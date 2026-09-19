// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/cursed/shadows.lua:465-520
//   (Shadow Warriors: `mode = "passive"`, `getIncDamage` :471-473,
//    `getCombatAtk` :474-476, `getDominateLevel` :477-479, `getFadeLevel`
//    :480-482, `getDominateChance` :483-489, `on_learn`/`on_unlearn` :490-511)
//   shadows.lua:300-311 — where the two numbers are actually SPENT, inside the
//   shadow's own `feed`; the two adds are :306-307.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   SHADOW WARRIORS — the first passive in this game that is about somebody
 *   else's body.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Instil hate in your shadows." — upstream's own first line (:518).
 *
 * ═══ IT HAS NO `passive` FUNCTION, AND THAT IS THE POINT RATHER THAN A GAP ═══
 * Every other passive in this game returns a `PassiveContribution` and the fold
 * lands it on the OWNER'S sheet. This one grants the owner nothing at all:
 * upstream spends it in `shadow:feed()` (shadows.lua:300-311, the two adds at
 * :306-307), where it becomes
 * `addTemporaryValue("combat_atk", …)` and `addTemporaryValue("inc_damage", …)`
 * ON THE SHADOW.
 *
 * So the two getters below are the whole talent, and `call_shadows.ts` reads
 * them — once when a shadow is summoned and again on every base turn, which is
 * upstream's own `on_learn`/`on_unlearn` re-feed (:490-511) turned into a
 * refresh that cannot go stale.
 *
 * `engine/hooks.ts`'s header measured this shape upstream and predicted it:
 * *"SEVENTY PERCENT have no body at all — the rule lives in engine code gated
 * on `knowTalent`"*. This is one of the seventy percent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT COULD NOT CROSS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DOMINATE (:477-479, :483-489) AND FADE (:480-482). Both are TALENTS given to
 *   the shadow — `T_DOMINATE` raises all damage a foe takes for 4 turns,
 *   `T_SHADOW_FADE` (shadows.lua:20-35) makes a struck shadow invulnerable
 *   until its next turn. Neither talent is ported, so their LEVELS have nothing
 *   to be the level of. `getDominateChance` is
 *   `combatLimit(tl^.5, 100, 7, 1, 15.65, 2.23)` and it is written down here
 *   rather than dropped, because the day `shadow_fade.ts` exists this is the
 *   curve it takes.
 *
 * ═══ AND THE TOOLTIP IS WRONG UPSTREAM, WHICH IS WORTH SAYING OUT LOUD ═══
 * `:518` reads *"They gain %d%% extra Accuracy and %d%% extra damage"* and
 * prints `getCombatAtk` into the first slot. `combat_atk` is a FLAT accuracy
 * add (Combat.lua:1355 sums it before the rescale), not a percentage — so the
 * tooltip's first "%%" is a typo in the source. The number is ported as what
 * the CODE does, not as what the tooltip says, and ours describes it honestly.
 * `inc_damage` really is a percentage, so the second half is right.
 */

import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

export const SHADOW_WARRIORS_ID = talentId('shadow_warriors');

/**
 * `math.floor((math.sqrt(self:getTalentLevel(t)) - 0.5) * 35)` — shadows.lua:472.
 *
 * NOT `combatTalentScale`. Upstream writes this one out by hand and the shape
 * differs where it matters: the `- 0.5` means a talent level below 0.25 pays
 * NEGATIVE, so the floor at zero below is load-bearing rather than tidy — a
 * Redactor who has not bought this must not make her shadows worse.
 */
const DAMAGE_PER_ROOT = 35;
/** `math.floor((math.sqrt(self:getTalentLevel(t)) - 0.5) * 23)` — shadows.lua:475. */
const ACCURACY_PER_ROOT = 23;
/** The `- 0.5` both getters subtract. */
const ROOT_OFFSET = 0.5;

function hateCurve(talentLevel: number, scale: number): number {
  if (talentLevel <= 0) return 0;
  return Math.max(0, Math.floor((Math.sqrt(talentLevel) - ROOT_OFFSET) * scale));
}

/** Percentage points of extra damage a shadow deals, at a rank. `inc_damage`. */
export function shadowWarriorDamageAt(talentLevel: number): number {
  return hateCurve(talentLevel, DAMAGE_PER_ROOT);
}

/** FLAT accuracy added to a shadow's swing, at a rank. `combat_atk`. */
export function shadowWarriorAccuracyAt(talentLevel: number): number {
  return hateCurve(talentLevel, ACCURACY_PER_ROOT);
}

export const shadowWarriors: Talent = {
  id: SHADOW_WARRIORS_ID,
  name: 'Shadow Warriors',
  classId: ClassId.Redactor,
  tree: 'ledger/unwritten',
  /** Tier 2 — `type = {"cursed/shadows", 2}`. See `src/shared/tiers.ts`. */
  tier: 2,
  /** `require = cursed_cun_req2` (shadows.lua:469). See `Talent.statGate`. */
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_shadow_warriors',
  // A PASSIVE COSTS NOTHING TO HAVE — `cold_reading.ts` carries the whole note.
  cost: { ap: 0 },
  cooldownTurns: 0,
  /** Never aimed. See `cold_reading.ts` for the argument behind these fields. */
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,

  // NO `passive` FIELD. See the header: this talent's whole contribution lands
  // on a DIFFERENT body, through `call_shadows.ts#shadowCombatAt`.

  describe: (_self, level) =>
    `Always on. Your shadows swing with ${String(shadowWarriorAccuracyAt(level))} more accuracy ` +
    `and deal ${String(shadowWarriorDamageAt(level))}% more damage.`,
};
