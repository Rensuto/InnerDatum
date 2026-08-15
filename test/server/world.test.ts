import { describe, expect, it } from 'vitest';

import { MoveBlock, createWorld } from '../../src/server/world/world.ts';
import { DIR_ORDER, dirVector } from '../../src/shared/coords.ts';
import { TEST_LEVEL_SPAWNS, canWalk } from '../../src/shared/level.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { Dir, TileXY } from '../../src/shared/coords.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * `tryMove` is the server's authority in one function: the client sends a
 * direction and nothing else, and everything about whether that direction is
 * legal — and what the resulting coordinates are — is decided here. Every test
 * below asserts BOTH the returned result and the stored position, because the
 * expensive bug is not a wrong answer, it is a refusal that moved the actor
 * anyway. That desyncs one client from the server permanently and shows up much
 * later as a player standing inside a wall.
 */

/**
 * Narrows away the `| undefined` that noUncheckedIndexedAccess adds to every
 * lookup. Throwing is correct here: a missing fixture is a broken test, not a
 * failed assertion, and `!` is banned project-wide.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test fixture: ${what} is missing`);
  return value;
}

/** The direction whose unit vector carries `from` onto `to`, if one does. */
function dirFromTo(from: TileXY, to: TileXY): Dir | undefined {
  return DIR_ORDER.find((dir) => {
    const v = dirVector(dir);
    return from.x + v.dx === to.x && from.y + v.dy === to.y;
  });
}

/** The world's stored position, read back rather than trusted from a closure. */
function positionOf(world: World, id: string): TileXY {
  const actor = must(world.getActor(id), `actor ${id}`);
  return { x: actor.x, y: actor.y };
}

/** Join `count` players into a fresh world and record where each one landed. */
function placements(seed: string, count: number): string[] {
  const world = createWorld(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const actor = world.addPlayer(`p${i}`, `Player ${i}`);
    out.push(`${actor.id} ${actor.sprite} ${actor.x},${actor.y}`);
  }
  return out;
}

describe('world.addPlayer', () => {
  it('puts every joining player on a walkable tile of their own', () => {
    // Two bodies on one tile breaks the invariant the rest of the file depends
    // on, and it is unrecoverable: neither actor can then step off without the
    // occupancy check refusing.
    const world = createWorld('m1-placement');
    const joins = TEST_LEVEL_SPAWNS.length + 2;
    const occupied = new Set<string>();
    const offTerrain: string[] = [];

    for (let i = 0; i < joins; i += 1) {
      const actor = world.addPlayer(`p${i}`, `Player ${i}`);
      const where = `${actor.x},${actor.y}`;
      if (!canWalk(world.level, actor.x, actor.y)) offTerrain.push(`${actor.id} at ${where}`);
      expect(actor.kind).toBe(ActorKind.Player);
      occupied.add(where);
    }

    expect(offTerrain).toEqual([]);
    // More joins than authored spawn tiles, so this also covers the overflow
    // path that scans for any free floor tile.
    expect(occupied.size).toBe(joins);
    expect(world.allActors()).toHaveLength(joins);
  });

  it('seats the first players on the authored spawn cluster, in order', () => {
    // The coordinates come from TEST_LEVEL_SPAWNS rather than being written out,
    // so editing the map moves the expectation with it.
    const world = createWorld('m1-spawn-order');
    const first = world.addPlayer('a', 'Alice');
    const second = world.addPlayer('b', 'Bob');

    expect({ x: first.x, y: first.y }).toEqual(must(TEST_LEVEL_SPAWNS[0], 'spawn 0'));
    expect({ x: second.x, y: second.y }).toEqual(must(TEST_LEVEL_SPAWNS[1], 'spawn 1'));
  });

  it('reattaches a returning player to the token they left, without moving it', () => {
    // The resume path. A reconnecting socket that spawns a second actor leaves an
    // abandoned body on the map; one that teleports the existing actor back to
    // spawn undoes the player's turn. Both are silent server-side.
    const world = createWorld('m1-resume');
    const original = world.addPlayer('a', 'Alice');
    expect(world.tryMove('a', 'e').ok).toBe(true);

    const afterMoving = positionOf(world, 'a');
    const rejoined = world.addPlayer('a', 'Alice');

    expect(rejoined).toBe(original);
    expect(positionOf(world, 'a')).toEqual(afterMoving);
    expect(world.allActors()).toHaveLength(1);
  });
});

describe('world.placeAtSpawn', () => {
  it('walks an existing body back to the spawn cluster', () => {
    // The respawn path. PLACEMENT, not movement: a body appearing somewhere is
    // not a step, so there is no terrain rule and no bump-attack to get wrong —
    // what it shares with `addPlayer` is the one invariant that matters, that
    // the tile has no living body on it.
    const world = createWorld('respawn-place');
    const actor = world.addPlayer('a', 'Alice');
    actor.x = 20;
    actor.y = 20;

    const tile = world.placeAtSpawn('a');
    expect(tile).toBeDefined();
    expect(positionOf(world, 'a')).toEqual(tile);
    expect(canWalk(world.level, actor.x, actor.y)).toBe(true);
  });

  it('never puts one body on top of another', () => {
    const world = createWorld('respawn-occupied');
    const held: string[] = [];
    for (let i = 0; i < TEST_LEVEL_SPAWNS.length; i += 1) {
      held.push(world.addPlayer(`p${i}`, `Player ${i}`).id);
    }
    // The whole authored cluster is taken, so this exercises the overflow scan.
    const returning = world.addPlayer('late', 'Late');
    returning.x = 20;
    returning.y = 20;

    expect(world.placeAtSpawn('late')).toBeDefined();
    const occupied = new Set(world.allActors().map((actor) => `${actor.x},${actor.y}`));
    expect(occupied.size).toBe(held.length + 1);
  });

  it('answers undefined for an id that is not in the world, rather than throwing', () => {
    // The caller is a player pressing a key to get themselves unstuck. An
    // exception on that path is the bug all over again.
    const world = createWorld('respawn-unknown');
    expect(world.placeAtSpawn('nobody')).toBeUndefined();
  });
});

describe('world.tryMove', () => {
  it('applies exactly the direction vector, and lets terrain alone decide', () => {
    // Every direction from one tile, checked against canWalk rather than against
    // a written-out list — this asserts the rule, not the map. It also catches a
    // vector applied twice or with a flipped sign, which reads as "the token
    // jumps two tiles" and only on the diagonals.
    const world = createWorld('m1-vectors');
    world.addPlayer('solo', 'Solo');
    const start = positionOf(world, 'solo');

    for (const dir of DIR_ORDER) {
      const v = dirVector(dir);
      const target: TileXY = { x: start.x + v.dx, y: start.y + v.dy };
      const result = world.tryMove('solo', dir);

      expect(result.ok).toBe(canWalk(world.level, target.x, target.y));

      if (result.ok) {
        expect({ x: result.x, y: result.y }).toEqual(target);
        expect(positionOf(world, 'solo')).toEqual(target);
        // Step back so the next direction is measured from the same tile.
        const back = must(dirFromTo(target, start), `the return direction for ${dir}`);
        expect(world.tryMove('solo', back).ok).toBe(true);
      }

      expect(positionOf(world, 'solo')).toEqual(start);
    }
  });

  it('refuses a move into a wall and leaves the actor exactly where it stood', () => {
    // Walked into the border rather than into a hard-coded wall coordinate, so
    // this survives an edit to the map.
    const world = createWorld('m1-wall');
    world.addPlayer('a', 'Alice');

    let result = world.tryMove('a', 'w');
    let steps = 0;
    while (result.ok && steps < 64) {
      result = world.tryMove('a', 'w');
      steps += 1;
    }
    expect(steps).toBeLessThan(64);

    const stoppedAt = positionOf(world, 'a');
    expect(canWalk(world.level, stoppedAt.x - 1, stoppedAt.y)).toBe(false);
    expect(result).toEqual({ ok: false, reason: MoveBlock.Terrain });

    // And it stays refused — a rejection must not leave the actor half-moved.
    expect(world.tryMove('a', 'w')).toEqual({ ok: false, reason: MoveBlock.Terrain });
    expect(positionOf(world, 'a')).toEqual(stoppedAt);
  });

  it('refuses a move onto a tile another body is standing on', () => {
    // Distinct from the terrain refusal on purpose: the target tile here is
    // legal floor, so only the occupancy check can reject it. Collapsing the two
    // reasons would let one player walk through another.
    const world = createWorld('m1-occupied');
    const alice = world.addPlayer('a', 'Alice');
    const bob = world.addPlayer('b', 'Bob');

    const aliceBefore = positionOf(world, 'a');
    const bobBefore = positionOf(world, 'b');
    const toward = must(dirFromTo(aliceBefore, bobBefore), 'a direction from Alice to Bob');

    expect(canWalk(world.level, bob.x, bob.y)).toBe(true);
    expect(world.tryMove('a', toward)).toEqual({ ok: false, reason: MoveBlock.Occupied });
    expect(positionOf(world, 'a')).toEqual(aliceBefore);
    expect(positionOf(world, 'b')).toEqual(bobBefore);

    // Once Bob leaves, the same move becomes legal — proving the refusal was
    // about the body and not about the tile.
    expect(world.removePlayer('b')).toBe(true);
    expect(world.tryMove('a', toward)).toEqual({ ok: true, x: bobBefore.x, y: bobBefore.y });
    expect({ x: alice.x, y: alice.y }).toEqual(bobBefore);
  });

  it('refuses a socket that has not joined, without inventing an actor', () => {
    // A frame arriving before `hello`, or after removal. Answering anything but
    // a refusal here would mean the wire could name who moves.
    const world = createWorld('m1-unknown');
    expect(world.tryMove('ghost', 'n')).toEqual({ ok: false, reason: MoveBlock.NoActor });
    expect(world.allActors()).toEqual([]);
    expect(world.getActor('ghost')).toBeUndefined();
  });
});

describe('world determinism', () => {
  it('places identical players from an identical seed and join order', () => {
    // Twelve, not two: the first six take the authored spawn cluster and never
    // touch the RNG at all. Only the overflow joins prove the seed is genuinely
    // plumbed through createWorld -> createRng -> fork('world.spawn') -> pick.
    expect(placements('shared-seed', 12)).toEqual(placements('shared-seed', 12));
  });

  it('separates two seeds once placement starts drawing from the RNG', () => {
    // The other half of the same guarantee: if the seed were ignored, the test
    // above would still pass and a restart would silently reuse one world's
    // layout for another.
    const seats = TEST_LEVEL_SPAWNS.length;
    const alpha = placements('seed-alpha', 12).slice(seats);
    const beta = placements('seed-beta', 12).slice(seats);

    expect(alpha).toHaveLength(12 - seats);
    expect(alpha).not.toEqual(beta);
  });

  it("keeps each world's level and actors to itself", () => {
    // Two sessions in one process. A shared tile array or a shared actor table
    // would mean one party's doors and bodies appearing in the other's game.
    const a = createWorld('session-a');
    const b = createWorld('session-b');

    a.addPlayer('only-in-a', 'Alice');
    expect(b.allActors()).toEqual([]);
    expect(b.getActor('only-in-a')).toBeUndefined();
    expect(a.level.tiles).not.toBe(b.level.tiles);
  });
});
