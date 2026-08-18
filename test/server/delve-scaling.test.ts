import { describe, expect, it } from 'vitest';

import { DELVES, delveHeadroom, populateDelve } from '../../src/server/content/delve.ts';
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
