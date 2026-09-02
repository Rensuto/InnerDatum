import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TargetAdvice, createTargeting } from '../../../src/client/input/targeting.ts';
import { hasLineOfSight } from '../../../src/shared/sight.ts';
import { TalentShape, TileCode } from '../../../src/shared/protocol.ts';
import type { LevelView, LoadoutTalent } from '../../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING MUST NOT OFFER A SHOT THE SERVER WILL REFUSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `targeting.ts` says this itself, and says it as the justification for being a
 * deliberate reimplementation of the server's trace rather than a shared one:
 * *"the ring never offers a shot the server will refuse for a corner the player
 * cannot see."*
 *
 * It compared to `TileCode.WALL` — ONE code — while the server asks
 * `blocksSightAt`, which is `protocol.ts`'s closed-default predicate over
 * MOUNTAIN, CRAG, TREES, roofs and ERASED. Interiors were the only place the
 * two agreed, because every interior is built out of FLOOR and WALL and nothing
 * else. On the 170x100 overworld, where `TileCode.WALL` does not appear at all,
 * the ring offered a clear shot straight through a mountain range and the server
 * answered `NoLos`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ASSERTION IS AGREEMENT, NOT A SECOND OPINION
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS PARAGRAPH USED TO SAY THE TESTS IMPORT **BOTH** TRACES AND COMPARE THEM,
 * and that was the whole design: production code may not import across
 * `client -> server`, a test may, and comparing the two copies was what that
 * freedom was for.
 *
 * THERE IS ONLY ONE TRACE NOW. `hasLineOfSight` moved to `shared/sight.ts`,
 * which both sides may import, so the copy in `targeting.ts` is gone and a test
 * that compared them would be importing the same function twice — vacuously
 * green, exactly the trap `talent-kinds.test.ts` documents ("renaming the enum
 * moves both sides").
 *
 * So what these assertions test is no longer AGREEMENT but INTEGRATION: that the
 * ring's published advice matches the trace it is built on. The agreement
 * property is now carried by the guard at the bottom of this file, which asserts
 * there is exactly one definition to agree with.
 */

const W = 24;
const H = 9;

function level(fill: TileCode = TileCode.PLAINS): LevelView {
  return { w: W, h: H, tiles: new Array<number>(W * H).fill(fill) };
}

function put(view: LevelView, x: number, y: number, code: TileCode): void {
  view.tiles[y * W + x] = code;
}

function bolt(range: number): LoadoutTalent {
  return {
    id: 'test_bolt',
    name: 'Test Bolt',
    icon: 'icon_talent_revolver_shot',
    shape: TalentShape.Single,
    range,
    minRange: 0,
    radius: 0,
    apCost: 1,
    mpCost: 0,
    cooldownTurns: 0,
    ready: true,
    known: true,
  } as unknown as LoadoutTalent;
}

/** What this client would tell the player about aiming at `to` from `from`. */
function adviceThrough(
  view: LevelView,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const targeting = createTargeting({
    onChange: () => {},
    onCommit: () => {},
  });
  targeting.begin(bolt(20), { level: view, origin: from, occupied: [to] });
  targeting.hover(to);
  return targeting.advice();
}

/**
 * EVERY CODE THAT STOPS AN EYE, and the two transparent oddities beside them.
 * Named one at a time rather than looped over `TileCode` so that a NEW code
 * added to the enum does not silently join a list nobody re-read.
 */
const SOLID = [
  ['a mountain', TileCode.MOUNTAIN],
  ['a crag', TileCode.CRAG],
  ['a stand of trees', TileCode.TREES],
  ['erasure', TileCode.ERASED],
  ['an interior wall', TileCode.WALL],
] as const;

describe('the aim preview and the server agree about what blocks an eye', () => {
  for (const [what, code] of SOLID) {
    it(`refuses a shot through ${what}, exactly as the server does`, () => {
      const view = level();
      const from = { x: 2, y: 4 };
      const to = { x: 12, y: 4 };
      put(view, 7, 4, code);

      // THE SERVER'S ANSWER FIRST, so the test states what it is mirroring.
      expect(hasLineOfSight(view, from, to)).toBe(false);
      // And the client must not be more permissive than that.
      expect(adviceThrough(view, from, to)).not.toBe(TargetAdvice.Ok);
    });
  }

  it('allows the shot when the lane is clear, so the refusals above mean something', () => {
    const view = level();
    const from = { x: 2, y: 4 };
    const to = { x: 12, y: 4 };

    expect(hasLineOfSight(view, from, to)).toBe(true);
    expect(adviceThrough(view, from, to)).toBe(TargetAdvice.Ok);
  });

  it('shoots across water, which stops a body and not an eye', () => {
    /**
     * `blocksSight` names water and deep water as its two transparent
     * exceptions alongside walkable ground, and it is the free tactical win in
     * the whole terrain plan: a channel gives real ranged play with no engine
     * change at all. A client that treated "not walkable" as "solid" would
     * throw that away, which is why this file asserts the permissive case as
     * hard as it asserts the refusals.
     */
    const view = level();
    const from = { x: 2, y: 4 };
    const to = { x: 12, y: 4 };
    for (let x = 6; x <= 8; x += 1) put(view, x, 4, TileCode.WATER);

    expect(hasLineOfSight(view, from, to)).toBe(true);
    expect(adviceThrough(view, from, to)).toBe(TargetAdvice.Ok);
  });

  it('refuses a target STANDING on something solid', () => {
    // The friendlier of the two refusals — `Blocked` rather than `NoLos` — and
    // it has to move with the trace or the two disagree about the last cell.
    const view = level();
    const from = { x: 2, y: 4 };
    const to = { x: 12, y: 4 };
    put(view, to.x, to.y, TileCode.MOUNTAIN);

    expect(adviceThrough(view, from, to)).toBe(TargetAdvice.Blocked);
  });
});

// ---------------------------------------------------------------------------
// The guard that replaced the comparison
// ---------------------------------------------------------------------------

describe('there is exactly one line-of-sight trace', () => {
  it('no module defines its own', () => {
    /**
     * The property the old two-trace comparison existed to protect, asserted
     * directly and cheaply. A second copy could not be caught by a test that
     * imports one of them — it would simply not be the one under test.
     *
     * `targeting.ts` carried such a copy for two milestones, byte-identical to
     * the server's, on the reasoning that `client -> server` imports are banned.
     * They are, and `shared/` was always the third option.
     */
    const dir = new URL('../../../src/', import.meta.url);
    const offenders: string[] = [];
    const walk = (at: URL): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), at);
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (child.pathname.endsWith('shared/sight.ts')) continue;
        const text = readFileSync(child, 'utf8');
        if (/function hasLineOfSight\s*\(/.test(text)) offenders.push(child.pathname);
      }
    };
    walk(dir);
    expect(offenders, 'a second line-of-sight trace exists — import shared/sight.ts').toEqual([]);
  });
});
