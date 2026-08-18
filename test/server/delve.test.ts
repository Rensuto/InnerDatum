import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord, partyHint } from '../../src/server/content/delve.ts';
import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { ActorKind } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE EIGHT DELVES HAVE SOMETHING IN THEM. THEY DID NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every one of them generated EMPTY: a player was told "Cut for ore, abandoned
 * for a reason the paperwork does not give", walked thirty tiles across a moor,
 * and found a room with nothing in it. Eight times. No writing on a threshold
 * survives that, and nothing in the test suite noticed — because "is there
 * anything in there" was not a question anything asked.
 *
 * It asks now.
 */

function realms(seed: string): ReturnType<typeof createRealms> {
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
}

/** A site by id, or a throw. Keeps every call site free of `?? fallback`. */
function site(id: string): typeof SITES extends ReadonlyMap<string, infer T> ? T : never {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no site ${id}`);
  return def;
}

function monstersIn(seed: string, siteId: string): number {
  const def = SITES.get(siteId);
  if (def === undefined) throw new Error(`no site ${siteId}`);
  const realm = realms(seed).open(def, 'party');
  return realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
}

describe('a delve is not an empty room', () => {
  it('puts somebody in EVERY inner site', () => {
    // THE REGRESSION, stated as the thing it was. If this ever reads zero
    // again, a named destination on the map has quietly become a door onto
    // nothing.
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Inner) continue;
      expect(monstersIn(`delve-${id}`, id), `${def.name} is empty`).toBeGreaterThan(0);
    }
  });

  it('has a spec for every inner site and for no town', () => {
    // The rule expressed as data: `populate` is attached only where `DELVES`
    // has an entry, and `createRealms` THROWS for a Common site that carries
    // one — because a single monster in a town arms engagement for every
    // unrelated person standing in it.
    for (const [id, def] of SITES) {
      expect(DELVES.has(id), `${def.name}`).toBe(def.kind === RealmKind.Inner);
    }
  });

  it('leaves every town empty, which the engine would otherwise punish', () => {
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Common) continue;
      expect(monstersIn(`town-${id}`, id), `${def.name} has a monster in it`).toBe(0);
    }
  });
});

describe('where they stand', () => {
  it('never puts anybody within reach of the door', () => {
    // `seedAmbush` learned this the expensive way: being hit before the map has
    // finished drawing is not tension, it is a bug report. A delve is somewhere
    // you walked into on purpose, so the first screen is yours to read.
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Inner) continue;
      for (let run = 0; run < 4; run += 1) {
        const realm = realms(`door-${id}-${run}`).open(def, `p${run}`);
        const body = realm.world.addPlayer('probe', 'P');
        const foes = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
        for (const foe of foes) {
          const d = Math.max(Math.abs(foe.x - body.x), Math.abs(foe.y - body.y));
          expect(d, `${def.name}: a ${foe.name} stands ${d} from the door`).toBeGreaterThan(1);
        }
      }
    }
  });

  it('does not stack everybody on one tile', () => {
    // The placer walks a candidate list with a stride. An independent draw per
    // monster clusters, and a cluster is one fight rather than a room.
    const realm = realms('spread').open(site('site:outer_index'), 'p');
    const foes = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    const cells = new Set(foes.map((f) => `${String(f.x)},${String(f.y)}`));
    expect(cells.size).toBe(foes.length);
  });
});

describe('the map has a gradient now', () => {
  it('makes the far end meaningfully worse than the near end', () => {
    // THE REASON A PLAYER PICKS ONE MARKER OVER ANOTHER. Until there was a
    // gradient, every destination was worth exactly the same as every other
    // one: nothing.
    const blackwood = DELVES.get('site:blackwood_outskirts');
    const outer = DELVES.get('site:outer_index');
    if (blackwood === undefined || outer === undefined) throw new Error('unreachable');
    expect(outer.monsters[0]).toBeGreaterThan(blackwood.monsters[1]);
    expect(outer.litter[0]).toBeGreaterThan(blackwood.litter[1]);
  });

  it('is reproducible from the realm that opened it', () => {
    // A party re-entering before the linger expires finds the room it left —
    // which is only true if population is a pure function of the realm's seed.
    const a = realms('same').open(site('site:underworks'), 'p');
    const b = realms('same').open(site('site:underworks'), 'p');
    const at = (r: typeof a): string =>
      r.world
        .allActors()
        .filter((x) => x.kind === ActorKind.Monster)
        .map((m) => `${m.name}@${String(m.x)},${String(m.y)}`)
        .join('|');
    expect(at(a)).toBe(at(b));
    expect(at(a)).not.toBe('');
  });
});

describe('what is lying about', () => {
  it('leaves loot on the floor, so a delve rewards exploring and not only clearing', () => {
    let withLitter = 0;
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Inner) continue;
      const realm = realms(`litter-${id}`).open(def, 'p');
      if (realm.world.groundItems().length > 0) withLitter += 1;
    }
    expect(withLitter).toBeGreaterThan(4);
  });

  it('gives most residents something to drop', () => {
    const realm = realms('drops').open(site('site:outer_index'), 'p');
    const foes = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    const carrying = foes.filter((f) => (f.carried ?? []).length > 0).length;
    expect(carrying).toBeGreaterThan(0);
  });
});

describe('how bad it is in there, in one word', () => {
  it('never calls a room full of wraiths and elites quiet', () => {
    // THE BUG THE FIRST VERSION HAD. A flat "has anything nastier than a husk"
    // bonus called the Watcher's Altar — three to four WRAITHS AND ELITES —
    // "quiet", which is worse than saying nothing: a hint that lies is a hint a
    // player stops reading. What is in a room is weighted apart from how much
    // of it there is.
    const altar = DELVES.get('site:watchers_altar');
    if (altar === undefined) throw new Error('unreachable');
    expect(dangerWord(altar)).not.toBe('quiet');
  });

  it('is derived from the spec, so it cannot disagree with the population', () => {
    // A `danger:` field authored beside the band would be a second opinion
    // about the same room, free to drift the day somebody retunes one and not
    // the other — silently, because nothing downstream compares them.
    const near = DELVES.get('site:blackwood_outskirts');
    const far = DELVES.get('site:outer_index');
    if (near === undefined || far === undefined) throw new Error('unreachable');
    const rank = ['quiet', 'restless', 'dangerous', 'grim'];
    expect(rank.indexOf(dangerWord(far))).toBeGreaterThan(rank.indexOf(dangerWord(near)));
  });

  it('uses more than one word across the eight, or it is not telling anybody anything', () => {
    // A gradient every marker reports identically is not a gradient.
    const words = new Set([...DELVES.values()].map(dangerWord));
    expect(words.size).toBeGreaterThanOrEqual(3);
  });
});

describe('whether to bring somebody', () => {
  it('suggests a party only where a solo player would actually struggle', () => {
    // ADVICE THAT IS WRONG ONCE IS ADVICE NOBODY READS AGAIN. Suggesting a
    // party for Blackwood is something a solo player disproves in four minutes.
    const near = DELVES.get('site:blackwood_outskirts');
    const far = DELVES.get('site:outer_index');
    if (near === undefined || far === undefined) throw new Error('unreachable');
    expect(partyHint(near)).toBeNull();
    expect(partyHint(far)).toBe('bring a party');
  });

  it('says nothing at all for the quiet rooms, rather than saying "go alone"', () => {
    // A hint on every room is furniture. The absence IS the signal for the ones
    // a player can walk into without thinking about it.
    const hinted = [...DELVES.values()].filter((spec) => partyHint(spec) !== null).length;
    expect(hinted).toBeGreaterThan(0);
    expect(hinted).toBeLessThan(DELVES.size);
  });

  it('tracks the danger word rather than being a second opinion about it', () => {
    // Derived, like the word itself. Two hand-authored fields describing the
    // same room drift the day somebody retunes one of them.
    for (const spec of DELVES.values()) {
      const word = dangerWord(spec);
      const hint = partyHint(spec);
      if (word === 'grim' || word === 'dangerous') expect(hint).not.toBeNull();
      else expect(hint).toBeNull();
    }
  });
});
