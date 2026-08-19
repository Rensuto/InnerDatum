import { describe, expect, it } from 'vitest';

import { tileIndex } from '../../src/shared/coords.ts';
import { REDACTION_SITE_ID, makeOverworld } from '../../src/shared/level.ts';
import { TileCode, isSafeGround, isWalkable } from '../../src/shared/protocol.ts';
import { makeRedaction } from '../../src/shared/redaction.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND MOOR — AND THE ONE PROPERTY THAT MAKES IT A PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Redaction is generated, and a generated map has a failure mode an
 * authored one does not: it can produce a destination nobody can walk to. Every
 * assertion below is a version of "you can get there from where you arrive",
 * because a marker behind a hole is worse than no marker at all — it is a
 * promise the map cannot keep, and the player spends twenty minutes learning
 * that rather than learning the game.
 *
 * These are properties, not fixtures. The threshold in `redaction.ts` is a
 * tuning knob and is expected to move; NONE of these numbers should have to be
 * edited when it does, except the one that is deliberately pinned and says so.
 */

/** Every walkable cell reachable from `from`, eight-way, as movement is. */
function reachFrom(tiles: readonly number[], w: number, h: number, from: number): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const i = queue.pop();
    if (i === undefined) break;
    const x = i % w;
    const y = (i - x) / w;
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
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen.has(j) || !isWalkable(tiles[j] ?? TileCode.WALL)) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return seen;
}

describe('the Redaction', () => {
  it('puts every one of its doors within walking distance of where you land', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WHOLE REASON THIS FILE EXISTS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `makeRedaction` picks the arrival and the surviving sites from the same
     * connected blob, so this cannot fail today. It is asserted anyway and it is
     * asserted FIRST, because the two halves of that guarantee are twenty lines
     * apart in a function somebody will one day edit for an unrelated reason —
     * and the symptom would be a player walking two hundred tiles toward a
     * marker they can see and never reach.
     */
    const map = makeRedaction();
    const spawn = map.spawns[0];
    expect(spawn).toBeDefined();
    if (spawn === undefined) return;

    const { w, h, tiles } = map.view;
    const reach = reachFrom(tiles, w, h, tileIndex(spawn.x, spawn.y, w));

    expect(map.sites.size).toBeGreaterThan(0);
    for (const [cell] of map.sites) {
      const [xs, ys] = cell.split(',');
      expect(reach.has(tileIndex(Number(xs), Number(ys), w))).toBe(true);
    }
  });

  it('is one crossable country and not a scatter of islands', () => {
    /**
     * A player who arrives and walks in a straight line should find country,
     * not a shoreline four tiles out. The blob the arrival sits in has to be
     * most of the map — the prototype measured 89.3% and the threshold was
     * chosen for exactly this — so a bound well under that value fails loudly
     * if a future tweak shatters the interior while still looking fine in a
     * screenshot.
     */
    const map = makeRedaction();
    const spawn = map.spawns[0];
    if (spawn === undefined) throw new Error('no arrival tile');

    const { w, h, tiles } = map.view;
    const walkable = tiles.filter((c) => isWalkable(c)).length;
    const reach = reachFrom(tiles, w, h, tileIndex(spawn.x, spawn.y, w));

    expect(reach.size / walkable).toBeGreaterThan(0.75);
  });

  it('takes out a sixth of the country and most of the road', () => {
    /**
     * THE TWO NUMBERS THAT ARE THE DESIGN, stated as bounds rather than as the
     * measurements themselves, so that tuning is allowed and gutting is not.
     *
     * The erasure has to be felt — a map with 3% missing is Alderbrook with
     * typos — and the ROAD has to go, which is the half that nearly shipped
     * wrong: at the first threshold that passed the crossability check, 89.8%
     * of the safe network survived, and the Redaction would have played as the
     * same country with holes in it. See `ROAD_BIAS`.
     */
    const base = makeOverworld();
    const map = makeRedaction();

    const walkableIn = (t: readonly number[]): number => t.filter((c) => isWalkable(c)).length;
    const roadIn = (t: readonly number[]): number =>
      t.filter((c) => isWalkable(c) && isSafeGround(c)).length;

    const groundLeft = walkableIn(map.view.tiles) / walkableIn(base.view.tiles);
    const roadLeft = roadIn(map.view.tiles) / roadIn(base.view.tiles);

    // A tenth gone at minimum, and never so much that the map stops being one.
    expect(groundLeft).toBeLessThan(0.9);
    expect(groundLeft).toBeGreaterThan(0.5);
    // AND THE ROAD IS THE POINT: fragments you find, not a network you travel.
    expect(roadLeft).toBeLessThan(0.4);
  });

  it('keeps the coastline, so the player recognises where they are', () => {
    /**
     * The silhouette is the entire premise. Water and the erased rim are skipped
     * by the transform, so the two maps must agree on every one of those cells —
     * and if they ever stop agreeing, this is a DIFFERENT CONTINENT wearing the
     * Redaction's name, which is the one failure nobody can see by looking at a
     * screenshot of it.
     */
    const base = makeOverworld();
    const map = makeRedaction();
    expect(map.view.w).toBe(base.view.w);
    expect(map.view.h).toBe(base.view.h);

    let checked = 0;
    for (let i = 0; i < base.view.tiles.length; i += 1) {
      const code = base.view.tiles[i];
      if (code !== TileCode.WATER && code !== TileCode.DEEPWATER) continue;
      checked += 1;
      expect(map.view.tiles[i]).toBe(code);
    }
    // The sea is most of the border; a transform that quietly stopped producing
    // one would make the loop above vacuous, and this is what says so.
    expect(checked).toBeGreaterThan(1_000);
  });

  it('does not contain its own front door', () => {
    /**
     * REGRESSION, AND IT WAS CAUGHT BY AN ASSERTION RATHER THAN BY PLAYING.
     *
     * The Redaction is entered through a site glyph on the Alderbrook rows, so
     * it is in `base.sites` alongside the towns — and the first version mirrored
     * it like any other, producing a door on the Redaction that led to the
     * Redaction. A map does not contain its own entrance.
     */
    const map = makeRedaction();
    for (const [, siteId] of map.sites) {
      expect(siteId).not.toBe(REDACTION_SITE_ID);
      expect(siteId.startsWith(`${REDACTION_SITE_ID}:`)).toBe(true);
    }
  });

  it('is the same map in every process', () => {
    // PURITY, ASSERTED. `shared/` may not roll dice, and this map is a hash of
    // its own coordinates precisely so the server and every client agree without
    // spending a position in a seeded stream. Two builds, cell for cell.
    const a = makeRedaction();
    const b = makeRedaction();
    expect(a.view.tiles).toEqual(b.view.tiles);
    expect(a.spawns).toEqual(b.spawns);
    expect([...a.sites]).toEqual([...b.sites]);
  });
});

describe('the door on the Alderbrook side', () => {
  it('costs the map it is drawn on nothing', () => {
    /**
     * PINNED ON PURPOSE, and the only fixture number in this file.
     *
     * Every site glyph in `ALDERBROOK_LEGEND` carries the TileCode of the
     * character it replaced, so adding a destination must never change the
     * shape of the ground. 9327 is the walkable count from before this door
     * existed; if a future glyph gets that wrong, the failure is a silent change
     * to a map players have already learned.
     */
    const base = makeOverworld();
    expect(base.view.tiles.filter((c) => isWalkable(c)).length).toBe(9_327);
  });

  it('is on the map, and is somewhere you had to go looking', () => {
    const base = makeOverworld();
    const door = [...base.sites].find(([, id]) => id === REDACTION_SITE_ID);
    expect(door).toBeDefined();
    if (door === undefined) return;

    const [xs, ys] = door[0].split(',');
    const x = Number(xs);
    const y = Number(ys);

    // NOT ON THE DOORSTEP. The entire difficulty gate on the far map is that
    // reaching this cell takes a while — see the note in `redactedSpec` on why
    // the floors over there are not softened for somebody who wandered in.
    const spawn = base.spawns[0];
    if (spawn === undefined) throw new Error('no spawn');
    expect(Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y))).toBeGreaterThan(60);

    // AND NOT BESIDE ANOTHER MARKER, which would make it one more destination
    // in a row of them rather than something found.
    for (const [cell, id] of base.sites) {
      if (id === REDACTION_SITE_ID) continue;
      const [ox, oy] = cell.split(',').map(Number);
      if (ox === undefined || oy === undefined) continue;
      expect(Math.max(Math.abs(ox - x), Math.abs(oy - y))).toBeGreaterThan(4);
    }
  });
});
