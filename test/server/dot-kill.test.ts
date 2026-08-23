// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's `Actor:die` running for ANY death, including
// one dealt by a timed effect (ActorTemporaryEffects.lua:85's `on_timeout` ->
// damage_types.lua projector -> ActorLife.lua:86-94).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { BLEEDING, EffectId } from '../../src/server/content/effects.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createEffectState, registerEffect, setEffect } from '../../src/server/engine/effects.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MONSTER BLED TO DEATH USED TO STAND THERE FOREVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A blow is buried because the scheduler reads `killedBy(effect)` off the ACTION
 * OUTCOME it produced. A bleed tick produces no outcome, so nothing ever looked:
 * `applyDamage` set `alive = false`, returned `{ killed: true }`, and
 * content/effects.ts discarded the answer.
 *
 * MEASURED before the fix, driving a 3 hp husk with a 5-power bleed through the
 * real pump:
 *
 *     hp=0 alive=false  ·  still in world: true  ·  reaped: []
 *     events: held, turn_ended, engagement
 *
 * A corpse on the tile with no death event, no experience, no loot, and counted
 * as present by anything asking whether the site is clear — so bleeding a
 * monster out was strictly worse than letting it live.
 *
 * ═══ THROUGH `createTurnEngine`, NOT A BARE `pump` ═══
 * The fix is three seams — `EffectCtx.noteKill`, `PumpCtx.drainKills`, and
 * `reapStatusKills` — and a bare `pump` with a hand-built ctx would pass while
 * the production wiring was missing, which is precisely the failure this file
 * exists to catch. `createTurnEngine` is what `main.ts` calls.
 */
describe('a monster killed by a status', () => {
  const stage = (): {
    world: ReturnType<typeof createWorld>;
    engine: ReturnType<typeof createTurnEngine>;
  } => {
    const world = createWorld('dot-kill');
    const effects = createEffectState();
    registerEffect(effects, BLEEDING);
    const downed = createDownedState();
    const engine = createTurnEngine({ world, downed, effects });

    world.addPlayer('p1', 'Dalt');
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    husk.maxHp = 3;
    husk.hp = 3;
    setEffect(effects, husk, EffectId.Bleeding, 20, { power: 5, srcId: 'p1' }, world.rng);
    return { world, engine };
  };

  it('is enrolled for burial instead of standing there at 0 hp', () => {
    const { world, engine } = stage();
    const reaped: string[] = [];
    for (let turn = 0; turn < 8; turn += 1) reaped.push(...engine.pump().reaped);

    // ═══ THE SETUP HAS TO HAVE WORKED BEFORE THE CLAIM MEANS ANYTHING ═══
    // A bleed that never ticked would satisfy every assertion below by leaving a
    // husk standing at 3 hp, which is the vacuous green this file is about.
    expect(world.getActor('m1')?.hp ?? 0, 'the bleed never ticked').toBe(0);
    expect(world.getActor('m1')?.alive ?? false, 'the bleed never killed it').toBe(false);

    // AND THE CLAIM. `reaped` is the engine's half of the contract — the caller
    // drains it through `engine.reap` and broadcasts one `left` per body — so
    // this is the line between "the world knows it died" and the old behaviour,
    // where nothing did.
    expect(reaped, 'a bled-out monster is never enrolled for burial').toContain('m1');

    // ...AND THE CONTRACT'S OTHER HALF ACTUALLY BURIES IT, so this is not a list
    // that nobody can act on.
    expect(engine.reap('m1'), 'the enrolled body could not be buried').toBe(true);
    expect(world.getActor('m1'), 'the corpse is still on the board').toBeUndefined();
  });

  it('pays the bleeder for the kill', () => {
    /**
     * A KILL PAYS THREE THINGS — the talent layer's `noteKill` (the Alchemist's
     * reagents), experience, and the body's pockets onto the tile. A bleed paid
     * none of them, so a class that wins by bleeding things out was a class that
     * could not refill its own resource.
     *
     * ASSERTED ON EXPERIENCE because it is the one every class shares.
     *
     * ═══ AND WHAT THIS DOES *NOT* PIN, SAID PLAINLY ═══
     * Swapping `srcId` for the bleed's display `blame` — which falls back to the
     * VICTIM (physical.lua:150) — does NOT fail this test, because the fixture's
     * bleeder is alive and the two are the same body. It stays a deliberate
     * choice rather than a guarded one: `awardExperience` independently refuses a
     * monster killer, so the observable difference is only a spurious
     * `talents.noteKill` on a corpse's id, and a fixture contrived to catch it
     * would be a test about the fallback rather than about the payout.
     */
    const { world, engine } = stage();
    // `xp` lives on `PlayerActor`; `getActor` answers the wider `EngineActor`.
    const dalt = (): PlayerActor => {
      const body = world.getActor('p1');
      if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no Dalt');
      return body;
    };
    const before = dalt().xp;
    for (let turn = 0; turn < 8; turn += 1) engine.pump();

    expect(world.getActor('m1')?.alive ?? false, 'the bleed never killed it').toBe(false);
    expect(dalt().xp, 'the bleeder was paid nothing for the kill').toBeGreaterThan(before);
  });
});
