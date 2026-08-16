import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import {
  TalentEffect,
  TalentRefusal,
  canUseTalent,
  effectiveTalentRange,
  getTalentLevel,
  resolveGuardCounter,
  talentId,
  useTalent,
} from '../../src/server/engine/talents.ts';
import { ENERGY_TO_ACT } from '../../src/shared/version.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';
import type {
  TalentActor,
  TalentCtx,
  TalentEngine,
  TalentUseResult,
  TalentWorld,
} from '../../src/server/engine/talents.ts';
import type { Dir } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ===========================================================================
 * THE HONESTY GATE. A TALENT LEVEL THAT CHANGES NOTHING IS FORBIDDEN HERE.
 * ===========================================================================
 *
 * A talent tree that shows a rank which moves no number is worse than no tree:
 * it is a UI that lies, and it lies in the one place a player is being asked to
 * spend something scarce. This file is what makes that a rule rather than a
 * promise.
 *
 * WHAT IS PINNED, AND WHY EACH:
 *
 *  1. STRICTLY INCREASING, ALL TWELVE, TABLE-DRIVEN. Each talent is resolved on
 *     a FRESH fixture with a RE-SEEDED script at level 1 and again at level 5,
 *     and the one number its rank is supposed to move must go UP. A thirteenth
 *     talent added without a curve fails here, by construction, rather than
 *     being noticed in a playtest six weeks later.
 *  2. THE LOW END. Every curve's `low` is EXACTLY the constant the talent
 *     shipped with, so `combatTalentScale(1, low, high) === low` and level 1 is
 *     unchanged to the bit. That is pinned twice over: the level-1 assertions in
 *     test/server/talents.test.ts were all written against the flat constants
 *     and still pass untouched, and `describe(self, 1)` below must still render
 *     each authored number verbatim.
 *  3. FOG STEP'S RANGE, on both sides of the wire's problem. It is the only
 *     talent whose rank buys distance, so it is the only one where a
 *     client/server disagreement about "can I click there" is possible.
 *  4. THE FROZEN NUMBERS DO NOT MOVE. Each of them has an argument in its own
 *     file; this is the test that catches somebody scaling one anyway.
 *  5. `describe` DIFFERS BETWEEN CONSECUTIVE RANKS. It had ZERO callers before
 *     the panel, so all twelve strings were unverified — this is their first
 *     exercise, and it is also the check that the tooltip a player reads is not
 *     the one place the level went missing.
 *  6. THE GUARD COUNTER RIDES ON THE EFFECT INSTANCE. `GUARD_COUNTER_MULT` used
 *     to be a constant in engine/talents.ts; it is now snapshot onto the
 *     `Guarding` effect's `power` at cast time, which is the only channel by
 *     which a talent's numbers can reach a counter the scheduler triggers
 *     without engine/talents.ts learning the string `talent:iron_curtain`.
 */

const W = 16;

function openLevel(): LevelView {
  return { w: W, h: W, tiles: new Array<number>(W * W).fill(TileCode.FLOOR) };
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

/**
 * EVERY DRAW ANSWERS 50, AND THE SAME SCRIPT IS REBUILT FOR EVERY RUN.
 *
 * `scriptedRng` ignores the bounds and hands back the written-down number, so
 * 50 is: a to-hit roll that lands (hit chance sits well above 50 for a player
 * against a husk), a mid damage-range roll, and a crit roll that does NOT crit
 * (crit chance is single digits). That makes the ONLY difference between a
 * level-1 run and a level-5 run the multiplier under test — which is the entire
 * point of re-seeding rather than reusing one generator across both.
 *
 * 50 rather than talents.test.ts's 1: a damage roll of literally 1 collapses
 * every multiplier into the same rounded integer, and a test that cannot see
 * the difference it exists to measure passes for the wrong reason.
 */
const ROLL = 50;
function freshRolls(): number[] {
  return new Array<number>(128).fill(ROLL);
}

type Fixture = {
  readonly world: TalentWorld;
  readonly engine: TalentEngine;
  readonly ctx: TalentCtx;
  add(definition: ClassDef, id: string, x: number, y: number): TalentActor;
  addMonster(id: string, x: number, y: number, hp?: number): TalentActor;
  /** Buy this talent up to `level` — the spend path's effect, without the path. */
  setLevel(actorId: string, bare: string, level: number): void;
  /** Full AP, full MP, full resource. Stands in for the once-a-turn refill. */
  refill(actorId: string): void;
};

/**
 * The same minimal `TalentWorld` test/server/talents.test.ts builds, for the
 * same reason: a body has to stand on an exact tile, and `createWorld` puts it
 * wherever the spawn cluster had room.
 */
function fixture(): Fixture {
  const level = openLevel();
  const actors: TalentActor[] = [];
  const rng = scriptedRng(freshRolls());

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
      if (actors.some((a) => a.alive && a.x === nx && a.y === ny)) {
        return { ok: false, reason: 'occupied' };
      }
      actor.x = nx;
      actor.y = ny;
      return { ok: true, x: nx, y: ny };
    },
  };

  const engine = createContentTalentEngine();
  // `talentLevel` here is only ever read by the direct-call helpers
  // (`resolveGuardCounter`); `useTalent` computes its own from the caster's
  // sheet and overwrites it.
  const ctx: TalentCtx = { engine, world, rng, talentLevel: 1 };

  return {
    world,
    engine,
    ctx,
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
    addMonster: (id, x, y, hp = 4000) => {
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
    setLevel: (actorId, bare, level) => {
      const sheet = engine.sheetOf(actorId);
      if (sheet === undefined) throw new Error(`no sheet for ${actorId}`);
      sheet.points.set(talentId(bare), level);
    },
    refill: (actorId) => {
      const sheet = engine.sheetOf(actorId);
      if (sheet === undefined) throw new Error(`no sheet for ${actorId}`);
      sheet.ap = sheet.maxAp;
      sheet.mp = sheet.maxMp;
      sheet.resource.value = sheet.resource.max;
    },
  };
}

/** Total damage a cast dealt. A refusal is 0, which fails the increase check. */
function damageOf(result: TalentUseResult): number {
  return result.ok ? result.hits.reduce((sum, hit) => sum + hit.damage, 0) : 0;
}

/** Total HP a cast restored. */
function healingOf(result: TalentUseResult): number {
  return result.ok ? result.hits.reduce((sum, hit) => sum + hit.healed, 0) : 0;
}

/** One resolved cast, plus the number the talent's rank is supposed to move. */
type Cast = {
  readonly observed: number;
  readonly result: TalentUseResult;
  readonly fixture: Fixture;
};

type ScalingCase = {
  /** Bare id, for the message and for `setLevel`. */
  readonly bare: string;
  /** What its rank moves, in a player's words. Printed on failure. */
  readonly moves: string;
  /**
   * The authored constant as `describe(self, 1)` must still render it. This is
   * the LOW end of the un-collapse, pinned through the shipped rendering path
   * rather than against a private module constant.
   */
  readonly authored: string;
  readonly cast: (level: number) => Cast;
};

// ---------------------------------------------------------------------------
// The twelve, each on a fresh board
// ---------------------------------------------------------------------------

/** A single-target cast against one very fat husk. The commonest shape. */
function singleTargetCase(
  bare: string,
  definition: ClassDef,
  moves: string,
  authored: string,
  targetOffset: number,
): ScalingCase {
  return {
    bare,
    moves,
    authored,
    cast: (level) => {
      const f = fixture();
      const caster = f.add(definition, 'caster', 5, 5);
      const husk = f.addMonster('husk', 5 + targetOffset, 5);
      f.setLevel('caster', bare, level);
      f.refill('caster');
      const result = useTalent(
        f.engine,
        caster,
        talentId(bare),
        { x: husk.x, y: husk.y, actorId: husk.id },
        f.ctx,
      );
      return { observed: damageOf(result), result, fixture: f };
    },
  };
}

const CASES: readonly ScalingCase[] = [
  singleTargetCase('crude_blow', WATCHMAN, 'damage dealt', '100%', 1),
  singleTargetCase('ward_rush', WATCHMAN, 'damage dealt', '80%', 1),
  singleTargetCase('lockdown', WATCHMAN, 'damage dealt', '100%', 1),
  singleTargetCase('revolver_shot', INSPECTOR, 'damage dealt', '90%', 4),
  singleTargetCase('snipers_mark', INSPECTOR, 'damage dealt', '165%', 4),
  singleTargetCase('ashwick_flare', ALCHEMIST, 'damage dealt', '130%', 4),
  singleTargetCase('backdraft', ALCHEMIST, 'damage dealt', '130%', 2),

  {
    // A Self shape: the curtain falls over the worst-off adjacent ally and the
    // blow lands on whatever is adjacent to both of them.
    bare: 'iron_curtain',
    moves: 'damage dealt to the threat between you',
    authored: '140%',
    cast: (level) => {
      const f = fixture();
      const watchman = f.add(WATCHMAN, 'caster', 5, 5);
      const ally = f.add(INSPECTOR, 'sam', 4, 5);
      ally.hp = 6; // worst off, so the curtain picks him rather than the caster
      const husk = f.addMonster('husk', 6, 5);
      if (husk.ai !== undefined) husk.ai.targetId = 'sam';
      f.setLevel('caster', 'iron_curtain', level);
      f.refill('caster');
      const result = useTalent(f.engine, watchman, talentId('iron_curtain'), { x: 5, y: 5 }, f.ctx);
      return { observed: damageOf(result), result, fixture: f };
    },
  },
  {
    // The AoE. One body in the cross, so the number under test is per-target
    // damage rather than a headcount that could hide a flat multiplier.
    bare: 'alchemic_vial',
    moves: 'damage dealt per target',
    authored: '95%',
    cast: (level) => {
      const f = fixture();
      const alchemist = f.add(ALCHEMIST, 'caster', 5, 5);
      f.addMonster('husk', 9, 5);
      f.setLevel('caster', 'alchemic_vial', level);
      f.refill('caster');
      const result = useTalent(
        f.engine,
        alchemist,
        talentId('alchemic_vial'),
        { x: 9, y: 5 },
        f.ctx,
      );
      return { observed: damageOf(result), result, fixture: f };
    },
  },
  {
    // The heal. Its rank moves HP restored, not damage.
    bare: 'mend_wounds',
    moves: 'HP restored',
    authored: '20%',
    cast: (level) => {
      const f = fixture();
      const alchemist = f.add(ALCHEMIST, 'caster', 5, 5);
      alchemist.hp = 1; // room for every rank's heal, so nothing clamps
      f.setLevel('caster', 'mend_wounds', level);
      f.refill('caster');
      const result = useTalent(f.engine, alchemist, talentId('mend_wounds'), { x: 5, y: 5 }, f.ctx);
      return { observed: healingOf(result), result, fixture: f };
    },
  },
  {
    // The mark. Its rank moves the POWER snapshot onto the effect — the number
    // every other source in the room collects, not the caster's own round.
    bare: 'sigil',
    moves: 'mark power',
    authored: '+15%',
    cast: (level) => {
      const f = fixture();
      const inspector = f.add(INSPECTOR, 'caster', 5, 5);
      f.addMonster('husk', 9, 5);
      f.setLevel('caster', 'sigil', level);
      f.refill('caster');
      const result = useTalent(
        f.engine,
        inspector,
        talentId('sigil'),
        { x: 9, y: 5, actorId: 'husk' },
        f.ctx,
      );
      const mark = f.engine.effectOn('husk', TalentEffect.Marked);
      return { observed: mark?.power ?? 0, result, fixture: f };
    },
  },
  {
    // The escape. Its rank moves RANGE, and "range reached" is measured through
    // the real predicate rather than off the constant — the farthest tile
    // `canUseTalent` will actually accept.
    bare: 'fog_step',
    moves: 'tiles reached',
    authored: '3 tiles',
    cast: (level) => {
      const f = fixture();
      const inspector = f.add(INSPECTOR, 'caster', 5, 5);
      f.setLevel('caster', 'fog_step', level);
      f.refill('caster');
      const step = f.engine.registry.get(talentId('fog_step'));
      if (step === undefined) throw new Error('fog_step is not registered');

      let reach = 0;
      for (let d = 1; d + 5 < W; d += 1) {
        if (canUseTalent(f.engine, inspector, step, { x: 5 + d, y: 5 }, f.world) !== null) break;
        reach = d;
      }

      const result = useTalent(
        f.engine,
        inspector,
        talentId('fog_step'),
        { x: 5 + reach, y: 5 },
        f.ctx,
      );
      // …and the walk actually got there, so "reach" is not a number the
      // predicate agreed to and the mover then declined.
      expect({ x: inspector.x, y: inspector.y }).toEqual({ x: 5 + reach, y: 5 });
      return { observed: reach, result, fixture: f };
    },
  },
];

describe('every talent level moves a number — the honesty gate', () => {
  it('covers all twelve, with no talent quietly left off the table', () => {
    // Iterated from the REGISTRY, so a talent that exists and is not measured
    // here fails rather than being invisible to a table somebody forgot to
    // extend. This is the check that makes the rest of the file complete.
    const engine = createContentTalentEngine();
    const registered = engine.registry.all().map((talent) => talent.id);
    expect(registered).toHaveLength(12);
    expect([...CASES.map((entry) => talentId(entry.bare))].sort()).toEqual([...registered].sort());
  });

  it.each(CASES)('$bare: rank 5 STRICTLY beats rank 1 on $moves', (entry) => {
    const low = entry.cast(1);
    const high = entry.cast(TALENT_MAX_LEVEL);

    expect(low.result.ok).toBe(true);
    expect(high.result.ok).toBe(true);

    // Compared as an object so a failure names the talent, what it was supposed
    // to move, and both numbers — rather than "expected 14 to be greater than
    // 14" with no clue which of twelve it was.
    //
    // `rank1 > 0` first: without it, "it went up" would also be satisfied by a
    // talent that refused at rank 1 and dealt 1 damage at rank 5.
    //
    // STRICTLY. Not `>=` — a rank that moves nothing observable is the exact
    // thing this file exists to forbid, and `>=` passes for all twelve.
    expect({
      talent: entry.bare,
      moves: entry.moves,
      rank1: low.observed,
      rank5: high.observed,
      doesSomethingAtRank1: low.observed > 0,
      grows: high.observed > low.observed,
    }).toEqual({
      talent: entry.bare,
      moves: entry.moves,
      rank1: low.observed,
      rank5: high.observed,
      doesSomethingAtRank1: true,
      grows: true,
    });
  });

  it.each(CASES)('$bare: level 1 still renders its authored constant, $authored', (entry) => {
    const f = fixture();
    const actor = f.add(WATCHMAN, 'reader', 5, 5);
    const talent = f.engine.registry.get(talentId(entry.bare));
    expect(talent).toBeDefined();
    if (talent === undefined) return;

    // THE LOW END OF THE UN-COLLAPSE, pinned through the shipped rendering path.
    // `combatTalentScale(1, low, high)` returns `low` exactly (scale.ts:182-208),
    // so a curve whose `low` drifted off the authored number shows up here as a
    // tooltip that no longer says what the JSON says.
    expect(talent.describe(actor, 1)).toContain(entry.authored);
  });

  it.each(CASES)('$bare: describe() differs at every consecutive rank', (entry) => {
    const f = fixture();
    const actor = f.add(WATCHMAN, 'reader', 5, 5);
    const talent = f.engine.registry.get(talentId(entry.bare));
    expect(talent).toBeDefined();
    if (talent === undefined) return;

    // The panel's current→next diff (LevelupDialog.lua:963-970) is these two
    // strings side by side. If they are equal, the player is being shown a
    // purchase that changes nothing — which is true of the NUMBER as well,
    // because both strings come from the same helper the body calls.
    for (let level = 1; level < TALENT_MAX_LEVEL; level += 1) {
      expect({ level, text: talent.describe(actor, level) }).not.toEqual({
        level,
        text: talent.describe(actor, level + 1),
      });
    }
  });
});

describe('FOG STEP — the one talent whose rank buys distance', () => {
  it('reaches exactly 3, 4, 5, 6, 7 tiles at ranks 1 through 5', () => {
    // `Math.floor(combatTalentLimit(t, 10, 3, 7))` — mobility.lua:40-62, both
    // endpoints upstream's. Raw the curve gives 3, 4.75, 5.8, 6.5, 7; the floor
    // is what turns that into one tile per rank with NO DEAD RANK. Without it,
    // ranks 2 and 3 both read as "about five tiles" in play and the second
    // point a player spent feels stolen.
    const f = fixture();
    const step = f.engine.registry.get(talentId('fog_step'));
    expect(step).toBeDefined();
    if (step === undefined) return;

    const reach = [1, 2, 3, 4, 5].map((level) => effectiveTalentRange(step.targeting, level));
    expect(reach).toEqual([3, 4, 5, 6, 7]);

    // …and the static `range` is the rank-1 value, so anything that never
    // resolves a level reads a real number rather than a sentinel.
    expect(step.targeting.range).toBe(3);
  });

  it('REFUSES a 5-tile step at rank 1 and ALLOWS it at rank 3', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE SERVER-SIDE HALF OF THE PER-ACTOR RANGE.
    // ═══════════════════════════════════════════════════════════════════════
    // This is where a client/server disagreement would ship: the client draws
    // its ring from `LoadoutTalent.range`, and if the server kept refusing
    // against the class constant, a player at rank 3 would click a tile inside
    // her own highlighted ring and be told no — with nothing failing anywhere.
    const f = fixture();
    const inspector = f.add(INSPECTOR, 'sam', 5, 5);
    const step = f.engine.registry.get(talentId('fog_step'));
    expect(step).toBeDefined();
    if (step === undefined) return;

    f.setLevel('sam', 'fog_step', 1);
    expect(canUseTalent(f.engine, inspector, step, { x: 10, y: 5 }, f.world)).toBe(
      TalentRefusal.OutOfRange,
    );

    f.setLevel('sam', 'fog_step', 3);
    expect(canUseTalent(f.engine, inspector, step, { x: 10, y: 5 }, f.world)).toBe(null);

    // …and the tile one step beyond rank 3's reach is still refused, so the
    // widening is a widening and not the removal of the check.
    expect(canUseTalent(f.engine, inspector, step, { x: 11, y: 5 }, f.world)).toBe(
      TalentRefusal.OutOfRange,
    );
  });
});

describe('THE FROZEN NUMBERS — a rank buys damage, never a discount or a solution', () => {
  const RANKS = [1, 2, 3, 4, 5] as const;

  it('Backdraft shoves exactly one tile at every rank', () => {
    // backdraft.ts: "One tile is a lever; three is a solution." A shove that
    // grew with rank would let the Alchemist open the Inspector's three-tile
    // dead zone on demand, from range, which R6's arbitration already rejected.
    for (const level of RANKS) {
      const f = fixture();
      const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
      const husk = f.addMonster('husk', 7, 5);
      f.setLevel('rey', 'backdraft', level);
      f.refill('rey');
      useTalent(f.engine, alchemist, talentId('backdraft'), { x: 7, y: 5, actorId: 'husk' }, f.ctx);
      expect({ level, x: husk.x, y: husk.y }).toEqual({ level, x: 8, y: 5 });
    }
  });

  it('Ward Rush knocks back exactly one tile — and advances exactly one — at every rank', () => {
    for (const level of RANKS) {
      const f = fixture();
      const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
      const husk = f.addMonster('husk', 6, 5);
      f.setLevel('dalt', 'ward_rush', level);
      f.refill('dalt');
      useTalent(f.engine, watchman, talentId('ward_rush'), { x: 6, y: 5, actorId: 'husk' }, f.ctx);
      expect({ level, hx: husk.x, wx: watchman.x }).toEqual({ level, hx: 7, wx: 6 });
    }
  });

  it('Mend Wounds reaches exactly 2 tiles at every rank', () => {
    // mend_wounds.ts: the radius is the clustering tension every co-op decision
    // in the MVP is downstream of. The rank buys HOW MUCH, never HOW FAR.
    for (const level of RANKS) {
      const f = fixture();
      const alchemist = f.add(ALCHEMIST, 'rey', 5, 5);
      const near = f.add(WATCHMAN, 'dalt', 7, 5); // 2.0 — inside
      const far = f.add(INSPECTOR, 'sam', 8, 5); // 3.0 — outside
      near.hp = 1;
      far.hp = 1;
      f.setLevel('rey', 'mend_wounds', level);
      f.refill('rey');
      useTalent(f.engine, alchemist, talentId('mend_wounds'), { x: 5, y: 5 }, f.ctx);
      expect({ level, healed: near.hp > 1, spilled: far.hp > 1 }).toEqual({
        level,
        healed: true,
        spilled: false,
      });
    }
  });

  it('Lockdown strips exactly 2 of 6 AP at every rank', () => {
    // lockdown.ts: an INTEGER OUT OF SIX. Scaled to 6 it would delete a whole
    // monster turn, which is a stun — a different mechanic, with none of the
    // typed-save machinery game-design.md § 7 says a stun needs.
    const PLAYER_MAX_AP = 6;
    const AP_STRIPPED = 2;
    for (const level of RANKS) {
      const f = fixture();
      const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
      const husk = f.addMonster('husk', 6, 5);
      const before = husk.energy ?? 0;
      f.setLevel('dalt', 'lockdown', level);
      f.refill('dalt');
      useTalent(f.engine, watchman, talentId('lockdown'), { x: 6, y: 5, actorId: 'husk' }, f.ctx);
      expect(before - (husk.energy ?? 0)).toBeCloseTo(
        (ENERGY_TO_ACT * AP_STRIPPED) / PLAYER_MAX_AP,
        6,
      );
    }
  });

  it.each(CASES)('$bare: costs the same AP, MP and resource at rank 1 and rank 5', (entry) => {
    // Freezing the costs is what keeps `canUseTalent` a PURE PREDICATE OVER
    // STATIC DATA: the projector greys a hotbar slot out from the catalogue, and
    // a cost that depended on the caster's rank would mean the button the client
    // draws as affordable and the one the server accepts are two different
    // questions.
    const low = entry.cast(1);
    const high = entry.cast(TALENT_MAX_LEVEL);
    expect(low.result.ok).toBe(true);
    expect(high.result.ok).toBe(true);
    if (!low.result.ok || !high.result.ok) return;

    expect({
      ap: high.result.apSpent,
      mp: high.result.mpSpent,
      resource: high.result.resourceSpent,
      cooldown: high.result.cooldownTurns,
    }).toEqual({
      ap: low.result.apSpent,
      mp: low.result.mpSpent,
      resource: low.result.resourceSpent,
      cooldown: low.result.cooldownTurns,
    });
  });
});

describe('THE GUARD COUNTER rides on the effect instance, not on a constant', () => {
  /** Raise the curtain over `sam`, with a husk in reach of the Watchman. */
  function curtainAt(level: number): { readonly f: Fixture; readonly power: number } {
    const f = fixture();
    const watchman = f.add(WATCHMAN, 'dalt', 5, 5);
    const ally = f.add(INSPECTOR, 'sam', 4, 5);
    ally.hp = 6;
    const husk = f.addMonster('husk', 6, 5);
    if (husk.ai !== undefined) husk.ai.targetId = 'sam';
    f.setLevel('dalt', 'iron_curtain', level);
    f.refill('dalt');
    useTalent(f.engine, watchman, talentId('iron_curtain'), { x: 5, y: 5 }, f.ctx);

    const guard = f.engine.effectOn('dalt', TalentEffect.Guarding);
    expect(guard?.otherId).toBe('sam');
    return { f, power: guard?.power ?? 0 };
  }

  it('snapshots the multiplier onto Guarding.power, at the shipped 0.7 at rank 1', () => {
    // THE MOVED CONSTANT, PINNED AT BOTH ENDS. `GUARD_COUNTER_MULT = 0.7` lived
    // in engine/talents.ts until the rank landed; the low end of the curve is
    // that exact number, so the counter a rank-1 Watchman throws is the counter
    // he always threw.
    expect(curtainAt(1).power).toBeCloseTo(0.7, 6);
    expect(curtainAt(TALENT_MAX_LEVEL).power).toBeGreaterThan(curtainAt(1).power);
  });

  it('counters HARDER at rank 5 than at rank 1, through the effect and nothing else', () => {
    // `resolveGuardCounter` takes no talent id and never touches the registry —
    // engine/talents.ts must not learn the string `talent:iron_curtain` (the
    // registry-cycle rule). The effect instance is therefore the ONLY channel by
    // which Iron Curtain's rank can reach a counter the scheduler triggers, and
    // this is the test that the channel carries it.
    const damageAt = (level: number): number => {
      const { f } = curtainAt(level);
      const counter = resolveGuardCounter(f.ctx, 'husk', 'sam');
      expect(counter).not.toBe(null);
      return counter?.hit.damage ?? 0;
    };

    const low = damageAt(1);
    const high = damageAt(TALENT_MAX_LEVEL);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });
});

describe('the sheet is where a rank lives', () => {
  it('seeds every loadout talent at 1 — the four ARE the birth grant', () => {
    // warrior.lua:80-86 hands a fresh Berserker five talents outright before a
    // point is spent; `ClassDef.loadout` hands ours four. That is why
    // `pointsForLevel` drops ToME's separate 2-point birth grant (Actor.lua:171).
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const sheet = sheetForClass(definition);
      expect(sheet.points.size).toBe(4);
      for (const talent of definition.loadout) {
        expect({ talent: talent.id, level: getTalentLevel(sheet, talent.id) }).toEqual({
          talent: talent.id,
          level: 1,
        });
      }
    }
  });

  it('seeding at 1 rather than 0 is load-bearing: level 0 resolves, it does not refuse', () => {
    // `combatTalentScale` maps tl <= 0 to 0.1 (scale.ts:191). A talent seeded at
    // 0 would therefore not fail loudly — it would quietly deal a fraction of
    // its damage, which is the worst possible failure mode for a seeding bug.
    const sheet = sheetForClass(WATCHMAN);
    expect(getTalentLevel(sheet, talentId('crude_blow'))).toBe(1);
    // …and a talent this sheet has no points in answers 0, not 1, so a caller
    // that got 0 knows it asked about something the actor does not have.
    expect(getTalentLevel(sheet, talentId('fog_step'))).toBe(0);
  });

  it('feeds a restored point spread through the ONE constructor', () => {
    // A save restore must not build a sheet and then mutate it into shape: two
    // ways to make a sheet is two places to forget the seeding rule, and the one
    // that forgets it hands a loaded character talents at level 0.
    const restored = new Map<string, number>([[talentId('crude_blow'), 4]]);
    const sheet = sheetForClass(WATCHMAN);
    expect(getTalentLevel(sheet, talentId('crude_blow'))).toBe(1);

    const engine = createContentTalentEngine();
    const definition = WATCHMAN;
    const loaded = engine.attach('p1', {
      ...sheet,
      points: new Map(
        definition.loadout.map((talent) => [talent.id, restored.get(talent.id) ?? 1]),
      ),
    });
    expect(getTalentLevel(loaded, talentId('crude_blow'))).toBe(4);
    expect(getTalentLevel(loaded, talentId('ward_rush'))).toBe(1);
  });
});
