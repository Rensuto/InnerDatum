// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CountFit,
  delveLevel,
  eligibleOn,
  floorsOf,
  floorsToWalk,
  nbNpcFor,
  specFor,
} from '../../src/server/content/delve.ts';
import type { CountSource, DelveSpec } from '../../src/server/content/delve.ts';
import { SITES, RealmKind } from '../../src/server/world/realms.ts';
import { rarityShare } from '../../src/server/content/rarity.ts';
import { ZONES as SITE_ZONES, zoneFloor, zoneTable } from '../../src/shared/mapgen/zones.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   EVERY COUNT IS ONE ToME STATES FOR THE LEVEL WE PLACE THE DELVE AT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `content/delve.ts` used to read each delve's `nb_npc` off the zone its FLOOR
 * is built from, and nothing anywhere asked whether that zone's `level_range`
 * had anything to do with the level we stand the delve at. Mostly it did not:
 * the Underworks carried orc-breeding-pit's `{40, 50}` — `level_range =
 * {30, 60}` — at level three, and the Hollow Mine carried ardhungol's
 * `{70, 80}`, `{25, 32}`, at level nine. A single global factor stood in
 * `delve.ts` absorbing the difference, and it could not: one number cannot be
 * right for a table that drifts in both directions at once.
 *
 * `DelveSpec.countFrom` is the fix, as data rather than as a comment, and this
 * file is what makes the data mean something. Three questions, and they are
 * independent:
 *
 *   IS THE ROW TRUE ABOUT ToME? Every `cite` is opened in `reference/` and the
 *     line is read. `npm run check:citations` proves a cited line EXISTS; this
 *     proves it says what the row says it says. `delve.ts` has already shipped
 *     four `max_ood` citations that were each one line low and two sentences
 *     invented outright, with the gate green throughout.
 *   IS THE ROW TRUE ABOUT US? The band the placer uses on the floors a row
 *     claims has to be that row's `nbNpc` — asked through `nbNpcFor`, the
 *     placer's own function, rather than by reading the table back.
 *   IS THE DELVE ALIGNED? Every row's `fit` is checked against its band and the
 *     delve's level, from BOTH sides: `Covers` must cover, `Unaligned` must NOT,
 *     and `Clamped` must be exactly one level out.
 *
 * ═══ THE THIRD ONE IS THE ANTI-ROT MECHANISM AND IT IS THE POINT ═══
 * A label that only fires one way is a label somebody leaves on. `Unaligned`
 * asserted from the other side means the day the Glass Archive's floor grows and
 * its count becomes legal, this file goes RED until the label comes off — which
 * is the opposite of an exception list that outlives its cause.
 *
 * DRIVEN OVER `SITES`, NOT OVER `DELVES`: twenty-two of the twenty-eight specs
 * are DERIVED by `redactedSpec` at their original's level plus four, and three
 * of them re-source because a `{1, 5}` band does not reach seven, nine or ten.
 * A file that read the authored table would check twelve rows and miss all of
 * that.
 */

/** Every delve on the moor, its twin through the Redaction, and the tutorial. */
const delves: readonly { readonly id: string; readonly spec: DelveSpec }[] = [...SITES.values()]
  .filter((s) => s.kind === RealmKind.Inner)
  .flatMap((site) => {
    const spec = specFor(site.id);
    return spec === undefined ? [] : [{ id: site.id, spec }];
  });

/** `data/zones/deep-bellow/zone.lua:48` -> the path and the line. */
function parseCite(cite: string): { readonly path: string; readonly line: number } {
  const m = /^([A-Za-z0-9_./-]+\.lua):(\d+)$/.exec(cite);
  if (m?.[1] === undefined || m[2] === undefined) throw new Error(`unparseable citation: ${cite}`);
  return { path: m[1], line: Number(m[2]) };
}

/**
 * How many cells OUR floor has, from the same table `sitemap.ts` builds it from.
 * `undefined` for a site `zones.ts` does not describe (the tutorial's hand-drawn
 * floors), which the caller skips rather than guesses at.
 */
function cellsOfFloor(id: string, floor: number): number | undefined {
  // A twin is `site:redaction:<original>` and is built from its original's zone.
  const twin = `${REDACTION_SITE_ID}:`;
  const zone = SITE_ZONES.get(id.startsWith(twin) ? `site:${id.slice(twin.length)}` : id);
  if (zone === undefined) return undefined;
  const table = zoneTable(zoneFloor(zone, floor), zone.palette);
  // A zone that ROLLS its table per level change (the Infinite Dungeon) has no
  // fixed size to compare; those rows are the area formula's and are skipped
  // by the caller anyway.
  if (typeof table === 'function') return undefined;
  return table.width * table.height;
}

/** Every row of every delve, with the site it belongs to, for the table cases. */
const rows: readonly {
  readonly id: string;
  readonly spec: DelveSpec;
  readonly row: CountSource;
}[] = delves.flatMap(({ id, spec }) => spec.countFrom.map((row) => ({ id, spec, row })));

describe('every delve says where its count came from', () => {
  it('carries at least one source, and every floor is claimed by exactly one', () => {
    /**
     * ═══ THE PRECONDITION, BECAUSE WITHOUT IT EVERY CASE BELOW IS VACUOUS ═══
     * A spec with an empty `countFrom` would pass every "for each row" case in
     * this file by having no rows. And a floor claimed by two rows, or by none
     * while `nbNpcByFloor` overrides it, is a count with no citation — which is
     * the state this whole file exists to make impossible.
     */
    expect(delves.length, 'no delves at all').toBeGreaterThan(20);
    for (const { id, spec } of delves) {
      expect(spec.countFrom.length, `${id} states no source for its count`).toBeGreaterThan(0);

      const defaults = spec.countFrom.filter((row) => row.floors === undefined);
      expect(defaults.length, `${id} has ${String(defaults.length)} rows for its base band`).toBe(
        1,
      );

      for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
        const claiming = spec.countFrom.filter((row) => row.floors?.includes(floor) === true);
        expect(
          claiming.length,
          `${id} floor ${String(floor)} is claimed by ${String(claiming.length)} sources`,
        ).toBeLessThanOrEqual(1);
        // A floor with an override MUST have a row claiming it: otherwise the
        // override is a count nobody cited.
        if (spec.nbNpcByFloor?.has(floor) === true) {
          expect(
            claiming.length,
            `${id} floor ${String(floor)} overrides the band and cites nothing`,
          ).toBe(1);
        }
      }
    }
  });

  it('places the band each source states, on the floors that source claims', () => {
    /**
     * ═══ ASKED THROUGH THE PLACER, NOT BY READING THE TABLE BACK ═══
     * `nbNpcFor` is what `populateDelve` calls, so a factor, a party term or a
     * "+2 for the twins" applied anywhere between the row and the floor shows up
     * here. Comparing `row.nbNpc` against `spec.nbNpc` would compare the table
     * with itself.
     *
     * `nbNpcPerArea` is the one spec whose band is not a stated pair — the
     * Infinite Dungeon computes it from the floor's own area
     * (`data/zones/infinite-dungeon/zone.lua:255-256`) — and its rows carry the
     * base table's `{29, 39}` as the citation. Its arithmetic is pinned in
     * `monster-scaling.test.ts`; what is checked here is that the row states the
     * base table, which is what `nbNpcFor` falls back to when a floor reports no
     * area at all.
     */
    let checked = 0;
    for (const { id, spec } of delves) {
      for (const row of spec.countFrom) {
        const floors = row.floors ?? [];
        if (row.floors === undefined) {
          /**
           * FLOOR ZERO IS NOT A FLOOR — it is how `nbNpcFor` is asked for the
           * BASE band with every `nbNpcByFloor` override stepped around, which
           * is what a row with no `floors` states. One spec is only ever checked
           * this way: the Undermost overrides all three of its floors, so its
           * base row (`reknor-escape:50`) never reaches a floor the game builds.
           * The row is kept and checked because the escort's fourth floor makes
           * it live, and its own comment says so.
           */
          checked += 1;
          expect(
            nbNpcFor(spec, 0, undefined),
            `${id}: the base band is not the one ${row.cite} states`,
          ).toEqual(row.nbNpc);
          continue;
        }
        for (const floor of floors) {
          checked += 1;
          expect(
            nbNpcFor(spec, floor, undefined),
            `${id} floor ${String(floor)}: the placer does not use the band ${row.cite} states`,
          ).toEqual(row.nbNpc);
        }
      }
    }
    expect(checked, 'no source was checked against the placer').toBeGreaterThan(delves.length);
  });

  it('reads every part of a row off ONE zone file', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE LAUNDERING HOLE: A COUNT FROM ONE ZONE BEHIND ANOTHER ZONE'S BAND.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Nothing tied `cite` to `bandCite`, and a mutation audit walked straight
     * through the gap: the Hollow Mine's count moved to
     * `data/zones/reknor-escape/zone.lua:50` — a `{1, 5}` zone — with the band
     * left on the Maze's `{7, 16}`. EVERY CASE IN THIS FILE AND BOTH CITATION
     * GATES STAYED GREEN. `reknor-escape:50` really does state `{50, 60}`, so
     * the count case passed; `maze:137` really does state `{7, 16}`, so the band
     * case passed; `{7, 16}` really does cover nine, so `Covers` passed from
     * both sides. The row was a true sentence about two different rooms.
     *
     * The rule this file exists for is *a count is legal at level L iff some
     * upstream zone CARRYING THAT COUNT has a band covering L* — one zone, both
     * halves. So all four citations on a row must name the same file.
     *
     * NOT IN THE `reference/` BLOCK: it needs no Lua, only the strings, so it
     * runs in a clone and in CI where the reference tree is absent.
     */
    let checked = 0;
    for (const { id, row } of rows) {
      const home = parseCite(row.cite).path;
      expect(parseCite(row.bandCite).path, `${id}: ${row.cite} is banded by another zone`).toBe(
        home,
      );
      expect(
        parseCite(row.floorCite).path,
        `${id}: ${row.cite} takes its floor size from another zone`,
      ).toBe(home);
      if (row.maxOodCite !== undefined) {
        expect(
          parseCite(row.maxOodCite).path,
          `${id}: ${row.cite} takes its filter from another zone`,
        ).toBe(home);
      }
      checked += 1;
    }
    expect(checked, 'no row was checked').toBeGreaterThan(delves.length);
  });

  it('stays inside the ground ToME itself carries a count across', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THE RETIRED SIZE CLAUSE WAS RIGHT ABOUT, KEPT AS A BOUND.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A count is a number of bodies and not a density — `content/delve.ts`'s
     * note has the evidence — so the source's floor is NOT required to be ours.
     * But a count taken onto ground wildly unlike the ground it was written for
     * is not inheriting a decision either, and upstream says how far that can be
     * pushed, because it pushes it itself:
     *
     *   x0.09  `data/zones/orc-breeding-pit/zone.lua:83` — a 15x15 floor with
     *          `min_floor=120`, inheriting the 50x50 table's `{40, 50}` (`:47`).
     *   x2.72  `data/zones/noxious-caldera/zone.lua:68` — a 70x70 floor
     *          restating `{40, 40}` (`:81`) where the zone's other floor is
     *          150x12 (`:41`) with the identical `{40, 40}` (`:54`).
     *
     * So the bound is OUR cells over the SOURCE's cells, inside [0.09, 2.72].
     *
     * IT IS A LOOSE BOUND AND THE DOCBLOCK SAYS SO rather than pretending. Thirty
     * times is what ToME's own range is, and a tighter number would be ours
     * again — which is the mistake this replaces. What it does catch is a row
     * that took a count from a room of a different order of size, and the tight
     * statement is the citation cases below: every number on a row is the line it
     * names.
     */
    const LOOSEST_UPSTREAM_SHRINK = 225 / 2500;
    const LOOSEST_UPSTREAM_GROWTH = 4900 / 1800;
    let checked = 0;
    for (const { id, spec } of delves) {
      // The Infinite Dungeon computes its count from the floor's own area
      // (`nbNpcPerArea`), so the ground is IN the number and a ratio against a
      // fixed source floor is not a statement about anything.
      if (spec.nbNpcPerArea !== undefined) continue;
      // EVERY FLOOR, through the row that claims it — the same walk `nbNpcFor`
      // makes, so a per-floor source is measured on its own floors.
      for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
        const row =
          spec.countFrom.find((r) => r.floors?.includes(floor) === true) ??
          spec.countFrom.find((r) => r.floors === undefined);
        expect(row, `${id} floor ${String(floor)} is claimed by no row`).toBeDefined();
        if (row === undefined) continue;
        const ours = cellsOfFloor(id, floor);
        if (ours === undefined) continue;
        checked += 1;
        const source = row.floor[0] * row.floor[1];
        const ratio = ours / source;
        expect(
          ratio,
          `${id} floor ${String(floor)}: ${String(ours)} cells against ${row.cite}'s ` +
            `${String(source)} is x${ratio.toFixed(2)} — outside anything ToME carries a count across`,
        ).toBeGreaterThanOrEqual(LOOSEST_UPSTREAM_SHRINK);
        expect(ratio, `${id} floor ${String(floor)}: x${ratio.toFixed(2)}`).toBeLessThanOrEqual(
          LOOSEST_UPSTREAM_GROWTH,
        );
      }
    }
    expect(checked, 'no floor was measured against its source').toBeGreaterThan(delves.length);
  });

  it('takes its out-of-depth filter from the same source as its count', () => {
    /**
     * `filters` sits inside `generator.actor` beside `nb_npc`
     * (`engine/Zone.lua:306` is what reads it), so it is half of the same
     * answer and cannot be inherited from somewhere else. Two things are pinned:
     * the rows agree with each other, and `spec.maxOod` — the field the placer
     * reads — is what they say.
     *
     * THIS IS WHAT CAUGHT THE TWINS. `redactedSpec` used to copy `spec.maxOod`
     * from the original, so a twin sourcing its count from a `{7, 16}` zone that
     * passes no filter would have carried its original's tier-1 `max_ood = 2`
     * four levels deeper.
     */
    for (const { id, spec } of delves) {
      const [first, ...rest] = spec.countFrom;
      if (first === undefined) continue;
      for (const row of rest) {
        expect(row.maxOod, `${id}: its sources disagree about the out-of-depth filter`).toBe(
          first.maxOod,
        );
      }
      expect(spec.maxOod, `${id}: the placer's filter is not the one its source states`).toBe(
        first.maxOod,
      );
      // A citation exactly when there is something to cite.
      for (const row of spec.countFrom) {
        expect(
          row.maxOodCite === undefined,
          `${id}: ${row.cite} states a filter and does not say where`,
        ).toBe(row.maxOod === undefined);
      }
    }
  });
});

describe('the band a delve stands on covers the level it stands at', () => {
  it('judges every row from both sides, so a label cannot outlive its cause', () => {
    for (const { id, spec, row } of rows) {
      const level = delveLevel(spec);
      const covers = row.band[0] <= level && level <= row.band[1];
      const at = `${id} at level ${String(level)}, ${row.cite} states ${row.band.join('-')}`;

      if (row.fit === CountFit.Covers) {
        expect(covers, `${at} — marked Covers and does not cover`).toBe(true);
        continue;
      }
      if (row.fit === CountFit.Clamped) {
        /**
         * ONE STEP, AND THE TEST REFUSES TWO. `Clamped` is the label for
         * upstream's own gap at level six — the bands run `{1, 5}` then
         * `{7, 16}` — and it says the count is what `engine/Zone.lua:141-148`'s
         * clamp hands a character standing one level outside. At two levels out
         * that argument is gone and there is a legal source to be had, so the
         * label has to be refused rather than stretched.
         */
        expect(covers, `${at} — marked Clamped and the band covers it`).toBe(false);
        const out = level < row.band[0] ? row.band[0] - level : level - row.band[1];
        expect(out, `${at} — marked Clamped and is ${String(out)} levels out, not one`).toBe(1);
        continue;
      }
      if (row.fit === CountFit.Unaligned) {
        expect(covers, `${at} — marked Unaligned and the band COVERS it: take the label off`).toBe(
          false,
        );
        continue;
      }
      /**
       * `PlayerScheme` is the Infinite Dungeon and only it: `level_range =
       * {1, 1}` with `level_scheme = "player"` and an unbounded `max_level`, so
       * its bodies take their level from the floor number and its count from the
       * floor's area. The label is tied to the mechanism that earns it — a spec
       * without `nbNpcPerArea` has a real band and has to be judged against it.
       */
      expect(
        spec.nbNpcPerArea,
        `${at} — marked PlayerScheme and does not scale its count with the floor`,
      ).toBeDefined();
    }
  });

  it('is aligned everywhere but the two places that are argued at the site', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CENSUS, SO THAT A NEW EXCEPTION IS A DELIBERATE ACT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The case above judges each label honestly and would happily pass a table
     * where every delve was marked `Unaligned`. This is the other half: how many
     * of each there may be, and which delves they are.
     *
     *   CLAMPED, two — Cairnfoot and The Weir, the only rooms standing at level
     *     six, which is the only level from one to fifteen that no ToME zone
     *     generating a population has a band covering. The reference case below
     *     proves that gap against the Lua rather than taking this comment's
     *     word for it.
     *   UNALIGNED, NONE. The Glass Archive and its twin carried it: a 30x30
     *     tier-1 layout standing at eleven, refused a 50x50 count on the ground
     *     that it would be denser than anything upstream builds. The density
     *     clause behind that refusal was OURS, and
     *     `data/zones/orc-breeding-pit/zone.lua:83` refutes it — a 15x15 floor,
     *     `min_floor=120`, inheriting `{40, 50}`. So the Archive took
     *     `data/zones/halfling-ruins/zone.lua:50` at `{10, 25}` and the label
     *     came off by itself. THE ZERO IS ASSERTED ON PURPOSE: `Unaligned` is
     *     the one label with no upstream fact behind it, only an argument, and a
     *     table that can reach for it without going red has a place to put rooms
     *     nobody wants to think about.
     *   PLAYER-SCHEME, eight — the Infinity Tower itself, Gearford Ward, its
     *     twin and the five redacted towns. All of them are the Infinite
     *     Dungeon, which has no band: `level_range = {1, 1}` with
     *     `level_scheme = "player"` and `max_level = 1000000000`
     *     (`data/zones/infinite-dungeon/zone.lua:25-27`). The seven that are
     *     not the Tower borrow its `enemy_count` formula for a floor built as
     *     one of its layouts; the Tower IS the zone.
     *
     * Everything else is `Covers`: twenty-two of twenty-eight delves carrying a
     * count ToME states for a character standing at exactly their level.
     */
    const by = (fit: string): readonly string[] =>
      [...new Set(rows.filter((r) => r.row.fit === fit).map((r) => r.id))].sort();

    expect(by(CountFit.Clamped)).toEqual(['site:cairnfoot', 'site:the_weir']);
    expect(by(CountFit.Unaligned)).toEqual([]);
    expect(by(CountFit.PlayerScheme)).toEqual([
      'site:gearford_ward',
      'site:infinity_tower',
      'site:redaction:alderbrook',
      'site:redaction:ashwick_row',
      'site:redaction:gearford_ward',
      'site:redaction:saints_rest',
      'site:redaction:threadneedle_row',
      'site:redaction:wayfarers_camp',
    ]);

    const excepted = new Set([
      ...by(CountFit.Clamped),
      ...by(CountFit.Unaligned),
      ...by(CountFit.PlayerScheme),
    ]);
    const aligned = delves.filter((d) => d.spec.countFrom.every((r) => r.fit === CountFit.Covers));
    expect(aligned.length, 'delves whose every count is one upstream states at their level').toBe(
      delves.length - excepted.size,
    );
    /**
     * AND THE SHARE, COUNTED AGAINST THE DELVES THAT HAVE A BAND AT ALL. Seven
     * of the twenty-eight are the Infinite Dungeon, which states no band for
     * anybody, so counting them as unaligned would make the figure a statement
     * about how many redacted towns there are. Of the twenty-one that do carry a
     * band, nineteen are aligned outright and two are the one argument above.
     */
    const banded = delves.filter((d) =>
      d.spec.countFrom.every((r) => r.fit !== CountFit.PlayerScheme),
    );
    expect(
      aligned.length * 4,
      'less than three quarters of the banded map is aligned',
    ).toBeGreaterThan(banded.length * 3);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE ALIGNMENT DOES TO WHO IS ELIGIBLE, FLOOR BY FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `level_range` gates two things upstream, not one: how many bodies (`nb_npc`)
 * and WHICH bodies — `computeRarities` makes an under-depth candidate rare and
 * `max_ood` refuses it outright (`engine/Zone.lua:214`, `:306`). Re-sourcing the
 * count moves the filter with it, so it moves the roster too, and the honest
 * thing is to measure that rather than reason about it.
 *
 * MEASURED, every floor of all twenty-eight sites: exactly ONE delve in the game
 * has a floor whose eligible set is smaller than its own roster, and it is
 * Barrow End.
 *
 *   BARROW END loses `INDEX_HUSK_ELITE`. Its count came from the Old Forest,
 *     `{7, 16}`, which passes no filter; it comes from Norgos' Lair, `{1, 5}`,
 *     which filters at 2 like every tier-1 zone in ToME. At level five
 *     `5 + 2 < 15` and the elite is refused on every floor, where it used to be
 *     three tenths of one percent of the draw.
 *   BARROW END'S TWIN GAINS IT. The twin stands at nine, a `{1, 5}` band does
 *     not reach that, and it re-sources from Daikara — which passes no filter.
 *     So the elite is eligible there from the first floor, and the pair is the
 *     filter's whole effect on the game stated from both sides.
 *
 * THE GLASS ARCHIVE WAS THE OTHER ONE AND IS NOT ANY MORE, which is a LOSS and
 * is recorded as one. It stood at eleven with the Caves' `max_ood = 2` and
 * refused the elite on floors 1-2 while admitting it from floor 3 — THE ONLY
 * PLACE IN EITHER MAP WHERE A FLOOR'S ROSTER CHANGED AS YOU DESCENDED. Its count
 * now comes from `{10, 25}`, which filters at nothing, so the elite is drawn
 * there from floor one and that one escalation is gone. It is not this file's to
 * restore: see the note below on `monsters.ts`.
 *
 * THAT IS THE WHOLE LIST, and it has a shape: the out-of-depth refusal is a
 * TIER-1 device in ToME (every `{1, 5}` zone carries `max_ood = 2`, nothing at
 * `{7, 16}`, `{10, 25}` or `{15, 25}` carries one), so aligning the counts put
 * the protection on the beginner rooms and took it off the deep ones. Upstream's
 * own rule, arrived at by following the citations.
 *
 * ═══ AND THE REST OF THE MAP DOES NOT MOVE, WHICH IS A FACT ABOUT `monsters.ts`
 * RATHER THAN ABOUT THIS FILE ═══
 * Ten of the eleven bestiary templates are `levelRange` `[1, undefined]`, so
 * `Zone.lua:218`'s under-depth division can only ever fire on
 * `INDEX_HUSK_ELITE` and `:219`'s over-depth division only on `INDEX_HUSK`
 * above sixteen. The rarity gate has almost nothing to gate. Making floors
 * escalate is an authoring problem in `content/monsters.ts` — `rarity` and
 * `levelRange` bands on the bestiary — and no amount of alignment reaches it.
 */
describe('who is eligible, floor by floor', () => {
  /**
   * `populateDelve`'s OWN answer, imported rather than rebuilt.
   *
   * ═══ THIS USED TO BE A SECOND COPY OF THE PLACER'S TWO LINES ═══
   * It recomputed `delveLevel(spec) + floor - 1` and rebuilt the `max_ood`
   * predicate, and a mutation audit measured what that cost: dropping
   * `+ floor - 1` from `populateDelve`, and switching the filter off in
   * `populateDelve`, BOTH LEFT THIS WHOLE FILE GREEN. Every census below was a
   * statement about the copy. `eligibleOn` is exported from `content/delve.ts`
   * now and the placer calls the same one.
   */
  function eligible(spec: DelveSpec, floor: number): readonly string[] {
    return rarityShare(eligibleOn(spec, floor))
      .map(({ e }) => e.id)
      .sort();
  }

  it('never empties a floor`s candidate list', () => {
    /**
     * THE BOUND THAT MATTERS MOST AND IS EASIEST TO BREAK BY ACCIDENT. A filter
     * sourced from a shallower zone than the roster was written for refuses
     * everybody, and `populateDelve` then places nothing: an empty room with a
     * count of thirty. Asked of every floor of every site because that is where
     * a per-floor source or a twin's `+4` would land it.
     */
    for (const { id, spec } of delves) {
      for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
        expect(
          eligible(spec, floor).length,
          `${id} floor ${String(floor)}: the filter refuses its own whole roster`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('narrows two rooms in the game: Barrow End, and the top of the Tower', () => {
    /**
     * ═══ THE CENSUS, SO THAT A THIRD IS A DELIBERATE ACT ═══
     * `THICKET` and `DEEP` are the only rosters holding a template with a
     * `levelRange` floor above one (`INDEX_HUSK_ELITE`, fifteen), and Barrow End
     * is the only delve on the moor carrying either at a level low enough for a
     * tier-1 filter to bite AND sourcing its count from a zone that states one.
     * So the answer below is not a fixture of one id: it is what is left when
     * the one gate in the bestiary meets the filters that can close it.
     *
     * ═══ AND THE SECOND ONE NARROWS FOR THE OPPOSITE REASON ═══
     * The Infinity Tower's first floors stand at base level 1 and it filters at
     * `max_ood = 6` (`data/zones/infinite-dungeon/zone.lua:89`) — SIX, the
     * loosest filter in the game, on the one zone meant to hand you something
     * over your head. Six is still not fourteen: a level-15 elite is out of
     * depth on floor 1 of anything, so the Tower's shallow floors hold the rank
     * and file and nothing else, and the elites arrive as the floor number does.
     * That is upstream's own rule doing exactly what it is for, and it is the
     * only thing in this table that gets LOOSER as you walk — see
     * `test/server/tower.test.ts`, which asserts the roster never empties at
     * any depth.
     *
     * THE TITLE IS WHAT IS ASSERTED. This case used to be called "moves exactly
     * two rooms" while asserting which delves NARROW — it has no before and
     * cannot see a move. Narrowing is the thing it can measure and the thing it
     * measures.
     *
     * DRIVEN FROM THE ROSTERS, NOT LISTED: the delves whose eligible set on some
     * floor is smaller than their whole roster are computed, and THAT list is
     * what is pinned.
     */
    const narrowed = delves
      .filter(({ spec }) => {
        const whole = spec.roster.filter(
          (t) => t.rarity !== undefined && t.levelRange !== undefined,
        ).length;
        for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
          if (eligible(spec, floor).length < whole) return true;
        }
        return false;
      })
      .map(({ id }) => id)
      .sort();

    expect(narrowed).toEqual(['site:barrow_end', 'site:infinity_tower']);

    /**
     * AND IT IS READ FROM BOTH SIDES, because "one delve narrows" is only half a
     * statement: the case would pass just as well if the elite were absent
     * everywhere. The twin is the control — the same roster, the same rooms,
     * four levels up, sourcing from Daikara, which states no filter.
     *
     * A THIRD SPEC CARRIES THE FILTER AND IS INERT, and that is asserted too:
     * The Weir takes Murgol Lair's `max_ood = 2` at level six and `WEIR` holds
     * nothing with a `levelRange` floor above one, so the filter refuses nobody.
     * Without that line a table where the filter did nothing ANYWHERE would
     * still satisfy the census above.
     */
    const barrow = specFor('site:barrow_end');
    const twin = specFor('site:redaction:barrow_end');
    const weir = specFor('site:the_weir');
    if (barrow === undefined || twin === undefined || weir === undefined) {
      throw new Error('a delve went missing');
    }
    const elite = 'index_husk_elite';
    expect(barrow.maxOod, 'Barrow End stopped carrying a filter').toBe(2);
    expect(twin.maxOod, 'the twin picked a filter up').toBeUndefined();
    expect(weir.maxOod, 'The Weir stopped carrying a filter').toBe(2);

    for (let floor = 1; floor <= floorsOf(barrow); floor += 1) {
      expect(
        eligible(barrow, floor),
        `Barrow End floor ${String(floor)} admits a level-15 body at level five`,
      ).not.toContain(elite);
      expect(
        eligible(twin, floor),
        `the redacted Barrow End floor ${String(floor)} refuses the elite its source allows`,
      ).toContain(elite);
    }

    // The inert one: a filter that refuses nothing, because nothing in this
    // roster has a floor it could be out of the depth of.
    const whole = weir.roster.filter(
      (t) => t.rarity !== undefined && t.levelRange !== undefined,
    ).length;
    for (let floor = 1; floor <= floorsOf(weir); floor += 1) {
      expect(
        eligible(weir, floor).length,
        `The Weir floor ${String(floor)}: its tier-1 filter refused somebody`,
      ).toBe(whole);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE ROWS ARE TRUE ABOUT ToME — read off `reference/`, where it is present.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `reference/t-engine4` is gitignored (CLAUDE.md non-negotiable 6), so a clone
 * and CI have no tree to check against and these cases skip — the same
 * accommodation `tools/check-citations.mjs` and `gridsets.test.ts` make. The
 * cases ABOVE run everywhere and are about our own table; these are about
 * upstream's, and they are the half no other tool in this repository performs.
 */
const ZONES = new URL('../../reference/t-engine4/game/modules/tome/data/zones/', import.meta.url);
const REFERENCE = new URL('../../reference/t-engine4/game/modules/tome/', import.meta.url);
const HAVE_REFERENCE = existsSync(ZONES);

/** The cited line of a cited file, 1-indexed, as `check:citations` counts them. */
function luaLine(cite: string): string {
  const { path, line } = parseCite(cite);
  const url = new URL(path, REFERENCE);
  if (!existsSync(url)) throw new Error(`${cite} names a file that is not in reference/`);
  const lines = readFileSync(url, 'utf8').split('\n');
  const text = lines[line - 1];
  if (text === undefined) throw new Error(`${cite} points past the end of the file`);
  return text;
}

describe('the sources are the Lua (reads reference/, skipped without it)', () => {
  it.skipIf(!HAVE_REFERENCE)('finds each `nb_npc` on the line its row cites', () => {
    for (const { id, row } of rows) {
      const text = luaLine(row.cite);
      expect(text, `${id}: ${row.cite} is not an nb_npc line`).toContain('nb_npc');
      const m = /nb_npc\s*=\s*\{\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/.exec(text);
      expect(m, `${id}: ${row.cite} does not state a pair: ${text.trim()}`).not.toBeNull();
      expect(
        [Number(m?.[1]), Number(m?.[2])],
        `${id}: ${row.cite} states a different count from the row`,
      ).toEqual([row.nbNpc[0], row.nbNpc[1]]);
    }
  });

  it.skipIf(!HAVE_REFERENCE)('finds each `level_range` on the line its row cites', () => {
    for (const { id, row } of rows) {
      const text = luaLine(row.bandCite);
      expect(text, `${id}: ${row.bandCite} is not a level_range line`).toContain('level_range');
      const m = /level_range\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(text);
      expect(m, `${id}: ${row.bandCite} does not state a band: ${text.trim()}`).not.toBeNull();
      expect(
        [Number(m?.[1]), Number(m?.[2])],
        `${id}: ${row.bandCite} states a different band from the row`,
      ).toEqual([row.band[0], row.band[1]]);
    }
  });

  it.skipIf(!HAVE_REFERENCE)('finds each floor size on the line its row cites', () => {
    /**
     * `CountSource.floor` is the ground the source's count was authored over,
     * and it is the whole of what is left of the retired size clause — so it has
     * to be the zone's own `width`/`height` and not a remembered one. Read off
     * the cited line the same way the count and the band are.
     */
    for (const { id, row } of rows) {
      const text = luaLine(row.floorCite);
      const m = /width\s*=\s*(\d+)\s*,\s*height\s*=\s*(\d+)/.exec(text);
      expect(m, `${id}: ${row.floorCite} states no size: ${text.trim()}`).not.toBeNull();
      expect(
        [Number(m?.[1]), Number(m?.[2])],
        `${id}: ${row.floorCite} states a different floor from the row`,
      ).toEqual([row.floor[0], row.floor[1]]);
    }
  });

  it.skipIf(!HAVE_REFERENCE)('states a filter exactly when the zone it cites states one', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * JUDGED FROM BOTH SIDES, BECAUSE ONE SIDE IS HOW A FILTER GOES MISSING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The `max_ood` case below asks "if you cite a filter, is it there" and
     * `continue`s on a row that cites none — so a row could DROP a filter its
     * source states and every case in this file stayed green. Measured with a
     * mutant: the Drowned Chapel's `maxOod: 2` and its citation removed, the
     * spec's `maxOod` removed with them, whole suite green and both citation
     * gates at exit 0. Behaviour cannot cover it either: of the delves carrying
     * a filter, only ONE has a roster the filter can refuse (see the census
     * above), so the other rows can lose it invisibly.
     *
     * ═══ WHERE `filters` LIVES, AND WHY THE WINDOW IS THE ACTOR BLOCK ═══
     * `engine/Zone.lua:306` reads `generator.actor.filters`, which sits in the
     * same table as `nb_npc` — `data/zones/murgol-lair/zone.lua:56` and `:57`,
     * `data/zones/reknor-escape/zone.lua:50` and `:51`. So the search starts at
     * the cited count and stops where that table closes, which is the first line
     * that is nothing but `},`. Never the whole file: `data/zones/maze/zone.lua`
     * carries a `filters` in a later table and reading it here would make the
     * Maze look filtered.
     */
    let stated = 0;
    let bare = 0;
    for (const { id, row } of rows) {
      const { path, line } = parseCite(row.cite);
      const lines = readFileSync(new URL(path, REFERENCE), 'utf8').split('\n');
      let own: number | undefined;
      for (let i = line; i < lines.length; i += 1) {
        const text = lines[i] ?? '';
        if (text.trim() === '},') break;
        const m = /max_ood\s*=\s*(\d+)/.exec(text);
        if (m?.[1] !== undefined) {
          own = Number(m[1]);
          break;
        }
      }
      /**
       * ═══ AND A `levels[n]` COUNT INHERITS THE BASE TABLE'S FILTER ═══
       * `engine/Zone.lua:833-843` deep-merges `levels[n]` over the zone's own
       * table, so an override that restates `nb_npc` and says nothing about
       * `filters` keeps the base table's. That is not hypothetical: the
       * Undermost's third floor cites `data/zones/reknor-escape/zone.lua:79`,
       * the `{0, 0}` inside `levels[3]`, whose actor block carries no filter
       * while the zone's own at `:51` does. The inherited value is the nearest
       * `max_ood` BEFORE the cited count — every zone in the tree writes its own
       * table above its `levels` block — and the row's `maxOodCite` has to name
       * that line, which the case above already opens and reads.
       */
      let inherited: number | undefined;
      if (own === undefined) {
        for (let i = line - 2; i >= 0; i -= 1) {
          const m = /max_ood\s*=\s*(\d+)/.exec(lines[i] ?? '');
          if (m?.[1] !== undefined) {
            inherited = Number(m[1]);
            break;
          }
        }
      }
      const found = own ?? inherited;
      if (found === undefined) bare += 1;
      else stated += 1;
      expect(
        row.maxOod,
        found === undefined
          ? `${id}: ${row.cite}'s zone states no max_ood and the row invents one`
          : `${id}: ${row.cite}'s zone states max_ood=${String(found)} and the row drops it`,
      ).toBe(found);
    }
    // Both halves have to be populated or the case is one-sided again.
    expect(stated, 'no row takes a filter from its source any more').toBeGreaterThan(0);
    expect(bare, 'every row takes a filter — the "invents one" half is vacuous').toBeGreaterThan(0);
  });

  it.skipIf(!HAVE_REFERENCE)('places no more bodies than ToME states at that level', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CEILING, PER DELVE, READ OFF THE LUA INSTEAD OF REMEMBERED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `monster-scaling.test.ts` carries a flat 80 — the largest `nb_npc` any
     * ToME zone states anywhere — which is a real bound and a loose one: it
     * permits `{70, 80}` on a level-one room, where upstream's whole spread at
     * `{1, 5}` tops out at `{50, 60}`. This is the same bound taken per level:
     * the most bodies any zone whose band covers THIS delve's level states.
     *
     * Scanned from the tree rather than listed, excluding `Static` maps (a
     * hand-drawn town's ten townsfolk say nothing about a generated floor) for
     * the same reason the level-six case does.
     */
    const bands: { lo: number; hi: number; most: number }[] = [];
    for (const dir of readdirSync(ZONES, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const url = new URL(`${dir.name}/zone.lua`, ZONES);
      if (!existsSync(url)) continue;
      const text = readFileSync(url, 'utf8');
      if (!/generator\.map\.(?!Static)\w+/.test(text)) continue;
      const counts = [...text.matchAll(/nb_npc\s*=\s*\{\s*\d+\s*,\s*(\d+)\s*\}/g)].map((m) =>
        Number(m[1]),
      );
      const most = Math.max(0, ...counts);
      if (most === 0) continue;
      for (const m of text.matchAll(/level_range\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)) {
        bands.push({ lo: Number(m[1]), hi: Number(m[2]), most });
      }
    }
    expect(bands.length, 'the scan found no bands at all').toBeGreaterThan(40);

    for (const { id, spec } of delves) {
      // The Infinite Dungeon's count is the floor's area and its band is `{1, 1}`
      // with an unbounded `max_level`; there is no "other zone at this level".
      if (spec.nbNpcPerArea !== undefined) continue;
      const level = delveLevel(spec);
      for (let floor = 1; floor <= floorsToWalk(spec); floor += 1) {
        const row =
          spec.countFrom.find((r) => r.floors?.includes(floor) === true) ??
          spec.countFrom.find((r) => r.floors === undefined);
        if (row === undefined) continue;
        /**
         * CLAMPED INTO THE ROW'S OWN BAND, which is `engine/Zone.lua:141-148`
         * doing what it does: `base_level = bound(plev, lo, hi)`. Cairnfoot and
         * The Weir stand at six and ToME has no band covering six, so a ceiling
         * read at six is a ceiling over an empty set. Read at five — the level
         * their clamp actually hands them — it is `{1, 5}`'s own top.
         */
        const at = Math.min(Math.max(level, row.band[0]), row.band[1]);
        const most = Math.max(
          0,
          ...bands.filter((b) => b.lo <= at && at <= b.hi).map((b) => b.most),
        );
        expect(most, `${id}: nothing upstream covers level ${String(at)}`).toBeGreaterThan(0);
        expect(
          nbNpcFor(spec, floor, undefined)[1],
          `${id} floor ${String(floor)} asks for more than ToME states anywhere at level ${String(at)}`,
        ).toBeLessThanOrEqual(most);
      }
    }
  });

  it.skipIf(!HAVE_REFERENCE)('finds each `max_ood` on the line its row cites', () => {
    /**
     * THE ONE THAT WOULD HAVE CAUGHT THE FOUR LINES THAT WERE EACH ONE LOW. The
     * old `maxOod` note in `delve.ts` cited four `filters` lines by guessing an
     * offset from `nb_npc`, and every one of them landed on the `nb_npc` line
     * instead. `check:citations` passed all four, because all four lines exist.
     */
    let checked = 0;
    for (const { id, row } of rows) {
      if (row.maxOodCite === undefined) continue;
      checked += 1;
      const text = luaLine(row.maxOodCite);
      const m = /max_ood\s*=\s*(\d+)/.exec(text);
      expect(m, `${id}: ${row.maxOodCite} states no max_ood: ${text.trim()}`).not.toBeNull();
      expect(Number(m?.[1]), `${id}: ${row.maxOodCite} states a different filter`).toBe(row.maxOod);
    }
    expect(checked, 'no delve cites a filter any more').toBeGreaterThan(0);
  });

  it.skipIf(!HAVE_REFERENCE)('confirms ToME has no rung at level six', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CLAIM `CountFit.Clamped` RESTS ON, CHECKED RATHER THAN ASSERTED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Cairnfoot and The Weir stand at six and take a band one step away. That is
     * only honest if there is genuinely nothing at six, so this scans every
     * `zone.lua` in the tree: a zone that GENERATES a floor and rolls a
     * population — an `nb_npc` with a map generator that is not `Static` — and
     * asks which levels its band covers.
     *
     * `Static` is the exclusion and it is not a convenience: `town-derth` is
     * `{1, 15}` with `nb_npc = {10, 10}` and would make every count in the game
     * legal at every level, but its map is a hand-drawn town
     * (`data/zones/town-derth/zone.lua:42`) and its ten bodies are townsfolk.
     *
     * AND THE SECOND EXCLUSION IS ITS EVIDENCE AND NOT ITS NAME. ToME ships a
     * developer zone at `level_range = {1, 50}`, reachable only from the debug
     * console, and a band spanning the whole game would make every count legal
     * at every level. It used to be skipped by `name = "TestZone!"` under a
     * comment claiming it was "tied to its evidence rather than to a name",
     * which it was not. Its evidence was there all along:
     * `data/zones/test/zone.lua:95` is `nb_npc = {0, 0}`. A ZONE THAT ROLLS
     * NOBODY says nothing about how many bodies a level gets, and that rule
     * drops the debug zone with three scripted rooms that state the same thing —
     * `data/zones/eidolon-plane/zone.lua:44`,
     * `data/zones/illusory-castle/zone.lua:49` and
     * `data/zones/last-hope-graveyard/zone.lua:55`. All four are NAMED below
     * rather than counted, so the exclusion cannot quietly grow and a reader can
     * see what it takes out.
     *
     * AND `nb_npc` IS MATCHED ANYWHERE ON A LINE, not only at its start:
     * `data/zones/thieves-tunnels/zone.lua:42` writes it inline after the
     * generator class and an anchored scan misses that zone entirely.
     *
     * FIVE AND SEVEN ARE ASSERTED TOO, so the case fails loudly if the scan
     * breaks rather than quietly reporting a gap everywhere.
     */
    const bands: { lo: number; hi: number; zone: string }[] = [];
    const rollsNobody: string[] = [];
    for (const dir of readdirSync(ZONES, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const url = new URL(`${dir.name}/zone.lua`, ZONES);
      if (!existsSync(url)) continue;
      const text = readFileSync(url, 'utf8');
      const counts = [...text.matchAll(/nb_npc\s*=\s*\{\s*\d+\s*,\s*(\d+)\s*\}/g)];
      if (counts.length === 0) continue;
      if (!/generator\.map\.(?!Static)\w+/.test(text)) continue;
      if (!counts.some((m) => Number(m[1]) > 0)) {
        rollsNobody.push(dir.name);
        continue;
      }
      for (const m of text.matchAll(/level_range\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)) {
        bands.push({ lo: Number(m[1]), hi: Number(m[2]), zone: dir.name });
      }
    }
    expect(rollsNobody.sort(), 'the zones this scan drops for rolling nobody have changed').toEqual(
      ['eidolon-plane', 'illusory-castle', 'last-hope-graveyard', 'test'],
    );
    const covering = (level: number): readonly string[] => [
      ...new Set(bands.filter((b) => b.lo <= level && level <= b.hi).map((b) => b.zone)),
    ];
    expect(bands.length, 'the scan found no generated zones at all').toBeGreaterThan(30);
    expect(
      covering(5).length,
      'nothing covers level five — the scan is broken',
    ).toBeGreaterThanOrEqual(3);
    expect(
      covering(7).length,
      'nothing covers level seven — the scan is broken',
    ).toBeGreaterThanOrEqual(3);
    expect(
      covering(6),
      'ToME authors a generated population at level six after all — CountFit.Clamped is no longer honest',
    ).toEqual([]);
  });

  it.skipIf(!HAVE_REFERENCE)(
    'confirms every zone that rolls a population is `player`-scheme',
    () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE PREMISE THE WHOLE DECISION RESTS ON, CHECKED AGAINST THE TREE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `content/delve.ts` argues that a `level_range` is a CLAMP on the player's
       * level rather than a statement about the content, and therefore that
       * "give each delve the band of the zone its count came from" is not even a
       * well-formed fix. That argument is only available while
       * `engine/Zone.lua:141-148`'s `if self.level_scheme == "player"` branch is
       * the one every one of those zones takes. If ToME ever shipped a
       * population-rolling zone on the FIXED scheme, its band really would be a
       * statement about a level and the reasoning would need re-reading.
       *
       * COUNTED, NOT SAMPLED: eighty-one zone files carry an `nb_npc`. The three
       * that are not `player`-scheme are two Sher'Tul fortresses whose count is
       * `{0, 0}` and a town, so none of them puts anybody on a generated floor —
       * which is why the claim is written as "every zone that ROLLS a population"
       * rather than "every zone that carries an `nb_npc`". Both halves are pinned,
       * so a zone moving between them fails here rather than quietly widening the
       * exception.
       */
      let rolling = 0;
      const exempt: string[] = [];
      for (const dir of readdirSync(ZONES, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const url = new URL(`${dir.name}/zone.lua`, ZONES);
        if (!existsSync(url)) continue;
        const text = readFileSync(url, 'utf8');
        // ANYWHERE ON THE LINE, NOT ONLY AT ITS START:
        // `data/zones/thieves-tunnels/zone.lua:42` writes `nb_npc` inline after
        // the generator class, and an anchored scan leaves that zone out of a
        // count this case states as a count.
        if (!/nb_npc\s*=/.test(text)) continue;
        const rolls = [...text.matchAll(/nb_npc\s*=\s*\{\s*\d+\s*,\s*(\d+)\s*\}/g)].some(
          (m) => Number(m[1]) > 0,
        );
        if (text.includes('level_scheme = "player"')) {
          if (rolls) rolling += 1;
          continue;
        }
        exempt.push(`${dir.name}${rolls ? ' (ROLLS BODIES)' : ''}`);
      }
      expect(rolling, 'the scan found no player-scheme zones with a count').toBeGreaterThan(50);
      expect(
        exempt.sort(),
        'a zone states a population outside the player scheme — re-read the argument on CountFit',
      ).toEqual([
        'shertul-fortress',
        'shertul-fortress-caldizar',
        'town-lumberjack-village (ROLLS BODIES)',
      ]);
    },
  );
});
