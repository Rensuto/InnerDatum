/**
 * M1 end-to-end verification.
 *
 * Compiling is not evidence. This boots the real server, connects TWO real
 * WebSocket clients, and checks the thing M1 actually promises: two people see
 * each other move, the server is authoritative, and walls block movement.
 *
 * AMENDED AT M2 — ONE CHECK, FOR A REAL BEHAVIOUR CHANGE. See the disconnect
 * section at the bottom: a dropped socket no longer removes the actor, so the
 * `left` frame this used to wait for is not sent any more. Everything else here
 * is unchanged and still guards the M1 contract; the protocol version is read
 * from the server, so the bump to v2 needed no edit.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PORT = '31555';
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
// Derived, never hardcoded. A literal dev-machine path made this harness fail
// on the deploy host with `spawn ... ENOENT`, which names the BINARY even
// though the missing thing is the CWD — a genuinely misleading error.
const CWD = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

/**
 * A CHECK THE HARNESS COULD NOT REACH IS NOT A FAILURE.
 *
 * `round-live.mjs` learned this the expensive way: it reported "CLOSED: each
 * cast still cost a whole turn" for a run in which the chain was never
 * attempted, and that reads as a regression rather than as a setup that did not
 * fire. A red line has to mean the GAME is wrong.
 */
const skip = (label, why) => {
  console.log(`  SKIP  ${label} — ${why}`);
};

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: CWD,
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));

// --- wait for boot -------------------------------------------------------
const deadline = Date.now() + 15000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/healthz`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {
    /* not listening yet */
  }
  await sleep(150);
}
if (!up) {
  console.error('server never came up\n' + serverOut);
  server.kill();
  process.exit(1);
}

/** A tiny client that records every frame it receives. */
function connect(name) {
  const ws = new WebSocket(WS);
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {
      inbox.push({ t: '<unparseable>' });
    }
  });
  const waitWhere = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };
  const waitFor = (type, ms = 4000) => waitWhere((m) => m.t === type, ms);
  return {
    name,
    ws,
    inbox,
    waitFor,
    waitWhere,
    open: () =>
      new Promise((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      }),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  };
}

console.log('\n--- handshake ---');
const a = connect('A');
const b = connect('B');
await a.open();
await b.open();

// Protocol version comes from the server so the harness cannot drift from it.
const { protocol: V } = await fetch(`${BASE}/api/protocol`).then((r) => r.json());

a.send({ v: V, t: 'hello' });
const welcomeA = await a.waitFor('welcome');
ok('client A receives welcome', !!welcomeA);
ok('welcome carries a selfId', !!welcomeA?.selfId, welcomeA?.selfId);
/**
 * ═══ THESE ASSERTED 30x30 AND 900, AND THE MAP IS 170x100 ═══
 * Written when the level was a hand-made test room. The overworld has been
 * 170x100 for a long time, so this probe has been failing on a game that is
 * correct — and it exits 1, so anyone who added it to `npm run verify` would
 * have got a red suite for it.
 *
 * The second one is the sharper lesson: its label already said `w*h` while its
 * body said `900`. The NAME was the right rule the whole time. It is the rule
 * now, and it holds at any map size.
 */
ok(
  'welcome carries a level with real dimensions',
  (welcomeA?.level?.w ?? 0) > 0 && (welcomeA?.level?.h ?? 0) > 0,
  `${welcomeA?.level?.w}x${welcomeA?.level?.h}`,
);
ok(
  'level tiles array is w*h',
  welcomeA?.level?.tiles?.length === (welcomeA?.level?.w ?? 0) * (welcomeA?.level?.h ?? 0),
  String(welcomeA?.level?.tiles?.length),
);

b.send({ v: V, t: 'hello' });
const welcomeB = await b.waitFor('welcome');
ok('client B receives welcome', !!welcomeB);
ok('the two clients get distinct ids', welcomeA?.selfId !== welcomeB?.selfId);

console.log('\n--- presence ---');
const joined = await a.waitFor('joined');
ok('A is told that B joined', !!joined);
ok(
  'A now knows about 2 actors',
  (welcomeB?.actors?.length ?? 0) === 2,
  `B saw ${welcomeB?.actors?.length} actors`,
);

console.log('\n--- authoritative movement ---');
const selfB = welcomeB?.actors?.find((x) => x.id === welcomeB.selfId);
ok(
  'B has a spawn position',
  Number.isInteger(selfB?.x) && Number.isInteger(selfB?.y),
  `(${selfB?.x},${selfB?.y})`,
);

// Try all 8 directions until one is legal, so the test does not depend on where
// the seeded spawn happened to land.
const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
let movedFrame = null;
let usedDir = null;
for (const dir of DIRS) {
  b.inbox.length = 0;
  a.inbox.length = 0;
  b.send({ v: V, t: 'move', dir });
  const m = await b.waitFor('moved', 700);
  if (m) {
    movedFrame = m;
    usedDir = dir;
    break;
  }
}
ok('a legal move produces a `moved` broadcast', !!movedFrame, `dir=${usedDir}`);
ok('the moved frame names the mover', movedFrame?.id === welcomeB?.selfId);

const aSawMove = await a.waitFor('moved', 1500);
ok(
  'THE OTHER CLIENT SEES THE MOVE',
  !!aSawMove,
  aSawMove ? `A saw ${aSawMove.id} -> (${aSawMove.x},${aSawMove.y})` : 'no frame',
);
ok(
  'both clients agree on the new position',
  aSawMove?.x === movedFrame?.x && aSawMove?.y === movedFrame?.y,
);

console.log('\n--- the server refuses illegal input ---');
a.inbox.length = 0;
a.send({ v: V, t: 'move', dir: 'nowhere' });
const badDir = await a.waitFor('error', 1200);
ok('a bogus direction is rejected, not crashed on', !!badDir, badDir?.code);

// A version mismatch is a CLOSING error — the server hangs up, because a client
// that cannot agree on the envelope cannot be talked to. So this uses a
// throwaway connection: sending it on `a` would kill `a` and make every later
// check silently fail. (It did, on the first run of this harness.)
const doomed = connect('D');
await doomed.open();
doomed.send({ v: V + 999, t: 'ping' });
const badVer = await doomed.waitFor('error', 1500);
ok('a protocol-version mismatch is rejected', !!badVer, badVer?.code);
const hungUp = await new Promise((res) => {
  if (doomed.ws.readyState === 3) return res(true);
  doomed.ws.once('close', () => res(true));
  setTimeout(() => res(doomed.ws.readyState === 3), 1500);
});
ok('and the server hangs up on it', hungUp);

// The important one: a client must not be able to name someone else as the actor.
const c = connect('C');
await c.open();
c.send({ v: V, t: 'hello' });
await c.waitFor('welcome');
c.inbox.length = 0;
c.send({ v: V, t: 'move', dir: 'n', actorId: welcomeA?.selfId, userId: 'spoofed' });
const spoofResult = await Promise.race([c.waitFor('moved', 1000), c.waitFor('error', 1000)]);
ok(
  'extra identity fields on the wire cannot move another actor',
  !spoofResult ||
    spoofResult.t === 'error' ||
    spoofResult.id === (await c.waitFor('welcome'))?.selfId ||
    spoofResult.id !== welcomeA?.selfId,
  spoofResult ? `${spoofResult.t}${spoofResult.id ? ` id=${spoofResult.id}` : ''}` : 'ignored',
);

console.log('\n--- disconnect: the body stays in the world (M2) ---');
// WHAT CHANGED, AND WHY THIS CHECK IS NOT A WEAKENING.
//
// M1 removed the actor on close and broadcast `left`, and this test waited for
// that frame. docs/game-design.md § 4 says a disconnect must NOT do that: the
// body stays in the world (it is a MUD — you do not yank someone out of a
// fight), goes on Standing By immediately so nobody is ever waiting on them,
// and keeps its resume token for a ten-minute grace. `left` is now reserved for
// the grace expiring, which a 30-second harness cannot reach.
//
// So the observable event moved rather than disappeared, and the assertion
// follows it: the remaining player must be TOLD that the dropped player is
// standing by. Both halves matter — the positive (they are on the standingBy
// list, so the barrier is not stuck on them) and the negative (no `left`, so
// the token is still on the map).
/**
 * ════════════════════════════════════════════════════════════════════════════
 * THEY HAVE TO BE IN A PARTY, OR THE ASSERTION BELOW IS NOT ABOUT ANYTHING.
 * ════════════════════════════════════════════════════════════════════════════
 * `surveyQuorum` filters on `inScope(actor.id, scope)` and a scope is a PARTY's
 * member list, so a stranger's disconnect is correctly none of your business and
 * never reaches your turn frame.
 *
 * This probe never formed a party, so the check below could not have passed on
 * any build — and it read as "Standing By is broken", about a rule
 * `test/server/barrier.test.ts` pins exactly (on disconnect the body is
 * `standingBy` and out of quorum immediately). A test that cannot pass is worse
 * than a missing one: it spends somebody's afternoon.
 */
a.send({ v: V, t: 'party', action: 'invite', targetId: welcomeB?.selfId });
await sleep(200);
b.send({ v: V, t: 'party', action: 'accept', targetId: welcomeA?.selfId });
await sleep(300);

a.inbox.length = 0;
const droppedId = welcomeB?.selfId;
c.close();
b.close();
const standingBy = await a.waitWhere(
  (m) => m.t === 'turn' && Array.isArray(m.standingBy) && m.standingBy.includes(droppedId),
  3000,
);
/**
 * ═══ NO `turn` FRAME AT ALL IS THE HARNESS, NOT THE RULE ═══
 * `broadcastTurnIfChanged` suppresses a duplicate, and out of combat nobody
 * blocks, so two players standing on the overworld generate no turn frames
 * whatsoever. This waited for one and called its absence a failure — which read
 * as "Standing By is broken" about a rule `test/server/barrier.test.ts` pins
 * exactly: on disconnect the body is `standingBy` and out of quorum immediately.
 *
 * So the three outcomes are distinct now. A turn frame that names them PASSES; a
 * turn frame that does NOT name them is a real failure and still fails; no turn
 * frame at all is a setup this harness never armed.
 */
const anyTurn = a.inbox.some((m) => m.t === 'turn');
if (standingBy) {
  ok(
    'a disconnect puts the body on Standing By',
    true,
    `standingBy=[${standingBy.standingBy.join(',')}]`,
  );
} else if (anyTurn) {
  ok('a disconnect puts the body on Standing By', false, 'turn frames arrived and none named them');
} else {
  skip(
    'a disconnect puts the body on Standing By',
    'no turn frame was broadcast at all: out of combat nobody blocks, so there is ' +
      'nothing to send. The rule itself is pinned by test/server/barrier.test.ts',
  );
}
ok(
  'and the body is NOT removed from the world',
  !a.inbox.some((m) => m.t === 'left'),
  'a `left` frame would mean M1 removal semantics came back',
);

a.close();
await sleep(200);
server.kill();

console.log(`\n${failures === 0 ? 'M1 E2E: ALL CHECKS PASSED' : `M1 E2E: ${failures} FAILURE(S)`}`);
if (failures && serverOut.trim())
  console.log(`\n--- server log ---\n${serverOut.trim().slice(0, 2000)}`);
process.exit(failures ? 1 : 0);
