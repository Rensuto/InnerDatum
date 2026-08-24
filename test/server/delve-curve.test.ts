// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { delveLevel, specFor } from '../../src/server/content/delve.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { canWalk } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE WALK GETS LONGER AND THE ROOMS GET WORSE, IN THAT ORDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `content/delve.ts` authors a level per site and annotates each with a step
 * count in a comment. The gradient is the single most important tuning decision
 * on the map — it is what makes "walk further" mean "risk more" — and until this
 * existed NOTHING checked it. A content pass that gave a site near the start a
 * level-15 roster would break the opening of the game, and the only instrument
 * would be a friend dying in the first ten minutes.
 *
 * ═══ IT MEASURES THE MAP, NOT THE COMMENTS ═══
 * The step counts beside the table were stale when this was written, and not by
 * rounding: they put `outer_index` nearer than `glass_archive` and `gearford_ward`
 * nearer than `blackwood_outskirts`, and a walked path says the opposite of both.
 * Blackwood's own note called it "the furthest walk on the moor" while Gearford
 * is three steps further. So the numbers here come from `findPath` over the
 * authored overworld, which is the same ground a player crosses.
 *
 * `makeOverworld()` takes NO SEED — Alderbrook is authored, not generated — so
 * these distances are facts about the shipped map rather than a property of one
 * roll.
 *
 * ═══ A TOLERANCE, BECAUSE A HAND-TUNED CURVE IS NOT A FUNCTION ═══
 * Two neighbouring sites may sit either way round by a level or two; that is
 * tuning, not a fault. What must not happen is a GROSS inversion — something
 * far harder much closer in. The gate is a distance band: sites more than
 * `NEARER_BY` steps apart must be ordered by level.
 */
const NEARER_BY = 20;

type Site = {
  readonly id: string;
  readonly steps: number;
  readonly level: number;
  /** Marked on the world map, or found only by walking into it. */
  readonly hidden: boolean;
  /** How much it pays. The hidden sites' reward axis — see `walkedSites`. */
  readonly litter: readonly [number, number];
};

function walkedSites(): readonly Site[] {
  const realms = createRealms({
    seed: 'curve-test',
    engineFor: (world) => createTurnEngine({ world }),
  });
  const over = realms.overworld;
  const level = over.world.level;
  const start = over.spawns[0];
  if (start === undefined) throw new Error('the overworld has no spawn');

  const out: Site[] = [];
  for (const [key, siteId] of over.sites) {
    const spec = specFor(siteId);
    // No spec means a town — nothing to fight, so nothing on this curve.
    if (spec === undefined) continue;
    const [xs, ys] = key.split(',');
    const path = findPath(start, { x: Number(xs), y: Number(ys) }, (x, y) => canWalk(level, x, y), {
      maxNodes: 400_000,
    });
    if (path === null) continue;
    out.push({
      id: siteId,
      steps: path.length,
      level: delveLevel(spec, { level: 1, size: 1 }),
      hidden: SITES.get(siteId)?.hidden === true,
      litter: spec.litter,
    });
  }
  return out;
}

describe('the difficulty gradient across the moor', () => {
  it('reaches every fightable site on foot', () => {
    /**
     * THE SETUP, ASSERTED FIRST. A site the pathfinder cannot reach is silently
     * dropped above, and a version of this file that reached two of eleven would
     * pass every assertion below by having almost no pairs to compare.
     */
    const sites = walkedSites();
    const fightable = [
      ...createRealms({
        seed: 'curve-test',
        engineFor: (world) => createTurnEngine({ world }),
      }).overworld.sites.values(),
    ].filter((id) => specFor(id) !== undefined);

    expect(sites.length, 'no fightable site was reachable on foot').toBeGreaterThan(0);
    expect(sites.length, 'some fightable site cannot be walked to at all').toBe(fightable.length);
  });

  it('never puts a much harder MARKED room much closer to the start', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HIDDEN THREE ARE DELIBERATELY OFF THIS CURVE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `HIDDEN_SITES` are placed "as far from any existing marker as this map
     * allows" — a placement rule about SECRECY, not about difficulty — and the
     * table beside them says why their level does not follow the walk: *"a
     * secret that is also the hardest room in the game is a secret you can only
     * survive after you no longer need it, and one that is trivial is a
     * disappointment. They pay in LITTER instead."*
     *
     * The first run of this test found exactly that: The Weir, 71 steps out and
     * level 6, "nearer and harder" than nothing but flagged against Watcher's
     * Altar at 41 steps and level 7. Correct design, wrong test — so the
     * gradient is asserted over the rooms a player can SEE and plan a walk
     * around, and the hidden ones get their own contract in the test below.
     */
    const sites = walkedSites().filter((site) => !site.hidden);
    expect(sites.length, 'every site on the map is hidden — the filter is wrong').toBeGreaterThan(
      4,
    );

    const faults: string[] = [];
    for (const near of sites) {
      for (const far of sites) {
        if (near.steps + NEARER_BY > far.steps) continue;
        if (near.level <= far.level) continue;
        faults.push(
          `${near.id} (${String(near.steps)} steps, level ${String(near.level)}) is nearer than ` +
            `${far.id} (${String(far.steps)} steps, level ${String(far.level)}) and harder`,
        );
      }
    }

    expect(faults, faults.join('; ')).toEqual([]);
  });

  it('pays the hidden three in loot rather than in level', () => {
    /**
     * The other half of the exclusion above, so it is a CONTRACT and not a
     * loophole. A hidden site that was both off the level curve AND no better
     * paid would be a long walk for nothing, and the exemption would be hiding
     * a tuning hole rather than describing a design.
     */
    const sites = walkedSites();
    const hidden = sites.filter((site) => site.hidden);
    const marked = sites.filter((site) => !site.hidden);
    expect(hidden.length, 'no hidden sites at all').toBeGreaterThan(0);

    for (const secret of hidden) {
      // Every MARKED room within twenty steps either way — the ones a player
      // would have chosen instead.
      const rivals = marked.filter((site) => Math.abs(site.steps - secret.steps) <= 20);
      if (rivals.length === 0) continue;
      const bestRival = Math.max(...rivals.map((site) => site.litter[1]));
      expect(
        secret.litter[1],
        `${secret.id} is hidden, off the level curve, and pays no better than the marked rooms beside it`,
      ).toBeGreaterThanOrEqual(bestRival);
    }
  });

  it('starts gently — the two nearest rooms are the two easiest', () => {
    /**
     * The part of the curve that decides whether anybody plays a second time.
     * A first walk out of Alderbrook has to be survivable by a level-1 body with
     * two talents, and the general tolerance above is far too loose to protect
     * the first twenty steps.
     */
    const sites = [...walkedSites()].sort((a, b) => a.steps - b.steps);
    const opening = sites.slice(0, 2);
    expect(opening.length, 'fewer than two rooms on the map').toBe(2);
    for (const site of opening) {
      expect(
        site.level,
        `${site.id} is ${String(site.steps)} steps out and level ${String(site.level)} — a beginner walks into it`,
      ).toBeLessThanOrEqual(3);
    }
  });
});
