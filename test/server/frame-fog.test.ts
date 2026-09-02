// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:30-34 (display_on_seen, remember FALSE)
//                       game/engines/default/engine/Object.lua:28-29 (remember TRUE — see the note below)
//                       game/engines/default/engine/Grid.lua:30-32 (terrain remembered)
//                       game/modules/tome/class/Projectile.lua:29-31 (seen only, never remembered)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectEffects,
  projectGroundItems,
  projectProjectiles,
} from '../../src/server/view/projector.ts';
import { visibleActorIds } from '../../src/server/view/projector.ts';
import { DEFAULT_SIGHT_RADIUS, knownTile, sightDistance } from '../../src/shared/sight.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';
import { createFog, fogSet } from '../../src/shared/fog.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { STUNNED } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BADGE IS A FACT ABOUT A BODY. AN ORB IS A POSITION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `6d201c3` fogged the board and `3911b1b` fogged the event stream, and both
 * left these two frames going to the whole realm. Each leaked in its own way:
 *
 *   `EffectsMsg`      told you an unseen monster was Off-balance, which names
 *                     it. `Actor.lua:30-34` is `display_on_seen = true`,
 *                     `display_on_remember = FALSE` — a body you cannot see is
 *                     not drawn, and nor is anything about it.
 *   `ProjectilesMsg`  drew every orb in the sky. `Projectile.lua:29-31` is the
 *                     same pair, and sharper: never remembered, because where a
 *                     bolt was two turns ago is not where it is.
 *
 * ═══ WHAT IS DELIBERATELY NOT IN THIS COMMIT ═══
 * `GroundMsg`. Objects are NOT gated like actors — `Object.lua:28-29` sets
 * `display_on_seen = true` AND `display_on_remember = true`, exactly as
 * `Grid.lua:30-32` does for terrain. You remember a coat you walked past. So
 * fogging floor loot to currently-visible tiles would be a DEVIATION dressed as
 * a fidelity fix; the faithful version filters against each player's EXPLORED
 * bitset, which is per-player, persisted, and a larger job. It is its own commit.
 */

const RNG = () => createRng('frame-fog');

/** An open field, so only the rule under test can hide anything. */
function field(): World {
  const world = createWorld('frame-fog');
  world.level.tiles.fill(TileCode.FLOOR);
  return world;
}

function husk(world: World, id: string, x: number, y: number) {
  return world.addMonster(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

describe('the effects frame', () => {
  /** A world with one stunned husk near the door and one stunned husk far off. */
  function stunned() {
    const world = field();
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    const near = husk(world, 'near', 3, 1);
    const far = husk(world, 'far', 1 + DEFAULT_SIGHT_RADIUS + 3, 1);
    expect(world.level.w).toBeGreaterThan(far.x);

    const effects = createEffectState([STUNNED]);
    setEffect(effects, near, STUNNED.id, 3, {}, RNG());
    setEffect(effects, far, STUNNED.id, 3, {}, RNG());
    return { world, effects };
  }

  it('carries the badge of a monster you can see', () => {
    const { world, effects } = stunned();
    const seen = visibleActorIds(world, [{ x: 1, y: 1 }]);
    const rows = projectEffects(world, effects, undefined, seen).actors.map((a) => a.id);
    expect(rows).toContain('near');
  });

  it('says nothing about a monster you cannot', () => {
    /**
     * THE LEAK. A badge row names an actor id, so shipping it for an unseen
     * husk told the client that something out there was Stunned — and the id is
     * enough to ask about, and the row's existence is enough to count.
     */
    const { world, effects } = stunned();
    const seen = visibleActorIds(world, [{ x: 1, y: 1 }]);
    const rows = projectEffects(world, effects, undefined, seen).actors.map((a) => a.id);
    expect(rows).not.toContain('far');
  });

  it('and with no eyes given, says everything — the GM console', () => {
    const { world, effects } = stunned();
    const rows = projectEffects(world, effects).actors.map((a) => a.id);
    expect(rows).toContain('near');
    expect(rows).toContain('far');
  });
});

// ---------------------------------------------------------------------------
// Orbs
// ---------------------------------------------------------------------------

describe('the projectiles frame', () => {
  function sky() {
    const world = field();
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    husk(world, 'shooter', 4, 1);
    husk(world, 'sniper', 1 + DEFAULT_SIGHT_RADIUS + 3, 1);

    // One orb in front of the party, one crossing the far end of the map.
    const near = world.addProjectile({
      sourceId: 'shooter',
      origin: { x: 4, y: 1 },
      to: { x: 2, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    const far = world.addProjectile({
      sourceId: 'sniper',
      origin: { x: 1 + DEFAULT_SIGHT_RADIUS + 3, y: 1 },
      to: { x: 1 + DEFAULT_SIGHT_RADIUS + 1, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    return { world, near: near.id, far: far.id };
  }

  const EYES = [{ x: 1, y: 1 }];

  it('draws an orb over ground you can see', () => {
    const { world, near } = sky();
    expect(projectProjectiles(world, EYES).projectiles.map((p) => p.id)).toContain(near);
  });

  it('does not draw one crossing the far end of the map', () => {
    const { world, far } = sky();
    expect(projectProjectiles(world, EYES).projectiles.map((p) => p.id)).not.toContain(far);
  });

  it('names the shooter when you can see them', () => {
    const { world, near } = sky();
    const orb = projectProjectiles(world, EYES).projectiles.find((p) => p.id === near);
    expect(orb?.sourceId).toBe('shooter');
  });

  it('DRAWS a shot from the dark, and does not name who fired it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE WHOLE REDACTION RULE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The orb is gated on ITS OWN tile and never on its shooter. Gating on the
     * shooter would hide incoming fire from the dark — the one thing a player
     * most needs to see, and which the engine is going to resolve either way.
     *
     * So the shot shows and the shooter does not. Upstream draws the orb by the
     * same rule (`Projectile.lua:29-31` is about the projectile's own tile) and
     * keeps `src` as an object reference that is never rendered.
     */
    const { world } = sky();
    const sniperShot = world.addProjectile({
      sourceId: 'sniper',
      origin: { x: 5, y: 1 },
      to: { x: 2, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    const orb = projectProjectiles(world, EYES).projectiles.find((p) => p.id === sniperShot.id);
    expect(orb, 'a shot over visible ground was withheld because of its shooter').toBeDefined();
    expect(orb?.sourceId, 'the unseen shooter was named').toBeUndefined();
    expect(JSON.stringify(orb), 'the name survived serialisation').not.toContain('sniper');
  });

  it('and with no eyes given, the whole sky — the GM console', () => {
    const { world, far } = sky();
    expect(projectProjectiles(world).projectiles.map((p) => p.id)).toContain(far);
  });
});

// ---------------------------------------------------------------------------
// Floor loot — remembered, not merely seen
// ---------------------------------------------------------------------------

describe('the ground frame', () => {
  /** Three piles: one on ground you remember, one you can see, one neither. */
  function floors() {
    const world = field();
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    world.addGroundItem({ x: 2, y: 1 }, 'item_watchmans_cap');
    world.addGroundItem({ x: 9, y: 1 }, 'item_watchmans_cap');
    world.addGroundItem({ x: 25, y: 1 }, 'item_watchmans_cap');
    // THROUGH THE PROJECTOR, not just onto the floor. `projectGroundItems`
    // drops anything `resolveItem` cannot answer for, and the first version of
    // this fixture invented an item id — so all three piles existed in the
    // world and none of them reached a frame, which would have made every
    // assertion below true of nothing.
    expect(world.groundItems()).toHaveLength(3);
    expect(projectGroundItems(world).items).toHaveLength(3);
    return world;
  }

  const tilesOf = (world: World, known?: (x: number, y: number) => boolean) =>
    projectGroundItems(world, known).items.map((row) => row.cell.join(','));

  it('shows a pile on a tile you REMEMBER, even standing nowhere near it', () => {
    /**
     * THE HALF THAT MAKES THIS DIFFERENT FROM EVERY OTHER FOGGED FRAME.
     * `Object.lua:28-29` is `display_on_remember = true`, exactly as
     * `Grid.lua:30-32` is for terrain. You walked past the coat; it stays on
     * your map. Gating loot on current sight would be a DEVIATION.
     */
    const world = floors();
    const remembered = (x: number, y: number) => x === 25 && y === 1;
    expect(tilesOf(world, remembered)).toEqual(['25,1']);
  });

  it('shows a pile you can see but have not walked to', () => {
    // `REVEAL_RADIUS` is 12 and `DEFAULT_SIGHT_RADIUS` is 20, so the two terms are not
    // redundant: there are eight tiles' worth of ground you can see and have
    // never revealed. Upstream has one radius and no such gap.
    const world = floors();
    const seenOnly = (x: number, y: number) => x === 9 && y === 1;
    expect(tilesOf(world, seenOnly)).toEqual(['9,1']);
  });

  it('says nothing about a floor you have neither seen nor walked', () => {
    const world = floors();
    expect(tilesOf(world, () => false)).toEqual([]);
  });

  it('and with no predicate, the whole floor — the GM console', () => {
    const world = floors();
    expect(tilesOf(world)).toHaveLength(3);
  });
});

describe('knownTile — the rule the gateway actually spends', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE JOIN, AND IT WAS UNTESTED WHILE BOTH HALVES WERE GREEN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `projectGroundItems` is covered above, but every one of those tests passes
   * its OWN predicate — so the predicate a real player is judged by was driven
   * by nothing. Two mutations proved it: deleting the memory term and deleting
   * the sight term both survived a green suite.
   *
   * This drives the extracted rule with both terms, and the mutations now fail.
   */
  const level = () => {
    const world = field();
    return world.level;
  };

  it('a tile you have walked is known, from anywhere on the map', () => {
    const lvl = level();
    const remembered = createFog(lvl.w, lvl.h);
    fogSet(remembered, lvl.w, 25, 1);
    // The eyes are nowhere near it — memory alone must carry this.
    expect(knownTile(lvl, [{ x: 1, y: 1 }], remembered, 25, 1)).toBe(true);
  });

  it('a tile you can see is known even with no memory at all', () => {
    /**
     * Sight alone must carry this — a character with no fog recorded at all
     * (the very first frame, before a step) still sees what is in front of them.
     *
     * THE COMMENT HERE USED TO CLAIM MORE THAN THAT. It said sight 20 exceeded
     * `REVEAL_RADIUS` 12 by eight tiles, so both terms were load-bearing. With
     * the radius corrected to 10 the containment runs the other way: everything
     * within sight is inside the reveal disc, so once a character has taken a
     * step this term is subsumed. It is kept because upstream ORs seen and
     * remembered (`Object.lua:28-29`) and because "before the first step" is a
     * real state, not because it catches ground memory misses.
     */
    const lvl = level();
    expect(knownTile(lvl, [{ x: 1, y: 1 }], undefined, 9, 1)).toBe(true);
  });

  it('a tile that is neither is not', () => {
    const lvl = level();
    const empty = createFog(lvl.w, lvl.h);
    expect(knownTile(lvl, [{ x: 1, y: 1 }], empty, 25, 1)).toBe(false);
  });

  it('and sight still stops at a wall', () => {
    const world = field();
    for (let y = 0; y < world.level.h; y += 1) {
      world.level.tiles[y * world.level.w + 5] = TileCode.WALL;
    }
    const empty = createFog(world.level.w, world.level.h);
    expect(knownTile(world.level, [{ x: 1, y: 3 }], empty, 9, 3)).toBe(false);
    // ...but memory sees through it, which is the whole point of remembering.
    fogSet(empty, world.level.w, 9, 3);
    expect(knownTile(world.level, [{ x: 1, y: 3 }], empty, 9, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('every player-facing frame is built with eyes', () => {
  it('the gateway never builds one without them', () => {
    /**
     * A SOURCE GUARD, on the terms `fov.test.ts` sets out: there is no runtime
     * seam that can tell a GM read from a player read, and every call in the
     * gateway serves a player. Both fogged forms take their argument at a fixed
     * place, so "is the fog argument there" is checkable by reading the call.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const [fn, needs] of [
      ['projectEffects', 'visibleActorIds'],
      ['projectProjectiles', 'eyesIn'],
    ] as const) {
      for (const match of text.matchAll(new RegExp(`${fn}\\(`, 'g'))) {
        const call = text.slice(match.index, match.index + 220);
        expect(
          call.includes(needs),
          `a ${fn} call in the gateway has no ${needs} — that frame goes out unfogged`,
        ).toBe(true);
      }
    }
  });

  it('and the ground frame is built against each viewer`s own memory', () => {
    /**
     * THE PIN FROM THE PREVIOUS COMMIT FIRED, WHICH IS WHY THIS READS DIFFERENTLY.
     *
     * It asserted the OLD signature — `projectGroundItems(world)` — with the
     * note *"this assertion should fail then, which is the point of writing it
     * down"*. It failed on the commit that fogged the floor, the reasoning was
     * re-read, and this replaced it. A pin that never fires is decoration.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const match of text.matchAll(/projectGroundItems\(/g)) {
      const call = text.slice(match.index, match.index + 220);
      expect(
        call.includes('knownTilesFor'),
        'a projectGroundItems call in the gateway has no knownTilesFor — that floor goes out unfogged',
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The join, over a real socket
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE MUTATION THE UNIT TESTS COULD NOT CATCH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `knownTile` is driven directly above and `projectGroundItems` is driven with
 * a hand-written predicate. Both green — and changing the GATEWAY to call
 * `knownTile(level, eyes, undefined, x, y)`, throwing away every character's
 * memory, survived the whole suite. Two correct layers, one untested line
 * between them: the failure this codebase keeps repeating.
 *
 * So this walks a real character, moves them out of sight of where they walked,
 * drops loot on the ground they REMEMBER, and reads the frame off a socket.
 */
describe('a remembered floor, over the wire', () => {
  let harness: { port: number; realms: Realms; close: () => Promise<void> };
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'ground-wire',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const app = Fastify({ logger: false });
    await app.register(wsGateway, {
      world: realms.overworld.world,
      engine: realms.overworld.engine,
      realms,
      parties,
      downed,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');
    harness = {
      port: address.port,
      realms,
      close: async (): Promise<void> => {
        await app.close();
      },
    };
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await harness.close();
  });

  it('still shows loot on ground the character walked and then left', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}/ws`);
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed === 'object' && parsed !== null) {
        frames.push({ ...(parsed as Record<string, unknown>) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('socket never opened'));
      });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello' }));

    const deadline = Date.now() + 4000;
    let selfId: string | undefined;
    for (;;) {
      const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
      if (typeof id === 'string') {
        selfId = id;
        break;
      }
      if (Date.now() >= deadline) throw new Error('no welcome came back');
      await sleep(5);
    }

    const world = harness.realms.overworld.world;
    const body = world.getActor(selfId);
    if (body === undefined) throw new Error('no body');

    // Walk, so the fog around the starting tile is genuinely revealed.
    const walked = { x: body.x, y: body.y };
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
    await sleep(150);

    // Then leave — far enough that `canSee` cannot reach the old ground, so ONLY
    // memory can put the pile in the frame.
    body.x = Math.min(world.level.w - 2, walked.x + DEFAULT_SIGHT_RADIUS + 6);
    world.addGroundItem(walked, 'item_watchmans_cap');
    expect(sightDistance(body, walked)).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

    frames.length = 0;
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hold' }));

    // POLLED, NOT SLEPT. A fixed wait made this the only flaky test in the
    // suite: it passed alone and failed about one run in three under the full
    // suite's load, which is the worst possible outcome — a real assertion
    // nobody can trust. Waiting for the FRAME rather than for the clock is both
    // faster and deterministic.
    const until = Date.now() + 4000;
    let ground: Record<string, unknown>[];
    for (;;) {
      ground = frames.filter((f) => f['t'] === 'ground');
      if (ground.length > 0 || Date.now() >= until) break;
      await sleep(10);
    }
    expect(ground, 'no ground frame arrived at all within four seconds').not.toEqual([]);
    const cells = ground.flatMap((f) =>
      ((f['items'] as { cell: readonly [number, number] }[] | undefined) ?? []).map((row) =>
        row.cell.join(','),
      ),
    );
    expect(
      cells,
      'the pile on remembered ground never reached the client — the gateway is not ' +
        'passing that character`s fog to knownTile',
    ).toContain(`${String(walked.x)},${String(walked.y)}`);
  });
});
