// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO FRIENDS LOG IN. CAN THEY FIND EACH OTHER?  `node tools/two-on-the-moor.mjs`
// ═══════════════════════════════════════════════════════════════════════════
//
// This game is built for three to six friends on a SHARED overworld, and nearly
// everything measured so far has been one party inside an instance —
// `first-session`, `first-levelup` and `first-death` drive one socket, and
// `first-rescue` drives two but takes them straight into a delve.
//
// The moor is the only place the game is an MMO rather than a co-op roguelike,
// and nobody has ever looked at it from two sockets at once. So this asks the
// questions a pair of friends ask in the first minute:
//
//   - does A see B at all, and as a PERSON rather than as something to kill?
//   - does the party pane say where B is, or only how healthy?
//   - how far apart do two people who joined together start?
//   - can they both move, or does the barrier make walking together miserable?
//   - and when one of them does something, does the other hear about it?
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
import { COMMAND_GAP_MS, PROTOCOL_VERSION } from '../src/shared/version.ts';

const PORT = process.argv[2] ?? '31981';
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
  send({ t: 'hello' });
  await sleep(900);
  const id = frames.find((f) => f.t === 'welcome')?.selfId;
  const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
  send({ t: 'choose_class', classId: opts[0].id });
  await sleep(700);

  const latest = (type) => frames.filter((f) => f.t === type).at(-1);
  const log = () =>
    frames.filter((f) => f.t === 'log').flatMap((f) => (f.lines ?? []).map((l) => l.text));
  return { label, ws, id, frames, send, latest, log, className: opts[0].name };
}

const a = await join('A');
const b = await join('B');
await sleep(900);

beat('TWO PEOPLE JOIN THE SAME MOOR');
console.log(`  A is ${a.className}, B is ${b.className}`);
console.log(`  A's realm: ${String(a.latest('realm')?.name)} [${String(a.latest('realm')?.kind)}]`);
console.log(`  B's realm: ${String(b.latest('realm')?.name)} [${String(b.latest('realm')?.kind)}]`);

// ── 1. DOES A SEE B AT ALL? ────────────────────────────────────────────────
// `realm.actors` is the arrival snapshot; `state` is the resync. Both are
// checked, because seeing somebody once and losing them is a different bug from
// never seeing them.
const seenBy = (viewer, otherId) => {
  const inRealm = (viewer.latest('realm')?.actors ?? []).find((x) => x.id === otherId);
  const inState = (viewer.latest('state')?.actors ?? []).find((x) => x.id === otherId);
  return inState ?? inRealm;
};

beat('DOES A SEE B?');
const bAsSeenByA = seenBy(a, b.id);
const aAsSeenByB = seenBy(b, a.id);
console.log(`  A sees B: ${bAsSeenByA === undefined ? 'NO' : JSON.stringify(bAsSeenByA)}`);
console.log(`  B sees A: ${aAsSeenByB === undefined ? 'NO' : JSON.stringify(aAsSeenByB)}`);

const mine = (viewer) => (viewer.latest('realm')?.actors ?? []).find((x) => x.id === viewer.id);
const aPos = mine(a);
const bPos = mine(b);
if (aPos !== undefined && bPos !== undefined) {
  console.log(
    `  they start ${String(Math.max(Math.abs(aPos.x - bPos.x), Math.abs(aPos.y - bPos.y)))} tiles apart` +
      ` (A at ${String(aPos.x)},${String(aPos.y)}  B at ${String(bPos.x)},${String(bPos.y)})`,
  );
}

// ── 2. WHAT DOES THE PARTY PANE SAY? ───────────────────────────────────────
// Before a party is formed, and after — because a solo player is a party of one
// and the pane is the surface a group actually reads.
beat('THE PARTY PANE, BEFORE ANY INVITE');
const paneOf = (v) => (v.latest('party_state')?.members ?? []).map((m) => Object.keys(m).join(','));
console.log(`  A's pane rows: ${String((a.latest('party_state')?.members ?? []).length)}`);
console.log(`  fields on a row: ${paneOf(a)[0] ?? '(no rows)'}`);

a.send({ t: 'party', action: 'invite', targetId: b.id });
await sleep(500);
b.send({ t: 'party', action: 'accept', targetId: a.id });
await sleep(900);

beat('AND AFTER THEY PARTY UP');
const rows = a.latest('party_state')?.members ?? [];
console.log(`  A's pane rows: ${String(rows.length)}`);
for (const m of rows) {
  console.log(
    `    ${String(m.name).padEnd(10)} hp ${String(m.hp)}/${String(m.maxHp)}` +
      `  position: ${m.x === undefined && m.y === undefined ? 'NOT SENT' : `${String(m.x)},${String(m.y)}`}`,
  );
}

// ── 3. CAN THEY BOTH MOVE? ─────────────────────────────────────────────────
// With two players the turn does not turn over until both have answered, so
// "can they walk together" is a real question rather than a formality.
beat('DO THEY BOTH GET TO MOVE?');
const movesOf = (v) => v.frames.filter((f) => f.t === 'moved' && f.id === v.id).length;
const beforeA = movesOf(a);
const beforeB = movesOf(b);
for (let i = 0; i < 12; i += 1) {
  a.send({ t: 'move', dir: 'e' });
  b.send({ t: 'move', dir: 'e' });
  await sleep(120);
}
console.log(`  A moved ${String(movesOf(a) - beforeA)} of 12 asked`);
console.log(`  B moved ${String(movesOf(b) - beforeB)} of 12 asked`);

// ── 4. DOES EITHER HEAR ABOUT THE OTHER? ───────────────────────────────────
beat('WHAT EACH HEARD ABOUT THE OTHER');
const mentions = (viewer, otherName) =>
  viewer.log().filter((line) => String(line).includes(otherName));
console.log(`  A's log mentioning B: ${JSON.stringify(mentions(a, 'Player 2').slice(-4))}`);
console.log(`  B's log mentioning A: ${JSON.stringify(mentions(b, 'Player 1').slice(-4))}`);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE ONE LINE THAT MAKES THE MOOR FEEL INHABITED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `gateway.ts` broadcasts a clear to the OVERWORLD and calls it "the only sign
 * that anybody else is playing" — an instance is private by construction, so
 * without this line five friends are five single-player games in one window.
 * It is the most load-bearing social feature in the game and nothing has ever
 * checked that it reaches a socket, so: B goes and clears something while A
 * stands on the moor doing nothing, and we read A's log.
 *
 * ═══ WHY THIS NEEDS A PATHFINDER AND NOT A DIRECTION ═══
 *
 * The first version of this section stepped one axis at a time toward the
 * target and read its own position out of `realm.actors`. Both are wrong, and
 * together they deadlock:
 *
 *   `realm.actors` IS THE ARRIVAL SNAPSHOT. It is sent when you enter a realm
 *   and never again, so a driver that re-reads it after moving computes every
 *   subsequent step from the tile it started on. Live position is on the
 *   `moved` lane — except right after a realm change, when the newest `moved`
 *   frame belongs to the realm you just left, which is why `posOf` compares the
 *   two by recency rather than preferring one.
 *
 *   ONE AXIS AT A TIME WALKS INTO WATER AND STAYS THERE. The moor is 425 tiles
 *   of frozen sea and a mountain range; "east until aligned" hits something
 *   solid within a few steps, the move is refused, and the next iteration
 *   computes the identical direction. Measured: 3 moves accepted out of 400
 *   asked, with 15 roamers visible the whole time.
 *
 * `firstStep` is the same breadth-first search `first-death` and `first-rescue`
 * use, and it is here rather than imported because tools/ is deliberately flat
 * .mjs — `fightlib` exists for what a driver gets WRONG, not for what three
 * drivers happen to share.
 */
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
      // The destination itself may be solid — a site tile you step ONTO.
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

/** Where a viewer actually is: the newest of its `moved` lane and its arrival snapshot. */
function posOf(v) {
  let realmAt = -1;
  let movedAt = -1;
  for (let i = v.frames.length - 1; i >= 0 && realmAt < 0; i -= 1) {
    if (v.frames[i].t === 'realm') realmAt = i;
  }
  for (let i = v.frames.length - 1; i > realmAt; i -= 1) {
    if (v.frames[i].t === 'moved' && v.frames[i].id === v.id) {
      movedAt = i;
      break;
    }
  }
  if (movedAt > realmAt) return { x: v.frames[movedAt].x, y: v.frames[movedAt].y };
  return (v.latest('realm')?.actors ?? []).find((x) => x.id === v.id);
}

/**
 * Live actors, which `realm.actors` is not.
 *
 * The arrival snapshot froze the FOE side too: the first working version of
 * this section swung 400 times at monsters that were already dead, at the tiles
 * they stood on when B walked in. Monster movement rides the `sweep` lane, not
 * `moved`, and a death is an event rather than a field going false.
 */
function makeTracker(v) {
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
    for (; seen < v.frames.length; seen += 1) {
      const f = v.frames[seen];
      // A new realm is a new cast. Rebuilding is what makes a floor change safe.
      if (f.t === 'realm') {
        at.clear();
        for (const x of f.actors ?? []) {
          at.set(x.id, {
            x: x.x,
            y: x.y,
            alive: x.alive !== false,
            name: x.name,
            kind: x.kind,
            seen: true,
          });
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * `left` IS NOT DEATH. IT IS PER-PLAYER FOV, AND THIS DELETED THE BODY.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `reconcileSight` sends `left` when a body leaves the viewer's sight, and
       * this tracker forgot it entirely — so a husk that stepped round a corner
       * vanished from the cast, the search below found no foe, and the probe
       * printed "CLEARED the floor" about a room it had merely lost track of.
       * Measured: "B took 0 turns and CLEARED the floor", on arrival, before it
       * had swung at anything.
       *
       * It is kept and marked UNSEEN instead, so "nothing I can see" and
       * "nothing left alive" stay different questions — which is the whole
       * distinction FOV introduced and this file predates.
       */
      if (f.t === 'left') {
        const gone = at.get(f.id);
        if (gone !== undefined) gone.seen = false;
      }
      if (f.t === 'joined' && f.actor !== undefined) {
        at.set(f.actor.id, {
          x: f.actor.x,
          y: f.actor.y,
          alive: f.actor.alive !== false,
          name: f.actor.name,
          kind: f.actor.kind,
          seen: true,
        });
      }
    }
    return at;
  };
}

/**
 * The walkable tile furthest from `from`, by straight-line distance.
 *
 * A SEARCH TARGET THAT EXISTS. See its caller for the version that did not.
 */
function furthestWalkable(level, from) {
  let best = null;
  let far = -1;
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      if (!isWalkable(level.tiles[y * level.w + x])) continue;
      const d = (x - from.x) ** 2 + (y - from.y) ** 2;
      if (d > far) {
        far = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** @returns true when the engine ACCEPTED the step, so a refusal ends the walk. */
async function stepTo(v, target) {
  const lvl = v.latest('realm')?.level;
  const me = posOf(v);
  if (lvl === undefined || me === undefined) return false;
  if (me.x === target.x && me.y === target.y) return false;
  const dir = firstStep(lvl, me, target);
  if (dir === null) return false;
  const before = v.frames.filter((f) => f.t === 'moved' && f.id === v.id).length;
  v.send({ t: 'move', dir });
  await sleep(COMMAND_GAP_MS);
  return v.frames.filter((f) => f.t === 'moved' && f.id === v.id).length > before;
}

beat('B GOES OFF TO CLEAR SOMETHING, WHILE A STANDS ON THE MOOR');
const aLogBefore = a.log().length;
const aRealmBefore = a.latest('realm')?.name;

// A FIXED site, not a roamer: roamers walk, and chasing one measures the chase.
// Quiet/restless only — solo runs wipe 0/8 on grim and dangerous, and a probe
// that dies before it clears anything measures nothing about the broadcast.
const bHere = posOf(b);
const SOLOABLE = new Set(['quiet', 'restless']);
const target = (b.latest('sites')?.sites ?? [])
  .filter((s) => !s.sprite && SOLOABLE.has(s.danger))
  .map((s) => ({ s, d: Math.max(Math.abs(s.x - bHere.x), Math.abs(s.y - bHere.y)) }))
  .sort((p, q) => p.d - q.d)[0];

if (target === undefined) {
  console.log('  no quiet or restless site in sight — nothing B can clear alone');
} else {
  console.log(
    `  B sets off for ${String(target.s.name)} (${String(target.s.danger)}), ` +
      `${String(target.d)} tiles away`,
  );
  let walked = 0;
  for (let i = 0; i < 400 && b.latest('realm')?.kind === 'overworld'; i += 1) {
    if (!(await stepTo(b, { x: target.s.x, y: target.s.y }))) break;
    walked += 1;
  }
  console.log(
    `  B walked ${String(walked)} tiles and is now in: ` +
      `${String(b.latest('realm')?.name)} [${String(b.latest('realm')?.kind)}]`,
  );

  // Did A get dragged along? A party member entering is not supposed to move
  // anybody else, and if it does then the broadcast question is moot.
  console.log(
    `  meanwhile A is in: ${String(a.latest('realm')?.name)}` +
      `${a.latest('realm')?.name === aRealmBefore ? ' (unmoved, correct)' : ' — A WAS DRAGGED IN'}`,
  );

  // …and bumps whatever is in there until nothing is left standing.
  const track = makeTracker(b);
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * "CLEARED" IS THE SERVER'S WORD, NOT THIS FILE'S GUESS.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `shouldAnnounceCleared` (world/cleared.ts) will not fire until a monster
   * kill has been SEEN, and it prints `Filed. N of M.` — so it cannot be true of
   * a room nobody has fought in. This file inferred it from an empty cast list,
   * which per-player FOV turned into a lie: see the `left` note in the tracker.
   */
  const sawCleared = () => b.log().some((line) => /^Filed[.] |is quiet now/.test(line));
  let bumps = 0;
  let cleared = false;
  let blind = 0;
  let sweepTo = null;
  for (let i = 0; i < 400; i += 1) {
    const at = track();
    const me = posOf(b);
    if (me === undefined) break;
    // A foe on your own tile is not a foe you can swing at.
    const foes = [...at.entries()]
      .filter(([id, e]) => id !== b.id && e.alive && e.kind !== 'player')
      .map(([, e]) => ({ e, d: Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) }))
      .filter((c) => c.d > 0)
      .sort((p, q) => p.d - q.d);
    // WHAT IS IN SIGHT FIRST, then whatever is merely REMEMBERED — walking to a
    // body's last known tile is how you find it again, and it is what this
    // probe used to do by accident before `left` deleted the entry.
    const foe = foes.find((c) => c.e.seen !== false) ?? foes[0];
    if (foe === undefined) {
      // NOTHING KNOWN AT ALL. Either the room really is done — ask the server —
      // or nothing has come into sight yet, in which case walking is the answer
      // and declaring victory is not.
      if (sawCleared()) {
        cleared = true;
        break;
      }
      blind += 1;
      if (blind > 120) break;
      /**
       * SWEEP THE ROOM, and it has to be a REAL target. The first version of
       * this walked to `(x + 7) % w, (y + 5) % h`, which is a tile chosen by
       * arithmetic rather than by the map: mostly a wall, sometimes off the
       * walkable region entirely, so `firstStep` answered null and B stood
       * perfectly still for sixty turns while reporting that it was searching.
       *
       * THE FURTHEST WALKABLE TILE is a real sweep, and it matters here more
       * than it looks: monsters in this engine do not move at all until
       * somebody walks into an aggro radius with line of sight
       * (`actMonster`'s own note), so a probe that does not cross the room
       * never meets anything and cannot tell an empty floor from a shy one.
       */
      const lvl = b.latest('realm')?.level;
      if (lvl !== undefined) {
        if (sweepTo === null || (me.x === sweepTo.x && me.y === sweepTo.y)) {
          sweepTo = furthestWalkable(lvl, me);
        }
        if (sweepTo !== null && !(await stepTo(b, sweepTo))) sweepTo = null;
      }
      await sleep(COMMAND_GAP_MS);
      continue;
    }
    if (foe.d <= 1) {
      // Adjacent: the move IS the attack, and it is refused-looking either way.
      const dir = firstStep(b.latest('realm').level, me, { x: foe.e.x, y: foe.e.y });
      if (dir !== null) b.send({ t: 'move', dir });
      await sleep(COMMAND_GAP_MS);
    } else if (!(await stepTo(b, { x: foe.e.x, y: foe.e.y }))) {
      await sleep(COMMAND_GAP_MS);
    }
    bumps += 1;
  }
  console.log(
    `  B took ${String(bumps)} turns and ` +
      `${cleared ? 'the server filed the room' : 'never got a filed line'}` +
      `${blind > 0 ? ` (${String(blind)} turns with nothing in sight)` : ''}`,
  );
  console.log(`  B's last lines: ${JSON.stringify(b.log().slice(-3))}`);
  /**
   * DID THE ROOM TELL HIM IT WAS BUILT FOR TWO?
   *
   * `crossIntoRealm` sizes a delve from the party ROSTER, not from who walks in,
   * so B — partied with A, entering alone — gets a room scaled for two. The line
   * that says so arrives with the room's blurb, long before these last three
   * lines, which is why printing only the tail hid it and nearly had it recorded
   * as not firing at all.
   */
  const warned = b.log().filter((line) => String(line).startsWith('Built for'));
  console.log(`  was he told the room is party-sized? ${warned[0] ?? 'NO — nothing said'}`);
}
await sleep(1500);

const heard = a.log().slice(aLogBefore);
const social = heard.filter((l) => /quiet now|cleared|clears|Player 2/.test(String(l)));
console.log(`\n  A heard ${String(heard.length)} new line(s) while standing still`);
console.log(
  `  of which about B: ${social.length === 0 ? 'NOTHING' : JSON.stringify(social.slice(-4))}`,
);

a.ws.close();
b.ws.close();
server.kill();
process.exit(0);
