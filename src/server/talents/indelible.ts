// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/cursed/gloom.lua — the
//          passive that raises the power a class's own effects are applied with,
//          rather than the damage of any one button.
// PORTED:  t-engine4 game/modules/tome/data/talents/cursed/cursed-form.lua:24-76
//          Unnatural Body — `on_kill` banks `getHealPerKill` and the body spends
//          it back. The Doomed is born with it (data/birth/classes/afflicted.lua:143).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { combatTalentScale, combatTalentSpellDamage } from '../../shared/scale.ts';
import { healActor } from '../engine/damage.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INDELIBLE — the marks go in harder, which for this class is the damage stat.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Not the sort that comes out."
 *
 * ═══ MINDPOWER IS THIS CLASS'S DAMAGE NUMBER, EVEN THOUGH IT IS NOT DAMAGE ═══
 * Every mark the Redactor applies rolls its `applyPower` against a save. A
 * Watchman who raises Strength hits harder; a Redactor whose marks go in harder
 * does not hit harder AT ALL — the mark either lands or does not, and the whole
 * rest of the class depends on which.
 *
 * That is why this passive raises power rather than `dam`. For a class whose
 * economy is "did the mark land", a point on the save roll is worth more than a
 * point on a bolt — and a flat `dam` bonus would have been the twenty-fifth
 * talent in this game that is a number going up, which is the count
 * `Talent.hooks` puts on the record at engine/talents.ts:1611.
 *
 * ═══ `genericPower`, WHICH IS THE ONLY FIELD THAT CAN REACH MINDPOWER ═══
 * The obvious field is `mindPower`, and it cannot be used: `AdditiveMods` is
 * `Omit<CombatMods, 'physSpeed' | 'spellPower' | 'mindPower'>`
 * (content/items.ts:217), so the three school powers are exactly what a passive
 * or a worn item is forbidden to add. `genericPower` is not omitted, and
 * `combatMindpower` folds it into `add` at engine/derived.ts:526 — so it is
 * both the correct field and the only one.
 *
 * IT RAISES ALL THREE POWERS, not just this one (Combat.lua:1693, 1748, 2060),
 * and that is stated rather than hidden. For a Redactor the other two are close
 * to inert — nothing in the class applies with spellpower or physical power —
 * so the breadth costs the game nothing here even though it would matter on a
 * hybrid.
 *
 * An earlier draft of this file raised `spellPower` and argued at length that it
 * was the same number `combatMindpower` reads. It was not; that is
 * `combatSpellpower`, a different function for a different school. The passive
 * would have compiled, shown a bonus on the sheet, and moved no mark this class
 * ever throws.
 *
 * ═══ AND THE FORMULA IS WHY THIS CLASS HAS THE TWO STATS IT HAS ═══
 * Combat.lua:2076, ported verbatim:
 *
 *     mindpower = combat_mindpower + getWil() * 0.7 + getCun() * 0.4
 *
 * It is the only power in the game fed by TWO stats, and the weights sum above
 * 1.0 — so a mind caster who splits Will and Cunning beats one who pours
 * everything into either. The Redactor's two trees gate on exactly those two
 * (`ledger/redaction` on Cunning, `ledger/testimony` on Will), which means the
 * class's stat spread is not a flavour choice laid over the engine: it is the
 * shape the engine already rewards, and this talent sits on top of it.
 */

/** Points of power. Modest at rank 1, worth a fourth point at rank 5. */
const POWER_LOW = 3;
const POWER_HIGH = 12;

function powerAt(talentLevel: number): number {
  return Math.round(combatTalentScale(talentLevel, POWER_LOW, POWER_HIGH));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT THE DOOMED HAS THAT THE REDACTOR DID NOT — cursed-form.lua:24-76.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE MEASUREMENT FIRST, BECAUSE IT IS THE WHOLE ARGUMENT. Eight runs each on
 * the Drowned Chapel's first floor, a level-1 Redactor alone, one field changed
 * at a time:
 *
 *     as shipped                              0/8   1351 damage taken
 *     + the Watchman's whole armour block     0/8   1274
 *     + 15 accuracy                           0/8   1336
 *     + double weapon damage                  0/8   1277
 *     + double hit points (108)               0/8   2027
 *     + ALL FOUR AT ONCE                      0/8   1805
 *     + regeneration                          4/8    662
 *
 * Armour does nothing. Hit points do nothing — they make the number WORSE,
 * because a bigger body survives longer to be hit more. Accuracy and damage do
 * nothing. The ONLY input that moves her is hit points coming back, and the
 * class ships with no source of them anywhere in its eighteen talents.
 *
 * ═══ AND BE HONEST ABOUT WHAT THAT LAST ROW MEASURED, BECAUSE IT IS NOT THIS ═══
 * The row that moved is `+ regeneration` — hit points arriving every turn,
 * unconditionally. What is ported below is `T_UNNATURAL_BODY`, which pays ONLY
 * ON A KILL, and a Redactor who is losing kills nothing. Toggled on its own,
 * eight runs a floor on both level-1 delves:
 *
 *                          The Undermost      The Drowned Chapel
 *     as shipped           0/8,  802 damage   0/8, 1747 damage
 *     the heal removed     0/8,  803          0/8, 1580
 *
 * It moves the damage figure and CHANGES NO OUTCOME. (A healed body lives longer
 * to be hit more, which is why the number can go the wrong way.)
 *
 * SO THE SWEEP IS THE EVIDENCE THAT SUSTAIN IS THE AXIS, AND IT IS NOT EVIDENCE
 * THAT THIS PARTICULAR SUSTAIN IS ENOUGH. It is the one the ARCHETYPE has, which
 * is why it is the one that lands — a per-turn regeneration with no condition on
 * it is not a thing upstream gives the Doomed, and inventing one to match a
 * counterfactual would be tuning to a measurement instead of porting. What the
 * archetype has that we still do not is structural and named at the bottom of
 * `REDACTOR`'s own note: `T_CALL_SHADOWS` and `T_GESTURE_OF_PAIN`.
 *
 * ═══ SO IT IS PORTED, AND FROM THE ARCHETYPE THAT ALREADY HAS IT ═══
 * The Doomed's five birth talents include `T_UNNATURAL_BODY`
 * (afflicted.lua:143), whose entire content is this: a kill banks life and the
 * body spends it back. It is NOT armour and it is not a shield — the Redactor
 * still has no answer to a stick, which is what her own class note insists on.
 * It is the frail controller's actual upstream answer: you live because you are
 * winning, and a fight you are losing gives you nothing.
 *
 * ═══ THE POOL IS COLLAPSED INTO THE KILL, AND THE ARITHMETIC IS WHY ═══
 * Upstream banks `getHealPerKill` into `unnatural_body_heal` and drains it at
 * `getRegenRate = 3 + combatTalentDamage(t, 15, 25)` per turn. Evaluated for a
 * level-1 Redactor at every rank, the rate is ALWAYS larger than the deposit:
 *
 *     rank        1      2      3      4      5
 *     per kill   10.2   13.7   16.5   18.8   20.8
 *     rate/turn  15.9   19.3   22.0   24.3   26.3   (upstream's, x2 for our turn)
 *
 * — so the pool is empty again before the next turn starts, at every rank, and
 * a pool that never holds anything is a pool with no observable behaviour. The
 * heal is applied at the kill instead. `TOME_ACTIONS_PER_TURN` is the x2 and it
 * is the same conversion `tomeCooldownToTurns` and the resource regens use.
 *
 * ═══ ONE CLAUSE NOT PORTED, AND IT NAMES THE HOOK THAT WOULD CARRY IT ═══
 *   `math.min(heal, target.max_life)` (cursed-form.lua:61) — a rat is worth a
 *     rat. `KillHook` is `(ctx, victimId)` and carries an ID, not a body, so the
 *     clamp cannot be asked. At rank 1 the figure is 10 and the smallest thing
 *     on any delve floor has more life than that, so the clamp is unreachable
 *     today; the day a 6hp vermin exists, this is the line that needs the hook
 *     widened.
 *   `updateHealingFactor` (cursed-form.lua:38-42) is not a clause of the heal
 *     and is not on this list — it halves ALL healing at 0 Hate and restores it
 *     at 100, there is no Hate and Ink is not it (Hate is spent to act and
 *     earned by being hurt; Ink is earned by marking), and porting the penalty
 *     without the resource that lifts it would be a flat 50% healing debuff
 *     wearing a citation. Stated because it is the one upstream line in this
 *     talent that is deliberately absent rather than collapsed.
 *
 * ═══ AND TWO CLAUSES THAT WERE MISSING AND ARE NOW PORTED ═══
 *   `math.min(self.life, pool + heal)` (cursed-form.lua:63) was dismissed here
 *     as "a cap on the POOL, and there is none". It is not a cap on the pool's
 *     shape — it is keyed on CURRENT LIFE, and the collapse of the pool into the
 *     kill turns `min(self.life, 0 + heal)` into `min(hp, heal)`. The hook has
 *     current life: `ctx.self.hp` is read two lines below, in the `alive` guard.
 *     Upstream's Doomed on 5 hit points banks 5; ours healed the full figure.
 *   `healing_factor = 1` (cursed-form.lua:51-54) — upstream steps around its own
 *     `onHeal` factor for this one heal and tells the player so at
 *     cursed-form.lua:73. `HealOpts.ignoreHealingFactor` is that swap. Inert
 *     today (nothing grants a player a healing mod) and live the first time a
 *     healing ego ships, which is exactly when an unstated divergence bites.
 *
 * ═══ AND THE NUMBERS ARE PINNED AT LEVEL 1, WHICH IS THE HONEST GAP ═══
 * Upstream's power term is `(self.level + self:getWil()) * 1.2`, so the heal
 * grows with character level and Willpower. `HookSelf` (engine/hooks.ts:126-134)
 * carries `hp`, `maxHp` and a position and no sheet at all, so neither is
 * readable here. `SPELL_POWER` below is that expression evaluated for the
 * Redactor AS SHE IS BORN — level 1, `wil` 22 — and it does not move afterwards.
 * `cold_reading.ts` records the same gap from the other side. The day a hook can
 * read a stat, this constant is deleted and the expression goes in its place.
 */
/** The level the figure is pinned at, and the `wil` on `REDACTOR.combat.stats`. */
const BIRTH_LEVEL = 1;
const BIRTH_WIL = 22;
/** cursed-form.lua:20-22 — the `* 1.2` in `(self.level + self:getWil()) * 1.2`. */
const POWER_FACTOR = 1.2;
const SPELL_POWER = (BIRTH_LEVEL + BIRTH_WIL) * POWER_FACTOR;
/** cursed-form.lua:32 — `combatTalentDamage(self, t, 15, 50)`. */
const HEAL_BASE = 15;
const HEAL_MAX = 50;

/** Hit points returned by one kill, at a rank. */
export function healPerKillAt(talentLevel: number): number {
  return Math.round(combatTalentSpellDamage(talentLevel, HEAL_BASE, HEAL_MAX, SPELL_POWER));
}

export const indelible: Talent = {
  id: talentId('indelible'),
  name: 'Indelible',
  classId: ClassId.Redactor,
  tree: 'ledger/redaction',
  tier: 1,
  statGate: 'cun',
  kind: TalentKind.Passive,
  iconId: 'icon_passive_indelible',
  cost: { ap: 0, resource: 0 },
  cooldownTurns: 0,
  targeting: {
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Darkness,

  passive: (level) => ({ mods: { genericPower: powerAt(level) } }),

  hooks: {
    /**
     * cursed-form.lua:59-67, minus the one clause named in `healPerKillAt`'s
     * note above. A kill returns life; nothing else does.
     */
    onKill: (ctx) => {
      // A CORPSE DOES NOT MEND — `walk_it_off.ts`'s line, for its reason: the
      // Downed system keeps a body on the board at 0 hp, and a kill landing on
      // the turn she goes down must not heal her off the floor behind the
      // rescue rules.
      if (!ctx.self.alive || ctx.self.hp <= 0) return;
      /**
       * `math.min(self.life, ...)` — cursed-form.lua:63, with the pool collapsed
       * into the kill. A body on 3 hit points banks 3, not the full figure: the
       * bank is what the body has left to give, which is what makes this a
       * reward for WINNING rather than a floor under losing.
       */
      const banked = Math.min(healPerKillAt(ctx.level), ctx.self.hp);
      // THROUGH `healActor`, WHICH IS THIS GAME'S `onHeal` — with upstream's own
      // `healing_factor = 1` (cursed-form.lua:51-54) spelled as an argument.
      healActor(ctx.self, banked, { ignoreHealingFactor: true });
    },
  },

  describe: (_self, level) =>
    `Always on. Your marks go in with ${String(powerAt(level))} more power, so more of them ` +
    `beat the save — and every kill gives you back ${String(healPerKillAt(level))} hit points. ` +
    `You live by winning; a fight you are losing pays nothing.`,
};
