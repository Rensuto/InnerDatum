// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/npcs/ant.lua:24-43 (BASE_NPC_ANT)
//                                                              :53-60 (giant brown ant)
//             t-engine4 game/modules/tome/data/general/npcs/losgoroth.lua:22-57 (BASE_NPC_LOSGOROTH)
//                                                                        :59-70 (losgoroth)
//             t-engine4 game/modules/tome/data/general/npcs/ghoul.lua:49-116 (the ghoul ladder)
//             t-engine4 game/modules/tome/data/talents/misc/npcs.lua:723-747 (T_VOID_BLAST)
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
 * THE SIX DELIBERATE DEVIATIONS, ALL OF THEM LIVE FIELDS
 * ───────────────────────────────────────────────────────────────────────────
 * Numbered here so a reader can find all six in one place and so nobody has to
 * grep for the word "invented" to know what is ours. THIS LIST USED TO SAY
 * THREE, and the missing three were documented only at their own site — which is
 * a trap for the next re-base pass, because a reader who trusts a short list
 * takes upstream's numbers for everything it does not name and quietly restores
 * an aggro of 10 and a reach of 10 on the creature this work item exists to calm
 * down. Every field below deviates from a real upstream number:
 *
 *   1. EVERY `maxHp` IS HELD at 25 / 22 / 60 rather than ported. See the note on
 *      each template. In one sentence: the damage sheet is not wired to the
 *      scheduler yet, so porting the losgoroth's `rngavg(40,60)` = 50 onto the
 *      wraith would make it a ten-hit kill for a party that currently kills it
 *      in four — on the creature that was just reported as too strong.
 *   2. THE WRAITH'S `globalSpeed` STAYS 0.84. Upstream's losgoroth has no
 *      `global_speed_base` at all, i.e. 1.0.
 *   3. THE WRAITH'S `minRange` 2 STAYS. ToME has no dead zone whatsoever; its
 *      ranged tactic preset is `escape=3, closein=0` (tome/resolvers.lua:901)
 *      and its bolt talents have `range` but no minimum. Citing upstream for a
 *      dead zone would be a false citation.
 *   4. THE WRAITH'S `aggroRange` IS HELD AT 8. Upstream is losgoroth.lua:34
 *      `infravision = 10`. Full note at the field.
 *   5. THE WRAITH'S `attackRange` IS HELD AT 6. T_VOID_BLAST authors `range = 10`
 *      (misc/npcs.lua:730). Full note at the field — and read it, because the
 *      number is a legality ceiling the AI never reaches.
 *   6. THE WRAITH'S `Darkness: 50` RESIST IS OURS. Upstream's losgoroth.lua:46
 *      is `ARCANE = 100` and carries no darkness row at all; we do not have
 *      Arcane and would not ship a 100 on floor one if we did.
 *
 * A seventh deviation lives one file over and belongs in any reading of this
 * roster: the orb `projSpeed` puts in the air is a `bolt` and T_VOID_BLAST is a
 * `beam` (misc/npcs.lua:734, Target.lua:583-584). Ours stops on the first body
 * in the line; upstream's clips everyone it passes and flies on. It is DEVIATION
 * 1 in the header of src/server/engine/projectile.ts, with the reason.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SHEET IS NOT WIRED TO THE SWING YET, AND THAT MATTERS FOR READING IT
 * ───────────────────────────────────────────────────────────────────────────
 * `monsterInit` below does NOT pass `damageMin`/`damageMax`, so every monster in
 * this roster deals `DEFAULT_MONSTER_DAMAGE_MIN..MAX` = 3-6 through
 * `scheduler.ts#strike`, with no to-hit roll, no armour and no resists. Every
 * `weapon.dam` / `atk` / `apr` ported below is therefore INERT ON THE ATTACKER
 * SIDE today; it is read by `derived.ts` for the inspect card, and by the TARGET
 * side of the pipeline when a player talent hits this creature.
 *
 * That is recorded here rather than buried because it changes how the numbers
 * read: an accuracy of 19 does not mean this creature never misses, it means
 * this creature does not roll to hit at all — and neither does anything else.
 * Moving the scheduler onto `combat.ts#attackTarget` is ONE change, not two (see
 * the wiring note at the foot of engine/combat.ts: the Chebyshev range check and
 * the Euclidean `canAttack` must move together), and it is out of scope here.
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
import { resolveLevelup, resolveMBonus, resolveRngAvg } from './resolvers.ts';
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

  // --- combat ---------------------------------------------------------------
  /** Everything derived.ts, checkhit.ts and damage.ts read. */
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
 * hand-authored version had that backwards. NB neither number is live yet — see
 * the "not wired to the swing" note in the file header.
 */
export const INDEX_HUSK: MonsterTemplate = Object.freeze({
  id: 'index_husk',
  displayName: 'Index Husk',
  description:
    'A half-erased citizen overwritten by Index pages bleeding through the Veil. ' +
    'Slow, hollow, and hungry for contact.',
  sprite: 'enemy_index_husk_s',
  rank: ActorRank.Normal,

  // DEVIATION 1 OF 6 (see the file header). Upstream is
  // ant.lua:59 `max_life = resolvers.rngavg(15,30)`, i.e. a mean of 22.5 — so 25
  // is INSIDE the giant brown ant's own band and needs no defence beyond this
  // citation. It is held rather than ported only because the other two maxHp
  // values are held and a roster that ports one life value and authors two is
  // harder to reason about than one that authors all three.
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
 *
 * ═══ WHAT IT IS AND IS NOT, MEASURED ═══
 * It is a CHIP THREAT that has to be walked at, not a burst threat. Standing
 * still is punished; so is charging straight down the line, because the orb
 * tests its own tile on every act (engine/projectile.ts, DEVIATION 3) and a body
 * that walks onto it eats it. Stepping SIDEWAYS off the frozen line still dodges
 * cleanly, and that is the counterplay working rather than the creature failing.
 *
 * Its damage per player turn is small and the arithmetic is worth writing down
 * so nobody re-derives it from the sheet: 0.84 globalSpeed × 0.5 (`talentIn` 2)
 * × 4.5 avg = 1.89 hp, against the melee husk's 0.9 × 4.5 = 4.05. It is BELOW
 * HALF the basic mob, and the reason is the file header's "not wired to the
 * swing" note — `monsterInit` passes no `damageMin`/`damageMax`, so a landed orb
 * deals `DEFAULT_MONSTER_DAMAGE_MIN..MAX` 3-6 and the ported `weapon.dam` of
 * ~7.4 with `apr` 15 is inert. THE COMPENSATION FOR THREE STACKED NERFS —
 * travel time, the 1-in-2 cadence, and the stand-off moving 6 → 4 — is
 * therefore not in yet, and none of the upstream buffs that would pay for it
 * (max_life 50, global_speed 1.0, range 10) is taken either; all three are in
 * the deviation list above with their own reasons. Wiring the sheet to the swing
 * is the one change that fixes this properly and it is one change, not two.
 * Until then this creature is deliberately under-tuned rather than accidentally
 * so, and that sentence is here so the next person does not "fix" it by
 * un-porting `talent_in`.
 *
 * `minRange 2` is the whole class. A wraith CANNOT shoot something standing on
 * it, so a Watchman who closes the gap turns it off; `ai/npc.ts` retreats rather
 * than firing point-blank and `canAttack` refuses the shot if it ever tried.
 * That is the same lesson the Inspector's `min_range 3` teaches from the
 * player's side (game-design.md § 2: "the single most important number here"),
 * shown from the receiving end on the first floor. It is DEVIATION 3 OF 6: ToME
 * has no dead zone anywhere, so this one is ours and is labelled as ours.
 *
 * DERIVED NUMBERS (pinned in test/server/monsters.test.ts):
 *   accuracy 17 · defence 19 · damage 5.055 → rolls a flat 5 darkness · crit 1%
 *   armour 0 · darkness resist 50% · physical resist −30% (VULNERABLE)
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

  // DEVIATION 1 OF 6 (see the file header), and this is the sharp one.
  // Upstream is losgoroth.lua:63 `max_life = resolvers.rngavg(40,60)` — a mean
  // of 50, against our 22. It is NOT ported, for one measurable reason: a
  // player's live damage is `DEFAULT_PLAYER_DAMAGE_MIN..MAX` = 4-7 through
  // `scheduler.ts#strike` (avg 5.5), NOT the ~10-12 their combat SHEET says,
  // because the sheet is not wired to the swing (see the file header). Fifty
  // life is therefore a ten-hit kill where 22 is a four-hit kill: the same
  // creature would take 2.3x longer to bring down, on the creature the user just
  // reported as killing too fast. ADOPT 50 ON THE DAY the scheduler moves onto
  // `combat.ts#attackTarget`, and not before.
  maxHp: 22,
  hpRegen: 0,

  // DEVIATION 2 OF 6. Upstream's losgoroth authors no `global_speed_base`, so it
  // is 1.0 — the same speed as the party. Ours stays at 0.84 and the reason is
  // structural rather than aesthetic: an equal-speed kiter retreats forever and
  // the fight is a treadmill with no end state. ToME can afford 1.0 because its
  // player has movement talents, teleports and a `movement_speed` stat; ours has
  // none of those yet. This is the number that makes cornering one WORK.
  globalSpeed: 0.84,
  speedFactor: 1,

  // losgoroth.lua:43 `ai = "dumb_talented_simple", ai_state = { ai_move="move_complex" }`
  // plus a granted attack talent — which is exactly "kiter caster". The M3
  // profile is the closest one that exists; the "caster" half is `talentIn`
  // below rather than a talent tree.
  profile: AiProfile.RangedKiter,
  // DEVIATION 4 OF 6. HELD at 8. Upstream is losgoroth.lua:34 `infravision = 10`, the same as the
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
  preferredRange: 4,
  minRange: 2,
  // DEVIATION 5 OF 6. HELD at 6, and it is already a cut: T_VOID_BLAST authors
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
  talentIn: 2,

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
    // losgoroth.lua:30, VERBATIM including the resolver nest:
    //   combat = { dam=resolvers.levelup(resolvers.mbonus(40, 15), 1, 1.2),
    //              atk=15, apr=15, dammod={mag=0.8}, damtype=DamageType.ARCANE }
    // `resolveMBonus(40, 15)` is 15 at level 1 (see content/resolvers.ts for the
    // ~0.4 the port drops and why), which lands within one point of the 14 this
    // field was hand-authored at — a good sign that the old number was a decent
    // guess at a curve somebody else had already tuned.
    weapon: {
      dam: resolveLevelup(resolveMBonus(40, 15)),
      atk: 15,
      apr: 15,
      // `dammod = {mag=0.8}` — the orb is thrown by Magic alone. The old
      // { dex: 0.5, cun: 0.4 } was invented "in the shape of ToME's own ranged
      // dammod"; this IS ToME's own ranged dammod, for this creature.
      damMod: { mag: 0.8 },
    },
    profile: {
      resists: {
        // DEVIATION 6 OF 6 — OURS, KEPT. Upstream's equivalent is losgoroth.lua:46
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
 * We cannot spend the ghoulking's currency yet. `dam`/`atk`/`apr` are inert on
 * the attacker side until the scheduler moves onto `combat.ts#attackTarget` (see
 * the file header), and there is no monster talent system for a cadence to
 * drive. Life and behaviour are the elite's only LIVE levers today, and an elite
 * with neither is a husk. So 60 stays — as DEVIATION 1 OF 6, written down rather
 * than justified by a ratio that does not exist.
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

  // DEVIATION 1 OF 6 — see this template's header. Upstream's ladder holds
  // `max_life = resolvers.rngavg(90,100)` across ALL THREE ghoul tiers
  // (ghoul.lua:54, :71, :92), i.e. the delta is ZERO and a faithful port would
  // put this at 25. Held at 60 because life and behaviour are the only live
  // levers an elite has until the damage sheet is wired, and an elite with
  // neither is indistinguishable from the creature it upgrades.
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
 * NOTE WHAT IS STILL NOT PASSED: `damageMin` and `damageMax`. Every monster in
 * this roster therefore deals `DEFAULT_MONSTER_DAMAGE_MIN..MAX` = 3-6 through
 * `scheduler.ts#strike`, and every `weapon.dam`/`atk`/`apr` above is inert on
 * the attacker side. See the file header; it is deliberate and it is one change
 * away, not two.
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

  // A creature that behaves like an elite must LOOK like one. The ring is the
  // only warning the player gets, and an unringed thing that hunts the isolated
  // detective and walks around a chokepoint is a bug report, not a monster.
  const isElite = template.huntsIsolated || template.shoulderAfter > 0;
  if (isElite && template.rank === ActorRank.Normal) {
    problems.push(`${where} carries elite behaviour but rank is ${template.rank}`);
  }

  return problems;
}
