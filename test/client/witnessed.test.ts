/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { REVEAL_RADIUS } from '../../src/shared/fog.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { DEFAULT_SIGHT_RADIUS, tilesInSight } from '../../src/shared/sight.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE VIEWER HAS SEEN — upstream's `remembers`, and the THIRD draw state.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Map:apply` and `Map:applyLite` write `seens` and `remembers`; a grid in
 * neither is absent from upstream's screen entirely. The light pass shipped with
 * two of the three because the client had no honest source for the third:
 * `explored` is a DISC at `REVEAL_RADIUS` with no line of sight, which `fog.ts`
 * defends as *"a map, not a torch"*.
 *
 * The rule itself is a pure function in `shared/sight.ts` and is tested as one.
 * Everything it is WIRED to lives in `main.ts`, which is unreachable from
 * `test/` — those are source guards, on `travel.test.ts`' stated terms: *"the
 * weakest kind of test, chosen because the alternative is none"*.
 */

const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
const CANVAS = readFileSync(new URL('../../src/client/render/canvas.ts', import.meta.url), 'utf8');

function mapOf(rows: readonly string[]): LevelView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    if (row.length !== w) throw new Error(`ragged test map: "${row}" is not ${w} wide`);
    for (let x = 0; x < w; x += 1) {
      tiles.push(row.charAt(x) === '#' ? TileCode.WALL : TileCode.FLOOR);
    }
  }
  return { w, h, tiles };
}

const key = (t: { x: number; y: number }): string => `${String(t.x)},${String(t.y)}`;

describe('tilesInSight — the torch, not the map', () => {
  it('refuses a tile behind a wall that a DISC would have handed over', () => {
    /**
     * ═══ THE WHOLE REASON THIS IS NOT `explored` ═══
     * The viewer stands west of a wall with a room behind it. Every tile of that
     * room is within `REVEAL_RADIUS` and within sight range, so the disc the
     * minimap draws from contains all of it — which on the playfield would mean
     * walking up to the OUTSIDE of a building and being shown its floor plan.
     *
     *     y=2   # @ # . . . #      <- @ at (1,2); the wall at (2,2)
     */
    const level = mapOf(['#######', '#######', '#@#...#', '#######', '#######']);
    const at = { x: 1, y: 2 };
    const seen = new Set(tilesInSight(level, at).map(key));

    for (const x of [3, 4, 5]) {
      expect(seen.has(`${String(x)},2`), `(${String(x)},2) was visible through a wall`).toBe(false);
      // AND THE DISC WOULD HAVE TAKEN IT, which is what makes this a difference
      // rather than a fact about a far-away tile.
      expect(x - at.x).toBeLessThanOrEqual(REVEAL_RADIUS);
    }
    // The wall ITSELF is seen — you are looking straight at it. `hasLineOfSight`
    // excludes endpoints precisely so a body cannot be blinded by what it faces.
    expect(seen.has('2,2'), 'the wall being looked at was not seen').toBe(true);
  });

  it('sees its own tile, and nothing outside the radius', () => {
    const level = mapOf(Array.from({ length: 31 }, () => '.'.repeat(31)));
    const at = { x: 15, y: 15 };
    const seen = new Set(tilesInSight(level, at).map(key));

    expect(seen.has('15,15'), 'a body cannot see the tile it stands on').toBe(true);
    // EUCLIDEAN, so the diagonal corner of the square is OUT while the cardinal
    // edge at the same radius is IN. A chebyshev sweep passes the second and
    // fails the first, which is the shape of the mistake `canSee` exists to
    // prevent — see `sightDistance`.
    expect(seen.has(`${String(15 + DEFAULT_SIGHT_RADIUS)},15`)).toBe(true);
    expect(
      seen.has(`${String(15 + DEFAULT_SIGHT_RADIUS)},${String(15 + DEFAULT_SIGHT_RADIUS)}`),
      'the sweep is chebyshev — it should be a circle',
    ).toBe(false);
  });

  it('stays inside the map', () => {
    // A body in the corner: the sweep walks a square that runs off two edges.
    const level = mapOf(Array.from({ length: 5 }, () => '.'.repeat(5)));
    for (const tile of tilesInSight(level, { x: 0, y: 0 })) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(level.w);
      expect(tile.y).toBeLessThan(level.h);
    }
  });
});

describe('the wiring, as source', () => {
  it('main.ts builds its memory from the shared sweep, not a second disc', () => {
    const at = MAIN.indexOf('function witnessAround(');
    expect(at, 'witnessAround was renamed — this guard is now blind').toBeGreaterThan(-1);
    const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
    expect(body, 'witnessAround stopped delegating — a second visibility rule').toContain(
      'tilesInSight(',
    );
    // AND NOT THE GENEROUS ONE. `REVEAL_RADIUS` here would silently restore the
    // through-walls behaviour the first test above is about.
    expect(body).not.toContain('REVEAL_RADIUS');
  });

  it('re-sweeps when the MAP changes under a body that did not move', () => {
    /**
     * ═══ THE MEMO IS KEYED ON POSITION AND A DOOR IS NOT A POSITION ═══
     * Opening a door from where you stand reveals a room. Without the terrain
     * term the player watches a lit doorway with a black room behind it until
     * they take a step — and doors have been in the game for four commits.
     */
    const at = MAIN.indexOf('function witnessAround(');
    const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
    expect(body, 'the sight memo ignores terrain changes').toContain('terrainEpoch');

    // AND SOMETHING ACTUALLY MOVES IT. A key that reads a counter nobody
    // increments is a key on position with extra steps.
    expect(MAIN, 'nothing ever advances terrainEpoch').toContain('terrainEpoch += 1;');
    const bump = MAIN.indexOf('terrainEpoch += 1;');
    const terrainCase = MAIN.lastIndexOf("case 'terrain': {", bump);
    expect(terrainCase, 'the bump is not inside the terrain frame handler').toBeGreaterThan(-1);
    expect(MAIN.indexOf("case 'ground':", terrainCase)).toBeGreaterThan(bump);
  });

  it('hands the set to the renderer, or the whole memory is unread', () => {
    // THE JOIN. Every assertion above is true of a set nothing draws from.
    const at = MAIN.indexOf('function scene(): Scene {');
    expect(at, 'scene was renamed — this guard is now blind').toBeGreaterThan(-1);
    expect(MAIN.slice(at, MAIN.indexOf('\n}', at))).toContain('witnessed: witnessedNow()');
  });

  it('the renderer blacks out a tile that is in neither state', () => {
    const at = CANVAS.indexOf('function paintLight(');
    const body = CANVAS.slice(at, CANVAS.indexOf('\n  function ', at + 1));
    expect(body, 'the paintLight window swallowed a neighbour').not.toContain(
      'paintsWorldTopology',
    );
    expect(body).toContain('witnessed.has(');
    // AND NULL FALLS BACK rather than blacking the screen: "say nothing" and
    // "nothing has been seen" differ by every tile on the floor.
    expect(body).toContain('witnessed !== null');
  });
});
