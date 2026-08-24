// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/damage_types.lua
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIX MVP DAMAGE TYPES — IN `shared/` BECAUSE THE LOG SAYS THEM OUT LOUD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `as const` object plus a derived union, NOT an `enum`: `erasableSyntaxOnly` is
 * on because Node type-strips these files and runs them directly, so an enum
 * would not survive to runtime.
 *
 * ToME ships 161 types across 4,076 lines. The overwhelming majority are a
 * single talent's bespoke side effect wearing a damage type's clothes
 * (`DamageType.BLIGHT_DISEASE`, `DamageType.ITEM_ANTIMAGIC_MANABURN`), which is
 * a talent, not a type. These six are the ones with a real identity: a resist
 * column, a colour in the log, and — from M4 — a status they tend to apply.
 *
 * Values are lowercase strings rather than ToME's SCREAMING_CASE because they
 * cross the wire into `content/` JSON and the client's log renderer, where they
 * are matched against authored `*_resistance_pct` keys.
 *
 * ═══ IT LIVED IN `server/engine/damage.ts` AND THE LAST CLAUSE WAS NOT TRUE ═══
 * "The client's log renderer" was the stated reason for the lowercase values,
 * and the type never reached the client at all: `combat.ts` computed it, `Blow`
 * dropped it, and `DamageEvent` had no field for it. Every blow in the game
 * narrated as a bare number.
 *
 * `src/shared/` is the only module a zod schema, a server engine and a browser
 * renderer may all import, which is what this being on the wire requires. The
 * damage MATHS stays in `server/engine/damage.ts`, which re-exports this so its
 * hundred call sites keep one import path — one definition, not two.
 */
export const DamageType = {
  /** damage_types.lua:703-720. The default for any attack that names none. */
  Physical: 'physical',
  /** damage_types.lua:727-754. The Alchemist's whole kit. */
  Fire: 'fire',
  /** damage_types.lua:755-773. */
  Cold: 'cold',
  /** damage_types.lua:774-792. */
  Lightning: 'lightning',
  /** damage_types.lua:856-875. The Redacted's signature. */
  Darkness: 'darkness',
  /** damage_types.lua:876-904. Resisted by the MENTAL save, not the physical. */
  Mind: 'mind',
} as const;
export type DamageType = (typeof DamageType)[keyof typeof DamageType];

/** Every type, in a fixed order — for iteration that must be reproducible. */
export const DAMAGE_TYPES: readonly DamageType[] = [
  DamageType.Physical,
  DamageType.Fire,
  DamageType.Cold,
  DamageType.Lightning,
  DamageType.Darkness,
  DamageType.Mind,
] as const;
