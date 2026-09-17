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
import { TileCode, isWalkable, isSafeGround, BeaconKind } from '../../shared/protocol.ts';
import type { BeaconView, LevelView, RegionView, SiteView } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';

/** Where the minimap sits and how big it is allowed to get. */
export const MINIMAP_MARGIN = 8;
export const MINIMAP_MAX_W = 200;
export const MINIMAP_MAX_H = 130;

/**
 * ═══ WATER AND LAVA ARE WHAT UPSTREAM PAINTS AS WATER AND LAVA, v25 ═══
 * A grid's own `special_minimap` wins; otherwise it is wall if it blocks a move
 * and floor if it does not (tome/class/Grid.lua:128-134, engine/Grid.lua:42-46).
 * Only two of the themed codes carry one: deep water inherits BLUE from
 * `WATER_BASE` (data/general/grids/water.lua:128), and molten lava is RED
 * (data/general/grids/lava.lua:64). The seabed, the coral wall, the bubble, lava
 * floors and lava walls have none, so the Weir reads as rooms and corridors, not
 * as one blue rectangle. OUTERSPACE blocks a move and draws as wall; VOID is
 * walkable and draws as ground.
 */
const MINI_WATER: ReadonlySet<number> = new Set<number>([
  TileCode.WATER,
  TileCode.DEEPWATER,
  TileCode.POND_WATER,
]);
const MINI_LAVA: ReadonlySet<number> = new Set<number>([TileCode.MOLTEN_LAVA]);

/**
 * Four bands, chosen to survive being one pixel wide.
 *
 * Water is separated from wall because on a world map the coast is most of what
 * you navigate by, and a lake that looked like a mountain would make the whole
 * picture unreadable. Everything else collapses into walkable / blocking, which
 * is the only distinction a minimap owes the player.
 */
function miniFill(code: TileCode): string {
  if (MINI_WATER.has(code)) return '#141d33';
  if (MINI_LAVA.has(code)) return '#4a1a10';
  if (code === TileCode.ERASED) return '#0c0a14';
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BEFORE `isWalkable`, BECAUSE AN OPEN DOOR WOULD OTHERWISE DRAW AS ROAD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This is not a colour preference, it is a correctness fix, and the bug it
   * prevents is the exact one the `isSafeGround` note below warns about.
   * `DOOR_OPEN` is walkable and is not a `HAUNT`, so `isSafeGround` answers TRUE
   * for it — and the branch below would paint every opened doorway in `#8a8070`,
   * the SAFE NETWORK colour, whose whole meaning is *"nothing may lie in wait
   * here"*. A delve is the one place in the game where that promise is false,
   * and a doorway is the one tile in a delve where something most often is.
   *
   * ═══ AND THIS MAP DOES DRAW DELVES ═══
   * `MapPaint.seen` is documented as *"Absent means 'all of it', which is what
   * an inner-world wants"*, so an interior is drawn in full and every door on it
   * reaches this function. It would not have been caught by looking at the
   * overworld, which has no doors on it at all.
   *
   * The two values are the map-palette relatives of the playfield's amber
   * (`tileFill`, ported from `basic.lua:220`): findable at one pixel, and the
   * closed one louder, because a shut door is a thing you are looking FOR.
   */
  // A rock door is a shut door too (`door_opened`), and is looked for the same way.
  if (code === TileCode.DOOR || code === TileCode.ROCK_DOOR) return '#8a6134';
  if (code === TileCode.DOOR_OPEN) return '#4a3d2e';
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IS ON THE FLOOR — `Map.lua:490-521`, which draws five layers and not
   * one.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's minimap is not a picture of the terrain: `setupMinimapInfo` is
   * defined on Grid, Trap, Object AND Actor, and `updateMap` calls it for each
   * in turn. Ours drew the ground and the places and stopped, which made the map
   * answer "where am I" and "where can I go" and not the third question a player
   * opens it for — *"where was that thing"*.
   *
   * BOTH LISTS ARE ALREADY PER-VIEWER and neither is filtered here. Traps arrive
   * from `TrapsMsg`, which the server built against one actor's `knownBy`; loot
   * arrives from `GroundMsg`, which is gated on tiles that character has walked
   * past. Upstream gates the trap layer the same way and in the same place —
   * `if not self.actor_player or t:knownBy(self.actor_player)` — so a trap
   * nobody has met is absent rather than hidden.
   *
   * Absent means "nothing to draw", which is the overworld's answer: there are
   * no traps out there and the floor list is a delve's.
   */
  readonly traps?: readonly TileXY[];
  readonly loot?: readonly TileXY[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT IS STANDING ON IT — `tome/class/Actor.lua:872-880`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * function _M:setupMinimapInfo(mo, map)
   *   if map.actor_player and not map.actor_player:canSee(self) then return end
   *   if self.rank > 3 then mo:minimap(0xC0, 0x00, 0xAF) return end
   *   local r = map.actor_player and map.actor_player:reactionToward(self) or -100
   *   if r < 0 then mo:minimap(240, 0, 0)
   *   elseif r > 0 then mo:minimap(0, 240, 0)
   *   else mo:minimap(0, 0, 240) end
   * end
   * ```
   *
   * Ours drew ALLIES on the map (`partyMarks`, with their names) and nothing
   * else — so mid-fight the minimap showed your friends and not the thing
   * hunting them, which is backwards from what a map is opened for.
   *
   * ═══ MONSTERS ONLY, BECAUSE ALLIES ALREADY HAVE A RICHER TREATMENT ═══
   * Upstream's layer draws every actor; ours would then answer "where is my
   * teammate" twice, in two colours, from two lists. `partyMarks` wins that
   * question — it carries the NAME — so this carries the rest, and upstream's
   * friendly-green branch has nothing to draw.
   *
   * ═══ ALREADY FOV-GATED, AND NOT AGAIN HERE ═══
   * `map.actor_player:canSee(self)` is upstream's first line; ours is
   * `projectActors(world, eyes)`, which means the client never HOLDS a body it
   * cannot see. Re-testing on this side would be a second answer to a question
   * the server settled, and the one that drifts.
   */
  readonly actors?: readonly ActorMark[];
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE LAYER ON THIS MAP THAT THE FOG DOES NOT TAKE AWAY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every other list above is gated on `seen`, and the note on `seen` says why:
   * *"a map that hid the ground but kept the towns would give away exactly what
   * the fog is for"*. THIS ONE IS DELIBERATELY NOT, and it is the same ruling
   * that made props line-of-sight only (2026-09-17, `PropsMsg`): you may no
   * longer see the furniture through a wall, so you must not have to hunt for
   * the door either. A friendly face and the way in and out are the two things
   * a player is allowed to be told about a town they are standing in.
   *
   * ═══ THE DECISION WAS ALREADY MADE, ONCE, ON THE SERVER ═══
   * `beaconsFor` sends a friendly within `MINIMAP_REVEAL_RADIUS` and a way
   * on/out within that radius OR on ground this character has seen. NO HOSTILE
   * IS EVER IN THIS LIST. Re-testing any of that here would be a second copy of
   * a sight rule in the process that must never hold one — and the copy that
   * drifts. The painter draws what it is handed.
   *
   * ═══ THE WINDOW STILL CLIPS IT, AND THAT IS KNOWN AND KEPT ═══
   * `MINIMAP_RADIUS` is 16 and the reveal radius is 20, so a beacon 17 to 20
   * tiles out is culled by the window bounds below before an ink is ever
   * chosen. Raising the window to 20 keeps `cell` at 3 but grows
   * `minimapReserveH` from 119 to 143, and that function records the Case Log
   * vanishing mid-fight at 150. Sixteen tiles is already "relatively close",
   * which is what was asked for; the extra four are a server-side allowance
   * that the full-screen map does not draw either.
   *
   * ═══ AND THE CLIP IS NOT "17 TO 20". IT IS "ANYTHING PAST 16" ═══
   * Corrected from a rendered measurement: the way-out arm of `beaconsFor` is
   * near OR seen/remembered, and the memory half has NO BOUND. Standing at
   * 23,12 in Alderbrook the server sent six remembered entrance beacons at
   * y=46/47, 34 tiles off, and none of them could be drawn. That is a handful
   * of `{x,y,kind}` triples on a frame that already carries the site list, so it
   * is waste rather than a leak — and bounding the server to a number the CLIENT
   * owns would put the minimap's layout arithmetic into the gateway. The clip
   * lives here, and this is it written down honestly.
   *
   * ═══ THE MINIMAP ONLY, AND NOT THE WORLD MAP ═══
   * Beacons are about the floor you are STANDING ON. The full-screen map is
   * always the overworld's, so drawing a delve's beacons on it would be the
   * same confident lie `partyMarks` refuses to tell with instance coordinates.
   */
  readonly beacons?: readonly BeaconView[];
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

/** One body on the map, reduced to what decides its colour. */
export type ActorMark = {
  readonly x: number;
  readonly y: number;
  /** `self.rank > 3` upstream — the boss branch, which outranks the reaction. */
  readonly boss: boolean;
  /** `reactionToward == 0`. A townsfolk is hostile to nobody, not friendly. */
  readonly neutral: boolean;
};

/** `Trap:setupMinimapInfo` — `mo:minimap(240, 240, 0)`, engine/Trap.lua:60. */
const TRAP_INK = '#f0f000';
/** `Object:setupMinimapInfo` — `mo:minimap(0, 0, 240)`, engine/Object.lua:72. */
const LOOT_INK = '#0000f0';
/**
 * `Actor:setupMinimapInfo` — tome/class/Actor.lua:874-878.
 *
 * A BOSS OUTRANKS ITS REACTION, which is upstream's own order: the rank branch
 * `return`s before the reaction is ever computed. On a one-pixel cell that is
 * the right priority — "there is something here that will kill you" is a louder
 * fact than whose side it is on.
 *
 * Neutral shares the object blue upstream (both `0, 0, 240`) and is left
 * sharing it here: a shopkeeper and a dropped coat are both things you may walk
 * up to, and inventing a sixth colour to separate two harmless marks would
 * spend contrast the dangerous ones need.
 */
const BOSS_INK = '#c000af';
const HOSTILE_INK = '#f00000';
const NEUTRAL_INK = '#0000f0';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FRIENDLY FACE. AN INK NOTHING ELSE ON THIS SURFACE USES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PARTY_INK`'s rule, applied again: a mark has to be readable as its own kind
 * at a glance, which means an ink no other layer here spends. Every one that is
 * taken is taken for a reason that would be spoiled by sharing it —
 * `NEUTRAL_INK` `#0000f0` is upstream's OBJECT blue and this map already draws
 * loot in it, `PARTY_INK` `#6fd3a8` means somebody you are playing with,
 * `HOSTILE_INK` and `BOSS_INK` are the two "this will kill you" answers, and
 * `PALETTE.GOLD` is a place rather than a person.
 *
 * Cyan is what is left that survives three pixels against this map's terrain
 * bands, all of which are desaturated: field `#4e5a44`, road `#8a8070`, wall
 * `#2a2733`. It sits on the blue side of `PARTY_INK`'s mint.
 *
 * ═══ AND THE HUE IS THE WHOLE SEPARATION, BECAUSE THE TWO NEVER SHARE A MAP ═══
 * This said the INK ring was the second channel against a party mark. MEASURED
 * ON THE RENDERED CLIENT AND IT IS NOT: `main.ts` passes `party` to the WORLD
 * MAP only, and the world map is never handed `beacons` (`MapPaint.beacons`
 * says why). So a beacon and a party mark cannot appear on one surface, and the
 * ring is doing a different job — see `beaconGlyph`.
 *
 * OUTSIDE `PALETTE`, exactly as `TRAP_INK`, `LOOT_INK`, `PARTY_INK` and the
 * whole `DANGER_INK` ramp are: this map paints flat bands chosen for contrast
 * at one pixel rather than for fidelity to the art, and the palette is tuned
 * for the other job.
 */
const BEACON_FRIENDLY_INK = '#39c6e0';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A WAY OFF THIS MAP — `PALETTE.ORANGE`, which nothing else here spends.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In the palette rather than beside it, because there was a free entry that
 * fits: `ORANGE` is unused anywhere on this surface, and it is the furthest
 * readable step from `PALETTE.GOLD` (the settlements), `CROSSING_INK` (the way
 * between maps on the OVERWORLD) and the `DANGER_INK` amber.
 *
 * BOTH DIRECTIONS SHARE IT, ON PURPOSE. What a player is hunting for is "a way
 * off this floor"; which way it goes is the detail, and it is carried by the
 * SHAPE instead — see `beaconGlyph`. That is `DANGER_INK`'s own rule: *"about
 * one man in twelve cannot tell the amber from the crimson"*, so a fact this
 * map is asked for must never live in hue alone.
 */
const BEACON_WAY_INK = PALETTE.ORANGE;

/**
 * How one beacon is drawn: an ink, a side in pixels, and whether it is punched
 * hollow. The outline is always `PALETTE.INK` and always one pixel, so it is
 * not a field.
 */
export type BeaconGlyph = {
  readonly ink: string;
  /** The side of the coloured mark. The INK ring adds one pixel all round. */
  readonly size: number;
  /** A one-pixel ring of `ink` around an INK centre, rather than a solid block. */
  readonly hollow: boolean;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH MARK A BEACON GETS — TWO CHANNELS, BECAUSE THREE PIXELS IS THE BUDGET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The minimap runs at `cell = 3` (`minimapRect`: a 33-tile window in a 200x130
 * box). At that size a hue on its own is a smudge, so every beacon differs from
 * every other mark on this surface in SIZE or FILL as well as in colour:
 *
 *   FRIENDLY — `BEACON_FRIENDLY_INK`, one cell, ringed in INK.
 *   EXIT — `BEACON_WAY_INK`, a cell wider than a site dot, SOLID and ringed.
 *   ENTRANCE — the same ink and size, HOLLOW. The way back is a thing you note
 *     and walk away from; the way on is the thing you are looking for, so the
 *     louder of the two shapes goes to the exit.
 *
 * ═══ WHAT THE INK RING IS ACTUALLY FOR, MEASURED ═══
 * It is a KEYLINE against LIT ground, not a second channel against another
 * mark. On the map's bright bands — road `#8a8070`, and the settlement gold —
 * a 3px block of cyan with no outline loses its edges; the ring is what keeps
 * it square. On NEVER-SEEN ground it contributes nothing at all and needs to:
 * `UNSEEN` is `#0b0912` and `PALETTE.INK` is `#0a0813`, one step apart, so the
 * measured glyph over black is a bare 3px cyan square — which is legible,
 * because the fill is the loud part. The claim that used to live here (that the
 * ring told a friendly from a teammate) was false: the two lists never reach
 * the same surface. See `BEACON_FRIENDLY_INK`.
 *
 * THE FLOORS ARE NOT `cell`. At `cell = 1` (a full region, if this ever drew
 * beacons there) a one-pixel dot under a one-pixel ring is nothing at all, so
 * both kinds have a minimum that keeps the ring visible.
 *
 * PURE, AND EXPORTED FOR THE TEST. The choice is the whole feature — a beacon
 * drawn in the party's own green is a stranger a player walks up to expecting a
 * friend — and it is the part of this file that can be asserted rather than
 * scraped.
 */
export function beaconGlyph(kind: BeaconKind, cell: number): BeaconGlyph {
  if (kind === BeaconKind.Friendly) {
    return { ink: BEACON_FRIENDLY_INK, size: Math.max(3, cell), hollow: false };
  }
  return { ink: BEACON_WAY_INK, size: Math.max(4, cell + 1), hollow: kind === BeaconKind.Entrance };
}

export function paintMap(paint: MapPaint): number {
  const {
    ctx,
    level,
    rect,
    sites,
    self,
    framed,
    seen,
    windowRadius,
    labelled,
    regions,
    party,
    traps,
    loot,
    actors,
    beacons,
  } = paint;

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
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT IS LYING ON IT — `Map.lua:493-506`, in upstream's own two colours.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Trap:setupMinimapInfo` is `mo:minimap(240, 240, 0)` and
   * `Object:setupMinimapInfo` is `mo:minimap(0, 0, 240)` — yellow and blue,
   * carried across exactly, because on a one-pixel cell the colour is the whole
   * message and these two are already as far apart as two colours get.
   *
   * ═══ UNDER THE PLACES, OVER THE GROUND ═══
   * Upstream's layer order is terrain (1), trap (4), object (7), actor (10), and
   * this sits between the ground fill above and the site dots below. A site is a
   * destination and a piece of loot is a detour; the map should not let the
   * detour cover the destination.
   *
   * ═══ ONE CELL, NOT `dot` ═══
   * The sites below deliberately draw BIGGER than a cell so a settlement is not
   * lost among the roads. These do not: a trap is a fact about ONE tile and you
   * have to step around that tile exactly. A marker wider than the thing it
   * marks would be a map that lies about which square is dangerous.
   */
  const floorMark = (tiles: readonly TileXY[] | undefined, ink: string): void => {
    if (tiles === undefined) return;
    ctx.fillStyle = ink;
    for (const tile of tiles) {
      if (tile.x < win.x0 || tile.x > win.x1 || tile.y < win.y0 || tile.y > win.y1) continue;
      // THE FOG STILL APPLIES. Both lists are already per-viewer, but a remembered
      // tile can leave the `seen` set when a realm changes under a stale frame,
      // and a mark floating on unseen ground reads as a bug rather than as loot.
      if (seen !== undefined && !seen.has(`${tile.x},${tile.y}`)) continue;
      ctx.fillRect(ox + tile.x * cell, oy + tile.y * cell, cell, cell);
    }
  };
  // LOOT FIRST, SO A TRAP ON A PILE WINS. Upstream draws the object layer OVER
  // the trap, which is right when both have their own sprite; with one flat cell
  // each, the one you must not step on is the one that has to survive.
  floorMark(loot, LOOT_INK);
  floorMark(traps, TRAP_INK);

  /**
   * AND THE BODIES, OVER BOTH — `Map.lua:490-521`'s layer order puts the actor
   * (10) above the trap (4) and the object (7). A thing that is walking towards
   * you outranks a thing that is lying still, which is the same argument the
   * site loop below makes for a roamer keeping the alarm colour.
   */
  if (actors !== undefined) {
    for (const mark of actors) {
      if (mark.x < win.x0 || mark.x > win.x1 || mark.y < win.y0 || mark.y > win.y1) continue;
      if (seen !== undefined && !seen.has(`${mark.x},${mark.y}`)) continue;
      ctx.fillStyle = mark.boss ? BOSS_INK : mark.neutral ? NEUTRAL_INK : HOSTILE_INK;
      ctx.fillRect(ox + mark.x * cell, oy + mark.y * cell, cell, cell);
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
   * AND THE BEACONS, WHICH ARE THE ONE PASS ON THIS MAP WITH NO `seen` GUARD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * READ `MapPaint.beacons` BEFORE CHANGING THIS. Every loop above it drops a
   * mark on a cell outside `seen`, and each of those checks is load-bearing.
   * THIS ONE IS MEANT TO BE MISSING. A beacon is a per-viewer answer the SERVER
   * has already fogged — a friendly within `MINIMAP_REVEAL_RADIUS`, a way
   * on or out within that radius or on ground this character has walked — and
   * adding `seen.has()` here would silently delete the whole feature on exactly
   * the tiles it exists for: the door you have not found yet.
   *
   * THE WINDOW BOUNDS STILL APPLY, and that is not the fog. A mark outside the
   * drawn cells would be painted over the panel beside the map.
   *
   * UNDER THE PARTY AND UNDER YOU, over the sites. A person you are playing
   * with outranks a person you have merely been told about, and your own mark
   * outranks both — the order the party/self block below already argues for.
   */
  if (beacons !== undefined) {
    for (const beacon of beacons) {
      if (beacon.x < win.x0 || beacon.x > win.x1) continue;
      if (beacon.y < win.y0 || beacon.y > win.y1) continue;
      const glyph = beaconGlyph(beacon.kind, cell);
      const inset = Math.floor((glyph.size - cell) / 2);
      const bx = ox + beacon.x * cell - inset;
      const by = oy + beacon.y * cell - inset;
      // THE RING FIRST, AS A BOX UNDER THE MARK. A stroke would straddle the
      // pixel boundary and blur a three-pixel glyph into four grey ones; this
      // map draws in whole pixels for the reason `mapPlacement` gives.
      ctx.fillStyle = PALETTE.INK;
      ctx.fillRect(bx - 1, by - 1, glyph.size + 2, glyph.size + 2);
      ctx.fillStyle = glyph.ink;
      ctx.fillRect(bx, by, glyph.size, glyph.size);
      if (glyph.hollow) {
        ctx.fillStyle = PALETTE.INK;
        ctx.fillRect(bx + 1, by + 1, glyph.size - 2, glyph.size - 2);
      }
    }
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
