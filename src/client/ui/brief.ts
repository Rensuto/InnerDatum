// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/modules/tome/class/Player.lua:234 — an objective belongs to a floor
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE STRIP — WHAT THIS PARTY TOOK ON, IN ITS OWN WORDS, IN TEXT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One line, centred under the turn bar, drawn only while there is an OPEN
 * objective on the floor this party is standing on. Upstream's equivalent is
 * two lines in the player display; ours is a band because this HUD has no
 * permanent sidebar to put it in.
 *
 * ═══ THREE RULES, ALL OF THEM OLDER THAN THIS FILE ═══
 *
 *   IT CARRIES ITS INFORMATION IN TEXT. `ui/combatbanner.ts` states the rule
 *   for every persistent cue here: *"a transition that is only ever announced
 *   is a transition that is missed"*, and the converse — a state carried by a
 *   colour alone is a state somebody colour-blind, or simply not looking, never
 *   learns. The strip says the words. The Case Log keeps the durable copy.
 *
 *   NO FLAVOUR ON A PERSISTENT SURFACE. It shows the objective's own title and
 *   its count, and nothing else. A sentence of mood read four hundred times in
 *   an evening is furniture, and furniture is what the eye stops reading.
 *
 *   THE PLAYER NEVER SEES A SYSTEM WORD. "Brief" is an engineering word, like
 *   Record and Margin, and it never reaches the canvas: the strip is the
 *   objective's own words or it is nothing.
 *
 * ═══ A PILL, NOT A FULL-WIDTH STRIP, AND THAT IS A COLLISION ARGUMENT ═══
 * `drawLine` in main.ts paints an opaque band across the whole playfield, which
 * is correct for a transient notice and wrong for something that is on screen
 * for the length of a floor: at the top of the map it would paint over the
 * minimap's first rows for the whole time the objective is open. Sized to its
 * own text, it sits in the one place nothing else is docked.
 */

import { PALETTE } from '../render/canvas.ts';
import { fitText } from './panel.ts';
import type { JournalQuestView } from './escapemenu.ts';
import type { BriefView } from '../../shared/protocol.ts';

/** The pill's height. One line of HUD prose, the same as the notice's. */
export const BRIEF_STRIP_H = 14;

/** Ink either side of the words, so the pill is not a box drawn on the letters. */
const PAD_PX = 7;

/**
 * THE ONE STATE THAT IS DRAWN, and it is a string comparison rather than an
 * import of the server's union: the wire carries `BriefState` verbatim, and
 * `src/client/` may not reach into `src/server/`.
 *
 * WORK THAT HAS ENDED IS NOT WORK IN PROGRESS. A closed or failed objective
 * leaves a Case Log line and takes its strip with it, because a band that
 * lingers after the fact is the same lie as a stale notice — and the server
 * sends the ending state rather than silence precisely so this client can tell
 * "it is over" from "the frame never arrived".
 */
const OPEN = 'open';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME OBJECTIVE, AS THE JOURNAL'S `QUESTS` SECTION NEEDS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE PLACE TO LOOK, WHICH IS WHY THIS IS HERE AND NOT A SECOND PANEL. The
 * Journal's QUESTS section was written and shipped EMPTY, ahead of anything that
 * could fill it, for exactly this: an objective that grew a surface of its own
 * would give a player two places to check what they had agreed to, and the two
 * would disagree the first time either moved. The strip is the glance; the
 * Journal is the page you open to read it properly. They are one frame.
 *
 * ═══ THE STATUS WORD IS UPSTREAM'S, AND THE RECONCILIATION IS OURS ═══
 * `ui/escapemenu.ts#JournalQuestView` says the status *"IS A WORD, ALREADY
 * CHOSEN BY WHOEVER PRODUCES THE LIST"*, names upstream's four
 * (`engine/Quest.lua:31-36` — `active`, `completed`, `done`, `failed`) and
 * states that reconciling them with a server's own states belongs to the lane
 * that ships them. This is that lane and this is that reconciliation:
 *
 *   open    -> `active`     PENDING, `engine/Quest.lua:26`
 *   closed  -> `done`       DONE, `:28` — our close pays at once, so upstream's
 *                           COMPLETED/DONE two-step collapses into one
 *   failed  -> `failed`     FAILED, `:29`
 *
 * `offered` HAS NO ROW AT ALL and cannot reach this function: the server does
 * not send an un-accepted objective to anybody, because an offer nobody took is
 * not something this character has agreed to do. That is the same sentence the
 * empty state is written in — *"work you take on is listed here"*.
 *
 * ═══ A CONSTANT KEY, BECAUSE THERE IS AT MOST ONE ═══
 * `JournalQuestView.id` is *"carried and not drawn"*, for a fold to open by and
 * for a list to be keyed on. A floor carries one optional objective by
 * construction (`Realm.brief` is a single field, and that constraint is the
 * mechanism that stops this becoming a quest log), so the key is a constant
 * rather than a field invented on the wire to hold a string that could only ever
 * have one value.
 */
export function briefQuestRows(brief: BriefView | null): readonly JournalQuestView[] {
  if (brief === null || brief.state === OFFERED) return [];
  const status = QUEST_STATUS[brief.state] ?? brief.state;
  const name = brief.progress === undefined ? brief.title : briefStripText(brief);
  return [{ id: BRIEF_ROW_ID, name, status }];
}

/** See `briefQuestRows`. */
const BRIEF_ROW_ID = 'brief';
const OFFERED = 'offered';
const QUEST_STATUS: Readonly<Record<string, string>> = {
  open: 'active',
  closed: 'done',
  failed: 'failed',
};

/** Is there an objective to draw at all? Exported because main.ts asks it too. */
export function briefOnScreen(brief: BriefView | null): boolean {
  return brief !== null && brief.state === OPEN;
}

/**
 * The words, in reading order: what it is, then how far in you are.
 *
 * A MIDDLE DOT RATHER THAN A SECOND LINE. The count is a qualifier on the
 * title, not a fact of its own, and two bands stacked at the top of the map is
 * the beginning of a quest log.
 */
export function briefStripText(brief: BriefView): string {
  return brief.progress === undefined ? brief.title : `${brief.title} · ${brief.progress}`;
}

/**
 * Draw it, centred on `width`, with its top edge at `top`. Nothing at all when
 * there is no open objective — which is most of the game.
 */
export function drawBriefStrip(
  ctx: CanvasRenderingContext2D,
  brief: BriefView | null,
  width: number,
  top: number,
): void {
  if (!briefOnScreen(brief) || brief === null) return;
  ctx.save();
  ctx.font = 'bold 10px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // HALF THE SCREEN AT MOST. A long title truncates with an ellipsis rather
  // than growing a pill that reaches the minimap on one side and the party
  // pane on the other.
  const text = fitText(ctx, briefStripText(brief), Math.max(0, width / 2 - PAD_PX * 2));
  if (text === '') {
    ctx.restore();
    return;
  }
  const w = Math.ceil(ctx.measureText(text).width) + PAD_PX * 2;
  const x = Math.floor((width - w) / 2);
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(x, top, w, BRIEF_STRIP_H);
  // PARCHMENT, WHICH IS THIS HUD'S WORD FOR "SOMETHING WRITTEN DOWN". Gold is
  // spent on "the game is waiting on you" and crimson on "the fight is on";
  // an objective is neither, and borrowing either colour would cost the one
  // that owns it.
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(text, Math.floor(width / 2), top + BRIEF_STRIP_H / 2);
  ctx.restore();
}
