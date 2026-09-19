// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  BOSS_LEVELS_ABOVE_ROOM,
  DELVES,
  NB_NPC_SCALE,
  actorAdjustLevel,
  delveHeadroom,
  delveLevel,
  floorsOf,
  nbNpcFor,
  populateDelve,
  specFor,
} from '../../src/server/content/delve.ts';
import { computeRarities, pickEntity, rarityShare } from '../../src/server/content/rarity.ts';
import {
  INDEX_CAIRN,
  INDEX_HUSK,
  INDEX_HUSK_ELITE,
  INDEX_WRAITH,
} from '../../src/server/content/monsters.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import { RANK_VALUE, rankLevelAdjust } from '../../src/shared/leveling.ts';
import { ActorKind, ActorRank, TileCode } from '../../src/shared/protocol.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createRng } from '../../src/shared/rng.ts';
import { SITES, RealmKind, createRealms, floorsOfSite } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      THE MONSTER PIPELINE, PORTED — HOW MANY, WHICH ONES, AT WHAT LEVEL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ruled by the author: *"the monster scaling should work the same as in tales
 * of maj eyal since we want to reuse 15 years of tuning."* So each of these is
 * about a rule that came from upstream, and each is written to fail when that
 * rule is broken rather than when a number moves:
 *
 *   HOW MANY     `nb_npc` per zone and per level, one body per count
 *                (`engine/generator/actor/Random.lua:126`), through `nbNpcFor`.
 *   WHICH ONES   `computeRarities` + `pickEntity` (`engine/Zone.lua:205-262`,
 *                `:318-330`) against the floor's own level, so the roster
 *                changes as you descend.
 *   WHAT LEVEL   `actor_adjust_level` — `base_level + getRankLevelAdjust() +
 *                level.level - 1 + rng.range(-1, 2)`.
 *
 * DRIVEN, NOT FIXTURED, wherever it can be: the floors below are opened through
 * `createRealms` with the real generator, the real placer and the real seeds.
 */

/**
 * A bare open floor, so nothing about a generated map is in the way.
 *
 * ═══ `size` IS NOT COSMETIC AND LEAVING IT DEFAULT COST A CASE ═══
 * The default is `makeTestMap`'s 30-wide fixture, about 750 cells. Every DELVE
 * is built at its upstream zone's own size — Blackwood Outskirts is 65 x 40,
 * 2600 cells — so a count spread over the fixture sits at three and a half
 * times the density it has in the game. That is harmless for a case that counts
 * bodies and fatal for one that measures how CLOSE they stand: see the OnSpots
 * case, whose statistic saturated at 85% against 83% the moment the counts came
 * off `NB_NPC_SCALE = 0.4`, because on a floor that small nearly every body is
 * within five tiles of two others however it was placed. The rule had not
 * changed; the fixture had never been the floor.
 */
function openFloor(
  seed: string,
  size?: { readonly w: number; readonly h: number },
): { world: ReturnType<typeof createWorld>; map: AuthoredMap } {
  const world =
    size === undefined
      ? createWorld(seed)
      : createWorld(seed, {
          view: { w: size.w, h: size.h, tiles: Array.from({ length: size.w * size.h }, () => 0) },
          spawns: [{ x: 4, y: 4 }],
          sites: new Map<string, string>(),
        });
  world.level.tiles.fill(TileCode.FLOOR);
  const map: AuthoredMap = {
    view: world.level,
    spawns: [{ x: 4, y: 4 }],
    sites: new Map<string, string>(),
  };
  return { world, map };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR BLACKWOOD IS REALLY GENERATED AT — 65 x 40, AND IT WAS 51 x 51.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/sitemap.ts` builds every site at its zone's own `width`/`height`, and
 * `trollmire/zone.lua` is 65 by 40. The square got the CELL COUNT right (2601
 * against 2600) and the SHAPE wrong, which does not matter for a case that
 * counts bodies and does matter for the OnSpots case below — that is a statistic
 * about DISTANCE, and a square is not the rectangle the placer runs on.
 *
 * The comment here used to say 51 was "its zone's own width/height, measured
 * through `createRealms`". It was not measured; it was the square root of a
 * measured area. Driven through `realms.open` the answer is 65 x 40, 1730
 * walkable — which is the whole lesson this fixture already carries in its own
 * words two paragraphs up: *"the fixture had never been the floor."*
 */
const BLACKWOOD_FLOOR = { w: 65, h: 40 } as const;

/**
 * THE FLOOR'S CELL COUNT, FOR THE ONE ZONE THAT READS IT — `nbNpcPerArea`,
 * `infinite-dungeon/zone.lua:255-256`. Every other spec ignores whatever is
 * passed, which is why the caller only pays for this where the field exists.
 */
function areaOf(siteId: string, floor: number): number {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  const seed = `area:${siteId}:${String(floor)}`;
  const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
  const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, floor);
  return realm.world.level.w * realm.world.level.h;
}

const bodiesOf = (world: ReturnType<typeof createWorld>) =>
  world.allActors().filter((a) => a.kind === ActorKind.Monster);

describe('how many — `nb_npc`, per zone and per level', () => {
  it('places the band and nothing else, for a lone party', () => {
    /**
     * `engine/generator/actor/Random.lua:126` is
     * `for i = current, rng.range(nb_npc[1], nb_npc[2]) do generateOne() end` —
     * ONE BODY PER COUNT. No area term, no headcount term, no floor of one.
     * `delveHeadroom(1)` is 1.0, so a lone party meets exactly the band.
     */
    for (const [id, spec] of DELVES) {
      for (let n = 0; n < 6; n += 1) {
        const { world, map } = openFloor(`nbnpc-${id}-${String(n)}`);
        // THE FIXTURE'S OWN AREA, because one zone reads it (`nbNpcPerArea`).
        const band = nbNpcFor(spec, 1, map.view.w * map.view.h);
        const placed = populateDelve(world, map, spec, { level: 1, size: 1 });
        expect(placed, `${id} seed ${String(n)}`).toBeGreaterThanOrEqual(band[0]);
        expect(placed, `${id} seed ${String(n)}`).toBeLessThanOrEqual(band[1]);
      }
    }
  });

  it('reads the zone’s per-level override where the zone carries one', () => {
    /**
     * `engine/Zone.lua:833-843` deep-merges `levels[n]` over the zone's table.
     * The Undermost is the escape from Reknor and its last level is
     * `nb_npc = {0, 0}` (`reknor-escape/zone.lua:79`) because that level is a
     * static map with its bodies drawn on it.
     *
     * ═══ AND A ZERO BAND MUST PLACE NOBODY ═══
     * `populateDelve` used to floor the count at one, so the one floor in the
     * game upstream states as empty of rolled bodies had a body on it anyway.
     */
    const spec = specFor('site:undermost');
    if (spec === undefined) throw new Error('no spec for the Undermost');
    expect(nbNpcFor(spec, floorsOf(spec))).toEqual([0, 0]);
    expect(nbNpcFor(spec, 1)[1], 'the first floor is not empty').toBeGreaterThan(0);

    for (let n = 0; n < 6; n += 1) {
      const { world, map } = openFloor(`undermost-last-${String(n)}`);
      expect(populateDelve(world, map, spec, { level: 1, size: 1 }, floorsOf(spec))).toBe(0);
      expect(bodiesOf(world)).toHaveLength(0);
    }
  });

  it('scales the one zone upstream scales, by ITS area and nobody else`s', () => {
    /**
     * `infinite-dungeon/zone.lua:255-256`:
     * `enemy_count = layout.enemy_count or ceil(vx*vy*34/4900)` then
     * `nb_npc = {enemy_count-5, enemy_count+5}`. The "building" layout Gearford
     * Ward is built as overrides the numerator to 60 (`:161`).
     *
     * EVERY OTHER DELVE IGNORES AREA. The previous attempt at this scaled every
     * band by floor area and made nearly every delve unclearable; upstream does
     * it in exactly one zone, the one whose floor size is itself rolled per
     * level.
     */
    const gearford = specFor('site:gearford_ward');
    const underworks = specFor('site:underworks');
    if (gearford === undefined || underworks === undefined) throw new Error('missing spec');

    const small = nbNpcFor(gearford, 1, 40 * 40);
    const large = nbNpcFor(gearford, 1, 70 * 70);
    expect(large[1], 'Gearford`s band did not grow with its floor').toBeGreaterThan(small[1]);
    expect(large[1] - large[0], 'the band is upstream`s +/-5, scaled once').toBe(
      small[1] - small[0],
    );
    // ceil(70*70*60/4900) = 60, band {55, 65}, at the one factor that is ours.
    expect(large).toEqual([Math.round(55 * NB_NPC_SCALE), Math.round(65 * NB_NPC_SCALE)]);

    expect(nbNpcFor(underworks, 1, 70 * 70), 'a flat-band zone grew with the floor').toEqual(
      nbNpcFor(underworks, 1, 20 * 20),
    );
  });

  it('grows with the party and never with the level', () => {
    /**
     * `delveHeadroom` is OURS — upstream has no co-op — and it is size only.
     * The room's identity is `delveLevel`; who walks in decides how much of it
     * there is. Both halves are asserted because both have been got wrong here.
     */
    const spec = specFor('site:underworks');
    if (spec === undefined) throw new Error('no spec');
    const count = (party: { level: number; size: number }, seed: string): number => {
      const { world, map } = openFloor(seed);
      return populateDelve(world, map, spec, party);
    };
    const alone = count({ level: 1, size: 1 }, 'headroom-a');
    const three = count({ level: 1, size: 3 }, 'headroom-a');
    const veteran = count({ level: 20, size: 1 }, 'headroom-a');
    expect(three / alone).toBeCloseTo(delveHeadroom({ level: 1, size: 3 }), 1);
    expect(veteran, 'the room grew for a levelled party').toBe(alone);
  });
});

describe('which ones — the rarity draw, and it changes with depth', () => {
  /** The delve roster as `computeRarities` sees it. */
  const candidates = (roster: readonly MonsterTemplate[]) =>
    roster.filter(
      (t): t is MonsterTemplate & { rarity: number; levelRange: readonly [number, number] } =>
        t.rarity !== undefined && t.levelRange !== undefined,
    );

  it('weights a candidate by its own `rarity`, floor(10000 / rarity)', () => {
    // `engine/Zone.lua:217-221`. In range, the weight is the numerator over the
    // rarity and nothing else — so a rarity-5 body is a fifth of a rarity-1 one.
    const list = computeRarities(candidates([INDEX_HUSK, INDEX_WRAITH, INDEX_CAIRN]), 1);
    expect(list.entries.map((e) => e.genprob)).toEqual([10000, 20000, 30000]);
    for (const { percent } of rarityShare(list)) expect(percent).toBeCloseTo(100 / 3, 6);
  });

  it('fades a body OUT above its ceiling and IN below its floor', () => {
    /**
     * THE HALF THAT MAKES A FLOOR ESCALATE. The husk is the giant brown ant,
     * `level_range = {1, 15}` (`ant.lua:56`); the Overwritten Husk is the
     * ghoulking, `{15, nil}` (`ghoul.lua:90`) at `rarity = 6` (`:91`). Upstream
     * divides an under-depth weight by `3 x levelsBelow` and an over-depth one
     * by `levelsAbove` alone (`Zone.lua:218-219`), so the pair crosses.
     *
     * DRIVEN OVER THE REAL LEVELS the Outer Index's roster is used at.
     */
    const roster = candidates(DELVES.get('site:outer_index')?.roster ?? []);
    expect(roster.length, 'the Outer Index has no weighted roster').toBeGreaterThan(1);

    const shareOf = (level: number, t: MonsterTemplate): number =>
      rarityShare(computeRarities(roster, level)).find((r) => r.e === t)?.percent ?? 0;

    const eliteShallow = shareOf(5, INDEX_HUSK_ELITE);
    const eliteDeep = shareOf(25, INDEX_HUSK_ELITE);
    expect(eliteDeep, 'the elite did not become commoner with depth').toBeGreaterThan(eliteShallow);
    expect(eliteShallow, 'the elite is not rare in a shallow room').toBeLessThan(5);

    /**
     * ═══ THE HUSK'S OWN WEIGHT, NOT ITS SHARE ═══
     * A SHARE falls whenever anything else rises, so asserting it survives a
     * `computeRarities` with the over-depth branch cut out — measured: that
     * mutant passed. `genprob` is the weight itself, and past the ceiling it has
     * to fall: `10000 / (lev - level_range[2])` at `Zone.lua:219`.
     */
    const weightAt = (level: number): number =>
      computeRarities(candidates([INDEX_HUSK]), level).total;
    expect(weightAt(15), 'precondition: in range at its ceiling').toBe(10000);
    expect(weightAt(20), 'the husk keeps full weight five levels past its ceiling').toBe(2000);
    expect(weightAt(25), 'the husk did not fade past its ceiling').toBeLessThan(weightAt(20));
  });

  it('changes what a floor actually holds as the floor gets deeper', () => {
    /**
     * ═══ THE JOIN, NOT THE HALVES ═══
     * The two assertions above are about `computeRarities`. This is about the
     * PLACER: it opens the same delve at floor 1 and at a deep floor through the
     * real generator and compares the bodies that came out. Before this port
     * `populateDelve` walked its roster as `roster[i % roster.length]`, so the
     * answer here was identical at every depth by construction.
     */
    const site = SITES.get('site:outer_index');
    const spec = specFor('site:outer_index');
    if (site === undefined || spec === undefined) throw new Error('no Outer Index');

    const mixAt = (floor: number): Map<string, number> => {
      const mix = new Map<string, number>();
      for (let n = 0; n < 8; n += 1) {
        const seed = `depth-mix:${String(floor)}:${String(n)}`;
        const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
        const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, floor);
        for (const body of bodiesOf(realm.world)) {
          mix.set(body.sprite, (mix.get(body.sprite) ?? 0) + 1);
        }
      }
      return mix;
    };
    const shallow = mixAt(1);
    const deep = mixAt(floorsOf(spec));
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(total(shallow), 'floor 1 placed nothing').toBeGreaterThan(20);
    expect(total(deep), 'the deep floor placed nothing').toBeGreaterThan(20);

    const elite = INDEX_HUSK_ELITE.sprite;
    const shareDeep = (deep.get(elite) ?? 0) / total(deep);
    const shareShallow = (shallow.get(elite) ?? 0) / total(shallow);
    expect(
      shareDeep,
      `the roster did not change with depth: ${String(shareShallow)} -> ${String(shareDeep)}`,
    ).toBeGreaterThan(shareShallow);

    /**
     * ═══ AND A SPREAD A CYCLE CANNOT PRODUCE ═══
     * The Outer Index's four floors span levels 10 to 13, where the elite's
     * weight moves by a little. A CYCLE gives the same composition at every
     * depth by construction, and over four floors the little is not enough to
     * fail it — measured: `roster[i % roster.length]` passed the assertion
     * above. So the rule is also stated where the two answers cannot be
     * confused: one roster, two levels far apart, driven through the placer.
     */
    const twoDeep = { ...spec, roster: [INDEX_HUSK, INDEX_HUSK_ELITE] };
    const eliteShareAt = (level: number): number => {
      let elites = 0;
      let bodies = 0;
      for (let n = 0; n < 6; n += 1) {
        const { world, map } = openFloor(`cycle-vs-draw-${String(level)}-${String(n)}`);
        populateDelve(
          world,
          map,
          { ...twoDeep, levelRange: [level, level] },
          { level: 1, size: 1 },
        );
        for (const body of bodiesOf(world)) {
          bodies += 1;
          if (body.sprite === INDEX_HUSK_ELITE.sprite) elites += 1;
        }
      }
      return bodies === 0 ? 0 : elites / bodies;
    };
    const shallowPair = eliteShareAt(3);
    const deepPair = eliteShareAt(30);
    expect(shallowPair, 'a level-3 floor is a third elites — the roster is a cycle').toBeLessThan(
      0.1,
    );
    expect(deepPair, 'a level-30 floor holds no elites — the roster is a cycle').toBeGreaterThan(
      0.5,
    );
  });

  it('refuses a candidate further out of depth than the zone allows', () => {
    /**
     * `max_ood` — `engine/Zone.lua:306`. A HARD refusal on top of the weight,
     * and six of our twelve zones carry it. The Trollmire, which Blackwood
     * Outskirts is built as, is `filters = { {max_ood=2} }`
     * (`trollmire/zone.lua:198`).
     */
    const spec = specFor('site:blackwood_outskirts');
    if (spec === undefined) throw new Error('no Blackwood spec');
    expect(spec.maxOod, 'Blackwood lost its filter').toBe(2);

    /**
     * ═══ DRIVEN THROUGH THE PLACER, NOT THROUGH A COPY OF THE RULE ═══
     * Rebuilding the filter here and asserting on it tests the test. Measured: a
     * mutant that made the production filter accept everything passed that way.
     * So the roster is narrowed to the one body the filter is about — the
     * Overwritten Husk, `level_range = {15, nil}` (`ghoul.lua:90`) — and the
     * floor is populated for real. With the filter the list is EMPTY and the
     * floor holds nobody; without it the same floor fills.
     */
    const onlyElite = { ...spec, roster: [INDEX_HUSK_ELITE], levelRange: [10, 10] as const };
    const { maxOod: _none, ...unfiltered } = onlyElite;
    let refused = 0;
    let allowed = 0;
    for (let n = 0; n < 6; n += 1) {
      const a = openFloor(`maxood-on-${String(n)}`);
      refused += populateDelve(a.world, a.map, onlyElite, { level: 1, size: 1 });
      const b = openFloor(`maxood-off-${String(n)}`);
      allowed += populateDelve(b.world, b.map, unfiltered, { level: 1, size: 1 });
    }
    expect(refused, 'max_ood let a body 5 levels out of depth onto a level-10 floor').toBe(0);
    expect(allowed, 'precondition: without the filter the floor fills').toBeGreaterThan(0);

    // And at a level the filter allows — 13 + 2 reaches the elite's floor of 15 —
    // the same spec populates.
    const inReach = { ...onlyElite, levelRange: [13, 13] as const };
    const c = openFloor('maxood-inreach');
    expect(populateDelve(c.world, c.map, inReach, { level: 1, size: 1 })).toBeGreaterThan(0);
  });

  it('takes one draw per body, whatever the roster holds', () => {
    // `Zone.lua:318-330` is one `rng.range(1, total)` and a linear walk, so a
    // content edit changes WHICH body a seed produces and never how many draws
    // the floor spends. That is what keeps a floor reproducible.
    const list = computeRarities(candidates([INDEX_HUSK, INDEX_WRAITH, INDEX_CAIRN]), 1);
    const short = computeRarities(candidates([INDEX_HUSK]), 1);
    const drawsFor = (l: typeof list): number => {
      const rng = createRng('draw-count');
      for (let i = 0; i < 10; i += 1) pickEntity(rng, `pick.${String(i)}`, l);
      return rng.getState().count;
    };
    expect(drawsFor(list)).toBe(drawsFor(short));
  });
});

describe('what level — `actor_adjust_level`, all four of its terms', () => {
  it('is base + rank + floor - 1, plus a draw of -1 to +2', () => {
    /**
     * `tome/data/zones/trollmire/zone.lua:30`, and seventy-eight more
     * occurrences of the same line. Asserted over the whole range of the draw
     * rather than against one seed, and per RANK, because the rank term is the
     * one that was missing: every body on a floor used to be exactly the same
     * level.
     */
    for (const rank of [ActorRank.Normal, ActorRank.Elite, ActorRank.Boss]) {
      const seen = new Set<number>();
      for (let n = 0; n < 200; n += 1) {
        const rng = createRng(`adjust-${rank}-${String(n)}`);
        seen.add(actorAdjustLevel(rng, 'delve.level.0', 10, rank, 3));
      }
      const base = 10 + rankLevelAdjust(RANK_VALUE[rank]) + 3 - 1;
      expect(
        [...seen].sort((a, b) => a - b),
        rank,
      ).toEqual([base - 1, base, base + 1, base + 2]);
    }
  });

  it('puts an elite over the bodies around it and a boss over the elite', () => {
    // `getRankLevelAdjust` — `tome/class/Actor.lua:1714-1725`: rank 2 is 0, rank
    // 3.5 is +2, rank 4 is +3. THIS is how upstream makes one body dangerous
    // instead of making twenty bodies slow.
    expect(rankLevelAdjust(RANK_VALUE[ActorRank.Normal])).toBe(0);
    expect(rankLevelAdjust(RANK_VALUE[ActorRank.Elite])).toBe(2);
    expect(rankLevelAdjust(RANK_VALUE[ActorRank.Boss])).toBe(3);
    expect(rankLevelAdjust(1), 'a critter is born under its floor').toBe(-1);
  });

  it('gives a floor bodies at more than one level, leaning up', () => {
    /**
     * ═══ THE JOIN ═══ The floor is opened through the real placer. Before the
     * port every body on a floor shared one level, so this set had size 1 by
     * construction and the elite in the corner was an ordinary body with a ring.
     */
    const site = SITES.get('site:hollow_mine');
    const spec = specFor('site:hollow_mine');
    if (site === undefined || spec === undefined) throw new Error('no Hollow Mine');
    const levels: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      const seed = `levels-spread-${String(n)}`;
      const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
      const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, 2);
      for (const body of bodiesOf(realm.world)) levels.push(body.level);
    }
    expect(levels.length, 'the Hollow Mine placed nothing').toBeGreaterThan(20);
    expect(new Set(levels).size, 'every body on the floor is the same level').toBeGreaterThan(1);

    const floorLevel = delveLevel(spec) + 2 - 1;
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    expect(mean, 'the jitter does not lean up').toBeGreaterThan(floorLevel);
    for (const l of levels) {
      expect(l).toBeGreaterThanOrEqual(floorLevel - 1);
      // The deepest a body can be born: the elite's +2 rank term plus the draw's +2.
      expect(l).toBeLessThanOrEqual(floorLevel + 2 + 2);
    }
  });

  it('descends a level a floor — `base_level + level.level - 1`', () => {
    // `engine/Zone.lua:195`. The floor term, isolated from the rank term and the
    // draw by averaging a hundred bodies of one rank.
    const mean = (floor: number): number => {
      let total = 0;
      for (let n = 0; n < 400; n += 1) {
        const rng = createRng(`floor-arith-${String(floor)}-${String(n)}`);
        total += actorAdjustLevel(rng, 'delve.level.0', 5, ActorRank.Normal, floor);
      }
      return total / 400;
    };
    expect(mean(2) - mean(1)).toBeCloseTo(1, 1);
    expect(mean(4) - mean(1)).toBeCloseTo(3, 1);
  });
});

describe('the tutorial`s last floor is no longer skipped', () => {
  it('populates every floor of the Undermost, including the last', () => {
    /**
     * ═══ THE BUG ═══
     * `UNDERMOST_SITE.populate` read
     * `if (spec === undefined || floor >= floorsOf(spec)) return;`, so the third
     * floor was never handed to `populateDelve` at all: no litter, no lore note
     * and — the part that mattered — no `spec.boss`, which `populateDelve` only
     * ever places on the last floor. Measured: 0 foes, 0 turns, 100% hp, cleared
     * by all four classes.
     *
     * The fact behind the guard was real and now lives in `nbNpcByFloor`:
     * `reknor-escape/zone.lua:79` is `nb_npc = {0, 0}` on that level because it
     * is a static map WITH ITS BODIES DRAWN ONTO IT
     * (data/maps/zones/reknor-escape-last.lua:34-35). So the floor rolls no
     * bodies, is populated, AND holds the fight its map is drawn around: the
     * warden and his pickets, placed by glyph. Both halves are asserted here,
     * because "no rolled body" and "no body" were the same assertion while the
     * hall was empty and they are different facts now.
     */
    const site = SITES.get('site:undermost');
    if (site === undefined) throw new Error('no Undermost site');
    const last = floorsOfSite('site:undermost');
    expect(last, 'the Undermost is one floor deep').toBeGreaterThan(1);

    let littered = 0;
    for (let n = 0; n < 4; n += 1) {
      const seed = `undermost-last-floor-${String(n)}`;
      const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
      const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, last);
      littered += realm.world.groundItems().length;
      // Upstream rolls no population on that level, and neither do we.
      const bodies = bodiesOf(realm.world);
      expect(
        bodies.filter((a) => /delve_(\d+|boss)$/.test(a.id)),
        `seed ${String(n)}: something was ROLLED onto the static last floor`,
      ).toEqual([]);
      // AND THE DRAWN FIGHT IS THERE. One warden, and pickets — the count is
      // `undermost.test.ts`'s to pin against the map; here it is only that the
      // hall is not empty, which is the state this whole case exists about.
      expect(
        bodies.filter((a) => a.id.includes('undermost_warden')),
        `seed ${String(n)}: nobody holds the last door`,
      ).toHaveLength(1);
      expect(
        bodies.filter((a) => a.id.includes('undermost_picket')).length,
        `seed ${String(n)}: the warden stands alone`,
      ).toBeGreaterThan(0);
    }
    expect(littered, 'the last floor was never populated at all').toBeGreaterThan(0);
  });

  it('is a place a lone beginner can arrive in', () => {
    // The floors before it hold the band every other tier-1 zone carries, not
    // the escape from Reknor's own 50-60 — see `DELVES`. The bodies are there.
    const site = SITES.get('site:undermost');
    const spec = specFor('site:undermost');
    if (site === undefined || spec === undefined) throw new Error('no Undermost');
    const seed = 'undermost-first-floor';
    const realms = createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
    const realm = realms.open(site, seed, { level: 1, size: 1 }, undefined, undefined, 1);
    const band = nbNpcFor(spec, 1);
    expect(bodiesOf(realm.world).length).toBeGreaterThanOrEqual(band[0]);
    expect(bodiesOf(realm.world).length).toBeLessThanOrEqual(band[1]);
  });
});

describe('every delve states its zone`s numbers', () => {
  it('carries a band, a roster every member of which can be rolled, and a level', () => {
    for (const [id, spec] of DELVES) {
      expect(spec.nbNpc[0], `${id} band`).toBeLessThanOrEqual(spec.nbNpc[1]);
      expect(spec.nbNpc[1], `${id} states no population`).toBeGreaterThan(0);
      expect(delveLevel(spec), `${id} level`).toBeGreaterThan(0);
      for (const t of spec.roster) {
        expect(t.rarity, `${id}: ${t.id} cannot be rolled`).toBeDefined();
        expect(t.levelRange, `${id}: ${t.id} has no level range`).toBeDefined();
      }
    }
  });

  it('is denser than it was, on every site on the map', () => {
    /**
     * THE AUTHOR'S COMPLAINT, AS A RULE: *"too easy per enemy and too little
     * enemies"*. The bands HEAD shipped are below, read off the file at
     * `63e3e47`; no site may be less crowded than it was.
     */
    const before = new Map<string, number>([
      ['site:drowned_chapel', 2],
      ['site:undermost', 2],
      ['site:underworks', 6],
      ['site:watchers_altar', 7],
      ['site:hollow_mine', 8],
      ['site:outer_index', 4],
      ['site:glass_archive', 5],
      ['site:gearford_ward', 8],
      ['site:cairnfoot', 6],
      ['site:barrow_end', 7],
      ['site:the_weir', 6],
      ['site:blackwood_outskirts', 10],
    ]);
    for (const [id, was] of before) {
      const spec = DELVES.get(id);
      if (spec === undefined) throw new Error(`no spec for ${id}`);
      // 2500 cells is what every generated site reports; only Gearford reads it.
      expect(nbNpcFor(spec, 1, 2500)[1], `${id} got emptier`).toBeGreaterThanOrEqual(was);
    }
  });

  it('is an inner site with a fight behind every door', () => {
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      if (site.id === 'site:encounter') continue;
      const spec = specFor(site.id);
      if (spec === undefined) continue;
      expect(nbNpcFor(spec, 1, 2500)[1], site.id).toBeGreaterThan(0);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MUTANTS THAT SURVIVED — each case below is one that lived through the
 * whole suite, with the mutation it now kills named in its own docblock.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The audit ran 59 mutants against this port and 15 survived; twelve of those
 * were real coverage gaps rather than equivalent mutants. The shape of nearly
 * all of them is the same and it is this repository's recurring one: a rule was
 * asserted against its own copy, or from one side only, so the half that ships
 * was never driven.
 */
describe('the gaps the mutation audit found', () => {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * A BAND HAS A CEILING AS WELL AS A FLOOR — the ratchet only ratcheted UP.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * SURVIVED: `site:hollow_mine`'s `nbNpc` taken from `[70, 80]` to
   * `[700, 800]` — roughly three hundred bodies a floor after `NB_NPC_SCALE` —
   * and `REDACTED_TOWN.nbNpcPerArea` from 34 to 340. The case above is
   * `toBeGreaterThanOrEqual` and nothing else in the tree bounds a count from
   * above, so a ten-fold typo in any of the twelve bands ships green. That is
   * exactly the failure this port's own notes warn about: *"a previous attempt
   * made nearly every delve UNCLEARABLE"*.
   *
   * THE CEILING IS UPSTREAM'S OWN NUMBER, not a tolerance invented here. Every
   * band is its zone's `nb_npc` taken at `NB_NPC_SCALE`, and the densest thing
   * in ToME's whole first tier is ardhungol at 70-80. A band whose top is over
   * `MOST_BODIES_UPSTREAM_STATES` is a band that is no longer a port of
   * anything, whatever else it is.
   */
  const MOST_BODIES_UPSTREAM_STATES = 80;

  it('is no denser than the densest zone upstream states, on every site', () => {
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      const spec = specFor(site.id);
      if (spec === undefined) continue;
      for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
        const band = nbNpcFor(spec, floor, 2500);
        expect(
          band[1],
          `${site.id} floor ${String(floor)} asks for ${String(band[1])} bodies`,
        ).toBeLessThanOrEqual(Math.ceil(MOST_BODIES_UPSTREAM_STATES * NB_NPC_SCALE));
        // AND THE BAND IS A BAND: a top under its own floor is a typo that
        // `rng.range` would silently answer backwards.
        expect(
          band[1],
          `${site.id} floor ${String(floor)} band is inverted`,
        ).toBeGreaterThanOrEqual(band[0]);
      }
    }
  });

  it('is no denser than that PER PERSON, whatever the party size', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CEILING ABOVE IS ONLY HALF THE QUESTION, AND THE OTHER HALF IS OURS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `delveHeadroom` multiplies AFTER the scale and ToME has no party at all,
     * so it is an original rule with no upstream number to check against. At
     * five it is x3.0, which puts NINETY-SIX bodies on the Hollow Mine's first
     * floor — a number that reads alarming and is not: five people meeting 96
     * bodies is nineteen each, against the seventy to eighty ardhungol puts in
     * front of ToME's ONE player.
     *
     * So the bound is PER PERSON, which is the only reading under which
     * upstream's figure is the right comparison at every party size. It catches
     * a ten-fold band typo exactly as the case above does, and it also catches
     * the thing that case cannot see: a headroom that grew superlinearly, which
     * would make every extra friend a tax rather than a hand.
     */
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      const spec = specFor(site.id);
      if (spec === undefined) continue;
      for (let size = 1; size <= 5; size += 1) {
        const party = { level: delveLevel(spec), size };
        for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
          const each = (nbNpcFor(spec, floor, 2500)[1] * delveHeadroom(party)) / size;
          expect(
            each,
            `${site.id} floor ${String(floor)} puts ${each.toFixed(1)} bodies on each of ${String(size)}`,
          ).toBeLessThanOrEqual(Math.ceil(MOST_BODIES_UPSTREAM_STATES * NB_NPC_SCALE));
        }
      }
    }
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE FLOOR TERM, AT THE JOIN — `delveLevel(spec) + floor - 1`.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * SURVIVED: `const roomLevel = delveLevel(spec, party) + floor - 1` reduced to
   * `delveLevel(spec, party)`. The depth case above drives the Outer Index,
   * whose four floors move the elite's weight from 0.55% to 1.37% — three
   * bodies against zero over eight seeds, which an un-deepened run clears by
   * luck about a third of the time. Its second half varies `levelRange`, which
   * does not exercise the floor term at all.
   *
   * SO IT IS THE SAME SPEC AT TWO FLOORS, WITH A LEVEL GAP BIG ENOUGH THAT THE
   * WEIGHTS ARE NOT NEIGHBOURS — one roster, one level range, nothing moving
   * but the floor number the placer is handed.
   */
  it('reads the floor number into the level the roster is drawn at', () => {
    const spec = specFor('site:outer_index');
    if (spec === undefined) throw new Error('no Outer Index');
    const pair = { ...spec, roster: [INDEX_HUSK, INDEX_HUSK_ELITE], levelRange: [3, 3] as const };

    const eliteShareAtFloor = (floor: number): number => {
      let elites = 0;
      let bodies = 0;
      for (let n = 0; n < 6; n += 1) {
        const { world, map } = openFloor(`floor-term-${String(floor)}-${String(n)}`);
        populateDelve(world, map, pair, { level: 1, size: 1 }, floor);
        for (const body of bodiesOf(world)) {
          bodies += 1;
          if (body.sprite === INDEX_HUSK_ELITE.sprite) elites += 1;
        }
      }
      return bodies === 0 ? 0 : elites / bodies;
    };

    // Floor 1 is room level 3 — the elite's `levelRange[0]` is 15, so it is
    // twelve levels under depth and all but excluded. Floor 28 is room level 30,
    // where it is the commoner of the two.
    const shallow = eliteShareAtFloor(1);
    const deep = eliteShareAtFloor(28);
    expect(shallow, 'a floor-1 room is drawing deep bodies').toBeLessThan(0.1);
    expect(deep, 'the floor number never reached the roster draw').toBeGreaterThan(0.5);
  });

  /**
   * SURVIVED: `BOSS_LEVELS_ABOVE_ROOM = rankLevelAdjust(RANK_VALUE[Boss])`
   * replaced by the literal `2` it used to be. Its only remaining reader is a
   * test that uses it on both sides of a band, so the band moved with it and
   * nothing noticed. Its docblock says *"DERIVED now — change `rankLevelAdjust`
   * and this follows"*, and this is the one line that makes that true.
   */
  it('derives the boss promotion from its rank rather than restating it', () => {
    expect(BOSS_LEVELS_ABOVE_ROOM).toBe(rankLevelAdjust(RANK_VALUE[ActorRank.Boss]));
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `max_ood` WHERE IT ACTUALLY BITES — the Glass Archive's first two floors.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * SURVIVED: `maxOod: 2` deleted from `site:glass_archive`. The mechanism has a
   * case above, but it drives a SYNTHETIC spec — so the rule was pinned and its
   * one shipped use was not. Measured across every inner site and every floor,
   * the Glass Archive at room level 11 and 12, refusing the Overwritten Husk at
   * `levelRange[0] = 15`, is the only place in the shipped table where the
   * filter refuses anything at all.
   */
  it('keeps the Overwritten Husk out of the Glass Archive first floors', () => {
    const spec = specFor('site:glass_archive');
    if (spec === undefined) throw new Error('no Glass Archive');
    expect(spec.roster.some((t) => t.sprite === INDEX_HUSK_ELITE.sprite)).toBe(true);

    /**
     * ═══ MANY FLOORS, BECAUSE THE FADE ALREADY MAKES IT RARE AND THAT IS THE
     * WHOLE POINT OF THE FILTER ═══
     * `computeRarities` puts the elite at 0.69% of floor 1 and 0.92% of floor 2
     * WITHOUT `max_ood`. Eight floors is fifty bodies and would see neither, so
     * a case that size passes with the filter deleted — measured, it did. The
     * rule the zone is stating is *never*, not *seldom*, and the only honest way
     * to tell those two apart is a sample big enough for *seldom* to show.
     *
     * DRIVEN THROUGH `populateDelve` ON A BARE FLOOR rather than through
     * `createRealms`, because two hundred generated caves is a minute of wall
     * clock and the generator is not what is being asked about.
     */
    const elitesOnFloor = (floor: number): { elites: number; bodies: number } => {
      let elites = 0;
      let bodies = 0;
      for (let n = 0; n < 200; n += 1) {
        const { world, map } = openFloor(`ood-archive:${String(floor)}:${String(n)}`);
        populateDelve(world, map, spec, { level: 1, size: 1 }, floor);
        for (const body of bodiesOf(world)) {
          bodies += 1;
          if (body.sprite === INDEX_HUSK_ELITE.sprite) elites += 1;
        }
      }
      return { elites, bodies };
    };

    const first = elitesOnFloor(1);
    const second = elitesOnFloor(2);
    expect(first.bodies, 'floor 1 placed nothing').toBeGreaterThan(500);
    expect(first.elites, 'the Archive first floor let an out-of-depth elite in').toBe(0);
    expect(second.elites, 'the Archive second floor let an out-of-depth elite in').toBe(0);

    /**
     * AND THE THIRD FLOOR LETS IT IN, which is what makes the two lines above a
     * statement about the FILTER and not about the fade: room level 13 plus
     * `maxOod` 2 is exactly the elite's `levelRange[0]` of 15, so `Zone.lua:306`
     * stops refusing it on the floor upstream's arithmetic says it should.
     */
    const third = elitesOnFloor(floorsOf(spec));
    expect(
      third.elites,
      'the filter never stops biting — the first two floors prove nothing',
    ).toBeGreaterThan(0);
  });

  /**
   * SURVIVED: the `Math.max(1, ...)` in `actorAdjustLevel`. The difference is
   * reachable and it is reachable in the two rooms a new character meets — on
   * floor 1 of a base-level-1 zone the `rng.range(-1, 2)` draw asks for level
   * ZERO one time in four, and the clamp is all that stops it. A level-0 body is
   * a question `maxLifeFor` and every `combatTalentScale` in the game have never
   * been asked.
   */
  it('never births a body below level 1, whatever the jitter rolls', () => {
    for (let n = 0; n < 400; n += 1) {
      const rng = createRng(`floor-of-one:${String(n)}`);
      expect(actorAdjustLevel(rng, 'jitter', 1, ActorRank.Normal, 1)).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * `OnSpots` — THE ONE ZONE-SPECIFIC PLACEMENT RULE THIS PORT ADDED.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * SURVIVED, BOTH WAYS: the `spec.spots !== undefined` branch forced false, and
   * Blackwood's whole `spots` block deleted. The clumping case in
   * `delve-scaling.test.ts` drives `site:gearford_ward`, which carries no
   * `spots`, so the rule ported this run had no assertion at all.
   *
   * `engine/generator/actor/OnSpots.lua:30-38, 43-56`: pick `nb_spots` spots and
   * put each body within `spot_radius` of one of them at `on_spot_chance`
   * percent. Trollmire — so Blackwood Outskirts — is `nb_spots = 2,
   * on_spot_chance = 35` (trollmire/zone.lua:196, :199) with OnSpots' own
   * default radius of 5.
   *
   * THE CONTROL IS THE SAME SPEC WITHOUT `spots`, so the only difference between
   * the two numbers is the rule itself: same seeds, same band, same roster.
   */
  it('clusters Blackwood bodies round spots, and nothing else', () => {
    const spec = specFor('site:blackwood_outskirts');
    if (spec === undefined) throw new Error('no Blackwood');
    expect(spec.spots, 'Blackwood stopped carrying trollmire OnSpots fields').toBeDefined();

    /**
     * THE SHARE OF BODIES STANDING IN A PACK, at OnSpots' own `spot_radius`.
     *
     * MEAN NEAREST-NEIGHBOUR DISTANCE WAS THE FIRST STATISTIC AND IT IS TOO
     * WEAK: 4.04 against 4.31, and forcing the per-body branch false left it
     * passing by luck. `on_spot_chance` is 35, so two thirds of the floor is
     * drawn uniformly either way and the signal is all in the other third.
     * Asking how many bodies are standing WITH somebody separates them, because
     * that is the thing `OnSpots` actually does.
     *
     * ═══ AND IT IS MEASURED ON BLACKWOOD'S OWN FLOOR NOW ═══
     * It read 49% against 32% on the 30-wide fixture at the counts of the day.
     * Both halves of that were fixture: on 750 cells a band of twenty is dense
     * enough that a uniform draw packs nearly everything, and when the counts
     * rose to the zone's own the two numbers met at 85% and 83% and the case
     * failed with the rule untouched. `BLACKWOOD_SIDE` is the floor the placer
     * really runs on, and on it the separation is about the rule again.
     */
    const inAPack = (withSpots: boolean): number => {
      const radius = spec.spots?.spotRadius ?? 0;
      let packed = 0;
      let counted = 0;
      for (let n = 0; n < 20; n += 1) {
        const { world, map } = openFloor(
          `spots:${String(withSpots)}:${String(n)}`,
          BLACKWOOD_FLOOR,
        );
        populateDelve(world, map, withSpots ? spec : { ...spec, spots: undefined }, {
          level: 1,
          size: 1,
        });
        const bodies = [...bodiesOf(world)];
        for (const a of bodies) {
          let near = 0;
          for (const b of bodies) {
            if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= radius) near += 1;
          }
          counted += 1;
          // ITSELF AND TWO OTHERS — the smallest arrangement a player would call
          // opening a door onto something rather than meeting one more husk.
          if (near >= 3) packed += 1;
        }
      }
      return counted === 0 ? 0 : packed / counted;
    };

    const clustered = inAPack(true);
    const loose = inAPack(false);
    expect(clustered, 'no bodies were placed').toBeGreaterThan(0);
    expect(
      clustered,
      `OnSpots did not tighten the floor: ${(100 * clustered).toFixed(0)}% vs ${(100 * loose).toFixed(0)}%`,
    ).toBeGreaterThan(loose * 1.2);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FACTOR ITSELF — `NB_NPC_SCALE`, AND WHAT IT IS ALLOWED TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The cases above check that every band is the zone's own `nb_npc` and that
 * nothing is denser than the densest zone upstream states. Both of them take
 * `NB_NPC_SCALE` as given and scale their own bound by it, which is right — they
 * are about the BANDS — and it means nothing in the tree says anything about the
 * factor. A factor of 0.05 passes every one of them, and so does 12.
 *
 * The receipt for its value lives on the constant in `content/delve.ts`. These
 * are the two bounds that receipt cannot be written outside of.
 */
describe('the one factor that is not upstream’s', () => {
  it('never places MORE than the zone states, because then it is not a port', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ONE IS THE CEILING AND IT IS A DEFINITION, NOT A TOLERANCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every `nbNpc` in `DELVES` cites a zone file and a line. At 1.00 the band
     * this game rolls IS the band that line states, and the whole claim of the
     * port — *"reuse fifteen years of tuning"* — rests on that. Above 1.00 the
     * counts stop being upstream's and start being ours, and nothing in the
     * bestiary, the rarity weighting or `actor_adjust_level` was tuned for them.
     *
     * A floor is deliberately NOT asserted here. A factor can be argued down
     * with a measurement — that is what the constant's docblock is — and the
     * bar that decides how far down is the levelling curve, which has its own
     * file (`test/server/levelling-curve.test.ts`) and fails from below.
     */
    expect(
      NB_NPC_SCALE,
      'the delves hold more bodies than the zones they port',
    ).toBeLessThanOrEqual(1);
    expect(NB_NPC_SCALE, 'a factor of zero or less empties every delve').toBeGreaterThan(0);
  });

  it('leaves every delve a band that can still put a body on the floor', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FLOOR UNDER THE FACTOR THAT IS A RULE RATHER THAN A MEASUREMENT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * How far DOWN the factor may be argued is the levelling curve's question
     * and it has its own file — `test/server/levelling-curve.test.ts` fails
     * from below, because a thinner floor pays less experience and the ruling
     * is about experience. This is the other floor, the structural one: a
     * factor low enough to round a band to nothing turns a delve into an empty
     * room, and no amount of levelling arithmetic would notice, because an
     * empty room fails that case for the same reason a poor one does.
     *
     * `nbNpcFor` rounds, so the smallest band in the game is what decides this:
     * the Glass Archive's `{12, 16}` off `scintillating-caves/zone.lua:53`.
     *
     * THE ONE EXEMPTION IS UPSTREAM'S OWN ZERO. `reknor-escape/zone.lua:79`
     * states `nb_npc = {0, 0}` for its last level, and `nbNpcFor`'s docblock is
     * explicit that `{0, 0}` must stay `{0, 0}` under any factor — that static
     * floor has its bodies drawn on the map. So the rule is about bands the
     * spec states as non-empty, and a band that was never meant to hold anybody
     * is not evidence of a factor that is too low.
     */
    let checked = 0;
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      const spec = specFor(site.id);
      if (spec === undefined) continue;
      for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
        const stated = spec.nbNpcByFloor?.get(floor) ?? spec.nbNpc;
        if (stated[1] === 0) continue;
        checked += 1;
        /**
         * THE SITE'S OWN AREA, READ OFF THE BUILT FLOOR — and read only for the
         * spec that has a field which looks at it. This passed a literal 2500
         * for every spec, which happened to be right (the one zone that reads
         * the area, Gearford's `nbNpcPerArea`, is 50x50) and was right by
         * COINCIDENCE, on a case whose whole subject is a band rounding to zero.
         * The Glass Archive is 900 cells, the Hollow Mine 3600 and Blackwood
         * 2600, and the day a second zone takes `nbNpcPerArea` the coincidence
         * stops holding. A realm is opened only where it is needed, because
         * opening one per floor of twenty-eight sites is a generator run apiece.
         */
        const area = spec.nbNpcPerArea === undefined ? undefined : areaOf(site.id, floor);
        expect(
          nbNpcFor(spec, floor, area)[1],
          `${site.id} floor ${String(floor)} rounds to an empty room at this factor`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked, 'no delve states a non-empty band any more').toBeGreaterThan(0);
  });

  it('is the number the probes measured, and moving it means re-running them', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE CHANGE-DETECTOR IN THIS FILE, AND IT IS DELIBERATE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every other case here scales its own bound by `NB_NPC_SCALE`, which is
     * right — they are about the BANDS — and it means all of them would go on
     * passing at 0.05 or at 12. The two bounds above are real and neither of
     * them picks a value inside the range they leave.
     *
     * The value is picked by things a unit test cannot run, and there are THREE
     * of them, not two — which is the lesson this message now carries:
     *
     *   `tools/delve-climb.mjs`, every delve descended by every class, carrying
     *     level and experience. This is the LEVELLING bound and it wants the
     *     factor HIGH.
     *   `tools/delve-density.mjs` / `tools/delve-run.mjs`, the two level-1 delves
     *     solo for ALL FOUR CLASSES and as a party of four, counting wipes AND
     *     TURNS. This is the BEGINNER-ROOM bound and it wants the factor LOW.
     *   and only then the arithmetic in `levelling-curve.test.ts`, which is a
     *     bound on the delve rather than on the player.
     *
     * THE SECOND ONE WAS ONCE TAKEN ON THE WATCHMAN ALONE, and the constant's own
     * note said in the same breath that *"the Watchman is flat across the whole
     * range"* — a value chosen with the one instrument that cannot see it. Driven
     * across the four classes the same sweep moves a great deal: see the table in
     * `first-room.test.ts`.
     *
     * THE HONEST THING IS TO SAY SO RATHER THAN TO INVENT A FAST PROXY that would
     * be a worse bound wearing a test's clothes. So this line exists to make
     * moving the number a deliberate act: change it and this case names every
     * measurement that has to move with it.
     */
    expect(
      NB_NPC_SCALE,
      'the factor moved — re-run tools/delve-climb.mjs (every delve, EVERY' +
        ' CLASS) and the first-room sweep in tools/delve-density.mjs for all' +
        ' four classes AND a party of four, counting wipes and TURNS, and' +
        ' rewrite every table on the constant and in first-room.test.ts',
    ).toBe(0.85);
  });
});
