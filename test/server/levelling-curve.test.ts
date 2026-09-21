// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  CountFit,
  actorAdjustLevel,
  delveHeadroom,
  delveLevel,
  floorsOf,
  floorsToWalk,
  nbNpcFor,
  specFor,
} from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import {
  INFINITY_TOWER_SITE_ID,
  SITES,
  RealmKind,
  createRealms,
} from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { computeRarities, rarityShare } from '../../src/server/content/rarity.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import { expChart, worthExp } from '../../src/shared/progression.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      A DELVE IS A LEVELLING CURVE. THIS IS THE RULING, MADE ARITHMETIC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The author: *"the goal is to level up before encountering the boss at the end.
 * you are not meant to get to the end of the dungeon without leveling at least
 * twice. this is exactly like ToME does."*
 *
 * So a delve owes two character levels' worth of experience on the floors BEFORE
 * its boss, and that is a fact about the delve's own numbers — `nb_npc`, the
 * level its bodies are born at, `worthExp` and `expChart` — none of which
 * mentions a class. It is checkable here, exactly, with no probe.
 *
 * ═══ WHAT THIS CASE IS NOT ═══
 * IT IS NOT "EVERY CLASS LEVELS TWICE". It is the delve's half of that sentence:
 * *the room pays two levels to anybody who clears it.* Whether a given class CAN
 * clear it is the other half, it is a fact about the class and the driver, and it
 * is measured by `tools/delve-climb.mjs`, which walks one character top to bottom
 * carrying level and experience. A green run here says the experience is on the
 * floor; it does not say anybody lived to collect it, and reading it that way is
 * how the two halves get confused. At the time of writing the Watchman collects
 * it on eleven delves and the other three classes complete a descent on one or
 * two — see `DECISIONS.md` and the note above `CountFit` in `content/delve.ts`.
 *
 * ═══ THE ARITHMETIC, AND EVERY TERM IS THE GAME'S OWN FUNCTION ═══
 * For floor `f` of a delve whose own level is `L` (`delveLevel`):
 *
 *     bodies      `nbNpcFor(spec, f, area)`, the sourced zone's `nb_npc`, verbatim
 *     their level `actorAdjustLevel`'s own answer   — engine/Zone.lua:195
 *     each pays   `worthExp(thatLevel, rank, L)`    — Actor.lua:6513-6531
 *     two levels  `expChart(L + 1) + expChart(L + 2)` — load.lua:205
 *
 * ═══ AND THE BODY'S LEVEL IS THE PLACER'S, WHICH IS THE THIRD THING THIS FILE
 * GOT WRONG ═══
 * It priced every body at `L + f - 1` — two of `actor_adjust_level`'s four
 * terms. The placer births them at
 * `max(1, L + rankLevelAdjust(rank) + f - 1 + rng.range(-1, 2))`, so an elite is
 * TWO levels over that and a boss THREE, and the jitter leans up by half a level
 * on top. `worthExp` is linear in the level, so the model under-counted every
 * delve by about 6% — and that is not a rounding error where it matters: the
 * five `REDACTED_TOWN` sites came out at 0.95 of two levels at upstream's own
 * count under the old model and at 1.004 under the placer's, which is the
 * difference between "no factor fixes this" and "the count fixes this".
 *
 * PROVED BLIND, NOT ARGUED: dropping `rankLevelAdjust` from `actorAdjustLevel`
 * left this file green, and so did dropping its `floor - 1` term. Both are
 * caught by `monster-scaling.test.ts`, so that was never a coverage hole — it
 * was proof that this file's arithmetic was not the game's.
 *
 * THE JITTER IS SUMMED, NOT SAMPLED. `rng.range(-1, 2)` has four equally likely
 * values and the expectation of a sum is the sum of expectations, so walking the
 * four is exact rather than an estimate — and it stays a pure function with no
 * draw of its own.
 *
 * summed over floors `1 .. floorsOf(spec) - 1`, because the last floor is where
 * the boss is standing and the question is what you are carrying when you walk
 * onto it.
 *
 * ═══ THE COUNT IS THE BAND'S MIDPOINT, AND THAT IS `rng.range`'S OWN MEAN ═══
 * `populateDelve` rolls `world.rng.int('delve.count', band[0], band[1])` — a
 * uniform draw, inclusive at both ends, whose expectation is the midpoint. So
 * the midpoint is what a floor pays, not an average of something else.
 *
 * THE FIRST VERSION OF THIS FILE USED THE BOTTOM OF THE BAND and it was wrong
 * in a way worth recording: a delve sums three or four floors, so "unlucky on
 * every floor of the descent" is a one-in-a-thousand run, and asserting it is
 * asserting a bar the ruling never set. It also failed delves that pay two
 * levels on nineteen runs in twenty, which would have been read as the count
 * being too low.
 *
 * ═══ AND THE RANKS ARE THE ROSTER'S, NOT A FLAT `Normal` ═══
 * The second version of this file paid every body `RANK_WORTH[Normal]`, 0.8,
 * on the argument that it was the cheapest row and therefore pessimistic. It
 * was pessimistic by the wrong amount and in a place that mattered: an elite
 * pays 3, nearly four normals, and Blackwood Outskirts came out at 0.91 of two
 * levels while `tools/delve-climb.mjs` had the Watchman gaining two on six
 * descents out of six. A model that disagrees with the driven probe about a
 * delve the probe actually walked is wrong, whichever direction it errs in.
 *
 * So the mix is the one the placer draws: `computeRarities` at this floor's own
 * level, `rarityShare` for each candidate's share of the draw, and each share
 * paid at ITS OWN rank. That is `populateDelve`'s own two calls, so the number
 * moves when a creature's `rarity`, `levelRange` or `rank` moves — which is the
 * whole point of not restating the roster here.
 *
 * ═══ ONE WAY IT IS STILL DELIBERATELY PESSIMISTIC ═══
 * `delveHeadroom` is left at 1.0 — a lone player. A party of three meets twice
 * the bodies AND each of them is paid the full award (`awardExperience`, D12),
 * so more people is strictly more experience each, and this is the floor of the
 * range for every party size.
 */

/**
 * Every delve on the moor and its twin through the Redaction.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXCEPT A PLACE WITH NO BOTTOM, AND NOT AS AN EXEMPTION — THE QUESTION DOES
 * NOT APPLY TO IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every case in this file is built on "a delve pays two character levels on the
 * floors BEFORE ITS BOSS". The Infinity Tower has no boss and no last floor, so
 * there is no "before" — and it does not merely fail to apply, it passes for
 * the wrong reason. `floorsToWalk` bounds the walk at four, so the case summed
 * floors 1 to 3 of an endless place and asserted the three SHALLOWEST floors in
 * the game's deepest dungeon pay two levels. They do, comfortably; and they
 * would keep doing so however badly the floor-40 economy behaved. A guard that
 * had stopped guarding, on the one test in the repo that asks whether a dungeon
 * pays for itself.
 *
 * Two more things make the model wrong here rather than just uninformative:
 * `experienceBeforeTheBoss` computes a body's level as `level + floor - 1`,
 * which is every zone's line EXCEPT this one (`DelveSpec.depthScale`, the ×1.2
 * at `infinite-dungeon/zone.lua:28`), and `averageWorth` pays on `RANK_WORTH`,
 * where this zone pays on `RANK_WORTH_INFINITE` (`Actor.lua:6519`). Both halves
 * of upstream's bargain are invisible to this file.
 *
 * THE QUESTION IS ASKED WHERE BOTH HALVES ARE IN PLAY — `test/server/tower.test.ts`,
 * as a RATE ("what does one floor pay, against what one level costs at the
 * level that floor demands") rather than as a total, because a rate is the only
 * form the question has when there is no total.
 */
const delves: readonly { readonly site: { readonly id: string }; readonly spec: DelveSpec }[] = [
  ...SITES.values(),
]
  .filter((s) => s.kind === RealmKind.Inner)
  .flatMap((site) => {
    const spec = specFor(site.id);
    if (spec === undefined) return [];
    // BY THE SPEC'S OWN ENDLESSNESS, not by its id — see above. A second
    // bottomless place must be a deliberate act, and the count below is what
    // makes it one.
    if (spec.maxFloors !== undefined) return [];
    return [{ site, spec }];
  });

/**
 * AND THE EXCLUSION IS COUNTED, for the reason `CANNOT_PAY_TWO` is pinned from
 * every side below: an exclusion nobody counts is a hole that widens quietly.
 * One row in `DELVES` states its own depth; a second would have to say so here.
 */
const ENDLESS_DELVES = [...SITES.values()].filter(
  (s) => s.kind === RealmKind.Inner && specFor(s.id)?.maxFloors !== undefined,
).length;

/**
 * THE FLOOR'S CELL COUNT, FOR THE ONE ZONE THAT READS IT.
 *
 * `populateDelve` calls `nbNpcFor(spec, floor, map.view.w * map.view.h)`, and
 * `nbNpcPerArea` — `infinite-dungeon/zone.lua:255-256` — is the only field that
 * looks at it. For every other spec `perArea` is `undefined` whatever is passed,
 * which the first case below asserts rather than assumes, so the cheap path is
 * provably the placer's own answer.
 */
function areaOf(siteId: string, floor: number): number {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  const seed = `levelling-curve:${siteId}:${String(floor)}`;
  const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
  const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, floor);
  return realm.world.level.w * realm.world.level.h;
}

/** `rng.range(-1, 2)` — every value it can take, each equally likely. */
const JITTER = [-1, 0, 1, 2] as const;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN `Rng` THAT ALWAYS ROLLS ONE JITTER, SO `actorAdjustLevel` ITSELF IS DRIVEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE FIRST FIX FOR THE BODY-LEVEL BUG RE-IMPLEMENTED THE FORMULA HERE, and a
 * mutant walked straight through it: dropping `rankLevelAdjust` from
 * `actorAdjustLevel` left this file green, because this file was computing the
 * same expression a second time instead of calling the one the placer calls.
 * That is the repo's own recurring fault — test the JOIN, not the halves — and
 * it was reintroduced by the very edit that was fixing an instance of it.
 *
 * So the production function is called with its own arguments and the only thing
 * standing in is the one draw it takes. Every other method throws rather than
 * returning a plausible number: if `actorAdjustLevel` ever draws twice, this
 * says so instead of silently modelling the wrong thing.
 */
function rollsExactly(jitter: number): Rng {
  const refuse = (what: string): never => {
    throw new Error(`actorAdjustLevel drew ${what}, which this stub cannot answer`);
  };
  return {
    int: () => jitter,
    nextU32: () => refuse('nextU32'),
    nextFloat: () => refuse('nextFloat'),
    pick: () => refuse('pick'),
    shuffle: () => refuse('shuffle'),
    fork: () => refuse('fork'),
    getState: () => refuse('getState'),
    setState: () => refuse('setState'),
  };
}

/**
 * What one body off this delve's roster is worth, averaged over the draw AND
 * over the level the placer births it at.
 *
 * `roomLevel` is the FLOOR's level (`L + f - 1`) and decides which candidates are
 * eligible and how the draw is weighted — `populateDelve` builds the same list
 * with the same two calls. The BODY's level is `actorAdjustLevel`'s, which adds
 * the rank term and the jitter on top, and that is what `worthExp` is paid on.
 */
function averageWorth(spec: DelveSpec, roomLevel: number, level: number): number {
  const shares = rarityShare(
    computeRarities(
      spec.roster.filter(
        (t): t is MonsterTemplate & { rarity: number; levelRange: readonly [number, number] } =>
          t.rarity !== undefined && t.levelRange !== undefined,
      ),
      roomLevel,
      spec.maxOod === undefined
        ? undefined
        : (e) => roomLevel + (spec.maxOod ?? 0) >= e.levelRange[0],
    ),
  );
  let worth = 0;
  for (const { e, percent } of shares) {
    let overJitter = 0;
    for (const j of JITTER) {
      // THE PLACER'S OWN FUNCTION, not a second copy of its arithmetic. The two
      // terms it does not get from `roomLevel` are passed as it receives them:
      // `baseLevel` is the delve's level and `floor` reconstructs the `+ f - 1`
      // that `roomLevel` already carries, so the sum is the same one
      // `populateDelve` computes.
      const bodyLevel = actorAdjustLevel(
        rollsExactly(j),
        'levelling-curve.jitter',
        level,
        e.rank,
        roomLevel - level + 1,
      );
      overJitter += worthExp(bodyLevel, e.rank, level) / JITTER.length;
    }
    worth += (percent / 100) * overJitter;
  }
  return worth;
}

/** What floors 1..N-1 of this delve pay, on an average floor, if all of it dies. */
function experienceBeforeTheBoss(siteId: string, spec: DelveSpec): number {
  const level = delveLevel(spec);
  let paid = 0;
  for (let floor = 1; floor < floorsToWalk(spec); floor += 1) {
    const area = spec.nbNpcPerArea === undefined ? undefined : areaOf(siteId, floor);
    const band = nbNpcFor(spec, floor, area);
    paid += ((band[0] + band[1]) / 2) * averageWorth(spec, level + floor - 1, level);
  }
  return paid;
}

/** Two character levels, from where this delve starts you. */
function twoLevels(spec: DelveSpec): number {
  const level = delveLevel(spec);
  return expChart(level + 1) + expChart(level + 2);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DELVES THAT CANNOT — AND THE EXCEPTION IS NOW EARNED, NOT ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There were TWO lists here and the split between them was "short at
 * `NB_NPC_SCALE` and not at 1.00" against "short at both". THAT DISTINCTION NO
 * LONGER EXISTS: the factor is deleted and every band is an upstream `nb_npc`
 * verbatim, so there is one count and one question.
 *
 * ═══ WHAT REPLACED IT IS A CONTRACT AGAINST THE ALIGNMENT ITSELF ═══
 * `DelveSpec.countFrom` says, per row, how the source zone's `level_range`
 * stands to the level we place the delve at, and
 * `test/server/delve-alignment.test.ts` checks each of those labels against the
 * band. THE RULE HERE IS THAT ALIGNMENT IS THE LICENCE TO BE EXCEPTED: a delve
 * every row of which is `CountFit.Covers` — a count upstream authors at exactly
 * the level we place it at — has no excuse left and must pay. Only a delve
 * carrying a row that is NOT `Covers` may sit on this list, and it must still
 * actually be short.
 *
 * That is what stops an exception list outliving its cause. The old one could be
 * grown by adding an id; this one can only be grown by first admitting, in
 * `content/delve.ts` and under a test that reads the Lua, that a delve's count
 * is not the one upstream states for its level.
 *
 * ═══ SO: FIVE ENTRIES, AND THEY ARE ONE ROOM ═══
 *
 * THE GLASS ARCHIVE AND ITS TWIN WERE ON THIS LIST AND HAVE COME OFF IT, which
 * is this rule doing the work it was written for. They were `CountFit.Unaligned`
 * because a 50x50 count on their 30x30 floor was refused as denser than anything
 * upstream builds — a clause of OURS that
 * `data/zones/orc-breeding-pit/zone.lua:83` refutes, forty bodies inheriting
 * onto a floor with `min_floor=120`. With the clause gone the Archive takes
 * `data/zones/halfling-ruins/zone.lua:50` at `{10, 25}`, every row is `Covers`,
 * and the contract above STOPS PERMITTING the exception: the case below reports
 * it as paying 1.43x and demands the id be removed. It was 0.79 for two years of
 * this file's life and no factor could have reached it.
 *
 * THE FIVE `REDACTED_TOWN` SITES are `CountFit.PlayerScheme`: their count is not
 * a band at all but the Infinite Dungeon's own area formula
 * (`data/zones/infinite-dungeon/zone.lua:255-256`), `ceil(2500 * 34/4900)` on
 * our 50x50 floors, so `{13, 23}`. There is no other zone to take it from —
 * that IS the zone's statement — and it lands at 0.991 of two levels. Short by
 * nine parts in a thousand, at upstream's own arithmetic, with nothing to
 * substitute. It was 0.85 before the factor came off.
 *
 * AND THE FIVE ARE ONE NUMBER, not five: they share a single spec
 * (`REDACTED_TOWN`) at level 14 and therefore agree to the digit.
 */
const CANNOT_PAY_TWO = new Set([
  // One spec, five doors: the Infinite Dungeon's area formula on a 50x50.
  'site:redaction:alderbrook',
  'site:redaction:ashwick_row',
  'site:redaction:saints_rest',
  'site:redaction:threadneedle_row',
  'site:redaction:wayfarers_camp',
]);

describe('a delve pays two levels before its boss', () => {
  it('reads the area only where upstream does', () => {
    /**
     * The cheap path above passes `undefined` for every spec without
     * `nbNpcPerArea`. That is only sound if the field is genuinely the only
     * reader, so this drives `nbNpcFor` both ways rather than trusting the
     * docblock — the same rule that caught a band scaled by floor area across
     * every zone instead of the one.
     */
    let flat = 0;
    for (const { site, spec } of delves) {
      if (spec.nbNpcPerArea !== undefined) continue;
      flat += 1;
      for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
        expect(
          nbNpcFor(spec, floor, 40 * 40),
          `${site.id} floor ${String(floor)} moved with the floor's area`,
        ).toEqual(nbNpcFor(spec, floor, undefined));
      }
    }
    expect(flat, 'no flat-band delve left to check').toBeGreaterThan(0);
  });

  it('pays two levels on the floors before the boss', () => {
    const short: string[] = [];
    for (const { site, spec } of delves) {
      if (CANNOT_PAY_TWO.has(site.id)) continue;
      const paid = experienceBeforeTheBoss(site.id, spec);
      const need = twoLevels(spec);
      if (paid < need)
        short.push(
          `${site.id} pays ${paid.toFixed(0)} of the ${String(need)} two levels cost` +
            ` (${(paid / need).toFixed(2)}x)`,
        );
    }
    expect(short).toEqual([]);
  });

  it('has something to say — every delve is a real climb, not a zero', () => {
    /**
     * ═══ THE PRECONDITION, BECAUSE WITHOUT IT THE CASE ABOVE IS VACUOUS ═══
     * A delve of one floor has no floors before its boss, and an empty sum is
     * zero, which `paid < need` would catch — but a delve whose band rounded to
     * `[0, n]` would pass the bottom-of-band reading with nothing on the floor.
     * Both are named here so the failure says which.
     */
    for (const { site, spec } of delves) {
      expect(floorsOf(spec), `${site.id} has no floor before its boss`).toBeGreaterThan(1);
      for (let floor = 1; floor < floorsToWalk(spec); floor += 1) {
        const area = spec.nbNpcPerArea === undefined ? undefined : areaOf(site.id, floor);
        expect(
          nbNpcFor(spec, floor, area)[0],
          `${site.id} floor ${String(floor)} can roll empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AN EXCEPTION HAS TO CARRY ITS REASON OR IT IS A SUPPRESSION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `CANNOT_PAY_TWO` would otherwise be a list somebody could grow every time
   * the case above went red. The three cases below pin it from every side that
   * can rot:
   *
   *   IT IS A LIVE DELVE. A renamed or deleted site leaves a dead entry silently
   *     excusing nothing, which is how an exception list outlives its reason.
   *   IT IS ACTUALLY SHORT. Anything else is a delve that is FINE being carried
   *     as though it were not, and the case above would never notice.
   *   ITS COUNT IS NOT ONE UPSTREAM STATES AT ITS LEVEL. This is the one that
   *     replaced the old two-list split, and it is the reason the list cannot be
   *     grown quietly: a delve whose every `countFrom` row is `CountFit.Covers`
   *     has no excuse to offer, so excusing it fails here and the fix has to be
   *     made in `content/delve.ts` under a test that reads the Lua.
   */
  it('leaves out exactly one bottomless place, and it is still bottomless', () => {
    expect(ENDLESS_DELVES).toBe(1);
    expect(delves.some(({ site }) => site.id === INFINITY_TOWER_SITE_ID)).toBe(false);
    expect(delves.length, 'the sweep excluded more than the one').toBeGreaterThan(20);
  });

  it('excepts only delves that are still delves', () => {
    const live = new Set(delves.map(({ site }) => site.id));
    for (const id of CANNOT_PAY_TWO)
      expect(live.has(id), `${id} is excepted and is not a delve any more`).toBe(true);
  });

  it('excepts nothing that is not short', () => {
    for (const { site, spec } of delves) {
      if (!CANNOT_PAY_TWO.has(site.id)) continue;
      const paid = experienceBeforeTheBoss(site.id, spec);
      const need = twoLevels(spec);
      expect(
        paid,
        `${site.id} pays ${paid.toFixed(0)} of ${String(need)} and is excepted anyway` +
          ` (${(paid / need).toFixed(2)}x) — take it off the list`,
      ).toBeLessThan(need);
    }
  });

  it('excepts nothing whose count is the one upstream states at its own level', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ALIGNMENT IS THE LICENCE TO BE EXCEPTED, AND IT IS THE ONLY ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `CountFit.Covers` means the source zone's `level_range` covers the level
     * we place the delve at, on a floor the size we build — so the count is
     * exactly what ToME puts in front of a character standing at their own
     * level. A delve made of nothing but those rows has spent its excuse: if it
     * still cannot pay two levels, the thing to change is the delve, not this
     * list.
     *
     * The converse is deliberately NOT asserted. Gearford Ward's rows are
     * `PlayerScheme` and it pays 1.7 of two levels — being unalignable is
     * permission to be short, not a prediction that you will be.
     */
    for (const { site, spec } of delves) {
      if (!CANNOT_PAY_TWO.has(site.id)) continue;
      const fits = spec.countFrom.map((row) => row.fit);
      expect(
        fits.some((fit) => fit !== CountFit.Covers),
        `${site.id} is excepted from paying two levels and every one of its counts is` +
          ` one upstream states at its own level (${fits.join(', ')}) — it has no excuse`,
      ).toBe(true);
    }
  });

  it('is measured for one player and only gets better with company', () => {
    /**
     * `delveHeadroom` multiplies the count by 1.5 per extra body and
     * `awardExperience` pays every party member the FULL award (D12), so a
     * party of three meets twice the bodies and each of them banks twice the
     * experience. The case above is therefore the floor of the range for every
     * party size, which is the reading worth pinning: a headroom that ever went
     * sublinear would make the promise true for one player and false for four.
     */
    for (const { spec } of delves) {
      const alone = delveHeadroom({ level: delveLevel(spec), size: 1 });
      expect(alone, 'a lone player no longer meets the bare band').toBe(1);
      for (let size = 2; size <= 5; size += 1) {
        expect(
          delveHeadroom({ level: delveLevel(spec), size }),
          `a party of ${String(size)} meets fewer bodies each than a lone player`,
        ).toBeGreaterThan(alone);
      }
    }
  });
});
