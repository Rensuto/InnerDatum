// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/inscriptions.lua:86-113 ("Infusion: Healing" —
//              `no_energy = true`, `self:heal(data.heal + data.inc_stat)`, then one `wound`
//              and one `poison` effect removed)
//   t-engine4 game/modules/tome/data/birth/races/human.lua:55 (born with one:
//              `inscription_data.cooldown = 12`, `inscription_data.heal = 50`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HEALING INFUSION. The button every ToME character has had for fifteen
 * years.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT BELONGS TO NO CLASS, AND THAT IS NOT A DETAIL ═══
 * An earlier attempt shipped this as a talent on all four `ClassDef`s and three
 * unrelated guards refused it — a duplicate registration, the cheapest-engage
 * invariant, and *"every talent REACHABLE from exactly one class loadout"*. They
 * were right: in this codebase an ACTIVE belongs to a class, and this is not a
 * class talent. It is granted by an INSCRIPTION, which upstream keeps on the
 * ACTOR (`ActorInscriptions.lua:26-32`) and not on the class or in the bag.
 *
 * `content/inscriptions.ts` owns that list; `sheetForClass` joins what a body has
 * written on it into the loadout. So this file declares a button and says
 * nothing about who may press it.
 *
 * ═══ IT COSTS NO TURN, AND THAT IS THE WHOLE TUNING ═══
 * `no_energy = true` (:104). An infusion is not a move traded for a move; it is
 * the thing you do WHILE the fight goes on, which is why upstream's cooldown is
 * long and its heal is flat. `ap: 0` is what `no_energy` means in this engine,
 * and a heal costing 3 of 6 AP would be a different mechanic wearing the name.
 *
 * ═══ FIFTY, VERBATIM, AND THE LOCAL ARITHMETIC THAT SAYS IT FITS ═══
 * `heal = 50` is upstream's birth number, ported unchanged — safe only because
 * our pools were checked against it rather than assumed: `DRAUGHT_OF_MENDING`,
 * the one consumable in the game, heals 80 against level-1 pools of 54 to 72. So
 * the reusable button on a twelve-turn cooldown heals rather less than the
 * single-use bottle, which is the relationship both numbers should have and
 * neither had to be invented to get.
 *
 * A FLAT HEAL, NOT A FRACTION, also verbatim. `mend_wounds` heals a fraction of
 * `maxHp` and stays useful forever; a flat fifty is enormous at level 1 and a
 * gesture at level 40, and that decay IS the tuning — it is what will make
 * finding a better infusion worth wanting.
 *
 * ═══ THE CURE HALF, AND THE HALF WITH NOTHING TO PORT ONTO ═══
 * Upstream removes one `wound` and one `poison` (:112-113). We have
 * `effect:bleeding`, which is the wound; we have no poison at all, so that
 * clause is unreachable rather than skipped — the answer STR→encumbrance got —
 * and it becomes reachable the day a poison exists.
 */

import { DamageType } from '../engine/damage.ts';
import { EffectStatus } from '../engine/effects.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  healActor,
  talentDone,
  talentId,
  talentRefused,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/** `inscription_data.heal = 50` (human.lua:55). See the header for why it fits. */
const HEAL = 50;

/**
 * `inscription_data.cooldown = 12` (human.lua:55), through the one converter.
 *
 * IN ACTIONS, like every cooldown in that file, so it goes through
 * `tomeCooldownToTurns` rather than being written as a turn count — the same
 * reason `mend_wounds` does. Writing the converted number here would be the
 * conversion done twice, once in a comment.
 */
const TOME_COOLDOWN = 12;

/** `no_energy = true` (inscriptions.lua:104): the turn goes on around it. */
const AP_COST = 0;

export const healingInfusion: Talent = {
  id: talentId('healing_infusion'),
  name: 'Healing Infusion',
  /** NO CLASS OWNS IT — see the header. An inscription grants it. */
  classId: null,
  tree: 'generic/inscriptions',
  tier: 1,
  kind: TalentKind.Active,
  /**
   * ITS OWN ICON, UNDRAWN FOR NOW. `Talent.iconId` sets the rule: *"A NEW TALENT
   * MAY SHIP AHEAD OF ITS ICON, which is the practice thirty already follow.
   * What must NOT happen is pointing an iconId at somebody else's art"* — the
   * bar draws a letter, `npm run art:needs` lists it, and that is the whole of
   * the placeholder story for a talent.
   */
  iconId: 'icon_active_healing_infusion',
  /**
   * ONE RANK — `points = 1` on every `newInscription` upstream.
   *
   * WITHOUT THIS IT IS A POINT SINK. `HEAL` is a constant and `describe()`
   * ignores its level, because an inscription's power comes from the
   * inscription; but loadout membership IS purchase authorization here, so the
   * panel would draw a live `+` and sell five irreversible generic points for
   * two identical sentences. Caught by `talent-scaling.test.ts`'s honesty gate
   * before it reached anybody.
   */
  maxLevel: 1,
  cost: { ap: AP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    // Self-centred, nothing to point at — `mend_wounds`' note applies word for
    // word: the one button that must never be fiddly.
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
     * THE CURE FIRST, WHICH INVERTS UPSTREAM'S ORDER DELIBERATELY.
     *
     * `inscriptions.lua` heals at :110 and clears at :112. Ours clears first
     * because our bleed TICKS: `effect:bleeding` takes hit points on the turn it
     * runs, so clearing after healing would let one more tick land on the pool
     * just filled. Upstream's order is simply not load-bearing; here it is worth
     * the two lines.
     */
    const cured = ctx.cure?.(self, EffectStatus.Detrimental) ?? null;
    const healed = healActor(self, HEAL);

    /**
     * NOTHING TO DO IS A REFUSAL, NOT A SPENT COOLDOWN. `healActor` answers 0 at
     * full health, and a twelve-turn cooldown burned on a full-health press is
     * the kind of thing a player never forgives — `field_dressing` makes the
     * same judgement when its cure finds nothing.
     *
     * A CURE ALONE IS STILL A USE: taking a bleed off at full health is exactly
     * what this is for in the turn after a husk opens you up.
     */
    if (healed <= 0 && cured === null) return talentRefused(TalentRefusal.NoTarget);

    return talentDone(
      [],
      [
        ...(healed > 0 ? [`${self.name} recovers ${String(healed)}.`] : []),
        ...(cured === null ? [] : [`${self.name} shakes off ${cured}.`]),
      ],
    );
  },

  describe: () =>
    `Heal yourself for ${String(HEAL)} and shake off one condition. ` +
    `Costs no time at all. ${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`,
};
