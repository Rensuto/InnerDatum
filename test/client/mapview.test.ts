/**
 * The map at both sizes: the window, the fog, and the two things that must not
 * leak through it.
 */

import { describe, expect, it } from 'vitest';

import { MINIMAP_RADIUS, minimapRect } from '../../src/client/ui/mapview.ts';

describe('the minimap is a window, not the whole world', () => {
  it('is square and sized from the radius rather than from the level', () => {
    // A minimap that showed all of a 170x100 region would be a postage stamp of
    // a continent: every cell under a pixel, the player a dot among dots, and
    // no answer to the only question it is asked — what is just off the edge of
    // my screen. So its size depends on the RADIUS and not on the map, which is
    // also what stops it changing shape when you walk into a 24x24 arena.
    const wide = minimapRect(1280);
    const narrow = minimapRect(800);
    expect(wide.w).toBe(wide.h);
    expect(wide.w).toBe(narrow.w);
    expect(wide.h).toBe(narrow.h);
  });

  it('sits in the top-right corner, whatever the width', () => {
    for (const width of [640, 900, 1280, 1920]) {
      const r = minimapRect(width);
      expect(r.y).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThan(width);
      // Hard against the right edge, allowing only the margin.
      expect(width - (r.x + r.w)).toBeLessThan(16);
    }
  });

  it('reaches further than the viewport, which is the whole point', () => {
    // "A slightly bigger area than the player can currently see." The viewport
    // is at most 48x32 tiles and usually nearer 20x11, so a radius of 16 shows
    // the screen plus a margin of what is about to matter. A minimap showing
    // exactly what is already on screen would be decoration.
    expect(MINIMAP_RADIUS * 2 + 1).toBeGreaterThan(20);
  });
});
