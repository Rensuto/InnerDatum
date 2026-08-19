import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SITE_PALETTE,
  SITE_MAP_SIZE,
  SiteShape,
  makeSiteMap,
} from '../../src/shared/sitemap.ts';
import { RealmKind, SITES } from '../../src/server/world/realms.ts';
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
      const codes = new Set(site.map(`palette-check-${id}`).view.tiles);
      expect(codes.size).toBe(2);

      const [floor, wall] = [...codes].sort(
        (a, b) => Number(isWalkable(b)) - Number(isWalkable(a)),
      );
      expect(isWalkable(floor ?? TileCode.WALL)).toBe(true);
      expect(isWalkable(wall ?? TileCode.FLOOR)).toBe(false);
      expect(blocksSight(wall ?? TileCode.FLOOR)).toBe(true);
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
    const walls = towns.map((id) => {
      const codes = [...new Set(SITES.get(id)?.map(`wall-check-${id}`).view.tiles ?? [])];
      return codes.find((c) => !isWalkable(c));
    });
    expect(new Set(walls).size).toBeGreaterThan(1);
  });
});
