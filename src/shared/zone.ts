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
