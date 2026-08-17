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

import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { MAX_ROAMERS, roamerAt, tickRoamers } from '../../src/server/world/roamers.ts';
import { tileAt } from '../../src/shared/level.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import type { Realms } from '../../src/server/world/realms.ts';

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
    expect(realms.overworld.roamers.size).toBe(MAX_ROAMERS);
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
