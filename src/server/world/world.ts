/**
 * The world: one level, one actor table, one turn state, and the only code in
 * the process that is allowed to change where a token stands.
 *
 * AUTHORITY. `tryMove` is the whole point of this file. The client sends a
 * DIRECTION and nothing else (see the missing-field note in protocol.ts); the
 * decision about whether that direction is legal, and what the resulting
 * coordinates are, is made here and broadcast to everyone — including the person
 * who asked. A client that patches its own renderer sees a lie for one frame and
 * then gets corrected by the next update.
 *
 * SYNCHRONOUS, AND ESLint ENFORCES IT. src/server/world/** carries the same six
 * anti-async AST selectors as the engine: no await, no Promise, no timers. That
 * synchronicity IS the mutex — a WebSocket frame cannot interleave with another
 * frame's mutation because there is no point in the middle of `tryMove` where
 * control returns to the event loop. If you ever want a lock here, the real bug
 * is that something above became asynchronous.
 *
 * DETERMINISM. The same lint block bans `Math.random` and `Date.now`. Spawn
 * placement and combat both draw from the seeded PCG32 in src/shared/rng.ts, so
 * a given seed and a given join order produce the same game on any machine.
 *
 * M2 SCOPE. Actors now carry energy, hp and control state (see
 * src/server/engine/actor.ts, which owns the actor type), the level carries a
 * turn state, and monsters exist. The scheduler in src/server/engine/ drives all
 * of it; nothing in this file knows what a turn is. Fog of war is still M3.
 *
 * DEPENDENCY DIRECTION. This file imports the actor MODEL from engine/actor.ts
 * and nothing else from engine/. The scheduler imports the world. One direction,
 * no cycle, and one actor type in the process rather than an engine copy that
 * has to be kept in sync with a world copy — the first field to drift would be
 * `hp`, and it would drift silently.
 */

import { bresenham, step } from '../../shared/coords.ts';
import { createTurnClock } from '../../shared/energy.ts';
import { TEST_LEVEL_SPAWNS, canWalk, makeTestLevel } from '../../shared/level.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { createRng } from '../../shared/rng.ts';
import { createMonsterActor, createPlayerActor } from '../engine/actor.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { TurnClock } from '../../shared/energy.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { EngineActor, MonsterInit } from '../engine/actor.ts';

/**
 * An actor as the SERVER holds it — deliberately not an `ActorView`.
 *
 * The two were the same six fields in M1 and are not remotely the same now: hp,
 * both energy clocks, cooldowns and the control flags all live on this type, and
 * none of them may reach a client except through src/server/view/projector.ts.
 * Collapsing the two types would mean the first secret field added is on the
 * wire by default, which is the wrong direction for a mistake to fall.
 *
 * The definition lives in src/server/engine/actor.ts (the engine owns the actor
 * model) and is aliased here so that every existing importer of
 * `world.ts#Actor` keeps working.
 */
export type Actor = EngineActor;

/**
 * The level's clock and combat state. One level per party, ever — two live
 * levels means two clocks and an unsolvable UX problem for a Friday night.
 */
export type TurnState = {
  /**
   * Engine ticks and completed game turns. Ten ticks to a turn; both numbers
   * are carried explicitly so nobody has to guess which one a bare `turn` meant
   * (ToME's own `game.turn` counts TICKS, hence its `self.turn % 10`).
   */
  readonly clock: TurnClock;
  /**
   * Turns of engagement remaining. Above zero the barrier is armed and every
   * player on the level owes a decision each turn; at zero nobody ever blocks
   * and the pump idles at ~0% CPU. Owned by the scheduler's game-turn hook —
   * see `updateEngagement` there for why it is level-wide rather than per-actor.
   */
  engagement: number;
  /** Boss floors run a shorter Bell (12s rather than 20s). */
  bossFloor: boolean;
};

/**
 * Why a move was refused. A closed union rather than free-form prose so the
 * gateway can map it to an `ErrorCode` and a test can assert on it; the strings
 * are also short enough to log on every rejected keystroke without noise.
 */
export const MoveBlock = {
  /** No such actor. A socket asking to move before `hello`, or after removal. */
  NoActor: 'no_actor',
  /** Wall, or off the edge of the map — `tileAt` treats both as solid rock. */
  Terrain: 'terrain',
  /** Another LIVING body is standing there. Corpses do not block. */
  Occupied: 'occupied',
} as const;
export type MoveBlock = (typeof MoveBlock)[keyof typeof MoveBlock];

/** Discriminated on `ok`, so a caller cannot read `x` off a failed move. */
export type MoveResult =
  | { readonly ok: true; readonly x: number; readonly y: number }
  | { readonly ok: false; readonly reason: MoveBlock };

/**
 * The six playable classes, in the order the art was cut. Handed out with the
 * spawn tiles so the first two players in a session are visibly different
 * sprites standing next to each other.
 */
const PLAYER_SPRITES = [
  'chr_player_watchman_s',
  'chr_player_inspector_s',
  'chr_player_alchemist_s',
  'chr_player_enforcer_s',
  'chr_player_voidling_s',
  'chr_player_cipher_clerk_s',
] as const;

/**
 * Used only if the list above is ever emptied. `PLAYER_SPRITES[i]` is
 * `string | undefined` under noUncheckedIndexedAccess and a `!` to silence that
 * is exactly the shortcut this project bans, so there is a real value to fall
 * back to instead.
 */
const FALLBACK_SPRITE = 'chr_player_watchman_s';

/** How far `addMonster` will look for a free tile before giving up. */
const SPAWN_SEARCH_RADIUS = 8;

/**
 * Line of sight between two tiles, walls blocking.
 *
 * Bresenham's symmetry is what makes this usable as a visibility test: the walk
 * is done from a canonical endpoint and reversed, so `hasLineOfSight(a, b)` and
 * `hasLineOfSight(b, a)` cannot disagree. Without that you get the oldest
 * roguelike bug report there is — the archer shoots you through a corner you
 * cannot shoot back through.
 *
 * Endpoints are excluded: standing IN a wall (a phasing monster, a door being
 * opened) must not blind you, and the target's own tile is what you are looking
 * at.
 *
 * FOV SEAM (M3): opacity and passability are the same thing today because every
 * blocker on the M2 map is a wall. When glass, chasms and open doors arrive this
 * needs its own `isOpaque` predicate rather than `canWalk`, and this is the one
 * function that changes.
 */
export function hasLineOfSight(level: LevelView, from: TileXY, to: TileXY): boolean {
  const line = bresenham(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (!canWalk(level, tile.x, tile.y)) return false;
  }
  return true;
}

export type World = {
  /**
   * The authoritative level. Mutable in type because M4 digs doors into it; in
   * M1 and M2 nothing writes to it after construction.
   */
  readonly level: LevelView;
  /** The clock and the combat state. Mutated by the scheduler, nobody else. */
  readonly turn: TurnState;
  /**
   * The world's random stream, for anything that happens DURING play: damage
   * rolls, AI coin flips, and later loot and generation.
   *
   * Forked away from spawn placement on purpose. Placement draws happen at
   * CONNECT time, driven by network timing nobody controls; if they shared a
   * stream with combat, a replay would depend on when somebody's laptop woke up.
   */
  readonly rng: Rng;
  /**
   * Place a player on a free tile and return it.
   *
   * IDEMPOTENT on `id`: calling it again for an actor that already exists
   * returns that actor untouched and does NOT move them. That is the resume
   * path — a reconnecting socket must reattach to its token, not teleport it.
   *
   * THROWS if the level has no free tile at all. With 761 floor tiles and under
   * ten players that is unreachable, but silently stacking two bodies on one
   * tile would corrupt the invariant the rest of this file depends on. The
   * caller (the gateway) catches it and answers `internal`.
   */
  addPlayer(id: string, name: string): Actor;
  /**
   * Place a monster, preferring the requested tile and settling for the nearest
   * free one. Idempotent on `id`, like `addPlayer`.
   */
  addMonster(id: string, init: MonsterInit): Actor;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PUT AN EXISTING BODY BACK ON A SPAWN TILE. The respawn path, and nothing else.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * PLACEMENT, NOT MOVEMENT, and the distinction is what keeps `tryMove`'s claim
   * to be the only legal way to change a position honest. `addPlayer` and
   * `addMonster` write `x`/`y` directly too: a body appearing somewhere is not a
   * STEP, so there is no terrain rule, no corner-cutting rule and no bump-attack
   * to get wrong. What both share with this is the ONE invariant that matters —
   * the tile is free of living bodies before anything is written to it.
   *
   * It exists because an Erased body can be stood on: `actorAt` skips anything
   * not alive ("corpses do not block"), so a monster or an ally may be standing
   * exactly where the erased detective fell. Standing them up in place would put
   * two living bodies on one tile, which is the single invariant this file is
   * written around. A spawn tile is also the safe, authored answer to "where do
   * you come back" — the same one game-design.md gives for a session that ended.
   *
   * @returns the tile, or undefined for an unknown id or a level with no free
   * tile at all. It NEVER throws: the caller is a player pressing a key to get
   * out of a stranded state, and an exception there is the bug all over again.
   */
  placeAtSpawn(id: string): TileXY | undefined;
  /**
   * Remove a player outright.
   *
   * NOT THE DISCONNECT PATH. A dropped socket leaves the body in the world —
   * see `disconnectActor` in the scheduler, which marks it Standing By and
   * starts the ten-minute grace. This is for a player who has genuinely left.
   */
  removePlayer(id: string): boolean;
  /** Remove any actor. Reaping a corpse, or a GM `remove`. */
  removeActor(id: string): boolean;
  getActor(id: string): Actor | undefined;
  /** A fresh array; the `Actor` objects inside are live references. */
  allActors(): Actor[];
  /**
   * The order the scheduler ticks actors in: the whole party first, then
   * everything the world drives.
   *
   * Ported in spirit from ToME's `Party.lua:71`, which forces the party to be
   * contiguous in the level's entity list for exactly this reason. Insertion
   * order within each group, so it is stable across a save and a reload.
   */
  actorsInTurnOrder(): Actor[];
  /** The LIVING body standing on a tile, if any. Terrain is not consulted. */
  actorAt(x: number, y: number): Actor | undefined;
  /** The one legal way to change a position. */
  tryMove(id: string, dir: Dir): MoveResult;
};

function spriteForJoinIndex(index: number): string {
  return PLAYER_SPRITES[index % PLAYER_SPRITES.length] ?? FALLBACK_SPRITE;
}

/**
 * Build the world. `seed` names this world's random stream — pass a stable
 * string (`env.WORLD_SEED`) so a restart reproduces the same placements.
 */
export function createWorld(seed: number | string): World {
  const level = makeTestLevel();
  const actors = new Map<string, Actor>();

  const turn: TurnState = {
    clock: createTurnClock(),
    engagement: 0,
    bossFloor: false,
  };

  /**
   * TWO FORKED SUB-STREAMS, not the world's main generator.
   *
   * `fork` is a pure function of (state, inc, label) and does not advance the
   * parent, so neither stream can shift the other's numbers however many draws
   * it takes. Placement is driven by connect timing; play is driven by the
   * action log. They must not share a cursor.
   */
  const root = createRng(seed);
  const spawnRng = root.fork('world.spawn');
  const playRng = root.fork('world.turn');

  /** Where the next join starts scanning the authored spawn cluster. */
  let spawnCursor = 0;
  /** Monotonic join counter, used only to rotate through the class sprites. */
  let joinIndex = 0;

  /**
   * Linear scan, on purpose. This is a co-op game for under ten players: a
   * position -> actor index would be a second source of truth that has to be
   * updated in lockstep with every move, and the failure mode of a stale index
   * is two players standing on one tile — the exact bug this function exists to
   * prevent. Ten comparisons per move is not worth that risk.
   *
   * Corpses are skipped: a dead body is scenery, and having to walk around your
   * friend's remains for the rest of the floor is not a mechanic anybody asked
   * for.
   */
  const actorAt = (x: number, y: number): Actor | undefined => {
    for (const actor of actors.values()) {
      if (actor.alive && actor.x === x && actor.y === y) return actor;
    }
    return undefined;
  };

  /** Walkable terrain AND unoccupied. Terrain alone is `canWalk`. */
  const isFree = (x: number, y: number): boolean =>
    canWalk(level, x, y) && actorAt(x, y) === undefined;

  /**
   * Preference order: the authored spawn cluster in order (wrapping), then any
   * free floor tile at all.
   *
   * The cluster is walked deterministically rather than drawn from the RNG
   * because two people joining a session should land next to each other every
   * time; the seeded draw is the overflow path, for the seventh player onwards.
   *
   * UNDEFINED when the level has no free tile at all — which takes more than 761
   * players. `addPlayer` turns that into the throw it has always been; the
   * respawn path answers a refusal instead, because a player pressing a key to
   * get themselves unstuck must never meet an exception.
   */
  const findSpawn = (): TileXY | undefined => {
    const count = TEST_LEVEL_SPAWNS.length;
    for (let i = 0; i < count; i += 1) {
      const index = (spawnCursor + i) % count;
      const tile = TEST_LEVEL_SPAWNS[index];
      if (tile === undefined) continue;
      if (isFree(tile.x, tile.y)) {
        spawnCursor = (index + 1) % count;
        return tile;
      }
    }

    // Row-major, so the candidate list is identical on every machine and the
    // draw below is reproducible.
    const free: TileXY[] = [];
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        if (isFree(x, y)) free.push({ x, y });
      }
    }
    return spawnRng.pick('world.spawn.overflow', free);
  };

  /**
   * The requested tile, or the closest free one to it.
   *
   * Rings outward in row-major order within each radius, so the answer is a
   * pure function of the map and the request — no draw, and identical on every
   * machine. An authored encounter that names an occupied tile shuffles by one
   * step rather than failing to spawn, which matters because the commonest
   * cause of an occupied spawn tile is a second monster from the same encounter.
   */
  const nearestFreeTile = (x: number, y: number): TileXY | undefined => {
    if (isFree(x, y)) return { x, y };
    for (let radius = 1; radius <= SPAWN_SEARCH_RADIUS; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          // Only the ring, not the filled square — the interior was covered by
          // a smaller radius.
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          if (isFree(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return undefined;
  };

  const addPlayer = (id: string, name: string): Actor => {
    const existing = actors.get(id);
    if (existing !== undefined) return existing;

    const tile = findSpawn();
    if (tile === undefined) {
      throw new Error('world.addPlayer: the level has no free tile');
    }
    const actor = createPlayerActor(id, {
      name,
      sprite: spriteForJoinIndex(joinIndex),
      x: tile.x,
      y: tile.y,
    });
    joinIndex += 1;
    actors.set(id, actor);
    return actor;
  };

  const addMonster = (id: string, init: MonsterInit): Actor => {
    const existing = actors.get(id);
    if (existing !== undefined) return existing;

    const tile = nearestFreeTile(init.x, init.y);
    if (tile === undefined) {
      throw new Error(
        `world.addMonster: no free tile within ${SPAWN_SEARCH_RADIUS} of ${init.x},${init.y}`,
      );
    }
    const actor = createMonsterActor(id, { ...init, x: tile.x, y: tile.y });
    actors.set(id, actor);
    return actor;
  };

  /**
   * The respawn placement. See `World.placeAtSpawn` for why it is placement
   * rather than movement, and why it never throws.
   *
   * CALLED WHILE THE BODY IS STILL ERASED, which is what makes it safe: `isFree`
   * consults `actorAt`, `actorAt` skips anything not alive, so the body cannot
   * be blocked by itself and cannot block anybody else on the way past. The
   * caller stands it up immediately afterwards, on a tile that has just been
   * proven empty of the living.
   */
  const placeAtSpawn = (id: string): TileXY | undefined => {
    const actor = actors.get(id);
    if (actor === undefined) return undefined;
    const tile = findSpawn();
    if (tile === undefined) return undefined;
    actor.x = tile.x;
    actor.y = tile.y;
    return { x: tile.x, y: tile.y };
  };

  const actorsInTurnOrder = (): Actor[] => {
    const party: Actor[] = [];
    const rest: Actor[] = [];
    for (const actor of actors.values()) {
      if (actor.kind === ActorKind.Player) party.push(actor);
      else rest.push(actor);
    }
    return [...party, ...rest];
  };

  const tryMove = (id: string, dir: Dir): MoveResult => {
    const actor = actors.get(id);
    if (actor === undefined) return { ok: false, reason: MoveBlock.NoActor };

    // `step` reads only x/y off the actor, and every direction vector is
    // non-zero, so the target is never the mover's own tile.
    const target = step(actor, dir);

    // Terrain first: it is the cheaper check and the commoner rejection.
    // `canWalk` fails closed off-grid, so the map border needs no special case.
    if (!canWalk(level, target.x, target.y)) {
      return { ok: false, reason: MoveBlock.Terrain };
    }
    if (actorAt(target.x, target.y) !== undefined) {
      return { ok: false, reason: MoveBlock.Occupied };
    }

    // RULE SEAM — CORNER CUTTING. A diagonal step between two orthogonally
    // adjacent walls is allowed here, which is what ToME does and what row 20 of
    // the test map (alternating pillars) is for. If that ever needs to change,
    // it changes HERE and only here, and the client is unaffected because the
    // client never decides legality.
    actor.x = target.x;
    actor.y = target.y;
    return { ok: true, x: actor.x, y: actor.y };
  };

  const removeActor = (id: string): boolean => actors.delete(id);

  return {
    level,
    turn,
    rng: playRng,
    addPlayer,
    addMonster,
    placeAtSpawn,
    removePlayer: removeActor,
    removeActor,
    getActor: (id: string): Actor | undefined => actors.get(id),
    allActors: (): Actor[] => [...actors.values()],
    actorsInTurnOrder,
    actorAt,
    tryMove,
  };
}
