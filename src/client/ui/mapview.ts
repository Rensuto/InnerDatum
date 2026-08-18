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
import { TileCode, isWalkable, isSafeGround } from '../../shared/protocol.ts';
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
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THIS LINE DRAWS THE SAFE NETWORK, AND THAT IS A RULE, NOT A COLOUR.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * It used to name three codes by hand — COBBLE, PAVING, YARD — for the good
     * reason that *"where are the roads"* is what a world map is opened to
     * answer. But the game already had a second, invisible fact about exactly
     * this ground: nothing may lie in wait on it. `roamers.ts` has enforced that
     * since roamers existed and says why — *"the road and a settlement's
     * approach are SAFE, and that is a promise a player learns to rely on"* —
     * and no screen in the game had ever said so.
     *
     * A promise nobody can see is not a promise. `isSafeGround` is the same
     * predicate the server places roamers by, so the strand, the fields and the
     * bridges join the roads and the picture becomes one continuous thing you
     * can plan a journey along.
     *
     * ONE DEFINITION, IN `shared/`, for the reason the note there gives: a
     * hand-kept copy on this side would eventually promise safety on ground a
     * roamer was standing on.
     */
    if (isSafeGround(code)) return '#8a8070';
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NAME THE PLACES. THE FULL-SCREEN MAP WANTS THIS; THE MINIMAP MUST NOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The world map was thirteen identical gold squares. A player pressed M to
   * ask the one question a world map exists to answer — WHERE DO I GO — and got
   * a black field with dots on it: no names, no difficulty, no way to tell
   * Saint's Rest (an empty safe room) from the Outer Index ("grim"). The server
   * had been sending `name` all along and nothing drew it.
   *
   * OFF BY DEFAULT AND OFF FOR THE MINIMAP, which is 200px wide and shows a
   * 33-tile window: three labels would cover the terrain the panel exists to
   * show. The same painter serves both, so the difference has to be a flag
   * rather than a second painter that drifts.
   */
  readonly labelled?: boolean;
};

/**
 * Paint one level into a rect, letterboxed to keep the map's aspect.
 *
 * Returns the cell size actually used, which the caller needs in order to hit
 * test — the full-screen map has to turn a click back into a tile.
 */
export function paintMap(paint: MapPaint): number {
  const { ctx, level, rect, sites, self, framed, seen, windowRadius, labelled } = paint;

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
    // A PLACE TAKES ITS GRADE'S COLOUR; a roamer keeps the alarm colour, because
    // a thing that is walking towards you outranks a room that is merely bad.
    ctx.fillStyle =
      site.sprite !== undefined
        ? PALETTE.CRIMSON
        : ((site.danger === undefined ? undefined : DANGER_INK[site.danger]) ?? PALETTE.GOLD);
    ctx.fillRect(
      ox + site.x * cell - Math.floor((dot - cell) / 2),
      oy + site.y * cell - Math.floor((dot - cell) / 2),
      dot,
      dot,
    );
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT EACH ONE IS CALLED — a second pass, after every dot is down.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * SEPARATE FROM THE DOT LOOP ON PURPOSE. Text and rectangles interleaved would
   * let one settlement's label be painted over by the next settlement's marker,
   * and which ones depends on map order — a picture that is subtly different
   * every time the roster changes. Two passes means every label sits above every
   * dot, always.
   *
   * ROAMERS ARE NOT LABELLED. They carry a `sprite` and they move; a name that
   * follows a wandering danger around the region turns a map into a tracker, and
   * the fog is supposed to make "where is it now" a real question. The dot in
   * the alarm colour is all a roamer gets.
   */
  if (labelled) {
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const site of sites) {
      if (site.sprite !== undefined) continue;
      if (site.x < win.x0 || site.x > win.x1 || site.y < win.y0 || site.y > win.y1) continue;
      if (seen !== undefined && !seen.has(`${site.x},${site.y}`)) continue;

      const dx = ox + site.x * cell;
      const dy = oy + site.y * cell;
      // FLIP TO THE LEFT NEAR THE RIGHT EDGE, so a name on the far side of the
      // region is not clipped in half by the panel it is drawn in.
      const flip = dx > rect.x + rect.w - 160;
      ctx.textAlign = flip ? 'right' : 'left';
      const tx = flip ? dx - dot : dx + dot + 3;

      const grade = site.danger === undefined ? undefined : DANGER_INK[site.danger];
      const label = site.danger === undefined ? site.name : `${site.name} · ${site.danger}`;

      // A DARK PLATE UNDER THE TEXT. The region is mostly mid-green field and
      // pale road; a bare 10px label on that is unreadable at exactly the
      // moment somebody is squinting at it. Measured, not guessed at.
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10, 8, 19, 0.72)';
      ctx.fillRect(flip ? tx - w - 3 : tx - 3, dy - 7, w + 6, 14);

      ctx.fillStyle = grade ?? PALETTE.PARCHMENT;
      ctx.fillText(label, tx, dy);
    }
    ctx.textAlign = 'left';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR GRADES, AS COLOUR — AND THE WORD IS ALWAYS DRAWN BESIDE IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `content/delve.ts#dangerWord` weighs a delve's roster against its population
 * band and answers one of four words. This is that scale in colour, running
 * parchment -> gold -> amber -> crimson, so a player can read the shape of the
 * region at a glance before reading a single label.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. The word itself is printed next to the dot
 * for exactly the reason the Case Log's `LogLine.lane` is a server-set field
 * rather than something a renderer infers: about one man in twelve cannot tell
 * the amber from the crimson, and "where is it safe" is not a question this
 * game gets to answer only in hue.
 */
const DANGER_INK: Readonly<Record<string, string>> = {
  quiet: '#9fb08a',
  restless: '#d8b25a',
  dangerous: '#d98341',
  grim: '#c9483f',
};

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
