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
import {
  LIFE_PER_CON,
  RANK_VALUE,
  lifeGainedTo,
  spreadStatPoints,
  statPointsGainedTo,
} from '../../shared/leveling.ts';
import { STAT_BASE } from '../engine/derived.ts';
import { ActorRank } from '../../shared/protocol.ts';
import { ITEMS, itemById } from './items.ts';
import { resolveLevelup, resolveMBonus, resolveRngAvg } from './resolvers.ts';
import type { TileXY } from '../../shared/coords.ts';
import { BLEED_POWER, EffectId } from './effects.ts';
import type { MonsterInit, OnHitStatus } from '../engine/actor.ts';
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
  /** Hit points at level 1. The BASE of a curve — see `lifeRating`. */
  readonly maxHp: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   HOW THIS BODY GROWS. `life_rating` — Actor.lua:187.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream never authors a monster's power; it authors a monster's SHAPE and
   * lets a level do the arithmetic. Every hit point in this file used to be a
   * frozen literal — husk 25, elite 95, boss 220 — which is why a level-40
   * character would have had nothing left that could threaten them.
   *
   * ABSENT MEANS 10, the engine default, so a template that says nothing still
   * grows at the ordinary rate rather than not at all.
   */
  readonly lifeRating?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   WHAT IT KNOWS. Talent ids, and absent means it can only swing.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's monsters carry `resolvers.talents{...}` and use them constantly;
   * ours could not use one at any price until this field existed. See
   * `MonsterActor.talents` for why the missing piece was a PATH rather than
   * content — the resolution half has always been generic over actors.
   *
   * ═══ A MONSTER'S TALENTS ARE ITS OWN, NOT A CLASS'S ═══
   * Nothing stops a template naming a player talent and it would mostly work.
   * But a husk casting the Watchman's Ward Rush is a husk wearing somebody's
   * profession, and every number in a player talent was tuned against a
   * resource pool that a creature does not have. The roster gets its own.
   *
   * ABSENT IS THE COMMON CASE and costs nothing: `monsterInit` writes no field,
   * no sheet is attached, and the creature behaves exactly as it did before any
   * of this existed.
   */
  readonly talents?: readonly string[];
  /**
   * WHICH STATS THIS BODY PUTS ITS LEVELLING POINTS INTO. Upstream's
   * `auto_stats`, dealt round-robin by `spreadStatPoints`.
   *
   * Scaling hit points WITHOUT this does not make a fight harder, it makes it
   * LONGER — a six-hundred-hit-point husk swinging a level-1 weapon cannot
   * threaten anybody, it just takes four minutes to kill. That is a worse
   * outcome than leaving both flat, because the tedium is invisible in a test
   * and obvious in a session.
   *
   * EMPTY OR ABSENT IS A BODY THAT DOES NOT GROW, which is a legitimate thing to
   * author for a prop or a training dummy.
   */
  readonly autoStats?: readonly string[];
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
   * WHAT A LANDED BLOW FROM THIS CREATURE ALSO DOES — see `OnHitStatus`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ABSENT ON MOST OF THE ROSTER AND THAT IS THE POINT. A status every monster
   * inflicts is not a status, it is a damage formula written twice. Upstream is
   * the same: the overwhelming majority of ToME's NPCs have no `on_melee_hit`
   * at all, and the ones that do are the ones you remember.
   *
   * Absent costs nothing at runtime — `strike` guards on it and takes the same
   * branch it always has, with no rng draw, so adding this field shifted no
   * seeded stream for any creature that declined it.
   */
  readonly onHit?: OnHitStatus;

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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ANT'S OWN SCHEME. `ant.lua:32` -> `autolevel_schemes.lua:25-27`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This read `['con', 'str']` and that was a divergence from the creature it
   * is adopted from. `BASE_NPC_ANT` declares `autolevel = "warrior"`, and the
   * warrior scheme is:
   *
   *     self:learnStats{ self.STAT_STR, self.STAT_STR, self.STAT_DEX }
   *
   * No Constitution at all. The husk copied the ant's authored `con = 13`
   * verbatim and then grew it, which upstream's ant never does.
   *
   * ═══ IT MATTERED THE DAY CONSTITUTION STARTED PAYING MONSTERS ═══
   * It was invisible while a monster's Constitution bought nothing — the husk
   * was quietly hoarding a stat that did nothing, and the two lists produced the
   * same creature. `monsterInit` now pays four hit points a point, exactly as a
   * player is paid, and on the old list that made a level-20 husk 47% tougher on
   * its own. Correcting the scheme is what keeps this a PARITY change rather
   * than a retune of the early game: the commonest creature in the game keeps
   * the hit points it has always had.
   *
   * WHAT IT GAINS INSTEAD is what the ant gains — two thirds Strength rather
   * than one half, and Dexterity where the Constitution was. It hits slightly
   * harder and slightly more often as it levels, which is the ant's own curve.
   */
  autoStats: ['str', 'str', 'dex'],
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
/** GAME TURNS the orb's slow asks for, before any save scales it down. */
const ORB_SLOW_TURNS = 3;
/** The wraith's own `combatPhysicalpower`. See `CLAW_APPLY_POWER` for why it is a literal. */
const ORB_APPLY_POWER = 10;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORB DRAGS — the roster's ranged rider, and the wraith's whole argument.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT WAS WRONG WITH THE WRAITH ═══
 * Its intent line reads "kites — punishes a party that clumps"
 * (content/encounter.ts) and its numbers back the first half: `minRange 2`,
 * `preferredRange` out at the edge, an orb that takes two to three game turns
 * to cross. But a kiter is only a problem while you cannot close, and nothing
 * it did made closing harder. Walk at it for three turns and the fight is a
 * melee fight — which is to say, the fight the husk already gives you.
 *
 * ═══ SLOWED IS EXACTLY THE COUNTER TO THE COUNTER ═══
 * A player has 3 MP a round (4 for the Inspector) and a move costs 1, so −1 MP
 * is a THIRD of your legs. Against a creature whose entire plan is to stay four
 * tiles away, losing a third of your closing speed is the difference between
 * "walk at it" and "you need a plan". game-design.md § 7 lists Slowed as −1 MP
 * for exactly this kind of moment.
 *
 * AND IT CREATES A ROLE PROBLEM RATHER THAN A DAMAGE PROBLEM. The Inspector
 * barely cares — she can shoot from where she is standing. The Watchman cares
 * enormously, and he is the one who has to get there. That is a thing a party
 * talks about in a voice channel, which is the entire point of the game.
 *
 * ═══ THREE TURNS ASKED, AND THE SAVE IS MEANT TO BITE ═══
 * `docs/game-design.md` § 11's sample Record is *"Dalt saves (phys 38 vs power
 * 31, 68%) — Slowed 1 turn, not 3."* — this is that line, with these numbers.
 * Measured over 400 applications the ask of 3 lands as 1.4 turns on a Watchman
 * (32% of the time) and 2.0 on an Alchemist (63%). The tank shrugs it off most
 * often, which is the same incentive the elite's claw creates, arrived at by
 * the same route: the physical save, and no separate rule.
 *
 * ═══ IT RIDES THE ORB AND THE SWING ALIKE ═══
 * `MonsterActor.onHit` is read by BOTH `strike` and the fire site, so a wraith
 * cornered into melee drags at you too. That is one creature with one property
 * rather than two rules, and a cornered kiter making it harder to stay on top
 * of it is the correct behaviour for the one situation it least wants to be in.
 */
export const INDEX_WRAITH: MonsterTemplate = Object.freeze({
  /**
   * NO TALENTS, AND IT HELD GRASPING HOLD FOR EXACTLY ONE AFTERNOON.
   *
   * It was the obvious creature to give the first one to and it was the wrong
   * one, for a reason a moment's arithmetic would have shown: this is a
   * `RangedKiter` with `attackRange: 6` and the talent reaches 1.5. It kites by
   * design — closing is the one thing its profile will not do — so the option
   * was offered to the AI on every turn of every fight and `canUseTalent`
   * refused it on range every single time.
   *
   * Nothing failed. The sheet attached, the seam worked, the AI asked. A talent
   * a creature can never be in position to use is indistinguishable, from every
   * test and every log line, from a creature that simply chose not to.
   *
   * It lives on the Glut now, whose own docblock names the problem it fixes.
   */
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['mag', 'dex'],
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 80, AND IT WAS 50 — THE ORB HAS TO LAND AT LEAST ONCE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This number has never been about how hard it is to kill. It is about TIME
   * TO KILL: the orb takes 1.5 game turns to cross the stand-off, so a wraith
   * that dies inside one party round never fires at all, and the whole kiting
   * creature is a stationary 50 hit points. `monsters.test.ts` pins that as
   * `maxHp / party > 1.5` and records the argument.
   *
   * THE INTRA-TURN BUDGET MOVED THE DENOMINATOR. A party that can chain two
   * at-will talents in one round deals ~51.4 instead of ~25.7 — Crude Blow and
   * Revolver Shot are both `cooldownTurns: 0`, so the second cast is real — and
   * at 50 the ratio fell to 0.97. The creature died before its first orb.
   *
   * ═══ 1.6x, NOT THE FULL 2x, AND THAT IS THE JUDGEMENT ═══
   * Doubling would hold the designed time-to-kill exactly, for a party that
   * chains optimally every single round. No real party does: the Alchemist's
   * Flare is reagent-gated to about four rounds of doubles, cooldowns interrupt
   * chains, and a new player who has not worked out that talents beat walking
   * into things got no faster at all. Scaling the full 2x would make the game
   * measurably harder for the person least equipped to notice why.
   *
   * 80 restores the invariant (80 / 51.4 = 1.56) with the least movement that
   * does. If play shows parties chaining more reliably than this assumes, the
   * honest next step is to raise it again — not to have guessed higher now.
   *
   * ═══ AND IT RE-OPENS A DEVIATION THE PORT HAD JUST CLOSED. SAID PLAINLY. ═══
   * 50 was `resolvers.rngavg(40,60)` from losgoroth.lua:63 — a real ported
   * number, and `monsters.test.ts` records the moment it stopped being a
   * deviation. 80 is not upstream's. The trade is deliberate: upstream has no
   * intra-turn budget, so its life values were never sized against a party that
   * acts twice a round, and holding a ported number that makes the creature's
   * own orb unreachable would be fidelity to the digit at the cost of the
   * design. The elite went the other way in the same commit — to 95, which IS
   * the port — so this is a judgement about one creature, not a policy.
   */
  maxHp: 80,
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

  /** THE ORB DRAGS. See this template's header. */
  onHit: { effectId: EffectId.Slowed, turns: ORB_SLOW_TURNS, power: ORB_APPLY_POWER },

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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ELITE'S CLAW — the roster's one melee rider, and the only one on purpose.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THE ELITE AND NOT THE HUSK ═══
 * An Index Husk is the first thing a level-1 character ever fights, and the
 * first fight has one job: teach that walking into a marker starts one. A
 * status on it would put an unexplained badge on a player's portrait in the
 * thirty seconds where they are still working out which token is theirs.
 *
 * The Overwritten Husk is the opposite case. Before this it was sixty hit
 * points and a slightly bigger number — "the elite ring, and a reason to
 * retreat" (content/encounter.ts) in intent, but mechanically just a longer
 * version of the same fight. A rider is what makes it a DIFFERENT fight: the
 * damage keeps arriving after you step away, so disengaging stops being free
 * and the Alchemist's Mend Wounds stops being optional.
 *
 * ═══ BLEEDING, BECAUSE IT IGNORES ARMOUR ═══
 * game-design.md § 7: "Bleeding (damage per turn, ignores armour)". That is the
 * property that makes it the right rider for an elite — the Watchman is the
 * body standing in front of it, the Watchman is the one wearing armour, and a
 * rider that armour answered would be a rider that only ever hurt the people
 * who were already fragile.
 *
 * ═══ THE POWER IS THE CREATURE'S, AND THE SAVE IS REAL ═══
 * `power` is its own physical power, so a Watchman with the Strength to stand
 * there shrugs it off more often than an Inspector caught in melee — which is
 * the correct incentive and required no separate rule to express. A save that
 * bites shortens the bleed rather than cancelling it, and the Record says so.
 *
 * THREE TURNS AND 3 DAMAGE A TURN (`BLEED_POWER`). Nine damage on a 60-hp elite
 * fight is a real cost and not a second health bar; the point is the pressure
 * it puts on WHEN you disengage, not the total.
 */
/** GAME TURNS the claw's bleed asks for, before any save scales it down. */
const CLAW_BLEED_TURNS = 3;
/**
 * The elite's own `combatPhysicalpower`, as a literal.
 *
 * A template is DATA. Calling a derived getter from inside a frozen object
 * literal would make the roster's numbers depend on the order two modules
 * happened to initialise in, and `combat` is defined further down this very
 * object. test/server/monsters.test.ts pins this against the real function, so
 * the literal cannot drift from the sheet it describes.
 */
const CLAW_APPLY_POWER = 12;

export const INDEX_HUSK_ELITE: MonsterTemplate = Object.freeze({
  /**
   * WHAT MAKES AN ELITE AN ELITE. Until this, the Overwritten Husk was the
   * common husk with better numbers — and a monster whose only difference is a
   * bigger number is a normal monster wearing a ring.
   *
   * Breaching Blow persists after the creature dies, which is the shape an
   * elite wants: the party has to decide whether to kill it FIRST, rather than
   * whether to kill it harder.
   *
   * `MeleeChaser` at `attackRange: 1` against a 1.5-reach talent — it arrives.
   */
  talents: ['talent:breaching_blow'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['str', 'con'],
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 95, AND IT WAS 60 — WHICH IS THE PORT, AND CLOSES A STANDING DEVIATION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `resolvers.rngavg(90,100)` = 95 is what ToME's ghoul ladder authors across
   * ALL THREE tiers (ghoul.lua:54, :71, :92), buying the top tier's threat
   * entirely with dam/atk/apr/def/armour/cadence rather than with life.
   * `monsters.test.ts` has carried 60 as an explicit deviation and said what
   * would end it: *"this deviation is due a re-argue the next time the elite is
   * tuned; it is left alone here because retuning is a separate job with its own
   * measurements."*
   *
   * This is that job, and the measurement points the same way. The intra-turn
   * budget lets a party chain two at-will talents a round — Crude Blow and
   * Revolver Shot are both `cooldownTurns: 0` — so party damage went from ~25.7
   * a round to ~51.4. At 60 the elite is 1.17 rounds: the thing
   * `content/encounter.ts` calls *"a reason to retreat"*, dying before anybody
   * decides anything. At 95 it is 1.85, and the number is upstream's rather than
   * one this project invented to hit a feel.
   */
  maxHp: 95,
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

  /**
   * THE CLAW. See this template's header for why it is the elite and why it is
   * Bleeding.
   *
   * `power` is `combatPhysicalpower` computed off the sheet below — written as
   * a literal rather than derived, because a template is DATA and calling a
   * derived getter from inside a frozen object literal would mean the roster's
   * numbers depended on the order two modules happened to initialise in.
   * `test/server/monsters.test.ts` pins it against the real function, so the
   * literal cannot drift from the sheet it describes.
   */
  onHit: {
    effectId: EffectId.Bleeding,
    turns: CLAW_BLEED_TURNS,
    power: CLAW_APPLY_POWER,
    magnitude: BLEED_POWER,
  },

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INDEX EIDOLON — dangerous in the trees and nowhere else.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three monster templates was the ceiling on everything: sixteen destinations
 * and six kinds of country all opened onto the same husk, the same wraith and
 * the same elite, so a forest and a moor were the same fight in two colours.
 * These two are keyed to the grounds `makeArena` builds, and each is dangerous
 * on exactly one of them.
 *
 * THE WOOD OPENS 0.34 OF ITS ROOM — arena.ts's own words for that band are *"a
 * corridor system and a ranged monster can never be reached"*, and sightlines
 * run about four tiles. A creature that is FAST is lethal there and harmless
 * anywhere else: you meet it at four tiles, it acts 1.2 times for your one, and
 * it is on you before you get a second decision. On the open moor you see it
 * coming from eight tiles away and shoot it to pieces, because it is made of
 * paper.
 *
 * ═══ PORTED FROM `canine.lua:40-43`, THE BASE EVERY WOLF IS BUILT ON ═══
 *
 *     global_speed_base = 1.2,
 *     stats = { str=10, dex=17, mag=3, con=7 },
 *     combat_armor = 1, combat_def = 1,
 *
 * Dexterity leads by a mile and Constitution is the worst stat on the sheet:
 * upstream states "fast and fragile" in the stat block itself, and it is the
 * exact creature this ground wanted. Life is the wolf's own
 * `resolvers.rngavg(40,70)` (canine.lua:52) = 55.
 *
 * No new art: `enemy_index_eidolon_s` has been cut, in the manifest and drawing
 * nothing since the day it was made.
 */
/**
 * GAME TURNS the eidolon's touch asks for, before any save scales it down.
 *
 * THREE, WHICH IS THE ROSTER'S OWN NUMBER — `CLAW_BLEED_TURNS` and
 * `ORB_SLOW_TURNS` are both three, and matching them is a better argument than
 * a duration invented out of caution about a new mechanic. The mental save
 * shortens it from there, and `CONFUSE_POWER` (content/effects.ts) explains why
 * the CHANCE is upstream's fifty and untouched: duration is the knob a game
 * controls, chance is the one ToME already settled.
 */
const TOUCH_CONFUSE_TURNS = 3;
/**
 * The eidolon's own `combatMindpower`, as a literal — see `CLAW_APPLY_POWER`
 * for the full reason a template may not call a derived getter.
 *
 * MINDPOWER AND NOT PHYSICAL POWER, because the effect is `type: mental`
 * (mental.lua:71) and `Actor.lua:6981-6986` keys the save off the EFFECT rather
 * than off the attack that delivered it. They are 11 and 10 here, close enough
 * that reading the wrong one would look right in a test and be wrong in the
 * fiction: what this creature does to you is not a matter of how hard it hits.
 */
const TOUCH_APPLY_POWER = 11;

export const INDEX_EIDOLON: MonsterTemplate = Object.freeze({
  /**
   * THE BASE WOLF HAS EXACTLY ONE TALENT AND THIS CREATURE IS THE BASE WOLF.
   *
   * canine.lua:55-57 gives the stat block this template is ported from a single
   * resolver: T_RUSH. It was missing, and its absence is what made the design
   * note above aspirational — globalSpeed alone cannot produce "it is on you
   * before you get a second decision", because a fast creature crossing open
   * ground is a fast creature you shoot four times instead of five.
   *
   * MeleeChaser at attackRange 1, and Rush is the thing that gets it there.
   */
  talents: ['talent:rush'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['mag', 'wil'],
  id: 'index_eidolon',
  displayName: 'Index Eidolon',
  description:
    'A reading of somebody that the Index kept after it stopped keeping them. It moves the way ' +
    'a misremembered thing moves — too quickly, and only ever towards you.',
  sprite: 'enemy_index_eidolon_s',
  rank: ActorRank.Normal,

  // canine.lua:52 `max_life = resolvers.rngavg(40,70)` = 55.
  maxHp: resolveRngAvg(40, 70),
  hpRegen: 0,

  // ═══ THE WHOLE CREATURE IS IN THIS NUMBER ═══
  // canine.lua:40 `global_speed_base = 1.2`, VERBATIM. It is the only monster in
  // the roster that acts more often than the player, and in a room with
  // four-tile sightlines that is the difference between "something is coming"
  // and "something is here".
  globalSpeed: 1.2,
  speedFactor: 1,

  profile: AiProfile.MeleeChaser,
  // The same eight as the rest of the roster. It is NOT given a short leash to
  // make it an ambusher — THE TREES DO THAT, which is the entire point: the same
  // creature on the open moor notices you at eight tiles and dies crossing them.
  aggroRange: 8,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  huntsIsolated: false,
  shoulderAfter: 0,

  drops: { chance: 100, pick: idsOfTier('common') },

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TOUCH — and it is the creature's own sentence, made mechanical.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * *"A reading of somebody that the Index kept after it stopped keeping them.
   * It moves the way a misremembered thing moves."* It has had a description
   * about misremembering and a stat line about speed, and nothing joining them.
   *
   * CONFUSED is that join: the thing that moves like a misremembering makes YOU
   * misremember which way you were going (mental.lua:67-87 — half your steps
   * come out somewhere else, and a talent can fail outright for its full turn).
   * `icon_status_confused.png` has been on disk since the status atlas was cut
   * and had never been referenced by anything.
   *
   * ═══ WHY THIS CREATURE AND NOT ANOTHER ═══
   * Three of eight already carry an `onHit` — the wraith slows, the elite
   * bleeds, the boss stuns — and all three are PHYSICAL. This is the first
   * mental one, and it goes on the body it belongs to rather than onto the
   * Inquisitor, which is already the roster's pure-debuff creature and would
   * become two debuffs wearing one robe.
   *
   * ═══ AND IT IS MELEE, WHICH IS THE COUNTERPLAY ═══
   * Confusion arriving on CONTACT means the answer is the answer this creature
   * already had: do not let it reach you. A ranged confusion would have no
   * counter but the save. The eidolon only lives on `THICKET` ground, so this is
   * a property of one place rather than of the whole moor.
   */
  onHit: {
    effectId: EffectId.Confused,
    turns: TOUCH_CONFUSE_TURNS,
    power: TOUCH_APPLY_POWER,
  },

  combat: {
    // canine.lua:41, VERBATIM.
    stats: { str: 10, dex: 17, mag: 3, con: 7 },
    // canine.lua:43 `combat_armor = 1, combat_def = 1`, VERBATIM. Almost nothing
    // of either, which is what makes the trade honest: it hits first, and once.
    mods: { armour: 1, def: 1 },
    weapon: {
      dam: resolveLevelup(resolveMBonus(30, 12)),
      atk: 12,
      apr: 3,
      damMod: { dex: 0.8 },
    },
    profile: {
      resists: {
        // OURS, not a port. It is a thing the Index made, so half of its own
        // element slides off — the same identity `INDEX_WRAITH` carries and for
        // the same reason. Physical is left alone: the answer to this creature
        // is to hit it, and it must not also be resistant to being hit.
        [DamageType.Darkness]: 50,
      },
    },
    // 1.5, MATCHING THE HUSK, and it is not 1: `validateTemplate` refuses a
    // melee reach below the diagonal step (√2), because a creature standing
    // corner-to-corner with you IS adjacent and a reach of exactly 1 would let
    // it be stood next to without being able to swing.
    range: 1.5,
    minRange: 0,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INDEX CAIRN — the reason the fen is not a free win.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fen's channels give the player something no other ground does: a place to
 * stand where you can SHOOT and cannot be REACHED. Measured at 6.4% of visible
 * positions against 0.0% everywhere else. That is a real tactic and it should
 * stay — but a tactic with no answer is not a tactic, it is a bug that has not
 * been found yet, and the first party to notice would spend every fen fight
 * standing on one bank.
 *
 * SO THE FEN GETS SOMETHING THAT SHOOTS BACK. Across a channel neither of you
 * can close, both of you can see, and the fight becomes a firing line decided by
 * range and cover rather than by who reaches whom. That is a fight this game has
 * never had.
 *
 * ═══ AND IT IS HELPLESS ANYWHERE ELSE, WHICH IS THE SAME DESIGN AS THE EIDOLON ═══
 * `global_speed_base = 0.7` and twenty-three hit points: on open ground you walk
 * away from it, or you walk up to it and it dies in half a round. It is only
 * dangerous when something it cannot cross is between you — and the fen is the
 * only ground that provides one.
 *
 * ═══ PORTED FROM `crystal.lua:30-39` ═══
 *
 *     ai = "dumb_talented_simple", ai_state = { talent_in=1 },
 *     max_life = resolvers.rngavg(12,34),
 *     stats = { str=1, dex=5, mag=20, con=1 },
 *     global_speed_base = 0.7,
 *     combat_def = 1,
 *     never_move = 1,
 *
 * `never_move` HAS NO EQUIVALENT HERE AND NEEDS NONE. It is a `RangedKiter` at
 * 0.7 speed, and the water does upstream's job for it: a kiter on the far bank
 * cannot approach whatever it does, so the terrain supplies the behaviour that
 * upstream had to author as a flag. The deviation is the implementation, not the
 * creature.
 *
 * Twenty-three hit points against a party that deals ~51 a round is deliberately
 * nothing — it survives because it cannot be reached, never because it is tough,
 * and the moment a player finds the ford it is over. That is the fight.
 *
 * No new art: `enemy_index_cairn_s` was cut and has drawn nothing until now.
 */
export const INDEX_CAIRN: MonsterTemplate = Object.freeze({
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['dex', 'cun'],
  id: 'index_cairn',
  displayName: 'Index Cairn',
  description:
    'A stack of citations weathered into the shape of a marker stone. It does not come for you. ' +
    'It simply has a clear view, and time.',
  sprite: 'enemy_index_cairn_s',
  rank: ActorRank.Normal,

  // crystal.lua:34 `max_life = resolvers.rngavg(12,34)` = 23.
  maxHp: resolveRngAvg(12, 34),
  hpRegen: 0,

  // crystal.lua:36 `global_speed_base = 0.7`, VERBATIM. Half the reason you can
  // ignore it on dry ground.
  globalSpeed: 0.7,
  speedFactor: 1,

  profile: AiProfile.RangedKiter,
  // THE LONGEST REACH IN THE ROSTER, and the only field that is tuned rather
  // than ported: the wraith stands off at 4 and shoots to 6, so a cairn that did
  // the same would be a slower wraith. At 8 it out-ranges everything the party
  // owns at level 1, which is what makes the far bank of a channel a problem to
  // solve rather than a place to ignore.
  aggroRange: 9,
  preferredRange: 6,
  minRange: 3,
  attackRange: 8,
  huntsIsolated: false,
  shoulderAfter: 0,

  // Slower than the wraith's orb, so the water buys real time — you can see it
  // coming across the channel and step out of the lane.
  projSpeed: 1,
  damageMin: 8,
  damageMax: 12,

  drops: { chance: 100, pick: idsOfTier('common') },

  combat: {
    // crystal.lua:35, VERBATIM. Magic 20 and Constitution 1 — everything it has
    // is in the shot.
    stats: { str: 1, dex: 5, mag: 20, con: 1 },
    // crystal.lua:38 `combat_def = 1`; `combat_armor` is absent upstream and
    // therefore 0 here. It dodges nothing and absorbs nothing.
    mods: { armour: 0, def: 1 },
    weapon: {
      dam: resolveLevelup(resolveMBonus(30, 10)),
      atk: 8,
      apr: 6,
      damMod: { mag: 0.8 },
    },
    profile: {
      resists: {
        [DamageType.Darkness]: 50,
        // IT IS MADE OF STONE AND IT STILL BREAKS. No physical vulnerability —
        // the wraith's −30 says "reach it and it folds", and this creature's
        // whole problem is that you often cannot reach it, so the same line here
        // would be a discount on a fight the terrain already decided.
      },
    },
    range: 8,
    minRange: 3,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INDEX GLUT — the roamer that had a name, a sprite, and no creature.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `world/roamers.ts` has drawn *"Something Redacted"* on the overworld since
 * roamers landed, wearing `enemy_index_glut_s`. Walk into it and you fought two
 * husks, because the ambush roster never consulted the marker. That file's own
 * header states the promise it was breaking:
 *
 *   > The sprites are the AMBUSH ROSTER's own, so the thing you decided to walk
 *   > into is the thing you meet — a roamer that looked like a husk and produced
 *   > a wraith would make the decision it exists to offer a lie.
 *
 * There was no glut to produce. This is it, and it is the fourth piece of cut
 * art connected to a creature rather than the first — `INDEX_CAIRN` ends with
 * the same sentence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A WALL THAT HITS BACK, WHICH IS A FIGHT THIS GAME HAS NOT HAD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE WHOLE ROSTER, MEASURED, because the first draft of this comment claimed
 * three things about it that were not true and the table is what caught them:
 *
 *     creature           hp  regen  armour  def  atk  apr  str  dex
 *     Index Cairn        23      0       0    1    8    6    1    5
 *     Index Husk         25      0       1    1   15    7   12   10
 *     Index Eidolon      55      0       1    1   12    3   10   17
 *     Index Glut         60      2       4    0    2    6   20    8
 *     Index Wraith       80      0       0   20   15   15   10    8
 *     Overwritten Husk   95      0       2    4   18    8   12   10
 *
 * SO IT IS NOT THE BIGGEST THING IN THE GAME. It is fourth of six on hit
 * points, and the wraith a level-3 party already meets has twenty more. Saying
 * otherwise would have oversold the creature and, worse, would have justified
 * softening it later against a number that was never real.
 *
 * WHAT IS ACTUALLY UNIQUE IS THE ONE COLUMN NOTHING ELSE HAS A NUMBER IN:
 *
 *   regen 2 per turn  — the only creature in the game whose health goes UP
 *   armour 4          — twice the next highest, so chip damage is nearly free
 *   def 0             — the lowest; it dodges nothing at all
 *   atk 2             — the lowest by a factor of four; the roster runs 8 to 18
 *
 * Read together those four are one creature and one question, and it is a
 * question this game has never asked: not whether the party can deal ENOUGH
 * damage, but whether it can deal damage FASTER THAN A THRESHOLD. Everything
 * else on the moor dies to patience. A party that pokes at this does not win
 * slowly, it does not win — the armour eats the small hits and the regen takes
 * back what is left. A party that commits kills it in a handful of rounds.
 *
 * AND IT IS NOT A DIFFICULTY SPIKE, because it can barely hit you. `atk = 2`
 * against a roster that runs 8 to 18: it misses, and misses, and then lands for
 * a great deal. You are rarely in danger of dying to it quickly; you are in
 * danger of standing there for ten rounds achieving nothing. Those are
 * different fears and this is the only creature that supplies the second.
 *
 * ═══ PORTED FROM `troll.lua:24-45` (base) AND `troll.lua:53-60` (forest troll) ═══
 *
 *     combat = { dam=resolvers.levelup(resolvers.mbonus(45, 10), 1, 1),
 *                atk=2, apr=6, physspeed=2, dammod={str=0.8} },
 *     life_regen = 2,
 *     rank = 2,
 *     size_category = 4,
 *     stats = { str=20, dex=8, mag=6, con=16 },
 *     fear_immune = 1,
 *     max_life = resolvers.rngavg(50,70),
 *     combat_armor = 4, combat_def = 0,
 *
 * `physspeed = 2` IS THE ONE THING NOT PORTED, and it is worth saying why
 * rather than leaving it as an omission. ToME separates PHYSICAL speed from
 * GLOBAL speed: upstream's troll walks at full pace and swings at half. This
 * engine has one `speedFactor` for what an action costs, and every monster in
 * the file leaves it at 1 — slowness is expressed through `globalSpeed`, which
 * scales moving and swinging together (see `actor.ts`, the two clocks).
 *
 * Spending `globalSpeed` on it was tried in the head and rejected: at half rate
 * this creature cannot corner anybody, and a wall you can simply walk away from
 * is not a wall. So it keeps upstream's 1.0 and the slowness lives where the
 * source already put most of it — `atk = 2` and DEX 8, a thing that swings
 * often and connects rarely. The deviation makes it MORE dangerous than
 * upstream, which the sixty hit points and the four armour are already paying
 * for.
 *
 * `combat_def = 0`, VERBATIM: it dodges nothing. Every attack the party makes
 * lands. The armour is what makes them cheap, and that is the distinction the
 * fight is built on — you are never missing, you are being absorbed.
 *
 * No new art: `enemy_index_glut_s` was cut, shipped in the manifest, and has
 * drawn a marker that opened onto somebody else's fight until now.
 */
export const INDEX_GLUT: MonsterTemplate = Object.freeze({
  /**
   * ═══ THE FIRST CREATURE IN THE GAME THAT CAN DO SOMETHING ═══
   *
   * And it goes here rather than on the wraith because of the sentence this
   * template's own notes already carry: *"a wall you can simply walk away from
   * is not a wall."* That was written as a known weakness of the design — the
   * Glut absorbs everything the party throws and cannot corner anybody, so the
   * counterplay to the whole fight is to walk five tiles and keep shooting.
   *
   * Grasping Hold is the answer to that exact complaint. A slow absorber that
   * can pin you for three turns is finally the wall it was built to be, and it
   * costs nothing anywhere else: the creature is still slow, still misses
   * constantly, and still dies to anyone who deals with it before it arrives.
   *
   * MELEE CHASER, `attackRange: 1`, against a talent that reaches 1.5 — it gets
   * to use this, which is not a sentence that was true of the wraith.
   */
  talents: ['talent:grasping_hold'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['con', 'str'],
  id: 'index_glut',
  displayName: 'Index Glut',
  description:
    'Something the Index took and did not finish reading. It has kept growing in the parts that ' +
    'were left, and it closes the distance the way a filing cabinet would.',
  sprite: 'enemy_index_glut_s',
  rank: ActorRank.Normal,

  // troll.lua:59 `max_life = resolvers.rngavg(50,70)` = 60. Fourth of six — see
  // the table above; the armour and the regen are what make it feel like more.
  maxHp: resolveRngAvg(50, 70),
  /**
   * troll.lua:39 `life_regen = 2`, VERBATIM, AND IT IS THE WHOLE CREATURE.
   *
   * Every other template in this file is `hpRegen: 0`, so this is the first
   * monster in the game whose health bar can go BACKWARDS. Two a turn against
   * sixty is small enough that a committed party never notices it and large
   * enough that a cautious one never finishes. That gap is the fight.
   */
  hpRegen: 2,

  // troll.lua declares no `global_speed_base`, so 1.0 — VERBATIM. See the note
  // above on `physspeed`, which is the field that is deliberately not here.
  globalSpeed: 1,
  speedFactor: 1,

  profile: AiProfile.MeleeChaser,
  // The roster's standard eight. It is not given a longer leash to compensate
  // for being slow to kill: noticing you sooner would make it a chase, and this
  // creature is meant to be a decision you walked into on purpose.
  aggroRange: 8,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  huntsIsolated: false,
  shoulderAfter: 0,

  drops: { chance: 100, pick: idsOfTier('common') },

  combat: {
    // troll.lua:45, VERBATIM. Strength 20 IS the highest in the game; dexterity
    // 8 is not the lowest (the cairn is 5) but it is the lowest on anything that
    // has to walk up to you. Everything this creature has is in the swing.
    stats: { str: 20, dex: 8, mag: 6, con: 16 },
    // troll.lua:60 `combat_armor = 4, combat_def = 0`, VERBATIM.
    mods: { armour: 4, def: 0 },
    weapon: {
      // troll.lua:30 `dam=resolvers.levelup(resolvers.mbonus(45, 10), 1, 1)`.
      dam: resolveLevelup(resolveMBonus(45, 10)),
      /**
       * troll.lua:30 `atk=2`, VERBATIM, and it is not a typo upstream either.
       *
       * IT IS NO LONGER UNIQUE, and the correction belongs here rather than in
       * a commit message: INDEX_INQUISITOR carries the same 2 from
       * `elven-caster.lua:30`, because upstream reuses that combat line as
       * boilerplate across unrelated base NPCs. What is still true, and is what
       * the creature is built on, is that this is the least accurate thing in
       * the game THAT HAS TO WALK UP TO YOU — the Inquisitor's melee swing is
       * the pitiful thing that happens after you have already cornered it, and
       * its real weapon is an orb that takes no accuracy roll at all.
       */
      atk: 2,
      // troll.lua:30 `apr=6`. When it does land, your armour is most of the way
      // to irrelevant, which is what keeps a miss streak from being free.
      apr: 6,
      // troll.lua:30 `dammod={str=0.8}`, VERBATIM.
      damMod: { str: 0.8 },
    },
    profile: {
      resists: {
        // OURS, not a port — upstream's troll takes +50% from fire and this
        // engine has no fire. The Index's own half-resistance to darkness is
        // the identity every made thing in this file carries; physical is left
        // alone, because the answer to a wall is to hit it and it must not also
        // be resistant to being hit.
        [DamageType.Darkness]: 50,
      },
    },
    // 1.5, matching the rest of the melee roster. `validateTemplate` refuses
    // anything below the diagonal step.
    range: 1.5,
    minRange: 0,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO THAT LIVE ON THE OTHER MAP — AND WHY THEY ARE A PAIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Redaction shipped with harder DELVES and Alderbrook's open country. That
 * is backwards: a player crossing the door spends most of their time walking,
 * and walking was identical on both maps, so the second landmass read as the
 * first one with holes until you happened to open a door.
 *
 * These are its roamers. They are deliberately not "the husk but bigger" —
 * `monsters.test.ts` argues that a creature has to belong to something the
 * player chose, and a bigger husk belongs to nothing. What these two belong to
 * is EACH OTHER:
 *
 *   THE INSPECTOR hunts whoever is alone.  → so the party stays together
 *   THE INQUISITOR out-ranges and out-walks
 *     everyone, and must be closed down.   → so somebody has to leave
 *
 * That is one decision with no free answer, and it is the first time this game
 * has asked a party to solve two problems that contradict. Six friends in a
 * voice channel arguing about who goes is the entire pitch, and until now the
 * bestiary gave them nothing to argue about.
 *
 * BOTH SPRITES WERE CUT AND DRAWING NOTHING. `enemy_disgraced_inspector_s` was
 * referenced by no file at all; `enemy_high_inquisitor_s` appeared once, in a
 * comment in `content/items.ts` explaining that it is a monster sprite and NOT
 * a player class. They were the last two enemies in the manifest with nothing
 * behind them.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DISGRACED INSPECTOR — it did your job here, before here stopped.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Inspector is a PLAYER CLASS (`content/classes.ts`), and that is the whole
 * idea: the thing coming across the erased ground at you is what happened to
 * somebody who was doing exactly what you are doing, on this exact map, before
 * the Index finished with it. It is the only creature in the game that is a
 * person rather than a thing the Index made.
 *
 * ═══ IT IS THE ONLY ROAMER THAT PICKS ITS TARGET ═══
 * `huntsIsolated` is OURS, not upstream's, and it is the entire creature.
 * `ai/npc.ts` reads it and calls `mostIsolated(visible, ctx)` instead of taking
 * the nearest body — so this thing walks PAST the group to reach whoever
 * wandered off. Until now `INDEX_HUSK_ELITE` was the only template that set it,
 * which meant the mechanic existed only inside delves, where a party is already
 * standing in one room. Out on open country it means something completely
 * different: the moor is 170x100, splitting up is efficient, and this is the
 * cost of it.
 *
 * At `globalSpeed` 1.25 the person it picked cannot outrun it. That is not a
 * death sentence — sixty hit points and no armour at all means the party kills
 * it quickly once they turn around — it is a demand that they turn around.
 *
 * ═══ PORTED FROM `feline.lua:25-30` (base) AND `feline.lua:41-49` (snow cat) ═══
 *
 *     stats = { str=10, dex=20, mag=3, cun=18, con=6 },
 *     global_speed_base = 1.25,
 *     rank = 2,
 *     level_range = {3, nil},
 *     max_life = resolvers.rngavg(40,80),
 *     combat_armor = 0, combat_def = 8,
 *     combat = { dam=resolvers.levelup(5, 1, 0.7), atk=12, apr=15,
 *                dammod={str=0.5, dex=0.5} },
 *
 * `cun=18` HAS NOWHERE TO GO — this engine's `PrimaryStats` is str/dex/mag/con,
 * because nothing in the ported combat maths reads cunning. Dropped rather than
 * folded into another stat, which would be inventing a number and citing a
 * source for it.
 *
 * A SNOW CAT because the profile is exactly right and the fiction is ours to
 * write over it: fastest thing in the game, highest dexterity in the game,
 * dodges well, wears nothing, and `apr=15` means the armour the party is
 * wearing does not help. Upstream is a predator that runs down the straggler.
 * So is this.
 */
export const INDEX_INSPECTOR: MonsterTemplate = Object.freeze({
  /**
   * IT ALREADY HUNTED THE ISOLATED. NOW YOU CAN FEEL IT.
   *
   * huntsIsolated is invisible from the receiving end — a player who gets
   * picked on cannot tell targeting from bad luck. Uncorroborated triples its
   * damage against somebody with nobody beside them, which says the same thing
   * in one blow and makes the counterplay the one this elite pair was built
   * around: stand next to each other.
   *
   * MeleeChaser at attackRange 1 against a 1.5-reach talent — it arrives.
   */
  talents: ['talent:uncorroborated'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['dex', 'cun'],
  id: 'index_inspector',
  displayName: 'A Disgraced Inspector',
  description:
    'Somebody who worked this ground before it was taken, still working it. The badge is legible. ' +
    'Nothing else is.',
  sprite: 'enemy_disgraced_inspector_s',
  /**
   * ELITE, AND `validateTemplate` IS WHY — IT REFUSED THE NORMAL VERSION.
   *
   *   > A creature that behaves like an elite must LOOK like one. The ring is
   *   > the only warning the player gets, and an unringed thing that hunts the
   *   > isolated detective and walks around a chokepoint is a bug report, not a
   *   > monster.
   *
   * It was authored as `Normal` and the rule caught it, which is the rule
   * earning its keep rather than an inconvenience: this creature's whole
   * behaviour is that it IGNORES the nearest body and goes for whoever wandered
   * off. Without the ring that reads as broken pathfinding for the ten seconds
   * before somebody dies, and as a cheap trick afterwards. With it, the party
   * saw a marked thing arrive and chose to stay spread out.
   *
   * The rank costs it nothing in stats — see the essay on INDEX_HUSK_ELITE and
   * ToME's three-tier ghoul ladder, where all three ranks hold identical life
   * and every point of threat is bought with `dam`/`atk`/`apr`/`def`/armour.
   */
  rank: ActorRank.Elite,

  // feline.lua:46 `max_life = resolvers.rngavg(40,80)` = 60.
  maxHp: resolveRngAvg(40, 80),
  hpRegen: 0,

  // feline.lua:30 `global_speed_base = 1.25`, VERBATIM — the fastest thing in
  // the game, ahead of INDEX_EIDOLON's 1.2. Whoever it chose does not get away.
  globalSpeed: 1.25,
  speedFactor: 1,

  profile: AiProfile.MeleeChaser,
  aggroRange: 8,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  /**
   * OURS, AND IT IS THE POINT OF THE CREATURE.
   *
   * The second template in the game to set it and the first outside a delve.
   * See the essay above: on a 170x100 map where splitting up is the efficient
   * thing to do, a creature that walks past the group to reach the person who
   * wandered off is the only argument against it that is not a lecture.
   */
  huntsIsolated: true,
  shoulderAfter: 0,

  // THE DARK TERRITORY PAYS BETTER, which is the other half of `redactedSpec`'s
  // +1 litter: danger with no upside is a place you visit once.
  drops: { chance: 100, pick: idsOfTier('rare') },

  combat: {
    // feline.lua:25, VERBATIM but for `cun=18`, which this engine has no home
    // for. Dexterity 20 is the highest in the game.
    stats: { str: 10, dex: 20, mag: 3, con: 6 },
    // feline.lua:48 `combat_armor = 0, combat_def = 8`, VERBATIM. It dodges and
    // it wears nothing: hard to hit, and it folds the moment you connect.
    mods: { armour: 0, def: 8 },
    weapon: {
      // feline.lua:49 `dam=resolvers.levelup(5, 1, 0.7)`.
      dam: resolveLevelup(5),
      atk: 12,
      // feline.lua:49 `apr=15`, matching INDEX_WRAITH's. Whatever the party is
      // wearing is most of the way to irrelevant — the answer to this creature
      // is to kill it, not to tank it.
      apr: 15,
      damMod: { str: 0.5, dex: 0.5 },
    },
    profile: {
      resists: {
        // OURS. Half of the Index's own element slides off everything the Index
        // made — and whatever this used to be, it belongs to the Index now.
        [DamageType.Darkness]: 50,
      },
    },
    range: 1.5,
    minRange: 0,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HIGH INQUISITOR — a kiter you cannot walk away from, or up to.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The game has two ranged creatures and the party's answer to both is its legs.
 * INDEX_CAIRN never moves — reach it and it is over, and the fen exists to make
 * reaching it hard. INDEX_WRAITH kites at `globalSpeed` 0.84, which is slower
 * than a player, so a party that commits to the walk always closes.
 *
 * THIS ONE IS AS FAST AS YOU ARE. `globalSpeed` 1.0 on a `RangedKiter` with the
 * longest reach in the game means walking at it does not work: it gives ground
 * for exactly as long as you advance. The only things that close the distance
 * are cutting it off — which needs somebody going the other way — or ignoring
 * it, which costs 7 damage a player turn for as long as you ignore it.
 *
 * THE SECOND ELITE, AND THE FIRST ONE THAT IS NOT A BRAWL. `INDEX_HUSK_ELITE`
 * is a heavier melee problem; this is a different KIND of problem, which is
 * what makes a second elite content rather than escalation.
 *
 * ═══ NO ON-HIT EFFECT, AND THAT IS A DECISION ═══
 * The wraith's orb applies `Slowed` and the elite's claw applies `Bleeding`, so
 * this creature having neither looks like an omission. It is not. Slowing the
 * party from nine tiles, on a kiter that already retreats at their walking
 * speed, does not make closing the distance harder — it makes it IMPOSSIBLE,
 * and "somebody has to go and deal with it" would become "nobody can". The
 * pressure is meant to be a decision, not a wall.
 *
 * ═══ PORTED FROM `elven-caster.lua:24-52` (base) AND `:56-64` (elven mage) ═══
 *
 *     combat = { dam=resolvers.rngavg(5,12), atk=2, apr=6, physspeed=2 },
 *     ai_state = { talent_in=1 },
 *     stats = { str=20, dex=8, mag=6, con=16 },
 *     level_range = {2, nil},
 *     max_life = resolvers.rngavg(70, 80),
 *     combat_armor = 0, combat_def = 0,
 *
 * THE STAT LINE IS THE SAME ONE `INDEX_GLUT` CITES FROM `troll.lua:45`, and it
 * is worth saying so out loud because the coincidence reads as a copied
 * citation: upstream reuses `str=20, dex=8, mag=6, con=16` and `atk=2, apr=6,
 * physspeed=2` as boilerplate across unrelated base NPCs. Both citations were
 * checked against the files. They also barely overlap in play — the glut is a
 * strength-driven melee swing and this creature's damage is an ORB, which takes
 * no stats at all.
 *
 * `rank`, THE ORB AND THE RANGES ARE OURS. `damageMin`/`damageMax` 12-16 is
 * INDEX_WRAITH's orb, taken deliberately rather than tuned: this creature is not
 * a bigger gun, it is the same gun that you cannot walk away from. What upstream
 * supplies is a robed thing with seventy-five hit points and no armour or
 * defence whatsoever, which is exactly right — corner it and it dies.
 */
export const INDEX_INQUISITOR: MonsterTemplate = Object.freeze({
  /**
   * THE ONE CREATURE IN THE GAME THAT SPENDS ITS TURN DOING NO DAMAGE.
   *
   * Efface is a pure debuff and the Inquisitor is an elite `RangedKiter` with
   * `attackRange: 9` — reach 7 sits comfortably inside that, so this is a
   * talent it is actually in position to use, and kiting is already the
   * counterplay its profile implements.
   *
   * It is the most dangerous thing in the bestiary precisely because nothing
   * about it looks urgent: no damage numbers, no health bar moving, and four
   * turns later every roll the party makes is worse.
   */
  talents: ['talent:efface'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['wil', 'mag'],
  id: 'index_inquisitor',
  displayName: 'A High Inquisitor',
  description:
    'It decided what stayed. It is still deciding, out here, where there is nothing left to ' +
    'decide about but you.',
  sprite: 'enemy_high_inquisitor_s',
  rank: ActorRank.Elite,

  // elven-caster.lua:60 `max_life = resolvers.rngavg(70, 80)` = 75.
  maxHp: resolveRngAvg(70, 80),
  hpRegen: 0,

  // The base declares no `global_speed_base`, so 1.0 — VERBATIM, and it is the
  // whole creature. A player is pinned at 1.0 by D1, so this is the only ranged
  // thing in the game that does not lose a walking race.
  globalSpeed: 1,
  speedFactor: 1,

  profile: AiProfile.RangedKiter,
  aggroRange: 10,
  /**
   * THE OPERATIVE REACH — see the essay on INDEX_WRAITH's `attackRange`: `kite`
   * returns `advance` for anything beyond `preferredRange`, so this is the band
   * it actually fights in and `attackRange` below is a legality ceiling.
   *
   * 7 against the cairn's 6 and the wraith's 4. Longest in the game, and unlike
   * the cairn's it moves.
   */
  preferredRange: 7,
  /**
   * 3, NOT THE 4 THIS WAS AUTHORED WITH, and `validateTemplate` is the reason:
   *
   *   > At `minRange` 4 the pure diagonal at offset (3, 3) is Chebyshev 3
   *   > (inside the hole, so the AI backs off) and Euclidean 4.243 (outside it,
   *   > so `canAttack` would have allowed the shot).
   *
   * A creature that retreats from a tile it is willing to shoot from reads as
   * the server being broken, not as a weakness. 3 is `MAX_SAFE_MIN_RANGE` and
   * is the cairn's, and it costs this design nothing — the dead zone was never
   * the point. `preferredRange` is, and that is still the longest in the game.
   */
  minRange: 3,
  attackRange: 9,
  // NOT `huntsIsolated`. That belongs to the Inspector, and the two of them
  // pulling in opposite directions is the design — see the header. A creature
  // that both out-ranged the party AND chased the straggler would collapse the
  // decision into one answer.
  huntsIsolated: false,
  shoulderAfter: 0,

  projSpeed: 2,
  talentIn: 2,
  // INDEX_WRAITH's orb, deliberately identical. See the note above.
  damageMin: 12,
  damageMax: 16,

  drops: { chance: 100, pick: idsOfTier('rare') },

  combat: {
    // elven-caster.lua:51, VERBATIM. See the note above on why this matches the
    // glut's line and why it does not matter in play.
    stats: { str: 20, dex: 8, mag: 6, con: 16 },
    // elven-caster.lua:64 `combat_armor = 0, combat_def = 0`, VERBATIM. Nothing
    // at all, on an elite: the whole of its survival is the distance.
    mods: { armour: 0, def: 0 },
    weapon: {
      // elven-caster.lua:30 `dam=resolvers.rngavg(5,12)` = 8, `atk=2`, `apr=6`.
      // The melee swing is what happens when the party finally corners it, and
      // it is deliberately pitiful.
      dam: resolveRngAvg(5, 12),
      atk: 2,
      apr: 6,
      damMod: { mag: 0.8 },
    },
    profile: {
      resists: {
        [DamageType.Darkness]: 50,
      },
    },
    range: 9,
    minRange: 3,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WATCHER — the first boss, and the first thing in this game that stuns.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ActorRank.Boss` has been in the protocol since it was written. It has an
 * experience worth (`RANK_WORTH` 25, against the elite's 3), a render weight in
 * `view/projector.ts`, and its own assertions in `progression.test.ts`. NOTHING
 * IN THE GAME HAS EVER BEEN ONE. Seventeen destinations, a danger gradient
 * across two landmasses, and not a single set piece — every room is a generated
 * floor with a roster rolled into it, so the case file could be closed from end
 * to end without ever meeting something that was PUT there.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FICTION WROTE THIS BEFORE THE CODE DID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `places.ts` on the Redaction's Watcher's Altar: *"Whoever was leaving things
 * here never stopped. The pile has been added to since the country ended."*
 *
 * And `INDEX_CAIRN` is *"a stack of citations weathered into the shape of a
 * marker stone"*. THE PILE IS THE CREATURE. The blurb describes a thing that
 * outlasted the erasure and is still growing, on an altar, in a country that
 * ended — and the game already had a monster made of stacked citations. This
 * is that, at the size the sentence implies.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAKES IT A BOSS AND NOT A BIGGER CAIRN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `monsters.test.ts` sets the bar and it is the right one: *"a creature has to
 * BELONG TO SOMETHING THE PLAYER CHOSE... one that was merely a bigger husk
 * would still be scope creep."* Hit points alone do not qualify.
 *
 * SO IT STUNS, AND NOTHING ELSE IN THIS GAME EVER HAS. Measured across the
 * whole roster: two of eight creatures carry an `onHit` at all — the wraith
 * slows, the elite bleeds — and `EffectId.Stunned` is applied by exactly ONE
 * thing in the entire codebase, the Watchman's own `lockdown` talent. Being
 * stunned is a thing this game does TO monsters and has never done to a player.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE FIGHT ACTUALLY IS — READ OFF `ai/npc.ts`, NOT ASSUMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE FIRST VERSION OF THIS PARAGRAPH CALLED IT STATIONARY THREE TIMES AND THAT
 * WAS WRONG. `never_move` is upstream's flag and is not ported here, for the
 * same reason `INDEX_CAIRN` does not port it. `kite` decides everything, and it
 * has three branches:
 *
 *   beyond `preferredRange` 9   it ADVANCES — you cannot walk away from it
 *   between 3 and 9             it fires
 *   inside `minRange` 3         it BACKS AWAY, and if it cannot,
 *                               *"CORNERED. hold rather than fire a shot that
 *                               will be refused"* — it does nothing at all
 *
 * So it is mobile artillery holding a band, and the fight has a shape and a
 * counter. It moves at 0.7 against a player pinned at 1.0 by D1, so a party
 * that COMMITS closes on it; `populateDelve` puts it at the point furthest from
 * the door, which in a generated ruin is a corner, so the ground it can retreat
 * into is the ground it has already used.
 *
 * ═══ "GET INSIDE THREE TILES AND IT CANNOT ACT" IS WHAT THIS SAID, AND IT IS
 *     NOT TRUE ═══
 * Driven with a player STANDING STILL inside the dead zone, it backed from
 * (32,1) to (32,4) and went on shooting for 4.7 a turn. `kite` retreats before
 * it holds, and it only holds once it has nowhere left to go — so the dead zone
 * on its own buys nothing.
 *
 * WHAT IS TRUE IS PURSUIT, and the difference is the whole fight. Measured over
 * forty turns from nine tiles, alone with it, on a real floor:
 *
 *     standing still   198 damage, six turns spent stunned, still at 9 tiles
 *     walking at it     22 damage, one turn stunned, ends adjacent
 *
 * A factor of nine. It cannot outrun a player and it cannot fight at contact,
 * so the answer is to close and keep closing — and the punishment for treating
 * it as a ranged trade is severe enough to teach that in one attempt.
 *
 * MEASURED ON A REAL FLOOR: the room generates 34x30 with the door at (2,15)
 * and the Watcher at (32,1). The shortest path between them is 30 steps, of
 * which 12 fall inside its reach and all 12 have line of sight. At 5.95 damage
 * a player turn plus a lost turn every third, the crossing costs roughly 107
 * damage to whoever it has picked. That is a hard approach, not a wall.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NUMBERS, AND WHICH OF THEM ARE PORTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ PORTED, from `crystal.lua:28-48` — the same base INDEX_CAIRN cites ═══
 *
 *     stats = { str=1, dex=5, mag=20, con=1 },
 *     global_speed_base = 0.7,
 *     combat_def = 1,
 *     never_move = 1,       <- NOT ported; see the fight, and INDEX_CAIRN's note
 *     ai_state = { talent_in=1 },   <- halved; see `talentIn`
 *
 * ═══ OURS, AND SAID SO PLAINLY ═══
 * `max_life`. Upstream cannot supply it: EVERY crystal in that file inherits
 * `resolvers.rngavg(12,34)` = 23 and the variants differ only by `level_range`,
 * because ToME scales a monster by the level it spawns at and this engine does
 * not. A verbatim port would be a 23 hit point boss.
 *
 * So it is derived from what the party can actually do, and the arithmetic is
 * here to be argued with. Measured `combatDamage`: Watchman 12.4, Inspector
 * 11.5, Alchemist 9.7 — about 33 a round for a party of three before gear or
 * talents. `INDEX_HUSK_ELITE` is 95, which is roughly three rounds. A boss
 * should be the longest fight in the game without being a slog, so: eight
 * rounds of standing damage, 8/3 x 95 = 253, taken as **250**.
 *
 * ═══ AND IT IS NOT A SOLO FIGHT, WHICH IS DELIBERATE AND IS DISCLOSED ═══
 * At about 11 a round a lone player needs roughly twenty-three rounds, under
 * artillery, being stunned. That is not winnable and is not meant to be. It
 * sits in the Redaction, behind a level-5 rumour and a ninety-nine tile walk,
 * and `partyHint` publishes "bring a party" on the world map from the grade —
 * so the game says so out loud before anybody walks in. This is a co-op game
 * whose whole premise is three to six friends in a voice channel, and the one
 * fight that requires them is a feature, not an oversight.
 *
 * No new art: `enemy_index_cairn_s` draws it, and the elite ring draws around
 * it — `canvas.ts` maps every non-Normal rank to `ui_token_ring_elite`, and
 * there is no boss ring in the manifest. That is the same art-family argument
 * the site markers make, and it is stated here rather than left to be noticed.
 */
export const INDEX_WATCHER: MonsterTemplate = Object.freeze({
  /**
   * AN ANSWER TO BEING CORNERED, WHICH THIS TEMPLATE ALREADY ADMITTED IT LACKED.
   *
   * The fight description below reads off kite three branches and ends the
   * third with the creature holding rather than firing: cornered, it does
   * NOTHING AT ALL. That was written as a description and it is really the
   * exploit — the counter to the encounter was to walk it into a wall.
   *
   * Clear the Altar is legal only while a hostile is within two tiles, which is
   * strictly inside its own minRange of 3, so it can never be spent at the
   * band the creature wants to hold.
   */
  talents: ['talent:clear_the_altar'],
  // Grows into what it already leads with. See `autoStats`.
  autoStats: ['cun', 'dex'],
  id: 'index_watcher',
  displayName: 'The Watcher',
  description:
    'The altar, still being added to. Every citation ever filed against this country is in it, ' +
    'and it has had a long time to read them.',
  sprite: 'enemy_index_cairn_s',
  rank: ActorRank.Boss,

  // OURS — see the derivation above. Upstream's crystals are all 23.
  maxHp: 220,
  hpRegen: 0,

  // crystal.lua:36 `global_speed_base = 0.7`, VERBATIM, and the same value
  // INDEX_CAIRN carries. It acts slowly; it simply does not need to move.
  globalSpeed: 0.7,
  speedFactor: 1,

  profile: AiProfile.RangedKiter,
  /**
   * IT SEES THE WHOLE ROOM. `roomFor` builds the candidate floor around the
   * door and this creature is placed at the far end of it, so an aggro range
   * shorter than the room would mean a boss that ignores you until you are
   * halfway across — which reads as the server not having noticed.
   */
  aggroRange: 14,
  // FURTHER THAN ANYTHING ELSE IN THE GAME. INDEX_INQUISITOR's 7 was the
  // longest and it MOVES; this does not, so the reach is the whole of its
  // threat and the room is sized to make crossing it a decision.
  preferredRange: 9,
  minRange: 3,
  attackRange: 11,
  huntsIsolated: false,
  shoulderAfter: 0,

  projSpeed: 2,
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * 2, AND UPSTREAM'S 1 WOULD HAVE SHIPPED A SOFT-LOCK.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `crystal.lua:30` declares `talent_in = 1` and the first version of this
   * creature ported it verbatim. Then the approach was measured and the port
   * turned out to be unplayable for a reason that has nothing to do with
   * upstream: THIS ENGINE'S ORB HAS NO TO-HIT ROLL. `scheduler.ts:1709` and the
   * note on `damageMin` both say it — *"counterplay against a travelling shot is
   * 100% POSITIONAL"* — so every shot lands, and a stun on every shot means a
   * player who is stunned cannot move out of the way of the next one. Permanent
   * lock from eleven tiles, with no roll anywhere to save them.
   *
   * ToME's crystal can afford `talent_in = 1` because its bolt can miss and
   * because being stunned there is a save, not a certainty. Neither is true
   * here, so the cadence carries the whole cost of the deviation and it is
   * stated rather than quietly halved.
   *
   * At `globalSpeed` 0.7 over a cadence of 2 it fires about once every three
   * player turns. See the fight arithmetic in the header.
   */
  talentIn: 2,
  damageMin: 14,
  damageMax: 20,

  drops: { chance: 100, pick: idsOfTier('rare') },

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE FIRST THING IN THIS GAME THAT STUNS A PLAYER.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Measured before it was written: `EffectId.Stunned` is applied by exactly
   * one call site in the whole codebase — `talents/lockdown.ts`, the Watchman's
   * own. Two of eight monsters carry any `onHit`. So the effect is proven
   * machinery that has only ever pointed one way, and turning it around is new
   * content that needs no new system.
   *
   * ONE TURN, AND THE FIRST DRAFT SAID TWO. The wraith's `Slowed` runs three
   * and merely taxes movement; a stun takes the turn away entirely. With no
   * to-hit roll on the orb (see `talentIn`), a stun longer than the gap between
   * shots is not a hard fight, it is a player who never acts again — so the
   * duration has to stay strictly under the cadence, and one is what fits.
   *
   * `ORB_APPLY_POWER` is shared with the wraith deliberately: this is the same
   * kind of application, not a second set of rules.
   */
  onHit: { effectId: EffectId.Stunned, turns: 1, power: ORB_APPLY_POWER },

  combat: {
    // crystal.lua:35, VERBATIM — the cairn's own line. Everything it has is in
    // the shot, and there is nothing at all behind it if you arrive.
    stats: { str: 1, dex: 5, mag: 20, con: 1 },
    // crystal.lua:38 `combat_def = 1`; no `combat_armor` upstream, so 0 here.
    // TWO HUNDRED AND FIFTY HIT POINTS AND NO ARMOUR: every hit the party lands
    // counts in full, so the fight is long because it is BIG, never because it
    // is absorbing. A boss that ate chip damage would be the glut again.
    mods: { armour: 0, def: 1 },
    weapon: {
      dam: resolveLevelup(resolveMBonus(30, 10)),
      atk: 8,
      apr: 6,
      damMod: { mag: 0.8 },
    },
    profile: {
      resists: {
        [DamageType.Darkness]: 50,
      },
    },
    range: 11,
    minRange: 3,
  },
});

export const MONSTER_TEMPLATES: readonly MonsterTemplate[] = Object.freeze([
  INDEX_HUSK,
  INDEX_WRAITH,
  INDEX_HUSK_ELITE,
  INDEX_EIDOLON,
  INDEX_CAIRN,
  INDEX_GLUT,
  INDEX_INSPECTOR,
  INDEX_INQUISITOR,
  INDEX_WATCHER,
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A BODY AT A LEVEL. Upstream authors the shape; the level does the rest.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `level` DEFAULTS TO 1, so every existing caller — and every fixture — keeps
 * the exact body it had before this existed. A level-1 monster is its authored
 * template unchanged, to the number.
 *
 * Upstream reaches the same place by a longer road: a zone picks a base level,
 * `actor_adjust_level` nudges it, and `forceLevelup` then runs `Actor:levelup()`
 * once per level, accumulating hit points and stats as it goes. We compute the
 * accumulation directly, because our version has no random element to preserve
 * order for — `spreadStatPoints` is deterministic and the life curve has no
 * dice in it for a fixed rating.
 */
export function monsterInit(template: MonsterTemplate, at: TileXY, level: number = 1): MonsterInit {
  const rank = RANK_VALUE[template.rank];
  const grown = Math.max(1, Math.floor(level));
  /**
   * THE BASE PLUS EVERY LEVEL SINCE. Floored once at the end, never per level:
   * upstream carries `max_life` as a float and rounding each step would drift by
   * up to half a point a level — about twenty-five hit points across a career,
   * all of it invisible.
   */
  /**
   * THE STATS IT GREW INTO, AND THEY ARE RESOLVED FIRST. A template with no
   * `autoStats` keeps the sheet it was authored with, which is what makes this
   * safe to land before every template has been given a list.
   *
   * ═══ THIS USED TO COME AFTER `maxHp`, AND THE ORDER WAS THE BUG ═══
   * A pool sized before the stats exist cannot include them. See below.
   */
  const combat =
    template.autoStats === undefined || template.autoStats.length === 0
      ? template.combat
      : {
          ...template.combat,
          stats: spreadStatPoints(
            template.combat.stats ?? {},
            template.autoStats,
            statPointsGainedTo(grown, rank),
          ),
        };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BASE, EVERY LEVEL SINCE, AND THE CONSTITUTION IT GREW INTO.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Floored once at the end, never per level: upstream carries `max_life` as a
   * float and rounding each step would drift by up to half a point a level —
   * about twenty-five hit points across a career, all of it invisible.
   *
   * ═══ THE CONSTITUTION TERM WAS MISSING, AND PLAYERS HAD IT ═══
   * `engine/pools.ts#maxLifeOf` pays a player four hit points per point of
   * Constitution over their class's own. This function paid a monster nothing,
   * while `spreadStatPoints` handed three of the authored templates
   * (`autoStats: ['con', 'str']` and `['str', 'con']`) a growing pile of it. A
   * level-20 creature built around toughness was therefore no tougher for it.
   *
   * UPSTREAM PAYS BOTH, through one function. `Actor:levelup` adds the life
   * rating (Actor.lua:3818-3822) and THEN calls `Autolevel:autoLevel`
   * (:3835-3837), whose schemes call `learnStats` -> `incIncStat` ->
   * `onStatChange` -> `max_life = max_life + 4 * v`. There is no player branch
   * anywhere in that path; a monster gains life from Constitution for exactly
   * the reason a player does.
   *
   * ═══ WHICH CREATURES GAIN IT IS AN AUTHORING DECISION, NOT THIS FUNCTION'S ═══
   * Upstream's `warrior` scheme is `{STR, STR, DEX}` and grants no Constitution
   * at all, so an ant gets none of this — the schemes differ per creature
   * (autolevel_schemes.lua:25-39) and `autoStats` is our equivalent of that
   * choice. This line pays for whatever a template asked for; a creature that
   * should not grow tough should not list `con`.
   *
   * OVER THE AUTHORED SHEET, exactly as the player's is over the class's. A
   * template's `maxHp` is its hit points AT the Constitution it was written
   * with, so paying for the whole stat would hand every creature in the game a
   * free pile of life on the day this landed.
   */
  const authoredCon = template.combat.stats?.con ?? STAT_BASE;
  const grownCon = combat.stats?.con ?? authoredCon;
  const maxHp = Math.max(
    1,
    Math.floor(
      template.maxHp +
        lifeGainedTo(template.lifeRating ?? 10, grown, rank) +
        (grownCon - authoredCon) * LIFE_PER_CON,
    ),
  );
  // WHAT IT KNOWS, CARRIED ONTO THE BODY. Copied rather than aliased: the
  // template is frozen and shared by every creature built from it, so a body
  // that ever learned something would teach the whole species.
  const talents = template.talents === undefined ? undefined : [...template.talents];

  return {
    name: template.displayName,
    sprite: template.sprite,
    // ABSENT RATHER THAN EMPTY for a creature that knows nothing, so a template
    // authored before this field produces the byte-identical body it always did.
    ...(talents === undefined ? {} : { talents }),
    x: at.x,
    y: at.y,
    rank: template.rank,
    profile: template.profile,
    maxHp,
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
    onHit: template.onHit,
    combat,
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
