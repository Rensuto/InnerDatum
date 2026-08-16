// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/abilities/sigil.json
//          ("A marked round", `cooldown_sec: 4.0` -> R2 -> 4 turns,
//           `effect_type: projectile_shot`, vfx tint [0.78, 0.3, 0.95, 1.0])
//          Outer Index game-design.md § 2 (AP 4, rng 4, ally utility)
// SHAPE:   t-engine4 game/modules/tome/data/damage_types.lua:208-216
//          (`inc_damage_actor_type` — the "this hits that harder" algebra,
//           additive percent applied inside the projector)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * SIGIL — the Inspector's ally utility. A marked round that makes a target
 * easier for EVERYONE to kill.
 *
 * "The Index passes judgment on one of its own." The Inspector does not buff
 * allies; the Inspector annotates the enemy, and the annotation is public.
 *
 * ═══ WHY THE ALLY SLOT IS A DEBUFF ═══
 * game-design.md § 2 requires each class's fourth talent to "touch an ally —
 * that last slot is what makes this co-op rather than four solo games". A mark
 * qualifies more strongly than a buff would: a +15% damage buff on one ally
 * helps one person, whereas a mark on a monster helps whoever is best placed to
 * take the shot, which is a conversation ("it's sigiled, hit it") rather than a
 * menu. That is the § 10 test — does this make people talk?
 *
 * ═══ HOW THE BONUS IS ACTUALLY APPLIED ═══
 * `markMultiplier` in engine/talents.ts folds it into the `mult` of every
 * talent hit, so it is LIVE today for all twelve talents in both directions
 * (the Alchemist's flare and the Watchman's tackle both benefit). It composes
 * with the talent's own multiplier the way Combat.lua:546 composes — a single
 * multiply, before the damage-type projector — rather than as another additive
 * `inc_damage` row, because the mark is a property of the TARGET and
 * `inc_damage` is a property of the attacker.
 *
 * ═══ IT ALSO FEEDS THE INSPECTOR'S OWN RESOURCE ═══
 * Focus "builds by holding LOS on a marked target and by not moving"
 * (game-design.md § 2). Both clauses are in `regenResource`; this talent is
 * what makes the first one reachable. Sigil, then stand still, then Sniper's
 * Mark is the class's whole economy in three turns.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentEffect,
  TalentRefusal,
  TargetShape,
  secondsToTurns,
  talentAttack,
  talentId,
  percent,
  talentDone,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { INSPECTOR_MIN_RANGE } from './revolver_shot.ts';

/** FROZEN. 4 AP leaves 2 — enough to reposition, never enough to also shoot. */
const AP_COST = 4;
/** FROZEN. Sigil (20) then Sniper's Mark (35) is 55 Focus: the class's whole
 * economy is that the setup and the payoff cannot both be afforded in one bar,
 * so the sigil has to land a turn early. A cheaper rank collapses that. */
const FOCUS_COST = 20;
/** FROZEN, and shorter than Sniper's Mark's 7 on purpose: painting is the risk
 * the Inspector takes to earn the long shot. */
const RANGE = 4;
/**
 * `content/abilities/sigil.json` — `cooldown_sec: 4.0`.
 *
 * The only donor cooldown in the Inspector's kit, converted by R2
 * (docs/data-schemas.md § 5): `toTurns(sec) = max(1, round(sec))`, clamped to
 * [0,30]. 4.0 s -> 4 turns.
 */
const COOLDOWN_SEC = 4;
/**
 * A marked round still hits; it is a round. Light, because the mark is the
 * point.
 *
 * FROZEN AT 0.6, DELIBERATELY FLAT — the one damage number in the twelve that
 * does not scale, and the reason is that it is not this talent's real number.
 * `MARK_POWER` below is. A rank spent on Sigil should buy a bigger mark for the
 * whole party, not a bigger round for the caster; scaling both would pay the
 * point twice and turn the ally-utility slot into a fourth attack.
 */
const DAMAGE_MULT = 0.6;
/**
 * Percent extra damage EVERYTHING deals to a sigiled target — THE talent's real
 * number, and the one its rank buys.
 *
 * It is already snapshot onto the effect instance's `power` at cast time and
 * read back by `markMultiplier` (engine/talents.ts), so a mark burning on a
 * monster keeps the strength it was painted with even if the Inspector levels
 * mid-fight. That machinery predates the curve; only the value moved.
 *
 * TUNED HIGH, not ported. The `SHAPE:` citation is damage_types.lua:208-216 —
 * `inc_damage_actor_type`, which is the ALGEBRA for "this hits that harder" and
 * carries no magnitude at all, so there is no upstream 30 to point at.
 *
 * 15 -> 30 is tuned against the party, not the caster, because that is who
 * spends it: at rank 5 a sigiled target takes a third more from every source in
 * the room, which is worth more than any single Inspector shot and is exactly
 * the "it's sigiled, hit it" conversation game-design.md § 10 tests for. It
 * stops at 30 because beyond a third the correct play stops being "focus the
 * marked one" and becomes "never attack anything else", which is one decision
 * fewer, not more.
 */
const MARK_POWER_LOW = 15;
const MARK_POWER_HIGH = 30;

/** The one place this talent's curve is written. */
function markPower(talentLevel: number): number {
  return combatTalentScale(talentLevel, MARK_POWER_LOW, MARK_POWER_HIGH);
}

/** GAME TURNS the sigil burns for. Long enough for the party to act on it.
 * FROZEN: the duration is the party's window to react, and a window that grows
 * lets one sigil cover a whole fight — the talent would stop being a decision
 * about WHEN. The rank buys how much the mark is worth, not how long. */
const MARK_TURNS = 4;

export const sigil: Talent = {
  id: talentId('sigil'),
  name: 'Sigil',
  classId: ClassId.Inspector,
  iconId: 'icon_active_sigil',
  cost: { ap: AP_COST, resource: FOCUS_COST },
  cooldownTurns: secondsToTurns(COOLDOWN_SEC),
  targeting: {
    shape: TargetShape.Single,
    range: RANGE,
    // The dead zone applies: this is fired from the same revolver.
    minRange: INSPECTOR_MIN_RANGE,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: DAMAGE_MULT });

    // Marking a corpse would leave an effect on a body nobody can hit, and the
    // duration would tick for four turns on an actor that never acts again.
    if (!victim.alive) return talentDone([hit], [`${victim.name} is unfiled.`]);

    // SNAPSHOT. `power` is the mark's strength at the moment it was painted;
    // `markMultiplier` reads it back as `1 + power/100` for every hit landed on
    // this body until it lapses.
    const power = markPower(ctx.talentLevel);
    ctx.engine.addEffect(victim.id, {
      kind: TalentEffect.Marked,
      otherId: self.id,
      turns: MARK_TURNS,
      power,
    });

    return talentDone(
      [hit],
      // Rounded for the LOG only — the effect carries the unrounded number, so
      // the line a player reads never drifts from the damage they see.
      [`${victim.name} is sigiled: +${Math.round(power)}% damage taken for ${MARK_TURNS} turns.`],
    );
  },

  describe: (_self, level) =>
    `Paint a target ${INSPECTOR_MIN_RANGE}-${RANGE} tiles away for ${percent(DAMAGE_MULT)} ` +
    `weapon damage. For ${MARK_TURNS} turns everyone — not just you — deals ` +
    `+${Math.round(markPower(level))}% damage to it. ${AP_COST} AP, ${FOCUS_COST} Focus.`,
};
