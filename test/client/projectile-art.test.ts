/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRenderer,
  PALETTE,
  projectileHeading,
  projectileSpriteId,
  ZONE_WASH_INK,
} from '../../src/client/render/canvas.ts';
import { MONSTER_TEMPLATES, monsterById, monsterInit } from '../../src/server/content/monsters.ts';
import { DEFAULT_PROJECTILE_DAMAGE_TYPE } from '../../src/server/engine/projectile.ts';
import { DAMAGE_TYPES, DamageType } from '../../src/shared/damagetype.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { ActorView, LevelView, ProjectileView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SHOT IN THE GAME HAS A PICTURE, AND IT POINTS THE WAY IT IS GOING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from play: *"it seems projectiles are using solid colored boxes
 * instead of the sprites codex made for the projectiles. lets fix this and
 * ensure all projectiles have art wired."*
 *
 * ═══ WALKED, NOT SAMPLED ═══
 * `DAMAGE_TYPES` is the closed list and every case below iterates it. The
 * failure this feature can actually have is ONE element out of six resolving to
 * nothing — a wraith's bolt drawn and an ash-thing's drawn as a triangle — and a
 * test that fired a fire bolt would never see it.
 *
 * ═══ THE CHAIN THAT HAS TO HOLD, AND ALL FOUR LINKS ARE HERE ═══
 *   1. the server says WHICH element (`ProjectileView.damageType`),
 *   2. `PROJECTILE_SPRITE` turns that into an id,
 *   3. `NEEDED_ASSET_PREFIXES` in main.ts admits the id, or `loadSprites` never
 *      fetches the PNG and `sprites.sprite()` answers undefined for ever, and
 *   4. ASSETS-REQUIRED.md — the committed half, since client/public/assets/ is
 *      gitignored wholesale — names the file.
 * Link 3 is the one that has silently broken four times in this client
 * (`icon_ability_`, `icon_passive_`, `prop_`, and now this), and it is invisible
 * from both ends: the prefix list looks ordinary and the fallback is a
 * documented, deliberate state. So it is asserted from the drawing end here.
 */

const ROOT = new URL('../../', import.meta.url);
/**
 * CODE ONLY, COMMENTS STRIPPED — `test/client/assets.test.ts` states why and it
 * bit this file on the way in: main.ts is heavily commented by house rule, the
 * prose QUOTES the ids it justifies, and an apostrophe in a sentence reads as a
 * string quote to the scrape below. The prefix list came back with two
 * paragraphs of English in it.
 */
const MAIN = readFileSync(new URL('src/client/main.ts', ROOT), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const COMMISSION = readFileSync(new URL('ASSETS-REQUIRED.md', ROOT), 'utf8');

function loadedPrefixes(): readonly string[] {
  const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(MAIN);
  expect(block, 'NEEDED_ASSET_PREFIXES is gone — this guard is now blind').not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

// ---------------------------------------------------------------------------
// 1. THE TABLE
// ---------------------------------------------------------------------------

describe('every damage type this game can fire has a bolt', () => {
  it('resolves an id for all six, and no two share one', () => {
    const ids = DAMAGE_TYPES.map((type) => {
      const id = projectileSpriteId({ damageType: type });
      expect(id, `no bolt sprite for ${type}`).toBeDefined();
      return id ?? '';
    });
    expect(new Set(ids).size, 'two elements share one picture').toBe(DAMAGE_TYPES.length);
  });

  it('names an id main.ts actually loads, for all six', () => {
    // THE LINK THAT BREAKS SILENTLY. A prefix that does not cover these ids
    // filters them out of the manifest before `loadSprites` ever fetches one,
    // and the painter then draws its fallback for ever with the art on disk.
    const prefixes = loadedPrefixes();
    for (const type of DAMAGE_TYPES) {
      const id = projectileSpriteId({ damageType: type }) ?? '';
      expect(
        prefixes.some((prefix) => id.startsWith(prefix)),
        `${id} is under no prefix main.ts loads`,
      ).toBe(true);
    }
  });

  it('names a file the commission actually carries, for all six', () => {
    // client/public/assets/ is gitignored WHOLESALE, manifest included, so the
    // markdown is the only half of this a clone can check — which is the rule
    // test/client/assets.test.ts already states for the item and prop families.
    for (const type of DAMAGE_TYPES) {
      const id = projectileSpriteId({ damageType: type }) ?? '';
      expect(COMMISSION, `${id} is in no ASSETS-REQUIRED.md entry`).toContain(id);
    }
  });

  it('answers undefined when the server did not say, rather than guessing one', () => {
    // A GUESS WOULD BE A LIE ABOUT THE ELEMENT. `damageType` is optional on the
    // wire (an older server sends none), and defaulting to physical would draw a
    // steel dart for a fire bolt — worse than the honest fallback, because it
    // looks finished.
    expect(projectileSpriteId({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. THE HEADING
// ---------------------------------------------------------------------------

describe('the bolt points where it is going', () => {
  const QUARTER = Math.PI / 2;
  const EIGHTH = Math.PI / 4;

  /** From the orb's tile toward its FROZEN aim tile. East is the art's own zero. */
  const CASES: readonly { readonly dx: number; readonly dy: number; readonly turn: number }[] = [
    { dx: 5, dy: 0, turn: 0 },
    { dx: 5, dy: 5, turn: EIGHTH },
    { dx: 0, dy: 5, turn: QUARTER },
    { dx: -5, dy: 5, turn: EIGHTH * 3 },
    { dx: -5, dy: 0, turn: Math.PI },
    { dx: -5, dy: -5, turn: -EIGHTH * 3 },
    { dx: 0, dy: -5, turn: -QUARTER },
    { dx: 5, dy: -5, turn: -EIGHTH },
  ];

  for (const c of CASES) {
    it(`turns ${String(c.dx)},${String(c.dy)} to ${c.turn.toFixed(3)} radians`, () => {
      const heading = projectileHeading({ x: 10, y: 10, targetX: 10 + c.dx, targetY: 10 + c.dy });
      // Modulo 2π, because -π and π are the same direction and `atan2` may
      // answer either at the exact west.
      const same = Math.abs(Math.cos(heading) - Math.cos(c.turn)) < 1e-9;
      const also = Math.abs(Math.sin(heading) - Math.sin(c.turn)) < 1e-9;
      expect(same && also, `${String(heading)} is not ${String(c.turn)}`).toBe(true);
    });
  }

  it('snaps a shallow line to the direction it mostly steps in', () => {
    // The flight path is a frozen Bresenham line, so every step is one of eight.
    // An aim ten tiles east and one south is a run of east steps with one
    // diagonal in it, and east is the honest picture.
    expect(projectileHeading({ x: 0, y: 0, targetX: 10, targetY: 1 })).toBe(0);
  });

  it('answers east on the aim tile itself rather than dividing by nothing', () => {
    // The art's native orientation, and at most the one frame between arriving
    // and detonating.
    expect(projectileHeading({ x: 4, y: 4, targetX: 4, targetY: 4 })).toBe(0);
  });

  it('never answers an angle that is not one of the eight', () => {
    for (let dx = -6; dx <= 6; dx += 1) {
      for (let dy = -6; dy <= 6; dy += 1) {
        const heading = projectileHeading({ x: 0, y: 0, targetX: dx, targetY: dy });
        const eighths = heading / EIGHTH;
        expect(Math.abs(eighths - Math.round(eighths)), `${String(dx)},${String(dy)}`).toBeLessThan(
          1e-9,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. THE DRAWN FRAME
// ---------------------------------------------------------------------------

type Op =
  | { readonly op: 'translate'; readonly x: number; readonly y: number }
  | { readonly op: 'rotate'; readonly a: number }
  | { readonly op: 'fill'; readonly style: string }
  | { readonly op: 'path'; readonly style: string }
  | {
      readonly op: 'blit';
      readonly id: string | null;
      readonly args: readonly number[];
    };

type RecordingCanvas = {
  width: number;
  height: number;
  readonly ops: Op[];
  getContext: (kind: string) => unknown;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
};

/**
 * A context that records the FOUR things this painter's claim is made of: the
 * pivot, the turn, the blit (with its SOURCE rect, which is the frame index) and
 * the filled path the fallback draws. `test/client/canvasstub.ts` keeps only a
 * blit's destination, and a rotated blit's destination is `-32,-32` in every
 * case — so it could not tell a bolt on the right tile from one on the wrong one.
 */
function recordingCanvas(cssW = 0, cssH = 0): RecordingCanvas {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
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
          if (prop === 'translate') {
            return (x: number, y: number) => {
              ops.push({ op: 'translate', x, y });
            };
          }
          if (prop === 'rotate') {
            return (a: number) => {
              ops.push({ op: 'rotate', a });
            };
          }
          if (prop === 'fill') {
            return () => {
              ops.push({ op: 'path', style: String(target.fillStyle) });
            };
          }
          if (prop === 'fillRect') {
            return () => {
              ops.push({ op: 'fill', style: String(target.fillStyle) });
            };
          }
          if (prop === 'drawImage') {
            return (source: unknown, ...nums: number[]) => {
              const id =
                typeof source === 'object' && source !== null && 'id' in source
                  ? String(source.id)
                  : null;
              ops.push({ op: 'blit', id, args: nums });
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

/** Every id answers, at the wrong size — a cell mark must fill the cell anyway. */
function everyBolt(): SpriteSource & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sprite: (id: string) => {
      asked.push(id);
      // 256x64: four 64x64 frames, which is what the strips actually are.
      return { id, image: { id } as unknown as HTMLImageElement, w: 256, h: 64 };
    },
  };
}

/** A bare clone: client/public/assets/ is gitignored, so nothing answers. */
const NO_ART: SpriteSource = { sprite: () => undefined };

/** The viewer's body, and the orb stands on its tile so the pivot is the centre. */
const SELF = { x: 20, y: 15 } as const;

function player(): ActorView {
  return {
    id: 'me',
    name: 'Ren',
    sprite: 'chr_player_watchman_s',
    x: SELF.x,
    y: SELF.y,
    kind: 'player',
    rank: ActorRank.Normal,
    hp: 10,
    maxHp: 10,
    alive: true,
  };
}

function map(): LevelView {
  return { w: 60, h: 40, tiles: new Array<number>(60 * 40).fill(1) };
}

function orb(over: Partial<ProjectileView> = {}): ProjectileView {
  return {
    id: 'proj_1',
    x: SELF.x,
    y: SELF.y,
    targetX: SELF.x + 5,
    targetY: SELF.y,
    turnsToImpact: 2,
    ...over,
  };
}

/**
 * ONE FRAME, AND THE BACKBUFFER'S OWN OPS.
 *
 * The renderer paints the world into an off-screen canvas it makes through
 * `document.createElement` and then composites it, so the visible canvas records
 * one blit and nothing else. This keeps a handle on every canvas the renderer
 * asks for and returns the busiest — which is the map backbuffer by a wide
 * margin — after checking that the composite happened at all, because every
 * assertion below would otherwise be reading an empty buffer and passing.
 */
function drawAndRecord(
  sprites: SpriteSource,
  projectiles: readonly ProjectileView[],
): { readonly ops: readonly Op[]; readonly logicalW: number; readonly logicalH: number } {
  const made: RecordingCanvas[] = [];
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      const canvas = recordingCanvas();
      made.push(canvas);
      return canvas;
    },
  };
  const visible = recordingCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites,
  });
  renderer.resize();
  renderer.draw({
    level: map(),
    realmKind: null,
    actors: [player()],
    selfId: 'me',
    projectiles,
  });
  const { logicalW, logicalH } = renderer.metrics();
  expect(
    visible.ops.filter((op) => op.op === 'blit').length,
    'the backbuffer was never presented',
  ).toBeGreaterThan(0);
  const busiest = made.reduce<RecordingCanvas | null>(
    (best, c) => (best === null || c.ops.length > best.ops.length ? c : best),
    null,
  );
  expect(busiest, 'no backbuffer was made').not.toBeNull();
  expect((busiest?.ops ?? []).length, 'the backbuffer recorded nothing').toBeGreaterThan(0);
  return { ops: busiest?.ops ?? [], logicalW, logicalH };
}

describe('the painter blits the element it was sent', () => {
  for (const type of DAMAGE_TYPES) {
    it(`draws ${type} from its own strip, frame 0, at cell size`, () => {
      const sprites = everyBolt();
      const { ops, logicalW, logicalH } = drawAndRecord(sprites, [orb({ damageType: type })]);
      const id = projectileSpriteId({ damageType: type });

      const blit = ops.find((op) => op.op === 'blit' && op.id === id);
      expect(blit, `${type} never reached its sprite`).toBeDefined();
      if (blit?.op !== 'blit') throw new Error('unreachable');

      // ═══ THE SOURCE RECT IS THE FRAME INDEX, AND IT MUST BE THE FIRST ═══
      // ASSETS-REQUIRED.md records that nine of the twelve bolts end their loop
      // on a shatter frame, per sprite. Frame 0 is the intact bolt; frame 3
      // would put a burst on screen while the shot is still in the air.
      expect(blit.args, 'not the nine-argument sub-rectangle form').toHaveLength(8);
      expect(blit.args.slice(0, 4), `${type} is not sliced at frame 0`).toEqual([0, 0, 64, 64]);
      // ...and the DESTINATION is the whole cell, centred on the pivot, which is
      // `blitCell`'s invariant: a cell mark fills the cell whatever size the art
      // happens to be cut at. The stub answers 256x64 on purpose.
      expect(blit.args.slice(4), `${type} is not drawn at cell size`).toEqual([
        -TILE_PX / 2,
        -TILE_PX / 2,
        TILE_PX,
        TILE_PX,
      ]);

      // ═══ AND IT IS ON THE ORB'S TILE, TURNED THE WAY IT IS FLYING ═══
      // The orb stands on the viewer's own tile in this fixture and the camera
      // is dead centre, so the pivot is the middle of the playfield.
      const pivot = ops.filter((op) => op.op === 'translate').at(-1);
      expect(pivot?.op === 'translate' && Math.abs(pivot.x - logicalW / 2) <= 1).toBe(true);
      expect(pivot?.op === 'translate' && Math.abs(pivot.y - logicalH / 2) <= 1).toBe(true);
      const turn = ops.filter((op) => op.op === 'rotate').at(-1);
      expect(turn?.op === 'rotate' && turn.a).toBe(0);

      // NOTHING ELSE WAS ASKED FOR. A painter that fell through to its fallback
      // as well would draw a dart over the bolt.
      expect(sprites.asked.filter((asked) => asked.startsWith('ui_fx_bolt_'))).toEqual([id]);
    });
  }

  it('turns the blit with the flight, not only the fallback', () => {
    const { ops } = drawAndRecord(everyBolt(), [
      orb({ damageType: DamageType.Fire, targetX: SELF.x, targetY: SELF.y - 6 }),
    ]);
    const turn = ops.filter((op) => op.op === 'rotate').at(-1);
    expect(turn?.op === 'rotate' && turn.a).toBe(-Math.PI / 2);
  });
});

describe('a clone with no art still shows the shot, and says what it is', () => {
  for (const type of DAMAGE_TYPES) {
    it(`draws ${type} as a dart in its own wash ink`, () => {
      const { ops } = drawAndRecord(NO_ART, [orb({ damageType: type })]);
      const paths = ops.filter((op) => op.op === 'path');
      // TWO: the INK surround and the dart itself, which is the legibility trick
      // the status pips use — the orb crosses floor, wall and the lit top edge of
      // a wall within one flight.
      expect(paths.map((p) => (p.op === 'path' ? p.style : ''))).toEqual([
        PALETTE.INK,
        ZONE_WASH_INK[type],
      ]);
      // AND IT IS STILL TURNED. A fallback that lost the heading would answer
      // "something is flying" and drop "and it is coming from over there".
      expect(ops.some((op) => op.op === 'rotate')).toBe(true);
    });
  }

  it('never draws the violet missing-asset box for a shot', () => {
    // `blitSprite` resolves a miss to that box because an invisible PLAYER must
    // be loud. On a bare clone EVERY orb misses, so the loud box would be the
    // ordinary state of the game rather than an alarm.
    //
    // ═══ MEASURED BY SUBTRACTION, because the PLAYER draws one too ═══
    // The viewer's own token has no art on a clone either, and `blitSprite` is
    // right to shout about that. So the same frame is drawn twice, with and
    // without the orb, and only what the orb ADDED is asked about — the body,
    // the floor and the light are in both and cancel.
    const before = drawAndRecord(NO_ART, []);
    const after = drawAndRecord(NO_ART, [orb({ damageType: DamageType.Fire })]);
    const added = after.ops.slice(before.ops.length);
    expect(added.length, 'the orb added nothing at all').toBeGreaterThan(0);
    for (const op of added) {
      if (op.op === 'fill' || op.op === 'path') {
        expect(op.style, 'a shot painted in the missing-asset colour').not.toBe(PALETTE.VIOLET_HI);
      }
    }
    // ...and it is the DART that was added, not a box.
    expect(added.filter((op) => op.op === 'path')).toHaveLength(2);
  });

  it('draws an orb whose element the server did not send, in orange', () => {
    // An older server. It is still a shot and it must still be on screen: a
    // frame that dropped it would delete from the player a fact the engine is
    // still going to act on.
    const { ops } = drawAndRecord(NO_ART, [orb()]);
    const paths = ops.filter((op) => op.op === 'path');
    expect(paths.map((p) => (p.op === 'path' ? p.style : ''))).toEqual([
      PALETTE.INK,
      PALETTE.ORANGE,
    ]);
  });

  it('draws nothing at all when the sky is clear', () => {
    const empty = drawAndRecord(NO_ART, []);
    const withOne = drawAndRecord(NO_ART, [orb()]);
    expect(withOne.ops.filter((op) => op.op === 'path').length).toBeGreaterThan(
      empty.ops.filter((op) => op.op === 'path').length,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE ROSTER — the four creatures that fire one, and what each throws
// ---------------------------------------------------------------------------

describe('every shooter on the roster names its element', () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════
   * THREE OF THE FOUR DECLARED NOTHING, AND THE FALLBACK IS SILENT.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * The cases above prove that every ELEMENT has a picture. They cannot see the
   * failure that was actually shipped, which is a creature that never names one:
   * `fire` (engine/scheduler.ts) reads `sheet?.damageType ??
   * DEFAULT_PROJECTILE_DAMAGE_TYPE`, so a template with no element does not
   * fail — it quietly throws a physical bolt. The Index Cairn, the High
   * Inquisitor and the Watcher were all in that state: a stone lit violet, a
   * darkness caster whose own docblock says three times that it throws the
   * wraith's dark orb, and an eleven-tile boss that stuns you by looking at you
   * — all three firing the steel dart.
   *
   * THE TABLE IS CONTENT, not a rule to be relaxed: an archer that really does
   * fire a physical bolt belongs in it as `Physical`, which is one line here.
   */
  const SHOOTERS: readonly (readonly [string, DamageType])[] = [
    ['index_wraith', DamageType.Darkness],
    ['index_cairn', DamageType.Mind],
    ['index_inquisitor', DamageType.Darkness],
    ['index_watcher', DamageType.Mind],
  ];

  it('is every creature that can fire one, in roster order', () => {
    // `damageMin` IS THE PREDICATE, and content/monsters.ts says why in as many
    // words: absent is not "3-6", it is *"this creature never reaches `fire`"*.
    // Written this way so a fifth shooter lands in this table rather than
    // shipping whatever the default happens to be.
    expect(MONSTER_TEMPLATES.filter((t) => t.damageMin !== undefined).map((t) => t.id)).toEqual(
      SHOOTERS.map(([id]) => id),
    );
  });

  /**
   * ═══ ASKED OF THE BODY THAT FIRES, NOT OF THE TEMPLATE IT WAS CUT FROM ═══
   *
   * `fire` reads `sheet?.damageType` off the LIVE actor's combat sheet
   * (engine/scheduler.ts), and the sheet is what `monsterInit` builds. Reading
   * `monsterById(id).combat` instead asks the authored half of a two-step join
   * and cannot see the step in between drop the field — which is the whole
   * failure this block exists for. One `monsterInit` call closes it, and costs
   * nothing: the field is either carried across or it is not.
   */
  const sheetOf = (id: string) => {
    const template = MONSTER_TEMPLATES.find((t) => t.id === id);
    if (template === undefined) throw new Error(`no such creature: ${id}`);
    return monsterInit(template, { x: 5, y: 5 }).combat;
  };

  it('declares an element rather than falling through to the default', () => {
    for (const [id] of SHOOTERS) {
      expect(sheetOf(id)?.damageType, `${id} declares no element`).toBeDefined();
      // AND THE DEFAULT IS WHAT "falling through" MEANS, named rather than
      // implied: a creature that resolved to it by accident would be
      // indistinguishable from one that chose it.
      expect(
        sheetOf(id)?.damageType ?? DEFAULT_PROJECTILE_DAMAGE_TYPE,
        `${id} throws the steel dart`,
      ).not.toBe(DEFAULT_PROJECTILE_DAMAGE_TYPE);
    }
  });

  it('throws what its own fiction says it throws', () => {
    // Two families, two elements: the wraith and the Inquisitor share the dark
    // orb on purpose (the Inquisitor *"is not a bigger gun, it is the same gun
    // you cannot walk away from"*), and the Cairn and the Watcher are one stone
    // family — the same base, the same stat line, the same speed.
    for (const [id, type] of SHOOTERS) {
      expect(sheetOf(id)?.damageType, id).toBe(type);
      // THE AUTHORED HALF TOO, so a failure says WHICH of the two steps lost it.
      expect(monsterById(id)?.combat.damageType, `${id}, as authored`).toBe(type);
    }
  });

  it('draws each one with the bolt for its element', () => {
    const drawn = SHOOTERS.map(([id]) =>
      projectileSpriteId({ damageType: sheetOf(id)?.damageType }),
    );
    // THE WHOLE CHAIN IN ONE LINE: the template's field, `PROJECTILE_SPRITE`,
    // and the ids the commission carries. A template that lost its element
    // resolves to `ui_fx_bolt_physical` here and this fails by NAME rather than
    // by a missing picture, which is how the bug was invisible the first time.
    expect(drawn).toEqual([
      'ui_fx_bolt_darkness',
      'ui_fx_bolt_mind',
      'ui_fx_bolt_darkness',
      'ui_fx_bolt_mind',
    ]);
    for (const id of drawn)
      expect(COMMISSION, `${id ?? ''} is in no commission entry`).toContain(id ?? '');
  });
});
