/**
 * The ambush arena — a generated room, so the properties are asserted rather
 * than eyeballed.
 *
 * An authored map can be read; a generator has to be trusted, and the only
 * honest basis for trusting one is a set of claims that hold over many seeds.
 * Every test here runs the whole batch rather than one lucky room.
 */

import { describe, expect, it } from 'vitest';

import { arenaCentre, makeArena } from '../../src/shared/arena.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import { Ground } from '../../src/shared/level.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';

const SEEDS = Array.from({ length: 40 }, (_, i) => `realm:site:encounter:${i + 1}`);
const CENTRE = arenaCentre();

/**
 * Off the map reads as WALL, which is what `tileAt` in shared/level.ts does and
 * what every caller here already meant. It returned `number | undefined` while
 * every assertion compared it to a code; now that they ask a PREDICATE instead,
 * the undefined has to land somewhere, and "outside the room is solid" is the
 * only answer that is not a lie.
 */
function tile(m: AuthoredMap, x: number, y: number): number {
  return m.view.tiles[y * m.view.w + x] ?? TileCode.WALL;
}

/** Eight-way, matching the movement rule the server enforces. */
function reachable(m: AuthoredMap): Set<string> {
  const seen = new Set([`${CENTRE.x},${CENTRE.y}`]);
  const stack = [CENTRE];
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined) break;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const nx = p.x + dx;
      const ny = p.y + dy;
      const k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= m.view.w || ny >= m.view.h || seen.has(k)) continue;
      if (!isWalkable(tile(m, nx, ny))) continue;
      seen.add(k);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe('every arena is one connected room', () => {
  it.each(SEEDS)('%s strands nothing', (seed) => {
    // The whole reason a walk was chosen over cellular automata: it opens only
    // cells it stood on, so connectivity is a property of the algorithm rather
    // than something a repair pass has to go and fix afterwards.
    const m = makeArena(seed);
    const open = m.view.tiles.filter((t) => isWalkable(t)).length;
    expect(open).toBeGreaterThan(0);
    expect(reachable(m).size).toBe(open);
  });
});

describe('every arena is sealed', () => {
  it.each(SEEDS)('%s has a solid border', (seed) => {
    const m = makeArena(seed);
    for (let x = 0; x < m.view.w; x += 1) {
      expect(isWalkable(tile(m, x, 0))).toBe(false);
      expect(isWalkable(tile(m, x, m.view.h - 1))).toBe(false);
    }
    for (let y = 0; y < m.view.h; y += 1) {
      expect(isWalkable(tile(m, 0, y))).toBe(false);
      expect(isWalkable(tile(m, m.view.w - 1, y))).toBe(false);
    }
  });
});

describe('you can be surrounded, which is what makes it an ambush', () => {
  it.each(SEEDS)('%s offers ambush ground on every side', (seed) => {
    // THE REGRESSION THIS EXISTS FOR. A plain drunkard's walk DRIFTS: the first
    // arenas hollowed out one corner and left the opposite third solid, with
    // the arrival tile on the EDGE of the open area. Monsters are placed in an
    // annulus 4-7 tiles out, so a room open on one side only means every
    // monster comes from that side — the thing that makes an ambush an ambush,
    // deleted by a property of the random walk rather than by any decision.
    //
    // Restarting the walker at the centre fixed it, and the forest that replaced
    // the walk has no drift to fix. This asserts the OUTCOME, because the next
    // person tuning a ground's zoom or sqrtPercent needs to find out here rather
    // than in play.
    const m = makeArena(seed);
    const octants = new Set<number>();
    for (let y = 0; y < m.view.h; y += 1) {
      for (let x = 0; x < m.view.w; x += 1) {
        const d = Math.max(Math.abs(x - CENTRE.x), Math.abs(y - CENTRE.y));
        if (d < 4 || d > 7) continue;
        if (!isWalkable(tile(m, x, y))) continue;
        octants.add(Math.round(Math.atan2(y - CENTRE.y, x - CENTRE.x) / (Math.PI / 4)));
      }
    }
    // atan2 rounds to 8 buckets but -4 and 4 are the same direction.
    const distinct = new Set([...octants].map((o) => (o === -4 ? 4 : o)));
    expect(distinct.size, `only ${distinct.size} directions have ambush ground`).toBe(8);
  });
});

describe('you arrive in the middle of it', () => {
  it.each(SEEDS)('%s spawns on open floor at the centre', (seed) => {
    // An ambush that surrounds you needs room on every side, which a corner
    // cannot give — this is the difference from the authored floor it replaced.
    const m = makeArena(seed);
    expect(m.spawns).toEqual([CENTRE]);
    expect(isWalkable(tile(m, CENTRE.x, CENTRE.y))).toBe(true);
  });
});

describe('an arena is a fight, not a place', () => {
  it('leads nowhere and is the same room for the same seed', () => {
    // Determinism is not decoration: a party re-entering its own realm must get
    // its own room back, and an ambush should be reproducible from the seed
    // that caused it.
    const a = makeArena('realm:site:encounter:7');
    const b = makeArena('realm:site:encounter:7');
    expect(a.view.tiles).toEqual(b.view.tiles);
    expect(a.sites.size).toBe(0);

    const other = makeArena('realm:site:encounter:8');
    expect(other.view.tiles).not.toEqual(a.view.tiles);
  });
});

describe('a room whose arrival is shut in', () => {
  it('is built again, as upstream rebuilds a cavern too small to use', () => {
    /**
     * These seeds' first build shut the arrival tile inside a ring of trees and
     * kept a room of one cell, found over 5000 seeds a ground. Upstream's
     * Cavern rebuilds a level whose open region is too small
     * (`Cavern.lua:100-109`), and so does this.
     */
    const sealed: readonly (readonly [Ground, number])[] = [
      [Ground.Wood, 1361],
      [Ground.Scree, 1579],
      [Ground.Walls, 456],
    ];
    for (const [ground, n] of sealed) {
      const m = makeArena(`realm:site:encounter:${String(n)}`, ground);
      const interior = (m.view.w - 2) * (m.view.h - 2);
      expect(reachable(m).size, `${ground} ${String(n)} kept the sealed room`).toBeGreaterThan(
        interior / 3,
      );
    }
  });
});

describe('each ground as open as the upstream zone it comes from', () => {
  it('keeps each ground inside the band upstream`s numbers give it', () => {
    /**
     * Measured over these forty seeds, as a share of the 22x22 interior a body
     * can stand on: OPEN (the Golem Graveyard) 92.9%, UPLAND (upstream's
     * ambush) 83.5%, SCREE (the Mark of the Spellblaze) 78.0%, WOOD
     * (Trollmire) 63.7%, WALLS (the Ring of Blood) 63.6%, and FEN (Slazish Fen,
     * less its channel) 62.2%. The walk this replaced gave 62%, 42%, 36%, 34%,
     * 46% and 42.5%.
     */
    const band: Readonly<Record<Ground, readonly [number, number]>> = {
      [Ground.Open]: [0.88, 0.97],
      [Ground.Upland]: [0.79, 0.88],
      [Ground.Scree]: [0.73, 0.83],
      [Ground.Wood]: [0.58, 0.69],
      [Ground.Walls]: [0.58, 0.69],
      [Ground.Fen]: [0.56, 0.68],
    };
    for (const ground of Object.values(Ground)) {
      let share = 0;
      for (const seed of SEEDS) {
        const m = makeArena(seed, ground);
        const interior = (m.view.w - 2) * (m.view.h - 2);
        share += m.view.tiles.filter((c) => isWalkable(c)).length / interior;
      }
      const mean = share / SEEDS.length;
      const [lo, hi] = band[ground];
      const said = `${ground} is ${(mean * 100).toFixed(1)}% open`;
      expect(mean, said).toBeGreaterThan(lo);
      expect(mean, said).toBeLessThan(hi);
    }
  });
});
