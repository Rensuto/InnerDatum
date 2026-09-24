import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { BELL_MS } from '../../src/server/engine/barrier.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COUNTDOWN APPEARS WHEN IT MEANS SOMETHING, AND NOT BEFORE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Bell exists so a turn-based game played by six friends does not stall on
 * whoever went to make tea, and every bit of its force is social: the clock
 * appearing means *the table is waiting on you now*. `barrier.ts` states the
 * rule and states why it is safe to be aggressive — *"`committed >= total - 1`
 * is the same thing as `blocking.length <= 1`: the Bell only ever rings for the
 * LAST straggler, which is why it can be aggressive without ever hurrying
 * somebody who has company."*
 *
 * ═══ WHAT WAS WRONG, AND IT MADE THE WHOLE MECHANIC WALLPAPER ═══
 * `BellState` carries two different facts and their doc comments say so:
 * `running` ("true while a countdown is actually running") and `durationMs`
 * ("what the countdown WOULD be, EVEN WHEN IT IS NOT RUNNING"). `TurnState`
 * carried only the second one, and the gateway's `syncBell` treats a non-null
 * `bellDurationMs` as *arm a real wall-clock timer for this long*.
 *
 * So the moment three people were in a fight, a 20-second timer was armed and a
 * 20-second countdown was drawn on three screens with nobody having committed to
 * anything. When it reached zero `barrier.expire` re-derived the rule, correctly
 * found the Bell was never armed, and returned no passes — so the clock hit zero,
 * nothing happened, and it started again. Forever, in every group fight.
 *
 * That is worse than a cosmetic bug. A countdown that is always running is a
 * countdown that is never information, so the ONE moment it should have meant
 * something — everybody else is committed and the table is waiting on you — was
 * indistinguishable from the twenty minutes of noise before it.
 *
 * ═══ AND SINCE 2026-09-23 THE CLOCK IS ON WHOEVER'S TURN IT IS ═══
 * A party's turns go one at a time in initiative order, so there is always
 * exactly one person the table is waiting on: the first in line who has not
 * decided. The Bell runs on them from the moment it is their turn, and when it
 * runs out it passes for THEM — so it can never again reach zero with nobody to
 * act on. A player alone has no clock at all.
 */

function scene(names: readonly string[]) {
  const world = createWorld('bell-wiring');
  world.level.tiles.fill(TileCode.FLOOR);
  const downed = createDownedState();
  const parties = createPartyState();
  const engine = createTurnEngine({ world, downed, parties });

  names.forEach((id, i) => {
    const body = world.addPlayer(id, id, { maxHp: 40 });
    body.x = 4 + i;
    body.y = 4;
    engine.join(id);
    engine.setConnected(id, true);
  });

  return { world, engine };
}

/** Something hostile and adjacent, so `engagement > 0` and the barrier blocks. */
function arm(world: ReturnType<typeof createWorld>): void {
  world.addMonster('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 6,
    y: 5,
    profile: AiProfile.MeleeChaser,
    maxHp: 30,
  });
}

describe('the Bell is armed only when it is on somebody', () => {
  it('arms on the first player in line the moment a party’s fight starts', () => {
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();

    const state = engine.turnState();
    expect(state.whoseTurn).toHaveLength(3);
    expect(state.current).toBe(state.whoseTurn[0]);
    expect(state.bellDurationMs).toBe(BELL_MS.Normal);
  });

  it('names the player the roll put first, not the first to join', () => {
    // `whoseTurn[0]` is whose turn it is only if the survey walks the TURN
    // order. Set so the last to join goes first.
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    const order: Record<string, number> = { p1: 10, p2: 20, p3: 30 };
    for (const body of world.allActors()) body.initiative = order[body.id] ?? 1;
    engine.pump();

    expect(engine.turnState().whoseTurn).toEqual(['p3', 'p2', 'p1']);
    expect(engine.turnState().current).toBe('p3');
  });

  it('moves to the next player in line when the one before decides', () => {
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();
    const [first, second] = engine.turnState().whoseTurn;
    if (first === undefined || second === undefined) throw new Error('fixture: short line');

    engine.hold(first);
    const state = engine.turnState();
    expect(state.current).toBe(second);
    expect(state.bellDurationMs).toBe(BELL_MS.Normal);
  });

  it('does not move for a player who decides out of turn', () => {
    // The LAST in line queues a hold. It is still the first player's turn, and
    // the clock is still theirs.
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();
    const line = engine.turnState().whoseTurn;
    const last = line[line.length - 1];
    if (last === undefined) throw new Error('fixture: empty line');

    engine.hold(last);
    expect(engine.turnState().current).toBe(line[0]);
  });

  it('never arms for a player on their own', () => {
    // Nobody is being kept waiting, so there is no clock at all — the gateway
    // is handed null and arms no timer. This was a two-minute Solo Bell, and it
    // was the thing that passed a lone player's open round for them and then
    // benched them on Standing By. ToME never hurries a player.
    const { world, engine } = scene(['p1']);
    arm(world);
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBeNull();
  });

  it('never arms out of combat, however many people are standing about', () => {
    // Belt and braces, and `bellDurationMs` said so first: at engagement 0
    // nothing blocks, so there is nobody to ring a bell at.
    const { engine } = scene(['p1', 'p2', 'p3']);
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBeNull();
  });
});
