// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: t-engine4 game/modules/tome/data/talents/techniques/archery.lua:318-345
//          Fragmentation Shot -- cooldown 10, ball radius
//          floor(combatTalentScale(t, 1.3, 2.7)), getDamage =
//          combatTalentWeaponDamage(t, 1.0, 1.5).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * SCATTERSHOT -- the Inspector, in Marksmanship.
 *
 * "Wide load. You will not like where all of it goes."
 *
 * ═══ THE RANGED CLASS HAD NO ANSWER TO A CROWD EITHER ═══
 * Revolver Shot hits one body and Sniper Mark improves hitting one body. Against
 * three things walking up a corridor the Inspector's whole plan was to kill the
 * front one slightly faster, which is the same gap Truncheon Sweep closes for
 * the Watchman -- and closing it the same way for both classes would be lazy, so
 * these two are deliberately different shapes. The sweep is centred on the BODY
 * and costs nothing to aim; this is centred on a TILE up to `RANGE` away and
 * therefore has to be aimed, and can be aimed badly.
 *
 * ═══ THE RADIUS DOES NOT GROW WITH RANK, WHICH UPSTREAM'S DOES ═══
 * Fragmentation Shot scales 1.3 -> 2.7. `TalentTargeting.radius` is sent to the
 * client so it can draw the shape, and `effectiveTalentRange` is the ONE
 * function both sides resolve range from -- there is no radius equivalent, so a
 * radius that changed with rank would have the client drawing a two-tile ball
 * around a talent the server just burst at three. That is the same class of bug
 * `toLoadoutView`'s range invariant exists to prevent, and it is not worth
 * opening a second front on it for a scaling nicety.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { TalentPower } from '../engine/derived.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TargetShape,
  actorsInShape,
  ballTiles,
  talentBaseDamage,
  talentDone,
  talentId,
  talentProject,
  percent,
} from '../engine/talents.ts';
import type { Talent, TalentHit } from '../engine/talents.ts';

/**
 * ═══ UPSTREAM CHARGES Focus FOR THIS, AND SO DO WE NOW ═══
 * `archery.lua:318-345, Fragmentation Shot` carries ``stamina = 12``. The header above cites that
 * talent for its cooldown and its damage; the resource line was not carried
 * with them, and is now.
 *
 * ONE OF FIVE, all of them Inspector or Watchman/Inspector talents — see
 * `tools/talent-costs.mjs`, which found them by reading every citation, and
 * `shin_crack.ts`, which carries the long version of the argument. The five are
 * why `tools/class-live.mjs` reports that neither class can spend its resource
 * at level 1.
 *
 * ═══ RULED 2026-09-04: TAKE UPSTREAM'S NUMBER, UNCONVERTED ═══
 * Asked and answered rather than left at the line a third time. The number is
 * TRANSCRIBED, not converted, and that is defensible on three measurements:
 * our pool is 0-100 and so is a ToME actor's stamina (the npcs cluster 90-150);
 * `RESOLVE_PER_TURN` is `0.3 * TOME_ACTIONS_PER_TURN`, which is
 * `tome/class/Actor.lua:230`'s own `stamina_regen = 0.3` ported exactly; and the
 * costs that WERE carried land in the same band -- Lockdown 30, Iron Curtain 25.
 * A conversion factor would have been the invention here; 1:1 is the port.
 */
/**
 * Upstream's own number, transcribed — `archery.lua:324`. See the header's ruling.
 */
const FOCUS_COST = 12;
const AP_COST = 4;
/**
 * ═══ DIVERGES FROM THE CITED TALENT, AND THE REASON IS NOT RECORDED ═══
 * Upstream is `cooldown = 10` in ACTIONS, which `tomeCooldownToTurns` converts
 * to 5 turns. This is 4.
 *
 * The header above says this talent was taken "for its cooldown and its
 * damage". The cooldown is the one it did not take: 4 is neither upstream's 10
 * nor the converted 5.
 *
 * Flagged rather than changed: a cooldown is a balance number and moving four
 * of them is a tuning pass, not a transcription. `redaction.ts` is the shape a
 * deliberate divergence takes here — it states the multiple, gives the reason
 * (its reach against upstream's melee), and says it is written down precisely so
 * `tools/talent-costs.mjs` does not report it as silent. This one has no such
 * paragraph, and the probe has been printing it on every run.
 */
const COOLDOWN = 4;
const RANGE = 5;
/** Fixed, and the header says why at length. */
const RADIUS = 1;
/**
 * ═══ UNDER THE REVOLVER, FOR `pistol_whip.ts`'s REASON ═══
 * Upstream's Fragmentation Shot is `combatTalentWeaponDamage(t, 1.0, 1.5)` —
 * 122% at rank 1 rising to 150%. Ours is the same 0.5 -> 0.9 band `pistol_whip`
 * carries, and for the same stated reason: what the player pays four AP and a
 * cooldown for is the EFFECT, not the hit.
 *
 * The Inspector's ladder, which this sits inside:
 *
 *     sniper_mark      1.65 -> 3.5   one target, the whole turn
 *     revolver_shot    0.9  -> 1.6   the at-will shot
 *     scattershot      0.5  -> 0.9   this: several bodies, and a crowd answer
 *     pistol_whip      0.5  -> 0.9   melee on a ranged class, and a stun
 *
 * At upstream's pair this would deal 122% at rank 1 against the at-will shot's
 * 90% — an area talent out-damaging the single-target basic on every body it
 * touches. That is the shape `truncheon_sweep.ts` argues against by name.
 */
const MULT_LOW = 0.5;
const MULT_HIGH = 0.9;

function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, MULT_LOW, MULT_HIGH);
}

export const scattershot: Talent = {
  id: talentId('scattershot'),
  name: 'Scattershot',
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** marksmanship is about DEX. See `Talent.statGate`. */
  statGate: 'dex',
  kind: TalentKind.Active,
  iconId: 'icon_active_scattershot',
  cost: { ap: AP_COST, resource: FOCUS_COST },
  cooldownTurns: COOLDOWN,
  targeting: {
    shape: TargetShape.Ball,
    range: RANGE,
    minRange: 0,
    radius: RADIUS,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,
  scalesWith: { damage: TalentPower.Weapon },

  onUse: (ctx, self, target) => {
    // The same constant the wire sent as `radius`, so the preview and the tiles
    // that are actually hit cannot disagree -- `alchemic_vial.ts` states the
    // rule and this is the second reader of it.
    const tiles = ballTiles(target, RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);

    const base = talentBaseDamage(self);
    const mult = damageMult(ctx.talentLevel);
    const hits: TalentHit[] = [];
    for (const victim of victims) {
      hits.push(talentProject(ctx, self, victim, base, DamageType.Physical, mult));
    }

    return talentDone(hits, [`Scattershot. ${String(hits.length)} caught.`]);
  },

  describe: (_self, level) =>
    `Fire wide at a tile up to ${String(RANGE)} tiles away. Every enemy on it and its ` +
    `neighbours takes ${percent(damageMult(level))} damage. It does not miss, and allies ` +
    `are never hit.`,
};
