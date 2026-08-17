/**
 * What a character has seen of a map, as a bitset.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A BITSET AND NOT A SET OF CELLS
 * ═══════════════════════════════════════════════════════════════════════════
 * The overworld is 170x100 = 17,000 cells. As `Set<"x,y">` that is 17,000
 * strings to hold, and as JSON it is roughly 130 KB to send or store — per
 * character, for a fact that is one bit per cell.
 *
 * As a bitset it is 2,125 bytes, and base64 of that is about 2,834 characters:
 * small enough to sit in a save file, small enough to ride on the frame that
 * already carries the map, and small enough that nobody has to design an
 * incremental protocol for it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS A RECORD OF EXPLORATION, NOT A VISIBILITY RULE
 * ═══════════════════════════════════════════════════════════════════════════
 * The server still decides what a client may know; this decides what a client
 * DRAWS on its map. Nothing here withholds information from a hostile client
 * and nothing here should ever be relied on to — that is the projector's job
 * and it does it per-viewer with `hasLineOfSight`.
 *
 * PURE. `src/shared/` bans `fs`, timers and randomness, and this needs none of
 * them: it is bit arithmetic and a base64 codec.
 */

/** How far a body reveals as it walks. Generous: this is a map, not a torch. */
export const REVEAL_RADIUS = 12;

/** Bytes needed for a map of this many cells. */
export function fogBytes(w: number, h: number): number {
  return Math.ceil((w * h) / 8);
}

export function createFog(w: number, h: number): Uint8Array {
  return new Uint8Array(fogBytes(w, h));
}

export function fogHas(fog: Uint8Array, w: number, x: number, y: number): boolean {
  const bit = y * w + x;
  const byte = fog[bit >> 3];
  return byte !== undefined && (byte & (1 << (bit & 7))) !== 0;
}

/** Returns true if this call actually changed anything. */
export function fogSet(fog: Uint8Array, w: number, x: number, y: number): boolean {
  const bit = y * w + x;
  const index = bit >> 3;
  const mask = 1 << (bit & 7);
  const byte = fog[index];
  if (byte === undefined || (byte & mask) !== 0) return false;
  fog[index] = byte | mask;
  return true;
}

/**
 * Reveal a disc around a point. Returns true if anything was newly seen, so a
 * caller can skip work — a party standing still must not mark a save dirty on
 * every pump.
 *
 * A CIRCLE RATHER THAN THE SQUARE THE LOOP WALKS, so the edge of what somebody
 * has explored looks like a place a person stood rather than a stamp.
 */
export function revealDisc(
  fog: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius = REVEAL_RADIUS,
): boolean {
  let changed = false;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (fogSet(fog, w, x, y)) changed = true;
    }
  }
  return changed;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BASE64 BY HAND, BECAUSE THIS FILE RUNS IN BOTH RUNTIMES
 * ═══════════════════════════════════════════════════════════════════════════
 * `Buffer` is Node-only and `btoa` is browser-only, and `src/shared/` compiles
 * with `types: []` — it is not allowed to know which one it is in. Twenty lines
 * of table lookup is cheaper than a polyfill dependency in a project whose
 * whole runtime is Fastify, zod and the Discord SDK.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function fogToBase64(fog: Uint8Array): string {
  let out = '';
  for (let i = 0; i < fog.length; i += 3) {
    const a = fog[i] ?? 0;
    const b = fog[i + 1] ?? 0;
    const c = fog[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] ?? '';
    out += B64[(n >> 12) & 63] ?? '';
    out += i + 1 < fog.length ? (B64[(n >> 6) & 63] ?? '') : '=';
    out += i + 2 < fog.length ? (B64[n & 63] ?? '') : '=';
  }
  return out;
}

/**
 * Decode into a buffer of exactly `bytes` length.
 *
 * REPAIR, NEVER REJECT — the doctrine `parseCharacterFile` applies to every
 * other field on disk. A truncated or over-long string yields as much fog as it
 * can and zeroes the rest, because the cost of being wrong is a player
 * re-walking some country, and the cost of throwing is a character that will
 * not load.
 */
export function fogFromBase64(text: string, bytes: number): Uint8Array {
  const fog = new Uint8Array(bytes);
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  let out = 0;
  for (let i = 0; i + 1 < clean.length && out < bytes; i += 4) {
    const n =
      (B64.indexOf(clean[i] ?? 'A') << 18) |
      (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      (B64.indexOf(clean[i + 2] ?? 'A') << 6) |
      B64.indexOf(clean[i + 3] ?? 'A');
    fog[out] = (n >> 16) & 255;
    out += 1;
    if (out < bytes) {
      fog[out] = (n >> 8) & 255;
      out += 1;
    }
    if (out < bytes) {
      fog[out] = n & 255;
      out += 1;
    }
  }
  return fog;
}

/** How many cells are known. Diagnostics and tests; never on a hot path. */
export function fogCount(fog: Uint8Array): number {
  let n = 0;
  for (const byte of fog) {
    let b = byte;
    while (b !== 0) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}
