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
 * left disabled — two files drawing one panel is the bug the M5 turn work was
 * opened to fix, and it is not a bug worth having twice. Everything that was
 * right about it is here: the badge column, the Downed rail and countdown, the
 * microphone, and the colour rule below.
 *
 * ===========================================================================
 * AND SINCE 2026-09-18 THIS PANE CARRIES THE TURN. IT IS THE ONLY SURFACE THAT
 * DOES, PER PERSON.
 * ===========================================================================
 * A strip of portrait cards used to sit across the top of the screen answering
 * "who still owes a decision". The author deleted it — *"lets just go no cards
 * at all, no turn order indicator. it will also free up more space. we can use
 * the 'Party' hud UI to indicate that its the players turn, even when doing
 * multiplayer."* — and the 46 logical pixels it spent in every fight went back
 * to the map. `stateWord` below is where that fact now lives; ui/turnbar.ts
 * keeps the one line of prose and the frame, which are about YOU rather than
 * about the party.
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
 *                 inventory doll wears and is deliberately NOT drawn here: cropping a
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
 * than shrinking rows until the text is a smear. There is no honest halfway
 * house between "a row with words on it" and "a face" — a name cut to four
 * characters and an ellipsis identifies nobody. What the narrow form keeps is
 * every signal that is a shape: the pennant, the hatch, the rail, the hp sliver
 * and the turn chip.
 *
 * ===========================================================================
 * THE ROW ORDER IS THE SERVER'S AND IS NEVER RE-SORTED HERE
 * ===========================================================================
 * `PartyStateMsg.members` is join order and stable, and protocol.ts asks for
 * that guarantee to be respected for a concrete reason: KICK IS ON THIS PANE. A
 * row that moves between two frames is a row somebody misclicks, and the click
 * that lands one row off removes the wrong person from the party. You are found
 * by MARKER instead — a wash, a '>' and gold.
 *
 * ═══ AND THE TURN IS NEVER A SORT EITHER, FOR A SECOND REASON ═══
 * The game is phase-locked (DECISIONS.md D1): a player action always costs one
 * full turn of energy, so the WHOLE party decides in the same window and every
 * member reading `waiting` can act RIGHT NOW. Ordering rows by turn state would
 * invent a queue that does not exist and make three people sit waiting for
 * "their go" — the spinner D1 exists to prevent, arrived at through the UI
 * instead of the engine. The rail and the chip move; the rows do not.
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
 *   - YOU are a wash, a '>' prefix and gold — and, while the game is waiting on
 *     you, the words YOUR MOVE and a gold rail down your own row;
 *   - the TURN is a word (WAITING · BELL · DONE · STANDBY), an authored 12x12
 *     chip on the token's top-right corner, and a rail on every row still owed;
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
import {
  BlitAnchor,
  blitReduced,
  drawHeader,
  drawPanel,
  fitText,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
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
import type { PanelSize } from './drag.ts';
import { HP_LOW } from '../../shared/vitals.ts';
import { RESOURCE_H, WIDEST_POOL_LINE_W, drawResource, resourceStripH } from './resource.ts';
import { PURSE_GAP, drawPurse } from './purse.ts';
import { drawXpBar, xpBarGeometry } from './xpbar.ts';
import { drawAirBar } from './air.ts';
import type { AirView, ProgressMsg, ResourceView } from '../../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Geometry. See the layout note in the header before changing any of it.
// ---------------------------------------------------------------------------

/**
 * The inset every row is laid out inside — `paneGeometry`'s `x`, and the same
 * number `partyPaneHeight` reserves top and bottom.
 *
 * NAMED BECAUSE THE PANE'S WIDTH IS NOW DERIVED FROM IT. It was written out as
 * `PANEL_PAD + 3` in the two functions below; a width computed from one copy
 * while the rows were laid out against another is the shape this file's own
 * header warns about.
 */
const PANE_INSET = PANEL_PAD + 3;

/**
 * How far into the row the portrait — and therefore the pool strip under it —
 * starts. `drawRow`'s `token.x`.
 */
const ROW_TOKEN_DX = 5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FULL PANE, AND THE WIDTH IS DERIVED FROM WHAT A POOL ACTUALLY PRINTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported as *"the Party UI needs to be slightly widened as it can cut
 * resourcces off. example: the redactor character has its Ink initially cut off
 * on the party display until you manually drag to widenen it a bit to
 * accomodate."*
 *
 * ═══ IT WAS 208, A NUMBER, AND THREE CLASSES OF FOUR WERE CUT ═══
 * MEASURED against the row this pane actually draws — `drawResource` at
 * `stacked`, starting at `token.x` with `x + w - token.x` to run in, which is
 * 187 pixels at 208:
 *
 *   Resolve   10 pips, `Resolve 100/100`   wants 234   CUT by 47
 *   Focus     10 pips, `Focus 100/100`     wants 222   CUT by 35
 *   Ink       10 pips, `Ink 100/100`       wants 210   CUT by 23
 *   Reagents   8 pips, `Reagents`          wants 164   fits
 *
 * The Redactor is the one that got reported; the Watchman — the class most
 * people start on — was losing more of its line than the Redactor was. The pane
 * CLIPS to its rect (`drawPartyPane`), so the overflow is not drawn over the
 * map where somebody would see it and call it a bug: it is silently cut at the
 * frame, which is why three classes shipped this way.
 *
 * ═══ THE DEFAULT WAS WRONG, NOT THE MAXIMUM ═══
 * The grip could always reach a width that fits — the player in the report got
 * there by dragging. What no player should have to do is discover that their
 * own resource is being hidden by a number that was chosen before the pool
 * strip moved into this pane at all.
 *
 * ═══ DERIVED, AND THE DERIVATION IS THE DEFINITION ═══
 * `WIDEST_POOL_LINE_W` walks `ResourceKind` and measures the line `poolText`
 * prints, in the glyph advance the row draws with. Added to the two insets and
 * the portrait offset, that IS the pane width — so a fifth resource, a longer
 * label or a wider figure moves this constant by itself instead of quietly
 * losing the end of somebody's line again.
 *
 * ═══ SIX PIXELS WIDER THAN THE WIDEST REAL LINE, AND THAT IS THE BOUND ═══
 * `WIDEST_POOL_LINE_W` is 240 and the widest line any class actually draws is
 * the Watchman's 234, because the bound measures EVERY kind at the continuous
 * shape and `Reagents` is both the longest label and the one kind that is
 * discrete. Deriving the exact 234 instead would need each pool's authored
 * maximum, which lives on the server (`RESOURCE_RULES`) and must not be copied
 * into this client — `ResourceView.discrete`'s own note says why. So the client
 * sizes from a bound it can state, and `partypanel.test.ts` walks the real
 * class table to prove the bound holds. Six pixels is the price of not keeping
 * a second copy of authored data in the renderer.
 *
 * ═══ MEASURED CONSEQUENCES, SINCE THIS IS A LAYOUT CONSTANT ═══
 * 208 -> 261. At the 640-wide floor the pane leaves 373 clear pixels against
 * `MAP_MIN_CLEAR_PX` 320, so the clear-map heuristic still picks Rows exactly
 * where it did. And `mode` is `paneW >= PARTY_PANE_W`, so a pane DRAGGED
 * narrower than 261 now takes the Portraits form where it used to take Rows —
 * which is the honest reading of that test rather than a side effect: Rows is
 * the form that shows the pools, and it now means "wide enough to show them".
 */
export const PARTY_PANE_W = PANE_INSET * 2 + ROW_TOKEN_DX + WIDEST_POOL_LINE_W;

/**
 * How wide one ROW is inside a pane this wide — `paneGeometry`'s `w`.
 *
 * EXPORTED, AND THE REASON IS THE CONSTANT ABOVE. `PARTY_PANE_W` is defined as
 * "the width at which the widest pool line fits", and a test can only check
 * that claim by asking the same two questions the painter asks. Two copies of
 * the row inset — one in the width, one in the layout — is how a pane ends up
 * six pixels short of what it promised.
 */
export function paneRowW(paneW: number): number {
  return Math.max(0, paneW - PANE_INSET * 2);
}

/**
 * How much room the self row's pool strip gets inside a row this wide — what
 * `drawRow` hands `drawResource` as its `width`.
 *
 * The strip starts at the PORTRAIT rather than at the text, so the pips have
 * the whole row to run in; see the call in `drawRow`.
 */
export function poolStripW(rowW: number): number {
  return Math.max(0, rowW - ROW_TOKEN_DX);
}
/**
 * Rail, gutter and one face. Everything else is dropped.
 *
 * Was 44, sized around a 24-wide token. The face box is `FACE_PX` square, so
 * the eight extra pixels are the difference between a cropped token and a
 * whole one -- the compact form is the one place a body is ALL the row has.
 */
export const PARTY_PANE_COMPACT_W = 52;
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

/**
 * THE FACE BOX. A square, because everything that goes in it halves into one.
 *
 * `FACE_PX` is 32: exactly half of a 64x64 `icon_character_the_*`, and a
 * 48x64 `chr_player_*` token halves to 24x32 inside the same square. Both
 * land through `blitReduced` at d = 2, which is an exact divisor and so stays
 * sharp with smoothing off.
 *
 * This was a 24x32 TOKEN box, blitted 1:1 and cropped from the top when the
 * sprite was taller. That is what cut the character off.
 */
const FACE_PX = 32;
/**
 * The badge box. Production badges are authored at 24x24; the commission
 * masters under `ui/icons/status/commission/` are 64x64, and `drawBadge`
 * reduces those to fit rather than assuming the art's size.
 */
const BADGE_PX = 24;
/** 64 / 4 = 16, the largest exact reduction of a 64x64 master that fits. */
const BADGE_MAX_REDUCTION = 4;
/**
 * THE TURN CHIP, HALF ITS AUTHORED SIZE. Every `ui_icon_turn_*` is 24x24 and
 * this is 12, which is the exact half `blitReduced` will take with smoothing
 * off. 24 would reach from the top of the token to below the hp bar; 12 sits
 * inside the token's top-right quarter and leaves the face readable, which is
 * the other thing a party row is for.
 */
const TURN_CHIP_PX = 12;
/**
 * THE RAIL, three pixels down the left edge: the signal you catch while looking
 * at the map. `downed` owns it when there is one, because a body on the floor
 * outranks a decision nobody has made yet, and the two cannot collide — a Downed
 * detective is `standing_by` and so is never one of the rows still owed.
 */
const ROW_RAIL_W = 3;
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
/**
 * THE SHORTEST THE PANE MAY BE — a header and one row.
 *
 * EXPORTED because it is the pane's resize FLOOR as well as its layout gate,
 * and `main.ts` needs the same number the layout uses. Two copies of "how short
 * is too short" would let the grip drag the box below what the layout will
 * draw, which is a pane the player cannot get back.
 */
export const PARTY_PANE_MIN_H = HEADER_H + PARTY_ROW_H;
const PANE_MIN_H = PARTY_PANE_MIN_H;

/**
 * How tall ONE row is, and it is not a constant any more.
 *
 * The self row carries the viewer's pools under the name, so it is taller than
 * everybody else's by exactly the strip that draws them. THREE callers need this
 * number -- `partyPaneHeight` to ask for the space, `paneGeometry` to place the
 * rows, and `partyPaneHitAt` through that same geometry -- and the header of
 * `partyPaneLayout` already says what two copies of this arithmetic cost: a
 * click that lands on the map through a panel, on somebody else's window size.
 * So there is one function and the other two call it.
 *
 * NOT IN THE COMPACT FORM. `PartyPaneMode.Portraits` is a 52-pixel strip of
 * faces with no room for a word, let alone twelve pips -- the same reason its
 * invites carry a mark rather than two buttons.
 *
 * THIS USED TO ADD "on that form the bottom strip remains the only copy". There
 * is no bottom strip any more, so on a window narrow enough to force Portraits
 * the pools, the level, the xp and the purse are on NO permanent surface at
 * all. Stated rather than left implied: it is the narrow-window half of the
 * trade recorded at the resource band below.
 */
function rowHeightFor(row: PartyPaneRow, view: PartyPaneView, compact: boolean): number {
  if (compact) return PARTY_ROW_COMPACT_H;
  if (!row.member.isSelf) return PARTY_ROW_H;
  /**
   * TWO INDEPENDENT BANDS, EACH PAID FOR ONLY WHEN ITS FRAME HAS LANDED.
   *
   * Summed rather than branched, because the two arrive from different frames
   * and either can be the one that is missing: a `resource` frame lands with the
   * class and a `progress` frame with the first xp. A single "self is taller"
   * constant would reserve space for a band that is not being drawn, which the
   * pane cannot afford on a short window -- `partyPaneHeight` is what clamps it
   * into the band, and every reserved pixel is a row somebody else loses.
   */
  // `?? null` FOR THE REASON drawRow GIVES: a fixture-built view can be missing
  // these fields entirely, and reserving on `undefined !== null` would make
  // every self row taller than what is drawn into it.
  const pools = (view.resource ?? null) !== null ? RESOURCE_STRIP_H : 0;
  const carriesProgress = (view.progress ?? null) !== null || (view.money ?? null) !== null;
  const progress = carriesProgress ? PROGRESS_STRIP_H : 0;
  return PARTY_ROW_H + pools + progress;
}

/**
 * The band under the self row's name that holds the pools.
 *
 * `resourceStripH` is `ui/resource.ts`'s own answer, so this grows if the pips
 * ever do rather than being a number remembered in two files. TRUE is passed
 * because the pane draws the STACKED shape: the row was written for the
 * full-width strip along the bottom, so on one line everything past the AP
 * blocks ran off the end -- reported as "it looks like the MP is cut off in the
 * player hud". The pane was 208 wide when that was written and the width is
 * derived now (`PARTY_PANE_W`), which answers the POOL line; this answers the
 * BUDGET line, and the two are separate faults with separate fixes.
 */
const RESOURCE_STRIP_H = resourceStripH(true);

/**
 * The band under the pools that holds the level, the xp track and the purse.
 *
 * `RESOURCE_H` RATHER THAN A LITERAL, and it is the same eighteen pixels the
 * deleted bottom strip gave these three widgets — the row they shared was
 * exactly `RESOURCE_H` tall and their internal offsets were written against it.
 * Reusing the constant is what makes this a MOVE rather than a re-tuning: the
 * widgets are handed a box the shape of the one they were designed in.
 */
const PROGRESS_STRIP_H = RESOURCE_H;

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
  /**
   * IS IT THIS MEMBER'S TURN — `TurnMsg.current` — or undefined when no `turn`
   * frame has said. In a party's fight the turns go one at a time, so a member
   * can owe a decision without it being their turn yet: that is the difference
   * between "YOUR TURN" and "IN LINE" on the self row.
   */
  readonly current?: boolean;
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
   * while they walk around freely. It is the same reason the deleted card strip
   * drew nothing at all out of combat.
   */
  readonly inCombat: boolean;
  /**
   * THE VIEWER'S OWN POOLS, OR NULL BEFORE THE FIRST `resource` FRAME.
   *
   * Reported: *"the resources, AP, MP, reagents is easy to miss at the bottom
   * left hand of the screen. we need to include all of that info in the hp hud/
   * 'party' at the top left."*
   *
   * ONE FIELD ON THE VIEW AND NOT ONE PER ROW, because there is only ever one
   * of these to draw. `ResourceView` is VIEWER-PRIVATE by protocol
   * (protocol.ts:1311, *"Another detective's AP is not yours to see, and the
   * party pane has never claimed otherwise"*) and the wire carries no teammate's
   * pool at all, so a per-row field would be six nulls and an invitation to fill
   * them from somewhere they cannot honestly come from.
   *
   * It is drawn on the SELF row, which is the row it is about.
   */
  readonly resource: ResourceView | null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE VIEWER'S OWN LEVEL AND XP, OR NULL BEFORE THE FIRST `progress` FRAME.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `resource`'s twin, one field for the same reason: there is one of these and
   * it belongs to the body under this socket.
   *
   * IT USED TO LIVE ON A STRIP ALONG THE BOTTOM OF THE SCREEN, right-aligned
   * beside the pools and the purse. That row was deleted to give the Case Log
   * the bottom-left corner it has upstream, and this is where it went — the
   * rule the strip's replacement follows being that a fact about the VIEWER
   * belongs on the viewer's own row.
   *
   * NULL IS DRAWN AS NOTHING, never as zero. `ui/xpbar.ts` refuses a null
   * outright, and `ui/charsheet.ts:344-347` carries the argument: a row reading
   * `Level: 0` in the window between a welcome and the first frame is a wrong
   * number stated confidently on the screen the player is staring at.
   */
  readonly progress: ProgressMsg | null;
  /**
   * THE VIEWER'S PURSE, OR NULL BEFORE THE FIRST `inventory` FRAME.
   *
   * NULL AND NOT ZERO, and this is the field where that distinction has already
   * cost something: `0 GOLD` drawn on permanent furniture for the whole window
   * before the first frame is the same wrong-number-stated-confidently failure
   * as `Level: 0`. The bag's own title bar may use zero because a closed bag has
   * no rows to afford; this surface may not.
   */
  readonly money: number | null;
  /**
   * THE VIEWER'S OWN AIR, OR NULL WHILE THEY BREATHE FREELY. `ResourceMsg.air`,
   * straight through. OPTIONAL, so every view a fixture built before it reads as
   * a body with full lungs — which is what absent means on the wire too.
   */
  readonly air?: AirView | null;
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
  /** The viewer's own pools. Straight through; see `PartyPaneView.resource`. */
  readonly resource: ResourceView | null;
  /** The viewer's own level and xp. Straight through; see `PartyPaneView.progress`. */
  readonly progress: ProgressMsg | null;
  /** The viewer's purse. NULL, never zero — see `PartyPaneView.money`. */
  readonly money: number | null;
  /** The viewer's air, null when full. See `PartyPaneView.air`. */
  readonly air?: AirView | null;
  /** Whose turn it is, off the last `turn` frame. See `PartyPaneRow.current`. */
  readonly current?: string | null;
}): PartyPaneView {
  const roster = new Map(options.roster.map((member) => [member.id, member]));

  return {
    rows: options.state.members.map((member) => {
      const level = roster.get(member.id);
      return {
        member,
        ...(options.current === undefined ? {} : { current: member.id === options.current }),
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
    resource: options.resource,
    progress: options.progress,
    money: options.money,
    air: options.air ?? null,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** How tall the pane wants to be, before the viewport has its say. */
export function partyPaneHeight(view: PartyPaneView, mode: PartyPaneMode): number {
  const inset = PANE_INSET;
  if (mode === PartyPaneMode.Portraits) {
    const flag = view.invites.length > 0 ? BUTTON_H : 0;
    return inset * 2 + flag + view.rows.length * PARTY_ROW_COMPACT_H;
  }
  const rows = view.rows.reduce((total, row) => total + rowHeightFor(row, view, false), 0);
  return HEADER_H + inset * 2 + view.invites.length * INVITE_H + rows;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE PLAYER DRAGGED THE PANE TO, or null for "never touched".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for as *"we want to make the party panel resizable as well, same way
   * the log panel is. the party panel should reformat and accomodate the
   * resizing to 'fit better'."*
   *
   * NULL KEEPS EVERY EXISTING ANSWER EXACTLY. The clear-map heuristic below is
   * untouched on that path, so a player who never grabs the grip sees the pane
   * this function has always produced — which is also what keeps every existing
   * test in partypanel.test.ts true without an argument.
   */
  readonly size?: PanelSize | null;
}): PartyPaneLayout | null {
  const { view, width, top, bottom, rightReserved } = options;
  const chosen = options.size ?? null;
  // NEVER AN EMPTY BOX. No rows means no `party_state` yet — say nothing rather
  // than drawing a header over a void, and never invent a party of one before
  // the server has described it.
  if (view.rows.length === 0) return null;

  const available = bottom - top;
  if (available < PANE_MIN_H) return null;

  const clearWith = (paneW: number): number =>
    width - rightReserved - paneW - PARTY_PANE_MARGIN * 2;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE WIDTH DECIDES THE FORM, AND THAT IS WHAT "REFORMAT TO FIT" MEANS HERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The pane already has two forms and already picks between them by width —
   * `Rows` at 208 with names, bars and badges, `Portraits` at 52 with faces
   * alone. All that changes is WHO chooses: the clear-map heuristic when nobody
   * has dragged it, the player's own width when somebody has.
   *
   * So a drag past the threshold does not clip or squash anything; it changes
   * the pane into its other form, which is the reflow the request asks for and
   * the one this file was already built to do.
   */
  const heuristic =
    clearWith(PARTY_PANE_W) >= MAP_MIN_CLEAR_PX ? PartyPaneMode.Rows : PartyPaneMode.Portraits;
  const paneW =
    chosen === null
      ? heuristic === PartyPaneMode.Rows
        ? PARTY_PANE_W
        : PARTY_PANE_COMPACT_W
      : /**
         * CLAMPED, NEVER NULLED. A player who drags the pane narrow must not be
         * able to drag it out of existence — the map's hard floor still holds,
         * but it holds by refusing to give up more width rather than by making
         * the pane disappear mid-gesture.
         */
        Math.max(
          PARTY_PANE_COMPACT_W,
          Math.min(chosen.w, width - rightReserved - MAP_MIN_CLEAR_HARD_PX - PARTY_PANE_MARGIN * 2),
        );
  const mode = paneW >= PARTY_PANE_W ? PartyPaneMode.Rows : PartyPaneMode.Portraits;
  if (chosen === null && clearWith(paneW) < MAP_MIN_CLEAR_HARD_PX) return null;

  return {
    rect: {
      x: PARTY_PANE_MARGIN,
      y: top,
      // THE CONTENT'S HEIGHT IS STILL THE CEILING. A pane taller than its rows
      // would be a header over a void, which this file refuses one screen up.
      h: Math.min(
        chosen === null ? partyPaneHeight(view, mode) : Math.max(PANE_MIN_H, chosen.h),
        available,
        partyPaneHeight(view, mode),
      ),
      w: paneW,
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
  const inset = PANE_INSET;
  const compact = layout.mode === PartyPaneMode.Portraits;
  const { rect } = layout;

  const x = rect.x + inset;
  // THROUGH `paneRowW`, which is the same function `PARTY_PANE_W` is defined
  // against. A second expression here is how the pane comes to be narrower
  // than the width that was derived to hold the content.
  const w = paneRowW(rect.w);
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

  const rows: { row: PartyPaneRow; rect: PanelRect; follow: PanelRect | null }[] = [];
  for (const row of view.rows) {
    const rowH = rowHeightFor(row, view, compact);
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
 * and it is the same "this one is out" grammar `ui_hotbar_slot_disabled`
 * already carries. Clipped to the box so the strokes cannot run over the text
 * beside it.
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
 * ════════════════════════════════════════════════════════════════════════════
 * THE FACE. The class portrait first, the map token second, initials last.
 * ════════════════════════════════════════════════════════════════════════════
 * THIS DREW THE MAP TOKEN 1:1 AND CROPPED IT, and the crop is what cut the
 * character off: `sy = sprite.h - sh` kept the bottom of a 32-tall box, so a
 * taller sprite lost its head. It was reported that way, and the fix is to
 * show the same face the inventory's paper doll shows.
 *
 * THE OLD RULE WAS *"NEVER SCALED, and never the 64x64 class portrait"*, and
 * half of it still stands. Cropping a 64px face into a 24px box IS a nose —
 * which is exactly why nothing here crops any more. What was wrong was the
 * scaling half: an EXACT halving with smoothing off is not the resampling the
 * backbuffer exists to prevent, and `blitReduced` refuses anything that is not
 * a whole divisor.
 *
 * ═══ WHAT INITIALS NOW MEAN, WHICH IS THE REVERSE OF WHAT THEY MEANT ═══
 * They used to mean "this body is out of your FOV", because `sprite` is null
 * then. `portrait` is populated for away members too — which is precisely who
 * a party pane is for — so initials now mean NO ART RESOLVED AT ALL: a bare
 * clone, or a server too old to send the field.
 */
function drawFace(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  box: PanelRect,
): void {
  if (box.w <= 0 || box.h <= 0) return;

  const portrait = row.member.portrait ?? null;
  if (portrait !== null && blitReduced(ctx, sprites, portrait, box, BlitAnchor.Centre)) return;
  // THE TOKEN IS THE FALLBACK NOW, bottom-anchored because a silhouette is
  // read from its feet up — the one part of the deleted crop that was right.
  if (row.sprite !== null && blitReduced(ctx, sprites, row.sprite, box, BlitAnchor.Bottom)) {
    return;
  }

  ctx.save();
  ctx.font = FONT_INITIALS;
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(initialsOf(row.member.name), box.x + box.w / 2, box.y + box.h / 2);
  ctx.restore();
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
  /**
   * INSIDE THE BOX, BY AN EXACT DIVISOR — `blitReduced`, as the faces are.
   * A badge drawn at the image's own size assumed every badge was authored at
   * 24x24, and Burning was the first wired to a 64x64 commission master: it
   * hung 35px into the next member's row. A 24x24 badge still draws 1:1; a 64
   * lands at 16, centred and sharp; anything no divisor fits takes the glyph.
   */
  const drawn = blitReduced(
    ctx,
    sprites,
    effect.icon,
    { x, y, w: BADGE_PX, h: BADGE_PX },
    BlitAnchor.Centre,
    BADGE_MAX_REDUCTION,
  );
  if (!drawn) {
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
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MEMBER OWES THE TURN — AND THIS PANE IS NOW THE ONLY SURFACE THAT
 * ANSWERS IT PER PERSON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There was a strip of portrait cards across the top of the screen carrying
 * this. It is deleted (ui/turnbar.ts records both deletions and why), on the
 * author's ruling of 2026-09-18: *"lets just go no cards at all, no turn order
 * indicator. it will also free up more space. we can use the 'Party' hud UI to
 * indicate that its the players turn, even when doing multiplayer."* So what
 * used to be a supporting word beside a card is the whole telling.
 *
 * ═══ `PartyStateMember.state` AND NOTHING ELSE ═══
 * The server's own answer, decided in src/server/engine/barrier.ts, never
 * re-derived from id lists here. The strip's predecessor had a `chipFor` that
 * did exactly that — Standing By outranks a commit, a commit outranks the Bell,
 * worked out in the browser from three arrays — and it could not express a
 * Downed detective, who is in NEITHER `whoseTurn` nor `standingBy`: it fell
 * through to "committed" and told the party that the person bleeding out on the
 * floor had taken their turn. `turnChipIdFor` below is a state-to-asset lookup
 * and is not that function returning; it decides nothing.
 *
 * ═══ THREE CHANNELS, AND ONLY ONE OF THEM IS COLOUR ═══
 * Roughly one man in twelve cannot separate red from green, the Discord overlay
 * is not colour-managed, and this is read in third-of-a-second glances. So every
 * state is said as a WORD (a shape, and the copy the hover card repeats), as an
 * authored CHIP on the token's top-right corner (`ui_icon_turn_*` — four
 * distinct silhouettes), and as the RAIL down the left edge of the rows still
 * being waited on. Take the colour away and the checklist still reads.
 *
 * ═══ THE SELF ROW SAYS "YOUR TURN", NOT "WAITING" ═══
 * The single most important fact on this screen is that the game is waiting on
 * the person reading it, and "WAITING" beside your own name is the passive voice
 * for it — it reads as *you are waiting*, which is the opposite. The word, the
 * gold rail, the gold ink and the `>` on the name are four marks on one row.
 *
 * DOWNED OUTRANKS ALL OF IT and returns null so the countdown speaks instead:
 * "excluded from the quorum" and "bleeding out" must never read the same.
 */
type TurnMark = {
  readonly word: string;
  readonly ink: string;
  /** The authored chip for the state, or null where there is no art for it. */
  readonly chip: string | null;
  /** Is the barrier still waiting on this row? Drives the rail, nothing else. */
  readonly owed: boolean;
};

/**
 * The authored chip for a state. A LOOKUP, not a derivation — it is handed the
 * state the server decided and returns an asset key, which is what
 * protocol.ts's `TurnActorState` note promises when it says the values ARE the
 * art suffixes.
 *
 * `acting` has no chip because it has no PNG: it is the monsters' state and
 * protocol.ts is explicit that it never appears on a party row. Reusing another
 * state's icon for it would draw a lie rather than a gap.
 */
function turnChipIdFor(state: TurnActorState): string | null {
  switch (state) {
    case TurnActorState.Waiting:
      return 'ui_icon_turn_waiting';
    case TurnActorState.Committed:
      return 'ui_icon_turn_committed';
    case TurnActorState.Bell:
      return 'ui_icon_turn_bell';
    case TurnActorState.StandingBy:
      return 'ui_icon_turn_standing_by';
    case TurnActorState.Acting:
      return null;
  }
}

function stateWord(row: PartyPaneRow): TurnMark | null {
  if (row.downed !== null) return null; // the countdown says it better
  const self = row.member.isSelf;
  const chip = turnChipIdFor(row.member.state);
  switch (row.member.state) {
    case TurnActorState.Waiting:
      // IN LINE: you owe a decision and somebody before you is taking theirs.
      // Only a `turn` frame that named somebody else says so; alone, and
      // before any frame, a waiting self row is your turn.
      if (self && row.current === false) {
        return { word: 'IN LINE', ink: PALETTE.VIOLET_HI, chip, owed: true };
      }
      return {
        word: self ? 'YOUR TURN' : 'WAITING',
        ink: self ? PALETTE.GOLD : PALETTE.VIOLET_HI,
        chip,
        owed: true,
      };
    case TurnActorState.Bell:
      // THE BELL IS STILL A ROW THAT OWES, so it keeps the rail. `BELL` alone on
      // your own row says a clock is running and not that it is running on YOU,
      // which is the whole of what a straggler needs to read.
      return { word: self ? 'BELL — MOVE' : 'BELL', ink: PALETTE.ORANGE, chip, owed: true };
    case TurnActorState.Acting:
      return { word: 'ACTING', ink: PALETTE.ORANGE, chip, owed: false };
    case TurnActorState.Committed:
      return { word: 'DONE', ink: PALETTE.GREY_HI, chip, owed: false };
    case TurnActorState.StandingBy:
      return { word: 'STANDBY', ink: PALETTE.GREY, chip, owed: false };
  }
}

/**
 * The chip, top-right of the token, in BOTH forms of the pane.
 *
 * ONE FIXED PLACE, which is the rule the deleted card strip stated and the one
 * thing worth keeping from it: the pane changes form when the window is resized
 * or the grip is dragged, and a state icon that migrates with the layout is a
 * state icon that has to be found again. Top-right is the one corner of a token
 * nothing else claims — the leader's pennant is top-left and the microphone is
 * bottom-right.
 *
 * `blitReduced` halves the authored 24x24 exactly and REFUSES rather than
 * smudging, so a clone with no art draws no chip and the word still carries the
 * state. Nothing here is the only telling of anything.
 */
function drawTurnChip(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  chip: string | null,
  token: PanelRect,
): void {
  if (chip === null) return;
  blitReduced(ctx, sprites, chip, {
    x: token.x + token.w - TURN_CHIP_PX,
    y: token.y,
    w: TURN_CHIP_PX,
    h: TURN_CHIP_PX,
  });
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
/**
 * The three viewer-private things the self row carries. See `PartyPaneView`'s
 * own fields for why each is nullable and why null is never drawn as zero.
 */
type SelfExtras = {
  readonly resource: ResourceView | null;
  readonly progress: ProgressMsg | null;
  readonly money: number | null;
  readonly air?: AirView | null;
};

function drawRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  rect: PanelRect,
  inCombat: boolean,
  /**
   * EVERYTHING THE VIEWER'S OWN ROW DRAWS AND NOBODY ELSE'S, in one object.
   *
   * A SINGLE PARAMETER RATHER THAN THREE. `resource` arrived here as a sixth
   * positional and the level, the xp track and the purse would have made it
   * eight — at which point a call site passing them in the wrong order is a
   * silent bug that typechecks, because two of the three are `number | null`.
   */
  self: SelfExtras,
): void {
  const { member, effects, downed } = row;
  const away = !member.online;
  const { x, y, w } = rect;

  /**
   * WHAT THE BARRIER IS DOING ABOUT THIS ROW, worked out ONCE at the top because
   * four marks are made from it — the rail here, the chip on the token, the word
   * in the name line, and the ink that word is drawn in. It used to be computed
   * halfway down beside the word, which was fine while the word was the only
   * thing it fed.
   *
   * ═══ A MEMBER IN ANOTHER REALM HAS NO TURN ON THIS SCREEN ═══
   * `away` (the place, not the disconnection) means they are counting down under
   * a different Bell, so the state-word slot carries FOLLOW instead and none of
   * the four marks are made. And out of combat nobody blocks: the projector
   * marks every member `committed`, so printing DONE beside four names would
   * tell four people they are waiting on each other while they walk around
   * freely.
   */
  const elsewhere = member.away;
  const mark = inCombat && elsewhere === null ? stateWord(row) : null;

  // The self row gets a wash so the pane marks "you" the same way everywhere.
  // THE WASH COVERS THE WHOLE ROW, POOLS INCLUDED -- `rect.h` and not
  // `PARTY_ROW_H`, or the strip sits outside the block that marks it as yours
  // and reads as a detached row belonging to whoever is listed next.
  if (member.isSelf) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, w, rect.h - 1);
  }

  // THE RAIL. Three pixels of solid colour down the left of the row: the signal
  // you catch while looking at the map, backed by the word beside it.
  //
  // ═══ AND IN COMBAT IT IS THE CHECKLIST ═══
  // Downed first, because a body on the floor outranks a decision nobody has
  // made; otherwise a rail on every row the barrier is still waiting on, gold on
  // your own. Six rails down the left edge answer "who are we waiting on" in one
  // glance without reading a word — which is exactly the read the deleted card
  // strip existed for, and the reason it is NOT a sort: every one of these
  // people can act right now (DECISIONS.md D1), so the rows stay in join order
  // and the rail moves instead.
  if (downed !== null) {
    ctx.fillStyle = downed.status === DownedStatus.Erased ? PALETTE.GREY : PALETTE.ORANGE;
    ctx.fillRect(x, y, ROW_RAIL_W, rect.h - 1);
  } else if (mark !== null && mark.owed) {
    ctx.fillStyle = member.isSelf ? PALETTE.GOLD : PALETTE.VIOLET_HI;
    ctx.fillRect(x, y, ROW_RAIL_W, rect.h - 1);
  }

  // `ROW_TOKEN_DX`, NOT A 5. `PARTY_PANE_W` is derived from this offset — the
  // pool strip starts here — so the two must be the same number by
  // construction rather than by coincidence.
  const token: PanelRect = { x: x + ROW_TOKEN_DX, y: y + 1, w: FACE_PX, h: FACE_PX };
  drawFace(ctx, sprites, row, token);
  // A body nobody is driving, and a body on the floor, are both HATCHED. The
  // hatch is the shape half of "not with us"; the word half is below.
  if (away || downed !== null || member.away !== null) hatchOver(ctx, token);
  if (member.isLeader) drawLeaderPennant(ctx, token.x, token.y);
  drawVoice(ctx, sprites, row.voice, token.x + FACE_PX - VOICE_PX, token.y + FACE_PX - VOICE_PX);
  // AFTER the hatch, so a body nobody is driving still says what the barrier is
  // doing about it. A null chip, or a clone with no art, simply draws nothing.
  drawTurnChip(ctx, sprites, mark?.chip ?? null, token);

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
  /**
   * ════════════════════════════════════════════════════════════════════════════
   * YOUR POOLS, UNDER YOUR NAME — Minimalist.lua:376-377.
   * ════════════════════════════════════════════════════════════════════════════
   * Reported: *"the resources, AP, MP, reagents is easy to miss at the bottom
   * left hand of the screen. we need to include all of that info in the hp hud/
   * 'party' at the top left."*
   *
   * Upstream agrees and says so in one table: `self.places` puts `player` at
   * `{x=0, y=0}` (:376) and `resources` at `{x=0, y=111}` (:377) — the SAME
   * left column, the pools directly under the portrait. Ours had them in
   * opposite corners of the screen.
   *
   * ═══ THE SELF ROW ONLY, AND THAT IS THE PROTOCOL'S RULE RATHER THAN A CHOICE ═══
   * `ResourceView` is viewer-private (protocol.ts:1311) and the wire carries no
   * teammate's pool, so there is nothing to draw on anybody else's row and
   * nowhere honest to get it. `view.resource` is one field for that reason.
   *
   * ═══ THE BOTTOM STRIP IS GONE, AND THIS PARAGRAPH USED TO SAY IT STAYS ═══
   * It read: *"removing the strip would reopen the exact gap `ui/life.ts` was
   * written to close"* — that file argues vitals must sit on furniture which
   * cannot be dismissed, and names this pane's own two failure modes as the
   * reason: it is toggled off with `p`, and it degrades to faces on a narrow
   * window.
   *
   * BOTH ARE STILL TRUE. The strip was deleted anyway, on the ruling that every
   * number on it was already here and that it was standing in the corner the
   * Case Log occupies upstream. So this IS the only always-on copy now, and the
   * two gaps are real rather than covered. That is a trade, recorded as one —
   * see `the player can always see their own health` in hudwiring.test.ts,
   * which is where the exposure is written down instead of being rediscovered.
   */
  if (member.isSelf && self.resource !== null) {
    drawResource({
      ctx,
      sprites,
      resource: self.resource,
      stacked: true,
      x: token.x,
      y: y + PARTY_ROW_H - 1,
      // FROM THE TOKEN TO THE ROW'S EDGE. It starts under the portrait rather
      // than under the name so the pips have the full width of the row to run
      // in -- twelve reagents plus a budget does not fit beside a 32px face.
      //
      // ═══ AND THE PANE IS NOW SIZED SO THIS IS ENOUGH ═══
      // This said *"187 pixels against the 256 the flat row wants, which is why
      // `stacked` is set rather than the pane being widened: `MAX_PIPS` is 16,
      // so a discrete pool alone can want 224 and NO pane width is safe."* Both
      // halves were true and the conclusion did not follow. `stacked` answers
      // the BUDGET row, which is the 256; it does nothing for the POOL line,
      // which is pips plus the figure and stayed on line one — and three of the
      // four classes had that line cut at the frame. `PARTY_PANE_W` is derived
      // from `WIDEST_POOL_LINE_W` now, so this is 240 against the 234 the
      // widest authored pool wants. The 16-pip pool nobody has authored is
      // still out of reach, and `partypanel.test.ts` walks the real classes.
      //
      // `poolStripW(w)` AND NOT `x + w - token.x`: they are the same number,
      // and only one of them is the number `PARTY_PANE_W` was derived from.
      width: poolStripW(w),
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND UNDER THE POOLS, THE LEVEL, THE XP TRACK AND THE PURSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THE ARRANGEMENT IS THE DELETED STRIP'S, MOVED RATHER THAN REDESIGNED: the
   * purse takes the left of the band and the xp widget right-aligns into the
   * same box, so neither has to know the other's width. `xpBarGeometry` is
   * asked where it starts and the purse is given what is left, which is the one
   * authority on that edge — a literal there would overlap the widget for
   * exactly the player who reached the cap and grew a `TOP` caption.
   *
   * BELOW THE POOLS, AND ONLY AS FAR BELOW AS THEY ACTUALLY TOOK. The offset
   * adds `RESOURCE_STRIP_H` only when a `resource` frame has landed, because
   * `rowHeightFor` reserved it on the same condition. Reserving on one condition
   * and drawing on another is how a band ends up painted over the row beneath.
   */
  /**
   * ═══ NORMALISED WITH `?? null`, AND THAT IS NOT BELT AND BRACES ═══
   * `PartyPaneView.progress` is typed non-optional, so inside this file the
   * coalesce looks redundant. It is not: every fixture that builds a view by
   * hand predates these two fields, and an object literal missing them reaches
   * here as `undefined` — which passes `!== null` and walks straight into
   * `xpBarGeometry(undefined)` and a TypeError on `xpToNext`. The party-pane
   * tests caught exactly that. Absent and null mean the same thing to this band,
   * so it says so once here rather than four times below.
   */
  const progress = self.progress ?? null;
  const money = self.money ?? null;
  if (member.isSelf && (progress !== null || money !== null)) {
    const bandY = y + PARTY_ROW_H - 1 + (self.resource !== null ? RESOURCE_STRIP_H : 0);
    const bandX = token.x;
    const bandW = Math.max(0, x + w - token.x);
    const xpGeometry = xpBarGeometry(progress, bandX, bandY, bandW);
    drawXpBar({ ctx, progress, x: bandX, y: bandY, width: bandW });
    // NULL PROGRESS MEANS NO XP WIDGET, so the purse may use the whole band; it
    // right-aligns into what it is given and `ui/purse.ts` refuses a box too
    // narrow to hold the text rather than drawing a clipped number.
    const xpLeft = xpGeometry === null ? bandX + bandW : (xpGeometry.caption ?? xpGeometry.track).x;
    drawPurse({
      ctx,
      money,
      x: bandX,
      y: bandY,
      width: Math.max(0, xpLeft - PURSE_GAP - bandX),
    });
  }

  const textX = token.x + FACE_PX + 4;
  const contentRight = Math.max(textX, badgeX + BADGE_PX - BADGE_GAP);

  // --- the name line --------------------------------------------------------
  let nameRight = contentRight;
  /**
   * SOMEWHERE ELSE, WHICH IS NOT THE SAME AS NOBODY DRIVING.
   *
   * `away` above is `!member.online` — a body whose owner has dropped. This is
   * a body in ANOTHER REALM, with somebody at the keyboard, in a fight you are
   * entitled to join. The two look alike on a row and mean opposite things, so
   * this one names the place and offers the way in. Both `elsewhere` and the
   * turn mark are decided at the top of this function now — see the note there.
   */
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
  } else if (mark !== null) {
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = mark.ink;
    const word = fitText(ctx, mark.word, Math.max(0, contentRight - textX - 24));
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
  // YOUR BREATH, in the gap between the hp bar and the pools band — see
  // ui/air.ts for why a sliver and not a band. Only yours, only while short.
  if (member.isSelf) {
    drawAirBar(ctx, self.air ?? null, textX, barY + BAR_H + 1, contentRight - textX - digitsW);
  }
}

/**
 * ONE PORTRAIT-ONLY ROW: the token, its rail, and a 3-pixel hp sliver.
 *
 * Every signal that survives is a SHAPE or a POSITION — the pennant, the hatch,
 * the rail, the bar's length, and now the turn chip — because there is no room
 * for a word. That is the form's whole justification: at this width a name is
 * four characters and an ellipsis, which identifies nobody, while a 24x32 token
 * identifies everybody who has been on screen all session.
 *
 * ═══ THE RAIL HERE MEANS "YOU", AND THE CHIP MEANS THE TURN ═══
 * The full row can spend its rail on the barrier because the `>` and the wash
 * already say which row is yours; at 52 pixels the wash is the only other mark
 * there is, and it is a shade of slate on ink. So the two forms divide the
 * signals differently ON PURPOSE, and the chip — which is in the same corner of
 * the token in both — is the one that carries the turn in both.
 */
function drawCompactRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: PartyPaneRow,
  rect: PanelRect,
  inCombat: boolean,
  air: AirView | null,
): void {
  const { member, downed } = row;
  const { x, y, w } = rect;
  const mark = inCombat && member.away === null ? stateWord(row) : null;

  if (member.isSelf) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, w, PARTY_ROW_COMPACT_H - 2);
  }
  if (downed !== null) {
    ctx.fillStyle = downed.status === DownedStatus.Erased ? PALETTE.GREY : PALETTE.ORANGE;
    ctx.fillRect(x, y, ROW_RAIL_W, PARTY_ROW_COMPACT_H - 2);
  } else if (member.isSelf) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillRect(x, y, ROW_RAIL_W, PARTY_ROW_COMPACT_H - 2);
  }

  const token: PanelRect = { x: x + 4, y: y + 1, w: FACE_PX, h: FACE_PX };
  drawFace(ctx, sprites, row, token);
  if (!member.online || downed !== null) hatchOver(ctx, token);
  if (member.isLeader) drawLeaderPennant(ctx, token.x, token.y);
  drawVoice(ctx, sprites, row.voice, token.x + FACE_PX - VOICE_PX, token.y + FACE_PX - VOICE_PX);
  drawTurnChip(ctx, sprites, mark?.chip ?? null, token);
  // YOUR BREATH HERE TOO, on the face's last row and the gap under it: Portraits
  // is the layout a narrow window forces, and the Weir is no kinder there. The
  // hp bar below keeps all three of its rows.
  if (member.isSelf) drawAirBar(ctx, air, token.x, token.y + FACE_PX - 1, FACE_PX);
  drawHpBar(ctx, token.x, y + FACE_PX + 2, FACE_PX, COMPACT_BAR_H, member, downed !== null);
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
 * mysteriously outlined sprite. Clipped to its own rect because a row must never
 * bleed onto the map — a long nickname included.
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
  const geometry = paneGeometry(view, layout);
  if (!compact) {
    const down = view.rows.filter((row) => row.downed !== null).length;
    /**
     * The header carries the COUNT, not the word "party" alone: "PARTY · 1" is
     * how somebody playing alone learns the pane is right rather than broken.
     *
     * ═══ AND IT SAYS "3/6" WHEN THE BOX COULD NOT HOLD THEM ALL ═══
     * `paneGeometry` places rows while they fit and then stops — silently,
     * which is what it should do with the pixels and the wrong thing to do with
     * the fact. A pane squeezed by the Case Log, by a short band or by the
     * player's own grip showed three faces and a header reading "PARTY · 6",
     * and the three missing people were indistinguishable from three people who
     * had left. One number a player can see, one they have.
     */
    const shown = geometry.rows.length;
    const held = view.rows.length;
    const count = shown < held ? `${shown}/${held}` : String(held);
    const title = down > 0 ? `PARTY · ${down} DOWN` : `PARTY · ${count}`;
    drawHeader(ctx, sprites, title, rect, FONT_META);
  }

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
    if (compact) drawCompactRow(ctx, sprites, slot.row, slot.rect, view.inCombat, view.air ?? null);
    else drawRow(ctx, sprites, slot.row, slot.rect, view.inCombat, view);
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
   * *"Reduces global action speed by 30%."* is the difference between a badge
   * and an explanation.
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
