// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/zones/reknor-escape/npcs.lua:81-115
//                       game/modules/tome/class/Party.lua:68-69, :136-139
//                       game/modules/tome/class/GameState.lua:2624-2636
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ESCORT — SOMEBODY WALKS WITH YOU, AND IS GONE BY THE STAIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ruling this implements: *"temporary companions in level usually come with
 * an in level quest... so the companion npc is gone by the time you exit that
 * floor."*
 *
 * `squad.test.ts` holds what the ENGINE does about a body on the party's side —
 * the hostility table, the swap, the credit, the quorum. `brief.test.ts` holds
 * the objective LAYER — the identity, the arming, the frame, the edge. This
 * file is the join of the two: a body the floor lends you, with somewhere to be
 * taken.
 *
 * ═══ WHAT EACH TEST MUST KILL ═══
 * Every case below names the mutant it was written against, because a test that
 * passes when its rule is broken is a test of the fixture. Each was applied,
 * watched fail, and restored by hash.
 *
 * ═══ AND THE FOLLOWING IS DRIVEN THROUGH `pump`, NEVER REASONED ABOUT ═══
 * The idle gate is the one edit in this feature that can hang the scheduler:
 * `actMonster` refuses every monster a turn out of combat precisely so the
 * level can reach a fixed point, and a companion is the one body allowed out of
 * that. So the cases that matter here assert what the CLOCK did, not merely
 * where the body ended up.
 */

import { describe, expect, it } from 'vitest';

import { Faction, HOLD_INTENT } from '../../src/server/engine/actor.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { COMPANION_LEASH, FOLLOW_LEASH } from '../../src/server/ai/npc.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { tileDistance } from '../../src/shared/distance.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../src/shared/sight.ts';
import { liteRadiusOf } from '../../src/server/engine/derived.ts';
import { visibleActorIds } from '../../src/server/view/projector.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { FIELD_FOLK } from '../../src/server/content/townsfolk.ts';
import { STRANDED_HAND } from '../../src/server/content/monsters.ts';
import { SITES, createRealms, stairsDownOf } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
import {
  BriefKind,
  BriefState,
  acceptBrief,
  armBrief,
  closeFloorBriefs,
  noteBriefProgress,
} from '../../src/server/world/brief.ts';
import type { Brief, BriefSpec } from '../../src/server/world/brief.ts';
import type { MonsterActor, PlayerActor } from '../../src/server/engine/actor.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { World } from '../../src/server/world/world.ts';

const UNDERWORKS = 'site:underworks';

const WHO = FIELD_FOLK.get('callow');
if (WHO === undefined) throw new Error('nobody in FIELD_FOLK offers an escort');

/** The shipped sheet, so nothing here is proved against a body the game does not place. */
const WALK_OUT: BriefSpec = {
  id: 'test:the-way-back',
  kind: BriefKind.Escort,
  floors: [1, 3],
  title: 'The way back, with her',
  detail: 'One of the crew is still on her feet, and wants the surface.',
  reward: { level: 3, rank: ActorRank.Elite },
  offerer: WHO,
  escort: { after: 'leaves', body: STRANDED_HAND },
};

const ERRAND: BriefSpec = { ...WALK_OUT, escort: { after: 'stays', body: STRANDED_HAND } };

const QUARRY: BriefSpec = {
  id: 'test:kept-its-name',
  kind: BriefKind.Quarry,
  floors: [1, 3],
  title: 'It kept its name',
  detail: 'One of them down there still answers to something.',
  reward: { level: 3, rank: ActorRank.Elite },
  offerer: WHO,
  quarry: { name: 'Maundy', mark: 'UNMAKE THIS ONE' },
};

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

function makeRealms(seed: string): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

/** A delve floor carrying one authored objective. */
function floorWith(specs: readonly BriefSpec[], seed: string, floor = 1): Realm {
  const def: SiteDef = { ...site(UNDERWORKS), briefs: specs };
  return makeRealms(seed).open(def, `party-${seed}`, undefined, undefined, undefined, floor);
}

/** The body the brief stood up, as a monster. */
function bodyOf(realm: Realm, id: string | null): MonsterActor {
  const body = id === null ? undefined : realm.world.getActor(id);
  if (body === undefined || body.kind !== ActorKind.Monster) {
    throw new Error('test fixture: no body on the floor');
  }
  return body;
}

/** A floor with the objective taken on, and one player standing on it. */
function taken(specs: readonly BriefSpec[], seed: string): { realm: Realm; brief: Brief } {
  const realm = floorWith(specs, seed);
  const armed = armBrief(realm);
  if (armed === undefined) throw new Error('test fixture: nothing armed');
  realm.world.addPlayer('p1', 'Ren');
  const brief = acceptBrief(realm, 'p1');
  if (brief === undefined) throw new Error('test fixture: the accept was refused');
  return { realm, brief };
}

/** Put a body on a tile, ignoring the movement rules — see `World.addMonster`. */
function stand(actor: { x: number; y: number }, at: TileXY): void {
  actor.x = at.x;
  actor.y = at.y;
}

/**
 * A run of open ground: `length` tiles in a row, walkable, empty and not a way
 * in or out. Found by a sweep rather than authored, because the world under
 * test is a generated one and a hard-coded corridor is a fixture that goes
 * stale the day the generator changes.
 */
function openRun(world: World, length: number): TileXY[] {
  for (let y = 1; y < world.level.h - 1; y += 1) {
    for (let x = 1; x + length < world.level.w; x += 1) {
      const run: TileXY[] = [];
      for (let i = 0; i < length; i += 1) {
        if (!canWalk(world.level, x + i, y)) break;
        if (world.actorAt(x + i, y) !== undefined) break;
        run.push({ x: x + i, y });
      }
      if (run.length === length) return run;
    }
  }
  throw new Error('the floor has no open run on it');
}

/** A companion: an ordinary monster on the party's side, with somebody to follow. */
function companionAt(world: World, id: string, at: TileXY, anchorId?: string): MonsterActor {
  world.addMonster(id, {
    name: 'Maud Callow',
    sprite: STRANDED_HAND.sprite,
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    // Enough to survive being hit. A body that dies mid-test takes the subject
    // of every position assertion off the board with it.
    maxHp: 5000,
    faction: Faction.Squad,
  });
  const body = world.getActor(id);
  if (body === undefined || body.kind !== ActorKind.Monster) throw new Error('no companion');
  if (anchorId !== undefined) body.anchorId = anchorId;
  return body;
}

function husk(world: World, id: string, at: TileXY): MonsterActor {
  world.addMonster(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    maxHp: 5000,
  });
  const body = world.getActor(id);
  if (body === undefined || body.kind !== ActorKind.Monster) throw new Error('no husk');
  return body;
}

function playerOf(world: World, id: string): PlayerActor {
  const body = world.getActor(id);
  if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no player');
  return body;
}

/** One pump, and what the clock did in it. */
function step(world: World, parties = createPartyState()): { turns: number } {
  const before = world.turn.clock.gameTurn;
  pump(world, { nowMs: 0, barrier: createBarrier(), parties });
  return { turns: world.turn.clock.gameTurn - before };
}

// ===========================================================================
// 1. THE BODY THE FLOOR LENDS YOU
// ===========================================================================

describe('the body an escort stands up', () => {
  /**
   * A COMPANION HAS TO BE ABLE TO WALK THROUGH THE FIGHT IT IS BEING WALKED
   * THROUGH, and `standFolk`'s ordinary body cannot: five hundred hit points
   * nothing may touch, no weapon and no aggro range.
   *
   * MUTANT: drop the `sheet` argument at the `standFolk` call in `armBrief`.
   * The person is still offered, the conversation still works, the objective
   * still closes if you walk them to the door — and the first husk that reaches
   * them stands there swinging at somebody who cannot swing back.
   */
  it('can fight, where a quarry`s offerer deliberately cannot', () => {
    const escort = floorWith([WALK_OUT], 'escort-body');
    const walker = bodyOf(escort, armBrief(escort)?.offererId ?? null);
    expect(walker.faction, 'the floor may attack them before the accept').toBe(Faction.Townsfolk);
    expect(walker.combat?.weapon?.dam, 'nothing to swing with').toBeGreaterThan(0);
    expect(walker.ai.aggroRange, 'nothing it can notice').toBeGreaterThan(0);
    expect(walker.maxHp).toBeLessThan(500);

    const quarry = floorWith([QUARRY], 'quarry-body');
    const standing = bodyOf(quarry, armBrief(quarry)?.offererId ?? null);
    expect(standing.maxHp, 'a shopkeeper grew a sheet').toBe(500);
    expect(standing.ai.aggroRange).toBe(0);
  });

  /**
   * LEVELLED OFF THE FLOOR, NOT AUTHORED. Upstream levels its escortee with the
   * zone's own `actor_adjust_level` roll (`reknor-escape/zone.lua:26`); ours
   * cannot take that draw without moving the world's labelled stream, so it
   * reads the answer the floor already computed.
   *
   * MUTANT: return `spec.reward.level` unconditionally, or drop
   * `COMPANION_LEVEL_BONUS`. Both give a body that stops keeping up the moment
   * the delve curve moves, and neither is visible in any other test.
   */
  it('is born one level over the deepest thing standing on the floor', () => {
    const realm = floorWith([WALK_OUT], 'escort-level');
    const deepest = Math.max(
      ...realm.world
        .allActors()
        .filter((a) => a.kind === ActorKind.Monster)
        .map((a) => a.level),
    );
    expect(deepest, 'the floor generated nothing to measure against').toBeGreaterThan(0);
    const walker = bodyOf(realm, armBrief(realm)?.offererId ?? null);
    expect(walker.level).toBe(deepest + 1);
  });

  /**
   * ACCEPTING FLIPS THE BODY THAT IS ALREADY STANDING THERE. No second body is
   * spawned, and the anchor is written BEFORE the faction — upstream's own
   * lesson from `Party.lua:68-69`, where the leash is set before `addMember`
   * so the default cannot overwrite it. Here it is the idle gate that reads the
   * faction, so one pump between the two writes would be a companion with
   * nothing to follow.
   *
   * MUTANT: leave the faction alone. Everything else still passes — the brief
   * opens, the strip goes out — and the floor never notices the body, which is
   * the whole of what accepting was supposed to mean.
   */
  it('changes sides on the accept, and it is the same body', () => {
    const realm = floorWith([WALK_OUT], 'escort-accept');
    const armed = armBrief(realm);
    if (armed === undefined) throw new Error('test fixture: nothing armed');
    // COUNTED BEFORE, AND THAT IS THE WHOLE ASSERTION. It used to be counted
    // twice AFTER, against itself, under this comment — an expectation that
    // cannot fail, which memory `membership-is-not-a-rank` is about.
    const before = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
    realm.world.addPlayer('p1', 'Ren');
    const brief = acceptBrief(realm, 'p1');
    if (brief === undefined) throw new Error('test fixture: the accept was refused');

    expect(brief.companionId, 'the companion is not the person who offered').toBe(brief.offererId);
    const walking = bodyOf(realm, brief.companionId);
    expect(walking.faction).toBe(Faction.Squad);
    expect(walking.anchorId).toBe('p1');
    expect(
      realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length,
      'a second body was spawned',
    ).toBe(before);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PERSON'S NAME AND FACE WIN, AND THE SHEET IS ONLY THE NUMBERS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `standFolk` spreads the template's sheet and then writes the authored
   * person's `name` and `sprite` over it. Those two lines are a RULE and not an
   * ordering accident: the template is a working title (*"Stranded Hand"*) and
   * a fallback miner sprite, and the body the party is asked to keep alive is a
   * named person they have just had a conversation with.
   *
   * MUTANT: move the `name`/`sprite` pair ABOVE the sheet spread in
   * `content/townsfolk.ts`. Nothing else in the suite moves, and every hover
   * card on the shipped floor reads *"Stranded Hand"* over a stranger's face.
   */
  it('wears the person`s name and face, not the template`s', () => {
    const realm = floorWith([WALK_OUT], 'escort-name');
    const walker = bodyOf(realm, armBrief(realm)?.offererId ?? null);
    expect(WHO.name, 'the fixture cannot tell the two apart').not.toBe(STRANDED_HAND.displayName);
    expect(walker.name).toBe(WHO.name);
    expect(walker.sprite).toBe(WHO.sprite);
    // AND THE NUMBERS ARE THE TEMPLATE'S, which is the half that must NOT be
    // overwritten — otherwise the rule above would read as "ignore the sheet".
    // `maxHp` is not the discriminator: `monsterInit` spends `rank` and `level`
    // through `rankLifeAdjust`, so it is the sheet's number SCALED. The rank
    // itself is not scaled by anything.
    expect(walker.rank).toBe(STRANDED_HAND.rank);
    expect(walker.maxHp, 'a shopkeeper`s body').not.toBe(500);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SHE CARRIES A LIGHT, AND WITHOUT IT THE PARTY NEVER SEES HER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `npcs.lua:97` gives Norgan a LITE slot and `:101` fills it with a brass
   * lantern; ours is that lantern's own radius (`content/items.ts`,
   * `item_brass_lantern`) written onto the sheet.
   *
   * IT IS NOT DECORATION AND THE MEASUREMENT IS THE POINT: `FOLLOW_LEASH` is
   * chebyshev and a detective's lantern is ToME's radius-2 circle, so a
   * companion holding station on the diagonal behind you, (2,2), rounds to 3:
   * outside the light, in a dark delve. Rendered through the real client
   * before this line existed, her tile was black for an entire eight-turn walk
   * and the board dropped and re-acquired her six times on one floor.
   *
   * ═══ AND THE CASE THIS PINNED MOVED WITH SIGHT ═══
   * It stood her at (2,1), 2.24 long, outside the lantern when the lantern was
   * the exact disc. ToME's circle rounds that to 2 and holds it: the lantern's
   * shadowcast (shared/vision.ts, pass 2) lights her tile with no help from
   * hers. So the case is (2,2) now, and (2,1) is pinned as the eye's own.
   *
   * MUTANT: drop `lite` from the sheet's `mods`. Nothing fails but the party
   * cannot see the one body they were asked to keep alive.
   */
  it('carries a light that reaches past the leash it follows at', () => {
    const realm = floorWith([WALK_OUT], 'escort-lantern');
    const walker = bodyOf(realm, armBrief(realm)?.offererId ?? null);
    expect(liteRadiusOf(walker), 'she walks in the dark with nothing').toBeGreaterThan(0);

    // ═══ AND THE DRIVE, BECAUSE THE NUMBER ALONE PROVES NOTHING ═══
    // A dark floor, a detective carrying the ordinary brass lantern, and the
    // companion holding station at the far corner of what `followStep` allows:
    // two back and two across. That is `FOLLOW_LEASH` by the rule she follows
    // and 3 by the rule light is measured in (`tileDistance`, 2.83 rounded),
    // and the gap between those two metrics is the whole bug.
    const dark = createWorld('escort-lantern-dark', undefined, '', { litRoomChance: 0 });
    dark.level.tiles.fill(TileCode.FLOOR);
    const eye = { x: 8, y: 8, combat: { mods: { lite: 2 } } };
    const at = { x: eye.x + FOLLOW_LEASH, y: eye.y + FOLLOW_LEASH };
    expect(chebyshev(eye, at), 'not where she may stand').toBe(FOLLOW_LEASH);
    expect(tileDistance(eye, at), 'inside the lantern after all').toBeGreaterThan(2);

    const held = companionAt(dark, 'companion', at, 'p1');
    expect(visibleActorIds(dark, [eye]).has('companion'), 'no light of her own').toBe(false);
    held.combat = { ...held.combat, mods: { ...held.combat?.mods, lite: liteRadiusOf(walker) } };
    expect(visibleActorIds(dark, [eye]).has('companion'), 'her own lantern').toBe(true);

    // (2,1), the case this used to pin: the detective's circle holds it, so
    // she is seen there without a light of her own.
    const knight = createWorld('escort-lantern-knight', undefined, '', { litRoomChance: 0 });
    knight.level.tiles.fill(TileCode.FLOOR);
    const beside = { x: eye.x + FOLLOW_LEASH, y: eye.y + 1 };
    expect(Math.hypot(beside.x - eye.x, beside.y - eye.y), 'not the old case').toBeGreaterThan(2);
    companionAt(knight, 'companion', beside, 'p1');
    expect(visibleActorIds(knight, [eye]).has('companion'), 'the lantern`s own circle').toBe(true);
  });

  /**
   * AND IT REFUSES WHEN THERE IS NOBODY LEFT TO WALK ANYWHERE — the same guard
   * the quarry has for the same reason: an objective opened with no body in it
   * can never close, and the offer standing is better than a brief that cannot.
   *
   * MUTANT: open the brief anyway. The strip comes up on an objective with no
   * subject, and the only way out of it is walking off the floor.
   */
  it('refuses the accept when the person is no longer standing there', () => {
    const realm = floorWith([WALK_OUT], 'escort-gone');
    const armed = armBrief(realm);
    realm.world.removeActor(armed?.offererId ?? '');
    realm.world.addPlayer('p1', 'Ren');
    expect(acceptBrief(realm, 'p1')).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Offered);
  });
});

// ===========================================================================
// 2. FOLLOWING, AND THE FIXED POINT IT IS NOT ALLOWED TO BREAK
// ===========================================================================

describe('a companion follows, one step at a time', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE IDLE GATE. `actMonster` refuses every monster a turn while
   * `engagement <= 0` and its own essay says why: *"something has to spend
   * energy for the level to keep ticking, and then the server has a game loop
   * and a home PC has a fan."*
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A companion is the one body allowed out of that, and the allowance is
   * bounded twice. This case pins BOTH bounds and the arrival:
   *
   *   ONE STEP PER PUMP. MUTANT: delete `Run.followed`. `tickLevel` keeps
   *     granting energy while anything is spending it, so the companion walks
   *     the whole distance inside the single pump one keypress opened —
   *     six game turns of regeneration, cooldowns and effect timers bought by
   *     walking away from your own companion and back.
   *   IT STOPS AT `FOLLOW_LEASH`. MUTANT: `<=` to `<`. It shuffles one tile
   *     closer than it should and the assertion on the distance catches it.
   *   AND THE CLOCK STOPS WITH IT. MUTANT: delete the whole idle clause and
   *     the body never moves at all; keep the clause but let it act when it is
   *     already beside you and the level never idles.
   */
  it('closes the distance a step per pump and then stops', () => {
    const world = createWorld('escort-follow');
    const run = openRun(world, FOLLOW_LEASH + 5);
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) throw new Error('no run');

    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    const keel = companionAt(world, 'companion', last, 'p1');
    world.turn.engagement = 0;

    const started = chebyshev(keel, first);
    expect(started, 'the fixture did not put them apart').toBe(FOLLOW_LEASH + 4);

    // ONE PUMP, ONE STEP. Asserted before the loop, because "it arrived" is
    // true of the unbounded version too.
    step(world);
    expect(chebyshev(keel, first), 'more than one step in one pump').toBe(started - 1);

    for (let i = 0; i < 8; i += 1) step(world);
    expect(chebyshev(keel, first)).toBe(FOLLOW_LEASH);

    // AND THE LEVEL IS BACK AT ITS FIXED POINT: a pump with nobody to catch up
    // to advances no clock at all.
    expect(step(world).turns, 'the floor kept ticking with nothing happening').toBe(0);
  });

  /**
   * A BODY WITH NOBODY TO FOLLOW IS AN ORDINARY MONSTER OUT OF COMBAT: it does
   * not move, and the level idles. Three ways to have nobody — no anchor at
   * all, an anchor who took the stair, and an anchor who is DOWN — and the
   * third is the one that is a decision rather than an absence.
   *
   * MUTANT: drop the `alive`/`kind` checks in `makeAiCtx`'s `anchorAt`. A
   * companion then walks back to stand over a body that is not going anywhere,
   * out of the fight that put it there.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PERSON THEY ARE WITH TOOK THE STAIR, SO THEY ARE WITH SOMEBODY ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tome/class/Game.lua:1282-1283` re-points `tactic_leash_anchor` at whoever
   * the player currently is. Ours has a party, so it is the nearest member
   * still standing on the floor — and it is the design's C.5 and its test 19.
   *
   * WITHOUT IT THE SHIPPED OBJECTIVE IS UNWINNABLE FOR HALF A PARTY. Splitting
   * at a stair is an ordinary co-op move; `anchorId` was written once at the
   * accept and cleared once at the close, so the half that stayed behind walked
   * to the way out beside a body that never took another step.
   *
   * MUTANT: delete `keepAnchor`'s call, or let it fire while the held anchor is
   * still on the floor. The first strands her; the second makes her change
   * owner every corridor, which is the mutant the design names.
   */
  it('follows whoever is left when its person leaves the floor', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-repoint');
    const world = realm.world;
    const walking = bodyOf(realm, brief.companionId);
    expect(walking.anchorId, 'the accepter is the anchor').toBe('p1');

    // ═══ A SECOND MEMBER, NEARER — AND THE ANCHOR DOES NOT MOVE ═══
    // The re-point is about ABSENCE, never about distance. A companion that
    // re-homed on proximity would change owner every corridor.
    world.addPlayer('p2', 'Mate');
    stand(playerOf(world, 'p2'), { x: walking.x + 1, y: walking.y });
    stand(playerOf(world, 'p1'), farFrom(realm, walking));
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(walking.anchorId, 'it changed owner for a nearer body').toBe('p1');

    // ═══ AND NOW THE ACCEPTER TAKES THE STAIR ═══
    world.removePlayer('p1');
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(walking.anchorId, 'she was left standing there').toBe('p2');

    // AND IT IS A FOLLOW AND NOT A FIELD: the body walks toward the person the
    // leash now names. Test the join, not the halves.
    //
    // THE FLOOR IS EMPTIED FIRST, and it is not tidying: `updateEngagement`
    // re-reads the room every pump, so one generated husk within aggro of the
    // remaining member puts the level in combat, parks the player on a decision
    // nobody in a unit test makes, and `tickLevel` stops before it ever reaches
    // the companion.
    for (const body of world.allActors()) {
      if (body.kind === ActorKind.Monster && body.id !== walking.id) world.removeActor(body.id);
    }
    const away = openRun(world, FOLLOW_LEASH + 5);
    const first = away[0];
    const last = away.at(-1);
    if (first === undefined || last === undefined) throw new Error('no run');
    stand(playerOf(world, 'p2'), first);
    stand(walking, last);
    world.turn.engagement = 0;
    const started = chebyshev(walking, first);
    step(world);
    step(world);
    expect(chebyshev(walking, first), 'she never took a step for the one left').toBeLessThan(
      started,
    );
  });

  /**
   * ═══ AND WHEN THERE IS NOBODY LEFT AT ALL, THE LEASH IS NOT RE-POINTED ═══
   * That leaver was the last one and `closeFloorBriefs` is already running for
   * it. Inventing an owner here would be inventing a party row.
   *
   * MUTANT: fall back to any body on the floor. The husk that killed the party
   * acquires a companion.
   */
  it('is left holding nobody when the floor empties', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-repoint-none');
    const walking = bodyOf(realm, brief.companionId);
    realm.world.removePlayer('p1');
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(walking.anchorId, 'it adopted something on the floor').toBe('p1');
  });

  it('does not move for an anchor that is gone, or never was', () => {
    const world = createWorld('escort-no-anchor');
    const run = openRun(world, FOLLOW_LEASH + 5);
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) throw new Error('no run');
    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    world.turn.engagement = 0;

    const orphan = companionAt(world, 'orphan', last, undefined);
    const lost = companionAt(world, 'lost', { x: last.x, y: last.y - 1 }, 'nobody-here');

    // ONE PUMP TO SETTLE, AND IT IS NOT THE ASSERTION. A body added to a world
    // starts below the act threshold, so the first pump after any fixture is
    // built grants energy until everybody is at the cap — and a granting sweep
    // advances the clock whatever anybody decides. The fixed point is the pump
    // AFTER that one.
    step(world);
    const where = [orphan, lost].map((body) => ({ x: body.x, y: body.y }));
    expect(step(world).turns, 'somebody spent a turn').toBe(0);
    expect([orphan, lost].map((body) => ({ x: body.x, y: body.y }))).toEqual(where);
  });

  /**
   * ═══ AND A COMPANION WHOSE PERSON IS DOWN KEEPS ITS GROUND ═══
   * `alive` is false while a body is on the floor, and `anchorAt` refuses it —
   * so the companion stops following and goes on fighting whatever is standing
   * over them, which is the only useful thing it can do.
   *
   * NO CLOCK ASSERTION HERE, and the reason is worth stating: a downed player
   * is still an ACTIVE body (`isActive` exempts a downed one explicitly, so its
   * five-turn countdown can run), so this pump advances a turn whatever the
   * companion does. The position is the whole assertion.
   *
   * MUTANT: drop the `alive` check from `anchorAt`. The companion walks back
   * across the room to stand over a body that is not going anywhere.
   */
  it('keeps its ground when its person is down', () => {
    const world = createWorld('escort-anchor-down');
    const run = openRun(world, FOLLOW_LEASH + 5);
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) throw new Error('no run');
    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    world.turn.engagement = 0;
    const over = companionAt(world, 'over', last, 'p1');
    playerOf(world, 'p1').alive = false;

    step(world);
    expect({ x: over.x, y: over.y }).toEqual(last);
  });

  /**
   * ═══ THE COMBAT LEASH — `Party.lua:69`'s ten, NOT the escort's hundred ═══
   * A companion dragged past `COMPANION_LEASH` by something it is chasing
   * breaks off and walks back. Without it a kiter leads your companion across
   * the floor and the party arrives at the stair alone.
   *
   * MUTANT: delete the leash clause from `decideSquadAction`. The companion
   * swings at the husk instead — its hit points move — and never comes back.
   */
  it('breaks off a fight that has dragged it past the leash', () => {
    const world = createWorld('escort-leash');
    const run = openRun(world, COMPANION_LEASH + 4);
    const first = run[0];
    const far = run[COMPANION_LEASH + 2];
    const beside = run[COMPANION_LEASH + 3];
    if (first === undefined || far === undefined || beside === undefined) throw new Error('no run');

    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    const keel = companionAt(world, 'companion', far, 'p1');
    const biter = husk(world, 'm_husk', beside);
    // IN COMBAT, which is the only state this clause is reachable in.
    world.turn.engagement = 3;

    const away = chebyshev(keel, first);
    expect(away, 'the fixture did not put it past the leash').toBeGreaterThan(COMPANION_LEASH);
    const hp = biter.hp;

    // ═══ THE PLAYER OWES A DECISION AND EVERYTHING ELSE IS WAITING ON IT ═══
    // `tickLevel` skips every actor after the first park, so in combat nothing
    // moves until the human has acted. A fixture that only pumped would be
    // asserting about a sweep that never reached the companion.
    const barrier = createBarrier();
    submitIntent(world, barrier, 'p1', HOLD_INTENT);
    pump(world, { nowMs: 0, barrier, parties: createPartyState() });

    expect(chebyshev(keel, first), 'it did not walk back').toBeLessThan(away);
    expect(biter.hp, 'it swung at the husk instead of going back').toBe(hp);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OTHER CLAUSE: NOTHING TO FIGHT, SO CLOSE THE DISTANCE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * IN combat and out of reach of it — the party is fighting something the
   * companion cannot see or cannot get to. `decideNpcAction` answers HOLD for
   * that, and standing in the last room is not an answer: the fight moves and
   * the objective is that the body is WITH you.
   *
   * The out-of-combat half of this is the idle gate, which calls `followStep`
   * directly and never reaches `decideSquadAction` at all — so this clause is
   * the only thing that closes a gap while `engagement > 0`.
   *
   * MUTANT: delete `if (intent.kind !== IntentKind.Hold) return intent; return
   * followStep(self, ctx) ?? intent;`. The companion stands where the last
   * fight ended for the whole of the next one, and nothing else in the suite
   * notices — the leash clause above covers the other half of the function.
   */
  it('closes the distance in a fight it cannot reach', () => {
    const world = createWorld('escort-held');
    const run = openRun(world, FOLLOW_LEASH + 5);
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) throw new Error('no run');

    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    const keel = companionAt(world, 'companion', last, 'p1');
    // IN COMBAT, WITH NOTHING FOR IT TO DO. `engagement` is the floor's state
    // and not a body's, so a party fighting three rooms away puts this
    // companion in exactly this position.
    world.turn.engagement = 3;

    const away = chebyshev(keel, first);
    expect(away, 'the fixture did not put them apart').toBeGreaterThan(FOLLOW_LEASH);

    const barrier = createBarrier();
    submitIntent(world, barrier, 'p1', HOLD_INTENT);
    pump(world, { nowMs: 0, barrier, parties: createPartyState() });

    expect(chebyshev(keel, first), 'it stood in the last room').toBeLessThan(away);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND OUT OF COMBAT IT IS A STEP AND NEVER A SWING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `followStep` filters `approach`'s answer to `IntentKind.Move`, and the idle
   * caller's whole claim rests on it: a companion that opens a fight with
   * something nobody had noticed spends the floor's clock on a decision no
   * player made, and the level stops being at its fixed point.
   *
   * A HUSK THAT NOTICES NOTHING is what makes this measurable — `aggroRange: 0`
   * is asleep, so the only thing that can start this fight is the companion.
   *
   * MUTANT: `return step;` instead of `return step?.kind === IntentKind.Move ?
   * step : undefined;`. The companion bump-attacks a sleeping husk on the way
   * past, out of combat, in a pump the party opened by walking.
   */
  it('walks past a sleeping body rather than opening a fight with it', () => {
    const world = createWorld('escort-nofight');
    const run = openRun(world, FOLLOW_LEASH + 5);
    const first = run[0];
    const last = run.at(-1);
    const between = run.at(-2);
    if (first === undefined || last === undefined || between === undefined) {
      throw new Error('no run');
    }

    world.addPlayer('p1', 'Ren');
    stand(playerOf(world, 'p1'), first);
    // ON THE ROUTE HOME, so `approach`'s first path node IS this body and
    // `intentForStep` answers ATTACK for it.
    const sleeper = husk(world, 'm_asleep', between);
    sleeper.ai.aggroRange = 0;
    const keel = companionAt(world, 'companion', last, 'p1');
    world.turn.engagement = 0;

    const hp = sleeper.hp;
    step(world);
    step(world);
    step(world);

    expect(sleeper.hp, 'the companion started a fight on its own').toBe(hp);
    expect(world.turn.engagement, 'a fight started out of an idle pump').toBe(0);
    // AND IT DID NOT WALK THROUGH THE BODY EITHER. `followStep`'s third refusal
    // — no route — is a chokepoint working as intended, and what it produces
    // here is a companion standing still rather than one swinging.
    expect({ x: keel.x, y: keel.y }, 'it took the sleeping body`s tile').not.toEqual(between);
  });
});

// ===========================================================================
// 3. THE OBJECTIVE — ARRIVING, DYING, AND THE FLOOR'S EDGE
// ===========================================================================

describe('walking somebody to where they asked to go', () => {
  /** Stand the companion on its destination and a player in sight of it. */
  function atTheDoor(brief: Brief, realm: Realm, offset = 0): MonsterActor {
    if (brief.target.k !== BriefKind.Escort) throw new Error('not an escort');
    const at = brief.target.at;
    const walking = bodyOf(realm, brief.companionId);
    stand(walking, { x: at.x + offset, y: at.y });
    stand(playerOf(realm.world, 'p1'), { x: at.x, y: at.y + 1 });
    return walking;
  }

  /**
   * ARRIVAL IS `FOLLOW_LEASH` OF THE DESTINATION AND NOT THE TILE ITSELF, and
   * that is derived rather than chosen: a companion follows to within that
   * distance and then stops, so a condition reading the exact cell is one the
   * follow rule can never satisfy.
   *
   * MUTANT: require `chebyshev === 0`. The objective hangs open with the
   * companion standing beside the door, and the only way it ever closes is a
   * route that happens to push the body onto one particular cell.
   */
  it('closes when they are at the door with somebody who took it on', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-arrive');
    const walking = atTheDoor(brief, realm, FOLLOW_LEASH);

    expect(noteBriefProgress(realm)).toBe(brief);
    expect(brief.state).toBe(BriefState.Closed);
    // `leaves` — THEY GO. Removed and never killed: no corpse, no loot, no kill
    // line. MUTANT: `reap` it as a death instead and the party is told their
    // companion was destroyed at the moment they succeeded.
    expect(realm.world.getActor(walking.id), 'the body stayed on the floor').toBeUndefined();
    expect(brief.companionId).toBeNull();
    expect(brief.offererId, 'the edge is left holding a dead id').toBeNull();
  });

  /**
   * AND NOT ONE STEP FURTHER. The companion one tile beyond the leash has not
   * arrived, which is what stops the radius being "near enough".
   */
  it('does not close from one tile further out', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-nearly');
    atTheDoor(brief, realm, FOLLOW_LEASH + 2);
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(brief.state).toBe(BriefState.Open);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE TWO NUMBERS THEMSELVES, BECAUSE EVERY OTHER CASE DERIVES FROM THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every test in this file imports the constant and builds its fixture out of
   * it, so the fixture scales WITH a mutant and `FOLLOW_LEASH = 4` passes the
   * whole suite. `npm run check:constants` does not catch either, because both
   * are spelled as words in their own prose (*"Two is beside you"*, *"ten,
   * which is upstream's"*) — memory `citation-ratchet` in the other direction.
   *
   * SO THEY ARE PINNED AS LITERALS, ONCE, HERE:
   *
   *   `FOLLOW_LEASH` IS OURS. Two is "beside you, or one body over"; three is
   *     left behind. What it costs is the idle fixed point, which is why it is
   *     bounded on both sides.
   *   `COMPANION_LEASH` IS UPSTREAM'S. `tome/class/Party.lua:69` is
   *     `actor.ai_state.tactic_leash = actor.ai_state.tactic_leash or 10` — the
   *     summon default, NOT the escort's override of 100, because a hundred
   *     tiles on a fifty-by-fifty floor is a companion in another room. It is
   *     flagged twice in the design as the number most likely to be
   *     "corrected" back.
   *
   * AND THE ARRIVAL BAND AS A LITERAL TOO, so the follow rule and the close
   * condition cannot be moved together by one edit and still agree.
   */
  it('is two tiles of leash and ten of rope, and three at the door', () => {
    expect(FOLLOW_LEASH).toBe(2);
    expect(COMPANION_LEASH).toBe(10);

    const { realm, brief } = taken([WALK_OUT], 'escort-band');
    atTheDoor(brief, realm, 3);
    expect(noteBriefProgress(realm), 'three tiles off the door is not arrived').toBe(brief);

    const further = taken([WALK_OUT], 'escort-band-2');
    atTheDoor(further.brief, further.realm, 4);
    expect(noteBriefProgress(further.realm), 'four tiles off the door arrived').toBeUndefined();
  });

  /**
   * ═══ AND SOMEBODY WHO TOOK IT ON HAS TO BE THERE ═══
   * Otherwise a party accepts, runs ahead, and wins by standing at the stair
   * while the body walks the floor alone behind them.
   *
   * MUTANT: drop the proximity clause. This test is the only thing in the
   * suite that fails, and the feature it deletes is the whole reason the
   * objective is an escort rather than a delivery.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND SOMEBODY ON THEIR FEET. A PARTY LYING DOWN HAS NOT ARRIVED WITH THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `alive` is false for a DOWNED body, not only a dead one, so this clause
   * decides a real case: the party is wiped but not finished, lying at the door
   * with the companion standing over them, and the five-turn count running. The
   * answer is that nobody has been walked anywhere — somebody has to be
   * standing to have arrived — and the floor's own wipe handling takes it from
   * there.
   *
   * MUTANT: drop `a.alive`. A party that went down at the door is paid for it.
   */
  it('does not close for a party lying at the door', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-downed-watch');
    atTheDoor(brief, realm, FOLLOW_LEASH);
    // The downed state as the engine writes it: `goDown` sets hp 0 AND `alive`
    // false beside it, and the body stays on the floor.
    const watcher = playerOf(realm.world, 'p1');
    watcher.hp = 0;
    watcher.alive = false;

    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(brief.state).toBe(BriefState.Open);

    // AND BACK ON HER FEET IT CLOSES, so the assertion above is about `alive`
    // and not about the fixture having drifted out of range.
    watcher.alive = true;
    expect(noteBriefProgress(realm)).toBe(brief);
    expect(brief.state).toBe(BriefState.Closed);
  });

  /**
   * "IN SIGHT OF IT" IS THE SIGHT RADIUS BY ToME's DISTANCE: `tileDistance <=
   * DEFAULT_SIGHT_RADIUS`, the rounded disc sight is. (10,2) from the door is
   * 10.2 long and rounds to 10, so a party member there saw her arrive; it was
   * the exact length, which refused it. (11,0) is 11 either way.
   *
   * MUTANT: measure with `Math.hypot` again. The (10,2) case stays open.
   */
  it('closes with somebody at (10,2) from the door, and not at (11,0)', () => {
    for (const [dx, dy, closes] of [
      [10, 2, true],
      [11, 0, false],
    ] as const) {
      const { realm, brief } = taken([WALK_OUT], `escort-rim-${String(dx)}`);
      if (brief.target.k !== BriefKind.Escort) throw new Error('not an escort');
      const at = brief.target.at;
      stand(bodyOf(realm, brief.companionId), at);
      // Whichever side of the door the floor has room on; the rule reads a
      // distance and nothing else, so the tile need not be open ground.
      const sx = at.x + dx < realm.world.level.w ? 1 : -1;
      const sy = at.y + dy < realm.world.level.h ? 1 : -1;
      const watcher = { x: at.x + sx * dx, y: at.y + sy * dy };
      stand(playerOf(realm.world, 'p1'), watcher);
      expect(tileDistance(watcher, at)).toBe(dx === 10 ? 10 : 11);
      expect(Math.hypot(watcher.x - at.x, watcher.y - at.y)).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

      noteBriefProgress(realm);
      expect(brief.state, `(${String(dx)},${String(dy)})`).toBe(
        closes ? BriefState.Closed : BriefState.Open,
      );
    }
  });

  it('does not close with nobody in sight of it', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-alone');
    if (brief.target.k !== BriefKind.Escort) throw new Error('not an escort');
    const at = brief.target.at;
    stand(bodyOf(realm, brief.companionId), at);
    // Standing on the same floor and nowhere near it.
    stand(playerOf(realm.world, 'p1'), farFrom(realm, at));

    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(brief.state).toBe(BriefState.Open);
  });

  /**
   * THE ERRAND'S HALF: they stay where they were put, and they stop being
   * yours. Leave them `Squad` with an anchor and the follow rule walks them
   * straight back out of the place the party just walked them to.
   *
   * MUTANT: collapse the two configurations — reap on both. The Errand becomes
   * the Walk Out with the destination moved, and the second half of it (walking
   * back unescorted) is a body vanishing at the moment of success.
   */
  it('leaves an errand`s companion standing, and no longer following', () => {
    const { realm, brief } = taken([ERRAND], 'escort-errand');
    const walking = atTheDoor(brief, realm);

    expect(noteBriefProgress(realm)).toBe(brief);
    expect(brief.state).toBe(BriefState.Closed);
    expect(realm.world.getActor(walking.id), 'they were taken away').toBeDefined();
    expect(walking.faction, 'the floor still wants them dead').toBe(Faction.Townsfolk);
    expect(walking.anchorId, 'they are still following somebody').toBeUndefined();
    expect(brief.companionId).toBeNull();
  });

  /**
   * ═══ A DEATH FAILS IT, IN THE PUMP IT HAPPENS IN ═══
   * The corpse stays: it is what the party can see, and the reap window buries
   * it with everything else that died. A companion deleted by its own objective
   * would vanish out of the room mid-fight with no frame that says why.
   *
   * MUTANT: check for arrival before death. A companion that fell ON the
   * destination then pays the party for a body they failed to keep alive.
   */
  it('fails when the companion goes down, and leaves the body where it fell', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-death');
    const walking = atTheDoor(brief, realm);
    walking.hp = 0;
    walking.alive = false;

    expect(noteBriefProgress(realm)).toBe(brief);
    expect(brief.state).toBe(BriefState.Failed);
    expect(realm.world.getActor(walking.id), 'the corpse was taken away').toBeDefined();
    expect(brief.companionId).toBeNull();
  });

  /**
   * ═══ AND A BODY THE FLOOR DELETED IS NOT A DEATH — IDENTITY, NOT PRESENCE ═══
   * `resetFloor` reaps every monster inside the pump and this sweep runs on the
   * far side of it in the same breath, so "the id no longer resolves" is what a
   * WIPE looks like from here. The quarry's own header records the measured
   * version of this bug: a party paid for a floor they died on.
   *
   * MUTANT: fail on `getActor(id) === undefined`. A wiped party reads that
   * their companion is lost as the last line before the floor is handed back to
   * them with her standing on it again.
   */
  it('says nothing about a companion the floor itself deleted', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-wiped');
    const walking = atTheDoor(brief, realm);
    realm.world.removeActor(walking.id);

    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(brief.state).toBe(BriefState.Open);
  });
});

// ===========================================================================
// 4. THE FLOOR'S EDGE
// ===========================================================================

describe('the last of them steps off the floor', () => {
  /**
   * ═══ THE LAST CHANCE, AND IT IS THE MAIN SUCCESS PATH RATHER THAN AN EDGE ═══
   * `GameState.lua:2630-2632` asks the condition once more at the moment of
   * leaving. For an escort whose destination IS the way out, the companion is
   * standing on the tile the party is stepping off and no pump happened between
   * the two.
   *
   * MUTANT: move `clearOfferer` above the last chance — an escort's offerer IS
   * its companion, so the body the condition is about is deleted before it is
   * asked, and every success at the door becomes a failure.
   */
  it('closes one that was met at the door', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-edge-met');
    if (brief.target.k !== BriefKind.Escort) throw new Error('not an escort');
    const walking = bodyOf(realm, brief.companionId);
    stand(walking, brief.target.at);
    stand(playerOf(realm.world, 'p1'), { x: brief.target.at.x, y: brief.target.at.y + 1 });

    const ended = closeFloorBriefs(realm);
    expect(ended).toBe(brief);
    expect(brief.state).toBe(BriefState.Closed);
    expect(realm.world.getActor(walking.id), 'the body walked out with them').toBeUndefined();
    expect(realm.brief, 'the floor kept a reference to its own objective').toBeUndefined();
  });

  /**
   * AND FAILS ONE THAT WAS NOT. The quest id contains the floor number
   * (`Player.lua:234`), so walking off the floor is definitionally the failure
   * — and the body goes with it either way.
   */
  it('fails one that was not, and the body is gone either way', () => {
    const { realm, brief } = taken([WALK_OUT], 'escort-edge-unmet');
    if (brief.target.k !== BriefKind.Escort) throw new Error('not an escort');
    const walking = bodyOf(realm, brief.companionId);
    stand(walking, farFrom(realm, brief.target.at));

    const ended = closeFloorBriefs(realm);
    expect(ended).toBe(brief);
    expect(brief.state).toBe(BriefState.Failed);
    expect(realm.world.getActor(walking.id)).toBeUndefined();
    expect(brief.companionId).toBeNull();
  });

  /**
   * AN UNACCEPTED ESCORT IS REAPED IN SILENCE. Nobody agreed to anything, so
   * there is no line anybody earned — and the person still goes, because they
   * are a fact about a floor being walked.
   *
   * MUTANT: return the brief for an `Offered` state. The party reads that they
   * failed something they never took.
   */
  it('says nothing about one nobody took, and takes the person away anyway', () => {
    const realm = floorWith([WALK_OUT], 'escort-edge-offered');
    const armed = armBrief(realm);
    const standing = bodyOf(realm, armed?.offererId ?? null);

    expect(closeFloorBriefs(realm)).toBeUndefined();
    expect(realm.world.getActor(standing.id)).toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });
});

// ===========================================================================
// 5. THE ERRAND'S DESTINATION
// ===========================================================================

describe('where an errand goes', () => {
  /**
   * A PREDICATE OVER CELLS, NOT AN AUTHORED PLACE — which is what makes the
   * Errand different on every seed and what stops it collapsing into the Walk
   * Out. Four properties, and the first is the one that matters:
   *
   * MUTANT: resolve `stays` to `stairsDownOf(realm) ?? realm.spawns[0]`. Both
   * configurations then walk to the same tile and the only difference left is
   * whether the body is reaped, which no player can see.
   */
  it('is somewhere a body can stand, and is not the way out', () => {
    const realm = floorWith([ERRAND], 'errand-where');
    const brief = armBrief(realm);
    if (brief?.target.k !== BriefKind.Escort) throw new Error('nothing armed');
    const at = brief.target.at;

    expect(canWalk(realm.world.level, at.x, at.y)).toBe(true);
    expect(at, 'the errand is the stair').not.toEqual(stairsDownOf(realm));
    expect(realm.spawns, 'the errand is the door').not.toContainEqual(at);
    /**
     * THESE THREE STATE THE RULE AND KILL NO MUTANT, AND THAT IS SAID PLAINLY
     * RATHER THAN CLAIMED OTHERWISE. Deleting `errandCell`'s `realm.sites` and
     * `realm.spawns` exclusions, or its `OFFERER_MAX_FROM_ARRIVAL` minimum,
     * leaves all three of these passing: the tie-break maximises the distance
     * from BOTH ends of the floor, so the winner is far from the door and the
     * stair whether or not anything forbids them. They are the CONTENT rule the
     * destination has to satisfy — memory `tests-true-of-the-fixture` cuts both
     * ways, and an assertion advertising a mutant it does not kill is worse
     * than one that does not advertise.
     */
    const door = realm.spawns[0];
    if (door === undefined) throw new Error('no arrival');
    expect(chebyshev(at, door)).toBeGreaterThanOrEqual(12);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT IS A PLACE BEFORE IT IS A PREFERENCE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The three preferences answer *"which of these is interesting"*; they do not
   * answer *"is this somewhere at all"*, and the tie-break works AGAINST it —
   * maximising the distance from both ends pushes the answer into the corners.
   * MEASURED over 24 seeds of the Underworks before the two guards existed:
   * EIGHTEEN destinations were on the map's outer ring, which rendered as a
   * place with nothing drawn around it that the party is told to walk somebody
   * to. Afterwards: none.
   *
   * ACROSS SEEDS AND NOT ONE, because one seed passing is the definition of a
   * fixture. Six is enough that the old behaviour (18 of 24) could not survive.
   *
   * MUTANT: drop either guard. The rim one fails here within two seeds; the
   * room one leaves an errand at the end of a one-tile crack in the rock, where
   * the close condition — which needs a party member near the destination —
   * has nowhere to put anybody.
   */
  it('is off the rim of the map, with room around it, on every seed', () => {
    for (let seed = 0; seed < 6; seed += 1) {
      const realm = floorWith([ERRAND], `errand-place-${String(seed)}`);
      const brief = armBrief(realm);
      if (brief?.target.k !== BriefKind.Escort) throw new Error('nothing armed');
      const { at } = brief.target;
      const { level } = realm.world;

      expect(at.x, `seed ${String(seed)} is on the west edge`).toBeGreaterThan(0);
      expect(at.y, `seed ${String(seed)} is on the north edge`).toBeGreaterThan(0);
      expect(at.x, `seed ${String(seed)} is on the east edge`).toBeLessThan(level.w - 1);
      expect(at.y, `seed ${String(seed)} is on the south edge`).toBeLessThan(level.h - 1);

      // ROOM FOR A PARTY AND A COMPANION, which is what the close condition
      // asks for: she has to be within the arrival band of this tile AND
      // somebody who took it on has to be standing near it.
      let open = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        if (canWalk(level, at.x + dx, at.y + dy)) open += 1;
      }
      expect(open, `seed ${String(seed)} is a dead end in the rock`).toBeGreaterThanOrEqual(5);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND ARMING A FLOOR MOVES NO DRAW AT ALL — THE ONE THAT WOULD BE INVISIBLE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `armBrief` runs ON ARRIVAL, after the floor's own population has been
   * rolled, and it stands a body up, decides its level and picks a destination.
   * Every one of those is a place a draw could be taken, and `content/delve.ts`
   * states what a new draw on this path costs: *"it would consume a position in
   * the world's labelled stream and shift every draw after it"* — which is
   * every fight in that realm, for the rest of the run.
   *
   * THE STATE ITSELF AND NOT A SAMPLE, because a sample can agree by luck and
   * because this is the assertion that has to be true of the WHOLE of arming
   * rather than of one function inside it.
   *
   * MUTANT: place the offerer with `world.rng.int` instead of the ring walk, or
   * roll the companion's level with `actorAdjustLevel` the way the roster is
   * levelled. Both are the obvious implementation, neither breaks a single
   * other test, and both re-roll every delve anybody has ever walked.
   */
  it('takes no draw from the world it arms', () => {
    const realm = floorWith([ERRAND], 'errand-no-draw');
    const before = realm.world.rng.getState();
    expect(armBrief(realm), 'nothing was armed, so nothing was measured').toBeDefined();
    expect(realm.world.rng.getState()).toEqual(before);
  });

  /**
   * AND IT IS A SWEEP RATHER THAN A DRAW. `offererCell` states the rule this
   * obeys: a draw at arm time would shift the seeded stream for everything that
   * draws after it, which is every fight in the realm.
   *
   * MUTANT: pick the cell with `world.rng.int`. Two instances of one seed then
   * disagree, and every delve rolled after an arming is a different floor.
   */
  it('is the same cell on the same seed, every time', () => {
    const one = floorWith([ERRAND], 'errand-stable');
    const two = floorWith([ERRAND], 'errand-stable');
    const first = armBrief(one);
    const second = armBrief(two);
    if (first?.target.k !== BriefKind.Escort || second?.target.k !== BriefKind.Escort) {
      throw new Error('nothing armed');
    }
    expect(first.target.at).toEqual(second.target.at);
  });
});

/** The walkable tile furthest from `at`, for a body that must be nowhere near it. */
function farFrom(realm: Realm, at: TileXY): TileXY {
  let best: TileXY | undefined;
  let away = -1;
  for (let y = 1; y < realm.world.level.h - 1; y += 1) {
    for (let x = 1; x < realm.world.level.w - 1; x += 1) {
      if (!canWalk(realm.world.level, x, y)) continue;
      if (realm.world.actorAt(x, y) !== undefined) continue;
      const distance = chebyshev({ x, y }, at);
      if (distance <= away) continue;
      best = { x, y };
      away = distance;
    }
  }
  if (best === undefined) throw new Error('the floor has nowhere far from anything');
  return best;
}
