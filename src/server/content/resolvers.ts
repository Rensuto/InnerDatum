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
 * Neither is ported, and the reason is the same for both and is worth stating
 * once, at the top, because it is the kind of omission that gets "fixed" by a
 * well-meaning future reader:
 *
 *   1. THE DISTRIBUTIONS ARE NOT READABLE. `rng.avg` and `rng.mbonus` are C
 *      functions in the engine core, and `reference/t-engine4` HAS NO `src/`
 *      DIRECTORY — the clone ships CONTRIBUTING, COPYING, COPYING-MEDIA,
 *      CREDITS, `game/` and premake4.lua, and nothing else. Any variance form
 *      written here would be OUR INVENTION wearing a `// Ported from` comment,
 *      which is precisely the failure this whole work item exists to correct.
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
 * NOT PORTED: the spread. `rng.avg(x, y)` draws several times in [x, y] and
 * averages, giving a bell around (x + y) / 2 rather than the flat draw
 * `rng.range` would give — that is the whole point of the function upstream, and
 * it is a C function this clone does not carry the source for (see the file
 * header). We take the MEAN, which is the centre of whatever that bell is.
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
 * `rng.mbonus(max, level, max_level)` scales a random bonus by how far up the
 * level ladder the entity is: at `max_level` it can reach `max`, and at level 1
 * it is pinned to roughly `max / max_level`. ToME raises the ceiling from the
 * engine's 50 to **90**, so at OUR tier the scaled term is on the order of
 * 40/90 ≈ 0.444 — under half a point.
 *
 * SAY IT PLAINLY RATHER THAN ROUNDING IT AWAY: for the one real caller,
 * `losgoroth.lua:30` `resolvers.mbonus(40, 15)`, the true level-1 value is
 * 15 + something in roughly [0, 0.44], and this function returns a flat 15. The
 * port is therefore EXACT TO WITHIN ABOUT 0.4 of a point of weapon damage
 * rating, which then goes under the square root at Combat.lua:1682-1687 and
 * becomes a few thousandths of a point of damage. It is not exact. It is close
 * enough that the honest thing is to write the error down, and it is the same
 * two reasons as the file header: the distribution is unreadable and the
 * variance would cost a labelled draw.
 *
 * NOT PORTED: the `rng.mbonus` draw itself (C function, no source in the clone)
 * and therefore the level-scaled term. At level 1 that term is smaller than the
 * rounding on the number it is added to.
 *
 * @param _max the ceiling the bonus reaches at `mbonus_max_level` (90).
 *   DELIBERATELY UNCONSUMED at level 1 — underscored so eslint's
 *   `argsIgnorePattern` states that in the signature itself rather than in a
 *   comment somebody can delete. It stays in the parameter list so a call site
 *   can be diffed character-for-character against the upstream expression, and
 *   so the day autolevel lands the scaling term has somewhere to go.
 * @param add the flat term, which IS the whole value at our tier.
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
