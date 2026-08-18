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
 * Solo is unaffected and always was: `quorum <= 1` arms on the first blocker,
 * because with nobody else at the table `blocking.length <= 1` is immediate.
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
  it('does not arm while three people are all still deciding', () => {
    /**
     * THE REGRESSION. Nobody has committed, so nobody is waiting on anybody —
     * `blocking.length` is 3 and the rule wants it at 1. The gateway arms its
     * timer off this number, so a non-null answer here is a countdown on three
     * screens that cannot do anything when it reaches zero.
     */
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBeNull();
  });

  it('does not arm when two of three have committed', () => {
    // Still two stragglers. The Bell is for the LAST one, and one player with
    // company must never be hurried.
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();
    engine.hold('p1');

    expect(engine.turnState().bellDurationMs).toBeNull();
  });

  it('ARMS when everybody but one has committed — which is the whole mechanic', () => {
    /**
     * The moment the countdown is supposed to appear, and the reason the three
     * refusals above are not simply "never arm". If this assertion ever reads
     * null the Bell has been switched off rather than fixed, and a party stalls
     * on whoever walked away from the keyboard.
     */
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();
    engine.hold('p1');
    engine.hold('p2');

    expect(engine.turnState().bellDurationMs).toBe(BELL_MS.Normal);
  });

  it('arms immediately for a player on their own', () => {
    // Unaffected and always was: with a quorum of one, `blocking.length <= 1`
    // holds from the first moment, so the solo clock is real. It is the long
    // one (two minutes) precisely because nobody is being kept waiting.
    const { world, engine } = scene(['p1']);
    arm(world);
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBe(BELL_MS.Solo);
  });

  it('never arms out of combat, however many people are standing about', () => {
    // Belt and braces, and `bellDurationMs` said so first: at engagement 0
    // nothing blocks, so there is nobody to ring a bell at.
    const { engine } = scene(['p1', 'p2', 'p3']);
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBeNull();
  });

  it('stops arming again once the straggler acts', () => {
    // The countdown is spent and the fight moves on; the next round starts with
    // three people deciding again and no clock on any of them.
    const { world, engine } = scene(['p1', 'p2', 'p3']);
    arm(world);
    engine.pump();
    engine.hold('p1');
    engine.hold('p2');
    expect(engine.turnState().bellDurationMs).toBe(BELL_MS.Normal);

    engine.hold('p3');
    engine.pump();

    expect(engine.turnState().bellDurationMs).toBeNull();
  });
});
