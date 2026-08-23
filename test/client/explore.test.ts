// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Game.lua:2064-2098 (`RUN_AUTO`)
// and class/interface/PlayerExplore.lua:1822+ (`autoExplore`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  EXPLORE_SIGHT,
  ExploreStop,
  exploreStopText,
  exploreTarget,
} from '../../src/client/input/explore.ts';
import type { ExploreView } from '../../src/client/input/explore.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MAP DRAWN AS A PICTURE, WHICH IS THE ONLY WAY THESE STAY READABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `#` wall   `.` floor, seen   `?` floor, unseen   `@` the player
 *   `i` floor, seen, with something on it
 *
 * Everything the rule needs comes off the same picture, so a test that changes
 * the map cannot forget to change the fixture beside it.
 */
function scene(rows: readonly string[], over: Partial<ExploreView> = {}): ExploreView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const seen = new Set<string>();
  const items: { x: number; y: number }[] = [];
  let from = { x: 0, y: 0 };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cell = rows[y]?.[x] ?? '#';
      if (cell === '@') from = { x, y };
      if (cell === 'i') items.push({ x, y });
      // `?` IS THE ONLY UNSEEN CELL. A wall the player has walked past IS seen —
      // that is what makes a frontier a frontier rather than every wall on the
      // map.
      if (cell !== '?') seen.add(`${String(x)},${String(y)}`);
    }
  }
  return {
    from,
    w,
    h,
    passable: (x, y) => (rows[y]?.[x] ?? '#') !== '#',
    seen,
    items,
    threat: null,
    ...over,
  };
}

describe('where to go next', () => {
  it('walks toward the edge of what has been seen', () => {
    /**
     * THE WHOLE FEATURE, IN ONE PICTURE. The corridor runs east into unseen
     * ground; the answer must be a tile you can STAND on that touches it, never
     * the unseen cell itself — which might be solid rock, since the map does not
     * say, which is the point of it being unseen.
     */
    const answer = exploreTarget(scene(['#######', '#@...??', '#######']));
    expect(answer.go).toBe(true);
    if (!answer.go) return;
    expect(answer.to).toEqual({ x: 4, y: 1 });
    expect(answer.item).toBe(false);
  });

  it('takes the nearest frontier when the map offers two', () => {
    /**
     * TWO PLACES LEFT TO GO: a pocket behind the wall at the top left, and the
     * corridor mouth in the south-east. The mouth is one step away and the
     * pocket is four, so the mouth wins.
     *
     * ═══ WHAT THIS DOES *NOT* PROVE, SAID PLAINLY ═══
     * It does not separate route-distance from line-distance. On a chebyshev
     * grid with eight-way movement those two are EQUAL unless something is in
     * the way, and they can only ever diverge in one direction — so a map that
     * showed a difference would need a contrived detour, and the test would end
     * up about the map rather than about the rule. What the flood buys is
     * cheapness (one pass, not one A* per candidate) and correctness around
     * obstructions; the walled-pocket case below is where the obstruction bites.
     */
    const answer = exploreTarget(
      scene([
        '#########',
        '#?#.....#',
        '#.#.....#',
        '#.......#',
        '#....@..#',
        '#......??',
        '#########',
      ]),
    );
    expect(answer.go).toBe(true);
    if (!answer.go) return;
    // The mouth, one step east — not the pocket four steps north-west.
    expect(answer.to).toEqual({ x: 6, y: 4 });
  });

  it('picks up something on the floor over a corner at the same distance', () => {
    /**
     * UPSTREAM'S GREED, AT ITS SIMPLEST (`PlayerExplore.lua:1856-1859`). At equal
     * distance a player would rather take the thing than round the corner, and
     * the corner is still there afterwards.
     */
    const answer = exploreTarget(scene(['#####', '#?.i#', '#.@.#', '#####']));
    expect(answer.go).toBe(true);
    if (!answer.go) return;
    expect(answer.item).toBe(true);
    expect(answer.to).toEqual({ x: 3, y: 1 });
  });

  it('never answers the tile the player is standing on', () => {
    /**
     * A player walks to the edge of the lit area constantly, so standing ON a
     * frontier tile is the ordinary case — and travel refuses a zero-length
     * route, which would read as the key being dead at exactly the moment it is
     * pressed most.
     */
    const answer = exploreTarget(scene(['#####', '#..?#', '#.@.#', '#####']));
    expect(answer.go).toBe(true);
    if (!answer.go) return;
    expect(answer.to).not.toEqual({ x: 2, y: 2 });
  });
});

describe('when it refuses', () => {
  it('stops for something hostile, and says which way', () => {
    // Upstream refuses with enemies in sight and NAMES them with a bearing
    // (Game.lua:2078-2079). A refusal that does not say what stopped it is an
    // alarm with no information in it.
    const answer = exploreTarget(
      scene(['#####', '#..?#', '#.@.#', '#####'], {
        threat: { name: 'Index Husk', dx: 2, dy: -1 },
      }),
    );
    expect(answer.go).toBe(false);
    if (answer.go) return;
    expect(answer.stop).toBe(ExploreStop.Hostile);
    expect(answer.threat?.name).toBe('Index Husk');
  });

  it('ignores a hostile too far away to have been seen', () => {
    /**
     * `projectActors` sends EVERY actor today — its own docblock calls that an
     * accepted leak — so a rule that refused for any hostile in the map would
     * make this key useless on a populated floor. The bound is what a body has
     * personally lit.
     */
    const far = exploreTarget(
      scene(['#####', '#..?#', '#.@.#', '#####'], {
        threat: { name: 'Index Husk', dx: EXPLORE_SIGHT + 1, dy: 0 },
      }),
    );
    expect(far.go).toBe(true);

    // ...and the boundary itself still stops it.
    const edge = exploreTarget(
      scene(['#####', '#..?#', '#.@.#', '#####'], {
        threat: { name: 'Index Husk', dx: EXPLORE_SIGHT, dy: 0 },
      }),
    );
    expect(edge.go).toBe(false);
  });

  it('says the floor is finished when every cell has been seen', () => {
    const answer = exploreTarget(scene(['#####', '#...#', '#.@.#', '#####']));
    expect(answer.go).toBe(false);
    if (answer.go) return;
    expect(answer.stop).toBe(ExploreStop.Done);
    expect(exploreStopText(answer.stop, 'here')).toBe('There is nowhere left to explore.');
  });

  it('says something DIFFERENT when the last corner is walled off', () => {
    /**
     * ═══ TWO REASONS, TWO SENTENCES ═══
     * Telling a player the floor is done when it is not would send them looking
     * for stairs that are not the answer. The unseen pocket here has no route to
     * it at all.
     *
     * AND THIS IS THE CASE AN EARLIER VERSION GOT WRONG. Deciding it from the
     * flood's own leftovers answered "no way through" for a player standing on
     * the frontier with the whole floor already mapped; the question is about
     * the MAP, and it is asked of the map.
     */
    const answer = exploreTarget(scene(['#####', '#?#.#', '#.#@#', '#####']));
    expect(answer.go).toBe(false);
    if (answer.go) return;
    expect(answer.stop).toBe(ExploreStop.Unreachable);
    expect(exploreStopText(answer.stop, 'here')).toContain('no way through');
  });

  it('does not claim the floor is done while something is still on it', () => {
    // Everything seen, nothing unexplored, and a coat on the floor two tiles
    // away. Upstream counts unvisited items as somewhere to go.
    const answer = exploreTarget(scene(['#####', '#..i#', '#.@.#', '#####']));
    expect(answer.go).toBe(true);
    if (!answer.go) return;
    expect(answer.item).toBe(true);
  });
});
