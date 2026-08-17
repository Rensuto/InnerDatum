// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/npcs/ant.lua:24-43 (BASE_NPC_ANT)
//                                                              :53-60 (giant brown ant)
//             t-engine4 game/modules/tome/data/general/npcs/losgoroth.lua:22-57 (BASE_NPC_LOSGOROTH)
//                                                                        :59-70 (losgoroth)
//             t-engine4 game/modules/tome/data/general/npcs/ghoul.lua:49-116 (the ghoul ladder)
//             t-engine4 game/modules/tome/data/talents/misc/npcs.lua:723-747 (T_VOID_BLAST)
//                                                              :739 (the orb's own damage —
//                                                              `combatTalentSpellDamage(t, 15, 240)`,
//                                                              which is NOT losgoroth.lua:30)
//             t-engine4 game/modules/tome/class/interface/Combat.lua:1774-1779
//                                                              (combatTalentSpellDamage)
//             t-engine4 game/modules/tome/data/birth/classes/*.lua (22 `max_life` entries — the
//             level-1 body scale the orb's damage is normalised against)
//             t-engine4 game/modules/tome/class/Actor.lua:3881-3885 (Constitution's +4 life/point,
//             the other half of that anchor)
//             t-engine4 game/engines/default/engine/ai/talented.lua:115-132 (ai_state.talent_in)
//             t-engine4 game/engines/default/engine/interface/ActorTalents.lua:987-991
//                                                              (getTalentProjectileSpeed)
//             t-engine4 game/modules/tome/class/Actor.lua:1198-1204 (boss_rank_circles — the
//             under-token ring keyed off `rank`, which is what ui_token_ring_elite.png is)
//                                       :1701-1751 (the rank ladder: stat, level and life adjust)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                     THE M3 ROSTER — THREE TEMPLATES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PLAN.md § M3 asks for "three enemy types (melee chaser, ranged kiter, one
 * elite)". That is exactly what is here and no more:
 *
 *   index_husk        melee chaser   the baseline everything else is measured against
 *   index_wraith      ranged kiter   the reason positioning exists
 *   index_husk_elite  melee chaser   the same creature with a threat behaviour
 *
 * A template is DATA. It carries no behaviour: `ai/npc.ts` owns what a profile
 * does and `engine/combat.ts` owns what a swing does. This file's whole job is
 * to say which numbers those two read, and where each number came from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE NUMBERS COME FROM — AND THIS FILE ONCE SAID SOMETHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * READ THIS PARAGRAPH BEFORE TRUSTING ANY OLDER COMMENT YOU FIND IN GIT HISTORY
 * FOR THIS FILE. Until this revision the header argued that the author's own
 * Outer Index enemy JSON supplied IDENTITY and ToME supplied only the SHAPE —
 * a mapping table with `max_hp` → `max_life`, `attack_power` → `combat.dam`,
 * `move_speed` (px/s) → `global_speed_base`, and a row reading
 * "`aggro_radius` — AUTHORED HERE: source is all 0". Every stat on all three
 * creatures was then hand-authored under a rule about primaries staying at base
 * 10 "unless the creature's own description demands otherwise".
 *
 * That argument is now WITHDRAWN, not merely stale. Hand-authoring numbers on
 * top of a faithfully ported formula engine is reinventing the wheel: ToME ships
 * a bestiary that has been tuned against these exact formulas for fifteen years,
 * and a hand-made mapping table cannot be tuned against anything. The direction
 * is inverted:
 *
 *   ToME SUPPLIES THE NUMBERS. WE SUPPLY THE IDENTITY.
 *
 * The identity half is `id`, `displayName`, `description` and `sprite`, plus the
 * damage TYPE where it carries meaning. Those four fields are byte-identical to
 * what they were before this revision and they are the author's own; nothing in
 * ToME's setting, naming or flavour text is copied (CLAUDE.md, the licensing
 * note: take the NUMBERS and the BEHAVIOUR, the identity stays ours). Everything
 * else — stats, armour, defence, weapon rating, accuracy, armour penetration,
 * resists, speed, sight radius and AI cadence — is lifted from a real upstream
 * NPC entry with a `file:line` citation and the upstream field name kept verbatim
 * in the comment so `grep resolvers.mbonus reference/t-engine4` still finds the
 * source in six months.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ADOPTION TABLE — WHICH UPSTREAM CREATURE EACH SLOT TOOK
 * ───────────────────────────────────────────────────────────────────────────
 *
 * | ours              | upstream                | why that one                  |
 * |-------------------|-------------------------|-------------------------------|
 * | `index_husk`      | giant brown ant         | ToME's own first-floor melee  |
 * |                   | ant.lua:53-60 on        | trash: `level_range = {1, 15}`,|
 * |                   | BASE_NPC_ANT :24-43     | `rarity = 1`, rank 1, and     |
 * |                   |                         | `global_speed_base = 0.9` —   |
 * |                   |                         | upstream's own way to write   |
 * |                   |                         | "slow and hollow".            |
 * | `index_wraith`    | losgoroth               | a rank-2 void elemental that  |
 * |                   | losgoroth.lua:59-70 on  | grants exactly one bolt talent|
 * |                   | BASE_NPC_LOSGOROTH      | (T_VOID_BLAST) and buys its   |
 * |                   | :22-57, plus            | survival with DODGE not       |
 * |                   | misc/npcs.lua:723-747   | armour. `level_range = {1,nil}`|
 * | `index_husk_elite`| the ghoul → ghast →     | ToME's cleanest three-tier    |
 * |                   | ghoulking ladder        | ladder of the SAME creature,  |
 * |                   | ghoul.lua:49-116        | which is what an elite is here|
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ELITE IS A DELTA, NOT A COPY
 * ───────────────────────────────────────────────────────────────────────────
 * `index_husk_elite` does NOT adopt the ghoulking's absolute numbers — a
 * level-15 rank-3 undead dropped onto floor one would be a different game. It
 * adopts the ghoul→ghoulking DELTA and applies it to the husk's own block:
 *
 *   | field   | ghoul (:63, :55) | ghoulking (:101, :93) | delta   | husk → elite |
 *   |---------|------------------|-----------------------|---------|--------------|
 *   | `dam`   | 10               | 30                    | ×3      | 5 → 15       |
 *   | `atk`   | 5                | 8                     | +3      | 15 → 18      |
 *   | `apr`   | 3                | 4                     | +1      | 7 → 8        |
 *   | `armor` | 2                | 3                     | +1      | 1 → 2        |
 *   | `def`   | 7                | 10                    | +3      | 1 → 4        |
 *
 * `dam` is a RATIO and the other four are ADDITIVE because that is how the two
 * numbers actually relate upstream, not because it was convenient: 10 → 30 is a
 * clean tripling while 5 → 8 is not a clean anything. Every field the ladder
 * does NOT move — stats, `infravision`, `global_speed_base`, `max_life` — the
 * elite inherits from the husk unchanged, which is why the elite is 0.9 speed
 * and sight 10 exactly like the creature it upgrades.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SEVEN DELIBERATE DEVIATIONS, ALL OF THEM LIVE FIELDS
 * ───────────────────────────────────────────────────────────────────────────
 * Numbered here so a reader can find all seven in one place and so nobody has to
 * grep for the word "invented" to know what is ours. THIS LIST USED TO SAY
 * THREE, and the missing three were documented only at their own site — which is
 * a trap for the next re-base pass, because a reader who trusts a short list
 * takes upstream's numbers for everything it does not name and quietly restores
 * an aggro of 10 and a reach of 10 on the creature this work item exists to calm
 * down. Every field below deviates from a real upstream number:
 *
 *   1. `maxHp` ON TWO OF THE THREE, NOT ALL THREE ANY MORE. THE WRAITH'S IS NOW
 *      A PORT: 50, from losgoroth.lua:63 `max_life = resolvers.rngavg(40,60)`.
 *      The husk's 25 sits INSIDE ant.lua:59's own `rngavg(15,30)` band, so it
 *      needs no defence beyond the citation. The elite's 60 is the only one that
 *      contradicts its source (the ghoul ladder holds `rngavg(90,100)` across
 *      all three tiers) and it is argued at that template's header.
 *   2. THE WRAITH'S `globalSpeed` STAYS 0.84. Upstream's losgoroth has no
 *      `global_speed_base` at all, i.e. 1.0. HELD, with the measurement, at the
 *      field: 1.0 buys +19% damage and costs the "you can corner it" property.
 *   3. THE WRAITH'S `minRange` 2 STAYS. ToME has no dead zone whatsoever; its
 *      ranged tactic preset is `escape=3, closein=0` (tome/resolvers.lua:901)
 *      and its bolt talents have `range` but no minimum. Citing upstream for a
 *      dead zone would be a false citation.
 *   4. THE WRAITH'S `aggroRange` IS HELD AT 8. Upstream is losgoroth.lua:34
 *      `infravision = 10`. Full note at the field.
 *   5. THE WRAITH'S `attackRange` IS HELD AT 6. T_VOID_BLAST authors `range = 10`
 *      (misc/npcs.lua:730). Full note at the field — and read it, because the
 *      number is a legality ceiling the AI provably never reaches.
 *   6. THE WRAITH'S `Darkness: 50` RESIST IS OURS. Upstream's losgoroth.lua:46
 *      is `ARCANE = 100` and carries no darkness row at all; we do not have
 *      Arcane and would not ship a 100 on floor one if we did.
 *   7. THE WRAITH'S ORB DAMAGE — `damageMin`/`damageMax` 12-16 — IS OURS BY
 *      ARITHMETIC, and it is a CORRECTION rather than an invention. It is
 *      derived from T_VOID_BLAST at misc/npcs.lua:739 and explicitly NOT from
 *      losgoroth.lua:30's `combat` block: that block is the creature's MELEE
 *      weapon (it carries `atk`, `apr` and a `dammod`, and it is what
 *      `attackTarget` would swing), and a previous pass wired the orb to it by
 *      mistake. The whole derivation, with both citations and the body-scale
 *      factor, is written out at the field.
 *
 * One more deviation lives one file over and belongs in any reading of this
 * roster: the orb `projSpeed` puts in the air is a `bolt` and T_VOID_BLAST is a
 * `beam` (misc/npcs.lua:734, Target.lua:583-584). Ours stops on the first body
 * in the line; upstream's clips everyone it passes and flies on. It is DEVIATION
 * 1 in the header of src/server/engine/projectile.ts, with the reason.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MELEE SHEET IS LIVE. THE ORB'S DAMAGE IS A DIFFERENT FIELD, FOR GOOD
 * ───────────────────────────────────────────────────────────────────────────
 * THIS BLOCK USED TO SAY "THE SHEET IS NOT WIRED TO THE SWING YET" AND THAT IS
 * NO LONGER TRUE OF THE MELEE HALF. `scheduler.ts#strike` resolves through
 * `combat.ts#attackTarget`, so `checkHit`, armour, armour penetration, resists
 * and crit all run for a monster: every `weapon.dam` / `atk` / `apr` ported
 * below is LIVE on the attacker side, and an accuracy of 19 on the husk now
 * means the husk actually rolls it. (That was ONE change and not two — the
 * Chebyshev range check in the scheduler and the Euclidean `canAttack` had to
 * move together; the wiring note at the head of engine/combat.ts is the record.)
 *
 * THE PROJECTILE HALF IS NOT ON THAT FUNCTION AND IS NOT GOING TO BE, which is
 * why this roster's one ranged creature reads its damage out of two different
 * places. `resolveIntent` forks at scheduler.ts:1501-1502 — a monster carrying a
 * `projSpeed` returns `fire(...)` one line BEFORE `strike` is reachable — and
 * `fire` (scheduler.ts:1722) freezes `rng.int('combat.bump.damage', damageMin,
 * damageMax)` onto the orb at the muzzle. There is no to-hit roll at fire or at
 * impact and there never will be (scheduler.ts:1709): upstream's `projectile()`
 * routes straight to the DamageType projector with no `checkHit` anywhere in the
 * call graph, so counterplay against a travelling shot is 100% POSITIONAL. So:
 *
 *   `combat`                  the MELEE weapon, swung by `attackTarget`
 *   `damageMin`/`damageMax`   the ORB, frozen by `fire`
 *
 * The one thing the orb still takes off the sheet is armour penetration — `fire`
 * passes `combatAPR(sheet)` into the impact's armour stage, and for the wraith
 * that is losgoroth.lua:30's `apr = 15`. Fifteen exceeds every class's armour
 * (Watchman 6, Inspector 0, Alchemist 0 — content/classes.ts), so an orb arrives
 * UNMITIGATED against all three and the damage table on the wraith below is one
 * number rather than three. That lands on upstream's shape with room to spare
 * rather than by luck: a ToME spell is never reduced by armour at all, because
 * `attackTargetWith` is the only function in the game that applies it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO METRICS, AND WHY EACH TEMPLATE CARRIES TWO RANGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME measures MOVEMENT in Chebyshev (a diagonal step costs the same as an
 * orthogonal one — Astar.lua) and RANGE in Euclidean (`core.fov.distance`; see
 * the header of engine/combat.ts). This port keeps both, so every template
 * declares both:
 *
 *   `attackRange`  CHEBYSHEV. What the scheduler's legality check and the AI's
 *                  chase band read. For melee it is 1, which IS the Moore
 *                  neighbourhood and is what makes bump-attack work.
 *   `combat.range` EUCLIDEAN. What `canAttack` refuses on.
 *
 * A melee template therefore declares `combat.range` **1.5**, not 1: the four
 * diagonal neighbours sit at √2 = 1.4142, and a Euclidean reach of exactly 1
 * would refuse every diagonal melee attack in the game while the scheduler
 * happily accepted it. 1.5 is the radius that makes the circle equal the Moore
 * neighbourhood — it contains 1.4142 and excludes the nearest non-neighbour at
 * 2.0. `validateTemplate` enforces it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SYNCHRONOUS AND PURE
 * ═══════════════════════════════════════════════════════════════════════════
 * Frozen literals and two total functions over them. Nothing here reads a clock,
 * draws a random number, or touches the world; `monsterInit` returns a plain
 * `MonsterInit` so this module never has to import `world/`. The three
 * `resolve*` helpers it calls are pure and RNG-free by construction — see the
 * header of content/resolvers.ts for the half of each that was NOT ported.
 */

import { AiProfile } from '../engine/actor.ts';
import { DamageType } from '../engine/damage.ts';
import { ActorRank } from '../../shared/protocol.ts';
import { ITEMS, itemById } from './items.ts';
import { resolveLevelup, resolveMBonus, resolveRngAvg } from './resolvers.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { MonsterInit } from '../engine/actor.ts';
import type { CombatSheet } from '../engine/combat.ts';
import type { ItemTier } from './items.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WHOLE DROP TABLE, WRITTEN AS ONE WORD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Item.tier` was authored to BE the drop table (content/items.ts's own header
 * says so): common is every LEGS and FEET item plus the leather chest, uncommon
 * is every HEAD, OFFHAND and TRINKET, rare is the three class BODY items and the
 * three RINGs. Selecting on the tier rather than listing 22 ids again keeps the
 * table in exactly ONE place — a second hand-written list is a second thing to
 * forget when an item is added, and the failure mode is silent (a new item that
 * can be worn and can never drop).
 *
 * ORDER IS `ITEMS` ORDER, WHICH IS FROZEN CATALOGUE ORDER, and that is
 * load-bearing rather than tidy: the pick draw below is an INDEX into this array
 * (resolvers.lua:434 `rng.range(1, #t)`), so re-ordering the catalogue would
 * change which item every past seed produces. `Array.prototype.filter` preserves
 * source order by specification, so this is stable as long as `ITEMS` is.
 */
function idsOfTier(tier: ItemTier): readonly string[] {
  return Object.freeze(ITEMS.filter((item) => item.tier === tier).map((item) => item.id));
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/**
 * One authored creature.
 *
 * A subset of `MonsterDef` in docs/data-schemas.md § 4 — the fields this build
 * can actually consume.
 *
 * ═══ THIS PARAGRAPH USED TO SAY THERE WAS NO LOOT SYSTEM. THERE IS ONE NOW. ═══
 * Verbatim, until this revision: *"`talentIds`, `lootTable`, `xpReward` and
 * `saves` are all in that schema and none of them have a consumer yet; adding
 * them here would be writing content for a system that does not exist."* That
 * was true and it is now false for exactly one of the four. `drops` below has a
 * consumer — `content/encounter.ts` rolls it at spawn and
 * `engine/scheduler.ts#noteCasualty` spills the result — so it is authored here
 * and the other three stay absent for the reason the old sentence gave.
 *
 * The field is called `drops` and not `lootTable` on purpose: it is a port of
 * ToME's `resolvers.drops` (modules/tome/resolvers.lua:420-450) and keeping the
 * upstream word is what makes `grep -rn 'resolvers.drops' reference/t-engine4`
 * still find the source in six months (CLAUDE.md, "keep ported names verbatim").
 */
export type MonsterTemplate = {
  /** Matches the Outer Index content id, so the two rosters stay greppable. */
  readonly id: string;
  readonly displayName: string;
  /** The source `description`, verbatim where one exists. Drives nothing; read it anyway. */
  readonly description: string;
  /** An asset KEY, never a path — the client owns the manifest (protocol.ts). */
  readonly sprite: string;
  /** Drives the under-token ring. Actor.lua:1198-1204. */
  readonly rank: ActorRank;

  // --- vitals ---------------------------------------------------------------
  readonly maxHp: number;
  /** Per GAME TURN, on the base clock. 0 for everything in this roster. */
  readonly hpRegen: number;

  // --- speed (both directions of ToME's model; D1 pins only players) ---------
  /** Energy GAIN multiplier — `global_speed_base` (ant.lua:58). */
  readonly globalSpeed: number;
  /** Action COST multiplier. 1 for everything in M3. */
  readonly speedFactor: number;

  // --- AI -------------------------------------------------------------------
  readonly profile: AiProfile;
  /** CHEBYSHEV. How far it notices a player. Line of sight is also required. */
  readonly aggroRange: number;
  /** Where a kiter wants to stand. A melee profile leaves this at 1. */
  readonly preferredRange: number;
  /** The dead zone. Closer than this and a kiter gives ground. 0 for melee. */
  readonly minRange: number;
  /** CHEBYSHEV reach — the scheduler's check and the AI's chase band. */
  readonly attackRange: number;
  /** ELITE: hunt the most isolated hostile rather than the nearest. */
  readonly huntsIsolated: boolean;
  /** ELITE: consecutive blocked turns before routing around its own kin. 0 = never. */
  readonly shoulderAfter: number;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `proj_speed` — TILES PER GAME TURN, NOT ACTIONS PER TURN
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * How fast this creature's ranged attack TRAVELS. ABSENT MEANS INSTANTANEOUS,
   * which is precisely what every attack in this game does today, so a template
   * that omits it is byte-for-byte unchanged in behaviour. That is upstream's own
   * design and not a compatibility shim — `proj_speed` is OPT-IN PER TALENT:
   *
   *     -- engines/default/engine/interface/ActorTalents.lua:987-991
   *     function _M:getTalentProjectileSpeed(t)
   *         if not t.proj_speed then return nil end
   *         ...
   *
   * and tome/class/Actor.lua:6272-6274 prints the tooltip line as literally
   * "Travel Speed: instantaneous" when the field is absent. Most bolts in ToME
   * arrive the instant they are cast; the ones that travel say so.
   *
   * ═══ THE UNIT, WHICH IS THE ONE THING TO GET WRONG ═══
   * NB this is the SAME MULTIPLIER as `EnergyActor.energyMod` and a DIFFERENT
   * UNIT BY CONVENTION ONLY. `energyMod` 6 on a monster means six ACTIONS per
   * game turn; `projSpeed` 6 on an orb means six TILES per game turn. The
   * arithmetic underneath is identical — a projectile spends one action's worth
   * of energy per tile it crosses (Projectile.lua:142, :168-172) — so
   * tiles-per-turn falls out of the energy loop we already ported at
   * src/shared/energy.ts:236-238 with no new maths. It is only the WORD for what
   * one action buys that changes.
   */
  readonly projSpeed?: number;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `ai_state.talent_in` — A 1-IN-N CHANCE PER TURN, NOT A CADENCE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *     -- engines/default/engine/ai/talented.lua:122
   *     if ... rng.chance(self.ai_state.talent_in or 6) ... then
   *
   * and upstream's own comment two lines above it, at :115:
   * "Attempts to use a talent (chance in self.ai_state.talent_in <default 6)".
   *
   * ANYONE WHO READS THIS AS "ONE CAST EVERY N TURNS" MIS-PREDICTS DPS BY A
   * FACTOR OF TWO in the tail and gets the feel completely wrong: a cadence is a
   * metronome the player can count, and a 1-in-2 chance is a coin the player
   * cannot. `talent_in = 2` fires twice in a row about a quarter of the time and
   * goes quiet for three turns about an eighth of the time, and that unevenness
   * is the thing that makes a ranged monster feel like a threat rather than like
   * a timer.
   *
   * ABSENT means "every turn", which is both the current behaviour and the exact
   * meaning of upstream's own `talent_in = 1` (`rng.chance(1)` is always true),
   * so omitting it costs no draw and shifts no seeded stream.
   */
  readonly talentIn?: number;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ORB'S FROZEN DAMAGE. NOT THE MELEE SWING'S — SEE THE FILE HEADER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The inclusive bounds of the ONE labelled draw `scheduler.ts#fire` takes at
   * the muzzle: `rng.int('combat.bump.damage', damageMin, damageMax)`, frozen
   * onto the projectile and carried to impact whatever happens to the shooter in
   * between. `combat` below drives the MELEE swing and has nothing to do with
   * these two.
   *
   * ONLY A CREATURE WITH A `projSpeed` EVER READS THEM, and only that creature
   * should author them. Absent → `actor.ts`'s `DEFAULT_MONSTER_DAMAGE_MIN..MAX`
   * 3-6, which is a placeholder and is documented there as one. A melee template
   * leaving both absent is therefore correct and costs nothing: `fire` is
   * unreachable for it (scheduler.ts:1501).
   *
   * BOTH OR NEITHER, and `validateTemplate` enforces it — a template with only a
   * minimum would silently inherit a maximum of 6 from a constant in another
   * file, which is exactly the class of bug the whole re-base exists to remove.
   */
  readonly damageMin?: number;
  /** As above. `validateTemplate` refuses a max below the min: `rng.int` throws. */
  readonly damageMax?: number;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS CREATURE MIGHT BE CARRYING WHEN IT DIES — ROLLED AT SPAWN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * -- modules/tome/resolvers.lua:427-434, the whole mechanism
   * function resolvers.calc.drops(t, e)
   *     t = t[1]
   *     if not rng.percent(t.chance or 100) then return nil end   -- :429
   *     for i = 1, (t.nb or 1) do
   *         local filter = table.clone(t[rng.range(1, #t)])       -- :434
   * ```
   *
   * `chance` is a PERCENT, 0-100. `pick` is upstream's array of object filters,
   * ours narrowed to item ids because our catalogue is 22 hand-authored rows and
   * has nothing to filter over. `nb` is NOT ported: upstream defaults it to 1
   * (:433) and the only rosters that raise it are money piles and bosses
   * (ant.lua:220 `nb=12`, bird.lua:68 `nb=9`), neither of which we have. AT MOST
   * ONE ITEM PER CREATURE, always.
   *
   * ═══ THE ROLL HAPPENS AT SPAWN, NOT AT DEATH, AND THAT IS THE PORT ═══
   * `resolvers.drops` marks itself `__resolve_last = true` (:421) and runs during
   * ENTITY RESOLUTION — it creates the object straight into the monster's own
   * inventory (:441-446). `Actor:die` (class/Actor.lua:3011-3060) then spills
   * that already-decided inventory and takes NO drop-table draw at all. So the
   * faithful port and the determinism-safe port are the same port, which is the
   * happiest possible outcome for a system whose draws sit inside a kill. See
   * `content/encounter.ts` for where our two draws are taken and
   * `engine/damage.ts` for why they are emphatically not taken at the kill site.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * MONSTERS DROP. THEY NEVER WIELD. THIS IS NOT AN OVERSIGHT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * There is no `equips` field here and there must never be one. Upstream DOES
   * equip its own npcs — `data/general/npcs/ghoul.lua:124` is
   * `resolvers.equip{ {type="weapon", subtype="longsword", ...} }` — but it does
   * so INSTEAD OF AUTHORING THE STATS: the risen corpse's swing comes from the
   * longsword the resolver hands it. That is the exact opposite of what this file
   * did. The rule at the top of this header is *"ToME SUPPLIES THE NUMBERS. WE
   * SUPPLY THE IDENTITY"*, and every `dam`, `atk`, `apr`, `armour` and `def` on
   * all three templates below is a cited port of a REAL UPSTREAM NPC'S FINISHED
   * SHEET — a sheet that already has that creature's gear baked into it.
   *
   * Layering our own `wielder` tables on top would therefore double-count, and it
   * would do it silently: the husk would quietly stop being the giant brown ant
   * whose numbers the 230-line header above cites, every hp-per-player-turn
   * figure in the balance tables would become fiction, and there would be no
   * error anywhere. A creature that drops a coat it was never wearing is a
   * smaller lie than a creature whose citations no longer describe it.
   */
  readonly drops?: {
    /** Percent, 0-100. `rng.percent(t.chance or 100)`, resolvers.lua:429. */
    readonly chance: number;
    /** Item ids. The index draw's array — `t[rng.range(1, #t)]`, resolvers.lua:434. */
    readonly pick: readonly string[];
  };

  // --- combat ---------------------------------------------------------------
  /** Everything derived.ts, checkhit.ts and damage.ts read. THE MELEE WEAPON. */
  readonly combat: CombatSheet;
};

// ---------------------------------------------------------------------------
// index_husk — THE MELEE CHASER, on ant.lua's giant brown ant
// ---------------------------------------------------------------------------

/**
 * "A half-erased citizen overwritten by Index pages bleeding through the Veil.
 * Slow, hollow, and hungry for contact."
 *
 * ═══ WHY THE GIANT BROWN ANT ═══
 * It is ToME's own answer to "what does a party meet on floor one": `rank = 1`
 * (ant.lua:40), `level_range = {1, 15}` and `rarity = 1` (ant.lua:56-57), one
 * weapon, no talents, no resists, no immunities. Of the three level-1 ants it is
 * the one with `global_speed_base = 0.9` (ant.lua:58) — the white ant is 1.1 and
 * the carpenter ant is faster still — and "slower than the party" is the same
 * sentence as "slow, hollow" in our own description. The creature and the
 * adjective arrived together rather than being fitted to each other.
 *
 * The baseline. Every other number in this file is legible only as a comparison
 * against this one, so it is the one that must be plain.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 19 · defence 1 · damage 5.9979 → rolls a flat 5 · crit 1% · armour 1
 *
 * Those first two moved a long way in the re-base (from 2 and 0) and the reason
 * is `atk = 15` on the ant's weapon: ToME gives its low-level trash real
 * accuracy and then makes it survivable by giving it very little damage. The
 * hand-authored version had that backwards. BOTH NUMBERS ARE LIVE — `strike`
 * runs `attackTarget` now — and they are what the whole roster is measured
 * against, so they are also the top row of the balance table on the wraith:
 *
 *   hp PER PLAYER TURN, adjacent, standing still, after the swing went live
 *   ─────────────────────────────────────────────────────────────────────────
 *     vs Watchman (def 4, armour 6 @ 40% hardiness)   88% × 5.527 × 0.9 = 4.378
 *     vs Inspector (def 4, armour 0)                  88% × 5.527 × 0.9 = 4.378
 *     vs Alchemist (def 0, armour 0)                  98% × 5.527 × 0.9 = 4.875
 *
 * It used to be a flat 4.050 against everybody (3-6 with no roll, × 0.9), so the
 * baseline moved by +8% to +20% depending on who is standing there — which is
 * the first time in this game's history that who you are has changed how hard
 * you are hit.
 */
export const INDEX_HUSK: MonsterTemplate = Object.freeze({
  id: 'index_husk',
  displayName: 'Index Husk',
  description:
    'A half-erased citizen overwritten by Index pages bleeding through the Veil. ' +
    'Slow, hollow, and hungry for contact.',
  sprite: 'enemy_index_husk_s',
  rank: ActorRank.Normal,

  // DEVIATION 1 OF 7 (see the file header). Upstream is
  // ant.lua:59 `max_life = resolvers.rngavg(15,30)`, i.e. a mean of 22.5 — so 25
  // is INSIDE the giant brown ant's own band and needs no defence beyond this
  // citation. The old note here added "and the other two maxHp values are held
  // too"; that is no longer true — the wraith's is a port now — so the argument
  // stands on the band alone, which is where it should always have stood.
  maxHp: 25,
  hpRegen: 0,

  // ant.lua:58 `global_speed_base = 0.9`. Upstream's own way to say "slow", and
  // it replaces the old 76px-per-second justification entirely. A monster below
  // the party's speed is a monster you can disengage from, which is what makes
  // the FIRST creature in the game a safe place to learn that disengaging works.
  globalSpeed: 0.9,
  speedFactor: 1,

  // The Outer Index roster authored `ai_profile: "melee_chaser"` and ToME's
  // BASE_NPC_ANT authors `ai = "dumb_talented_simple"` with
  // `ai_state = { ai_move="move_complex" }` (ant.lua:33). Both name the same
  // behaviour: walk at it, hit it.
  profile: AiProfile.MeleeChaser,
  // ant.lua:38 `infravision = 10`. This REPLACES an invented 8 whose comment
  // began "INVENTED. `aggro_radius` is 0 on every Outer Index enemy" — there is
  // now an upstream number for it, so the invention comes out. Ten tiles is a
  // third of the 30x30 test map: walking into a room wakes what is in it.
  aggroRange: 10,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  huntsIsolated: false,
  shoulderAfter: 0,
  // No `projSpeed`: a melee bump has no travel time to have. No `talentIn`
  // either, and that is a faithful port rather than an omission —
  // ant.lua:33 authors `talent_in = 1`, and `rng.chance(1)` is always true, so
  // upstream's ant acts every turn exactly as ours does. Declaring 1 would cost
  // a labelled draw per turn to answer a question with one possible answer, and
  // would shift the seeded stream for every husk in the game.

  // THE COMMON TIER, ABOUT A THIRD OF THE TIME. Seven ids: every LEGS and FEET
  // item plus the leather chest (content/items.ts). The baseline creature gives
  // the baseline reward — trousers, boots, a salvaged chestpiece — and 35 is the
  // number that makes clearing the first room usually worth something and never
  // reliably worth something. Upstream's own low-tier rates sit in this band:
  // construct.lua:30 is `chance=30`, elven-caster.lua:33 is `chance=20`,
  // crystal.lua:32 is `chance=15`.
  //
  // WHAT IT IS WORTH, MEASURED AGAINST THIS CREATURE'S OWN BASELINE ROW ABOVE
  // (4.378 hp per player turn against a Watchman or an Inspector, 4.875 against
  // an Alchemist), because "a common drop" is an adjective. Every figure below is
  // computed from the shipped formulas — `ceil(50 + 2.5*(atk-def))`
  // (shared/checkhit.ts) and `max(dam*pres - max(0, armour-apr), 0) + dam*(1-pres)`
  // (damage.ts:298-301) — not estimated:
  //
  //   boots / slacks   +2 mods.def   −5.7%  (4.378 → 4.129) for anybody
  //   treads/breeches  +3 mods.def   −8.2%  on the Alchemist (4.875 → 4.475)
  //   oxfords          +3 dex        −3.4% incoming AND +5.7% outgoing
  //   leather chest    +3 armour     −35.6% ON A WATCHMAN (4.378 → 2.820)
  //                    +1 def        −3.4% on an Inspector, −3.1% on an Alchemist
  //
  // THE SPREAD IS ENORMOUS AND IT IS THE APR RULE, NOT A BALANCE MISTAKE. Armour
  // is subtracted FLAT from the hardiness-scaled slice of every blow, so the
  // three points that finally clear this creature's apr 7 are worth more than
  // everything else in the tier put together — to the one class that already had
  // six. This file's own header has said as much since the re-base:
  // `max(0, 6 - 7) = 0`.
  //
  // AND ONE PIECE IS WORTH LITERALLY NOTHING TO TWO OF THE THREE CLASSES.
  // `item_watchmans_trousers` is +2 armour: on a Watchman that is armour 6 → 8,
  // −16.7%; on an Inspector or an Alchemist it is `max(0, 2 - 7) = 0` and the
  // measured change is 0.0%. It still moves `combatArmor` on the character sheet,
  // which is what test/server/equipment.test.ts pins per item, and it is still a
  // real upgrade for the class the kit belongs to. Written down rather than
  // smoothed over: a shared floor pile means a cross-class drop is sometimes just
  // somebody else's coat, and the fix for that is the pickup being free, not
  // sprinkling +1s onto items until every number moves for everyone.
  drops: { chance: 35, pick: idsOfTier('common') },

  combat: {
    // ant.lua:34 `stats = { str=12, dex=10, mag=3, con=13 }`, VERBATIM. ToME
    // authors no `cun` on the ant, so it takes the engine base of 10
    // (load.lua:182-189) — which is why `cun` is absent below rather than 8.
    // This replaces a hand-authored 12/8/12/8 that was reasoned from our own
    // description ("hungry for contact buys +2 Strength"); the description now
    // describes the numbers instead of generating them.
    stats: { str: 12, dex: 10, con: 13, mag: 3 },
    // ant.lua:36 `combat_armor = 1, combat_def = 1`. The `def` half is NEW: the
    // old block carried armour alone, on an argument that a monster's dodge
    // should come from Dexterity only. Upstream disagrees, and one point of
    // dodge on the roster's baseline creature is what makes the elite's four
    // legible as a step rather than as an absolute.
    mods: { armour: 1, def: 1 },
    // ant.lua:37, VERBATIM including the resolver nest:
    //   combat = { dam=resolvers.levelup(resolvers.rngavg(5,5), 1, 1),
    //              atk=15, apr=7, dammod={str=0.6} }
    // The expression is written out rather than folded to 5 so it can be diffed
    // against the Lua character by character. `resolvers.levelup` returns its
    // base at level 1 and only RECORDS growth (engine/resolvers.lua:154-158),
    // which is exactly what keeps autolevel out of scope — see content/resolvers.ts.
    weapon: {
      dam: resolveLevelup(resolveRngAvg(5, 5)),
      atk: 15,
      apr: 7,
      damMod: { str: 0.6 },
    },
    // NO `profile` AT ALL, and that is a deletion with a reason. The old block
    // carried `resists { Mind: 25 }` tagged INVENTED, justified as "a husk is
    // already half-erased, so a mind attack finds less to grip". BASE_NPC_ANT
    // authors no `resists` table whatsoever — a giant brown ant resists nothing
    // — so the invention comes out with the rest of them. `resistsCap` was
    // already absent and stays absent: the ENGINE default is `{ all = 100 }`
    // (Actor.lua:211) and the familiar 70 is a PLAYER birth descriptor
    // (descriptors.lua:63) that monsters do not get.
    range: 1.5,
    minRange: 0,
    damageType: DamageType.Physical,
  },
});

// ---------------------------------------------------------------------------
// index_wraith — THE RANGED KITER, on losgoroth.lua plus its own T_VOID_BLAST
// ---------------------------------------------------------------------------

/**
 * "A cited absence given shape: pages, ink, and a detached watching glyph
 * drifting where a body should be. Hangs at the outer ring and lobs dark orbs."
 *
 * ═══ WHY THE WRAITH AND NOT THE CAIRN ═══
 * PLAN.md's M3 line offers `index_cairn` or `index_wraith` for the ranged slot.
 * The source settles it: `index_cairn` is authored as a melee chaser — it is the
 * slow grinder that shoulders into melee — while the wraith "hangs at the outer
 * ring". Taking the cairn would mean overriding the author's own AI field to
 * fill a slot the author already filled.
 *
 * ═══ WHY THE LOSGOROTH ═══
 * `level_range = {1, nil}` and `rarity = 1` (losgoroth.lua:61-62), so it is a
 * creature ToME is willing to put in front of a level-1 character. It grants
 * EXACTLY ONE talent (losgoroth.lua:67-69, `T_VOID_BLAST`), which is the whole
 * creature the way the orb is the whole wraith, and that talent is the SLOWEST
 * projectile in the game — `proj_speed = 2` at misc/npcs.lua:733. The creature
 * and its orb come as one package, which is why this slot did not go shopping
 * for a bolt from somewhere else.
 *
 * It also answers the report that started this work item. The old wraith fired
 * from six tiles, every turn, with the damage landing instantly. This one fires
 * from four, about half the time, with an orb that takes a game turn and a half
 * to arrive. TWO of those three numbers are upstream's — `safe_range = 4`
 * (tome/resolvers.lua:901) and `talent_in = 2` (losgoroth.lua:43). The flight
 * time is NOT: `proj_speed = 2` is upstream's, but the DISTANCE it crosses is
 * our own capped reach, so the turn-and-a-half is derived here and is stated
 * here rather than dressed up as a port. See the `projSpeed` field below for the
 * arithmetic at every distance the AI can actually shoot from.
 *
 * ═══ THE NUMBERS THAT MAKE IT A DIFFERENT PROBLEM ═══
 *   reach 6 (a ceiling; see `attackRange`) · stand-off 4 · dead zone 2
 *   aggro 8 · globalSpeed 0.84 · orb speed 2 tiles/turn · fires on a 1-in-2
 *   orb 12-16 · 50 life
 *
 * ═══ WHAT IT IS AND IS NOT, MEASURED ═══
 * It is a CHIP THREAT that has to be walked at, not a burst threat. Standing
 * still is punished; so is charging straight down the line, because the orb
 * tests its own tile on every act (engine/projectile.ts, DEVIATION 3) and a body
 * that walks onto it eats it. Stepping SIDEWAYS off the frozen line still dodges
 * cleanly, and that is the counterplay working rather than the creature failing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BALANCE TABLE. MEASURED AGAINST THE REAL SHEETS, NOT ESTIMATED.
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS BLOCK USED TO READ "0.84 × 0.5 × 4.5 avg = 1.89 hp … BELOW HALF the basic
 * mob", and that was a true measurement of a creature that had its orb wired to
 * a placeholder constant. It is replaced rather than edited, because every input
 * to it moved. Hp PER PLAYER TURN, against a body standing still inside the
 * band, computed over the shipped class sheets in content/classes.ts — the same
 * arithmetic is asserted in test/server/monsters.test.ts so this table cannot
 * silently rot:
 *
 *   creature            state      Watchman   Inspector   Alchemist
 *   ─────────────────   ────────   ────────   ─────────   ─────────
 *   index_husk          before        4.050       4.050       4.050
 *   index_husk          NOW           4.378       4.378       4.875
 *   index_husk_elite    before        4.050       4.050       4.050
 *   index_husk_elite    NOW           5.888       5.888       6.332
 *   index_wraith        before        1.890       1.890       1.890
 *   index_wraith        NOW           5.880       5.880       5.880
 *
 * "before" is the placeholder path: `rng.int(3, 6)` with no to-hit roll, no
 * armour and no resists, × `globalSpeed`, × the 1-in-2 cadence for the wraith.
 * The wraith is ONE number across all three classes and the husks are not,
 * because `combatAPR` of losgoroth.lua:30's `apr = 15` swallows every class's
 * armour whole — see the file header.
 *
 * WHAT THAT BUYS. The wraith:husk ratio goes 0.467 → 1.343: the designated
 * ranged threat stops being less than half as dangerous as the baseline mob and
 * becomes a third more dangerous than it. It lands one hair under the ELITE
 * (5.880 against 5.888), which is deliberate and is the top of the band rather
 * than an accident — the elite's damage is unavoidable once it has reached you
 * and it carries 60 life, while every point of the wraith's is dodgeable by
 * stepping off the line and it cannot shoot at all inside two tiles. A creature
 * whose damage is 100% positional may sit level with one whose damage is not.
 *
 * One orb is 12-16 against bars of 72 / 60 / 54, i.e. 17-22% of a Watchman,
 * 20-27% of an Inspector and 22-30% of an Alchemist: memorable, never lethal
 * from full, and four average orbs put an Alchemist on the floor. THE THREE
 * STACKED NERFS this creature took when it was re-based — travel time, the
 * 1-in-2 cadence, and the stand-off moving 6 → 4 — are now paid for, and they
 * are paid for out of the orb and the life bar rather than by un-porting any of
 * them. Do not "fix" this creature by touching `talent_in`.
 *
 * `minRange 2` is the whole class. A wraith CANNOT shoot something standing on
 * it, so a Watchman who closes the gap turns it off; `ai/npc.ts` retreats rather
 * than firing point-blank and `canAttack` refuses the shot if it ever tried.
 * That is the same lesson the Inspector's `min_range 3` teaches from the
 * player's side (game-design.md § 2: "the single most important number here"),
 * shown from the receiving end on the first floor. It is DEVIATION 3 OF 7: ToME
 * has no dead zone anywhere, so this one is ours and is labelled as ours.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 17 · defence 19 · MELEE damage 5.055 → a flat 5 · crit 1%
 *   armour 0 · darkness resist 50% · physical resist −30% (VULNERABLE)
 *   ORB damage 12-16 — a DIFFERENT FIELD; see `damageMin` and the file header
 *
 * READ THAT SECOND-TO-LAST LINE AS A MELEE WEAPON, because it is one. The 5.055
 * is `combatDamage` over losgoroth.lua:30's `combat` block, which is what
 * `attackTarget` would swing if anything ever routed this creature into it —
 * and nothing does, because `resolveIntent` forks to `fire` first
 * (scheduler.ts:1501). It is live on the RECEIVING side (the inspect card reads
 * it, and so does anyone reading this file) and it is not what hits you.
 *
 * The defence of 19 against armour 0 is the shape of the whole creature and it
 * inverted the old sheet: this is not a sniper with a glass jaw, it is a slow
 * tough floater that is HARD TO CONNECT WITH and takes a third more damage from
 * anything physical that does connect. The "sniper" reading was invented.
 */
export const INDEX_WRAITH: MonsterTemplate = Object.freeze({
  id: 'index_wraith',
  displayName: 'Index Wraith',
  description:
    'A cited absence given shape: pages, ink, and a detached watching glyph drifting where a ' +
    'body should be. Hangs at the outer ring and lobs dark orbs at the player.',
  sprite: 'enemy_index_wraith_s',
  rank: ActorRank.Normal,

  // ═══════════════════════════════════════════════════════════════════════
  // PORTED. losgoroth.lua:63 `max_life = resolvers.rngavg(40,60)` = 50.
  // ═══════════════════════════════════════════════════════════════════════
  // THIS WAS 22 AND THE NOTE THAT HELD IT THERE IS DELETED, NOT REUSED. Its
  // stated premise was that "a player's live damage is 4-7 through
  // `scheduler.ts#strike`, NOT the ~10-12 their combat SHEET says", so 50 life
  // would be a ten-hit kill where 22 is a four-hit kill. THE PREMISE IS REFUTED
  // BY MEASUREMENT. Now that the swing runs the real pipeline and players carry
  // real class sheets, a basic swing at THIS creature's live defence of 19 is:
  //
  //   Watchman    23% to hit × 16.461 on a hit = 3.786 hp per player turn
  //   Alchemist   18% to hit × 11.187          = 2.014
  //   Inspector   REFUSED — `combat.minRange` 3 forbids her bump entirely
  //
  // Both of the two who can swing are BELOW the old flat 5.5, not above it. The
  // sheet did not make players hit harder; it made this creature harder to hit.
  //
  // ═══ THE FRAME THE NUMBER WAS CHOSEN IN: A PARTY OF THREE, WITH TALENTS ═══
  // Stated explicitly because a life total is meaningless without one. Three
  // detectives, one of each class, each spending their turn on their slot-1
  // reliable talent — which is the live game now that content/classes.ts is
  // wired into the running server — put out 25.708 hp per PARTY TURN at this
  // creature: crude_blow 3.786 + revolver_shot 8.108 + ashwick_flare 13.814.
  //
  //   at 22 life:  0.856 party turns to kill
  //   at 50 life:  1.945 party turns to kill
  //
  // The orb needs 1.5 GAME TURNS to cross the stand-off (15 ticks at `projSpeed`
  // 2 from four tiles — see the table on `projSpeed` below). So at 22 the wraith
  // reliably DIED BEFORE ITS FIRST ORB LANDED: the designated ranged threat was
  // a creature most parties never saw attack. At 50 it lives one to two acts and
  // lands one or two orbs, 12-32 hp onto one player. That is the whole argument.
  //
  // ═══ REPORTED HONESTLY, OUT OF FRAME ═══
  // A SOLO WATCHMAN needs 13.206 player turns of basic swings, during which a
  // wraith standing off at four tiles deals 13.206 × 5.880 = 77.7 against his 72
  // hp bar. A lone Watchman trading shots with a wraith at range LOSES, and that
  // is not the frame: his answer is to close, because the creature cannot fire
  // inside two tiles at all and gives ground instead. If solo play ever becomes
  // a frame this game supports, this number is the first one to re-argue.
  maxHp: 50,
  hpRegen: 0,

  // DEVIATION 2 OF 7, HELD AGAIN AND THIS TIME WITH THE MEASUREMENT. Upstream's
  // losgoroth authors no `global_speed_base`, so it is 1.0 — the same speed as
  // the party. Ours stays at 0.84 for a structural reason: an equal-speed kiter
  // retreats forever and the fight is a treadmill with no end state. ToME can
  // afford 1.0 because its player has movement talents, teleports and a
  // `movement_speed` stat; ours has none of those yet.
  //
  // PRICED, so the hold is a decision rather than an omission: 1.0 would move
  // this creature from 5.880 to 7.000 hp per player turn — +19% — and would
  // spend the ONE property that lets a kiter fight end. The retune needed 3.99
  // more hp per turn and the orb supplied it; buying the last 1.12 by making the
  // creature un-cornerable is the worst available trade on this sheet.
  globalSpeed: 0.84,
  speedFactor: 1,

  // losgoroth.lua:43 `ai = "dumb_talented_simple", ai_state = { ai_move="move_complex" }`
  // plus a granted attack talent — which is exactly "kiter caster". The M3
  // profile is the closest one that exists; the "caster" half is `talentIn`
  // below rather than a talent tree.
  profile: AiProfile.RangedKiter,
  // DEVIATION 4 OF 7. HELD at 8. Upstream is losgoroth.lua:34 `infravision = 10`, the same as the
  // ant's, and it is NOT adopted here: 10 would let the wraith open fire on
  // something six tiles outside its own reach, which just means it spends four
  // turns walking while the party watches. Eight is two tiles past its reach —
  // enough to notice you and set up, not enough to start a fight it cannot
  // reach. Written down as ours rather than dressed up as a port.
  aggroRange: 8,
  // tome/resolvers.lua:901 — the `ranged` tactic preset ships `safe_range = 4`,
  // which is upstream's own answer to "how far away does a shooter want to
  // stand". The old 6 was above every non-`survivor` value in that table (the
  // only larger one is `survivor`'s 8, tome/resolvers.lua:903) and it is what
  // made the creature un-closeable: it stood at the very edge of its reach, so
  // every step the party took toward it was answered by a step back.
  //
  // HELD, AND IT IS A PORT RATHER THAN A DEVIATION, which is why it is not in
  // the numbered list. It was re-examined during the retune anyway because it is
  // the field that sets the counterplay window (5 tiles would buy a second
  // player decision per orb, see `projSpeed`) — and it stays, because moving it
  // would mean citing `safe_range = 4` in the comment while shipping a 5.
  preferredRange: 4,
  minRange: 2,
  // DEVIATION 5 OF 7. HELD at 6, and it is already a cut: T_VOID_BLAST authors
  // `range = 10` (misc/npcs.lua:730). Six is capped deliberately — the
  // Inspector's authored reach is 7 (test/server/combat.test.ts), and a monster
  // that outshoots the ranged class deletes that class's identity.
  //
  // ═══ IT IS A LEGALITY CEILING. `preferredRange` IS THE OPERATIVE REACH. ═══
  // `kite` (ai/npc.ts) returns `advance` for anything beyond `preferredRange`,
  // so control only ever reaches its `distance <= self.attackRange` test with a
  // distance already <= 4. THE AI CANNOT FIRE A SIX-TILE SHOT. What this number
  // actually does is bound `canAttack` and `proj.range`, neither of which binds
  // at four tiles either. Tuning it alone will therefore change NOTHING you can
  // observe in play; the field to move is `preferredRange`, and the cap above is
  // the reason it may not move past 6.
  //
  // SO UPSTREAM'S 10 IS NOT DECLINED FOR TASTE, IT IS DECLINED AS INERT. It was
  // re-offered during the retune as one of the three upstream buffs that could
  // pay for the creature's nerfs, and it pays nothing: the AI cannot reach the
  // test that would consume it. Restoring it would move zero numbers in the
  // balance table above while deleting the sentence that protects the Inspector.
  attackRange: 6,
  huntsIsolated: false,
  shoulderAfter: 0,

  // misc/npcs.lua:733 `proj_speed = 2` on T_VOID_BLAST — the slowest projectile
  // in ToME, and the one the losgoroth actually grants (losgoroth.lua:67-69), so
  // the creature and its orb arrive as one package. Two tiles per game turn: the
  // orb is born holding a full turn of energy (Projectile.lua:37-38) so its
  // first tile is free and every tile after it costs half a turn. Upstream's own
  // tooltip calls it "a blast of void energies that slowly travel to their
  // target" (misc/npcs.lua:744).
  //
  // ═══════════════════════════════════════════════════════════════════════
  // THE COUNTERPLAY WINDOW, MEASURED AT THE DISTANCES THE AI ACTUALLY FIRES
  // ═══════════════════════════════════════════════════════════════════════
  // THIS COMMENT USED TO CLAIM "two and a half game turns to cross the wraith's
  // full reach" and "two whole decisions". BOTH WERE WRONG, and wrong in the
  // reader's favour, which is the worse direction. The six-tile figure was
  // computed from `attackRange`, and `kite` can never fire a six-tile shot (see
  // the note on `attackRange` above). The real firing band is Euclidean 2 to 4:
  //
  //   distance   tiles   ticks to impact   player decisions in between
  //   ────────   ─────   ───────────────   ───────────────────────────
  //      4         4       5 × 3 = 15                  1
  //      3         3       5 × 2 = 10                  1
  //      2         2       5 × 1 =  5                  0
  //
  // (a tile is 5 ticks at `projSpeed` 2; a player at globalSpeed 1 acts every 10
  // ticks — src/shared/energy.ts.) So ONE decision at the stand-off distance the
  // wraith fights at, and NONE at the near edge of the band. That is still the
  // counterplay — stepping off the frozen line or putting a wall on it makes the
  // orb miss, and a body that walks onto the orb's own tile eats it (DEVIATION 3
  // in engine/projectile.ts) — but it is one decision, not two. If two is the
  // design target, the lever is `preferredRange`, not this field: 5 tiles would
  // buy 20 ticks. That is a tuning decision with a playtest behind it and it has
  // not been made.
  projSpeed: 2,
  // losgoroth.lua:43 `ai_state = { ..., talent_in = 2 }` — VERBATIM. A 1-in-2
  // chance per turn, NOT one shot every two turns; see the field's own doc
  // comment on `MonsterTemplate` for why that distinction is worth a paragraph.
  // This is the second half of the fix: the old wraith fired every single turn.
  //
  // HELD AT 2 AND PRICED, because it is the single biggest lever on this sheet
  // and somebody will reach for it: `talentIn: 1` DOUBLES the damage per player
  // turn, 5.880 → 11.760, straight past the top of the band and past the elite.
  // It is declined on two counts and either would be enough. It deviates from a
  // verbatim port for the first time on this field, and it turns the coin the
  // whole creature is designed around into a metronome — see the paragraph on
  // `MonsterTemplate.talentIn`, which is there precisely because a cadence is
  // something a player counts and a coin is something a player cannot.
  talentIn: 2,

  // ═══════════════════════════════════════════════════════════════════════
  // THE ORB. DERIVED FROM T_VOID_BLAST, NOT FROM THE MELEE BLOCK BELOW.
  // ═══════════════════════════════════════════════════════════════════════
  // DEVIATION 7 OF 7, and it is a CORRECTION of a porting error rather than an
  // invention. The previous pass left these absent, so `monsterInit` passed
  // nothing, so `actor.ts`'s `DEFAULT_MONSTER_DAMAGE_MIN..MAX` = 3-6 was frozen
  // onto every orb this creature has ever thrown. The fix is not to point `fire`
  // at the `combat` block below — that block is the creature's MELEE weapon
  // (losgoroth.lua:30, and it carries `atk`, `apr` and a `dammod`, which is what
  // a weapon is). THE ORB IS A TALENT:
  //
  //     -- game/modules/tome/data/talents/misc/npcs.lua:739 (T_VOID_BLAST)
  //     self:projectile(tg, x, y, DamageType.VOID_BLAST,
  //         self:spellCrit(self:combatTalentSpellDamage(t, 15, 240)), …)
  //
  // ═══ THE DERIVATION, IN FIVE STEPS, EVERY INPUT MEASURED ═══
  //
  //   1. `combatSpellpower(INDEX_WRAITH.combat)` = 6. Combat.lua:1744-1771, and
  //      it is Magic 6 (losgoroth.lua:44) with no `spellPower` mod, which the
  //      stat rescale leaves alone at 6.
  //   2. `combatTalentSpellDamage(6, 1, 15, 240)` = 24.9376. Combat.lua:1774-1779,
  //      ported and exported at engine/talents.ts; `base` 15 and `max` 240 are
  //      npcs.lua:739's own two arguments, and the talent level is
  //      `MONSTER_TALENT_LEVEL` = 1 (it was `MVP_TALENT_LEVEL` until players
  //      grew real talent points; monsters still have no sheet and no points,
  //      so the constant survives under the one name that is still true).
  //   3. THE UPSTREAM BODY SCALE, measured rather than assumed. ToME's level-1
  //      life bar is the class birth descriptor: 22 `max_life` entries across
  //      data/birth/classes/*.lua, values 90 / 100 / 110 / 120, MEAN 100.455 and
  //      median 100. Constitution adds 4 life per point over the engine base of
  //      10 (Actor.lua:3884, `local multi_life = 4`), and the class-granted mean
  //      across the 28 subclass `stats` blocks in the same files is 0.714 points
  //      of Con, i.e. +2.86 life. ANCHOR = 103.31.
  //      IT EXCLUDES race Constitution and the free birth points, both of which
  //      RAISE the anchor and therefore LOWER the orb — so this anchor is the low
  //      end and the number falling out of it is the high end.
  //   4. 24.9376 / 103.31 = 24.14% of an upstream level-1 bar. Our own median
  //      class bar is 60 (Watchman 72, Inspector 60, Alchemist 54 —
  //      content/classes.ts), and 24.14% of 60 is 14.48 → 14, rounded toward the
  //      conservative side of the anchor's known omission.
  //   5. THE ±2 SPREAD IS OURS and is labelled as ours. Upstream's orb is a
  //      single number wrapped in `spellCrit` (npcs.lua:739); our `fire` path
  //      never rolls a crit, at the muzzle or at impact (scheduler.ts:1709), so
  //      the band stands in for the variance that crit would have supplied. It
  //      is symmetric, so the mean is exactly the derived integer.
  //
  // ═══ DETERMINISM: THE DRAW DOES NOT MOVE, ONLY ITS BOUNDS ═══
  // `fire` keeps EXACTLY ONE labelled `combat.bump.damage` draw at EXACTLY the
  // stream position it has always occupied. The alternative — rewriting `fire`
  // to `rollDamageRange(combatDamage(sheet), …)` — was rejected on two counts:
  // it sources the orb from the melee block, which is the error this field
  // exists to correct, and `combatDamage` 5.055 × `damRange` 1.1 truncates to
  // [5, 5], where damage.ts:276 returns EARLY and takes no draw at all. That
  // would delete a draw from the middle of every wraith's turn and shift every
  // replay after it.
  //
  // ═══ AND NO, THE ORB DOES NOT GET A BLAST RADIUS ═══
  // Written down so it is not re-litigated: `ProjectileOutcome.impact`
  // (projectile.ts:444-453) is exactly ONE victim, so a real radius means
  // widening that type to a list, the `Effect` variant that carries it, the
  // sweep step the client paces off, and the client playback — the same price
  // list DEVIATION 1 in projectile.ts already prices for turning the bolt into
  // upstream's beam. And there is nothing upstream to port it FROM:
  // T_VOID_BLAST authors no radius whatsoever (npcs.lua:723-747), so it would be
  // an invention bought at the cost of four files.
  damageMin: 12,
  damageMax: 16,

  // THE RARE TIER, EVERY TIME. Six ids: the three class BODY items and the three
  // RINGs (content/items.ts). Chance 100 is upstream's own default — `t.chance or
  // 100` at resolvers.lua:429 — and it is what most authored tables actually
  // carry (ant.lua:220, bird.lua:67-68, canine.lua:157, cold-drake.lua:28 are all
  // `chance=100`).
  //
  // ═══ WHY THE KITER AND NOT THE ELITE GETS THE GUARANTEED RARE ═══
  // This creature is the one you have to solve rather than out-trade: it stands
  // off at four tiles, fires on a coin flip, cannot be shot back at by the
  // Inspector's own dead zone, and a lone Watchman trading with it at range
  // LOSES (see `maxHp` above). It is also the roster's only optional fight —
  // nothing forces a party to walk into the orb's line. A guaranteed rare is what
  // pays for choosing to. The elite arrives whether you want it or not.
  //
  // AND THE DRAW COUNT IS THE POINT OF SAYING 100 RATHER THAN OMITTING IT: this
  // template takes EXACTLY TWO loot draws every spawn, always, on every seed.
  // Chance 35 on the husk takes one or two. Both are stated in
  // test/server/loot.test.ts, because "how many draws" is the only property of a
  // seeded stream that a later pass can break without any test going red.
  drops: { chance: 100, pick: idsOfTier('rare') },

  combat: {
    // losgoroth.lua:44 `stats = { str=10, dex=8, mag=6, con=16 }`, VERBATIM.
    // Read it against the block it replaces — a hand-authored
    // { str: 8, dex: 13, con: 8, cun: 12 } reasoned from "it snipes, so
    // Dexterity leads". Upstream inverts every one of those: Dex is BELOW
    // average, Con is the highest stat on the sheet, and the orb is thrown with
    // Magic. `cun` is absent, so it takes the engine base of 10.
    stats: { str: 10, dex: 8, mag: 6, con: 16 },
    // losgoroth.lua:64 `combat_armor = 0, combat_def = 20`. A KITER BUYS
    // SURVIVAL WITH DODGE, NOT ARMOUR, and that is a real design statement:
    // armour would flatten the chip damage the party can reliably land, whereas
    // 20 defence makes every individual swing a coin flip that a player can tilt
    // with accuracy or with a talent. It also means the answer to a wraith is
    // still to reach it — armour 0 with a −30 physical resist is the softest
    // target in the roster once you are standing next to it.
    mods: { armour: 0, def: 20 },
    // ═══ THIS IS THE MELEE WEAPON. THE ORB IS `damageMin`/`damageMax` ABOVE. ═══
    // losgoroth.lua:30, VERBATIM including the resolver nest:
    //   combat = { dam=resolvers.levelup(resolvers.mbonus(40, 15), 1, 1.2),
    //              atk=15, apr=15, dammod={mag=0.8}, damtype=DamageType.ARCANE }
    // `resolveMBonus(40, 15)` is 15 at level 1 (see content/resolvers.ts for the
    // ~0.4 the port drops and why), which lands within one point of the 14 this
    // field was hand-authored at — a good sign that the old number was a decent
    // guess at a curve somebody else had already tuned.
    //
    // WHAT IT ACTUALLY DRIVES TODAY: `atk` and `apr` and nothing else. `apr` 15
    // is passed to the orb's impact by `scheduler.ts#fire` and swallows every
    // class's armour; `atk` and `dam` feed the inspect card and would feed
    // `attackTarget` if anything ever routed this creature into it, which
    // nothing does — the `projSpeed` fork at scheduler.ts:1501 returns first.
    weapon: {
      dam: resolveLevelup(resolveMBonus(40, 15)),
      atk: 15,
      apr: 15,
      // `dammod = {mag=0.8}` — swung with Magic alone. The old { dex: 0.5,
      // cun: 0.4 } was invented "in the shape of ToME's own ranged dammod"; this
      // IS ToME's own dammod, for this creature. NB it is `mag` because the
      // losgoroth is a caster, not because this line has anything to do with the
      // orb: the orb's Magic scaling went through `combatSpellpower` instead.
      damMod: { mag: 0.8 },
    },
    profile: {
      resists: {
        // DEVIATION 6 OF 7 — OURS, KEPT. Upstream's equivalent is losgoroth.lua:46
        // `[DamageType.ARCANE] = 100` — total immunity to its own element. We do
        // not have Arcane and we would not want a 100 on the first floor
        // regardless (`resistsCap` is absent, so the engine default of 100 makes
        // that genuinely immune, Actor.lua:211). Darkness is our damage type and
        // half of it sliding off is our identity, not a port.
        [DamageType.Darkness]: 50,
        // losgoroth.lua:46 `[DamageType.PHYSICAL] = -30`, VERBATIM. This field
        // carried an INVENTED tag and a value of −20; the invention was RIGHT
        // and the number was timid. A negative resist is a vulnerability and it
        // multiplies rather than subtracts (damage_types.lua:345-352,
        // `dam * (100 - res) / 100`), so a solid hit lands for 30% more on
        // something that is barely there — which is the same sentence as its
        // `minRange`: the answer to a wraith is to reach it.
        [DamageType.Physical]: -30,
      },
      // `resistsCap` deliberately absent — Actor.lua:211, the engine default is
      // `{ all = 100 }`. The familiar 70 is a PLAYER birth descriptor
      // (descriptors.lua:63) and monsters do not get it.
    },
    // EUCLIDEAN, and equal to `attackRange` because the AI's band arithmetic is
    // Euclidean too (ai/npc.ts `kite`). Equality means every shot the AI wants
    // is a shot `canAttack` allows.
    range: 6,
    // THE SAME NUMBER AS `minRange` ABOVE, and `validateTemplate` proves it. Two
    // dead zones that disagree is a monster that walks to a tile it then refuses
    // to shoot from, every turn, forever.
    minRange: 2,
    // OURS. damage_types.lua:856-875, `dark_orb`. Upstream's void blast is
    // Arcane; the orb being made of ink and absence is the author's setting.
    damageType: DamageType.Darkness,
  },
});

// ---------------------------------------------------------------------------
// index_husk_elite — THE ELITE, on the ghoul → ghoulking delta
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING IS A WARNING ABOUT THE BEHAVIOUR, NOT ABOUT THE NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ A FACTUAL CORRECTION THAT USED TO LIVE HERE ═══
 * This header used to claim that ToME's `getRankLifeAdjust` (Actor.lua:1740-1751)
 * gives a rank-3 elite ×1.125 life against a rank-2 normal's ×0.925 at level 1,
 * i.e. "an elite has 1.22× a normal's life", and a test asserted exactly that
 * ratio. THAT IS A MIS-READ OF THE LUA AND BOTH ARE GONE.
 *
 * `getRankLifeAdjust` does not scale a creature's life. It scales the per-level
 * life GAIN, and it is consumed inside `levelup()` at Actor.lua:3822 — a
 * function that runs once per level GAINED. `resolveLevel` (ActorLevel.lua:62-64)
 * levels an NPC from its `start_level` up to the zone's level and therefore runs
 * ZERO times for a level-1 creature on floor one. So at our tier, rank changes
 * life by EXACTLY ZERO. There is no ×1.22 and there never was.
 *
 * That is not a footnote — it removes the last remaining argument for "an elite
 * is the same creature with more life", and it agrees with what ToME's own
 * three-tier ghoul ladder does: ghoul, ghast and ghoulking ALL hold
 * `max_life = resolvers.rngavg(90,100)` (ghoul.lua:54, :71, :92). Every point of
 * the ghoulking's threat is bought with `dam`, `atk`, `apr`, `def`, `armor`, a
 * faster talent cadence and an AI swap. Not one point of it is life.
 *
 * ═══ WHY OURS STILL BUYS SOME OF IT WITH LIFE ═══
 * THE OLD ANSWER HERE WAS "we cannot spend the ghoulking's currency yet — dam,
 * atk and apr are inert until the scheduler moves onto combat.ts#attackTarget".
 * THAT HAS RESOLVED. The scheduler moved, and this creature's currency is now
 * live and measurably spent: `dam` 15 / `atk` 18 / `apr` 8 / `def` 4 / armour 2
 * put it at 5.888 hp per player turn against a Watchman or an Inspector and
 * 6.332 against an Alchemist, where the husk it upgrades is 4.378 / 4.378 /
 * 4.875. THE ELITE ALREADY HITS 34% HARDER THAN THE HUSK WITHOUT SPENDING ONE
 * POINT OF LIFE — which is the ghoulking's own argument, arriving on our side of
 * the port at last.
 *
 * So the 60 is now a genuinely open question rather than a forced one, and it is
 * DELIBERATELY LEFT ALONE THIS PASS. Retuning the elite means re-deriving its
 * whole fight — party turns to kill, how the two elite behaviours change who is
 * being hit, and whether a 25-life elite reads as an elite at all — and that is
 * a measurement job with its own scope. This pass retuned exactly one creature
 * and said so. It stays DEVIATION 1 OF 7, and the note that used to excuse it is
 * replaced by the one that dates it.
 *
 * ═══ WHAT ACTUALLY EARNS THE RING ═══
 * Two behaviours, both in `ai/npc.ts`:
 *
 *   `huntsIsolated`  it goes for whoever is standing ALONE, not whoever is
 *                    nearest. The ring means "close ranks".
 *   `shoulderAfter`  after five turns of being unable to advance it re-routes
 *                    AROUND its own swarm (simple.lua:199-247). The ring means
 *                    "you cannot plug the door on this one".
 *
 * These two are OUR analogue of the ghoulking's third lever, which is an AI
 * swap: `ai = "tactical", ai_tactic = resolvers.tactic"melee"` (ghoul.lua:98-99,
 * and skeleton.lua:154-155 does the same for its own top tier). Upstream makes
 * its elite think differently rather than hit harder; so do we, with the two
 * behaviours a four-player game actually wants.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 21 · defence 4 · damage 7.0964 → rolls a flat 7 · crit 1% · armour 2
 *
 * ═══ THE ART DOES NOT CARRY THE READ YET, WHICH IS WHY THE RING MUST ═══
 * docs/art-pipeline.md:234 and :362 record a real `FRAME_SIZE_MISMATCH`:
 * `index_husk` ships at 48x64 and `index_husk_elite` at 24x32, so the elite
 * currently draws SMALLER than the creature it upgrades. Until that is
 * regenerated the under-token ring is the only thing on screen saying "this one
 * is different", which is why `ActorView.rank` exists and why the renderer keys
 * off it (Actor.lua:1198-1204 does the same thing for the same reason).
 */
export const INDEX_HUSK_ELITE: MonsterTemplate = Object.freeze({
  id: 'index_husk_elite',
  displayName: 'Overwritten Husk',
  description:
    'A husk the Index kept editing. The pages have set into something that reads the room ' +
    'before it moves, and it goes for whoever is standing on their own.',
  sprite: 'enemy_index_husk_elite_s',
  rank: ActorRank.Elite,

  // DEVIATION 1 OF 7 — see this template's header. Upstream's ladder holds
  // `max_life = resolvers.rngavg(90,100)` across ALL THREE ghoul tiers
  // (ghoul.lua:54, :71, :92), i.e. the delta is ZERO and a faithful port would
  // put this at 25. The reason that used to sit here — "life and behaviour are
  // the only live levers an elite has until the damage sheet is wired" — has
  // expired: the sheet is wired and this creature spends it (5.888 hp per player
  // turn against 4.378 for the husk). 60 is HELD here only because retuning the
  // elite is not this pass's job; the argument for moving it is in the header.
  maxHp: 60,
  hpRegen: 0,

  // The ghoul ladder moves no speed field, so the delta is zero and the elite
  // inherits the husk's `global_speed_base = 0.9` (ant.lua:58) unchanged. This
  // used to be 1, i.e. FASTER than its own base creature, directly contradicting
  // the note that used to sit here saying it deliberately was not. An elite you
  // can outrun but cannot shake is a better fight than one that arrives sooner.
  globalSpeed: 0.9,
  speedFactor: 1,

  profile: AiProfile.MeleeChaser,
  // Also a zero delta: BASE_NPC_GHOUL's `infravision` is shared by all three
  // tiers, so the elite sees exactly as far as the husk (ant.lua:38,
  // `infravision = 10`). It used to be 9 — one MORE than the husk's invented 8,
  // and now one LESS than its real 10, which is how a hand-authored +1 ages.
  aggroRange: 10,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  // ═══ THE TWO BEHAVIOURS THAT ARE THE ELITE ═══ (ai/npc.ts owns both)
  huntsIsolated: true,
  // simple.lua:225 — "Wait at least 5 turns of not moving before switching to
  // blocked_astar". Upstream's own number, upstream's own reason.
  shoulderAfter: 5,
  // No `projSpeed` (melee) and no `talentIn`. The ghoulking DOES tighten the
  // cadence — `ai_state = { talent_in=2 }` at ghoul.lua:94 against the ghoul's
  // 4 at :61 — but that is a cadence for GRANTED TALENTS, of which this creature
  // has none. Setting it here would gate the elite's ordinary bump-attack on a
  // coin flip and halve the damage of the roster's threat creature, which is the
  // exact opposite of what the upstream field does.

  // THE UNCOMMON TIER, SEVEN TIMES IN TEN. Nine ids: every HEAD, OFFHAND and
  // TRINKET item (content/items.ts). The ring under this creature is a warning,
  // and 70 is the answer to it — the party that decides to take the fight it was
  // warned about is usually paid for it.
  //
  // WHY THE TIER IS HEAD/OFFHAND/TRINKET AND NOT "BETTER VERSIONS OF THE COMMON
  // ONES": these are the slots that carry the OFFENSIVE grants — the badge and
  // the deerstalker are `mods.atk +3`, the dossier and the tome are `mods.dam +4`
  // and `+5`, the cowl is `mag +4`. The common tier is defence and the uncommon
  // tier is damage, so the elite's reward changes how fast you kill the next one
  // rather than how long you survive it.
  //
  // MEASURED, one piece at a time, against each class's own bare `combatDamage`:
  //   inquisitors_tome     +5 dam    9.660 → 10.500   +8.7%   (the largest)
  //   inspectors_dossier   +4 dam   11.542 → 12.430   +7.7%
  //   inquisitors_cowl     +4 mag    9.660 → 10.277   +6.4%
  // The two `mods.atk +3` pieces — the badge and the deerstalker — move
  // `combatDamage` by exactly ZERO, and that is correct rather than a hole: they
  // buy 7.5 percentage points of hit chance, which no damage figure can show.
  // Against the wraith's defence 19 that is where their entire value lives, and
  // it is the reason the tier is judged on both numbers and not one.
  //
  // Not 100, deliberately. A guaranteed drop from the creature you MUST fight
  // turns the elite into a vending machine and makes the wraith's guaranteed rare
  // — which you may walk past — read as the same promise.
  drops: { chance: 70, pick: idsOfTier('uncommon') },

  combat: {
    // The ghoul ladder moves no stat, so the delta is zero: the elite carries
    // BASE_NPC_ANT's own `stats = { str=12, dex=10, mag=3, con=13 }`
    // (ant.lua:34), identical to the husk. It is the SAME CREATURE, edited — the
    // difference is what it swings and how it thinks, not what it is made of.
    // (The old block hand-authored 16/10/16/10 "with the ToME rank ladder's
    // shape applied"; the rank ladder's stat adjust, Actor.lua:1701-1712, is
    // consumed by autolevel, which is out of scope for the same reason
    // `getRankLifeAdjust` is — see this template's header.)
    stats: { str: 12, dex: 10, con: 13, mag: 3 },
    // The husk's `combat_armor = 1, combat_def = 1` (ant.lua:36) plus the
    // ghoul→ghoulking deltas: armour +1 (ghoul.lua:55 `combat_armor = 2` →
    // ghoul.lua:93 `combat_armor = 3`) and def +3 (`combat_def` 7 → 10).
    //
    // `armourHardiness: 5` and `physCrit: 5` are DELETED. Both were invented —
    // the hardiness to make the elite "the roster's armour teacher", the crit
    // anchored on a `crit_chance: 0.05` from a different game's watchman — and
    // the ghoulking authors neither. Rank-based resists and crit in ToME come
    // from per-level rng draws inside `levelup()` (Actor.lua:3801-3806), which
    // is autolevel and out of scope.
    mods: { armour: 2, def: 4 },
    // The husk's weapon with the ghoul→ghoulking deltas applied:
    //   dam ×3  — ghoul.lua:63 `dam=resolvers.levelup(10,1,1)`
    //           → ghoul.lua:101 `dam=resolvers.levelup(30,1,1.2)`;   5 → 15
    //   atk +3  — :63 `atk=resolvers.levelup(5,1,1)` → :101 `atk=...(8,1,1)`; 15 → 18
    //   apr +1  — :63 `apr=3` → :101 `apr=4`;                        7 → 8
    // `dam` is the one ratio in the table because 10 → 30 is a clean tripling
    // while 5 → 8 is not a clean anything; see the adoption table in the file
    // header. `dammod` is unchanged at the ant's `{str=0.6}`, which is also the
    // ghoul's (:63) and the engine default (Combat.lua:1625).
    weapon: { dam: 15, atk: 18, apr: 8, damMod: { str: 0.6 } },
    // NO `profile`. The old block carried `resists { all: 10, Mind: 25 }`, both
    // invented, the pair chosen to exercise the multiplicative composition rule
    // at Combat.lua:2227-2228 (10 and 25 give 32.5, not 35). THAT RULE STILL HAS
    // A TEST — test/server/monsters.test.ts drives it from a synthetic profile
    // declared in the test file, which is where a rule-exerciser belongs. It is
    // not content, and it should never have been a creature's stat block. The
    // ghoulking authors no `resists` of its own.
    range: 1.5,
    minRange: 0,
    damageType: DamageType.Physical,
  },
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every template, in a fixed order — for iteration that must be reproducible. */
export const MONSTER_TEMPLATES: readonly MonsterTemplate[] = Object.freeze([
  INDEX_HUSK,
  INDEX_WRAITH,
  INDEX_HUSK_ELITE,
]);

/** Their ids, same order. */
export const MONSTER_IDS: readonly string[] = Object.freeze(
  MONSTER_TEMPLATES.map((template) => template.id),
);

const BY_ID: ReadonlyMap<string, MonsterTemplate> = new Map(
  MONSTER_TEMPLATES.map((template) => [template.id, template]),
);

/** Look one up. `undefined` for an id no build of the content knows about. */
export function monsterById(id: string): MonsterTemplate | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * A template plus a tile, in the shape `world.addMonster` wants.
 *
 * A function rather than a method on the template so this module never imports
 * `world/`: content is data, the world is state, and the day an encounter table
 * wants to spawn from a save file it should not have to construct a World first.
 *
 * ═══ TWO FIELDS, TWO DIFFERENT ATTACKS. THIS IS THE EASY ONE TO GET WRONG. ═══
 * THIS NOTE USED TO READ "NOTE WHAT IS STILL NOT PASSED: `damageMin` and
 * `damageMax`", and the omission was the whole reason a wraith's orb hit for the
 * placeholder 3-6 no matter what its stat block said. Both are passed now, and
 * what each of the two damage inputs drives is worth stating once:
 *
 *   `combat`                  THE MELEE SWING. `scheduler.ts#strike` hands the
 *                             whole sheet to `combat.ts#attackTarget`, which
 *                             runs checkHit, the damage-range roll, armour,
 *                             armour penetration, crit and resists off it.
 *   `damageMin`/`damageMax`   THE TRAVELLING ORB. `scheduler.ts#fire` rolls one
 *                             labelled `combat.bump.damage` draw between them
 *                             and freezes the integer onto the projectile.
 *
 * A melee template passes `undefined` for both and that is correct: `fire` is
 * unreachable without a `projSpeed` (scheduler.ts:1501), so the fallback they
 * would fall through to is never read. `undefined` is forwarded rather than
 * defaulted for exactly the same reason `projSpeed` and `talentIn` are — see the
 * comment on those two below.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `drops` IS DELIBERATELY NOT FORWARDED, AND THAT IS THE WHOLE DROP DESIGN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other authored field arrives here and is copied onto the body. The drop
 * table is the one that stops at this line, because it is not a fact about a
 * body — it is a QUESTION, and somebody has to roll it.
 *
 * This function is PURE and RNG-FREE, and the file header promises it in as many
 * words: *"Frozen literals and two total functions over them. Nothing here reads
 * a clock, draws a random number, or touches the world."* Forwarding `drops`
 * would leave exactly two places to answer the question and both are worse:
 *
 *   ROLL IT HERE — this function starts drawing, so the promise above is gone
 *     and every caller of `monsterInit` (four test files among them) silently
 *     starts consuming a random stream it never asked for.
 *   ROLL IT IN `world.addMonster` — `MonsterInit` grows a table of item ids, so
 *     src/server/world/ has to learn what a content catalogue is, and the world
 *     starts drawing at placement time, which is the ONE stream (`world.spawn`)
 *     that is driven by when somebody's laptop woke up.
 *
 * So the roll lives in `content/encounter.ts`, one layer up, where the loot
 * stream and the catalogue are both legitimately in view, and the DECIDED id is
 * written straight onto `actor.carried`. That is also upstream's own shape:
 * `resolvers.calc.drops` puts the resolved object into the creature's inventory
 * at resolution time (resolvers.lua:441-446) rather than storing the table on the
 * creature for later.
 */
export function monsterInit(template: MonsterTemplate, at: TileXY): MonsterInit {
  return {
    name: template.displayName,
    sprite: template.sprite,
    x: at.x,
    y: at.y,
    rank: template.rank,
    profile: template.profile,
    maxHp: template.maxHp,
    hpRegen: template.hpRegen,
    globalSpeed: template.globalSpeed,
    speedFactor: template.speedFactor,
    attackRange: template.attackRange,
    aggroRange: template.aggroRange,
    preferredRange: template.preferredRange,
    minRange: template.minRange,
    huntsIsolated: template.huntsIsolated,
    shoulderAfter: template.shoulderAfter,
    // THE ORB'S FROZEN DAMAGE, authored per template. Absent on both melee
    // creatures, and absent is not "3-6" here — it is "this creature never
    // reaches `fire`". See the note above.
    damageMin: template.damageMin,
    damageMax: template.damageMax,
    // Both optional, and both pass `undefined` through as `undefined` on
    // purpose: absent `projSpeed` is ToME's "instantaneous"
    // (ActorTalents.lua:988) and absent `talentIn` is "every turn"
    // (talented.lua:122, `rng.chance(1)`). Defaulting either here would silently
    // change every melee monster in the roster.
    projSpeed: template.projSpeed,
    talentIn: template.talentIn,
    combat: template.combat,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** √2 — the diagonal neighbour, and the reason a melee reach cannot be 1.0. */
const DIAGONAL_STEP = Math.SQRT2;

/**
 * Past this, a Chebyshev dead-zone test and a Euclidean one stop agreeing.
 *
 * At `minRange` 4 the pure diagonal at offset (3, 3) is Chebyshev 3 (inside the
 * hole, so the AI backs off) and Euclidean 4.243 (outside it, so `canAttack`
 * would have allowed the shot). At 1, 2 and 3 there is no such tile anywhere on
 * the grid — a test proves it by exhaustion. The AI and the refusal use the same
 * metric today, so this is belt and braces; it is also the number that makes the
 * Inspector's authored 3 the largest dead zone that is safe to reason about
 * loosely, which is worth knowing before someone authors a 5.
 */
const MAX_SAFE_MIN_RANGE = 3;

/**
 * Everything about a template that the type system cannot say.
 *
 * Returns problems rather than throwing: a module that throws at import time
 * takes the whole server down on a content typo, and this is called from a test
 * over every template, which is where a content typo should be found.
 */
export function validateTemplate(template: MonsterTemplate): readonly string[] {
  const problems: string[] = [];
  const where = `${template.id}:`;
  const combat = template.combat;
  const reach = combat.range ?? template.attackRange;
  const deadZone = combat.minRange ?? 0;

  if (template.maxHp <= 0) problems.push(`${where} maxHp must be positive`);
  if (template.globalSpeed <= 0) problems.push(`${where} globalSpeed must be positive`);
  if (template.speedFactor <= 0) problems.push(`${where} speedFactor must be positive`);

  // ONE DEAD ZONE, TWO CONSUMERS. `ai.minRange` is what makes a kiter give
  // ground; `combat.minRange` is what makes `canAttack` refuse. If they differ,
  // the monster either stands where it cannot shoot or shoots where it should
  // have retreated — and both look like the server being broken, not like a
  // creature having a weakness.
  if (deadZone !== template.minRange) {
    problems.push(
      `${where} combat.minRange ${deadZone} must equal ai minRange ${template.minRange}`,
    );
  }
  if (template.minRange > MAX_SAFE_MIN_RANGE) {
    problems.push(`${where} minRange ${template.minRange} exceeds ${MAX_SAFE_MIN_RANGE}`);
  }

  // The band has to be ordered or the kiter oscillates: retreat because it is
  // inside `minRange`, then approach because it is outside `preferredRange`,
  // forever, one tile each way.
  if (template.minRange > template.preferredRange) {
    problems.push(`${where} minRange ${template.minRange} > preferredRange`);
  }
  if (template.preferredRange > template.attackRange) {
    problems.push(`${where} preferredRange ${template.preferredRange} > attackRange`);
  }
  // Otherwise it can never see far enough to use the reach it has.
  if (template.aggroRange < template.attackRange) {
    problems.push(`${where} aggroRange ${template.aggroRange} < attackRange`);
  }

  // The Euclidean circle must never be tighter than the Chebyshev square's edge,
  // or the scheduler accepts an attack `canAttack` then refuses.
  if (reach < template.attackRange) {
    problems.push(`${where} combat.range ${reach} < attackRange ${template.attackRange}`);
  }
  // ...and at melee reach it must contain the four diagonals. See the header.
  if (template.attackRange === 1 && reach < DIAGONAL_STEP) {
    problems.push(`${where} melee combat.range ${reach} excludes the diagonal ${DIAGONAL_STEP}`);
  }

  // A PROJECTILE THAT DOES NOT MOVE NEVER ARRIVES. `projSpeed` is tiles per game
  // turn, so 0 is an orb that hangs in the air forever and a negative one flies
  // backwards; NaN would make every energy comparison false, which reads as the
  // orb silently vanishing. ABSENT is the legal way to say "instantaneous"
  // (ActorTalents.lua:988), and absent is checked for separately here rather
  // than being folded into a `?? 0` that would make every melee template fail.
  if (template.projSpeed !== undefined) {
    if (!Number.isFinite(template.projSpeed) || template.projSpeed <= 0) {
      problems.push(`${where} projSpeed ${template.projSpeed} must be a positive finite number`);
    }
  }

  // THE ORB'S BOUNDS. `scheduler.ts#fire` calls `rng.int('combat.bump.damage',
  // damageMin, damageMax)`, and `rng.int` THROWS a RangeError when the max is
  // below the min (src/shared/rng.ts) — which would take down a turn mid-pump,
  // synchronously, on a content typo. That is exactly the class of failure this
  // function exists to move to a test run.
  //
  // BOTH OR NEITHER. A template with only one of the two silently inherits the
  // other from `DEFAULT_MONSTER_DAMAGE_*` in engine/actor.ts, which is a number
  // in a different file chosen for a different purpose — a 12..6 or a 3..16 orb
  // is a bug that reads as a tuning decision.
  const hasMin = template.damageMin !== undefined;
  const hasMax = template.damageMax !== undefined;
  if (hasMin !== hasMax) {
    problems.push(`${where} damageMin and damageMax must be authored together`);
  } else if (template.damageMin !== undefined && template.damageMax !== undefined) {
    if (!Number.isInteger(template.damageMin) || !Number.isInteger(template.damageMax)) {
      problems.push(`${where} damage bounds must be integers — rng.int refuses a fraction`);
    } else if (template.damageMin < 0) {
      problems.push(`${where} damageMin ${template.damageMin} must not be negative`);
    } else if (template.damageMax < template.damageMin) {
      problems.push(`${where} damageMax ${template.damageMax} < damageMin ${template.damageMin}`);
    }
  }

  // `talent_in` is the N in `rng.chance(N)` (talented.lua:122), which draws an
  // integer in [1, N]. A 0 or a negative would make that range empty and a
  // fraction would make "1 in 2.5" mean nothing anybody can reason about. 1 is
  // legal and means "every turn", exactly as BASE_NPC_ANT authors it
  // (ant.lua:33) — it is just an expensive way to spell absent.
  if (template.talentIn !== undefined) {
    if (!Number.isInteger(template.talentIn) || template.talentIn < 1) {
      problems.push(`${where} talentIn ${template.talentIn} must be an integer >= 1`);
    }
  }

  /**
   * THE DROP TABLE. Four ways it can be wrong, and every one of them is quiet.
   *
   *   A NON-INTEGER OR OUT-OF-BAND `chance` is a percentage that means nothing:
   *     the roll is `rng.int('loot.chance', 1, 100) <= chance` (encounter.ts,
   *     porting `rng.percent`, resolvers.lua:429), so 35.5 rounds nowhere in
   *     particular and 150 is a 100 written in a way that hides a typo.
   *   AN EMPTY `pick` WOULD THROW MID-SPAWN. `rng.int(label, 0, -1)` is a
   *     RangeError from src/shared/rng.ts:219, raised synchronously inside
   *     `seedTestEncounter`, which runs at boot AND on every floor reset. A
   *     content typo would take the server down in the middle of a wipe.
   *   AN UNKNOWN ITEM ID reaches the floor and renders as the LOUD violet
   *     fallback box on every client — the failure this project's whole asset
   *     rule exists to make impossible. It is caught here rather than at the
   *     drop, because at the drop it is one unlucky party's evening.
   *   A DUPLICATE ID inside one `pick` silently doubles that item's weight. The
   *     draw is a uniform index over the array (resolvers.lua:434), so a list
   *     that names the same coat twice is a table that is 2/7 coat and reads as
   *     1/7 to anyone who glances at it.
   *
   * `chance` 0 is LEGAL and is not a mistake worth refusing — it is how a
   * template says "not yet, but the table is written". It still takes its one
   * `loot.chance` draw, exactly as upstream still calls `rng.percent(0)` before
   * returning (resolvers.lua:429), and the stream position stays put.
   */
  if (template.drops !== undefined) {
    const { chance, pick } = template.drops;
    if (!Number.isInteger(chance) || chance < 0 || chance > 100) {
      problems.push(`${where} drops.chance ${chance} must be an integer 0..100`);
    }
    if (pick.length === 0) {
      problems.push(`${where} drops.pick is empty — the index draw would throw at spawn`);
    }
    const seen = new Set<string>();
    for (const itemId of pick) {
      // `itemById`, DELIBERATELY, AND NOT `resolveItem`. Everywhere else an id
      // may be an ego'd one, because it came off the wire or out of a save file
      // and describes an item that was rolled. A drop table is the other side of
      // that: it names the BASE the roll starts from, and the egos are added
      // afterwards from the quality table. Accepting `item_x~ba2` here would let
      // an authored row hand out a fixed ego'd item and bypass the roll — which
      // is a design decision, and would arrive disguised as a content typo.
      if (itemById(itemId) === undefined) {
        problems.push(`${where} drops.pick names '${itemId}', which is not in the item catalogue`);
      }
      if (seen.has(itemId)) {
        problems.push(`${where} drops.pick lists '${itemId}' twice — that doubles its weight`);
      }
      seen.add(itemId);
    }
  }

  // A creature that behaves like an elite must LOOK like one. The ring is the
  // only warning the player gets, and an unringed thing that hunts the isolated
  // detective and walks around a chokepoint is a bug report, not a monster.
  const isElite = template.huntsIsolated || template.shoulderAfter > 0;
  if (isElite && template.rank === ActorRank.Normal) {
    problems.push(`${where} carries elite behaviour but rank is ${template.rank}`);
  }

  return problems;
}
