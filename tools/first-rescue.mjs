// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// GET TO ME.  `node tools/first-rescue.mjs [port]`
// ═══════════════════════════════════════════════════════════════════════════
//
// Two players, one party, one fight. One of them goes down and the other walks
// over and picks them up. Prints what BOTH of them saw.
//
// ═══ WHY IT IS WORTH A DRIVER OF ITS OWN ═══
// game-design.md § 9 calls Downed "the mechanic that does more for co-op tension
// than anything else", and gives the reason in one sentence: it turns "I died"
// into GET TO ME. This game is built for three to six friends in a voice
// channel — and every instrument in this folder until now has measured ONE
// PERSON ALONE. `first-session`, `first-levelup` and `first-death` all drive a
// solo character, so the single most important co-op claim in the design
// document has never been played.
//
// ═══ IT READS BOTH SIDES, WHICH IS THE POINT ═══
// The person on the floor and the person running to them are having different
// experiences and only one of them can act. A rescue that reads well to the
// rescuer and tells the downed player nothing is still a broken beat, and a
// driver holding one socket cannot tell the difference. So this holds two and
// prints each transcript separately.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { isWalkable } from '../src/shared/protocol.ts';
// THE SERVER'S OWN NUMBER, NEVER A LITERAL. These tools hardcoded `v: 18`
// and could not connect at all from the day PROTOCOL_VERSION became 19 — the
// handshake was refused with `version_mismatch` and the fixed sleep after it
// turned that into "Cannot read properties of undefined". Eight gameplay
// verification tools were dead and silent about it.
import { PROTOCOL_VERSION } from '../src/shared/version.ts';

const PORT = process.argv[2] ?? '31971';
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

/** One connected player, with its own frame log — two of these is the point. */
async function join(label) {
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

  send({ t: 'hello' });
  await sleep(900);
  const id = frames.find((f) => f.t === 'welcome')?.selfId;
  const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
  send({ t: 'choose_class', classId: opts[0].id });
  await sleep(600);

  const realmNow = () => frames.filter((f) => f.t === 'realm').at(-1);
  const self = () => realmNow()?.actors?.find((a) => a.id === id);
  return {
    label,
    ws,
    id,
    frames,
    log,
    drain,
    send,
    realmNow,
    self,
    className: opts[0].name,
    pos: { x: self()?.x ?? 0, y: self()?.y ?? 0 },
  };
}

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

async function stepTo(p, target) {
  const lvl = p.realmNow()?.level;
  if (lvl === undefined) return false;
  const dir = firstStep(lvl, p.pos, target);
  if (dir === null) return false;
  const before = p.frames.filter((f) => f.t === 'moved' && f.id === p.id).length;
  p.send({ t: 'move', dir });
  await sleep(45);
  const after = p.frames.filter((f) => f.t === 'moved' && f.id === p.id);
  if (after.length > before) {
    const m = after.at(-1);
    p.pos = { x: m.x, y: m.y };
    return true;
  }
  return false;
}

/** Re-read a body's position off the board, which a realm change requires. */
const resync = (p) => {
  const me = p.self();
  if (me !== undefined) p.pos = { x: me.x, y: me.y };
};

// ── two of them ────────────────────────────────────────────────────────────
const a = await join('A');
const b = await join('B');
beat('TWO PLAYERS JOIN');
console.log(`  A is ${a.className}, B is ${b.className}`);

// ── one party ──────────────────────────────────────────────────────────────
a.send({ t: 'party', action: 'invite', targetId: b.id });
await sleep(500);
b.send({ t: 'party', action: 'accept', targetId: a.id });
await sleep(700);
a.drain();
b.drain();
const partyOf = (p) => p.frames.filter((f) => f.t === 'party').at(-1);
beat('AND MAKE A PARTY');
console.log(`  A's party: ${(partyOf(a)?.members ?? []).length} member(s)`);
console.log(`  B's party: ${(partyOf(b)?.members ?? []).length} member(s)`);
for (const line of a.log.slice(-3)) console.log(`  A saw: ${line.text}`);
for (const line of b.log.slice(-3)) console.log(`  B saw: ${line.text}`);

// ── into the same fight ────────────────────────────────────────────────────
// B follows A in, so both are in the delve the ambush creates. `follow` is the
// verb the game gives a party for exactly this.
const RANK = { grim: 3, dangerous: 2, restless: 1, quiet: 0 };
const graded = (a.frames.filter((f) => f.t === 'sites').at(-1)?.sites ?? [])
  .filter((s) => s.danger !== undefined && s.danger !== null && !s.sprite)
  .sort((x, y) => (RANK[y.danger] ?? 0) - (RANK[x.danger] ?? 0));
/**
 * WHICH GRADE, AND WHY IT IS AN ARGUMENT.
 *
 * A rescue needs somebody to FALL and somebody still STANDING, and that is a
 * narrow band. Measured with both of them fighting: a `dangerous` site is won
 * outright by a party of two — nobody ever goes down, which is a good thing to
 * know and a useless thing to drive. `grim` is the one that puts a body on the
 * floor. Second argument overrides it: `node tools/first-rescue.mjs 31971 dangerous`.
 */
const WANT = process.argv[3] ?? 'grim';
const target = graded.find((s) => s.danger === WANT) ?? graded[0];

let aMark;
let bMark;
for (let i = 0; i < 600 && a.realmNow()?.kind === 'overworld'; i += 1) {
  if (!(await stepTo(a, { x: target.x, y: target.y }))) break;
}
resync(a);
// B walks to the same doorway and follows through it.
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * B FOLLOWS. IT DOES NOT WALK, AND THE FIRST VERSION OF THIS TRIED TO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured: B took ZERO steps toward the door and stayed on the Moor. The path
 * was fine and B's position was right — the moves were simply never resolved,
 * because A was already inside a delve and a party barrier does not turn over
 * while a member is somewhere else. `stepTo` reports that as `false` for the
 * same reason it reports a wall as `false`, which is how "B never moved" looked
 * like a pathfinding failure for one pass.
 *
 * `follow` is the verb the game gives a party for exactly this, and it is what
 * a real player presses — the reason `handleFollow` exists, and refuses with
 * "they are not anywhere you can reach" and "they are already here with you".
 */
b.send({ t: 'follow', targetId: a.id });
await sleep(900);
resync(b);
resync(b);
await sleep(500);
a.drain();
b.drain();
beat(`BOTH WALK INTO ${String(target.name)} (${String(target.danger)})`);
console.log(`  A is in: ${String(a.realmNow()?.name)} [${String(a.realmNow()?.kind)}]`);
console.log(`  B is in: ${String(b.realmNow()?.name)} [${String(b.realmNow()?.kind)}]`);

// ── the fight, with A doing the fighting and B hanging back ────────────────
// A bumps whatever is nearest; B holds. The asymmetry is deliberate: somebody
// has to be standing when the other one falls, or there is no rescue to read.
aMark = a.log.length;
bMark = b.log.length;
const downedOf = (p) => {
  const party = p.frames.filter((f) => f.t === 'party_state').at(-1);
  return (party?.members ?? []).map((m) => [m.id, m.downed ?? null]);
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO PLAYERS MEANS THE TURN DOES NOT MOVE UNTIL BOTH OF THEM HAVE ANSWERED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The solo drivers get away with "send a move, sleep 45ms, look for a `moved`":
 * one player IS the quorum, so the turn resolves the instant they commit. With
 * two, `TurnMsg.engagement > 0` arms the barrier and every player owes a
 * decision every turn — so firing intents on a fixed sleep just races it.
 *
 * Measured, before this: A moved 6 times and was REFUSED 214, closest approach
 * 8 tiles, not one swing thrown, both bodies still at 72 hp after 220 rounds.
 * From the outside that reads as "the fight never happens", which is the exact
 * sentence three earlier versions of `first-session` produced for three
 * different reasons that were all the driver.
 *
 * So this drives by TURN: everybody who owes a decision commits, and then it
 * waits for `gameTurn` to actually move before deciding anything else.
 */
const turnOf = (p) => p.frames.filter((f) => f.t === 'turn').at(-1)?.gameTurn ?? -1;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOARD IS TRACKED, NOT RE-READ. `realm.actors` IS A SNAPSHOT OF ARRIVAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resync` reads a body's position out of the latest `realm` frame, which is
 * correct exactly once — when you cross a threshold and are handed a new board.
 * Calling it every turn pins both players to the tile they walked in on, so A
 * "moved" all fight and never got closer than 8, and the monsters never moved
 * at all because their positions came off the same frozen snapshot.
 *
 * Both halves of that are faults this family of tools has had before: the
 * frozen monsters are `sweep` versus the immediate `moved` lane, which
 * `first-levelup.mjs` already documents. This is the same bug wearing a party.
 */
const board = new Map();
let scanned = 0;
const place = (id, x, y) => {
  const e = board.get(id);
  if (e) {
    e.x = x;
    e.y = y;
  }
  if (id === a.id) a.pos = { x, y };
  if (id === b.id) b.pos = { x, y };
};
const readBoard = () => {
  /**
   * BOTH BOARDS, because they were handed out at different moments. A's `realm`
   * frame is the snapshot of A's arrival and B followed in AFTERWARDS, so B is
   * simply not on it — measured: 13 entries, twelve monsters and A, and the
   * rescue broke with "victim B not on the tracked board". Seeding from one
   * player's view is only ever right for a party of one.
   */
  for (const actor of [...(a.realmNow()?.actors ?? []), ...(b.realmNow()?.actors ?? [])]) {
    if (!board.has(actor.id)) {
      board.set(actor.id, { x: actor.x, y: actor.y, alive: true, name: actor.name });
    }
  }
  for (; scanned < a.frames.length; scanned += 1) {
    const f = a.frames[scanned];
    // A monster turn is ONE `sweep` carrying a TurnEvent[]; the top-level
    // `moved` lane is mostly your own steps.
    if (f.t === 'sweep') {
      for (const ev of f.events ?? []) {
        if (ev.k === 'move') place(ev.id, ev.x, ev.y);
        if (ev.k === 'death') {
          const e = board.get(ev.id);
          if (e) e.alive = false;
        }
      }
    }
    if (f.t === 'moved') place(f.id, f.x, f.y);
    if (f.t === 'died') {
      const e = board.get(f.id);
      if (e) e.alive = false;
    }
    if (f.t === 'left') board.delete(f.id);
  }
};

const awaitTurn = async (before) => {
  for (let w = 0; w < 24 && turnOf(a) === before; w += 1) {
    await sleep(25);
    readBoard();
  }
  readBoard();
};

let rescued = false;
let downedId = null;
let swings = 0;
let closest = 99;

for (let round = 0; round < 160 && !rescued; round += 1) {
  a.drain();
  b.drain();
  const lvl = a.realmNow()?.level;
  if (lvl === undefined) break;

  // Who is on the floor, as the PARTY PANEL reports it — the surface a rescuer
  // actually reads, not the engine's own table.
  const onFloor = downedOf(b).filter(([, d]) => d !== null);
  if (onFloor.length > 0 && downedId === null) {
    downedId = onFloor[0][0];
    beat('SOMEBODY IS ON THE FLOOR');
    console.log(`  party panel, as the RESCUER sees it: ${JSON.stringify(downedOf(b))}`);
    for (const l of a.log.slice(aMark)) console.log(`  A saw: ${l.text}`);
    for (const l of b.log.slice(bMark)) console.log(`  B saw: ${l.text}`);
    aMark = a.log.length;
    bMark = b.log.length;
  }

  const before = turnOf(a);

  if (downedId !== null) {
    // ── THE RESCUE ───────────────────────────────────────────────────────
    // `revive` names a DIRECTION, not an id: you pick up whoever is on the
    // tile you point at. So B has to be standing next to the body first.
    /**
     * WHOEVER IS STILL STANDING DOES THE RESCUING. The first version hard-coded
     * A as the casualty and B as the rescuer, and then B fell first — so it
     * spent the countdown ordering a body on the floor to walk somewhere.
     */
    const victim = downedId === a.id ? a : b;
    const saviour = downedId === a.id ? b : a;
    const body = board.get(victim.id);
    if (body === undefined) {
      console.log(
        `  the victim is not on the tracked board: ${victim.label} (${String(board.size)} entries)`,
      );
      break;
    }
    const gap = Math.max(Math.abs(body.x - saviour.pos.x), Math.abs(body.y - saviour.pos.y));
    if (gap > 1) {
      const dir = firstStep(lvl, saviour.pos, { x: body.x, y: body.y });
      if (dir === null) {
        console.log(
          `  no route to the body: ${saviour.label} ${String(saviour.pos.x)},${String(saviour.pos.y)} -> body ${String(body.x)},${String(body.y)} gap ${String(gap)}`,
        );
        break;
      }
      saviour.send({ t: 'move', dir });
      await awaitTurn(before);
      continue;
    }
    /**
     * STANDING ON THEM IS THE COMMON CASE, NOT AN EDGE ONE. A Downed body does
     * not block, so the last step of the run lands on top of it — measured here
     * as "adjacent but no direction: gap 0" while the countdown ran out. The
     * server now picks up whoever is under your feet first, so the direction is
     * a formality when `gap === 0`.
     */
    const step = STEPS.find(
      ([dx, dy]) => saviour.pos.x + dx === body.x && saviour.pos.y + dy === body.y,
    );
    saviour.send({ t: 'revive', dir: step === undefined ? 'n' : step[2] });
    await sleep(800);
    rescued = true;
    break;
  }

  // ── nobody down yet: A fights, B holds so the turn can resolve ─────────
  readBoard();
  const foes = [...board.entries()].filter(
    ([id, e]) => id !== a.id && id !== b.id && e.alive !== false,
  );
  const near = foes
    .map(([, e]) => ({ x: e, d: Math.max(Math.abs(e.x - a.pos.x), Math.abs(e.y - a.pos.y)) }))
    .filter((c) => c.d > 0)
    .sort((m, n) => m.d - n.d)[0];

  if (near === undefined) {
    a.send({ t: 'hold' });
    b.send({ t: 'hold' });
    await awaitTurn(before);
    continue;
  }
  closest = Math.min(closest, near.d);
  const dir = firstStep(lvl, a.pos, { x: near.x.x, y: near.x.y });
  if (dir === null) a.send({ t: 'hold' });
  else {
    a.send({ t: 'move', dir });
    if (near.d <= 1) swings += 1;
  }
  /**
   * AND B FIGHTS TOO, WHICH IS WHAT A RESCUER ACTUALLY IS.
   *
   * B held every turn in the first version and was simply beaten to death
   * standing still — the party wiped and the revive was never thrown. Nobody
   * plays a co-op roguelike by watching; the interesting question is whether
   * somebody who is IN the fight can break off and reach a friend.
   */
  /**
   * THEY FOCUS THE SAME TARGET, WHICH IS ALSO WHY THEY STAY WITHIN REACH.
   *
   * Each picking its own nearest foe pulled them to opposite ends of the room,
   * and when one fell the other needed more than five turns to cross it:
   * *"Player 2 is erased. Nobody reached them in time."* That is the right line
   * and the wrong measurement — a countdown you lose because your friend was
   * thirty tiles away says nothing about whether the rescue itself reads. Two
   * people hitting the same thing is how a party actually fights anyway.
   */
  const dirB = firstStep(lvl, b.pos, { x: near.x.x, y: near.x.y });
  if (dirB === null) b.send({ t: 'hold' });
  else b.send({ t: 'move', dir: dirB });
  await awaitTurn(before);
}

await sleep(900);
a.drain();
b.drain();

const hpOf = (p, who) => {
  const st = p.frames.filter((f) => f.t === 'party_state').at(-1);
  return (st?.members ?? []).find((m) => m.id === who)?.hp;
};
console.log(`  the fight: ${String(swings)} swing(s), closest approach ${String(closest)}`);
console.log(
  `  after the fall: A hp ${String(hpOf(b, a.id))}, B hp ${String(hpOf(b, b.id))}, foes left ${String(
    (a.realmNow()?.actors ?? []).filter((x) => x.id !== a.id && x.id !== b.id && x.alive !== false)
      .length,
  )}`,
);

beat('THE RESCUE');
if (downedId === null) {
  console.log('  NOBODY WENT DOWN — no rescue to read');
} else {
  const fell = downedId === a.id ? a : b;
  const saved = downedId === a.id ? b : a;
  const fellMark = downedId === a.id ? aMark : bMark;
  const savedMark = downedId === a.id ? bMark : aMark;
  console.log(`  down: ${fell.label}   rescue thrown: ${String(rescued)}`);
  console.log(`  --- what the RESCUER (${saved.label}) saw ---`);
  for (const l of saved.log.slice(savedMark))
    console.log(`    ${'  '.repeat(l.depth ?? 0)}${l.text}`);
  console.log(`  --- what the one ON THE FLOOR (${fell.label}) saw ---`);
  for (const l of fell.log.slice(fellMark))
    console.log(`    ${'  '.repeat(l.depth ?? 0)}${l.text}`);
  console.log(`  party panel after: ${JSON.stringify(downedOf(b))}`);
}

a.ws.close();
b.ws.close();
server.kill();
process.exit(0);
