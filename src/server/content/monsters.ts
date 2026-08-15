// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Stat-block SHAPE ported from t-engine4 game/modules/tome/data/general/npcs/vermin.lua:22-77
//             (`combat = { dam=, atk=, apr= }`, `combat_armor`, `combat_def`, `stats`,
//              `resists`, `global_speed_base`, `rank`, `ai_state = { ai_move = ... }`)
//             t-engine4 game/modules/tome/class/Actor.lua:1198-1204 (boss_rank_circles — the
//             under-token ring keyed off `rank`, which is what ui_token_ring_elite.png is)
//                                       :1701-1751 (the rank ladder: stat, level and life adjust)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license
//
// The identity numbers (max_hp, attack_power, defense, move_speed, ai_profile) come from the
// author's own Outer Index content, which is NOT GPL:
//   outer-index-ren/outer-index-orthographic/outer-index-engine/content/enemies/{index_husk,
//   index_wraith}.json

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
 * WHERE THE NUMBERS COME FROM — THE MAPPING TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Outer Index enemy JSON is already turn-based shaped, and it is the
 * author's own canon, so it supplies IDENTITY. ToME supplies the CURVE. The two
 * meet field by field:
 *
 * | Outer Index            | ToME                    | Where the shape is from        |
 * |------------------------|-------------------------|--------------------------------|
 * | `max_hp`               | `max_life`              | direct                         |
 * | `attack_power`         | `combat.dam` (rating)   | vermin.lua:50 `combat={dam=1,…}`|
 * | `defense`              | `combat_armor`          | vermin.lua:36 — SEE THE NOTE   |
 * | `crit_chance` 0.05     | `combat_physcrit` 5     | Combat.lua:1415-1427, pct points|
 * | `*_resistance_pct`     | `resists`               | vermin.lua:75, pct points      |
 * | `move_speed` (px/s)    | `global_speed_base`     | vermin.lua:36, normalised      |
 * | `melee_range` (px)     | reach in tiles          | ÷ TILE_PX (32)                 |
 * | `ai_profile`           | `AiProfile`             | the strings already match      |
 * | `aggro_radius`         | —                       | AUTHORED HERE: source is all 0 |
 * | —                      | `rank`                  | Actor.lua:1198, the ring       |
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `defense` IS PORTED AS `combat_armor`, AND THAT IS A DELIBERATE DEVIATION
 * ───────────────────────────────────────────────────────────────────────────
 * Structurally, Outer Index's `defense` is a FLAT subtraction applied AFTER the
 * percentage resistance —
 *
 *     # systems/combat/combat_manager.gd:324, :342-344
 *     # Dofus-inspired formula: base * (1 + atk_pct) * (1 - res_pct) - flat_defense
 *     var resisted: float = base_damage * (1.0 - res_pct)
 *     var final_damage: int = maxi(1, int(floor(resisted)) - defense)
 *
 * — which is ToME's `flat_damage_armor` to the letter (damage_types.lua:404-409,
 * step 8 of the pipeline in damage.ts). The obvious port is therefore
 * `profile.flatDamageArmour`, and it is WRONG here, for one reason: that Godot
 * line floors at `maxi(1, …)` and ToME's floors at 0.
 *
 * Run the arithmetic. A default level-1 detective's swing is 4.408 damage
 * (test/server/derived.test.ts). Give the elite the flat 3 its `defense` would
 * imply and the blow lands for 4 − 3 = 1 through a floor ToME does not have, or
 * 0 through the floor it does. Outer Index survives this because its player
 * attack_power is 15-25 and its floor is 1; ToME level-1 numbers are 4-9 and its
 * floor is 0, so the same field deletes the hit.
 *
 * `combat_armor` is the stat ToME actually puts on its own low-level monsters
 * (vermin.lua:36, `combat_armor = 1, combat_def = 1`), and it is gated by
 * hardiness — base 30, so 70% of every blow lands no matter what (Combat.lua:1336
 * and the note in derived.ts). That is precisely the mechanism that lets armour
 * matter without making anything unkillable, which is the property `defense`
 * was carrying in the source engine. So: same intent, different stage, recorded
 * here rather than discovered in playtest.
 *
 * Consequence, stated so nobody "fixes" it: NOTHING in this roster sets
 * `flatDamageArmour`. Step 8 of the pipeline is unexercised by M3 content on
 * purpose. It is a gear stat, and gear is M6.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `defense` IS ALSO NOT `combat_def`
 * ───────────────────────────────────────────────────────────────────────────
 * ToME's `combat_def` is DODGE — it moves the to-hit roll, not the damage. A
 * monster that carried `defense` there would be both hard to hit and, once the
 * party invested in accuracy, no tougher at all. Monster dodge in this port
 * comes from Dexterity alone (Combat.lua:1245, at 0.35/point), which is where
 * ToME puts it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS INVENTED, AND WHY EACH INVENTION EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Outer Index blocks carry no primary stats, no accuracy, and no aggro
 * radius (`aggro_radius` is 0 on every single file — docs/data-schemas.md:213
 * already records that the source value is dead). Those are authored here. The
 * rule they are authored under:
 *
 *   EVERY PRIMARY STAYS AT ToME's BASE 10 (load.lua:182-189) UNLESS THE
 *   CREATURE'S OWN DESCRIPTION DEMANDS OTHERWISE, AND THE DEVIATION IS WRITTEN
 *   DOWN NEXT TO IT.
 *
 * That keeps the sheets readable — a reader can see at a glance that a husk is
 * ±2 from a person in two stats and identical in the rest — and it keeps the
 * derived numbers close to the hand-traceable vectors in test/server/derived.test.ts.
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
 * `MonsterInit` so this module never has to import `world/`.
 */

import { AiProfile } from '../engine/actor.ts';
import { DamageType } from '../engine/damage.ts';
import { ActorRank } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { MonsterInit } from '../engine/actor.ts';
import type { CombatSheet } from '../engine/combat.ts';

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/**
 * One authored creature.
 *
 * A subset of `MonsterDef` in docs/data-schemas.md § 4 — the fields M3 can
 * actually consume. `talentIds`, `lootTable`, `xpReward` and `saves` are all in
 * that schema and none of them have a consumer yet; adding them here would be
 * writing content for a system that does not exist (CLAUDE.md, "things that look
 * helpful and are not").
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
  /** Energy GAIN multiplier — `global_speed_base` (vermin.lua:36). */
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

  // --- combat ---------------------------------------------------------------
  /** Everything derived.ts, checkhit.ts and damage.ts read. */
  readonly combat: CombatSheet;
};

// ---------------------------------------------------------------------------
// index_husk — THE MELEE CHASER
// ---------------------------------------------------------------------------

/**
 * "A half-erased citizen overwritten by Index pages bleeding through the Veil.
 * Slow, hollow, and hungry for contact."
 *
 * The baseline. Every other number in this file is legible only as a comparison
 * against this one, so it is the one that must be plain.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 2 · defence 0 · damage 6.3637 → rolls 6-7 · crit 0.4% · armour 1
 *   vs a default detective it hits 55% of the time and is hit 60% of the time.
 *
 * Twenty-five life against a ~3-per-swing baseline detective is eight or nine
 * connected blows — a husk is a two-player problem or a four-turn one, which is
 * the right size for the thing you meet first.
 */
export const INDEX_HUSK: MonsterTemplate = Object.freeze({
  id: 'index_husk',
  displayName: 'Index Husk',
  description:
    'A half-erased citizen overwritten by Index pages bleeding through the Veil. ' +
    'Slow, hollow, and hungry for contact.',
  sprite: 'enemy_index_husk_s',
  rank: ActorRank.Normal,

  // index_husk.json `max_hp: 25`.
  maxHp: 25,
  hpRegen: 0,

  // index_husk.json `move_speed: 76` is the roster's reference walker, so it is
  // the 1.0 every other creature's speed is quoted against.
  globalSpeed: 1,
  speedFactor: 1,

  // index_husk.json `ai_profile: "melee_chaser"` — the string already matches.
  profile: AiProfile.MeleeChaser,
  // INVENTED. `aggro_radius` is 0 on every Outer Index enemy (dead value —
  // docs/data-schemas.md:213). Eight tiles is a quarter of the 30x30 test map:
  // far enough that walking into a room wakes what is in it, near enough that
  // the far corner is still yours to approach on your own terms.
  aggroRange: 8,
  preferredRange: 1,
  minRange: 0,
  // index_husk.json `melee_range: 28` px ÷ TILE_PX 32 → one tile.
  attackRange: 1,
  huntsIsolated: false,
  shoulderAfter: 0,

  combat: {
    // INVENTED, from the description. "Hungry for contact" buys +2 Strength;
    // "slow, hollow" costs 2 Dexterity, which is the one stat that pays twice —
    // accuracy at 1.0/point (Combat.lua:1343) and dodge at 0.35 (Combat.lua:1245).
    // A husk is therefore easy to hit AND bad at hitting, which is what makes it
    // the creature you are allowed to fight in the open.
    stats: { str: 12, dex: 8, con: 12, cun: 8 },
    // index_husk.json `defense: 1` — see the header for why this is `armour`.
    mods: { armour: 1 },
    // index_husk.json `attack_power: 8` as the weapon's damage RATING, exactly
    // the shape of vermin.lua:50 `combat = { dam=1, atk=0, apr=100 }`. The
    // rating goes through a square root (Combat.lua:1682-1687), so it moves the
    // result far less than Strength does — which is upstream's design, not a
    // dilution of the authored number.
    weapon: { dam: 8 },
    profile: {
      // INVENTED. Nothing in the source roster resists anything our six damage
      // types cover (the authored resists are `earth`/`air`/`corruption`/`water`,
      // which do not exist here). A husk is already half-erased, so a mind
      // attack finds less to grip: 25%. It costs the Alchemist nothing and it
      // gives the first creature in the game one fact worth learning.
      resists: { [DamageType.Mind]: 25 },
      // resistsCap deliberately absent — the ENGINE default is { all = 100 }
      // (Actor.lua:211). The familiar 70 is a PLAYER birth descriptor
      // (descriptors.lua:63) and monsters do not get it.
    },
    range: 1.5,
    minRange: 0,
    damageType: DamageType.Physical,
  },
});

// ---------------------------------------------------------------------------
// index_wraith — THE RANGED KITER
// ---------------------------------------------------------------------------

/**
 * "A cited absence given shape: pages, ink, and a detached watching glyph
 * drifting where a body should be. Hangs at the outer ring and lobs dark orbs."
 *
 * ═══ WHY THE WRAITH AND NOT THE CAIRN ═══
 * PLAN.md's M3 line offers `index_cairn` or `index_wraith` for the ranged slot.
 * The source settles it: `index_cairn.json` is authored
 * `"ai_profile": "melee_chaser"` — it is the slow grinder that shoulders into
 * melee — while `index_wraith.json` is `"ai_profile": "kiter_caster"` and its
 * description says it "hangs at the outer ring". Taking the cairn would mean
 * overriding the author's own AI field to fill a slot the author already filled.
 *
 * ═══ THE NUMBERS THAT MAKE IT A DIFFERENT PROBLEM ═══
 *   reach 6 · dead zone 2 · aggro 8 · globalSpeed 0.84
 *
 * `minRange 2` is the whole class. A wraith CANNOT shoot something standing on
 * it, so a Watchman who closes the gap turns it off; `ai/npc.ts` retreats rather
 * than firing point-blank and `canAttack` refuses the shot if it ever tried.
 * That is the same lesson the Inspector's `min_range 3` teaches from the
 * player's side (game-design.md § 2: "the single most important number here"),
 * shown from the receiving end on the first floor.
 *
 * The dead zone is 2 and not 3 ON PURPOSE. The Inspector's is 3 and the ranged
 * class must be the range specialist: a monster with the player's own dead zone
 * and a shorter one is a better Inspector than the Inspector. Six reach against
 * the Inspector's seven says the same thing.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 7 · defence 1 · damage 7.3832 → rolls 7-8 darkness · crit 1.6%
 *   armour 1 · darkness resist 50% · physical resist -20% (VULNERABLE)
 */
export const INDEX_WRAITH: MonsterTemplate = Object.freeze({
  id: 'index_wraith',
  displayName: 'Index Wraith',
  description:
    'A cited absence given shape: pages, ink, and a detached watching glyph drifting where a ' +
    'body should be. Hangs at the outer ring and lobs dark orbs at the player.',
  sprite: 'enemy_index_wraith_s',
  rank: ActorRank.Normal,

  // index_wraith.json `max_hp: 22`. The most fragile thing in the roster, which
  // is the reward for reaching it.
  maxHp: 22,
  hpRegen: 0,

  // index_wraith.json `move_speed: 64` ÷ the husk's 76 = 0.842, to 2dp.
  // A kiter SLOWER than the party is not a mistake: it is the reason cornering
  // one works at all. An equal-speed kiter retreats forever and the fight is a
  // treadmill with no end state.
  globalSpeed: 0.84,
  speedFactor: 1,

  // index_wraith.json `ai_profile: "kiter_caster"` → the closest MVP profile.
  // The "caster" half is a talent, and M3 has twelve talents, none of them a
  // monster's (PLAN.md).
  profile: AiProfile.RangedKiter,
  // INVENTED: two tiles past its own reach, so it notices you before you are in
  // its band and has a turn to set up rather than being surprised at point six.
  aggroRange: 8,
  // Equal to `attackRange` on purpose — see `validateTemplate`. The wraith wants
  // to stand at the edge of its reach; anything less would be walking toward the
  // party for no reason.
  preferredRange: 6,
  minRange: 2,
  // INVENTED, and capped deliberately. `cast_ability_range_px: 280` ÷ 32 is 8.75
  // tiles, which out-ranges the Inspector's authored 7 (test/server/combat.test.ts)
  // — a monster that outshoots the ranged class deletes that class's identity.
  // Six.
  attackRange: 6,
  huntsIsolated: false,
  shoulderAfter: 0,

  combat: {
    // INVENTED, from the description. It snipes, so Dexterity leads (+3, worth
    // +3 accuracy and +1.05 dodge); it is "a cited absence", so Strength and
    // Constitution give way (-2 each). Cunning +2 buys it the only meaningful
    // crit chance in the normal roster.
    stats: { str: 8, dex: 13, con: 8, cun: 12 },
    // index_wraith.json `defense: 1`.
    mods: { armour: 1 },
    weapon: {
      // index_wraith.json `cast_ability_damage: 14`, not `attack_power: 8`. The
      // wraith has both authored; the orb IS the creature ("lobs dark orbs"),
      // and an MVP monster has exactly one attack.
      dam: 14,
      // INVENTED, in the shape of ToME's own ranged `dammod` (a bow is
      // `{ dex = 0.7, str = 0.5 }`; the default is `{ str = 0.6 }` at
      // Combat.lua:1625). The orb should be thrown by the stats that define the
      // wraith, not by a Strength it does not have.
      damMod: { dex: 0.5, cun: 0.4 },
    },
    profile: {
      resists: {
        // INVENTED. It is made of the stuff, so half of it slides off.
        [DamageType.Darkness]: 50,
        // INVENTED, and the interesting one: a NEGATIVE resist is a
        // vulnerability, and it is idiomatic upstream (vermin.lua:75 ships
        // `[DamageType.FIRE] = -50` on the carrion worm mass). A solid hit lands
        // for 20% more on something that is barely there — so the answer to a
        // wraith is to reach it, which is the same sentence as its `minRange`.
        [DamageType.Physical]: -20,
      },
    },
    // EUCLIDEAN, and equal to `attackRange` because the AI's band arithmetic is
    // Euclidean too (ai/npc.ts `kite`). Equality means every shot the AI wants
    // is a shot `canAttack` allows.
    range: 6,
    // THE SAME NUMBER AS `minRange` ABOVE, and `validateTemplate` proves it. Two
    // dead zones that disagree is a monster that walks to a tile it then refuses
    // to shoot from, every turn, forever.
    minRange: 2,
    // damage_types.lua:856-875. `dark_orb`.
    damageType: DamageType.Darkness,
  },
});

// ---------------------------------------------------------------------------
// index_husk_elite — THE ELITE
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING IS A WARNING ABOUT THE BEHAVIOUR, NOT ABOUT THE NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both source games say the same thing independently, and it is the thing that
 * decides what an elite is here:
 *
 *   - ToME. `getRankLifeAdjust` (Actor.lua:1740-1751) gives rank 2 (normal)
 *     ×(1 + lvl/40 − 0.1) and rank 3 (elite) ×(1 + lvl/40 + 0.1). At level 1
 *     that is ×0.925 against ×1.125 — an elite has **1.22× a normal's life**.
 *     `getRankLevelAdjust` adds one level. That is the entire numeric gap.
 *   - Outer Index. `NEXUS/knowledge/lessons.md:164-170`: "`is_elite` scales
 *     **visuals only** … it does **not** scale HP."
 *
 * So an elite that is only a bigger number is not an elite in either lineage;
 * it is a husk with a bigger number. What earns `ui_token_ring_elite.png` is in
 * `ai/npc.ts`, and this template turns exactly two behaviours on:
 *
 *   `huntsIsolated`  it goes for whoever is standing ALONE, not whoever is
 *                    nearest. The ring means "close ranks".
 *   `shoulderAfter`  after five turns of being unable to advance it re-routes
 *                    AROUND its own swarm (simple.lua:199-247). The ring means
 *                    "you cannot plug the door on this one".
 *
 * ═══ WHERE 60 LIFE COMES FROM ═══
 * Neither source ladder transfers. ToME's ×1.22 is sized for one player meeting
 * an elite every few floors; Outer Index's "tanky elite ~110" against "basic
 * 22-25" (lessons.md:170) is ×4.4 and sized for a real-time swarm where you kill
 * two hundred things a run. INVENTED by interpolating between them against the
 * fight this game actually runs: three to six detectives, one 30x30 room, and an
 * elite worth about five rounds of the party's whole attention. Four M3-shaped
 * detectives put roughly 13 damage a round through armour 3 / hardiness 35, so
 * 60. (It lands on `DEFAULT_PLAYER_MAX_HP` by coincidence, but it is a good
 * coincidence: the elite has exactly one detective's worth of life.)
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 6 · defence 0 · damage 8.15 → rolls a flat 8 · crit 6%
 *   armour 3 · hardiness 35 · physical resist 10% · mind resist 32.5%
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

  // INVENTED — see the header for the interpolation and the arithmetic.
  maxHp: 60,
  hpRegen: 0,

  // Deliberately NOT faster than its base creature. Speed is a number, and the
  // point of this template is that the upgrade is not a number. An elite you can
  // outrun but cannot shake is a better fight than one that simply arrives sooner.
  globalSpeed: 1,
  speedFactor: 1,

  profile: AiProfile.MeleeChaser,
  // INVENTED: +1 over the husk. It notices the room a tile earlier, which is
  // what "reads the room before it moves" has to mean mechanically.
  aggroRange: 9,
  preferredRange: 1,
  minRange: 0,
  attackRange: 1,
  // ═══ THE TWO BEHAVIOURS THAT ARE THE ELITE ═══ (ai/npc.ts owns both)
  huntsIsolated: true,
  // simple.lua:225 — "Wait at least 5 turns of not moving before switching to
  // blocked_astar". Upstream's own number, upstream's own reason.
  shoulderAfter: 5,

  combat: {
    // INVENTED: the husk's 12/8/12/8 with the ToME rank ladder's shape applied —
    // `getRankStatAdjust` (Actor.lua:1701-1712) moves rank 2 → rank 3 by +0.5
    // and `getRankLevelAdjust` (:1714-1725) by +1 level. Here that is +4 Str /
    // +4 Con (it is the thing that has been overwritten most) and +2 Dex / +2 Cun
    // (it has stopped being clumsy), leaving Dex and Cun exactly at a person's 10.
    stats: { str: 16, dex: 10, con: 16, cun: 10 },
    mods: {
      // INVENTED: the husk's 1 → 3, and it is the roster's armour teacher. At
      // hardiness 35 a 4-damage swing loses 1.4 to armour and the other 2.6
      // lands untouched (Combat.lua:541) — heavy armour flattening chip damage
      // without ever making the thing immune, which is the whole reason the base
      // hardiness is 30 and not 100.
      armour: 3,
      armourHardiness: 5,
      // Anchored, not invented from nothing: `city_watchman.json` authors
      // `crit_chance: 0.05` for "an enemy that is meaningfully better than
      // trash", and Combat.lua:1415-1427 takes that in percentage POINTS.
      physCrit: 5,
    },
    // INVENTED: the husk's `attack_power: 8` × 1.5. The square root at
    // Combat.lua:1682-1687 means +50% of rating is only +8% of damage — the
    // elite hits for 8 where a husk hits for 6-7, and that gap is supposed to be
    // small. `atk: 2` is invented too: without it the elite would connect no more
    // often than the clumsy thing it upgrades.
    weapon: { dam: 12, atk: 2 },
    profile: {
      resists: {
        // INVENTED, and it is here to make the roster exercise the one resist
        // rule that is easy to get wrong: `all` composes MULTIPLICATIVELY with
        // the typed row (Combat.lua:2227-2228). 10 and 25 give 32.5%, NOT 35%.
        // A test pins that exact number.
        all: 10,
        [DamageType.Mind]: 25,
      },
    },
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

  // A creature that behaves like an elite must LOOK like one. The ring is the
  // only warning the player gets, and an unringed thing that hunts the isolated
  // detective and walks around a chokepoint is a bug report, not a monster.
  const isElite = template.huntsIsolated || template.shoulderAfter > 0;
  if (isElite && template.rank === ActorRank.Normal) {
    problems.push(`${where} carries elite behaviour but rank is ${template.rank}`);
  }

  return problems;
}
