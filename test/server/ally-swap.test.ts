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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO FRIENDS WALKING THE SAME WAY MUST BOTH GET SOMEWHERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Combat.lua:32-74` is the PLAYER pushing a FOLLOWER, and a follower has no
   * opinion about where it is going. Ours are two people at two keyboards, and
   * every swap moves BOTH bodies — so without a guard they undo each other.
   *
   * MEASURED over two real sockets before the fix: ten commands each, twenty
   * position changes, NET ZERO, alternating between exactly two tiles. This is
   * that, in the engine, in four moves.
   */
  it('does not let two players walking the same way undo each other', () => {
    const { world, engine, a, b } = twoPlayers();
    // WHICHEVER WAY `b` LIES, that is the way they are both walking: the mover
    // walks INTO the other, which is the collision the guard is about.
    const dir = b.x > a.x ? 'e' : b.x < a.x ? 'w' : b.y > a.y ? 's' : 'n';
    const axis = dir === 'e' || dir === 'w' ? 'x' : 'y';
    const sign = dir === 'e' || dir === 's' ? 1 : -1;
    const startA = a[axis];
    const startB = b[axis];

    // FOUR EXCHANGES, which is twice as many as it takes to deadlock: the old
    // behaviour is a two-cycle, so any even number of them returns to the start.
    for (let i = 0; i < 4; i += 1) {
      engine.submitMove('p1', dir);
      engine.pump();
      engine.submitMove('p2', dir);
      engine.pump();
    }

    const endA = world.getActor('p1')?.[axis] ?? startA;
    const endB = world.getActor('p2')?.[axis] ?? startB;
    // THE ASSERTION IS PROGRESS, NOT A POSITION. How far they get depends on the
    // one move the shoved body loses when they first collide, and pinning an
    // exact tile would be pinning that incidental rather than the property.
    expect((endA - startA) * sign, 'the mover made no ground').toBeGreaterThan(0);
    expect((endB - startB) * sign, 'the body that was shoved made no ground').toBeGreaterThan(0);
  });

  it('lets a body past a friend who is STANDING STILL, twice running', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE THE GUARD WAS NEVER ASKED ABOUT — and the one a party lives in.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The test above walks two bodies the SAME way, which is the collision the
     * `wouldUndo` guard was written for. This is the other half: one body wants
     * past a friend who is not going anywhere — reading a note, guarding a
     * corridor, or simply idle at a keyboard.
     *
     * `lastSwap` is cleared only by a NORMAL move (its own docblock: *"the event
     * that actually means I got where I was going"*), so a friend who never
     * takes a normal step keeps their mark forever. The mover swaps once, and
     * every later attempt to come back past them is refused for as long as they
     * stand there.
     *
     * ═══ AND A REFUSED PLAYER INTENT IS REFUNDED, SO IT IS NOT ONE LOST STEP ═══
     * `actPlayer` returns `Park` on a refusal — energy unspent, the actor still
     * owes a decision, and *"the loop comes back to them before the world
     * moves"*. A client that re-sends the same direction therefore stops the
     * floor's clock for the WHOLE party, not just for the body that is blocked.
     * That is what a 900-turn delve stall looks like from the inside.
     */
    const { world, engine, a, b } = twoPlayers();
    const toward = b.x > a.x ? 'e' : b.x < a.x ? 'w' : b.y > a.y ? 's' : 'n';
    const back = toward === 'e' ? 'w' : toward === 'w' ? 'e' : toward === 's' ? 'n' : 's';
    // SNAPSHOTS, because `a` and `b` are the live bodies and a swap rewrites
    // them in place — comparing against `a.x` after the pump compares a number
    // with itself and passes whatever happened.
    const start = { x: a.x, y: a.y };

    // 1. THE FIRST PASS, which has always worked.
    engine.submitMove('p1', toward);
    engine.hold('p2');
    engine.pump();
    const afterFirst = { x: world.getActor('p1')?.x, y: world.getActor('p1')?.y };
    expect(afterFirst, 'the first swap did not happen at all').not.toEqual(start);

    // 2. AND BACK, with the friend still standing exactly where the swap put
    //    them. Nothing about the second attempt undoes the first — the mover is
    //    going the OTHER way — and the body it is asking to trade with has not
    //    moved, which is precisely the doorway this feature exists for.
    engine.submitMove('p1', back);
    engine.hold('p2');
    engine.pump();

    expect(
      { x: world.getActor('p1')?.x, y: world.getActor('p1')?.y },
      'the mover could not get back past a friend standing still',
    ).not.toEqual(afterFirst);
  });

  it('does not let one body ordering a blocked step freeze everybody else', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE REFUND RULE, SEEN FROM THE OTHER THREE PEOPLE IN THE VOICE CHANNEL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `actPlayer` returns `Park` on a refusal — energy unspent, *"the loop comes
     * back to them before the world moves"*. That is right for a race: two
     * players attack the same monster, the loser is refunded rather than
     * charged for nothing.
     *
     * It is a hazard when the refusal is not a race but a WALL. A body ordering
     * a step into terrain gets the same refusal every time, so a client that
     * re-sends it holds the floor's clock for the whole party — and that is not
     * hypothetical: it is four of the delve driver's remaining 900-turn stalls,
     * `[refused] p2: occupied` on repeat.
     *
     * THIS TEST IS THE PROPERTY, NOT THE MECHANISM: whatever the engine does
     * about it, a second player who orders a legal move must get to take it.
     */
    const { world, engine, a, b } = twoPlayers();
    /**
     * A DIRECTION THAT CANNOT WORK, MADE RATHER THAN FOUND. A wall would do and
     * the spawn does not reliably have one beside it; a TOWNSFOLK is the same
     * refusal by construction — the test above pins that a shopkeeper is never
     * shoved — and it needs no assumption about the generated room.
     */
    const post = beside(world, a);
    if (post === null) throw new Error('test fixture: no ground beside the spawn');
    world.addMonster('shopkeep', husk('Merrow Stitch', post.x, post.y, Faction.Townsfolk));
    const blocked = post.x > a.x ? 'e' : post.x < a.x ? 'w' : post.y > a.y ? 's' : 'n';

    const startA = { x: a.x, y: a.y };
    const startB = { x: b.x, y: b.y };
    // TYPED AS `Dir`, not inferred as `string`: `submitMove` takes the union and
    // a bare array literal widens.
    const open = (['n', 's', 'e', 'w'] as const).find((dir) => {
      const dx = dir === 'e' ? 1 : dir === 'w' ? -1 : 0;
      const dy = dir === 'n' ? -1 : dir === 's' ? 1 : 0;
      return (
        canWalk(world.level, b.x + dx, b.y + dy) && world.actorAt(b.x + dx, b.y + dy) === undefined
      );
    });
    if (open === undefined) throw new Error('test fixture: no open floor beside the second body');

    // TEN ROUNDS of one body pressing into stone and the other walking. Ten
    // because the stall this is about ran for nine hundred.
    for (let i = 0; i < 10; i += 1) {
      engine.submitMove('p1', blocked);
      engine.submitMove('p2', open);
      engine.pump();
    }

    expect(
      { x: world.getActor('p2')?.x, y: world.getActor('p2')?.y },
      'a body walking into a wall stopped everyone else from taking a turn',
    ).not.toEqual(startB);
    // AND THE BLOCKED STEP REALLY WAS BLOCKED. Without this the test passes if
    // the shopkeeper turns out to be shovable after all — proving the party
    // kept moving in a scenario that was never the one being tested.
    expect({ x: world.getActor('p1')?.x, y: world.getActor('p1')?.y }).toEqual(startA);
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
