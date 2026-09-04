// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/races.lua:39-59 ("Gift of the Highborn" —
//              `no_energy = true`, `on_pre_use` refuses while EFF_REGENERATION is up,
//              `setEffect(EFF_REGENERATION, 10, {power = 5 + self:getWil() * 0.5})` and
//              `setEffect(EFF_EMPOWERED_HEALING, 10, {power = t.getHealMod(self, t) / 100})`)
//   t-engine4 game/modules/tome/data/birth/races/human.lua:99-101 (the Higher is GRANTED it:
//              `talents = { [ActorTalents.T_HIGHER_HEAL] = 1 }`)
//   t-engine4 game/modules/tome/class/interface/Combat.lua:1576 (`combatTalentLimit(t, limit,
//              low, high)` — `low` is the value AT TALENT LEVEL 1)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GIFT OF THE HIGHBORN. What the Indexed have that nobody else does.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `human.lua:96-101` gives the Higher two things: a talent TYPE (`race/higher`,
 * a tree) and a TALENT, granted outright at rank 1. This is the talent. The tree
 * is four more and is not ported — see "the tree is not here" below.
 *
 * ═══ IT IS AN ORIGIN'S TALENT, AND THAT ROUTE ALREADY EXISTED ═══
 * `content/origins.ts` grants it exactly as `content/inscriptions.ts` grants an
 * infusion: joined into `sheetForClass`'s loadout AND its birth list, so it
 * arrives on the bar at rank 1 and the engine will accept a press. It belongs to
 * no class, and the Cityborn never see it.
 *
 * ═══ THE SECOND SOURCE OF REGENERATION IN THE GAME, WHICH IS THE POINT ═══
 * `regeneration_infusion.ts` records upstream's `on_pre_use` guard as
 * UNREACHABLE — "there is no second source of `effect:regeneration` in the
 * game", and "the day a second source exists, this is the clause that has to
 * come back". This is that day. Both buttons now refuse while the effect is up,
 * because `StackMode.Refresh` means a second press RESTARTS the clock and throws
 * away the healing still owed: pressing twice would heal you for less than
 * pressing once.
 *
 * ═══ RANK ONE IS THE ONLY RANK, BECAUSE THE TREE IS NOT HERE ═══
 * Upstream's `points = 5` and the numbers climb with rank — but every rank above
 * the first is bought through `race/higher`, which has FOUR talents against this
 * project's "exactly six per tree" panel rule (`talent-trees.test.ts`). So the
 * tree is a separate decision and this talent is capped at 1, exactly as an
 * inscription is: `maxLevel: 1` keeps the panel from drawing a live `+` over a
 * rank no purse can buy.
 *
 * Every number below is therefore `combatTalentLimit`'s `low` argument — its
 * value AT TALENT LEVEL 1 (Combat.lua:1570-1576) — rather than a curve.
 */

import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
import { stat } from '../engine/derived.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * `combatTalentLimit(t, 10, 45, 25)` at rank 1 — races.lua:46. Long on purpose:
 * this is a racial power rather than a rotation button.
 */
const TOME_COOLDOWN = 45;

/** `setEffect(EFF_REGENERATION, 10, …)` — races.lua:51, in ToME actions. */
const TOME_DURATION = 10;

/** THREE OF OUR TURNS… see `regeneration_infusion.ts` for the one converter. */
const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/** `5 + self:getWil() * 0.5` per ToME turn — races.lua:51. */
const REGEN_BASE = 5;
const REGEN_PER_WIL = 0.5;

/**
 * `combatTalentLimit(t, 50, 10, 30)` at rank 1 — races.lua:49, as a PERCENT,
 * divided by 100 at the call site exactly as `:52` does.
 */
const HEAL_MOD_PCT = 10;

/** `no_energy = true` (races.lua:45). The turn goes on around it. */
const AP_COST = 0;

/**
 * THE TOTAL HEALING, PRESERVED ACROSS THE CONVERSION.
 *
 * Upstream ticks `5 + wil/2` for ten ToME turns; ours ticks for `DURATION_TURNS`
 * of our own. `regeneration_infusion.ts` makes the argument in full: the tuned
 * quantity is the POOL, and a duration this engine can actually schedule is the
 * thing that has to move.
 */
function powerPerTurn(wil: number): number {
  return ((REGEN_BASE + wil * REGEN_PER_WIL) * TOME_DURATION) / DURATION_TURNS;
}

export const higherHeal: Talent = {
  id: talentId('higher_heal'),
  name: 'Gift of the Highborn',
  /** NO CLASS OWNS IT — an ORIGIN grants it. See the header. */
  classId: null,
  /**
   * ITS OWN CATEGORY — `type = {"race/higher", 1}` (races.lua:42). It sat in
   * `generic/inscriptions` while that tree was the only hidden one, which kept
   * a one-icon strip off the panel at the cost of filing a racial gift under
   * "things written on you". `TalentTree.size` makes the honest home drawable.
   */
  tree: 'race/higher',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_higher_heal',
  /** ONE RANK — the tree that would raise it is not ported. See the header. */
  maxLevel: 1,
  cost: { ap: AP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  /** Required by the type and never rolled: this one heals. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /**
     * `on_pre_use = ... not self:hasEffect(self.EFF_REGENERATION)` — races.lua:48.
     *
     * REACHABLE HERE, UNLIKE ON THE INFUSION, and that asymmetry is the whole
     * reason `TalentCtx.hasStatus` exists: an Indexed body carries TWO sources
     * of the same regeneration, so one can genuinely be running when the other
     * is pressed. `StatusHas`'s own docblock records why the seam was declined
     * the first time and what changed.
     */
    if (ctx.hasStatus?.(self, EffectId.Regeneration) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    // `getWil()` — races.lua:51. The heal scales with Willpower and nothing else.
    const wil = stat(self.combat ?? {}, 'wil');

    const landed = ctx.status?.(self, EffectId.Regeneration, DURATION_TURNS, {
      power: powerPerTurn(wil),
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * AND THE HALF THAT IS WORTH NOTHING ALONE — races.lua:52.
     *
     * `EMPOWERED_HEALING` multiplies healing RECEIVED, so on its own it does not
     * move a single hit point. Upstream hands it out in the same press as the
     * regeneration for exactly that reason, and separating them would make one
     * of the two a dead button.
     */
    ctx.status?.(self, EffectId.EmpoweredHealing, DURATION_TURNS, {
      power: HEAL_MOD_PCT / 100,
      srcId: self.id,
    });

    return talentDone([], [`${self.name} draws on something older than the record.`]);
  },

  describe: (self) => {
    const wil = stat(self?.combat ?? {}, 'wil');
    const total = Math.round(powerPerTurn(wil) * DURATION_TURNS);
    return (
      `Heal yourself for ${String(total)} life over ${String(DURATION_TURNS)} turns and take ` +
      `${String(HEAL_MOD_PCT)}% more from every other mending while it lasts. ` +
      `Scales with Willpower. Costs no time at all. ` +
      `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`
    );
  },
};
