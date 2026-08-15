// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/alchemic_vial.json
//          (ap_cost 5, range 4, target_shape CROSS, element fire,
//           damage_multiplier 0.95)
//          Outer Index content/abilities/alchemic_vial.json
//          (`cooldown_sec: 6.0` -> R2 -> 6 turns, "splashes in a ~2.6-tile radius")
// SHAPE:   t-engine4 game/modules/tome/data/talents/spells/explosives.lua:20-50
//          (Throw Bomb: `cooldown = 4`, a ball projector, `friendlyfire` off)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ALCHEMIC VIAL — the Alchemist's signature. The only AoE in the MVP.
 *
 * "Hurl a vial of volatile Ashwick brew. Whatever the apothecaries are mixing
 * this week, it burns."
 *
 * ═══ A CROSS, NOT A CIRCLE ═══
 * `target_shape: "cross"` is authored, and it is a better shape than a circle
 * for this game: five named tiles that a player can count at a glance on a
 * 40x40 grid, rather than a radius that has to be drawn to be understood. The
 * M3 targeting UI previews the exact five (PLAN.md's DoD: "shape preview"), so
 * a mis-thrown vial is the player's fault and reads as one.
 *
 * `abilities/alchemic_vial.json` donates a `radius_px: 84` (~2.6 tiles) from
 * the real-time game; it is NOT converted by R1 here, because R6 makes
 * `skills/` the mechanical authority and the authored turn-based shape is the
 * cross. The donor's contribution is its cooldown.
 *
 * ═══ PLAYER AoE DOES NOT DAMAGE ALLIES. EVER. ═══
 * game-design.md § 10, stated flatly: *"player AoE does **not** damage allies.
 * No PvP, ever."* `actorsInShape(..., Affinity.Hostile)` is where that is
 * enforced, and it filters by SIDE rather than by "is a player", so
 * monster-on-monster chains keep their friendly fire — `index_glut.json`
 * already declares `bomb_aoe_hits_enemies: true` and that is a headline tactic.
 *
 * ═══ ORDERING IS FIXED, NOT WHATEVER THE MAP HAPPENED TO RETURN ═══
 * `crossTiles` returns centre, N, E, S, W in that order, every time. Damage is
 * applied in that order, so the RNG draws happen in that order, so a replay
 * cannot diverge because two monsters swapped tiles. `actorAt` is a linear scan
 * over an insertion-ordered map, which would otherwise be a perfectly plausible
 * source of an unreproducible bug.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TargetShape,
  actorsInShape,
  crossTiles,
  secondsToTurns,
  talentBaseDamage,
  talentId,
  percent,
  talentDone,
  talentProject,
} from '../engine/talents.ts';
import type { Talent, TalentHit } from '../engine/talents.ts';

const AP_COST = 5;
const REAGENT_COST = 2;
const RANGE = 4;
/** `damage_multiplier: 0.95` — per target, which is why an AoE is worth 2 Reagents. */
const DAMAGE_MULT = 0.95;
/** `content/abilities/alchemic_vial.json` — `cooldown_sec: 6.0`. R2 -> 6 turns. */
const COOLDOWN_SEC = 6;
/** The cross is centre + four orthogonals; the radius exists for the UI ring. */
const RADIUS = 1;

export const alchemicVial: Talent = {
  id: talentId('alchemic_vial'),
  name: 'Alchemic Vial',
  classId: ClassId.Alchemist,
  iconId: 'icon_active_alchemic_vial',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  cooldownTurns: secondsToTurns(COOLDOWN_SEC),
  targeting: {
    shape: TargetShape.Cross,
    range: RANGE,
    minRange: 0,
    radius: RADIUS,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Fire,

  onUse: (ctx, self, target) => {
    // The arm length is the SAME constant the wire sends as `radius`, so the
    // client's shape preview and the tiles that actually burn cannot disagree.
    const tiles = crossTiles(target, RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);

    // A vial thrown at an empty crossroads still burns, still costs its two
    // Reagents and still goes on cooldown. That is not a refusal: the player
    // made a positioning bet and lost it, which is a legible outcome. The
    // refund rule covers intents that went ILLEGAL, not intents that went bad.
    const base = talentBaseDamage(self);
    const hits: TalentHit[] = [];
    for (const victim of victims) {
      hits.push(talentProject(ctx, self, victim, base, DamageType.Fire, DAMAGE_MULT));
    }

    return talentDone(hits, [`Cross, radius ${RADIUS}. ${hits.length} caught.`]);
  },

  describe: () =>
    `Hurl a vial up to ${RANGE} tiles. Every enemy on the target tile and its four ` +
    `orthogonal neighbours takes ${percent(DAMAGE_MULT)} fire damage. Allies are never hit. ` +
    `${AP_COST} AP, ${REAGENT_COST} Reagents.`,
};
