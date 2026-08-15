// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:275-293 (checkHitOld)
//                                                                  336-350 (checkHit)
//             t-engine4 game/modules/tome/class/Actor.lua:6999-7015 (the partial-save margin)
//             t-engine4 game/engines/default/engine/utils.lua:1957-1961 (util.bound)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * THE RESOLUTION ROLL. One function for melee to-hit, ranged to-hit, spell and
 * mind status application, and all three saves.
 *
 * That single-function design is the whole reason a ToME character sheet is
 * legible. Because `checkHit` is linear at 2.5% per point, "+4 accuracy" means
 * "+10% to hit" against everything, forever, and a player can reason about a
 * piece of gear without a spreadsheet. Give saves their own curve and that
 * property is gone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO FUNCTIONS AND BOTH ARE LIVE. DO NOT DELETE EITHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `checkHit`    (Combat.lua:337) — linear. `ceil(50 + 2.5·(atk − def))`.
 *                 Used for attacks. Assumes both inputs have ALREADY been
 *                 through `rescaleCombatStats`.
 *   `checkHitOld` (Combat.lua:277) — logistic. Older, slower-saturating, and
 *                 still shipped, because `on_set_temporary_effect`
 *                 (Actor.lua:7003) uses it for every status save in the game.
 *
 * The name `checkHitOld` is kept verbatim, misleading as it is, so that
 * `grep -r checkHitOld reference/t-engine4` still lands on the original in six
 * months. Renaming it to `checkSave` would be clearer for exactly as long as it
 * takes to need the Lua again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE MARGIN IS RETURNED, NOT JUST THE BOOLEAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME returns two values — `rng.percent(hit), hit` — and the second one is not
 * decoration. Actor.lua:7006 computes a failed save's surviving DURATION from
 * it: `mean_pct = (100 − savechance) · 1.1`. Failing a save narrowly gives you a
 * SHORTER stun, not a binary miss, and that is the single mechanic that makes
 * ToME statuses feel the way they do.
 *
 * That lands at M4. It is in this signature at M3 because the alternative is
 * retrofitting a second return value through every call site in the engine at
 * the exact moment the status system is the thing being debugged.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FEED IT RESCALED NUMBERS. ALWAYS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * At 2.5% per point, a 40-point raw spread covers the entire 0-100% range — so
 * a raw accuracy of 80 against a raw defence of 20 is a guaranteed hit with 100
 * points of headroom wasted. `rescaleCombatStats` exists to compress raw numbers
 * into a band where 2.5%/point is a meaningful slope. Every derived getter in
 * src/server/engine/derived.ts ends in a rescale for this reason. Passing a raw
 * stat here is not a rounding error; it flattens the entire accuracy game.
 */

import { bound } from './scale.ts';
import type { Rng } from './rng.ts';

/**
 * The result of one resolution roll.
 *
 * A struct rather than a tuple: `const [hit, chance] = checkHit(...)` reads
 * fine and `const [chance, hit] = checkHit(...)` compiles just as happily.
 */
export type HitCheck = {
  /** Did it land? `roll <= chance`. */
  readonly hit: boolean;
  /**
   * The bounded percentage — ToME's SECOND return value.
   *
   * This is the number the combat log prints ("acc 41 vs def 33, 70%") and the
   * number M4's partial-save duration scaling consumes as
   * `(100 − chance) · 1.1` (Actor.lua:7006).
   */
  readonly chance: number;
  /** The d100 itself, 1..100 inclusive. Kept for replay diffing and logs. */
  readonly roll: number;
  /**
   * `chance − roll`. Zero or positive when it landed, negative when it did not,
   * and the size says by how much. This is the "how badly did I fail" number a
   * partial effect scales on, and the reason this type exists.
   */
  readonly margin: number;
};

/** Optional bounds. Status talents pass things like `(0, 95)` or `(5, 95)`. */
export type HitOpts = {
  /** Floor on the chance. `checkHit` defaults to 0; `checkHitOld` to 5. */
  readonly min?: number;
  /** Ceiling on the chance. `checkHit` defaults to 100; `checkHitOld` to 95. */
  readonly max?: number;
};

/**
 * `rng.percent(v)` — the d100 behind every roll in this file.
 *
 * ToME's `rng.percent` is native C and is NOT in the reference clone (the clone
 * holds 1,656 `.lua` files and zero `.c`/`.h` — see docs/tome-mechanics.md § 10).
 * So this is a REIMPLEMENTATION of documented semantics, not a translation:
 * `rand_range(1, 100) <= v`, both ends inclusive. Our `rng.int` is inclusive on
 * both ends by contract, so it maps across directly.
 *
 * The roll is drawn UNCONDITIONALLY, even when the chance is 0 or 100 and the
 * outcome is already decided. That is deliberate and it matters more than it
 * looks: the RNG stream's ordinal position is part of the replay contract, so a
 * short-circuit that skips a draw makes a guaranteed hit desynchronise every
 * subsequent roll in the turn.
 */
function rollPercent(rng: Rng, label: string): number {
  return rng.int(label, 1, 100);
}

/**
 * THE CURRENT TO-HIT — Combat.lua:337-350.
 *
 * ```lua
 * if atk < 0 then atk = 0 end
 * if def < 0 then def = 0 end
 * local hit = math.ceil(50 + 2.5 * (atk - def))
 * hit = util.bound(hit, min, max)
 * return rng.percent(hit), hit
 * ```
 *
 * 50% at parity, ±2.5% per rescaled point, clamped to `[min, max]` — defaults
 * `0` and `100` (:340-341), so an attack CAN be made impossible or certain by
 * the bounds. Status talents that must never be a sure thing pass `(0, 95)`.
 *
 * NOT PORTED, and neither is a loss:
 *   - :342-345 forces `min=0, max=100` while the combat tutorial quest is
 *     active. There is no quest system here.
 *   - the `factor` parameter (:337) is accepted by the Lua and never read by
 *     it. A dead parameter is worse than a documented omission.
 *   - `checkHit` has NO `atk == 0` promotion. That line belongs to
 *     `checkHitOld` alone (:281) and copying it here would shift every to-hit
 *     roll made by a zero-accuracy actor by 2.5%.
 *
 * @param atk attacker's accuracy — ALREADY rescaled. See the file header.
 * @param def defender's defence — ALREADY rescaled.
 */
export function checkHit(
  atk: number,
  def: number,
  rng: Rng,
  label: string,
  opts: HitOpts = {},
): HitCheck {
  const chance = hitChance(atk, def, opts);
  const roll = rollPercent(rng, label);

  return { hit: roll <= chance, chance, roll, margin: chance - roll };
}

/**
 * `checkHit`'s arithmetic WITHOUT the roll — Combat.lua:338-347.
 *
 * The server sends the client a to-hit percentage for the targeting UI, and the
 * client is forbidden from computing one itself (eslint.config.js blocks every
 * `shared/checkhit*` import from src/client/). This is that number, and it
 * exists so there is exactly ONE expression of the formula in the codebase:
 * `checkHit` calls it too. A preview that recomputed the curve would eventually
 * disagree with the roll, and "the tooltip said 70%" is an unwinnable argument.
 *
 * Draws nothing, so it is safe to call anywhere — including inside a loop over
 * every tile in a targeting ring — without touching the replay stream.
 */
export function hitChance(atk: number, def: number, opts: HitOpts = {}): number {
  const a = atk < 0 ? 0 : atk;
  const d = def < 0 ? 0 : def;
  return bound(Math.ceil(50 + 2.5 * (a - d)), opts.min ?? 0, opts.max ?? 100);
}

/**
 * THE SAVE ROLL — Combat.lua:277-293. Logistic, and still live.
 *
 * ```lua
 * if atk < 0 then atk = 0 end
 * if def < 0 then def = 0 end
 * if atk == 0 then atk = 1 end            -- ← :281. THE LINE THE DOCS DROPPED.
 * local one = 1 / (1 + math.exp(-(atk - def) / 7))
 * local two = 0
 * if atk + def ~= 0 then two = atk / (atk + def) end
 * hit = 50 * (one + two)
 * hit = util.bound(hit, min or 5, max or 95)
 * ```
 *
 * ═══ THE `atk == 0` PROMOTION AT LINE 281 ═══
 * docs/tome-mechanics.md § 3 quotes this function without it. It is not
 * cosmetic. The `two` term is `atk / (atk + def)`, so at `atk = 0` it collapses
 * to 0 and the guard on the next line — which exists only to stop a 0/0 — hides
 * the collapse instead of fixing it.
 *
 *   atk 0 vs def 0, WITHOUT the promotion:  one = 0.5, two = 0    → 25.0%
 *   atk 0 vs def 0, WITH it (atk becomes 1): one ≈ 0.5357, two = 1 → ≈ 76.78%
 *
 * Fifty points of save chance, on precisely the actor a monster with no
 * `apply_power` authored yet will hand you. It is pinned by a test.
 *
 * Called as `checkHitOld(save, apply_power)` — the SAVE is `atk` and the
 * incoming power is `def` — so a `true` result means the effect was RESISTED
 * (Actor.lua:7003, :7034-7037), and `chance` is the save chance the duration
 * formula divides into 100. Read that mapping twice; it inverts the intuition
 * every other use of the word "hit" in this file sets up.
 *
 * `factor` (:283, `factor = factor or 5`) is assigned and then never read by the
 * function. Omitted for the same reason as in `checkHit`.
 */
export function checkHitOld(
  atk: number,
  def: number,
  rng: Rng,
  label: string,
  opts: HitOpts = {},
): HitCheck {
  let a = atk < 0 ? 0 : atk;
  const d = def < 0 ? 0 : def;
  // Combat.lua:281. Do not remove; see the block above.
  if (a === 0) a = 1;

  const min = opts.min ?? 5;
  const max = opts.max ?? 95;

  const one = 1 / (1 + Math.exp(-(a - d) / 7));
  const two = a + d !== 0 ? a / (a + d) : 0;
  const chance = bound(50 * (one + two), min, max);
  const roll = rollPercent(rng, label);

  return { hit: roll <= chance, chance, roll, margin: chance - roll };
}
