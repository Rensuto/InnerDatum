import { describe, expect, it } from 'vitest';

import {
  MouseIntentKind,
  mouseIntentAt,
  travelTargetAllowed,
} from '../../src/client/input/mouseintent.ts';
import { DIR_ORDER, step } from '../../src/shared/coords.ts';
import { ActorKind, ActorRank, TileCode } from '../../src/shared/protocol.ts';
import type { MouseIntent, MouseSnapshot } from '../../src/client/input/mouseintent.ts';
import type { ActorView, LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A LEFT-CLICK MEANS. ONE PURE FUNCTION, NO PIXELS, NO SOCKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE TEST THAT MATTERS MOST IS THE ONE ABOUT AN ALLY. Attacking is walking into
 * somebody, and `resolveIntent` (scheduler.ts:1118-1121) strikes the destination
 * tile's occupant only when `isHostile` — an ally falls through to `tryMove` and
 * comes back `Occupied`, a corpse does not block at all. So a click layer that
 * offered "attack" over a friend would teach the player a rule this game does
 * not have, and they would pay a turn to find out. Two tests below exist purely
 * to keep that impossible.
 *
 * Everything here is ADVISORY in exactly the sense input/targeting.ts's header
 * claims for itself: the server re-validates, and a wrong answer costs one
 * refused frame. The value is that the player is not told something false first.
 */

function mapOf(rows: readonly string[]): LevelView {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  for (const row of rows) {
    if (row.length !== w) throw new Error(`ragged test map: "${row}" is not ${w} wide`);
    for (let x = 0; x < w; x += 1) {
      tiles.push(row.charAt(x) === '#' ? TileCode.WALL : TileCode.FLOOR);
    }
  }
  return { w, h, tiles };
}

/** A walled 10x8 field. (4,3) is the middle of open floor; (0,0) is wall. */
const OPEN = mapOf([
  '##########',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '##########',
]);

const SELF = { x: 4, y: 3 };

function husk(id: string, x: number, y: number, alive = true): ActorView {
  return {
    id,
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    kind: ActorKind.Monster,
    rank: ActorRank.Normal,
    hp: alive ? 12 : 0,
    maxHp: 12,
    alive,
  };
}

function detective(id: string, x: number, y: number): ActorView {
  return {
    id,
    name: 'Sam',
    sprite: 'chr_player_watchman_s',
    x,
    y,
    kind: ActorKind.Player,
    rank: ActorRank.Normal,
    hp: 30,
    maxHp: 30,
    alive: true,
  };
}

function snapshot(
  tile: { x: number; y: number },
  actors: readonly ActorView[] = [],
): MouseSnapshot {
  return { self: SELF, tile, actors, level: OPEN };
}

/**
 * Assert `none` and hand back the sentence. The narrowing has to be written out
 * — `expect` does not narrow a union for the compiler — and the return value is
 * what lets each caller make its own claim about the wording.
 */
function reasonOf(intent: MouseIntent): string {
  expect(intent.kind).toBe(MouseIntentKind.None);
  return intent.kind === MouseIntentKind.None ? intent.reason : '';
}

describe('mouseIntentAt', () => {
  it('bumps an adjacent live hostile in all eight directions', () => {
    for (const dir of DIR_ORDER) {
      const tile = step(SELF, dir);
      const intent = mouseIntentAt(snapshot(tile, [husk('m1', tile.x, tile.y)]));
      // Bump-attack: the intent IS a move, so nothing new goes on the wire.
      expect(intent).toEqual({ kind: MouseIntentKind.Bump, dir });
    }
  });

  it('travels toward a hostile two tiles away rather than bumping it, stopping short', () => {
    const tile = { x: 6, y: 3 };
    const intent = mouseIntentAt(snapshot(tile, [husk('m1', tile.x, tile.y)]));

    // Bump is adjacency only. From two tiles out the click is a walk, and the
    // walk must NOT end on the body — arriving is not consent to attack.
    expect(intent).toEqual({ kind: MouseIntentKind.Travel, to: tile, stopShort: true });
  });

  it('travels onto empty floor', () => {
    const tile = { x: 7, y: 5 };
    expect(mouseIntentAt(snapshot(tile))).toEqual({
      kind: MouseIntentKind.Travel,
      to: tile,
      stopShort: false,
    });
  });

  it('does not offer an attack on an adjacent ally', () => {
    const tile = step(SELF, 'e');
    const intent = mouseIntentAt(snapshot(tile, [detective('p2', tile.x, tile.y)]));

    // `tryMove` answers Occupied for a friend, so this is a walk that stops one
    // tile short — never a strike.
    expect(intent).toEqual({ kind: MouseIntentKind.Travel, to: tile, stopShort: true });
  });

  it('does not offer an attack on an adjacent corpse, and will walk over it', () => {
    const tile = step(SELF, 'n');
    const intent = mouseIntentAt(snapshot(tile, [husk('m1', tile.x, tile.y, false)]));

    // Corpses are scenery (world.ts:286-289), so the tile is a normal
    // destination and nothing stops short of it.
    expect(intent).toEqual({ kind: MouseIntentKind.Travel, to: tile, stopShort: false });
  });

  it('refuses a wall, with a sentence', () => {
    const reason = reasonOf(mouseIntentAt(snapshot({ x: 0, y: 3 })));
    expect(reason).toMatch(/^[a-z][^.]*[a-z]$/);
  });

  it('refuses a tile off the grid, with a sentence', () => {
    const reason = reasonOf(mouseIntentAt(snapshot({ x: -1, y: 3 })));
    expect(reason).toMatch(/^[a-z][^.]*[a-z]$/);
  });

  it('refuses the tile you are standing on, with a sentence', () => {
    const reason = reasonOf(mouseIntentAt(snapshot({ ...SELF })));
    expect(reason).toMatch(/^[a-z][^.]*[a-z]$/);
  });

  it('says nothing can be clicked before the board arrives', () => {
    const reason = reasonOf(mouseIntentAt({ self: null, tile: SELF, actors: [], level: null }));
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe('travelTargetAllowed', () => {
  it('is terrain today, and is the only place the M6 fog clause will land', () => {
    expect(travelTargetAllowed(OPEN, { x: 4, y: 3 })).toBe(true);
    expect(travelTargetAllowed(OPEN, { x: 0, y: 0 })).toBe(false);
    // Fails closed off-grid, because `canWalk` does.
    expect(travelTargetAllowed(OPEN, { x: 99, y: 99 })).toBe(false);
  });
});
