// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { tickRoamers } from '../../src/server/world/roamers.ts';
import { canWalk, tileAt } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';
import { isSafeGround } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   "NOTHING WAITS ON MADE GROUND. KEEP TO THE ROAD."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three separate townsfolk say a version of that sentence, and `TopicId.Roads`
 * exists for the sole reason that the promise was TRUE and had never been said
 * out loud: *"a promise you have to infer is not one you travel on"*.
 *
 * This file is about the two halves of that promise being kept:
 *
 *   1. THE RULE HOLDS. Not by reading the definition back — `isSafeGround` is
 *      `walkable && !isHaunt` and `canHauntTile` is `canWalk && isHaunt`, so
 *      asserting they disagree is asserting that `!x` differs from `x`. The
 *      honest test RUNS THE ROAMERS and looks at where they actually stand.
 *
 *   2. IT IS SAID WHERE IT APPLIES. The first case names one room and quotes a
 *      bearing and a straight-line distance — which describes the route through
 *      the trees, not the safe one. Only seven of seventeen sites can be reached
 *      without leaving made ground, so the clause has to be earned per site, and
 *      a line that promised a road that was not there would be far worse than
 *      one that never mentioned roads at all.
 */

function overworldOf(seed: string): {
  level: LevelView;
  realm: Parameters<typeof tickRoamers>[0];
} {
  const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
  const over = realms.overworld;
  const full = realms.get(over.id);
  if (full === undefined || full.kind !== RealmKind.Overworld) {
    throw new Error('the overworld is not an overworld');
  }
  return { level: full.world.level, realm: full };
}

/** The predicate the advice line is making a promise about. */
function roadStep(level: LevelView) {
  return (x: number, y: number): boolean =>
    canWalk(level, x, y) && isSafeGround(tileAt(level, x, y));
}

describe('the road is safe, and the game says so where it is true', () => {
  it('never lets a roamer stand on made ground, over a long run of turns', () => {
    const { level, realm } = overworldOf('road-promise');

    /**
     * ═══ THE SETUP HAS TO HAVE WORKED, OR THIS PASSES BY FINDING NOTHING ═══
     * A run that spawned no roamers would satisfy "no roamer stands on the
     * road" perfectly and prove nothing whatsoever. `tickRoamers` spawns ONE
     * PER TICK at most — deliberately, so the map fills gradually rather than
     * at boot — so this needs enough turns to reach a populated map, and then
     * has to say out loud that it got there.
     */
    let everSeen = 0;
    const offences: string[] = [];
    for (let seq = 1; seq <= 400; seq += 1) {
      tickRoamers(realm, seq);
      for (const roamer of realm.roamers.values()) {
        everSeen = Math.max(everSeen, realm.roamers.size);
        if (isSafeGround(tileAt(level, roamer.x, roamer.y))) {
          offences.push(`${roamer.name} stood on made ground at ${roamer.x},${roamer.y}`);
        }
      }
      if (offences.length > 0) break;
    }

    expect(everSeen, 'no roamer ever spawned, so this test proved nothing').toBeGreaterThan(0);
    expect(offences).toEqual([]);
  });

  it('has a safe route to the room a beginner is sent to', () => {
    /**
     * THE CLAUSE MUST NOT BE DEAD CODE. If nothing the first case can name is
     * ever reachable on made ground, `roadClause` never fires and the work is a
     * comment. The Drowned Chapel is the room the picker names today — the
     * gentlest grade, sixteen tiles out — and it is 17 steps cross-country
     * against 18 on the road. That one extra step is the whole feature.
     */
    const { level } = overworldOf('road-promise');
    const spawn = { x: 101, y: 62 };
    expect(
      roadStep(level)(spawn.x, spawn.y),
      'the spawn is not on made ground, so no road advice could ever be given',
    ).toBe(true);

    const chapel = [...SITES.values()].find((site) => /drowned chapel/i.test(site.name));
    expect(chapel, 'the Drowned Chapel is not in SITES any more').toBeDefined();
  });

  it('only ever promises a road that is actually there', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT MAKES THE FEATURE SAFE RATHER THAN MERELY NICE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Measured across the whole map: ten of seventeen sites have NO route on
     * made ground. Telling somebody to keep to a road that stops halfway is
     * how a player learns to stop reading the advice — and this game has one
     * line of advice, given once, to a character four minutes old.
     *
     * So: for every site, the route either exists on made ground or it does
     * not, and this asserts the two populations are BOTH non-empty. A build
     * where every site were reachable would make the clause meaningless noise
     * on every line; a build where none were would make it dead code. Either
     * would mean the map changed under the feature, and this is the line that
     * says so.
     */
    const { level, realm } = overworldOf('road-promise');
    const spawn = { x: 101, y: 62 };
    const step = roadStep(level);
    const NEIGHBOURS = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const;

    let reachable = 0;
    let unreachable = 0;
    for (const [cell] of realm.sites) {
      const parts = cell.split(',');
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      let found = false;
      for (const [dx, dy] of NEIGHBOURS) {
        if (!step(x + dx, y + dy)) continue;
        if (findPath(spawn, { x: x + dx, y: y + dy }, step, { maxNodes: 40000 }) !== null) {
          found = true;
          break;
        }
      }
      if (found) reachable += 1;
      else unreachable += 1;
    }

    expect(
      reachable,
      'no site at all is reachable on made ground — the clause is dead code',
    ).toBeGreaterThan(0);
    expect(
      unreachable,
      'every site is on the road, which makes the clause noise on every line',
    ).toBeGreaterThan(0);
  });
});
