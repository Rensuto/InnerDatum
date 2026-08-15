import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import {
  DOWNED_TURNS,
  REVIVE_HP_FRACTION,
  Survival,
  createDownedState,
  downedView,
  goDown,
  isDowned,
  isErased,
  revive,
  survivalOf,
  tickDowned,
} from '../../src/server/engine/downed.ts';
import { pump } from '../../src/server/engine/scheduler.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { parseClientMsg } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Barrier } from '../../src/server/engine/barrier.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { PumpResult } from '../../src/server/engine/scheduler.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESPAWN — A WAY BACK. THE ERASED PLAYER PICKS THEMSELVES UP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED FROM REAL CO-OP PLAY: *"when the player dies, we need a respawn
 * method as I was stuck since the other player's character is there."*
 *
 * Erased was TERMINAL in a game that has no permadeath, which is a contradiction
 * somebody sat inside for an evening. `revive` refuses an erased body by design
 * (`ReviveRefusal.Erased`), so the only exit was a party wipe — and a
 * disconnected friend's body was keeping the wipe from ever firing. Even with
 * that predicate fixed (test/server/ghost-survivor.test.ts), a party of two where
 * one person is fine and the other is Erased has NO RESET COMING: the survivor
 * is up, so the party is not wiped, and the erased body waits for a rescue that
 * cannot happen. That is the hole this verb fills, and `no floor reset is coming`
 * below is the test that describes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE PROPERTIES, AND WHY EACH ONE IS LOAD-BEARING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   FULL HP, OUT OF ERASED, AND THEN THEY CAN ACTUALLY PLAY. It is the wipe's
 *   own restoration (`standUp` in engine/downed.ts), so nothing is lost and
 *   nothing is deleted. M4 ships no permadeath and this adds none.
 *
 *   REFUSED OUT OF UP AND OUT OF DOWNED. Downed has a five-turn countdown and an
 *   ally running at it; a player who could stand themselves up out of it would
 *   never be worth running to, and the mechanic game-design.md § 9 calls the one
 *   that does most for co-op tension would quietly stop existing.
 *
 *   IT CAN NEVER TARGET ANYBODY ELSE. There is no target on the wire and no
 *   parameter to put one in. The actor is the one the socket owns, resolved
 *   server-side like every other verb.
 */

const NOW = 1_000_000;

type Scene = {
  readonly world: World;
  readonly downed: DownedState;
  readonly barrier: Barrier;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
  /** Down, then the whole countdown spent: the state a player gets stranded in. */
  readonly erase: (id: string) => Actor;
  readonly advance: (nowMs: number) => PumpResult;
};

function scene(seed: string, players = 1): Scene {
  const world = createWorld(seed);
  const downed = createDownedState();
  const barrier = createBarrier();

  for (let i = 0; i < players; i += 1) {
    const actor = world.addPlayer(`p${String(i + 1)}`, `Player ${String(i + 1)}`);
    actor.hpRegen = 0;
  }

  const actor = (id: string): Actor => {
    const found = world.getActor(id);
    if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
    return found;
  };

  return {
    world,
    downed,
    barrier,
    // The same barrier instance the pump gets, so "did the respawn clear
    // Standing By" is asked of the object that actually arbitrates turns.
    engine: createTurnEngine({ world, downed, barrier, now: () => NOW }),
    actor,
    erase: (id) => {
      const body = actor(id);
      body.hp = 0;
      body.alive = false;
      goDown(downed, body, world.turn.clock.gameTurn);
      for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(downed, body);
      expect(isErased(downed, id)).toBe(true);
      return body;
    },
    advance: (nowMs) => pump(world, { nowMs, barrier, downed }),
  };
}

// ---------------------------------------------------------------------------
// The way back
// ---------------------------------------------------------------------------

describe('an Erased player may pick themselves up', () => {
  it('stands up at FULL hp and can take a turn again — the report, closed', () => {
    const stuck = scene('respawn-full-hp');
    stuck.world.turn.engagement = 3;
    const dalt = stuck.erase('p1');
    dalt.energy = 900;
    dalt.energyBase = 700;

    expect(stuck.engine.submitRespawn?.('p1').ok).toBe(true);

    // FULL, and that is the difference from a rescue: `revive` restores 25%
    // (game-design.md § 9) because an ally paid a turn for it. A respawn is the
    // WIPE's restoration — the floor reset arriving for one body — so it is
    // total, and `standUp` in engine/downed.ts is literally the same function.
    expect(dalt.hp).toBe(dalt.maxHp);
    expect(dalt.hp).toBeGreaterThan(Math.ceil(dalt.maxHp * REVIVE_HP_FRACTION));
    expect(dalt.alive).toBe(true);
    expect(survivalOf(stuck.downed, 'p1')).toBe(Survival.Up);
    expect(downedView(stuck.downed, 'p1')).toBeUndefined();

    // Both clocks re-zeroed, so they land phase-locked with the party instead of
    // taking a turn inside the very tick that restored them (D1).
    expect(dalt.energy).toBe(0);
    expect(dalt.energyBase).toBe(0);
    // AND IT IS NOT AN INTENT. An erased body is dropped by `tickLevel`'s
    // `isActive` gate, so a queued intent would never resolve; the restoration is
    // applied between pumps and the next pump simply finds a body that is up.
    expect(dalt.pendingIntent).toBeNull();

    // ═══ THE PART THE PLAYER CARES ABOUT: THEY ARE PLAYING AGAIN ═══
    const from = { x: dalt.x, y: dalt.y };
    expect(stuck.engine.submitMove('p1', 's').ok).toBe(true);
    stuck.advance(1);
    expect({ x: dalt.x, y: dalt.y }).toEqual({ x: from.x, y: from.y + 1 });
  });

  it('is the exit when NO FLOOR RESET IS COMING — a friend is up, so nobody is wiped', () => {
    // The scenario the verb exists for, and the one the ghost fix does not
    // reach: two players, one Erased and one perfectly fine. The party is not
    // wiped — correctly, there is somebody standing — so the floor will never
    // reset, and `revive` refuses an erased body outright. Without this verb the
    // erased player waits forever while their friend plays on.
    const stuck = scene('respawn-no-wipe', 2);
    const dalt = stuck.erase('p1');
    const sam = stuck.actor('p2');

    const result = stuck.advance(0);
    expect(result.events.some((event) => event.t === 'party_wipe')).toBe(false);
    expect(isErased(stuck.downed, 'p1')).toBe(true);
    expect(sam.alive).toBe(true);

    expect(stuck.engine.submitRespawn?.('p1').ok).toBe(true);
    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(dalt.maxHp);
    // And the friend who was standing there the whole time was not touched.
    expect(sam.hp).toBe(sam.maxHp);
    expect(survivalOf(stuck.downed, 'p2')).toBe(Survival.Up);
  });

  it('puts them somewhere a living body is not already standing', () => {
    // An erased body does not block (`actorAt` skips anything not alive), so
    // something may well have parked on top of it while it lay there. Standing
    // up in place would put two living bodies on one tile.
    const stuck = scene('respawn-placement', 2);
    const dalt = stuck.erase('p1');
    const sam = stuck.actor('p2');
    sam.x = dalt.x;
    sam.y = dalt.y;

    expect(stuck.engine.submitRespawn?.('p1').ok).toBe(true);
    expect({ x: dalt.x, y: dalt.y }).not.toEqual({ x: sam.x, y: sam.y });
    expect(stuck.world.actorAt(dalt.x, dalt.y)?.id).toBe('p1');
  });

  it('clears Standing By, so nobody is left waiting on a body that just came back', () => {
    // By the time somebody is Erased the Bell has usually auto-passed them out
    // of the quorum. Coming back has to put them into it, or the person who just
    // pressed a key to get unstuck is still not in the game.
    const stuck = scene('respawn-standing-by');
    const dalt = stuck.erase('p1');
    stuck.barrier.disconnect(dalt, NOW);
    dalt.connected = true;
    expect(dalt.standingBy).toBe(true);

    expect(stuck.engine.submitRespawn?.('p1').ok).toBe(true);
    expect(dalt.standingBy).toBe(false);
    expect(stuck.barrier.autoPassesOf('p1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The two refusals, and neither of them costs anything
// ---------------------------------------------------------------------------

describe('it is refused while Up or Downed', () => {
  it('REFUSES a player who is merely Downed — the countdown is the mechanic', () => {
    // game-design.md § 9: the five turns are what turn *"I died"* into *"GET TO
    // ME"*. A player who could file themselves back in would never be worth
    // running to, and this refusal is the whole of what protects that.
    const stuck = scene('respawn-refuse-downed', 2);
    const dalt = stuck.actor('p1');
    const sam = stuck.actor('p2');
    const where = { x: dalt.x, y: dalt.y };
    dalt.hp = 0;
    dalt.alive = false;
    goDown(stuck.downed, dalt, stuck.world.turn.clock.gameTurn);

    const result = stuck.engine.submitRespawn?.('p1');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toBe(
      'you are down, not erased — an ally can still reach you',
    );

    // THE REFUSAL COST ZERO: not half-restored, not healed, not teleported out
    // from under the ally who is running at them.
    expect(dalt.alive).toBe(false);
    expect(dalt.hp).toBe(0);
    expect(isDowned(stuck.downed, 'p1')).toBe(true);
    expect(downedView(stuck.downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS);
    expect({ x: dalt.x, y: dalt.y }).toEqual(where);

    // ...and the sentence is true. The ally really can still finish the job, at
    // the 25% a rescue gives rather than the full bar a respawn would have.
    sam.x = dalt.x + 1;
    sam.y = dalt.y;
    const rescued = revive(stuck.downed, dalt, sam);
    expect(rescued.ok).toBe(true);
    expect(dalt.hp).toBe(Math.ceil(dalt.maxHp * REVIVE_HP_FRACTION));
    expect(dalt.hp).toBeLessThan(dalt.maxHp);
  });

  it('refuses a player who is on their feet, and is emphatically not a free heal', () => {
    // The commonest way to press this key is by accident — a wipe or an ally's
    // rescue beat the keypress by half a second.
    const stuck = scene('respawn-refuse-up');
    const dalt = stuck.actor('p1');
    dalt.hp = 3;
    dalt.energy = 640;

    const result = stuck.engine.submitRespawn?.('p1');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toBe('you are already on your feet');
    expect(dalt.hp).toBe(3);
    expect(dalt.energy).toBe(640);
    expect(dalt.alive).toBe(true);
  });

  it('refuses a body that is not a player, and does not resurrect it', () => {
    // Monsters die; players are Unfiled. `goDown` refuses a monster outright, so
    // a husk can never be Erased — and the verb still has to answer for one.
    const stuck = scene('respawn-refuse-monster');
    const husk = stuck.world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    husk.hp = 0;
    husk.alive = false;

    expect(stuck.engine.submitRespawn?.('m1').ok).toBe(false);
    expect(husk.alive).toBe(false);
    expect(husk.hp).toBe(0);
  });

  it('refuses an id that is not in the world, rather than inventing a body', () => {
    const stuck = scene('respawn-refuse-unknown');
    const result = stuck.engine.submitRespawn?.('actor_does_not_exist');
    expect(result?.ok).toBe(false);
    expect(stuck.world.getActor('actor_does_not_exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Self-service, and there is nowhere to put a target
// ---------------------------------------------------------------------------

describe('it can never target another player', () => {
  const frame = (extra: Record<string, unknown>): boolean =>
    parseClientMsg({ v: PROTOCOL_VERSION, t: 'respawn', ...extra }).ok;

  it('carries NO FIELDS AT ALL on the wire — the emptiness is the security property', () => {
    expect(frame({})).toBe(true);
    // `strictObject`, so a frame naming somebody else is REJECTED rather than
    // quietly stripped: the difference matters, because stripping would make a
    // hostile frame indistinguishable from an honest one in the log.
    expect(frame({ targetId: 'p2' })).toBe(false);
    expect(frame({ actorId: 'p2' })).toBe(false);
    expect(frame({ id: 'p2' })).toBe(false);
    // ...and no geometry either. A respawn does not get to choose a tile.
    expect(frame({ dir: 'n' })).toBe(false);
    expect(frame({ x: 3, y: 2 })).toBe(false);
  });

  it('takes the sender and nothing else — there is no parameter to put a target in', () => {
    // The wire is one half; this is the other. Identity is resolved from the
    // socket in net/gateway.ts and handed in as the only argument, exactly as
    // `commit` and `hold` are.
    const stuck = scene('respawn-arity');
    expect(stuck.engine.submitRespawn?.length).toBe(1);
  });

  it('restores ONLY the sender — an erased ally is left exactly as they were', () => {
    const stuck = scene('respawn-only-sender', 2);
    const dalt = stuck.erase('p1');
    const sam = stuck.erase('p2');
    const samWhere = { x: sam.x, y: sam.y };

    expect(stuck.engine.submitRespawn?.('p1').ok).toBe(true);

    expect(dalt.alive).toBe(true);
    expect(dalt.hp).toBe(dalt.maxHp);
    // Sam pressed nothing, so Sam is still on the floor: same tile, same stage,
    // same 0 hp. A verb that swept the level would be a floor reset wearing a
    // keybind, and the wipe is the only thing allowed to do that.
    expect(sam.alive).toBe(false);
    expect(sam.hp).toBe(0);
    expect(survivalOf(stuck.downed, 'p2')).toBe(Survival.Erased);
    expect({ x: sam.x, y: sam.y }).toEqual(samWhere);

    // And Sam's own way back is the same one, pressed by Sam.
    expect(stuck.engine.submitRespawn?.('p2').ok).toBe(true);
    expect(sam.alive).toBe(true);
    expect(sam.hp).toBe(sam.maxHp);
  });

  it('cannot be used to stand a DOWNED ally up on their behalf either', () => {
    // The refusal is a fact about the SENDER'S stage, so there is no arrangement
    // of two bodies that turns it into a rescue somebody else performed.
    const stuck = scene('respawn-not-a-rescue', 2);
    const dalt = stuck.actor('p1');
    dalt.hp = 0;
    dalt.alive = false;
    goDown(stuck.downed, dalt, stuck.world.turn.clock.gameTurn);

    // Sam is up and standing on top of them, which is the one arrangement in
    // which a target-less verb could plausibly be argued to mean "this body".
    const sam = stuck.actor('p2');
    sam.x = dalt.x;
    sam.y = dalt.y;

    const result = stuck.engine.submitRespawn?.('p2');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toBe('you are already on your feet');
    expect(isDowned(stuck.downed, 'p1')).toBe(true);
    expect(dalt.hp).toBe(0);
  });
});
