/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROP_ART_COMMISSION } from '../../content/art-requests.ts';
import { PALETTE, createRenderer, ringIdFor } from '../../src/client/render/canvas.ts';
import { TRAP_KINDS } from '../../src/server/content/traps.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import type { Sprite, SpriteSource } from '../../src/client/render/assets.ts';
import type { ActorView, TrapView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FOUND TRAP SHOWS ITS PICTURE, AND A CLONE WITH NO ART STILL SHOWS THE CARET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream draws every trap as its own `image` (`traps/elemental.lua:64`,
 * `alarm.lua:29`, `natural_forest.lua:32`), and until the commission landed
 * this port drew all seven as one tinted caret. `paintTraps` now prefers the
 * picture and falls back to the caret, and both halves are a claim about what
 * lands on the canvas — which is exactly what the shared stub cannot see.
 *
 * ═══ ITS OWN HARNESS, BECAUSE THE CARET IS `fillRect` ═══
 * `canvasstub.ts` records `drawImage` and nothing else (`zonewash.test.ts`
 * spends its header on that). The caret is made of `fillRect`, and the failure
 * worth catching is the two paths running together — the picture drawn and
 * then the caret drawn over it — so this context records both, in order, with
 * the `fillStyle` each fill was made in.
 *
 * ═══ AND IT MEASURES THE TRAPS BY SUBTRACTION ═══
 * Each case draws the same floor twice, with and without the traps, and keeps
 * only what the traps added. The floor, the light and whatever the next
 * ground painter adds are in both frames and cancel, so nothing here has to
 * know what the rest of the renderer paints under a trap.
 */

type Op =
  | {
      readonly op: 'fill';
      readonly style: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly op: 'blit';
      /** The stub image's id, or null when the source is a canvas buffer. */
      readonly id: string | null;
      readonly source: unknown;
      readonly x: number;
      readonly y: number;
      readonly w: number | null;
      readonly h: number | null;
    };

type RecordingCanvas = {
  width: number;
  height: number;
  readonly ops: Op[];
  getContext: (kind: string) => unknown;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
};

function recordingCanvas(cssW = 0, cssH = 0): RecordingCanvas {
  const ops: Op[] = [];
  // Plain fields, so a painter that reads one back gets a value, not a function.
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
  };
  let ctx: unknown = null;
  const canvas: RecordingCanvas = {
    width: 0,
    height: 0,
    ops,
    getContext(kind) {
      if (kind !== '2d') return null;
      ctx ??= new Proxy(state, {
        get(target, prop) {
          if (prop === 'canvas') return canvas;
          if (prop === 'fillRect') {
            return (x: number, y: number, w: number, h: number) => {
              ops.push({ op: 'fill', style: String(target.fillStyle), x, y, w, h });
            };
          }
          if (prop === 'drawImage') {
            return (source: unknown, ...nums: number[]) => {
              // (src, dx, dy), (src, dx, dy, dw, dh), or the nine-argument
              // sub-rectangle form whose destination is its last four numbers.
              const d = nums.length >= 8 ? nums.slice(4) : nums;
              const id =
                typeof source === 'object' && source !== null && 'id' in source
                  ? String(source.id)
                  : null;
              ops.push({
                op: 'blit',
                id,
                source,
                x: d[0] ?? 0,
                y: d[1] ?? 0,
                w: d[2] ?? null,
                h: d[3] ?? null,
              });
            };
          }
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
            return () => ({ addColorStop: () => undefined });
          }
          if (typeof prop === 'string' && prop in target) return target[prop];
          return () => undefined;
        },
        set(target, prop, value) {
          if (typeof prop === 'string') target[prop] = value;
          return true;
        },
      });
      return ctx;
    },
    getBoundingClientRect: () => ({ width: cssW, height: cssH, left: 0, top: 0 }),
  };
  return canvas;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return recordingCanvas();
    },
  };
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
});

/**
 * WHAT EACH KIND DRAWS AS. `null` is the caret: upstream's lethargy rune
 * (`annoy.lua:27`) was never commissioned, so it keeps the mark, and the cold,
 * lightning and teleport pictures are held back until they are redrawn (see
 * `TRAP_SPRITE` in render/canvas.ts), so those three keep it too.
 *
 * Checked against the briefs in `content/art-requests.ts` before these were
 * deleted from it, and against the upstream entry each kind ports:
 * `trap_cold` is the "ice trap" (`elemental.lua:76`), so it wears the frost
 * sigil; `trap_rock` is the "sliding rock" (`natural_forest.lua:32`), the name
 * that picture was commissioned under, and not `prop_trap_boulder`, which is
 * the "giant boulder trap" (`complex.lua:33`).
 */
const PICTURE: Readonly<Record<string, string | null>> = {
  trap_fire: 'prop_trap_rune_fire',
  trap_cold: null,
  trap_lightning: null,
  trap_alarm: 'prop_trap_alarm_bell',
  trap_rock: 'prop_trap_sliding_rock',
  trap_teleport: null,
  trap_lethargy: null,
};

/** A kind the server has never rolled. It must draw SOMETHING, and it is the caret. */
const UNKNOWN_KIND = 'trap_unrecognised';

/** Art at half a cell. A picture on a cell fills the cell whatever size it was cut. */
const ART_PX = TILE_PX / 2;

/** Every id answers, at the wrong size, and every id asked for is written down. */
function everyPicture(): SpriteSource & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sprite: (id: string): Sprite => {
      asked.push(id);
      return { id, image: { id } as unknown as HTMLImageElement, w: ART_PX, h: ART_PX };
    },
  };
}

/** A bare clone: `client/public/assets/` is gitignored, so nothing answers. */
const NO_ART: SpriteSource = { sprite: () => undefined };

/**
 * One frame, on a level EXACTLY the size of the view. `cameraAxis` centres a
 * map no bigger than the buffer, and one exactly its size centres at zero, so a
 * cell's origin is `x * TILE_PX` and no case has to repeat the camera maths.
 */
function frame(sprites: SpriteSource, traps: readonly TrapView[] | undefined): readonly Op[] {
  const visible = recordingCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites,
  });
  renderer.resize();
  const { logicalW, logicalH } = renderer.metrics();
  const w = logicalW / TILE_PX;
  const h = logicalH / TILE_PX;
  expect(w, 'the view is too narrow for a row of eight traps').toBeGreaterThanOrEqual(16);
  expect(h).toBeGreaterThanOrEqual(4);
  expect(w, 'the off-screen trap is on screen').toBeLessThan(OFF_SCREEN.x - 3);
  renderer.draw({
    level: { w, h, tiles: new Array<number>(w * h).fill(1) },
    realmKind: null,
    actors: [],
    selfId: null,
    ...(traps === undefined ? {} : { traps }),
  });
  // The map buffer is the first thing composited onto the visible canvas.
  const first = visible.ops.find((op) => op.op === 'blit');
  const back = first?.op === 'blit' ? (first.source as RecordingCanvas | null) : null;
  expect(back?.ops, 'the map buffer was never presented').toBeDefined();
  return back?.ops ?? [];
}

function key(op: Op): string {
  return op.op === 'fill'
    ? `fill ${op.style} ${String(op.x)},${String(op.y)} ${String(op.w)}x${String(op.h)}`
    : `blit ${String(op.id)} ${String(op.x)},${String(op.y)} ${String(op.w)}x${String(op.h)}`;
}

/** The ops in `withTraps` that `without` does not also hold, counted as a multiset. */
function subtract(withTraps: readonly Op[], without: readonly Op[]): readonly Op[] {
  const left = new Map<string, number>();
  for (const op of without) left.set(key(op), (left.get(key(op)) ?? 0) + 1);
  return withTraps.filter((op) => {
    const n = left.get(key(op)) ?? 0;
    if (n === 0) return true;
    left.set(key(op), n - 1);
    return false;
  });
}

/** What the traps added: the frame with them, less the same frame without. */
function trapOps(sprites: SpriteSource, traps: readonly TrapView[]): readonly Op[] {
  return subtract(frame(sprites, traps), frame(sprites, undefined));
}

/**
 * ═══ AND ONE FRAME WHERE THE CAMERA IS NOT ZERO ═══
 * `frame` holds the camera at the origin, and at the origin a painter that
 * forgot to subtract it draws in exactly the right place — so every case built
 * on it passes whether `paintTraps` honours the camera or not. In play the
 * camera follows you and is almost never zero.
 *
 * So: a level many views wide and tall, with this viewer standing in the
 * middle of it. The camera is READ BACK from where the self's own ring landed
 * rather than recomputed here, so this case holds no copy of `cameraAxis`.
 */
const SELF: ActorView = {
  id: 'p1',
  name: 'Ren',
  sprite: 'chr_player_watchman_s',
  x: 60,
  y: 40,
  kind: 'player',
  rank: ActorRank.Normal,
  hp: 10,
  maxHp: 10,
  alive: true,
};

function scrolledFrame(sprites: SpriteSource, traps: readonly TrapView[] | undefined) {
  const visible = recordingCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites,
  });
  renderer.resize();
  const w = SELF.x * 2;
  const h = SELF.y * 2;
  renderer.draw({
    level: { w, h, tiles: new Array<number>(w * h).fill(1) },
    realmKind: null,
    actors: [SELF],
    selfId: SELF.id,
    ...(traps === undefined ? {} : { traps }),
  });
  const first = visible.ops.find((op) => op.op === 'blit');
  const back = first?.op === 'blit' ? (first.source as RecordingCanvas | null) : null;
  const ops = back?.ops ?? [];
  const ring = ops.find((op) => op.op === 'blit' && op.id === ringIdFor(SELF, SELF.id));
  expect(ring, 'the self was not drawn, so there is no camera to read').toBeDefined();
  return {
    ops,
    cam: { x: SELF.x * TILE_PX - (ring?.x ?? 0), y: SELF.y * TILE_PX - (ring?.y ?? 0) },
  };
}

/** One of every kind the server rolls, then the unknown one, a cell apart on one row. */
const ROW: readonly TrapView[] = [...TRAP_KINDS, UNKNOWN_KIND].map((kind, i) => ({
  x: 1 + i * 2,
  y: 2,
  kind,
}));

/**
 * A trap well past the right edge of the view — more than `ACTOR_CULL_MARGIN_PX`
 * past it. Every ground painter culls, and the picture path must not skip that
 * by being checked first.
 */
const OFF_SCREEN: TrapView = { x: 60, y: 2, kind: 'trap_fire' };

/** Whether `op` lands inside the trap's cell ON SCREEN, for the given camera. */
function inCell(op: Op, trap: TrapView, cam = { x: 0, y: 0 }): boolean {
  const x = trap.x * TILE_PX - cam.x;
  const y = trap.y * TILE_PX - cam.y;
  return op.x >= x && op.x < x + TILE_PX && op.y >= y && op.y < y + TILE_PX;
}

/** The caret's shape inside its own cell, with the colour left out. */
function shape(ops: readonly Op[], trap: TrapView): string[] {
  return ops.map(
    (op) =>
      `${op.op} ${String(op.x - trap.x * TILE_PX)},${String(op.y - trap.y * TILE_PX)} ${String(op.w)}x${String(op.h)}`,
  );
}

describe('a found trap shows its rune', () => {
  it('has a decision for every kind the server rolls', () => {
    // A new trap kind fails here until somebody says what it looks like.
    expect(Object.keys(PICTURE).sort()).toEqual([...TRAP_KINDS].sort());
    expect(TRAP_KINDS).not.toContain(UNKNOWN_KIND);
  });

  it('draws each kind as its own picture, filling the cell, and nothing over it', () => {
    const sprites = everyPicture();
    const ops = trapOps(sprites, [...ROW, OFF_SCREEN]);

    for (const trap of ROW) {
      const here = ops.filter((op) => inCell(op, trap));
      const picture = PICTURE[trap.kind] ?? null;
      if (picture !== null) {
        // ONE blit, of this kind's own id, at the cell and at the cell's size.
        // A caret drawn after it would be a fill in this list.
        expect(here.map(key), `${trap.kind} did not draw ${picture} alone`).toEqual([
          `blit ${picture} ${String(trap.x * TILE_PX)},${String(trap.y * TILE_PX)} ${String(TILE_PX)}x${String(TILE_PX)}`,
        ]);
        continue;
      }
      // LETHARGY AND THE UNKNOWN KIND KEEP THE CARET, and it is the table's
      // decision rather than a miss: this source answers every id there is.
      expect(here.length, `${trap.kind} drew nothing`).toBeGreaterThan(0);
      expect(
        here.every((op) => op.op === 'fill'),
        `${trap.kind} drew a picture`,
      ).toBe(true);
    }

    // Nothing was drawn anywhere but on the on-screen traps' own cells.
    expect(ops.filter((op) => !ROW.some((trap) => inCell(op, trap)))).toEqual([]);
    // And the renderer asked for no trap picture this table does not name.
    const named = new Set(Object.values(PICTURE));
    expect(sprites.asked.filter((id) => id.startsWith('prop_trap_') && !named.has(id))).toEqual([]);
  });

  it('draws the caret for every kind on a clone with no art, and never the missing-art box', () => {
    const ops = trapOps(NO_ART, [...ROW, OFF_SCREEN]);
    const shapes = ROW.map((trap) =>
      shape(
        ops.filter((op) => inCell(op, trap)),
        trap,
      ),
    );

    for (const [i, trap] of ROW.entries()) {
      const here = ops.filter((op) => inCell(op, trap));
      expect(here.length, `${trap.kind} drew nothing without its art`).toBeGreaterThan(0);
      expect(here.filter((op) => op.op === 'blit')).toEqual([]);
      // `blitSprite` answers a miss with a VIOLET_HI box. That is the alarm for
      // a broken manifest, and a clone with no manifest is not broken.
      expect(
        here.filter((op) => op.op === 'fill' && op.style === PALETTE.VIOLET_HI),
        `${trap.kind} drew the missing-art box`,
      ).toEqual([]);
      // THE SAME CARET IN EVERY CELL: one shape, whatever the kind.
      expect(shapes[i], `${trap.kind} drew a different mark`).toEqual(shapes[0]);
    }
    expect(ops.filter((op) => !ROW.some((trap) => inCell(op, trap)))).toEqual([]);

    /**
     * ON A CLONE THE COLOUR IS THE WHOLE IDENTITY, which is why `TRAP_INK`
     * departs from upstream three times. Seven kinds, seven inks: two carets in
     * one colour would be one mark meaning two different traps.
     */
    const inks = TRAP_KINDS.map((kind) => {
      const trap = ROW.find((t) => t.kind === kind);
      const styles = new Set(
        ops.flatMap((op) =>
          trap !== undefined && inCell(op, trap) && op.op === 'fill' ? [op.style] : [],
        ),
      );
      expect(styles.size, `${kind}'s caret is not one colour`).toBe(1);
      return [...styles][0];
    });
    expect(new Set(inks).size, `two kinds share an ink: ${inks.join(' ')}`).toBe(TRAP_KINDS.length);
  });

  it('draws the picture and the caret where the camera puts the cell, not where the world does', () => {
    const fire: TrapView = { x: SELF.x + 2, y: SELF.y + 1, kind: 'trap_fire' };
    const lethargy: TrapView = { x: SELF.x - 2, y: SELF.y + 1, kind: 'trap_lethargy' };
    const sprites = everyPicture();
    const withTraps = scrolledFrame(sprites, [fire, lethargy]);
    const { cam } = withTraps;
    expect(cam.x, 'the camera did not scroll, so this is the zero camera again').toBeGreaterThan(0);
    expect(cam.y, 'the camera did not scroll, so this is the zero camera again').toBeGreaterThan(0);
    const ops = subtract(withTraps.ops, scrolledFrame(sprites, undefined).ops);

    expect(ops.filter((op) => inCell(op, fire, cam)).map(key)).toEqual([
      `blit prop_trap_rune_fire ${String(fire.x * TILE_PX - cam.x)},${String(fire.y * TILE_PX - cam.y)} ${String(TILE_PX)}x${String(TILE_PX)}`,
    ]);
    const caret = ops.filter((op) => inCell(op, lethargy, cam));
    expect(caret.length, 'the caret is not in its cell on screen').toBeGreaterThan(0);
    expect(caret.every((op) => op.op === 'fill')).toBe(true);
    expect(ops.filter((op) => !inCell(op, fire, cam) && !inCell(op, lethargy, cam))).toEqual([]);
  });

  it('loads every picture it draws, and only those', () => {
    /**
     * THE JOIN. A picture the renderer asks for and `main.ts` never loads is a
     * miss forever, and a miss here is the caret — a supported state, so nothing
     * would ever fail on it. The prefixes are read out of `main.ts` with its
     * comments stripped, the way `assets.test.ts` reads them.
     */
    const main = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(main);
    expect(block, 'NEEDED_ASSET_PREFIXES moved — this join is now blind').not.toBeNull();
    const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    const loaded = (id: string): boolean => prefixes.some((prefix) => id.startsWith(prefix));

    const pictures = Object.values(PICTURE).filter((id): id is string => id !== null);
    expect(pictures).toHaveLength(3);
    for (const id of pictures) expect(loaded(id), `${id} is drawn and never loaded`).toBe(true);

    // AND ONLY THOSE: the commission still holds the trap pictures nothing draws,
    // the three held back among them, and a `prop_trap_` prefix would fetch
    // every one of them.
    const commissioned = PROP_ART_COMMISSION.map((request) => request.id);
    const undrawn = commissioned.filter((id) => id.startsWith('prop_trap_'));
    expect(undrawn.length, 'no trap picture is left to guard against').toBeGreaterThan(0);
    expect(undrawn.filter(loaded), 'a commissioned trap picture is loaded').toEqual([]);
    // An id leaves the commission when the code that draws it names it.
    expect(pictures.filter((id) => commissioned.includes(id))).toEqual([]);
  });
});
