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
 * elseif ... self:checkHit(atk, def) ... then                                 -- :505
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
 *    * speed)`), but DECISIONS.md § D1 pins a player action to exactly one turn
 *    and the scheduler's `spendTurn` is the only sanctioned spender. A second
 *    spender is how the party falls out of phase lock.
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
 * while this file measures in EUCLIDEAN because that is what ToME's
 * `core.fov.distance` is and what every range and radius in the game is measured
 * with (docs/tome-mechanics.md § 10). A Chebyshev range ring is a square; the
 * targeting UI draws a circle.
 *
 * Swapping the scheduler over was therefore ONE change, not two: the range check
 * and the resolution had to move together. Leaving `strike` on Chebyshev while
 * `attackTarget` refused on Euclidean produced attacks that passed the
 * scheduler's legality check and then quietly did nothing — and the first thing
 * that fell out of moving them together was that a Euclidean reach of exactly 1
 * refuses every diagonal melee swing in the game. Hence `MELEE_REACH`.
 */

import { checkHit } from '../../shared/checkhit.ts';
import { hasLineOfSight } from '../world/world.ts';
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
} from './derived.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { DamageProfile, TypeTable } from './damage.ts';
import type { Combatant } from './derived.ts';

/**
 * A combat sheet plus the damage-side profile.
 *
 * One object rather than two because every content template authors them
 * together and every call site needs both halves. M4's loader hangs one of these
 * off each actor as `actor.combat`.
 */
export type CombatSheet = Combatant & {
  /** Resistances, caps and flat reduction. Read when this actor is the TARGET. */
  readonly profile?: DamageProfile;
  /** `inc_damage` — additive damage bonuses. Read when this actor ATTACKS. */
  readonly increase?: TypeTable;
  /** `resists_pen` — resistance penetration. Read when this actor ATTACKS. */
  readonly penetration?: TypeTable;
  /** Reach, in Euclidean tiles. 1 is melee. */
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
    };

/** Everything a template can leave unsaid. */
const DEFAULT_SHEET: CombatSheet = {};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EUCLIDEAN RADIUS THAT EQUALS THE MOORE NEIGHBOURHOOD. 1.5, AND THE
 * ARITHMETIC IS THE WHOLE JUSTIFICATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   the four diagonal neighbours sit at √2 = 1.4142…
 *   the nearest NON-neighbour (two tiles orthogonally) sits at 2.0
 *   1.5 is the only round number between them
 *
 * So a circle of radius 1.5 contains exactly the eight tiles around you and
 * nothing else, which is what "melee" has to mean when the metric is Euclidean.
 * content/monsters.ts:210-220 states the same argument from the content side —
 * the √2 = 1.4142 two-metrics paragraph — and `validateTemplate`
 * (content/monsters.ts:1207, against its `DIAGONAL_STEP = Math.SQRT2` at
 * content/monsters.ts:1184) refuses any melee template whose `combat.range`
 * excludes the diagonal.
 *
 * ═══ WHY A CONSTANT AND NOT A LITERAL, AND WHY `Math.max` BELOW ═══
 * `EngineActor.attackRange` is CHEBYSHEV (engine/actor.ts:299-309): 1 means the
 * eight-neighbourhood, which is what makes bump-attack work on a diagonal.
 * Feeding that 1 into `canAttack` RAW, as a Euclidean radius, is precisely what
 * refuses every diagonal melee attack in the game — the swing passes the
 * scheduler and then quietly does nothing, which is the failure the wiring note
 * at the top of this file warns about. `Math.max(attackRange, MELEE_REACH)`
 * fixes every melee actor while leaving a ranged fixture that sets only
 * `attackRange: 5` with the reach it asked for.
 *
 * It is EXPORTED because the class sheets (content/classes.ts) and every melee
 * talent need the same number, and a second literal 1.5 somewhere else is a
 * second definition of what melee means.
 */
export const MELEE_REACH = 1.5;

/**
 * `core.fov.distance` — EUCLIDEAN.
 *
 * REIMPLEMENTED, not translated: `core.fov.*` is native C and absent from the
 * reference clone (docs/tome-mechanics.md § 10). ToME uses TWO metrics on
 * purpose — Chebyshev for A* step costs (`ENGINE/Astar.lua`, diagonals cost the
 * same as orthogonals) and Euclidean for every range, radius and targeting ring.
 * Reproducing only one makes ranged talents feel wrong: a Chebyshev range 5 is a
 * square that reaches 7.07 tiles into the corners.
 */
export function combatDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
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
  if (combatDistance(attacker, target) > 1 && !hasLineOfSight(world.level, attacker, target)) {
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
 * The AI is safe to skip the sight clause because `visibleEnemies` (the
 * scheduler's) only ever hands it targets it already has a clear line to.
 *
 * @param target anything with a position. It does NOT have to be an actor: the
 * dead-zone half is also how a kiter tests a tile it is considering stepping on.
 */
export function rangeRefusal(
  attacker: CombatActor,
  target: { readonly x: number; readonly y: number },
): AttackRefusal | null {
  const sheet = sheetOf(attacker);
  // `attackRange` IS CHEBYSHEV (engine/actor.ts:299-309) and this is a
  // EUCLIDEAN radius, so it is floored at `MELEE_REACH` rather than used raw —
  // read that constant's note, because a raw 1 here refuses all four diagonals.
  // `Math.max` and not a blanket 1.5: a ranged fixture that sets only
  // `attackRange: 5` keeps the five tiles it asked for.
  const reach = sheet.range ?? Math.max(attacker.attackRange ?? 1, MELEE_REACH);
  const minRange = sheet.minRange ?? 0;
  const distance = combatDistance(attacker, target);

  if (distance > reach) return AttackRefusal.OutOfRange;

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

  const self = sheetOf(attacker);
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
    sourceDazed: self.flags?.dazed,
    sourceStunned: self.flags?.stunned,
    increase: self.increase,
    penetration: self.penetration,
  });

  return {
    ok: true,
    targetId: target.id,
    hit: true,
    atk,
    def,
    chance: roll.chance,
    damage: outcome.dealt,
    crit: outcome.crit,
    killed: outcome.killed,
    type,
  };
}
