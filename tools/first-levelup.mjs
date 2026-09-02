// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FIRST LEVEL-UP, PLAYED.  `node tools/first-levelup.mjs [port]`
// ═══════════════════════════════════════════════════════════════════════════
//
// `first-session.mjs` walks the opening arc and stops at the shop, with the
// character still level 1. This drives the beat immediately after it: fight
// until level 2, then spend the point.
//
// ═══ WHY IT IS WORTH A DRIVER OF ITS OWN ═══
// In a ToME-like the level-up is where the player makes a CHOICE about who
// their character is, and nothing in this project had ever walked one through
// it. `career.mjs` prints the curve from the tables and asserts nothing;
// `first-fight.mjs` drives the engine with no protocol in the way. Neither can
// see what actually REACHES A SCREEN at the moment a point is granted — which
// is the only question that matters for whether a player notices it happened.
//
// ═══ IT REPORTS THE SETUP, NOT ONLY THE RESULT ═══
// Five of the last six faults this family of tools reported were faults in the
// tool: a monster that was kiting (it was a MeleeChaser), a monster on the
// player's own tile (a stale coordinate), frozen monster positions (monster
// moves arrive inside `sweep`, not the immediate `moved` lane), a loot walk
// that took one step, and a shop hunt that visited an archive and a campfire.
//
// So this prints how many fights it drove, what it met, and what the progress
// frame said at each step. A run that reaches no level says which of those
// stopped rather than printing nothing and inviting an invention.
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

const PORT = process.argv[2] ?? '31951';
const CWD = fileURLToPath(new URL('..', import.meta.url));
/** Level 2 is 27 xp and one encounter pays about 6. See `career.mjs`. */
const TARGET_LEVEL = 2;
const MAX_FIGHTS = 12;

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
const show = (from, cap = 14) => {
  drain();
  const ls = log.slice(from);
  for (const l of ls.slice(-cap)) console.log(`  ${'  '.repeat(l.depth ?? 0)}${l.text}`);
  if (ls.length === 0) console.log('  (nothing)');
};

const realmNow = () => frames.filter((f) => f.t === 'realm').at(-1);
const progressNow = () => frames.filter((f) => f.t === 'progress').at(-1);

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
      // The target is never treated as blocked: stepping onto an occupied tile
      // is how you attack.
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
beat(`JOINS AS ${chosen.name}`);
const p0 = progressNow();
console.log(`  level ${String(p0?.level)}   xp ${String(p0?.xp)}/${String(p0?.xpToNext)}`);

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

const roamers = () =>
  (frames.filter((f) => f.t === 'sites').at(-1)?.sites ?? []).filter((s) => s.sprite);

/** Walk the overworld until a roamer pulls us into a breach. */
async function findAFight() {
  let moved = 0;
  let refused = 0;
  let closest = 99;
  for (let i = 0; i < 400; i += 1) {
    const rs = roamers();
    if (rs.length === 0) {
      await stepTo({ x: pos.x, y: pos.y - 1 });
      continue;
    }
    /**
     * NOT THE ONE UNDER YOUR FEET. Stepping out of a breach puts you back on the
     * overworld tile the ambush happened on, and the roamer is still listed
     * there — so the nearest roamer is at distance ZERO, every direction toward
     * it is no direction, and the hunt refuses 400 steps in a row without
     * moving. Measured exactly that way: `0 steps, 400 refused, closest 0`.
     *
     * The same shape as the fight loop's coincident foe. "Nearest" and
     * "reachable" are different questions and this tool has now conflated them
     * twice.
     */
    const near = rs
      .map((s) => ({ s, d: Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y)) }))
      .filter((c) => c.d > 0)
      .sort((a, b) => a.d - b.d)[0];
    if (near === undefined) {
      await stepTo({ x: pos.x, y: pos.y - 1 });
      continue;
    }
    closest = Math.min(closest, near.d);
    if (await stepTo({ x: near.s.x, y: near.s.y })) moved += 1;
    else refused += 1;
    if (realmNow()?.kind === 'inner') {
      // Crossing a threshold sends a `realm` frame, NOT a `moved` frame, so the
      // position has to be re-read off the new board or every path starts out
      // of bounds. This cost three passes in the sibling tool.
      const me = realmNow().actors.find((a) => a.id === selfId);
      if (me !== undefined) pos = { x: me.x, y: me.y };
      return true;
    }
  }
  console.log(
    `    [hunt] ${String(moved)} steps, ${String(refused)} refused, closest roamer ${String(closest)}`,
  );
  return false;
}

/** Bump whatever is in the room until nothing is left standing. */
async function fight() {
  /**
   * THE ROOM COMES OFF THE `realm` FRAME, not off an `enter` frame -- there is
   * no such frame, and the first draft of this invented one and would have
   * reported an empty arena. `realm.actors` is what the sibling tool reads and
   * it is what the client itself is given.
   */
  const at = new Map();
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
      // MONSTER MOVEMENT IS IN THE SWEEP. The immediate `moved` lane is mostly
      // your own steps; a monster turn is one `sweep` carrying a TurnEvent[].
      // Reading only `moved` freezes every monster at its `enter` tile.
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
      /**
       * `left` IS PER-PLAYER FOV, NOT DEATH. `reconcileSight` sends it when a
       * body leaves the viewer's sight, and deleting the entry made the loop below
       * break as soon as the last foe stepped behind a wall — a fight abandoned and
       * reported as finished. Measured in `the-long-road`, which filed ZERO delves
       * out of eleven visits on exactly this.
       *
       * Kept and marked UNSEEN, so "nothing I can see" and "nothing left alive"
       * stay different questions.
       */
      if (f.t === 'left') {
        const gone = at.get(f.id);
        if (gone !== undefined) gone.seen = false;
      }
    }
  };

  for (let i = 0; i < 300; i += 1) {
    track();
    // A foe on your own tile is not a foe you can swing at: every direction
    // toward it is no direction, so it must not be chosen as the target.
    const known = [...at.entries()].filter(
      ([id, e]) => id !== selfId && e.alive && (e.x !== pos.x || e.y !== pos.y),
    );
    // WHAT IS IN SIGHT FIRST, then whatever is only remembered.
    const foes = known.some(([, e]) => e.seen !== false)
      ? known.filter(([, e]) => e.seen !== false)
      : known;
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
  await sleep(700);
  return [...met];
}

/** Back out through the door, which only ejects once you have stepped off it. */
async function leave() {
  if (realmNow()?.kind !== 'inner') return;
  const gate = (realmNow().sites ?? []).find((site) => site.name === 'The way out');
  if (gate !== undefined) {
    for (let i = 0; i < 4; i += 1) await stepTo({ x: gate.x + 2, y: gate.y + 2 });
    for (let i = 0; i < 40 && realmNow()?.kind === 'inner'; i += 1) {
      if (!(await stepTo({ x: gate.x, y: gate.y }))) break;
    }
  }
  const me = realmNow()?.actors?.find((a) => a.id === selfId);
  if (me !== undefined) pos = { x: me.x, y: me.y };
}

// ── fight until the level turns over ───────────────────────────────────────
let mark = log.length;
let fights = 0;
let levelled = false;
const roster = new Set();
for (; fights < MAX_FIGHTS && !levelled; fights += 1) {
  const found = await findAFight();
  if (!found) {
    console.log(
      `  [stopped] no fight found: realm ${String(realmNow()?.kind)}, ${String(roamers().length)} roamer(s) visible`,
    );
    break;
  }
  for (const name of await fight()) roster.add(name);
  const p = progressNow();
  console.log(
    `  fight ${String(fights + 1)}: xp ${String(p?.xp)}/${String(p?.xpToNext)} level ${String(p?.level)}`,
  );
  if ((p?.level ?? 1) >= TARGET_LEVEL) levelled = true;
  else {
    await leave();
    console.log(`    left to ${String(realmNow()?.kind)}, ${String(roamers().length)} roamer(s)`);
  }
}

beat('FIGHTS UNTIL SOMETHING CHANGES');
console.log(`  ${String(fights)} fight(s) against ${[...roster].join(', ') || 'nothing'}`);
const p1 = progressNow();
console.log(
  `  level ${String(p1?.level)}   xp ${String(p1?.xp)}/${String(p1?.xpToNext)}   unspent ${String(p1?.unspent)}`,
);

// ── WHAT THE PLAYER WAS TOLD ───────────────────────────────────────────────
// The whole question. `ProgressMsg` is viewer-private, so a party could cross
// three levels without anybody learning a point had been granted -- the Record
// lane is what stops that, and this reads it rather than the frame.
beat('WHAT THE PLAYER WAS TOLD');
drain();
const said = log.slice(mark).map((l) => l.text);
const levelLine = said.find((t) => /reaches level/i.test(t));
const pointLine = said.find((t) => /talent point/i.test(t));
console.log(`  level announced : ${levelLine ?? 'NOTHING SAID'}`);
console.log(`  point announced : ${pointLine ?? 'NOTHING SAID'}`);

// ── and spending it ────────────────────────────────────────────────────────
mark = log.length;
const slots = frames.filter((f) => f.t === 'loadout').at(-1)?.talents ?? [];
console.log(
  `  talents in hand : ${slots.map((s) => `${s.name} L${String(s.level)}`).join(', ') || 'NONE'}`,
);
const target = slots[0];
if (target !== undefined && (p1?.unspent ?? 0) > 0) {
  send({ t: 'spend_point', talentId: target.id });
  await sleep(600);
  beat(`SPENDS THE POINT ON ${target.name}`);
  show(mark, 6);
  const p2 = progressNow();
  const after = frames.filter((f) => f.t === 'loadout').at(-1)?.talents ?? [];
  const now = after.find((s) => s.id === target.id);
  console.log(
    `  ${target.name} L${String(target.level)} -> L${String(now?.level)}   unspent ${String(p1?.unspent)} -> ${String(p2?.unspent)}`,
  );
} else {
  beat('SPENDS THE POINT');
  console.log(
    `  no point to spend (unspent ${String(p1?.unspent ?? 0)}, ${String(slots.length)} talents)`,
  );
}

console.log(`\n──── ${String(log.length)} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
ws.close();
server.kill();
process.exit(0);
