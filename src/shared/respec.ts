// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:4773-4783 (lastLearntTalentsMax, capLastLearntTalents)
//              t-engine4 game/modules/tome/dialogs/LevelupDialog.lua:343-360 (isUnlearnable)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        A TAKE-BACK WINDOW ON THE LAST FEW POINTS YOU SPENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One mis-clicked `+` was permanent. In a game where three friends are waiting
 * in a voice channel, that is not a hardcore rule — it is the reason nobody
 * reads a talent's description properly and nobody experiments at all: the cost
 * of a mistake is the character, and the cost of taking thirty seconds to be
 * sure is everyone's evening.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S SHAPE, WHICH IS A WINDOW AND NOT AN UNDO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Actor.lua:4773-4783
 * function _M:lastLearntTalentsMax(what)
 *   return what == "generic" and 3 or 4
 * end
 * function _M:capLastLearntTalents(what)
 *   local list = self.last_learnt_talents[what]
 *   while #list > max do table.remove(list, 1) end
 * end
 * ```
 *
 * A ROLLING LIST, OLDEST FIRST, TRIMMED FROM THE FRONT. Four class spends, three
 * generic. So you can always undo the thing you just did, and you can never
 * unwind a build — which is the whole balance of the feature and the reason it
 * is not simply "refund anything in town".
 *
 * ═══ IN `shared/` BECAUSE BOTH SIDES HAVE TO AGREE ═══
 * The server decides whether an unlearn is legal. The client decides whether to
 * DRAW the affordance, and a panel that offers a `−` the server will refuse is
 * worse than no `−` at all — it reads as a broken button rather than as a rule.
 * One answer, imported by both, is the only way those cannot drift.
 *
 * PURE: no clock, no RNG, no I/O. `src/shared/` forbids all three.
 */

/**
 * How many spends stay unwindable, per purse.
 *
 * FOUR AND THREE ARE UPSTREAM'S, and the asymmetry is upstream's too. It is not
 * arbitrary: generic points arrive on a different and scarcer schedule, so the
 * same window in both would make the generic one proportionally far more
 * forgiving. Kept verbatim rather than rounded to one number, for the reason
 * this project keeps a `docs/tome-port.md` at all — fifteen years of tuning is
 * the asset, and the places it looks untidy are usually where it was earned.
 */
export const RESPEC_WINDOW = Object.freeze({ class: 4, generic: 3 });

/** Which purse a spend came out of. The tree id's namespace decides it. */
export type Purse = keyof typeof RESPEC_WINDOW;

/**
 * Push a spend onto the ledger, trimming the oldest past the cap.
 *
 * RETURNS A NEW ARRAY rather than splicing in place. The caller assigns it, so
 * a body's ledger is replaced wholesale — which means nothing can hold a stale
 * reference to a list that has since been trimmed, and it keeps this function
 * honest about `src/shared/` purity.
 *
 * THE SAME ID MAY APPEAR MORE THAN ONCE. It is a ledger of SPENDS, not of
 * talents: three ranks of Iron Curtain are three entries, and each unlearn
 * takes one rank back. Deduplicating would make the second rank of anything
 * permanently unrefundable while the first stayed open, which is a rule nobody
 * could predict.
 */
export function noteSpend(ledger: readonly string[], talentId: string, purse: Purse): string[] {
  const next = [...ledger, talentId];
  const max = RESPEC_WINDOW[purse];
  // FROM THE FRONT — `table.remove(list, 1)`. Dropping from the back would
  // discard the spend that was just made, which is the one thing a player is
  // most likely to want back.
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Is this talent inside the window — and if so, at which entry?
 *
 * SEARCHED FROM THE BACK, which is `for i = #list, min, -1` upstream, so a
 * talent bought twice answers with its MOST RECENT entry. Taking the oldest
 * would refund a rank the player bought long ago and leave the fresh one
 * stranded, and the two are indistinguishable to everything downstream.
 *
 * @returns the index into `ledger`, or -1 when this talent is not in the window.
 */
export function unlearnableAt(ledger: readonly string[], talentId: string): number {
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    if (ledger[i] === talentId) return i;
  }
  return -1;
}

/** Take one entry out. The caller has already decided it may. */
export function dropSpend(ledger: readonly string[], index: number): string[] {
  if (index < 0 || index >= ledger.length) return [...ledger];
  return [...ledger.slice(0, index), ...ledger.slice(index + 1)];
}
