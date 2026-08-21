// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/archery-utility.lua
//          -- Crippling Shot: a shot whose point is what it leaves behind
//          rather than what it takes off.
// NUMBERS: authored. The slow is `SLOWED`, which already exists.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * LINE OF ENQUIRY -- METHOD.
 *
 * "You do not have to catch them. You have to be the reason they are slow."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THIS IS THE ANSWER TO A MEASURED PROBLEM, NOT A GUESSED ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/first-fight.mjs`, twenty-four openings per class: the Watchman wins
 * 24/24 in ten turns and the Alchemist 24/24 in six. THE INSPECTOR WINS 22/24
 * IN TWENTY-THREE, and the two it does not win are STALLS -- kiting something
 * it cannot kill fast enough, in a room too small to kite in.
 *
 * The class has damage at range (Marksmanship) and a way out (Fieldcraft) and
 * NOTHING THAT SLOWS THE THING DOWN. Every tool it owns is about what to do
 * once the gap exists; none of them is about keeping it. That is why the fight
 * takes twenty-three turns: the Inspector opens the range, the husk closes it,
 * and the loop runs until somebody's dice go cold.
 *
 * ═══ THE DAMAGE IS DELIBERATELY POOR ═══
 * Half of Revolver Shot. If this hit as hard as the reliable attack it would BE
 * the reliable attack, and the slow would be a rider nobody thought about. It
 * is priced so that pressing it is a choice to spend a turn on POSITION, which
 * is the decision the class was missing.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { INSPECTOR_MIN_RANGE } from './revolver_shot.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  percent,
  talentAttack,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. One shot of a six-AP round, leaving room to step afterwards. */
const AP_COST = 3;
const FOCUS_COST = 12;
const COOLDOWN_TURNS = 3;

/**
 * THE CLASS'S OWN NUMBERS, IMPORTED RATHER THAN RE-TYPED.
 *
 * `INSPECTOR_MIN_RANGE` is exported by revolver_shot.ts precisely so the dead
 * zone is one decision in one place — a second copy here would drift the day
 * anybody tuned it, and the symptom would be one talent in the class that works
 * closer than the rest.
 */
const RANGE = 6;

/** Half of Revolver Shot's, and the header says why. */
const DAMAGE_LOW = 0.4;
const DAMAGE_HIGH = 0.7;
const CURVE = 0.75;

/** Weapon-damage multiplier at a rank. */
export function damageMult(level: number): number {
  return combatTalentScale(level, DAMAGE_LOW, DAMAGE_HIGH, CURVE);
}

const SLOW_LOW = 2;
const SLOW_HIGH = 6;

/** Turns of `SLOWED` at a rank. */
export function slowTurnsAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, SLOW_LOW, SLOW_HIGH, CURVE)));
}

/** The three-branch log line. `move_along.ts` carries the argument. */
function slowLine(name: string, maximum: number, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} keeps its footing.`];
  }
  if (landed.dur < maximum) {
    const t = landed.dur === 1 ? '1 turn' : `${String(landed.dur)} turns`;
    return [`${name} saves — slowed ${t}, not ${String(maximum)}.`];
  }
  return [`${name} is slowed (${String(landed.dur)} turns).`];
}

export const lineOfEnquiry: Talent = {
  id: talentId('line_of_enquiry'),
  name: 'Line of Enquiry',
  classId: ClassId.Inspector,
  tree: 'index/method',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** method is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_line_of_enquiry',
  cost: { ap: AP_COST, resource: FOCUS_COST },
  cooldownTurns: COOLDOWN_TURNS,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    // THE DEAD ZONE IS THE CLASS'S, and it is kept here rather than dropped:
    // a talent that worked point-blank when the rest of the class does not
    // would be the one button an Inspector presses when cornered, which is the
    // opposite of what this tree is teaching.
    minRange: INSPECTOR_MIN_RANGE,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });

    // A corpse cannot be slowed. The shot above still took its RNG draws, so the
    // stream does not depend on whether it died first — `lockdown.ts` makes the
    // same guarantee for the same reason.
    if (!victim.alive) return talentDone([hit], [`${victim.name} is unfiled.`]);

    const turns = slowTurnsAt(ctx.talentLevel);
    const landed = ctx.status?.(victim, EffectId.Slowed, turns, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });

    return talentDone([hit], slowLine(victim.name, turns, landed));
  },

  describe: (_self, level) =>
    `Shoot for ${percent(damageMult(level))} weapon damage and slow it for ` +
    `${String(slowTurnsAt(level))} turns (physical save). The damage is poor on purpose — ` +
    `this is a turn spent on where the fight happens. ${String(AP_COST)} AP, ` +
    `${String(FOCUS_COST)} Focus.`,
};
