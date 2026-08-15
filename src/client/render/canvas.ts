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
import { ActorRank, TileCode } from '../../shared/protocol.ts';
import { TILE_PX } from '../../shared/version.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { ActorView, DownedView, EffectView, LevelView } from '../../shared/protocol.ts';
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

/** Everything one frame needs. The renderer holds no game state of its own. */
export type Scene = {
  readonly level: LevelView | null;
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
export const DEFAULT_VIEWPORT: Viewport = { tilesW: 20, tilesH: 15 };

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
 * quietly painting the new terrain as floor.
 */
function tileFill(code: TileCode): string {
  switch (code) {
    case TileCode.FLOOR:
      return PALETTE.PANEL;
    case TileCode.WALL:
      return PALETTE.VOID;
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
  let offsetX = 0;
  let offsetY = 0;

  // The camera and level of the LAST drawn frame, kept solely so `tileAtClient`
  // can invert the transform the player is actually looking at. Nothing reads
  // these while drawing; they are written at the end of `draw` and never before.
  let lastCamX = 0;
  let lastCamY = 0;
  let lastLevel: LevelView | null = null;

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
    scale = Math.max(1, Math.floor(Math.min(deviceW / minLogicalW, deviceH / minLogicalH)));

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

        backCtx.fillStyle = tileFill(code);
        backCtx.fillRect(sx, sy, TILE_PX, TILE_PX);

        if (code === TileCode.WALL) {
          // A lit top edge. Without it a flat wall colour reads as a hole in
          // the floor rather than as something solid you cannot walk through.
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

    const arm = CURSOR_TICK_PX;
    const thick = CURSOR_TICK_THICK;
    const far = TILE_PX - thick;
    const near = TILE_PX - arm;

    backCtx.fillStyle = PALETTE.GOLD;
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

      // The targeting layer, between the terrain and the tokens. See `TargetCell`.
      if (scene.targeting !== undefined) paintTargeting(scene.targeting, camX, camY);

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

  return { resize, draw, metrics, backbufferPoint, tileAtClient };
}
