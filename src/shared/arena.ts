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
 * A DRUNKARD'S WALK, AND THE CHOICE IS ABOUT CONNECTIVITY
 * ═══════════════════════════════════════════════════════════════════════════
 * Cellular automata make prettier caves and need a flood fill afterwards to
 * find and discard the pockets they strand. A walk carves a single connected
 * region BY CONSTRUCTION — every cell it opens, it opened by standing on it —
 * so "can the player reach the monsters" is answered by the algorithm rather
 * than by a repair pass. On a room this small, prettier is worth less than
 * provably-connected.
 *
 * PURE, and seeded from `shared/rng.ts` with labelled draws, so an ambush is
 * reproducible from the realm that caused it. `src/shared/` bans `Math.random`
 * outright (CLAUDE.md § 3); this file could not cheat if it wanted to.
 */

import { tileIndex } from './coords.ts';
import { createRng } from './rng.ts';
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
 * explore. ToME's ambush is 20x20 for the same reason.
 */
const ARENA_W = 24;
const ARENA_H = 24;

/**
 * WHERE THE ONE FRACTION WENT: it is per-ground now, in `ARENAS` below, and the
 * range it used to describe is what makes six rooms out of one generator.
 *
 * *Below about a third the room is a corridor system and a ranged monster can
 * never be reached; above about a half it is an empty box and the walls stop
 * meaning anything.* Both of those were written as failure modes to stay
 * between — and both are now a ground: WOOD is the corridor system (0.34,
 * deliberately neutering anything that shoots) and OPEN is the empty box (0.62,
 * deliberately leaving you nowhere to hide). UPLAND keeps 0.42 exactly, because
 * it is the room the game already ships.
 */

/** One cell of margin stays solid, so the arena is always sealed. */
const MARGIN = 1;

/**
 * The eight steps, in a fixed order.
 *
 * ORDER IS PART OF THE SEED CONTRACT: the walk picks an index, so reordering
 * this array changes every arena ever generated from every seed. Same rule
 * `DIR_ORDER` states in coords.ts and for the same reason.
 */
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
 * Until now every ambush was the same 24x24 walk through the same two tile
 * codes, whatever you were standing on — so the moor's forest, its range and its
 * fen were a picture you crossed rather than ground you got caught on.
 *
 * Each ground moves TWO dials and nothing else: how much of the room is opened,
 * and what the two codes are. That is enough, because `openFraction` is the
 * whole character of a fight — this file already says so in as many words:
 * *"below about a third the room is a corridor system and a ranged monster can
 * never be reached; above about a half it is an empty box and the walls stop
 * meaning anything."* Those two failure modes are exactly what WOOD and OPEN
 * are FOR.
 *
 * ═══ UPLAND IS TODAY'S ROOM, TO THE DIGIT, AND THAT IS DELIBERATE ═══
 * 0.42 is the value that has shipped since the arena existed, and UPLAND is the
 * default. So the fight the game already has is unchanged for everybody, and the
 * five new ones are new — if somebody reports that fights feel different there
 * is exactly one change to look at rather than six. Retuning the old room in the
 * same commit that adds five would make that unanswerable.
 */
const ARENAS: Readonly<
  Record<
    Ground,
    {
      readonly floor: TileCode;
      readonly wall: TileCode;
      readonly openFraction: number;
      readonly channels: number;
    }
  >
> = {
  // Almost no cover. A ranged monster owns you until you close the distance,
  // which is the fight the open moor should be.
  [Ground.Open]: {
    floor: TileCode.PLAINS,
    wall: TileCode.TREES,
    openFraction: 0.62,
    channels: 0,
  },
  // TODAY'S ROOM. Knots of dead ground, the default, and the only one of the six
  // whose numbers are not new.
  [Ground.Upland]: {
    floor: TileCode.HILLS,
    wall: TileCode.CRAG,
    openFraction: 0.42,
    channels: 0,
  },
  // Sightlines of a few tiles. Ranged monsters are neutered and melee is on you
  // before you see it — the first reason on this map to walk INTO the trees, or
  // to keep well out of them.
  [Ground.Wood]: {
    floor: TileCode.GREEN,
    wall: TileCode.TREES,
    openFraction: 0.34,
    channels: 0,
  },
  // Corridors. You fight them one at a time if you pick the right one, which
  // makes this the only ground that rewards choosing where to stand.
  [Ground.Scree]: {
    floor: TileCode.SOOT,
    wall: TileCode.CRAG,
    openFraction: 0.36,
    channels: 0,
  },
  // A yard with real corners.
  [Ground.Walls]: {
    floor: TileCode.COBBLE,
    wall: TileCode.TERRACE,
    openFraction: 0.46,
    channels: 0,
  },
  // ═══ THE FREE ONE, AND THE BEST FIGHT IN THE SET ═══
  // WATER STOPS A BODY AND NOT AN EYE — `protocol.ts` names it as the one code
  // in neither set's complement, "solid, and transparent". A channel across a
  // fen is genuine ranged tactics with ZERO engine change: shoot across it while
  // nothing can reach you, or walk the long way round if you cannot.
  [Ground.Fen]: {
    floor: TileCode.MIRE,
    wall: TileCode.TREES,
    openFraction: 0.44,
    channels: 2,
  },
};

/**
 * Build one arena.
 *
 * `seed` should name the realm this belongs to, so two parties ambushed at the
 * same moment get two different rooms and the same party re-entering the same
 * realm gets the same one back.
 *
 * `ground` is where the party was standing when something reached them. It
 * defaults to UPLAND, which is the room this generator has always built, so a
 * caller that knows nothing about terrain gets exactly what it used to get.
 */
export function makeArena(seed: string, ground: Ground = Ground.Upland): AuthoredMap {
  const spec = ARENAS[ground];
  const rng = createRng(seed);
  const tiles: number[] = new Array<number>(ARENA_W * ARENA_H).fill(TileCode.WALL);

  const centre: TileXY = { x: Math.floor(ARENA_W / 2), y: Math.floor(ARENA_H / 2) };
  const interior = (ARENA_W - MARGIN * 2) * (ARENA_H - MARGIN * 2);
  const target = Math.floor(interior * spec.openFraction);

  let x = centre.x;
  let y = centre.y;
  let open = 0;

  const carve = (cx: number, cy: number): void => {
    const i = tileIndex(cx, cy, ARENA_W);
    if (tiles[i] === TileCode.FLOOR) return;
    tiles[i] = TileCode.FLOOR;
    open += 1;
  };

  carve(x, y);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE WALKER IS RETURNED TO THE CENTRE PERIODICALLY, AND WITHOUT THAT THIS
   * GENERATOR IS UNUSABLE.
   * ═════════════════════════════════════════════════════════════════════════
   * A plain random walk DRIFTS. Left alone it wanders into one region and
   * hollows it out, and the first arenas this produced opened the top-left
   * corner while the bottom third stayed solid rock — with the arrival tile
   * sitting on the EDGE of the open area, walls immediately to two sides.
   *
   * That is not merely ugly. The ambush places its monsters in an annulus
   * around the arrival tile, so a room open on one side only means every
   * monster comes from that side: the thing that makes an ambush an ambush,
   * quietly deleted by a property of the random walk.
   *
   * Restarting from the centre every so often turns one wandering excursion
   * into a dozen radial ones. Connectivity is untouched — the centre is open,
   * so every excursion begins on an already-connected tile — which is the whole
   * reason a walk was chosen over cellular automata.
   */
  const RESET_EVERY = Math.max(8, Math.floor(target / 10));

  /**
   * BOUNDED, and the bound is not decoration. A walk that keeps rejecting steps
   * near a wall can in principle take a long time to reach its target, and this
   * runs synchronously inside a player's move — the same rule the pathfinder's
   * `maxNodes` obeys. Generous enough to be unreachable in practice, small
   * enough that hitting it costs a millisecond and a slightly emptier room
   * rather than a wedged server.
   */
  const MAX_STEPS = interior * 40;
  for (let step = 0; step < MAX_STEPS && open < target; step += 1) {
    if (step % RESET_EVERY === 0) {
      x = centre.x;
      y = centre.y;
    }
    const dir = STEPS[rng.int('arena.step', 0, STEPS.length - 1)];
    if (dir === undefined) continue;
    const nx = x + dir.x;
    const ny = y + dir.y;
    // Stay off the border so the room is always sealed. A rejected step still
    // consumed its draw, which keeps the stream aligned with the step count.
    if (nx < MARGIN || ny < MARGIN || nx >= ARENA_W - MARGIN || ny >= ARENA_H - MARGIN) {
      continue;
    }
    x = nx;
    y = ny;
    carve(x, y);
  }

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
     * this replaced. The walk starts here, so the centre is always floor and
     * always connected to everything it opened — and an ambush that surrounds
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

/** Where the walk starts, exported so a test can assert against it. */
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
