// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PHASE DOOR RUNE — inscriptions.lua:1313-1344, engine/Actor.lua:331-351, and the
 * effect at magical.lua:2277-2303.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT COSTS WITHOUT IT ═══
 * Before this the game's only escape was `fog_step` — Disengage, three tiles on
 * foot. Against anything with `globalSpeed: 1.2` that is closed back in two
 * turns while you spent one, so there was no answer at all to "something faster
 * than me has me, and walking will not help". A teleport is a different KIND of
 * answer: ten tiles at once, through the wall, and the thing chasing you has to
 * find you again.
 *
 * ═══ AND THE HALF THAT IS EASY TO SHIP DEAD ═══
 * `ActorMove` exists in this codebase because THREE talents moved people and no
 * client was ever told — the server's positions were right, no `move` frame was
 * produced, and every client kept drawing the caster on the tile she left, with
 * the camera and targeting anchored there, permanently. A teleport that skipped
 * the recorder would be that bug again at ten tiles instead of three, so it is
 * asserted here first.
 */

import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import {
  classById,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { effectsOn, setEffect, statusApplier } from '../../src/server/engine/effects.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { teleportRandom } from '../../src/server/engine/talents.ts';
import { phaseDoorRune } from '../../src/server/talents/phase_door_rune.ts';
import { UNFILED } from '../../src/server/content/origins.ts';
import { STUNNED } from '../../src/server/content/effects.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { trained } from '../helpers/trained.ts';

/** A body that knows the rune, in a real world, with a real runtime. */
function arena() {
  const world = createWorld('phase-door');
  const player = world.addPlayer('p1', 'Dalt');
  const effects = createMvpEffectState();
  const engine = createContentTalentEngine();
  const definition = classById('watchman');
  if (definition === undefined) throw new Error('no watchman');
  engine.attach('p1', trained(sheetForClass(definition, [], [], undefined, UNFILED)));
  const runtime = talentRuntimeFor(engine, world, statusApplier(effects, world.rng));
  return { world, player, effects, runtime };
}

describe('the blink', () => {
  it('moves the body, and never leaves it where it started', () => {
    const { player, runtime } = arena();
    const from = { x: player.x, y: player.y };

    const used = runtime.use(player, phaseDoorRune.id, undefined);
    expect(used.ok, `the rune was refused: ${used.ok ? '' : used.reason}`).toBe(true);
    // `teleportRandom` skips any occupied tile, and the caster occupies its own,
    // so the caster's square is never a candidate. A blink that landed you
    // where you were is a spent cooldown and a lie.
    expect(
      player.x !== from.x || player.y !== from.y,
      'the blink landed the caster back on their own tile',
    ).toBe(true);
  });

  it('REPORTS the move, or every client draws the caster on the old tile forever', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `recordingWorld` wraps `tryMove` to build `ActorMove`. A teleport does not
     * go through `tryMove` — it cannot, the destination is not walkable-to — so
     * `placeAt` had to be wrapped as well. If it were not, the server would move
     * the body, emit no `move` frame, and the client's `case 'talent'` is
     * deliberately no-state-change: the caster would be drawn on her old tile
     * with the camera and targeting cursor anchored there, and there is no
     * client-initiated resync in the protocol to fix it.
     */
    const { player, runtime } = arena();
    const from = { x: player.x, y: player.y };

    const used = runtime.use(player, phaseDoorRune.id, undefined);
    expect(used.ok).toBe(true);
    if (!used.ok) return;

    const mine = used.landing.moved.find((m) => m.id === 'p1');
    expect(mine, 'the teleport produced no ActorMove — the clients are not told').toBeDefined();
    expect(mine?.from).toEqual(from);
    expect(mine?.to).toEqual({ x: player.x, y: player.y });
  });

  it('never lands anywhere it could not stand', () => {
    /**
     * A hundred blinks from a fresh position each time. Every destination has to
     * be somewhere the body could legally be — a teleport that ignored terrain
     * would put people inside walls, and one that ignored bodies would stack
     * two on a tile, which the movement code assumes cannot happen.
     */
    const { world, player, runtime } = arena();
    for (let i = 0; i < 100; i += 1) {
      player.cooldowns.clear();
      const used = runtime.use(player, phaseDoorRune.id, undefined);
      if (!used.ok) continue;
      const sitting = world.actorAt(player.x, player.y);
      expect(sitting?.id, 'the blink landed on top of somebody').toBe('p1');
    }
  });

  it('stays inside the range it promises, measured as a disc', () => {
    /**
     * `core.fov.distance` is Euclidean, so the square loop upstream scans is the
     * BOUNDING BOX and `<= dist` carves the circle out of it. Chebyshev here
     * would hand out corners a tenth of a tile further than the sentence says —
     * the same trap `DEFAULT_SIGHT_RADIUS` documents.
     */
    const { world, player } = arena();
    const RANGE = 4;
    for (let i = 0; i < 100; i += 1) {
      const from = { x: player.x, y: player.y };
      if (!teleportRandom(world, player, RANGE, world.rng)) continue;
      const away = Math.hypot(player.x - from.x, player.y - from.y);
      expect(
        away,
        `blinked ${String(away)} tiles on a range of ${String(RANGE)}`,
      ).toBeLessThanOrEqual(RANGE);
    }
  });

  it('answers false rather than hanging when there is nowhere to go', () => {
    // A range of zero has exactly one candidate — the caster's own tile — and
    // that one is excluded as occupied. Upstream returns `false` from `#poss ==
    // 0`; the alternative shape (draw a tile, re-draw if illegal) would spin.
    const { world, player } = arena();
    expect(teleportRandom(world, player, 0, world.rng)).toBe(false);
  });
});

describe('being out of phase', () => {
  it('lands with the rune, at the power the elf is born with', () => {
    const { player, effects, runtime } = arena();
    expect(runtime.use(player, phaseDoorRune.id, undefined).ok).toBe(true);
    const phase = effectsOn(effects, 'p1').find((eff) => eff.effectId === EffectId.OutOfPhase);
    expect(phase, 'the blink left no phase behind — half the talent is missing').toBeDefined();
    // `elf.lua:108` — `{cooldown=7, range=10, dur=5, power=15}`.
    expect(phase?.params['power']).toBe(15);
  });

  it('shortens a new affliction, and the channel had to travel by `modifiers`', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE THIRD CHANNEL IS THE ONE THAT SHIPS DEAD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `def` and `resistAll` go out through `wielder`, which composes into the
     * COMBAT SHEET. The duration reduction is read by `setEffect` off
     * `target.combat.flags`, which is a different table fed by `modifiers` —
     * and putting all three in `wielder` type-checked perfectly and delivered
     * the third one nowhere. tome/class/Actor.lua:7047-7050 is the site:
     *
     *     p.dur = math.ceil(p.dur * (1 - (power/100)))
     *
     * This drives it end to end: phase the body, recompose so the flags fold,
     * then land a detrimental effect and read its duration.
     */
    // THE CONTROL ARENA NEVER BLINKS — it exists to measure an unphased stun,
    // so it takes no runtime.
    const { world, player, effects } = arena();

    setEffect(effects, player, STUNNED.id, 10, {}, world.rng);
    const plain = effectsOn(effects, 'p1').find((eff) => eff.effectId === STUNNED.id)?.dur ?? 0;
    expect(plain, 'the control stun landed with no duration at all').toBeGreaterThan(0);

    const fresh = arena();
    expect(fresh.runtime.use(fresh.player, phaseDoorRune.id, undefined).ok).toBe(true);
    // The fold that puts `reduceDetrimentalTime` on `combat.flags`.
    recomposeCombat(fresh.player, fresh.effects, () => undefined);
    expect(
      fresh.player.combat?.flags?.reduceDetrimentalTime,
      'the phase never reached StatusFlags — the channel is cold',
    ).toBe(15);

    setEffect(fresh.effects, fresh.player, STUNNED.id, 10, {}, fresh.world.rng);
    const phased =
      effectsOn(fresh.effects, 'p1').find((eff) => eff.effectId === STUNNED.id)?.dur ?? 0;
    // ceil(10 * 0.85) = 9 against a control of 10.
    expect(phased, 'the affliction was not shortened by the phase').toBeLessThan(plain);
  });

  it('never shortens a BENEFICIAL effect — that would be a curse, not a defence', () => {
    const { world, player, effects, runtime } = arena();
    expect(runtime.use(player, phaseDoorRune.id, undefined).ok).toBe(true);
    recomposeCombat(player, effects, () => undefined);

    const phase = effectsOn(effects, 'p1').find((eff) => eff.effectId === EffectId.OutOfPhase);
    const held = phase?.dur ?? 0;
    setEffect(effects, player, EffectId.DamageShield, 10, { power: 50 }, world.rng);
    const shield = effectsOn(effects, 'p1').find((eff) => eff.effectId === EffectId.DamageShield);
    expect(shield?.dur, 'a beneficial effect was cut short by the phase').toBe(10);
    expect(held, 'the phase itself expired instantly').toBeGreaterThan(0);
  });
});
