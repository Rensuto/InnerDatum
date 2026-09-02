// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { COMMAND_BURST, COMMAND_GAP_MS, COMMAND_RATE_PER_SEC } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SCRIPTED CLIENT MAY OUTRUN THE SERVER'S RATE LIMIT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway drops every command past `COMMAND_RATE_PER_SEC` and tells the
 * sender AT MOST ONCE A SECOND. That combination is the whole problem: a probe
 * going too fast sees one error line and then silently loses commands for the
 * rest of the run, while still reaching an end state and still satisfying every
 * assertion it makes — about a walk that did not happen.
 *
 * ═══ IT COST THIS REPOSITORY THREE FALSE DIAGNOSES ═══
 * `killer-named.test.ts` fired a move every 22ms — forty-five a second — turned
 * 106 planned steps into 67 real ones, stopped 27 tiles short of the room it
 * names, and passed for months by dying to a roamer it met on the way. The
 * failure was blamed on roamer density twice and on a talent's range once. It
 * was this, every time.
 *
 * So the rule gets a mechanism, and the mechanism reads the source rather than a
 * list: every `await sleep(N)` that PACES a command has to leave at least
 * `COMMAND_GAP_MS` per command sent.
 */

/** Files that drive a socket: the probes, and every test that opens one. */
function drivers(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.mjs')) {
        out.push(`${dir}${entry.name}`);
      }
    }
  };
  walk('../../tools/');
  walk('../../test/');
  return out;
}

const SLEEP = /await sleep\((\d+)\)/;
const SEND = /(?<![\w.])(?:\w+\.)?send\(/g;
const LOOP = /\b(?:while|for)\s*\(/;

/**
 * How many commands this `sleep` is pacing, or zero if it is not pacing any.
 *
 * ═══ THE DISCRIMINATOR IS WHICH COMES FIRST WALKING BACKWARDS ═══
 * A sleep inside a POLL loop — *"send once, then wait for the frame"* — is not
 * pacing anything and may be as short as it likes; `draught-loop.test.ts` walks
 * through a door that way with a 10ms poll, correctly. A sleep pacing a SEND
 * loop is the one that matters.
 *
 * Reading back from the sleep, whichever we meet first decides: a `send` means
 * the sends are in the same body as the sleep and it is pacing them; a loop
 * header means the send was left behind outside the loop and this is a poll.
 * Getting this backwards flags the honest poll and misses the real offender,
 * which is what the first two versions of this function did.
 */
function pacedCommands(lines: readonly string[], at: number): number {
  let sends = 0;
  for (let k = at - 1; k >= 0 && k >= at - 4; k -= 1) {
    const line = lines[k] ?? '';
    const found = line.match(SEND)?.length ?? 0;
    if (found > 0) {
      sends += found;
      continue;
    }
    if (LOOP.test(line)) break;
  }
  return sends;
}

describe('the command rate limit', () => {
  it('leaves a gap a client can actually keep to', () => {
    /**
     * THE ARITHMETIC FLOOR IS EXACTLY THE LIMIT, which is why the gap is not it.
     * Fifty milliseconds is twenty a second on paper and twenty-one the moment
     * either end hiccups, and the penalty for going one over is a dropped
     * command the sender is not told about.
     */
    expect(COMMAND_GAP_MS).toBeGreaterThan(1000 / COMMAND_RATE_PER_SEC);
    // AND THE BURST IS THE RATE — a client may spend a second's worth at once
    // (a reconnect replay does) and then refills. If these ever diverge, the
    // gap above is no longer the whole story and this test should say so.
    expect(COMMAND_BURST).toBe(COMMAND_RATE_PER_SEC);
  });

  it('is one number, and the gateway does not keep a second copy', () => {
    // These were module-private in the gateway, which is exactly why every
    // scripted client picked its own interval by feel.
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway, 'the gateway has re-declared the rate').not.toMatch(
      /const COMMAND_RATE_PER_SEC\s*=/,
    );
    expect(gateway).toMatch(
      /COMMAND_RATE_PER_SEC[\s\S]{0,200}from '\.\.\/\.\.\/shared\/version\.ts'/,
    );
  });

  it('is respected by every probe and socket test that paces its commands', () => {
    const offences: string[] = [];
    for (const rel of drivers()) {
      const lines = readFileSync(new URL(rel, import.meta.url), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const ms = SLEEP.exec(lines[i] ?? '');
        if (ms === null) continue;
        const sends = pacedCommands(lines, i);
        if (sends === 0) continue;
        const need = COMMAND_GAP_MS * sends;
        const got = Number(ms[1]);
        if (got < need) {
          offences.push(
            `${rel.replace('../../', '')}:${String(i + 1)} sleeps ${String(got)}ms ` +
              `after ${String(sends)} command(s) — needs ${String(need)}`,
          );
        }
      }
    }
    expect(
      offences,
      `these lose commands to the rate limiter and will not be told:\n  ${offences.join('\n  ')}`,
    ).toEqual([]);
  });
});
