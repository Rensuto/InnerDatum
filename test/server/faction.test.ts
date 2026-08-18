import { describe, expect, it } from 'vitest';

import { ActorKind } from '../../src/shared/protocol.ts';
import { Faction, areEnemies } from '../../src/server/engine/actor.ts';
import { isEnemy, isFriend } from '../../src/server/engine/talents.ts';
import type { Sided } from '../../src/server/engine/actor.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "SAME KIND MEANS SAME SIDE" WAS WRITTEN OUT THREE TIMES, IN TWO MODULES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `engine/actor.ts#isHostile`      — the one everybody knows about
 *   `engine/talents.ts#isEnemy`      — a second copy of the same line
 *   `engine/talents.ts#canUseTalent` — a third, INLINE, as
 *                                      `victim.kind === actor.kind`
 *
 * None of the last two is reachable from a grep for `isHostile`; none is a
 * compile error; none is a lint error. So a faction added to the first alone
 * would have left the Inspector's Revolver Shot landing on a shopkeeper on day
 * one — `'player' === 'monster'` is false, so `canUseTalent` would never have
 * refused — and put her inside an Alchemic Vial through `actorsInShape`.
 *
 * All three now delegate to `areEnemies`. This file exists to make sure they
 * still do, because the property that made this bug possible has not gone away:
 * a fourth copy would compile, lint and ship.
 */

const player: Sided = { kind: ActorKind.Player };
const husk: Sided = { kind: ActorKind.Monster, faction: Faction.Redacted };
const keeper: Sided = { kind: ActorKind.Monster, faction: Faction.Townsfolk };

describe('areEnemies — the one answer', () => {
  it('keeps the old rule for everything that existed before', () => {
    // The whole bestiary defaults to Redacted, so no seeded stream moves and no
    // fight changes. This is the byte-identical clause.
    expect(areEnemies(player, husk)).toBe(true);
    expect(areEnemies(husk, player)).toBe(true);
    expect(areEnemies(husk, husk)).toBe(false);
    expect(areEnemies(player, player)).toBe(false);
  });

  it('makes a townsfolk nobody’s enemy, in both directions', () => {
    // BOTH directions, separately asserted. A one-sided check would leave the
    // shopkeeper unable to be attacked while still being counted as a target by
    // whatever asks the question the other way round.
    expect(areEnemies(player, keeper)).toBe(false);
    expect(areEnemies(keeper, player)).toBe(false);
    expect(areEnemies(husk, keeper)).toBe(false);
    expect(areEnemies(keeper, husk)).toBe(false);
  });

  it('does not make a townsfolk an ALLY either — she is simply not in the fight', () => {
    /**
     * `isFriend` is the Ally affinity's predicate, and Iron Curtain guards the
     * worst-off adjacent friend and pulls their hunters onto the Watchman.
     *
     * THE HUSK CASE IS THE ONE THAT MATTERS. A townsfolk IS a `Monster`, so a
     * bare `a.kind === b.kind` made a shopkeeper the ally of every husk in the
     * game — somebody for the bestiary to protect. Read the other way it is just
     * as wrong: an ally of a player is healable, guardable and counted in the
     * party's arithmetic, in a party nobody invited her to.
     */
    expect(isFriend(husk, keeper)).toBe(false);
    expect(isFriend(keeper, husk)).toBe(false);
    expect(isFriend(player, keeper)).toBe(false);
    // Neither an enemy nor an ally. Both halves, on one body, in one assertion.
    expect(isEnemy(player, keeper)).toBe(false);
    expect(isFriend(husk, husk)).toBe(true);
  });
});

describe('every hostility site delegates', () => {
  /**
   * `isEnemy` is the copy in `engine/talents.ts`, and it feeds `pullAggro` and
   * `resolveGuardCounter` as well as the Hostile affinity. If it ever stops
   * delegating, this disagrees with `areEnemies` and says so.
   */
  it('talents.ts#isEnemy answers exactly what areEnemies answers', () => {
    const cases: readonly (readonly [Sided, Sided])[] = [
      [player, husk],
      [husk, player],
      [husk, husk],
      [player, keeper],
      [keeper, player],
      [keeper, husk],
    ];
    for (const [a, b] of cases) {
      expect({ a: a.faction ?? a.kind, b: b.faction ?? b.kind, enemy: isEnemy(a, b) }).toEqual({
        a: a.faction ?? a.kind,
        b: b.faction ?? b.kind,
        enemy: areEnemies(a, b),
      });
    }
  });
});
