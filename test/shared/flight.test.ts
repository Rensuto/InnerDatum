// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:872-882 (the projectile arm of spotHostiles)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { onFlightPath, orbsOnMyLine } from '../../src/shared/flight.ts';
import type { ProjectileView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE RULE, TWO CALLERS, AND THEY PARAMETERISE IT DIFFERENTLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream stops BOTH a rest and a run for an inbound orb, by one call —
 * `spotHostiles` with `actors_only` false, Player.lua:973 and :1131. Ours
 * stopped a rest for it (server-side) and let a walk carry on, because the
 * client could not reach the server's copy.
 *
 * The SERVER passes the orb's ORIGIN as the point naming the line, matching the
 * Lua's `core.fov.distance(sx, sy, tx, ty)` divisor literally. The CLIENT has no
 * origin — `ProjectileView` carries the current tile and the aim — so it passes
 * the CURRENT tile instead. That is only sound because an orb flies a straight
 * line and its current tile is on it, which is the assertion at the bottom of
 * this file rather than a claim in a comment.
 */

const orb = (x: number, y: number, tx: number, ty: number): ProjectileView => ({
  id: 'proj_1',
  x,
  y,
  targetX: tx,
  targetY: ty,
  turnsToImpact: 2,
});

describe('onFlightPath', () => {
  const me = { x: 4, y: 4 };

  it('a shot aimed straight at you is on your line', () => {
    expect(onFlightPath({ x: 10, y: 4 }, me, { x: 8, y: 4 }, me)).toBe(true);
  });

  it('counts a near miss, and the bound is STRICTLY less than one tile', () => {
    /**
     * `dist_to_line < 1.0`, not "aimed at my exact tile" — the bolt that will go
     * by your shoulder is a thing to stop walking for. Upstream measures to the
     * MATHEMATICAL trajectory rather than the drawn Bresenham staircase and says
     * so in its own comment, which is why the answer is fractional at all.
     *
     * THE BOUND IS STRICT, and writing this test the other way round is what
     * showed it: a body one row off a cardinal lane sits at exactly 1.0 and is
     * NOT counted. A diagonal lane is what produces a distance between 0 and 1 —
     * (5,4) is 0.707 from the line (10,10)->(0,0).
     */
    const diagonal = onFlightPath({ x: 10, y: 10 }, { x: 0, y: 0 }, { x: 7, y: 7 }, { x: 5, y: 4 });
    expect(diagonal, 'a body 0.707 off the line is a near miss and counts').toBe(true);

    const exactlyOne = onFlightPath({ x: 10, y: 5 }, { x: 0, y: 5 }, { x: 8, y: 5 }, me);
    expect(exactlyOne, 'one whole tile off is the boundary, and `< 1` excludes it').toBe(false);
  });

  it('a shot crossing the far side of the room does not', () => {
    // Four rows away. Without this term every shot fired anywhere in a long
    // room would keep the party standing.
    expect(onFlightPath({ x: 10, y: 8 }, { x: 0, y: 8 }, { x: 8, y: 8 }, me)).toBe(false);
  });

  it('a shot that has already gone past does not', () => {
    /**
     * The dot product. This orb is exactly on the line — it was aimed through
     * the body's tile — but it is now BEYOND it relative to the target, so it
     * cannot arrive. Without `our_way` a shot that missed would pin a player
     * standing for the rest of its flight.
     */
    expect(onFlightPath({ x: 0, y: 4 }, { x: 12, y: 4 }, { x: 8, y: 4 }, me)).toBe(false);
  });

  it('a shot with nowhere left to go is not a threat', () => {
    expect(onFlightPath(me, me, me, me)).toBe(false);
  });
});

describe('orbsOnMyLine', () => {
  const me = { x: 4, y: 4 };

  it('counts the ones coming and ignores the ones that are not', () => {
    const sky = [
      orb(8, 4, 0, 4), // straight down the lane at us
      orb(8, 9, 0, 9), // five rows away, going elsewhere
      orb(2, 4, 0, 4), // already past us, still on the line
    ];
    expect(orbsOnMyLine(sky, me)).toBe(1);
  });

  it('is zero for a viewer with no tile, rather than throwing', () => {
    // A spectating or bodiless socket. `selfTile()` is nullable and the driver
    // asks this every projectiles frame.
    expect(orbsOnMyLine([orb(8, 4, 0, 4)], null)).toBe(0);
  });

  it('is zero for an empty sky, so the walk is not stopped by nothing', () => {
    expect(orbsOnMyLine([], me)).toBe(0);
  });
});

describe('the two callers agree', () => {
  it('naming the line by the ORIGIN and by the CURRENT tile give one answer', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSUMPTION THAT LETS THE CLIENT SKIP A WIRE FIELD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The server passes `proj.origin`; the client passes `{orb.x, orb.y}`.
     * Those are different points, so this would be a real divergence if the
     * perpendicular distance to the line depended on WHICH point on it you
     * named. It does not — but "it does not" is exactly the kind of claim that
     * belongs in a test rather than a docblock, because the alternative is
     * adding an origin to every projectile frame to make the two calls look
     * alike.
     *
     * Swept over a fan of positions so this is a property, not one example.
     */
    const origin = { x: 12, y: 6 };
    const aim = { x: 0, y: 6 };
    for (let step = 1; step <= 10; step += 1) {
      const at = { x: origin.x - step, y: 6 };
      for (let by = 2; by <= 9; by += 1) {
        for (let bx = 0; bx <= 12; bx += 3) {
          const body = { x: bx, y: by };
          expect(
            onFlightPath(at, aim, at, body),
            `origin and current-tile disagreed for body (${String(bx)},${String(by)}) ` +
              `with the orb at (${String(at.x)},${String(at.y)})`,
          ).toBe(onFlightPath(origin, aim, at, body));
        }
      }
    }
  });
});
