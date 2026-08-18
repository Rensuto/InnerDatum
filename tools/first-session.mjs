/**
 * THE FIRST SESSION, PLAYED. Boots the real server, connects a real client, and
 * walks the opening arc: join, pick a class, find a fight, win it, loot it, and
 * report what the player has to show for it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT PATHFINDS, AND THAT IS THE WHOLE REASON IT IS A TOOL
 * ═══════════════════════════════════════════════════════════════════════════
 * Three throwaway versions of this walked in straight lines and reported that
 * the first fight never happened. Instrumenting the server showed why:
 *
 *     over 60 attempts:  moved 5, errors 55
 *     illegal_move: refused at resolution: terrain
 *
 * The arena is a carved cave. A straight-line walker pins itself against the
 * first wall between it and its target and stays there — and every conclusion
 * drawn from that run is a conclusion about the walker. The arena is fine:
 * flood-filling forty seeds finds zero unreachable floor. So the fix belongs
 * here rather than in the map.
 *
 * The `realm` frame carries the whole tile grid, which is exactly what the real
 * client's travel uses to path, so this does the same: breadth-first over
 * eight-way steps, walls excluded.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR, AND HOW IT DIFFERS FROM ITS SIBLINGS
 * ═══════════════════════════════════════════════════════════════════════════
 * `first-fight.mjs` and `delve-run.mjs` measure BALANCE at the engine level,
 * where there is no protocol and no latency. This measures the SESSION: what
 * reaches the screen, in what order, and whether the arc joins up.
 *
 * Every player-facing gap found in the last several passes came out of running
 * something like this rather than out of reading code — a Case Log full of
 * footsteps, a world with no name, a first fight that killed strangers in
 * twenty seconds, a class choice the game never acknowledged.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES NOT DO YET, STATED PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════
 * IT CANNOT DRIVE A FIGHT TO A CONCLUSION. It reaches the enemy, trades a blow,
 * and then stops making progress — the swings go out and nothing comes back.
 * The cause is not yet known and is NOT assumed to be the game: this probe has
 * already been wrong four times about exactly this (see above), and every one
 * of those looked like a bug in the server from the outside.
 *
 * So: read the opening beats from here, and read COMBAT from
 * `first-fight.mjs`, which drives the engine directly with no protocol in the
 * way and is the trustworthy instrument for anything about a fight.
 *
 * Usage:  node tools/first-session.mjs [port]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { isWalkable } from '../src/shared/protocol.ts';

const PORT = process.argv[2] ?? '31950';
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
const send = (o) => ws.send(JSON.stringify({ v: 18, ...o }));

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

/**
 * Walls, read off the frame the client already holds.
 *
 * ═══ IT ASKS THE GAME RATHER THAN GUESSING, AND THE FIRST VERSION GUESSED ═══
 * That version said "TileCode 0 is WALL and 2 is DEEPWATER". FLOOR is 0 and
 * WALL is 1 — exactly backwards — so the pathfinder routed THROUGH walls and
 * refused open floor, found no route to anything, and reported for a fourth
 * time that the first fight never happens. A second copy of `isWalkable` is
 * precisely the thing that cannot be allowed to drift, so this imports the
 * real one.
 */
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
      // THE TARGET IS NEVER TREATED AS BLOCKED: stepping onto an occupied tile
      // is how you attack, and how you walk into a roamer.
      if ((x !== to.x || y !== to.y) && blocked(lvl, x, y)) continue;
      if (prev.has(key(x, y))) continue;
      prev.set(key(x, y), c);
      queue.push({ x, y });
    }
  }
  if (!prev.has(key(to.x, to.y))) return null;
  let cur = to;
  for (;;) {
    const back = prev.get(key(cur.x, cur.y));
    if (back === null || back === undefined) return null;
    if (back.x === from.x && back.y === from.y) break;
    cur = back;
  }
  const dir = STEPS.find(([dx, dy]) => from.x + dx === cur.x && from.y + dy === cur.y);
  return dir === undefined ? null : dir[2];
}

send({ t: 'hello' });
await sleep(900);
const selfId = frames.find((f) => f.t === 'welcome')?.selfId;
const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
beat('JOINS');
show(0, 8);

let mark = log.length;
send({ t: 'choose_class', classId: opts[0].id });
await sleep(700);
beat(`PICKS ${opts[0].name}`);
show(mark, 3);

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
  await sleep(40);
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

mark = log.length;
let breach = null;
for (let i = 0; i < 400 && breach === null; i += 1) {
  const rs = roamers();
  if (rs.length === 0) {
    await stepTo({ x: pos.x, y: pos.y - 1 });
    continue;
  }
  const near = rs
    .map((s) => ({ s, d: Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y)) }))
    .sort((a, b) => a.d - b.d)[0];
  await stepTo({ x: near.s.x, y: near.s.y });
  if (realmNow()?.kind === 'inner') {
    breach = realmNow();
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * RE-READ THE POSITION FROM THE NEW BOARD. THIS ONE COST THREE PASSES.
     * ═══════════════════════════════════════════════════════════════════════
     * Crossing a threshold sends a `realm` frame, NOT a `moved` frame — the
     * body is placed on a new map rather than stepping across the old one. A
     * probe that only tracks `moved` therefore keeps its OVERWORLD coordinates
     * (around 122,73) while standing in a 24x24 arena, and every path it asks
     * for starts out of bounds, returns null, and moves nothing.
     *
     * From the outside that looks exactly like "the first fight never happens",
     * which is what three earlier versions of this reported.
     */
    const me = breach.actors.find((a) => a.id === selfId);
    if (me !== undefined) pos = { x: me.x, y: me.y };
  }
}
beat('WALKS INTO SOMETHING');
show(mark, 4);

if (breach !== null) {
  const at = new Map();
  for (const a of breach.actors) at.set(a.id, { x: a.x, y: a.y, alive: true, name: a.name });
  let seen = frames.length;
  const track = () => {
    for (; seen < frames.length; seen += 1) {
      const f = frames[seen];
      if (f.t === 'moved') {
        const e = at.get(f.id);
        if (e) {
          e.x = f.x;
          e.y = f.y;
        }
        if (f.id === selfId) pos = { x: f.x, y: f.y };
      }
      if (f.t === 'died') {
        const e = at.get(f.id);
        if (e) e.alive = false;
      }
      if (f.t === 'left') at.delete(f.id);
    }
  };
  mark = log.length;
  for (let i = 0; i < 300; i += 1) {
    track();
    const foes = [...at.entries()].filter(([id, e]) => id !== selfId && e.alive);
    if (foes.length === 0) break;
    const [, f0] = foes.sort(
      (a, b) =>
        Math.max(Math.abs(a[1].x - pos.x), Math.abs(a[1].y - pos.y)) -
        Math.max(Math.abs(b[1].x - pos.x), Math.abs(b[1].y - pos.y)),
    )[0];
    /**
     * A SWING IS NOT A STEP. Bumping an occupied tile attacks rather than
     * moving, so no `moved` frame comes back — and treating that as "the move
     * failed" made the driver pause after every single swing, which is why an
     * early run produced one exchange in twenty-two seconds.
     */
    const adjacent = Math.max(Math.abs(f0.x - pos.x), Math.abs(f0.y - pos.y)) <= 1;
    if (adjacent) {
      const lvl = realmNow().level;
      const dir = firstStep(lvl, pos, { x: f0.x, y: f0.y });
      if (dir !== null) send({ t: 'move', dir });
      await sleep(45);
    } else if (!(await stepTo({ x: f0.x, y: f0.y }))) {
      await sleep(45);
    }
  }
  await sleep(900);
  beat('THE FIGHT');
  show(mark, 16);

  mark = log.length;
  for (let i = 0; i < 6; i += 1) {
    send({ t: 'pickup' });
    await sleep(220);
  }
  beat('LOOTS THE ROOM');
  show(mark, 8);
}

await sleep(400);
drain();
const inv = frames.filter((f) => f.t === 'inventory').at(-1);
const prog = frames.filter((f) => f.t === 'progress').at(-1);
beat('WHAT THEY HAVE TO SHOW FOR IT');
console.log(
  `  level ${prog?.level}   xp ${prog?.xp}/${prog?.xpToNext}   unspent points ${prog?.unspent}`,
);
console.log(
  `  ${inv?.money ?? 0} gold, bag: ${(inv?.carried ?? []).map((c) => c.name).join(', ') || '(empty)'}`,
);
console.log(`  standing in: ${realmNow()?.name}`);
console.log(
  `\n──── the player read ${log.length} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);

ws.close();
server.kill();
await sleep(200);
