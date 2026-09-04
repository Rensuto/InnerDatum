// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:311-330 ("Wrath of the Woods" —
//              `no_energy = true`, `cooldown = math.ceil(combatTalentLimit(t, 5, 45, 25))`,
//              `getPower = combatStatScale("wil", 11, 20)`, and an action that is one
//              `setEffect(EFF_ETERNAL_WRATH, 5, {power=...})`)
//   t-engine4 game/modules/tome/data/timed_effects/physical.lua:801-819 (the effect —
//              `inc_damage {all=power}` and `resists {all=power}`)
//   t-engine4 game/modules/tome/data/damage_types.lua:200-202 (`inc_damage.all` is SUMMED
//              with the typed row, not multiplied)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WRATH OF THE WOODS. Hit harder and take less, both by the same number.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first talent of `race/unfiled`, and the only talent in the game that
 * moves the offensive and defensive `all` rows at once. That symmetry is the
 * whole design: one number, spent twice, so the button is worth pressing
 * whether you are about to swing or about to be swung at.
 *
 * ═══ IT NEEDED A WRITER, NOT A READER ═══
 * `combatGetDamageIncrease` has read `tableAll(inc) + tableValue(inc, type)`
 * since damage.ts was written — the `all` row has always reached the damage
 * maths. Nothing could put a number in it. `Wielder.damageAll` is that writer,
 * and it is the third time this exact shape has turned up here: a correct
 * reader with no way to reach it.
 *
 * ═══ THE TWO ROWS DO NOT COMPOSE THE SAME WAY, AND IT IS NOT A BUG ═══
 * `resists.all` multiplies with the typed row (Combat.lua:2227-2228);
 * `inc_damage.all` SUMS with it (damage_types.lua:202). So a body that already
 * resists fire gets less than a flat +N there, while a body that already deals
 * bonus fire damage gets exactly +N. Upstream's asymmetry, ported as written.
 *
 * ═══ ONE RANK, LIKE EVERYTHING IN A RACIAL TREE HERE ═══
 * `points = 5` upstream. Capped at 1 for `higher_heal.ts`'s reason and pinned by
 * `talent-trees.test.ts`. Every number below is upstream's at talent level 1.
 */

import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
import { stat } from '../engine/derived.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { combatStatScale } from '../../shared/scale.ts';

/** `combatTalentLimit(t, 5, 45, 25)` at rank 1 — races.lua:317, in ToME turns. */
const TOME_COOLDOWN = 45;

/** `setEffect(…, 5, …)` — races.lua:322, in ToME turns. Three of ours. */
const TOME_DURATION = 5;

const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/**
 * `combatStatScale("wil", 11, 20)` — races.lua:318. Eleven per cent at
 * Willpower 10, twenty at Willpower 100.
 *
 * A PERCENTAGE, SPENT TWICE — once as damage dealt and once as damage refused.
 */
const POWER_AT_LOW_WIL = 11;
const POWER_AT_HIGH_WIL = 20;

const powerFor = (wil: number): number =>
  Math.round(combatStatScale(wil, POWER_AT_LOW_WIL, POWER_AT_HIGH_WIL));

/** `no_energy = true` (races.lua:316). The turn goes on around it. */
const AP_COST = 0;

export const wrathOfTheWoods: Talent = {
  id: talentId('wrath_of_the_woods'),
  name: 'Wrath of the Woods',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/unfiled',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_wrath_of_the_woods',
  /** ONE RANK — see the header, and the tripwire in `talent-trees.test.ts`. */
  maxLevel: 1,
  cost: { ap: AP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  /** Required by the type and never rolled: this one deals no damage itself. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /** REFUSES WHILE ALREADY RUNNING — `resilience_of_the_archived.ts`'s reason. */
    if (ctx.hasStatus?.(self, EffectId.EternalWrath) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    // `combatStatScale("wil", 11, 20)` — races.lua:318. Willpower and nothing else.
    const wil = stat(self.combat ?? {}, 'wil');

    /** Computed here and frozen — see `EffectParams.grants`. */
    const power = powerFor(wil);
    const landed = ctx.status?.(self, EffectId.EternalWrath, DURATION_TURNS, {
      power,
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`${self.name} draws on something that was never written down.`]);
  },

  describe: (self) => {
    const power = powerFor(stat(self?.combat ?? {}, 'wil'));
    return (
      `For ${String(DURATION_TURNS)} turns, deal ${String(power)}% more damage of every kind ` +
      `and take ${String(power)}% less. Scales with Willpower. Costs no time at all. ` +
      `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`
    );
  },
};
