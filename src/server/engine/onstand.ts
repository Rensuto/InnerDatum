// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/grids/lava.lua:30-39 (mindam, maxdam, the burn)
//             t-engine4 game/modules/tome/data/general/grids/water.lua:104-115 (the bubble's charges)
//             t-engine4 game/engines/default/engine/resolvers.lua:85-92 (resolvers.calc.mbonus)
//             t-engine4 game/modules/tome/resolvers.lua:586-587 (mbonus_max_level)
//             t-engine4 game/engines/default/engine/Zone.lua:1031 (resolvers.current_level)
//             t-engine4 game/modules/tome/class/Game.lua:1608-1631 (#Source# and #Target#)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT STANDING ON A TILE DOES, AS NUMBERS AND SENTENCES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/terrain.ts` says WHICH tiles do something (`ON_STAND`). This file is
 * the half that needs a generator or a body: what a burning floor's
 * `mindam`/`maxdam` resolve to, whether a body spends an air bubble's charge,
 * and the lines upstream prints. The world holds the resolved values
 * (`World.burnRange`, `World.spendBubble`) and the scheduler fires them
 * (`onStandPass`); both call through here so the rule is written once.
 *
 * ═══ ONE RESOLUTION PER FLOOR, NOT PER ZONE, AND NOT PER TILE ═══
 * Upstream resolves `mindam` and `maxdam` when the grid entity is first
 * resolved (engine/Generator.lua:59-77), at `resolvers.current_level`, which
 * `newLevel` sets to `base_level + lev - 1` (engine/Zone.lua:1031). LAVA_FLOOR
 * has no `force_clone`, so the zone's one entity keeps the first floor's roll
 * for every floor after it. Here each floor is its own world and rolls at its
 * own level: the freeze is per floor. Two further differences, both narrower:
 * the sixteen `LAVA_FLOOR1..16` picture variants (data/general/grids/lava.lua:43)
 * are separate entities upstream and each would roll its own pair, and the
 * order `pairs` resolves `mindam` and `maxdam` in is a hash order. Here there
 * is one pair per code, `mindam` first.
 */

import { mbonus, range } from '../../shared/mapgen/lua.ts';
import { TileCode } from '../../shared/protocol.ts';
import { ON_STAND } from '../../shared/terrain.ts';
import type { Rng } from '../../shared/rng.ts';
import type { Breather, MBonus, OnStand } from '../../shared/terrain.ts';

/**
 * `resolvers.mbonus_max_level`, which ToME raises from the engine's 50
 * (engine/resolvers.lua:86) to 90 (tome/resolvers.lua:587).
 */
export const MBONUS_MAX_LEVEL = 90;

/**
 * `resolvers.current_level` before any level sets it (engine/resolvers.lua:85).
 * A world nobody gave a level to — every fixture, a town — resolves here.
 */
export const DEFAULT_TERRAIN_LEVEL = 1;

/** A burning grid's resolved `mindam` and `maxdam`. */
export type BurnRange = { readonly min: number; readonly max: number };

/** The burn arm of `OnStand`. */
export type Burn = Extract<OnStand, { readonly kind: 'burn' }>;

/** The bubble arm of `OnStand`. */
export type Bubble = Extract<OnStand, { readonly kind: 'bubble' }>;

/**
 * `resolvers.calc.mbonus(t)` (engine/resolvers.lua:90-92):
 *
 * ```lua
 * return rng.mbonus(t[1], resolvers.current_level, resolvers.mbonus_max_level) + (t[2] or 0)
 * ```
 */
export function resolveMbonus(rng: Rng, label: string, bonus: MBonus, level: number): number {
  const [max, add] = bonus;
  return mbonus(rng, label, max, level, MBONUS_MAX_LEVEL) + add;
}

/** The burn a code carries, or undefined for a code that burns nobody. */
export function burnOf(code: number): Burn | undefined {
  const stand = ON_STAND[code as TileCode];
  return stand?.kind === 'burn' ? stand : undefined;
}

/** The bubble a code carries, or undefined for a code that is not one. */
export function bubbleOf(code: number): Bubble | undefined {
  const stand = ON_STAND[code as TileCode];
  return stand?.kind === 'bubble' ? stand : undefined;
}

/**
 * LAVA'S `mindam = resolvers.mbonus(5, 15)` AND `maxdam = resolvers.mbonus(10, 30)`
 * (data/general/grids/lava.lua:30-31), resolved at `level`: `mindam`'s draws,
 * then `maxdam`'s, on the one stream.
 *
 * At level 1 the pair is about 15..20 and 30..40; at the ceiling it reaches
 * 20 and 40.
 */
export function resolveBurn(rng: Rng, burn: Burn, level: number): BurnRange {
  const min = resolveMbonus(rng, 'terrain.resolve.mindam', burn.mindam, level);
  const max = resolveMbonus(rng, 'terrain.resolve.maxdam', burn.maxdam, level);
  return { min, max };
}

/**
 * ONE BURN'S DAMAGE BEFORE RESISTS — `rng.range(self.mindam, self.maxdam)`
 * (data/general/grids/lava.lua:36). `range`'s rules: both ends inclusive, no
 * draw when they are equal, reversed bounds swapped.
 */
export function rollBurn(rng: Rng, burnRange: BurnRange): number {
  return range(rng, 'terrain.on_stand.burn', burnRange.min, burnRange.max);
}

/**
 * `nb_charges = resolvers.rngrange(4, 7)` (data/general/grids/water.lua:104),
 * rolled per grid because the bubble is `force_clone`.
 */
export function rollBubbleCharges(rng: Rng, bubble: Bubble): number {
  const [min, max] = bubble.charges;
  return range(rng, 'terrain.bubble.charges', min, max);
}

/**
 * DOES THIS BODY SPEND A CHARGE — data/general/grids/water.lua:107.
 *
 * ```lua
 * if ((who.can_breath.water and who.can_breath.water <= 0) or not who.can_breath.water)
 *    and not who:attr("no_breath") then
 * ```
 *
 * Lua's `0` is truthy, so a `can_breath.water` of 0 or less is "cannot", and
 * so is an absent one. Only a positive count keeps the charge. `no_breath`
 * keeps it too: a body that does not breathe takes nothing from a bubble.
 */
export function spendsBubble(body: Breather): boolean {
  if (body.noBreath === true) return false;
  const water = body.canBreath?.water;
  return water === undefined || water <= 0;
}

/**
 * THE GRID'S NAME, for `#Source#` — upstream's `name` field. Only the codes that
 * speak are here.
 */
const GRID_NAME: Readonly<Partial<Record<TileCode, string>>> = Object.freeze({
  // data/general/grids/lava.lua:27, `name = "lava floor"`.
  [TileCode.LAVA_FLOOR]: 'lava floor',
});

/**
 * WHO THE DAMAGE IS FROM, as a `DamageSource.id`. Not a body: `noteCasualty`
 * pays a kill to it and finds nobody to pay, which is the trap's and the
 * orphaned fire's case already.
 */
export function terrainSourceId(code: number): string {
  return code === TileCode.LAVA_FLOOR ? 'terrain:lava' : `terrain:${String(code)}`;
}

/**
 * `self:logCombat(who, "#Source# burns #Target#!")` (data/general/grids/lava.lua:38),
 * through `Game:logMessage` (tome/class/Game.lua:1608-1631): `#Source#` is the
 * grid's name capitalised, `#Target#` the victim's.
 *
 * In the trap-sentence shape (`trapSentence`'s `@Target@`), so the scheduler
 * hands it over the same way.
 */
export function burnMessage(code: number): string {
  const name = GRID_NAME[code as TileCode] ?? 'the ground';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} burns @Target@!`;
}

/**
 * `game.logSeen(who, "#AQUAMARINE#The air bubbles are depleted!")`
 * (data/general/grids/water.lua:110), with the colour dropped.
 */
export const BUBBLES_DEPLETED = 'The air bubbles are depleted!';
