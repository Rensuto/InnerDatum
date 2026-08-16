// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/lockdown.json
//          (ap_cost 5, range 1, damage_multiplier 1.0,
//           effects: [{ type: "debuff_ap", value: 2 }])
// SHAPE:   t-engine4 game/modules/tome/data/talents/gifts/summon-utility.lua:21-40
//          (Taunt: `cooldown = 5`, `a:setTarget(self)`)
//          t-engine4 game/modules/tome/class/Actor.lua:5863 (energy is what a
//          monster's action actually costs — see the debuff_ap note below)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * LOCKDOWN — the Watchman's ally utility. It takes a turn away from something
 * and points it at you.
 *
 * "A crushing tackle that pins the target and disrupts their rhythm — a
 * Watchman's favourite, when no one is looking."
 *
 * ═══ `debuff_ap: 2` AGAINST SOMETHING THAT HAS NO AP ═══
 * The authored effect strips two action points. Monsters do not have action
 * points: engine/actor.ts's player/monster asymmetry gives players a flat
 * ENERGY_TO_ACT per action plus a 6-AP intra-turn budget, and gives monsters
 * ToME's full variable-speed model on the act clock instead.
 *
 * So "two AP" is converted into the currency the target actually spends:
 * `ENERGY_TO_ACT * 2 / 6` — a third of a turn — subtracted from its ACT clock
 * by `drainActionBudget`. The visible effect is what the name promises: the
 * thing you tackled acts later than it was going to.
 *
 * ═══ IT MUST NOT TOUCH `energyBase` ═══
 * `drainActionBudget` writes the act clock only. Draining the BASE clock would
 * shorten the target's cooldowns and status durations, which is the same class
 * of bug as letting haste do it and is invisible until balance feels wrong
 * (game-design.md § 3's "single most important invariant").
 *
 * ═══ WHY THIS IS THE *ALLY* SLOT ═══
 * game-design.md § 2 files this under ally utility, which reads oddly for a
 * tackle until you count turns: a monster that does not act is a monster that
 * did not attack the Inspector. Stripping an action budget protects whoever it
 * was walking toward, and pointing it at the Watchman finishes the job.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentEffect,
  TalentRefusal,
  TargetShape,
  drainActionBudget,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. 5 of 6 AP — the tackle is the round. See Iron Curtain's note. */
const AP_COST = 5;
/**
 * FROZEN, and it is the most expensive thing a Watchman can buy. Lockdown and
 * Iron Curtain together are 55 Resolve, which is more than the bar holds at
 * once, so the Watchman is always choosing between the guard and the tackle
 * rather than doing both. A cost that fell with rank would delete that choice.
 */
const RESOLVE_COST = 30;
/**
 * MELEE REACH — 1.5, NOT 1, AND THE ARITHMETIC IS THE WHOLE JUSTIFICATION.
 *
 * `checkTargeting` (engine/talents.ts) and `submitTalent` (turn-engine.ts) both
 * measure with `combatDistance`, which is EUCLIDEAN — `core.fov.distance`. The
 * four diagonal neighbours sit at √2 = 1.4142…, so a range of exactly 1 refuses
 * every one of them: a Watchman standing corner-to-corner with a husk is told
 * OutOfRange on a talent whose whole point is that he is standing on it. 1.5 is
 * the only round number between √2 and the nearest non-neighbour at 2.0, so a
 * circle of that radius holds exactly the eight tiles around you.
 *
 * Imported rather than written as 1.5, because a second literal somewhere else
 * is a second definition of what melee means (engine/combat.ts `MELEE_REACH`).
 */
const RANGE = MELEE_REACH;
/** `damage_multiplier: 1.0`. Unchanged at talent level 1. */
const DAMAGE_MULT_LOW = 1;
/**
 * TUNED HIGH, not ported. ToME's Taunt (the `SHAPE:` citation) deals no damage,
 * so there is nothing upstream to copy — the shape is the retarget, not a blow.
 *
 * 1.8 is deliberately IDENTICAL to Crude Blow's trained high, because the two
 * shipped identical at 1.0 and the difference between them is what you pay for:
 * this one costs 5 AP and 30 Resolve and comes with a stripped action and a
 * taunt. Giving it a bigger multiplier as well would make the at-will swing
 * pointless the moment the Watchman had Resolve in the bank; keeping them equal
 * means the tackle is bought for its CONTROL, which is the slot it fills.
 */
const DAMAGE_MULT_HIGH = 1.8;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

/**
 * `{ type: "debuff_ap", value: 2 }`. FROZEN, and this one is an INTEGER OUT OF
 * SIX.
 *
 * `drainActionBudget` converts it as `ENERGY_TO_ACT * AP_STRIPPED /
 * PLAYER_MAX_AP` — two of six is a third of a monster's turn. Scaled to 6 it
 * would delete a whole monster turn outright, which is not a stronger debuff
 * but a DIFFERENT MECHANIC: a stun, with none of the typed-save machinery
 * game-design.md § 7 says a stun needs (M4 owns that, and this file's header is
 * explicit that it is not the status system). Four of six would be a stun most
 * of the time and a debuff the rest, which is worse than either.
 *
 * The talent's rank is paid out in damage instead. See `DAMAGE_MULT_HIGH`.
 */
const AP_STRIPPED = 2;
/** The 6-AP round (game-design.md § 6, from `city_watchman.json`'s `max_ap`). */
const PLAYER_MAX_AP = 6;
/** ToME Taunt, summon-utility.lua:24 — `cooldown = 5` ToME actions. */
const TOME_COOLDOWN = 5;
/** How long the target stays fixed on the Watchman, in GAME TURNS. */
const TAUNT_TURNS = 3;

export const lockdown: Talent = {
  id: talentId('lockdown'),
  name: 'Lockdown',
  classId: ClassId.Watchman,
  iconId: 'icon_active_lockdown',
  cost: { ap: AP_COST, resource: RESOLVE_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });

    // A corpse has no rhythm left to disrupt. The swing above still consumed
    // its RNG draws, so the stream does not depend on whether it died first
    // (damage.ts makes the same guarantee for the same reason).
    if (!victim.alive) return talentDone([hit], [`${victim.name} is unfiled.`]);

    const drained = drainActionBudget(victim, AP_STRIPPED, PLAYER_MAX_AP);

    // The taunt half. `ai.targetId` is what src/server/ai/npc.ts reads, so this
    // is a real retarget and not a flag nobody consults.
    const ai = victim.ai;
    if (ai !== null && ai !== undefined) ai.targetId = self.id;
    ctx.engine.addEffect(victim.id, {
      kind: TalentEffect.Taunted,
      otherId: self.id,
      turns: TAUNT_TURNS,
      power: 0,
    });

    return talentDone(
      [hit],
      [
        `${victim.name} loses ${AP_STRIPPED} AP of momentum (${Math.round(drained)} energy).`,
        `${victim.name} turns on ${self.name}.`,
      ],
    );
  },

  describe: (_self, level) =>
    `Tackle an adjacent enemy for ${percent(damageMult(level))} weapon damage, strip ` +
    `${AP_STRIPPED} AP from its next turn and force it onto you for ${TAUNT_TURNS} turns. ` +
    `${AP_COST} AP, ${RESOLVE_COST} Resolve.`,
};
