// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite, partyIdOf } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import {
  BriefKind,
  BriefState,
  acceptBrief,
  armBrief,
  briefIdFor,
  briefSnapshotFor,
  briefSpecFor,
  briefViewFor,
  closeFloorBriefs,
  declineBrief,
  progressText,
  distanceBand,
  noteBriefProgress,
  rearmBrief,
  rewardCell,
} from '../../src/server/world/brief.ts';
import { SITES, createRealms, floorsOfSite, stairsDownOf } from '../../src/server/world/realms.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { FIELD_FOLK } from '../../src/server/content/townsfolk.ts';
import { STRANDED_HAND } from '../../src/server/content/monsters.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Brief, BriefSpec } from '../../src/server/world/brief.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { BriefMsg, BroadcastMsg, ViewerMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BRIEF LIVES AND DIES ON ONE FLOOR OF ONE INSTANCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ruling: *"temporary companions in level usually come with an in level
 * quest... so the companion needs a proper in level quest variety, whether its
 * bodyguard to destination or elite mob kill, etc."*
 *
 * This file covers the LAYER — the objective's identity, its arming, its edge
 * and its frame — with no body of any kind on the floor. That order is
 * deliberate: the riskiest edit in the whole feature is a new faction inside
 * `areEnemies`, and everything here can be proved without one.
 *
 * ═══ WHAT EACH TEST MUST KILL ═══
 * Every rule below names the mutant it was written against, because a test that
 * passes when its rule is broken is a test of the fixture. Each was applied,
 * watched fail, and restored.
 */

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

/** One authored objective, for a floor that has no body on it. */
const WHO = FIELD_FOLK.get('pell');
if (WHO === undefined) throw new Error('nobody in FIELD_FOLK offers anything');

const QUARRY: BriefSpec = {
  id: 'test:kept-its-name',
  kind: BriefKind.Quarry,
  floors: [2, 2],
  title: 'It kept its name',
  detail: 'One of them down there still answers to something.',
  reward: { level: 3, rank: ActorRank.Elite },
  offerer: WHO,
  quarry: { name: 'Maundy', mark: 'UNMAKE THIS ONE' },
};

/**
 * THE SHEET THE PERSON IS STOOD UP WITH. `content/monsters.ts#STRANDED_HAND` is
 * the shipped one and this file uses it rather than a hand-built body, for the
 * reason `armBrief` builds one at all: a companion has to be able to walk
 * through the fight, and a fixture that was harmless would prove the lifecycle
 * against a body the shipped game does not place.
 */
const ESCORT_BODY = { body: STRANDED_HAND } as const;

const ESCORT: BriefSpec = {
  id: 'test:the-way-up',
  kind: BriefKind.Escort,
  floors: [1, 3],
  title: 'The way up, with you',
  detail: 'Somebody down here wants to leave with the party.',
  reward: { level: 3, rank: ActorRank.Elite },
  offerer: WHO,
  escort: { ...ESCORT_BODY, after: 'leaves' },
};

function makeRealms(seed = 'briefs'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

/** A delve floor whose site carries `specs`. */
function floorWith(
  realms: Realms,
  specs: readonly BriefSpec[],
  floor: number,
  partyId = 'party-brief',
): Realm {
  const def: SiteDef = { ...site(UNDERWORKS), briefs: specs };
  return realms.open(def, partyId, undefined, undefined, undefined, floor);
}

// ===========================================================================
// 1. THE ID, AND THE FLOOR IS IN IT
// ===========================================================================

describe('a brief is named after the floor it belongs to', () => {
  /**
   * Upstream builds the same shape twice — `tome/class/Player.lua:234` is
   * `"escort-duty-"..zone.short_name.."-"..level.level` and
   * `tome/class/GameState.lua:2593` is `"id-challenge-"..level.level`. The
   * property it buys is that "you walked off the floor" is a string comparison.
   *
   * MUTANT: drop the floor term from `briefIdFor`. Two floors of one delve then
   * share an id, and every rule keyed on identity stops distinguishing them.
   */
  it('gives two floors of one delve two different ids', () => {
    expect(briefIdFor(UNDERWORKS, 2)).not.toBe(briefIdFor(UNDERWORKS, 3));
    expect(briefIdFor(UNDERWORKS, 2)).toContain(UNDERWORKS);
    expect(briefIdFor(UNDERWORKS, 2).endsWith('2')).toBe(true);
  });

  it('puts the floor it was armed on into the brief`s own id', () => {
    const realms = makeRealms();
    const armed = armBrief(floorWith(realms, [QUARRY], 2));
    expect(armed?.id).toBe(briefIdFor(UNDERWORKS, 2));
  });
});

// ===========================================================================
// 2. WHICH FLOOR CARRIES ONE
// ===========================================================================

describe('which floor of a site carries an objective', () => {
  /**
   * MUTANT: make either bound of `floors` exclusive. The Underworks' own brief
   * is authored `[2, 2]`, so an exclusive bound silently gives that site no
   * objective at all and nothing anywhere fails.
   */
  it('reads `floors` as inclusive at both ends', () => {
    const band: BriefSpec = { ...QUARRY, floors: [2, 3] };
    expect(briefSpecFor([band], 1)).toBeUndefined();
    expect(briefSpecFor([band], 2)).toBe(band);
    expect(briefSpecFor([band], 3)).toBe(band);
    expect(briefSpecFor([band], 4)).toBeUndefined();
  });

  it('answers undefined for a site that carries none at all', () => {
    expect(briefSpecFor(undefined, 1)).toBeUndefined();
    expect(briefSpecFor([], 1)).toBeUndefined();
  });

  it('gives every floor in the game an empty list rather than an absent one', () => {
    // `Realm.briefs` is a list on every realm, so `armBrief` never asks twice.
    // MUTANT: set `briefs` above the `...extra` spread in `build` — the key is
    // then copied as `undefined` over the default on every floor in the game.
    //
    // A SITE THAT AUTHORS NONE, and the Underworks is no longer one of them:
    // `content/briefs.ts` gives it an objective, which is what the case below
    // is about.
    const realms = makeRealms();
    expect(realms.overworld.briefs).toEqual([]);
    expect(realms.open(site('site:blackwood_outskirts'), 'party-empty').briefs).toEqual([]);
  });

  /**
   * THE AUTHORED TABLE REACHES A REAL INSTANCE, which is the join between
   * `content/briefs.ts` and the registry and is the only thing that makes any
   * of this reachable in a game.
   *
   * MUTANT: drop the `briefs` spread from `AUTHORED_SITES`. Every unit test
   * above still passes, every socket test that supplies its own site definition
   * still passes, and no floor a player can walk to ever offers anything.
   */
  it('carries the authored objective onto a real Underworks floor', () => {
    const realms = makeRealms();
    const floor = realms.open(
      site(UNDERWORKS),
      'party-authored',
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(floor.briefs.map((spec) => spec.id)).toEqual([
      'underworks:kept-its-name',
      'underworks:one-still-walking',
    ]);
    // AND IT IS THE ONE **THIS FLOOR** CARRIES, not merely one the site knows
    // about — which is the whole of what `briefSpecFor` is for now that the
    // site carries two. One per FLOOR, and floor 1 carries neither.
    expect(briefSpecFor(floor.briefs, 2)?.kind).toBe(BriefKind.Quarry);
    expect(briefSpecFor(floor.briefs, 3)?.kind).toBe(BriefKind.Escort);
    expect(briefSpecFor(floor.briefs, 1)).toBeUndefined();

    /**
     * ═══ AND THE ESCORT'S OWN FIELDS, BECAUSE NOTHING ELSE DRIVES THEM ═══
     * `briefshipped.test.ts` walks the QUARRY end to end on the real floor 2
     * and there is no counterpart for the escort — both `escort.test.ts` and
     * `briefescort.test.ts` author their own `BriefSpec` so the shipped row is
     * exercised by nothing. Measured: `offerer('callow')` -> `offerer('pell')`
     * and `after: 'leaves'` -> `'stays'` each survived the ENTIRE suite.
     *
     * Pinned the way `briefshipped.test.ts` pins the quarry's `name`/`mark`:
     * the fields, directly, in one place.
     *
     *   `after: 'leaves'`   the destination is the way out. `'stays'` is the
     *                       Errand, which is built and driven and NOT authored
     *                       onto any floor.
     *   `offerer.id`        the person; `armBrief` stands up THIS body, and
     *                       swapping it changes who the party meets and what
     *                       the conversation says.
     *   `escort.body`       the sheet under her, which is what makes her able
     *                       to fight at all.
     */
    const walk = briefSpecFor(floor.briefs, 3);
    expect(walk?.id).toBe('underworks:one-still-walking');
    expect(walk?.floors).toEqual([3, 3]);
    expect(walk?.escort?.after).toBe('leaves');
    expect(walk?.offerer?.id).toBe('callow');
    expect(walk?.escort?.body.id).toBe(STRANDED_HAND.id);
  });

  /**
   * AND NOBODY IS STANDING IN THE REDACTION TO ASK YOU FOR ANYTHING.
   *
   * The twin sites spread their original's `SiteDef`, which is how they inherit
   * a shape and a palette — and how they would have inherited an objective
   * offered by a person, in a place whose whole statement is that there are no
   * people left in it.
   *
   * MUTANT: delete `briefs: undefined` from the twin. The Redacted Underworks
   * then stands somebody up in a country the Index emptied.
   */
  it('offers nothing in the Redaction, where nobody lives', () => {
    const twin = [...SITES.values()].find(
      (def) => def.id !== UNDERWORKS && def.id.endsWith('underworks'),
    );
    expect(twin, 'no redacted twin of the Underworks').toBeDefined();
    expect(twin?.briefs).toBeUndefined();
    // NOT VACUOUS: the original beside it does carry them.
    expect(site(UNDERWORKS).briefs).toHaveLength(2);
  });
});

// ===========================================================================
// 3. ARMING THE FLOOR
// ===========================================================================

describe('arming a floor', () => {
  /**
   * `engine/interface/ActorQuest.lua:50` refuses a second grant of an id the
   * player already holds. Upstream's arrivals are once per level; ours are not.
   *
   * MUTANT: delete `armBrief`'s idempotence guard. The second arrival then
   * builds a second brief — and in the shipped feature, stands a second
   * offerer on the floor beside the first.
   */
  it('arms once, and a second arrival changes nothing', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const first = armBrief(realm);
    expect(first).toBeDefined();
    expect(realm.brief).toBe(first);
    const second = armBrief(realm);
    expect(second, 'a second arrival armed a second objective').toBe(first);
    expect(realm.brief).toBe(first);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE PER ID, EVER, ON THIS INSTANCE — `hasQuest`, WHICH WAS CITED AND NOT BUILT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The guard above only refuses a second arrival while the first brief is
   * still ON the realm, and the floor's edge clears that field. So walking out
   * of the delve and back in through the same door minted the SAME id on the
   * SAME instance a second time — a second quarry, a second payout, a second
   * reward item on one floor. Measured over a socket: xp 0 -> 36 -> 72 for both
   * members, two `Done:` lines and two lamps.
   *
   * `engine/interface/ActorQuest.lua:50` is `if self:hasQuest(quest.id) then
   * return end`, and `Brief.id` carries the floor precisely so that check can be
   * a string lookup. `Realm.granted` is that ledger.
   *
   * MUTANT: delete the `realm.granted.has(id)` guard, or stop writing the id.
   * The floor re-offers its work every time somebody walks back in.
   */
  it('refuses to hand out the same id twice on one instance', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const first = armBrief(realm);
    expect(first).toBeDefined();
    // THE FLOOR'S EDGE: the last body out, which clears `realm.brief`.
    closeFloorBriefs(realm);
    expect(realm.brief, 'the edge left a reference behind').toBeUndefined();
    // AND THEY WALK BACK IN THROUGH THE SAME DOOR, onto the same instance.
    expect(armBrief(realm), 'the floor offered its work a second time').toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });

  /**
   * AND A DECLINE IS ALSO AN ANSWER. `declineBrief` deletes the content —
   * upstream removes the encounter rather than leaving it standing to be farmed
   * — and an offer you may refuse and then walk back to is an offer with no
   * weight.
   *
   * MUTANT: record the grant at the accept rather than at the arm. A declined
   * objective comes back through the door.
   */
  it('does not offer again what the lead has already refused', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    expect(declineBrief(realm)).toBeDefined();
    expect(armBrief(realm), 'a refusal was undone by walking out and back').toBeUndefined();
  });

  /**
   * A WIPE TAKES THE GRANT BACK OUT, because *"a reset means the fight did not
   * happen"* and the floor is handed back exactly as it was on arrival.
   *
   * MUTANT: leave the id in `granted` in `rearmBrief`. A party that wipes on a
   * floor loses its objective permanently, which is the one thing a reset is
   * not allowed to do.
   */
  it('gives the floor back its objective after a wipe', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    acceptBrief(realm, 'dalt');
    const again = rearmBrief(realm);
    expect(again, 'the wipe left the floor with nothing on it').toBeDefined();
    expect(again?.state).toBe(BriefState.Offered);
  });

  it('arms nothing on a floor the spec does not name', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 1);
    expect(armBrief(realm)).toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });

  it('opens it offered, taken by nobody, with no body and no count', () => {
    const realms = makeRealms();
    const brief = armBrief(floorWith(realms, [QUARRY], 2));
    expect(brief?.state).toBe(BriefState.Offered);
    expect(brief?.acceptedBy).toBeNull();
    expect(brief?.companionId).toBeNull();
    expect(brief?.progress).toBeNull();
  });

  /**
   * A quarry's body is spawned by the ACCEPT, not by the arming — an extra
   * elite standing on a floor nobody agreed to hunt is a floor measured without
   * it. Upstream marks its own bodies at grant time for the neighbouring
   * reason, `tome/class/GameState.lua:2698`.
   *
   * MUTANT: resolve `actorId` at arm time. The floor is then harder for a party
   * that declined than for one that never spoke to anybody.
   */
  it('names the quarry and does not put it on the floor yet', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const before = realm.world.allActors().length;
    const brief = armBrief(realm);
    expect(brief?.target).toEqual({
      k: BriefKind.Quarry,
      actorId: null,
      body: null,
      name: 'Maundy',
      mark: 'UNMAKE THIS ONE',
    });
    // ONE BODY, AND IT IS THE PERSON OFFERING IT. Nothing named 'Maundy' is
    // standing on the floor yet, which is the half this case is about.
    expect(realm.world.allActors().length, 'arming stood up more than the offerer').toBe(
      before + 1,
    );
    expect(realm.world.getActor(brief?.offererId ?? '')?.name).toBe(WHO.name);
    expect(realm.world.allActors().filter((a) => a.name === 'Maundy')).toEqual([]);
  });

  /**
   * ═══ WHERE THEY STAND IS A RULE, AND BOTH HALVES OF IT MATTER ═══
   * FAR ENOUGH that the party is not body-checked by the one friendly face on
   * the floor the instant they cross — `placeTownsfolk`'s own four, for its own
   * reason. NEAR ENOUGH that they are met before the party commits to a route:
   * a person somebody has to cross the floor to find is a person nobody meets,
   * and an objective nobody was offered is the same floor with a body standing
   * in a corner of it.
   *
   * AND NEVER ON A WAY IN OR OUT — `canEventGrid` (`tome/class/GameState.lua:
   * 2296-2298`) refuses a `change_level` grid, and a body on the stair is a
   * body between the party and the way on.
   *
   * MUTANT: drop either bound, or the `realm.sites` check. The first two are
   * invisible in every other test in this file, because every one of them cares
   * only that somebody was stood up.
   */
  it('stands the offerer in the room, off the arrival and off the stair', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const brief = armBrief(realm);
    const body = realm.world.getActor(brief?.offererId ?? '');
    const arrival = realm.spawns[0];
    expect(body, 'nobody was stood up').toBeDefined();
    expect(arrival, 'the floor has no arrival cell').toBeDefined();
    if (body === undefined || arrival === undefined) return;
    const away = Math.max(Math.abs(body.x - arrival.x), Math.abs(body.y - arrival.y));
    expect(away, 'they are standing on top of the party').toBeGreaterThanOrEqual(4);
    expect(away, 'they are across the floor from anybody who walks in').toBeLessThanOrEqual(12);
    expect(realm.sites.has(`${String(body.x)},${String(body.y)}`)).toBe(false);
    expect(realm.spawns.some((t) => t.x === body.x && t.y === body.y)).toBe(false);
  });

  /**
   * An escort's destination is resolved AT ARM TIME, because the conversation
   * offering it describes the way there.
   *
   * MUTANT: resolve it at accept time instead — the offerer can then say
   * nothing about how far it is, which is the only channel an objective's
   * position is allowed to reach a player through.
   */
  it('resolves `leaves` to this floor`s way out', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [ESCORT], 1);
    const stair = stairsDownOf(realm);
    expect(stair, 'precondition: this floor has a stair down').not.toBeNull();
    const brief = armBrief(realm);
    expect(brief?.target).toEqual({ k: BriefKind.Escort, at: stair, after: 'leaves' });
  });

  it('falls back to the tile you came in on, on a floor with no stair down', () => {
    const realms = makeRealms();
    const last = floorsOfSite(UNDERWORKS);
    const realm = floorWith(realms, [{ ...ESCORT, floors: [last, last] }], last);
    expect(stairsDownOf(realm), 'precondition: a last floor has no stair down').toBeNull();
    const brief = armBrief(realm);
    expect(brief?.target).toEqual({
      k: BriefKind.Escort,
      at: realm.spawns[0],
      after: 'leaves',
    });
  });

  /**
   * `stays` RESOLVES SOMEWHERE ELSE ENTIRELY, and the whole point of the
   * configuration is that it is not the door.
   *
   * THIS TEST USED TO ASSERT THAT IT ARMED NOTHING, which was true while the
   * destination rule did not exist. It exists now (`errandCell`), and the
   * property worth pinning is the one the old test was protecting: the two
   * configurations must not resolve to the same tile, or the Errand is the Walk
   * Out wearing the wrong words and the bug is content-shaped — nothing
   * crashes and the wrong thing ships.
   *
   * MUTANT: return `stairsDownOf(realm) ?? realm.spawns[0]` for both arms.
   */
  it('resolves `stays` to somewhere that is not the way out', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [{ ...ESCORT, escort: { ...ESCORT_BODY, after: 'stays' } }], 1);
    const brief = armBrief(realm);
    const target = brief?.target;
    expect(target?.k).toBe(BriefKind.Escort);
    const at = target?.k === BriefKind.Escort ? target.at : undefined;
    if (at === undefined) throw new Error('no destination');
    expect(at).not.toEqual(stairsDownOf(realm));
    expect(realm.spawns).not.toContainEqual(at);
    expect(canWalk(realm.world.level, at.x, at.y), 'somewhere a body can stand').toBe(true);
  });
});

// ===========================================================================
// 4. THE FLOOR'S EDGE
// ===========================================================================

describe('the floor`s edge', () => {
  function armed(state: (typeof BriefState)[keyof typeof BriefState], taker: string | null): Realm {
    const realm = floorWith(makeRealms(), [QUARRY], 2);
    const brief = armBrief(realm);
    if (brief === undefined) throw new Error('nothing armed');
    brief.state = state;
    brief.acceptedBy = taker;
    return realm;
  }

  /**
   * ═══ AN UNACCEPTED BRIEF IS REAPED IN SILENCE ═══
   * Upstream cannot do this: `grantQuest` fires on entering the level
   * (`tome/class/Player.lua:170`), so its quest exists before you have spoken
   * to anybody and leaving fails it. Ours is not granted until somebody agrees,
   * so there is nothing to fail and no line anybody earned.
   *
   * MUTANT: fail an `Offered` brief at the edge. `closeFloorBriefs` then
   * returns something to report, and the party that walked past a stranger is
   * told they let them down.
   */
  it('reaps an offered brief without a word', () => {
    const realm = armed(BriefState.Offered, null);
    expect(closeFloorBriefs(realm), 'an offer nobody took reported a failure').toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });

  /**
   * `tome/class/GameState.lua:2631-2632` — force the failure if the objective
   * is not already ended at the moment of leaving.
   *
   * MUTANT: leave an open brief open. It then survives on a floor nobody is
   * standing on, which is the property `check_level = nil` exists to prevent.
   */
  it('fails an open brief and hands it back to be reported', () => {
    const realm = armed(BriefState.Open, 'dalt');
    const ended = closeFloorBriefs(realm);
    expect(ended?.state).toBe(BriefState.Failed);
    expect(realm.brief, 'the floor kept a reference to its objective').toBeUndefined();
  });

  it('has nothing to add about one that already ended', () => {
    for (const state of [BriefState.Closed, BriefState.Failed]) {
      const realm = armed(state, 'dalt');
      expect(closeFloorBriefs(realm)).toBeUndefined();
      expect(realm.brief).toBeUndefined();
    }
  });

  /**
   * ═══ AND THE PERSON GOES WITH THE FLOOR, WHATEVER THE STATE WAS ═══
   * `tome/class/Party.lua:123-139` `leftLevel` deletes the level's temporary
   * members unconditionally. An instance lingers for five minutes behind a
   * party that stepped out, so a body left standing here is somebody a
   * returning party can talk to who has nothing to say — the objective they
   * were offering has already been cleared off the realm.
   *
   * MUTANT: delete `clearOfferer` from `closeFloorBriefs`. Every other case in
   * this file still passes, because none of them looks at the floor afterwards.
   */
  it('takes the person off the floor at the edge, offered or open', () => {
    for (const state of [BriefState.Offered, BriefState.Open] as const) {
      const realms = makeRealms(`edge-${state}`);
      const realm = floorWith(realms, [QUARRY], 2, `party-${state}`);
      const armed = armBrief(realm);
      const offererId = armed?.offererId ?? '';
      if (state === BriefState.Open) acceptBrief(realm, 'dalt');
      expect(realm.world.getActor(offererId), 'nobody was stood up').toBeDefined();
      closeFloorBriefs(realm);
      expect(
        realm.world.getActor(offererId),
        `${state}: they are still standing there`,
      ).toBeUndefined();
    }
  });

  /**
   * AND THE QUARRY IS NOT TOUCHED. It is a monster on a floor now, and the
   * floor is behind you.
   *
   * MUTANT: reap the marked body too. A party that walks out and comes back
   * inside the linger window finds a floor one body short of the one they left.
   */
  it('leaves the body that kept its name standing', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    closeFloorBriefs(realm);
    expect(realm.world.getActor(named), 'the quarry left with the objective').toBeDefined();
  });

  it('is safe on a floor that never had one', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [], 2);
    expect(closeFloorBriefs(realm)).toBeUndefined();
  });

  /**
   * `realms.close` drops the realm from the registry, and a caller holding the
   * object still holds every field on it.
   *
   * MUTANT: delete the `realm.brief = undefined` line in `close`. Nothing
   * observable breaks today, and the day something keys a side table off a
   * closed realm's brief it is a floor reaching back out of the grave.
   */
  it('leaves no objective behind on a realm that is closed', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    expect(realm.brief, 'precondition: something to forget').toBeDefined();
    expect(realms.close(realm.id)).toBe(true);
    expect(realms.get(realm.id)).toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });
});

// ===========================================================================
// 4d. WHICH BODY IS NAMED, AND THE THREE-PART ORDER THAT DECIDES IT
// ===========================================================================

describe('which body kept its name', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HIGHEST RANK, THEN FURTHEST FROM THE WAY IN, THEN THE LOWEST ID.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `markQuarry` argues all three at length and NOTHING TESTED ANY OF THEM: the
   * socket fixture deletes every hostile but one, so the comparison never runs
   * there, and the unit cases asserted only that one body was marked and that it
   * was not the offerer. Both survivors were found by mutation.
   *
   * MUTANT: `away > bestAway` -> `away < bestAway`. The nearest body is named,
   * so the objective is a monster standing at the door rather than *"the far end
   * of a floor that has to be crossed"*.
   *
   * MUTANT: `rank > bestRank` -> `rank < bestRank`. The weakest body is named,
   * and a quarry drawn as trash reads as trash.
   */
  it('names the highest rank, and the furthest of that rank from the arrival', () => {
    const realms = makeRealms();
    const { realm } = bareFloor(realms);
    const cells = freeCells(realm);
    const near = cells[0];
    const far = cells.at(-1);
    const alsoFar = cells.at(-2);
    if (near === undefined || far === undefined || alsoFar === undefined) {
      throw new Error('the floor had nowhere to stand three bodies');
    }
    // AN ELITE AT THE DOOR, A NORMAL AT THE FAR END, AN ELITE AT THE FAR END.
    // Rank decides first, so the far Normal loses to both Elites; distance
    // decides between the two Elites.
    putHostile(realm, 'm_near_elite', near, ActorRank.Elite);
    putHostile(realm, 'm_far_normal', far, ActorRank.Normal);
    putHostile(realm, 'm_far_elite', alsoFar, ActorRank.Elite);

    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(named, 'rank did not decide, or distance did not').toBe('m_far_elite');
    expect(realm.world.getActor('m_far_elite')?.name).toBe(QUARRY.quarry?.name);
    expect(realm.world.getActor('m_near_elite')?.name).not.toBe(QUARRY.quarry?.name);
  });

  /**
   * AND A TIE HAS ONE ANSWER ON EVERY MACHINE. `allActors` is an insertion-order
   * walk, so without the id term the winner would be whichever body the floor
   * happened to create first — a quarry that moves when an unrelated spawn is
   * reordered.
   *
   * MUTANT: drop the `body.id < best.id` clause. This passes or fails depending
   * on insertion order, which is the definition of a test of the fixture.
   */
  it('breaks a tie on the id, so every machine names the same body', () => {
    const realms = makeRealms();
    const { realm } = bareFloor(realms);
    const from = realm.spawns[0] ?? { x: 0, y: 0 };
    const away = (t: TileXY): number => Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y));
    // TWO CELLS THE SAME DISTANCE OUT, so only the id term can separate them.
    const cells = freeCells(realm);
    const furthest = away(cells.at(-1) ?? from);
    const tied = cells.filter((c) => away(c) === furthest);
    if (tied.length < 2) throw new Error('the floor has no two cells equally far out');
    const [first, second] = tied;
    if (first === undefined || second === undefined) throw new Error('unreachable');
    // `m_b` IS CREATED FIRST, so without the id clause insertion order wins.
    putHostile(realm, 'm_b', first, ActorRank.Elite);
    putHostile(realm, 'm_a', second, ActorRank.Elite);
    const a = realm.world.getActor('m_a');
    const b = realm.world.getActor('m_b');
    if (a === undefined || b === undefined) throw new Error('a body did not go down');
    expect(away(a), 'the fixture never made the two distances equal').toBe(away(b));

    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(named, 'the tie was broken by insertion order').toBe('m_a');
  });
});

// ===========================================================================
// 5. WHAT GOES ON THE WIRE, AND TO WHOM
// ===========================================================================

// ===========================================================================
// 4b. TAKING IT, REFUSING IT, AND THE BODY THAT KEEPS ITS NAME
// ===========================================================================

describe('taking an objective on', () => {
  /**
   * A QUARRY NAMES A BODY THAT WAS ALREADY STANDING THERE.
   *
   * `content/delve.ts` records that *"every number in `DELVES` was authored and
   * measured"*. Spawning an elite at the accept would be a population increase
   * on a floor sized without one, arriving through a conversation.
   *
   * MUTANT: have `acceptBrief` call `world.addMonster` instead of naming one of
   * the bodies already on the floor. The headcount assertion fails.
   */
  it('names a body the floor already had, and adds nobody', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const before = realm.world.allActors().length;
    const brief = acceptBrief(realm, 'dalt');
    expect(brief?.state).toBe(BriefState.Open);
    expect(brief?.acceptedBy).toBe('dalt');
    expect(realm.world.allActors().length, 'the accept put a body on the floor').toBe(before);
    const target = brief?.target;
    expect(target?.k).toBe(BriefKind.Quarry);
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(named, 'the accept named nothing').not.toBeNull();
    const body = realm.world.getActor(named ?? '');
    expect(body?.name).toBe('Maundy');
    expect(body?.kind).toBe(ActorKind.Monster);
  });

  /**
   * IT PICKS AN ENEMY OF THE PARTY, through `areEnemies` and not through a
   * second copy of the rule. The offerer is `Faction.Townsfolk` and is standing
   * four tiles from the arrival, which is nearer than most of the roster.
   *
   * MUTANT: filter on `kind === Monster && alive` alone. The person offering the
   * objective becomes the objective.
   */
  it('never names the person who offered it', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const armed = armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(named).not.toBe(armed?.offererId);
    expect(realm.world.getActor(armed?.offererId ?? '')?.name).toBe(WHO.name);
  });

  /**
   * THE MARK IS ON THAT BODY AND ON NO OTHER — `tome/class/GameState.lua:2702`
   * writes it onto the actor rather than onto the template, at grant time, so
   * that nothing spawned afterwards can wear it.
   *
   * MUTANT: set `mark` on every monster of that kind. Every husk on the floor
   * then reads as the one that kept its name, and the search is over before it
   * started.
   */
  it('marks the one body and nothing else on the floor', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    const marked = realm.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster)
      .filter((a) => a.mark !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.mark).toBe('UNMAKE THIS ONE');
    const target = brief?.target;
    expect(marked[0]?.id).toBe(target?.k === BriefKind.Quarry ? target.actorId : undefined);
    // AND THE REST OF THE FLOOR IS UNTOUCHED: more than one body was there to
    // get it wrong with.
    expect(
      realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length,
    ).toBeGreaterThan(1);
  });

  /**
   * TWO FRAMES CAN CROSS — `engine/interface/ActorQuest.lua:50` refuses a second
   * grant of an id already held, and ours refuses a second accept.
   *
   * MUTANT: drop the `state !== Offered` guard. The second accept re-marks a
   * second body, so the floor grows a name nobody agreed to and the first one
   * can no longer close the objective.
   */
  it('refuses a second accept and changes nothing', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const first = acceptBrief(realm, 'dalt');
    const target = first?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(acceptBrief(realm, 'wren')).toBeUndefined();
    expect(realm.brief?.acceptedBy).toBe('dalt');
    const after = realm.brief?.target;
    expect(after?.k === BriefKind.Quarry ? after.actorId : null).toBe(named);
    expect(
      realm.world
        .allActors()
        .filter((a) => a.kind === ActorKind.Monster)
        .filter((a) => a.mark !== undefined),
    ).toHaveLength(1);
  });

  /**
   * NOTHING LEFT TO NAME REFUSES THE ACCEPT, and the offer stands.
   *
   * MUTANT: open the objective anyway, with `actorId` still null. It can then
   * never close, the strip carries work that cannot be finished, and the only
   * way out of it is to walk off the floor.
   */
  it('refuses to open an objective a cleared floor cannot carry', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const armed = armBrief(realm);
    for (const body of realm.world.allActors()) {
      if (body.kind === ActorKind.Monster && body.id !== armed?.offererId) {
        realm.world.removeActor(body.id);
      }
    }
    expect(acceptBrief(realm, 'dalt')).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Offered);
    expect(realm.brief?.acceptedBy).toBeNull();
  });

  /**
   * REFUSING DELETES THE CONTENT — `tome/class/GameState.lua:2974-2976`,
   * `m:disappear() m:removed()`.
   *
   * MUTANT: leave the body standing. The offer can be asked again, for ever, by
   * anybody who walks back to it.
   */
  it('takes the person off the floor when the party refuses', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const armed = armBrief(realm);
    const offererId = armed?.offererId ?? '';
    expect(realm.world.getActor(offererId)).toBeDefined();
    const refused = declineBrief(realm);
    expect(refused?.title).toBe(QUARRY.title);
    expect(realm.brief, 'the offer survived a refusal').toBeUndefined();
    expect(realm.world.getActor(offererId), 'they are still standing there').toBeUndefined();
  });

  it('has nothing to refuse once the party has taken it', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    acceptBrief(realm, 'dalt');
    expect(declineBrief(realm)).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Open);
  });
});

/**
 * Walkable, unoccupied cells on this floor, nearest first by Chebyshev from the
 * arrival — everything the placement tests below need to stand a body somewhere
 * they chose rather than somewhere the generator did.
 */
function freeCells(realm: Realm): TileXY[] {
  const from = realm.spawns[0] ?? { x: 1, y: 1 };
  const taken = new Set(realm.world.allActors().map((a) => `${String(a.x)},${String(a.y)}`));
  const out: TileXY[] = [];
  for (let y = 0; y < realm.world.level.h; y += 1) {
    for (let x = 0; x < realm.world.level.w; x += 1) {
      const key = `${String(x)},${String(y)}`;
      if (taken.has(key) || realm.sites.has(key)) continue;
      if (realm.spawns.some((t) => t.x === x && t.y === y)) continue;
      if (!canWalk(realm.world.level, x, y)) continue;
      out.push({ x, y });
    }
  }
  out.sort(
    (a, b) =>
      Math.max(Math.abs(a.x - from.x), Math.abs(a.y - from.y)) -
      Math.max(Math.abs(b.x - from.x), Math.abs(b.y - from.y)),
  );
  return out;
}

/** An armed floor with NOTHING on it but the offerer — the placement fixtures. */
function bareFloor(realms: Realms): { realm: Realm; offererId: string } {
  const realm = floorWith(realms, [QUARRY], 2);
  const brief = armBrief(realm);
  const offererId = brief?.offererId ?? '';
  for (const body of realm.world.allActors()) {
    if (body.kind === ActorKind.Monster && body.id !== offererId) realm.world.removeActor(body.id);
  }
  return { realm, offererId };
}

/** One hostile, at a chosen cell, with a chosen rank and id. */
function putHostile(realm: Realm, id: string, at: TileXY, rank: ActorRank): void {
  const body = realm.world.addMonster(id, {
    name: id,
    sprite: 'mon_index_husk',
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    rank,
  });
  body.x = at.x;
  body.y = at.y;
}

// ===========================================================================
// 4c. WHAT THE PUMP DOES TO IT
// ===========================================================================

describe('unmaking the one that kept its name', () => {
  function taken(): { realm: Realm; brief: Brief; quarryId: string } {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    if (brief === undefined) throw new Error('the fixture never took it');
    const target = brief.target;
    const quarryId = target.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    return { realm, brief, quarryId };
  }

  /**
   * WHOEVER OR WHATEVER KILLED IT. Upstream pays the player for any
   * rank-above-3 death regardless of who swung
   * (`tome/class/Actor.lua:2983-2995`), and this generalises that.
   *
   * MUTANT: gate the close on a player having landed the blow. A trap kill, or
   * one monster killing another, then pays nothing and the objective stands
   * over a body that is already down.
   */
  it('closes on the body going down, whoever caused it', () => {
    const { realm, quarryId } = taken();
    expect(noteBriefProgress(realm), 'it closed before anything died').toBeUndefined();
    const body = realm.world.getActor(quarryId);
    if (body === undefined) throw new Error('nothing was named');
    // NOBODY SWUNG. This is what the floor killing it looks like from here, and
    // it is the case a death-list reading could not represent at all.
    body.hp = 0;
    body.alive = false;
    expect(noteBriefProgress(realm)).toBeDefined();
    expect(realm.brief?.state).toBe(BriefState.Closed);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BODY THAT IS GONE IS VOID, NOT DONE — IDENTITY, NOT PRESENCE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THIS TEST USED TO ASSERT THE OPPOSITE AND IT WAS THE BUG, WRITTEN DOWN. It
   * was true of its fixture — a body removed by hand, which only ever happens
   * here — and false of the rule: in the game the thing that deletes a marked
   * monster is `resetFloor`, which runs INSIDE the pump when the party wipes,
   * and the sweep reads the floor on the far side of it. So a party that died
   * on a floor whose quarry the reset happened not to re-mint was told *"Done:"*
   * and paid for it. Measured over a socket, +36 experience each.
   *
   * MUTANT: read `getActor(id) === undefined` as unmade again. A wipe pays.
   */
  it('does not close when the body is gone from the world entirely', () => {
    const { realm, quarryId } = taken();
    realm.world.removeActor(quarryId);
    expect(noteBriefProgress(realm), 'an absent body was read as an unmade one').toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Open);
  });

  /**
   * AND A DIFFERENT BODY UNDER THE SAME NAME IS ALSO VOID, which is the half a
   * removal alone cannot show. `reseedFloor` re-mints a delve's roster with
   * INDEX ids, so after a wipe `delve_7` is a brand-new, full-health monster
   * that answers to the string somebody agreed to unmake.
   *
   * `turn-engine.ts` states the rule this checks: *"`world.getActor(id) ===
   * body` is the whole test, and it has to be the OBJECT and not merely 'is
   * something there', because the re-seeded body answers to the same string."*
   *
   * MUTANT: compare the id rather than the object, and kill the impostor. The
   * objective closes on a body nobody ever agreed to hunt.
   */
  it('does not close on a different body wearing the same id', () => {
    const { realm, quarryId } = taken();
    realm.world.removeActor(quarryId);
    // THE SAME STRING, A NEW OBJECT — and dead, so only identity can refuse it.
    const at = realm.spawns[0] ?? { x: 2, y: 2 };
    const impostor = realm.world.addMonster(quarryId, {
      name: 'Maundy',
      sprite: 'mon_index_husk',
      x: at.x,
      y: at.y,
      profile: AiProfile.MeleeChaser,
    });
    impostor.hp = 0;
    impostor.alive = false;
    expect(realm.world.getActor(quarryId), 'the fixture never re-minted the id').toBeDefined();
    expect(
      noteBriefProgress(realm),
      'a re-seeded body closed somebody else`s work',
    ).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Open);
  });

  it('is unmoved by every other body on the floor going down', () => {
    const { realm } = taken();
    const target = realm.brief?.target;
    const named = target?.k === BriefKind.Quarry ? target.actorId : null;
    const others = realm.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster)
      .filter((a) => a.id !== named);
    expect(others.length, 'the fixture had nothing else to kill').toBeGreaterThan(0);
    for (const body of others) {
      body.hp = 0;
      body.alive = false;
    }
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Open);
  });

  /**
   * AND IT CLOSES ONCE. The sweep runs after every pump, and a brief that
   * reported itself closed twice would pay twice.
   *
   * MUTANT: drop the `state !== Open` guard at the top of `noteBriefProgress`.
   */
  it('reports the close exactly once', () => {
    const { realm, quarryId } = taken();
    const body = realm.world.getActor(quarryId);
    if (body === undefined) throw new Error('nothing was named');
    body.hp = 0;
    body.alive = false;
    expect(noteBriefProgress(realm)).toBeDefined();
    expect(noteBriefProgress(realm)).toBeUndefined();
  });

  it('has nothing to report for an objective nobody took', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    for (const body of realm.world.allActors()) {
      if (body.kind === ActorKind.Monster) realm.world.removeActor(body.id);
    }
    expect(noteBriefProgress(realm)).toBeUndefined();
    expect(realm.brief?.state).toBe(BriefState.Offered);
  });

  /**
   * THE REWARD LANDS ON THE OBJECTIVE'S OWN TILE, and never in anybody's bag.
   *
   * MUTANT: return the accepter's tile instead. The item then follows the lead,
   * which is the party-split rule this game deliberately does not have.
   */
  it('puts the reward where the body was', () => {
    const { realm, quarryId } = taken();
    const body = realm.world.getActor(quarryId);
    if (body !== undefined) body.alive = false;
    noteBriefProgress(realm);
    const at = rewardCell(realm, realm.brief ?? ({} as Brief));
    expect(at).toEqual({ x: body?.x, y: body?.y });
  });

  /**
   * AND IT IS NOT THE ACCEPTER'S TILE, which is the answer a reader reaches for
   * and is the party-split rule this game deliberately does not have: *"loot and
   * gold are whoever gets there first"*.
   *
   * MUTANT: return the accepter's position. The lead becomes a hoarder by
   * construction, and the case above cannot tell the difference — its fixture
   * accepts under an id with no body behind it.
   */
  it('never puts the reward under whoever answered for the party', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    // A REAL BODY FOR THE ACCEPTER, standing somewhere the quarry is not.
    const lead = realm.world.addPlayer('lead', 'Lead');
    const brief = acceptBrief(realm, lead.id);
    const target = brief?.target;
    const named = target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '';
    const body = realm.world.getActor(named);
    if (body === undefined) throw new Error('nothing was named');
    lead.x = body.x + 3;
    lead.y = body.y;
    body.alive = false;
    noteBriefProgress(realm);
    expect(rewardCell(realm, realm.brief ?? ({} as Brief))).toEqual({ x: body.x, y: body.y });
  });
});

// ===========================================================================
// 4d. WHAT THE OFFERER SAYS, AND TO WHOM
// ===========================================================================

describe('the direction answer', () => {
  /**
   * `tome/class/Party.lua:412-414`, its three bands and no fourth.
   *
   * MUTANT: make the bands inclusive at the top. 8 then reads "very close" and
   * 16 reads "close", which is one band wrong for every distance on a boundary.
   */
  it('ports the three bands exactly', () => {
    expect(distanceBand(0)).toBe('very close');
    expect(distanceBand(7.9)).toBe('very close');
    expect(distanceBand(8)).toBe('close');
    expect(distanceBand(15.9)).toBe('close');
    expect(distanceBand(16)).toBe('still far away');
  });

  /**
   * ONE ANSWER PER ASKER, computed from the asker's own body.
   *
   * MUTANT: compute it from the offerer's tile instead of the asker's. Every
   * member of the party then gets the same answer, which is the one thing a
   * warm-and-cold game must not do.
   */
  it('answers two people standing in two places two different things', () => {
    const { realm, quarryId } = (() => {
      const realms = makeRealms();
      const floor = floorWith(realms, [QUARRY], 2);
      armBrief(floor);
      const brief = acceptBrief(floor, 'dalt');
      const target = brief?.target;
      return {
        realm: floor,
        quarryId: target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '',
      };
    })();
    const body = realm.world.getActor(quarryId);
    const speaker = realm.brief?.offererId ?? '';
    const west = briefSnapshotFor(realm, speaker, { x: (body?.x ?? 0) - 20, y: body?.y ?? 0 });
    const beside = briefSnapshotFor(realm, speaker, { x: (body?.x ?? 0) - 1, y: body?.y ?? 0 });
    expect(west?.bearing).toBe('east');
    expect(west?.band).toBe('still far away');
    expect(beside?.bearing).toBe('east');
    expect(beside?.band).toBe('very close');
    expect(west?.name).toBe('Maundy');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAND IS EUCLIDEAN, AND ONLY A DIAGONAL CAN SHOW IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Party.lua:411` is `core.fov.distance`, a straight-line radius, and the
   * three bands were chosen against it. Every fixture that exercised the bands
   * was AXIS-ALIGNED (dx=20/dy=0, dx=-1/dy=0), where Euclidean and Chebyshev
   * agree exactly — so swapping one for the other changed no test at all.
   *
   * dx=dy=7 is 9.9 Euclidean ("close") and 7 Chebyshev ("very close"), which is
   * the whole difference in one case.
   *
   * MUTANT: `Math.hypot` -> `Math.max(Math.abs(dx), Math.abs(dy))`. The offerer
   * calls a body ten tiles away "very close", and a party walks the wrong way.
   */
  it('measures the distance in a straight line and not in king moves', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const body = realm.world.getActor(target?.k === BriefKind.Quarry ? (target.actorId ?? '') : '');
    const speaker = realm.brief?.offererId ?? '';
    if (body === undefined) throw new Error('nothing was named');
    const said = briefSnapshotFor(realm, speaker, { x: body.x - 7, y: body.y - 7 });
    expect(said?.band, 'the diagonal was measured in king moves').toBe('close');
    expect(said?.bearing).toBe('south-east');
    // AND THE TWO BANDS STILL MEET WHERE THEY MEET, read off the function
    // directly: 7.99 is inside the first band and 8 is not.
    expect(distanceBand(Math.hypot(7, 7))).toBe('close');
    expect(distanceBand(Math.hypot(5, 5))).toBe('very close');
  });

  /**
   * AND NOTHING AT ALL BEFORE THE ACCEPT, which is what makes the search a
   * search: the offerer can say what it is and what it pays, and not where.
   *
   * MUTANT: resolve the quarry at arm time. The bearing is then available to a
   * party that has agreed to nothing.
   */
  it('has no bearing to give while the objective is only offered', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    const armed = armBrief(realm);
    const said = briefSnapshotFor(realm, armed?.offererId ?? '', { x: 1, y: 1 });
    expect(said?.state).toBe(BriefState.Offered);
    expect(said?.title).toBe(QUARRY.title);
    expect(said?.bearing).toBeUndefined();
    expect(said?.band).toBeUndefined();
  });

  /**
   * AND EVERY OTHER PERSON IN THE GAME IS ASKED THE SAME QUESTION AND SAYS NO.
   * That is the whole of what keeps the four brief rows out of sixteen
   * shopkeepers' conversations.
   *
   * MUTANT: answer off the realm alone, ignoring the speaker. Every townsperson
   * on a floor with an objective then offers it.
   */
  it('is nobody`s answer but the offerer`s', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    expect(briefSnapshotFor(realm, 'somebody-else', { x: 1, y: 1 })).toBeUndefined();
  });
});

// ===========================================================================
// 4e. A WIPE UNDOES IT
// ===========================================================================

describe('a party wipe', () => {
  /**
   * `resetFloor`'s own header: *"A RESET MEANS THE FIGHT DID NOT HAPPEN"*. It
   * reaps every monster on the floor, including the person offering the
   * objective and the body that kept its name, so the objective is re-armed
   * from scratch rather than exempted from the reap.
   *
   * MUTANT: call `armBrief` rather than `rearmBrief`. Its idempotence guard sees
   * a brief already on the realm and returns it unchanged — so the party is left
   * holding an OPEN objective naming a body the reset deleted, which can never
   * close and never fail.
   */
  it('puts the objective back, offered, with a person to offer it', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [QUARRY], 2);
    armBrief(realm);
    const brief = acceptBrief(realm, 'dalt');
    const target = brief?.target;
    const wasNamed = target?.k === BriefKind.Quarry ? target.actorId : null;
    expect(wasNamed).not.toBeNull();

    // WHAT A RESET DOES, in the one line this rule is about: every monster
    // reaped. `turn-engine.ts` does it through `reap`; here the same removal.
    for (const body of realm.world.allActors()) {
      if (body.kind === ActorKind.Monster) realm.world.removeActor(body.id);
    }
    // AND PUT BACK WHAT THE RESET PUTS BACK — `World.reseedFloor` is the
    // floor's own repopulation, which is what gives the second accept a body
    // to name. Without it this case would prove only half the rule.
    realm.world.reseedFloor?.(realm.world);

    const again = rearmBrief(realm);
    expect(again?.state).toBe(BriefState.Offered);
    expect(again?.acceptedBy).toBeNull();
    expect(realm.world.getActor(again?.offererId ?? '')?.name).toBe(WHO.name);
    // AND IT IS TAKEABLE A SECOND TIME, which is the point of undoing it.
    const retaken = acceptBrief(realm, 'dalt');
    expect(retaken?.state).toBe(BriefState.Open);
    const retarget = retaken?.target;
    expect(retarget?.k === BriefKind.Quarry ? retarget.actorId : null).not.toBeNull();
  });

  it('arms nothing on a floor that carries none', () => {
    const realms = makeRealms();
    const realm = floorWith(realms, [], 2);
    expect(rearmBrief(realm)).toBeUndefined();
    expect(realm.brief).toBeUndefined();
  });
});

describe('who the strip is sent to', () => {
  function brief(state: (typeof BriefState)[keyof typeof BriefState], taker: string | null): Brief {
    const realm = floorWith(makeRealms(), [QUARRY], 2);
    const armed = armBrief(realm);
    if (armed === undefined) throw new Error('nothing armed');
    armed.state = state;
    armed.acceptedBy = taker;
    return armed;
  }

  it('says nothing at all when there is no objective', () => {
    expect(briefViewFor(undefined, 'dalt', ['dalt'])).toBeNull();
  });

  /**
   * An offer nobody has accepted is not an objective; it is a person standing
   * on the floor, and the Case Log announces them.
   *
   * MUTANT: drop the `acceptedBy === null` arm. The strip then advertises work
   * the party never agreed to, for the whole length of the floor.
   */
  it('says nothing about an offer nobody took', () => {
    expect(briefViewFor(brief(BriefState.Offered, null), 'dalt', ['dalt'])).toBeNull();
  });

  /**
   * MUTANT: pay attention to the reader rather than to their PARTY — return the
   * view only when `acceptedBy === viewer`. The three people who followed the
   * lead in then have an empty strip while doing the thing.
   */
  it('goes to everybody in the party that took it, not only to the taker', () => {
    const taken = brief(BriefState.Open, 'dalt');
    expect(briefViewFor(taken, 'dalt', ['dalt', 'wren'])).toEqual({
      state: BriefState.Open,
      title: QUARRY.title,
    });
    expect(briefViewFor(taken, 'wren', ['dalt', 'wren'])).toEqual({
      state: BriefState.Open,
      title: QUARRY.title,
    });
    // AND A BODY ON THE SAME FLOOR WHO IS NOT IN THAT PARTY READS NOTHING.
    expect(briefViewFor(taken, 'stranger', ['dalt', 'wren'])).toBeNull();
  });

  /**
   * ═══ INCLUDING THE PERSON WHO ANSWERED, ONCE THEY ARE NOT IN IT ═══
   * The third argument is the party that HOLDS THE FLOOR, not the reader's own.
   * The old rule short-circuited on `acceptedBy === viewer`, which made the
   * taker an unconditional reader — so a lead who walked out of the party kept
   * the band on screen for the rest of the floor.
   *
   * MUTANT: restore the `taker === viewer` shortcut. A deserter reads an
   * objective they are no longer part of.
   */
  it('says nothing to the person who took it once they have left that party', () => {
    const taken = brief(BriefState.Open, 'dalt');
    expect(briefViewFor(taken, 'dalt', ['wren'])).toBeNull();
    expect(briefViewFor(taken, 'wren', ['wren'])).not.toBeNull();
  });

  /**
   * `BeaconView`'s header forbids a beacon carrying a hostile: a position is
   * *"the intelligence the fog exists to withhold"*.
   *
   * MUTANT: add a tile to the view. Every rule about how an objective's
   * location reaches a player is then advisory.
   */
  it('carries the words and no position of any kind', () => {
    const taken = brief(BriefState.Open, 'dalt');
    const view = briefViewFor(taken, 'dalt', ['dalt']);
    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {}).sort()).toEqual(['state', 'title']);
  });

  it('carries a count only when the objective has one', () => {
    expect(progressText(null)).toBeUndefined();
    expect(progressText({ done: 1, total: 3 })).toBe('1 / 3');
    const taken = brief(BriefState.Open, 'dalt');
    taken.progress = { done: 2, total: 4 };
    expect(briefViewFor(taken, 'dalt', ['dalt'])?.progress).toBe('2 / 4');
  });

  it('carries the ending state verbatim rather than falling silent', () => {
    // The client stops DRAWING a brief that ended; the frame still says so, and
    // that is what makes "it is over" different from "the frame never arrived".
    expect(briefViewFor(brief(BriefState.Failed, 'dalt'), 'dalt', ['dalt'])?.state).toBe(
      BriefState.Failed,
    );
  });
});

// ===========================================================================
// 6. NOTHING ABOUT A BRIEF IS EVER WRITTEN TO DISK
// ===========================================================================

describe('a brief is not persisted, and nothing may start', () => {
  /**
   * ═══ THE SCRAPE IS THE MECHANISM, AND THE CUT IT DEFENDS IS OLDER ═══
   * `docs/tome-port.md` cuts `Quest` outright, and the honest failure mode of
   * this whole feature is that "an objective on one floor" becomes a quest
   * system with a log, a panel and a save field. `Realm.brief` being the one
   * home is half of what stops that; the other half is that the save file never
   * learns the word.
   *
   * MUTANT: add `brief` to `CharacterFile`. Nothing breaks, nothing fails, and
   * the narrowness that makes a brief affordable is gone — a saved objective
   * belongs to a character rather than to a floor, and every rule in
   * `world/brief.ts` is then a rule about the wrong thing.
   */
  it('is not a word the save file knows', () => {
    const saves = readFileSync(
      new URL('../../src/server/persist/saves.ts', import.meta.url),
      'utf8',
    );
    const file = saves.slice(saves.indexOf('export type CharacterFile'));
    /**
     * ═══ THE TYPE'S OWN CLOSE, AT COLUMN ZERO, AND NOT THE FIRST `};` ═══
     * It was `indexOf('};')`, which stops at the close of the first NESTED
     * object literal in the type — `lastLearnt?: { … };`. MEASURED: 6,414 of
     * 26,484 characters, 24% of the declaration. Everything after it —
     * `carried`, `kitGranted`, `money`, `resources`, `position`, `updatedAt` —
     * went unread, which is exactly where a new field is appended.
     *
     * MUTANT: add `readonly brief?: string;` beside `updatedAt`, where a new
     * field naturally goes. The old slice never saw it.
     */
    // THE CLOSE AT COLUMN ZERO, found by shape rather than by counting: a
    // nested literal's `};` is indented and the type's own is not.
    const body = file.slice(0, /^};/m.exec(file)?.index ?? file.length);
    expect(body.length, 'CharacterFile moved or was renamed').toBeGreaterThan(0);
    // THE LAST FIELD OF THE TYPE, SO A RE-TRUNCATION IS LOUD RATHER THAN
    // SILENT. A slice that stops early passes this file by reading less of it.
    expect(body, 'the scrape stopped before the end of CharacterFile').toContain('updatedAt');
    expect(body.toLowerCase()).not.toContain('brief');
  });
});

// ===========================================================================
// 7. THE FRAME IS VIEWER-PRIVATE, AS A COMPILE ERROR
// ===========================================================================

describe('a brief frame is viewer-scoped by construction', () => {
  it('is a ViewerMsg and is therefore NOT assignable to BroadcastMsg', () => {
    /**
     * THE `@ts-expect-error` IS THE ENFORCEMENT AND THE `expect` IS DECORATION,
     * exactly as `keybinds-wire.test.ts` states for its own frame. Whether
     * there is an objective at all depends on whether the READER'S party took
     * it, so `broadcast(briefMsg)` must not compile. If `BriefMsg` is ever
     * dropped from `ViewerMsg`, the expect-error becomes unused and
     * `npm run typecheck` fails in the file that made the claim.
     */
    const msg: BriefMsg = {
      v: PROTOCOL_VERSION,
      t: 'brief',
      brief: { state: BriefState.Open, title: 'It kept its name' },
    };
    const viewer: ViewerMsg = msg;
    expect(viewer.t).toBe('brief');

    // @ts-expect-error a brief is true for one party, so it must never be
    // assignable to the type `broadcast` accepts.
    const broadcastable: BroadcastMsg = msg;
    expect(broadcastable).toBeDefined();
  });
});

// ===========================================================================
// 8. OVER A REAL SOCKET — THE JOIN, NOT THE HALVES
// ===========================================================================

describe('the objective, over the wire and across the floor`s edge', () => {
  let harness: {
    port: number;
    realms: Realms;
    parties: PartyState;
    close: () => Promise<void>;
  };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'brief-wire',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    harness = {
      port: address.port,
      realms,
      parties,
      close: async (): Promise<void> => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await harness.close();
  });

  type Client = {
    readonly actorId: string;
    readonly frames: readonly Record<string, unknown>[];
    move(dir: string): Promise<void>;
  };

  async function join(): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}/ws`);
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) {
        frames.push({ ...(parsed as Record<string, unknown>) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello' }));
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof id === 'string') {
        return {
          actorId: id,
          frames,
          async move(dir: string): Promise<void> {
            socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir }));
            await sleep(250);
          },
        };
      }
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }
  }

  const STEPS = [
    { dir: 'e', dx: 1, dy: 0, back: 'w' },
    { dir: 'w', dx: -1, dy: 0, back: 'e' },
    { dir: 's', dx: 0, dy: 1, back: 'n' },
    { dir: 'n', dx: 0, dy: -1, back: 's' },
  ] as const;

  function realmOf(client: Client): Realm {
    const realm = harness.realms.realmOf(client.actorId);
    if (realm === undefined) throw new Error('the body is in no realm');
    return realm;
  }

  function briefFrames(client: Client): BriefMsg[] {
    return client.frames.filter((f) => f['t'] === 'brief') as unknown as BriefMsg[];
  }

  /**
   * Empty a floor and stand the fight down, so nothing here is about the
   * barrier.
   *
   * ═══ THE SECOND LINE IS NOT DECORATION, AND IT COST AN HOUR ═══
   * `engagement` is a COUNTDOWN (`world.turn.engagement`, decayed a turn at a
   * time so a fight does not flicker), not a headcount — so a floor whose
   * monsters have just been deleted is still an armed barrier for three more
   * turns. With one player that is invisible: their own commit resolves the
   * turn. With two it is not: the second player's step is held as an intent
   * waiting for the first to commit, the body never moves, and the crossing
   * under test never happens while every assertion still reads plausibly.
   */
  function clear(realm: Realm): void {
    for (const actor of realm.world.allActors()) {
      if (actor.kind === ActorKind.Monster) realm.world.removeActor(actor.id);
    }
    realm.world.turn.engagement = 0;
  }

  async function stepOnto(client: Client, cell: TileXY): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    for (const step of STEPS) {
      const x = cell.x - step.dx;
      const y = cell.y - step.dy;
      if (!canWalk(realm.world.level, x, y) || realm.world.actorAt(x, y) !== undefined) continue;
      body.x = x;
      body.y = y;
      await client.move(step.dir);
      return;
    }
    throw new Error('no open ground beside the cell');
  }

  /** Stand on the threshold, step off it and back on: what leaving is. */
  async function leaveByThreshold(client: Client): Promise<void> {
    const realm = realmOf(client);
    const body = realm.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const onThreshold = (x: number, y: number): boolean =>
      realm.spawns.some((t) => t.x === x && t.y === y);
    for (const tile of realm.spawns) {
      // NOT A TILE SOMEBODY ELSE IS ON: two party members leave by the same
      // cluster, and this places the body by hand.
      const sitting = realm.world.actorAt(tile.x, tile.y);
      if (sitting !== undefined && sitting.id !== body.id) continue;
      for (const step of STEPS) {
        const x = tile.x + step.dx;
        const y = tile.y + step.dy;
        if (onThreshold(x, y) || !canWalk(realm.world.level, x, y)) continue;
        if (realm.world.actorAt(x, y) !== undefined) continue;
        body.x = tile.x;
        body.y = tile.y;
        await client.move(step.dir);
        await client.move(step.back);
        return;
      }
    }
    throw new Error('no threshold tile has open ground beside it');
  }

  /** Walk this client into floor 1 of the Underworks. */
  async function enterDelve(client: Client): Promise<Realm> {
    const door = [...harness.realms.overworld.sites].find(([, id]) => id === UNDERWORKS);
    if (door === undefined) throw new Error('no door to the Underworks');
    const [dx, dy] = door[0].split(',').map(Number);
    if (dx === undefined || dy === undefined) throw new Error('a bad door cell');
    await stepOnto(client, { x: dx, y: dy });
    const inside = realmOf(client);
    if (inside.siteId !== UNDERWORKS) throw new Error('never went in');
    return inside;
  }

  /**
   * Open a floor of the Underworks for this player's party BEFORE they walk in,
   * off a site definition carrying `specs`.
   *
   * `realms.open` is idempotent on (partyId, siteId, floor), so the door the
   * player then walks through hands them THIS instance — which is how a floor
   * that carries an objective is reachable over a real socket before any site
   * in the game authors one.
   */
  function prepareFloor(client: Client, specs: readonly BriefSpec[], floor: number): Realm {
    const partyId = partyIdOf(harness.parties, client.actorId);
    return floorWith(harness.realms, specs, floor, partyId);
  }

  it('sends the withdrawal on a floor with nothing on it', async () => {
    // A `brief` frame arrives with the welcome, saying there is nothing. Without
    // it a reconnecting client keeps whatever it was drawing when the socket
    // died. MUTANT: make `sendBrief` silent when there is no objective.
    const client = await join();
    const frames = briefFrames(client);
    expect(frames.length, 'no brief frame arrived with the welcome').toBeGreaterThan(0);
    expect(frames[0]?.brief).toBeNull();
  });

  /**
   * THE JOIN: `crossIntoRealm` arms the floor the party walked into.
   *
   * MUTANT: delete the `armBrief(to)` call. Every unit test above still passes
   * and no floor in the game ever has an objective on it.
   */
  it('arms the floor the party walks into, and not the one they left', async () => {
    const client = await join();
    prepareFloor(client, [ESCORT], 1);
    expect(harness.realms.overworld.brief, 'the moor armed something').toBeUndefined();
    const inside = await enterDelve(client);
    expect(inside.brief, 'walking in armed nothing').toBeDefined();
    expect(inside.brief?.state).toBe(BriefState.Offered);
    expect(inside.brief?.id).toBe(briefIdFor(UNDERWORKS, 1));
  });

  /**
   * THE STRIP REACHES THE PARTY THAT TOOK IT. Driven over a socket with a
   * hand-set open brief, because nothing can ACCEPT one yet.
   *
   * MUTANT: remove `sendBrief` from the crossing. The objective exists, every
   * server-side test passes, and no player ever sees it.
   */
  it('puts an open objective on the arriving player`s strip', async () => {
    const client = await join();
    const floor = prepareFloor(client, [ESCORT], 1);
    const armedBrief = armBrief(floor);
    if (armedBrief === undefined) throw new Error('nothing armed');
    armedBrief.state = BriefState.Open;
    armedBrief.acceptedBy = client.actorId;

    await enterDelve(client);
    const last = briefFrames(client).at(-1);
    expect(last?.brief).toEqual({ state: BriefState.Open, title: ESCORT.title });
  });

  /**
   * THE EDGE, AT THE STAIR DOWN. `goDown` -> `crossIntoRealm`, and the objective
   * ends on the floor being left rather than following the party down.
   *
   * MUTANT: move the teardown below `from.world.removePlayer`. The rule it
   * breaks is invisible here and fatal in Phase 3: the member who was standing
   * beside the destination is gone by then, so an objective that was MET at the
   * moment of leaving reads as unmet.
   */
  it('fails an open objective when the last of the party takes the stair down', async () => {
    const client = await join();
    const floor = prepareFloor(client, [ESCORT], 1);
    const armedBrief = armBrief(floor);
    if (armedBrief === undefined) throw new Error('nothing armed');
    armedBrief.state = BriefState.Open;
    armedBrief.acceptedBy = client.actorId;

    const first = await enterDelve(client);
    clear(first);
    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('the first floor has no stair down');
    await stepOnto(client, stairs);

    expect(realmOf(client).floor, 'never went down').toBe(2);
    expect(first.brief, 'the floor behind them kept its objective').toBeUndefined();
    expect(armedBrief.state).toBe(BriefState.Failed);
    expect(briefFrames(client).at(-1)?.brief, 'the strip did not clear').toBeNull();
  });

  /**
   * THE EDGE, AT THE THRESHOLD — `crossOut`, which is the OTHER seam and is a
   * different function from the one above.
   *
   * MUTANT: wire the teardown into `crossIntoRealm` alone, which is what the
   * design said before `leaveRealm`'s crossing half was extracted. Walking out
   * of a delve then leaves the objective standing on an instance that lingers
   * for five minutes and can be walked back into.
   */
  it('fails an open objective when the last of the party walks back out', async () => {
    const client = await join();
    const floor = prepareFloor(client, [ESCORT], 1);
    const armedBrief = armBrief(floor);
    if (armedBrief === undefined) throw new Error('nothing armed');
    armedBrief.state = BriefState.Open;
    armedBrief.acceptedBy = client.actorId;

    const inside = await enterDelve(client);
    clear(inside);
    await leaveByThreshold(client);

    expect(realmOf(client).id, 'never came out').toBe(harness.realms.overworld.id);
    expect(inside.brief).toBeUndefined();
    expect(armedBrief.state).toBe(BriefState.Failed);
  });

  /**
   * THE LAST ONE OUT, NOT THE FIRST — a genuine divergence from upstream, which
   * has one player and cannot ask the question. Ours asks the same emptiness
   * question `reapIfEmpty` already asks.
   *
   * MUTANT: drop the "anybody else still standing here" check in
   * `endFloorBrief`. One member stepping out for a moment then takes the
   * objective away from the three still fighting for it — and the party that
   * split up, which the barrier already tolerates, is punished for it.
   */
  it('stands while one member steps out, and ends when the last of them goes', async () => {
    const one = await join();
    const two = await join();
    // ONE PARTY, THROUGH THE PARTY TABLE THE GATEWAY IS HOLDING — so both doors
    // open the same instance. The wire verbs for this have their own suite.
    const now = Date.now();
    expect(invite(harness.parties, one.actorId, two.actorId, now).ok).toBe(true);
    expect(accept(harness.parties, two.actorId, one.actorId, now).ok).toBe(true);

    const floor = prepareFloor(one, [ESCORT], 1);
    const armedBrief = armBrief(floor);
    if (armedBrief === undefined) throw new Error('nothing armed');
    armedBrief.state = BriefState.Open;
    armedBrief.acceptedBy = one.actorId;

    const inside = await enterDelve(one);
    clear(inside);
    expect((await enterDelve(two)).id, 'the two ended up on different floors').toBe(inside.id);
    clear(inside);

    // ═══ ONE OF THEM STEPS OUT ═══
    // The other stands well clear of the doorstep first: `leaveByThreshold`
    // places a body by hand, and two of them shuffling on a six-tile spawn
    // cluster is a fixture problem rather than a rule.
    const away = stairsDownOf(inside);
    if (away === null) throw new Error('the first floor has no stair down');
    const stayer = inside.world.getActor(one.actorId);
    if (stayer === undefined) throw new Error('no body inside');
    stayer.x = away.x;
    stayer.y = away.y;
    await leaveByThreshold(two);
    expect(realmOf(two).id, 'never came out').toBe(harness.realms.overworld.id);
    expect(inside.brief, 'one member leaving ended it for everybody').toBeDefined();
    expect(armedBrief.state).toBe(BriefState.Open);
    // AND THEIR OWN STRIP CLEARS, because they are not on that floor any more.
    expect(briefFrames(two).at(-1)?.brief).toBeNull();

    // ═══ AND THEN THE LAST OF THEM DOES ═══
    await leaveByThreshold(one);
    expect(realmOf(one).id, 'never came out').toBe(harness.realms.overworld.id);
    expect(inside.brief).toBeUndefined();
    expect(armedBrief.state).toBe(BriefState.Failed);
  });
});
