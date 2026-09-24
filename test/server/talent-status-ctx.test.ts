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
 * shipped seams now use, and drive the realm's own assembly
 * (`realmTalentRuntime`) to show its status door is built with it.
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
import { INDEX_HUSK_ELITE, monsterInit } from '../../src/server/content/monsters.ts';
import { isMonster } from '../../src/server/engine/actor.ts';
import { effectsOn, statusApplier } from '../../src/server/engine/effects.ts';
import { realmTalentRuntime, talentEffectCtx } from '../../src/server/main.ts';
import { bearDown } from '../../src/server/talents/bear_down.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import { trained } from '../helpers/trained.ts';

const MAIN = readFileSync(new URL('../../src/server/main.ts', import.meta.url), 'utf8');

function watchman() {
  const world = createWorld('seam-ctx');
  const body = world.addPlayer('p1', 'Dalt');
  const engine = createContentTalentEngine();
  engine.attach('p1', trained(sheetForClass(WATCHMAN)));
  const book = createTalentBook(engine, world);
  return { world, body, book, engine };
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

  it('is what the realm’s own status door is built with — a monster’s stun locks three', () => {
    // DRIVEN THROUGH `realmTalentRuntime`, the assembly every realm and every
    // probe runs: the elite's Bear Down through `runtime.use`, onto a Watchman
    // with a sheet, and the stun locks three of his ready talents.
    const table = watchman();
    table.world.level.tiles.fill(TileCode.FLOOR);
    table.body.x = 5;
    table.body.y = 5;
    table.body.combat = { ...table.body.combat, mods: { ...table.body.combat?.mods, def: 0 } };
    const elite = table.world.addMonster('m1', monsterInit(INDEX_HUSK_ELITE, { x: 6, y: 5 }, 1));
    const effects = createMvpEffectState();
    const runtime = realmTalentRuntime(table.engine, effects, table.world, () => undefined);
    const ready = table.book.loadoutOf(table.body).map((talent) => talent.id);

    // AS THE AI DOES: `castable` attaches the monster's sheet the first time it
    // asks, and offers what it could cast.
    if (!isMonster(elite) || runtime.castable === undefined) throw new Error('fixture');
    expect(runtime.castable(elite, table.body).map((cast) => cast.talentId)).toContain(bearDown.id);
    const out = runtime.use(elite, bearDown.id, { x: 5, y: 5 });
    expect(out, 'Bear Down was refused').toMatchObject({ ok: true });
    // THE PRECONDITION: the stun landed (a made save would lock nothing).
    expect(effectsOn(effects, 'p1').map((e) => e.effectId)).toContain(EffectId.Stunned);
    expect(ready.filter((id) => table.body.cooldowns.has(id))).toHaveLength(3);
  });

  it('builds the cure and the daze break with the same context', () => {
    // Scraped, because neither has a talent this file can drive cheaply; the
    // status door above is the behavioural half.
    expect(MAIN, 'the cure door is built without the seam context').toContain(
      'statusCurer(effects, forWorld.rng, seamCtx())',
    );
    expect(MAIN, 'the daze break runs without the seam context').toContain(
      'breakDamageSensitive(effects, body, forWorld.rng, seamCtx())',
    );
  });
});
