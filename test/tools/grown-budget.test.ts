// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  CLASSES,
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
  spendByPurse,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { stat } from '../../src/server/engine/derived.ts';
import { boughtSheet, recomposeCombat } from '../../src/server/engine/effects.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import {
  MAX_CHARACTER_LEVEL,
  canRaiseStat,
  pointsForLevel,
  statPointsForLevel,
  totalPointsAtLevel,
  totalStatPointsAtLevel,
} from '../../src/shared/progression.ts';
import { growTo, levelOnTheFloor, spendPointsTo } from '../../tools/grown.mjs';
import { classPointBonus, originOf } from '../../src/server/content/origins.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { PrimaryStats } from '../../src/server/engine/derived.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import type { TalentEngine, TalentSheet } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE PROBE'S PURSES ARE THE SERVER'S, AND SO ARE ITS REFUSALS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every balance table is read off a body `tools/grown.mjs` builds, and that body
 * used to be the probe's own arithmetic twice over:
 *
 *   ITS STATS CAME FROM THE MONSTER FORMULA. `statPointsGainedTo` has no birth
 *   term and no ceiling, so a level-2 Watchman was built at Strength 25 where
 *   `statCeilingForLevel(2)` is 22.8 — a point `handleSpendStat` refuses.
 *
 *   ITS TALENTS HAD NO LADDER. A level-3 body held a tier-3 rank the server
 *   opens at level 8, because the round-robin never asked `checkTier`.
 *
 * Both are joins between the probe and the spend path, so the oracle here is
 * never the probe's own code. The stat ceiling is asked of `canRaiseStat` over
 * `boughtSheet`, the two reads `handleSpendStat` makes. The tier gate is asked
 * of the TALENT BOOK — `loadoutOf`'s `locked`, which `content/classes.ts#gateFor`
 * computes from its own context — at the moment of every write, so a rank the
 * panel would have greyed cannot be bought quietly. The purses are held against
 * `totalStatPointsAtLevel` / `totalPointsAtLevel` and against `spendByPurse`,
 * the ledger the restore path reads.
 */

type StatKey = Exclude<keyof PrimaryStats, 'lck'>;
const STATS: readonly StatKey[] = ['str', 'dex', 'con', 'mag', 'wil', 'cun'];

/**
 * THE DEFAULT ORIGIN'S POINT BONUS — what the server pays a body with no
 * `origin` (`originOf(undefined)` is Cityborn: one at birth, one every ten).
 * A probe body is that body, so its purse is this total and not the bare one.
 */
const BONUS = classPointBonus(originOf(undefined));

type ProbeBody = {
  id: string;
  kind: 'player';
  level: number;
  hp: number;
  maxHp: number;
  combat: CombatSheet;
  baseCombat: CombatSheet;
  equipped: Record<string, string>;
  spentStats?: PrimaryStats;
  unspentStatPoints?: number;
  unspentPoints?: number;
};

/** A body the way `delve-run.mjs#run` makes one, before `growTo`. */
function newBody(cls: ClassDef, tag: string): ProbeBody {
  return {
    id: `grown-budget:${cls.id}:${tag}`,
    kind: 'player',
    level: 1,
    hp: cls.maxHp,
    maxHp: cls.maxHp,
    combat: cls.combat,
    baseCombat: cls.combat,
    equipped: {},
  };
}

const spentOf = (ledger: PrimaryStats | undefined): number =>
  STATS.reduce((sum, key) => sum + (ledger?.[key] ?? 0), 0);

/**
 * EVERY STAT POINT REPLAYED THROUGH THE SERVER'S OWN CHECK. A stat's value
 * before its j-th raise is the class sheet with j bought, and nothing else moves
 * it, so the replay is exact while the level holds still — which it does inside
 * `growTo`.
 */
function ceilingBreaches(body: ProbeBody, level: number): string[] {
  const out: string[] = [];
  for (const key of STATS) {
    const bought = body.spentStats?.[key] ?? 0;
    for (let j = 0; j < bought; j += 1) {
      const before = stat(boughtSheet({ spentStats: { [key]: j } }, body.baseCombat) ?? {}, key);
      if (!canRaiseStat(before, level)) out.push(`${key} raised from ${String(before)}`);
    }
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WRITE, WATCHED. Every rank the probe buys is checked against the panel's
 * verdict at the instant before it lands.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sheet.points.set` is wrapped on this one sheet. A raise of a loadout talent
 * asks `loadoutOf(body)` — the server's own projection, `gateFor` and all —
 * whether that talent's next rank is open. `locked` present is a refusal;
 * `level >= maxLevel` is the cap `handleSpendPoint` refuses at.
 *
 * AND THE SHEET THE PANEL READS MUST BE THE ONE THE SERVER WOULD HOLD. The gate
 * reads `body.combat`, and so does `loadoutOf`, so a probe that spent its stats
 * and asked the gate before refolding would be agreed with by a panel reading
 * the same stale sheet. `handleSpendStat` refolds the moment a point lands, so
 * each write also refolds a copy of the body and holds the two sheets' stats
 * against each other.
 *
 * `contested` counts the writes made while SOME loadout talent was locked, so
 * a sweep in which the gate never bound can say so instead of passing on air.
 */
function watch(
  engine: TalentEngine,
  body: ProbeBody,
  sheet: TalentSheet,
  cls: ClassDef,
  effects: EffectState | null = null,
) {
  const book = createTalentBook(engine, undefined as never);
  const loadout = new Set(cls.loadout.map((talent) => talent.id));
  const refused: string[] = [];
  let contested = 0;
  const points = sheet.points;
  const write = points.set.bind(points);
  points.set = (id: string, rank: number) => {
    if (loadout.has(id) && rank > (points.get(id) ?? 0)) {
      const fresh = { ...body };
      recomposeCombat(fresh as never, effects, resolveItem);
      for (const key of STATS) {
        if (stat(fresh.combat, key) !== stat(body.combat, key)) {
          refused.push(`${id} gated on a stale ${key} at level ${String(body.level)}`);
        }
      }
      const views = book.loadoutOf(body as never);
      const view = views.find((entry) => entry.id === id);
      if (views.some((entry) => entry.locked === true)) contested += 1;
      if (view === undefined) refused.push(`${id} is not on the panel`);
      else if (view.locked === true) {
        refused.push(
          `${id} -> ${String(rank)} at level ${String(body.level)}: ${String(view.lockedReason)}`,
        );
      } else if (view.level >= view.maxLevel) {
        refused.push(`${id} -> ${String(rank)} past its cap ${String(view.maxLevel)}`);
      }
    }
    return write(id, rank);
  };
  return {
    refused,
    contested: () => contested,
    /** Is there any loadout talent the server would still take a point for? */
    anyOpen: () =>
      book
        .loadoutOf(body as never)
        .some((view) => loadout.has(view.id) && view.locked !== true && view.level < view.maxLevel),
  };
}

/** The class points this sheet has spent, by the restore path's own ledger. */
function classSpent(engine: TalentEngine, sheet: TalentSheet, cls: ClassDef): number {
  return spendByPurse(sheet, cls, (id) => engine.registry.get(id)?.tree).class;
}

describe('growTo spends the attribute points the server grants, and none it would refuse', () => {
  it('a level-2 Watchman: exactly the level-2 purse, and no raise past the level-2 ceiling', () => {
    // THE PRECONDITION. His class Strength is already over the level-2 ceiling,
    // so this is the case where the old spread and the server disagree. If a
    // rebalance ever moves it under, this case stops testing the ceiling and
    // must say so rather than pass.
    expect(
      canRaiseStat(stat(WATCHMAN.combat, 'str'), 2),
      'Strength is under the level-2 ceiling now; pick a stat that is over it',
    ).toBe(false);

    const body = growTo(newBody(WATCHMAN, 'l2'), WATCHMAN, 2);
    expect(spentOf(body.spentStats)).toBe(totalStatPointsAtLevel(2));
    expect(body.unspentStatPoints).toBe(0);
    expect(ceilingBreaches(body, 2)).toEqual([]);
    // AND THE LIVE SHEET IS THE LEDGER FOLDED, so what the fight reads is what
    // was bought: never over the ceiling for a stat that was raised.
    for (const key of STATS) {
      const bought = body.spentStats?.[key] ?? 0;
      expect(stat(body.combat, key), key).toBe(stat(WATCHMAN.combat, key) + bought);
    }
  });

  it('every class, every level: the purse is the server total and every raise passes the ceiling', () => {
    for (const cls of CLASSES) {
      for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
        const body = growTo(newBody(cls, `sweep:${String(level)}`), cls, level);
        const at = `${cls.id} at level ${String(level)}`;
        expect(spentOf(body.spentStats) + (body.unspentStatPoints ?? 0), at).toBe(
          totalStatPointsAtLevel(level),
        );
        expect(ceilingBreaches(body, level), at).toEqual([]);
        // A POINT LEFT IN THE PURSE MEANS NO STAT COULD TAKE IT — the only
        // reason the server would leave one there.
        if ((body.unspentStatPoints ?? 0) > 0) {
          for (const key of STATS) {
            const now = stat(boughtSheet(body, body.baseCombat) ?? {}, key);
            expect(canRaiseStat(now, level), `${at}: ${key} could still take a point`).toBe(false);
          }
        }
      }
    }
  });

  it('a level-1 body with an empty purse comes out as it went in', () => {
    expect(totalStatPointsAtLevel(1), 'there is a level-1 purse now; re-read this case').toBe(0);
    for (const cls of CLASSES) {
      const body = growTo(newBody(cls, 'l1'), cls, 1);
      expect(body.combat, cls.id).toBe(cls.combat);
      expect(body.spentStats, cls.id).toBeUndefined();
      expect(body.maxHp, cls.id).toBe(cls.maxHp);
    }
  });
});

/** Levels a birth-time body is built at: the whole early game, then the long tail. */
const LEVELS = [...Array.from({ length: 20 }, (_u, i) => i + 1), 25, 30, 40, MAX_CHARACTER_LEVEL];

describe('spendPointsTo spends the class purse and never buys a rank the ladder refuses', () => {
  it('pays the default origin its point bonus, as the server does', () => {
    // THE SETUP THAT MAKES THE REST MEAN SOMETHING: the default origin carries
    // a bonus, so a purse without it is a different, smaller number.
    expect(totalPointsAtLevel(1, BONUS), 'the default origin grants nothing at birth').toBe(
      totalPointsAtLevel(1) + 1,
    );
    const cls = CLASSES[0];
    if (cls === undefined) throw new Error('no class');
    const engine = createContentTalentEngine();
    const body = growTo(newBody(cls, 'origin-bonus'), cls, 10);
    const sheet = sheetForClass(cls);
    engine.attach(body.id, sheet);
    const spent = spendPointsTo(sheet, cls, 10, body, engine.registry);
    expect(spent + (body.unspentPoints ?? 0)).toBe(totalPointsAtLevel(10, BONUS));
  });

  it('every class: the purse is the server total, and a point is kept only when nothing is open', () => {
    let contested = 0;
    for (const cls of CLASSES) {
      for (const level of LEVELS) {
        const engine = createContentTalentEngine();
        const body = growTo(newBody(cls, `talents:${String(level)}`), cls, level);
        const sheet = sheetForClass(cls);
        engine.attach(body.id, sheet);
        const seen = watch(engine, body, sheet, cls);
        const spent = spendPointsTo(sheet, cls, level, body, engine.registry);
        const at = `${cls.id} at level ${String(level)}`;

        expect(seen.refused, at).toEqual([]);
        expect(classSpent(engine, sheet, cls), at).toBe(spent);
        expect(spent + (body.unspentPoints ?? 0), at).toBe(totalPointsAtLevel(level, BONUS));
        if ((body.unspentPoints ?? 0) > 0) {
          expect(seen.anyOpen(), `${at}: a point was kept while a rank was open`).toBe(false);
        }
        contested += seen.contested();
      }
    }
    expect(
      contested,
      'the ladder never refused anything; this sweep proves nothing',
    ).toBeGreaterThan(0);
  });

  it('asks the ledger, not a counter: a second call on a spent sheet spends nothing', () => {
    // `restoreProgression`'s arithmetic — the purse is the total LESS what the
    // sheet has already spent — so the probe cannot pay for a level twice.
    for (const cls of CLASSES) {
      const engine = createContentTalentEngine();
      const body = growTo(newBody(cls, 'twice'), cls, 10);
      const sheet = sheetForClass(cls);
      engine.attach(body.id, sheet);
      const first = spendPointsTo(sheet, cls, 10, body, engine.registry);
      expect(first, `${cls.id} spent nothing at level 10`).toBeGreaterThan(0);
      expect(spendPointsTo(sheet, cls, 10, body, engine.registry), cls.id).toBe(0);
      expect(classSpent(engine, sheet, cls), cls.id).toBe(first);
    }
  });

  it('the whole early game is spent: every class point through level 20 finds a rank', () => {
    for (const cls of CLASSES) {
      for (let level = 1; level <= 20; level += 1) {
        const engine = createContentTalentEngine();
        const body = growTo(newBody(cls, `early:${String(level)}`), cls, level);
        const sheet = sheetForClass(cls);
        engine.attach(body.id, sheet);
        spendPointsTo(sheet, cls, level, body, engine.registry);
        expect(classSpent(engine, sheet, cls), `${cls.id} at level ${String(level)}`).toBe(
          totalPointsAtLevel(level, BONUS),
        );
      }
    }
  });
});

describe('levelOnTheFloor spends each level the way a player at that level could', () => {
  it('asks the ceiling of what was BOUGHT, not of what the gear adds', () => {
    /**
     * `handleSpendStat` caps `boughtSheet(body, baseCombat)` — the class sheet
     * plus the ledger, with no gear — so a ring's Strength never blocks buying
     * Strength. A probe that asked the worn sheet instead refused the point and
     * put it somewhere else, and every dressed row measured a different build.
     */
    const RING = 'item_watchmans_brass_ring';
    const ring = resolveItem(RING);
    expect(ring?.wielder?.stats?.str, `${RING} no longer grants Strength`).toBe(3);
    const effects = createMvpEffectState();
    const body = newBody(WATCHMAN, 'ringed');
    body.level = 3;
    body.equipped = { ring: RING };
    recomposeCombat(body as never, effects, resolveItem);
    const bought = stat(WATCHMAN.combat, 'str');
    // THE SETUP: bought Strength is under the level-3 ceiling, worn is over it.
    expect(canRaiseStat(bought, 3), 'bought Strength is over the ceiling now').toBe(true);
    expect(canRaiseStat(stat(body.combat ?? {}, 'str'), 3), 'the ring did not lift it').toBe(false);

    body.unspentStatPoints = 1;
    const sheet = sheetForClass(WATCHMAN);
    const engine = createContentTalentEngine();
    engine.attach(body.id, sheet);
    levelOnTheFloor(body, WATCHMAN, sheet, effects, { registry: engine.registry, engine });
    expect(body.spentStats?.str, 'the point went past Strength').toBe(1);
  });

  it('born at 1, levelled to 20 one level at a time: the server purses, the ceiling, the ladder', () => {
    let contested = 0;
    for (const cls of CLASSES) {
      const engine = createContentTalentEngine();
      const effects = createMvpEffectState();
      const body = growTo(newBody(cls, 'floor'), cls, 1);
      const sheet = sheetForClass(cls);
      engine.attach(body.id, sheet);
      spendPointsTo(sheet, cls, 1, body, engine.registry);
      const seen = watch(engine, body, sheet, cls, effects);

      /**
       * EVERY STAT WRITE, CHECKED AT THE LEVEL IT HAPPENS AT. The ceiling rises
       * with the level, so a replay at level 20 would forgive a raise made
       * illegally at level 2. `spentStats` is replaced wholesale on each raise,
       * the gateway's shape, so the setter sees exactly one key move.
       */
      const breaches: string[] = [];
      let ledger = body.spentStats;
      Object.defineProperty(body, 'spentStats', {
        configurable: true,
        enumerable: true,
        get: () => ledger,
        set: (next: PrimaryStats | undefined) => {
          for (const key of STATS) {
            if ((next?.[key] ?? 0) <= (ledger?.[key] ?? 0)) continue;
            const before = stat(boughtSheet({ spentStats: ledger }, body.baseCombat) ?? {}, key);
            if (!canRaiseStat(before, body.level)) {
              breaches.push(
                `${cls.id} ${key} raised from ${String(before)} at ${String(body.level)}`,
              );
            }
          }
          ledger = next;
        },
      });

      // `applyPendingLevels`, one level crossed at a time, and then the seam
      // main.ts hangs `refreshPassives` on — which is `levelOnTheFloor`.
      for (let level = 2; level <= 20; level += 1) {
        body.level = level;
        body.unspentPoints = (body.unspentPoints ?? 0) + pointsForLevel(level, BONUS);
        body.unspentStatPoints = (body.unspentStatPoints ?? 0) + statPointsForLevel(level);
        levelOnTheFloor(body, cls, sheet, effects, { registry: engine.registry, engine });
      }

      expect(breaches, cls.id).toEqual([]);
      expect(seen.refused, cls.id).toEqual([]);
      expect(spentOf(body.spentStats) + (body.unspentStatPoints ?? 0), cls.id).toBe(
        totalStatPointsAtLevel(20),
      );
      expect(classSpent(engine, sheet, cls) + (body.unspentPoints ?? 0), cls.id).toBe(
        totalPointsAtLevel(20, BONUS),
      );
      if ((body.unspentPoints ?? 0) > 0) {
        expect(seen.anyOpen(), `${cls.id}: a point was kept while a rank was open`).toBe(false);
      }
      contested += seen.contested();
    }
    expect(
      contested,
      'the ladder never refused anything; this case proves nothing',
    ).toBeGreaterThan(0);
  });
});
