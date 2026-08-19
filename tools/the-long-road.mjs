// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// HOW LONG UNTIL THE WORLD TELLS YOU ABOUT THE OTHER HALF OF ITSELF?
// `node tools/the-long-road.mjs`
// ═══════════════════════════════════════════════════════════════════════════
//
// The Redaction is a whole second landmass — a second overworld, six delves, two
// creatures nothing else in the game has — and `townsfolk.ts` records that every
// route to it was measured SHUT: the door sits 99 tiles from the spawn, site
// markers on the world map are fog-gated so they do not appear until you have
// already walked onto the cell, region captions need a fifth of the region
// walked, and `nearestSites` reports the three nearest when the door is
// ninety-ninth. The fix was dialogue: at `STANDING_LEVEL` every person in every
// town stops giving their own rumour and starts pointing the same way.
//
// So the largest content in this game is behind one sentence, said by ten
// people, gated on a character level — and nothing has ever checked that a real
// player is ever actually told. A unit test can prove the TABLE has the line in
// it. Only a socket can prove somebody hears it.
//
// This earns the level. There is no test backdoor in this server — no env hooks,
// no GM verbs, and that is the right call for something that faces the internet
// — so the probe plays: it clears delves until the character reaches standing,
// then walks into a town and asks.
//
// ═══ IT BUMPS, AND THAT IS A CEILING ON WHAT IT CAN CONCLUDE ═══
//
// This driver attacks by walking into things and never spends a talent. A real
// player has a loadout, and `delve-run.mjs` — which does use one, through
// `fightlib` — measured a solo character clearing restless floors 7 times in 8.
// This one died on its second restless floor at level 1.
//
// SO A DEATH HERE IS NOT A STATEMENT ABOUT THE GAME'S DIFFICULTY. It is the
// floor a player who never presses a talent key would hit, which is a different
// and much lower bar. What the run CAN report honestly is the experience curve —
// what a cleared floor is worth, and therefore how far standing is — and whether
// the rumour on the wire changes when the level does.
//
// ═══ WHAT IT REPORTS ═══
//   - how many delves a solo player must clear to reach standing, and how long
//   - whether the rumour actually changes on the wire
//   - and what it changes TO, so a human can judge whether that is a signpost
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { isWalkable } from '../src/shared/protocol.ts';
import { STANDING_LEVEL } from '../src/server/content/townsfolk.ts';

const PORT = process.argv[2] ?? '32051';
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
const secs = () => ((Date.now() - t0) / 1000).toFixed(0);
const beat = (s) => console.log(`\n──── ${s}  (+${secs()}s)`);

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

// ── the walking kit, as the working drivers have it ────────────────────────
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
  await sleep(40);
  return frames.filter((f) => f.t === 'moved' && f.id === selfId).length > before;
}
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
  const kill = (id) => {
    const e = at.get(id);
    if (e !== undefined) e.alive = false;
  };
  return () => {
    for (; seen < frames.length; seen += 1) {
      const f = frames[seen];
      if (f.t === 'realm') {
        at.clear();
        for (const a of f.actors ?? []) {
          at.set(a.id, { x: a.x, y: a.y, alive: a.alive !== false, name: a.name, kind: a.kind });
        }
      }
      if (f.t === 'sweep') {
        for (const ev of f.events ?? []) {
          if (ev.k === 'move') step(ev.id, ev.x, ev.y);
          if (ev.k === 'death') kill(ev.id);
        }
      }
      if (f.t === 'moved') step(f.id, f.x, f.y);
      if (f.t === 'died') kill(f.id);
      if (f.t === 'left') at.delete(f.id);
    }
    return at;
  };
}
const gap = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
async function walkUpTo(track, id) {
  for (let i = 0; i < 60; i += 1) {
    const them = track().get(id);
    const me = posOf();
    if (them === undefined || me === undefined) return null;
    if (gap(me, them) <= 1) return gap(me, them);
    if (!(await stepTo({ x: them.x, y: them.y }))) {
      if (gap(me, them) <= 1) return gap(me, them);
      await sleep(45);
    }
  }
  return null;
}

const levelNow = () => latest('progress')?.level ?? 1;
const barNow = () => {
  const p = latest('progress');
  return p === undefined ? '?' : `${String(p.xp)}/${String(p.xpToNext)}`;
};

/**
 * THE TOWN IS CHOSEN NOW, WHILE NOTHING IS FILED YET.
 *
 * A CLEARED DELVE LOSES ITS `danger` GRADE, so "a site with no grade" stops
 * meaning "a settlement" the moment this probe starts working — a room you just
 * filed matches it too, at distance zero. `marker` is the field that keeps
 * meaning what it meant.
 */
const TOWN_MARKERS = new Set(['town', 'city', 'village']);
const start = posOf();
const allSites = latest('sites')?.sites ?? [];
const town = allSites
  .filter((s) => s.sprite === undefined && TOWN_MARKERS.has(String(s.marker)))
  .map((s) => ({ s, d: gap(s, start) }))
  .sort((a, b) => a.d - b.d)[0];

/** Ask one person one topic and hand back what they said. */
async function ask(topic) {
  const track = makeTracker();
  const person = (latest('realm')?.actors ?? []).find(
    (a) => a.id !== selfId && a.kind !== 'player',
  );
  if (person === undefined) return { name: null, said: [] };
  await walkUpTo(track, person.id);
  const before = logLines().length;
  const errs = frames.filter((f) => f.t === 'error').length;
  send({ t: 'talk', targetId: person.id, topic });
  await sleep(320);
  const said = logLines().slice(before);
  // A REFUSAL IS NEVER SWALLOWED — see `townsfolk-round.mjs`, which read
  // "step closer to talk" as "she has nothing to say" for a whole run.
  for (const e of frames.filter((f) => f.t === 'error').slice(errs)) {
    said.push(`REFUSED(${String(e.code)}): ${String(e.message)}`);
  }
  return { name: String(person.name), said };
}

async function visitTown() {
  for (let i = 0; i < 600 && latest('realm')?.kind === 'overworld'; i += 1) {
    if (!(await stepTo({ x: town.s.x, y: town.s.y }))) break;
  }
  await sleep(500);
  return latest('realm')?.kind !== 'overworld' ? posOf() : null;
}
/**
 * Walk back to the arrival tile and step onto it, which is how you leave.
 *
 * ARRIVING DISARMS THE DOOR, so a body that is ALREADY STANDING on it has to
 * step off before stepping back on — and a fight that ends on the doorstep leaves
 * you exactly there. The first version just called `stepTo(door)`, which is a
 * no-op when you are already on the target, so it broke out of its loop
 * immediately and reported "no gentle floor left" from inside the first delve.
 */
async function leaveVia(door) {
  if (door === undefined || door === null) return;
  let stuck = 0;
  for (let i = 0; i < 140 && latest('realm')?.kind !== 'overworld' && stuck < 6; i += 1) {
    const me = posOf();
    if (me === undefined) break;
    if (me.x === door.x && me.y === door.y) {
      const lvl = latest('realm')?.level;
      const off = STEPS.find(
        ([dx, dy]) => lvl !== undefined && !blocked(lvl, me.x + dx, me.y + dy),
      );
      if (off === undefined) break;
      send({ t: 'move', dir: off[2] });
      await sleep(120);
      continue;
    }
    if (!(await stepTo(door))) {
      stuck += 1;
      if (process.env.ROAD_DIAG)
        console.log(
          `      leave: at ${String(me.x)},${String(me.y)} door ${String(door.x)},${String(door.y)} REFUSED`,
        );
      await sleep(60);
    } else {
      stuck = 0;
    }
  }
  await sleep(500);
  if (process.env.ROAD_DIAG) {
    const n = frames.filter((f) => f.t === 'sites').length;
    const names = (latest('sites')?.sites ?? []).map((x) => String(x.name));
    console.log(
      `      leave: finished in ${String(latest('realm')?.name)} [${String(latest('realm')?.kind)}]` +
        ` | ${String(n)} sites frames, newest holds ${String(names.length)}: ${names.slice(0, 3).join(', ')}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THEY SAY ON DAY ONE.
// ═══════════════════════════════════════════════════════════════════════════
beat(`LEVEL ${String(levelNow())} — asking ${String(town.s.name)} about rumours`);
const doorA = await visitTown();
const before = await ask('rumour');
console.log(`  ${String(before.name)}: ${before.said.join(' / ') || 'NOTHING'}`);
await leaveVia(doorA);

// ═══════════════════════════════════════════════════════════════════════════
// THEN GO AND EARN IT.
// ═══════════════════════════════════════════════════════════════════════════
// Quiet and restless only. `delve-run.mjs` measured a solo run at 0 of 8 on
// grim and dangerous and 7 of 8 on the two gentle grades, so sending this at a
// grim floor would measure how fast a level-1 character dies, which is already
// known.
const SOLOABLE = new Set(['quiet', 'restless']);
const filed = new Set();
let cleared = 0;
let died = false;

for (let trip = 0; trip < 14 && levelNow() < STANDING_LEVEL && !died; trip += 1) {
  const me = posOf();
  if (me === undefined) break;
  const target = (latest('sites')?.sites ?? [])
    .filter((s) => s.sprite === undefined && SOLOABLE.has(String(s.danger)) && !filed.has(s.name))
    .map((s) => ({ s, d: gap(s, me) }))
    .sort((a, b) => a.d - b.d)[0];
  if (target === undefined) {
    console.log('  no gentle floor left that has not been filed. What the map offers:');
    for (const s of latest('sites')?.sites ?? []) {
      if (s.sprite !== undefined) continue;
      console.log(
        `    ${String(s.name).padEnd(24)} danger=${String(s.danger).padEnd(10)} filed=${String(filed.has(s.name))}`,
      );
    }
    break;
  }

  for (let i = 0; i < 600 && latest('realm')?.kind === 'overworld'; i += 1) {
    if (!(await stepTo({ x: target.s.x, y: target.s.y }))) break;
  }
  await sleep(400);
  if (latest('realm')?.kind === 'overworld') {
    console.log(`  could not reach ${String(target.s.name)}`);
    filed.add(target.s.name);
    continue;
  }
  const door = posOf();

  const track = makeTracker();
  for (let i = 0; i < 500; i += 1) {
    const at = track();
    const mine = posOf();
    if (mine === undefined) break;
    const foe = [...at.entries()]
      .filter(([id, e]) => id !== selfId && e.alive && e.kind !== 'player')
      .map(([, e]) => ({ e, d: gap(e, mine) }))
      .filter((c) => c.d > 0)
      .sort((p, q) => p.d - q.d)[0];
    if (foe === undefined) break;
    if (foe.d <= 1) {
      const dir = firstStep(latest('realm').level, mine, { x: foe.e.x, y: foe.e.y });
      if (dir !== null) send({ t: 'move', dir });
      await sleep(45);
    } else if (!(await stepTo({ x: foe.e.x, y: foe.e.y }))) {
      await sleep(45);
    }
  }
  await sleep(700);

  const tail = logLines().slice(-14).join(' ');
  if (/ is erased|You are erased/.test(tail)) died = true;
  const didFile = /Filed\./.test(tail);
  if (didFile) cleared += 1;
  filed.add(target.s.name);
  console.log(
    `  ${String(target.s.name).padEnd(22)} ${String(target.s.danger).padEnd(9)}` +
      ` ${didFile ? 'filed' : 'not filed'}  ->  level ${String(levelNow())} (${barNow()})  +${secs()}s`,
  );

  await leaveVia(door);
}

// ═══════════════════════════════════════════════════════════════════════════
// AND ASK AGAIN.
// ═══════════════════════════════════════════════════════════════════════════
beat(`LEVEL ${String(levelNow())} — asking ${String(town.s.name)} the same question`);
await visitTown();
const after = await ask('rumour');
console.log(`  ${String(after.name)}: ${after.said.join(' / ') || 'NOTHING'}`);

beat('WHAT A SOLO PLAYER ACTUALLY GETS');
console.log(`  delves filed          : ${String(cleared)}`);
console.log(`  level reached         : ${String(levelNow())} of ${String(STANDING_LEVEL)} needed`);
console.log(`  died on the way       : ${died ? 'YES' : 'no'}`);
console.log(`  time                  : ${secs()}s`);
const opened = before.said.join(' ') !== after.said.join(' ') && after.said.length > 0;
console.log(`  the rumour changed    : ${opened ? 'YES' : 'NO'}`);
if (!opened && levelNow() < STANDING_LEVEL) {
  console.log('  (and it should not have — the character never reached standing)');
}

ws.close();
server.kill();
process.exit(0);
