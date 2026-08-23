/**
 * The Warrant Clock, in words: ONE line of prose that says whether the game is
 * waiting on you, plus the frame around the playfield.
 *
 * WHY THIS IS THE MOST IMPORTANT UI IN THE GAME. game-design.md § 4 names the
 * failure mode outright: player 1 deliberates, players 2-4 tab out, the voice
 * channel drifts and the session dies. Every mechanism in that section — the
 * barrier, the quorum, the Bell, Standing By — exists to keep four people
 * pointed at the same moment, and all of it is wasted if the screen does not
 * say, at a glance and at all times, "it is your move" or "we are waiting on
 * Sam". So this file draws that continuously, never on a hover, never in a
 * corner, and never only in the status line under the canvas.
 *
 * ===========================================================================
 * THE COLUMN STRIP THAT USED TO LIVE HERE IS GONE. ui/turncards.ts REPLACED IT
 * ===========================================================================
 * It was a row of chips-and-names across the top, and by M5 it was the SECOND
 * thing on screen drawing turn state — the party panel already had the people,
 * and the new card strip has the turn. Two surfaces answering one question is
 * the bug this milestone was opened to fix, so the strip was deleted rather than
 * hidden behind a flag.
 *
 * `chipFor` went with it, and that is the more important half. It derived the
 * barrier's precedence — Standing By outranks a commit, a commit outranks the
 * Bell — in the BROWSER, from three id arrays, which was a second implementation
 * of rules that live in src/server/engine/barrier.ts. It also could not express
 * the case that matters most: a Downed detective is in neither `whoseTurn` nor
 * `standingBy`, so the old lookup fell through to "committed" and told the party
 * that the person bleeding out on the floor had taken their turn.
 * `TurnActor.state` is now sent per actor and is the only answer anything reads.
 *
 * WHAT IS LEFT HERE IS THE PROSE AND THE BORDER, and both are deliberate. The
 * sentence is the copy a screen reader can be given and the one people quote at
 * each other in voice; the frame is what you catch out of the corner of your eye
 * while looking at the map rather than at the HUD. The cards are the third
 * telling. Three tellings of one fact is the point, not redundancy — but three
 * PLACES deciding that fact would be the bug.
 *
 * THE FRAME ITSELF MOVED OUT, to ui/combatbanner.ts. It is now two concentric
 * rings answering two different questions — gold for "the game is waiting on
 * you", crimson outside it for "the fight is on" — and one painter owns both so
 * their insets cannot disagree. `drawTurnBar` still calls it, at the same point
 * in the same frame; nothing about its meaning changed here.
 *
 * IT DRAWS INTO THE BACKBUFFER, at logical scale, through `Scene.hud`. That
 * means it is magnified by the same integer factor as the world (see the long
 * note at the top of render/canvas.ts) and can never be half a pixel off the art
 * it sits above.
 */

import { TurnActorState } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { MENU_BUTTON_W } from './menubutton.ts';
import { drawPlayfieldFrame } from './combatbanner.ts';
import { fitText } from './panel.ts';
import { bellSeconds, owedCount, selfCard, turnCardsHeight } from './turncards.ts';
import type { TurnView } from './turncards.ts';

/**
 * The view is SHARED WITH THE CARD STRIP and is declared in ui/turncards.ts —
 * see the note there. This alias exists because main.ts already speaks the name;
 * the banner and the cards must never be built from two different `turn` frames,
 * and one type is how that is enforced rather than remembered.
 */
export type TurnBarView = TurnView;

export type TurnBarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: TurnBarView;
  /** Logical backbuffer size, in world pixels — not device pixels. */
  readonly width: number;
  readonly height: number;
};

const PAD = 3;

/**
 * The bar is now exactly one line of prose.
 *
 * It was 44 pixels — a 30px chip column plus this — and it is 14. The 30 went to
 * ui/turncards.ts, which spends 78 but ONLY IN COMBAT, so the top HUD costs less
 * than it used to for the majority of a session that is spent walking around.
 * Callers stacking anything under the HUD want `turnHudHeight`, not this.
 */
export const TURN_BAR_H = 14;

const FONT_BOLD = 'bold 10px ui-monospace, Consolas, monospace';

/**
 * EVERYTHING THE TOP HUD OCCUPIES, banner plus cards, right now.
 *
 * A function rather than a constant because the card strip is drawn only while
 * `inCombat` — the dock below it grows back the moment a fight ends, which is
 * the whole reason the strip is allowed to be 78 pixels tall in the first place.
 * Exported so main.ts stacks the dock and the combat banner by arithmetic rather
 * than by a second hard-coded number that drifts the first time a card changes
 * size.
 */
export function turnHudHeight(view: TurnBarView): number {
  return TURN_BAR_H + turnCardsHeight(view.turn);
}

/**
 * THE question. True when the game is waiting on this client.
 *
 * Read off `TurnActor.state`, which the server decides, so this cannot disagree
 * with the card strip about whether you owe a move.
 *
 * OUT OF COMBAT THE ANSWER IS STILL YES, and the special case is honest rather
 * than convenient: with `engagement === 0` nobody blocks, so the projector marks
 * every card `committed` — a true statement about the BARRIER and the opposite
 * of the truth about the PLAYER, who may act freely. A socket with no card of
 * its own (a spectator, a body still being assigned) is never "your turn".
 */
export function isYourTurn(view: TurnBarView): boolean {
  const turn = view.turn;
  if (turn === null) return false;
  const card = selfCard(turn);
  if (card === null) return false;
  if (!turn.inCombat) return true;
  return card.state === TurnActorState.Waiting || card.state === TurnActorState.Bell;
}

/**
 * One line of prose, because a shape and a colour are not enough on their own
 * and because this is the text the status line mirrors for screen readers.
 *
 * IT LEADS WITH WHETHER THERE IS A FIGHT. `inCombat` comes straight off the wire
 * and is never inferred from `whoseTurn` being non-empty: the two agree in the
 * ordinary case and disagree in the one that matters — a fight in which every
 * other player is Standing By empties the quorum without ending the fight, and
 * the old inference printed "nothing is hunting you" in the middle of one.
 *
 * The counts come from `owedCount`, which reads the same `actors` array the
 * cards are drawn from, so the sentence and the strip can never disagree about
 * how many people the party is waiting on.
 *
 * Exhaustive over `TurnActorState` with no `default`, so a sixth state cannot
 * ship without words.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT IS LEFT IN THE ROUND, IN THE FEWEST CHARACTERS THAT STILL SAY IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE QUESTION THIS BANNER EXISTS TO ANSWER IS "AM I DONE?", and until now it
 * could not. The engine has an honest answer — `hasAffordableAction` closes the
 * round the moment nothing is off cooldown and affordable on BOTH budgets — but
 * the player could not see either number, so acting twice and still being asked
 * for a decision read as the game ignoring them.
 *
 * BOTH BUDGETS, ALWAYS, because a round can end on either. A step costs 1 MP of
 * 3 (`MOVE_MP_COST`) and a talent costs its AP, so a Watchman holding 4 AP and
 * no MP is out of moves and full of swings — and a HUD showing only AP would
 * have him wondering why he could not walk.
 *
 * `3/6 AP` AND NOT `3 AP`: the denominator is what makes the number mean
 * something on the round a player has not memorised the maximum for, which is
 * every round for the first hour.
 */
function budgetWords(view: TurnBarView): string | null {
  const budget = view.budget;
  if (budget === undefined || budget === null) return null;
  if (budget.maxAp <= 0 && budget.maxMp <= 0) return null;
  const ap = `${String(Math.max(0, Math.floor(budget.ap)))}/${String(budget.maxAp)} AP`;
  const mp = `${String(Math.max(0, Math.floor(budget.mp)))}/${String(budget.maxMp)} MP`;
  return `${ap} · ${mp}`;
}

export function bannerFor(view: TurnBarView): string {
  const turn = view.turn;
  if (turn === null) return 'waiting for the server';

  const card = selfCard(turn);
  const owed = owedCount(turn);

  if (!turn.inCombat) {
    return card === null
      ? `turn ${turn.gameTurn} — free movement`
      : 'YOUR MOVE — free movement, nothing is hunting you';
  }
  if (card === null) return `IN COMBAT — turn ${turn.gameTurn} — waiting on ${owed}`;

  switch (card.state) {
    case TurnActorState.Bell: {
      // THE BELL IS THE ONE STATE WHERE THE CLOCK OUTRANKS THE BUDGET. A player
      // being counted down needs the seconds first and the arithmetic second.
      const left = budgetWords(view);
      return `YOUR MOVE — BELL ${String(bellSeconds(view.bellMs) ?? 0)}s${
        left === null ? '' : ` — ${left}`
      } — SPACE ends your turn`;
    }
    case TurnActorState.Waiting: {
      /**
       * NEVER "wait your turn". The party is phase-locked (DECISIONS.md D1):
       * everyone who owes a move can make it right now, and the others are
       * deciding beside you rather than ahead of you in a queue.
       *
       * ═══ THE ORDER OF THIS SENTENCE IS THE FIX ═══
       * It used to read "IN COMBAT — YOUR TURN — space: commit · . : hold — 2
       * still deciding", which answers "whose turn" and then lists keys. The
       * question a player actually has after acting once is *"can I do anything
       * else, or am I supposed to pass?"*, and nothing on screen answered it —
       * the round stays open while any action is still affordable, so acting
       * and being asked again looked like the game ignoring the input.
       *
       * So: whose move, WHAT IS LEFT, then how to end it. The keys come last
       * because they are the only part a player learns once.
       */
      const left = budgetWords(view);
      /**
       * `owedCount` COUNTS THE READER TOO, and the old sentence said "2 still
       * deciding" to a player who was one of the two. That is not wrong so much
       * as unhelpful: the number a player wants is how many people they are
       * keeping waiting, or being waited on by. So this subtracts the reader and
       * says "others", and says nothing at all when there are none.
       */
      const rest = Math.max(0, owed - 1);
      const others =
        rest === 0 ? '' : rest === 1 ? ' — 1 other deciding' : ` — ${String(rest)} others deciding`;
      return left === null
        ? `YOUR MOVE — SPACE ends your turn${others}`
        : `YOUR MOVE — ${left} left — SPACE ends your turn${others}`;
    }
    case TurnActorState.Committed:
      // "TURN OVER" AND NOT "committed", which is the engine's word rather than
      // the player's. This is the half of the answer that was hardest to see:
      // a player who has finished needs to KNOW they have finished, or they go
      // on pressing keys at a game that is waiting for somebody else.
      return owed === 0 ? 'TURN OVER — resolving' : `TURN OVER — waiting on ${String(owed)}`;
    case TurnActorState.StandingBy:
      return card.downed
        ? 'DOWN — you can still talk, and an ally can still reach you'
        : 'STANDING BY — any command puts you back in the turn order';
    case TurnActorState.Acting:
      // Never a player's state (protocol.ts: human actions resolve the instant
      // they arrive, so there is no window for a card to describe). Says
      // something true rather than falling through to a blank line.
      return 'IN COMBAT — resolving';
  }
}

/**
 * Paint the banner and the playfield frame.
 *
 * Wrapped in save/restore because it changes `font`, `textAlign` and
 * `textBaseline`, none of which the world painter sets before every call — a
 * leaked `textBaseline` would show up as a mysteriously shifted debug string
 * three milestones from now.
 */
export function drawTurnBar(options: TurnBarOptions): void {
  const { ctx, view, width, height } = options;
  const turn = view.turn;
  if (turn === null) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const yours = isYourTurn(view);

  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(0, 0, width, TURN_BAR_H);
  ctx.font = FONT_BOLD;
  ctx.fillStyle = yours ? PALETTE.GOLD : PALETTE.SILVER;
  /**
   * THE BANNER STARTS AFTER THE MENU BUTTON, which owns the left end of this
   * strip — see ui/menubutton.ts for why the top-left is the one corner nothing
   * else claims. The two share the row the way `drawResource` and `drawXpBar`
   * share theirs: a constant offset, so neither measures the other and neither
   * can move under the other's text.
   */
  const left = MENU_BUTTON_W + PAD;
  ctx.fillText(fitText(ctx, bannerFor(view), width - left - PAD), left, TURN_BAR_H / 2);

  // THE FRAME AROUND THE PLAYFIELD. Two concentric rings, one painter, and it
  // lives in ui/combatbanner.ts — see the long note there on why combat does not
  // simply recolour this one. Gold still means "the game is waiting on you" and
  // is the signal you catch out of the corner of your eye while looking at the
  // map rather than at the strip; the crimson ring outside it means the fight is
  // on, for as long as it is on, and is the persistent half of the answer to a
  // player who missed the banner.
  //
  // `top` is the whole top HUD, so the frame starts BELOW the card strip when
  // there is one. A frame drawn from `TURN_BAR_H` would put a crimson rail
  // across the middle of the cards, which is both ugly and a lie about where the
  // playfield begins.
  //
  // `inCombat` comes STRAIGHT OFF THE WIRE and is never derived from
  // `whoseTurn` being non-empty: that inference cannot tell the start of a fight
  // from one straggler still deciding, which is the bug this whole seam fixes.
  drawPlayfieldFrame({
    ctx,
    top: turnHudHeight(view),
    width,
    height,
    inCombat: turn.inCombat,
    yourTurn: yours,
  });

  ctx.restore();
}
