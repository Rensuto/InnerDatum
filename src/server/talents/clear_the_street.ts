// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/warcries.lua
//          -- Shattering Shout: a cone of force from the caster that pushes
//          rather than kills.
// NUMBERS: authored. The shove is `knockback` and the slow is `SLOWED`, both of
//          which already exist; the radius is `ballTiles`, as Alchemic Vial's
//          cross is `crossTiles`.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CLEAR THE STREET -- AUTHORITY, and the deepest thing in it.
 *
 * "EVERYBODY. BACK."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SECOND AREA TALENT IN THE GAME, AND THE FIRST THAT DOES NO DAMAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Alchemic Vial is the only other one, it belongs to the Alchemist, and it
 * kills things. This one moves them, and the difference is the whole reason to
 * own it: a Watchman surrounded has, until now, had exactly one answer -- stand
 * there and be surrounded, which his class is admittedly very good at. This is
 * the other answer, and it is the one that lets a party RESET a fight that has
 * gone wrong rather than grinding it out.
 *
 * ═══ CENTRED ON THE CASTER, NOT AIMED ═══
 * `TargetShape.Self` with a radius. Every other area talent in this game is
 * thrown somewhere; this one happens AROUND you, which is what makes it the
 * answer to being surrounded rather than a second way to open a fight. It also
 * means it cannot be aimed at a friend by accident, and `Affinity.Hostile` on
 * `actorsInShape` is what guarantees a party never shoves each other -- see
 * `alchemic_vial.ts`'s note on why that filter is not optional in a co-op game.
 *
 * ═══ IT IS EXPENSIVE AND ON A LONG COOLDOWN, AND THAT IS THE BALANCE ═══
 * Control that does no damage is easy to underprice, because it looks like it
 * does nothing. What it actually does is undo the single worst position a party
 * can be in, and that is worth more than a round of damage in the fights where
 * it matters. The cost is set so it is a fight-turning decision once, not a
 * rhythm.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TargetShape,
  actorsInShape,
  ballTiles,
  knockback,
  talentDone,
  talentId,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** FROZEN. A fight-turning decision once, not a rhythm. See the header. */
const AP_COST = 5;
const RESOLVE_COST = 4;
const COOLDOWN_TURNS = 8;

/** How far the shout reaches. Two tiles is everything in melee and one step out. */
const RADIUS = 2;

const PUSH_LOW = 2;
const PUSH_HIGH = 4;
const CURVE = 0.75;

/** Tiles everything is shoved, at a rank. */
export function pushTilesAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, PUSH_LOW, PUSH_HIGH, CURVE)));
}

const SLOW_LOW = 2;
const SLOW_HIGH = 5;

/** Turns of `SLOWED` on everything caught, at a rank. */
export function slowTurnsAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, SLOW_LOW, SLOW_HIGH, CURVE)));
}

/** One line per body, and a partial save is its own outcome. See `move_along.ts`. */
function line(name: string, shoved: number, landed: SetEffectResult | undefined): string {
  /**
   * ═══ `Immune` IS NOT THE ONLY WAY TO SHRUG SOMETHING OFF ═══
   *
   * This read `outcome === SetEffectOutcome.Immune` alone, which is the RARE
   * refusal — a body with an outright immunity. The common one is `Negated`:
   * the save roll came up saved (Actor.lua:7034-7037), which is what happens
   * every time an ordinary target makes an ordinary save. Those were reported as
   * slowed.
   *
   * `dur <= 0` rather than naming `Negated` too, because a PARTIAL save can
   * grind a duration down to nothing and "slowed for 0 turns" is the same
   * non-event wearing a third outcome code.
   *
   * Found by test/server/status-report-honesty.test.ts, which casts every talent
   * twice — once landing, once saved — and demands the two read differently. A
   * grep for `SetEffectOutcome` said this file was fine; it mentions the symbol
   * and used it wrong.
   */
  const resisted =
    landed === undefined || landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0;
  if (shoved <= 0 && resisted) return `${name} does not move.`;
  if (shoved <= 0) return `${name} is slowed but holds its ground.`;
  const ground = `${name} gives ${String(shoved)} ground`;
  return resisted ? `${ground}.` : `${ground} and is slowed.`;
}

export const clearTheStreet: Talent = {
  id: talentId('clear_the_street'),
  name: 'Clear the Street',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 4 of its tree — the deepest thing in it. See `src/shared/tiers.ts`. */
  tier: 4,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_clear_the_street',
  cost: { ap: AP_COST, resource: RESOLVE_COST },
  cooldownTurns: COOLDOWN_TURNS,
  targeting: {
    // CENTRED ON THE CASTER. See the header — this happens around you, which is
    // what makes it the answer to being surrounded.
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: RADIUS,
    requiresLos: false,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    // THE SAME CONSTANT THE WIRE SENDS AS `radius`, so the client's shape
    // preview and the tiles that are actually cleared cannot disagree —
    // `alchemic_vial.ts` makes the identical guarantee for the same reason.
    const tiles = ballTiles(self, RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);

    /**
     * A SHOUT INTO AN EMPTY STREET STILL COSTS ITS AP AND STILL GOES ON
     * COOLDOWN, exactly as a vial thrown at an empty crossroads does. That is
     * not a refusal — the player made a read and it was wrong, which is a
     * legible outcome. The refund rule covers intents that went ILLEGAL.
     */
    const push = pushTilesAt(ctx.talentLevel);
    const turns = slowTurnsAt(ctx.talentLevel);
    const power = combatPhysicalpower(self.combat ?? {});
    const lines: string[] = [];

    for (const victim of victims) {
      // SHOVED FIRST, THEN SLOWED. The order matters and it is the intuitive
      // one: a body is pushed back and THEN finds itself struggling, rather
      // than being slowed and pushed the same distance anyway.
      const shoved = knockback(ctx.world, victim, self, push);
      const landed = ctx.status?.(victim, EffectId.Slowed, turns, {
        applyPower: power,
        srcId: self.id,
      });
      lines.push(line(victim.name, shoved, landed));
    }

    if (lines.length === 0) lines.push(`${self.name} shouts at nobody in particular.`);
    return talentDone([], lines);
  },

  describe: (_self, level) =>
    `Shove every enemy within ${String(RADIUS)} tiles of you up to ${String(pushTilesAt(level))} ` +
    `tiles back and slow them for ${String(slowTurnsAt(level))} turns (physical save). ` +
    `No damage — this is the answer to being surrounded. ` +
    `${String(AP_COST)} AP, ${String(RESOLVE_COST)} Resolve, ${String(COOLDOWN_TURNS)}-turn cooldown.`,
};
