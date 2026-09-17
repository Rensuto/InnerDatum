/**
 * The floor behind a door — a different shape for every kind of place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * All thirteen sites opened onto `makeTestMap` — the same hand-authored 30x30
 * room, every time. Walk into a city, a mine, a drowned chapel or an industrial
 * ward and you got the identical floor plan, which makes the region's thirteen
 * destinations one destination with thirteen doors. Reported from play as the
 * points of interest all being the same.
 *
 * A place's IDENTITY at this scale is its SHAPE. Long straight galleries read
 * as a mine before a single sprite is drawn; an open plaza with blocks in it
 * reads as a town; scattered fragments read as a ruin. So each site kind gets a
 * generator, and the generator is the identity.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR AND WALL, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 * `TILE_SPRITES` in the renderer deliberately has no entry for either, so every
 * room this produces draws correctly the day it is written — the flat-interior
 * rule paying for itself a second time. Four new layouts cost zero assets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONNECTIVITY IS PROVEN, NOT HOPED FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * The town and the ruin finish by carving from the spawn to anything they
 * stranded, so "can the player reach the far side" is a property of the
 * algorithm. A sealed pocket in a hand-authored map is a bug somebody notices;
 * in a generated one it is a bug that appears one run in fifty and cannot be
 * reproduced from a description.
 *
 * THE WORKS PROVES IT UPSTREAM'S WAY INSTEAD. It is ToME's Roomer
 * (`mapgen/`), which repairs nothing: `newLevel` throws a level away and makes
 * another when the up stair cannot reach the down stair or a vault's entrance
 * (`engine/Zone.lua:1131-1158`). A room the tunnels never opened can stay shut,
 * as it can in ToME, and since nobody here can dig one out, its ground is made
 * rock (see `works`).
 *
 * THE CAVE IS UPSTREAM'S TOO, and needs neither. It is ToME's Cavern, which keeps
 * only the biggest eight-connected region of its noise and makes the rest rock,
 * so every open cell is one region before a stair is placed (see `cave`).
 *
 * PURE, and seeded from shared/rng.ts with labelled draws, so a floor is
 * reproducible from the realm that opened it.
 */

import { tileIndex } from './coords.ts';
import { createRng } from './rng.ts';
import { TileCode } from './protocol.ts';
import { sealUnreachable } from './mapgen/connectivity.ts';
import { CAVERN_ORC_BREEDING_PIT, ROOMER_RUINS_KOR_PUL, keepTrying } from './mapgen/level.ts';
import type { CavernMapSpec, LevelSpec } from './mapgen/level.ts';
import { placeVault, stampVault } from './vault.ts';
import type { VaultShape } from './vault.ts';
import { VAULTS_BY_SHAPE } from './vaults.ts';
import type { TileXY } from './coords.ts';
import type { Rng } from './rng.ts';
import type { AuthoredMap } from './level.ts';

/**
 * The shapes a place can take. A site names one; the generator does the rest.
 *
 * Deliberately few. Four distinguishable silhouettes across thirteen sites is
 * variety; thirteen bespoke generators would be thirteen things to keep working
 * and would still be read as "some rooms" by a player walking through them.
 */
export const SiteShape = {
  /** An open plaza with building blocks in it. Towns, markets, settlements. */
  Town: 'town',
  /** Caverns, as ToME's Cavern digs them. Mines, the Underworks, anything dug. */
  Cave: 'cave',
  /** Mostly open, with broken fragments of wall. Chapels, altars, wreckage. */
  Ruin: 'ruin',
  /** Rooms joined by tunnels, as ToME's Roomer lays them. Works, archives, anything built. */
  Works: 'works',
} as const;
export type SiteShape = (typeof SiteShape)[keyof typeof SiteShape];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR FROM THE DOOR ANYTHING IS ALLOWED TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LARGER THAN THE AMBUSH'S FOUR, deliberately. An ambush is something that
 * happened TO you and opening at four tiles is the point; a delve is somewhere
 * you chose to walk into, and the first thing it owes you is a look at the room
 * before anything is in reach.
 *
 * ═══ IT LIVED IN `server/content/delve.ts` AND ONLY HALF THE CODE KNEW IT ═══
 * The populator dropped every candidate tile within this radius, and the vault
 * placer — which knows exactly where the door is — excluded ONE CELL. So a
 * drawn room could land four tiles from the arrival tile, entirely inside the
 * ring the populator was about to discard, and the room's guard and its share
 * of the litter both fell through to the rest of the floor.
 *
 * Measured over 400 floors a shape before this moved: 206/400 caves and
 * 151/400 works rolled a room that could hold nothing at all, mean footprint
 * centre 5.5 and 7.5 tiles from the door. Half the delves in the game had a
 * hand-drawn chamber in them that paid nothing and defended nothing.
 *
 * `src/shared/` is the only module the map generator and the server's populator
 * can both import, which is what one definition of this requires.
 */
export const DOOR_CLEARANCE = 8;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S LEVEL SIZE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every site was 34 by 30, which is small beside upstream: its first-tier zone
 * levels are 50 by 50 (data/zones/ruins-kor-pul/zone.lua:30) and so are its
 * smaller towns (data/zones/town-zigur/zone.lua:27). Trollmire's forest is 65 by
 * 40. So a site is 50 by 50 now, whatever its shape, and the generators below
 * scale with it: a ruin lays more fragments and a town more blocks. A works is
 * Kor'Pul's own 50 by 50 table and a cave the orc breeding pits' (`mapgen/level.ts`).
 */
const W = 50;
const H = 50;

/** The area every fixed count in this file was measured on, before the resize. */
const TUNED_AREA = 34 * 30;

/** `n` things per site of the tuned size, for a site of this size. */
function byArea(n: number): number {
  return Math.max(1, Math.round((n * W * H) / TUNED_AREA));
}
const MARGIN = 1;

type Grid = number[];

function blank(): Grid {
  return new Array<number>(W * H).fill(TileCode.WALL);
}

function put(g: Grid, x: number, y: number, code: number): void {
  if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) return;
  g[tileIndex(x, y, W)] = code;
}

function at(g: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= W || y >= H) return TileCode.WALL;
  return g[tileIndex(x, y, W)] ?? TileCode.WALL;
}

function room(g: Grid, x0: number, y0: number, x1: number, y1: number, code: number): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) put(g, x, y, code);
  }
}

// ---------------------------------------------------------------------------
// The four shapes
// ---------------------------------------------------------------------------

/**
 * A TOWN: one open plaza, blocks of building standing in it.
 *
 * The blocks are placed on a loose grid and then SHRUNK at random, which is
 * what stops it reading as a chessboard — a settlement is regular enough to
 * have streets and irregular enough that no two are the same.
 */
function town(g: Grid, rng: Rng): TileXY {
  room(g, MARGIN, MARGIN, W - MARGIN - 1, H - MARGIN - 1, TileCode.FLOOR);
  for (let by = 3; by < H - 5; by += 6) {
    for (let bx = 3; bx < W - 5; bx += 7) {
      const w = rng.int('site.town.w', 2, 4);
      const h = rng.int('site.town.h', 2, 3);
      // A gap in the row now and then, so the streets are not a grid.
      if (rng.int('site.town.gap', 0, 9) < 2) continue;
      room(g, bx, by, bx + w, by + h, TileCode.WALL);
    }
  }
  return { x: Math.floor(W / 2), y: H - 3 };
}

/**
 * A RUIN: open ground with fragments of wall standing in it.
 *
 * Fragments rather than rooms — short runs, one cell thick, at right angles.
 * A ruin is a building that has mostly stopped being one, and the read comes
 * from the gaps rather than from the walls.
 */
function ruin(g: Grid, rng: Rng): TileXY {
  room(g, MARGIN, MARGIN, W - MARGIN - 1, H - MARGIN - 1, TileCode.FLOOR);
  // AS MANY FRAGMENTS FOR THE AREA as the tuned ruin had, or a bigger ruin is an
  // emptier one.
  const fragments = rng.int('site.ruin.count', byArea(14), byArea(22));
  for (let i = 0; i < fragments; i += 1) {
    const x = rng.int('site.ruin.x', 2, W - 3);
    const y = rng.int('site.ruin.y', 2, H - 3);
    const len = rng.int('site.ruin.len', 2, 6);
    const horizontal = rng.int('site.ruin.dir', 0, 1) === 0;
    for (let n = 0; n < len; n += 1) {
      put(g, horizontal ? x + n : x, horizontal ? y : y + n, TileCode.WALL);
    }
  }
  return { x: 2, y: Math.floor(H / 2) };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAVE: A CAVERN LEVEL, DUG THE WAY THE ORC BREEDING PITS ARE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mapgen/level.ts` holds the zone table and `mapgen/cavern.ts` the generator:
 * simplex noise at zoom 23 decides rock from floor, only the biggest region of
 * floor survives — and it must hold 900 cells, or the noise is rolled again —
 * and both stairs go on random open cells (`engine/generator/map/Cavern.lua:44-246`).
 *
 * ═══ IT REPLACED A RANDOM WALK ═══
 * That cave was a walk from the centre, pulled back every 90 steps until 38% of
 * the inside was open, with one of four drawn rooms stamped in and a corridor
 * dug to anything the stamp cut off, and the arrival always the centre. ToME's
 * caves are none of that: close-grained noise, pillars and pockets, the arrival
 * anywhere, and no room in them at all: `nb_rooms` defaults to 0
 * (`engine/generator/map/Cavern.lua:112`) and no ToME level built by Cavern
 * places one. So a cave rolls no drawn room now (`shared/vaults.ts`).
 *
 * ═══ THE PALETTE IS THE ZONE'S GRID KEYS ═══
 * `floor` and `wall` are the palette's; both stairs and the `door` key are its
 * floor, as the breeding pits' own door is their floor
 * (`data/zones/orc-breeding-pit/zone.lua:39-43`). A key that names one code
 * draws nothing, so a painted cave is the plain cave in other codes.
 *
 * ═══ NO SEALING PASS, BECAUSE NOTHING IS SEALED ═══
 * A works makes rock of what its up stair cannot reach. A cave has nothing to
 * make rock: every region but one is walled in before the stairs are placed,
 * and the stairs stand in that one — reached eight ways, which is how a body
 * walks. With no rooms and no doors, that is every walkable cell.
 */
function cave(seed: string, palette: SitePalette): AuthoredMap {
  const table = CAVERN_ORC_BREEDING_PIT;
  const spec: LevelSpec<CavernMapSpec> = {
    ...table,
    map: {
      ...table.map,
      grid: {
        ...table.map.grid,
        floor: palette.floor,
        wall: palette.wall,
        up: palette.floor,
        down: palette.floor,
        door: palette.floor,
      },
    },
  };
  return keepTrying(spec, seed, { level: 1, maxLevel: 1 }).map;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WORKS: A ROOMER LEVEL, LAID THE WAY THE RUINS OF KOR'PUL ARE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mapgen/level.ts` holds the zone table and `mapgen/roomer.ts` the generator:
 * up to ten rooms from ToME's own room library, each with a small weighted chance
 * of being a money vault or one of our drawn rooms instead, tunnels from each
 * room to the next, a door rolled
 * on half the places a tunnel broke through a wall, and both stairs placed by
 * the generator rather than chosen afterwards.
 *
 * ═══ IT REPLACED A BSP TILING ═══
 * That floor was cut by `shared/bsp.ts` into rooms that filled the building
 * wall to wall, each joined to its sibling, with a corridor dug afterwards to
 * anything left stranded. It read as built, and it was not ToME's: Kor'Pul's
 * rooms stand apart in rock, in dozens of authored shapes, and its tunnels
 * wander between them.
 *
 * ═══ THE PALETTE IS THE ZONE'S GRID KEYS, NOT A REPAINT ═══
 * `'.'` is the palette's floor and `'#'` its wall and a door stays DOOR — the
 * grids a ToME zone names in its own `generator.map` table
 * (`data/zones/ruins-kor-pul/zone.lua:47-51`). Both stairs are the floor, because
 * a stair here is a site marker standing on it, not terrain. A key that
 * names one code draws nothing when it resolves (`engine/Generator.lua:59-77`),
 * so a painted works makes the same draws, and has the same walls, as a plain
 * one. `roof` is a town's third code; a works has one kind of wall.
 *
 * ═══ ONE TABLE FOR EVERY FLOOR ═══
 * `makeSiteMap` is not told which floor it builds, so every floor is built as
 * level 1. With `forceLastStair` that loses nothing: the generator always places
 * a down stair, and `realms.ts` decides whether this floor has a level below it.
 *
 * ═══ ONLY A CERTIFIED LEVEL, AS TOME ONLY ENTERS ONE ═══
 * `keepTrying` (`mapgen/level.ts`) never hands back a level whose stairs or
 * vault entrances `newLevel` could not join.
 *
 * ═══ AND SOLID ROCK WHERE NOBODY CAN GO — OUR RULE, NOT UPSTREAM'S ═══
 * A Roomer floor can keep ground its tunnels never opened: a room they missed,
 * a money vault walled in by the rooms around it. Upstream keeps it, and a ToME
 * player who lands there digs out. Nobody here can dig, and three things put a
 * body somewhere without walking it there: the search for a free tile beside a
 * crowded arrival (`World.findSpawn`), a teleport (`talents.ts`
 * `teleportRandom`), and a teleport trap. Before the drawn vaults had their
 * apron (`mapgen/rooms-loader.ts`), the fourth to sixth arrival of a party was
 * put in a sealed pocket on 7 of 20,000 floors, with no way out. So every
 * walkable cell and door the up stair cannot reach — eight neighbours, a shut
 * door passable, the rule that certified the level — is made the zone's wall.
 * Nobody could see into that ground either, so the floor a party walks and sees
 * is unchanged; the level only stops offering places that are not on it.
 * Measured over 6,000 floors: 85 had any, and two had more than half their
 * walkable ground sealed (`site:outer_index` seeds 141 and 1149).
 */
function works(seed: string, palette: SitePalette): AuthoredMap {
  const table = ROOMER_RUINS_KOR_PUL;
  const spec: LevelSpec = {
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
  };
  return sealUnreachable(keepTrying(spec, seed, { level: 1, maxLevel: 1 }).map, palette.wall);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DOOR IS A WAY THROUGH — and `connect` was quietly disagreeing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isWalkable(DOOR)` is FALSE and correctly so: a shut door stops a body where
 * it stands, which is the whole tile. But CONNECTIVITY is a different question
 * from walkability — a player opens the door and walks through, so a room whose
 * only mouth is a door is reachable, not stranded.
 *
 * `connect` floods to find what the shape stranded and carves a corridor to it.
 * Reading `!== FLOOR` meant every room behind a door looked cut off, so it
 * carved a SECOND way in — and the door became decoration on a room you could
 * walk around. Found by the reachability guard in `sitemap.test.ts`, which was
 * asking the same question with the same wrong predicate.
 *
 * The two answers now agree, and they agree with the player.
 */
function crossable(code: number): boolean {
  return code === TileCode.FLOOR || code === TileCode.DOOR;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A DRAWN ROOM FORBIDS A CORRIDOR — `RoomsLoader.lua:526-536` (`roomFrom`).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * self.map.room_map[i-1+x][j-1+y].room = id
 * if c == '#' and (i == 1 or i == room.w or j == 1 or j == room.h) then -- forces tunnelling around edge walls
 *   self.map.room_map[i-1+x][j-1+y].room = nil
 *   self.map.room_map[i-1+x][j-1+y].can_open = false
 * ```
 *
 * Upstream marks every cell of a placed room, and the walls on its edge as cells
 * no tunnel may open. Its tunneller then goes around those walls, walks through
 * the rest of the room without writing a tile of it, and lays floor only where
 * it walked outside one (`RoomsLoader.lua:814-817`).
 *
 * ONE FLAG DOES BOTH HALVES HERE. A repair corridor has to be one a body can
 * follow, so it walks a drawn cell only where that cell is already a way
 * through, and every wall of the room, on its edge or not, is one it goes around.
 *
 * `connect` had neither half. Its corridor ran straight from the threshold to
 * whatever was stranded, through a room if one was in the way, and floored
 * everything it crossed. Measured over eighty floors a shape before this: a
 * drawn cell rewritten in 32 works rooms, 20 cave rooms and 5 ruin rooms, most
 * of them edge walls. A door whose wall is gone is a door standing in the open.
 */
/** A cell of `held` that a stamped room drew. */
const HELD = 1;

/** Mark the cells a stamped room drew in `held`. */
function holdRoom(held: Uint8Array, shape: VaultShape, at: TileXY): void {
  for (let y = 0; y < shape.h; y += 1) {
    for (let x = 0; x < shape.w; x += 1) {
      const code = shape.tiles[y * shape.w + x];
      // A BLANK IS NOT PART OF THE DRAWING. The stamp leaves the ground there as
      // it was, and so may a corridor: it is how a room is drawn open to the
      // floor around it, as the sealed shaft is at its foot.
      if (code === null || code === undefined) continue;
      held[tileIndex(at.x + x, at.y + y, W)] = HELD;
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REPAIR CORRIDOR, AROUND A DRAWN ROOM RATHER THAN THROUGH IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The shortest way from the threshold to what was stranded that writes none of a
 * drawn room: through a drawn cell only where it is already a way through, so
 * every wall of the room is one the corridor goes around.
 *
 * Where no room is in the way it digs the cells the straight corridor did. An
 * earlier version tried that corridor first, and over eighty floors a shape the
 * two never differed by a tile.
 *
 * A room is always placed with a ring of open bounds around it (`vaultFits`),
 * and its own door is crossable, so a room stamped into rock is reached through
 * that door.
 */
function dig(g: Grid, held: Uint8Array, from: TileXY, to: TileXY): void {
  const start = tileIndex(from.x, from.y, W);
  const came = new Int32Array(W * H).fill(-1);
  came[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const idx = queue[head] ?? start;
    const x = idx % W;
    const y = (idx - x) / W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < MARGIN || ny < MARGIN || nx >= W - MARGIN || ny >= H - MARGIN) continue;
      const n = tileIndex(nx, ny, W);
      if (came[n] !== -1) continue;
      if (held[n] === HELD && !crossable(at(g, nx, ny))) continue;
      came[n] = idx;
      queue.push(n);
    }
  }
  // BACK FROM THE STRANDED CELL, which is floor already. Nothing is written if
  // no way was found: `came` of the goal is still -1.
  for (let i = came[tileIndex(to.x, to.y, W)] ?? -1; i !== -1 && i !== start; i = came[i] ?? -1) {
    if (held[i] !== HELD) put(g, i % W, (i - (i % W)) / W, TileCode.FLOOR);
  }
}

/**
 * Carve from the spawn to anything the shape stranded.
 *
 * Flood from the spawn, then run a corridor to the nearest cell of each
 * unreached pocket, repeatedly, until everything walkable is connected. Cheap
 * on a 50x50 grid and it makes "the far side is reachable" true by construction
 * rather than by inspection.
 */
function connect(g: Grid, from: TileXY, held: Uint8Array): void {
  for (let pass = 0; pass < 12; pass += 1) {
    const seen = new Set<number>();
    const stack = [tileIndex(from.x, from.y, W)];
    seen.add(stack[0] ?? 0);
    while (stack.length > 0) {
      const idx = stack.pop();
      if (idx === undefined) break;
      const x = idx % W;
      const y = Math.floor(idx / W);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!crossable(at(g, nx, ny))) continue;
        const nIdx = tileIndex(nx, ny, W);
        if (seen.has(nIdx)) continue;
        seen.add(nIdx);
        stack.push(nIdx);
      }
    }

    let orphan: TileXY | null = null;
    for (let y = MARGIN; y < H - MARGIN && orphan === null; y += 1) {
      for (let x = MARGIN; x < W - MARGIN; x += 1) {
        if (at(g, x, y) === TileCode.FLOOR && !seen.has(tileIndex(x, y, W))) {
          orphan = { x, y };
          break;
        }
      }
    }
    if (orphan === null) return;
    dig(g, held, from, orphan);
  }
}

/**
 * Build the floor behind one door.
 *
 * `seed` should name the realm, so two parties in the same place get the same
 * floor and a re-entry finds the room it left.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A ROOM IS MADE OF. Two codes, and it is a SUBSTITUTION, not a generator.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirteen destinations were one destination with thirteen doors, then `shape`
 * made them four; they were still every one of them the same grey box, because
 * every interior in the game is built out of exactly two tile codes and the
 * player has been looking at those two codes since M1.
 *
 * The palette is applied as a POST-PASS over the finished grid rather than
 * threaded into the carvers, and that is the whole safety argument: the
 * generator runs unchanged, draws the same numbers off the same seeded stream in
 * the same order, and produces the same walkable cells bit for bit. Only the two
 * codes it wrote are renamed on the way out. A room cannot become unreachable by
 * being repainted, and `sitemap.test.ts` asserts exactly that — the walkable
 * index set is identical to the FLOOR/WALL build for every shape and palette.
 *
 * BOTH HALVES CARRY A REAL RULE, checked by that same test rather than trusted:
 * the floor must be `isWalkable` and the wall must not be, or a repaint would
 * quietly change where a body may stand.
 *
 * ═══ WATER WAS TRIED HERE AND MEASURED OUT. DO NOT ADD IT BACK BLIND. ═══
 * The Drowned Chapel is named for a tide — *"the tide took the nave and left the
 * arches"* — and has no water in it, which looks exactly like the broken
 * promises this game has spent a lot of effort fixing. So the fen arena's
 * channel logic was lifted in behind a `channels` palette field and measured
 * with `tools/delve-run.mjs`, solo, 8 runs:
 *
 *     dry (shipped)      8/8 cleared   166 turns   50% low-water
 *     one channel        7/8           206 turns   49%
 *     two channels       6/8           315 turns   48%
 *
 * IT IS NOT THE DAMAGE — the low-water mark barely moves. It is the CHASE. An
 * arena works with water because it is a short fight you are surrounded in; a
 * delve is a floor you have to CLEAR, so one kiting monster on the far bank is a
 * long walk to a ford and back, repeatedly. Removing the cairn and leaving the
 * water still gave 7/8 at 252 turns, so the ranged monster is not the variable
 * either — any kiter behind a cut does this.
 *
 * The Drowned Chapel is seventeen steps from the gate and the first marker most
 * players will ever walk to. Doubling its length and adding a one-in-eight
 * chance of a chase, to make a name literal, is a bad trade. The name stays
 * unfulfilled and that is the smaller cost.
 *
 * AND IT IS FREE. Every code any palette names already has a PNG on disk and a
 * `tileFill` colour — six of them (GREEN, SOOT, RAIL, WORKS, TERRACE, CIVIC) are
 * finished art that until now drew nothing anywhere in the game, because their
 * codes appear on no overworld row and in no interior.
 */
export type SitePalette = {
  readonly floor: TileCode;
  readonly wall: TileCode;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT A BLOCK IN THE MIDDLE OF TOWN IS MADE OF, AS OPPOSED TO THE EDGE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Optional, and absent means "the same as `wall`" — which is what every site
   * did before and is still right for a cave, where the rock at the edge and the
   * rock in the middle are the same rock.
   *
   * IT IS NOT RIGHT FOR A TOWN. Measured on Alderbrook: 1,020 cells, exactly two
   * codes — PAVING 732 and CIVIC 288 — and the outer ring is the SAME CODE as
   * the building blocks inside it. The layout is a real town, streets and all,
   * and a player standing in it cannot tell a house from the edge of the map
   * because they are drawn identically. A player put it as "how hard it is to
   * tell the area im at is a town".
   *
   * Three codes give a town the three things it needs to read as one: a street,
   * a building, and a boundary. All the art already exists.
   */
  readonly roof?: TileCode;
};

/** What every site was, and what a caller that names no palette still gets. */
export const DEFAULT_SITE_PALETTE: SitePalette = {
  floor: TileCode.FLOOR,
  wall: TileCode.WALL,
};

export function makeSiteMap(
  seed: string,
  shape: SiteShape,
  palette: SitePalette = DEFAULT_SITE_PALETTE,
): AuthoredMap {
  // A WORKS AND A CAVE ARE EACH ITS OWN LEVEL, with its own seeds per attempt —
  // see `works` and `cave`. Nothing below runs for them: no shared vault roll,
  // no `connect`, no repaint.
  if (shape === SiteShape.Works) return works(seed, palette);
  if (shape === SiteShape.Cave) return cave(seed, palette);

  const rng = createRng(seed);
  const g = blank();

  /** The cells a stamped room holds, which no repair corridor writes. See `dig`. */
  const held = new Uint8Array(W * H);

  const spawn = shape === SiteShape.Town ? town(g, rng) : ruin(g, rng);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A ROOM SOMEBODY DREW, DROPPED INTO THE NOISE — see `shared/vault.ts`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * BEFORE THE THRESHOLD AND BEFORE `connect`, and both halves of that matter.
   *
   * BEFORE `connect` because a vault writes WALLS, and walls can cut a floor in
   * two. `connect` already exists to find orphaned floor and dig a corridor to
   * it — twelve passes of it — so stamping first means the repair pass treats a
   * vault exactly as it treats a cave that generated two chambers. Stamping
   * after it would be the one arrangement that can seal a room permanently.
   *
   * BEFORE the threshold is written, so the arrival tile is restored on the line
   * below whatever the vault did to it. A vault cannot be placed ON the spawn —
   * `isOpen` is false for anything not already floor and the spawn is floor, so
   * it CAN — which is precisely why the threshold is re-asserted afterwards
   * rather than trusted.
   */
  /**
   * ═══ ONE ROOM, DRAWN FROM THE LIST — AND IT USED TO BE ALL OF THEM ═══
   * The first version stamped every vault the shape owned, which meant a works
   * always contained all three and every works was the same works. Upstream
   * rolls for its vaults per level; the variety is meant to be in WHICH room you
   * got, not only in where it landed.
   *
   * THE DRAW IS UNCONDITIONAL, like the two inside `placeVault`: a shape with an
   * empty list (a town) still consumes it, so adding a room to one shape cannot
   * shift the number stream of another.
   */
  const placed: {
    id: string;
    at: { x: number; y: number };
    turn: string;
    w: number;
    h: number;
  }[] = [];
  const forShape = VAULTS_BY_SHAPE[shape] ?? [];
  const pick = rng.int('vault.pick', 0, Math.max(0, forShape.length - 1));
  for (const vault of forShape.length === 0 ? [] : [forShape[pick] ?? forShape[0]]) {
    if (vault === undefined) continue;
    const spot = placeVault(
      vault,
      { w: W, h: H },
      /**
       * BOUNDS AND THE DOOR RING — never occupancy. See `placeVault`: a room may
       * land in rock, because `connect` below digs to any floor it cannot
       * otherwise reach. What it may not do is run off the map, or sit inside
       * `DOOR_CLEARANCE` of the arrival tile.
       *
       * THAT SECOND CLAUSE USED TO BE ONE CELL — `!(x === spawn.x && ...)` — and
       * a single cell is not a clearance. `roomFor` discards every candidate
       * within eight tiles of the door, so a room that landed inside that ring
       * could hold nothing: no guard, no litter, and both fell silently through
       * to the rest of the floor. Over half of caves rolled exactly that.
       */
      (x, y) =>
        x >= MARGIN &&
        y >= MARGIN &&
        x < W - MARGIN &&
        y < H - MARGIN &&
        Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) >= DOOR_CLEARANCE,
      rng,
      /**
       * PREFER GROUND THAT IS ALREADY OPEN. A room made of walls, stamped into
       * rock, writes walls into walls and changes nothing anybody can see — and
       * measured over sixty floors a shape, a third of cave rooms landed exactly
       * there. This counts how much of the footprint is already floor and lets
       * the best spot win; every legal spot stays legal, so a floor with no open
       * rectangle still gets its room rather than none.
       */
      (spot, shape) => {
        let open = 0;
        for (let y = 0; y < shape.h; y += 1) {
          for (let x = 0; x < shape.w; x += 1) {
            if (at(g, spot.x + x, spot.y + y) === TileCode.FLOOR) open += 1;
          }
        }
        return open;
      },
    );
    // NULL IS AN ORDINARY ANSWER. A floor with no open patch big enough simply
    // does not get the room; see `placeVault`.
    if (spot !== null) {
      placed.push({
        id: vault.id,
        at: spot.at,
        turn: spot.turn,
        w: spot.shape.w,
        h: spot.shape.h,
      });
    }
    if (spot !== null) {
      stampVault(spot.shape, spot.at, (x, y, code) => {
        put(g, x, y, code);
      });
      holdRoom(held, spot.shape, spot.at);
    }
  }

  // The threshold is always floor, whatever the shape did to it — you arrive
  // here, and `leaveRealm` treats it as the door.
  put(g, spawn.x, spawn.y, TileCode.FLOOR);
  connect(g, spawn, held);

  /**
   * THE REPAINT, LAST, over the finished grid. The CARVERS put in two codes and
   * two come out — `blank()` fills with WALL and `put` only ever writes FLOOR or
   * WALL — so a third code from that direction would still be a bug rather than
   * something for this line to guess about.
   *
   * ═══ BUT THE VAULT STAMP RUNS BEFORE THIS, AND IT WRITES A THIRD ═══
   * Three rooms in `vaults.ts` carry a `+`, and a DOOR is not FLOOR, so without
   * the guard below it fell into the solid branch and was painted into `roof` —
   * every door on every palette-using floor silently becoming a wall, sealing
   * the room it was the only way into. Caught by two "only two codes" tests one
   * commit after the door codes existed, and the right fix is not to loosen
   * those tests: it is for a door to survive a repaint, because a door is
   * neither the ground nor the building. It is the way through the building.
   *
   * Skipped entirely for the default palette: identity work on 900 cells per
   * realm is cheap, but a no-op that is visibly a no-op is easier to reason
   * about than one that has to be traced.
   */
  const roof = palette.roof ?? palette.wall;
  if (palette.floor !== TileCode.FLOOR || palette.wall !== TileCode.WALL || roof !== palette.wall) {
    for (let i = 0; i < g.length; i += 1) {
      if (g[i] === TileCode.FLOOR) {
        g[i] = palette.floor;
        continue;
      }
      // A DOOR IS ITS OWN MATERIAL. It is drawn from ToME's amber rather than
      // from the site's palette, and it has to stay legible as a door whatever
      // the floor around it is made of.
      if (g[i] === TileCode.DOOR || g[i] === TileCode.DOOR_OPEN) continue;
      /**
       * THE EDGE IS THE BOUNDARY; EVERYTHING ELSE SOLID IS A BUILDING.
       *
       * A border test rather than a flood fill, because the grid always has a
       * closed ring — `blank()` fills with WALL and no carver opens the rim, so
       * "on the edge" and "is the wall around this place" are the same set.
       * Anything solid further in was put there by a carver as a block.
       */
      const x = i % W;
      const y = (i - x) / W;
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      g[i] = edge ? palette.wall : roof;
    }
  }

  return {
    vaults: placed,
    // Only a room generator records rooms, and neither of these two is one.
    rooms: [],
    view: { w: W, h: H, tiles: g },
    spawns: [spawn],
    /** A floor is somewhere you are, not somewhere you leave from. */
    sites: new Map<string, string>(),
  };
}

/** Exposed so a test can assert against the shape the generator was given. */
export const SITE_MAP_SIZE = { w: W, h: H };
