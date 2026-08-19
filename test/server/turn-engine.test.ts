import { describe, expect, it } from 'vitest';

import { AiProfile, setCooldown, Faction } from '../../src/server/engine/actor.ts';
import {
  DOWNED_TURNS,
  Survival,
  createDownedState,
  goDown,
  isDowned,
  isErased,
  survivalOf,
  tickDowned,
} from '../../src/server/engine/downed.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { tileIndex } from '../../src/shared/coords.ts';
import { ErrorCode, ResourceKind, TalentShape, TileCode } from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { TalentBook } from '../../src/server/turn-engine.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type {
  LoadoutTalent,
  ResourceView,
  TalentShape as Shape,
} from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TALENT GATE. THE POINT OF THE WHOLE FEATURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The client's range ring, `min_range` hole, LOS greying and cooldown wipe are a
 * CONVENIENCE. `submitTalent` is the rule. Every test in this file is a frame a
 * patched client could send from a devtools console with the ring switched off,
 * paired with the specific `ErrorCode` the server must answer — because a
 * refusal that does not name which rule it broke teaches the player nothing, and
 * a targeting mode's only teaching moment is its refusals.
 *
 * The refusals are checked at SUBMISSION here, which is a deliberately smaller
 * set than the one checked at resolution: only the things that cannot change
 * between the packet and the tick (terrain, the catalogue, your own bookkeeping).
 * Whether a monster is still standing there is a resolution question, and its
 * answer is the refund rule — see the scheduler's tests.
 */

const CASTER = { x: 10, y: 10 } as const;

/**
 * A talent, with the fields nothing in this file varies already filled in.
 * Written as a factory rather than four hand-built literals so that a test says
 * only what it is about — `range: 5, minRange: 3` and nothing else.
 */
function talent(id: string, over: Partial<LoadoutTalent> = {}): LoadoutTalent {
  return {
    id,
    name: id,
    icon: `icon_ability_${id}`,
    cost: { ap: 0, mp: 0, resource: 0 },
    cooldownTurns: 0,
    range: 5,
    minRange: 0,
    shape: TalentShape.Single satisfies Shape,
    radius: 0,
    // ═══ THE RANK, AND WHY IT IS PART OF THE FIXTURE RATHER THAN A DEFAULT ═══
    // `range` on a `LoadoutTalent` is PER-ACTOR from v9 — the caster's own
    // talent level resolved through `effectiveTalentRange`. This file drives the
    // CATALOGUE-ONLY fallback (a book with no `check`), which reads `range`
    // straight off this view, so a test that overrides `range` is deliberately
    // stating "this actor's range, at whatever rank they are" and the level
    // beside it is what makes that readable rather than accidental.
    level: 1,
    maxLevel: TALENT_MAX_LEVEL,
    desc: `${id} at rank 1.`,
    descNext: `${id} at rank 2.`,
    ...over,
  };
}

/** The Inspector's signature, and the only number in the class that matters. */
const SNIPERS_MARK = talent('talent:sniper_mark', { range: 7, minRange: 3 });
const REVOLVER_SHOT = talent('talent:revolver_shot', { range: 5 });
const IRON_CURTAIN = talent('talent:iron_curtain', { shape: TalentShape.Self, range: 0 });
const MEND_WOUNDS = talent('talent:mend_wounds', {
  range: 2,
  cost: { ap: 4, mp: 0, resource: 3 },
  cooldownTurns: 5,
});

const ALL = [SNIPERS_MARK, REVOLVER_SHOT, IRON_CURTAIN, MEND_WOUNDS];

function book(talents: readonly LoadoutTalent[], resource?: ResourceView): TalentBook {
  return {
    loadoutOf: () => talents,
    resourceOf: () => resource,
  };
}

const FULL_REAGENTS: ResourceView = {
  kind: ResourceKind.Reagents,
  current: 8,
  max: 8,
  discrete: true,
};

type Session = {
  readonly world: World;
  readonly caster: Actor;
  readonly engine: ReturnType<typeof createTurnEngine>;
};

/**
 * One caster on an OPEN FLOOR at (10, 10).
 *
 * The authored test map is flattened on purpose: these tests are about the gate,
 * not about where the level generator happens to have put a pillar. The one test
 * that needs a wall digs exactly one, so the wall it is testing is visible in the
 * test rather than three files away.
 */
function session(talents: readonly LoadoutTalent[], resource?: ResourceView): Session {
  const world = createWorld('talent-gate');
  world.level.tiles.fill(TileCode.FLOOR);

  const caster = world.addPlayer('actor_caster', 'Caster');
  caster.x = CASTER.x;
  caster.y = CASTER.y;

  return { world, caster, engine: createTurnEngine({ world, talents: book(talents, resource) }) };
}

function wall(world: World, x: number, y: number): void {
  world.level.tiles[tileIndex(x, y, world.level.w)] = TileCode.WALL;
}

/** The refusal code, or 'ok'. Keeps every assertion below to one line. */
function use(s: Session, talentId: string, target?: { x: number; y: number }): string {
  const result = s.engine.submitTalent('actor_caster', talentId, target);
  return result.ok ? 'ok' : result.code;
}

// ---------------------------------------------------------------------------
// THE DEAD ZONE
// ---------------------------------------------------------------------------

describe("the Inspector's dead zone", () => {
  /**
   * game-design.md § 2: `min_range 3` is "the single most important number
   * here" — the Inspector CANNOT shoot adjacent, which is the entire reason the
   * Watchman holding a choke is worth anything.
   */
  it('refuses point blank with too_close, NEVER out_of_range', () => {
    const s = session(ALL);
    // Distance 1 and 2. Both are well inside `range: 7`, so a server that only
    // checked the outer ring would happily let the shot through — which is the
    // bug this test exists to catch.
    expect(use(s, SNIPERS_MARK.id, { x: 11, y: 10 })).toBe(ErrorCode.TooClose);
    expect(use(s, SNIPERS_MARK.id, { x: 12, y: 10 })).toBe(ErrorCode.TooClose);
  });

  it('allows the shot at exactly minRange — `<`, not `<=`', () => {
    const s = session(ALL);
    // 3 is the closest LEGAL tile. That is how the authored `min_range` reads in
    // content/skills/*.json and how the ring's hole must be cut, so an
    // off-by-one here would make the hole a tile too wide on every client.
    expect(use(s, SNIPERS_MARK.id, { x: 13, y: 10 })).toBe('ok');
  });

  it('CUTS A CIRCULAR HOLE, not a square one', () => {
    const s = session(ALL);
    // (12,12) is dx 2, dy 2 — Euclidean 2.83, INSIDE a minRange of 3. A
    // Chebyshev metric would call it 2 and also refuse, but the pair below is
    // what separates the two: (13,11) is Chebyshev 3 and Euclidean 3.16, and it
    // must be legal. The metric is `core.fov.distance`, shared with
    // engine/combat.ts's `combatDistance` so a talent and a weapon swing cannot
    // disagree about one tile.
    expect(use(s, SNIPERS_MARK.id, { x: 12, y: 12 })).toBe(ErrorCode.TooClose);
    expect(use(s, SNIPERS_MARK.id, { x: 13, y: 11 })).toBe('ok');
  });

  it('leaves talents without a dead zone alone', () => {
    const s = session(ALL);
    // minRange 0 means there is no hole at all. A blanket "you may not target
    // adjacent" would silently break every melee talent in the game.
    expect(use(s, REVOLVER_SHOT.id, { x: 11, y: 10 })).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// RANGE
// ---------------------------------------------------------------------------

describe('range', () => {
  it('is a CIRCLE, so the diagonal corner is out of range', () => {
    const s = session(ALL);
    // (14,14) is dx 4, dy 4 — Chebyshev 4, which a square ring would allow
    // inside `range: 5`. Euclidean it is 5.66 and it is out. This is the whole
    // reason two metrics exist: ToME uses Chebyshev for A* step costs and
    // Euclidean for every range, radius and targeting ring, and reproducing only
    // one makes ranged talents feel wrong by 41% along the diagonals.
    expect(use(s, REVOLVER_SHOT.id, { x: 14, y: 14 })).toBe(ErrorCode.OutOfRange);
    expect(use(s, REVOLVER_SHOT.id, { x: 15, y: 10 })).toBe('ok');
    expect(use(s, REVOLVER_SHOT.id, { x: 13, y: 13 })).toBe('ok');
  });

  it('refuses a tile that is not on the map at all', () => {
    const s = session(ALL);
    // zod already bounded the coordinate to [0, 4095]; this is the real check,
    // and it is `illegal_move` — "that tile, no" — rather than a range failure,
    // because a tile off the grid is not a distance problem.
    expect(use(s, REVOLVER_SHOT.id, { x: 29, y: 29 })).toBe(ErrorCode.OutOfRange);
    expect(use(s, REVOLVER_SHOT.id, { x: 10, y: 4095 })).toBe(ErrorCode.IllegalMove);
  });
});

// ---------------------------------------------------------------------------
// LINE OF SIGHT
// ---------------------------------------------------------------------------

describe('line of sight', () => {
  it('refuses a shot through a wall', () => {
    const s = session(ALL);
    wall(s.world, 12, 10);
    expect(use(s, REVOLVER_SHOT.id, { x: 14, y: 10 })).toBe(ErrorCode.NoLos);
  });

  it('does not let a wall block the tile it is standing on', () => {
    const s = session(ALL);
    // Bresenham excludes both endpoints, so a target tile that is itself a wall
    // is still visible. That matters: an AoE aimed at a wall is a legal thing to
    // do, and the alternative is a targeting mode that mysteriously refuses the
    // corner of a room.
    wall(s.world, 14, 10);
    expect(use(s, REVOLVER_SHOT.id, { x: 14, y: 10 })).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// THE CATALOGUE, THE COOLDOWN AND THE PURSE
// ---------------------------------------------------------------------------

describe('membership, cooldown and resource', () => {
  it('refuses a talent that is not in this actor loadout', () => {
    // M3 loadouts are FIXED (PLAN.md § M3: zero trees, zero talent points), so a
    // frame naming a thirteenth talent — or the Alchemist's heal on a Watchman —
    // is hand-crafted, not a UI slip. `bad_message` says exactly that.
    const s = session([REVOLVER_SHOT]);
    expect(use(s, 'talent:mend_wounds', { x: 11, y: 10 })).toBe(ErrorCode.BadMessage);
    expect(use(s, 'talent:not_a_real_talent', { x: 11, y: 10 })).toBe(ErrorCode.BadMessage);
  });

  it('refuses a talent still cooling down, and names the turns left', () => {
    const s = session(ALL, FULL_REAGENTS);
    setCooldown(s.caster, MEND_WOUNDS.id, 3);
    const result = s.engine.submitTalent('actor_caster', MEND_WOUNDS.id, { x: 11, y: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(ErrorCode.OnCooldown);
    // The number is in the sentence because the hotbar's wipe already draws the
    // fraction; the error line is what a player reads when they pressed the key
    // anyway, and "3 turn(s) left" is the only useful thing it can say.
    expect(result.reason).toContain('3');
  });

  it('refuses a talent that cannot be paid for', () => {
    const poor: ResourceView = { ...FULL_REAGENTS, current: 2 };
    const s = session(ALL, poor);
    // Mend Wounds costs 3 reagents and there are 2. THIS IS THE ALCHEMIST'S
    // WHOLE CLASS: a countable stock, so every cast is a discrete decision, and
    // the refusal has to say which resource ran out rather than "illegal".
    expect(use(s, MEND_WOUNDS.id, { x: 11, y: 10 })).toBe(ErrorCode.NoResource);
    expect(
      use(session(ALL, { ...FULL_REAGENTS, current: 3 }), MEND_WOUNDS.id, { x: 11, y: 10 }),
    ).toBe('ok');
  });

  it('refuses a costed talent when the actor has no resource pool at all', () => {
    // No pool and a non-zero cost is not "free", it is "cannot pay". The
    // opposite reading would let a monster with no class cast the party's heal.
    const s = session(ALL);
    expect(use(s, MEND_WOUNDS.id, { x: 11, y: 10 })).toBe(ErrorCode.NoResource);
  });

  it('lets a free talent through without a pool', () => {
    const s = session(ALL);
    expect(use(s, REVOLVER_SHOT.id, { x: 12, y: 10 })).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// SELF TALENTS
// ---------------------------------------------------------------------------

describe('self talents', () => {
  it('needs no target', () => {
    const s = session(ALL);
    expect(use(s, IRON_CURTAIN.id)).toBe('ok');
  });

  it('accepts the caster own tile, and refuses being aimed anywhere else', () => {
    const s = session(ALL);
    expect(use(s, IRON_CURTAIN.id, { x: CASTER.x, y: CASTER.y })).toBe('ok');
    // Refused rather than silently ignored: dropping a field on the floor is how
    // a client and a server start disagreeing about what was cast.
    expect(use(s, IRON_CURTAIN.id, { x: 12, y: 10 })).toBe(ErrorCode.IllegalMove);
  });

  it('refuses an aimed talent that arrives with no target', () => {
    const s = session(ALL);
    expect(use(s, REVOLVER_SHOT.id)).toBe(ErrorCode.BadMessage);
  });
});

// ---------------------------------------------------------------------------
// WHAT A SUCCESSFUL SUBMISSION ACTUALLY DOES
// ---------------------------------------------------------------------------

describe('an accepted talent', () => {
  it('queues an intent carrying the CATALOGUE id and a copied tile', () => {
    const s = session(ALL);
    expect(use(s, REVOLVER_SHOT.id, { x: 13, y: 10 })).toBe('ok');

    const intent = s.caster.pendingIntent;
    expect(intent?.kind).toBe('talent');
    if (intent?.kind !== 'talent') return;
    expect(intent.talentId).toBe(REVOLVER_SHOT.id);
    expect(intent.target).toEqual({ x: 13, y: 10 });
  });

  it('SPENDS NOTHING at submission — that is the refund rule', () => {
    const s = session(ALL, FULL_REAGENTS);
    setCooldown(s.caster, MEND_WOUNDS.id, 0);
    expect(use(s, MEND_WOUNDS.id, { x: 11, y: 10 })).toBe('ok');
    // No cooldown, no reagent gone. An intent that goes illegal between the
    // packet and the tick — the target died, you were shoved out of range — must
    // cost ZERO, and that only falls out for free if nothing was deducted yet.
    // The spend happens in `useTalent`, after the last thing that can fail.
    expect(s.caster.cooldowns.size).toBe(0);
    expect(s.engine.resourceOf('actor_caster')?.current).toBe(8);
  });

  it('replaces a previous pending intent — you changed your mind', () => {
    const s = session(ALL);
    expect(use(s, REVOLVER_SHOT.id, { x: 13, y: 10 })).toBe('ok');
    expect(use(s, REVOLVER_SHOT.id, { x: 12, y: 10 })).toBe('ok');
    const intent = s.caster.pendingIntent;
    if (intent?.kind !== 'talent') throw new Error('expected a talent intent');
    expect(intent.target).toEqual({ x: 12, y: 10 });
  });

  it('refuses everything once the caster is a corpse', () => {
    const s = session(ALL);
    s.caster.alive = false;
    expect(use(s, REVOLVER_SHOT.id, { x: 12, y: 10 })).toBe(ErrorCode.NotYourTurn);
  });
});

// ---------------------------------------------------------------------------
// THE DEFAULTS, AND THE HOOK
// ---------------------------------------------------------------------------

describe('the gate composes rather than competing', () => {
  it('fails CLOSED with no talent book at all', () => {
    // `createTurnEngine({ world })` is the M2 call, still valid, and it must not
    // become a validation bypass. Every id is unknown, so every talent frame is
    // refused — the opposite default would be a hole that only shows up live.
    const world = createWorld('no-book');
    const engine = createTurnEngine({ world });
    const actor = world.addPlayer('actor_a', 'A');
    const result = engine.submitTalent(actor.id, 'talent:revolver_shot', { x: 1, y: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(ErrorCode.BadMessage);
    expect(engine.loadoutOf(actor.id)).toEqual([]);
    expect(engine.resourceOf(actor.id)).toBeUndefined();
  });

  it('defers ENTIRELY to the authoritative checker when one is supplied', () => {
    // `canUseTalent` in engine/talents.ts knows things this adapter cannot see —
    // the AP and MP budgets, whether the body under the cursor is hostile,
    // whether a Fog Step destination is occupied. When it is wired in, it is the
    // only opinion that counts: the fallback below would have said `ok` for this
    // frame, and it must not get a vote.
    const world = createWorld('with-checker');
    world.level.tiles.fill(TileCode.FLOOR);
    const caster = world.addPlayer('actor_caster', 'Caster');
    caster.x = CASTER.x;
    caster.y = CASTER.y;

    const engine = createTurnEngine({
      world,
      talents: {
        loadoutOf: () => ALL,
        resourceOf: () => FULL_REAGENTS,
        check: () => ErrorCode.OnCooldown,
      },
    });

    const inRange = engine.submitTalent('actor_caster', REVOLVER_SHOT.id, { x: 12, y: 10 });
    expect(inRange.ok).toBe(false);
    if (inRange.ok) return;
    expect(inRange.code).toBe(ErrorCode.OnCooldown);
    // ...and nothing was queued, because a refusal is a refusal wherever it came
    // from.
    expect(caster.pendingIntent).toBeNull();
  });

  it('still queues through the hook when it says yes', () => {
    const world = createWorld('with-checker-ok');
    world.level.tiles.fill(TileCode.FLOOR);
    const caster = world.addPlayer('actor_caster', 'Caster');
    caster.x = CASTER.x;
    caster.y = CASTER.y;

    const engine = createTurnEngine({
      world,
      talents: { loadoutOf: () => ALL, resourceOf: () => FULL_REAGENTS, check: () => null },
    });

    // Distance 1 with a minRange of 3 — the fallback would refuse it. The hook
    // is the authority and it said yes, so it goes through: one implementation
    // of the rule, not two voting.
    expect(engine.submitTalent('actor_caster', SNIPERS_MARK.id, { x: 11, y: 10 }).ok).toBe(true);
    expect(caster.pendingIntent?.kind).toBe('talent');
  });
});

// ---------------------------------------------------------------------------
// REVIVE — a DIRECTION on the wire, an ID in the engine
// ---------------------------------------------------------------------------

/**
 * game-design.md § 9: "Any ally reaching you spends 4 AP to restore you at 25%
 * HP. This single mechanic does more for co-op tension than anything else."
 *
 * `submitRevive` is the adapter between the two vocabularies and it is the only
 * place the conversion happens. The wire says a DIRECTION because identity never
 * travels client -> server; the engine says an ID because an intent submitted
 * now resolves later, and a direction re-read at resolution would pick up
 * whoever has since stepped into that tile.
 */
describe('submitRevive', () => {
  /** A rescuer at (10,10) and, optionally, somebody east of them. */
  function scene(): { world: World; rescuer: Actor; engine: ReturnType<typeof createTurnEngine> } {
    const world = createWorld('revive');
    world.level.tiles.fill(TileCode.FLOOR);
    const rescuer = world.addPlayer('actor_caster', 'Caster');
    rescuer.x = CASTER.x;
    rescuer.y = CASTER.y;
    return { world, rescuer, engine: createTurnEngine({ world, downed: createDownedState() }) };
  }

  it('REACHES A BODY THAT IS `alive === false`, which is what a Downed one is', () => {
    // THE REGRESSION THIS WHOLE BLOCK EXISTS FOR. `goDown` sets `alive = false`
    // — deliberately, because that flag is what stops the scheduler ticking them
    // and what stops them blocking the tile the rescuer has to step onto. So
    // `world.actorAt`, whose whole job is to skip bodies that do not block,
    // returns undefined for every body this verb exists to reach. The symptom is
    // a revive key that answers "nobody is lying there" while somebody is lying
    // there, in the one moment of the game a player must not hesitate.
    const { world, rescuer, engine } = scene();
    const fallen = world.addPlayer('actor_fallen', 'Fallen');
    fallen.x = CASTER.x + 1;
    fallen.y = CASTER.y;

    goDown(createDownedState(), fallen, 1);
    expect(fallen.alive).toBe(false);
    expect(world.actorAt(fallen.x, fallen.y)).toBeUndefined();

    expect(engine.submitRevive?.('actor_caster', 'e').ok).toBe(true);
    // AN ID, not a direction. Fixed at the moment the player pointed, so that
    // somebody stepping into that tile before the tick cannot become the subject.
    expect(rescuer.pendingIntent).toEqual({ kind: 'revive', targetId: 'actor_fallen' });
  });

  it('prefers the body ON THE FLOOR when an ally is standing on the same tile', () => {
    // A corpse does not block, so an ally really can be standing on one. The
    // person you are reaching for is the one lying down.
    const { world, engine, rescuer } = scene();
    const fallen = world.addPlayer('actor_fallen', 'Fallen');
    const standing = world.addPlayer('actor_standing', 'Standing');
    fallen.x = CASTER.x + 1;
    fallen.y = CASTER.y;
    standing.x = CASTER.x + 1;
    standing.y = CASTER.y;

    goDown(createDownedState(), fallen, 1);

    expect(engine.submitRevive?.('actor_caster', 'e').ok).toBe(true);
    expect(rescuer.pendingIntent).toEqual({ kind: 'revive', targetId: 'actor_fallen' });
  });

  it('refuses an empty tile in words a player can act on', () => {
    const { engine, rescuer } = scene();
    const result = engine.submitRevive?.('actor_caster', 'e');
    expect(result?.ok).toBe(false);
    expect(rescuer.pendingIntent).toBeNull();
  });

  it('refuses a monster: it is a CATEGORY error, so it is caught at submission', () => {
    // Everything that can change between the packet and the tick — is that body
    // actually Downed, is it in reach, can you afford the 4 AP — belongs to
    // `revive` in engine/downed.ts at RESOLUTION. Whether the thing is a person
    // cannot change, so it is refused here, where the sentence is useful.
    const { world, engine, rescuer } = scene();
    world.addMonster('mon_a', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: CASTER.x + 1,
      y: CASTER.y,
      profile: AiProfile.MeleeChaser,
    });

    expect(engine.submitRevive?.('actor_caster', 'e').ok).toBe(false);
    expect(rescuer.pendingIntent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RESPAWN — the way out of Erased, applied BETWEEN pumps
// ---------------------------------------------------------------------------

/**
 * Reported from real co-op play: "when the player dies, we need a respawn method
 * as I was stuck". Erased was terminal in a game that has no permadeath — the
 * only exit was a party wipe, and a disconnected friend's body was keeping the
 * wipe from ever firing.
 *
 * It is NOT AN INTENT, and that is the thing this block is really pinning: an
 * erased body is dropped by `tickLevel`'s `isActive` gate, so an intent queued on
 * one would never resolve. The restoration is applied here and now, and the pump
 * that follows simply finds a body that is up.
 */
describe('submitRespawn', () => {
  function scene(): {
    world: World;
    downed: DownedState;
    actor: Actor;
    engine: ReturnType<typeof createTurnEngine>;
  } {
    const world = createWorld('respawn');
    world.level.tiles.fill(TileCode.FLOOR);
    const downed = createDownedState();
    const actor = world.addPlayer('actor_stuck', 'Stuck');
    return { world, downed, actor, engine: createTurnEngine({ world, downed }) };
  }

  /** Down, then the whole countdown spent: the state a player gets stranded in. */
  function erase(downed: DownedState, actor: Actor): void {
    goDown(downed, actor, 1);
    for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(downed, actor);
    expect(isErased(downed, actor.id)).toBe(true);
  }

  it('stands an ERASED body up at full HP, on a spawn tile', () => {
    const { downed, actor, engine } = scene();
    actor.x = 20;
    actor.y = 20;
    erase(downed, actor);

    expect(engine.submitRespawn?.('actor_stuck').ok).toBe(true);
    expect(actor.alive).toBe(true);
    expect(actor.hp).toBe(actor.maxHp);
    expect(survivalOf(downed, 'actor_stuck')).toBe(Survival.Up);
    // MOVED, and that is the half the engine cannot do for itself: a body that
    // stood up where it fell could be standing inside a monster — an erased body
    // does not block, so anything may have parked on top of it.
    expect({ x: actor.x, y: actor.y }).not.toEqual({ x: 20, y: 20 });
  });

  it('never lands on a tile a living body is already standing on', () => {
    // THE INVARIANT world.ts IS WRITTEN AROUND. `actorAt` skips anything not
    // alive, so an ally can be standing exactly where the erased body is lying.
    const { world, downed, actor, engine } = scene();
    const bystander = world.addPlayer('actor_by', 'Bystander');
    bystander.x = actor.x;
    bystander.y = actor.y;
    erase(downed, actor);

    expect(engine.submitRespawn?.('actor_stuck').ok).toBe(true);
    expect({ x: actor.x, y: actor.y }).not.toEqual({ x: bystander.x, y: bystander.y });
  });

  it('REFUSES a body that is Downed, and the refusal costs nothing', () => {
    // The five-turn countdown is the mechanic (game-design.md § 9). A player who
    // could stand themselves up out of Downed would never be worth running to.
    const { downed, actor, engine } = scene();
    const where = { x: actor.x, y: actor.y };
    goDown(downed, actor, 1);

    const result = engine.submitRespawn?.('actor_stuck');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toContain('an ally can still reach you');
    // Not half-restored, and not teleported: a refused verb must leave the body
    // exactly where the rescuer is running to.
    expect(actor.alive).toBe(false);
    expect({ x: actor.x, y: actor.y }).toEqual(where);
    expect(isDowned(downed, 'actor_stuck')).toBe(true);
  });

  it('refuses somebody who is already on their feet', () => {
    const { actor, engine } = scene();
    actor.hp = 3;
    const result = engine.submitRespawn?.('actor_stuck');
    expect(result?.ok).toBe(false);
    // Emphatically not a free heal.
    expect(actor.hp).toBe(3);
  });

  it('clears Standing By, so the party is not left waiting on a body nobody drives', () => {
    // Somebody who was erased has usually been auto-passed out of the quorum by
    // then. Coming back has to put them into it, or the person who just pressed
    // a key to get unstuck is still not in the game.
    const { world, downed, actor, engine } = scene();
    erase(downed, actor);
    actor.standingBy = true;

    expect(engine.submitRespawn?.('actor_stuck').ok).toBe(true);
    expect(world.getActor('actor_stuck')?.standingBy).toBe(false);
  });

  it('is absent-safe: a server with no survival table refuses in words', () => {
    // `createTurnEngine({ world })` is still the M3 game, where 0 hp is a corpse
    // and nobody is ever Erased. The honest answer names itself rather than
    // pretending the player was not erased.
    const world = createWorld('respawn-no-survival');
    const engine = createTurnEngine({ world });
    world.addPlayer('actor_stuck', 'Stuck');
    const result = engine.submitRespawn?.('actor_stuck');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.reason : '').toContain('survival');
  });
});

// ---------------------------------------------------------------------------
// THE REFUND, AND THE ONE CHANNEL IT IS ALLOWED OUT OF THE ENGINE ON
// ---------------------------------------------------------------------------

/**
 * A move that is legal when the packet lands and illegal when it resolves.
 *
 * This is the case the refund rule exists for, and until `PumpResult.refusals`
 * it was invisible from outside: `toWireEvents` drops `refunded` (it has nothing
 * to draw), the refund spends no energy so no clock advances, and every term of
 * the gateway's `turnKey` is therefore byte-identical — `broadcastTurnIfChanged`
 * suppresses the frame. The owner of the intent was told LITERALLY NOTHING, and
 * a travelling client waiting for its `moved` wedged forever with the whole
 * phase-locked party behind it.
 */
describe('pump reports the intents it refunded', () => {
  function twoPlayers(seed: string): {
    readonly world: World;
    readonly engine: ReturnType<typeof createTurnEngine>;
  } {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);

    const walker = world.addPlayer('actor_walker', 'Walker');
    walker.x = 10;
    walker.y = 10;
    /**
     * A TOWNSFOLK, AND IT USED TO BE A SECOND PLAYER.
     *
     * The blocker has to be somebody the walker will neither fight nor swap
     * with, because this test is about a move that survives submission and dies
     * at RESOLUTION — which is what a traveller hits when somebody lands on its
     * next tile during the step's flight time.
     *
     * An ally was the obvious choice and stopped working the day allies started
     * trading places (Combat.lua:32-74, engine/scheduler.ts). A hostile is no
     * good either: stepping into one is a bump-attack and resolves perfectly
     * well. `Faction.Townsfolk` is the remaining body that blocks — `areEnemies`
     * returns false for her so there is no attack, and the swap's kind test
     * refuses to move her, so the step is still `MoveBlock.Occupied`.
     */
    const blocker = world.addMonster('actor_blocker', {
      name: 'Merrow Stitch',
      sprite: 'chr_npc_bent_watchman_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
      faction: Faction.Townsfolk,
      aggroRange: 0,
      attackRange: 0,
    });
    void blocker;

    const engine = createTurnEngine({ world });
    engine.join('actor_walker');
    engine.join('actor_blocker');
    return { world, engine };
  }

  it('surfaces a move refused at RESOLUTION, which nothing else on the wire mentions', () => {
    const { engine } = twoPlayers('refund-surfaced');

    // ACCEPTED AT SUBMISSION: `submitMove` validates only that the actor is
    // alive. Terrain and occupancy are decided later, in `resolveIntent`.
    expect(engine.submitMove('actor_walker', 'e').ok).toBe(true);

    const result = engine.pump();

    expect(result.refusals).toEqual([{ id: 'actor_walker', reason: 'occupied' }]);
    // ...and the drawable lane says nothing whatsoever, which is correct and is
    // also the whole problem `refusals` solves.
    expect(result.playerEvents).toEqual([]);
  });

  it('is empty on a pump where nothing was taken back', () => {
    // A refusal channel that fired on quiet turns would be worse than none: the
    // client cancels a walk on it.
    const { engine } = twoPlayers('refund-quiet');

    expect(engine.submitMove('actor_walker', 'w').ok).toBe(true);
    const result = engine.pump();

    expect(result.refusals).toEqual([]);
    expect(result.playerEvents.some((ev) => ev.k === 'move')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hitToWire — A MISS IS AN OUTCOME, NOT AN ABSENCE
// ---------------------------------------------------------------------------

/**
 * `AttackEvent.hit` has been on the wire since M2 and both READERS were already
 * finished — `client/render/sweep.ts`'s `case 'attack'` picks the marker off
 * `event.hit`, and the gateway's `recordFor` `case 'attack'` narrates
 * "Watchman misses Bent Husk." (by symbol: both line numbers drifted, and
 * gateway.ts:2563 is now a `sendTurn` call). The producer was the
 * only liar: `hitToWire` hard-coded `true`, because nothing upstream of it could
 * miss until `strike` moved onto `combat.ts#attackTarget`.
 *
 * These tests drive it end to end through a real pump rather than calling the
 * private function, because the claim is about what the GATEWAY is handed.
 */
describe('a miss on the wire', () => {
  /**
   * One player and one husk, adjacent, with the fight already armed.
   *
   * `defence` is what decides the outcome, and it is pinned rather than seeded:
   * `checkHit` bounds its chance to [0, 100], so a defence far past any
   * achievable accuracy is a guaranteed miss and an accuracy far past any
   * defence is a guaranteed hit. Seeds are not used to steer an outcome anywhere
   * in this file — a seed chosen because it passed is a coincidence, not a test.
   */
  function brawl(
    seed: string,
    who: 'hits' | 'misses',
  ): { readonly world: World; readonly engine: ReturnType<typeof createTurnEngine> } {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);

    const ren = world.addPlayer('actor_ren', 'Ren');
    ren.x = 10;
    ren.y = 10;
    ren.hpRegen = 0;
    // Enough accuracy to beat any defence below, so "did it land" is decided by
    // the husk's sheet alone.
    ren.combat = { mods: { atk: 30 } };

    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 40,
      combat: who === 'misses' ? { mods: { def: 400 } } : {},
    });

    const engine = createTurnEngine({ world });
    engine.join('actor_ren');
    world.turn.engagement = 3;
    return { world, engine };
  }

  it('emits exactly ONE frame on a miss — no damage, no death', () => {
    const { engine } = brawl('wire-miss', 'misses');
    expect(engine.submitMove('actor_ren', 'e').ok).toBe(true);

    const mine = engine.pump().playerEvents;

    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      k: 'attack',
      id: 'actor_ren',
      targetId: 'm_husk',
      x: 11,
      y: 10,
      hit: false,
    });
    // A `damage` frame here would remove hp from a blow that never landed, and a
    // `death` frame would kill somebody with it.
    expect(mine.some((ev) => ev.k === 'damage')).toBe(false);
    expect(mine.some((ev) => ev.k === 'death')).toBe(false);
  });

  it('emits attack + damage on a hit, and adds death when it kills', () => {
    const { world, engine } = brawl('wire-hit', 'hits');
    expect(engine.submitMove('actor_ren', 'e').ok).toBe(true);

    const landed = engine.pump().playerEvents;
    expect(landed.map((ev) => ev.k)).toEqual(['attack', 'damage']);
    const [swing, harm] = landed;
    expect(swing?.k === 'attack' ? swing.hit : undefined).toBe(true);
    expect(harm?.k === 'damage' ? harm.amount : 0).toBeGreaterThan(0);

    // ...and the killing blow adds the third frame.
    const husk = world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: husk missing');
    husk.hp = 1;
    expect(engine.submitMove('actor_ren', 'e').ok).toBe(true);
    const killing = engine.pump().playerEvents;
    expect(killing.map((ev) => ev.k)).toEqual(['attack', 'damage', 'death']);
  });

  it('still reports a NON-ZERO maxHp on the frame that killed the body', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE REASON THE REAP IS THE CALLER'S JOB AND NOT THE PUMP'S.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `hitToWire` reads `maxHp` off the world AFTER the pump has returned —
    // legitimately, because nothing in a fight changes it, so there is nothing
    // to snapshot. Remove the corpse inside the pump and that lookup answers
    // undefined, the frame ships `maxHp: 0`, and the Case Log narrates
    // "5 damage. someone 0/0." Nothing throws; the log simply starts lying.
    const { world, engine } = brawl('wire-kill-maxhp', 'hits');
    const husk = world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: husk missing');
    husk.hp = 1;

    expect(engine.submitMove('actor_ren', 'e').ok).toBe(true);
    const result = engine.pump();

    const harm = result.playerEvents.find((ev) => ev.k === 'damage');
    expect(harm?.k === 'damage' ? harm.maxHp : 0).toBe(40);
    expect(harm?.k === 'damage' ? harm.hp : -1).toBe(0);
    // The body is NAMED, not buried: it is on the reap list and still in the
    // world, which is exactly what let the frame above be honest.
    expect(result.reaped).toEqual(['m_husk']);
    expect(world.getActor('m_husk')).toBeDefined();
  });
});
