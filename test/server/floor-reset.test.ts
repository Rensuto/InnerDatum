import { describe, expect, it, vi } from 'vitest';

import { seedTestEncounter } from '../../src/server/content/encounter.ts';
import { ITEMS } from '../../src/server/content/items.ts';
import { AiProfile, IntentKind } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite } from '../../src/server/engine/party.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { ErasedReason, TileCode } from '../../src/shared/protocol.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { TurnLogger } from '../../src/server/turn-engine.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { TurnEvent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR RESET — THE HALF THE ENGINE MAY NOT DO, AND HAD NEVER BEEN WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resetFloorParty` (engine/downed.ts) puts every body back on its feet at full
 * hp and re-zeroes both clocks. It deliberately does not MOVE anything, because
 * nothing in engine/ knows where a spawn tile is or how to re-seed content — its
 * header says so and ends with *"the `party_wipe` event is the seam"*.
 *
 * Nothing was on the far side of that seam. So a wipe restored the party IN
 * PLACE, one tile from the monster that had just killed them, still engaged; the
 * monster swung again and the whole thing repeated. Verbatim, from a live
 * session's Case Log at turn 162:
 *
 *     Ren is erased — the party is down. The floor resets.
 *     Index Wraith hits Ren.  3 damage. Ren 60/60.
 *     Ren is unfiled.
 *     Ren is DOWN — 5 turns to reach them.
 *
 * Three separate defects are visible in those four lines and this file pins all
 * three:
 *
 *   THE RESET DID NOT RESET ANYTHING but hit points — hence the loop.
 *   THE LOG LIED ABOUT ORDER — the reset is announced two lines above the blow
 *   that caused it, because a wipe raised during the monster sweep was filed in
 *   the player lane, which is broadcast first.
 *   THE LOG LIED ABOUT HP — "60/60" is Ren's hp AFTER the restoration, read off
 *   the body long after the blow landed, printed one line above "is unfiled".
 */

const WRAITH_SPRITE = 'enemy_index_wraith_s';

/**
 * A COMBAT SHEET WHOSE BLOW ALWAYS LANDS.
 *
 * Every test below turns on a monster actually hitting the detective: the hp the
 * blow left, the tile it landed on, the lane the wipe was filed in. Since
 * `scheduler.ts#strike` moved onto `combat.ts#attackTarget` a swing ROLLS TO
 * HIT, and a sheet-less monster falls through to ToME's bare level-1 defaults —
 * `combatAttack({}) = 4` against a classless detective's `combatDefense` 0, so
 * ceil(50 + 2.5 × 4) = 60%. Two in five seeds would produce a miss, no `damage`
 * frame, no death, and a test failure that reads as a regression in the floor
 * reset.
 *
 * `mods.atk` 18 rescales to `combatAttack` 21, so the chance is ceil(50 + 52.5)
 * = 103, bounded to 100. FIXED BY ACCURACY, NOT BY RE-ROLLING THE SEED: a seed
 * chosen because it happened to pass converts a structural guarantee into a
 * coincidence that stops holding the next time anything upstream draws.
 */
const NEVER_MISSES: CombatSheet = { mods: { atk: 18 } };

/** A logger that records, so "it warned" and "it did not" are both assertable. */
function spyLogger(): TurnLogger & {
  readonly warns: string[];
  readonly errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    info: () => undefined,
    warn: (_context, message) => warns.push(message),
    error: (_context, message) => errors.push(message),
  };
}

type Scene = {
  readonly world: World;
  readonly downed: DownedState;
  readonly log: ReturnType<typeof spyLogger>;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
  /** Put a body on the floor the way a killing blow does. */
  readonly knockDown: (id: string) => void;
};

/**
 * One player standing deep in the level with a monster breathing on them — the
 * board state the report describes. The player is deliberately NOT on a spawn
 * tile, because "did the reset move them" is the whole question.
 *
 * `reseedFloor` is left at its default (`seedTestEncounter`), so what these
 * tests exercise is the production path rather than a stub of it.
 */
function scene(seed: string, options: { readonly reseed?: (world: World) => void } = {}): Scene {
  const world = createWorld(seed);
  const downed = createDownedState();
  const log = spyLogger();

  const dalt = world.addPlayer('p1', 'Ren');
  dalt.hpRegen = 0;
  // Away from the spawn cluster and next to the thing that will kill them.
  dalt.x = 22;
  dalt.y = 20;
  world.addMonster('m_wraith', {
    name: 'Index Wraith',
    sprite: WRAITH_SPRITE,
    x: 23,
    y: 20,
    profile: AiProfile.MeleeChaser,
    combat: NEVER_MISSES,
  });

  const actor = (id: string): Actor => {
    const found = world.getActor(id);
    if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
    return found;
  };

  return {
    world,
    downed,
    log,
    engine: createTurnEngine({
      world,
      downed,
      log,
      now: () => 0,
      ...(options.reseed === undefined ? {} : { reseedFloor: options.reseed }),
    }),
    actor,
    knockDown: (id) => {
      const body = actor(id);
      body.hp = 0;
      body.alive = false;
      goDown(downed, body, world.turn.clock.gameTurn);
    },
  };
}

/** Every living monster on the floor. */
function monsters(world: World): Actor[] {
  return world.allActors().filter((a) => a.kind === 'monster');
}

// ---------------------------------------------------------------------------
// FIX A — a floor reset must leave the party somewhere survivable
// ---------------------------------------------------------------------------

describe('a party wipe actually resets the floor', () => {
  it('MOVES THE RESTORED PARTY OFF THE TILE THEY DIED ON — the loop, closed', () => {
    const stuck = scene('reset-moves');
    const fell = { x: stuck.actor('p1').x, y: stuck.actor('p1').y };

    stuck.knockDown('p1');
    stuck.engine.pump();

    const ren = stuck.actor('p1');
    // Restored by the engine...
    expect(ren.alive).toBe(true);
    expect(ren.hp).toBe(ren.maxHp);
    // ...and relocated by the caller, which is the half that was missing.
    expect({ x: ren.x, y: ren.y }).not.toEqual(fell);
    // AND SOMEWHERE SURVIVABLE. Nothing hostile is in reach of the tile they
    // landed on — a reset that stands you up next to the wraith is not a reset.
    for (const monster of monsters(stuck.world)) {
      expect(chebyshev(monster, ren)).toBeGreaterThan(1);
    }
  });

  it('RESETS THE HOSTILES rather than leaving the survivors of the fight standing', () => {
    // "A floor reset that leaves a wounded Wraith three tiles away is the same
    // bug with extra steps." The monster that did the killing is gone; the
    // authored encounter is back, whole, at its authored positions.
    const stuck = scene('reset-hostiles');
    const wraith = stuck.actor('m_wraith');
    wraith.hp = 1;

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(stuck.world.getActor('m_wraith')).toBeUndefined();
    const rebuilt = monsters(stuck.world);
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const monster of rebuilt) {
      expect(monster.hp).toBe(monster.maxHp);
    }
  });

  it('DROPS ENGAGEMENT TO ZERO, so the party lands out of combat', () => {
    // Landing straight back into a parked barrier is what made this read as
    // "downing doesn't fully down". At zero nobody blocks and the pump idles.
    const stuck = scene('reset-engagement');
    stuck.world.turn.engagement = 3;

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(stuck.world.turn.engagement).toBe(0);
  });

  it('MOVES THE PARTY BEFORE IT RE-SEEDS — the order is the fix', () => {
    // If the hostiles went back first, `addMonster` would find the party still
    // standing on the fight's tiles and shuffle every authored spawn one ring
    // outward. Moving first also means nothing hostile exists at the instant the
    // party is placed.
    const seen: { x: number; y: number }[] = [];
    const stuck = scene('reset-order', {
      reseed: (world) => {
        const ren = world.getActor('p1');
        if (ren !== undefined) seen.push({ x: ren.x, y: ren.y });
        seedTestEncounter(world);
      },
    });
    const fell = { x: stuck.actor('p1').x, y: stuck.actor('p1').y };

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toEqual(fell);
  });

  it('does not loop looking for a safe tile when there is none — it warns and moves on', () => {
    // The pathological case, and the rule is stated in resetFloor: a hang is
    // worse than an unfair position. Solid rock everywhere means `findSpawn`
    // has nothing to answer with.
    const stuck = scene('reset-nowhere');
    stuck.world.level.tiles.fill(TileCode.WALL);
    const fell = { x: stuck.actor('p1').x, y: stuck.actor('p1').y };

    stuck.knockDown('p1');
    stuck.engine.pump();

    const ren = stuck.actor('p1');
    // Left where they fell — a worse spot, and still on their feet.
    expect({ x: ren.x, y: ren.y }).toEqual(fell);
    expect(ren.alive).toBe(true);
    expect(stuck.log.warns.some((line) => line.includes('no free spawn tile'))).toBe(true);
  });

  it('leaves a floor with no wipe completely untouched', () => {
    // The reset is reached from ONE event. A pump that did not wipe must not
    // re-seed anything, or every quiet turn silently rebuilds the level.
    const reseed = vi.fn();
    const quiet = scene('reset-not-fired', { reseed });
    quiet.actor('p1').hp = 5;

    quiet.engine.pump();

    expect(reseed).not.toHaveBeenCalled();
    expect(quiet.world.getActor('m_wraith')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FIX C — the log told the truth about order
// ---------------------------------------------------------------------------

/**
 * A monster's blow is where a wipe comes from in practice, and it is the case
 * the transcript records. The player holds, the wraith swings, the last body
 * hits the floor and the party is wiped INSIDE the monster sweep.
 */
function killedByTheSweep(seed: string): {
  readonly playerEvents: readonly TurnEvent[];
  readonly sweep: readonly TurnEvent[];
  readonly ren: Actor;
} {
  const stuck = scene(seed);
  const ren = stuck.actor('p1');
  ren.hp = 1;
  // Engagement has to be armed before anybody is asked whether they are
  // blocking, and the player has to have committed or the world will not move.
  stuck.world.turn.engagement = 3;
  expect(stuck.engine.hold('p1').ok).toBe(true);

  const result = stuck.engine.pump();
  return { playerEvents: result.playerEvents, sweep: result.sweep, ren };
}

describe('the wipe is narrated in the order it happened', () => {
  it('files a wipe raised DURING the sweep in the sweep lane, not the player lane', () => {
    // The player lane is broadcast and narrated first. A wipe filed there is
    // announced before the blow that caused it — which is what the transcript
    // shows, and it cost an evening on the wrong bug.
    const { playerEvents, sweep } = killedByTheSweep('order-lane');

    const wiped = (event: TurnEvent): boolean =>
      event.k === 'erased' && event.reason === ErasedReason.Wipe;
    expect(sweep.some(wiped)).toBe(true);
    expect(playerEvents.some(wiped)).toBe(false);
  });

  it('puts the erasure AFTER the blow and the countdown that caused it', () => {
    const { sweep } = killedByTheSweep('order-sequence');

    const at = (predicate: (event: TurnEvent) => boolean): number => sweep.findIndex(predicate);
    const damage = at((event) => event.k === 'damage');
    const death = at((event) => event.k === 'death');
    const downed = at((event) => event.k === 'downed');
    const erased = at((event) => event.k === 'erased');

    expect(damage).toBeGreaterThanOrEqual(0);
    expect(death).toBeGreaterThan(damage);
    expect(downed).toBeGreaterThan(death);
    expect(erased).toBeGreaterThan(downed);
  });

  it('reports the hp the BLOW left, not the hp the reset handed back', () => {
    // "3 damage. Ren 60/60." one line above "Ren is unfiled." The number was
    // read off the body after the pump, by which time the floor had reset it.
    const { sweep, ren } = killedByTheSweep('order-hp');

    const hit = sweep.find((event) => event.k === 'damage');
    expect(hit?.k === 'damage' ? hit.hp : -1).toBe(0);
    // And the body really is back at full — both numbers are true, at different
    // instants, which is exactly why one of them had to be snapshotted.
    expect(ren.hp).toBe(ren.maxHp);
  });

  it('flashes the blow on the tile it landed on, not where the reset put the body', () => {
    // The same class of lie one field over, and one this fix would otherwise
    // have INTRODUCED: the reset walks the party to the spawn cluster before a
    // single event has been translated, so a position read afterwards paints the
    // killing blow thirty tiles from where it happened.
    const stuck = scene('order-tile');
    const ren = stuck.actor('p1');
    const struckAt = { x: ren.x, y: ren.y };
    ren.hp = 1;
    stuck.world.turn.engagement = 3;
    expect(stuck.engine.hold('p1').ok).toBe(true);

    const result = stuck.engine.pump();
    const blow = result.sweep.find((event) => event.k === 'attack');

    expect(blow?.k === 'attack' ? { x: blow.x, y: blow.y } : undefined).toEqual(struckAt);
    expect({ x: ren.x, y: ren.y }).not.toEqual(struckAt);
  });
});

// ---------------------------------------------------------------------------
// FIX B — one stalled party must not freeze another
// ---------------------------------------------------------------------------

describe('a party that owes no decision is skipped, not waited on', () => {
  it('RESOLVES THE OTHER PARTY’S TURN while one party is down — the report', () => {
    // "if i am down, he is unable to take a turn, do anything". Parties scope the
    // barrier, but the pump is LEVEL-WIDE — one clock, one tick loop, one call —
    // so a party stuck on the floor shares every pump with everybody else. The
    // property that has to hold is simply this: the other party still plays.
    const world = createWorld('stalled-does-not-starve');
    const downed = createDownedState();
    const barrier = createBarrier();
    const parties = createPartyState();

    for (const id of ['p1', 'p2']) {
      const actor = world.addPlayer(id, id);
      actor.hpRegen = 0;
    }
    // Two parties of one, minted lazily — neither ever agreed to share a barrier.
    world.turn.engagement = 3;

    const fallen = world.getActor('p1');
    const playing = world.getActor('p2');
    if (fallen === undefined || playing === undefined) throw new Error('fixture');
    fallen.hp = 0;
    fallen.alive = false;
    goDown(downed, fallen, 0);

    // Park everybody first, so p2's move is submitted against a live barrier.
    pump(world, { nowMs: 0, barrier, downed, parties });
    const from = { x: playing.x, y: playing.y };
    expect(submitIntent(world, barrier, 'p2', { kind: IntentKind.Move, dir: 's' })).toBe(true);
    const result = pump(world, { nowMs: 1, barrier, downed, parties });

    expect({ x: playing.x, y: playing.y }).toEqual({ x: from.x, y: from.y + 1 });
    // AND THE CALL CAME BACK. A pump that burned its whole tick budget is the
    // shape of one party churning the loop for everybody else.
    expect(result.status).not.toBe('budget');
  });

  it('contributes no Bell deadline for a party nobody is driving', () => {
    // The stated invariant (`canDecide`): every member Downed, Erased,
    // disconnected or Standing By means nobody to ring, nobody to force a pass,
    // and no deadline for the caller's single timer to be armed against. It is
    // `inQuorum`'s answer today; pinning it is what makes the day somebody
    // widens `inQuorum` a decision rather than a discovery.
    const world = createWorld('stalled-no-bell');
    const downed = createDownedState();
    const barrier = createBarrier();
    const parties = createPartyState();

    for (const id of ['p1', 'p2']) {
      const actor = world.addPlayer(id, id);
      actor.hpRegen = 0;
    }
    world.turn.engagement = 3;

    const ghost = world.getActor('p1');
    if (ghost === undefined) throw new Error('fixture');
    barrier.disconnect(ghost, 0);

    const result = pump(world, { nowMs: 0, barrier, downed, parties });

    expect(result.bell.stragglers).toEqual(['p2']);
    expect(result.parked).not.toContain('p1');
  });

  it('hands a party coming back off the floor a FRESH countdown', () => {
    // The trap in skipping: `bell` is what RETIRES a running countdown, so a
    // skip that also skipped the call would leave the old start time behind and
    // ring at somebody the instant they got up. `applyBellExpiry` still asks.
    const world = createWorld('stalled-fresh-bell');
    const downed = createDownedState();
    const barrier = createBarrier();
    const solo = world.addPlayer('p1', 'Solo');
    solo.hpRegen = 0;
    world.turn.engagement = 3;

    // A countdown is running on the solo player at t = 0.
    const armed = pump(world, { nowMs: 0, barrier, downed });
    expect(armed.bell.running).toBe(true);
    const firstDeadline = armed.bell.deadlineMs;

    // They go down; the party is wiped and restored, all inside one pump.
    solo.hp = 0;
    solo.alive = false;
    goDown(downed, solo, world.turn.clock.gameTurn);
    pump(world, { nowMs: 1_000, barrier, downed });

    // Back on their feet and blocking again — with a deadline measured from NOW,
    // not from before they fell.
    const back = pump(world, { nowMs: 5_000, barrier, downed });
    expect(back.bell.running).toBe(true);
    expect(back.bell.deadlineMs).not.toBe(firstDeadline);
    expect(back.bell.deadlineMs ?? 0).toBeGreaterThan(5_000);
  });

  it('names the party on a wipe, so churn is attributable', () => {
    const world = createWorld('wipe-party-id');
    const downed = createDownedState();
    const parties = createPartyState();
    for (const id of ['p1', 'p2']) world.addPlayer(id, id);
    expect(invite(parties, 'p1', 'p2', 0).ok).toBe(true);
    expect(accept(parties, 'p2', 'p1', 0).ok).toBe(true);

    for (const id of ['p1', 'p2']) {
      const body = world.getActor(id);
      if (body === undefined) throw new Error('fixture');
      body.hp = 0;
      body.alive = false;
      goDown(downed, body, 0);
    }

    const result = pump(world, { nowMs: 0, barrier: createBarrier(), downed, parties });
    const wipe = result.events.find((event) => event.t === 'party_wipe');
    if (wipe === undefined || wipe.t !== 'party_wipe') throw new Error('expected a party wipe');

    // The id the churn alarm keys on. It is process-local bookkeeping and never
    // reaches a client — see engine/party.ts.
    expect(wipe.partyId).not.toBe('');
    expect([...wipe.restored].sort()).toEqual(['p1', 'p2']);
    // Raised by `enrolCasualties` on the way in, which is the player lane.
    expect(wipe.duringSweep).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX D — the FOURTH table a reset has to know about
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ITEMS ARE WIPED WITH THE FLOOR, AND THE DROPS ARE RE-ROLLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resetFloor` now clears four tables: bodies, side tables, orbs and ground
 * items. The first three were each added only after a party found the hole in a
 * voice channel — a re-seeded monster still Marked, an orb that outlived the
 * wipe and landed on a party standing at full health in the spawn cluster. This
 * one is written down before it can be, because the failure is not a crash: it
 * is that WIPING BECOMES PROFITABLE. A reset costs the party nothing but time
 * (game-design.md § 9: no permadeath, no loss), so loot left on the floor from
 * the fight they just lost is a farm with a re-seeded encounter attached to it.
 *
 * ═══ A RE-SEEDED MONSTER CARRIES A NEW ROLL, NOT THE OLD ONE ═══
 * Stated here because it is the natural thing to assume and it is not true. The
 * reset REAPS every monster and `seedTestEncounter` mints brand new bodies at the
 * authored positions with the stable ids (`mon_<template.id>`,
 * content/encounter.ts) — and each of those bodies takes its own two draws off a
 * loot stream that has moved on. The wraith is `chance: 100`, so it always comes
 * back carrying something; WHICH of the six rare items it carries is a fresh
 * question every time.
 *
 * That is deliberate rather than incidental. Remembering a per-id result would
 * make the loot on the floor a function of how many times the party has wiped —
 * which is the one thing a floor reset exists to erase — and it would need a
 * decided-drops table living somewhere across resets, which is a fourth source
 * of truth about a floor that is supposed to be rebuilt from a seed.
 */
describe('a floor reset clears the floor of items too', () => {
  it('CLEARS EVERY GROUND ITEM — loot from the fight you lost is not a consolation prize', () => {
    const stuck = scene('reset-clears-ground');
    stuck.world.addGroundItem({ x: 22, y: 20 }, 'item_watchmans_coat');
    stuck.world.addGroundItem({ x: 5, y: 5 }, 'item_inspectors_signet');
    expect(stuck.world.groundItems()).toHaveLength(2);

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(stuck.world.groundItems()).toEqual([]);
  });

  it('leaves NO ground item surviving into the re-seeded floor', () => {
    // The stronger form of the assertion above: the floor is not merely emptied
    // at some point during the reset, it is empty AFTER `reseedFloor` has run.
    // Clearing before the re-seed and clearing after it are different programs,
    // and only one of them survives a re-seed that ever drops something itself.
    const stuck = scene('reset-ground-after-reseed');
    stuck.world.addGroundItem({ x: 22, y: 20 }, 'item_leather_chest');

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(monsters(stuck.world).length).toBeGreaterThan(0);
    expect(stuck.world.groundItems()).toEqual([]);
  });

  it('re-seeds a monster that is carrying a drop again — same id, fresh roll', () => {
    // The encounter is seeded FIRST, so the reset happens with living monsters
    // that already carry pre-rolled drops. The wraith is the one to assert on:
    // `chance: 100` means it always carries exactly one rare item, so "did the
    // re-seeded body get a drop" has a definite answer on every seed.
    const stuck = scene('reset-rerolls-drops');
    seedTestEncounter(stuck.world);

    const rareIds = ITEMS.filter((item) => item.tier === 'rare').map((item) => item.id);
    /**
     * THE BASE, out of an id that may carry egos.
     *
     * The drop table names a base and the ego roll decorates it, so what this
     * test is actually asserting — "the wraith drew from the rare table" — is a
     * claim about the part before the `~`. Asserting on the whole id would make
     * this test fail every time an ego lands, which is not the wraith's table
     * changing.
     */
    const baseOf = (id: string | undefined): string | undefined => id?.split('~')[0];

    const before = stuck.world.getActor('mon_index_wraith');
    expect(before?.carried).toHaveLength(1);
    expect(rareIds).toContain(baseOf(before?.carried?.[0]));

    stuck.knockDown('p1');
    stuck.engine.pump();

    // Same id, because content/encounter.ts:99 mints stable ids...
    const after = stuck.world.getActor('mon_index_wraith');
    expect(after).toBeDefined();
    // ...but a DIFFERENT BODY, which is exactly why the drop is a new roll.
    expect(after).not.toBe(before);
    expect(after?.carried).toHaveLength(1);
    expect(rareIds).toContain(baseOf(after?.carried?.[0]));
  });

  it('re-rolls reproducibly — two identical sessions reset to the identical floor', () => {
    // The reset consumes loot draws (three chance rolls, one to three picks), so
    // the stream position after a wipe is a function of how many wipes there have
    // been. That is fine and it is deterministic, which is the property worth
    // pinning: same seed plus same script equals same floor, wipes included.
    const run = (): readonly (string | undefined)[] => {
      const stuck = scene('reset-reroll-determinism');
      seedTestEncounter(stuck.world);
      stuck.knockDown('p1');
      stuck.engine.pump();
      return monsters(stuck.world)
        .map((monster) => monster.carried?.[0])
        .sort();
    };
    expect(run()).toEqual(run());
  });
});

describe('a floor reset that is not working says so', () => {
  it('logs an error when the same party wipes again within two game turns', () => {
    // The scheduler refuses to reset the same party twice inside ONE pump, which
    // bounds a loop within a call. A reset that does not separate the party from
    // what killed them produces one tidy wipe per call, forever — and that is
    // invisible from in there. This is the alarm for it.
    const stuck = scene('churn-alarm');

    stuck.knockDown('p1');
    stuck.engine.pump();
    expect(stuck.log.errors).toEqual([]);

    stuck.knockDown('p1');
    stuck.engine.pump();

    expect(stuck.log.errors.some((line) => line.includes('wiped again'))).toBe(true);
  });

  it('stays quiet for a party that wipes once and gets on with the floor', () => {
    const stuck = scene('churn-quiet');
    stuck.knockDown('p1');
    stuck.engine.pump();
    expect(stuck.log.errors).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A RESET MOVED THEM, SO IT HAS TO SAY IT MOVED THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PumpResult.displaced` is defined as "who was moved without asking to be", and
 * `net/` uses it for one thing: if a body it names is standing on a spawn tile,
 * that session's `exitArmed` is cleared, under the note "SOMEBODY ELSE PUT THEM
 * ON THE DOORSTEP. THAT IS NOT A DECISION TO LEAVE."
 *
 * A floor reset is exactly that and never populated the field — it was filled
 * only by `swapped`. The consequence, measured live over nine two-player runs
 * and reproduced 9/9: the party wipes, `placeAtSpawn` puts every restored body
 * on the delve's spawn cluster — which is the same tile set `leaveRealm` reads
 * as the way out — and the tail of `handleMove` then walks whoever's command
 * resolved the wipe straight out of the delve. One player ends on the moor and
 * the rest are left inside, with nobody having pressed anything.
 *
 * The control that proves the chain: replay the same wipe with `hold` as the
 * closing command instead of `move` and 0 of 2 are ejected, because the tail of
 * `handleMove` is what runs `leaveRealm`.
 */
describe('a floor reset reports the bodies it moved', () => {
  it('names every restored body in `displaced`', () => {
    const stuck = scene('reset-moves');
    const before = { x: stuck.actor('p1').x, y: stuck.actor('p1').y };

    stuck.knockDown('p1');
    const result = stuck.engine.pump();

    // The body really was moved — this scene is the one the tests above use to
    // prove the reset relocates the party, so if this fails the fixture changed
    // and the assertion below would pass for the wrong reason.
    const after = { x: stuck.actor('p1').x, y: stuck.actor('p1').y };
    expect(after, 'the reset did not move anybody').not.toEqual(before);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // `displaced` came back empty, so net/'s doorstep guard never fired and the
    // tail of `handleMove` walked the mover out of the delve.
    expect(result.displaced ?? [], 'a moved body went unreported').toContain('p1');
  });

  it('does not report a body it did not move', () => {
    // The other half: `displaced` must not become "everyone, always", or the
    // guard stops meaning anything and a real decision to leave gets swallowed.
    // The monsters were reset onto their authored tiles too and are not players
    // — nothing in net/ has a session for them, and naming them would be noise.
    const stuck = scene('reset-moves');
    stuck.knockDown('p1');
    const result = stuck.engine.pump();
    for (const id of result.displaced ?? []) {
      expect(id, `${id} is not a player`).toMatch(/^p\d+$/);
    }
  });
});
