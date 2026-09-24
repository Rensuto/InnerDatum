// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/cursed/shadows.lua:335-463
//   (Call Shadows: `mode = "sustained"`, `no_energy = true`, `getMaxShadows`
//    :347-349, `getAvoidMasterDamage` :350-352, `deactivate` :370-379,
//    `summonShadow` :388-437, `callbackOnActBase` :438-453)
//   shadows.lua:179-333 (`createShadow`) — the body, ported as
//   `BOUND_SHADOW` in content/monsters.ts.
//   shadows.lua:465-520 (Shadow Warriors) — `talents/shadow_warriors.ts`.
//   t-engine4 game/modules/tome/class/Actor.lua:1664-1667 (`reactionToward`:
//   a summon answers as its summoner) — `Faction.Bound`, engine/actor.ts.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   CALL SHADOWS — the first thing in this game that puts a BODY on the map.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "You are not alone in the dark. You never were. The difference is that now
 *  it is standing where you asked it to."
 *
 * ═══ WHY THE REDACTOR HAD TO HAVE THIS AND WHY A BUFF WOULD NOT DO ═══
 * The Doomed is born with five talents (afflicted.lua:143-147) and this is one
 * of them. `content/classes.ts` has said so in writing since the class landed:
 * *"the Doomed is born with T_UNNATURAL_BODY, T_CALL_SHADOWS (a body between
 * you and them) and T_FEED. We copied the armour column and none of the rest."*
 *
 * The frailest class in the game answers contact by having something ELSE in
 * contact. That is a fact about TILES — who is adjacent to whom, which body the
 * husk's pathfinder walks at, which square the corridor is blocked at — and
 * there is no defensive number that expresses it. A flat mitigation buff would
 * leave her exactly where she was: the only thing standing in the doorway.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT THIS RUN BUILT, BECAUSE THERE WAS NO SUMMON SYSTEM AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/actor.ts#isHostile` carried a note headed FACTION SEAM: *"ToME
 * resolves this through `reactionToward` over faction tables, which is what
 * charm, summons and monster-on-monster chains all need. Until one of those
 * exists, a faction table would be a lookup with one row."* This is that day.
 * Four pieces, and only the first is an engine change:
 *
 *   `Faction.Bound` + `reactsAs`   engine/actor.ts. Four lines, and they are
 *     upstream's four: `while rsrc.summoner do rsrc = rsrc.summoner end`. One
 *     predicate already answered hostility for the whole codebase, so a shadow
 *     is an ally to players, an ally to other shadows and an enemy of
 *     everything Redacted — and monster-on-monster hostility, which this engine
 *     has never had, came out of the same two lines.
 *   `MonsterActor.summonerId`      the leash, walked with a world in hand.
 *   `BOUND_SHADOW`                 content/monsters.ts, `createShadow`'s table.
 *   `shadowsBasePass` below        `callbackOnActBase` and the leash.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT COULD NOT CROSS, AND WHY — STATED, NOT SUBSTITUTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE SHADOW'S OWN THREE TALENTS (:219-228). `resolvers.talents` gives every
 *   shadow `T_SHADOW_PHASE_DOOR`, `T_SHADOW_BLINDSIDE` and `T_HEAL` at this
 *   talent's raw rank — so even a rank-1 shadow blinks, charges and heals
 *   itself upstream. None of the three crossed:
 *     `SHADOW_PHASE_DOOR` (:37-63) teleports toward `ai_state.shadow_wall_target`
 *       or the summoner. `teleportRandom` is ported now (Phase Door,
 *       engine/talents.ts), but the AI state it aims at belongs to the
 *       `"shadow"` AI, which is the next item.
 *     `SHADOW_BLINDSIDE` (:65-102) is `talents/rush.ts`'s shape — appear beside
 *       a target up to 10 tiles away and hit for `combatTalentWeaponDamage(t,
 *       0.9, 1.9)`. It is portable and it is not ported, because a MONSTER
 *       choosing it needs `ai_state.blindside_chance`, which is again the
 *       `"shadow"` AI.
 *     `T_HEAL` is Arcane Reconstruction, a spell tree this game does not have.
 *   The measured consequence: ours is a shadow that WALKS to the fight instead
 *   of appearing in it, and does not heal. It still blocks a corridor, still
 *   takes the swing, and still dies where it stood.
 *
 * THE `"shadow"` AI (:246-266). `summoner_range` 10, `actor_range` 8,
 *   `location_range` 4, `target_timeout` 10, `blindside_chance` 15,
 *   `phasedoor_chance` 5. With neither talent ported there is nothing for that
 *   machine to choose between, so `BOUND_SHADOW` takes `MeleeChaser` and
 *   `actor_range` alone (see its note). `summoner_range` is enforced by
 *   `shadowPass` below instead of by the AI, because the summoner is
 *   resolvable there and not in `ai/npc.ts`.
 *
 * `avoid_master_damage` (:244, :350-352, :313-316) IS STRUCTURALLY UNREACHABLE
 *   HERE, which is a stronger statement than "not ported". Upstream's shadows
 *   take `(100 - X)%` of damage dealt to them BY THEIR OWN SUMMONER, because a
 *   ToME `project` lands on everything in its radius whatever its faction. Ours
 *   cannot: every area talent selects with `actorsInShape(..., Affinity.Hostile)`
 *   and `isEnemy` now answers false between a Redactor and her shadow, so there
 *   is no such blow to reduce. The scaling is `combatTalentScale(t, 5, 85)` and
 *   this comment is where it goes the day friendly fire exists.
 *
 * `game.party:addMember(shadow, …)` (:431-434) DID NOT CROSS, AND IT IS THE ONE
 *   WITH A VISIBLE CONSEQUENCE. Upstream puts the shadow in the party, so it is
 *   drawn on the party frame and is never fogged. Ours is a `Monster` on the
 *   wire, so `visibleActorIds`' teammate exemption does not cover it and the
 *   BOARD fogs a shadow you cannot see — exactly like any other body.
 *
 *   THE MINIMAP DOES NOT, AND THAT IS DELIBERATE RATHER THAN A SECOND ANSWER.
 *   `gateway.ts`'s friendly-beacon pass filters on
 *   `isMonster(a) && a.alive && !isHostile(a, body)` inside
 *   `MINIMAP_REVEAL_RADIUS` (20), and its own comment pre-registered this case
 *   in as many words — *"an escort or a summoned ally given a third faction
 *   tomorrow would silently stop being marked"*. The leash is 10, so a shadow
 *   is always inside that radius: measured, it is in its summoner's seen set
 *   on 87.3% of its turns, and on the other 12.7% it is fogged on the board
 *   and marked friendly on the map. A body you cannot see but can still find
 *   is the right answer for a thing you put there on purpose.
 *
 * `exp_worth = 0` (:195) NEEDED NO PORT and `summoner_gain_exp` (:188) and
 *   `summoner_hate_per_kill = self.hate_per_kill` (:218) did not cross:
 *   `BOUND_SHADOW` has no `drops`, and `awardExperience` returns before it
 *   credits anybody when `killer.kind !== Player` — so for a shadow's kill the
 *   Redactor is paid neither the experience NOR the Ink. Upstream pays her
 *   both, and the hate half is the one with a price on it: `INK_PER_KILL` is 8
 *   and `SHADOW_INK_COST` is 5, so a shadow that lands one kill leaves her
 *   THIRTEEN INK DOWN against having done it herself — two and a half Strike
 *   Outs — with no way to stop it. Measured over 48 moor runs with the stance
 *   up, 60% of summon attempts are already refused for want of Ink. Stated
 *   because it is a real economic difference on a class whose resource comes
 *   from kills, and it is the argument for pressing the button to HOLD a line
 *   rather than to farm one.
 *
 *   `hate_regen = 1` (:196) IS THE SHADOW'S OWN FIELD and not that clause:
 *   every body upstream regenerates hate, and a shadow spends none. It is
 *   transcribed nowhere for that reason.
 */

import { RANK_VALUE, lifeGainedTo } from '../../shared/leveling.ts';
import { bound, combatTalentScale } from '../../shared/scale.ts';
import { tileDistance } from '../../shared/distance.ts';
import {
  BOUND_SHADOW,
  SHADOW_ATK_BASE,
  SHADOW_APR,
  SHADOW_DEF,
  SHADOW_RESIST_PEN,
  shadowStatsAt,
  shadowWeaponDamageAt,
} from '../content/monsters.ts';
import {
  shadowWarriorAccuracyAt,
  shadowWarriorDamageAt,
  shadowWarriors,
} from './shadow_warriors.ts';
import { Faction, isMonster, isPlayer } from '../engine/actor.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TargetShape,
  spendResource,
  talentId,
  talentLevelOf,
} from '../engine/talents.ts';
import type { EngineActor, MonsterActor, MonsterInit } from '../engine/actor.ts';
import type { CombatSheet } from '../engine/combat.ts';
import type { Talent, TalentEngine } from '../engine/talents.ts';
import type { SummonPassResult } from '../engine/scheduler.ts';
import type { TileXY } from '../../shared/coords.ts';

export const CALL_SHADOWS_ID = talentId('call_shadows');

/**
 * What a body with no `life_rating` of its own gets — `tome/class/Actor.lua:187`
 * (`life_rating = 10`). `BOUND_SHADOW` authors 5 and this is unreachable; it is
 * named rather than written as a literal so the fallback is a stated engine
 * default and not a number somebody picked.
 */
const ENGINE_LIFE_RATING = 10;

/** `math.min(4, …)` — shadows.lua:348. */
const MAX_SHADOWS_CAP = 4;
/** `… math.floor(self:getTalentLevel(t) * 0.55)` — shadows.lua:348. */
const SHADOWS_PER_LEVEL = 0.55;

/**
 * `self:incHate(-5)` and the `getHate() < 5` refusal — shadows.lua:405-410.
 *
 * FIVE INK, AND THE UNIT CONVERSION IS THE IDENTITY. Upstream's hate pool is
 * 0-100 (`Actor.lua`'s `max_hate`) and `ResourceKind.Ink` is 0-100
 * (`RESOURCE_RULES`), so the Doomed's five hate is five Ink and no rescaling is
 * needed or honest. It is EXACTLY ONE STRIKE OUT (`strike_out.ts`'s `INK_COST`
 * is 5) — the sentence here used to say "a third of a Strike Out ... costs 8",
 * which read `INK_PER_KILL` off the wrong constant. A shadow costs what a mark
 * costs, which is the trade the stance actually asks you to make.
 */
export const SHADOW_INK_COST = 5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW OFTEN A SHADOW ARRIVES — 10 AT RANK 1, AND THE RANK MOVES IT. OURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `self.shadows.remainingCooldown = 10` (shadows.lua:449) IS FIXED UPSTREAM.
 * Ten turns at every rank. This is the one number in the file that is not a
 * transcription, and it is here because of what did NOT cross.
 *
 * ═══ WHAT A RANK BUYS UPSTREAM, AND WHY NONE OF IT REACHED US ═══
 * Four things move with `getTalentLevel` on this talent:
 *
 *   `getMaxShadows`          1, 1, 1, 2, 2 at raw ranks 1-5 — so it is FLAT
 *                            across the first three points, upstream included.
 *   `getPhaseDoorLevel`      the shadow's Phase Door rank.  NOT PORTED.
 *   `getBlindsideLevel`      the shadow's Blindside rank.   NOT PORTED.
 *   `getHealLevel`           the shadow's Heal rank.        NOT PORTED.
 *   `getAvoidMasterDamage`   STRUCTURALLY UNREACHABLE here — see the header.
 *
 * The three unported ones are the whole of what a second and third point buy
 * upstream, and they are unported for a stated reason (the `"shadow"` AI they
 * are chosen by). So without a second lever a Redactor's second point in Call
 * Shadows would buy NOTHING a player could see — which is the one thing this
 * project says a talent tree must never be, in as many words at
 * `TalentResolution.markMultiplier`: *"Both talents' levels were therefore
 * partly cosmetic, which is the one thing a talent tree must never be."*
 *
 * ═══ SO THE RANK IS GIVEN A SECOND THING TO MOVE, AND IT IS OURS ═══
 * `on_my_whistle.ts` is the precedent and makes the whole argument: when
 * `combatTalentScale` rounded two consecutive ranks to the same figure, the
 * answer was not to widen the band until it did not — it was to give the rank a
 * second thing to move, chosen so it means what the talent means.
 *
 * A stance you have practised calls them SOONER. Ten turns down to four across
 * five ranks, on `combatTalentScale` like everything else here, so the shape is
 * the engine's even though the endpoints are not upstream's.
 *
 * THE DAY ANY OF THE THREE CROSSES, THIS COMES OUT and the cadence goes back to
 * a flat ten. That is what makes it a stand-in rather than a design.
 */
const SUMMON_EVERY_LOW = 10;
const SUMMON_EVERY_HIGH = 4;

/** Turns between shadows, at a rank. 10 at rank 1 — upstream's flat figure. */
export function summonEveryAt(talentLevel: number): number {
  return Math.max(
    SUMMON_EVERY_HIGH,
    Math.round(combatTalentScale(talentLevel, SUMMON_EVERY_LOW, SUMMON_EVERY_HIGH)),
  );
}

/**
 * `ai_state.summoner_range = 10` — shadows.lua:248. Upstream's AI uses it to
 * hover; ours uses it as a LEASH (see `shadowPass`), which is the same number
 * doing the same job at a different layer.
 */
export const SHADOW_SUMMONER_RANGE = 10;

/** `getAvoidMasterDamage` — `util.bound(combatTalentScale(t, 5, 85), 0, 100)`, :350-352. */
const AVOID_LOW = 5;
const AVOID_HIGH = 85;
const AVOID_FLOOR = 0;
const AVOID_CEILING = 100;

/** How many shadows may stand at once, at a rank. shadows.lua:347-349. */
export function maxShadowsAt(talentLevel: number): number {
  return Math.min(MAX_SHADOWS_CAP, Math.max(1, Math.floor(talentLevel * SHADOWS_PER_LEVEL)));
}

/**
 * What fraction of its master's damage a shadow ignores, at a rank.
 *
 * PORTED AND UNREACHABLE — see the header. Exported so the number exists and is
 * testable on the day friendly fire does.
 */
export function avoidMasterDamageAt(talentLevel: number): number {
  return bound(combatTalentScale(talentLevel, AVOID_LOW, AVOID_HIGH), AVOID_FLOOR, AVOID_CEILING);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `feed` — shadows.lua:288-312, the part of it that crossed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream calls `shadow:feed()` at summon time (:422) AND again from Shadow
 * Warriors' and Shadow Mages' `on_learn`/`on_unlearn` (:490-511), so a rank
 * bought mid-fight reaches shadows that are already standing. It is written as
 * a REFRESH — it removes the previous temporary values before adding new ones —
 * precisely so it can be run repeatedly.
 *
 * Ours is run from the same two moments: once at summon, and once per base turn
 * from `shadowPass`. That is more often than upstream and it is the same
 * function, so a rank spent mid-fight upgrades the shadow on its next turn
 * rather than never.
 */
function shadowCombatAt(level: number, warriorLevel: number): CombatSheet {
  const accuracy = shadowWarriorAccuracyAt(warriorLevel);
  const damage = shadowWarriorDamageAt(warriorLevel);
  return {
    stats: shadowStatsAt(level),
    mods: { armour: 0, def: SHADOW_DEF },
    weapon: {
      // :211-214 — `dam` on the curve, `atk = 10 + level`, `apr = 8`.
      dam: shadowWeaponDamageAt(level),
      atk: SHADOW_ATK_BASE + level + accuracy,
      apr: SHADOW_APR,
      damMod: { str: 0.5, dex: 0.5 },
    },
    // `resists = { [DamageType.LIGHT] = -100, [DamageType.DARKNESS] = 100 }`
    // (:241) — taken off the
    // template rather than restated, so the body a talent builds and the body a
    // reader sees in `content/monsters.ts` cannot disagree about what it is.
    profile: BOUND_SHADOW.combat.profile,
    penetration: { all: SHADOW_RESIST_PEN },
    // :307 — `addTemporaryValue("inc_damage", {all=…})`. Absent at rank 0, so a
    // Redactor who has not bought Shadow Warriors carries no key at all and her
    // shadows are byte-identical to what `createShadow` alone produces.
    ...(damage === 0 ? {} : { increase: { all: damage } }),
    immunities: BOUND_SHADOW.combat.immunities,
    range: BOUND_SHADOW.combat.range,
    minRange: BOUND_SHADOW.combat.minRange,
    damageType: BOUND_SHADOW.combat.damageType,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE POOL A SHADOW IS SUMMONED WITH — `forceLevelup`, shadows.lua:420.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * shadow:resolve()
 * shadow:resolve(nil, true)
 * shadow:forceLevelup(level)          -- <- this line
 * game.zone:addEntity(game.level, shadow, "actor", x, y)
 * ```
 *
 * `forceLevelup` (engines/default/engine/interface/ActorLevel.lua:138-146) is
 * `while self.level < lev do self.level = self.level + 1; self:levelup() end`,
 * and `levelup()` (Actor.lua:3818-3822) is where `life_rating` is spent:
 *
 * ```lua
 * local rating = self.life_rating
 * if not self.fixed_rating then rating = rng.range(…) end
 * self.max_life = self.max_life + math.max(self:getRankLifeAdjust(rating), 1)
 * ```
 *
 * ═══ THIS LINE WAS DROPPED ONCE, ON A MISREADING OF TWO OTHER CLAUSES ═══
 * The comment that stood here said *"a shadow does not grow, so the life rating
 * never applies"*, resting on `autolevel = "none"` and
 * `level_range = {level, level}` (:193-194). NEITHER SAYS ANYTHING ABOUT LIFE:
 *
 *   `autolevel` selects the Autolevel SCHEME (Actor.lua:3835-3837) — which
 *     STATS a levelup allocates, and this body's stats are written out in full
 *     by `createShadow` itself (`shadowStatsAt`).
 *   `level_range` is read by `Zone` during entity GENERATION
 *     (Zone.lua:214-222); `game.zone:addEntity` never applies it to an NPC
 *     built by hand, which is what `createShadow` returns.
 *
 * So the pool IS the one number in `createShadow` that moves with the
 * summoner's level, and it was the only one that did not cross. Measured
 * before the fix: 8 hit points at summoner level 1, 5, 10, 20 and 30 alike —
 * against an `INDEX_HUSK` of 25 / 64 / 119 / 248 / 402. A body that dies to
 * the first blow holds a doorway for zero turns, which is the whole talent.
 *
 * `lifeGainedTo` (shared/leveling.ts:149) IS that loop, already ported and
 * already what `monsterInit` folds for every other creature in the game; the
 * deterministic branch is upstream's own for a `fixed_rating` body and the
 * only one `src/shared/` may have (no RNG). `BOUND_SHADOW.lifeRating = 5`
 * was transcribed from shadows.lua:200 and read by NOTHING until this.
 *
 * NO CONSTITUTION TERM, unlike `monsterInit`. That function pays for the stat
 * points a levelup ALLOCATES on top of an authored sheet; `shadowStatsAt` is
 * upstream's `combatScale` curve evaluated at the level directly, so the con
 * is already in the body and folding it again would pay twice.
 */
export function shadowMaxHpAt(level: number): number {
  return Math.floor(
    BOUND_SHADOW.maxHp +
      lifeGainedTo(
        BOUND_SHADOW.lifeRating ?? ENGINE_LIFE_RATING,
        level,
        RANK_VALUE[BOUND_SHADOW.rank],
      ),
  );
}

/**
 * One shadow, at a level, in the shape `world.addMonster` wants.
 *
 * `getLevel = function(self, t) return self.level end` (shadows.lua:346) — the
 * shadow is born at the SUMMONER'S CHARACTER LEVEL. Every stat, the weapon and
 * the pool are computed from that one number, which is why this builds the
 * whole body rather than calling `monsterInit`, whose job is the opposite: a
 * template grown BY a level.
 */
export function shadowInitAt(
  level: number,
  warriorLevel: number,
  at: TileXY,
  summonerId: string,
): MonsterInit {
  return {
    // BORN AT A LEVEL AND CARRYING IT. `MonsterActor.level` is what `shadowPass`
    // re-reads when it re-runs `feed`, and it is the same number
    // `level_range = {level, level}` (:194) pins upstream.
    level,
    name: BOUND_SHADOW.displayName,
    sprite: BOUND_SHADOW.sprite,
    x: at.x,
    y: at.y,
    profile: BOUND_SHADOW.profile,
    rank: BOUND_SHADOW.rank,
    // `max_life` plus `forceLevelup(level)` — see `shadowMaxHpAt`.
    maxHp: shadowMaxHpAt(level),
    hpRegen: BOUND_SHADOW.hpRegen,
    globalSpeed: BOUND_SHADOW.globalSpeed,
    speedFactor: BOUND_SHADOW.speedFactor,
    attackRange: BOUND_SHADOW.attackRange,
    aggroRange: BOUND_SHADOW.aggroRange,
    preferredRange: BOUND_SHADOW.preferredRange,
    minRange: BOUND_SHADOW.minRange,
    huntsIsolated: BOUND_SHADOW.huntsIsolated,
    shoulderAfter: BOUND_SHADOW.shoulderAfter,
    noBreath: true,
    faction: Faction.Bound,
    summonerId,
    combat: shadowCombatAt(level, warriorLevel),
  };
}

/**
 * The id a shadow gets. DETERMINISTIC AND SLOT-KEYED, never a counter.
 *
 * `world.addMonster` is idempotent on id and this pass runs inside a pump, so
 * an id that depended on a running total would re-use a dead shadow's slot in a
 * way that depends on burial order. Slots 0..3 are searched in order and the
 * first free one is taken, which is a pure function of who is standing.
 */
function shadowIdFor(summonerId: string, slot: number): string {
  return `shadow:${summonerId}:${String(slot)}`;
}

/** Everything the summon pass needs from the world, and nothing else. */
export type SummonWorld = {
  allActors(): EngineActor[];
  getActor(id: string): EngineActor | undefined;
  addMonster(id: string, init: MonsterInit): EngineActor;
  nearestSeat(from: TileXY): TileXY | undefined;
};

/** Every living shadow this body has called up. `nbShadowsUp`, shadows.lua:380-387. */
export function shadowsOf(world: SummonWorld, summonerId: string): readonly MonsterActor[] {
  const out: MonsterActor[] = [];
  for (const actor of world.allActors()) {
    if (!isMonster(actor)) continue;
    if (actor.summonerId !== summonerId || !actor.alive) continue;
    out.push(actor);
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `callbackOnActBase` — shadows.lua:438-453, clause for clause.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * self.shadows.remainingCooldown = self.shadows.remainingCooldown - 1
 * if self.shadows.remainingCooldown > 0 then return false end
 * self.shadows.remainingCooldown = 10
 * t.summonShadow(self, t)
 * ```
 *
 * THE COUNTER STARTS AT ZERO, so the first base turn after the stance goes up
 * takes it to -1, which is not `> 0`, and a shadow arrives that turn. That is
 * upstream's behaviour and it is the whole reason the talent feels like a
 * stance rather than a cast: you turn it on and something is there.
 *
 * `if game.zone.wilderness then return false end` (:445) DID NOT CROSS. It is
 * upstream's overworld, where no fight can happen; ours has overworlds too, but
 * they hold roamers and a Redactor can be attacked on one, so refusing to
 * summon there would take the answer away in the one place a solo player meets
 * something alone. A DELIBERATE DIVERGENCE, and it is the safer direction.
 */
function summonPass(
  world: SummonWorld,
  engine: TalentEngine,
  summoner: EngineActor,
): SummonPassResult {
  if (!isPlayer(summoner)) return {};
  const sheet = engine.sheetOf(summoner.id);
  if (sheet === undefined || !sheet.sustained.has(CALL_SHADOWS_ID)) return {};

  // THE EFFECTIVE LEVEL, mastery folded in — `talentLevelOf` is the only
  // function allowed to answer that question (engine/talents.ts).
  const talentLevel = talentLevelOf(sheet, callShadows);

  const remaining = (summoner.shadowCooldown ?? 0) - 1;
  if (remaining > 0) {
    summoner.shadowCooldown = remaining;
    return {};
  }
  summoner.shadowCooldown = summonEveryAt(talentLevel);

  // `summonShadow`, :388-396 — the roster is full, and that costs nothing.
  const standing = shadowsOf(world, summoner.id);
  if (standing.length >= maxShadowsAt(talentLevel)) return {};

  // :399-402 — `util.findFreeGrid(self.x, self.y, 8, …)`. `nearestSeat` IS that
  // search at that radius (world.ts), and it answers undefined rather than
  // throwing, which is what a pass running every ten turns needs.
  const seat = world.nearestSeat({ x: summoner.x, y: summoner.y });
  if (seat === undefined) return {};

  // :405-410 — the hate check and the spend, in that order. A refusal leaves
  // the counter reset, so the next attempt is ten turns away: upstream's "not
  // enough hate.. just wait for another try".
  if (!spendResource(sheet.resource, SHADOW_INK_COST)) {
    return { records: [`${summoner.name} has not the Ink to call another shadow.`] };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FREE SLOT IS ASKED OF THE WORLD, NEVER OF `shadowsOf`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `world.addMonster` is IDEMPOTENT ON ID — it returns the existing actor for
   * an id already present (world.ts:1361-1362) — and a corpse is still present
   * for the rest of the pump it died in (`turn-engine.ts` drains `reaped` only
   * after `pump()` returns). `shadowsOf` filters on `alive`, correctly, because
   * a corpse must not hold a slot against the CEILING.
   *
   * Reading the slot off that same list therefore picked an id the world still
   * had. Driven: a shadow killed earlier in the same pump, then the summoner's
   * base turn inside it —
   *
   *     records: ["A shadow steps out of the dark beside Ren."]
   *     ink 96 -> 91 (spent 5)
   *     bound bodies in the world: shadow:p1:0:alive=false
   *     LIVING shadows: 0
   *
   * Five Ink gone, a line in the Case Log that is not true, no body on any
   * tile, and `shadowCooldown` reset — so the next attempt is a full cadence
   * away. THE CEILING AND THE SLOT ARE DIFFERENT QUESTIONS: how many are
   * standing, and which id is free. They are asked of different things.
   */
  let slot = 0;
  while (world.getActor(shadowIdFor(summoner.id, slot)) !== undefined) slot += 1;

  const warriorLevel = talentLevelOf(sheet, shadowWarriors);
  world.addMonster(
    shadowIdFor(summoner.id, slot),
    shadowInitAt(summoner.level, warriorLevel, seat, summoner.id),
  );
  return { records: [`A shadow steps out of the dark beside ${summoner.name}.`] };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE LEASH — `on_act` (shadows.lua:324-329) and `deactivate` (:370-379).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream has two separate mechanisms and ours is one, because ours has to
 * answer a third question neither of theirs does.
 *
 *   `on_act`: `if self.summoner.dead then self:die(self) end`. A shadow whose
 *     master has fallen goes with them.
 *   `deactivate`: every shadow of this summoner gets `summon_time = 0`, which
 *     the engine's expiry pass reads as "gone this turn". Putting the stance
 *     down puts the shadows down.
 *   AND OURS: THE FLOOR. Upstream's summons are entities on a LEVEL and the
 *     level is left behind when you take the stairs. Ours are actors in a
 *     REALM's world and a Redactor who crosses a threshold leaves her shadows
 *     in a world that still ticks them — with no summoner in it, for ever. So
 *     the leash also asks whether the summoner is resolvable in THIS world and
 *     within `summoner_range`, which is `ai_state.summoner_range = 10` (:248)
 *     used as the bound upstream's AI uses it as a target.
 *
 * ═══ MEASURED THE WAY THE SHADOW AI MEASURES IT ═══
 * Upstream's test is in the module's `ai/shadow.lua`, a file that is in the
 * reference repository's git history but not in its sparse checkout
 * (`git -C reference/t-engine4 show HEAD:game/modules/tome/ai/shadow.lua`),
 * under the comment `-- out of summoner range?`:
 *
 *     if core.fov.distance(self.x, self.y, self.summoner.x, self.summoner.y)
 *         > self.ai_state.summoner_range then
 *
 * — the straight line ROUNDED HALF-UP, which is `tileDistance`, and strictly
 * greater. So a shadow at (10,3) from its summoner, 10.44 tiles, rounds to 10
 * and stays, and one at (10,4), 10.77 tiles, rounds to 11 and goes. This was
 * a Chebyshev square, which kept both, and every shadow out to (10,10) with
 * them.
 *
 * A DOWNED PLAYER IS NOT A DEAD ONE. `alive` goes false the moment a detective
 * hits zero and the five-turn rescue window opens (`engine/downed.ts`), and a
 * shadow that vanished at that instant would remove the one body that might
 * still be holding the doorway the party has to come back through. So the test
 * is `world.getActor` resolving at all, plus the stance, plus the distance —
 * never `alive`.
 */
function shadowPass(
  world: SummonWorld,
  engine: TalentEngine,
  shadow: MonsterActor,
): SummonPassResult {
  const summonerId = shadow.summonerId;
  if (summonerId === undefined) return {};
  const summoner = world.getActor(summonerId);
  if (summoner === undefined) return { reap: [shadow.id] };

  const sheet = engine.sheetOf(summonerId);
  if (sheet === undefined || !sheet.sustained.has(CALL_SHADOWS_ID)) return { reap: [shadow.id] };

  if (tileDistance(summoner, shadow) > SHADOW_SUMMONER_RANGE) return { reap: [shadow.id] };

  /**
   * `feed()` — see `shadowCombatAt`. Re-derived from the body's OWN level, so a
   * rank bought mid-fight reaches a shadow that is already standing, which is
   * what upstream's `on_learn` re-feed does.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * IT WRITES `baseCombat` AND CARRIES `flags` ACROSS, AND BOTH ARE THE RULE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `engine/effects.ts#recomposeCombat` states the ownership split in as many
   * words: *"`actor.combat` is OWNED BY `recomposeCombat`, and by nothing else.
   * It is DERIVED — baseCombat, then gear, then these flags — and any writer
   * that skips a stage produces a body whose sheet cannot be reproduced from
   * its own fields."*
   *
   * This line USED TO BE a bare `shadow.combat = shadowCombatAt(…)` and it
   * skipped both ends of that sentence:
   *
   *   IT DROPPED `StatusFlags`. `shadowCombatAt` returns a sheet with no
   *     `flags` key, so the whole block went every base turn. Driven: a shadow
   *     pinned by a real `setEffect` reported `flags.pinned = true`, and one
   *     base turn later reported `flags: undefined` — still carrying a live
   *     `effect:pinned` and no longer pinned. `recomputeAttributes` then ran
   *     only when an effect LANDED or EXPIRED, so the flags stayed gone until
   *     the next effect event. (A shadow is recomposed after its base pass
   *     every base turn now; see `summonPass` in server/main.ts.) The shadow's four immunities cover stun, confusion,
   *     blind and teleport, which makes `pinned` the live case, and `dazed`,
   *     `scoured` and `breached` are equally unprotected.
   *   IT LEFT `baseCombat` FROZEN at the summon-time sheet
   *     (`createMonsterActor` sets `baseCombat: init.combat`), so any full
   *     `recomposeCombat` on this body would have discarded the Shadow
   *     Warriors refresh and quietly put the shadow back to its birth sheet.
   *
   * Upstream has neither problem because `feed` is an `addTemporaryValue` /
   * `removeTemporaryValue` PAIR on two keys (shadows.lua:300-311) — it touches
   * `combat_atk` and `inc_damage` and leaves the rest of the actor alone. This
   * is that, in the vocabulary of a codebase that recomposes from a baseline.
   *
   * ═══ AND IT WAS STILL A WRITER THAT SKIPPED A STAGE ═══
   * Carrying the flags kept stage three. But what a timed effect's `wielder`
   * folds in sits BETWEEN the base and the flags, and this line wrote over it
   * every base turn, after the shadow's own fold had already run: a shadow under
   * Off-balance read `numbed` 0 for as long as the effect lasted. This file
   * cannot rebuild a sheet, because it holds neither the status table nor the
   * item catalogue. So `summonPass` in server/main.ts recomposes a shadow that
   * stays as soon as this returns, and what this line writes is only the sheet
   * for the moment in between.
   */
  const derived = shadowCombatAt(shadow.level, talentLevelOf(sheet, shadowWarriors));
  const flags = shadow.combat?.flags;
  shadow.baseCombat = derived;
  shadow.combat = flags === undefined ? derived : { ...derived, flags };
  return {};
}

/**
 * THE ONE SEAM THE SCHEDULER CALLS, once per body per base turn.
 *
 * BOTH ARMS IN ONE FUNCTION because they are one rule seen from two ends: a
 * summoner's turn asks "should there be another", a summon's turn asks "should
 * I still be here". Splitting them would give the scheduler two optional calls
 * to remember instead of one.
 */
export function shadowsBasePass(
  world: SummonWorld,
  engine: TalentEngine,
  actor: EngineActor,
): SummonPassResult {
  if (isMonster(actor)) {
    return actor.summonerId === undefined ? {} : shadowPass(world, engine, actor);
  }
  return summonPass(world, engine, actor);
}

/**
 * THE SUSTAIN. `mode = "sustained"`, `no_energy = true`, `hate = 0` — free to
 * press, and the price is five Ink per shadow rather than a reservation.
 *
 * ═══ NO `sustain.reserve`, AND THAT IS THE DESIGN RATHER THAN AN OMISSION ═══
 * `ledger_stances.ts` reserves 20 Ink because a ToME stance reserves. This one
 * does not: upstream prices it PER SHADOW (`incHate(-5)`, :410) and a
 * reservation on top would charge the Redactor twice for the same thing. It
 * also makes the stance self-limiting in the right way — a Redactor who is
 * spending her Ink on marks summons more slowly, which is the same tension
 * `ledger/testimony` already makes her feel, expressed as a body instead of a
 * number.
 *
 * `cooldown = 10` (:342) IS ON THE SUMMON, NOT ON THE PRESS. Upstream's sustain
 * cooldown and `self.shadows.remainingCooldown` are both ten and they are
 * different clocks; ours keeps the one that matters — see `summonEveryAt`
 * — and leaves the press free, because a stance you cannot put back up for ten
 * turns after dropping it is a trap rather than a decision.
 */
export const callShadows: Talent = {
  id: CALL_SHADOWS_ID,
  name: 'Call Shadows',
  classId: ClassId.Redactor,
  tree: 'ledger/unwritten',
  /** Tier 1 — `type = {"cursed/shadows", 1}`. See `src/shared/tiers.ts`. */
  tier: 1,
  /** `require = cursed_cun_req1` (shadows.lua:340). See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Sustained,
  iconId: 'icon_sustain_call_shadows',
  cooldownTurns: 0,
  sustain: {},
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,

  describe: (_self, level) =>
    `A stance, free to hold. Every ${String(summonEveryAt(level))} turns it calls a shadow to ` +
    `stand beside you for ${String(SHADOW_INK_COST)} Ink, up to ${String(maxShadowsAt(level))} at ` +
    `once. They are weak, they are born at your level, and they go when you put the stance down ` +
    `or walk more than ${String(SHADOW_SUMMONER_RANGE)} tiles from them.`,
};
