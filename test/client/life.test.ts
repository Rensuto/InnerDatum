// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/uiset/Minimalist.lua:762-830.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { PALETTE } from '../../src/client/render/canvas.ts';
import { LIFE_W, drawLife } from '../../src/client/ui/life.ts';

type Op = { kind: string; args: unknown[] };

function recorder(ops: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
        return (...args: unknown[]) => {
          ops.push({ kind: prop, args });
        };
      },
      // `fillStyle = x` is a SET, not a call, so it has to be recorded here or
      // every colour assertion below would be blind.
      set: (_t, prop: string, value: unknown) => {
        ops.push({ kind: `set:${prop}`, args: [value] });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function paint(hp: number | null, maxHp: number): Op[] {
  const ops: Op[] = [];
  drawLife({ ctx: recorder(ops), hp, maxHp, x: 4, y: 100 });
  return ops;
}

const texts = (ops: Op[]) =>
  ops.filter((op) => op.kind === 'fillText').map((op) => String(op.args[0]));
const colours = (ops: Op[]) =>
  ops.filter((op) => op.kind === 'set:fillStyle').map((op) => String(op.args[0]));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLAIM: a combat roguelike shows you your own health, always.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every previous copy of this number could be gone at the moment it mattered —
 * the party pane toggles off with `p` and sheds its digits under 320px, the turn
 * cards are drawn only in combat, and the character sheet is behind a keypress.
 * ToME spends its largest permanent element on it (Minimalist.lua:762-830).
 */
describe('the life readout', () => {
  it('always draws the digits, not only a bar', () => {
    // THE POINT OF THE WIDGET. "Can I survive another hit from that" is
    // arithmetic, and a fill fraction cannot be arithmetic'd.
    expect(texts(paint(24, 40))).toEqual(['24/40']);
  });

  it('rounds a fractional hit point UP, so 0.5 left never reads as dead', () => {
    // `hpRegen` is fractional (0.5 a turn), so fractional HP is the ordinary
    // state and not an edge. A body with half a point left is alive, and a
    // readout saying `0/40` beside a living body is the worst lie here.
    expect(texts(paint(0.5, 40))).toEqual(['1/40']);
  });

  it('never reads below zero', () => {
    expect(texts(paint(-3, 40))).toEqual(['0/40']);
  });

  it('draws NOTHING before the client knows its own body', () => {
    /**
     * A real window on connect, and exactly when the player is staring at the
     * screen. `0/0` there is a wrong number stated confidently — and the
     * wrongest one available, because it reads as dead. ui/xpbar.ts refuses the
     * same window for the same reason.
     */
    expect(paint(null, 0)).toEqual([]);
    expect(paint(20, 0), 'and a maximum of zero is the same refusal').toEqual([]);
  });
});

describe('the colour rule, which is the party pane’s', () => {
  /**
   * TWO HEALTH READOUTS THAT DISAGREED about when a body is in trouble would be
   * worse than one. `partypanel.ts` turns at a third; so does this.
   */
  it('is gold above a third', () => {
    expect(colours(paint(20, 40))).toContain(PALETTE.GOLD);
    expect(colours(paint(20, 40))).not.toContain(PALETTE.ORANGE);
  });

  it('turns orange at a third and below', () => {
    const at = colours(paint(10, 30));
    expect(at, 'exactly a third is already low').toContain(PALETTE.ORANGE);
    expect(colours(paint(4, 40))).toContain(PALETTE.ORANGE);
  });

  it('turns the DIGITS orange too, not only the bar', () => {
    // A player reading the number rather than the bar — most of them, most of
    // the time — must not have to look at a second thing to learn they are hurt.
    const ops = paint(4, 40);
    const beforeText = ops.slice(
      0,
      ops.findIndex((op) => op.kind === 'fillText'),
    );
    expect(beforeText.filter((op) => op.kind === 'set:fillStyle').at(-1)?.args[0]).toBe(
      PALETTE.ORANGE,
    );
  });

  it('never spends CRIMSON, which means something else entirely', () => {
    /**
     * `PALETTE` reserves it for one fact — hostiles are engaged — so that the
     * ring around the playfield answers "are we in a fight?" from peripheral
     * vision. A low-health bar wearing it would spend that.
     */
    expect(colours(paint(1, 40))).not.toContain(PALETTE.CRIMSON);
  });
});

describe('the width is a constant, and that is load-bearing', () => {
  it('does not change with the number in it', () => {
    /**
     * The caller offsets the resource pips by `LIFE_W` without measuring
     * anything. If this were fitted to the current digits, the whole resource
     * row would shuffle sideways every time the player took a hit — which is
     * exactly the frame in which they are trying to read it.
     */
    expect(LIFE_W).toBe(88);
  });

  it('holds the widest reading the game can produce', () => {
    // 7 characters at 6px, plus the bar and both gaps.
    expect(LIFE_W).toBeGreaterThanOrEqual(34 + 4 + '999/999'.length * 6);
  });
});
