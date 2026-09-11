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
import { computeRarities, pickEntity } from './rarity.ts';
import { resolveMBonus } from './resolvers.ts';
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
   * Upstream's second `triggered` return — see `Trap.spent`. An elemental bolt
   * returns `true` alone and stays armed; an alarm returns `true, true`.
   */
  readonly spent: boolean;
  /**
   * Upstream's `name`. AUTHORED AND NOT ON THE WIRE: the Case Log prints
   * `message`, which already names the element in a sentence, and nothing in
   * this build renders a trap tooltip yet. It stays here because it is what
   * upstream calls the thing and re-deriving it later is the expensive half.
   */
  readonly name: string;
  /** Upstream's `message`, with `@target@` left in for the caller. */
  readonly message: string;
  /**
   * What it does, and how to roll it. `bolt` carries its `clscale` arguments
   * because the number depends on the floor; `alarm` carries a fixed radius
   * because a noise does not get louder with depth.
   */
  readonly effect:
    | {
        readonly kind: 'bolt';
        readonly damageType: DamageType;
        /** `resolvers.clscale(base, baseLevel, spread, 0.75, 0)` for `dam`. */
        readonly damage: readonly [base: number, baseLevel: number, spread: number];
      }
    | { readonly kind: 'alarm'; readonly radius: number }
    | { readonly kind: 'lethargy' }
    | { readonly kind: 'teleport' };
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

/**
 * `who:teleportRandom(x, y, 100)` — teleport.lua:39.
 *
 * A hundred tiles from a 34x30 floor is "anywhere walkable", which is the
 * point: upstream does not aim this, it removes you. Carried across as the
 * number rather than as something unbounded because `teleportRandom` walks a
 * box of this size, and an unbounded one would walk the world.
 */
const TELEPORT_RANGE = 100;

/** `resolvers.mbonus(5, 40)` — teleport.lua:31. See `resolveMBonus`. */
const TELEPORT_DETECT_MAX = 5;
const TELEPORT_DETECT_ADD = 40;

/**
 * `for i = x - 20, x + 20 do for j = y - 20, y + 20` — alarm.lua:39.
 *
 * A Chebyshev radius, carried across unchanged. On a 34x30 delve that is the
 * whole floor, which is what "alerting others" is supposed to mean: the room
 * comes for you, not the corner of it you happened to be standing in.
 */
const ALARM_RADIUS = 20;

const TEMPLATES: readonly TrapTemplate[] = [
  {
    kind: 'trap_fire',
    spent: false,
    name: 'fire trap',
    message: 'A bolt of fire blasts onto @target@!',
    effect: { kind: 'bolt', damageType: DamageType.Fire, damage: [90, 30, 25] },
    rarity: 3,
    levelRange: [1, 30],
  },
  {
    kind: 'trap_cold',
    spent: false,
    name: 'ice trap',
    message: 'A bolt of ice blasts onto @target@!',
    effect: { kind: 'bolt', damageType: DamageType.Cold, damage: [70, 30, 15] },
    rarity: 3,
    levelRange: [1, 30],
  },
  {
    kind: 'trap_lightning',
    spent: false,
    name: 'lightning trap',
    message: 'A bolt of lightning blasts onto @target@!',
    effect: { kind: 'bolt', damageType: DamageType.Lightning, damage: [70, 30, 15] },
    rarity: 3,
    levelRange: [1, 30],
  },
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE INTRUDER ALARM — `traps/alarm.lua:28-53`. No damage at all.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * name = "intruder alarm", rarity = 3, level_range = {1, 50},
   * unided_name = "pressure plate", message = "@Target@ triggers an alarm!",
   * desc = function(self) return ("Makes noise, alerting others.") end,
   * pressure_trap = true,
   * ```
   *
   * The most interesting trap in the shallow game and the one that makes the
   * layer worth having: it does nothing to you and changes everything about the
   * room. Every hostile body on the floor takes you as its target at once, with
   * no line of sight and no notice radius — see `soundAlarm`.
   *
   * `level_range = {1, 50}` upstream, and the 50 is a cap for a game with fifty
   * floors. Ours has fifteen, so the range is written as the floors that exist:
   * it is available everywhere, which is upstream's answer too.
   *
   * SPENT WHEN IT FIRES (`return true, true`), unlike every bolt above it. A
   * noise happens once; a plate that re-summoned the room every time somebody
   * walked back across it would be a tile nobody could ever cross twice.
   */
  {
    kind: 'trap_alarm',
    spent: true,
    name: 'intruder alarm',
    message: '@Target@ triggers an alarm!',
    effect: { kind: 'alarm', radius: ALARM_RADIUS },
    rarity: 3,
    levelRange: [1, 15],
  },
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LETHARGY RUNE — `traps/annoy.lua:29-47`. It takes your kit, not your hp.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * name = "lethargy trap", rarity = 3, level_range = {5, nil},
   * color=colors.BLUE, message = "@Target@ seems less active.",
   * unided_name = "pattern of glyphs",
   * desc = function(self) return "Disrupts activated talents." end,
   * ```
   *
   * The third shape a trap can take and the one that is hardest to see coming:
   * no damage, no noise, and three of your four buttons go grey for the length
   * of a fight. On a class whose whole answer to a room is one talent, that is a
   * bigger number than any bolt on this list.
   *
   * ═══ `{5, nil}` — NO UPPER BOUND, WHICH IS NOT THE SAME AS `{5, 30}` ═══
   * Upstream's nil max means "every floor from five down", and it is written
   * here as the deepest floor this game has rather than as a number copied off
   * a game with fifty. The FLOOR of five is the part that is tuning: it is the
   * one trap in this roster that is deliberately absent from the shallow game,
   * because a level-3 character has fewer talents and losing three of them is
   * most of what they can do.
   *
   * SPENT WHEN IT FIRES (`return true, true`), like the alarm and unlike a bolt.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TELEPORT TRAP — `traps/teleport.lua:26-46`. It moves YOU.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * name = "teleport trap", rarity = 5, level_range = {5, nil},
   * detect_power = resolvers.mbonus(5, 40), disarm_power = resolvers.mbonus(10, 50),
   * message = "@Target@ shimmers briefly.", unided_name = "shimmering floor switch",
   * triggered = function(self, x, y, who) ... who:teleportRandom(x, y, 100) ... return true end
   * ```
   *
   * THE ONLY TRAP HERE THAT IS RARER THAN THE REST — `rarity = 5` against
   * everything else's 3 — and the entry that makes the rarity field do anything
   * at all. In a party game it is the worst thing on this list: it does no
   * damage and separates one detective from the other three, which is the
   * situation most of this game's tuning exists to avoid.
   *
   * ═══ AND IT STAYS ARMED ═══
   * `return true` with no second value, so `del` is nil — a bolt's behaviour and
   * not the alarm's. You are thrown across the floor and the switch is still
   * there when you walk back to it.
   *
   * ═══ A DIFFERENT RESOLVER, AND IT IS NOT A TYPO ═══
   * `resolvers.mbonus(5, 40)` where every other trap uses `clscale`. At our tier
   * `resolveMBonus` is the flat `add` term, so detect power is 40 against the
   * bolts' 6 — this is the one nobody spots. Upstream's own description says so
   * out loud: *"How does anyone get close enough to disarm this trap...?"*
   *
   * ═══ NOT PORTED: THE RESIST BRANCH ═══
   * Upstream gates the whole thing on `who:canBe("teleport")` and, when that
   * fails, logs *"%s resists being teleported!"* and returns NOTHING — so the
   * trap teaches nobody and is not spent. Our `canBe` is about status effects
   * and this game has no `teleport_immune` attribute for anything to grant, so
   * the branch would be unreachable and its `known = false` case with it. It
   * arrives with the first thing that can resist a teleport.
   */
  {
    kind: 'trap_teleport',
    spent: false,
    name: 'teleport trap',
    message: '@Target@ shimmers briefly.',
    effect: { kind: 'teleport' },
    rarity: 5,
    levelRange: [5, 15],
  },
  {
    kind: 'trap_lethargy',
    spent: true,
    name: 'lethargy trap',
    message: '@Target@ seems less active.',
    effect: { kind: 'lethargy' },
    rarity: 3,
    levelRange: [5, 15],
  },
];

/**
 * `for i = 1, 3` and `rng.range(4, 7)` — annoy.lua:41-45.
 *
 * THREE, AND FOUR TO SEVEN TURNS. Authored here rather than on the effect,
 * because they are the same on the one rune that has them and a second rune
 * that wanted different numbers would be a second entry in this file.
 */
const LETHARGY_TALENTS = 3;
const LETHARGY_MIN_TURNS = 4;
const LETHARGY_MAX_TURNS = 7;

/** Every authored trap kind, for the tests that must cover all of them. */
export const TRAP_KINDS: readonly string[] = TEMPLATES.map((template) => template.kind);

/**
 * Every authored message, for the one test that must see the REAL strings.
 *
 * A fixture that paraphrases the content it stands for can only test itself:
 * the alarm's `@Target@` bug survived because the test scene had been written
 * with `@target@`, which is a message this game never sends.
 */
export const TRAP_MESSAGES: readonly string[] = TEMPLATES.map((template) => template.message);

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
export function rollTrap(level: number, rng: Rng, label: string): TrapKit | undefined {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SAME WEIGHTING EVERY OTHER ROSTER IN THIS GAME USES — `content/rarity.ts`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `generator/trap/Random.lua:44` calls `self.zone:makeEntity(self.level,
   * "trap", ...)`, which is the SAME entity picker the actor and object
   * generators use — so a trap's `rarity` and `level_range` mean exactly what a
   * monster's do, and `computeRarities` already ports both
   * (`engine/Zone.lua:218-245`).
   *
   * ═══ THE FIRST VERSION OF THIS FUNCTION REIMPLEMENTED HALF OF IT, WORSE ═══
   * It hand-filtered `levelRange` to a hard include/exclude. Upstream does not
   * exclude: it DIVIDES the weight by the distance out of depth — three times
   * harder below the band than above it — so a slightly-too-deep trap gets
   * rarer rather than vanishing, and only drops out when `floor(max / rarity)`
   * reaches zero. Two answers to one question, and the reimplementation was the
   * wrong one.
   *
   * It also ignored `rarity` entirely, which was invisible while every template
   * was a 3 and became wrong the moment the teleport trap arrived at 5.
   *
   * ═══ ONE DRAW, AND `undefined` IS A REAL ANSWER ═══
   * `pickEntity` takes exactly one labelled draw. It answers `undefined` when
   * nothing is eligible at this depth, which the caller must treat as "no trap
   * here" rather than as a failure — `generateOne` upstream does the same, and
   * it is why this returns an optional rather than throwing.
   */
  const eligible = computeRarities(TEMPLATES, level);
  const picked = pickEntity(rng, `${label}.kind`, eligible);
  if (picked === undefined) return undefined;

  return {
    kind: picked.kind,
    spent: picked.spent,
    message: picked.message,
    effect: rollEffect(picked, level, rng, label),
    /**
     * THE TELEPORT TRAP USES A DIFFERENT RESOLVER, and it is not a typo in the
     * Lua: `resolvers.mbonus(5, 40)` where every other trap is `clscale`. At our
     * tier `resolveMBonus` is the flat `add`, so 40 — against the bolts' 6.
     */
    detectPower:
      picked.effect.kind === 'teleport'
        ? resolveMBonus(TELEPORT_DETECT_MAX, TELEPORT_DETECT_ADD)
        : clscale(
            DETECT.base,
            DETECT.baseLevel,
            DETECT.spread,
            DETECT.power,
            // NO FLOOR ARGUMENT, so it falls through to the base. Not a
            // copy-paste slip: upstream's two resolvers genuinely differ.
            undefined,
            level,
            rng,
            `${label}.detect`,
          ),
  };
}

/** One template's effect, with whatever its shape needs rolled for this floor. */
function rollEffect(
  picked: TrapTemplate,
  level: number,
  rng: Rng,
  label: string,
): TrapKit['effect'] {
  switch (picked.effect.kind) {
    case 'lethargy':
      return {
        kind: 'lethargy',
        count: LETHARGY_TALENTS,
        minTurns: LETHARGY_MIN_TURNS,
        maxTurns: LETHARGY_MAX_TURNS,
      };
    case 'teleport':
      return { kind: 'teleport', range: TELEPORT_RANGE };
    case 'alarm':
      return { kind: 'alarm', radius: picked.effect.radius };
    case 'bolt':
      return {
        kind: 'bolt',
        damageType: picked.effect.damageType,
        // The explicit ZERO floor, which is truthy in Lua and is the reason a
        // level-1 fire trap does single digits rather than ninety.
        damage: clscale(
          picked.effect.damage[0],
          picked.effect.damage[1],
          picked.effect.damage[2],
          DAMAGE_POWER,
          0,
          level,
          rng,
          `${label}.dam`,
        ),
      };
  }
}
