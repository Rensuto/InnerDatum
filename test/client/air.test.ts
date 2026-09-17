/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:771-781 (`suffocate` stops a run)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AIR_BAR_H, drawAirBar, losingBreath } from '../../src/client/ui/air.ts';
import {
  PartyPaneMode,
  drawPartyPane,
  partyPaneHeight,
  partyPaneLayout,
  partyPaneView,
} from '../../src/client/ui/partypanel.ts';
import type { PartyPaneView } from '../../src/client/ui/partypanel.ts';
import { PALETTE } from '../../src/client/render/canvas.ts';
import { TurnActorState } from '../../src/shared/protocol.ts';
import type { AirView, PartyStateMember } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT'S HALF OF BREATH: WHEN A WALK STOPS, AND WHERE THE SLIVER GOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ResourceMsg.air` is absent at full. So `null` below always means "breathing
 * freely", and a first frame carrying air is a fall from the ceiling.
 */

const air = (cur: number): AirView => ({ cur, max: 100 });

describe('losingBreath — Player.lua:773-775', () => {
  it('stops a walk when the ground took air and left under three quarters', () => {
    expect(losingBreath(air(76), air(74))).toBe(true);
    expect(losingBreath(air(20), air(18))).toBe(true);
  });

  it('does not stop above the line, even while losing', () => {
    expect(losingBreath(air(79), air(77))).toBe(false);
    // 75 is not BELOW 0.75 × 100.
    expect(losingBreath(air(77), air(75))).toBe(false);
  });

  it('treats a first frame as a fall from full', () => {
    expect(losingBreath(null, air(70))).toBe(true);
    expect(losingBreath(null, air(95))).toBe(false);
  });

  it('never stops a body whose breath is coming back, or that is full again', () => {
    // Stepping out of the water: 40 → 43 is regeneration, `value > 0` is false.
    expect(losingBreath(air(40), air(43))).toBe(false);
    expect(losingBreath(air(40), air(40))).toBe(false);
    expect(losingBreath(air(40), null)).toBe(false);
  });
});

/** A recording context: every `fillRect`, with the fill style it used. */
function recorder(): {
  ctx: CanvasRenderingContext2D;
  rects: { style: string; x: number; y: number; w: number; h: number }[];
} {
  const rects: { style: string; x: number; y: number; w: number; h: number }[] = [];
  let style = '';
  const ctx = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return () => ({ width: 20 });
        if (prop === 'canvas') return undefined;
        if (prop === 'fillRect') {
          return (x: number, y: number, w: number, h: number) => {
            rects.push({ style, x, y, w, h });
          };
        }
        return () => {};
      },
      set: (_target, prop: string, value: unknown) => {
        if (prop === 'fillStyle') style = String(value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

describe('drawAirBar', () => {
  it('draws nothing for a body breathing freely', () => {
    const { ctx, rects } = recorder();
    drawAirBar(ctx, null, 0, 0, 100);
    expect(rects).toEqual([]);
  });

  it('draws a track the full width and a fill the share of breath left', () => {
    const { ctx, rects } = recorder();
    drawAirBar(ctx, air(40), 10, 20, 100);
    expect(rects).toEqual([
      { style: PALETTE.INK, x: 10, y: 20, w: 100, h: AIR_BAR_H },
      { style: PALETTE.SILVER, x: 10, y: 20, w: 40, h: AIR_BAR_H },
    ]);
  });
});

describe('drawAirBar, the fill', () => {
  it('floors a fractional width: 33 of 100 on a 50-pixel bar is 16 pixels', () => {
    const { ctx, rects } = recorder();
    drawAirBar(ctx, air(33), 0, 0, 50);
    expect(rects.map((r) => r.w)).toEqual([50, 16]);
  });
});

function member(over: Partial<PartyStateMember> & { id: string; name: string }): PartyStateMember {
  return {
    hp: 40,
    maxHp: 58,
    state: TurnActorState.Waiting,
    isLeader: false,
    isSelf: false,
    online: true,
    away: null,
    ...over,
  };
}

function pair(breath: AirView | null): PartyPaneView {
  return partyPaneView({
    state: {
      v: PROTOCOL_VERSION,
      t: 'party_state',
      leaderId: 'actor_a',
      members: [
        member({ id: 'actor_a', name: 'Dalt', isSelf: true, isLeader: true }),
        member({ id: 'actor_b', name: 'Sam' }),
      ],
      invites: [],
    },
    invites: [],
    roster: [],
    actors: new Map(),
    effects: new Map(),
    inCombat: false,
    resource: null,
    progress: null,
    money: null,
    air: breath,
  });
}

describe('the sliver on the party pane', () => {
  it('is drawn on the self row only, and only while short of breath', () => {
    const silver = (view: PartyPaneView) => {
      const layout = partyPaneLayout({
        view,
        width: 900,
        top: 20,
        bottom: 420,
        rightReserved: 214,
      });
      if (layout === null) throw new Error('expected a pane on a 900px viewport');
      const { ctx, rects } = recorder();
      drawPartyPane({ ctx, sprites: { sprite: () => undefined }, view, layout });
      return rects.filter((r) => r.style === PALETTE.SILVER && r.h === AIR_BAR_H);
    };
    expect(silver(pair(null))).toEqual([]);
    const drawn = silver(pair(air(30)));
    // ONE sliver for two rows: the protocol carries no teammate's breath.
    expect(drawn).toHaveLength(1);
  });

  it('is drawn in Portraits too, the layout a narrow window forces', () => {
    const silver = (view: PartyPaneView) => {
      // 640 is the minimum viewport, and it collapses to Portraits (partypanel.test.ts).
      const layout = partyPaneLayout({
        view,
        width: 640,
        top: 20,
        bottom: 420,
        rightReserved: 214,
      });
      if (layout === null) throw new Error('expected a pane on a 640px viewport');
      expect(layout.mode).toBe(PartyPaneMode.Portraits);
      const { ctx, rects } = recorder();
      drawPartyPane({ ctx, sprites: { sprite: () => undefined }, view, layout });
      return rects.filter((r) => r.style === PALETTE.SILVER && r.h === AIR_BAR_H);
    };
    expect(silver(pair(null))).toEqual([]);
    expect(silver(pair(air(30)))).toHaveLength(1);
  });

  it('costs the pane no height, so wading in and out moves no row', () => {
    expect(partyPaneHeight(pair(air(30)), PartyPaneMode.Rows)).toBe(
      partyPaneHeight(pair(null), PartyPaneMode.Rows),
    );
  });
});

describe('main.ts wires the frame to both halves', () => {
  /**
   * main.ts is not importable from a test (it boots a canvas), so this reads the
   * source, exactly as test/client/hudwiring.test.ts does. It pins the join: the
   * `resource` case keeps the air AND asks `losingBreath` whether to stop.
   */
  const src = readFileSync('src/client/main.ts', 'utf8');
  const block = /case 'resource': \{([\s\S]*?)\n {4}\}/.exec(src)?.[1] ?? '';

  it('keeps the frame’s air and stops travel on it', () => {
    expect(block, 'no `resource` case block was found — this join is blind').not.toBe('');
    expect(block).toContain('air = msg.air ?? null');
    expect(block).toMatch(/if \(losingBreath\(before, air\)\) cancelTravel\(/);
  });

  it('hands the pane the air', () => {
    expect(src).toMatch(/partyPaneView\(\{[\s\S]*?\n {4}air,\n/);
  });
});
