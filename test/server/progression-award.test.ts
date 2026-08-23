import { describe, expect, it } from 'vitest';

import { NO_STAIRS_GAME_TURNS, stairsLockedFor } from '../../src/shared/progression.ts';

import { AiProfile, IntentKind } from '../../src/server/engine/actor.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite, partyOf } from '../../src/server/engine/party.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { TalentRefusal } from '../../src/server/engine/talents.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { GameEvent, PumpResult, TalentResolution } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EXPERIENCE AWARD: ONE SITE, ONE PAYMENT PER BODY, THE WHOLE PARTY PAID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The award lives in `noteCasualty` and NOWHERE ELSE, and this file is the
 * argument for that placement rather than a description of it. Three separate
 * properties fall out of the one line, and each of them is a bug that has
 * already been shipped once in this codebase in a different currency:
 *
 *   IT CANNOT DOUBLE-PAY. `killed` is true exactly once per body — damage.ts:589
 *   returns an empty outcome against something already down — so a party of four
 *   racing the same husk is paid once, not four times.
 *
 *   IT CANNOT UNDER-PAY. All three lanes reach it: a player's own action, the
 *   batched monster sweep, and a projectile impact up to three game turns after
 *   the shot. `TalentEngine.noteKill` used to be called from inside the talent
 *   helpers instead, so a TALENT kill paid and the basic weapon swing paid
 *   nothing — talents.ts:1477-1481 and :1519 still carry the NO-noteKill-HERE
 *   warnings that record it. Experience would have repeated the bug exactly.
 *
 *   IT CANNOT LEAK A PARTY ROW. `partyOf` MUTATES and mints on demand
 *   (party.ts:275-290), so the kind guard has to come BEFORE the party lookup or
 *   monster-kills-monster quietly files husks into the party table.
 *
 * ═══ THE SHARE RULE IS OURS, AND NOTHING IN HERE CITES A LUA LINE FOR IT ═══
 * ToME has no party experience rule at all: `Party.lua` contains zero `exp`,
 * `Player.lua` zero `gainExp`, and `Actor.lua:2985-2987` is the module's only
 * combat award site, paying `src:resolveSource()` and nobody else. DECISIONS.md
 * D12 is the record. Ours pays the FULL award to every member — no division, no
 * proximity, and no filter on being upright.
 */

/** `worthExp(1, ActorRank.Normal)` — level 1 × rank 0.8 × XP_WORTH_MULT 4. */
const AWARD = 1 * 0.8 * 4;
/**
 * `worthExp(2, ActorRank.Normal)`. The SAME husk pays a level-2 character twice
 * what it pays a level-1 one, because `awardExperience` computes the award once
 * PER RECIPIENT from the recipient's own level — see the deviation note on
 * `worthExp` in src/shared/progression.ts, which is where the whole of that
 * wart is argued.
 */
const AWARD_AT_2 = 2 * 0.8 * 4;

/**
 * A weapon that always lands and always rolls the SAME NUMBER.
 *
 * `damRange: 1.0` collapses the damage interval to a point, so `damage.ts:276`
 * takes no draw at all and every blow is a flat 6. That is not a convenience:
 * half of these tests need a husk to survive exactly three blows and die on the
 * fourth, and a test that arranges that by picking a lucky seed converts a
 * structural property into a coincidence that stops holding the next time
 * anything upstream draws. `atk: 100` rescales far past the 100% bound, which is
 * how "never misses" is bought by accuracy rather than by re-rolling the seed.
 */
const FLAT_SIX: CombatSheet = { weapon: { dam: 20, atk: 100, damRange: 1.0 }, minRange: 0 };
const FLAT_DAMAGE = 6;

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * The eight tiles around (12,2) are all floor (src/shared/level.ts), so a whole
 * party can stand shoulder to shoulder around one husk. Order matters only in
 * that the first four are used first.
 */
const RING: readonly { readonly x: number; readonly y: number }[] = [
  { x: 11, y: 1 },
  { x: 11, y: 2 },
  { x: 11, y: 3 },
  { x: 12, y: 1 },
  { x: 12, y: 3 },
  { x: 13, y: 1 },
];
const HUSK_TILE = { x: 12, y: 2 };

/**
 * One body, NARROWED TO A PLAYER, because `level`/`xp`/`unspentPoints`/
 * `pendingLevels` live on `PlayerActor` and not on the union. The narrowing is
 * the type system restating the split engine/actor.ts argues in prose: a husk
 * has no experience and asking it for some is a compile error rather than an
 * `undefined` that reads as zero.
 */
function player(world: World, id: string): PlayerActor {
  const found = world.getActor(id);
  if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
  if (found.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
  return found;
}

type Table = {
  readonly world: World;
  readonly parties: PartyState | undefined;
  readonly downed: DownedState | undefined;
  readonly actor: (id: string) => PlayerActor;
  /** Submit for everybody named, then resolve the whole lot in ONE pump call. */
  readonly commitAll: (ids: readonly string[], targetId: string, nowMs: number) => PumpResult;
  /** As above, but each attacker names its own victim. */
  readonly commitOrders: (
    orders: readonly (readonly [string, string])[],
    nowMs: number,
  ) => PumpResult;
  readonly advance: (nowMs: number) => PumpResult;
};

type TableInit = {
  readonly seed: string;
  readonly players: number;
  /** Put every player in one party. Absent → no party table at all. */
  readonly party?: boolean;
  readonly survival?: boolean;
  /** The husk's hit points. 5 dies to one blow; 23 dies to exactly four. */
  readonly huskHp?: number;
  /** Tiles for players beyond the ring — the far-corner case. */
  readonly outposts?: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** Extra husks, for the tests that need two kills inside one pump. */
  readonly extraHusks?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly hp: number;
  }[];
  /**
   * The talent seam. Wired in ONLY by the level-timing tests, which use its
   * `noteKill` / `actBase` hooks as the two mid-pump observation points — there
   * is no other way to look at an actor between the award and the base clock.
   * The recorder below is a pure observer: every member is a no-op.
   */
  readonly talents?: TalentResolution;
  /**
   * The Case Log narration seam. Absent → the level still happens and nothing is
   * narrated, which is the contract `PumpCtx.onLevelUp` states — and which was
   * the SHIPPED behaviour for one build, because the hook was declared, invoked
   * by `applyPendingLevels` and connected to nothing anywhere in `src/`.
   */
  readonly onLevelUp?: (actorId: string, level: number) => void;
};

/**
 * A party stood around one husk, ready to hit it.
 *
 * Everybody is given 10,000 hp: the husk swings back on its own turn, and a
 * test about experience must never fail because somebody was killed while it was
 * counting.
 */
function table(init: TableInit): Table {
  const world = createWorld(init.seed);
  const barrier = createBarrier();
  const parties = init.party === true ? createPartyState() : undefined;
  const downed = init.survival === true ? createDownedState() : undefined;

  for (let i = 0; i < init.players; i += 1) {
    const id = `p${i + 1}`;
    const player = world.addPlayer(id, `Player ${i + 1}`);
    const outpost = init.outposts?.[id];
    const spot = outpost ?? RING[i] ?? RING[0];
    if (spot !== undefined) {
      player.x = spot.x;
      player.y = spot.y;
    }
    player.maxHp = 10_000;
    player.hp = 10_000;
    player.hpRegen = 0;
    player.combat = FLAT_SIX;
  }

  // One party for everybody. The real command path rather than a hand-built
  // table, so the members list is the one the barrier would see.
  if (parties !== undefined) {
    for (let i = 1; i < init.players; i += 1) {
      expect(invite(parties, 'p1', `p${i + 1}`, 0).ok).toBe(true);
      expect(accept(parties, `p${i + 1}`, 'p1', 0).ok).toBe(true);
    }
  }

  world.addMonster('m1', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: HUSK_TILE.x,
    y: HUSK_TILE.y,
    profile: AiProfile.MeleeChaser,
    maxHp: init.huskHp ?? 5,
  });

  for (const extra of init.extraHusks ?? []) {
    world.addMonster(extra.id, {
      name: `Index Husk ${extra.id}`,
      sprite: HUSK_SPRITE,
      x: extra.x,
      y: extra.y,
      profile: AiProfile.MeleeChaser,
      maxHp: extra.hp,
    });
  }

  const actor = (id: string): PlayerActor => player(world, id);

  const ctx = (nowMs: number): Parameters<typeof pump>[1] => ({
    nowMs,
    barrier,
    ...(parties === undefined ? {} : { parties }),
    ...(downed === undefined ? {} : { downed }),
    ...(init.talents === undefined ? {} : { talents: init.talents }),
    ...(init.onLevelUp === undefined ? {} : { onLevelUp: init.onLevelUp }),
  });

  const commitOrders = (
    orders: readonly (readonly [string, string])[],
    nowMs: number,
  ): PumpResult => {
    for (const [id, targetId] of orders) {
      expect(submitIntent(world, barrier, id, { kind: IntentKind.Attack, targetId })).toBe(true);
    }
    return pump(world, ctx(nowMs));
  };

  return {
    world,
    parties,
    downed,
    actor,
    advance: (nowMs) => pump(world, ctx(nowMs)),
    commitOrders,
    commitAll: (ids, targetId, nowMs) =>
      commitOrders(
        ids.map((id) => [id, targetId] as const),
        nowMs,
      ),
  };
}

/** One actor's progression, as of the instant a hook fired. */
type Snapshot = {
  readonly level: number;
  readonly xp: number;
  readonly unspentPoints: number;
  readonly pendingLevels: number;
};

/**
 * A `TalentResolution` that resolves nothing and records everything.
 *
 * The two hooks it exists for sit either side of the split this file is about:
 * `noteKill` is called by `noteCasualty` IMMEDIATELY BEFORE the experience
 * award, and `actBase` is called by the pump's base-clock pass IMMEDIATELY
 * BEFORE the banked levels are paid out. Between those two calls lies "the rest
 * of the pump", and a snapshot taken at the second one is the only honest way to
 * see what an actor looked like while it was in there.
 *
 * Every member is otherwise inert, so wiring it in changes no behaviour and
 * moves no draw: `use` is never reached (nothing submits a talent intent) and
 * the other three do nothing at all.
 */
function recorder(
  // LAZY, because the seam has to be handed to `table` and `table` is what
  // creates the world. One closure beats threading a mutable box through two
  // helpers.
  getWorld: () => World,
  watchId: string,
): {
  readonly seam: TalentResolution;
  readonly atKill: readonly Snapshot[];
  readonly atBasePass: readonly Snapshot[];
} {
  const atKill: Snapshot[] = [];
  const atBasePass: Snapshot[] = [];

  const snap = (): Snapshot => {
    const watched = getWorld().getActor(watchId);
    if (watched === undefined || watched.kind !== 'player') {
      throw new Error(`recorder: ${watchId} is not a player`);
    }
    return {
      level: watched.level,
      xp: watched.xp,
      unspentPoints: watched.unspentPoints,
      pendingLevels: watched.pendingLevels,
    };
  };

  return {
    atKill,
    atBasePass,
    seam: {
      use: () => ({ ok: false, reason: TalentRefusal.UnknownTalent }),
      actBase: (actorId) => {
        if (actorId === watchId) atBasePass.push(snap());
      },
      noteMoved: () => undefined,
      noteKill: () => atKill.push(snap()),
      noteStruck: () => undefined,
      // The intra-turn budget's seam. A stub answers "nothing left to do", which
      // closes every round after one action — this fixture's existing behaviour
      // exactly. See `TalentResolution.roundOpen`.
      roundOpen: () => false,
      // Movement is free without a talent runtime — the game as it shipped.
      spendMove: () => true,
      // NO MARK AND NO GUARD in this scene. 1 is the identity the seam's own
      // contract names, and a null counter is "nobody was guarding" — which is
      // the truth here: this fixture has no talent sheets at all.
      markMultiplier: () => 1,
      guardCounter: () => null,
    },
  };
}

/**
 * TWO PLAYERS, TWO HUSKS, ONE PARTY, ONE PUMP — the scene the level-timing
 * tests need, because a split between "the award" and "the base clock" is only
 * observable if something else happens in between. p1 stands on the ring beside
 * `m1`; p2 is four tiles east beside `m2`, close enough to nothing else.
 */
function tableWithRecorder(seed: string): {
  readonly table: Table;
  readonly record: ReturnType<typeof recorder>;
  readonly actor: (id: string) => PlayerActor;
} {
  let built: Table | null = null;
  const record = recorder(() => {
    if (built === null) throw new Error('test fixture: the world is not built yet');
    return built.world;
  }, 'p1');

  built = table({
    seed,
    players: 2,
    party: true,
    talents: record.seam,
    outposts: { p2: { x: 15, y: 2 } },
    extraHusks: [{ id: 'm2', x: 16, y: 2, hp: 5 }],
  });

  return { table: built, record, actor: built.actor };
}

/** Every `attacked` event in a pump's result, sweep steps included. */
function blows(events: readonly GameEvent[]): {
  readonly attackerId: string;
  readonly targetId: string;
  readonly damage: number;
  readonly killed: boolean;
}[] {
  const out: {
    attackerId: string;
    targetId: string;
    damage: number;
    killed: boolean;
  }[] = [];
  for (const event of events) {
    if (event.t === 'attacked') {
      out.push({
        attackerId: event.id,
        targetId: event.targetId,
        damage: event.damage,
        killed: event.killed,
      });
    }
    if (event.t === 'sweep') {
      for (const step of event.steps) {
        if (step.t === 'attack') {
          out.push({
            attackerId: step.id,
            targetId: step.targetId,
            damage: step.damage,
            killed: step.killed,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The award
// ---------------------------------------------------------------------------

describe('the award at the one kill site', () => {
  it('pays killerLevel x 0.8 x 4 for one Normal husk, and nothing else moves', () => {
    const scene = table({ seed: 'award-one', players: 1 });
    expect(scene.actor('p1').xp).toBe(0);

    scene.commitAll(['p1'], 'm1', 0);

    const ren = scene.actor('p1');
    // The golden, written as the arithmetic rather than as 3.2, so the number
    // and its provenance cannot drift apart: the KILLER's level (a deliberate
    // deviation from Actor.lua:6513-6531, argued in src/shared/progression.ts),
    // the Normal rank's 0.8 (Actor.lua:6521) and ToME's own `exp_worth_mult`
    // dial at 4 (Actor.lua:6516).
    expect(ren.xp).toBe(AWARD);
    // 3.2 is nowhere near `expChart(2)` = 27, so nothing else may have happened.
    expect(ren.level).toBe(1);
    expect(ren.unspentPoints).toBe(0);
    expect(ren.pendingLevels).toBe(0);
  });

  it('pays a player NOTHING for putting another player down — the monster branch', () => {
    // There is no player-versus-player intent in the game (`isHostile` is
    // kind-based, so an Attack at an ally is refused as `not_hostile`), so the
    // only way a player's id can be the killer of a player is an orb attributed
    // to them. It takes the survival arm of `noteCasualty`, which pays nobody.
    const scene = table({ seed: 'award-pvp', players: 2 });
    // The fixture's husk goes: with anything hostile in sight, engagement arms,
    // the party blocks, and an orb in flight FREEZES until a human decides
    // (`pump`'s note on why projectiles tick last). Out of combat the level
    // reaches its idle fixed point and the orb crosses the room in one call.
    expect(scene.world.removeActor('m1')).toBe(true);
    const victim = scene.actor('p2');
    victim.maxHp = 10;
    victim.hp = 10;
    // Out along row 2, which is open floor end to end, with a clear line.
    scene.actor('p1').x = 3;
    scene.actor('p1').y = 2;
    victim.x = 8;
    victim.y = 2;

    scene.world.addProjectile({
      sourceId: 'p1',
      origin: { x: 3, y: 2 },
      to: { x: 8, y: 2 },
      projSpeed: 2,
      range: 8,
      damage: { dam: 50, type: DamageType.Physical, apr: 0 },
    });

    // No `downed` table in this fixture, so 0 hp is M3's plain corpse and the
    // survival branch simply `continue`s. Either way nobody is paid.
    scene.advance(0);

    expect(scene.actor('p2').alive).toBe(false);
    expect(scene.actor('p1').xp).toBe(0);
    expect(scene.actor('p2').xp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotence — the property that put the award in `noteCasualty`
// ---------------------------------------------------------------------------

describe('one body pays exactly once', () => {
  it('FOUR PLAYERS RACING ONE HUSK ARE EACH PAID ONCE, AND ALL FOUR ARE PAID', () => {
    // 23 hp against a flat 6 is three blows survived and the fourth fatal, all
    // inside ONE pump call: four `attacked` events, one of them `killed`.
    //
    // This is the whole reason the award sits beside the reap enrolment. The
    // naive placement — inside the damage helpers — pays the party four times
    // for one husk, and the naive fix — paying only the last-hitter — is the
    // last-hit race the full-share rule exists to abolish.
    const scene = table({ seed: 'idempotent', players: 4, party: true, huskHp: 23 });

    const result = scene.commitAll(['p1', 'p2', 'p3', 'p4'], 'm1', 0);

    const landed = blows(result.events).filter((blow) => blow.targetId === 'm1' && blow.damage > 0);
    expect(landed).toHaveLength(4);
    expect(landed.filter((blow) => blow.killed)).toHaveLength(1);
    expect(result.reaped).toEqual(['m1']);

    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      // EXACTLY ONE AWARD EACH. Not four (one per blow), not two (one for the
      // killer's own lane plus one for the party sweep), not zero for the three
      // who did not land the last hit.
      expect(scene.actor(id).xp).toBe(AWARD);
    }
  });
});

// ---------------------------------------------------------------------------
// The share rule — DECISIONS.md D12, and no `Ported from` header anywhere
// ---------------------------------------------------------------------------

describe('the party share', () => {
  it('pays every member the FULL award — three members, three times one award', () => {
    // NOT A THIRD EACH. Division by headcount makes every new arrival a tax on
    // the people already playing, in a game whose premise is 3-6 friends in a
    // voice channel; the fifth friend must never be a cost the other four feel.
    const scene = table({ seed: 'share-three', players: 3, party: true });

    scene.commitAll(['p1'], 'm1', 0);

    const paid = ['p1', 'p2', 'p3'].map((id) => scene.actor(id).xp);
    expect(paid).toEqual([AWARD, AWARD, AWARD]);
    expect(paid.reduce((sum, xp) => sum + xp, 0)).toBe(3 * AWARD);
  });

  it('pays a member standing in the far corner of the floor — NO PROXIMITY CHECK', () => {
    // A radius would pay the least experience to the Inspector, whose authored
    // `min_range` of 3 puts her furthest from the body by design. Once there is
    // no radius there is no distance at which the rule changes, so the honest
    // test is the extreme one: the other side of the map.
    const scene = table({
      seed: 'share-far',
      players: 2,
      party: true,
      outposts: { p2: { x: 27, y: 27 } },
    });

    const far = scene.actor('p2');
    expect(chebyshev(far, HUSK_TILE)).toBeGreaterThan(20);

    scene.commitAll(['p1'], 'm1', 0);

    expect(scene.actor('p2').xp).toBe(AWARD);
  });

  it('pays a member who is DOWN — game-design.md § 9 is no permadeath, NO LOSS', () => {
    // `alive === false` in this game means DOWNED, not dead: engine/downed.ts
    // reuses the flag for a body on the floor with a countdown over it. A player
    // being carried is still on the case, and D12's "living" was written before
    // this question had a site to be answered at.
    const scene = table({ seed: 'share-downed', players: 3, party: true, survival: true });
    const survival = scene.downed;
    if (survival === undefined) throw new Error('test fixture: no survival table');

    const carried = scene.actor('p3');
    carried.hp = 0;
    carried.alive = false;
    expect(goDown(survival, carried, scene.world.turn.clock.gameTurn)).not.toBeNull();

    scene.commitAll(['p1'], 'm1', 0);

    expect(scene.actor('p3').alive).toBe(false);
    expect(scene.actor('p3').xp).toBe(AWARD);
    // ...and the two who were standing were paid the same amount, not a share
    // topped up by the absent one.
    expect(scene.actor('p1').xp).toBe(AWARD);
    expect(scene.actor('p2').xp).toBe(AWARD);
  });
});

// ---------------------------------------------------------------------------
// The two guards, in order, and why the order is the whole of it
// ---------------------------------------------------------------------------

/**
 * A shooter, a victim and a live orb, all far enough from the party that
 * engagement never arms — which is what lets the orb fly in an `idle` pump
 * instead of hanging in the air while a human decides.
 */
function orbScene(
  seed: string,
  options: { readonly reapShooter: boolean },
): {
  readonly world: World;
  readonly parties: PartyState;
  readonly pumpOnce: () => PumpResult;
} {
  const world = createWorld(seed);
  const barrier = createBarrier();
  const parties = createPartyState();

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 3;
  ren.y = 2;

  world.addMonster('m_shooter', {
    name: 'Index Wraith',
    sprite: 'enemy_index_wraith_s',
    x: 20,
    y: 18,
    profile: AiProfile.MeleeChaser,
  });
  world.addMonster('m_victim', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 26,
    y: 18,
    profile: AiProfile.MeleeChaser,
    maxHp: 10,
  });

  world.addProjectile({
    sourceId: 'm_shooter',
    origin: { x: 20, y: 18 },
    to: { x: 26, y: 18 },
    projSpeed: 2,
    range: 8,
    damage: { dam: 50, type: DamageType.Physical, apr: 0 },
  });

  // THE SHOOTER IS BURIED WHILE ITS ORB IS STILL IN THE AIR. That is not a
  // contrivance: `PumpResult.reaped`'s own doc says the reap window is one pump
  // wide and "does not cover an orb in flight", and a wraith's orb crosses six
  // tiles at projSpeed 2 — three game turns after the muzzle.
  if (options.reapShooter) expect(world.removeActor('m_shooter')).toBe(true);

  return {
    world,
    parties,
    pumpOnce: () => pump(world, { nowMs: 0, barrier, parties }),
  };
}

describe('the guards, in order', () => {
  it('GUARD 1 — the killer no longer exists: no throw, and nobody is paid', () => {
    const scene = orbScene('killer-gone', { reapShooter: true });
    // `pump` mints a party for every PLAYER on the floor before it does anything
    // else (`partyScopes` -> `partyIdOf`), so the baseline is taken with p1's own
    // row already in place. What must not appear is a row for the SHOOTER.
    partyOf(scene.parties, 'p1');
    const before = scene.parties.byId.size;

    // The throw this guard prevents would escape `pump`, cross a ws handler and
    // take the process down — so "it did not throw" is the assertion, and it is
    // the important one.
    const result = scene.pumpOnce();

    expect(result.reaped).toEqual(['m_victim']);
    expect(player(scene.world, 'p1').xp).toBe(0);
    expect(player(scene.world, 'p1').level).toBe(1);
    // And it returned before touching party.ts, so no row was minted for a
    // shooter that no longer exists.
    expect(scene.parties.byId.size).toBe(before);
  });

  it('GUARD 2 — a monster killing a monster mints NO PARTY ROW', () => {
    // `partyOf` MUTATES (party.ts:275-290, "IT MUTATES, AND THAT IS THE
    // CONTRACT") and both `membersOf` and `partyIdOf` go through it. Calling
    // either with a husk's id leaves a party containing one husk, which only
    // `forgetActor` ever clears — a leak with no symptom at all, which is why
    // this asserts on the table's own size rather than on anything visible.
    const scene = orbScene('monster-on-monster', { reapShooter: false });
    // One real row first, so the assertion is "no NEW rows" rather than "the
    // table happens to be empty".
    partyOf(scene.parties, 'p1');
    const before = scene.parties.byId.size;
    expect(before).toBe(1);

    const result = scene.pumpOnce();

    expect(result.reaped).toEqual(['m_victim']);
    expect(scene.parties.byId.size).toBe(before);
    expect(scene.parties.partyOf.has('m_shooter')).toBe(false);
    expect(scene.parties.partyOf.has('m_victim')).toBe(false);
    expect(scene.parties.partyOf.has('p1')).toBe(true);
    // Nothing was paid to the only body that could have been paid.
    expect(player(scene.world, 'p1').xp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AWARD NOW, LEVEL LATER — the replay-divergence split
// ---------------------------------------------------------------------------

describe('levels land on the base clock, never mid-pump', () => {
  it('LEAVES THE POINT BANKED FOR THE REST OF THE PUMP, then pays it on the base pass', () => {
    /**
     * WHAT IS ACTUALLY BEING PINNED, because "talent scaling" is one step
     * downstream of it: a talent's damage comes from `combatTalentScale` over
     * `TalentSheet.points`, and the ONLY thing that can change that map is the
     * spend path, which needs an unspent point to spend. So `unspentPoints`
     * staying 0 for the remainder of the pump IS the scaling staying put — there
     * is no other input, and pinning the cause beats pinning one symptom of it.
     *
     * Why it matters: the pump walks ONE FROZEN ACTOR SNAPSHOT and every RNG
     * draw in it is labelled and ordered. A talent whose scaling changed between
     * the first and the third blow of one AoE would move the draw stream and
     * break replay-from-seed (CLAUDE.md § 3).
     *
     * THE SCENE IS TWO KILLS IN ONE PUMP, so that there is a "remainder" to
     * look at: p1 crosses a level on the first husk, and p2 then kills a second
     * husk in the same pump, before any base clock has come round. The snapshot
     * taken at that second kill is the whole test.
     */
    const scene = tableWithRecorder('level-timing');

    scene.actor('p1').xp = 26; // one kill short of `expChart(2)` = 27.

    const killing = scene.table.commitOrders(
      [
        ['p1', 'm1'],
        ['p2', 'm2'],
      ],
      0,
    );
    expect([...killing.reaped].sort()).toEqual(['m1', 'm2']);

    // TWO KILLS, TWO `noteKill` HOOKS, IN RESOLUTION ORDER.
    expect(scene.record.atKill).toHaveLength(2);
    const beforeAward = scene.record.atKill[0];
    const laterInTheSamePump = scene.record.atKill[1];

    // Immediately before p1's own award: still level 1, nothing banked.
    expect(beforeAward).toEqual({ level: 1, xp: 26, unspentPoints: 0, pendingLevels: 0 });

    // AND HERE IS THE PROPERTY. p2's kill lands later in the SAME pump, with no
    // base clock in between. p1's level has already risen — a number no draw
    // reads — while the POINT has not appeared.
    expect(laterInTheSamePump?.level).toBe(2);
    expect(laterInTheSamePump?.pendingLevels).toBe(1);
    expect(laterInTheSamePump?.unspentPoints).toBe(0);

    // Let the base clock come round — `applyPendingLevels` fires beside
    // `actBase`, which is once per game turn per actor at any speed.
    scene.table.advance(1_000);
    scene.table.advance(2_000);

    // The base pass that paid it saw the point still banked one instant before
    // it ran: that snapshot is taken by `talents.actBase`, which the scheduler
    // calls immediately before handing the points out.
    const banked = scene.record.atBasePass.filter((snap) => snap.pendingLevels > 0);
    expect(banked.length).toBeGreaterThan(0);
    for (const snap of banked) expect(snap.unspentPoints).toBe(0);

    // ...and by the time the dust settles the point is in hand. Both kills paid
    // p1, because both husks fell to somebody in p1's party.
    const settled = scene.actor('p1');
    expect(settled.level).toBe(2);
    /**
     * ═══ THE TWO AWARDS ARE NOT THE SAME SIZE, AND THAT IS THE POINT ═══
     * p1 is level 1 when the first husk falls and level 2 when the second does,
     * and `awardExperience` computes `worthExp` ONCE PER RECIPIENT inside the
     * payout loop — from the RECIPIENT's own level, never the killer's. So the
     * second kill pays p1 6.4 even though p2, who landed it, is still level 1.
     *
     * THIS EXPRESSION USED TO READ `26 + AWARD + AWARD - 27`, back when the
     * award was computed once from the KILLER and paid identically to everybody.
     * That rule was defended on the grounds that the difference is unobservable
     * "because full-share keeps the party at one level" — and THIS VERY SCENE is
     * a counterexample to it, because p1 crosses a level mid-pump and p2 does
     * not. It also meant the party's whole xp rate was set by whoever happened
     * to land the killing blow, which a mid-session join turns into an eightfold
     * swing.
     *
     * `toBeCloseTo` only because the engine subtracts the threshold BETWEEN the
     * two awards ((26 + 3.2 - 27) + 6.4) and the expression here does not, which
     * is a different rounding of the same arithmetic and nothing more.
     */
    expect(settled.xp).toBeCloseTo(26 + AWARD - 27 + AWARD_AT_2, 10);
    expect(settled.unspentPoints).toBe(1);
    expect(settled.pendingLevels).toBe(0);
    // THE INVARIANT, over every observation this pump produced: a level is
    // either banked or paid, never both and never neither.
    for (const snap of scene.record.atBasePass) {
      expect(snap.pendingLevels > 0 && snap.unspentPoints > 0).toBe(false);
    }
  });

  it('grants BOTH levels when one award crosses two — 2 for level 5, 1 for level 6', () => {
    // `pointsForLevel` is Actor.lua:3749-3751: one per level, plus one more on
    // every fifth. A crossing that skipped the fifth level's pair would be
    // invisible in a single-level test and permanent for the character.
    const scene = tableWithRecorder('two-levels');
    const ren = scene.actor('p1');
    ren.level = 4;
    // `expChart(5)` = 174 and `expChart(6)` = 254, both pinned by the golden
    // table in test/shared/progression.test.ts. One award short of both.
    ren.xp = 174 + 254 - 1;

    scene.table.commitOrders(
      [
        ['p1', 'm1'],
        ['p2', 'm2'],
      ],
      0,
    );

    // Two levels crossed by ONE award, banked as two...
    const midPump = scene.record.atKill[1];
    expect(midPump?.level).toBe(6);
    expect(midPump?.pendingLevels).toBe(2);
    expect(midPump?.unspentPoints).toBe(0);

    scene.table.advance(1_000);
    scene.table.advance(2_000);

    // ...and paid as three points, because the fifth level is worth two.
    const settled = scene.actor('p1');
    expect(settled.level).toBe(6);
    expect(settled.unspentPoints).toBe(3);
    expect(settled.pendingLevels).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The floor reset
// ---------------------------------------------------------------------------

describe('a wipe costs hit points, not progress', () => {
  it('leaves level, xp and unspent points INTACT through a full floor reset', () => {
    /**
     * game-design.md § 9 is "no permadeath, no loss". A reset that quietly
     * zeroed a level would look identical to a working one from inside the
     * engine — `resetFloorParty` restores hp, `alive`, the sprite and both
     * clocks, and every one of those is asserted elsewhere — so the only thing
     * that can catch it is an explicit assertion here, or a player at the end of
     * an evening.
     *
     * This drives the REAL caller (`resetFloor` in src/server/turn-engine.ts),
     * not `resetFloorParty` alone, because the caller's half moves the bodies
     * and re-seeds the floor and is where a "restore the character" step would
     * plausibly be added by somebody being helpful.
     */
    const world = createWorld('wipe-keeps-progress');
    const downed = createDownedState();

    world.addPlayer('p1', 'Ren');
    const ren = player(world, 'p1');
    ren.x = 22;
    ren.y = 20;
    ren.level = 4;
    ren.xp = 100;
    ren.unspentPoints = 5;

    const engine = createTurnEngine({ world, downed, now: () => 0 });

    // Straight onto the floor, exactly as a killing blow leaves them.
    ren.hp = 0;
    ren.alive = false;
    expect(goDown(downed, ren, world.turn.clock.gameTurn)).not.toBeNull();

    engine.pump();

    const restored = player(world, 'p1');
    // The reset did what it is for...
    expect(restored.alive).toBe(true);
    expect(restored.hp).toBe(restored.maxHp);
    // ...and nothing else.
    expect(restored.level).toBe(4);
    expect(restored.xp).toBe(100);
    expect(restored.unspentPoints).toBe(5);
    expect(restored.pendingLevels).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('replays to the same draw stream AND the same experience', () => {
    // The award is a product of three numbers and takes no draw of its own, so
    // the interesting half is that adding it did not INSERT one: two runs of the
    // same seed must agree on the generator's cursor as well as on the xp.
    const run = (): { readonly rng: unknown; readonly xp: readonly number[] } => {
      const scene = table({ seed: 'determinism', players: 4, party: true, huskHp: 23 });
      scene.commitAll(['p1', 'p2', 'p3', 'p4'], 'm1', 0);
      scene.advance(1_000);
      return {
        rng: scene.world.rng.getState(),
        xp: ['p1', 'p2', 'p3', 'p4'].map((id) => scene.actor(id).xp),
      };
    };

    const first = run();
    const second = run();

    expect(second.rng).toEqual(first.rng);
    expect(second.xp).toEqual(first.xp);
    expect(first.xp).toEqual([AWARD, AWARD, AWARD, AWARD]);
  });
});

/**
 * The flat-damage fixture is load-bearing for the four-blows-one-kill test, so
 * it gets an assertion of its own rather than being assumed. If a change to the
 * damage pipeline moves this number, the idempotence test above starts failing
 * for a reason that has nothing to do with experience.
 */
describe('the fixture', () => {
  it('lands a flat 6 on every blow, so a 23 hp husk dies on exactly the fourth', () => {
    const scene = table({ seed: 'fixture', players: 1, huskHp: 23 });

    const first = scene.commitAll(['p1'], 'm1', 0);
    const landed = blows(first.events).filter((blow) => blow.targetId === 'm1');
    expect(landed).toHaveLength(1);
    expect(landed[0]?.damage).toBeCloseTo(FLAT_DAMAGE, 10);
    expect(landed[0]?.killed).toBe(false);
  });
});

// ===========================================================================
// The narration seam — `PumpCtx.onLevelUp`
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A LEVEL-UP HAS TO BE SAYABLE, OR THE TALENT TREE IS DEAD CONTENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `onLevelUp` shipped once as a declared, documented, INVOKED hook that nothing
 * anywhere constructed — `grep -rn onLevelUp src/` returned the declaration, the
 * call and a comment. So the Case Log, which reports every blow, every status
 * and every death, said nothing when somebody levelled; and `ProgressMsg` is
 * viewer-private by design, so the only other signal was a number behind a key
 * the player had no reason to press. A party could cross three levels in its
 * first fight and finish the evening with every talent at rank 1.
 *
 * These pin the two things the gateway's Record line depends on: that the hook
 * fires at all, and that it fires ONCE PER LEVEL in ascending order, because
 * that is what makes a double crossing worth two announcements and two points.
 */
describe('the level-up narration seam', () => {
  it('fires once per level crossed, in order, on the base clock', () => {
    const calls: { readonly id: string; readonly level: number }[] = [];
    const scene = table({
      seed: 'levelup-seam',
      players: 1,
      onLevelUp: (id, level) => calls.push({ id, level }),
    });

    // `expChart(2)` = 27 and `expChart(3)` = 61, both pinned by the golden table
    // in test/shared/progression.test.ts. One award short of BOTH, so a single
    // kill carries this character across two levels at once — the case a
    // per-crossing hook exists for and a per-award one would under-report.
    const ren = scene.actor('p1');
    ren.xp = 27 + 61 - 1;

    // ONE PUMP IS ENOUGH, and that is worth stating: the husk dies to the first
    // blow, so nothing blocks afterwards and the pump runs on to its idle fixed
    // point — which means the base clock comes round inside this same call and
    // `applyPendingLevels` pays out before it returns. The banked-until-the-base
    // -pass property has its own test above; what is under examination here is
    // WHAT THE HOOK SAYS.
    scene.commitAll(['p1'], 'm1', 0);

    expect(calls).toEqual([
      { id: 'p1', level: 2 },
      { id: 'p1', level: 3 },
    ]);
    // Two levels announced, two levels held, and the points to match.
    expect(scene.actor('p1').level).toBe(3);
    expect(scene.actor('p1').unspentPoints).toBe(2);
  });

  it('says nothing at all when no level is crossed', () => {
    // The seam must not fire on a bare award, or every kill in the game becomes
    // a Record line and the Case Log stops being readable.
    const calls: number[] = [];
    const scene = table({
      seed: 'levelup-quiet',
      players: 1,
      onLevelUp: (_id, level) => calls.push(level),
    });

    scene.commitAll(['p1'], 'm1', 0);
    scene.advance(1_000);
    scene.advance(2_000);

    expect(calls).toEqual([]);
    expect(scene.actor('p1').level).toBe(1);
    // ...and the award did land, so this is silence about a LEVEL rather than
    // silence about a kill that never happened.
    expect(scene.actor('p1').xp).toBe(AWARD);
  });
});

describe('a kill shuts the stairs for a moment', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ANTI-STAIRSCUM — `last_kill_turn`, Game.lua:880.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Walk in, kill the first thing, walk straight back out to a freshly generated
   * floor. The arithmetic is `stairsLockedFor` and is tested on its own; this is
   * about the STAMP — that a real kill through the real award path actually
   * records the turn, on everybody it should.
   */
  it('records the turn on the killer', () => {
    const scene = table({ seed: 'stairs-one', players: 1 });
    expect(scene.actor('p1').lastKillTurn, 'nothing killed yet').toBeUndefined();

    scene.commitAll(['p1'], 'm1', 0);

    const ren = scene.actor('p1');
    expect(ren.lastKillTurn).toBeDefined();
    expect(stairsLockedFor(ren.lastKillTurn, ren.lastKillTurn ?? 0)).toBe(NO_STAIRS_GAME_TURNS);
  });

  it('records it on EVERY party member, not just the one who swung', () => {
    /**
     * ═══ THE HALF THAT CLOSES THE EXPLOIT IN CO-OP ═══
     * This file already establishes that a kill is the PARTY's event — "pays
     * every member the FULL award", no division and no proximity check. The
     * stairs rule rides the same loop, and it has to: charge only the killer and
     * one player kills while another opens the door.
     *
     * Upstream is single-player, so `getPlayer(true)` is unambiguous there and
     * this is the reading that carries the same intent here.
     */
    const scene = table({ seed: 'stairs-party', players: 3, party: true });
    scene.commitAll(['p1'], 'm1', 0);

    for (const id of ['p1', 'p2', 'p3']) {
      expect(scene.actor(id).lastKillTurn, `${id} was not charged`).toBeDefined();
    }
  });

  it('leaves a body that killed nothing free to walk out', () => {
    // Which is the ordinary case, and the one the rule must not touch: fleeing a
    // fight you are LOSING is exactly what upstream still allows, because the
    // trigger is a kill.
    const scene = table({ seed: 'stairs-none', players: 1 });
    expect(stairsLockedFor(scene.actor('p1').lastKillTurn, 50)).toBe(0);
  });
});
