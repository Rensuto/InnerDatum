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
  /**
   * WHICH CELLS HAVE BEEN SEEN. Absent means "all of it", which is what an
   * inner-world wants — a room you are standing in is not a thing you explore
   * across sessions.
   *
   * Everything outside it draws as unknown, and a site or a roamer standing on
   * an unseen cell is not drawn at all: a map that hid the ground but kept the
   * towns would give away exactly what the fog is for.
   */
  readonly seen?: ReadonlySet<string>;
  /**
   * Show only a window this many tiles either side of `self`, rather than the
   * whole level. The minimap wants this; the world map does not.
   */
  readonly windowRadius?: number;
};

/**
 * Paint one level into a rect, letterboxed to keep the map's aspect.
 *
 * Returns the cell size actually used, which the caller needs in order to hit
 * test — the full-screen map has to turn a click back into a tile.
 */
export function paintMap(paint: MapPaint): number {
  const { ctx, level, rect, sites, self, framed, seen, windowRadius } = paint;

  /**
   * THE WINDOW. A minimap that showed the whole 170x100 region would be a
   * postage stamp of a continent — every cell under a pixel, the player a dot
   * among dots, and no answer to the only question it is asked: what is just
   * off the edge of my screen.
   *
   * So it shows a window a little wider than the viewport instead, centred on
   * the player and CLAMPED to the map, which is what keeps a player walking
   * along the north edge from seeing half a panel of nothing.
   */
  const win =
    windowRadius === undefined || self === undefined
      ? { x0: 0, y0: 0, x1: level.w - 1, y1: level.h - 1 }
      : {
          x0: Math.max(0, Math.min(level.w - 1 - windowRadius * 2, self.x - windowRadius)),
          y0: Math.max(0, Math.min(level.h - 1 - windowRadius * 2, self.y - windowRadius)),
          x1: 0,
          y1: 0,
        };
  if (windowRadius !== undefined && self !== undefined) {
    win.x1 = Math.min(level.w - 1, win.x0 + windowRadius * 2);
    win.y1 = Math.min(level.h - 1, win.y0 + windowRadius * 2);
  }
  const spanW = win.x1 - win.x0 + 1;
  const spanH = win.y1 - win.y0 + 1;

  // WHOLE PIXELS PER CELL. A fractional cell size makes adjacent cells round to
  // different widths, and the seams that produces read as terrain that is not
  // there — precisely the thing a map must not invent.
  const cell = Math.max(1, Math.floor(Math.min(rect.w / spanW, rect.h / spanH)));
  const mapW = cell * spanW;
  const mapH = cell * spanH;
  const ox = rect.x + Math.floor((rect.w - mapW) / 2) - win.x0 * cell;
  const oy = rect.y + Math.floor((rect.h - mapH) / 2) - win.y0 * cell;

  if (framed) {
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
  }

  for (let y = win.y0; y <= win.y1; y += 1) {
    for (let x = win.x0; x <= win.x1; x += 1) {
      const code = level.tiles[y * level.w + x];
      if (code === undefined) continue;
      // UNSEEN GROUND IS DRAWN, not skipped: leaving it blank would show the
      // panel behind it and make the fog look like a hole in the UI.
      ctx.fillStyle =
        seen !== undefined && !seen.has(`${x},${y}`) ? UNSEEN : miniFill(code as TileCode);
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
    // Not on this window, or not yet found. A map that hid the ground and kept
    // the towns would give away the thing the fog exists to withhold.
    if (site.x < win.x0 || site.x > win.x1 || site.y < win.y0 || site.y > win.y1) continue;
    if (seen !== undefined && !seen.has(`${site.x},${site.y}`)) continue;
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

/** Unknown ground. Near-black, and never pure black — see `miniFill`. */
const UNSEEN = '#0b0912';

/**
 * How far either side of the player the minimap reaches.
 *
 * "A slightly bigger area than the player can currently see" — the viewport is
 * at most 48x32 tiles and usually nearer 20x11, so 16 either side shows the
 * screen plus a margin of what is about to matter. That margin IS the feature:
 * a minimap showing exactly what you can already see would be decoration.
 */
export const MINIMAP_RADIUS = 16;

/** Where the minimap goes: top-right, inside the margin. */
export function minimapRect(viewW: number): MapRect {
  const span = MINIMAP_RADIUS * 2 + 1;
  const cell = Math.max(1, Math.floor(Math.min(MINIMAP_MAX_W / span, MINIMAP_MAX_H / span)));
  const size = cell * span;
  return { x: viewW - size - MINIMAP_MARGIN, y: MINIMAP_MARGIN, w: size, h: size };
}
