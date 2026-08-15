// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/backdraft.json
//          (ap_cost 4, range 3, element fire, damage_multiplier 1.3,
//           effects: [{ type: "push", cells: 1 }])
//          Outer Index content/abilities/backdraft.json
//          (`cooldown_sec: 4.5` -> R2 -> 5 turns, `knockback_px: 96` = 3 tiles)
// SHAPE:   t-engine4 game/modules/tome/data/talents/spells/fire.lua (the fire
//          projector) + engine `knockback` semantics: shoved directly away from
//          the source, one tile at a time, stopping at the first blocked step
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * BACKDRAFT — the Alchemist's control button. Damage, and a shove.
 *
 * "A concentrated fire blast that scorches the target and shoves them back,
 * breaking up enemy formations."
 *
 * ═══ ONE TILE, NOT THREE ═══
 * The two sources disagree and the turn-based one wins. `skills/backdraft.json`
 * authors `{ type: "push", cells: 1 }`; `abilities/backdraft.json` authors
 * `knockback_px: 96`, which R1 (`toTiles(px) = round(px / 32)`) would convert
 * to 3. R6 settles it: *"`skills/` is the mechanical authority; `abilities/` is
 * a scaling-and-flavour donor only."*
 *
 * And the design agrees with the rule. On a 40x40 grid where the Inspector's
 * dead zone is three tiles, a three-tile shove would let the Alchemist hand out
 * a clean firing lane on demand, every five turns, from safety. One tile is a
 * lever; three is a solution. The donor still contributes its cooldown.
 *
 * ═══ WHAT IT IS ACTUALLY FOR ═══
 * game-design.md § 2: *"control — shoves things into hazards."* MVP has no
 * hazard tiles yet, so today the shove does three things that are already real:
 * it opens the Inspector's dead zone, it peels something off a Downed ally, and
 * it breaks a chokepoint the wrong way round. When hazards land the same one
 * tile becomes lethal and the number does not change.
 *
 * A shove that cannot happen — back to a wall, a body behind it — is NOT a
 * refusal. The blast landed; pinning something against a wall is an outcome.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  knockback,
  secondsToTurns,
  talentBaseDamage,
  talentId,
  percent,
  talentDone,
  talentProject,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 4;
const REAGENT_COST = 1;
const RANGE = 3;
/** `damage_multiplier: 1.3`. */
const DAMAGE_MULT = 1.3;
/** `{ type: "push", cells: 1 }`. See the header for why not 3. */
const PUSH_TILES = 1;
/** `content/abilities/backdraft.json` — `cooldown_sec: 4.5`. R2 rounds up: 5 turns. */
const COOLDOWN_SEC = 4.5;

export const backdraft: Talent = {
  id: talentId('backdraft'),
  name: 'Backdraft',
  classId: ClassId.Alchemist,
  iconId: 'icon_active_backdraft',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  cooldownTurns: secondsToTurns(COOLDOWN_SEC),
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Fire,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const origin = { x: self.x, y: self.y };
    const hit = talentProject(
      ctx,
      self,
      victim,
      talentBaseDamage(self),
      DamageType.Fire,
      DAMAGE_MULT,
    );

    // Corpses do not get shoved. `alive` is checked after the projector so the
    // damage draws happen either way and the RNG stream cannot depend on a
    // kill race (damage.ts makes the same guarantee).
    if (!victim.alive) return talentDone([hit], [`${victim.name} is unfiled.`]);

    const shoved = knockback(ctx.world, victim, origin, PUSH_TILES);
    return talentDone(
      [hit],
      shoved > 0
        ? [`${victim.name} is blown back ${shoved} tile.`]
        : [`${victim.name} is pinned against the wall.`],
    );
  },

  describe: () =>
    `Blast a target up to ${RANGE} tiles away for ${percent(DAMAGE_MULT)} fire damage and ` +
    `shove it ${PUSH_TILES} tile directly away from you. ${AP_COST} AP, ${REAGENT_COST} Reagent.`,
};
