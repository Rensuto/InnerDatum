// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import { ADJACENT_CAP, coldReading, perFoeAt } from '../../src/server/talents/cold_reading.ts';
import { gritAt, seenWorse } from '../../src/server/talents/seen_worse.ts';
import type { PassiveView } from '../../src/server/engine/hooks.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A PASSIVE THAT DEPENDS ON SOMETHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.passive` took a level and nothing else, so "+2 defence per adjacent
 * enemy" was not unwritten — it was UNTYPEABLE. All 24 passives were therefore
 * flat, and six of them were STRICTLY DOMINATED by another talent granting the
 * same stat on the same curve from the same point pool, which is a panel
 * offering 42 choices and containing at most 36.
 *
 * Two of those dominated talents are the ones converted here, and the point is
 * not that they are bigger. It is that they are a different SHAPE, which is what
 * makes them a choice rather than a worse option.
 */

function view(over: Partial<PassiveView>): PassiveView {
  return { ...EMPTY_PASSIVE_VIEW, ...over };
}

/** What a passive contributes to one mod, or 0 when it contributes nothing. */
function modOf(
  talent: typeof coldReading,
  level: number,
  v: PassiveView,
  key: 'def' | 'physResist',
): number {
  const block = talent.passive?.(level, v) ?? {};
  const mods = (block as { mods?: Record<string, number> }).mods ?? {};
  return mods[key] ?? 0;
}

describe('Cold Reading — defence for each of them', () => {
  it('is worth NOTHING alone, which a flat talent could never be', () => {
    /**
     * ═══ THE HALF THAT MAKES IT A CHOICE ═══
     * A conditional that still pays when its condition is false is a flat bonus
     * in a costume. The fold runs every turn precisely so "nothing" is an answer
     * it can give — and this is the assertion that would fail if somebody
     * quietly added a floor to make it feel better.
     */
    expect(modOf(coldReading, 3, view({ adjacentEnemies: () => 0 }), 'def')).toBe(0);
  });

  it('scales with how many of them there are', () => {
    const one = modOf(coldReading, 3, view({ adjacentEnemies: () => 1 }), 'def');
    const two = modOf(coldReading, 3, view({ adjacentEnemies: () => 2 }), 'def');
    expect(one, 'one enemy bought nothing').toBeGreaterThan(0);
    expect(two).toBe(one * 2);
    expect(one).toBe(perFoeAt(3));
  });

  it('stops paying past the cap, so being surrounded stays bad', () => {
    /**
     * Uncapped, this rewards standing in the middle of six husks — the exact
     * position the rest of the game teaches players to avoid. Upstream caps
     * Tactical Expert for the same reason.
     */
    const atCap = modOf(coldReading, 3, view({ adjacentEnemies: () => ADJACENT_CAP }), 'def');
    const swarmed = modOf(coldReading, 3, view({ adjacentEnemies: () => 12 }), 'def');
    expect(swarmed, 'the cap does not hold').toBe(atCap);
  });
});

describe('Seen Worse — truer the worse it gets', () => {
  it('is worth nothing at full health', () => {
    expect(modOf(seenWorse, 3, view({ hpFraction: () => 1 }), 'physResist')).toBe(0);
  });

  it('pays in proportion to what is missing', () => {
    const half = modOf(seenWorse, 3, view({ hpFraction: () => 0.5 }), 'physResist');
    const nearly = modOf(seenWorse, 3, view({ hpFraction: () => 0.1 }), 'physResist');
    expect(half).toBe(Math.round(gritAt(3) * 0.5));
    expect(nearly, 'a nearly-dead body is not better protected than a hurt one').toBeGreaterThan(
      half,
    );
  });

  it('reaches its full band only at death’s door', () => {
    expect(modOf(seenWorse, 3, view({ hpFraction: () => 0 }), 'physResist')).toBe(gritAt(3));
  });
});

describe('the empty view keeps every old caller working', () => {
  it('gives a conditional talent its floor rather than throwing', () => {
    /**
     * Dozens of fixtures call `passive(3)` with no second argument, and dozens of
     * talents ignore it. `EMPTY_PASSIVE_VIEW` is what makes both fine: an empty
     * board, full health, nothing sustained. A conditional evaluated against it
     * contributes its floor — which for both of these is nothing.
     */
    expect(modOf(coldReading, 3, EMPTY_PASSIVE_VIEW, 'def')).toBe(0);
    expect(modOf(seenWorse, 3, EMPTY_PASSIVE_VIEW, 'physResist')).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AND THE FOLD ACTUALLY RERUNS. Read off the source, because it is wiring.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tests above prove the FUNCTIONS are conditional. They would all pass just
 * as well if the fold still ran only when a point was spent — and then every
 * one of these talents would be frozen at whatever the board looked like at
 * level-up, while LOOKING live, which is worse than being obviously flat.
 *
 * This is the same category as `budgetPenalty`, which had zero production
 * callers while a Slowed player moved exactly as far as an unslowed one.
 */
const MAIN = readFileSync(new URL('../../src/server/main.ts', import.meta.url), 'utf8');

describe('the per-turn recompute is wired', () => {
  it('passes a refresh into the talent runtime', () => {
    expect(
      MAIN.includes('refreshPassives(id);'),
      'nothing refreshes the passives on a base turn any more',
    ).toBe(true);
  });

  it('hands the fold a view rather than only a level', () => {
    expect(
      MAIN.includes('contribute(talentLevelOf(sheet, talent), view)'),
      'the passive fold is not passing a PassiveView',
    ).toBe(true);
  });

  it('defers the lookup, because the const is declared below the call', () => {
    /**
     * ═══ THIS ONE IS A REGRESSION GUARD WITH A SCAR ═══
     * Passing `refreshPassives` by name here is a temporal dead zone: it is a
     * `const` declared about a hundred lines further down, and `engineFor` runs
     * during `buildServer`. The server refused to boot with "Cannot access
     * 'refreshPassives' before initialization", and three real-socket tests went
     * red with "the server never came up" — which is exactly the failure mode
     * that kind of test exists to catch.
     */
    const at = MAIN.indexOf('onActBase?: (actorId: string) => void');
    expect(at, 'the seam is gone').toBeGreaterThan(-1);
    expect(
      MAIN.includes('\n        refreshPassives,\n'),
      'refreshPassives is passed by name again — the server will not boot',
    ).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AND THE VIEW ASKS THE RIGHT QUESTION ABOUT WHO IS STANDING THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every test above builds its own `PassiveView` by hand, which is the only way
 * to test a passive's SHAPE — and it means the production view, the one in
 * `main.ts` that the folder actually hands these talents, has never been under
 * a test in this file or any other. Memory `test-the-join-not-the-halves`: the
 * halves were right and the join said this.
 *
 *     adjacentEnemies: () => neighbours().filter((o) => o.kind !== actor.kind)
 *     adjacentAllies:  () => neighbours().filter((o) => o.kind === actor.kind)
 *
 * `kind` is not a side. Both lines counted a SHOPKEEPER as an adjacent enemy
 * (`one_at_a_time.ts` refuses at `adjacentEnemies() !== 1`, so it switched
 * itself off at a counter) and a Redactor's own Bound shadow as one too, while
 * `riot_line.ts` and `known_face.ts` saw nobody beside her. `Faction.Squad`
 * makes it permanent rather than occasional: a companion follows, so it is
 * adjacent most turns of a floor.
 *
 * ═══ READ OFF THE SOURCE, AND THAT IS A STATED LIMIT ═══
 * The view is built inside `refreshPassives`, inside `buildServer`'s closure,
 * and the only way to drive it is to spawn a server
 * (`passives-wired.test.ts` does, over a real socket, for one number). A scrape
 * is what this file already does for the fold's wiring three tests up, it fails
 * the moment either line goes back to `kind`, and it is honest about being a
 * scrape. The RELATION itself is driven, exhaustively, in `faction.test.ts`.
 */
describe('the production PassiveView counts sides, not kinds', () => {
  it('asks `areEnemies` for the enemies and `sameSide` for the allies', () => {
    expect(
      MAIN.includes(
        'adjacentEnemies: () => neighbours().filter((o) => areEnemies(actor, o)).length',
      ),
      'adjacentEnemies is not asking areEnemies — a townsfolk or a companion counts as a foe',
    ).toBe(true);
    expect(
      MAIN.includes('adjacentAllies: () => neighbours().filter((o) => sameSide(actor, o)).length'),
      'adjacentAllies is not asking sameSide — a body your own party brought is not counted',
    ).toBe(true);
  });

  it('asks it for the nearest one too, which is a third copy of the same line', () => {
    expect(
      MAIN.includes('!areEnemies(actor, other)) continue;'),
      'nearestEnemyDistance is back to a kind comparison — cold_case.ts folds beside a friend',
    ).toBe(true);
  });
});
