import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { wsGateway } from '../../src/server/net/gateway.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { Realms } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUND TRIP. ALDERBROOK → THE REDACTION → ALDERBROOK, OVER A SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `two-overworlds.test.ts` proved a second overworld was POSSIBLE using a
 * synthetic site, and its last test ends by saying the round trip itself
 * *"needs a door on the Alderbrook rows"*. There is one now, at (22,60), so
 * this is that test: the real registry, the real map, the real glyph, and a
 * real body walking through it and back.
 *
 * ═══ WHY THIS IS THE FILE THAT MATTERS OUT OF THE THREE ═══
 * The shared tests prove the map is sound and the registry probe proves the
 * sites resolve. Neither would have caught the fifth blocker, which was a
 * one-line refusal in `leaveRealm` that no map-shaped assertion can see: the
 * player crosses fine, and then the door does not open from the far side, and
 * there is no verb in the protocol that brings them home. A character that can
 * never leave. The only thing that finds that is going there and coming back.
 *
 * THE POSITION IS SET DIRECTLY AND THE STEP IS A REAL INTENT, which is the same
 * shortcut `two-overworlds.test.ts` takes and for the same reason: the door is
 * 99 tiles from the spawn and walking it over a socket would be a minute of
 * wall-clock for nothing. The CROSSING is not shortcut — it is a `move` frame
 * through `dispatch`, resolved by the scheduler, exactly as a player's is.
 */

const FRAME_TIMEOUT_MS = 4_000;

type Harness = { port: number; realms: Realms; close: () => Promise<void> };
let server: Harness;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const downed = createDownedState();
  const parties = createPartyState();
  // THE REAL `SITES`, deliberately: every other socket suite here supplies its
  // own table, and a door wired only into a fixture is a door nobody can use.
  const realms = createRealms({
    seed: 'redaction-crossing',
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

async function hello(
  port: number,
): Promise<{ actorId: string; frames: Record<string, unknown>[]; socket: WebSocket }> {
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
    const id = frames.find((f) => f['t'] === 'welcome')?.['selfId'];
    if (typeof id === 'string') return { actorId: id, frames, socket };
    if (Date.now() >= deadline) throw new Error('no welcome came back');
    await sleep(5);
  }
}

/** The most recent frame of a type, which is the one the player is looking at. */
function latest(
  frames: Record<string, unknown>[],
  type: string,
): Record<string, unknown> | undefined {
  return [...frames].reverse().find((f) => f['t'] === type);
}

/** Where the door is, read off the map rather than written down twice. */
function doorCell(realms: Realms): { x: number; y: number } {
  const found = [...realms.overworld.sites].find(([, id]) => id === REDACTION_SITE_ID);
  if (found === undefined) throw new Error('no door to the Redaction on the Alderbrook rows');
  const [xs, ys] = found[0].split(',');
  return { x: Number(xs), y: Number(ys) };
}

/**
 * Put the body one step west of `cell` and step east onto it.
 *
 * The step is a real `move` intent so the crossing runs the handler a player's
 * keypress runs. The placement is not — see the header.
 */
async function stepOnto(
  realms: Realms,
  actorId: string,
  socket: WebSocket,
  cell: { x: number; y: number },
): Promise<void> {
  const realm = realms.realmOf(actorId);
  const body = realm?.world.getActor(actorId);
  if (body === undefined) throw new Error('no body to move');
  body.x = cell.x - 1;
  body.y = cell.y;
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
  await sleep(200);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALK OFF THE DOORSTEP AND BACK ONTO IT, WHICH IS WHAT LEAVING ACTUALLY IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Session.exitArmed`: you arrive STANDING ON the threshold, so "standing on
 * the threshold means leave" would bounce every player straight back out of
 * every door they walked through. The rule is that you have to step off it
 * first, and the flag is set inside `leaveRealm` by a move that lands anywhere
 * else — which means the arming CANNOT be faked by assigning coordinates.
 *
 * The first version of this helper did exactly that and reported the round trip
 * as broken. It was not: it was a test that had skipped a step a player cannot
 * skip. Both moves here are real intents for that reason.
 */
async function stepOffAndBack(
  realms: Realms,
  actorId: string,
  socket: WebSocket,
  cell: { x: number; y: number },
): Promise<void> {
  const body = realms.realmOf(actorId)?.world.getActor(actorId);
  if (body === undefined) throw new Error('no body to move');
  body.x = cell.x;
  body.y = cell.y;
  // OFF — this is the move that arms the exit.
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'w' }));
  await sleep(200);
  // AND BACK ON.
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'move', dir: 'e' }));
  await sleep(250);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A DOOR CHANGES WHERE YOU ARE STANDING AND NOTHING ELSE ABOUT YOU.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED over the real socket, and it was not true: a Watchman on the moor has
 * Strength 25 — 24 authored plus one from a passive — and walking him through a
 * door gave him 24. **Every passive talent in the game stopped working the
 * moment a player entered a dungeon**, which is the place they matter most.
 *
 * A crossing builds a NEW body in the new world and copies a hand-written list
 * of fields onto it, then recomposes. `passiveCombat` was not on the list, so
 * the recompose found nothing to fold. Nothing put it back either —
 * `refreshPassives` is called from `attachClass` and `raiseTalentPoint` only, so
 * the contribution returned when a player happened to spend a talent point and
 * never for one who had spent them all.
 *
 * ═══ THE ASSERTION IS THE WHOLE SHEET, NOT THE FIELD THAT BROKE ═══
 * This is the sixth time this codebase has been bitten by one rule written as a
 * hand-written list. Pinning `passiveCombat` would catch the bug that happened;
 * comparing the COMPOSED sheet catches the next field somebody forgets, which is
 * the one that has not happened yet.
 */
describe('what follows a character through a door', () => {
  it('leaves every derived number exactly where it was', async () => {
    const { actorId, socket } = await hello(server.port);

    const before = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(before, 'no body on the near side').toBeDefined();
    if (before === undefined) return;

    /**
     * THE PASSIVE LAYER IS PUT ON BY HAND, and that is the honest shape of the
     * claim. `refreshPassives` lives in `src/server/main.ts` — the one file that
     * can see the talent registry, the world and the gateway at once — and this
     * harness builds its own gateway without it, so a body here has no passives
     * to lose. The rule under test is not "this harness grants passives"; it is
     * "whatever layers a body has, a door does not take them away".
     *
     * A body with no layer at all would pass this by having nothing to lose,
     * which is the vacuous green that let the real bug live for six milestones.
     */
    before.passiveCombat = { stats: { str: 1 } };
    recomposeCombat(before, null, resolveItem);
    const sheetBefore = structuredClone(before.combat);
    expect(sheetBefore?.stats?.str, 'the passive never reached the sheet').toBeDefined();

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const after = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(after, 'no body on the far side').toBeDefined();
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the fix: `stats.str` came back one lower, and with it accuracy,
    // damage, armour, defence and both saves.
    expect(after?.combat).toEqual(sheetBefore);
  });

  it('carries the attribute points a player has spent', async () => {
    /**
     * THE SAME LIST, AND THIS FIELD WOULD HAVE INHERITED THE SAME BUG the day it
     * shipped — a delta the recompose cannot see is a delta that is not there,
     * and the symptom would be a character losing spent points at a door.
     */
    const { actorId, socket } = await hello(server.port);
    const body = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined || body.kind !== 'player') return;

    body.spentStats = { str: 4 };
    body.unspentStatPoints = 2;

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const after = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(after?.spentStats, 'spent attribute points did not follow').toEqual({ str: 4 });
    expect(after?.kind === 'player' ? after.unspentStatPoints : null).toBe(2);
  });

  it('carries the hit-point ceiling, and does not file the body down to it', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * THE SEVENTH TIME THE HAND-WRITTEN LIST BIT, AND THE FIRST THAT COST BLOOD.
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * The test directly above this one is called *"leaves every derived number
     * exactly where it was"* and it PASSES against this bug, because it compares
     * `after.combat` — and `maxHp` is not a field of the combat sheet. The sheet
     * survived the door; the hit points did not.
     *
     * `carryAcross` clamps `to.hp` against `to.maxHp` on its first line, and
     * `to` is a body `world.addPlayer` has just built from `overlayFor`, whose
     * `maxHp` is the class's AUTHORED CONSTANT. `to.level = from.level` is five
     * lines further down, and nothing on the path re-derives the ceiling. So the
     * clamp ran against a level-1 number.
     *
     * A level-30 Watchman crossed at 768/768 and arrived at 72. The ceiling
     * repairs itself on the next base turn — `refreshPassives` runs once per
     * turn — but that clamp is DOWNWARD ONLY by deliberate design, so the blood
     * never comes back. Both directions, every doorway.
     *
     * ═══ WHY NO TEST COULD SEE IT UNTIL NOW ═══
     * `maxHp` was an authored constant until `maxLifeFor` landed. While it was,
     * `to.maxHp` and `from.maxHp` really were the same number and the clamp
     * really did cost nothing — which is exactly what `carryAcross`'s comment
     * still claimed. A level-1 fixture reproduces that vanished world perfectly
     * and passes. THE LEVEL IS THE WHOLE FIXTURE, so it is set explicitly here.
     */
    const { actorId, socket } = await hello(server.port);
    const before = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(before, 'no body on the near side').toBeDefined();
    if (before === undefined || before.kind !== 'player') return;

    // A BODY THAT HAS EARNED SOMETHING. The ceiling is set by hand because this
    // harness builds its own gateway with no `refreshBody` seam — the same
    // honesty the passive test above states about `refreshPassives`. The rule
    // under test is not "this harness derives a ceiling"; it is "whatever
    // ceiling a body has, a door does not replace it with the class's".
    before.level = 10;
    before.maxHp = 252;
    before.hp = 252;

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const after = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(after, 'no body on the far side').toBeDefined();
    // ═══ THE TWO ASSERTIONS THAT WERE FAILING ═══
    // Before the fix: maxHp came back as the fresh body's authored default and
    // hp had been clamped to it.
    expect(after?.maxHp, 'the ceiling was rebuilt from the class table').toBe(252);
    expect(after?.hp, 'a door took the hit points off a levelled body').toBe(252);
  });

  it('still clamps a body whose blood exceeds the ceiling it carries', async () => {
    /**
     * The clamp is not deleted, only moved onto the right number. A save that
     * arrives at 90/72 is corrupt input and must land at 72 — `main.ts` says a
     * pool reading above its own ceiling is *"a number no other part of this
     * game can be shown"*.
     */
    const { actorId, socket } = await hello(server.port);
    const before = server.realms.realmOf(actorId)?.world.getActor(actorId);
    if (before === undefined || before.kind !== 'player') return;

    before.level = 3;
    before.maxHp = 100;
    before.hp = 400;

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const after = server.realms.realmOf(actorId)?.world.getActor(actorId);
    expect(after?.maxHp).toBe(100);
    expect(after?.hp).toBe(100);
  });
});

describe('walking into the dark territory', () => {
  it('crosses onto a second overworld that names itself', async () => {
    const { actorId, frames, socket } = await hello(server.port);
    expect(server.realms.realmOf(actorId)?.id).toBe(server.realms.overworld.id);

    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const now = server.realms.realmOf(actorId);
    expect(now?.id, 'the door did not open').toBe(`realm:${REDACTION_SITE_ID}`);
    // AND IT IS AN OVERWORLD, which is not cosmetic: six subsystems read this
    // field, including the roamer tick and the way home. See `SiteDef.kind`.
    expect(now?.kind).toBe(RealmKind.Overworld);

    // THE PLAYER IS TOLD. The two maps look alike on purpose, so the name in the
    // frame is most of what distinguishes them on screen.
    const realm = latest(frames, 'realm');
    expect(realm?.['name']).toBe('The Redaction');
    expect(realm?.['kind']).toBe(RealmKind.Overworld);
  });

  it('draws the way home, and it opens', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FIFTH BLOCKER, DRIVEN RATHER THAN ARGUED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `leaveRealm` began `if (from.kind === RealmKind.Overworld) return false;`
     * and `markersFor` drew no exit on an overworld for the same reason. Both
     * were true of the one map that existed when they were written. Either one
     * alone strands the player: without the marker they cannot find the tile,
     * and without the rule the tile does nothing.
     *
     * So this asserts BOTH HALVES on the far side — the marker is drawn, and
     * standing on it works — because a test that only checked the second would
     * pass against a build where the way home is invisible.
     */
    const { actorId, frames, socket } = await hello(server.port);
    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));

    const there = server.realms.realmOf(actorId);
    expect(there?.id).toBe(`realm:${REDACTION_SITE_ID}`);
    const arrival = there?.spawns[0];
    if (arrival === undefined) throw new Error('the Redaction has no arrival tile');

    // ── the marker is on the map ───────────────────────────────────────────
    const sites = latest(frames, 'realm')?.['sites'];
    expect(Array.isArray(sites)).toBe(true);
    const wayOut = (sites as Record<string, unknown>[]).find(
      (s) => s['x'] === arrival.x && s['y'] === arrival.y,
    );
    expect(wayOut, 'no way out drawn on the far map').toBeDefined();
    expect(wayOut?.['name']).toBe('The way out');

    // ── and standing on it works ───────────────────────────────────────────
    await stepOffAndBack(server.realms, actorId, socket, arrival);
    expect(server.realms.realmOf(actorId)?.id, 'stranded on the far map').toBe(
      server.realms.overworld.id,
    );
  });

  it('puts them back on the Alderbrook side of the door they used', async () => {
    // NOT AT THE SPAWN. Being teleported to the city after a crossing would
    // undo the ninety-nine tiles the player walked to get here, which is the
    // difference between a door and a fast-travel node.
    const { actorId, socket } = await hello(server.port);
    const door = doorCell(server.realms);
    await stepOnto(server.realms, actorId, socket, door);
    const arrival = server.realms.realmOf(actorId)?.spawns[0];
    if (arrival === undefined) throw new Error('no arrival tile');
    await stepOffAndBack(server.realms, actorId, socket, arrival);

    const home = server.realms.realmOf(actorId);
    expect(home?.id).toBe(server.realms.overworld.id);
    const body = home?.world.getActor(actorId);
    expect(body).toBeDefined();
    if (body === undefined) return;
    expect(Math.max(Math.abs(body.x - door.x), Math.abs(body.y - door.y))).toBeLessThanOrEqual(2);
  });

  it('is a place with somewhere to go, not seven thousand empty cells', async () => {
    /**
     * The map being crossable is `test/shared/redaction.test.ts`'s job. This is
     * the other half of it: that the doors on it RESOLVE — every marker the far
     * map draws has a `SiteDef` behind it, and opening one produces a floor
     * with things on it. A marker with no definition is drawn and then does
     * nothing when you stand on it, which is the failure mode this repo has
     * shipped more times than any other.
     */
    const { actorId, socket } = await hello(server.port);
    await stepOnto(server.realms, actorId, socket, doorCell(server.realms));
    const there = server.realms.realmOf(actorId);
    if (there === undefined) throw new Error('never crossed');

    expect(there.sites.size).toBeGreaterThan(3);
    for (const [, siteId] of there.sites) {
      const def = SITES.get(siteId);
      expect(def, `${siteId} is drawn on the map and has no definition`).toBeDefined();
      // NOTHING OVER THERE IS A TOWN. See `REDACTED_TOWN` — a shared realm on
      // that map would have no shop, no townsfolk and no monsters, which is an
      // empty street grid rather than an eerie one.
      expect(def?.kind).toBe(RealmKind.Inner);
    }
  });
});
