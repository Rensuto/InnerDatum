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
import { tileAt } from '../../src/shared/level.ts';
import { ActorKind, TileCode, isHaunt, isWalkable } from '../../src/shared/protocol.ts';
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
    expect(canvas).toContain("sprites.sprite('ui_token_ring_hostile')");
    expect(canvas).toContain('if (site.sprite !== undefined)');
  });
});
