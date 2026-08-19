// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/weaponshield.lua:297
//          Shield Expertise -- `getPhysical = combatTalentScale(t, 5, 20, 0.75)`.
// CUT:     its paired second save at :298 is NOT ported.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * Seen Worse -- the Watchman, in The Line.
 *
 * "Screaming, fire, threats. Filed on all three. You do not flinch."
 *
 * THE SECOND SAVE WAS CUT FOR SOFT PLACES' REASON. `weaponshield.lua:298`
 * pairs the physical save with a second channel, and the obvious reading here is
 * `mentalResist`. It would be INERT, and `content/effects.ts` says so in its own
 * words: the mental and magical channels "exist in `SaveChannel` and are
 * exercised by tests; nothing authored uses them yet".
 *
 * A resistance to a channel no content produces can only ever be decoration. It
 * goes in the day something authored swings at the nerve rather than the body,
 * and the citation is already sitting here for whoever does that.
 *
 * IT HAS NO `onUse`, AND THAT IS THE DECLARATION. See `Talent.onUse` -- the
 * absent body IS `mode = "passive"`.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** ToME's physical-save band, verbatim -- weaponshield.lua:297. */
const RESIST_LOW = 5;
const RESIST_HIGH = 20;
const CURVE = 0.75;

/** Physical resistance at a rank. */
export function physResistAt(level: number): number {
  return Math.round(combatTalentScale(level, RESIST_LOW, RESIST_HIGH, CURVE));
}

export const seenWorse: Talent = {
  id: 'talent:seen_worse',
  name: 'Seen Worse',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_seen_worse',
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

  passive: (level) => ({ mods: { physResist: physResistAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(physResistAt(level))} better at shrugging off what the body feels.`,
};
