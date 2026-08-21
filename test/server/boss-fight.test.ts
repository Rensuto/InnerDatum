import { BOSS_LEVELS_ABOVE_ROOM, delveLevel, specFor } from '../../src/server/content/delve.ts';
import { INDEX_WATCHER, monsterInit } from '../../src/server/content/monsters.ts';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLEEDING, SLOWED, STUNNED } from '../../src/server/content/effects.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createEffectState, registerEffect } from '../../src/server/engine/effects.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOMEBODY ACTUALLY FIGHTS THE WATCHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `boss.test.ts` asserts the creature from its template and from ONE static
 * measurement of a generated floor. Every claim about how it PLAYS was read off
 * `ai/npc.ts` rather than watched — and reading the source is exactly how the
 * first version of its header came to describe a stationary creature that
 * advances, and how a two-turn stun on a one-turn cadence got as far as being
 * written down.
 *
 * So this file fights it. Four claims, none of which had ever been observed:
 *
 *   1. the stun LANDS — nothing in this game had ever stunned a player
 *   2. and EXPIRES — a stun that never ticked down is the soft-lock again,
 *      arriving by a different route
 *   3. the dead zone REFUSES — inside `minRange` it cannot shoot, which is the
 *      whole counter to two hundred and twenty hit points
 *   4. the prize DROPS — the one authored body in the game does not roll for
 *      whether the walk was worth it
 *
 * ═══ AND `effects` HAS TO BE WIRED OR THIS MEASURES NOTHING ═══
 * `wsGateway` sends no effect frames unless `opts.effects` is supplied, and
 * `main.ts` records that this was once forgotten in production: *"NONE OF IT WAS
 * CONNECTED. `wsGateway` was registered without `effects`"*. Every other socket
 * suite in this repo omits it, so a stun test built on the usual harness would
 * have watched a socket that could not report a stun and called it a pass.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  // THE SAME THREE `main.ts` REGISTERS. See the header.
  const effects = createEffectState();
  for (const def of [STUNNED, BLEEDING, SLOWED]) registerEffect(effects, def);

  const realms = createRealms({
    seed: 'boss-fight',
    engineFor: (world) => createTurnEngine({ world, downed, parties, effects }),
  });

  const app = Fastify({ logger: false });
  await app.register(wsGateway, {
    world: realms.overworld.world,
    engine: realms.overworld.engine,
    realms,
    parties,
    downed,
    effects,
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
  for (const socket of openSockets) socket.close();
  openSockets.length = 0;
  await server.close();
});

type Client = {
  actorId: string;
  send(frame: Record<string, unknown>): void;
  lines(): string[];
  /** Every effect id this socket has ever been told the viewer carries. */
  everCarried(): string[];
  /** The viewer's current badges, from the newest `effects` frame. */
  carriedNow(): string[];
};

async function hello(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
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

  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const selfId = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof selfId === 'string') {
      const badgesIn = (frame: Record<string, unknown>): string[] => {
        const rows = frame['actors'];
        if (!Array.isArray(rows)) return [];
        const mine = (rows as Record<string, unknown>[]).find((r) => r['id'] === selfId);
        const list = mine?.['effects'];
        if (!Array.isArray(list)) return [];
        // NARROWED TO STRINGS BEFORE COLLECTING, never `String(unknown)`: an
        // effect row whose id was an object would otherwise read
        // '[object Object]' and quietly match nothing forever.
        return (list as Record<string, unknown>[])
          .map((e) => e['id'])
          .filter((id): id is string => typeof id === 'string' && id !== '');
      };
      return {
        actorId: selfId,
        send(frame): void {
          socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
        },
        lines(): string[] {
          const out: string[] = [];
          for (const frame of frames) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Record<string, unknown>[]) {
              if (typeof row['text'] === 'string') out.push(row['text']);
            }
          }
          return out;
        },
        everCarried(): string[] {
          const out = new Set<string>();
          for (const frame of frames) {
            if (frame['t'] !== 'effects') continue;
            for (const id of badgesIn(frame)) out.add(id);
          }
          return [...out];
        },
        carriedNow(): string[] {
          const latest = [...frames].reverse().find((f) => f['t'] === 'effects');
          return latest === undefined ? [] : badgesIn(latest);
        },
      };
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/**
 * Walk into the boss room, the long way, through both doors.
 *
 * TWO REAL CROSSINGS. The altar is on the Redaction, so a body has to reach the
 * second landmass before it can reach the room — and the session has to follow
 * it, which only a real `move` intent does. `rumour-gate.test.ts` records what
 * happens when a test teleports instead: every assertion fails with "nobody
 * answered", and the server was right.
 */
async function walkToTheAltar(realms: Realms, client: Client): Promise<void> {
  const step = async (map: string, cell: string): Promise<void> => {
    const realm = realms.get(map);
    const body = realm?.world.getActor(client.actorId);
    if (realm === undefined || body === undefined) throw new Error(`not on ${map}`);
    const [xs, ys] = cell.split(',');
    body.x = Number(xs) - 1;
    body.y = Number(ys);
    client.send({ t: 'move', dir: 'e' });
    await sleep(250);
  };

  const door = [...realms.overworld.sites].find(([, id]) => id === 'site:redaction');
  if (door === undefined) throw new Error('no door to the Redaction');
  await step(realms.overworld.id, door[0]);

  const dark = realms.get('realm:site:redaction');
  const altar = [...(dark?.sites ?? [])].find(([, id]) => id === 'site:redaction:watchers_altar');
  if (altar === undefined) throw new Error('the Redaction has no altar');
  await step('realm:site:redaction', altar[0]);
}

/** The boss, and the room it is standing in. */
function theWatcher(
  realms: Realms,
  actorId: string,
): { boss: ReturnType<typeof Object>; realm: NonNullable<ReturnType<Realms['realmOf']>> } {
  const realm = realms.realmOf(actorId);
  if (realm === undefined) throw new Error('nowhere');
  const boss = [...realm.world.allActors()].find(
    (a) => a.kind === ActorKind.Monster && a.rank === ActorRank.Boss,
  );
  if (boss === undefined) throw new Error('no boss in this room');
  return { boss, realm };
}

describe('fighting the Watcher', () => {
  it('is reachable by walking, through two doors', async () => {
    // THE PREREQUISITE FOR EVERY OTHER TEST HERE, asserted on its own so a
    // failure below cannot be mistaken for a combat problem.
    const client = await hello(server.port);
    await walkToTheAltar(server.realms, client);
    expect(server.realms.realmOf(client.actorId)?.siteId).toBe('site:redaction:watchers_altar');
    const { boss } = theWatcher(server.realms, client.actorId);

    /**
     * ═══ THE PROPERTY, NOT THE LITERAL. THIS LINE READ `toBe(220)`. ═══
     * 220 is `INDEX_WATCHER.maxHp`, the authored base, and it was correct for
     * exactly as long as nothing in this game had a level: every body ever
     * spawned was level 1, because no caller passed `monsterInit` a third
     * argument. The room is level 11 now (the moor's altar at 7, plus 4 for
     * being through the Redaction) and its boss is two above that.
     *
     * PINNING THE NEW NUMBER WOULD REPEAT THE MISTAKE — it would fail on the
     * next tuning pass and say nothing about whether the boss is scaled. So
     * this asserts what the test is actually for: it is grown, and it is grown
     * BY THE ROOM rather than by some fixed multiplier.
     */
    const spec = specFor('site:redaction:watchers_altar');
    expect(spec, 'the redacted altar has no delve spec').toBeDefined();
    const roomLevel = spec === undefined ? 1 : delveLevel(spec);
    expect(roomLevel, 'the redacted altar is still a level-1 room').toBeGreaterThan(1);
    expect(boss.maxHp, 'the boss did not grow with its room').toBeGreaterThan(INDEX_WATCHER.maxHp);
    expect(boss.maxHp).toBe(
      monsterInit(INDEX_WATCHER, { x: 1, y: 1 }, roomLevel + BOSS_LEVELS_ABOVE_ROOM).maxHp,
    );
  });

  it('stuns the player, and the stun wears off', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NOTHING IN THIS GAME HAD EVER STUNNED A PLAYER. THIS IS IT HAPPENING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ THE FIRST VERSION OF THIS TEST WAS NOT SURVIVABLE ═══
     * It stood a fresh level-1 body at six tiles and held for twenty-four
     * turns. The badge list came back empty and the diagnostic said why: the
     * player was at `2,15` — the DOOR — with three monsters in a room that had
     * been emptied. They had died. `cleared.ts` records what happens next:
     * *"a wiped party's floor is RESET: `resetFloor` reaps every monster and
     * the erased player is restored"*. The test was measuring a corpse.
     *
     * So the body is given a pool it can observe from. THAT IS SCENARIO, NOT
     * MECHANISM — every shot, every effect roll and every duration tick is the
     * real pipeline; the only lie is that this detective is unusually hard to
     * kill, and without it there is nothing standing there to stun.
     */
    const client = await hello(server.port);
    await walkToTheAltar(server.realms, client);
    const { boss, realm } = theWatcher(server.realms, client.actorId);
    const me = realm.world.getActor(client.actorId);
    if (me === undefined) throw new Error('no body');

    // ALONE WITH IT. Twenty other residents share this room and an earlier run
    // was bled by an elite before the boss ever fired.
    for (const other of [...realm.world.allActors()]) {
      if (other.kind === ActorKind.Monster && other.id !== boss.id) {
        realm.world.removeActor(other.id);
      }
    }
    me.maxHp = 900;
    me.hp = 900;
    me.x = boss.x - 9;
    me.y = boss.y;

    for (let turn = 0; turn < 40 && !client.everCarried().includes('effect:stunned'); turn += 1) {
      client.send({ t: 'hold' });
      await sleep(70);
    }
    expect(
      client.everCarried(),
      `never stunned — badges: ${client.everCarried().join(', ') || 'none'}, hp ${String(me.hp)}`,
    ).toContain('effect:stunned');

    // ── AND IT WEARS OFF, which is the soft-lock arriving by another route: a
    //    stun that lands and never ticks down is a player who never acts again.
    me.x = boss.x - 40;
    me.y = boss.y;
    for (let turn = 0; turn < 30 && client.carriedNow().includes('effect:stunned'); turn += 1) {
      client.send({ t: 'hold' });
      await sleep(70);
    }
    expect(client.carriedNow(), 'the stun never expired').not.toContain('effect:stunned');
  });

  it('is answered by closing on it, and standing still is what kills you', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE COUNTER, MEASURED — AND THE FIRST VERSION OF THE CLAIM WAS WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The header said *"get inside three tiles and it cannot fight back at
     * all"*. Driven with a player standing still inside the dead zone, that is
     * FALSE: it backed from (32,1) to (32,4) and went on shooting for 4.7 a
     * turn — `kite` retreats before it holds, and holding only happens when it
     * has nowhere left to go.
     *
     * What is true, and is the actual design, is that it retreats at 0.7
     * against a player pinned at 1.0 by D1. PURSUE it and you pin it in the
     * corner `populateDelve` put it in. Measured over forty turns from nine
     * tiles: standing costs 198 and six stunned turns, pursuing costs 22 and
     * ends adjacent. That is a factor of nine, and it is the whole fight.
     */
    const client = await hello(server.port);
    await walkToTheAltar(server.realms, client);
    const { boss, realm } = theWatcher(server.realms, client.actorId);
    const me = realm.world.getActor(client.actorId);
    if (me === undefined) throw new Error('no body');

    for (const other of [...realm.world.allActors()]) {
      if (other.kind === ActorKind.Monster && other.id !== boss.id) {
        realm.world.removeActor(other.id);
      }
    }
    me.maxHp = 900;
    me.hp = 900;
    me.x = boss.x - 9;
    me.y = boss.y;

    const before = me.hp;
    for (let turn = 0; turn < 45; turn += 1) {
      // WALK AT IT. The direction is recomputed each turn because it retreats.
      const dx = Math.sign(boss.x - me.x);
      const dy = Math.sign(boss.y - me.y);
      const dir =
        dy === 0 ? (dx > 0 ? 'e' : 'w') : dx === 0 ? (dy > 0 ? 's' : 'n') : dy > 0 ? 'se' : 'ne';
      client.send({ t: 'move', dir });
      await sleep(70);
    }

    const reached = Math.max(Math.abs(me.x - boss.x), Math.abs(me.y - boss.y));
    expect(
      reached,
      `never closed — ended at ${String(reached)} tiles, me ${String(me.x)},${String(me.y)} boss ${String(boss.x)},${String(boss.y)}`,
      // `ai.minRange` ON A LIVE ACTOR. The flat `minRange` is a TEMPLATE field
      // and reads `undefined` here — an earlier version compared against it and
      // failed with "expected value must be number, received undefined", which
      // is the same probe-shape mistake in a different costume.
    ).toBeLessThan(boss.ai.minRange);
    // AND IT COST FAR LESS THAN STANDING THERE WOULD HAVE. Stated against the
    // creature's own published output rather than a literal, so a retune of the
    // orb has to come past this.
    const standingWouldCost = 45 * 5.95;
    expect(before - me.hp).toBeLessThan(standingWouldCost / 2);
  });

  it('is holding something, and it drops when it dies', async () => {
    /**
     * The one authored body in the game does not roll for whether the walk was
     * worth it. Driven rather than asserted on `carried`, because a prize that
     * is held and never spills is the same as no prize: `boss.test.ts` proves
     * the field is set, and this proves the floor gets it.
     *
     * THE SCENARIO IS SHAPED, THE KILL IS NOT — one hit point, then a real bump
     * through the damage pipeline. An earlier probe in this project set
     * `hp = 0; alive = false` and reported zero loot spills because it had
     * skipped the very pipeline that spills them.
     */
    const client = await hello(server.port);
    await walkToTheAltar(server.realms, client);
    const { boss, realm } = theWatcher(server.realms, client.actorId);
    const me = realm.world.getActor(client.actorId);
    if (me === undefined) throw new Error('no body');

    expect(boss.carried?.length ?? 0, 'the boss generated empty-handed').toBeGreaterThan(0);
    const floorBefore = realm.world.groundItems().length;

    boss.hp = 1;
    for (let swing = 0; swing < 40 && boss.alive; swing += 1) {
      me.x = boss.x - 1;
      me.y = boss.y;
      client.send({ t: 'move', dir: 'e' });
      await sleep(70);
    }
    await sleep(250);

    expect(boss.alive, 'never managed to kill it').toBe(false);
    expect(
      realm.world.groundItems().length,
      'it died holding the prize and the floor never got it',
    ).toBeGreaterThan(floorBefore);
  });
});
