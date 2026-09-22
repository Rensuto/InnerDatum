import { describe, expect, it } from 'vitest';

import { TargetAdvice, createTargeting } from '../../../src/client/input/targeting.ts';
import { MarkerKind } from '../../../src/client/render/canvas.ts';
import { allTalents } from '../../../src/server/content/classes.ts';
import { MELEE_REACH } from '../../../src/server/engine/combat.ts';
import { TargetShape, effectiveTalentRange } from '../../../src/server/engine/talents.ts';
import { TalentShape, TileCode } from '../../../src/shared/protocol.ts';
import type { LevelView, LoadoutTalent } from '../../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING REACHES AS FAR AS THE RANGE, NOT AS FAR AS ITS FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `buildRing` walks a square whose half-width is `floor(range)` and keeps the
 * cells within `range`. It used to keep the cells within the FLOOR, so every
 * talent at `MELEE_REACH` (1.5) drew a ring of 1: the four orthogonal
 * neighbours marked, the four diagonals blank, and the server accepting all
 * eight. Field Dressing and Move Along are the two the distance plan named; the
 * shipped-talent case below finds every `single` at a fractional range through
 * `allTalents()` — locked trees included — rather than listing them, so one
 * added later is covered without an edit here.
 *
 * ═══ THE INTEGER RING IS PINNED TOO, SO THE FIX CANNOT BE "MARK EVERYTHING" ═══
 * An integer range floors to itself, so a range-5 ring must come out exactly as
 * it did. Its pins are cells whose answer is the same under today's exact
 * Euclidean distance and under upstream's rounded `core.fov.distance`, so the
 * metric switch planned in docs/wip/distance does not have to edit them.
 */

const W = 15;
const H = 15;
const ORIGIN = { x: 7, y: 7 } as const;

function openLevel(): LevelView {
  return { w: W, h: H, tiles: new Array<number>(W * H).fill(TileCode.PLAINS) };
}

function single(range: number): LoadoutTalent {
  return {
    id: 'test_reach',
    name: 'Test Reach',
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

/** Open the mode on an empty plain and read back the offsets the ring marked Valid. */
function validOffsets(talent: LoadoutTalent): Set<string> {
  const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
  expect(targeting.begin(talent, { level: openLevel(), origin: ORIGIN })).toBe(true);
  return new Set(
    targeting
      .cells()
      .filter((cell) => cell.marker === MarkerKind.Valid)
      .map((cell) => `${String(cell.x - ORIGIN.x)},${String(cell.y - ORIGIN.y)}`),
  );
}

const NEIGHBOURS = ['-1,-1', '0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1', '1,1'] as const;

describe('an arm`s-length ring marks all eight neighbours', () => {
  it('marks the diagonals at MELEE_REACH, which the server has always accepted', () => {
    // THE NUMBER THE SERVER SHIPS, not a literal 1.5 — a second definition of
    // what melee means is how the two sides drift.
    expect(Number.isInteger(MELEE_REACH), 'melee reach is a whole number now').toBe(false);
    expect([...validOffsets(single(MELEE_REACH))].sort()).toEqual([...NEIGHBOURS].sort());
  });

  it('agrees with the cursor, which already said a diagonal was fine', () => {
    // `adviseTile` never floored, so the old ring and the old cursor disagreed
    // on exactly these four cells. Now the marker under the cursor and the
    // sentence beside it are one answer.
    const targeting = createTargeting({ onChange: () => {}, onCommit: () => {} });
    const diagonal = { x: ORIGIN.x + 1, y: ORIGIN.y + 1 };
    targeting.begin(single(MELEE_REACH), {
      level: openLevel(),
      origin: ORIGIN,
      occupied: [ORIGIN, diagonal],
    });
    targeting.hover(diagonal);
    expect(targeting.advice()).toBe(TargetAdvice.Ok);
    const ringHere = targeting
      .cells()
      .find((c) => c.x === diagonal.x && c.y === diagonal.y && c.marker === MarkerKind.Valid);
    expect(ringHere, 'the cursor says Ok on a cell the ring left blank').toBeDefined();
  });

  it('holds for every shipped talent whose single-target range is fractional, locked trees too', () => {
    /**
     * `allTalents()`, NOT the class loadouts. The loadouts miss every talent in
     * a tree no class owns — Full Swing sits in the locked Leverage tree, was
     * itself refused on the diagonal until it moved to `MELEE_REACH`, and a walk
     * of `CLASSES` never saw it. Every rank, through `effectiveTalentRange`, so
     * a talent whose reach grows into a fraction is found at the rank it does.
     */
    const fractional = allTalents().flatMap((t) => {
      if (t.targeting.shape !== TargetShape.Single) return [];
      const ranks = Array.from({ length: t.maxLevel ?? 5 }, (_u, i) => i + 1);
      return ranks
        .map((rank) => effectiveTalentRange(t.targeting, rank))
        .filter((range) => !Number.isInteger(range))
        .map((range) => ({ name: t.name, range }));
    });
    const names = fractional.map((t) => t.name);
    // NOT VACUOUS: the two the distance plan named, and the locked one.
    expect(names).toContain('Field Dressing');
    expect(names).toContain('Move Along');
    expect(names).toContain('Full Swing');

    for (const { name, range } of fractional) {
      const marked = validOffsets(single(range));
      for (const offset of NEIGHBOURS) {
        expect(marked.has(offset), `${name}'s ring leaves ${offset} blank`).toBe(true);
      }
    }
  });
});

describe('an integer ring is unchanged', () => {
  it('reaches the rim along both axes and at 3-4-5', () => {
    const ring = validOffsets(single(5));
    for (const offset of ['5,0', '0,-5', '-5,0', '3,4', '-4,-3']) {
      expect(ring.has(offset), `range 5 lost ${offset}`).toBe(true);
    }
  });

  it('still refuses the corners inside the square it walks', () => {
    const ring = validOffsets(single(5));
    // (4,4) is 5.66 away: inside the 11x11 box the loop covers and outside the
    // ring. It is the cell that proves the reach test still discriminates.
    for (const offset of ['4,4', '-4,4', '5,5', '5,-5']) {
      expect(ring.has(offset), `range 5 marked ${offset}`).toBe(false);
    }
    // And the caster's own tile is not decorated when there is no dead zone.
    expect(ring.has('0,0')).toBe(false);
  });
});
