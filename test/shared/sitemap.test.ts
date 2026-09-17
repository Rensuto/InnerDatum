import { describe, expect, it } from 'vitest';

import {
  CAVERN_ORC_BREEDING_PIT,
  ROOMER_RUINS_KOR_PUL,
  keepTrying,
  newLevel,
} from '../../src/shared/mapgen/level.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import {
  DOOR_CLEARANCE,
  DEFAULT_SITE_PALETTE,
  SITE_MAP_SIZE,
  SiteShape,
  makeSiteMap,
} from '../../src/shared/sitemap.ts';
import { RealmKind, SITES } from '../../src/server/world/realms.ts';
import { ALL_VAULTS, VAULTS_BY_SHAPE } from '../../src/shared/vaults.ts';
import { turnVault } from '../../src/shared/vault.ts';
import type { VaultTurn } from '../../src/shared/vault.ts';
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

/**
 * The shapes that finish by carving from the threshold to anything stranded, and
 * so owe it every floor tile. A works is ToME's Roomer and a cave ToME's Cavern;
 * neither repairs anything, and each is held to upstream's rules instead — see
 * their own tests below.
 */
const CARVED = SHAPES.filter((shape) => shape !== SiteShape.Works && shape !== SiteShape.Cave);

/**
 * Every index a body can get to from `from`, as upstream's level check asks it:
 * EIGHT neighbours, and a shut door passable unless `doorsShut` says otherwise
 * (`engine/Astar.lua:113-193`). Written out here rather than imported from
 * `mapgen/connectivity.ts`, so the rule cannot certify itself.
 */
function reach8(map: AuthoredMap, from: TileXY, doorsShut = false): Set<number> {
  const { w, h, tiles } = map.view;
  const seen = new Set<number>([from.y * w + from.x]);
  const queue = [from.y * w + from.x];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head] ?? 0;
    const x = at % w;
    const y = (at - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(ny * w + nx)) continue;
        const code = tiles[ny * w + nx] ?? TileCode.WALL;
        if (!isWalkable(code) && (doorsShut || code !== TileCode.DOOR)) continue;
        seen.add(ny * w + nx);
        queue.push(ny * w + nx);
      }
    }
  }
  return seen;
}

/** A works' drawn rooms: `vaults` minus the room functions' `room:` records. */
function drawnRooms(map: AuthoredMap): NonNullable<AuthoredMap['vaults']> {
  return (map.vaults ?? []).filter((v) => !v.id.startsWith('room:'));
}

/**
 * Every room a works placed. `rooms` is the rooms a lit roll lights, which a
 * lesser vault is not (`rooms/lesser_vault.lua:90`), so its drawn rooms are
 * counted from `vaults`.
 */
function roomsPlaced(map: AuthoredMap): number {
  return (map.rooms?.length ?? 0) + drawnRooms(map).length;
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

  it('writes only the codes it was given, plus any door a vault brought', () => {
    /**
     * The post-pass sees FLOOR and WALL from the carvers and nothing else,
     * because `blank()` fills with WALL and `put` only ever writes those two. A
     * fourth code appearing here would be a bug, and this is where it surfaces
     * rather than as a tile nobody can name on a live map.
     *
     * ═══ A DOOR IS THE THIRD, AND IT IS ALLOWED THROUGH ON PURPOSE ═══
     * The vault stamp runs BEFORE the repaint and three rooms carry a `+`. This
     * test read `[floor, wall]` exactly, and it is what caught the repaint
     * painting every one of those doors into `roof` — sealing the room the door
     * was the only way into. So the set is widened by exactly one code and no
     * more: a door survives a repaint because it is neither the ground nor the
     * building.
     */
    const palette = { floor: TileCode.SOOT, wall: TileCode.CRAG };
    const map = makeSiteMap('two-codes', SiteShape.Cave, palette);
    const written = new Set(map.view.tiles);
    written.delete(TileCode.DOOR);
    expect(written).toEqual(new Set<number>([palette.floor, palette.wall]));
    // AND THE PALETTE NEVER BECAME THE DOOR'S BUSINESS: an OPEN door cannot
    // appear on a freshly generated floor, because nothing has walked into one.
    expect(map.view.tiles).not.toContain(TileCode.DOOR_OPEN);
  });

  it('is unchanged, exactly, when no palette is named', () => {
    // Every caller that predates this and every test fixture takes this path.
    for (const shape of SHAPES) {
      const before = makeSiteMap('default', shape);
      const after = makeSiteMap('default', shape, DEFAULT_SITE_PALETTE);
      expect(after.view.tiles).toEqual(before.view.tiles);
      // Plus a door, where the shape rolled one of the three rooms that has
      // one — see the sibling test above for why that is widened rather than
      // asserted away.
      const written = new Set(before.view.tiles);
      written.delete(TileCode.DOOR);
      expect(written).toEqual(new Set<number>([TileCode.FLOOR, TileCode.WALL]));
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
  for (const shape of CARVED) {
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
            /**
             * A DOOR IS A WAY THROUGH, even though `isWalkable` says no.
             *
             * That predicate answers "may a body stand here", and a shut door
             * stops one where it stands. REACHABILITY is a different question:
             * the player opens it and walks on, so a room whose only mouth is a
             * door is reached rather than stranded.
             *
             * This guard reported three stranded tiles the day the works
             * generator started hanging doors, and it was right that something
             * was wrong — `connect` was asking with the same wrong predicate and
             * carving a second way into every room with a door on it.
             */
            const code = tiles[n2] ?? TileCode.WALL;
            if (!isWalkable(code) && code !== TileCode.DOOR) continue;
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

  it('joins a works the way upstream certifies a level: stairs, and every drawn room', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NOT EVERY TILE — A ROOMER LEVEL NEVER PROMISED THAT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The carved shapes above owe every floor tile to the threshold because
     * `connect` digs to whatever they stranded. A works is ToME's Roomer, whose
     * tunnels never carve inside a room, so a room they never opened stays shut
     * — in ToME too. What upstream refuses, and regenerates, is a level whose up
     * stair cannot reach the down stair, or whose vault entrance cannot reach
     * the up stair (`engine/Zone.lua:1131-1158`). Those are the promises, and
     * `content/delve.ts` places nothing on the ground they do not cover.
     */
    let doors = 0;
    for (let n = 0; n < 40; n += 1) {
      const seed = `vault-reach-works-${String(n)}`;
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, tiles } = map.view;
      const up = map.spawns[0];
      const { down } = map;
      if (up === undefined || down === undefined) throw new Error(`${seed}: a stair is missing`);
      expect(isWalkable(tiles[up.y * w + up.x] ?? TileCode.WALL), `${seed}: up`).toBe(true);
      expect(isWalkable(tiles[down.y * w + down.x] ?? TileCode.WALL), `${seed}: down`).toBe(true);

      const reached = reach8(map, up);
      expect(reached.has(down.y * w + down.x), `${seed}: the stairs are not joined`).toBe(true);
      for (const room of drawnRooms(map)) {
        // A drawn room's entrance is its door where it has one
        // (`rooms/lesser_vault.lua:116-119`), and every door here is one.
        for (let y = room.at.y; y < room.at.y + room.h; y += 1) {
          for (let x = room.at.x; x < room.at.x + room.w; x += 1) {
            if (tiles[y * w + x] !== TileCode.DOOR) continue;
            doors += 1;
            expect(
              reached.has(y * w + x),
              `${seed}: ${room.id}'s door at ${String(x)},${String(y)}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(doors, 'no drawn room with a door was rolled, so nothing was checked').toBeGreaterThan(
      3,
    );
  });

  it('makes rock of every cell a works` up stair cannot reach, and of nothing else', () => {
    /**
     * OUR RULE, NOT UPSTREAM'S (`shared/sitemap.ts`, `works`): nobody here can
     * dig, so ground the tunnels never opened would only ever be somewhere a
     * crowded arrival or a teleport strands a body. Those were measured seeds of
     * the realm's own: `outer_index` 1149 and 141 are mostly sealed, 869 and
     * `glass_archive` 1336 partly.
     */
    const seeds = [
      'inner-datum-m1:realm:site:outer_index:1149',
      'inner-datum-m1:realm:site:outer_index:141',
      'inner-datum-m1:realm:site:outer_index:869',
      'inner-datum-m1:realm:site:glass_archive:1336',
      ...Array.from({ length: 20 }, (_, n) => `seal-${String(n)}`),
    ];
    const palette = { floor: TileCode.PAVING, wall: TileCode.ERASED };
    const grid = {
      ...ROOMER_RUINS_KOR_PUL.map.grid,
      '.': palette.floor,
      '#': palette.wall,
      up: palette.floor,
      down: palette.floor,
    };
    let sealed = 0;
    for (const seed of seeds) {
      const map = makeSiteMap(seed, SiteShape.Works, palette);
      const up = map.spawns[0];
      if (up === undefined) throw new Error(`${seed}: no up stair`);
      const reached = reach8(map, up);
      map.view.tiles.forEach((code, i) => {
        if (!isWalkable(code) && code !== TileCode.DOOR) return;
        expect(reached.has(i), `${seed}: ${String(i % 50)},${String(Math.floor(i / 50))}`).toBe(
          true,
        );
      });

      // The level before: the same, but for walls where it had sealed ground.
      const level = keepTrying(
        { ...ROOMER_RUINS_KOR_PUL, map: { ...ROOMER_RUINS_KOR_PUL.map, grid } },
        seed,
        { level: 1, maxLevel: 1 },
      ).map;
      const before = reach8(level, up);
      level.view.tiles.forEach((code, i) => {
        const open = isWalkable(code) || code === TileCode.DOOR;
        if (open && !before.has(i)) {
          sealed += 1;
          expect(map.view.tiles[i], `${seed}: sealed ground left open`).toBe(palette.wall);
        } else {
          expect(map.view.tiles[i], `${seed}: ground a party can reach was changed`).toBe(code);
        }
      });
    }
    expect(sealed, 'precondition: none of these seeds had sealed ground').toBeGreaterThan(1000);
  });

  for (const shape of SHAPES.filter((s) => (VAULTS_BY_SHAPE[s] ?? []).length > 0)) {
    it(`never writes over the room it drew in a ${shape}`, () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * UPSTREAM'S TUNNELLER GOES AROUND A ROOM'S EDGE AND WRITES NONE OF IT.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `RoomsLoader.lua:814-817`. The repair corridor here used to run straight
       * through a drawn room and floor whatever it crossed, which is how a works
       * came to have a door standing in open ground: the corridor took the wall
       * on either side of it. Measured over eighty floors a shape, a drawn cell
       * was rewritten in 32 works rooms, 20 cave rooms and 5 ruin rooms.
       *
       * Every drawn cell, turned the way the room was laid, against the finished
       * floor. That also covers a door hung inside the room, which would replace
       * a floor cell.
       */
      let stamped = 0;
      for (let n = 0; n < 80; n += 1) {
        const seed = `vault-intact-${shape}-${String(n)}`;
        const map = makeSiteMap(seed, shape);
        const { w, tiles } = map.view;
        // A money vault is a room FUNCTION's geometry, not a drawing, and its wall
        // ring is one a tunnel may open (`rooms/money_vault.lua:26-28`).
        for (const placed of drawnRooms(map)) {
          const vault = ALL_VAULTS.find((v) => v.id === placed.id);
          if (vault === undefined) throw new Error(`${seed}: no room called ${placed.id}`);
          const drawn = turnVault(vault, placed.turn as VaultTurn);
          stamped += 1;
          for (let y = 0; y < drawn.h; y += 1) {
            for (let x = 0; x < drawn.w; x += 1) {
              const want = drawn.tiles[y * drawn.w + x];
              if (want === null || want === undefined) continue;
              const cx = placed.at.x + x;
              const cy = placed.at.y + y;
              expect(
                tiles[cy * w + cx],
                `${seed}: ${placed.id} was rewritten at ${String(cx)},${String(cy)}`,
              ).toBe(want);
            }
          }
        }
      }
      expect(stamped, 'no room was stamped, so nothing was checked').toBeGreaterThan(0);
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

  it('stamps exactly one drawn room per floor, and rolls which', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * MEASURED OFF THE GENERATOR'S OWN RECORD, NOT OFF THE TILES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Two earlier versions of this test read the finished map and asked whether
     * a room's exact pattern was in it. Both were wrong, in opposite directions,
     * and the numbers are worth keeping:
     *
     *   half_partition   40/40 in every shape — eight wall cells in an L is a
     *                    thing procedural noise produces by accident, so it
     *                    "passed" with the stamp removed entirely.
     *   sealed_shaft     0/40 in a works, 8/40 in a cave.
     *   filing_chamber   3/40 in a works, 17/40 in a ruin.
     *
     * The low numbers are not a bug: `connect` tunnels through a room it cannot
     * otherwise reach, which is correct and destroys the pattern. But it makes
     * "is the pattern there" a proxy that answers about the noise and about the
     * repair pass at once, and a test built on it passes or fails by which seeds
     * it happened to pick.
     *
     * `AuthoredMap.vaults` is the generator saying what it did.
     */
    for (const shape of CARVED) {
      const list = VAULTS_BY_SHAPE[shape] ?? [];
      const chosen: string[] = [];

      for (let n = 0; n < 40; n += 1) {
        const map = makeSiteMap(`vault-roll-${shape}-${String(n)}`, shape);
        const placed = map.vaults ?? [];
        expect(
          placed.length,
          `a ${shape} stamped ${String(placed.length)} rooms — the list is being stamped whole`,
        ).toBeLessThanOrEqual(1);
        for (const one of placed) {
          expect(
            list.some((vault) => vault.id === one.id),
            `a ${shape} stamped '${one.id}', which is not one of its rooms`,
          ).toBe(true);
          chosen.push(one.id);
        }
      }

      if (list.length === 0) {
        // A town has no rooms and must get none — a building among buildings is
        // noise with extra steps, which is why the list is empty rather than shared.
        expect(chosen, `a ${shape} has no rooms and got one anyway`).toEqual([]);
        continue;
      }

      expect(chosen.length, `no room was stamped into any ${shape} in forty seeds`).toBeGreaterThan(
        0,
      );
      if (list.length > 1) {
        expect(
          new Set(chosen).size,
          `every ${shape} got the same room: ${[...new Set(chosen)].join(', ')}`,
        ).toBeGreaterThan(1);
      }
    }
  });

  it("rolls the vaults of a works room by room, as Kor'Pul's table weights them", () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NOT ONE ROOM A FLOOR — THAT WAS THE OLD PLACER'S RULE, NOT UPSTREAM'S.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `rooms = {"random_room", {"money_vault",5}, {"lesser_vault",8}}`
     * (`data/zones/ruins-kor-pul/zone.lua:44`): every one of a level's room
     * picks is uniform over the three, and a weighted entry is kept only if its
     * percent roll passes, else the pick is made again
     * (`engine/generator/map/Roomer.lua:186-193`). So a vault is a chance on
     * every room, and a floor can hold none of them or several.
     *
     * The drawn rooms are the works list (`shared/vaults.ts`), where Kor'Pul
     * names four upstream vaults.
     */
    const works = new Set((VAULTS_BY_SHAPE[SiteShape.Works] ?? []).map((v) => v.id));
    const drawn = new Set<string>();
    let money = 0;
    let none = 0;
    let several = 0;
    for (let n = 0; n < 40; n += 1) {
      const placed = makeSiteMap(`vault-roll-works-${String(n)}`, SiteShape.Works).vaults ?? [];
      if (placed.length === 0) none += 1;
      if (placed.length > 1) several += 1;
      for (const one of placed) {
        if (one.id === 'room:money_vault') {
          money += 1;
          continue;
        }
        expect(
          works.has(one.id),
          `a works stamped '${one.id}', which is not one of its rooms`,
        ).toBe(true);
        drawn.add(one.id);
      }
    }
    expect(money, 'no money vault in forty works').toBeGreaterThan(0);
    expect(drawn.size, `every works got the same room: ${[...drawn].join(', ')}`).toBeGreaterThan(
      1,
    );
    expect(none, 'every works rolled a vault, so the rolls are not being made').toBeGreaterThan(0);
    expect(several, 'no works rolled two, so the list is capped at one again').toBeGreaterThan(0);
  });

  it('puts the room somewhere a player can see it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A ROOM MADE OF WALLS, STAMPED INTO ROCK, CHANGES NOTHING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Placement is bounds-only — that is what makes a works placeable at all,
     * whose corridors are one tile wide — but bounds-only also buried the rooms.
     * MEASURED over sixty floors a shape, before the preference and after:
     *
     *     cave    20/60 almost entirely sealed  ->  0/60   (mean open 0.24 -> 0.52)
     *     ruin     0/60                         ->  0/60   (       0.45 -> 0.47)
     *     works    9/60                         ->  3/60   (       0.30 -> 0.39)
     *
     * `placeVault` now takes a score and the sitemap counts already-open cells
     * under the footprint. It is a PREFERENCE: every legal spot stays legal, so a
     * floor with no open rectangle still gets its room in the rock rather than
     * going without.
     *
     * WHICH IS WHY THIS ALLOWS SOME. Three in sixty is the measured floor for a
     * works, and a test demanding zero would be demanding that the preference be
     * a requirement — which is the rule that left a third of the game's floors
     * with no room at all.
     *
     * THE CARVED SHAPES ONLY, because only they place with `placeVault`. A works
     * stamps its rooms whole into rock it has not dug yet.
     */
    for (const shape of CARVED) {
      if ((VAULTS_BY_SHAPE[shape] ?? []).length === 0) continue;

      let sealed = 0;
      let rolled = 0;
      for (let n = 0; n < 60; n += 1) {
        const map = makeSiteMap(`vault-open-${shape}-${String(n)}`, shape);
        const one = (map.vaults ?? [])[0];
        if (one === undefined) continue;
        rolled += 1;

        const { w, tiles } = map.view;
        let open = 0;
        for (let y = 0; y < one.h; y += 1) {
          for (let x = 0; x < one.w; x += 1) {
            if (isWalkable(tiles[(one.at.y + y) * w + (one.at.x + x)] ?? TileCode.WALL)) open += 1;
          }
        }
        if (open / Math.max(1, one.w * one.h) < 0.15) sealed += 1;
      }

      expect(rolled, `no room was rolled into any ${shape}`).toBeGreaterThan(0);
      expect(
        sealed / rolled,
        `${String(sealed)} of ${String(rolled)} ${shape} rooms are buried in rock — the open-ground preference is not being applied`,
      ).toBeLessThan(0.2);
    }
  });

  it('keeps the room clear of the door, so it can hold anything at all', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A ROOM INSIDE THE DOOR RING IS A ROOM THAT PAYS NOTHING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `roomFor` (server/content/delve.ts) discards every candidate tile within
     * `DOOR_CLEARANCE` of the arrival tile — a delve owes you a look at the room
     * before anything is in reach. The vault placer knows exactly where the door
     * is and excluded ONE CELL, so a drawn room could land wholly inside that
     * ring: `inRoom` came back empty and the room's guard and its share of the
     * litter both fell silently through to the rest of the floor.
     *
     * MEASURED over 400 floors a shape, before and after:
     *
     *     cave    206/400 rooms could hold nothing  ->  2/400
     *     works   151/400                           ->  0/400
     *     ruin     34/400                           ->  0/400
     *
     * More than half of all caves had a hand-drawn chamber in them that paid
     * nothing and defended nothing — the precise outcome the litter and guard
     * commits were written to prevent, shipped and never played.
     *
     * Placement did not get harder: all three shapes still roll a room on 400 of
     * 400 seeds. The two residual caves are rooms whose interior is solid wall,
     * which is a cause the fallthrough docblocks named all along and which can
     * now actually fire.
     */
    for (const shape of CARVED) {
      if ((VAULTS_BY_SHAPE[shape] ?? []).length === 0) continue;

      let rolled = 0;
      let inside = 0;
      for (let n = 0; n < 120; n += 1) {
        const map = makeSiteMap(`vault-clearance-${shape}-${String(n)}`, shape);
        const one = (map.vaults ?? [])[0];
        const spawn = map.spawns[0];
        if (one === undefined || spawn === undefined) continue;
        rolled += 1;

        // EVERY cell of the footprint, because the placer's contract is that the
        // whole room sits outside the ring — not merely that some corner does.
        for (let y = 0; y < one.h; y += 1) {
          for (let x = 0; x < one.w; x += 1) {
            const d = Math.max(Math.abs(one.at.x + x - spawn.x), Math.abs(one.at.y + y - spawn.y));
            if (d < DOOR_CLEARANCE) inside += 1;
          }
        }
      }

      expect(rolled, `no room was rolled into any ${shape}`).toBeGreaterThan(0);
      expect(
        inside,
        `${String(inside)} ${shape} room cells sit inside the door clearance, where nothing can be placed`,
      ).toBe(0);
    }
  });

  it('never stands a works stair inside a drawn room', () => {
    /**
     * THE DOOR CLEARANCE ABOVE IS THE CARVED SHAPES' PLACER, and a works has no
     * such placer: Roomer lays its rooms first and its stairs last, anywhere. What
     * it does refuse is a stair on a `special` cell (`engine/generator/map/Roomer.lua:51`,
     * `:67`), and every cell of a drawn room is special — so neither the arrival
     * nor the stair down is ever inside one.
     */
    let rooms = 0;
    for (let n = 0; n < 120; n += 1) {
      const seed = `vault-clearance-works-${String(n)}`;
      const map = makeSiteMap(seed, SiteShape.Works);
      const stairs = [map.spawns[0], map.down].filter((s) => s !== undefined);
      expect(stairs, `${seed}: a stair is missing`).toHaveLength(2);
      for (const room of drawnRooms(map)) {
        rooms += 1;
        for (const stair of stairs) {
          const inside =
            stair.x >= room.at.x &&
            stair.y >= room.at.y &&
            stair.x < room.at.x + room.w &&
            stair.y < room.at.y + room.h;
          expect(
            inside,
            `${seed}: a stair at ${String(stair.x)},${String(stair.y)} in ${room.id}`,
          ).toBe(false);
        }
      }
    }
    expect(rooms, 'no drawn room was rolled into any works').toBeGreaterThan(0);
  });

  it('turns the room it rolled, rather than always laying it the same way', () => {
    // The six orientations are the reason a short list of rooms does not read as
    // a short list. If every stamp used `none` they would be three fixed shapes.
    const turns = new Set<string>();
    for (const shape of SHAPES) {
      for (let n = 0; n < 40; n += 1) {
        for (const one of makeSiteMap(`vault-turn-${shape}-${String(n)}`, shape).vaults ?? []) {
          turns.add(one.turn);
        }
      }
    }
    expect(
      turns.size,
      `every room was laid the same way: ${[...turns].join(', ')}`,
    ).toBeGreaterThan(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WORKS IS A ROOMER LEVEL — `engine/generator/map/Roomer.lua`, as Kor'Pul.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to be a LATTICE, then a BSP tiling: rooms cut wall to wall out of the
 * whole building, joined sibling to sibling. Both were ours. A works is now the
 * level ToME's first dungeon is built as (`data/zones/ruins-kor-pul/zone.lua:41-52`):
 * rooms from the room library standing apart in rock, tunnels wandering between
 * them, doors rolled where a tunnel broke through a wall. What these tests pin
 * is upstream's rules for that level, read off the finished floor.
 */
describe('a works is rooms and corridors', () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => `works-${String(i)}`);
  /**
   * A WIDER SWEEP FOR THE TWO RULES A DOOR BREAKS RARELY. With the blocked axis
   * read as "not floor" rather than "wall", 32 works in 2000 hung a door beside
   * a door, and the first of them is works-78: outside `SEEDS`, so both tests
   * below passed without the rule they are about.
   */
  const DOOR_SEEDS = Array.from({ length: 100 }, (_, i) => `works-${String(i)}`);

  it("is the Kor'Pul Roomer level, built in the site's own grid keys", () => {
    /**
     * THE JOIN. `mapgen/` is tested on its own; this is the one line that hands
     * a site's palette to it. `'.'` and `'#'` are the palette, the stairs are
     * its floor, and a door stays a door — so a painted works holds exactly its
     * two codes and DOOR, drawn rooms included, where a repaint pass would have
     * had to find and rename them.
     */
    const palette = { floor: TileCode.SOOT, wall: TileCode.WORKS };
    const table = ROOMER_RUINS_KOR_PUL;
    let drawn = 0;
    for (const seed of SEEDS.slice(0, 10)) {
      const map = makeSiteMap(seed, SiteShape.Works, palette);
      // None of these ten has ground the up stair cannot reach, so the sealing
      // pass (tested above) leaves the level exactly as `newLevel` made it.
      const level = newLevel(
        {
          ...table,
          map: {
            ...table.map,
            grid: {
              ...table.map.grid,
              '.': palette.floor,
              '#': palette.wall,
              up: palette.floor,
              down: palette.floor,
            },
          },
        },
        seed,
        { level: 1, maxLevel: 1 },
      );
      expect(level.failed, `${seed}: no level in fifty attempts`).toBe(false);
      expect(map).toEqual(level.map);

      const written = new Set(map.view.tiles);
      written.delete(TileCode.DOOR);
      expect(written, `${seed}: a code the palette did not name`).toEqual(
        new Set<number>([palette.floor, palette.wall]),
      );
      drawn += drawnRooms(map).length;
    }
    expect(drawn, 'no drawn room was stamped, so its materials went unchecked').toBeGreaterThan(0);
  });

  it('lays nb_rooms rooms, standing apart in rock', () => {
    /**
     * `nb_rooms = 10` (`data/zones/ruins-kor-pul/zone.lua:43`), and Roomer stops
     * placing when that many are down (`engine/generator/map/Roomer.lua:183-197`)
     * over a map it first fills with `'#'` (`:154-156`). So a works holds at most
     * ten rooms, and everything that is not a room or a tunnel is rock.
     *
     * THE SHARE IS A GUARD, MEASURED: over 500 seeds, 17% to 34% walkable, a mean
     * of 27%, with ten rooms placed on every one. The BSP tiling this replaced
     * was 45% to 70%, and a floor filling back up toward that is a sign the map
     * is no longer starting from rock.
     */
    let rooms = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const placed = roomsPlaced(map);
      expect(placed, `${seed}: a works placed no rooms`).toBeGreaterThan(0);
      expect(placed, `${seed}: more rooms than nb_rooms`).toBeLessThanOrEqual(10);
      rooms += placed;
      const share =
        map.view.tiles.filter((code) => isWalkable(code)).length / map.view.tiles.length;
      expect(share, `${seed}: a works came out as solid rock`).toBeGreaterThan(0.12);
      expect(share, `${seed}: a works came out as an open floor`).toBeLessThan(0.45);
    }
    expect(rooms / SEEDS.length, 'a works is not placing the rooms it asks for').toBeGreaterThan(9);
  });

  it('hangs a door on some breakthroughs and not on all of them', () => {
    /**
     * A door costs a turn to open and blocks sight until it is. Upstream's
     * `door_chance` of 50 (`engine/generator/map/Roomer.lua:33`) is rolled over
     * the tiles a tunnel broke through a wall (`RoomsLoader.lua:910-928`) and
     * nowhere else, and the assertion is a BAND over seeds rather than a count on
     * one, because how many walls the tunnels cross is a property of the level.
     */
    let withDoors = 0;
    let most = 0;
    let total = 0;
    let cut = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const doors = map.view.tiles.filter((code) => code === TileCode.DOOR).length;
      const rooms = roomsPlaced(map);
      expect(rooms, `${seed}: a works cut no rooms`).toBeGreaterThan(0);
      if (doors > 0) withDoors += 1;
      most = Math.max(most, doors / rooms);
      total += doors;
      cut += rooms;
    }
    expect(withDoors, 'a works floor came out with no door at all').toBe(SEEDS.length);
    /**
     * THE MEAN IS THE TUNING AND THE MAX IS THE GUARD, PER ROOM. Measured over
     * 500 seeds: 1.20 doors a room, and no floor above 2.5 — a tunnel between
     * two rooms breaks through a wall leaving one and a wall arriving at the
     * other, and crosses others on the way. These thirty come to 1.11.
     *
     * AND A FLOOR BELOW THE MEAN, because half the chance is still a density: at
     * a `door_chance` of 25 these seeds come to 0.61 a room.
     *
     * The band is here to catch the shape of the mistake this file has already
     * made once — surveying the whole map for anything doorway-shaped, which put
     * a door on most of the gaps a floor has — not to pin a number that moves
     * when a room size does.
     */
    expect(total / cut, 'a works is a sequence of pauses again').toBeLessThan(1.6);
    expect(total / cut, 'a works rolls its doors at less than door_chance').toBeGreaterThan(0.9);
    expect(most, 'some works sealed nearly every room it placed').toBeLessThan(3);
  });

  it('hangs at least some doors that are the ONLY way into a room', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A DOOR NOBODY HAS TO OPEN IS A DOOR THAT IS NOT IN THE GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The failure this guards is a second way into every room with a door on
     * it, which leaves the door as decoration on a room you can walk around.
     * Nothing else notices: the doors are still on the map and the density is
     * unchanged. The only observable difference is whether a door is
     * load-bearing, so that is what this asks — ground reachable with the doors
     * opened that is NOT reachable with them shut.
     *
     * EIGHT-WAY BOTH TIMES, and both floods from the arrival. A Roomer floor
     * can keep a room nothing opened, and two floods that differed in more than
     * the doors would count that room as "behind a door" when no door is
     * involved.
     *
     * ═══ SOME SEEDS, NOT EVERY SEED ═══
     * A floor whose rooms all happen to have two mouths is a legitimate
     * building, so requiring it of each one would be a fixture asserting a
     * coincidence. Requiring it of the SET is the honest version of "doors do
     * something here". Measured: 493 of 500 floors.
     */
    let seedsWithALoadBearingDoor = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const spawn = map.spawns[0];
      if (spawn === undefined) continue;
      const opened = reach8(map, spawn);
      const shut = reach8(map, spawn, true);
      const behind = [...opened].filter(
        (i) => isWalkable(map.view.tiles[i] ?? TileCode.WALL) && !shut.has(i),
      ).length;
      if (behind > 0) seedsWithALoadBearingDoor += 1;
    }

    expect(
      seedsWithALoadBearingDoor,
      'every door on every floor can be walked around',
    ).toBeGreaterThan(SEEDS.length / 4);
  });

  it('hangs a door only where canDoor would: open through, shut in on both sides', () => {
    /**
     * `RoomsLoader:canDoor` (`engine/generator/map/RoomsLoader.lua:780-806`):
     * for some axis, both ends OPEN, and on one side of it the two orthogonal
     * cells and the two diagonals beyond them all BLOCKED. Worked through all
     * four headings that is: N and S open, W and E blocked, and both northern
     * or both southern diagonals blocked — or the same turned a quarter. Open is
     * `not block_move`, so off the map is open and a shut door is blocked.
     *
     * READ OFF THE FINISHED MAP, which is fair because nothing after
     * `placeDoors` opens a tile beside a door: the stairs stand on floor that
     * was already floor. Measured over 300 seeds, 3,553 doors, all of them pass.
     *
     * ═══ THE DRAWN ROOMS ARE EXCLUDED, AND IT IS NOT AN ESCAPE HATCH ═══
     * `shared/vaults.ts` writes its OWN doors from a hand-drawn legend, and
     * `SEALED_SHAFT` deliberately puts one at the neck of a one-tile corridor.
     * Those are an author's decision, not something `placeDoors` hung.
     */
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, h, tiles } = map.view;
      const rooms = drawnRooms(map);
      const inRoom = (x: number, y: number): boolean =>
        rooms.some((r) => x >= r.at.x && y >= r.at.y && x < r.at.x + r.w && y < r.at.y + r.h);
      const open = (x: number, y: number): boolean =>
        x < 0 || y < 0 || x >= w || y >= h || isWalkable(tiles[y * w + x] ?? TileCode.WALL);
      const shut = (x: number, y: number): boolean => !open(x, y);

      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (tiles[y * w + x] !== TileCode.DOOR || inRoom(x, y)) continue;
          const northSouth =
            open(x, y - 1) &&
            open(x, y + 1) &&
            shut(x - 1, y) &&
            shut(x + 1, y) &&
            ((shut(x - 1, y - 1) && shut(x + 1, y - 1)) ||
              (shut(x - 1, y + 1) && shut(x + 1, y + 1)));
          const eastWest =
            open(x - 1, y) &&
            open(x + 1, y) &&
            shut(x, y - 1) &&
            shut(x, y + 1) &&
            ((shut(x - 1, y - 1) && shut(x - 1, y + 1)) ||
              (shut(x + 1, y - 1) && shut(x + 1, y + 1)));
          expect(
            northSouth || eastWest,
            `${seed}: a door at ${String(x)},${String(y)} canDoor would refuse`,
          ).toBe(true);
        }
      }
    }
  });

  it('never puts two doors side by side', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `canDoor` HAS TWO HALVES AND THE FIRST VERSION ONLY HAD ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `RoomsLoader.lua:781-806` needs a through-line OPEN on one axis and
     * BLOCKED on the other. Testing only for walls is the blocked half alone —
     * and a door is not a wall, so a candidate next to a door still passed and
     * the generator shipped floors with `++` in them: two turns of opening for
     * one way through.
     *
     * Upstream cannot produce that, because its `open_spaces` is built from
     * `block_move` and a door blocks move. Asserted directly, because it is the
     * only observable difference between the two halves.
     */
    for (const seed of DOOR_SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, h, tiles } = map.view;
      const door = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x] === TileCode.DOOR;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (!door(x, y)) continue;
          expect(
            door(x + 1, y) || door(x, y + 1),
            `${seed}: two doors side by side at ${String(x)},${String(y)}`,
          ).toBe(false);
        }
      }
    }
  });

  it('never leaves a door with floor on all four sides', () => {
    /**
     * A DOORWAY IS A HOLE IN A WALL, and `canDoor` requires solid tiles on
     * exactly one axis. A door standing in open ground is a turn's delay in the
     * middle of a room with nothing on either side of it — which is what a naive
     * "put a door where the corridor started" would do.
     *
     * Asserted over the FINISHED map, after the stairs, because anything that
     * writes after `placeDoors` could in principle open the ground beside a door
     * that was legal when it was hung.
     */
    for (const seed of DOOR_SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, h, tiles } = map.view;
      const code = (x: number, y: number): number =>
        x < 0 || y < 0 || x >= w || y >= h ? TileCode.WALL : (tiles[y * w + x] ?? TileCode.WALL);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (code(x, y) !== TileCode.DOOR) continue;
          const solidNS = code(x, y - 1) === TileCode.WALL && code(x, y + 1) === TileCode.WALL;
          const solidEW = code(x - 1, y) === TileCode.WALL && code(x + 1, y) === TileCode.WALL;
          expect(
            solidNS || solidEW,
            `${seed}: a door at ${String(x)},${String(y)} is standing in open ground`,
          ).toBe(true);
        }
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CAVE IS A CAVERN LEVEL — `engine/generator/map/Cavern.lua`, as the orc pits.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to be a random walk from the centre with a drawn room stamped in and a
 * corridor dug to whatever the stamp cut off. It is now the level ToME digs for
 * its orc breeding pits (`data/zones/orc-breeding-pit/zone.lua:34-43`): noise at
 * zoom 23, the biggest region of it kept, and nothing else. `mapgen/cavern.test.ts`
 * pins the generator; these pin the site that is built from it.
 */
describe('a cave is a Cavern level', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => `cave-${String(i)}`);

  it("is the orc breeding pits' Cavern level, built in the site's own grid keys", () => {
    /**
     * THE JOIN: the one line that hands a site's palette to `mapgen/`. `floor`
     * and `wall` are the palette, and the stairs and the zone's `door` are its
     * floor — so a painted cave holds exactly its two codes.
     */
    const palette = { floor: TileCode.SOOT, wall: TileCode.CRAG };
    const table = CAVERN_ORC_BREEDING_PIT;
    for (const seed of SEEDS.slice(0, 10)) {
      const map = makeSiteMap(seed, SiteShape.Cave, palette);
      const level = keepTrying(
        {
          ...table,
          map: {
            ...table.map,
            grid: {
              floor: palette.floor,
              wall: palette.wall,
              up: palette.floor,
              down: palette.floor,
              door: palette.floor,
            },
          },
        },
        seed,
        { level: 1, maxLevel: 1 },
      );
      expect(map).toEqual(level.map);
      expect(new Set(map.view.tiles), `${seed}: a code the palette did not name`).toEqual(
        new Set<number>([palette.floor, palette.wall]),
      );
    }
  });

  it('leaves every floor tile reachable from the threshold, eight ways, as a body walks', () => {
    /**
     * EIGHT NEIGHBOURS, NOT FOUR. Cavern keeps the biggest EIGHT-connected region
     * (`engine/generator/map/Cavern.lua:63-85`), and a body here steps diagonally
     * between two walls (`World.tryMove`'s corner rule), so two chambers that
     * touch only at a corner are one cave. The carved shapes above are held to
     * four because their repair corridor digs four ways.
     */
    let diagonalOnly = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Cave);
      const { w, tiles } = map.view;
      const up = map.spawns[0];
      const { down } = map;
      if (up === undefined || down === undefined) throw new Error(`${seed}: a stair is missing`);
      expect(isWalkable(tiles[up.y * w + up.x] ?? TileCode.WALL), `${seed}: up`).toBe(true);
      expect(isWalkable(tiles[down.y * w + down.x] ?? TileCode.WALL), `${seed}: down`).toBe(true);

      const reached = reach8(map, up);
      const walkable = walkableSet(tiles);
      const stranded = [...walkable].filter((i) => !reached.has(i));
      expect(stranded.length, `${seed}: floor cut off from the threshold`).toBe(0);

      // How many of these a four-way flood would have called broken.
      const four = new Set<number>([up.y * w + up.x]);
      const stack = [up.y * w + up.x];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        const x = at % w;
        for (const n of [at - 1, at + 1, at - w, at + w]) {
          if (n < 0 || n >= tiles.length || four.has(n)) continue;
          if (Math.abs((n % w) - x) > 1 || !isWalkable(tiles[n] ?? TileCode.WALL)) continue;
          four.add(n);
          stack.push(n);
        }
      }
      if (four.size < walkable.size) diagonalOnly += 1;
    }
    expect(diagonalOnly, 'no cave needed a diagonal step, so four ways was tested').toBeGreaterThan(
      10,
    );
  });

  it('keeps at least min_floor cells of floor, and digs no room into it', () => {
    /**
     * `min_floor = 900` (`data/zones/orc-breeding-pit/zone.lua:38`): the biggest
     * region must hold that many or the noise is rolled again, and nothing else
     * stays open. And `nb_rooms` is Cavern's default of 0
     * (`engine/generator/map/Cavern.lua:112`), so no room, drawn or lit, and a
     * cave is as dark as upstream's.
     */
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Cave);
      const open = map.view.tiles.filter((code) => isWalkable(code)).length;
      expect(open, `${seed}: less floor than min_floor`).toBeGreaterThanOrEqual(900);
      expect(map.vaults, `${seed}: a cave rolled a room`).toEqual([]);
      expect(map.rooms, `${seed}: a cave recorded a room`).toEqual([]);
    }
    expect(VAULTS_BY_SHAPE[SiteShape.Cave]).toEqual([]);
  });

  it('lands the arrival wherever the generator put the up stair, not always the centre', () => {
    // `makeStairsInside` rolls both stairs on random open cells
    // (`engine/generator/map/Cavern.lua:220-246`). The old cave arrived at 25,25.
    const arrivals = new Set(
      SEEDS.map((seed) => {
        const up = makeSiteMap(seed, SiteShape.Cave).spawns[0];
        return `${String(up?.x)},${String(up?.y)}`;
      }),
    );
    expect(arrivals.size).toBeGreaterThan(30);
  });
});

describe('a ruin on a bigger site', () => {
  it('lays as many fragments for its area as the ruin it was tuned on', () => {
    /**
     * `byArea` scales the fragment count with the site. Without it a 50 by 50
     * ruin keeps the count of a 34 by 30 one and opens up. Measured over two
     * hundred seeds, inside the rim: the tuned ruin was 90.7% walkable, the
     * scaled one is 92.2%, and an unscaled one was 96.2%.
     */
    const { w, h } = SITE_MAP_SIZE;
    const N = 60;
    let share = 0;
    for (let n = 0; n < N; n += 1) {
      const { tiles } = makeSiteMap(`ruin-density-${String(n)}`, SiteShape.Ruin).view;
      let open = 0;
      for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
          if (isWalkable(tiles[y * w + x] ?? TileCode.WALL)) open += 1;
        }
      }
      share += open / ((w - 2) * (h - 2));
    }
    expect(share / N, 'a ruin opened up on the bigger site').toBeLessThan(0.94);
    expect(share / N, 'a ruin filled in on the bigger site').toBeGreaterThan(0.88);
  });
});
