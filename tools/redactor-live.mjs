/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE REDACTOR ACTUALLY WORK? ASK A REAL SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fourth class shipped with 12 talents, two trees, a resource, a portrait
 * row and 3536 passing tests. Nobody has ever played one.
 *
 * ═══ WHY A UNIT TEST CANNOT CLOSE THIS ═══
 * `tools/status-live.mjs`'s header states the rule this file inherits: the
 * status system shipped connected to nothing for a whole milestone with 115
 * test references, every one reaching into the module directly, none through
 * `main.ts`. "A test that imports the module under test is exactly the thing
 * that missed it."
 *
 * The Redactor is the same shape of risk, one class along, and it stacks three
 * newly-wired seams on top of each other:
 *
 *   1. the class must be OFFERED and CHOOSABLE — `class_options` is built from
 *      `CLASSES`, and the rotation, the portrait table and the sprite family
 *      all key off an id that did not exist a day ago.
 *   2. `Strike Out` must reach `ctx.status` and land `EFFACED` — an effect that
 *      until `MVP_EFFECTS` was fixed was registered from a three-element
 *      literal and could not be applied by anything at all.
 *   3. the landing must PAY — `creditForLanding` -> `noteAfflicted` ->
 *      `gainResource`. That path existed for months with no class that could
 *      take it, which is the whole reason this class was worth building.
 *
 * Every one of those is green in the suite. None of them had crossed a socket.
 *
 * ═══ WHAT IT PRINTS ═══
 * The Ink before and after, the log line the server chose, and a verdict that
 * distinguishes "the mark was resisted" from "nothing resolved" from "it landed
 * and paid nothing" — because only the last two are faults, and a probe that
 * reports a save as a failure is the bug `status-live.mjs` had.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { WebSocket } from 'ws';

import { PROTOCOL_VERSION } from '../src/shared/version.ts';
import { canWalk } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';
import { helloAndChoose } from './handshake.mjs';

const PORT = process.argv[2] ?? '31979';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TURN_WAIT_MS = 45;

// ---------------------------------------------------------------------------
// Boot — a port of its own, so a live game on the host is never disturbed.
// ---------------------------------------------------------------------------

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverErr = [];
server.stderr.on('data', (b) => serverErr.push(b.toString()));
process.on('exit', () => server.kill());

let up = false;
for (let i = 0; i < 80 && !up; i += 1) {
  await sleep(250);
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
  } catch {
    /* not yet */
  }
}
if (!up) {
  console.log('the server never came up. stderr:\n' + serverErr.join(''));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// One socket, and a record of everything it was sent
// ---------------------------------------------------------------------------

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (raw) => {
  try {
    frames.push(JSON.parse(raw.toString()));
  } catch {
    /* not ours */
  }
});
ws.on('error', (err) => {
  console.log(`socket error: ${String(err)}`);
  process.exit(1);
});
await new Promise((done) => ws.on('open', done));

const send = (msg) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
const last = (t) => frames.filter((f) => f.t === t).at(-1);

let logCursor = 0;
const drainLog = () => {
  const lines = [];
  for (const f of frames) if (f.t === 'log') for (const l of f.lines ?? []) lines.push(l.text);
  const fresh = lines.slice(logCursor);
  logCursor = lines.length;
  return fresh;
};
const beat = (title) => console.log(`\n──── ${title}`);

// ---------------------------------------------------------------------------
// 1. Be a Redactor
// ---------------------------------------------------------------------------

beat('THE PICKER');
/**
 * BY NAME, NOT BY INDEX. `helloAndChoose` takes a position in the offered list
 * and the Redactor is fourth today — but the whole point of this run is that the
 * roster changed, so an index would be the one assumption most likely to rot.
 * The offer is read, the id is found, and a missing one is the first failure.
 */
send({ t: 'hello' });
await sleep(400);
const offer = last('class_options');
const options = offer?.options ?? [];
console.log(`  offered: ${options.map((o) => o.id).join(', ') || '(none)'}`);
const wanted = options.findIndex((o) => o.id === 'redactor');
if (wanted < 0) {
  console.log('  THE REDACTOR WAS NOT OFFERED. The picker is built from CLASSES.');
  process.exit(1);
}

/** Re-run the handshake through the shared helper, now that the index is known. */
const socketFrames = frames;
const { chosen } = await helloAndChoose(send, socketFrames, wanted);
console.log(`  chose: ${chosen.id} — ${chosen.name}`);
await sleep(500);

const loadout = last('loadout');
const talents = loadout?.talents ?? [];
console.log(`  loadout: ${talents.map((t) => t.name).join(' | ') || '(none)'}`);
const strikeOut = talents.find((t) => /strike out/i.test(t.name));
if (strikeOut === undefined) {
  console.log('  STRIKE OUT IS NOT ON THE BAR. Check `REDACTOR.birthTalents`.');
  process.exit(1);
}

/**
 * THE POOL IS NESTED. `ResourceMsg` is `{ t, resource: ResourceView }`, and the
 * first draft of this read `r.kind` off the frame itself — which is `undefined`,
 * so the probe reported "THE POOL IS undefined, NOT INK" about a frame that had
 * arrived and was perfectly correct. Read the shape; do not guess it.
 */
const inkOf = () => {
  const r = last('resource')?.resource;
  return r === undefined ? null : { kind: r.kind, value: r.current, max: r.max };
};
/**
 * WAITED FOR, NOT SAMPLED. The first run of this file read `last('resource')`
 * 900ms after choosing and printed "THE POOL IS NOT INK" — because no `resource`
 * frame had arrived at all, which is a different fact from a frame carrying the
 * wrong kind. That is precisely the false negative `waitForBadges` was added to
 * `status-live.mjs` to stop, reproduced here within an hour of citing it.
 */
let opening = inkOf();
for (let i = 0; i < 40 && opening === null; i += 1) {
  await sleep(150);
  opening = inkOf();
}
console.log(
  `  resource: ${opening?.kind ?? '(no frame arrived)'} ` +
    `${String(opening?.value)}/${String(opening?.max)}`,
);
if (opening === null) {
  console.log('  NO `resource` FRAME IN SIX SECONDS. The pool is never announced at all.');
  process.exit(1);
}
if (opening.kind !== 'ink') {
  console.log(
    `  THE POOL IS ${opening.kind}, NOT INK. \`REDACTOR.resource\` did not reach the sheet.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Find something to write on
// ---------------------------------------------------------------------------

beat('WALKING INTO A FIGHT');
const selfId = last('welcome')?.selfId;
const realmNow = () => last('realm');

/**
 * HOSTILES ARE NOT ON THE OVERWORLD'S ACTOR LIST. They are ROAMER SITES, and a
 * fight starts by walking into one — `realm.kind` flips to `inner` and the
 * monsters appear then. The first draft of this walked six tiles north looking
 * for `kind === 'monster'` in `realm.actors` and reported "nothing hostile
 * turned up in 400 steps" about a map that was full of them.
 *
 * The loop below is `status-live.mjs`'s, which already knew this.
 */
const roamers = () => (last('sites')?.sites ?? []).filter((site) => site.sprite);
let pos = (() => {
  const me = realmNow()?.actors?.find((a) => a.id === selfId);
  return me === undefined ? { x: 0, y: 0 } : { x: me.x, y: me.y };
})();

let inFight = false;
for (let i = 0; i < 400 && !inFight; i += 1) {
  const targets = roamers();
  const realm = realmNow();
  if (targets.length === 0) {
    send({ t: 'move', dir: 'n' });
  } else {
    const near = targets
      .map((site) => ({ site, d: Math.max(Math.abs(site.x - pos.x), Math.abs(site.y - pos.y)) }))
      .sort((a, b) => a.d - b.d)[0].site;
    const dir =
      realm === undefined
        ? 'n'
        : (firstStep((x, y) => canWalk(realm.level, x, y), pos, { x: near.x, y: near.y }) ?? 'n');
    send({ t: 'move', dir });
  }
  await sleep(TURN_WAIT_MS / 2);
  const moved = frames.filter((f) => f.t === 'moved' && f.id === selfId).at(-1);
  if (moved !== undefined) pos = { x: moved.x, y: moved.y };
  if (realmNow()?.kind === 'inner') inFight = true;
}

if (!inFight) {
  console.log('  never found a fight in 400 steps — nothing to mark. Inconclusive.');
  ws.close();
  server.kill();
  process.exit(0);
}

const hostiles = () =>
  (realmNow()?.actors ?? []).filter((a) => a.id !== selfId && a.kind === 'monster' && a.alive);
const victim = hostiles()[0];
if (victim === undefined) {
  console.log('  in a breach with nothing alive in it. Inconclusive.');
  ws.close();
  server.kill();
  process.exit(0);
}
console.log(`  in a breach with ${victim.name} at ${String(victim.x)},${String(victim.y)}`);
drainLog();

// ---------------------------------------------------------------------------
// 3. Strike it out, and see whether the well fills
// ---------------------------------------------------------------------------

beat('STRIKE OUT');
const before = inkOf();
const usedIt = () => frames.some((f) => f.t === 'used' && f.ev?.talentId === strikeOut.id);

/**
 * CLOSE TO RANGE FIRST. Strike Out reaches 6 and the breach can drop you further
 * out than that — the first run stood at 12,12 against a husk at 7,5, seven tiles
 * away, and the server correctly answered `out_of_range` while this file called
 * it "NOTHING RESOLVED — this IS a fault". A probe that cannot walk into its own
 * range is measuring its own legs.
 */
const STRIKE_RANGE = 6;
/**
 * THE SERVER'S METRIC, WHICH IS EUCLIDEAN. `engine/combat.ts#combatDistance` is
 * `sqrt(dx*dx + dy*dy)`; this probe used Chebyshev, walked to 12,12 against a
 * body at 18,14, measured "6 tiles, range is 6" and could not understand why
 * `out_of_range` came back. (6, 2) is 6.32 away. The server was right every time.
 *
 * A probe that measures distance differently from the thing it is probing will
 * always eventually accuse it of a bug it does not have.
 */
const reach = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
/**
 * POSITIONS COME AS DELTAS. `realm` is a SNAPSHOT and the bodies move inside
 * `moved` frames after it, so reading a position out of the snapshot is reading
 * where everybody was when the breach opened. The first run of this loop asked
 * the snapshot where it was standing, was told 12,12 for twenty iterations, and
 * never took a step. `status-live.mjs` says this in its own words: "the board
 * here is rebuilt from deltas, and the husk takes its step inside a `sweep`".
 */
/**
 * ONLY THE MOVES SINCE THIS REALM ARRIVED, which is the whole correctness of it.
 *
 * An earlier version replayed EVERY `moved` frame of the session over the inner
 * realm's snapshot — including every step taken on the OVERWORLD before the
 * breach opened. Those are positions on a different map, and they clobbered the
 * right ones: the probe aimed at overworld coordinates, collected
 * `out_of_range` eight times, and reported a fault while an Index Husk was
 * hitting the caster in melee.
 *
 * A realm frame is a fresh board. Nothing before it describes this one.
 */
const track = new Map();
const sinceRealm = () => {
  let at = -1;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i].t === 'realm') {
      at = i;
      break;
    }
  }
  return at;
};
const refresh = () => {
  track.clear();
  const from = sinceRealm();
  for (const actor of realmNow()?.actors ?? []) track.set(actor.id, { x: actor.x, y: actor.y });
  for (let i = from + 1; i < frames.length; i += 1) {
    const f = frames[i];
    if (f.t === 'moved') track.set(f.id, { x: f.x, y: f.y });
  }
};
const hereRaw = () => {
  refresh();
  return track.get(selfId) ?? { x: 0, y: 0 };
};
// REFRESHES FIRST. Splitting `hereRaw` out left this one reading a map that
// `refresh` had just cleared, so it answered `undefined` and the approach loop
// broke out on its first iteration without taking a step.
const hereNow = () => {
  refresh();
  const at = track.get(selfId);
  return at === undefined ? undefined : { ...at, id: selfId };
};
/**
 * THE NEAREST LIVE HOSTILE, RE-CHOSEN EVERY TIME — not the one this run happened
 * to name when the breach opened.
 *
 * A breach holds several bodies and they move. An earlier version tracked one id
 * from entry, aimed at it for eight attempts, and collected eight
 * `out_of_range` refusals WHILE AN INDEX HUSK WAS HITTING THE CASTER IN MELEE.
 * Something was plainly in reach; it simply was not the body being aimed at.
 */
const victimNow = () => {
  refresh();
  const live = (realmNow()?.actors ?? []).filter(
    (a) => a.id !== selfId && a.kind === 'monster' && a.alive,
  );
  const at = hereRaw();
  const ranked = live
    .map((a) => {
      const p = track.get(a.id) ?? { x: a.x, y: a.y };
      return { a, p, d: reach(at, p) };
    })
    .sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best === undefined
    ? { x: victim.x, y: victim.y, name: victim.name }
    : { ...best.p, name: best.a.name };
};
for (let step = 0; step < 20; step += 1) {
  const at = hereNow();
  const realm = realmNow();
  if (at === undefined || realm === undefined) break;
  const goal = victimNow();
  if (reach(at, goal) <= STRIKE_RANGE) break;
  const dir = firstStep((x, y) => canWalk(realm.level, x, y), { x: at.x, y: at.y }, goal);
  if (dir === undefined) break;
  send({ t: 'move', dir });
  await sleep(TURN_WAIT_MS * 3);
}

const me = hereNow();
const goal = victimNow();
const away = me === undefined ? '?' : reach(me, goal).toFixed(1);
console.log(
  `  me at ${String(me?.x)},${String(me?.y)} — ${String(goal.name)} at ` +
    `${String(goal.x)},${String(goal.y)}, ${away} tiles, range is ${String(STRIKE_RANGE)}`,
);

/**
 * PRESSED UNTIL IT LANDS OR THE ATTEMPTS RUN OUT, re-aiming each time. The
 * target is a live creature taking its own turn between the read and the press,
 * so a single shot at a remembered tile misses about as often as not — and
 * `illegal_move` maps from `NoTarget`, which is indistinguishable from a broken
 * talent unless you try again at where it actually is now.
 */
const errorsBefore = frames.filter((f) => f.t === 'error').length;
for (let attempt = 0; attempt < 8 && !usedIt(); attempt += 1) {
  const at = victimNow();
  send({ t: 'talent', talentId: strikeOut.id, target: { x: at.x, y: at.y } });
  const deadline = Date.now() + 800;
  while (Date.now() < deadline && !usedIt()) await sleep(60);
  if (usedIt()) break;
  send({ t: 'hold' });
  await sleep(TURN_WAIT_MS * 3);
}

/**
 * WHAT THE SERVER SAID, NOT WHAT IT MIGHT HAVE MEANT. `status-live.mjs` spent a
 * run printing three unchecked guesses at a refusal whose code was on the wire
 * the whole time. Every refusal since the press is printed here.
 */
for (const err of frames.filter((f) => f.t === 'error').slice(errorsBefore)) {
  console.log(`  [server refused] ${err.code}: ${err.message ?? ''}`);
}

const lines = drainLog();
for (const line of lines) console.log(`  ${line}`);
await sleep(600);
const after = inkOf();

console.log(
  `\n  Ink: ${String(before?.value)} -> ${String(after?.value)} (of ${String(after?.max)})`,
);

/**
 * THE VERDICT, AND ONLY TWO OF THE FOUR ARE FAULTS.
 *
 * A resisted mark is the status system WORKING and refusing — `status-live.mjs`
 * spent a run reporting exactly that as a broken pipeline, and this file is not
 * going to repeat it. What is a fault is a mark that landed and paid nothing
 * (the Ink path is broken) or a press that never resolved at all.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A SECOND PRESS, WHICH IS THE ONLY WAY TO TELL TWO BUGS APART.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The well starts FULL, so a first mark that pays cannot be seen: 100 - 8 + 12
 * caps back to 100 and 100 - 8 with no income is 92. The reading after one cast
 * is the same either way if the income is capped away, and DIFFERENT only in the
 * direction that looks like a fault.
 *
 * Press again from 92 and the two answers separate:
 *   income arrives  ->  92 - 8 + 12 = 96   (the well climbs while marking)
 *   income does not ->  92 - 8      = 84
 *
 * A third possibility this also catches: the server credits correctly and never
 * SENDS the new figure, in which case the second reading is 84 while the server
 * believes 96 — and the third press would read 76 rather than 88. That is a
 * different bug in a different layer, and reporting one as the other would send
 * somebody to read the wrong file.
 */
beat('AGAIN, TO SEE WHICH WAY THE WELL MOVES');
const secondFrom = inkOf();
for (let attempt = 0; attempt < 8; attempt += 1) {
  const before2 = frames.filter((f) => f.t === 'used').length;
  const at = victimNow();
  send({ t: 'talent', talentId: strikeOut.id, target: { x: at.x, y: at.y } });
  const until = Date.now() + 900;
  while (Date.now() < until && frames.filter((f) => f.t === 'used').length === before2) {
    await sleep(60);
  }
  if (frames.filter((f) => f.t === 'used').length > before2) break;
  send({ t: 'hold' });
  await sleep(TURN_WAIT_MS * 3);
}
await sleep(700);
for (const line of drainLog()) console.log(`  ${line}`);
const secondTo = inkOf();
console.log(`  Ink: ${String(secondFrom?.value)} -> ${String(secondTo?.value)}`);
/**
 * EVERY DISTINCT FIGURE THE SOCKET WAS SENT, IN ORDER — because one reading
 * cannot separate the two ways this can be wrong.
 *
 * `sendHotbarIfChanged` is MEMOISED on a key that quantises the pool with
 * `Math.floor`, so a value that returns to what it already was sends no frame at
 * all. That means "the client still reads 92" is consistent with BOTH
 *
 *   the income never happened (the server is at 84 and said so, and this read a
 *   stale frame), and
 *   the income happened and capped (the server is at 100 and the memo suppressed
 *   the resend because the previous frame already said 100).
 *
 * The sequence tells them apart in a way a before/after pair cannot, and it is
 * printed rather than judged: this probe has no business naming a culprit it
 * cannot see.
 */
const readings = frames
  .filter((f) => f.t === 'resource')
  .map((f) => f.resource)
  .filter((r) => r !== undefined);
const distinct = [];
for (const r of readings) {
  const at = `${String(r.current)}/${String(r.max)}`;
  if (distinct.at(-1) !== at) distinct.push(at);
}
console.log(`  every Ink figure this socket was sent: ${distinct.join(' -> ')}`);
console.log(`  (${String(readings.length)} resource frames in all)`);

const text = lines.join(' | ');
const landed = /is struck out/.test(text);
const resisted = /holds the line/.test(text);
const paid = before !== null && after !== null && after.value > before.value;

beat('VERDICT');
if (!usedIt()) {
  console.log('  NOTHING RESOLVED — no `used` frame named Strike Out. This IS a fault.');
  process.exit(1);
} else if (landed && paid) {
  console.log('  THE MARK LANDED AND THE WELL FILLED. The class works end to end.');
} else if (landed && !paid) {
  console.log(
    '  THE MARK LANDED AND THE BAR DID NOT CLIMB. Either the income never\n' +
      '  arrives, or it arrives and the client is never told — the sequence\n' +
      '  above is the evidence, and this probe does not guess between them.\n' +
      '  Read it with `sendHotbarIfChanged` in net/gateway.ts, which suppresses\n' +
      '  a resend when the floored figure is unchanged.',
  );
  process.exit(1);
} else if (resisted) {
  console.log(
    '  THE TARGET SAVED. The status system ran and refused the mark, which is an ' +
      'honest outcome and not a fault — run again for a landing.',
  );
} else {
  console.log(`  UNRECOGNISED. The log said: ${text || '(nothing)'}`);
}

ws.close();
server.kill();
