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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A TRAP DOES, AND IT IS NOT ALWAYS DAMAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `triggered` is a closure per trap entity, and across the nine
 * files in `data/general/traps/` it is far more often something OTHER than a
 * bolt: an alarm makes noise, a lethargy rune puts your talents on cooldown, a
 * teleport rune moves you. A port that modelled a trap as "damage on a tile"
 * would have ported the least interesting third of the system and closed the
 * door on the rest.
 *
 * A DISCRIMINATED UNION rather than an optional-damage field, so a trap that
 * does no damage is a different SHAPE and not a bolt with a zero in it — and so
 * `noteTrap`'s dispatch is exhaustive and the next family is a compile error
 * until it is handled.
 */
export type TrapEffect =
  /**
   * `TRAP_ELEMENTAL` — `self:project({type="hit",x=x,y=y}, ...)`, a single tile.
   * The bolt hits whoever stood on the plate and nobody else.
   */
  | { readonly kind: 'bolt'; readonly damage: number; readonly damageType: DamageType }
  /**
   * `TRAP_ALARM`'s intruder alarm — `traps/alarm.lua:38-52`. Every non-player
   * body in a box around the plate takes the victim as its target.
   */
  | { readonly kind: 'alarm'; readonly radius: number }
  /**
   * The lethargy rune — `traps/annoy.lua:29-47`. Takes `count` of the victim's
   * READY activated talents at random and puts each on cooldown.
   *
   * ```lua
   * for i = 1, 3 do
   *   local tid = rng.tableRemove(tids)
   *   if not tid then break end
   *   who.talents_cd[tid] = rng.range(4, 7)
   * end
   * ```
   *
   * `rng.tableRemove` REMOVES the element it returns, so the three are distinct
   * — the same talent cannot be picked twice — and `break` on an empty list is
   * why a body with one talent loses one rather than erroring.
   */
  /**
   * `TRAP_TELEPORT` — `traps/teleport.lua:26-46`. Throws the victim anywhere on
   * the floor, and stays armed to do it again.
   */
  | { readonly kind: 'teleport'; readonly range: number }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TRAP THAT PUTS A STATUS ON YOU — `who:setEffect(...)`, the commonest
   * `triggered` body upstream has.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * if who:canBe("stun") then
   *   who:setEffect(who.EFF_STUNNED, 4, {apply_power=self.disarm_power + 5})
   * else
   *   game.logSeen(who, "%s resists!", who.name:capitalize())
   * end
   * return true
   * ```
   *
   * `traps/natural_forest.lua:41-48`. GENERIC rather than one variant per
   * status, because that `setEffect` line is the whole body of most of the
   * `annoy`, `natural` and `water` families — a bespoke effect kind each would
   * be a dozen arms of one switch that all did the same thing.
   *
   * `effectId` IS A CONTENT STRING and stays one. The engine hands it to
   * `ctx.applyStatus` without knowing what it names, exactly as it does for a
   * monster's `onHit` rider, because `engine/` must not import `content/`.
   *
   * THE RESIST BRANCH NEEDS NO PORT HERE. Upstream's `canBe` check and the
   * `apply_power` save are two halves of one question, and our `setEffect`
   * already asks both — an immunity refuses outright and a save is rolled
   * against `applyPower`, with the Record line written either way. Upstream's
   * explicit else is its own way of saying what `setEffect` says for us.
   */
  | {
      readonly kind: 'status';
      readonly effectId: string;
      readonly turns: number;
      readonly applyPower: number;
    }
  | {
      readonly kind: 'lethargy';
      readonly count: number;
      readonly minTurns: number;
      readonly maxTurns: number;
    };

/** One trap, on one tile. `Map.TRAP` holds at most one entity per cell. */
export type Trap = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Which of the authored kinds this is. The client's key for what to draw. */
  readonly kind: string;
  /** Upstream's `message`, with `@target@` already substituted by the caller. */
  readonly message: string;
  /** What happens when somebody stands on it. */
  readonly effect: TrapEffect;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IS IT CONSUMED BY GOING OFF — upstream's `del`, and it is PER TRAP.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * if self.triggered then known, del = self:triggered(x, y, who) end
   * ...
   * if del then game.level.map:remove(x, y, Map.TRAP) end
   * ```
   *
   * `engine/Trap.lua:141-150`. The second return value of `triggered`, and the
   * families genuinely differ: an elemental bolt returns `true` alone, so `del`
   * is nil and the plate stays armed forever. An alarm returns `true, true` and
   * is gone the moment it has done its job — which is the only sensible reading
   * of a noise, and is also what stops one plate from summoning the room every
   * time somebody walks back over it.
   *
   * The first port of this file hardcoded "never removed", which was right about
   * the only family it had and would have been silently wrong about every family
   * after it.
   */
  readonly spent: boolean;
  /**
   * `detect_power` — the number a detector's `see_traps` is checked against.
   * Carried now and read by nothing, because it is AUTHORED data rather than a
   * code channel: the roster states each trap's difficulty whether or not this
   * build can ask the question yet, and dropping it would mean re-deriving
   * every number from the Lua when detection lands.
   */
  readonly detectPower: number;
  /**
   * `disarm_power` — what a disarm attempt is checked against, and what a
   * status trap applies its rider at.
   *
   * IT HAS A READER NOW, which `detectPower` still does not. The sliding rock's
   * `apply_power = self.disarm_power + 5` spends it as the save DC, so this is
   * authored data that reaches play through a door nobody expected — and it is
   * why both numbers are carried rather than only the one a future disarm verb
   * would want.
   */
  readonly disarmPower: number;
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SENTENCE, WITH THE VICTIM IN IT — `engine/Trap.lua:133-138`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local tname = who.name
 * local str = self.message
 * str = str:gsub("@target@", tname)
 * str = str:gsub("@Target@", tname:capitalize())
 * ```
 *
 * TWO PLACEHOLDERS, NOT ONE, and the second is the one that bites. The bolt
 * traps all write `@target@` mid-sentence ("A bolt of fire blasts onto
 * @target@!") and the alarm writes `@Target@` at the start of one ("@Target@
 * triggers an alarm!"), because that is where the name falls in each. A port
 * that substituted only the lowercase form would be correct on every trap it
 * had at the time and would print a literal `@Target@` at the player the day
 * the first sentence-initial message landed.
 *
 * IT DID. The intruder alarm shipped with exactly that, and it was found by
 * reading the NEXT trap's message rather than by anything failing — the
 * fixtures for the alarm had been written with the lowercase spelling, so the
 * one test that could have caught it was testing the test.
 */
export function trapSentence(message: string, victimName: string): string {
  const capitalised =
    victimName.length === 0 ? victimName : victimName[0]?.toUpperCase() + victimName.slice(1);
  return message.replaceAll('@target@', victimName).replaceAll('@Target@', capitalised);
}

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
