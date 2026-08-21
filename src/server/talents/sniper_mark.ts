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
 * ToME's Snipe marks its target (sniper.lua:278, `EFF_SNIPE`). Here the mark
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

import { combatTalentScale } from '../../shared/scale.ts';
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
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { INSPECTOR_MIN_RANGE } from './revolver_shot.ts';

/** FROZEN. 5 of 6 AP — the deliberate shot IS the round, exactly as upstream's
 * "this effectively takes 2 turns" (sniper.lua:273, the trailing comment on
 * the `getDamage` line) intends. */
const AP_COST = 5;
/**
 * FROZEN. Focus accrues at 12 for holding ground plus 8 for watching your own
 * sigil, so 35 is two patient turns. That patience is the class; a rank that
 * bought a discount would let the Inspector fire the big gun while moving,
 * which is the one thing her resource is designed to forbid.
 */
const FOCUS_COST = 35;
/**
 * FROZEN AT 7, and it is the longest range in the game.
 *
 * The Inspector's reach is her half of the co-op contract with the Watchman's
 * doorway, and 7 already spans most of a 30x30 room's sightlines. A rank that
 * bought tiles would eventually let her shoot from outside the fight entirely,
 * at which point the doorway buys nothing and the Watchman is decoration.
 */
const RANGE = 7;
/**
 * ═══ THE CONTRADICTION THIS FILE HAS CARRIED SINCE IT SHIPPED, RESOLVED ═══
 * The header cites `combatTalentWeaponDamage(t, 1.7, 3.5)` from sniper.lua and
 * the code has always used 1.65, which is neither endpoint of that call. Both
 * were right about different things and neither said which:
 *
 *   SHAPE  — PORTED. Snipe, sniper.lua:260-289: a long single shot, a big
 *            multiplier, `cooldown = 10`, and the explicit design note "very
 *            high damage as this effectively takes 2 turns".
 *   LOW    — AUTHORED, `content/skills/sniper_mark.json`'s `damage_multiplier:
 *            1.65`. It WINS at talent level 1 because it is the shipped balance
 *            the whole Inspector was tuned against, and because
 *            `combatTalentScale(1, low, high)` returns `low` exactly — so the
 *            existing level-1 assertion stands untouched.
 *   HIGH   — PORTED. 3.5, upstream's own `max` on the same call.
 *
 * ═══ WHY NOT `combatTalentWeaponDamage`, WHICH IS THE HELPER CITED ═══
 * Arithmetic, not preference: `combatTalentWeaponDamage(1, 1.65, 3.5)` is
 * 2.4773, because that helper is `base + (max-base)·sqrt(tl/5)` and is already
 * 45% up its own curve at level 1. Adopting it would silently move Sniper's
 * Mark off 1.65 on the day levels landed. `combatTalentScale` is fitted with
 * xLow = 1 and reproduces the authored number to the bit. engine/talents.ts
 * carries the full finding above its helpers.
 */
const DAMAGE_MULT_LOW = 1.65;
/** PORTED HIGH: sniper.lua:260-289 — the `max` of `combatTalentWeaponDamage(t, 1.7, 3.5)`. */
const DAMAGE_MULT_HIGH = 3.5;

/** The one place this talent's curve is written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}

/** Snipe, sniper.lua:266 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;
/**
 * Percentage points of crit against a target this Inspector has Sigiled.
 *
 * FROZEN. It is the payoff for a two-button, two-turn sequence, and it is
 * already added BEFORE the [0,100] clamp at the roll (Combat.lua:1935 — see the
 * header). Scaling it as well would double-count the rank: the multiplier below
 * already grows, and crit multiplies the multiplier. 25 points is the size of
 * the reward for the setup; the size of the shot is `DAMAGE_MULT_HIGH`.
 */
const MARKED_CRIT_BONUS = 25;

export const snipersMark: Talent = {
  id: talentId('snipers_mark'),
  name: "Sniper's Mark",
  classId: ClassId.Inspector,
  tree: 'index/marksmanship',
  /** Tier 4 of its tree. See `src/shared/tiers.ts`. */
  tier: 4,
  /** marksmanship is about DEX. See `Talent.statGate`. */
  statGate: 'dex',
  kind: TalentKind.Active,
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
      mult: damageMult(ctx.talentLevel),
      critBonus: onMyMark ? MARKED_CRIT_BONUS : 0,
    });

    return talentDone([hit], onMyMark ? [`${victim.name} was already sigiled.`] : []);
  },

  describe: (_self, level) =>
    `A deliberate shot at ${INSPECTOR_MIN_RANGE}-${RANGE} tiles for ` +
    `${percent(damageMult(level))} weapon damage, +${MARKED_CRIT_BONUS}% critical against ` +
    `your own sigil. ${AP_COST} AP, ${FOCUS_COST} Focus.`,
};
