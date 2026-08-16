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

const AP_COST = 5;
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
const DAMAGE_MULT = 1;
/** `{ type: "debuff_ap", value: 2 }`. */
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

    const hit = talentAttack(ctx, self, victim, { mult: DAMAGE_MULT });

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

  describe: () =>
    `Tackle an adjacent enemy for ${percent(DAMAGE_MULT)} weapon damage, strip ` +
    `${AP_STRIPPED} AP from its next turn and force it onto you for ${TAUNT_TURNS} turns. ` +
    `${AP_COST} AP, ${RESOLVE_COST} Resolve.`,
};
