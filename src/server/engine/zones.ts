// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Map.lua:1089-1116 (addEffect)
//              t-engine4 game/engines/default/engine/Map.lua:1231-1254 (processEffects)
//              t-engine4 game/modules/tome/class/Game.lua:1737 (the once-per-game-turn cadence)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        FIRE THAT STAYS ON THE FLOOR. `map:addEffect`, and its tick.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sixty-seven talents upstream call `game.level.map:addEffect`, which makes it
 * the most-used primitive in ToME after the projector itself — and this game had
 * none of it. Every AoE here resolved instantaneously against whoever happened
 * to be standing there at the moment it landed, so an area attack was a bigger
 * single hit and never a piece of terrain. Area denial, retreat cost, the reason
 * to not walk back through a doorway: all of it lives here.
 *
 * It is also what `on_die` is waiting on. The commonest shape of an upstream
 * death trigger is a cloud — `vermin.lua:82`'s worm mass *"exudes a corrupted
 * gas as it dies"* — and there was nowhere to put one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE RULE, WHICH IS SMALLER THAN THE FEATURE SOUNDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Map.lua:1233-1254
 * for i, e in ipairs(self.effects) do
 *   if not update_shape_only and e.duration > 0 then
 *     for lx, ys in pairs(e.grids) do for ly, _ in pairs(ys) do
 *       local act = game.level.map(lx, ly, engine.Map.ACTOR)
 *       if act and act == e.src and not e.selffire then
 *       elseif act and e.src and e.src.reactionToward and (e.src:reactionToward(act) >= 0) and not e.friendlyfire then
 *       else DamageType:get(e.damtype).projector(e.src, lx, ly, e.damtype, e.dam) end
 *     end end
 *     e.duration = e.duration - 1
 *   end
 *   if e.duration <= 0 then table.insert(todel, i) end
 * end
 * ```
 *
 * Three things in that are worth saying out loud, because each is a decision
 * that could plausibly have gone the other way:
 *
 *   THE TILES ARE FROZEN AT CREATION. `grids` is computed once by
 *   `addEffect` (Map.lua:1093-1108) and the tick walks it. A zone does not
 *   re-derive its shape against terrain every turn, so a wall that opens later
 *   does not let the fire through — and, more to the point, the set is stable,
 *   which is what makes the damage order stable and the replay reproducible.
 *
 *   IT DAMAGES A TILE, NOT A LIST OF VICTIMS. The tick asks each tile who is
 *   standing on it NOW. Walking into a fire hurts; standing in one hurts every
 *   turn; walking out stops it. Nothing is remembered about who was caught.
 *
 *   THE SOURCE IS ASKED TWICE AND DIFFERENTLY. `selffire` is about the caster
 *   alone; `friendlyfire` is about anyone the caster is not hostile to. Fire
 *   Storm (`spells/fire-alchemy.lua:117-155`) passes 0 for both and its own
 *   description says why — *"You closely control the firestorm, preventing it
 *   from harming your party members"* — which is the same sentence
 *   game-design.md § 10 writes as *"player AoE does not damage allies. Ever."*
 *
 * ═══ ONCE PER GAME TURN, AND THE UNITS ARE THE USUAL TRAP ═══
 * `Game.lua:1737` is `self.level.map:processEffects(self.turn % 10 ~= 0)` —
 * the argument is `update_shape_only`, so the DAMAGE-AND-DECREMENT pass runs on
 * one tick in ten and the other nine only move particles. ToME's `game.turn`
 * counts ticks; ours counts game turns already, so this hangs off `onGameTurn`
 * (shared/energy.ts:704) and a duration is a count of GAME TURNS. A version
 * that ticked per pump would burn ten times as fast and read as durations not
 * working.
 *
 * ═══ THE PROJECTOR, SO NO ARMOUR ═══
 * `DamageType:get(...).projector` is the same door the brand and the spikes go
 * through, and `combat_armor` is not in it — it lives in `attackTargetWith`
 * alone (Combat.lua:439/506/540). That was the finding of `091e70f` and it
 * applies here unchanged: a zone that a breastplate shrugged off would be a
 * zone nobody in armour needs to walk around.
 *
 * PURE OVER ITS ARGUMENTS. This module holds no state; the world owns the
 * table and this decides what one turn does to it.
 */

import { DAMAGE_TYPES } from '../../shared/damagetype.ts';
import type { DamageType } from '../../shared/damagetype.ts';
import { applyDamage } from './damage.ts';
import { areEnemies } from './actor.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { DamageOutcome } from './damage.ts';
import type { EngineActor } from './actor.ts';

/**
 * One patch of ground doing something to whoever stands on it.
 *
 * ═══ `srcId` AND NOT THE BODY ═══
 * Upstream holds `e.src`, a live reference, and its zone keeps burning after
 * the caster dies — `processEffects` never checks. An id says the same thing
 * without pinning a corpse in memory, and the lookup is what the tick already
 * has to do to answer "is this actor an ally of the source".
 *
 * A SOURCE THAT HAS LEFT THE WORLD IS NOT AN ERROR. The fire outlives the
 * alchemist, which is upstream's behaviour and the right one: a thrown vial is
 * not undone by the thrower being killed. `friendlyFire` cannot be evaluated
 * without the source, so with the source gone the zone burns EVERYONE — see
 * `tickZones`.
 */
export type GroundZone = {
  /** Unique within this world, monotonic, never reused. */
  readonly id: string;
  /** Who put it there. May no longer be in the world. */
  readonly srcId: string;
  /**
   * THE TILES, FIXED AT CREATION — upstream's `grids`.
   *
   * In the order the creator listed them, because the tick applies damage in
   * this order and every application can take RNG draws. Two replays of one
   * seed must burn the same tiles in the same sequence, which a `Set` of
   * coordinates could not promise.
   */
  readonly tiles: readonly TileXY[];
  readonly type: DamageType;
  /** Per tile, per turn. Flat: a zone does not roll a band and cannot crit. */
  readonly damage: number;
  /** GAME turns. Decremented once per `tickZones`, which is once per game turn. */
  turnsLeft: number;
  /** Does it burn the body that made it? Upstream's `selffire`. */
  readonly selfFire: boolean;
  /** Does it burn that body's friends? Upstream's `friendlyfire`. */
  readonly friendlyFire: boolean;
};

/** Everything but the id and the countdown — what a caller has to decide. */
export type ZoneSpec = Omit<GroundZone, 'id' | 'turnsLeft'> & { readonly turns: number };

/** One body, burnt once, by one zone. The caller narrates and buries. */
export type ZoneHit = {
  readonly zoneId: string;
  readonly srcId: string;
  readonly victimId: string;
  readonly outcome: DamageOutcome;
};

/** What one game turn did. `expired` is enrolment, exactly like `reaped`. */
export type ZoneTick = {
  readonly hits: readonly ZoneHit[];
  readonly expired: readonly string[];
};

/** The slice of the world `tickZones` needs, and nothing else. */
export type ZoneWorld = {
  zones(): readonly GroundZone[];
  actorAt(x: number, y: number): EngineActor | undefined;
  getActor(id: string): EngineActor | undefined;
};

/**
 * ONE GAME TURN OF EVERY ZONE ON THE MAP. Map.lua:1231-1254.
 *
 * ═══ IT MUTATES `turnsLeft` AND NOTHING ELSE ═══
 * The expired ids are RETURNED rather than removed, which is `PumpResult.reaped`'s
 * rule and it is here for the same reason: the caller still has to narrate what
 * happened on a tile before the tile stops having anything on it, and a table
 * that deleted its own rows mid-walk is the classic way to skip one.
 *
 * ═══ A DEAD BODY IS SKIPPED BY `applyDamage`, NOT BY A GUARD HERE ═══
 * `applyDamage` refuses a target that is not `alive` and returns an empty
 * outcome (damage.ts). Writing the check here as well would be a second answer
 * to "can this be hurt", and the one place that question is answered is the one
 * that also knows about shields, hooks and the death event.
 *
 * ═══ THE ORDER IS ZONE, THEN TILE, BOTH AS AUTHORED ═══
 * Every draw `applyDamage` takes is a draw in the world stream, so both loops
 * walk arrays rather than sets. `shared/rng.ts`'s rule is the whole reason: a
 * different order is a different replay.
 */
export function tickZones(world: ZoneWorld, rng: Parameters<typeof applyDamage>[4]): ZoneTick {
  const hits: ZoneHit[] = [];
  const expired: string[] = [];

  for (const zone of world.zones()) {
    // `if not update_shape_only and e.duration > 0`. A zone at zero does
    // nothing on the turn it is collected, which is upstream's shape and is why
    // the expiry check below is a separate `if` rather than an `else`.
    if (zone.turnsLeft > 0) {
      const source = world.getActor(zone.srcId);
      for (const tile of zone.tiles) {
        const victim = world.actorAt(tile.x, tile.y);
        if (victim === undefined) continue;

        /**
         * THE TWO SPARING RULES, IN UPSTREAM'S ORDER AND WITH ITS ASYMMETRY.
         *
         * The first arm is identity: `act == e.src`. The second is a REACTION —
         * `e.src:reactionToward(act) >= 0`, i.e. anyone the source is not
         * hostile to, which includes the source itself. So a zone with
         * `selfFire: false` and `friendlyFire: true` still spares its caster,
         * and the first arm is what makes that true rather than an accident.
         *
         * ═══ NO SOURCE MEANS NO MERCY, AND THAT IS NOT A SHORTCUT ═══
         * `friendlyFire` is a question about a relationship, and with the
         * source gone from the world there is nobody to have one with. Upstream
         * holds a live reference so the question is always answerable; we hold
         * an id, so this is the one place the two genuinely differ. Sparing
         * everybody would be worse — the fire would go out in all but name the
         * moment its caster fell, which is exactly when a zone matters most.
         */
        if (victim.id === zone.srcId && !zone.selfFire) continue;
        if (!zone.friendlyFire && source !== undefined && !areEnemies(source, victim)) continue;

        /**
         * FLAT, THROUGH THE PROJECTOR. No damage band, no crit, no armour — see
         * this file's header. `increase` and `penetration` ARE the source's and
         * they do apply, because `setDefaultProjector` reads both off whoever is
         * projecting (damage_types.lua:48); with the source gone they are simply
         * absent, like every other property of a body that is not there.
         */
        const outcome = applyDamage(
          victim,
          zone.damage,
          zone.type,
          source ?? { id: zone.srcId },
          rng,
          {
            ...(source?.combat?.increase === undefined ? {} : { increase: source.combat.increase }),
            ...(source?.combat?.penetration === undefined
              ? {}
              : { penetration: source.combat.penetration }),
          },
        );
        if (outcome.dealt > 0 || outcome.killed) {
          hits.push({ zoneId: zone.id, srcId: zone.srcId, victimId: victim.id, outcome });
        }
      }

      zone.turnsLeft -= 1;
    }

    if (zone.turnsLeft <= 0) expired.push(zone.id);
  }

  return { hits, expired };
}

/**
 * Refuse a zone nothing could read, at the moment it is authored.
 *
 * The same argument `validateItems` makes about a misspelled damage type: a
 * zone with a type outside `DAMAGE_TYPES` is a patch of ground that resists
 * nothing and reports nothing, and it looks exactly like one that works.
 * Non-positive damage or duration is a zone that is invisible in play, which is
 * a content mistake rather than a feature — upstream's own guard is the
 * `duration > 0` on the tick.
 */
export function assertZoneSpec(spec: ZoneSpec): ZoneSpec {
  if (!DAMAGE_TYPES.includes(spec.type)) {
    throw new Error(`zones: '${spec.type}' is not one of the ${String(DAMAGE_TYPES.length)} types`);
  }
  if (!Number.isFinite(spec.damage) || spec.damage <= 0) {
    throw new Error(
      `zones: damage ${String(spec.damage)} would be a patch of ground doing nothing`,
    );
  }
  if (!Number.isInteger(spec.turns) || spec.turns <= 0) {
    throw new Error(`zones: turns ${String(spec.turns)} must be a whole number of game turns`);
  }
  if (spec.tiles.length === 0) {
    throw new Error('zones: a zone with no tiles is a zone nobody can stand in');
  }
  return spec;
}
