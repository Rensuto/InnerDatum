// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Zone.lua:118, :141-148.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                 HOW DANGEROUS A PLACE IS, AND WHO DECIDES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two schemes and no third, because upstream has two and fifteen years of
 * content fits inside them (`Zone.lua:118`, `:141-148`). Every room in this
 * game was implicitly the FIRST one at a level of 1 — nothing ever passed a
 * level to `monsterInit`, so a husk at the far end of the road had the
 * twenty-five hit points of the husk in the tutorial room.
 *
 * ═══ WHY THE SCHEME IS A PROPERTY OF THE PLACE ═══
 * Which of the two a room uses is a design statement about that room, and
 * getting it backwards ruins the room in a way no amount of tuning fixes:
 *
 *   FIXED    A place is as dangerous as it is, and deciding whether you are
 *            ready for it is the game. This is every delve. It is what makes
 *            the walk you could not survive last week worth taking now — the
 *            single clearest reward this map offers, and one that scaling
 *            silently deletes by making every fight the same fight.
 *
 *   PLAYER   The room came to YOU, so it arrives at your level. This is the
 *            overworld ambush and upstream marks its own the same way —
 *            `dreadfell-ambush/zone.lua` is `level_scheme = "player"`. An
 *            ambush you cannot lose is scenery, and one you cannot survive is
 *            a death you did not choose. Neither is a fight.
 *
 * The clamp is what keeps `player` honest: a range of `[1, 50]` follows the
 * party the whole way, and a narrower one says "this stops being a threat
 * eventually", which is a thing content should be able to say.
 */

/** Upstream's `level_scheme`, with upstream's own default first. */
export const ZoneLevelScheme = {
  /** `base_level = level_range[1]`. The default, upstream and here. */
  Fixed: 'fixed',
  /** `base_level = bound(player.level, range[0], range[1])`. */
  Player: 'player',
} as const;

export type ZoneLevelScheme = (typeof ZoneLevelScheme)[keyof typeof ZoneLevelScheme];

/** Lowest and highest level a zone will state, inclusive. */
export type ZoneLevelRange = readonly [number, number];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `Zone:updateBaseLevel` — Zone.lua:141-148, four lines and all four of them.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE, AND TAKES THE PLAYER LEVEL RATHER THAN READING IT. Upstream reaches
 * for `game:getPlayer().level` from inside the method; this file may not touch
 * a global and should not — a room's level is a function of its own two fields
 * and one number about whoever is walking in, and writing that out means the
 * party-of-six question ("whose level?") has to be answered by the caller,
 * where the party actually is. See `partyMaxLevel`.
 *
 * THE FLOOR OF 1 IS OURS, not upstream's. `bound` would happily return 0 from a
 * range somebody typed wrong, and a level-0 body divides through the life curve
 * as a body that never levelled — which is a silently harmless-looking monster
 * rather than a crash. One line here beats finding that in play.
 */
export function zoneBaseLevel(
  range: ZoneLevelRange,
  scheme: ZoneLevelScheme,
  playerLevel: number,
): number {
  const low = Math.max(1, Math.floor(range[0]));
  const high = Math.max(low, Math.floor(range[1]));
  if (scheme !== ZoneLevelScheme.Player) return low;
  return Math.min(high, Math.max(low, Math.floor(playerLevel)));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE PLACE FEELS WHEN YOU WALK IN — `Game.lua:1338-1353`, exactly.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream compares the level of the area against the player's and prints one
 * of four sentences, or nothing. The BANDS ARE PORTED VERBATIM because they are
 * the tuning: `>= 5`, `>= 2`, `>= -2`, `>= -5`, and below.
 *
 * ═══ THE SILENT BAND IS THE FEATURE ═══
 * `diff >= -2` returns nothing at all upstream, and that is not an omission to
 * be tidied up. A line on every single entrance is furniture and stops being
 * read — the same argument `input/explore.ts` makes about a permanent legend —
 * and the whole value of the four sentences is that they only appear when the
 * answer is INTERESTING. A room within two levels of you is the ordinary case,
 * and the honest thing to say about it is nothing.
 *
 * ═══ IT IS A WARNING, AND THEREFORE IT IS PER-PLAYER ═══
 * Upstream is single-player, so "the player's level" is unambiguous there. Here
 * six people walk through the same door with six different levels, and the
 * sentence is addressed to ONE of them: a level-3 Watchman and a level-12
 * Inspector entering the same delve are owed different sentences, and telling
 * the room either one would be wrong for somebody. See the caller.
 *
 * ═══ THE WORDS ARE OURS, THE MEANING IS THEIRS ═══
 * Upstream's read "You feel a thrill of terror and your heart begins to pound
 * in your chest" — a fantasy adventurer's interior. The Record lane is a
 * detective's case file written in the third person and the fiction's own
 * vocabulary, so the sentences are rewritten to that voice and the RULE is
 * untouched. Each still says the same two things upstream's does: how far out
 * of your depth you are, and in which direction.
 */
export const LevelFeeling = {
  /** `diff >= 5`. Upstream: "terribly threatened upon entering this area." */
  Terror: 'terror',
  /** `diff >= 2`. Upstream: "mildly anxious, and walk with caution." */
  Wary: 'wary',
  /** `diff >= -2`. Upstream says NOTHING here, and neither do we. */
  Even: 'even',
  /** `diff >= -5`. Upstream: "very confident walking into this place." */
  Confident: 'confident',
  /** Below that. Upstream: "stifling a yawn... time might be better spent". */
  Bored: 'bored',
} as const;
export type LevelFeeling = (typeof LevelFeeling)[keyof typeof LevelFeeling];

/**
 * Which band a body walking in falls into. `Game.lua:1345-1351`.
 *
 * TAKES THE TWO LEVELS RATHER THAN THE DIFFERENCE, so no caller can compute the
 * subtraction the wrong way round — which is the one mistake here that produces
 * a confident sentence about a room that is about to kill somebody.
 */
export function levelFeeling(areaLevel: number, bodyLevel: number): LevelFeeling {
  const diff = Math.floor(areaLevel) - Math.floor(bodyLevel);
  if (diff >= 5) return LevelFeeling.Terror;
  if (diff >= 2) return LevelFeeling.Wary;
  if (diff >= -2) return LevelFeeling.Even;
  if (diff >= -5) return LevelFeeling.Confident;
  return LevelFeeling.Bored;
}

/**
 * The sentence, or null for the band that says nothing.
 *
 * NULL RATHER THAN AN EMPTY STRING, so a caller cannot print a blank line by
 * forgetting to check — the silent band is the common case and the easiest to
 * get wrong.
 */
export function levelFeelingText(feeling: LevelFeeling): string | null {
  switch (feeling) {
    case LevelFeeling.Terror:
      return 'Nothing here is filed under anything you have read. This is far past you.';
    case LevelFeeling.Wary:
      return 'The paperwork here is heavier than yours. Walk carefully.';
    case LevelFeeling.Even:
      return null;
    case LevelFeeling.Confident:
      return 'You have closed worse than this. It should not hold you long.';
    case LevelFeeling.Bored:
      return 'There is nothing here you have not already filed twice. Your time is worth more elsewhere.';
  }
}
