import { describe, expect, it } from 'vitest';

import { AiProfile, Faction } from '../../src/server/engine/actor.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { canWalk } from '../../src/shared/level.ts';
import { createWorld } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALKING INTO A FRIEND TRADES PLACES WITH THEM. AND ONLY A FRIEND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from Combat.lua:32-74 — the `reaction >= 0` half of `Actor:bumpInto`,
 * where ToME force-moves both bodies and charges the mover one move. Switched
 * on for party members by Party.lua:271-272 (*"actor.move_others = true"*) and
 * for the player at birth by descriptors.lua:60.
 *
 * ═══ WHY, MEASURED ═══
 * Found while probing something else: a player following a friend into a delve
 * arrives at the way out, and with anybody standing on it the only route in is
 * through them — twelve consecutive steps, no movement. The refusal WAS
 * delivered (`refused at resolution: occupied`, unicast to the owner), so it was
 * never silent; an accurate error message is simply not the answer to *"my
 * friend is standing in the doorway"*.
 *
 * ═══ WHY THESE ARE ENGINE-LEVEL AND NOT DRIVEN OVER A SOCKET ═══
 * The gateway intercepts a bump into a townsfolk BEFORE the intent is ever
 * submitted (`greetOnBump` — bumping a shopkeeper opens a conversation and
 * costs no turn). A socket test of the third case below would therefore pass
 * whether or not the engine rule is correct, which is the exact shape of a test
 * that pins nothing. The end-to-end path has its own test in two-players.test.ts.
 */

/**
 * A walkable tile next to `from`, or null.
 *
 * THE FIRST VERSION OF THESE FIXTURES WROTE x/y DIRECTLY AND PUT A BODY IN A
 * WALL — and `swapPlaces` refused, correctly, which read as the whole feature
 * being broken. Placement goes through the map from here on.
 */
function beside(world: ReturnType<typeof createWorld>, from: { x: number; y: number }) {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const x = from.x + dx;
    const y = from.y + dy;
    if (canWalk(world.level, x, y) && world.actorAt(x, y) === undefined) return { x, y };
  }
  return null;
}

function husk(name: string, x: number, y: number, faction?: Faction) {
  return {
    name,
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
    // Enough to survive a bump. A body that dies leaves the board and takes the
    // position assertion's subject with it.
    maxHp: 5000,
    ...(faction === undefined ? {} : { faction }),
  };
}

/** A world with two adjacent players, both parked and connected. */
function twoPlayers() {
  const world = createWorld('ally-swap');
  world.addPlayer('p1', 'Ren');
  world.addPlayer('p2', 'Sol');
  const a = world.getActor('p1');
  const b = world.getActor('p2');
  if (a === undefined || b === undefined) throw new Error('no bodies');
  const spot = beside(world, a);
  if (spot === null) throw new Error('no ground beside the spawn');
  b.x = spot.x;
  b.y = spot.y;
  a.maxHp = 9000;
  a.hp = 9000;
  const engine = createTurnEngine({ world });
  for (const id of ['p1', 'p2']) {
    engine.join(id);
    engine.setConnected(id, true);
  }
  return { world, engine, a, b };
}

describe('bumping into a body', () => {
  it('trades places with another player', () => {
    const { world, engine, a, b } = twoPlayers();
    const was = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    const dir = b.x > a.x ? 'e' : b.x < a.x ? 'w' : b.y > a.y ? 's' : 'n';
    expect(engine.submitMove('p1', dir).ok).toBe(true);
    // The barrier: the other standing body owes the turn too, or nothing
    // resolves and the assertion below reads the starting position.
    engine.hold('p2');
    engine.pump();

    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual(was.b);
    // BOTH HALVES. Asserting only the mover would pass if the other body were
    // deleted, left where it was, or put anywhere at all.
    expect({ x: world.getActor('p2')?.x, y: world.getActor('p2')?.y }).toEqual(was.a);
  });

  it('will not shove a townsfolk out of the way', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE GATE, AND THE ONLY CASE THAT REACHES IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `areEnemies` returns false the moment either side is `Faction.Townsfolk`,
     * so a shopkeeper is a NON-HOSTILE occupant: the bump-attack branch does not
     * fire and the swap rule is reached with a monster on the tile. Without the
     * kind test, a player would displace the person they came to trade with —
     * and the same hole would let two monsters flow through each other, which
     * would let a pack walk THROUGH the line a party is holding.
     *
     * A FIRST VERSION OF THIS TEST USED A HOSTILE MONSTER AND PINNED NOTHING:
     * it passed with the kind test deleted, because the hostile branch returns
     * before the swap is ever reached. Reverting the rule is what found that.
     */
    const world = createWorld('ally-swap');
    world.addPlayer('p1', 'Ren');
    const a = world.getActor('p1');
    if (a === undefined) throw new Error('no body');
    a.maxHp = 9000;
    a.hp = 9000;
    const spot = beside(world, a);
    if (spot === null) throw new Error('no ground beside the spawn');
    world.addMonster('shopkeep', husk('Merrow Stitch', spot.x, spot.y, Faction.Townsfolk));
    const mine = { x: a.x, y: a.y };
    const dir = spot.x > a.x ? 'e' : spot.x < a.x ? 'w' : spot.y > a.y ? 's' : 'n';
    const engine = createTurnEngine({ world });
    engine.join('p1');
    engine.setConnected('p1', true);

    expect(engine.submitMove('p1', dir).ok).toBe(true);
    engine.pump();

    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual(mine);
    expect({ x: world.getActor('shopkeep')?.x, y: world.getActor('shopkeep')?.y }).toEqual(spot);
  });

  it('attacks a hostile rather than trading places with it', () => {
    /**
     * Asserted by POSITION, not by hit points: a blow can miss, and a test that
     * read damage would be flaky for a reason unrelated to what it is about.
     * Where the two bodies stand afterwards is the fact under test.
     */
    const world = createWorld('ally-swap');
    world.addPlayer('p1', 'Ren');
    const a = world.getActor('p1');
    if (a === undefined) throw new Error('no body');
    a.maxHp = 9000;
    a.hp = 9000;
    const spot = beside(world, a);
    if (spot === null) throw new Error('no ground beside the spawn');
    world.addMonster('beast', husk('Index Husk', spot.x, spot.y));
    const mine = { x: a.x, y: a.y };
    const dir = spot.x > a.x ? 'e' : spot.x < a.x ? 'w' : spot.y > a.y ? 's' : 'n';
    const engine = createTurnEngine({ world });
    engine.join('p1');
    engine.setConnected('p1', true);

    expect(engine.submitMove('p1', dir).ok).toBe(true);
    engine.pump();

    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual(mine);
  });
});
