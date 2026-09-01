// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/load.lua:192-206 (exp_chart, defineMaxLevel)
//             t-engine4 game/engines/default/engine/interface/ActorLevel.lua:95-107 (gainExp)
//             t-engine4 game/engines/default/engine/interface/ActorTalents.lua:71 (t.points)
//             t-engine4 game/modules/tome/class/Actor.lua:171, 3747-3774, 6513-6531
//             t-engine4 game/modules/tome/data/birth/classes/warrior.lua:80-86
//             t-engine4 game/modules/tome/data/birth/descriptors.lua:73 (max_level = 50)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * PROGRESSION: the experience curve, the level-up loop, and the talent-point
 * budget. Pure arithmetic, no state, no dice.
 *
 * ===========================================================================
 * WHY THIS IS IN src/shared/ AND NOT src/server/
 * ===========================================================================
 * The panel has to draw "1,240 / 2,700 to level 8". That is `expChart` run in
 * the browser, and the alternative is either a second copy of the formula or a
 * server round-trip for a number that never changes. Both are worse. This is
 * the same argument that keeps the combat curves in src/shared/scale.ts, with
 * one difference that matters: scale.ts is banned from the client bundle by
 * eslint's `NO_COMBAT_MATH_PATTERNS` because a client-side hit-chance preview
 * can DISAGREE with the server about whether something died. An xp bar cannot
 * disagree about anything — the server sends `xp` and `level` as facts and this
 * file only formats the denominator — so it is safe for both sides, and that
 * asymmetry is the whole reason it gets to be shared rather than server-only.
 *
 * ═══ THE ONE IMPORT THAT IS DELIBERATELY NOT HERE ═══
 * `bound` in src/shared/scale.ts is `util.bound` and `expChart` below wants it.
 * It is NOT imported. `no-restricted-imports` only inspects the specifier a
 * file writes, so importing scale.ts here would drag the entire combat-maths
 * module into the client bundle through a back door that lints clean — the ban
 * would still be enforced at every direct call site and silently defeated at
 * this one. The clamp is written out inline instead, with the Lua beside it.
 *
 * PURITY (CLAUDE.md § 3)
 *   No fs, no process, no DOM, no Date.now, no Math.random, no timers, and no
 *   RNG of any kind. Experience is not a dice roll in ToME and is not one here:
 *   `worthExp` is a product of three numbers. Every export is a pure function
 *   of its arguments, so the tests pin exact integers rather than ranges.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   THE PARTY SHARE RULE IS NOT IN THIS FILE. It needs the party table and the
 *   connection state, so it lives in the scheduler. It is also NOT A PORT —
 *   ToME has no party experience rule at all (Party.lua contains zero `exp`,
 *   Player.lua contains zero `gainExp`, and Actor.lua:2985-2987 is the only
 *   combat award site in the module, paying exactly one actor). See DECISIONS.md
 *   D12; nothing about it may ever carry a `Ported from` header.
 */

import { ActorRank } from './protocol.ts';

/**
 * The character cap.
 *
 * ═══ THIS IS A CONTENT CHANGE, NOT AN ENGINE DEVIATION ═══
 * ToME's 50 is not an engine constant. load.lua:192 does the opposite of
 * setting one:
 *
 *     ActorLevel:defineMaxLevel(nil)      -- "player is restricted to 50 but
 *                                         --  npcs can go higher"
 *
 * The engine cap is switched OFF outright, and the 50 arrives from the other
 * direction entirely — as `max_level = 50`, one field on a BIRTH DESCRIPTOR
 * (data/birth/descriptors.lua:73), which is authored content in exactly the
 * same sense our class definitions are. So choosing 10 is us authoring a
 * descriptor, not us contradicting the engine, and the ported curve below is
 * untouched by it.
 *
 * ═══ IT WAS 10, AND THE PROJECT DECIDED FOR 1:1 INSTEAD (2026-08-20) ═══
 * The old argument was a good one: 3-6 friends playing ONE EVENING, ten levels
 * against the verbatim chart being ~145 kills, a session with a visible top
 * rather than a treadmill. It was the right cap for three classes and forty-two
 * talents.
 *
 * It is the wrong cap for the target this project now has — ToME's 1,231
 * talents across 281 trees and 29 classes. A cap of 10 gives eleven talent
 * points, and eleven points cannot express a build drawn from that much
 * content: the game would ship a library nobody has the currency to read.
 *
 * ═══ AND TEN WAS QUIETLY BREAKING FOUR PORTED FORMULAS ═══
 * This is the part that settles it. Every one of these is upstream arithmetic
 * that a cap of 10 pushed outside its own domain, and each needed a local
 * workaround that this change deletes:
 *
 *   LOOT BANDS.   `bound(ceil(level/10), 1, 5)` (GameState.lua:1324) put EVERY
 *                 character at EVERY level in band 1 — the whole ego and
 *                 double-ego table was unreachable. content/loot.ts had to
 *                 halve the divisor to five bands of two.
 *   TALENT TIERS. Upstream's ladder gates tier 4 at character level 12, so a
 *                 quarter of every tree was unbuyable. src/shared/tiers.ts had
 *                 to re-derive the constants.
 *   THE XP CURVE. The `level < 30` branch of the chart below never ran: `mult`
 *                 only fell from 8.5 to 6.7 across the whole game, so the
 *                 curve's own shape was never seen.
 *   PRODIGIES.    Unlocked at 30 and 42 (Actor.lua:3761-3766). Unreachable.
 *
 * Four ported formulas, four workarounds, all of them saying the same thing:
 * the constant was outside the range its source assumes. Raising the cap is
 * what makes the port a port.
 *
 * WHAT IT COSTS, STATED PLAINLY: 50 levels against the verbatim chart is a far
 * longer game than one evening, and the content to fill it does not exist yet.
 * That is the accepted trade — the cap now describes the game being built
 * rather than the game as it stands this week.
 */
export const MAX_CHARACTER_LEVEL = 50;

/**
 * The per-talent cap. One point buys one raw level, 1 through 5.
 *
 * `t.points` — ActorTalents.lua:71, inside `newTalent`, which defaults it to 1
 * for talents that declare nothing. Essentially every real ToME talent declares
 * 5: `grep -rho 'points = [0-9]*' data/talents/` over the reference tree counts
 * 1,096 occurrences of `points = 5` against 144 of `points = 1` (the passives
 * and the one-shot uniques) and a single `points = 6`.
 *
 * NOTE FOR THE NEXT READER, because the two lines are IDENTICAL and easy to
 * confuse (they are seventeen lines apart, not adjacent — this note used to say
 * one, which sends a reader scanning the wrong three lines for the second hit):
 * ActorTalents.lua:54 is ALSO `t.points = t.points or 1`, but that one
 * is in `newTalentType` and is the price of unlocking a whole CATEGORY. It is
 * not this number and we do not have categories to unlock.
 *
 * Five is also what src/shared/scale.ts's curves are fitted to —
 * `combatTalentScale` pins y(1) = low and y(5) = high (Combat.lua:1515-1536) —
 * so this constant and the talent numbers are the same decision seen twice.
 * Levels above 5 are not clamped by the curve on purpose (see that file's
 * "NEVER CLAMP THE TALENT LEVEL AT 5"); the cap is enforced by the spend path,
 * which is the only thing that hands out raw points.
 */
export const TALENT_MAX_LEVEL = 5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW MANY TALENTS A CLASS IS BORN KNOWING. The free ranks in the ledger.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's `talents = { [T_SHIELD_PUMMEL]=1, ... }` on a class descriptor
 * (warrior.lua:149-155 grants five). `ClassDef.birthTalents` is the authored
 * list; this is its LENGTH, and it lives here because two layers need the
 * number and only one of them may see the list.
 *
 * ═══ WHY THE PERSISTENCE LAYER CANNOT JUST COUNT THEM ═══
 * `spentTalentPoints` (server/persist/saves.ts) has to subtract the free ranks
 * from a spread to know what was actually PAID for, and that file may not
 * import the talent registry or the class table — `classId` is a soft
 * reference there on purpose, so that a save outlives a content edit. A number
 * in shared/ is what both sides can hold without either one reaching into the
 * other.
 *
 * PINNED AGAINST THE LISTS by test/server/birth-talents.test.ts: every class
 * grants exactly this many, and a class that granted five would silently hand
 * its owner a free point on every reconnect.
 */
export const BIRTH_TALENT_GRANTS = 4;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW MANY ACTIVE TALENTS A CLASS MAY OWN. A RANGE, AND IT WAS ONCE SIX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `_loadoutArityCheck` (server/content/classes.ts) required EXACTLY six, and
 * that was not arbitrary: the hotbar had six fixed slots, slot n was
 * `loadout[n]`, and a seventh active would have been a talent nothing could
 * press. It is also what stopped any class growing a third discipline with a
 * button in it, which was most of what stood between this game and the one it
 * is a port of.
 *
 * ═══ IN shared/ BECAUSE BOTH ENDS ANSWER TO IT, AND NEITHER OWNS IT ═══
 * The obvious place was ui/hotbar.ts beside the geometry, and the server would
 * then import from the client — which inverts the one-way arrow CLAUDE.md
 * states and eslint enforces. The honest reading is the other way round: how
 * many talents a class may HOLD is a rule about the game, and how many boxes
 * fit on a screen is the client's answer to it. So the rule lives here and the
 * bar checks itself against it.
 *
 * THE FLOOR IS A FULL PAGE. A class with five actives draws a gap on the bar,
 * which reads as a button that failed to load rather than as a class with room
 * in it — the same argument talent-trees.test.ts makes for why a tree is
 * exactly six and not at most six.
 *
 * THE CEILING IS WHAT THE BAR CAN ADDRESS: two pages of six. A thirteenth
 * active would be one a player could own, could see in the panel, and could
 * never put on a key.
 */
export const TALENTS_PER_CLASS_MIN = 6;
export const TALENTS_PER_CLASS_MAX = 12;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY THINGS A BODY MAY CARRY. THE ONE NUMBER, READ BY BOTH SIDES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Moved here from `net/gateway.ts`, where it was server-only and the panel
 * therefore could not read it. Its argument is unchanged and is worth keeping:
 *
 *   Upstream's cap is a weight budget (data/birth/descriptors.lua:56) — a limit
 *   nobody meets in a four-hour session, which engine/actor.ts calls "a rule
 *   that only exists to be got wrong". Upstream can afford that: it has a
 *   vendor, a home chest and a hundred-hour campaign to fill a bag over. We have
 *   one floor, three monsters on it, at most three drops per delve and no shop.
 *
 *   TWELVE IS CHOSEN, NOT PORTED. It is the smallest number that cannot bind in
 *   ordinary play — seven worn slots plus five in reserve is more than a full
 *   kit — so a player who hits it has been hoarding rather than playing, and the
 *   refusal is a nudge to leave something for a friend. The point of a cap that
 *   cannot bind is not the cap: it is that `pickup` has a bounded answer at all,
 *   so `carried` cannot grow without limit under a client in a loop.
 *
 * ═══ AND THE PANEL WAS HOLDING A COPY SPELLED AS FURNITURE ═══
 * `ui/inventory.ts` had `const CARRIED_MAX = COLS * 3` under a note reading "IT
 * IS THE SERVER'S CAP, RESTATED, NOT A SECOND OPINION" — four grid columns
 * times three grid rows, which is twelve by coincidence of LAYOUT. The panel
 * draws that number to the player as `CARRIED 5/12`, so re-flowing the grid for
 * any visual reason would have changed what the game told a player their
 * capacity was, without touching the rule or failing anything.
 *
 * Both sides import this now. The grid's job is to be big enough to SHOW it,
 * which is a separate assertion in the panel.
 */
export const INVENTORY_CAP = 12;

/**
 * `ActorLevel.exp_chart(level)` — load.lua:193-206, VERBATIM.
 *
 *     ActorLevel.exp_chart = function(level)
 *         local exp = 10
 *         local mult = 8.5
 *         local min = 3
 *         for i = 2, level do
 *             exp = exp + level * mult
 *             if level < 30 then
 *                 mult = util.bound(mult - 0.2, min, mult)
 *             else
 *                 mult = util.bound(mult - 0.1, min, mult)
 *             end
 *         end
 *         return math.ceil(exp)
 *     end
 *
 * ═══ IT MULTIPLIES BY `level`, NOT BY `i` ═══
 * This is the line every reader "fixes". The accumulator adds `level * mult` —
 * the TARGET level, a loop invariant — while the loop variable `i` is used for
 * nothing but counting the iterations. It is not a typo upstream and it is what
 * makes the curve quadratic-ish rather than linear: `expChart(4)` adds
 * 4×8.5 + 4×8.3 + 4×8.1, three times, not 2×8.5 + 3×8.3 + 4×8.1. Change it to
 * `i` and every number in test/shared/progression.test.ts's golden table moves.
 *
 * ═══ WHAT IS KEPT EVEN THOUGH IT IS DEAD CODE HERE ═══
 * The `level < 30` branch, the 0.1 decay above it, and the floor of 3 are all
 * unreachable at our cap of 10: `mult` only falls from 8.5 to 6.7 across the
 * whole range and never approaches 3. They stay anyway. A verbatim port that a
 * reader can diff character-for-character against the Lua is worth more than a
 * trimmed one — the trimmed version is faster to read exactly once and then
 * costs an hour every time somebody wants to know whether it was simplified
 * correctly or simplified wrongly. If `MAX_CHARACTER_LEVEL` is ever raised, the
 * curve above 30 is already right.
 *
 * ═══ IT IS PER-LEVEL, NOT CUMULATIVE ═══
 * The return value is the xp needed to advance FROM `level - 1` TO `level`, and
 * `gainExp` SUBTRACTS it on the way past. `expChart(10)` is 703, not 2,700; the
 * 2,700 is the sum over 2..10 and appears nowhere in the game's arithmetic.
 * `expChart(1)` runs zero iterations and returns 10, which is why the loop below
 * — like the Lua's — is never asked about level 1 by `gainExp`.
 *
 * Values, and the test pins all of them: 27, 61, 110, 174, 254, 346, 453, 572,
 * 703 for levels 2..10.
 */
export function expChart(level: number): number {
  let exp = 10;
  let mult = 8.5;
  const min = 3;

  for (let i = 2; i <= level; i++) {
    // `level`, NOT `i`. See the docblock above before touching this line.
    exp = exp + level * mult;

    // `util.bound(mult - 0.2, min, mult)` — engine/utils.lua:1957-1961 clamps
    // low first, then high. Written out rather than imported from scale.ts, so
    // that including this file in the client bundle cannot smuggle the combat
    // maths in with it (see the module docblock).
    const decayed = level < 30 ? mult - 0.2 : mult - 0.1;
    mult = Math.min(mult, Math.max(min, decayed));
  }

  // load.lua:205 — `math.ceil`. The chart is fractional internally (level 3 is
  // 60.4) and integral on the way out. Drop it and every threshold is a hair
  // low, which never fails anything and quietly shortens the game.
  return Math.ceil(exp);
}

/**
 * ToME's own farm-rate dial, `game.level.data.exp_worth_mult` (Actor.lua:6516),
 * which defaults to 1 and is set per zone by GameState.lua:857
 * (`zone.exp_worth_mult = self.farm_factor[kind]`) for exactly this purpose:
 * turning the award rate up or down without touching the curve.
 *
 * We have one level and no zones, so it is a module constant rather than level
 * data. Four is chosen, not ported — see `worthExp` for the arithmetic it
 * produces. It is the ONE tuning knob for pacing: raising it shortens the
 * evening proportionally and leaves ToME's per-level shape exactly intact,
 * which is precisely what re-tuning the curve would destroy.
 */
export const XP_WORTH_MULT = 4;

/**
 * The rank ladder — Actor.lua:6520-6528. (NOT :6519-6527: :6519 is the
 * `if not game.zone.infinite_dungeon then` guard, which is not part of the
 * ladder, and the quoted block's own closing `end` is :6528. Copying the old
 * range picks up the guard and drops the terminator.)
 *
 *     local mult = 0.6
 *     if self.rank == 1 then mult = 0.6          -- critter
 *     elseif self.rank == 2 then mult = 0.8      -- normal
 *     elseif self.rank == 3 then mult = 3        -- elite
 *     elseif self.rank == 3.2 then mult = 3      -- rare
 *     elseif self.rank == 3.5 then mult = 11     -- unique
 *     elseif self.rank == 4 then mult = 25       -- boss
 *     elseif self.rank >= 5 then mult = 60       -- elite boss
 *     end
 *
 * UPSTREAM HAS SEVEN ROWS AND WE PORT THREE. The other four are absent because
 * THE RANKS ARE ABSENT, not because the numbers were rejected: `ActorRank` in
 * src/shared/protocol.ts:240-244 has exactly three members, and its own comment
 * says why ("MVP has no unique/rare/god tier to distinguish"). The day a rare
 * or a unique lands, the row it needs is written above, unedited, ready to be
 * copied down — which is the entire reason the dead rows are quoted here rather
 * than deleted.
 *
 * The three we keep are upstream's values to the digit: normal 0.8, elite 3,
 * boss 25. An elite is worth just under four normals and a boss worth
 * thirty-one, and that ratio is fifteen years of somebody else's tuning.
 */
export const RANK_WORTH = {
  [ActorRank.Normal]: 0.8,
  [ActorRank.Elite]: 3,
  [ActorRank.Boss]: 25,
} as const satisfies Record<ActorRank, number>;

/**
 * The rank multiplier for one body. `satisfies Record<ActorRank, number>` above
 * is what makes this total: add a member to `ActorRank` and the table fails to
 * compile rather than this function returning `undefined` at runtime and paying
 * out `NaN` xp.
 */
export function rankWorth(rank: ActorRank): number {
  return RANK_WORTH[rank];
}

/**
 * What one kill pays. `killerLevel × rankWorth(victimRank) × XP_WORTH_MULT`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A DEVIATION. UPSTREAM USES THE VICTIM'S LEVEL; WE USE THE KILLER'S.
 * ═══════════════════════════════════════════════════════════════════════════
 * Actor.lua:6513-6531 ends in:
 *
 *     return self.level * mult * self.exp_worth
 *            * (target.exp_kill_multiplier or 1) * level_mult
 *
 * where `self` is the CORPSE. The award is linear in the VICTIM's level, and
 * `exp_worth` (1 for everything ordinary) and `exp_kill_multiplier` are the two
 * per-entity dials we have no content for.
 *
 * WHY THAT DOES NOT WORK HERE. In ToME the victim's level tracks the player's,
 * because progress IS depth: you descend, the zone level rises, and the monsters
 * rise with it. We have ONE hand-authored 30×30 map (src/shared/level.ts), no
 * floors, no depth and no monster levels — every husk in the game is level 1 and
 * stays level 1. Ported verbatim, every kill in the game pays a FLAT
 * `1 × 0.8 = 0.8` xp forever, and 2,700 xp at 0.8 a kill is **3,375 kills** to
 * reach level 10. That is not a long game; it is a broken one.
 *
 * THE SUBSTITUTION, AND ITS ARITHMETIC. Swap the victim's level for the
 * KILLER'S and apply ToME's own `exp_worth_mult` at 4 (`XP_WORTH_MULT`). Award
 * against a normal becomes `killerLevel × 3.2`, and kills-to-next-level runs:
 *
 *     level 1→2   8.4        level 4→5  13.6        level 7→8   20.2
 *     level 2→3   9.5        level 5→6  15.9        level 8→9   22.3
 *     level 3→4  11.5        level 6→7  18.0        level 9→10  24.4
 *
 * ≈144 kills (145 walked as whole kills, which is what the pacing test counts) —
 * an evening for 3-6 friends. Note what it does NOT do: it reproduces ToME's
 * per-level pacing RATIO exactly, because the chart is untouched and only a
 * scalar changed. Re-tuning the curve instead would have been inventing one.
 *
 * ═══ THE WART, NAMED RATHER THAN HIDDEN ═══
 * A level-9 player earns NINE TIMES what a level-1 player earns from the same
 * husk. That is backwards on its face, and it is a real, observable property of
 * this build rather than a rounding error.
 *
 * THIS PARAGRAPH USED TO CLAIM IT WAS UNOBSERVABLE, and the claim was wrong.
 * The argument was: the full-share rule (DECISIONS.md D12) keeps everyone in the
 * party at the same level, so nobody can compare. NOTHING ENFORCES THAT. Parties
 * are invite/accept (src/server/engine/party.ts), so a fifth friend can join at
 * level 1 at nine o'clock and stand next to four level-8 friends — at which
 * point the premise is false and stays false for the rest of the evening. It was
 * presented as a proof and it was a description of the only case anybody had
 * tried.
 *
 * WHAT ACTUALLY CONTAINS IT NOW: `awardExperience` computes this function ONCE
 * PER RECIPIENT, from the RECIPIENT'S OWN LEVEL, inside the payout loop. So the
 * wart is confined to a single character's own rate — a level-9 player levels
 * more slowly than the chart alone would suggest, which is a pacing choice —
 * and it can no longer leak sideways into anybody else's progression or make the
 * party's rate depend on who landed the last blow. The parameter is named
 * `killerLevel` for its history; read it as "the level of the actor being paid",
 * which is what the `@param` below has always said.
 *
 * **The day floors and monster levels land, this MUST be swapped back to the
 * victim's level** — at that point the victim's level tracks progress again,
 * which is the only thing upstream's version ever needed, the wart disappears
 * entirely, and this comment becomes the changelog for doing it.
 *
 * ═══ THE LINE THAT IS DELIBERATELY NOT PORTED ═══
 * Actor.lua:6514 is the anti-farming floor:
 *
 *     if not target.level or self.level < target.level - 7 then return 0 end
 *
 * "a corpse more than seven levels beneath you is worth nothing". Under the
 * substitution `self.level` and `target.level` are the SAME NUMBER, so it reads
 * `killerLevel < killerLevel - 7` and is never true — porting it would be
 * porting a no-op and pretending it did something. Worse, porting it *against
 * the victim's level* while the roster is uniformly level 1 would zero every
 * award in the game the moment a player hit level 9, with no error, no log line
 * and no way to tell it from a bug in the barrier. It goes back in the same
 * commit the victim's level does, and not before.
 *
 * @param killerLevel the level of the actor being PAID. See above.
 * @param victimRank the rank of the body that died.
 */
export function worthExp(killerLevel: number, victimRank: ActorRank): number {
  return killerLevel * rankWorth(victimRank) * XP_WORTH_MULT;
}

/** What `gainExp` returns: the new level, the new PER-LEVEL xp, and the delta. */
export type ExpGain = {
  level: number;
  xp: number;
  levelsGained: number;
};

/**
 * `ActorLevel:gainExp(value)` — ActorLevel.lua:95-107, ported.
 *
 *     function _M:gainExp(value)
 *         self.changed = true
 *         self.exp = math.max(0, self.exp + value)
 *         while self:getExpChart(self.level + 1) and self.exp >= self:getExpChart(self.level + 1)
 *               and (not self.actors_max_level or self.level < self.actors_max_level) do
 *             ...
 *             self.level = self.level + 1
 *             self.exp = self.exp - self:getExpChart(self.level)
 *             self:levelup()
 *         end
 *     end
 *
 * Pure rather than mutating: it takes the pair and returns a new pair, so the
 * caller decides when the actor changes and the engine's synchronous turn
 * resolution never has a half-levelled actor to observe. `levelup()` is the
 * caller's job too — the points it would grant are `pointsForLevel`, below.
 *
 * ═══ TWO PROPERTIES THAT MUST SURVIVE THE PORT ═══
 *
 * 1. `xp` IS PER-LEVEL AND RESETS. Line 104 SUBTRACTS the threshold; it does not
 *    remember a running total. So `xp` is always "progress into the current
 *    level" and the panel's bar is `xp / expChart(level + 1)` with no
 *    bookkeeping. A cumulative implementation type-checks, passes a single-level
 *    test, and then levels a player every single kill once they are past 2,700.
 *
 * 2. ONE AWARD CAN CROSS SEVERAL LEVELS. It is a `while`, not an `if`. A boss at
 *    100 xp a head takes a level-1 character to level 4 in one call, and the
 *    remainder carries. `levelsGained` is returned so the caller can narrate all
 *    of them rather than only the last.
 *
 * ═══ AT THE CAP, XP KEEPS ACCUMULATING ═══
 * Upstream's guard is `self.level < self.actors_max_level`; ours is
 * `MAX_CHARACTER_LEVEL`. When it stops the loop the leftover xp is KEPT, not
 * zeroed — same as upstream, which simply stops looping. It is what the panel
 * draws as a full bar at level 10, and zeroing it would make a capped character
 * flicker back to an empty bar after every kill.
 *
 * A negative `award` is clamped at the bottom by `Math.max(0, ...)` (line 97):
 * xp can be drained (damage_types.lua:2417 does exactly that) but never below
 * zero, and draining never un-levels anybody.
 *
 * @param level current level.
 * @param xp current PER-LEVEL xp — never a cumulative total.
 * @param award xp to add. May be negative.
 */
export function gainExp(level: number, xp: number, award: number): ExpGain {
  // ActorLevel.lua:97 — the floor is on the SUM, so a drain larger than the
  // balance empties it rather than going negative.
  let nextXp = Math.max(0, xp + award);
  let nextLevel = level;
  let levelsGained = 0;

  // ActorLevel.lua:98-106. `while`, not `if` — see the docblock.
  while (nextLevel < MAX_CHARACTER_LEVEL && nextXp >= expChart(nextLevel + 1)) {
    nextLevel = nextLevel + 1;
    // ActorLevel.lua:104 subtracts AFTER the increment, so the threshold spent
    // is `expChart(newLevel)` — the same number the comparison just used.
    nextXp = nextXp - expChart(nextLevel);
    levelsGained = levelsGained + 1;
  }

  return { level: nextLevel, xp: nextXp, levelsGained };
}

/**
 * Talent points granted on REACHING `level`. One per level, two on every fifth.
 *
 * Actor.lua:3749-3752, the surviving half of `Actor:levelup()`:
 *
 *     self.unused_talents = self.unused_talents + 1
 *     self.unused_generics = self.unused_generics + 1
 *     if self.level % 5 == 0 then self.unused_talents = self.unused_talents + 1 end
 *     if self.level % 5 == 0 then self.unused_generics = self.unused_generics - 1 end
 *
 * ═══ WHAT WAS DROPPED, AND WHY EACH ═══
 *
 *   `unused_generics` AND ITS -1 SWAP (:3750, :3752). ToME runs TWO pools: class
 *   points and generic points, and every fifth level moves one from the generic
 *   pool to the class pool. That needs a generic/class TREE SPLIT to spend
 *   against, and we have one book of four class talents. With no generic tree,
 *   a generic pool is a currency with nothing to buy.
 *
 *   CATEGORY POINTS at levels 10, 20 and 36 (:3758-3760). They buy a NEW TREE.
 *   There are no new trees; `ClassDef.loadout` is exactly four talents.
 *
 *   PRODIGIES at 30 and 42 (:3761-3766). Above our cap of 10 — unreachable, so
 *   porting them would be porting dead code with a dialog attached.
 *
 *   STAT POINTS, `unused_stats + (stats_per_level or 3)` (:3748). A second spend
 *   screen against six stats, and this pass ships one panel. Out of scope, not
 *   rejected — when it lands it is one more line here.
 *
 *   THE LEVEL-50 BONUS (:3767-3774). Above the cap, same as prodigies.
 *
 * ═══ AND THE BIRTH GRANT OF 2 IS DROPPED TOO — Actor.lua:171 ═══
 *     self.unused_talents = self.unused_talents or 2
 * ToME hands a fresh character 2 spare points ON TOP of its free birth talents
 * (data/birth/classes/warrior.lua:80-86 hands a Berserker five outright, at
 * level 1, before the 2 points are counted). It can afford to, because it has
 * DOZENS of talents to spend them on. **Our four loadout talents,
 * already learned at level 1, ARE our birth grant** — the equivalent gift, paid
 * in talents instead of points.
 *
 * The budget is why it matters and it is arithmetic, not taste: levels 2-10 give
 * 9 points, levels 5 and 10 give 2 more, so 11 points against 4 talents × 4
 * upgrade steps = 16 purchasable steps. 11/16 = 69%, so every player finishes an
 * evening with about five steps unbought and had to CHOOSE which. Add the birth
 * 2 and it is 13/16 = 81%, at which point there is nothing to decide and the
 * panel is a checklist you tick until it is empty.
 *
 * @param level the level just REACHED. Level 1 grants nothing — it is where a
 *   character starts, not somewhere it levelled up to.
 */
export function pointsForLevel(level: number): number {
  if (level <= 1) return 0;

  // Actor.lua:3749 — the flat point.
  let points = 1;

  // Actor.lua:3751 — and one more on every fifth level.
  if (level % 5 === 0) points = points + 1;

  // Actor.lua:3768 — and three more at the cap. See `CAP_BONUS_CLASS_POINTS`.
  if (level === MAX_CHARACTER_LEVEL) points = points + CAP_BONUS_CLASS_POINTS;

  return points;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE LAST LEVEL PAYS A BONUS. Actor.lua:3767-3774.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     if self.level == 50 then
 *         self.unused_stats    = self.unused_stats    + 10
 *         self.unused_talents  = self.unused_talents  + 3
 *         self.unused_generics = self.unused_generics + 3
 *
 * ON TOP of the ordinary grant for that level rather than instead of it, so
 * reaching the cap hands over its usual 2 class / 0 generic / 3 stats and then
 * 3 + 3 + 10 again. Upstream pops a dialog about it, and that is the point: the
 * last level is an EVENT, not the moment the numbers quietly stop moving.
 *
 * ═══ `MAX_CHARACTER_LEVEL`, NOT A LITERAL 50 ═══
 * Upstream writes `self.level == 50` because 50 is its cap. The INTENT is "the
 * final level", and this project has already moved its cap once — from 10 to 50,
 * which is the only reason this bonus is reachable at all. Writing the literal
 * would make the next move silently drop it into the middle of the game, where
 * it means nothing and nobody would notice for months.
 *
 * ═══ AND IT LIVES IN THE PURE FUNCTIONS, NOT IN THE SCHEDULER ═══
 * The level-up loop crosses one level at a time and asks these three what that
 * level is worth. Putting the bonus here makes it testable without a world,
 * routes it through the same path every other point takes, and means a body that
 * crossed two levels in one award cannot miss it.
 */
export const CAP_BONUS_STATS = 10;
export const CAP_BONUS_CLASS_POINTS = 3;
export const CAP_BONUS_GENERIC_POINTS = 3;

/**
 * Every point a character of `level` has ever been granted, spent or not: the
 * sum of `pointsForLevel` over 2..level.
 *
 * Kept as a loop over the per-level function rather than a closed form, because
 * the closed form (`(level - 1) + floor(level / 5)`) silently stops agreeing the
 * moment `pointsForLevel` grows a clause, and it is nine iterations at most.
 *
 * This is the LEDGER, and it is what makes the persisted shape safe: saves store
 * the RAW per-talent points, never the unspent count (docs/data-schemas.md § 1,
 * "NEVER persist a derived value"), so unspent is recomputed on load as
 * `totalPointsAtLevel(level) - (sum of raw points spent)`. Retuning this grant
 * therefore corrects every existing character instead of stranding them.
 *
 * At `MAX_CHARACTER_LEVEL` it is 11 — 9 from levels 2-10, plus 1 each at 5 and 10.
 */
export function totalPointsAtLevel(level: number): number {
  let total = 0;
  for (let l = 2; l <= level; l++) {
    total = total + pointsForLevel(l);
  }
  return total;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SECOND POOL. `unused_generics` — Actor.lua:3750, :3752.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream hands out TWO talent currencies on every level-up, and this game
 * shipped only one:
 *
 *     self.unused_talents = self.unused_talents + 1
 *     self.unused_generics = self.unused_generics + 1
 *     if self.level % 5 == 0 then self.unused_talents  = self.unused_talents  + 1 end
 *     if self.level % 5 == 0 then self.unused_generics = self.unused_generics - 1 end
 *
 * `pointsForLevel` above is the FIRST of those, and has been correct all along
 * — one a level, two on every fifth. This is the second, and it is the mirror:
 * one a level, and NONE on every fifth, because the fifth-level bonus is paid
 * for by taking the generic away.
 *
 * ═══ THAT SWAP IS THE WHOLE DESIGN, NOT A ROUNDING ═══
 * The total per level never changes — it is always two. What changes is WHICH
 * pool they land in, so every fifth level is a moment where a character gets
 * deeper in their profession instead of broader as a person. It costs nothing
 * and it is what makes level 5, 10, 15 feel like milestones.
 *
 * ═══ AND IT IS WHY UPSTREAM CAN AFFORD A BORING GENERIC TREE ═══
 * `technique/combat-training` is seven talents, five of them flat numbers —
 * deliberately the least interesting tree in the game. It is acceptable there
 * because it is bought with a SEPARATE, DELIBERATELY SCARCER currency that
 * cannot be spent on anything exciting.
 *
 * This project copied that tree and not the economics, which is exactly how it
 * ended up with 57% of its talents being a number going up while competing for
 * the same points as everything else. Splitting the pools is the other half of
 * that fix.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE LEVELS THAT HAND OVER A CATEGORY POINT. Actor.lua:3757-3760, verbatim.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     -- At levels 10, 20 and 36 and then every 30 levels, we gain a new
 *     -- talent type
 *     if self.level == 10 or self.level == 20 or self.level == 36 or
 *        (self.level > 50 and (self.level - 6) % 30 == 0) then
 *
 * THE FOURTH CLAUSE IS DELIBERATELY NOT PORTED. It fires past level 50, which
 * is this game's cap — a branch that can never be taken is a line nobody can
 * test. The three that matter are here; the day a cap moves past 50, this
 * comment is the note that a fourth exists.
 *
 * ═══ THREE POINTS IN A CAREER, AND THE SCARCITY IS THE MECHANIC ═══
 * A category point buys a WHOLE DISCIPLINE — six talents nobody starts with.
 * Three across fifty levels is what makes which one a build decision rather
 * than a shopping list, and it is why upstream spends them so rarely.
 */
export const CATEGORY_POINT_LEVELS: readonly number[] = Object.freeze([10, 20, 36]);

/** Category points granted BY reaching exactly this level. 0 or 1. */
export function categoryPointsForLevel(level: number): number {
  return CATEGORY_POINT_LEVELS.includes(level) ? 1 : 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER THING A CATEGORY POINT BUYS — LevelupDialog.lua:433-437.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if not self.actor:knowTalentType(tt) then
 *   self.actor:learnTalentType(tt)                                  -- unlock
 * else
 *   self.actor.__increased_talent_types[tt] = (... or 0) + 1
 *   self.actor:setTalentTypeMastery(tt, self.actor:getTalentTypeMastery(tt) + 0.2)
 * end
 * ```
 *
 * ONE ACTION, TWO OUTCOMES, chosen by whether you already know the tree. Ours
 * only ever did the first half — `unlockTree` refuses any tree that is not
 * locked — so two of the three points a character ever sees were unspendable
 * the moment they owned every discipline they wanted.
 *
 * ═══ WHY DEEPENING IS WORTH A WHOLE POINT ═══
 * `getTalentLevel = getTalentLevelRaw × mastery` (ActorTalents.lua:834), so
 * +0.2 is a flat 20% on every rank in that tree, present and future, everywhere
 * `combatTalentScale` is read. On a tree a character has poured points into it
 * is worth more than a sixth discipline they will spend nothing in.
 */
export const MASTERY_STEP = 0.2;

/**
 * `"You can only improve a category mastery once!"` — LevelupDialog.lua:422.
 *
 * The cap is the mechanic. Without it three points would go into one tree for
 * +0.6, which is a bigger multiplier than any class differentiation in the game
 * (the measured upstream spread tops out at 1.30) and would make the choice
 * "which tree" rather than "which three trees".
 */
export const MASTERY_DEEPEN_LIMIT = 1;

/** Every category point a character of this level has ever been granted. */
export function totalCategoryPointsAtLevel(level: number): number {
  let total = 0;
  for (const at of CATEGORY_POINT_LEVELS) {
    if (level >= at) total += 1;
  }
  return total;
}

export function genericPointsForLevel(level: number): number {
  if (level <= 1) return 0;
  // Actor.lua:3750 — the flat point, then :3752 takes it back on every fifth.
  const points = level % 5 === 0 ? 0 : 1;
  /**
   * Actor.lua:3769 — and three more at the cap.
   *
   * THE CAP IS ALSO A FIFTH LEVEL, so the last level-up pays 0 + 3 rather than
   * 1 + 3. That is upstream's arithmetic and not a rounding: the fifth-level
   * swap fires first and takes the ordinary generic point away, then the cap
   * bonus lands on top of nothing.
   */
  return level === MAX_CHARACTER_LEVEL ? points + CAP_BONUS_GENERIC_POINTS : points;
}

/** Every generic point a character of this level has been handed. */
export function totalGenericPointsAtLevel(level: number): number {
  let total = 0;
  for (let l = 2; l <= level; l++) {
    total = total + genericPointsForLevel(l);
  }
  return total;
}

/**
 * WHICH POOL A TREE IS BOUGHT FROM, and the only place that decision is made.
 *
 * Upstream keys this off `newTalentType`'s `generic = true` flag. Ours is the
 * tree id's namespace, which is the same information already written down:
 * `generic/groundwork` versus `watch/the-line`. One prefix, no second table to
 * keep in step with the first.
 */
export const GENERIC_TREE_PREFIX = 'generic/';

export function isGenericTree(tree: string): boolean {
  return tree.startsWith(GENERIC_TREE_PREFIX);
}

// ---------------------------------------------------------------------------
// THE ATTRIBUTES — the other half of a levelup, and ToME's numbers exactly
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE A LEVEL. `Actor.lua:3748` — `self.unused_stats + (self.stats_per_level
 * or 3)`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported verbatim rather than retuned, because the whole point of asking for
 * "attributes exactly as Tales of Maj'Eyal" is that a player who knows that
 * game already knows this one. Three points, every level, freely assignable.
 *
 * `getRankStatAdjust` IS NOT PORTED and its absence is deliberate: it hands
 * ELITE and BOSS ranks extra stats, and no player character is either. Adding
 * it would be a term that is always zero.
 */
export const STAT_POINTS_PER_LEVEL = 3;

/** How many attribute points arriving at `level` grants. Nothing at birth. */
export function statPointsForLevel(level: number): number {
  if (level <= 1) return 0;
  // Actor.lua:3767-3768 — the cap pays ten attribute points on top of its three.
  // See `CAP_BONUS_STATS`.
  return level === MAX_CHARACTER_LEVEL
    ? STAT_POINTS_PER_LEVEL + CAP_BONUS_STATS
    : STAT_POINTS_PER_LEVEL;
}

/**
 * Every attribute point a character of `level` has ever been granted.
 *
 * THE SAME LEDGER SHAPE AS `totalPointsAtLevel`, and for the reason stated
 * there: saves store the RAW per-stat points spent, never the unspent count
 * (`docs/data-schemas.md` § 1, "NEVER persist a derived value"), so unspent is
 * recomputed on load. Retuning the grant then corrects every existing character
 * instead of stranding them.
 *
 * A loop rather than `(level - 1) * 3` for the same reason too — the closed form
 * stops agreeing the moment the grant grows a clause, and it is nine iterations.
 */
export function totalStatPointsAtLevel(level: number): number {
  let total = 0;
  for (let l = 2; l <= level; l++) {
    total = total + statPointsForLevel(l);
  }
  return total;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR AND THE CEILING — `load.lua:182-189`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ActorStats:defineStat(name, short, 10, 1, 100, ...)`: base ten, minimum one,
 * maximum one hundred, for all six and for Luck.
 *
 * ═══ THIS IS THE OUTER BOUND, NOT THE ONE THAT BINDS ═══
 * `statCeilingForLevel` below is the one a player meets. 100 is the floor and
 * ceiling of the STAT ITSELF and would still be right if every other rule went
 * away, so it stays here as its own fact.
 *
 * ═══ WHAT THIS COMMENT USED TO SAY, AND WHY IT WAS WRONG ═══
 * It read: *"Both belong to the AUTO-LEVELLER — the build order a player can
 * hand the game — and neither binds a human spending their own points. Porting
 * them as hard rules would forbid a build ToME allows."*
 *
 * That was written from `Actor.lua:755-756` alone, which IS the auto-leveller.
 * The same two clauses are also in `LevelupDialog:incStat` (:255, :259) — the
 * `+` button a human presses — where they refuse with player-facing text:
 * *"You cannot increase this stat further until next level!"*. The dialog paints
 * the row green when either binds (:584, :593, :610-616), so upstream not only
 * enforces it on the human, it puts it on screen before the press.
 *
 * CLAUDE.md's rule decided this: when a document and the Lua disagree, the Lua
 * wins. The document here was one of ours.
 */
export const STAT_MIN = 1;
export const STAT_MAX = 100;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW HIGH ONE ATTRIBUTE MAY GO AT THIS LEVEL — LevelupDialog.lua:255-260.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT IS THE REASON A LEVEL-2 CHARACTER IS NOT A SPECIALIST YET ═══
 * Without it, three points a level all go into one attribute and a level-2
 * character is as strong in one direction as a level-6 one — which is the
 * fifteen years of tuning this port exists to inherit, thrown away for the sake
 * of a missing line. Upstream's shape is: SPREAD EARLY, SPECIALISE LATE.
 *
 * ═══ TWO CLAUSES, MINIMUM WINS ═══
 * `level * 1.4 + 20` is the per-level pace. `60 + max(0, level - 50)` is the
 * lifetime bound, which only starts moving past level 50. Upstream tests them
 * separately so it can say two different sentences; `AdvanceActor.lua:291`
 * composes exactly this minimum when it needs one number, which is what this is.
 *
 * ═══ NOT FLOORED HERE ═══
 * `1.4` makes fractional ceilings — 21.4 at level 1 — and the comparison is
 * `>=`, so a base of 21 may still be raised and 22 may not. Flooring would
 * change that boundary by one at every level where the fraction is not zero, so
 * the fraction is kept and the caller compares against it directly.
 */
export function statCeilingForLevel(level: number): number {
  return Math.min(level * 1.4 + 20, 60 + Math.max(0, level - 50));
}

/**
 * May this character put another point into a stat whose BASE is `base`?
 *
 * ═══ `base`, NOT THE COMPOSED VALUE, AND UPSTREAM IS EXPLICIT ═══
 * Every one of these comparisons is `getStat(sid, nil, nil, true)` — the fourth
 * argument is `no_inc`, which drops `inc_stats`: gear, effects, everything worn.
 * So the ceiling is on what the player has BOUGHT, and wearing a good coat can
 * never cost you the ability to spend a point you own.
 *
 * This function used to take the composed value and argue for it — *"a cap on
 * the delta would let a character in good armour pass a limit a naked one could
 * not"*. That reasoning is sound and upstream chose the opposite trade, on
 * purpose, and while the only cap was an unreachable 100 the difference could
 * not be observed. It can now.
 *
 * PURE, AND IT ANSWERS ONLY THE CEILING. Whether a point is in hand is the
 * caller's ledger question — `totalStatPointsAtLevel` minus what is spent — and
 * keeping the two apart is what lets the client grey a `+` without a second copy
 * of the ledger.
 */
export function canRaiseStat(base: number, level: number): boolean {
  return base < STAT_MAX && base < statCeilingForLevel(level);
}

// ---------------------------------------------------------------------------
// ANTI-STAIRSCUM — Game.lua:868-884
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW LONG THE STAIRS ARE SHUT AFTER A KILL, in GAME TURNS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT STOPS ═══
 * Stairscumming: walk in, kill the first thing, walk straight back out, walk in
 * again to a freshly generated floor. It turns a delve into a slot machine —
 * the player takes every easy fight and pays for none of the hard ones — and it
 * is the single oldest exploit in the genre.
 *
 * ═══ THE NUMBER IS UPSTREAM'S NORMAL DIFFICULTY ═══
 * `noStairsTime` returns `nb * 10` engine turns with `nb = 2` on Normal
 * (Game.lua:868-876), and ten engine turns is one game turn — the same
 * `TICKS_PER_GAME_TURN` this codebase already runs on. So: two game turns.
 *
 * The other four difficulties (0 on Easy, 3 on Nightmare, 5 on Insane, 9 on
 * Madness) have NO REFERENT HERE — this game ships one difficulty, which
 * `docs/game-design.md` settled — so porting the table would be four dead
 * branches and a knob nobody can turn.
 *
 * ═══ IT IS SHORT ON PURPOSE ═══
 * Two turns is long enough that leaving is a decision and short enough that it
 * never feels like a lock. Upstream tuned it there over fifteen years, and the
 * temptation to "make it meaningful" by raising it is the temptation to punish
 * the ordinary case in order to close an exploit the number already closes.
 */
export const NO_STAIRS_GAME_TURNS = 2;

/**
 * How many game turns are left before this body may change level, or 0.
 *
 * PURE, so the refusal the server sends and any affordance a client draws are
 * one arithmetic rather than two. Upstream computes its own remaining count for
 * exactly the same reason: the refusal names it (`:881`), because "not yet" with
 * no number is a rule a player cannot plan around.
 *
 * @param lastKillTurn the game turn a kill was credited on, or undefined for a
 *   body that has not killed anything — which is most bodies, most of the time.
 */
export function stairsLockedFor(lastKillTurn: number | undefined, now: number): number {
  if (lastKillTurn === undefined) return 0;
  // `>=` MATCHES UPSTREAM'S COMPARISON (`last_kill_turn >= turn - noStairsTime`),
  // so the turn of the kill itself counts as one of the two.
  const until = lastKillTurn + NO_STAIRS_GAME_TURNS;
  return now >= until ? 0 : until - now;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MUCH A HOSTILE RECOVERS WHILE YOU ARE AWAY — Game.lua:1369-1388.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE OTHER HALF OF ANTI-STAIRSCUM, AND THE HALF THAT MATTERS MORE ═══
 * `NO_STAIRS_GAME_TURNS` stops you leaving IMMEDIATELY. This stops you gaining
 * by leaving at all: soften a room, walk out, rest to full outside, walk back in
 * to the same half-dead monsters with their cooldowns still spent and your
 * debuffs still on them. That is a fight paused rather than a fight fled, and
 * `Realm.sealed` already names the failure in those words — it just closes it for
 * roaming encounters alone, by sealing them, and leaves every site open.
 *
 * ═══ A TENTH OF MAXIMUM PER GAME TURN AWAY, CAPPED AT FULL ═══
 * Upstream: `perc = bound(floor((turn - last_turn) / 10), 0, 10)` then
 * `life + max_life * perc / 10`. Its `turn` is engine ticks and ten of those are
 * one game turn, so `perc` IS game turns away — capped at ten, which is the
 * point at which a monster is simply whole again.
 *
 * ═══ A FRACTION AND NOT AN AMOUNT ═══
 * The caller has `maxHp` and this does not; keeping it a fraction is what makes
 * the rule testable without a body, and it is the same split `restBonus` makes.
 *
 * @param turnsAway game turns since the last body left. Negative or fractional
 *   input is floored and clamped, because a clock that went backwards across a
 *   reconnect must not heal anybody by a negative amount.
 */
export function reentryHealFraction(turnsAway: number): number {
  if (!Number.isFinite(turnsAway)) return 0;
  const turns = Math.min(10, Math.max(0, Math.floor(turnsAway)));
  return turns / 10;
}
