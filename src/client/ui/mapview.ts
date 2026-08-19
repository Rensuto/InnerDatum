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
import type { LevelView, RegionView, SiteView } from '../../shared/protocol.ts';

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
  /**
   * The names of the country, drawn UNDER the markers and only where the player
   * has walked. See `paintRegions`.
   */
  readonly regions?: readonly RegionView[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE YOUR PARTY IS, ON THE SCREEN YOU PLAN ON.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The map draws the country, the fog, all seventeen doors with their grade and
   * whether they are filed, the names of the regions, and a mark for YOU. In a
   * game whose whole design is three to six friends in a voice channel, it drew
   * nothing at all for the other five.
   *
   * The party PANE answers "who am I with and are they upright". It cannot
   * answer "where", and for a member on the same map as you that is the question
   * — *"Blackwood Outskirts"* is a name until the map turns it into a direction
   * and a distance.
   *
   * ═══ ONLY BODIES ON THE MAP BEING DRAWN ═══
   * The caller passes these only when the viewer is standing on the overworld
   * (`onIt`), and for the same reason that flag already exists: this map is the
   * OVERWORLD's, always, and a body inside an instance has instance
   * coordinates. Drawing those here would put a friend's delve position on the
   * world map — a mark that is not merely unhelpful but wrong, and confidently
   * so.
   */
  readonly party?: readonly { readonly x: number; readonly y: number; readonly name: string }[];
};

/** One party member's mark: where they are and what to call them. */
export type PartyMark = { readonly x: number; readonly y: number; readonly name: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH OF YOUR PARTY BELONG ON THIS MAP — the join, and the whole rule.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `party_state` says WHO you are playing with and how they are; it has never
 * carried a position and it should not. `projectWorld` sends every body in the
 * realm unfiltered, so the client already holds the tile of anybody standing on
 * this map. This is where the two meet.
 *
 * THREE THINGS IT HAS TO GET RIGHT, and each is a way to draw a lie:
 *
 *   `onMap` — the caller's `onIt`. This map is always the OVERWORLD's, and a
 *     body inside an instance carries instance coordinates. Painting those would
 *     put a friend's delve position on the world map.
 *   SELF IS NOT A MEMBER HERE. `self` is drawn separately, larger and on top; a
 *     second mark underneath it is a party member who does not exist.
 *   A MEMBER WITH NO BODY IN `actors` IS ABSENT, not an error. They are in an
 *     instance, or on another floor entirely — the party PANE answers for them
 *     by name, because it is the surface that knows about realms.
 */
export function partyMarks(
  members: readonly { readonly id: string; readonly name: string; readonly isSelf: boolean }[],
  bodies: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
  onMap: boolean,
): readonly PartyMark[] {
  if (!onMap) return [];
  return members.flatMap((member) => {
    if (member.isSelf) return [];
    const body = bodies.get(member.id);
    return body === undefined ? [] : [{ x: body.x, y: body.y, name: member.name }];
  });
}

/**
 * Paint one level into a rect, letterboxed to keep the map's aspect.
 *
 * Returns the cell size actually used, which the caller needs in order to hit
 * test — the full-screen map has to turn a click back into a tile.
 */
export function paintMap(paint: MapPaint): number {
  const { ctx, level, rect, sites, self, framed, seen, windowRadius, labelled, regions, party } =
    paint;

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
        : site.crossing === true
          ? CROSSING_INK
          : ((site.danger === undefined ? undefined : DANGER_INK[site.danger]) ?? PALETTE.GOLD);
    // A CLOSED CASE KEEPS ITS COLOUR AND LOSES ITS EMPHASIS. `globalAlpha` and
    // not a second palette: the grade still has to be readable, because "have I
    // done this" and "how bad is it" are two questions and the map answers both.
    const wasAlpha = ctx.globalAlpha;
    if (site.filed === true) ctx.globalAlpha = wasAlpha * FILED_ALPHA;
    ctx.fillRect(
      ox + site.x * cell - Math.floor((dot - cell) / 2),
      oy + site.y * cell - Math.floor((dot - cell) / 2),
      dot,
      dot,
    );
    ctx.globalAlpha = wasAlpha;
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE NAMES OF THE COUNTRY, AND THEY ARE EARNED RATHER THAN GIVEN.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The log has told you *"You come to the Bracken Waste"* since the regions
   * landed, and the map — the one screen whose entire job is answering "where"
   * — could not show you where the Bracken Waste WAS. A name you hear once and
   * cannot look up is a name you stop using.
   *
   * ═══ ONLY WHERE YOU HAVE WALKED, WHICH IS THE SAME RULE THE FOG ALREADY HAS ═══
   * A region's name appears when a fifth of it has been seen. Handing over
   * twelve names on the first frame would label ground the player has never
   * been near, and this map is drawn over their own fog precisely so that what
   * it shows is what they have earned. It is also the cheap answer to a real
   * problem: a name centred on a region the player cannot see is a caption on a
   * black rectangle.
   *
   * UNDER THE MARKERS AND OVER THE TERRAIN, because a site name is a
   * destination and a region name is context — and where they collide the
   * destination has to win.
   */
  if (labelled && regions !== undefined) {
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const region of regions) {
      // How much of it this player has actually walked. `seen` is the fog, and
      // its absence means an unfogged caller, which gets every name.
      let known = 0;
      let total = 0;
      for (let y = region.y0; y <= region.y1; y += 2) {
        for (let x = region.x0; x <= region.x1; x += 2) {
          if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1) continue;
          total += 1;
          if (seen === undefined || seen.has(`${String(x)},${String(y)}`)) known += 1;
        }
      }
      if (total === 0 || known * 5 < total) continue;

      const cx = ox + ((region.x0 + region.x1) / 2 + 0.5) * cell;
      const cy = oy + ((region.y0 + region.y1) / 2 + 0.5) * cell;
      // A HAIRLINE OF INK BEHIND THE LETTERS rather than a plate: a region name
      // sits on top of the terrain it names, and a filled box would punch a hole
      // in the very picture the label is about.
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10, 8, 19, 0.85)';
      ctx.strokeText(region.name.toUpperCase(), cx, cy);
      ctx.fillStyle = 'rgba(198, 190, 214, 0.55)';
      ctx.fillText(region.name.toUpperCase(), cx, cy);
    }
    ctx.restore();
  }

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

      // A CROSSING OUTRANKS A GRADE, and cannot collide with one: `specFor`
      // answers nothing for a site that is not a delve, so a marker never
      // carries both. Ordered explicitly anyway — the day something does carry
      // both, "there is a way off the map here" is the more important half.
      const grade =
        site.crossing === true
          ? CROSSING_INK
          : site.danger === undefined
            ? undefined
            : DANGER_INK[site.danger];
      const suffix = site.crossing === true ? CROSSING_WORD : site.danger;
      /**
       * `filed` IS APPENDED, NOT SUBSTITUTED. The grade of a room you have
       * cleared is still the grade of that room — a player deciding whether to
       * go back needs both facts, and dropping the danger word to make space
       * for the new one would trade a warning for a receipt.
       */
      const parts = [suffix, site.filed === true ? FILED_WORD : undefined].filter(
        (part): part is string => part !== undefined,
      );
      const label = parts.length === 0 ? site.name : `${site.name} · ${parts.join(' · ')}`;

      // A DARK PLATE UNDER THE TEXT. The region is mostly mid-green field and
      // pale road; a bare 10px label on that is unreadable at exactly the
      // moment somebody is squinting at it. Measured, not guessed at.
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10, 8, 19, 0.72)';
      ctx.fillRect(flip ? tx - w - 3 : tx - 3, dy - 7, w + 6, 14);

      // THE TEXT RECEDES WITH THE DOT. Dimming one and not the other reads as a
      // rendering fault rather than as a closed case — and the plate behind it
      // is deliberately NOT dimmed, because the label still has to be legible
      // against the field it sits on.
      const wasTextAlpha = ctx.globalAlpha;
      if (site.filed === true) ctx.globalAlpha = wasTextAlpha * FILED_ALPHA;
      ctx.fillStyle = grade ?? PALETTE.PARCHMENT;
      ctx.fillText(label, tx, dy);
      ctx.globalAlpha = wasTextAlpha;
    }
    ctx.textAlign = 'left';
  }

  /**
   * THE PARTY, UNDER YOUR OWN MARK AND OVER EVERYTHING ELSE.
   *
   * Painted before `self` so that two people standing on one tile resolve in the
   * only order that is never confusing: you are always the mark on top. A friend
   * hidden under your own token is a friend you go looking for.
   *
   * SMALLER THAN THE SELF MARK AND A DIFFERENT INK. The map already spends
   * `PALETTE.GOLD` on doors and `CROSSING_INK` on the way between maps; a party
   * mark that reused either would read as a place rather than a person.
   *
   * NAMED ONLY ON THE FULL SCREEN, exactly as the sites are — see `labelled`.
   * The minimap is 200px wide and three names would bury the country.
   */
  if (party !== undefined) {
    for (const mate of party) {
      const size = Math.max(2, cell);
      ctx.fillStyle = PARTY_INK;
      ctx.fillRect(ox + mate.x * cell, oy + mate.y * cell, size, size);
      if (labelled) {
        ctx.fillStyle = PARTY_INK;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(mate.name, ox + mate.x * cell + size / 2, oy + mate.y * cell - 2);
        ctx.textAlign = 'left';
      }
    }
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
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE ONE MARKER THAT IS NOT ON THIS SCALE AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A crossing is not a room, so it has no roster to weigh and no grade to earn —
 * `specFor` answers nothing for it, correctly. That put it in the gradeless
 * bucket with the settlements and drew it in `PALETTE.GOLD`, which is how the
 * entrance to the hardest country in the game came to look exactly like
 * Alderbrook.
 *
 * VIOLET, WHICH IS THE INDEX'S OWN COLOUR everywhere else in this client, and
 * therefore reads as "this is Index business" rather than as a fifth danger
 * step above grim. The scale still runs parchment -> gold -> amber -> crimson
 * and this is deliberately beside it rather than on the end of it.
 *
 * AND THE WORD IS WHAT ACTUALLY CARRIES IT. The note on `DANGER_INK` is the
 * rule: *"COLOUR IS NEVER THE ONLY CHANNEL... about one man in twelve cannot
 * tell the amber from the crimson"*. A player who cannot see this hue reads
 * `· another map` next to the dot, which is the whole message anyway.
 */
/**
 * THE INK FOR SOMEBODY YOU ARE PLAYING WITH.
 *
 * Not `GOLD` and not `CROSSING_INK`: this map already spends those on doors and
 * on the way between maps, and a mark in either would read as a PLACE. A party
 * mark has to read as a person at a glance, which means an ink nothing else on
 * this surface uses.
 */
const PARTY_INK = '#6fd3a8';

export const CROSSING_INK = '#9a7fd6';
const CROSSING_WORD = 'another map';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A CASE THIS PLAYER HAS ALREADY CLOSED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The map's job is to answer *"where should I go"*, and until now it answered
 * it identically on your first evening and your fifth: twenty-odd markers, no
 * mark on any of them, no way to tell the room you cleared last week from the
 * one you have never opened. See `world/casefile.ts`.
 *
 * DIMMED RATHER THAN RECOLOURED, and the grade is KEPT. A closed case is not a
 * different KIND of place and its danger word is still true — a player deciding
 * to go back to a `grim` room they have already done needs to know it is still
 * grim. So the marker keeps its colour and loses its emphasis, which is what a
 * map does with somewhere you have been.
 *
 * AND THE WORD IS STILL THE CHANNEL. `DANGER_INK`'s rule — *"about one man in
 * twelve cannot tell the amber from the crimson"* — applies to a dimmed hue far
 * harder than to a distinct one, so `filed` is printed. A player who cannot see
 * the dimming reads `· filed` and has the whole message.
 */
const FILED_ALPHA = 0.45;
const FILED_WORD = 'filed';

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
