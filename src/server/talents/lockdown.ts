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
import { EffectId } from '../content/effects.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentEffect,
  TalentRefusal,
  TargetShape,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
  TalentKind,
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STUN THIS TALENT SPENT THREE MILESTONES NOT BEING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What stood here was `AP_STRIPPED = 2` — `{ type: "debuff_ap", value: 2 }`
 * from the donor content, an integer out of six, converted by
 * `drainActionBudget` as `ENERGY_TO_ACT * 2 / 6`: a third of a monster's turn.
 * Its note explained at length why it was not simply scaled to six:
 *
 * > Scaled to 6 it would delete a whole monster turn outright, which is not a
 * > stronger debuff but a DIFFERENT MECHANIC: a stun, with none of the
 * > typed-save machinery game-design.md § 7 says a stun needs (M4 owns that).
 * > Four of six would be a stun most of the time and a debuff the rest, which
 * > is worse than either.
 *
 * ONE STATED REASON, AND IT IS NOW SPENT. M4's machinery exists, is registered
 * in main.ts, and is threaded to this file as `ctx.status`. So the talent
 * becomes what its name always claimed.
 *
 * ═══ THE AP STRIP IS GONE, NOT STACKED ═══
 * A stun and a third of a turn's momentum are the same idea twice. Keeping both
 * would make one control talent worth two, and the strip was explicitly the
 * SUBSTITUTE for this, never a companion to it. What is left is damage, a stun
 * that has to get past a save, and the taunt.
 *
 * ═══ WHY A SAVE MAKES IT BETTER, NOT WEAKER ═══
 * The strip always landed for exactly the same amount, so the decision to press
 * it never depended on who was standing there. A typed save makes an
 * Overwritten Husk genuinely harder to lock down than an Index Husk — and, the
 * part worth having, a NARROW save SHORTENS the stun rather than erasing it
 * (Actor.lua:7004-7014). "Index Husk saves — stunned 1 turn, not 3" is a
 * different sentence from "nothing happened", and it is the sentence
 * game-design.md § 7 puts in its own sample Record to explain the subsystem.
 *
 * ═══ THE POWER IS THE WATCHMAN'S PHYSICAL POWER ═══
 * `combatPhysicalpower` (Combat.lua:1689-1733) — Strength through the same
 * rescale everything else uses, which ties the stun's reliability to the stat
 * the class already levels rather than to a number invented here. It is checked
 * against the victim's PHYSICAL save, because that is `STUNNED.type` and
 * Actor.lua:7002 reads the effect's own type when the caller names none.
 */
/**
 * ═══ AND IT IS FROZEN AT 2, WHICH IS THE SAME RULE THE STRIP OBEYED ═══
 * The note this replaced ended "the talent's rank is paid out in damage
 * instead", and that sentence outlived the mechanic it was written about.
 * test/server/talent-scaling.test.ts is an entire file enforcing it — "a rank
 * buys damage, never a discount or a solution" — and a stun that grew from two
 * turns to three with rank would be a rank buying a solution, which is the one
 * thing the doctrine names.
 *
 * WHAT DOES SCALE IS THE CASTER, not the talent: `applyPower` is
 * `combatPhysicalpower`, so a Watchman who put levels into Strength lands this
 * more often and for longer against the same husk. Reliability grows with the
 * CHARACTER and length is fixed by the TALENT, which keeps a rank-1 Lockdown a
 * real answer at level 20 rather than a slot you are obliged to top up.
 *
 * TWO AND NOT THREE because two is what a party can build a turn around. Three
 * turns of a monster at 40% damage with its cooldowns frozen, on a five-turn
 * cooldown, is close to taking a body off the board for its whole cycle.
 */
const STUN_TURNS = 2;
/** ToME Taunt, summon-utility.lua:24 — `cooldown = 5` ToME actions. */
const TOME_COOLDOWN = 5;
/** How long the target stays fixed on the Watchman, in GAME TURNS. */
const TAUNT_TURNS = 3;

/**
 * WHAT THE RECORD SAYS ABOUT THE STUN — the honest three-way.
 *
 * The entire reason for a partial save is that "it worked" and "it didn't" are
 * not the only two outcomes, so a log printing only those two throws the
 * mechanic away at the last step. Three sentences, one per real outcome:
 *
 *   landed whole      "Index Husk is stunned (3 turns)."
 *   the save bit      "Index Husk saves — stunned 1 turn, not 3."
 *   the save held      "Index Husk shrugs it off."
 *
 * The middle one is the sentence a player learns the system from, which is why
 * it is the one that names both numbers.
 */
function stunLine(name: string, maximum: number, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} shrugs it off.`];
  }
  if (landed.dur < maximum) {
    const turns = landed.dur === 1 ? '1 turn' : `${String(landed.dur)} turns`;
    return [`${name} saves — stunned ${turns}, not ${String(maximum)}.`];
  }
  return [`${name} is stunned (${String(landed.dur)} turns).`];
}

export const lockdown: Talent = {
  id: talentId('lockdown'),
  name: 'Lockdown',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** the-line is about CON. See `Talent.statGate`. */
  statGate: 'con',
  kind: TalentKind.Active,
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
  scalesWith: { damage: TalentPower.Weapon, lands: TalentPower.Physical },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });

    // A corpse has no rhythm left to disrupt. The swing above still consumed
    // its RNG draws, so the stream does not depend on whether it died first
    // (damage.ts makes the same guarantee for the same reason).
    if (!victim.alive) return talentDone([hit], [`${victim.name} is unfiled.`]);

    // ═══ THE STUN ═══
    // `ctx.status` absent is a fixture with no status table, not an error: the
    // tackle still hits and still taunts. Every seam in the talent layer reads
    // this way — see `TalentCallCtx.status`.
    const landed = ctx.status?.(victim, EffectId.Stunned, STUN_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });

    // The taunt half. `ai.targetId` is what src/server/ai/npc.ts reads, so this
    // is a real retarget and not a flag nobody consults.
    //
    // IT HAPPENS WHETHER OR NOT THE STUN DID. A victim that shrugged the stun
    // off is precisely the one you most want walking at the Watchman rather
    // than past him, and a talent whose halves fail together is a coin flip
    // instead of a decision.
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
      [...stunLine(victim.name, STUN_TURNS, landed), `${victim.name} turns on ${self.name}.`],
    );
  },

  describe: (_self, level) =>
    `Tackle an adjacent enemy for ${percent(damageMult(level))} weapon damage, stun it for ` +
    `${String(STUN_TURNS)} turns (physical save) and force it onto you for ` +
    `${TAUNT_TURNS} turns. ${AP_COST} AP, ${RESOLVE_COST} Resolve.`,
};
