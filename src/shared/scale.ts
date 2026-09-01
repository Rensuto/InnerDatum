// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:1437-1441, 1443-1462,
//                                                                  1471-1477, 1507-1536,
//                                                                  1567-1593, 1781-1788
//             t-engine4 game/engines/default/engine/utils.lua:1957-1961
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * The scaling curves. Twelve lines of real arithmetic that carry fifteen years
 * of somebody else's balance tuning.
 *
 * WHY THIS FILE EXISTS AT ALL
 *   Every raw combat number in ToME — accuracy, defence, all three saves, all
 *   three powers — is passed through `rescaleCombatStats` exactly once, at the
 *   END of its getter. That single call is what makes `+5 accuracy` a real
 *   upgrade at character level 3 and a rounding error at level 30, without one
 *   line of per-item hand-tuning. Take it out and gear stacks linearly forever;
 *   replace it with a logarithm and players can no longer read their own sheet.
 *
 *   The source comment at Combat.lua:1443 states the design rule outright: *the
 *   first twenty ranks cost 1 point each, the second twenty cost two each, and
 *   so on ... they always know exactly what's going on, and there are nice
 *   breakpoints to strive for.*
 *
 * THE ONE RULE FOR CALLERS
 *   Rescale the SUM of the raw contributions, ONCE, at the end of the getter.
 *   Never per item and never per bonus. `rescale(a) + rescale(b)` is not
 *   `rescale(a + b)` — the function is deliberately concave, so rescaling per
 *   source restores linear stacking and destroys the entire diminishing-returns
 *   design while every unit test still passes.
 *
 * PURITY
 *   src/shared/ has no host types (tsconfig.shared.json sets `types: []`) and
 *   ESLint bans `Math.random`/`Date.now` here. Nothing in this file is random or
 *   stateful: every export is a pure function of its arguments, which is why the
 *   tests can pin exact values rather than ranges.
 *
 * CLIENT BAN
 *   eslint.config.js `NO_COMBAT_MATH_PATTERNS` blocks every `shared/scale*`
 *   import from src/client/. A hit-chance preview computed in the browser is a
 *   second copy of a formula, and a second copy always diverges — the symptom is
 *   a monster the client already drew as dead. Every displayed number is
 *   computed here, on the server, and sent.
 */

/**
 * `util.bound(i, min, max)` — engine/utils.lua:1957-1961.
 *
 * Lives here rather than in a utils module because ToME's combat maths is
 * saturated with it and every single use is a clamp on a combat number. Both
 * bounds are optional in the Lua (`if min then ...`), and because Lua treats 0
 * as truthy, `bound(x, 0, nil)` clamps at zero exactly as written; `undefined`
 * is the faithful translation of `nil`.
 */
export function bound(value: number, min?: number, max?: number): number {
  let out = value;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
}

/** ToME's default interval: the first tier is twenty raw points wide. */
export const RESCALE_INTERVAL = 20;

/**
 * Flat damage armour is rescaled on a WIDER interval — Combat.lua:2216 calls
 * `rescaleCombatStats(dec, 40)`. Exported so `combatGetFlatResist` cannot drift
 * to the default 20 during a refactor; the two curves differ by ~5 points at
 * realistic values, which is invisible in review and obvious in play.
 */
export const FLAT_RESIST_INTERVAL = 40;

/**
 * THE TIER RESCALE — Combat.lua:1444-1462, verbatim.
 *
 * Not a table lookup and not a logarithm: an iterative minimum over the convex
 * hull of the straight lines `x`, `20 + (x-20)/2`, `40 + (x-60)/3`, ... Each
 * successive tier costs one more raw point per rescaled point, so the plot is
 * piecewise linear with breakpoints a player can name.
 *
 * ═══ THE FLOOR AT LINE 1459 IS REAL ═══
 * `return math.floor(result)`. The te4 wiki and a great deal of third-party
 * documentation quote `rescale(71) = 43.67`; the shipped source returns **43**.
 * Trace: 71 → 45.5 → 43.667 → (47.75 is not smaller, so stop) → floor = 43.
 * If your implementation returns 43.67 you have dropped the floor, and every
 * derived stat in the game is then a fraction of a point too high — which is
 * exactly the kind of error that never crashes and quietly poisons balance.
 *
 * TERMINATION: no iteration guard, deliberately, because the loop cannot hang.
 * `nextresult` decreases only while the next tier is still cheaper, and the
 * subtracted `base` grows quadratically, so the comparison flips after
 * O(sqrt(x)) steps. NaN and ±Infinity all fail `nextresult < result` on the
 * first pass and return immediately.
 *
 * @param raw the SUM of every raw contribution to one stat. Never one item's.
 * @param interval tier width. 20 everywhere except flat damage armour, which
 *   passes 40 (Combat.lua:2216).
 */
export function rescaleCombatStats(raw: number, interval: number = RESCALE_INTERVAL): number {
  const x = raw;
  let result = x;
  let shift = 2;
  let tier = interval;
  let base = interval;

  for (;;) {
    const nextResult = tier + (x - base) / shift;
    if (nextResult < result) {
      result = nextResult;
      base = base + interval * shift;
      tier = tier + interval;
      shift = shift + 1;
    } else {
      // Combat.lua:1459 — THE FLOOR.
      return Math.floor(result);
    }
  }
}

/**
 * `rescaleDamage` — Combat.lua:1437-1441.
 *
 * The counterweight to the stat rescale above: raw damage is bumped by a small
 * power so that high-end talent damage keeps up with the compression applied to
 * the powers that feed it. Non-positive damage passes through untouched, so a
 * heal expressed as negative damage is not silently reshaped.
 */
export function rescaleDamage(dam: number): number {
  if (dam <= 0) return dam;
  return dam ** 1.04;
}

/**
 * `combatScale` — Combat.lua:1471-1477. The general power-curve fit.
 *
 * Solves for the straight line through `(x_low^p, y_low)` and
 * `(x_high^p, y_high)` and evaluates it at `x^p`. `combatTalentScale` and
 * `combatStatScale` are this function with the two anchor x-values pinned.
 */
export function combatScale(
  x: number,
  yLow: number,
  xLow: number,
  yHigh: number,
  xHigh: number,
  power = 0.5,
  add = 0,
  shift = 0,
): number {
  const xLowAdj = (xLow + shift) ** power;
  const xHighAdj = (xHigh + shift) ** power;
  const m = (yHigh - yLow) / (xHighAdj - xLowAdj);
  const b = yLow - m * xLowAdj;
  return m * (x + shift) ** power + b + add;
}

/**
 * `combatTalentScale` — Combat.lua:1515-1536. THE talent damage curve.
 *
 * Fits `y(1) = low` and `y(5) = high` on a square-root curve and extrapolates
 * honestly past 5. This is the helper 90% of ToME's talent numbers run through,
 * so porting a talent means copying its `low`/`high` pair and nothing else.
 *
 * ═══ NEVER CLAMP THE TALENT LEVEL AT 5 ═══
 * ActorTalents.lua:826 multiplies raw points by category mastery, so 4 raw
 * points at mastery 1.3 is talent level 5.2 and is *supposed* to exceed the
 * fitted high value. Clamping deletes the entire reward for mastery. (Mastery
 * itself is M6 — MVP loadouts are fixed at raw level — but the curve must be
 * right before anything is tuned against it.)
 *
 * Two behaviours that look like bugs and are not:
 *   - `tl <= 0` becomes 0.1 (:1517), so an unlearned talent yields a small
 *     positive value rather than a negative one or a division by zero.
 *   - the result is floored at 0 (:1533), never below.
 *
 * @param talentLevel effective talent level. Pass the number; the Lua's
 *   `t`-table overload is a lookup we do not have and do not need.
 * @param power `'log'` selects the log10 variant at :1521-1523, which
 *   additionally raises `tl` to at least 1.
 */
export function combatTalentScale(
  talentLevel: number,
  low: number,
  high: number,
  power: number | 'log' = 0.5,
  add = 0,
  shift = 0,
): number {
  let tl = talentLevel;
  if (tl <= 0) tl = 0.1;

  const xLow = 1;
  const xHigh = 5;

  if (power === 'log') {
    tl = Math.max(1, tl);
    const xLowAdj = Math.log10(xLow + shift);
    const xHighAdj = Math.log10(xHigh + shift);
    const m = (high - low) / (xHighAdj - xLowAdj);
    const b = low - m * xLowAdj;
    return Math.max(0, m * Math.log10(tl + shift) + b + add);
  }

  const xLowAdj = (xLow + shift) ** power;
  const xHighAdj = (xHigh + shift) ** power;
  const m = (high - low) / (xHighAdj - xLowAdj);
  const b = low - m * xLowAdj;
  return Math.max(0, m * (tl + shift) ** power + b + add);
}

/**
 * `combatTalentLimit` — Combat.lua:1576-1593. The asymptote.
 *
 * For any percentage that must approach a ceiling and never reach it: a chance
 * to stun, a damage reduction, an evasion rate. `limit` is the value at
 * infinite talent level; `low` and `high` are the values at talent levels 1
 * and 5. Omitting `low` uses the two-point form at :1588-1591, which assumes
 * the curve passes through the origin.
 *
 * The Lua computes `add * halfpoint` as one product (:1585) specifically to
 * avoid a divide-by-zero when `high == low`; that factoring is reproduced here
 * rather than "simplified", because simplifying it reintroduces the crash.
 *
 * The progression low → high → limit must be monotone. It is the caller's job
 * to keep it so; a non-monotone triple produces a curve that doubles back, and
 * ToME does not check either.
 */
export function combatTalentLimit(
  talentLevel: number,
  limit: number,
  low: number | undefined,
  high: number,
): number {
  const xLow = 1;
  const xHigh = 5;
  let tl = talentLevel;
  if (tl <= 0) tl = 0.1;

  if (low !== undefined) {
    const p = limit * (xHigh - xLow);
    const m = xHigh * high - xLow * low;
    const ah = (limit * (xHigh * low - xLow * high) + high * low * (xLow - xHigh)) / (high - low);
    return (limit * tl + ah) / (tl + (p - m) / (high - low));
  }

  const halfpoint = (limit * xHigh) / high - xHigh;
  return (limit * tl) / (tl + halfpoint);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `combatStatLimit` — Combat.lua:1603-1619. THE SAME CURVE, ANCHORED ON A STAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Byte for byte the formula `combatTalentLimit` above already implements, with
 * the two anchor points moved from talent levels (1 and 5) to STAT VALUES (10
 * and 100). Upstream keeps them as two functions for exactly that reason and so
 * do we, rather than one with the anchors as parameters: every call site would
 * then have to pass the pair, and the first one to pass the wrong pair would
 * produce a curve that is plausible everywhere and correct nowhere.
 *
 * `low` is what the value equals at stat 10 — a body with NO investment, since
 * `STAT_BASE` is 10 — and `high` is what it equals at stat 100. `limit` is the
 * asymptote nothing reaches. So the shape is "your first points are worth the
 * most", which is the whole reason upstream uses it for anything a stat buys
 * beyond a flat rate.
 *
 * ═══ `low = 0` IS A REAL ARGUMENT, NOT AN ABSENT ONE ═══
 * In Lua `0` is truthy, so `if low then` takes the FIRST branch for it — and
 * the one caller this file has, `healingFactorFrom`, passes exactly that. A
 * port that read Lua's `if low` as JavaScript's `if (low)` would silently take
 * the second branch and return a different curve, with both branches looking
 * equally reasonable. `low !== undefined` is the correct translation and the
 * sibling above already gets it right.
 */
export function combatStatLimit(
  stat: number,
  limit: number,
  low: number | undefined,
  high: number,
): number {
  const xLow = 10;
  const xHigh = 100;

  if (low !== undefined) {
    const p = limit * (xHigh - xLow);
    const m = xHigh * high - xLow * low;
    const ah = (limit * (xHigh * low - xLow * high) + high * low * (xLow - xHigh)) / (high - low);
    return (limit * stat + ah) / (stat + (p - m) / (high - low));
  }

  const halfpoint = (limit * xHigh) / high - xHigh;
  return (limit * stat) / (stat + halfpoint);
}

/**
 * `combatTalentWeaponDamage` — Combat.lua:1782-1788.
 *
 * The weapon-damage MULTIPLIER a talent applies, `base + (max-base)·sqrt(tl/5)`.
 * `Sniper's Mark ×1.65` and friends are this number.
 *
 * `t2` is a second talent's level that contributes at HALF weight (:1783); it
 * exists for talents boosted by a companion passive. Pass 0 when there is none.
 */
export function combatTalentWeaponDamage(
  talentLevel: number,
  base: number,
  max: number,
  t2 = 0,
): number {
  const half = t2 / 2;
  const diff = max - base;
  return base + diff * Math.sqrt((talentLevel + half) / 5);
}

/**
 * `getTierDiff` — Combat.lua:325-329.
 *
 * Tiers are twenty rescaled points wide. When an attacker's power outranks a
 * defender's save by a whole tier the defender eats a cross-tier debuff with NO
 * save at all, and the tier difference IS the duration in turns
 * (Combat.lua:321-322).
 *
 * Shipped now, used at M4: it is four lines, it is what makes "you have outgrown
 * this zone" legible without printing a level number, and retrofitting the
 * floors later is how off-by-one tier bugs happen.
 */
export function getTierDiff(atk: number, def: number): number {
  const a = Math.floor(atk);
  const d = Math.floor(def);
  return Math.max(0, Math.max(Math.ceil(a / 20), 1) - Math.max(Math.ceil(d / 20), 1));
}
