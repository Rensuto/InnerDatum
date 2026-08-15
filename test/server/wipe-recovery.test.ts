import { describe, expect, it } from 'vitest';

import { seedTestEncounter } from '../../src/server/content/encounter.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { Survival, createDownedState, goDown, survivalOf } from '../../src/server/engine/downed.ts';
import { createPartyState, partyIdOf } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind, ErasedReason, TileCode } from '../../src/shared/protocol.ts';
import type { MonsterActor } from '../../src/server/engine/actor.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { PumpResult } from '../../src/server/net/gateway.ts';
import type { TurnLogger } from '../../src/server/turn-engine.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { TurnEvent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REPORTED LOOP — "DOWNING DOESN'T FULLY DOWN, IT SEEMS TO REVIVE ME"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two people played an evening of this. The Case Log, turn 162, verbatim:
 *
 *     Ren moves W.
 *     Ren is erased — the party is down. The floor resets.
 *     Index Wraith hits Ren.  3 damage. Ren 60/60.
 *     Ren is unfiled.
 *     Ren is DOWN — 5 turns to reach them.
 *
 * The floor "reset" and left Ren standing at full health one tile from the
 * wraith that had just killed them, still engaged, still in reach. The wraith
 * swung again, Ren went down again, the party wiped again, and the whole thing
 * repeated until somebody closed the tab. The other player's half of the same
 * report — *"if i am down, he is unable to take a turn, do anything"* — is what
 * a shared, level-wide pump looks like from a different party's screen while one
 * party churns it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, AND HOW IT DIFFERS FROM floor-reset.test.ts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * floor-reset.test.ts pins the MECHANISM: that `resetFloor` moves before it
 * re-seeds, that a wipe carries its lane and its party id, that the churn alarm
 * fires. Those are assertions about the parts.
 *
 * THIS FILE PINS THE OUTCOME THE PLAYERS REPORTED, end to end, through the same
 * `createTurnEngine` the socket layer drives — the property that a wipe next to
 * the thing that killed you RECOVERS, and keeps recovering, turn after turn.
 * Every test here is written so that it would have FAILED on the build that
 * produced the transcript above, and none of them reaches inside `resetFloor` to
 * do it: they ask the questions a player asks. Am I up? Am I whole? Is it still
 * standing on me? Can my friend take a turn?
 *
 * The fixtures deliberately leave `reseedFloor` at its default, so what runs is
 * the production path and not a stub of it.
 */

/** Open floor, deep in the level and well clear of the authored spawn cluster. */
const DEEP_IN_THE_LEVEL = { x: 20, y: 18 } as const;
/** The tile east of it. Whatever stands here is what puts them on the floor. */
const ON_TOP_OF_THEM = { x: 21, y: 18 } as const;
/** The tile west of it, for a second pair of hands in the same monster turn. */
const BEHIND_THEM = { x: 19, y: 18 } as const;

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * Enough damage to put a whole detective on the floor in one blow.
 *
 * A COMPRESSION OF THE REPORT, NOT A DEPARTURE FROM IT. The wraith in the
 * transcript hit for 3 and a restored detective comes back with 60, so the real
 * loop took the better part of twenty turns to come round — which is exactly why
 * it read as "downing doesn't fully down" rather than as an obvious reset loop,
 * and why it survived an evening of play. One blow per cycle makes the same loop
 * visible in the same turn, and nothing else about it changes: the party is
 * still restored in place, still inside the fight, still in reach.
 */
const PUTS_YOU_DOWN_IN_ONE = 999;

/** A logger that records, so "it warned" and "it stayed quiet" are both assertable. */
function spyLogger(): TurnLogger & {
  readonly warns: string[];
  readonly errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    info: () => undefined,
    warn: (_context, message) => warns.push(message),
    error: (_context, message) => errors.push(message),
  };
}

type Scene = {
  readonly world: World;
  readonly downed: DownedState;
  readonly log: ReturnType<typeof spyLogger>;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
  /** Arm the fight, spend the detective's turn, and let the blow land. */
  readonly takeTheKillingBlow: () => PumpResult;
  /** Put a body on the floor with no fight around it — a bleed-out, a GM command. */
  readonly knockDown: (id: string) => void;
};

/**
 * ONE DETECTIVE, DEEP IN THE LEVEL, WITH SOMETHING STANDING ON THEM.
 *
 * The board state the report describes, and every coordinate in it is chosen for
 * a reason. The player is nowhere near a spawn tile, because "did the reset move
 * them" is the whole question; the hostile is orthogonally adjacent, because
 * "was it still in reach afterwards" is the other one.
 */
function scene(seed: string): Scene {
  const world = createWorld(seed);
  const downed = createDownedState();
  const log = spyLogger();

  const ren = world.addPlayer('p1', 'Ren');
  // Regeneration off: a hit point that came back on its own would make "at full
  // health because the floor reset" indistinguishable from "at full health
  // because a turn went by".
  ren.hpRegen = 0;
  ren.x = DEEP_IN_THE_LEVEL.x;
  ren.y = DEEP_IN_THE_LEVEL.y;

  world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: ON_TOP_OF_THEM.x,
    y: ON_TOP_OF_THEM.y,
    profile: AiProfile.MeleeChaser,
    damageMin: PUTS_YOU_DOWN_IN_ONE,
    damageMax: PUTS_YOU_DOWN_IN_ONE,
  });

  const actor = (id: string): Actor => {
    const found = world.getActor(id);
    if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
    return found;
  };

  const engine = createTurnEngine({ world, downed, log, now: () => 0 });

  return {
    world,
    downed,
    log,
    engine,
    actor,
    takeTheKillingBlow: () => {
      const body = actor('p1');
      // One blow from the floor. The damage roll is seeded and the exact number
      // does not matter — anything at all finishes them.
      body.hp = 1;
      // Engagement has to be armed before anybody is asked whether they are
      // blocking, and the detective has to have spent their turn or the world
      // never reaches the monster.
      world.turn.engagement = 3;
      expect(engine.hold('p1').ok).toBe(true);
      return engine.pump();
    },
    knockDown: (id) => {
      const body = actor(id);
      body.hp = 0;
      body.alive = false;
      goDown(downed, body, world.turn.clock.gameTurn);
    },
  };
}

/**
 * Every living hostile on the floor, narrowed properly.
 *
 * A `filter` with a discriminant would leave the array as the union and hide
 * `ai.aggroRange` behind a cast — and `aggroRange` is exactly the number these
 * tests need, because "not adjacent" is a weaker claim than "has not even
 * noticed them".
 */
function livingHostiles(world: World): MonsterActor[] {
  const found: MonsterActor[] = [];
  for (const body of world.allActors()) {
    if (body.kind === ActorKind.Monster && body.alive) found.push(body);
  }
  return found;
}

/** Everything the gateway broadcasts for one pump, IN BROADCAST ORDER. */
function narrationOf(result: PumpResult): TurnEvent[] {
  return [...result.playerEvents, ...result.sweep];
}

/**
 * How many bodies this pump told the clients the floor had reset under.
 *
 * `ErasedReason.Wipe` rather than `Timer` is the whole of the distinction: a
 * timer erasure is one body's countdown running out, a wipe erasure is the floor
 * resetting under everybody. Counting them is how "it happened once" and "it
 * happened again" are told apart from OUTSIDE the engine, over the wire, which
 * is where the report came from.
 *
 * ONE FRAME PER RESTORED BODY, so this is a wipe COUNT only because every party
 * in this file is a party of one — which they are on purpose: the loop needs no
 * more than one person to reproduce, and a second body in the party would make
 * `toBe(1)` a statement about party size rather than about the reset.
 */
function wipesIn(result: PumpResult): number {
  return narrationOf(result).filter(
    (event) => event.k === 'erased' && event.reason === ErasedReason.Wipe,
  ).length;
}

/** Turn one tile of solid rock back into floor. */
function carve(world: World, x: number, y: number): void {
  world.level.tiles[y * world.level.w + x] = TileCode.FLOOR;
}

// ---------------------------------------------------------------------------
// The loop itself
// ---------------------------------------------------------------------------

describe('a party wiped with a hostile standing on them', () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. Everything else here is context for it.
   */
  it('"downing doesnt fully down, it seems to revive me" — is not put back on the floor by the thing that killed them', () => {
    const stuck = scene('reported-loop');

    const wipe = stuck.takeTheKillingBlow();

    // The premise: they really did go down, and the floor really did reset.
    expect(wipesIn(wipe)).toBe(1);

    // ON THEIR FEET WHEN THE TURN ENDS, which is the literal claim: a party
    // wiped with a hostile standing on them is not downed again on the turn
    // they are restored.
    expect(survivalOf(stuck.downed, 'p1')).toBe(Survival.Up);
    expect(stuck.actor('p1').alive).toBe(true);

    // ═══ AND THAT IS ONLY HALF OF IT. THE REPORT IS A *LOOP*. ═══
    // One good turn proves nothing — the build that produced the transcript got
    // that far too, because the restored body has 60 hit points and the thing
    // standing on it only takes one turn at a time. What it could not do was the
    // NEXT turn, and the next, and the next: the party stood back up inside the
    // same fight, took the next swing, went down, wiped, and came back up again,
    // for as long as anybody kept playing.
    //
    // So this keeps playing. Every turn the detective braces — which is what a
    // player does while they work out what just happened, and what the Bell
    // forces on them if they do not — and every turn the world gets its chance.
    for (let turn = 0; turn < 5; turn += 1) {
      expect(stuck.engine.hold('p1').ok).toBe(true);
      expect(wipesIn(stuck.engine.pump())).toBe(0);
      expect(survivalOf(stuck.downed, 'p1')).toBe(Survival.Up);
      expect(stuck.actor('p1').hp).toBe(stuck.actor('p1').maxHp);
    }
    // The churn alarm never had anything to say, which is the same statement
    // made from the server's side of the glass.
    expect(stuck.log.errors).toEqual([]);
  });

  it('hands them back whole, out of combat, and beyond every hostile’s notice', () => {
    const stuck = scene('reset-leaves-them-somewhere-survivable');

    stuck.takeTheKillingBlow();

    const ren = stuck.actor('p1');
    expect(ren.alive).toBe(true);
    expect(ren.hp).toBe(ren.maxHp);
    // At zero nobody blocks, the pump idles, and the party gets the moment to
    // breathe a floor reset is supposed to be. Landing straight back into a
    // parked barrier is what made this read as "downing doesn't fully down".
    expect(stuck.world.turn.engagement).toBe(0);

    // NOT MERELY "NOT ADJACENT". Nothing on the floor has line on them at all —
    // outside every hostile's aggro radius, which is the distance at which a
    // monster starts hunting. A reset that stands you up inside somebody's
    // aggro radius has handed the fight straight back to them.
    const hostiles = livingHostiles(stuck.world);
    expect(hostiles.length).toBeGreaterThan(0);
    for (const hostile of hostiles) {
      expect(chebyshev(hostile, ren)).toBeGreaterThan(hostile.ai.aggroRange);
    }
  });

  it('puts the hostiles back at their AUTHORED positions, not where the fight ended', () => {
    // A reset that leaves a wounded husk three tiles from the spawn cluster is
    // the same bug with extra steps: the encounter is authored far from the
    // spawn corner, and that placement is what makes the tile they land on SAFE
    // rather than merely unoccupied.
    const stuck = scene('hostiles-go-home');
    seedTestEncounter(stuck.world);

    const chaser = stuck.actor('mon_index_husk');
    const authored = { x: chaser.x, y: chaser.y };
    // It chased them the length of the room and it is standing on them, half
    // dead. This is what the end of a real fight looks like.
    chaser.x = BEHIND_THEM.x;
    chaser.y = BEHIND_THEM.y;
    chaser.hp = 3;

    stuck.takeTheKillingBlow();

    // The floor is the authored encounter and nothing else: the hand-placed
    // monster that did the killing is gone outright, and the three that belong
    // here are back where the author put them, at full health.
    expect(stuck.world.getActor('m_husk')).toBeUndefined();

    const reference = createWorld('hostiles-go-home-reference');
    seedTestEncounter(reference);
    const authoredFloor = livingHostiles(reference).map((body) => ({
      id: body.id,
      x: body.x,
      y: body.y,
      hp: body.hp,
      maxHp: body.maxHp,
    }));
    expect(
      livingHostiles(stuck.world).map((body) => ({
        id: body.id,
        x: body.x,
        y: body.y,
        hp: body.hp,
        maxHp: body.maxHp,
      })),
    ).toEqual(authoredFloor);

    // Named explicitly, because the map comparison above would still pass if
    // the encounter had simply never moved: the one that was dragged is home.
    const rebuilt = stuck.actor('mon_index_husk');
    expect({ x: rebuilt.x, y: rebuilt.y }).toEqual(authored);
    expect({ x: rebuilt.x, y: rebuilt.y }).not.toEqual({ x: BEHIND_THEM.x, y: BEHIND_THEM.y });
  });

  it('cannot wipe the same party twice running — there is nobody left on the floor to wipe', () => {
    // STRUCTURAL, NOT LUCKY, and the difference is what this test is for.
    // `surveyParty` reports a wipe only when `downed + erased > 0`; a second
    // wipe therefore needs somebody to be put back on the floor first, and after
    // the reset there is nobody down and nothing within reach to down them. The
    // scheduler's own guard (`SurvivalRun.wiped`) bounds a loop WITHIN one pump
    // and says nothing at all about the next one — which is exactly the shape
    // the report had: one tidy wipe per call, forever.
    const stuck = scene('no-second-wipe');

    expect(wipesIn(stuck.takeTheKillingBlow())).toBe(1);

    const ren = stuck.actor('p1');
    expect(survivalOf(stuck.downed, 'p1')).toBe(Survival.Up);
    expect(stuck.world.turn.engagement).toBe(0);
    for (const hostile of livingHostiles(stuck.world)) {
      expect(chebyshev(hostile, ren)).toBeGreaterThan(hostile.ai.aggroRange);
    }

    // So the very next pump has nothing to reset, and the one after it neither.
    expect(wipesIn(stuck.engine.pump())).toBe(0);
    expect(wipesIn(stuck.engine.pump())).toBe(0);
    // The churn alarm fires on a second wipe within two GAME TURNS. Its silence
    // is the same claim as the two lines above, made from the server's side.
    expect(stuck.log.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pathological floor
// ---------------------------------------------------------------------------

describe('a floor with nowhere safe to put anybody', () => {
  /**
   * A HANG IS WORSE THAN AN UNFAIR POSITION. An unfair position is one bad turn;
   * a hang is a server that stops answering with four people in a voice channel.
   * So the reset takes the best tile it can find and moves on — never a retry
   * loop, never a search that widens until it succeeds.
   *
   * The explicit timeout is the hang detector: this test asserts termination as
   * much as it asserts state.
   */
  it('places the party anyway on a level that is almost entirely solid rock, and does not hang', () => {
    const stuck = scene('nowhere-safe');
    const ren = stuck.actor('p1');

    // Solid rock everywhere, then a two-tile pocket carved back out of it. The
    // authored spawn cluster is gone, so `findSpawn` falls through to its
    // overflow scan; every authored monster tile is gone, so the re-seed places
    // nothing. What is left is one free tile and a body that has to end up
    // somewhere real.
    stuck.world.level.tiles.fill(TileCode.WALL);
    carve(stuck.world, DEEP_IN_THE_LEVEL.x, DEEP_IN_THE_LEVEL.y);
    carve(stuck.world, BEHIND_THEM.x, BEHIND_THEM.y);
    const fell = { x: ren.x, y: ren.y };

    stuck.knockDown('p1');
    const first = stuck.engine.pump();

    // IT CAME BACK, and it came back inside the tick budget — a pump that burned
    // its ceiling is the shape of a loop that nearly did not return.
    expect(first.status).not.toBe('budget');

    expect(ren.alive).toBe(true);
    expect(ren.hp).toBe(ren.maxHp);
    expect(survivalOf(stuck.downed, 'p1')).toBe(Survival.Up);
    // PLACED ANYWAY. There is exactly one tile on this floor that a living body
    // is not already standing on, and the reset found it rather than giving up
    // on a level it did not like the look of.
    expect({ x: ren.x, y: ren.y }).not.toEqual(fell);
    expect(stuck.log.warns).toEqual([]);
    // And it is real floor. A body standing inside a wall is the one outcome
    // worse than a body standing where it fell.
    expect(canWalk(stuck.world.level, ren.x, ren.y)).toBe(true);

    // And pumping the ruined floor again is still cheap and still terminates.
    for (let turn = 0; turn < 3; turn += 1) {
      expect(stuck.engine.pump().status).not.toBe('budget');
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// The other half of the report
// ---------------------------------------------------------------------------

describe('one party on the floor does not starve another', () => {
  it('"if i am down, he is unable to take a turn, do anything" — the other party keeps resolving turns', () => {
    // Parties scope the BARRIER; `pump` is LEVEL-WIDE, and deliberately so —
    // per-party would fork the world clock, which world.ts argues against where
    // it declares `TurnState`. So the two parties genuinely share every pump,
    // and the property that has to hold is simply that the second one plays.
    const world = createWorld('other-party-keeps-playing');
    const downed = createDownedState();
    const parties = createPartyState();
    const log = spyLogger();

    const fallen = world.addPlayer('p1', 'Ren');
    fallen.hpRegen = 0;
    fallen.x = DEEP_IN_THE_LEVEL.x;
    fallen.y = DEEP_IN_THE_LEVEL.y;

    // Far away, in the open, with clear floor to the east.
    const playing = world.addPlayer('p2', 'Dalt');
    playing.hpRegen = 0;
    playing.x = 5;
    playing.y = 17;

    world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: ON_TOP_OF_THEM.x,
      y: ON_TOP_OF_THEM.y,
      profile: AiProfile.MeleeChaser,
    });

    const engine = createTurnEngine({ world, downed, parties, log, now: () => 0 });

    // Two parties of one, minted lazily. Neither ever agreed to share a barrier
    // with the other, which is the premise of the whole complaint.
    expect(partyIdOf(parties, 'p1')).not.toBe(partyIdOf(parties, 'p2'));

    world.turn.engagement = 3;
    fallen.hp = 0;
    fallen.alive = false;
    goDown(downed, fallen, world.turn.clock.gameTurn);

    let wipes = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      const from = { x: playing.x, y: playing.y };
      expect(engine.submitMove('p2', 'e').ok).toBe(true);

      const result = engine.pump();
      wipes += wipesIn(result);

      // THE REPORT, INVERTED INTO A PASSING ASSERTION: the move resolved, on the
      // same pump, while the other party was face down on the floor.
      expect({ x: playing.x, y: playing.y }).toEqual({ x: from.x + 1, y: from.y });
      // And the call came back without exhausting its budget — a pump that does
      // is one party churning the loop for everybody else.
      expect(result.status).not.toBe('budget');
    }

    // The premise held throughout: p1's party really did wipe, exactly once, and
    // really did come back.
    expect(wipes).toBe(1);
    expect(survivalOf(downed, 'p1')).toBe(Survival.Up);
    expect(log.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The narration
// ---------------------------------------------------------------------------

describe('the events are broadcast in causal order', () => {
  it('announces the restoration after the blow that caused it and before the blow that follows it', () => {
    // The transcript put "the floor resets" TWO LINES ABOVE the attack that
    // triggered it, because a wipe raised during the monster sweep was filed in
    // the player lane and the player lane is broadcast first. A log that
    // misreports causality costs an evening on the wrong bug.
    //
    // Both lanes are concatenated here in the order the gateway sends them,
    // because that — not the order within one lane — is what a player reads.
    const stuck = scene('causal-order');
    // A second pair of hands on the far side, so that something demonstrably
    // happens AFTER the restoration and inside the same monster turn. Without
    // it, "before the blow that follows it" would be vacuous.
    stuck.world.addMonster('m_witness', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: BEHIND_THEM.x,
      y: BEHIND_THEM.y,
      profile: AiProfile.MeleeChaser,
    });

    const narration = narrationOf(stuck.takeTheKillingBlow());
    const at = (predicate: (event: TurnEvent) => boolean): number => narration.findIndex(predicate);

    const blow = at((event) => event.k === 'attack' && event.id === 'm_husk');
    const damage = at((event) => event.k === 'damage' && event.hp === 0);
    const death = at((event) => event.k === 'death');
    const floored = at((event) => event.k === 'downed');
    const restored = at((event) => event.k === 'erased' && event.reason === ErasedReason.Wipe);
    const next = at((event) => event.k === 'attack' && event.id === 'm_witness');

    expect(blow).toBeGreaterThanOrEqual(0);
    expect(damage).toBeGreaterThan(blow);
    expect(death).toBeGreaterThan(damage);
    expect(floored).toBeGreaterThan(death);
    // THE LINE THE TRANSCRIPT GOT WRONG.
    expect(restored).toBeGreaterThan(floored);
    // ...and the world carried on afterwards, in that order and not before it.
    expect(next).toBeGreaterThan(restored);

    // The restoration is announced ONCE. Two `erased` frames for one body is how
    // a client ends up drawing the marker over somebody who is standing up.
    expect(
      narration.filter((event) => event.k === 'erased' && event.reason === ErasedReason.Wipe),
    ).toHaveLength(1);

    // And the two damage frames tell the story honestly from either side of it:
    // 0 hp before the restoration was announced, a healthy body after. Both
    // numbers are true, at different instants, which is why the engine has to
    // snapshot the first rather than read it off the body once the pump is over.
    const afterwards = narration.slice(restored + 1).find((event) => event.k === 'damage');
    expect(afterwards?.k === 'damage' ? afterwards.hp : -1).toBeGreaterThan(0);
  });
});
