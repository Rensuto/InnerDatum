// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/resolvers.lua:49-55  (rngavg)
//                                                              :84-92   (mbonus)
//                                                              :150-159 (levelup)
//             t-engine4 game/modules/tome/resolvers.lua:586-587 (mbonus_max_level = 90)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE RESOLVERS A LEVEL-1 NPC ENTRY ACTUALLY NEEDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ToME NPC entry is not a table of numbers. It is a table of numbers and
 * RESOLVERS — little deferred computations that `Entity:resolve()` runs when the
 * entity is created. Read `ant.lua:37` cold and it says
 *
 *     combat = { dam=resolvers.levelup(resolvers.rngavg(5,5), 1, 1), atk=15, ... }
 *
 * and there is no way to know what `dam` is without running three functions.
 * This file is those functions, at OUR TIER ONLY — level 1, no autolevel — so
 * that content/monsters.ts can write the upstream expression VERBATIM next to
 * its citation instead of writing a magic number and a promise that it was
 * derived correctly. A reader can diff `resolveRngAvg(5, 5)` against
 * `resolvers.rngavg(5,5)` character by character; they cannot diff `5`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALL THREE ARE PURE AND TAKE ZERO RNG DRAWS. THAT IS A DECISION, NOT A GAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two of the three upstream forms are stochastic: `rng.avg` and `rng.mbonus`.
 * Neither draws HERE, and the reason is worth stating once, at the top,
 * because it is the kind of omission that gets "fixed" by a well-meaning future
 * reader:
 *
 *   1. THE DISTRIBUTIONS WERE NOT READABLE WHEN THIS WAS WRITTEN, AND ARE NOW.
 *      `reference/t-engine4` has no `src/` and no `game/loader/`, so this file
 *      said any variance form would be OUR INVENTION wearing a `// Ported
 *      from` comment. That stopped being true when the C core and the loader
 *      were read at tag tome-1.6.0: `rng.avg` is C's `rng_avg`, the mean of
 *      `nb` (default 2) draws of `range(x, y)`, and `rng.mbonus` is LUA in
 *      `game/loader/pre-init.lua`, ported verbatim as `mbonus` in
 *      `shared/mapgen/lua.ts`. The terrain resolves lava's `mindam`/`maxdam`
 *      through it, per floor (`world/world.ts`, `burnRange`). So the
 *      distribution is no longer a reason; the argument below still is.
 *
 *   2. THE VARIANCE WOULD COST TWO LABELLED DRAWS AT SPAWN TIME. `src/shared/`
 *      is pure and every draw is labelled (CLAUDE.md § 3); a per-spawn HP roll
 *      would have to take two labelled draws from the `world.spawn` stream at a
 *      deterministic point in spawn ORDER, and replay-from-seed diverges the
 *      moment anything reorders spawns. There is no caller that needs it: every
 *      `maxHp` in the roster is held at an authored constant (see the deviation
 *      notes in content/monsters.ts), so the only live callers are two weapon
 *      damage RATINGS, which are per-template and not per-spawn.
 *
 * So: MEAN ONLY, no rng, and each function below names the half that was not
 * ported. If variance is ever wanted, it belongs at the spawn site with a
 * labelled draw — not hidden inside a content constant.
 *
 * SYNCHRONOUS AND PURE. No clock, no entropy source, no world.
 */

/**
 * `resolvers.rngavg(x, y)` — engine/resolvers.lua:49-55.
 *
 * ```lua
 * function resolvers.rngavg(x, y)
 *     return {__resolver="rngavg",  __resolve_instant=true, x, y}
 * end
 * function resolvers.calc.rngavg(t)
 *     return rng.avg(t[1], t[2])
 * end
 * ```
 *
 * `__resolve_instant = true` is the load-bearing half of that declaration: an
 * instant resolver runs ONCE, at entity creation, BEFORE every non-instant
 * resolver — it is not re-rolled per turn, per attack or per level. So the value
 * a creature is born with is the value it dies with, which is exactly why a
 * constant is a faithful port of the shape even though it is not a faithful port
 * of the distribution.
 *
 * NOT PORTED: the spread. `rng.avg(x, y)` is C's `rng_avg` (T-Engine4 tag
 * tome-1.6.0): two integer draws of `x + rand_div(1 + y - x)`, averaged, so a
 * triangle around (x + y) / 2 rather than the flat draw `rng.range` would give.
 * We take the MEAN, which for integer bounds is exactly that triangle's centre.
 *
 * The two real callers are both degenerate anyway: `ant.lua:37` writes
 * `rngavg(5,5)`, where x === y and the distribution collapses to the constant 5
 * with no error at all.
 */
export function resolveRngAvg(x: number, y: number): number {
  return (x + y) / 2;
}

/**
 * `resolvers.mbonus(max, add)` — engine/resolvers.lua:84-92, with ToME's own
 * override of the ceiling at tome/resolvers.lua:586-587.
 *
 * ```lua
 * resolvers.current_level = 1
 * resolvers.mbonus_max_level = 50                                  -- engine
 * function resolvers.calc.mbonus(t)
 *     return rng.mbonus(t[1], resolvers.current_level, resolvers.mbonus_max_level)
 *          + (t[2] or 0)
 * end
 * ```
 * ```lua
 * -- tome/resolvers.lua:586-587
 * resolvers.mbonus_max_level = 90
 * ```
 *
 * `rng.mbonus(max, level, max_level)` (`game/loader/pre-init.lua`, ported as
 * `mbonus` in `shared/mapgen/lua.ts`) centres a bell on `max * level /
 * max_level`, with a spread of `max / 4`, and clamps it to `[0, max]`. ToME
 * raises the ceiling from the engine's 50 to **90**.
 *
 * ═══ THIS NOTE USED TO SAY "UNDER HALF A POINT", AND THAT WAS WRONG ═══
 * It read the centre and forgot the spread. At level 1 the centre is under 1
 * but the spread is a quarter of `max`, and the clamp folds the lower half onto
 * 0. For the one real caller, `losgoroth.lua:30` `resolvers.mbonus(40, 15)`,
 * the level-1 value is 15 plus a bonus that is 0 about half the time, averages
 * about 4, and can reach 40 (measured over 400,000 draws of `mbonus`). This
 * function returns a flat 15, which is UPSTREAM'S FLOOR, not its mean: the
 * weapon rating is about 4 points low on average, before the square root at
 * Combat.lua:1682-1687 shrinks that to a small fraction of a point of damage.
 * `resolveMBonus(80, 40)` (items.ts) is the same shape, about 8 low.
 *
 * KEPT, AND NOW FOR ONE REASON RATHER THAN TWO. The distribution is readable
 * (see the file header); the per-spawn labelled draw is still the cost, and
 * every value this feeds is a per-template constant, not a per-spawn roll.
 *
 * NOT PORTED: the `rng.mbonus` draw itself, and therefore the whole bonus term.
 *
 * @param _max the ceiling the bonus reaches at `mbonus_max_level` (90).
 *   DELIBERATELY UNCONSUMED — underscored so eslint's `argsIgnorePattern`
 *   states that in the signature itself rather than in a comment somebody can
 *   delete. It stays in the parameter list so a call site can be diffed
 *   character-for-character against the upstream expression, and so the day
 *   the draw is wanted the bonus term has somewhere to go.
 * @param add the flat term, and the floor of upstream's value.
 */
export function resolveMBonus(_max: number, add: number): number {
  return add;
}

/**
 * `resolvers.levelup(base, every, inc, max)` — engine/resolvers.lua:150-159.
 *
 * ```lua
 * function resolvers.levelup(base, every, inc, max)
 *     return {__resolver="levelup", base, every, inc, max}
 * end
 * function resolvers.calc.levelup(t, e, _, _, k, kchain)
 *     if not e._levelup_info then e._levelup_info = {} end
 *     local li = {every=t[2], inc=t[3], max=t[4], kchain=table.clone(kchain), k=k}
 *     e._levelup_info[#e._levelup_info+1] = li
 *     return t[1]
 * end
 * ```
 *
 * ═══ THIS FUNCTION IS THE SCOPE FENCE, WRITTEN AS CODE ═══
 * Read the Lua again: `calc.levelup` RETURNS `t[1]` — the base — unchanged. The
 * only other thing it does is APPEND A RECORD to `e._levelup_info` describing
 * how the field should grow later. It does not grow anything itself. Growth
 * happens in `Actor:levelup()`, driven by `autolevel`, which is explicitly OUT
 * OF SCOPE for this work item and for this milestone.
 *
 * So the identity below is not a stub and it is not laziness. It is the correct
 * level-1 answer, and it exists so that a template can write
 * `resolveLevelup(resolveRngAvg(5, 5))` — the literal shape of ant.lua:37 — and
 * a reader can see at a glance that the `every`/`inc`/`max` half of the upstream
 * expression is deliberately absent rather than forgotten.
 *
 * NOT PORTED: `_levelup_info`, and everything downstream of it. Recording growth
 * rules for a system that cannot run them would be writing content for a system
 * that does not exist (CLAUDE.md, "things that look helpful and are not"). When
 * autolevel lands, THIS is the function that grows a second parameter, and every
 * call site is already pointing at it.
 */
export function resolveLevelup(base: number): number {
  return base;
}
