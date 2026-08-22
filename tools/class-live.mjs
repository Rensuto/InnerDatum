/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES A CLASS ACTUALLY REACH A BODY? ASK A REAL SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     node tools/class-live.mjs [watchman|inspector|alchemist|redactor] [port]
 *
 * Written for the Redactor, which shipped with 12 talents, two trees, a
 * resource, a portrait row and 3536 passing tests and had never been played by
 * anybody. It turned out the check is not about the Redactor at all: "does a
 * `ClassDef` reach a real body" is a question every class answers, and only one
 * of them had ever been asked it.
 *
 * A class whose pool never reached the sheet still walks, still swings, still
 * looks entirely fine, and cannot pay for a single talent.
 *
 * ═══ WHY A UNIT TEST CANNOT CLOSE THIS ═══
 * `tools/status-live.mjs`'s header states the rule this file inherits: the
 * status system shipped connected to nothing for a whole milestone with 115
 * test references, every one reaching into the module directly, none through
 * `main.ts`. "A test that imports the module under test is exactly the thing
 * that missed it."
 *
 * The Redactor is the same shape of risk, one class along, and it stacks three
 * newly-wired seams on top of each other:
 *
 *   1. the class must be OFFERED and CHOOSABLE — `class_options` is built from
 *      `CLASSES`, and the rotation, the portrait table and the sprite family
 *      all key off an id that did not exist a day ago.
 *   2. `Strike Out` must reach `ctx.status` and land `EFFACED` — an effect that
 *      until `MVP_EFFECTS` was fixed was registered from a three-element
 *      literal and could not be applied by anything at all.
 *   3. the landing must PAY — `creditForLanding` -> `noteAfflicted` ->
 *      `gainResource`. That path existed for months with no class that could
 *      take it, which is the whole reason this class was worth building.
 *
 * Every one of those is green in the suite. None of them had crossed a socket.
 *
 * ═══ IT MUST PRESS MORE THAN ONCE, AND THAT COST A WRONG ANSWER TO LEARN ═══
 * The first version of this file compared the Ink either side of ONE cast and
 * announced that `creditForLanding` -> `noteAfflicted` -> `gainResource` was
 * broken. It is not. `useTalent` runs the talent BODY and only then pays —
 * "past this line nothing can fail, so now we pay", which is what keeps a
 * refused talent free — so a mark credits its income BEFORE the cost:
 *
 *     100 -> mark lands, +12 -> CAPPED at 100 -> cost 8 -> 92
 *
 * At a full well the cap eats the income, and the single measurement that kind
 * of probe can take is exactly the one that cannot see what it is looking for.
 * At a dry well the same order gives 10 -> 22 -> 14: the net +4 `strike_out.ts`
 * documents, working as designed.
 *
 * So it presses SIX times and reads the shape. With income the well HOVERS near
 * the cap; without it, six casts take 100 to 52. Neither reading can be mistaken
 * for the other, and no second talent is needed to force the well down.
 *
 * ═══ WHAT IT PRINTS ═══
 * Every distinct Ink figure the socket was sent, the log line the server chose,
 * and a verdict drawn from the SEQUENCE — distinguishing "the mark was resisted"
 * and "nothing resolved" from a genuine drain. A probe that reports a save, or a
 * cap, as a failure is the bug `status-live.mjs` had.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { WebSocket } from 'ws';

import { PROTOCOL_VERSION } from '../src/shared/version.ts';
import { canWalk } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';
import { helloAndChoose } from './handshake.mjs';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH CLASS TO PLAY, AND WHAT IT SHOULD BE CARRYING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Redactor was the one that needed proving, but the check is not about the
 * Redactor — it is "does a `ClassDef` reach a real body over a socket". Every
 * class answers that question and only one of them had ever been asked.
 *
 * `resource` is the assertion that matters. A class whose pool never reached the
 * sheet still walks, still swings, still looks entirely fine, and cannot pay for
 * a single talent — which is the shape of failure this whole file exists for.
 *
 * WHAT IS NOT PINNED HERE: the earn clause. Each class earns differently —
 * Resolve when struck, Focus for holding ground, Reagents on a kill, Ink per
 * mark — and each needs its own scenario to trigger. Only the Redactor's is
 * driven below, because a mark is the one a probe can force reliably in a few
 * turns. The other three are named so the gap is visible rather than implied.
 */
const CLASSES = {
  watchman: { pool: 'resolve', earns: 'when struck (RESOLVE_ON_STRUCK, +6) — NOT driven here' },
  inspector: {
    pool: 'focus',
    earns: 'holding ground (FOCUS_ON_HELD_GROUND, +12) — NOT driven here',
  },
  alchemist: { pool: 'reagents', earns: 'on a kill — NOT driven here' },
  redactor: { pool: 'ink', earns: 'per mark landed (INK_PER_MARK, +12) — driven below' },
};

const WANT = process.argv[2] ?? 'redactor';
const SPEC = CLASSES[WANT];
if (SPEC === undefined) {
  console.log(`unknown class "${WANT}". One of: ${Object.keys(CLASSES).join(', ')}`);
  process.exit(1);
}

const PORT = process.argv[3] ?? '31979';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TURN_WAIT_MS = 45;

// ---------------------------------------------------------------------------
// Boot — a port of its own, so a live game on the host is never disturbed.
// ---------------------------------------------------------------------------

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverErr = [];
server.stderr.on('data', (b) => serverErr.push(b.toString()));
process.on('exit', () => server.kill());

let up = false;
for (let i = 0; i < 80 && !up; i += 1) {
  await sleep(250);
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
  } catch {
    /* not yet */
  }
}
if (!up) {
  console.log('the server never came up. stderr:\n' + serverErr.join(''));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// One socket, and a record of everything it was sent
// ---------------------------------------------------------------------------

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (raw) => {
  try {
    frames.push(JSON.parse(raw.toString()));
  } catch {
    /* not ours */
  }
});
ws.on('error', (err) => {
  console.log(`socket error: ${String(err)}`);
  process.exit(1);
});
await new Promise((done) => ws.on('open', done));

const send = (msg) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
const last = (t) => frames.filter((f) => f.t === t).at(-1);

let logCursor = 0;
const drainLog = () => {
  const lines = [];
  for (const f of frames) if (f.t === 'log') for (const l of f.lines ?? []) lines.push(l.text);
  const fresh = lines.slice(logCursor);
  logCursor = lines.length;
  return fresh;
};
const beat = (title) => console.log(`\n──── ${title}`);

// ---------------------------------------------------------------------------
// 1. Be a Redactor
// ---------------------------------------------------------------------------

beat('THE PICKER');
/**
 * BY NAME, NOT BY INDEX. `helloAndChoose` takes a position in the offered list
 * and the Redactor is fourth today — but the whole point of this run is that the
 * roster changed, so an index would be the one assumption most likely to rot.
 * The offer is read, the id is found, and a missing one is the first failure.
 */
send({ t: 'hello' });
await sleep(400);
const offer = last('class_options');
const options = offer?.options ?? [];
console.log(`  offered: ${options.map((o) => o.id).join(', ') || '(none)'}`);
const wanted = options.findIndex((o) => o.id === WANT);
if (wanted < 0) {
  console.log(`  ${WANT.toUpperCase()} WAS NOT OFFERED. The picker is built from CLASSES.`);
  process.exit(1);
}

/** Re-run the handshake through the shared helper, now that the index is known. */
const socketFrames = frames;
const { chosen } = await helloAndChoose(send, socketFrames, wanted);
console.log(`  chose: ${chosen.id} — ${chosen.name}`);
await sleep(500);

const loadout = last('loadout');
const talents = loadout?.talents ?? [];
console.log(`  loadout: ${talents.map((t) => t.name).join(' | ') || '(none)'}`);
if (talents.length === 0) {
  console.log('  THE BAR IS EMPTY. `birthTalents` never reached the loadout.');
  process.exit(1);
}

/**
 * THE POOL IS NESTED. `ResourceMsg` is `{ t, resource: ResourceView }`, and the
 * first draft of this read `r.kind` off the frame itself — which is `undefined`,
 * so the probe reported "THE POOL IS undefined, NOT INK" about a frame that had
 * arrived and was perfectly correct. Read the shape; do not guess it.
 */
const inkOf = () => {
  const r = last('resource')?.resource;
  return r === undefined ? null : { kind: r.kind, value: r.current, max: r.max };
};
/**
 * WAITED FOR, NOT SAMPLED. The first run of this file read `last('resource')`
 * 900ms after choosing and printed "THE POOL IS NOT INK" — because no `resource`
 * frame had arrived at all, which is a different fact from a frame carrying the
 * wrong kind. That is precisely the false negative `waitForBadges` was added to
 * `status-live.mjs` to stop, reproduced here within an hour of citing it.
 */
let opening = inkOf();
for (let i = 0; i < 40 && opening === null; i += 1) {
  await sleep(150);
  opening = inkOf();
}
console.log(
  `  resource: ${opening?.kind ?? '(no frame arrived)'} ` +
    `${String(opening?.value)}/${String(opening?.max)}`,
);
if (opening === null) {
  console.log('  NO `resource` FRAME IN SIX SECONDS. The pool is never announced at all.');
  process.exit(1);
}
if (opening.kind !== SPEC.pool) {
  console.log(
    `  THE POOL IS ${opening.kind}, NOT ${SPEC.pool}. This ClassDef's resource ` +
      `never reached the sheet.`,
  );
  process.exit(1);
}
console.log(`  earns: ${SPEC.earns}`);

/**
 * ONLY THE REDACTOR'S EARN CLAUSE IS DRIVEN, and the others say so rather than
 * being quietly skipped.
 *
 * A mark is the one income a probe can force in a handful of turns: aim, press,
 * read. The others need a scenario — the Watchman has to BE HIT, the Inspector
 * has to hold ground for a turn, the Alchemist has to land a killing blow — and
 * each is a different piece of choreography with its own ways to be
 * inconclusive. Writing three shaky ones now would produce three probes that
 * fail for reasons other than the thing they test, which is the fault this file
 * spent two commits learning to avoid.
 *
 * So: every class is checked as far as "its pool reached its sheet and its bar
 * is populated", which is the failure that makes a class unplayable, and the
 * Redactor is taken all the way through to income.
 */
const strikeOut = talents.find((t) => /strike out/i.test(t.name));
if (WANT !== 'redactor' || strikeOut === undefined) {
  // THE OBSERVED KIND, NOT THE EXPECTED ONE. `SPEC.pool` is what this run was
  // looking for; printing it here would report the question as the answer. The
  // assertion above is what proves they match — this line just says what came
  // back.
  console.log(
    `\n  ${WANT} is offered, choosable, carries ${String(talents.length)} talents, and its ` +
      `pool came back as ${opening.kind} ${String(opening.value)}/${String(opening.max)}.` +
      `\n  Its earn clause is not driven by this probe — see the note above.`,
  );
  ws.close();
  server.kill();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Find something to write on
// ---------------------------------------------------------------------------

beat('WALKING INTO A FIGHT');
const selfId = last('welcome')?.selfId;
const realmNow = () => last('realm');

/**
 * HOSTILES ARE NOT ON THE OVERWORLD'S ACTOR LIST. They are ROAMER SITES, and a
 * fight starts by walking into one — `realm.kind` flips to `inner` and the
 * monsters appear then. The first draft of this walked six tiles north looking
 * for `kind === 'monster'` in `realm.actors` and reported "nothing hostile
 * turned up in 400 steps" about a map that was full of them.
 *
 * The loop below is `status-live.mjs`'s, which already knew this.
 */
const roamers = () => (last('sites')?.sites ?? []).filter((site) => site.sprite);
let pos = (() => {
  const me = realmNow()?.actors?.find((a) => a.id === selfId);
  return me === undefined ? { x: 0, y: 0 } : { x: me.x, y: me.y };
})();

let inFight = false;
for (let i = 0; i < 400 && !inFight; i += 1) {
  const targets = roamers();
  const realm = realmNow();
  if (targets.length === 0) {
    send({ t: 'move', dir: 'n' });
  } else {
    const near = targets
      .map((site) => ({ site, d: Math.max(Math.abs(site.x - pos.x), Math.abs(site.y - pos.y)) }))
      .sort((a, b) => a.d - b.d)[0].site;
    const dir =
      realm === undefined
        ? 'n'
        : (firstStep((x, y) => canWalk(realm.level, x, y), pos, { x: near.x, y: near.y }) ?? 'n');
    send({ t: 'move', dir });
  }
  await sleep(TURN_WAIT_MS / 2);
  const moved = frames.filter((f) => f.t === 'moved' && f.id === selfId).at(-1);
  if (moved !== undefined) pos = { x: moved.x, y: moved.y };
  if (realmNow()?.kind === 'inner') inFight = true;
}

if (!inFight) {
  console.log('  never found a fight in 400 steps — nothing to mark. Inconclusive.');
  ws.close();
  server.kill();
  process.exit(0);
}

const hostiles = () =>
  (realmNow()?.actors ?? []).filter((a) => a.id !== selfId && a.kind === 'monster' && a.alive);
const victim = hostiles()[0];
if (victim === undefined) {
  console.log('  in a breach with nothing alive in it. Inconclusive.');
  ws.close();
  server.kill();
  process.exit(0);
}
console.log(`  in a breach with ${victim.name} at ${String(victim.x)},${String(victim.y)}`);
drainLog();

// ---------------------------------------------------------------------------
// 3. Strike it out, and see whether the well fills
// ---------------------------------------------------------------------------

beat('STRIKE OUT');
const before = inkOf();
const usedIt = () => frames.some((f) => f.t === 'used' && f.ev?.talentId === strikeOut.id);

/**
 * CLOSE TO RANGE FIRST. Strike Out reaches 6 and the breach can drop you further
 * out than that — the first run stood at 12,12 against a husk at 7,5, seven tiles
 * away, and the server correctly answered `out_of_range` while this file called
 * it "NOTHING RESOLVED — this IS a fault". A probe that cannot walk into its own
 * range is measuring its own legs.
 */
const STRIKE_RANGE = 6;
/**
 * THE SERVER'S METRIC, WHICH IS EUCLIDEAN. `engine/combat.ts#combatDistance` is
 * `sqrt(dx*dx + dy*dy)`; this probe used Chebyshev, walked to 12,12 against a
 * body at 18,14, measured "6 tiles, range is 6" and could not understand why
 * `out_of_range` came back. (6, 2) is 6.32 away. The server was right every time.
 *
 * A probe that measures distance differently from the thing it is probing will
 * always eventually accuse it of a bug it does not have.
 */
const reach = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
/**
 * POSITIONS COME AS DELTAS. `realm` is a SNAPSHOT and the bodies move inside
 * `moved` frames after it, so reading a position out of the snapshot is reading
 * where everybody was when the breach opened. The first run of this loop asked
 * the snapshot where it was standing, was told 12,12 for twenty iterations, and
 * never took a step. `status-live.mjs` says this in its own words: "the board
 * here is rebuilt from deltas, and the husk takes its step inside a `sweep`".
 */
/**
 * ONLY THE MOVES SINCE THIS REALM ARRIVED, which is the whole correctness of it.
 *
 * An earlier version replayed EVERY `moved` frame of the session over the inner
 * realm's snapshot — including every step taken on the OVERWORLD before the
 * breach opened. Those are positions on a different map, and they clobbered the
 * right ones: the probe aimed at overworld coordinates, collected
 * `out_of_range` eight times, and reported a fault while an Index Husk was
 * hitting the caster in melee.
 *
 * A realm frame is a fresh board. Nothing before it describes this one.
 */
const track = new Map();
const sinceRealm = () => {
  let at = -1;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i].t === 'realm') {
      at = i;
      break;
    }
  }
  return at;
};
const refresh = () => {
  track.clear();
  const from = sinceRealm();
  for (const actor of realmNow()?.actors ?? []) track.set(actor.id, { x: actor.x, y: actor.y });
  for (let i = from + 1; i < frames.length; i += 1) {
    const f = frames[i];
    if (f.t === 'moved') track.set(f.id, { x: f.x, y: f.y });
  }
};
const hereRaw = () => {
  refresh();
  return track.get(selfId) ?? { x: 0, y: 0 };
};
// REFRESHES FIRST. Splitting `hereRaw` out left this one reading a map that
// `refresh` had just cleared, so it answered `undefined` and the approach loop
// broke out on its first iteration without taking a step.
const hereNow = () => {
  refresh();
  const at = track.get(selfId);
  return at === undefined ? undefined : { ...at, id: selfId };
};
/**
 * THE NEAREST LIVE HOSTILE, RE-CHOSEN EVERY TIME — not the one this run happened
 * to name when the breach opened.
 *
 * A breach holds several bodies and they move. An earlier version tracked one id
 * from entry, aimed at it for eight attempts, and collected eight
 * `out_of_range` refusals WHILE AN INDEX HUSK WAS HITTING THE CASTER IN MELEE.
 * Something was plainly in reach; it simply was not the body being aimed at.
 */
const victimNow = () => {
  refresh();
  const live = (realmNow()?.actors ?? []).filter(
    (a) => a.id !== selfId && a.kind === 'monster' && a.alive,
  );
  const at = hereRaw();
  const ranked = live
    .map((a) => {
      const p = track.get(a.id) ?? { x: a.x, y: a.y };
      return { a, p, d: reach(at, p) };
    })
    .sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best === undefined
    ? { x: victim.x, y: victim.y, name: victim.name }
    : { ...best.p, name: best.a.name };
};
for (let step = 0; step < 20; step += 1) {
  const at = hereNow();
  const realm = realmNow();
  if (at === undefined || realm === undefined) break;
  const goal = victimNow();
  if (reach(at, goal) <= STRIKE_RANGE) break;
  const dir = firstStep((x, y) => canWalk(realm.level, x, y), { x: at.x, y: at.y }, goal);
  if (dir === undefined) break;
  send({ t: 'move', dir });
  await sleep(TURN_WAIT_MS * 3);
}

const me = hereNow();
const goal = victimNow();
const away = me === undefined ? '?' : reach(me, goal).toFixed(1);
console.log(
  `  me at ${String(me?.x)},${String(me?.y)} — ${String(goal.name)} at ` +
    `${String(goal.x)},${String(goal.y)}, ${away} tiles, range is ${String(STRIKE_RANGE)}`,
);

/**
 * PRESSED UNTIL IT LANDS OR THE ATTEMPTS RUN OUT, re-aiming each time. The
 * target is a live creature taking its own turn between the read and the press,
 * so a single shot at a remembered tile misses about as often as not — and
 * `illegal_move` maps from `NoTarget`, which is indistinguishable from a broken
 * talent unless you try again at where it actually is now.
 */
const errorsBefore = frames.filter((f) => f.t === 'error').length;
for (let attempt = 0; attempt < 8 && !usedIt(); attempt += 1) {
  const at = victimNow();
  send({ t: 'talent', talentId: strikeOut.id, target: { x: at.x, y: at.y } });
  const deadline = Date.now() + 800;
  while (Date.now() < deadline && !usedIt()) await sleep(60);
  if (usedIt()) break;
  send({ t: 'hold' });
  await sleep(TURN_WAIT_MS * 3);
}

/**
 * WHAT THE SERVER SAID, NOT WHAT IT MIGHT HAVE MEANT. `status-live.mjs` spent a
 * run printing three unchecked guesses at a refusal whose code was on the wire
 * the whole time. Every refusal since the press is printed here.
 */
for (const err of frames.filter((f) => f.t === 'error').slice(errorsBefore)) {
  console.log(`  [server refused] ${err.code}: ${err.message ?? ''}`);
}

const lines = drainLog();
for (const line of lines) console.log(`  ${line}`);
await sleep(600);
const after = inkOf();

console.log(
  `\n  Ink: ${String(before?.value)} -> ${String(after?.value)} (of ${String(after?.max)})`,
);

/**
 * THE VERDICT, AND ONLY TWO OF THE FOUR ARE FAULTS.
 *
 * A resisted mark is the status system WORKING and refusing — `status-live.mjs`
 * spent a run reporting exactly that as a broken pipeline, and this file is not
 * going to repeat it. What is a fault is a mark that landed and paid nothing
 * (the Ink path is broken) or a press that never resolved at all.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A SECOND PRESS, WHICH IS THE ONLY WAY TO TELL TWO BUGS APART.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The well starts FULL, so a first mark that pays cannot be seen: 100 - 8 + 12
 * caps back to 100 and 100 - 8 with no income is 92. The reading after one cast
 * is the same either way if the income is capped away, and DIFFERENT only in the
 * direction that looks like a fault.
 *
 * Press again from 92 and the two answers separate:
 *   income arrives  ->  92 - 8 + 12 = 96   (the well climbs while marking)
 *   income does not ->  92 - 8      = 84
 *
 * A third possibility this also catches: the server credits correctly and never
 * SENDS the new figure, in which case the second reading is 84 while the server
 * believes 96 — and the third press would read 76 rather than 88. That is a
 * different bug in a different layer, and reporting one as the other would send
 * somebody to read the wrong file.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRESS IT SIX TIMES, BECAUSE ONE PRESS AT A FULL WELL PROVES NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useTalent` runs the talent BODY and only then pays — "past this line nothing
 * can fail, so now we pay", which is what keeps a refused talent free. So a mark
 * credits its income BEFORE the cost comes off:
 *
 *     100 -> mark lands, +12 -> capped at 100 -> cost 8 -> 92
 *
 * At a full well the income is clipped away and a single before/after reads as
 * "landed and paid nothing". It is not: at a dry well the same order gives
 * 10 -> 22 -> 14, the net +4 `strike_out.ts` documents.
 *
 * SIX PRESSES SEPARATE THEM WITHOUT NEEDING A SECOND TALENT. With income, each
 * press is +12 then -8 and the well HOVERS near the cap. Without it, six presses
 * take 100 down to 52. The shape of the sequence is the answer, and neither
 * reading can be mistaken for the other.
 */
beat('SIX PRESSES — DOES THE WELL HOVER OR DRAIN?');
for (let press = 0; press < 6; press += 1) {
  const usedBefore = frames.filter((f) => f.t === 'used').length;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const at = victimNow();
    send({ t: 'talent', talentId: strikeOut.id, target: { x: at.x, y: at.y } });
    const until = Date.now() + 700;
    while (Date.now() < until && frames.filter((f) => f.t === 'used').length === usedBefore) {
      await sleep(60);
    }
    if (frames.filter((f) => f.t === 'used').length > usedBefore) break;
    send({ t: 'hold' });
    await sleep(TURN_WAIT_MS * 3);
  }
  await sleep(250);
}
await sleep(700);
drainLog();

const readings = frames
  .filter((f) => f.t === 'resource')
  .map((f) => f.resource)
  .filter((r) => r !== undefined);
const distinct = [];
for (const r of readings) {
  const at = Number(r.current.toFixed(1));
  if (distinct.at(-1) !== at) distinct.push(at);
}
console.log(`  every Ink figure this socket was sent: ${distinct.join(' -> ')}`);
const lowest = Math.min(...distinct);
const cost = 8;
const presses = frames.filter((f) => f.t === 'used').length;
console.log(`  ${String(presses)} casts landed; lowest Ink seen was ${String(lowest)}`);
const drained = 100 - presses * cost;
console.log(
  lowest > drained + cost
    ? `  IT HOVERS. ${String(presses)} casts with no income would have reached ` +
        `${String(drained)}; the well never went below ${String(lowest)}, so a landed ` +
        `mark is paying.`
    : `  IT DRAINS. ${String(presses)} casts took it to ${String(lowest)}, which is the ` +
        `full cost with nothing coming back. The credit path is broken.`,
);

const text = lines.join(' | ');
const landed = /is struck out/.test(text);
const resisted = /holds the line/.test(text);

/**
 * THE VERDICT COMES FROM THE SEQUENCE, NOT FROM ONE BEFORE/AFTER PAIR.
 *
 * An earlier version compared the Ink either side of a single press and
 * announced "THE MARK LANDED AND PAID NOTHING — `creditForLanding` ->
 * `noteAfflicted` -> `gainResource` is broken." It is not broken. The well
 * starts FULL, the income is credited before the cost comes off, and the cap
 * clips it — so the one measurement that class of probe can make is the one
 * measurement that cannot see the thing it is looking for.
 *
 * The six-press shape can. Reported from that, and from nothing else.
 */
beat('VERDICT');
if (!usedIt()) {
  console.log('  NOTHING RESOLVED — no `used` frame named Strike Out. This IS a fault.');
  process.exit(1);
} else if (!landed && resisted) {
  console.log(
    '  THE TARGET SAVED every time. The status system ran and refused the mark,\n' +
      '  which is honest and not a fault — run again for a landing.',
  );
} else if (!landed) {
  console.log(`  UNRECOGNISED. The log said: ${text || '(nothing)'}`);
} else if (lowest > drained + cost) {
  console.log(
    '  THE CLASS WORKS END TO END. It is offered, choosable, carries its bar,\n' +
      '  lands its mark, and a landed mark pays — the well held at ' +
      `${String(lowest)} across ${String(presses)} casts that would otherwise have\n` +
      `  drained it to ${String(drained)}.`,
  );
} else {
  console.log(
    '  THE WELL DRAINED THE FULL COST. `creditForLanding` -> `noteAfflicted` ->\n' +
      '  `gainResource` is not paying. This IS a fault.',
  );
  process.exit(1);
}

ws.close();
server.kill();
