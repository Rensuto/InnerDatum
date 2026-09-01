// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3884-3885 (onStatChange)
//                                                  :3866-3872 (onTemporaryValueChange)
//              game/engines/default/engine/interface/ActorInventory.lua:563-572 (onWear)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE POOLS A BODY HAS, READ OFF THE SHEET IT IS ACTUALLY WEARING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/derived.ts` answers "what can this sheet DO" — accuracy, defence,
 * damage. This file answers the other question a composed sheet implies: "how
 * much of this body IS there".
 *
 * IT SAID "one function today; `maxMp` belongs here the day anything other than
 * a passive can move it." That day arrived when `moveMp` joined the gear fold,
 * and `maxMoveOf` is below.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FILE AND NOT THE THREE LINES IT REPLACES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It WAS three lines, inline in `main.ts#refreshPassives`, and it was wrong for
 * as long as it existed. It read:
 *
 *     actor.spentStats?.con ?? 0
 *
 * `spentStats` is the ledger of attribute points THE PLAYER BOUGHT. So the only
 * Constitution in the game that paid for hit points was Constitution somebody
 * clicked a `+` on. An ego rolling `con` (egos.ts:334 and :376 both do), the
 * `Long Service` passive — whose own description promises *"you last longer"* —
 * and any future timed effect all moved the Constitution row on the character
 * sheet and moved no hit points whatever. Reported from the live game as
 * *"I equip gear with CON and it doesn't properly raise my HP"*, and correct:
 * they did, and it didn't.
 *
 * ═══ THE FOLD WAS NEVER THE PROBLEM, WHICH IS WHY IT SURVIVED SO LONG ═══
 * `recomposeCombat` had been folding gear into `actor.combat.stats.con`
 * correctly the whole time, and every OTHER consumer of Constitution read that
 * and was right. This one computation reached around the fold to the ledger
 * underneath it, so it was the single reader in the process that disagreed with
 * the character sheet — and the character sheet is what the player checks.
 *
 * ═══ AND WHY IT IS EXPORTED RATHER THAN INLINE ═══
 * The bug was untestable where it lived. `refreshPassives` is a closure inside
 * `buildServer`, so nothing in `test/` could aim at it: the only way to reach
 * the rule was to spawn a server, and a level-1 character has no points to spend
 * and no way to be handed a Constitution item, so even that could not express
 * the case. A rule that cannot be stated as a test is a rule that gets to be
 * wrong indefinitely. This module is that rule, named, with the discriminating
 * case — Constitution from somewhere OTHER than the ledger — written down in
 * test/server/pools.test.ts.
 */

import { STAT_BASE } from './derived.ts';
import { maxLifeFor } from '../../shared/leveling.ts';
import type { CombatSheet } from './combat.ts';

/**
 * What this function needs of a body. A structural slice rather than
 * `PlayerActor`, for `equipment.ts#wornOf`'s stated reason: a function that can
 * only be called with the real thing is a function a test has to build a world
 * to ask a question of.
 *
 * `combat` is the COMPOSED sheet — the one `recomposeCombat` writes. Passing
 * `baseCombat` here would reintroduce the whole bug, which is why the parameter
 * is not called `sheet`.
 */
export type PooledBody = {
  readonly level: number;
  readonly combat?: CombatSheet;
};

/** The numbers a class contributes. `ClassDef` satisfies this. */
export type PooledClass = {
  readonly maxHp: number;
  readonly lifeRating: number;
  readonly maxMp: number;
  readonly combat: CombatSheet;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAX HIT POINTS FOR A BODY AS IT CURRENTLY STANDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `classBase + Σ level gains + 4 × (Constitution now − Constitution the class
 * was authored with)`.
 *
 * ═══ WHY THE CLASS'S OWN CONSTITUTION IS SUBTRACTED ═══
 * A Watchman's authored `maxHp: 72` is seventy-two hit points AT CONSTITUTION
 * 20 — the number was tuned for the body that has it. Handing the raw effective
 * stat to `maxLifeFor` would pay him eighty extra hit points for standing still
 * on the day he was created. The subtraction is what makes "a level-1 character
 * with nothing on is exactly its authored base" hold, which is the safety
 * property `leveling.test.ts` pins for all four classes.
 *
 * ═══ `STAT_BASE` ON BOTH SIDES, NEVER ZERO ═══
 * `composeWielders` states the rule and the cost: *"An absent `stats.*` is TEN,
 * not zero … the naive version hands a Watchman a ring and takes seven points of
 * Strength off him."* Both reads here default the same way, so a fixture class
 * with no authored `stats` table nets to nought rather than to minus forty hit
 * points.
 *
 * ═══ IT DOES NOT CLAMP, AND `maxLifeFor` FLOORS AT ONE ═══
 * A body dragged below its class's Constitution by a future curse SHRINKS —
 * upstream runs the same `+ 4 * v` with a negative `v`. See `maxLifeFor`.
 */
export function maxLifeOf(body: PooledBody, definition: PooledClass, rank: number): number {
  const classCon = definition.combat.stats?.con ?? STAT_BASE;
  const liveCon = body.combat?.stats?.con ?? classCon;
  return maxLifeFor(definition.maxHp, definition.lifeRating, body.level, rank, liveCon - classCon);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR THIS BODY GETS IN A TURN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The class's authored figure plus whatever `mods.moveMp` the composed sheet
 * carries — a `legwork` passive, and now a worn item or a timed effect, because
 * `moveMp` joined `WIELDER_MOD_KEYS`.
 *
 * ═══ IT READ `passiveCombat` AND THAT WAS THE SAME BUG AS ALL THE OTHERS ═══
 * `main.ts` computed this as `definition.maxMp + actor.passiveCombat?.mods
 * ?.moveMp`, which is a derived pool reaching past `recomposeCombat` to one of
 * the layers underneath it — the shape that cost this project a whole day: max
 * hit points off the points ledger, the compare panel off `baseCombat`, two
 * clamps off a level-1 ceiling.
 *
 * ═══ AND IT WAS COMPLETELY UNTESTED, WHICH IS WHY IT IS HERE NOW ═══
 * Removing `moveMp` from the fold's allow-list — which would have silently
 * deleted the `legwork` passive's whole effect — failed NOTHING in a suite of
 * four thousand tests. It was unreachable where it lived, inside the
 * `buildServer` closure, exactly as `maxLifeOf` was.
 *
 * FLOORED AT ONE. A body that cannot move at all is a body the turn system has
 * no answer for; `mpPenalty` is how a status takes movement away, and it is
 * applied elsewhere and deliberately not here.
 */
export function maxMoveOf(body: PooledBody, definition: PooledClass): number {
  return Math.max(1, definition.maxMp + (body.combat?.mods?.moveMp ?? 0));
}
