// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { canWalk } from '../../src/shared/level.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import { findPath } from '../../src/shared/path.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *       THE BLOW THAT KILLS YOU IS NOT STRUCK BY "SOMEONE".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED by walking a level-1 Watchman into an ambush over the real socket and
 * standing still until it killed him:
 *
 *     Index Wraith hits Player 1.   15 damage.  Player 1 2/72.
 *     someone hits Player 1.         3 damage.  Player 1 0/72.
 *     Player 1 is DOWN — 5 turns, and nobody is coming.
 *
 * Every line in the fight names its monster except the one that ends it. A
 * server-side trace gave the id as `realm:site:encounter:1:mon_index_husk`, and
 * `realmOf` scans LIVE worlds — so it found nothing, `homeOf` fell through to
 * the fixture realm (the same fallback that once made every passive inert), and
 * `nameOf` reached its last resort.
 *
 * The cause is a solo player's survivor count hitting zero the instant they
 * fall: the wipe and the floor reset run in the SAME PUMP as the blow, and a
 * reset removes every hostile in the room — that is its whole job, "a reset
 * means the fight did not happen". Nothing was reaped. The room simply stopped
 * existing before the log was written.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SPAWNS A SERVER INSTEAD OF USING THE REAP HARNESS NEXT DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 * `reap-broadcast.test.ts` already asserts that no line says "someone", and it
 * passes — it boots ONE world with no realms and no party table, so a solo body
 * on the floor raises no wipe and no reset there. Reaching this failure inside
 * that harness means giving it parties, enrolment, engagement and scopes, at
 * which point its other six tests are describing a different world: with a party
 * table a body "merely on the floor" IS a wipe, and the `left` frames they
 * correctly forbid start arriving.
 *
 * So the guard runs where the bug lives. This is the same argument
 * `passives-wired.test.ts` makes, and the same one that found that bug: the
 * break was in the wiring, one layer above everything the unit tests cover.
 *
 * It is slow — a real walk into a real ambush — and that is the price of the
 * only instrument that has ever seen this failure.
 */
describe('a death in a room that resets', () => {
  it('names whoever struck the killing blow', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'inner-datum-killer-'));
    const port = 31973;
    const server = spawn(process.execPath, ['src/server/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'error',
        DATA_DIR: dataDir,
        /**
         * ═══════════════════════════════════════════════════════════════════
         * NO WORLD CLOCK, BECAUSE THIS TEST SCRIPTS A WALK.
         * ═══════════════════════════════════════════════════════════════════
         *
         * The tide (net/gateway.ts) turns a shared realm's game turn over every
         * couple of seconds whether or not anybody acts, which is what stops the
         * moor being frozen when nobody is walking and running six times too
         * fast when six people are.
         *
         * It also drifts the roamers WHILE THIS TEST PATHS 106 TILES ACROSS
         * THEM. That is the feature working, and it is precisely what makes a
         * scripted walk non-deterministic: bump into a wanderer on the way and
         * you arrive at a different encounter than the one this test chose for
         * being dangerous enough to die in. Measured: with the tide on, the walk
         * completes and the player never reaches the room they set out for.
         *
         * So this is not the feature being switched off for being inconvenient
         * — it is this test declaring that it measures KILL ATTRIBUTION and
         * wants the world to hold still while it does. The tide's own behaviour
         * is measured in test/server/tide.test.ts, and over a real socket.
         */
        TIDE_MS: '0',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
      let up = false;
      for (let i = 0; i < 120 && !up; i += 1) {
        try {
          up = (await fetch(`http://127.0.0.1:${String(port)}/healthz`)).ok;
        } catch {
          /* not listening yet */
        }
        if (!up) await sleep(250);
      }
      expect(up, 'the server never came up').toBe(true);

      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
      const frames: Record<string, unknown>[] = [];
      const lines: string[] = [];
      const events: Record<string, unknown>[] = [];
      socket.addEventListener('message', (ev: MessageEvent) => {
        for (const raw of String(ev.data).split('\n')) {
          if (raw.trim() === '') continue;
          try {
            const frame = JSON.parse(raw) as Record<string, unknown>;
            frames.push(frame);
            // EVERY LANE THAT CARRIES EVENTS, not just `sweep` — the immediate
            // lane sends one thing on its own and a death can land in either.
            for (const ev of (frame['events'] ?? []) as Record<string, unknown>[]) events.push(ev);
            if (typeof frame['k'] === 'string') events.push(frame);
            if (frame['t'] === 'log') {
              for (const line of (frame['lines'] ?? []) as { text?: string }[]) {
                lines.push(line.text ?? '');
              }
            }
          } catch {
            /* a frame this test does not read */
          }
        }
      });
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      const send = (body: Record<string, unknown>): void =>
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body }));

      send({ t: 'hello' });
      await sleep(1200);
      const selfId = frames.find((f) => f['t'] === 'welcome')?.['selfId'] as string | undefined;
      const options = (frames.find((f) => f['t'] === 'class_options')?.['options'] ?? []) as {
        id: string;
      }[];
      send({ t: 'choose_class', classId: options[0]?.id });
      await sleep(1000);

      const realm = (): Record<string, unknown> | undefined =>
        frames.filter((f) => f['t'] === 'realm').at(-1);
      // `LevelView` IS WHAT `canWalk` TAKES, so the frame's level is handed over
      // as itself rather than through a structural stand-in — the compiler then
      // proves the shape instead of an assertion promising it.
      const level = (): LevelView => realm()?.['level'] as LevelView;

      let me = { x: 0, y: 0 };
      for (const f of frames) {
        if (f['t'] === 'welcome' || f['t'] === 'state' || f['t'] === 'realm') {
          const who = (f['actors'] ?? []) as { id: string; x: number; y: number }[];
          const mine = who.find((a) => a.id === selfId);
          if (mine !== undefined) me = { x: mine.x, y: mine.y };
        }
        if (f['t'] === 'moved' && f['id'] === selfId) {
          me = { x: f['x'] as number, y: f['y'] as number };
        }
      }

      /**
       * THE WORST ROOM ON THE MAP, so a level-1 character reliably loses. The
       * grade is on the wire precisely so this does not have to name a site.
       */
      const sites = (frames.filter((f) => f['t'] === 'sites').at(-1)?.['sites'] ?? []) as {
        x: number;
        y: number;
        name: string;
        danger?: string;
      }[];
      const target =
        sites.find((s) => s.danger === 'grim') ?? sites.find((s) => s.danger === 'dangerous');
      expect(target, 'no dangerous room on the map to die in').toBeDefined();
      if (target === undefined) return;

      // WALK ROUND THE OTHER DOORS. Stepping onto a site's cell enters it, so a
      // straight line to a far marker is swallowed by the first town it crosses.
      const closed = new Set(
        sites.filter((s) => s.name !== target.name).map((s) => `${String(s.x)},${String(s.y)}`),
      );
      const board = level();
      const passable = (x: number, y: number): boolean =>
        x >= 0 &&
        y >= 0 &&
        x < board.w &&
        y < board.h &&
        canWalk(board, x, y) &&
        !closed.has(`${String(x)},${String(y)}`);
      const steps = findPath(me, { x: target.x, y: target.y }, passable, { maxNodes: 400_000 });
      expect(steps, 'no route to anywhere dangerous').not.toBeNull();

      let cursor = me;
      for (const step of steps ?? []) {
        const dx = Math.sign(step.x - cursor.x);
        const dy = Math.sign(step.y - cursor.y);
        const dir = `${dy < 0 ? 'n' : dy > 0 ? 's' : ''}${dx < 0 ? 'w' : dx > 0 ? 'e' : ''}`;
        if (dir !== '') send({ t: 'move', dir });
        cursor = step;
        await sleep(22);
        if (realm()?.['kind'] === 'inner') break;
      }
      await sleep(600);

      // STAND STILL AND LET IT HAPPEN. `hold` is a real action and spends the
      // turn, so the room gets to act; a died-of-nothing setup would not.
      for (let i = 0; i < 400; i += 1) {
        send({ t: 'hold' });
        send({ t: 'commit' });
        await sleep(35);
        if (lines.some((l) => /is DOWN|erased/i.test(l))) break;
      }
      await sleep(800);

      // ═══ THE SETUP HAS TO HAVE WORKED BEFORE THE CLAIM MEANS ANYTHING ═══
      // A run that never reached a fight would pass the assertion below by
      // saying nothing at all, which is the vacuous green this file exists to
      // avoid.
      expect(
        lines.some((l) => /is DOWN|erased/i.test(l)),
        `never died — log was: ${lines.slice(-6).join(' | ')}`,
      ).toBe(true);
      expect(
        lines.filter((l) => /hits Player/.test(l)).length,
        'never took a blow',
      ).toBeGreaterThan(0);

      // ═══ THE ASSERTION THAT WAS FAILING ═══
      expect(
        lines.filter((l) => l.includes('someone')),
        `anonymous lines: ${lines.slice(-8).join(' | ')}`,
      ).toEqual([]);

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE DOWNED LINE NAMES WHAT DID IT, OR SAYS NOTHING — NEVER A
       * DANGLING CLAUSE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `DownedEvent.sourceId` was declared on the wire and filled by nothing;
       * the line read "Player 1 is DOWN — 5 turns, and nobody is coming" with no
       * cause, at the one moment a player is reading carefully.
       *
       * THE SOLO CASE IS THE HARD ONE and it is the one this file exists for: a
       * lone death raises a wipe and a floor reset in the SAME pump, the reset
       * removes every hostile, and all three name lookups can miss. So the rule
       * is not "always names somebody" — it is that the sentence is never left
       * half-built. `by ` with nothing after it, or "by someone", are the two
       * failures, and the assertion above already forbids the second.
       */
      const down = lines.filter((l) => /is DOWN/.test(l));
      expect(down.length, `no DOWN line: ${lines.slice(-6).join(' | ')}`).toBeGreaterThan(0);
      for (const line of down) {
        expect(line, `dangling attribution: ${line}`).not.toMatch(/is DOWN by\s*(—|$)/);
      }
      // MEASURED, not assumed — printed so a human reading a failure sees the
      // sentence a player would have seen.
      console.log(`DOWNED LINE: ${down.join(' | ')}`);

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE SCREEN. THE LOG IS NOT THE SCREEN, AND THIS IS WHERE THEY PART.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Everything above measures the TRANSCRIPT. A player who has just died is
       * not reading a transcript, and the death plate they are looking at
       * instead is driven by `PartyMember.downed` — a projection of a record
       * that `resetFloorParty` DELETES inside the pump that raised the death.
       * For a solo player, whose death and whose wipe are the same event, the
       * plate therefore had nothing to draw from on any frame, ever.
       *
       * So the plate is driven off `erased`/`wipe` instead, and this asserts the
       * two frames it needs actually arrive — over the socket, from the real
       * death this test already stages. Without it the client change is an
       * assumption about a wire nobody has looked at.
       */
      const mine = events.filter((e) => e['id'] === selfId);
      const downEv = mine.filter((e) => e['k'] === 'downed');
      const erasedEv = mine.filter((e) => e['k'] === 'erased');
      console.log(
        `EVENTS: ${mine
          .map((e) => {
            const why = e['reason'];
            return `${String(e['k'])}${typeof why === 'string' ? `/${why}` : ''}`;
          })
          .join(', ')}`,
      );

      expect(downEv.length, 'no `downed` event reached the client').toBeGreaterThan(0);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND NOBODY TOLD THEM THEY WERE DEAD FOR GOOD.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * This instrument is what found it. The stream it measured, in the order
       * the client received it:
       *
       *     damage x13, death, downed, erased/wipe, damage
       *
       * `killed` is `applyDamage`'s answer and is true of any body taken to 0 —
       * for a player that is the Downed state, `alive === false` on purpose. The
       * Record lane renders `death` as "X is unfiled.", the game's word for a
       * monster removed for good, so the transcript read "Player 1 is unfiled."
       * and then "Player 1 is DOWN — 5 turns". Two lines about one body
       * disagreeing about whether the run was over, wrong one first.
       */
      expect(
        mine.filter((e) => e['k'] === 'death'),
        'a DOWNED player was announced as permanently dead',
      ).toEqual([]);

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND EVERY BLOW SAYS WHAT KIND IT WAS.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The Case Log printed "7 damage. Dalt 41/58." for every source of damage
       * in the game, so a critical hit from a Redacted's darkness was
       * indistinguishable from a graze off a husk's fist. `combat.ts` has
       * computed `type` and `crit` since M3 — `Blow` dropped the first and
       * `hitToWire` dropped the second, one field per hop.
       *
       * ASSERTED HERE, over a real socket, because this is the ATTACK path: the
       * unit tests next door drive a status, and the swing is the case that
       * traverses `attackTarget -> Blow -> attacked -> hitToWire -> the wire`
       * and had two chances to lose something on the way.
       */
      const hits = mine.filter((e) => e['k'] === 'damage' && Number(e['amount'] ?? 0) > 0);
      expect(hits.length, 'nothing hit the player — the probe is not measuring').toBeGreaterThan(0);
      const typed = hits.filter((e) => typeof e['type'] === 'string');
      expect(
        typed.length,
        `a blow arrived with no type: ${JSON.stringify(hits.filter((e) => e['type'] === undefined))}`,
      ).toBe(hits.length);
      expect(erasedEv.length, 'no `erased` event reached the client').toBeGreaterThan(0);
      // THE REASON IS THE WHOLE POINT: a timer erasure keeps its record and the
      // frame-driven plate still works for it. Only `wipe` is unreachable that
      // way, and only `wipe` happens to somebody playing alone.
      expect(
        erasedEv.map((e) => e['reason']),
        'a solo death must be a WIPE — nobody was left standing',
      ).toContain('wipe');

      socket.close();
    } finally {
      server.kill();
      await sleep(200);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
