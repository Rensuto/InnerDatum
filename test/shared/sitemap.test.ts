import { describe, expect, it } from 'vitest';

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
        for (const placed of map.vaults ?? []) {
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
    for (const shape of SHAPES) {
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
     */
    for (const shape of SHAPES) {
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
    for (const shape of SHAPES) {
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
 * A WORKS IS A BUILDING NOW — `engine/BSP.lua`, and what it changed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to be a LATTICE: a floor with square blocks stamped on a fixed pitch
 * and one gallery through the middle. Every cell the same size, every junction
 * the same junction, and nowhere a player could be said to be IN. BSP cuts it
 * into rooms of genuinely different sizes, and the walls between them are what
 * is left rather than something drawn.
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

  it('leaves between half and two thirds of the floor walkable', () => {
    /**
     * MEASURED, and the band is what the shape is FOR rather than a tolerance.
     * Too little and a building is a maze of slots — the first draft of this
     * generator used a minimum room of four, which the one-tile shared wall ate
     * down to rooms two tiles wide and 36% walkable. Too much and it is the open
     * box the delve started as.
     */
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const walkable = map.view.tiles.filter((code) => isWalkable(code)).length;
      const share = walkable / map.view.tiles.length;
      expect(share, `${seed}: a works came out as a maze of slots`).toBeGreaterThan(0.45);
      expect(share, `${seed}: a works came out as an open box`).toBeLessThan(0.7);
    }
  });

  it('hangs a door on some mouths and not on all of them', () => {
    /**
     * A door costs a turn to open and blocks sight until it is, so one on every
     * mouth would be a dozen pauses crossing a single delve — the opposite of
     * what the tile is for. `DOOR_CHANCE` is the share, and the assertion is a
     * BAND over seeds rather than a count on one, because the number of mouths
     * is a property of the cut.
     */
    let withDoors = 0;
    let most = 0;
    let total = 0;
    let cut = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const doors = map.view.tiles.filter((code) => code === TileCode.DOOR).length;
      const rooms = map.rooms?.length ?? 0;
      expect(rooms, `${seed}: a works cut no rooms`).toBeGreaterThan(0);
      if (doors > 0) withDoors += 1;
      most = Math.max(most, doors / rooms);
      total += doors;
      cut += rooms;
    }
    expect(withDoors, 'a works floor came out with no door at all').toBe(SEEDS.length);
    /**
     * THE MEAN IS THE TUNING AND THE MAX IS THE GUARD, PER ROOM CUT, because a
     * bigger building cuts more rooms and so has more mouths to hang one on.
     * Measured over two hundred seeds at upstream's own `door_chance` of 50,
     * rolled over the tiles a tunnel broke through: 0.68 doors a room on a 34 by
     * 30 floor, and 0.72 on a 50 by 50 one, where no floor carried more than 0.93.
     *
     * The band is generous on purpose. It is here to catch the shape of the
     * mistake this file has already made once — surveying the whole map for
     * anything doorway-shaped, which offered thirty candidates and put sixteen
     * doors on a floor of about eleven rooms — not to pin a number that moves
     * when a room size does.
     */
    expect(total / cut, 'a works is a sequence of pauses again').toBeLessThan(1);
    expect(most, 'some works sealed nearly every room it cut').toBeLessThan(1.5);
  });

  it('hangs at least some doors that are the ONLY way into a room', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A DOOR NOBODY HAS TO OPEN IS A DOOR THAT IS NOT IN THE GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `connect` repairs stranded floor by carving a corridor to it, and it
     * decides what is stranded by flooding. If that flood treats a door as a
     * WALL, every room whose only mouth is a door looks cut off — so `connect`
     * digs a second way in and the door becomes decoration on a room you can
     * walk around. `crossable` is what stops that.
     *
     * NOTHING ELSE NOTICES. Reachability still holds (there are MORE routes,
     * not fewer), the doors are still on the map, and the density is unchanged.
     * The only observable difference is whether a door is load-bearing, so that
     * is what this asks: flood the finished map treating doors as solid, and
     * some floor must come out unreachable.
     *
     * ═══ SOME SEEDS, NOT EVERY SEED ═══
     * A floor whose rooms all happen to have two mouths is a legitimate
     * building, so requiring it of each one would be a fixture asserting a
     * coincidence. Requiring it of the SET is the honest version of "doors do
     * something here".
     */
    let seedsWithALoadBearingDoor = 0;
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, h, tiles } = map.view;
      const spawn = map.spawns[0];
      if (spawn === undefined) continue;

      const seen = new Set<number>();
      const stack = [spawn.y * w + spawn.x];
      seen.add(stack[0] ?? 0);
      while (stack.length > 0) {
        const idx = stack.pop();
        if (idx === undefined) break;
        const x = idx % w;
        const y = Math.floor(idx / w);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          // DOORS AS SOLID, deliberately — the whole question is what a shut
          // door is keeping from you.
          if (!isWalkable(tiles[ny * w + nx] ?? TileCode.WALL)) continue;
          const n = ny * w + nx;
          if (seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }

      const behind = tiles.filter((code, i) => isWalkable(code) && !seen.has(i)).length;
      if (behind > 0) seedsWithALoadBearingDoor += 1;
    }

    expect(
      seedsWithALoadBearingDoor,
      'every door on every floor can be walked around — connect is digging past them',
    ).toBeGreaterThan(SEEDS.length / 4);
  });

  it('never hangs a door on a corridor pinch', () => {
    /**
     * A one-tile corridor has walls on one axis for its whole length, so the
     * doorway test alone would hang doors along a passage — a delay with no
     * room behind it. `opensWide` requires the gap to lead into a span at least
     * three wide on one side, which is a room and not another corridor.
     *
     * ═══ THE STAMPED VAULT IS EXCLUDED, AND IT IS NOT AN ESCAPE HATCH ═══
     * `shared/vaults.ts` writes its OWN doors from a hand-drawn legend, and
     * `SEALED_SHAFT` deliberately puts one at the neck of a one-tile corridor —
     * *"the only shape here that makes a player commit to walking in"*. So the
     * no-pinch property is true of THIS PASS and false of the finished map, and
     * a test that asserted it map-wide was reporting an author's decision as a
     * generator bug. It did: a door at 17,13 on the eleventh seed, stamped by a
     * vault.
     */
    for (const seed of SEEDS) {
      const map = makeSiteMap(seed, SiteShape.Works);
      const { w, h, tiles } = map.view;
      const vault = map.vaults?.[0];
      const inVault = (x: number, y: number): boolean =>
        vault !== undefined &&
        x >= vault.at.x &&
        y >= vault.at.y &&
        x < vault.at.x + vault.w &&
        y < vault.at.y + vault.h;
      const code = (x: number, y: number): number =>
        x < 0 || y < 0 || x >= w || y >= h ? TileCode.WALL : (tiles[y * w + x] ?? TileCode.WALL);
      /**
       * A DOOR COUNTS AS FLOOR HERE, and the reason is a real trap.
       *
       * The generator surveys the map while the mouth is still FLOOR and turns
       * it into a DOOR afterwards. This test reads the finished map, where one
       * of the tiles the survey looked at is the door itself — so asking for
       * `FLOOR` on both sides fails on the very tile being judged. It reported
       * a pinch at 9,5 that is a perfectly good room mouth.
       */
      const open = (x: number, y: number): boolean =>
        code(x, y) === TileCode.FLOOR || code(x, y) === TileCode.DOOR;
      const roomy = (x: number, y: number, alongX: boolean): boolean =>
        open(x, y) &&
        (alongX ? open(x, y - 1) && open(x, y + 1) : open(x - 1, y) && open(x + 1, y));

      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (code(x, y) !== TileCode.DOOR) continue;
          if (inVault(x, y)) continue;
          const wallNS = code(x, y - 1) === TileCode.WALL && code(x, y + 1) === TileCode.WALL;
          const leadsSomewhere = wallNS
            ? roomy(x - 1, y, false) || roomy(x + 1, y, false)
            : roomy(x, y - 1, true) || roomy(x, y + 1, true);
          expect(
            leadsSomewhere,
            `${seed}: a door at ${String(x)},${String(y)} is a pinch in a corridor`,
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
     * A DOORWAY IS A HOLE IN A WALL, and the survey that finds one requires
     * solid tiles on exactly one axis. A door standing in open ground is a
     * turn's delay in the middle of a room with nothing on either side of it —
     * which is what a naive "put a door where the corridor started" would do.
     *
     * Asserted over the FINISHED map, after `connect` has carved whatever it
     * needed, because that pass runs last and could in principle open the ground
     * beside a door that was legal when it was hung.
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
