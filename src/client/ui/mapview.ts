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
import type { TileXY } from '../../shared/coords.ts';

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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THIS MAP PUTS ITS CELLS — one derivation, two readers.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `paintMap` draws cell `(x, y)` at `(ox + x * cell, oy + y * cell)`, and
 * `mapTileAt` inverts exactly that. They HAVE to be the same arithmetic: two
 * copies is a map drawn in one place and clicked in another, which
 * ui/partypanel.ts:93-99 records as the failure this project has already had
 * once — and here the misclick sends a player walking to the wrong tile.
 *
 * So the window, the cell size and the origin are computed here and nowhere
 * else.
 */
type MapPlacement = {
  readonly win: { x0: number; y0: number; x1: number; y1: number };
  /** Whole pixels per cell. Never fractional — see the note below. */
  readonly cell: number;
  readonly ox: number;
  readonly oy: number;
};

function mapPlacement(
  level: { readonly w: number; readonly h: number },
  rect: MapRect,
  self: TileXY | undefined,
  windowRadius: number | undefined,
): MapPlacement {
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
  return {
    win,
    cell,
    ox: rect.x + Math.floor((rect.w - mapW) / 2) - win.x0 * cell,
    oy: rect.y + Math.floor((rect.h - mapH) / 2) - win.y0 * cell,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH TILE A POINT ON THIS MAP IS OVER — Minimalist.lua:1639-1642.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE MINIMAP WAS DECORATIVE, AND UPSTREAM'S IS NOT ═══
 * `minimapRect` had no caller in any mouse handler: the map was painted every
 * frame and answered nothing. Upstream registers a mouse zone over its own —
 * left-click walks there (`game.player:mouseMove`), middle-click opens the full
 * map — and a minimap that cannot be clicked is a picture of a map.
 *
 * ═══ IT INVERTS `mapPlacement` AND NOTHING ELSE ═══
 * Same window, same cell size, same origin as the painter, because they are one
 * function. A second copy of this arithmetic would put the click a tile away
 * from the thing under the cursor on exactly the windows where the map is
 * clamped to an edge.
 *
 * NULL FOR A POINT OFF THE MAP, including one inside `rect` but outside the
 * drawn cells — the map is centred in its box and a clamped window can leave a
 * margin, so "inside the box" is not the same question as "over a tile".
 */
export function mapTileAt(
  level: { readonly w: number; readonly h: number },
  rect: MapRect,
  px: number,
  py: number,
  self?: TileXY,
  windowRadius?: number,
): TileXY | null {
  const { win, cell, ox, oy } = mapPlacement(level, rect, self, windowRadius);
  const x = Math.floor((px - ox) / cell);
  const y = Math.floor((py - oy) / cell);
  if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1) return null;
  return { x, y };
}

export function paintMap(paint: MapPaint): number {
  const { ctx, level, rect, sites, self, framed, seen, windowRadius, labelled, regions, party } =
    paint;

  const { win, cell, ox, oy } = mapPlacement(level, rect, self, windowRadius);

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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * DRAWN WHERE THE LABEL BELONGS, ONCE THE PLAYER HAS BEEN THERE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * This used to scan a region's rectangle and show the name once a fifth of
       * it had been walked. That was a good rule for boxes and it cannot survive
       * their loss: the country is irregular now and the wire carries an ANCHOR
       * rather than bounds, so there is no area left to take a fifth of.
       *
       * The anchor cell itself is the test, and it is a stricter and more honest
       * one: the name appears when you have stood in the place it names, rather
       * than when you have seen enough of a rectangle that happened to contain
       * it. `assertRegionsHoldGround` guarantees the anchor is inside its own
       * country, so "seen the anchor" cannot mean "seen somewhere else".
       */
      if (region.x < win.x0 || region.x > win.x1) continue;
      if (region.y < win.y0 || region.y > win.y1) continue;
      if (seen !== undefined && !seen.has(`${String(region.x)},${String(region.y)}`)) continue;

      const cx = ox + (region.x + 0.5) * cell;
      const cy = oy + (region.y + 0.5) * cell;
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

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND WHO IS IN THERE, ON ITS OWN LINE AND IN THE PARTY'S OWN INK.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `partyMarks` puts a mark on this map for every member standing ON it.
       * This is the other half: a member INSIDE a room is not on the map at all,
       * and without this the map's answer to *"where is everybody"* was silence
       * for exactly the people who most need finding.
       *
       * NOT APPENDED TO THE LABEL CHAIN ABOVE. That chain is facts about the
       * ROOM — its grade, whether you have filed it — and a person's name in the
       * same run of middots reads as a third property of the place rather than
       * as somebody who is in it. A separate line in `PARTY_INK` says "person"
       * with no words spent, and it is the SAME ink `partyMarks` uses, so green
       * means a friend everywhere on this surface.
       *
       * THE SERVER DID THE JOIN. See `SiteView.party`: six Redaction rooms share
       * a name with an Alderbrook one, so this cannot be matched up here.
       */
      const inside = site.party ?? [];
      if (inside.length > 0) {
        const who = inside.join(', ');
        const ww = ctx.measureText(who).width;
        ctx.fillStyle = 'rgba(10, 8, 19, 0.72)';
        ctx.fillRect(flip ? tx - ww - 3 : tx - 3, dy + 5, ww + 6, 12);
        ctx.fillStyle = PARTY_INK;
        ctx.fillText(who, tx, dy + 11);
      }

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MUCH VERTICAL SPACE THE MINIMAP ACTUALLY TAKES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The dock reserves this much before it places the Case Log beneath. It used to
 * be `MINIMAP_MAX_H + MINIMAP_MARGIN * 2 + 4` — derived from the CAP rather than
 * from the box, which is a guess wearing a derivation's clothes. `minimapRect`
 * floors its cell size, so on the 170x100 overworld the map draws 99x99 and the
 * reserve claimed 150: THIRTY-ONE PIXELS of nothing.
 *
 * That mattered exactly once, and badly. In combat the top HUD grows by the turn
 * cards (14 -> 60), and on any 384-tall logical viewport the band left for the
 * dock fell to 62 against a `DOCK_MIN_H` of 84 — so `logPanelRect` returned null
 * and the Case Log VANISHED the instant a fight began, taking the transcript of
 * who hit whom for how much with it. Swept across 9,440 window samples, 827 of
 * them (8.8%) had a log during free movement and none during a fight. Giving
 * back the thirty-one pixels the minimap never wanted covers the shortfall of
 * twenty-two with room to spare.
 *
 * IT IS STILL A RESERVE AND STILL UNCONDITIONAL — it does not shrink when the
 * world map is open, for the reason `logPanelRect` gives: a dock that re-laid
 * itself on a keypress is worse than one a few pixels short.
 */
export function minimapReserveH(viewW: number): number {
  const box = minimapRect(viewW);
  return box.y + box.h + MINIMAP_MARGIN + 4;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR YOU ARE STANDING NEXT TO, IF ANY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A player photographed the overworld and said it is hard to tell the area they
 * are standing in is a town. The art half of that is answered by `landmark`;
 * this is the other half, and it is the older gap: the board never says what a
 * place IS.
 *
 * Everything the game knows gets said somewhere ELSE. `nearestSites` speaks the
 * name, the bearing, the distance and the grade on arrival — and then it scrolls
 * away. The world map carries the grade permanently, behind a key. The solo
 * warning fires once you are already inside. None of those is on the screen at
 * the moment a player is standing beside a door deciding whether to open it,
 * which is the moment the fact is worth anything.
 *
 * ═══ ADJACENT, AND NOT THE CELL UNDERFOOT ═══
 * Stepping onto a site's own cell IS the door (`crossIntoSite`), so a body
 * standing on one has just come OUT. Prompting there would read as an
 * instruction to step off and back on, which is both wrong and annoying.
 *
 * ═══ A ROAMER IS NOT A DOOR ═══
 * A wandering danger carries `sprite`, is drawn as a token with a hostile ring,
 * and stepping onto it starts a fight rather than opening a room. It is already
 * legible as a threat; labelling it "step in" would invite exactly the wrong
 * act.
 *
 * ORDERED BY POSITION rather than by the order the server happened to send, so
 * two doors on the same corner do not swap places between frames.
 */
export function doorwayAt(
  sites: readonly SiteView[],
  self: { readonly x: number; readonly y: number } | null,
): SiteView | undefined {
  if (self === null) return undefined;
  return sites
    .filter(
      (s) =>
        s.sprite === undefined && Math.max(Math.abs(s.x - self.x), Math.abs(s.y - self.y)) === 1,
    )
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))[0];
}

/**
 * How that door reads on the status line.
 *
 * THE GRADE COMES ALONG WHEN THERE IS ONE. A town has no grade and inventing
 * "quiet" for one would imply the scale applies to it — `nearestSites` already
 * argues why: *"a 'quiet' beside every settlement would train a player to stop
 * reading the word"*.
 */
export function doorwayLine(site: SiteView): string {
  return site.danger === undefined
    ? `${site.name} — step in`
    : `${site.name} — ${site.danger} · step in`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE YOU ARE, WRITTEN ON THE SCREEN — `Game.lua:1497-1507`, `getZoneName`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream keeps the zone name as a standing GOLD label beside the minimap and
 * has done in both shipped UI sets: `uiset/Classic.lua:303-308` right-aligns it
 * at the top-right of the map, `uiset/Minimalist.lua:1654-1660` centres it over
 * the minimap. It is not a flourish on arrival — it is there the whole time you
 * are in the place, because "where am I" is a question a player asks on the
 * turn after they stopped paying attention, not on the turn they walked in.
 *
 * ═══ OURS SAID IT ONCE, OUT LOUD, TO NOBODY WATCHING ═══
 * `realmName` reached exactly one surface: the aria-live region. A player using
 * a screen reader was told where they were and a player looking at the screen
 * was not — the arrival line scrolls out of the Record within a few turns, and
 * after that nothing on the canvas named the room at all.
 *
 * ═══ IT FITS IN SPACE THAT WAS ALREADY RESERVED, WHICH IS THE WHOLE TRICK ═══
 * `minimapReserveH` ends `+ MINIMAP_MARGIN + 4` below the box — twelve pixels
 * the dock already refuses to place anything in, and that nothing draws in. The
 * label goes THERE rather than growing the reserve, and that is not tidiness:
 * that function's own docblock records the Case Log VANISHING the instant a
 * fight began because the reserve was thirty-one pixels too greedy, and the
 * repair left about nine to spare. A line of text costs eleven. Growing the
 * reserve to hold this would have put the transcript of who hit whom back on
 * the edge of disappearing, to make room for a label saying where it happened.
 */
export const ZONE_LABEL_FONT = '9px ui-monospace, Consolas, monospace';

/** The baseline for the zone label, inside the reserve and never past it. */
export function zoneLabelBaseline(viewW: number): number {
  const box = minimapRect(viewW);
  // `+ 10` of the twelve. The descender of a 9px face lands inside the last two.
  return box.y + box.h + 10;
}

/**
 * The name, shortened until it fits.
 *
 * RIGHT-ALIGNED TO THE MINIMAP'S EDGE and allowed to run left across empty
 * screen, so the common case is untouched — but a long name is CUT rather than
 * allowed to run under the turn cards, because the top-left of this strip is
 * where they appear the moment a fight starts.
 */
export function fitZoneLabel(
  measure: (text: string) => number,
  name: string,
  maxPx: number,
): string {
  if (maxPx <= 0) return '';
  if (measure(name) <= maxPx) return name;
  // A NAME CUT TO NOTHING IS WORSE THAN NO NAME. Below the width of an ellipsis
  // there is no honest shortening left, and a bare "…" beside the minimap reads
  // as a rendering fault rather than as a place.
  if (measure('…') > maxPx) return '';
  let cut = name;
  while (cut.length > 0 && measure(`${cut}…`) > maxPx) cut = cut.slice(0, -1);
  return cut.length === 0 ? '' : `${cut}…`;
}
