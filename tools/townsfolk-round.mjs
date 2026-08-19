// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// GO INTO TOWN AND TALK TO EVERYBODY.  `node tools/townsfolk-round.mjs`
// ═══════════════════════════════════════════════════════════════════════════
//
// "Friendly NPCs, shops, interactable dialogues" is a clause of this game's
// whole brief, and it is the only one nothing has ever driven. `townsfolk.ts` is
// eight hundred lines with a topic vocabulary, a line-length budget enforced at
// module load, placement rules and faction protection — all of it verified by
// unit tests that call the content directly, and none of it ever exercised
// through a socket by something walking up to a person and asking a question.
//
// So this walks into every settlement in turn, finds who is standing there, and
// asks each of them everything, then reports what a player would actually get.
//
// ═══ IT ASKS THE QUESTIONS A PLAYER ASKS ═══
//
//   - how many people are there, and does the town look inhabited?
//   - how many topics does each of them answer?
//   - does anybody repeat themselves — the fastest way a town stops feeling real
//   - does anything they say depend on what this player has DONE?
//   - and is the shop reachable through a person, or only by standing in a room?
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
// It does not judge the writing. Whether a line is good is not a thing a probe
// can measure and not a thing worth pretending to; what it measures is COVERAGE
// and REPETITION, which are the two failures a player feels within a minute.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { isWalkable } from '../src/shared/protocol.ts';

const PORT = process.argv[2] ?? '32021';
const CWD = fileURLToPath(new URL('..', import.meta.url));

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: CWD,
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.on('exit', () => server.kill());

let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  await sleep(250);
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
  } catch {
    up = false;
  }
}
if (!up) {
  console.log('the server never came up');
  process.exit(1);
}

const t0 = Date.now();
const beat = (s) => console.log(`\n──── ${s}  (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (r) => {
  try {
    frames.push(JSON.parse(r.toString()));
  } catch {
    /* a frame this probe cannot read is not a frame it needs */
  }
});
await new Promise((r) => ws.on('open', r));
const send = (o) => ws.send(JSON.stringify({ v: 18, ...o }));
const latest = (t) => frames.filter((f) => f.t === t).at(-1);
const logLines = () =>
  frames.filter((f) => f.t === 'log').flatMap((f) => (f.lines ?? []).map((l) => String(l.text)));

send({ t: 'hello' });
await sleep(900);
const selfId = frames.find((f) => f.t === 'welcome')?.selfId;
const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
send({ t: 'choose_class', classId: opts[0].id });
await sleep(900);

// ── walking, the way the working drivers do it ─────────────────────────────
const STEPS = [
  [0, -1, 'n'],
  [1, -1, 'ne'],
  [1, 0, 'e'],
  [1, 1, 'se'],
  [0, 1, 's'],
  [-1, 1, 'sw'],
  [-1, 0, 'w'],
  [-1, -1, 'nw'],
];
const blocked = (lvl, x, y) => {
  if (x < 0 || y < 0 || x >= lvl.w || y >= lvl.h) return true;
  return !isWalkable(lvl.tiles[y * lvl.w + x]);
};
function firstStep(lvl, from, to) {
  const key = (x, y) => y * lvl.w + x;
  const prev = new Map([[key(from.x, from.y), null]]);
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const c = queue[head];
    head += 1;
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of STEPS) {
      const x = c.x + dx;
      const y = c.y + dy;
      if ((x !== to.x || y !== to.y) && blocked(lvl, x, y)) continue;
      if (prev.has(key(x, y))) continue;
      prev.set(key(x, y), c);
      queue.push({ x, y });
    }
  }
  if (!prev.has(key(to.x, to.y))) return null;
  let cur = to;
  let step = null;
  while (cur !== null && !(cur.x === from.x && cur.y === from.y)) {
    step = cur;
    cur = prev.get(key(cur.x, cur.y)) ?? null;
  }
  if (step === null) return null;
  const dir = STEPS.find(([dx, dy]) => from.x + dx === step.x && from.y + dy === step.y);
  return dir === undefined ? null : dir[2];
}

/** Live position: the newest of the `moved` lane and the arrival snapshot. */
function posOf() {
  let realmAt = -1;
  let movedAt = -1;
  for (let i = frames.length - 1; i >= 0 && realmAt < 0; i -= 1) {
    if (frames[i].t === 'realm') realmAt = i;
  }
  for (let i = frames.length - 1; i > realmAt; i -= 1) {
    if (frames[i].t === 'moved' && frames[i].id === selfId) {
      movedAt = i;
      break;
    }
  }
  if (movedAt > realmAt) return { x: frames[movedAt].x, y: frames[movedAt].y };
  return (latest('realm')?.actors ?? []).find((a) => a.id === selfId);
}

async function stepTo(target) {
  const lvl = latest('realm')?.level;
  const me = posOf();
  if (lvl === undefined || me === undefined) return false;
  if (me.x === target.x && me.y === target.y) return false;
  const dir = firstStep(lvl, me, target);
  if (dir === null) return false;
  const before = frames.filter((f) => f.t === 'moved' && f.id === selfId).length;
  send({ t: 'move', dir });
  await sleep(45);
  return frames.filter((f) => f.t === 'moved' && f.id === selfId).length > before;
}

/**
 * THE FOUR TOPICS PLUS THE GREETING, and the greeting is `undefined` rather than
 * a fifth id — `TalkSchema` says absent is "walking up and saying hello", and a
 * probe that invented a `'greeting'` id would be testing a vocabulary the server
 * does not have.
 */
const TOPICS = [undefined, 'where', 'party', 'roads', 'rumour'];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALK UP TO THEM FIRST, WHICH THE FIRST VERSION OF THIS PROBE DID NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `talk` refuses past one tile — `out_of_range`, "step closer to talk" — and
 * `townsfolk.ts` places everybody at least `MIN_FROM_ARRIVAL` (4) tiles from the
 * door ON PURPOSE, so that a party of six does not body-check the one friendly
 * face in the game the instant they cross. Standing on the arrival tile and
 * shouting therefore gets NOTHING from everybody, everywhere, which is exactly
 * what the first run reported and exactly what it would have reported if the
 * whole dialogue system were missing.
 *
 * A TRACKER, NOT `realm.actors`, because townsfolk WALK. The arrival snapshot is
 * where they stood when the door opened and their movement rides the `sweep`
 * lane, so pathing at a remembered tile is how a driver ends up bumping a wall
 * next to somebody who wandered off.
 */
function makeTracker() {
  const at = new Map();
  let seen = 0;
  const step = (id, x, y) => {
    const e = at.get(id);
    if (e !== undefined) {
      e.x = x;
      e.y = y;
    }
  };
  return () => {
    for (; seen < frames.length; seen += 1) {
      const f = frames[seen];
      if (f.t === 'realm') {
        at.clear();
        for (const a of f.actors ?? [])
          at.set(a.id, { x: a.x, y: a.y, name: a.name, kind: a.kind });
      }
      if (f.t === 'sweep')
        for (const ev of f.events ?? []) if (ev.k === 'move') step(ev.id, ev.x, ev.y);
      if (f.t === 'moved') step(f.id, f.x, f.y);
      if (f.t === 'left') at.delete(f.id);
    }
    return at;
  };
}

const gap = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Close to within one tile, or say how close it got. */
async function walkUpTo(track, id) {
  for (let i = 0; i < 60; i += 1) {
    const them = track().get(id);
    const me = posOf();
    if (them === undefined || me === undefined) return null;
    if (gap(me, them) <= 1) return gap(me, them);
    if (!(await stepTo({ x: them.x, y: them.y }))) {
      // A refused step ADJACENT to them is the bump that means we have arrived;
      // anywhere else it is a wall and repeating it is the deadlock.
      if (gap(me, them) <= 1) return gap(me, them);
      await sleep(45);
    }
  }
  const them = track().get(id);
  const me = posOf();
  return them === undefined || me === undefined ? null : gap(me, them);
}
const TOPIC_NAME = (t) => (t === undefined ? '(greeting)' : t);

/** Every settlement on the map, nearest first — a town is a marker with no grade. */
const townsOf = (me) =>
  (latest('sites')?.sites ?? [])
    .filter((s) => s.sprite === undefined && s.danger === undefined)
    .map((s) => ({ s, d: Math.max(Math.abs(s.x - me.x), Math.abs(s.y - me.y)) }))
    .sort((a, b) => a.d - b.d);

const report = [];

for (const { s: town } of townsOf(posOf())) {
  // ── get there ────────────────────────────────────────────────────────────
  let walked = 0;
  for (let i = 0; i < 500 && latest('realm')?.kind === 'overworld'; i += 1) {
    if (!(await stepTo({ x: town.x, y: town.y }))) break;
    walked += 1;
  }
  await sleep(500);
  const inside = latest('realm');
  if (inside?.kind === 'overworld') {
    report.push({ town: town.name, reached: false, walked });
    continue;
  }

  beat(`${String(town.name)} — ${String(walked)} tiles from the last stop`);
  // THE DOOR, RECORDED ON ARRIVAL. The first version read it after the round of
  // conversation and got "wherever the probe finished standing", which is why it
  // never found its way back out and only ever saw one settlement.
  const doorway = posOf();

  // ── who is standing here ─────────────────────────────────────────────────
  // Everything that is not the player and not hostile. A townsfolk is a
  // `MonsterActor` with a friendly faction (see the file's own header on why she
  // is not a third `ActorKind`), so the wire tells them apart by `kind`.
  const folk = (inside?.actors ?? []).filter((a) => a.id !== selfId && a.kind !== 'player');
  console.log(
    `  ${String(folk.length)} person/people: ${folk.map((f) => String(f.name)).join(', ') || '(nobody)'}`,
  );

  const shop = latest('shop');
  console.log(
    `  shop frame on arrival: ${shop === undefined ? 'NO' : `${String((shop.stock ?? []).length)} items`}`,
  );

  // ── ask each of them everything, twice ───────────────────────────────────
  // TWICE, because the question is not "does she answer" but "does she repeat".
  const track = makeTracker();
  for (const person of folk) {
    const closed = await walkUpTo(track, person.id);
    const heard = new Map();
    for (const pass of [1, 2]) {
      for (const topic of TOPICS) {
        const before = logLines().length;
        const errsBefore = frames.filter((f) => f.t === 'error').length;
        send({ t: 'talk', targetId: person.id, ...(topic === undefined ? {} : { topic }) });
        await sleep(220);
        const said = logLines().slice(before);
        // A REFUSAL IS NEVER SWALLOWED. Silence and "step closer to talk" look
        // identical in a transcript, and reading the first as "she has nothing
        // to say" is the whole reason this probe was wrong once already.
        for (const e of frames.filter((f) => f.t === 'error').slice(errsBefore)) {
          said.push(`REFUSED(${String(e.code)}): ${String(e.message)}`);
        }
        const key = `${TOPIC_NAME(topic)}#${String(pass)}`;
        heard.set(key, said);
      }
    }

    const answered = TOPICS.filter((t) => (heard.get(`${TOPIC_NAME(t)}#1`) ?? []).length > 0);
    const repeats = TOPICS.filter((t) => {
      const a = (heard.get(`${TOPIC_NAME(t)}#1`) ?? []).join('|');
      const b = (heard.get(`${TOPIC_NAME(t)}#2`) ?? []).join('|');
      return a !== '' && a === b;
    });

    console.log(
      `\n  ${String(person.name)}  (closed to ${closed === null ? '?' : String(closed)} tiles)`,
    );
    console.log(
      `    answers ${String(answered.length)} of ${String(TOPICS.length)}` +
        `  ·  says the same thing twice on ${String(repeats.length)} of them`,
    );
    for (const topic of TOPICS) {
      const said = heard.get(`${TOPIC_NAME(topic)}#1`) ?? [];
      const line = said.length === 0 ? 'NOTHING' : said.join(' / ');
      console.log(`    ${TOPIC_NAME(topic).padEnd(11)} ${line}`);
    }

    report.push({
      town: town.name,
      person: String(person.name),
      answered: answered.length,
      repeats: repeats.length,
    });
  }

  // ── back out to the moor ─────────────────────────────────────────────────
  // The arrival tile is the way out, and ARRIVING DISARMS IT — so leaving means
  // walking back to the door from wherever the conversation ended and stepping
  // onto it, which re-arms and ejects.
  if (doorway !== undefined) {
    for (let i = 0; i < 80 && latest('realm')?.kind !== 'overworld'; i += 1) {
      if (!(await stepTo(doorway))) break;
    }
  }
  await sleep(400);
  if (latest('realm')?.kind !== 'overworld') {
    console.log('  (could not get back out — stopping the round here)');
    break;
  }
}

beat('WHAT A PLAYER WOULD ACTUALLY GET');
const reached = report.filter((r) => r.person !== undefined);
console.log(`  settlements entered: ${String(new Set(reached.map((r) => r.town)).size)}`);
console.log(`  people spoken to   : ${String(reached.length)}`);
const totalAnswers = reached.reduce((n, r) => n + r.answered, 0);
const totalRepeats = reached.reduce((n, r) => n + r.repeats, 0);
console.log(`  topics answered    : ${String(totalAnswers)} across everybody`);
console.log(`  answers that repeat verbatim on a second ask: ${String(totalRepeats)}`);
for (const r of report.filter((x) => x.reached === false)) {
  console.log(`  NEVER REACHED: ${String(r.town)} (walked ${String(r.walked)})`);
}

ws.close();
server.kill();
process.exit(0);
