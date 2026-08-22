/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES A STATUS REACH A PLAYER'S SCREEN? ASK A REAL SOCKET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER TEST ═══
 * The status system — three effects, typed saves, partial-save duration
 * scaling, badge art, wire frames, 115 test references — was fully built and
 * connected to NOTHING for an entire milestone. Every one of those references
 * reached into `engine/effects.ts` directly. Not one of them went through
 * `main.ts`, so not one of them noticed that `main.ts` never built the table.
 *
 * That is the failure mode this file exists to close, and a unit test cannot
 * close it by construction: a test that imports the module under test is
 * exactly the thing that missed it. So this boots the REAL server binary, opens
 * a REAL WebSocket, and reads what a browser would have been sent. Everything
 * printed here crossed a socket.
 *
 * ═══ WHAT IT PROVES, END TO END ═══
 *   main.ts built an EffectState and registered three defs
 *     -> createTurnEngine got it, so `statusPass` exists
 *     -> talentRuntimeFor got a `statusApplier`, so Lockdown can land a stun
 *     -> the scheduler got `applyStatus`, so a monster's rider can land one
 *     -> wsGateway got it, so `EffectsMsg` is broadcast at all
 *     -> the projector let it through FOV, so THIS CLIENT can see it
 *     -> the Case Log rendered words for it
 *
 * Any one of those seven being absent prints a different, obvious failure.
 *
 * ═══ IT ASSERTS NOTHING AND EXITS 0 ON A QUIET RESULT ═══
 * Deliberate. `npm run check` is the gate; this is an INSTRUMENT. A stun that
 * did not land because the husk saved is not a regression, and a tool that
 * failed the build over a die roll would be turned off within a week. It prints
 * what happened and lets a person read it.
 *
 * Usage:  node tools/status-live.mjs [port]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { WebSocket } from 'ws';

import { PROTOCOL_VERSION } from '../src/shared/version.ts';
import { EFFECT_IDS } from '../src/server/content/effects.ts';
import { canWalk } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';

const PORT = process.argv[2] ?? '31977';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Long enough for an orb to cross a room; short enough to notice a hang. */
const TURN_WAIT_MS = 45;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: ROOT,
  // A PORT OF ITS OWN. The live game is on the host and people play on it; a
  // tool that grabbed the real port would take the server out from under them.
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
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    // ═══ A REFUSAL IS THE MOST INFORMATIVE FRAME ON THE WIRE ═══
    // An `error` is the server saying "I understood you and declined", which is
    // exactly what a probe needs to see and exactly what a frame counter hides:
    // the first run of this tool reported `error×1` in a tally and said nothing
    // about a Lockdown that was refused for a nameable reason.
    if (frame.t === 'error')
      console.log(`  [server refused] ${frame.code}: ${frame.message ?? ''}`);
  } catch {
    /* a frame we cannot read is a frame we cannot report on */
  }
});
await new Promise((r) => ws.on('open', r));
const send = (msg) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));

const last = (t) => frames.filter((f) => f.t === t).at(-1);
const lastRealm = () => last('realm');

/** Case Log lines, drained in order, so each beat prints only what it added. */
let logCursor = 0;
const drainLog = () => {
  const out = [];
  for (const f of frames.slice(logCursor === 0 ? 0 : 0)) void f;
  const lines = [];
  for (const f of frames) if (f.t === 'log') for (const l of f.lines ?? []) lines.push(l);
  const fresh = lines.slice(logCursor);
  logCursor = lines.length;
  for (const l of fresh) out.push(`${'  '.repeat(l.depth ?? 0)}${l.text}`);
  return out;
};

const beat = (title) => console.log(`\n──── ${title}`);
/**
 * RETURNS WHAT IT PRINTED, so a caller can READ the verdict instead of inferring
 * it from the absence of a badge. See `effectVerdict`.
 */
const printLog = () => {
  const lines = drainLog();
  if (lines.length === 0) console.log('  (the log said nothing)');
  for (const l of lines) console.log(`  ${l}`);
  return lines;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE SERVER DECIDED ABOUT THE STUN — READ OFF ITS OWN WORDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ "NO BADGE" WAS THREE DIFFERENT ANSWERS WEARING ONE WORD ═══
 * This tool pressed Lockdown once and reported `a stun reached this client: no`
 * whenever a badge failed to turn up. Three unrelated things produce that:
 *
 *   1. THE SAVE HELD. The status system ran, rolled, and refused the effect.
 *      Nothing is broken — the pipeline carried a "no". This is the COMMON
 *      case, and it was being reported as a failure of the pipeline.
 *   2. THE STUN LANDED AND NO BADGE ARRIVED. The actual seam failure this file
 *      exists to catch.
 *   3. NOTHING RESOLVED AT ALL — the press never reached the talent.
 *
 * A run that cannot separate 1 from 2 cannot answer the question in this file's
 * title, and it spent a run saying "no" about a working pipeline. That is the
 * same false negative `waitForBadges` was written to stop, one layer up.
 *
 * ═══ IT MUST MATCH WHICHEVER TALENT WAS ACTUALLY PRESSED ═══
 * Lockdown is the only stun and it is NOT LEARNED AT LEVEL 1, so this tool
 * usually presses Shin Crack instead and says so — see the `stand-in` line. The
 * first version of this classifier looked only for Lockdown's stun phrasing and
 * therefore returned `NOTHING` on every run, reporting *"the press never reached
 * the talent"* about a slow that had landed perfectly well.
 *
 * That is the same mistake in miniature that this whole file exists to catch: an
 * instrument confidently measuring something it was not pointed at. Both talents
 * are matched now, because either one proves the pipeline.
 *
 *   lockdown.ts   `is stunned (N turns)` · `saves — stunned N, not M` · `shrugs it off`
 *   shin_crack.ts `is slowed for N turns` · `shakes it off`
 *
 * The partial save is why this cannot be a two-way test: it is a save AND a
 * landing, and it is precisely the case where a missing badge is a real bug.
 *
 * PROSE RATHER THAN A CODE, and that is a real weakness stated rather than
 * hidden: the wire carries the sentence, not the outcome enum. Editing those
 * strings blinds this classifier — which is the cost of the rule this whole file
 * is built on, that nothing here may reach into the server to check its work.
 */
const effectVerdict = (lines) => {
  const text = lines.join(' | ');
  //   strike_out.ts  `is struck out`            ·  `holds the line`
  //   lockdown.ts    `is stunned (N turns)`     ·  `saves — stunned N` ·  `shrugs it off`
  //   shin_crack.ts  `is slowed for N turns`    ·  `shakes it off`
  if (/is stunned \(|is slowed for|is struck out/.test(text)) return 'LANDED';
  if (/saves . stunned/.test(text)) return 'LANDED_PARTIAL';
  if (/shrugs it off|shakes it off|holds the line/.test(text)) return 'SAVED';
  return 'NOTHING';
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WAIT FOR AN `effects` FRAME THAT CARRIES SOMETHING. Never sample once.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `printEffects` reads whatever the LATEST frame happens to be at the instant
 * it is called, and a status applied by the press this tool exists to make
 * takes a beat to come back down the socket. Sampling immediately reported
 * "an effects frame arrived, carrying no badges" on a run whose own log said
 * *"Index Cairn is slowed for 3 turns"* — the badge was on its way, and the
 * tool had already decided it was not.
 *
 * That answer is worse than no answer. This is the tool that exists to prove
 * the status pipeline reaches a client, and it was reporting a false negative
 * on a working pipeline.
 *
 * RETURNS WHETHER ANYTHING TURNED UP, so the caller can still say so honestly
 * when nothing does.
 */
const waitForBadges = async (timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = last('effects')?.actors ?? [];
    if (rows.some((a) => (a.effects ?? []).length > 0)) return true;
    if (Date.now() > deadline) return false;
    // AND LET TIME PASS WHILE WAITING. The effects snapshot goes out on a PUMP,
    // and a probe that presses once and then only listens never causes another
    // one -- so it waits for a frame that nothing is going to send. A player
    // does not have this problem because a fight keeps moving around them.
    send({ t: 'hold' });
    await sleep(150);
  }
};

/** Every `effects` frame is a full snapshot; this prints the badges on it. */
const printEffects = (label) => {
  const msg = last('effects');
  if (msg === undefined) {
    console.log(`  ${label}: NO 'effects' FRAME HAS EVER ARRIVED`);
    return false;
  }
  const rows = msg.actors ?? [];
  const carrying = rows.filter((a) => (a.effects ?? []).length > 0);
  if (carrying.length === 0) {
    console.log(`  ${label}: an effects frame arrived, carrying no badges`);
    return false;
  }
  for (const a of carrying) {
    // `EffectView.id` / `.name`, not `.effectId` — the row names itself the way
    // every other id-carrying view in protocol.ts does.
    const badges = a.effects.map((e) => `${e.name} [${e.id}] ${String(e.turns)}t`).join(', ');
    console.log(`  ${label}: ${a.id} -> ${badges}`);
  }
  return true;
};

// ---------------------------------------------------------------------------
// 1. Join and take the Watchman — the only class with a stun
// ---------------------------------------------------------------------------

send({ t: 'hello' });
await sleep(900);

const selfId = last('welcome')?.selfId;
const options = last('class_options')?.options ?? [];
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REDACTOR, BECAUSE THIS FILE IS ABOUT STATUSES AND THE REDACTOR APPLIES
 * THEM AT RANGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This chose the Watchman, and the Watchman cannot prove the thing this tool
 * exists to prove. His only level-1 status is Shin Crack's slow, it is MELEE, and
 * a physical save refuses it often enough that landing one takes several
 * presses — which means standing next to a breach full of monsters for several
 * turns. The last run before this change ended
 *
 *     retry 1: no 'used' frame — last refusal was out_of_range
 *     stopped retrying: the caster is down after 1 more press(es)
 *
 * He died. Not a fault in the game and not a fault in the probe; the wrong body
 * was sent to ask the question.
 *
 * `strike_out` reaches six tiles and applies EFFACED, so a Redactor can press it
 * from outside the fight and keep pressing. The class exists now, `class-live.mjs`
 * proves it lands marks over this same socket, and picking it here costs nothing
 * — the status pipeline does not care which class fed it.
 *
 * BY NAME, NOT BY ROTATION SLOT. `options[0]` is whatever the gateway offers
 * first, which is exactly the assumption that broke when a fourth class shipped.
 */
const caster =
  options.find((o) => /redactor/i.test(o.name)) ??
  options.find((o) => /watchman/i.test(o.name)) ??
  options[0];
if (selfId === undefined || caster === undefined) {
  console.log('never got a welcome or a class list — the gateway is not talking.');
  process.exit(1);
}

send({ t: 'choose_class', classId: caster.id });
await sleep(700);

beat(`JOINED as ${caster.name}`);
printLog();

const loadout = last('loadout')?.talents ?? [];
console.log(
  `  hotbar: ${loadout.map((t) => t.name).join(' | ') || '(EMPTY — the talent seam is unwired)'}`,
);
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TALENT THIS BODY HAS ACTUALLY LEARNED — which used to be assumed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This tool pressed Lockdown by name and that was right until `birthTalents`
 * landed: a class is now born knowing FOUR of its eighteen, and Lockdown is not
 * one of the Watchman's. Every press came back `bad_message` — nine of them,
 * reported as "every tile around 17,13 was refused", which reads like a
 * targeting fault and is not one.
 *
 * The point of this tool is the STATUS PIPELINE: does an effect applied on the
 * server reach this socket as a badge. Lockdown is the only stun, so it is
 * still first choice — but Shin Crack slows, is learned at level 1, and proves
 * the same pipeline. Preferring the stun and settling for any learned active
 * keeps the tool honest about what it managed to test.
 */
const learned = loadout.filter((t) => (t.level ?? 0) >= 1 && t.cost !== undefined);
/**
 * STRIKE OUT FIRST, now that the caster is a Redactor. It is learned at level 1,
 * reaches six tiles, and applies EFFACED — everything Lockdown was wanted for
 * without needing to survive melee to do it. Lockdown and Shin Crack stay in the
 * list so this file still works if the class choice above falls back.
 */
const lockdown =
  learned.find((t) => /strike out/i.test(t.name)) ??
  learned.find((t) => /lockdown/i.test(t.name)) ??
  learned.find((t) => /shin crack/i.test(t.name)) ??
  learned[0];
console.log(`  pressing: ${lockdown?.name ?? '(nothing learned)'}`);

// ---------------------------------------------------------------------------
// 2. Walk into a fight
// ---------------------------------------------------------------------------

const meOn = (realm) => realm?.actors?.find((a) => a.id === selfId);
let pos = (() => {
  const me = meOn(lastRealm());
  return me === undefined ? { x: 0, y: 0 } : { x: me.x, y: me.y };
})();

const roamers = () => (last('sites')?.sites ?? []).filter((s) => s.sprite);

let inFight = false;
for (let i = 0; i < 400 && !inFight; i += 1) {
  const targets = roamers();
  if (targets.length === 0) {
    send({ t: 'move', dir: 'n' });
    await sleep(TURN_WAIT_MS / 2);
  } else {
    const near = targets
      .map((s) => ({ s, d: Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y)) }))
      .sort((a, b) => a.d - b.d)[0].s;
    const realm = lastRealm();
    const dir =
      realm === undefined
        ? 'n'
        : (firstStep((x, y) => canWalk(realm.level, x, y), pos, { x: near.x, y: near.y }) ?? 'n');
    send({ t: 'move', dir });
    await sleep(TURN_WAIT_MS / 2);
  }
  const moved = frames.filter((f) => f.t === 'moved' && f.id === selfId).at(-1);
  if (moved !== undefined) pos = { x: moved.x, y: moved.y };
  const realm = lastRealm();
  if (realm !== undefined && realm.kind === 'inner') inFight = true;
}

if (!inFight) {
  console.log('\nnever found a fight in 400 steps — nothing more to measure.');
  ws.close();
  server.kill();
  process.exit(0);
}

beat('IN A BREACH');
printLog();

// ---------------------------------------------------------------------------
// 3. Close to melee, then press Lockdown
// ---------------------------------------------------------------------------

const board = new Map();
for (const a of lastRealm().actors ?? [])
  board.set(a.id, { x: a.x, y: a.y, alive: true, kind: a.kind });
/**
 * START AT THE PRESENT, NOT AT ZERO — and getting this wrong is the classic
 * self-bug of every probe written against this server.
 *
 * The `realm` frame above is a FULL SNAPSHOT of the breach: everybody's
 * coordinates as they are right now, inside this room. `moved` frames are
 * DELTAS, and the buffer still holds every one of them from the overworld walk
 * that got us here. Replaying those over a fresh snapshot writes overworld
 * coordinates onto bodies standing in a 34x30 room, and the tool then reports
 * the player at 122,60 and a husk 117 tiles away — a nonsense the game never
 * produced. The crossing is a `realm` frame; only what arrives AFTER it is a
 * delta on it.
 */
let seen = frames.length;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MONSTERS MOVE INSIDE A `sweep`. READ ONLY `moved` AND THE BOARD GOES STALE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * protocol.ts is explicit about the split — "Monsters go in a `sweep`; players
 * come through here, plus `moved` for a step." A probe that tracks only the
 * top-level `moved` frames therefore sees its own footsteps perfectly and every
 * monster frozen where the last full snapshot left it.
 *
 * That is not a cosmetic inaccuracy. It made this tool aim Lockdown at a tile
 * the husk had walked off, and the server answered `illegal_move` — which maps
 * from `NoTarget` among four other refusals, so the frame looked exactly like a
 * broken melee talent. It was a stale board.
 */
const applyEvent = (ev) => {
  const e = board.get(ev.id);
  if (e === undefined) return;
  // `MoveEvent` carries `fromX/fromY` AND `x/y`; the destination is the plain
  // pair, and the `from` half exists so a client can animate the step.
  if (ev.k === 'move') {
    e.x = ev.x;
    e.y = ev.y;
  }
  // `'death'`, NOT `'died'`. There is no `died` TurnEvent kind, so a probe
  // testing for one marks nothing dead, keeps a corpse on the board, aims a
  // melee talent at it once the player walks onto that very tile, and reads
  // back `illegal_move` — which maps from `NoTarget`. Every symptom of a broken
  // talent, produced entirely by a misspelt string in the tool.
  if (ev.k === 'death' || ev.k === 'erased') e.alive = false;
};

const track = () => {
  for (; seen < frames.length; seen += 1) {
    const f = frames[seen];
    if (f.t === 'moved') {
      const e = board.get(f.id);
      if (e !== undefined) {
        e.x = f.x;
        e.y = f.y;
      }
    }
    /**
     * THE IMMEDIATE LANE — `attacked` / `damaged` / `died` / `used`.
     *
     * Every one of them wraps the SAME payload the sweep carries, under the key
     * `ev`. protocol.ts is explicit that this exists so a client needs exactly
     * one `applyEvent` and cannot grow two disagreeing implementations of "an
     * actor took damage".
     *
     * A probe reading `f.id` off these gets `undefined` and silently updates
     * nothing — which is how this tool kept a killed husk on its board, then
     * aimed a melee talent at the corpse and read the resulting `NoTarget` as a
     * broken talent. Player kills come down THIS lane; only monster actions go
     * through `sweep`.
     */
    if (f.t === 'died' || f.t === 'attacked' || f.t === 'damaged' || f.t === 'used') {
      if (f.ev !== undefined) applyEvent(f.ev);
    }
    // THE MONSTER LANE.
    if (f.t === 'sweep') for (const ev of f.events ?? []) applyEvent(ev);
    if (f.t === 'turn' && Array.isArray(f.events)) for (const ev of f.events) applyEvent(ev);
  }
};

const foesNow = () => {
  track();
  const me = board.get(selfId);
  if (me === undefined) return [];
  return [...board.entries()]
    .filter(([id, e]) => id !== selfId && e.alive && e.kind !== 'player')
    .map(([id, e]) => ({ id, ...e, d: Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) }))
    .sort((a, b) => a.d - b.d);
};

let adjacent = null;
for (let i = 0; i < 60 && adjacent === null; i += 1) {
  const foes = foesNow();
  if (foes.length === 0) break;
  const me = board.get(selfId);
  if (i === 0) {
    console.log(
      `  [board] me at ${String(me?.x)},${String(me?.y)} — ` +
        `${String(foes.length)} foe(s): ${foes.map((f) => `${f.id}@${String(f.x)},${String(f.y)} d${String(f.d)}`).join(' ')}`,
    );
  }
  if (foes[0].d <= 1) {
    adjacent = foes[0];
    break;
  }
  const realm = lastRealm();
  const dir =
    firstStep(
      (x, y) => canWalk(realm.level, x, y),
      { x: me.x, y: me.y },
      { x: foes[0].x, y: foes[0].y },
    ) ?? 'e';
  send({ t: 'move', dir });
  await sleep(TURN_WAIT_MS);
}

beat('CLOSED TO MELEE');
printLog();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIGHT FOR THE RESOLVE FIRST, BECAUSE A PLAYER HAS TO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first run of this tool walked up to a husk, pressed Lockdown and got back
 * `no_resource`. That is not a bug — it is the Watchman's class mechanic doing
 * exactly what game-design.md § 2 says it does. Resolve starts at ZERO and
 * builds two ways: `RESOLVE_PER_TURN` (a trickle) and `RESOLVE_ON_STRUCK` = 6,
 * a lump every time somebody hits you. Lockdown costs 30.
 *
 * So a Watchman's control talent is something he EARNS by standing in front of
 * the swarm for a few turns, which is the entire fiction of the class. A probe
 * that skipped that would be measuring a character no player ever has.
 *
 * Bump-attacking is how a player fills the bar: it trades blows, which pays the
 * 6 each time the husk connects.
 */
// `ResourceView.current`, NOT `.value` — reading a field that does not exist
// gives `undefined ?? 0`, and a probe that reports a full bar as zero looks
// exactly like the bug it is supposed to be hunting for.
const resolveNow = () => last('resource')?.resource?.current ?? 0;
const resolveMax = () => last('resource')?.resource?.max ?? 0;
const resolveCost = lockdown?.cost?.resource ?? 30;

if (adjacent !== null && lockdown !== undefined) {
  beat('EARNING THE RESOLVE');
  for (let i = 0; i < 40 && resolveNow() < resolveCost; i += 1) {
    const foes = foesNow();
    if (foes.length === 0) break;
    const me = board.get(selfId);
    const realm = lastRealm();
    const dir =
      firstStep(
        (x, y) => canWalk(realm.level, x, y),
        { x: me.x, y: me.y },
        { x: foes[0].x, y: foes[0].y },
      ) ?? 'e';
    send({ t: 'move', dir });
    await sleep(TURN_WAIT_MS);
  }
  console.log(
    `  Resolve ${String(Math.round(resolveNow()))} / ${String(resolveMax())} ` +
      `(Lockdown needs ${String(resolveCost)})`,
  );
  printLog();
  // The husk may have died to the bumping, in which case there is nothing left
  // to stun and saying so beats pressing at a corpse.
  const still = foesNow();
  adjacent = still.length > 0 && still[0].d <= 1 ? still[0] : null;
}

let stunSeen = false;
/** What the server said about the effect it threw. See `effectVerdict`. */
let verdict = 'NOTHING';
if (adjacent === null) {
  console.log('  nothing adjacent and alive to stun.');
} else if (lockdown === undefined) {
  console.log('  nothing on the hotbar is learned yet, so there is nothing to press.');
} else if (resolveNow() < resolveCost) {
  console.log(
    `  never earned enough Resolve — the fight ended first ` +
      `(${String(Math.round(resolveNow()))} of ${String(resolveCost)}).`,
  );
} else {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PRESS AROUND THE RING, BECAUSE A TRACKED TILE IS ALWAYS ONE FRAME OLD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The board here is rebuilt from deltas, and the husk takes its step inside a
   * `sweep` that may arrive after the move that put us next to it. Aiming at a
   * single remembered tile therefore misses by exactly one square about as often
   * as not, and the server answers `illegal_move` — which maps from `NoTarget`
   * along with four other refusals, so the frame is indistinguishable from a
   * genuinely broken melee talent. That misreading cost real time.
   *
   * A PLAYER DOES NOT HAVE THIS PROBLEM: they click the husk they can see. The
   * honest equivalent for a headless probe is to try the eight tiles around the
   * caster and stop at the one the server accepts. It is not a workaround for a
   * game defect — it is the tool declining to assert something it cannot know.
   */
  const RING = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const caster = board.get(selfId);
  // WHAT THE BOARD BELIEVES, PRINTED BEFORE THE PRESS. Nine refusals in a row
  // is not a stale tile — it is "there is nothing hostile anywhere near me" —
  // and the only way to tell those apart is to say what we think is out there.
  console.log(
    `  board: me@${String(caster?.x)},${String(caster?.y)} | ` +
      ([...board.entries()]
        .filter(([id]) => id !== selfId)
        .map(([id, e]) => `${id}@${String(e.x)},${String(e.y)} ${e.alive ? 'alive' : 'DEAD'}`)
        .join(' ') || '(nothing else on the board)'),
  );
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WAIT FOR THE TALENT TO BE *USED*, NOT MERELY FOR NO ERROR TO ARRIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This loop used to accept a tile the moment 220ms passed with no new `error`
   * frame, and then print "Lockdown accepted". That is absence of evidence, and
   * it was wrong in the quietest possible way: a run reported `accepted, aimed
   * at 18,14`, no `used` frame for Lockdown ever arrived, no log line said
   * *"Player 1 uses Lockdown"*, and the summary blamed the badge pipeline.
   *
   * The log printed under `PRESSED LOCKDOWN` was DRAINED HISTORY — Shin Crack
   * resolving late from the previous phase — which is what made the false
   * acceptance look like a real cast that lost its badge. A tool built to catch
   * a system connected to nothing was itself asserting from nothing.
   *
   * `used` is the server saying it happened, by talent id. That is the only
   * frame that means the press reached the talent, so it is the one waited for.
   */
  let usedBefore = 0;
  const usedIt = () =>
    frames.filter((f) => f.t === 'used' && f.ev?.talentId === lockdown.id).length > usedBefore;

  let accepted = null;
  for (const [dx, dy] of RING) {
    const at = { x: (caster?.x ?? 0) + dx, y: (caster?.y ?? 0) + dy };
    const errorsBefore = frames.filter((f) => f.t === 'error').length;
    // `TalentSchema` is a zod STRICT object and the tile goes in `target`, not
    // as loose `x`/`y` — a bare pair is refused as `bad_message` before it
    // reaches any game logic, which is what the first run of this tool did.
    send({ t: 'talent', talentId: lockdown.id, target: at });

    /**
     * POLLED TO A DEADLINE RATHER THAN SLEPT PAST. A talent is an INTENT: it is
     * accepted now and resolves when the clock asks, so the `used` frame comes
     * back a beat later and a fixed 220ms sleep can end before either answer
     * arrives. Whichever lands first — the use or the refusal — ends the wait.
     */
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      if (usedIt()) break;
      if (frames.filter((f) => f.t === 'error').length > errorsBefore) break;
      await sleep(60);
    }
    if (usedIt()) {
      accepted = at;
      break;
    }
  }
  console.log(
    accepted === null
      ? `  every tile around ${String(caster?.x)},${String(caster?.y)} was refused, ` +
          `or was accepted and never resolved — no 'used' frame named it`
      : `  ${lockdown?.name ?? 'the talent'} USED, aimed at ` +
          `${String(accepted.x)},${String(accepted.y)} ` +
          `(the server sent a 'used' frame naming it — not merely no error)`,
  );
  await sleep(500);

  beat(`PRESSED ${(lockdown?.name ?? 'THE TALENT').toUpperCase()}`);
  // THE SERVER'S OWN WORDS ABOUT THE EFFECT, kept rather than only printed. See
  // `effectVerdict` — "no badge" was three different answers wearing one word.
  verdict = effectVerdict(printLog());
  // THE BADGE COMES BACK A BEAT AFTER THE CAST. See `waitForBadges`.
  const effectsBefore = frames.filter((f) => f.t === 'effects').length;
  const got = await waitForBadges();
  const effectsAfter = frames.filter((f) => f.t === 'effects').length;
  console.log(
    `  effects frames: ${String(effectsBefore)} before the press, ${String(effectsAfter)} after; ` +
      `badges seen: ${got ? 'yes' : 'no'}`,
  );
  stunSeen = printEffects('badges');

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND PRESS AGAIN WHILE THE TARGET KEEPS SAVING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A SAVE IS AN HONEST ANSWER AND IT IS NOT THE ANSWER THIS FILE WANTS. The
   * verdict classifier stopped runs being read as a broken pipeline when a husk
   * made its roll — but "nothing is broken" is not the same claim as "a badge
   * reached this client", and only the second one closes the seam this tool was
   * written for. A tool that proves the pipeline only on lucky runs proves it on
   * no run in particular.
   *
   * So: press again. Saves are independent rolls, so a handful of attempts turns
   * a coin-flip into a near-certainty, and the loop stops the moment anything
   * lands. It stops for the honest reasons too — the target dying, the caster
   * dying, or the talent simply never being usable again — and SAYS WHICH,
   * because "we ran out of attempts" and "the fight ended" are different facts
   * about a run and only one of them is worth re-running.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY MORE TIMES TO TRY TO MAKE SOMETHING LAND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Five, and it is deliberately not more. Saves are independent rolls, so five
   * extra presses turn a coin-flip into a near-certainty WHEN THE PRESS CAN BE
   * MADE AT ALL. When it cannot — a melee stand-in against a ranged creature
   * standing across water — no number helps, and the refusal printed each time
   * says which of the two situations this run is in.
   */
  const MORE_ATTEMPTS = 5;
  /**
   * Turns to let pass before each retry. One more than `shin_crack.ts`'s
   * `cooldownTurns: 3`, so the press is never the turn the cooldown expires on —
   * a probe that lands exactly on the boundary reports a flake as a fault.
   */
  const COOLDOWN_PASSES = 4;
  /** Steps to spend walking back into melee before a retry. See the loop. */
  const CLOSE_STEPS = 6;
  for (
    let attempt = 1;
    attempt <= MORE_ATTEMPTS && verdict === 'SAVED' && !stunSeen;
    attempt += 1
  ) {
    if (board.get(selfId)?.alive === false) {
      console.log(
        `  stopped retrying: the caster is down after ${String(attempt - 1)} more press(es)`,
      );
      break;
    }
    /**
     * THE NEAREST LIVE FOE, RE-CHOSEN EVERY ATTEMPT — `foesNow` already sorts
     * them by distance and this loop was not asking it.
     *
     * It took the FIRST live entry off the board instead, which is insertion
     * order and has nothing to do with reach. A breach holds several bodies;
     * this walked six steps toward whichever one happened to be first, pressed a
     * MELEE talent, and collected `out_of_range` five times in a row while
     * something else stood next to the caster hitting it.
     */
    const [victim] = foesNow();
    if (victim === undefined) {
      console.log(`  stopped retrying: nothing hostile left alive to mark`);
      break;
    }
    /**
     * WALK BACK INTO REACH FIRST. Shin Crack is a MELEE talent and the Index
     * Cairn is a `RangedKiter` — it spends its turns backing away, so four turns
     * of holding is four turns of it getting further off. The first version of
     * this retry pressed from wherever the caster happened to be standing and
     * reported "still not usable" five times, which was true and was a statement
     * about DISTANCE rather than about cooldown, resource or reach.
     */
    for (let step = 0; step < CLOSE_STEPS; step += 1) {
      const me = board.get(selfId);
      const realmNow = lastRealm();
      if (me === undefined || realmNow === undefined) break;
      if (Math.abs(victim.x - me.x) <= 1 && Math.abs(victim.y - me.y) <= 1) break;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * `move` CARRIES A COMPASS `dir`, NOT A `{dx, dy}` PAIR.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The first version of this loop sent `{ t: 'move', dx, dy }` and the
       * server refused all six steps with
       *
       *   bad_message: dir: Invalid option: expected one of "n"|"ne"|"e"|...;
       *                Unrecognized keys: "dx", "dy"
       *
       * so the caster never took a step, stayed six tiles from a creature that
       * spends its turns backing away, and every retry came back
       * `out_of_range`. The retry loop then reported "still not usable
       * (resource, reach, or the fight moved)" — true, unhelpful, and pointing
       * at three things that were all innocent.
       *
       * `firstStep` is the same pathing helper the walk-into-a-fight phase uses
       * at :319. Reusing it rather than writing a second direction calculation
       * is what keeps this from drifting away from the shape the wire accepts.
       */
      const dir = firstStep(
        (x, y) => canWalk(realmNow.level, x, y),
        { x: me.x, y: me.y },
        { x: victim.x, y: victim.y },
      );
      if (dir === undefined) break;
      send({ t: 'move', dir });
      await sleep(TURN_WAIT_MS * 4);
    }
    /**
     * PASS TURNS FIRST, BECAUSE THE TALENT IS ON COOLDOWN.
     *
     * `shin_crack.ts` has `cooldownTurns: 3`. The first version of this retry
     * slept 45ms between presses and reported *"not usable again (cooldown,
     * resource, or out of reach)"* five times in a row — technically true, and
     * useless: it had not let a single turn pass, so the cooldown it was
     * blaming had no opportunity to tick.
     *
     * A cooldown ticks on GAME TURNS, not on wall clock, and the only way this
     * client advances one is to take an action. `hold` is the cheapest.
     */
    for (let pass = 0; pass < COOLDOWN_PASSES; pass += 1) {
      send({ t: 'hold' });
      await sleep(TURN_WAIT_MS * 4);
    }
    /**
     * AND PRESS AROUND THE RING, for the reason the first press does: the board
     * here is rebuilt from deltas and is always one frame behind the creature.
     * Aiming at the remembered tile misses by one square about half the time.
     */
    usedBefore = frames.filter((f) => f.t === 'used' && f.ev?.talentId === lockdown.id).length;
    const from = board.get(selfId);
    for (const [rx, ry] of RING) {
      send({
        t: 'talent',
        talentId: lockdown.id,
        target: { x: (from?.x ?? 0) + rx, y: (from?.y ?? 0) + ry },
      });
      await sleep(200);
      if (usedIt()) break;
    }

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !usedIt()) await sleep(60);
    if (!usedIt()) {
      /**
       * SAY WHAT THE SERVER SAID, NOT WHAT IT MIGHT HAVE MEANT.
       *
       * This line used to read "(resource, reach, or the fight moved)" — three
       * guesses, none of them checked, printed five times in a row. The actual
       * answer was on the wire the whole time: `out_of_range`, because the walk
       * toward the target was itself being refused `illegal_move: refused at
       * resolution: terrain`. The Index Cairn is a `RangedKiter` that stands
       * across a channel, and the stand-in talent is MELEE — so this pairing
       * cannot be made to land however many times it is pressed.
       *
       * That is a real limit on what this probe can prove with a level-1
       * Watchman, and it belongs on the screen rather than behind a guess.
       */
      const lastError = frames.filter((f) => f.t === 'error').at(-1);
      console.log(
        `  retry ${String(attempt)}: no 'used' frame — last refusal was ` +
          `${lastError?.code ?? '(none)'}: ${lastError?.message ?? ''}`,
      );
      continue;
    }
    beat(`PRESSED AGAIN (${String(attempt)} of ${String(MORE_ATTEMPTS)})`);
    verdict = effectVerdict(printLog());
    await waitForBadges();
    stunSeen = printEffects('badges');
    console.log(`  verdict on this press: ${verdict}`);
  }

  // THE BADGE MUST ALSO EXPIRE. A door with no clock is a permanent stun, and
  // the two halves of the seam fail independently and silently.
  if (stunSeen) {
    for (let i = 0; i < 8; i += 1) {
      send({ t: 'hold' });
      await sleep(TURN_WAIT_MS);
    }
    beat('EIGHT TURNS LATER');
    printLog();
    printEffects('badges');
  }
}

// ---------------------------------------------------------------------------
// 4. What crossed the wire, counted
// ---------------------------------------------------------------------------

const kinds = new Map();
for (const f of frames) kinds.set(f.t, (kinds.get(f.t) ?? 0) + 1);

beat('WHAT THE SOCKET RECEIVED');
console.log(
  '  ' +
    [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${String(n)}`)
      .join('  '),
);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER CHECK — the thing this tool found that nothing else could.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The room's completion beat is authored by the gateway and broadcast on its
 * own frame; the pump's own Record lines are batched. Put the beat before the
 * batch and a player reads the conclusion above its cause:
 *
 *     An Index Breach is quiet now.
 *     2 damage. Index Husk 0/25.
 *     Index Husk is unfiled.
 *
 * A unit test on the cleared-room predicate cannot see this — the predicate was
 * always right, and `test/server/cleared.test.ts` passes either way. Only frame
 * ORDER over a socket shows it, which is what this file reads.
 */
const allLines = [];
for (const f of frames) if (f.t === 'log') for (const l of f.lines ?? []) allLines.push(l.text);
const quietAt = allLines.findIndex((t) => /is quiet now\./.test(t));
const lastKillAt = allLines.map((t) => /is unfiled\./.test(t)).lastIndexOf(true);

beat('THE CLEARED-ROOM BEAT, IN ORDER');
if (quietAt === -1) {
  console.log('  no room was cleared this run — nothing to check.');
} else if (lastKillAt === -1) {
  console.log('  a room announced itself clear with nothing recorded dying in it.');
} else if (quietAt < lastKillAt) {
  console.log(
    `  WRONG ORDER: "${allLines[quietAt]}" arrived BEFORE "${allLines[lastKillAt]}".
` + `  The beat is overtaking the blow that caused it.`,
  );
} else {
  console.log(`  ok — "${allLines[lastKillAt]}" then "${allLines[quietAt]}"`);
}

/**
 * THE ACTING BUDGET, AS IT CROSSED THE WIRE.
 *
 * `ResourceView.ap` is memoised by `sendHotbarIfChanged`'s viewer key, and a
 * field missing from that key is a field the client is never told changed — so
 * the first thing to check is that it arrives at all. It did not, on the first
 * run of this check: `projectResource` rebuilds the view field by field and
 * silently dropped it, two files downstream of where it was added.
 *
 * ═══ A CONSTANT READING IS CORRECT TODAY, AND WILL NOT BE LATER ═══
 * Under the current engine one submitted action ends the actor's turn, and
 * `actBase` refills `sheet.ap = sheet.maxAp` inside the same pump — so the
 * budget is always back to full before any frame is composed. Seeing 6/6 on
 * every frame is the TRUTH, not a stuck memo.
 *
 * That stops being true when the round stays open (DECISIONS.md D1: "spendable
 * across several talents in one park"). At that point a mid-round reading of
 * 3/6 has to appear here, and a constant 6/6 becomes the memo-key bug this
 * check was originally written to catch. Both readings are printed rather than
 * judged, because which one is correct depends on a change this tool cannot
 * see.
 */
const apSeen = frames
  .filter((f) => f.t === 'resource' && f.resource?.ap !== undefined)
  .map((f) => `${String(f.resource.ap)}/${String(f.resource.maxAp)}`);
beat('THE AP BUDGET, ON THE WIRE');
if (apSeen.length === 0) {
  console.log('  NO `resource` FRAME CARRIED `ap` — the projection is not wired.');
} else {
  const distinct = [...new Set(apSeen)];
  console.log(`  ${String(apSeen.length)} frame(s) carried ap; values seen: ${distinct.join(' ')}`);
  console.log(
    distinct.length === 1
      ? '  constant — correct while one action ends the round; a bug once it stays open.'
      : '  it moves mid-round, which is what an open round should look like.',
  );
}

const effectFrames = kinds.get('effects') ?? 0;
console.log(`\n  'effects' frames: ${String(effectFrames)}`);
// AN EFFECT, NOT A STUN. The caster is a Redactor and the effect is EFFACED;
// the field is still named `stunSeen` because Lockdown was the original
// subject, and renaming it would touch eight call sites to say the same thing.
console.log(`  an effect reached this client as a badge: ${stunSeen ? 'YES' : 'no'}`);

/**
 * AND WHAT THAT ANSWER MEANS, which is the part a reader cannot supply.
 *
 * Only one of these four is a defect in this game. Printing the verdict beside
 * the badge means a run can no longer be mistaken for a broken pipeline because
 * a husk happened to make its save.
 */
const READING = {
  LANDED: 'the effect LANDED — a badge is owed, and the line above says whether one came',
  LANDED_PARTIAL:
    'a PARTIAL save — the effect landed shortened, so a badge is still owed. ' +
    'This is the case where a missing badge is a real bug.',
  SAVED: 'the target SAVED — the status system ran and refused it. Nothing is broken.',
  NOTHING: 'nothing resolved — the press never reached the talent, which IS a fault',
};
console.log(`  the server's verdict: ${verdict} — ${READING[verdict]}`);
if (verdict !== 'SAVED' && verdict !== 'NOTHING' && !stunSeen) {
  console.log('  ^^ AN EFFECT LANDED AND NO BADGE ARRIVED. This is the seam this tool exists for.');
}

/**
 * EVERY REGISTERED ID, READ FROM THE LIST THE SERVER REGISTERS FROM.
 *
 * This line said "the three registered ids" and named Stunned, Bleeding and
 * Slowed as literals. There have been SIX since Effaced, Breached and Dazed
 * were added to `MVP_EFFECTS` — and a hardcoded three in the tool whose whole
 * job is catching a hardcoded list that drifted is the same bug it exists to
 * find. `main.ts` iterates `MVP_EFFECTS`; `EFFECT_IDS` is derived from it, so
 * this cannot fall behind again.
 */
console.log(`  the ${String(EFFECT_IDS.length)} registered ids: ${EFFECT_IDS.join(', ')}`);

if (effectFrames === 0) {
  console.log(
    `\n  NO 'effects' FRAME EVER ARRIVED. That is the unwired-gateway signature:\n` +
      `  wsGateway registered without \`effects\` returns on the first line of\n` +
      `  broadcastEffectsIfChanged, forever, and nothing anywhere raises.`,
  );
}

ws.close();
server.kill();
await sleep(200);
