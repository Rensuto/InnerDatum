// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/inscriptions.lua:321-345 ("Rune: Shielding" —
//              `no_energy = true`, `on_pre_use` refuses while a shield is up,
//              `self:setEffect(self.EFF_DAMAGE_SHIELD, data.dur, {power=...})`)
//   t-engine4 game/modules/tome/data/general/objects/scrolls.lua:240-254 (the shielding rune
//              itself: `cooldown = rngrange(14, 18)`, `dur = mbonus_level(5, 3)`,
//              `power = mbonus_level(500, 50, ...)`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHIELDING RUNE. The other button every ToME character carries.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The healing infusion undoes a blow after it lands. This one stands in front
 * of the next few, and that difference is the whole reason both exist: a heal
 * is worth pressing when you are hurt, a shield is worth pressing when you are
 * about to be, and a party that only has the first can only ever react.
 *
 * ═══ IT IS THE FIRST RUNE, AND RUNES ARE A SECOND FAMILY ═══
 * `type = {"inscriptions/runes", 1}` upstream, against the infusions' `type =
 * {"inscriptions/infusions", 1}`. `Actor.lua:5850-5856` and `:6356-6362` branch
 * on that string in two places, and each arm has its OWN saturation pool —
 * drinking an infusion must not slow a rune down. `InscriptionKind` carries
 * both values now and `RUNE_SATURATION` is the second pool.
 *
 * ═══ IT COSTS NO TURN, LIKE EVERY INSCRIPTION ═══
 * `no_energy = true` (:327). Pressing it is what you do WHILE the fight goes
 * on — `healing_infusion.ts` carries the full argument and it applies verbatim.
 *
 * ═══ IT REFUSES WHILE A SHIELD IS ALREADY UP ═══
 * `on_pre_use = function(self, t) return not self:hasEffect(self.EFF_DAMAGE_SHIELD) end`
 * (:330-332). Upstream is protecting the player from spending a sixteen-turn
 * cooldown to replace a shield they already have — and it also means the
 * merge case is rare enough that `DAMAGE_SHIELD` does not need upstream's
 * thirty-line `on_merge`.
 */

import { DamageType } from '../engine/damage.ts';
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
import { EffectId } from '../content/effects.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A HUNDRED, AND IT IS A BIRTH GRANT'S NUMBER RATHER THAN A DROP'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `elf.lua:107` — `resolvers.inscription("RUNE:_SHIELDING", {cooldown=14,
 * dur=5, power=100})`. Upstream writes the whole kit out as literals for a race
 * that is born with it, exactly as `human.lua:55` does for the healing infusion
 * this game already ports at its literal 50.
 *
 * NOT `scrolls.lua:250`'s `mbonus_level(500, 50, ...)`, which is the FOUND rune
 * and rolls per item. We have no item roll — `origins.ts` grants a talent — so
 * the birth literal is both the faithful number and the only one that can be
 * written down. It is also the larger of the two, which is right: a rune you
 * were born with is upstream's baseline, not a floor drop.
 *
 * FLAT WHERE A FOUND RUNE SCALES, and that decay IS the tuning, on
 * `healing_infusion`'s argument word for word: enormous at level 1, a gesture
 * at level 40, and what will make finding a better rune worth wanting.
 *
 * ═══ TWICE THE HEALING INFUSION, AND UPSTREAM MEANS THAT ═══
 * 100 absorbed against 50 healed. A shield has to be pressed BEFORE the blow
 * and expires unspent if you were wrong; a heal is spent on damage that has
 * already happened and is never wasted. Upstream pays for the guess, and the
 * longer cooldown below is the other half of the same bargain.
 */
const ABSORB = 100;

/**
 * `dur = resolvers.mbonus_level(5, 3)` (scrolls.lua:249), which lands at three
 * to four UPSTREAM turns at level 1. Two of those are one of ours.
 *
 * THROUGH THE CONVERTER, like every duration in this codebase, rather than
 * written as the converted number — that would be the conversion done twice,
 * once in a comment, and the comment is the copy that goes stale.
 */
const TOME_DURATION = 4;

/**
 * `cooldown = resolvers.rngrange(14, 18)` (scrolls.lua:248) — the midpoint,
 * because we do not roll one per item.
 *
 * LONGER THAN THE HEALING INFUSION'S TWELVE, which is upstream's own ordering
 * and worth keeping: a shield spent at the right moment is worth more than a
 * heal spent at any moment, so it comes back more slowly.
 */
const TOME_COOLDOWN = 16;

/** `no_energy = true` (inscriptions.lua:327): the turn goes on around it. */
const AP_COST = 0;

export const shieldingRune: Talent = {
  id: talentId('shielding_rune'),
  name: 'Shielding Rune',
  /** NO CLASS OWNS IT — see `healing_infusion.ts`. An inscription grants it. */
  classId: null,
  tree: 'generic/inscriptions',
  /**
   * `type = {"inscriptions/runes", 1}` (inscriptions.lua:323) — the RUNE arm,
   * which is what puts its cooldown tax in `RUNE_SATURATION` rather than in the
   * infusions' pool. Two pools, deliberately: `Actor.lua:6356-6362`.
   */
  inscriptionKind: 'rune',
  tier: 1,
  kind: TalentKind.Active,
  /** ITS OWN ICON, UNDRAWN FOR NOW — `Talent.iconId` states the rule. */
  iconId: 'icon_active_shielding_rune',
  /** ONE RANK — `points = 1` on every `newInscription`. See the infusion's note. */
  maxLevel: 1,
  cost: { ap: AP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    // Self-centred, nothing to point at. The one button that must never be
    // fiddly — `mend_wounds`' note, and it applies to every inscription.
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  /** Required by the type and never rolled: this one takes damage rather than deals it. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /**
     * `on_pre_use` (inscriptions.lua:330-332), AS A REFUSAL RATHER THAN A
     * HIDDEN BUTTON.
     *
     * Upstream's `on_pre_use` greys the talent out. Ours refuses at the press,
     * which is this codebase's settled shape for the same thing — and the
     * refusal is what stops a player spending an eight-turn cooldown to replace
     * a shield they are already standing behind.
     */
    if (ctx.hasStatus?.(self, EffectId.DamageShield) === true) {
      return talentRefused(TalentRefusal.NoTarget);
    }

    const landed = ctx.status?.(self, EffectId.DamageShield, tomeCooldownToTurns(TOME_DURATION), {
      power: ABSORB,
    });
    // NO EFFECT TABLE MEANS NO SHIELD, and a cooldown spent on nothing is the
    // thing a player never forgives — `healing_infusion` refuses the same way.
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`A shield forms around ${self.name}.`]);
  },

  describe: () =>
    `Raise a shield that absorbs the next ${String(ABSORB)} damage aimed at you. ` +
    `Costs no time at all.`,
};
