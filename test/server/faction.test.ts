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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEN THERE WERE FIVE SIDES. THE WHOLE TABLE, DRIVEN, BOTH WAYS ROUND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Faction.Squad` is a temporary companion — a body that fights beside the
 * party, belongs to the FLOOR rather than to a player, and is gone by the time
 * anybody takes the way out. Upstream builds the same thing out of a friendly
 * faction (`data/zones/reknor-escape/npcs.lua:85` is Norgan's
 * `faction = "iron-throne"`; `data/factions.lua:28` gives that faction `-1`
 * against Enemies and Undead) plus party membership (`Party.lua:46-88`).
 *
 * ═══ WHY A TABLE AND NOT FOUR CASES ═══
 * `areEnemies` is ONE line, and a one-line rule fails in pairs nobody thought
 * to ask about. Both directions of all five sides is 25 answers; the rule is
 * two lines long, so writing out all 25 costs nothing and is the only version
 * that cannot be true of the fixture. Every expected value below is a LITERAL,
 * never `reactsAs` re-run — a table computed from the rule under test is the
 * rule under test.
 *
 * ═══ THE TWO TABLES DISAGREE ON PURPOSE, AND THAT IS THE POINT OF HAVING TWO ═══
 * `areEnemies` is not `!sameSide`. A Townsfolk is in neither table: not an
 * enemy of anything, and not an ally of anything either. Her row and her column
 * are all `false` in both, which is the honest shape of somebody standing
 * behind a counter while a fight goes on somewhere else.
 */
const shadow: Sided = { kind: ActorKind.Monster, faction: Faction.Bound };
const squad: Sided = { kind: ActorKind.Monster, faction: Faction.Squad };

const SIDES: Readonly<Record<string, Sided>> = {
  player,
  husk,
  keeper,
  shadow,
  squad,
};

/**
 * `true` where the two are enemies. Rows are `a`, columns are `b`, and both
 * triangles are written out rather than mirrored — a rule that answered
 * asymmetrically would pass a mirrored table by construction.
 */
const ENEMIES: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  //        player  husk   keeper shadow squad
  player: { player: false, husk: true, keeper: false, shadow: false, squad: false },
  husk: { player: true, husk: false, keeper: false, shadow: true, squad: true },
  keeper: { player: false, husk: false, keeper: false, shadow: false, squad: false },
  shadow: { player: false, husk: true, keeper: false, shadow: false, squad: false },
  squad: { player: false, husk: true, keeper: false, shadow: false, squad: false },
};

/** `true` where the two are on the same side — `isFriend`, the Ally predicate. */
const FRIENDS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  //        player  husk   keeper shadow squad
  player: { player: true, husk: false, keeper: false, shadow: true, squad: true },
  husk: { player: false, husk: true, keeper: false, shadow: false, squad: false },
  keeper: { player: false, husk: false, keeper: false, shadow: false, squad: false },
  shadow: { player: true, husk: false, keeper: false, shadow: true, squad: true },
  squad: { player: true, husk: false, keeper: false, shadow: true, squad: true },
};

/**
 * WHAT THE GAME ANSWERED BEFORE `Faction.Squad` EXISTED — the four sides that
 * were on the board at `83db83b`, transcribed by hand from that rule rather
 * than derived from `ENEMIES` above. Two independent transcriptions of the same
 * sixteen facts is the point: one of them being edited to fit a broken rule
 * leaves the other one failing.
 */
const BEFORE_SQUAD: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  //        player  husk   keeper shadow
  player: { player: false, husk: true, keeper: false, shadow: false },
  husk: { player: true, husk: false, keeper: false, shadow: true },
  keeper: { player: false, husk: false, keeper: false, shadow: false },
  shadow: { player: false, husk: true, keeper: false, shadow: false },
};

function pairs(): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const a of Object.keys(SIDES)) for (const b of Object.keys(SIDES)) out.push([a, b]);
  return out;
}

describe('five sides, twenty-five answers', () => {
  it('answers `areEnemies` exactly as the table says, in both directions', () => {
    for (const [a, b] of pairs()) {
      const left = SIDES[a];
      const right = SIDES[b];
      if (left === undefined || right === undefined) throw new Error(`no side ${a}/${b}`);
      expect(areEnemies(left, right), `${a} vs ${b}`).toBe(ENEMIES[a]?.[b]);
    }
  });

  it('answers `isFriend` exactly as the table says, and NOT as `!areEnemies`', () => {
    for (const [a, b] of pairs()) {
      const left = SIDES[a];
      const right = SIDES[b];
      if (left === undefined || right === undefined) throw new Error(`no side ${a}/${b}`);
      expect(isFriend(left, right), `${a} with ${b}`).toBe(FRIENDS[a]?.[b]);
    }
    // THE DISAGREEMENT, ASSERTED RATHER THAN IMPLIED: a townsfolk is the body
    // the two predicates are not negations over, and she is the reason there
    // are two of them.
    expect(areEnemies(player, keeper)).toBe(false);
    expect(isFriend(player, keeper)).toBe(false);
  });

  it('puts a companion on the party’s side and not on its summoner-less own', () => {
    /**
     * THE FOUR THAT CARRY THE FEATURE, named separately from the table so a
     * reader can see what the table is for:
     *
     *   the bestiary fights it        — or nothing can ever kill it
     *   the party cannot hit it       — or friendly fire is a mechanic
     *   it is no enemy of a shadow    — a Redactor's party brought both
     *   it is an ALLY of the party    — Mend Wounds binds it, Iron Curtain
     *                                   guards it, which is the whole point
     */
    expect(areEnemies(squad, husk), 'nothing on the floor would fight it').toBe(true);
    expect(areEnemies(squad, player), 'the party could swing at its own companion').toBe(false);
    expect(areEnemies(squad, shadow), 'two bodies the same party brought fought').toBe(false);
    expect(isFriend(player, squad), 'no heal and no guard would ever reach it').toBe(true);
  });

  it('keeps every answer that existed before it, byte for byte', () => {
    /**
     * THE REGRESSION HALF. A new member of `Faction` must not move one answer
     * about the bodies that were already on the board, or every fight in the
     * game changed with it.
     *
     * ═══ AGAINST A SECOND TABLE, AND THE DUPLICATION IS THE WHOLE MECHANISM ═══
     * This loop used to assert `isEnemy(l, r) === areEnemies(l, r)`, and
     * `talents.ts#isEnemy` is `return areEnemies(a, b)` — so it was a
     * DELEGATION check (already made by the describe above it) wearing a
     * regression comment, and it could not fail. `BEFORE_SQUAD` is the sixteen
     * pre-Squad answers transcribed INDEPENDENTLY of `ENEMIES`: an edit that
     * moves the rule and updates the table it is asserted against still fails
     * here, which is the only thing a regression table is for.
     */
    for (const [a, b] of pairs()) {
      if (a === 'squad' || b === 'squad') continue;
      const left = SIDES[a];
      const right = SIDES[b];
      if (left === undefined || right === undefined) throw new Error(`no side ${a}/${b}`);
      const was = BEFORE_SQUAD[a]?.[b];
      expect(was, `${a} vs ${b} is missing from the before-table`).toBeDefined();
      expect(areEnemies(left, right), `${a} vs ${b}`).toBe(was);
      // AND THE DELEGATION, still asserted — just no longer the only thing.
      expect(isEnemy(left, right), `${a} vs ${b} through isEnemy`).toBe(was);
    }
    expect(areEnemies(player, husk)).toBe(true);
    expect(areEnemies(husk, husk)).toBe(false);
    expect(areEnemies(shadow, husk)).toBe(true);
    expect(areEnemies(shadow, player)).toBe(false);
  });
});
