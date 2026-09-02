// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FIRST DEATH, ALONE.  `node tools/first-death.mjs [port]`
// ═══════════════════════════════════════════════════════════════════════════
//
// Walks a level-1 character into the most dangerous place on the map, loses,
// and prints everything that happens next.
//
// ═══ WHY THIS BEAT AND NOT ANOTHER ═══
// Death is the moment a roguelike either keeps a player or does not. Every
// other driver in this folder measures a session going WELL: `first-session`
// wins its fight and buys a draught, `first-levelup` wins six and spends a
// point. Nothing had ever driven the losing case, which is the one a player
// meets on the evening they decide whether to launch it again tomorrow.
//
// AND SPECIFICALLY ALONE. game-design.md calls Downed the mechanic that turns
// "I died" into GET TO ME, which is true with a party and is an instruction
// addressed to nobody when you are by yourself. The gateway already knows the
// difference and says "nobody is coming" rather than "N turns to reach them".
// What it does NOT tell you from inside the code is what the player does next,
// which is what this prints.
//
// ═══ IT AIMS AT THE DANGER GRADE THE GAME ADVERTISES ═══
// `SiteView.danger` is quiet | restless | dangerous | grim, and `partyHint`
// says "hard alone" out loud. A level-1 character walking into a `grim` site is
// not this tool cheating to force a loss — it is the exact thing the map dares
// a new player to do, and the whole question is what the game does when they
// take the dare.
//
// ═══ WHAT IT FOUND, AND WHAT IT DID NOT ═══
// The solo death loop is COHERENT and mostly wanted no changes. The map grades
// the site, entering one says "Graded grim — bring a party. You are one.", the
// countdown says "nobody is coming" rather than "N turns to reach them", and the
// player lands back on the Moor alive with level, xp and gold untouched — "no
// permadeath, NO LOSS" read at its word.
//
// One line was wrong and is fixed: the erasure announced "the party is down" to
// a player who did not have one.
//
// AND ONE THING THAT LOOKS WRONG IS NOT. The sweep carries
//
//     attack damage attack damage death downed erased attack damage
//
// so a blow lands AFTER the erasure and the party row reads 12 -> 66.5 hp. That
// is deliberate: the party is restored to full before the remaining monster
// swings, and `test/server/wipe-recovery.test.ts` places a second monster
// specifically to prove the body is still standing afterwards. I moved the
// restoration to the end of the pump to "fix" it and that test caught it. The
// invariant in `resetFloor`'s header — nothing hostile between restoration and
// relocation — is about the NEXT pump, which the relocation already prevents.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { isWalkable } from '../src/shared/protocol.ts';
import { helloAndChoose } from './handshake.mjs';
// THE SERVER'S OWN NUMBER, NEVER A LITERAL. These tools hardcoded `v: 18`
// and could not connect at all from the day PROTOCOL_VERSION became 19 — the
// handshake was refused with `version_mismatch` and the fixed sleep after it
// turned that into "Cannot read properties of undefined". Eight gameplay
// verification tools were dead and silent about it.
import { COMMAND_GAP_MS, PROTOCOL_VERSION } from '../src/shared/version.ts';

const PORT = process.argv[2] ?? '31961';
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
const send = (o) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...o }));

const log = [];
let read = 0;
const drain = () => {
  for (; read < frames.length; read += 1) {
    const f = frames[read];
    if (f.t === 'log') for (const l of f.lines ?? []) log.push(l);
  }
};
const t0 = Date.now();
const beat = (s) => console.log(`\n──── ${s}  (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
const show = (from, cap = 20) => {
  drain();
  const ls = log.slice(from);
  for (const l of ls.slice(-cap)) console.log(`  ${'  '.repeat(l.depth ?? 0)}${l.text}`);
  if (ls.length === 0) console.log('  (nothing)');
};

const realmNow = () => frames.filter((f) => f.t === 'realm').at(-1);
const progressNow = () => frames.filter((f) => f.t === 'progress').at(-1);
const partyNow = () => frames.filter((f) => f.t === 'party').at(-1);
const invNow = () => frames.filter((f) => f.t === 'inventory').at(-1);

const blocked = (lvl, x, y) => {
  if (x < 0 || y < 0 || x >= lvl.w || y >= lvl.h) return true;
  return !isWalkable(lvl.tiles[y * lvl.w + x]);
};

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

/** Breadth-first, eight-way. The first step toward `to`, or null. */
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

// WAIT FOR THE FRAMES, NOT FOR THE CLOCK. See tools/handshake.mjs — a fixed
// 900ms here is a bet on how fast a cold server boots, and it loses on any
// machine that is also running a build.
const { selfId, chosen } = await helloAndChoose(send, frames);
await sleep(700);

let pos = (() => {
  const a = realmNow().actors.find((x) => x.id === selfId);
  return { x: a.x, y: a.y };
})();

async function stepTo(target) {
  const lvl = realmNow().level;
  const dir = firstStep(lvl, pos, target);
  if (dir === null) return false;
  const before = frames.filter((f) => f.t === 'moved' && f.id === selfId).length;
  send({ t: 'move', dir });
  await sleep(COMMAND_GAP_MS);
  const after = frames.filter((f) => f.t === 'moved' && f.id === selfId);
  if (after.length > before) {
    const m = after.at(-1);
    pos = { x: m.x, y: m.y };
    return true;
  }
  return false;
}

// ── pick the worst place the map admits to ─────────────────────────────────
const RANK = { grim: 3, dangerous: 2, restless: 1, quiet: 0 };
const sitesNow = () => frames.filter((f) => f.t === 'sites').at(-1)?.sites ?? [];
const graded = sitesNow()
  .filter((s) => s.danger !== undefined && s.danger !== null && !s.sprite)
  .sort((a, b) => (RANK[b.danger] ?? 0) - (RANK[a.danger] ?? 0));

beat('READS THE MAP');
const p0 = progressNow();
console.log(`  level ${String(p0?.level)} as ${chosen.name}`);
for (const s of graded.slice(0, 4)) {
  console.log(
    `  ${String(s.name)} — ${String(s.danger)}${s.partyHint ? ` · ${String(s.partyHint)}` : ''}`,
  );
}
const worst = graded[0];
if (worst === undefined) {
  console.log('  NO GRADED SITE VISIBLE — nothing to walk into');
  process.exit(0);
}

// ── walk in ────────────────────────────────────────────────────────────────
let mark = log.length;
for (let i = 0; i < 600 && realmNow()?.kind === 'overworld'; i += 1) {
  if (!(await stepTo({ x: worst.x, y: worst.y }))) break;
}
const me = realmNow()?.actors?.find((a) => a.id === selfId);
if (me !== undefined) pos = { x: me.x, y: me.y };
beat(`WALKS INTO ${String(worst.name)} (${String(worst.danger)})`);
console.log(`  now in: ${String(realmNow()?.name)} [${String(realmNow()?.kind)}]`);
show(mark, 4);

// ── and fights until it cannot ─────────────────────────────────────────────
mark = log.length;
const at = new Map();
// The room comes off `realm.actors`. There is no `enter` frame.
for (const a of realmNow()?.actors ?? []) {
  at.set(a.id, { x: a.x, y: a.y, alive: true, name: a.name });
}
let seen = frames.length;
const met = new Set();
const step = (id, x, y) => {
  const e = at.get(id);
  if (e) {
    e.x = x;
    e.y = y;
  }
  if (id === selfId) pos = { x, y };
};
const track = () => {
  for (; seen < frames.length; seen += 1) {
    const f = frames[seen];
    // Monster movement is inside the sweep, not the immediate `moved` lane.
    if (f.t === 'sweep') {
      for (const ev of f.events ?? []) {
        if (ev.k === 'move') step(ev.id, ev.x, ev.y);
        if (ev.k === 'death') {
          const e = at.get(ev.id);
          if (e) e.alive = false;
        }
      }
    }
    if (f.t === 'moved') step(f.id, f.x, f.y);
    if (f.t === 'died') {
      const e = at.get(f.id);
      if (e) e.alive = false;
    }
    if (f.t === 'left') at.delete(f.id);
  }
};

let downedAt = -1;
for (let i = 0; i < 400; i += 1) {
  track();
  // The moment the run turns over -- captured here so the report can print
  // everything from it rather than a fixed tail.
  if (downedAt < 0) {
    drain();
    const hit = log.findIndex((l) => / is DOWN | is erased/.test(l.text ?? ''));
    if (hit >= 0) downedAt = hit;
  }
  // A foe on your own tile is not a foe you can swing at.
  const foes = [...at.entries()].filter(
    ([id, e]) => id !== selfId && e.alive && (e.x !== pos.x || e.y !== pos.y),
  );
  if (foes.length === 0) break;
  const [, f0] = foes.sort(
    (a, b) =>
      Math.max(Math.abs(a[1].x - pos.x), Math.abs(a[1].y - pos.y)) -
      Math.max(Math.abs(b[1].x - pos.x), Math.abs(b[1].y - pos.y)),
  )[0];
  for (const [, e] of foes) if (e.name !== undefined) met.add(e.name);
  if (Math.max(Math.abs(f0.x - pos.x), Math.abs(f0.y - pos.y)) <= 1) {
    const dir = firstStep(realmNow().level, pos, { x: f0.x, y: f0.y });
    if (dir !== null) send({ t: 'move', dir });
    await sleep(COMMAND_GAP_MS);
  } else if (!(await stepTo({ x: f0.x, y: f0.y }))) {
    await sleep(COMMAND_GAP_MS);
  }
}
await sleep(1500);
drain();

beat('THE FIGHT IT WAS NEVER GOING TO WIN');
console.log(`  met: ${[...met].join(', ') || 'nothing'}`);
if (downedAt < 0) {
  const late = log.findIndex((l) => / is DOWN | is erased/.test(l.text ?? ''));
  downedAt = late;
}
console.log(`  ${downedAt < 0 ? 'IT DID NOT DIE' : 'it went down'}`);

// ── WHAT A PLAYER IS TOLD, AND WHAT THEY CAN DO ────────────────────────────
beat('WHAT HAPPENS WHEN YOU LOSE, ALONE');
if (downedAt >= 0) {
  for (const l of log.slice(downedAt)) console.log(`  ${'  '.repeat(l.depth ?? 0)}${l.text}`);
} else {
  show(mark, 12);
}

// A frame trace across the death, because the log alone cannot say whether a
// hit narrated after the erasure happened in the delve or after the reset.
beat('THE FRAMES, IN ORDER');
{
  const erasedAt = frames.findIndex(
    (f) =>
      (f.t === 'sweep' && (f.events ?? []).some((e) => e.k === 'erased')) ||
      (f.t === 'log' && (f.lines ?? []).some((l) => / is erased/.test(l.text ?? ''))),
  );
  for (const f of frames.slice(Math.max(0, erasedAt - 2), erasedAt + 14)) {
    if (f.t === 'realm') console.log(`  realm  -> ${String(f.name)} [${String(f.kind)}]`);
    else if (f.t === 'log')
      console.log(
        `  log     : ${(f.lines ?? [])
          .map((l) => l.text)
          .join(' | ')
          .slice(0, 96)}`,
      );
    else if (f.t === 'sweep')
      console.log(
        `  sweep   : ${(f.events ?? []).map((e) => `${e.k}(${String(e.targetId ?? e.id ?? '')})`).join(' ')}`,
      );
    else if (f.t === 'party_state')
      console.log(`  party   : ${JSON.stringify((f.members ?? []).map((m) => [m.hp, m.downed]))}`);
  }
}

beat('AND WHERE THEY ARE NOW');
const p1 = progressNow();
const party = partyNow();
const bag = invNow();
console.log(`  realm  : ${String(realmNow()?.name)} [${String(realmNow()?.kind)}]`);
console.log(
  `  level  : ${String(p0?.level)} -> ${String(p1?.level)}   xp ${String(p0?.xp)} -> ${String(p1?.xp)}`,
);
console.log(`  gold   : ${String(bag?.money)}   carried ${String((bag?.carried ?? []).length)}`);
const mine = (party?.members ?? []).find((m) => m.id === selfId);
console.log(`  downed : ${JSON.stringify(mine?.downed ?? null)}`);
console.log(`  alive  : ${String(realmNow()?.actors?.find((a) => a.id === selfId)?.alive)}`);

ws.close();
server.kill();
process.exit(0);
