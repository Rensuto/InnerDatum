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
import {
  ENCOUNTER_SITE,
  INSTANCE_LINGER_MS,
  OVERWORLD_ID,
  RealmKind,
  SITES,
  createRealms,
} from '../../src/server/world/realms.ts';
import { makeOverworld, makeTestMap } from '../../src/shared/level.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { Realms, SiteDef } from '../../src/server/world/realms.ts';

/** The towns, derived rather than restated so the table stays the one source. */
/** Every site id the city actually has a cell for. */
const OVERWORLD_SITE_IDS = [...makeOverworld().sites.values()];

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
    // THE REGION, NOT THE CITY. They shared the name until a first-session
    // walkthrough showed a player being told they were in "Alderbrook" while
    // standing at the gate of a different Alderbrook they could walk into.
    expect(realms.overworld.name).toBe('The Alderbrook Moor');
    expect(realms.overworld.name).not.toBe(SITES.get('site:alderbrook')?.name);
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

  it('holds the region, not the test level', () => {
    const realms = makeRealms();
    expect(realms.overworld.world.level.w).toBe(170);
    expect(realms.overworld.world.level.h).toBe(100);
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
  it('gives two unrelated parties the SAME city', () => {
    // The rule: a common space has no combat, so there is nothing to
    // coordinate, so there is no reason to keep anyone out. This is the half
    // that makes the world feel populated rather than a set of private rooms.
    const realms = makeRealms();
    const mine = realms.open(site('site:alderbrook'), 'party_1');
    const theirs = realms.open(site('site:alderbrook'), 'party_2');
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
              marker: 'town',
              map: makeTestMap,
              lingerMs: 0,
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
    const town = realms.open(site('site:alderbrook'), 'party_1');
    expect(realms.empty()).toEqual([]);
    expect(realms.close(town.id)).toBe(false);
    expect(realms.get(town.id)).toBeDefined();
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

describe('the roaming encounter', () => {
  it('is instanced and populated, unlike anywhere shared', () => {
    // ToME's wilderness rule: the world map has no monsters on it, and crossing
    // it is dangerous because a step PULLS YOU INTO a zone. The encounter is
    // therefore an ordinary Inner site that happens to be opened by a roll
    // rather than by a doorway.
    const realms = makeRealms();
    expect(ENCOUNTER_SITE.kind).toBe(RealmKind.Inner);
    const breach = realms.open(ENCOUNTER_SITE, 'party_1');
    const monsters = breach.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(monsters.length).toBeGreaterThan(0);
  });

  it('gives two unrelated parties two separate ambushes', () => {
    // Two people ambushed on opposite sides of the city are in two different
    // fights, which is the same rule every delve obeys — and the reason the
    // encounter reuses `SiteDef` rather than inventing a second crossing path.
    const realms = makeRealms();
    const mine = realms.open(ENCOUNTER_SITE, 'party_1');
    const theirs = realms.open(ENCOUNTER_SITE, 'party_2');
    expect(mine.id).not.toBe(theirs.id);
    expect(mine.world).not.toBe(theirs.world);
  });

  it('leaves the overworld with no hostiles and no engagement', () => {
    // THE INVARIANT THE WHOLE DESIGN RESTS ON, restated after an ambush exists.
    // A hostile standing on Alderbrook would lift engagement above zero, and
    // `isBlocking` would then return true for every player in the city, related
    // or not — six friends walking to three districts would start waiting on
    // each other with a Bell running. Encounters are what let the overworld be
    // dangerous AND shared; they must never put anything ON it.
    const realms = makeRealms();
    realms.open(ENCOUNTER_SITE, 'party_1');
    realms.open(ENCOUNTER_SITE, 'party_2');
    const onTheStreet = realms.overworld.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster);
    expect(onTheStreet).toEqual([]);
    expect(realms.overworld.world.turn.engagement).toBe(0);
  });

  it('is not an authored map cell', () => {
    // Every entry in SITES is a door somebody drew on the city. The encounter is
    // a roll, so it is deliberately absent — and a test says so, because adding
    // it to that table would put a permanent ambush tile in Alderbrook.
    expect(SITES.has(ENCOUNTER_SITE.id)).toBe(false);
    expect([...OVERWORLD_SITE_IDS]).not.toContain(ENCOUNTER_SITE.id);
  });
});

describe('what happens to an instance when everyone leaves', () => {
  it('gives a delve a linger and an ambush none', () => {
    // The distinction in one assertion: a delve is a place you can go back to,
    // an ambush is an event you can flee. The gateway owns the wall clock; this
    // is the policy it reads.
    expect(ENCOUNTER_SITE.lingerMs).toBe(0);
    for (const s of SITES.values()) expect(s.lingerMs).toBe(INSTANCE_LINGER_MS);
  });

  it('will not hand a fled breach back to the party that ran', () => {
    // FLEEING HAS TO COST SOMETHING. A breach left open would let a party step
    // out, heal, and step back into a fight frozen exactly as they left it —
    // making "run away" and "pause the fight" the same verb. Sealing is what
    // makes the second ambush a NEW fight.
    const realms = makeRealms();
    const first = realms.open(ENCOUNTER_SITE, 'party_1');
    first.sealed = true;
    const second = realms.open(ENCOUNTER_SITE, 'party_1');
    expect(second.id).not.toBe(first.id);
    expect(second.sealed).toBe(false);
  });

  it('still hands a delve back to the party that left it', () => {
    // The mirror of the test above, and the reason sealing is per-realm rather
    // than a rule about Inner realms in general.
    const realms = makeRealms();
    const first = realms.open(site('site:underworks'), 'party_1');
    expect(realms.open(site('site:underworks'), 'party_1').id).toBe(first.id);
  });

  it('reports an emptied instance as reapable, and a town never', () => {
    const realms = makeRealms();
    const delve = realms.open(site('site:underworks'), 'party_1');
    const town = realms.open(site('site:alderbrook'), 'party_1');
    delve.world.addPlayer('p1', 'Someone');
    town.world.addPlayer('p2', 'Someone else');
    expect(realms.empty()).toEqual([]);

    delve.world.removePlayer('p1');
    town.world.removePlayer('p2');
    // The town is deserted and still not a candidate: it is a place, not a
    // session, and somebody walking back for a dropped coat must find it.
    expect(realms.empty().map((r) => r.id)).toEqual([delve.id]);
  });
});

describe('the threshold, and why the exit still has to arm', () => {
  it('is a single tile now that floors are generated', () => {
    // THE ORIGINAL BUG IS GONE, AND THE GUARD IS NOT. `leaveRealm` treats a
    // site's spawn tiles as its door, and the M1 map spawned on a 3x2 block of
    // SIX ADJACENT tiles — so the first step after arriving landed on another
    // one and ejected you instantly. Reported from play as "encounters start
    // but there are no enemies" and "I can click out and carry on walking".
    //
    // Generated floors have one threshold, so that particular collision cannot
    // happen any more. `Session.exitArmed` stays because the REQUIREMENT it
    // encodes never depended on the cluster: arriving on the door must not be
    // the same act as leaving through it, whatever the door's shape. Deleting
    // it would work today and break the first time a floor is authored with a
    // wider entrance.
    const realms = makeRealms();
    const delve = realms.open(site('site:underworks'), 'party_1');
    expect(delve.spawns).toHaveLength(1);
  });

  it('puts an arriving body onto that threshold', () => {
    // The half that makes the arming necessary rather than defensive: if
    // arrival did NOT land on the door, nothing would need to distinguish the
    // two acts.
    const realms = makeRealms();
    const delve = realms.open(site('site:underworks'), 'party_1');
    const body = delve.world.addPlayer('p1', 'Arrived');
    expect(delve.spawns.some((t) => t.x === body.x && t.y === body.y)).toBe(true);
  });

  it('always leaves the threshold walkable, whatever the generator did', () => {
    // A door stamped into a wall is a floor nobody can leave. Every shape
    // carves its spawn last for this reason (shared/sitemap.ts).
    const realms = makeRealms();
    for (const s of SITES.values()) {
      const realm = realms.open(s, `party_${s.id}`);
      const door = realm.spawns[0];
      expect(door, `${s.id} has no threshold`).toBeDefined();
      expect(
        realm.world.getActor('probe') ?? realm.world.addPlayer('probe', 'Probe'),
      ).toBeDefined();
      realm.world.removePlayer('probe');
    }
  });
});

describe('every site can be drawn on the overworld', () => {
  it('gives every site a marker family the client knows', () => {
    // Sites are drawn from `SiteView.marker`, and the renderer falls back to
    // `gate` for anything it does not recognise. That fallback is a safety net
    // for a newer server, not a licence for this table to invent families.
    const known = new Set([
      'village',
      'town',
      'city',
      'mine',
      'ruin',
      'gate',
      'stair',
      'altar',
      'archive',
      'breach',
      'office',
    ]);
    for (const s of SITES.values()) {
      expect(known.has(s.marker), `${s.id} has marker '${s.marker}'`).toBe(true);
    }
    expect(known.has(ENCOUNTER_SITE.marker)).toBe(true);
  });

  it('sizes the settlements, because that is what the tiers are for', () => {
    // The map has to say which places are safe AND how big they are before you
    // walk into them — that is most of what a world map is for. The three
    // markers were measured on delivery at 294 / 430 / 571 px of ink, so the
    // tier is legible by silhouette alone; this pins that the DATA uses it.
    const size = new Map([...SITES.values()].map((s) => [s.id, s.marker]));
    expect(size.get('site:alderbrook')).toBe('city');
    expect(size.get('site:wayfarers_camp')).toBe('village');
    for (const s of SITES.values()) {
      if (s.kind !== RealmKind.Common) continue;
      expect(['village', 'town', 'city'], `${s.id} is not a size tier`).toContain(s.marker);
    }
  });
});

describe('an ambush puts the fight where you are standing', () => {
  it('places every ambusher on screen and none of them adjacent', () => {
    // THE BUG THIS PREVENTS, reported from play twice as "encounters start but
    // there are no enemies". `seedTestEncounter` places monsters at authored
    // coordinates chosen for a floor you EXPLORE — far from the spawn, so
    // nothing hunts you the instant you arrive. Reused for an AMBUSH it drops
    // the player in the map's corner at (3,2) with the nearest monster at
    // (22,6): nineteen tiles, and the viewport in a Discord iframe is about
    // twenty tiles wide. The map changed and the screen showed an empty room.
    //
    // The first fix was a ring of fixed radius and even angles, which does not
    // survive a corner: most of the ring was wall, every placement settled to
    // the nearest free tile, and the elite arrived ADJACENT. So both bounds are
    // asserted, because fixing one broke the other.
    const realms = makeRealms();
    const breach = realms.open(ENCOUNTER_SITE, 'party_1');
    const arrival = breach.spawns[0];
    expect(arrival).toBeDefined();

    const monsters = breach.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(monsters.length).toBeGreaterThan(0);

    for (const m of monsters) {
      const d = Math.max(Math.abs(m.x - (arrival?.x ?? 0)), Math.abs(m.y - (arrival?.y ?? 0)));
      // Not adjacent: being hit before the map has finished drawing is not
      // tension. Chebyshev, because that is the metric movement uses.
      expect(d, `${m.id} is ${d} tiles away — too close`).toBeGreaterThanOrEqual(4);
      // And on screen at the smallest viewport this game ships.
      expect(d, `${m.id} is ${d} tiles away — off screen`).toBeLessThanOrEqual(8);
    }
  });

  it('does not stack two ambushers on one tile', () => {
    const realms = makeRealms();
    const breach = realms.open(ENCOUNTER_SITE, 'party_2');
    const cells = breach.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster)
      .map((a) => `${a.x},${a.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe('a town is a place you learn; a delve is not', () => {
  const layout = (r: { world: { level: { tiles: readonly number[] } } }): string =>
    r.world.level.tiles.join(',');

  it('gives a town the same streets on every server start', () => {
    // STATIC BY SEED. A Common realm's map is built from an id derived from the
    // SITE, so Threadneedle Row is the same Threadneedle Row tonight as it was
    // last night — which is the whole difference between a place and a floor.
    expect(layout(makeRealms('seed-a').open(site('site:threadneedle_row'), 'p1'))).toBe(
      layout(makeRealms('seed-b').open(site('site:threadneedle_row'), 'p1')),
    );
  });

  it('gives two unrelated parties the SAME town', () => {
    const realms = makeRealms();
    expect(layout(realms.open(site('site:ashwick_row'), 'p1'))).toBe(
      layout(realms.open(site('site:ashwick_row'), 'p2')),
    );
  });

  it('gives two parties DIFFERENT ground in the same delve', () => {
    // Stated as the requirement was: solo players entering the same area each
    // get their own randomised instance of it.
    const realms = makeRealms();
    const mine = realms.open(site('site:underworks'), 'party_1');
    const theirs = realms.open(site('site:underworks'), 'party_2');
    expect(mine.id).not.toBe(theirs.id);
    expect(layout(mine)).not.toBe(layout(theirs));
  });

  it('re-randomises a delve once the linger has reaped it', () => {
    // THE FIVE-MINUTE RULE'S OTHER HALF. While the instance lives, coming back
    // finds the floor you left — that is what the linger is for. Once it is
    // reaped, the next party through the door gets somewhere new, because the
    // realm id carries a monotonic instance number and the map is seeded from
    // it.
    const realms = makeRealms();
    const first = realms.open(site('site:hollow_mine'), 'party_1');
    const before = layout(first);

    // Still open: the same floor comes back.
    expect(layout(realms.open(site('site:hollow_mine'), 'party_1'))).toBe(before);

    expect(realms.close(first.id)).toBe(true);
    const second = realms.open(site('site:hollow_mine'), 'party_1');
    expect(second.id).not.toBe(first.id);
    expect(layout(second)).not.toBe(before);
  });
});
