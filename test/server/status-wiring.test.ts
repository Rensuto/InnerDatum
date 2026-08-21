import { trained } from '../helpers/trained.ts';
import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { BLEEDING, EffectId, SLOWED, STUNNED } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { MOVE_MP_COST } from '../../src/server/engine/talents.ts';
import { SLOW_PLAYER_MP_PENALTY, createMvpEffectState } from '../../src/server/content/effects.ts';
import { createDownedState, isDowned } from '../../src/server/engine/downed.ts';
import { INDEX_HUSK_ELITE, INDEX_WRAITH, monsterInit } from '../../src/server/content/monsters.ts';
import {
  budgetPenalty,
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
    const sheet = talents.attach('p1', trained(sheetForClass(WATCHMAN)));
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

  it('an Overwritten Husk’s claw leaves a bleed on the body it hit', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE OTHER DIRECTION, AND IT IS THE ONE A PLAYER FEELS.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Lockdown proves a PLAYER can inflict a status. This proves a MONSTER can,
     * which is the half game-design.md § 11 puts in its own sample Record —
     * "Dalt saves (phys 38 vs power 31, 68%) — Slowed 1 turn, not 3." A status
     * system players can only ever hand out is a damage bonus with a badge.
     *
     * It runs through the SCHEDULER, not through `setEffect` directly: the
     * whole point is `strike` consulting `MonsterActor.onHit` and calling
     * `PumpCtx.applyStatus`, and every link in that chain was added at once.
     */
    const { world, effects } = arena('status-claw');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 400 });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;
    dalt.hpRegen = 0;

    // THE REAL TEMPLATE, through the real mapper. A hand-built monster with an
    // `onHit` glued on would pass while `monsterInit` dropped the field.
    world.addMonster(
      'm_elite',
      monsterInit(INDEX_HUSK_ELITE, { x: REALM_TILES.x + 1, y: REALM_TILES.y }),
    );

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    world.turn.engagement = 3;

    // Stand still and let it swing. The claw needs a LANDED hit and the elite
    // can miss, so this is a window rather than a single turn — but the bleed
    // is short, so the check is inside the loop rather than after it.
    let bled = false;
    for (let i = 0; i < 30 && !bled; i += 1) {
      expect(engine.hold('p1').ok).toBe(true);
      engine.pump();
      if (hasEffect(effects, 'p1', EffectId.Bleeding)) bled = true;
    }

    expect(bled).toBe(true);
  });

  it('an Index Wraith’s orb slows the body it lands on, three turns of flight later', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE RANGED RIDER, AND THE FLIGHT IS THE POINT OF THE TEST.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The melee rider is read off the attacker at the instant it swings. This
     * one is FROZEN ONTO THE ORB at the muzzle and applied two or three game
     * turns later, by which time the shooter may have moved, been stunned, or
     * died. Reading it off the shooter at impact would compile, pass a
     * point-blank test, and be wrong the moment anything happened mid-flight.
     *
     * So the wraith is placed at its preferred range rather than adjacent: the
     * orb has to actually cross the gap for this to prove anything.
     */
    const { world, effects } = arena('status-orb');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 900 });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;
    dalt.hpRegen = 0;

    world.addMonster(
      'm_wraith',
      monsterInit(INDEX_WRAITH, { x: REALM_TILES.x + 4, y: REALM_TILES.y }),
    );

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    world.turn.engagement = 3;

    // A long window on purpose: the wraith's `talentIn: 2` is a 1-in-2 chance
    // per turn (not a cadence), the orb needs two to three turns to arrive, and
    // the slow can be saved against. None of that is what is under test — that
    // it EVER lands is.
    let slowed = false;
    for (let i = 0; i < 60 && !slowed; i += 1) {
      expect(engine.hold('p1').ok).toBe(true);
      engine.pump();
      if (hasEffect(effects, 'p1', EffectId.Slowed)) slowed = true;
    }

    expect(slowed).toBe(true);
  });

  it('a party wipe takes the statuses off with everything else', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * "A RESET MEANS THE FIGHT DID NOT HAPPEN" — turn-engine.ts's own words.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Every other clause of `resetFloor` obeys that: full health, hostiles back
     * on their authored tiles, floor loot swept, orbs cleared, and `reap`
     * emptying all five talent side-tables. Statuses were the one thing that
     * survived — so a party that wiped while bleeding, which is the ordinary way
     * to wipe now the elite's claw exists, stood up at full health with the
     * badge still lit and three damage a turn still arriving from a fight the
     * game had just annulled. `dispel` existed with no production caller.
     */
    const { world, effects } = arena('status-wipe');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 40 });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;

    const engine = createTurnEngine({ world, now: () => 0, effects, downed: createDownedState() });
    engine.join('p1');
    world.turn.engagement = 3;

    // ═══ LONGER THAN THE WINDOW, OR THIS TEST PROVES NOTHING ═══
    // A five-turn bleed simply EXPIRES inside a dozen pumps, so the first
    // version of this passed with the fix stashed — natural expiry wearing the
    // fix's clothes. Fifty turns cannot run out here, so the only thing that can
    // clear it is the reset.
    const LONGER_THAN_THE_TEST = 50;
    setEffect(effects, dalt, EffectId.Bleeding, LONGER_THAN_THE_TEST, {}, world.rng);
    expect(effectDur(effects, 'p1', EffectId.Bleeding)).toBe(LONGER_THAN_THE_TEST);

    // Put the only player down, which is a wipe: `resetFloor` runs and the
    // engine reports the party restored.
    dalt.hp = 0;
    for (let i = 0; i < 12 && hasEffect(effects, 'p1', EffectId.Bleeding); i += 1) {
      engine.hold('p1');
      engine.pump();
    }

    // The wipe really did happen — full health in the spawn cluster — so a
    // surviving badge would be the bug rather than a fight still in progress.
    expect(dalt.hp).toBe(dalt.maxHp);

    expect(hasEffect(effects, 'p1', EffectId.Bleeding)).toBe(false);
  });

  it('leaving takes the countdown and the statuses with the body', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A RECALLED BODY CAME BACK PHANTOM-DOWNED, AND STILL BLEEDING.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `reap`, for a MONSTER leaving, empties all five side tables. `leave`, for
     * a PLAYER leaving, emptied three — barrier, talent sheet, party row — and
     * missed the two that describe a body's CONDITION.
     *
     * The scenario is ordinary. Somebody's Discord drops mid-fight while Downed;
     * the reconnect grace expires and the body is recalled through `leave`. They
     * return that evening to the same stable actor id and a brand-new
     * full-health body that the Downed table still has a record for: drawn prone
     * under a countdown, outside the quorum so the barrier waits on somebody who
     * cannot act, and a party of one wipes — `resetFloor` running on a floor
     * where nothing happened. With statuses wired they also came back bleeding
     * from a fight they left.
     */
    const { world, effects } = arena('status-leave');
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 60 });
    dalt.x = REALM_TILES.x;
    dalt.y = REALM_TILES.y;

    const engine = createTurnEngine({ world, now: () => 0, effects, downed });
    engine.join('p1');

    setEffect(effects, dalt, EffectId.Bleeding, 20, {}, world.rng);
    expect(hasEffect(effects, 'p1', EffectId.Bleeding)).toBe(true);

    engine.leave('p1');

    // The body is gone, and so is everything that described it.
    expect(world.getActor('p1')).toBeUndefined();
    expect(hasEffect(effects, 'p1', EffectId.Bleeding)).toBe(false);
    // The Downed table too — asserted through the public reader rather than the
    // map, so this keeps holding if the storage changes.
    expect(isDowned(downed, 'p1')).toBe(false);
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

describe('SLOWED, which was a badge and nothing else', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CLAIM WAS ANNOUNCED TO PLAYERS AND WAS NOT TRUE FOR THREE COMMITS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The commit that gave the Index Wraith its orb-rider shipped with *"Index
   * Wraiths now slow you when their orbs land, so closing the gap on one costs
   * you real ground."* It did not. SLOWED's player half is `-1 MP`
   * (`SLOW_PLAYER_MP_PENALTY`), `budgetPenalty` had **zero production callers**,
   * and nothing charged MP for walking — so a Slowed detective moved exactly as
   * far and acted exactly as often as an unslowed one. The badge was the effect.
   *
   * Two things had to land before it could be true: a step had to cost MP
   * (`docs/game-design.md` § 6, "Move = 1 MP", authored and never charged), and
   * the refill had to subtract the penalty. This is the assertion that the words
   * now match the game.
   */
  it('costs a player one step in three', () => {
    const world = createWorld('slowed-steps');
    const engine = createContentTalentEngine();
    // WATCHMAN by name, not CLASSES[0]: `noUncheckedIndexedAccess` makes the
    // index a maybe, and the class this asserts about is a 3-MP body.
    const cls = WATCHMAN;
    const body = world.addPlayer('p1', 'Ren', { maxHp: cls.maxHp });
    const sheet = engine.attach('p1', trained(sheetForClass(cls)));
    const effects = createMvpEffectState();

    const stepsInARound = (penalty?: { ap: number; mp: number }): number => {
      engine.actBase('p1', world, penalty);
      let taken = 0;
      while (sheet.mp >= MOVE_MP_COST) {
        sheet.mp -= MOVE_MP_COST;
        taken += 1;
      }
      return taken;
    };

    expect(stepsInARound(undefined)).toBe(3);

    setEffect(effects, body, EffectId.Slowed, 3, {}, world.rng);
    const penalty = budgetPenalty(effects, 'p1');
    // The authored number, read off the status rather than repeated here.
    expect(penalty.mp).toBe(SLOW_PLAYER_MP_PENALTY);
    // ...and it is a step the player does not get. THE WHOLE POINT: a wraith
    // holds its stand-off at range 4, so a third less closing speed is the
    // difference between walking at it and needing a plan.
    expect(stepsInARound(penalty)).toBe(2);
  });
});
