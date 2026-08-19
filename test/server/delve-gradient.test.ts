import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord } from '../../src/server/content/delve.ts';
import { INDEX_CAIRN, INDEX_EIDOLON } from '../../src/server/content/monsters.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import { makeOverworld } from '../../src/shared/level.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FURTHER IS WORSE. IT USED TO BE THE OTHER WAY ROUND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DELVES` has always promised a difficulty gradient and called it *"the entire
 * reason a player picks one marker over another"*. It was real. It also pointed
 * the wrong way. Measured by eight-way BFS from the Alderbrook spawn:
 *
 *   The Drowned Chapel    17 steps   DEEP roster, a 95hp elite   "dangerous"
 *   Blackwood Outskirts  131 steps   the gentlest room in the game   "quiet"
 *
 * A player leaves Alderbrook, walks seventeen steps, finds the nearest marker on
 * the map, and it is one of the two hardest rooms in the game. Meanwhile the row
 * commented *"the near country: where a level-1 party learns the game"* sat on
 * the site that is a hundred and thirty-one steps away, the furthest thing on
 * the moor.
 *
 * WORSE THAN NO GRADIENT AT ALL. With no gradient a player learns nothing; with
 * an inverted one they learn something FALSE on their first evening — *the
 * markers near town are the dangerous ones* — and every decision after that is
 * built on it. `dangerWord` had been faithfully publishing that to the world map
 * since the day it was written.
 *
 * This file is the assertion that it cannot come back, and it computes the walk
 * rather than trusting a number written down beside it: move a site on the map
 * and this test re-measures and fails.
 */

const OVERWORLD = makeOverworld();

/** Steps from the Alderbrook spawn to every reachable cell. Eight-way, as movement is. */
function walkFromTown(): Map<number, number> {
  const { w, h, tiles } = OVERWORLD.view;
  const start = OVERWORLD.spawns[0];
  if (start === undefined) throw new Error('the overworld has no spawn');
  const dist = new Map<number, number>([[start.y * w + start.x, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift();
    if (at === undefined) break;
    const d = dist.get(at.y * w + at.x) ?? 0;
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
      const nx = at.x + dx;
      const ny = at.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = ny * w + nx;
      if (dist.has(i) || !isWalkable(tiles[i] ?? TileCode.WALL)) continue;
      dist.set(i, d + 1);
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

type Row = { readonly id: string; readonly steps: number; readonly weight: number };

/** Every delve, with how far the walk is and how bad the room is. */
function delvesByDistance(): readonly Row[] {
  const dist = walkFromTown();
  const { w } = OVERWORLD.view;
  const rows: Row[] = [];
  for (const [key, siteId] of OVERWORLD.sites) {
    const spec = DELVES.get(siteId);
    if (spec === undefined) continue;
    const [xs, ys] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const steps = dist.get(y * w + x);
    expect(steps, `${siteId} is not reachable on foot from town`).toBeDefined();
    // The same weight `dangerWord` bands, read back out of the word so this
    // test cannot drift from the thing the player actually reads.
    const weight = ['quiet', 'restless', 'dangerous', 'grim'].indexOf(dangerWord(spec));
    rows.push({ id: siteId, steps: steps ?? 0, weight });
  }
  rows.sort((a, b) => a.steps - b.steps);
  return rows;
}

describe('the map stops lying about which way danger lies', () => {
  it('never puts the worst room nearest the gate', () => {
    /**
     * THE REGRESSION, and the weakest form of it that still catches the bug:
     * whatever else is true, the nearest delve must not be in the top band and
     * the furthest must not be in the bottom one. Before the re-key both were.
     */
    const rows = delvesByDistance();
    expect(rows.length).toBeGreaterThan(4);

    const nearest = rows[0];
    const furthest = rows[rows.length - 1];
    expect(nearest?.weight).toBe(0);
    expect(furthest?.weight).toBe(3);
  });

  it('gets worse the further out you walk, band by band', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * BANDS, NOT A STRICT SORT, AND THAT IS A DESIGN DECISION RATHER THAN A
     * WEAKER ASSERTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `dangerWord` collapses two axes into one word — how MANY and how BAD —
     * so two rooms can be equally dangerous by being opposite: a horde of husks
     * and three things that bite. Demanding a strict sort would force every
     * mid-map room to be the same KIND of room, which is the texture a roguelike
     * is made of thrown away to make a number tidy.
     *
     * What a player perceives is near, middle and far, and those must not
     * overlap. Measured on the shipped map:
     *
     *   NEAR  (<=40 steps)   quiet, restless
     *   MID   (41-100)       restless, dangerous, restless, dangerous
     *   FAR   (>100)         grim, grim
     *
     * So the worst thing near town is never worse than the best thing far from
     * it, and inside a band the variety is the point.
     */
    const rows = delvesByDistance();
    const band = (steps: number): number => (steps <= 40 ? 0 : steps <= 100 ? 1 : 2);

    const worstOf = new Map<number, number>();
    const bestOf = new Map<number, number>();
    for (const row of rows) {
      const b = band(row.steps);
      worstOf.set(b, Math.max(worstOf.get(b) ?? -1, row.weight));
      bestOf.set(b, Math.min(bestOf.get(b) ?? 99, row.weight));
    }

    expect(worstOf.get(0)).toBeLessThan(bestOf.get(2) ?? 99);
    expect(worstOf.get(0)).toBeLessThanOrEqual(bestOf.get(1) ?? 99);
    expect(worstOf.get(1)).toBeLessThan(bestOf.get(2) ?? 99);
  });

  it('gives the two delves whose names promised something a roster to match', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * CHARACTER, NOT DEPTH — the other axis of what a delve is.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `RANK_AND_FILE` and `DEEP` answer "how far out is this", which after the
     * re-key is exactly what they should answer. `THICKET` and `DROWNED` answer
     * "what is this place", and they go to the two rooms whose names have
     * promised something the bestiary could not deliver: Blackwood, where
     * `places.ts` has said *"the trees start here"* since before there was
     * anything in them, and the Drowned Chapel.
     *
     * AUTHORED, NOT DERIVED, and the other way was measured first: reading the
     * ground off the site's own overworld cell classifies Blackwood Outskirts as
     * FEN, because the 9x9 around its marker holds fourteen water cells of the
     * northern coastline. The classifier is right about the country; a dungeon's
     * interior is not its doorstep.
     *
     * MEASURED with `tools/delve-run.mjs`, solo, 8 runs: Blackwood went from 142
     * turns at an 11% low-water mark to 115 at 8% — sharper rather than longer,
     * which is what the far end of the road should be — and the Drowned Chapel
     * went from 243 turns at 30% to 166 at 50%, which is what the first marker
     * anybody walks to should be.
     */
    const chapel = DELVES.get('site:drowned_chapel');
    const blackwood = DELVES.get('site:blackwood_outskirts');
    expect(chapel?.roster).toContain(INDEX_CAIRN);
    expect(blackwood?.roster).toContain(INDEX_EIDOLON);

    // AND THE CAIRN IS IN THE EASIEST ROOM ON PURPOSE. It is only dangerous
    // across water it cannot be reached over, and a delve has none — so here it
    // is a weak shooter you walk up to. Meeting it somewhere harmless is how you
    // learn what it does before meeting one on the far bank of a channel.
    expect(dangerWord(chapel as DelveSpec)).toBe('quiet');
  });

  it('still holds all eight rooms, unchanged', () => {
    /**
     * DATA ONLY — the re-key attached the same eight specs to different doors.
     * Same counts, same rosters, same litter, so the total content in the game
     * did not move and `test/shared/overworld.test.ts` is untouched by
     * construction. If this count changes, somebody added or dropped a room
     * while claiming to reorder them.
     */
    expect(DELVES.size).toBe(8);
    const words = [...DELVES.values()].map(dangerWord).sort();
    expect(words).toEqual([
      'dangerous',
      'dangerous',
      'grim',
      'grim',
      'quiet',
      'restless',
      'restless',
      'restless',
    ]);
  });
});
