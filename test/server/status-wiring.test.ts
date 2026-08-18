import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { BLEEDING, EffectId, SLOWED, STUNNED } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import {
  createEffectState,
  effectDur,
  hasEffect,
  registerEffect,
  setEffect,
  statusApplier,
} from '../../src/server/engine/effects.ts';
import { talentId } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STATUS SYSTEM WAS FINISHED, TESTED, DOCUMENTED — AND CONNECTED TO NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything existed. `content/effects.ts` had all three MVP statuses with
 * their typed saves and their partial-save duration scaling. `engine/effects.ts`
 * had the whole machine — 1600 lines, `setEffect`, `timedEffects`,
 * `recomputeAttributes`, the stochastic round at Actor.lua:7011. The party pane
 * drew a badge row. `EffectsMsg` was on the wire. 115 references across the
 * test tree exercised every branch.
 *
 * And in the running game none of it could ever fire, because:
 *
 *   1. `main.ts` never called `createEffectState`. There was no table.
 *   2. `wsGateway` was registered without `effects`, so
 *      `broadcastEffectsIfChanged` returned on its first line, forever.
 *   3. `createTurnEngine` was called without it, so `PumpCtx.statusPass` — a
 *      field whose own docblock writes out the exact construction and says "the
 *      adapter in turn-engine.ts is the only thing that holds all three" — was
 *      `undefined` on every path, and no adapter ever built one.
 *   4. Nothing in `src/` called `setEffect` or `registerEffect` at all. Every
 *      one of those 115 references was in `test/`.
 *
 * A subsystem that only its own tests can reach is indistinguishable from one
 * that was never written. This file is the guard against that happening again:
 * it drives the PRODUCTION adapters — `talentRuntimeFor` out of main.ts, a real
 * `createTurnEngine` — and asserts the seam carries at both ends.
 *
 * ═══ WHY BOTH ENDS, AND WHY THEY ARE DIFFERENT TESTS ═══
 * The seam has two halves that fail independently and silently:
 *
 *   THE DOOR   something applies a status (`ctx.status` → `statusApplier`).
 *   THE CLOCK  something ticks it down (`PumpCtx.statusPass` → `timedEffects`).
 *
 * Wire only the door and every stun in the game is permanent. Wire only the
 * clock and nothing ever gets stunned. Neither failure raises anything.
 */

const REALM_TILES = { x: 10, y: 10 } as const;

function arena(seed: string): { world: World; effects: EffectState } {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  // THE PRODUCTION SHAPE, not `createMvpEffectState`: main.ts registers the
  // three by hand, and a test that used the convenience constructor would keep
  // passing if main.ts registered none of them.
  const effects = createEffectState();
  for (const def of [STUNNED, BLEEDING, SLOWED]) registerEffect(effects, def);

  return { world, effects };
}

describe('the status seam — a subsystem that existed and was reachable from nowhere', () => {
  it('a Watchman’s Lockdown puts a real stun in the real table', () => {
    const { world, effects } = arena('status-door');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: WATCHMAN.maxHp });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;
    dalt.combat = WATCHMAN.combat;
    dalt.baseCombat = WATCHMAN.combat;

    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: REALM_TILES.x + 1,
      y: REALM_TILES.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });

    const talents = createContentTalentEngine();
    const sheet = talents.attach('p1', sheetForClass(WATCHMAN));
    sheet.resource.value = sheet.resource.max;

    // ═══ THE PRODUCTION ADAPTER, WITH THE PRODUCTION DOOR ═══
    // `talentRuntimeFor(talents, world, statusApplier(...))` is character-for-
    // character what main.ts does. Build the runtime without the third argument
    // and this test fails, which is the whole point of it.
    const engine = createTurnEngine({
      world,
      now: () => 0,
      effects,
      // BOTH TALENT SEAMS, because they are different jobs and main.ts passes
      // both: `talents` is the READ-ONLY SUBMISSION GATE (is this in your
      // hotbar, can you afford it), `talentRuntime` is the RESOLVER. Omit the
      // book and every submission is refused as "no such talent in this
      // loadout" before the resolver is ever consulted.
      talents: createTalentBook(talents, world),
      talentRuntime: talentRuntimeFor(talents, world, statusApplier(effects, world.rng)),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    const result = engine.submitTalent('p1', talentId('lockdown'), { x: husk.x, y: husk.y });
    expect(result.ok).toBe(true);
    engine.pump();

    // IN THE TABLE THE CLOCK READS. Not a talent-local flag: `hasEffect` looks
    // at the same `EffectState` `statusPass` was handed.
    expect(hasEffect(effects, 'm_husk', EffectId.Stunned)).toBe(true);

    // AND IT REACHED THE COMBAT SHEET, which is what actually costs the husk
    // 60% of its damage — `recomputeAttributes` writes `StatusFlags.stunned`,
    // combat.ts reads it as `sourceStunned`, damage.ts multiplies by 0.4.
    // Without this the badge would be decoration.
    expect(husk.combat?.flags?.stunned).toBe(true);
  });

  it('the clock runs it out — a stun without a tick is a permanent stun', () => {
    const { world, effects } = arena('status-clock');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: WATCHMAN.maxHp });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;

    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: REALM_TILES.x + 6,
      y: REALM_TILES.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    world.turn.engagement = 3;

    // NO `applyPower`, so no save is rolled and no draw is consumed
    // (Actor.lua:6999). This test is about the CLOCK; letting a die decide the
    // starting duration would make it a test of the save.
    setEffect(effects, husk, EffectId.Stunned, 3, {}, world.rng);
    expect(effectDur(effects, 'm_husk', EffectId.Stunned)).toBe(3);

    // Each pump is one game turn, so three of them retire a three-turn stun.
    // Ten is slack: the assertion that matters is that it reaches zero at all,
    // and a stun that outlives ten turns is the unwired-clock bug exactly.
    for (let i = 0; i < 10; i += 1) {
      expect(engine.hold('p1').ok).toBe(true);
      engine.pump();
    }

    expect(hasEffect(effects, 'm_husk', EffectId.Stunned)).toBe(false);
    expect(husk.combat?.flags?.stunned ?? false).toBe(false);
  });

  it('with no table at all, the engine is byte-for-byte its old self', () => {
    // THE ABSENT SEAM. Every fixture written before the status system exists
    // builds an engine with no `effects`, and each one must keep behaving
    // exactly as it did — `statusPass` undefined, `actBase` on the M3 path.
    const { world } = arena('status-absent');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: WATCHMAN.maxHp });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    world.turn.engagement = 3;

    expect(engine.hold('p1').ok).toBe(true);
    expect(() => engine.pump()).not.toThrow();
  });
});
