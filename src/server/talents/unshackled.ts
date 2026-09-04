// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:332-347 ("Unshackled" —
//              `mode = "passive"`, `getSave = combatTalentScale(t, 6, 25, 0.75)`, and
//              `passives` writing `combat_physresist` and `combat_mentalresist`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UNSHACKLED. Harder to hold down, and harder to talk round.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The second talent of `race/unfiled`. Two save channels, both of which already
 * existed — the cross-tier work added all three — so this is the smallest kind
 * of port there is: a passive returning the same block a worn item returns.
 *
 * ═══ THE TWO IT RAISES ARE THE TWO THAT ANSWER DISABLES ═══
 * Physical is what refuses a stun or a pin; Mental is what refuses confusion
 * and the mind talents. `Spell` is deliberately NOT among them — upstream's
 * Thaloren are a people the world's institutions never got hold of, not a people
 * resistant to magic, and adding the third would be an invention wearing a port's
 * citation.
 *
 * ═══ ONE RANK ═══
 * `points = 5` upstream and `getSave` climbs 6 → 25 across them. Capped at 1 for
 * `higher_heal.ts`'s reason, so the number below is `combatTalentScale(t, 6, 25,
 * 0.75)` at talent level 1, which is its `low` end.
 */

import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * SIX. `combatTalentScale(t, 6, 25, 0.75)` at talent level 1 — races.lua:337,
 * where the `low` end of a scale is its rank-1 value.
 *
 * FLAT SAVE POINTS, which go through `rescaleCombatStats` with everything else
 * in `save()` — so six here is not six on the character sheet at high stats, and
 * `archival-resilience.test.ts` explains why that is asserted as an identity.
 */
const SAVE_BONUS = 6;

export const unshackled: Talent = {
  id: talentId('unshackled'),
  name: 'Unshackled',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/unfiled',
  tier: 2,
  kind: TalentKind.Passive,
  /** Undrawn; `npm run art:needs` lists it and the panel draws a letter. */
  iconId: 'icon_passive_unshackled',
  /** ONE RANK — see the header, and the tripwire in `talent-trees.test.ts`. */
  maxLevel: 1,
  // A PASSIVE IS NEVER PRESSED, so every one of these is the shape the type
  // demands rather than a decision — `overseer_of_nations.ts` carries the
  // identical block for the identical reason.
  cost: { ap: 0 },
  cooldownTurns: 0,
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
   * `talentTemporaryValue(p, "combat_physresist", …)` and the same for
   * `combat_mentalresist` — races.lua:339-340. Two writes, one number, exactly
   * as upstream computes it once and spends it twice.
   */
  passive: () => ({ mods: { physResist: SAVE_BONUS, mentalResist: SAVE_BONUS } }),

  describe: () =>
    `Your physical and mental saves are each ${String(SAVE_BONUS)} higher. ` +
    `Nothing holds you for long.`,
};
