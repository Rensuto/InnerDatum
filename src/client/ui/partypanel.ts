/**
 * THE PARTY PANE: who you are actually playing with, down the LEFT of the map.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AND ui/party.ts DOES NOT ANY MORE
 * ===========================================================================
 * The old panel drew `PartyMsg.members` — every player on the FLOOR — and called
 * it the party. That was true enough while everyone on the floor was one group
 * of friends in one voice channel. It stopped being true the first evening two
 * people played:
 *
 *   *"When I had my friend test, his character is still showing. We need to
 *     ensure that him being AFK, not in game, etc doesn't affect solo players."*
 *
 * A body inside its ten-minute reconnect grace stays in the world ON PURPOSE
 * (M2: a dropped socket must not yank somebody out of a fight), so it stayed in
 * that list, and a player alone on the floor was shown a party they were not in.
 * From v6 a PARTY is a thing you join: `party_state` (protocol.ts) is the
 * viewer's own party, the barrier is scoped to it, and this pane draws that
 * frame and nothing else. A solo player is a party of one and sees one row —
 * never an empty box, because "you are playing alone" is worth stating plainly.
 *
 * The old file drew the same surface on the right and is deleted rather than
 * left disabled — two files drawing one panel is the bug ui/turncards.ts was
 * opened to fix, and it is not a bug worth having twice. Everything that was
 * right about it is here: the badge column, the Downed rail and countdown, the
 * microphone, and the colour rule below.
 *
 * ===========================================================================
 * IT DRAWS THE FRAME, AND JOINS ONLY WHAT THE FRAME CANNOT CARRY
 * ===========================================================================
 * `PartyStateMember` already carries the name, the hp, the barrier state, who
 * leads and whether anybody is attached to the body — deliberately, because a
 * party member may be outside the viewer's FOV and therefore absent from the
 * actor map. So this pane never joins for those. It joins for exactly three
 * things the party frame does not describe:
 *
 *   the TOKEN     `ActorView.sprite`, when the body is on screen. 24x32, blitted
 *                 1:1. `PartyStateMember.portrait` is the 64x64 class icon the
 *                 turn cards use and is deliberately NOT drawn here: cropping a
 *                 64px face into a 24px box is a nose, and scaling it is the
 *                 resampling render/canvas.ts's backbuffer exists to prevent.
 *                 Out of view the row falls back to initials.
 *   the DOWNED    `PartyMsg.members[].downed`, which owns the countdown. One
 *   COUNTDOWN     ticking number, one frame, no second copy to disagree.
 *   the BADGES    the `effects` snapshot, which is keyed by actor id.
 *
 * ===========================================================================
 * ON THE LEFT, AND IT MUST NOT COST THE MAP MORE THAN IT IS WORTH
 * ===========================================================================
 * The Case Log keeps the right-hand dock, so the two surfaces no longer stack
 * and neither has to shrink for the other. Both OVERLAY the map rather than
 * shrinking the camera — see the note in main.ts: a camera that changed width
 * with a panel would change the integer scale factor and make toggling a panel
 * resize the art.
 *
 * That overlay is exactly why this file measures the map. `partyPaneLayout`
 * computes what is left CLEAR between the two panels and:
 *
 *   - full rows, 208 wide, while at least ten tile columns stay clear;
 *   - otherwise PORTRAITS ONLY, 44 wide — the token, the rails, a hp sliver;
 *   - and nothing at all if even that would bury the playfield.
 *
 * It degrades in one step to a form that spends every pixel on identity rather
 * than shrinking rows until the text is a smear. That is the same cliff
 * ui/turncards.ts drops off at `CARD_W_FULL_MIN`, for the same reason: there is
 * no honest halfway house between "a row with words on it" and "a face".
 *
 * ===========================================================================
 * THE ROW ORDER IS THE SERVER'S AND IS NEVER RE-SORTED HERE
 * ===========================================================================
 * `PartyStateMsg.members` is join order and stable, and protocol.ts asks for
 * that guarantee to be respected for a concrete reason: KICK IS ON THIS PANE. A
 * row that moves between two frames is a row somebody misclicks, and the click
 * that lands one row off removes the wrong person from the party. You are found
 * by MARKER instead — a wash, a '>' and gold, the same three the turn cards use.
 *
 * ===========================================================================
 * NEVER COLOUR ALONE. EVER.
 * ===========================================================================
 * Roughly one man in twelve cannot separate the red from the green, the Discord
 * overlay is not colour-managed, and this pane is read in glances:
 *
 *   - AWAY is the word "away", a HATCH over the token (a shape, which is what
 *     survives greyscale and the corner of an eye) and a greyed name;
 *   - DOWNED is a solid rail down the left of the row, a hatched empty hp track,
 *     and the countdown "DOWN 3/5" — four signals, one of which is colour;
 *   - the LEADER is a gold pennant on the token AND the word LEAD;
 *   - YOU are a wash, a '>' prefix and gold;
 *   - a status badge is a distinct 24x24 PICTURE carrying its own turn count;
 *   - hp is a bar AND the digits.
 *
 * ===========================================================================
 * HIT TESTING IS GEOMETRY, NOT A REMEMBERED RECT
 * ===========================================================================
 * `paneGeometry` is called by the painter AND by `partyPaneHitAt`, exactly as
 * `slotRect` is in ui/hotbar.ts. Two copies of this arithmetic is how an accept
 * button lands one row above where it is drawn, and the bug only shows up on
 * somebody else's window size.
 *
 * IT DRAWS INTO THE BACKBUFFER through `Scene.hud`, at logical scale, like every
 * other ui/ module — see the long note at the top of render/canvas.ts. No second
 * canvas and no DOM overlay: the pane is magnified by the same integer factor as
 * the world, so it can never be half a pixel off the art beside it.
 */

import type { HoverCard } from './panel.ts';
import { DownedStatus, TurnActorState, VoiceState } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { drawHeader, drawPanel, fitText, HEADER_H, PANEL_PAD, PanelSkin } from './panel.ts';
import type {
  ActorView,
  DownedView,
  EffectView,
  PartyInviteView,
  PartyMember,
  PartyStateMember,
  PartyStateMsg,
} from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';
import { HP_LOW } from '../../shared/vitals.ts';

// ---------------------------------------------------------------------------
// Geometry. See the layout note in the header before changing any of it.
// ---------------------------------------------------------------------------

/** The full pane. Same width the dock has always been, so the two match. */
export const PARTY_PANE_W = 208;
/** Rail, gutter and one 24-wide token. Everything else is dropped. */
export const PARTY_PANE_COMPACT_W = 44;
/** One full row: a 32px token with a pixel of air, two text lines beside it. */
export const PARTY_ROW_H = 34;
/** One portrait-only row: the token, then a 3px hp sliver under it. */
export const PARTY_ROW_COMPACT_H = 38;
/** Distance from the viewport edge. Matches the dock's own margin in main.ts. */
export const PARTY_PANE_MARGIN = 3;

/** An incoming invite: one line of prose and a row of two buttons. */
const INVITE_H = 34;
const BUTTON_H = 14;

/**
 * The FOLLOW control on the row of a member who is in another realm.
 *
 * A WORD, NOT A SPRITE, for the reason the pane's DROP and ACCEPT controls are
 * words: a new icon is a new asset, and the art tree is the one thing in this
 * project that cannot be added to from a keyboard.
 */
const FOLLOW_W = 44;
const FOLLOW_H = 11;

/** Authored token size for `chr_player_*`. Blitted 1:1, cropped, never scaled. */
const TOKEN_W = 24;
const TOKEN_H = 32;
/** The authored badge size. Every `icon_status_*` in the manifest is 24x24. */
const BADGE_PX = 24;
/** The authored speaking indicator. Both `ui_icon_speaking*` are 16x16. */
const VOICE_PX = 16;
const BADGE_GAP = 2;

/**
 * Two badges, not three. The old panel had 200 pixels of row and no token; this
 * one spends 29 of them on the picture that says WHO, which is the question a
 * party pane exists to answer. The overflow is printed as "+2" rather than
 * dropped silently: "there is more on me than you can see" is itself
 * information, and a row that quietly hides the third status is a row that hides
 * the one that is killing somebody.
 */
const MAX_BADGES = 2;

/** Below this fraction the bar turns, and the row earns a word as well. */

const BAR_H = 7;
const COMPACT_BAR_H = 3;

/**
 * How much map has to stay clear for the full pane to be worth its width.
 *
 * TEN TILE COLUMNS of the twenty the default viewport shows. It is the same
 * number main.ts's dock note already committed to ("narrow enough to leave ten
 * of the twenty tile columns clear"), stated once here because it is now a
 * decision this file makes rather than a fact about a constant.
 */
const MAP_MIN_CLEAR_PX = 320;
/**
 * ...and the floor below which even the portrait strip is dropped entirely.
 * Eight columns is the least anybody can fight in; a pane that buries the
 * playfield is a pane nobody wants, and `p` brings it back.
 */
const MAP_MIN_CLEAR_HARD_PX = 256;
/** A pane shorter than a header plus one row is noise. */
const PANE_MIN_H = HEADER_H + PARTY_ROW_H;

const FONT_NAME = '10px ui-monospace, Consolas, monospace';
const FONT_NAME_SELF = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_SMALL = '10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';
/** The badge's turn counter. Small, because it sits inside a 24px square. */
const FONT_BADGE = 'bold 9px ui-monospace, Consolas, monospace';
/** Initials, for a body that is out of view. Fills the 24x32 token box. */
const FONT_INITIALS = 'bold 14px ui-monospace, Consolas, monospace';

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * TWO FORMS, ONE PANE. Which one is in use is decided by `partyPaneLayout` and
 * carried in the layout, so the painter and the hit test cannot disagree about
 * it — the accept button exists in one form and not the other.
 */
export const PartyPaneMode = {
  Rows: 'rows',
  Portraits: 'portraits',
} as const;
export type PartyPaneMode = (typeof PartyPaneMode)[keyof typeof PartyPaneMode];

/**
 * ONE ROW: the `party_state` member, plus the three things that frame cannot
 * carry. See the join note in the header.
 */
export type PartyPaneRow = {
  readonly member: PartyStateMember;
  /** The map sprite's asset key, or null when the body is out of view. */
  readonly sprite: string | null;
  /** From the level roster, and the owner of the countdown. Null when upright. */
  readonly downed: DownedView | null;
  readonly voice: VoiceState;
  readonly effects: readonly EffectView[];
};

export type PartyPaneView = {
  readonly rows: readonly PartyPaneRow[];
  /** Offers waiting on the VIEWER. Outgoing ones are not on the wire at all. */
  readonly invites: readonly PartyInviteView[];
  /**
   * IS THERE A FIGHT ON.
   *
   * The one thing that decides whether a barrier state is worth a word. Out of
   * combat nobody blocks and every member reads `committed`, so printing DONE
   * beside four names would tell four people they are waiting on each other
   * while they walk around freely — the exact failure ui/turncards.ts refuses to
   * draw a strip for.
   */
  readonly inCombat: boolean;
};

export type PartyPaneLayout = {
  readonly rect: PanelRect;
  readonly mode: PartyPaneMode;
};

export type PartyPaneOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: PartyPaneView;
  readonly layout: PartyPaneLayout;
};

/** What a click on the pane landed on. Null is "the panel, but nothing in it". */
export type PartyPaneHit =
  | { readonly kind: 'member'; readonly id: string }
  /** The FOLLOW word on the row of a member who is in another realm. */
  | { readonly kind: 'follow'; readonly id: string }
  | { readonly kind: 'accept'; readonly fromId: string }
  | { readonly kind: 'decline'; readonly fromId: string };

/**
 * Build the pane's rows.
 *
 * HERE RATHER THAN IN main.ts because the join is the part with a rule in it,
 * and because the ORDER is a promise: `state.members` is used exactly as it
 * arrives. Anything this cannot find — a body out of FOV, a member the roster
 * frame has not caught up with — degrades to a row without that one signal
 * rather than to no row at all.
 */
export function partyPaneView(options: {
  readonly state: PartyStateMsg;
  /** Invites that have NOT lapsed. main.ts owns the clock and does the filtering. */
  readonly invites: readonly PartyInviteView[];
  /** The level roster, for the Downed countdown and the microphone. */
  readonly roster: readonly PartyMember[];
  readonly actors: ReadonlyMap<string, ActorView>;
  readonly effects: ReadonlyMap<string, readonly EffectView[]>;
  readonly inCombat: boolean;
}): PartyPaneView {
  const roster = new Map(options.roster.map((member) => [member.id, member]));

  return {
    rows: options.state.members.map((member) => {
      const level = roster.get(member.id);
      return {
        member,
        sprite: options.actors.get(member.id)?.sprite ?? null,
        /**
         * THE ROSTER FIRST, AND THE PARTY FRAME FOR EVERYBODY ELSE.
         *
         * Both are `downedView` reading one survival table, so where both answer
         * they agree — and preferring the roster keeps a body on your own floor
         * described by the frame that has always described it.
         *
         * The fallback is the whole point: a member who walked into an instance
         * is in NO floor roster of yours, so until now this read `null` for them
         * and the countdown that makes a rescue matter was invisible to the only
         * people who could act on it.
         */
        downed: level?.downed ?? member.downed ?? null,
        voice: level?.voice ?? VoiceState.Silent,
        effects: options.effects.get(member.id) ?? [],
      };
    }),
    invites: options.invites,
    inCombat: options.inCombat,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** How tall the pane wants to be, before the viewport has its say. */
export function partyPaneHeight(view: PartyPaneView, mode: PartyPaneMode): number {
  const inset = PANEL_PAD + 3;
  if (mode === PartyPaneMode.Portraits) {
    const flag = view.invites.length > 0 ? BUTTON_H : 0;
    return inset * 2 + flag + view.rows.length * PARTY_ROW_COMPACT_H;
  }
  return HEADER_H + inset * 2 + view.invites.length * INVITE_H + view.rows.length * PARTY_ROW_H;
}

/**
 * WHERE THE PANE GOES, WHICH FORM IT WEARS, OR NULL FOR "NOT NOW".
 *
 * ONE function, called by the painter AND by every hit test, for the reason
 * `slotRect` in ui/hotbar.ts is: two copies of this arithmetic is how a click
 * lands on a tile that is underneath a panel, and the bug only shows up on
 * somebody else's window size.
 *
 * `rightReserved` is whatever the Case Log dock is taking on the other side,
 * PASSED IN rather than imported, so this file does not have to know that the
 * log exists — only that something is over there.
 */
export function partyPaneLayout(options: {
  readonly view: PartyPaneView;
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** First free pixel under the top HUD. */
  readonly top: number;
  /** First pixel of the bottom bands (the hotbar and the prose lines). */
  readonly bottom: number;
  readonly rightReserved: number;
}): PartyPaneLayout | null {
  const { view, width, top, bottom, rightReserved } = options;
  // NEVER AN EMPTY BOX. No rows means no `party_state` yet — say nothing rather
  // than drawing a header over a void, and never invent a party of one before
  // the server has described it.
  if (view.rows.length === 0) return null;

  const available = bottom - top;
  if (available < PANE_MIN_H) return null;

  const clearWith = (paneW: number): number =>
    width - rightReserved - paneW - PARTY_PANE_MARGIN * 2;

  const mode =
    clearWith(PARTY_PANE_W) >= MAP_MIN_CLEAR_PX ? PartyPaneMode.Rows : PartyPaneMode.Portraits;
  const paneW = mode === PartyPaneMode.Rows ? PARTY_PANE_W : PARTY_PANE_COMPACT_W;
  if (clearWith(paneW) < MAP_MIN_CLEAR_HARD_PX) return null;

  return {
    rect: {
      x: PARTY_PANE_MARGIN,
      y: top,
      w: paneW,
      h: Math.min(partyPaneHeight(view, mode), available),
    },
    mode,
  };
}

/** One laid-out invite, with the two rects a click can land in. */
type InviteSlot = {
  readonly invite: PartyInviteView;
  readonly rect: PanelRect;
  readonly accept: PanelRect;
  readonly decline: PanelRect;
};

type PaneGeometry = {
  readonly invites: readonly InviteSlot[];
  readonly rows: readonly {
    readonly row: PartyPaneRow;
    readonly rect: PanelRect;
    /**
     * The FOLLOW word, when this member is somewhere else and can be reached.
     *
     * IT SITS IN THE STATE-WORD SLOT, which is free for exactly these rows: the
     * state word says what the BARRIER is doing about somebody, and a member in
     * another realm is counting down under a different Bell entirely.
     */
    readonly follow: PanelRect | null;
  }[];
};

/**
 * Everything inside the pane, in one pass, TOP DOWN: invites first, then rows.
 *
 * INVITES ABOVE THE ROSTER, deliberately. An invite is a task with somebody
 * waiting on the other end of it and a clock running on it; a row is a status.
 * The roster moving down by one block when a request arrives is the cost, and it
 * is paid a handful of times a session at the exact moment the pane is what the
 * player should be looking at.
 *
 * Rows that do not fit are DROPPED rather than shrunk — half a row is worse than
 * none — and an invite is never dropped, which is the whole reason it is laid
 * out first.
 */
function paneGeometry(view: PartyPaneView, layout: PartyPaneLayout): PaneGeometry {
  const inset = PANEL_PAD + 3;
  const compact = layout.mode === PartyPaneMode.Portraits;
  const { rect } = layout;

  const x = rect.x + inset;
  const w = Math.max(0, rect.w - inset * 2);
  const bottom = rect.y + rect.h - inset;
  let y = (compact ? rect.y : rect.y + HEADER_H) + inset;

  const invites: InviteSlot[] = [];
  if (!compact) {
    for (const invite of view.invites) {
      if (y + INVITE_H > bottom) break;
      const buttonY = y + INVITE_H - BUTTON_H - 2;
      const half = Math.floor((w - 4) / 2);
      invites.push({
        invite,
        rect: { x, y, w, h: INVITE_H },
        accept: { x, y: buttonY, w: half, h: BUTTON_H },
        decline: { x: x + half + 4, y: buttonY, w: half, h: BUTTON_H },
      });
      y += INVITE_H;
    }
  } else if (view.invites.length > 0) {
    // The compact form has no room for two buttons, so it carries a MARK rather
    // than a control: main.ts says the sentence in the notice line and the
    // status line, and `/accept` is the way through. A button too small to read
    // is worse than a command.
    y += BUTTON_H;
  }

  const rowH = compact ? PARTY_ROW_COMPACT_H : PARTY_ROW_H;
  const rows: { row: PartyPaneRow; rect: PanelRect; follow: PanelRect | null }[] = [];
  for (const row of view.rows) {
    if (y + rowH > bottom) break;
    // NOT IN THE COMPACT FORM. `FOLLOW` is a word, and the portraits mode has
    // no room for a word — the same reason its invites carry a mark rather than
    // two buttons. A player on a narrow window uses the row menu instead.
    const canFollow = !compact && row.member.away?.canFollow === true;
    rows.push({
      row,
      rect: { x, y, w, h: rowH },
      follow: canFollow ? { x: x + w - FOLLOW_W, y: y + 1, w: FOLLOW_W, h: FOLLOW_H } : null,
    });
    y += rowH;
  }

  return { invites, rows };
}

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * Computed from the same `paneGeometry` the painter uses — see the header. It
 * answers `member` for a row so the caller can open the same token menu a
 * right-click on the map opens: the pane is the one place a player can reach
 * somebody who is off screen.
 */
export function partyPaneHitAt(
  view: PartyPaneView,
  layout: PartyPaneLayout,
  px: number,
  py: number,
): PartyPaneHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  if (!inside(layout.rect)) return null;

  const geometry = paneGeometry(view, layout);
  for (const slot of geometry.invites) {
    if (inside(slot.accept)) return { kind: 'accept', fromId: slot.invite.fromId };
    if (inside(slot.decline)) return { kind: 'decline', fromId: slot.invite.fromId };
  }
  for (const slot of geometry.rows) {
    // THE CONTROL BEFORE THE ROW, so the word wins over the menu it sits on.
    if (slot.follow !== null && inside(slot.follow)) {
      return { kind: 'follow', id: slot.row.member.id };
    }
    if (inside(slot.rect)) return { kind: 'member', id: slot.row.member.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Two letters, for a body with no sprite. `Bent Watchman` -> `BW`. */
function initialsOf(name: string): string {
  const words = name.split(' ').filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return '?';
  const second = words[1];
  const a = [...first][0] ?? '?';
  const b = second === undefined ? '' : ([...second][0] ?? '');
  return `${a}${b}`.toUpperCase();
}

/**
 * Diagonal ink over a token nobody is driving, or a body on the floor.
 *
 * A SHAPE, which is the point — it survives greyscale and the corner of an eye,
 * and it is the same "this one is out" grammar `ui_hotbar_slot_disabled` and the
 * turn cards already carry. Clipped to the box so the strokes cannot run over
 * the text beside it.
 */
function hatchOver(ctx: CanvasRenderingContext2D, box: PanelRect): void {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.strokeStyle = PALETTE.INK;
  ctx.lineWidth = 2;
  for (let offset = -box.h; offset < box.w; offset += 6) {
    ctx.beginPath();
    ctx.moveTo(box.x + offset, box.y + box.h);
    ctx.lineTo(box.x + offset + box.h, box.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The token: the same sprite that is standing on the map, blitted 1:1.
 *
 * NEVER SCALED, and never the 64x64 class portrait — see the join note in the
 * header. When the body is out of view (which is exactly when a party pane earns
 * its keep) the fallback is INITIALS rather than a blank, so the row still says
 * who it is about.
 */
function drawToken(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  box: PanelRect,
): void {
  if (box.w <= 0 || box.h <= 0) return;
  const sprite = row.sprite === null ? undefined : sprites.sprite(row.sprite);
  if (sprite === undefined) {
    ctx.save();
    ctx.font = FONT_INITIALS;
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(initialsOf(row.member.name), box.x + box.w / 2, box.y + box.h / 2);
    ctx.restore();
    return;
  }

  const sw = Math.min(sprite.w, box.w);
  const sh = Math.min(sprite.h, box.h);
  const sx = Math.floor((sprite.w - sw) / 2);
  // Crop from the TOP when the sprite is taller than the box: the feet are the
  // half that identifies a body, which is how render/canvas.ts anchors it too.
  const sy = sprite.h - sh;
  ctx.drawImage(
    sprite.image,
    sx,
    sy,
    sw,
    sh,
    box.x + Math.floor((box.w - sw) / 2),
    box.y + (box.h - sh),
    sw,
    sh,
  );
}

/**
 * The gold pennant that says LEADER, in the token's top-left corner.
 *
 * A shape as well as a colour, and it is drawn on the token rather than in the
 * text so the portrait-only form keeps it. The word LEAD rides the name line in
 * the full form; neither is load-bearing alone.
 */
function drawLeaderPennant(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.GOLD;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 8, y);
  ctx.lineTo(x, y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The microphone, over the token's bottom-right corner rather than in the text.
 *
 * Three states, three different pictures — and the third is deliberately no
 * picture at all. Silence is the resting state of four people mid-turn, so a
 * glyph for it would be lit almost always, which is the same as not being there.
 * Putting it on the token costs the name column nothing and never moves the text
 * when somebody starts talking.
 */
function drawVoice(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  voice: VoiceState,
  x: number,
  y: number,
): void {
  if (voice === VoiceState.Silent) return;
  const id = voice === VoiceState.Muted ? 'ui_icon_speaking_muted' : 'ui_icon_speaking';
  const sprite = sprites.sprite(id);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
    return;
  }
  // A filled square for "speaking", a hollow one for "muted" — two shapes, not
  // two colours, so a missing PNG does not collapse them into one dot.
  ctx.fillStyle = voice === VoiceState.Muted ? PALETTE.GREY : PALETTE.GOLD;
  ctx.fillRect(x + 3, y + 3, VOICE_PX - 6, VOICE_PX - 6);
  if (voice === VoiceState.Muted) {
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(x + 5, y + 5, VOICE_PX - 10, VOICE_PX - 10);
  }
}

/**
 * A 24x24 badge with its remaining turns in the corner.
 *
 * The fallback is a short BADGE GLYPH in a box rather than the renderer's loud
 * violet marker: a missing badge PNG must not collapse distinguishable statuses
 * into identical error squares, which would break this file's central promise
 * at exactly the moment the art pipeline regressed.
 *
 * ═══ THE GLYPH COMES FROM THE SERVER, AND IT USED TO BE `name[0]` ═══
 * That worked on a roster of three and stopped the moment there were six:
 * Stunned against Slowed, Bleeding against Breached. Only the server sees every
 * effect in the game, so only the server can promise the letters are distinct —
 * `EffectDef.badge`, pinned by a test.
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  effect: EffectView,
  x: number,
  y: number,
): void {
  const sprite = sprites.sprite(effect.icon);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
  } else {
    ctx.fillStyle = PALETTE.VOID;
    ctx.fillRect(x, y, BADGE_PX, BADGE_PX);
    ctx.fillStyle = effect.harmful ? PALETTE.ORANGE : PALETTE.GOLD;
    ctx.fillRect(x, y, BADGE_PX, 1);
    ctx.fillRect(x, y + BADGE_PX - 1, BADGE_PX, 1);
    ctx.fillRect(x, y, 1, BADGE_PX);
    ctx.fillRect(x + BADGE_PX - 1, y, 1, BADGE_PX);
    ctx.font = FONT_META;
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.PARCHMENT;
    // THE SERVER'S LETTERS, because it is the only side that sees every effect
    // in the game and can therefore promise these are distinct. The initial is
    // kept as the fallback's fallback: a server too old to send one still draws
    // something, which is what this whole branch is for.
    const glyph = effect.badge ?? effect.name.charAt(0).toUpperCase();
    ctx.fillText(glyph, x + BADGE_PX / 2, y + BADGE_PX / 2 - 2);
    ctx.textAlign = 'left';
  }

  // The badge says WHAT, the number says HOW MUCH LONGER, and the second
  // question is the one that decides whether anybody waits it out. Outlined so
  // it survives both a dark badge and a bright one.
  if (effect.turns <= 0) return;
  const digits = `${Math.ceil(effect.turns)}`;
  ctx.save();
  ctx.font = FONT_BADGE;
  ctx.textAlign = 'right';
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.INK;
  ctx.strokeText(digits, x + BADGE_PX - 1, y + BADGE_PX - 2);
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(digits, x + BADGE_PX - 1, y + BADGE_PX - 2);
  ctx.restore();
}

/**
 * The hp bar: a track, a fill, and (in the full form) the digits beside it.
 *
 * A RECT, NOT AN IMAGE, deliberately: a bar is a FRACTION of a width that
 * changes with the pane and the party size, and art would need either a frame
 * per step or one stretched PNG resampled to a fractional width — exactly the
 * resampling render/canvas.ts's backbuffer exists to prevent.
 *
 * A DOWNED body gets a HATCHED track and no fill at all. That is not decoration:
 * 0/58 drawn as an empty bar is indistinguishable at a glance from a dead
 * monster's, and the whole point of Downed is that it is not death.
 */
function drawHpBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  member: PartyStateMember,
  downed: boolean,
): void {
  if (w <= 0) return;

  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);

  if (downed) {
    ctx.fillStyle = PALETTE.ORANGE;
    for (let i = 0; i < w; i += 4) ctx.fillRect(x + i, y + 1, 2, Math.max(1, h - 2));
    return;
  }

  const fraction = Math.min(1, Math.max(0, member.hp / Math.max(1, member.maxHp)));
  const fill = Math.floor((w - 2) * fraction);
  if (fill <= 0) return;
  ctx.fillStyle = fraction <= HP_LOW ? PALETTE.ORANGE : PALETTE.GOLD;
  ctx.fillRect(x + 1, y + 1, fill, Math.max(1, h - 2));
}

/**
 * The one word for what this member owes the turn, and its colour.
 *
 * Read off `PartyStateMember.state` — the server's own answer, the same value
 * the turn cards are drawn from — and never re-derived from id lists here. It
 * appears only IN COMBAT (see `PartyPaneView.inCombat`), and Downed outranks it,
 * because "excluded from the quorum" and "bleeding out" must not read the same.
 * The vocabulary is the turn strip's, to the letter: two surfaces describing one
 * fact must not describe it with two words.
 */
function stateWord(row: PartyPaneRow): { readonly word: string; readonly ink: string } | null {
  if (row.downed !== null) return null; // the countdown says it better
  switch (row.member.state) {
    case TurnActorState.Waiting:
      return { word: 'WAITING', ink: PALETTE.VIOLET_HI };
    case TurnActorState.Bell:
      return { word: 'BELL', ink: PALETTE.ORANGE };
    case TurnActorState.Acting:
      return { word: 'ACTING', ink: PALETTE.ORANGE };
    case TurnActorState.Committed:
      return { word: 'DONE', ink: PALETTE.GREY_HI };
    case TurnActorState.StandingBy:
      return { word: 'STANDBY', ink: PALETTE.GREY };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STOPWATCH ON A RACE THAT IS NOT RUNNING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DOWN 3/5` is exactly right for a body on YOUR floor. `REVIVE_REACH` is one
 * tile, the clock is five turns, and a party member fighting beside them is
 * already within a step or two — that is the mechanic game-design.md § 9 is
 * describing, and the number is what makes it a decision.
 *
 * ═══ AND IT CANNOT BE WON FROM ANOTHER FLOOR. MEASURED, NOT ASSUMED ═══
 * `handleFollow` crosses instantly and costs no turn, so the whole of the
 * question is the walk from where it drops you — and it drops you at the way
 * out. `DOOR_CLEARANCE` is 8, so no body can be placed nearer than eight tiles
 * to that spot, and one step is exactly one tick of the clock. Driven over a
 * socket in the friendliest delve in the game: the follower closed from seven
 * tiles to three as the clock went 5, 4, 3, 2, 1, 0. Across all seventeen
 * delves the MEDIAN body is 11 to 30 tiles from the door, and **none** of them
 * has a median within the whole five turns. (`tools/rescue-reach.mjs`.)
 *
 * So the number, shown to somebody in another realm, is an instruction to run
 * that always ends three tiles short. It manufactures an urgency the player
 * cannot discharge and then reads as the game having cheated — and § 9 is clear
 * that what is actually at stake is a setback, not a character: *"the floor
 * resets and the party restarts it. No permadeath, no loss."*
 *
 * WHAT IS TRUE STAYS ON THE ROW. They are down, and the name still carries
 * where. What goes is the stopwatch, because the useful move from town is to
 * follow — and that is a control, not a countdown.
 */
export function survivalWord(downed: DownedView, elsewhere: boolean): string {
  if (downed.status === DownedStatus.Erased) return 'ERASED';
  return elsewhere ? 'DOWN' : `DOWN ${String(downed.turnsLeft)}/${String(downed.total)}`;
}

/**
 * ONE FULL ROW.
 *
 * LAYOUT, inside 34 pixels:
 *   x+0             the Downed rail, 3px
 *   x+5  .. x+29    the 24x32 token, with the pennant and the microphone on it
 *   y+2  .. y+13    the name line: '>name (away)', and the state word right
 *   y+18 .. y+25    the hp bar, with the digits or the countdown right-aligned
 * and down the right-hand edge, vertically centred, up to two 24x24 badges.
 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  rect: PanelRect,
  inCombat: boolean,
): void {
  const { member, effects, downed } = row;
  const away = !member.online;
  const { x, y, w } = rect;

  // The self row gets a wash, exactly as the turn cards do, so the two surfaces
  // mark "you" the same way.
  if (member.isSelf) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, w, PARTY_ROW_H - 1);
  }

  // THE RAIL. Three pixels of solid colour down the left of the row: the signal
  // you catch while looking at the map, backed by the word beside it.
  if (downed !== null) {
    ctx.fillStyle = downed.status === DownedStatus.Erased ? PALETTE.GREY : PALETTE.ORANGE;
    ctx.fillRect(x, y, 3, PARTY_ROW_H - 1);
  }

  const token: PanelRect = { x: x + 5, y: y + 1, w: TOKEN_W, h: TOKEN_H };
  drawToken(ctx, sprites, row, token);
  // A body nobody is driving, and a body on the floor, are both HATCHED. The
  // hatch is the shape half of "not with us"; the word half is below.
  if (away || downed !== null || member.away !== null) hatchOver(ctx, token);
  if (member.isLeader) drawLeaderPennant(ctx, token.x, token.y);
  drawVoice(ctx, sprites, row.voice, token.x + TOKEN_W - VOICE_PX, token.y + TOKEN_H - VOICE_PX);

  const right = x + w;
  // --- badges, laid out from the right edge inwards -------------------------
  const shown = Math.min(MAX_BADGES, effects.length);
  const overflow = effects.length - shown;
  let badgeX = right - BADGE_PX;
  for (let i = 0; i < shown; i += 1) {
    const effect = effects[i];
    if (effect === undefined) continue;
    drawBadge(ctx, sprites, effect, badgeX, y + Math.floor((PARTY_ROW_H - BADGE_PX) / 2));
    badgeX -= BADGE_PX + BADGE_GAP;
  }
  if (overflow > 0) {
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.BONE;
    ctx.fillText(`+${overflow}`, badgeX + BADGE_PX, y + PARTY_ROW_H / 2);
    ctx.textAlign = 'left';
    badgeX -= 14;
  }
  const textX = token.x + TOKEN_W + 4;
  const contentRight = Math.max(textX, badgeX + BADGE_PX - BADGE_GAP);

  // --- the name line --------------------------------------------------------
  let nameRight = contentRight;
  /**
   * SOMEWHERE ELSE, WHICH IS NOT THE SAME AS NOBODY DRIVING.
   *
   * `away` above is `!member.online` — a body whose owner has dropped. This is
   * a body in ANOTHER REALM, with somebody at the keyboard, in a fight you are
   * entitled to join. The two look alike on a row and mean opposite things, so
   * this one names the place and offers the way in.
   */
  const elsewhere = member.away;
  const state = inCombat && elsewhere === null ? stateWord(row) : null;
  if (elsewhere !== null) {
    // THE CONTROL SITS IN THE STATE-WORD SLOT, which is free for exactly this
    // row: the state word says what YOUR barrier is doing about somebody, and a
    // member in another realm is counting down under a different Bell.
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = elsewhere.canFollow ? PALETTE.GOLD : PALETTE.GREY;
    const word = elsewhere.canFollow ? 'FOLLOW' : 'AWAY';
    ctx.fillText(word, contentRight, y + 8);
    nameRight -= Math.ceil(ctx.measureText(word).width) + 4;
    ctx.textAlign = 'left';
  } else if (state !== null) {
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = state.ink;
    const word = fitText(ctx, state.word, Math.max(0, contentRight - textX - 24));
    ctx.fillText(word, contentRight, y + 8);
    nameRight -= Math.ceil(ctx.measureText(word).width) + 4;
    ctx.textAlign = 'left';
  } else if (member.isLeader) {
    // No fight on, so the slot the state word would use says who is in charge —
    // which is also the answer to "why can only they kick anybody".
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillText('LEAD', contentRight, y + 8);
    nameRight -= Math.ceil(ctx.measureText('LEAD').width) + 4;
    ctx.textAlign = 'left';
  }

  ctx.font = member.isSelf ? FONT_NAME_SELF : FONT_NAME;
  ctx.fillStyle = member.isSelf
    ? PALETTE.GOLD
    : away || elsewhere !== null
      ? PALETTE.GREY_HI
      : PALETTE.BONE;
  // THE WORD "away", NOT A DIMMER NAME. This is the fact the bug report was
  // about — somebody who is not there must be readable AS not there.
  //
  // AND WHEN THEY ARE SOMEWHERE, IT NAMES THE SOMEWHERE. "Ren (An Index
  // Breach)" is the difference between a party member who is busy and a party
  // member who is gone, which is the whole of the second bug report: the row
  // used to vanish, and a vanished row reads as being thrown out of the party.
  const suffix = elsewhere !== null ? ` (${elsewhere.place})` : away ? ' (away)' : '';
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THEIR LEVEL, WHICH IS WHAT "BRING A PARTY" IS ACTUALLY ASKING ABOUT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The world map grades a room and `partyHint` says *"bring a party"* at the
   * top of that scale; `populateDelve` then builds the floor against the
   * party's MAX level. This row showed everything except the number both of
   * those turn on.
   *
   * BEFORE THE NAME, NOT AFTER IT. `fitText` truncates the label to the width
   * available, so anything appended after a long name is the first thing to be
   * cut — and the level is short, fixed-width and the same shape on every row,
   * which is what makes a column of them readable at a glance. The place suffix
   * stays last precisely because losing it to a truncation is survivable.
   *
   * ABSENT WHEN THE SERVER DID NOT SAY, rather than drawn as `L0`. A wrong
   * number stated confidently is worse than a row that has not learned it yet —
   * the same rule the character sheet's own `Level` row follows.
   */
  const rank = member.level === undefined ? '' : `L${String(member.level)} `;
  const label = `${member.isSelf ? '>' : ''}${rank}${member.name}${suffix}`;
  ctx.fillText(fitText(ctx, label, Math.max(0, nameRight - textX)), textX, y + 8);

  // --- the hp bar, or the countdown ----------------------------------------
  const barY = y + 18;
  ctx.font = FONT_SMALL;

  if (downed !== null) {
    // THE COUNTDOWN REPLACES THE DIGITS. "DOWN 3/5" is the only number that
    // matters about a body on the floor, and printing 0/58 beside it would put
    // the irrelevant one first.
    const erased = downed.status === DownedStatus.Erased;
    const text = survivalWord(downed, member.away !== null);
    ctx.textAlign = 'right';
    ctx.fillStyle = erased ? PALETTE.GREY_HI : PALETTE.ORANGE;
    ctx.fillText(text, contentRight, barY + BAR_H / 2);
    const textW = Math.ceil(ctx.measureText(text).width) + 4;
    ctx.textAlign = 'left';
    drawHpBar(ctx, textX, barY, contentRight - textX - textW, BAR_H, member, true);
    return;
  }

  const digits = `${Math.max(0, Math.ceil(member.hp))}/${member.maxHp}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = member.hp / Math.max(1, member.maxHp) <= HP_LOW ? PALETTE.ORANGE : PALETTE.BONE;
  ctx.fillText(digits, contentRight, barY + BAR_H / 2);
  const digitsW = Math.ceil(ctx.measureText(digits).width) + 4;
  ctx.textAlign = 'left';
  drawHpBar(ctx, textX, barY, contentRight - textX - digitsW, BAR_H, member, false);
}

/**
 * ONE PORTRAIT-ONLY ROW: the token, its rail, and a 3-pixel hp sliver.
 *
 * Every signal that survives is a SHAPE or a POSITION — the pennant, the hatch,
 * the rail, the bar's length — because there is no room for a word. That is the
 * form's whole justification: at this width a name is four characters and an
 * ellipsis, which identifies nobody, while a 24x32 token identifies everybody
 * who has been on screen all session.
 */
function drawCompactRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  rect: PanelRect,
): void {
  const { member, downed } = row;
  const { x, y, w } = rect;

  if (member.isSelf) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, w, PARTY_ROW_COMPACT_H - 2);
  }
  if (downed !== null) {
    ctx.fillStyle = downed.status === DownedStatus.Erased ? PALETTE.GREY : PALETTE.ORANGE;
    ctx.fillRect(x, y, 3, PARTY_ROW_COMPACT_H - 2);
  } else if (member.isSelf) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillRect(x, y, 3, PARTY_ROW_COMPACT_H - 2);
  }

  const token: PanelRect = { x: x + 4, y: y + 1, w: TOKEN_W, h: TOKEN_H };
  drawToken(ctx, sprites, row, token);
  if (!member.online || downed !== null) hatchOver(ctx, token);
  if (member.isLeader) drawLeaderPennant(ctx, token.x, token.y);
  drawVoice(ctx, sprites, row.voice, token.x + TOKEN_W - VOICE_PX, token.y + TOKEN_H - VOICE_PX);
  drawHpBar(ctx, token.x, y + TOKEN_H + 2, TOKEN_W, COMPACT_BAR_H, member, downed !== null);
}

/** A button: a plate, a border and a centred word. Two rects and a string. */
function drawButton(
  ctx: CanvasRenderingContext2D,
  rect: PanelRect,
  label: string,
  ink: string,
): void {
  if (rect.w <= 0) return;
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = ink;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  ctx.fillRect(rect.x, rect.y, 1, rect.h);
  ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
  ctx.save();
  ctx.font = FONT_META;
  ctx.textAlign = 'center';
  ctx.fillStyle = ink;
  ctx.fillText(fitText(ctx, label, rect.w - 6), rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * ONE INVITE. The whole reason invites are not left to the Case Log.
 *
 * A Record line scrolls; twenty lines of a monster sweep put it off the top of
 * the panel inside one turn, and the person who was asked never sees it. Here it
 * is a block with two buttons in the surface they are already reading, and it
 * stays until they answer or it lapses. `size` is printed because "join Ren and
 * 2 others" and "join Ren" are different decisions.
 */
function drawInvite(ctx: CanvasRenderingContext2D, slot: InviteSlot): void {
  const { rect, invite } = slot;
  const others = invite.size - 1;
  const text =
    others > 0 ? `${invite.fromName} +${others} invite you` : `${invite.fromName} invites you`;

  ctx.font = FONT_META;
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(fitText(ctx, text, rect.w), rect.x, rect.y + 7);

  drawButton(ctx, slot.accept, 'ACCEPT', PALETTE.GOLD);
  drawButton(ctx, slot.decline, 'DECLINE', PALETTE.GREY_HI);
}

/**
 * Paint the pane.
 *
 * Wrapped in save/restore because it changes `font`, `textAlign`, `textBaseline`,
 * `lineWidth` and `strokeStyle` — none of which the world painter re-sets before
 * every call, so a leak here would surface three milestones from now as a
 * mysteriously outlined sprite. Clipped to its own rect for the same reason the
 * card strip is: a row must never bleed onto the map.
 */
export function drawPartyPane(options: PartyPaneOptions): void {
  const { ctx, sprites, view, layout } = options;
  const { rect } = layout;
  if (rect.w <= 0 || rect.h <= 0 || view.rows.length === 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  const compact = layout.mode === PartyPaneMode.Portraits;
  if (!compact) {
    const down = view.rows.filter((row) => row.downed !== null).length;
    // The header carries the COUNT, not the word "party" alone: "PARTY · 1" is
    // how somebody playing alone learns the pane is right rather than broken.
    const title = down > 0 ? `PARTY · ${down} DOWN` : `PARTY · ${view.rows.length}`;
    drawHeader(ctx, sprites, title, rect, FONT_META);
  }

  const geometry = paneGeometry(view, layout);
  for (const slot of geometry.invites) drawInvite(ctx, slot);

  if (compact && view.invites.length > 0) {
    // The mark, in place of the buttons there is no room for.
    const mark: PanelRect = {
      x: rect.x + 6,
      y: rect.y + PANEL_PAD + 3,
      w: rect.w - 12,
      h: BUTTON_H,
    };
    drawButton(ctx, mark, '!', PALETTE.GOLD);
  }

  for (const slot of geometry.rows) {
    if (compact) drawCompactRow(ctx, sprites, slot.row, slot.rect);
    else drawRow(ctx, sprites, slot.row, slot.rect, view.inCombat);
  }

  ctx.restore();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO THE POINTER IS OVER, AS A CARD — AND IN PORTRAITS MODE IT IS THE ONLY
 * PLACE THE ANSWER EXISTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, NOT ASSUMED. Painting this pane at five viewports through a context
 * that measures six pixels a character shows it drawing exactly three strings
 * at 640 wide: `["D","S","M"]`. Three initials. No name, no hp numbers, no
 * `WAITING`, no `DOWN 3/5`, no header. Everything else `drawCompactRow` conveys
 * it conveys as a SHADE -- a three-pixel gold stripe for the leader, orange for
 * a body on the floor, grey for one that has been erased, and hatching for
 * offline.
 *
 * That is the exact thing `ui/caselog.ts:467-478` forbids, and this file is not
 * exempt from it: a surface that has stopped showing something says so in
 * words. The trouble is that 44 pixels has no room for a word, and the pane is
 * 44 pixels for a reason `partyPaneLayout` argues well -- at 640 there is not
 * enough map left to justify 208, and burying the playfield to describe the
 * party is not a trade anybody wants.
 *
 * ═══ SO THE WORDS GO WHERE THEY COST NO WIDTH ═══
 * A hover card is the only surface that can hold them without taking a pixel
 * from the map. In Portraits mode it is the whole of the row's content; in Rows
 * mode it is the unabbreviated form of a line that is already there -- `Mo
 * (away)` becomes the realm they are actually in, and `DOWN 3/5` gets the
 * sentence explaining what the number means.
 *
 * ═══ IT REUSES `partyPaneHitAt` ═══
 * The same rule every other tip in this client follows: the card names exactly
 * the row a CLICK would land on. A second walk of the same rects is a second
 * chance to disagree about which row the pointer is in, and this pane's own
 * geometry note (two copies is a row drawn in one place and clicked in another)
 * is about precisely that.
 *
 * INVITES GET NO CARD. `accept` and `decline` are buttons whose words are
 * already on them, and a card over a control the player is reaching for covers
 * the thing they are about to press.
 */
export function partyPaneTipAt(
  view: PartyPaneView,
  layout: PartyPaneLayout,
  px: number,
  py: number,
): HoverCard | null {
  const hit = partyPaneHitAt(view, layout, px, py);
  if (hit === null) return null;
  if (hit.kind !== 'member' && hit.kind !== 'follow') return null;

  const row = view.rows.find((candidate) => candidate.member.id === hit.id);
  if (row === undefined) return null;

  const { member, downed } = row;
  const elsewhere = member.away ?? null;

  /**
   * THE TITLE IS THE NAME AND THE LEVEL, in the row's own order and for the
   * row's own reason: the level is what "bring a party" is actually asking
   * about. `>` marks the viewer, as it does on the row.
   */
  const rank = member.level === undefined ? '' : `L${String(member.level)} `;
  const title = `${member.isSelf ? '>' : ''}${rank}${member.name}`;

  const lines: string[] = [];

  // HP AS NUMBERS. In Portraits mode the bar is all there is, and a bar answers
  // "roughly" when the question is "can they take another hit".
  if (downed === null) {
    lines.push(`Life  ${String(Math.max(0, Math.ceil(member.hp)))}/${String(member.maxHp)}`);
  }

  // WHERE THEY ARE, when it is not here. The row abbreviates this to `(away)`
  // whenever the place would not fit; the card always has room for the place.
  if (elsewhere !== null) {
    lines.push(`In ${elsewhere.place}`);
    if (elsewhere.canFollow) lines.push('Click FOLLOW to cross to them.');
  }

  /**
   * THE DOWNED SENTENCE, WHICH THE ROW CANNOT AFFORD AND THE NUMBER NEEDS.
   *
   * `survivalWord` deliberately drops the stopwatch for a body in another realm
   * -- `tools/rescue-reach.mjs` measured that the walk from the door always ends
   * short, so the countdown there is an urgency the player cannot discharge.
   * The card keeps that distinction and spends its extra room saying what the
   * clock is FOR, which is the one place a beginner is likely to hesitate.
   */
  if (downed !== null) {
    lines.push(survivalWord(downed, elsewhere !== null));
    if (downed.status !== DownedStatus.Erased && elsewhere === null) {
      lines.push('Stand beside them to bring them back up.');
    }
  }

  if (!member.online) lines.push('Disconnected.');
  if (row.voice === VoiceState.Speaking) lines.push('Speaking.');

  /**
   * THE EFFECTS BY NAME AND REMAINING TURNS. The row has room for a count and a
   * badge; neither says which effect, and "2" over a stunned ally is not an
   * answer to what is wrong with them.
   *
   * ═══ AND NOW WHAT EACH ONE DOES, WHICH THE NAME ALONE DOES NOT SAY ═══
   * "Slowed 3t" tells a player something is wrong and not what. The sentence
   * has been authored on every effect in the game since the status system
   * landed and could not reach any screen until `EffectView.desc` existed —
   * *"Dragging. Monsters act less often; detectives lose a point of
   * movement."* is the difference between a badge and an explanation.
   *
   * ON ITS OWN LINE, INDENTED, rather than appended to the name: the card wraps
   * nothing, and a name plus a sentence on one line would ellipsise away the
   * half that is new. Two lines per effect is affordable — a body carries two
   * or three statuses, not ten.
   */
  for (const effect of row.effects) {
    lines.push(`${effect.name}  ${String(effect.turns)}t`);
    if (effect.desc !== undefined) lines.push(`  ${effect.desc}`);
  }

  /**
   * THE STATE WORD IS THE META, and it is the reason the whole barrier is
   * legible: it says what the turn is waiting on. `stateWord` returns null for
   * a downed member because the countdown says it better, and that is honoured
   * here rather than second-guessed.
   */
  const state = stateWord(row);
  const meta =
    state !== null && view.inCombat ? state.word : member.isLeader ? 'party leader' : undefined;

  return { title, meta, lines };
}
