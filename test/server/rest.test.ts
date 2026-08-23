// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:971-1075 (`rest`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { DEFAULT_SIGHT_RADIUS, createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { REST_MAX_TURNS, RestStop } from '../../src/shared/rest.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REST, WIRED — the rule in `src/shared/rest.ts` driving a real world.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/shared/rest.test.ts` pins the RULE against a hand-built view and needs
 * no world at all. This file pins the two things that file cannot see:
 *
 *   1. that the loop actually advances the BASE clock, so regen, cooldowns and
 *      status durations all move — the thing a hundred `hold` presses bought;
 *   2. that the view is rebuilt from the world EVERY turn, so a husk that walks
 *      into sight mid-rest ends the rest rather than being noticed at the end.
 *
 * The second is the one worth writing a world for. A rest that read its own
 * conditions once would be a party asleep with something in the room.
 */

function scene(name: string) {
  const world = createWorld(name);
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
  // SETTLE FIRST, exactly as the tide's fixture does: the join leaves energy to
  // hand out, and the state a player standing about actually sits in is the one
  // after that has been spent.
  engine.pump();
  return { world, engine, body, talents, sheet: talents.sheetOf('p1') };
}

describe('rest passes turns the way holding would, without the hundred keys', () => {
  it('heals a hurt body and reports how long it took', () => {
    const { engine, body } = scene('rest-heal');
    body.hp = 10;

    const result = engine.rest('p1');

    expect(result.stop, 'nothing threatened, so it ran to Done').toBe(RestStop.Done);
    expect(result.turns, 'a rest that did nothing would be the bug').toBeGreaterThan(0);
    expect(body.hp).toBe(body.maxHp);
  });

  it('advances the world clock, which is the whole difference from a heal', () => {
    /**
     * A REST IS NOT A POTION. Cooldowns turning over and statuses expiring are
     * most of why the key is worth pressing (Player.lua:1023-1049), and all of
     * them ride the BASE clock — so if the game turn did not move, none of them
     * did, however full the health bar ended up.
     */
    const { engine, world, body } = scene('rest-clock');
    body.hp = 10;
    const before = world.turn.clock.gameTurn;

    const result = engine.rest('p1');

    expect(world.turn.clock.gameTurn).toBe(before + result.turns);
  });

  it('gets faster as it goes, so a long rest is not a long wait', () => {
    /**
     * Player.lua:986 — `math.min(cnt / 10, 8)`. The claim is not "it heals more"
     * (a flat rate would too, given enough turns) but that the SAME amount of
     * healing takes FEWER TURNS than the flat rate would need.
     *
     * `hpRegen` is 0.5 a turn and the body is 30 points down, so a flat rest
     * would need 60 turns. With the bonus it must need materially fewer.
     */
    const { engine, body } = scene('rest-accel');
    body.hp = 10;
    const flatTurns = (body.maxHp - body.hp) / body.hpRegen;

    const result = engine.rest('p1');

    expect(body.hp).toBe(body.maxHp);
    expect(result.turns).toBeLessThan(flatTurns);
  });

  it('says there was nothing to rest off rather than passing a turn', () => {
    // `restStopText` gives this its own sentence. A settled body that pressed
    // the key must not lose a turn to it — that would make rest a way to skip
    // your own turn, which is what `hold` is for.
    const { engine, world } = scene('rest-settled');
    const before = world.turn.clock.gameTurn;

    const result = engine.rest('p1');

    expect(result.turns).toBe(0);
    expect(result.stop).toBe(RestStop.Done);
    expect(world.turn.clock.gameTurn).toBe(before);
  });

  it('refills the class pool, not only health', () => {
    // Player.lua:1011-1020. Full health with an empty pool is the state a party
    // walks out of a fight in, and stopping there would leave every button grey.
    const { engine, sheet } = scene('rest-pool');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 0;

    engine.rest('p1');

    expect(sheet.resource.value).toBe(sheet.resource.max);
  });
});

describe('what stops it', () => {
  it('stops the moment something hostile comes into view, and says which way', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THAT MATTERS, and the reason the view is rebuilt every turn.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The husk is placed BEFORE the rest starts, so this proves the check runs
     * at all; the test below proves it runs on every iteration rather than once.
     */
    const { engine, world, body } = scene('rest-hostile');
    body.hp = 10;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: body.x + 3,
      y: body.y - 4,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
    });
    expect(husk.x - body.x, 'the fixture must land where it was asked to').toBe(3);

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Hostile);
    expect(result.turns, 'it must not rest a single turn beside a hostile').toBe(0);
    expect(result.threat?.dx).toBe(3);
    expect(result.threat?.dy).toBe(-4);
  });

  it('ends a rest ALREADY RUNNING when a hostile walks into view', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE VIEW IS REBUILT EVERY TURN, AND THIS IS WHAT PROVES IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A rest that read its conditions once and then looped would sleep through
     * a monster walking into the room, and would look completely correct in the
     * test above — which places the husk first, so a single read finds it.
     *
     * ═══ THE FIXTURE IS THE ARGUMENT ═══
     * The husk starts at `DEFAULT_SIGHT_RADIUS + 4`, OUTSIDE what the resting
     * body can see, with an aggro range long enough that IT can see US. So the
     * rest genuinely begins — and the clock it is turning is the clock the husk
     * walks on, which is the point: rest does not freeze the world while it
     * runs.
     *
     * So `turns` must be strictly between 0 (it started) and the ~11 a full heal
     * from 4 to 40 would take (it did not finish), and the stop must name the
     * husk.
     */
    const { engine, world, body } = scene('rest-interrupt');
    body.hp = 4;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: body.x + DEFAULT_SIGHT_RADIUS + 4,
      y: body.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
      // LONGER THAN OUR SIGHT, deliberately. Aggro range and sight radius are
      // different questions (see `DEFAULT_SIGHT_RADIUS`), and this fixture needs
      // the asymmetry: something that has noticed us before we can see it.
      aggroRange: 30,
    });

    const result = engine.rest('p1');

    expect(result.stop, 'the husk closed, so the rest must have ended for it').toBe(
      RestStop.Hostile,
    );
    expect(result.threat?.name).toBe('Index Husk');
    expect(
      result.turns,
      'it must have STARTED — a hostile out of sight stops nothing',
    ).toBeGreaterThan(0);
    expect(body.hp, 'and it must NOT have finished').toBeLessThan(body.maxHp);
    expect(
      chebyshev(body, husk),
      'the husk is inside sight when the rest ends, which is why it ended',
    ).toBeLessThanOrEqual(DEFAULT_SIGHT_RADIUS);
  });

  it('stops rather than spinning when health only falls', () => {
    // :1003. The rule's own note: a bleeding body at full health would otherwise
    // rest forever waiting on a number that only goes down.
    const { engine, body } = scene('rest-bleed');
    body.hp = 10;
    body.hpRegen = -1;

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Bleeding);
    expect(result.turns).toBe(0);
  });

  it('never exceeds its budget, whatever the world does', () => {
    /**
     * THE LIVENESS BOUND, and it is not a balance number. Turn resolution is
     * synchronous, so this call holds the whole realm until it returns — a rest
     * that never reached Done would be a server that never answered.
     *
     * Forced here by a body that heals a hair a turn and is enormously deep: it
     * genuinely wants more turns than the budget allows, so the engine must stop
     * and SAY it stopped rather than quietly report a finished rest.
     */
    const { engine, body } = scene('rest-budget');
    body.maxHp = 100_000;
    body.hp = 1;
    body.hpRegen = 0.01;

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Budget);
    expect(result.turns).toBe(REST_MAX_TURNS);
  });

  it('answers rather than throwing for a body that is not there', () => {
    const { engine } = scene('rest-nobody');
    expect(engine.rest('nobody').turns).toBe(0);
  });
});
