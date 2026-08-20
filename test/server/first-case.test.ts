// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { dangerWord, specFor } from '../../src/server/content/delve.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { fileableCount, isFileable } from '../../src/server/world/casefile.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *    THE GAME HAS TO ASK FOR SOMETHING, AND IT NEVER ASKED FOR ANYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED by playing a first session over the real socket: a brand-new
 * character was told NINE LINES in four minutes and not one of them was a thing
 * to do. Three bearings, a class blurb, a town description, and then silence for
 * two hundred and forty steps.
 *
 * The word "case" was never spoken to a player who had not already closed one.
 * The only line that says it is the receipt — `Filed. 1 of 27.` — which arrives
 * AFTER the fight it is meant to motivate. `casefile.ts` calls the file "the
 * strongest retention mechanic in the genre" and says *"a gap in the file is a
 * thing a player can decide to go and close"*; a gap in a file nobody has
 * mentioned is not a gap, it is a blank screen.
 *
 * ═══ WHY THIS SPAWNS A SERVER ═══
 * Same reason as `passives-wired.test.ts`. The picker consults the realms
 * registry, the authored site table and the real spawn point at once, and a
 * fixture gateway has none of the three — `opts.realms` is undefined there, so a
 * unit-shaped test would exercise the fallback and never the line.
 *
 * ═══ WHICH OF THESE ASSERTIONS ACTUALLY CATCH SOMETHING TODAY ═══
 * ONE of them does: delete the block in `gateway.ts` and this fails on "a new
 * character is still never told the file exists". The rest are GUARDS, verified
 * by reverting each rule in turn and watching the test go on passing, and each
 * one says so at its own site rather than implying a catch it does not make.
 */
describe('the first thing the game asks a new character to do', () => {
  it('opens the file and names one room, and the room is one you can close', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'inner-datum-firstcase-'));
    const port = 31947;
    const server = spawn(process.execPath, ['src/server/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'error',
        DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
      let up = false;
      for (let i = 0; i < 80 && !up; i += 1) {
        try {
          up = (await fetch(`http://127.0.0.1:${String(port)}/healthz`)).ok;
        } catch {
          /* not listening yet */
        }
        if (!up) await sleep(250);
      }
      expect(up, 'the server never came up').toBe(true);

      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
      const lines: { lane?: string; text?: string }[] = [];
      const frames: Record<string, unknown>[] = [];
      socket.addEventListener('message', (ev: MessageEvent) => {
        for (const raw of String(ev.data).split('\n')) {
          if (raw.trim() === '') continue;
          try {
            const frame = JSON.parse(raw) as Record<string, unknown>;
            frames.push(frame);
            if (frame['t'] === 'log') {
              for (const line of (frame['lines'] ?? []) as { lane?: string; text?: string }[]) {
                lines.push(line);
              }
            }
          } catch {
            /* a frame this test does not care about */
          }
        }
      });
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      const send = (body: Record<string, unknown>): void =>
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body }));

      send({ t: 'hello' });
      await sleep(900);

      // ═══ THE HALF THAT MUST NOT MOVE ═══
      // Before a class is taken up the game says nothing about a file. That is
      // the pre-state of the bug and it is also the rule: the line belongs to
      // the one moment that is unambiguously a beginning, and a body with no
      // class has not begun. It also keeps the line from riding `announceArrival`,
      // which fires again on every threshold for the rest of the character's
      // life.
      expect(
        lines.filter((l) => /your file is open/i.test(l.text ?? '')),
        'the file opened before the character existed',
      ).toHaveLength(0);

      const options = (frames.find((f) => f['t'] === 'class_options')?.['options'] ?? []) as {
        id: string;
      }[];
      expect(options.length, 'no classes were offered').toBeGreaterThan(0);
      send({ t: 'choose_class', classId: options[0]?.id });
      await sleep(1200);

      // ═══ THE ASSERTION THAT WAS FAILING, AND THE ONE LIVE COUNTERFACTUAL ═══
      // Verified by deleting the block: "expected undefined to be defined".
      const opened = lines.find((l) => /your file is open/i.test(l.text ?? ''));
      expect(opened, 'a new character is still never told the file exists').toBeDefined();
      expect(opened?.lane, 'advice belongs in the margin, not the record').toBe('margin');
      expect(opened?.text).toContain(String(fileableCount(SITES)));

      const start = lines.find((l) => /^start with /i.test(l.text ?? ''));
      expect(start, 'the game opened a file and then named nothing to put in it').toBeDefined();
      // The line is `Start with NAME — grade, bearing, N tiles. ...` and a
      // room name may hold spaces, so the em dash is the separator, not a gap.
      const halves = (start?.text ?? '').replace(/^Start with /, '').split(' — ');
      const named = halves[0];
      expect(named, `could not read a room out of: ${String(start?.text)}`).toBeDefined();

      const site = [...SITES.values()].find((s) => s.name === named);
      expect(site, `named a place that is not in SITES: ${String(named)}`).toBeDefined();

      /**
       * ═══ A ROOM, NOT A TOWN — AND THIS ONE IS A GUARD, NOT A CATCH ═══
       * The nearest site to the spawn is Alderbrook, a town, TWO tiles away
       * against the sixteen of the room actually named. So the stake is real:
       * name a town and a beginner walks two tiles, finds a shop, and learns
       * that the game's instructions do not mean anything.
       *
       * BUT DROPPING `isFileable` DOES NOT PRODUCE THAT — verified, the test
       * still passes. A town has no delve spec either, so the grade lookup
       * excludes it first. Two predicates, one answer, today. This assertion
       * pins the ANSWER so that either predicate may be the one that fails.
       */
      expect(site !== undefined && isFileable(site), `${String(named)} can never be filed`).toBe(
        true,
      );

      /**
       * ═══ AND NEVER A PLACE YOU ARE MEANT TO FIND ═══
       * Three sites are `hidden` and withheld until your own fog holds them; the
       * arrival bearings read all three out by name until three commits ago.
       *
       * ALSO A GUARD. The nearest hidden site is Barrow End at 23 tiles, behind
       * the named room at 16 and graded `dangerous` on top of that, so removing
       * the fog check changes nothing today — verified. It is here because this
       * is the third reader of that rule and the first two were both wrong.
       */
      expect(site?.hidden ?? false, `${String(named)} is a hidden site`).toBe(false);

      /**
       * ═══ THE GENTLEST GRADE AVAILABLE — GUARD, AND HERE IS WHY ═══
       * There is exactly ONE `quiet` room in the game and it is also the nearest
       * fileable one, so a distance-only sort picks the same room and this
       * passes either way. STATED, not implied.
       *
       * It earns its keep the day a second quiet room is authored or the spawn
       * moves. The failure it exists to prevent is a level-1 character walking
       * into `grim` because the only instruction the game ever gave them said to.
       */
      const grades = [...SITES.values()]
        .filter((s) => isFileable(s) && s.hidden !== true)
        .map((s) => specFor(s.id))
        .filter((spec) => spec !== undefined)
        .map((spec) => dangerWord(spec));
      const order = ['quiet', 'restless', 'dangerous', 'grim'];
      const gentlest = order.find((g) => grades.includes(g));
      const namedGrade = (halves[1] ?? '').split(',')[0];
      expect(namedGrade, 'the line carries no grade').toBeDefined();
      expect(
        namedGrade,
        `named a ${String(namedGrade)} room with a ${String(gentlest)} available`,
      ).toBe(gentlest);

      socket.close();
    } finally {
      server.kill();
      await sleep(200);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45_000);
});
