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
import { TileCode } from '../../src/shared/protocol.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';

const SEEDS = Array.from({ length: 40 }, (_, i) => `realm:site:encounter:${i + 1}`);
const CENTRE = arenaCentre();

function tile(m: AuthoredMap, x: number, y: number): number | undefined {
  return m.view.tiles[y * m.view.w + x];
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
      if (tile(m, nx, ny) !== TileCode.FLOOR) continue;
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
    const open = m.view.tiles.filter((t) => t === TileCode.FLOOR).length;
    expect(open).toBeGreaterThan(0);
    expect(reachable(m).size).toBe(open);
  });
});

describe('every arena is sealed', () => {
  it.each(SEEDS)('%s has a solid border', (seed) => {
    const m = makeArena(seed);
    for (let x = 0; x < m.view.w; x += 1) {
      expect(tile(m, x, 0)).toBe(TileCode.WALL);
      expect(tile(m, x, m.view.h - 1)).toBe(TileCode.WALL);
    }
    for (let y = 0; y < m.view.h; y += 1) {
      expect(tile(m, 0, y)).toBe(TileCode.WALL);
      expect(tile(m, m.view.w - 1, y)).toBe(TileCode.WALL);
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
    // Restarting the walker at the centre fixed it. This asserts the OUTCOME,
    // because the next person tuning OPEN_FRACTION or the reset interval needs
    // to find out here rather than in play.
    const m = makeArena(seed);
    const octants = new Set<number>();
    for (let y = 0; y < m.view.h; y += 1) {
      for (let x = 0; x < m.view.w; x += 1) {
        const d = Math.max(Math.abs(x - CENTRE.x), Math.abs(y - CENTRE.y));
        if (d < 4 || d > 7) continue;
        if (tile(m, x, y) !== TileCode.FLOOR) continue;
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
    expect(tile(m, CENTRE.x, CENTRE.y)).toBe(TileCode.FLOOR);
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
