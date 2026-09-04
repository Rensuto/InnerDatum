// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:116-160 ("Highborn's Bloom" —
//              `no_energy = true`, `getDuration = math.floor(combatTalentLimit(t, 10, 2, 6.1))`,
//              `cooldown = math.ceil(combatTalentLimit(t, 20, 47, 35))`, and an action that is
//              one `setEffect(EFF_HIGHBORN_S_BLOOM, …)`)
//   t-engine4 game/modules/tome/data/timed_effects/other.lua:1574-1580 (the effect —
//              "The target is using talents without consuming resources")
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HIGHBORN'S BLOOM. A window where your abilities cost you nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fourth talent of `race/higher` and the only thing in this game that
 * changes what a talent COSTS. `useTalent` has one payment site and it now reads
 * `StatusFlags.freeResources` there — the same shape `noTalentsCooldown` uses at
 * the one cooldown site, which is how an effect reaches the engine without
 * `engine/` learning what an effect is.
 *
 * ═══ THE RESOURCE, NOT THE TURN ═══
 * Upstream waives the resource and still spends energy. AP and MP here are the
 * TURN rather than a pool, so waiving them would let a body act without end —
 * this is a discount on the pool your class spends, and nothing else.
 *
 * ═══ AND IT DOES NOT MAKE ANYTHING AFFORDABLE ═══
 * *"Your resources must still be high enough to initially power the talent"*
 * (races.lua:157). The affordability check runs before the body and is
 * untouched; only the deduction is skipped. So this is a window to spend a pool
 * you are ABOUT to empty, not a way to cast from nothing — which is exactly why
 * upstream's own AI presses it when a resource is already low rather than when
 * it is gone.
 *
 * ═══ ONE TURN, AND THAT IS UPSTREAM'S RANK-1 NUMBER ═══
 * `getDuration` is `combatTalentLimit(t, 10, 2, 6.1)`, whose `low` is the value
 * at talent level 1 — two ToME actions, which is one of our turns. Against a
 * 24-turn cooldown that is deliberately a moment rather than a mode. Ours cannot
 * be raised past rank 1 for `higher_heal.ts`'s reason.
 */

import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
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

/**
 * `combatTalentLimit(t, 10, 2, 6.1)` at rank 1 — races.lua:149, in ToME actions.
 * Two of them is one of our turns.
 */
const TOME_DURATION = 2;

/** `combatTalentLimit(t, 20, 47, 35)` at rank 1 — races.lua:121. */
const TOME_COOLDOWN = 47;

const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/** `no_energy = true` (races.lua:120). The turn goes on around it. */
const AP_COST = 0;

export const highbornsBloom: Talent = {
  id: talentId('highborns_bloom'),
  name: "Highborn's Bloom",
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/higher',
  /**
   * TIER 3, WHERE UPSTREAM SAYS 4 — because the tier below it is not ported.
   *
   * `shared/tiers.ts` gates a tier-N talent on there being N-1 others in its
   * tree, which is a DEPTH rule: you earn the deep one by having gone deep. With
   * Born into Magic absent this tree is three talents, so a tier 4 here could
   * never be reached by anybody and `talent-tiers.test.ts` says so outright.
   *
   * The ORDER is upstream's and that is what the tier is really for: this is
   * still the last thing in the tree.
   */
  tier: 3,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_highborns_bloom',
  /** ONE RANK — see `higher_heal.ts` and the tripwire in `talent-trees.test.ts`. */
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
  /** Required by the type and never rolled: this one spends nothing. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /**
     * REFUSES WHILE IT IS ALREADY RUNNING. Upstream has no `on_pre_use` here
     * because its duration is longer than one turn at every rank; ours is ONE
     * turn at rank 1, so a second press inside the window would spend the whole
     * 24-turn cooldown to refresh a window that was about to end anyway.
     *
     * The same `StackMode.Refresh` trap the two regenerations have, arrived at
     * from the other direction — and the seam to answer it already exists.
     */
    if (ctx.hasStatus?.(self, EffectId.HighbornsBloom) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    const landed = ctx.status?.(self, EffectId.HighbornsBloom, DURATION_TURNS, {
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`${self.name} lets something older do the paying.`]);
  },

  describe: () =>
    `For ${String(DURATION_TURNS)} turn, your talents cost no resource — though you must ` +
    `still have enough to begin one. Costs no time at all. ` +
    `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`,
};
