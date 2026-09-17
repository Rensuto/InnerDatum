// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE LAYER THE FOG DOES NOT TAKE AWAY, AND IT HAS TO LOOK LIKE ITSELF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ruled on 2026-09-17, in the same breath as the ruling that made props line of
 * sight only: *"the exception is i want friendly npcs marked on the minimap and
 * also the entrance/exit to the level. this should be easily distinguishable in
 * the minimap when relatively close to it."*
 *
 * TWO CLAIMS, AND BOTH ARE TESTABLE HERE:
 *
 *   IT IS DRAWN AT ALL, on ground the player has never seen. Every other marker
 *   loop in `paintMap` is gated on `seen`, so the natural shape of this one is
 *   gated too — and gated is the feature deleted. The cases below paint a
 *   beacon on a cell outside the `seen` set and require its ink on the canvas,
 *   beside a SITE on the same cell that must not be drawn.
 *
 *   IT IS DISTINGUISHABLE, at `cell = 3` — which is what the real minimap runs
 *   at (`minimapRect`: a 33-tile window in 200x130). `beaconGlyph` is pure and
 *   exported precisely so the choice can be asserted rather than described: a
 *   friendly drawn in the party's own green is a stranger a player walks up to
 *   expecting a friend, and nothing else in this repository would fail.
 *
 * `paintMap` paints with `fillRect`, so this file drives it through a context
 * that records every fill with the style it was made in — the same measurement
 * `minimap-terrain.test.ts` uses, widened to keep the rectangle as well as the
 * colour, because half of what separates these marks is their shape.
 */

import { describe, expect, it } from 'vitest';

import { PALETTE } from '../../src/client/render/canvas.ts';
import {
  MINIMAP_MAX_H,
  MINIMAP_MAX_W,
  MINIMAP_RADIUS,
  beaconGlyph,
  paintMap,
} from '../../src/client/ui/mapview.ts';
import { BeaconKind, TileCode } from '../../src/shared/protocol.ts';
import type { BeaconView, SiteView } from '../../src/shared/protocol.ts';

/** One `fillRect`, with the style it was made in. */
type Fill = {
  readonly style: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

function recordingCtx(): { readonly fills: Fill[]; readonly ctx: CanvasRenderingContext2D } {
  const fills: Fill[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000000', globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'fillRect') {
        return (x: number, y: number, w: number, h: number) => {
          fills.push({ style: String(target.fillStyle), x, y, w, h });
        };
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { fills, ctx };
}

/**
 * THE REAL MINIMAP'S CELL SIZE, DERIVED RATHER THAN TYPED. `minimapRect` floors
 * `min(200/33, 130/33)` to 3, and every size claim below is about what survives
 * at three pixels — so a change to the box or the window has to reach this file
 * rather than leaving the assertions quietly measuring something else.
 */
const MINIMAP_CELL = Math.max(
  1,
  Math.floor(
    Math.min(MINIMAP_MAX_W / (MINIMAP_RADIUS * 2 + 1), MINIMAP_MAX_H / (MINIMAP_RADIUS * 2 + 1)),
  ),
);

/** A small open floor, big enough to hold a mark and a margin round it. */
const LEVEL = { w: 8, h: 8, tiles: new Array<number>(64).fill(TileCode.FLOOR) };

/**
 * One frame of the minimap-shaped call: the whole level, no window, and a `seen`
 * set that holds NOTHING. Every gated layer is therefore silent and whatever
 * lands on the canvas came from a pass that does not consult the fog.
 */
function paintOnUnseenGround(opts: {
  readonly beacons?: readonly BeaconView[];
  readonly sites?: readonly SiteView[];
  readonly party?: readonly { x: number; y: number; name: string }[];
}): readonly Fill[] {
  const { fills, ctx } = recordingCtx();
  paintMap({
    ctx,
    level: LEVEL,
    rect: { x: 0, y: 0, w: LEVEL.w * MINIMAP_CELL, h: LEVEL.h * MINIMAP_CELL },
    sites: opts.sites ?? [],
    framed: false,
    seen: new Set<string>(),
    ...(opts.party === undefined ? {} : { party: opts.party }),
    ...(opts.beacons === undefined ? {} : { beacons: opts.beacons }),
  });
  return fills;
}

/** Every distinct fill style on the canvas, in the order it was first used. */
function inksOf(fills: readonly Fill[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fill of fills) {
    if (seen.has(fill.style)) continue;
    seen.add(fill.style);
    out.push(fill.style);
  }
  return out;
}

const friendly = (x: number, y: number): BeaconView => ({ x, y, kind: BeaconKind.Friendly });
const entrance = (x: number, y: number): BeaconView => ({ x, y, kind: BeaconKind.Entrance });
const exitAt = (x: number, y: number): BeaconView => ({ x, y, kind: BeaconKind.Exit });

/** A gold, gradeless, unfiled place — the plainest thing the site loop draws. */
const SITE: SiteView = { marker: 'town:alderbrook', name: 'Alderbrook', x: 4, y: 4 };

describe('a beacon is drawn on ground you have never seen', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CASE THE WHOLE FEATURE IS, AND THE ONE A TIDYING PASS WOULD DELETE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MapPaint.seen` says a site or a roamer on an unseen cell *"is not drawn at
   * all: a map that hid the ground but kept the towns would give away exactly
   * what the fog is for"* — and that is right for every layer but this one. The
   * server has already fogged a beacon against the viewer's own body and
   * `MINIMAP_REVEAL_RADIUS`, and no hostile is ever in the list, so a `seen`
   * test here would delete the feature on precisely the tiles it exists for:
   * the door you have not found yet.
   *
   * MEASURED AGAINST A SITE ON THE SAME CELL, so this cannot pass by the fog
   * having quietly stopped working everywhere.
   */
  it('shows the way out through a wall the player has not been past', () => {
    const withBeacon = paintOnUnseenGround({ beacons: [exitAt(SITE.x, SITE.y)], sites: [SITE] });
    const inks = inksOf(withBeacon);
    expect(inks, 'the beacon pass is gated on the fog, so the feature is gone').toContain(
      beaconGlyph(BeaconKind.Exit, MINIMAP_CELL).ink,
    );
    expect(inks, 'the site loop stopped honouring the fog, so this proves nothing').not.toContain(
      PALETTE.GOLD,
    );
  });

  it('draws nothing for a beacon outside the window, which is not the fog', () => {
    /**
     * The window bounds are NOT the `seen` test and they stay: a mark outside
     * the drawn cells would be painted over the panel beside the map. This is
     * also the documented clip — `MINIMAP_RADIUS` is 16 while the server's
     * reveal radius is 20, so a friendly 17 tiles out is culled here.
     */
    const off = paintOnUnseenGround({ beacons: [friendly(LEVEL.w + 4, LEVEL.h + 4)] });
    expect(inksOf(off)).not.toContain(beaconGlyph(BeaconKind.Friendly, MINIMAP_CELL).ink);
  });

  it('draws nothing at all when the server sends no beacons', () => {
    // The absent list and the empty one mean the same thing, and the empty one
    // is how the last friendly to walk out of range leaves the map.
    const none = inksOf(paintOnUnseenGround({}));
    const empty = inksOf(paintOnUnseenGround({ beacons: [] }));
    expect(empty).toEqual(none);
    expect(none).not.toContain(beaconGlyph(BeaconKind.Friendly, MINIMAP_CELL).ink);
  });
});

describe('a beacon looks like nothing else on this map', () => {
  /**
   * `DANGER_INK`'s own rule: *"about one man in twelve cannot tell the amber
   * from the crimson"*, so a fact this map is asked for must never live in hue
   * alone. Every pair below is separated on BOTH channels, or says which one it
   * deliberately shares and what carries the difference instead.
   */
  const FRIENDLY = beaconGlyph(BeaconKind.Friendly, MINIMAP_CELL);
  const ENTRANCE = beaconGlyph(BeaconKind.Entrance, MINIMAP_CELL);
  const EXIT = beaconGlyph(BeaconKind.Exit, MINIMAP_CELL);

  it('never wears an ink that already means something else here', () => {
    /**
     * THE MUTANT THIS KILLS is a friendly drawn in `PARTY_INK`, which is the
     * single most tempting choice in the file — green already means "a person
     * who is on your side" on this surface — and the one that makes a player
     * walk up to a stranger expecting a friend. The rest are the inks whose
     * meanings a beacon must not borrow: upstream's object blue (which this map
     * spends on LOOT), the two "this will kill you" answers, the trap yellow,
     * and the golds and violets that mean a PLACE rather than a person.
     */
    const taken = [
      '#6fd3a8', // PARTY_INK — somebody you are playing with
      '#0000f0', // LOOT_INK / NEUTRAL_INK — engine/Object.lua:72
      '#f00000', // HOSTILE_INK
      '#c000af', // BOSS_INK
      '#f0f000', // TRAP_INK — engine/Trap.lua:60
      '#9a7fd6', // CROSSING_INK — the way between maps
      PALETTE.GOLD, // a settlement
      PALETTE.PARCHMENT, // you
      '#0b0912', // UNSEEN
    ];
    for (const ink of taken) {
      expect(FRIENDLY.ink, `a friendly beacon reuses ${ink}`).not.toBe(ink);
      expect(EXIT.ink, `a way off this map reuses ${ink}`).not.toBe(ink);
    }
    expect(FRIENDLY.ink).not.toBe(EXIT.ink);
  });

  it('separates a friendly from the way out on colour AND on size', () => {
    // Colour alone is a smudge at three pixels. The ways on and out are drawn
    // larger than a friendly, so the two do not resolve into one kind of dot on
    // a screenshot taken across a room.
    expect(EXIT.size).toBeGreaterThan(FRIENDLY.size);
    expect(FRIENDLY.ink).not.toBe(EXIT.ink);
  });

  it('separates the way in from the way out on SHAPE, sharing one ink on purpose', () => {
    /**
     * What a player hunts for is *a way off this floor*; which direction it goes
     * is the detail. So both wear one ink and the fill is the channel — and the
     * louder of the two shapes goes to the exit, because the way back is a thing
     * you note and walk away from.
     *
     * THE MUTANT: drop `hollow` and the two become the same mark. Nothing else
     * in the repository notices, and the minimap quietly stops answering half
     * the question it was added for.
     */
    expect(ENTRANCE.ink).toBe(EXIT.ink);
    expect(ENTRANCE.hollow).not.toBe(EXIT.hollow);
    expect(EXIT.hollow, 'the way ON is the solid one').toBe(false);
  });

  it('draws the hollow one with a real hole in it, not just a flag', () => {
    /**
     * `beaconGlyph` can answer `hollow` and the painter can ignore it. This is
     * the join: the entrance puts back a smaller INK rectangle that the exit
     * does not, so the two frames differ by exactly one fill.
     */
    const inFills = paintOnUnseenGround({ beacons: [entrance(4, 4)] });
    const outFills = paintOnUnseenGround({ beacons: [exitAt(4, 4)] });
    expect(inFills.length, 'the hollow is a flag nobody reads').toBe(outFills.length + 1);
    const hole = inFills.at(-1);
    expect(hole?.style).toBe(PALETTE.INK);
    expect(hole?.w).toBe(ENTRANCE.size - 2);
    expect(hole?.h).toBe(ENTRANCE.size - 2);
  });

  it('rings every beacon in INK so it survives the terrain under it', () => {
    /**
     * The map's bands are all desaturated — field `#4e5a44`, road `#8a8070`,
     * wall `#2a2733` — and a three-pixel dot with no outline reads as a bit of
     * terrain. The ring is also what separates a friendly beacon from a PARTY
     * mark, which is the same cell size and deliberately bare.
     */
    const fills = paintOnUnseenGround({ beacons: [friendly(4, 4)] });
    const ring = fills.find((fill) => fill.style === PALETTE.INK);
    const mark = fills.find((fill) => fill.style === FRIENDLY.ink);
    expect(ring, 'a beacon is drawn with no outline').toBeDefined();
    expect(mark).toBeDefined();
    expect(ring?.w).toBe(FRIENDLY.size + 2);
    // Centred on the same cell, one pixel out on every side.
    expect((mark?.x ?? 0) - (ring?.x ?? 0)).toBe(1);
    expect((mark?.y ?? 0) - (ring?.y ?? 0)).toBe(1);
  });

  it('keeps a friendly beacon and a party mark apart on both channels', () => {
    /**
     * They are the two "a person" marks on this surface and they are the pair a
     * player most needs to tell apart at a glance. Measured together in ONE
     * frame rather than asserted as two constants, because what matters is the
     * picture: two inks, and only one of them ringed.
     */
    const fills = paintOnUnseenGround({
      beacons: [friendly(2, 2)],
      party: [{ x: 5, y: 5, name: 'Sam' }],
    });
    const inks = inksOf(fills);
    expect(inks).toContain(FRIENDLY.ink);
    expect(inks).toContain('#6fd3a8');
    const mate = fills.find((fill) => fill.style === '#6fd3a8');
    const ringed = fills.filter((fill) => fill.style === PALETTE.INK);
    expect(mate, 'the party mark is gone').toBeDefined();
    expect(
      ringed,
      'the party mark grew an outline, so the ring stopped saying anything',
    ).toHaveLength(1);
  });
});

describe('a beacon is drawn on the cell it names', () => {
  it('puts the mark at x across and y down, and not the other way about', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SURVIVING MUTANT, AND IT IS THE ONE THING THE FEATURE WAS ASKED FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Swapping the two axes in the beacon loop — `ox + beacon.y * cell`,
     * `oy + beacon.x * cell` — left every case in this file green. Every fixture
     * cell was symmetric (4,4 / 2,2 / 12,12) and the level is square, so the
     * window cull could not tell them apart either. A minimap that points at the
     * transposed cell is precisely the failure the mark exists to prevent:
     * *"easily distinguishable in the minimap when relatively close to it"*.
     *
     * AN ASYMMETRIC CELL AND AN ABSOLUTE RECTANGLE. The inset is `beaconGlyph`'s
     * own arithmetic — the mark is bigger than a cell and is centred on it — so
     * this reads the drawn rectangle rather than a offset guessed here.
     */
    const cell = { x: 1, y: 5 };
    const glyph = beaconGlyph(BeaconKind.Friendly, MINIMAP_CELL);
    const inset = Math.floor((glyph.size - MINIMAP_CELL) / 2);
    const fills = paintOnUnseenGround({ beacons: [friendly(cell.x, cell.y)] });
    const mark = fills.find((fill) => fill.style === glyph.ink);
    expect(mark, 'no friendly mark was drawn at all').toBeDefined();
    expect(
      { x: mark?.x, y: mark?.y },
      'the beacon is drawn at the transposed cell — one down and five across',
    ).toEqual({ x: cell.x * MINIMAP_CELL - inset, y: cell.y * MINIMAP_CELL - inset });
    expect(mark?.w, 'the mark is not the size the glyph asked for').toBe(glyph.size);
  });

  it('draws two beacons on two different cells, not one on top of the other', () => {
    // The loop could read the right axes and still paint every mark at the same
    // place — `fills` holds one rectangle per beacon, so count them apart.
    const glyph = beaconGlyph(BeaconKind.Friendly, MINIMAP_CELL);
    const fills = paintOnUnseenGround({ beacons: [friendly(1, 5), friendly(6, 2)] });
    const marks = fills.filter((fill) => fill.style === glyph.ink);
    expect(marks, 'two friendlies did not make two marks').toHaveLength(2);
    expect(
      new Set(marks.map((mark) => `${String(mark.x)},${String(mark.y)}`)).size,
      'both friendlies landed on one rectangle',
    ).toBe(2);
  });
});

describe('a beacon sits over the places and under the people', () => {
  it('is drawn after the site dots and before the party and you', () => {
    /**
     * Order is the whole of the overlap rule and it is twenty lines from the
     * loop it concerns: a person you are playing with outranks a person you
     * have merely been told about, and your own mark outranks both. Asserted by
     * position on one canvas, because nothing else in the file would fail if the
     * pass were moved.
     *
     * The site is on a SEEN cell here — this case is about order, and a site on
     * unseen ground is not drawn at all.
     */
    const { fills, ctx } = recordingCtx();
    paintMap({
      ctx,
      level: LEVEL,
      rect: { x: 0, y: 0, w: LEVEL.w * MINIMAP_CELL, h: LEVEL.h * MINIMAP_CELL },
      sites: [SITE],
      framed: false,
      seen: new Set([`${String(SITE.x)},${String(SITE.y)}`]),
      beacons: [exitAt(SITE.x, SITE.y)],
      party: [{ x: 6, y: 6, name: 'Sam' }],
      self: { x: 1, y: 1 },
    });
    const at = (style: string): number => fills.findIndex((fill) => fill.style === style);
    const site = at(PALETTE.GOLD);
    const beacon = at(beaconGlyph(BeaconKind.Exit, MINIMAP_CELL).ink);
    const mate = at('#6fd3a8');
    const self = at(PALETTE.PARCHMENT);
    expect(site, 'the site was not drawn, so there is no order to read').toBeGreaterThan(-1);
    expect(beacon, 'a beacon now hides under a settlement dot').toBeGreaterThan(site);
    expect(mate, 'a beacon now covers a friend').toBeGreaterThan(beacon);
    expect(self, 'a beacon now covers you').toBeGreaterThan(mate);
  });
});
