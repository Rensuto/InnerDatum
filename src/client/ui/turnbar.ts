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
 * TWO PER-ACTOR STRIPS HAVE NOW LIVED AT THE TOP OF THIS FILE'S SCREEN AND BOTH
 * ARE DELETED. THE PARTY PANE CARRIES THE TURN.
 * ===========================================================================
 * The first was a row of chips-and-names in THIS file. By M5 it was the SECOND
 * thing on screen drawing turn state — the party panel already had the people —
 * so it was replaced by a strip of portrait cards in a module of its own.
 *
 * That module then became the second surface itself, and on 2026-09-18 the
 * author ruled it out entirely: *"lets just go no cards at all, no turn order
 * indicator. it will also free up more space. we can use the 'Party' hud UI to
 * indicate that its the players turn, even when doing multiplayer."* So there is
 * no card, no order and no per-actor marker at the top of the screen at all. The
 * pane that already lists exactly the people a turn can be owed by says what
 * each of them owes — see `stateWord` in ui/partypanel.ts.
 *
 * `chipFor` went with the first strip, and that is the half worth remembering.
 * It derived the barrier's precedence — Standing By outranks a commit, a commit
 * outranks the Bell — in the BROWSER, from three id arrays, which was a second
 * implementation of rules that live in src/server/engine/barrier.ts. It also
 * could not express the case that matters most: a Downed detective is in neither
 * `whoseTurn` nor `standingBy`, so the old lookup fell through to "committed"
 * and told the party that the person bleeding out on the floor had taken their
 * turn. `TurnActor.state` is sent per actor and is the only answer anything
 * reads — here, and on every party row.
 *
 * WHAT IS LEFT HERE IS THE PROSE AND THE BORDER, and both are deliberate. The
 * sentence is the copy a screen reader can be given and the one people quote at
 * each other in voice; the frame is what you catch out of the corner of your eye
 * while looking at the map rather than at the HUD. The party row is the third
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

import { TurnActorKind, TurnActorState } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { MENU_BUTTON_W } from './menubutton.ts';
import { drawPlayfieldFrame } from './combatbanner.ts';
import { fitText } from './panel.ts';
import type { TurnActor, TurnMsg } from '../../shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING THE TOP HUD NEEDS OF A `turn` FRAME, assembled by main.ts once per
 * frame.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * IT USED TO LIVE IN THE CARD STRIP'S OWN MODULE, because the banner and the
 * cards had to describe the same instant and two view types is two chances for
 * main.ts to build one from a `turn` frame and the other from the previous one.
 * That module is deleted; the type MOVED here rather than being re-declared, so
 * nothing about what the banner reads changed on the way.
 *
 * `bellMs` is NOT read from `turn.bellMs`. The server sends the milliseconds
 * remaining at the instant it sent the frame, and a countdown that only moves
 * when a packet arrives is not a countdown — main.ts holds the deadline and
 * ticks it locally, and hands the current value in here.
 *
 * There is deliberately no `selfId` and no actor list. `TurnActor.isSelf` is the
 * server's answer to "which one is you" (protocol.ts: that flag is the reason
 * `turn` is unicast), and every name and hp value anything here needs is on the
 * record. A join against the actor map would be a second source for facts the
 * frame already carries.
 */
export type TurnView = {
  /** Null until the first `turn` frame; nothing is drawn. */
  readonly turn: TurnMsg | null;
  /** Milliseconds left on the Bell, ticked locally. Null when none is running. */
  readonly bellMs: number | null;
};

/**
 * The name main.ts and this file's own signatures already speak. Kept as an
 * alias rather than renamed at thirty call sites, and it is the SAME type — the
 * banner and every other reader of a `turn` frame must never be built from two
 * different frames, and one type is how that is enforced rather than remembered.
 */
export type TurnBarView = TurnView;

/**
 * WHICH RECORD IS YOU, or null.
 *
 * Straight off the server's flag, never a comparison against a local `selfId`.
 * A spectating or bodiless socket genuinely has no record, and "nobody is
 * highlighted" has to be a fact the server states rather than a comparison that
 * happens to fail — see the note on `TurnActor.isSelf`.
 */
export function selfCard(turn: TurnMsg | null): TurnActor | null {
  if (turn === null) return null;
  return turn.actors.find((actor) => actor.isSelf) ?? null;
}

/**
 * HOW MANY PEOPLE STILL OWE A DECISION.
 *
 * Counted off `actors`, which is the authoritative per-actor state, so this
 * number and the party pane's own words can never disagree. The old
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
  for (const actor of turn.actors) {
    if (actor.kind !== TurnActorKind.Player) continue;
    if (actor.state === TurnActorState.Waiting || actor.state === TurnActorState.Bell) owed += 1;
  }
  return owed;
}

/**
 * Whole seconds, rounded up, so a live Bell never displays 0 while it runs.
 *
 * EXPORTED FOR ITS TEST AND FOR NO OTHER CALLER, deliberately, and `check:inert`
 * will list it as over-exported for exactly that reason. It had a second caller
 * while the turn card strip printed the digits on the straggler's card; the
 * strip is deleted and `bannerFor` below is the only one left. The rounding is
 * the rule — a countdown that reads 0 for the last 999 ms has already lied about
 * the deadline once per turn — and a rule worth stating is worth asserting
 * directly rather than through the sentence it happens to appear in.
 */
export function bellSeconds(bellMs: number | null): number | null {
  return bellMs === null ? null : Math.max(0, Math.ceil(bellMs / 1000));
}

export type TurnBarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: TurnBarView;
  /** Logical backbuffer size, in world pixels — not device pixels. */
  readonly width: number;
  readonly height: number;
};

const PAD = 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE TOP HUD. ONE LINE OF PROSE, 14 PIXELS, IN COMBAT AND OUT OF IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It was 44 — a 30px chip column plus this line — then 14 out of combat and 60
 * in it, because the card strip under this bar spent another 46 whenever there
 * was a fight on. It is 14 unconditionally now: the cards are deleted and the
 * party pane carries what they carried.
 *
 * THAT IS THE MEASURED HALF OF THE DELETION AND IT IS WHY THIS IS A CONSTANT
 * AGAIN. `turnHudHeight(view)` used to sit here, a function precisely because
 * the number moved when a monster joined the initiative — and everything that
 * derives from it moved too. `panelBand.top` was 17 walking around and 63 in a
 * fight; the log's own band jumped under it so hard that `quietLogBand` existed
 * to stop the box ratcheting smaller every time somebody walked into a room.
 * Stacking is arithmetic against this one number now, so a band cannot move
 * because of something that happened in the world.
 */
export const TURN_BAR_H = 14;

const FONT_BOLD = 'bold 10px ui-monospace, Consolas, monospace';

/**
 * THE question. True when the game is waiting on this client.
 *
 * Read off `TurnActor.state`, which the server decides, so this cannot disagree
 * with the party pane about whether you owe a move.
 *
 * OUT OF COMBAT THE ANSWER IS STILL YES, and the special case is honest rather
 * than convenient: with `engagement === 0` nobody blocks, so the projector marks
 * every card `committed` — a true statement about the BARRIER and the opposite
 * of the truth about the PLAYER, who may act freely. A socket with no card of
 * its own (a spectator, a body still being assigned) is never "your turn".
 *
 * IN A FIGHT IT IS `current`, AND OWING A DECISION IS NOT ENOUGH. A party takes
 * its turns one at a time (protocol.ts `TurnMsg.current`), so a player later in
 * line owes a decision while somebody else is taking theirs.
 */
export function isYourTurn(view: TurnBarView): boolean {
  const turn = view.turn;
  if (turn === null) return false;
  const card = selfCard(turn);
  if (card === null) return false;
  if (!turn.inCombat) return true;
  return turn.current === card.id;
}

/** The name on the card whose turn it is, or null when nobody's is. */
function currentName(turn: TurnMsg): string | null {
  if (turn.current === null) return null;
  return turn.actors.find((actor) => actor.id === turn.current)?.name ?? null;
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
 * server decides every party row's state from, so the sentence and the pane can
 * never disagree about how many people the party is waiting on.
 *
 * Exhaustive over `TurnActorState` with no `default`, so a sixth state cannot
 * ship without words.
 */
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
  const who = currentName(turn);
  if (card === null) {
    return who === null ? `IN COMBAT — turn ${turn.gameTurn}` : `IN COMBAT — ${who}'s turn`;
  }

  switch (card.state) {
    case TurnActorState.Bell:
      // The table is waiting on you and the clock is running. One action ends
      // your turn, so there is nothing else to say but how long you have.
      return `YOUR TURN — BELL ${String(bellSeconds(view.bellMs) ?? 0)}s`;
    case TurnActorState.Waiting: {
      // IN LINE. You owe a decision, and somebody before you is taking theirs;
      // a move sent now waits for your slot.
      if (turn.current !== null && turn.current !== card.id) {
        return `IN LINE — ${who ?? 'somebody'}'s turn`;
      }
      /**
       * ═══ ONE ACTION ENDS YOUR TURN, SO THE BANNER NAMES NO KEY ═══
       * This read "YOUR MOVE — 3/6 AP · 2/3 MP left — SPACE ends your turn",
       * and the Space was the complaint: the round stayed open after a step
       * or a talent, so a player had to pass after every action. It no longer
       * does (`actPlayer`, as ToME's `useEnergy`), and a banner that still named
       * a key to end the turn would teach the habit that now wastes one.
       *
       * `owedCount` counts the reader too, so this subtracts them and says how
       * many OTHERS are still deciding, and nothing when there are none.
       */
      const rest = Math.max(0, owed - 1);
      const others =
        rest === 0 ? '' : rest === 1 ? ' — 1 after you' : ` — ${String(rest)} after you`;
      return `YOUR TURN${others}`;
    }
    case TurnActorState.Committed:
      // "TURN OVER" AND NOT "committed", which is the engine's word rather than
      // the player's. This is the half of the answer that was hardest to see:
      // a player who has finished needs to KNOW they have finished, or they go
      // on pressing keys at a game that is waiting for somebody else. And it
      // says WHO, because the turns go one at a time now.
      return who === null ? 'TURN OVER — resolving' : `TURN OVER — waiting on ${who}`;
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
  // map rather than at the bar; the crimson ring outside it means the fight is
  // on, for as long as it is on, and is the persistent half of the answer to a
  // player who missed the banner.
  //
  // `top` IS `TURN_BAR_H` NOW AND THAT IS THE WHOLE TOP HUD. It used to be
  // `turnHudHeight(view)`, which added the card strip's 46 pixels while a fight
  // was on, because a frame drawn from `TURN_BAR_H` would have put a crimson
  // rail across the middle of the cards. There are no cards, so the playfield
  // begins directly under this one line of prose — in combat and out of it.
  //
  // `inCombat` comes STRAIGHT OFF THE WIRE and is never derived from
  // `whoseTurn` being non-empty: that inference cannot tell the start of a fight
  // from one straggler still deciding, which is the bug this whole seam fixes.
  drawPlayfieldFrame({
    ctx,
    top: TURN_BAR_H,
    width,
    height,
    inCombat: turn.inCombat,
    yourTurn: yours,
  });

  ctx.restore();
}
