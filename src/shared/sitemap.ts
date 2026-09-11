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
 * Every generator here finishes by carving from the spawn to anything it
 * stranded, so "can the player reach the far side" is a property of the
 * algorithm. A sealed pocket in a hand-authored map is a bug somebody notices;
 * in a generated one it is a bug that appears one run in fifty and cannot be
 * reproduced from a description.
 *
 * PURE, and seeded from shared/rng.ts with labelled draws, so a floor is
 * reproducible from the realm that opened it.
 */

import { tileIndex } from './coords.ts';
import { createRng } from './rng.ts';
import { TileCode } from './protocol.ts';
import { partition } from './bsp.ts';
import { placeVault, stampVault } from './vault.ts';
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
  /** Winding galleries. Mines, the Underworks, anything dug. */
  Cave: 'cave',
  /** Mostly open, with broken fragments of wall. Chapels, altars, wreckage. */
  Ruin: 'ruin',
  /** A regular grid of blocks and corridors. Works, archives, anything built. */
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
 * The smallest room BSP may cut for a works floor.
 *
 * FOUR, because one tile of it is spent on the shared wall at each edge: a leaf
 * of four is a room of two, which is the smallest thing a player can stand in
 * and still call a room. Three would tile more finely and produce corridors
 * with doors on them rather than rooms.
 */
const WORKS_MIN_ROOM = 7;

/**
 * The percentage of a works floor's doorways that get an actual door.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S NUMBER IS 50 AND OURS IS NOT, BECAUSE THE DENOMINATOR DIFFERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Roomer.lua:33` defaults `door_chance` to 50 and `RoomsLoader.lua:921-928`
 * spends it exactly this way — a percentage roll per candidate. Carrying the 50
 * across would have been the wrong kind of faithful, because the CANDIDATE SET
 * is not the same set.
 *
 * Upstream registers a candidate only where a TUNNEL crossed a room wall
 * (`RoomsLoader.lua:912`, the `t[3]` flag set while tunnelling), so a floor
 * offers a handful. Ours surveys the finished map, and our corridors run centre
 * to centre across the whole building rather than room to room — so one
 * corridor crosses several rooms' walls on its way and a floor offers about
 * THIRTY-THREE. Measured over eighty seeds: 50% of those is a mean of sixteen
 * doors a delve, a pause every few steps.
 *
 * EIGHTEEN IS THE SHARE THAT REPRODUCES UPSTREAM'S DENSITY rather than its
 * percentage — about six doors on a 34x30 floor of ten rooms, so half the rooms
 * have one and crossing the building is not a sequence of pauses. The number
 * that is being ported here is the FEELING of a door being worth noticing, and
 * the percentage is the thing that had to move to keep it.
 */
const DOOR_CHANCE = 18;

const W = 34;
const H = 30;
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

/** A straight corridor. The only thing every shape below has in common. */
function corridor(g: Grid, a: TileXY, b: TileXY): void {
  let { x, y } = a;
  while (x !== b.x) {
    put(g, x, y, TileCode.FLOOR);
    x += x < b.x ? 1 : -1;
  }
  while (y !== b.y) {
    put(g, x, y, TileCode.FLOOR);
    y += y < b.y ? 1 : -1;
  }
  put(g, b.x, b.y, TileCode.FLOOR);
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
 * A CAVE: a walk that wanders and is pulled back, the same shape the ambush
 * arena uses and for the same reason — a walk opens only cells it stood on, so
 * one connected region is a property of the algorithm.
 */
function cave(g: Grid, rng: Rng): TileXY {
  const start: TileXY = { x: Math.floor(W / 2), y: Math.floor(H / 2) };
  let x = start.x;
  let y = start.y;
  const target = Math.floor((W - 2) * (H - 2) * 0.38);
  let open = 0;
  const steps: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let i = 0; i < W * H * 30 && open < target; i += 1) {
    // Pulled back to the middle periodically, or the walk drifts into one
    // corner and hollows it out — the exact failure the arena had.
    if (i % 90 === 0) {
      x = start.x;
      y = start.y;
    }
    const step = steps[rng.int('site.cave.step', 0, steps.length - 1)];
    if (step === undefined) continue;
    const nx = x + step[0];
    const ny = y + step[1];
    if (nx < MARGIN || ny < MARGIN || nx >= W - MARGIN || ny >= H - MARGIN) continue;
    x = nx;
    y = ny;
    if (at(g, x, y) !== TileCode.FLOOR) {
      put(g, x, y, TileCode.FLOOR);
      open += 1;
    }
  }
  return start;
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
  const fragments = rng.int('site.ruin.count', 14, 22);
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
 * WORKS: ROOMS AND CORRIDORS, CUT BY `BSP.lua`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The only shape here that is deliberately BUILT, and until now it was a
 * LATTICE: `room(...)` filled the floor and a nested loop stamped square blocks
 * on a fixed pitch, with one gallery through the middle so the grid had a
 * spine. It read as industrial and it was not a building — every cell was the
 * same size, every junction was the same junction, and there was nowhere a
 * player could be said to be IN.
 *
 * `shared/bsp.ts` cuts the rectangle into rooms of genuinely different sizes.
 * Each leaf gets a floor inset one tile from its own bounds, so the walls
 * BETWEEN rooms are what is left rather than something drawn — which is
 * upstream's trick and the reason the result never has a double wall.
 *
 * ═══ AND IT IS WHERE THE DOORS FINALLY LIVE ═══
 * A door was terrain with nowhere to be: `shared/vaults.ts` carries three, and
 * a vault lands on maybe half of floors. A room cut by BSP has a MOUTH by
 * construction — the one tile a corridor punches through its wall — and that is
 * what a door is for. Every corridor here ends in one.
 *
 * ═══ EVERY EXISTING WORKS FLOOR CHANGES, AND THAT IS SAFE ═══
 * A delve is rebuilt per instance from the realm seed and no floor is ever
 * persisted (`content/delve.ts`: *"the same party re-entering finds the room
 * they left"* is a property of the SEED, not of a save). So this is not a
 * migration; it is the next party through the door finding a different
 * building. `connect` still runs afterwards, so reachability is true by
 * construction whatever the corridors did.
 */
function works(g: Grid, rng: Rng): TileXY {
  const tree = partition(
    W - MARGIN * 2,
    H - MARGIN * 2,
    WORKS_MIN_ROOM,
    WORKS_MIN_ROOM,
    rng,
    'site.works.bsp',
  );

  /** A leaf's floor: inset one tile, so neighbours share the wall between them. */
  const inner = (leaf: { x: number; y: number; w: number; h: number }) => ({
    x0: leaf.x + MARGIN + 1,
    y0: leaf.y + MARGIN + 1,
    x1: leaf.x + MARGIN + leaf.w - 2,
    y1: leaf.y + MARGIN + leaf.h - 2,
  });

  const centres: TileXY[] = [];
  for (const leaf of tree.leaves) {
    const at = inner(leaf);
    // A LEAF CAN BE TOO THIN TO HOLD ANYTHING once the inset is taken — the
    // minimum is a bound on the CUT, not on what survives the wall. Skipping is
    // honest: it leaves solid rock where a room would have been one tile wide,
    // which reads as structure rather than as a corridor with a door on it.
    if (at.x1 < at.x0 || at.y1 < at.y0) continue;
    room(g, at.x0, at.y0, at.x1, at.y1, TileCode.FLOOR);
    centres.push({
      x: Math.floor((at.x0 + at.x1) / 2),
      y: Math.floor((at.y0 + at.y1) / 2),
    });
  }

  /**
   * CONNECTED IN LEAF ORDER, WHICH IS THE TREE'S OWN ORDER.
   *
   * `partition` finishes a subtree before it starts its sibling, so consecutive
   * leaves are usually neighbours and a corridor between them is short. Sorting
   * by distance would make prettier corridors and would also make the layout
   * depend on a comparison rather than on the seed — the same argument
   * `delve.ts` makes for computing the boss tile instead of rolling it.
   */
  for (let i = 1; i < centres.length; i += 1) {
    const from = centres[i - 1];
    const to = centres[i];
    if (from === undefined || to === undefined) continue;
    corridor(g, from, to);
  }

  return centres[0] ?? { x: Math.floor(W / 2), y: Math.floor(H / 2) };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DOOR WHERE SOMETHING BROKE THROUGH A WALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SURVEY OF THE FINISHED MAP, and it must be exactly that. A tile is a
 * doorway if it is floor, the two tiles on ONE axis are solid, and the opening
 * leads into something wider than itself. Nothing else on this map produces
 * that shape.
 *
 * ═══ IT READS THE MAP RATHER THAN REMEMBERING THE CUT, AND IT HAD TO LEARN ═══
 * The first version took the BSP tree and walked each leaf's own boundary,
 * hung inside `works`. That is the map as the ROOMS were cut, and three things
 * write floor afterwards: `connect` repairs stranded pockets, the vault stamp
 * drops a drawn room in, and both can open the ground beside a tile that was a
 * doorway a moment earlier — leaving a door standing in the open with floor on
 * all four sides, which is a turn's delay in the middle of a room.
 *
 * Measured: a door at 5,20 on the fifth seed, put there by the VAULT rather
 * than by `connect`, which is why moving the call inside `works` fixed nothing.
 * A survey that runs last cannot disagree with the map it surveys.
 *
 * ═══ AND IT NEEDS NO TREE, WHICH IS WHAT MAKES RUNNING LAST POSSIBLE ═══
 * The leaf bounds were only ever there to tell a room's mouth from a corridor's
 * pinch — a one-tile corridor is walls-on-one-axis for its whole length. The
 * `opensWide` test asks that directly: at least one side of the gap has to lead
 * somewhere broader than a single tile.
 *
 * ═══ NOT EVERY MOUTH, BECAUSE A FLOOR OF DOORS IS A FLOOR OF STOPPING ═══
 * A door costs a turn to open and blocks sight until it is. On a building with
 * a dozen mouths that is a dozen pauses crossing one delve, which is the
 * opposite of what the tile is for — it should mark the rooms worth committing
 * to. `DOOR_CHANCE` is the share, drawn per mouth so the same floor always
 * hangs the same doors.
 */
function hangDoors(g: Grid, rng: Rng, spawn: TileXY): void {
  /**
   * Does this neighbour lead into a ROOM rather than into another corridor?
   *
   * BOTH sides, not either. A tile with floor on one side is in something two
   * wide, which is a corridor junction; a tile with floor on both is in a span
   * of at least three, which is a room.
   *
   * ═══ `vertical` IS THE AXIS OF DEPTH, NOT THE AXIS OF THE DOORWAY ═══
   * It was called `alongX` and that name was simply wrong: for a doorway with
   * walls east and west, the room lies NORTH or SOUTH and the question is how
   * far it runs THAT way — so the call passes `true` and the body measures the
   * vertical span. The parameter names the span being measured, which is always
   * perpendicular to the wall the door sits in.
   */
  const opensWide = (x: number, y: number, vertical: boolean): boolean => {
    if (at(g, x, y) !== TileCode.FLOOR) return false;
    return vertical
      ? at(g, x, y - 1) === TileCode.FLOOR && at(g, x, y + 1) === TileCode.FLOOR
      : at(g, x - 1, y) === TileCode.FLOOR && at(g, x + 1, y) === TileCode.FLOOR;
  };

  let seen = 0;
  for (let y = MARGIN; y < H - MARGIN; y += 1) {
    for (let x = MARGIN; x < W - MARGIN; x += 1) {
      if (at(g, x, y) !== TileCode.FLOOR) continue;
      // NEVER THE ARRIVAL TILE. Being asked to open a door before the map has
      // finished drawing is `delve.ts`'s named bug report, one tile further in.
      if (x === spawn.x && y === spawn.y) continue;

      // SOLID ON BOTH SIDES OF EXACTLY ONE AXIS. Walls north and south is a
      // horizontal doorway; east and west is a vertical one. Requiring one and
      // not the other is what excludes a corner.
      const wallNS = at(g, x, y - 1) === TileCode.WALL && at(g, x, y + 1) === TileCode.WALL;
      const wallEW = at(g, x - 1, y) === TileCode.WALL && at(g, x + 1, y) === TileCode.WALL;
      if (wallNS === wallEW) continue;

      // AND IT LEADS SOMEWHERE. A pinch in a long corridor has walls on one
      // axis too, and a door halfway down a passage is a delay with no room
      // behind it.
      const wide = wallNS
        ? opensWide(x - 1, y, false) || opensWide(x + 1, y, false)
        : opensWide(x, y - 1, true) || opensWide(x, y + 1, true);
      if (!wide) continue;

      seen += 1;
      if (rng.int(`site.works.door.${String(seen)}`, 1, 100) > DOOR_CHANCE) continue;
      put(g, x, y, TileCode.DOOR);
    }
  }
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
 * Carve from the spawn to anything the shape stranded.
 *
 * Flood from the spawn, then run a corridor to the nearest cell of each
 * unreached pocket, repeatedly, until everything walkable is connected. Cheap
 * on a 34x30 grid and it makes "the far side is reachable" true by construction
 * rather than by inspection.
 */
function connect(g: Grid, from: TileXY): void {
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
    corridor(g, from, orphan);
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
  const rng = createRng(seed);
  const g = blank();

  const spawn =
    shape === SiteShape.Town
      ? town(g, rng)
      : shape === SiteShape.Cave
        ? cave(g, rng)
        : shape === SiteShape.Ruin
          ? ruin(g, rng)
          : works(g, rng);

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
       * the best spot win; every legal spot stays legal, so a works with no open
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
    if (spot !== null)
      stampVault(spot.shape, spot.at, (x, y, code) => {
        put(g, x, y, code);
      });
  }

  // The threshold is always floor, whatever the shape did to it — you arrive
  // here, and `leaveRealm` treats it as the door.
  put(g, spawn.x, spawn.y, TileCode.FLOOR);
  connect(g, spawn);

  /**
   * AND THE DOORS, LAST OF EVERYTHING THAT WRITES FLOOR — see `hangDoors`.
   *
   * WORKS ONLY. A cave and a ruin are not built and have no mouths to hang one
   * on; a town is drawn at world-map scale where a door would be a pixel. The
   * same split `content/delve.ts` makes for traps: somebody has to have PUT it
   * there.
   *
   * BEFORE THE PALETTE REPAINT, which is not a preference: the survey compares
   * against `TileCode.FLOOR` and `TileCode.WALL`, and after a repaint a works
   * floor is SOOT on CRAG and every one of those tests answers false.
   */
  if (shape === SiteShape.Works) hangDoors(g, rng, spawn);

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
    view: { w: W, h: H, tiles: g },
    spawns: [spawn],
    /** A floor is somewhere you are, not somewhere you leave from. */
    sites: new Map<string, string>(),
  };
}

/** Exposed so a test can assert against the shape the generator was given. */
export const SITE_MAP_SIZE = { w: W, h: H };
