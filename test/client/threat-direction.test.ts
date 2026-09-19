/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  THREAT_ARC_SEEN_DEG,
  THREAT_ARC_UNSEEN_DEG,
  createRenderer,
} from '../../src/client/render/canvas.ts';
import {
  THREAT_TELL_MS,
  headingToward,
  incomingThreats,
  liveThreats,
  nextThreatExpiry,
  rememberThreat,
  threatTells,
} from '../../src/client/state/threat.ts';
import { threatQuadrant } from '../../src/server/view/projector.ts';
import { DIR_ORDER, DIR_VECTORS, bearingWord } from '../../src/shared/coords.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { installDom, removeDom, stubCanvas, stubSprites } from './canvasstub.ts';
import type { Arc, StubCanvas, StubCtx } from './canvasstub.ts';
import type { RememberedThreat } from '../../src/client/state/threat.ts';
import type { Dir } from '../../src/shared/coords.ts';
import type { ProjectileView, TurnEvent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH WAY IS IT FACING, AND WHERE DID THAT COME FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The author, verbatim: *"Tales of Maj Eyal combat will tell you which
 * direction the enemy is facing. we need to give a small indication to the
 * direction that the attack or enemy targetting you is coming from."*
 *
 * ═══ WHAT UPSTREAM ACTUALLY HAS, BECAUSE IT IS LESS THAN THE REQUEST ═══
 * ToME's facing is a MIRRORED SPRITE and nothing else. `tome/class/Actor.lua:1427`
 * flips it on a move by comparing the new x to the old; `Combat.lua:649` flips
 * it toward the target at the moment of a blow; `Actor.lua:4014-4019`
 * (`isTileFlipped`) says which way the art natively points and
 * `engine/Entity.lua:591-603` does the flipping. Horizontal only — there is a
 * `MOflipY` and nothing calls it for facing — and it is on the ATTACKER, so it
 * says nothing at all about a body you cannot see. THERE IS NO VICTIM-SIDE
 * DIRECTION CUE UPSTREAM, so the second half of the request is a labelled
 * divergence and is tested as one.
 *
 * ═══ THE TWO HALVES, AND THE LINE BETWEEN THEM ═══
 *   THE FACING is derived in the client from tiles the frames already carry —
 *     `MoveEvent.fromX/fromY` and `AttackEvent.x/y` — which is the same pair
 *     those two Lua lines compare. Nothing was added to the wire, because a
 *     facing is a fact about a picture.
 *   THE THREAT ARC is new information when the dealer cannot be seen, so it is
 *     a server decision: `DamageEvent.from`, a QUADRANT, sent only where
 *     `sourceId` was redacted. An octant plus melee adjacency is one tile,
 *     which would let a player swing exactly at an invisible body.
 */

const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/** `MAIN` with its comments removed — this file quotes the old code it replaced. */
const CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function body(open: string): string {
  const at = MAIN.indexOf(open);
  expect(at, `no such function: ${open}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let seen = false;
  for (let i = at; i < MAIN.length; i += 1) {
    const ch = MAIN[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return MAIN.slice(at, i + 1);
    }
  }
  return MAIN.slice(at);
}

// ---------------------------------------------------------------------------
// 1. THE SNAP — a displacement becomes one of eight, and never an eighth out
// ---------------------------------------------------------------------------

describe('headingToward', () => {
  it('answers each of the eight for its own unit step', () => {
    for (const dir of DIR_ORDER) {
      const v = DIR_VECTORS[dir];
      expect(headingToward(v.dx, v.dy), dir).toBe(dir);
      // ...AND AT ANY DISTANCE ALONG IT. A blow comes from six tiles away as
      // often as from one, which is precisely why `dirFromVector` in
      // shared/coords.ts is the wrong tool: it answers undefined outside
      // [-1, 1] because it maps a STEP.
      expect(headingToward(v.dx * 7, v.dy * 7), `${dir} x7`).toBe(dir);
    }
  });

  it('never answers off the eight, anywhere on a full circle', () => {
    /**
     * A SWEEP RATHER THAN CASES. The bug this shape has is an off-by-an-eighth
     * in the rotation — `DIR_ORDER` runs clockwise from NORTH and `atan2` starts
     * at EAST — and it is invisible on the cardinals: four of the eight would
     * still be right with the offset wrong. It shows on the diagonals, so the
     * sweep has to cross them.
     */
    const allowed = new Set<string>(DIR_ORDER);
    for (let deg = 0; deg < 360; deg += 1) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.cos(rad) * 40;
      const dy = Math.sin(rad) * 40;
      const dir = headingToward(dx, dy);
      expect(dir, `${String(deg)}°`).not.toBeNull();
      expect(allowed.has(dir ?? ''), `${String(deg)}° -> ${String(dir)}`).toBe(true);
      // AND IT IS THE NEAREST ONE. Measured against the vector table rather
      // than against a second copy of the arithmetic: the answer's own unit
      // vector must be the closest of the eight to the direction asked for.
      const chosen = DIR_VECTORS[dir ?? 'n'];
      const angleOf = (ax: number, ay: number): number => Math.atan2(ay, ax);
      const gap = (a: number, b: number): number => {
        const raw = Math.abs(a - b) % (Math.PI * 2);
        return raw > Math.PI ? Math.PI * 2 - raw : raw;
      };
      const mine = gap(angleOf(chosen.dx, chosen.dy), rad);
      for (const other of DIR_ORDER) {
        const v = DIR_VECTORS[other];
        // A tolerance of one degree: exactly on a boundary either neighbour is
        // correct, and `Math.round` has to pick one.
        expect(mine, `${String(deg)}° chose ${String(dir)} over ${other}`).toBeLessThanOrEqual(
          gap(angleOf(v.dx, v.dy), rad) + 0.02,
        );
      }
    }
  });

  it('agrees with the sentence upstream writes, except in one wedge', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO TELLS ABOUT THE SAME MONSTER, AND WHERE THEY ARE ALLOWED TO DIFFER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `bearingWord` is the rest refusal's half of this — ported from
     * `engine/Map.lua:1459-1470` (`compassDirection`), which is what
     * `tome/class/Player.lua:979` calls to say *"hostile spotted to the
     * north-east"*. A player can have both on screen at once: the sentence in
     * the status line and the arc on their own token.
     *
     * So they must agree wherever anybody would notice, and they do on every
     * cardinal and every true diagonal. The wedge between 22.5° and the 2:1
     * line is the one place they part, deliberately: the word prefers the
     * cardinal because it is WALKED, the arc takes the nearest eighth because
     * it is LOOKED AT beside seven other angles.
     */
    for (const dir of DIR_ORDER) {
      const v = DIR_VECTORS[dir];
      const word = bearingWord(v.dx * 6, v.dy * 6).replace('-', '');
      const snapped = headingToward(v.dx * 6, v.dy * 6);
      const spelt = { n: 'north', e: 'east', s: 'south', w: 'west' };
      const expected = (snapped ?? '')
        .split('')
        .map((letter) => spelt[letter as 'n' | 'e' | 's' | 'w'])
        .join('');
      expect(word, dir).toBe(expected);
    }
    // THE WEDGE, NAMED. Nine east and four north is 24°: past the eighth
    // boundary at 22.5, inside the 2:1 line the sentence uses.
    expect(headingToward(9, -4)).toBe('ne');
    expect(bearingWord(9, -4)).toBe('east');
  });

  it('answers null for no displacement at all, and never a default', () => {
    // A direction from a square to itself is not a direction. A body that swung
    // at its own tile — a self-shape talent, a bump resolved in place — must
    // keep the heading it had, and a default would be a tick confidently
    // pointing north at nothing.
    expect(headingToward(0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. THE SERVER'S HALF — four answers, and never eight
// ---------------------------------------------------------------------------

describe('threatQuadrant', () => {
  const HERE = { x: 10, y: 10 };

  it('answers exactly four things, ever', () => {
    const seen = new Set<string>();
    for (let dx = -6; dx <= 6; dx += 1) {
      for (let dy = -6; dy <= 6; dy += 1) {
        const q = threatQuadrant({ x: HERE.x + dx, y: HERE.y + dy }, HERE);
        if (q !== null) seen.add(q);
      }
    }
    /**
     * ═══ THE HONESTY IS IN THE PROTOCOL, NOT IN THE PAINT ═══
     * `DamageEvent.from` is the only thing the server sends about an attacker
     * the viewer cannot see. An OCTANT plus the adjacency a melee blow implies
     * is ONE TILE — a player could swing exactly at an invisible body every
     * time. Four quadrants never narrow below three adjacent tiles, and because
     * the finer answer is never COMPUTED here, no change to the renderer can
     * leak it.
     */
    expect([...seen].sort()).toEqual(['e', 'n', 's', 'w']);
  });

  it('names the dominant axis, and breaks a tie on the vertical', () => {
    expect(threatQuadrant({ x: 20, y: 10 }, HERE)).toBe('e');
    expect(threatQuadrant({ x: 0, y: 10 }, HERE)).toBe('w');
    expect(threatQuadrant({ x: 10, y: 0 }, HERE)).toBe('n');
    expect(threatQuadrant({ x: 10, y: 20 }, HERE)).toBe('s');
    // A near-cardinal keeps its cardinal.
    expect(threatQuadrant({ x: 16, y: 12 }, HERE)).toBe('e');
    // The perfect diagonal. Some rule has to break it and a deterministic one
    // leaks nothing, because the answer is still one of four.
    expect(threatQuadrant({ x: 14, y: 14 }, HERE)).toBe('s');
    expect(threatQuadrant({ x: 6, y: 6 }, HERE)).toBe('n');
  });

  it('says nothing rather than pointing north', () => {
    // A blow from your own tile has no direction, and a killer can be erased
    // inside the same pump that its blow is being narrated in.
    expect(threatQuadrant(HERE, HERE)).toBeNull();
    expect(threatQuadrant(null, HERE)).toBeNull();
    expect(threatQuadrant(HERE, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. THE REDACTION — `from` appears exactly where the name went away
// ---------------------------------------------------------------------------

describe('fogEvent gives a quadrant back for the name it takes', () => {
  const WHERE = new Map<string, { x: number; y: number }>([
    ['me', { x: 10, y: 10 }],
    ['husk', { x: 10, y: 4 }],
    ['ally', { x: 11, y: 10 }],
  ]);
  const tileOf = (id: string): { x: number; y: number } | null => WHERE.get(id) ?? null;

  const blow = (sourceId: string): TurnEvent => ({
    k: 'damage',
    id: 'me',
    amount: 7,
    hp: 20,
    maxHp: 30,
    sourceId,
  });

  async function fog(
    event: TurnEvent,
    held: readonly string[],
    withTiles = true,
  ): Promise<TurnEvent | null> {
    const { fogEvent } = await import('../../src/server/view/projector.ts');
    return fogEvent(event, new Set(held), withTiles ? tileOf : undefined);
  }

  it('redacts the name and leaves the quadrant, for a blow out of the dark', async () => {
    const out = await fog(blow('husk'), ['me']);
    expect(out).not.toBeNull();
    const damage = out as { sourceId?: string; from?: string };
    expect(damage.sourceId, 'the shooter was named to somebody who cannot see it').toBeUndefined();
    // The husk is six tiles NORTH of the victim.
    expect(damage.from).toBe('n');
  });

  it('adds nothing at all when the dealer is held', async () => {
    const out = (await fog(blow('ally'), ['me', 'ally'])) as { sourceId?: string; from?: string };
    expect(out.sourceId).toBe('ally');
    /**
     * NOT A COURTESY — A RULE. When the dealer is visible the client holds both
     * tiles and works the bearing out itself, to the eighth. A `from` here would
     * be a second, coarser answer to a question already answered, and the two
     * would disagree on every diagonal.
     */
    expect(out.from).toBeUndefined();
  });

  it('adds nothing without a way to locate the bodies', async () => {
    // Every existing caller and every fixture passes no lookup. They must keep
    // exactly the behaviour they had.
    const out = (await fog(blow('husk'), ['me'], false)) as { sourceId?: string; from?: string };
    expect(out.sourceId).toBeUndefined();
    expect(out.from).toBeUndefined();
  });

  it('adds nothing to a death or a talent, whose redacted ids are somebody else’s', async () => {
    /**
     * `killerId` is on a DEATH — a fact about the body that fell, which may not
     * be the viewer — and `TalentEvent.targetId` names a third party. A bearing
     * between two bodies that are not the recipient is a position leak with no
     * question behind it.
     */
    const death = await fog({ k: 'death', id: 'ally', killerId: 'husk' } as unknown as TurnEvent, [
      'me',
      'ally',
    ]);
    expect((death as { killerId?: string; from?: string }).killerId).toBeUndefined();
    expect((death as { from?: string }).from).toBeUndefined();
  });

  it('still withholds the whole event when a REQUIRED id is unheld', async () => {
    // The gate is unchanged: `sourceId` redacts, `id` gates. A quadrant must not
    // become a way to hear about a blow on a body you do not hold.
    expect(await fog(blow('husk'), ['ally'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. THE PAINT — the span is the precision
// ---------------------------------------------------------------------------

function level(w: number, h: number) {
  return { w, h, tiles: new Array<number>(w * h).fill(1) };
}

const SMALL = level(12, 10);

function ctxOfMapBuffer(visible: StubCanvas): StubCtx | null {
  const composited = visible.ctx?.blits ?? [];
  const back = composited[0]?.source;
  if (back === null || back === undefined || !('ctx' in back)) return null;
  return back.ctx;
}

function paint(scene: Record<string, unknown>): StubCtx {
  const visible = stubCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: stubSprites(TILE_PX, TILE_PX),
  });
  renderer.resize();
  renderer.draw(scene as never);
  const ctx = ctxOfMapBuffer(visible);
  expect(ctx, 'no map buffer was composited').not.toBeNull();
  return ctx as StubCtx;
}

const SELF = {
  id: 'me',
  name: 'Ren',
  sprite: 'x',
  x: 5,
  y: 5,
  kind: 'player',
  rank: 'normal',
  hp: 10,
  maxHp: 10,
  alive: true,
};

const degOf = (arc: Arc): number => Math.round(((arc.end - arc.start) * 180) / Math.PI);

describe('the threat arc', () => {
  beforeEach(() => {
    installDom(1);
  });
  afterEach(() => {
    removeDom();
  });

  it('is drawn on the body’s own cell, centred, at the direction given', () => {
    const ctx = paint({
      level: SMALL,
      actors: [SELF],
      selfId: 'me',
      threats: [{ x: 5, y: 5, dir: 'e', seen: true }],
    });
    expect(ctx.arcs.length, 'nothing was stroked at all').toBe(1);
    const arc = ctx.arcs[0] as Arc;
    // The camera is dead centre on the body (`cameraAxis`), so its cell centre
    // is the middle of the playfield. Asserted against the SCENE rather than
    // against a remembered pixel: what matters is that the arc is on the token.
    const blits = ctx.blits.filter((b) => b.dw === TILE_PX && b.dh === TILE_PX);
    const ring = blits[0];
    expect(ring, 'no cell-sized token ring was drawn').toBeDefined();
    expect(arc.x).toBe((ring?.dx ?? 0) + TILE_PX / 2);
    expect(arc.y).toBe((ring?.dy ?? 0) + TILE_PX / 2);
    // EAST is angle 0 on a screen-down axis, and the arc straddles it.
    expect((arc.start + arc.end) / 2).toBeCloseTo(0, 6);
  });

  it('draws a SEEN blow as an eighth and an UNSEEN one as a quarter', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SPAN IS THE PRECISION, AND THAT IS THE WHOLE HONESTY OF THE TELL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A wide arc means "somewhere in that quarter", which is exactly what
     * `DamageEvent.from` carried. A renderer that drew both grades the same
     * width would be claiming, for a blow out of the dark, a precision the
     * server deliberately refused to send.
     */
    const ctx = paint({
      level: SMALL,
      actors: [SELF],
      selfId: 'me',
      threats: [
        { x: 5, y: 5, dir: 'e', seen: true },
        { x: 5, y: 5, dir: 'w', seen: false },
      ],
    });
    expect(ctx.arcs.length).toBe(2);
    const [narrow, wide] = ctx.arcs as [Arc, Arc];
    expect(degOf(narrow)).toBe(THREAT_ARC_SEEN_DEG);
    expect(degOf(wide)).toBe(THREAT_ARC_UNSEEN_DEG);
    expect(THREAT_ARC_UNSEEN_DEG).toBeGreaterThan(THREAT_ARC_SEEN_DEG);
    // AND NOT BY COLOUR ALONE. `game-design.md` § 4's rule, and the reason the
    // turn chips carry silhouettes: the two grades differ in WEIGHT as well as
    // in span, so they are told apart on a monochrome screen.
    expect(narrow.width).toBeGreaterThan(wide.width);
  });

  it('points at each of the eight, and never the same way twice', () => {
    const angles = new Map<Dir, number>();
    for (const dir of DIR_ORDER) {
      const ctx = paint({
        level: SMALL,
        actors: [SELF],
        selfId: 'me',
        threats: [{ x: 5, y: 5, dir, seen: true }],
      });
      const arc = ctx.arcs[0] as Arc;
      angles.set(dir, (arc.start + arc.end) / 2);
    }
    for (const dir of DIR_ORDER) {
      const v = DIR_VECTORS[dir];
      expect(angles.get(dir) ?? 0, dir).toBeCloseTo(Math.atan2(v.dy, v.dx), 6);
    }
  });

  it('draws nothing when there is nothing to say', () => {
    const quiet = paint({ level: SMALL, actors: [SELF], selfId: 'me' });
    expect(quiet.arcs).toEqual([]);
  });
});

describe('the facing tick', () => {
  beforeEach(() => {
    installDom(1);
  });
  afterEach(() => {
    removeDom();
  });

  it('turns with the heading, and only for a body that has one', () => {
    const facing = new Map<string, Dir>([['me', 'n']]);
    const ctx = paint({
      level: SMALL,
      actors: [SELF, { ...SELF, id: 'other', x: 6, y: 5 }],
      selfId: 'me',
      facing,
    });
    const turns = ctx.ops.filter((op) => op.startsWith('rotate('));
    // EXACTLY ONE. The second body has no entry, and a default would be a tick
    // claiming a husk that has not moved or swung is looking north.
    expect(turns.length, 'a body with no heading was given a tick').toBe(1);
    expect(turns[0]).toBe(`rotate(${Math.atan2(-1, 0).toFixed(4)})`);
  });

  it('draws inward from the rim, never over the neighbouring tile', () => {
    /**
     * A tick that stuck OUT of the cell would overlap the next square, and on a
     * full board every token would be wearing its neighbour's tick. Asserted on
     * the rect the painter lays down inside its own rotated frame: its x runs
     * from negative to zero, which is "back from the rim point", and it is
     * centred on the rim line.
     */
    const ctx = paint({
      level: SMALL,
      actors: [SELF],
      selfId: 'me',
      facing: new Map<string, Dir>([['me', 'e']]),
    });
    const tick = ctx.rects.find((r) => r.x < 0 && r.y < 0 && r.w > 0 && r.h > 0);
    expect(tick, 'no facing tick was drawn').toBeDefined();
    expect((tick?.x ?? 0) + (tick?.w ?? 0)).toBe(0);
    expect(tick?.y).toBe(-(tick?.h ?? 0) / 2);
    // AND IT IS SAVED AND RESTORED. A transform left on the context would put
    // every later painter — the pips, the orbs, the whole interface — through
    // the last body's rotation.
    expect(ctx.ops.filter((op) => op === 'save()').length).toBe(
      ctx.ops.filter((op) => op === 'restore()').length,
    );
  });

  it('puts the tick on the rim of the token’s own cell', () => {
    const ctx = paint({
      level: SMALL,
      actors: [SELF],
      selfId: 'me',
      facing: new Map<string, Dir>([['me', 'e']]),
    });
    const ring = ctx.blits.filter((b) => b.dw === TILE_PX && b.dh === TILE_PX)[0];
    const pivot = ctx.ops.find((op) => op.startsWith('translate('));
    expect(pivot).toBe(
      `translate(${String((ring?.dx ?? 0) + TILE_PX - 1)},${String((ring?.dy ?? 0) + TILE_PX / 2)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE WIRING — the two places upstream turns a body, and the one that arms
//    the arc
// ---------------------------------------------------------------------------

describe('main.ts turns a body exactly where upstream does', () => {
  it('on a move, from the tiles the frame already carried', () => {
    /**
     * `applyTurnEvent`'s own note said `fromX`/`fromY` were *"ignored: they
     * exist for a client that interpolates the step, and this one deliberately
     * does not"*. It still does not interpolate. It reads them for the one bit
     * they carry that the destination does not.
     */
    const arm = body('function applyTurnEvent(event: TurnEvent): void {');
    expect(arm).toContain('faceToward(event.id, event.fromX, event.fromY, event.x, event.y);');
  });

  it('on a blow, toward the tile it swung at', () => {
    // `Combat.lua:649`. `event.x/y` is the TARGET's tile, which the frame
    // carries so the client needs no lookup for a body that may already be dead.
    expect(CODE).toContain('faceToward(event.id, swinger.x, swinger.y, event.x, event.y);');
  });

  it('forgets a heading when the body leaves', () => {
    // Ids are per-run and can be reused by a later spawn; a stale heading would
    // put a tick on a fresh husk claiming it had already acted.
    expect(body('function applyServerMessage(msg: ServerMsg): void {')).toContain(
      'facings.delete(msg.id);',
    );
    expect(CODE).toContain('facings.clear();');
  });

  it('arms the arc for a blow on the viewer that was not a heal', () => {
    /**
     * THE SAME GUARD AS THE TRAVEL INTERRUPT, and for the same two reasons:
     * somebody else's blow is not the question, and being patched up by the
     * Alchemist is the opposite of a threat. Asserted as ORDER — inside the
     * guard — rather than as presence, because a `noteThreat` outside it would
     * draw an orange arc every time an ally was healed.
     */
    const arm = body('function applyTurnEvent(event: TurnEvent): void {');
    const guard = arm.indexOf('if (event.id === selfId && (event.healed ?? 0) === 0) {');
    expect(guard).toBeGreaterThanOrEqual(0);
    const call = arm.indexOf('threatTellOf(event.sourceId, event.from, actor.x, actor.y)');
    expect(call).toBeGreaterThan(guard);
    expect(arm.indexOf('}', call)).toBeGreaterThan(call);
  });

  it('arms it again for a swing AIMED at the viewer, landed or not', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE MISS IS HALF THE FEATURE, AND IT IS NOT ON THE `damage` FRAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `hitToWire` emits the `attack` frame ALONE on a miss — travel.ts's
     * interrupt (5) moved onto this frame for exactly that reason, in as many
     * words: *"a swing at you is the signal, landed or not"*. A tell fed only
     * by `damage` is silent on the one swing in eight that misses, which is the
     * swing after which a player most needs to know which way to turn.
     *
     * `targetId` AND NOT `id`: `id` is the ATTACKER on this frame, and the
     * player's own swings arrive here too.
     */
    const arm = body('function applyTurnEvent(event: TurnEvent): void {');
    const guard = arm.indexOf('if (event.targetId === selfId && event.id !== selfId) {');
    expect(guard).toBeGreaterThanOrEqual(0);
    const call = arm.indexOf('threatTellOf(event.id, undefined, event.x, event.y)');
    expect(call).toBeGreaterThan(guard);
    // TWO ARMING SITES AND NO MORE — the blow that landed and the swing that
    // was aimed. A third would be a third lifetime for one tell.
    expect(CODE.split('noteThreat(').length - 1, 'noteThreat is armed somewhere else').toBe(2);
    // ...AND BOTH GO THROUGH THE ONE DECISION. A second copy of the
    // dealer/quadrant ternary is a second chance to disagree about the grade.
    expect(CODE.split('threatTellOf(').length - 1).toBe(3); // one declaration, two calls
  });

  it('reads the dealer off the board, so an unheld id falls back to the quadrant', () => {
    /**
     * `sourceId !== undefined` IS NOT THE TEST. The id is dropped by `fogEvent`
     * for a body out of sight, but a client can hold an id for a body it has
     * not been sent yet — one frame between a sweep and its `joined`. No body,
     * no tiles, no octant, so it falls through to whatever the server said.
     */
    expect(CODE).toContain('actors.get(sourceId)');
    // WHITESPACE-INSENSITIVE, because prettier owns the line breaks in a
    // ternary this long and a pin on its exact layout would go red on a
    // reformat that changed nothing.
    expect(CODE.replace(/\s+/g, ' ')).toContain('dealer === undefined ? (from ?? null)');
  });

  it('keeps the decay in the module, and holds the marks as a list', () => {
    /**
     * THE RULES ARE NOT IN main.ts ANY MORE, and this is the pin that keeps
     * them out. `boot()` cannot be imported, so a decay written inside it is a
     * decay no test can run — which is how the shared-deadline version below
     * survived being written down as deliberate.
     */
    expect(CODE).toContain('threatMarks = rememberThreat(threatMarks, tell, Date.now());');
    expect(CODE).toContain('threatMarks = liveThreats(threatMarks, Date.now());');
    expect(CODE).toContain('nextThreatExpiry(threatMarks, Date.now())');
    // ...AND THE ORBS ARE ASKED FOR ON EVERY DRAW. `threatArcs` is called from
    // `scene()`, so a version that passed no projectiles would silently lose
    // the whole "it has not landed yet" half and break no other assertion here.
    expect(CODE).toContain('threatTells(threatMarks, projectiles, self, Date.now())');
    // AND NO SECOND COPY OF THE LIFETIME. A number here would be the one that
    // was wrong, silently, on a board nobody could test.
    expect(CODE).not.toContain('THREAT_TELL_MS =');
  });
});

// ---------------------------------------------------------------------------
// 6. THE SET — two attackers at once, one quarter twice, and four seconds each
// ---------------------------------------------------------------------------

const NO_ORBS: readonly ProjectileView[] = [];
const MY_TILE = { x: 5, y: 5 };
const T0 = 1_700_000_000_000;

describe('what the viewer is being told', () => {
  it('holds one mark a side when two things hit you in the same turn', () => {
    /**
     * THE CASE THE WHOLE SHAPE EXISTS FOR. A husk to the east and something in
     * the dark to the west inside one pump is not one answer with a tie to
     * break — it is two facts, and a tell that kept only the last would send a
     * player away from one attacker and into the other.
     */
    let marks = rememberThreat([], { dir: 'e', seen: true }, T0);
    marks = rememberThreat(marks, { dir: 'w', seen: false }, T0);
    expect(threatTells(marks, NO_ORBS, MY_TILE, T0)).toEqual([
      { dir: 'e', seen: true },
      { dir: 'w', seen: false },
    ]);
  });

  it('never stacks two arcs on one rim: three swings from the east are one', () => {
    let marks = rememberThreat([], { dir: 'e', seen: true }, T0);
    marks = rememberThreat(marks, { dir: 'e', seen: true }, T0 + 10);
    marks = rememberThreat(marks, { dir: 'e', seen: true }, T0 + 20);
    expect(marks).toHaveLength(1);
    expect(threatTells(marks, NO_ORBS, MY_TILE, T0 + 20)).toEqual([{ dir: 'e', seen: true }]);
  });

  it('gives the quarter to a side the dark has a claim on, in either order', () => {
    // THE WIDER ARC WINS THE KEY. Two attackers east, one of them unseen: the
    // narrow arc would claim a precision the server refused to send.
    const darkFirst = rememberThreat(
      rememberThreat([], { dir: 'e', seen: false }, T0),
      { dir: 'e', seen: true },
      T0 + 1,
    );
    expect(threatTells(darkFirst, NO_ORBS, MY_TILE, T0 + 1)).toEqual([{ dir: 'e', seen: false }]);
    const seenFirst = rememberThreat(
      rememberThreat([], { dir: 'e', seen: true }, T0),
      { dir: 'e', seen: false },
      T0 + 1,
    );
    expect(threatTells(seenFirst, NO_ORBS, MY_TILE, T0 + 1)).toEqual([{ dir: 'e', seen: false }]);
  });

  it('answers in compass order, whatever order the blows arrived in', () => {
    let marks = rememberThreat([], { dir: 'w', seen: true }, T0);
    marks = rememberThreat(marks, { dir: 'n', seen: true }, T0);
    marks = rememberThreat(marks, { dir: 'se', seen: true }, T0);
    expect(threatTells(marks, NO_ORBS, MY_TILE, T0).map((tell) => tell.dir)).toEqual([
      'n',
      'se',
      'w',
    ]);
  });

  it('decays, and each mark on its own clock', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS IS THE RULE THE FIRST CUT GOT WRONG, AND IT WAS WRITTEN DOWN AS
     * DELIBERATE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * One timeout for the whole set, restarted by every blow, was argued in
     * main.ts as *"the arcs go together because they are one answer to one
     * question"*. In a FIGHT — the only place this feature is ever used — a
     * blow lands every turn, so the timeout is restarted every turn and nothing
     * ever expires: the north arc from the corridor you walked out of is still
     * up thirty seconds later while you trade blows with something south of
     * you. A stale direction is not half a picture, it is a wrong one.
     *
     * So the north mark below dies on schedule WHILE the south one, made three
     * seconds later, is still standing. Restore the shared deadline and this
     * is the assertion that goes red.
     */
    const north = rememberThreat([], { dir: 'n', seen: true }, T0);
    const both = rememberThreat(north, { dir: 's', seen: true }, T0 + 3000);

    // Still both, a millisecond before the north one is due.
    expect(threatTells(both, NO_ORBS, MY_TILE, T0 + THREAT_TELL_MS - 1).map((t) => t.dir)).toEqual([
      'n',
      's',
    ]);
    // ...and the north one alone has gone, ON ITS OWN BLOW'S CLOCK.
    expect(threatTells(both, NO_ORBS, MY_TILE, T0 + THREAT_TELL_MS).map((t) => t.dir)).toEqual([
      's',
    ]);
    // ...and the south one four seconds after ITS blow, not after the first.
    expect(threatTells(both, NO_ORBS, MY_TILE, T0 + 3000 + THREAT_TELL_MS - 1)).toHaveLength(1);
    expect(threatTells(both, NO_ORBS, MY_TILE, T0 + 3000 + THREAT_TELL_MS)).toEqual([]);
  });

  it('refreshes the mark that was hit again, and only that one', () => {
    const marks = rememberThreat(
      rememberThreat([], { dir: 'n', seen: true }, T0),
      { dir: 'n', seen: true },
      T0 + 3000,
    );
    // The second blow from the north bought the north arc another four seconds.
    expect(threatTells(marks, NO_ORBS, MY_TILE, T0 + THREAT_TELL_MS + 100)).toEqual([
      { dir: 'n', seen: true },
    ]);
    expect(threatTells(marks, NO_ORBS, MY_TILE, T0 + 3000 + THREAT_TELL_MS)).toEqual([]);
  });

  it('sweeps what has expired rather than carrying it, and names the next due', () => {
    // The timer in boot() arms itself from these two. `liveThreats` is what it
    // keeps; `nextThreatExpiry` is when it next has something to do.
    const marks = rememberThreat(
      rememberThreat([], { dir: 'n', seen: true }, T0),
      { dir: 's', seen: true },
      T0 + 1000,
    );
    expect(nextThreatExpiry(marks, T0)).toBe(T0 + THREAT_TELL_MS);
    expect(liveThreats(marks, T0 + THREAT_TELL_MS)).toHaveLength(1);
    expect(nextThreatExpiry(marks, T0 + THREAT_TELL_MS)).toBe(T0 + 1000 + THREAT_TELL_MS);
    // NULL, NOT A DEFAULT: nothing standing means the timer does not re-arm at
    // all, which is what stops an idle party paying for a timeout every frame.
    expect(nextThreatExpiry(marks, T0 + 1000 + THREAT_TELL_MS)).toBeNull();
    expect(nextThreatExpiry([], T0)).toBeNull();
  });

  it('drops the expired mark as it writes, so the list cannot grow unbounded', () => {
    // A fight is thousands of blows. The set is at most eight entries because
    // it is keyed by direction, and the sweep is not what keeps it that way.
    let marks: readonly RememberedThreat[] = [];
    for (let i = 0; i < 200; i += 1) {
      marks = rememberThreat(marks, { dir: DIR_ORDER[i % 8] ?? 'n', seen: true }, T0 + i * 1000);
    }
    expect(marks.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// 7. THE THIRD CASE — something aimed at you that has not landed yet
// ---------------------------------------------------------------------------

function orb(id: string, x: number, y: number, targetX: number, targetY: number): ProjectileView {
  return { id, x, y, targetX, targetY, turnsToImpact: 2 };
}

describe('something already in the air', () => {
  it('points at an orb committed to the tile you are standing on', () => {
    /**
     * THE ONLY "IT HAS NOT HIT YOU YET" THE SERVER IS WILLING TO SEND. A
     * monster that has DECIDED to attack and not yet swung is not knowable —
     * `ActorView` withholds pending intent and AI target by rule — so the
     * earliest honest warning is a shot already on the board, and the orb is
     * one the viewer can see: `projectProjectiles` gates each on its own tile.
     */
    expect(incomingThreats([orb('o1', 1, 5, 5, 5)], MY_TILE)).toEqual([{ dir: 'w', seen: true }]);
    expect(incomingThreats([orb('o1', 5, 1, 5, 5)], MY_TILE)).toEqual([{ dir: 'n', seen: true }]);
    expect(incomingThreats([orb('o1', 9, 9, 5, 5)], MY_TILE)).toEqual([{ dir: 'se', seen: true }]);
  });

  it('says nothing about a shot aimed at the tile you have left', () => {
    // THE WHOLE COUNTERPLAY. `targetX/targetY` is frozen at the moment of
    // firing, so stepping aside makes the orb miss — and an arc that kept
    // pointing at it would be telling a player who had already solved the
    // problem to solve it again.
    expect(incomingThreats([orb('o1', 1, 5, 4, 5)], MY_TILE)).toEqual([]);
  });

  it('says nothing for an orb standing on you, and nothing without a body', () => {
    // Landing this pump. "It is on top of you" is the notice line's sentence.
    expect(incomingThreats([orb('o1', 5, 5, 5, 5)], MY_TILE)).toEqual([]);
    expect(incomingThreats([orb('o1', 1, 5, 5, 5)], null)).toEqual([]);
  });

  it('gives a side each for two shots from two sides', () => {
    const tells = incomingThreats([orb('o1', 1, 5, 5, 5), orb('o2', 5, 9, 5, 5)], MY_TILE);
    expect(tells.map((tell) => tell.dir).sort()).toEqual(['s', 'w']);
  });

  it('merges with the memory instead of drawing the same side twice', () => {
    // A blow that landed from the east and a second shot still coming from the
    // east is ONE east. Two arcs there would say "two attackers" on a board
    // with one.
    const marks = rememberThreat([], { dir: 'e', seen: true }, T0);
    expect(threatTells(marks, [orb('o1', 9, 5, 5, 5)], MY_TILE, T0)).toEqual([
      { dir: 'e', seen: true },
    ]);
  });

  it('does not let a visible orb narrow a quarter the dark owns', () => {
    // The unseen blow said "somewhere east". An orb the viewer can see, also
    // east, is a different attacker — it does not make the first one located.
    const marks = rememberThreat([], { dir: 'e', seen: false }, T0);
    expect(threatTells(marks, [orb('o1', 9, 5, 5, 5)], MY_TILE, T0)).toEqual([
      { dir: 'e', seen: false },
    ]);
  });

  it('outlives nothing: the arc goes with the orb', () => {
    // No memory is written for an orb, so the frame after it lands — or after
    // the player steps aside — there is nothing to expire.
    expect(threatTells([], [orb('o1', 9, 5, 5, 5)], MY_TILE, T0)).toHaveLength(1);
    expect(threatTells([], [], MY_TILE, T0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. AT THE REAL SCALE — it must not cover the thing it points at
// ---------------------------------------------------------------------------

describe('the arc at the scale it is actually drawn', () => {
  beforeEach(() => {
    installDom(1);
  });
  afterEach(() => {
    removeDom();
  });

  /** Every point the stroke covers, as a bounding box: radius plus half a nib. */
  function coverage(arc: Arc): { x0: number; y0: number; x1: number; y1: number } {
    const half = arc.width / 2;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    // WALKED, NOT REASONED. A quarter-circle's extent is not its endpoints —
    // an arc crossing due east reaches further east than either end of it.
    for (let i = 0; i <= 720; i += 1) {
      const a = arc.start + ((arc.end - arc.start) * i) / 720;
      const px = arc.x + Math.cos(a) * arc.r;
      const py = arc.y + Math.sin(a) * arc.r;
      x0 = Math.min(x0, px - half);
      y0 = Math.min(y0, py - half);
      x1 = Math.max(x1, px + half);
      y1 = Math.max(y1, py + half);
    }
    return { x0, y0, x1, y1 };
  }

  it('stays inside the cell it is drawn on, for all eight and both grades', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TELL MUST NOT COVER THE THING IT POINTS AT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The arc is drawn on the VICTIM's cell and points at an attacker standing
     * somewhere else — so a stroke that spilled over the rim would be painted
     * on top of the body the player is being told to look at, and on a packed
     * board every token would be wearing its neighbour's arc. At `TILE_PX` 32
     * the radius is 14 and the widest nib is 3: 15.5 from the centre, a clean
     * half-pixel inside the 16 the cell allows. Asserted at the REAL scale
     * because that margin is what would vanish first if either number moved.
     */
    for (const dir of DIR_ORDER) {
      for (const seen of [true, false]) {
        const ctx = paint({
          level: SMALL,
          actors: [SELF],
          selfId: 'me',
          threats: [{ x: 5, y: 5, dir, seen }],
        });
        const arc = ctx.arcs[0] as Arc;
        const box = coverage(arc);
        const label = `${dir} ${seen ? 'seen' : 'unseen'}`;
        expect(box.x0, label).toBeGreaterThanOrEqual(arc.x - TILE_PX / 2);
        expect(box.x1, label).toBeLessThanOrEqual(arc.x + TILE_PX / 2);
        expect(box.y0, label).toBeGreaterThanOrEqual(arc.y - TILE_PX / 2);
        expect(box.y1, label).toBeLessThanOrEqual(arc.y + TILE_PX / 2);
      }
    }
  });

  it('never touches the token of the body it is pointing at', () => {
    /**
     * The one that matters most, and it is asserted against the ATTACKER'S OWN
     * BLIT rather than against arithmetic: the husk is drawn one tile east, the
     * arc is drawn east on the viewer's cell, and the two rectangles must not
     * meet. A `visible()` cull or a camera change that moved one and not the
     * other would show up here and nowhere else.
     */
    const husk = { ...SELF, id: 'husk', name: 'Index Husk', sprite: 'h', x: 6, y: 5 };
    const ctx = paint({
      level: SMALL,
      actors: [SELF, husk],
      selfId: 'me',
      threats: [{ x: 5, y: 5, dir: 'e', seen: true }],
    });
    const arc = ctx.arcs[0] as Arc;
    const box = coverage(arc);
    // The cell-sized blits are the token rings, in draw order: the viewer's
    // first (y-sorted, then x), the husk's second.
    const rings = ctx.blits.filter((b) => b.dw === TILE_PX && b.dh === TILE_PX);
    const hostile = rings[1];
    expect(hostile, 'the husk was never drawn').toBeDefined();
    // ...AND IT REALLY IS THE HUSK'S CELL, one tile east of the viewer's. Named
    // rather than assumed: `rings[1]` being the wrong token would make the
    // assertion below pass for the wrong reason.
    expect(hostile?.dx).toBe((rings[0]?.dx ?? 0) + TILE_PX);
    expect(box.x1).toBeLessThanOrEqual(hostile?.dx ?? 0);
  });

  it('leaves the middle of the token clear, so the body under it is still read', () => {
    // A filled wedge would have been the obvious drawing and would have hidden
    // the player's own sprite — the one token they steer. The arc is a stroke
    // at the rim, so the inner half of the cell is untouched by it.
    const ctx = paint({
      level: SMALL,
      actors: [SELF],
      selfId: 'me',
      threats: [{ x: 5, y: 5, dir: 'e', seen: true }],
    });
    const arc = ctx.arcs[0] as Arc;
    expect(arc.r - arc.width / 2).toBeGreaterThan(TILE_PX / 4);
  });
});
