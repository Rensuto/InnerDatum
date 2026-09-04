// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:61-88 ("Overseer of Nations" —
//              `mode = "passive"`, `getSight = math.floor(combatTalentScale(t, 1, 5, "log"))`,
//              and `passives` writing `talentTemporaryValue(p, "sight", …)` at :72)
//   t-engine4 game/modules/tome/class/Actor.lua:178 (`t.sight = t.sight or 10` — the MODULE's
//              default, which is why ten and not the engine's twenty)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OVERSEER OF NATIONS. The Indexed see further than anybody else.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The second talent of `race/higher` and the first thing in this game that
 * changes how far a body can see. `self.sight` is per-actor upstream and every
 * FOV call reads it; ours was the constant `DEFAULT_SIGHT_RADIUS` and nothing
 * else, so a scout and a shut-in had identical eyes. `CombatMods.sight` is the
 * channel and `sightRadiusOf` is what spends it.
 *
 * ═══ IT IS A THIRD OF UPSTREAM'S TALENT, AND THE OTHER TWO THIRDS ARE NAMED ═══
 * `passives` at :70-74 writes THREE values:
 *
 *   `sight`         ported, and the whole of this file.
 *   `blind_immune`  NOT PORTED — there is no blindness in this game. Not a
 *                   skipped clause but an unreachable one, the answer
 *                   `healing_infusion.ts` gives for upstream's poison: the day
 *                   a blind effect exists, this is where its immunity goes.
 *   `esight`        NOT PORTED. `infravision` is seeing living things through
 *                   walls, which needs a second FOV pass with different rules;
 *                   `canSee` is one circle and one line test, and a second kind
 *                   of sight is a system rather than a number.
 *
 * A PARTIAL PORT IS SAID OUT LOUD RATHER THAN QUIETLY SHIPPED, so the next
 * person reads a list of what is missing instead of measuring it.
 *
 * ═══ ONE RANK, LIKE EVERYTHING IN A RACIAL TREE HERE ═══
 * `points = 5` upstream and `getSight` climbs 1 → 5 across them. Ours is capped
 * at 1 for `higher_heal.ts`'s reason — the purse that would buy rank 2 is the
 * wrong one until `isGenericTree` learns about `race/` trees, and
 * `talent-trees.test.ts` fails the day a raisable talent lands in one. So the
 * number here is `combatTalentScale(t, 1, 5, "log")` at rank 1, which is 1.
 */

import { DamageType } from '../engine/damage.ts';
import { Affinity, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ONE TILE. `math.floor(combatTalentScale(t, 1, 5, "log"))` at talent level 1 —
 * races.lua:67, where the `low` end of a scale is its rank-1 value.
 *
 * SMALL AND STILL WORTH IT: sight is a RADIUS, so one tile further out is a ring
 * of about sixty more tiles, and in a fogged corridor it is the difference
 * between seeing the thing in the doorway and walking into it.
 */
const SIGHT_BONUS = 1;

export const overseerOfNations: Talent = {
  id: talentId('overseer_of_nations'),
  name: 'Overseer of Nations',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See `higher_heal.ts`. */
  classId: null,
  tree: 'race/higher',
  tier: 2,
  kind: TalentKind.Passive,
  /** Undrawn; `npm run art:needs` lists it and the panel draws a letter. */
  iconId: 'icon_passive_overseer_of_nations',
  /** ONE RANK — see the header, and the tripwire in `talent-trees.test.ts`. */
  maxLevel: 1,
  // A PASSIVE IS NEVER PRESSED, so every one of these is the shape the type
  // demands rather than a decision — `carrying_voice.ts` carries the identical
  // block for the identical reason.
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
   * `talentTemporaryValue(p, "sight", t.getSight(self, t))` — races.lua:72.
   *
   * THE SAME BLOCK A WORN ITEM RETURNS, which is what `EffectDef.wielder` and
   * `PassiveContribution` already are: `composeWielders` folds a passive exactly
   * as it folds gear, so a body wearing something that also granted sight would
   * get both. Upstream's `talentTemporaryValue` sums for the same reason.
   */
  passive: () => ({ mods: { sight: SIGHT_BONUS } }),

  describe: () =>
    `You see ${String(SIGHT_BONUS)} tile further than anyone else, in every direction.`,
};
