// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// PORTED:  t-engine4 game/modules/tome/data/talents/misc/npcs.lua:817-849 (Grab)
//          -- the squid's one talent, `resolvers.talents{ [Talents.T_GRAB]=3, }`
//          at data/general/npcs/aquatic_critter.lua:96.
// NUMBERS: the damage band, the duration curve, the cooldown and the pin are
//          upstream's (:821, :828, :833, :836-838). The PRICE is not: upstream
//          charges `stamina = 8` (:822) and a creature here has no pool to charge.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise -- tools/art-needs.mjs reads a talent module whole.

import { combatTalentScale, combatTalentWeaponDamage } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  talentAttack,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/** `npcs.lua:821` -- `cooldown = 6`, in ToME actions. See `tomeCooldownToTurns`. */
const TOME_COOLDOWN = 6;

/** `npcs.lua:833` -- `combatTalentWeaponDamage(t, 0.8, 1.4)`. */
const BLOW_BASE = 0.8;
const BLOW_MAX = 1.4;

/** `npcs.lua:828` -- `math.floor(self:combatTalentScale(t, 2, 6))`. */
const PIN_LOW = 2;
const PIN_HIGH = 6;

/**
 * THE BLOW'S MULTIPLIER AT A RANK -- `combatTalentWeaponDamage`, THE HELPER THE
 * LUA CALLS.
 *
 * `bear_down.ts` and the older talents fit their band with `combatTalentScale`
 * instead, and `engine/talents.ts` says why: they had a shipped level-1 number
 * to keep, and only `combatTalentScale` returns its `low` at rank 1. This talent
 * is new and has no shipped number, so it takes the formula upstream wrote. At
 * rank 1 that is 107%, not 80%: `0.8 + 0.6 * sqrt(1/5)`.
 */
export function grabMult(level: number): number {
  return combatTalentWeaponDamage(level, BLOW_BASE, BLOW_MAX);
}

/**
 * HOW MANY TURNS THE PIN ASKS FOR, before any save scales it down.
 *
 * Upstream's default curve (power 0.5), not `MONSTER_CURVE`: that constant is
 * the authored talents' shared curve, and this one is ported. Rank 1 is 2,
 * rank 3 (the squid's upstream rank) is 4, rank 5 is 6.
 */
export function grabDuration(level: number): number {
  return Math.floor(combatTalentScale(level, PIN_LOW, PIN_HIGH));
}

/**
 * THE RECORD'S LINE. The first branch is upstream's own words at `npcs.lua:840`,
 * which it prints when `canBe("pin")` refuses; a save that shortens the pin to
 * nothing reads the same, because to the player it is the same.
 *
 * ONE TEST, `dur`, because it covers the immunity too: `SetEffectResult.dur` is
 * 0 for every refusal, `SetEffectOutcome.Immune` included. This also asked for
 * `Immune` by name, and deleting that half changed nothing a test could see.
 */
function pinLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.dur <= 0) return [`${name} resists the grab!`];
  return [`${name} is pinned (${String(landed.dur)} turns).`];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRAB -- the Index Clutch's. It hits, and if it hits, you stay.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT GRASPING HOLD WITH A NEW NAME. `grasping_hold.ts` is the Glut's and is
 * authored: a slow, on every cast, whether the blow landed or not. This is a
 * port, and upstream's is a PIN, and only ON A HIT (`npcs.lua:836`, `if hit
 * then`). A missed grab holds nobody.
 *
 * ═══ A PIN TAKES YOUR FEET AND NOT YOUR TURN ═══
 * See `PINNED` in content/effects.ts. A pinned player still swings and still
 * casts; what they lose is the step away. From a melee creature that is the
 * point of it -- you cannot leave the thing that is holding you, so the answer
 * is to kill it or to not be the one it reaches.
 *
 * `canBe("pin")` IS NOT WRITTEN HERE BECAUSE IT CANNOT BE SKIPPED. `ctx.status`
 * is the only way an effect is applied, and it asks the immunity and the save
 * itself -- the same arrangement `bear_down.ts` describes.
 */
export const grab: Talent = {
  id: talentId('grab'),
  name: 'Grab',
  // NO CLASS, like every talent in this tree: it belongs to a creature and no
  // player can learn it. See `grasping_hold.ts`.
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  /** ITS OWN ICON, UNDRAWN FOR NOW -- `Talent.iconId` states the rule. */
  iconId: 'icon_monster_grab',
  /**
   * NO `cost`: A CREATURE PAYS THE TURN AND NOTHING ELSE, AND THIS IS BEAR
   * DOWN'S PRICE. Upstream's Grab and upstream's Stun (`npcs.lua:191-217`,
   * which is `bear_down.ts`) are priced identically -- `cooldown = 6`,
   * `stamina = 8` -- and both are one weapon blow with a physical disable
   * behind it. The same upstream price gets the same price here: the same
   * cooldown, the same weapon-speed turn, and no pool, so the two are one
   * decision rather than two. (Both were 5 AP while talents carried an AP
   * price.)
   */
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  // Grab is `technique/other` (misc/npcs.lua:819), so `weapon`
  // (tome/class/Actor.lua:5807-5808).
  speed: 'weapon',
  targeting: {
    // `range = 1` and `type="hit"` (:826-827): the body next to it, diagonals
    // included. 1.5 is this game's adjacent reach -- the figure `bear_down` and
    // `grasping_hold` use.
    shape: TargetShape.Single,
    range: 1.5,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,
  scalesWith: { damage: TalentPower.Weapon, lands: TalentPower.Physical },

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: grabMult(ctx.talentLevel) });
    // `if hit then` (:836). A miss pins nobody, and a corpse cannot be held.
    // Either way the swing above has already taken its draws, so the stream
    // does not depend on which it was.
    if (!hit.hit || !victim.alive) return talentDone([hit]);

    // :838 -- `setEffect(target.EFF_PINNED, t.getDuration(self, t),
    // {apply_power=self:combatPhysicalpower()})`.
    const landed = ctx.status?.(victim, EffectId.Pinned, grabDuration(ctx.talentLevel), {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], pinLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Grabs for ${percent(grabMult(level))} weapon damage; if it hits, the target is pinned ` +
    `for ${String(grabDuration(level))} turns (physical save).`,
};
