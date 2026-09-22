// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { ALCHEMIST, REDACTOR } from '../../src/server/content/classes.ts';
import { alchemicVial } from '../../src/server/talents/alchemic_vial.ts';
import { expunge } from '../../src/server/talents/expunge.ts';
import { classStrikes, takeShot } from '../../tools/fightlib.mjs';
import type { ProbeAttack } from '../../tools/fightlib.d.mts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A BALL'S CATCH STOPS AT A WALL, AS THE ENGINE'S DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ballTiles` shadowcasts over the level now (`shared/ball.ts`), so a foe on
 * the far side of a wall from the aimed body is not caught — and a probe that
 * still counted the open disc would fire a ball at one body for the price of
 * an area. `caughtBy` asks on the ground `takeShot` is given.
 *
 * RADIUS 2, BY HAND. No ball a class carries today is wider than 1 (Expunge
 * and Scattershot), and radius 1 is the whole 3x3 whatever blocks, so with the
 * shipped kits this join cannot show a wall at all; the record below is
 * Expunge's own with its radius raised, which is the next ball to ship.
 */
describe('an area talent`s catch stops at a wall', () => {
  const W = 12;
  function levelWithWall(wall: { readonly x: number; readonly y: number }): LevelView {
    const tiles = new Array<number>(W * W).fill(TileCode.FLOOR);
    tiles[wall.y * W + wall.x] = TileCode.WALL;
    return { w: W, h: W, tiles };
  }
  const wide = (): ProbeAttack => ({ ...strikeFor(REDACTOR, expunge.id), radius: 2 });
  // Two tiles east of the aimed foe, with a wall between them: libfov's
  // fixture C, which hides exactly (2,0).
  const behind = { x: AIMED.x + 2, y: AIMED.y } as const;
  const wall = { x: AIMED.x + 1, y: AIMED.y } as const;

  it('holds the ball back from a pair a wall splits', () => {
    const engine = acceptingEngine();
    const shot = takeShot(
      engine,
      'p1',
      [wide()],
      SELF,
      [AIMED, behind],
      undefined,
      levelWithWall(wall),
    );
    expect(engine.submitted, 'the ball was pressed at a pair it hits one of').toEqual([]);
    expect(shot.fired).toBe(false);
  });

  it('fires it at the same pair on open ground', () => {
    // NOT VACUOUS: the wall is the only difference, so the refusal above is the
    // shadow and not the band.
    const engine = acceptingEngine();
    const open = levelWithWall({ x: 0, y: 0 });
    const shot = takeShot(engine, 'p1', [wide()], SELF, [AIMED, behind], undefined, open);
    expect(engine.submitted).toHaveLength(1);
    expect(shot.fired).toBe(true);
  });

  /**
   * AND ON A WORLD, which is what the in-process probes pass. `levelOf` takes a
   * World's `.level` and a bare view as it is; the two cases above are the bare
   * view. Read the World as a level and the ball has no map under it, so the
   * open-ground pair below is not a crowd; ignore it and the disc is open, so
   * the walled pair is. Each goes red on its own.
   */
  function worldWithWall(at: { readonly x: number; readonly y: number }) {
    const world = createWorld('fightlib-area', {
      view: levelWithWall(at),
      spawns: [{ x: 1, y: 1 }],
      sites: new Map<string, string>(),
    });
    expect(typeof world.lineClearFor, 'this is not the World branch').toBe('function');
    return world;
  }

  it('holds the ball back from a pair a wall splits, on a real World', () => {
    const engine = acceptingEngine();
    const world = worldWithWall(wall);
    const shot = takeShot(engine, 'p1', [wide()], SELF, [AIMED, behind], undefined, world);
    expect(engine.submitted, 'the ball was pressed at a pair it hits one of').toEqual([]);
    expect(shot.fired).toBe(false);
  });

  it('fires it at the same pair on a real World with open ground', () => {
    const engine = acceptingEngine();
    const world = worldWithWall({ x: 0, y: 0 });
    const shot = takeShot(engine, 'p1', [wide()], SELF, [AIMED, behind], undefined, world);
    expect(engine.submitted).toHaveLength(1);
    expect(shot.fired).toBe(true);
  });
});
