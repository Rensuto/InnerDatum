// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:1740-1752 (getRankLifeAdjust)
//                                                       :3818-3822 (the level-up life gain)
//                                                       :3884-3885 (Constitution to life)
//                                                       :187       (life_rating default)
//             t-engine4 game/modules/tome/class/Player.lua:70 (fixed_rating), :77 (rank 3)
//             t-engine4 game/modules/tome/data/birth/descriptors.lua:61 (no_auto_saves)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW A BODY GETS TOUGHER. THE ONE NUMBER A LEVEL MOVES ON ITS OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE HOLE THIS FILLS, MEASURED ═══
 * `maxHp` was an authored constant per class — 72 / 60 / 54 — written into the
 * body once at creation and never touched again. A level-50 Watchman had the
 * same seventy-two hit points he had at level 1, while upstream's nearest
 * analogue is around 1,492. The cap moved to 50 and nothing about a character's
 * durability moved with it.
 *
 * ═══ AND THE QUIETER HALF: CONSTITUTION BOUGHT NOTHING ═══
 * Upstream pays +4 max life per point of CON (Actor.lua:3884-3885). Here it fed
 * one physical save and nothing else, so of the 157 attribute points a career
 * now grants, every one spent on Constitution was close to dead currency — a
 * stat the character sheet invites you to raise and the game declines to reward.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT UPSTREAM DOES *NOT* DO, WHICH MATTERS MORE THAN WHAT IT DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A player's accuracy, defence, armour, crit and saves gain NOTHING from a
 * level. The birth descriptor switches both automatic channels off by name:
 *
 *     no_auto_resists = true, no_auto_saves = true    -- descriptors.lua:61
 *
 * Only MONSTERS get automatic saves and resists as they level. For a player, hit
 * points are the single number that rises without them choosing where — every
 * other combat value moves through a stat point, a talent point, or a piece of
 * gear.
 *
 * That asymmetry is the design and it is easy to "improve" by accident. Adding a
 * per-level accuracy drip would look like fidelity and would quietly remove the
 * reason to spend a point on Dexterity.
 */

import { ActorRank } from './protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RANK LADDER. Actor.lua:1740-1752, transcribed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     local level_adjust = 1 + self.level / 40
 *     rank 1   -> value * (level_adjust - 0.2)
 *     rank 2   -> value * (level_adjust - 0.1)
 *     rank 3   -> value * (level_adjust + 0.1)
 *     rank 3.2 -> value * (level_adjust + 0.15)
 *     rank 3.5 -> value * (level_adjust + 1)
 *     rank 4   -> value * (level_adjust + 2)
 *     rank 5   -> value * (level_adjust + 3)
 *     rank>=10 -> value * (level_adjust + 6)
 *
 * A NUMERIC LADDER AGAINST OUR THREE WORDS. Upstream's ranks are numbers because
 * it has eight of them; ours is a three-member union because the game has three
 * kinds of thing in it. The mapping below is the whole of the translation, and
 * it is a table rather than a `switch` so that adding a fourth word is one line
 * in one place.
 *
 * A PLAYER IS RANK 3 — Player.lua:77, `t.rank = t.rank or 3`. Not a choice we
 * are making; it is what upstream's own player is, and it is why a player's
 * life gain sits between a normal monster's and an elite's.
 */
export const PLAYER_RANK = 3;

export const RANK_VALUE: Readonly<Record<ActorRank, number>> = {
  /** Upstream's rank 2 — the ordinary body a zone is full of. */
  [ActorRank.Normal]: 2,
  /**
   * Upstream's 3.5, its "unique" tier. Not 4: rank 4 is a BOSS there, and using
   * it here would make our elites tougher than our bosses at every level.
   */
  [ActorRank.Elite]: 3.5,
  /** Upstream's rank 4. */
  [ActorRank.Boss]: 4,
};

/**
 * The rank coefficient at a level. Exported because the monster path and the
 * player path must not compute it twice — see M-002.
 */
export function rankLifeAdjust(value: number, level: number, rank: number): number {
  const levelAdjust = 1 + level / 40;
  if (rank <= 1) return value * (levelAdjust - 0.2);
  if (rank <= 2) return value * (levelAdjust - 0.1);
  if (rank <= 3) return value * (levelAdjust + 0.1);
  if (rank <= 3.2) return value * (levelAdjust + 0.15);
  if (rank <= 3.5) return value * (levelAdjust + 1);
  if (rank <= 4) return value * (levelAdjust + 2);
  if (rank < 10) return value * (levelAdjust + 3);
  return value * (levelAdjust + 6);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONE LEVEL IS WORTH IN HIT POINTS. Actor.lua:3818-3822.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     local rating = self.life_rating
 *     if not self.fixed_rating then
 *         rating = rng.range(floor(life_rating * 0.5), floor(life_rating * 1.5))
 *     end
 *     self.max_life = self.max_life + math.max(self:getRankLifeAdjust(rating), 1)
 *
 * ═══ NO DICE, AND THAT IS UPSTREAM'S OWN CHOICE FOR PLAYERS ═══
 * The `rng.range` branch is skipped entirely for a player, because Player.lua:70
 * sets `fixed_rating = true`. Two characters of the same class and level have
 * exactly the same hit points, and a level-up cannot roll badly.
 *
 * It matters doubly here: `src/shared/` is pure and may not touch an RNG at all
 * (CLAUDE.md § 3). Had upstream rolled for players, this function could not have
 * lived in this file — the deterministic branch is the one we need AND the one
 * upstream uses.
 *
 * `level` IS THE NEW LEVEL. ActorLevel.lua:100-102 increments before calling
 * `levelup()`, so the gain for reaching level 2 uses 2. An off-by-one here is
 * invisible at level 2 and worth roughly a level's hit points at 50.
 *
 * THE FLOOR OF 1 is upstream's, and it is what stops a low-rated body at a low
 * level gaining nothing at all.
 */
export function lifeGainForLevel(lifeRating: number, level: number, rank: number): number {
  if (level <= 1) return 0;
  return Math.max(rankLifeAdjust(lifeRating, level, rank), 1);
}

/**
 * Every hit point a body of this level has been granted by levelling, summed.
 *
 * A LOOP RATHER THAN THE CLOSED FORM, for the reason `totalPointsAtLevel` gives
 * about itself: the closed form silently stops agreeing the moment the per-level
 * function grows a clause, and this is fifty iterations at most.
 *
 * The cumulative multiplier on `lifeRating` for a rank-3 player, which is the
 * figure worth checking a port against: 11.25 by level 10, 34.5 by 25, 85.75 by
 * 50.
 */
export function lifeGainedTo(lifeRating: number, level: number, rank: number): number {
  let total = 0;
  for (let l = 2; l <= level; l += 1) total += lifeGainForLevel(lifeRating, l, rank);
  return total;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MONSTER'S STATS RISE TOO, AND WITHOUT THIS THE HIT POINTS ARE A CRUELTY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `self.unused_stats + (self.stats_per_level or 3) + self:getRankStatAdjust()`
 * — Actor.lua:3748. A player is handed those points to spend; a monster has
 * `autoLevelup` assign them, which is the only difference.
 *
 * ═══ WHY THIS SHIPS IN THE SAME BREATH AS THE LIFE CURVE ═══
 * Scaling a monster's hit points and not its stats does not make a fight
 * harder — it makes it LONGER. A level-40 husk with six hundred hit points and
 * a level-1 weapon cannot threaten anybody; it just takes four minutes to kill
 * while hitting for thirteen. That is a worse outcome than leaving both flat,
 * because the tedium is invisible in a test and obvious in a session.
 *
 * `getRankStatAdjust` returns 0 for ranks 1-3 and rises for the big ones
 * (Actor.lua:1754-1764). It is folded in here rather than exposed separately
 * because nothing else needs it yet.
 */
export const STATS_PER_LEVEL = 3;

export function rankStatAdjust(rank: number): number {
  if (rank <= 3) return 0;
  if (rank <= 3.5) return 1;
  if (rank <= 4) return 2;
  return 3;
}

/**
 * Every stat point a body of this level has been granted by levelling.
 *
 * For a PLAYER this is bookkeeping the spend path already does — see
 * `totalStatPointsAtLevel`, which is the same arithmetic against the player's
 * fixed rank. For a MONSTER it is the whole of its progression: there is nobody
 * to spend them, so they are assigned at spawn.
 */
export function statPointsGainedTo(level: number, rank: number): number {
  if (level <= 1) return 0;
  return (level - 1) * (STATS_PER_LEVEL + rankStatAdjust(rank));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSTITUTION BUYS HIT POINTS. Actor.lua:3884-3885.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     if stat == self.STAT_CON then
 *         self.max_life = self.max_life + 4 * v
 *
 * Four per point, flat, no curve. It is the only stat that pays into a pool in
 * our game today; upstream also routes WIL into mana and psi, which we have no
 * equivalent of yet.
 */
export const LIFE_PER_CON = 4;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   MAX HIT POINTS, DERIVED — NEVER STORED AND MUTATED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream keeps `max_life` as a running mutable total and adds to it in two
 * places. We compute it instead, from three inputs that are all facts the save
 * already holds: the class base, the level, and the Constitution actually spent.
 *
 * ═══ WHY DERIVED, WHEN UPSTREAM MUTATES ═══
 * Because a mutable total is a value that can drift from its own inputs, and
 * this project has a rule about exactly that: *"NEVER persist a derived value"*
 * (docs/data-schemas.md § 1). A stored `maxHp` would have to be reconciled on
 * every load, every respec and every gear change, and the first time the
 * reconciliation disagreed with the ledger a character would silently gain or
 * lose hit points on reconnect.
 *
 * `unspentPoints` already works this way and says so: raw points are persisted,
 * the purse is recomputed. This is the same decision for the same reason.
 *
 * CURRENT HP IS NOT DERIVED and must not be — it is a fact about a fight, and
 * the caller is responsible for clamping it when this figure moves. Upstream
 * heals to full on level-up, which sidesteps the question entirely.
 */
export function maxLifeFor(
  classBase: number,
  lifeRating: number,
  level: number,
  rank: number,
  conSpent: number,
): number {
  const gained = lifeGainedTo(lifeRating, level, rank);
  const fromCon = Math.max(0, conSpent) * LIFE_PER_CON;
  /**
   * FLOORED TO AN INTEGER AT THE END, and only at the end. Upstream carries
   * `max_life` as a float from level 2 onward and never rounds it, so rounding
   * each per-level gain would drift by up to half a point a level — about
   * twenty-five hit points across a career, all of it invisible.
   */
  return Math.max(1, Math.floor(classBase + gained + fromCon));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   SPREAD A MONSTER'S LEVELLING POINTS ACROSS THE STATS IT CARES ABOUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `autoLevelup` reads a per-monster `auto_stats` table and assigns
 * there. Ours takes the same list and deals round-robin, which is the same
 * intent with none of the machinery: a body that leads with Strength gets its
 * points in Strength, and a caster gets them in Magic.
 *
 * ROUND-ROBIN RATHER THAN ALL-IN-ONE, because a monster with one stat at 90 and
 * the rest at 10 is a monster that is unhittable or harmless depending on which
 * stat you look at — upstream's own tables list two or three for the same
 * reason.
 *
 * DETERMINISTIC, so two husks of the same level in the same room are identical
 * and a replay reproduces. `src/shared/` may not touch an RNG at all, which
 * settles it, but it would be the right call regardless: a monster whose
 * numbers were rolled would make "why did that one hit so hard" unanswerable.
 *
 * AN EMPTY LIST IS A BODY THAT DOES NOT GROW, and that is a legitimate thing to
 * author — a training dummy, or a prop that happens to have hit points.
 */
export function spreadStatPoints(
  stats: Readonly<Record<string, number>>,
  order: readonly string[],
  points: number,
): Record<string, number> {
  const out: Record<string, number> = { ...stats };
  if (order.length === 0 || points <= 0) return out;
  for (let i = 0; i < points; i += 1) {
    const key = order[i % order.length];
    if (key === undefined) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
