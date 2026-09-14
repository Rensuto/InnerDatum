/**
 * The ambush arena — a small, generated room to be jumped in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY GENERATED WHEN EVERY OTHER MAP IN THIS PROJECT IS AUTHORED
 * ═══════════════════════════════════════════════════════════════════════════
 * The city is authored because a world you cannot learn is not a world, and the
 * inner-worlds are authored because a bad transition must not also be a
 * generation bug. An ambush is the opposite of both: it is somewhere you have
 * never been and will never return to, and its whole job is to be UNFAMILIAR.
 * Reusing one hand-made floor made every ambush the same room, entered at the
 * same corner, with the exit two steps behind you.
 *
 * ToME does exactly this and for the same reason — `GameState.lua` builds a
 * fresh `Zone.new("ambush", …)` per encounter, `width = enc.width or 20`, from
 * a Forest generator rather than a static map.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT COSTS NO ART, WHICH IS WHY THE FLAT-INTERIOR RULE WAS WORTH WRITING DOWN
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR and WALL are the entire vocabulary, and `TILE_SPRITES` in the renderer
 * deliberately has no entry for either, so every room this produces draws
 * correctly the day it is generated. A tiling terrain set would have made each
 * change to this file an art commission — the argument test/client/assets.test.ts
 * pins, arriving at the moment it pays for itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UPSTREAM'S FOREST GENERATOR, AND CAVERN'S FLOOD FILL
 * ═══════════════════════════════════════════════════════════════════════════
 * This was a drunkard's walk carving open ground out of solid rock, which made
 * every ambush a cave: about a third of the box walkable on the default ground.
 * Upstream's ambush is its Forest generator (`GameState.lua:797-803`), open
 * country with trees in it, and a sealed room of that is about four fifths
 * open. A player put the difference as the fight space feeling small.
 *
 * So each cell is upstream's roll (`Forest.lua:147-152`): seeded noise turned
 * into a percentage, a tree on a roll under it where the noise runs high, and a
 * tree on a roll under its square root where it runs low. `zoom` sets how wide
 * the clearings are and `sqrtPercent` where the thickets start, and each ground
 * takes both from an upstream zone of its own kind of country.
 *
 * NOISE STRANDS POCKETS, which the walk never did. Upstream's Cavern keeps its
 * largest open region and fills the rest (`Cavern.lua:98-106`); here the region
 * kept is the arrival's, since that is where you are. Cavern also rebuilds a
 * level whose region is too small (`Cavern.lua:100-109`), and here that is a
 * room under a third of its interior: on the densest grounds about one arena in
 * a thousand shuts the arrival tile inside a ring of trees.
 *
 * PURE, and seeded from `shared/rng.ts` with labelled draws, so an ambush is
 * reproducible from the realm that caused it. `src/shared/` bans `Math.random`
 * outright (CLAUDE.md § 3); this file could not cheat if it wanted to.
 */

import { tileIndex } from './coords.ts';
import { createNoise2 } from './noise.ts';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { TileCode } from './protocol.ts';
import type { TileXY } from './coords.ts';
import { Ground } from './level.ts';
import type { AuthoredMap } from './level.ts';

/**
 * Big enough to manoeuvre, small enough to read as one room.
 *
 * The viewport is about twenty tiles wide at the smallest size this game ships
 * (canvas.ts `MAX_TILES_*` caps it at 48x32), so 24x24 is a room you can nearly
 * see the whole of — which is the point of an arena, as against a floor you
 * explore. ToME's ambush is 20x20 by default (`GameState.lua:826`) and its
 * encounters ask for 14 or 18. This stays at 24, because the fight space was
 * already the complaint and upstream's open ground on 24x24 is twice the room
 * the walk used to carve.
 */
const ARENA_W = 24;
const ARENA_H = 24;

/** Upstream's default ceiling on the noise percentage (`Forest.lua:36`). */
const MAX_PERCENT = 80;

/** Upstream's default octaves of noise (`Forest.lua:41`). */
const OCTAVES = 4;

/**
 * The smallest room kept, as a share of the interior, before the arena is built
 * again. Upstream's Cavern asks for a count of open cells instead
 * (`Cavern.lua:37`); a share is the same rule for a room of fixed size.
 */
const MIN_KEPT = 1 / 3;

/** How many builds before the last is kept whatever it is: this runs inside a move. */
const MAX_BUILDS = 8;

/** One cell of margin stays solid, so the arena is always sealed. */
const MARGIN = 1;

/** The eight steps a body can take, which is what joins one open cell to the next. */
const STEPS: readonly TileXY[] = Object.freeze([
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIX ROOMS, ONE PER KIND OF COUNTRY. The ground you were caught on decides.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream builds every world ambush with one set of numbers and swaps only the
 * tiles, sand and palms for the desert (`GameState.lua:815`). The moor here is
 * classified into six grounds, and a room per ground is a fight per ground, so
 * each takes its `zoom` and `sqrtPercent` from an upstream outdoor zone of the
 * same kind of country. The mapping is this file's; every number is upstream's.
 *
 * ═══ UPLAND IS UPSTREAM'S AMBUSH, TO THE DIGIT ═══
 * A zoom of 10 and a `sqrt_percent` of 50 (`GameState.lua:802-803`). UPLAND is
 * the default room, so a caller that knows nothing about terrain gets the
 * ambush upstream would have built.
 */
const ARENAS: Readonly<
  Record<
    Ground,
    {
      readonly floor: TileCode;
      readonly wall: TileCode;
      readonly zoom: number;
      readonly sqrtPercent: number;
      readonly channels: number;
    }
  >
> = {
  // Almost no cover. A ranged monster owns you until you close the distance.
  // The Golem Graveyard's meadow (`data/zones/golem-graveyard/zone.lua:39-40`).
  [Ground.Open]: {
    floor: TileCode.PLAINS,
    wall: TileCode.TREES,
    zoom: 4,
    sqrtPercent: 70,
    channels: 0,
  },
  // UPSTREAM'S AMBUSH, and the default.
  [Ground.Upland]: {
    floor: TileCode.HILLS,
    wall: TileCode.CRAG,
    zoom: 10,
    sqrtPercent: 50,
    channels: 0,
  },
  // Short sightlines between thickets, and melee is on you before you see it.
  // Trollmire (`data/zones/trollmire/zone.lua:50-51`).
  [Ground.Wood]: {
    floor: TileCode.GREEN,
    wall: TileCode.TREES,
    zoom: 7,
    sqrtPercent: 30,
    channels: 0,
  },
  // Scorched ground with stands of dead trees to put between you and them. The
  // Mark of the Spellblaze (`data/zones/mark-spellblaze/zone.lua:40-41`).
  [Ground.Scree]: {
    floor: TileCode.SOOT,
    wall: TileCode.CRAG,
    zoom: 4,
    sqrtPercent: 45,
    channels: 0,
  },
  // A walled yard: the Ring of Blood's arena (`data/zones/ring-of-blood/zone.lua:41-42`).
  [Ground.Walls]: {
    floor: TileCode.COBBLE,
    wall: TileCode.TERRACE,
    zoom: 5,
    sqrtPercent: 30,
    channels: 0,
  },
  // ═══ THE FREE ONE, AND THE BEST FIGHT IN THE SET ═══
  // WATER STOPS A BODY AND NOT AN EYE — `protocol.ts` names it as the one code
  // in neither set's complement, "solid, and transparent". A channel across a
  // fen is genuine ranged tactics with ZERO engine change: shoot across it while
  // nothing can reach you, or walk the long way round if you cannot.
  // Slazish Fen's bog (`data/zones/slazish-fen/zone.lua:43-44`).
  [Ground.Fen]: {
    floor: TileCode.MIRE,
    wall: TileCode.TREES,
    zoom: 7,
    sqrtPercent: 30,
    channels: 2,
  },
};

/**
 * One build of the room: upstream's roll for every cell, then the arrival's
 * region kept and every other pocket filled.
 */
function forest(
  rng: Rng,
  spec: { readonly zoom: number; readonly sqrtPercent: number },
  centre: TileXY,
  build: number,
): { readonly tiles: number[]; readonly kept: number } {
  const tiles = new Array<number>(ARENA_W * ARENA_H).fill(TileCode.WALL);
  const noise = createNoise2(rng, `arena.noise.${String(build)}`);

  // `Forest.lua:148-152`, which counts its cells from 1. One roll a cell, from
  // 0 to 99 and under the chance: `rng.percent` is engine C the reference tree
  // does not carry, and that is its usual reading. The margin stays solid so the
  // room is sealed.
  for (let x = MARGIN; x < ARENA_W - MARGIN; x += 1) {
    for (let y = MARGIN; y < ARENA_H - MARGIN; y += 1) {
      const n = noise.fbmPerlin(
        (spec.zoom * (x + 1)) / ARENA_W,
        (spec.zoom * (y + 1)) / ARENA_H,
        OCTAVES,
      );
      const v = Math.floor((n / 2 + 0.5) * MAX_PERCENT);
      const roll = rng.int('arena.tree', 0, 99);
      const tree = v >= spec.sqrtPercent ? roll < v : roll < Math.sqrt(v);
      if (!tree) tiles[tileIndex(x, y, ARENA_W)] = TileCode.FLOOR;
    }
  }

  // YOU ARRIVE HERE, so it is ground whatever the roll said.
  tiles[tileIndex(centre.x, centre.y, ARENA_W)] = TileCode.FLOOR;

  // THE ARRIVAL'S REGION, AND NOTHING ELSE (`Cavern.lua:98-106`).
  const seen = new Set<number>([tileIndex(centre.x, centre.y, ARENA_W)]);
  const queue: TileXY[] = [centre];
  while (queue.length > 0) {
    const at = queue.pop();
    if (at === undefined) break;
    for (const step of STEPS) {
      const nx = at.x + step.x;
      const ny = at.y + step.y;
      if (nx < 0 || ny < 0 || nx >= ARENA_W || ny >= ARENA_H) continue;
      const i = tileIndex(nx, ny, ARENA_W);
      if (seen.has(i) || tiles[i] !== TileCode.FLOOR) continue;
      seen.add(i);
      queue.push({ x: nx, y: ny });
    }
  }
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] === TileCode.FLOOR && !seen.has(i)) tiles[i] = TileCode.WALL;
  }
  return { tiles, kept: seen.size };
}

/**
 * Build one arena.
 *
 * `seed` should name the realm this belongs to, so two parties ambushed at the
 * same moment get two different rooms and the same party re-entering the same
 * realm gets the same one back.
 *
 * `ground` is where the party was standing when something reached them. It
 * defaults to UPLAND, upstream's own ambush.
 */
export function makeArena(seed: string, ground: Ground = Ground.Upland): AuthoredMap {
  const spec = ARENAS[ground];
  const rng = createRng(seed);
  const centre: TileXY = { x: Math.floor(ARENA_W / 2), y: Math.floor(ARENA_H / 2) };
  const interior = (ARENA_W - MARGIN * 2) * (ARENA_H - MARGIN * 2);

  // BUILT AGAIN WHILE THE ROOM IS TOO SMALL (`Cavern.lua:100-109`), and bounded.
  let built = forest(rng, spec, centre, 0);
  for (let build = 1; build < MAX_BUILDS && built.kept < interior * MIN_KEPT; build += 1) {
    built = forest(rng, spec, centre, build);
  }
  const { tiles } = built;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE CHANNEL, AND IT IS A LINE WITH A FORD — NOT A SCATTER OF PUDDLES.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE FIRST VERSION OF THIS WAS MEASURED AND DID NOTHING, which is the whole
   * reason it is written the way it is now. It grew three water cells by random
   * walk and vetoed any cell that disconnected the room — and the cells it
   * vetoed were exactly the ones that would have made the water a BARRIER. What
   * survived was 25 scattered tiles in a 187-tile room: measured over twelve
   * arenas, the mean extra steps to reach a cell you could already shoot was
   * **0.03**. A puddle you step over is not tactics.
   *
   * So the channel is now a straight cut across the room with ONE FORD left in
   * it. That gives the two facts the fen exists for, and gives them by
   * construction rather than by luck:
   *
   *   YOU CAN SHOOT ACROSS IT.  `protocol.ts` names WATER as the one code in
   *     neither set's complement — *"solid, and transparent"* — so it stops a
   *     body and not an eye. Zero engine change; the trace already honours it.
   *   YOU CANNOT WALK ACROSS IT, except at the ford. Which is what makes the
   *     shot worth taking: for the turns it takes them to come round, they are
   *     something you can hit and that cannot hit back.
   *
   * THE FORD IS WHAT KEEPS THE PROMISE. This room must let an ambush come at you
   * from every side — *"an ambush that surrounds you needs room on every side"* —
   * so a cut with no crossing would strand half the roster behind the water and
   * turn the fight into a shooting gallery. One crossing is a decision; none is
   * a bug. The whole channel is reverted if the ford turns out not to be enough,
   * because a room that must be right is worth building twice.
   */
  if (spec.channels > 0) {
    const isFloor = (cx: number, cy: number): boolean =>
      tiles[tileIndex(cx, cy, ARENA_W)] === TileCode.FLOOR;

    /** How many floor cells the centre can still walk to. The promise, counted. */
    const reachable = (): number => {
      const seen = new Set<number>([tileIndex(centre.x, centre.y, ARENA_W)]);
      const queue: TileXY[] = [centre];
      while (queue.length > 0) {
        const at = queue.pop();
        if (at === undefined) break;
        for (const d of STEPS) {
          const nx = at.x + d.x;
          const ny = at.y + d.y;
          if (nx < 0 || ny < 0 || nx >= ARENA_W || ny >= ARENA_H) continue;
          const i = tileIndex(nx, ny, ARENA_W);
          if (seen.has(i) || !isFloor(nx, ny)) continue;
          seen.add(i);
          queue.push({ x: nx, y: ny });
        }
      }
      return seen.size;
    };

    let floorCells = 0;
    for (const t of tiles) if (t === TileCode.FLOOR) floorCells += 1;

    for (let c = 0; c < spec.channels; c += 1) {
      // ACROSS THE WHOLE ROOM, alternating axis, so two channels cannot lie on
      // top of each other and cancel out into one thick band.
      const vertical = c % 2 === 0;
      const span = vertical ? ARENA_W : ARENA_H;
      const across = vertical ? ARENA_H : ARENA_W;
      // OFF THE ARRIVAL TILE. The centre stays walkable and so do its
      // neighbours: you arrive there, and arriving in water is a body standing
      // where `canWalk` says it cannot.
      let line = rng.int('arena.fen.line', MARGIN + 2, span - MARGIN - 3);
      if (Math.abs(line - (vertical ? centre.x : centre.y)) <= 1) line += 2;
      const ford = rng.int('arena.fen.ford', MARGIN, across - MARGIN - 1);

      const flooded: number[] = [];
      for (let k = MARGIN; k < across - MARGIN; k += 1) {
        // THE FORD, AND THE TILE EITHER SIDE OF IT. One cell is a crossing a
        // pathfinder can miss on a diagonal; three is a crossing a player can
        // see and aim for.
        if (Math.abs(k - ford) <= 1) continue;
        const x = vertical ? line : k;
        const y = vertical ? k : line;
        if (Math.abs(x - centre.x) <= 1 && Math.abs(y - centre.y) <= 1) continue;
        if (!isFloor(x, y)) continue;
        const i = tileIndex(x, y, ARENA_W);
        tiles[i] = TileCode.WATER;
        flooded.push(i);
      }

      // ALL OR NOTHING. Checked once for the whole cut rather than per cell,
      // because a cut is only a cut when it is complete — the per-cell veto is
      // precisely what turned the first version into puddles.
      if (reachable() < floorCells - flooded.length) {
        for (const i of flooded) tiles[i] = TileCode.FLOOR;
      } else {
        floorCells -= flooded.length;
      }
    }
  }

  /**
   * THE REPAINT, LAST, and it is the same two-code substitution `makeSiteMap`
   * uses: the generator ran unchanged, drew the same numbers in the same order
   * for this ground, and only the codes it wrote are renamed on the way out.
   * WATER is left alone — it is neither of the two, and it is the point.
   */
  if (spec.floor !== TileCode.FLOOR || spec.wall !== TileCode.WALL) {
    for (let i = 0; i < tiles.length; i += 1) {
      if (tiles[i] === TileCode.FLOOR) tiles[i] = spec.floor;
      else if (tiles[i] === TileCode.WALL) tiles[i] = spec.wall;
    }
  }

  return {
    view: { w: ARENA_W, h: ARENA_H, tiles },
    /**
     * YOU ARRIVE IN THE MIDDLE, which is the whole difference from the floor
     * this replaced. `forest` makes the centre ground and keeps only what joins
     * it — and an ambush that surrounds
     * you needs room on every side, which a corner cannot give.
     */
    spawns: [centre],
    /** An arena is a fight, not a place. Nothing leads anywhere from here. */
    sites: new Map<string, string>(),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GROUND BUILT THIS ROOM — READ BACK OFF ITS OWN FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The population of an ambush wants to know the ground (a cairn belongs in the
 * fen and nowhere else), and `SiteDef.populate` is handed the map rather than
 * the ground. The obvious move is to thread `ground` through `populate` as well
 * — a second parameter, on a hook every site implements, to carry a fact the
 * map already contains.
 *
 * IT ALREADY CONTAINS IT. Every ground paints a DIFFERENT floor code, so the
 * room is its own record of what made it, and a reverse lookup is exact rather
 * than a guess. One fact, one place, and nothing to keep in step.
 *
 * Falls back to UPLAND — the default room — for a map this file did not build,
 * which is every fixture and every authored site.
 */
export function arenaGround(map: AuthoredMap): Ground {
  const centre = arenaCentre();
  const floor = map.view.tiles[tileIndex(centre.x, centre.y, map.view.w)];
  for (const [ground, spec] of Object.entries(ARENAS)) {
    if (spec.floor === floor) return ground as Ground;
  }
  return Ground.Upland;
}

/** Where you arrive, exported so a test can assert against it. */
export function arenaCentre(): TileXY {
  return { x: Math.floor(ARENA_W / 2), y: Math.floor(ARENA_H / 2) };
}

/**
 * WHAT WAS HERE: `isArenaFloor`, whose doc claimed it was *"used by tests and by
 * the seeder"* and which had ZERO callers anywhere in src, test or tools. The
 * seeder asks `canWalk` (encounter.ts:267, :428), which reads the terrain sets
 * and therefore keeps working on a repainted arena.
 *
 * Deleted rather than fixed, because it compared to `TileCode.FLOOR`: the moment
 * an arena's floor is HILLS or MIRE it would answer false for every tile in the
 * room, and a dead function with a confident stale doc block is exactly what
 * somebody reaches for in a hurry.
 */
