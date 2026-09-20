// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  BOSS_LEVELS_ABOVE_ROOM,
  DELVES,
  actorAdjustLevel,
  delveHeadroom,
  delveLevel,
  floorsOf,
  nbNpcFor,
  populateDelve,
  specFor,
} from '../../src/server/content/delve.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
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
    // ceil(70*70*60/4900) = 60, band {55, 65}, verbatim: there is no factor.
    expect(large).toEqual([55, 65]);

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
     * carried by every `{1, 5}` zone in ToME and by nothing past the first tier
     * (see `DelveSpec.maxOod`), so it reaches our table through `countFrom` on
     * the delves whose count is sourced from a tier-1 zone.
     *
     * ═══ THE VEHICLE IS FOUND, NOT NAMED ═══
     * This read `specFor('site:blackwood_outskirts')` and asserted the Trollmire's
     * `max_ood = 2` on it. Blackwood's count is the Mark of the Spellblaze's now
     * (`{15, 25}` filters at nothing) and the case went red on a site id rather
     * than on the rule it is about. The rule needs SOME shipped spec carrying
     * the filter; which one is content's business.
     */
    const filtered = [...SITES.values()]
      .filter((s) => s.kind === RealmKind.Inner)
      .map((s) => ({ id: s.id, spec: specFor(s.id) }))
      .filter((s) => s.spec?.maxOod === 2);
    const spec = filtered[0]?.spec;
    expect(filtered.length, 'no delve in the game carries max_ood = 2 any more').toBeGreaterThan(0);
    if (spec === undefined) throw new Error('no filtered spec');

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
   * `[700, 800]` — roughly three hundred bodies a floor — and
   * `REDACTED_TOWN.nbNpcPerArea` from 34 to 340. The case above is
   * `toBeGreaterThanOrEqual` and nothing else in the tree bounds a count from
   * above, so a ten-fold typo in any of the twelve bands ships green. That is
   * exactly the failure this port's own notes warn about: *"a previous attempt
   * made nearly every delve UNCLEARABLE"*.
   *
   * THE CEILING IS UPSTREAM'S OWN NUMBER, not a tolerance invented here. Every
   * band is some zone's `nb_npc` verbatim (`DelveSpec.countFrom`), and the
   * largest `nb_npc` any ToME zone states ANYWHERE is 80 —
   * `data/zones/ardhungol/zone.lua:50` and `data/zones/sandworm-lair/zone.lua:120`.
   * (It used to read "on a floor of a size we build", which was wrong about the
   * second of those: sandworm-lair states it on a 350x20, seven thousand cells,
   * and we build nothing like that. The bound does not need the clause — nothing
   * in ToME states more than 80 on any floor at all.)
   * A band whose top is over `MOST_BODIES_UPSTREAM_STATES` is a band that is no
   * longer a port of anything, whatever else it is.
   *
   * IT IS A LOOSE CEILING NOW AND DELIBERATELY SO. Nothing on the map reaches it
   * since the alignment — the largest band in the twelve is `{50, 60}` — and
   * tightening it to what ships would make this a change-detector rather than a
   * bound on the port. The tight statement is in
   * `test/server/delve-alignment.test.ts`: every band equals the Lua line it
   * cites.
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
        ).toBeLessThanOrEqual(MOST_BODIES_UPSTREAM_STATES);
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
          ).toBeLessThanOrEqual(MOST_BODIES_UPSTREAM_STATES);
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
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE FILTER ON A SHIPPED SPEC, FOUND RATHER THAN NAMED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `populateDelve` is driven with a real `DelveSpec` and a real roster in the
   * case above, but that one builds a SYNTHETIC spec — so the rule was pinned
   * and its one shipped use was not.
   *
   * ═══ WHICH SPEC IS NOT WRITTEN DOWN, BECAUSE IT KEEPS MOVING ═══
   * This has now gone red twice on an id rather than on its rule. It read
   * `site:blackwood_outskirts` until Blackwood's count came from a `{15, 25}`
   * zone that states no filter; it then read `site:glass_archive` until the
   * Archive's came from `{10, 25}`, which states none either. The rule needs
   * SOME shipped delve whose filter actually refuses somebody, and which one
   * that is is content's business: the search below finds it. Today it is
   * Barrow End, at level five with `THICKET`, taking Norgos' Lair's tier-1
   * `max_ood = 2` against `INDEX_HUSK_ELITE` at `levelRange` fifteen.
   */
  it('refuses an out-of-depth body on whichever shipped delve filters one', () => {
    const elite = INDEX_HUSK_ELITE.sprite;
    /** The delves whose own filter would refuse a member of their own roster. */
    const biting: { id: string; spec: DelveSpec }[] = [];
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      const candidate = specFor(site.id);
      if (candidate === undefined) continue;
      const ood = candidate.maxOod;
      if (ood === undefined) continue;
      const reach = delveLevel(candidate) + ood;
      const refuses = candidate.roster.some(
        (t) => t.levelRange !== undefined && reach < t.levelRange[0],
      );
      if (refuses) biting.push({ id: site.id, spec: candidate });
    }
    expect(
      biting.map((r) => r.id),
      'no shipped delve carries a filter that refuses anybody — the rule below is vacuous',
    ).not.toEqual([]);
    const spec = biting[0]?.spec;
    if (spec === undefined) throw new Error('no biting spec');

    /**
     * ═══ MANY FLOORS, BECAUSE THE FADE ALREADY MAKES IT RARE ═══
     * `computeRarities` puts the elite under one percent of the draw WITHOUT
     * `max_ood`. A handful of floors is fifty bodies and would see neither, so a
     * case that size passes with the filter deleted — measured, it did. The rule
     * the zone states is *never*, not *seldom*, and the only honest way to tell
     * those apart is a sample big enough for *seldom* to show.
     *
     * DRIVEN THROUGH `populateDelve` ON A BARE FLOOR rather than through
     * `createRealms`, because two hundred generated floors is a minute of wall
     * clock and the generator is not what is being asked about.
     */
    const elitesOn = (
      use: DelveSpec,
      floor: number,
      tag: string,
    ): { hits: number; all: number } => {
      let hits = 0;
      let all = 0;
      for (let n = 0; n < 200; n += 1) {
        const { world, map } = openFloor(`ood:${tag}:${String(floor)}:${String(n)}`);
        populateDelve(world, map, use, { level: 1, size: 1 }, floor);
        for (const body of bodiesOf(world)) {
          all += 1;
          if (body.sprite === elite) hits += 1;
        }
      }
      return { hits, all };
    };

    for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
      const on = elitesOn(spec, floor, 'on');
      expect(on.all, `floor ${String(floor)} placed nothing`).toBeGreaterThan(300);
      expect(on.hits, `floor ${String(floor)} let a body out of its depth past max_ood`).toBe(0);
    }

    /**
     * AND THE SAME SPEC WITHOUT THE FILTER LETS IT IN, which is what makes the
     * lines above a statement about `max_ood` rather than about the fade. Same
     * roster, same level, same floors: one field removed.
     */
    const { maxOod: _off, ...unfiltered } = spec;
    let without = 0;
    for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
      without += elitesOn(unfiltered, floor, 'off').hits;
    }
    expect(without, 'precondition: without the filter the elite is drawn at all').toBeGreaterThan(
      0,
    );
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
 *   THERE IS NO FACTOR ANY MORE, AND THIS IS WHAT KEEPS IT THAT WAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NB_NPC_SCALE` stood here and WAS 0.85: one global multiplier on every band,
 * the only number in `content/delve.ts` that was not upstream's. Three cases in
 * this file were about it — a ceiling of 1.00, a floor under rounding, and a
 * change-detector naming the probes to re-run. It is deleted, because the drift
 * it was absorbing was a mis-sourced count and one factor cannot be right for a
 * table that drifts in both directions at once: lowering it starved the delves
 * standing above their band and raising it killed you in the ones standing
 * below. The alignment is in `DelveSpec.countFrom` and
 * `test/server/delve-alignment.test.ts`.
 *
 * WHAT IS LEFT IS THE PART THAT WAS NEVER ABOUT THE FACTOR'S VALUE. A future
 * factor — a multiplier, a party term, a "just this once" +2 — would reappear
 * in exactly one observable place, which is that `nbNpcFor` stopped returning
 * the band a delve states. That is the first case. The second is the structural
 * floor the old one had: a band that rounds to an empty room.
 */
describe('the band the placer uses is the band the delve states', () => {
  it('returns each floor`s stated band verbatim, with nothing applied to it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FACTOR REINTRODUCED *HERE* CANNOT PASS — AND THAT IS THE NARROW CLAIM.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This said "the one case a reintroduced factor cannot pass" and that was
     * too wide. Measured: `Math.round(rolled * 0.85)` put on `populateDelve`'s
     * own line, ONE line after `nbNpcFor` returns, with the same draw label and
     * the same range, leaves this case green. It is caught — by `delve-air`, by
     * `weir-roster`, and by the placer-driven count case in this file — but not
     * by this one, which asks the TABLE's question and not the FLOOR's.
     *
     * `nbNpcFor` is the placer's own question (`populateDelve` asks it, and so
     * do the probes and `levelling-curve.test.ts`), so anything applied to a
     * count anywhere has to pass through here. Driven over every inner site and
     * every floor rather than over `DELVES`, because the Redaction's twenty-two
     * specs are DERIVED and a factor added in `redactedSpec` would be invisible
     * to a case that only read the table.
     *
     * ═══ THE ONE SPEC THIS CANNOT ASK THE FLAT QUESTION OF ═══
     * `nbNpcPerArea` computes its band from the floor's own area
     * (`data/zones/infinite-dungeon/zone.lua:255-256`), so there is no stated
     * pair to compare against — its band is checked against the formula
     * instead, which is the same demand made of the same arithmetic.
     */
    let flat = 0;
    let scaled = 0;
    for (const site of SITES.values()) {
      if (site.kind !== RealmKind.Inner) continue;
      const spec = specFor(site.id);
      if (spec === undefined) continue;
      for (let floor = 1; floor <= floorsOf(spec); floor += 1) {
        if (spec.nbNpcPerArea === undefined) {
          flat += 1;
          const stated = spec.nbNpcByFloor?.get(floor) ?? spec.nbNpc;
          expect(
            nbNpcFor(spec, floor, 2500),
            `${site.id} floor ${String(floor)}: the placer does not use the band the spec states`,
          ).toEqual(stated);
        } else {
          scaled += 1;
          const each = Math.ceil((2500 * spec.nbNpcPerArea) / 4900);
          expect(
            nbNpcFor(spec, floor, 2500),
            `${site.id} floor ${String(floor)}: the area band is not upstream's +/-5`,
          ).toEqual([Math.max(0, each - 5), each + 5]);
        }
      }
    }
    expect(flat, 'no flat-band floor left to check').toBeGreaterThan(0);
    expect(scaled, 'no area-band floor left to check').toBeGreaterThan(0);
  });

  it('leaves every delve a band that can still put a body on the floor', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STRUCTURAL FLOOR, WHICH OUTLIVED THE FACTOR IT WAS WRITTEN FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A band that rounds to nothing turns a delve into an empty room, and no
     * amount of levelling arithmetic would notice, because an empty room fails
     * `levelling-curve.test.ts` for the same reason a poor one does. Nothing
     * rounds any more — the bands are verbatim — but a band authored as
     * `{0, n}` or an area formula on a tiny floor would land in exactly the same
     * place, so the bound stays.
     *
     * THE ONE EXEMPTION IS UPSTREAM'S OWN ZERO. `reknor-escape/zone.lua:79`
     * states `nb_npc = {0, 0}` for its last level, because that static floor has
     * its bodies drawn on the map. So the rule is about bands the spec states as
     * non-empty, and a band that was never meant to hold anybody is not evidence
     * of an empty room.
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
          `${site.id} floor ${String(floor)} is an empty room`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked, 'no delve states a non-empty band any more').toBeGreaterThan(0);
  });
});
