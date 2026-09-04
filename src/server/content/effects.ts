// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/timed_effects/physical.lua:480-511 (STUNNED)
//                                                              :123-152 (CUT — "Bleeding")
//                                                              :621-637 (SLOW)
//             t-engine4 game/modules/tome/class/Actor.lua:606 (the no_talents_cooldown guard)
//             t-engine4 game/modules/tome/data/damage_types.lua:150-153 (stunned ×0.4 outgoing)
//             t-engine4 game/engines/default/engine/interface/ActorTemporaryEffects.lua:54
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license
//
// The badge art (ui/icons/status/icon_status_*.png) is the author's own and is NOT GPL.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    THE THREE MVP STATUSES — DATA + BEHAVIOUR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * game-design.md § 12 ships exactly three, and this is them:
 *
 *   STUNNED   physical save. FREEZES COOLDOWNS, ×0.4 outgoing damage, and puts
 *             three ready talents on a 1-turn cooldown that cannot tick.
 *   BLEEDING  physical save. Damage per turn on the BASE clock, no armour stage.
 *   SLOWED    physical save. Fewer actions for a monster; fewer points for a
 *             player. Those are two different mechanisms and § D1 is why.
 *
 * All three are `physical` because the MVP roster is a husk, a wraith and an
 * elite husk swinging and shooting. The mental and magical channels exist in
 * `SaveChannel` and are exercised by tests; nothing authored uses them yet, and
 * inventing a mental status to "balance the table" would be content nobody asked
 * for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EFFECT'S TYPE PICKS THE SAVE — NOT THE ATTACK THAT DELIVERED IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Actor.lua:6981-6986. Ashwick Flare is a fire talent and the Bleeding it could
 * apply is still resisted by the PHYSICAL save, because `type: 'physical'` is on
 * the EFFECT. The caller passes `applyPower` — a power number — and never a
 * channel. There is no parameter on `setEffect` that lets an attack choose the
 * save; the only override is `applySave` on the effect's own params, which is
 * ToME's `p.apply_save` and exists for the one-off "this poison is mental" case.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BEHAVIOUR LIVES HERE AND NOT IN engine/effects.ts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same rule content/monsters.ts follows: the engine owns the MACHINERY (saves,
 * durations, stacking, the tick) and content owns WHICH effects exist and what
 * they do. `engine/effects.ts` names none of these three. The dependency runs
 * `content → engine` and never back, which is what lets a fourth status be one
 * new object in this file.
 */

import { bound } from '../../shared/scale.ts';
import { DamageType, applyDamage } from '../engine/damage.ts';
import { healActor } from '../engine/talents.ts';
import {
  EffectStatus,
  SaveChannel,
  StackMode,
  createEffectState,
  effectModifiers,
  immunityAgainst,
  lockoutTalents,
} from '../engine/effects.ts';
import type { EffectDef, EffectHookArgs, EffectInstance, EffectState } from '../engine/effects.ts';

// ---------------------------------------------------------------------------
// Ids — namespaced, exactly like `talent:` (engine/talents.ts:171)
// ---------------------------------------------------------------------------

export const EFFECT_ID_PREFIX = 'effect:';

/**
 * The three ids, as constants rather than bare strings, so a typo is a compile
 * error at every call site instead of an effect that silently never lands.
 */
export const EffectId = {
  Stunned: 'effect:stunned',
  Bleeding: 'effect:bleeding',
  Slowed: 'effect:slowed',
  /**
   * ═══ THESE TWO ARE THE CONTENT HALF OF SOMETHING ALREADY BUILT ═══
   * `StatusFlags.scoured` and `StatusFlags.breached` have been in
   * engine/derived.ts since the defensive maths was ported — `finish()` divides
   * accuracy, defence, all three powers and all three saves by 1.2 for a scoured
   * body, and `combatArmorHardiness` halves the bound for a breached one, each
   * with its upstream line number. Both were tested. Both were unreachable,
   * because no effect in the game set either flag.
   *
   * That is the ninth time this codebase has found a finished system with no
   * content pointed at it. The expensive half was already paid for; these are
   * the cheap half.
   */
  Effaced: 'effect:effaced',
  Breached: 'effect:breached',
  /**
   * THE THIRD FLAG engine/derived.ts HAS BEEN READING WITH NOTHING TO READ.
   * `finish()` halves accuracy, defence, all three powers and all three saves
   * for a dazed body — the same eight rolls `scoured` divides, twice as hard.
   */
  Dazed: 'effect:dazed',
  /**
   * THE FIRST STATUS THAT CHANGES WHAT AN ACTION DOES RATHER THAN WHAT IT IS
   * WORTH. Every other entry on this list moves a number; this one takes the
   * step you asked for and puts it somewhere else. `mental.lua:67-87`.
   */
  Confused: 'effect:confused',
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FIRST BENEFICIAL EFFECT IN THE GAME, AND THE POINT IS THE CATEGORY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every effect above this line is `EffectStatus.Detrimental`. All six of them.
   * The engine has supported the other kind since the port — `canBe` skips the
   * immunity checks for it, `creditForLanding` refuses to pay for it, `dispel`
   * will not touch it, and the save block carries a comment reading *"A
   * beneficial effect keeps its scaled duration and is never refused"* — and no
   * content had ever pointed at any of it.
   *
   * That is the tenth time this codebase has found a finished system with
   * nothing aimed at it, and it is the most expensive one so far: ToME is built
   * out of buffs, and not one of its self-buff talents could be ported while a
   * timed effect had no way to ADD anything.
   */
  Evasive: 'effect:evasive',
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THREE CROSS-TIER EFFECTS — Combat.lua:305-309.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * One per save channel. `getTierDiff` has been in `shared/scale.ts` since the
   * port, with a full test file and this in its docblock: *"Shipped now, used at
   * M4"*. It was never used at M4 or since — `grep` finds the definition, the
   * test, and no production caller at all. The eleventh finished system in this
   * codebase with nothing pointed at it.
   *
   * What it buys is the thing a level number cannot say: when an attacker
   * outranks your save by a whole tier you take a SECOND debuff on top of
   * whatever landed, even if you shrugged the first one off. That is ToME's
   * "you have wandered somewhere you should not be" signal, and it scales with
   * the gap instead of being a wall.
   */
  OffBalance: 'effect:off_balance',
  Spellshocked: 'effect:spellshocked',
  Brainlocked: 'effect:brainlocked',
  /**
   * THE FIRST EFFECT IN THE GAME THAT PUTS HIT POINTS BACK. Everything above
   * either takes them (Bleeding) or moves a number on the sheet (Evasive), and
   * that asymmetry is why `StatusHit.healed` did not exist until now.
   *
   * `EFF_REGENERATION`, applied by the regeneration infusion
   * (inscriptions.lua:74). Upstream reaches it from several sources — infusions,
   * runes, a Wyrmic talent — and we have exactly one, which is what makes that
   * talent's `on_pre_use` clause unreachable rather than skipped. Its header
   * says so at length.
   */
  Regeneration: 'effect:regeneration',
  /**
   * THE FIRST POSITIVE `all` ROW IN THE GAME. `SPELLSHOCKED` has carried a
   * NEGATIVE one since the cross-tier trio landed, and `Wielder.resistAll`
   * exists for exactly that — `validateItems` refuses it on gear and says why:
   * "only an effect may move `all`". This is the effect that finally moves it
   * the other way.
   */
  PainSuppression: 'effect:pain_suppression',
  /**
   * THE FIRST THING THAT MOVES `healing_factor`. `derived.ts`'s note has said
   * "other sources can push it outside the range" since the defensive maths was
   * ported, and there were none — the factor was Constitution and nothing else.
   */
  EmpoweredHealing: 'effect:empowered_healing',
  /**
   * THE ONLY EFFECT THAT CHANGES WHAT A TALENT COSTS. Everything else here
   * changes what a body IS; this changes the price of acting.
   */
  HighbornsBloom: 'effect:highborns_bloom',
  /**
   * THE ONLY EFFECT THAT WRITES FOUR CHANNELS AT ONCE, and the first to move
   * `armourHardiness` from anywhere but worn gear and a sustain.
   */
  ArchivalResilience: 'effect:archival_resilience',
  /**
   * THE ONLY EFFECT THAT MOVES BOTH `all` ROWS — offence and defence at once,
   * by the same number, and they do not compose the same way downstream.
   */
  EternalWrath: 'effect:eternal_wrath',
  /**
   * THE ONLY EFFECT THAT MOVES ALL THREE SAVES AT ONCE, and the only one that
   * touches critical chance at all.
   */
  FootnotedLuck: 'effect:footnoted_luck',
} as const;
export type EffectId = (typeof EffectId)[keyof typeof EffectId];

// ---------------------------------------------------------------------------
// Authored numbers. Every one of them has a source.
// ---------------------------------------------------------------------------

/**
 * ToME's SLOW default — physical.lua:628, `parameters = { power = 0.1 }`, used
 * as `global_speed_add = -eff.power`.
 *
 * 0.3 rather than 0.1 because the MVP fight is three turns long (see the
 * placeholder vitals in engine/actor.ts) and a 10% speed cut over three turns is
 * invisible. AUTHORED DEVIATION, recorded rather than discovered in playtest.
 */
export const SLOW_POWER = 0.3;

/**
 * ToME's CUT default — physical.lua:130, `parameters = { power = 1 }`.
 *
 * 1 damage per turn is a ToME level-1 rat's bleed and it is not a threat here:
 * a monster has 24 HP (engine/actor.ts) and a detective's swing already deals
 * ~4.4 (test/server/derived.test.ts). 3 keeps a bleed worth applying without
 * making it better than swinging again.
 */
export const BLEED_POWER = 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW OFTEN A CONFUSED BODY GETS IT WRONG — `mental.lua:74`, `power = 50`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's own default and upstream's own ceiling: `activate` runs
 * `util.bound(eff.power, 0, 50)` (`mental.lua:79`), so fifty percent is the most
 * confusion ToME will ever apply however it was rolled. Taken unchanged.
 *
 * ═══ WHY IT IS NOT TURNED DOWN FOR BEING HARSH ═══
 * A coin flip on every step reads as enormous, and the instinct is to soften it
 * to twenty. That would be the wrong edit twice over: it is the number fifteen
 * years of play settled on, and — more to the point here — the DURATION is what
 * this game controls. A two-turn confusion at fifty percent is a scare; a
 * ten-turn one is a death sentence. Tune the turns at the call site, not the
 * chance, so the mechanic keeps meaning what it means everywhere else.
 */
export const CONFUSE_POWER = 50;

/**
 * The least confusion this path may leave — `mental.lua:78`'s `math.max(..., 10)`.
 *
 * However much `confusion_immune` is worn, the POWER never falls below one step
 * in ten. Total immunity is `canBe`'s job (it refuses the effect outright), and
 * keeping the two apart is what stops a single deep affix from quietly deleting
 * a status the bestiary is built around.
 */
export const CONFUSE_FLOOR = 10;

/**
 * physical.lua:500 — `for i = 1, 3 do ... end`. Three talents, not four.
 *
 * Paired with :503's 1-turn cooldown and the freeze: the lockout lasts exactly
 * as long as the stun and releases on the turn it ends. Upstream's own comment
 * at :503 explains it — "Just set cooldown to 1 since cooldown does not decrease
 * while stunned".
 */
export const STUN_TALENT_LOCKOUT = 3;

/** physical.lua:493 — `movement_speed`, −0.5. Carried as data; see the note below. */
export const STUN_MOVEMENT_SPEED_ADD = -0.5;

/**
 * game-design.md § 7 — "Slowed (−1 MP)", and § 8's item note: "35% slow/2 s →
 * −1 MP for 2 turns, because a percentage is illegible on a grid."
 *
 * A player cannot be slowed on the clock (D1), so this is the player-facing
 * expression of the same effect. One movement point, which on a 30×30 room is
 * the difference between reaching the downed ally this turn and not.
 */
export const SLOW_PLAYER_MP_PENALTY = 1;

/**
 * Slow costs a player NO action points by default.
 *
 * The AP budget is what a player spends on TALENTS, and taking a point of it
 * would silently disable whichever talent sits at the top of their cost curve —
 * a much larger and much less legible nerf than losing a tile of movement. The
 * knob exists (`EffectModifiers.apPenalty`) and a future effect can use it; slow
 * is not that effect.
 */
export const SLOW_PLAYER_AP_PENALTY = 0;

// ---------------------------------------------------------------------------
// STUNNED — physical.lua:480-511
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STUNNED. THE FREEZE IS THE WHOLE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * newEffect{
 *   name = "STUNNED", image = "effects/stunned.png",
 *   type = "physical", subtype = { stun=true }, status = "detrimental",
 *   activate = function(self, eff)
 *     eff.tmpid   = self:addTemporaryValue("stunned", 1)                -- :491
 *     eff.tcdid   = self:addTemporaryValue("no_talents_cooldown", 1)    -- :492
 *     eff.speedid = self:addTemporaryValue("movement_speed", -0.5)      -- :493
 *     ...
 *     for i = 1, 3 do
 *       local t = rng.tableRemove(tids)
 *       self:startTalentCooldown(t.id, 1)                              -- :503
 *     end
 *   end,
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `no_talents_cooldown` — line 492, and tome/class/Actor.lua:606 is where it bites
 * ───────────────────────────────────────────────────────────────────────────
 * ```lua
 * -- Cooldown talents after effects, because some of them involve breaking sustains.
 * if not self:attr("no_talents_cooldown") then self:cooldownTalents() end
 * ```
 * A stunned actor's cooldowns DO NOT TICK. Miss this one line and stun is a
 * damage debuff you wait out with a full bar of talents ready — which is a
 * completely different game from the one where a 3-turn stun costs the victim
 * three turns of cooldown progress on top of three turns of acting.
 *
 * It arrives here as `modifiers.noTalentsCooldown`, is aggregated by
 * `noTalentsCooldown(state, actorId)`, and is consumed by
 * `engine/actor.ts#actBase` via the `statusPass` callback. The read happens
 * AFTER `timedEffects` (tome/class/Actor.lua:597 before :606), so the turn a stun expires
 * is a turn cooldowns tick normally.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE THREE-TALENT LOCKOUT AND THE 1-TURN COOLDOWN CONSPIRE
 * ───────────────────────────────────────────────────────────────────────────
 * :503 sets those three to cooldown 1 — a number that would normally clear on
 * the very next base turn. It does not, because the freeze above stops it
 * ticking. So the lockout is exactly as long as the stun, self-timing, with no
 * second duration to keep in sync. It is a genuinely elegant trick and it only
 * works if BOTH halves are ported.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT `stunned` DOES TO DAMAGE — damage_types.lua:150-153
 * ───────────────────────────────────────────────────────────────────────────
 * `if src:attr("stunned") then dam = dam * 0.4 end`. A flat ×0.4 on OUTGOING
 * damage, applied in the projector, not in any getter. `recomputeAttributes`
 * writes it to `StatusFlags.stunned`; combat.ts:356 reads it as `sourceStunned`;
 * damage.ts applies it at step 5. Nothing needs to be added for that to work —
 * derived.ts's `StatusFlags` was wired at M3 for precisely this moment.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NOT PORTED: `movement_speed`, and it is declared anyway
 * ───────────────────────────────────────────────────────────────────────────
 * :493's −50% movement speed has nothing to multiply here — a move is one
 * action, and there is no separate movement cost to halve. The number is
 * carried as `movementSpeedAdd` so the port is complete on paper and so the day
 * movement gets its own cost, the value is already sitting where it belongs.
 * Deleting it would make the omission invisible.
 */
export const STUNNED: EffectDef = Object.freeze({
  id: EffectId.Stunned,
  badge: 'St',
  displayName: 'Stunned',
  description:
    'Reeling. Deals 40% damage, and talent cooldowns do not tick while it lasts. ' +
    'Three ready talents are locked out for the duration.',
  // Actor.lua:6981-6986 — THIS is what picks the save. `physical` → combatPhysicalResist.
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  // physical.lua has no `on_merge` for STUNNED, so upstream's default applies:
  // remove and re-add (ActorTemporaryEffects.lua:128). A re-stun REPLACES.
  stackMode: StackMode.Refresh,
  // physical.lua:485 — `subtype = { stun=true }`.
  subtypes: ['stun'],
  // ActorTemporaryEffects.lua:54 — the default.
  decrease: 1,
  icon: 'icon_status_stunned',
  modifiers: {
    // :491 — the ×0.4 outgoing damage flag (damage_types.lua:150-153).
    stunned: true,
    // :492 — THE FREEZE. tome/class/Actor.lua:606.
    noTalentsCooldown: true,
    // :493 — carried, not yet read. See the header.
    movementSpeedAdd: STUN_MOVEMENT_SPEED_ADD,
  },
  parameters: {},

  activate: ({ actor, eff, rng, ctx }: EffectHookArgs): void => {
    // physical.lua:495-504. `ctx.activatableTalents` is the seam: this file must
    // not import the talent engine, and the talent engine must not know about
    // statuses. The scheduler supplies the reader when it builds the context.
    const candidates = ctx.activatableTalents?.(actor.id) ?? [];
    const locked = lockoutTalents(
      actor,
      candidates,
      STUN_TALENT_LOCKOUT,
      rng,
      `effects.stunned.lockout.${actor.id}`,
    );
    // Recorded on the instance so the Case Log can name the talents that went
    // dark — "Bent Watchman is Stunned 2 turns (Gutting Strike, Lunge locked)".
    eff.params.power = locked.length;
  },
} satisfies EffectDef);

// ---------------------------------------------------------------------------
// BLEEDING — physical.lua:123-152 (upstream's `CUT`)
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLEEDING. DAMAGE ON THE BASE CLOCK, AND NO ARMOUR STAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream calls the effect `CUT` and displays it as "Bleeding"
 * (physical.lua:124-125). The id here is `effect:bleeding` because that is the
 * word on the badge and in the design doc; the citation keeps the trail.
 *
 * ```lua
 * on_merge = function(self, old_eff, new_eff)                    -- :133-141
 *   local olddam = old_eff.power * old_eff.dur
 *   local newdam = new_eff.power * new_eff.dur
 *   local dur = math.ceil((old_eff.dur + new_eff.dur) / 2)
 *   old_eff.dur = dur
 *   old_eff.power = (olddam + newdam) / dur
 *   return old_eff
 * end,
 * on_timeout = function(self, eff)                               -- :149-151
 *   DamageType:get(DamageType.PHYSICAL).projector(eff.src or self, self.x, self.y,
 *                                                 DamageType.PHYSICAL, eff.power)
 * end,
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MERGE CONSERVES TOTAL DAMAGE. IT DOES NOT STACK IT.
 * ───────────────────────────────────────────────────────────────────────────
 * Two bleeds of 3 damage × 4 turns do not become 6 × 4. They become
 * `dur = ceil(8/2) = 4`, `power = (12 + 12) / 4 = 6` — the same 24 total,
 * delivered in the same window. Applying a bleed to something already bleeding
 * FRONT-LOADS it; it never multiplies it. That is what stops a bleed class from
 * being a stacking-DoT class, and it is four lines of arithmetic that look
 * arbitrary until you multiply them out.
 *
 * Worked, and pinned in the test: old {power 3, dur 4} + new {power 3, dur 4} →
 * `olddam 12`, `newdam 12`, `dur ceil(4) = 4`, `power 24/4 = 6`.
 * Uneven: old {power 3, dur 1} + new {power 9, dur 5} → `3 + 45 = 48`,
 * `dur = ceil(6/2) = 3`, `power = 16`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * "IGNORES ARMOUR" IS FAITHFUL, NOT A DEVIATION
 * ───────────────────────────────────────────────────────────────────────────
 * game-design.md § 7 says Bleeding ignores armour, and so does ToME — but not by
 * a special case. The DoT goes through the damage-type PROJECTOR, and the
 * armour stage lives in `attackTargetWith`, never in the projector
 * (engine/damage.ts's header says so: "a spell has never been reduced by armour
 * in ToME's entire history"). Passing no `armour` in the spec below is therefore
 * the port, not a shortcut. RESISTANCES still apply, because those ARE in the
 * projector, so physical resistance shortens a bleed's total exactly as it
 * shortens everything else.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ON THE BASE CLOCK, WHICH IS THE ONLY REASON A DoT IS BALANCEABLE
 * ───────────────────────────────────────────────────────────────────────────
 * `on_timeout` is driven by `timedEffects`, which runs in `actBase`
 * (tome/class/Actor.lua:597) on `energyBase`. So "3 damage per turn for 4 turns" is 12
 * damage at ANY speed. Put it on the act clock and a hasted target takes 40%
 * more from the same bleed while a slowed one takes less — a DoT that rewards
 * the victim for being slowed is the wrong direction on every axis.
 *
 * ZERO RNG DRAWS PER TICK: the spec below carries no `damageRange` and no
 * `critChance`, so `resolveDamage` rolls nothing (engine/damage.ts steps 1 and
 * 3 are both gated on presence). A bleed's damage is exact, which is what makes
 * the merge arithmetic above mean anything.
 */
export const BLEEDING: EffectDef = Object.freeze({
  id: EffectId.Bleeding,
  badge: 'Bl',
  displayName: 'Bleeding',
  description: 'An open wound. Deals physical damage each turn, unreduced by armour.',
  // physical.lua:127. The save is PHYSICAL because the EFFECT is physical —
  // even when an Ashwick Flare put it there.
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  // physical.lua:133 declares `on_merge`, which is upstream's stacking path
  // (ActorTemporaryEffects.lua:123-125).
  stackMode: StackMode.Stack,
  // physical.lua:128 — `subtype = { wound=true, cut=true, bleed=true }`. THREE
  // keys, and `canBe` multiplies the actor's resistance to each of them.
  subtypes: ['wound', 'cut', 'bleed'],
  decrease: 1,
  icon: 'icon_status_bleeding',
  // physical.lua:130 — `parameters = { power = 1 }`. See BLEED_POWER.
  parameters: { power: BLEED_POWER },

  onTimeout: ({ actor, eff, rng, ctx }: EffectHookArgs): boolean => {
    const power = eff.params.power ?? BLEED_POWER;
    if (power <= 0) return false;

    // physical.lua:150 — `eff.src or self`. The bleeder is blamed when it is
    // still around; otherwise the wound blames its owner, so the Case Log always
    // has a name and a kill is always attributable.
    const srcId = eff.params.srcId;
    const src = srcId === undefined ? undefined : ctx.getActor?.(srcId);
    const blame = src ?? actor;

    // damage_types.lua:146-153 — the projector applies the SOURCE's own daze and
    // stun multipliers to every projected hit, DoTs included. Faithful and
    // slightly surprising: stunning the thing that cut you weakens its bleed.
    const outcome = applyDamage(actor, power, DamageType.Physical, blame, rng, {
      // Dazed, Stunned and `numbed` come off `source.combat` inside
      // `applyDamage` now. This passed the first two and never `numbed`.
      increase: src?.combat?.increase,
      penetration: src?.combat?.penetration,
    });

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND SAY WHAT IT DID. THE RETURN USED TO BE DISCARDED ENTIRELY.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * TWO THINGS WENT MISSING WITH IT, and they are the same omission:
     *
     *   THE LINE.  Ours derives the `damage` frame from the ACTION OUTCOME a
     *              blow produces (`hitToWire`). A bleed produces no outcome, so
     *              a death by bleeding was one bare sentence with no number, no
     *              hp and no cause. Upstream has no such gap because it logs at
     *              the PROJECTOR — `takeHit` then `"%d %s"`, the same path for a
     *              sword and a wound (damage_types.lua:491-501).
     *   THE BODY.  `applyDamage` set `alive = false` and returned `killed`, and
     *              nothing buried it: 0 hp, still on its tile, unpaid, and
     *              counted by whatever asks if the site is clear.
     *
     * So the hit is reported and the death is a flag on it, which is the order
     * it happens in. See `EffectCtx.noteDamage` for the measurement.
     *
     * THE BLAME IS `srcId`, NOT `blame`. `blame` falls back to the VICTIM so the
     * damage always has a name to print (physical.lua:150, `eff.src or self`),
     * and passing that here would credit a husk with bleeding itself out.
     *
     * SAID EXACTLY: `awardExperience` would refuse it anyway — it returns early
     * for a killer that is a monster, and says at length why that check precedes
     * every `party.ts` call — so this is DEFENCE IN DEPTH rather than the only
     * thing standing between a corpse and a level. What it does buy on its own
     * is that `talents.noteKill` is not fired on a dead husk's id, and that null
     * means "nobody is owed for this", which is not the same claim as "the
     * victim is owed for this".
     */
    if (outcome.dealt > 0 || outcome.killed) {
      ctx.noteDamage?.({
        victimId: actor.id,
        sourceId: srcId ?? null,
        amount: outcome.dealt,
        hp: actor.hp,
        maxHp: actor.maxHp,
        killed: outcome.killed,
        // FROM THE OUTCOME, NOT FROM THE CONSTANT ABOVE. The projector applies
        // resists and the source's own modifiers, and it is what the arithmetic
        // actually resolved as — re-stating `DamageType.Physical` here would be
        // a second copy of a fact one line away.
        type: outcome.type,
        crit: outcome.crit,
      });
    }

    // ActorTemporaryEffects.lua:85 — returning true removes the effect. A bleed
    // never self-terminates; it runs its duration out.
    return false;
  },

  /**
   * physical.lua:133-141, verbatim arithmetic.
   *
   * `Math.ceil` on the average duration matches `math.ceil` exactly for the
   * positive values a duration can hold. `dur` is guaranteed ≥ 1 here because
   * `setEffect` refuses a 0-duration application before it ever reaches a merge.
   */
  onMerge: ({ eff, incoming }: EffectHookArgs & { incoming: EffectInstance }): EffectInstance => {
    const oldPower = eff.params.power ?? BLEED_POWER;
    const newPower = incoming.params.power ?? BLEED_POWER;
    const oldDam = oldPower * eff.dur; // :135
    const newDam = newPower * incoming.dur; // :136
    const dur = Math.ceil((eff.dur + incoming.dur) / 2); // :137
    eff.dur = dur; // :138
    eff.params.power = (oldDam + newDam) / dur; // :139
    // Not upstream: `total_dur` is this codebase's UI bar denominator and a
    // merge that left it stale would draw a bar longer than the effect.
    eff.totalDur = Math.max(eff.totalDur, dur);
    return eff; // :140
  },
} satisfies EffectDef);

// ---------------------------------------------------------------------------
// SLOWED — physical.lua:621-637 (upstream's `SLOW`)
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SLOWED. TWO MECHANISMS, ONE EFFECT, AND THE ASYMMETRY IS D1.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * newEffect{
 *   name = "SLOW", image = "talents/slow.png",
 *   type = "physical", subtype = { slow=true }, status = "detrimental",
 *   parameters = { power = 0.1 },
 *   activate   = function(self, eff) eff.tmpid = self:addTemporaryValue("global_speed_add", -eff.power) end,  -- :632
 *   deactivate = function(self, eff) self:removeTemporaryValue("global_speed_add", eff.tmpid) end,            -- :635
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MONSTERS: `global_speed_add`, WHICH IS THE GAIN KNOB
 * ───────────────────────────────────────────────────────────────────────────
 * ToME subtracts from `global_speed`, the multiplier on energy GAINED per tick.
 * engine/actor.ts names the same thing `globalSpeed`, so the port is direct:
 * `globalSpeedAdd: -0.3` means a slowed monster accrues 70 energy per tick
 * instead of 100 and acts roughly seven times in ten game turns.
 *
 * ═══ DO NOT REACH FOR `speedFactor` ═══
 * `speedFactor` is the ACTION COST multiplier, and it runs the OTHER WAY:
 * smaller is cheaper is FASTER. "Slow reduces speedFactor" is the single most
 * plausible-sounding way to write this backwards, and the symptom is a slowed
 * monster that acts MORE often — with no crash, no type error and no failing
 * test. derived.ts issues the same warning about `combatSpeed` for the same
 * reason. If a future effect must use the cost knob, it ADDS to it.
 *
 * The write goes through `recomputeAttributes`, which composes every live
 * effect's `globalSpeedAdd` on top of a snapshot of the monster's own base
 * speed and floors the result at 0.1 (mirroring Combat.lua:1409's floor) so a
 * stacked slow can never stop the clock outright. Two slows landing and one
 * expiring leaves the survivor's full value, which is exactly the case ToME's
 * `addTemporaryValue`/`removeTemporaryValue` handle pairs exist to get right.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PLAYERS: −1 MP, BECAUSE THE CLOCK IS NOT AVAILABLE (DECISIONS.md § D1)
 * ───────────────────────────────────────────────────────────────────────────
 * A player's `globalSpeed` is the literal type `1` and readonly. That is not
 * fussiness — it is what keeps the party PHASE-LOCKED so the barrier parks once
 * per turn at full quorum. Slow a player on the clock and four people drift out
 * of phase: the scheduler starts parking with quorum 1, 2, 3, 2, 1, and the
 * solo-Bell exemption fires on the single-player parks while three people sit
 * frozen watching one person think. engine/actor.ts works the arithmetic.
 *
 * So a slowed player loses a MOVEMENT POINT instead — game-design.md § 7's
 * "Slowed (−1 MP)", and § 8's item note spelling out the reasoning: "35%
 * slow/2 s → −1 MP for 2 turns, because a percentage is illegible on a grid."
 * One fewer tile of reach on a 30×30 room is a real cost with a legible number,
 * and it costs the barrier nothing.
 *
 * ═══ THE PENALTY IS A QUERY, NOT A SUBTRACTION ═══
 * `talentEngine.actBase` refills the budget every game turn
 * (`sheet.ap = sheet.maxAp; sheet.mp = sheet.maxMp;`), so anything subtracted
 * from `sheet.mp` when the effect LANDS is erased at the start of the next turn.
 * The caller therefore applies `budgetPenalty(state, actorId)` immediately after
 * that refill. That is the one integration line this effect needs, and it is
 * stated here because it is the only place anyone will look for it:
 *
 * ```ts
 * talents.actBase(actor.id, world);
 * const { ap, mp } = budgetPenalty(effects, actor.id);
 * sheet.ap = Math.max(0, sheet.ap - ap);
 * sheet.mp = Math.max(0, sheet.mp - mp);
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NO `activate` / `deactivate` HOOKS HERE, DELIBERATELY
 * ───────────────────────────────────────────────────────────────────────────
 * Upstream needs them because `addTemporaryValue` is a handle protocol.
 * `recomputeAttributes` re-derives from a baseline after every state change
 * instead, so the modifier below is the entire implementation — nothing to
 * forget to reverse, and nothing that leaks if a hook throws mid-turn.
 */
export const SLOWED: EffectDef = Object.freeze({
  id: EffectId.Slowed,
  badge: 'Sl',
  displayName: 'Slowed',
  description: 'Dragging. Monsters act less often; detectives lose a point of movement.',
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  // physical.lua declares no `on_merge` for SLOW → upstream replaces (:128).
  stackMode: StackMode.Refresh,
  // physical.lua:626 — `subtype = { slow=true }`.
  subtypes: ['slow'],
  decrease: 1,
  icon: 'icon_status_slowed',
  modifiers: {
    // :632 — `addTemporaryValue("global_speed_add", -eff.power)`. NEGATIVE.
    // Monsters only; `recomputeAttributes` refuses to write a player's clock.
    globalSpeedAdd: -SLOW_POWER,
    // The player half. See the asymmetry note above.
    mpPenalty: SLOW_PLAYER_MP_PENALTY,
    apPenalty: SLOW_PLAYER_AP_PENALTY,
  },
  // :628 — `parameters = { power = 0.1 }`. Kept so the log and the tooltip can
  // print the fraction; the modifier above is what the engine reads.
  parameters: { power: SLOW_POWER },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EFFACED — everything you do, done slightly worse.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from t-engine4 data/timed_effects/physical.lua:28-46,
 * `ITEM_ANTIMAGIC_SCOURED` — the effect that sets the `scoured` attribute
 * upstream, and the only thing in the whole module that does:
 *
 *     activate = function(self, eff)
 *         self:effectTemporaryValue(eff, "scoured", 1)
 *     end,
 *
 * The engine half was already here. `finish()` in engine/derived.ts is the two
 * lines every getter routes through, and its second line is
 * `if (c.flags?.scoured === true) d = d / 1.2` — accuracy, defence, physical,
 * spell and mind power, and all three saves, each citing Combat.lua:1359, 1371,
 * 1380, 1388, 1396. Nothing set the flag, so none of it ever ran in play.
 *
 * ═══ ONE NUMBER, APPLIED EVERYWHERE, WHICH IS WHY IT READS AS DREAD ═══
 * A 17% cut to a single stat is invisible. The same cut to EVERY roll you make
 * and every roll you resist is a fight that has quietly stopped going your way,
 * and a player who checks the badge finds out why. That breadth is exactly what
 * makes it the right thing for a ranged elite to open with rather than close on.
 *
 * ═══ THE SUBTYPE IS UPSTREAM'S, NOT OURS ═══
 * `acid` is a poor fit for an archive, and it stays because subtypes are what
 * immunities match on. Inventing a stylish one nothing checks would make this
 * effect unresistable by any future immunity that mirrors ToME's — which is the
 * same silent-inertness this effect exists to fix.
 */
export const EFFACED: EffectDef = Object.freeze({
  id: EffectId.Effaced,
  badge: 'Ef',
  displayName: 'Effaced',
  description: 'Rubbed out at the edges. Every roll you make and every roll you resist is worse.',
  // physical.lua:31 — `type = "physical"`.
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  // physical.lua declares no `on_merge` → upstream replaces.
  stackMode: StackMode.Refresh,
  // physical.lua:32 — `subtype = { acid=true }`.
  subtypes: ['acid'],
  decrease: 1,
  icon: 'icon_status_effaced',
  modifiers: {
    // The flag engine/derived.ts has been reading since the port. `finish()`
    // divides by 1.2; there is no power parameter to scale, upstream or here.
    scoured: true,
  },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BREACHED — your armour stops doing half of its job.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from t-engine4 data/timed_effects/magical.lua:3210-3235, `EFF_BREACH`:
 * *"The target's defenses have been breached, reducing armor hardiness, stun,
 * pin, blindness, and confusion immunity by 50%."*
 *
 * ═══ THE HARDINESS HALF ONLY, AND THAT IS THE WHOLE EFFECT HERE ═══
 * Upstream also halves four immunities. This engine has no immunity attribute
 * to halve — `SetEffectOutcome.Immune` is a boolean answer from the save roll,
 * not a percentage anything could scale. Porting the other four would mean
 * inventing a system to weaken, so they are stated as absent rather than
 * silently dropped. The hardiness line is the one that already exists:
 * `combatArmorHardiness` (engine/derived.ts) reads `c.flags?.breached` and
 * multiplies by 0.5 AFTER the 0-100 bound, verbatim from Combat.lua:1334.
 *
 * ═══ AFTER THE BOUND MATTERS MORE THAN IT LOOKS ═══
 * Hardiness is what fraction of a blow armour is allowed to touch, and it is
 * clamped to 0-100 before this halving. Applying it after lets a breached body
 * sit below the band's floor entirely, which is upstream's behaviour and the
 * reason heavy armour does not merely get worse — it gets bypassed.
 *
 * MAGICAL CHANNEL, upstream's `type = "magical"`, so it is resisted by the save
 * that has the least to do with how much armour you are wearing. Being
 * overwritten is not something you shrug off by being sturdy.
 */
export const BREACHED: EffectDef = Object.freeze({
  id: EffectId.Breached,
  badge: 'Br',
  displayName: 'Breached',
  description: 'Something got through. Armour turns away half of what it should.',
  // magical.lua:3214 — `type = "magical"`.
  type: SaveChannel.Magical,
  status: EffectStatus.Detrimental,
  // magical.lua:3219-3222 — `on_merge` sets `old_eff.dur = new_eff.dur`.
  stackMode: StackMode.Refresh,
  // magical.lua:3215 — `subtype = { temporal=true }`.
  subtypes: ['temporal'],
  decrease: 1,
  icon: 'icon_status_breached',
  modifiers: {
    // Combat.lua:1334, via `combatArmorHardiness` — a 0.5 multiplier applied
    // after the bound. The flag has been read by that getter all along.
    breached: true,
  },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DAZED — everything halved, until somebody hits you.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from t-engine4 data/timed_effects/physical.lua:558-575, `EFF_DAZED`:
 *
 *     activate = function(self, eff)
 *         self:effectTemporaryValue(eff, "dazed", 1)
 *         self:effectTemporaryValue(eff, "never_move", 1)
 *     end,
 *
 * *"The target is dazed, rendering it unable to move, halving all damage done,
 * defense, saves, accuracy, spell, mind and physical power. Any damage will
 * remove the daze."*
 *
 * ═══ THE HALVING IS THE PART THAT WAS ALREADY BUILT ═══
 * `finish()` in engine/derived.ts opens with
 * `if (c.flags?.dazed === true) d = d / 2`, and every getter that matters runs
 * through it. It has been there since the defensive maths was ported and no
 * effect in the game set the flag, so it had never once run.
 *
 * ═══ AND "ANY DAMAGE REMOVES IT" IS NOT OPTIONAL FLAVOUR ═══
 * It is the reason upstream can hand out a debuff this strong. Three turns of
 * halved everything sounds oppressive and almost never happens, because in a
 * real fight nobody gets three untouched turns. Porting the numbers without
 * this rule would produce a citation that is true line by line and false as a
 * whole — so `breaksOnDamage` was built for this effect, and rides on
 * `noteStruck`, which already fires on exactly upstream's condition.
 *
 * ═══ `never_move` IS ABSENT, AND STATED RATHER THAN DROPPED ═══
 * This engine has no movement-prohibition attribute. The nearest thing is
 * `mpPenalty`, and spending it here would be a lie of a different shape: a
 * player at 0 MP is a player who cannot step, but a MONSTER moves on the
 * actor's budget and would be untouched, so the same effect would mean two
 * different things depending on who wore it. A dazed body is slower to act and
 * worse at everything; it is not rooted. Rooting arrives when there is an
 * attribute for it.
 */
export const DAZED: EffectDef = Object.freeze({
  id: EffectId.Dazed,
  badge: 'Dz',
  displayName: 'Dazed',
  description: 'Reeling. Every roll you make and every roll you resist is halved.',
  // physical.lua:562 — `type = "physical"`.
  type: SaveChannel.Physical,
  status: EffectStatus.Detrimental,
  // physical.lua declares no `on_merge` for DAZED → upstream replaces.
  stackMode: StackMode.Refresh,
  // physical.lua:563 — `subtype = { stun=true }`. Kept verbatim: subtypes are
  // what immunities match on, and a daze IS a stun as far as upstream's
  // `canBe("stun")` check is concerned — which is the check that gates it.
  subtypes: ['stun'],
  decrease: 1,
  icon: 'icon_status_dazed',
  // physical.lua:561 — "Any damage will remove the daze."
  breaksOnDamage: true,
  modifiers: {
    // The flag `finish()` has been reading since the port. Halves the eight.
    dazed: true,
  },
} satisfies EffectDef);

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/** Every MVP status, in a fixed order — for iteration that must be reproducible. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVASIVE — you saw it coming.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from t-engine4 data/timed_effects/physical.lua's `EFF_EVASION`, the
 * effect `technique/mobility`'s Evasion applies (mobility.lua:205-228):
 * *"Your quick wit and reflexes allow you to anticipate attacks against you,
 * granting you a %d%% chance to evade melee and ranged attacks and %d increased
 * defense for %d turns."*
 *
 * ═══ THE DEFENCE HALF ONLY, AND IT IS STATED RATHER THAN DROPPED ═══
 * Upstream grants a flat evade CHANCE as well as defence. This engine has no
 * evade attribute — `checkHit` is accuracy against defence and there is no
 * second roll for it to short-circuit — so porting the chance would mean
 * inventing a mechanic to hang it on. `BREACHED` above records the identical
 * decision in the identical words for the four immunities it does not halve:
 * the missing half is written down, not quietly dropped.
 *
 * Defence is the half that already exists, and it is the half that carries the
 * talent's meaning: a body that is harder to connect with for a few turns.
 *
 * ═══ NO SAVE, NO CHANNEL THAT MATTERS ═══
 * Nothing resists a buff. `canBe` only consults immunities for a detrimental
 * effect, and `applySave` only rolls for one, so `type` here is a label for the
 * badge rather than a gate. Physical is upstream's own subtype.
 *
 * ═══ WHERE THE NUMBER COMES FROM ═══
 * `params.power`, which the talent hands over at cast time. Upstream scales its
 * defence on talent level AND Dexterity (`combatScale(getTalentLevel * getDex,
 * ...)`); ours scales on rank alone, because a stat-scaled talent number is a
 * separate decision this codebase has not taken anywhere else yet.
 */
export const EVASIVE: EffectDef = Object.freeze({
  id: EffectId.Evasive,
  badge: 'Ev',
  displayName: 'Evasive',
  description: 'You saw it coming. Harder to land a blow on.',
  type: SaveChannel.Physical,
  status: EffectStatus.Beneficial,
  // physical.lua's EFF_EVASION declares no `on_merge`, so a re-cast replaces.
  stackMode: StackMode.Refresh,
  subtypes: ['evasion'],
  decrease: 1,
  icon: 'icon_status_evasive',
  /**
   * THE FIRST USE OF `EffectDef.wielder` — the block a worn item returns, folded
   * by `recomposeCombat` with the same `composeWielders` gear and passives go
   * through. A buff is a passive with a clock on it.
   */
  wielder: (instance) => ({ mods: { def: Number(instance.params['power'] ?? 0) } }),
} satisfies EffectDef);

// ---------------------------------------------------------------------------
// THE CROSS-TIER TRIO — Combat.lua:295-322, one per save channel
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE THREE SHARE, AND WHY THEY ARE AUTHORED TOGETHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * None of them is ever applied by a talent, a monster or an item. The engine
 * applies them, from `crossTierEffect`, when an attacker's apply power outranks
 * the defender's save on that channel by a whole twenty-point tier. Each one
 * DECLARES its channel via `crossTierFor` and `createEffectState` indexes it —
 * `engine/effects.ts` never names an authored id.
 *
 * All three carry `noCtEffect`, so a cross-tier effect can never trigger
 * another one, and all three take `subtypes: ['cross tier']` from upstream's
 * `subtype = { ["cross tier"]=true }`. That subtype is deliberately NOT in
 * `IMMUNITY_KEYS`: upstream sells no cross-tier immunity, and an affix that
 * removed the game's "you are outclassed" signal would be the strongest
 * defensive roll in the game by a distance.
 *
 * `StackMode.Refresh` for all three — upstream declares no `on_merge` on any of
 * them, so ActorTemporaryEffects.lua:128's default applies: remove and re-add.
 * A second cross-tier hit REPLACES rather than extends, which matters because
 * the duration is the tier gap and the newest gap is the true one.
 */

/** physical.lua:1858 — `numbed` 15, i.e. 15% off everything you deal. */
export const OFF_BALANCE_NUMBED = 15;

export const OFF_BALANCE: EffectDef = Object.freeze({
  id: EffectId.OffBalance,
  badge: 'Ob',
  displayName: 'Off-balance',
  description: 'Badly off balance. You deal 15% less damage until you recover your footing.',
  type: SaveChannel.Physical,
  crossTierFor: SaveChannel.Physical,
  noCtEffect: true,
  status: EffectStatus.Detrimental,
  stackMode: StackMode.Refresh,
  subtypes: ['cross tier'],
  decrease: 1,
  icon: 'icon_status_off_balance',
  /**
   * physical.lua:1864-1866 — `addTemporaryValue("numbed", 15)`. Through the
   * wielder channel rather than a `modifiers` flag, because `numbed` is a
   * PERCENTAGE and `EffectModifiers` carries flags and speeds; `CombatMods` is
   * where a number that the damage projector reads off the sheet belongs.
   */
  wielder: () => ({ mods: { numbed: OFF_BALANCE_NUMBED } }),
} satisfies EffectDef);

/** magical.lua:1975 — `parameters = { power=20 }`, applied as `resists.all`. */
export const SPELLSHOCK_RESIST = 20;

export const SPELLSHOCKED: EffectDef = Object.freeze({
  id: EffectId.Spellshocked,
  badge: 'Ss',
  displayName: 'Spellshocked',
  description:
    'Overwhelming magic has interfered with your resistances, lowering all of them by 20%.',
  type: SaveChannel.Magical,
  crossTierFor: SaveChannel.Magical,
  noCtEffect: true,
  status: EffectStatus.Detrimental,
  stackMode: StackMode.Refresh,
  subtypes: ['cross tier'],
  decrease: 1,
  icon: 'icon_status_spellshocked',
  parameters: { power: SPELLSHOCK_RESIST },
  /**
   * magical.lua:1979-1983 — `addTemporaryValue("resists", { all = -eff.power })`.
   *
   * THE `all` ROW, which is why `Wielder.resistAll` exists and why
   * `validateItems` refuses it on gear: it composes MULTIPLICATIVELY with every
   * typed row (Combat.lua:2227-2228), so this is not "−20 to six numbers", it is
   * a rescale of the whole defensive column. Six typed −20s would be a different
   * effect the moment the target resisted anything.
   */
  wielder: (instance) => ({
    resistAll: -Number(instance.params['power'] ?? SPELLSHOCK_RESIST),
  }),
} satisfies EffectDef);

/** mental.lua:2247-2253 — `for i = 1, 1 do` — exactly ONE talent goes dark. */
export const BRAINLOCK_TALENT_LOCKOUT = 1;

export const BRAINLOCKED: EffectDef = Object.freeze({
  id: EffectId.Brainlocked,
  // `Bl` is Bleeding's and `Br` is Breached's, so Brainlock contracts to `Bk`.
  // Two glyphs, and the roster test proves no two statuses share a pair.
  badge: 'Bk',
  displayName: 'Brainlocked',
  description:
    'A talent is locked out, and no talent cools down until it passes. ' +
    'The mind reels from something it could not answer.',
  type: SaveChannel.Mental,
  crossTierFor: SaveChannel.Mental,
  noCtEffect: true,
  status: EffectStatus.Detrimental,
  stackMode: StackMode.Refresh,
  subtypes: ['cross tier'],
  decrease: 1,
  icon: 'icon_status_brainlocked',
  modifiers: {
    // mental.lua:2246 — `addTemporaryValue("no_talents_cooldown", 1)`. The same
    // freeze Stunned uses, and the reason a one-turn Brainlock is worse than it
    // reads: nothing you already spent comes back while it lasts.
    noTalentsCooldown: true,
  },
  parameters: {},

  activate: ({ actor, eff, rng, ctx }: EffectHookArgs): void => {
    // mental.lua:2247-2253. ONE talent, where Stunned takes three — the tier gap
    // is usually one or two turns, so this is the lighter, more frequent cousin.
    const candidates = ctx.activatableTalents?.(actor.id) ?? [];
    const locked = lockoutTalents(
      actor,
      candidates,
      BRAINLOCK_TALENT_LOCKOUT,
      rng,
      `effects.brainlocked.lockout.${actor.id}`,
    );
    eff.params.power = locked.length;
  },
} satisfies EffectDef);

// ---------------------------------------------------------------------------
// CONFUSED — mental.lua:67-87
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFUSED. THE STEP YOU TAKE IS NOT THE STEP YOU ASKED FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * newEffect{
 *   name = "CONFUSED", image = "effects/confused.png",
 *   long_desc = "The target is confused, acting randomly (chance %d%%) and unable
 *                to perform complex actions.",
 *   type = "mental", subtype = { confusion=true }, status = "detrimental",
 *   parameters = { power=50 },                                        -- :74
 *   on_gain = "#Target# wanders around!.",                            -- :75
 *   activate = function(self, eff)
 *     eff.power = math.floor(math.max(eff.power - (self:attr("confusion_immune") or 0) * 100, 10))
 *     eff.power = util.bound(eff.power, 0, 50)                        -- :79
 *     eff.tmpid = self:addTemporaryValue("confused", eff.power)       -- :80
 *   end,
 * }
 * ```
 *
 * ═══ IT IS THE FIRST STATUS HERE THAT CHANGES AN ACTION'S MEANING ═══
 * Everything else on this list is a modifier: Slowed moves a speed, Effaced
 * divides eight rolls, Breached halves a bound. A player reads those on their
 * sheet. Confusion is read on the FLOOR — you press east and go north-west —
 * and it is the only status in the game whose whole expression is that the
 * board did not do what you told it.
 *
 * ═══ THE TWO CONSUMERS, AND BOTH ARE AT RESOLUTION ═══
 * `Actor.lua:1316-1321` scrambles a step inside `move`, and `Actor.lua:5499-5504`
 * makes a talent fail inside `preUseTalent` AND SPENDS THE ENERGY. Ours are in
 * `engine/scheduler.ts` for the reason the talent gate's own docblock gives:
 * `submitTalent` checks only what CANNOT CHANGE between the packet and the tick,
 * because a refusal there costs zero and re-prompts. A confusion roll must not
 * be a free re-roll, so it belongs where the turn is actually spent.
 *
 * ═══ NO `confusion_immune` YET, DELIBERATELY ═══
 * Upstream's `activate` subtracts one. `IMMUNITY_KEYS` (shared/immunity.ts) has
 * seven subtypes and confusion is not among them, and adding an eighth with no
 * ego granting it would be the ninth time this codebase has built a finished
 * channel with no content pointed at it — the failure `Effaced` and `Breached`
 * were written to end. The subtype below is already `'confusion'`, so the day an
 * ego wants to grant it, the key is the only thing missing.
 */
export const CONFUSED: EffectDef = Object.freeze({
  id: EffectId.Confused,
  // `Cn` — `Cf` reads as "cold/fire" at a glance on a 24-pixel badge, and the
  // roster test proves no two statuses share a pair.
  badge: 'Cn',
  displayName: 'Confused',
  description:
    'Acting at random, and unable to do anything complicated. ' +
    'Half the steps you take are somebody else’s idea.',
  // mental.lua:71 — the MENTAL save, whatever delivered it. See the file header.
  type: SaveChannel.Mental,
  status: EffectStatus.Detrimental,
  // mental.lua declares no `on_merge` for CONFUSED, so upstream replaces (:128).
  stackMode: StackMode.Refresh,
  // mental.lua:72 — `subtype = { confusion=true }`.
  subtypes: ['confusion'],
  decrease: 1,
  icon: 'icon_status_confused',
  modifiers: {
    // :80 — `addTemporaryValue("confused", eff.power)`.
    confusedPercent: CONFUSE_POWER,
  },
  // :74 — AND IT IS WHAT THE ENGINE READS. `effectModifiers` prefers this
  // instance's `power` over the definition's, because `activate` below lowers
  // it; see the note there and at the composer.
  parameters: { power: CONFUSE_POWER },

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `mental.lua:78-79` — IMMUNITY MAKES IT WEAKER AS WELL AS RARER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * eff.power = math.floor(math.max(eff.power - (self:attr("confusion_immune") or 0) * 100, 10))
   * eff.power = util.bound(eff.power, 0, 50)
   * ```
   *
   * CONFUSION IS THE ONLY STATUS IN THE GAME WHOSE IMMUNITY PAYS TWICE. Every
   * other subtype only feeds `canBe` — a chance the thing does not land at all.
   * This one is subtracted from the landed instance's own power as well, so a
   * body wearing ` of Plain Reading` shrugs it off more often AND is less
   * confused when it does not.
   *
   * That is not a generosity, it is what makes the affix worth a slot: against
   * a base chance of fifty percent, twenty points of `canBe` alone would be a
   * fifth of the landings refused and no difference whatever to the four fifths
   * that stick.
   *
   * ═══ THE FLOOR IS TEN, AND IT IS UPSTREAM'S ═══
   * `math.max(..., 10)` — so this path can never take confusion below one step
   * in ten, however much immunity is worn. Total immunity comes from `canBe`
   * refusing it outright, never from grinding the power to nothing; that
   * separation is what stops one deep affix from deleting a status.
   *
   * ═══ AND THE CEILING IS FIFTY ═══
   * `util.bound(eff.power, 0, 50)` runs AFTER the subtraction, so it bounds a
   * caller who asked for more rather than the immunity's work. Applied in the
   * same order here.
   */
  activate: ({ state, actor, eff }: EffectHookArgs): void => {
    const asked = Number(eff.params['power'] ?? CONFUSE_POWER);
    // `immunityAgainst` composes the WORN sheet with anything an effect granted
    // and bounds the pair to 0..100 — upstream's single `confusion_immune`
    // attr, which is a percentage there expressed as a fraction (`* 100`).
    const immune = immunityAgainst(state, actor, 'confusion');
    eff.params.power = bound(Math.floor(Math.max(asked - immune, CONFUSE_FLOOR)), 0, CONFUSE_POWER);
  },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGENERATION — hit points put back, a turn at a time.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BLEEDING's mirror, and deliberately built like it: one `onTimeout` that moves
 * hit points and then REPORTS what it moved, so the Case Log accounts for every
 * point of the pool restored the same way it accounts for every point taken.
 *
 * ═══ IT OWNS NO NUMBERS ═══
 * `parameters.power` defaults to 0, and 0 does nothing — the same guard BLEEDING
 * opens with. There is no generic regeneration in this game: every instance is
 * written by an inscription that knows its own heal and its own duration, so a
 * default here would be a number with no source, and the rule in this file is
 * that every number has one.
 *
 * ═══ THE HEAL GOES THROUGH `healActor`, NOT THROUGH `hp +=` ═══
 * `Actor.lua:2086-2089` scales a heal by the RECEIVER's `healing_factor`, and
 * `healActor` is where that lives. Touching `hp` directly here would be a
 * second, quieter heal path that ignored the one stat which modifies healing —
 * exactly the sort of divergence that surfaces months later as "why do the
 * numbers not match the character sheet".
 */
export const REGENERATION: EffectDef = Object.freeze({
  id: EffectId.Regeneration,
  badge: 'Rg',
  displayName: 'Regenerating',
  description: 'Flesh knitting closed. Restores life every turn.',
  // The CHANNEL describes the effect and not whatever put it there, which is
  // the note BLEEDING makes. Nothing ever rolls against this one — `applySave`
  // does not roll for a beneficial effect — but it is still physical.
  type: SaveChannel.Physical,
  status: EffectStatus.Beneficial,
  // Upstream's EFF_REGENERATION declares no `on_merge`, so a re-application
  // REPLACES rather than stacking. That is also exactly why the infusion refuses
  // to re-apply while it is running; see that talent's header for why the clause
  // is unreachable here.
  stackMode: StackMode.Refresh,
  subtypes: ['heal', 'regeneration'],
  decrease: 1,
  icon: 'icon_status_regeneration',
  parameters: { power: 0 },

  onTimeout: ({ actor, eff, ctx }: EffectHookArgs): boolean => {
    const power = eff.params.power ?? 0;
    if (power <= 0) return false;

    const healed = healActor(actor, power);

    /**
     * NOTHING RESTORED IS NOTHING TO SAY. `healActor` answers 0 at full health,
     * and "+0" three turns running is noise rather than a record.
     */
    if (healed <= 0) return false;

    ctx.noteDamage?.({
      victimId: actor.id,
      // WHOEVER WROTE THE INFUSION — the body itself today. Carried rather than
      // nulled because the same effect will one day arrive from an ally's rune,
      // and the transcript should be able to say whose it was.
      sourceId: eff.params.srcId ?? null,
      // ZERO, AND `healed` CARRIES THE NUMBER. `DamageEvent.healed` states that
      // contract — "when it is set, `amount` is 0" — and this is the third
      // producer to honour it.
      amount: 0,
      hp: actor.hp,
      maxHp: actor.maxHp,
      // A HEAL CANNOT KILL. Said rather than left to the reader: `killed` is
      // what `resolveStatusHits` reaps a body on.
      killed: false,
      // `applyDamage` rolls a crit either way, and this never calls it.
      crit: false,
      healed,
    });
    return false;
  },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PAIN SUPPRESSION — physical.lua:838-855. "The target ignores pain."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     activate = function(self, eff)
 *         eff.pid = self:addTemporaryValue("resists", {all=eff.power})
 *     end,
 *
 * ═══ IT IS A RESCALE OF THE WHOLE DEFENSIVE COLUMN, NOT SIX TYPED BONUSES ═══
 * `SPELLSHOCKED`'s note states the rule from the other direction and it applies
 * unchanged here: the `all` row composes MULTIPLICATIVELY with every typed row
 * (Combat.lua:2227-2228), so this is not "+14 to six numbers". A body already
 * resistant to darkness gets proportionally more out of it, which is upstream's
 * intent and is why the row exists at all.
 *
 * ═══ THROUGH `Wielder.resistAll`, WHICH WAS BUILT FOR THIS AND HAD ONE USER ═══
 * `composeWielders` has folded an `all` row since the trio landed and
 * `combatGetResist` has read one since the defensive maths was ported. The only
 * thing missing was something that granted it rather than taking it away.
 */
export const PAIN_SUPPRESSION: EffectDef = Object.freeze({
  id: EffectId.PainSuppression,
  badge: 'Pn',
  displayName: 'Pain Suppression',
  description: 'Ignoring the pain. Every kind of damage lands softer.',
  // physical.lua:842 — `type = "physical"`, `subtype = { nature = true }`.
  type: SaveChannel.Physical,
  status: EffectStatus.Beneficial,
  // No `on_merge` upstream, so a re-press replaces rather than stacking — which
  // matters here more than usual: two stacked `all` rows would compound.
  stackMode: StackMode.Refresh,
  subtypes: ['nature'],
  decrease: 1,
  icon: 'icon_status_pain_suppression',
  // physical.lua:844 — `parameters = { power = 20 }`. The INSCRIPTION overrides
  // it (human.lua:54 carries 14); this is the bare effect's own default, exactly
  // as upstream declares it.
  parameters: { power: 20 },
  wielder: (instance) => ({
    resistAll: Number(instance.params['power'] ?? 20),
  }),
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EMPOWERED HEALING — magical.lua:1297-1310. Every heal lands harder.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     activate = function(self, eff)
 *         eff.tmpid = self:addTemporaryValue("healing_factor", eff.power)
 *
 * ═══ A FRACTION, NOT A PERCENT, AND UPSTREAM'S DEFAULT SAYS SO ═══
 * `parameters = { power = 0.1 }` is a TENTH more healing, and `healing_factor`
 * is a multiplier that starts at 1. Storing 10 here and dividing at the reader
 * would put the same number in two units and make the day somebody stacks two
 * sources a debugging session.
 *
 * ═══ IT MULTIPLIES WHAT ARRIVES, SO IT IS WORTH NOTHING ALONE ═══
 * Unlike every other beneficial effect in this file it does nothing on its own:
 * a body with no heal coming is a body at the same hit points. That is exactly
 * why upstream hands it out WITH a regeneration rather than by itself — see
 * `higher_heal.ts`, which applies both in one press.
 */
export const EMPOWERED_HEALING: EffectDef = Object.freeze({
  id: EffectId.EmpoweredHealing,
  badge: 'Em',
  displayName: 'Empowered Healing',
  description: 'Every mending lands harder while it lasts.',
  // magical.lua:1300-1301 — `type = "magical"`, `subtype = { light = true }`.
  type: SaveChannel.Magical,
  status: EffectStatus.Beneficial,
  stackMode: StackMode.Refresh,
  subtypes: ['light'],
  decrease: 1,
  icon: 'icon_status_empowered_healing',
  // magical.lua:1303 — `parameters = { power = 0.1 }`.
  parameters: { power: 0.1 },
  wielder: (instance) => ({
    mods: { healMod: Number(instance.params['power'] ?? 0.1) },
  }),
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HIGHBORN'S BLOOM — other.lua:1574-1580. "Using talents without consuming
 * resources."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT CARRIES NO NUMBER AT ALL, WHICH IS UNUSUAL HERE ═══
 * Upstream declares `parameters = { power = 10 }` and its own action passes `{}`
 * — the power is never read by anything. So this effect is a FLAG: the whole of
 * it is `modifiers.freeResources`, which `useTalent` reads at the one site where
 * a resource is deducted.
 *
 * ═══ THE RESOURCE, NOT THE TURN ═══
 * AP and MP are the turn rather than a pool, and a talent that cost no time
 * would let a body act without end. Upstream spends energy either way; only the
 * class resource is waived.
 *
 * SHORT AND EXPENSIVE. One turn at rank 1 against a 24-turn cooldown, which is
 * upstream's shape: it is a window to spend a pool you have already emptied,
 * not a discount you plan around.
 */
export const HIGHBORNS_BLOOM: EffectDef = Object.freeze({
  id: EffectId.HighbornsBloom,
  // 'Hb', NOT 'Bl' — BLEEDING has had that glyph since M3 and
  // `effects.test.ts` requires every badge to be unique, because two statuses
  // sharing a mark is a party panel that lies about what is on you.
  badge: 'Hb',
  displayName: "Highborn's Bloom",
  description: 'Inner magic is paying for your talents. They cost no resource.',
  // other.lua:1577-1578 — `type = "other"`, `subtype = { arcane = true }`. We
  // have no `other` channel and nothing ever rolls against a beneficial effect,
  // so the label is the nearest true one rather than an invented category.
  type: SaveChannel.Magical,
  status: EffectStatus.Beneficial,
  stackMode: StackMode.Refresh,
  subtypes: ['arcane'],
  decrease: 1,
  icon: 'icon_status_highborns_bloom',
  modifiers: { freeResources: true },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHIVAL RESILIENCE — physical.lua:3524-3559. Upstream's "Dwarven Resilience".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     eff.aid = self:addTemporaryValue("combat_armor", eff.armor)
 *     eff.hid = self:addTemporaryValue("combat_armor_hardiness", eff.armor_hardiness)
 *     eff.pid = self:addTemporaryValue("combat_physresist", eff.physical)
 *     eff.sid = self:addTemporaryValue("combat_spellresist", eff.spell)
 *
 * ═══ READ THE SECOND DEFINITION, NOT THE FIRST ═══
 * `DWARVEN_RESILIENCE` is declared TWICE in physical.lua — once at :666 and
 * again at :3524 — and a later `newEffect` replaces the earlier one. The two are
 * not the same: the early one writes three channels and the live one writes
 * FOUR. Porting :666 would have quietly dropped armour hardiness, which is the
 * half of the effect that decides whether the armour matters against a big hit.
 * The talent's own `getParams` passes `armor_hardiness`, which is how the
 * duplicate was caught — the early definition never reads it.
 *
 * ═══ FOUR VALUES AND ALL FOUR ARE THE PRESSER'S ═══
 * Three are computed from Constitution when the talent fires, so a body that
 * gained CON since the last press gets a stronger one. They ride in `params`
 * rather than being recomputed here, because an effect must keep the number it
 * was granted with — `higher_heal.ts` carries its heal the same way.
 *
 * ═══ `mid_ac` IS NOT PORTED, AND IT IS UNREACHABLE RATHER THAN SKIPPED ═══
 * The `activate` branch at :3546-3550 adds `flat_damage_armor` when the body
 * knows `T_STONE_FORTRESS` — a prodigy we have not ported, so the condition can
 * never be true. Named here for `overseer_of_nations.ts`'s reason: the next
 * reader gets a list of what is missing rather than having to measure it.
 */
export const ARCHIVAL_RESILIENCE: EffectDef = Object.freeze({
  id: EffectId.ArchivalResilience,
  /** 'Ar'. Every other two-letter mark in this file is taken; the panel needs a unique one. */
  badge: 'Ar',
  displayName: 'Archival Resilience',
  description: 'Hardened against alteration. More armour, and harder to move or unmake.',
  // physical.lua:3535-3536 — `type = "physical"`, `subtype = { earth = true }`.
  type: SaveChannel.Physical,
  status: EffectStatus.Beneficial,
  // No `on_merge` upstream, so a re-press replaces. That is the right rule here
  // for `PAIN_SUPPRESSION`'s reason and one more: the params are recomputed from
  // CON at each press, so a refresh is how a stronger body upgrades its own buff.
  stackMode: StackMode.Refresh,
  subtypes: ['earth'],
  decrease: 1,
  icon: 'icon_status_archival_resilience',
  /**
   * physical.lua:3537 — `parameters = { armor=10, spell=10, physical=10 }`,
   * carried into `EffectParams.grants` under the channel names our fold uses.
   *
   * UPSTREAM DECLARES NO DEFAULT FOR `armor_hardiness` even though `activate`
   * reads it (:3542), so a press that omitted it would add `nil`. Ours leaves it
   * out of the defaults too rather than inventing a number — the talent always
   * passes all four, and an absent channel folds as nothing.
   */
  parameters: { grants: { armour: 10, physResist: 10, spellResist: 10 } },
  wielder: (instance) => ({ mods: instance.params.grants ?? {} }),
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WRATH OF THE WOODS — physical.lua:801-819, upstream's `ETERNAL_WRATH`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     eff.pid1 = self:addTemporaryValue("inc_damage", {all=eff.power})
 *     eff.pid2 = self:addTemporaryValue("resists",    {all=eff.power})
 *
 * ONE NUMBER SPENT TWICE, which is the whole shape of the effect: the same
 * `power` is how much harder you hit and how much less you take.
 *
 * ═══ THE TWO ROWS COMPOSE DIFFERENTLY, AND BOTH ARE UPSTREAM'S ═══
 * `combatGetResist` multiplies the `all` row against the typed one
 * (Combat.lua:2227-2228); `combatGetDamageIncrease` SUMS them
 * (damage_types.lua:202). Reading this block and expecting a symmetric result is
 * the mistake it invites, so: the damage half is worth exactly its number, the
 * resistance half is worth less on a body that already resists that type.
 *
 * ═══ DECLARED ONCE UPSTREAM, WHICH WAS CHECKED ═══
 * `ARCHIVAL_RESILIENCE` is the cautionary tale — its name is declared twice in
 * physical.lua and the later one wins. `ETERNAL_WRATH` appears once across all
 * five timed-effect files.
 */
export const ETERNAL_WRATH: EffectDef = Object.freeze({
  id: EffectId.EternalWrath,
  /** 'Ww'. Every other two-letter mark in this file is taken. */
  badge: 'Ww',
  displayName: 'Wrath of the Woods',
  description: 'Everything you do lands harder, and everything done to you lands softer.',
  // physical.lua:805-806 — `type = "physical"`, `subtype = { nature = true }`.
  type: SaveChannel.Physical,
  status: EffectStatus.Beneficial,
  // No `on_merge` upstream, so a re-press replaces. See `PAIN_SUPPRESSION`.
  stackMode: StackMode.Refresh,
  subtypes: ['nature'],
  decrease: 1,
  icon: 'icon_status_eternal_wrath',
  // physical.lua:808 — `parameters = { power = 10 }`.
  parameters: { power: 10 },
  wielder: (instance) => {
    const power = Number(instance.params['power'] ?? 10);
    return { resistAll: power, damageAll: power };
  },
} satisfies EffectDef);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOOTNOTED LUCK — mental.lua:1631-1647, upstream's `HALFLING_LUCK`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     self:effectTemporaryValue(eff, "combat_generic_crit", eff.crit)
 *     self:effectTemporaryValue(eff, "combat_physresist",   eff.save)
 *     self:effectTemporaryValue(eff, "combat_spellresist",  eff.save)
 *     self:effectTemporaryValue(eff, "combat_mentalresist", eff.save)
 *
 * FOUR CHANNELS AND NOT ONE OF THEM IS NEW. `genericCrit` arrived with the stat
 * work and the three saves with the cross-tier effects, so this whole racial
 * talent is a pure content port — the first one where that was true of every
 * clause rather than most of them.
 *
 * ═══ `genericCrit`, NOT `physCrit` ═══
 * Upstream writes `combat_generic_crit`, which is the crit chance for
 * EVERYTHING — spells and mind powers as well as blows. `physCrit` would have
 * been the wrong channel and would have looked right on a melee character.
 *
 * DECLARED ONCE upstream, checked across all five timed-effect files.
 */
export const FOOTNOTED_LUCK: EffectDef = Object.freeze({
  id: EffectId.FootnotedLuck,
  /** 'Lk'. Every other two-letter mark in this file is taken. */
  badge: 'Lk',
  displayName: 'Footnoted Luck',
  description: 'Everything is going your way, briefly. You crit more and shrug off more.',
  // mental.lua:1635-1636 — `type = "mental"`, `subtype = { focus = true }`.
  type: SaveChannel.Mental,
  status: EffectStatus.Beneficial,
  // No `on_merge` upstream, so a re-press replaces. See `PAIN_SUPPRESSION`.
  stackMode: StackMode.Refresh,
  subtypes: ['focus'],
  decrease: 1,
  icon: 'icon_status_footnoted_luck',
  // mental.lua:1638 — `parameters = { crit = 10, save = 10 }`, carried into
  // `EffectParams.grants` under the channel names our fold uses.
  parameters: {
    grants: { genericCrit: 10, physResist: 10, spellResist: 10, mentalResist: 10 },
  },
  wielder: (instance) => ({ mods: instance.params.grants ?? {} }),
} satisfies EffectDef);

export const MVP_EFFECTS: readonly EffectDef[] = Object.freeze([
  STUNNED,
  BLEEDING,
  SLOWED,
  EFFACED,
  BREACHED,
  DAZED,
  EVASIVE,
  OFF_BALANCE,
  SPELLSHOCKED,
  BRAINLOCKED,
  CONFUSED,
  REGENERATION,
  PAIN_SUPPRESSION,
  EMPOWERED_HEALING,
  HIGHBORNS_BLOOM,
  ARCHIVAL_RESILIENCE,
  ETERNAL_WRATH,
  FOOTNOTED_LUCK,
]);

/** Effect ids, for a content-completeness check and for the client's badge atlas. */
export const EFFECT_IDS: readonly string[] = Object.freeze(MVP_EFFECTS.map((def) => def.id));

const BY_ID: ReadonlyMap<string, EffectDef> = new Map(MVP_EFFECTS.map((def) => [def.id, def]));

export function effectById(id: string): EffectDef | undefined {
  return BY_ID.get(id);
}

/** An `EffectState` with the three MVP statuses registered. What `createWorld` wants. */
export function createMvpEffectState(): EffectState {
  return createEffectState(MVP_EFFECTS);
}

// ---------------------------------------------------------------------------
// Validation — the same shape content/monsters.ts uses
// ---------------------------------------------------------------------------

/**
 * Prove a definition is internally consistent. Returns problems, empty when fine.
 *
 * These are the mistakes that produce a silently inert or silently unfair
 * effect rather than a crash, which is why they are checked at all:
 *
 *   - a `Stack` mode with no `onMerge` falls back to plain duration extension,
 *     which is almost never what an authored stacking effect wants;
 *   - `decrease: 0` is a PERMANENT effect (ActorTemporaryEffects.lua:91 would
 *     subtract nothing), legal for a sustain and a bug for a status;
 *   - a `globalSpeedAdd` at or below −1 would stop a monster's clock, and the
 *     0.1 floor in `recomputeAttributes` would silently absorb it instead of
 *     letting anyone notice the number was wrong.
 */
/** Two characters fit the 24px box; three collide with its border. */
const BADGE_MAX = 2;

export function validateEffect(def: EffectDef): readonly string[] {
  const problems: string[] = [];

  // ONE OR TWO CHARACTERS. The badge box is 24px and centres its text; three
  // would overflow the border this file's fallback draws around it.
  if (def.badge.length < 1 || def.badge.length > BADGE_MAX) {
    problems.push(`badge must be 1-2 characters, got "${def.badge}"`);
  }

  if (!def.id.startsWith(EFFECT_ID_PREFIX)) {
    problems.push(`${def.id}: id must start with '${EFFECT_ID_PREFIX}'`);
  }
  if (def.subtypes.length === 0) {
    problems.push(`${def.id}: no subtypes — nothing can ever grant immunity to it`);
  }
  if (def.decrease <= 0) {
    problems.push(
      `${def.id}: decrease ${def.decrease} never expires (ActorTemporaryEffects.lua:91)`,
    );
  }
  if (def.stackMode === StackMode.Stack && def.onMerge === undefined) {
    problems.push(`${def.id}: stackMode 'stack' without onMerge falls back to duration extension`);
  }
  if (def.stackMode !== StackMode.Stack && def.onMerge !== undefined) {
    problems.push(`${def.id}: onMerge is only ever called by stackMode 'stack'`);
  }

  const speed = def.modifiers?.globalSpeedAdd ?? 0;
  if (speed <= -1) {
    problems.push(`${def.id}: globalSpeedAdd ${speed} would stop a monster's clock`);
  }
  if (speed > 0 && def.status === EffectStatus.Detrimental) {
    problems.push(`${def.id}: a detrimental effect with a POSITIVE globalSpeedAdd is a haste`);
  }

  return problems;
}

/**
 * Is this actor's stun freezing its cooldowns right now?
 *
 * A convenience over `effectModifiers` for the one query the scheduler, the
 * projector and the Case Log all want to phrase the same way. Exported from
 * CONTENT rather than the engine because "stunned" is a content concept; the
 * engine only knows `no_talents_cooldown`.
 */
export function isStunned(state: EffectState, actorId: string): boolean {
  return effectModifiers(state, actorId).stunned === true;
}
