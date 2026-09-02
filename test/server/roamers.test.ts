/**
 * Roamers — visible danger on a shared map that still has no hostiles on it.
 *
 * The rule these protect is the one every other decision about realms was
 * arranged around: `engagement` on the overworld must stay at zero, because it
 * is the last clause of `isBlocking` (barrier.ts:293-306) and one real hostile
 * would put every unrelated player in the region into a single barrier, waiting
 * on strangers with a Bell running.
 *
 * A roamer honours that rule while giving the player the thing the rule kept
 * taking away: something to SEE and decide about.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import {
  CELLS_PER_ROAMER,
  maxRoamersFor,
  roamerAt,
  tickRoamers,
} from '../../src/server/world/roamers.ts';
import { INDEX_HUSK } from '../../src/server/content/monsters.ts';
import { canWalk, tileAt } from '../../src/shared/level.ts';
import { sightDistance } from '../../src/shared/sight.ts';
import { ActorKind, TileCode, isHaunt, isWalkable } from '../../src/shared/protocol.ts';
import type { Realm, Realms, Roamer } from '../../src/server/world/realms.ts';

function makeRealms(seed = 'roam-seed'): Realms {
  const downed = createDownedState();
  const parties = createPartyState();
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world, downed, parties }) });
}

/** Run enough pumps that the population fills and everything has wandered. */
function settle(realms: Realms, turns = 200): void {
  for (let i = 1; i <= turns; i += 1) tickRoamers(realms.overworld, i);
}

describe('a roamer is a marker, not a monster', () => {
  it('never becomes an actor, so engagement stays at zero', () => {
    // THE INVARIANT. If this ever fails, six unrelated people walking to three
    // different districts begin waiting on each other's turns.
    const realms = makeRealms();
    settle(realms);
    expect(realms.overworld.roamers.size).toBeGreaterThan(0);

    const monsters = realms.overworld.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    expect(monsters).toEqual([]);
    expect(realms.overworld.world.turn.engagement).toBe(0);
  });

  it('fills to the cap and no further', () => {
    const realms = makeRealms();
    settle(realms);
    expect(realms.overworld.roamers.size).toBe(maxRoamersFor(realms.overworld));
  });

  it('takes its cap from the ground the map has, not from a number', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FOURTH THING THAT ASSUMED THERE WAS ONE OVERWORLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `MAX_ROAMERS` was a flat 18, and its own comment described a DENSITY:
     * *"Seven was tuned against 6,144 cells; the map is now 17,000... Eighteen
     * keeps roughly the same density — about one per five hundred cells."* The
     * ratio was always the design; 18 was that ratio worked out by hand for one
     * map and then written down as though it were the rule.
     *
     * A second landmass under a flat cap would have HALVED the danger on both:
     * the same eighteen creatures spread over twice the ground, on a map whose
     * whole premise is that it is worse than the first.
     *
     * ═══ AND ALDERBROOK STILL GETS EIGHTEEN, WHICH IS THE POINT ═══
     * Nothing about today's play changes. 7,643 hauntable cells over 425 is 18,
     * so the computed answer reproduces the hand-tuned one — which is the only
     * evidence that the ratio was read off the map rather than invented to
     * justify a number somebody liked.
     */
    const realms = makeRealms();
    // 15 on the redesigned moor: the cap is a DENSITY over haunt-able ground and
    // the new landmass holds less of it. That the number followed the map is the
    // whole point of the change this test was written for.
    expect(maxRoamersFor(realms.overworld)).toBe(15);

    // AND IT IS THE HAUNTABLE GROUND, not the walkable ground. The road and the
    // settlements are SAFE by promise, so counting them would let a map with
    // more road quietly carry more danger per acre of wild country.
    const level = realms.overworld.world.level;
    let hauntable = 0;
    let walkable = 0;
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const code = level.tiles[y * level.w + x] ?? TileCode.WALL;
        if (isWalkable(code)) walkable += 1;
        if (isWalkable(code) && isHaunt(code)) hauntable += 1;
      }
    }
    expect(hauntable).toBeLessThan(walkable);
    expect(maxRoamersFor(realms.overworld)).toBe(Math.round(hauntable / CELLS_PER_ROAMER));
  });
});

describe('where they are allowed to be', () => {
  it('never stands on the road, a settlement approach or a bridge', () => {
    // "The road is safe" is a promise the player learns to rely on — the
    // encounter table states it at 0 rather than leaving it absent for exactly
    // this reason. A roamer parked on it would break that promise far more
    // visibly than an invisible roll ever did.
    const realms = makeRealms();
    settle(realms);
    const level = realms.overworld.world.level;
    for (const r of realms.overworld.roamers.values()) {
      const t = tileAt(level, r.x, r.y);
      expect(t, `a roamer is standing on ${t}`).not.toBe(TileCode.COBBLE);
      expect(t).not.toBe(TileCode.PAVING);
      expect(t).not.toBe(TileCode.BRIDGE);
    }
  });

  it('never stands on impassable ground', () => {
    const realms = makeRealms();
    settle(realms);
    for (const r of realms.overworld.roamers.values()) {
      expect(
        realms.overworld.world.level.tiles[r.y * realms.overworld.world.level.w + r.x],
      ).not.toBe(TileCode.MOUNTAIN);
    }
  });

  it('never stacks two on one cell', () => {
    const realms = makeRealms();
    settle(realms);
    const cells = [...realms.overworld.roamers.values()].map((r) => `${r.x},${r.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe('they move, and they do not ambush you', () => {
  it('wanders over time', () => {
    const realms = makeRealms();
    settle(realms, 30);
    const before = [...realms.overworld.roamers.values()].map((r) => `${r.x},${r.y}`).join('|');
    for (let i = 31; i <= 120; i += 1) tickRoamers(realms.overworld, i);
    const after = [...realms.overworld.roamers.values()].map((r) => `${r.x},${r.y}`).join('|');
    expect(after).not.toBe(before);
  });

  it("will not step onto a player, so the fight is always the player's choice", () => {
    // Being caught by something that moved into YOU is a fight you did not
    // choose, and choosing is the entire point of making them visible.
    const realms = makeRealms();
    settle(realms);
    const body = realms.overworld.world.addPlayer('p1', 'Standing still');
    for (let i = 200; i <= 400; i += 1) {
      tickRoamers(realms.overworld, i);
      expect(roamerAt(realms.overworld, body.x, body.y)).toBeUndefined();
    }
  });
});

describe('walking into one is how you start the fight', () => {
  it('is findable by the cell the player is standing on', () => {
    const realms = makeRealms();
    settle(realms);
    const r = [...realms.overworld.roamers.values()][0];
    expect(r).toBeDefined();
    expect(roamerAt(realms.overworld, r?.x ?? -1, r?.y ?? -1)?.id).toBe(r?.id);
    expect(roamerAt(realms.overworld, -5, -5)).toBeUndefined();
  });
});

describe('nothing starts a fight that the player cannot see', () => {
  it('leaves no per-step encounter roll anywhere in the gateway', () => {
    // THE BUG THIS PINS, reported from play three separate times as "the fight
    // just starts randomly".
    //
    // The overworld used to have an invisible d100 per step, keyed on terrain.
    // When the visible roamers were added they were added ALONGSIDE it rather
    // than INSTEAD of it, so both were live: you could see danger and choose to
    // take it on, AND still be yanked into a fight for standing on grass. Every
    // report after that was about the roll, and every fix went somewhere else.
    //
    // Asserted by grep because the absence of a code path cannot be tested by
    // calling it. If a roll comes back, it comes back here first.
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway).not.toContain('rollForEncounter');
    expect(gateway).not.toContain('ENCOUNTER_CHANCE[');
    expect(gateway).not.toContain("'overworld.encounter'");
  });

  it('reaches the ambush only through a roamer the player walked onto', () => {
    // The one remaining entry point. `crossIntoSite` checks `roamerAt` on the
    // tile the body resolved onto, and nothing else opens ENCOUNTER_SITE.
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    // The import is an occurrence too, so count the ENTRY POINTS: how many
    // places actually cross a body into the ambush.
    const opens = [...gateway.matchAll(/crossInto\([^)]*ENCOUNTER_SITE/g)].length;
    expect(opens, 'there should be exactly one way into an ambush').toBe(1);
    expect(gateway).toContain('roamerAt(from, body.x, body.y)');
  });
});

describe('a roamer looks like a creature, not like a place', () => {
  it('wears a real enemy sprite', () => {
    // Reported from play as "the enemies do not seem to have enemy assets, it
    // seems to be a door or something odd" — which was exactly right. Roamers
    // ride on the same list as the settlements, so they borrowed the breach
    // MARKER: `tile_ow_site_breach`, drawn as "a tear in the air", which reads
    // as a door because that is what it was drawn to be.
    //
    // A thing you are meant to recognise as dangerous and decide about has to
    // look like what it becomes.
    const realms = makeRealms();
    settle(realms);
    expect(realms.overworld.roamers.size).toBeGreaterThan(0);
    for (const r of realms.overworld.roamers.values()) {
      expect(r.sprite, `${r.id} wears '${r.sprite}'`).toMatch(/^enemy_/);
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it('draws anything carrying a sprite as a token rather than a marker', () => {
    // The renderer branch that makes the difference. A settlement is a marker
    // lying on the ground; a roamer gets the hostile ring and the bottom-centre
    // anchor every other body on the board gets.
    const canvas = readFileSync(
      new URL('../../src/client/render/canvas.ts', import.meta.url),
      'utf8',
    );
    //
    // BOTH HALVES, because the pair IS the claim: the ring is a CELL and the
    // roamer standing in it is a BODY. This used to name
    // `sprites.sprite('ui_token_ring_hostile')`, the hand-rolled scale that
    // existed at this one call site before `blitCell` knew the difference —
    // a spelling rather than the behaviour, and it broke when the spelling
    // improved. test/client/cellmarks.test.ts asserts the sizes for real.
    expect(canvas).toContain("blitCell('ui_token_ring_hostile'");
    expect(canvas).toContain('blitSprite(site.sprite');
    expect(canvas).toContain('if (site.sprite !== undefined)');
  });
});

// ---------------------------------------------------------------------------
// The moor is not driven by the keyboard
// ---------------------------------------------------------------------------

describe('a player cannot walk the moor forward by pressing keys', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TICK RAN ONCE PER PUMP, AND A PUMP IS ONE KEY PRESS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `pumpRealm` bumped a counter every pump and handed it to `tickRoamers`, so
   * the moor advanced at the rate the party typed: frozen when nobody moved, six
   * times faster with six people walking, faster still for anyone holding a
   * direction down. The SPAWN half was worse — it sits outside the
   * `MOVE_EVERY_TURNS` gate, so one player leaning on a key filled the map as
   * fast as they could press.
   *
   * A docblock directly above that line described the fix as already made. It
   * was not, twice: the first attempt passed the realm's GAME TURN and was
   * reverted, because a game turn advances whenever ANY body spends energy — so
   * six players still ran the moor about six times per player action. These are
   * the assertions that would have caught the gap between the paragraph and the
   * code, both times.
   */
  it('CANNOT protect itself, which is why the gate is at the call site', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE REASON THE GUARD IS IN THE GATEWAY AND NOT IN HERE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `tickRoamers` decides whether to WANDER from `seq % MOVE_EVERY_TURNS`, so
     * calling it repeatedly with the SAME seq either never wanders or wanders
     * every single time, depending on which number it is. On a wander turn it
     * happily steps the whole moor once per call.
     *
     * That is not a bug in this function — it is why the caller has to refuse to
     * call it twice for one tick of the moor's clock. Stated here so nobody
     * "fixes" it by memoising inside and leaves the real gate unguarded.
     */
    const realms = makeRealms('roam-spam');
    settle(realms);
    // A MULTIPLE OF `MOVE_EVERY_TURNS`, written out because that constant is
    // deliberately module-private — importing it would be this test reaching for
    // an implementation detail to describe a contract.
    const wanderTurn = 12;
    const before = new Map(
      [...realms.overworld.roamers.values()].map((r) => [r.id, `${String(r.x)},${String(r.y)}`]),
    );

    for (let i = 0; i < 6; i += 1) tickRoamers(realms.overworld, wanderTurn);

    const moved = [...realms.overworld.roamers.values()].filter(
      (r) => before.get(r.id) !== `${String(r.x)},${String(r.y)}`,
    );
    expect(
      moved.length,
      'six calls on one tick moved nothing — the wander gate changed shape, and ' +
        'the gateway guard may no longer be the thing holding the moor still',
    ).toBeGreaterThan(0);
  });

  it('and the gateway ticks it on a WALL-CLOCK bucket, never once per pump', () => {
    /**
     * A SOURCE GUARD. The rule lives in a closure inside `wsGateway` that no
     * test can reach, and the mistake it prevents is a one-word edit: bumping a
     * local counter, or reading the game clock, instead of reading the wall
     * clock. Both of those have shipped.
     */
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    )
      // CODE ONLY. The docblock at the fix NAMES both things it replaced, which
      // is the comment doing its job — matching raw text would fail on the
      // explanation rather than on the mistake, and the obvious way to make it
      // pass would be deleting the explanation.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(gateway, 'the per-pump counter is back').not.toContain('roamerSeq');
    // THE CONDITION, not just the names. Every identifier below survives a
    // mutation that replaces the guard with `if (true)` and calls the tick on
    // every pump again, which is the whole thing this test exists to prevent.
    expect(gateway, 'the tick is no longer gated on the bucket having CHANGED').toContain(
      'bucket !== lastRoamerBucket.get(',
    );
    expect(gateway, 'the bucket is no longer wall-clock').toContain(
      'Math.floor(Date.now() / roamerBucketMs)',
    );
    expect(gateway).toContain('tickRoamers(full, bucket)');
    // AND NOT THE GAME TURN, which is the repair that looks right, shipped once
    // and was reverted: it advances whenever any body spends energy, so a field
    // full of players runs it once per player action rather than once per turn.
    expect(gateway, 'the moor is back on a clock the party can type on').not.toContain(
      'tickRoamers(full, turn)',
    );
  });
});

// ---------------------------------------------------------------------------
// Aggro, the leash, and the walk home
// ---------------------------------------------------------------------------

/**
 * The middle of the widest stretch of open haunt-able ground on the map.
 *
 * FOUND RATHER THAN WRITTEN DOWN, which is `instance-reap.test.ts`'s rule and
 * its reason: the overworld is an authored map, and a coordinate pair hardcoded
 * here is a test that breaks the next time somebody moves a tree. A leash test
 * needs ten clear tiles in every direction or it measures the terrain.
 */
function openGround(realms: Realms, radius: number): { readonly x: number; readonly y: number } {
  const level = realms.overworld.world.level;
  const good = (x: number, y: number): boolean =>
    canWalk(level, x, y) && isHaunt(tileAt(level, x, y));
  for (let cy = radius; cy < level.h - radius; cy += 1) {
    for (let cx = radius; cx < level.w - radius; cx += 1) {
      let clear = true;
      for (let y = cy - radius; y <= cy + radius && clear; y += 1) {
        for (let x = cx - radius; x <= cx + radius; x += 1) {
          if (!good(x, y)) {
            clear = false;
            break;
          }
        }
      }
      if (clear) return { x: cx, y: cy };
    }
  }
  throw new Error(`the moor has no clear ${String(radius)}-tile disc to test a leash in`);
}

/**
 * A moor holding exactly one roamer that matters, anchored where you asked.
 *
 * ═══ THE OTHERS ARE PARKED, NOT DELETED, AND THAT IS THE WHOLE TRICK ═══
 * `tickRoamers` spawns one per call from OUTSIDE the movement gate —
 * deliberately; it is the top-up after a roamer is walked into and consumed. So
 * a test that emptied the map would get a fresh creature somewhere random on
 * every beat, in a test about one creature.
 *
 * Keeping the population at its cap stops that. And a parked roamer is inert by
 * construction rather than by hope: its anchor is wherever it spawned, every one
 * of the eight steps from the corner is further from that anchor than the leash
 * allows, and the only thing that could override the leash is seeing a player —
 * who is standing in the middle of the map.
 */
function stage(realms: Realms, at: { readonly x: number; readonly y: number }): Roamer {
  settle(realms);
  const realm = realms.overworld;
  const others = [...realm.roamers.values()];
  const doomed = others[0];
  if (doomed === undefined) throw new Error('the moor settled with no roamers on it');
  realm.roamers.delete(doomed.id);

  let park = 1;
  for (const other of others.slice(1)) {
    other.x = park;
    other.y = 1;
    park += 2;
  }

  const mine: Roamer = {
    id: 'roam_under_test',
    x: at.x,
    y: at.y,
    name: 'A Wrong Shadow',
    templateId: INDEX_HUSK.id,
    sprite: INDEX_HUSK.sprite,
    homeX: at.x,
    homeY: at.y,
    unseen: 0,
    goingHome: false,
  };
  realm.roamers.set(mine.id, mine);
  return mine;
}

/** How far a roamer has strayed from the tile it appeared on. */
const fromHome = (r: Roamer): number => sightDistance(r, { x: r.homeX, y: r.homeY });

/**
 * One step of the moor's clock, past the `MOVE_EVERY_TURNS` gate every time.
 *
 * Multiples of three, written out for the reason the spam test gives: that
 * constant is module-private on purpose, and importing it would make this
 * harness a description of the implementation rather than of the behaviour.
 */
function beater(realm: Realm): () => void {
  let seq = 300;
  return () => {
    seq += 3;
    tickRoamers(realm, seq);
  };
}

describe('it notices you, and that is all a roamer is allowed to do about it', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SLIGHT AGGRO — `ai/simple.lua:251-266`, bounded by `Party.lua:69`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The moor's danger was a random walk that could not see you. Upstream's
   * simplest AI is two lines of behaviour — take the nearest hostile in your
   * FOV, walk to where you last saw it — and a leash is upstream's own idea as
   * well (`ai_state.tactic_leash`, default 10).
   *
   * What makes it SLIGHT is the cadence, not a shortened radius: a roamer takes
   * one step every six seconds while you move as fast as you press. It can never
   * catch you at a walk. What it can do is turn towards you, which is a thing
   * you can read at ten tiles and act on.
   */
  it('steps towards a player it can see', () => {
    const realms = makeRealms('roam-aggro');
    const spot = openGround(realms, 12);
    const mine = stage(realms, spot);
    const body = realms.overworld.world.addPlayer('p1', 'Detective');
    body.x = spot.x + 5;
    body.y = spot.y;

    const before = sightDistance(mine, body);
    beater(realms.overworld)();

    expect(sightDistance(mine, body), 'it did not move towards the body').toBeLessThan(before);
    expect(mine.targetId, 'it moved, but it did not TARGET anybody').toBe(body.id);
  });

  it('closes to arm`s length and stops there, so the fight is still your choice', () => {
    /**
     * THE ONE RULE THE CHASE MAY NOT BREAK. Walking into a roamer is how a fight
     * starts; a roamer that walked into YOU would be the invisible encounter
     * roll back again, wearing a sprite.
     *
     * This asserts both halves, and the second is what makes the first mean
     * something: it never stands on the body, AND it does arrive — a chase that
     * quietly stopped working would pass a "never stood on me" test forever.
     */
    const realms = makeRealms('roam-adjacent');
    const spot = openGround(realms, 12);
    const mine = stage(realms, spot);
    const body = realms.overworld.world.addPlayer('p1', 'Detective');
    body.x = spot.x + 5;
    body.y = spot.y;

    const beat = beater(realms.overworld);
    for (let i = 0; i < 20; i += 1) {
      beat();
      expect(
        roamerAt(realms.overworld, body.x, body.y),
        'it stepped onto the body',
      ).toBeUndefined();
    }

    expect(Math.max(Math.abs(mine.x - body.x), Math.abs(mine.y - body.y))).toBe(1);
  });

  it('follows you no further than the leash, and then walks home', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `Party.lua:69` — `tactic_leash = 10`, *"the maximum distance this
     * creature can go from the party master"*.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Ours SNAPS where upstream's BINDS: a party pet may simply not step past
     * its anchor and hovers at the boundary, which is right beside its owner and
     * wrong on an open map — a creature parked at ten tiles from home is a
     * creature parked ten tiles nearer the road than it lives.
     *
     * THE PLAYER RETREATS AT HALF THE ROAMER'S PACE so that this measures the
     * LEASH and not the give-up counter. Walk away at full speed and the roamer
     * loses sight of you and gives up (`ai/simple.lua:209-211`) — a different
     * rule, tested below, that would make this one pass for the wrong reason.
     */
    const realms = makeRealms('roam-leash');
    const spot = openGround(realms, 12);
    const mine = stage(realms, spot);
    const level = realms.overworld.world.level;
    const body = realms.overworld.world.addPlayer('p1', 'Detective');
    body.x = spot.x + 3;
    body.y = spot.y;

    const beat = beater(realms.overworld);
    let furthest = 0;
    for (let i = 0; i < 30; i += 1) {
      beat();
      furthest = Math.max(furthest, fromHome(mine));
      if (i % 2 === 1 && canWalk(level, body.x + 1, body.y)) body.x += 1;
    }

    // IT REALLY WAS DRAGGED OUT. Without this the bound below passes for a
    // roamer that never moved at all, which is the shape this whole file's
    // history says the mistake takes.
    expect(furthest, 'it never followed anybody anywhere').toBeGreaterThan(6);
    expect(furthest, 'the leash did not hold').toBeLessThanOrEqual(10);
    expect(mine.targetId, 'it is still hunting somebody past its leash').toBeUndefined();

    // AND IT GOES BACK. Park the body out of the way so the return leg is not
    // racing a re-aggro; the assertion is about the walk home, not about what it
    // does once it gets there.
    //
    // THE CLOSEST IT GOT, NOT WHERE IT ENDED UP, and the difference is the whole
    // behaviour: arriving home CLEARS the latch, and a roamer with no latch and
    // nobody in sight goes back to drifting. Asserting on the last position
    // instead measured how far a random walk had got in the leftover beats, and
    // failed at 6.7 tiles for a creature that had walked home perfectly.
    body.x = 1;
    body.y = 1;
    let closest = Infinity;
    for (let i = 0; i < 20; i += 1) {
      beat();
      closest = Math.min(closest, fromHome(mine));
    }
    expect(closest, 'it never went back to where it came from').toBeLessThanOrEqual(1);
  });

  it('gives up on somebody it can no longer see — ai/simple.lua:209-211', () => {
    /**
     * Upstream falls back to `move_wander` once ten turns have passed since
     * `target_last_seen`. Ours counts in STEPS of the moor's clock rather than
     * game turns (see `GIVE_UP_STEPS`) and walks home rather than wandering,
     * because home is a thing a roamer has and a ToME monster does not.
     *
     * The body is moved rather than hidden: a mountain to duck behind is not
     * something the open ground this test needs also contains, and "out of
     * sight" is what the rule is about either way.
     */
    const realms = makeRealms('roam-giveup');
    const spot = openGround(realms, 12);
    const mine = stage(realms, spot);
    const body = realms.overworld.world.addPlayer('p1', 'Detective');
    body.x = spot.x + 4;
    body.y = spot.y;

    const beat = beater(realms.overworld);
    beat();
    expect(mine.targetId, 'it never noticed the body at four tiles').toBe(body.id);

    body.x = 1;
    body.y = 1;
    // THE CLOSEST IT GOT — see the leash test. Arriving home drops the latch and
    // a roamer with nobody in sight goes back to drifting, so the final tile
    // measures the drift rather than the walk.
    let closest = Infinity;
    for (let i = 0; i < 30; i += 1) {
      beat();
      closest = Math.min(closest, fromHome(mine));
    }

    expect(
      mine.targetId,
      'it is still hunting a body it has not seen for a minute',
    ).toBeUndefined();
    expect(closest, 'it gave up and then stood there').toBeLessThanOrEqual(1);
  });
});

describe('and when nobody is about, it keeps to its own country', () => {
  it('drifts, but never further from where it appeared than the leash', () => {
    /**
     * THE LEASH BOUNDS THE WANDER AS WELL AS THE CHASE, which is more than
     * `Party.lua` asks for and is the half a player actually feels. A free random
     * walk over seventeen thousand cells has no memory: the danger you routed
     * around yesterday is somewhere else today, and the map has no places in it.
     * Ten tiles is small enough that a roamer belongs to a piece of ground and
     * large enough that where it will be is still a guess.
     */
    const realms = makeRealms('roam-drift');
    settle(realms, 900);
    const roamers = [...realms.overworld.roamers.values()];
    expect(roamers.length).toBeGreaterThan(0);

    for (const r of roamers) {
      expect(fromHome(r), `${r.id} strayed ${fromHome(r).toFixed(1)} tiles`).toBeLessThanOrEqual(
        10,
      );
    }
    // AND THE BOUND IS NOT VACUOUS. Nine hundred steps of a walk that never left
    // its own tile would satisfy every assertion above.
    expect(
      roamers.some((r) => fromHome(r) > 1),
      'nothing wandered at all, so the bound above proves nothing',
    ).toBe(true);
  });

  it('anchors on the tile it appeared on, not on wherever it has got to', () => {
    // The anchor is written once at spawn and never again — a home that followed
    // the body would be a leash that measures nothing.
    const realms = makeRealms('roam-anchor');
    settle(realms, 60);
    const level = realms.overworld.world.level;
    for (const r of realms.overworld.roamers.values()) {
      expect(canWalk(level, r.homeX, r.homeY)).toBe(true);
      expect(isHaunt(tileAt(level, r.homeX, r.homeY))).toBe(true);
    }
  });
});
