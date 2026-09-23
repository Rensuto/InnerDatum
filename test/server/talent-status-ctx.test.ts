// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A STATUS A TALENT LAYS GOES THROUGH A CONTEXT — `talentEffectCtx`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `statusFor`, `cureFor` and the daze break in main.ts built their doors with
 * no context, so a talent's stun locked no talents (`STUNNED.activate` asks
 * `ctx.activatableTalents`, physical.lua:495-504) and a talent's sheet effect
 * waited a base turn to fold (`ctx.sheetDirty`). These drive the context the
 * shipped seams now use, and scrape that each of the three is handed it: the
 * seams live inside `buildServer`'s closure, as conditional-passives.test.ts
 * says of the passive view.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { statusApplier } from '../../src/server/engine/effects.ts';
import { talentEffectCtx } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createRng } from '../../src/shared/rng.ts';
import { trained } from '../helpers/trained.ts';

const MAIN = readFileSync(new URL('../../src/server/main.ts', import.meta.url), 'utf8');

function watchman() {
  const world = createWorld('seam-ctx');
  const body = world.addPlayer('p1', 'Dalt');
  const engine = createContentTalentEngine();
  engine.attach('p1', trained(sheetForClass(WATCHMAN)));
  const book = createTalentBook(engine, world);
  return { world, body, book };
}

describe('the talent seams apply statuses through a context', () => {
  it('lets a talent`s stun lock out three ready talents, where no context locked none', () => {
    const table = watchman();
    const ready = table.book.loadoutOf(table.body).map((talent) => talent.id);
    // The setup: enough ready talents for the three upstream takes.
    expect(ready.length, 'the fixture Watchman has too few talents').toBeGreaterThanOrEqual(3);

    // The control, the way the seam was built before: no context, nothing locked.
    const blind = createMvpEffectState();
    statusApplier(blind, createRng('blind'))(table.body, EffectId.Stunned, 3, {});
    expect(
      ready.filter((id) => table.body.cooldowns.has(id)),
      'the control locked talents',
    ).toEqual([]);
    table.body.cooldowns.clear();

    const ctx = talentEffectCtx(table.world, table.book, () => undefined);
    const state = createMvpEffectState();
    statusApplier(state, createRng('seen'), ctx)(table.body, EffectId.Stunned, 3, {});
    const locked = ready.filter((id) => table.body.cooldowns.has(id));
    expect(locked, 'a talent`s stun locked the wrong number of talents').toHaveLength(3);
  });

  it('rebuilds the sheet the moment a sheet effect lands', () => {
    const table = watchman();
    const dirty: string[] = [];
    const ctx = talentEffectCtx(table.world, table.book, (id) => dirty.push(id));
    statusApplier(createMvpEffectState(), createRng('dirty'), ctx)(
      table.body,
      EffectId.OffBalance,
      2,
      {},
    );
    expect(dirty, 'Off Balance`s wielder waited for the next base turn').toContain('p1');
  });

  it('is what all three shipped seams are handed', () => {
    expect(MAIN, 'statusFor builds its door without the seam context').toContain(
      'statusApplier(effects, forWorld.rng, seamCtx(forWorld))',
    );
    expect(MAIN, 'cureFor builds its door without the seam context').toContain(
      'statusCurer(effects, forWorld.rng, seamCtx(forWorld))',
    );
    expect(MAIN, 'the daze break runs without the seam context').toContain(
      'breakDamageSensitive(effects, body, forWorld.rng, seamCtx(forWorld))',
    );
  });
});
