// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/sniper_mark.json
//          (ap_cost 5, range 7, MIN_RANGE 3, damage_multiplier 1.65)
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/sniper.lua:260-289
//          (Snipe: `cooldown = 10`, `combatTalentWeaponDamage(t, 1.7, 3.5)`,
//           "very high damage as this effectively takes 2 turns", and it MARKS
//           the target)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * SNIPER'S MARK — the Inspector's signature, and the class fantasy in one
 * number: 1.65x, at seven tiles, and never closer than three.
 *
 * "A carefully aimed shot that rewards distance — and punishes anyone who
 * learned to fight up close."
 *
 * ═══ THE DEAD ZONE IS THE POINT, NOT A DRAWBACK ═══
 * `min_range: 3` is authored on this talent in the source and is the number
 * game-design.md § 2 calls "the single most important number here". A player
 * who is being crowded cannot reach for the big button, which is precisely why
 * the Watchman standing in the doorway is worth something. `canUseTalent`
 * refuses with `MinRange` before a single AP is spent, so being crowded is free
 * rather than punishing (the refund rule).
 *
 * ═══ IT PAYS OFF A SIGIL ═══
 * ToME's Snipe marks its target (sniper.lua:277, `EFF_SNIPE`). Here the mark
 * runs the other way: Sigil paints, Sniper's Mark collects. Firing at a target
 * the Inspector has already painted adds crit chance ON TOP of the damage
 * bonus that `markMultiplier` folds into every hit — so the two-button sequence
 * (Sigil, then Mark) is the highest-damage thing the class can do, and it costs
 * two turns and most of a Focus bar to set up.
 *
 * The crit bonus goes in as `critBonus`, i.e. `add_chance` at Combat.lua:1889,
 * which is added BEFORE the clamp to [0,100] happens at the roll
 * (Combat.lua:1935). derived.ts's `combatCrit` deliberately does not clamp for
 * exactly this reason.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentEffect,
  TalentRefusal,
  TargetShape,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { INSPECTOR_MIN_RANGE } from './revolver_shot.ts';

const AP_COST = 5;
const FOCUS_COST = 35;
const RANGE = 7;
/** `damage_multiplier: 1.65` — the highest in the game, and it is earned. */
const DAMAGE_MULT = 1.65;
/** Snipe, sniper.lua:266 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;
/** Percentage points of crit against a target this Inspector has Sigiled. */
const MARKED_CRIT_BONUS = 25;

export const snipersMark: Talent = {
  id: talentId('snipers_mark'),
  name: "Sniper's Mark",
  classId: ClassId.Inspector,
  iconId: 'icon_active_sniper_mark',
  cost: { ap: AP_COST, resource: FOCUS_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    minRange: INSPECTOR_MIN_RANGE,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    // Only YOUR sigil pays out. A second Inspector's mark still boosts everyone's
    // damage (that is what a mark is for) but does not hand you its crit.
    const mark = ctx.engine.effectOn(victim.id, TalentEffect.Marked);
    const onMyMark = mark !== undefined && mark.otherId === self.id;

    const hit = talentAttack(ctx, self, victim, {
      mult: DAMAGE_MULT,
      critBonus: onMyMark ? MARKED_CRIT_BONUS : 0,
    });

    return talentDone([hit], onMyMark ? [`${victim.name} was already sigiled.`] : []);
  },

  describe: () =>
    `A deliberate shot at ${INSPECTOR_MIN_RANGE}-${RANGE} tiles for ${percent(DAMAGE_MULT)} ` +
    `weapon damage, +${MARKED_CRIT_BONUS}% critical against your own sigil. ` +
    `${AP_COST} AP, ${FOCUS_COST} Focus.`,
};
