// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/load.lua:181-188 — `ActorStats:defineStat`,
//          which is where each stat's long name is bound to its three-letter key.
//          t-engine4 game/engines/default/engine/interface/ActorTalents.lua:769
//          — `("- %s %d"):format(self.stats_def[s].name, v)`, the requirement
//          line a player reads, which prints the NAME and not the key.
// NUMBERS: NONE. This is seven names and nothing else; the ladder that uses them
//          is in tiers.ts and deliberately does not port upstream's constants.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STAT AS A PLAYER NAMES IT, NOT AS THE ENGINE KEYS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.statGate` is authored as upstream's three-letter key — `'wil'` — and
 * that is the right thing to author: it is what every table in the engine is
 * keyed by, and it is what ToME itself passes around internally
 * (`engine/interface/ActorTalents.lua:701` answers its own caller with
 * `"not enough stat: "..s:upper()`).
 *
 * IT IS NOT WHAT A PLAYER READS. The requirement listing spells it out —
 * `engine/interface/ActorTalents.lua:769` formats `("- %s %d"):format(self.stats_def[s].name, v)`
 * — and `tome/load.lua:181-188` is where those names are defined:
 *
 *     ActorStats:defineStat("Willpower", "wil", 10, 1, 100, ...)
 *
 * Ours printed the key. A talent's requirement read `20 wil (18)` and its
 * refusal read `Needs 20 wil; you have 18.` — database identifiers, in the one
 * place in this game where a talent already names a stat at all.
 *
 * ═══ IN `shared/` BECAUSE BOTH SIDES NEED IT AND ONLY ONE MAY OWN IT ═══
 * The names existed already, in `ui/talents.ts`'s `STAT_ROWS`, which is client
 * code — and `shared ← client` is the forbidden direction, so the sentences
 * composed in `shared/tiers.ts` could not reach them. This is the module both
 * may import.
 *
 * ═══ `Record<string, string>` RATHER THAN `as const` ═══
 * `TierRequirement.stat` is a plain `string`, and indexing a const-literal
 * object with one does not compile under `strict`. `noUncheckedIndexedAccess`
 * is on, so every read is `string | undefined` and callers must say what an
 * unknown key reads as.
 */
export const STAT_NAMES: Record<string, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  mag: 'Magic',
  wil: 'Willpower',
  cun: 'Cunning',
  con: 'Constitution',
  /**
   * PRESENT THOUGH NOTHING GATES ON IT. `PrimaryStats` admits `lck` and pins it
   * at 50 unless something deliberately unpins it, so the type allows a talent
   * to gate on luck even though none does. A table that omitted it would print
   * the key for exactly that talent, on the day somebody wrote it.
   */
  lck: 'Luck',
};

/**
 * A stat key -> the name to print, or the key itself if it is not one of the
 * seven.
 *
 * FALLS BACK TO THE KEY rather than to a word like "aptitude": an unknown key
 * is a bug, and printing it is what makes the bug findable. Substituting prose
 * for it would hide which stat the server actually meant.
 */
export function statName(key: string | undefined): string {
  if (key === undefined) return 'aptitude';
  return STAT_NAMES[key] ?? key;
}
