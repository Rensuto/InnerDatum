// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/inscriptions.lua:66-80 ("Infusion: Regeneration" —
//              `on_pre_use` refuses while the effect is already up (:71), and the action is one
//              `setEffect(EFF_REGENERATION, data.dur, {power=(data.heal + data.inc_stat)/data.dur})`
//              (:74). NO `no_energy` on this one, unlike its two siblings)
//   t-engine4 game/modules/tome/data/birth/races/human.lua:53 (born with one:
//              `resolvers.inscription("INFUSION:_REGENERATION", {cooldown=10, dur=5, heal=60})`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REGENERATION INFUSION. The second of the three a body is born with.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `human.lua:50-56` is ONE `copy` block granting THREE inscriptions, and that is
 * where `MAX_INSCRIPTIONS = 3` came from — it was never an arbitrary ceiling.
 * The healing infusion shipped first and left two of those slots declared and
 * empty; this is the second. See `content/inscriptions.ts`.
 *
 * ═══ IT COSTS A TURN, AND THAT IS THE ONE THING SEPARATING IT FROM THE OTHER
 *     HEAL ═══
 * `Infusion: Healing` and `Infusion: Wild` both carry `no_energy = true`
 * (inscriptions.lua:104 and :137). THIS ONE DOES NOT, and the omission is
 * load-bearing rather than something upstream never got to: a heal you press for
 * free in the middle of a fight and a heal you spend your action on are
 * different tools, and owning both is the choice. Healing is the panic button —
 * instant, flat, cheap on the clock and expensive on the cooldown. Regeneration
 * is the one you press BEFORE the fight, or in the gap after it, because it asks
 * for a turn and pays back over three.
 *
 * So `AP_COST` is 3 and not 0: a ToME action is `BUDGET / TOME_ACTIONS_PER_TURN`
 * = 6 / 2, which is what `field_dressing` — the other heal that costs a turn —
 * charges. A 0 here would have made this strictly better than the healing
 * infusion in every situation and collapsed a fifteen-year-old choice into one
 * obvious answer.
 *
 * ═══ SIXTY OVER THE WHOLE EFFECT, NOT SIXTY PER TURN ═══
 * `power = (heal + inc_stat) / dur` (:74) — upstream divides the pool across the
 * duration, so `heal = 60` is the TOTAL and the per-turn number is derived. That
 * division is why this file keeps `TOTAL_HEAL` and derives `POWER_PER_TURN` from
 * it rather than authoring the per-turn number: the tuned quantity is 60 life,
 * and a change to the duration must not silently become a change to the power.
 *
 * ═══ FIVE UPSTREAM ACTIONS ARE THREE OF OUR TURNS ═══
 * `dur = 5` is in ToME actions, exactly as a `cooldown` is — `tomeCooldownToTurns`
 * says so in its own docblock ("ToME turns = ToME actions"), and there is one
 * converter because there is one conversion. Five actions is 2.5 of our turns and
 * rounds up to 3, so the heal lands as 20 a turn for three turns.
 *
 * THE TOTAL IS PRESERVED AND THE PACING MOVES, which is the right way round: 60
 * is the tuned number and 2.5 turns is not something this engine can schedule.
 *
 * ═══ UPSTREAM'S `on_pre_use` IS UNREACHABLE HERE, RATHER THAN SKIPPED ═══
 * `on_pre_use = function(self, t) return not self:hasEffect(self.EFF_REGENERATION) end`
 * (:71) stops you restarting the clock and throwing away healing still owed —
 * our `StackMode.Refresh` would do exactly that.
 *
 * IT CANNOT HAPPEN. The cooldown is `tomeCooldownToTurns(10)` = 5 turns and the
 * effect runs for 3, so the button is unavailable for two full turns after the
 * last tick. There is no second source of `effect:regeneration` in the game.
 *
 * SO NO SEAM WAS ADDED FOR IT. `TalentCtx` has no "is this status up" query, and
 * building one to answer a question nothing can ask would be a correct value
 * with no reader — the defect this codebase keeps finding. The day a second
 * source of regeneration exists, or a cooldown drops under the duration, this is
 * the clause that has to come back, and this paragraph is where to start. Same
 * judgement `healing_infusion.ts` records for upstream's poison clause.
 */

import { EffectId } from '../content/effects.ts';
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

/** `heal = 60` (human.lua:53). The TOTAL, spread across the duration — see the header. */
const TOTAL_HEAL = 60;

/** `dur = 5` (human.lua:53), in ToME actions like every other number in that table. */
const TOME_DURATION = 5;

/** `cooldown = 10` (human.lua:53), through the one converter. */
const TOME_COOLDOWN = 10;

/**
 * THREE OF OUR TURNS. `tomeCooldownToTurns(5)` — `ceil(5 / 2)` — because a ToME
 * duration is counted in the same actions a ToME cooldown is.
 */
const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/**
 * TWENTY A TURN, DERIVED. `(heal + inc_stat) / dur` at :74, with `inc_stat` zero
 * until an infusion scales with a stat. Never authored directly: see the header.
 */
const POWER_PER_TURN = TOTAL_HEAL / DURATION_TURNS;

/**
 * ONE ACTION. `BUDGET / TOME_ACTIONS_PER_TURN` — the price `field_dressing`
 * pays, and the whole difference between this and the healing infusion.
 */
const AP_COST = 3;

export const regenerationInfusion: Talent = {
  id: talentId('regeneration_infusion'),
  name: 'Regeneration Infusion',
  /** NO CLASS OWNS IT — an inscription grants it. See `healing_infusion.ts`. */
  classId: null,
  tree: 'generic/inscriptions',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_regeneration_infusion',
  /** ONE RANK — `points = 1` on every `newInscription`. See `healing_infusion.ts`. */
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
     * NO SAVE IS ROLLED AND NONE SHOULD BE — `applySave` never rolls for a
     * beneficial effect, which is the note `legwork.ts` makes where it puts
     * Evasive on its own body. So the only way this comes back `undefined` is a
     * fixture with no status table, never anything a player can produce.
     */
    const landed = ctx.status?.(self, EffectId.Regeneration, DURATION_TURNS, {
      power: POWER_PER_TURN,
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    return talentDone([], [`${self.name} begins to knit closed.`]);
  },

  describe: () =>
    `Heal yourself for ${String(TOTAL_HEAL)} life over ${String(DURATION_TURNS)} turns. ` +
    `Costs an action, unlike your other infusion. ` +
    `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`,
};
