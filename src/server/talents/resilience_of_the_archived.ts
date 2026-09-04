// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:451-478 ("Resilience of the
//              Dwarves" — `no_energy = true`,
//              `cooldown = math.ceil(combatTalentLimit(t, 8, 45, 25))`, and a `getParams`
//              of `armor = combatStatScale("con", 7, 25)`,
//              `armor_hardiness = combatTalentLimit(t, 40, 20, 35)`,
//              `physical = spell = combatStatScale("con", 12, 30, 0.75)`, applied as
//              `setEffect(EFF_DWARVEN_RESILIENCE, 8, params)`)
//   t-engine4 game/modules/tome/data/timed_effects/physical.lua:3524-3559 (the effect —
//              the SECOND of two declarations under that name; see `effects.ts`)
//   t-engine4 game/modules/tome/class/interface/Combat.lua:1545-1560 (`combatStatScale`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESILIENCE OF THE ARCHIVED. Your skin turns to stone for a moment.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first talent of `race/archived` and the only thing in this game that
 * raises four defensive channels in one press: armour, armour hardiness, and
 * both the physical and spell saves. Every one of those channels already
 * existed — worn gear and `braced.ts` write the first two, and the cross-tier
 * work added the saves — so this talent is a pure content port with no engine
 * change behind it. That is why it is the one ported first out of its tree.
 *
 * ═══ IT IS DEFENSIVE, WHICH IS RARE AMONG THE ORIGIN TALENTS ═══
 * The Indexed get a heal, sight and a resource holiday. This is the first racial
 * button that answers a blow that is ALREADY COMING, and it is the reason the
 * Archived pay the heaviest experience penalty in the game so far: a body that
 * can turn to stone on demand survives mistakes the others do not.
 *
 * ═══ THREE OF THE FOUR NUMBERS ARE CONSTITUTION'S, NOT THE TALENT'S ═══
 * Only hardiness comes off the talent curve. Armour and both saves run through
 * `combatStatScale` against CON, so this is a talent that grows all campaign
 * without ever being raised — which is exactly what a racial ability capped at
 * one rank needs in order to stay worth pressing at level 30.
 *
 * ═══ ONE RANK, LIKE EVERYTHING IN A RACIAL TREE HERE ═══
 * `points = 5` upstream. Ours is capped at 1 for `higher_heal.ts`'s reason — the
 * purse that would buy rank 2 is the wrong one until `isGenericTree` learns
 * about `race/` trees, and `talent-trees.test.ts` fails the day a raisable
 * talent lands in one. So every number below is upstream's at talent level 1.
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

/** `combatTalentLimit(t, 8, 45, 25)` at rank 1 — races.lua:457, in ToME turns. */
const TOME_COOLDOWN = 45;

/** `setEffect(…, 8, …)` — races.lua:470, in ToME turns. Four of ours. */
const TOME_DURATION = 8;

const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/**
 * `combatTalentLimit(t, 40, 20, 35)` at rank 1 — races.lua:462, where `low` is
 * the rank-1 value.
 *
 * PERCENTAGE POINTS, ADDED onto the base 30 that `armourHardinessOf` starts
 * from (Combat.lua:1336) — so this puts a pressed body at 50%, not at 20%. The
 * unit is the one `braced.ts` and every armour ego already write in.
 */
const HARDINESS_BONUS = 20;

/**
 * `combatStatScale("con", 7, 25)` — races.lua:461. The two ends of the armour
 * curve: 7 at Constitution 10, 25 at Constitution 100.
 */
const ARMOUR_AT_LOW_CON = 7;
const ARMOUR_AT_HIGH_CON = 25;

const armourFor = (con: number): number =>
  Math.round(combatStatScale(con, ARMOUR_AT_LOW_CON, ARMOUR_AT_HIGH_CON));

/**
 * `combatStatScale("con", 12, 30, 0.75)` — races.lua:463-464.
 *
 * BOTH SAVES TAKE THE SAME NUMBER, and upstream computes it twice rather than
 * once into two fields. Written once here; the two are not independently tunable
 * upstream either, so a shared helper is the honest shape.
 *
 * THE POWER IS 0.75, NOT THE 0.5 DEFAULT — a flatter curve than the armour's, so
 * the saves reward high Constitution more than the armour does.
 */
const SAVE_AT_LOW_CON = 12;
const SAVE_AT_HIGH_CON = 30;
const SAVE_CURVE_POWER = 0.75;

const saveFor = (con: number): number =>
  Math.round(combatStatScale(con, SAVE_AT_LOW_CON, SAVE_AT_HIGH_CON, SAVE_CURVE_POWER));

/** `no_energy = true` (races.lua:456). The turn goes on around it. */
const AP_COST = 0;

export const resilienceOfTheArchived: Talent = {
  id: talentId('resilience_of_the_archived'),
  /**
   * UPSTREAM IS "Resilience of the Dwarves" and this is the one racial talent
   * whose name could not survive the port: it names a people this world does not
   * have. `overseer_of_nations.ts` and `highborns_bloom.ts` kept theirs because
   * neither is a race word standing alone.
   */
  name: 'Resilience of the Archived',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/archived',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_resilience_of_the_archived',
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
    /**
     * REFUSES WHILE IT IS ALREADY RUNNING, for `highborns_bloom.ts`'s reason and
     * one sharper: `StackMode.Refresh` means a second press inside the window
     * silently RESTARTS a four-turn buff at the cost of a 23-turn cooldown. The
     * only case where that would be a gain is a body whose Constitution rose
     * mid-window, which cannot happen inside four turns.
     */
    if (ctx.hasStatus?.(self, EffectId.ArchivalResilience) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    // `combatStatScale("con", …)` — races.lua:461-464. All three read CON and
    // nothing else, at the moment of the press.
    const con = stat(self.combat ?? {}, 'con');

    /**
     * COMPUTED HERE AND FROZEN, which is upstream's shape: `getParams` runs at
     * the press and `activate` reads the stored numbers, never the stat. See
     * `EffectParams.grants` for why that distinction is load-bearing.
     */
    const landed = ctx.status?.(self, EffectId.ArchivalResilience, DURATION_TURNS, {
      grants: {
        armour: armourFor(con),
        armourHardiness: HARDINESS_BONUS,
        physResist: saveFor(con),
        spellResist: saveFor(con),
      },
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`${self.name} hardens against alteration.`]);
  },

  describe: (self) => {
    const con = stat(self?.combat ?? {}, 'con');
    return (
      `For ${String(DURATION_TURNS)} turns, gain ${String(armourFor(con))} armour, ` +
      `${String(HARDINESS_BONUS)}% armour hardiness, and ${String(saveFor(con))} to both your ` +
      `physical and spell saves. The armour and the saves scale with Constitution. ` +
      `Costs no time at all. ${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`
    );
  },
};
