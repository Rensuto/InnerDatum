// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The format under test is ported from t-engine4 data/maps/vaults/*.lua.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import {
  VAULT_TURNS,
  VaultTurn,
  defineVault,
  placeVault,
  stampVault,
  turnVault,
  vaultFits,
} from '../../src/shared/vault.ts';
import { ALL_VAULTS } from '../../src/shared/vaults.ts';

const LEGEND = { '#': TileCode.WALL, '.': TileCode.FLOOR };

/** A shape drawn back out as rows, so a failure is READABLE as a picture. */
function draw(shape: { w: number; h: number; tiles: readonly (number | null)[] }): string[] {
  const rows: string[] = [];
  for (let y = 0; y < shape.h; y += 1) {
    let row = '';
    for (let x = 0; x < shape.w; x += 1) {
      const code = shape.tiles[y * shape.w + x];
      row += code === null || code === undefined ? ' ' : code === TileCode.WALL ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

describe('the vault format', () => {
  it('refuses a ragged room at the moment it is authored', () => {
    /**
     * A typo in authored content should fail when the module loads, not when a
     * player happens to open the one delve that rolled it. Both of these are
     * shapes somebody would actually type.
     */
    expect(() => defineVault('v', ['##', '###'], LEGEND)).toThrow(/row 1 is 3 wide/);
    expect(() => defineVault('v', ['#?'], LEGEND)).toThrow(/not in the legend/);
    expect(() => defineVault('v', [], LEGEND)).toThrow(/no rows/);
  });

  it('reads a space as "leave whatever is already here"', () => {
    // The one addition to upstream's format, and what lets a room have a SHAPE
    // rather than arriving inside its own square block of wall.
    const v = defineVault('v', [' #', '. '], LEGEND);
    expect(v.tiles).toEqual([null, TileCode.WALL, TileCode.FLOOR, null]);
  });
});

describe('the six orientations', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AN ASYMMETRIC ROOM, SO EVERY TURN IS DISTINGUISHABLE FROM EVERY OTHER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A symmetric fixture would pass all six arms against a single implementation
   * that ignored its argument. This one is different under all six, and it is
   * NOT square — which is what catches a quarter turn that forgets to swap the
   * width and the height.
   */
  const L = defineVault('l', ['##.', '#..'], LEGEND);

  it('leaves the room alone when it is not turned', () => {
    expect(draw(turnVault(L, VaultTurn.None))).toEqual(['##.', '#..']);
  });

  it('turns a quarter clockwise, swapping the footprint', () => {
    const turned = turnVault(L, VaultTurn.Quarter);
    expect(turned.w).toBe(2);
    expect(turned.h).toBe(3);
    // Worked through by hand: a clockwise turn makes the LEFT column the TOP
    // row. Original `##.` / `#..` has left column (#, #), so the top row is
    // `##`, and the old bottom-left `#` lands top-right.
    expect(draw(turned)).toEqual(['##', '.#', '..']);
  });

  it('turns three quarters, which is the other way round', () => {
    const turned = turnVault(L, VaultTurn.ThreeQuarter);
    expect(turned.w).toBe(2);
    expect(turned.h).toBe(3);
    // The mirror of the above: anticlockwise makes the RIGHT column the top row.
    expect(draw(turned)).toEqual(['..', '#.', '##']);
  });

  it('turns a half, and a half is two quarters', () => {
    expect(draw(turnVault(L, VaultTurn.Half))).toEqual(['..#', '.##']);
    // THE COMPOSITION CHECK. Each arm is written out separately rather than
    // composed, so this is what notices if one of them drifts from the others.
    const once = defineVault('q', draw(turnVault(L, VaultTurn.Quarter)), LEGEND);
    expect(draw(turnVault(L, VaultTurn.Half))).toEqual(draw(turnVault(once, VaultTurn.Quarter)));
  });

  it('mirrors, which is not the same as turning', () => {
    expect(draw(turnVault(L, VaultTurn.FlipX))).toEqual(['.##', '..#']);
    expect(draw(turnVault(L, VaultTurn.FlipY))).toEqual(['#..', '##.']);
  });

  it('gives six genuinely different rooms, which is why there are six', () => {
    const seen = new Set(VAULT_TURNS.map((turn) => draw(turnVault(L, turn)).join('/')));
    expect(seen.size, 'two orientations produce the same room').toBe(VAULT_TURNS.length);
  });

  it('keeps every cell — a turn moves tiles, it does not lose them', () => {
    const floors = (turn: VaultTurn): number =>
      turnVault(L, turn).tiles.filter((t) => t === TileCode.FLOOR).length;
    for (const turn of VAULT_TURNS) {
      expect(floors(turn), `${turn} lost a tile`).toBe(floors(VaultTurn.None));
    }
  });
});

describe('placing a room in ground that already exists', () => {
  /** An open field, as a fit predicate. */
  const field =
    (w: number, h: number) =>
    (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h;

  it('answers null rather than forcing a room into a floor with no room', () => {
    // An ordinary answer, not a failure: the floor is still a floor, and the
    // caller carries on. See `placeVault`.
    const v = defineVault('big', ['####', '####'], LEGEND, { border: 1 });
    expect(placeVault(v, { w: 3, h: 3 }, field(3, 3), createRng('s'))).toBeNull();
  });

  it('keeps the clearance, so a room never lands flush against anything', () => {
    const v = defineVault('one', ['#'], LEGEND, { border: 1, turns: [VaultTurn.None] });
    // A 3x3 field has exactly one cell with a full ring around it.
    const spot = placeVault(v, { w: 3, h: 3 }, field(3, 3), createRng('s'));
    expect(spot?.at).toEqual({ x: 1, y: 1 });
  });

  it('is the same room in the same place for the same seed', () => {
    /**
     * `docs/tome-port.md`'s determinism contract is that a seed is the whole
     * map. A vault placed by an unseeded draw would make two players in one
     * instance disagree about where the walls are.
     */
    const v = ALL_VAULTS[0];
    if (v === undefined) throw new Error('no vaults');
    const once = placeVault(v, { w: 20, h: 20 }, field(20, 20), createRng('same'));
    const twice = placeVault(v, { w: 20, h: 20 }, field(20, 20), createRng('same'));
    expect(once?.at).toEqual(twice?.at);
    expect(once?.shape.tiles).toEqual(twice?.shape.tiles);
  });

  it('draws its orientation whether or not it finds a home', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DRAW HAPPENS ON EVERY PATH, WHICH IS A RULE ABOUT THE STREAM.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `shared/rng.ts` labels every draw because the sequence is the save: a draw
     * that happened only when a vault FIT would shift every later number in the
     * stream depending on the shape of the floor, and two clients replaying the
     * same seed would diverge from the first monster placed after it.
     */
    const v = defineVault('one', ['#'], LEGEND, { border: 0 });
    const fits = createRng('stream');
    const doesNot = createRng('stream');
    placeVault(v, { w: 8, h: 8 }, field(8, 8), fits);
    placeVault(v, { w: 0, h: 0 }, field(0, 0), doesNot);
    // Both consumed the turn draw, so the NEXT number matches.
    expect(fits.int('after', 0, 1_000_000)).toBe(doesNot.int('after', 0, 1_000_000));
  });

  it('writes only the cells that are part of the room', () => {
    const v = defineVault('l', [' #', '. '], LEGEND, { turns: [VaultTurn.None] });
    const written: string[] = [];
    stampVault(turnVault(v, VaultTurn.None), { x: 5, y: 7 }, (x, y, code) => {
      written.push(`${String(x)},${String(y)}=${String(code)}`);
    });
    expect(written).toEqual([`6,7=${String(TileCode.WALL)}`, `5,8=${String(TileCode.FLOOR)}`]);
  });

  it('refuses a spot whose clearance runs off the edge of the world', () => {
    const v = defineVault('one', ['#'], LEGEND, { border: 2, turns: [VaultTurn.None] });
    const shape = turnVault(v, VaultTurn.None);
    expect(vaultFits(shape, { x: 1, y: 1 }, field(9, 9), 2)).toBe(false);
    expect(vaultFits(shape, { x: 4, y: 4 }, field(9, 9), 2)).toBe(true);
  });
});
