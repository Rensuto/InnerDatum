// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ELSEWHERE, EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import {
  ITEMS,
  ItemUseKind,
  KNOT_COOLDOWN_TURNS,
  KNOT_OF_ELSEWHERE_ID,
  KNOT_WIND_UP_TURNS,
  itemById,
} from '../../src/server/content/items.ts';
import { cooldownOf } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown, isDowned, survivalOf } from '../../src/server/engine/downed.ts';
import {
  EffectStatus,
  breakDamageSensitive,
  effectDur,
  hasEffect,
  removeEffect,
  setEffect,
  timedEffects,
} from '../../src/server/engine/effects.ts';
import { createPartyState, isLeader, partyIdOf } from '../../src/server/engine/party.ts';
import {
  MAX_COOLDOWN_TURNS,
  TOME_ACTIONS_PER_TURN,
  tomeCooldownToTurns,
} from '../../src/server/engine/talents.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms, floorsOfSite, stairsDownOf } from '../../src/server/world/realms.ts';
import { createRng } from '../../src/shared/rng.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { tileIndex } from '../../src/shared/coords.ts';
import { canWalk } from '../../src/shared/level.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { EffectActor, EffectLogLine, EffectState } from '../../src/server/engine/effects.ts';
import type { PartyState } from '../../src/server/engine/party.ts';
import type { Realm, Realms, SiteDef } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KNOT OF ELSEWHERE — THE BUTTON DOES WHAT THE BUTTON SAYS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from play, with a screenshot: the Knot sat on the action bar, the
 * slot said USE, the card said *"press to use it"*, and the server answered
 * *"that is not something you can use"* — ten times over, because the player
 * kept trying. A HUD that offers an action the server refuses is worse than no
 * button at all, so this file drives the whole path over a real socket.
 *
 * ═══ IT IS THE JOIN THAT BREAKS, NOT THE HALVES ═══
 * The effect counts down correctly in `effects.test.ts`, `crossOut` moves a
 * body correctly for every walker in `floors.test.ts`, and the item authors
 * correctly in `items.test.ts`. Every bug this feature can have lives BETWEEN
 * those: an expiry that cannot be told from a cancellation, a rest that
 * swallows the pump that reported it, a party that half-arrives, a wind-up that
 * survives a door. So nothing here is asked of a fixture — a client presses the
 * item, the world runs, and the questions are asked of where the bodies
 * actually are.
 */

const FRAME_TIMEOUT_MS = 4_000;
const UNDERWORKS = 'site:underworks';

type Frame = Record<string, unknown>;

type Client = {
  actorId: string;
  send(frame: Frame): void;
  frames(): Frame[];
  latest(type: string): Frame | undefined;
  count(type: string): number;
  errors(): string[];
  lines(): string[];
  close(): void;
};

const openClients: Client[] = [];

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const seen: Frame[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed: unknown = JSON.parse(String(event.data));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      seen.push({ ...parsed });
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

  const send = (frame: Frame): void => {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  };
  send({ t: 'hello' });

  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const id = seen.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') {
      const client: Client = {
        actorId: id,
        send,
        frames: () => [...seen],
        latest: (type) => [...seen].reverse().find((f) => f['t'] === type),
        count: (type) => seen.filter((f) => f['t'] === type).length,
        errors: () =>
          seen
            .filter((f) => f['t'] === 'error')
            .map((f) =>
              [f['code'], f['message']]
                .filter((v): v is string => typeof v === 'string')
                .join(': '),
            ),
        lines: () => {
          const out: string[] = [];
          for (const frame of seen) {
            if (frame['t'] !== 'log') continue;
            const rows = frame['lines'];
            if (!Array.isArray(rows)) continue;
            for (const row of rows as Frame[]) {
              if (typeof row['text'] === 'string') out.push(row['text']);
            }
          }
          return out;
        },
        close: () => {
          socket.close();
        },
      };
      openClients.push(client);
      return client;
    }
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

type Harness = {
  port: number;
  realms: Realms;
  parties: PartyState;
  effects: EffectState;
  downed: DownedState;
  close: () => Promise<void>;
};
let server: Harness;

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  const effects = createMvpEffectState();
  const realms = createRealms({
    seed: 'elsewhere',
    effects,
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
    parties,
    effects,
    downed,
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

function site(id: string): SiteDef {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no such site: ${id}`);
  return def;
}

function realmOf(client: Client): Realm {
  const realm = server.realms.realmOf(client.actorId);
  if (realm === undefined) throw new Error('the body is in no realm');
  return realm;
}

/** The door cell on the overworld that opens `siteId`. */
function doorTo(siteId: string): { x: number; y: number } {
  const door = [...server.realms.overworld.sites].find(([, id]) => id === siteId);
  if (door === undefined) throw new Error(`no door to ${siteId}`);
  const [xs, ys] = door[0].split(',');
  return { x: Number(xs), y: Number(ys) };
}

/**
 * NOTHING LEFT ALIVE IN HERE.
 *
 * Not tidiness: `handleRest` refuses outright while `engagement > 0`, and
 * resting is how a party sits through a twenty-turn wind-up. A floor with a husk
 * on it would refuse every rest in this file and every case would fail for a
 * reason that has nothing to do with the rule it is testing.
 */
function clear(realm: Realm): void {
  for (const actor of realm.world.allActors()) {
    if (actor.kind === ActorKind.Monster) realm.world.removeActor(actor.id);
  }
}

/** Step onto the door cell from the west. Real movement, so `enteredFrom` is written. */
async function walkIn(client: Client, siteId = UNDERWORKS): Promise<Realm> {
  const cell = doorTo(siteId);
  const body = server.realms.overworld.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body on the overworld');
  body.x = cell.x - 1;
  body.y = cell.y;
  client.send({ t: 'move', dir: 'e' });
  await sleep(250);
  const inside = realmOf(client);
  if (inside.id === server.realms.overworld.id) {
    throw new Error(`never got in (${client.errors().join('; ') || 'no error'})`);
  }
  clear(inside);
  return inside;
}

/** Put one in their hand. The warden drops it; this file is not about the warden. */
function handTheKnot(client: Client): void {
  const body = realmOf(client).world.getActor(client.actorId);
  if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
  body.carried = [...(body.carried ?? []), KNOT_OF_ELSEWHERE_ID];
}

async function pull(client: Client): Promise<void> {
  client.send({ t: 'use', itemId: KNOT_OF_ELSEWHERE_ID });
  await sleep(200);
}

const STEPS = [
  { dir: 'e', dx: 1, dy: 0 },
  { dir: 'w', dx: -1, dy: 0 },
  { dir: 's', dx: 0, dy: 1 },
  { dir: 'n', dx: 0, dy: -1 },
] as const;

/** One real step in whichever direction is open. Used to prove movement does NOT cancel. */
async function stepAnywhere(client: Client): Promise<void> {
  const realm = realmOf(client);
  const body = realm.world.getActor(client.actorId);
  if (body === undefined) throw new Error('no body');
  const step = STEPS.find(
    (s) =>
      canWalk(realm.world.level, body.x + s.dx, body.y + s.dy) &&
      realm.world.actorAt(body.x + s.dx, body.y + s.dy) === undefined,
  );
  if (step === undefined) throw new Error('nowhere to step');
  client.send({ t: 'move', dir: step.dir });
  await sleep(200);
}

// ---------------------------------------------------------------------------
// The numbers, and where each of them comes from
// ---------------------------------------------------------------------------

describe('what the Knot is authored as', () => {
  /**
   * THE ARITHMETIC, PINNED WHERE IT MAY BE. `content/items.ts` imports TYPES
   * ONLY — a runtime edge into the engine closes a cycle in a project with no
   * build step — so the wind-up is written out there with the sum in a comment.
   * A test is in neither file and may import both, which is what makes the
   * comment checkable rather than decorative.
   */
  it('winds up for upstream`s forty turns, in this codebase`s units', () => {
    // quest-artifacts.lua:326 and :336 both say 40, in ToME turns.
    const TOME_RECALL_TURNS = 40;
    expect(TOME_ACTIONS_PER_TURN).toBe(2);
    expect(KNOT_WIND_UP_TURNS).toBe(tomeCooldownToTurns(TOME_RECALL_TURNS));
    expect(KNOT_WIND_UP_TURNS).toBe(20);
  });

  it('is rate-limited at the longest cooldown this game has', () => {
    expect(KNOT_COOLDOWN_TURNS).toBe(MAX_COOLDOWN_TURNS);
  });

  it('carries a `use`, and it is not the kind you drink', () => {
    const knot = itemById(KNOT_OF_ELSEWHERE_ID);
    expect(knot?.use?.kind).toBe(ItemUseKind.Elsewhere);
    expect(knot?.slot, 'held, never worn').toBeUndefined();
    expect(knot?.quest, 'unsellable and out of the drop pools').toBe(true);
  });

  /**
   * ═══ THE DIVERGENCE THAT IS NOT ONE, PINNED SO NOBODY "FIXES" IT ═══
   * Upstream's recall is broken by NOTHING: not damage, not movement, not a
   * hostile in view (quest-artifacts.lua has no such clause, and the effect at
   * other.lua:3331-3355 has no `on_timeout` at all). `breaksOnDamage` exists in
   * this engine and is the obvious knob; turning it on would make an item that
   * exists for the fight you are losing stop working in exactly that fight.
   */
  it('is not broken by damage, and that is upstream`s rule and not an oversight', () => {
    expect(ELSEWHERE.breaksOnDamage).not.toBe(true);
    const state = createMvpEffectState();
    const rng = createRng('break');
    const body = {
      id: 'p1',
      name: 'Sam',
      kind: ActorKind.Player,
      hp: 30,
      maxHp: 60,
      alive: true,
      cooldowns: new Map<string, number>(),
    };
    setEffect(state, body, EffectId.Elsewhere, KNOT_WIND_UP_TURNS, {}, rng);
    expect(breakDamageSensitive(state, body, rng)).toEqual([]);
    expect(hasEffect(state, 'p1', EffectId.Elsewhere)).toBe(true);
  });

  /**
   * BENEFICIAL, which two other rules read: `restCheck`'s `afflicted` clause
   * must NOT see it (waiting one out is `RestView.recalling`'s job, and
   * upstream needs both clauses for the same reason), and `dispel` will not
   * take it off — nothing in this game should be able to strip somebody's way
   * home. other.lua:3337.
   */
  it('is beneficial, so nothing strips it and `afflicted` does not count it', () => {
    expect(ELSEWHERE.status).toBe(EffectStatus.Beneficial);
    expect(ELSEWHERE.restWaitsFor, 'Player.lua:1066-1077').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The distinction the whole feature stands on
// ---------------------------------------------------------------------------

describe('an expiry and a cancellation are different things', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `kind: 'lost'` MEANT BOTH, AND FOR EVERY OTHER EFFECT IT STILL MAY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * For a bleed they genuinely are one thing: the badge goes away either way,
   * and `statusToWire` is right to map both to `effect_expired`. The recall is
   * the first effect in this codebase that does one thing when the clock runs
   * out and the opposite thing when something takes it off — upstream's own
   * cut, at other.lua:3343-3353, on exactly `eff.dur <= 0`.
   *
   * ASKED OF `removeEffect` DIRECTLY, because that is where the rule lives and
   * because the socket path has a SECOND guard in front of it (the gateway's
   * recall ledger is cleared before a cancellation ever reaches the engine). A
   * feature test therefore cannot fail when this flag is wrong, which is the
   * definition of a rule that is not being tested: mutating `eff.dur <= 0` to a
   * constant `true` left all twenty-one of the socket cases green.
   */
  function counting(): { state: EffectState; body: EffectActor; notes: EffectLogLine[] } {
    const state = createMvpEffectState();
    const notes: EffectLogLine[] = [];
    const body: EffectActor = {
      id: 'p1',
      name: 'Sam',
      kind: ActorKind.Player,
      hp: 40,
      maxHp: 60,
      alive: true,
      cooldowns: new Map<string, number>(),
    };
    setEffect(state, body, EffectId.Elsewhere, 2, {}, createRng('expiry'), {
      log: (line) => notes.push(line),
    });
    return { state, body, notes };
  }

  it('reports a clock that ran out as expired', () => {
    const { state, body, notes } = counting();
    const rng = createRng('expiry');
    const ctx = { log: (line: EffectLogLine) => notes.push(line) };
    // ActorTemporaryEffects.lua:80-91 — an instance is queued for removal only
    // once `dur` has ALREADY reached zero, and the decrement is afterwards.
    timedEffects(state, body, rng, ctx);
    timedEffects(state, body, rng, ctx);
    timedEffects(state, body, rng, ctx);
    expect(hasEffect(state, 'p1', EffectId.Elsewhere)).toBe(false);
    const lost = notes.filter((note) => note.kind === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.expired, 'a countdown that finished read as a cancellation').toBe(true);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * AND THE LAYER THE DISTINCTION IS ACTUALLY CONSUMED AT — `PumpResult.expired`.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * The two cases above pin `removeEffect`; `expiredNotes` is what CARRIES the
   * fact out of a pump, and a mutation audit found it unpinned — dropping its
   * `note.expired !== true` clause left every socket case green, because
   * `yankOut` holds a second guard (the ledger) that catches the leak. A guard
   * whose partner is the only thing tested is a guard somebody deletes.
   *
   * ONE PUMP, TWO `lost` NOTES, AND ONLY ONE OF THEM IS AN EXPIRY. Suffocating
   * is the one effect this codebase takes off a body from INSIDE a pump for a
   * reason that is not a clock — `stopSuffocating`, the port of `cleanActor`'s
   * `removeEffect(eff, false, true)` (dialogs/DeathDialog.lua:115) — so a body
   * that steps out of water on the same turn its wind-up runs out produces
   * exactly the pair this filter exists to separate. Without the clause the
   * gateway would be handed “the Suffocating on p1 finished”, which is a sentence
   * nothing downstream has any right to act on.
   */
  it('carries the expiry out of a pump and leaves every other removal behind', () => {
    const world = createWorld('expired-notes');
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createMvpEffectState();
    const body = world.addPlayer('p1', 'Dalt', { maxHp: 1_000 });
    body.hpRegen = 0;
    body.x = 12;
    body.y = 4;
    world.level.tiles[tileIndex(12, 4, world.level.w)] = TileCode.POND_WATER;

    const engine = createTurnEngine({ world, effects });
    engine.join('p1');

    // UNDER LONG ENOUGH TO BE SUFFOCATING. The air clock is the world's, not
    // this file's: `air` drains 2 a turn from 97 and the status lands when it
    // runs out (see air.test.ts for the whole curve).
    for (let pump = 0; pump < 200 && !hasEffect(effects, 'p1', EffectId.Suffocating); pump += 1) {
      engine.hold('p1');
      engine.pump();
    }
    expect(hasEffect(effects, 'p1', EffectId.Suffocating), 'never went under').toBe(true);

    // OUT OF THE WATER, AND A WIND-UP ABOUT TO RUN OUT. Both removals now
    // happen inside the same pumps.
    body.x = 13;
    body.y = 4;
    setEffect(effects, body, EffectId.Elsewhere, 1, {}, world.rng);

    const carried: { id: string; effectId: string }[] = [];
    let sawSuffocatingLeave = false;
    for (let pump = 0; pump < 5; pump += 1) {
      engine.hold('p1');
      const result = engine.pump();
      carried.push(...(result.expired ?? []));
      for (const event of [...result.playerEvents, ...result.sweep]) {
        if (event.k === 'effect_expired' && event.effectId === EffectId.Suffocating) {
          sawSuffocatingLeave = true;
        }
      }
    }

    // THE NEGATIVE HALF IS NOT VACUOUS: Suffocating really did come off inside
    // one of those pumps, and really did reach the wire as `effect_expired`.
    expect(sawSuffocatingLeave, 'the body never stopped suffocating').toBe(true);
    expect(hasEffect(effects, 'p1', EffectId.Elsewhere), 'the wind-up never ran out').toBe(false);
    expect(carried).toEqual([{ id: 'p1', effectId: EffectId.Elsewhere }]);
  });

  it('reports anything else that takes it off as not expired', () => {
    const { state, body, notes } = counting();
    removeEffect(state, body, EffectId.Elsewhere, createRng('cancel'), {
      log: (line) => notes.push(line),
    });
    const lost = notes.filter((note) => note.kind === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.expired, 'a cancellation read as a finished countdown').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pulling it
// ---------------------------------------------------------------------------

describe('pulling it', () => {
  it('starts a countdown instead of teleporting, and does not spend the item', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);

    await pull(client);

    expect(client.errors(), 'the press was refused').toEqual([]);
    expect(realmOf(client).id, 'it teleported instead of winding up').toBe(delve.id);
    /**
     * NINETEEN, NOT TWENTY, AND THAT IS THE TURN IT COST. Pulling it spends the
     * turn (`spendLootTurn`, the rule every loot verb follows), the turn
     * resolves, and `actBase` ticks the status durations on the way through —
     * so the count a player first sees is one below the authored number.
     * Upstream is the same shape: `setEffect(EFF_RECALL, 40)` then `actBase`.
     */
    expect(effectDur(server.effects, client.actorId, EffectId.Elsewhere)).toBe(
      KNOT_WIND_UP_TURNS - 1,
    );

    const body = delve.world.getActor(client.actorId);
    // NOT CONSUMED. Upstream's rod is a rate limit, not a stock: `max_power`
    // 400 with a use costing 202 (quest-artifacts.lua:325-326).
    expect(body?.carried, 'the Knot was spent').toContain(KNOT_OF_ELSEWHERE_ID);
    // AND THE SAME TURN TICKED THE COOLDOWN, which is why this is one below the
    // authored thirty. It rides `actor.cooldowns` — upstream's own mechanism
    // for an object's cooldown (class/Object.lua:214-222).
    expect(body === undefined ? 0 : cooldownOf(body, KNOT_OF_ELSEWHERE_ID)).toBe(
      KNOT_COOLDOWN_TURNS - 1,
    );
    // quest-artifacts.lua:337 — *"Space around you starts to dissolve..."*
    expect(client.lines().some((line) => line.includes('starts to come undone'))).toBe(true);
  });

  it('counts down where the player can see it, and is still in the delve at nineteen', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    await pull(client);

    await stepAnywhere(client);

    // ONE FOR THE PULL, ONE FOR THE STEP. See the note on the case above.
    expect(effectDur(server.effects, client.actorId, EffectId.Elsewhere)).toBe(
      KNOT_WIND_UP_TURNS - 2,
    );
    expect(realmOf(client).id, 'it fired early').toBe(delve.id);

    // AND THE COUNT IS ON THE WIRE, on the badge the party panel draws. A
    // countdown the player cannot read is a twenty-turn silence.
    const badges = client.latest('effects')?.['actors'];
    const mine = Array.isArray(badges)
      ? (badges as Frame[]).find((row) => row['id'] === client.actorId)
      : undefined;
    const carried = Array.isArray(mine?.['effects']) ? (mine['effects'] as Frame[]) : [];
    const shown = carried.find((row) => row['id'] === EffectId.Elsewhere);
    expect(shown?.['turns'], 'the wind-up is not on the wire').toBe(KNOT_WIND_UP_TURNS - 2);
    expect(shown?.['harmful']).toBe(false);
  });

  /**
   * MOVEMENT DOES NOT CANCEL IT — upstream has no such clause, and a wind-up
   * you cannot walk during is one you can only use standing still, which is the
   * one thing nobody does in the fight this item exists for.
   */
  it('is not cancelled by walking', async () => {
    const client = await connect(server.port);
    await walkIn(client);
    handTheKnot(client);
    await pull(client);

    await stepAnywhere(client);
    await stepAnywhere(client);

    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finishing it
// ---------------------------------------------------------------------------

describe('when it finishes', () => {
  it('takes the body out to the cell it walked in from, with everything it carried', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    const before = delve.world.getActor(client.actorId);
    if (before === undefined || before.kind !== ActorKind.Player) throw new Error('no body');
    const level = before.level;
    const purse = before.money;
    await pull(client);

    // ONE `rest` IS TWENTY HOLDS. `RestView.recalling` (Player.lua:1066-1077)
    // is what makes that legal, and it is the clause without which this feature
    // is "press hold twenty times in a phase-locked co-op game".
    client.send({ t: 'rest' });
    await sleep(500);

    const home = realmOf(client);
    expect(home.id, 'it never came out').toBe(server.realms.overworld.id);
    const out = home.world.getActor(client.actorId);
    if (out === undefined || out.kind !== ActorKind.Player) throw new Error('no body came out');
    expect({ x: out.x, y: out.y }, 'not on the cell it walked in from').toEqual(doorTo(UNDERWORKS));
    expect(out.carried, 'the bag did not come out').toContain(KNOT_OF_ELSEWHERE_ID);
    expect(out.level).toBe(level);
    expect(out.money).toBe(purse);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    // other.lua:3347 — *"You are yanked out of this place!"*
    expect(client.lines().some((line) => line.includes('yanked out of'))).toBe(true);
    // AND THE WHOLE FRAME SET, which is the regression `crossOut` exists to
    // prevent: two of those calls carry essays about what broke when they were
    // missing. The map, the markers and the floor of the room they arrived in.
    expect(client.count('realm')).toBeGreaterThan(1);
    expect(client.latest('sites')).toBeDefined();
  });

  /**
   * ═══ FROM FLOOR THREE IT LANDS ON THE MOOR, NOT ON FLOOR TWO ═══
   * The regression this feature is most likely to introduce, because the
   * obvious implementation is "do what the threshold does" — and the threshold
   * on floor three goes UP ONE FLOOR. Upstream's `changeLevel(1,
   * last_wilderness)` (other.lua:3348) is the world map, unconditionally, and
   * `session.enteredFrom` survives going down precisely so this is one step.
   */
  it('comes out of a deep floor in one step', async () => {
    const client = await connect(server.port);
    const first = await walkIn(client);
    expect(floorsOfSite(UNDERWORKS), 'a one-floor delve cannot test this').toBeGreaterThan(2);

    let here = first;
    for (let floor = 1; floor < 3; floor += 1) {
      const stairs = stairsDownOf(here);
      if (stairs === null) throw new Error(`floor ${String(floor)} has no stair down`);
      const body = here.world.getActor(client.actorId);
      if (body === undefined) throw new Error('no body');
      const beside = STEPS.map((s) => ({ at: { x: stairs.x - s.dx, y: stairs.y - s.dy }, s })).find(
        ({ at }) =>
          canWalk(here.world.level, at.x, at.y) && here.world.actorAt(at.x, at.y) === undefined,
      );
      if (beside === undefined) throw new Error('the stair has no open ground beside it');
      body.x = beside.at.x;
      body.y = beside.at.y;
      client.send({ t: 'move', dir: beside.s.dir });
      await sleep(250);
      here = realmOf(client);
      expect(here.floor, 'the stair did not go down').toBe(floor + 1);
      clear(here);
    }

    handTheKnot(client);
    await pull(client);
    client.send({ t: 'rest' });
    await sleep(600);

    expect(realmOf(client).id, 'it came out onto floor two instead of the moor').toBe(
      server.realms.overworld.id,
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT STAYS OUT WHEN THE WIND-UP IS BURNT BY WALKING, NOT BY RESTING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * EVERY OTHER CASE IN THIS FILE BURNS THE WIND-UP WITH `rest`, and that is
   * the one path where this bug cannot happen. `handleRest` does not ask where
   * the body ended up; `handleMove` does, because a step can land on a door —
   * and `crossIntoSite` was its single call site.
   *
   * So the sequence nobody drove: the twentieth turn after the pull is a MOVE.
   * `pumpAndBroadcast` drains the wind-up inside that move, `yankOut` puts the
   * body on `session.enteredFrom` — which IS the site's door glyph, because
   * that is the tile it was standing on when it crossed in — and then the rest
   * of `handleMove` reads that tile as the tile this step reached and crosses
   * them straight back in.
   *
   * MEASURED before the guard, over a socket: pulled on Infinity Tower floor
   * 12, burnt with moves, landed in `realm:site:infinity_tower:1`. Reproduced
   * from Underworks floor 2, which is what this case drives — it is every
   * delve, not a Tower bug.
   *
   * MUTANT: delete `if (session.realmId !== startedIn) return;` from
   * `handleMove` and this case ends in the delve instead of on the moor. It is
   * the only case in the suite that does.
   *
   * AND THIS IS THE REALISTIC PATH. You cannot rest at depth with hostiles
   * standing (`handleRest` refuses above zero engagement), and you are running
   * when you pull the Knot.
   */
  it('stays out when the wind-up is burnt by walking rather than resting', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    await pull(client);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), 'never armed').toBe(true);

    // ONE STEP PER TURN, and one turn more than the wind-up, so the drain
    // happens ON a move. No `rest` anywhere in this case, deliberately.
    for (let turn = 0; turn <= KNOT_WIND_UP_TURNS + 2; turn += 1) {
      if (realmOf(client).id === server.realms.overworld.id) break;
      await stepAnywhere(client);
    }

    expect(
      realmOf(client).id,
      'the step that drained the wind-up crossed them back through the door they left by',
    ).toBe(server.realms.overworld.id);
    expect(realmOf(client).id, 'it never came out at all').not.toBe(delve.id);
    // AND ON THE DOOR CELL, as the resting path lands: the yank is unchanged,
    // only what `handleMove` does afterwards.
    const out = server.realms.overworld.world.getActor(client.actorId);
    expect(out === undefined ? null : { x: out.x, y: out.y }).toEqual(doorTo(UNDERWORKS));
  });
});

// ---------------------------------------------------------------------------
// Calling it off
// ---------------------------------------------------------------------------

describe('calling it off', () => {
  /**
   * PRESSED AGAIN IS CALLED OFF — quest-artifacts.lua:329-333, the FIRST clause
   * of the rod's `use`. Upstream still charges a use for the cancel; ours does
   * not, because upstream recharges in four turns and ours in thirty.
   */
  it('cancels on a second pull, does not teleport, and hands the cooldown back', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    await pull(client);
    const armed = delve.world.getActor(client.actorId);
    const cooldownWhenPulled = armed === undefined ? 0 : cooldownOf(armed, KNOT_OF_ELSEWHERE_ID);
    // One below the authored thirty: the pull cost a turn and the turn ticked it.
    expect(cooldownWhenPulled).toBe(KNOT_COOLDOWN_TURNS - 1);

    await pull(client);

    expect(client.errors(), 'the cancel was refused').toEqual([]);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    expect(realmOf(client).id, 'cancelling teleported them').toBe(delve.id);
    // other.lua:3352 — *"Space restabilizes around you."*
    expect(client.lines().some((line) => line.includes('lets the knot go slack'))).toBe(true);

    const after = delve.world.getActor(client.actorId);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE COOLDOWN COMES BACK, WHICH IS THE WHOLE POINT OF A CANCEL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This asserted only that it was LOWER than it had been — which a cooldown
     * that is merely ticking satisfies — and so it passed while two presses
     * cost a party their whole expedition's escape. Driven with the ten presses
     * from the bug report: press 1 armed it, press 2 cancelled, and presses 3
     * through 10 were answered *"the knot is still slack — 28 turns before it
     * will take hold"*. `pullTheKnot`'s own comment argued at length that ours
     * does NOT charge for a cancel, and the code charged anyway.
     *
     * EXACTLY ZERO, not "less than": absent is how `setCooldown` spells ready
     * (it deletes the entry at zero), and anything else is a number the refusal
     * would still quote.
     */
    expect(after === undefined ? -1 : cooldownOf(after, KNOT_OF_ELSEWHERE_ID)).toBe(0);
    expect(cooldownWhenPulled, 'the pull never armed one').toBeGreaterThan(0);

    // AND IT CAN BE PULLED AGAIN ON THE VERY NEXT TURN, which is what "handed
    // back" has to mean to a player standing in the room.
    await pull(client);
    expect(client.errors(), 'the re-pull was refused').toEqual([]);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(true);
    // Put it back the way the rest of the case expects to find it.
    await pull(client);

    // AND NOTHING FIRES LATER. Twenty turns of rest and the body is still here.
    client.send({ t: 'rest' });
    await sleep(500);
    expect(realmOf(client).id, 'a cancelled wind-up fired anyway').toBe(delve.id);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A CANCELLATION AND AN EXPIRY ARE DIFFERENT THINGS ON THE WIRE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `effect_expired` fires for both — it always has, and it is right to, because
   * for a bleed they ARE the same thing: the badge is gone. What was missing is
   * the distinction a READER needs, and `yankOut` is the first reader in this
   * codebase that acts differently on the two. Get it wrong and a second press
   * teleports the person who pressed it to call the recall off.
   *
   * WHAT THE WIRE CARRIES IS THE RECORD LANE AND THE FRAME SET, not a new event
   * variant: `shared/version.ts` records that a new `TurnEvent` independently
   * forces a protocol bump, and the two sentences plus the presence of a `realm`
   * frame say it without one.
   */
  it('reads differently on the wire from one that ran out', async () => {
    const cancelled = await connect(server.port);
    await walkIn(cancelled);
    handTheKnot(cancelled);
    await pull(cancelled);
    const realmFramesBefore = cancelled.count('realm');
    await pull(cancelled);

    const finished = await connect(server.port);
    await walkIn(finished);
    handTheKnot(finished);
    await pull(finished);
    finished.send({ t: 'rest' });
    await sleep(500);

    expect(cancelled.lines().some((line) => line.includes('lets the knot go slack'))).toBe(true);
    expect(cancelled.lines().some((line) => line.includes('yanked out of'))).toBe(false);
    expect(cancelled.count('realm'), 'a cancel moved somebody').toBe(realmFramesBefore);

    expect(finished.lines().some((line) => line.includes('yanked out of'))).toBe(true);
    expect(finished.lines().some((line) => line.includes('goes slack'))).toBe(false);
  });

  /**
   * A DOOR CANCELS IT — `cancel_on_level_change` (other.lua:3338), swept by
   * `Player:onEnterLevel` (Player.lua:173-181). It matters more here than
   * upstream: our effects are process-wide and keyed by actor id, so one that
   * survived a door would fire from wherever the body happened to be.
   */
  it('does not follow you through a door', async () => {
    const client = await connect(server.port);
    const first = await walkIn(client);
    handTheKnot(client);
    await pull(client);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), 'precondition').toBe(
      true,
    );

    const stairs = stairsDownOf(first);
    if (stairs === null) throw new Error('no stair down');
    const body = first.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    const beside = STEPS.map((s) => ({ at: { x: stairs.x - s.dx, y: stairs.y - s.dy }, s })).find(
      ({ at }) =>
        canWalk(first.world.level, at.x, at.y) && first.world.actorAt(at.x, at.y) === undefined,
    );
    if (beside === undefined) throw new Error('the stair has no open ground beside it');
    body.x = beside.at.x;
    body.y = beside.at.y;
    client.send({ t: 'move', dir: beside.s.dir });
    await sleep(250);

    expect(realmOf(client).floor, 'never went down').toBe(2);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    expect(client.lines().some((line) => line.includes('not where you pulled it'))).toBe(true);

    // AND NOTHING FIRES ON THE NEW FLOOR twenty turns later.
    clear(realmOf(client));
    const secondFloor = realmOf(client).id;
    client.send({ t: 'rest' });
    await sleep(500);
    expect(realmOf(client).id).toBe(secondFloor);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE OTHER DOOR — WALKING OUT UNDER YOUR OWN POWER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * There are exactly two crossings in this codebase and each cancels the
   * wind-up with its own call: `crossIntoRealm` (the stairs, above) and
   * `crossOut` (the way out, here). Only the first was driven, and a mutation
   * audit found it: deleting `cancelWindUpOnCrossing` from `crossOut` left all
   * twenty-four cases green, and deleting the fire-time realm check WITH it
   * still left them green. Both together is a player who pulls in a delve,
   * walks out by the door into a town, and is torn out of that town twenty
   * turns later.
   *
   * So this is one case that pins both legs, and the guard at the fire is
   * honestly labelled as belt-and-braces rather than left looking load-bearing.
   */
  it('does not follow you out of the door either', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    await pull(client);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), 'precondition').toBe(
      true,
    );

    // Step OFF the threshold and back ONTO it — `Session.exitArmed` is two
    // steps on purpose, so that a stray key cannot eject somebody on arrival.
    const door = delve.spawns[0];
    if (door === undefined) throw new Error('the delve has no threshold');
    const body = delve.world.getActor(client.actorId);
    if (body === undefined) throw new Error('no body');
    body.x = door.x;
    body.y = door.y;
    const off = STEPS.find(
      (step) =>
        canWalk(delve.world.level, door.x + step.dx, door.y + step.dy) &&
        delve.world.actorAt(door.x + step.dx, door.y + step.dy) === undefined,
    );
    if (off === undefined) throw new Error('nothing beside the threshold to step onto');
    const home = server.realms.overworld.id;
    client.send({ t: 'move', dir: off.dir });
    await sleep(120);
    const backIn = STEPS.find((step) => step.dx === -off.dx && step.dy === -off.dy);
    if (backIn === undefined) throw new Error('no way back onto the threshold');
    client.send({ t: 'move', dir: backIn.dir });
    await sleep(250);

    expect(realmOf(client).id, 'never walked out').toBe(home);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    expect(client.lines().some((line) => line.includes('not where you pulled it'))).toBe(true);

    // AND NOTHING FIRES OUT ON THE MOOR. The overworld is where the Knot lands
    // people, so a wind-up that survived the walk would be a no-op at best and
    // a body moved to a stale cell at worst.
    client.send({ t: 'rest' });
    await sleep(500);
    expect(realmOf(client).id).toBe(home);
  });
});

// ---------------------------------------------------------------------------
// Refusals — every one of them names something the player can do about it
// ---------------------------------------------------------------------------

describe('when it refuses', () => {
  it('refuses out in the open, and says there is nothing to be pulled out of', async () => {
    const client = await connect(server.port);
    const body = server.realms.overworld.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
    body.carried = [KNOT_OF_ELSEWHERE_ID];

    await pull(client);

    expect(client.errors().join(' ')).toContain('nothing here to be pulled out of');
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    // A REFUSED PULL COSTS NOTHING, exactly as a refused move does.
    expect(cooldownOf(body, KNOT_OF_ELSEWHERE_ID)).toBe(0);
  });

  /**
   * ═══ A PLACE THAT WILL NOT LET GO — `no_worldport` (Actor.lua:6918) ═══
   * Nothing in the shipped world sets it: the author ruled that the Knot DOES
   * work inside the Undermost, deliberately against upstream, which flags
   * reknor-escape `no_worldport` (zone.lua:31). So the instance is opened here
   * with the flag on, BEFORE the body walks in — `Realms.open` is idempotent on
   * (party, site, floor), so the door hands back this instance and the real
   * crossing path is what is driven.
   */
  it('refuses where nothing lets go, with the reason', async () => {
    const client = await connect(server.port);
    const partyId = partyIdOf(server.parties, client.actorId);
    const sealed = server.realms.open(
      { ...site(UNDERWORKS), noRecall: true },
      partyId,
      { level: 1, size: 1 },
      undefined,
      undefined,
      1,
    );
    expect(sealed.noRecall, 'the fixture did not take the flag').toBe(true);

    const delve = await walkIn(client);
    expect(delve.id, 'the door opened a different instance').toBe(sealed.id);
    handTheKnot(client);
    await pull(client);

    expect(client.errors().join(' ')).toContain('nothing here will let go of you');
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * THE ONE WAY TO MEET THIS REFUSAL IS TO HAVE ACTUALLY USED IT.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * THIS CASE USED TO REACH IT BY PULLING AND CANCELLING, which is exactly the
   * sequence that must NOT leave a cooldown behind — see the cancel case. So
   * the route is the real one: pull it, rest the twenty turns out, arrive on the
   * moor with the cooldown still running, and walk straight back into the delve.
   * A party that clears a room, leaves by the Knot and goes back in is the
   * likeliest way anybody meets this sentence at all.
   */
  it('refuses while it is still slack, and says how long', async () => {
    const client = await connect(server.port);
    await walkIn(client);
    handTheKnot(client);
    await pull(client);
    client.send({ t: 'rest' });
    await sleep(600);
    expect(realmOf(client).id, 'never came out').toBe(server.realms.overworld.id);

    const back = await walkIn(client);
    const body = back.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
    expect(cooldownOf(body, KNOT_OF_ELSEWHERE_ID), 'precondition').toBeGreaterThan(0);

    await pull(client);

    const said = client.errors().join(' ');
    expect(said).toContain('still slack');
    expect(said, 'a wait with no number is a rule nobody can plan around').toMatch(/\d+ turns?/);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND NOT STRAIGHT AFTER A KILL — `changeLevelCheck`, Game.lua:879-884.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The fifth refusal, and the only one with no case: a mutation audit
   * neutralised the whole arm and all twenty-four cases stayed green. It is also
   * the arm this port DIVERGES on — upstream re-checks `can_change_zone` when
   * the effect expires (other.lua:3346), so a kill on turn thirty-nine eats the
   * whole wind-up; ours asks at the pull, where the answer costs nothing.
   * An unpinned divergence is a divergence somebody deletes.
   *
   * `lastKillTurn` IS WHAT A KILL WRITES, and it is the only thing a kill writes
   * that this rule reads (`stairsShut` → `stairsLockedFor`). Setting it is the
   * same statement as felling something, without needing a body to fell on a
   * floor this file deliberately clears.
   */
  it('refuses too soon after a kill, and says how long to wait', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    const body = delve.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
    body.lastKillTurn = delve.world.turn.clock.gameTurn;

    await pull(client);

    const said = client.errors().join(' ');
    expect(said).toContain('not so soon after a kill');
    expect(said, 'a wait with no number is a rule nobody can plan around').toMatch(/\d+ turns?/);
    // AND NOTHING STARTED. A refused pull costs nothing — no effect, no
    // cooldown, no turn — exactly as a refused move does.
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere)).toBe(false);
    expect(cooldownOf(body, KNOT_OF_ELSEWHERE_ID)).toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AN `effect:elsewhere` NOBODY PULLED IS INERT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The gateway acts on a finished countdown only when it also holds the ledger
   * entry that says where the wind-up was STARTED — upstream's `eff.leveid`
   * (other.lua:3341), and the thing that decides where the body lands. An
   * effect applied by anything else (a console, a future talent, a monster with
   * a bad idea) has no such entry, and a crossing with no destination is worse
   * than no crossing: it is a body moved somewhere nobody chose.
   */
  it('ignores a countdown nobody started through the item', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);

    /**
     * BOTH WAYS THE WORLD RUNS, because there are two places that read a
     * finished countdown and each keeps its own copy of this guard: the ordinary
     * pump, and `handleRest` — which has to, because a rest swallows the pumps
     * it runs (`TurnEngine.rest`). Mutating one of them left the other's test
     * green, which is how half a rule ships.
     */
    for (const how of ['stepping', 'resting'] as const) {
      const body = delve.world.getActor(client.actorId);
      if (body === undefined) throw new Error('no body');
      setEffect(server.effects, body, EffectId.Elsewhere, 2, {}, delve.world.rng);
      expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), how).toBe(true);

      if (how === 'stepping') {
        await stepAnywhere(client);
        await stepAnywhere(client);
        await stepAnywhere(client);
      } else {
        client.send({ t: 'rest' });
        await sleep(400);
      }

      expect(
        hasEffect(server.effects, client.actorId, EffectId.Elsewhere),
        `${how}: it never ran out`,
      ).toBe(false);
      expect(realmOf(client).id, `${how}: an unowned countdown moved somebody`).toBe(delve.id);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONLY THE LEAD MAY PULL IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The author's co-op ruling, 2026-09-17: *"for coop, only the host's decisions
   * matter as its their playthrough."* It is the same rule
   * `handleDialogueChoose` applies to a `DialogueScope.Story` option, and taking
   * a party off a floor is story scope by any reading: it ends the expedition,
   * it moves five other people, and it is not reversible by the people it moves.
   *
   * A SOLO PLAYER LEADS THEMSELVES, so a one-client test cannot tell "the rule
   * is enforced" from "there is no rule". Both of these have a lead and a
   * non-lead, and the non-lead is the one being measured.
   */
  it('refuses a non-lead, and names who to ask', async () => {
    const lead = await connect(server.port);
    const other = await connect(server.port);
    lead.send({ t: 'party', action: 'invite', targetId: other.actorId });
    await sleep(150);
    other.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(200);
    expect(isLeader(server.parties, lead.actorId), 'the party never formed').toBe(true);
    expect(isLeader(server.parties, other.actorId)).toBe(false);

    const delve = await walkIn(lead);
    await walkIn(other);
    expect(realmOf(other).id, 'they went into different instances').toBe(delve.id);

    handTheKnot(other);
    await pull(other);

    expect(
      other.errors().some((line) => line.includes('can pull it for the party')),
      'a non-lead pulled it',
    ).toBe(true);
    expect(hasEffect(server.effects, other.actorId, EffectId.Elsewhere)).toBe(false);
    expect(
      other.lines().some((line) => line.includes('Only')),
      'they were not told who to ask',
    ).toBe(true);

    // AND THE LEAD MAY, on the same floor, with the same item.
    handTheKnot(lead);
    await pull(lead);
    expect(hasEffect(server.effects, lead.actorId, EffectId.Elsewhere)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parting with it — the refusal upstream hangs on the object itself
// ---------------------------------------------------------------------------

describe('you cannot bring yourself to part with it', () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * quest-artifacts.lua:357-362 — *"You cannot bring yourself to drop the %s"*.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * THIS IS THE RULE THE ONCE-PER-CHARACTER LATCH IS BUILT ON, and for one
   * commit it did not exist: `spillOrderOf`'s docblock defended the latch with
   * *"it is unsellable and undroppable"* while `Item.quest`'s said *"the
   * `on_drop` refusal has no port yet"*. Measured over a socket: `drop`
   * succeeded, the bag emptied, and because the ledger records being HANDED one
   * rather than HOLDING one, that character's next warden would have paid
   * nothing. One keypress, permanent.
   *
   * AND `give` IS THE SAME DOOR. Upstream has no analogue — every body you can
   * hand something to there is already yours — but here A can kill the first
   * warden, hand the Knot to B, and end the campaign with none while B's own
   * warden still pays B.
   */
  it('refuses to put it down, and keeps it in the bag', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    const body = delve.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');

    client.send({ t: 'drop', itemId: KNOT_OF_ELSEWHERE_ID });
    await sleep(200);

    expect(client.errors().join(' ')).toContain('cannot bring yourself to put down');
    expect(body.carried, 'the Knot left the bag').toContain(KNOT_OF_ELSEWHERE_ID);
    expect(delve.world.itemsAt(body.x, body.y).length, 'the Knot landed on the floor').toBe(0);
    expect(client.lines().some((line) => line.includes('puts down the Knot'))).toBe(false);
  });

  it('refuses to hand it to somebody else', async () => {
    const lead = await connect(server.port);
    const friend = await connect(server.port);
    lead.send({ t: 'party', action: 'invite', targetId: friend.actorId });
    await sleep(150);
    friend.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(200);
    const delve = await walkIn(lead);
    await walkIn(friend);
    expect(realmOf(friend).id, 'two instances, not one').toBe(delve.id);
    clear(delve);

    handTheKnot(lead);
    const mine = delve.world.getActor(lead.actorId);
    const theirs = delve.world.getActor(friend.actorId);
    if (mine === undefined || theirs === undefined) throw new Error('no bodies');
    // Stand them side by side, because `give` names a DIRECTION.
    const beside = STEPS.find(
      (step) =>
        canWalk(delve.world.level, mine.x + step.dx, mine.y + step.dy) &&
        delve.world.actorAt(mine.x + step.dx, mine.y + step.dy) === undefined,
    );
    if (beside === undefined) throw new Error('nowhere to stand the friend');
    theirs.x = mine.x + beside.dx;
    theirs.y = mine.y + beside.dy;

    lead.send({ t: 'give', itemId: KNOT_OF_ELSEWHERE_ID, dir: beside.dir });
    await sleep(200);

    expect(lead.errors().join(' ')).toContain('cannot bring yourself to hand over');
    expect(mine.carried, 'the Knot left the bag').toContain(KNOT_OF_ELSEWHERE_ID);
    expect(theirs.carried ?? [], 'the Knot was handed over').not.toContain(KNOT_OF_ELSEWHERE_ID);
  });

  /**
   * AND THE OTHER HALF, which is what keeps this from being a rule about one
   * item: an ORDINARY thing still goes down and still gets handed over. A guard
   * that refused everything would pass every assertion above.
   */
  it('still lets go of anything that is not the story`s', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    const body = delve.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');
    const ordinary = [...ITEMS].find((item) => item.quest !== true);
    if (ordinary === undefined) throw new Error('every item in the game is a quest item');
    body.carried = [ordinary.id];

    client.send({ t: 'drop', itemId: ordinary.id });
    await sleep(200);

    expect(client.errors()).toEqual([]);
    expect(body.carried).not.toContain(ordinary.id);
  });
});

// ---------------------------------------------------------------------------
// Resting through it — the clause that makes twenty turns playable
// ---------------------------------------------------------------------------

describe('resting through it', () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * BLEEDING WHILE IT COUNTS DOWN — THE SITUATION THE ITEM EXISTS FOR.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * `rest` is N pumps and the caller sees only the LAST result, so every exit
   * from that loop has to carry out the notes the pumps produced. One did not:
   * the `RestStop.Hurt` return sat ABOVE the line that collects them, so any
   * damage landing on the same pump the countdown reached zero dropped the
   * expiry on the floor. The badge vanished, the twenty turns were spent, the
   * thirty-turn cooldown was spent, and the party stayed exactly where it was —
   * and then the next press took the CANCEL branch, because the ledger still
   * held an entry for a countdown that had ended.
   *
   * IT IS NOT A CORNER. Any per-turn damage makes every rest end in `Hurt` after
   * one turn, so the turn the wind-up lands IS a Hurt turn: an unseen shooter's
   * bolt, a ground zone, a trap, a bleed. A party taking damage in a delve and
   * reaching for the way out is the whole design.
   *
   * A BLEED RATHER THAN A MONSTER, because `handleRest` refuses outright while
   * anything is engaged — so the only damage that can reach a resting body is
   * damage with nobody standing next to it, which is also the interesting case.
   */
  it('still carries the party out when the rester is being damaged', async () => {
    const client = await connect(server.port);
    const delve = await walkIn(client);
    handTheKnot(client);
    const body = delve.world.getActor(client.actorId);
    if (body === undefined || body.kind !== ActorKind.Player) throw new Error('no body');

    await pull(client);
    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), 'precondition').toBe(
      true,
    );

    // ENOUGH BLOOD TO OUTLAST THE COUNT. The case is about the expiry being
    // reported, not about surviving a wound, and a body that goes Downed
    // half-way through would be testing the Downed rules instead.
    body.maxHp = 5_000;
    body.hp = 5_000;
    const landed = setEffect(
      server.effects,
      body,
      EffectId.Bleeding,
      KNOT_WIND_UP_TURNS + 10,
      { power: 1 },
      delve.world.rng,
    );
    expect(landed.dur, 'the bleed never landed').toBeGreaterThan(0);

    // ONE TURN PER PRESS, because every one of them ends in `Hurt`. That is the
    // point: the player is pressing rest into a wound and the world is moving
    // one turn at a time, which is exactly how the countdown reaches zero on a
    // pump that also dealt damage.
    const home = server.realms.overworld.id;
    for (let i = 0; i < KNOT_WIND_UP_TURNS + 6; i += 1) {
      if (realmOf(client).id === home) break;
      client.send({ t: 'rest' });
      // 60ms, NOT LESS. `command-rate.test.ts` reads this file for the ceiling
      // the real limiter enforces — twenty commands a second — and a faster loop
      // loses presses silently, which is the `scripted-walks-desync` failure.
      await sleep(60);
    }
    await sleep(250);

    expect(hasEffect(server.effects, client.actorId, EffectId.Elsewhere), 'never ran out').toBe(
      false,
    );
    expect(realmOf(client).id, 'the countdown ran out and nothing happened').toBe(home);
    expect(client.lines().some((line) => line.includes('yanked out of'))).toBe(true);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * AND WITHOUT ANYBODY PRESSING ANYTHING AT ALL — THE TIDE'S OWN PUMP.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * There are three `pumpRealm` calls in the gateway and only two of them are
   * inside `pumpAndBroadcast`, which is where finished countdowns are drained.
   * The third is the TIDE's — the timer that advances a shared realm when
   * nobody is acting — and it had no drain, so a wind-up that ran out while the
   * party stood still in a settlement sat in the queue until somebody, anywhere
   * in the process, pressed a key.
   *
   * A SETTLEMENT IS THE WHOLE REACHABLE SURFACE of that bug: the tide arms only
   * for shared realms (Overworld and Common) and the Knot refuses the
   * overworld. So this is a party standing in Alderbrook with the Knot pulled
   * and their hands off the keyboard, which is also the most ordinary way
   * anybody would ever test the item.
   *
   * ITS OWN SERVER, with a fast tide. The shared harness runs at the production
   * interval, and twenty game turns of it is not a test anybody would wait for.
   */
  it('finishes on the tide alone, with nobody pressing a key', async () => {
    const downed = createDownedState();
    const parties = createPartyState();
    const effects = createMvpEffectState();
    const realms = createRealms({
      seed: 'elsewhere-tide',
      effects,
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
      tideMs: 20,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port was bound');

    try {
      const client = await connect(address.port);
      // INTO A SETTLEMENT, the one place that is both shared (so the tide runs)
      // and not the open moor (so the Knot does not refuse).
      const door = [...realms.overworld.sites].find(([, id]) => id === 'site:alderbrook');
      if (door === undefined) throw new Error('no door to Alderbrook');
      const [xs, ys] = door[0].split(',');
      const body = realms.overworld.world.getActor(client.actorId);
      if (body === undefined) throw new Error('no body on the overworld');
      body.x = Number(xs) - 1;
      body.y = Number(ys);
      client.send({ t: 'move', dir: 'e' });
      /**
       * POLLED, NOT SLEPT, AT ALL THREE STEPS. This case runs its own server
       * with a fast tide, and it is the only one in the file whose subject is a
       * TIMER — so it is the one that goes flaky first when three hundred other
       * test files are competing for the same event loop. A fixed `sleep` here
       * failed once in a full-suite run and never once alone, which is the
       * signature of contention rather than of a rule.
       */
      const until = async (what: string, ready: () => boolean): Promise<void> => {
        const stop = Date.now() + 15_000;
        while (Date.now() < stop) {
          if (ready()) return;
          await sleep(25);
        }
        throw new Error(`${what} (${client.errors().join('; ') || 'no error'})`);
      };
      await until('never got into town', () => {
        const at = realms.realmOf(client.actorId);
        return at !== undefined && at.id !== realms.overworld.id;
      });
      const town = realms.realmOf(client.actorId);
      if (town === undefined) throw new Error('no realm');

      const inside = town.world.getActor(client.actorId);
      if (inside === undefined || inside.kind !== ActorKind.Player) throw new Error('no body');
      inside.carried = [...(inside.carried ?? []), KNOT_OF_ELSEWHERE_ID];
      client.send({ t: 'use', itemId: KNOT_OF_ELSEWHERE_ID });
      await until('the wind-up never started', () =>
        hasEffect(effects, client.actorId, EffectId.Elsewhere),
      );
      expect(hasEffect(effects, client.actorId, EffectId.Elsewhere), 'never started').toBe(true);

      // HANDS OFF. Everything from here is the timer's.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (realms.realmOf(client.actorId)?.id === realms.overworld.id) break;
        await sleep(25);
      }

      expect(
        realms.realmOf(client.actorId)?.id,
        'the countdown ran out on a tide tick and nothing drained it',
      ).toBe(realms.overworld.id);
      // AND THE LINE, which is a FRAME and therefore arrives a moment after the
      // body does: the loop above breaks on the server's own state.
      await until('the party was moved without being told', () =>
        client.lines().some((line) => line.includes('yanked out of')),
      );
      expect(client.lines().some((line) => line.includes('yanked out of'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  /**
   * THE CONTROL, and the clause this file could not do without: an undisturbed
   * rest sits through the whole wind-up in ONE press (`wait_recall`,
   * Player.lua:1066-1077) and stops the turn it finishes rather than resting on
   * into the next forty.
   */
  it('sits through the whole wind-up in one press when nothing interrupts', async () => {
    const client = await connect(server.port);
    await walkIn(client);
    handTheKnot(client);
    await pull(client);

    client.send({ t: 'rest' });
    await sleep(600);

    expect(realmOf(client).id).toBe(server.realms.overworld.id);
  });
});

// ---------------------------------------------------------------------------
// The party rule
// ---------------------------------------------------------------------------

describe('who comes out with it', () => {
  /** Lead and a friend, partied, standing in the same instance of the Underworks. */
  async function twoInADelve(): Promise<{ lead: Client; friend: Client; delve: Realm }> {
    const lead = await connect(server.port);
    const friend = await connect(server.port);
    lead.send({ t: 'party', action: 'invite', targetId: friend.actorId });
    await sleep(150);
    friend.send({ t: 'party', action: 'accept', targetId: lead.actorId });
    await sleep(200);
    expect(isLeader(server.parties, lead.actorId), 'the party never formed').toBe(true);

    const delve = await walkIn(lead);
    await walkIn(friend);
    expect(realmOf(friend).id, 'two instances, not one').toBe(delve.id);
    clear(delve);
    return { lead, friend, delve };
  }

  it('takes the whole party standing in the room', async () => {
    const { lead, friend, delve } = await twoInADelve();
    handTheKnot(lead);
    await pull(lead);
    lead.send({ t: 'rest' });
    await sleep(700);

    expect(realmOf(lead).id, 'the puller stayed').toBe(server.realms.overworld.id);
    expect(realmOf(friend).id, 'a friend was left in the delve').toBe(server.realms.overworld.id);
    expect(delve.world.getActor(friend.actorId), 'a body was left behind').toBeUndefined();
    // AND THEY WERE TOLD, in their own log, on the way out.
    expect(friend.lines().some((line) => line.includes('yanked out of'))).toBe(true);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * AND THEY ARRIVE TOGETHER — NOT ONE AT THE DOOR AND THE REST AT THE GATE.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * `yankOut` hands every member the puller's single `back` cell, and `crossOut`
   * used to take it only while it was FREE — so the first body seated there and
   * everybody after them fell through to wherever `placeAtSpawn` had put them,
   * which on the overworld is the fixed start spawn. Measured before the fix: the
   * lead on the door cell at (94,44) and the friend at (104,62), eighteen tiles
   * apart against a `DEFAULT_SIGHT_RADIUS` of ten. They arrived unable to see
   * each other, out of an item whose card promises to take the party out to the
   * moor they came in from.
   *
   * CHEBYSHEV, because that is the metric this game walks in (eight ways, corners
   * cut). Two steps is the tightest a search that does not shove anybody can
   * promise for a party of two.
   */
  it('puts the party down together, at the door they came in by', async () => {
    const { lead, friend } = await twoInADelve();
    handTheKnot(lead);
    await pull(lead);
    lead.send({ t: 'rest' });
    await sleep(700);

    const out = server.realms.overworld.world;
    const a = out.getActor(lead.actorId);
    const b = out.getActor(friend.actorId);
    expect(a, 'the lead never came out').toBeDefined();
    expect(b, 'the friend never came out').toBeDefined();
    if (a === undefined || b === undefined) throw new Error('nobody arrived');

    const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    expect(apart, 'the party was scattered across the moor').toBeLessThanOrEqual(2);
    // AND IT IS THE DOOR, not merely "near each other somewhere". The whole
    // promise is the cell they walked in from.
    const door = doorTo(UNDERWORKS);
    expect(Math.max(Math.abs(a.x - door.x), Math.abs(a.y - door.y))).toBeLessThanOrEqual(2);
    expect(Math.max(Math.abs(b.x - door.x), Math.abs(b.y - door.y))).toBeLessThanOrEqual(2);
  });

  /**
   * ═══ CALLING YOUR OWN OFF IS NOT LEAD-ONLY, AND NOW SOMETHING SAYS SO ═══
   *
   * `pullTheKnot` puts the cancel clause ABOVE the party-lead refusal and argues
   * the ordering at length: the lead badge MOVES, and a player who started a
   * wind-up and then stopped being lead would be holding a countdown they could
   * not call off. A mutation audit moved the refusal above the cancel and all
   * twenty-four cases stayed green — the rule was written down twice in prose
   * and driven nowhere.
   *
   * THE ROUTE INTO THE STATE IS THE REAL ONE: `isPartyLead` is true for anybody
   * in a party of one, so the only way to be a non-lead holding a wind-up is to
   * start one alone and then JOIN somebody — which is exactly what a player does
   * when a friend comes online mid-delve.
   */
  it('lets a member who is no longer the lead call off their own wind-up', async () => {
    const { lead, friend, delve } = await twoInADelve();
    handTheKnot(lead);
    await pull(lead);
    expect(hasEffect(server.effects, lead.actorId, EffectId.Elsewhere), 'precondition').toBe(true);

    // THE BADGE MOVES: the friend walks out of the party and invites the puller
    // into theirs, which is the shape this happens in when somebody reshuffles
    // a group mid-delve. No realm is crossed, so the wind-up is untouched.
    friend.send({ t: 'party', action: 'leave' });
    await sleep(150);
    friend.send({ t: 'party', action: 'invite', targetId: lead.actorId });
    await sleep(150);
    lead.send({ t: 'party', action: 'accept', targetId: friend.actorId });
    await sleep(250);
    expect(isLeader(server.parties, lead.actorId), 'the puller is still the lead').toBe(false);
    expect(hasEffect(server.effects, lead.actorId, EffectId.Elsewhere), 'the shuffle ate it').toBe(
      true,
    );

    const before = lead.errors().length;
    await pull(lead);

    expect(lead.errors().slice(before), 'a non-lead was refused their own cancel').toEqual([]);
    expect(hasEffect(server.effects, lead.actorId, EffectId.Elsewhere)).toBe(false);
    expect(lead.lines().some((line) => line.includes('lets the knot go slack'))).toBe(true);
    expect(realmOf(lead).id, 'the cancel moved somebody').toBe(delve.id);

    // AND STARTING ONE IS STILL THE LEAD'S ALONE — the other half of the rule,
    // in the same body, one press later.
    await pull(lead);
    expect(lead.errors().join(' ')).toContain('can pull it for the party');
    expect(hasEffect(server.effects, lead.actorId, EffectId.Elsewhere)).toBe(false);
  });

  /**
   * ═══ A DOWNED FRIEND COMES OUT, AND COMES OUT STILL DOWN ═══
   * Losing somebody for being unconscious is the outcome the Downed system
   * exists to prevent. Arriving on their FEET would be the opposite mistake:
   * `addPlayer` builds a fresh, standing body, so without `carryAcross` keeping
   * `alive === false` the way to beat the five-turn countdown would be to pull
   * the Knot.
   */
  it('takes a downed friend, and does not stand them up on the way', async () => {
    const { lead, friend, delve } = await twoInADelve();
    const body = delve.world.getActor(friend.actorId);
    if (body === undefined) throw new Error('no friend in the delve');
    // PUT DOWN THE WAY THE SURVIVAL SYSTEM PUTS BODIES DOWN, so the sprite, the
    // countdown and `alive` all say the same thing. The table is process-wide
    // on purpose (world/realms.ts: *"a five-turn countdown must follow a body
    // across a boundary"*), which is the half this case is really about.
    goDown(server.downed, body, delve.world.turn.clock.gameTurn);
    expect(isDowned(server.downed, friend.actorId), 'the fixture did not put them down').toBe(true);

    handTheKnot(lead);
    await pull(lead);
    lead.send({ t: 'rest' });
    await sleep(700);

    const out = server.realms.overworld.world.getActor(friend.actorId);
    expect(out, 'the downed friend was left on the floor').toBeDefined();
    // AND THE COUNTDOWN CAME WITH THEM, because the survival table is
    // process-wide for exactly this. Downed or Erased — the five turns may have
    // run out during the wind-up — but never back on their feet.
    expect(survivalOf(server.downed, friend.actorId)).not.toBe('up');
    expect(out?.alive, 'the crossing stood them up — a free revive').toBe(false);
    expect(out?.hp).toBe(0);
  });

  it('leaves behind a member who is on another floor', async () => {
    const { lead, friend, delve } = await twoInADelve();
    const stairs = stairsDownOf(delve);
    if (stairs === null) throw new Error('no stair down');
    const body = delve.world.getActor(friend.actorId);
    if (body === undefined) throw new Error('no body');
    const beside = STEPS.map((s) => ({ at: { x: stairs.x - s.dx, y: stairs.y - s.dy }, s })).find(
      ({ at }) =>
        canWalk(delve.world.level, at.x, at.y) && delve.world.actorAt(at.x, at.y) === undefined,
    );
    if (beside === undefined) throw new Error('the stair has no open ground beside it');
    body.x = beside.at.x;
    body.y = beside.at.y;
    friend.send({ t: 'move', dir: beside.s.dir });
    await sleep(250);
    const below = realmOf(friend);
    expect(below.floor, 'the friend never went down').toBe(2);
    clear(below);

    handTheKnot(lead);
    await pull(lead);
    lead.send({ t: 'rest' });
    await sleep(700);

    expect(realmOf(lead).id).toBe(server.realms.overworld.id);
    expect(realmOf(friend).id, 'the Knot reached through a floor').toBe(below.id);
  });

  /**
   * ═══ A MEMBER WHO LEFT MID-WIND-UP STAYS PUT ═══
   * Every frame a crossing sends is addressed to a socket, and `crossOut` ends
   * with `setConnected(actorId, true)` — putting a body nobody is driving into
   * the destination's quorum, where the barrier waits on a decision that cannot
   * come. So the body stays where it is, exactly as it does today when a party
   * walks out by the stairs, and the disconnect grace still owns it.
   */
  it('leaves behind a member whose socket died during the countdown', async () => {
    const { lead, friend, delve } = await twoInADelve();
    handTheKnot(lead);
    await pull(lead);

    friend.close();
    await sleep(250);

    lead.send({ t: 'rest' });
    await sleep(700);

    expect(realmOf(lead).id).toBe(server.realms.overworld.id);
    expect(
      delve.world.getActor(friend.actorId),
      'a body nobody was driving was moved',
    ).toBeDefined();
  });
});
