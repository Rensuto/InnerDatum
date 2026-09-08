// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * DOES A PANEL LAYOUT REACH THE BODY AND COME BACK? Over a real socket.
 *
 * `set_panel_layout` crosses five layers: a zod schema in shared/, a handler in
 * the gateway, a field on the actor, four carry-forward paths in persist/, and
 * an apply on the client. Every one of those has a unit test and NONE of them
 * proves the five are wired to each other -- which is this repo's signature
 * defect, and the reason test/server/monster-casts.test.ts exists at all.
 *
 * WHAT IT PROVES: a layout sent on the wire is stored on the body and reported
 * by a LATER `settings` frame -- a fresh one built from the body, rather than
 * the echo the write itself produced.
 *
 * WHAT IT CANNOT PROVE, and says so rather than pretending: cross-session
 * persistence. An anonymous socket gets a new body per connect, so there is
 * nothing to reload; asking that needs a signed-in character. The FILE half is
 * covered by test/server/save-completeness.test.ts, which round-trips every
 * optional field on `CharacterFile` and refuses to let a new one be added
 * without one -- it caught three carry-forward paths this change had missed.
 *
 *     node tools/panels-live.mjs [port] [protocolVersion]
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PROTOCOL_VERSION = Number(process.argv[3] ?? 20);
const PORT = process.argv[2] ?? '32411';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    continue;
  }
}

/** One connection: hello, choose a class, run `body`, return the frames seen. */
async function session(body) {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (r) => {
    try {
      frames.push(JSON.parse(r.toString()));
    } catch {
      /* not ours */
    }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...m }));
  const last = (t) => frames.filter((f) => f.t === t).at(-1);

  send({ t: 'hello' });
  await sleep(900);
  const opts = last('class_options')?.options ?? [];
  if (opts.length > 0) {
    send({ t: 'choose_class', classId: opts[0].id });
    await sleep(700);
  }
  await body(send, last);
  ws.close();
  await sleep(200);
  return { last };
}

console.log('── one session: set a layout, then ask the server what it holds');
const { last } = await session(async (send, peek) => {
  send({
    t: 'set_panel_layout',
    layout: {
      offsets: { log: { dx: 40, dy: -12 }, sheet: { dx: -8, dy: 6 } },
      logSize: { w: 420, h: 180 },
      logStyle: { font: 13, opacity: 60, spacing: 17 },
    },
  });
  await sleep(500);
  console.log('  echo after the write :', JSON.stringify(peek('settings')?.panels ?? null));

  // A DIFFERENT verb that also triggers `sendSettings`, so the frame we read
  // next is a FRESH one built from the body rather than the echo we just got.
  send({ t: 'set_zoom', zoom: 1 });
  await sleep(500);
});

const panels = last('settings')?.panels ?? null;
console.log('  re-read from the body:', JSON.stringify(panels));

const ok =
  panels?.logStyle?.font === 13 &&
  panels?.logStyle?.opacity === 60 &&
  panels?.logStyle?.spacing === 17 &&
  panels?.logSize?.w === 420 &&
  panels?.logSize?.h === 180 &&
  panels?.offsets?.log?.dx === 40 &&
  panels?.offsets?.sheet?.dy === 6;
console.log(
  ok
    ? '  STORED — the body kept it and a later settings frame reports it'
    : '  LOST — the gateway did not keep it on the body',
);
console.log('  (cross-session persistence needs a signed-in character; an anonymous');
console.log('   socket gets a fresh body per connect, so it cannot be asked here.)');

server.kill();
await sleep(200);
process.exit(ok ? 0 : 1);
