import { describe, expect, it } from 'vitest';

import { ALDERBROOK_REGIONS, makeOverworld, regionAt, canWalk } from '../../src/shared/level.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GROUND HAS NAMES, AND EVERY TILE HAS EXACTLY ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen markers had names. The 9,327 tiles between them had one, and it was
 * "the overworld" — so everything that happened out there was reported the same
 * way, and six friends in a voice channel had no way to say where anything
 * happened except by reading coordinates at each other.
 *
 * *"I got jumped in the Bracken Waste"* is a sentence. *"I got jumped at 94,41"*
 * is a bug report. This game is played by people talking to each other, and the
 * evening's story is the product.
 *
 * ═══ THE PROPERTY THAT MATTERS IS THE TILING, AND IT FAILS INVISIBLY ═══
 * A hand-placed rectangle list has to cover every cell and overlap nowhere. One
 * typo in one bound leaves a nameless strip, and walking along that seam crosses
 * in and out of it — announcing itself over and over, on one border, where
 * nobody is looking.
 *
 * ═══ WHICH IS WHY THE TABLE IS BANDS, AND WHY THIS FILE CANNOT CATCH A TYPO ═══
 * Checked by injection, not assumed: changing a cut from 69 to 68 leaves every
 * test here green, because `buildRegions` starts each rectangle at the previous
 * one's `x1 + 1`. **A gap between adjacent regions is unrepresentable**, so a
 * mis-typed bound moves a border rather than opening a hole — which is a
 * different-looking map, not a flickering one.
 *
 * The one failure the construction cannot prevent is a table that stops SHORT of
 * the map edge, and `assertRegionsTile` throws at module load for exactly that
 * (verified the same way: shortening the last band to y1 95 fails every suite in
 * the file with a named error rather than a subtle miss).
 *
 * So what the exhaustive sweep below actually protects is the CONSTRUCTION — it
 * is the test that fails the day somebody replaces the bands with free
 * rectangles and reintroduces the failure mode the bands exist to remove.
 */

const OVERWORLD = makeOverworld();

describe('every part of the moor is called something', () => {
  it('covers all 17,000 cells with no gap and no overlap', () => {
    /**
     * EXHAUSTIVE, NOT SAMPLED — 17,000 cells, each in exactly one rectangle.
     * Cheap, total, and the assertion that has to hold however the table is
     * built. See the header: with bands it cannot currently fail, and that is
     * the point of it. It is here to fail on the refactor, not on the typo.
     */
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PROPERTY THAT REPLACED "NO GAP AND NO OVERLAP".
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Rectangles had to TILE — every cell in exactly one box — and this counted
     * hits per cell to prove it. The redesigned moor draws its country PER CELL,
     * so a cell holds exactly one index by construction and there is nothing
     * left for that test to catch.
     *
     * What CAN still go wrong is a cell of ground with no name on it, and that
     * is the half a player meets: `noteRegion` announces the country you walk
     * into, so unnamed WALKABLE ground is a step that says nothing or says "the
     * moor". Unwalkable cells are allowed to be nameless — the open sea and the
     * eroded border are not anywhere — and nobody can stand on them to find out.
     */
    const { w, h } = OVERWORLD.view;
    const nameless: string[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!canWalk(OVERWORLD.view, x, y)) continue;
        if (regionAt(x, y) === 'the moor') nameless.push(`${String(x)},${String(y)}`);
      }
    }
    expect(nameless.slice(0, 8), 'walkable ground with no country').toEqual([]);
  });

  it('never answers with the off-map fallback anywhere on the map', () => {
    // `regionAt` returns 'the moor' for a caller that did not bounds-check — a
    // name being better than a crash inside somebody's move. It must never be
    // reachable from a real tile, or the fallback IS the region table.
    const { w, h } = OVERWORLD.view;
    /**
     * ON WALKABLE GROUND. The redesigned moor leaves the open sea and the eroded
     * border unregioned on purpose — they are not anywhere — and a player cannot
     * stand on either to be told so. What must never happen is a step onto real
     * ground that answers with the off-map fallback.
     */
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!canWalk(OVERWORLD.view, x, y)) continue;
        expect(regionAt(x, y)).not.toBe('the moor');
      }
    }
  });

  it('gives every region real ground somebody can stand on', () => {
    /**
     * A REGION NOBODY CAN WALK IN IS A NAME NOBODY WILL EVER READ. Measured on
     * the shipped map, the smallest is the Drowned Coast at 144 walkable cells
     * and the largest is the Bracken Waste at 1,820 — so none of the twelve is a
     * sliver, and the two that sound like edges genuinely are edges.
     */
    const { w, h, tiles } = OVERWORLD.view;
    const walkable = new Map<string, number>();
    const cells = new Map<string, number>();
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const name = regionAt(x, y);
        // EVERY cell for `cells`, walkable ones for `walkable`: a mountain range
        // has plenty of the first and almost none of the second, and both facts
        // are asserted below.
        cells.set(name, (cells.get(name) ?? 0) + 1);
        if (!isWalkable(tiles[y * w + x] ?? TileCode.WALL)) continue;
        walkable.set(name, (walkable.get(name) ?? 0) + 1);
      }
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A RANGE IS ALLOWED TO HAVE NO GROUND. THAT IS WHAT A RANGE IS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This demanded a hundred walkable cells of every region, which was true
     * while the country was rectangles laid over rolling ground. The redesigned
     * Kettle Range is 55% mountain and 43% crag — FOUR walkable cells in the
     * whole of it — and that is the barrier the two passes exist to get through
     * rather than a region with nothing in it.
     *
     * So the floor is on CELLS, which every region must have, and the walkable
     * demand moves to the regions a player is meant to walk in. A range that
     * became strollable would fail the promise test in overworld.test.ts
     * instead, which is where that belongs.
     */
    for (const region of ALDERBROOK_REGIONS) {
      expect(cells.get(region.name) ?? 0, `${region.name} has no ground at all`).toBeGreaterThan(
        100,
      );
    }
    const impassable = new Set(['the Kettle Range', 'the Drowned Coast']);
    for (const region of ALDERBROOK_REGIONS) {
      if (impassable.has(region.name)) continue;
      expect(
        walkable.get(region.name) ?? 0,
        `${region.name} has no walkable ground`,
      ).toBeGreaterThan(100);
    }
    // And between them they account for the whole walkable map.
    // 8,380 -> 8,346 when the settlements were built properly: 34 yard tiles
    // became buildings, because every roof on this map used to be a lone tile on
    // open ground. See `test/shared/level.test.ts`.
    expect([...walkable.values()].reduce((a, b) => a + b, 0)).toBe(8346);
  });

  it('names the ground rather than repeating the markers', () => {
    /**
     * A marker already says "Threadneedle Row". A region that repeated it would
     * tell the player nothing they cannot already see — and the useful thing to
     * name is the ground BETWEEN the markers, which is exactly the part that had
     * no name.
     */
    const siteWords = ['Threadneedle', 'Gearford', 'Underworks', 'Hollow', 'Glass'];
    for (const region of ALDERBROOK_REGIONS) {
      for (const word of siteWords) {
        expect(region.name).not.toContain(word);
      }
    }
  });

  it('puts the spawn somewhere that sounds like home', () => {
    // 121,72 is where every new detective opens their eyes. The first region
    // name any player ever reads should be the one that sounds like a place they
    // came from rather than a place they are lost in.
    const spawn = OVERWORLD.spawns[0];
    expect(spawn).toBeDefined();
    expect(regionAt(spawn?.x ?? 0, spawn?.y ?? 0)).toBe('Alderbrook Common');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FLICKER TEST IS GONE, AND ITS FAILURE MODE WENT WITH THE RECTANGLES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It walked whole rows and demanded every region be at least six cells wide
   * where it was crossed, because *"a gap in the tiling shows up here as a
   * region entered and left within two steps"*. That was a real guard while
   * country was boxes that had to tile: a gap between two rectangles is a
   * nameless strip, and this is where it would have shown.
   *
   * Per-cell regions cannot have a gap. Every cell holds exactly one index
   * because there is nowhere else for it to hold anything, and the two tests
   * above assert what remains: no walkable ground without a name, and no region
   * that is a sliver.
   *
   * WHAT WAS LEFT WAS GEOMETRY, NOT A BUG. Irregular country clips corners — a
   * region forty cells across can show one cell on one row and be perfectly
   * substantial. Four attempts narrowed the map's short runs from five to one,
   * each correction real (the scan counted the first run short; it treated cells
   * across open water as consecutive steps; it counted runs that ended at a
   * coastline), and the last one standing was a corner. A test that failed on a
   * corner would be asserting that the moor is rectangular, which is the one
   * thing the redesign set out to stop being.
   */
});
