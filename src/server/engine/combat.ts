// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:92-262 (attackTarget)
//                                                                  380-608 (attackTargetWith)
//                                                                  417 (atk/def), 439 (dam/apr/armor)
//                                                                  505-546 (THE resolution order)
//             t-engine4 game/modules/tome/data/damage_types.lua:604 (the projector call)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * MELEE AND RANGED RESOLUTION — the function that ties derived.ts, checkhit.ts
 * and damage.ts together into one swing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER, ONE LINE PER STAGE — Combat.lua:505-546
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local atk, def = self:combatAttack(weapon), target:combatDefense()          -- :417
 * local dam, apr, armor = self:combatDamage(weapon), self:combatAPR(weapon),
 *                         target:combatArmor()                               -- :439
 * elseif self:checkEvasion(target) then evaded = true                         -- :502
 * elseif ... self:checkHit(atk, def)
 *         and (self:canSee(target) or ... or rng.chance(3)) then              -- :505
 *     local pres = util.bound(target:combatArmorHardiness() / 100, 0, 1)      -- :506
 *     local damrange = self:combatDamageRange(weapon)                         -- :510
 *     dam = rng.range(dam, dam * damrange)                                    -- :511
 *     armor = math.max(0, armor - apr)                                        -- :540
 *     dam = math.max(dam * pres - armor, 0) + (dam * (1 - pres))              -- :541
 *     if deflect == 0 then dam, crit = self:physicalCrit(...) end             -- :544
 *     dam = dam * mult                                                        -- :546
 *     DamageType:get(damtype).projector(self, target.x, target.y, damtype, dam)  -- :604
 * ```
 *
 * Everything from `damrange` onward lives in damage.ts's `resolveDamage`, which
 * owns the ordering and the citations. This file computes the six inputs at :417
 * and :439, makes the to-hit call at :505, and hands the rest over. That split is
 * deliberate: a talent that deals damage without a weapon swing (Ashwick Flare)
 * calls `resolveDamage` directly and gets the identical, identically-ordered
 * pipeline without having to skip half of this function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO CLAUSES THE MAP ABOVE USED TO ELIDE, AND WHY NEITHER IS PORTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That line read `elseif ... self:checkHit(atk, def) ... then` for a long time,
 * and both sets of dots hid a real upstream mechanic. Written out here so the
 * next reader finds the ANSWER where they would otherwise find the gap — the
 * `talents.ts` note on Travel Speed exists for the same reason.
 *
 * ═══ `checkEvasion` (:502, defined :353) — A SECOND DODGE CHANNEL ═══
 * `rng.percent(target:attr("evasion"))`, rolled BEFORE the to-hit roll and
 * skipping it entirely. NOTHING HERE GRANTS `evasion`, and that is a decision
 * rather than an omission: our `Evasive` effect returns `mods: { def }` through
 * `EffectDef.wielder`, so "harder to hit" is expressed as DEFENCE and goes
 * THROUGH `checkHit` instead of around it. Porting the attr would add a second
 * dodge channel with no content feeding it, and two ways to miss that stack
 * invisibly is worse than one that shows up on the character sheet.
 *
 * ═══ `canSee(target) or ... or rng.chance(3)` (:505) — SWINGING BLIND ═══
 * A landed roll against a target you cannot see connects only one time in
 * three. THE CASE IS UNREACHABLE HERE. Sight is radius 10 with line of sight
 * (`DEFAULT_SIGHT_RADIUS`), and LOS to an ADJACENT tile is always true, so
 * anything you can melee you can see. No status conceals: `Effaced` is a roll
 * debuff — *"every roll you make and every roll you resist is worse"* — not
 * concealment, and there is no Blind in `MVP_EFFECTS`.
 *
 * SO IT IS CONTENT-GATED, NOT REFUSED. The day a concealing status or a Blind
 * lands, this clause ports WITH it — a status that hides a body and a melee
 * path that cannot tell are the two halves of one feature, and shipping the
 * first alone is how a stealth effect silently does nothing.
 *
 * The rest of `attackTargetWith` was read at the same time and needs nothing:
 * every other branch in :380-680 is gated on a ToME talent or effect this game
 * has no content for (`T_REPEL`, `EFF_WEAPON_WARDING`, `T_BLADE_WARD`,
 * `EFF_GESTURE_OF_GUARDING`, `T_INTUITIVE_SHOTS`, `EFF_COUNTERSTRIKE`), and
 * `attackTargetHitProcs` (:681-900) reaches for exactly three generic attrs —
 * `damage_backfire`, `onslaught`, `shattering_impact` — all three likewise
 * talent-granted upstream and unfed here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MIN_RANGE — THE INSPECTOR'S DEAD ZONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 2 calls `min_range 3` "the single most important number here":
 * the Inspector CANNOT shoot an adjacent enemy, which is the entire reason the
 * Watchman holding a choke is worth anything. The refusal is enforced HERE, on
 * the server, because the server is the only authority — a client that draws the
 * hole but does not enforce it is a UI hint, and a server that enforces it
 * without the client drawing it reads as a broken class.
 *
 * The refusal is a distinct `AttackRefusal.MinRange`, never a miss, so the log
 * can say "too close" instead of silently eating the turn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - IT DOES NOT SPEND ENERGY. Combat.lua:234-236 does (`useEnergy(energy_to_act
 *    * speed)`); here the swing REPORTS its speed (`AttackResult.speed`) and
 *    the scheduler's `spendTurn` charges it, because that is the only
 *    sanctioned spender. A talent that swings through here is priced by its
 *    own speed instead, exactly as upstream's pass `noenergy` to this call.
 *  - IT DOES NOT EMIT EVENTS. It returns a value; the scheduler turns that into
 *    `GameEvent`s, because only the scheduler knows whether this was a player
 *    action or part of a batched monster sweep.
 *  - IT DOES NOT MOVE ANYONE, break stealth, trigger hooks, or run any of the
 *    ~40 talent interceptors between Combat.lua:96 and :260. Twelve talents,
 *    zero of them interceptors (PLAN.md).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEDULER IS NOW ON THIS PATH — WHAT THAT COST AND WHY IT WAS ONE CHANGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HISTORY, KEPT BECAUSE IT IS THE REASON `MELEE_REACH` EXISTS. `scheduler.ts#
 * strike` used to be the M2 placeholder — `rng.int(damageMin, damageMax)`
 * straight into `actor.ts#applyDamage` — and it range-checked with CHEBYSHEV,
 * while this file measured a straight line, because every range and radius in
 * ToME is measured with `core.fov.distance` (docs/tome-mechanics.md § 10). A
 * Chebyshev range ring is a square; the targeting UI draws a circle.
 *
 * Swapping the scheduler over was therefore ONE change, not two: the range check
 * and the resolution had to move together. Leaving `strike` on Chebyshev while
 * `attackTarget` refused on the straight line produced attacks that passed the
 * scheduler's legality check and then quietly did nothing — and the first thing
 * that fell out of moving them together was that an UNROUNDED reach of exactly 1
 * refused every diagonal melee swing in the game. Hence `MELEE_REACH`.
 *
 * THE STRAIGHT LINE WAS THE WRONG ONE. `core.fov.distance` ROUNDS the length
 * half-up (`combatDistance` below), so a diagonal neighbour is 1 away and a
 * reach of 1 holds all eight. The metric the two halves share is that rounded
 * one now; the pairing argument above is unchanged by it.
 */

import { checkHit } from '../../shared/checkhit.ts';
import { tileDistance } from '../../shared/distance.ts';
import { hasLineOfSight } from '../../shared/sight.ts';
import { DAMAGE_TYPES } from '../../shared/damagetype.ts';
import { DamageType, applyDamage } from './damage.ts';
import {
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatCritPower,
  combatDamage,
  combatDamageRange,
  combatDefense,
  combatSpeed,
} from './derived.ts';
// TYPE-ONLY, so this is erased at runtime and cannot make a cycle with
// actor.ts — which imports `CombatSheet` from here. `OnHitStatus` lives there
// because a MONSTER declares one directly and has since M3; the sheet is the
// second place one can come from, not the first.
import type { OnHitStatus } from './actor.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { DamageProfile, TypeTable } from './damage.ts';
import type { Combatant, Weapon } from './derived.ts';

/**
 * A combat sheet plus the damage-side profile.
 *
 * One object rather than two because every content template authors them
 * together and every call site needs both halves. M4's loader hangs one of these
 * off each actor as `actor.combat`.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A WORN THING LEAVES IN THE WOUND — ToME's `melee_project`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MonsterActor.onHit` has carried a ghoul's paralysis since M3 and `strike`
 * applies it at one guarded site. The PLAYER side of the same idea — a serrated
 * blade that opens a cut, upstream's `wielder = { melee_project = ... }` — had
 * nowhere to live: `strike` read `isMonster(attacker) ? attacker.onHit`, so a
 * rider was a fact only a creature could state.
 *
 * A LIST, BECAUSE A BODY WEARS MORE THAN ONE THING. Upstream folds every
 * wielder's `melee_project` and fires all of them; two serrated weapons are two
 * cuts, not the louder of the two. It is the one channel in this fold that is
 * not a number, so it CONCATENATES where the rest add — which is the same
 * "combine per channel" rule, with the combine that fits.
 */
export type CombatSheet = Combatant & {
  /**
   * `melee_project` — the riders every worn thing contributes, concatenated.
   * ABSENT rather than empty when nothing grants one, so an empty fold still
   * deep-equals the sheet it folded. See the block above this type.
   */
  readonly onHit?: readonly OnHitStatus[];
  /** Resistances, caps and flat reduction. Read when this actor is the TARGET. */
  readonly profile?: DamageProfile;
  /** `inc_damage` — additive damage bonuses. Read when this actor ATTACKS. */
  readonly increase?: TypeTable;
  /**
   * `melee_project` — TYPED DAMAGE ADDED TO EVERY LANDED BLOW. A brand.
   *
   * Combat.lua:723-732. Read when this actor ATTACKS, like `increase` — but it
   * is not a modifier on the swing's damage, it is a SEPARATE application
   * through the full pipeline, which is why it sits beside `increase` rather
   * than inside it. A fire brand on a weapon is resisted by fire resistance and
   * amplified by fire increase; the swing that carried it is neither.
   *
   * See `Wielder.brand` for the channel and `engine/scheduler.ts` for the two
   * conditions upstream puts on it.
   */
  readonly brand?: TypeTable;
  /**
   * `on_melee_hit` — TYPED DAMAGE PAID BY WHOEVER LANDS A BLOW ON THIS ACTOR.
   *
   * Combat.lua:851-891. The brand's mirror image, and the only table on this
   * sheet that is read when the actor is neither swinging nor being asked to
   * resist: it is read off the DEFENDER and spent ON THE ATTACKER, which is why
   * neither `increase` (attacker-side) nor `profile` (target-side) is the right
   * home for it.
   *
   * See `Wielder.retaliation` for the channel and `noteRetaliation` in
   * `engine/scheduler.ts` for the application.
   */
  readonly retaliation?: TypeTable;
  /** `resists_pen` — resistance penetration. Read when this actor ATTACKS. */
  readonly penetration?: TypeTable;
  /**
   * `*_immune` — percent chance to REFUSE a status outright, by subtype.
   *
   * Keyed by the strings in `EffectDef.subtypes`; `IMMUNITY_KEYS` is the list
   * content may author. Read by `canBe` when this actor is the TARGET of a
   * detrimental effect, and composed MULTIPLICATIVELY across an effect's
   * subtypes there — 50% wound and 50% bleed leave a 25% chance of being cut,
   * not none. On the sheet rather than in `EffectState` because a worn immunity
   * has to survive being taken off, and only recomposition does that.
   */
  readonly immunities?: Readonly<Record<string, number>>;
  /**
   * Reach, in `combatDistance` tiles — `core.fov.distance`, the length rounded
   * half-up. 1 is melee, diagonals included; `MELEE_REACH` is the same reach.
   */
  readonly range?: number;
  /**
   * The dead zone: closer than this and the attack is REFUSED.
   *
   * The Inspector's 3 (game-design.md § 2). 0 for everything melee.
   */
  readonly minRange?: number;
  /** What this actor's basic attack deals. Defaults to physical. */
  readonly damageType?: DamageType;
};

/**
 * The minimum an actor needs to swing or be swung at.
 *
 * Structural rather than `EngineActor` on purpose: it is satisfied by an
 * engine actor today (which carries no `combat` field yet, hence the `?`), by a
 * bare test fixture, and by whatever M4's content loader produces. Widening this
 * to the real actor type would drag the energy clocks and the barrier's control
 * flags into every combat unit test.
 */
export type CombatActor = {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  hp: number;
  alive: boolean;
  /** The M2 placeholder reach on `EngineActor`. `combat.range` wins when present. */
  readonly attackRange?: number;
  readonly combat?: CombatSheet;
};

/** Just enough world for the legality checks. `World` satisfies it. */
export type CombatWorld = {
  readonly level: LevelView;
  /**
   * The line a body is allowed, when the world can say (`World.lineClearFor`).
   * Absent, as in a fixture, the plain line of sight.
   */
  lineClearFor?(actor: CombatActor, to: { readonly x: number; readonly y: number }): boolean;
};

/** Why a swing never happened. Never a miss — a miss is `ok: true, hit: false`. */
export const AttackRefusal = {
  /** The attacker is a corpse. */
  Dead: 'dead',
  /** The target is already a corpse — the refund rule's commonest trigger. */
  TargetDead: 'target_dead',
  /** Beyond reach. */
  OutOfRange: 'out_of_range',
  /** INSIDE the dead zone. The Inspector cannot shoot what is standing on them. */
  MinRange: 'min_range',
  /** A wall. Only checked beyond melee reach. */
  NoLineOfSight: 'no_line_of_sight',
  /** Swinging at yourself. */
  Self: 'self',
} as const;
export type AttackRefusal = (typeof AttackRefusal)[keyof typeof AttackRefusal];

/**
 * What one swing did.
 *
 * Discriminated on `ok` so a caller cannot read `damage` off a refusal, and
 * carries `atk`/`def`/`chance` because the Record log prints them verbatim —
 * "Hits Bent Watchman (acc 41 vs def 33, 70%)" (game-design.md § 11). Those are
 * the numbers that make a miss feel like arithmetic rather than the server being
 * unfair, and they are already computed here.
 */
export type AttackResult =
  | { readonly ok: false; readonly reason: AttackRefusal }
  | {
      readonly ok: true;
      readonly targetId: string;
      /** Did the blow connect? False is a MISS, which still consumed the turn. */
      readonly hit: boolean;
      /** Attacker's rescaled accuracy (Combat.lua:417). */
      readonly atk: number;
      /** Defender's rescaled defence (Combat.lua:417). */
      readonly def: number;
      /** The to-hit percentage that was rolled against. */
      readonly chance: number;
      /** HP actually removed. 0 on a miss. */
      readonly damage: number;
      readonly crit: boolean;
      readonly killed: boolean;
      readonly type: DamageType;
      /**
       * WHAT THE BRAND ADDED, on top of `damage`. 0 when nothing is branded.
       *
       * SEPARATE FROM `damage` RATHER THAN SUMMED INTO IT, because upstream is
       * separate: `melee_project` runs its own `projector` call per type
       * (Combat.lua:723-732), so each element is resisted, penetrated and
       * amplified on its own terms. Folding it into the swing's number would
       * report a fire brand as physical damage on the one surface — the case
       * log — that exists to tell a party what is actually hurting things.
       */
      readonly brandDamage: number;
      /**
       * WHAT THE SWING COSTS, as a multiple of a turn — `combatSpeed` of the
       * weapon actually swung. Upstream's `attackTargetWith` returns exactly this
       * first (`return self:combatSpeed(weapon), hitted, dam`, Combat.lua:677),
       * hit or miss, and `attackTarget` charges the largest of them
       * (Combat.lua:185, :211, :226, :234-236). The scheduler is the one that
       * spends it; this file only reports it.
       */
      readonly speed: number;
    };

/** Everything a template can leave unsaid. */
const DEFAULT_SHEET: CombatSheet = {};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REACH THAT IS THE MOORE NEIGHBOURHOOD. 1.5, AND UNDER ToME'S ROUNDED
 * DISTANCE IT IS THE SAME REACH AS UPSTREAM'S 1.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `combatDistance` is `core.fov.distance`, whole tiles: the eight neighbours
 * are all 1 away (a diagonal is 1.41 rounded half-up) and the nearest tile past
 * them is 2. So any reach from 1 up to just under 2 is the same set of tiles —
 * the 3x3 — and 1.5 is one of them. It is not the smaller number upstream
 * writes (`range = 1` on every melee talent) only because it was chosen while
 * this file measured the UNROUNDED length, under which the diagonals sat at
 * 1.4142 and a reach of exactly 1 refused all four. The number is kept rather
 * than lowered because nothing behaves differently for it; lowering it to
 * upstream's literal is the author's call, not a fix.
 *
 * `validateTemplate` in content/monsters.ts used to refuse a melee template
 * whose `combat.range` was under √2, on the same unrounded arithmetic. It is
 * gone: a template authoring upstream's 1 now reaches the diagonals, and
 * test/server/monsters.test.ts pins that it is accepted and swings at (1,1).
 *
 * ═══ WHY A CONSTANT AND NOT A LITERAL, AND WHY `Math.max` BELOW ═══
 * `EngineActor.attackRange` 1 means the eight-neighbourhood, which is what
 * makes bump-attack work on a diagonal. It is read on two metrics (its note in
 * engine/actor.ts names the readers): `rangeRefusal` takes it on the rounded
 * length when a sheet names no range, and the guard counter and the orb take
 * it as Chebyshev. On the rounded metric a raw 1 reaches the same eight tiles
 * as on Chebyshev; it was the UNROUNDED metric under which feeding that 1 into
 * `canAttack` refused every diagonal melee attack in the game — the swing
 * passed the scheduler and then quietly did nothing, which is the failure the
 * wiring note at the top of this file warns about.
 * `Math.max(attackRange, MELEE_REACH)` is kept for the actor
 * with no sheet at all, and it still leaves a ranged fixture that sets only
 * `attackRange: 5` with the reach it asked for.
 *
 * It is EXPORTED because the class sheets (content/classes.ts) and every melee
 * talent need the same number, and a second literal 1.5 somewhere else is a
 * second definition of what melee means.
 */
export const MELEE_REACH = 1.5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIST EVERY BODY HAS — tome/class/Actor.lua:277-285, verbatim.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     -- Default melee barehanded damage
 *     self.combat = self.combat or {
 *       dam=1,
 *       atk=1, apr=0,
 *       physcrit=0,
 *       physspeed =1,
 *       dammod = { str=1 },
 *       damrange=1.1,
 *     }
 *
 * EVERY FIELD IS UPSTREAM'S AND THE NUMBERS ARE NOT NEGOTIABLE. A ToME archer
 * cornered in a doorway is not refused; she punches.
 *
 * ═══ AND A `dam` OF 1 IS NOT A DAMAGE OF 1 — MEASURED, HAVING ASSUMED IT WAS ═══
 * The first draft of this note called the punch "deliberately feeble" and
 * "one point of base damage". It is neither, and the reason is upstream's own
 * curve: `combatDamagePower` (Combat.lua:1682-1687) is
 * `(sqrt((dam + totstat) / 10) - 1) * 0.5 + 1`, so the weapon's `dam` goes under
 * a square root BESIDE the whole stat term rather than multiplying the result.
 * Run through this game's own `combatDamage` on the shipped Inspector, a
 * `dam` of 1 against the revolver's 18 comes out as 7.06 against 11.54 — a
 * factor of 1.6, not 18.
 *
 * That is the port and it is left alone. What the fist loses is the rest of the
 * weapon: half the crit (`physcrit = 0` against the revolver's 3, and `physCrit`
 * DEFAULTS TO 1 when absent at Combat.lua:1424, which is why the zero is written
 * out), half the armour penetration, and the narrower damage band.
 *
 * `dammod = { str = 1 }` is the one number LARGER than a real weapon's
 * (`{ str = 0.6 }` is ToME's default, Combat.lua:1625) and it is upstream's:
 * with a `dam` of 1 the stat term is nearly all of the swing, which is why a
 * strong body's punch is worth more than a weak one's.
 *
 * See `Weapon.archery` (engine/derived.ts) for what reaches this, and
 * `barehandAt` below for when.
 */
export const BAREHAND: Weapon = {
  dam: 1,
  atk: 1,
  apr: 0,
  physCrit: 0,
  physSpeed: 1,
  damMod: { str: 1 },
  damRange: 1.1,
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS SWING A PUNCH? — tome/class/interface/Combat.lua:181, :204, :221-231.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's melee loop skips any weapon flagged `archery` in BOTH hands
 * (`if combat and not o.archery then`, twice), which leaves `speed` nil, which
 * falls into `-- Barehanded ?` at :221 and swings
 * `self:getObjectCombat(nil, "barehand")` — the innate `self.combat` above.
 *
 * ═══ THE ONE ADAPTATION, STATED ═══
 * Upstream splits by ATTACK KIND: `attackTarget` is melee and never uses a bow,
 * while `Archery.lua`'s talents always do, at any distance. This engine has one
 * `attackTarget` that serves both the bump and the basic shot, because a class's
 * reach is `CombatSheet.range` rather than a second code path. So the split is
 * by DISTANCE instead: inside `MELEE_REACH` you are swinging, and a gun cannot
 * be swung. Past it you are firing, and the gun is the weapon.
 *
 * That lands on exactly upstream's outcome for the only case either rule can
 * disagree about — a body in contact with a gun in its hands — which is the case
 * this exists for.
 *
 * IT READS THE WEAPON, NOT THE CLASS. A monster's innate weapon is not archery
 * (upstream's are `self.combat` tables, which is the barehand slot itself), so
 * nothing about a wraith or a husk changes.
 */
function barehandAt(sheet: CombatSheet, distance: number): boolean {
  return sheet.weapon?.archery === true && distance <= MELEE_REACH;
}

/**
 * `core.fov.distance` — the straight-line length ROUNDED HALF-UP to whole tiles,
 * which is `tileDistance` (shared/distance.ts) and nothing else.
 *
 * ToME uses TWO metrics on purpose — Chebyshev for A* step costs
 * (`ENGINE/Astar.lua`, diagonals cost the same as orthogonals) and
 * `core.fov.distance` for every range, radius and targeting ring. Reproducing
 * only one makes ranged talents feel wrong: a Chebyshev range 5 is a square that
 * reaches 7.07 tiles into the corners. Under the rounded length a range of 5
 * reaches (5,2) and (4,3) and stops short of (5,3) and (4,4).
 *
 * ═══ IT WAS THE UNROUNDED LENGTH, AND ITS NOTE SAID THAT WAS ToME ═══
 * `Math.sqrt(dx*dx + dy*dy)`, under a docblock reading "`core.fov.distance` —
 * EUCLIDEAN". The C rounds (`lua_fov_get_distance`; shared/distance.ts has the
 * derivation), so every band here was a sliver tighter than upstream's: the
 * Inspector refused a foe two diagonal steps away (2.83) that ToME calls 3 and
 * lets her shoot.
 *
 * ═══ ONE BODY, AND EVERY ATTACK-BAND READER GOES THROUGH IT ═══
 * `rangeRefusal` and `canAttack` below, the AI's kite band and dead-zone step
 * test (ai/npc.ts), `checkTargeting` (engine/talents.ts), the submission gate's
 * fallback (turn-engine.ts) and the inspect card (view/inspect.ts) all call this
 * function. That is the point of changing the body rather than the callers: an
 * AI band on one metric and a refusal on another is a kiter that stands in what
 * it thinks is its band while every shot is refused. The ONE caller that must
 * not ask this is `canRetreat` (ai/npc.ts), whose "is this step further away"
 * needs a length that moves on every step; it asks `euclidDistance` and says why.
 *
 * INTEGER-VALUED NOW. A caller that sorts on it or wants "strictly further"
 * sees ties it did not see before; each such caller was checked when the body
 * changed, and the retreat above is the only one that needed the exact length.
 */
export function combatDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return tileDistance(a, b);
}

/** The sheet, or ToME's defaults for every field it omits. */
function sheetOf(actor: CombatActor): CombatSheet {
  return actor.combat ?? DEFAULT_SHEET;
}

/**
 * Legality — Combat.lua has no single equivalent because ToME checks reach at
 * the talent/AI layer, so this is assembled from the constraints the game design
 * actually imposes.
 *
 * Checked at RESOLUTION, not at submission (docs/architecture.md § 2). An intent
 * that went illegal in between — the target died, someone was knocked out of
 * range — costs ZERO energy and re-prompts. That refund rule is what removes
 * hesitation from the turn, and it only works because this function is called
 * inside the loop rather than when the packet arrived.
 */
export function canAttack(
  attacker: CombatActor,
  target: CombatActor,
  world: CombatWorld,
): AttackRefusal | null {
  if (attacker.id === target.id) return AttackRefusal.Self;
  if (!attacker.alive) return AttackRefusal.Dead;
  if (!target.alive) return AttackRefusal.TargetDead;

  const outOfBand = rangeRefusal(attacker, target);
  if (outOfBand !== null) return outOfBand;

  // Melee needs no sight check — you are standing on them. Anything with reach
  // does, or it shoots through the wall it is standing behind.
  const clear =
    world.lineClearFor?.(attacker, target) ?? hasLineOfSight(world.level, attacker, target);
  if (combatDistance(attacker, target) > 1 && !clear) {
    return AttackRefusal.NoLineOfSight;
  }

  return null;
}

/**
 * THE BAND, AND NOTHING ELSE: too far, too close, or fine.
 *
 * Split out of `canAttack` so that `ai/npc.ts` can ask EXACTLY the question the
 * legality check will ask, from a context that holds no level and therefore
 * cannot answer the sight half. That is not a convenience — a monster whose AI
 * band is wider than `canAttack`'s submits an attack that is refused every
 * single turn, and a refused monster intent costs the turn and emits a `blocked`
 * sweep step. From outside it reads as an AI freeze rather than as a range bug,
 * forever, with nothing failing anywhere.
 *
 * The sight clause is asked separately, as `AiCtx.lineClear` (ai/npc.ts). It
 * used to be skipped because `visibleEnemies` (the scheduler's) only handed
 * the AI targets it had a clear line to; since monster sight is ToME's
 * shadowcast it hands over bodies past a pillar that this line cannot reach.
 *
 * @param target anything with a position. It does NOT have to be an actor: the
 * dead-zone half is also how a kiter tests a tile it is considering stepping on.
 */
export function rangeRefusal(
  attacker: CombatActor,
  target: { readonly x: number; readonly y: number },
): AttackRefusal | null {
  const sheet = sheetOf(attacker);
  // `attackRange` IS READ HERE ON THE ROUNDED LENGTH, as the
  // `core.fov.distance` radius below, and only when the sheet names no
  // `range`. Its other readers take it as Chebyshev: `resolveGuardCounter`
  // and the orb's flight limit (the note on `EngineActor.attackRange`,
  // engine/actor.ts, names all three). The two metrics agree at 1 — a diagonal
  // rounds to 1 — and the floor at `MELEE_REACH` is what made this agree back
  // when it was the unrounded length, under which a raw 1 refused all four
  // diagonals. Read that constant's note. `Math.max` and not a blanket 1.5: a
  // ranged fixture that sets only `attackRange: 5` keeps the five tiles it
  // asked for.
  const reach = sheet.range ?? Math.max(attacker.attackRange ?? 1, MELEE_REACH);
  const minRange = sheet.minRange ?? 0;
  const distance = combatDistance(attacker, target);

  if (distance > reach) return AttackRefusal.OutOfRange;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A GUN IN CONTACT IS A FIST, AND A FIST IS NEVER REFUSED.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * tome/class/interface/Combat.lua:221-231. `barehandAt`'s note has the whole
   * argument; the short version is that upstream has NO minimum range on any
   * archery talent and no way to be refused at contact — the melee loop skips
   * the bow and the fall-through punches for `dam = 1`.
   *
   * THIS LINE IS WHY THE INSPECTOR WAS UNPLAYABLE. Measured at HEAD: `bumped: 0`
   * in every run ever taken of her, at every site, at every level, because the
   * dead zone refused the one action a body in a doorway has. 0/12 on the intro
   * floor at level 1 against a strictly WEAKER body (the Alchemist: 54hp to her
   * 60, 0 defence to her 4, the same reach, the same zero armour) going 12/12.
   *
   * ═══ AND THE DEAD ZONE ITSELF IS UNTOUCHED, WHICH IS THE POINT ═══
   * `game-design.md` § 2 calls `min_range 3` "the single most important number
   * here: the Inspector CANNOT SHOOT ADJACENT", and she still cannot. The three
   * gun talents carry their own `minRange: 3` and are refused by
   * `checkTargeting`, not by this function. What comes back at contact is a
   * punch worth one point of base damage, and the tiles between `MELEE_REACH`
   * and `minRange` — too far to hit, too close to shoot — are still the hole the
   * class is built around.
   */
  if (barehandAt(sheet, distance)) return null;

  // THE DEAD ZONE. `<` not `<=`: min_range 3 means 3 is the closest LEGAL tile,
  // matching how the authored `min_range` reads in content/skills/*.json and how
  // the targeting ring's hole must be drawn.
  if (minRange > 0 && distance < minRange) return AttackRefusal.MinRange;

  return null;
}

/** Per-swing overrides: a talent's multiplier, damage type and bonus accuracy. */
export type AttackOpts = {
  /** Combat.lua:546. Sniper's Mark is 1.65, Ashwick Flare 1.3. */
  readonly mult?: number;
  /** Overrides the attacker's default (Combat.lua:396). */
  readonly damtype?: DamageType;
  /** Added to accuracy before the to-hit roll — Combat.lua:423, the Stalk shape. */
  readonly atkBonus?: number;
  /** Added to crit chance — `add_chance` at Combat.lua:1889. */
  readonly critBonus?: number;
  /**
   * Skip the reach / dead-zone / sight checks.
   *
   * For a caller that has already validated (the scheduler, which needs the
   * refusal as a refund reason before it commits). NOT a way to shoot through
   * walls: it means "I already asked".
   */
  readonly skipLegality?: boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS TALENT NAMES THE THING IT SWINGS — upstream's `attackTargetWith`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Combat.lua:380 takes a `combat` table as an ARGUMENT, and a talent that
   * calls it has chosen its weapon rather than letting the mainhand/offhand loop
   * choose: `Combat.lua:202` hands `o.special_combat` to it for a shield bash,
   * which is a swing with a thing the ordinary melee loop would never pick up.
   *
   * SO THE BAREHAND FALL-THROUGH DOES NOT APPLY. That fall-through is what
   * happens when the LOOP found nothing to swing (`if not speed`, :222); a
   * talent that named its weapon skipped the loop entirely.
   *
   * Exactly one talent needs it: Pistol Whip is the revolver used as a club, and
   * without this it would become a one-damage punch the moment `Weapon.archery`
   * landed on the Inspector's gun — which would delete the class's contact
   * answer in the same commit that gave it one.
   */
  readonly withWeapon?: boolean;
};

/**
 * ONE SWING — Combat.lua:380-608, condensed to the single-weapon case.
 *
 * ToME's `attackTarget` (:92) loops over every mainhand and offhand weapon and
 * calls `attackTargetWith` (:380) for each. The loop still has exactly one
 * iteration here and is still not written out — but the REASON changed, and the
 * old comment ("MVP has fixed loadouts, no inventory and no dual wielding") is
 * now false in its middle clause and must not be left to mislead.
 *
 * THERE IS AN INVENTORY. content/items.ts authors 22 items across seven worn
 * slots, `engine/equipment.ts` folds their `wielder` tables onto the actor's
 * sheet, and every number this function reads off `combat` — accuracy, damage,
 * apr, crit, and the defender's armour and defence — already includes them, for
 * free, because gear lands in the SHEET rather than in a second place this file
 * would have to consult.
 *
 * THERE IS STILL NO SECOND WEAPON, AND THAT IS NOW A DESIGN CHOICE RATHER THAN
 * AN ABSENCE. `Slot` has no MAINHAND and no OFFHAND WEAPON: the offhand holds a
 * buckler, a case file or a tome (content/items.ts), and a class's weapon is
 * part of its authored `CombatSheet` (content/classes.ts). The immediate reason
 * is that the art does not exist — `_aliases.json` claims four `item_*` weapon
 * ids resolve onto `icon_weapon_*` art and it is wrong (content/items.ts:53-57
 * names all four; no `icon_weapon_*` file is on disk or in the manifest), so
 * authoring one would ship a violet fallback box — and the standing reason is
 * that a second weapon means a second `atk`, a second `dam`, a second `damMod`
 * and ToME's whole off-hand penalty table: `Combat.lua:1791-1816`
 * (`_M:getOffHandMult`), applied by the off-hand weapon loop at
 * `Combat.lua:194-209` (`local offmult = self:getOffHandMult(o.combat, mult)`
 * at :200). Both re-verified in reference/t-engine4 at the lines given —
 * Combat.lua:105-121 is `attackTarget`'s `feared`/`terrified` guards and its
 * break-stealth block, and an earlier draft of this paragraph cited it here by
 * mistake. When dual-wielding lands, the loop wraps this function; nothing
 * inside it changes.
 *
 * RNG DISCIPLINE. A miss consumes exactly ONE draw (the to-hit d100) because
 * ToME's range roll lives inside the `if checkHit` branch at :511. A hit
 * consumes three: to-hit, damage range, crit. Every draw is labelled, so a
 * replay divergence names the stage it happened in.
 */
export function attackTarget(
  attacker: CombatActor,
  target: CombatActor,
  world: CombatWorld,
  rng: Rng,
  opts: AttackOpts = {},
): AttackResult {
  if (opts.skipLegality !== true) {
    const refusal = canAttack(attacker, target, world);
    if (refusal !== null) return { ok: false, reason: refusal };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FALL-THROUGH — tome/class/interface/Combat.lua:221-231.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `barehandAt` (above) says when. This is what upstream does when it happens:
   * `getObjectCombat(nil, "barehand")` returns the actor's own `self.combat`
   * table in place of the object's, and `attackTargetWith` is called with THAT.
   *
   * ONLY THE WEAPON BLOCK IS SWAPPED. `mods` — accuracy, armour penetration,
   * crit, every wielder fold — is the ACTOR's and upstream keeps all of it: a
   * gauntlet's `combat_apr` applies to a punch, which is the whole point of
   * `-- Ensures we have certain values for gloves to modify`
   * (tome/class/Actor.lua:286). Spreading the sheet and replacing one field is
   * exactly that split.
   */
  const worn = sheetOf(attacker);
  const self: CombatSheet =
    opts.withWeapon !== true && barehandAt(worn, combatDistance(attacker, target))
      ? { ...worn, weapon: BAREHAND }
      : worn;
  const foe = sheetOf(target);
  const type = opts.damtype ?? self.damageType ?? DamageType.Physical;

  // Combat.lua:417 — both already rescaled by their getters.
  const atk = combatAttack(self) + (opts.atkBonus ?? 0);
  const def = combatDefense(foe);

  // Combat.lua:505. One draw, always.
  const roll = checkHit(atk, def, rng, 'combat.checkhit');
  if (!roll.hit) {
    return {
      ok: true,
      targetId: target.id,
      hit: false,
      atk,
      def,
      chance: roll.chance,
      damage: 0,
      crit: false,
      killed: false,
      type,
      // A MISS LEAVES NOTHING. Upstream's brand loop is guarded by `hitted`, and
      // this is that guard: the field is named rather than spread in, so a new
      // required member of `AttackResult` is a compile error on every exit
      // instead of a silent zero on one of them.
      brandDamage: 0,
      // A MISS COSTS THE SAME AS A HIT — Combat.lua:677 returns the speed on
      // both. `self` is the sheet actually swung, fist included.
      speed: combatSpeed(self),
    };
  }

  // Combat.lua:439 + :506 + :510 — the inputs the ordered pipeline consumes.
  const outcome = applyDamage(target, combatDamage(self), type, attacker, rng, {
    damageRange: combatDamageRange(self),
    armour: combatArmor(foe),
    hardiness: combatArmorHardiness(foe),
    apr: combatAPR(self),
    // Combat.lua:544 guards this with `deflect == 0` — a fully parried blow
    // cannot crit. Parry is an M4+ effect; when it lands, the guard belongs
    // here, as an omitted `critChance`, not inside `rollCrit`.
    critChance: combatCrit(self, opts.critBonus ?? 0),
    critPower: combatCritPower(self),
    mult: opts.mult,
    // damage_types.lua:146-153 — the ATTACKER's debuffs, applied in the
    // projector rather than in any getter. Stunned is ×0.4 and Dazed ×0.5, and
    // Dazed ALSO halves accuracy inside `combatAttack` above; that double dip is
    // upstream's and is why Dazed reads as the more punishing of the two.
    // DAZED, STUNNED AND `numbed` ARE NO LONGER PASSED FROM HERE.
    // `applyDamage` reads all three off `source.combat`, which is this same
    // sheet — see its note. They were passed here and NOT from the talent, bleed
    // or projectile paths, which is how a stunned caster's talent came to deal
    // full damage while a stunned swing dealt 40%.
    increase: self.increase,
    penetration: self.penetration,
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT THE WEAPON LEAVES BEHIND — `melee_project`, Combat.lua:723-732.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *     if hitted and not target.dead then for typ, dam in pairs(self.melee_project) do
   *       if dam > 0 then DamageType:get(typ).projector(self, target.x, target.y, typ, dam) end
   *
   * THREE CLAUSES, ALL THREE PORTED:
   *
   *   `hitted`            — unreachable otherwise; the miss path returned above.
   *   `not target.dead`   — a corpse takes no brand. NOT "a brand cannot kill":
   *                         the guard asks whether the SWING already finished
   *                         them, and a brand that lands on a living target goes
   *                         through the same projector everything else does. So
   *                         `killed` below is an OR, and a fire brand finishing a
   *                         husk the swing left at 2hp is a real kill with a real
   *                         reaping.
   *
   *                         KEPT THOUGH IT IS CURRENTLY REDUNDANT, and measured
   *                         rather than assumed: `applyDamage` already refuses a
   *                         dead target (damage.ts:954) and a flat brand takes
   *                         no RNG draw doing it, so deleting this line changes
   *                         nothing observable today. It is upstream's shape, it
   *                         saves a call per corpse, and it is the line that
   *                         stops being free the day a brand gains a crit roll —
   *                         at which point `resolveDamage` would draw at :929,
   *                         BEFORE the alive check, and shift the stream.
   *   `if dam > 0`        — a zero entry is skipped rather than projected.
   *                         Redundant today for the same measured reason as the
   *                         clause above — `applyDamage` returns empty for a
   *                         non-positive amount and draws nothing — and kept for
   *                         the same reason: it is upstream's, and it is free.
   *
   * ═══ ITS OWN PIPELINE PASS, NOT A NUMBER ADDED TO THE SWING ═══
   * Each type is a separate `applyDamage`, so a fire brand meets fire resistance
   * independently of the physical blow that carried it. That is upstream's
   * `projector` call per type.
   *
   * ═══ NO CRIT, NO RANGE ROLL, AND — CORRECTED — NO ARMOUR ═══
   * The projector takes a flat `dam`. It is not a second swing: it does not
   * re-roll the damage band, it cannot crit, and IT DOES NOT MEET ARMOUR.
   *
   * The first port of this block passed `armour`, `hardiness` and `apr`, on the
   * stated reasoning that armour "is applied to it independently ... which is
   * the whole reason a brand is worth carrying against an armoured foe". The
   * conclusion was right and the code did the opposite of it. Upstream reads
   * `combat_armor` in exactly one function — `attackTargetWith`, at
   * Combat.lua:439, :506 and :540 — and `melee_project` (:723-732) never calls
   * it. It calls `DamageType:get(typ).projector` directly, and the default
   * projector (damage_types.lua:48) has no armour step: its one flat reduction
   * is `flat_damage_armor` at :404, a stat nothing in this game grants.
   *
   * The cost was `hardiness`% of every brand against every armoured body — up
   * to nine tenths of it against plate — and no test caught it because no
   * fixture in the suite had ever worn armour. `test/server/combat.test.ts`
   * now has one that does.
   *
   * `increase` and `penetration` DO apply and are still passed: both ARE in the
   * default projector (`src.inc_damage`, `src.resists_pen`), alongside the
   * target's resistance, which is the whole list of what a projector consults.
   *
   * DRAW ORDER: strictly after the swing's own draws, so a branded weapon
   * consumes a suffix of the RNG stream rather than shifting the roll that
   * produced it. Same rule the status riders in `engine/scheduler.ts` follow.
   */
  let brandDamage = 0;
  let killedByBrand = false;
  if (!outcome.killed) {
    for (const brandType of DAMAGE_TYPES) {
      // `TypeTable` admits `'all'` and a brand never uses it: upstream's
      // `melee_project` is keyed by real damage types only, and walking
      // `DAMAGE_TYPES` is what keeps an `all` entry from silently becoming a
      // ninth element nothing resists.
      const amount: number | undefined = self.brand?.[brandType];
      if (amount === undefined || amount <= 0) continue;
      if (killedByBrand) break;
      const burn = applyDamage(target, amount, brandType, attacker, rng, {
        increase: self.increase,
        penetration: self.penetration,
      });
      brandDamage += burn.dealt;
      if (burn.killed) killedByBrand = true;
    }
  }

  return {
    ok: true,
    targetId: target.id,
    hit: true,
    atk,
    def,
    chance: roll.chance,
    damage: outcome.dealt,
    crit: outcome.crit,
    killed: outcome.killed || killedByBrand,
    type,
    brandDamage,
    speed: combatSpeed(self),
  };
}
