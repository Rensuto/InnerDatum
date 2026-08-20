/**
 * THE TURN CARDS: a strip of faces that answers ONE question — who still owes a
 * decision this turn.
 *
 * ===========================================================================
 * READ THIS FIRST. IT IS NOT AN INITIATIVE ORDER AND MUST NEVER LOOK LIKE ONE
 * ===========================================================================
 * The reference everybody reaches for is Baldur's Gate 3, and copying it
 * literally would misrepresent this game. BG3 runs STRICT INITIATIVE: one actor
 * acts at a time in a fixed order, and its portrait strip IS that order — you
 * read it left to right to learn who goes next and how long you have to wait.
 *
 * Inner Datum is PHASE-LOCKED (DECISIONS.md D1, PLAN.md § 6). A player action
 * always costs exactly one full turn of energy, so the WHOLE PARTY decides in
 * the same window, everything resolves, and then the monsters sweep as one
 * batch. There is no order among the players because there is no queue to be in.
 * Every card here whose state is `waiting` can act RIGHT NOW.
 *
 * So this strip is a CHECKLIST, not a running order, and the failure mode of
 * getting it wrong is specific and bad: a strip that reads as a queue makes
 * three people sit and wait for "their go" while the server is already waiting
 * on all four. That is the spinner D1 exists to prevent, arrived at through the
 * UI instead of the engine. Concretely, that rule forbids all of:
 *
 *   - re-sorting `turn.actors`. The server sends JOIN ORDER precisely because it
 *     carries no information; a client sort by state, by hp or by name would
 *     both invent a queue and move a card under the cursor between two frames.
 *   - a "next up" marker, an arrow, a numbered badge, or a highlight that
 *     travels along the strip.
 *   - CENTRING THE ROW. The aggregate card appears and vanishes with engagement,
 *     and a centred row would shove every player's card sideways when it did.
 *     Left-aligned, so a card is in the same place all fight (protocol.ts makes
 *     the same promise by putting the aggregate LAST).
 *   - one card per monster. The hostile side is ONE card however many husks are
 *     on the floor, because they resolve together in one batched `sweep`. A row
 *     of individual monster cards would say eight creatures take eight
 *     separately-timed turns, which is a lie about the rules and the second most
 *     common way co-op turn-based dies (game-design.md § 4).
 *
 * ===========================================================================
 * WHAT THIS OWNS, AND WHAT ui/partypanel.ts OWNS. NOT THE SAME PANEL
 * ===========================================================================
 * The bug report is "two things drawing turn state", so the split is written
 * down rather than left to taste:
 *
 *   HERE — the TURN. Who owes a move, who is done, who the Bell is counting on,
 *     which card is you. It exists only while `inCombat` and it is transient by
 *     nature: every value on it changes within one turn.
 *   ui/partypanel.ts — the PEOPLE. Hit points in digits, status badges, the
 *     microphone, whether anybody is still attached to the body, and THE DOWNED
 *     COUNTDOWN. It is always on screen and it answers "who is in trouble".
 *
 * The overlap is deliberate and bounded to exactly two things. A card carries an
 * hp BAR (no digits, except in the wide form) because "how much fight is left in
 * that one" is part of reading the turn, and it carries the word DOWN because a
 * card that said nothing about a body on the floor would be the one card the
 * party most needs. It carries NO countdown: protocol.ts is explicit that the
 * ticking number lives on `PartyMsg.downed`, and two of them on screen is two
 * that can disagree.
 *
 * ui/turnbar.ts keeps the one PROSE line and the frame around the playfield. Its
 * old chip-and-name column strip is deleted, not disabled — it was the second
 * thing drawing this, and it derived the barrier's precedence rules in the
 * browser from three id arrays. `TurnActor.state` is now sent.
 *
 * ===========================================================================
 * STATE IS NEVER CARRIED BY COLOUR ALONE
 * ===========================================================================
 * Roughly one man in twelve cannot separate the red from the green, the Discord
 * overlay is not colour-managed, and this is read in third-of-a-second glances.
 * So every state is said at least three ways:
 *
 *   waiting     full brightness · violet border    · the waiting chip  · WAITING
 *   bell        full brightness · orange border    · the bell chip     · BELL + digits
 *   committed   DIMMED + GREY   · slate border     · the committed chip· DONE
 *   standing_by dimmer + HATCHED· grey border      · the standby chip  · STANDBY
 *   acting      full brightness · orange border    · a play triangle   · ACTING
 *   downed      dimmed + hatched· crimson border   · a crimson rail    · DOWN
 *   YOU         gold border     · a gold caret above the card          · >name
 *
 * THE COMMITTED READ IS THE ONE THAT MATTERS MOST, because "who are we waiting
 * on" is answered by which cards are still BRIGHT. A done card is dimmed with an
 * ink wash AND desaturated with `ctx.filter` where the browser has it, so the
 * difference survives peripheral vision, a colour-blind reader, and a filter-less
 * engine (the wash alone still dims it). Standing By goes further and adds a
 * hatch, which is a SHAPE — the same trick `ui_hotbar_slot_disabled` uses.
 *
 * THE WORD IS THE ONE SIGNAL THE COMPACT FORM DROPS, because there is no column
 * to put it in. Every other one survives: the chip is four distinct authored
 * silhouettes, the wash and the hatch are brightness and texture, DOWN keeps its
 * plate over the face, and the Bell keeps its digits. So the compact card still
 * says every state at least three ways, none of which is colour.
 *
 * CRIMSON is also the combat frame's colour (ui/combatbanner.ts). The two never
 * compete: that ring is a 3px border at the outer edge of the PLAYFIELD and says
 * "the fight is on"; this is a border on a FACE inside a panel and says "that one
 * is on the floor". Both are alarms, neither is a state the other could be
 * mistaken for, and the card additionally carries the hatch, the rail and the
 * word — so crimson is decoration on a signal here, never the signal.
 *
 * ===========================================================================
 * THE HEIGHT BUDGET. 78 LOGICAL PIXELS, AND ZERO OUT OF COMBAT
 * ===========================================================================
 * The map is the game, so this states its cost rather than discovering it:
 *
 *   TURN_CARDS_H = 46 = 3 pad + 4 caret + 36 card + 3 pad  (was 78 at a
 *   64px portrait; see PORTRAIT_PX for why it is half)
 *
 * That is 16% of the 480px MINIMUM logical viewport and about 9% of the ~832px
 * one a real Discord Activity iframe actually gets (render/canvas.ts grows the
 * backbuffer to whole tiles once the integer scale is chosen). It buys back more
 * than it spends: deleting turnbar.ts's 30px column strip means the top HUD is
 * now 14px OUT OF COMBAT against the 44px it used to cost always — so free
 * movement, which is most of a session, shows MORE map than before, and the
 * 92px in-combat total is only paid while there is a fight to track.
 *
 * OUT OF COMBAT THE STRIP IS NOT DRAWN AT ALL and `turnCardsHeight` returns 0.
 * Free movement needs no turn tracker: nobody blocks, nothing is owed, and a
 * permanently visible strip of eight ticks trains people to stop looking at the
 * one surface that has to be believed the moment it does mean something.
 *
 * ===========================================================================
 * TWO FORMS, ONE HEIGHT
 * ===========================================================================
 * WIDE (>= 124px per card): a 64x64 portrait beside a text column — name, chip,
 * state word, hp digits. Six of these need ~765 logical pixels, which the
 * Activity iframe has and the 640px minimum does not.
 * COMPACT (the rest): the portrait alone, with the chip, the Bell digits and the
 * hp bar laid OVER it. Below 68px the portrait is centre-CROPPED rather than
 * scaled — nearest-neighbour downscaling is exactly the resampling the whole
 * backbuffer exists to prevent — down to a 44px floor. Seven cards at 44px fit
 * in 640, so the party cap of six plus the hostile side never overflows.
 *
 * THE HEIGHT IS THE SAME IN BOTH FORMS, on purpose: the map must not resize
 * because somebody joined or a window got narrower.
 *
 * It draws into the BACKBUFFER through `Scene.hud`, at logical scale, like every
 * other ui/ module — see the long note at the top of render/canvas.ts — so the
 * cards are magnified by the same integer factor as the world and can never be
 * half a pixel off the art they sit above. No second canvas, no DOM overlay.
 */

import { TurnActorKind, TurnActorState } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { drawPanel, fitText, PanelSkin } from './panel.ts';
import type { TurnActor, TurnMsg } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry. See the height budget in the header before changing any of it.
// ---------------------------------------------------------------------------

/**
 * How big a portrait is DRAWN. The art is authored at 64.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HALVED, BECAUSE THE STRIP WAS EATING THE FIGHT
 * ═══════════════════════════════════════════════════════════════════════════
 * This used to be 64 and blitted 1:1, which made the band 78px — a sizable
 * bite out of a viewport that is at most 32 tiles tall, taken at exactly the
 * moment the player most needs to see the room. Reported from play as taking
 * up too much of the screen during a fight, which it did.
 *
 * 32 IS AN EXACT HALF AND THAT IS THE WHOLE REASON FOR THE NUMBER. The HUD
 * context runs with `imageSmoothingEnabled = false`, so a downscale is
 * nearest-neighbour: at 1/2 it drops every other pixel evenly and the face
 * stays clean, while 40 or 48 would drop them unevenly and make a hand-drawn
 * portrait look damaged. The band goes 78 -> 46, a third of the screen bite
 * given back, and the card still answers the only question it is for — who
 * acts next — because that is carried by the silhouette and the frame rather
 * than by the detail.
 */
const PORTRAIT_PX = 32;
/** Authored size of every `ui_icon_turn_*`. */
const CHIP_PX = 24;
const CARD_BORDER = 2;
/** Portrait plus its frame. */
const CARD_H = PORTRAIT_PX + CARD_BORDER * 2;
const CARD_GAP = 3;
const BAND_PAD = 3;
/** The gold "this one is you" caret, in the band's padding above the cards. */
const CARET_H = 4;
const CARET_W = 9;

/** The strip's whole vertical bite. Zero out of combat — see `turnCardsHeight`. */
export const TURN_CARDS_H = BAND_PAD * 2 + CARET_H + CARD_H;

/**
 * The narrowest card that still fits a name column worth having: 124 - 4 border
 * - 68 portrait leaves 52 pixels, which is eight characters of 10px monospace
 * plus an ellipsis. Below that the text column is a smear and the compact form
 * — which spends every pixel on a face — is strictly more legible.
 */
const CARD_W_FULL_MIN = 124;
/**
 * And the widest. Past this a four-person party stretches into four billboards
 * with a lake of empty panel in each; the row is left-aligned, so the slack goes
 * to the right where it is simply band.
 */
const CARD_W_FULL_MAX = 168;
/** Portrait plus frame, exactly. The compact card is the portrait. */
const CARD_W_COMPACT = PORTRAIT_PX + CARD_BORDER * 2;
/**
 * The floor. A 40px-wide crop of a 64px face still reads as that face; narrower
 * and the chip has nowhere to sit. Seven cards at this width plus gaps is 326px,
 * so the documented party cap can never overflow a 640px viewport.
 */
const CARD_W_MIN = 44;

const BAR_H = 5;
const TEXT_GAP = 4;
/** Below this fraction the hp bar turns, and the digits turn with it. */
const HP_LOW = 1 / 3;

const FONT_NAME = '10px ui-monospace, Consolas, monospace';
const FONT_NAME_SELF = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';
/** The Bell digits and the DOWN plate. Big, because they are the whole message. */
const FONT_PLATE = 'bold 12px ui-monospace, Consolas, monospace';
/** Initials, when there is no portrait to draw. Fills the 64px square. */
const FONT_INITIALS = 'bold 24px ui-monospace, Consolas, monospace';

// ---------------------------------------------------------------------------
// The view, and the three questions everything else asks of a `turn` frame
// ---------------------------------------------------------------------------

/**
 * Everything the strip needs, assembled by main.ts once per frame.
 *
 * IT IS THE WHOLE VIEW FOR ui/turnbar.ts TOO, which is why it lives here rather
 * than in either file's own vocabulary: the banner and the cards must describe
 * the same instant, and two view types is two chances for main.ts to build one
 * from a `turn` frame and the other from the previous one.
 *
 * `bellMs` is NOT read from `turn.bellMs`. The server sends the milliseconds
 * remaining at the instant it sent the frame, and a countdown that only moves
 * when a packet arrives is not a countdown — main.ts holds the deadline and ticks
 * it locally, and hands the current value in here.
 *
 * There is deliberately no `selfId` and no actor list. `TurnActor.isSelf` is the
 * server's answer to "which card is you" (protocol.ts: that flag is the reason
 * `turn` is unicast), and every name, hp value and portrait a card needs is on
 * the card. A join against the actor map would be a second source for facts the
 * frame already carries, and it would disagree first for the aggregate, which
 * has no body to join to.
 */
export type TurnView = {
  /** Null until the first `turn` frame; nothing is drawn. */
  readonly turn: TurnMsg | null;
  /** Milliseconds left on the Bell, ticked locally. Null when none is running. */
  readonly bellMs: number | null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE VIEWER HAS LEFT TO SPEND THIS ROUND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * FROM `ResourceMsg` AND NOT FROM `TurnActor`, and that is not a convenience —
   * it is the only place it may come from. A turn card describes a player TO THE
   * ROOM, and `ResourceView` is viewer-private for a stated reason: another
   * detective's remaining budget is not yours to read. Putting AP on the public
   * per-actor record would leak every player's round to every other player.
   *
   * OPTIONAL, because a client can outlive a server that never sends it and
   * because there is no budget at all before the first `resource` frame lands.
   * Absent means the banner says what it always said.
   */
  readonly budget?: {
    readonly ap: number;
    readonly maxAp: number;
    readonly mp: number;
    readonly maxMp: number;
  } | null;
};

export type TurnCardsOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: TurnView;
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** Top of the strip. main.ts stacks it directly under the banner. */
  readonly y: number;
};

/**
 * WHICH CARD IS YOU, or null.
 *
 * Straight off the server's flag, never a comparison against a local `selfId`.
 * A spectating or bodiless socket genuinely has no card, and "nobody is
 * highlighted" has to be a fact the server states rather than a comparison that
 * happens to fail — see the note on `TurnActor.isSelf`.
 */
export function selfCard(turn: TurnMsg | null): TurnActor | null {
  if (turn === null) return null;
  return turn.actors.find((card) => card.isSelf) ?? null;
}

/**
 * HOW MANY PEOPLE STILL OWE A DECISION.
 *
 * Counted off `actors`, which is the authoritative per-actor state, so this
 * number and the bright cards on the strip can never disagree. The old
 * `whoseTurn.length - committed.length` cannot be used for it: protocol.ts
 * records that `whoseTurn` holds only the actors that still owe, so `committed`
 * is empty by construction and the subtraction is a no-op that merely looks like
 * arithmetic.
 *
 * The aggregate is excluded. The hostile side owes nothing — it resolves after
 * the party, and counting it would tell four people they are waiting on five.
 */
export function owedCount(turn: TurnMsg | null): number {
  if (turn === null) return 0;
  let owed = 0;
  for (const card of turn.actors) {
    if (card.kind !== TurnActorKind.Player) continue;
    if (card.state === TurnActorState.Waiting || card.state === TurnActorState.Bell) owed += 1;
  }
  return owed;
}

/** Whole seconds, rounded up, so a live Bell never displays 0 while it runs. */
export function bellSeconds(bellMs: number | null): number | null {
  return bellMs === null ? null : Math.max(0, Math.ceil(bellMs / 1000));
}

/**
 * What the strip costs the map right now.
 *
 * ZERO OUT OF COMBAT, which is the whole reason this is a function and not the
 * constant. main.ts stacks the dock under it, so returning 0 is what gives the
 * party panel and the Case Log the 78 pixels back the moment the fight ends.
 */
export function turnCardsHeight(turn: TurnMsg | null): number {
  if (turn === null || !turn.inCombat || turn.actors.length === 0) return 0;
  return TURN_CARDS_H;
}

// ---------------------------------------------------------------------------
// One card's treatment
// ---------------------------------------------------------------------------

/**
 * How one state looks, decided in ONE table so a state cannot acquire a border
 * in one branch and a wash in another.
 *
 * `word` is the half that survives greyscale, a 1x scale and a bad monitor. It
 * is short on purpose — WAITING, DONE, BELL, STANDBY, ACTING, DOWN — because it
 * is read peripherally at 10px in a 52-pixel column, and "COMMITTED" at that
 * size is a grey smudge whose only legible property is its length.
 */
type CardTone = {
  readonly border: string;
  /** Alpha of the INK wash over the portrait. 0 leaves it at full brightness. */
  readonly wash: number;
  /** Ask the browser for greyscale as well. The wash is the fallback. */
  readonly desaturate: boolean;
  /** A diagonal hatch: a SHAPE difference, for the states nobody waits on. */
  readonly hatch: boolean;
  readonly word: string;
};

/**
 * Exhaustive over `TurnActorState` with no `default`, so a sixth state cannot
 * ship wearing whatever the fall-through happened to be.
 *
 * DOWNED IS CHECKED FIRST because it outranks the state it arrives with. The
 * projector sends a body on the floor as `standing_by` — correct, the barrier is
 * not waiting on them — but "excluded from the quorum" and "bleeding out" must
 * not look the same on a card, and only one of them means *get to them*.
 */
function toneFor(card: TurnActor): CardTone {
  if (card.downed) {
    return {
      border: PALETTE.CRIMSON,
      wash: 0.55,
      desaturate: true,
      hatch: true,
      word: 'DOWN',
    };
  }
  switch (card.state) {
    case TurnActorState.Waiting:
      return {
        border: PALETTE.VIOLET_HI,
        wash: 0,
        desaturate: false,
        hatch: false,
        word: 'WAITING',
      };
    case TurnActorState.Bell:
      return { border: PALETTE.ORANGE, wash: 0, desaturate: false, hatch: false, word: 'BELL' };
    case TurnActorState.Acting:
      return { border: PALETTE.ORANGE, wash: 0, desaturate: false, hatch: false, word: 'ACTING' };
    case TurnActorState.Committed:
      // THE MOST IMPORTANT READ ON THE STRIP. Dimmed hard and desaturated, so
      // "who are we waiting on" is answered by which faces are still bright
      // without anybody reading a word or telling two colours apart.
      return { border: PALETTE.SLATE, wash: 0.55, desaturate: true, hatch: false, word: 'DONE' };
    case TurnActorState.StandingBy:
      return { border: PALETTE.GREY, wash: 0.72, desaturate: true, hatch: true, word: 'STANDBY' };
  }
}

/**
 * The chip's asset id, or null when there is no art for the state.
 *
 * The four turn chips are authored (`ui_icon_turn_{waiting,committed,bell,
 * standing_by}` — the protocol's state VALUES are the art suffixes, so renaming
 * one renames a PNG). `acting` deliberately has none: it belongs to the
 * aggregate card alone and is not a state a player is ever in, so it is drawn as
 * a play triangle below rather than given a fifth silhouette nobody would learn.
 */
function chipIdFor(state: TurnActorState): string | null {
  switch (state) {
    case TurnActorState.Waiting:
    case TurnActorState.Committed:
    case TurnActorState.Bell:
    case TurnActorState.StandingBy:
      return `ui_icon_turn_${state}`;
    case TurnActorState.Acting:
      return null;
  }
}

/** Two letters, for a card with no portrait. `The Filed` -> `TF`. */
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
 * A face, or two letters.
 *
 * NEVER SCALED. A player's portrait is authored at 64x64 and lands 1:1; the
 * aggregate wears the SPRITE of the most dangerous living hostile, which is
 * 24x32 or 48x64 and is therefore bottom-centred inside the box exactly as
 * render/canvas.ts anchors a body on a tile — the feet are what say which thing
 * this is. When the card has been squeezed narrower than the art, the SOURCE
 * rectangle is cropped symmetrically instead: nearest-neighbour downscaling
 * throws away every other pixel of a pixel-art face, which is precisely the
 * resampling the backbuffer exists to prevent.
 *
 * THE FALLBACK IS INITIALS, NOT A BLANK. Half the `icon_character_the_*` family
 * is uncut today (art-pipeline: watchman, inspector and the generic detective
 * are not in the manifest yet) and the monster sprites in `enemy_*` are a
 * partial roster, so this path is the COMMON case rather than the regression
 * case. Two letters keep the card identifiable, which matters most in the
 * compact form where the portrait is the only thing saying who this is.
 */
function blitPortrait(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  card: TurnActor,
  box: PanelRect,
  tone: CardTone,
): void {
  if (box.w <= 0 || box.h <= 0) return;

  const sprite = card.portrait === undefined ? undefined : sprites.sprite(card.portrait);
  if (sprite === undefined) {
    ctx.save();
    ctx.font = FONT_INITIALS;
    ctx.textAlign = 'center';
    ctx.fillStyle = tone.wash > 0 ? PALETTE.GREY : PALETTE.GREY_HI;
    ctx.fillText(initialsOf(card.name), box.x + box.w / 2, box.y + box.h / 2 + 1);
    ctx.restore();
    return;
  }

  const sw = Math.min(sprite.w, box.w);
  const sh = Math.min(sprite.h, box.h);
  const sx = Math.floor((sprite.w - sw) / 2);
  // Crop from the TOP when a sprite is taller than the box: a creature's feet
  // are the half that identifies it, and a face icon is never taller than 64.
  const sy = sprite.h - sh;
  const dx = box.x + Math.floor((box.w - sw) / 2);
  const dy = box.y + (box.h - sh);

  ctx.save();
  // Best effort, and never the only signal: an engine without canvas filters
  // silently ignores this and the ink wash below still dims the card.
  if (tone.desaturate) ctx.filter = 'grayscale(1)';
  ctx.drawImage(sprite.image, sx, sy, sw, sh, dx, dy, sw, sh);
  ctx.restore();
}

/**
 * Diagonal ink over a card nobody is waiting for.
 *
 * A SHAPE, which is the point — it survives greyscale and the corner of an eye,
 * and it is the same "this one is out" grammar `ui_hotbar_slot_disabled` already
 * carries. Clipped to the box so the strokes cannot run over the neighbouring
 * card.
 */
function hatchOver(ctx: CanvasRenderingContext2D, box: PanelRect): void {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.strokeStyle = PALETTE.INK;
  ctx.lineWidth = 2;
  for (let offset = -box.h; offset < box.w; offset += 7) {
    ctx.beginPath();
    ctx.moveTo(box.x + offset, box.y + box.h);
    ctx.lineTo(box.x + offset + box.h, box.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * One chip, on an ink plate so a silhouette drawn over a face is still a
 * silhouette.
 *
 * The missing-art fallback carries the state's initial letter rather than a
 * blank box: a broken PNG must not collapse four distinguishable states into one
 * anonymous square, which would break this file's central promise at exactly the
 * moment the pipeline regressed.
 */
function drawChip(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  state: TurnActorState,
  x: number,
  y: number,
): void {
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x - 1, y - 1, CHIP_PX + 2, CHIP_PX + 2);

  const id = chipIdFor(state);
  const sprite = id === null ? undefined : sprites.sprite(id);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
    return;
  }

  if (state === TurnActorState.Acting) {
    // A play triangle: a shape nothing else in the strip wears, for the one
    // state that is neither owed nor done — the sweep is happening.
    ctx.fillStyle = PALETTE.ORANGE;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 4);
    ctx.lineTo(x + CHIP_PX - 4, y + CHIP_PX / 2);
    ctx.lineTo(x + 6, y + CHIP_PX - 4);
    ctx.closePath();
    ctx.fill();
    return;
  }

  ctx.fillStyle = PALETTE.VIOLET_HI;
  ctx.fillRect(x, y, CHIP_PX, CHIP_PX);
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x + 2, y + 2, CHIP_PX - 4, CHIP_PX - 4);
  ctx.save();
  ctx.font = FONT_META;
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(state.charAt(0).toUpperCase(), x + CHIP_PX / 2, y + CHIP_PX / 2);
  ctx.restore();
}

/**
 * The hp bar. Two rects and, in the wide form, the digits.
 *
 * A RECT, NOT AN IMAGE, for the reason ui/partypanel.ts states: a bar is a fraction
 * of a width that changes with the card and the party size, and art would need
 * either a frame per step or one stretched PNG resampled to a fractional width.
 *
 * THE DOWNED TRACK IS HATCHED AND UNFILLED, drawn exactly as the party panel
 * draws it, on purpose: 0/58 as a plain empty bar is indistinguishable at a
 * glance from a dead monster's, and the whole point of Downed is that it is not
 * death. Two surfaces describing the same body must not describe it differently.
 *
 * ON THE AGGREGATE CARD THIS IS A GROUP BAR — the sum over every living hostile,
 * which is "how much fight is left in the other side" and never one creature's
 * health. That is also why the digits are suppressed for it; see `drawCard`.
 */
function drawHpBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  card: TurnActor,
): void {
  if (w <= 0) return;

  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x, y, w, BAR_H);

  if (card.downed) {
    ctx.fillStyle = PALETTE.ORANGE;
    for (let i = 0; i < w; i += 4) {
      ctx.fillRect(x + i, y + 1, 2, BAR_H - 2);
    }
    return;
  }

  const fraction = Math.min(1, Math.max(0, card.hp / Math.max(1, card.maxHp)));
  const fill = Math.floor((w - 2) * fraction);
  if (fill <= 0) return;
  ctx.fillStyle = fraction <= HP_LOW ? PALETTE.ORANGE : PALETTE.GOLD;
  ctx.fillRect(x + 1, y + 1, fill, BAR_H - 2);
}

/**
 * A word on a solid plate, centred over the portrait.
 *
 * Used for the two things that must be legible over ANY face: the Bell's
 * remaining seconds and DOWN. A plate rather than an outline because both land
 * on top of arbitrary art, and an outlined glyph over a busy sprite is a glyph
 * somebody has to look twice at.
 */
function drawPlate(
  ctx: CanvasRenderingContext2D,
  text: string,
  ground: string,
  ink: string,
  box: PanelRect,
  midY: number,
): void {
  ctx.save();
  ctx.font = FONT_PLATE;
  ctx.textAlign = 'center';
  const w = Math.min(box.w, Math.ceil(ctx.measureText(text).width) + 8);
  const midX = box.x + Math.floor(box.w / 2);
  ctx.fillStyle = ground;
  ctx.fillRect(midX - Math.floor(w / 2), midY - 7, w, 14);
  ctx.fillStyle = ink;
  ctx.fillText(fitText(ctx, text, w - 4), midX, midY);
  ctx.restore();
}

/** The gold "this one is you" caret, pointing down at the card. */
function drawCaret(ctx: CanvasRenderingContext2D, midX: number, y: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.GOLD;
  ctx.beginPath();
  ctx.moveTo(midX - CARET_W / 2, y);
  ctx.lineTo(midX + CARET_W / 2, y);
  ctx.lineTo(midX, y + CARET_H);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * ONE CARD.
 *
 * Layout, inside the 2px border, for a 64-pixel-tall interior:
 *
 *   COMPACT              WIDE
 *   +--------------+     +--------------+---------------+
 *   | face   [chip]|     | face   [chip]| >name         |
 *   |     DOWN     |     |     DOWN     | WAITING       |
 *   |    [ 12s ]   |     |    [ 12s ]   | 23/58         |
 *   |▓▓▓▓▓░░░░░░░░░|     |▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░|
 *   +--------------+     +--------------+---------------+
 *
 * The chip, the DOWN plate and the Bell digits are in the SAME PLACE in both
 * forms — over the face — so the strip changing form does not move a signal.
 * Only the text column comes and goes.
 *
 * The bar spans the WHOLE interior in both forms, including under the portrait,
 * which is the one thing here that is a straight lift from BG3 — a health bar
 * across the bottom edge of a face is a shape people already read.
 */
function drawCard(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  card: TurnActor,
  rect: PanelRect,
  compact: boolean,
  secs: number | null,
): void {
  const tone = toneFor(card);
  const dim = tone.wash > 0;

  // The border is the card's outer rect painted flat, then the interior painted
  // over it — four fillRects' worth of arithmetic avoided, and it cannot leave a
  // one-pixel seam at a corner the way four strips can.
  //
  // YOU OUTRANK EVERY STATE ON THE BORDER. Finding yourself has to be instant and
  // must not depend on what you happen to be doing this turn; the state is still
  // said by the chip, the word, the wash and the hatch. A downed self keeps the
  // crimson rail below, so neither fact is lost.
  ctx.fillStyle = card.isSelf ? PALETTE.GOLD : tone.border;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const ix = rect.x + CARD_BORDER;
  const iy = rect.y + CARD_BORDER;
  const iw = rect.w - CARD_BORDER * 2;
  const ih = rect.h - CARD_BORDER * 2;
  if (iw <= 0 || ih <= 0) return;

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(ix, iy, iw, ih);

  const portrait: PanelRect = {
    x: ix,
    y: iy,
    w: compact ? iw : Math.min(PORTRAIT_PX, iw),
    h: ih,
  };
  blitPortrait(ctx, sprites, card, portrait, tone);

  // The dim and the hatch cover the FACE only. The text column beside it stays
  // at full contrast: a card that is done still has to be readable, it just must
  // not be one of the bright ones you are counting.
  if (tone.wash > 0) {
    ctx.save();
    ctx.globalAlpha = tone.wash;
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(portrait.x, portrait.y, portrait.w, portrait.h);
    ctx.restore();
  }
  if (tone.hatch) hatchOver(ctx, portrait);

  // THE DOWNED RAIL, two pixels down the inside edge — the same signal the party
  // panel's rows carry, so the two surfaces mark a body on the floor the same
  // way. It survives the gold self-border, which is why it is drawn inside.
  if (card.downed) {
    ctx.fillStyle = PALETTE.CRIMSON;
    ctx.fillRect(ix, iy, 2, ih);
  }

  const barY = iy + ih - BAR_H;
  drawHpBar(ctx, ix, barY, iw, card);

  // THE CHIP IS TOP-RIGHT OF THE FACE IN BOTH FORMS, never in the text column.
  // One fixed place beats one that migrates with the layout: the strip changes
  // form when the window is resized or somebody joins, and a state icon that
  // moves is a state icon that has to be found again. Clamped so a card crushed
  // to the 44px floor still shows it.
  const chipX = Math.max(ix, portrait.x + portrait.w - CHIP_PX - 1);
  drawChip(ctx, sprites, card.state, chipX, iy + 1);

  // THE BELL'S DIGITS, on the card of whoever it is counting and nowhere else.
  // Every straggler carries them at once — there is one level-wide deadline, not
  // one per player — and they go over the face because that is the loudest place
  // on the card and a Bell is the loudest thing that happens on a turn.
  if (secs !== null && card.state === TurnActorState.Bell) {
    drawPlate(ctx, `${secs}s`, PALETTE.INK, PALETTE.ORANGE, portrait, barY - 12);
  }
  if (card.downed) {
    // Across the middle of the face, clear of the chip above it. No countdown:
    // `PartyMsg.downed` owns the ticking number and the party panel draws it as
    // "DOWN 3/5"; a second copy here is a second copy that can sit one frame
    // behind the first.
    drawPlate(ctx, 'DOWN', PALETTE.CRIMSON, PALETTE.PARCHMENT, portrait, iy + Math.floor(ih / 2));
  }

  if (compact) return;

  // --- the text column, wide form only --------------------------------------
  //
  // THREE STACKED LINES, each given the WHOLE column, rather than anything laid
  // out beside anything else. At the narrow end of the wide form the column is
  // 50 pixels — eight characters — and a word sharing that row with an icon
  // would be four. Every line here has to survive the narrowest card that still
  // claims to have room for words, or the form is lying about itself.
  const tx = ix + PORTRAIT_PX + TEXT_GAP;
  const tw = ix + iw - tx - 2;
  if (tw <= 0) return;

  ctx.font = card.isSelf ? FONT_NAME_SELF : FONT_NAME;
  ctx.fillStyle = card.isSelf ? PALETTE.GOLD : dim ? PALETTE.GREY_HI : PALETTE.BONE;
  // '>' as well as the colour and the caret. Three signals for the one thing a
  // player must never have to hunt for on this strip.
  ctx.fillText(fitText(ctx, card.isSelf ? `>${card.name}` : card.name, tw), tx, iy + 8);

  // The word and the border are the same colour on purpose: the frame is the
  // glance and the word is the confirmation, and they must not be able to say
  // two different things.
  ctx.font = FONT_META;
  ctx.fillStyle = tone.border;
  ctx.fillText(fitText(ctx, tone.word, tw), tx, iy + 24);

  // DIGITS FOR A PERSON, A BAR ALONE FOR THE SIDE. The aggregate's numbers are a
  // SUM over every living hostile, and "142/300" printed on a card wearing one
  // creature's face invites reading it as that creature's health — which is the
  // one thing protocol.ts says this card must never say.
  if (card.kind === TurnActorKind.Monsters) return;
  const fraction = card.hp / Math.max(1, card.maxHp);
  ctx.font = FONT_NAME;
  ctx.fillStyle = fraction <= HP_LOW ? PALETTE.ORANGE : dim ? PALETTE.GREY : PALETTE.BONE;
  const digits = `${Math.max(0, Math.ceil(card.hp))}/${card.maxHp}`;
  ctx.fillText(fitText(ctx, digits, tw), tx, iy + 40);
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

/**
 * How wide one card gets, and therefore which form it wears.
 *
 * Two forms and a crop rather than a continuous shrink, because the wide form
 * has a text column whose contents stop being words somewhere around 40 pixels
 * and there is no honest halfway house. The cliff is at `CARD_W_FULL_MIN` and it
 * is crossed by the viewport getting narrower or by somebody joining, both of
 * which are moments a layout is allowed to change.
 */
function cardMetrics(
  count: number,
  avail: number,
): { readonly w: number; readonly compact: boolean } {
  const per = Math.floor((avail - CARD_GAP * (count - 1)) / count);
  if (per >= CARD_W_FULL_MIN) return { w: Math.min(per, CARD_W_FULL_MAX), compact: false };
  return { w: Math.max(CARD_W_MIN, Math.min(per, CARD_W_COMPACT)), compact: true };
}

/**
 * Paint the strip.
 *
 * NOTHING AT ALL OUT OF COMBAT — see the header. `inCombat` comes straight off
 * the wire and is never inferred from `whoseTurn` being non-empty: that
 * inference cannot tell the start of a fight from one straggler still deciding,
 * and it is the bug this milestone exists to fix.
 *
 * Wrapped in save/restore because it sets `font`, `textAlign`, `textBaseline`,
 * `globalAlpha`, `lineWidth`, `strokeStyle` and `filter`, none of which the
 * world painter re-sets before every call — a leaked greyscale filter would grey
 * the whole map and read as a broken PNG rather than as a missing restore.
 */
export function drawTurnCards(options: TurnCardsOptions): void {
  const { ctx, sprites, view, width, y } = options;
  const turn = view.turn;
  if (turn === null || !turn.inCombat) return;

  const cards = turn.actors;
  if (cards.length === 0 || width <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, { x: 0, y, w: width, h: TURN_CARDS_H });
  // Everything after this is confined to the band, so a card can never bleed
  // into the map on a viewport too narrow to hold the row.
  ctx.beginPath();
  ctx.rect(0, y, width, TURN_CARDS_H);
  ctx.clip();

  const avail = width - BAND_PAD * 2;
  const metrics = cardMetrics(cards.length, avail);
  const secs = bellSeconds(view.bellMs);
  const cardY = y + BAND_PAD + CARET_H;
  /** Unreachable at the documented cap of six players plus one side. Honest anyway. */
  const room = Math.max(1, Math.floor((avail + CARD_GAP) / (metrics.w + CARD_GAP)));

  let cursor = BAND_PAD;
  let drawn = 0;
  for (const card of cards) {
    // IN THE ORDER THE SERVER SENT THEM. Join order, never re-sorted here — see
    // the header, and protocol.ts above `TurnActorKind`.
    if (drawn >= room) break;
    const rect: PanelRect = { x: cursor, y: cardY, w: metrics.w, h: CARD_H };
    drawCard(ctx, sprites, card, rect, metrics.compact, secs);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "STILL GOING" — a player who has ACTED and still owes a decision.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `DECISIONS.md` D1's intra-turn budget means acting does not necessarily
     * end your turn: Ward Rush costs 2 of 6, so the round stays open and the
     * player parks again. `whoseTurn` is still true of them — the party IS
     * waiting — so their chip is correctly `waiting`, and without this their
     * card is identical to somebody who has not touched a key.
     *
     * That distinction is the whole reason the table can tell "he is thinking"
     * from "he has walked away", which is what makes the Bell feel fair.
     *
     * ═══ DRAWN, NOT A CHIP, AND THAT IS NOT LAZINESS ═══
     * `TurnActorState.Acting` exists but belongs to the MONSTERS card, and there
     * is no `ui_icon_turn_acting.png` in the manifest — reusing it would paint
     * the violet missing-asset box on a live card. A two-pixel gold rule along
     * the bottom of the card needs no art, reads at a glance as a progress
     * mark rather than a state change, and cannot be confused with the chip.
     */
    if ((turn.acting ?? []).includes(card.id)) {
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillRect(rect.x + 2, rect.y + rect.h - 2, rect.w - 4, 2);
    }
    if (card.isSelf) drawCaret(ctx, rect.x + Math.floor(rect.w / 2), cardY - CARET_H);
    cursor += metrics.w + CARD_GAP;
    drawn += 1;
  }

  if (drawn < cards.length) {
    // "There are more of us than you can see" is itself information, and saying
    // it beats silently dropping the card of somebody the party is waiting on.
    //
    // THE FIX FOR THIS, IF IT EVER FIRES, IS A SECOND ROW — never pulling the
    // dropped cards (or your own) to the front. Re-ordering to keep a card
    // visible would break the promise the whole strip rests on: that a card sits
    // in the same place all fight and cannot be read as a queue position.
    ctx.font = FONT_META;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(`+${cards.length - drawn}`, cursor, cardY + CARD_H / 2);
  }

  ctx.restore();
}
