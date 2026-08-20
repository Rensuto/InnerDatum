/**
 * The fog bitset — the thing that makes exploration survive a reload.
 *
 * Every assertion here is about a property the SAVE depends on: it round-trips,
 * it survives a map that changed size, and it never claims ground nobody stood
 * near.
 */

import { describe, expect, it } from 'vitest';

import {
  REVEAL_RADIUS,
  createFog,
  fogBytes,
  fogCount,
  fogFromBase64,
  fogHas,
  fogSet,
  fogToBase64,
  revealDisc,
  revealDiscExcept,
} from '../../src/shared/fog.ts';

const W = 170;
const H = 100;

describe('it is small enough to keep', () => {
  it('spends one bit per cell', () => {
    // THE WHOLE REASON FOR A BITSET. The same fact as a Set of "x,y" strings is
    // roughly 130 KB per character; this is 2,125 bytes, and its base64 is
    // small enough to ride on the frame that already carries the map.
    expect(fogBytes(W, H)).toBe(2125);
    expect(fogToBase64(createFog(W, H)).length).toBeLessThan(3000);
  });
});

describe('it round-trips exactly', () => {
  it('survives base64 and back', () => {
    const fog = createFog(W, H);
    revealDisc(fog, W, H, 122, 73);
    revealDisc(fog, W, H, 20, 20);
    const back = fogFromBase64(fogToBase64(fog), fogBytes(W, H));
    expect([...back]).toEqual([...fog]);
    expect(fogCount(back)).toBe(fogCount(fog));
  });

  it('repairs rather than rejects a damaged string', () => {
    // The doctrine every other field on disk follows: a truncated save costs a
    // player some re-walked country, never a character that will not load.
    const fog = createFog(W, H);
    revealDisc(fog, W, H, 80, 50);
    const truncated = fogToBase64(fog).slice(0, 200);
    const back = fogFromBase64(truncated, fogBytes(W, H));
    expect(back.length).toBe(fogBytes(W, H));
    expect(fogCount(back)).toBeLessThanOrEqual(fogCount(fog));
  });

  it('fills what it can when the map has grown since the save', () => {
    // A save written against a smaller region decodes into the bigger buffer
    // with the new ground left unexplored, which is the honest answer.
    const small = createFog(96, 64);
    revealDisc(small, 96, 64, 40, 30);
    const grown = fogFromBase64(fogToBase64(small), fogBytes(W, H));
    expect(grown.length).toBe(fogBytes(W, H));
    expect(fogCount(grown)).toBeGreaterThan(0);
  });
});

describe('it reveals a disc, not a box', () => {
  it('leaves the corners of the square unseen', () => {
    // The edge of what somebody has explored should look like a place a person
    // stood, not like a stamp. The corner of the bounding square is
    // radius * sqrt(2) away and must stay dark.
    const fog = createFog(W, H);
    revealDisc(fog, W, H, 80, 50);
    expect(fogHas(fog, W, 80, 50)).toBe(true);
    expect(fogHas(fog, W, 80 + REVEAL_RADIUS, 50)).toBe(true);
    expect(fogHas(fog, W, 80 + REVEAL_RADIUS, 50 + REVEAL_RADIUS)).toBe(false);
  });

  it('clips at the edges rather than wrapping', () => {
    // A wrap would reveal the far side of the region from the near one, which
    // is the one bug a flat bit array invites.
    const fog = createFog(W, H);
    revealDisc(fog, W, H, 0, 0);
    expect(fogHas(fog, W, W - 1, 0)).toBe(false);
    expect(fogHas(fog, W, 0, H - 1)).toBe(false);
  });

  it('reports whether anything was NEW, so standing still writes nothing', () => {
    // The save is queued only when this answers true. Without it a party pacing
    // one street would ask for a write on every step.
    const fog = createFog(W, H);
    expect(revealDisc(fog, W, H, 50, 50)).toBe(true);
    expect(revealDisc(fog, W, H, 50, 50)).toBe(false);
    expect(fogSet(fog, W, 50, 50)).toBe(false);
    expect(fogSet(fog, W, 0, 0)).toBe(true);
  });
});

describe('one character is not another', () => {
  it('keeps two maps independent', () => {
    // The request in one line: six people can walk the same region and each has
    // their own map of it, because exploring is something you did.
    const mine = createFog(W, H);
    const theirs = createFog(W, H);
    revealDisc(mine, W, H, 20, 20);
    expect(fogCount(mine)).toBeGreaterThan(0);
    expect(fogCount(theirs)).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BULK REVEAL MUST NOT HAND OVER A SECRET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SiteDef.hidden` places are filtered out of a player's map until their own
 * fog holds the cell they stand on, so anything that reveals ground in bulk can
 * uncover one by accident. Marking the country a rumour names did exactly that:
 * Barrow End is 8 tiles from the Blackwater Wood's anchor and Cairnfoot 10 from
 * the Bracken Waste's, both inside a radius of 12.
 */
describe('a disc that leaves some cells covered', () => {
  it('reveals the ground around a cell it is told to skip', () => {
    const fog = createFog(40, 40);
    const secret = '20,20';
    expect(revealDiscExcept(fog, 40, 40, 20, 20, new Set([secret]))).toBe(true);
    // The neighbours are seen…
    expect(fogHas(fog, 40, 19, 20)).toBe(true);
    expect(fogHas(fog, 40, 21, 20)).toBe(true);
    expect(fogHas(fog, 40, 20, 19)).toBe(true);
    // …and the cell itself is not. A wood you can see, with a barrow you cannot.
    expect(fogHas(fog, 40, 20, 20)).toBe(false);
  });

  it('is otherwise the same disc', () => {
    const plain = createFog(40, 40);
    const spared = createFog(40, 40);
    revealDisc(plain, 40, 40, 20, 20);
    revealDiscExcept(spared, 40, 40, 20, 20, new Set());
    expect([...spared]).toEqual([...plain]);
  });

  it('answers false when it changed nothing, so a caller does not queue a save', () => {
    const fog = createFog(40, 40);
    // A disc whose ONLY cell is excluded reveals nothing at all.
    expect(revealDiscExcept(fog, 40, 40, 20, 20, new Set(['20,20']), 0)).toBe(false);
  });

  it('still reveals when walking, which is a different function', () => {
    // The distinction the feature rests on: being TOLD about a place is refused,
    // being THERE is not. `revealDisc` has no exclusions and keeps none.
    const fog = createFog(40, 40);
    revealDisc(fog, 40, 40, 20, 20);
    expect(fogHas(fog, 40, 20, 20)).toBe(true);
  });
});
