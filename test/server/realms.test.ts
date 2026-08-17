/**
 * Realms — more than one place to be.
 *
 * The whole overworld design rests on a claim that is cheap to state and easy
 * to get wrong: separate `World` closures make cross-map bleed impossible by
 * construction rather than by filtering. These tests are that claim, written
 * down as the failures they prevent.
 *
 * The two most important are `engagement` and the seed. Engagement was ONE
 * process-wide number computed by scanning every monster against every player
 * (scheduler.ts:3046-3076), and it is the last clause of `isBlocking` — so
 * before realms, one fight anywhere armed the barrier for everybody, and a
 * player alone on an empty street would eat a 20-second Bell for a fight they
 * could not see. And two worlds built from one seed string are not independent,
 * they are MIRRORED: identical to-hit rolls, crits and drops in lockstep.
 */

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { OVERWORLD_ID, RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { makeTestMap } from '../../src/shared/level.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { Realms, SiteDef } from '../../src/server/world/realms.ts';

/** The towns, derived rather than restated so the table stays the one source. */
const COMMON_SITES = [...SITES.values()]
  .filter((s) => s.kind === RealmKind.Common)
  .map((s) => s.id);

/**
 * The engine factory a test needs: one per world, with the process-wide tables
 * shared across realms exactly as main.ts shares them. `downed` and `parties`
 * are deliberately built ONCE and closed over — a five-turn Downed countdown
 * must follow a body through a door, and a party is a social fact that outlives
 * every map.
 */
function makeRealms(seed = 'test-seed'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
}

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

describe('the overworld', () => {
  it('exists at boot, is Alderbrook, and is the only overworld', () => {
    const realms = makeRealms();
    expect(realms.overworld.id).toBe(OVERWORLD_ID);
    expect(realms.overworld.kind).toBe(RealmKind.Overworld);
    expect(realms.overworld.name).toBe('Alderbrook');
    expect(realms.all().filter((r) => r.kind === RealmKind.Overworld)).toHaveLength(1);
  });

  it('boots with the city plus every town, and no instances', () => {
    // Common realms are built eagerly so `all()` is a stable set the pump can
    // iterate, and so two people stepping through the office door in the same
    // millisecond cannot create two offices.
    const realms = makeRealms();
    expect(realms.all()).toHaveLength(1 + COMMON_SITES.length);
    expect(realms.all().filter((r) => r.kind === RealmKind.Inner)).toEqual([]);
  });

  it('holds the city, not the test level', () => {
    const realms = makeRealms();
    expect(realms.overworld.world.level.w).toBe(64);
    expect(realms.overworld.world.level.h).toBe(48);
  });

  it('has no hostiles, and that is load-bearing rather than flavour', () => {
    // At engagement 0 nobody blocks, no Bell can arm, and movement free-runs
    // (barrier.ts:143-148, :304, :351). That is what lets six people wander
    // Alderbrook at their own pace on the same turn engine that phase-locks a
    // fight. It is ALSO what makes a follow-prompt safe: a prompted player is
    // parked out of `blocking` but stays in the quorum's denominator as a
    // permanent yes-vote, which would shorten a genuinely-solo friend's Bell
    // from 120s to 20s — except that on the overworld no Bell exists at all.
    const realms = makeRealms();
    const monsters = realms.overworld.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(monsters).toEqual([]);
    expect(realms.overworld.world.turn.engagement).toBe(0);
  });

  it('cannot be closed', () => {
    const realms = makeRealms();
    expect(realms.close(OVERWORLD_ID)).toBe(false);
    expect(realms.get(OVERWORLD_ID)).toBeDefined();
  });

  it('opens onto all eight authored sites', () => {
    const realms = makeRealms();
    expect([...realms.overworld.sites.values()].sort()).toEqual([...SITES.keys()].sort());
  });
});

describe('a town is open to everybody', () => {
  it('gives two unrelated parties the SAME office', () => {
    // The rule: a common space has no combat, so there is nothing to
    // coordinate, so there is no reason to keep anyone out. This is the half
    // that makes the world feel populated rather than a set of private rooms.
    const realms = makeRealms();
    const mine = realms.open(site('site:office'), 'party_1');
    const theirs = realms.open(site('site:office'), 'party_2');
    expect(theirs.id).toBe(mine.id);
    expect(mine.kind).toBe(RealmKind.Common);
    expect(mine.partyId).toBeUndefined();
  });

  it('never spawns anything, which is what makes it shareable', () => {
    const realms = makeRealms();
    for (const id of COMMON_SITES) {
      const town = realms.open(site(id), 'party_1');
      expect(town.world.allActors().filter((a) => a.kind === ActorKind.Monster)).toEqual([]);
      expect(town.world.turn.engagement).toBe(0);
    }
  });

  it('refuses to be built with a population at all', () => {
    // Not a warning. One monster in an open town lifts engagement above zero,
    // and `isBlocking` then returns true for every unrelated player standing in
    // it — they all start waiting on people they never agreed to play with,
    // with a Bell running and nothing on screen explaining why.
    expect(() =>
      createRealms({
        seed: 'x',
        engineFor: (world) =>
          createTurnEngine({ world, downed: createDownedState(), parties: createPartyState() }),
        sites: new Map([
          [
            'site:bad',
            {
              id: 'site:bad',
              name: 'A town with monsters in it',
              kind: RealmKind.Common,
              map: makeTestMap,
              populate: () => undefined,
            },
          ],
        ]),
      }),
    ).toThrow(/shared\s+space cannot have hostiles/);
  });

  it('is never closed, empty or not', () => {
    // A town is a place, not a session. Somebody walking back for the coat they
    // dropped there must find it.
    const realms = makeRealms();
    const office = realms.open(site('site:office'), 'party_1');
    expect(realms.empty()).toEqual([]);
    expect(realms.close(office.id)).toBe(false);
    expect(realms.get(office.id)).toBeDefined();
  });
});

describe('instances are per party', () => {
  it('opens a fresh inner realm for a party', () => {
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');
    expect(inner.kind).toBe(RealmKind.Inner);
    expect(inner.partyId).toBe('party_1');
    expect(inner.siteId).toBe('site:underworks');
  });

  it('is idempotent on (party, site), so a declined prompt is recoverable', () => {
    // THE POINT: a player who declines "follow your party?" and walks onto the
    // site themselves five minutes later must land WITH their friends, not in a
    // second private copy of the same floor beside them.
    const realms = makeRealms();
    const first = realms.open(site('site:glass_archive'), 'party_1');
    const second = realms.open(site('site:glass_archive'), 'party_1');
    expect(second.id).toBe(first.id);
    expect(realms.all().filter((r) => r.kind === RealmKind.Inner)).toHaveLength(1);
  });

  it('gives two different parties two different instances of one site', () => {
    // Stated as the requirement was: if someone from a different party enters
    // the SAME space as someone already there, they get their own copy of it.
    const realms = makeRealms();
    const a = realms.open(site('site:underworks'), 'party_1');
    const b = realms.open(site('site:underworks'), 'party_2');
    expect(a.id).not.toBe(b.id);
    expect(a.world).not.toBe(b.world);
    expect(realms.all().filter((r) => r.kind === RealmKind.Inner)).toHaveLength(2);
  });

  it('never recycles a realm id', () => {
    // Everything above this file keys on the id. A reused one would attach a
    // new instance to an old socket's expectations, silently.
    const realms = makeRealms();
    const first = realms.open(site('site:underworks'), 'party_1');
    expect(realms.close(first.id)).toBe(true);
    const second = realms.open(site('site:underworks'), 'party_2');
    expect(second.id).not.toBe(first.id);
  });
});

describe('realms do not bleed into each other', () => {
  it('keeps bodies on the same coordinates apart', () => {
    // The failure this design exists to make impossible: before realms, a
    // player on the overworld at (12,7) blocked a player at (12,7) inside an
    // instance from stepping there, because `actorAt` compared bare x/y across
    // every living actor with nothing on a body to say which map it was on.
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');

    const outside = realms.overworld.world.addPlayer('p1', 'Outside');
    const inside = inner.world.addPlayer('p2', 'Inside');

    expect(realms.overworld.world.getActor('p2')).toBeUndefined();
    expect(inner.world.getActor('p1')).toBeUndefined();
    expect(realms.overworld.world.actorAt(inside.x, inside.y)?.id).not.toBe('p2');
    expect(inner.world.actorAt(outside.x, outside.y)?.id).not.toBe('p1');
  });

  it('keeps engagement per realm', () => {
    // The single most important isolation in the file. Engagement is the last
    // clause of `isBlocking`; one number for the process meant one fight armed
    // the barrier for everyone, everywhere.
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');
    inner.world.turn.engagement = 5;
    expect(realms.overworld.world.turn.engagement).toBe(0);
  });

  it('keeps clocks, floors and orbs per realm', () => {
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');

    inner.world.addGroundItem({ x: 5, y: 5 }, 'item_iron_ingot');
    expect(inner.world.groundItems()).toHaveLength(1);
    expect(realms.overworld.world.groundItems()).toHaveLength(0);

    expect(inner.world.turn.clock).not.toBe(realms.overworld.world.turn.clock);
  });

  it('finds which realm holds a body', () => {
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');
    inner.world.addPlayer('p1', 'Someone');
    expect(realms.realmOf('p1')?.id).toBe(inner.id);
    expect(realms.realmOf('nobody')).toBeUndefined();
  });
});

describe('two realms roll different dice', () => {
  it('does not mirror one seed across two instances', () => {
    // THE SUBTLE ONE. `createWorld` hard-codes its three fork labels, so the
    // seed STRING is the only lever distinguishing two worlds. Build both from
    // the same string and they are not independent — they are mirrored, rolling
    // the same to-hit sequence, crits and drops in lockstep, each looking
    // perfectly correct on its own. `seedFor` qualifies by realm id to prevent
    // exactly that.
    const realms = makeRealms();
    const a = realms.open(site('site:underworks'), 'party_1');
    const b = realms.open(site('site:underworks'), 'party_2');

    const drawsA = Array.from({ length: 8 }, () => a.world.rng.int('t', 0, 1_000_000));
    const drawsB = Array.from({ length: 8 }, () => b.world.rng.int('t', 0, 1_000_000));
    expect(drawsA).not.toEqual(drawsB);
  });

  it('is reproducible for the same seed and the same realm', () => {
    // Decorrelated must not mean unpredictable: a restart on the same seed has
    // to reproduce the same world, which is the whole reason seeds are strings
    // rather than clocks.
    const first = makeRealms('fixed').overworld.world.rng.int('t', 0, 1_000_000);
    const second = makeRealms('fixed').overworld.world.rng.int('t', 0, 1_000_000);
    expect(first).toBe(second);
  });

  it('gives two different root seeds two different cities', () => {
    const a = makeRealms('seed-a').overworld.world.rng.int('t', 0, 1_000_000);
    const b = makeRealms('seed-b').overworld.world.rng.int('t', 0, 1_000_000);
    expect(a).not.toBe(b);
  });
});

describe('closing an instance', () => {
  it('refuses while a player is still standing in it', () => {
    // A realm reaped out from under a body leaves that socket rendering a map
    // the server no longer holds, and every later frame about it is silently
    // dropped — which presents as "the game froze", not as a missing realm.
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');
    inner.world.addPlayer('p1', 'Still here');
    expect(realms.close(inner.id)).toBe(false);
    expect(realms.get(inner.id)).toBeDefined();
  });

  it('closes once the last body leaves', () => {
    const realms = makeRealms();
    const inner = realms.open(site('site:underworks'), 'party_1');
    inner.world.addPlayer('p1', 'Leaving');
    expect(realms.empty()).toEqual([]);
    inner.world.removePlayer('p1');
    expect(realms.empty().map((r) => r.id)).toEqual([inner.id]);
    expect(realms.close(inner.id)).toBe(true);
    expect(realms.get(inner.id)).toBeUndefined();
  });

  it('never lists the overworld as empty, however deserted it is', () => {
    const realms = makeRealms();
    expect(realms.empty()).toEqual([]);
  });

  it('answers false for a realm that never existed', () => {
    expect(makeRealms().close('realm:nonsense')).toBe(false);
  });
});
