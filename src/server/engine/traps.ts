// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Trap.lua:117-155 (trigger, on_move)
//              t-engine4 game/modules/tome/class/Trap.lua:76-87 (added)
//              t-engine4 game/modules/tome/class/Trap.lua:246-280 (canTrigger)
//              t-engine4 game/modules/tome/resolvers.lua:662-667 (clscale)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              THE FIFTH MAP LAYER — the one this game did not have.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's map is five layers: TERRAIN, TRAP, OBJECT, ACTOR, PROJECTILE. This
 * port has had four of them since M4 — terrain, ground items, actors and orbs —
 * and the gap was not a missing feature so much as a missing ROW in the model.
 * That is why it is worth doing as a layer rather than as a monster that cannot
 * move: everything about a trap follows from being terrain-that-acts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS INVISIBLE, AND THAT IS THE PORT RATHER THAN AN OVERSIGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Actor:detectTrap` (tome/class/Actor.lua:1622-1642) opens with
 *
 * ```lua
 * power = power or self:attr("see_traps") or 0
 * if power <= 0 then return end
 * ```
 *
 * and `see_traps` is granted by NOTHING except two talents in
 * `data/talents/cunning/survival.lua`. There is no base value, no birth
 * descriptor and no item in the game that sets it otherwise. So a ToME
 * character without those talents — which is most of them — never sees a trap
 * at all. They find one by standing on it.
 *
 * ═══ WHICH IS WHY TRIGGERING TEACHES YOU, AND WHY THAT IS NOT OPTIONAL ═══
 * An elemental trap's `triggered` returns `true` and nothing else, so `known`
 * is true and `del` is nil (`engine/Trap.lua:139-148`): the trap is NOT removed. It
 * sits there and goes off again the next time somebody steps on it. The only
 * thing that changes is that the victim now KNOWS, and the knowledge is
 * per-actor (`known_by`, a table keyed by actor).
 *
 * So "you learn it by setting it off" is the entire counterplay for a character
 * with no detection, and a port that dropped the known-set would be a port of
 * invisible repeating damage with no way to avoid it. The knowledge is the
 * mechanic; the damage is just the teacher.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT PORTED HERE, AND IS NOT AN OVERSIGHT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   NO DETECTION. `see_traps` has no source in this game yet, so porting the
 *   attribute would be a channel with no writer — the shape `inert.mjs` exists
 *   to catch. It arrives with the talent that grants it.
 *
 *   NO DISARM. `Trap:canDisarm` (tome/class/Trap.lua:186-198) requires Device
 *   Mastery or a `can_disarm` attribute and neither exists here. Upstream's
 *   `trigger` tries to disarm FIRST for an actor that knows the trap, and
 *   normally fails and triggers anyway — so a build with no disarm source
 *   behaves identically without the branch.
 *
 *   NO `trap_avoidance` / `avoid_traps` / `levitation`. Three separate escapes
 *   in `canTrigger`, and nothing in this game grants any of them. Same argument.
 *
 *   NO BENEFICIAL TRAPS AND NO FACTION CHECK. `canTrigger`'s first line is
 *   `if self.faction and who:reactionToward(self) >= 0 then return
 *   self.beneficial_trap end`. Every trap ported here is hostile to everybody,
 *   which is what that line reduces to when no trap has a friendly faction.
 *
 * `trigger_fail` IS ported, because it is the one escape that applies to every
 * actor and every trap with no attribute behind it.
 */

import type { DamageType } from '../../shared/damagetype.ts';
import type { Rng } from '../../shared/rng.ts';

/**
 * `_M.trigger_fail = 5` — tome/class/Trap.lua:73.
 *
 * A flat percentage that every trap in the game simply fails to go off,
 * independent of who walked onto it. Upstream's comment calls it *"Percent
 * chance for the trap to automatically fail to trigger"*, and it is the reason
 * a player who steps on the same known trap twice does not always pay twice.
 */
export const TRIGGER_FAIL_PERCENT = 5;

/** One trap, on one tile. `Map.TRAP` holds at most one entity per cell. */
export type Trap = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Which of the authored kinds this is. The client's key for what to draw. */
  readonly kind: string;
  /** Upstream's `message`, with `@target@` already substituted by the caller. */
  readonly message: string;
  readonly damage: number;
  readonly damageType: DamageType;
  /**
   * `detect_power` — the number a detector's `see_traps` is checked against.
   * Carried now and read by nothing, because it is AUTHORED data rather than a
   * code channel: the roster states each trap's difficulty whether or not this
   * build can ask the question yet, and dropping it would mean re-deriving
   * every number from the Lua when detection lands.
   */
  readonly detectPower: number;
  /**
   * WHO HAS FOUND OUT — upstream's `known_by`, which is a table keyed by ACTOR
   * and not a single flag. Two players on one floor know different things about
   * the same tile, and that is the whole reason the wire frame is per-viewer.
   *
   * MUTABLE, and the only mutable field here: a trap's position and numbers are
   * fixed at generation, and what changes about it is who has met it.
   */
  readonly knownBy: Set<string>;
};

/** What the caller must supply to put one down. */
export type TrapSpec = Omit<Trap, 'id' | 'knownBy'>;

/**
 * A trap's PROPERTIES, before anybody has decided where it goes.
 *
 * Split from `TrapSpec` because the roster and the placer answer different
 * questions and neither can answer the other's: `rollTrap` knows what a fire
 * trap is worth on a floor of this level and has no opinion about tiles, while
 * the placer knows which tiles are legal and nothing about damage.
 */
export type TrapKit = Omit<TrapSpec, 'x' | 'y'>;

/**
 * CAN THIS TRAP GO OFF ON THIS BODY — `tome/class/Trap.lua:246-280`, reduced.
 *
 * ```lua
 * elseif not self.beneficial_trap and rng.percent(self.trigger_fail) then
 *   avoid = "somehow avoid"
 * ```
 *
 * Every other arm of upstream's `canTrigger` tests an attribute this game does
 * not grant — see the header. What remains is the flat 5%, which applies to
 * everybody.
 *
 * ONE DRAW, ALWAYS TAKEN when a body is standing on a trap, so the seeded
 * stream does not depend on anything about the victim. `rng.ts`'s rule is that
 * adding or removing a draw shifts every later draw from that seed forever, and
 * a draw that is sometimes skipped is the version of that rule that is hardest
 * to see.
 */
export function trapTakes(trap: Trap, rng: Rng, victimId: string): boolean {
  return rng.int(`trap.fire.${trap.id}.${victimId}`, 1, 100) > TRIGGER_FAIL_PERCENT;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `resolvers.clscale` — resolvers.lua:662-667, AND ITS LUA TRUTHINESS TRAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * function resolvers.calc.clscale(t, e)
 *   return math.max(math.ceil((t[1] + (t[3] and rng.range(-t[3],t[3]) or 0))*(resolvers.current_level/t[2])^t[4]), t[5] or t[1])
 * end
 * ```
 *
 * A base value quoted at a reference level, spread by a random range, scaled by
 * `(level / baseLevel) ^ power`, and floored.
 *
 * ═══ THE FLOOR IS `t[5] or t[1]`, AND `t[5] = 0` IS TRUTHY IN LUA ═══
 * Every elemental bolt trap passes `0` as the fifth argument. In Lua only `nil`
 * and `false` are falsy, so `0 or 90` is **0** — the floor is zero and the
 * scaling is allowed to take a level-1 fire trap down to single digits. Read
 * with JavaScript reflexes it is `90`, which would put a 90-damage trap on the
 * first floor of the game against a character with 48 hit points.
 *
 * The detect/disarm resolvers pass NOTHING as the fifth argument, so there the
 * `or` really does fall through to the base. Both readings are live in the same
 * file, which is exactly why this is a function with a comment rather than four
 * numbers inlined at the call sites.
 *
 * DRAWS ONCE, LABELLED, and only when `spread` is non-zero — mirroring
 * `t[3] and ... or 0`, which takes no draw at all when the spread is absent.
 */
export function clscale(
  base: number,
  baseLevel: number,
  spread: number,
  power: number,
  min: number | undefined,
  level: number,
  rng: Rng,
  label: string,
): number {
  const jitter = spread === 0 ? 0 : rng.int(label, -spread, spread);
  const scaled = Math.ceil((base + jitter) * Math.pow(level / baseLevel, power));
  // `t[5] or t[1]`: absent falls through to the base, and ZERO DOES NOT.
  return Math.max(scaled, min ?? base);
}
