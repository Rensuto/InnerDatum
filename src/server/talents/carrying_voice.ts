// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/warcries.lua
//          -- the warcry tree's shouts check `combatMindpower`; a talent that
//          raises it is what makes the rest of the tree land.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * CARRYING VOICE -- AUTHORITY.
 *
 * "Everyone in the yard heard it. That was the idea."
 *
 * ═══ THE TALENT THAT MAKES THE OTHER FIVE WORK ═══
 * Every status in this game lands on a SAVE, and what it is rolled against is
 * the caster's power. Move Along's slow and Clear the Street's shove both check
 * power against the target's save; without something in this tree that raises
 * it, a Watchman who has spent five points on shouting is shouting at exactly
 * the same volume he started with, and the tree gets strictly worse the deeper
 * into it you go -- because later targets have better saves.
 *
 * That is the shape upstream avoids by giving nearly every tree a power talent,
 * and it is the single most common way a control tree dies in playtesting: the
 * numbers all rise and the LANDING RATE falls faster.
 *
 * ═══ AND IT IS A PASSIVE, DELIBERATELY, IN A TREE OF SHOUTS ═══
 * A tree of nothing but actives is a tree that competes with itself for AP: one
 * button a turn, so the fourth shout is worth nothing while the first exists.
 * The two passives here are what let a player buy INTO the tree rather than
 * choosing between its buttons -- and this one is worth more the more of the
 * tree they own, which is exactly the incentive a category should create.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `genericPower`, AND THIS TALENT WAS WRITTEN WITH `mindPower` FIRST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That version type-checked. It would have persisted, drawn a tooltip, printed
 * a sentence in the panel, and CHANGED NO NUMBER A PLAYER COULD SEE — because
 * `combatMindpower` and `combatSpellpower` have zero call sites in this game.
 * derived.ts:110-134 says so out loud and names it "the worst failure an item
 * system has, because it is invisible", and content/classes.ts already carries
 * one dead `mods: { spellPower: 4 }` from the last time somebody made exactly
 * this mistake.
 *
 * `genericPower` is the live one: derived.ts:473, :481 and :500 add it into ALL
 * THREE power getters, so it raises whatever channel a given shout happens to
 * roll with. That is a better talent than the one intended as well as a working
 * one — a Watchman does not need to know which save the thing in front of him
 * is about to make.
 *
 * THE LESSON, FOR THE NEXT TALENT: a mod field existing is not the same as a
 * mod field being read. `grep -rn '<field>' src/` and look for a consumer that
 * is not a type declaration.
 */
const POWER_LOW = 4;
const POWER_HIGH = 16;
const CURVE = 0.75;

/** Power in every channel — what a shout is rolled against a save with. */
export function powerAt(level: number): number {
  return Math.round(combatTalentScale(level, POWER_LOW, POWER_HIGH, CURVE));
}

export const carryingVoice: Talent = {
  id: talentId('carrying_voice'),
  name: 'Carrying Voice',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_carrying_voice',
  cost: { ap: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  passive: (level) => ({ mods: { genericPower: powerAt(level) } }),

  describe: (_self, level) =>
    `Always on. ${String(powerAt(level))} to every kind of power — what a shout is rolled ` +
    `against a target's saves with, so the rest of this discipline keeps landing on things ` +
    `that are getting harder to shift.`,
};
