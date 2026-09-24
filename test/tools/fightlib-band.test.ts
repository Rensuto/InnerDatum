// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { INSPECTOR, createContentTalentEngine } from '../../src/server/content/classes.ts';
import { ResourceKind, canUseTalent, createTalentSheet } from '../../src/server/engine/talents.ts';
import { revolverShot } from '../../src/server/talents/revolver_shot.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { classStrikes, reachable } from '../../tools/fightlib.mjs';
import type { TalentActor, TalentWorld } from '../../src/server/engine/talents.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBE'S BAND IS THE ENGINE'S BAND — `reachable` against `canUseTalent`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every difficulty number in this repository is read off a probe that decides
 * for itself whether a foe is in reach (`tools/fightlib.mjs#reachable`) and
 * then asks the engine to fire. When the two disagree the probe either offers
 * shots the engine refuses — each one a wasted iteration, 92 of them in one
 * sample — or, worse, walks away from shots the engine would take, and the
 * class reads as weaker than it is. Seven of seven past probe "findings" were
 * instrument defects of exactly that shape.
 *
 * The band has been copied wrong twice: Chebyshev, then the unrounded length
 * (`sightDistance`) while the engine rounds. So the test is the JOIN, over
 * every tile around a body: a lone foe standing there, the probe's own attack
 * record for Revolver Shot (`classStrikes` on the shipped class), and the
 * engine's own answer. `reachable` must pick the foe exactly when
 * `canUseTalent` says yes.
 *
 * Both are handed plain line of sight on an open level — the probe a bare
 * `LevelView`, the engine a world with no `lineClearFor` — so what is compared
 * is the distance band, which is what the probe copies.
 */

const N = 23;
const ORIGIN = { x: 11, y: 11 } as const;

function openLevel(): LevelView {
  return { w: N, h: N, tiles: new Array<number>(N * N).fill(TileCode.FLOOR) };
}

function body(id: string, kind: ActorKind, x: number, y: number): TalentActor {
  return { id, name: id, kind, x, y, hp: 10, maxHp: 10, alive: true, cooldowns: new Map() };
}

describe('fightlib `reachable` picks a foe exactly when Revolver Shot is legal', () => {
  it('agrees with canUseTalent on every tile of a 23x23 level', () => {
    const level = openLevel();
    const engine = createContentTalentEngine();
    const self: TalentActor = {
      ...body('p1', ActorKind.Player, ORIGIN.x, ORIGIN.y),
      // The shipped gun, or the engine stops at `NoShooter` before it measures.
      combat: INSPECTOR.combat,
    };
    const sheet = createTalentSheet({
      loadout: [revolverShot.id],
      resource: ResourceKind.Focus,
    });
    sheet.resource.value = Number.MAX_SAFE_INTEGER;
    engine.attach(self.id, sheet);

    const attack = classStrikes(INSPECTOR).find((a) => a.id === revolverShot.id);
    if (attack === undefined) throw new Error('classStrikes offers no Revolver Shot');
    // The record the probe builds is the talent's own band — the part copied
    // from content rather than measured. 5 and 3 are what the rims below mean.
    expect({ range: attack.range, minRange: attack.minRange }).toEqual({ range: 5, minRange: 3 });

    const disagreements: string[] = [];
    let legal = 0;
    let refused = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (x === ORIGIN.x && y === ORIGIN.y) continue;
        const foe = body('foe', ActorKind.Monster, x, y);
        const world: TalentWorld = {
          level,
          getActor: (id) => (id === self.id ? self : id === foe.id ? foe : undefined),
          actorAt: (ax, ay) =>
            ax === self.x && ay === self.y ? self : ax === foe.x && ay === foe.y ? foe : undefined,
          allActors: () => [self, foe],
          tryMove: () => ({ ok: false, reason: 'terrain' }),
          placeAt: () => false,
          vaultAt: () => undefined,
        };

        const engineSays =
          canUseTalent(engine, self, revolverShot, { x, y, actorId: foe.id }, world) === null;
        const probeSays = reachable(attack, self, [foe], level) !== undefined;
        if (engineSays) legal += 1;
        else refused += 1;
        if (engineSays !== probeSays) {
          disagreements.push(
            `(${String(x - ORIGIN.x)},${String(y - ORIGIN.y)}): engine ${String(engineSays)}, probe ${String(probeSays)}`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
    // NOT VACUOUS: both answers occurred.
    expect(legal).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('reaches the rounded rims: (5,2) and (2,2) are shots, (5,3) and (2,1) are not', () => {
    const attack = classStrikes(INSPECTOR).find((a) => a.id === revolverShot.id);
    if (attack === undefined) throw new Error('classStrikes offers no Revolver Shot');
    const level = openLevel();
    const at = (dx: number, dy: number): boolean =>
      reachable(attack, ORIGIN, [{ x: ORIGIN.x + dx, y: ORIGIN.y + dy }], level) !== undefined;

    expect(at(5, 2), '(5,2) is 5.39, which rounds to 5').toBe(true);
    expect(at(2, 2), '(2,2) is 2.83, which rounds to 3').toBe(true);
    expect(at(5, 3), '(5,3) is 5.83, which rounds to 6').toBe(false);
    expect(at(2, 1), '(2,1) is 2.24, which rounds to 2').toBe(false);
  });

  it('reports the gap in whole tiles, the number a caller compares with minRange', () => {
    const attack = classStrikes(INSPECTOR).find((a) => a.id === revolverShot.id);
    if (attack === undefined) throw new Error('classStrikes offers no Revolver Shot');
    const hit = reachable(attack, ORIGIN, [{ x: ORIGIN.x + 2, y: ORIGIN.y + 2 }], openLevel());
    expect(hit?.d).toBe(3);
  });
});
