// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/cursed/gestures.lua:66-208
//   (Gesture of Pain: `mode = "sustained"`, `no_energy = true`, `canUseGestures`
//    at :20-40, `getBaseDamage` :75-77, `getStunChance` :103, `preAttack`
//    :104-111, `attack` :112-186)
//   t-engine4 game/modules/tome/class/interface/Combat.lua:164-173 -- the one
//   place it is reached from: BEFORE the weapon loop, in place of it.
//   t-engine4 game/modules/tome/class/interface/Combat.lua:2087-2092
//   (combatTalentMindDamage), :2056-2084 (combatMindpower), :2180-2204
//   (combatMentalResist)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   GESTURE OF PAIN — the Redactor stops swinging and starts insisting.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "You do not lay a hand on it. You simply decline to agree that it is well."
 *
 * ═══ IT IS NOT A BUFF. IT REPLACES THE BLOW. ═══
 * Combat.lua:164-173 sits ABOVE the mainhand loop, the offhand loop and the
 * barehand fall-through, and it sets `speed` — which is the flag every one of
 * those three tests with `if not speed`. So a body standing in this sustain
 * never reaches its weapon at all: the gesture IS the attack, once, and the
 * ordinary swing does not also happen.
 *
 * That is why this file exports a FUNCTION beside the talent. Ours is wired at
 * `scheduler.ts#strike`, which is the one basic-attack site in the process and
 * serves both the `Attack` intent and the move bump — the same seam
 * `markMultiplier` already rides.
 *
 * ═══ WHAT CHANGES WHEN IT IS UP, AND WHY IT IS WORTH A SLOT ═══
 * The Redactor's ordinary swing is `checkHit(accuracy, DEFENCE)` for Darkness
 * off a stylus. This is `checkHit(MINDPOWER, MENTAL SAVE)` for Mind damage off
 * nothing at all. Three things follow and all three are upstream's own words
 * (gestures.lua:201-208):
 *
 *   IT IGNORES ACCURACY AND DEFENCE ENTIRELY. A class with no `atk` on its
 *     sheet stops caring that it has none, and a dodging enemy stops dodging.
 *   IT IS ROLLED AGAINST THE SAVE THIS CLASS ALREADY ATTACKS. `combatMindpower`
 *     is 0.7 Wil + 0.4 Cun (Combat.lua:2076) — the exact two stats the Redactor
 *     is built out of, and the same power every mark in `ledger/redaction`
 *     already rolls with. The class's whole stat spread starts paying for its
 *     basic attack as well as its talents.
 *   AND IT STUNS. `getStunChance` is `combatTalentLimit(t, 50, 12, 20)` —
 *     12% at rank 1, approaching but never reaching 50. On a class whose only
 *     answer to something in contact was to walk away, a one-in-eight stun on
 *     the button she was pressing anyway is the difference between retreating
 *     and holding.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT COULD NOT CROSS, STATED RATHER THAN SUBSTITUTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE MINDSTAR TERMS ARE ZERO AND THE CODE FOR THEM IS NOT WRITTEN.
 *   `getBonusDamage` (:78-89) adds `(weapon.combat.dam or 1) * 2` per equipped
 *   mindstar and `getBonusCritical` (:90-102) adds each one's `physcrit`. This
 *   game has no mindstar — `Slot.Offhand` holds a buckler, a case file or a
 *   tome, and the Doomed's two `mossy mindstar`s (afflicted.lua:156-157) are
 *   ported as the CLASS weapon table rather than as items (see
 *   `birthKitFor`). Both terms are therefore structurally 0 and the ported
 *   `attack` below is the bare `getBaseDamage` band. The day a mindstar is
 *   authored, the two getters are four lines each and the citation is here.
 *
 * THE DUAL-MINDSTAR PROC PASS DID NOT CROSS EITHER (:158-180). It exists to run
 *   each mindstar's `special_on_hit` through `attackTargetHitProcs`, which is
 *   the same "no mindstars" fact one layer down. Ours therefore runs NO melee
 *   riders on a gesture at all — and that is correct rather than convenient:
 *   `wielder.melee_project` is a property of a WEAPON that was swung, and this
 *   blow does not swing one. `scheduler.ts#strike` skips the rider loop on a
 *   replaced blow for exactly that reason.
 *
 * `crossTierChance = 25` (:127) DID NOT CROSS AS A CHANCE ON THE DAMAGE.
 *   Upstream's MIND projection carries a 25% roll to inflict a cross-tier
 *   effect off the blow itself. Our cross-tier machinery
 *   (`engine/effects.ts#crossTierEffect`) fires from `setEffect` when an
 *   attacker's apply power outranks the defender's save on that channel — so
 *   the STUN below already routes through it, at its own power, with no roll.
 *   Wiring a second, damage-side entry point would be a new engine feature
 *   rather than a port of this talent.
 *
 * GLOOM WEAKNESS AND DISMAYED (:120-122, :131-133, :140-145) DID NOT CROSS.
 *   Both are effects from other Cursed trees this game does not have. The
 *   clauses are conditional on an effect being present; with no such effect the
 *   branches are unreachable, so their absence changes no number.
 *
 * GESTURE OF MALICE (:152-156) is the tier-2 talent of upstream's tree and is
 *   not ported. Its clause here is `if self:knowTalent(...)`, so it is dead
 *   weight rather than a missing rule.
 */

import { checkHit } from '../../shared/checkhit.ts';
import { combatTalentLimit, combatTalentMindDamage } from '../../shared/scale.ts';
import { DamageType, applyDamage } from '../engine/damage.ts';
import { TalentPower } from '../engine/derived.ts';
import {
  combatCrit,
  combatCritPower,
  combatMentalResist,
  combatMindpower,
  combatSpeed,
} from '../engine/derived.ts';
import { Slot } from '../content/items.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TargetShape,
  combatOf,
  talentId,
} from '../engine/talents.ts';
import { MELEE_REACH, combatDistance } from '../engine/combat.ts';
import type { AttackResult } from '../engine/combat.ts';
import type { StatusApply } from '../engine/effects.ts';
import type { Talent, TalentActor } from '../engine/talents.ts';
import type { EngineActor } from '../engine/actor.ts';
import type { Rng } from '../../shared/rng.ts';
import type { TileXY } from '../../shared/coords.ts';

/** The id, exported because three modules outside this file ask about it. */
export const GESTURE_OF_PAIN_ID = talentId('gesture_of_pain');

/**
 * `getBaseDamage` — `combatTalentMindDamage(t, 0, 130)`, gestures.lua:75-77.
 *
 * A BASE OF ZERO IS NOT A DAMAGE OF ZERO. The curve reads
 * `(base + mindpower) * …`, so `base = 0` means the whole figure is the
 * caster's mind power and nothing is granted for free — see
 * `combatTalentSpellDamage`'s own note on why `base`/`max` cannot be read as
 * "low" and "high".
 */
const MIND_BASE = 0;
const MIND_MAX = 130;

/** `rng.float(0.5, 1)` — gestures.lua:126. Half the band is always dealt. */
const SPREAD_FLOOR = 0.5;

/** `getStunChance` — `combatTalentLimit(t, 50, 12, 20)`, gestures.lua:103. */
const STUN_LIMIT = 50;
const STUN_LOW = 12;
const STUN_HIGH = 20;

/** `setEffect(target.EFF_STUNNED, 3, …)` — gestures.lua:149. */
const STUN_TURNS = 3;

const PERCENT = 100;

/**
 * `combatMindpower` FOR THE REDACTOR AS SHE IS BORN — `wil` 22, `cun` 20
 * (`REDACTOR.combat.stats`, content/classes.ts), through Combat.lua:2076's
 * `wil * 0.7 + cun * 0.4` and the rescale. Twenty-one.
 *
 * A LITERAL AND NOT A LOOKUP, because `content/classes.ts` imports THIS FILE to
 * put the talent on the Redactor's loadout: reading her stat block from here
 * closes the cycle and the server does not boot. `items.ts` documents the same
 * trap twice about `EffectId`. Used for the printed figure only — never by the
 * blow, which reads the real body.
 */
const BIRTH_MINDPOWER = 21;

/** What one gesture deals at a rank, against a caster of this mind power. */
export function gestureDamageAt(talentLevel: number, mindPower: number): number {
  return combatTalentMindDamage(talentLevel, MIND_BASE, MIND_MAX, mindPower);
}

/** The stun chance at a rank, as a percentage. */
export function stunChanceAt(talentLevel: number): number {
  return combatTalentLimit(talentLevel, STUN_LIMIT, STUN_LOW, STUN_HIGH);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   TWO FREE OR MINDSTAR-EQUIPPED HANDS — `canUseGestures`, gestures.lua:20-40.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream counts a hand as usable when its inventory slot is EMPTY or holds a
 * mindstar, and demands two of them. With no mindstar in this game the rule
 * reduces to exactly one clause — both hands empty — and it is a real price
 * rather than a formality: the moment a Redactor picks up a Service Baton or a
 * buckler, the gesture stops and her stylus comes back out.
 *
 * ═══ AND THAT IS THE DECISION THE TALENT IS FOR ═══
 * `preAttack` (:104-111) REFUSES the whole attack when the hands are full and
 * logs why. Ours cannot refuse — by the time `strike` runs the turn is
 * committed, and a refusal would cost the player their action for wearing a
 * shield. So a full hand falls THROUGH to the ordinary swing, which is what
 * upstream's `if not speed` chain would do if `preAttack` had merely declined
 * instead of returning false. Stated because it is a divergence: upstream tells
 * you off, we quietly swing.
 */
export function handsFreeForGestures(actor: EngineActor): boolean {
  const worn = 'equipped' in actor ? actor.equipped : undefined;
  return worn?.[Slot.Mainhand] === undefined && worn?.[Slot.Offhand] === undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AND AT CONTACT — WHICH IS WHERE `Combat:attackTarget` IS, AND ONLY THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Combat.lua:164-173` sits INSIDE `Combat:attackTarget`, above the mainhand
 * loop, the offhand loop and the barehand fall-through. Every one of those
 * three is `attackTargetWith` on a worn weapon, and a bow is skipped by name
 * (`if combat and not o.archery`, tome/class/interface/Combat.lua:181 and
 * :204) — so upstream reaches this hook by BUMPING and by nothing else. Its
 * own tooltip says so in the sentence that describes the mechanic: *"This
 * strike replaces your melee physical"* (gestures.lua:202).
 *
 * BOTH CITATIONS ARE WRITTEN OUT because this paragraph names two files and a
 * bare `:181` under it would mean whichever one the reader guessed. That is
 * the shape `check-citations.mjs` warns about one level up — *"a stale one is
 * worse than none: it looks like proof"* — and a line-range checker cannot
 * catch it, because both numbers are in range for both files.
 *
 * ═══ OURS IS NOT ONLY A MELEE SEAM, AND THAT IS WHY THIS EXISTS ═══
 * `scheduler.ts#strike` serves the bump AND `IntentKind.Attack`, and
 * `rangeRefusal` reads `sheet.range` — which for a Redactor is **6**
 * (`REDACTOR.combat.range`, her marking stylus). Without this clause the
 * stance converted her basic attack into a mind attack at SIX TILES. Driven,
 * against a husk three tiles away:
 *
 *     stance off  type darkness  atk 6   def 1  chance 63  damage 0
 *     stance on   type mind      atk 21  def 7  chance 85  damage 7.93
 *
 * A blow that ignores accuracy and defence, rolls against the mental save and
 * carries a three-turn stun, delivered from outside anything's reach. That is
 * not a port of a melee replacement; it is a new ranged attack.
 *
 * `MELEE_REACH` (engine/combat.ts:364) is 1.5 — this engine's "adjacent,
 * diagonals included" — and it is the same bound `barehandAt` uses to decide
 * that a bump is a punch rather than a shot. A target outside it FALLS THROUGH
 * to the ordinary swing, exactly as a full hand does: `strike` has already
 * committed the turn, and a refusal here would cost a player their action for
 * standing too far away from something they could plainly hit.
 */
export function withinGestureReach(attacker: TileXY, target: TileXY): boolean {
  return combatDistance(attacker, target) <= MELEE_REACH;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE BLOW — `attack`, gestures.lua:112-186, in the order upstream has it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the same `AttackResult` a weapon swing returns, so `strike` can
 * substitute it whole and every consumer downstream — the event, the Case Log
 * line, the alarm, the kill note — carries on unchanged.
 *
 * ═══ THE DRAWS, AND THEIR ORDER, ARE UPSTREAM'S ═══
 *   1. `gesture.checkhit`  the mind-vs-save roll (:125). ONE draw, always, and
 *                          a failure takes no others — upstream's damage roll
 *                          lives inside the `if checkHit` branch.
 *   2. `gesture.range`     `rng.float(0.5, 1)` (:126).
 *   3. the crit roll       inside `applyDamage`, which is where `mindCrit`
 *                          sits upstream.
 *   4. `gesture.stun`      `rng.percent(stunChance)` (:148), last, and only on
 *                          a blow that connected.
 */
export function gestureOfPainBlow(
  attacker: TalentActor,
  target: TalentActor,
  talentLevel: number,
  rng: Rng,
  /** The mark multiplier `strike` already resolved. 1 when nothing is marked. */
  mult: number,
  status: StatusApply | undefined,
): AttackResult {
  const mindPower = combatMindpower(combatOf(attacker));
  const save = combatMentalResist(combatOf(target));

  // gestures.lua:125 — `self:checkHit(mindpower, target:combatMentalResist())`.
  const roll = checkHit(mindPower, save, rng, 'gesture.checkhit');
  if (!roll.hit) {
    return {
      ok: true,
      targetId: target.id,
      hit: false,
      atk: mindPower,
      def: save,
      chance: roll.chance,
      damage: 0,
      crit: false,
      killed: false,
      type: DamageType.Mind,
      brandDamage: 0,
      // gestures.lua:185 — `return self:combatSpeed(), hit`, a miss included.
      speed: combatSpeed(combatOf(attacker)),
    };
  }

  // :126 — `baseDamage * rng.float(0.5, 1) + bonusDamage`. The bonus is the
  // mindstar term and is structurally 0 here; see the header.
  const spread = SPREAD_FLOOR + rng.nextFloat('gesture.range') * (1 - SPREAD_FLOOR);
  const outcome = applyDamage(
    target,
    gestureDamageAt(talentLevel, mindPower) * spread,
    DamageType.Mind,
    attacker,
    rng,
    {
      // `alwaysHit=true` (gestures.lua:127): the check at :125 above WAS the
      // mind-vs-save roll, so MIND's own must not roll it a second time.
      alwaysHit: true,
      // THE MARK STILL COUNTS. `strike` folds `markMultiplier` into every swing
      // and a replaced swing is still the Redactor hitting something she marked.
      ...(mult === 1 ? {} : { mult }),
      increase: combatOf(attacker).increase,
      penetration: combatOf(attacker).penetration,
      // `self:mindCrit(...)` (:126). One crit stat here — see `talentProject`.
      critChance: combatCrit(combatOf(attacker)),
      critPower: combatCritPower(combatOf(attacker)),
    },
  );

  // :147-150 — the stun, on a blow that landed, at the caster's own mind power.
  // `setEffect` is what asks `canBe` and what runs the cross-tier comparison.
  if (!outcome.killed && status !== undefined) {
    const chance = stunChanceAt(talentLevel);
    if (rng.int('gesture.stun', 1, PERCENT) <= chance) {
      status(target, 'effect:stunned', STUN_TURNS, {
        applyPower: mindPower,
        srcId: attacker.id,
      });
    }
  }

  return {
    ok: true,
    targetId: target.id,
    hit: true,
    atk: mindPower,
    def: save,
    chance: roll.chance,
    damage: outcome.dealt,
    crit: outcome.crit,
    killed: outcome.killed,
    type: DamageType.Mind,
    brandDamage: 0,
    // WHAT THE BLOW COSTS — gestures.lua:185, the body's own `combatSpeed`, which
    // `attackTarget` then charges exactly as it charges a weapon's.
    speed: combatSpeed(combatOf(attacker)),
  };
}

/**
 * THE SUSTAIN ITSELF. `mode = "sustained"`, `no_energy = true`, `hate` unset —
 * so it costs a press and nothing else, for ever.
 *
 * ═══ NO RESERVE, AND THAT IS UPSTREAM'S PRICE RATHER THAN A MISSING ONE ═══
 * `ledger_stances.ts` holds 20 Ink back while a stance is up, because that is
 * what a ToME stance does. Gesture of Pain's block carries no `sustain_hate`
 * and no `hate` cost at all: its price is `canUseGestures` — you are fighting
 * with both hands empty — and a second price on top would be ours, not theirs.
 *
 * NO `sustainSlot` EITHER. It does not share a slot with the ledger stances
 * upstream and must not here: a Redactor standing in Open Ledger AND gesturing
 * is a legal, intended build (`cursed/gestures` and the Doomed's other trees
 * stack freely), and making the two exclusive would be a balance decision
 * wearing a port's clothes.
 */
export const gestureOfPain: Talent = {
  id: GESTURE_OF_PAIN_ID,
  name: 'Gesture of Pain',
  classId: ClassId.Redactor,
  tree: 'ledger/unwritten',
  /** Tier 1 of its tree — `type = {"cursed/gestures", 1}`. See `src/shared/tiers.ts`. */
  tier: 1,
  /** `require = cursed_cun_req1` (gestures.lua:71). See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Sustained,
  iconId: 'icon_sustain_gesture_of_pain',
  // FREE TO PRESS — `no_energy = true` (:70). See `ledger_stances.ts` for the
  // argument that a stance pays in its reserve and pays nothing else.
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
  damageType: DamageType.Mind,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BOTH HALVES ARE MIND, AND THEY ARE THE SAME NUMBER — `combatMindpower`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `damage` is `combatTalentMindDamage`'s power term and `lands` is the
   * `applyPower` the stun is rolled at; this talent reads one getter for both,
   * which is unusual and is exactly what upstream does (gestures.lua:114,
   * :149). `talent-power.test.ts` checks the pair in both directions — a file
   * that rolls a power and declares none, and a file that declares one and
   * never rolls it — and this is what makes the panel's "Willpower, Cunning"
   * line true of the blow as well as of the stun.
   */
  scalesWith: { damage: TalentPower.Mind, lands: TalentPower.Mind },

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE DAMAGE FIGURE IS PINNED AT THE REDACTOR'S BIRTH SHEET, AS `indelible`'S IS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `describe` may not read the body. `content/classes.ts` says why where it
   * builds the card: *"Composed here rather than in each `describe` because the
   * weapon half is not a property of the talent at all"* — what makes a number
   * bigger is `scalesWith`'s job, and every other `describe` in this directory
   * takes `_self` for it.
   *
   * So the printed figure is `getBaseDamage` evaluated at `BIRTH_MINDPOWER`,
   * which is `combatMindpower` for the Redactor as she is born (`wil` 22,
   * `cun` 20 — `REDACTOR.combat.stats`). `indelible.ts` records the identical
   * gap in the identical words and for a harder reason (a hook cannot read a
   * stat at all). A player above birth hits harder than this says, and the
   * panel's power line is what tells them so.
   */
  describe: (_self, level) =>
    `A stance, free to hold. While it is up and both hands are empty your attacks ` +
    `on an adjacent foe ` +
    `become a gesture: ${String(Math.round(gestureDamageAt(level, BIRTH_MINDPOWER) * SPREAD_FLOOR))}` +
    `-${String(Math.round(gestureDamageAt(level, BIRTH_MINDPOWER)))} mind damage at a new ` +
    `Redactor's Mindpower, rolled against the target's mental save instead of its defence, ` +
    `with a ${String(Math.round(stunChanceAt(level)))}% chance to stun for ${String(STUN_TURNS)} turns.`,
};
