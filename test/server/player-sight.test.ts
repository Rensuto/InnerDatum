// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/Player.lua:646-663
// (playerFOV's three passes), game/modules/tome/class/Player.lua:709 (lineFOV's sight term)
// and game/engines/default/engine/interface/ActorFOV.lua:49-130 (computeFOV).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { DELVES } from '../../src/server/content/delve.ts';
import { liteRadiusOf, sensesRadiusOf, sightRadiusOf } from '../../src/server/engine/derived.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { visionOf } from '../../src/server/view/eyesight.ts';
import { visibleActorIds } from '../../src/server/view/projector.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { bresenham } from '../../src/shared/coords.ts';
import { discTiles, euclidDistance, tileDistance } from '../../src/shared/distance.ts';
import { fogHas } from '../../src/shared/fog.ts';
import { blocksSightAt, canWalk } from '../../src/shared/level.ts';
import { circleCells } from '../../src/shared/mapgen/fovcircle.ts';
import { TileCode, alwaysRemembered } from '../../src/shared/protocol.ts';
import { DEFAULT_SIGHT_RADIUS, hasLineOfSight, playerLineClear } from '../../src/shared/sight.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLAYER SEES WHAT ToME's FIELD OF VIEW REACHES, PASS BY PASS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `playerFOV` (tome/class/Player.lua:646-663) makes three passes, sight, the
 * eye's own light and every other light, and each is a `computeFOV`: libfov's
 * `calc_circle` at that pass's radius from that pass's centre, with
 * `block_sight` as the wall (`circleCells` here, shared/mapgen/fovcircle.ts).
 * Ours was the exact disc and one Bresenham line per tile. The two part
 * company three ways, each pinned below with the old rule asked alongside so
 * the fixture is shown to tell them apart:
 *
 *   - THE RIM. The rounded disc holds 32 tiles at a radius of 10 the exact one
 *     did not, (10,3) among them; a lantern of 2 holds (2,1).
 *   - PAST A PILLAR BESIDE THE EYE. The line from its centre hits the pillar;
 *     the shadowcast from the whole tile clears it.
 *   - THREADED BETWEEN TWO WALLS. The line slips through a diagonal gap the
 *     shadowcast calls closed.
 *
 * Nothing else moved, and the join at the bottom holds `visionOf` to an oracle
 * built from `circleCells` and the same lit, kept and in-view rules.
 */

/** The eye every hand-made case stands at: far enough in for a radius of 10. */
const EYE = { x: 15, y: 15 };

/** A viewer at `at` carrying a light of `lite`. */
function eyeAt(at: TileXY, lite: number): TileXY & { combat: { mods: { lite: number } } } {
  return { x: at.x, y: at.y, combat: { mods: { lite } } };
}

/** The 30x30 test level, all floor, lit everywhere or nowhere, with the walls a case names. */
function room(
  seed: string,
  lit: boolean,
  walls: readonly (readonly [number, number])[] = [],
): World {
  const world = createWorld(seed, undefined, '', lit ? undefined : { litRoomChance: 0 });
  const level = world.level;
  level.tiles.fill(TileCode.FLOOR);
  for (const [x, y] of walls) level.tiles[y * level.w + x] = TileCode.WALL;
  // THE FIXTURE MUST BE WHAT IT SAYS. A room lit where it claims dark would make
  // every lantern case below a sight case.
  expect(level.w, 'fixture: a level narrower than the sight disc').toBeGreaterThanOrEqual(
    EYE.x + DEFAULT_SIGHT_RADIUS + 2,
  );
  expect(
    world.lit.every((b) => b === (lit ? 1 : 0)),
    'fixture: the light is not what it says',
  ).toBe(true);
  return world;
}

/** Is (x, y) in the viewer's seen set? */
function sees(world: World, eye: ReturnType<typeof eyeAt>, at: TileXY): boolean {
  return fogHas(visionOf(world, eye).seen, world.level.w, at.x, at.y);
}

/** Every tile in a seen bitset, as "x,y" keys. */
function seenKeys(world: World, bits: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < world.level.h; y += 1) {
    for (let x = 0; x < world.level.w; x += 1) {
      if (fogHas(bits, world.level.w, x, y)) out.add(`${String(x)},${String(y)}`);
    }
  }
  return out;
}

const key = (t: TileXY): string => `${String(t.x)},${String(t.y)}`;

/**
 * THE RULE THIS INCREMENT REPLACED, asked alongside to show a fixture tells
 * them apart: the exact length, then one Bresenham line (`canSee` as it was).
 */
function oldSees(level: LevelView, from: TileXY, to: TileXY, radius: number): boolean {
  return euclidDistance(from, to) <= radius && hasLineOfSight(level, from, to);
}

/** `tilesInSight` as it was: the square, the exact disc, a line per tile. */
function oldTiles(level: LevelView, at: TileXY, radius: number): TileXY[] {
  const out: TileXY[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const t = { x: at.x + dx, y: at.y + dy };
      if (t.x < 0 || t.y < 0 || t.x >= level.w || t.y >= level.h) continue;
      if (oldSees(level, at, t, radius)) out.push(t);
    }
  }
  return out;
}

/** `calc_circle` with `block_sight`, on the map: the oracle every pass is held to. */
function shadowcast(level: LevelView, at: TileXY, radius: number): TileXY[] {
  return circleCells(level, at.x, at.y, radius, (x, y) => blocksSightAt(level, x, y)).filter(
    (t) => t.x >= 0 && t.y >= 0 && t.x < level.w && t.y < level.h,
  );
}

describe('a player sees through ToME`s shadowcast, not the exact disc and a line', () => {
  it('sees past a pillar beside it, where the line from its centre was blocked', () => {
    // The pillar is on the eye's east side; the tile is a knight's move and one
    // beyond it. The line from the centre runs (1,0) first.
    const world = room('player-sight-pillar', true, [[EYE.x + 1, EYE.y]]);
    const eye = eyeAt(EYE, 0);
    const past = { x: EYE.x + 3, y: EYE.y - 1 };

    expect(
      oldSees(world.level, eye, past, DEFAULT_SIGHT_RADIUS),
      'fixture: the old rule saw it',
    ).toBe(false);
    expect(sees(world, eye, past)).toBe(true);

    // AND THE BOARD, which reads the same seen set: a husk there is drawn.
    world.addMonster('husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: past.x,
      y: past.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    const husk = world.getActor('husk');
    if (husk === undefined) throw new Error('fixture: no husk');
    husk.x = past.x;
    husk.y = past.y;
    expect(visibleActorIds(world, [eye]).has('husk')).toBe(true);
  });

  it('does not see through a diagonal gap its old line threaded', () => {
    // Walls at (1,-2) and (1,0) from the eye: the line to (3,-4) steps through
    // (1,-1) between them. The shadowcast calls that gap closed.
    const world = room('player-sight-gap', true, [
      [EYE.x + 1, EYE.y - 2],
      [EYE.x + 1, EYE.y],
    ]);
    const eye = eyeAt(EYE, 0);
    const threaded = { x: EYE.x + 3, y: EYE.y - 4 };

    expect(
      oldSees(world.level, eye, threaded, DEFAULT_SIGHT_RADIUS),
      'fixture: the old rule did not see it',
    ).toBe(true);
    expect(sees(world, eye, threaded)).toBe(false);

    world.addMonster('husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: threaded.x,
      y: threaded.y,
      profile: AiProfile.MeleeChaser,
      aggroRange: 0,
    });
    const husk = world.getActor('husk');
    if (husk === undefined) throw new Error('fixture: no husk');
    husk.x = threaded.x;
    husk.y = threaded.y;
    expect(visibleActorIds(world, [eye]).has('husk')).toBe(false);
  });

  it('sees the rounded disc: (10,3) is in and (10,4) is not', () => {
    const world = room('player-sight-rim', true);
    const eye = eyeAt(EYE, 0);
    const rim = { x: EYE.x + 10, y: EYE.y + 3 };
    const past = { x: EYE.x + 10, y: EYE.y + 4 };

    expect(euclidDistance(eye, rim), 'fixture: the exact disc held the rim').toBeGreaterThan(
      DEFAULT_SIGHT_RADIUS,
    );
    expect([tileDistance(eye, rim), tileDistance(eye, past)]).toEqual([10, 11]);
    expect(sees(world, eye, rim)).toBe(true);
    expect(sees(world, eye, past)).toBe(false);

    // THE WHOLE DISC, counted: 349 tiles on open lit ground where the exact
    // disc held 317. That difference is the 32 rim tiles.
    const seen = seenKeys(world, visionOf(world, eye).seen);
    expect(seen.size).toBe(discTiles(eye, DEFAULT_SIGHT_RADIUS).length);
    expect(seen.size).toBe(349);
    expect(oldTiles(world.level, eye, DEFAULT_SIGHT_RADIUS)).toHaveLength(317);
  });
});

describe('a blind eye gropes at the whole 3x3', () => {
  it('sees its eight neighbours at radius 1, the diagonals included', () => {
    /**
     * `sightRadiusOf` floors a blind body at 1 (engine/derived.ts), and radius 1
     * of ToME's circle is the whole 3x3 whatever blocks (fovcircle.ts). Under
     * the exact disc it was the plus: the four diagonals at 1.41 refused.
     */
    const world = room('player-sight-blind', true, [[EYE.x + 1, EYE.y]]);
    const blind = { x: EYE.x, y: EYE.y, combat: { mods: { lite: 0 }, flags: { blind: true } } };
    expect(sightRadiusOf(blind)).toBe(1);
    const seen = seenKeys(world, visionOf(world, blind).seen);
    expect(seen).toEqual(new Set(discTiles(EYE, 1).map(key)));
    expect(oldTiles(world.level, EYE, 1), 'fixture: the old radius 1 was the plus').toHaveLength(5);
  });

  it('sees nothing by its own lantern, which still lights the floor for others', () => {
    /**
     * Upstream's light pass is inside `if not self:attr("blind")`
     * (tome/class/Player.lua:622): a blind player's lantern shows it nothing.
     * Ours showed the lantern's 21 tiles. In the DARK a blind eye with a lantern
     * of 2 sees only its own tile; a friend beside it sees by that lantern.
     */
    const world = room('player-sight-blind-lantern', false);
    const blind = { x: EYE.x, y: EYE.y, combat: { mods: { lite: 2 }, flags: { blind: true } } };
    expect(liteRadiusOf(blind), 'fixture: the blind eye carries no lantern').toBe(2);
    const seen = seenKeys(world, visionOf(world, blind).seen);
    expect(seen).toEqual(new Set([key(EYE)]));

    // THE SAME LANTERN, BORNE BY A BODY ON THE FLOOR, lights for a seeing eye.
    const bearer = world.addPlayer('bearer', 'Bearer');
    bearer.x = EYE.x;
    bearer.y = EYE.y;
    bearer.combat = {
      ...bearer.combat,
      mods: { ...bearer.combat?.mods, lite: 2 },
      flags: { blind: true },
    };
    const friend = { x: EYE.x + 2, y: EYE.y, combat: { mods: { lite: 0 } } };
    const friendSees = seenKeys(world, visionOf(world, friend).seen);
    expect(
      friendSees.has(key({ x: EYE.x + 1, y: EYE.y })),
      'the blind body`s lantern went dark',
    ).toBe(true);
  });
});

describe('a lantern shows the shadowcast`s disc in the dark', () => {
  it('shows the radius-2 circle, 21 tiles, where the exact disc showed 13', () => {
    const world = room('player-sight-lantern', false);
    const eye = eyeAt(EYE, 2);
    const seen = seenKeys(world, visionOf(world, eye).seen);

    expect(seen).toEqual(new Set(discTiles(eye, 2).map(key)));
    expect(seen.size).toBe(21);
    // (2,1) is the knight's move the exact disc refused at 2.24; (2,2) rounds
    // to 3 and stays dark.
    expect(seen.has(key({ x: EYE.x + 2, y: EYE.y + 1 }))).toBe(true);
    expect(seen.has(key({ x: EYE.x + 2, y: EYE.y + 2 }))).toBe(false);
    expect(oldTiles(world.level, eye, 2), 'fixture: the old lantern was the plus').toHaveLength(13);
  });

  it('stops at a wall: its face is shown and kept, the tile behind it is dark', () => {
    // libfov's fixture C: a wall at (1,0) on a radius of 2 hides (2,0) alone.
    const wall = { x: EYE.x + 1, y: EYE.y };
    const world = room('player-sight-lantern-wall', false, [[wall.x, wall.y]]);
    const eye = eyeAt(EYE, 2);
    const vision = visionOf(world, eye);
    const seen = seenKeys(world, vision.seen);

    const expected = discTiles(eye, 2)
      .map(key)
      .filter((k) => k !== key({ x: EYE.x + 2, y: EYE.y }));
    expect(seen).toEqual(new Set(expected));
    expect(seen.has(key({ x: EYE.x + 2, y: EYE.y + 1 })), 'the old line refused (2,1) too').toBe(
      true,
    );

    // WHAT IS KEPT DID NOT MOVE: dark floor a lantern shows is not remembered;
    // a wall is (`ALWAYS_REMEMBER`).
    const kept = seenKeys(world, vision.remember);
    expect(kept).toEqual(new Set([key(wall)]));
  });

  it('another body`s lantern lights its own circle, and only what the eye has in view', () => {
    /**
     * The bearer's (2,1) was outside the exact disc; it is inside the rounded
     * one, and the eye (no light of its own) sees it by the bearer's lantern.
     * A wall between the eye and a tile the lantern reaches keeps that tile
     * dark: `applyExtraLite` shows only grids already in view (engine/Map.lua:663).
     */
    const bearerAt = { x: EYE.x + 4, y: EYE.y };
    const hidden = { x: bearerAt.x, y: bearerAt.y - 2 };
    // A short wall at the eye's (3,-1) and (3,-2) shades `hidden` from the eye
    // and leaves the bearer's own tile and its (2,1) in the open.
    const world = room('player-sight-other-light', false, [
      [EYE.x + 3, EYE.y - 1],
      [EYE.x + 3, EYE.y - 2],
      [EYE.x + 2, EYE.y - 2],
    ]);
    const bearer = world.addPlayer('bearer', 'Bearer');
    bearer.x = bearerAt.x;
    bearer.y = bearerAt.y;
    bearer.combat = { ...bearer.combat, mods: { ...bearer.combat?.mods, lite: 2 } };
    expect(liteRadiusOf(bearer)).toBe(2);

    const eye = eyeAt(EYE, 0);
    const knight = { x: bearerAt.x + 2, y: bearerAt.y + 1 };
    expect(euclidDistance(bearerAt, knight), 'fixture: outside the exact disc').toBeGreaterThan(2);
    expect(sees(world, eye, knight)).toBe(true);
    expect(sees(world, eye, bearerAt)).toBe(true);

    // In the lantern's circle, out of the eye's view: dark.
    expect(
      shadowcast(world.level, bearerAt, 2).some((t) => t.x === hidden.x && t.y === hidden.y),
      'fixture: the lantern does not reach the hidden tile',
    ).toBe(true);
    expect(
      shadowcast(world.level, eye, sightRadiusOf(eye)).some(
        (t) => t.x === hidden.x && t.y === hidden.y,
      ),
      'fixture: the eye has the hidden tile in view',
    ).toBe(false);
    expect(sees(world, eye, hidden)).toBe(false);
  });
});

describe('a player`s line counts the rounded sight radius (tome/class/Player.lua:709)', () => {
  it('crosses remembered ground at (10,2), which rounds to 10', () => {
    /**
     * Toward a tile they do not see, every tile on the way must be within
     * `core.fov.distance <= self.sight`, the ROUNDED distance. The line from
     * (0,0) to (11,2) passes (10,2), 10.2 long: it was refused, and ToME's
     * circle holds it. One further, the line to (12,2) passes (11,2), which is
     * 11 either way.
     */
    const world = room('player-sight-line', true);
    const from = { x: 2, y: 10 };
    const unseen = (): boolean => false;
    const remembered = (): boolean => true;
    const near = { x: from.x + 11, y: from.y + 2 };
    const far = { x: from.x + 12, y: from.y + 2 };

    const line = bresenham(from, near);
    expect(
      line.some((t) => t.x === from.x + 10 && t.y === from.y + 2),
      'fixture: the line does not pass (10,2)',
    ).toBe(true);
    expect(euclidDistance(from, { x: from.x + 10, y: from.y + 2 })).toBeGreaterThan(
      DEFAULT_SIGHT_RADIUS,
    );

    expect(playerLineClear(world.level, from, near, DEFAULT_SIGHT_RADIUS, unseen, remembered)).toBe(
      true,
    );
    expect(playerLineClear(world.level, from, far, DEFAULT_SIGHT_RADIUS, unseen, remembered)).toBe(
      false,
    );
  });
});

describe('the join: `visionOf` is the shadowcast, cell for cell, on generated floors', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE REAL ENTRY POINT AGAINST AN ORACLE BUILT FROM `circleCells`.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A party of four stands at every few open tiles of four generated delve
   * floors (dark caves, lit rooms), each carrying a brass lantern, one of them
   * with heightened senses. For every viewer, `visionOf(world, body)` must equal
   * the three passes composed here from `circleCells` with `blocksSightAt`
   * (the monster-sight oracle), `world.lit` and `alwaysRemembered`:
   *
   *   senses  occupied cells of its circle, then the whole rad2 circle, kept
   *           when lit or always remembered;
   *   sight   its circle is the field of view; the lit cells are seen and kept;
   *   own     the lantern's circle, seen, kept when lit or always remembered;
   *   others  each other light's circle from ITS tile, where in view.
   *
   * THE FIXTURE MUST DISCRIMINATE: the same composition over the old rule
   * (`oldTiles`) must differ on some viewers, so a pass left on the old
   * geometry cannot pass.
   */
  it('matches the oracle for every viewer, seen and kept', () => {
    const sites = [...DELVES.keys()].filter((id) => SITES.get(id) !== undefined).slice(0, 4);
    expect(sites.length, 'fixture: fewer than four delves').toBe(4);

    let viewers = 0;
    let parted = 0;
    let dark = 0;

    for (const id of sites) {
      const site = SITES.get(id);
      if (site === undefined) continue;
      const realms = createRealms({
        seed: `player-sight-join:${id}`,
        engineFor: (world) => createTurnEngine({ world }),
      });
      const world = realms.open(site, 'party').world;
      const level = world.level;
      const w = level.w;
      const open: TileXY[] = [];
      for (let y = 0; y < level.h; y += 1) {
        for (let x = 0; x < level.w; x += 1) {
          if (canWalk(level, x, y) && world.actorAt(x, y) === undefined) open.push({ x, y });
        }
      }
      const party = [0, 1, 2, 3].map((i) => {
        const p = world.addPlayer(`p${String(i)}`, `P${String(i)}`);
        const senses = i === 3 ? { senses: 5 } : {};
        p.combat = { ...p.combat, mods: { ...p.combat?.mods, lite: 2, ...senses } };
        return p;
      });
      expect(sensesRadiusOf(party[3] ?? {}), 'fixture: nobody senses').toBe(5);

      const litAt = (t: TileXY): boolean => world.lit[t.y * w + t.x] === 1;
      const keptAt = (t: TileXY): boolean =>
        litAt(t) || alwaysRemembered(level.tiles[t.y * w + t.x] ?? TileCode.WALL);

      /** The three passes (and senses), composed over a tile-lister. */
      const compose = (
        eye: (typeof party)[number],
        tiles: (at: TileXY, r: number) => TileXY[],
      ): { seen: Set<string>; kept: Set<string> } => {
        const seen = new Set<string>();
        const kept = new Set<string>();
        const see = (t: TileXY, keep: boolean): void => {
          seen.add(key(t));
          if (keep) kept.add(key(t));
        };
        const senses = sensesRadiusOf(eye);
        if (senses > 0) {
          for (const t of tiles(eye, senses)) {
            const alive = world.allActors().some((a) => a.alive && a.x === t.x && a.y === t.y);
            if (alive) see(t, keptAt(t));
          }
          for (const t of tiles(eye, Math.max(1, Math.floor(senses / 4)))) see(t, keptAt(t));
        }
        const inFov = new Set<string>();
        for (const t of tiles(eye, sightRadiusOf(eye))) {
          inFov.add(key(t));
          if (litAt(t)) see(t, true);
        }
        const lite = liteRadiusOf(eye);
        if (lite <= 0) see(eye, keptAt(eye));
        else for (const t of tiles(eye, lite)) see(t, keptAt(t));
        for (const other of world.allActors()) {
          if (other === eye || liteRadiusOf(other) <= 0) continue;
          for (const t of tiles(other, liteRadiusOf(other))) {
            if (inFov.has(key(t))) see(t, keptAt(t));
          }
        }
        return { seen, kept };
      };

      for (let k = 0; k < open.length; k += 23) {
        party.forEach((p, i) => {
          const at = open[(k + i * 2) % open.length] ?? { x: 0, y: 0 };
          p.x = at.x;
          p.y = at.y;
        });
        for (const p of party) {
          const vision = visionOf(world, p);
          const want = compose(p, (at, r) => shadowcast(level, at, r));
          const where = `${id} ${p.id} at (${String(p.x)},${String(p.y)})`;
          expect(seenKeys(world, vision.seen), `${where}: seen`).toEqual(want.seen);
          expect(seenKeys(world, vision.remember), `${where}: kept`).toEqual(want.kept);

          const old = compose(p, (at, r) => oldTiles(level, at, r));
          viewers += 1;
          if (!litAt(p)) dark += 1;
          const same =
            old.seen.size === want.seen.size && [...old.seen].every((t) => want.seen.has(t));
          if (!same) parted += 1;
        }
      }
    }

    expect(viewers, 'fixture: too few viewers').toBeGreaterThan(200);
    expect(dark, 'fixture: every viewer stood in the light').toBeGreaterThan(0);
    expect(dark, 'fixture: every viewer stood in the dark').toBeLessThan(viewers);
    expect(parted, 'fixture: the old and new rules never disagreed').toBeGreaterThan(0);
  });
});
