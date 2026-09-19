// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  NB_NPC_SCALE,
  actorAdjustLevel,
  delveHeadroom,
  delveLevel,
  floorsOf,
  nbNpcFor,
  specFor,
} from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import { SITES, RealmKind, createRealms } from '../../src/server/world/realms.ts';
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
 * two — see `DECISIONS.md` and the receipt on `NB_NPC_SCALE`.
 *
 * ═══ THE ARITHMETIC, AND EVERY TERM IS THE GAME'S OWN FUNCTION ═══
 * For floor `f` of a delve whose own level is `L` (`delveLevel`):
 *
 *     bodies      `nbNpcFor(spec, f, area)`, the zone's `nb_npc` at NB_NPC_SCALE
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

/** Every delve on the moor and its twin through the Redaction. */
const delves: readonly { readonly site: { readonly id: string }; readonly spec: DelveSpec }[] = [
  ...SITES.values(),
]
  .filter((s) => s.kind === RealmKind.Inner)
  .flatMap((site) => {
    const spec = specFor(site.id);
    return spec === undefined ? [] : [{ site, spec }];
  });

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
function experienceBeforeTheBoss(siteId: string, spec: DelveSpec, scale = NB_NPC_SCALE): number {
  const level = delveLevel(spec);
  let paid = 0;
  for (let floor = 1; floor < floorsOf(spec); floor += 1) {
    const area = spec.nbNpcPerArea === undefined ? undefined : areaOf(siteId, floor);
    const band = nbNpcFor(spec, floor, area);
    // THE FACTOR IS RE-APPLIED, NOT RE-ROLLED. `nbNpcFor` has already taken the
    // shipping `NB_NPC_SCALE`; the counterfactual asks what the same band would
    // be at another factor, which is that band divided out and multiplied back.
    const mid = (band[0] + band[1]) / 2;
    const bodies = scale === NB_NPC_SCALE ? mid : (mid / NB_NPC_SCALE) * scale;
    paid += bodies * averageWorth(spec, level + floor - 1, level);
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
 * THE DELVES THAT CANNOT — AND THERE ARE TWO REASONS, NOT ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There was ONE list here and it carried one claim: *"taking the factor to 1.00
 * leaves it short anyway"*, which made every entry a statement that the count is
 * innocent. That claim was true of two of the seven and false of five, and the
 * only reason it passed was the body-level bug above — a 6% under-count that put
 * the `REDACTED_TOWN` sites at 0.95 of the bar at 1.00 when the placer's own
 * levels put them at 1.004.
 *
 * So the entries are split by WHICH REASON, and each list is pinned from both
 * sides: an entry has to be short at the shipping factor to be excepted at all,
 * and has to be short (or not) at 1.00 to be in the list it is in. Neither list
 * can be grown to hide a delve that is simply fine, and a delve cannot sit in
 * the wrong one.
 *
 * ═══ ONE: SHORT AT ANY COUNT. The level, not the number of bodies ═══
 * Upstream tunes a `nb_npc` and a `level_range` TOGETHER. We ported the count
 * off the zone file and kept our own authored level, and where those two drift
 * far apart the arithmetic cannot close: a body pays LINEARLY in its level
 * (`worthExp`) while `expChart` climbs quadratically, so a count that buys two
 * levels at level 5 buys a fifth of one at level 15. No factor fixes that,
 * because it is not the factor.
 *
 * THE GLASS ARCHIVE is `scintillating-caves`
 * (`data/zones/scintillating-caves/zone.lua:53`), `nb_npc = {12, 16}` — the
 * sparsest band in the twelve — and its own `level_range` is `{1, 5}` (`:25`).
 * We stand it at ELEVEN. At `NB_NPC_SCALE = 1.00`, which is upstream's count
 * with no divergence left at all, it still pays about four fifths of the two
 * levels. Its Redaction twin inherits that band and adds FOUR LEVELS
 * (`redactedSpec`), so it is the same arithmetic with the expensive half of the
 * ratio moved up and the cheap half held exactly still.
 *
 * ═══ TWO: SHORT AT THIS COUNT. The factor, and a bound that outranks it ═══
 * The five `REDACTED_TOWN` sites share one spec at level 14 and therefore share
 * one number to the digit. They clear the bar at upstream's own count and fail
 * at ours, so their shortfall IS the factor — and the factor is held where it is
 * by the other bound on it, which is a measured one and not arithmetic: the room
 * the game names to a four-minute-old character (`first-room.test.ts`) and the
 * turn cost of a floor for a party. `NB_NPC_SCALE`'s own docblock is the
 * receipt. This list is the price of that bound, written down rather than
 * averaged away.
 *
 * ═══ AND THE DRIVEN PROBE AGREES WITH BOTH LISTS, WHICH IS THE BAR THIS FILE
 * SET ITSELF ═══
 * Its own header says a model that disagrees with `tools/delve-climb.mjs` about
 * a delve the probe actually walked is wrong whichever way it errs. Walked, four
 * descents a class: the Watchman gains +1.0 by the Glass Archive's boss (0 of 4
 * runs at +2) and +1.0 to +2.0 on the five towns (0/4, 1/4, 2/4, 2/3, 4/4). The
 * seven entries here are the seven the probe is short on. Every other delve the
 * Watchman reaches the boss of pays its two levels.
 */
const SHORT_AT_ANY_COUNT = new Set([
  // The sparsest band in the game, six levels above the band it was tuned for.
  'site:glass_archive',
  // The Archive's band, four levels further up again.
  'site:redaction:glass_archive',
]);

/** Short at `NB_NPC_SCALE` and NOT at 1.00 — see "TWO" above. */
const SHORT_AT_THIS_COUNT = new Set([
  'site:redaction:alderbrook',
  'site:redaction:ashwick_row',
  'site:redaction:saints_rest',
  'site:redaction:threadneedle_row',
  'site:redaction:wayfarers_camp',
]);

const CANNOT_PAY_TWO = new Set([...SHORT_AT_ANY_COUNT, ...SHORT_AT_THIS_COUNT]);

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
      for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
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
      for (let floor = 1; floor < floorsOf(spec); floor += 1) {
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
   *   IT IS ACTUALLY SHORT, at the factor that ships. Anything else is a delve
   *     that is FINE being carried as though it were not, and the case above
   *     would never notice.
   *   IT IS IN THE RIGHT LIST. Short at 1.00 is the level; short only at ours is
   *     the count. Those are different problems with different fixes, and the
   *     single list that used to be here asserted the first about all seven when
   *     it was true of two.
   */
  it('excepts only delves that are still delves', () => {
    const live = new Set(delves.map(({ site }) => site.id));
    for (const id of CANNOT_PAY_TWO)
      expect(live.has(id), `${id} is excepted and is not a delve any more`).toBe(true);
    expect(CANNOT_PAY_TWO.size, 'the two lists overlap').toBe(
      SHORT_AT_ANY_COUNT.size + SHORT_AT_THIS_COUNT.size,
    );
  });

  it('excepts nothing that is not short at the factor that ships', () => {
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

  it('names the shortfall that is the delve`s LEVEL and not its count', () => {
    for (const { site, spec } of delves) {
      if (!CANNOT_PAY_TWO.has(site.id)) continue;
      const atUpstream = experienceBeforeTheBoss(site.id, spec, 1);
      const need = twoLevels(spec);
      const ratio = (atUpstream / need).toFixed(3);
      if (SHORT_AT_ANY_COUNT.has(site.id)) {
        expect(
          atUpstream,
          `${site.id} pays ${ratio} of two levels at NB_NPC_SCALE = 1.00, which CLEARS` +
            ` the bar — its shortfall is the COUNT, so it belongs in SHORT_AT_THIS_COUNT`,
        ).toBeLessThan(need);
      } else {
        expect(
          atUpstream,
          `${site.id} pays ${ratio} of two levels at NB_NPC_SCALE = 1.00 and is still` +
            ` short — no count fixes it, so it belongs in SHORT_AT_ANY_COUNT`,
        ).toBeGreaterThanOrEqual(need);
      }
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
