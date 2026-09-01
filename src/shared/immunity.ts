// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:6951-6978 (canBe)
//              game/modules/tome/data/general/objects/ (the `*_immune` wielder rolls)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      THE STATUS SUBTYPES A PLAYER IS ALLOWED TO BUILD A DEFENCE AGAINST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream spells each of these as its own wielder field — `stun_immune`,
 * `cut_immune`, `poison_immune` — and a ring carrying one is the standard answer
 * to a monster carrying the matching rider. Half of ToME's gearing problem is
 * "what is about to disable me, and what do I put on to stop it".
 *
 * ═══ THE ENGINE WAS FINISHED AND NOTHING COULD REACH IT ═══
 * `canBe` (effects.ts) has the blanket check, the multiplicative subtype
 * product and the no-draw short-circuit, all ported and all tested. Its only
 * source of numbers was `grantImmunity`, and the ONLY callers of that outside
 * the engine were four lines in `test/server/effects.test.ts`. So the immunity
 * system worked perfectly and no item, ego, class or talent in the game could
 * put a single point into it — while `content/effects.ts` describes Stunned's
 * three-talent lockout as *"the entire reason Stun is the most feared status in
 * ToME"* and offered no way to answer it.
 *
 * ═══ WHY A FIXED LIST AND NOT "ANY STRING" ═══
 * `DAMAGE_TYPES` plays this exact role for the resist fold. A free-form key in
 * an ego would validate, fold, display on the character sheet, and resist
 * nothing whatever — the failure this project keeps finding, a number that
 * exists everywhere except where it is read. Every key here is a subtype some
 * authored DETRIMENTAL effect actually carries, and `immunity.test.ts` fails if
 * one of them stops matching anything.
 *
 * ═══ WHY THE FOUR BLANKET KEYS ARE NOT IN IT ═══
 * `ImmunityKey.AllNegative` and its three per-channel siblings are tested for
 * TRUTH, not for a percentage — Actor.lua:6956-6960 is `if self:attr(...)`, and
 * `canBe` mirrors it with `> 0`. A 5% roll on one of those would therefore be
 * total immunity to every detrimental effect in the game. They stay reachable
 * only from `grantImmunity`, which is to say from an effect that owns its own
 * lifetime, and never from a slot somebody can wear.
 *
 * In `shared/` rather than beside `ImmunityKey` in `engine/effects.ts` for a
 * mechanical reason: `effects.ts` imports `equipment.ts` for `composeSheet`, and
 * `equipment.ts` is where the fold lives, so a value import the other way is a
 * runtime cycle. `DAMAGE_TYPES` sits here for the same class of reason.
 */
export const IMMUNITY_KEYS = Object.freeze([
  'stun',
  'wound',
  'cut',
  'bleed',
  'slow',
  'acid',
  'temporal',
] as const);

/** One of the seven. `Wielder.immunities` is keyed by this. */
export type ImmunitySubtype = (typeof IMMUNITY_KEYS)[number];

/**
 * The most one item may grant against one subtype, as a percentage.
 *
 * `canBe` composes subtypes MULTIPLICATIVELY, so a rider carrying three of them
 * meets `(1 - p)³` — three slots at this cap already refuse a Bleed outright
 * more often than not. Upstream's ordinary gear rolls partial immunities in
 * this range and reserves the 100% ones for artifacts, which this game does not
 * have yet. The `resists` cap's reasoning applies unchanged: the grade doubles
 * an authored floor, so this is half of what a Bespoke roll can reach.
 */
export const MAX_ITEM_IMMUNITY = 25;
