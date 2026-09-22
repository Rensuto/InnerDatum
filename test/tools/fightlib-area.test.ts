// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { ALCHEMIST, REDACTOR } from '../../src/server/content/classes.ts';
import { alchemicVial } from '../../src/server/talents/alchemic_vial.ts';
import { expunge } from '../../src/server/talents/expunge.ts';
import { classStrikes, takeShot } from '../../tools/fightlib.mjs';
import type { ProbeAttack } from '../../tools/fightlib.d.mts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBE COUNTS THE BODIES THE ENGINE WILL HIT — PER SHAPE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `takeShot` declines an area talent aimed at a lone foe (`AREA_MINIMUM`), so
 * the probe's count of who a ball or a cross would catch decides whether the
 * anti-crowd buttons are ever pressed — and every density table is read off
 * probes that press them.
 *
 * The count was ONE Euclidean test for both shapes, `sightDistance <= radius`:
 * the five-tile plus at radius 1. That matched the vial's cross and matched
 * the ball while `ballTiles` cut the same plus. Balls take ToME's disc now —
 * the whole 3x3 at radius 1 — so the two shapes part at the diagonal, and the
 * count has to part with them: a ball catches a foe on the aimed foe's
 * diagonal, the vial does not.
 *
 * DRIVEN THROUGH `classStrikes` on the shipped classes, so the attack records
 * are the ones a probe actually builds, shape and radius included.
 */

/** A fake engine that accepts every talent and remembers what it was asked. */
function acceptingEngine() {
  const submitted: { readonly talentId: string; readonly at: unknown }[] = [];
  return {
    submitted,
    submitTalent: (_actorId: string, talentId: string, at: unknown) => {
      submitted.push({ talentId, at });
      return { ok: true };
    },
  };
}

function strikeFor(cls: unknown, id: string): ProbeAttack {
  const attack = classStrikes(cls).find((a) => a.id === id);
  if (attack === undefined) throw new Error(`classStrikes offers no ${id}`);
  return attack;
}

const SELF = { x: 0, y: 5 } as const;
const AIMED = { x: 3, y: 5 } as const;

describe('an area talent is pressed on a pair it will actually catch', () => {
  it('carries the shape and radius the talent authors', () => {
    expect(strikeFor(REDACTOR, expunge.id)).toMatchObject({ radius: 1, shape: 'ball' });
    expect(strikeFor(ALCHEMIST, alchemicVial.id)).toMatchObject({ radius: 1, shape: 'cross' });
  });

  it('fires a ball at a foe whose neighbour stands on its diagonal', () => {
    const ball = strikeFor(REDACTOR, expunge.id);
    const corner = { x: AIMED.x + 1, y: AIMED.y + 1 };
    const engine = acceptingEngine();

    const shot = takeShot(engine, 'p1', [ball], SELF, [AIMED, corner]);

    // SETUP: the nearest foe in band is the one aimed at, so the diagonal
    // really is the aimed tile's neighbour and not a second aim.
    expect(engine.submitted, 'the ball was not pressed').toHaveLength(1);
    expect(engine.submitted[0]?.at).toEqual({ x: AIMED.x, y: AIMED.y });
    expect(shot.fired).toBe(true);
  });

  it('holds the vial back from the same pair, because its cross misses the diagonal', () => {
    const vial = strikeFor(ALCHEMIST, alchemicVial.id);
    const corner = { x: AIMED.x + 1, y: AIMED.y + 1 };
    const engine = acceptingEngine();

    const shot = takeShot(engine, 'p1', [vial], SELF, [AIMED, corner]);

    expect(engine.submitted, 'the vial was thrown at a pair it hits one of').toEqual([]);
    expect(shot.fired).toBe(false);
  });

  it('throws the vial when the neighbour is on its arm', () => {
    // NOT VACUOUS: the vial is pressable at all, so the refusal above is the
    // shape doing the work and not the vial being unusable here.
    const vial = strikeFor(ALCHEMIST, alchemicVial.id);
    const beside = { x: AIMED.x, y: AIMED.y + 1 };
    const engine = acceptingEngine();

    const shot = takeShot(engine, 'p1', [vial], SELF, [AIMED, beside]);

    expect(engine.submitted).toHaveLength(1);
    expect(shot.fired).toBe(true);
  });
});
