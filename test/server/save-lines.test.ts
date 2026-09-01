// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/Actor.lua:7034-7040.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MVP_EFFECTS, STUNNED } from '../../src/server/content/effects.ts';
import { createEffectState } from '../../src/server/engine/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { saveLines } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { GameEvent } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SAVE HAD NEVER ONCE BEEN VISIBLE, AND FOUR DOCBLOCKS SAID IT WAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `statusToWire` maps `negated`, `resisted` and `immune` to no event, and it is
 * right to: they mean nothing landed, so there is no badge to pop and no
 * duration to time. Its own comment then promises *"They are still real and
 * still recorded: they go into the Case Log's Record lane as words."*
 * `EffectView` says the Record lane is *"where the save maths belongs"*.
 * `PumpCtx.statusPass` and `docs/game-design.md` § 11 both print the sample
 * line — *"Dalt saves (phys 38 vs power 31, 68%)"*.
 *
 * Nothing produced one. A rider that was refused looked identical on screen to
 * a rider that was never rolled and to a monster with no rider at all, so the
 * Physical save a party spends points and gear on had no observable effect in
 * the entire history of the game.
 */

function staged(): { world: World; effects: ReturnType<typeof createEffectState> } {
  const world = createWorld('save-lines');
  world.addPlayer('p1', 'Dalt');
  world.addMonster('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 7,
    y: 2,
    profile: AiProfile.MeleeChaser,
  });
  return { world, effects: createEffectState(MVP_EFFECTS) };
}

const note = (over: Record<string, unknown> = {}) => ({
  actorId: 'p1',
  effectId: STUNNED.id,
  kind: 'negated',
  maximum: 3,
  saveChance: 68,
  savedVs: 'phys',
  ...over,
});

describe('a save says so, in words, with the odds', () => {
  it('shrugs off — the save roll beat the power outright', () => {
    // Actor.lua:7036 — `"%s shrugs off %s '%s'!"`.
    const { world, effects } = staged();
    const events = [{ t: 'status', note: note() }] as unknown as GameEvent[];
    expect(saveLines(world, effects, events)).toEqual(['Dalt shrugs off Stunned (phys 68%).']);
  });

  it('resists — a DIFFERENT sentence, because it is a different thing', () => {
    /**
     * Actor.lua:7039 — `"%s resists %s '%s'!"`. `statusToWire`'s own note calls
     * these "genuinely different events": a shrug is the save beating the power,
     * a resist is the save LOSING and the duration grinding to nothing anyway.
     * A player who cannot tell them apart cannot tell whether another point of
     * save is worth buying.
     */
    const { world, effects } = staged();
    const events = [{ t: 'status', note: note({ kind: 'resisted' }) }] as unknown as GameEvent[];
    expect(saveLines(world, effects, events)).toEqual(['Dalt resists Stunned (phys 68%).']);
  });

  it('names an immunity without inventing odds for it', () => {
    // An immunity took no roll, so there is no percentage to print and a made-up
    // one would be worse than none.
    const { world, effects } = staged();
    const events = [
      { t: 'status', note: note({ kind: 'immune', saveChance: null, savedVs: null }) },
    ] as unknown as GameEvent[];
    expect(saveLines(world, effects, events)).toEqual(['Dalt is immune to Stunned.']);
  });

  it('reads the SWEEP steps too, which is where most saves happen', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF A CARELESS VERSION WOULD MISS ENTIRELY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A monster's rider is refused INSIDE its own turn, so the note is a
     * `status` step in a batched sweep rather than a top-level event — an
     * ordinary event would close the batch and split one sweep into three
     * (`createEventSink`). A version reading only the player lane would show a
     * save against a talent and never one against a claw, which is nearly all
     * of them.
     */
    const { world, effects } = staged();
    const events = [
      {
        t: 'sweep',
        gameTurn: 1,
        steps: [{ t: 'status', id: 'p1', note: note() }],
      },
    ] as unknown as GameEvent[];
    expect(saveLines(world, effects, events)).toEqual(['Dalt shrugs off Stunned (phys 68%).']);
  });

  it('says nothing about a status that LANDED', () => {
    // `gained`, `merged` and `lost` all have a badge to draw, and they are
    // `statusToWire`'s business. A Record line for them would double-report
    // every status in the game.
    const { world, effects } = staged();
    for (const kind of ['gained', 'merged', 'lost']) {
      const events = [{ t: 'status', note: note({ kind }) }] as unknown as GameEvent[];
      expect(saveLines(world, effects, events), kind).toEqual([]);
    }
  });

  it('says nothing when there is no status table at all', () => {
    // A build with no effects wired is every pre-M4 fixture, and it must produce
    // the byte-identical pump it always did.
    const { world } = staged();
    const events = [{ t: 'status', note: note() }] as unknown as GameEvent[];
    expect(saveLines(world, undefined, events)).toEqual([]);
  });

  it('drops a note whose body or effect is gone', () => {
    // A content reload under a live game — the same case `projectEffects` skips.
    // There is nothing honest to say about a name that no longer resolves.
    const { world, effects } = staged();
    expect(
      saveLines(world, effects, [
        { t: 'status', note: note({ actorId: 'nobody' }) },
      ] as unknown as GameEvent[]),
    ).toEqual([]);
    expect(
      saveLines(world, effects, [
        { t: 'status', note: note({ effectId: 'effect:not_in_this_build' }) },
      ] as unknown as GameEvent[]),
    ).toEqual([]);
  });

  it('is actually consumed by the gateway, not merely produced', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WIRING, WHICH EVERY TEST ABOVE WOULD PASS WITHOUT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This is the failure this project keeps repeating: a rule that is correct
     * in the engine and reaches no player, with the engine's own tests green.
     * `passives-wired.test.ts` exists because of it and `pools.ts` was extracted
     * because of it. The sentences are useless unless `pumpRealm` broadcasts
     * them, and that is one line in a file no unit test can drive.
     *
     * A SOURCE GUARD, which is the same instrument `auth.test.ts` uses for
     * `requireIdentity` — the weakest kind of test, chosen only where the
     * alternative is no test at all.
     */
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway).toContain('result.saves ?? []');
    expect(gateway).toContain('broadcastRecordLine(realm, line)');
  });
});
