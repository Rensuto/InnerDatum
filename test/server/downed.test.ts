import { describe, expect, it } from 'vitest';

import {
  AiProfile,
  HOLD_INTENT,
  IntentKind,
  createMonsterActor,
  createPlayerActor,
} from '../../src/server/engine/actor.ts';
import { createBarrier, inQuorum, isBlocking } from '../../src/server/engine/barrier.ts';
import {
  DOWNED_TURNS,
  DownedMarker,
  DownedTick,
  REVIVE_HP_FRACTION,
  RespawnRefusal,
  ReviveRefusal,
  Survival,
  createDownedState,
  downedSpriteFor,
  downedView,
  forgetActor,
  goDown,
  isDowned,
  isErased,
  resetFloorParty,
  respawn,
  revive,
  survivalOf,
  surveyParty,
  tickDowned,
} from '../../src/server/engine/downed.ts';
import { Refusal, pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { ALCHEMIST, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TICKS_PER_GAME_TURN } from '../../src/shared/energy.ts';
import { ENERGY_TO_ACT } from '../../src/shared/version.ts';
import type { EngineActor, PlayerActor } from '../../src/server/engine/actor.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { GameEvent, PumpResult, SweepStep } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * Downed → revive → Erased → the wipe (game-design.md § 9), which the design doc
 * calls the mechanic that "does more for co-op tension than anything else".
 *
 * The three properties this file exists to defend, in order of how quietly they
 * break:
 *
 *   THE COUNTDOWN IS IN TURNS AND IT ACTUALLY TICKS. `tickLevel`'s `isActive`
 *   gate skips a non-alive actor entirely, so a downed body that is merely
 *   `alive === false` never reaches `actBase` and its five turns sit frozen
 *   forever — a mechanic that silently does not exist, with no failing test
 *   anywhere. The scheduler widens `isActive` for exactly this, and the pump
 *   test below is what proves the widening is live.
 *
 *   EFFECTS TICK BEFORE THE COUNTDOWN, BECAUSE BLEEDING CAN DOWN YOU. Reverse
 *   the two and a body that bled out is reported a whole turn late — a fifth of
 *   the rescue window, spent.
 *
 *   NO PERMADEATH IN M4. A party wipe RESTORES the party and asks the caller to
 *   reset the floor. Nothing in this system removes a body from the world.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function player(id: string, x: number, y: number, maxHp = 60): PlayerActor {
  return createPlayerActor(id, { name: id, sprite: 'chr_player_watchman_s', x, y, maxHp });
}

/** Put a body on the floor the way a killing blow does: 0 HP, then enrol it. */
function knockDown(state: DownedState, actor: PlayerActor, gameTurn = 0): void {
  actor.hp = 0;
  actor.alive = false;
  goDown(state, actor, gameTurn);
}

type Session = {
  readonly world: World;
  readonly downed: DownedState;
  readonly barrier: Barrier;
  readonly advance: (nowMs: number) => PumpResult;
  readonly commit: (actorId: string, nowMs: number) => PumpResult;
  /** Hold with everyone still standing, then resolve. The way a fight is walked forward. */
  readonly holdAll: (nowMs: number) => PumpResult;
  readonly actor: (id: string) => EngineActor;
};

/**
 * A world with a survival table wired in, `players` humans on the spawn cluster
 * — (3,2), (4,2), (5,2), which are mutually adjacent, so a rescue is one step —
 * and `monsters` husks down the corridor with line of sight, which is what arms
 * engagement and therefore the barrier.
 */
function session(seed: string, players: number, monsters: number): Session {
  const world = createWorld(seed);
  const downed = createDownedState();

  for (let i = 0; i < players; i += 1) {
    const actor = world.addPlayer(`p${i + 1}`, `Player ${i + 1}`);
    actor.maxHp = 100;
    actor.hp = 100;
    // Placeholder regen would quietly heal a body between turns and make the
    // countdown tests measure the wrong thing.
    actor.hpRegen = 0;
  }
  for (let i = 0; i < monsters; i += 1) {
    world.addMonster(`m${i + 1}`, {
      name: `Index Husk ${i + 1}`,
      sprite: HUSK_SPRITE,
      x: 7 + i,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
  }

  const barrier = createBarrier();
  return {
    world,
    downed,
    barrier,
    advance: (nowMs) => pump(world, { nowMs, barrier, downed }),
    commit: (actorId, nowMs) => {
      expect(submitIntent(world, barrier, actorId, HOLD_INTENT)).toBe(true);
      return pump(world, { nowMs, barrier, downed });
    },
    holdAll: (nowMs) => {
      for (let i = 0; i < players; i += 1) {
        submitIntent(world, barrier, `p${i + 1}`, HOLD_INTENT);
      }
      return pump(world, { nowMs, barrier, downed });
    },
    actor: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      return found;
    },
  };
}

function sweepSteps(events: readonly GameEvent[]): SweepStep[] {
  const steps: SweepStep[] = [];
  for (const event of events) {
    if (event.t === 'sweep') steps.push(...event.steps);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// The art keys
// ---------------------------------------------------------------------------

describe('the downed body wears its own sprite', () => {
  it('derives every authored downedSprite from the standing one', () => {
    // The engine may not import content/, so `downedSpriteFor` derives the key
    // by convention. This is the test that stops the convention drifting away
    // from the files that actually exist on disk
    // (client/public/assets/characters/chr_player_<class>_downed_s.png, 32x24).
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      expect(downedSpriteFor(definition.sprite)).toBe(definition.downedSprite);
    }
    expect(WATCHMAN.downedSprite).toBe('chr_player_watchman_downed_s');
  });

  it('is idempotent, so a double application cannot produce _downed_downed_s', () => {
    const once = downedSpriteFor('chr_player_watchman_s');
    expect(downedSpriteFor(once)).toBe(once);
  });

  it('names the two 32x32 overlays apart', () => {
    // Two keys, not one with a flag: the stages have to be told apart across a
    // room, because one says RUN and the other says regroup.
    expect(DownedMarker.Downed).toBe('ui_marker_downed');
    expect(DownedMarker.Erased).toBe('ui_marker_erased');
  });
});

// ---------------------------------------------------------------------------
// Going down
// ---------------------------------------------------------------------------

describe('goDown', () => {
  it('puts a player on the floor with five turns, not in a grave', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    dalt.pendingIntent = { kind: IntentKind.Hold };

    const record = goDown(state, dalt, 7);
    expect(record).not.toBeNull();
    expect(record?.turnsLeft).toBe(DOWNED_TURNS);
    expect(DOWNED_TURNS).toBe(5); // game-design.md § 9: "Prone, 5-turn timer."
    expect(record?.total).toBe(DOWNED_TURNS);
    expect(record?.sinceTurn).toBe(7);

    expect(dalt.hp).toBe(0);
    expect(dalt.alive).toBe(false);
    // A body on the floor holds no decisions — one queued before the blow must
    // not resolve the instant somebody picks them up.
    expect(dalt.pendingIntent).toBeNull();
    expect(dalt.sprite).toBe('chr_player_watchman_downed_s');

    expect(survivalOf(state, 'p1')).toBe(Survival.Downed);
    expect(isDowned(state, 'p1')).toBe(true);
    expect(downedView(state, 'p1')).toEqual({
      status: Survival.Downed,
      marker: DownedMarker.Downed,
      turnsLeft: 5,
      total: 5,
    });
  });

  it('refuses a monster — monsters die, they are not downed', () => {
    // The whole mechanic exists so a HUMAN keeps playing. A downed husk would be
    // a five-turn window in which the party debates hitting a corpse again.
    const world = createWorld('monster-down');
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 8,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    const state = createDownedState();
    expect(goDown(state, husk, 0)).toBeNull();
    expect(survivalOf(state, 'm1')).toBe(Survival.Up);
  });

  it('is idempotent — a second blow on the same turn does not restart the clock', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);
    expect(tickDowned(state, dalt)).toBe(DownedTick.Counting);
    expect(downedView(state, 'p1')?.turnsLeft).toBe(4);

    expect(goDown(state, dalt, 1)).toBeNull();
    expect(downedView(state, 'p1')?.turnsLeft).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The countdown
// ---------------------------------------------------------------------------

describe('the countdown', () => {
  it('erases on the fifth tick and not the fourth', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);

    for (let turn = 1; turn < DOWNED_TURNS; turn += 1) {
      expect(tickDowned(state, dalt)).toBe(DownedTick.Counting);
      expect(downedView(state, 'p1')?.turnsLeft).toBe(DOWNED_TURNS - turn);
    }
    expect(tickDowned(state, dalt)).toBe(DownedTick.Erased);

    expect(isErased(state, 'p1')).toBe(true);
    expect(downedView(state, 'p1')).toEqual({
      status: Survival.Erased,
      marker: DownedMarker.Erased,
      turnsLeft: 0,
      total: 5,
    });
    // NOT PERMADEATH. The body is still there, still on its tile, still wearing
    // the downed sprite — only the overlay changed. M4 has no way to delete one.
    expect(dalt.sprite).toBe('chr_player_watchman_downed_s');
  });

  it('stops at Erased rather than counting into the negatives', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, dalt);

    expect(tickDowned(state, dalt)).toBe(DownedTick.None);
    expect(downedView(state, 'p1')?.turnsLeft).toBe(0);
  });

  it('does nothing at all to somebody on their feet', () => {
    const state = createDownedState();
    expect(tickDowned(state, player('p1', 3, 2))).toBe(DownedTick.None);
  });
});

// ---------------------------------------------------------------------------
// Out of the quorum
// ---------------------------------------------------------------------------

describe('a downed body is out of the quorum', () => {
  it('falls out of inQuorum and isBlocking without a second predicate', () => {
    // `alive === false` is what does it, and that is the whole argument for
    // reusing the field: the Bell then counts the SURVIVORS at their real party
    // size instead of waiting on somebody lying on the floor. This is why the
    // Bell suddenly matters (game-design.md § 9).
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    dalt.energy = ENERGY_TO_ACT;
    const level = { engagement: 3, bossFloor: false };

    expect(inQuorum(dalt)).toBe(true);
    expect(isBlocking(dalt, level)).toBe(true);

    knockDown(state, dalt);
    expect(inQuorum(dalt)).toBe(false);
    expect(isBlocking(dalt, level)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ...and cannot act
// ---------------------------------------------------------------------------

describe('a downed body cannot act', () => {
  it('drops the decision it was holding and refuses every new one', () => {
    const table = session('cannot-act', 2, 0);
    table.advance(0);
    const dalt = table.actor('p1');

    expect(submitIntent(table.world, table.barrier, 'p1', HOLD_INTENT)).toBe(true);
    expect(dalt.pendingIntent).not.toBeNull();

    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);

    // A body on the floor holds no decisions. Leaving one pending would let it
    // resolve the instant somebody picked them up, three turns after they chose
    // it — the same argument the refund rule makes about stale intents.
    expect(dalt.pendingIntent).toBeNull();
    // `submitIntent` refuses outright: there is no such LIVING actor.
    expect(submitIntent(table.world, table.barrier, 'p1', HOLD_INTENT)).toBe(false);
    expect(dalt.pendingIntent).toBeNull();
  });

  it('banks a full turn it can never spend while the countdown runs', () => {
    const table = session('no-turn', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);

    for (let turn = 1; turn <= 3; turn += 1) table.commit('p2', turn);

    // The body IS still ticked — that is the widening of `isActive` that makes
    // the countdown exist at all — so its act clock fills to the threshold and
    // then stops there: `grantEnergy` refuses to bank past it, and `act` returns
    // `Done` without spending because the body is not alive. Energy that moved
    // would mean a corpse took a turn.
    expect(dalt.energy).toBe(ENERGY_TO_ACT);
    // And the countdown, which is the thing that IS supposed to move.
    expect(downedView(table.downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS - 3);
  });
});

// ---------------------------------------------------------------------------
// Getting back up
// ---------------------------------------------------------------------------

describe('revive', () => {
  it('restores 25% HP, clears the countdown and gives the sprite back', () => {
    // game-design.md § 9: "Any ally reaching you spends 4 AP to restore you at
    // 25% HP." maxHp 60 -> ceil(15) = 15.
    const state = createDownedState();
    const dalt = player('p1', 3, 2, 60);
    const sam = player('p2', 4, 2);
    knockDown(state, dalt);
    tickDowned(state, dalt); // 4 left, so `turnsSpared` is a real number

    const result = revive(state, dalt, sam);
    expect(result).toEqual({ ok: true, hp: 15, turnsSpared: 4 });
    expect(REVIVE_HP_FRACTION).toBe(0.25);

    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(15);
    expect(dalt.sprite).toBe('chr_player_watchman_s');
    // CLEARED, not paused: going down again must buy a fresh five turns, or the
    // second rescue is quietly hopeless.
    expect(survivalOf(state, 'p1')).toBe(Survival.Up);
    expect(downedView(state, 'p1')).toBeUndefined();
  });

  /**
   * THE COUNTDOWN IS CLEARED, NOT PAUSED. A player picked up with one turn to
   * spare and knocked straight back down must get five turns again, not one. The
   * plausible-wrong version keeps the record and merely un-flags the body, and
   * the symptom is a second rescue that is quietly impossible — the worst kind
   * of bug in a mechanic whose entire job is to say "GET TO ME".
   */
  it('a body that goes down again gets a FRESH five turns, not the remains', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2, 60);
    const sam = player('p2', 4, 2);

    knockDown(state, dalt);
    tickDowned(state, dalt);
    tickDowned(state, dalt);
    tickDowned(state, dalt);
    tickDowned(state, dalt);
    expect(downedView(state, 'p1')?.turnsLeft).toBe(1); // one turn from Erased

    expect(revive(state, dalt, sam)).toEqual({ ok: true, hp: 15, turnsSpared: 1 });
    expect(survivalOf(state, 'p1')).toBe(Survival.Up);

    knockDown(state, dalt);
    expect(downedView(state, 'p1')?.turnsLeft).toBe(DOWNED_TURNS);
    expect(downedView(state, 'p1')?.total).toBe(DOWNED_TURNS);
  });

  it('rounds the Watchman up to 18 of his 72', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2, WATCHMAN.maxHp);
    const sam = player('p2', 4, 2);
    knockDown(state, dalt);

    expect(WATCHMAN.maxHp).toBe(72);
    expect(revive(state, dalt, sam)).toEqual({ ok: true, hp: 18, turnsSpared: 5 });
  });

  it('never returns somebody at 0 HP', () => {
    // A body that came back at 0 would be downed again by the next applyDamage,
    // which reads to a player as a taunt rather than a rescue.
    const state = createDownedState();
    const frail = player('p1', 3, 2, 1);
    const sam = player('p2', 4, 2);
    knockDown(state, frail);

    const result = revive(state, frail, sam);
    expect(result.ok && result.hp).toBe(1);
    expect(frail.hp).toBeGreaterThan(0);
  });

  it('reaches on the diagonal, because adjacency is Chebyshev', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 4, 3);
    knockDown(state, dalt);
    expect(revive(state, dalt, sam).ok).toBe(true);
  });

  it('refuses from two tiles away, and OUT_OF_REACH is not NOT_DOWNED', () => {
    // The two refusals carry opposite instructions — one says close in, the
    // other says they are fine, do something else. Reporting the wrong one in
    // the middle of a rescue is how a player learns to distrust the button.
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 5, 2);
    knockDown(state, dalt);

    expect(revive(state, dalt, sam)).toEqual({ ok: false, reason: ReviveRefusal.OutOfReach });
    expect(dalt.alive).toBe(false);
  });

  it('refuses somebody who is not down, an Erased body, and a rescuer on the floor', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 4, 2);

    expect(revive(state, dalt, sam)).toEqual({ ok: false, reason: ReviveRefusal.NotDowned });

    knockDown(state, dalt);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, dalt);
    // Only a floor reset brings an Erased body back — and the floor reset is not
    // a death, it is a restart. See the wipe tests.
    expect(revive(state, dalt, sam)).toEqual({ ok: false, reason: ReviveRefusal.Erased });

    const state2 = createDownedState();
    const rey = player('p3', 3, 2);
    const alsoDown = player('p4', 4, 2);
    knockDown(state2, rey);
    knockDown(state2, alsoDown);
    expect(revive(state2, rey, alsoDown)).toEqual({
      ok: false,
      reason: ReviveRefusal.RescuerDown,
    });
  });

  it('refuses a monster standing over a detective', () => {
    const world = createWorld('not-an-ally');
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 4,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);

    expect(revive(state, dalt, husk)).toEqual({ ok: false, reason: ReviveRefusal.NotAnAlly });
  });
});

// ---------------------------------------------------------------------------
// The party survey and the wipe
// ---------------------------------------------------------------------------

describe('surveyParty', () => {
  /** Everybody is at the keyboard — the ordinary case, stated explicitly. */
  const allPresent = (): boolean => true;

  it('splits the party three ways and only calls a wipe when nobody is up', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 4, 2);
    const rey = player('p3', 5, 2);

    expect(surveyParty([dalt, sam, rey], state, allPresent)).toEqual({
      up: ['p1', 'p2', 'p3'],
      survivors: ['p1', 'p2', 'p3'],
      downed: [],
      erased: [],
      wiped: false,
    });

    knockDown(state, dalt);
    knockDown(state, sam);
    expect(surveyParty([dalt, sam, rey], state, allPresent).wiped).toBe(false);

    knockDown(state, rey);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, rey);
    expect(surveyParty([dalt, sam, rey], state, allPresent)).toEqual({
      up: [],
      survivors: [],
      downed: ['p1', 'p2'],
      erased: ['p3'],
      wiped: true,
    });
  });

  it('an empty party is not a wipe', () => {
    // Without this clause a freshly booted server would report a party wipe on
    // every game turn and reset a floor nobody is standing on.
    expect(surveyParty([], createDownedState(), allPresent).wiped).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE GHOST. Reported from real co-op play; see engine/downed.ts's header.
  // -------------------------------------------------------------------------

  it('does NOT count a body nobody is driving as a survivor', () => {
    // The bug, exactly as it happened: a friend closed the activity, their body
    // stayed standing (M2 keeps it there on purpose), and the player who went
    // down could never reach a wipe — no floor reset, no way back, forever.
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const ghost = player('p2', 4, 2);
    knockDown(state, dalt);

    const survey = surveyParty([dalt, ghost], state, (id) => id !== 'p2');
    expect(survey.wiped).toBe(true);
    // AND THE GHOST IS STILL `up`. It is not dead and it is not Downed: its
    // owner may walk back in and find it at the hp they left it on. Filing it
    // under `downed` would put a countdown on a healthy body.
    expect(survey.up).toEqual(['p2']);
    expect(survey.survivors).toEqual([]);
    expect(survey.downed).toEqual(['p1']);
    expect(state.byActor.has('p2')).toBe(false);
  });

  it('one present survivor is enough, however many ghosts stand beside them', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 4, 2);
    const rey = player('p3', 5, 2);
    knockDown(state, dalt);

    const survey = surveyParty([dalt, sam, rey], state, (id) => id === 'p3');
    expect(survey.wiped).toBe(false);
    expect(survey.survivors).toEqual(['p3']);
  });

  it('a party nobody is driving at all is still not a wipe while everyone is up', () => {
    // Two ghosts and nobody on the floor: there is nothing to restore and no
    // floor to reset, and firing a wipe here would rewrite two absent players'
    // hp for no reason. The `downed + erased > 0` clause is what stops it.
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    const sam = player('p2', 4, 2);
    expect(surveyParty([dalt, sam], state, () => false).wiped).toBe(false);
  });
});

describe('resetFloorParty — M4 has NO permadeath', () => {
  it('puts everybody back at full HP with both clocks re-zeroed', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2, 60);
    const sam = player('p2', 4, 2, 60);
    dalt.energy = 900;
    dalt.energyBase = 700;
    knockDown(state, dalt);
    knockDown(state, sam);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, sam);

    expect(resetFloorParty([dalt, sam], state)).toEqual(['p1', 'p2']);

    for (const actor of [dalt, sam]) {
      expect(actor.alive).toBe(true);
      expect(actor.hp).toBe(60);
      expect(actor.sprite).toBe('chr_player_watchman_s');
      expect(survivalOf(state, actor.id)).toBe(Survival.Up);
      // Both clocks to zero, so the party lands PHASE-LOCKED and parks together
      // on the next turn instead of trickling in one at a time (D1).
      expect(actor.energy).toBe(0);
      expect(actor.energyBase).toBe(0);
    }
  });

  it('restores an ERASED body too — being erased is not being deleted', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, dalt);
    expect(isErased(state, 'p1')).toBe(true);

    resetFloorParty([dalt], state);
    expect(dalt.alive).toBe(true);
    expect(survivalOf(state, 'p1')).toBe(Survival.Up);
  });

  it('leaves somebody who was never down alone', () => {
    const state = createDownedState();
    const sam = player('p2', 4, 2, 60);
    sam.hp = 12;
    sam.energy = 1000;
    expect(resetFloorParty([sam], state)).toEqual([]);
    expect(sam.hp).toBe(12);
    expect(sam.energy).toBe(1000);
  });
});

describe('respawn — a way back out of Erased', () => {
  /** Erased: down, then the whole countdown spent. */
  function erase(state: DownedState, actor: PlayerActor): void {
    knockDown(state, actor);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(state, actor);
    expect(isErased(state, actor.id)).toBe(true);
  }

  it('stands an ERASED body up at full HP with both clocks re-zeroed', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2, 60);
    dalt.energy = 900;
    dalt.energyBase = 700;
    erase(state, dalt);

    const result = respawn(state, dalt);
    expect(result).toEqual({ ok: true, hp: 60, downedSinceTurn: 0 });
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(60);
    // The standing sprite comes back off the record, not re-derived, so a body
    // wearing something unusual when it fell gets that back.
    expect(dalt.sprite).toBe('chr_player_watchman_s');
    expect(survivalOf(state, 'p1')).toBe(Survival.Up);
    // Phase-locked, exactly as the wipe leaves them (D1): a body holding a full
    // act bar would take its turn inside the tick it was restored in.
    expect(dalt.energy).toBe(0);
    expect(dalt.energyBase).toBe(0);
    expect(dalt.pendingIntent).toBeNull();
  });

  it('REFUSES a body that is merely Downed — the countdown is the mechanic', () => {
    // game-design.md § 9: the five turns are what turn "I died" into "GET TO
    // ME". A player who could stand themselves up would never be worth running
    // to, and the refusal is what protects that.
    const state = createDownedState();
    const dalt = player('p1', 3, 2, 60);
    knockDown(state, dalt);

    expect(respawn(state, dalt)).toEqual({ ok: false, reason: RespawnRefusal.Downed });
    // AND IT COST NOTHING. A refusal must not half-restore anybody.
    expect(dalt.alive).toBe(false);
    expect(dalt.hp).toBe(0);
    expect(isDowned(state, 'p1')).toBe(true);
    expect(downedView(state, 'p1')?.turnsLeft).toBe(DOWNED_TURNS);
  });

  it('refuses a body that is already up', () => {
    const state = createDownedState();
    const sam = player('p2', 4, 2, 60);
    sam.hp = 12;
    expect(respawn(state, sam)).toEqual({ ok: false, reason: RespawnRefusal.Up });
    // Not a free heal. The commonest way to press this key is by accident.
    expect(sam.hp).toBe(12);
  });

  it('refuses a monster outright — monsters die, they are not Unfiled', () => {
    const state = createDownedState();
    const husk: EngineActor = createMonsterActor('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    expect(respawn(state, husk)).toEqual({ ok: false, reason: RespawnRefusal.NotAPlayer });
  });

  it('is exactly the restoration a wipe performs — no permadeath either way', () => {
    // Two identical bodies, one restored by the floor reset and one by its own
    // hand. If these two ever diverge, one of them has forgotten a clock.
    const wiped = createDownedState();
    const byWipe = player('p1', 3, 2, 60);
    byWipe.energy = 500;
    erase(wiped, byWipe);
    resetFloorParty([byWipe], wiped);

    const solo = createDownedState();
    const bySelf = player('p1', 3, 2, 60);
    bySelf.energy = 500;
    erase(solo, bySelf);
    expect(respawn(solo, bySelf).ok).toBe(true);

    expect(bySelf.hp).toBe(byWipe.hp);
    expect(bySelf.alive).toBe(byWipe.alive);
    expect(bySelf.sprite).toBe(byWipe.sprite);
    expect(bySelf.energy).toBe(byWipe.energy);
    expect(bySelf.energyBase).toBe(byWipe.energyBase);
  });
});

describe('forgetActor', () => {
  it('drops the record for a body that has genuinely left the world', () => {
    const state = createDownedState();
    const dalt = player('p1', 3, 2);
    knockDown(state, dalt);
    forgetActor(state, 'p1');
    expect(survivalOf(state, 'p1')).toBe(Survival.Up);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real pump
// ---------------------------------------------------------------------------

describe('through pump', () => {
  it('a monster blow downs a player INSIDE the batched sweep', () => {
    const table = session('down-in-sweep', 2, 1);
    table.advance(0);
    // Both, because the husk chases the NEAREST hostile (ai/simple.lua:259-267)
    // and which of two adjacent detectives that is, is not this test's business.
    for (const id of ['p1', 'p2']) table.actor(id).hp = 1;

    let step: SweepStep | undefined;
    let loose = false;
    for (let turn = 1; turn <= 30 && step === undefined; turn += 1) {
      const result = table.holdAll(turn);
      step ??= sweepSteps(result.events).find((entry) => entry.t === 'downed');
      loose ||= result.events.some((event) => event.t === 'downed');
    }

    // The downing is a SWEEP STEP, not a loose event: it is part of the monster
    // turn the client is already pacing, and pushing it as an ordinary event
    // would close the batch and split one sweep into two.
    expect(step).toBeDefined();
    if (step === undefined || step.t !== 'downed') throw new Error('expected a downed step');
    expect(step.turnsLeft).toBe(DOWNED_TURNS);
    expect(isDowned(table.downed, step.id)).toBe(true);
    expect(table.actor(step.id).alive).toBe(false);
    expect(loose).toBe(false);
  });

  it('ticks the countdown once per game turn and erases at zero', () => {
    // THE WIDENING THAT MAKES THE MECHANIC EXIST: `tickLevel`'s `isActive` gate
    // skips a non-alive actor entirely, so without the scheduler's "alive, or a
    // body still counting down" clause this countdown would never move and
    // nothing else would fail.
    const table = session('countdown', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);
    expect(downedView(table.downed, 'p1')?.turnsLeft).toBe(5);

    // p2 holds each turn, which is what spends energy and moves the clock.
    for (let turn = 1; turn <= 4; turn += 1) {
      const result = table.commit('p2', turn);
      expect(result.gameTurns).toBe(1);
      expect(downedView(table.downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS - turn);
      expect(result.events.some((event) => event.t === 'erased')).toBe(false);
    }

    const last = table.commit('p2', 5);
    expect(last.events).toContainEqual({ t: 'erased', id: 'p1' });
    expect(isErased(table.downed, 'p1')).toBe(true);
    // The body is still in the world. Nothing in M4 removes one.
    expect(table.world.getActor('p1')).toBeDefined();
  });

  it('an adjacent ally spends a turn and picks them up', () => {
    const table = session('rescue', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    const sam = table.actor('p2');
    // (3,2) and (4,2) — the authored spawn cluster is contiguous, so a rescue is
    // one step and "GET TO ME" is a sentence somebody can act on.
    expect(Math.abs(dalt.x - sam.x) + Math.abs(dalt.y - sam.y)).toBe(1);

    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, 0);
    table.commit('p2', 1); // one turn on the clock, so turnsSpared is 4

    const before = sam.energy;
    expect(
      submitIntent(table.world, createBarrier(), 'p2', {
        kind: IntentKind.Revive,
        targetId: 'p1',
      }),
    ).toBe(true);
    const result = pump(table.world, { nowMs: 2, barrier: createBarrier(), downed: table.downed });

    expect(result.events).toContainEqual({
      t: 'revived',
      id: 'p1',
      byId: 'p2',
      hp: 25,
      turnsSpared: 4,
    });
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(25); // maxHp 100 -> ceil(25)
    expect(survivalOf(table.downed, 'p1')).toBe(Survival.Up);
    // The rescue cost the rescuer their whole turn.
    expect(sam.energy).toBeLessThan(before + ENERGY_TO_ACT);
  });

  it('a rescuer two tiles away is refunded, not teleported into reach', () => {
    // The spawn cluster is (3,2) (4,2) (5,2), so p3 is exactly two tiles from
    // p1 — adjacent to the adjacent one, and that is not adjacent. `REVIVE_REACH`
    // is Chebyshev, the same metric a monster reaches you with, so a rescuer can
    // never end up in a tile from which they can be hit but cannot help.
    const table = session('reach-refund', 3, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    const far = table.actor('p3');
    expect(Math.max(Math.abs(far.x - dalt.x), Math.abs(far.y - dalt.y))).toBe(2);

    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);

    const energyBefore = far.energy;
    const barrier = createBarrier();
    submitIntent(table.world, barrier, 'p3', { kind: IntentKind.Revive, targetId: 'p1' });
    const result = pump(table.world, { nowMs: 1, barrier, downed: table.downed });

    // THE MAPPING IS DELIBERATE and worth pinning: the engine's own vocabulary
    // is `ReviveRefusal.OutOfReach`; the WIRE's is `Refusal.OutOfRange`, shared
    // with every other "too far away" refusal so the client has one message to
    // render. What must never collapse is OutOfRange (close in) against
    // NotDowned (they are fine, do something else) — opposite instructions.
    expect(revive(table.downed, dalt, far).ok).toBe(false);
    expect(result.events).toContainEqual({
      t: 'refunded',
      id: 'p3',
      reason: Refusal.OutOfRange,
    });
    // Zero cost, and re-prompted: the answer to "they moved" is another go, not
    // a wasted turn. Nobody got up.
    expect(far.energy).toBe(energyBefore);
    expect(result.parked).toContain('p3');
    expect(isDowned(table.downed, 'p1')).toBe(true);
    expect(dalt.alive).toBe(false);
  });

  it('a refused revive costs ZERO and re-prompts — the refund rule', () => {
    const table = session('refund', 2, 1);
    table.advance(0);

    const sam = table.actor('p2');
    const energyBefore = sam.energy;

    // Nobody is down. game-design.md's whole point about the refund rule is that
    // pressing the button in the one moment you must not hesitate is free.
    const barrier = createBarrier();
    submitIntent(table.world, barrier, 'p2', { kind: IntentKind.Revive, targetId: 'p1' });
    const result = pump(table.world, { nowMs: 1, barrier, downed: table.downed });

    expect(result.events).toContainEqual({ t: 'refunded', id: 'p2', reason: 'not_downed' });
    expect(sam.energy).toBe(energyBefore);
    expect(result.parked).toContain('p2');
  });

  it('resets the floor party the moment the last body hits the ground', () => {
    // Checked at the moment of the wipe rather than at a turn boundary, because
    // at that moment NOTHING is left to move: no player can act, no monster has
    // a target, and `tickLevel` reaches its idle fixed point. Waiting for a turn
    // that will never complete would leave the party watching a frozen screen.
    const table = session('wipe', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    const sam = table.actor('p2');
    for (const actor of [dalt, sam]) {
      actor.hp = 0;
      actor.alive = false;
    }
    goDown(table.downed, dalt, 0);

    // The wipe fires inside the next pump's actBase pass, when p2 is enrolled.
    const result = pump(table.world, { nowMs: 1, barrier: createBarrier(), downed: table.downed });

    const wipe = result.events.find((event) => event.t === 'party_wipe');
    expect(wipe).toBeDefined();
    if (wipe === undefined || wipe.t !== 'party_wipe') throw new Error('expected a party wipe');
    expect([...wipe.restored].sort()).toEqual(['p1', 'p2']);

    // NO PERMADEATH, NO LOSS (game-design.md § 9): both bodies are up, whole,
    // and still in the world.
    for (const actor of [dalt, sam]) {
      expect(actor.alive).toBe(true);
      expect(actor.hp).toBe(actor.maxHp);
      expect(survivalOf(table.downed, actor.id)).toBe(Survival.Up);
      expect(table.world.getActor(actor.id)).toBeDefined();
    }
  });

  it('WIPES WHEN THE ONLY OTHER BODY IS A GHOST — the bug that stranded somebody', () => {
    // THE REPORT, END TO END. Two players; one closes the activity, which the
    // gateway's close handler turns into `barrier.disconnect` immediately. The
    // body stays standing (M2 keeps it there on purpose) and used to count as a
    // survivor, so the player who actually went down was Downed, then Erased,
    // then nothing — no reset, no rescue, no way back.
    const table = session('ghost-wipe', 2, 0);
    table.advance(0);
    table.barrier.disconnect(table.actor('p2'), 0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;

    // `enrolCasualties` on the way in: a body that fell outside a pump is the
    // one case that can only be seen here.
    const result = table.advance(1);
    const wipe = result.events.find((event) => event.t === 'party_wipe');
    expect(wipe).toBeDefined();
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(dalt.maxHp);
    expect(survivalOf(table.downed, 'p1')).toBe(Survival.Up);

    // AND THE GHOST WAS NOT TOUCHED. It had no record, so `resetFloorParty`
    // leaves it exactly as its owner left it — including Standing By, because
    // somebody who walked away has not come back just because the floor did.
    const ghost = table.actor('p2');
    expect(ghost.connected).toBe(false);
    expect(ghost.standingBy).toBe(true);
    expect(wipe?.t === 'party_wipe' ? [...wipe.restored] : []).toEqual(['p1']);
  });

  it('a friend who is genuinely there still holds the wipe off', () => {
    // The other half of the same predicate: a present survivor means the party
    // is NOT wiped, the five-turn countdown runs, and "GET TO ME" still means
    // something. Nothing about the fix makes the mechanic easier to reach.
    const table = session('present-no-wipe', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;

    const result = table.advance(1);
    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);
    expect(isDowned(table.downed, 'p1')).toBe(true);
  });

  it('wipes at most once per pump, so a reset cannot loop inside one call', () => {
    const table = session('wipe-once', 1, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;

    const result = pump(table.world, { nowMs: 1, barrier: createBarrier(), downed: table.downed });
    expect(result.events.filter((event) => event.t === 'party_wipe')).toHaveLength(1);
  });

  it('behaves exactly as it did before M4 when no survival table is supplied', () => {
    // Every survival branch is gated on `ctx.downed`. Absent, 0 HP is a corpse
    // and `pump(world, { nowMs, barrier })` is unchanged to the byte.
    const world = createWorld('no-survival');
    const dalt = world.addPlayer('p1', 'Dalt');
    world.addPlayer('p2', 'Sam');
    world.addMonster('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 8,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    const barrier = createBarrier();

    pump(world, { nowMs: 0, barrier });
    dalt.hp = 0;
    dalt.alive = false;

    const result = pump(world, { nowMs: 1, barrier });
    expect(result.events.some((event) => event.t === 'downed')).toBe(false);
    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);
    expect(result.parked).not.toContain('p1');
  });

  it('drains the status log into events in the lane it happened in', () => {
    const table = session('status-lane', 2, 0);
    const pending = [
      { actorId: 'p1', effectId: 'effect:slowed', kind: 'gained' as const, dur: 1, maximum: 3 },
    ];
    const result = pump(table.world, {
      nowMs: 0,
      barrier: createBarrier(),
      downed: table.downed,
      drainStatusLog: () => pending.splice(0, pending.length),
    });

    // game-design.md § 11's own log line needs every field: "Dalt saves
    // (phys 38 vs power 31, 68%) — Slowed 1 turn, not 3."
    expect(result.events[0]).toEqual({
      t: 'status',
      note: { actorId: 'p1', effectId: 'effect:slowed', kind: 'gained', dur: 1, maximum: 3 },
    });
    // Drained, not copied: a second pump must not replay it.
    const again = pump(table.world, {
      nowMs: 1,
      barrier: createBarrier(),
      downed: table.downed,
      drainStatusLog: () => pending.splice(0, pending.length),
    });
    expect(again.events.some((event) => event.t === 'status')).toBe(false);
  });

  it('parks the survivors at their real party size once a body is on the floor', () => {
    // The Bell counts the quorum, and a downed body is out of it. This is the
    // co-op consequence game-design.md § 9 is actually about: with one of two
    // down, the survivor is a party of one and gets the SOLO bell rather than
    // twenty seconds of pressure while nobody is waiting on them.
    const table = session('quorum', 2, 1);
    const first = table.advance(0);
    expect(first.parked).toEqual(['p1', 'p2']);
    expect(first.bell.quorum).toBe(2);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);

    const after = pump(table.world, { nowMs: 1, barrier: createBarrier(), downed: table.downed });
    expect(after.parked).toEqual(['p2']);
    expect(after.bell.quorum).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The order in the actBase pass: effects, THEN the countdown
// ---------------------------------------------------------------------------

describe('bleeding can down you', () => {
  it('enrols a body that bled out on the SAME turn, with all five turns intact', () => {
    // physical.lua:149-151's `on_timeout` projects its damage inside
    // `timedEffects`, which runs inside `actBase` (Actor.lua:597). So the status
    // pass has to come first: by the time the survival pass looks, the body is
    // already at 0 HP and gets enrolled on the turn it actually fell. Run the
    // countdown first and the party is told a turn late — a fifth of the rescue
    // window, spent.
    //
    // The bleed is simulated with the same seam the real effect system uses (the
    // `statusPass` callback, engine/effects.ts#statusPass), so the ORDER under
    // test is the real one rather than a re-implementation of it.
    const table = session('bleed-out', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 3;

    const barrier = createBarrier();
    submitIntent(table.world, barrier, 'p2', HOLD_INTENT);
    const result = pump(table.world, {
      nowMs: 1,
      barrier,
      downed: table.downed,
      statusPass: (actor) => {
        if (actor.id === 'p1' && actor.alive) {
          dalt.hp = 0;
          dalt.alive = false;
        }
        return false;
      },
    });

    expect(result.events).toContainEqual({ t: 'downed', id: 'p1', turnsLeft: DOWNED_TURNS });
    // FIVE, not four: a body enrolled on this pass does not also tick on it —
    // the same shape as ActorTemporaryEffects.lua:91 decrementing AFTER
    // `on_timeout`.
    expect(downedView(table.downed, 'p1')?.turnsLeft).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The stun freeze, from the survival side (Actor.lua:606)
// ---------------------------------------------------------------------------

describe('the base clock is the only clock any of this runs on', () => {
  it('ticks the countdown exactly once per GAME TURN, never once per tick', () => {
    const table = session('one-per-turn', 2, 0);
    table.advance(0);

    const dalt = table.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;
    goDown(table.downed, dalt, table.world.turn.clock.gameTurn);

    const result = table.commit('p2', 1);
    // Ten engine ticks, one game turn, ONE decrement. If the countdown ever
    // moved on the act clock instead, this would be 10 and a hasted monster
    // could run out your friend's five turns.
    expect(result.ticks).toBe(TICKS_PER_GAME_TURN);
    expect(downedView(table.downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS - 1);
  });
});
