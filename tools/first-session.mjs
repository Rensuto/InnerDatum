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
 * IT DRIVES THE FIGHT TO A CONCLUSION NOW, and this paragraph used to say it
 * could not — *"it reaches the enemy, trades a blow, and then stops making
 * progress."* That stopped being true and the warning stayed, which is worse
 * than never having written it: it tells the next person not to trust the one
 * instrument that would have shown them the answer.
 *
 * `first-fight.mjs` is still the trustworthy instrument for BALANCE — it drives
 * the engine directly with no protocol or latency in the way. This one is for
 * the SESSION, and it now walks the whole of it: join, class, fight, loot, put
 * the loot on, walk back out, cross to a town, meet somebody, ask all four
 * topics, walk on to a shop, and buy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SHAPE IT READS OFF THE WIRE HAS BEEN WRONG AT LEAST ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 * Recorded because each one produced a confident, false finding that survived
 * until the SETUP was asserted rather than the result:
 *
 *   `realm.spawns`     -> the wire has no such field. The way out is a SITE
 *                         MARKER named "The way out". Reported a player who
 *                         never left the room.
 *   "a town has no creature sprite" -> so does every delve. Walked a level-1
 *                         character into the Drowned Chapel to meet a wraith.
 *                         A town is `marker` in {city, town, village}.
 *   `t: 'hotbar'`      -> the frame is `t: 'loadout'` and carries `talents`.
 *                         Reported an empty hotbar for a class that has four.
 *   `item.price/.id`   -> `ShopItemView` is `buy`/`itemId`. Reported "15 gold
 *                         buys 0 of 4" when it buys all four.
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MONSTERS MOVE INSIDE THE SWEEP, AND THIS ONLY EVER READ THE OTHER LANE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The gateway is explicit: a monster turn is "ONE frame for the whole monster
   * turn. Never one per monster" — a `sweep` carrying a `TurnEvent[]`. Top-level
   * `moved` frames are the immediate lane, which is mostly YOUR OWN steps.
   *
   * So every monster sat frozen at the coordinate its `enter` frame gave it, for
   * the entire fight. That is the whole of the "monster standing on the player's
   * tile" I nearly filed as a server bug and a retention disaster: the Eidolon
   * had walked off that square long before, the player walked onto it, and this
   * tracker never heard about either step. No two actors ever shared a tile.
   *
   * A tool that silently freezes half the world reports the world as broken. The
   * sweep is unpacked here so that stops being true.
   */
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
      if (f.t === 'sweep') {
        for (const ev of f.events ?? []) {
          if (ev.k === 'move') step(ev.id, ev.x, ev.y);
          if (ev.k === 'death') {
            const e = at.get(ev.id);
            if (e) e.alive = false;
          }
        }
      }
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WAIT FOR THE ROOM TO ARRIVE BEFORE DECIDING IT IS EMPTY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The loop below breaks the instant it sees no living foe, and on entering a
   * delve it saw exactly that: the descent frame lands first and the entities
   * follow a beat later, so iteration zero found an empty room and left. The
   * proof it was a race and not an empty room is that the line above — printed
   * AFTER the loop — names an Index Husk and an Index Eidolon standing in it.
   *
   * This cost a real diagnosis. The fight reported `(nothing)`, I read that as
   * the driver meeting a kiter, and the monster it had supposedly failed to
   * catch turns out to be a MeleeChaser at preferredRange 1 — it would have
   * walked straight onto the sword. The instrument was broken, not the game.
   *
   * A DEADLINE, NOT A FIXED SLEEP: it leaves as soon as something is there, and
   * a genuinely empty room costs one second rather than hanging.
   */
  for (
    let i = 0;
    i < 20 && [...at.entries()].filter(([id, e]) => id !== selfId && e.alive).length === 0;
    i += 1
  ) {
    track();
    await sleep(50);
  }

  let rounds = 0;
  // How near it ever got. THE DISCRIMINATOR: a fight that logs nothing is a
  // pathing failure if this stays large and a combat failure if it reaches 1.
  let closest = 99;
  const frameMark = frames.length;
  // NAMED WHILE THEY ARE STILL STANDING. Reading the room after the fight lists
  // the survivors, which on a win is nobody -- the report said "nothing this
  // driver could see" about a fight it had just won 2-0.
  const metNames = new Set();
  // WHICH KIND OF STUCK. `noPath` is the pathfinder refusing to route at all;
  // `blocked` is a step that was routed and then went nowhere. They are
  // different bugs and the transcript used to show neither.
  let noPath = 0;
  let blocked = 0;
  for (let i = 0; i < 300; i += 1) {
    track();
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FOE ON YOUR OWN TILE IS NOT A FOE YOU CAN SWING AT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Measured, on the Bracken Waste: `Index Eidolon` sits at 8,14 and so does
     * the player. Every direction toward it is no direction at all — `firstStep`
     * correctly returns null when `from === to` — so the driver sent nothing,
     * three hundred times, while an `Index Husk` nine tiles north went
     * unfought. The transcript for that was one word: `(nothing)`.
     *
     * NEAREST IS NOT THE SAME AS REACHABLE, and this loop had quietly assumed
     * it was. Skipping the coincident entity makes it walk to the foe it can
     * actually hit, which is what the beat was always meant to measure.
     */
    const foes = [...at.entries()].filter(
      ([id, e]) => id !== selfId && e.alive && (e.x !== pos.x || e.y !== pos.y),
    );
    if (foes.length === 0) break;
    rounds += 1;
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
    for (const [, e] of foes) if (e.name !== undefined) metNames.add(e.name);
    const gap = Math.max(Math.abs(f0.x - pos.x), Math.abs(f0.y - pos.y));
    closest = Math.min(closest, gap);
    const adjacent = gap <= 1;
    if (adjacent) {
      const lvl = realmNow().level;
      const dir = firstStep(lvl, pos, { x: f0.x, y: f0.y });
      if (dir !== null) send({ t: 'move', dir });
      await sleep(45);
    } else {
      if (firstStep(realmNow().level, pos, { x: f0.x, y: f0.y }) === null) noPath += 1;
      if (!(await stepTo({ x: f0.x, y: f0.y }))) {
        blocked += 1;
        await sleep(45);
      }
    }
  }
  await sleep(900);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO IT MET, AND WHY THAT DECIDES WHETHER SILENCE IS A BUG.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This driver bump-attacks, and the header already says what that costs: a
   * class with a dead zone cannot do it. Without a name in the transcript that
   * reads exactly like "combat is broken", which is how a silent beat here sent
   * me after three inventions in a row — a dead-zone class, then a monster
   * kiting the bumper (it was a MeleeChaser at preferredRange 1), then a monster
   * standing on the player's own tile that I was ready to file as a server bug.
   *
   * ALL THREE WERE THIS TOOL. Monster movement arrives inside the `sweep` frame
   * and the tracker read only the immediate lane, so every monster was frozen at
   * the tile it was first seen on and the driver chased ghosts. Fixed above.
   *
   * So the line below names what it MET, how near it got and how it stalled —
   * because every wrong answer so far came from a transcript that said nothing
   * and an author happy to fill the silence.
   */
  console.log(
    `  in the room: ${metNames.size === 0 ? 'nothing this driver could see' : [...metNames].join(', ')}` +
      ` -- ${String(rounds)} round(s), closest approach ${String(closest)}` +
      (noPath > 0 || blocked > 0
        ? ` (no route ${String(noPath)}x, step refused ${String(blocked)}x)`
        : ''),
  );
  const tally = new Map();
  for (const f of frames.slice(frameMark)) tally.set(f.t, (tally.get(f.t) ?? 0) + 1);
  console.log(
    `  frames: ${[...tally]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, n]) => `${t}x${String(n)}`)
      .join(' ')}`,
  );
  beat('THE FIGHT');
  show(mark, 16);

  mark = log.length;
  /**
   * WALK TO WHAT DROPPED, THEN PICK IT UP.
   *
   * This used to press `pickup` six times from wherever the fight ended, and
   * `pickup` takes what is under YOUR feet — so it reported "(nothing)" for
   * every opening in which the corpse fell more than a step away, which is most
   * of them. That is a hole in the INSTRUMENT and it was actively misleading:
   * driven properly, twelve real kills out of twelve leave loot on the floor.
   *
   * The whole point of this tool is to print what a player experiences, so a
   * step it does not take is a line it gets wrong. `ground` frames carry the
   * tiles; walk to the first one and then take it.
   */
  // `cell` IS A PAIR, not an `x`/`y`. The first version of this read `.x` and
  // `.y`, got two undefineds, and walked nowhere — which is how a tool reports
  // "(nothing)" about a floor with a pair of trousers on it.
  const dropped = frames.filter((f) => f.t === 'ground').at(-1)?.items ?? [];

  /**
   * ONE `stepTo` IS ONE STEP, NOT A WALK.
   *
   * Measured on this seed: the drop is at 9,14 and the fight ends at 9,6 --
   * eight tiles apart. A single step reached 10,7 and then six `pickup`s fired
   * at a bare tile, so a floor with two items on it printed "(nothing)" while
   * the beat above it said "2 things are still on the floor". The fight loop
   * gets away with calling `stepTo` once per iteration because it iterates; this
   * called it once and walked nowhere.
   */
  const walkTo = async (target, cap = 40) => {
    for (let i = 0; i < cap; i += 1) {
      if (pos.x === target.x && pos.y === target.y) return true;
      if (!(await stepTo(target))) return false;
    }
    return pos.x === target.x && pos.y === target.y;
  };

  // EVERY drop, not just the first -- a kill that leaves two items and a tool
  // that collects one is still reporting the wrong session.
  let reached = 0;
  for (const item of dropped.slice(0, 4)) {
    const cell = item?.cell;
    if (!Array.isArray(cell)) continue;
    if (!(await walkTo({ x: cell[0], y: cell[1] }))) continue;
    reached += 1;
    send({ t: 'pickup' });
    await sleep(220);
  }
  if (dropped.length > 0) {
    console.log(`  walked to ${String(reached)} of ${String(dropped.length)} drop(s)`);
  }
  beat('LOOTS THE ROOM');
  show(mark, 8);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEN THE TOWN — the leg this tool had never walked.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above is the fight. But a first session is also the first person
 * you speak to and the first thing you buy, and neither had ever been driven
 * end to end: the shops, the four closed topics and the ten townsfolk were all
 * tested at the unit level and never from a socket in the order a player meets
 * them.
 *
 * Leaving the breach is its own step and it is not a no-op: the threshold only
 * ejects once you have stepped OFF it since arriving (`Session.exitArmed`), so
 * this walks away from the door and back onto it.
 */
mark = log.length;
if (realmNow()?.kind === 'inner') {
  // THE WAY OUT IS A SITE MARKER, not a field on the realm frame — the first
  // version of this read `realm.spawns`, which the wire does not carry, and
  // reported a player who never left the room.
  const gate = (realmNow().sites ?? []).find((site) => site.name === 'The way out');
  const spawn = gate === undefined ? null : { x: gate.x, y: gate.y };
  if (spawn !== null) {
    // Off the doorstep first — standing on it on arrival means nothing.
    for (let i = 0; i < 4; i += 1) await stepTo({ x: spawn.x + 2, y: spawn.y + 2 });
    for (let i = 0; i < 40 && realmNow()?.kind === 'inner'; i += 1) {
      if (!(await stepTo(spawn))) break;
    }
  }
  const me = realmNow()?.actors?.find((a) => a.id === selfId);
  if (me !== undefined) pos = { x: me.x, y: me.y };
}
beat('WALKS BACK OUT');
console.log(`  now in: ${realmNow()?.name} [${realmNow()?.kind}]`);
show(mark, 3);

// ── to the nearest town ────────────────────────────────────────────────────
// A TOWN IS A MARKER, NOT AN ABSENCE. The first version filtered on "has no
// creature sprite", which is every delve on the map as well — and walked a
// level-1 character straight into the Drowned Chapel to meet a wraith.
const TOWN_MARKERS = new Set(['city', 'town', 'village']);
const towns = (frames.filter((f) => f.t === 'sites').at(-1)?.sites ?? []).filter((site) =>
  TOWN_MARKERS.has(site.marker),
);
const byDistance = towns
  .map((site) => ({ site, d: Math.max(Math.abs(site.x - pos.x), Math.abs(site.y - pos.y)) }))
  .sort((a, b) => a.d - b.d);
const town = byDistance[0];
mark = log.length;
if (town !== undefined) {
  for (let i = 0; i < 200 && realmNow()?.kind === 'overworld'; i += 1) {
    if (!(await stepTo({ x: town.site.x, y: town.site.y }))) break;
  }
  const me = realmNow()?.actors?.find((a) => a.id === selfId);
  if (me !== undefined) pos = { x: me.x, y: me.y };
}
await sleep(250);
drain();
beat('WALKS INTO TOWN');
console.log(`  now in: ${realmNow()?.name} [${realmNow()?.kind}]`);
show(mark, 4);

// ── the first person they meet ─────────────────────────────────────────────
const folk = (realmNow()?.actors ?? []).filter((a) => a.id !== selfId && a.kind !== 'player');
console.log(`  people here: ${folk.length === 0 ? 'NOBODY' : folk.map((f) => f.name).join(', ')}`);
mark = log.length;
if (folk.length > 0) {
  const who = folk
    .map((f) => ({ f, d: Math.max(Math.abs(f.x - pos.x), Math.abs(f.y - pos.y)) }))
    .sort((a, b) => a.d - b.d)[0].f;
  for (let i = 0; i < 120; i += 1) {
    const gap = Math.max(Math.abs(who.x - pos.x), Math.abs(who.y - pos.y));
    if (gap <= 1) break;
    if (!(await stepTo({ x: who.x, y: who.y }))) break;
  }
  const gap = Math.max(Math.abs(who.x - pos.x), Math.abs(who.y - pos.y));
  console.log(`  reached ${who.name}? gap=${gap}`);
  // BUMPING IS THE GREETING (`greetOnBump`), so a player who never learns the
  // talk key still meets them. Walk into them.
  const dir =
    (who.y > pos.y ? 's' : who.y < pos.y ? 'n' : '') +
    (who.x > pos.x ? 'e' : who.x < pos.x ? 'w' : '');
  if (dir !== '') {
    send({ t: 'move', dir });
    await sleep(300);
  }
  drain();
  beat('MEETS SOMEBODY');
  show(mark, 8);

  // AND ASKS THEM SOMETHING. The topic set is closed on purpose.
  mark = log.length;
  for (const topic of ['where', 'party', 'roads', 'rumour']) {
    send({ t: 'talk', targetId: who.id, topic });
    await sleep(180);
  }
  drain();
  beat('ASKS ALL FOUR TOPICS');
  show(mark, 10);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEN TO A SHOP, WHICH MEANS LEAVING — the nearest town has none.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED: Alderbrook is ONE step from the spawn, is the room every player
 * enters first, and has no shop. The nearest is Ashwick Alchemy Row at 28 steps
 * and the goods shop is Threadneedle Row at 52. That is deliberate — the towns
 * are specialised and the Reeve says so out loud, *"Threadneedle for goods"* —
 * but it means the first purchase in a career is a long way from the first coin,
 * and nothing had ever driven that walk to find out what happens at the end.
 */
if (frames.filter((f) => f.t === 'shop').length === 0) {
  mark = log.length;
  /**
   * GO WHERE THE REEVE SAID, not to whatever happens to be second nearest.
   *
   * This walked `byDistance.slice(1, 3)` and reported `NO SHOP FRAME` — because
   * it had strolled to The Glass Archive and then A Wayfarers' Camp, neither of
   * which sells anything. Exactly two sites carry a shelf (realms.ts: Threadneedle
   * Row is the Outfitter, Ashwick Alchemy Row the Apothecary) and blind distance
   * order does not find them.
   *
   * A PLAYER WOULD NOT SEARCH AT RANDOM EITHER. They asked the Reeve where to go
   * and were told *"Threadneedle for goods"*, so heading there is not the tool
   * cheating with knowledge the player lacks — it is the tool finally using the
   * knowledge the game just handed it. The distance order stays as the fallback
   * for a map where those names have moved.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ASHWICK FIRST, BECAUSE THAT IS WHAT THE REEVE NOW SAYS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The note above is the rule and this list is the part of it that has to keep
   * up. Her `where` used to read "Threadneedle for goods" and this walked there;
   * it now reads "Ashwick for a draught. Threadneedle costs more." — because
   * `STARTING_MONEY` is 15, the outfitter's level-1 floor is 24, and the
   * apothecary sells at 14.
   *
   * A tool that kept walking to Threadneedle after the advice moved would be
   * measuring a player who ignored the advice, and reporting the opening as a
   * refusal that the game no longer hands anybody. The ORDER is the whole fix:
   * both shops are still visited if the first has nothing.
   */
  const shopNames = ['Ashwick', 'Threadneedle'];
  const shopFirst = [
    ...shopNames.flatMap((n) => byDistance.filter((c) => (c.site.name ?? '').includes(n))),
    ...byDistance.slice(1, 3),
  ];
  for (const next of shopFirst) {
    // Out of this town first: the way out is a marker here too.
    const gateHere = (realmNow()?.sites ?? []).find((site) => site.name === 'The way out');
    if (gateHere !== undefined) {
      for (let i = 0; i < 6; i += 1) await stepTo({ x: gateHere.x + 2, y: gateHere.y + 2 });
      for (let i = 0; i < 60 && realmNow()?.kind !== 'overworld'; i += 1) {
        if (!(await stepTo({ x: gateHere.x, y: gateHere.y }))) break;
      }
    }
    const back = realmNow()?.actors?.find((a) => a.id === selfId);
    if (back !== undefined) pos = { x: back.x, y: back.y };
    if (realmNow()?.kind !== 'overworld') break;

    let steps = 0;
    for (; steps < 400 && realmNow()?.kind === 'overworld'; steps += 1) {
      if (!(await stepTo({ x: next.site.x, y: next.site.y }))) break;
    }
    const inside = realmNow()?.actors?.find((a) => a.id === selfId);
    if (inside !== undefined) pos = { x: inside.x, y: inside.y };
    await sleep(300);
    drain();
    console.log(`  walked ${steps} steps to ${realmNow()?.name} [${realmNow()?.kind}]`);
    if (frames.filter((f) => f.t === 'shop').length > 0) break;
  }
  beat('GOES LOOKING FOR A SHOP');
  show(mark, 6);
}

// ── and the shop ───────────────────────────────────────────────────────────
const shop = frames.filter((f) => f.t === 'shop').at(-1);
console.log(
  `  shop: ${shop === undefined ? 'NO SHOP FRAME' : `${shop.name} — ${(shop.stock ?? []).length} items`}`,
);
if (shop !== undefined && (shop.stock ?? []).length > 0) {
  mark = log.length;
  const money = frames.filter((f) => f.t === 'inventory').at(-1)?.money ?? 0;
  const affordable = (shop.stock ?? []).filter((it) => (it.buy ?? Infinity) <= money);
  console.log(
    `  ${money} gold buys ${affordable.length} of ${(shop.stock ?? []).length}: ${affordable.map((it) => `${it.name} (${it.buy}g)`).join(', ') || '(nothing)'}`,
  );
  console.log(
    `  the whole shelf: ${(shop.stock ?? []).map((it) => `${it.name} ${it.buy}g`).join(', ')}`,
  );
  const errsBefore = frames.filter((f) => f.t === 'error').length;
  send({ t: 'shop_buy', itemId: (affordable[0] ?? shop.stock[0]).itemId });
  await sleep(300);
  drain();
  beat('TRIES TO BUY SOMETHING');
  show(mark, 5);
  const errs = frames.filter((f) => f.t === 'error').slice(errsBefore);
  console.log(
    `  refusal: ${errs.length === 0 ? 'NONE — the key did nothing' : errs.map((e) => `${e.code}: ${e.message}`).join(' | ')}`,
  );
}

/**
 * AND PUTS THE COAT ON — the one action in the arc the game actually nudges.
 *
 * `Nothing on your ${slot} yet.` fires on the pickup and is deliberately an
 * observation rather than a tutorial naming a key. This drives the action it
 * implies, so the tool can say whether following the nudge WORKS rather than
 * only that the nudge was printed.
 */
mark = log.length;
const bag = frames.filter((f) => f.t === 'inventory').at(-1)?.carried ?? [];
if (bag.length > 0) {
  const errsBefore = frames.filter((f) => f.t === 'error').length;
  send({ t: 'equip', itemId: bag[0].itemId });
  await sleep(300);
  drain();
  beat('PUTS ON WHAT IT PICKED UP');
  show(mark, 4);
  const errs = frames.filter((f) => f.t === 'error').slice(errsBefore);
  if (errs.length > 0)
    console.log(`  refusal: ${errs.map((e) => `${e.code}: ${e.message}`).join(' | ')}`);
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

/**
 * AND WHAT THEY CAN PRESS. The opening arc joining up is one question; having
 * anything to DO with it is another, and the hotbar is the only surface that
 * answers it. A row of empty slots after a first kill is the shape of a player
 * concluding the game has nothing in it.
 */
// `loadout`, NOT `hotbar` — the frame is named for what it carries and the
// first version of this looked for the button bar's name and reported an empty
// hotbar that was never empty.
const hot = frames.filter((f) => f.t === 'loadout').at(-1);
const slots = hot?.talents ?? [];
console.log(
  `  talents: ${slots.length === 0 ? 'NONE' : slots.map((sl) => `${sl.name} L${sl.level}${sl.usable === false ? ' (unusable)' : ''}`).join(', ')}`,
);
const worn = Object.entries(inv?.equipped ?? {}).filter(([, v]) => v != null);
console.log(
  `  worn: ${worn.length === 0 ? 'nothing' : worn.map(([k, v]) => `${k}=${v.name ?? v}`).join(', ')}`,
);
console.log(
  `\n──── the player read ${log.length} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);

ws.close();
server.kill();
await sleep(200);
