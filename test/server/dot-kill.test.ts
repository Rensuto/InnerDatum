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

  it('puts the blow itself on the wire, with a number and a cause', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WHOLE TRANSCRIPT OF A DEATH BY BLEEDING WAS ONE SENTENCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `hitToWire` derives the `damage` frame from an ACTION OUTCOME, so a blow
     * nobody struck produced no frame: no number, no hp, no cause. A player
     * watching their health fall had nothing in the log saying what was doing
     * it.
     *
     * UPSTREAM HAS NO SUCH GAP BECAUSE IT LOGS AT THE PROJECTOR — every hit
     * goes through `takeHit` and is then logged as `"%d %s"`, the same path for
     * a sword swing and a wound (damage_types.lua:491-501). The log is attached
     * to DAMAGE there, not to attacks, which is exactly the distinction ours
     * had lost.
     */
    const { engine } = stage();
    const damage: { id?: string; amount?: number; hp?: number; sourceId?: string }[] = [];
    const deaths: { id?: string }[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      for (const ev of engine.pump().playerEvents) {
        if (ev.k === 'damage') damage.push(ev);
        if (ev.k === 'death') deaths.push(ev);
      }
    }

    expect(damage.length, 'a bleed put nothing on the wire').toBeGreaterThan(0);
    const first = damage[0];
    expect(first?.id, 'the line is about the wrong body').toBe('m1');
    expect(first?.amount ?? 0, 'a damage line with no damage in it').toBeGreaterThan(0);
    // THE CAUSE. "Something is hurting you" with no name is the sentence this
    // whole event exists to replace.
    expect(first?.sourceId, 'the blow has no cause on it').toBe('p1');
    // ...and the hp is the victim's AFTER the hit, so the Case Log can print
    // the pair the way every other damage line does.
    expect(first?.hp).toBeLessThan(3);

    // AND THE DEATH LINE, so a monster that bleeds out does not simply vanish.
    expect(
      deaths.map((d) => d.id),
      'the kill was never announced',
    ).toContain('m1');
  });

  it('narrates the ticks that do NOT kill, which is most of them', () => {
    /**
     * THE FIXTURE ABOVE KILLS ON ITS FIRST TICK, so on its own it cannot tell a
     * report-the-hit implementation from a report-only-the-kill one — and the
     * second is the bug: a player watching their own health fall three turns
     * running with nothing in the log saying why is the ordinary experience of
     * being bled, and it is the case the killing blow never covers.
     */
    const world = createWorld('dot-survives');
    const effects = createEffectState();
    registerEffect(effects, BLEEDING);
    const engine = createTurnEngine({ world, downed: createDownedState(), effects });
    world.addPlayer('p1', 'Dalt');
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 7,
      y: 2,
      profile: AiProfile.MeleeChaser,
    });
    husk.maxHp = 200;
    husk.hp = 200;
    setEffect(effects, husk, EffectId.Bleeding, 20, { power: 5, srcId: 'p1' }, world.rng);

    const lines: number[] = [];
    let died = false;
    for (let turn = 0; turn < 4; turn += 1) {
      // A HELD TURN IS STILL A TURN. Without it the pump parks waiting on the
      // player and the base clock never advances, so the bleed ticks once and
      // the test measures a single tick while claiming to measure several.
      engine.hold('p1');
      for (const ev of engine.pump().playerEvents) {
        if (ev.k === 'damage' && ev.id === 'm1') lines.push(ev.amount);
        if (ev.k === 'death') died = true;
      }
    }

    expect(died, 'the husk was supposed to survive — the fixture is wrong').toBe(false);
    expect(lines.length, 'a bleed that does not kill says nothing').toBeGreaterThan(1);
    expect(Math.min(...lines), 'a damage line with no damage in it').toBeGreaterThan(0);
  });

  it('does not print a monster`s death line over a player who is merely DOWNED', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `hitToWire` PUSHES `death` FOR WHOEVER `killed` NAMES, PLAYER OR NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The Record lane prints "X is unfiled." for a `death` — the game's own word
     * for a monster's permanent removal — so a player bled to 0 with an ally two
     * tiles away and five turns to reach them reads as gone for good. That is a
     * real fault on the attack path and it is queued; what this pins is that the
     * status path does not repeat it.
     *
     * A PLAYER AT 0 IS `alive === false` ON PURPOSE (engine/downed.ts) — the
     * `downed` event is the one that belongs to them, and `survivalPass` raises
     * it a line above `resolveStatusHits`.
     */
    const world = createWorld('dot-player');
    const effects = createEffectState();
    registerEffect(effects, BLEEDING);
    const engine = createTurnEngine({ world, downed: createDownedState(), effects });
    const dalt = world.addPlayer('p1', 'Dalt');
    dalt.maxHp = 4;
    dalt.hp = 4;
    setEffect(effects, dalt, EffectId.Bleeding, 20, { power: 9 }, world.rng);

    const kinds: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      // See the note above: a parked pump advances no base clock.
      engine.hold('p1');
      for (const ev of engine.pump().playerEvents) kinds.push(ev.k);
    }

    /**
     * ═══ THE SETUP HAS TO HAVE WORKED, AND NOT VIA HP ═══
     * `hp` reads 4 again by the end: a lone player IS the whole party, so going
     * down raises a wipe and `resetFloorParty` restores them inside the same
     * pump. (That collapse is why the death plate is driven off `erased`/Wipe
     * rather than the party frame.) The EVENTS are the honest witness.
     */
    expect(kinds, 'the bleed never put them down — the fixture is not measuring').toContain(
      'downed',
    );
    expect(kinds, 'the blow itself was never narrated').toContain('damage');
    // ═══ AND THE ORDER: THE BLOW BEFORE WHAT IT COST ═══
    expect(
      kinds.indexOf('damage'),
      'the transcript announced the downing before the blow that caused it',
    ).toBeLessThan(kinds.indexOf('downed'));
    // ═══ AND THE CLAIM ═══
    expect(kinds, 'a DOWNED player was announced as permanently dead').not.toContain('death');
  });

  it('says what kind of damage it was', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "7 damage" FOR EVERY BLOW IN THE GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A critical hit from a Redacted's darkness read character-for-character
     * like a graze off a husk's fist. `combat.ts`'s attack result has carried
     * `type` and `crit` since M3; `Blow` dropped the first and `hitToWire`
     * dropped the second — one field lost at each of two hops, which is why
     * neither was ever missed.
     *
     * `DamageType`'s own docblock gave "the client's log renderer" as the reason
     * its values are lowercase, and that described no code at all until the
     * field existed to carry them.
     */
    const { engine } = stage();
    const damage: { type?: string }[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      for (const ev of engine.pump().playerEvents) if (ev.k === 'damage') damage.push(ev);
    }

    expect(damage.length, 'no damage frame at all').toBeGreaterThan(0);
    expect(damage[0]?.type, 'the blow does not say what kind it was').toBe('physical');
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
