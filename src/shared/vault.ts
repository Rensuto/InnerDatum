// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/maps/vaults/*.lua — the ASCII
// map FORMAT and its `rotates` list, not any of the maps themselves.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              A ROOM SOMEBODY DREW, DROPPED INTO A FLOOR NOBODY DID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/tome-port.md`'s port map has carried one line about this since M4:
 * *"`data/maps/**` (ASCII vaults) — PORT THE FORMAT — it's genuinely good and
 * free"*. It is the format that is good, and this is it: rows of characters, a
 * legend, a clearance, and the six orientations upstream lists on nearly every
 * vault it ships (`rotates = {"default","90","180","270","flipx","flipy"}`).
 *
 * ═══ WHAT IT IS FOR ═══
 * `shared/sitemap.ts` grows four shapes — a town, a cave, a ruin, a works — and
 * every one is honest procedural noise. Noise is good at floors and bad at
 * ROOMS: it cannot make a chamber that reads as built, or a dead end that reads
 * as deliberate, because it has no intent to express. A vault is the intent,
 * drawn once by a person and stamped into the noise.
 *
 * ═══ WHAT IS DELIBERATELY NOT PORTED ═══
 * Upstream's `defineTile` takes object and actor FILTERS — `{random_filter={
 * type="scroll", tome_mod="vault"}}` — so a vault can specify what spawns on a
 * given character. That is a content-generation system with a rarity table
 * behind it, and this game populates rooms from `content/delve.ts` by weight
 * instead. A vault here says what the GROUND is and nothing about what stands
 * on it, which keeps one answer to "what is in this room".
 *
 * `setStatusAll{no_teleport=true, ...}` is likewise absent: it flags a room
 * against systems (teleport, room_map) that have no referent here.
 */

import type { Rng } from './rng.ts';

/**
 * The six orientations upstream lists, and no seventh.
 *
 * They are not arbitrary: they are the eight symmetries of a square minus the
 * two that need a diagonal mirror, which is what you get for free from index
 * arithmetic on a rectangular grid. Upstream writes the same six out by hand on
 * vault after vault, so this is that list given a name.
 */
export const VaultTurn = {
  /** Upstream's `"default"`. */
  None: 'none',
  /** `"90"` — a quarter turn clockwise. */
  Quarter: 'quarter',
  /** `"180"`. */
  Half: 'half',
  /** `"270"` — a quarter turn anticlockwise. */
  ThreeQuarter: 'three_quarter',
  /** `"flipx"` — mirrored left-to-right. */
  FlipX: 'flipx',
  /** `"flipy"` — mirrored top-to-bottom. */
  FlipY: 'flipy',
} as const;
export type VaultTurn = (typeof VaultTurn)[keyof typeof VaultTurn];

export const VAULT_TURNS: readonly VaultTurn[] = [
  VaultTurn.None,
  VaultTurn.Quarter,
  VaultTurn.Half,
  VaultTurn.ThreeQuarter,
  VaultTurn.FlipX,
  VaultTurn.FlipY,
] as const;

/**
 * A drawn room, before it is turned or placed.
 *
 * ROWS ARE VALIDATED AT CONSTRUCTION rather than at stamp time — see
 * `defineVault`. A vault with a ragged row is a typo in authored content, and
 * the moment to find it is when the module loads, not when a player happens to
 * open the one delve that rolled it.
 */
export type Vault = {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  /** Row-major, `w * h` long. `null` means "leave whatever is already here". */
  readonly tiles: readonly (number | null)[];
  /**
   * Upstream's `border`. How many tiles of FLOOR-OR-WALL must exist around the
   * footprint for a placement to be legal — a vault flush against the edge of
   * the map, or against another vault, reads as a mistake rather than a room.
   */
  readonly border: number;
  /** Which orientations this room may be placed in. Upstream's `rotates`. */
  readonly turns: readonly VaultTurn[];
};

/**
 * Build a vault from rows and a legend, checking it as it goes.
 *
 * ═══ A SPACE MEANS "NOT PART OF THE ROOM" ═══
 * Upstream's vaults are full rectangles because its generator carves them into
 * solid rock, so every cell has something to say. Ours are stamped into a floor
 * that already exists, and a rectangle would mean every vault arrives inside its
 * own square block of wall. The blank is what lets a drawn room have a SHAPE —
 * an L, a cross, a ragged edge — and it is the one addition to the format.
 */
export function defineVault(
  id: string,
  rows: readonly string[],
  legend: Readonly<Record<string, number>>,
  options: { readonly border?: number; readonly turns?: readonly VaultTurn[] } = {},
): Vault {
  const h = rows.length;
  if (h === 0) throw new Error(`vault '${id}': no rows`);
  const w = rows[0]?.length ?? 0;
  if (w === 0) throw new Error(`vault '${id}': first row is empty`);

  const tiles: (number | null)[] = [];
  for (let y = 0; y < h; y += 1) {
    const row = rows[y] ?? '';
    if (row.length !== w) {
      throw new Error(
        `vault '${id}': row ${String(y)} is ${String(row.length)} wide, expected ${String(w)}`,
      );
    }
    for (let x = 0; x < w; x += 1) {
      const ch = row.charAt(x);
      if (ch === ' ') {
        tiles.push(null);
        continue;
      }
      const code = legend[ch];
      if (code === undefined) {
        throw new Error(
          `vault '${id}': row ${String(y)} column ${String(x)} is '${ch}', not in the legend`,
        );
      }
      tiles.push(code);
    }
  }

  return {
    id,
    w,
    h,
    tiles,
    border: Math.max(0, Math.floor(options.border ?? 1)),
    turns: options.turns ?? VAULT_TURNS,
  };
}

/** The footprint of a vault once turned. */
export type VaultShape = {
  readonly w: number;
  readonly h: number;
  readonly tiles: readonly (number | null)[];
};

/**
 * One of the six orientations, as index arithmetic.
 *
 * WRITTEN OUT RATHER THAN COMPOSED from a rotate-once helper. Composition is
 * shorter and it puts a 270 three allocations away from a 90 while making the
 * off-by-one in either invisible; each arm here is four lines and is its own
 * test.
 */
export function turnVault(vault: Vault, turn: VaultTurn): VaultShape {
  const { w, h, tiles } = vault;
  const read = (x: number, y: number): number | null => tiles[y * w + x] ?? null;

  if (turn === VaultTurn.None) return { w, h, tiles };

  if (turn === VaultTurn.Half) {
    const out: (number | null)[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) out.push(read(w - 1 - x, h - 1 - y));
    }
    return { w, h, tiles: out };
  }

  if (turn === VaultTurn.FlipX) {
    const out: (number | null)[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) out.push(read(w - 1 - x, y));
    }
    return { w, h, tiles: out };
  }

  if (turn === VaultTurn.FlipY) {
    const out: (number | null)[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) out.push(read(x, h - 1 - y));
    }
    return { w, h, tiles: out };
  }

  // THE TWO THAT CHANGE THE FOOTPRINT. A quarter turn swaps width and height,
  // which is the whole reason `vaultFits` takes a shape rather than a vault.
  const out: (number | null)[] = [];
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < h; x += 1) {
      out.push(turn === VaultTurn.Quarter ? read(y, h - 1 - x) : read(w - 1 - y, x));
    }
  }
  return { w: h, h: w, tiles: out };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE IT MAY GO — and the answer is usually "nowhere", which is fine.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A vault is stamped into a floor that has already been generated, so placement
 * is a search rather than a construction. Upstream carves its vaults into solid
 * rock during generation and can therefore always succeed; ours has to find a
 * patch of an existing map that can afford to become a room.
 *
 * ═══ IT MAY LAND IN ROCK, AND THAT IS UPSTREAM'S SHAPE ═══
 * The first version required every cell of the footprint to be FLOOR already,
 * on the reasoning that stamping into rock would bury a room nobody could
 * reach. MEASURED across 40 seeds a shape, that rule placed a vault in 94% of
 * ruins, 12% of caves, and — the number that mattered — **0 of 120 attempts in
 * a works**, whose corridors are one tile wide and therefore never contain a
 * rectangle a room could sit in. A third of the delve shapes would have shipped
 * with the feature dead in them.
 *
 * Upstream carves its vaults into solid rock and lets the generator join them
 * up. Ours can do the same because `connect` ALREADY EXISTS to find orphaned
 * floor and dig a corridor to it, and a vault's interior is exactly that — a
 * pocket of floor with no route to the threshold, which is the case that
 * function was written for. So the caller's predicate is about BOUNDS, not
 * about what is already there, and a room in the rock is a chamber you tunnel
 * into rather than a bug.
 *
 * The `border` ring is upstream's own field and still earns its place: it keeps
 * a room off the edge of the map, where a wall drawn flush against the boundary
 * reads as the map ending rather than as a room.
 */
export function vaultFits(
  shape: VaultShape,
  at: { readonly x: number; readonly y: number },
  isOpen: (x: number, y: number) => boolean,
  border: number,
): boolean {
  for (let y = -border; y < shape.h + border; y += 1) {
    for (let x = -border; x < shape.w + border; x += 1) {
      if (!isOpen(at.x + x, at.y + y)) return false;
    }
  }
  return true;
}

/**
 * Find a placement, or answer null.
 *
 * ═══ NULL IS AN ORDINARY ANSWER AND NOT A FAILURE ═══
 * A cave that happens to have no open rectangle the size of the room simply
 * does not get one, and the floor it generated is still a floor. The caller
 * carries on. Treating this as an error would mean a delve that fails to open
 * because a decoration could not be placed.
 *
 * ═══ THE SEARCH IS SEEDED AND EXHAUSTIVE, IN THAT ORDER ═══
 * Two draws, both unconditional: the orientation, then WHERE THE SCAN STARTS.
 * From there every position is walked once, wrapping, and the first fit wins.
 *
 * The start offset is what stops every vault in the game appearing in the
 * top-left corner — a plain scan from (0,0) returns the first legal spot, which
 * for a bounds-only predicate is always the same spot. And it is a scan with a
 * moving start rather than "pick a spot, retry if it fails", because retries
 * consume a variable number of draws and the number of times a floor happened
 * to be unlucky would then shift every later number in the stream.
 */
export function placeVault(
  vault: Vault,
  bounds: { readonly w: number; readonly h: number },
  isOpen: (x: number, y: number) => boolean,
  rng: Rng,
): {
  readonly at: { x: number; y: number };
  readonly shape: VaultShape;
  /** Which of the six it was laid in — recorded on `AuthoredMap.vaults`. */
  readonly turn: VaultTurn;
} | null {
  const turns = vault.turns.length === 0 ? [VaultTurn.None] : vault.turns;
  // ONE DRAW, ALWAYS, whether or not a fit is found. A draw that happens only
  // on some paths moves every later number in the stream — the labelled-draw
  // rule in shared/rng.ts is about exactly this.
  const turn = turns[rng.int('vault.turn', 0, turns.length - 1)] ?? VaultTurn.None;
  const shape = turnVault(vault, turn);

  const cols = bounds.w - shape.w + 1;
  const rows = bounds.h - shape.h + 1;
  // THE DRAW HAPPENS EVEN WHEN THE ROOM CANNOT POSSIBLY FIT, for the reason the
  // turn draw does: a draw on only some paths moves every later number.
  const start = rng.int('vault.spot', 0, Math.max(0, cols * rows - 1));
  if (cols <= 0 || rows <= 0) return null;

  const spots = cols * rows;
  for (let n = 0; n < spots; n += 1) {
    const i = (start + n) % spots;
    const at = { x: i % cols, y: Math.floor(i / cols) };
    if (vaultFits(shape, at, isOpen, vault.border)) return { at, shape, turn };
  }
  return null;
}

/**
 * Write the room onto the grid.
 *
 * A `null` cell is SKIPPED rather than written, which is what makes a vault a
 * shape rather than a rectangle — see `defineVault`.
 */
export function stampVault(
  shape: VaultShape,
  at: { readonly x: number; readonly y: number },
  write: (x: number, y: number, code: number) => void,
): void {
  for (let y = 0; y < shape.h; y += 1) {
    for (let x = 0; x < shape.w; x += 1) {
      const code = shape.tiles[y * shape.w + x];
      if (code === null || code === undefined) continue;
      write(at.x + x, at.y + y, code);
    }
  }
}
