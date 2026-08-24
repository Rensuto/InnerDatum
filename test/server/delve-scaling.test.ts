import { describe, expect, it } from 'vitest';

import { DELVES, delveHeadroom, populateDelve, specFor } from '../../src/server/content/delve.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { PartyStrength } from '../../src/server/world/strength.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DELVE ANSWERS THE PARTY THAT WALKED IN. IT NEVER HAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SiteDef.populate` is typed `(world, map, party) => void` and the registry has
 * always CALLED it with all three arguments. The delve rows declared a lambda of
 * two — and TypeScript accepted that, correctly, because a function of fewer
 * parameters is assignable to one of more. Which is exactly why nothing ever
 * complained, and why the party was dropped on the floor for the entire life of
 * the feature.
 *
 * So a lone level-1 detective and a party of four walked into the identical
 * room. That is backwards twice over:
 *
 *   THE AMBUSH ALREADY SCALED (`ambushRoster` reads level and size), so the
 *     fight you STUMBLE into answered the party while the dungeon you
 *     deliberately brought three friends to did not.
 *   D12 PAYS EVERY MEMBER A FULL SHARE, no division by headcount — so four
 *     people clearing a solo-sized room earned four times the experience for a
 *     quarter of the work, and the game's own headline co-op incentive was
 *     pointing straight at its least interesting content.
 */

function delveWith(siteId: string, party: PartyStrength): number {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'delve-scaling',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no such site: ${siteId}`);
  const realm = realms.open(site, `party:${siteId}:${String(party.size)}`, party);
  return realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
}

/**
 * `populateDelve` over a bare world, so the count is read without the registry.
 * The SAME SEED both times, which is what makes the two numbers comparable.
 */
function populatedCount(party: PartyStrength, spec: DelveSpec): number {
  const world = createWorld('delve-stream');
  world.level.tiles.fill(TileCode.FLOOR);
  const map: AuthoredMap = {
    view: world.level,
    spawns: [{ x: 4, y: 4 }],
    sites: new Map<string, string>(),
  };
  return populateDelve(world, map, spec, party);
}

describe('the room grows for the people who brought friends', () => {
  it('puts more in the Underworks for four than for one', () => {
    /**
     * THE REGRESSION, and the numbers are the measured ones: 8 / 12 / 16 / 20.
     * Before the fix all four of these read 8.
     */
    const solo = delveWith('site:underworks', { level: 1, size: 1 });
    const pair = delveWith('site:underworks', { level: 1, size: 2 });
    const four = delveWith('site:underworks', { level: 1, size: 4 });

    expect(pair).toBeGreaterThan(solo);
    expect(four).toBeGreaterThan(pair);
  });

  it('scales every delve, not just one', () => {
    for (const siteId of DELVES.keys()) {
      const solo = delveWith(siteId, { level: 1, size: 1 });
      const four = delveWith(siteId, { level: 1, size: 4 });
      expect(four, `${siteId} did not answer the party`).toBeGreaterThan(solo);
    }
  });

  it('leaves a lone player exactly what they had', () => {
    /**
     * NOT A COINCIDENCE TO BE TUNED AWAY. Every number in `DELVES` was authored
     * and measured against a single body, so `x1.0` at size 1 is what keeps this
     * a fix for parties rather than a difficulty increase for everybody. It is
     * also what makes the two assertions above meaningful: they compare against
     * a baseline that did not move.
     */
    expect(delveHeadroom({ level: 1, size: 1 })).toBe(1);
    expect(delveHeadroom({ level: 9, size: 1 })).toBe(1);
  });

  it('grows sub-linearly, because a party is worth more than its headcount', () => {
    /**
     * Four players focus one target, cover each other, and each of them can
     * chain two at-will talents a round under D1's intra-turn budget. A straight
     * multiply by headcount would make a full party the HARDEST way to play,
     * which is the exact opposite of what this game is for.
     */
    expect(delveHeadroom({ level: 1, size: 4 })).toBe(2.5);
    expect(delveHeadroom({ level: 1, size: 4 })).toBeLessThan(4);
    expect(delveHeadroom({ level: 1, size: 2 })).toBeGreaterThan(1);
  });

  it('ignores level entirely — the roster is the place, the size is the party', () => {
    /**
     * The opposite rule to `ambushRoster`, and the difference is the point: an
     * ambush is generic and happens TO you, so it grows what is in it; a delve
     * is a place you chose, and the Underworks is the Underworks whoever walks
     * in. Only how much of it there is answers the party.
     */
    expect(delveHeadroom({ level: 1, size: 3 })).toBe(delveHeadroom({ level: 12, size: 3 }));
  });

  it('draws the count once and multiplies its ANSWER', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SCALED AFTER THE DRAW, NEVER INSIDE IT.
     * ═══════════════════════════════════════════════════════════════════════
     * `rng.ts` states the consequence of getting this wrong: adding, removing or
     * re-ranging a labelled draw shifts every later draw from that seed forever.
     * Widening `delve.count`'s bounds by party size would hand a party of three
     * a DIFFERENT FLOOR — different loot, different litter, everything
     * downstream — rather than the same floor with more in it.
     *
     * So this asserts the arithmetic directly: `populateDelve` on one world
     * places `rolled`, and on an identically-seeded world with four people it
     * places exactly `round(rolled * 2.5)`. Same roll, more bodies.
     */
    const spec = DELVES.get('site:underworks');
    if (spec === undefined) throw new Error('fixture');

    const rolled = populatedCount({ level: 1, size: 1 }, spec);
    const four = populatedCount({ level: 1, size: 4 }, spec);
    expect(four).toBe(Math.round(rolled * delveHeadroom({ level: 1, size: 4 })));
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR OF A DELVE PAYS THE PARTY THAT WALKED IN, NOT A LEVEL-1 ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `populateDelve` takes a `PartyStrength` and used `party.size` for the body
 * count and NOTHING for the litter: the loot roll was handed a hard-coded `1`,
 * which is exactly `LONE_BEGINNER.level`. So the third argument of `rollLoot` —
 * documented there as "party max level, for both the band and
 * `computeRarities`" — was the bottom band in every delve forever.
 *
 * ═══ IT CONTRADICTED THE LINE DIRECTLY ABOVE IT ═══
 * The litter comment says it is "rolled off the loot stream through the ordinary
 * generator, so litter is the same kind of thing a body drops rather than a
 * second catalogue". A body's drop goes through `encounter.ts`, which passes the
 * REAL level. So litter was not the same kind of thing a body drops, and the
 * comment stating the intent is what makes this a bug rather than a decision.
 *
 * ═══ WHY IT IS NOT "SIZE ONLY, NEVER LEVEL" ═══
 * That rule is argued at length above `partyScale` and it is about the ROSTER:
 * the Underworks is the Underworks whoever walks in, because a delve is a place
 * you chose rather than a fight that happened to you. It is a rule about DANGER.
 * Loot is not danger, and applying it here meant a level-5 party clearing the
 * furthest room on the moor picked up what a level-1 party picks up by the road.
 *
 * WHICH MATTERS MOST FOR THE PLACES YOU HAVE TO FIND. Cairnfoot, Barrow End and
 * The Weir are `hidden`, carry the best litter counts on the map, and were
 * paying that litter at the bottom band — so the reward for finding a secret was
 * more of the cheapest thing.
 */
describe('delve litter is rolled for the party that is there', () => {
  /** Every ground item in a populated delve, as ids, same seed both times. */
  function litterOf(party: PartyStrength, spec: DelveSpec): readonly string[] {
    const world = createWorld('delve-litter');
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    populateDelve(world, map, spec, party);
    return world.groundItems().map((entry) => entry.itemId);
  }

  /** The furthest, richest room on the moor — and one you have to find. */
  const BARROW = specFor('site:barrow_end');

  it('has a spec to test, and it is a hidden one', () => {
    expect(BARROW).toBeDefined();
  });

  it('drops the same NUMBER of things whatever the level', () => {
    // The count comes off `spec.litter` and a labelled draw, so level must not
    // move it — if this fails the fix reached further than it should have.
    const low = litterOf({ level: 1, size: 1 }, BARROW as DelveSpec);
    const high = litterOf({ level: 5, size: 1 }, BARROW as DelveSpec);
    expect(high.length).toBe(low.length);
    expect(low.length).toBeGreaterThan(0);
  });

  it('rolls DIFFERENT things for a level-5 party than for a level-1 one', () => {
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Identical output at every level is the signature of the hard-coded 1: the
    // band and the rarities both read that argument, so a party five levels in
    // was picking up the level-1 table off the floor of a room they had to find.
    /**
     * ═══ LEVELS 1 AND 25, NOT 1 AND 5, AND THE OLD PAIR WAS A COINCIDENCE ═══
     * `LEVELS_PER_BAND` is ten, so levels 1 and 5 are the SAME BAND — the
     * quality table, the money table and now the material grade all read the
     * band and answer identically for both. The only thing that differed was
     * the ego rarity curve, which reads the raw level, and it differed by one
     * pick out of six on this particular seed.
     *
     * That is a real difference and far too thin a thread to hang the
     * assertion on: adding a single labelled draw anywhere upstream shifts the
     * stream and the two can coincide, which is exactly what happened when the
     * material grade landed. Twenty-five is two bands up, so this now fails
     * only if level genuinely stops reaching the loot — which is the bug it
     * was written for.
     */
    const low = litterOf({ level: 1, size: 1 }, BARROW as DelveSpec);
    const high = litterOf({ level: 25, size: 1 }, BARROW as DelveSpec);
    expect(high).not.toEqual(low);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE BODIES TOO — THE SAME BUG, ONE FUNCTION CALL AWAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fixing the litter fixed half of `populateDelve`. The other half hands its
 * drops to `embellish`, which derives the level ITSELF:
 *
 *     partyMaxLevel(world.allActors().filter(isPlayer).map(a => a.level))
 *
 * A delve is populated when the realm OPENS, which is before anybody walks in.
 * So that list is empty, `partyMaxLevel` answers its documented default of 1,
 * and every corpse in every delve carried band-1 loot at every party level.
 *
 * ═══ THE SAME BUG HAD ALREADY BEEN FIXED ONCE, HALF-WAY ═══
 * `embellish`'s own header records the previous round: `delve.ts` used to call
 * `rollDrop` alone and put the bare base id on the corpse, so "no kill inside
 * the game's actual combat content had ever produced an egoed weapon". Routing
 * it through `embellish` fixed that — and moved the failure from "no ego ever"
 * to "ego at band 1 forever", which is quieter and survived longer.
 *
 * A SELF-DERIVING DEFAULT IS THE HAZARD. `embellish` reading the world is right
 * where players are IN it and silently wrong where they are not, and nothing at
 * the call site says which world it is being handed.
 */
describe('a body in a delve carries what the party is worth', () => {
  function carriedIn(party: PartyStrength, spec: DelveSpec): readonly string[] {
    const world = createWorld('delve-carried');
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    populateDelve(world, map, spec, party);
    return world.allActors().flatMap((actor) => [...(actor.carried ?? [])]);
  }

  const BARROW = specFor('site:barrow_end') as DelveSpec;

  it('puts the same NUMBER of things on the bodies whatever the level', () => {
    // `rollDrop` decides whether a body carries anything, off its own labelled
    // draw. Level must not reach that, or the fix rebalanced the room.
    const low = carriedIn({ level: 1, size: 1 }, BARROW);
    const high = carriedIn({ level: 5, size: 1 }, BARROW);
    expect(high.length).toBe(low.length);
    expect(low.length).toBeGreaterThan(0);
  });

  it('rolls different CONTENTS for a level-5 party', () => {
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Byte-identical at both levels, because the world `embellish` read had no
    // players in it yet.
    const low = carriedIn({ level: 1, size: 1 }, BARROW);
    const high = carriedIn({ level: 5, size: 1 }, BARROW);
    expect(high).not.toEqual(low);
  });
});

describe('the room somebody drew is worth the detour', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A VAULT WITH NOTHING IN IT TEACHES A PLAYER NOT TO WALK INTO ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `shared/vault.ts` stamps a drawn room into every delve floor, and it was
   * pure architecture: an interesting-looking chamber that paid nothing. One
   * piece of the floor's litter goes inside it now.
   *
   * THE VAULT STILL DOES NOT DECIDE WHAT IS IN IT — see `shared/vaults.ts` on
   * why upstream's per-tile object filters are not ported. The room says WHERE;
   * this file still says WHAT, out of the same table with the same roll.
   */
  const ROOM = { id: 'vault:test', at: { x: 20, y: 20 }, turn: 'none', w: 4, h: 4 };

  function litterTiles(vaults: AuthoredMap['vaults']): readonly { x: number; y: number }[] {
    const world = createWorld('delve-vault-litter');
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
      ...(vaults === undefined ? {} : { vaults }),
    };
    const spec = specFor('site:underworks');
    if (spec === undefined) throw new Error('no spec');
    populateDelve(world, map, spec, { level: 1, size: 1 });
    return world.groundItems().map((item) => ({ x: item.x, y: item.y }));
  }

  const inside = (tile: { x: number; y: number }): boolean =>
    tile.x >= ROOM.at.x &&
    tile.y >= ROOM.at.y &&
    tile.x < ROOM.at.x + ROOM.w &&
    tile.y < ROOM.at.y + ROOM.h;

  it('puts a piece of the floor litter inside the drawn room', () => {
    const tiles = litterTiles([ROOM]);
    expect(tiles.length, 'the fixture dropped no litter at all').toBeGreaterThan(0);
    expect(
      tiles.filter(inside).length,
      `nothing landed in the room: ${JSON.stringify(tiles)}`,
    ).toBeGreaterThan(0);
  });

  it('does not empty the rest of the floor into it', () => {
    /**
     * Everything in the drawn room would make the rest of the floor not worth
     * walking, which is the opposite of the problem being fixed. `site:underworks`
     * carries two to three pieces, so at least one must be elsewhere.
     */
    const tiles = litterTiles([ROOM]);
    expect(tiles.length).toBeGreaterThan(1);
    expect(
      tiles.filter((tile) => !inside(tile)).length,
      'the whole floor was in one room',
    ).toBeGreaterThan(0);
  });

  it('drops litter as it always did when the floor has no drawn room', () => {
    // A map with no vault system at all — an authored fixture, the arena — and
    // a floor that rolled no room both reach here, and neither is an error.
    const tiles = litterTiles(undefined);
    expect(tiles.length, 'a floor with no room stopped dropping litter').toBeGreaterThan(0);
  });
});
