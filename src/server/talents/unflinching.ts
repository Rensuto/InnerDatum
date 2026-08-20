// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/conditioning.lua:51-56 -- Unflinching Resolve,
//          a Constitution-scaled chance to shrug off an effect.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Unflinching -- GROUNDWORK, the category every class carries.
 *
 * "You have been shouted at by worse than this."
 *
 * THE PHYSICAL SAVE, WHICH IS WHAT `STUNNED` AND `SLOWED` ARE ROLLED
 * AGAINST. Upstream's version is a percentage chance to shed an effect after
 * it lands; this game has no shed-on-tick machinery, and the same intent is
 * expressed here as the save that stops it landing at all -- which is the
 * channel `EffectDef.type` already reads.
 *
 * IT MATTERS MORE NOW THAN IT WOULD HAVE LAST WEEK. Three talents in this
 * game apply `STUNNED` or `SLOWED` and monsters have them too. Field Dressing
 * is the Alchemist's answer AFTER one lands; this is everybody's answer
 * before it does, and a party should be able to buy either.
 *
 * NO CLASS, AND THAT IS THE POINT. `classId` is null here and on the tree: this
 * is true of a body rather than of a profession, which is what
 * `technique/combat-training` is upstream -- seven talents, seven passives, zero
 * buttons, carried by everyone.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** The house save band, matching Seen Worse and Contingencies. */
const LOW = 4;
const HIGH = 16;
const CURVE = 0.75;

/** Flat physical save at a rank. */
export function saveAt(level: number): number {
  return Math.round(combatTalentScale(level, LOW, HIGH, CURVE));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE HALF THAT IS NOT A NUMBER — THE FIRST BLOW OF EACH TURN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SMALLER BAND THAN THE SAVE ABOVE, ON PURPOSE. This fires against every
 * incoming damage type rather than against two status channels, and it fires
 * every single turn a fight lasts. A blunt worth as much as the save would be
 * worth several times the save.
 */
const BLUNT_LOW = 2;
const BLUNT_HIGH = 7;

/** How much the first blow of a turn is blunted, at a rank. */
export function bluntAt(level: number): number {
  return Math.round(combatTalentScale(level, BLUNT_LOW, BLUNT_HIGH, CURVE));
}

export const unflinching: Talent = {
  id: 'talent:unflinching',
  name: 'Unflinching',
  classId: null,
  tree: 'generic/groundwork',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_unflinching',
  // A PASSIVE COSTS NOTHING TO HAVE -- `cold_reading.ts` carries the whole note.
  cost: { ap: 0 },
  cooldownTurns: 0,
  /** Never aimed. See `cold_reading.ts` for the argument behind these fields. */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level) => ({ mods: { physResist: saveAt(level) } }),

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   THE FIRST TALENT IN THIS GAME THAT CHANGES A RULE RATHER THAN A NUMBER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It keeps its `passive` block above — a talent may carry both, and upstream
   * routinely does. The save is what Unflinching IS; this is what it DOES.
   *
   * ═══ WHY THE FIRST BLOW AND NOT ALL OF THEM ═══
   * A flat reduction on every blow is `physResist` with extra steps, and this
   * game already has eighteen of those. Blunting only the FIRST blow of each
   * turn is a different shape: it is worth most against one heavy attacker and
   * least against a crowd, which makes it a decision rather than a stat — the
   * Watchman holding a doorway wants it, and the same Watchman surrounded by
   * four husks would rather have armour.
   *
   * ═══ AND IT IS WHY THE LATCH HAD TO EXIST FIRST ═══
   * `procs.once` is what makes "first" mean anything. Without it this fires per
   * DAMAGE INSTANCE: twice for a two-hit talent, once per victim in an area
   * effect, and every turn a damage-over-time ticks. Every trigger-shaped
   * talent would then have to hand-limit itself, and they would not all
   * remember to. See engine/hooks.ts.
   *
   * THE KEY IS THE TALENT ID, not a shared word, so two blunting talents latch
   * independently and each gets its first blow.
   */
  hooks: {
    onTakeDamage: (ctx, incoming) => {
      if (!ctx.procs.once('talent:unflinching')) return;
      return { dam: Math.max(0, incoming.dam - bluntAt(ctx.level)) };
    },
  },

  describe: (_self, level) =>
    `Always on. ${String(saveAt(level))} harder to stun, slow or knock about, ` +
    `and the first blow against you each turn lands ${String(bluntAt(level))} lighter.`,
};
