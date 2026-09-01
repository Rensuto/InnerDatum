import { describe, expect, it } from 'vitest';

import {
  AiProfile,
  HOLD_INTENT,
  actBase,
  createMonsterActor,
  setCooldown,
} from '../../src/server/engine/actor.ts';
import {
  BLEED_POWER,
  EffectId,
  SLOW_PLAYER_AP_PENALTY,
  SLOW_PLAYER_MP_PENALTY,
  SLOW_POWER,
  STUN_TALENT_LOCKOUT,
  createMvpEffectState,
  isStunned,
} from '../../src/server/content/effects.ts';
import {
  budgetPenalty,
  effectDur,
  hasEffect,
  noTalentsCooldown,
  removeEffect,
  setEffect,
  statusPass,
} from '../../src/server/engine/effects.ts';
import {
  ActResult,
  TICKS_PER_GAME_TURN,
  createTurnClock,
  spendForAction,
  tickLevel,
} from '../../src/shared/energy.ts';
import { DOWNED_TURNS, createDownedState, downedView } from '../../src/server/engine/downed.ts';
import {
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { createRng } from '../../src/shared/rng.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import type { EngineActor, StatusPass } from '../../src/server/engine/actor.ts';
import type { EffectLogLine } from '../../src/server/engine/effects.ts';
import type { GameEvent } from '../../src/server/engine/scheduler.ts';

/**
 * ===========================================================================
 * THE THREE MVP STATUSES, AS BEHAVIOUR RATHER THAN AS DATA
 * ===========================================================================
 *
 * `effects.test.ts` pins the MACHINERY — the save, the duration curve, the tick
 * order. This file pins what the three authored statuses actually DO to a fight,
 * and each of the three has a failure mode that produces no crash, no type error
 * and no failing plumbing test:
 *
 *   STUN THAT DOES NOT FREEZE COOLDOWNS (Actor.lua:606) is a mild damage debuff
 *   the victim waits out with a full bar of talents ready. The one line is
 *   `if not self:attr("no_talents_cooldown") then self:cooldownTalents() end`,
 *   and the only way to see it missing is to count a cooldown across turns.
 *
 *   A BLEED ON THE ACT CLOCK rewards the victim for being slowed and punishes
 *   them for being hasted — the wrong direction on every axis. It ticks on
 *   `energyBase` (Actor.lua:597 inside :476-609), so "3 per turn for 4 turns" is
 *   12 damage at ANY speed. The test drives a hasted and an unhasted body
 *   through the same loop and compares totals.
 *
 *   SLOW APPLIED TO A PLAYER'S CLOCK desynchronises the barrier (DECISIONS.md
 *   § D1). A player's `globalSpeed` is the literal type `1` and readonly, so the
 *   player half of SLOWED spends the intra-turn BUDGET instead. Both paths are
 *   tested, side by side, because the asymmetry is the design and not a gap.
 *
 * The exact integers come from the Lua and from the authored constants; every
 * one of them is stated next to its citation.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function husk(id: string, over: { globalSpeed?: number; maxHp?: number } = {}): EngineActor {
  return createMonsterActor(id, {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 5,
    y: 5,
    profile: AiProfile.MeleeChaser,
    maxHp: over.maxHp ?? 24,
    globalSpeed: over.globalSpeed ?? 1,
  });
}

type ClockRun = {
  /** `act` calls that spent energy — the SPEED-dependent clock. */
  readonly actions: number;
  /** `actBase` passes — the SPEED-INDEPENDENT clock. Must be one per game turn. */
  readonly basePasses: number;
};

/**
 * Drive one actor through `tickLevel` for exactly `gameTurns` game turns, with
 * the real `actBase` (and therefore the real status pass) on the base clock.
 *
 * `tickLevel` rather than `pump` on purpose for the rate tests: `pump` stops the
 * moment a human owes a decision, so counting a MONSTER's actions per game turn
 * there means counting sweep steps around a barrier. Here the budget is the
 * clock, the loop returns `budget` at exactly `gameTurns × 10` ticks, and the
 * two counters are the two clocks with nothing in between.
 */
function runGameTurns(actor: EngineActor, gameTurns: number, pass?: StatusPass): ClockRun {
  let actions = 0;
  let basePasses = 0;

  tickLevel([actor], {
    clock: createTurnClock(),
    actBase: (): void => {
      basePasses += 1;
      actBase(actor, pass);
    },
    act: (): ActResult => {
      actions += 1;
      // Players pass 1.0 always (D1); a monster's own cost multiplier is the
      // OTHER knob and is deliberately left alone here — this measures gain.
      spendForAction(actor, 1);
      return ActResult.Done;
    },
    maxTicks: gameTurns * TICKS_PER_GAME_TURN,
  });

  return { actions, basePasses };
}

// ===========================================================================
// 1. STUNNED — THE COOLDOWN FREEZE (Actor.lua:606)
// ===========================================================================

describe('STUNNED freezes talent cooldowns — Actor.lua:606', () => {
  /**
   * ```lua
   * -- Cooldown talents after effects, because some of them involve breaking sustains.
   * if not self:attr("no_talents_cooldown") then self:cooldownTalents() end
   * ```
   *
   * Turn by turn, because "it froze" and "it froze and then never restarted" are
   * different bugs and only a table tells them apart.
   */
  it('holds every cooldown still for the whole stun and resumes the turn it ends', () => {
    const state = createMvpEffectState();
    const target = husk('m1');
    setCooldown(target, 'talent:crude_blow', 6);
    setCooldown(target, 'talent:lockdown', 2);

    // dur 3 and no `applyPower`, so no save is rolled and no draw is consumed —
    // this test is about the freeze, not about how long a stun lands for.
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));
    expect(noTalentsCooldown(state, target.id)).toBe(true);

    const pass = statusPass(state, createRng('freeze-table'));
    const seen: number[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      actBase(target, pass);
      seen.push(target.cooldowns.get('talent:crude_blow') ?? 0);
    }

    // Turns 1-2: stunned, dur 3 → 2 → 1. Turn 3: `timedEffects` sees dur 0 and
    // removes it (ActorTemporaryEffects.lua:80-81) BEFORE Actor.lua:606 reads
    // the attr (:597 before :606), so cooldowns tick on that same turn.
    expect(seen).toEqual([6, 6, 6, 5, 4, 3]);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
    // The second cooldown froze on the identical schedule — the freeze is an
    // actor-wide attr, not a per-talent one.
    expect(target.cooldowns.get('talent:lockdown')).toBeUndefined();
  });

  it('a shorter stun costs exactly its own length in cooldown progress', () => {
    const state = createMvpEffectState();

    const stunned = husk('m1');
    const control = husk('m2');
    setCooldown(stunned, 'talent:crude_blow', 10);
    setCooldown(control, 'talent:crude_blow', 10);
    setEffect(state, stunned, EffectId.Stunned, 2, {}, scriptedRng([]));

    const pass = statusPass(state, createRng('stun-cost'));
    for (let turn = 1; turn <= 5; turn += 1) {
      actBase(stunned, pass);
      actBase(control, pass);
    }

    // Five turns, two of them frozen: 10 − 3 = 7 against the control's 10 − 5 = 5.
    // The gap is exactly the stun's duration, which is the whole tactical claim.
    expect(stunned.cooldowns.get('talent:crude_blow')).toBe(7);
    expect(control.cooldowns.get('talent:crude_blow')).toBe(5);
  });

  it('releases the freeze the moment the stun is dispelled, not a turn later', () => {
    const state = createMvpEffectState();
    const target = husk('m1');
    setCooldown(target, 'talent:crude_blow', 5);
    setEffect(state, target, EffectId.Stunned, 9, {}, scriptedRng([]));

    const pass = statusPass(state, createRng('dispel-freeze'));
    actBase(target, pass);
    expect(target.cooldowns.get('talent:crude_blow')).toBe(5);

    removeEffect(state, target, EffectId.Stunned, scriptedRng([]));
    expect(noTalentsCooldown(state, target.id)).toBe(false);

    actBase(target, pass);
    expect(target.cooldowns.get('talent:crude_blow')).toBe(4);
  });

  /**
   * THE FREEZE IS `no_talents_cooldown`, NOT "skip the base pass".
   *
   * Actor.lua:606 is the LAST of the three things `actBase` does — regeneration
   * (:525) and `timedEffects` (:597) both run first and both keep running while
   * stunned. A port that guards the whole base pass instead of that one call
   * passes every cooldown assertion above and then quietly stops a stunned
   * actor's bleed from ticking and its wounds from closing.
   */
  it('does NOT freeze regeneration or the effect durations themselves', () => {
    const state = createMvpEffectState();
    const target = husk('m1', { maxHp: 40 });
    target.hp = 30;
    target.hpRegen = 2;
    setCooldown(target, 'talent:crude_blow', 5);
    setEffect(state, target, EffectId.Stunned, 3, {}, scriptedRng([]));

    const pass = statusPass(state, createRng('regen-under-stun'));
    actBase(target, pass);

    expect(target.hp).toBe(32); // Actor.lua:525 ran
    expect(effectDur(state, target.id, EffectId.Stunned)).toBe(2); // :597 ran
    expect(target.cooldowns.get('talent:crude_blow')).toBe(5); // :606 did not
  });

  /**
   * physical.lua:495-504 puts three READY talents on cooldown 1, and :503's own
   * comment explains the trick: *"Just set cooldown to 1 since cooldown does not
   * decrease while stunned"*. The lockout is therefore SELF-TIMING — it lasts
   * exactly as long as the stun and releases with it — and that only works if
   * BOTH halves are ported. Half a port gives a one-turn lockout on a four-turn
   * stun, which is a number nobody would ever notice was wrong.
   */
  it('locks three talents at cooldown 1 and the 1 cannot tick until the stun ends', () => {
    const state = createMvpEffectState();
    const target = husk('m1');
    const loadout = ['talent:crude_blow', 'talent:ward_rush', 'talent:iron_curtain'];

    setEffect(state, target, EffectId.Stunned, 2, {}, scriptedRng([]), {
      activatableTalents: () => loadout,
    });
    expect(loadout.filter((id) => target.cooldowns.has(id))).toHaveLength(STUN_TALENT_LOCKOUT);
    for (const id of loadout) expect(target.cooldowns.get(id)).toBe(1);

    const pass = statusPass(state, createRng('lockout-timing'));
    // Two turns of stun (dur 2 → 1 → 0). A cooldown of 1 would normally clear on
    // the very next base pass; here it does not move at all.
    actBase(target, pass);
    actBase(target, pass);
    for (const id of loadout) expect(target.cooldowns.get(id)).toBe(1);

    // The third pass is the one that sees `dur <= 0` and removes the stun
    // (ActorTemporaryEffects.lua:80-81), and Actor.lua reads the attr AFTER
    // :597's `timedEffects` — so it is also the pass that ticks cooldowns, and
    // all three talents come back together on the turn the victim comes round.
    actBase(target, pass);
    expect(hasEffect(state, target.id, EffectId.Stunned)).toBe(false);
    for (const id of loadout) expect(target.cooldowns.has(id)).toBe(false);
  });

  it('sets the ×0.4 outgoing-damage flag alongside the freeze', () => {
    const state = createMvpEffectState();
    const target = husk('m1');
    setEffect(state, target, EffectId.Stunned, 2, {}, scriptedRng([]));

    // damage_types.lua:150-153, read by combat.ts as `sourceStunned`.
    expect(target.combat?.flags?.stunned).toBe(true);
    expect(isStunned(state, target.id)).toBe(true);

    removeEffect(state, target, EffectId.Stunned, scriptedRng([]));
    expect(target.combat?.flags?.stunned).toBe(false);
    expect(isStunned(state, target.id)).toBe(false);
  });

  /**
   * The freeze survives the trip through the REAL drive loop: `tickLevel`
   * grants the base clock, `pump`'s `actBase` callback forwards the status pass,
   * and `engine/actor.ts` skips `tickCooldowns`. A hasted stunned monster is the
   * pointed case — it takes twice as many actions and still banks zero cooldown
   * progress, because the two clocks are genuinely separate.
   */
  it('holds through the real clock even for a HASTED monster', () => {
    const state = createMvpEffectState();
    const fast = husk('m1', { globalSpeed: 2 });
    setCooldown(fast, 'talent:crude_blow', 12);
    setEffect(state, fast, EffectId.Stunned, 99, {}, scriptedRng([]));

    const run = runGameTurns(fast, 10, statusPass(state, createRng('hasted-freeze')));

    expect(run.actions).toBe(20); // twice as many turns...
    expect(run.basePasses).toBe(10); // ...and still ten base passes
    expect(fast.cooldowns.get('talent:crude_blow')).toBe(12); // ...and zero progress
  });
});

// ===========================================================================
// 2. BLEEDING — DAMAGE ON THE BASE CLOCK
// ===========================================================================

describe('BLEEDING ticks once per GAME TURN at any speed — physical.lua:149-151', () => {
  it('deals power × dur in total, and haste does not buy the victim extra ticks', () => {
    const normal = husk('m1', { maxHp: 40 });
    const hasted = husk('m2', { maxHp: 40, globalSpeed: 2 });

    const state = createMvpEffectState();
    setEffect(state, normal, EffectId.Bleeding, 4, { power: 3 }, scriptedRng([]));
    setEffect(state, hasted, EffectId.Bleeding, 4, { power: 3 }, scriptedRng([]));

    const pass = statusPass(state, createRng('bleed-speed'));
    const slow = runGameTurns(normal, 6, pass);
    const fast = runGameTurns(hasted, 6, pass);

    // 3 × 4 = 12, both ways. The bleed stops on the fifth base pass
    // (ActorTemporaryEffects.lua:80-81) rather than running the full six.
    expect(normal.hp).toBe(28);
    expect(hasted.hp).toBe(28);
    expect(hasted.hp).toBe(normal.hp);

    // The only thing haste bought was actions.
    expect(fast.actions).toBe(2 * slow.actions);
    expect(fast.basePasses).toBe(slow.basePasses);
    expect(fast.basePasses).toBe(6);

    expect(hasEffect(state, normal.id, EffectId.Bleeding)).toBe(false);
    expect(hasEffect(state, hasted.id, EffectId.Bleeding)).toBe(false);
  });

  it('uses the authored default power when a caller supplies none', () => {
    const state = createMvpEffectState();
    const target = husk('m1', { maxHp: 40 });
    // physical.lua:130 `parameters = { power = 1 }`, raised to BLEED_POWER here
    // and merged in by ActorTemporaryEffects.lua:113-115.
    setEffect(state, target, EffectId.Bleeding, 2, {}, scriptedRng([]));

    runGameTurns(target, 2, statusPass(state, createRng('bleed-default')));
    expect(target.hp).toBe(40 - 2 * BLEED_POWER);
  });

  /**
   * ═══ A BLEED CAN PUT A DETECTIVE ON THE FLOOR ═══
   *
   * The whole reason the scheduler runs the status pass BEFORE the survival pass
   * (Actor.lua:597, then ours): `on_timeout` projects its damage inside
   * `timedEffects`, so a body that bled out is already at 0 HP when the survival
   * pass looks — and is enrolled on the turn it actually fell, with all five
   * turns intact. Run the countdown first and the party is told a turn late.
   */
  it('downs a player who bleeds out, on the turn it happens, with five turns left', () => {
    const world = createWorld('bleed-down');
    const barrier = createBarrier();
    const downed = createDownedState();
    const effects = createMvpEffectState();

    const dalt = world.addPlayer('p1', 'Dalt');
    dalt.hpRegen = 0; // placeholder regen would quietly outheal a 3-per-turn bleed
    dalt.hp = 5;
    const ori = world.addPlayer('p2', 'Ori');
    ori.hpRegen = 0;

    setEffect(effects, dalt, EffectId.Bleeding, 6, { power: 3 }, world.rng);

    const notes: EffectLogLine[] = [];
    const pass = statusPass(effects, world.rng, { log: (line) => notes.push(line) });
    const events: GameEvent[] = [];
    const drive = (nowMs: number, commit: boolean): void => {
      if (commit) {
        submitIntent(world, barrier, 'p1', HOLD_INTENT);
        submitIntent(world, barrier, 'p2', HOLD_INTENT);
      }
      const result = pump(world, {
        nowMs,
        barrier,
        downed,
        statusPass: pass,
        drainStatusLog: () => notes.splice(0, notes.length),
      });
      expect(result.gameTurns).toBe(1);
      events.push(...result.events);
    };
    // The opening pump takes nobody's turn: it fills both act clocks to the
    // threshold and parks. From there each committed pump is exactly one game
    // turn, because the party is phase-locked (D1).
    const advance = (nowMs: number): void => {
      drive(nowMs, true);
    };

    drive(0, false); // 5 − 3 = 2, still standing
    expect(dalt.hp).toBe(2);
    expect(dalt.alive).toBe(true);

    advance(1); // 2 − 3 → 0. The bleed, not a blow, is what put him down.
    expect(dalt.hp).toBe(0);
    expect(dalt.alive).toBe(false);
    expect(events).toContainEqual({ t: 'downed', id: 'p1', turnsLeft: DOWNED_TURNS });
    expect(downedView(downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS);

    // ═══ AND THE BLEED STOPS THERE ═══
    // `actBase` returns early for a body that is not alive, so a downed body
    // takes no further status ticks — the wound you fell with is the wound you
    // get up with. A bleed that kept ticking would make the countdown a lie.
    const durWhenDowned = effectDur(effects, 'p1', EffectId.Bleeding);
    advance(2);
    advance(3);
    expect(dalt.hp).toBe(0);
    expect(effectDur(effects, 'p1', EffectId.Bleeding)).toBe(durWhenDowned);
    // The countdown, by contrast, IS still running — that is the widening of
    // `isActive` the scheduler makes for exactly this case.
    expect(downedView(downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS - 2);
  });
});

// ===========================================================================
// 3. SLOWED — TWO MECHANISMS, ONE EFFECT (DECISIONS.md § D1)
// ===========================================================================

describe('SLOWED slows a MONSTER`s turn rate — physical.lua:632', () => {
  /**
   * `addTemporaryValue("global_speed_add", -eff.power)` — the GAIN knob.
   * `SLOW_POWER` is 0.3, so a slowed husk gains 70 energy a tick instead of 100
   * and takes SEVEN turns in the ten a healthy one takes.
   *
   * Reaching for `speedFactor` (the COST knob) instead would make the monster
   * FASTER, with no crash and no type error. This is the assertion that catches
   * the inversion, and it is stated as a count of actions rather than as a
   * multiplier so the sign cannot be argued with.
   */
  it('takes 7 turns in the 10 a healthy husk takes', () => {
    const state = createMvpEffectState();
    const slowed = husk('m1');
    const healthy = husk('m2');

    setEffect(state, slowed, EffectId.Slowed, 99, {}, scriptedRng([]));
    expect(slowed.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);
    expect(healthy.globalSpeed).toBe(1);

    const pass = statusPass(state, createRng('slow-rate'));
    const dragging = runGameTurns(slowed, 10, pass);
    const brisk = runGameTurns(healthy, 10, pass);

    expect(dragging.actions).toBe(7);
    expect(brisk.actions).toBe(10);
  });

  /**
   * SLOW MUST NOT REACH THE BASE CLOCK. `energyBase` accrues a flat
   * ENERGY_PER_TICK and is never multiplied (GameEnergyBased.lua:114-121), so a
   * slowed monster still burns exactly one turn of cooldown per game turn. If
   * slow ever shortened the base clock it would become a way to make a monster's
   * own debuffs expire faster, which is the reverse of the intent.
   */
  it('does not slow the BASE clock: cooldowns and durations still tick once a turn', () => {
    const state = createMvpEffectState();
    const target = husk('m1');
    setCooldown(target, 'talent:crude_blow', 20);
    setEffect(state, target, EffectId.Slowed, 99, {}, scriptedRng([]));

    const run = runGameTurns(target, 10, statusPass(state, createRng('slow-base')));

    expect(run.actions).toBe(7); // the act clock DID slow
    expect(run.basePasses).toBe(10); // the base clock did NOT
    expect(target.cooldowns.get('talent:crude_blow')).toBe(10);
    // Ten turns off a 99-turn slow, on the base clock, at 0.7 speed.
    expect(effectDur(state, target.id, EffectId.Slowed)).toBe(89);
  });

  it('gives the speed back on expiry, from the monster`s own authored baseline', () => {
    const state = createMvpEffectState();
    const brisk = husk('m1', { globalSpeed: 1.4 });

    setEffect(state, brisk, EffectId.Slowed, 2, {}, scriptedRng([]));
    expect(brisk.globalSpeed).toBeCloseTo(1.1, 10);

    // Two ticks to run the duration out, a third for the removal pass (:80-81).
    runGameTurns(brisk, 3, statusPass(state, createRng('slow-expiry')));

    expect(hasEffect(state, brisk.id, EffectId.Slowed)).toBe(false);
    expect(brisk.globalSpeed).toBeCloseTo(1.4, 10);
  });
});

describe('SLOWED spends a PLAYER`s budget instead — DECISIONS.md § D1', () => {
  /**
   * A player's `globalSpeed` is the literal type `1` and readonly, and that is
   * load-bearing rather than fussy: the party is phase-locked so the barrier
   * parks ONCE PER TURN AT FULL QUORUM. Slow one player on the clock and the
   * scheduler starts parking at quorum 1, 2, 3, 2 — and the solo-Bell exemption
   * fires on the single-player parks while three people sit watching.
   *
   * So the player half is game-design.md § 7's "Slowed (−1 MP)": one fewer tile
   * of reach, which on a 30×30 room is the difference between getting to the
   * downed ally this turn and not.
   */
  it('never touches the clock — same speed, same number of turns, one less MP', () => {
    const world = createWorld('slow-player');
    const effects = createMvpEffectState();
    const talents = createContentTalentEngine();

    const dalt = world.addPlayer('p1', 'Dalt');
    const sheet = talents.attach(dalt.id, sheetForClass(WATCHMAN));

    // Long enough to outlive the ten turns driven below — the question here is
    // whether a slow can reach a player's clock at all, not how long it lasts.
    setEffect(effects, dalt, EffectId.Slowed, 99, {}, scriptedRng([]));

    // THE PIN. Both knobs, because the two are confused in opposite directions.
    expect(dalt.globalSpeed).toBe(1);
    expect(dalt.speedFactor).toBe(1);

    const run = runGameTurns(dalt, 10, statusPass(effects, createRng('slow-player-clock')));
    expect(run.actions).toBe(10); // a slowed monster would have taken 7
    expect(run.basePasses).toBe(10);

    // ═══ THE PENALTY IS A QUERY APPLIED AFTER THE REFILL ═══
    // `talentEngine.actBase` sets `ap = maxAp; mp = maxMp` every game turn, so
    // anything subtracted when the effect LANDED is erased on the next turn.
    // This is the exact integration content/effects.ts documents.
    talents.actBase(dalt.id, world);
    expect(sheet.mp).toBe(sheet.maxMp);

    const penalty = budgetPenalty(effects, dalt.id);
    expect(penalty).toEqual({ ap: SLOW_PLAYER_AP_PENALTY, mp: SLOW_PLAYER_MP_PENALTY });

    sheet.ap = Math.max(0, sheet.ap - penalty.ap);
    sheet.mp = Math.max(0, sheet.mp - penalty.mp);
    expect(sheet.mp).toBe(sheet.maxMp - 1);
    // AP is what talents cost. Taking a point of it would silently disable
    // whichever talent sits at the top of the cost curve — a much larger and
    // much less legible nerf than a tile of movement.
    expect(sheet.ap).toBe(sheet.maxAp);
  });

  it('costs a point every turn the slow is live, and none after it expires', () => {
    const world = createWorld('slow-player-turns');
    const effects = createMvpEffectState();
    const talents = createContentTalentEngine();

    const dalt = world.addPlayer('p1', 'Dalt');
    const sheet = talents.attach(dalt.id, sheetForClass(WATCHMAN));
    setEffect(effects, dalt, EffectId.Slowed, 2, {}, scriptedRng([]));

    const pass = statusPass(effects, createRng('slow-player-turns'));
    const perTurn: number[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      actBase(dalt, pass);
      talents.actBase(dalt.id, world);
      sheet.mp = Math.max(0, sheet.mp - budgetPenalty(effects, dalt.id).mp);
      perTurn.push(sheet.mp);
    }

    // dur 2 → the effect is live through turns 1 and 2 and removed by the pass
    // on turn 3 (ActorTemporaryEffects.lua:80-81), so turn 3 is already free.
    const full = sheet.maxMp;
    expect(perTurn).toEqual([full - 1, full - 1, full, full]);
    expect(hasEffect(effects, dalt.id, EffectId.Slowed)).toBe(false);
  });

  it('a slowed player and a slowed husk are the SAME effect with two mechanisms', () => {
    const state = createMvpEffectState();
    const world = createWorld('slow-both');
    const dalt = world.addPlayer('p1', 'Dalt');
    const beast = husk('m1');

    setEffect(state, dalt, EffectId.Slowed, 3, {}, scriptedRng([]));
    setEffect(state, beast, EffectId.Slowed, 3, {}, scriptedRng([]));

    // One definition, one duration, one badge — two different consequences.
    expect(effectDur(state, dalt.id, EffectId.Slowed)).toBe(
      effectDur(state, beast.id, EffectId.Slowed),
    );
    expect(dalt.globalSpeed).toBe(1);
    expect(beast.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);
    expect(budgetPenalty(state, dalt.id).mp).toBe(SLOW_PLAYER_MP_PENALTY);
    // The monster carries the same modifier; nothing reads it for a monster,
    // because a monster has no intra-turn budget to spend.
    expect(budgetPenalty(state, beast.id).mp).toBe(SLOW_PLAYER_MP_PENALTY);
  });
});

// ===========================================================================
// 4. ALL THREE AT ONCE — the statuses have to compose
// ===========================================================================

describe('the three compose without fighting each other', () => {
  it('stacks a stun, a bleed and a slow on one husk and keeps every consequence', () => {
    const state = createMvpEffectState();
    const target = husk('m1', { maxHp: 40 });
    setCooldown(target, 'talent:crude_blow', 8);

    setEffect(state, target, EffectId.Stunned, 2, {}, scriptedRng([]));
    setEffect(state, target, EffectId.Bleeding, 3, { power: 3 }, scriptedRng([]));
    setEffect(state, target, EffectId.Slowed, 3, {}, scriptedRng([]));

    expect(target.combat?.flags?.stunned).toBe(true);
    expect(target.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);

    const run = runGameTurns(target, 3, statusPass(state, createRng('all-three')));

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SOURCELESS BLEED IS SELF-SOURCED, SO THE HUSK'S OWN STUN WEAKENS IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * physical.lua:150 — `projector(eff.src or self, ...)`. With no `srcId` the
     * VICTIM is the source, and `setDefaultProjector` then applies the victim's
     * own Stunned ×0.4 to the wound. This fixture applies the bleed with no
     * source, so all three ticks are penalised: `3 × 3 × 0.4 = 3.6`.
     *
     * IT WAS 9 HERE, and that was our divergence rather than upstream's: the
     * bleed read `src?.combat` — undefined when `eff.src` is absent — where
     * upstream reads `eff.src or self`. Nothing in the live game reaches this
     * branch: `srcId` is set by the swing (scheduler.ts:2612), the projectile
     * (:2796) and every talent that applies a bleed, so a real wound is
     * penalised by the CUTTER's stun. Only a bleed whose source has been reaped
     * self-blames, which is what upstream does with it too.
     */
    expect(target.hp).toBeCloseTo(40 - 3 * 3 * 0.4, 10);
    // Slowed all three turns → 0.7 × 3 turns of gain = 2 actions.
    expect(run.actions).toBe(2);
    expect(run.basePasses).toBe(3);
    // Frozen for turns 1-2, ticking on turn 3 when the stun is removed.
    expect(target.cooldowns.get('talent:crude_blow')).toBe(7);
    // ...and the stun's ×0.4 flag came off with it while the slow stayed on.
    expect(target.combat?.flags?.stunned).toBe(false);
    expect(target.globalSpeed).toBeCloseTo(1 - SLOW_POWER, 10);
  });
});
