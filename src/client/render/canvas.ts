/**
 * The renderer. Backbuffer -> integer upscale -> letterbox.
 *
 * ===========================================================================
 * THE DEVICE-PIXEL-RATIO PROBLEM, WHICH IS THE WHOLE REASON THIS FILE IS SHAPED
 * LIKE THIS
 * ===========================================================================
 *
 * A canvas has TWO sizes, and pixel art only survives when they are related by
 * a whole number:
 *
 *   - the CSS box (`getBoundingClientRect()`), in CSS pixels, decided by layout;
 *   - the backing store (`canvas.width/height`), in device pixels, decided by us.
 *
 * The usual recipe — `canvas.width = cssW * dpr; ctx.scale(dpr, dpr)` and then
 * draw the world at whatever scale happens to fit — is exactly wrong here. It
 * produces a fractional transform (say 2.4x), so a 32px tile lands on 76.8
 * device pixels: some tile rows get 77 pixels and some get 76, so the same wall
 * is drawn two different thicknesses in the same frame, and every sprite edge
 * shimmers by a pixel as the camera moves. This is the single most commonly
 * botched part of a pixel-art web renderer, and it cannot be fixed downstream —
 * `image-rendering: pixelated` only decides HOW the browser resamples, not
 * whether resampling happens.
 *
 * So the world is never drawn at the display's scale. It is drawn once, at 1:1,
 * into an offscreen BACKBUFFER whose size is exactly the logical viewport
 * (viewportTilesW * 32 by viewportTilesH * 32). That buffer is then blitted to
 * the visible canvas exactly once per frame, magnified by an INTEGER factor:
 *
 *     scale = max(1, floor(min(deviceW / logicalW, deviceH / logicalH)))
 *
 * where deviceW/deviceH are CSS pixels TIMES devicePixelRatio. Working in
 * device pixels throughout — there is no `ctx.scale(dpr, dpr)` anywhere in this
 * file — is what makes dpr 1 and dpr 2 one code path instead of two.
 *
 * WHAT THIS GUARANTEES, and what it does not. Measured, with the default
 * 640x480 logical viewport:
 *
 *   css box     dpr 1        dpr 1.25     dpr 1.5      dpr 2
 *   900x600     1x  (640)    1x  (512)    1x  (427)    2x  (640)
 *   1280x720    1x  (640)    1x  (512)    2x  (853)    3x  (960)
 *   1280x960    2x (1280)    2x (1024)    3x (1280)    4x (1280)
 *                            ^ figures in brackets are the apparent width in CSS px
 *
 * The magnification is a whole number in every cell — that is the guarantee,
 * and it is the only one that matters for pixel art. The APPARENT size is not
 * constant: it is quantised, so a higher-density screen usually earns a bigger
 * integer and shows the world larger, and a fractional dpr can land on a
 * smaller apparent size than dpr 1 (the 1.25 column) because 1.25 * 640 is not
 * enough for 2x. That is the honest cost of integer scaling. The alternative —
 * locking scale to a multiple of dpr to hold apparent size fixed — is worse
 * here: at the 1.25 and 1.5 ratios Windows display scaling actually produces,
 * a multiple of dpr is not an integer, so it degrades to 1x on the machines it
 * was meant to help.
 *
 * `floor` means the magnified image is almost never exactly the size of the
 * canvas. The remainder is LETTERBOX: bars of INK, split evenly, with the
 * destination origin floored to a whole device pixel so the blit itself is not
 * half-pixel offset. Giving up those bars is the price of crispness, and it is
 * the right trade for a game made of 32px tiles.
 *
 * When the canvas is SMALLER than the logical viewport (a 400x300 css box at
 * dpr 1), `max(1, …)` holds the scale at 1 and the blit is cropped evenly on
 * all four sides rather than being resampled down. Cropping loses tiles at the
 * edges; a fractional downscale would lose the art itself. Below that size the
 * fix is a smaller viewport, not a blurrier one.
 *
 * `imageSmoothingEnabled = false` is set on BOTH contexts, and — the part that
 * bites — is re-set after every resize, because assigning to `canvas.width`
 * resets the entire 2D context state, smoothing included.
 *
 * ===========================================================================
 * ART SEAM
 * ===========================================================================
 * There is no tile atlas in the repo yet, so `paintTiles` fills flat palette
 * rectangles. When real tiles land, that one function becomes a `TileCode ->
 * atlas cell` blit and nothing else in this file changes: the camera, the
 * anchoring, the draw order and the scaling are all already atlas-shaped.
 */

import { inBounds } from '../../shared/coords.ts';
import { tileAt } from '../../shared/level.ts';
import { ActorRank, TileCode, isWalkable } from '../../shared/protocol.ts';
import { TILE_PX, ZOOM_MAX, ZOOM_MIN } from '../../shared/version.ts';
import type { TileXY } from '../../shared/coords.ts';
import type {
  ActorView,
  DownedView,
  EffectView,
  ItemTier,
  LevelView,
  ProjectileView,
  SiteView,
} from '../../shared/protocol.ts';
import type { Sprite, SpriteSource } from './assets.ts';

/** Sampled from the real art. The only colours this game is allowed to use. */
export const PALETTE = {
  INK: '#0a0813',
  VOID: '#21082e',
  PANEL: '#312938',
  SLATE: '#36303e',
  GREY: '#5c5d63',
  GREY_HI: '#99999f',
  SILVER: '#a4a4ab',
  VIOLET: '#63409e',
  VIOLET_HI: '#a670e0',
  ORANGE: '#ff8427',
  GOLD: '#ffe479',
  PARCHMENT: '#ede6c2',
  BONE: '#c5c2b4',
  /**
   * THE ONLY ALARM COLOUR. Reserved for one fact: hostiles are engaged.
   *
   * It is spent by the combat banner and by the crimson ring around the
   * playfield (ui/combatbanner.ts) and by nothing else — a palette entry that
   * means "combat is on" wherever it appears is worth more than one that also
   * decorates a low-health bar, because the whole point of the ring is that a
   * player can answer "are we in a fight?" from peripheral vision.
   */
  CRIMSON: '#961e2c',
} as const;

/** Tile overlay markers. Ids are `ui_tile_marker_${kind}` in the manifest. */
export const MarkerKind = {
  Cursor: 'cursor',
  Valid: 'valid',
  Invalid: 'invalid',
  Aoe: 'aoe',
  MinRange: 'minrange',
} as const;
export type MarkerKind = (typeof MarkerKind)[keyof typeof MarkerKind];

export type TileOverlay = {
  readonly x: number;
  readonly y: number;
  readonly kind: MarkerKind;
};

/**
 * One cell of the TARGETING overlay — the pass that runs between the tiles and
 * the actors.
 *
 * WHY IT IS A SEPARATE TYPE FROM `TileOverlay`, AND A SEPARATE PASS. The sweep
 * beat's markers (render/sweep.ts) are EMPHASIS: they flash for 240 ms on top of
 * everything to say "this is what just happened", and being briefly louder than
 * a token is the whole point of them. A targeting ring is the opposite — it is
 * GROUND PAINT that stays on screen for as long as the player deliberates, and a
 * ring drawn over the tokens would hide the monster being aimed at behind the
 * marker meaning "you may aim here". So the ring goes down with the floor, and
 * the only part of it allowed above an actor is the cursor's corner ticks, which
 * frame a tile rather than fill it.
 *
 * `shaded` carries LOS-greying, which deliberately is NOT a marker: "in range
 * but not visible" is the absence of an option, and drawing an extra symbol for
 * it would make an unavailable tile busier than an available one. A wash of INK
 * under whatever marker the cell has reads as "behind something" at a glance.
 */
export type TargetCell = {
  readonly x: number;
  readonly y: number;
  /** Marker art to blit, or null when the cell is only washed. */
  readonly marker: MarkerKind | null;
  /** In range, out of sight. An ink wash, painted UNDER the marker. */
  readonly shaded: boolean;
};

/**
 * The HUD layer, as a PAINTER rather than as data.
 *
 * It is handed the BACKBUFFER context and the logical size, and runs after the
 * world and before the present blit — so the party strip is magnified by the
 * same integer factor as the art, sits on the same pixel grid, and cannot
 * shimmer independently of it.
 *
 * A function rather than a `hud: TurnBarView` field because the direction of
 * knowledge is ui/ -> render/ and must never be both: the renderer would
 * otherwise have to import the party strip, the party strip already imports the
 * palette from here, and the resulting cycle is exactly the kind that survives
 * bundling and then dies under Node's type-stripping loader. This way the
 * renderer knows there is a layer above the world and nothing about what is on
 * it — the hotbar and the log land the same way in M3 and M4.
 */
export type HudPainter = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/**
 * SOMEBODY POINTED HERE (`pinged`, M4). A marker and a name, nothing else.
 *
 * It carries the pointer's NAME rather than their id because the renderer has no
 * actor lookup and must not grow one — the caller already has the map, and a
 * marker whose label said `p_3f9c` would be a marker nobody can act on.
 */
export type PingMarker = {
  readonly x: number;
  readonly y: number;
  /** Who pointed. Drawn under the marker; empty for an unknown actor. */
  readonly label: string;
};

/**
 * A PILE ON THE FLOOR (v10). One mark per TILE, not one per item.
 *
 * The `ground` frame is a flat list of items each carrying its own `cell`, and
 * `GroundItemView`'s own note says the tuple is "the value the client groups by
 * to draw ONE pile marker on a tile holding three things". That grouping is the
 * caller's, for the reason `PingMarker` above carries a name rather than an id:
 * the renderer has no game state and must not grow any.
 *
 * `count` and `tier` are the two things the mark says, and both are drawn as
 * SHAPE as well as colour — see `paintLoot`.
 */
export type LootMarker = {
  readonly x: number;
  readonly y: number;
  /** How many items are on the tile. Two or more draws the pile's second edge. */
  readonly count: number;
  /**
   * The best tier on the tile. IT COMES OFF THE WIRE AND IS NEVER INFERRED —
   * `GroundItemView.tier` exists precisely so the browser does not hold a table
   * of which items are rare (shared/protocol.ts's `ItemTier`).
   */
  readonly tier: ItemTier;
};

/** Everything one frame needs. The renderer holds no game state of its own. */
export type Scene = {
  readonly level: LevelView | null;
  /**
   * Places on THIS map you can walk into, drawn as markers over the terrain.
   *
   * THE OVERWORLD'S WHOLE JOB IS TELLING YOU WHERE THINGS ARE. The first
   * version kept sites server-side on the reasoning that a destination is
   * something a player earns by treading on it — a good rule for a dungeon and
   * a terrible one for a world map, which left the region with no towns and no
   * dungeon mouths on it at all. FF7 and ToME both draw their settlements; the
   * discovery is in the journey, not in the existence of the place.
   */
  readonly sites?: readonly SiteView[];
  readonly actors: readonly ActorView[];
  /** Which actor the camera follows. Null before `welcome` arrives. */
  readonly selfId: string | null;
  /**
   * The targeting ring, the `min_range` hole, the LOS wash and the AoE preview.
   * Painted in array order, BELOW the actors — see `TargetCell`.
   */
  readonly targeting?: readonly TargetCell[];
  /**
   * The targeting cursor's tile. Drawn as four corner ticks ABOVE the actors, so
   * the one thing the player is steering is never lost behind a token — which is
   * exactly the tile a token is most likely to be standing on.
   */
  readonly cursor?: TileXY | null;
  /**
   * CLICK-TO-TRAVEL's ROUTE PREVIEW — the tiles still AHEAD of the walker, in
   * walk order, never including the tile they are standing on.
   *
   * GROUND PAINT. It is painted immediately after `targeting` and BELOW the
   * y-sorted token pass, for the reason `TargetCell`'s header gives at length:
   * an overlay above the tokens hides the thing it is about, and here that thing
   * is the monster whose appearance is supposed to STOP the walk. A route drawn
   * over the tokens would cover the interruption it exists to respect.
   *
   * It is advisory in exactly the sense input/targeting.ts claims for itself —
   * the server re-validates every step and a wrong path simply gets its move
   * refused — so it is drawn small and faint rather than as an authoritative
   * line. Absent means "not travelling"; an empty array means the same thing and
   * costs nothing, because the machine that produces it empties on arrival.
   */
  readonly path?: readonly TileXY[];
  /**
   * Where the walk ENDS — the tile that will actually be stood on, already
   * adjusted for the walk-up-to case, or null when nothing is being travelled to.
   *
   * The one part of the preview allowed ABOVE the y-sorted tokens, beside
   * `cursor` and for the identical reason: it is drawn as corner ticks that
   * FRAME the tile rather than fill it, so the destination stays findable when
   * something is standing on it — which for a walk-up-to is the normal case,
   * since it deliberately stops one tile short of a body.
   */
  readonly pathEnd?: TileXY | null;
  /** The sweep beat's markers. Emphasis, drawn on top of everything. */
  readonly overlays?: readonly TileOverlay[];
  /**
   * M4 — WHO IS ON THE FLOOR, keyed by actor id. Absent from the map means on
   * their feet, which is the common case and costs nothing to represent.
   *
   * It replaces the under-token RING rather than sitting on top of it: a body
   * with a countdown running is not "an ally, but faint", it is a different kind
   * of thing on the board and it gets its own 32x32 silhouette
   * (`ui_marker_downed` / `ui_marker_erased`, carried in `DownedView.marker`).
   * The prone sprite itself needs nothing here — the server swaps
   * `ActorView.sprite` to `chr_player_<class>_downed_s` when the body goes down,
   * so the ordinary blit already draws a 32x24 body lying on the tile.
   */
  readonly downed?: ReadonlyMap<string, DownedView>;
  /**
   * M4 — STATUS PIPS, keyed by actor id. See `paintStatusPips` for what is
   * deliberately NOT drawn here.
   */
  readonly effects?: ReadonlyMap<string, readonly EffectView[]>;
  /** M4 — live `point` markers. Emphasis, on top, with the pointer's name. */
  readonly pings?: readonly PingMarker[];
  /**
   * v10 — WHAT IS LYING ON THE FLOOR, one mark per tile, complete and absolute
   * (shared/protocol.ts's `GroundMsg`): absent or empty both mean the floor is
   * clear, and the frame is a REPLACEMENT rather than a patch.
   *
   * GROUND PAINT, AND SO IT IS PAINTED WITH THE GROUND — below the y-sorted
   * tokens, in the same band as the targeting ring and the travel route, for the
   * reason `TargetCell` gives at length. `Scene.projectiles` is the one overlay
   * that argues its way ABOVE the tokens and the argument does not transfer: an
   * orb is IN THE AIR and is the thing you are being asked to step out of the
   * way of, while a coat is UNDER whoever is standing on it. A pile drawn over a
   * body would hide the body, and the body is the thing that can kill you.
   *
   * It is painted AFTER the travel route rather than before, so a route drawn
   * across a pile does not hide the pile — the pile is frequently what the route
   * was drawn towards.
   */
  readonly loot?: readonly LootMarker[];
  /**
   * v7 — WHAT IS IN THE AIR. Every orb currently in flight, at the tile it is on
   * RIGHT NOW, complete and absolute (shared/protocol.ts's `ProjectilesMsg`):
   * absent or empty both mean the sky is clear.
   *
   * ABOVE THE Y-SORTED TOKENS, which makes it the one overlay in this file that
   * is neither ground paint nor emphasis. `TargetCell` and `Scene.path` both
   * argue at length that an overlay drawn over a token hides the thing it is
   * about — and both are right, because what those two are about is the monster
   * standing there. THIS one is about the orb, and the orb is IN THE AIR: it is
   * passing over the tile, not painted on it, and it is the only thing on screen
   * the player is being asked to step out of the way of. An orb hidden behind
   * the wraith that fired it is a counterplay that does not exist.
   *
   * Below the pings, which stay the topmost layer for the reason `paintPing`
   * gives: a person pointing outranks the game.
   */
  readonly projectiles?: readonly ProjectileView[];
  readonly hud?: HudPainter;
};

export type Viewport = {
  readonly tilesW: number;
  readonly tilesH: number;
};

/**
 * 20x15 tiles = 640x480 logical pixels.
 *
 * The trade is fixed by integer scaling: a SMALLER logical viewport reaches a
 * higher integer magnification in the same window (so the art reads better) but
 * shows less of the map. 640x480 hits scale 2 in a ~1280x960 device-pixel box,
 * which is an ordinary Discord activity window at dpr 2 and a large one at
 * dpr 1. Change it here, in one place, if playtesting says otherwise.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20x10, DOWN FROM 20x15 — BECAUSE PLAYTESTING SAID OTHERWISE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The note above invites exactly this change, and a player made the case: the
 * tiles read much smaller than Tales of Maj'Eyal's and the world did not fill
 * the space. The lever is HEIGHT, because a Discord activity is wide and short —
 * `fitScale` takes the MINIMUM of the two ratios, so 15 rows of guaranteed
 * viewport (480 logical pixels) was the number holding the magnification down.
 *
 * MEASURED, on the window the screenshot came from (1159x551 CSS):
 *
 *     tilesH 15 -> minLogicalH 480 -> 1102/480 = 2.29 -> scale 2 -> 32 CSS px
 *     tilesH 10 -> minLogicalH 320 -> 1102/320 = 3.44 -> scale 3 -> 48 CSS px
 *
 * and on an ordinary 1280x720 at dpr 1, 720/320 = 2.25 clears scale 2 with room
 * to spare, so a window a little under 720 does not fall back to 1x.
 *
 * WIDTH STAYS AT 20 ON PURPOSE. `ui/hotbar.ts` and `ui/xpbar.ts` both lay out
 * against a 640-pixel floor and name `DEFAULT_VIEWPORT.tilesW` while doing it;
 * narrowing the guarantee would quietly eat their slack. Height was the binding
 * constraint anyway, so there is nothing to buy by touching width.
 */
export const DEFAULT_VIEWPORT: Viewport = { tilesW: 20, tilesH: 10 };

export type RendererOptions = {
  readonly canvas: HTMLCanvasElement;
  readonly sprites: SpriteSource;
  readonly viewport?: Viewport;
};

/** Exposed for the status line and for eyeballing the scaling maths in devtools. */
export type RendererMetrics = {
  readonly logicalW: number;
  readonly logicalH: number;
  readonly deviceW: number;
  readonly deviceH: number;
  readonly dpr: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
};

export type Renderer = {
  /** Re-measure the CSS box and dpr. Returns true if anything changed. */
  readonly resize: () => boolean;
  /**
   * Move the zoom to a whole step and re-lay the board. Returns the step
   * actually taken after clamping, so a caller can tell "already at the limit"
   * from "moved" without keeping its own copy of the bounds.
   */
  readonly setZoom: (next: number) => number;
  /** The current zoom step. -1 out, 0 default, +1 in. */
  readonly zoom: () => number;
  readonly draw: (scene: Scene) => void;
  readonly metrics: () => RendererMetrics;
  /**
   * A pointer position (a MouseEvent's `clientX`/`clientY`) -> the point in the
   * LOGICAL BACKBUFFER it lands on, or null when it is on the letterbox bars.
   *
   * This is the coordinate space the HUD is drawn in, so it is what a hotbar
   * hit test wants. `tileAtClient` is this plus the camera; having one inverse
   * transform with two exits is what stops the HUD and the world from
   * disagreeing about where the pointer is by an integer scale factor.
   */
  readonly backbufferPoint: (clientX: number, clientY: number) => TileXY | null;
  /**
   * A pointer position (a MouseEvent's `clientX`/`clientY`) -> the tile under
   * it, or null when the pointer is on the letterbox or off the map.
   *
   * IT LIVES HERE BECAUSE THE CAMERA DOES. Undoing the transform means undoing
   * the letterbox offset, the integer scale AND the camera clamp, and all three
   * are computed in this file — a second copy in the input layer would be a
   * second copy of `cameraAxis`, and it would go wrong first at the map edges
   * where the clamp bites. It reads the camera from the LAST draw, which is
   * correct by construction: the pixels the player is pointing at ARE the last
   * frame.
   */
  readonly tileAtClient: (clientX: number, clientY: number) => TileXY | null;
};

/** Thickness of the lit top edge that makes a wall read as solid. */
const WALL_EDGE_PX = 2;
/** Tiles of slack when culling actors, so a tall sprite does not pop at the edge. */
const ACTOR_CULL_MARGIN_PX = TILE_PX * 3;
/**
 * How dark an out-of-sight cell goes. Sampled to sit between ToME's own
 * `color_shown` and `color_obscure` (Map.lua:68-69) once the palette is applied:
 * dark enough to read as unavailable at a glance, light enough that the floor
 * grid underneath is still countable, because counting tiles is how a player
 * measures a throw.
 */
const LOS_SHADE_ALPHA = 0.55;
/** Corner ticks on the cursor tile: arm length and thickness, in logical px. */
const CURSOR_TICK_PX = 8;
const CURSOR_TICK_THICK = 2;

/**
 * THE TRAVEL PREVIEW'S DOT: size, its centring inset, and how far it fades.
 *
 * Small and translucent on purpose, twice over. The route is drawn UNDER the
 * tokens, so anything larger competes with the actors it is routing between;
 * and `paintTiles` puts a one-pixel SLATE grid on every floor tile because
 * counting tiles is how a player measures a move, so a dot that filled the cell
 * would take away the measurement the preview is helping with.
 *
 * The inset is ROUNDED rather than left as a division: an odd dot size would
 * otherwise land the fill on a half pixel, which is precisely the fractional
 * sampling the backbuffer exists to prevent (see the header).
 */
const PATH_DOT_PX = 6;
const PATH_DOT_INSET = Math.round((TILE_PX - PATH_DOT_PX) / 2);
const PATH_DOT_ALPHA = 0.7;

/**
 * AN ORB IN FLIGHT: size and its centring inset.
 *
 * TWO PIXELS BIGGER THAN THE ROUTE DOT, AND AT FULL OPACITY, which is the whole
 * difference between the two and is deliberate in both directions. The route
 * preview is advisory and translucent because it is a plan the player may drop;
 * this is a thing that is going to land on somebody in two turns, and it is
 * drawn over the token pass rather than under it. A translucent orb over a
 * sprite would read as part of the sprite.
 *
 * It stays SMALL regardless: `paintTiles` puts a one-pixel SLATE grid on every
 * floor tile because counting tiles is how a player measures a move, and a
 * measurement is exactly what somebody works out when an orb is three tiles
 * away. A dot that filled the cell would take away the thing it is asking for.
 *
 * The inset is ROUNDED rather than left as a division, for the same reason the
 * route dot's is: an odd size would land the fill on a half pixel, which is the
 * fractional sampling the backbuffer exists to prevent (see the header).
 */
const ORB_DOT_PX = 8;
const ORB_DOT_INSET = Math.round((TILE_PX - ORB_DOT_PX) / 2);

/**
 * A PILE ON THE FLOOR: how big the mark is, per tier.
 *
 * TIER IS ENCODED TWICE — AS SIZE AND AS BRIGHTNESS — AND THAT IS THE RULE
 * RATHER THAN BELT AND BRACES. ui/partypanel.ts:78-92 states it: never colour
 * alone. A four-pixel mark on a 32-pixel tile is at the limit of what a hue can
 * carry anyway, and the two encodings are monotone in the same direction, so a
 * rare drop is the biggest AND the brightest thing on the floor whether the
 * player is red-green colourblind, is playing in greyscale, or is looking at the
 * tile out of the corner of their eye.
 *
 * IT STAYS SMALL REGARDLESS. `paintTiles` puts a one-pixel SLATE grid on every
 * floor tile because counting tiles is how a player measures a move, and a mark
 * that filled the cell would take away the measurement — the same reason the
 * route dot and the orb are small.
 */
const LOOT_DOT_PX: Readonly<Record<ItemTier, number>> = {
  common: 5,
  uncommon: 7,
  rare: 9,
};

/**
 * ...and what colour it is, on the same three-step ramp.
 *
 * A BRIGHTNESS RAMP OFF THE EXISTING PALETTE, chosen by elimination and stated
 * so nobody re-litigates it. GOLD is this file's affirmative/cursor colour and is
 * already spent on the player's own route and targeting bracket — a floor item in
 * gold reads as your own aim. CRIMSON is reserved by `PALETTE` for the single
 * fact "hostiles are engaged" and is spent on the playfield ring. VIOLET_HI *is*
 * the missing-asset box, so a mark painted in it is indistinguishable from a
 * broken manifest. ORANGE is the orb's, and an orb and a pile are the two things
 * on the map that must never be confused for one another — one is arriving and
 * one is waiting.
 *
 * That leaves the parchment ramp, which nothing on the MAP spends, and which is
 * monotone: 0x99 -> 0xc5 -> 0xed.
 */
const LOOT_DOT_INK: Readonly<Record<ItemTier, string>> = {
  common: PALETTE.GREY_HI,
  uncommon: PALETTE.BONE,
  rare: PALETTE.PARCHMENT,
};

/** How far the second edge of a pile of two or more is offset, in pixels. */
const LOOT_PILE_OFFSET = 3;

/**
 * STATUS PIPS OVER A TOKEN — the cap, the size and the spacing.
 *
 * FOUR IS THE CAP AND IT IS THE WHOLE REASON THESE ARE PIPS. The party panel
 * draws real 24x24 badges because it has 200 pixels of row to do it in; a token
 * has 32, and a heavily-debuffed actor wearing six of them disappears underneath
 * its own status display — which is the precise moment the player most needs to
 * see where it is standing. So the map gets a bounded column of dots and the
 * panel gets the identities.
 *
 * The fifth-and-beyond pip is drawn HOLLOW rather than dropped, so "there is
 * more on this than you can count" is itself visible. Hollow-versus-solid is a
 * shape difference, which is the same rule ui/resource.ts applies to an empty
 * pip and ui/turnbar.ts applies to the four turn chips.
 */
const PIP_MAX = 4;
const PIP_SIZE = 4;
const PIP_STEP = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `getContext` returns `CanvasRenderingContext2D | null` (null on a canvas that
 * already has a WebGL context, or when the tab has lost its GPU process). The
 * null check has to happen HERE rather than after both calls: a narrowing done
 * in the factory body is not carried into the closures the factory returns, so
 * the type has to be non-null at the point of declaration.
 *
 * `alpha: false` on both contexts — nothing behind either canvas is ever
 * visible, and it lets the compositor skip a blend per frame.
 */
function require2dContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = target.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('canvas 2D context unavailable');
  return ctx;
}

/**
 * ART SEAM: flat colours until there is an atlas.
 *
 * An exhaustive switch with no `default` on purpose — when DOOR or WATER is
 * added to `TileCode`, this stops compiling and names itself, instead of
 * quietly painting the new terrain as floor. THAT IS EXACTLY WHAT HAPPENED when
 * Alderbrook's thirteen overworld codes landed, which is the whole reason the
 * `default` is still absent after this file doubled in length.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OVERWORLD COLOURS OBEY ONE RULE: WALKABLE IS LIGHTER THAN BLOCKING
 * ═══════════════════════════════════════════════════════════════════════════
 * A player answers "can I walk there?" hundreds of times an evening, at a
 * glance, while talking to friends. That answer has to come from VALUE, not
 * from hue and not from recognising a building — the same rule the tileset
 * brief puts on the real art (ART-OVERWORLD.md § 4.2), stated here so the
 * stand-in and the finished set read the same way and swapping one for the
 * other is not a re-learning exercise.
 *
 * These are stand-ins and they are meant to be replaced by `tile_ow_*` sprites.
 * They are NOT placeholders in the violet-box sense: a city drawn in these is
 * legible and playable, which is what lets the overworld ship before the art
 * does.
 *
 * CRIMSON is absent, as everywhere else — it means "hostiles are engaged" and
 * the overworld has none, so a crimson cell would be a lie a player acts on.
 */
/**
 * TileCode -> the sprite id(s) that may draw it. The ART SEAM, finally open.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INTERIORS STAY FLAT. FLOOR AND WALL ARE ABSENT HERE ON PURPOSE, FOREVER.
 * ═══════════════════════════════════════════════════════════════════════════
 * The overworld is a fixed, hand-authored city, so it can afford — and wants —
 * real terrain art. An inner-world is the opposite: instanced, disposable, and
 * headed for a generator. Flat palette cells are the right look for that and
 * not a placeholder for a better one:
 *
 *   A GENERATOR NEEDS NO ART BUDGET. Every new room shape, corridor width and
 *   floor plan works on the day it is written, because FLOOR and WALL are the
 *   whole vocabulary. Tiling art would make each generator change an art
 *   commission, which is how procedural content quietly stops being made.
 *   NO SEAM PROBLEM, NO VARIANT PROBLEM, NO EDGE CASES. A generated floor is
 *   full of one-tile nooks and ragged edges — precisely where a seamless
 *   tileset looks worst and needs the most per-case work.
 *   AND THE TWO PLACES READ AS DIFFERENT PLACES. Stepping from a drawn city
 *   into flat violet geometry says "you are inside the Index's copy of this"
 *   more plainly than any amount of matching art would.
 *
 * So: a code with no entry here has no art and never will have; a code WITH an
 * entry draws from the tileset when the file is on disk and falls back to
 * `tileFill` when it is not. Both states are correct and shippable, which is
 * what lets the overworld exist before its art does — see `paintTerrain`.
 *
 * MORE THAN ONE ID MEANS INTERCHANGEABLE VARIANTS, picked per cell by position.
 * Only cobble has them, and only because it is the most repeated sprite in the
 * game by a wide margin. They must be indistinguishable in VALUE — a lighter
 * second cobble would read as a different kind of ground, not as texture.
 *
 * Ids are exactly what ART-OVERWORLD.md asks Sol for. A file named anything
 * else will not draw, and will not error either: it will simply keep showing
 * the flat colour, which is the one failure mode worth knowing about here.
 */
/**
 * The marker families the client can draw. Matched against `SiteView.marker`,
 * with anything unrecognised falling back to `gate` — a door is the right guess
 * for an unknown kind of place, and drawing nothing is not.
 */
/**
 * Marker family -> the sprite that draws it.
 *
 * A MAP RATHER THAN A SET, because the two names are allowed to differ and
 * currently do. `town` is the right word for what a settlement IS on a world
 * map; `tile_ow_site_office` is the art that exists, drawn for the first brief
 * as "the detective's office door — the one warm light on the map", which is
 * exactly what a settlement should read as from outside. Renaming the family to
 * match the file would make the DATA wrong to keep the art tidy.
 *
 * A dedicated `tile_ow_site_town` — a cluster of roofs rather than a doorway —
 * would read better at world-map scale. Until it exists this is not a
 * placeholder, it is a deliberate reuse, and swapping it is one line here.
 */
const SITE_MARKERS: ReadonlyMap<string, string> = new Map([
  // Three SIZE TIERS, and they are told apart by silhouette rather than detail
  // — they are read in peripheral vision at whatever zoom the player is at.
  // Measured on delivery: 294px / 430px / 571px of ink, strictly increasing.
  ['village', 'tile_ow_site_village'],
  ['town', 'tile_ow_site_town'],
  ['city', 'tile_ow_site_city'],
  ['mine', 'tile_ow_site_mine'],
  ['ruin', 'tile_ow_site_ruin'],
  ['office', 'tile_ow_site_office'],
  ['gate', 'tile_ow_site_gate'],
  ['stair', 'tile_ow_site_stair'],
  ['altar', 'tile_ow_site_altar'],
  ['archive', 'tile_ow_site_archive'],
  ['breach', 'tile_ow_site_breach'],
]);

export const ROAD_BY_MASK: readonly (string | null)[] = [
  null, // 0  — nothing to connect to; the cobble under it is the whole tile
  'tile_ow_road_n',
  'tile_ow_road_horizontal',
  'tile_ow_road_ne',
  'tile_ow_road_vertical',
  'tile_ow_road_vertical',
  'tile_ow_road_se',
  'tile_ow_road_t_e',
  'tile_ow_road_horizontal',
  'tile_ow_road_nw',
  'tile_ow_road_horizontal',
  'tile_ow_road_t_n',
  'tile_ow_road_sw',
  'tile_ow_road_t_w',
  'tile_ow_road_t_s',
  'tile_ow_road_cross',
];

/**
 * The rail set is smaller because the line needs less: measured over the
 * redesigned moor it uses exactly six mask values (1, 3, 4, 5, 10, 12), and
 * those six have art. The rest fall back along the dominant axis rather than
 * being left blank, so a future junction draws as track instead of a gap.
 */
export const RAIL_BY_MASK: readonly (string | null)[] = [
  null,
  'tile_ow_rail_n',
  'tile_ow_rail_horizontal',
  'tile_ow_rail_ne',
  'tile_ow_rail_s',
  'tile_ow_rail_vertical',
  'tile_ow_rail_vertical',
  'tile_ow_rail_vertical',
  'tile_ow_rail_horizontal',
  'tile_ow_rail_n',
  'tile_ow_rail_horizontal',
  'tile_ow_rail_horizontal',
  'tile_ow_rail_sw',
  'tile_ow_rail_vertical',
  'tile_ow_rail_horizontal',
  'tile_ow_rail_horizontal',
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH VARIANT A CELL DRAWS — AND WHY THE OLD ONE MADE A CHECKERBOARD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The previous version was `((tx * 73) ^ (ty * 151)) % n`, described as "two odd
 * multipliers so a diagonal run does not land on one variant". It does not do
 * that, and the map showed it: a player sent a screenshot of the moor drawn as a
 * regular light/dark chequer and said it was hard to tell what anything was.
 *
 * MEASURED, at six variants. The first row of that hash is
 *
 *     012345012345012345012345
 *
 * a perfect period-6 repeat, and across a 200x200 field a cell matched the one
 * TWO tiles to its right 33.9% of the time against a uniform 16.7% — twice as
 * often as chance. That is the chequer, and it is not a tuning problem: `tx * 73`
 * under `% 6` is a linear function of x, and a linear function modulo n can only
 * ever be a repeating stripe. XOR of two of them is a stripe crossed with a
 * stripe.
 *
 * So this is an AVALANCHE mix instead — multiply, shift-xor, multiply — where
 * one bit of input changes about half the output bits. Same measurement on the
 * same field: +1x 16.5%, +2x 16.5%, +2y 16.8%, diagonal 16.7%, and every variant
 * within a point of its even share.
 *
 * STILL PURE AND STILL POSITIONAL: the same cell draws the same tile every
 * frame and on every client, which is what lets the world be varied without
 * being sent.
 */
export function tileVariant(tx: number, ty: number, count: number): number {
  let h = Math.imul(tx, 0x27d4eb2d) ^ Math.imul(ty, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) % count;
}

/** Is this cell part of the made network the overlay draws along? */
export function isMadeGround(code: TileCode): boolean {
  return code === TileCode.COBBLE || code === TileCode.PAVING || code === TileCode.BRIDGE;
}

/**
 * Which cardinal neighbours continue the same kind of line.
 *
 * CARDINAL ONLY, N=1 E=2 S=4 W=8 — the handoff's contract, and the reason the
 * derived masks line up with its own. A diagonal neighbour is not a
 * connection: you cannot walk a road corner-to-corner and have it look like
 * one.
 */
export function transportMask(
  level: LevelView,
  tx: number,
  ty: number,
  same: (code: TileCode) => boolean,
): number {
  return (
    (same(tileAt(level, tx, ty - 1)) ? 1 : 0) |
    (same(tileAt(level, tx + 1, ty)) ? 2 : 0) |
    (same(tileAt(level, tx, ty + 1)) ? 4 : 0) |
    (same(tileAt(level, tx - 1, ty)) ? 8 : 0)
  );
}

/**
 * The road, rail or bridge lying over a terrain cell.
 *
 * COMPOSITED, NOT SUBSTITUTED. Measured: this art is ~70% transparent with
 * binary alpha, so the ground keeps showing through and a road over cobble
 * still reads as cobble underneath. It is drawn AFTER `paintTerrain` for that
 * reason and does nothing when there is no terrain sprite — a flat palette
 * fallback with a road on top would be the one cell on screen wearing two
 * different rendering eras at once.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MORE THAN ONE FACE PER TILE, WHICH THIS TABLE HAS ALWAYS BEEN ABLE TO HOLD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every entry here was a one-element array, so a forest was one drawing repeated
 * across nine per cent of the map and a mountain range was one rock. The picker
 * below has spread variants by positional hash the whole time — it was the ART
 * that did not exist.
 *
 * The redesign's handoff ships thirteen forests, seven mountain faces, seven
 * hill slopes and five field patterns. Six of each are installed
 * (`tools/import-overworld-art.mjs` explains why six and not thirteen), and
 * naming them `_b`, `_c` … follows the convention `tile_ow_cobble_b` already set.
 *
 * THE BASE STEM STAYS FIRST. A tile whose variants are ever removed falls back
 * to the drawing it always had rather than to nothing.
 */
/**
 * EXPORTED FOR `tools/look.mjs`, which composites this same table offline so a
 * change to the world's art can be LOOKED AT without a browser. Exported rather
 * than copied: a second hand-written copy of a table one file owns is the exact
 * shape this codebase has been bitten by repeatedly.
 */
export const TILE_SPRITES: Partial<Record<TileCode, readonly string[]>> = {
  [TileCode.COBBLE]: ['tile_ow_cobble', 'tile_ow_cobble_b'],
  [TileCode.PAVING]: ['tile_ow_paving'],
  [TileCode.GREEN]: ['tile_ow_green'],
  [TileCode.MIRE]: ['tile_ow_mire'],
  [TileCode.SOOT]: ['tile_ow_soot'],
  [TileCode.RAIL]: ['tile_ow_rail'],
  [TileCode.BRIDGE]: ['tile_ow_bridge'],
  [TileCode.TERRACE]: ['tile_ow_terrace'],
  [TileCode.CIVIC]: ['tile_ow_civic'],
  [TileCode.WORKS]: ['tile_ow_works'],
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE BARE STEM IS NOT IN THESE SETS, AND THAT IS THE POINT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A player photographed the overworld to say it "looks checkerboarded", and
   * this is what they were looking at. `import-overworld-art.mjs` writes the
   * handoff's variants starting at `_b` (`SUFFIX = 'bcdefghijk'`), so it never
   * overwrites `tile_ow_<stem>.png` — and the pre-redesign sprite sitting at
   * that name stayed in the set while the whole world around it was repainted.
   *
   * MEASURED, mean colour over the installed art:
   *
   *     field    rgb(162,151,105)   field_b..f    rgb( 52, 51, 30)
   *     hills    rgb(141,141, 95)   hills_b..g    rgb( 72, 72, 34)
   *     mountain rgb( 63, 64, 61)   mountain_b..g rgb(131,138,147)
   *
   * — so one field tile in six was drawn pale tan on dark olive, scattered by
   * the position hash. That is not a variant of a terrain; it is a different
   * terrain dealt out at random, which is exactly what a checkerboard is. A
   * hash of all 115 installed tiles says the same thing another way: 91 are
   * byte-identical to the handoff and these four bases are not.
   *
   * `trees` was the same mistake and did not show, because its legacy base
   * happened to land within 19 units of the new set. It goes for the same
   * reason: `tools/look.mjs --variants` measures the spread, and a set that is
   * coherent by luck is one nobody will notice going wrong.
   */
  [TileCode.TREES]: [
    'tile_ow_trees_b',
    'tile_ow_trees_c',
    'tile_ow_trees_d',
    'tile_ow_trees_e',
    'tile_ow_trees_f',
    'tile_ow_trees_g',
  ],
  [TileCode.ERASED]: ['tile_ow_erased'],
  [TileCode.WATER]: ['tile_ow_water'],
  [TileCode.PLAINS]: ['tile_ow_plains', 'tile_ow_plains_b'],
  [TileCode.HILLS]: [
    'tile_ow_hills_b',
    'tile_ow_hills_c',
    'tile_ow_hills_d',
    'tile_ow_hills_e',
    'tile_ow_hills_f',
    'tile_ow_hills_g',
  ],
  [TileCode.HEATH]: ['tile_ow_heath'],
  [TileCode.SHORE]: ['tile_ow_shore'],
  [TileCode.YARD]: ['tile_ow_yard'],
  [TileCode.FIELD]: [
    'tile_ow_field_b',
    'tile_ow_field_c',
    'tile_ow_field_d',
    'tile_ow_field_e',
    'tile_ow_field_f',
  ],
  [TileCode.VILLAGE_ROOF]: ['tile_ow_village_roof'],
  [TileCode.TOWN_ROOF]: ['tile_ow_town_roof'],
  [TileCode.CITY_ROOF]: ['tile_ow_city_roof'],
  [TileCode.TOWN_WALL]: ['tile_ow_wall'],
  [TileCode.MOUNTAIN]: [
    'tile_ow_mountain_b',
    'tile_ow_mountain_c',
    'tile_ow_mountain_d',
    'tile_ow_mountain_e',
    'tile_ow_mountain_f',
    'tile_ow_mountain_g',
  ],
  [TileCode.CRAG]: ['tile_ow_crag'],
  [TileCode.DEEPWATER]: ['tile_ow_deepwater'],
  // The north and the scar. Variant counts follow the art the handoff ships:
  // one polar cap, four frozen seas, six cold forests, and a charred scar with
  // sixteen patches of which six are installed — see `MAX_VARIANTS`.
  [TileCode.SNOWFIELD]: ['tile_ow_snowfield'],
  [TileCode.FROZEN_WATER]: [
    'tile_ow_frozen_water',
    'tile_ow_frozen_water_b',
    'tile_ow_frozen_water_c',
    'tile_ow_frozen_water_d',
  ],
  [TileCode.COLD_FOREST]: [
    'tile_ow_cold_forest',
    'tile_ow_cold_forest_b',
    'tile_ow_cold_forest_c',
    'tile_ow_cold_forest_d',
    'tile_ow_cold_forest_e',
    'tile_ow_cold_forest_f',
  ],
  [TileCode.CHARRED]: [
    'tile_ow_charred',
    'tile_ow_charred_b',
    'tile_ow_charred_c',
    'tile_ow_charred_d',
    'tile_ow_charred_e',
    'tile_ow_charred_f',
  ],
};

function tileFill(code: TileCode): string {
  switch (code) {
    // ─── the inner-worlds ───
    case TileCode.FLOOR:
      return PALETTE.PANEL;
    case TileCode.WALL:
      return PALETTE.VOID;

    // ─── Alderbrook: ground. Light. ───
    case TileCode.COBBLE:
      return '#4a4450';
    case TileCode.PAVING:
      return '#6b6478';
    case TileCode.GREEN:
      return '#3f5040';
    case TileCode.MIRE:
      return '#43483d';
    case TileCode.SOOT:
      return '#33303a';
    case TileCode.RAIL:
      return '#3c3842';
    case TileCode.BRIDGE:
      return '#5a4a3c';

    // ─── Alderbrook: blocks. Dark. ───
    case TileCode.TERRACE:
      return '#241d2c';
    case TileCode.CIVIC:
      return '#2b2536';
    case TileCode.WORKS:
      return '#1e1a24';
    case TileCode.TREES:
      return '#1c2a1e';
    /**
     * The Index has eaten this cell. Nearly the darkest thing on screen and
     * deliberately NOT black: black reads as a hole, and this is worse than a
     * hole — it is a correction.
     */
    case TileCode.ERASED:
      return '#14101c';
    /**
     * The canal. Dark because it is impassable, and the one tile whose colour
     * has to lie slightly about its nature: you can see across it, but value is
     * how a player reads "can I walk there", and they cannot.
     */
    case TileCode.WATER:
      return '#181f2e';

    // ─── the wilderness. Walkable: light. ───
    case TileCode.PLAINS:
      return '#4e5a3c';
    case TileCode.HILLS:
      return '#5a6142';
    case TileCode.HEATH:
      return '#565442';
    case TileCode.SHORE:
      return '#6b6350';
    case TileCode.YARD:
      return '#6a604e';
    case TileCode.FIELD:
      return '#5f6042';
    case TileCode.VILLAGE_ROOF:
      return '#2e2530';
    case TileCode.TOWN_ROOF:
      return '#2a2230';
    case TileCode.CITY_ROOF:
      return '#332b3c';
    case TileCode.TOWN_WALL:
      return '#2c2a30';

    // ─── the wilderness. Blocking: dark. ───
    case TileCode.MOUNTAIN:
      return '#2b2a30';
    case TileCode.CRAG:
      return '#302e34';
    /**
     * Open sea, darker than the river. Two values of water is what makes a
     * shoreline legible; one value makes a coast a flat shape.
     */
    case TileCode.DEEPWATER:
      return '#10151f';

    /**
     * ─── the cold north, and the burnt scar in the Sedge ───
     *
     * The flat-palette answers, for a viewport drawing without sprites. Cold
     * first: a snowfield is the BRIGHTEST ground on the map and it should be —
     * it is the one place the moor stops being grey — while the frozen sea sits
     * between the canal and the deep, because that is what it is.
     *
     * `charred` is deliberately close to SOOT (#33303a) without being it: the
     * two are the same idea at different scales, a burnt district and a burnt
     * county, and drawing them identically would make the scar read as more
     * town rather than as something that happened to the country.
     */
    case TileCode.SNOWFIELD:
      return '#b9c2cc';
    case TileCode.FROZEN_WATER:
      return '#5d7285';
    case TileCode.COLD_FOREST:
      return '#22303a';
    case TileCode.CHARRED:
      return '#3a3230';
  }
}

/**
 * What goes UNDER a body: a token ring, or — from M4 — a downed/erased marker.
 *
 * The downed case is checked first and unconditionally. A body on the floor with
 * a five-turn countdown must not read as "an ally standing here": the whole
 * mechanic is that somebody drops what they are doing and runs, and the marker
 * is the thing that says so from across the room. `DownedView.marker` carries
 * the asset key, so which of the two silhouettes it is stays an art decision
 * rather than a branch in the renderer.
 */
function underTokenIdFor(
  actor: ActorView,
  selfId: string | null,
  downed: ReadonlyMap<string, DownedView> | undefined,
): string {
  const down = downed?.get(actor.id);
  if (down !== undefined) return down.marker;
  return ringIdFor(actor, selfId);
}

function ringIdFor(actor: ActorView, selfId: string | null): string {
  // A CORPSE IS NOT A THREAT, and it must not keep wearing a threat's ring. The
  // body stays on the map after death (see `alive` in protocol.ts), so without
  // this the board after a sweep shows a hostile ring around something that can
  // no longer act — and "is that one dead?" is a question the screen should
  // never make anyone ask out loud. The neutral ring is a different shape, not
  // just a different colour.
  if (!actor.alive) return 'ui_token_ring_neutral';
  if (actor.id === selfId) return 'ui_token_ring_self';
  switch (actor.kind) {
    case 'player':
      return 'ui_token_ring_ally';
    case 'monster':
      // THE ELITE RING. `rank` is on the wire for exactly this and nothing else
      // (protocol.ts, `ActorView.rank`): the client cannot infer "elite" from hp
      // — a wounded elite has less life than a fresh husk — and it cannot infer
      // it from the sprite either, because art-pipeline.md records that
      // `index_husk_elite` currently ships SMALLER than `index_husk`. The art
      // reads the wrong way round, so the ring carries the whole signal, and a
      // player walking into an elite believing it is a husk is a wipe.
      //
      // Boss shares the elite ring: there is no boss ring in the manifest, and
      // one loud "this one is different" silhouette is better than falling back
      // to the ordinary hostile ring for the most dangerous thing on the floor.
      return actor.rank === ActorRank.Normal ? 'ui_token_ring_hostile' : 'ui_token_ring_elite';
  }
}

/**
 * The world-pixel coordinate that maps to backbuffer 0 on one axis.
 *
 * Centred on the focus, then clamped so the camera never shows the void beyond
 * the map edge. When the whole map is smaller than the viewport the clamp would
 * pin it to the top-left corner, which looks like a bug, so that case centres
 * the map instead and returns a negative camera.
 *
 * Everything is floored to a whole pixel: a camera at x = 12.5 offsets every
 * sprite in the frame by half a pixel, which is precisely the fractional
 * sampling the backbuffer exists to prevent.
 */
function cameraAxis(worldPx: number, viewPx: number, focusPx: number): number {
  if (worldPx <= viewPx) return -Math.floor((viewPx - worldPx) / 2);
  return clamp(Math.floor(focusPx - viewPx / 2), 0, worldPx - viewPx);
}

/**
 * A TILE -> ITS TOP-LEFT CORNER IN BACKBUFFER PIXELS, for one already-computed
 * camera. The whole of the camera arithmetic the travel preview needs.
 *
 * IT IS EXPORTED FOR TWO REASONS, AND NEITHER IS CONVENIENCE. The preview has
 * two painters — the dots below the tokens and the destination ticks above them
 * — and without this they would carry two copies of `tile * TILE_PX - cam`;
 * `Renderer.tileAtClient`'s own comment is already emphatic that a second copy
 * of the camera maths is how the pointer and the map start disagreeing at the
 * edges. And it is the only part of that arithmetic a TEST can reach: `draw`
 * writes `lastCamX`/`lastCamY` at the very end of a frame and `tileAtClient`
 * alone reads them, so there is nothing to sample from outside.
 *
 * IT DELIBERATELY DOES NOT CLAMP AND DOES NOT CULL. Both operands are signed:
 * a tile behind the camera yields a negative origin, and `cameraAxis` returns a
 * NEGATIVE camera whenever the whole map is smaller than the viewport, which it
 * does to centre a small map instead of pinning it to the corner. Anything that
 * assumes either is non-negative is wrong only on small maps and only at the
 * edges, which is the worst place for a bug to hide.
 *
 * This is NOT the tile->screen accessor a HUD painter might want, and it must
 * not grow into one on the `Renderer` type: the hover tooltip is anchored to the
 * POINTER precisely so that nothing outside this file ever needs the camera.
 */
export function pathCellOrigin(tile: TileXY, camX: number, camY: number): { x: number; y: number } {
  return { x: tile.x * TILE_PX - camX, y: tile.y * TILE_PX - camY };
}

export function createRenderer(options: RendererOptions): Renderer {
  const { canvas, sprites } = options;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  /**
   * ADAPTIVE VIEWPORT.
   *
   * `viewport` is now a MINIMUM, not a fixed size. A fixed 20x15 logical buffer
   * letterboxes badly in a Discord Activity iframe, which is wide and of
   * unpredictable aspect: at 1248x860 the integer scale lands on 1x, so 640 of
   * 1248 px carried the game and the rest was black bar.
   *
   * So: choose the integer scale from the MINIMUM viewport, then grow the
   * backbuffer to whatever whole tiles actually fit at that scale. Pixels stay
   * crisp (the scale is still an integer, chosen before the fit), and the extra
   * space becomes MORE VISIBLE MAP rather than more letterbox — which is the
   * right trade for a tactical game where seeing another tile of the room
   * matters more than seeing the same room larger.
   */
  const minTilesW = Math.max(1, Math.floor(viewport.tilesW));
  const minTilesH = Math.max(1, Math.floor(viewport.tilesH));
  const minLogicalW = minTilesW * TILE_PX;
  const minLogicalH = minTilesH * TILE_PX;
  /** Guardrail: past this the tiles are too small to read on a laptop. */
  /**
   * How thick the barrier contour is. Two pixels at 32 reads at every integer
   * scale this game uses; one disappears at 1x on a laptop screen.
   */
  const BARRIER_EDGE_PX = 2;

  const MAX_TILES_W = 48;
  const MAX_TILES_H = 32;
  let logicalW = minLogicalW;
  let logicalH = minLogicalH;

  // The backbuffer. Exactly the logical size, forever: it is never resized by
  // the window, which is what keeps the world's pixel grid stable.
  const back = document.createElement('canvas');
  back.width = logicalW;
  back.height = logicalH;

  const backCtx = require2dContext(back);
  const viewCtx = require2dContext(canvas);
  backCtx.imageSmoothingEnabled = false;
  viewCtx.imageSmoothingEnabled = false;

  let deviceW = 0;
  let deviceH = 0;
  let dpr = 1;
  let scale = 1;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ZOOM, AS A BIAS ON THE INTEGER SCALE RATHER THAN A MULTIPLIER ON IT
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `scale` is deliberately a whole number: it is what keeps every pixel of
   * hand-drawn art landing on a whole screen pixel, and the header above spends
   * a paragraph on why. A zoom that multiplied it by 1.25 would throw that away
   * for every player who used it, which is the one thing this renderer will not
   * do.
   *
   * So zoom moves the scale by whole STEPS. Out is a smaller scale — more
   * tiles, each smaller; in is a larger one. Clamped so it can never reach 0,
   * and clamped again by `MAX_TILES_*` on the way out, so zooming out on a big
   * window stops at a readable size rather than at unreadable specks.
   *
   * "Slightly" is the requirement and one step each way is what that means: at
   * the size this runs in a Discord iframe the natural scale is 2, so the range
   * is 1x to 3x and no setting is useless.
   */
  let zoomStep = 0;
  let offsetX = 0;
  let offsetY = 0;

  // The camera and level of the LAST drawn frame, kept solely so `tileAtClient`
  // can invert the transform the player is actually looking at. Nothing reads
  // these while drawing; they are written at the end of `draw` and never before.
  let lastCamX = 0;
  let lastCamY = 0;
  let lastLevel: LevelView | null = null;

  /**
   * Change the zoom by one step and re-lay the board.
   *
   * Returns the step actually taken, which may be the current one — the clamp
   * is authoritative and the caller must be able to say "already as far out as
   * it goes" rather than silently doing nothing.
   */
  function setZoom(next: number): number {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.trunc(next)));
    if (clamped === zoomStep) return zoomStep;
    zoomStep = clamped;
    // The device box has not changed, so `resize`'s early-out would skip the
    // whole recompute. Forcing it is the point of this line.
    deviceW = 0;
    resize();
    return zoomStep;
  }

  function zoom(): number {
    return zoomStep;
  }

  function resize(): boolean {
    const rect = canvas.getBoundingClientRect();
    const nextDpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    // Before layout has run (display:none, or a detached canvas in a test) the
    // rect is 0x0. Fall back to the logical size rather than dividing by zero.
    const cssW = rect.width > 0 ? rect.width : logicalW;
    const cssH = rect.height > 0 ? rect.height : logicalH;
    const nextW = Math.max(1, Math.round(cssW * nextDpr));
    const nextH = Math.max(1, Math.round(cssH * nextDpr));

    if (nextW === deviceW && nextH === deviceH && nextDpr === dpr) return false;

    deviceW = nextW;
    deviceH = nextH;
    dpr = nextDpr;

    // Assigning either of these RESETS the whole 2D context state — transform,
    // fillStyle and, the one that matters here, imageSmoothingEnabled. Anything
    // configured on viewCtx must be re-applied below.
    canvas.width = deviceW;
    canvas.height = deviceH;
    viewCtx.imageSmoothingEnabled = false;

    // Scale first, from the MINIMUM viewport — this is what keeps the factor a
    // whole number and the pixels sharp.
    const fitScale = Math.floor(Math.min(deviceW / minLogicalW, deviceH / minLogicalH));
    scale = Math.max(1, fitScale + zoomStep);

    // Then fill the box with whole tiles at that scale. Clamped below by the
    // requested minimum (never show LESS than was asked for) and above by
    // MAX_TILES_* (never shrink the world to unreadable specks).
    const fitTilesW = Math.floor(deviceW / (TILE_PX * scale));
    const fitTilesH = Math.floor(deviceH / (TILE_PX * scale));
    const tilesW = Math.min(MAX_TILES_W, Math.max(minTilesW, fitTilesW));
    const tilesH = Math.min(MAX_TILES_H, Math.max(minTilesH, fitTilesH));

    const nextLogicalW = tilesW * TILE_PX;
    const nextLogicalH = tilesH * TILE_PX;
    if (nextLogicalW !== logicalW || nextLogicalH !== logicalH) {
      logicalW = nextLogicalW;
      logicalH = nextLogicalH;
      // Same caveat as the visible canvas: assigning width/height resets the
      // context, so imageSmoothingEnabled must be re-applied.
      back.width = logicalW;
      back.height = logicalH;
      backCtx.imageSmoothingEnabled = false;
    }

    offsetX = Math.floor((deviceW - logicalW * scale) / 2);
    offsetY = Math.floor((deviceH - logicalH * scale) / 2);
    return true;
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * PAINT ONE TERRAIN CELL FROM THE TILESET. Returns false if there is no art
   * for it, which is the caller's cue to fall back to the flat palette colour.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * DELIBERATELY NOT `blitSprite`, and the difference is the whole point.
   * `blitSprite` paints a loud violet box on a miss, which is exactly right for
   * a token — an invisible player reads as a netcode bug and costs an evening.
   * It is exactly WRONG here: a bare clone with no manifest, or a tileset
   * half-delivered, would fill the entire screen with violet boxes and take the
   * game with it. Terrain has a good answer to a missing sprite that a creature
   * does not — the flat colour the renderer has always used — so it fails to
   * THAT, silently, and the city stays legible and playable with no art at all.
   *
   * NO BOTTOM-CENTRE ANCHOR EITHER. A terrain tile is exactly TILE_PX square
   * and is drawn at the cell origin. `blitSprite`'s anchor exists so a 48x64
   * ogre overflows upward rather than downward; a ground tile that overflowed
   * anywhere would tear the grid.
   *
   * VARIANTS ARE PICKED BY POSITION, NOT BY A DRAW. Cobble ships two
   * interchangeable tiles, because the single most repeated sprite in the game
   * looks mechanical however well it is drawn. The choice is a pure function of
   * (x, y): the same cell is the same stone on every client and on every frame,
   * which a random pick would not be — it would shimmer as the camera moved.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A ROAD IS A LINE, NOT A COLOUR — WHICH IS ALL IT HAS BEEN.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The redesigned moor lays 584 road cells and 89 of continuous rail, and both
   * drew as a flat fill: a smear of cobble where a road should run, with no way
   * to see a junction, a corner or where a line ends.
   *
   * The handoff ships the connection art and a per-cell NESW mask. THE MASK IS
   * NOT IMPORTED, because it is derivable and importing it would mean a second
   * 17,000-cell array on a wire that already carries the tiles. Measured against
   * the handoff's own masks over every cell both agree is road: **95.2%
   * identical**.
   *
   * THE 4.8% ARE ALL ONE SHAPE and it is a benign one: the handoff counts 167
   * `trail_danger` cells that the compatibility layout draws as HEATH, so where
   * a paved road meets a moorland track this draws the paving ending rather than
   * continuing. A road that stops being a road when it stops being paved is the
   * honest picture, not the wrong one.
   */
  function paintTransport(
    level: LevelView,
    code: TileCode,
    tx: number,
    ty: number,
    sx: number,
    sy: number,
  ): void {
    let id: string | null = null;
    if (code === TileCode.BRIDGE) {
      // A bridge is drawn along whichever way the crossing runs, and it is
      // always one or the other — a bridge is a span, never a junction.
      const mask = transportMask(level, tx, ty, isMadeGround);
      id = (mask & 5) !== 0 ? 'tile_ow_bridge_vertical' : 'tile_ow_bridge_horizontal';
    } else if (code === TileCode.RAIL) {
      id = RAIL_BY_MASK[transportMask(level, tx, ty, (c) => c === TileCode.RAIL)] ?? null;
    } else if (code === TileCode.COBBLE || code === TileCode.PAVING) {
      id = ROAD_BY_MASK[transportMask(level, tx, ty, isMadeGround)] ?? null;
    }
    if (id === null) return;
    const sprite: Sprite | undefined = sprites.sprite(id);
    if (sprite === undefined) return;
    backCtx.drawImage(sprite.image, sx, sy, TILE_PX, TILE_PX);
  }

  function paintTerrain(code: TileCode, tx: number, ty: number, sx: number, sy: number): boolean {
    const ids = TILE_SPRITES[code];
    if (ids === undefined) return false;

    const id = ids.length === 1 ? ids[0] : ids[tileVariant(tx, ty, ids.length)];
    if (id === undefined) return false;

    const sprite: Sprite | undefined = sprites.sprite(id);
    if (sprite === undefined) return false;

    // Scaled to TILE_PX rather than drawn at the sprite's own size: a tile that
    // is not 32x32 is an authoring mistake (the brief is explicit), and letting
    // it tear the grid would be a worse way to report that than a stretched cell.
    backCtx.drawImage(sprite.image, sx, sy, TILE_PX, TILE_PX);
    return true;
  }

  /**
   * Draw the places you can walk into.
   *
   * FALLS BACK TO A DRAWN MARK, NOT TO A VIOLET BOX. `tile_ow_site_*` may not be
   * on disk — the art tree is gitignored, so a bare clone has none of it — and a
   * world map speckled with violet error boxes where its towns should be is
   * worse than useless. So a missing marker paints a small gold ring instead:
   * legible, obviously deliberate, and enough to navigate by. Same argument
   * `paintTerrain` makes, and the opposite of `blitSprite`'s.
   *
   * AN UNKNOWN MARKER FAMILY FALLS BACK TO `gate`. A client meeting a marker a
   * newer server invented should draw *a door* rather than nothing at all.
   */
  function paintSites(sites: readonly SiteView[], camX: number, camY: number): void {
    for (const site of sites) {
      const sx = site.x * TILE_PX - camX;
      const sy = site.y * TILE_PX - camY;
      if (sx < -TILE_PX || sy < -TILE_PX || sx > logicalW || sy > logicalH) continue;

      /**
       * SOMETHING ALIVE IS DRAWN AS A TOKEN, not as a marker on the ground.
       *
       * A roamer carries a creature sprite and gets the hostile ring and the
       * bottom-centre anchor every other body on the board gets — because it IS
       * the same kind of thing as the creature it becomes, and it has to read
       * that way instantly. Drawing it with the breach marker instead made it
       * look like a door, which is exactly what that art was drawn to be.
       */
      if (site.sprite !== undefined) {
        const ring = sprites.sprite('ui_token_ring_hostile');
        if (ring !== undefined) backCtx.drawImage(ring.image, sx, sy, TILE_PX, TILE_PX);
        blitSprite(site.sprite, sx, sy);
        continue;
      }

      /**
       * THIS PLACE'S OWN ART FIRST, THE FAMILY SECOND.
       *
       * `SITE_MARKERS` draws a marker per KIND — three size tiers for
       * village/town/city — so every city on the map looked identical. A player
       * reported the result plainly: hard to tell the area you are standing in
       * is a town. `SiteView.landmark` is the same 32x32 slot with Alderbrook's
       * own clocktower in it.
       *
       * A PREFERENCE, NOT A REPLACEMENT. `site:redaction` ships no landmark, so
       * the lookup misses and the family marker draws exactly as before — which
       * is also what happens for any place whose art has not been installed yet.
       */
      const landmark = site.landmark === undefined ? undefined : sprites.sprite(site.landmark);
      if (landmark !== undefined) {
        backCtx.drawImage(landmark.image, sx, sy, TILE_PX, TILE_PX);
        continue;
      }

      const id = SITE_MARKERS.get(site.marker) ?? SITE_MARKERS.get('gate');
      const sprite = id === undefined ? undefined : sprites.sprite(id);
      if (sprite !== undefined) {
        backCtx.drawImage(sprite.image, sx, sy, TILE_PX, TILE_PX);
        continue;
      }

      // The no-art path. A ring on the cell, inset so the ground still reads.
      backCtx.strokeStyle = PALETTE.GOLD;
      backCtx.lineWidth = 2;
      backCtx.strokeRect(sx + 5, sy + 5, TILE_PX - 10, TILE_PX - 10);
    }
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * OUTLINE EVERY MASS YOU CANNOT WALK INTO. THE ART ALONE DOES NOT SAY SO.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Reported from play: "the walls and borders around the map are not very
   * clear that it's a barrier until you try to click past it."
   *
   * TWO CAUSES, AND THE SECOND WAS INTRODUCED BY THE ART LANDING.
   *
   *   The lit top edge only ever applied to `TileCode.WALL`. Mountain, crag,
   *   forest, water, deep water and erased ground — every barrier the overworld
   *   is actually made of — got nothing, because they did not exist when that
   *   branch was written.
   *
   *   And the whole edge/grid block sits inside `if (!paintTerrain(...))`, i.e.
   *   in the NO-ART fallback. The moment real tiles were installed the renderer
   *   stopped drawing cues altogether, so the region got *less* legible as it
   *   got prettier. That is the worst shape a regression can have: it arrives
   *   with something that is otherwise an improvement.
   *
   * So this runs unconditionally and OUTSIDE that branch. A dark rim is drawn on
   * the blocking tile along every side that faces ground you can walk on, which
   * outlines each range, wood and coast as one continuous mass — the contour a
   * world map wants — and costs nothing on an interior floor, where FLOOR and
   * WALL already read.
   *
   * DRAWN ON THE BLOCKING SIDE, never on the walkable one: the rim must not eat
   * a pixel of the tile a player is judging a move onto, and terrain art is
   * seamless by contract so a rim inside it cannot break a tiling edge.
   *
   * Value, not hue. `INK` is the darkest thing in the palette and the barrier
   * band is already the dark half of the set, so this reads at a glance and in
   * peripheral vision, which is the whole argument of ART-OVERWORLD.md § 4.2.
   */
  function paintBarrierEdge(
    level: LevelView,
    code: TileCode,
    tx: number,
    ty: number,
    sx: number,
    sy: number,
  ): void {
    if (isWalkable(code)) return;

    backCtx.fillStyle = PALETTE.INK;
    const W = BARRIER_EDGE_PX;
    // North, south, west, east. `tileAt` fails closed to WALL off-grid, so the
    // map border never draws a rim against nothing.
    if (isWalkable(tileAt(level, tx, ty - 1))) backCtx.fillRect(sx, sy, TILE_PX, W);
    if (isWalkable(tileAt(level, tx, ty + 1))) backCtx.fillRect(sx, sy + TILE_PX - W, TILE_PX, W);
    if (isWalkable(tileAt(level, tx - 1, ty))) backCtx.fillRect(sx, sy, W, TILE_PX);
    if (isWalkable(tileAt(level, tx + 1, ty))) backCtx.fillRect(sx + TILE_PX - W, sy, W, TILE_PX);
  }

  function blitSprite(id: string, cellX: number, cellY: number): void {
    const sprite: Sprite | undefined = sprites.sprite(id);
    if (sprite === undefined) {
      // A missing asset must be LOUD. Silently drawing nothing turns a broken
      // manifest entry into "the other player is invisible", which reads as a
      // netcode bug and costs an evening.
      backCtx.fillStyle = PALETTE.VIOLET_HI;
      backCtx.fillRect(cellX + 4, cellY + 4, TILE_PX - 8, TILE_PX - 8);
      backCtx.fillStyle = PALETTE.INK;
      backCtx.fillRect(cellX + 6, cellY + 6, TILE_PX - 12, TILE_PX - 12);
      return;
    }

    // BOTTOM-CENTRE ANCHOR, written generally rather than as the +4 that a
    // 24x32 sprite on a 32x32 tile happens to need today. A creature sprite is
    // allowed to be bigger than its tile — the M6 bestiary has 48x64 ogres —
    // and when it is, it must overflow UPWARD and sideways, never downward:
    // the feet are what tell the player which tile the thing occupies.
    //   24x32 -> dx = +4,  dy =   0
    //   48x64 -> dx = -8,  dy = -32
    const dx = cellX + Math.round((TILE_PX - sprite.w) / 2);
    const dy = cellY + (TILE_PX - sprite.h);
    backCtx.drawImage(sprite.image, dx, dy, sprite.w, sprite.h);
  }

  function paintTiles(level: LevelView, camX: number, camY: number): void {
    const minTx = Math.max(0, Math.floor(camX / TILE_PX));
    const minTy = Math.max(0, Math.floor(camY / TILE_PX));
    const maxTx = Math.min(level.w - 1, Math.floor((camX + logicalW - 1) / TILE_PX));
    const maxTy = Math.min(level.h - 1, Math.floor((camY + logicalH - 1) / TILE_PX));

    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        // tileAt fails closed to WALL out of bounds and for unknown codes, so
        // no `| undefined` ever reaches the renderer.
        const code = tileAt(level, tx, ty);
        const sx = tx * TILE_PX - camX;
        const sy = ty * TILE_PX - camY;

        // A REAL TERRAIN SPRITE WINS, and when one is present it is the WHOLE
        // cell — no flat fill under it, no grid line over it. See `paintTerrain`.
        // THE LINE OVER THE GROUND. Only when a terrain sprite actually
        // drew — see `paintTransport`.
        if (paintTerrain(code, tx, ty, sx, sy)) {
          paintTransport(level, code, tx, ty, sx, sy);
        } else {
          backCtx.fillStyle = tileFill(code);
          backCtx.fillRect(sx, sy, TILE_PX, TILE_PX);

          if (!isWalkable(code)) {
            // A lit top edge. Without it a flat blocking colour reads as a hole
            // in the floor rather than as something solid.
            backCtx.fillStyle = PALETTE.GREY;
            backCtx.fillRect(sx, sy, TILE_PX, WALL_EDGE_PX);
          } else {
            // A one-pixel grid on floor tiles. Counting tiles is how a player
            // measures a move, and it costs a barely-visible shade of SLATE.
            backCtx.fillStyle = PALETTE.SLATE;
            backCtx.fillRect(sx, sy + TILE_PX - 1, TILE_PX, 1);
            backCtx.fillRect(sx + TILE_PX - 1, sy, 1, TILE_PX);
          }
        }

        // ALWAYS, ART OR NO ART. See `paintBarrierEdge`.
        paintBarrierEdge(level, code, tx, ty, sx, sy);
      }
    }
  }

  function visible(cellX: number, cellY: number): boolean {
    return (
      cellX > -ACTOR_CULL_MARGIN_PX &&
      cellY > -ACTOR_CULL_MARGIN_PX &&
      cellX < logicalW + ACTOR_CULL_MARGIN_PX &&
      cellY < logicalH + ACTOR_CULL_MARGIN_PX
    );
  }

  /**
   * THE TARGETING PASS. Runs after the floor and before the token rings, so a
   * marker can never hide the thing being aimed at.
   *
   * `save`/`restore` around the wash because `globalAlpha` is the one piece of
   * context state nothing else in this file sets, and a leaked 0.55 would make
   * every subsequent sprite in the frame translucent — a bug that looks like a
   * broken PNG rather than like a missing restore.
   */
  function paintTargeting(cells: readonly TargetCell[], camX: number, camY: number): void {
    for (const cell of cells) {
      const cellX = cell.x * TILE_PX - camX;
      const cellY = cell.y * TILE_PX - camY;
      if (!visible(cellX, cellY)) continue;

      if (cell.shaded) {
        backCtx.save();
        backCtx.globalAlpha = LOS_SHADE_ALPHA;
        backCtx.fillStyle = PALETTE.INK;
        backCtx.fillRect(cellX, cellY, TILE_PX, TILE_PX);
        backCtx.restore();
      }
      if (cell.marker !== null) blitSprite(`ui_tile_marker_${cell.marker}`, cellX, cellY);
    }
  }

  /**
   * THE TRAVEL PATH PREVIEW. NO ART, DELIBERATELY — `fillRect` and nothing else.
   *
   * THE OBVIOUS IMPLEMENTATION IS A TRAP AND MUST NOT BE WRITTEN. Adding a
   * `MarkerKind.Path` member and blitting `ui_tile_marker_path` would follow the
   * shape of every other overlay in this file, and it would fail loudly for
   * everyone: that id exists in no manifest, the art is gitignored WHOLESALE so
   * a bare clone has no manifest at all, and `blitSprite` above resolves a
   * missing sprite to the intentionally shouty violet fallback box. The result
   * is a violet ring on every tile of every travel path, for every player,
   * including the author — a broken-manifest alarm fired by a feature that is
   * working perfectly, which is the one thing that alarm must never do. So: no
   * `blitSprite`, no new `MarkerKind` member, no new NEEDED_ASSET_PREFIXES
   * entry, and this preview keeps working on a clone with zero PNGs in it.
   *
   * GOLD because it is this file's affirmative / cursor colour, and the route
   * and the destination bracket should read as one thing. Never CRIMSON, which
   * `PALETTE` reserves for the single fact "hostiles are engaged"; and never
   * VIOLET_HI, which IS the missing-asset colour — a path painted in it is
   * indistinguishable from the bug described above.
   *
   * `save`/`restore` around `globalAlpha` for exactly the reason
   * `paintTargeting` wraps its wash: canvas state is not reset between painters
   * within a frame, so a leaked 0.7 makes every later sprite in the frame
   * translucent, which reads as a broken PNG rather than as a missing restore.
   */
  function paintPath(tiles: readonly TileXY[], camX: number, camY: number): void {
    if (tiles.length === 0) return;

    backCtx.save();
    backCtx.globalAlpha = PATH_DOT_ALPHA;
    backCtx.fillStyle = PALETTE.GOLD;
    for (const tile of tiles) {
      const origin = pathCellOrigin(tile, camX, camY);
      // The SAME cull the actors use, rather than a viewport test written fresh
      // for this one painter. It is deliberately generous —
      // ACTOR_CULL_MARGIN_PX is three tiles of slack, so a tall sprite does not
      // pop at the edge — and the generosity is harmless here: a route running
      // off the screen paints a few dots past the border, into backbuffer
      // coordinates the canvas itself clips away.
      if (!visible(origin.x, origin.y)) continue;
      backCtx.fillRect(
        origin.x + PATH_DOT_INSET,
        origin.y + PATH_DOT_INSET,
        PATH_DOT_PX,
        PATH_DOT_PX,
      );
    }
    backCtx.restore();
  }

  /**
   * WHAT IS ON THE FLOOR. NO ART, DELIBERATELY — `fillRect` and nothing else,
   * and written in the same shape as `paintPath` above for exactly its reasons.
   *
   * ═══ THE OBVIOUS IMPLEMENTATION IS WRONG TWICE OVER, SO BOTH ARE NAMED ═══
   * FIRST: a new `MarkerKind` member and a `ui_tile_marker_loot` blit follows the
   * shape of every other overlay in this file and fails loudly for EVERYONE —
   * that id is in no manifest, client/public/assets/ is gitignored wholesale so a
   * bare clone has no manifest at all, and `blitSprite` resolves a miss to the
   * intentionally shouty violet fallback box. The broken-manifest alarm would be
   * fired by a feature that works perfectly. test/client/assets.test.ts:210-218
   * re-asserts the five-member pin for exactly this reason.
   *
   * SECOND, AND IT IS SPECIFIC TO THIS OVERLAY: the item's own 64x64 icon IS in
   * the manifest and would be the tempting thing to draw. A tile is 32x32. Fitting
   * one into the other means a downscale, which is precisely the resampling the
   * backbuffer exists to prevent (see the header) — or a centre crop, which shows
   * a quarter of a picture and identifies nothing. The panel is where an icon is
   * legible; the map gets a mark that says "something is here, roughly how much of
   * it, and roughly how good it is", and the player presses `,` or opens the
   * panel for the rest.
   *
   * A ONE-PIXEL INK SURROUND, the legibility trick `paintStatusPips` and
   * `paintProjectiles` both use: a pile sits on floor, beside a wall and under the
   * lit top edge of a wall, and without the surround it disappears against
   * exactly one of them.
   *
   * NO `globalAlpha`, so no save/restore is needed — and that is a reason to keep
   * it that way rather than an accident. A leaked alpha makes every later sprite
   * in the frame translucent, which reads as a broken PNG rather than as a missing
   * restore; whoever adds a fade here must wrap it, as `paintPath` does.
   */
  function paintLoot(piles: readonly LootMarker[], camX: number, camY: number): void {
    if (piles.length === 0) return;

    for (const pile of piles) {
      // The SAME cull the actors, the route preview and the orbs use, rather than
      // a viewport test written fresh for this one painter.
      const origin = pathCellOrigin({ x: pile.x, y: pile.y }, camX, camY);
      if (!visible(origin.x, origin.y)) continue;

      const size = LOOT_DOT_PX[pile.tier];
      const ink = LOOT_DOT_INK[pile.tier];
      const inset = Math.round((TILE_PX - size) / 2);

      /** One square with its surround, at an offset from the tile's centre. */
      const mark = (dx: number, dy: number): void => {
        const x = origin.x + inset + dx;
        const y = origin.y + inset + dy;
        backCtx.fillStyle = PALETTE.INK;
        backCtx.fillRect(x - 1, y - 1, size + 2, size + 2);
        backCtx.fillStyle = ink;
        backCtx.fillRect(x, y, size, size);
      };

      // A PILE OF TWO OR MORE IS TWO OVERLAPPING SQUARES, drawn back to front.
      // The count is a SHAPE rather than a digit: a numeral at this size would be
      // three pixels tall and unreadable, and the only question the map has to
      // answer is "one thing or several" — the panel and the Case Log say which
      // things. Beyond two it stops growing, deliberately: `pickup` takes the top
      // of the pile one item at a time whether there are two or five.
      if (pile.count > 1) mark(-LOOT_PILE_OFFSET, -LOOT_PILE_OFFSET);
      mark(0, 0);
    }
  }

  /**
   * WHAT IS IN THE AIR. NO ART, DELIBERATELY — `fillRect` and nothing else, and
   * written in the same shape as `paintPath` above for exactly its reasons.
   *
   * THE OBVIOUS IMPLEMENTATION IS THE SAME TRAP `paintPath` NAMES, so it is
   * named again rather than left to be rediscovered. Adding a `MarkerKind.Orb`
   * member and blitting `ui_tile_marker_orb` — or a `fx_projectile_*` sprite —
   * would follow the shape of every other overlay in this file and would fail
   * loudly for everyone: that id exists in no manifest, client/public/assets/ is
   * gitignored WHOLESALE so a bare clone has no manifest at all, and
   * `blitSprite` resolves a missing sprite to the intentionally shouty violet
   * fallback box. The result would be a broken-manifest alarm fired by a feature
   * that is working perfectly, on the one object the player most needs to read
   * correctly. So: no `blitSprite`, no new `MarkerKind` member, no new
   * NEEDED_ASSET_PREFIXES entry in main.ts, and the orb draws on a clone with
   * zero PNGs in it.
   *
   * ORANGE BY ELIMINATION, and it is the codebase's existing word for "this is
   * being done TO you" — `paintStatusPips` picks it for a HARMFUL badge and
   * ui/tooltip.ts for a blocked reason. VIOLET_HI *is* the missing-asset box
   * above, so an orb painted in it is indistinguishable from the bug. CRIMSON is
   * reserved by `PALETTE` for the single fact "hostiles are engaged" and is
   * spent on the playfield ring. GOLD is this file's affirmative/cursor colour
   * and is already spent on the player's own route and targeting bracket — an
   * ENEMY orb in gold reads as your own aim, which is the one misreading that
   * would get somebody killed by standing still.
   *
   * A ONE-PIXEL INK SURROUND, the legibility trick `paintStatusPips` uses: the
   * orb crosses floor, wall and the lit top edge of a wall within one flight,
   * and without the surround it disappears against exactly one of them.
   *
   * NO `globalAlpha`, so no save/restore is needed — and that is a reason to
   * keep it that way rather than an accident. A leaked alpha makes every later
   * sprite in the frame translucent, which reads as a broken PNG rather than as
   * a missing restore; whoever adds a fade here must wrap it, as `paintPath`
   * does.
   *
   * `turnsToImpact`, `sourceId` and the frozen aim tile are deliberately NOT
   * drawn. The dot answers "where is it and which way is it going"; how long you
   * have is a sentence, not a pixel, and the client raises it on the notice line
   * (main.ts) rather than stacking a number over a token.
   */
  function paintProjectiles(orbs: readonly ProjectileView[], camX: number, camY: number): void {
    if (orbs.length === 0) return;

    for (const orb of orbs) {
      // The SAME cull the actors and the route preview use, rather than a
      // viewport test written fresh for this one painter. It is deliberately
      // generous — three tiles of slack — and the generosity is harmless: an orb
      // just off screen paints into backbuffer coordinates the canvas clips.
      const origin = pathCellOrigin({ x: orb.x, y: orb.y }, camX, camY);
      if (!visible(origin.x, origin.y)) continue;

      backCtx.fillStyle = PALETTE.INK;
      backCtx.fillRect(
        origin.x + ORB_DOT_INSET - 1,
        origin.y + ORB_DOT_INSET - 1,
        ORB_DOT_PX + 2,
        ORB_DOT_PX + 2,
      );
      backCtx.fillStyle = PALETTE.ORANGE;
      backCtx.fillRect(origin.x + ORB_DOT_INSET, origin.y + ORB_DOT_INSET, ORB_DOT_PX, ORB_DOT_PX);
    }
  }

  /**
   * The eight rects of a corner bracket, at the current `fillStyle`.
   *
   * Factored out of `paintCursor` when the travel destination needed the same
   * geometry: two hand-copied sets of eight offsets drift, and the drift shows
   * up as a bracket whose arms are a pixel different from the one beside it.
   */
  function cornerTicks(x: number, y: number): void {
    const arm = CURSOR_TICK_PX;
    const thick = CURSOR_TICK_THICK;
    const far = TILE_PX - thick;
    const near = TILE_PX - arm;

    backCtx.fillRect(x, y, arm, thick);
    backCtx.fillRect(x, y, thick, arm);
    backCtx.fillRect(x + near, y, arm, thick);
    backCtx.fillRect(x + far, y, thick, arm);
    backCtx.fillRect(x, y + far, arm, thick);
    backCtx.fillRect(x, y + near, thick, arm);
    backCtx.fillRect(x + near, y + far, arm, thick);
    backCtx.fillRect(x + far, y + near, thick, arm);
  }

  /**
   * Four corner ticks on the cursor tile, drawn ABOVE the actors.
   *
   * Ticks rather than a filled marker precisely so this may sit on top: it
   * brackets the tile without covering the token standing in it, so the player
   * can see both where the cursor is and what is under it. This is the only
   * thing in the targeting layer allowed above the y-sorted pass.
   */
  function paintCursor(tile: TileXY, camX: number, camY: number): void {
    const x = tile.x * TILE_PX - camX;
    const y = tile.y * TILE_PX - camY;
    if (!visible(x, y)) return;

    backCtx.fillStyle = PALETTE.GOLD;
    cornerTicks(x, y);
  }

  /**
   * The travel DESTINATION, bracketed above the tokens. Still no art.
   *
   * Corner ticks rather than a filled marker for `paintCursor`'s own reason, and
   * the case is even stronger here: the tile a walk ends on is the tile most
   * likely to have something standing next to or on it, because "walk up to"
   * stops one square short of a body on purpose. A fill would hide the body the
   * player is walking towards.
   *
   * Held at the dots' alpha, inside its own save/restore, so that when a
   * targeting ring happens to share the frame the FULL-opacity bracket is the
   * cursor being steered right now and the faint one is the route set earlier.
   * Without the wrapper the leak is the same one `paintTargeting` guards
   * against, and it would land on the sweep markers and the pings that follow.
   */
  function paintPathEnd(tile: TileXY, camX: number, camY: number): void {
    const origin = pathCellOrigin(tile, camX, camY);
    if (!visible(origin.x, origin.y)) return;

    backCtx.save();
    backCtx.globalAlpha = PATH_DOT_ALPHA;
    backCtx.fillStyle = PALETTE.GOLD;
    cornerTicks(origin.x, origin.y);
    backCtx.restore();
  }

  /**
   * A short column of dots down the right edge of a token.
   *
   * WHAT THEY SAY, AND WHAT THEY DELIBERATELY DO NOT. A pip answers "is
   * something on this thing, and roughly how much of it, and is it being helped
   * or hurt". It does NOT answer WHICH — the party panel's 24x24 badges do that,
   * and the Record lane says it in words. Encoding identity in the colour of a
   * four-pixel dot would be signalling state by colour alone at the smallest
   * size in the game, which is the one thing this codebase refuses to do; it
   * would also mean a client-side table mapping effect ids to colours, and a
   * client-side copy of authored data is the one that will be missing M5's
   * fourth status.
   *
   * DOWN THE RIGHT EDGE rather than across the top: sprites are anchored
   * bottom-centre and are frequently taller than their tile, so the top-centre
   * of a cell is somebody's head. The right edge is the one strip of a tile that
   * a bottom-centred 24-wide sprite in a 32-wide cell reliably leaves alone.
   */
  function paintStatusPips(effects: readonly EffectView[], cellX: number, cellY: number): void {
    if (effects.length === 0) return;
    const solid = Math.min(PIP_MAX, effects.length);
    const overflow = effects.length > PIP_MAX;
    const x = cellX + TILE_PX - PIP_SIZE - 1;

    for (let i = 0; i < solid; i += 1) {
      const y = cellY + 2 + i * PIP_STEP;
      // A one-pixel ink surround, so a pip stays legible over floor, over wall
      // and over the lit top edge of a wall alike.
      backCtx.fillStyle = PALETTE.INK;
      backCtx.fillRect(x - 1, y - 1, PIP_SIZE + 2, PIP_SIZE + 2);

      const effect = effects[i];
      const last = overflow && i === solid - 1;
      const colour = effect !== undefined && !effect.harmful ? PALETTE.GOLD : PALETTE.ORANGE;
      if (last) {
        // HOLLOW: "and more". A different shape, not a dimmer dot.
        backCtx.fillStyle = colour;
        backCtx.fillRect(x, y, PIP_SIZE, 1);
        backCtx.fillRect(x, y + PIP_SIZE - 1, PIP_SIZE, 1);
        backCtx.fillRect(x, y, 1, PIP_SIZE);
        backCtx.fillRect(x + PIP_SIZE - 1, y, 1, PIP_SIZE);
        continue;
      }
      backCtx.fillStyle = colour;
      backCtx.fillRect(x, y, PIP_SIZE, PIP_SIZE);
    }
  }

  /**
   * A `point` marker plus the name of whoever put it there.
   *
   * The NAME is the half that makes this social rather than decorative: "there,
   * behind the pillar" is only actionable if you know who said it, and in a
   * four-person party two people point at different things within a second of
   * each other constantly. Drawn on an ink strip so it survives a bright floor.
   */
  function paintPing(ping: PingMarker, camX: number, camY: number): void {
    const cellX = ping.x * TILE_PX - camX;
    const cellY = ping.y * TILE_PX - camY;
    if (!visible(cellX, cellY)) return;

    blitSprite('ui_marker_point', cellX, cellY);
    if (ping.label === '') return;

    backCtx.save();
    backCtx.font = 'bold 10px ui-monospace, Consolas, monospace';
    backCtx.textAlign = 'center';
    backCtx.textBaseline = 'middle';
    const midX = cellX + TILE_PX / 2;
    const labelY = cellY + TILE_PX + 6;
    const w = Math.ceil(backCtx.measureText(ping.label).width) + 6;
    backCtx.fillStyle = PALETTE.INK;
    backCtx.fillRect(midX - w / 2, labelY - 6, w, 12);
    backCtx.fillStyle = PALETTE.GOLD;
    backCtx.fillText(ping.label, midX, labelY);
    backCtx.restore();
  }

  function draw(scene: Scene): void {
    if (deviceW === 0) resize();

    backCtx.fillStyle = PALETTE.INK;
    backCtx.fillRect(0, 0, logicalW, logicalH);

    const level = scene.level;
    if (level !== null) {
      const self = scene.actors.find((actor) => actor.id === scene.selfId);
      // Before `welcome` names a self, look at the middle of the map.
      const focusX = (self === undefined ? level.w / 2 : self.x + 0.5) * TILE_PX;
      const focusY = (self === undefined ? level.h / 2 : self.y + 0.5) * TILE_PX;
      const camX = cameraAxis(level.w * TILE_PX, logicalW, focusX);
      const camY = cameraAxis(level.h * TILE_PX, logicalH, focusY);

      paintTiles(level, camX, camY);

      // THE LANDMARKS, directly on the terrain and under everything else. A
      // marker is part of the map rather than a thing standing on it, so a
      // token, a route or a targeting ring all draw over it — you must never
      // lose a friend behind a town.
      if (scene.sites !== undefined) paintSites(scene.sites, camX, camY);

      // The targeting layer, between the terrain and the tokens. See `TargetCell`.
      if (scene.targeting !== undefined) paintTargeting(scene.targeting, camX, camY);

      // The travel route, in the same band and for the same reason: ground
      // paint, above the floor and below the token rings. See `Scene.path`.
      if (scene.path !== undefined) paintPath(scene.path, camX, camY);

      // WHAT IS ON THE FLOOR, still in the ground-paint band and last in it — so
      // a route drawn across a pile does not hide the pile, which is frequently
      // what the route was drawn towards. See `Scene.loot` for why this is not
      // above the tokens the way the orbs are.
      if (scene.loot !== undefined) paintLoot(scene.loot, camX, camY);

      // Y-SORT. Painter's algorithm down the screen, so an actor standing lower
      // (larger y, nearer the viewer) draws in front of one behind it — which
      // matters the moment a sprite is taller than its tile. Ties break on x
      // then id so the order is stable frame to frame and identical in both
      // browser tabs; a sort keyed only on y would let two actors on the same
      // row swap depth between frames.
      const ordered = [...scene.actors].sort(
        (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
      );

      // Rings first, ALL of them, then sprites: one pass each. Interleaving
      // them would let the ring of an actor in front paint over the boots of
      // the actor behind.
      for (const actor of ordered) {
        const cellX = actor.x * TILE_PX - camX;
        const cellY = actor.y * TILE_PX - camY;
        if (visible(cellX, cellY)) {
          blitSprite(underTokenIdFor(actor, scene.selfId, scene.downed), cellX, cellY);
        }
      }
      for (const actor of ordered) {
        const cellX = actor.x * TILE_PX - camX;
        const cellY = actor.y * TILE_PX - camY;
        if (visible(cellX, cellY)) blitSprite(actor.sprite, cellX, cellY);
      }

      // THE PIP PASS, after every sprite. Its own pass rather than a tail on the
      // sprite loop for the same reason the rings are: interleaved, the pips of
      // an actor standing behind would be painted over by the boots of the one
      // in front, and a status you cannot see is worse than one you have to
      // hunt for.
      if (scene.effects !== undefined) {
        for (const actor of ordered) {
          const badges = scene.effects.get(actor.id);
          if (badges === undefined || badges.length === 0) continue;
          const cellX = actor.x * TILE_PX - camX;
          const cellY = actor.y * TILE_PX - camY;
          if (visible(cellX, cellY)) paintStatusPips(badges, cellX, cellY);
        }
      }

      // WHAT IS IN THE AIR — the first thing in the band above the tokens, and
      // the only WORLD object in it. See `Scene.projectiles`: everything else up
      // here is either the player's own steering (the route bracket, the
      // cursor), a quarter-second flash, or somebody pointing, and none of those
      // can hide a centred dot because none of them fills a tile opaquely. What
      // an orb must never sit behind is the MONSTER THAT FIRED IT, which is
      // exactly what drawing it with the ground paint would do.
      if (scene.projectiles !== undefined) paintProjectiles(scene.projectiles, camX, camY);

      // The travel destination, in the one band above the y-sorted tokens that
      // is not the sweep beat. BEFORE the cursor, so that in the rare frame
      // holding both, the aim being steered now paints over the older route.
      const pathEnd = scene.pathEnd;
      if (pathEnd !== undefined && pathEnd !== null) paintPathEnd(pathEnd, camX, camY);

      // The cursor's brackets — the only part of the targeting layer above the
      // tokens, and ticks rather than a fill so it frames without hiding.
      const cursor = scene.cursor;
      if (cursor !== undefined && cursor !== null) paintCursor(cursor, camX, camY);

      // The sweep beat — a 240 ms flash that must out-shout everything.
      for (const overlay of scene.overlays ?? []) {
        const cellX = overlay.x * TILE_PX - camX;
        const cellY = overlay.y * TILE_PX - camY;
        if (visible(cellX, cellY)) blitSprite(`ui_tile_marker_${overlay.kind}`, cellX, cellY);
      }

      // Pings LAST, above even the sweep. A person pointing is the one overlay
      // that must never be hidden by the game: it is somebody in the voice
      // channel asking everyone to look at a specific square, and the beat it
      // might land under lasts a fifth of a second while the ping lasts seconds.
      for (const ping of scene.pings ?? []) paintPing(ping, camX, camY);

      lastCamX = camX;
      lastCamY = camY;
    }
    lastLevel = level;

    // The HUD is painted OUTSIDE the level guard, deliberately: whose turn it is
    // must be legible in the seconds before `welcome` lands and during a
    // reconnect, and a turn indicator that vanishes whenever the map does is one
    // nobody trusts afterwards.
    scene.hud?.(backCtx, logicalW, logicalH);

    // Present: clear the letterbox, then ONE integer-scaled blit of the whole
    // backbuffer. Destination origin and size are whole device pixels by
    // construction.
    viewCtx.fillStyle = PALETTE.INK;
    viewCtx.fillRect(0, 0, deviceW, deviceH);
    viewCtx.drawImage(
      back,
      0,
      0,
      logicalW,
      logicalH,
      offsetX,
      offsetY,
      logicalW * scale,
      logicalH * scale,
    );
  }

  function metrics(): RendererMetrics {
    return { logicalW, logicalH, deviceW, deviceH, dpr, scale, offsetX, offsetY };
  }

  /**
   * Undo the present blit, then the camera. See `Renderer.tileAtClient`.
   *
   * The CSS -> device conversion is `deviceW / rect.width` rather than `dpr`,
   * and the difference is not pedantry: those two agree only while the canvas is
   * laid out at exactly the size `resize()` last measured. Between a layout
   * change and the ResizeObserver callback — and permanently, if a CSS transform
   * or a zoomed Discord window ever scales the element — the ratio is the honest
   * number and dpr is not. Getting this wrong puts the cursor a tile off near
   * the edges of the map, which reads as "clicking is inaccurate".
   */
  function backbufferPoint(clientX: number, clientY: number): TileXY | null {
    if (deviceW === 0 || deviceH === 0) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const deviceX = (clientX - rect.left) * (deviceW / rect.width);
    const deviceY = (clientY - rect.top) * (deviceH / rect.height);

    const backX = Math.floor((deviceX - offsetX) / scale);
    const backY = Math.floor((deviceY - offsetY) / scale);
    // On the letterbox bars: nothing was drawn there, and snapping to the
    // nearest edge would let a click outside the playfield hit a slot or a tile.
    if (backX < 0 || backY < 0 || backX >= logicalW || backY >= logicalH) return null;
    return { x: backX, y: backY };
  }

  function tileAtClient(clientX: number, clientY: number): TileXY | null {
    const level = lastLevel;
    if (level === null) return null;

    const point = backbufferPoint(clientX, clientY);
    if (point === null) return null;

    const tx = Math.floor((point.x + lastCamX) / TILE_PX);
    const ty = Math.floor((point.y + lastCamY) / TILE_PX);
    // Reachable whenever the map is smaller than the viewport: `cameraAxis`
    // centres it and returns a negative camera, so the backbuffer legitimately
    // contains pixels that are off the grid.
    if (!inBounds(tx, ty, level.w, level.h)) return null;
    return { x: tx, y: ty };
  }

  return { resize, draw, metrics, backbufferPoint, tileAtClient, setZoom, zoom };
}
