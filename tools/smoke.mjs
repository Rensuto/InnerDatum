/**
 * Boot smoke test.
 *
 * `tsc --noEmit` proves the types line up. It does NOT prove Node can actually
 * load the module tree — a bad import specifier, a missing `.ts` extension, an
 * `enum` that type stripping refuses, or a top-level throw all pass typecheck
 * and fail at boot. This catches that class in about two seconds.
 *
 * It also pins the shape of /healthz, which the control panel probes from
 * outside the network. If someone helpfully adds `players` or `world` to that
 * response, this fails: the one public route must not leak game state.
 *
 * Exit 0 = healthy. Any other exit = do not push.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.SMOKE_PORT ?? '31337';
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 15_000;

const server = spawn(process.execPath, ['src/server/main.ts'], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));

let exitedEarly = null;
server.on('exit', (code, signal) => {
  exitedEarly = signal ? `signal ${signal}` : `code ${code}`;
});

function fail(msg) {
  console.error(`\nSMOKE FAILED: ${msg}`);
  if (output.trim()) console.error(`\n--- server output ---\n${output.trim()}`);
  server.kill();
  process.exit(1);
}

// Poll rather than sleeping a fixed amount: fast when it works, patient when
// the machine is loaded.
const deadline = Date.now() + BOOT_TIMEOUT_MS;
let health = null;
while (Date.now() < deadline) {
  if (exitedEarly) fail(`server exited during boot (${exitedEarly})`);
  try {
    const res = await fetch(`${BASE}/healthz`);
    if (res.ok) {
      health = await res.json();
      break;
    }
  } catch {
    // not listening yet
  }
  await sleep(150);
}

if (!health) fail(`no response from ${BASE}/healthz within ${BOOT_TIMEOUT_MS} ms`);

// Exact shape, not a superset. Extra keys are the failure we are guarding.
const keys = Object.keys(health).sort();
const want = ['ok', 'uptime', 'version'];
if (keys.length !== want.length || !want.every((k, i) => k === keys[i])) {
  fail(
    `/healthz shape drifted.\n  expected exactly: ${want.join(', ')}\n  got:              ${keys.join(', ')}\n` +
      `  This route is publicly reachable — it must not leak players, sessions or world state.`,
  );
}
if (health.ok !== true) fail(`/healthz reported ok=${JSON.stringify(health.ok)}`);
if (typeof health.version !== 'string') fail('/healthz version must be a string');
if (typeof health.uptime !== 'number') fail('/healthz uptime must be a number');

// The protocol route must answer too — a client that cannot read it has no way
// to detect a version mismatch and will misparse instead.
const proto = await fetch(`${BASE}/api/protocol`)
  .then((r) => r.json())
  .catch(() => null);
if (!proto || typeof proto.protocol !== 'number') {
  fail('/api/protocol did not return { protocol: <number> }');
}

server.kill();
console.log(
  `smoke OK — booted, /healthz { ok, version: ${health.version}, uptime: ${health.uptime}ms }, protocol ${proto.protocol}`,
);
