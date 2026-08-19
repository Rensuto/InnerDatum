import { describe, expect, it } from 'vitest';

import { ALDERBROOK_REGIONS, makeOverworld, regionAt } from '../../src/shared/level.ts';
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
    const { w, h } = OVERWORLD.view;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const hits = ALDERBROOK_REGIONS.filter(
          (r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1,
        );
        expect(hits, `${String(x)},${String(y)} is in ${String(hits.length)} regions`).toHaveLength(
          1,
        );
      }
    }
  });

  it('never answers with the off-map fallback anywhere on the map', () => {
    // `regionAt` returns 'the moor' for a caller that did not bounds-check — a
    // name being better than a crash inside somebody's move. It must never be
    // reachable from a real tile, or the fallback IS the region table.
    const { w, h } = OVERWORLD.view;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
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
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!isWalkable(tiles[y * w + x] ?? TileCode.WALL)) continue;
        const name = regionAt(x, y);
        walkable.set(name, (walkable.get(name) ?? 0) + 1);
      }
    }

    for (const region of ALDERBROOK_REGIONS) {
      expect(
        walkable.get(region.name) ?? 0,
        `${region.name} has no walkable ground`,
      ).toBeGreaterThan(100);
    }
    // And between them they account for the whole walkable map.
    expect([...walkable.values()].reduce((a, b) => a + b, 0)).toBe(9327);
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

  it('changes name at most once per step, so a walk cannot stutter', () => {
    /**
     * THE FLICKER TEST, WRITTEN AS THE PLAYER EXPERIENCES IT. Walk the full
     * width of the map along several rows and count the boundaries crossed. A
     * gap in the tiling shows up here as a region entered and left within two
     * steps — which on a live server is two Record lines a tile apart.
     */
    const { w } = OVERWORLD.view;
    for (const y of [10, 25, 45, 70, 82, 95]) {
      let previous = regionAt(0, y);
      let run = 0;
      for (let x = 1; x < w; x += 1) {
        const name = regionAt(x, y);
        if (name === previous) {
          run += 1;
          continue;
        }
        // Every region a walk passes through must be at least a few tiles wide.
        // One or two tiles is a seam, not a place.
        expect(run, `a strip only ${String(run)} wide at y=${String(y)}`).toBeGreaterThan(5);
        previous = name;
        run = 0;
      }
    }
  });
});
