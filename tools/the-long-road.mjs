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
import { bestShot, loadoutBuffs, loadoutStrikes } from './fightlib.mjs';
import { STANDING_LEVEL } from '../src/server/content/townsfolk.ts';
import { helloAndChoose } from './handshake.mjs';
// THE SERVER'S OWN NUMBER, NEVER A LITERAL. These tools hardcoded `v: 18`
// and could not connect at all from the day PROTOCOL_VERSION became 19 — the
// handshake was refused with `version_mismatch` and the fixed sleep after it
// turned that into "Cannot read properties of undefined". Eight gameplay
// verification tools were dead and silent about it.
import { PROTOCOL_VERSION } from '../src/shared/version.ts';

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
const send = (o) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...o }));
const latest = (t) => frames.filter((f) => f.t === t).at(-1);
const logLines = () =>
  frames.filter((f) => f.t === 'log').flatMap((f) => (f.lines ?? []).map((l) => String(l.text)));

// WAIT FOR THE FRAMES, NOT FOR THE CLOCK. See tools/handshake.mjs — a fixed
// 900ms here is a bet on how fast a cold server boots, and it loses on any
// machine that is also running a build.
const { selfId, chosen } = await helloAndChoose(send, frames);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SPENDING A TALENT OVER A SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fightlib` owns which attack to try and in what order — the 1.5 trap and the
 * cooldown fall-through — and this owns the only part that is actually about the
 * wire: whether the server took it.
 *
 * ACCEPTANCE IS THE ABSENCE OF A REFUSAL. There is no "ok" frame for a talent;
 * `turn-engine.ts` answers a bad one with a specific `ErrorCode` and a good one
 * with the results of the act. So the attempt is: count the error frames, send,
 * wait a beat, count again. A driver that assumed every send landed would report
 * a character firing forty shots that were all refused for one reason.
 *
 * COOLDOWNS ARE FILTERED FIRST, from the frame that exists to say so — anything
 * in `loadout` that is NOT named in `cooldowns` is ready. That is cheaper than
 * discovering it by refusal, and `bestShot` still falls through if the server
 * disagrees, which it is entitled to do.
 */
const coolingNow = () => new Set(Object.keys(latest('cooldowns')?.cooldowns ?? {}));

async function fireAt(talentId, target) {
  const before = frames.filter((f) => f.t === 'error').length;
  send({ t: 'talent', talentId, target });
  await sleep(90);
  return frames.filter((f) => f.t === 'error').length === before;
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
  /**
   * ONLY INSIDE A SETTLEMENT. On the overworld "the first actor that is not a
   * player" is a ROAMER, and the first version of this asked an Index Wraith
   * about rumours, got `bad_message: there is nobody there to talk to`, and then
   * counted that refusal as the answer having CHANGED — a green result for a
   * conversation that never happened.
   */
  // A SETTLEMENT, and nothing else. `!== 'overworld'` was not enough: crossing
  // the moor at level 5 walks into roamers, an ambush is an `inner` realm too,
  // and the first version of this guard let the probe ask an Index Cairn about
  // rumours. Townsfolk live in `common` realms and only there.
  if (latest('realm')?.kind !== 'common') return { name: null, said: [], answered: [] };
  const track = makeTracker();
  const person = (latest('realm')?.actors ?? []).find(
    (a) => a.id !== selfId && a.kind !== 'player',
  );
  if (person === undefined) return { name: null, said: [], answered: [] };
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
  // A REFUSAL IS NOT AN ANSWER. Recorded so the transcript stays honest, then
  // excluded from the comparison: "she said something different" and "the server
  // said no" are opposite outcomes and must never collapse into one.
  const answered = said.filter((l) => !l.startsWith('REFUSED('));
  return { name: String(person.name), said, answered };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIGHT WHATEVER IS IN HERE UNTIL NOTHING IS STANDING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One function because there are two rooms worth fighting in and they are the
 * same fight: the delve you walked into on purpose, and the ambush that opened
 * under you on the way to town. The second used to end the run — the walk
 * assumed it would arrive, arrived in an arena instead, and the probe asked an
 * Index Cairn about local rumours.
 *
 * A BUFF, THEN THE BEST STRIKE, THEN A BUMP. `fightlib` owns which strike and in
 * what order; this owns only the turn.
 */
async function fightRoom() {
  const track = makeTracker();
  for (let i = 0; i < 500; i += 1) {
    const at = track();
    const mine = posOf();
    if (mine === undefined) break;
    const standing = [...at.entries()]
      .filter(([id, e]) => id !== selfId && e.alive && e.kind !== 'player')
      .map(([, e]) => ({ e, d: gap(e, mine) }))
      .filter((c) => c.d > 0)
      .sort((p, q) => p.d - q.d);
    const foe = standing[0];
    if (foe === undefined) break;

    const cooling = coolingNow();
    // A BUFF FIRST WHEN ONE IS UP: it costs the turn a bump would have cost, and
    // a character that never spends them is playing with part of its kit off.
    const buff = buffs.find((b) => !cooling.has(b.id));
    if (buff !== undefined && (await fireAt(buff.id, undefined))) {
      shots += 1;
      continue;
    }
    // AND AT WHOEVER IS REACHABLE RATHER THAN WHOEVER IS NEAREST.
    const shot = await bestShot(
      attacks.filter((a) => !cooling.has(a.id)),
      mine,
      standing.map((c) => c.e),
      fireAt,
    );
    if (shot.fired) {
      shots += 1;
      continue;
    }

    if (foe.d <= 1) {
      const dir = firstStep(latest('realm').level, mine, { x: foe.e.x, y: foe.e.y });
      if (dir !== null) send({ t: 'move', dir });
      await sleep(45);
    } else if (!(await stepTo({ x: foe.e.x, y: foe.e.y }))) {
      await sleep(45);
    }
  }
}

/**
 * Walk to the town, FIGHTING THROUGH WHATEVER STOPS YOU.
 *
 * At level 5 the moor is thick with roamers and stepping onto one opens an
 * ambush arena — an `inner` realm — so a walk that assumed it would arrive
 * arrived somewhere else. This clears what it is thrown into, leaves, and keeps
 * going, which is what the walk actually costs a player.
 */
/**
 * Walk to a cell on the overworld, FIGHTING THROUGH WHATEVER OPENS UNDERNEATH.
 *
 * At level 5 the moor is thick with roamers, and stepping onto one opens an
 * ambush arena — an `inner` realm — so a walk that assumed it would arrive
 * arrived somewhere else instead. This clears what it is thrown into, leaves,
 * and carries on, which is what the walk actually costs a player.
 *
 * @returns the realm kind it ended in, so the caller can tell "I am there" from
 *   "I stopped short" rather than inferring it from a position.
 */
async function travelTo(target, arriveInner = false) {
  for (let leg = 0; leg < 8; leg += 1) {
    for (let i = 0; i < 900 && latest('realm')?.kind === 'overworld'; i += 1) {
      if (!(await stepTo(target))) break;
    }
    await sleep(500);
    const kind = latest('realm')?.kind;
    // AN AMBUSH AND A DOORWAY ARE THE SAME `inner`, AND THE CALLER KNOWS WHICH
    // IT WANTED. Without `arriveInner` this walked to a delve entrance, called
    // arriving there an ambush, cleared the room and left — then reported the
    // Redaction's first door as holding nobody, which is exactly what a room you
    // have just emptied and walked out of looks like.
    if (kind !== 'inner') return kind;
    if (arriveInner) return kind;
    const door = posOf();
    await fightRoom();
    await leaveVia(door);
  }
  return latest('realm')?.kind;
}

async function visitTown() {
  return (await travelTo({ x: town.s.x, y: town.s.y })) === 'common' ? posOf() : null;
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

/**
 * THE FIGHTING KIT, HOISTED ABOVE THE FIRST TOWN VISIT.
 *
 * `fightRoom` closes over these and the walk to town can call it — an ambush
 * opens on the way — so declaring them after that walk is a temporal dead zone
 * waiting for the first roamer to step on the probe.
 */
const filed = new Set();
let cleared = 0;
let died = false;
let shots = 0;
const attacks = loadoutStrikes(latest('loadout')?.talents ?? []);
const buffs = loadoutBuffs(latest('loadout')?.talents ?? []);

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
/**
 * WHAT A CHARACTER OF THIS LEVEL WOULD ACTUALLY WALK INTO.
 *
 * The gentle floors run out. There are four graded quiet-or-restless rooms on the
 * moor, and a cleared one stays cleared until `INSTANCE_LINGER_MS` reaps it five
 * minutes later — so a driver that only ever takes those stalls at level 3 with
 * nothing left to do, which is a fact about the probe's shopping list rather than
 * about whether standing is reachable. A real player levels and then takes on
 * harder rooms, so this does too.
 */
const gradesFor = (level) =>
  level >= 3 ? new Set(['quiet', 'restless', 'dangerous']) : new Set(['quiet', 'restless']);

/**
 * GRIM IS NEVER ON THE LIST, and that is a measurement decision rather than
 * cowardice. `partyHint` publishes *"bring a party"* beside every grim marker
 * and `delve-run.mjs` measured a solo character at 0 of 8 on them. A run that
 * walks into one is measuring the warning being correct, which is known — it
 * killed this driver at level 4 on Blackwood Outskirts, sixty-four experience
 * short of the answer.
 */
console.log(
  `  fighting as ${String(chosen.name)} with ${String(attacks.length)} strike(s) and ` +
    `${String(buffs.length)} buff(s): ` +
    (attacks.map((a) => `${a.id.replace('talent:', '')}@${String(a.range)}`).join(', ') || 'none'),
);

for (let trip = 0; trip < 20 && levelNow() < STANDING_LEVEL && !died; trip += 1) {
  const me = posOf();
  if (me === undefined) break;
  const target = (latest('sites')?.sites ?? [])
    .filter(
      (s) =>
        s.sprite === undefined && gradesFor(levelNow()).has(String(s.danger)) && !filed.has(s.name),
    )
    .map((s) => ({ s, d: gap(s, me) }))
    .sort((a, b) => a.d - b.d)[0];
  if (target === undefined && filed.size > 0) {
    /**
     * NOTHING LEFT THAT HAS NOT BEEN FILED — so go round again. A cleared
     * instance is handed back cleared until `INSTANCE_LINGER_MS` reaps it five
     * minutes later, at which point the room is re-seeded and worth the walk. A
     * re-entered floor that is still empty costs one wasted trip and no damage.
     */
    console.log(`  filed everything reachable; going round again at +${secs()}s`);
    filed.clear();
    continue;
  }
  if (target === undefined) {
    console.log('  nothing on the map this character will take on. What it offers:');
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

  await fightRoom();
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
const doorB = await visitTown();
const after = await ask('rumour');
console.log(`  ${String(after.name)}: ${after.said.join(' / ') || 'NOTHING'}`);

beat('WHAT A SOLO PLAYER ACTUALLY GETS');
console.log(`  delves filed          : ${String(cleared)}`);
console.log(`  talents actually fired: ${String(shots)}`);
console.log(`  level reached         : ${String(levelNow())} of ${String(STANDING_LEVEL)} needed`);
console.log(`  died on the way       : ${died ? 'YES' : 'no'}`);
console.log(`  time                  : ${secs()}s`);
const bothHeard = before.answered.length > 0 && after.answered.length > 0;
const opened = bothHeard && before.answered.join(' ') !== after.answered.join(' ');
console.log(`  asked somebody twice  : ${bothHeard ? 'yes' : 'NO — the comparison is void'}`);
console.log(`  the rumour changed    : ${opened ? 'YES' : 'no'}`);
if (bothHeard && !opened && levelNow() < STANDING_LEVEL) {
  console.log('  (and it should not have — the character never reached standing)');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEN GO WHERE THE SENTENCE POINTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every measurement this repo has ever taken was on Alderbrook's moor. The
 * Redaction is a second overworld with its own delves and two creatures nothing
 * else in the game has, and no probe has ever set foot on it — so "the rumour
 * opens the channel" is only half an answer while the far side is unverified.
 *
 * The door is an ordinary `SiteDef` with `kind: Overworld` and no level gate of
 * its own; the gate is on the DIRECTIONS, which is why this section runs after
 * the character has earned them.
 */
if (levelNow() >= STANDING_LEVEL) {
  /**
   * OUT OF THE TOWN BEFORE READING THE MAP, AND OUT VIA THE DOOR IT CAME IN BY.
   *
   * `sites` is realm-scoped: standing in Alderbrook it holds Alderbrook's one
   * marker, so the moor's doors are not in it and the first version reported
   * that the Redaction was not on the map at all. The second version leaked the
   * same result for a different reason — it passed `posOf()` to `leaveVia`,
   * which wants the ARRIVAL tile and got "wherever the conversation finished",
   * so it never left. `visitTown` already returns the doorstep; use it.
   */
  await leaveVia(doorB);
  const doorSite = (latest('sites')?.sites ?? []).find((x) => String(x.name) === 'The Redaction');
  console.log(
    `  standing in ${String(latest('realm')?.name)} [${String(latest('realm')?.kind)}] with ` +
      `${String((latest('sites')?.sites ?? []).length)} sites in view: ` +
      (latest('sites')?.sites ?? []).map((x) => String(x.name)).join(', '),
  );
  beat(
    `WEST OF THE SEDGE — walking to ${doorSite === undefined ? '(no door on the map)' : `${String(doorSite.x)},${String(doorSite.y)}`}`,
  );
  if (doorSite !== undefined) {
    const landed = await travelTo({ x: doorSite.x, y: doorSite.y });
    const there = latest('realm');
    console.log(`  arrived in : ${String(there?.name)} [${String(landed)}]`);
    if (there !== undefined && String(there.name) !== 'The Alderbrook Moor') {
      console.log(`  the map    : ${String(there.level?.w)}x${String(there.level?.h)} tiles`);
      const over = latest('sites')?.sites ?? [];
      console.log(`  sites frame after the crossing: ${String(over.length)}`);
      for (const x of over) {
        console.log(
          `    ${String(x.name).padEnd(26)} marker=${String(x.marker).padEnd(8)}` +
            ` danger=${String(x.danger).padEnd(10)} landmark=${String(x.landmark)}`,
        );
      }
      // And into the first door over there, to see whether anything lives in it.
      const first = over
        .filter((x) => x.sprite === undefined && String(x.danger) !== 'undefined')
        .map((x) => ({ x, d: gap(x, posOf()) }))
        .sort((a, b) => a.d - b.d)[0];
      if (first === undefined) {
        console.log('  NOTHING GRADED TO WALK INTO over there');
      } else {
        console.log(`  walking into ${String(first.x.name)} (${String(first.x.danger)})`);
        const kind = await travelTo({ x: first.x.x, y: first.x.y }, true);
        const room = latest('realm');
        console.log(`  inside     : ${String(room?.name)} [${String(kind)}]`);
        const living = (room?.actors ?? []).filter((a) => a.id !== selfId && a.kind !== 'player');
        const names = [...new Set(living.map((a) => String(a.name)))];
        console.log(
          `  it holds   : ${String(living.length)} bodies — ${names.join(', ') || 'NOBODY'}`,
        );
      }
    }
  }
}

ws.close();
server.kill();
process.exit(0);
