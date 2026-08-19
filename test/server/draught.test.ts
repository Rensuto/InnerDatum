import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ITEMS, isConsumable, itemById } from '../../src/server/content/items.ts';
import { resolveMBonus } from '../../src/server/content/resolvers.ts';
import { healActor } from '../../src/server/engine/talents.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THIRD WAY A FIGHT CAN END.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A party at a fifth of its health could retreat or it could die. There was no
 * third option, because there were no consumables at all: twenty-two items
 * across seven slots, every one of them a permanent upgrade. So money in this
 * game was ONE DECISION LONG — you bought the best coat you could afford and
 * after that the number only went up — and the moment a roguelike fight
 * actually turns on, *"I am nearly dead and I drink something"*, did not exist.
 *
 * ═══ THE NUMBER IS UPSTREAM'S, AND IT IS DELIBERATELY LARGE ═══
 * `scrolls.lua:142`, the healing infusion: `heal = resolvers.mbonus_level(80,
 * 40, ...)`, which is 40 at level 1. Against health bars of 54 to 72 that is
 * most of one, and it should be: a heal that does not visibly change the
 * situation is a button nobody presses at the moment it matters.
 */

describe('there is something to drink', () => {
  it('ships exactly one consumable, and the rest of the catalogue is worn', () => {
    const drinkable = ITEMS.filter(isConsumable);
    expect(drinkable).toHaveLength(1);
    // ONE, NOT A LADDER OF THREE, because there is one vial on disk and two
    // items sharing a picture is a player squinting at a tooltip to tell their
    // healing apart. See the note on `DRAUGHTS`.
    expect(drinkable[0]?.id).toBe('item_draught_mending');
    for (const item of ITEMS) {
      // Every item is one thing or the other, and never both: a slot means worn,
      // a `use` means drunk, and nothing sensible is in the middle.
      expect(item.slot === undefined, `${item.id}`).toBe(item.use !== undefined);
    }
  });

  it('heals what ToME says it heals', () => {
    // scrolls.lua:142 `resolvers.mbonus_level(80, 40, ...)` = 40 at level 1.
    expect(itemById('item_draught_mending')?.use?.amount).toBe(resolveMBonus(80, 40));
    expect(itemById('item_draught_mending')?.use?.amount).toBe(40);
  });

  it('cannot be worn, and cannot take an ego', () => {
    /**
     * THE TWO PROPERTIES THAT FALL OUT OF `slot` BEING ABSENT, and they are the
     * reason an optional field beat a second catalogue. `resolveItem` refuses an
     * ego'd draught outright — an id claiming one is an id this build cannot
     * make sense of, which is the same answer an unknown ego code already gets.
     */
    const draught = itemById('item_draught_mending');
    expect(draught?.slot).toBeUndefined();
    expect(draught?.wielder.stats).toBeUndefined();
    expect(draught?.wielder.mods).toBeUndefined();
  });
});

describe('drinking it', () => {
  function hurt(): ReturnType<typeof createWorld> {
    const world = createWorld('draught');
    world.level.tiles.fill(TileCode.FLOOR);
    return world;
  }

  it('restores hit points, and never more than the bar holds', () => {
    /**
     * `healActor` already owned the no-overheal rule and answers how much it
     * ACTUALLY restored — which is the number the Case Log line says, so a
     * player at full health who drinks one is told plainly that they wasted it
     * rather than watching a bar not move.
     */
    const world = hurt();
    const body = world.addPlayer('p1', 'Sam', { maxHp: 60 });
    body.hp = 12;

    const draught = itemById('item_draught_mending');
    expect(draught?.use).toBeDefined();
    const healed = healActor(body, draught?.use?.amount ?? 0);

    expect(healed).toBe(40);
    expect(body.hp).toBe(52);
  });

  it('is clamped at the top of the bar, and says so by answering zero', () => {
    const world = hurt();
    const body = world.addPlayer('p1', 'Sam', { maxHp: 60 });
    body.hp = 60;

    expect(healActor(body, 40)).toBe(0);
    expect(body.hp).toBe(60);
  });

  it('cannot bring anybody back from the dead', () => {
    // A draught is not a revive. `downed.ts` owns that, it is a five-turn
    // countdown a PARTY resolves, and an item that quietly did it would delete
    // the one mechanic this game has that makes people run to each other.
    const world = hurt();
    const body = world.addPlayer('p1', 'Sam', { maxHp: 60 });
    body.hp = 0;
    body.alive = false;

    healActor(body, 40);
    expect(body.alive).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE VERB ACTUALLY REACHES THE SERVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above is the mechanic in isolation, and this project has shipped
 * four separate subsystems that passed exactly that kind of test while no client
 * could reach them — a status system with a hundred references and no caller, a
 * talent note whose only reference was its setter, Sigil's mark projected
 * nowhere, a region line wired to nothing. So this drives a real socket.
 */
const openSockets: WebSocket[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  for (const close of closers) await close();
  closers.length = 0;
});

describe('the use frame', () => {
  it('takes the draught out of the bag and puts the hit points on', async () => {
    const world = createWorld('draught-socket');
    world.level.tiles.fill(TileCode.FLOOR);

    const app = Fastify({ logger: false });
    await app.register(wsGateway, { world, engine: createTurnEngine({ world }) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    closers.push(async () => {
      await app.close();
    });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/ws`);
    openSockets.push(socket);
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
    const deadline = Date.now() + 4_000;
    let actorId: string;
    for (;;) {
      const welcome = frames.find((f) => f['t'] === 'welcome');
      const id = welcome?.['selfId'];
      if (typeof id === 'string') {
        actorId = id;
        break;
      }
      if (Date.now() >= deadline) throw new Error('no welcome');
      await sleep(5);
    }

    const body = world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined || body.kind !== 'player') return;
    body.hp = 10;
    body.carried = [...(body.carried ?? []), 'item_draught_mending'];

    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'use', itemId: 'item_draught_mending' }));
    await sleep(150);

    /**
     * THE THREE FACTS, and each one is a different way this could be wired to
     * nothing: the heal landed, the bottle is gone, and the party was told.
     *
     * `>= 50` AND NOT `=== 50`, and the half point is the game working rather
     * than a rounding slip: 10 + 40 is 50, and then the TURN THE DRAUGHT COST
     * ticked the base clock, which paid regeneration. Pinning the exact number
     * would be pinning the regen rate in a file about drinking.
     */
    expect(body.hp).toBeGreaterThanOrEqual(50);
    expect(body.hp).toBeLessThan(55);
    expect(body.carried ?? []).not.toContain('item_draught_mending');

    const said = frames
      .filter((f) => f['t'] === 'log')
      .flatMap((f): unknown[] => (Array.isArray(f['lines']) ? (f['lines'] as unknown[]) : []))
      .map((row) => String((row as Record<string, unknown>)['text']));
    expect(said.some((line) => line.includes('drinks Draught of Mending'))).toBe(true);
  });
});
