/**
 * The map, at two sizes: a corner minimap and a full-screen world map.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE PAINTER, TWO CALLERS, AND THAT IS THE WHOLE DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 * A minimap and a world map are the same picture at two scales. Writing them
 * separately would mean two colour tables and two ideas of what a settlement
 * looks like, and the first thing to drift would be the one that matters — the
 * walkable/blocking read, which is the only reason either exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT PAINTS FROM `TileCode`, NEVER FROM THE TILESET
 * ═══════════════════════════════════════════════════════════════════════════
 * At one or two pixels per cell a 32x32 sprite carries no information at all —
 * a mountain and a meadow both become a smudge of their average colour. So this
 * draws flat bands chosen for CONTRAST AT ONE PIXEL rather than for fidelity to
 * the terrain art, and it is deliberately not `tileFill`: that table is tuned so
 * walkable is lighter than blocking across a whole screen of tiles, and here the
 * job is different — tell land from water from wall in a single pixel.
 *
 * Pure: no state, no timers, no fetch. It is handed a level and a rect and it
 * paints.
 */

import { PALETTE } from '../render/canvas.ts';
import { TileCode, isWalkable } from '../../shared/protocol.ts';
import type { LevelView, SiteView } from '../../shared/protocol.ts';

/** Where the minimap sits and how big it is allowed to get. */
export const MINIMAP_MARGIN = 8;
export const MINIMAP_MAX_W = 200;
export const MINIMAP_MAX_H = 130;

/**
 * Four bands, chosen to survive being one pixel wide.
 *
 * Water is separated from wall because on a world map the coast is most of what
 * you navigate by, and a lake that looked like a mountain would make the whole
 * picture unreadable. Everything else collapses into walkable / blocking, which
 * is the only distinction a minimap owes the player.
 */
function miniFill(code: TileCode): string {
  if (code === TileCode.WATER || code === TileCode.DEEPWATER) return '#141d33';
  if (code === TileCode.ERASED) return '#0c0a14';
  if (isWalkable(code)) {
    // The road and a settlement's ground are picked out, because "where are the
    // roads" is the question a world map is opened to answer.
    if (code === TileCode.COBBLE || code === TileCode.PAVING || code === TileCode.YARD) {
      return '#8a8070';
    }
    return '#4e5a44';
  }
  return '#2a2733';
}

export type MapRect = { x: number; y: number; w: number; h: number };

export type MapPaint = {
  readonly ctx: CanvasRenderingContext2D;
  readonly level: LevelView;
  readonly rect: MapRect;
  readonly sites: readonly SiteView[];
  /** Where the viewer is, in tiles. Omitted when they are not on this map. */
  readonly self?: { x: number; y: number };
  /** Draw a frame and a fill behind it. False for the full-screen view. */
  readonly framed: boolean;
};

/**
 * Paint one level into a rect, letterboxed to keep the map's aspect.
 *
 * Returns the cell size actually used, which the caller needs in order to hit
 * test — the full-screen map has to turn a click back into a tile.
 */
export function paintMap(paint: MapPaint): number {
  const { ctx, level, rect, sites, self, framed } = paint;

  // WHOLE PIXELS PER CELL. A fractional cell size makes adjacent cells round to
  // different widths, and the seams that produces read as terrain that is not
  // there — precisely the thing a map must not invent.
  const cell = Math.max(1, Math.floor(Math.min(rect.w / level.w, rect.h / level.h)));
  const mapW = cell * level.w;
  const mapH = cell * level.h;
  const ox = rect.x + Math.floor((rect.w - mapW) / 2);
  const oy = rect.y + Math.floor((rect.h - mapH) / 2);

  if (framed) {
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
  }

  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      const code = level.tiles[y * level.w + x];
      if (code === undefined) continue;
      ctx.fillStyle = miniFill(code as TileCode);
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }

  /**
   * PLACES ON TOP, and bigger than a cell on purpose. A settlement is what a
   * player opens a map to find, and at one pixel it would be indistinguishable
   * from a patch of road. `sprite` marks something alive, which is drawn in the
   * alarm colour — the one place CRIMSON is spent outside the combat banner,
   * and it earns it: on a map, "where is the danger" is the other question.
   */
  const dot = Math.max(2, cell + 1);
  for (const site of sites) {
    ctx.fillStyle = site.sprite === undefined ? PALETTE.GOLD : PALETTE.CRIMSON;
    ctx.fillRect(
      ox + site.x * cell - Math.floor((dot - cell) / 2),
      oy + site.y * cell - Math.floor((dot - cell) / 2),
      dot,
      dot,
    );
  }

  if (self !== undefined) {
    const me = Math.max(3, cell + 2);
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillRect(
      ox + self.x * cell - Math.floor((me - cell) / 2),
      oy + self.y * cell - Math.floor((me - cell) / 2),
      me,
      me,
    );
  }

  return cell;
}

/** Where the minimap goes: top-right, inside the margin. */
export function minimapRect(level: LevelView, viewW: number): MapRect {
  const cell = Math.max(1, Math.floor(Math.min(MINIMAP_MAX_W / level.w, MINIMAP_MAX_H / level.h)));
  const w = cell * level.w;
  const h = cell * level.h;
  return { x: viewW - w - MINIMAP_MARGIN, y: MINIMAP_MARGIN, w, h };
}
