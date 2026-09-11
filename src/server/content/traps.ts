// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/traps/elemental.lua:20-97
//              t-engine4 game/engines/default/engine/generator/trap/Random.lua:36-60
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE BOLT TRAPS — `TRAP_ELEMENTAL`, and the three of five we can say.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * newEntity{ define_as = "TRAP_ELEMENTAL",
 *   type = "elemental", id_by_type=true, unided_name = "trap",
 *   display = '^',
 *   pressure_trap = true,
 *   triggered = function(self, x, y, who)
 *     self:project({type="hit",x=x,y=y}, x, y, self.damtype, self.dam, ...)
 *     return true
 *   end,
 * }
 * ```
 *
 * `{type="hit"}` is a single tile: the bolt hits whoever stood on the plate and
 * nobody else. That is the whole effect, which is what makes this family the
 * right one to port first — it needs no new projection primitive, only the
 * damage pipeline that has existed since M2.
 *
 * ═══ THREE OF THE FIVE, AND THE OTHER TWO ARE REFUSED RATHER THAN FUDGED ═══
 * Upstream's bolt family is acid, fire, cold, lightning and poison. This game
 * has six damage types and neither ACID nor POISON is among them
 * (`shared/damagetype.ts`). Mapping them onto Physical would put two traps in
 * the game whose numbers were tuned for a resistance channel that does not
 * exist here, and whose names would promise an element the sheet cannot show.
 * They arrive when their damage type does, or not at all.
 *
 * The three that remain carry upstream's numbers unchanged, and the fire trap's
 * are deliberately the odd ones: 90/25 where the others are 70/15. Fire is the
 * one bolt upstream rates as hotter, and re-levelling it to match its siblings
 * would be the exact opposite of using the tuning.
 *
 * ═══ THE FIRE TRAP'S DAMAGE TYPE IS A NARROWING, AND IT IS STATED ═══
 * Upstream's is `DamageType.FIREBURN` — fire that also lays a burn over several
 * turns (`damage_types.lua`'s BURN family). Ours is plain `Fire`: the port has
 * a Fire type and a burning-ground system, but no damage type that applies a
 * damage-over-time status to an actor. The trap therefore does its number and
 * stops, which is strictly gentler than upstream and is the honest reading
 * rather than a guess at what the burn would have been worth.
 */

import { DamageType } from '../../shared/damagetype.ts';
import { clscale } from '../engine/traps.ts';
import type { TrapKit } from '../engine/traps.ts';
import type { Rng } from '../../shared/rng.ts';

/**
 * One authored trap, before its level is known.
 *
 * `rarity` and `levelRange` are upstream's own fields and they are carried for
 * the reason `MonsterTemplate` carries its band: the roster states what a thing
 * is worth, and the placer decides how many. Neither is read by this build's
 * placer yet — every bolt trap shares `rarity = 3` and a range that covers
 * every floor this game has — and they are written down because re-deriving
 * them from the Lua later is the expensive half.
 */
type TrapTemplate = {
  readonly kind: string;
  /**
   * Upstream's `name`. AUTHORED AND NOT ON THE WIRE: the Case Log prints
   * `message`, which already names the element in a sentence, and nothing in
   * this build renders a trap tooltip yet. It stays here because it is what
   * upstream calls the thing and re-deriving it later is the expensive half.
   */
  readonly name: string;
  /** Upstream's `message`, with `@target@` left in for the caller. */
  readonly message: string;
  readonly damageType: DamageType;
  /** `resolvers.clscale(base, baseLevel, spread, 0.75, 0)` for `dam`. */
  readonly damage: readonly [base: number, baseLevel: number, spread: number];
  readonly rarity: number;
  readonly levelRange: readonly [number, number];
};

/**
 * `detect_power = resolvers.clscale(6,10,4,0.5)` — identical on all three, and
 * note the MISSING fifth argument: the floor falls through to the base, so this
 * never drops below 6 however shallow the floor. The bolt traps' own damage
 * resolver passes an explicit `0` and therefore does drop. Two readings of
 * `t[5] or t[1]` in one file; see `clscale`.
 */
const DETECT = { base: 6, baseLevel: 10, spread: 4, power: 0.5 } as const;

/** `power` on every bolt trap's damage resolver. */
const DAMAGE_POWER = 0.75;

const TEMPLATES: readonly TrapTemplate[] = [
  {
    kind: 'trap_fire',
    name: 'fire trap',
    message: 'A bolt of fire blasts onto @target@!',
    damageType: DamageType.Fire,
    damage: [90, 30, 25],
    rarity: 3,
    levelRange: [1, 30],
  },
  {
    kind: 'trap_cold',
    name: 'ice trap',
    message: 'A bolt of ice blasts onto @target@!',
    damageType: DamageType.Cold,
    damage: [70, 30, 15],
    rarity: 3,
    levelRange: [1, 30],
  },
  {
    kind: 'trap_lightning',
    name: 'lightning trap',
    message: 'A bolt of lightning blasts onto @target@!',
    damageType: DamageType.Lightning,
    damage: [70, 30, 15],
    rarity: 3,
    levelRange: [1, 30],
  },
];

/** Every authored trap kind, for the tests that must cover all of them. */
export const TRAP_KINDS: readonly string[] = TEMPLATES.map((template) => template.kind);

/**
 * Roll one trap for a floor of this level.
 *
 * ═══ THE DRAWS ARE ORDERED AND THE ORDER IS LOAD-BEARING ═══
 * Pick, then damage, then detect — three labelled draws per trap, always all
 * three, in that order. `rng.ts`'s rule is that adding, removing or re-ranging
 * a draw shifts every later draw from that seed forever, so a future trap
 * family must be APPENDED to `TEMPLATES` rather than inserted, exactly as
 * `computeRarities` requires of the monster list.
 */
export function rollTrap(level: number, rng: Rng, label: string): TrapKit {
  const picked = TEMPLATES[rng.int(`${label}.kind`, 0, TEMPLATES.length - 1)];
  // TEMPLATES is a non-empty literal and the draw is bounded by its length, so
  // this cannot fire — `!` is banned and a silent undefined would be worse.
  if (picked === undefined) throw new Error('trap roster is empty');

  const [base, baseLevel, spread] = picked.damage;
  return {
    kind: picked.kind,
    message: picked.message,
    damageType: picked.damageType,
    // The explicit ZERO floor, which is truthy in Lua and is the reason a
    // level-1 fire trap does single digits rather than ninety.
    damage: clscale(base, baseLevel, spread, DAMAGE_POWER, 0, level, rng, `${label}.dam`),
    detectPower: clscale(
      DETECT.base,
      DETECT.baseLevel,
      DETECT.spread,
      DETECT.power,
      // NO FLOOR ARGUMENT, so it falls through to the base. Not a copy-paste
      // slip from the line above: upstream's two resolvers genuinely differ.
      undefined,
      level,
      rng,
      `${label}.detect`,
    ),
  };
}
