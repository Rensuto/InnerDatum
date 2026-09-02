/**
 * TWO TALENTS IN ONE ROUND, OVER A REAL SOCKET.
 *
 * The intra-turn budget crosses `gateway.ts`, and no test in `test/server/`
 * drives that file. So the proof that `DECISIONS.md` D1 is finally true is not a
 * unit test — it is this: boot the real binary, join, find a fight, and cast
 * twice before the world advances.
 *
 * WHAT IT MEASURES, and why `gameTurn` is the number that matters: a round that
 * stayed open shows TWO `used` frames against ONE game-turn advance. Two turns
 * for two casts is the old behaviour wearing the new feature's clothes.
 *
 * Usage:  node tools/round-live.mjs [port]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { COMMAND_GAP_MS, PROTOCOL_VERSION } from '../src/shared/version.ts';
import { canWalk } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';

const PORT = process.argv[2] ?? '32300';
const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.on('exit', () => server.kill());
for (let i = 0; i < 80; i += 1) {
  await sleep(250);
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
  } catch {
    continue; // not up yet
  }
}

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (r) => {
  try {
    frames.push(JSON.parse(r.toString()));
  } catch {
    console.log('  [unreadable frame]');
  }
});
await new Promise((r) => ws.on('open', r));
const send = (m) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...m }));
const last = (t) => frames.filter((f) => f.t === t).at(-1);

send({ t: 'hello' });
await sleep(900);
const selfId = last('welcome')?.selfId;
const opts = last('class_options')?.options ?? [];
const watchman = opts.find((o) => /watchman/i.test(o.name)) ?? opts[0];
send({ t: 'choose_class', classId: watchman.id });
await sleep(700);

const hotbar = last('loadout')?.talents ?? [];
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LEARNED, NOT JUST CHEAP — AND THIS PROBE SPENT ITS LIFE CASTING NEITHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The hotbar draws the whole LOADOUT: nine talents for a Watchman, of which a
 * level-1 character has RAISED two. This filtered on AP alone, so it picked Ward
 * Rush and Move Along — both at rank 0 — and was refused every time. It then
 * read `casts landed: 0` and concluded `CLOSED: each cast still cost a whole
 * turn`, which is a verdict about a feature it never exercised.
 *
 * `LoadoutTalent.level` is the rank. Zero is a button you can see and cannot
 * press yet.
 */
const cheap = hotbar
  .filter((t) => (t.cost?.ap ?? 99) <= 3 && (t.level ?? 0) >= 1)
  .sort((a, b) => a.cost.ap - b.cost.ap);
console.log(
  'hotbar:',
  hotbar.map((t) => `${t.name}(${t.cost.ap}ap, L${String(t.level ?? 0)})`).join(' '),
);
console.log('learned AND cheap enough to chain:', cheap.map((t) => t.name).join(' ') || 'NONE');

// walk into a fight
let pos = (() => {
  const a = last('realm').actors.find((x) => x.id === selfId);
  return { x: a.x, y: a.y };
})();
for (let i = 0; i < 400; i += 1) {
  const r = last('realm');
  if (r.kind === 'inner') break;
  const rs = (last('sites')?.sites ?? []).filter((s) => s.sprite);
  let dir = 'n';
  if (rs.length) {
    const n = rs
      .map((s) => ({ s, d: Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y)) }))
      .sort((a, b) => a.d - b.d)[0].s;
    dir = firstStep((x, y) => canWalk(r.level, x, y), pos, { x: n.x, y: n.y }) ?? 'n';
  }
  send({ t: 'move', dir });
  await sleep(COMMAND_GAP_MS);
  const mv = frames.filter((f) => f.t === 'moved' && f.id === selfId).at(-1);
  if (mv) pos = { x: mv.x, y: mv.y };
}
const arena = last('realm');
if (arena.kind !== 'inner') {
  console.log('never found a fight');
  server.kill();
  process.exit(0);
}

// close to melee
const foe = (arena.actors ?? []).find((a) => a.kind === 'monster');
const me = arena.actors.find((a) => a.id === selfId);
pos = { x: me.x, y: me.y };
for (let i = 0; i < 80; i += 1) {
  if (Math.max(Math.abs(pos.x - foe.x), Math.abs(pos.y - foe.y)) <= 1) break;
  const d = firstStep((x, y) => canWalk(arena.level, x, y), pos, { x: foe.x, y: foe.y }) ?? 'e';
  send({ t: 'move', dir: d });
  await sleep(COMMAND_GAP_MS);
  const mv = frames.filter((f) => f.t === 'moved' && f.id === selfId).at(-1);
  if (mv) pos = { x: mv.x, y: mv.y };
}

const turnBefore = last('turn')?.gameTurn ?? 0;
const usedBefore = frames.filter((f) => f.t === 'used').length;
const apBefore = last('resource')?.resource?.ap;

/**
 * TWO CHEAP TALENTS, BACK TO BACK, WITH NO COMMIT BETWEEN THEM.
 *
 * AIMED AROUND THE RING, not at a remembered tile. The board here is rebuilt
 * from deltas and the husk takes its step inside a `sweep`, so a single tracked
 * coordinate is reliably one square stale — and the server answers
 * `illegal_move`, which maps from `NoTarget` among five refusals and looks
 * exactly like a broken talent. A player does not have this problem; they click
 * the husk they can see.
 */
const RING = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [0, 0],
];
// TWO DIFFERENT TALENTS. The first version cast the cheapest one twice and the
// second was refused `on_cooldown` — Ward Rush has one, and `hasAffordableAction`
// is right to say the round can continue while Crude Blow is still ready. The
// chain the plan describes is Ward Rush (2) then Crude Blow (3), which is 5 of 6.
for (const t of cheap.slice(0, 2)) {
  if (t === undefined) break;
  const before = frames.filter((f) => f.t === 'used').length;
  for (const [dx, dy] of RING) {
    send({ t: 'talent', talentId: t.id, target: { x: pos.x + dx, y: pos.y + dy } });
    await sleep(180);
    if (frames.filter((f) => f.t === 'used').length > before) break;
  }
}
await sleep(500);

const turnAfter = last('turn')?.gameTurn ?? 0;
const usedAfter = frames.filter((f) => f.t === 'used').length;
const apMid = last('resource')?.resource?.ap;

console.log(`\ncasts landed: ${usedAfter - usedBefore}`);
console.log(`game turns advanced: ${turnAfter - turnBefore}`);
console.log(`AP: ${apBefore} -> ${apMid}`);
/**
 * ═══ ZERO CASTS IS NOT A VERDICT, AND THIS PRINTED ONE ═══
 * "CLOSED" was reported for a run in which nothing was ever cast — the same
 * vacuous green a probe gives whenever the thing it measures did not happen.
 * The three outcomes are now distinct, and the middle one is the honest answer
 * when the setup failed rather than the feature.
 */
console.log(
  usedAfter - usedBefore === 0
    ? '  INCONCLUSIVE: nothing was cast at all — see the errors below.'
    : usedAfter - usedBefore >= 2 && turnAfter - turnBefore <= 1
      ? '  OPEN ROUND: two casts inside one turn.'
      : '  CLOSED: each cast still cost a whole turn.',
);
const errs = frames.filter((f) => f.t === 'error').map((f) => f.message);
if (errs.length) console.log('errors:', errs.slice(0, 3).join(' | '));
ws.close();
server.kill();
await sleep(150);
