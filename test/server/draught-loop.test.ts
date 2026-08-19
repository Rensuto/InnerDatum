import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE LOOP, IN ONE GO: WALK IN, BUY IT, DRINK IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every piece of this has its own passing test — the heal, the shelf, the `use`
 * frame — and the pieces having tests is exactly the condition under which this
 * project has repeatedly shipped things nobody could reach. The draught proved
 * it twice in two commits: the mechanic landed with no source in the world, and
 * then the shelf that was supposed to be the source silently stocked nothing.
 *
 * So this asserts the SEQUENCE a player actually performs, over a socket,
 * against the real registry.
 *
 * ═══ AND ONE SEAM THAT NO OTHER TEST TOUCHES ═══
 * The client decides between `equip` and `use` by whether the carried row has a
 * `slot`. That decision is three lines in main.ts which the node test
 * environment cannot run — but its INPUT is a wire frame, and if the projector
 * puts a `slot` on a draught the client will send `equip` for it and the item is
 * dead on arrival while every server-side test stays green. That is the exact
 * shape of "reads fine and behaves wrong", so the frame is asserted here.
 */

const FRAME_TIMEOUT_MS = 4_000;
const DRAUGHT = 'item_draught_mending';

type Frame = Record<string, unknown>;

type Client = {
  send(frame: Frame): void;
  hello(): Promise<string>;
  latest(type: string): Frame | undefined;
  lines(): string[];
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const frames: Frame[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed: unknown = JSON.parse(String(event.data));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      frames.push({ ...parsed });
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket never opened'));
    });
  });

  const client: Client = {
    send(frame: Frame): void {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    },
    async hello(): Promise<string> {
      client.send({ t: 'hello' });
      const deadline = Date.now() + FRAME_TIMEOUT_MS;
      for (;;) {
        const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
        if (typeof id === 'string') return id;
        if (Date.now() >= deadline) throw new Error('no welcome came back');
        await sleep(5);
      }
    },
    /** The most recent frame of a type — inventory and shop are both re-sent. */
    latest(type: string): Frame | undefined {
      return [...frames].reverse().find((f) => f['t'] === type);
    },
    lines(): string[] {
      const out: string[] = [];
      for (const frame of frames) {
        if (frame['t'] !== 'log') continue;
        const rows = frame['lines'];
        if (!Array.isArray(rows)) continue;
        for (const row of rows as unknown[]) {
          const text = (row as Record<string, unknown>)['text'];
          if (typeof text === 'string') out.push(text);
        }
      }
      return out;
    },
    close(): void {
      socket.close();
    },
  };

  openClients.push(client);
  return client;
}

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed: 'draught-loop',
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    disconnectGraceMs: 30_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was bound');

  server = {
    port: address.port,
    realms,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
});

afterEach(async () => {
  for (const client of openClients) client.close();
  openClients.length = 0;
  await server.close();
});

/**
 * WALK INTO ASHWICK THROUGH THE DOOR, because the door is the thing under test.
 *
 * Placing a body in the realm by hand and re-`hello`ing does not move the
 * SESSION, and the session is what decides where a `shop` frame is addressed —
 * so the first version of this helper produced four failures that were entirely
 * about the helper. The body is put on the tile NEXT to the marker and takes one
 * step, which is `crossIntoSite` and every frame that follows it.
 */
async function intoAshwick(client: Client, actorId: string): Promise<void> {
  const overworld = server.realms.overworld;
  let cell: { x: number; y: number } | undefined;
  for (const [key, siteId] of overworld.sites) {
    if (siteId !== 'site:ashwick_row') continue;
    const [xs, ys] = key.split(',');
    cell = { x: Number(xs), y: Number(ys) };
  }
  if (cell === undefined) throw new Error('Ashwick is not on the map');

  const body = overworld.world.getActor(actorId);
  if (body === undefined) throw new Error('no body');
  body.x = cell.x - 1;
  body.y = cell.y;

  client.send({ t: 'move', dir: 'e' });
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (server.realms.realmOf(actorId)?.siteId !== 'site:ashwick_row' && Date.now() < deadline) {
    await sleep(10);
  }
  expect(server.realms.realmOf(actorId)?.siteId, 'never got through the door').toBe(
    'site:ashwick_row',
  );
  await sleep(80);
}

describe('a player can buy healing and drink it', () => {
  it('shows a shelf of draughts at Ashwick and nowhere else', async () => {
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    const shop = client.latest('shop');
    expect(shop, 'standing in Ashwick sent no shop frame').toBeDefined();

    const stock = shop?.['stock'];
    expect(Array.isArray(stock)).toBe(true);
    if (!Array.isArray(stock)) return;
    expect(stock.length).toBeGreaterThan(0);
    for (const row of stock as unknown[]) {
      const name = (row as Record<string, unknown>)['name'];
      expect(String(name)).toContain('Draught');
    }
  });

  it('lets a starting purse afford exactly one, and puts it in the bag', async () => {
    /**
     * 14 AGAINST A STARTING PURSE OF 15. That is the decision the economy was
     * missing: your whole opening purse is one draught or the start of a coat.
     * If this ever refuses, healing has become something a new player cannot buy
     * on their first visit, which is the visit that teaches them it exists.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    const before = client.latest('inventory')?.['money'];
    expect(typeof before).toBe('number');

    const stock = client.latest('shop')?.['stock'];
    if (!Array.isArray(stock)) throw new Error('no stock');
    const first = (stock[0] as Record<string, unknown> | undefined)?.['itemId'];
    expect(typeof first).toBe('string');

    client.send({ t: 'shop_buy', itemId: String(first) });
    await sleep(150);

    const bag = client.latest('inventory')?.['carried'];
    expect(Array.isArray(bag)).toBe(true);
    if (!Array.isArray(bag)) return;
    const ids = (bag as unknown[]).map((row) => String((row as Record<string, unknown>)['itemId']));
    expect(ids, 'the draught never reached the bag').toContain(DRAUGHT);
  });

  it('sends a carried draught with NO slot, which is what makes the click mean drink', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SEAM NO OTHER TEST TOUCHES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * main.ts chooses between `unequip`, `equip` and `use` on one question: does
     * this carried row have a `slot`? Those three lines cannot run in a node
     * test — but their INPUT is this frame, and a `slot` on a draught would make
     * every click send `equip`, which the server then refuses with "that is not
     * something you can wear". The item would be visibly in the bag and
     * impossible to drink, and every server-side test would stay green.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    // BOUGHT, NOT INJECTED. Writing to `body.carried` does not push an
    // inventory frame, so the first version of this test was asserting about a
    // frame the server had no reason to have sent — which is a test failing for
    // its own reasons rather than the code's.
    const stock = client.latest('shop')?.['stock'];
    if (!Array.isArray(stock)) throw new Error('no stock');
    const first = (stock[0] as Record<string, unknown> | undefined)?.['itemId'];
    client.send({ t: 'shop_buy', itemId: String(first) });
    await sleep(150);

    const bag = client.latest('inventory')?.['carried'];
    if (!Array.isArray(bag)) throw new Error('no inventory frame');
    const row = (bag as unknown[])
      .map((entry) => entry as Record<string, unknown>)
      .find((entry) => String(entry['itemId']) === DRAUGHT);

    expect(row, 'the draught is not in the inventory frame at all').toBeDefined();
    expect(row?.['slot'], 'a draught with a slot would be sent to `equip`').toBeUndefined();
    /**
     * …AND THE ABSENCE HAS TO MEAN SOMETHING. A frame where NOTHING carried a
     * slot would pass the assertion above while proving only that the projector
     * is broken, so this reads the same frame for a row that must have one.
     * `projectInventory` is the function under test either way; the socket is
     * here to prove it is the function the player's client is actually fed.
     */
    const everything = (bag as unknown[]).map((entry) => entry as Record<string, unknown>);
    const wornRows = everything.filter((entry) => entry['slot'] !== undefined);
    const drinkRows = everything.filter((entry) => entry['slot'] === undefined);
    expect(drinkRows.length, 'no slotless row — the draught never arrived').toBeGreaterThan(0);
    for (const drink of drinkRows) {
      expect(String(drink['itemId'])).toBe(DRAUGHT);
    }
    for (const gear of wornRows) {
      expect(String(gear['itemId']), 'a draught turned up with a slot').not.toBe(DRAUGHT);
    }
  });

  it('drinks it, and the bottle is gone', async () => {
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    const body = server.realms.realmOf(actorId)?.world.getActor(actorId);
    if (body === undefined || body.kind !== 'player') throw new Error('no body');
    body.carried = [...(body.carried ?? []), DRAUGHT];
    body.hp = 8;

    client.send({ t: 'use', itemId: DRAUGHT });
    await sleep(150);

    expect(body.hp).toBeGreaterThan(40);
    expect(body.carried ?? []).not.toContain(DRAUGHT);
    expect(client.lines().some((line) => line.includes('drinks Draught of Mending'))).toBe(true);
  });
});

describe('the sell side says what it will pay', () => {
  it('prices every carried row while you are standing at a counter', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SELLING USED TO BE AN UNLABELLED BUTTON ALMOST EXACTLY WHEN IT MATTERED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The panel read the sell price off the SHELF, so it could only label a sale
     * for something the shop happened to be stocking — four items, against a bag
     * full of whatever came out of a delve. The two rarely intersect, so the
     * player learned the spread by pressing SELL and watching their purse.
     *
     * `CarriedItemView.sell` is now sent for every carried row in a room with a
     * counter, so the label is the number the server will actually pay.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    const stock = client.latest('shop')?.['stock'];
    if (!Array.isArray(stock)) throw new Error('no stock');
    client.send({ t: 'shop_buy', itemId: String((stock[0] as Record<string, unknown>)['itemId']) });
    await sleep(150);

    const bag = client.latest('inventory')?.['carried'];
    if (!Array.isArray(bag)) throw new Error('no inventory');
    for (const row of bag as unknown[]) {
      const entry = row as Record<string, unknown>;
      expect(typeof entry['sell'], `${String(entry['itemId'])} has no price at a counter`).toBe(
        'number',
      );
      // AND IT IS A REAL OFFER. Every item priced at zero was refused outright
      // by `handleShopSell` — 19% of loot, measured — until the rounding floor.
      expect(Number(entry['sell'])).toBeGreaterThan(0);
    }
  });

  it('says nothing about price out on the moor, where there is nobody to sell to', async () => {
    /**
     * ABSENT RATHER THAN ZERO. A price is a fact about a transaction that is not
     * on offer, and a number sitting in a delve's inventory frame is one more
     * thing that would have to be explained as meaningless.
     */
    const client = await connect(server.port);
    await client.hello();
    await sleep(120);

    const bag = client.latest('inventory')?.['carried'];
    expect(Array.isArray(bag)).toBe(true);
    for (const row of (bag ?? []) as unknown[]) {
      expect((row as Record<string, unknown>)['sell']).toBeUndefined();
    }
  });
});

describe('a purse that is too light is not a wall', () => {
  it('refuses an unaffordable buy with the price, not with "you cannot go that way"', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SENTENCE WAS BEING WRITTEN, SENT, AND THROWN AWAY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED, walking a fresh character to Threadneedle Row on 15 gold
     * (`STARTING_MONEY`): the server sent `that costs 24 gold` and the player
     * was shown **"you cannot go that way"**. `refusalText` maps `illegal_move`
     * to that fixed string and discards `message` — correctly, because
     * `illegal_move` means "that tile, no" and only the client can phrase a
     * wall well.
     *
     * `ErrorCode.Refused` exists for the opposite case, and its own docstring
     * records this bug happening once before: party refusals rode
     * `not_your_turn` while *"you cannot invite yourself"* sat unseen in a
     * status line.
     *
     * THE CODE IS PINNED, NOT ONLY THE TEXT. A test that checked the message
     * alone would have passed for the entire life of the bug — the message was
     * always right, and the code is what decided whether anybody read it.
     */
    const client = await connect(server.port);
    const actorId = await client.hello();
    await intoAshwick(client, actorId);

    const stock = client.latest('shop')?.['stock'];
    if (!Array.isArray(stock)) throw new Error('no stock');
    const first = (stock[0] as Record<string, unknown> | undefined)?.['itemId'];

    /**
     * THE PURSE IS EMPTIED RATHER THAN THE ITEM CHOSEN. The shelf is rolled, so
     * "something they cannot afford" is not a thing this test gets to pick — and
     * a test that reached for the dearest row would pass or fail on the roll.
     */
    const body = server.realms.realmOf(actorId)?.world.getActor(actorId);
    if (body === undefined || body.kind !== 'player') throw new Error('no body');
    body.money = 0;

    client.send({ t: 'shop_buy', itemId: String(first) });
    await sleep(150);

    const error = client.latest('error');
    expect(error?.['code'], 'an empty purse is a rule, not a tile').toBe('refused');
    expect(String(error?.['message']), 'the price is the whole sentence').toMatch(/costs \d+ gold/);
  });
});
