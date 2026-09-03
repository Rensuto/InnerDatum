// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/warcries.lua
//          -- the warcry tree: control shouts that land on a save and do no
//          weapon damage.
// NUMBERS: authored. The shove is `knockback` at this game's own tile scale;
//          the slow is `SLOWED`, which already exists in the effect table.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * MOVE ALONG -- AUTHORITY, and the first thing in the game that is a voice
 * rather than a swing.
 *
 * "Right. Off you go."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE WATCHMAN HAD NINE TALENTS AND EVERY ONE OF THEM WAS A BLOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `watch/discipline` is hitting the thing in front of you and `watch/the-line`
 * is being hit instead of somebody else. Both are excellent and both answer the
 * same question, which is what to do about the body already in reach. Nothing
 * this class owned could change WHERE a fight was happening, and a class whose
 * whole job is holding a doorway ought to be able to decide who is standing in
 * it.
 *
 * ═══ IT DOES NO DAMAGE, AND THAT IS THE DESIGN ═══
 * Every control talent in this game so far is stapled to an attack -- Lockdown
 * tackles and stuns, Backdraft burns and shoves, Ward Rush closes and hits. The
 * pattern is fine and it has a cost: a control talent that also does damage is
 * always worth pressing, so it is never a decision. This one is worth pressing
 * only when the position is wrong, which makes reading the room the skill it
 * pays for. It is priced to match -- cheap in AP, cheap in Resolve.
 *
 * ═══ WHY WILLPOWER ═══
 * `watch/authority` is gated on Will and the other two Watchman trees are not,
 * which gives the class a third attribute worth raising and a genuinely
 * different build to raise it for. A shout lands because of who is shouting,
 * and upstream agrees: warcries check Willpower, not Strength.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  knockback,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. Cheap on purpose -- see the header on why this must stay optional. */
const AP_COST = 2;
const RESOLVE_COST = 1;
const COOLDOWN_TURNS = 2;

/** How far it shoves, at a rank. One tile at rank 1, three at the cap. */
const PUSH_LOW = 1;
const PUSH_HIGH = 3;
const CURVE = 0.75;

/** Tiles shoved, at a rank. */
export function pushTilesAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, PUSH_LOW, PUSH_HIGH, CURVE)));
}

/** How long it is slowed for afterwards, at a rank. */
const SLOW_LOW = 1;
const SLOW_HIGH = 4;

/** Turns of `SLOWED`, at a rank. */
export function slowTurnsAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, SLOW_LOW, SLOW_HIGH, CURVE)));
}

/**
 * WHAT THE LOG SAYS ABOUT THE SLOW. The same three-branch shape `stunLine` uses
 * in lockdown.ts, and shared with it in SPIRIT rather than in code: a common
 * helper would have to name every effect in the game, and the sentence a player
 * reads is part of what the talent IS.
 *
 * A PARTIAL SAVE IS ITS OWN LINE, because it is its own outcome — `setEffect`
 * SHORTENS rather than refusing, and "slowed 1 turn, not 4" is the difference
 * between a talent that failed and one that was resisted. A player who cannot
 * tell those apart cannot tell whether the answer is a bigger number or a
 * different talent.
 */
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

export const moveAlong: Talent = {
  id: talentId('move_along'),
  name: 'Move Along',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 1 of its tree. See `src/shared/tiers.ts`. */
  tier: 1,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_move_along',
  cost: { ap: AP_COST, resource: RESOLVE_COST },
  cooldownTurns: COOLDOWN_TURNS,
  targeting: {
    shape: TargetShape.Single,
    range: MELEE_REACH,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,
  scalesWith: { lands: TalentPower.Physical },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * THE SHOVE IS NOT GUARANTEED AND THE TALENT DOES NOT REFUSE WHEN IT FAILS.
     *
     * `knockback` walks one tile at a time and stops at the first blocked step,
     * so a body pinned against a wall moves nothing -- and that is a REAL
     * OUTCOME rather than an error. Refusing would refund the AP and turn this
     * into a free "is there room behind it?" probe, which is a worse talent and
     * a worse thing to have to explain. The slow still lands, so the turn was
     * not wasted; a Watchman who wanted the shove has learned to check the wall.
     */
    const shoved = knockback(ctx.world, victim, self, pushTilesAt(ctx.talentLevel));

    /**
     * AND THE SLOW LANDS ON A SAVE, like every other status in this game.
     * `ctx.status` absent is a fixture with no table, not an error -- the shove
     * above still happened, exactly as `Lockdown`'s tackle does.
     */
    const turns = slowTurnsAt(ctx.talentLevel);
    const landed = ctx.status?.(victim, EffectId.Slowed, turns, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });

    const lines =
      shoved > 0
        ? [`${victim.name} gives ${String(shoved)} ground.`]
        : [`${victim.name} has nowhere to go.`];
    lines.push(...slowLine(victim.name, turns, landed));

    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Shove an adjacent enemy up to ${String(pushTilesAt(level))} tiles back and slow it for ` +
    `${String(slowTurnsAt(level))} turns (physical save). No damage — this is about where the ` +
    `fight is happening. ${String(AP_COST)} AP, ${String(RESOLVE_COST)} Resolve.`,
};
