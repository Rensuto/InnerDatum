import { describe, expect, it } from 'vitest';

import {
  DELVES,
  specFor,
  dangerWord,
  forArea,
  partyHint,
  populateDelve,
} from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import {
  RealmKind,
  SITES,
  STAIRS_DOWN_SITE_ID,
  createRealms,
} from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { SiteShape, makeSiteMap } from '../../src/shared/sitemap.ts';
import { Faction } from '../../src/server/engine/actor.ts';

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

/**
 * Bodies that want to kill you, which is a narrower question than `monstersIn`
 * since townsfolk arrived. A town may hold people; it may not hold hostiles.
 */
function hostilesIn(seed: string, siteId: string): number {
  const def = SITES.get(siteId);
  if (def === undefined) throw new Error(`no site ${siteId}`);
  const realm = realms(seed).open(def, 'party');
  return realm.world
    .allActors()
    .filter((a) => a.kind === ActorKind.Monster && a.faction !== Faction.Townsfolk).length;
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
    /**
     * The rule expressed as data: `populate` is attached only where a spec
     * exists, and `createRealms` THROWS for a Common site that carries one —
     * because a single monster in a town arms engagement for every unrelated
     * person standing in it.
     *
     * ═══ `specFor` AND NOT `DELVES.has`, WHICH IS WHAT THIS ASKED ═══
     * The Redaction's doors are DERIVED from their Alderbrook originals and are
     * therefore absent from `DELVES`, so the raw table now answers "town" for
     * six `Inner` sites. That absence is not a hole in the content — it is the
     * table being asked a question it does not answer any more. `specFor` is
     * the lookup that knows about both maps, and it is the one the gateway's
     * danger grade and the registry's `populate` both use, which is exactly why
     * it is the one this invariant should be stated over.
     */
    for (const [id, def] of SITES) {
      expect(specFor(id) !== undefined, `${def.name}`).toBe(def.kind === RealmKind.Inner);
    }
  });

  it('puts no HOSTILE in a town, which the engine would otherwise punish', () => {
    // Towns hold townsfolk now, so "empty" and "safe" are no longer the same
    // statement — see the matching note in realms.test.ts. What the engine
    // punishes is a HOSTILE in a shared space: it lifts engagement for every
    // party standing there at once.
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Common) continue;
      expect(hostilesIn(`town-${id}`, id), `${def.name} has a hostile in it`).toBe(0);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONLY ON GROUND A PARTY CAN GET TO, AND NEVER ON A STAIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A works is ToME's Roomer now, and a Roomer floor can keep a room its tunnels
 * never opened — upstream only refuses a level whose stairs or vault entrances
 * are cut off (`engine/Zone.lua:1131-1158`), and a ToME player digs into the
 * rest. Nobody here digs, so a body in a sealed room is a floor nobody can
 * clear. Our rule: a candidate must be reachable from the arrival the way the
 * level was certified, eight-way with a shut door passable. And a stair is a
 * `special` cell upstream's generators skip (`engine/generator/actor/Random.lua:114`).
 *
 * Hand-built floors, so each rule is the only thing that decides the outcome.
 */
describe('what a party cannot reach', () => {
  /** A floor of `w` by `h` wall with `open` carved as floor. */
  function floorOf(
    w: number,
    h: number,
    open: (x: number, y: number) => boolean,
  ): AuthoredMap['view'] {
    const tiles: number[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) tiles.push(open(x, y) ? TileCode.FLOOR : TileCode.WALL);
    }
    return { w, h, tiles };
  }

  /** Every cell anything was put on: bodies, ground items, traps and props. */
  function occupied(world: ReturnType<typeof createWorld>): { x: number; y: number }[] {
    return [
      ...world.allActors().filter((a) => a.kind === ActorKind.Monster),
      ...world.groundItems(),
      ...world.traps(),
      ...world.props(),
    ].map(({ x, y }) => ({ x, y }));
  }

  const underworks = (): DelveSpec => {
    const spec = specFor('site:underworks');
    if (spec === undefined) throw new Error('no spec for the Underworks');
    return spec;
  };

  it('puts nothing in a pocket sealed off from the arrival', () => {
    // Two halves, the far one bigger and walled off at x = 20.
    const view = floorOf(40, 20, (x, y) => x > 0 && y > 0 && x < 39 && y < 19 && x !== 20);
    const map: AuthoredMap = { view, spawns: [{ x: 2, y: 2 }], sites: new Map() };
    const world = createWorld('unreachable-pocket', map);
    const placed = populateDelve(world, map, underworks());

    expect(placed, 'precondition: the reachable half holds something').toBeGreaterThan(0);
    for (const at of occupied(world)) {
      expect(
        at.x,
        `something was put in the sealed half at ${String(at.x)},${String(at.y)}`,
      ).toBeLessThan(20);
    }
  });

  it('reaches through a shut door and round a corner, as a body walks', () => {
    // A corridor inside the door clearance, a shut door, then a room entered
    // only on the diagonal: (8,5) to (9,6), with (9,5) and (8,6) solid. Every
    // candidate is behind both.
    const view = floorOf(
      30,
      12,
      (x, y) => (y === 5 && x >= 1 && x <= 8) || (x >= 9 && x <= 20 && y >= 6 && y <= 10),
    );
    view.tiles[5 * 30 + 7] = TileCode.DOOR;
    const map: AuthoredMap = { view, spawns: [{ x: 2, y: 5 }], sites: new Map() };
    const world = createWorld('behind-a-door', map);
    const placed = populateDelve(world, map, underworks());

    expect(placed, 'the room behind the door and the corner got nobody').toBeGreaterThan(0);
    for (const at of occupied(world)) {
      expect(at.x >= 9 && at.y >= 6, `${String(at.x)},${String(at.y)} is not in the room`).toBe(
        true,
      );
    }
  });

  describe('on a floor with several rooms', () => {
    /** Room `r` holds `at`. */
    const inside = (r: NonNullable<AuthoredMap['vaults']>[number], at: { x: number; y: number }) =>
      at.x >= r.at.x && at.y >= r.at.y && at.x < r.at.x + r.w && at.y < r.at.y + r.h;
    const MONEY = { id: 'room:money_vault', at: { x: 14, y: 14 }, turn: 'none', w: 5, h: 5 };
    const DRAWN = { id: 'vault:test', at: { x: 30, y: 12 }, turn: 'none', w: 6, h: 6 };
    const OTHER = { id: 'vault:other', at: { x: 12, y: 28 }, turn: 'none', w: 8, h: 8 };

    function open(seed: string, vaults: AuthoredMap['vaults']) {
      const view = floorOf(40, 40, (x, y) => x > 0 && y > 0 && x < 39 && y < 39);
      const map: AuthoredMap = { view, spawns: [{ x: 2, y: 2 }], sites: new Map(), vaults };
      return { world: createWorld(seed, map), map };
    }

    it('guards a drawn room before a money vault laid ahead of it', () => {
      // A Roomer floor records rooms in placement order, and a money vault is
      // often first. The drawn room is the one somebody composed.
      for (let n = 0; n < 12; n += 1) {
        const { world, map } = open(`guard-drawn-${String(n)}`, [MONEY, DRAWN]);
        populateDelve(world, map, underworks());
        expect(
          world.groundItems().some((item) => inside(DRAWN, item)),
          'no litter in the drawn room',
        ).toBe(true);
        expect(
          world.allActors().some((a) => a.kind === ActorKind.Monster && inside(DRAWN, a)),
          'nobody guarding the drawn room',
        ).toBe(true);
      }
    });

    it('lays no trap in any drawn room, guarded or not', () => {
      // Upstream's trap generator skips every special cell
      // (generator/trap/Random.lua:47), and every cell of every lesser vault is
      // special. Forty traps spread over the floor would find the second room
      // many times over without the rule.
      const spec: DelveSpec = { ...underworks(), traps: [40, 40] };
      let traps = 0;
      for (let n = 0; n < 6; n += 1) {
        const { world, map } = open(`traps-drawn-${String(n)}`, [DRAWN, OTHER]);
        populateDelve(world, map, spec);
        traps += world.traps().length;
        for (const trap of world.traps()) {
          const at = `${String(trap.x)},${String(trap.y)}`;
          expect(inside(DRAWN, trap), `a trap in the guarded room at ${at}`).toBe(false);
          expect(inside(OTHER, trap), `a trap in the other drawn room at ${at}`).toBe(false);
        }
      }
      expect(traps, 'precondition: the floor holds traps').toBeGreaterThan(100);
    });
  });

  it('never puts anything on the stair down', () => {
    // A corridor whose twelve cells past the door clearance are every candidate
    // there is, with the stair in the middle of them. The bodies alone cover
    // half the list, so across thirty floors the stair would be stood on,
    // littered or trapped many times over without the rule.
    const view = floorOf(30, 5, (x, y) => y === 2 && x >= 1 && x <= 21);
    const map: AuthoredMap = {
      view,
      spawns: [{ x: 2, y: 2 }],
      sites: new Map([['15,2', STAIRS_DOWN_SITE_ID]]),
    };
    for (let n = 0; n < 30; n += 1) {
      const world = createWorld(`stair-down-${String(n)}`, map);
      const placed = populateDelve(world, map, underworks());
      expect(placed, 'precondition: the corridor holds something').toBeGreaterThan(0);
      for (const at of occupied(world)) {
        expect(`${String(at.x)},${String(at.y)}`, 'something was put on the stair').not.toBe(
          '15,2',
        );
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GENTLEST ROOM AND THE WORST ONE, ASKED FOR RATHER THAN NAMED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These used to be spelled `site:blackwood_outskirts` and `site:outer_index`,
 * which baked in an assumption that turned out to be the bug: the gradient ran
 * the wrong way down the map, so the site this file called "near" was 131 steps
 * out and the one it called "far" was not the far end of anything.
 *
 * The assertions were about the right PROPERTY the whole time — a real spread
 * between the top and bottom of the table — so they now ASK which rooms those
 * are. That makes them survive a re-key instead of enforcing one, and it leaves
 * the question of which room sits at which door to
 * `test/server/delve-gradient.test.ts`, which measures the actual walk.
 */
const BANDS = ['quiet', 'restless', 'dangerous', 'grim'] as const;

function byDanger(): readonly DelveSpec[] {
  return [...DELVES.values()].sort(
    (a, b) =>
      BANDS.indexOf(dangerWord(a) as (typeof BANDS)[number]) -
      BANDS.indexOf(dangerWord(b) as (typeof BANDS)[number]),
  );
}

/** The room the table considers gentlest. */
function gentlest(): DelveSpec {
  const spec = byDanger()[0];
  if (spec === undefined) throw new Error('DELVES is empty');
  return spec;
}

/** The room the table considers worst. */
function worst(): DelveSpec {
  const all = byDanger();
  const spec = all[all.length - 1];
  if (spec === undefined) throw new Error('DELVES is empty');
  return spec;
}

describe('the map has a gradient now', () => {
  it('makes the far end meaningfully worse than the near end', () => {
    // THE REASON A PLAYER PICKS ONE MARKER OVER ANOTHER. Until there was a
    // gradient, every destination was worth exactly the same as every other
    // one: nothing.
    const easy = gentlest();
    const hard = worst();
    // A SPREAD WIDE ENOUGH TO BE A DECISION. The worst room's FLOOR is above the
    // gentlest room's CEILING, for bodies and for loot alike — so the two are
    // not merely different, they do not overlap, and walking further out is
    // always more of both.
    expect(hard.monsters[0]).toBeGreaterThan(easy.monsters[1]);
    expect(hard.litter[0]).toBeGreaterThan(easy.litter[1]);
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

describe('what the bodies are carrying', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY CORPSE IN EVERY DELVE DROPPED A PLAIN, UNNAMED ITEM. ALL OF THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `populateDelve` called `rollDrop` and put the bare base id on the body.
   * `rollDrop` picks WHICH item; `embellish` — which both of `encounter.ts`'s
   * seeding paths wrap around it — is what rolls quality, applies egos, and
   * turns a drop into a coin pile.
   *
   * So across the eight delves, the only content a party enters on purpose, the
   * measurement was **100% plain, 0 egoed, 0 money**. The 45%/20% ego weights
   * and the whole money column were live, tested, and unreachable from the game.
   * The litter on the floor had `rollLoot` all along, so a delve's FLOOR could
   * produce a named item while nothing that died in it ever could.
   *
   * The rule this asserts is not a percentage — the weights are `loot.ts`'s to
   * own and pinning them here would make two files argue about one table. It is
   * that the delve path REACHES the generator at all.
   */
  it('rolls egos and money, not bare base ids', () => {
    const delves = [...SITES.values()].filter((site) => site.kind === RealmKind.Inner);
    let carried = 0;
    let embellished = 0;

    for (const site of delves) {
      for (let run = 0; run < 4; run += 1) {
        const realms = createRealms({
          seed: `delve-loot:${site.id}:${String(run)}`,
          engineFor: (world) => createTurnEngine({ world }),
        });
        const realm = realms.open(site, `party-${String(run)}`);
        for (const actor of realm.world.allActors()) {
          if (actor.kind !== ActorKind.Monster) continue;
          for (const id of actor.carried ?? []) {
            carried += 1;
            // ANY MARK OF THE GENERATOR. `~` is the ego separator and `@` is the
            // money quantity — both from content/resolve.ts's id grammar. A bare
            // `item_foo` carries neither, which is exactly what shipped.
            if (id.includes('~') || id.includes('@')) embellished += 1;
          }
        }
      }
    }

    // A roster carrying nothing at all would pass a "some are embellished"
    // check vacuously, so the sample size is asserted first.
    expect(carried).toBeGreaterThan(20);
    // Not a rate — see above. Zero is the bug; the weights live elsewhere.
    expect(embellished).toBeGreaterThan(0);
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
    const rank = [...BANDS] as string[];
    expect(rank.indexOf(dangerWord(worst()))).toBeGreaterThan(rank.indexOf(dangerWord(gentlest())));
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
    // party for the gentlest room in the game is something a solo player
    // disproves in four minutes.
    expect(partyHint(gentlest())).toBeNull();
    expect(partyHint(worst())).toBe('bring a party');
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

describe('bands for the floor they are spread over', () => {
  /**
   * EVERY BAND WAS MEASURED ON A 34 BY 30 SITE, and sites are upstream's 50 by
   * 50 now (`data/zones/ruins-kor-pul/zone.lua:30`). Litter and traps grow
   * with the floor, or a bigger delve is a barer one; the monsters stay the
   * fight the delve was tuned to be.
   */
  const built = makeSiteMap('bands-for-the-floor', SiteShape.Works);
  const tuned = { ...built, view: { ...built.view, w: 34, h: 30 } };

  it('leaves a band alone on the size it was tuned on and grows it with the area', () => {
    const underworks = specFor('site:underworks');
    if (underworks === undefined) throw new Error('no spec for the Underworks');
    const spec: DelveSpec = { ...underworks, monsters: [4, 6], litter: [2, 3], traps: [1, 2] };
    expect(forArea(spec, tuned)).toEqual(spec);

    expect(built.view.w * built.view.h, 'precondition: an upstream-sized site').toBe(2500);
    const wide = forArea(spec, built);
    expect(wide.monsters, 'the fight a delve was tuned to be').toEqual(spec.monsters);
    expect(wide.litter).toEqual([5, 7]);
    expect(wide.traps).toEqual([2, 5]);
    expect(wide.roster).toBe(spec.roster);
    expect(wide.levelRange).toEqual(spec.levelRange);

    const { traps: _none, ...trapless } = spec;
    expect('traps' in forArea(trapless, built), 'a delve with no traps was given some').toBe(false);
  });

  it('is what a delve is stocked with, from either map', () => {
    for (const siteId of ['site:underworks', 'site:redaction:watchers_altar']) {
      const spec = specFor(siteId);
      if (spec === undefined) throw new Error(`no spec for ${siteId}`);
      const wide = forArea(spec, built);
      const realm = realms(`stocked-${siteId}`).open(site(siteId), 'party');

      // THE LITTER, plus the one lore note a floor may carry.
      const ground = realm.world.groundItems().length;
      expect(ground, `${siteId} is littered for the size it was tuned on`).toBeGreaterThan(
        spec.litter[1] + 1,
      );
      expect(ground, siteId).toBeGreaterThanOrEqual(wide.litter[0]);
      expect(ground, siteId).toBeLessThanOrEqual(wide.litter[1] + 1);

      const monsters = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster).length;
      expect(monsters, `${siteId} is not the fight it was tuned to be`).toBeLessThanOrEqual(
        spec.monsters[1],
      );
      expect(monsters, siteId).toBeGreaterThanOrEqual(1);
    }
  });
});
