import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SITE_PALETTE,
  SITE_MAP_SIZE,
  SiteShape,
  makeSiteMap,
} from '../../src/shared/sitemap.ts';
import { RealmKind, SITES } from '../../src/server/world/realms.ts';
import { VAULT_TURNS, turnVault } from '../../src/shared/vault.ts';
import type { Vault } from '../../src/shared/vault.ts';
import { VAULTS_BY_SHAPE } from '../../src/shared/vaults.ts';
import { TileCode, blocksSight, isWalkable } from '../../src/shared/protocol.ts';
import type { SitePalette } from '../../src/shared/sitemap.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A ROOM MAY BE REPAINTED. IT MAY NOT BE RESHAPED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen destinations were one destination with thirteen doors; `SiteShape`
 * made them four; they were still every one of them the same grey box, because
 * every interior in this game is built out of exactly two tile codes and the
 * player has been looking at those two codes since M1.
 *
 * The palette is a POST-PASS over the finished grid rather than a change to the
 * carvers, and this file is the argument for why that is safe: the generator
 * runs unchanged, draws the same numbers off the same seeded stream in the same
 * order, and produces the same walkable cells BIT FOR BIT. Only the two codes it
 * wrote are renamed on the way out.
 *
 * There was no test over `src/shared/sitemap.ts` at all before this file — the
 * generator behind all thirteen doors, and behind every door added later, had
 * none.
 */

const PALETTES: readonly (readonly [string, SitePalette])[] = [
  ['paving/civic', { floor: TileCode.PAVING, wall: TileCode.CIVIC }],
  ['cobble/terrace', { floor: TileCode.COBBLE, wall: TileCode.TERRACE }],
  ['soot/crag', { floor: TileCode.SOOT, wall: TileCode.CRAG }],
  ['heath/trees', { floor: TileCode.HEATH, wall: TileCode.TREES }],
  ['paving/erased', { floor: TileCode.PAVING, wall: TileCode.ERASED }],
  ['shore/terrace', { floor: TileCode.SHORE, wall: TileCode.TERRACE }],
];

const SHAPES = [SiteShape.Town, SiteShape.Cave, SiteShape.Ruin, SiteShape.Works] as const;

/** Every index a body may stand on, as a set the two builds can be compared by. */
function walkableSet(tiles: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < tiles.length; i += 1) if (isWalkable(tiles[i] ?? TileCode.WALL)) out.add(i);
  return out;
}

describe('a palette repaints a floor without moving one wall', () => {
  for (const shape of SHAPES) {
    for (const [name, palette] of PALETTES) {
      it(`${shape} in ${name} is walkable in exactly the same cells`, () => {
        const seed = `sitemap-${shape}-${name}`;
        const plain = makeSiteMap(seed, shape);
        const painted = makeSiteMap(seed, shape, palette);

        // THE WHOLE SAFETY ARGUMENT, as one comparison. A room that became
        // unreachable by being repainted would be a party stuck behind a door.
        expect(walkableSet(painted.view.tiles)).toEqual(walkableSet(plain.view.tiles));
        // And sight moves with it, because both codes are drawn from the same
        // two sets — a floor an eye cannot cross would be worse than a wall.
        expect(painted.view.tiles.map((c) => blocksSight(c))).toEqual(
          plain.view.tiles.map((c) => blocksSight(c)),
        );
      });
    }
  }

  it('puts the threshold where the plain build put it', () => {
    // `leaveRealm` treats a spawn tile as the door. A palette that moved one
    // would be a site you can enter and not leave.
    for (const shape of SHAPES) {
      const plain = makeSiteMap('threshold', shape);
      const painted = makeSiteMap('threshold', shape, PALETTES[0]?.[1] ?? DEFAULT_SITE_PALETTE);
      expect(painted.spawns).toEqual(plain.spawns);
    }
  });

  it('writes only the two codes it was given', () => {
    // The post-pass sees FLOOR and WALL and nothing else, because `blank()`
    // fills with WALL and `put` only ever writes those two. A third code
    // appearing in a finished grid would be a bug in the carvers, and this is
    // where it surfaces rather than as a tile nobody can name on a live map.
    const palette = { floor: TileCode.SOOT, wall: TileCode.CRAG };
    const map = makeSiteMap('two-codes', SiteShape.Cave, palette);
    expect(new Set(map.view.tiles)).toEqual(new Set<number>([palette.floor, palette.wall]));
  });

  it('is unchanged, exactly, when no palette is named', () => {
    // Every caller that predates this and every test fixture takes this path.
    for (const shape of SHAPES) {
      const before = makeSiteMap('default', shape);
      const after = makeSiteMap('default', shape, DEFAULT_SITE_PALETTE);
      expect(after.view.tiles).toEqual(before.view.tiles);
      expect(new Set(before.view.tiles)).toEqual(new Set<number>([TileCode.FLOOR, TileCode.WALL]));
    }
  });

  it('builds the size it says it builds', () => {
    const map = makeSiteMap('size', SiteShape.Town);
    expect(map.view.w).toBe(SITE_MAP_SIZE.w);
    expect(map.view.h).toBe(SITE_MAP_SIZE.h);
    expect(map.view.tiles).toHaveLength(SITE_MAP_SIZE.w * SITE_MAP_SIZE.h);
  });
});

describe('every shipped site is painted with a legal pair', () => {
  /**
   * THE RULE BOTH HALVES CARRY, asserted over the real table rather than over
   * the six samples above: a floor a body cannot stand on, or a wall it can walk
   * through, would change where people may go — which is the one thing the
   * post-pass exists to promise it cannot do.
   *
   * It runs `map()` because `SiteDef` deliberately exposes a closure and not the
   * palette: a site's floor is the site's business, and the registry's job is to
   * hand back a map.
   */
  for (const [id, site] of SITES) {
    /**
     * EXCEPT THE ONE SITE THAT IS NOT A ROOM.
     *
     * Every other entry in `SITES` answers `map()` with a generated floor in
     * two colours, which is what makes the assertion below meaningful. The
     * Redaction answers with a whole second overworld — nineteen tile codes,
     * a coastline, mountains and a forest belt — so "exactly two codes, one
     * walkable and one not" is not a weaker claim about it, it is a claim about
     * a different kind of object.
     *
     * SKIPPED BY KIND RATHER THAN BY ID, so the next authored map is skipped
     * too and nobody has to remember to add it here. Its own soundness — that
     * every door on it can be reached from where you land — is
     * `test/shared/redaction.test.ts`, which is the equivalent promise for a
     * map you cannot paint in two colours.
     */
    if (site.kind === RealmKind.Overworld) continue;
    it(`${id} opens onto ground you can stand on, behind walls you cannot`, () => {
      /**
       * TWO CODES, OR THREE FOR A TOWN. This used to demand exactly two, which
       * was right while a site was floor-and-wall. A town now paints its
       * BOUNDARY separately from its BLOCKS — measured on Alderbrook, 732
       * PAVING streets, 164 CIVIC buildings and a 124-cell TOWN_WALL ring —
       * because drawing the edge of the world in the same code as a house is
       * what made a player unable to tell they were standing in a town.
       *
       * THE CLAIM IS UNCHANGED AND IS THE PART THAT MATTERS: exactly one code
       * you can stand on, and every other code solid AND opaque. A third code
       * that was walkable, or that you could see through, would still fail.
       */
      const codes = new Set(site.map(`palette-check-${id}`).view.tiles);
      expect(codes.size).toBeGreaterThanOrEqual(2);
      expect(codes.size).toBeLessThanOrEqual(3);

      const walkable = [...codes].filter((c) => isWalkable(c));
      expect(walkable, `${id} has ${String(walkable.length)} kinds of ground`).toHaveLength(1);
      for (const solid of [...codes].filter((c) => !isWalkable(c))) {
        expect(blocksSight(solid), `${id} has a solid code you can see through`).toBe(true);
      }
    });
  }

  it('gives no two neighbouring towns the same walls', () => {
    /**
     * NOT DECORATION — it is the entire point of the commit. Alderbrook,
     * Threadneedle Row, Ashwick Row and Saint's Rest are four settlements a
     * player walks between in one session, and four identical grey rooms is what
     * made thirteen destinations read as one. Asserted so the next site added
     * has to make a choice rather than inherit a default.
     */
    const towns = [
      'site:alderbrook',
      'site:threadneedle_row',
      'site:ashwick_row',
      'site:saints_rest',
    ];
    /**
     * THE BUILDINGS, NOT THE RING. Every town now shares `TOWN_WALL` for its
     * boundary — a wall around a place is the same idea everywhere — so "the
     * first solid code" stopped being the one that tells two towns apart.
     *
     * That distinction is exactly what a first attempt at the boundary got
     * backwards: it gave the blocks a roof chosen by marker tier, which made
     * Threadneedle, Ashwick and Saint's Rest identical inside, and this test is
     * what caught it. Asking for the BLOCK code keeps it doing that job.
     */
    const blocks = towns.map((id) => {
      const codes = [...new Set(SITES.get(id)?.map(`wall-check-${id}`).view.tiles ?? [])];
      return codes.find((c) => !isWalkable(c) && c !== TileCode.TOWN_WALL);
    });
    expect(new Set(blocks).size).toBeGreaterThan(1);
  });

  it('draws the edge of a town in a different code from its buildings', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "HOW HARD IT IS TO TELL THE AREA IM AT IS A TOWN" — A PLAYER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Measured on Alderbrook before this: 1,020 cells, exactly two codes, 732
     * PAVING and 288 CIVIC — and the ring around the town was THE SAME CODE as
     * the blocks inside it. The streets and the blocks are really there and the
     * layout is a real town; a player standing in the middle of it simply could
     * not tell a building from the edge of the world.
     *
     * Three things are needed to read a place as a town, and now all three are
     * distinct: a street you walk on, a building you walk round, and a boundary
     * that says the town stops here.
     *
     * PINNED SEPARATELY from the size band above, which permits two codes so
     * that a cave stays a cave. Without this, a town quietly losing its ring
     * would pass everything.
     */
    /**
     * THE FOUR TOWN-SHAPED SITES, and `site:wayfarers_camp` is deliberately not
     * among them: it is a `SiteShape.Ruin`, and a ruin's rim and a ruin's rubble
     * are the same rubble. A first version of this test asked it the town
     * question and it answered honestly with one solid code.
     */
    for (const id of [
      'site:alderbrook',
      'site:threadneedle_row',
      'site:ashwick_row',
      'site:saints_rest',
    ]) {
      const view = SITES.get(id)?.map(`edge-check-${id}`).view;
      if (view === undefined) throw new Error(`no such site ${id}`);

      const solid = new Set([...new Set(view.tiles)].filter((c) => !isWalkable(c)));
      expect(solid.size, `${id} draws its edge and its buildings the same`).toBe(2);

      // And the ring really is the ring: the corner cell is the boundary code,
      // and it is not what the blocks are made of.
      const corner = view.tiles[0];
      const middleBlocks = [...solid].filter((c) => c !== corner);
      expect(corner).toBe(TileCode.TOWN_WALL);
      expect(middleBlocks).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// VAULTS — the drawn rooms stamped into the noise (shared/vault.ts)
// ---------------------------------------------------------------------------

describe('a stamped room never seals the floor it was stamped into', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE PROPERTY A VAULT COULD PLAUSIBLY BREAK.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A vault writes WALLS into a floor that has already been generated, so the
   * failure it can cause is not a wrong tile — it is a floor cut in two, or a
   * threshold walled in, and either one is a delve a party cannot play. The
   * arrangement that prevents it is an ORDER: the stamp runs before `connect`,
   * which already exists to find orphaned floor and dig a corridor to it.
   *
   * SWEPT ACROSS SEEDS RATHER THAN ASSERTED ON ONE, because placement depends
   * on the shape of the floor that happens to generate. A single seed proves a
   * single map; the bug this is about is one that appears on the unlucky one.
   */
  for (const shape of SHAPES) {
    it(`leaves every floor tile reachable from the threshold in a ${shape}`, () => {
      for (let n = 0; n < 40; n += 1) {
        const seed = `vault-reach-${shape}-${String(n)}`;
        const map = makeSiteMap(seed, shape);
        const { w, h, tiles } = map.view;
        const spawn = map.spawns[0];
        expect(spawn, `${seed}: no threshold`).toBeDefined();
        if (spawn === undefined) return;

        expect(
          isWalkable(tiles[spawn.y * w + spawn.x] ?? TileCode.WALL),
          `${seed}: the threshold itself was walled in`,
        ).toBe(true);

        const seen = new Set<number>([spawn.y * w + spawn.x]);
        const stack = [spawn.y * w + spawn.x];
        while (stack.length > 0) {
          const idx = stack.pop();
          if (idx === undefined) break;
          const x = idx % w;
          const y = (idx - x) / w;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n2 = ny * w + nx;
            if (seen.has(n2)) continue;
            if (!isWalkable(tiles[n2] ?? TileCode.WALL)) continue;
            seen.add(n2);
            stack.push(n2);
          }
        }

        const walkable = walkableSet(tiles);
        const stranded = [...walkable].filter((i) => !seen.has(i));
        expect(
          stranded.length,
          `${seed}: ${String(stranded.length)} floor tiles are cut off from the threshold`,
        ).toBe(0);
      }
    });
  }

  it('is the same map for the same seed, vault and all', () => {
    // A vault drawn from an unseeded number would make two players in one
    // instance disagree about where the walls are. `docs/tome-port.md`'s
    // determinism contract is that a seed is the whole map.
    for (const shape of SHAPES) {
      const once = makeSiteMap(`vault-determinism-${shape}`, shape);
      const twice = makeSiteMap(`vault-determinism-${shape}`, shape);
      expect(once.view.tiles).toEqual(twice.view.tiles);
    }
  });

  it('actually puts EACH drawn room into the floor', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE OTHER TESTS ALL PASS WITH ZERO VAULTS PLACED, AND SO DID THIS ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Reachability and determinism are properties of a map with no rooms in it
     * at all, so on their own they would sign off a feature that had quietly
     * stopped running. This was written to catch that — and the FIRST version
     * of it did not, because it asked whether ANY vault matched anywhere, and
     * the smallest one is eight wall cells in an L that generated noise
     * produces by accident. Verified by mutation: with the stamp removed, it
     * passed.
     *
     * So every room is required SEPARATELY. The large ones cannot appear by
     * chance — a seven-by-seven with a specific interior is not a thing a cave
     * generator stumbles into — and they are what makes the assertion mean
     * "the stamp ran" rather than "the noise was noisy".
     *
     * SOME seed rather than every seed: `connect` may dig a corridor straight
     * through a room it could not otherwise reach, which is correct and
     * destroys the pattern. One survivor in forty is proof; zero is not.
     */
    const found = (shape: SiteShape, vault: Vault): number => {
      let intact = 0;
      for (let n = 0; n < 40; n += 1) {
        const map = makeSiteMap(`vault-present-${shape}-${String(n)}`, shape);
        const { w, h, tiles } = map.view;
        const hit = VAULT_TURNS.some((turn) => {
          const shaped = turnVault(vault, turn);
          for (let y = 0; y + shaped.h <= h; y += 1) {
            for (let x = 0; x + shaped.w <= w; x += 1) {
              let all = true;
              for (let vy = 0; vy < shaped.h && all; vy += 1) {
                for (let vx = 0; vx < shaped.w && all; vx += 1) {
                  const want = shaped.tiles[vy * shaped.w + vx];
                  if (want === null || want === undefined) continue;
                  if (tiles[(y + vy) * w + (x + vx)] !== want) all = false;
                }
              }
              if (all) return true;
            }
          }
          return false;
        });
        if (hit) intact += 1;
      }
      return intact;
    };

    for (const shape of SHAPES) {
      for (const vault of VAULTS_BY_SHAPE[shape] ?? []) {
        expect(
          found(shape, vault),
          `'${vault.id}' never survived into a ${shape} in forty seeds`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
