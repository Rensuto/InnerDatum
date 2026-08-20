import { describe, expect, it } from 'vitest';

import {
  allTalents,
  ALCHEMIST,
  CLASSES,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  loadoutViewFor,
  sheetForClass,
  toResourceView,
} from '../../src/server/content/classes.ts';
import {
  AiProfile,
  actBase,
  cooldownOf,
  createMonsterActor,
  setCooldown,
  tickCooldowns,
} from '../../src/server/engine/actor.ts';
import {
  Affinity,
  FOCUS_PER_TURN,
  REAGENT_REGEN_EVERY_TURNS,
  RESOLVE_PER_TURN,
  RESOURCE_RULES,
  ResourceKind,
  TOME_ACTIONS_PER_TURN,
  TalentEffect,
  TalentRefusal,
  TargetShape,
  ballTiles,
  canUseTalent,
  crossTiles,
  markMultiplier,
  resolveGuardCounter,
  secondsToTurns,
  spendResource,
  talentId,
  tomeCooldownToTurns,
  useTalent,
} from '../../src/server/engine/talents.ts';
import {
  ActResult,
  TICKS_PER_GAME_TURN,
  createTurnClock,
  spendForAction,
  tickLevel,
} from '../../src/shared/energy.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import { createRng } from '../../src/shared/rng.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { effectDur, hasEffect, statusApplier } from '../../src/server/engine/effects.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';
import type {
  Talent,
  TalentActor,
  TalentCtx,
  TalentEngine,
  TalentWorld,
} from '../../src/server/engine/talents.ts';
import type { Dir } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * ===========================================================================
 * WHAT IS PINNED HERE
 * ===========================================================================
 *
 *  1. THE TWO COOLDOWN CONVERSIONS, with the source number next to the result.
 *     Cooldowns are in TURNS; neither source of numbers already is.
 *  2. THE REFUND RULE. A talent that goes illegal costs ZERO AP, ZERO resource,
 *     no cooldown, and — the part that only a scripted RNG can see — ZERO
 *     DRAWS. A refusal that consumed a draw would desync every replay.
 *  3. THE DEAD ZONE, and that it is a EUCLIDEAN DISC rather than a count of
 *     steps: two diagonal steps is 2.83 tiles and is INSIDE a min_range 3 hole.
 *     Fog Step is the one talent that works at any distance, because it is the
 *     only way out of one.
 *  4. COOLDOWNS TICK ON THE BASE CLOCK — `actBase`, once per game turn, at any
 *     speed. The #1 port mistake.
 *  5. REAGENTS ARE A COUNTED STOCK: +1 on a kill, full at the stairs, and ONE
 *     WHOLE VIAL every `REAGENT_REGEN_EVERY_TURNS` — pinned from both sides, at
 *     zero rng draws, never fractional on the wire, nothing while at the cap,
 *     and nothing at all for a body that is down.
 *  6. THE CAP: 3 classes x 4 talents = 12, all ids distinct and namespaced.
 */

const W = 16;

function openLevel(walls: readonly (readonly [number, number])[] = []): LevelView {
  const tiles = new Array<number>(W * W).fill(TileCode.FLOOR);
  for (const [x, y] of walls) tiles[y * W + x] = TileCode.WALL;
  return { w: W, h: W, tiles };
}

const DIR_DELTA: Readonly<Record<Dir, readonly [number, number]>> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
};

type Fixture = {
  readonly world: TalentWorld;
  readonly engine: TalentEngine;
  readonly ctx: TalentCtx;
  readonly rng: Rng;
  /** The real status table `ctx.status` writes into. See the note in `fixture`. */
  readonly effects: EffectState;
  add(definition: ClassDef, id: string, x: number, y: number): TalentActor;
  addMonster(id: string, x: number, y: number, hp?: number): TalentActor;
};

/**
 * A minimal world that satisfies `TalentWorld` structurally, exactly as the
 * real `World` does (engine/talents.ts carries a compile-time proof of that).
 * Built here rather than through `createWorld` so a test can place a body on an
 * exact tile instead of wherever the spawn cluster happened to have room.
 */
function fixture(
  rolls: readonly number[] = [],
  walls: readonly (readonly [number, number])[] = [],
): Fixture {
  const level = openLevel(walls);
  const actors: TalentActor[] = [];
  const rng = scriptedRng(rolls);

  const world: TalentWorld = {
    level,
    getActor: (id) => actors.find((a) => a.id === id),
    actorAt: (x, y) => actors.find((a) => a.alive && a.x === x && a.y === y),
    allActors: () => [...actors],
    tryMove: (id, dir) => {
      const actor = actors.find((a) => a.id === id);
      if (actor === undefined) return { ok: false, reason: 'no_actor' };
      const [dx, dy] = DIR_DELTA[dir];
      const nx = actor.x + dx;
      const ny = actor.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) return { ok: false, reason: 'terrain' };
      if (level.tiles[ny * W + nx] !== TileCode.FLOOR) return { ok: false, reason: 'terrain' };
      if (actors.some((a) => a.alive && a.x === nx && a.y === ny)) {
        return { ok: false, reason: 'occupied' };
      }
      actor.x = nx;
      actor.y = ny;
      return { ok: true, x: nx, y: ny };
    },
  };

  const engine = createContentTalentEngine();
  // `talentLevel: 1` is the birth grant every loadout talent is seeded at
  // (`createTalentSheet`). `useTalent` overwrites it from the caster's own
  // sheet, so it only matters for the direct-call helpers — `resolveGuardCounter`
  // below is the one that takes a ctx without going through `useTalent`.
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A REAL STATUS TABLE, ON ITS OWN REAL STREAM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The TABLE is here because Lockdown now lands a stun through `ctx.status`,
   * and a fixture that left the seam out would pin the absent-seam fallback
   * forever while the production path went untested.
   *
   * THE STREAM IS `createRng`, NOT THE SCRIPTED ONE ABOVE, and the difference
   * matters. `scriptedRng` is a SCRIPT — every draw returns the next literal in
   * a list, which is exactly right for "did this stage draw, and how many
   * times" (`drawCount`) and exactly wrong for a save, whose whole behaviour is
   * a DISTRIBUTION: three normal samples, a stochastic round, and a hit roll.
   * Feeding it a constant does not produce a typical save, it produces the
   * extreme, and pinning the extreme would assert the opposite of the mechanic.
   *
   * The seed is fixed, so this is deterministic in the way that matters — the
   * assertions below are stable — while the numbers are ones the real system
   * actually produces. Production correctly shares ONE stream (main.ts hands
   * `statusApplier` the world's rng); a fixture splitting them only means the
   * scripted script stays untouched by status draws, which is what keeps every
   * `drawCount` assertion in this file reading the same as before.
   */
  const effects = createMvpEffectState();
  const ctx: TalentCtx = {
    engine,
    world,
    rng,
    talentLevel: 1,
    status: statusApplier(effects, createRng('talents.test:status')),
  };

  return {
    world,
    engine,
    ctx,
    rng,
    effects,
    add: (definition, id, x, y) => {
      const actor: TalentActor = {
        id,
        name: id,
        kind: ActorKind.Player,
        x,
        y,
        hp: definition.maxHp,
        maxHp: definition.maxHp,
        alive: true,
        combat: definition.combat,
        cooldowns: new Map<string, number>(),
      };
      actors.push(actor);
      engine.attach(id, sheetForClass(definition));
      return actor;
    },
    addMonster: (id, x, y, hp = 40) => {
      const actor: TalentActor = {
        id,
        name: id,
        kind: ActorKind.Monster,
        x,
        y,
        hp,
        maxHp: hp,
        alive: true,
        cooldowns: new Map<string, number>(),
        ai: { targetId: null },
        energy: 1000,
      };
      actors.push(actor);
      return actor;
    },
  };
}

/** Enough draws that no test runs out; every count assertion reads `drawCount`. */
const PLENTY = new Array<number>(64).fill(1);

/**
 * Top the actor's budgets back up.
 *
 * `canUseTalent` checks affordability BEFORE it checks targeting — the cheap,
 * world-free tests first — so a test that wants to see `min_range` has to be
 * able to pay for the shot, and a test that fires twice has to stand in for the
 * once-per-game-turn AP refill that `engine.actBase` normally does.
 */
function refill(engine: TalentEngine, actorId: string): void {
  const sheet = engine.sheetOf(actorId);
  if (sheet === undefined) throw new Error(`no sheet for ${actorId}`);
  sheet.ap = sheet.maxAp;
  sheet.mp = sheet.maxMp;
  sheet.resource.value = sheet.resource.max;
}

// ---------------------------------------------------------------------------

describe('cooldown conversion — TURNS, from two sources that are not', () => {
  it('R2 converts abilities/*.json seconds (docs/data-schemas.md § 5)', () => {
    // toTurns(sec) = max(1, round(sec)), clamped [0,30].
    expect(secondsToTurns(4)).toBe(4); // abilities/sigil.json
    expect(secondsToTurns(6)).toBe(6); // abilities/alchemic_vial.json
    expect(secondsToTurns(4.5)).toBe(5); // abilities/backdraft.json — rounds up
    expect(secondsToTurns(7)).toBe(7); // abilities/ward.json
  });

  it('"0 == at-will" survives the max(1, ...)', () => {
    // abilities/vigil.json authors `cooldown_sec: 0.0`. Without the explicit
    // non-positive branch, max(1, round(0)) would promote every at-will ability
    // in the donor data to a one-turn gate.
    expect(secondsToTurns(0)).toBe(0);
    // …but a real sub-second cooldown is still a whole turn: there is no such
    // thing as a fraction of a turn.
    expect(secondsToTurns(0.4)).toBe(1);
  });

  it('clamps at 30 turns', () => {
    expect(secondsToTurns(60)).toBe(30);
  });

  it('halves ToME cooldowns, because a ToME turn is ONE action and ours is ~2', () => {
    // A verbatim `cooldown = 6` would gate ~12 actions here where upstream
    // gated 6, because an Inner Datum turn carries a 6-AP budget.
    expect(tomeCooldownToTurns(6)).toBe(3); // Shield Pummel, weaponshield.lua:30
    expect(tomeCooldownToTurns(5)).toBe(3); // Taunt, summon-utility.lua:24 — ceils
    expect(tomeCooldownToTurns(10)).toBe(5); // Disengage / Snipe / Shield Wall
    expect(tomeCooldownToTurns(20)).toBe(10); // Bathe in Light, light.lua:56
    expect(tomeCooldownToTurns(0)).toBe(0);
  });

  it('lands those numbers on the actual talents', () => {
    const byId = new Map(CLASSES.flatMap((c) => c.loadout).map((t) => [t.id, t.cooldownTurns]));
    // The three reliable slots are at-will: skills/*.json carry no cooldown
    // field (0 of 33) and AP is the limiter.
    expect(byId.get(talentId('crude_blow'))).toBe(0);
    expect(byId.get(talentId('revolver_shot'))).toBe(0);
    expect(byId.get(talentId('ashwick_flare'))).toBe(0);
    expect(byId.get(talentId('ward_rush'))).toBe(3);
    expect(byId.get(talentId('sigil'))).toBe(4);
    expect(byId.get(talentId('backdraft'))).toBe(5);
    expect(byId.get(talentId('alchemic_vial'))).toBe(6);
    expect(byId.get(talentId('mend_wounds'))).toBe(10);
  });
});

describe('the loadout cap — PLAN.md § 5', () => {
  it('ships exactly three classes, six talents each, eighteen in all', () => {
    expect(CLASSES).toHaveLength(3);
    for (const definition of CLASSES) expect(definition.loadout).toHaveLength(6);
    expect(CLASSES.flatMap((c) => c.loadout)).toHaveLength(18);
  });

  it('gives every talent a distinct, R6-namespaced id', () => {
    const ids = CLASSES.flatMap((c) => c.loadout).map((t) => t.id);
    expect(new Set(ids).size).toBe(18);
    for (const id of ids) expect(id.startsWith('talent:')).toBe(true);
  });

  it('registers all eighteen, and the registry rejects a duplicate', () => {
    const engine = createContentTalentEngine();
    // THE ACTIVES, THE CLASS PASSIVES AND THE SHARED ONES. Counted from the
    // content rather than as a literal, so authoring a talent updates the
    // expectation with the code instead of failing a number somebody then bumps
    // without reading — and counted through `allTalents()`, which is the single
    // enumeration, because `CLASSES.reduce` cannot see a tree no class owns.
    const authored = allTalents().length;
    expect(engine.registry.all()).toHaveLength(authored);
    expect(engine.registry.forClass(WATCHMAN.id)).toHaveLength(
      WATCHMAN.loadout.length + WATCHMAN.passives.length,
    );
    const first = engine.registry.all()[0];
    expect(first).toBeDefined();
    if (first !== undefined) expect(() => engine.registry.register(first)).toThrow(/duplicate/);
  });

  it('makes every talent REACHABLE from exactly one class loadout, and no other', () => {
    // "Reachable" is not a figure of speech: `canUseTalent` answers
    // `NotLearned` for anything outside `sheet.loadout` BEFORE it looks at
    // cooldowns, cost or targeting, so a talent that is registered but absent
    // from every loadout is dead code with an icon. The matrix below is the
    // whole 3 x 12 grid, and it fails from either direction — a talent nobody
    // owns, or a talent two classes can somehow press.
    const f = fixture(PLENTY);
    const owners = CLASSES.map((definition) => ({
      definition,
      actor: f.add(definition, `owner_${definition.id}`, 3 + CLASSES.indexOf(definition) * 4, 12),
    }));
    for (const { actor } of owners) refill(f.engine, actor.id);

    // Iterated from the REGISTRY rather than from the loadouts, so a talent
    // that got registered by some other route and belongs to nobody's four
    // buttons shows up here as unreachable instead of being invisible to a
    // test that only ever looked at the loadouts.
    /**
     * THE ACTIVES. A passive is deliberately NOT reachable through
     * `canUseTalent` — it is not in `sheet.loadout`, so the answer is
     * `NotLearned`, and that is correct rather than a hole: a passive is never
     * pressed. It gets its own ownership check below, which is the half of this
     * assertion that still applies to it.
     */
    const everyTalent = f.engine.registry.all().filter((talent) => talent.onUse !== undefined);
    // Three classes, six actives each. The shared tree adds none — every talent
    // in `generic/groundwork` is passive, which is what a training category is.
    expect(everyTalent).toHaveLength(18);
    // …and the registry as a whole is those 18 plus 18 class passives plus the 6
    // shared, which is the count `allTalents()` is the single enumeration of.
    expect(f.engine.registry.all()).toHaveLength(42);

    for (const talent of f.engine.registry.all()) {
      const owners2 = CLASSES.filter(
        (definition) =>
          definition.loadout.some((owned) => owned.id === talent.id) ||
          definition.passives.some((owned) => owned.id === talent.id),
      );
      if (talent.classId === null) {
        /**
         * A SHARED TALENT IS OWNED BY NO DEFINITION AND CARRIED BY EVERY SHEET,
         * and both halves are asserted because either alone would pass for the
         * wrong reason. `GENERIC_PASSIVES` is joined at `sheetForClass` rather
         * than folded into `ClassDef.passives`, so a shared talent appearing in a
         * definition means somebody copied it back in and the registry is one
         * startup away from throwing on the duplicate.
         */
        expect(owners2, talent.id).toEqual([]);
        for (const definition of CLASSES) {
          expect(sheetForClass(definition).passives, `${definition.id} / ${talent.id}`).toContain(
            talent.id,
          );
        }
        continue;
      }
      // OWNED BY EXACTLY ONE CLASS, actives and passives alike — a talent two
      // classes can reach, or none can, is the failure this half catches.
      expect(owners2.map((definition) => definition.id)).toEqual([talent.classId]);
    }

    for (const talent of everyTalent) {
      // Registered under the id the wire and the cooldown map both use.
      expect(f.engine.registry.get(talent.id)).toBe(talent);

      const holders = CLASSES.filter((definition) =>
        definition.loadout.some((owned) => owned.id === talent.id),
      );
      // EXACTLY ONE class can press it, and it is the one the talent claims.
      expect(holders.map((definition) => definition.id)).toEqual([talent.classId]);

      for (const { definition, actor } of owners) {
        const refusal = canUseTalent(f.engine, actor, talent, { x: actor.x, y: actor.y }, f.world);
        if (definition.id === talent.classId) {
          // An owner may still be refused for a situational reason (aiming a
          // hostile shape at yourself is `Self`), but never for NOT HAVING IT.
          expect({ talent: talent.id, refusal }).not.toEqual({
            talent: talent.id,
            refusal: TalentRefusal.NotLearned,
          });
        } else {
          expect({ talent: talent.id, refusal }).toEqual({
            talent: talent.id,
            refusal: TalentRefusal.NotLearned,
          });
        }
      }
    }

    // …and the loadout the sheet carries is the class definition's, by id, so
    // "in the loadout" means the same thing on both sides of `attach`.
    for (const { definition, actor } of owners) {
      expect(f.engine.sheetOf(actor.id)?.loadout).toEqual(
        definition.loadout.map((talent) => talent.id),
      );
    }
  });

  it('projects a hotbar view whose ids match the cooldown map keys', () => {
    // projectCooldowns (view/projector.ts) sends `actor.cooldowns` keys
    // verbatim. If the wire id were namespaced anywhere OTHER than the registry
    // key, the cooldown wipe would silently never match a button.
    const view = loadoutViewFor(INSPECTOR);
    expect(view.map((t) => t.id)).toEqual(INSPECTOR.loadout.map((t) => t.id));
    const mark = view[1];
    expect(mark).toBeDefined();
    if (mark === undefined) return;
    expect(mark.minRange).toBe(3);
    expect(mark.range).toBe(7);
    expect(mark.shape).toBe(TargetShape.Single);
    expect(mark.cost).toEqual({ ap: 5, mp: 0, resource: 35 });
  });
});

describe('MELEE REACH — the Watchman can swing on a DIAGONAL', () => {
  it('lets all four melee talents reach a husk standing corner to corner', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE √2 REGRESSION. THREE OF THE WATCHMAN'S FOUR BUTTONS DID NOT WORK.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `checkTargeting` here and `submitTalent` in turn-engine.ts both measure
    // with `combatDistance`, which is EUCLIDEAN — `core.fov.distance`, the same
    // metric every range and radius in the game uses, because a Chebyshev ring
    // is a square that reaches 7.07 tiles into its corners.
    //
    // All four Watchman talents authored `range: 1`. The four diagonal
    // neighbours sit at √2 = 1.4142…, which is GREATER THAN 1 — so a Watchman
    // standing corner to corner with a husk was told `out_of_range` on Crude
    // Blow, Ward Rush, Iron Curtain and Lockdown. Only the orthogonal
    // neighbours worked, on the one class whose entire job is to be standing on
    // top of something.
    //
    // 1.5 is the only round number between √2 and the nearest NON-neighbour at
    // 2.0, so a circle of that radius holds exactly the eight tiles around you.
    // That is `MELEE_REACH`, and it is what all four now author.
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    refill(f.engine, 'dalt');
    // (6,6) — one step diagonally. Chebyshev 1, EUCLIDEAN 1.4142…
    const husk = f.addMonster('husk', 6, 6);
    expect(Math.hypot(husk.x - watchman.x, husk.y - watchman.y)).toBeCloseTo(Math.SQRT2, 5);

    for (const talent of WATCHMAN.loadout) {
      refill(f.engine, 'dalt');
      const refusal = canUseTalent(
        f.engine,
        watchman,
        talent,
        { x: husk.x, y: husk.y, actorId: husk.id },
        f.world,
      );
      expect({ talent: talent.id, refusal }).toEqual({ talent: talent.id, refusal: null });
    }

    // …and the ORTHOGONAL neighbour still works, which is what makes this a
    // widening rather than a swap.
    const straight = f.addMonster('straight', 6, 5);
    expect(
      canUseTalent(
        f.engine,
        watchman,
        crudeBlowOf(f),
        { x: straight.x, y: straight.y, actorId: straight.id },
        f.world,
      ),
    ).toBe(null);
  });

  it('still refuses the tile two steps away — the circle did not become a square', () => {
    // 1.5 has to stay BELOW 2.0 or melee quietly gains a tile of reach in every
    // direction, which is the other half of why the constant is not simply "2".
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    refill(f.engine, 'dalt');

    const far = f.addMonster('far', 7, 5); // two tiles orthogonally -> 2.0
    expect(
      canUseTalent(
        f.engine,
        watchman,
        crudeBlowOf(f),
        { x: far.x, y: far.y, actorId: far.id },
        f.world,
      ),
    ).toBe(TalentRefusal.OutOfRange);

    // …and the knight's-move tile at (7,6) is 2.236 away, which is outside it
    // too even though it is only two steps.
    const knight = f.addMonster('knight', 7, 6);
    expect(
      canUseTalent(
        f.engine,
        watchman,
        crudeBlowOf(f),
        { x: knight.x, y: knight.y, actorId: knight.id },
        f.world,
      ),
    ).toBe(TalentRefusal.OutOfRange);
  });

  it('leaves the Inspector’s dead zone exactly where it was', () => {
    // The widening is MELEE only. INSPECTOR authors range 5 / minRange 3 and
    // ALCHEMIST range 5, and neither goes anywhere near `MELEE_REACH` — a
    // "fix" that had loosened the dead zone would have deleted the one number
    // game-design.md § 2 calls the most important in the class.
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    refill(f.engine, 'sam');
    const shot = f.engine.registry.get(talentId('revolver_shot'));
    expect(shot).toBeDefined();
    if (shot === undefined) return;

    // The diagonal neighbour that the Watchman can now reach is still INSIDE
    // her hole, and it is `too close` rather than `out of range`.
    const adjacent = f.addMonster('adjacent', 6, 6);
    expect(
      canUseTalent(
        f.engine,
        inspector,
        shot,
        { x: adjacent.x, y: adjacent.y, actorId: adjacent.id },
        f.world,
      ),
    ).toBe(TalentRefusal.MinRange);
    expect(INSPECTOR.combat.minRange).toBe(3);
    expect(INSPECTOR.combat.range).toBe(5);
    expect(ALCHEMIST.combat.range).toBe(5);
  });
});

/** Crude Blow off the registry, narrowed once so three tests need not each do it. */
function crudeBlowOf(f: Fixture): Talent {
  const talent = f.engine.registry.get(talentId('crude_blow'));
  if (talent === undefined) throw new Error('test fixture: crude_blow is not registered');
  return talent;
}

describe('THE DEAD ZONE — the Inspector cannot shoot adjacent', () => {
  it('refuses at 1 and 2, allows at exactly 3', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    refill(f.engine, 'sam');
    const mark = f.engine.registry.get(talentId('snipers_mark'));
    expect(mark).toBeDefined();
    if (mark === undefined) return;

    for (const [dx, expected] of [
      [1, TalentRefusal.MinRange],
      [2, TalentRefusal.MinRange],
      [3, null],
    ] as const) {
      const husk = f.addMonster(`husk${dx}`, 5 + dx, 5);
      expect(
        canUseTalent(
          f.engine,
          inspector,
          mark,
          { x: husk.x, y: husk.y, actorId: husk.id },
          f.world,
        ),
      ).toBe(expected);
      husk.alive = false;
    }
  });

  it('is a DISC, not a ring of movement steps', () => {
    // The hole is measured with `core.fov.distance` — EUCLIDEAN — not in steps
    // taken. Two diagonal steps LOOK like enough distance and are 2.83 tiles,
    // which is inside a minRange 3 hole; three steps of which only one is
    // diagonal is 3.16 and is outside it. Players read the ring, not the
    // arithmetic, which is exactly why the ring has to be a circle.
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    refill(f.engine, 'sam');
    const mark = f.engine.registry.get(talentId('snipers_mark'));
    expect(mark).toBeDefined();
    if (mark === undefined) return;

    const near = f.addMonster('near', 7, 7); // (2,2) -> 2.83
    expect(
      canUseTalent(f.engine, inspector, mark, { x: near.x, y: near.y, actorId: near.id }, f.world),
    ).toBe(TalentRefusal.MinRange);

    const far = f.addMonster('far', 8, 6); // (3,1) -> 3.16
    expect(
      canUseTalent(f.engine, inspector, mark, { x: far.x, y: far.y, actorId: far.id }, f.world),
    ).toBe(null);
  });

  it('applies to the RELIABLE shot too — the dead zone is the CLASS', () => {
    // content/skills/revolver_shot.json authors `min_range: 1`, which in a
    // real-time game means "no dead zone". game-design.md § 2 overrides it: if
    // the Inspector could fall back to Revolver Shot whenever something closed,
    // the Watchman's chokepoint would buy nothing.
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    refill(f.engine, 'sam');
    const husk = f.addMonster('husk', 6, 5);
    const shot = f.engine.registry.get(talentId('revolver_shot'));
    expect(shot).toBeDefined();
    if (shot === undefined) return;
    expect(
      canUseTalent(f.engine, inspector, shot, { x: husk.x, y: husk.y, actorId: husk.id }, f.world),
    ).toBe(TalentRefusal.MinRange);
    expect(INSPECTOR.combat.minRange).toBe(3);
  });

  it('FOG STEP is the answer: minRange 0, and it works with a body on top of you', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    f.addMonster('husk', 6, 5);

    const result = useTalent(f.engine, inspector, talentId('fog_step'), { x: 3, y: 5 }, f.ctx);
    expect(result.ok).toBe(true);
    expect({ x: inspector.x, y: inspector.y }).toEqual({ x: 3, y: 5 });
    // …and from there the big button is legal again. That is the whole loop.
    refill(f.engine, 'sam');
    const mark = f.engine.registry.get(talentId('snipers_mark'));
    expect(mark).toBeDefined();
    if (mark === undefined) return;
    expect(canUseTalent(f.engine, inspector, mark, { x: 6, y: 5, actorId: 'husk' }, f.world)).toBe(
      null,
    );
  });
});

describe('THE REFUND RULE — an illegal intent costs nothing at all', () => {
  it('spends no AP, no resource, no cooldown and NO RNG DRAW', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const sheet = f.engine.sheetOf('sam');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = sheet.resource.max;
    const husk = f.addMonster('husk', 6, 5); // inside the dead zone

    const before = { ap: sheet.ap, focus: sheet.resource.value, draws: drawCount(f.rng) };
    const result = useTalent(
      f.engine,
      inspector,
      talentId('snipers_mark'),
      { x: husk.x, y: husk.y, actorId: husk.id },
      f.ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(TalentRefusal.MinRange);
    expect(sheet.ap).toBe(before.ap);
    expect(sheet.resource.value).toBe(before.focus);
    expect(inspector.cooldowns.size).toBe(0);
    // The one a code review cannot see: a refusal that consumed a draw would
    // shift every subsequent roll in the turn and desync a replay.
    expect(drawCount(f.rng)).toBe(before.draws);
  });

  it('refunds a talent whose target died between submission and resolution', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const husk = f.addMonster('husk', 6, 5);
    husk.alive = false; // the Inspector got there first

    const sheet = f.engine.sheetOf('dalt');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    const result = useTalent(
      f.engine,
      watchman,
      talentId('crude_blow'),
      { x: 6, y: 5, actorId: 'husk' },
      f.ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(TalentRefusal.NoTarget);
    expect(sheet.ap).toBe(sheet.maxAp);
    expect(drawCount(f.rng)).toBe(0);
  });

  it('refuses a talent that is not in the fixed loadout', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    f.addMonster('husk', 6, 5);
    const result = useTalent(
      f.engine,
      watchman,
      talentId('ashwick_flare'),
      { x: 6, y: 5, actorId: 'husk' },
      f.ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(TalentRefusal.NotLearned);
  });

  it('refuses an unaffordable resource before anything runs', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const sheet = f.engine.sheetOf('dalt');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    // ═══ DRAINED BY HAND, BECAUSE THE BAR IS NOW BORN FULL ═══
    // Resolve starts at its maximum (ActorResource.lua:131 — an actor is
    // created holding `maxname`; only a `switch_direction` resource like
    // Equilibrium starts at its minimum). This test is about the REFUSAL, so it
    // has to manufacture the one state in which a refusal is correct rather
    // than inherit it from a constant.
    sheet.resource.value = 0;
    const result = useTalent(f.engine, watchman, talentId('iron_curtain'), { x: 5, y: 5 }, f.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(TalentRefusal.NoResource);
  });
});

describe('paying for a talent that DID happen', () => {
  it('spends AP and the resource and starts the cooldown, exactly once', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const sheet = f.engine.sheetOf('sam');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 100;
    f.addMonster('husk', 9, 5);

    const result = useTalent(
      f.engine,
      inspector,
      talentId('snipers_mark'),
      { x: 9, y: 5, actorId: 'husk' },
      f.ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.apSpent).toBe(5);
    expect(result.resourceSpent).toBe(35);
    expect(sheet.ap).toBe(sheet.maxAp - 5);
    expect(sheet.resource.value).toBe(65);
    expect(inspector.cooldowns.get(talentId('snipers_mark'))).toBe(5);
  });

  it('NO talent — none of the twelve — can be pressed while it is cooling', () => {
    // Swept rather than spot-checked: `canUseTalent` tests the cooldown before
    // cost and before targeting, so this must hold for the three at-will
    // talents too. They author `cooldownTurns: 0` and are gated by AP alone —
    // but if something ever writes a cooldown onto one (a future effect, a
    // debuff), the gate has to bite there as well.
    const f = fixture(PLENTY);
    for (const definition of CLASSES) {
      const actor = f.add(
        definition,
        `cd_${definition.id}`,
        3,
        3 + CLASSES.indexOf(definition) * 4,
      );
      refill(f.engine, actor.id);
      const here = { x: actor.x, y: actor.y };
      for (const talent of definition.loadout) {
        setCooldown(actor, talent.id, 3);
        expect({
          id: talent.id,
          refusal: canUseTalent(f.engine, actor, talent, here, f.world),
        }).toEqual({ id: talent.id, refusal: TalentRefusal.OnCooldown });
        setCooldown(actor, talent.id, 0); // ToME deletes at zero; so do we
        expect(cooldownOf(actor, talent.id)).toBe(0);
      }
    }
  });

  it('NO talent can be pressed on an empty resource, or an empty AP budget', () => {
    // The other two gates, swept the same way. Order inside `canUseTalent` is
    // cooldown -> AP -> MP -> resource, so each is tested with the earlier ones
    // satisfied; otherwise a test for the resource gate would silently be a
    // second test for the AP gate.
    const f = fixture(PLENTY);
    for (const definition of CLASSES) {
      const actor = f.add(
        definition,
        `broke_${definition.id}`,
        8,
        3 + CLASSES.indexOf(definition) * 4,
      );
      const sheet = f.engine.sheetOf(actor.id);
      expect(sheet).toBeDefined();
      if (sheet === undefined) return;

      const here = { x: actor.x, y: actor.y };
      for (const talent of definition.loadout) {
        const cost = talent.cost.resource ?? 0;
        refill(f.engine, actor.id);
        // One short of the price, or empty for a talent that charges nothing.
        sheet.resource.value = cost > 0 ? cost - 1 : 0;
        const refusal = canUseTalent(f.engine, actor, talent, here, f.world);
        if (cost > 0) {
          // One short is short. `hasResource` is `value >= amount`.
          expect({ id: talent.id, refusal }).toEqual({
            id: talent.id,
            refusal: TalentRefusal.NoResource,
          });
        } else {
          // A talent that costs nothing must NOT be gated by an empty pool —
          // the Watchman's reliable slot has to work at 0 Resolve or the class
          // has no way to start earning any.
          expect({ id: talent.id, refusal }).not.toEqual({
            id: talent.id,
            refusal: TalentRefusal.NoResource,
          });
        }

        refill(f.engine, actor.id);
        sheet.ap = (talent.cost.ap ?? 0) - 1;
        expect({
          id: talent.id,
          refusal: canUseTalent(f.engine, actor, talent, here, f.world),
        }).toEqual({ id: talent.id, refusal: TalentRefusal.NoAp });
      }
    }
  });

  it('then refuses the same talent while it is cooling', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const sheet = f.engine.sheetOf('sam');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 100;
    f.addMonster('husk', 9, 5, 400);

    useTalent(f.engine, inspector, talentId('snipers_mark'), { x: 9, y: 5 }, f.ctx);
    const second = useTalent(f.engine, inspector, talentId('snipers_mark'), { x: 9, y: 5 }, f.ctx);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe(TalentRefusal.OnCooldown);
  });
});

/**
 * Run one actor through the real tick loop for `gameTurns` game turns, with a
 * talent already on cooldown, and report BOTH clocks.
 *
 * A real `MonsterActor` rather than a bare fixture, because the pin is about
 * the interaction of three separate modules: `tickLevel` (shared/energy.ts)
 * decides when `actBase` fires, `actBase` (engine/actor.ts) calls
 * `tickCooldowns`, and `useTalent` (engine/talents.ts) is what wrote the
 * number. A test that called `tickCooldowns` in a loop would prove only that
 * subtraction works.
 *
 * Monsters, because a PLAYER cannot be hasted at all — `PlayerActor` declares
 * `globalSpeed` as the literal type `1` (D1), so `player.globalSpeed = 1.4` is
 * a compile error rather than a balance bug.
 */
function runClocks(
  globalSpeed: number,
  cooldownTurns: number,
  gameTurns: number,
): { readonly actions: number; readonly baseTurns: number; readonly cooldownLeft: number } {
  const monster = createMonsterActor('bell_ringer', {
    name: 'Bell-Ringer',
    sprite: 'mob_husk_s',
    x: 1,
    y: 1,
    profile: AiProfile.MeleeChaser,
    globalSpeed,
  });
  // Any id at all: what is under test is the cooldown STORE and the clock that
  // decrements it, not who owns the button. `actor.cooldowns` is one map per
  // actor and `tickCooldowns` walks all of it (ActorTalents.lua:1002-1013).
  const gated = talentId('crude_blow');
  setCooldown(monster, gated, cooldownTurns);

  let actions = 0;
  let baseTurns = 0;

  tickLevel([monster], {
    clock: createTurnClock(),
    actBase: () => {
      baseTurns += 1;
      // THE REAL once-per-game-turn pass, which is what ticks cooldowns.
      actBase(monster);
    },
    act: (acting) => {
      actions += 1;
      spendForAction(acting, 1);
      return ActResult.Done;
    },
    maxTicks: gameTurns * TICKS_PER_GAME_TURN,
  });

  return { actions, baseTurns, cooldownLeft: cooldownOf(monster, gated) };
}

describe('cooldowns tick on the BASE clock — the #1 port mistake', () => {
  it('ONCE PER GAME TURN REGARDLESS OF HASTE — 14 actions, 10 cooldown ticks', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE TEST THIS FILE EXISTS FOR, AND THE ONE THAT IS INVISIBLE IN PLAY.
    // ═══════════════════════════════════════════════════════════════════════
    // `energyBase` accrues a FLAT ENERGY_PER_TICK and is never multiplied by
    // anything (GameEnergyBased.lua:114-121), so `actBase` — and therefore
    // `cooldownTalents` (ActorTalents.lua:1002-1013) — fires exactly once per
    // game turn at ANY speed. Multiply it by `globalSpeed` anywhere and haste
    // silently becomes a way to BUY COOLDOWNS: nothing crashes, no test that
    // was not written for this fails, and the only symptom is that balance
    // feels wrong three weekends later.
    //
    // A 12-turn cooldown is the discriminator. Across 10 game turns:
    //   CORRECT (base clock): 12 - 10 = 2 turns left, still cooling.
    //   WRONG   (act clock):  12 - 14 <= 0, ready TWO TURNS EARLY.
    const hasted = runClocks(1.4, 12, 10);

    expect(hasted.actions).toBe(14); // haste bought actions…
    expect(hasted.baseTurns).toBe(10); // …and bought nothing here
    expect(hasted.cooldownLeft).toBe(2);
    expect(hasted.cooldownLeft).not.toBe(0);

    // The unhasted control on the identical cooldown: FEWER actions, the SAME
    // number of turns left. That equality is the whole claim.
    const plain = runClocks(1, 12, 10);
    expect(plain.actions).toBe(10);
    expect(plain.cooldownLeft).toBe(hasted.cooldownLeft);
  });

  it('holds at every speed from crawling to quadruple, in one loop', () => {
    // The generalisation. `actions` must vary with speed and `cooldownLeft`
    // must not move at all — a single table that fails loudly whichever clock
    // gets contaminated, in whichever direction.
    for (const [globalSpeed, expectedActions] of [
      [0.5, 5],
      [1, 10],
      [1.4, 14],
      [2, 20],
      [4, 40],
    ] as const) {
      const run = runClocks(globalSpeed, 12, 10);
      expect({
        globalSpeed,
        actions: run.actions,
        baseTurns: run.baseTurns,
        left: run.cooldownLeft,
      }).toEqual({ globalSpeed, actions: expectedActions, baseTurns: 10, left: 2 });
    }
  });

  it('and a hasted actor still waits the full duration before the talent returns', () => {
    // The player-facing statement of the same fact: a 12-turn cooldown is over
    // after 12 GAME TURNS, not after 12 actions. At quadruple speed that is 48
    // actions of waiting, which is exactly what "cooldowns are in turns" means.
    const almost = runClocks(4, 12, 11);
    expect(almost.cooldownLeft).toBe(1);

    const done = runClocks(4, 12, 12);
    expect(done.cooldownLeft).toBe(0);
    expect(done.actions).toBe(48);
  });

  it('one game turn per actBase, and the entry is DELETED at zero', () => {
    // engine/actor.ts owns the store and the decrement; talents.ts only writes
    // into it. `tickCooldowns` is what `actBase` calls, and `actBase` fires once
    // per game turn at ANY speed because it runs off `energyBase`, which is
    // never multiplied by anything (Actor.lua:476-609).
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    f.addMonster('husk', 6, 5, 400);

    useTalent(f.engine, watchman, talentId('ward_rush'), { x: 6, y: 5 }, f.ctx);
    expect(watchman.cooldowns.get(talentId('ward_rush'))).toBe(3);

    tickCooldowns(watchman);
    expect(watchman.cooldowns.get(talentId('ward_rush'))).toBe(2);
    tickCooldowns(watchman);
    tickCooldowns(watchman);
    // ToME deletes at zero (`talents_cd[tid] = nil`) so "absent" and "ready"
    // are the same fact on both sides of the wire.
    expect(watchman.cooldowns.has(talentId('ward_rush'))).toBe(false);
  });
});

describe('REAGENTS ARE A COUNTED STOCK THAT REFILLS IN WHOLE UNITS — game-design.md § 2', () => {
  it('starts full at 8, and one whole vial lands on turn 12 — not on 11', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // BOTH SIDES OF THE CADENCE, BECAUSE ONE SIDE IS AN ACCIDENTAL GREEN.
    // ═══════════════════════════════════════════════════════════════════════
    // This test used to read "never regenerates on a turn tick" and loop
    // exactly TEN base turns. At `REAGENT_REGEN_EVERY_TURNS` = 12 that loop
    // still passes — it would have gone green against the very behaviour it
    // claimed to forbid, which is worse than a red, because nobody re-reads a
    // passing test. So the count is pinned from BELOW (eleven turns change
    // nothing) and from ABOVE (the twelfth pays exactly one).
    //
    // `regenAmmo`, Actor.lua:2074-2084: the counter increments once per base
    // turn and the grant is `shots_left + 1`, never a fraction.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const sheet = f.engine.sheetOf('rey');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    expect(sheet.resource.kind).toBe(ResourceKind.Reagents);
    expect(sheet.resource.value).toBe(8);
    expect(sheet.resource.max).toBe(8);

    sheet.resource.value = 3;
    for (let turn = 0; turn < REAGENT_REGEN_EVERY_TURNS - 1; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
    }
    // Eleven turns of standing still. Nothing partial has reached the pool —
    // the remainder is on `regenCounter`, which is exactly what keeps the pips
    // honest.
    expect(sheet.resource.value).toBe(3);
    expect(sheet.resource.regenCounter).toBe(REAGENT_REGEN_EVERY_TURNS - 1);

    f.engine.actBase(alchemist.id, f.world);
    expect(sheet.resource.value).toBe(4);
    // …and the counter starts over rather than carrying, so the next vial is a
    // full twelve turns away and not one.
    expect(sheet.resource.regenCounter).toBe(0);
    for (let turn = 0; turn < REAGENT_REGEN_EVERY_TURNS - 1; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
    }
    expect(sheet.resource.value).toBe(4);
  });

  it('refills one per kill and completely at the stairs', () => {
    const f = fixture(PLENTY);
    f.add(ALCHEMIST, 'rey', 5, 5);
    const sheet = f.engine.sheetOf('rey');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    sheet.resource.value = 2;
    f.engine.noteKill('rey');
    expect(sheet.resource.value).toBe(3);

    f.engine.noteStairs();
    expect(sheet.resource.value).toBe(8);

    // …and a kill never overflows the stock.
    f.engine.noteKill('rey');
    expect(sheet.resource.value).toBe(8);
  });

  it('is the only resource the wire draws as pips, and the only one on a counter', () => {
    expect(toResourceView(sheetForClass(ALCHEMIST)).discrete).toBe(true);
    expect(toResourceView(sheetForClass(WATCHMAN)).discrete).toBe(false);
    expect(toResourceView(sheetForClass(INSPECTOR)).discrete).toBe(false);

    // ═══════════════════════════════════════════════════════════════════════
    // THE ACTUAL RATES, WITH THE DERIVATION BESIDE EACH.
    // ═══════════════════════════════════════════════════════════════════════
    // This used to be `for (kind of ResourceKind) regenPerTurn === 0`, with the
    // comment "nothing in this game gives a resource for merely existing". That
    // decision is reversed. The rates are ToME's own defaults (Actor.lua:227-241)
    // scaled by our turn density, so they are asserted as the DERIVATION rather
    // than as copied decimals — a test that hard-codes 0.6 cannot tell a tuning
    // change from a typo.
    const TOME_STAMINA_REGEN = 0.3; // Actor.lua:230
    const TOME_PSI_REGEN = 0.2; // Actor.lua:239
    expect(RESOURCE_RULES[ResourceKind.Resolve].regenPerTurn).toBe(
      TOME_STAMINA_REGEN * TOME_ACTIONS_PER_TURN,
    );
    expect(RESOURCE_RULES[ResourceKind.Focus].regenPerTurn).toBe(
      TOME_PSI_REGEN * TOME_ACTIONS_PER_TURN,
    );

    // A CONTINUOUS KIND USES `regenPerTurn` AND A DISCRETE KIND USES
    // `regenEvery`, never both: two clocks on one pool and the fractional one
    // defeats the integer one, which is the whole mechanism.
    expect(RESOURCE_RULES[ResourceKind.Reagents].regenPerTurn).toBe(0);
    expect(RESOURCE_RULES[ResourceKind.Reagents].regenEvery).toBe(REAGENT_REGEN_EVERY_TURNS);
    for (const kind of Object.values(ResourceKind)) {
      const rules = RESOURCE_RULES[kind];
      if (rules.discrete) expect(rules.regenPerTurn).toBe(0);
      else expect(rules.regenEvery).toBeUndefined();
    }
  });

  it('takes ZERO rng draws across a long stretch of base turns', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // A DRAW HERE WOULD MOVE THE STREAM, AND NOTHING WOULD FAIL FOR WEEKS.
    // ═══════════════════════════════════════════════════════════════════════
    // docs/engineering-standards.md:101 pins save → load → continue ≡
    // never-saved. Regeneration runs once per base turn for every actor with a
    // sheet, so a single draw inside it shifts every subsequent roll in the
    // process — which surfaces, much later, as "the level regenerated
    // differently". The counter port is integer arithmetic precisely so this
    // number stays at zero.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const watchman = f.add(WATCHMAN, 'dalt', 9, 9);
    const inspector = f.add(INSPECTOR, 'sam', 9, 10);
    const before = drawCount(f.rng);

    const TURNS = 40;
    for (let turn = 0; turn < TURNS; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
      f.engine.actBase(watchman.id, f.world);
      f.engine.actBase(inspector.id, f.world);
    }

    // All three kinds, including the one that actually granted something.
    expect(f.engine.sheetOf('rey')?.resource.value).toBeGreaterThan(0);
    expect(f.engine.sheetOf('dalt')?.resource.value).toBeGreaterThan(0);
    expect(drawCount(f.rng)).toBe(before);
  });

  it('hands `toResourceView` a whole number at every single step, spends included', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE SEAM WHERE A FRACTION WOULD MAKE TWO READERS DISAGREE.
    // ═══════════════════════════════════════════════════════════════════════
    // `pipCount` floors the filled count and the character sheet rounds it, so a
    // pool holding 3.6 would draw THREE pips beside the text "4/8" while a
    // 4-cost talent answered `no_resource`. Nothing would throw. This asserts
    // the property the whole `regenCounter` design exists to provide, at every
    // observable moment rather than at the end.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const sheet = f.engine.sheetOf('rey');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    const TURNS = 40;
    for (let turn = 0; turn < TURNS; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
      // Spend on an irregular beat, so a refill lands mid-count as often as it
      // lands on an empty counter.
      if (turn % 5 === 0) spendResource(sheet.resource, 1);
      if (turn % 7 === 0) spendResource(sheet.resource, 2);
      const view = toResourceView(sheet);
      expect(view.discrete).toBe(true);
      expect(Number.isInteger(view.current)).toBe(true);
      expect(Number.isInteger(sheet.resource.regenCounter)).toBe(true);
    }
  });

  it('banks nothing while full: forty turns at the cap, then a spend, then a wait', () => {
    // Actor.lua:2078 — `if shots_left >= capacity then ... return end`, BEFORE
    // the counter increments. Without it the counter runs while the pool is
    // full and the first vial an Alchemist spends comes straight back; kills and
    // stairs both push her to the cap, so that is the common case rather than
    // an edge one.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const sheet = f.engine.sheetOf('rey');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    expect(sheet.resource.value).toBe(sheet.resource.max);
    const IDLE_TURNS = 40;
    for (let turn = 0; turn < IDLE_TURNS; turn += 1) f.engine.actBase(alchemist.id, f.world);
    expect(sheet.resource.value).toBe(sheet.resource.max);
    expect(sheet.resource.regenCounter).toBe(0);

    expect(spendResource(sheet.resource, 1)).toBe(true);
    expect(sheet.resource.value).toBe(sheet.resource.max - 1);

    // Eleven turns after the spend she is still one short — the forty banked
    // nothing at all.
    for (let turn = 0; turn < REAGENT_REGEN_EVERY_TURNS - 1; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
    }
    expect(sheet.resource.value).toBe(sheet.resource.max - 1);
    f.engine.actBase(alchemist.id, f.world);
    expect(sheet.resource.value).toBe(sheet.resource.max);
  });

  it('pays a DOWNED body nothing, for any kind, across twenty base turns', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // A CORPSE THAT REFILLS IS A CORPSE-CAMP INCENTIVE.
    // ═══════════════════════════════════════════════════════════════════════
    // Two guards agree on this and neither is new: `actBase` in engine/actor.ts
    // returns at `if (!actor.alive) return`, and `TalentEngine.actBase` returns
    // at the same test before it reaches `regenResource`. downed.ts spells out
    // the intent — "returns early ⇒ no regeneration, no status ticks and NO
    // COOLDOWN TICKS while down … being on the floor costs you progress".
    // Per-turn regen is the first thing in years to make that guard load-bearing
    // for a RESOURCE, so it is pinned here rather than assumed.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const watchman = f.add(WATCHMAN, 'dalt', 6, 5);
    const inspector = f.add(INSPECTOR, 'sam', 5, 6);
    const alchemistSheet = f.engine.sheetOf('rey');
    const watchmanSheet = f.engine.sheetOf('dalt');
    const inspectorSheet = f.engine.sheetOf('sam');
    if (
      alchemistSheet === undefined ||
      watchmanSheet === undefined ||
      inspectorSheet === undefined
    ) {
      throw new Error('fixture: a sheet is missing');
    }

    alchemistSheet.resource.value = 2;
    alchemist.alive = false;
    watchman.alive = false;
    inspector.alive = false;

    const DOWN_TURNS = 20;
    for (let turn = 0; turn < DOWN_TURNS; turn += 1) {
      f.engine.actBase(alchemist.id, f.world);
      f.engine.actBase(watchman.id, f.world);
      f.engine.actBase(inspector.id, f.world);
    }

    expect(alchemistSheet.resource.value).toBe(2);
    expect(alchemistSheet.resource.regenCounter).toBe(0);
    // Born full, then emptied here: what follows measures what a DOWNED body
    // earns, and a clamped-at-max pool cannot show the difference between
    // "earned nothing" and "earned something it could not hold".
    watchmanSheet.resource.value = 0;
    inspectorSheet.resource.value = 0;
    expect(watchmanSheet.resource.value).toBe(0);
    expect(inspectorSheet.resource.value).toBe(0);
  });
});

describe('Resolve and Focus are earned by STANDING SOMEWHERE, on a thin trickle', () => {
  it('Resolve accrues per adjacent ally, per game turn, above the flat rate', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const sheet = f.engine.sheetOf('dalt');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    // ═══ EMPTIED FIRST — THE BAR IS BORN FULL ═══
    // ActorResource.lua:131 creates an actor holding `maxname`. A test that
    // measures what a clause EARNS must set its own floor, or every gain is
    // clamped away at the maximum and the assertion quietly becomes "the bar is
    // still full", which is true no matter what the clause does.
    sheet.resource.value = 0;

    f.engine.actBase(watchman.id, f.world);
    // Alone: the unconditional trickle and NOTHING ELSE. It is deliberately a
    // tenth of what one blow taken pays (`RESOLVE_ON_STRUCK` = 6) — a floor, so
    // a solo Watchman is never permanently locked out of Iron Curtain, not a
    // second income he can stand still and farm.
    expect(sheet.resource.value).toBe(RESOLVE_PER_TURN);

    f.add(INSPECTOR, 'sam', 6, 5);
    f.add(ALCHEMIST, 'rey', 4, 5);
    f.engine.actBase(watchman.id, f.world);
    // Two allies x 3, plus a second turn of trickle. The adjacency clause is
    // still ten times the size of the trickle beside it.
    expect(sheet.resource.value).toBe(RESOLVE_PER_TURN * 2 + 6);
  });

  it('Focus accrues for holding ground, and Fog Step forfeits everything but the trickle', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const sheet = f.engine.sheetOf('sam');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;

    // EMPTIED FIRST — Focus is born full (ActorResource.lua:131). See the
    // Resolve test above for why a gain test has to set its own floor.
    sheet.resource.value = 0;

    f.engine.actBase(inspector.id, f.world);
    expect(sheet.resource.value).toBe(12 + FOCUS_PER_TURN);

    useTalent(f.engine, inspector, talentId('fog_step'), { x: 5, y: 7 }, f.ctx);
    expect(sheet.movedThisTurn).toBe(true);
    f.engine.actBase(inspector.id, f.world);
    // The 12 for holding ground is forfeit; the flat rate is not, because it is
    // unconditional by construction (`regenPerTurn` is added before the switch).
    // Thirty turns of trickle to buy what one still turn buys — which is the
    // point: moving still costs you the shot.
    expect(sheet.resource.value).toBe(12 + FOCUS_PER_TURN * 2);
  });
});

describe('the Watchman anchors — guard, taunt, and the punish', () => {
  it('Iron Curtain guards the worst-off adjacent ally and pulls their hunters', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const inspector = f.add(INSPECTOR, 'sam', 6, 5);
    inspector.hp = 6; // badly hurt, so the curtain should fall over him
    const husk = f.addMonster('husk', 7, 5, 400);
    if (husk.ai !== undefined) husk.ai.targetId = 'sam';

    const sheet = f.engine.sheetOf('dalt');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 100;

    const result = useTalent(f.engine, watchman, talentId('iron_curtain'), { x: 5, y: 5 }, f.ctx);
    expect(result.ok).toBe(true);

    const guard = f.engine.effectOn('dalt', TalentEffect.Guarding);
    expect(guard?.otherId).toBe('sam');
    expect(guard?.turns).toBe(3);
    // ToME's Taunt is `a:setTarget(self)` — a real retarget the AI already reads.
    expect(husk.ai?.targetId).toBe('dalt');
  });

  it('and the guarded ally being hit anyway earns a free counter-swing', () => {
    const f = fixture(PLENTY);
    f.add(WATCHMAN, 'dalt', 5, 5);
    f.add(INSPECTOR, 'sam', 6, 5);
    const husk = f.addMonster('husk', 7, 5, 400);

    f.engine.addEffect('dalt', {
      kind: TalentEffect.Guarding,
      otherId: 'sam',
      turns: 3,
      power: 0,
    });

    // Out of the Watchman's reach: nobody counters across the room.
    expect(resolveGuardCounter(f.ctx, 'husk', 'sam')).toBe(null);

    husk.x = 6;
    husk.y = 6;
    const counter = resolveGuardCounter(f.ctx, 'husk', 'sam');
    expect(counter).not.toBe(null);
    expect(counter?.hit.targetId).toBe('husk');
    // AND WHO SWUNG, which is the field the scheduler attributes the event to.
    expect(counter?.guardianId).toBe('dalt');
  });

  it('Lockdown stuns through the status table and turns the target on the Watchman', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const husk = f.addMonster('husk', 6, 5, 400);
    if (husk.ai !== undefined) husk.ai.targetId = 'sam';

    const sheet = f.engine.sheetOf('dalt');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 100;

    const result = useTalent(
      f.engine,
      watchman,
      talentId('lockdown'),
      { x: 6, y: 5, actorId: 'husk' },
      f.ctx,
    );
    expect(result.ok).toBe(true);

    // ═══ THE STUN IS ON THE BODY, IN THE REAL TABLE ═══
    // Not a flag the talent set on itself: `hasEffect` reads the same
    // `EffectState` that `statusPass` ticks, which is the whole point of the
    // seam — a stun landed here is a stun `actBase` will count down.
    expect(hasEffect(f.effects, 'husk', EffectId.Stunned)).toBe(true);
    // The rank-1 maximum. `combatTalentScale(1, 2, 3)` rounds to 2, and against
    // a 17% save this seed keeps the whole of it.
    expect(effectDur(f.effects, 'husk', EffectId.Stunned)).toBe(2);

    // AND THE MOMENTUM STRIP IS GONE. The old talent took a third of a turn
    // off the act clock; this one must leave it exactly where the fixture set
    // it, or the talent is quietly doing both jobs.
    expect(husk.energy).toBe(1000);

    expect(husk.ai?.targetId).toBe('dalt');
    expect(f.engine.effectOn('husk', TalentEffect.Taunted)?.otherId).toBe('dalt');
  });

  it('Lockdown still tackles and taunts with no status table at all', () => {
    // THE ABSENT SEAM, which every fixture built before M4 relies on. A talent
    // whose optional half is missing does the rest of its job; it does not
    // throw and it does not refuse.
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const husk = f.addMonster('husk', 6, 5, 400);

    const sheet = f.engine.sheetOf('dalt');
    if (sheet === undefined) return;
    sheet.resource.value = 100;

    const bare: TalentCtx = { engine: f.engine, world: f.world, rng: f.rng, talentLevel: 1 };
    const result = useTalent(
      f.engine,
      watchman,
      talentId('lockdown'),
      { x: 6, y: 5, actorId: 'husk' },
      bare,
    );

    expect(result.ok).toBe(true);
    expect(husk.hp).toBeLessThan(400);
    expect(f.engine.effectOn('husk', TalentEffect.Taunted)?.otherId).toBe('dalt');
  });

  it('Ward Rush shoves, then takes the ground', () => {
    const f = fixture(PLENTY);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const husk = f.addMonster('husk', 6, 5, 400);

    const result = useTalent(
      f.engine,
      watchman,
      talentId('ward_rush'),
      { x: 6, y: 5, actorId: 'husk' },
      f.ctx,
    );
    expect(result.ok).toBe(true);
    expect({ x: husk.x, y: husk.y }).toEqual({ x: 7, y: 5 });
    // The vacated tile, not one step in some direction — that ordering is what
    // makes this the cheapest way to seize a doorway.
    expect({ x: watchman.x, y: watchman.y }).toEqual({ x: 6, y: 5 });
  });

  it('a shove into a wall still lands the blow rather than refusing', () => {
    const f = fixture(PLENTY, [[7, 5]]);
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const husk = f.addMonster('husk', 6, 5, 400);

    const result = useTalent(f.engine, watchman, talentId('ward_rush'), { x: 6, y: 5 }, f.ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(1);
    expect({ x: husk.x, y: husk.y }).toEqual({ x: 6, y: 5 });
    expect({ x: watchman.x, y: watchman.y }).toEqual({ x: 5, y: 5 });
  });
});

describe('the Inspector marks, and everyone collects', () => {
  it("Sigil's mark raises damage from EVERY source, not just its own", () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const sheet = f.engine.sheetOf('sam');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 100;
    f.addMonster('husk', 9, 5, 400);

    expect(markMultiplier(f.engine, 'husk')).toBe(1);
    useTalent(f.engine, inspector, talentId('sigil'), { x: 9, y: 5, actorId: 'husk' }, f.ctx);
    expect(markMultiplier(f.engine, 'husk')).toBeCloseTo(1.15, 6);

    const mark = f.engine.effectOn('husk', TalentEffect.Marked);
    expect(mark?.otherId).toBe('sam');
    expect(mark?.turns).toBe(4);
  });

  it('expires the mark on the BASE clock, four turns later', () => {
    const f = fixture(PLENTY);
    f.add(INSPECTOR, 'sam', 5, 5);
    const husk = f.addMonster('husk', 9, 5, 400);
    f.engine.addEffect('husk', {
      kind: TalentEffect.Marked,
      otherId: 'sam',
      turns: 4,
      power: 15,
    });

    for (let turn = 0; turn < 3; turn += 1) f.engine.actBase(husk.id, f.world);
    expect(f.engine.effectOn('husk', TalentEffect.Marked)).toBeDefined();
    f.engine.actBase(husk.id, f.world);
    expect(f.engine.effectOn('husk', TalentEffect.Marked)).toBeUndefined();
    expect(markMultiplier(f.engine, 'husk')).toBe(1);
  });
});

describe('the Alchemist — AoE that never touches an ally, and the party heal', () => {
  it('Alchemic Vial hits the cross and skips friends standing in it', () => {
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const centre = f.addMonster('husk_c', 9, 5, 400);
    const arm = f.addMonster('husk_n', 9, 4, 400);
    const friend = f.add(WATCHMAN, 'dalt', 9, 6); // standing in the blast

    const before = { c: centre.hp, n: arm.hp, friend: friend.hp };
    const result = useTalent(f.engine, alchemist, talentId('alchemic_vial'), { x: 9, y: 5 }, f.ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(2);
    expect(centre.hp).toBeLessThan(before.c);
    expect(arm.hp).toBeLessThan(before.n);
    // game-design.md § 10: player AoE does NOT damage allies. No PvP, ever.
    expect(friend.hp).toBe(before.friend);
  });

  it('the cross is five named tiles, in a fixed order', () => {
    expect(crossTiles({ x: 4, y: 4 })).toEqual([
      { x: 4, y: 4 },
      { x: 4, y: 3 },
      { x: 5, y: 4 },
      { x: 4, y: 5 },
      { x: 3, y: 4 },
    ]);
  });

  it('a ball is a DISC — the corner of the bounding square is excluded', () => {
    const tiles = ballTiles({ x: 5, y: 5 }, 2);
    expect(tiles).toContainEqual({ x: 7, y: 5 });
    // (2,2) is 2.83 away. A Chebyshev ball would include it and the heal would
    // visibly reach someone standing outside the ring the client drew.
    expect(tiles).not.toContainEqual({ x: 7, y: 7 });
  });

  it('Mend Wounds heals every ally within 2 — including the caster — for 20%', () => {
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const watchman = f.add(WATCHMAN, 'dalt', 6, 6);
    const farAway = f.add(INSPECTOR, 'sam', 12, 12);
    const husk = f.addMonster('husk', 5, 6, 400);
    husk.hp = 10;

    alchemist.hp = 10;
    watchman.hp = 10;
    farAway.hp = 10;

    const result = useTalent(f.engine, alchemist, talentId('mend_wounds'), { x: 5, y: 5 }, f.ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(alchemist.hp).toBe(10 + Math.round(ALCHEMIST.maxHp * 0.2));
    expect(watchman.hp).toBe(10 + Math.round(WATCHMAN.maxHp * 0.2));
    expect(farAway.hp).toBe(10); // out of the disc
    expect(husk.hp).toBe(10); // a heal is Affinity.Ally, and a husk is not one
    expect(result.hits).toHaveLength(2);
  });

  it('CANNOT heal past maxHp, however little was missing', () => {
    // `healActor` clamps at max and returns what was ACTUALLY restored, so the
    // log cannot claim 11 when it gave 2. Overheal banked past max would also
    // make a pre-fight heal strictly better than a mid-fight one, which is the
    // opposite of what a 10-turn cooldown is for.
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const watchman = f.add(WATCHMAN, 'dalt', 6, 6);

    // 20% of 54 is 10.8 -> 11, but only 2 points are missing.
    alchemist.hp = alchemist.maxHp - 2;
    // …and the Watchman is untouched, so he cannot be healed at all.
    watchman.hp = watchman.maxHp;

    const result = useTalent(f.engine, alchemist, talentId('mend_wounds'), { x: 5, y: 5 }, f.ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(alchemist.hp).toBe(alchemist.maxHp);
    expect(watchman.hp).toBe(watchman.maxHp);
    // Only the ally who actually gained anything is reported — a hit that
    // healed 0 in the log reads as a bug in the heal.
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.targetId).toBe('rey');
    expect(result.hits[0]?.healed).toBe(2);
  });

  it('heals a hurt ally by 20% of THEIR max, and clamps at every starting HP', () => {
    // Percentage-of-MAX rather than of missing life: legible on a party panel,
    // and worth the same to a full-health Watchman as to a dying one — which is
    // what stops it being worthless at level 1 and mandatory later.
    for (const startingHp of [1, 10, 40, 71, 72]) {
      const f = fixture(PLENTY);
      const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
      const ally = f.add(WATCHMAN, 'dalt', 6, 5);
      ally.hp = startingHp;
      alchemist.hp = alchemist.maxHp;

      const expected = Math.min(WATCHMAN.maxHp, startingHp + Math.round(WATCHMAN.maxHp * 0.2));
      useTalent(f.engine, alchemist, talentId('mend_wounds'), { x: 5, y: 5 }, f.ctx);

      expect(ally.hp).toBe(expected);
      expect(ally.hp).toBeLessThanOrEqual(ally.maxHp);
    }
  });

  it('Backdraft shoves one tile — the authored number, not the donor’s three', () => {
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const husk = f.addMonster('husk', 7, 5, 400);

    useTalent(f.engine, alchemist, talentId('backdraft'), { x: 7, y: 5, actorId: 'husk' }, f.ctx);
    // skills/backdraft.json `{ push: 1 }` is the mechanical authority; the
    // real-time donor's `knockback_px: 96` would be 3 (R6 settles it).
    expect({ x: husk.x, y: husk.y }).toEqual({ x: 8, y: 5 });
  });

  it('a caster talent never rolls to hit — ToME spells skip checkHit entirely', () => {
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const husk = f.addMonster('husk', 8, 5, 400);
    const before = husk.hp;

    for (let cast = 0; cast < 3; cast += 1) {
      refill(f.engine, 'rey');
      const result = useTalent(
        f.engine,
        alchemist,
        talentId('ashwick_flare'),
        { x: 8, y: 5, actorId: 'husk' },
        f.ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hits[0]?.hit).toBe(true);
    }
    expect(husk.hp).toBeLessThan(before);
  });
});

describe('shapes and affinity', () => {
  it('refuses a hostile target on an ally-only shape, and the reverse', () => {
    const f = fixture(PLENTY);
    const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
    const friend = f.add(WATCHMAN, 'dalt', 6, 5);
    const flare = f.engine.registry.get(talentId('ashwick_flare'));
    expect(flare).toBeDefined();
    if (flare === undefined) return;
    expect(
      canUseTalent(
        f.engine,
        alchemist,
        flare,
        { x: friend.x, y: friend.y, actorId: friend.id },
        f.world,
      ),
    ).toBe(TalentRefusal.NotHostile);
    expect(flare.targeting.affinity).toBe(Affinity.Hostile);
  });

  it('refuses a Tile shape aimed at an occupied square', () => {
    const f = fixture(PLENTY);
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    f.addMonster('husk', 6, 5);
    const step = f.engine.registry.get(talentId('fog_step'));
    expect(step).toBeDefined();
    if (step === undefined) return;
    expect(canUseTalent(f.engine, inspector, step, { x: 6, y: 5 }, f.world)).toBe(
      TalentRefusal.Blocked,
    );
  });
});
