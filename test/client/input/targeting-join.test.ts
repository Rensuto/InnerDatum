// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { TargetAdvice, createTargeting } from '../../../src/client/input/targeting.ts';
import { MarkerKind } from '../../../src/client/render/canvas.ts';
import type { TargetCell } from '../../../src/client/render/canvas.ts';
import {
  INSPECTOR,
  allTalents,
  createContentTalentEngine,
  toLoadoutView,
} from '../../../src/server/content/classes.ts';
import {
  ResourceKind,
  TalentRefusal,
  TargetShape,
  canUseTalent,
  createTalentSheet,
  talentLevelOf,
} from '../../../src/server/engine/talents.ts';
import { ActorKind, TileCode } from '../../../src/shared/protocol.ts';
import type { TalentActor, TalentWorld } from '../../../src/server/engine/talents.ts';
import type { LevelView } from '../../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING AND THE RULE ARE ONE ANSWER — every shipped talent, every rank,
 * every tile.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The client's `adviseTile` (the cursor) and `buildRing` (the ring and its
 * hole), and the server's `canUseTalent` (the refusal), each decide "too far"
 * and "too close". They are functions on two sides of the wire, and they
 * agree only because both ask `tileDistance` — the client by name, the server
 * through `combatDistance`, whose body it is — against the SAME range, which
 * `toLoadoutView` sends from the rank the server resolves.
 *
 * So this is driven from the real halves and the real join: every player talent
 * `allTalents()` ships whose shape is aimed at a tile or a body (locked trees
 * included, which a walk of the class loadouts misses), at every rank, with
 * the client's `LoadoutTalent` built by `toLoadoutView` from the server's own
 * sheet, over every offset of an open 23x23 level. Wherever one side says
 * OutOfRange or TooClose, the other must say OutOfRange or MinRange, and the
 * same one — and the ring must leave the tile out, or mark it as the hole, to
 * match.
 *
 * WHAT GOES RED, AND WHERE. Give the client back its private `Math.sqrt` and
 * this fails at (5,2) from a range-5 talent (the server reaches it, the ring
 * does not) and at (2,2) from the Inspector's hole of 3 (the server shoots it,
 * the cursor calls it too close).
 */

const N = 23;
const ORIGIN = { x: 11, y: 11 } as const;

function openLevel(): LevelView {
  return { w: N, h: N, tiles: new Array<number>(N * N).fill(TileCode.FLOOR) };
}

/**
 * THE DISTANCE HALF OF EACH ANSWER, and nothing else. Line of sight, occupancy
 * and affinity are other rules with their own tests; on an open level with
 * nobody on it they would only make the two sides disagree about things this
 * file is not about.
 */
type Band = 'far' | 'near' | 'in';

function clientBand(advice: TargetAdvice): Band {
  if (advice === TargetAdvice.OutOfRange) return 'far';
  if (advice === TargetAdvice.TooClose) return 'near';
  return 'in';
}

/** Refusals `canUseTalent` answers BEFORE it measures anything. */
const BEFORE_TARGETING: ReadonlySet<string> = new Set([
  TalentRefusal.Dead,
  TalentRefusal.NotLearned,
  TalentRefusal.OnCooldown,
  TalentRefusal.NoAp,
  TalentRefusal.NoMp,
  TalentRefusal.NoResource,
  TalentRefusal.NoShooter,
]);

/**
 * WHAT THE RING DRAWS ON A TILE: the hole marker is 'near', no ring cell at all
 * is 'far', and a Valid or LOS-shaded cell is 'in'. The stamp and the cursor
 * are drawn over the ring and are not the ring, so they are left out.
 */
function ringBands(cells: readonly TargetCell[]): Map<string, Band> {
  const out = new Map<string, Band>();
  for (const cell of cells) {
    if (cell.marker === MarkerKind.MinRange) out.set(`${String(cell.x)},${String(cell.y)}`, 'near');
    else if (cell.marker === MarkerKind.Valid || cell.marker === null) {
      out.set(`${String(cell.x)},${String(cell.y)}`, 'in');
    }
  }
  return out;
}

function serverBand(refusal: TalentRefusal | null): Band {
  if (refusal === TalentRefusal.OutOfRange) return 'far';
  if (refusal === TalentRefusal.MinRange) return 'near';
  return 'in';
}

describe('the targeting ring and canUseTalent agree on reach and the hole', () => {
  it('for every shipped aimed talent, at every rank, over every tile of a 23x23 level', () => {
    const level = openLevel();
    const engine = createContentTalentEngine();
    const caster: TalentActor = {
      id: 'caster',
      name: 'Caster',
      kind: ActorKind.Player,
      x: ORIGIN.x,
      y: ORIGIN.y,
      hp: 100,
      maxHp: 100,
      alive: true,
      cooldowns: new Map(),
      // THE SHIPPED GUN, so the Inspector's archery talents reach their range
      // check rather than stopping at `NoShooter` (`archerPreUse`).
      combat: INSPECTOR.combat,
    };
    const world: TalentWorld = {
      level,
      getActor: (id) => (id === caster.id ? caster : undefined),
      actorAt: (x, y) => (x === caster.x && y === caster.y ? caster : undefined),
      allActors: () => [caster],
      tryMove: () => ({ ok: false, reason: 'terrain' }),
      placeAt: () => false,
      vaultAt: () => undefined,
    };

    const aimed = allTalents().filter(
      (t) => t.targeting.shape === TargetShape.Single || t.targeting.shape === TargetShape.Tile,
    );
    // NOT VACUOUS, and the two the metric switch moves most are in it.
    const ids = aimed.map((t) => t.id);
    expect(ids).toContain('talent:revolver_shot');
    expect(ids).toContain('talent:snipers_mark');
    expect(ids).toContain('talent:fog_step');

    const mismatches: string[] = [];
    const blocked: string[] = [];
    let compared = 0;
    let far = 0;
    let near = 0;

    for (const talent of aimed) {
      const ranks = Array.from({ length: talent.maxLevel ?? 5 }, (_u, i) => i + 1);
      for (const rank of ranks) {
        // A SHEET THAT OWNS THIS ONE TALENT AT THIS RANK, and can afford it.
        const sheet = createTalentSheet({
          loadout: [talent.id],
          resource: ResourceKind.Focus,
          maxAp: 99,
          maxMp: 99,
          points: new Map([[talent.id, rank]]),
        });
        sheet.resource.value = Number.MAX_SAFE_INTEGER;
        engine.attach(caster.id, sheet);

        // THE JOIN: the wire's view, from the server's own rank resolution.
        const view = toLoadoutView(talent, rank, caster, undefined, talentLevelOf(sheet, talent));
        const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
        expect(targeting.begin(view, { level, origin: ORIGIN })).toBe(true);
        const ring = ringBands(targeting.cells());

        for (let y = 0; y < N; y += 1) {
          for (let x = 0; x < N; x += 1) {
            targeting.hover({ x, y });
            const client = clientBand(targeting.advice());
            // The caster's own tile is left undecorated when there is no hole
            // (`buildRing` says why); it is not "out of range".
            const bare = x === ORIGIN.x && y === ORIGIN.y && view.minRange <= 0;
            const drawn = bare ? 'in' : (ring.get(`${String(x)},${String(y)}`) ?? 'far');
            const refusal = canUseTalent(engine, caster, talent, { x, y }, world);
            if (refusal !== null && BEFORE_TARGETING.has(refusal)) {
              blocked.push(`${talent.id}@${String(rank)}: ${refusal}`);
              continue;
            }
            const server = serverBand(refusal);
            compared += 1;
            if (server === 'far') far += 1;
            if (server === 'near') near += 1;
            if (client !== server || drawn !== server) {
              mismatches.push(
                `${talent.id}@${String(rank)} range ${String(view.range)}/${String(view.minRange)} ` +
                  `at (${String(x - ORIGIN.x)},${String(y - ORIGIN.y)}): ` +
                  `cursor ${client}, ring ${drawn}, server ${server}`,
              );
            }
          }
        }
      }
    }

    // The sweep reached the range check every time — nothing was refused for
    // a cost or a missing gun, which would have hidden the question.
    expect([...new Set(blocked)]).toEqual([]);
    expect(mismatches.slice(0, 20)).toEqual([]);
    // And it compared real answers on both sides of both rims.
    expect(compared).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(0);
  });

  it('draws the rounded rims the server enforces: (5,2) in at range 5, (2,2) out of a hole of 3', () => {
    // THE TWO CELLS THE UNROUNDED LENGTH GOT WRONG, named, so a red sweep above
    // has a one-line reading. Revolver Shot is range 5 and Sniper's Mark has the
    // Inspector's hole of 3; both are asked through the real view.
    const level = openLevel();
    const byId = new Map(allTalents().map((t) => [t.id, t]));
    const cursor = (id: string, dx: number, dy: number): TargetAdvice => {
      const talent = byId.get(id);
      if (talent === undefined) throw new Error(`no ${id}`);
      const self: TalentActor = {
        id: 'c',
        name: 'c',
        kind: ActorKind.Player,
        x: ORIGIN.x,
        y: ORIGIN.y,
        hp: 1,
        maxHp: 1,
        alive: true,
        cooldowns: new Map(),
      };
      const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
      targeting.begin(toLoadoutView(talent, 1, self), { level, origin: ORIGIN });
      targeting.hover({ x: ORIGIN.x + dx, y: ORIGIN.y + dy });
      return targeting.advice();
    };

    expect(byId.get('talent:revolver_shot')?.targeting.range).toBe(5);
    expect(cursor('talent:revolver_shot', 5, 2)).not.toBe(TargetAdvice.OutOfRange);
    expect(cursor('talent:revolver_shot', 4, 3)).not.toBe(TargetAdvice.OutOfRange);
    expect(cursor('talent:revolver_shot', 5, 3)).toBe(TargetAdvice.OutOfRange);
    expect(cursor('talent:revolver_shot', 4, 4)).toBe(TargetAdvice.OutOfRange);

    expect(byId.get('talent:snipers_mark')?.targeting.minRange).toBe(3);
    expect(cursor('talent:snipers_mark', 2, 2)).not.toBe(TargetAdvice.TooClose);
    expect(cursor('talent:snipers_mark', 2, 1)).toBe(TargetAdvice.TooClose);
  });
});
