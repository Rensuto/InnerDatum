/**
 * THE TOKEN MENU: right-click a detective, get the two or three things you can
 * do to them.
 *
 * ===========================================================================
 * WHY A MENU AT ALL, IN A GAME THAT IS OTHERWISE A KEYBOARD
 * ===========================================================================
 * Because "how do I group with you" has to be answerable by somebody who has
 * never read a command list. The MUD half is real and stays — `/party invite
 * Sam` works, and for anybody who types it will always be faster — but a player
 * in a voice channel looking at their friend's token will right-click it, and a
 * right-click that does nothing teaches them the feature does not exist.
 *
 * ===========================================================================
 * IT IS DRAWN ON THE CANVAS, NOT IN THE DOM
 * ===========================================================================
 * Everything else on this screen is: the hotbar, the dock, the turn cards. A DOM
 * overlay would sit at CSS pixel scale over a backbuffer that is magnified by an
 * integer factor, so it would be the one surface in the game whose pixels do not
 * line up with the art underneath it — and it would need its own z-index, its
 * own theme and its own focus handling. Two rects and some text cost nothing.
 *
 * ===========================================================================
 * THE WIDTH IS COMPUTED WITHOUT MEASURING, ON PURPOSE
 * ===========================================================================
 * Every other panel measures with `ctx.measureText`. This one cannot: the menu
 * is opened by one event and hit-tested by another, and both may happen between
 * two draws — a hit test that needed a canvas context would have to remember a
 * rect from the last frame, and a menu that has never been drawn would then
 * swallow clicks at 0,0. So the box is sized from the LABELS, in a fixed-advance
 * font, and every string here is ASCII by construction (they are written in this
 * file; only the TITLE is a player's nickname, and it is truncated by character
 * count rather than by pixels). The layout is therefore pure geometry and one
 * function answers for both the painter and the pointer.
 */

import { PALETTE } from '../render/canvas.ts';
import { drawPanel, PanelSkin } from './panel.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { PartyAction } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/**
 * THE THINGS A RIGHT-CLICK CAN MEAN THAT ARE NOT ABOUT A PARTY.
 *
 * `PartyAction` is a WIRE verb — the client puts it in a frame and the server
 * decides what it means. Four of these five are the opposite: `Travel`,
 * `Attack`, `Point` and `Inspect` are resolved by the CLIENT and then expressed
 * in verbs that already exist. `Travel` and `Attack` both come out the far end as
 * `{t:'move',dir}` (there is no attack intent — walking into a hostile IS the
 * attack), `Point` is the existing `{t:'point',x,y}`, and `Inspect` is the one
 * that adds a frame.
 *
 * ═══ `Pickup` (v10) IS THE EXCEPTION, AND IT IS WORTH SAYING WHY ═══
 * Its value IS the wire tag — `{t:'pickup'}` goes out exactly as written — which
 * makes it the first member of this object that behaves like a `PartyAction`
 * rather than like its four neighbours. It stays here rather than moving to the
 * protocol's own vocabulary because it is a row about a TILE, which is what this
 * object is for, and because `pickup` has no arguments at all: the server reads
 * the sender's own live position and takes index 0 of that tile, so there is
 * nothing for the menu to name. The row's whole job is to say the verb exists and
 * whether the viewer is standing in the right place to use it.
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on, and an enum emits runtime code the type-stripping loader will not
 * accept.
 */
export const MapVerb = {
  Travel: 'travel',
  Attack: 'attack',
  Inspect: 'inspect',
  Point: 'point',
  Pickup: 'pickup',
  /**
   * SPEAK TO SOMEBODY WHO LIVES HERE.
   *
   * A separate verb from `Attack` rather than a mode of it, because they are
   * mutually exclusive by faction and a menu row that means two different things
   * depending on who is under the cursor is the row people misclick.
   */
  Talk: 'talk',
} as const;
export type MapVerb = (typeof MapVerb)[keyof typeof MapVerb];

export type MenuItem = {
  /**
   * THE WIRE'S OWN VERB, not a menu-private enum that would have to be
   * translated. `PartyAction` is already the closed set of things a player may
   * do about a party (protocol.ts), so a row IS one of them and main.ts sends
   * it without a lookup table in between — one vocabulary, no drift.
   *
   * `MapVerb` sits BESIDE it rather than replacing it, and the union is the
   * whole point: `PartyAction` stays verbatim — the party rows keep sending the
   * value the schema already names — and `MapVerb` is the disjoint set of rows
   * that resolve locally in the client instead of going out as themselves. Two
   * origins, one row type, and a `switch` over `action` that the compiler can
   * still check for exhaustiveness.
   */
  readonly action: PartyAction | MapVerb;
  readonly label: string;
  /**
   * A disabled row is still DRAWN, greyed, rather than dropped.
   *
   * The alternative is a menu whose shape changes with state, so the row you
   * were reaching for moves — and a player who cannot see "Kick" at all learns
   * nothing about why they cannot use it. Same rule the hotbar follows for a
   * slot on cooldown.
   */
  readonly enabled: boolean;
};

export type ContextMenuOptions = {
  /** Something drawable changed: the menu opened, closed or changed hover. */
  readonly onChange: () => void;
};

export type ContextMenuDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
};

export type ContextMenu = {
  /**
   * Open at a LOGICAL backbuffer point, clamped inside the viewport.
   *
   * `title` is the target's name and is drawn as a heading, never as a row: a
   * nickname is hostile input and a heading cannot be clicked by accident.
   */
  readonly open: (options: {
    readonly x: number;
    readonly y: number;
    readonly title: string;
    readonly items: readonly MenuItem[];
    readonly viewportW: number;
    readonly viewportH: number;
    /**
     * The actor the menu is ABOUT, handed back with whatever is picked.
     *
     * OPTIONAL because a menu opened on BARE GROUND has no actor at all — the
     * "Travel here"/"Point here" rows are about a tile and nothing else. The
     * accessor's signature already permitted null; this makes the opener agree
     * with it rather than forcing a caller to invent a sentinel id, which is
     * exactly how an empty string ends up on the wire as a target.
     */
    readonly targetId?: string;
    /** The tile the menu is ABOUT, for the ground rows. Set instead of `targetId`. */
    readonly targetTile?: TileXY;
  }) => void;
  /** Returns true if it was open — so Escape can know whether it consumed the key. */
  readonly close: () => boolean;
  readonly visible: () => boolean;
  /** The actor the open menu is about, or null. */
  readonly targetId: () => string | null;
  /**
   * The tile the open menu is about, or null.
   *
   * Which of the two accessors answers is how the caller tells "walk up to that
   * husk" from "travel to that patch of floor": both rows carry
   * `MapVerb.Travel`, and only the target differs.
   */
  readonly targetTile: () => TileXY | null;
  readonly rect: () => PanelRect | null;
  /** Move the highlight. Returns true when it changed, so the caller can redraw. */
  readonly hoverAt: (px: number, py: number) => boolean;
  /** The ENABLED item under a point, or null. Disabled rows swallow the click. */
  readonly itemAt: (px: number, py: number) => MenuItem | null;
  /** True when the point is anywhere on the menu — including its border. */
  readonly contains: (px: number, py: number) => boolean;
  readonly draw: (options: ContextMenuDrawOptions) => void;
};

/**
 * Advance of one glyph in the 10px monospace this file draws with.
 *
 * Six pixels, measured from the same `ui-monospace, Consolas, monospace` stack
 * every other panel uses. It is an ESTIMATE and it is allowed to be: it only
 * decides how wide the box is, and the labels are clamped to the box either way.
 * Nothing here positions one string against another.
 */
const CHAR_W = 6;
const ROW_H = 16;
const TITLE_H = 15;
const PAD = 5;
const BORDER = 1;
const MIN_W = 96;
const MAX_W = 184;
/** A nickname longer than this is cut. The menu is not a place to read an essay. */
const TITLE_MAX_CHARS = 22;

const FONT_ITEM = '10px ui-monospace, Consolas, monospace';
const FONT_TITLE = 'bold 10px ui-monospace, Consolas, monospace';

type OpenMenu = {
  readonly rect: PanelRect;
  readonly title: string;
  readonly items: readonly MenuItem[];
  readonly targetId: string | undefined;
  readonly targetTile: TileXY | undefined;
  hovered: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The box, from the strings alone. See the header for why nothing is measured. */
function menuRect(
  x: number,
  y: number,
  title: string,
  items: readonly MenuItem[],
  viewportW: number,
  viewportH: number,
): PanelRect {
  const widest = items.reduce(
    (longest, item) => Math.max(longest, item.label.length),
    title.length,
  );
  const w = clamp(widest * CHAR_W + PAD * 2 + BORDER * 2, MIN_W, MAX_W);
  const h = TITLE_H + items.length * ROW_H + PAD * 2;
  // Opens DOWN AND RIGHT of the pointer like every menu anyone has used, and
  // flips rather than slides when that would run off the edge: a menu that slid
  // would put a different row under the cursor than the one the click was aimed
  // at.
  const px = x + w <= viewportW ? x : Math.max(0, x - w);
  const py = y + h <= viewportH ? y : Math.max(0, y - h);
  return {
    x: clamp(px, 0, Math.max(0, viewportW - w)),
    y: clamp(py, 0, Math.max(0, viewportH - h)),
    w,
    h,
  };
}

/** Row rects, top down. One function, called by the painter AND the hit test. */
function itemRects(menu: OpenMenu): PanelRect[] {
  const x = menu.rect.x + BORDER;
  const w = menu.rect.w - BORDER * 2;
  const top = menu.rect.y + PAD + TITLE_H;
  return menu.items.map((_item, index) => ({ x, y: top + index * ROW_H, w, h: ROW_H }));
}

export function createContextMenu(options: ContextMenuOptions): ContextMenu {
  let menu: OpenMenu | null = null;

  const inside = (rect: PanelRect, px: number, py: number): boolean =>
    px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;

  function indexAt(px: number, py: number): number {
    if (menu === null) return -1;
    const rects = itemRects(menu);
    for (let i = 0; i < rects.length; i += 1) {
      const rect = rects[i];
      if (rect !== undefined && inside(rect, px, py)) return i;
    }
    return -1;
  }

  return {
    open: (opts) => {
      const title =
        opts.title.length > TITLE_MAX_CHARS
          ? `${opts.title.slice(0, TITLE_MAX_CHARS - 1)}…`
          : opts.title;
      menu = {
        rect: menuRect(opts.x, opts.y, title, opts.items, opts.viewportW, opts.viewportH),
        title,
        items: opts.items,
        targetId: opts.targetId,
        targetTile: opts.targetTile,
        hovered: -1,
      };
      options.onChange();
    },

    close: () => {
      if (menu === null) return false;
      menu = null;
      options.onChange();
      return true;
    },

    visible: () => menu !== null,
    targetId: () => menu?.targetId ?? null,
    targetTile: () => menu?.targetTile ?? null,
    rect: () => menu?.rect ?? null,

    hoverAt: (px, py) => {
      if (menu === null) return false;
      const next = indexAt(px, py);
      if (next === menu.hovered) return false;
      menu.hovered = next;
      options.onChange();
      return true;
    },

    itemAt: (px, py) => {
      if (menu === null) return null;
      const index = indexAt(px, py);
      if (index < 0) return null;
      const item = menu.items[index];
      // A DISABLED ROW IS NOT A MISS. The caller closes the menu either way, so
      // clicking "Kick" while you are not the leader does not fall through to
      // the map underneath and ping a tile.
      return item !== undefined && item.enabled ? item : null;
    },

    contains: (px, py) => menu !== null && inside(menu.rect, px, py),

    draw: ({ ctx, sprites }) => {
      const open = menu;
      if (open === null) return;

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      drawPanel(ctx, sprites, PanelSkin.Inset, open.rect);

      const textX = open.rect.x + BORDER + PAD;
      ctx.font = FONT_TITLE;
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillText(open.title, textX, open.rect.y + PAD + TITLE_H / 2);
      ctx.fillStyle = PALETTE.SLATE;
      ctx.fillRect(
        open.rect.x + BORDER,
        open.rect.y + PAD + TITLE_H - 1,
        open.rect.w - BORDER * 2,
        1,
      );

      const rects = itemRects(open);
      ctx.font = FONT_ITEM;
      for (let i = 0; i < open.items.length; i += 1) {
        const item = open.items[i];
        const rect = rects[i];
        if (item === undefined || rect === undefined) continue;
        if (item.enabled && i === open.hovered) {
          ctx.fillStyle = PALETTE.SLATE;
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
        ctx.fillStyle = !item.enabled
          ? PALETTE.GREY
          : i === open.hovered
            ? PALETTE.GOLD
            : PALETTE.BONE;
        ctx.fillText(item.label, textX, rect.y + rect.h / 2);
      }

      ctx.restore();
    },
  };
}
