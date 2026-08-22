/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN EVERY LIVE PROBE, IN ORDER, AND SAY WHICH ONES ANSWERED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     npm run verify
 *
 * ═══ WHY THIS EXISTS, AND IT IS THE JOKE THIS PROJECT KEEPS TELLING ═══
 * `tools/status-live.mjs` was written because the status system shipped
 * connected to nothing for a whole milestone. `tools/class-live.mjs` was written
 * because a class shipped that nobody had played. `tools/inert.mjs` was written
 * because four hook dispatchers had no callers and one of them was a passive
 * every character carries.
 *
 * All three are run by HAND. Two manual tools that nobody remembers to run are
 * exactly the rot they were built to find, one level up, and leaving them that
 * way would be a poor joke to leave in a repository that has spent this long
 * learning the lesson.
 *
 * ═══ WHY IT IS NOT IN `npm run check` ═══
 * Each probe boots a real server, opens a real socket, and walks a character
 * into a real fight. That is minutes, not seconds, and `check` runs on every
 * push. A gate slow enough to skip is a gate that gets skipped.
 *
 * It is also legitimately INCONCLUSIVE sometimes: a probe that walks 400 steps
 * without meeting anything, or whose target saves every roll, has proved
 * nothing and is not a failure. `check` must be binary; this must not be.
 *
 * ═══ WHAT A RUN MEANS ═══
 * Each probe exits 0 when it proved its thing OR when it could not reach the
 * question, and non-zero only for a real fault. So a red line here is worth
 * reading immediately; a green one means the seam is live, and the probe's own
 * output says which of the two green cases it was.
 *
 * SEPARATE PORTS, deliberately. The probes boot their own servers and a lingering
 * process from a killed run would otherwise make the next probe talk to the
 * previous one's world — which fails in a way that looks like a game bug.
 */
import { spawn } from 'node:child_process';

const RUNS = [
  { what: 'smoke — the server boots and answers /healthz', argv: ['tools/smoke.mjs'] },
  {
    what: 'status-live — an effect applied on the server reaches a client as a badge',
    argv: ['tools/status-live.mjs', '31981'],
  },
  {
    what: 'class-live redactor — the class marks, and a landed mark pays',
    argv: ['tools/class-live.mjs', 'redactor', '31982'],
  },
  {
    what: 'class-live alchemist — the killing cast is free',
    argv: ['tools/class-live.mjs', 'alchemist', '31983'],
  },
  {
    what: 'class-live watchman — its pool reaches its sheet',
    argv: ['tools/class-live.mjs', 'watchman', '31984'],
  },
  {
    what: 'class-live inspector — its pool reaches its sheet',
    argv: ['tools/class-live.mjs', 'inspector', '31985'],
  },
];

const run = (argv) =>
  new Promise((done) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });

const results = [];
for (const { what, argv } of RUNS) {
  console.log(`\n${'═'.repeat(74)}\n▶  ${what}\n${'═'.repeat(74)}`);
  const code = await run(argv);
  results.push({ what, code });
  // STOPS AT THE FIRST FAULT. A probe that failed leaves a world in whatever
  // state it failed in, and the next one's output would be read against it.
  if (code !== 0) break;
}

console.log(`\n${'═'.repeat(74)}\nverify\n${'═'.repeat(74)}`);
for (const { what, code } of results) {
  console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'}  ${what}`);
}
const failed = results.filter((r) => r.code !== 0);
const skipped = RUNS.length - results.length;
if (skipped > 0) console.log(`  ....  ${String(skipped)} not run — stopped at the first fault`);

if (failed.length === 0) {
  console.log('\nverify OK — every probe answered, and none of them found a fault.');
} else {
  console.log('\nverify FAILED — read the section above the summary; the probe says which seam.');
  process.exit(1);
}
