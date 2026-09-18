// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { isPlayer } from '../../src/server/engine/actor.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import type { IdentityPort, PersistPort } from '../../src/server/net/gateway.ts';
import {
  EXIT_SITE_ID,
  SITES,
  STAIRS_DOWN_SITE_ID,
  UNDERMOST_SITE_ID,
  createRealms,
  floorsOfSite,
  stairsDownOf,
} from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { delveHeadroom } from '../../src/server/content/delve.ts';
import { KNOT_OF_ELSEWHERE_ID, itemById } from '../../src/server/content/items.ts';
import { UNDERMOST_GARRISON, UNDERMOST_LAST_FLOOR } from '../../src/server/content/undermost.ts';
import { ActorKind, ActorRank, LogLane, TileCode } from '../../src/shared/protocol.ts';
import { SiteShape, makeSiteMap } from '../../src/shared/sitemap.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE A NEW CHARACTER WAKES, AND THE ONLY WAY OUT OF IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's Escape from Reknor: three levels (data/zones/reknor-escape/
 * zone.lua:24), a first level whose up stair is floor (:67-69), and a last
 * level drawn by hand with the way out at its far end (:72-79). Here the
 * premise is waking deep in a cave and climbing to the surface.
 */
const FRAME_TIMEOUT_MS = 4_000;
/** A cave-shaped delve of several floors that is not the Undermost. */
const UNDERWORKS = 'site:underworks';

function makeRealms(seed = 'undermost'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

function undermost(): NonNullable<ReturnType<typeof SITES.get>> {
  const def = SITES.get(UNDERMOST_SITE_ID);
  if (def === undefined) throw new Error('no Undermost');
  return def;
}

function exitOf(realm: Realm): TileXY | null {
  for (const [cell, id] of realm.sites) {
    if (id !== EXIT_SITE_ID) continue;
    const [x, y] = cell.split(',').map(Number);
    if (x === undefined || y === undefined) return null;
    return { x, y };
  }
  return null;
}

describe('the Undermost, as a zone', () => {
  it('is three floors, like upstream`s escape, and a real place on the moor', () => {
    expect(floorsOfSite(UNDERMOST_SITE_ID)).toBe(3);
    const realms = makeRealms();
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS CASE WAS CALLED "AND ON NO MAP", AND ASSERTED THE FALSE HALF.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * *"tutorial should drop you in the world, but the tutorial zone should
     * still be an actual place in the overworld"* — the author. The Undermost
     * was built outside `AUTHORED_SITES` under a comment reading "ON NO MAP.
     * Nothing leads here", so the one room every character in the game has
     * stood in was the only room that stopped existing once you left it.
     *
     * The mouth is glyph `J` at (109,62) — see `ALDERBROOK_LEGEND` for why it
     * is six tiles off Alderbrook's gate rather than as far from everything as
     * the map allows, which is where the three hidden sites went.
     */
    const cells = [...realms.overworld.sites.entries()]
      .filter(([, id]) => id === UNDERMOST_SITE_ID)
      .map(([cell]) => cell);
    expect(cells, 'the Undermost is on no map').toEqual(['109,62']);

    // AND EXACTLY ONE OF THEM. A second door would be a second instance of the
    // place every character is born in.
    expect(SITES.get(UNDERMOST_SITE_ID)?.hidden ?? false, 'you have been inside it').toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT IS STILL A ONE-WAY CLIMB, WHICH IS THE OTHER HALF OF THE RULING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream replaces the first level's up stair with floor
   * (data/zones/reknor-escape/zone.lua:67-69). Making the cave a place you can
   * walk back to is not the same as making its first floor a door you can walk
   * back OUT of: a character four minutes old could otherwise step off the tile
   * it woke on and be standing in the city with no levels and no gear, which is
   * a skip button on the intro. `SiteDef.noWayBack` is what refuses it and the
   * gateway's `hasNoWayBack` reads it.
   */
  it('has no way back out of its first floor, however you got in', () => {
    expect(undermost().noWayBack, 'the intro grew a skip button').toBe(true);
    expect(undermost().birthplace, 'a new character is still put here').toBe(true);
  });

  it('climbs by stairs on the first two floors and leaves by the exit on the last', () => {
    const realms = makeRealms();
    for (let floor = 1; floor <= 3; floor += 1) {
      const realm = realms.open(undermost(), 'party-u', undefined, undefined, undefined, floor);
      const stairs = [...realm.sites.values()].filter((id) => id === STAIRS_DOWN_SITE_ID);
      const exits = [...realm.sites.values()].filter((id) => id === EXIT_SITE_ID);
      expect(stairs.length, `stairs on floor ${String(floor)}`).toBe(floor < 3 ? 1 : 0);
      expect(exits.length, `exits on floor ${String(floor)}`).toBe(floor < 3 ? 0 : 1);
      const monsters = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
      if (floor < 3) {
        expect(monsters, `nobody rolled on floor ${String(floor)}`).toBeGreaterThan(0);
        continue;
      }
      // UPSTREAM'S LAST LEVEL ROLLS NOBODY (zone.lua:79): its fight is PLACED,
      // which is a different claim and is checked by name rather than by count.
      const ids = realm.world
        .allActors()
        .filter((a) => a.kind === ActorKind.Monster)
        .map((a) => a.id);
      expect(
        ids.filter((id) => /delve_(\d+|boss)$/.test(id)),
        'the last floor rolled a population',
      ).toEqual([]);
      expect(monsters, 'the last floor is empty').toBeGreaterThan(0);
      const exit = exitOf(realm);
      if (exit === null) throw new Error('no exit on the last floor');
      expect(canWalk(realm.world.level, exit.x, exit.y), 'the exit is not ground').toBe(true);
      expect(realm.spawns.length, 'the last floor has no arrival').toBeGreaterThan(0);
    }
  });

  /**
   * ═══ THE FIRST TWO FLOORS ARE CAVES: DUG AS TOME DIGS ONE, AND DARK ═══
   * A cave is ToME's Cavern (`shared/mapgen/cavern.ts`): one region of noise,
   * no rooms, nothing lit. Nothing else here said so — the counts above hold
   * just as well for a ruin, and a lit floor passes every one of them.
   */
  it('digs the first two floors as caves in soot and crag, and lights none of it', () => {
    for (const floor of [1, 2]) {
      const seed = `undermost-cave:${String(floor)}`;
      expect(undermost().map(seed, undefined, floor), `floor ${String(floor)}`).toEqual({
        ...makeSiteMap(seed, SiteShape.Cave, { floor: TileCode.SOOT, wall: TileCode.CRAG }),
        // AND THE ONE THING THE FLOOR ADDS TO THE DIG — upstream's `on_enter`
        // (data/zones/reknor-escape/zone.lua:83-95). Floor 1 says nothing;
        // floor 2 levels whoever climbs onto it. See `AuthoredMap.forceLevel`.
        ...(floor >= 2 ? { forceLevel: floor } : {}),
      });
      const realm = makeRealms().open(undermost(), 'p', undefined, undefined, undefined, floor);
      const { tiles } = realm.world.level;
      expect(new Set(tiles), `floor ${String(floor)}`).toEqual(
        new Set([TileCode.SOOT, TileCode.CRAG]),
      );
      expect(tiles.filter((c) => c === TileCode.SOOT).length).toBeGreaterThanOrEqual(900);
      expect(
        realm.world.lit.some((v) => v > 0),
        `floor ${String(floor)} is lit`,
      ).toBe(false);
    }
  });

  it('draws the last floor by hand, the same floor every time', () => {
    const a = makeRealms('undermost-a').open(undermost(), 'p', undefined, undefined, undefined, 3);
    const b = makeRealms('undermost-b').open(undermost(), 'p', undefined, undefined, undefined, 3);
    expect(a.world.level.tiles).toEqual(b.world.level.tiles);
    const first = makeRealms('undermost-a').open(
      undermost(),
      'p',
      undefined,
      undefined,
      undefined,
      1,
    );
    const other = makeRealms('undermost-b').open(
      undermost(),
      'p',
      undefined,
      undefined,
      undefined,
      1,
    );
    expect(first.world.level.tiles, 'the generated floors are not generated').not.toEqual(
      other.world.level.tiles,
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIGHT AT THE WAY OUT — item 6, "the tutorial dungeon has no boss".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's escape ends in a hand-drawn hall held by Brotoq the Reaver
 * (data/zones/reknor-escape/npcs.lua:30-78), named on his tile by the map
 * itself — `defineTile("O", "FLOOR", nil, "BROTOQ")`,
 * data/maps/zones/reknor-escape-last.lua:35. Ours is `UNDERMOST_GARRISON` on
 * the `W` and `p` glyphs of `UNDERMOST_LAST_FLOOR`.
 *
 * MEASURED BEFORE ANY OF IT: the Undermost's last floor held 0.0 bodies, took
 * 0 turns and was cleared 3/3 by all four classes. The whole intro was four
 * monsters and an empty hall.
 */
describe('the way out of the Undermost is held', () => {
  const LAST = floorsOfSite(UNDERMOST_SITE_ID);

  function hallOf(seed: string, size = 1): Realm {
    return makeRealms(seed).open(
      undermost(),
      `party-${seed}`,
      { level: 1, size },
      undefined,
      undefined,
      LAST,
    );
  }

  const bodiesIn = (realm: Realm): readonly ReturnType<Realm['world']['addPlayer']>[] =>
    realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);

  /** Walking distance from `from` to every tile you can reach on foot. */
  function walkDistances(realm: Realm, from: TileXY): ReadonlyMap<string, number> {
    const seen = new Map<string, number>([[`${String(from.x)},${String(from.y)}`, 0]]);
    let edge: TileXY[] = [from];
    for (let d = 1; edge.length > 0; d += 1) {
      const next: TileXY[] = [];
      for (const at of edge) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = at.x + dx;
            const y = at.y + dy;
            const key = `${String(x)},${String(y)}`;
            if (seen.has(key) || !canWalk(realm.world.level, x, y)) continue;
            seen.set(key, d);
            next.push({ x, y });
          }
        }
      }
      edge = next;
    }
    return seen;
  }

  it('stands the warden and his pickets on the glyphs the floor draws', () => {
    /**
     * EVERY GENERATION, not one seed. The last floor is drawn by hand so the
     * fight can be PLACED rather than rolled, and "placed" has to mean the same
     * tiles every time or it is a roll with extra steps.
     */
    const drawn = new Map<string, number>();
    for (const row of UNDERMOST_LAST_FLOOR) {
      for (const glyph of row) {
        const template = UNDERMOST_GARRISON.get(glyph);
        if (template !== undefined) drawn.set(template.id, (drawn.get(template.id) ?? 0) + 1);
      }
    }
    expect(drawn.get('undermost_warden'), 'the floor draws no warden').toBe(1);
    expect(drawn.get('undermost_picket') ?? 0, 'the warden stands alone').toBeGreaterThan(1);

    for (let n = 0; n < 6; n += 1) {
      const realm = hallOf(`held-${String(n)}`);
      const bodies = bodiesIn(realm);
      const wardens = bodies.filter((a) => a.id.includes('undermost_warden'));
      const pickets = bodies.filter((a) => a.id.includes('undermost_picket'));
      expect(wardens, `seed ${String(n)}: nobody holds the last door`).toHaveLength(1);
      expect(pickets, `seed ${String(n)}`).toHaveLength(drawn.get('undermost_picket') ?? 0);
      // ON THEIR OWN GLYPHS. The legend in `realms.ts` and the garrison table in
      // `content/undermost.ts` are the two halves of upstream's one `defineTile`
      // call, and this is the only place that reads them together.
      for (const body of [...wardens, ...pickets]) {
        const glyph = UNDERMOST_LAST_FLOOR[body.y]?.charAt(body.x) ?? '';
        expect(UNDERMOST_GARRISON.get(glyph)?.id, `${body.id} stands on '${glyph}'`).toBe(
          body.id.includes('warden') ? 'undermost_warden' : 'undermost_picket',
        );
      }
      // AND NOTHING ELSE IS ON THE FLOOR. `nb_npc = {0, 0}` — zone.lua:79.
      expect(bodies).toHaveLength(wardens.length + pickets.length);
    }
  });

  it('puts the warden last on the road to the door, and every picket before it', () => {
    /**
     * "THE EXIT IS GUARDED BY A BOSS AND A SMALL HORDE" is a claim about the
     * ORDER things are met in, and a headcount cannot state it: four bodies in a
     * side pocket the party never enters would pass the case above.
     *
     * Walked as real ground rather than as a straight line, because the hall has
     * pillars in it and a Chebyshev distance through rock is a distance nobody
     * travels.
     */
    for (let n = 0; n < 4; n += 1) {
      const realm = hallOf(`road-${String(n)}`);
      const from = realm.spawns[0];
      const exit = exitOf(realm);
      if (from === undefined || exit === null) throw new Error('no arrival or no exit');
      const far = walkDistances(realm, from);
      const toExit = far.get(`${String(exit.x)},${String(exit.y)}`);
      expect(toExit, 'the way out is not walkable from the arrival').toBeDefined();
      if (toExit === undefined) continue;

      const steps = (a: { x: number; y: number }): number =>
        far.get(`${String(a.x)},${String(a.y)}`) ?? -1;
      const bodies = bodiesIn(realm);
      const warden = bodies.find((a) => a.id.includes('undermost_warden'));
      if (warden === undefined) throw new Error('no warden');
      for (const body of bodies) {
        expect(steps(body), `${body.id} stands off the road`).toBeGreaterThan(0);
        expect(steps(body), `${body.id} stands past the door`).toBeLessThan(toExit);
      }
      /**
       * AND THE WARDEN IS THE LAST THING BETWEEN YOU AND DAYLIGHT.
       *
       * `<=` AND NOT `<`, MEASURED: one picket stands on the warden's own row
       * and is therefore the same number of steps in. That is the upstream
       * arrangement — `....oOo....`, reknor-escape-last.lua, a guard at his
       * shoulder — and "no picket is met AFTER the warden" is the claim that is
       * true. The strict version is asserted on the one that is posted forward,
       * which is the arrangement's whole point.
       */
      for (const picket of bodies.filter((a) => a.id !== warden.id)) {
        expect(steps(picket), `${picket.id} is met after the warden`).toBeLessThanOrEqual(
          steps(warden),
        );
      }
      expect(
        bodies.filter((a) => a.id !== warden.id).some((a) => steps(a) < steps(warden)),
        'nothing stands between the corridor and the warden',
      ).toBe(true);
    }
  });

  it('grows the horde with the party, by the rule every other room uses', () => {
    /**
     * `delveHeadroom` — x1.0 / x1.5 / x2.0 / x2.5, sub-linear, SIZE and never
     * level. A drawn room cannot ask it by drawing more glyphs, so the glyphs
     * are the lone party's garrison and the rest stand in the ring around them.
     *
     * MEASURED BEFORE IT EXISTED: a party of three met the same four bodies a
     * lone character does, cleared the hall in 27 to 41 turns, and not one of
     * them lost a hit point. Every delve in the game scales and the one room
     * every character has to walk did not.
     */
    const drawnPickets = UNDERMOST_LAST_FLOOR.join('')
      .split('')
      .filter((glyph) => glyph === 'p').length;
    for (const size of [1, 2, 3, 5]) {
      const realm = hallOf(`horde-${String(size)}`, size);
      const bodies = bodiesIn(realm);
      const pickets = bodies.filter((a) => a.id.includes('undermost_picket'));
      expect(pickets, `a party of ${String(size)}`).toHaveLength(
        Math.round(drawnPickets * delveHeadroom({ level: 1, size })),
      );
      // AND NEVER A SECOND WARDEN. Two would be a different place.
      expect(
        bodies.filter((a) => a.id.includes('undermost_warden')),
        `a party of ${String(size)} met two wardens`,
      ).toHaveLength(1);
    }
  });

  it('hands the warden a prize, and levels it the way the zone levels everything', () => {
    /**
     * `resolvers.drops{chance=100, nb=1, ...}` — npcs.lua:57. And the level is
     * `actorAdjustLevel`'s four terms, which for a rank-4 body on floor 3 of a
     * level-1 zone is `1 + 3 + 2 + rng(-1,2)` — five to eight, which is upstream's
     * arithmetic for Brotoq to the number. NOT `level_range = {7, nil}`
     * (npcs.lua:38): that is the filter the RANDOM generator uses to decide what
     * may be rolled at a depth, and it has nothing to say about a body that is
     * drawn.
     */
    for (let n = 0; n < 6; n += 1) {
      const realm = hallOf(`prize-${String(n)}`);
      const bodies = bodiesIn(realm);
      const warden = bodies.find((a) => a.id.includes('undermost_warden'));
      if (warden === undefined) throw new Error('no warden');
      expect(warden.rank, 'the warden is not a boss').toBe(ActorRank.Boss);
      expect((warden.carried ?? []).length, 'the warden holds nothing').toBeGreaterThan(1);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE FIRST THING IT HOLDS IS THE WAY OUT.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `NPC:onDie` gives the Rod of Recall to the first rank-4 body a character
       * kills (tome/class/NPC.lua:393-406), by NAME — `makeEntityByName(...,
       * "ROD_OF_RECALL")` at :394. The warden is that body here, and the key is
       * on it as its RAW id: `embellish` forks the loot stream to roll material
       * grades, egos and money, and a unique that came back as `~ba2` of itself
       * would be a different object with the same name.
       *
       * AND AN ORDINARY RARE BESIDE IT, second — `resolvers.drops` on Brotoq is
       * two lines (npcs.lua:57-58), and a boss that paid only the quest item
       * would pay less than a husk in the next room.
       */
      expect(warden.carried?.[0], 'the warden is not holding the key').toBe(KNOT_OF_ELSEWHERE_ID);
      expect(
        itemById(KNOT_OF_ELSEWHERE_ID)?.quest,
        'the key is ordinary loot, so a husk can drop one too',
      ).toBe(true);
      expect(warden.level, `seed ${String(n)}`).toBeGreaterThanOrEqual(5);
      expect(warden.level, `seed ${String(n)}`).toBeLessThanOrEqual(8);
      /**
       * AND IT OUTRANKS ITS OWN GUARD, which is `rankLevelAdjust` doing its job:
       * +3 for a rank-4 body, 0 for a rank-2 one. The two bands are `6 + j` and
       * `3 + j` over the same `j` in [-1, 2], so they TOUCH at five and can
       * never cross — a picket above its warden would mean the rank term had
       * stopped being paid. `<=` is the claim the arithmetic supports; the band
       * below is what makes it a real assertion rather than a tautology.
       */
      for (const picket of bodies.filter((a) => a.id !== warden.id)) {
        expect(picket.level, `${picket.id} outranks the warden`).toBeLessThanOrEqual(warden.level);
        expect(picket.level, `${picket.id} is off its own band`).toBeGreaterThanOrEqual(2);
        expect(picket.level, `${picket.id} is off its own band`).toBeLessThanOrEqual(5);
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE CLIMB LEVELS YOU — data/zones/reknor-escape/zone.lua:83-95.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * on_enter = function(lev, old_lev, new_zone)
 *     if lev == 2 then game.player:forceLevelup(2) ... end
 *     if lev == 3 then game.player:forceLevelup(3) ... end
 * end,
 * ```
 *
 * It is the escape's own staging and the reason ToME can put fifty bodies in
 * front of a four-minute-old character: the zone does not get harder as you
 * climb, YOU DO, one level per floor, on arrival, before the first turn.
 *
 * DRIVEN THROUGH `TurnEngine.join`, which is what every way of arriving in a
 * realm ends with — the hello path, a stair down, a stair back up — and which
 * runs AFTER `carryAcross` has put the character's own level back on the body.
 * The rule itself is pinned in `test/shared/progression.test.ts`; this is the
 * join, and the join is the half that goes wrong.
 */
describe('the climb levels whoever makes it', () => {
  function arrive(
    floor: number,
    level: number,
    xp = 0,
    joins = 1,
  ): { level: number; xp: number; pendingLevels: number; hp: number; maxHp: number } {
    const realm = makeRealms(`levels-${String(floor)}-${String(level)}`).open(
      undermost(),
      'party-l',
      { level: 1, size: 1 },
      undefined,
      undefined,
      floor,
    );
    const body = realm.world.addPlayer('p0', 'P');
    // `addPlayer` returns the union; the progression fields are the player
    // half's, and a monster can never be handed to `forceLevelup`.
    if (!isPlayer(body)) throw new Error('addPlayer did not make a player');
    body.level = level;
    body.xp = xp;
    body.pendingLevels = 0;
    body.maxHp = 50;
    body.hp = 3;
    for (let n = 0; n < joins; n += 1) realm.engine.join(body.id);
    return {
      level: body.level,
      xp: body.xp,
      pendingLevels: body.pendingLevels,
      hp: body.hp,
      maxHp: body.maxHp,
    };
  }

  it('brings a level-1 body up to the number of the floor it walked onto', () => {
    expect(arrive(2, 1).level, 'floor 2 levelled nobody').toBe(2);
    expect(arrive(3, 1).level, 'floor 3 levelled nobody').toBe(3);
    // AND THE FIRST FLOOR SAYS NOTHING, because upstream's `on_enter` says
    // nothing about level 1: a character wakes there as it was born.
    expect(arrive(1, 1).level, 'the floor a character wakes on levelled it').toBe(1);
  });

  it('banks what the level owes and heals to the new ceiling', () => {
    /**
     * TWO HALVES, AND BOTH HAVE BEEN MISSED IN THIS CODEBASE BEFORE.
     * `pendingLevels` is what `applyPendingLevels` pays the talent point, the
     * generic, the three attribute points and — at ten — the discipline out of,
     * so writing `level` alone produces a character three levels up and nine
     * points short. And `Actor:levelup()` ends with `self:resetToFull()`
     * (tome/class/Actor.lua:3832), which is what makes the staging worth
     * anything: arriving at the next floor on the hit points you limped off the
     * last one with is not a gift.
     */
    const after = arrive(3, 1);
    expect(after.pendingLevels, 'the levels were given and not banked').toBe(2);
    expect(after.hp, 'arrived on the hit points it limped in with').toBe(after.maxHp);
    // AND THE PROGRESS INTO THE LEVEL IS SPENT — `self.exp = 0`, INSIDE the
    // loop, ActorLevel.lua:143.
    expect(arrive(3, 1, 11).xp).toBe(0);
  });

  it('heals to the ceiling the NEW level bought, not the one it walked in with', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ORDER, WHICH NOTHING COULD SEE — `onSheetDirty` BEFORE THE HEAL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `levelUpOnArrival` calls `opts.onSheetDirty?.(actor.id)` and THEN sets
     * `hp = maxHp`, and its docblock says why: *"the ceiling is recomposed from
     * the new level and healing to the old one is healing to the wrong number"*.
     *
     * SURVIVED THE MUTATION AUDIT: deleting that call entirely. The case above
     * hand-sets `maxHp = 50` in a realm whose engine passes NO `onSheetDirty`,
     * so `hp === maxHp` holds whatever the order is and whether or not the sheet
     * was ever rebuilt. In production the call is load-bearing — `main.ts` hangs
     * `refreshPassives` on it and that is where `actor.maxHp = maxLifeOf(...)`
     * happens — so the rule was true, untested, and one line from being deleted.
     *
     * SO THE SEAM IS WIRED, with the smallest thing that behaves like
     * `refreshPassives`: a ceiling that is a function of the LEVEL. If the heal
     * ran first, or the seam were never called, the body arrives on the old
     * ceiling — which is the number this asserts against.
     */
    const downed = createDownedState();
    const grown: string[] = [];
    const realms = createRealms({
      seed: 'heal-order',
      engineFor: (world) =>
        createTurnEngine({
          world,
          downed,
          // `refreshPassives`' one observable effect, in one line: how much of
          // this body there is, derived from the level it is standing at.
          onSheetDirty: (actorId: string): void => {
            const body = world.getActor(actorId);
            if (body === undefined) return;
            grown.push(actorId);
            body.maxHp = 40 + 10 * body.level;
          },
        }),
    });
    const realm = realms.open(
      undermost(),
      'heal-order',
      { level: 1, size: 1 },
      undefined,
      undefined,
      3,
    );
    const body = realm.world.addPlayer('p0', 'P');
    if (!isPlayer(body)) throw new Error('addPlayer did not make a player');
    body.level = 1;
    body.xp = 0;
    body.pendingLevels = 0;
    body.maxHp = 50;
    body.hp = 3;
    realm.engine.join(body.id);

    expect(grown, 'the sheet was never rebuilt for the forced level').toContain(body.id);
    expect(body.level).toBe(3);
    // 40 + 10 * 3. The level-1 ceiling was 50, so a heal that ran first — or a
    // seam that never fired — leaves the body on 50 and this line catches both.
    expect(body.maxHp, 'the ceiling did not follow the level').toBe(70);
    expect(body.hp, 'healed to the ceiling it walked in with').toBe(body.maxHp);
  });

  it('is a floor and never a set: it levels nobody down, and nobody twice', () => {
    /**
     * IDEMPOTENCE IS LOAD-BEARING HERE RATHER THAN TIDY. `join` runs on every
     * arrival AND on every reconnection after a dropped socket, so a rule that
     * fired twice would pay the points twice, and one that SET the level would
     * take six levels off a level-9 character walking back into the cave.
     */
    const high = arrive(3, 9, 11, 2);
    expect(high.level, 'a level-9 body was levelled down').toBe(9);
    expect(high.pendingLevels, 'a body already over the floor was paid anyway').toBe(0);
    expect(high.xp, 'a no-op emptied the experience bar').toBe(11);
    expect(high.hp, 'a no-op healed somebody').toBe(3);

    // AND A SECOND JOIN PAYS NOTHING. Two levels owed, two banked, not four.
    expect(arrive(3, 1, 0, 2).pendingLevels, 'a reconnect paid the levels twice').toBe(2);
  });
});

describe('the Undermost, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'undermost-wire',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    harness = {
      port: address.port,
      realms,
      close: async (): Promise<void> => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await harness.close();
  });

  type Client = {
    readonly actorId: string;
    readonly frames: readonly Record<string, unknown>[];
    move(dir: string): Promise<void>;
  };

  async function join(): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}/ws`);
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) {
        frames.push({ ...(parsed as Record<string, unknown>) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello' }));
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof id === 'string') {
        return {
          actorId: id,
          frames,
          async move(dir: string): Promise<void> {
            socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir }));
            await sleep(250);
          },
        };
      }
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }
  }

  const STEPS = [
    { dir: 'e', dx: 1, dy: 0, back: 'w' },
    { dir: 'w', dx: -1, dy: 0, back: 'e' },
    { dir: 's', dx: 0, dy: 1, back: 'n' },
    { dir: 'n', dx: 0, dy: -1, back: 's' },
  ] as const;

  function realmOf(client: Client): Realm {
    const realm = harness.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('the body is in no realm');
    return realm;
  }

  function clear(realm: Realm): void {
    for (const actor of realm.world.allActors()) {
      if (actor.kind === ActorKind.Monster) realm.world.removeActor(actor.id);
    }
  }

  async function stepOnto(client: Client, cell: TileXY): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    for (const step of STEPS) {
      const x = cell.x - step.dx;
      const y = cell.y - step.dy;
      // THE VIEWER'S OWN BODY DOES NOT BLOCK THE TILE IT IS STANDING ON.
      // `stepWithinSightOf` parks it beside the cell we are about to step onto,
      // which used to make that cell unreachable: the only open ground beside a
      // hand-drawn exit is often one tile, and we were already on it.
      const occupant = realm.world.actorAt(x, y);
      if (!canWalk(realm.world.level, x, y)) continue;
      if (occupant !== undefined && occupant.id !== client.actorId) continue;
      body.x = x;
      body.y = y;
      await client.move(step.dir);
      return;
    }
    throw new Error('no open ground beside the cell');
  }

  /**
   * STAND WHERE YOU CAN SEE IT — and never ON it, because this cell is a door.
   *
   * `markersFor` draws a way on or out only on a tile the character knows
   * (`knownTile`, seen or remembered — `engine/Grid.lua:30-32`), so a marker
   * assertion has to put the body within sight of the cell first. Reading the
   * arrival frame used to work because every stair was drawn to everybody, which
   * is the bug the rule closed.
   */
  async function stepWithinSightOf(client: Client, cell: TileXY): Promise<void> {
    const realm = realmOf(client);
    const beside = STEPS.map((s) => ({ x: cell.x + s.dx, y: cell.y + s.dy })).find(
      (t) => canWalk(realm.world.level, t.x, t.y) && realm.world.actorAt(t.x, t.y) === undefined,
    );
    if (beside === undefined) throw new Error('no open ground beside the cell');
    await stepOnto(client, beside);
  }

  async function offAndBackOntoThreshold(client: Client): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const onThreshold = (x: number, y: number): boolean =>
      realm.spawns.some((t) => t.x === x && t.y === y);
    for (const tile of realm.spawns) {
      for (const step of STEPS) {
        const x = tile.x + step.dx;
        const y = tile.y + step.dy;
        if (onThreshold(x, y) || !canWalk(realm.world.level, x, y)) continue;
        if (realm.world.actorAt(x, y) !== undefined) continue;
        body.x = tile.x;
        body.y = tile.y;
        await client.move(step.dir);
        await client.move(step.back);
        return;
      }
    }
    throw new Error('no threshold tile has open ground beside it');
  }

  it('has no way back from the first floor, and leaves by the exit on the last', async () => {
    const client = await join();
    const overworld = harness.realms.overworld;
    const body = overworld.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body on the overworld');

    // A DOOR BESIDE THE BODY, so this case is about the CLIMB rather than about
    // where the mouth is drawn. The real one on the moor is walked in the case
    // below, which is the one that would notice it moving.
    const door = STEPS.map((s) => ({ x: body.x + s.dx, y: body.y + s.dy })).find(
      (c) =>
        canWalk(overworld.world.level, c.x, c.y) && overworld.world.actorAt(c.x, c.y) === undefined,
    );
    if (door === undefined) throw new Error('no open ground beside the body');
    (overworld.sites as Map<string, string>).set(
      `${String(door.x)},${String(door.y)}`,
      UNDERMOST_SITE_ID,
    );
    await stepOnto(client, door);

    const first = realmOf(client);
    expect(first.siteId, 'never went in').toBe(UNDERMOST_SITE_ID);
    expect(first.floor).toBe(1);

    // ═══ NO WAY BACK, AND NONE DRAWN ═══ The threshold carries no way-out marker,
    // because the marker asks what leaving asks.
    const firstMap = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const drawnOut = (firstMap?.['sites'] as Record<string, unknown>[] | undefined)?.filter(
      (m) => m['marker'] === 'gate' && first.spawns.some((s) => s.x === m['x'] && s.y === m['y']),
    );
    expect(drawnOut, 'a way out is drawn on a threshold that leads nowhere').toEqual([]);
    clear(first);
    await offAndBackOntoThreshold(client);
    expect(realmOf(client).id, 'the first floor`s threshold led out').toBe(first.id);

    // ═══ UP THROUGH THE FLOORS ═══
    for (const floor of [1, 2]) {
      const here = realmOf(client);
      expect(here.floor).toBe(floor);
      clear(here);
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair`);
      await stepOnto(client, stairs);
    }
    const last = realmOf(client);
    expect(last.floor, 'never reached the last floor').toBe(3);
    clear(last);

    // ═══ THE WAY OUT IS ON THE MAP, AND IT IS THE WAY OUT ═══
    const exit = exitOf(last);
    if (exit === null) throw new Error('no exit on the last floor');
    // WITHIN SIGHT OF IT FIRST — see `stepWithinSightOf`.
    await stepWithinSightOf(client, exit);
    const map = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const marker = (map?.['sites'] as Record<string, unknown>[] | undefined)?.find(
      (m) => m['x'] === exit.x && m['y'] === exit.y,
    );
    // AND IT IS THE CAVE'S OWN STAIR, not the generic one: the landmark is a
    // preference the client falls back from, so `marker` stays beside it.
    expect(marker, 'the way out is not on the map').toMatchObject({
      marker: 'stair',
      name: 'The way out',
      landmark: 'prop_cave_way_up',
    });
    // AND ON THE EXIT ALONE. This floor's arrival thresholds are also named "The
    // way out" (`markersFor`'s `exits`, a `gate`), but on any floor after the
    // first `leaveRealm` takes them to the previous floor, not to daylight. The
    // case above finds the exit's marker and stops, so the cave stair painted on
    // a threshold as well would pass it. Where it is drawn, not merely that it is.
    const sites = (map?.['sites'] as Record<string, unknown>[] | undefined) ?? [];
    expect(
      sites.some(
        (m) => m['marker'] === 'gate' && last.spawns.some((s) => s.x === m['x'] && s.y === m['y']),
      ),
      'the last floor draws no threshold, so the check below has nothing to refuse',
    ).toBe(true);
    expect(
      sites
        .filter((m) => m['landmark'] === 'prop_cave_way_up')
        .map((m) => ({ x: m['x'], y: m['y'] })),
      'the cave stair is drawn somewhere other than the way out',
    ).toEqual([{ x: exit.x, y: exit.y }]);
    await stepOnto(client, exit);
    expect(realmOf(client).id, 'the exit did not lead out').toBe(overworld.id);
    const home = overworld.world.getActor(client.actorId);
    expect({ x: home?.x, y: home?.y }, 'did not come out where they went in').toEqual(door);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND YOU CAN WALK BACK IN — item 7, through the door the moor actually has.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * *"tutorial should drop you in the world, but the tutorial zone should still
   * be an actual place in the overworld"* — the author. The case above builds
   * its own door beside the body because for months there was none to use; this
   * one walks onto the cell the map draws, which is the whole of the feature.
   *
   * IT ALSO PINS THE ROUND TRIP, and that is the half nobody would notice
   * breaking: `leaveRealm` puts a body back on `session.enteredFrom`, which is
   * recorded only when you leave an OVERWORLD and is preserved all the way down.
   * So a party that walks in at the mouth and climbs out past the warden comes
   * up at the mouth — the same cell, three floors later. A character that WOKE
   * down there has no such record and lands on the world's own spawn, which is
   * Alderbrook's gate six tiles away, and that is why the mouth is drawn where
   * it is.
   */
  it('is a door on the moor you can walk back into, and come back out of', async () => {
    const client = await join();
    const overworld = harness.realms.overworld;
    const body = overworld.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body on the overworld');

    const found = [...overworld.sites].find(([, id]) => id === UNDERMOST_SITE_ID);
    if (found === undefined) throw new Error('the moor has no door to the Undermost');
    const [mx, my] = found[0].split(',').map(Number);
    if (mx === undefined || my === undefined) throw new Error('a bad door cell');
    const mouth = { x: mx, y: my };

    // WALKED ONTO FROM BESIDE IT. The gate is six tiles away and `stepOnto`
    // takes one step, so the body is carried to the doorstep first — the same
    // thing `hidden-sites.test.ts` does to reach the Weir.
    body.x = mouth.x - 1;
    body.y = mouth.y;
    await stepOnto(client, mouth);

    const first = realmOf(client);
    expect(first.siteId, 'the door on the moor opens nothing').toBe(UNDERMOST_SITE_ID);
    expect(first.floor, 'walking in did not start at the bottom').toBe(1);

    // AND IT IS STILL A ONE-WAY CLIMB, however you got in. `noWayBack`.
    clear(first);
    await offAndBackOntoThreshold(client);
    expect(realmOf(client).id, 'the first floor`s threshold led out').toBe(first.id);

    for (const floor of [1, 2]) {
      const here = realmOf(client);
      expect(here.floor).toBe(floor);
      clear(here);
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair`);
      await stepOnto(client, stairs);
    }
    const last = realmOf(client);
    expect(last.floor, 'never reached the last floor').toBe(3);

    // THE HALL IS HELD — and the way out is past it. Cleared here so the walk to
    // the exit is a walk rather than a fight; `undermost.test.ts`'s own garrison
    // cases are what pin who was standing in it.
    expect(
      last.world.allActors().filter((a) => a.id.includes('undermost_warden')),
      'nobody held the last door',
    ).toHaveLength(1);
    clear(last);

    const exit = exitOf(last);
    if (exit === null) throw new Error('no exit on the last floor');
    await stepWithinSightOf(client, exit);
    await stepOnto(client, exit);
    expect(realmOf(client).id, 'the exit did not lead out').toBe(overworld.id);
    const home = overworld.world.getActor(client.actorId);
    expect({ x: home?.x, y: home?.y }, 'did not come out at the mouth').toEqual(mouth);
  });

  /**
   * THE CAVE STAIR IS THE UNDERMOST'S, NOT EVERY ZONE'S.
   *
   * `exit:out` has exactly one map use today (the Undermost's last floor), so the
   * case above cannot tell "the Undermost's way out wears the cave stair" from
   * "every way out does": delete the site guard in `markersFor` and it still
   * passes. This is the other half: a way out on a floor of some OTHER zone
   * keeps the stair family marker and carries no landmark.
   *
   * THE UNDERWORKS, BECAUSE IT IS A CAVE TOO — `SiteShape.Cave` in soot and crag,
   * what the Undermost's generated floors are made of (world/realms.ts). And ON
   * ITS LAST FLOOR, where upstream puts an exit and where the Undermost's is. So
   * a guard reading "a cave", "the last floor" or "an inner realm" instead of
   * "the Undermost" fails here as well as a guard deleted outright.
   *
   * THE FLOOR IS PREPARED BEFORE THE PARTY ARRIVES, through the same idempotent
   * `open` the stair calls, keyed on the party the gateway itself minted at the
   * door. So the exit is on the map in the `realm` frame the last stair sends,
   * and nothing here reaches past the wire to read a marker.
   */
  it('draws any other zone`s way out as the plain stair, with no cave landmark', async () => {
    const client = await join();
    const overworld = harness.realms.overworld;
    const door = [...overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });

    const first = realmOf(client);
    expect(first.siteId, 'never went in').toBe(UNDERWORKS);
    const floors = floorsOfSite(UNDERWORKS);
    expect(floors, 'a one-floor delve has no stair to arrive by').toBeGreaterThan(1);
    const underworks = SITES.get(UNDERWORKS);
    if (underworks === undefined || first.partyId === undefined) {
      throw new Error('no Underworks, or a floor with no party');
    }
    const last = harness.realms.open(
      underworks,
      first.partyId,
      undefined,
      undefined,
      undefined,
      floors,
    );
    // ANY OPEN CELL that is neither a threshold nor already a site.
    const exit = ((): TileXY => {
      const level = last.world.level;
      for (let y = 0; y < level.h; y += 1) {
        for (let x = 0; x < level.w; x += 1) {
          if (!canWalk(level, x, y) || last.sites.has(`${String(x)},${String(y)}`)) continue;
          if (last.spawns.some((t) => t.x === x && t.y === y)) continue;
          return { x, y };
        }
      }
      throw new Error('no open ground on the last floor');
    })();
    (last.sites as Map<string, string>).set(`${String(exit.x)},${String(exit.y)}`, EXIT_SITE_ID);

    for (let floor = 1; floor < floors; floor += 1) {
      const here = realmOf(client);
      expect(here.floor).toBe(floor);
      clear(here);
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair`);
      await stepOnto(client, stairs);
    }
    expect(realmOf(client).id, 'the stairs did not lead to the prepared floor').toBe(last.id);

    // WITHIN SIGHT OF IT FIRST — see `stepWithinSightOf`.
    await stepWithinSightOf(client, exit);
    const map = [...client.frames]
      .reverse()
      .find((f) => (f['t'] === 'sites' || f['t'] === 'realm') && Array.isArray(f['sites']));
    const marker = (map?.['sites'] as Record<string, unknown>[] | undefined)?.find(
      (m) => m['x'] === exit.x && m['y'] === exit.y,
    );
    expect(marker, 'the way out is not on the map').toMatchObject({
      marker: 'stair',
      name: 'The way out',
    });
    expect(marker, 'another zone`s way out wears the Undermost`s cave stair').not.toHaveProperty(
      'landmark',
    );
  });
});

describe('a new character wakes in the Undermost', () => {
  // A SIGNED-IN PLAYER, because only a store asked on behalf of somebody can
  // answer that their character is new.
  const HANDLE = 'birth-handle';
  const identity: IdentityPort = {
    get: (id: string | undefined) =>
      id === HANDLE ? { user: { id: 'birth-user' }, displayName: 'Wren' } : undefined,
  };
  const sockets: WebSocket[] = [];
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await close?.();
    close = undefined;
  });

  async function boot(persist?: PersistPort): Promise<{ port: number; realms: Realms }> {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'undermost-birth',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
      sessions: identity,
      ...(persist === undefined ? {} : { persist }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    close = async (): Promise<void> => {
      await app.close();
    };
    return { port: address.port, realms };
  }

  async function chooseAClass(
    port: number,
  ): Promise<{ actorId: string; frames: Record<string, unknown>[] }> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) {
        frames.push({ ...(parsed as Record<string, unknown>) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', sessionId: HANDLE, newCharacter: true }),
    );
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    let actorId: string | undefined;
    let classId: string | undefined;
    while (Date.now() < deadline && (actorId === undefined || classId === undefined)) {
      const welcome = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof welcome === 'string') actorId = welcome;
      const offered = frames.find((f) => f['t'] === 'class_options')?.['options'];
      if (Array.isArray(offered)) classId = (offered[0] as { id?: string } | undefined)?.id;
      await sleep(10);
    }
    if (actorId === undefined || classId === undefined) throw new Error('no class was offered');
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'choose_class', classId }));
    await sleep(400);
    return { actorId, frames };
  }

  it('puts a character the store has no file for in the Undermost, and tells it why', async () => {
    const noFile: PersistPort = {
      savePlayers: () => undefined,
      savePlayersNow: () => undefined,
      openCharacter: () => Promise.resolve(null),
    };
    const { port, realms } = await boot(noFile);
    const { actorId, frames } = await chooseAClass(port);

    const realm = realms.realmOf(actorId);
    expect(realm?.siteId, 'a new character did not wake in the Undermost').toBe(UNDERMOST_SITE_ID);
    expect(realm?.floor).toBe(1);
    const margin = frames
      .filter((f) => f['t'] === 'log')
      .flatMap((f) => (f['lines'] as { lane: string; text: string }[] | undefined) ?? [])
      .filter((line) => line.lane === LogLane.Margin)
      .map((line) => line.text);
    expect(
      margin.some((text) => text.startsWith('You wake')),
      'nobody told it why',
    ).toBe(true);
    expect(
      margin.some((text) => text.startsWith('The void has noticed you')),
      'a character in the cave was pointed at a case on the surface',
    ).toBe(false);
  });

  it('leaves a character on the map when there is no store to say it is new', async () => {
    const { port, realms } = await boot();
    const { actorId } = await chooseAClass(port);
    expect(realms.realmOf(actorId)?.id).toBe(realms.overworld.id);
  });
});
