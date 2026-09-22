// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { REDACTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { EffectId, OFF_BALANCE_NUMBED } from '../../src/server/content/effects.ts';
import { INDEX_HUSK, INDEX_HUSK_ELITE, monsterInit } from '../../src/server/content/monsters.ts';
import { isMonster, isPlayer } from '../../src/server/engine/actor.ts';
import { combatAttack } from '../../src/server/engine/derived.ts';
import { SaveChannel, hasEffect, saveOf, setEffect } from '../../src/server/engine/effects.ts';
import { talentId } from '../../src/server/engine/talents.ts';
import { CALL_SHADOWS_ID } from '../../src/server/talents/call_shadows.ts';
import { getTierDiff } from '../../src/shared/scale.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import type * as TurnEngineModule from '../../src/server/turn-engine.ts';
import type * as RealmsModule from '../../src/server/world/realms.ts';
import type { ReapingTurnEngine, TurnEngineOptions } from '../../src/server/turn-engine.ts';
import type { RealmsOptions } from '../../src/server/world/realms.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TIMED EFFECT THAT GRANTS A NUMBER REACHES EVERY BODY — NOT ONLY SHEETED ONES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EffectDef.wielder` is folded by `recomposeCombat`, and for a timed effect
 * production runs that fold from one place: `refreshPassives` in main.ts, which
 * is both the per-base-turn fold (`onActBase`) and what `EffectCtx.sheetDirty`
 * is bound to (`onSheetDirty`). Its guard was
 *
 *     if (actor === undefined || sheet === undefined) return;
 *
 * and a monster with no `talents` list never gets a talent sheet —
 * `ensureMonsterSheet` returns undefined for it, by design. So the recompose was
 * never reached for seven of the sixteen templates (index_husk, index_wraith,
 * index_cairn, index_ribbon, index_strongbox, undermost_picket, bound_shadow):
 * an Off-balance husk carried `effect:off_balance` in the table and hit for full
 * damage the whole time, and a Spellshocked one never lost `SPELLSHOCK_RESIST`
 * off its resist-all.
 *
 * MEASURED BEFORE THE FIX, through this harness: after the base turn that
 * followed the cast, the talented elite's composed sheet carried
 * `OFF_BALANCE_NUMBED` and the husk's carried nothing, and the expiry's
 * `onSheetDirty` call for the husk returned at the guard.
 *
 * ═══ WHY THIS BOOTS `buildServer` IN-PROCESS ═══
 * The bug was in the one line joining two correct layers: `recomposeCombat`
 * folds `wielder` correctly (cross-tier.test.ts proves it on a bare body), and
 * the scheduler calls `actBase` correctly. Only production's `refreshPassives`
 * sits between them, and it is a closure inside `buildServer`. So the two
 * factories it calls are wrapped — each calls the real one and returns the
 * real result — which hands this file production's `engineFor` (through
 * `createRealms`' options, i.e. with `wrapForGateway` on it) and the world it
 * was first built on. Nothing is stubbed: the talent, the status door, the
 * pump, the base-turn fold and the expiry are all production's.
 *
 * `app.ready()` is never called, so no plugin loads and no port is bound.
 * `DATA_DIR` points at a temp directory before main.ts is imported, because
 * `DATA_ROOT` is read at module load and the real `data/` holds live saves.
 */

const seen = vi.hoisted(() => ({
  engines: [] as { opts: TurnEngineOptions; engine: ReapingTurnEngine }[],
  realms: [] as RealmsOptions[],
  dirty: [] as string[],
}));

vi.mock('../../src/server/turn-engine.ts', async () => {
  const real = await vi.importActual<typeof TurnEngineModule>('../../src/server/turn-engine.ts');
  return {
    ...real,
    createTurnEngine: (opts: TurnEngineOptions): ReapingTurnEngine => {
      // RECORDED, THEN FORWARDED UNCHANGED — the call main.ts binds is still
      // the one that runs.
      const bound = opts.onSheetDirty;
      const traced: TurnEngineOptions =
        bound === undefined
          ? opts
          : {
              ...opts,
              onSheetDirty: (actorId: string): void => {
                seen.dirty.push(actorId);
                bound(actorId);
              },
            };
      const engine = real.createTurnEngine(traced);
      seen.engines.push({ opts: traced, engine });
      return engine;
    },
  };
});

vi.mock('../../src/server/world/realms.ts', async () => {
  const real = await vi.importActual<typeof RealmsModule>('../../src/server/world/realms.ts');
  return {
    ...real,
    createRealms: (opts: RealmsOptions): RealmsModule.Realms => {
      seen.realms.push(opts);
      return real.createRealms(opts);
    },
  };
});

const SHIN_CRACK = talentId('shin_crack');

type Harness = {
  readonly world: World;
  readonly engine: ReapingTurnEngine;
  readonly effects: EffectState;
};

let dataDir = '';
let harness: Harness | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'inner-datum-wielder-'));
  process.env['DATA_DIR'] = dataDir;
  process.env['LOG_LEVEL'] = 'silent';
  const { buildServer } = await import('../../src/server/main.ts');
  buildServer();

  // THE FIRST ENGINE main.ts BUILDS is `engineFor(world)` over the standalone
  // world; the realms build theirs after. Asserted rather than assumed.
  const first = seen.engines[0];
  const realmsOpts = seen.realms[0];
  if (first === undefined || realmsOpts === undefined) throw new Error('buildServer built nothing');
  const world = first.opts.world;
  const effects = first.opts.effects;
  if (effects === undefined) throw new Error('main.ts built its engine without a status table');

  // PRODUCTION'S `engineFor`, WITH `wrapForGateway` ON IT — the same function
  // every realm is served by, pointed at the standalone world so the bodies are
  // found by `refreshPassives`' fallback lookup.
  const engine = realmsOpts.engineFor(world);
  harness = { world, engine, effects };
}, 60_000);

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function need(): Harness {
  if (harness === undefined) throw new Error('harness not built');
  return harness;
}

/**
 * A BARE FLOOR AND NOBODY ON IT. The seeded encounter would walk into the fight
 * and move the rng stream a landing depends on, and each case here builds the
 * whole board it needs.
 */
function clear({ world, engine }: Harness): void {
  world.level.tiles.fill(TileCode.FLOOR);
  for (const body of world.allActors()) {
    if (isPlayer(body)) {
      engine.leave(body.id);
      world.removePlayer(body.id);
    } else {
      world.removeActor(body.id);
    }
  }
}

type Seen = { on: boolean; numbed: number };
type CombatLike = { readonly mods?: { readonly numbed?: number } };

function look(effects: EffectState, body: { id: string; combat?: CombatLike }): Seen {
  return {
    on: hasEffect(effects, body.id, EffectId.OffBalance),
    numbed: body.combat?.mods?.numbed ?? 0,
  };
}

describe('a wielder effect reaches a body with no talent sheet', () => {
  it('an Off-balance husk carries it on its composed sheet while it lasts, like the elite', () => {
    const h = need();
    const { world, engine, effects } = h;
    clear(h);

    const players = [
      { id: 'p_husk', name: 'Dalt', at: { x: 8, y: 8 } },
      { id: 'p_elite', name: 'Sam', at: { x: 8, y: 20 } },
    ] as const;
    for (const p of players) {
      world.addPlayer(p.id, p.name);
      expect(world.placeAt(p.id, p.at)).toBe(true);
      engine.join(p.id);
      engine.attachClass?.(p.id, WATCHMAN.id);
      const body = world.getActor(p.id);
      if (body === undefined || !isPlayer(body)) throw new Error(`${p.id} was not placed`);
      // DEXTERITY THROUGH THE SEAM THE STAT BUTTON USES, so accuracy — Shin
      // Crack's `applyPower` — clears a whole save tier.
      body.spentStats = { dex: 20 };
      engine.refreshBody?.(p.id);
    }

    // `hp` 99999 so no blow ends the fight before the effect does.
    const husk = world.addMonster('m_husk', {
      ...monsterInit(INDEX_HUSK, { x: 9, y: 8 }),
      maxHp: 99_999,
    });
    const elite = world.addMonster('m_elite', {
      ...monsterInit(INDEX_HUSK_ELITE, { x: 9, y: 20 }),
      maxHp: 99_999,
    });
    world.turn.engagement = 3;

    const holdAll = (): void => {
      for (const p of players) expect(engine.hold(p.id).ok).toBe(true);
      engine.pump();
    };

    /**
     * ONE TURN OF STANDING THERE FIRST, so the control really is the sheeted
     * case. A talented monster has no sheet until its AI first asks `castable`,
     * which needs a target — so on the cast turn itself the elite would be as
     * sheetless as the husk, and a "control" that shared the bug would pass or
     * fail with it. After this the elite has a sheet and the husk still has none.
     */
    holdAll();
    expect(engine.talentPointsOf?.(elite.id), 'the elite never built its sheet').toBeDefined();
    expect(engine.talentPointsOf?.(husk.id)).toBeUndefined();
    expect(INDEX_HUSK.talents ?? []).toHaveLength(0);

    // THE FIXTURE, CHECKED: each caster's accuracy — Shin Crack's `applyPower` —
    // outranks its target's physical save by a whole tier, which is what makes
    // Off-balance land at all (`crossTierEffect`; see cross-tier.test.ts).
    for (const [caster, victim] of [
      ['p_husk', husk],
      ['p_elite', elite],
    ] as const) {
      const accuracy = combatAttack(world.getActor(caster)?.combat ?? {});
      const save = saveOf(victim.combat, SaveChannel.Physical);
      expect(
        getTierDiff(accuracy, save),
        `${caster} does not outrank ${victim.id}`,
      ).toBeGreaterThan(0);
    }

    // THROUGH THE REAL TALENT DOOR, on the real pump.
    seen.dirty.length = 0;
    expect(engine.submitTalent('p_husk', SHIN_CRACK, { x: husk.x, y: husk.y }).ok).toBe(true);
    expect(engine.submitTalent('p_elite', SHIN_CRACK, { x: elite.x, y: elite.y }).ok).toBe(true);
    engine.commit('p_husk');
    engine.commit('p_elite');
    engine.pump();
    expect(look(effects, husk).on, 'Off-balance did not land on the husk').toBe(true);
    expect(look(effects, elite).on, 'Off-balance did not land on the elite').toBe(true);

    /**
     * EVERY TURN FROM THE CAST TO WELL AFTER IT ENDS, BOTH BODIES.
     *
     * Where in the pump the cast lands, relative to the base turn that folds it,
     * depends on the tick the pump started on — so this does not predict WHICH
     * observation first shows it. It asks the question phase cannot move:
     * does the sheetless husk's composed sheet track the effect turn for turn
     * the way the sheeted elite's does? Both were cast on in the same pump.
     */
    type Turn = { husk: Seen; elite: Seen; huskDirtied: boolean };
    const turns: Turn[] = [
      {
        husk: look(effects, husk),
        elite: look(effects, elite),
        huskDirtied: seen.dirty.includes(husk.id),
      },
    ];
    for (let i = 0; i < 4; i += 1) {
      seen.dirty.length = 0;
      holdAll();
      turns.push({
        husk: look(effects, husk),
        elite: look(effects, elite),
        huskDirtied: seen.dirty.includes(husk.id),
      });
    }

    // THE CONTROL, which the fix does not touch: a sheeted body carries
    // `OFF_BALANCE_NUMBED` while the effect is on it, and nothing once it has gone.
    expect(turns.some((t) => t.elite.on && t.elite.numbed === OFF_BALANCE_NUMBED)).toBe(true);
    for (const t of turns) if (!t.elite.on) expect(t.elite.numbed).toBe(0);
    expect(turns.at(-1)?.elite).toEqual({ on: false, numbed: 0 });

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // `numbed` on the COMPOSED sheet is the number damage.ts (melee, talents)
    // and the orb path read. The husk's stayed 0 on every turn of this list.
    expect(turns.map((t) => t.husk)).toEqual(turns.map((t) => t.elite));

    // AND IT LEAVES WITH THE EFFECT, reaching the husk through the pump's
    // `sheetDirty` on the turn it expires. Recomposed from base, so an expired
    // effect is simply no longer folded.
    const ended = turns.findIndex((t) => !t.husk.on);
    expect(ended, 'Off-balance never ended').toBeGreaterThan(0);
    expect(turns[ended]?.huskDirtied).toBe(true);
    expect(turns[ended]?.husk.numbed).toBe(0);

    // AND NO SHEET WAS INVENTED FOR THE HUSK to make any of this work.
    expect(engine.talentPointsOf?.(husk.id)).toBeUndefined();
  });

  it('a bound shadow keeps it past its own base pass, which used to write over it', () => {
    /**
     * THE ONE SHEETLESS BODY THE FIX ABOVE DID NOT REACH ON ITS OWN. A shadow's
     * base turn runs its fold and THEN `shadowPass` (talents/call_shadows.ts),
     * which writes `combat` as the birth sheet plus the carried flags — so the
     * fold's work was gone before the shadow ever acted. Measured before
     * `summonPass` recomposed after it: `numbed` 0 on every turn below.
     */
    const h = need();
    const { world, engine, effects } = h;
    clear(h);
    world.turn.engagement = 0;

    world.addPlayer('p_red', 'Ren');
    expect(world.placeAt('p_red', { x: 10, y: 10 })).toBe(true);
    engine.join('p_red');
    engine.attachClass?.('p_red', REDACTOR.id);
    expect(engine.toggleSustain?.('p_red', CALL_SHADOWS_ID)).toBe(true);

    const called = (): ReturnType<World['allActors']>[number] | undefined =>
      world.allActors().find((a) => isMonster(a) && a.summonerId === 'p_red');
    for (let i = 0; i < 30 && called() === undefined; i += 1) {
      expect(engine.hold('p_red').ok).toBe(true);
      engine.pump();
    }
    const shadow = called();
    if (shadow === undefined) throw new Error('Call Shadows never called a shadow');
    expect(engine.talentPointsOf?.(shadow.id)).toBeUndefined();

    // THE TALENT DOOR'S SHAPE: `statusFor` in main.ts builds its applier with no
    // ctx, so a landing fires no `sheetDirty` and only the base turn folds it.
    // No `applyPower`, so no save is rolled and no draw is taken.
    setEffect(effects, shadow, EffectId.OffBalance, 3, {}, world.rng);

    const turns: Seen[] = [];
    for (let i = 0; i < 5; i += 1) {
      expect(engine.hold('p_red').ok).toBe(true);
      engine.pump();
      turns.push(look(effects, shadow));
    }
    // STILL STANDING, so every turn above is a turn the shadow could have acted.
    expect(world.getActor(shadow.id)?.alive).toBe(true);

    expect(turns.filter((t) => t.on).length).toBeGreaterThan(0);
    for (const t of turns) expect(t.numbed).toBe(t.on ? OFF_BALANCE_NUMBED : 0);
    expect(turns.at(-1)).toEqual({ on: false, numbed: 0 });
  });

  it('a body with no base sheet is left alone rather than folded onto itself each turn', () => {
    /**
     * `recomposeCombat` builds on `baseCombat ?? combat`. A body with no
     * `baseCombat` — the harmless townsfolk body has no combat sheet — would
     * fold its wielder grants onto LAST turn's composed sheet on every base
     * turn: measured in review under the underwater aura, cold +10, +20, +30.
     * So `refreshPassives` recomposes only a body with a base to fold from.
     */
    const h = need();
    const { world, engine, effects } = h;
    clear(h);
    world.addPlayer('p_watch', 'Ren');
    expect(world.placeAt('p_watch', { x: 10, y: 10 })).toBe(true);
    engine.join('p_watch');
    const plain = world.addMonster('m_plain', {
      name: 'A Plain Body',
      sprite: 'enemy_index_husk_s',
      x: 20,
      y: 20,
      profile: INDEX_HUSK.profile,
    });
    expect(plain.baseCombat, 'fixture: this body has a base sheet').toBeUndefined();

    setEffect(effects, plain, EffectId.OffBalance, 6, {}, world.rng);
    const turns: Seen[] = [];
    for (let i = 0; i < 4; i += 1) {
      expect(engine.hold('p_watch').ok).toBe(true);
      engine.pump();
      turns.push(look(effects, plain));
    }
    expect(
      turns.some((t) => t.on),
      'fixture: the effect never stayed on',
    ).toBe(true);
    // NEVER MORE THAN ONE COPY OF THE GRANT, however many base turns pass.
    for (const t of turns) expect(t.numbed).toBeLessThanOrEqual(OFF_BALANCE_NUMBED);
  });
});
