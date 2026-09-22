// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Party.lua:46-88, :271-272
//                       game/modules/tome/class/Actor.lua:2911-2917, :2984-2987
//                       game/modules/tome/data/zones/reknor-escape/npcs.lua:81-95
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `Faction.Squad` — A BODY THE FLOOR LENT YOU, DRIVEN THROUGH THE ENGINE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A temporary companion fights beside the party, belongs to the FLOOR rather
 * than to a player, and is gone by the time anybody takes the way out.
 * `faction.test.ts` holds the predicate table — all five sides, both
 * directions. THIS file is the other half: what the rest of the engine then
 * does about a body on the party's side, asked of the real pump rather than of
 * the predicate.
 *
 * Memory `test-the-join-not-the-halves`: `areEnemies` was already right and
 * every one of the failures below was a line BETWEEN two correct layers — a
 * count that filtered the wrong way, a swap gate that asked `kind`, a credit
 * guard that returned before it could resolve an owner.
 *
 * ═══ THE COMPANION IS BUILT HERE THE WAY THE ACCEPT WILL BUILD IT ═══
 * An ordinary `MonsterActor` with `faction` and `anchorId` written onto the
 * body — no new actor kind, and no content, because there is none yet. That is
 * the shape `engine/actor.ts#Faction.Squad` argues for and the one the brief's
 * accept step performs.
 */

import { describe, expect, it } from 'vitest';

import { AiProfile, Faction, IntentKind, isMonster } from '../../src/server/engine/actor.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { accept, createPartyState, invite, partyOf } from '../../src/server/engine/party.ts';
import { createBarrier, surveyQuorum } from '../../src/server/engine/barrier.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { Affinity, actorsInShape, ballTiles } from '../../src/server/engine/talents.ts';
import { shouldAnnounceCleared, standingThreats } from '../../src/server/world/cleared.ts';
import { canWalk } from '../../src/shared/level.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import {
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { RESOLVE_PER_ADJACENT_ALLY } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import type { MonsterActor, PlayerActor } from '../../src/server/engine/actor.ts';
import type { World } from '../../src/server/world/world.ts';

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * `worthExp(1, ActorRank.Normal, 1)` — a level-1 CORPSE × rank 0.8 × mult 4.
 * The same literal `progression-award.test.ts` uses, and written out rather
 * than imported for the reason that file gives: an award computed by calling
 * the function under test is the function under test.
 */
const AWARD = 1 * 0.8 * 4;

/** A body on the party's side: a monster with a faction and an owner. */
function companionAt(
  world: World,
  id: string,
  at: { readonly x: number; readonly y: number },
  anchorId: string | undefined,
): MonsterActor {
  world.addMonster(id, {
    name: 'Aubrey Keel',
    sprite: HUSK_SPRITE,
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    // Enough to survive being hit. A body that dies mid-test takes the subject
    // of every position assertion off the board with it.
    maxHp: 5000,
    faction: Faction.Squad,
  });
  const body = world.getActor(id);
  if (body === undefined || !isMonster(body)) throw new Error('test fixture: no companion');
  // WRITTEN ONTO THE BODY, NOT PASSED TO `addMonster`, because that is the
  // order the accept performs: the faction flip and the anchor are two writes
  // on a body that already exists (`MonsterActor.anchorId`).
  if (anchorId !== undefined) body.anchorId = anchorId;
  return body;
}

function huskAt(
  world: World,
  id: string,
  at: { readonly x: number; readonly y: number },
  hp = 5000,
): MonsterActor {
  world.addMonster(id, {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    maxHp: hp,
  });
  const body = world.getActor(id);
  if (body === undefined || !isMonster(body)) throw new Error('test fixture: no husk');
  return body;
}

function playerOf(world: World, id: string): PlayerActor {
  const found = world.getActor(id);
  if (found === undefined || found.kind !== ActorKind.Player) {
    throw new Error(`test fixture: ${id} is not a player`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// THE ROOM — a body on your side is not something left to fight
// ---------------------------------------------------------------------------

describe('a companion does not hold the floor open', () => {
  /**
   * `world/cleared.ts` refuses the announcement while `standing > 0`, and
   * `gateway.ts`'s `filedFor` write — the ONLY one in the process — sits behind
   * that call. A companion is a `Monster` and is `alive`, so the reading this
   * count had before `Faction.Bound` ("every monster, alive") would make a
   * cleared floor report one body standing forever: no *"quiet now"*, no *"Word
   * from the moor"*, and no case filed. Permanently, because `residentCounts`
   * never returns to zero and the EDGE the rule needs can never occur again.
   */
  it('is not counted by `standingThreats`, alive or dead, and a husk is', () => {
    const world = createWorld('squad-cleared');
    world.addPlayer('p1', 'Ren');
    const witness = playerOf(world, 'p1');
    const keel = companionAt(world, 'companion', { x: witness.x, y: witness.y + 1 }, 'p1');

    expect(standingThreats(world.allActors(), witness), 'the companion held the floor').toBe(0);
    expect(
      shouldAnnounceCleared({
        previous: 3,
        standing: standingThreats(world.allActors(), witness),
        sawMonsterKill: true,
        standingPlayers: 1,
        already: false,
      }),
      'the room never went quiet',
    ).toBe(true);

    // AND DEAD IS NOT A SECOND RULE. A fallen companion is still a Monster on
    // the board until the reap, and a count that only excluded live ones would
    // hold the floor open for the corpse of the body it just excluded.
    keel.alive = false;
    keel.hp = 0;
    expect(standingThreats(world.allActors(), witness)).toBe(0);

    // THE DISCRIMINATOR. Without it this passes against a count that returns 0
    // for everything.
    huskAt(world, 'm1', { x: witness.x + 2, y: witness.y });
    expect(standingThreats(world.allActors(), witness), 'a real body stopped counting').toBe(1);
  });

  it('does not make a floor UNCLEARED either — the edge is about hostiles', () => {
    // The other direction of the same rule. A floor with one husk and one
    // companion is a floor with ONE thing left, and when that dies the count
    // has to reach zero for the edge (`previous > 0 && standing === 0`) to fire
    // at all.
    const world = createWorld('squad-cleared-edge');
    world.addPlayer('p1', 'Ren');
    const witness = playerOf(world, 'p1');
    companionAt(world, 'companion', { x: witness.x, y: witness.y + 1 }, 'p1');
    const husk = huskAt(world, 'm1', { x: witness.x + 2, y: witness.y });

    const before = standingThreats(world.allActors(), witness);
    husk.alive = false;
    husk.hp = 0;
    const after = standingThreats(world.allActors(), witness);

    expect({ before, after }, 'the last husk dying did not empty the room').toEqual({
      before: 1,
      after: 0,
    });
    expect(
      shouldAnnounceCleared({
        previous: before,
        standing: after,
        sawMonsterKill: true,
        standingPlayers: 1,
        already: false,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE TILE — a companion in a doorway is not a wall
// ---------------------------------------------------------------------------

/** A walkable, empty tile next to `from`, or null. */
function beside(world: World, from: { readonly x: number; readonly y: number }) {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const x = from.x + dx;
    const y = from.y + dy;
    if (canWalk(world.level, x, y) && world.actorAt(x, y) === undefined) return { x, y };
  }
  return null;
}

describe('a player can walk through her own companion', () => {
  it('trades places with it, the way she would with a teammate', () => {
    /**
     * `scheduler.ts`'s swap gate asked `occupant.kind === ActorKind.Player`
     * until a Bound shadow proved it wrong, and the fix it took then —
     * `summonerId !== undefined` — is a fact about SUMMONS. A companion has no
     * summoner, so the same body would have been an absolute wall again:
     * `areEnemies` is false, so the bump-attack branch returns nothing and the
     * step answers `Occupied`.
     *
     * MEASURED for the shadow, on the same gate: 4159 of 13765 ordered steps —
     * 30.2% — refused by a body the player had put there, wins halved. A
     * companion follows the party down corridors by design, so it is the same
     * measurement waiting to be taken again.
     *
     * Upstream grants the permission on the body: Norgan's own template is
     * `move_others=true` (`data/zones/reknor-escape/npcs.lua:91`), and
     * `Party.lua:271-272` sets it for every party member.
     */
    const world = createWorld('squad-swap');
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    ren.maxHp = 9000;
    ren.hp = 9000;
    const spot = beside(world, ren);
    if (spot === null) throw new Error('test fixture: no ground beside the spawn');
    const keel = companionAt(world, 'companion', spot, 'p1');
    const mine = { x: ren.x, y: ren.y };
    const dir = spot.x > ren.x ? 'e' : spot.x < ren.x ? 'w' : spot.y > ren.y ? 's' : 'n';

    const engine = createTurnEngine({ world });
    engine.join('p1');
    engine.setConnected('p1', true);
    expect(engine.submitMove('p1', dir).ok).toBe(true);
    engine.pump();

    expect({ x: ren.x, y: ren.y }, 'her own companion was a wall').toEqual(spot);
    // BOTH HALVES. Asserting only the mover would pass if the companion were
    // deleted, left where it was, or put anywhere at all.
    expect({ x: keel.x, y: keel.y }, 'the companion did not move out of the way').toEqual(mine);
  });

  it('is a SWAP and not a shove-through: the bestiary still fights it', () => {
    /**
     * THE OTHER SIDE OF THE SAME FACTION, and the one the failure half of every
     * escort depends on. A body nothing can kill is a body whose objective
     * cannot fail, so this asserts that a husk standing next to a companion
     * SWINGS AT IT rather than treating it as one of its own.
     *
     * Driven through the real pump: `visibleEnemies` reads `isHostile`, the
     * husk picks the nearest enemy, and `chase` attacks what is in reach. The
     * player is on the board to arm engagement (`anyContact`) — monsters do not
     * act at all in an idle realm, which is `actMonster`'s fixed point.
     */
    const world = createWorld('squad-fight');
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    ren.maxHp = 9000;
    ren.hp = 9000;
    const spot = beside(world, ren);
    if (spot === null) throw new Error('test fixture: no ground beside the spawn');
    const keel = companionAt(world, 'companion', spot, 'p1');
    const next = beside(world, keel);
    if (next === null) throw new Error('test fixture: no ground beside the companion');
    huskAt(world, 'm1', next, 500);

    const engine = createTurnEngine({ world });
    engine.join('p1');
    engine.setConnected('p1', true);

    const full = keel.hp;
    const stood = { x: keel.x, y: keel.y };
    for (let turn = 0; turn < 8; turn += 1) {
      engine.hold('p1');
      engine.pump();
      if (keel.hp < full) break;
    }

    expect(keel.hp, 'nothing on the floor ever swung at the companion').toBeLessThan(full);
    // AND IT WAS A BLOW, NOT A SHOVE. A monster is never the mover on the swap
    // branch, so the companion is standing exactly where it was put.
    expect({ x: keel.x, y: keel.y }, 'a monster traded places with the companion').toEqual(stood);
  });
});

// ---------------------------------------------------------------------------
// THE CREDIT — what a body the party brought is paid for, and to whom
// ---------------------------------------------------------------------------

/**
 * A companion, a husk and a live orb, all far from the party — which is what
 * lets the orb fly in an `idle` pump instead of hanging in the air waiting for
 * a human to decide. `progression-award.test.ts#orbScene` is the shape and the
 * reason for it.
 *
 * The orb is the only way to make a MONSTER land a killing blow without writing
 * an AI fixture: `sourceId` is frozen at the muzzle and the impact credits it.
 */
function orbScene(
  seed: string,
  options: { readonly anchorId: string | undefined; readonly members: number },
) {
  const world = createWorld(seed);
  const barrier = createBarrier();
  const parties = createPartyState();

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 3;
  ren.y = 2;
  for (let i = 2; i <= options.members; i += 1) {
    const mate = world.addPlayer(`p${String(i)}`, `Mate ${String(i)}`);
    mate.x = 3 + i;
    mate.y = 2;
    expect(invite(parties, 'p1', `p${String(i)}`, 0).ok).toBe(true);
    expect(accept(parties, `p${String(i)}`, 'p1', 0).ok).toBe(true);
  }

  const keel = companionAt(world, 'companion', { x: 20, y: 18 }, options.anchorId);
  huskAt(world, 'm_victim', { x: 26, y: 18 }, 10);

  world.addProjectile({
    sourceId: keel.id,
    origin: { x: 20, y: 18 },
    to: { x: 26, y: 18 },
    projSpeed: 2,
    range: 8,
    damage: { dam: 50, type: DamageType.Physical, apr: 0 },
  });

  return {
    world,
    parties,
    keel,
    pumpOnce: () => pump(world, { nowMs: 0, barrier, parties }),
  };
}

describe('a kill by a body the party brought', () => {
  it('pays the ANCHOR’S WHOLE PARTY, at each member’s own level', () => {
    /**
     * `awardExperience` returns at `killer.kind !== ActorKind.Player`, and that
     * guard is load-bearing: `partyOf` MUTATES (party.ts:275-290), so touching
     * the table with a monster's id mints a row only `forgetActor` clears.
     *
     * So the branch RESOLVES AN OWNER and hands party.ts a player's id.
     * Upstream does the same walk for the same reason — `Actor.lua:2984-2987`
     * pays `src:resolveSource()`, and `:2911-2917` is
     * `if self.summoner_gain_exp and self.summoner then return
     * self.summoner:resolveSource() end`: the chain is walked to a ROOT and the
     * root is paid.
     *
     * WITHOUT IT the one thing a companion is for — fighting beside you — pays
     * the people who walked the floor nothing, which is a standing reason to
     * keep it out of the fight.
     */
    const scene = orbScene('squad-credit', { anchorId: 'p1', members: 2 });
    partyOf(scene.parties, 'p1');
    const before = scene.parties.byId.size;

    const result = scene.pumpOnce();

    expect(result.reaped, 'the orb never landed').toEqual(['m_victim']);
    expect(playerOf(scene.world, 'p1').xp, 'the anchor was not paid').toBe(AWARD);
    // THE WHOLE PARTY, not the anchor alone — DECISIONS.md D12, no division by
    // headcount and no proximity check. The mate is nineteen tiles away.
    expect(playerOf(scene.world, 'p2').xp, 'only the anchor was paid').toBe(AWARD);
    // AND NOT ONE PARTY ROW FOR THE BODY THAT SWUNG.
    expect(scene.parties.byId.size, 'a party row was minted for a monster').toBe(before);
    expect(scene.parties.partyOf.has('companion')).toBe(false);
  });

  it('pays NOBODY when the companion has no anchor', () => {
    // A companion whose anchor has taken the stair has no owner on this floor,
    // and inventing one would be inventing a party row. The guard's property is
    // that party.ts is never handed anything but a player's id — so "no owner"
    // has to mean "no payment", not "pay somebody nearby".
    const scene = orbScene('squad-credit-orphan', { anchorId: undefined, members: 2 });
    partyOf(scene.parties, 'p1');
    const before = scene.parties.byId.size;

    const result = scene.pumpOnce();

    expect(result.reaped).toEqual(['m_victim']);
    expect(playerOf(scene.world, 'p1').xp).toBe(0);
    expect(playerOf(scene.world, 'p2').xp).toBe(0);
    expect(scene.parties.byId.size).toBe(before);
  });

  it('pays NOBODY when the anchor does not name a player', () => {
    // THE LEAK GUARD, ASKED THE WAY A BUG WOULD ASK IT. An `anchorId` pointing
    // at a monster is not a case content can produce today; it is what a future
    // mis-write would look like, and the assertion is on the party table's own
    // size because that is the only place the damage would show.
    const scene = orbScene('squad-credit-bad-anchor', { anchorId: 'm_victim', members: 2 });
    partyOf(scene.parties, 'p1');
    const before = scene.parties.byId.size;

    scene.pumpOnce();

    expect(playerOf(scene.world, 'p1').xp).toBe(0);
    expect(scene.parties.byId.size).toBe(before);
    expect(scene.parties.partyOf.has('m_victim')).toBe(false);
  });

  it('pays nobody for the companion’s OWN death, and mints no row for its killer', () => {
    /**
     * THE OTHER DIRECTION, AND IT IS A DECISION RATHER THAN AN ACCIDENT: a
     * companion is worth no experience to anybody. Nothing that can kill one is
     * ever paid — the killer is a Redacted body (or a zone sourced by one), and
     * a Redacted body has no anchor, so the same branch returns.
     *
     * There is deliberately NO victim-side guard to go with this. A player
     * cannot kill a companion at all: `areEnemies` refuses the swing,
     * `Affinity.Hostile` refuses the talent, and the only `friendlyFire` zone in
     * the game is a monster's own death cloud. A guard nothing can reach is a
     * guard no test can break — memory `guard-the-proposer-never-reaches`.
     */
    const world = createWorld('squad-death');
    const barrier = createBarrier();
    const parties = createPartyState();
    /**
     * ═══ REN STANDS BESIDE HER, AND THE SHOOTER IS BLIND — BOTH SO THAT
     *     NOTHING IN THIS SCENE MOVES ═══
     * A companion further than `FOLLOW_LEASH` from its person takes a step
     * toward them on an idle pump (`ai/npc.ts#followStep`), so a fixture that
     * parked its anchor across the map would have the subject walk out of the
     * line of the orb aimed at it — and the assertion below would read
     * "nobody died" when what happened was "she dodged". Standing the anchor
     * next to her is the state the follow rule is written to produce anyway.
     *
     * The shooter's aggro radius then goes to zero, because `anyContact` is
     * monster-to-PLAYER: a husk that can see Ren puts the floor in combat, and
     * a fight is the one thing this scene is not about. Its orb is already in
     * the air and does not care what it can see.
     */
    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 26;
    ren.y = 17;

    huskAt(world, 'm_shooter', { x: 20, y: 18 }).ai.aggroRange = 0;
    const keel = companionAt(world, 'companion', { x: 26, y: 18 }, 'p1');
    keel.maxHp = 10;
    keel.hp = 10;

    world.addProjectile({
      sourceId: 'm_shooter',
      origin: { x: 20, y: 18 },
      to: { x: 26, y: 18 },
      projSpeed: 2,
      range: 8,
      damage: { dam: 50, type: DamageType.Physical, apr: 0 },
    });

    partyOf(parties, 'p1');
    const before = parties.byId.size;
    const result = pump(world, { nowMs: 0, barrier, parties });

    expect(result.reaped, 'the companion did not die').toEqual(['companion']);
    expect(playerOf(world, 'p1').xp, 'somebody was paid for a companion').toBe(0);
    expect(parties.byId.size).toBe(before);
    expect(parties.partyOf.has('companion')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE CLOCK — a body nobody drives must not hang it
// ---------------------------------------------------------------------------

describe('a companion costs the Bell nothing', () => {
  it('is never in the quorum, blocking or standing by', () => {
    /**
     * `inQuorum` is `kind === ActorKind.Player && alive && connected &&
     * !standingBy`, so a monster is counted in neither column. Asserted through
     * `surveyQuorum` with a real board rather than off the predicate, because
     * the failure this is about is the Knot's crossing bug: a body that owes a
     * decision nobody can make stops the floor for everybody, and it presents
     * as a turn that never resolves rather than as a wrong number.
     *
     * The companion is driven by `actMonster` like any other monster, so it
     * never owes one — it is given an intent by the AI on every turn it acts.
     */
    const world = createWorld('squad-quorum');
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    ren.connected = true;
    const spot = beside(world, ren);
    if (spot === null) throw new Error('test fixture: no ground beside the spawn');
    companionAt(world, 'companion', spot, 'p1');

    // ENGAGEMENT UP, which is the only state in which anybody blocks at all.
    world.turn.engagement = 3;
    const snapshot = surveyQuorum(world.allActors(), world.turn);

    expect(snapshot.total, 'the companion was counted in the quorum').toBe(1);
    expect(snapshot.blocking).not.toContain('companion');
    expect(snapshot.standingBy).not.toContain('companion');
  });

  it('resolves a turn with one player and a companion on the board', () => {
    // THE SAME FACT, END TO END: one person presses a key and the world moves.
    // A companion in the quorum would leave this pump waiting forever.
    const world = createWorld('squad-quorum-live');
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    const spot = beside(world, ren);
    if (spot === null) throw new Error('test fixture: no ground beside the spawn');
    companionAt(world, 'companion', spot, 'p1');

    const engine = createTurnEngine({ world });
    engine.join('p1');
    engine.setConnected('p1', true);
    const was = world.turn.clock.gameTurn;
    expect(engine.hold('p1').ok).toBe(true);
    engine.pump();

    expect(world.turn.clock.gameTurn, 'the turn never resolved').toBeGreaterThan(was);
  });
});

// ---------------------------------------------------------------------------
// THE INTENT — a companion is not aimed at
// ---------------------------------------------------------------------------

describe('the party cannot swing at its own companion', () => {
  it('refuses an Attack intent against it, and lands one on a husk', () => {
    /**
     * `strike` opens on `isHostile`, so this is `areEnemies` reaching the one
     * place a player could hurt the body on purpose. Driven through the real
     * intent path, and with the husk as the DISCRIMINATOR: without it the test
     * passes against an attack that is broken for everybody.
     */
    const world = createWorld('squad-noswing');
    const barrier = createBarrier();
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    ren.maxHp = 9000;
    ren.hp = 9000;
    ren.combat = { weapon: { dam: 20, atk: 100, damRange: 1.0 }, minRange: 0 };
    const spot = beside(world, ren);
    if (spot === null) throw new Error('test fixture: no ground beside the spawn');
    const keel = companionAt(world, 'companion', spot, 'p1');

    submitIntent(world, barrier, 'p1', { kind: IntentKind.Attack, targetId: 'companion' });
    pump(world, { nowMs: 0, barrier });
    expect(keel.hp, 'the party hit its own companion').toBe(keel.maxHp);

    // AND THE SAME SWING LANDS ON SOMETHING REDACTED.
    keel.alive = false;
    world.removeActor('companion');
    const husk = huskAt(world, 'm1', spot, 500);
    submitIntent(world, barrier, 'p1', { kind: IntentKind.Attack, targetId: 'm1' });
    pump(world, { nowMs: 100, barrier });
    expect(husk.hp, 'the swing does not work at all').toBeLessThan(husk.maxHp);
  });
});

// ---------------------------------------------------------------------------
// THE HEAL — an Ally affinity finds the body the party brought
// ---------------------------------------------------------------------------

describe('an Ally-affinity shape includes a companion and excludes a shopkeeper', () => {
  it('picks the sides `isFriend` picks, because it asks the same predicate', () => {
    /**
     * `actorsInShape`'s Ally arm was the SECOND copy of the same-side rule,
     * written inline as `actor.kind !== self.kind` thirty lines from
     * `isFriend` and invisible to a grep for it. Its only caller is Mend
     * Wounds, so the consequence was concrete: the Alchemist's field kit bound
     * Merrow Stitch standing behind her counter, and did not bind the body her
     * own party had brought down the stairs.
     *
     * Driven against the REAL `World` — `engine/talents.ts` carries a
     * compile-time proof that it satisfies `TalentWorld`, so this is the
     * production join and not a fixture's idea of one.
     */
    const world = createWorld('squad-ally-shape');
    world.addPlayer('p1', 'Ren');
    const ren = playerOf(world, 'p1');
    const mate = world.addPlayer('p2', 'Sol');
    mate.x = ren.x + 1;
    mate.y = ren.y;
    companionAt(world, 'companion', { x: ren.x, y: ren.y + 1 }, 'p1');
    world.addMonster('shopkeep', {
      name: 'Merrow Stitch',
      sprite: HUSK_SPRITE,
      x: ren.x - 1,
      y: ren.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
      faction: Faction.Townsfolk,
    });
    huskAt(world, 'm1', { x: ren.x, y: ren.y - 1 }, 500);

    const found = actorsInShape(
      world,
      ren,
      ballTiles(world, { x: ren.x, y: ren.y }, 2),
      Affinity.Ally,
    ).map((body) => body.id);

    expect(found, 'the companion is not an ally of the party').toContain('companion');
    expect(found, 'the caster is not in her own disc').toContain('p1');
    expect(found, 'a teammate stopped being an ally').toContain('p2');
    expect(found, 'a shopkeeper was inside a party heal').not.toContain('shopkeep');
    expect(found, 'a husk was inside a party heal').not.toContain('m1');
  });
});

// ---------------------------------------------------------------------------
// THE BAR — "adjacent to an ally" is the same rule a third time
// ---------------------------------------------------------------------------

/**
 * A Watchman on empty floor with one body beside him and the adapter
 * `src/server/main.ts` actually ships. Modelled on `class-wiring.test.ts`'s
 * bench, minus its husk: this measures the ALLY half of Resolve's income, and
 * a body landing blows pays `RESOLVE_ON_STRUCK` into the same bar.
 */
function resolveBench(seed: string, beside: 'none' | 'companion' | 'shopkeeper' | 'husk'): number {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const player = world.addPlayer('p1', 'Ren', {
    maxHp: WATCHMAN.maxHp,
    combat: WATCHMAN.combat,
    classId: WATCHMAN.id,
  });
  player.x = 10;
  player.y = 10;
  player.hpRegen = 0;
  player.combat = { ...WATCHMAN.combat, mods: { ...WATCHMAN.combat?.mods, def: 10_000 } };

  if (beside === 'companion') companionAt(world, 'companion', { x: 11, y: 10 }, 'p1');
  if (beside === 'husk') {
    const body = huskAt(world, 'm1', { x: 11, y: 10 }, 5000);
    // ACCURACY SO LOW IT CANNOT LAND. A blow pays `RESOLVE_ON_STRUCK` into the
    // same bar, so a husk that connects would read as ally income and the test
    // would pass for the opposite of its reason. `hitChance` floors at 5%, so
    // the player's defence carries the other half.
    body.combat = { mods: { atk: -10_000 } };
  }
  if (beside === 'shopkeeper') {
    world.addMonster('shopkeep', {
      name: 'Merrow Stitch',
      sprite: HUSK_SPRITE,
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 5000,
      faction: Faction.Townsfolk,
    });
  }

  const talents = createContentTalentEngine();
  const sheet = talents.attach('p1', sheetForClass(WATCHMAN));
  const engine = createTurnEngine({
    world,
    now: () => 0,
    talentRuntime: talentRuntimeFor(talents, world),
  });
  engine.join('p1');
  // ═══ EMPTIED FIRST — RESOLVE IS BORN FULL ═══
  // `ActorResource.lua:131` creates an actor holding `maxname`, so every figure
  // here is an ACCRUAL from a floor. Leave the bar at 100 and every assertion
  // becomes "still 100", which is equally true of paying nothing.
  sheet.resource.value = 0;

  for (let turn = 0; turn < 4; turn += 1) {
    world.turn.engagement = 3;
    expect(engine.hold('p1').ok).toBe(true);
    engine.pump();
  }
  return sheet.resource.value;
}

describe('the Watchman’s Resolve counts the bodies his party brought', () => {
  it('pays for a companion beside him, and not for a shopkeeper', () => {
    /**
     * `regenFor`'s Resolve case is the THIRD statement of the same-side rule —
     * *"builds when struck and when adjacent to an ally"* asked as
     * `other.kind !== actor.kind`. It paid him for standing at a counter in
     * Alderbrook and paid nothing for standing beside a body his own party had
     * brought down the stairs. Both halves are the same line.
     *
     * Measured as three benches against each other rather than as an absolute:
     * the flat trickle (`RESOLVE_PER_TURN`) pays in all three, so the FIGURE
     * would pin the trickle and not the clause.
     */
    const alone = resolveBench('resolve-alone', 'none');
    const withCompanion = resolveBench('resolve-companion', 'companion');
    const withShopkeeper = resolveBench('resolve-keeper', 'shopkeeper');

    expect(withCompanion, 'a companion beside him paid nothing').toBeGreaterThan(alone);
    expect(withShopkeeper, 'a shopkeeper paid him for standing at her counter').toBe(alone);
    /**
     * THE SIZE OF IT, so this cannot pass on a trickle that happened to differ
     * — a whole number of `RESOLVE_PER_ADJACENT_ALLY`, at least one per turn
     * held. NOT an exact figure: `class-wiring.test.ts` records that N pumps
     * carry N + 1 base passes (the first carries two), and pinning that here
     * would be pinning the pump's shape rather than this clause.
     */
    expect((withCompanion - alone) % RESOLVE_PER_ADJACENT_ALLY).toBe(0);
    expect(withCompanion - alone).toBeGreaterThanOrEqual(RESOLVE_PER_ADJACENT_ALLY * 4);
  });

  it('does not pay for a husk standing on him', () => {
    // The discriminator in the other direction: "adjacent" is not the rule,
    // "adjacent AND on my side" is. A husk swings, so this bench would read
    // high for the wrong reason if the clause ever counted enemies — and the
    // blows it lands are `RESOLVE_ON_STRUCK`, which is not what is under test.
    const alone = resolveBench('resolve-alone-2', 'none');
    const withHusk = resolveBench('resolve-husk', 'husk');
    expect(withHusk, 'a husk beside him counted as an ally').toBe(alone);
  });
});
