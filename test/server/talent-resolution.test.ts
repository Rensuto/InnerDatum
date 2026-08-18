import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  CLASSES,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { AiProfile, IntentKind } from '../../src/server/engine/actor.ts';
import { MELEE_REACH } from '../../src/server/engine/combat.ts';
import { Refusal, submitIntent } from '../../src/server/engine/scheduler.ts';
import {
  FOCUS_ON_HELD_GROUND,
  FOCUS_PER_TURN,
  RESOLVE_PER_TURN,
  TalentEffect,
  TalentRefusal,
  markMultiplier,
  resolveGuardCounter,
  talentId,
  useTalent,
} from '../../src/server/engine/talents.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TalentShape, TileCode } from '../../src/shared/protocol.ts';
import type { EngineActor } from '../../src/server/engine/actor.ts';
import type { TalentResolutionResult } from '../../src/server/engine/scheduler.ts';
import type { GuardCounter, TalentEngine, TalentSheet } from '../../src/server/engine/talents.ts';
import type { TalentRuntime } from '../../src/server/turn-engine.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TALENT RESOLUTION SEAM — WHERE A TALENT ACTUALLY HAPPENS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All twelve talents in `src/server/talents/` were written, cited against the
 * Lua and unit-tested, and NONE of them was reachable in play: `resolveIntent`
 * answered `Refusal.NoTalentEffect` for every `IntentKind.Talent`, so a `talent`
 * frame took the refund path and showed the player nothing. This file pins the
 * seam that closed that, from both sides.
 *
 * ═══ THE ABSENT CASE IS AS LOAD-BEARING AS THE PRESENT ONE ═══
 * `PumpCtx.talents` is gated exactly as `downed` and `parties` are, and the
 * promise is byte-for-byte: a server with no runtime wired in behaves as M3 did,
 * down to the RNG stream. That is what makes the seam mergeable on its own.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';
const IRON_CURTAIN = talentId('iron_curtain');
const CRUDE_BLOW = talentId('crude_blow');

/**
 * THE ADAPTER W2 WILL SHIP, WRITTEN OUT HERE SO THE SEAM CAN BE TESTED ALONE.
 *
 * It is deliberately thin — the whole point of `TalentResolution` being three
 * narrow callbacks rather than the `TalentEngine` itself is that `engine/` may
 * not import `content/`, so the layer that can see both is the one that writes
 * these four lines.
 */
function runtimeFor(talents: TalentEngine, world: World): TalentRuntime {
  return {
    use: (actor: EngineActor, id: string, target: TileXY | undefined): TalentResolutionResult => {
      const talent = talents.registry.get(id);
      if (talent === undefined) return { ok: false, reason: TalentRefusal.UnknownTalent };

      // A `self` shape has no target tile; the caster's own is the honest
      // origin for the stamp (protocol.ts: never a sentinel, -1 would be drawn).
      const at = target ?? { x: actor.x, y: actor.y };
      const standing = world.actorAt(at.x, at.y);
      const result = useTalent(
        talents,
        actor,
        id,
        { x: at.x, y: at.y, ...(standing === undefined ? {} : { actorId: standing.id }) },
        { engine: talents, world, rng: world.rng },
      );
      if (!result.ok) return { ok: false, reason: result.reason };

      return {
        ok: true,
        landing: {
          talentId: result.talentId,
          at,
          shape: talent.targeting.shape,
          radius: talent.targeting.radius ?? 0,
          ...(standing === undefined ? {} : { targetId: standing.id }),
          hits: result.hits,
          // Every body the cast repositioned. See `ActorMove` (engine/talents.ts):
          // without this the caster of Fog Step is drawn on the tile she left.
          moved: result.moved,
        },
      };
    },
    actBase: (actorId: string): void => talents.actBase(actorId, world),
    noteMoved: (actorId: string): void => {
      const sheet = talents.sheetOf(actorId);
      if (sheet !== undefined) sheet.movedThisTurn = true;
    },
    noteKill: (actorId: string): void => talents.noteKill(actorId),
    noteStruck: (actorId: string): void => talents.noteStruck(actorId),
    // THE TWO THAT MAKE A RANK VISIBLE ON THE BASIC SWING. Forwarded exactly as
    // `talentRuntimeFor` (src/server/main.ts) forwards them, because this
    // fixture's whole purpose is to be that adapter.
    markMultiplier: (targetId: string): number => markMultiplier(talents, targetId),
    guardCounter: (attackerId: string, victimId: string): GuardCounter | null =>
      resolveGuardCounter({ engine: talents, world, rng: world.rng }, attackerId, victimId),
    forget: (actorId: string): void => talents.forget(actorId),
  };
}

type Scene = {
  readonly world: World;
  readonly talents: TalentEngine;
  readonly sheet: TalentSheet;
  readonly engine: ReturnType<typeof createTurnEngine>;
  /** Queue a talent straight at the scheduler, bypassing the submission gate. */
  readonly cast: (talentId: string, target?: TileXY) => void;
};

/**
 * A Watchman at (10,10) with a husk on the tile east of him, on open floor.
 *
 * `wired: false` builds the SAME world with no runtime, which is how the absent
 * case is asserted against the present one rather than against a memory of it.
 */
function scene(seed: string, options: { readonly wired?: boolean } = {}): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 10;
  ren.y = 10;
  ren.hpRegen = 0;
  ren.maxHp = WATCHMAN.maxHp;
  ren.hp = WATCHMAN.maxHp;
  // MELEE_REACH, not the class sheet's authored 1: `canAttack` measures in
  // EUCLIDEAN, and a reach of exactly 1 refuses all four diagonals. Wiring the
  // class sheets onto joining players — and fixing that 1 — is W2's job; this
  // file only needs the Watchman to be able to swing.
  ren.combat = { ...WATCHMAN.combat, range: MELEE_REACH };

  world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 11,
    y: 10,
    profile: AiProfile.MeleeChaser,
    maxHp: 200,
  });

  const talents = createContentTalentEngine();
  const sheet = talents.attach('p1', sheetForClass(WATCHMAN));

  const engine = createTurnEngine({
    world,
    now: () => 0,
    ...(options.wired === false ? {} : { talentRuntime: runtimeFor(talents, world) }),
  });
  engine.join('p1');
  world.turn.engagement = 3;

  return {
    world,
    talents,
    sheet,
    engine,
    cast: (id, target) => {
      const intent =
        target === undefined
          ? { kind: IntentKind.Talent, talentId: id }
          : { kind: IntentKind.Talent, talentId: id, target };
      // Straight at the scheduler: `submitTalent`'s catalogue gate is a separate
      // feature with its own tests, and what is under test here is RESOLUTION.
      expect(submitIntent(world, engine.barrier, 'p1', intent)).toBe(true);
    },
  };
}

/**
 * AN INSPECTOR ALONE IN A CORRIDOR, with a husk far enough east to keep the
 * fight armed (so the barrier parks every turn) and far enough away to never
 * reach her (so nothing else can move her or interrupt the walk).
 */
function inspectorScene(seed: string): {
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly sheet: TalentSheet;
  /** Run one turn and report what the class resource gained across it. */
  readonly focusDelta: (act: () => void) => number;
} {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const vex = world.addPlayer('p1', 'Vex');
  vex.x = 10;
  vex.y = 10;
  vex.hpRegen = 0;

  world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 17,
    y: 10,
    profile: AiProfile.MeleeChaser,
    maxHp: 500,
  });

  const talents = createContentTalentEngine();
  const sheet = talents.attach('p1', sheetForClass(INSPECTOR));
  const engine = createTurnEngine({
    world,
    now: () => 0,
    talentRuntime: runtimeFor(talents, world),
  });
  engine.join('p1');
  world.turn.engagement = 3;

  // The first pump carries TWO base passes — one before the actor has ever
  // acted — so it is burned here rather than measured, and every turn after it
  // is one action and one base pass exactly.
  expect(engine.hold('p1').ok).toBe(true);
  engine.pump();

  return {
    engine,
    sheet,
    focusDelta: (act) => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EMPTIED BEFORE EVERY MEASUREMENT, BECAUSE A FULL BAR CANNOT GAIN.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Focus is born at its maximum (ActorResource.lua:131 — an actor is
       * created holding `maxname`; only a `switch_direction` resource like
       * Equilibrium starts at its minimum). `gainResource` is a BOUNDED add, so
       * every clause this helper exists to measure — holding ground, the
       * trickle, the move that forfeits them — adds its number and has it
       * clamped straight back off at the cap.
       *
       * The delta would then be 0 for every case, and the two tests that read
       * it would agree that holding ground and moving are worth exactly the
       * same. Both would be measuring the ceiling rather than the clause.
       *
       * Zeroing HERE rather than in each caller keeps the property where the
       * helper's contract is ("report what the resource gained across one
       * turn"), which is only a truthful description of the return value if
       * there is headroom to gain into.
       */
      sheet.resource.value = 0;
      const before = sheet.resource.value;
      act();
      engine.pump();
      return sheet.resource.value - before;
    },
  };
}

describe('with no runtime wired in, nothing changed', () => {
  it('refuses every talent with no_talent_effect, and refunds the turn', () => {
    const table = scene('seam-absent', { wired: false });
    table.sheet.resource.value = 100;

    table.cast(IRON_CURTAIN);
    const result = table.engine.pump();

    expect(result.refusals).toEqual([{ id: 'p1', reason: Refusal.NoTalentEffect }]);
    // The refund rule: zero energy, cleared, re-prompt. Nothing was spent —
    // which is the reason the resource and the cooldown are charged at
    // RESOLUTION and not when the packet arrives.
    expect(table.sheet.resource.value).toBe(100);
    expect(table.sheet.ap).toBe(table.sheet.maxAp);
    expect(table.world.getActor('p1')?.cooldowns.size).toBe(0);
    // And nothing drawable happened at all.
    expect(result.playerEvents).toEqual([]);
  });

  it('does not touch the AP budget or movedThisTurn on the base clock either', () => {
    // The whole seam is one `?.` in three places. If the absent case ever starts
    // calling `actBase`, a server with no talents wired in would begin drawing
    // for a resource regeneration nobody asked for and every replay would shift.
    const table = scene('seam-absent-base', { wired: false });
    table.sheet.ap = 2;
    table.sheet.movedThisTurn = true;

    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();

    expect(table.sheet.ap).toBe(2);
    expect(table.sheet.movedThisTurn).toBe(true);
  });
});

describe('with the runtime wired in, a talent resolves', () => {
  it('emits ONE talent event plus one attacked per hit, in that order', () => {
    // protocol.ts:1582-1592 requires exactly this shape: the stamp carries no
    // damage and no hit flag, and each victim arrives as the same
    // attack/damage/death triple a weapon swing produces. That is what keeps the
    // client's `applyTurnEvent` a single function.
    const table = scene('seam-emits');
    table.sheet.resource.value = 100;

    table.cast(IRON_CURTAIN);
    const mine = table.engine.pump().playerEvents;

    const stamp = mine[0];
    expect(stamp?.k).toBe('talent');
    if (stamp?.k !== 'talent') throw new Error('expected the stamp first');
    expect(stamp.id).toBe('p1');
    expect(stamp.talentId).toBe(IRON_CURTAIN);
    // A `self` shape stamps the CASTER'S OWN TILE, never a sentinel.
    expect({ x: stamp.x, y: stamp.y }).toEqual({ x: 10, y: 10 });
    expect(stamp.shape).toBe(TalentShape.Self);

    // Iron Curtain hits whatever is standing between the Watchman and the ally
    // he covered — here, the husk. Exactly one victim, exactly one triple.
    expect(mine.filter((ev) => ev.k === 'talent')).toHaveLength(1);
    expect(mine.filter((ev) => ev.k === 'attack')).toHaveLength(1);
    const swing = mine.find((ev) => ev.k === 'attack');
    expect(swing?.k === 'attack' ? swing.targetId : undefined).toBe('m_husk');
  });

  it('spends the resource, spends the AP, and sets the cooldown', () => {
    const table = scene('seam-costs');
    table.sheet.resource.value = 100;

    table.cast(IRON_CURTAIN);
    table.engine.pump();

    // ═══════════════════════════════════════════════════════════════════════
    // THE SPEND, PLUS THE ONE BASE TURN THE PUMP RAN AFTER IT. BOTH PINNED.
    // ═══════════════════════════════════════════════════════════════════════
    // Iron Curtain: 5 AP, 25 Resolve, and ToME's ten-action cooldown converted
    // to game turns (talents.ts `tomeCooldownToTurns`).
    //
    // This used to read `.toBe(75)` and was silent about how many base turns the
    // pump carried, which was harmless while `regenPerTurn` was 0 and is not
    // any more. The count is written out rather than folded into the expected
    // figure: ONE base pass runs after the actor acts, on the pump's way to the
    // next park. Base passes BEFORE the cast add nothing, because the pool starts
    // at its cap of 100 and `gainResource` clamps — so this figure would not move
    // even if the pump grew a leading pass.
    //
    // Written as an expression so that a future rate change fails at the RATE,
    // naming it, instead of at a copied decimal that somebody then "fixes".
    const IRON_CURTAIN_RESOLVE = 25;
    const BASE_PASSES_AFTER_THE_ACT = 1;
    expect(table.sheet.resource.value).toBeCloseTo(
      100 - IRON_CURTAIN_RESOLVE + RESOLVE_PER_TURN * BASE_PASSES_AFTER_THE_ACT,
      6,
    );
    // …and no blow landed on him this pump, which is the other thing that could
    // have moved this number (`RESOLVE_ON_STRUCK` is ten times the trickle).
    expect(table.sheet.resource.value).toBeLessThan(100 - IRON_CURTAIN_RESOLVE + 1);
    expect(table.world.getActor('p1')?.cooldowns.get(IRON_CURTAIN)).toBeGreaterThan(0);
  });

  it('REFUNDS with zero energy when it goes illegal between submission and resolution', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE REFUND RULE, WHICH IS WHY NOTHING IS DEDUCTED AT SUBMISSION.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The submission gate ran when the frame arrived; resolution happens on the
    // actor's next turn, and between the two the world moves. Here the Resolve
    // is spent by something else in the meantime — the same shape as a target
    // dying, or the caster being shoved out of range.
    const table = scene('seam-refund');
    table.sheet.resource.value = 100;

    table.cast(IRON_CURTAIN);
    table.sheet.resource.value = 0;

    const result = table.engine.pump();

    expect(result.refusals).toEqual([{ id: 'p1', reason: Refusal.NoTalentEffect }]);
    // Nothing half-applied: no cooldown from a cast that never happened, no AP
    // taken, and the actor still owes a decision.
    expect(table.world.getActor('p1')?.cooldowns.size).toBe(0);
    expect(table.sheet.ap).toBe(table.sheet.maxAp);
    expect(result.turn.whoseTurn).toEqual(['p1']);
  });

  it('maps the dead zone to too_close and the reach to out_of_range', () => {
    // The two refusals carry OPPOSITE instructions and the mapping keeps them
    // apart, exactly as it does for a weapon swing. Crude Blow is range 1, so a
    // tile four away is simply beyond it.
    const table = scene('seam-range');
    table.cast(CRUDE_BLOW, { x: 14, y: 10 });
    expect(table.engine.pump().refusals).toEqual([{ id: 'p1', reason: Refusal.OutOfRange }]);
  });
});

// ===========================================================================
// A TALENT THAT MOVES SOMEBODY HAS TO SAY SO
// ===========================================================================

describe('a talent that repositions a body puts a `move` on the wire', () => {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE DESYNC THIS PINS, AND WHY IT WAS PERMANENT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Three talents move people — Fog Step blinks the caster, Ward Rush knocks the
   * victim back and advances the caster, Backdraft shoves — all through
   * `world.tryMove`, so the SERVER was always right. But `Effect.talent` carried
   * only `{landing, blows}`, `toWireEvents` emitted one `{k:'talent'}` FX stamp,
   * and the client's `case 'talent'` is deliberately NO STATE CHANGE. So no
   * `move` frame was produced and every client — the caster's own included —
   * kept drawing her on the tile she left, with the camera, the targeting cursor
   * and travel pathing anchored there.
   *
   * There is no client-initiated resync frame in the protocol and
   * `needsFullResync` fires only on downed/revived/erased, so it lasted until
   * somebody wiped the floor.
   */
  const FOG_STEP = talentId('fog_step');
  const WARD_RUSH = talentId('ward_rush');

  it('reports the caster’s net displacement for Fog Step, as ONE hop', () => {
    const world = createWorld('talent-move-fog');
    world.level.tiles.fill(TileCode.FLOOR);

    const vex = world.addPlayer('p1', 'Vex', { maxHp: INSPECTOR.maxHp });
    vex.x = 20;
    vex.y = 20;
    vex.hpRegen = 0;
    vex.combat = INSPECTOR.combat;

    // Far enough east to keep the fight armed and never arrive.
    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 30,
      y: 20,
      profile: AiProfile.MeleeChaser,
      maxHp: 400,
    });

    const talents = createContentTalentEngine();
    talents.attach('p1', sheetForClass(INSPECTOR));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: runtimeFor(talents, world),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    expect(
      submitIntent(world, engine.barrier, 'p1', {
        kind: IntentKind.Talent,
        talentId: FOG_STEP,
        target: { x: 23, y: 20 },
      }),
    ).toBe(true);

    const mine = engine.pump().playerEvents;

    // The stamp still comes first — the FX has to fire whatever else happened.
    expect(mine[0]?.k).toBe('talent');

    const moves = mine.filter((ev) => ev.k === 'move');
    expect(moves).toHaveLength(1);
    const hop = moves[0];
    if (hop?.k !== 'move') throw new Error('expected a move frame');
    expect(hop.id).toBe('p1');
    // ONE HOP, not three: `stepToward` walks up to three single steps and the
    // wire carries the net displacement, exactly as an ordinary walk does.
    expect({ x: hop.fromX, y: hop.fromY }).toEqual({ x: 20, y: 20 });
    expect({ x: hop.x, y: hop.y }).toEqual({ x: 23, y: 20 });

    // ...and it agrees with the body the server is actually holding.
    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual({ x: 23, y: 20 });
  });

  it('reports BOTH bodies for Ward Rush, before the blow that goes with it', () => {
    const world = createWorld('talent-move-ward');
    world.level.tiles.fill(TileCode.FLOOR);

    const ren = world.addPlayer('p1', 'Ren', { maxHp: WATCHMAN.maxHp });
    ren.x = 20;
    ren.y = 20;
    ren.hpRegen = 0;
    ren.combat = { ...WATCHMAN.combat, range: MELEE_REACH };

    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 21,
      y: 20,
      profile: AiProfile.MeleeChaser,
      maxHp: 400,
    });

    const talents = createContentTalentEngine();
    talents.attach('p1', sheetForClass(WATCHMAN));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: runtimeFor(talents, world),
    });
    engine.join('p1');
    world.turn.engagement = 3;

    expect(
      submitIntent(world, engine.barrier, 'p1', {
        kind: IntentKind.Talent,
        talentId: WARD_RUSH,
        target: { x: 21, y: 20 },
      }),
    ).toBe(true);

    const kinds = engine.pump().playerEvents.map((ev) => ev.k);

    // ═══ THE ORDER IS THE ASSERTION ═══
    // Stamp, then both moves, THEN the blow. `Blow.at` is snapshotted after the
    // talent resolved, so the struck-tile marker belongs on the tile the husk
    // was knocked TO — emit the moves afterwards and the client draws the marker
    // on the old square and then teleports the body out from under it.
    expect(kinds).toEqual(['talent', 'move', 'move', 'attack', 'damage']);

    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual({ x: 21, y: 20 });
    expect({ x: world.getActor('m_husk')?.x, y: world.getActor('m_husk')?.y }).toEqual({
      x: 22,
      y: 20,
    });
  });

  it('says nothing at all for the nine talents that move nobody', () => {
    // The list is empty for them, so the loop that emits it costs nothing and
    // the wire is byte-for-byte what it was.
    const table = scene('talent-move-none');
    table.sheet.resource.value = 100;
    table.cast(IRON_CURTAIN);

    expect(table.engine.pump().playerEvents.filter((ev) => ev.k === 'move')).toEqual([]);
  });
});

// ===========================================================================
// A HEAL IS NOT A SWING
// ===========================================================================

describe('the party’s only heal is not narrated as an attack', () => {
  it('emits a `damage` frame carrying `healed`, and NO `attack` frame', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // `TalentHit.healed` WAS DROPPED ON THE WAY TO THE WIRE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The `Blow` mapping kept `damage` alone, so Mend Wounds became a blow with
    // `damage: 0, hit: true` and the whole room read:
    //
    //     Ren uses Mend Wounds.
    //     Ren hits Ren.    0 damage. Ren 41.5/54.
    //     Ren hits Alex.   0 damage. Alex 31/54.
    //
    // ...with render/sweep.ts stamping the STRUCK-TILE marker on both allies,
    // because that marker hangs off the `attack` frame. The `damage` frame still
    // has to go out — it is how the client's hp is corrected — so `healed` rides
    // it and `hitToWire` suppresses the swing.
    const world = createWorld('talent-heal');
    world.level.tiles.fill(TileCode.FLOOR);

    const medic = world.addPlayer('p1', 'Rey', { maxHp: ALCHEMIST.maxHp });
    medic.x = 10;
    medic.y = 10;
    medic.hpRegen = 0;
    medic.combat = ALCHEMIST.combat;
    medic.hp = 30;

    const ally = world.addPlayer('p2', 'Alex', { maxHp: ALCHEMIST.maxHp });
    ally.x = 11;
    ally.y = 10;
    ally.hpRegen = 0;
    ally.hp = 20;

    // Far enough east to keep the fight armed without reaching anybody.
    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 30,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 400,
    });

    const talents = createContentTalentEngine();
    talents.attach('p1', sheetForClass(ALCHEMIST));
    const engine = createTurnEngine({
      world,
      now: () => 0,
      talentRuntime: runtimeFor(talents, world),
    });
    engine.join('p1');
    engine.join('p2');
    world.turn.engagement = 3;

    expect(engine.hold('p2').ok).toBe(true);
    expect(
      submitIntent(world, engine.barrier, 'p1', {
        kind: IntentKind.Talent,
        talentId: talentId('mend_wounds'),
        target: { x: 10, y: 10 },
      }),
    ).toBe(true);

    const mine = engine.pump().playerEvents;

    expect(mine[0]?.k).toBe('talent');
    // NOT ONE SWING. No verb, no hit/miss read, and nothing for sweep.ts to
    // stamp a struck-tile marker with.
    expect(mine.filter((ev) => ev.k === 'attack')).toEqual([]);

    const healed = mine.filter((ev) => ev.k === 'damage');
    expect(healed).toHaveLength(2);
    for (const frame of healed) {
      if (frame.k !== 'damage') throw new Error('expected a damage frame');
      expect(frame.amount).toBe(0);
      expect(frame.healed ?? 0).toBeGreaterThan(0);
      // Absolute, as every vital on the wire is — this is what the client sets.
      expect(frame.hp).toBeGreaterThan(0);
    }
    // ...and both bodies really did go up.
    expect(medic.hp).toBeGreaterThan(30);
    expect(ally.hp).toBeGreaterThan(20);
  });
});

describe('the AP budget can never be structurally short', () => {
  it('no talent costs more AP than the smallest class budget', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE HOTBAR MUST NOT BE ABLE TO LIE, AND THIS IS WHERE THAT IS ENFORCED.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // AP and MP are deliberately NOT on the wire. That is only honest while
    // they are structurally incapable of being short at the moment of use:
    // DECISIONS.md D1 pins a player to one action per turn, `actBase` refills
    // every base turn, and nothing else decrements `sheet.ap` — Lockdown's
    // `drainActionBudget` writes the VICTIM'S ENERGY, not their AP, and says so
    // (talents/lockdown.ts:31).
    //
    // So the invariant is simply "the most expensive button fits in the
    // smallest budget". The day somebody authors a 7-AP talent, the BUILD
    // fails here instead of the hotbar quietly greying a button out with no
    // explanation on the wire for why.
    const budgets = CLASSES.map((definition) => definition.maxAp);
    const costs = CLASSES.flatMap((definition) =>
      definition.loadout.map((talent) => talent.cost.ap ?? 0),
    );

    expect(Math.max(...costs)).toBeLessThanOrEqual(Math.min(...budgets));
    // ...and the MP side of the same claim.
    const mpBudgets = CLASSES.map((definition) => definition.maxMp);
    const mpCosts = CLASSES.flatMap((definition) =>
      definition.loadout.map((talent) => talent.cost.mp ?? 0),
    );
    expect(Math.max(...mpCosts)).toBeLessThanOrEqual(Math.min(...mpBudgets));
  });
});

describe('the base-clock pass', () => {
  it('refills AP and MP every game turn', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // NOT OPTIONAL, AND THE FAILURE IS SILENT.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Sheets are created FULL (talents.ts:744-747) and are only ever
    // decremented, so a class attached WITHOUT this call drains AP monotonically
    // from the first cast and never refills. Nothing throws; the hotbar simply
    // stops working three fights in.
    //
    // The budget is drained by hand rather than by casting, because a cast and
    // its refill land inside the SAME pump — the actor acts, and the pump then
    // runs on to the next park, which is where the next base turn fires. That is
    // correct behaviour (a player is never asked for a decision with an empty
    // budget) and it is exactly what makes the drain invisible from outside.
    const table = scene('seam-refill');
    table.sheet.ap = 0;
    table.sheet.mp = 0;

    expect(table.engine.hold('p1').ok).toBe(true);
    table.engine.pump();

    expect(table.sheet.ap).toBe(table.sheet.maxAp);
    expect(table.sheet.mp).toBe(table.sheet.maxMp);
  });

  it('a MOVE suppresses the Inspector’s Focus, and holding ground earns it', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // `movedThisTurn` HAD NO WRITER ANYWHERE IN src/ BEFORE THIS SEAM.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // So the Inspector regained her full 12 Focus every single turn whatever she
    // did — her entire class mechanic ("Focus builds by holding LOS on a marked
    // target and by NOT MOVING", game-design.md § 2) was a per-turn stipend.
    //
    // Asserted through the RESOURCE rather than through the flag, because the
    // flag is set by the move and consumed by the very next base pass inside the
    // same pump: by the time `pump` returns it has already done its job and been
    // cleared. What a player can actually observe is the Focus bar, and that is
    // what is pinned.
    const table = inspectorScene('seam-moved');

    // ═══ EVERY DELTA IS ONE BASE TURN, SO EVERY DELTA CARRIES ONE TRICKLE ═══
    // `regenPerTurn` is added before the per-class switch in `regenResource`, so
    // `FOCUS_PER_TURN` is in BOTH answers and the DIFFERENCE between them is
    // still exactly `FOCUS_ON_HELD_GROUND` — which is the claim this test is
    // making. `toBeCloseTo` because 0.4 is not representable in binary and these
    // deltas are measured off a pool that has already taken adds.
    const holding = table.focusDelta(() => {
      expect(table.engine.hold('p1').ok).toBe(true);
    });
    expect(holding).toBeCloseTo(FOCUS_ON_HELD_GROUND + FOCUS_PER_TURN, 6);

    const walking = table.focusDelta(() => {
      expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    });
    expect(walking).toBeCloseTo(FOCUS_PER_TURN, 6);
    // The suppression is worth ten times the floor, which is the whole reason
    // the floor is safe to add: moving still costs you the shot.
    expect(holding - walking).toBeCloseTo(FOCUS_ON_HELD_GROUND, 6);

    // ...and standing still again earns it back, so the suppression is a fact
    // about the turn rather than a latch that stays down.
    const settled = table.focusDelta(() => {
      expect(table.engine.hold('p1').ok).toBe(true);
    });
    expect(settled).toBeCloseTo(FOCUS_ON_HELD_GROUND + FOCUS_PER_TURN, 6);
  });

  it('leaves the talent budget alone when the sheet belongs to nobody in the world', () => {
    // `leave` and `reap` both call `forget`, and a stale sheet outliving its
    // body would keep regenerating a resource for a character nobody is playing.
    const table = scene('seam-forget');
    expect(table.talents.sheetOf('p1')).toBeDefined();

    table.engine.leave('p1');

    expect(table.talents.sheetOf('p1')).toBeUndefined();
    expect(table.world.getActor('p1')).toBeUndefined();
  });
});

// ===========================================================================
// The two seams that make a rank visible on the BASIC SWING
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TALENT WHOSE LEVEL CHANGES NOTHING IS A LIE IN THE UI.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both of these seams existed as exported engine functions with NO PRODUCTION
 * CALLER, for as long as the scheduler had no way to reach them:
 *
 *   `markMultiplier`      was folded into `talentAttack`/`talentProject` only,
 *                         so Sigil's whole scaled number (15% -> 30%) moved
 *                         nothing on the WEAPON SWING — the party's free,
 *                         at-will, most-used damage — while sigil.ts's
 *                         `describe` promised "everyone — not just you — deals
 *                         +N% damage to it".
 *   `resolveGuardCounter` had ZERO call sites in `src/`, while iron_curtain.ts's
 *                         `describe` advertised its per-rank counter curve
 *                         (0.7 -> 1.2) in the panel's current->next diff.
 *
 * Both are wired through `TalentResolution` now. These tests drive the REAL
 * scheduler through the REAL adapter and measure HIT POINTS — never the engine
 * helpers directly, which is precisely what let the old tests stay green while
 * the functions were unreachable from play.
 */
describe('the basic swing carries the mark — Sigil off the hotbar', () => {
  /**
   * One BUMP attack against the husk, with an optional mark already on it.
   *
   * Walking into it IS the attack, and that is the case worth measuring:
   * `strike` serves both `IntentKind.Attack` and the move bump, so folding the
   * mark in there covers what the party actually spends its turns doing.
   *
   * Same seed and same construction both ways, so the draw stream is identical
   * and any difference in the result is the mark and nothing else.
   */
  const bumpDamage = (seed: string, markPower: number | null): number => {
    const table = scene(seed);
    // A WEAPON THAT ALWAYS LANDS. A miss reports 0 damage, and a test that
    // compared 0 against 0 would pass for the wrong reason — which is the exact
    // failure mode this whole file exists to catch.
    const ren = table.world.getActor('p1');
    if (ren !== undefined) ren.combat = { ...ren.combat, mods: { atk: 200 } };
    if (markPower !== null) {
      table.talents.addEffect('m_husk', {
        kind: TalentEffect.Marked,
        // WHO PAINTED IT. Ren stands in for the Inspector here: the mark is a
        // fact about the TARGET and `markMultiplier` never reads this field, so
        // any live id is honest — but the type requires one, because a Guarding
        // instance genuinely needs it.
        otherId: 'p1',
        turns: 4,
        power: markPower,
      });
    }
    const before = table.world.getActor('m_husk')?.hp ?? 0;
    expect(
      submitIntent(table.world, table.engine.barrier, 'p1', { kind: IntentKind.Move, dir: 'e' }),
    ).toBe(true);
    table.engine.pump();
    return before - (table.world.getActor('m_husk')?.hp ?? 0);
  };

  it('an unmarked bump is byte-identical to a zero-power one', () => {
    // THE REGRESSION GUARD, and the reason `strike` OMITS the `mult` key at 1
    // rather than passing 1: `applyDamage` guards on `spec.mult !== undefined`,
    // and replay-from-seed needs the pipeline to take the same BRANCH rather
    // than to multiply by an identity and argue about floats.
    expect(bumpDamage('mark-none', null)).toBe(bumpDamage('mark-none', 0));
  });

  it('a marked husk takes MORE from the same bump, and more again at a higher rank', () => {
    const plain = bumpDamage('mark-scale', null);
    const rank1 = bumpDamage('mark-scale', 15);
    const rank5 = bumpDamage('mark-scale', 30);

    expect(plain).toBeGreaterThan(0);
    // 15 and 30 are Sigil's own rank-1 and rank-5 `markPower` endpoints.
    expect(rank1).toBeGreaterThan(plain);
    expect(rank5).toBeGreaterThan(rank1);
    // And the STEP is the mark's, not noise: the same blow, +15% and +30%.
    expect(rank1).toBeCloseTo(plain * 1.15, 6);
    expect(rank5).toBeCloseTo(plain * 1.3, 6);
  });
});

describe('a guarded body strikes back — Iron Curtain off the hotbar', () => {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE GUARD IS INSTALLED ON A MONSTER, DELIBERATELY, AND IT PROVES MORE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `resolveGuardCounter` knows nothing about Iron Curtain — it may not, or
   * engine/talents.ts learns the string `talent:iron_curtain` and the registry
   * cycle closes. It matches on the `Guarding` EFFECT and on `isEnemy`, and on
   * nothing else. Putting the guard on a monster therefore exercises the
   * identical code path while letting the PLAYER throw the blow that triggers
   * it, which is deterministic and needs no AI turn to line up.
   *
   * test/server/talents.test.ts already pins the Watchman-guards-Inspector
   * direction of the function itself. What was never pinned — and what was
   * broken — is that the SCHEDULER calls it at all.
   */
  const withWarden = (seed: string, at: TileXY, power = 0.7): Scene => {
    const table = scene(seed);
    // Ren always lands, so that "no counter" can never be "Ren missed and there
    // was nothing to punish". The warden below always lands for the matching
    // reason: the counter is `talentAttack`, which rolls to hit like anything
    // else, and a missed counter and an unwired counter look identical.
    const ren = table.world.getActor('p1');
    if (ren !== undefined) ren.combat = { ...ren.combat, mods: { atk: 200 } };
    const warden = table.world.addMonster('m_guard', {
      name: 'Index Warden',
      sprite: HUSK_SPRITE,
      x: at.x,
      y: at.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });
    warden.combat = { ...warden.combat, range: MELEE_REACH };
    table.talents.addEffect('m_guard', {
      kind: TalentEffect.Guarding,
      otherId: 'm_husk',
      turns: 5,
      // Iron Curtain's counter multiplier, snapshotted onto the effect at cast
      // time — the ONLY channel by which the talent's rank can reach a counter
      // the scheduler triggers. 0.7 is rank 1 and 1.2 is rank 5.
      power,
    });
    warden.combat = { ...warden.combat, mods: { atk: 200 } };
    return table;
  };

  /** Ren swings at the guarded husk and the pump resolves. Her hp loss is the answer. */
  const renLoses = (table: Scene): number => {
    const before = table.world.getActor('p1')?.hp ?? 0;
    expect(
      submitIntent(table.world, table.engine.barrier, 'p1', {
        kind: IntentKind.Attack,
        targetId: 'm_husk',
      }),
    ).toBe(true);
    table.engine.pump();
    return before - (table.world.getActor('p1')?.hp ?? 0);
  };

  /**
   * THE CONTROL. The same pump WITHOUT a warden anywhere.
   *
   * It is not zero, and that is why it has to exist: the pump runs the husk's
   * own turn too, and the husk swings back. Every assertion below is against
   * this number rather than against 0, so "she took damage" can never be
   * satisfied by the blow she was always going to take.
   */
  const baseline = (seed: string): number => {
    const table = scene(seed);
    const ren = table.world.getActor('p1');
    if (ren !== undefined) ren.combat = { ...ren.combat, mods: { atk: 200 } };
    return renLoses(table);
  };

  it('the scheduler fires the counter when a blow lands on a guarded body', () => {
    // REN TAKES DAMAGE SHE WAS NEVER SWUNG AT, over and above the husk's own
    // reply. Both worlds share a seed and a construction order, so the extra is
    // the counter and nothing else.
    const plain = baseline('counter-wired');
    expect(renLoses(withWarden('counter-wired', { x: 10, y: 11 }))).toBeGreaterThan(plain);
  });

  it('does not counter from across the room — the reach guard survives the wiring', () => {
    // Four tiles off. `resolveGuardCounter` measures CHEBYSHEV against the
    // guardian's own `attackRange`, so this one cannot punish anybody — and a
    // counter that ignored reach would be a free hit from anywhere on the floor.
    const plain = baseline('counter-reach');
    expect(renLoses(withWarden('counter-reach', { x: 14, y: 14 }))).toBe(plain);
  });

  it('counters HARDER at a higher rank, all the way through the scheduler', () => {
    // The panel diffs 0.7 -> 1.2 across Iron Curtain's five ranks. This is the
    // end-to-end proof that the number a player reads is the number that lands:
    // the effect's `power` is the only thing that differs between these two
    // worlds, and it reaches `talentAttack` through the seam.
    const low = withWarden('counter-rank', { x: 10, y: 11 }, 0.7);
    const high = withWarden('counter-rank', { x: 10, y: 11 }, 1.2);

    const atRank1 = renLoses(low);
    expect(atRank1).toBeGreaterThan(baseline('counter-rank'));
    expect(renLoses(high)).toBeGreaterThan(atRank1);
  });
});
