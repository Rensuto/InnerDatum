// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Shaped against t-engine4 GameEnergyBased.lua:95-142 — the two clocks, and the
// base clock's independence from anybody's speed.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/server/world/world.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TIDE — a shared realm keeps time whether or not anybody presses a key.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE BUG, IN ONE SENTENCE ═══
 * `anyCanGainEnergy` (shared/energy.ts) asks only about the ACT clock, so once
 * every body sits at `ENERGY_TO_ACT` the loop stops granting — and because
 * `grantBaseEnergy` is granted INSIDE that branch, the speed-independent BASE
 * clock stops with it. The base clock is what pays regen, status durations and
 * cooldowns, so on a peaceful shared realm none of them moved unless somebody
 * pressed a key. Six people walking advanced the world six times faster than
 * one; an empty street was frozen.
 *
 * ═══ THE CODEBASE PREDICTED THIS AND PRESCRIBED THE FIX ═══
 * `scheduler.ts`'s `actMonster`, on why there is no wandering: *"it costs the
 * idle fixed point: something has to spend energy for the level to keep ticking,
 * and then the server has a game loop and a home PC has a fan. When wandering
 * lands it needs its own budget — A WANDER PUMP THE CALLER DRIVES ON A SLOW
 * TIMER, NOT THIS ONE."*
 *
 * That is exactly what `tide()` is, and the two properties in that sentence are
 * what these tests pin: it is driven by the CALLER (a wall clock in the gateway,
 * the only layer allowed one), and it has its OWN BUDGET — precisely one game
 * turn, so it can never become a game loop.
 */

function scene() {
  const world = createWorld('tide');
  world.level.tiles.fill(TileCode.FLOOR);
  const downed = createDownedState();
  const parties = createPartyState();
  const engine = createTurnEngine({ world, downed, parties });

  const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
  body.x = 4;
  body.y = 4;
  engine.join('p1');
  engine.setConnected('p1', true);

  // SETTLE FIRST. The join leaves energy to hand out; pumping to the fixed
  // point is the state a player standing about actually sits in, and it is the
  // state in which the bug appears.
  engine.pump();
  return { world, engine, body };
}

describe('a peaceful realm with nobody acting', () => {
  it('does not advance one game turn on its own, which is the bug', () => {
    const { world, engine } = scene();
    const before = world.turn.clock.gameTurn;
    // Ten pumps, no intents. This is six players walking past, or one player
    // holding a key, or a save-triggered resync — every pump the gateway makes.
    for (let i = 0; i < 10; i += 1) engine.pump();
    expect(world.turn.clock.gameTurn).toBe(before);
  });

  it('advances EXACTLY one game turn per tide, however many pumps follow', () => {
    const { world, engine } = scene();
    const before = world.turn.clock.gameTurn;

    engine.tide();
    engine.pump();
    expect(world.turn.clock.gameTurn, 'one tide, one turn').toBe(before + 1);

    // AND THE DEBT IS SPENT. Pumping again must not buy a second turn, or every
    // keystroke after a tide would advance the world and we are back where we
    // started with extra steps.
    for (let i = 0; i < 5; i += 1) engine.pump();
    expect(world.turn.clock.gameTurn, 'the debt is not reusable').toBe(before + 1);
  });

  it('collapses two tides that arrive before a pump into one turn', () => {
    // A flag, not a counter — see `tide()`. A backed-up event loop must not be
    // able to hand the world a burst of turns it will then resolve all at once.
    const { world, engine } = scene();
    const before = world.turn.clock.gameTurn;
    engine.tide();
    engine.tide();
    engine.tide();
    engine.pump();
    expect(world.turn.clock.gameTurn).toBe(before + 1);
  });
});

/** The same scene with a class attached, so the resource half is reachable. */
function classedScene() {
  const world = createWorld('tide-class');
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });

  const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
  body.x = 4;
  body.y = 4;
  talents.attach('p1', sheetForClass(WATCHMAN));
  engine.join('p1');
  engine.setConnected('p1', true);
  engine.pump();
  return { world, engine, body, sheet: talents.sheetOf('p1') };
}

describe('what a tide restores', () => {
  it('gives a hurt body its hp back, which a pump alone never does', () => {
    const { engine, body } = scene();
    body.hp = 10;

    for (let i = 0; i < 10; i += 1) engine.pump();
    expect(body.hp, 'pumps alone heal nothing').toBe(10);

    // `hpRegen` is 0.5 a turn, so this is the clock and not a rounding artefact.
    for (let i = 0; i < 20; i += 1) {
      engine.tide();
      engine.pump();
    }
    expect(body.hp).toBeGreaterThan(10);
  });

  it('gives a spent pool its resource back, on the same clock', () => {
    /**
     * THE OTHER HALF OF WHAT THE TIDE IS FOR. `regenResource` is called from
     * `talents.actBase`, which the scheduler runs in the SAME base pass as
     * `hpRegen` — and the scheduler's note says why they must share it: both
     * *"must fire exactly ONCE PER GAME TURN AT ANY SPEED. On the act clock a
     * hasted body would refill more often, which is a haste that shortens
     * cooldowns by another name."*
     *
     * So this is not a second mechanism. It is the same turn, arriving because
     * time passed rather than because somebody moved.
     */
    const { engine, sheet } = classedScene();
    expect(sheet, 'the fixture must have a class attached').toBeDefined();
    if (sheet === undefined) return;

    sheet.resource.value = 0;
    for (let i = 0; i < 10; i += 1) engine.pump();
    expect(sheet.resource.value, 'pumps alone refill nothing').toBe(0);

    for (let i = 0; i < 20; i += 1) {
      engine.tide();
      engine.pump();
    }
    expect(sheet.resource.value).toBeGreaterThan(0);
    expect(sheet.resource.value).toBeLessThanOrEqual(sheet.resource.max);
  });

  it('never heals past the ceiling, however long the tide runs', () => {
    const { engine, body } = scene();
    body.hp = body.maxHp;
    for (let i = 0; i < 40; i += 1) {
      engine.tide();
      engine.pump();
    }
    expect(body.hp).toBe(body.maxHp);
  });
});

describe('what a tide must NOT do', () => {
  it('banks the idler no extra actions', () => {
    /**
     * `grantEnergy` accrues only while STRICTLY below the threshold, and its
     * own note says why: *"it is why a player who idles for a minute out of
     * combat does not bank sixty turns and then teleport across the map."*
     *
     * That guard is the whole reason a wall clock can drive this at all.
     * Without it a tide every two seconds would hand a body standing in town a
     * free action every two seconds, and they would cross the map on their
     * first keypress.
     */
    const { engine, body } = scene();
    const settled = body.energy;
    for (let i = 0; i < 30; i += 1) {
      engine.tide();
      engine.pump();
    }
    expect(body.energy).toBe(settled);
  });

  it('emits nothing on an idle turn, so it cannot farm disk writes', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RISK THAT WOULD HAVE MADE THIS UNSHIPPABLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `pumpRealm` ends with the only line in the gateway that touches a disk:
     *
     *     else if (result.playerEvents.length > 0 || result.sweep.length > 0)
     *       queueSave('pump');
     *
     * and its rationale — *"an idle pump is a fixed point... a client spamming
     * frames must not be able to farm disk writes"* — was written against a
     * caller that only ever pumped on a player's intent.
     *
     * A tide pumps on a TIMER. If an idle turn emitted even one event, every
     * occupied realm would queue a save every `TIDE_MS` for as long as anybody
     * stood in it — a snapshot of every realm in the process, forever, for a
     * world in which nothing happened.
     *
     * It does not, and the reason is upstream of the tide: `actPlayer` reaches
     * `autoHold` only while `engagement > 0`, and a shared realm has no
     * hostiles, so a body with no intent returns `Done` silently.
     */
    const { engine } = scene();
    engine.tide();
    const result = engine.pump();
    expect(result.playerEvents, 'an idle tide must be silent').toEqual([]);
    expect(result.sweep).toEqual([]);
  });
});
