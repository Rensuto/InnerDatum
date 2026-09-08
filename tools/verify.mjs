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
  /**
   * ════════════════════════════════════════════════════════════════════════
   * THE THREE THAT NEED NO SERVER GO FIRST, AND THEY COST ABOUT A SECOND.
   * ════════════════════════════════════════════════════════════════════════
   * This list was FIVE of the ~25 probes in `tools/`, and a sweep through the
   * other twenty on 2026-09-06 found six defects in one afternoon — two false
   * citations the gate could not see, a probe reporting a regression its own
   * numbers disproved, a skip whose stated reason its own output contradicted,
   * a table of `0/0` presented as a content finding, and refusals counted as
   * answers. None of it was exotic. It was simply unrun.
   *
   * These three are STATIC: no socket, no server, no port, measured at 161ms,
   * 474ms and 431ms. There is no cost argument for leaving them out, and
   * between them they are what surfaced most of that list.
   *
   * THEY REPORT RATHER THAN FAIL, which is why they belong here and not in
   * `npm run check`. `rescue-reach` printing "27 of 27 cannot reach anybody in
   * time" is a finding for a person to rule on, not a red build — the same
   * contract every probe in this file has, stated at the top.
   */
  {
    what: 'talent-costs — every talent cost against the upstream it cites',
    argv: ['tools/talent-costs.mjs'],
  },
  {
    what: 'world — what each named region is made of, and whether anything is in it',
    argv: ['tools/world.mjs'],
  },
  {
    what: 'rescue-reach — how far a downed body is from the way in, against the clock',
    argv: ['tools/rescue-reach.mjs'],
  },
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
    what: 'origin-live — every origin is offered, and the one you pick is the one you get',
    argv: ['tools/origin-live.mjs', '31991'],
  },
  {
    what: 'panels-live — a panel layout reaches the body and a later frame reports it',
    argv: ['tools/panels-live.mjs', '31992'],
  },
  {
    what: 'class-live inspector — its pool reaches its sheet',
    argv: ['tools/class-live.mjs', 'inspector', '31985'],
  },
  /**
   * IT EXITS 1 ON A FAULT, WHICH IS RARE HERE AND IS WHY IT GOES LAST.
   *
   * Every probe above reports; this one ASSERTS, across two sockets — a move
   * broadcast to the other client, a spoofed identity refused, a disconnect
   * leaving the body in the world and naming it Standing By. It was red for
   * three reasons and all three were its own: two assertions written when the
   * level was a 30x30 test room, and a Standing By check that never formed a
   * party, so the dropped body was correctly out of the survivor's scope.
   *
   * Green now, so it can hold the line rather than be a known-red thing nobody
   * runs.
   */
  {
    what: 'e2e-m1 — two clients, a move, a refused spoof, and a disconnect',
    argv: ['tools/e2e-m1.mjs', '31995'],
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
