import { describe, expect, it } from 'vitest';

import { arenaCentre, makeArena } from '../../src/shared/arena.ts';
import { Ground, groundAt, makeOverworld } from '../../src/shared/level.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GROUND YOU WERE CAUGHT ON DECIDES WHAT THE FIGHT IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The moor has a forest, a range, a fen and a coastline, and every one of them
 * was scenery: whatever ground a roamer caught you on, the room you woke up in
 * was the same 24x24 walk through the same two tile codes. So the map was a
 * picture you crossed rather than country you got caught in, and the trees
 * existed only as a shape to route around.
 *
 * This is the one thing in the whole terrain design that changes what a fight
 * IS. Three other mechanisms were considered and every one was refuted by
 * measurement — terrain cannot cost a turn (`actionCostMultiplier` returns a
 * literal 1 for players, and out-of-combat movement is unmetered), it cannot buy
 * detour by becoming conditionally passable (deleting walls makes routes
 * *straighter*: 87.5% zero-detour becomes 92.0%), and it cannot be surfaced as a
 * safe-route toggle (the safe set is six disconnected components reaching 4 of
 * 13 sites). Those are closed questions and DECISIONS.md records them.
 */

const OVERWORLD: AuthoredMap = makeOverworld();

/** Where a roamer may legally stand — `roamers.ts` HAUNTS, which is the input. */
const HAUNTS: ReadonlySet<number> = new Set<number>([
  TileCode.PLAINS,
  TileCode.HEATH,
  TileCode.HILLS,
  TileCode.GREEN,
  TileCode.MIRE,
  TileCode.SOOT,
  TileCode.RAIL,
]);

function distribution(): { total: number; byGround: Map<Ground, number> } {
  const byGround = new Map<Ground, number>();
  const view = OVERWORLD.view;
  let total = 0;
  for (let y = 0; y < view.h; y += 1) {
    for (let x = 0; x < view.w; x += 1) {
      if (!HAUNTS.has(view.tiles[y * view.w + x] ?? TileCode.WALL)) continue;
      total += 1;
      const g = groundAt(view, x, y);
      byGround.set(g, (byGround.get(g) ?? 0) + 1);
    }
  }
  return { total, byGround };
}

describe('the moor is classified into six kinds of country', () => {
  it('gives every ground a real share of the ground a roamer can stand on', () => {
    /**
     * MEASURED, NOT CHOSEN. These are the numbers the shipped map actually
     * produces, and the assertion is a BAND rather than an equality because the
     * point is not the digit — it is that no ground is a rounding error and no
     * ground swallows the map. A fight that occurs on 0.2% of the map is content
     * nobody will ever see; one that occurs on 95% is the old single arena
     * wearing six names.
     *
     * Roughly: open 52%, upland 24%, wood 10%, walls 5%, scree 5%, fen 3%. A
     * common pair and four rarities, and the rarities live exactly where the
     * map's forest, range, streets and fen are — which is what makes walking
     * into the trees a different decision from walking round them.
     */
    const { total, byGround } = distribution();
    expect(total).toBeGreaterThan(7_000);

    for (const ground of Object.values(Ground)) {
      const share = (byGround.get(ground) ?? 0) / total;
      expect(share, `${ground} is ${(share * 100).toFixed(1)}% of the map`).toBeGreaterThan(0.01);
      expect(share, `${ground} is ${(share * 100).toFixed(1)}% of the map`).toBeLessThan(0.7);
    }
  });

  it('is total — every cell of the map has an answer, edges included', () => {
    // Off the edge counts as nothing rather than throwing, so a coastal cell is
    // classified by the land it actually has. A classifier that threw on the
    // border would throw inside a player's move.
    const view = OVERWORLD.view;
    const corners = [
      [0, 0],
      [view.w - 1, 0],
      [0, view.h - 1],
      [view.w - 1, view.h - 1],
    ] as const;
    for (const [x, y] of corners) {
      expect(Object.values(Ground)).toContain(groundAt(view, x, y));
    }
  });

  it('answers the same for the same tile, every time', () => {
    // Pure, and it must stay pure: two players ambushed on one tile get one
    // fight, and `shared/` may not read a clock or a random number.
    const view = OVERWORLD.view;
    for (const [x, y] of [
      [40, 40],
      [90, 20],
      [120, 70],
    ] as const) {
      expect(groundAt(view, x, y)).toBe(groundAt(view, x, y));
    }
  });
});

// ---------------------------------------------------------------------------

/** Every walkable cell the arrival tile can actually reach. */
function reachableFrom(map: AuthoredMap): number {
  const { w, h, tiles } = map.view;
  const centre = arenaCentre();
  const seen = new Set<number>([centre.y * w + centre.x]);
  const queue = [centre];
  while (queue.length > 0) {
    const at = queue.pop();
    if (at === undefined) break;
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
      const nx = at.x + dx;
      const ny = at.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = ny * w + nx;
      if (seen.has(i) || !isWalkable(tiles[i] ?? TileCode.WALL)) continue;
      seen.add(i);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen.size;
}

function walkableCount(map: AuthoredMap): number {
  return map.view.tiles.filter((c) => isWalkable(c)).length;
}

describe('six grounds build six different rooms', () => {
  it('never strands anything behind a wall or a channel', () => {
    /**
     * THE ONE PROMISE THIS ROOM MAKES, and the fen is why it is asserted rather
     * than assumed: *"an ambush that surrounds you needs room on every side"*.
     * The seeder places monsters in an annulus around the arrival tile, so a
     * room severed by water strands half the roster behind it and turns the
     * fight it exists to create into a shooting gallery.
     */
    for (const ground of Object.values(Ground)) {
      for (let seed = 1; seed <= 8; seed += 1) {
        const map = makeArena(`realm:site:encounter:${String(seed)}`, ground);
        expect(reachableFrom(map), `${ground} seed ${String(seed)}`).toBe(walkableCount(map));
      }
    }
  });

  it('puts you on walkable ground, in every one of them', () => {
    // Arriving in water is a body standing where `canWalk` says it cannot.
    for (const ground of Object.values(Ground)) {
      const map = makeArena('realm:site:encounter:1', ground);
      const c = arenaCentre();
      expect(isWalkable(map.view.tiles[c.y * map.view.w + c.x] ?? TileCode.WALL)).toBe(true);
      expect(map.spawns).toEqual([c]);
    }
  });

  it('makes a corridor system of the wood and an empty box of the open', () => {
    /**
     * arena.ts named both of these as failure modes to stay between — *"below
     * about a third the room is a corridor system and a ranged monster can never
     * be reached; above about a half it is an empty box and the walls stop
     * meaning anything"* — and each is now a ground on purpose. This asserts the
     * SPREAD, because six rooms that all opened the same amount would be one
     * room in six colours.
     */
    const openness = (g: Ground): number =>
      walkableCount(makeArena('realm:site:encounter:3', g)) / (24 * 24);

    expect(openness(Ground.Open)).toBeGreaterThan(openness(Ground.Upland));
    expect(openness(Ground.Upland)).toBeGreaterThan(openness(Ground.Wood));
    // Nearly twice the room, end to end. That is a different fight, not a tint.
    expect(openness(Ground.Open) / openness(Ground.Wood)).toBeGreaterThan(1.5);
  });

  it('leaves UPLAND the same SHAPE the game already shipped, and makes it the default', () => {
    /**
     * THE NO-REGRESSION HALF, and it is why UPLAND keeps `openFraction` at 0.42
     * rather than taking the retune the design proposed. The fight the game
     * already has is unchanged for everybody, so if somebody reports that fights
     * feel different there is exactly one change to look at instead of six.
     *
     * THE SHAPE, NOT THE CODES. The room is repainted — HILLS and CRAG where it
     * used to be FLOOR and WALL — and that is the whole visible point of the
     * commit. What must not move is where a body may stand, which is why the
     * pre-existing assertions in `arena.test.ts` were relaxed from `===
     * TileCode.FLOOR` to `isWalkable` rather than deleted: they still pin the
     * sealed border, the connectivity and the walkable centre, and they now pin
     * them for all six rooms instead of one.
     *
     * A caller that names no ground gets this one, which is every fixture
     * written before today.
     */
    for (let seed = 1; seed <= 5; seed += 1) {
      const name = `realm:site:encounter:${String(seed)}`;
      expect(makeArena(name, Ground.Upland).view.tiles).toEqual(makeArena(name).view.tiles);
    }

    // 0.42 of the 22x22 interior is 203 cells, which is the count that has
    // shipped since the arena existed. If this moves, the default fight moved.
    expect(walkableCount(makeArena('realm:site:encounter:1'))).toBe(203);
  });

  it('gives the fen water, and gives it to nothing else', () => {
    /**
     * WATER STOPS A BODY AND NOT AN EYE — `protocol.ts` calls it the one code in
     * neither set's complement, "solid, and transparent". That makes the fen the
     * only ground in the game where you can shoot something that cannot reach
     * you, and it costs no engine change at all: the sight trace already honours
     * it and `canWalk` already refuses it.
     *
     * MEASURED over 24 arenas per ground, counting cells the arrival tile can
     * SEE but must walk 3+ extra steps to reach: fen 6.4%, and every other
     * ground exactly 0.0% — because where walls block a body they also block the
     * eye, so anything you can see you can walk straight to. The tactic exists
     * nowhere else on the board.
     */
    const water = (g: Ground): number =>
      makeArena('realm:site:encounter:5', g).view.tiles.filter((c) => c === TileCode.WATER).length;

    expect(water(Ground.Fen)).toBeGreaterThan(0);
    for (const ground of Object.values(Ground)) {
      if (ground === Ground.Fen) continue;
      expect(water(ground), `${ground} must be dry`).toBe(0);
    }
  });

  it('paints each ground in its own two codes', () => {
    // The repaint is the same two-code substitution `makeSiteMap` uses, so a
    // room cannot be reshaped by being recoloured — and no two grounds may look
    // alike, or the classification is invisible to the person playing.
    const skin = (g: Ground): string =>
      [...new Set(makeArena('realm:site:encounter:2', g).view.tiles)]
        .filter((c) => c !== TileCode.WATER)
        .sort((a, b) => a - b)
        .join('/');

    const skins = Object.values(Ground).map(skin);
    expect(new Set(skins).size).toBe(skins.length);
    // And none of them is the grey box.
    for (const s of skins) expect(s).not.toBe(`${String(TileCode.FLOOR)}/${String(TileCode.WALL)}`);
  });
});
