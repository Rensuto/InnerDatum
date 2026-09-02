// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/GameEnergyBased.lua:89-130 (the tick loop)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { MAX_PARTY_SIZE, accept, createPartyState, invite } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A GAME TURN IS ONE PLAYER ACTION. THAT IS THE WHOLE PORT, IN ONE SENTENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every number ToME spent fifteen years tuning is denominated in TURNS — regen
 * per turn, cooldowns in turns, status durations in turns, the rest bonus per
 * turn. Upstream can leave the exchange rate unwritten because it is single
 * player: `tickLevel` grants energy only while THE player is short of it, so ten
 * ticks of the clock are exactly one action, always.
 *
 * We put six people on one level, and the exchange rate stops being free. This
 * file measures it, because nothing else did — and the answer turns out to be
 * two different numbers depending on whether anybody is in a fight.
 */

/**
 * `players` detectives on one floor, in one party, with or without something
 * hostile in the room.
 *
 * THE HOSTILE IS WHAT SETS `engagement`, and engagement is what turns the
 * barrier on — so it is the whole difference between the two halves of this
 * file. It stands at (6,4) rather than across the map because engagement is
 * raised by SEEING one (`updateEngagement`), and a husk thirty tiles away in the
 * dark leaves the level free-running with a monster on it, which is exactly the
 * fixture that would make the second half of this file pass for the wrong
 * reason.
 */
function floor(name: string, players: number, hostile: boolean, party = true) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const parties = createPartyState();
  const engine = createTurnEngine({ world, downed: createDownedState(), parties });

  const bodies = [];
  for (let i = 0; i < players; i += 1) {
    const body = world.addPlayer(`p${String(i)}`, `p${String(i)}`, { maxHp: 5000 });
    body.x = 2;
    body.y = 2 + i;
    engine.join(body.id);
    engine.setConnected(body.id, true);
    bodies.push(body);
  }
  /**
   * ONE PARTY, and asserted rather than assumed.
   *
   * Two `join`ed players are two parties of one — the trap `rest.test.ts` was
   * caught by. And both verbs take a `nowMs` and answer a result: the first
   * draft of this file dropped the argument, never read the answer, and would
   * have measured six parties of one while claiming to measure a party of six.
   *
   * IT ALSO FOUND THAT A PARTY OF SIX IS NOT A THING. `MAX_PARTY_SIZE` is FOUR,
   * so the sizes below stop there — and the six-body case is a separate test
   * about strangers, which is a different claim and a better one.
   */
  if (party) {
    if (players > MAX_PARTY_SIZE) throw new Error('a party that size cannot exist');
    for (let i = 1; i < players; i += 1) {
      const asked = invite(parties, 'p0', `p${String(i)}`, 0);
      const joined = accept(parties, `p${String(i)}`, 'p0', 0);
      if (!asked.ok || !joined.ok) throw new Error('the party never formed');
    }
  }

  if (hostile) {
    world.addMonster('foe', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 6,
      y: 4,
      profile: AiProfile.MeleeChaser,
      // UNKILLABLE ON PURPOSE. The measurement runs for sixty player actions and
      // a dead husk drops engagement back to zero part-way through, which would
      // silently turn this into the other test.
      maxHp: 999_999,
    });
  }

  engine.pump();
  return { world, engine, bodies };
}

/** Everybody takes `each` turns, round-robin. Returns the game turns that cost. */
function roundRobin(
  scene: ReturnType<typeof floor>,
  each: number,
): { readonly turns: number; readonly actions: number } {
  const start = scene.world.turn.clock.gameTurn;
  for (let a = 0; a < each; a += 1) {
    for (const body of scene.bodies) {
      scene.engine.hold(body.id);
      scene.engine.commit(body.id);
      scene.engine.pump();
    }
  }
  return {
    turns: scene.world.turn.clock.gameTurn - start,
    actions: each * scene.bodies.length,
  };
}

const ACTIONS = 10;

describe('in a fight, a turn costs each detective exactly one action', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE INVARIANT EVERY TUNED NUMBER RESTS ON, AND NOTHING GUARDED IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `engagement > 0` turns the barrier on, and the barrier is what phase-locks a
   * party: the level does not advance until everybody has spent their turn. So
   * six detectives taking ten actions each cost TEN game turns between them, not
   * sixty, and every per-turn number means to a party of six exactly what it
   * means to somebody playing alone.
   *
   * Losing this would be silent and enormous. Cooldowns, bleeds, regen and the
   * downed countdown would all run at party size — a five-turn rescue window
   * would be five of somebody else's turns and less than one of yours.
   */
  for (const size of [1, 2, MAX_PARTY_SIZE]) {
    it(`holds for a party of ${String(size)}`, () => {
      const { turns, actions } = roundRobin(floor(`fight-${String(size)}`, size, true), ACTIONS);
      expect(actions).toBe(ACTIONS * size);
      expect(
        turns,
        `a party of ${String(size)} bought ${String(turns)} turns with ${String(actions)} actions`,
      ).toBe(ACTIONS);
    });
  }
});

describe('out of a fight, it does not — and this is a measured divergence', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CHARACTERISATION TEST. THE NUMBER BELOW IS NOT THE NUMBER WE WANT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * With `engagement` at zero nobody is phase-locked — deliberately, and it is
   * the rule the whole realms design was arranged around: six unrelated people
   * crossing the moor must not wait on each other, which is why roamers are
   * markers and why `assertNoCombatInSharedSpace` exists.
   *
   * The cost is here. `tickLevel` grants energy whenever ANY active actor is
   * short of it, so with six people walking, a tick happens six times as often
   * as any one of them acts — and `grantBaseEnergy` is inside that grant. So
   * everybody's regen, cooldowns and status durations run at PARTY SIZE per
   * action they themselves took, and somebody standing still at the keyboard
   * heals off other people's footsteps.
   *
   * ═══ WHY IT IS MEASURED HERE INSTEAD OF FIXED ═══
   * The fix is one line — accrue base energy only while an actor is short of act
   * energy, so each body's clock is its own — and it was written, run, and
   * backed out. It is bit-identical to upstream for one player and it breaks two
   * things that matter more than the generosity it removes:
   *
   *   A BODY THAT IS NOT ACTING STOPS BLEEDING. `downed.test.ts`'s "enrols a
   *   body that bled out on the SAME turn" goes red: an idle body banks its
   *   turn, its base clock stops, and `timedEffects` never runs. "Stop pressing
   *   keys to stop bleeding" is a worse hole than the one being closed.
   *
   *   A RESTING PARTY STOPS RESTING. `rest.test.ts` goes red in three places,
   *   and the rest docblock says why in its own words: *"a rest pumps real
   *   turns, so `actBase` gave them their ordinary trickle"*. The teammates who
   *   did not press the key heal at the acceleration only, reaching 27.55 of 40.
   *
   * Both point the same way: the real answer is a world clock every realm owns,
   * so an idle body's time passes without anybody's footsteps paying for it —
   * the tide, which today only shared realms get. That is a bigger piece of work
   * than the one-line gate, and doing the gate without it trades a generosity
   * for an exploit.
   *
   * So this pins the number. When the world clock lands, this test goes red on
   * purpose and the expectation below becomes `ACTIONS`, matching the fight.
   */
  for (const size of [1, 2, 6]) {
    it(`costs a free-running group of ${String(size)} one turn per PERSON per action`, () => {
      const { turns } = roundRobin(floor(`quiet-${String(size)}`, size, false, false), ACTIONS);
      expect(turns).toBe(ACTIONS * size);
    });
  }

  it('and STRANGERS in one engaged room are phase-locked too, not just a party', () => {
    /**
     * THE CASE THAT MATTERS FOR A BUSY FLOOR, and the one a party-shaped fixture
     * cannot reach: `MAX_PARTY_SIZE` is four, so six people in one room are at
     * least two parties.
     *
     * They still cost ten turns between them, because `isBlocking`'s engagement
     * clause is LEVEL-WIDE — every player in a room with something hostile in it
     * owes a decision, whoever they came with. That is what keeps the tuning
     * honest on a floor holding more people than a party can.
     */
    const { turns } = roundRobin(floor('strangers', 6, true, false), ACTIONS);
    expect(turns).toBe(ACTIONS);
  });

  it('and a party of one is the same either way, which is why upstream never had to say', () => {
    // The control. ToME is single-player: the two halves of this file are one
    // number for it, and the divergence above is a thing only a second player
    // can create.
    const fighting = roundRobin(floor('solo-fight', 1, true), ACTIONS).turns;
    const quiet = roundRobin(floor('solo-quiet', 1, false), ACTIONS).turns;
    expect(fighting).toBe(quiet);
    expect(quiet).toBe(ACTIONS);
  });
});
