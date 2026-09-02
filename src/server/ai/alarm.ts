// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/NPC.lua:342-367 (onTakeHit — "Share reaction with allies")
//                                                      :372-391 (die — "Call for help if we become hostile")
//              t-engine4 game/modules/tome/class/interface/ActorAI.lua:130-135 (target_last_seen)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *            HURTING ONE OF THEM TELLS THE ONES THAT CAN SEE IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream, a wounded NPC does two things beyond bleeding. It takes the
 * attacker as its target even if it cannot see them, and it tells every friend
 * who can see IT:
 *
 * ```lua
 * -- NPC.lua:342-367, onTakeHit
 * if src.targetable and not self.ai_target.actor then self:setTarget(src) end
 * ...
 * -- Share reaction with allies
 * for i = 1, #self.fov.actors_dist do
 *   local act = self.fov.actors_dist[i]
 *   if act and act ~= self and not act.dead and act.checkAngered
 *      and self:reactionToward(act) > 0 then
 *     act:checkAngered(src, false, -50)
 *   end
 * end
 * ```
 *
 * Note whose field of view is walked: `self.fov` — the VICTIM's. The friends
 * who react are the ones who can see the body that got hit, NOT the ones who
 * can see the attacker. That is the whole mechanic, and it is why it changes
 * anything: a monster round a corner with no line to the shooter is exactly the
 * monster that stands there today.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT `checkAngered` MEANS HERE, WHERE EVERYTHING IS ALREADY HOSTILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `checkAngered(src, false, -50)` moves a FACTION REACTION — it is
 * how a neutral townsfolk becomes hostile when you shoot their neighbour. Our
 * monsters are already hostile to every player; there is no reaction to move.
 * Ported literally, this file would be a no-op with a citation on it, which is
 * the `egos.ts` failure — *"a name that changes no number a player can see"*.
 *
 * So what ports is the CONSEQUENCE upstream's reaction change produces: the
 * ally starts hunting the attacker. It is handed the attacker as its target and
 * the attacker's tile as `lastSeen`, which is the same pair a sighting stamps
 * (`ai/npc.ts`, `ActorAI.lua:130-135`).
 *
 * ═══ AND THAT IS WHY THIS COULD NOT HAVE BEEN BUILT BEFORE PURSUIT MEMORY ═══
 * A target handed to a monster that cannot remember it is worth almost nothing:
 * the ally would look for the attacker once, fail to see them, and forget.
 * `lastSeen` plus `PURSUIT_TURNS` is what turns "it is angry" into "it walks
 * over here", and the same bounded counter is what stops this being unbounded —
 * `scheduler.ts` documents an idle fixed point, and a monster that never gives
 * up means `pump` never returns idle.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT DRAWS NOTHING FROM THE RNG, AND THAT IS LOAD-BEARING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/damage.ts` states the rule at the one place it matters: *"renaming a
 * label never alters a replay, ADDING OR REMOVING A DRAW ALWAYS DOES"*, and it
 * fires on a moment — a blow landing — that happens a variable number of times
 * per turn. A single `rng.percent()` in here would make every later number in
 * the session depend on how many monsters happened to be watching. Every
 * decision below is a deterministic function of positions and state.
 *
 * Upstream's own version is draw-free for the same structural reason: it walks
 * `fov.actors_dist` and calls a setter.
 */

import { PURSUIT_TURNS } from './npc.ts';
import { chebyshev } from '../../shared/coords.ts';
import { isHostile, isMonster } from '../engine/actor.ts';
import { hasLineOfSight } from '../../shared/sight.ts';
import type { EngineActor, MonsterActor } from '../engine/actor.ts';
import type { World } from '../world/world.ts';

/**
 * Hand one body a target it did not have, and the tile to walk to.
 *
 * ONLY WHEN IT HAS NONE. Upstream guards the victim's own acquisition with
 * `not self.ai_target.actor` and this keeps that for every body it touches: a
 * monster already fighting somebody does not drop them because a friend got
 * shot across the room. Without the guard, one player hitting a pack would peel
 * the whole pack off whoever they were already engaged with — which is the
 * opposite of the pressure this is meant to add.
 */
function pointAt(watcher: MonsterActor, attacker: EngineActor): boolean {
  if (watcher.ai.targetId !== null) return false;
  watcher.ai.targetId = attacker.id;
  watcher.ai.lastSeen = { x: attacker.x, y: attacker.y };
  watcher.ai.unseenTurns = 0;
  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOMETHING HURT `victim`. TELL IT, AND TELL WHOEVER SAW IT HAPPEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @returns the ids that took up the hunt because of this, for the caller's log
 *   and for the tests. Empty is the common case and is not a failure.
 *
 * SAFE TO CALL ON ANYTHING. A player victim, a corpse, a monster hurt by a
 * bleed with no living source — all answer with an empty list rather than a
 * branch at every call site.
 *
 * THE VICTIM IS TOLD EVEN WITHOUT LINE OF SIGHT, which is upstream verbatim
 * (`setTarget(src)` has no visibility test on it) and is the half that answers
 * damage from somewhere a body cannot see: a shot from beyond its `aggroRange`,
 * or a bleed ticking after the shooter has gone.
 */
export function raiseAlarm(
  world: World,
  victim: EngineActor,
  attacker: EngineActor | undefined,
): readonly string[] {
  if (attacker === undefined || !attacker.alive) return [];
  // A BODY CANNOT CALL FOR HELP AGAINST ITSELF. Upstream's `src ~= self` —
  // reflected damage and a self-inflicted blast both reach here.
  if (attacker.id === victim.id) return [];
  if (!victim.alive) return [];

  const roused: string[] = [];

  if (isMonster(victim) && isHostile(victim, attacker) && pointAt(victim, attacker)) {
    roused.push(victim.id);
  }

  for (const other of world.allActors()) {
    if (!other.alive || other.id === victim.id || other.id === attacker.id) continue;
    if (!isMonster(other)) continue;
    // A friend of the victim and an enemy of whoever did it. Both halves are
    // upstream's — `self:reactionToward(act) > 0` and, in `die`,
    // `act:reactionToward(rsrc) >= 0`.
    if (isHostile(other, victim) || !isHostile(other, attacker)) continue;
    /**
     * CAN IT SEE THE VICTIM — not the attacker. `self.fov.actors_dist` is the
     * victim's own field of view, so the question is who watched it happen.
     * Bounded by the WATCHER's `aggroRange`, because that is this game's answer
     * to "how far does this creature notice things" and a second radius would be
     * a second answer to it.
     */
    if (chebyshev(other, victim) > other.ai.aggroRange) continue;
    if (!hasLineOfSight(world.level, other, victim)) continue;
    if (pointAt(other, attacker)) roused.push(other.id);
  }

  return roused;
}

/**
 * The bound this file leans on, re-exported so a reader of `raiseAlarm` does not
 * have to go and find out whether the hunt it starts ever ends. It does, after
 * `PURSUIT_TURNS` turns without a sighting — `ai/npc.ts#pursueLastSeen`.
 */
export { PURSUIT_TURNS };
