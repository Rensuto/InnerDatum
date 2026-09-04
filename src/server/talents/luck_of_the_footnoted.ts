// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:553-577 ("Luck of the Little
//              Folk" — `no_energy = true`,
//              `cooldown = math.ceil(combatTalentLimit(t, 5, 45, 25))`, and a `getParams`
//              of `crit = save = combatStatScale("cun", 15, 60, 0.75)`, applied as
//              `setEffect(EFF_HALFLING_LUCK, 5, params)`)
//   t-engine4 game/modules/tome/data/timed_effects/mental.lua:1631-1647 (the effect —
//              `combat_generic_crit` and all THREE saves)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LUCK OF THE FOOTNOTED. A moment where everything goes your way.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first talent of `race/footnoted`, and the cleanest port in the racial
 * trees: every one of the four channels it writes already existed, so there is
 * no engine change behind it at all. `genericCrit` came in with the stat work
 * and the three saves came in with the cross-tier effects.
 *
 * ═══ ALL THREE SAVES, WHERE `unshackled.ts` RAISES TWO ═══
 * The Unfiled are hard to hold and hard to talk round; this is hard to do
 * ANYTHING to, and it is the only thing in the game that moves the spell save
 * and the mental save and the physical save at once. That breadth is what a
 * five-turn window with a twenty-three turn cooldown is paying for.
 *
 * ═══ ONE NUMBER FOR BOTH HALVES, AND IT IS CUNNING'S ═══
 * `getParams` computes `crit` and `save` from the same
 * `combatStatScale("cun", 15, 60, 0.75)` and stores them as two fields. Ours
 * computes it once — they are not independently tunable upstream either.
 *
 * ═══ ONE RANK ═══
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

/** `combatTalentLimit(t, 5, 45, 25)` at rank 1 — races.lua:559, in ToME turns. */
const TOME_COOLDOWN = 45;

/** `setEffect(…, 5, …)` — races.lua:568, in ToME turns. Three of ours. */
const TOME_DURATION = 5;

const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/**
 * `combatStatScale("cun", 15, 60, 0.75)` — races.lua:562-563. Fifteen at
 * Cunning 10, sixty at Cunning 100.
 *
 * SPENT TWICE, as a percentage of critical chance and as flat points on every
 * save. Upstream computes the same expression into two fields; there is one
 * here because two would be two things to keep in step for no gain.
 */
const AT_LOW_CUN = 15;
const AT_HIGH_CUN = 60;
const CURVE_POWER = 0.75;

const powerFor = (cun: number): number =>
  Math.round(combatStatScale(cun, AT_LOW_CUN, AT_HIGH_CUN, CURVE_POWER));

/** `no_energy = true` (races.lua:558). The turn goes on around it. */
const AP_COST = 0;

export const luckOfTheFootnoted: Talent = {
  id: talentId('luck_of_the_footnoted'),
  /**
   * UPSTREAM IS "Luck of the Little Folk". Renamed for
   * `resilience_of_the_archived.ts`'s reason and by the same rule: the name
   * carries the PEOPLE, and this world's are the Footnoted. Talents whose names
   * carry no race word keep them — Overseer of Nations, Highborn's Bloom,
   * Unshackled, Wrath of the Woods all did.
   */
  name: 'Luck of the Footnoted',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/footnoted',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_luck_of_the_footnoted',
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
  /** Required by the type and never rolled: this one deals no damage. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /** REFUSES WHILE ALREADY RUNNING — `resilience_of_the_archived.ts`'s reason. */
    if (ctx.hasStatus?.(self, EffectId.FootnotedLuck) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    // `combatStatScale("cun", …)` — races.lua:562-563. Cunning and nothing else.
    const power = powerFor(stat(self.combat ?? {}, 'cun'));

    /** Computed here and frozen — see `EffectParams.grants`. */
    const landed = ctx.status?.(self, EffectId.FootnotedLuck, DURATION_TURNS, {
      grants: {
        genericCrit: power,
        physResist: power,
        spellResist: power,
        mentalResist: power,
      },
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`${self.name} finds the margin everyone else missed.`]);
  },

  describe: (self) => {
    const power = powerFor(stat(self?.combat ?? {}, 'cun'));
    return (
      `For ${String(DURATION_TURNS)} turns, gain ${String(power)}% critical chance and ` +
      `${String(power)} to all three saves. Scales with Cunning. Costs no time at all. ` +
      `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`
    );
  },
};
