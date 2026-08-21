// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PASSIVE HAS TO REACH THE BODY, AND NOT ONE OF THEM EVER DID.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `refreshPassives` in `src/server/main.ts` resolved the player with
 * `world.getActor(actorId)` against the STANDALONE world built for fixtures.
 * Players are not in that one — `gateway.ts` places every body into
 * `opts.realms?.overworld.world`, and `createRealms` builds its own worlds from
 * a seed. So the lookup returned undefined, the early return skipped the write,
 * and `actor.passiveCombat` was never set for anybody.
 *
 * Measured through the real protocol against a real server, before the fix:
 *
 *     Strength 24   Constitution 20   Accuracy 8    Damage 12-13
 *     Armour 6      Defence 4         Phys save 15  Spell save 8
 *
 * every one of them the authored class base, against twenty-four passives that
 * grant exactly those channels. After:
 *
 *     Strength 25   Constitution 21   Accuracy 9    Damage 13-14
 *     Armour 8      Defence 5         Phys save 22  Spell save 11
 *
 * ═══ WHY THIS TEST SPAWNS A SERVER INSTEAD OF CALLING A FUNCTION ═══
 * Nothing in `test/` had ever driven `buildServer`. Every talent test in the
 * tree passes with this bug present, because they exercise the ENGINE — the
 * sheet, the contribution, `recomposeCombat` — and the break was in the WIRING
 * one layer above them, in the file no test imports. A unit test of the same
 * shape as the existing ones would have gone on passing.
 *
 * `DATA_DIR` is pointed at a temp directory: the real `data/` holds live save
 * files and this must never write there.
 */
describe('the passives a class ships with reach the character', () => {
  it('gives a Watchman more armour than his class base', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'inner-datum-passives-'));
    const port = 31931;
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
      const frames: Record<string, unknown>[] = [];
      socket.addEventListener('message', (ev: MessageEvent) => {
        for (const line of String(ev.data).split('\n')) {
          if (line.trim() === '') continue;
          try {
            frames.push(JSON.parse(line) as Record<string, unknown>);
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
      const welcome = frames.find((f) => f['t'] === 'welcome');
      const selfId = welcome?.['selfId'] as string | undefined;
      expect(selfId, 'no welcome').toBeDefined();

      const options = (frames.find((f) => f['t'] === 'class_options')?.['options'] ?? []) as {
        id: string;
        name: string;
      }[];
      const watchman = options.find((o) => /watch/i.test(o.id));
      expect(watchman, 'the Watchman was not offered').toBeDefined();

      send({ t: 'choose_class', classId: watchman?.id });
      await sleep(900);
      send({ t: 'inspect', targetId: selfId });
      await sleep(700);

      const view = frames.filter((f) => f['t'] === 'inspected').at(-1)?.['view'] as
        { rows?: { label: string; value: string }[] } | undefined;
      const rows = view?.rows ?? [];
      expect(rows.length, 'the sheet came back empty').toBeGreaterThan(0);

      const armour = Number(rows.find((r) => /armour/i.test(r.label))?.value ?? '0');
      const base = WATCHMAN.combat.mods?.armour ?? 0;

      // ═══ THE ASSERTION THAT WAS FAILING ═══
      // It read exactly `base`. Standing Orders and Issued Kit grant +1 each at
      // rank 1, so a wired passive layer must read strictly above the base.
      expect(base, 'the fixture class still has authored armour').toBeGreaterThan(0);
      expect(
        armour,
        `armour ${String(armour)} against a class base of ${String(base)}`,
      ).toBeGreaterThan(base);

      /**
       * ═══ AND THE HIT-POINT CEILING, WHICH IS NOW DERIVED ═══
       * `maxHp` used to be an authored constant copied onto the body once. It is
       * now recomputed inside the same `refreshPassives` fold this test exists
       * to guard — `classBase + Σ level gains + 4 × Constitution spent` — so the
       * fold now has TWO ways to be wrong, and the second one is silent: a
       * fresh character whose ceiling came back inflated or crushed would look
       * completely normal on the sheet.
       *
       * A LEVEL-1 CHARACTER WITH NOTHING SPENT MUST READ EXACTLY THE CLASS BASE.
       * That is the safety property of the whole change — everyone already
       * playing keeps the body they had — and it is worth an equality rather
       * than a bound, because both of the ways this can break move the number.
       */
      const body = (frames.filter((f) => f['t'] === 'state').at(-1)?.['actors'] ??
        welcome?.['actors'] ??
        []) as { id: string; hp?: number; maxHp?: number }[];
      const self = body.find((a) => a.id === selfId);
      expect(self, 'the player is not in any projection').toBeDefined();
      expect(
        self?.maxHp,
        `a fresh Watchman reads ${String(self?.maxHp)} against a class base of ${String(WATCHMAN.maxHp)}`,
      ).toBe(WATCHMAN.maxHp);
      // AND IS AT FULL, because the clamp must not have bitten a body it had no
      // business touching.
      expect(self?.hp).toBe(WATCHMAN.maxHp);

      socket.close();
    } finally {
      server.kill();
      await sleep(200);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45_000);
});
