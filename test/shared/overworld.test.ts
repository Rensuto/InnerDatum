/**
 * The Alderbrook region — the overworld map, proven rather than eyeballed.
 *
 * WHY THIS FILE EXISTS. `ALDERBROOK_ROWS` is 6,144 authored cells. Nobody can
 * read that for the one mistake that actually matters — a settlement that
 * cannot be walked to — and the failure is silent: the map loads, the country
 * draws, and a party walks toward the Glass Archive for ten minutes and finds
 * no way in.
 *
 * The layout was generated from regions and roads and verified once before
 * being frozen into the source. This re-runs that verification on every commit,
 * because the map is now ordinary text an ordinary edit can break: widen one
 * mountain range by a cell and you can seal a road without touching anything
 * that looks load-bearing.
 */

import { describe, expect, it } from 'vitest';

import { canWalk, makeOverworld, regionAt, tileAt } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';
import { TileCode, blocksSight, isWalkable } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

const OVERWORLD = makeOverworld();

/** Alderbrook's gate. Every player starts here, so it anchors every claim. */
// The gate, and it MOVED with the redesign — v1 put it at 122,73 and the
// redesigned moor puts Alderbrook at 103,64. Every coordinate in this file is
// about that gate, so it is named once.
const ALDERBROOK = { x: 103, y: 64 };

/**
 * Flood fill from a tile, EIGHT-WAY WITH CORNER CUTTING.
 *
 * The corner-cutting part is not incidental — it must match the movement rule
 * the server enforces, which allows a diagonal step between two orthogonally
 * adjacent walls (world.ts:852-856, ported from ToME). A stricter flood here
 * would report false failures; a laxer one would prove nothing.
 */
function reachableFrom(level: LevelView, from: { x: number; y: number }): Set<string> {
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const stack = [from];
  while (stack.length > 0) {
    const cell = stack.pop();
    if (cell === undefined) break;
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
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (!canWalk(level, nx, ny)) continue;
      seen.add(key);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe('the region — shape', () => {
  it("is 170x100 — ToME's own wilderness size — with a tile for every cell", () => {
    // `data/zones/wilderness/zone.lua` in the reference clone reads
    // `width = 170, height = 100`. Roughly four camera screens across and three
    // down, so crossing the region is a journey rather than a walk.
    expect(OVERWORLD.view.w).toBe(170);
    expect(OVERWORLD.view.h).toBe(100);
    expect(OVERWORLD.view.tiles).toHaveLength(170 * 100);
  });

  it('spawns every player at Alderbrook and nowhere else', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE REASON WAS RIGHT AND THE NUMBER WAS BACKWARDS.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This used to read `expect(OVERWORLD.spawns).toEqual([ALDERBROOK])` under
     * the comment "ONE spawn is deliberate: the first thing you see on
     * connecting should be another player, not empty country."
     *
     * That intent is exactly right, and ONE SPAWN TILE IS THE ONE ARRANGEMENT
     * THAT CANNOT DELIVER IT. `world.ts#findSpawn` walks the authored cluster
     * and falls through to a uniform draw over every free tile on the level, so
     * with a single tile the second player to join — and every player after them
     * — was placed somewhere random on a 170x100 moor. The first thing they saw
     * on connecting was empty country, which is the precise outcome this test
     * was written to prevent while asserting the thing that caused it.
     *
     * So the assertion is now the intent rather than the number: the gate is
     * still where everybody lands, and there is room there for a party.
     */
    // Every spawn is at the gate, none anywhere else. Chebyshev, because
    // "the same courtyard" is a square in a grid game.
    const strays = OVERWORLD.spawns.filter(
      (s) => Math.max(Math.abs(s.x - ALDERBROOK.x), Math.abs(s.y - ALDERBROOK.y)) > 2,
    );
    expect(strays).toEqual([]);

    // ...and there are enough of them for a Discord voice channel, which is the
    // whole reason the map exists.
    expect(OVERWORLD.spawns.length).toBeGreaterThanOrEqual(8);

    // The gate itself is still one of them, and still the site marker.
    expect(OVERWORLD.spawns).toContainEqual(ALDERBROOK);
  });

  it('is sealed by erased ground on all four edges', () => {
    // The border is fiction, not a wall: the Index has eaten everything beyond
    // the region. It still has to actually seal, or a player walks off the map.
    for (let x = 0; x < OVERWORLD.view.w; x += 1) {
      expect(tileAt(OVERWORLD.view, x, 0)).toBe(TileCode.ERASED);
      expect(tileAt(OVERWORLD.view, x, OVERWORLD.view.h - 1)).toBe(TileCode.ERASED);
    }
    for (let y = 0; y < OVERWORLD.view.h; y += 1) {
      expect(tileAt(OVERWORLD.view, 0, y)).toBe(TileCode.ERASED);
      expect(tileAt(OVERWORLD.view, OVERWORLD.view.w - 1, y)).toBe(TileCode.ERASED);
    }
  });
});

describe('it is wilderness, not a town', () => {
  it('is mostly open country rather than paving', () => {
    // THE CHANGE THIS FILE RECORDS. The overworld used to BE Alderbrook, and
    // its commonest tile was a cobbled street. It is now the country around
    // Alderbrook, and the commonest tile must be open ground — otherwise the
    // city has quietly eaten the map again.
    const tiles = OVERWORLD.view.tiles;
    const countOf = (want: readonly number[]): number =>
      tiles.filter((t) => want.includes(t)).length;
    const open = countOf([TileCode.PLAINS, TileCode.HILLS, TileCode.HEATH, TileCode.GREEN]);
    const built = countOf([TileCode.COBBLE, TileCode.PAVING]);
    expect(open).toBeGreaterThan(built * 5);
  });

  it('makes forest, mountain and water the walls of the map', () => {
    // ToME's own rule, verified in the reference clone rather than remembered:
    // data/zones/wilderness/grids.lua gives FOREST `does_block_move = true`.
    // The light ground threading between dark masses IS the route, and a
    // mountain you could walk over would delete every decision the map makes.
    for (const blocking of [
      TileCode.TREES,
      TileCode.MOUNTAIN,
      TileCode.CRAG,
      TileCode.WATER,
      TileCode.DEEPWATER,
    ]) {
      expect(isWalkable(blocking), `${blocking} should block movement`).toBe(false);
    }
    for (const open of [TileCode.PLAINS, TileCode.HILLS, TileCode.HEATH]) {
      expect(isWalkable(open), `${open} should be walkable`).toBe(true);
    }
  });

  it('drains to a sea, with a shore between', () => {
    // A coast is three things or it is a blue shape abutting a green one: deep
    // water, shallow water and a beach. The generator produces the band from
    // elevation, so this is really asserting the thresholds still bracket it.
    const codes = new Set(OVERWORLD.view.tiles);
    expect(codes.has(TileCode.DEEPWATER)).toBe(true);
    expect(codes.has(TileCode.WATER)).toBe(true);
    expect(codes.has(TileCode.SHORE)).toBe(true);
  });

  it('has rivers that reach the sea rather than stopping inland', () => {
    // Every river was carved by walking downhill until it hit water, so a river
    // cell adjacent to nothing wet would mean the walk terminated in a basin —
    // which is a lake the map does not know it has.
    const view = OVERWORLD.view;
    let inland = 0;
    for (let y = 1; y < view.h - 1; y += 1) {
      for (let x = 1; x < view.w - 1; x += 1) {
        if (tileAt(view, x, y) !== TileCode.WATER) continue;
        // EIGHT-WAY, because that is how the river was carved: the downhill
        // walk takes diagonal steps, so a four-way check reads every diagonal
        // as a break and reports a perfectly continuous river as 31 puddles.
        const wet = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ].some(([dx, dy]) => {
          const t = tileAt(view, x + (dx ?? 0), y + (dy ?? 0));
          return t === TileCode.WATER || t === TileCode.DEEPWATER;
        });
        if (!wet) inland += 1;
      }
    }
    expect(inland).toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY REGION NAME IS A PROMISE ABOUT WHAT IS UNDERFOOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The overworld announces these by name as you cross them — *"You come to the
   * Long Strand."* — and that line is the only thing most of the map ever says
   * to a player. A region called a WOOD with no trees in it, or a STRAND with no
   * shore, is a sentence the game prints about country it did not draw.
   *
   * ═══ THE TEST BELOW ALREADY BELIEVED THIS, FOR ONE REGION OUT OF TWELVE ═══
   * *"has a real mountain range rather than scattered rocks"* is exactly this
   * argument, applied to the Kettle Range and nowhere else. It was right; it was
   * just eleven regions short. MEASURED when this was written (`tools/world.mjs`
   * prints the whole table): every promise below is kept, several of them
   * comfortably.
   *
   * ═══ ONLY THE UNAMBIGUOUS ONES ═══
   * Two regions are deliberately absent because their names do not name a
   * terrain and a threshold would be invention rather than a guard: **the Cold
   * Furrows** (ploughed country by name, and drawn as woodland and plains) and
   * **Ashwick Reach** (a "reach" is an approach, not a surface). Those are named
   * for what happened there or what they lead to, and a test that demanded soil
   * of them would be asserting a reading rather than a rule.
   *
   * THE SEDGE USED TO BE A THIRD, and the redesign earned it a place: v1 put no
   * bog in it whatsoever, v2 makes it 62% mire, and a sedge is a wetland plant.
   *
   * THE FLOORS ARE WELL UNDER THE MEASURED VALUES, on purpose. This exists to
   * catch a region being renamed, moved, or drained of the thing it is named
   * for — not to freeze a generator whose output legitimately drifts by a few
   * per cent when anything upstream of it changes.
   */
  const PROMISES: readonly {
    readonly region: string;
    readonly word: string;
    readonly tiles: readonly TileCode[];
    readonly atLeast: number;
  }[] = [
    { region: 'the Saintswood', word: 'wood', tiles: [TileCode.TREES], atLeast: 0.2 },
    { region: 'the Blackwater Wood', word: 'wood', tiles: [TileCode.TREES], atLeast: 0.3 },
    {
      region: 'the Kettle Range',
      word: 'range',
      tiles: [TileCode.MOUNTAIN, TileCode.CRAG],
      atLeast: 0.5,
    },
    { region: 'the Long Strand', word: 'strand', tiles: [TileCode.SHORE], atLeast: 0.08 },
    {
      region: 'the Drowned Coast',
      word: 'coast',
      tiles: [TileCode.WATER, TileCode.DEEPWATER],
      atLeast: 0.5,
    },
    { region: 'the Grey Downs', word: 'downs', tiles: [TileCode.HILLS], atLeast: 0.3 },
    /**
     * WASTE IS OPEN UNCULTIVATED GROUND, AND v2 DRAWS IT AS PLAINS AND BOG.
     * v1 made it 70% heath and this asked for heath alone. The redesign puts
     * 61% plains, 19% mire and 5% heath there — the same idea in different
     * soil, so the promise names the idea rather than one tile. Measured 85%.
     */
    {
      region: 'the Bracken Waste',
      word: 'bracken',
      tiles: [TileCode.HEATH, TileCode.PLAINS, TileCode.MIRE],
      atLeast: 0.5,
    },
    /**
     * A FLAT IS FLAT COUNTRY, NOT SPECIFICALLY GRASS. v1 laid 52% plains here
     * and v2 lays 51% heath with 10% plains. Heath is as flat as grass is;
     * demanding the one tile would fail a region that kept its whole meaning.
     * Measured 61%.
     */
    {
      region: 'Kettleflat',
      word: 'flat',
      tiles: [TileCode.PLAINS, TileCode.HEATH],
      atLeast: 0.4,
    },
    /**
     * ═══ AND ONE THE REDESIGN EARNED THAT v1 COULD NOT CLAIM ═══
     * A sedge is a wetland plant. v1's Sedge was 41% plains and 21% hills with
     * no bog in it at all, which is why it sat in the excluded list below as a
     * name that did not name a surface. v2 draws it 62% MIRE. The promise is
     * real now, so it is kept.
     */
    { region: 'the Sedge', word: 'wetland', tiles: [TileCode.MIRE], atLeast: 0.4 },
    { region: 'Alderbrook Common', word: 'common', tiles: [TileCode.PLAINS], atLeast: 0.3 },
  ];

  it.each(PROMISES)('$region is actually $word', ({ region, tiles, atLeast }) => {
    const anchor = (OVERWORLD.regions ?? []).find((r) => r.name === region);
    // THE SETUP FIRST. A renamed or deleted region must fail as "there is no
    // such country" rather than as a share of zero, which reads like a terrain
    // bug and is not one.
    expect(anchor, `no region named ${region} — was it renamed?`).toBeDefined();
    if (anchor === undefined) return;

    /**
     * COUNTED OVER THE REGION'S OWN CELLS, NOT A BOUNDING BOX.
     *
     * This walked `bounds.x0..x1` back when country was rectangles. The
     * redesigned moor draws its regions per cell and the boxes overlap so
     * heavily that one spans x 5 to 157 — a box scan would measure most of the
     * map and call the answer one region's terrain.
     */
    const want = new Set<number>(tiles);
    let matching = 0;
    let cells = 0;
    for (let y = 0; y < OVERWORLD.view.h; y += 1) {
      for (let x = 0; x < OVERWORLD.view.w; x += 1) {
        if (regionAt(x, y) !== region) continue;
        cells += 1;
        if (want.has(tileAt(OVERWORLD.view, x, y))) matching += 1;
      }
    }
    expect(cells, `${region} covers no cells at all`).toBeGreaterThan(0);
    const share = matching / cells;
    expect(
      share,
      `${region} is ${(share * 100).toFixed(1)}% of what it is named for, wanted at least ${(atLeast * 100).toFixed(0)}%`,
    ).toBeGreaterThanOrEqual(atLeast);
  });

  it('has a real mountain range rather than scattered rocks', () => {
    // A range is the longest continuous run of one tile in the game, and it is
    // what makes the north-west a barrier instead of scenery. Counted rather
    // than eyeballed so thinning it out is a test failure.
    const peaks = OVERWORLD.view.tiles.filter((t) => t === TileCode.MOUNTAIN).length;
    expect(peaks).toBeGreaterThan(700);
  });
});

describe('every settlement can be reached on foot', () => {
  const reach = reachableFrom(OVERWORLD.view, ALDERBROOK);

  it('places all seventeen sites, three hidden and one on another map', () => {
    /**
     * THIRTEEN OF THESE ARE ON YOUR MAP FROM THE FIRST FRAME. The last three are
     * `SiteDef.hidden` and appear only once your own fog holds their cell — see
     * the note on the K/V/Z glyphs in shared/level.ts.
     *
     * THE THREE COST THE MAP NOTHING, WHICH IS THE DESIGN CONSTRAINT AND IS
     * PROVED BY THE TEST ABOVE RATHER THAN BY THIS ONE: each new glyph maps to
     * the SAME TileCode as the character it replaced (K was h, V was p, Z was
     * s), so no cell changed walkability or sight, and `reach.size === 9327`
     * held unchanged when they landed.
     *
     * AND THE SEVENTEENTH IS NOT A PLACE ON THIS MAP AT ALL. `site:redaction`
     * is a door onto a second overworld — the same moor with a sixth of it
     * taken out — and it is in this list because on THIS side it is a glyph
     * like any other. It obeys the same constraint as the hidden three and for
     * the same reason: `E` carries the TileCode of the `h` it replaced, so the
     * count below moved and `reach.size === 9327` did not.
     */
    expect([...OVERWORLD.sites.values()].sort()).toEqual([
      'site:alderbrook',
      'site:ashwick_row',
      'site:barrow_end',
      'site:blackwood_outskirts',
      'site:cairnfoot',
      'site:drowned_chapel',
      'site:gearford_ward',
      'site:glass_archive',
      'site:hollow_mine',
      'site:outer_index',
      'site:redaction',
      'site:saints_rest',
      'site:the_weir',
      'site:threadneedle_row',
      'site:underworks',
      'site:watchers_altar',
      'site:wayfarers_camp',
    ]);
  });

  it.each([...OVERWORLD.sites.entries()])('%s (%s) is walkable and reachable', (key, siteId) => {
    const parts = key.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    // Walkable first: a site stamped onto a mountain is unreachable for a reason
    // the flood fill would report identically to a sealed road, and the two want
    // different fixes.
    expect(canWalk(OVERWORLD.view, x, y), `${siteId} sits on solid terrain`).toBe(true);
    expect(reach.has(key), `${siteId} is sealed off from Alderbrook`).toBe(true);
  });

  it('maroons no walkable cell anywhere in the region', () => {
    // The strongest statement available: not merely "the sites are reachable"
    // but "there is exactly one connected walkable region". A pocket is not
    // something a player sees, but it IS a lie in the data — the pathfinder will
    // happily route toward a cell no route reaches.
    const marooned: string[] = [];
    for (let y = 0; y < OVERWORLD.view.h; y += 1) {
      for (let x = 0; x < OVERWORLD.view.w; x += 1) {
        if (canWalk(OVERWORLD.view, x, y) && !reach.has(`${x},${y}`)) {
          marooned.push(`${x},${y}`);
        }
      }
    }
    expect(marooned).toEqual([]);
  });

  it('stays inside the pathfinder budget', () => {
    // travel.ts caps A* at `w * h + 1` expansions. With a closed set, expansions
    // are bounded by the reachable cell count, so this is the number that
    // decides whether "walk to the Glass Archive" answers 'no route to that
    // tile' — a lie about the map, and the one divergence a player notices.
    // 8,380 walkable cells, every one of them reachable from the gate. v1 held
    // 9,327; the redesigned moor is a smaller, more irregular landmass with real
    // coastline, and the number moved with it rather than drifting.
    expect(reach.size).toBe(8380);
    expect(reach.size).toBeLessThan(OVERWORLD.view.w * OVERWORLD.view.h + 1);
  });

  it('routes clear across the region under the travel budget', () => {
    // THE REGRESSION THIS FILE EXISTS FOR: a long legal journey across the whole
    // region must return a route rather than null. At 170x100 this is also the
    // test that the pathfinder's `w * h` ceiling is still enough.
    const route = findPath(
      // The Outer Index in the far west to Ashwick Alchemy Row in the far east —
      // the longest legal journey on the redesigned moor. v1 crossed 51,31 to
      // 149,78; both of those are open water now.
      { x: 16, y: 61 },
      { x: 151, y: 75 },
      (x, y) => canWalk(OVERWORLD.view, x, y),
      { maxNodes: OVERWORLD.view.w * OVERWORLD.view.h + 1 },
    );
    // `[]` and null are different answers (path.ts:303-311): [] means "you are
    // already there", null means "no route". Neither is acceptable here.
    expect(route).not.toBeNull();
    // Measured at 138 steps against a straight line of 135.
    expect(route?.length ?? 0).toBeGreaterThanOrEqual(120);
  });

  it('walks AROUND the range rather than through it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THE ASSERTION ABOVE DOES NOT CATCH, AND WHY THIS ONE EXISTS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * That route is exactly 98 steps long and its Chebyshev distance is exactly
     * 98 — the two points have clear ground the whole way between them, so
     * `>= 98` is the straight-line floor and NOTHING can go below it. It would
     * pass unchanged on a map with no terrain on it at all. It is a real test of
     * the pathfinder's BUDGET and no test whatever of the map's SHAPE.
     *
     * This is the shape. Blackwood Outskirts to the Glass Archive is 68 tiles as
     * the crow flies and 158 on foot, because the Archive sits behind high
     * ground with one way round it — the single largest terrain-forced detour
     * between any two sites on the moor, and the only kind of assertion that
     * fails the moment somebody flattens a range or opens a pass.
     *
     * Measured rather than chosen: 45 of the 78 site pairs have NO detour at
     * all, which is the honest state of this map and the reason the one that
     * does is worth pinning.
     */
    /**
     * GEARFORD TO THE UNDERWORKS, WHICH THE SPINE STANDS BETWEEN.
     *
     * v1 walked Blackwood to the Glass Archive and asked for twice the straight
     * line. Both places moved, and on the redesigned moor that pair is a
     * straight shot — 109 steps against a 109-step line — because the range is
     * no longer between them.
     *
     * Measured across every pair of sites, this is the sharpest detour on the
     * map: 24 tiles apart and 116 steps of walking, a ratio of 4.8. The two
     * surface passes and the collapsed Gearford cut are exactly what makes it
     * so, which is the redesign's own headline and now has a test behind it.
     */
    const blackwood = { x: 84, y: 20 };
    const archive = { x: 94, y: 44 };
    const straight = Math.max(Math.abs(blackwood.x - archive.x), Math.abs(blackwood.y - archive.y));

    const route = findPath(blackwood, archive, (x, y) => canWalk(OVERWORLD.view, x, y), {
      maxNodes: OVERWORLD.view.w * OVERWORLD.view.h + 1,
    });

    expect(route).not.toBeNull();
    // MORE THAN TWICE the straight line. On an empty field this is `straight`.
    expect(route?.length ?? 0).toBeGreaterThan(straight * 2);
  });
});

describe('water is the reason tiles have two predicates', () => {
  it('is solid to a body and transparent to an eye', () => {
    for (const wet of [TileCode.WATER, TileCode.DEEPWATER]) {
      expect(isWalkable(wet)).toBe(false);
      expect(blocksSight(wet)).toBe(false);
    }
  });

  it('has a river, a sea and bridges across the water', () => {
    const codes = new Set(OVERWORLD.view.tiles);
    expect(codes.has(TileCode.WATER)).toBe(true);
    expect(codes.has(TileCode.DEEPWATER)).toBe(true);
    expect(codes.has(TileCode.BRIDGE)).toBe(true);
  });
});

describe('the two maps are independent objects', () => {
  it('hands out a fresh tile array per call', () => {
    // Same argument makeTestLevel makes: one realm changing its map must never
    // appear in another's. With realms this stopped being hypothetical.
    const a = makeOverworld();
    const b = makeOverworld();
    expect(a.view.tiles).not.toBe(b.view.tiles);
    a.view.tiles[0] = TileCode.PLAINS;
    expect(b.view.tiles[0]).toBe(TileCode.ERASED);
  });
});
