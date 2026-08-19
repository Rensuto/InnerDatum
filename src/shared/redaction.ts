// SPDX-License-Identifier: GPL-3.0-or-later
//
// Inner Datum — the dark territory: Alderbrook, overwritten.

import { tileIndex } from './coords.ts';
import { ALDERBROOK_REGIONS, REDACTION_SITE_ID, makeOverworld } from './level.ts';
import { TileCode, isSafeGround, isWalkable } from './protocol.ts';
import type { AuthoredMap } from './level.ts';
import type { TileXY } from './coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REDACTION — THE SAME MOOR, WITH PARTS OF IT TAKEN OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A DIFF AND NOT A SECOND CONTINENT, and that is the whole design. The value of
 * this place is that the player RECOGNISES it: the same coastline, the same
 * range across the north, the same forest belt along the south — and a sixth of
 * the interior simply gone, the roads eaten, the towns absent. A hand-authored
 * second landmass would be somewhere else. This is *here*, afterwards.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS GENERATED, AND THE NUMBERS WERE MEASURED BEFORE ANY OF IT WAS WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 * Hand-authoring seventeen thousand cells is not bounded work; transforming them
 * is. The transform was prototyped and surveyed for CROSSABILITY first, because
 * a landmass you cannot cross is worse than no landmass:
 *
 *     threshold  erased  walkable  largest blob  components
 *        0.72      1017      8549         96.6%           6   barely touched
 *        0.66      2270      7624         96.6%           8   ← a sixth, still one place
 *        0.60      4176      6284         61.4%          16   shattered
 *        0.50      7828      3784         23.7%          37   unplayable
 *
 * 0.66 removes 1,703 walkable cells — almost exactly the "sixth of the interior"
 * the design asked for — while leaving 96.6% of the ground reachable from one
 * place.
 *
 * ═══ AND THEN THE ROAD, WHICH WAS THE PART THAT NEARLY SHIPPED WRONG ═══
 * At that setting **89.8% of the road survived**, so the Redaction would have
 * played as Alderbrook with holes in it: the safe network — the one promise the
 * overworld makes — intact in a place whose entire premise is that nothing is
 * safe. Biasing the erasure toward MADE GROUND (`ROAD_BIAS`) fixes it in the
 * fiction's own terms: the Index overwrote what people built. Measured at 0.25
 * bias — 6,532 walkable, 89.3% reachable, and **25% of the road left**, so what
 * remains of it is fragments you find rather than a network you travel.
 *
 * ═══ NO SHARDS, DELIBERATELY ═══
 * The design sketch wanted the walkable blob broken into five or six pieces.
 * That assumed conditionally-passable terrain to reconnect them, which was
 * refuted by measurement and removed (see DECISIONS.md). Without it, shards are
 * ground a player can see across and never reach — a dead end rather than a
 * mystery — so the transform is tuned to stay one crossable place.
 *
 * PURE, like everything in `shared/`: the noise is a hash of the coordinate, not
 * an rng draw, so this map is the same map in every process and on every client
 * without spending a single position in a seeded stream.
 */

/**
 * How far around the landing tile has to be country rather than void.
 *
 * A 7x7 (`ARRIVAL_RADIUS` 3) of which 45 of 49 cells must be walkable — nearly
 * clear, not merely passable. Measured: the cell this picks is 46/49 and the
 * one it rejects is 19/49, so the bar is nowhere near the noise. See the note
 * at the arrival itself for what it is protecting against.
 */
const ARRIVAL_RADIUS = 3;
const ARRIVAL_ROOM = 45;

/** How much noise a cell needs before the Index has taken it. */
const ERASE_THRESHOLD = 0.66;

/**
 * How much more readily made ground goes.
 *
 * The road, the paving, the yards and the bridges are what people built, and the
 * Redaction is what happened to what people built. 0.25 leaves a quarter of it —
 * enough that a surviving stretch of paving is a thing you notice, and far too
 * little to travel by.
 */
const ROAD_BIAS = 0.25;

/**
 * The Redaction's own site id — DEFINED IN `level.ts` and re-exported here.
 *
 * The glyph table in that file needs it and this file imports that file, so the
 * constant has to live upstream of the cycle. Re-exported because this is the
 * file a reader looks in. See the note beside the definition.
 */
export { REDACTION_SITE_ID };

/**
 * Deterministic value noise. NOT `rng.ts`: this map must be identical in every
 * process without consuming a labelled draw, and a hash of the coordinate is the
 * only way to get that. See the note on purity above.
 */
function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth blobs rather than pepper.
 *
 * Per-cell noise erases a scatter of single tiles, which reads as damage to the
 * RENDERER rather than to the world. Interpolating a coarse grid gives holes
 * with edges — country that has been taken out in pieces.
 */
function blob(x: number, y: number, salt: number, scale: number): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = (x % scale) / scale;
  const fy = (y % scale) / scale;
  const a = hash(gx, gy, salt);
  const b = hash(gx + 1, gy, salt);
  const c = hash(gx, gy + 1, salt);
  const d = hash(gx + 1, gy + 1, salt);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/** Every walkable cell reachable from `from`, eight-way, as movement is. */
function blobFrom(tiles: readonly number[], w: number, h: number, from: number): Set<number> {
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

/**
 * Build the dark territory.
 *
 * The arrival tile and every site are chosen from the LARGEST connected piece,
 * so nothing this map offers can be marooned behind a hole — which is the
 * property `test/shared/redaction.test.ts` exists to hold and the one that makes
 * the difference between a place and a diorama.
 */
export function makeRedaction(): AuthoredMap {
  const base = makeOverworld();
  const w = base.view.w;
  const h = base.view.h;
  const tiles = base.view.tiles.slice();

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = tileIndex(x, y, w);
      const code = tiles[i] ?? TileCode.WALL;
      // THE SILHOUETTE IS KEPT. Water, deep water and the existing erased rim
      // are what the player recognises from the other side; eating those would
      // make this a different continent rather than the same one overwritten.
      if (code === TileCode.WATER || code === TileCode.DEEPWATER) continue;
      if (code === TileCode.ERASED) continue;

      const n = blob(x, y, 7, 11) * 0.6 + blob(x, y, 23, 5) * 0.4;
      const bias = isSafeGround(code) ? ROAD_BIAS : 0;
      if (n + bias > ERASE_THRESHOLD) tiles[i] = TileCode.ERASED;
    }
  }

  // ═══ THE LARGEST SURVIVING PIECE, FOUND RATHER THAN ASSUMED ═══
  // The transform is tuned to leave one dominant blob, but "tuned to" is not
  // "guaranteed to", and everything below is placed inside whatever it actually
  // produced.
  let best = new Set<number>();
  const visited = new Set<number>();
  for (let i = 0; i < tiles.length; i += 1) {
    if (visited.has(i) || !isWalkable(tiles[i] ?? TileCode.WALL)) continue;
    const piece = blobFrom(tiles, w, h, i);
    for (const j of piece) visited.add(j);
    if (piece.size > best.size) best = piece;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE YOU ARRIVE — NEAR WHERE YOU WOULD HAVE BEEN, AND SOMEWHERE WITH ROOM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The joke of this place is that stepping through the door puts you where you
   * were already standing, so the arrival is chosen by nearness to Alderbrook's
   * own spawn. THAT ALONE IS NOT ENOUGH, and driving it is what showed why: the
   * nearest surviving cell to home is by definition the one hard against the
   * edge of a hole, and it measured 3 walkable neighbours out of 9. A player
   * crossing into the dark territory materialised in a notch with the void on
   * three sides and one way out of it — which reads as a bug in the map rather
   * than as the map being frightening, and it is the first thing they see.
   *
   * So nearness is the TIE-BREAK and open ground is the requirement. `ARRIVAL_
   * ROOM` of the 7x7 around the cell has to survive, which moved the landing
   * from (118,66) at 19/49 to a cell ten tiles further out at 46/49 — still
   * within sight of where you were, and now somewhere you can turn around.
   *
   * THE FALLBACK IS THE OLD RULE, deliberately. If a future threshold leaves
   * nowhere that open, a cramped arrival is bad and no arrival is fatal.
   */
  const home = base.spawns[0] ?? { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  const roomAround = (x: number, y: number): number => {
    let n = 0;
    for (let dy = -ARRIVAL_RADIUS; dy <= ARRIVAL_RADIUS; dy += 1) {
      for (let dx = -ARRIVAL_RADIUS; dx <= ARRIVAL_RADIUS; dx += 1) {
        if (isWalkable(tiles[tileIndex(x + dx, y + dy, w)] ?? TileCode.WALL)) n += 1;
      }
    }
    return n;
  };

  let arrival: TileXY = home;
  let nearest = Number.POSITIVE_INFINITY;
  let arrivalRoomy: TileXY | undefined;
  let nearestRoomy = Number.POSITIVE_INFINITY;
  for (const i of best) {
    const x = i % w;
    const y = (i - x) / w;
    // The border is skipped rather than clamped: `roomAround` reads a 7x7 and a
    // cell that close to the rim is the erased frame anyway.
    if (x < ARRIVAL_RADIUS || y < ARRIVAL_RADIUS) continue;
    if (x >= w - ARRIVAL_RADIUS || y >= h - ARRIVAL_RADIUS) continue;
    const d = Math.max(Math.abs(x - home.x), Math.abs(y - home.y));
    if (d < nearest) {
      nearest = d;
      arrival = { x, y };
    }
    if (d < nearestRoomy && roomAround(x, y) >= ARRIVAL_ROOM) {
      nearestRoomy = d;
      arrivalRoomy = { x, y };
    }
  }
  arrival = arrivalRoomy ?? arrival;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH DOORS SURVIVED — DERIVED FROM THE ERASURE, NOT PICKED BY HAND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The design asked for "nine of thirteen site coordinates gone". Rather than
   * choosing four and writing them down — which would drift the moment the
   * threshold moves — the surviving sites ARE the ones whose cells came through
   * the redaction still standing and still reachable. The Index decided, and the
   * map is the record of what it decided.
   *
   * Their ids are the Redaction's own, so nothing here can be mistaken for the
   * place it used to be: `SITES` is keyed by id and a shared id would mean one
   * shop, one shelf and one roster across two worlds.
   */
  const sites = new Map<string, string>();
  for (const [cell, siteId] of base.sites) {
    const [xs, ys] = cell.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const i = tileIndex(x, y, w);
    if (!best.has(i)) continue;
    /**
     * EXCEPT THE DOOR YOU CAME THROUGH, WHICH IS A CELL ON THAT MAP LIKE ANY
     * OTHER AND WOULD OTHERWISE COPY ITSELF.
     *
     * The Redaction is reached by a site glyph on the Alderbrook rows, so it is
     * in `base.sites` alongside the towns — and mirroring it here produced a
     * door on the Redaction leading to the Redaction, which is either a no-op
     * or a loop depending on which subsystem reads it first. It is written as a
     * skip rather than as a filter on the glyph table because the general rule
     * is the honest one: A MAP DOES NOT CONTAIN ITS OWN ENTRANCE. The way back
     * is the arrival tile, which `markersFor` already draws as *The way out*.
     */
    if (siteId === REDACTION_SITE_ID) continue;
    sites.set(cell, `${REDACTION_SITE_ID}:${siteId.replace('site:', '')}`);
  }

  return { view: { w, h, tiles }, spawns: [arrival], sites };
}

/**
 * The regions, borrowed whole.
 *
 * The Bracken Waste is still the Bracken Waste with holes in it — renaming the
 * country would be the one thing that stops a player recognising where they are,
 * and recognising where they are is the point of the entire map.
 */
export const REDACTION_REGIONS = ALDERBROOK_REGIONS;
