// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/npcs.lua:191-217
//          Stun -- the ghoul's own, and the melee half of what
//          `ghoul.lua:52-58` gives it (the other two are a poison bite and a
//          rotting disease, and this game has neither status).
// NUMBERS: the damage band is upstream's `combatTalentWeaponDamage(t, 0.5, 1)`
//          at :207. The DURATION is not: upstream is
//          `floor(combatTalentScale(t, 3, 7))` at :202, and see below.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise -- tools/art-needs.mjs reads a talent module whole.

import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
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
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import type { SetEffectResult } from '../engine/effects.ts';

/**
 * ONE TURN. IT SHIPPED AS TWO AND TWO WAS A STUN-LOCK.
 *
 * `npcs.lua:202` is `floor(combatTalentScale(t, 3, 7))`, far too long for a
 * three-turn `ENGAGEMENT_TURNS`. That part was never in doubt. What was wrong
 * was the replacement.
 *
 * TWO TURNS AGAINST A THREE-TURN COOLDOWN LEAVES ONE TURN IN THREE: stunned on
 * 1 and 2, acting on 3, stunned on 4 and 5. The commit that shipped it argued
 * the cooldown made this "a spike once per engagement" -- and an engagement IS
 * three turns, so it fires every one and covers two thirds of each.
 *
 * `INDEX_CAIRN` had already written the rule and I did not apply it: *"a stun
 * longer than the gap between shots is not a hard fight, it is a player who
 * never acts again -- so the duration has to stay strictly under the cadence"*.
 * One against three is strictly under. Two was not.
 *
 * WHY THE DURATION MOVED AND NOT THE COOLDOWN: three is upstream's
 * `cooldown = 6` through `tomeCooldownToTurns`, ported exactly. The duration
 * was already ours, because upstream's 3-to-7 is unusable here -- so the
 * deviation belongs on the number that was deviating anyway, and the ported
 * one stays ported.
 *
 * It is the cairn's stun exactly now: one turn, from a creature that applies it
 * about every third. Two stuns in this game, one rule for both.
 */
const STUN_TURNS = 1;

/**
 * `npcs.lua:207` -- `combatTalentWeaponDamage(t, 0.5, 1)`, ported as its band.
 * Half a swing rising to a whole one: what a player pays for is the STUN, and
 * a talent that also out-damaged the at-will attack would simply replace it
 * (`truncheon_sweep.ts` argues this at length for the Watchman's ladder).
 */
const BLOW_LOW = 0.5;
const BLOW_HIGH = 1;

/** `npcs.lua:195` `cooldown = 6`, through `tomeCooldownToTurns` -- ceil(6/2). */
const BEAR_DOWN_COOLDOWN = 3;

/**
 * A CREATURE PAYS AP AND NOTHING ELSE. Upstream charges `stamina = 8` (:196)
 * and a monster here has no pool to charge -- see the header note in
 * `grasping_hold.ts`, which prices the same way for the same reason.
 */
const BEAR_DOWN_AP = 5;

/** The swing's multiplier at a rank. */
export function blowMult(level: number): number {
  return combatTalentScale(level, BLOW_LOW, BLOW_HIGH);
}

/**
 * WHAT THE RECORD SAYS. A save that bites SHORTENS a stun rather than
 * cancelling it (`rollSaveDuration`), so the line prints the duration it
 * actually got -- the same shape `grasping_hold.ts` uses, and for its reason:
 * "2 turns" and "shrugged off" are different outcomes and must read that way.
 */
function stunLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} stays on their feet.`];
  }
  return [`${name} is Stunned (${String(landed.dur)} turns).`];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BEAR DOWN -- the husk elite's, and the second thing in the game that stuns.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first is the Index Cairn's orb, which stuns for ONE turn and argues the
 * duration against its own firing cadence: *"a stun longer than the gap between
 * shots is not a hard fight, it is a player who never acts again"*. That
 * reasoning is why this one is a TALENT rather than an `onHit` rider.
 *
 * A rider fires on every landed blow. A melee creature adjacent to you lands
 * one most turns, so a stunning rider on a bruiser IS the failure the cairn's
 * note describes -- you would be stunned, hit while stunned, and stunned again.
 * A talent on a three-turn cooldown fires once per engagement, which is what
 * upstream's `cooldown = 6` buys and what makes this a spike rather than a
 * lock.
 *
 * IT RESPECTS `canBe` BY CONSTRUCTION, through `ctx.status`. Upstream tests
 * `target:canBe("stun")` explicitly at :211; ours cannot skip it, because the
 * status path is the only way an effect is applied.
 */
export const bearDown: Talent = {
  id: talentId('bear_down'),
  name: 'Bear Down',
  // NO CLASS, like every talent in this tree: it belongs to a creature and no
  // player can learn it. See `grasping_hold.ts`.
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_bear_down',
  cost: { ap: BEAR_DOWN_AP },
  cooldownTurns: BEAR_DOWN_COOLDOWN,
  targeting: {
    // MELEE, exactly as upstream's `is_melee = true` (:200). 1.5 is this
    // game's adjacent reach -- the same figure `grasping_hold` uses.
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

    const hit = talentAttack(ctx, self, victim, { mult: blowMult(ctx.talentLevel) });
    // A corpse cannot be stunned. The swing above still took its RNG draws, so
    // the stream does not depend on whether it died first -- the guarantee
    // `grasping_hold.ts` and `damage.ts` both make for the same replay reason.
    if (!victim.alive) return talentDone([hit]);

    // UPSTREAM STUNS ONLY ON A HIT (:210, `if hit then`). `ctx.status` is
    // reached the same way here: the attack resolves first and its result is
    // what the log prints, so a miss cannot stun.
    const landed = ctx.status?.(victim, EffectId.Stunned, STUN_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], stunLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Bears down for ${percent(blowMult(level))} weapon damage and stuns for ` +
    `${String(STUN_TURNS)} turns (physical save).`,
};
