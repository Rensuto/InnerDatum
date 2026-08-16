// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/shield_bash.json
//          (ap_cost 2, range 1, target_shape single, damage_multiplier 0.8)
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/weaponshield.lua:23-45
//          (Shield Pummel: `cooldown = 6`, `range = 1`, a shield strike that
//           follows through) — cooldown converted, see below
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * WARD RUSH — the Watchman's signature, and the cheapest engage in the game.
 *
 * "Drive your buckler into the target with full body weight. Cheap in AP and
 * cheap in dignity — but it works."
 *
 * ═══ WHAT IT IS FOR ═══
 * game-design.md § 2: *"signature — the cheapest engage in the game; seizes
 * chokes."* At 2 AP it is the only talent a player can fire three times in one
 * round, and what it buys is not damage (0.8x, the lowest multiplier any
 * Watchman talent has) but GROUND: the target is shoved one tile and the
 * Watchman steps into the square it vacated.
 *
 * That single tile of forced movement is the entire co-op engine of this class.
 * The Inspector cannot shoot inside three tiles (game-design.md § 2), so
 * somebody has to own the doorway; Ward Rush is how the doorway changes hands.
 *
 * ═══ THE ORDER OF THE TWO MOVES IS LOAD-BEARING ═══
 * Shove first, THEN advance. Reverse it and the Watchman walks into an occupied
 * tile, `tryMove` refuses, and the talent silently becomes a weak attack. Both
 * moves go through `world.tryMove`, which is the only sanctioned position
 * writer, so neither can end up inside a wall.
 *
 * A shove that fails (the target's back is to a wall — which is exactly when
 * you wanted it) is NOT a refusal: the blow landed, and pinning something
 * against a wall is a legitimate outcome the log should say out loud.
 */

import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  knockback,
  stepToward,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 2;
/**
 * MELEE REACH — 1.5, NOT 1, AND THE ARITHMETIC IS THE WHOLE JUSTIFICATION.
 *
 * `checkTargeting` (engine/talents.ts) and `submitTalent` (turn-engine.ts) both
 * measure with `combatDistance`, which is EUCLIDEAN — `core.fov.distance`. The
 * four diagonal neighbours sit at √2 = 1.4142…, so a range of exactly 1 refuses
 * every one of them: a Watchman standing corner-to-corner with a husk is told
 * OutOfRange on a talent whose whole point is that he is standing on it. 1.5 is
 * the only round number between √2 and the nearest non-neighbour at 2.0, so a
 * circle of that radius holds exactly the eight tiles around you.
 *
 * Imported rather than written as 1.5, because a second literal somewhere else
 * is a second definition of what melee means (engine/combat.ts `MELEE_REACH`).
 */
const RANGE = MELEE_REACH;
/** `damage_multiplier: 0.8`. Deliberately the weakest hit in the kit. */
const DAMAGE_MULT = 0.8;
const KNOCKBACK_TILES = 1;
/** Shield Pummel, weaponshield.lua:30 — `cooldown = 6` ToME actions. */
const TOME_COOLDOWN = 6;

export const wardRush: Talent = {
  id: talentId('ward_rush'),
  name: 'Ward Rush',
  classId: ClassId.Watchman,
  iconId: 'icon_active_shield_bash',
  cost: { ap: AP_COST },
  // 6 ToME actions -> 3 Inner Datum turns (an Inner Datum turn holds ~2
  // actions from a 6 AP budget). See engine/talents.ts's cooldown header.
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: 0,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const origin = { x: self.x, y: self.y };
    const hit = talentAttack(ctx, self, victim, { mult: DAMAGE_MULT });

    // The vacated tile is wherever the victim was standing when the shove
    // started, so this is read before the knockback and not after.
    const vacated = { x: victim.x, y: victim.y };
    const shoved = knockback(ctx.world, victim, origin, KNOCKBACK_TILES);
    if (shoved === 0) {
      return talentDone([hit], [`${victim.name} is pinned and cannot be driven back.`]);
    }

    const advanced = stepToward(ctx.world, self, vacated, KNOCKBACK_TILES);
    const notes =
      advanced > 0
        ? [`${self.name} drives ${victim.name} back and takes the ground.`]
        : [`${victim.name} is driven back.`];
    return talentDone([hit], notes);
  },

  describe: () =>
    `Slam an adjacent enemy for ${percent(DAMAGE_MULT)} weapon damage, drive it back ` +
    `${KNOCKBACK_TILES} tile and step into the space. ${AP_COST} AP.`,
};
