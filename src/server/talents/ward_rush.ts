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

import { combatTalentScale } from '../../shared/scale.ts';
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
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * FROZEN AT 2, and it is the entire identity of the talent.
 *
 * game-design.md § 2 calls this "the cheapest engage in the game". 2 of 6 AP is
 * the only cost in the twelve that lets a player fire three times in one round;
 * at 3 it is Crude Blow with a shove and the Watchman loses his opening move.
 * A talent point buys damage, never a discount — a scaling cost would make the
 * spend path a rebate, and `canUseTalent` would stop being a pure predicate
 * over static data.
 */
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
/**
 * ═══ THE CONTRADICTION THIS FILE HAS CARRIED SINCE IT SHIPPED, RESOLVED ═══
 * The header cites TWO sources and they are not the same kind of source, which
 * was never said out loud until the curve landed:
 *
 *   SHAPE  — Shield Pummel, weaponshield.lua:23-45. A shield strike that
 *            follows through. It donates the STRUCTURE and the cooldown, and it
 *            is where "shove, then take the ground" comes from.
 *   LOW    — `content/skills/shield_bash.json`'s authored `damage_multiplier:
 *            0.8`. AUTHORED, not ported, and it WINS at talent level 1 because
 *            it is the shipped balance every existing test is pinned to.
 *   HIGH   — TUNED, not ported. Shield Pummel swings TWICE, at
 *            `combatTalentWeaponDamage(t, 1, 1.7)` and `(t, 1.2, 2.1)`
 *            (weaponshield.lua:50-51), on a different curve with a different
 *            base. Neither endpoint is ours and neither could be copied.
 *
 *            THIS BLOCK USED TO QUOTE `(t, 1, 1.5)` AT weaponshield.lua:33 and
 *            warn against "copying its 1.5 as our high" as coincidence dressed
 *            as provenance. That call does not exist: :33 is
 *            `is_special_melee = true`, and `grep -n combatTalentWeaponDamage`
 *            over the whole file returns 1/1.7, 1.2/2.1, 0.3/1, 0.8/1.3 and
 *            1/2.5 — there is no 1.5 anywhere in it. The argument is STRONGER
 *            for the correction, not weaker: since no upstream 1.5 exists, the
 *            coincidence it warned about was never even available.
 *
 * 1.5 is tuned against Crude Blow, which is the comparison a Watchman actually
 * makes: 0.8 vs 1.0 at rank 1 (80%) and 1.5 vs 1.8 at rank 5 (83%). The
 * signature stays the WEAKEST hit in the kit at every rank — you buy it for the
 * tile it takes, not the damage — while still being worth a point, because a
 * button pressed three times a round compounds faster than the ratio suggests.
 */
const DAMAGE_MULT_LOW = 0.8;
const DAMAGE_MULT_HIGH = 1.5;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

/**
 * FROZEN AT 1, and the header already argued it: "One tile is a lever; three is
 * a solution."
 *
 * Restated here beside the constant so a later reader sees it was considered
 * rather than missed. A knockback that grew with rank would let a trained
 * Watchman open the Inspector's three-tile dead zone with one button, from
 * melee, on a three-turn cooldown — which is the Alchemist's job (Backdraft,
 * which is likewise frozen at 1 for the same reason). It would also break the
 * talent's own second half: `stepToward` advances the Watchman exactly as far
 * as the victim went, so a 3-tile shove is a 3-tile lunge into whatever was
 * behind it.
 */
const KNOCKBACK_TILES = 1;
/** Shield Pummel, weaponshield.lua:30 — `cooldown = 6` ToME actions. */
const TOME_COOLDOWN = 6;

export const wardRush: Talent = {
  id: talentId('ward_rush'),
  name: 'Ward Rush',
  classId: ClassId.Watchman,
  tree: 'watch/discipline',
  /** Tier 3 of its tree. See `src/shared/tiers.ts`. */
  tier: 3,
  /** discipline is about STR. See `Talent.statGate`. */
  statGate: 'str',
  kind: TalentKind.Active,
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
    const hit = talentAttack(ctx, self, victim, { mult: damageMult(ctx.talentLevel) });

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

  describe: (_self, level) =>
    `Slam an adjacent enemy for ${percent(damageMult(level))} weapon damage, drive it back ` +
    `${KNOCKBACK_TILES} tile and step into the space. ${AP_COST} AP.`,
};
