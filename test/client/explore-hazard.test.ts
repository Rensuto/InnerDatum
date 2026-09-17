// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/PlayerExplore.lua:1948-1971 (ground that takes air or does damage)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTO-EXPLORE KEEPS ITS FEET DRY WHILE IT CAN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's flood gives air-draining and damaging ground extra cost so that
 * "slow" terrain will be avoided if at all possible. Ours has no costs: it floods
 * once treating every hazard as a wall, and again through them only when that
 * found nothing.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ExploreStop, exploreTarget } from '../../src/client/input/explore.ts';
import type { ExploreView } from '../../src/client/input/explore.ts';

/** `@` the player, `?` unseen, `~` a hazard, `#` rock, anything else open and seen. */
function scene(rows: readonly string[], withHazard = true): ExploreView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const seen = new Set<string>();
  let from = { x: 0, y: 0 };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cell = rows[y]?.[x] ?? '#';
      if (cell === '@') from = { x, y };
      if (cell !== '?') seen.add(`${String(x)},${String(y)}`);
    }
  }
  const at = (x: number, y: number): string => rows[y]?.[x] ?? '#';
  return {
    from,
    w,
    h,
    passable: (x, y) => at(x, y) !== '#',
    ...(withHazard ? { hazard: (x: number, y: number) => at(x, y) === '~' } : {}),
    seen,
    items: [],
    threat: null,
  };
}

describe('exploreTarget and the ground that hurts', () => {
  // West, through one pond tile, a frontier two steps off. East, along a dry
  // corridor, a frontier four steps off.
  const FORK = ['#########', '?.~@....?', '#########'];

  it('takes the long dry way over the short wet one', () => {
    const answer = exploreTarget(scene(FORK));
    expect(answer).toEqual({ go: true, to: { x: 7, y: 1 }, item: false });
  });

  it('PRECONDITION: with no hazard question it takes the short way through the water', () => {
    const answer = exploreTarget(scene(FORK, false));
    expect(answer).toEqual({ go: true, to: { x: 1, y: 1 }, item: false });
  });

  it('goes through the water when nothing dry is left to explore', () => {
    const answer = exploreTarget(scene(['#######', '?.~@..#', '#######']));
    expect(answer).toEqual({ go: true, to: { x: 1, y: 1 }, item: false });
  });

  it('a frontier that is itself in the water is aimed at, once nothing dry is left', () => {
    const answer = exploreTarget(scene(['######', '?~@..#', '######']));
    expect(answer).toEqual({ go: true, to: { x: 1, y: 1 }, item: false });
  });

  it('still says the floor is finished, and still says when the rest is out of reach', () => {
    expect(exploreTarget(scene(['#####', '#~@.#', '#####']))).toEqual({
      go: false,
      stop: ExploreStop.Done,
    });
    expect(exploreTarget(scene(['#######', '?#~@..#', '#######']))).toEqual({
      go: false,
      stop: ExploreStop.Unreachable,
    });
  });

  it('main.ts hands the flood upstream`s slow ground', () => {
    // main.ts boots a canvas and cannot be imported; this reads the call.
    const src = readFileSync('src/client/main.ts', 'utf8');
    const call = src.slice(src.indexOf('const answer = exploreTarget({'));
    const view = call.slice(0, call.indexOf('});'));
    expect(view).toContain('hazard: (x, y) => exploreSlowAt(here, x, y),');
  });
});
