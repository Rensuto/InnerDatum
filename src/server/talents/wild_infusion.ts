// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/inscriptions.lua:134-165 ("Infusion: Wild" —
//              `no_energy = true` (:137), two `removeEffectsFilter` clauses (:152-156) and
//              `setEffect(EFF_PAIN_SUPPRESSION, data.dur, {power=data.power + data.inc_stat})` (:160))
//   t-engine4 game/modules/tome/data/timed_effects/physical.lua:838-855 (PAIN_SUPPRESSION —
//              `addTemporaryValue("resists", {all=eff.power})`)
//   t-engine4 game/modules/tome/data/birth/races/human.lua:54 (born with one:
//              `{cooldown=12, what={physical=true}, dur=4, power=14}`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WILD INFUSION. The third and last of the three a body is born with.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `human.lua:50-56` grants three inscriptions and `MAX_INSCRIPTIONS` is 3
 * because of it. Healing shipped first, then Regeneration; this closes the set.
 *
 * ═══ IT IS THE ANSWER TO BEING HELD, NOT TO BEING HURT ═══
 * The other two infusions put hit points back. This one takes a debuff off and
 * makes the next few turns land softer, which is what you press when a husk has
 * opened you up and something else is already swinging — a heal does nothing
 * about the bleed and nothing about the blow that is coming.
 *
 * `no_energy = true` (:137), like Healing and unlike Regeneration, so it costs no
 * turn: it is the thing you do WHILE the fight goes on.
 *
 * ═══ THE `all` RESIST ROW, AND WHY THAT IS NOT A NEW MECHANIC ═══
 * `PAIN_SUPPRESSION` adds `resists = { all = power }` (physical.lua:850), which
 * composes MULTIPLICATIVELY with every typed row. `content/inscriptions.ts` used
 * to record this infusion as blocked on that — *"it wants a temporary
 * all-resistance, and `Wielder` deliberately refuses an `all` row"*.
 *
 * THAT WAS TRUE OF GEAR AND FALSE OF EFFECTS, and the codebase already said so:
 * `validateItems` refuses `resistAll` on an item with the message *"only an
 * effect may move `all`"*, `composeWielders` has folded the row since the
 * cross-tier trio landed, and `SPELLSHOCKED` has carried a NEGATIVE one all
 * along. Nothing needed designing; the row simply had no positive user.
 *
 * ═══ TWO CURE CLAUSES, AND THEY ARE NOT THE SAME CLAUSE TWICE ═══
 * `:152-156` removes every CROSS-TIER effect matching the type table, and then
 * ONE ordinary effect of that type:
 *
 *     removed = target:removeEffectsFilter({types=data.what, subtype={["cross tier"]=true}, ...})
 *     for k,v in pairs(data.what) do
 *         removed = removed + target:removeEffectsFilter({type=k, status="detrimental"}, 1)
 *
 * Collapsing them into "remove two physical debuffs" would take one too many off
 * a body that has no cross-tier effect, which is most bodies most of the time.
 * `StatusCureOptions.crossTierOnly` exists so the two clauses stay two.
 *
 * PHYSICAL ONLY, because `what = {physical=true}` (human.lua:54). A wild infusion
 * does nothing about being confused, and that is the tuning: the mental and
 * magical channels are somebody else's problem to solve.
 */

import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
import { EffectStatus, SaveChannel } from '../engine/effects.ts';
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

/** `power = 14` (human.lua:54) — the percentage taken off EVERY damage type. */
const RESIST_ALL = 14;

/** `dur = 4` (human.lua:54), in ToME actions like every number in that table. */
const TOME_DURATION = 4;

/** `cooldown = 12` (human.lua:54), through the one converter. */
const TOME_COOLDOWN = 12;

/**
 * TWO OF OUR TURNS — `tomeCooldownToTurns(4)`, `ceil(4 / 2)`. Short on purpose
 * upstream: this is a window to act in, not a stance to sit in.
 */
const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/** `no_energy = true` (inscriptions.lua:137). See `healing_infusion.ts`. */
const AP_COST = 0;

export const wildInfusion: Talent = {
  id: talentId('wild_infusion'),
  name: 'Wild Infusion',
  /** NO CLASS OWNS IT — an inscription grants it. See `healing_infusion.ts`. */
  classId: null,
  tree: 'generic/inscriptions',
  tier: 1,
  kind: TalentKind.Active,
  /** Undrawn; the bar draws a letter and `npm run art:needs` lists it. */
  iconId: 'icon_active_wild_infusion',
  /** ONE RANK — `points = 1` on every `newInscription`. See `healing_infusion.ts`. */
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
  /** Required by the type and never rolled: this one defends. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /**
     * THE CROSS-TIER CLAUSE FIRST, exactly as upstream orders them. In our
     * roster that is Off Balance — the physical member of the trio the engine
     * applies when an attacker outranks a save by a whole tier — and taking it
     * off is the difference between shaking off a hard hit and merely padding
     * the next one.
     */
    const tier = ctx.cure?.(self, EffectStatus.Detrimental, {
      channel: SaveChannel.Physical,
      crossTierOnly: true,
    });
    /** …AND THEN ONE ORDINARY PHYSICAL DEBUFF. `removeEffectsFilter(..., 1)`. */
    const ordinary = ctx.cure?.(self, EffectStatus.Detrimental, {
      channel: SaveChannel.Physical,
    });

    const landed = ctx.status?.(self, EffectId.PainSuppression, DURATION_TURNS, {
      power: RESIST_ALL,
      srcId: self.id,
    });
    /**
     * THE GUARD IS THE BUFF, NOT THE CURE. Upstream presses this with nothing to
     * cure all the time — the resistance IS the reason — so a body with no
     * debuffs must still get its window. Only a fixture with no status table can
     * answer `undefined`, which is `legwork.ts`'s note where it says the same.
     */
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    const shaken = [tier, ordinary].filter((name): name is string => name != null);
    return talentDone(
      [],
      [
        `${self.name} shrugs the pain off.`,
        ...(shaken.length === 0 ? [] : [`${self.name} shakes off ${shaken.join(' and ')}.`]),
      ],
    );
  },

  describe: () =>
    `Shake off a physical affliction and take ${String(RESIST_ALL)}% less of every kind of ` +
    `damage for ${String(DURATION_TURNS)} turns. Costs no time at all. ` +
    `${String(tomeCooldownToTurns(TOME_COOLDOWN))} turn cooldown.`,
};
