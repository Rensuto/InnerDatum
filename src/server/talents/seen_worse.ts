// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/weaponshield.lua:297
//          Shield Expertise -- `getPhysical = combatTalentScale(t, 5, 20, 0.75)`.
// NUMBERS: the CURVE is upstream's; the BAND is not. Upstream pays 5..20 flat,
//          this pays 10..35 scaled by MISSING HEALTH -- see `gritAt`, which
//          states why a proportional talent needs the higher headline.
//          The 5..20 version shipped first and its `physResistAt` outlived it by
//          several commits, exported and called by nothing. Deleted rather than
//          kept "for reference": the citation above is the reference.
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

/** ToME's curve exponent, verbatim -- weaponshield.lua:297. The band is not; see the header. */
const CURVE = 0.75;

/** The grit band. Paid only in proportion to missing health. */
const GRIT_LOW = 10;
const GRIT_HIGH = 35;

/**
 * THE FULL VALUE, PAID ONLY AT DEATH'S DOOR.
 *
 * Scaled by MISSING health, so this figure is what a body on its last hit point
 * receives and a healthy one receives none of. The band is higher than the old
 * flat one precisely because it is almost never paid in full — a talent worth
 * its headline number at full health would be the flat talent again.
 */
export function gritAt(level: number): number {
  return Math.round(combatTalentScale(level, GRIT_LOW, GRIT_HIGH, CURVE));
}

export const seenWorse: Talent = {
  id: 'talent:seen_worse',
  name: 'Seen Worse',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** the-line is about CON. See `Talent.statGate`. */
  statGate: 'con',
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   IT GETS TRUER THE WORSE IT GETS. techniques/battle-tactics.lua:101-158.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A flat physical resistance before this, and STRICTLY DOMINATED by
   * Contingencies — same stat, same curve, larger figure. There was no argument
   * for ever taking it.
   *
   * Upstream's True Grit recomputes resistance from MISSING health every turn,
   * and that is the shape worth having: worth nothing at full health, worth
   * everything at the moment you are about to die. It rewards being hurt without
   * rewarding recklessness, because the only way to hold the bonus is to stay
   * hurt — and staying hurt is how you die.
   *
   * ═══ THE FOLD RUNS EVERY TURN, AND THAT IS THE ONLY REASON THIS WORKS ═══
   * Before the per-turn recompute this would have been frozen at whatever health
   * the character happened to be on when the point was spent — and it would have
   * LOOKED live, which is worse than being obviously flat. See `refreshPassives`.
   */
  passive: (level, view) => {
    const missing = 1 - view.hpFraction();
    const resist = Math.round(gritAt(level) * missing);
    return resist <= 0 ? {} : { mods: { physResist: resist } };
  },

  describe: (_self, level) =>
    `Always on. Up to ${String(gritAt(level))} physical resistance, in proportion to how ` +
    `much health you are missing. Nothing at full.`,
};
