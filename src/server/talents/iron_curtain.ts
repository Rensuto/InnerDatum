// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/iron_curtain.json
//          (ap_cost 5, range 1, damage_multiplier 1.4,
//           effects: [{ type: "buff_defense_self", duration: 1, value: 6 }])
//          Outer Index content/abilities/ward.json — "Protective sigil",
//          `cooldown_sec: 7.0`, the donor for the protection half
// SHAPE:   t-engine4 game/modules/tome/data/talents/gifts/summon-utility.lua:21-40
//          (Taunt: `cooldown = 5`, `a:setTarget(self)` — forces foes onto you)
//          t-engine4 .../techniques/weaponshield.lua:186-210 (Shield Wall, cooldown 10)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * IRON CURTAIN — the guard. THE talent that makes this co-op rather than three
 * solo games (game-design.md § 2's ally-utility slot).
 *
 * "A powerful defensive strike that hits hard and leaves you braced behind your
 * guard."
 *
 * One click does three things, and they are the three halves of what an anchor
 * is:
 *
 *   STRIKE  — the authored 1.4x blow, landed on whatever is adjacent to BOTH
 *             you and the person you are covering. That is the thing you are
 *             stepping in front of; no second targeting step is needed to
 *             identify it.
 *   PROTECT — every hostile currently hunting the guarded ally is pulled onto
 *             the Watchman, right now. ToME's `Taunt` verbatim
 *             (summon-utility.lua:29-38, `a:setTarget(self)`), and it works
 *             with no new hook anywhere because src/server/ai/npc.ts already
 *             reads `ai.targetId` and already keeps it across turns (ToME's 90%
 *             hysteresis, ai/simple.lua:253). That hysteresis is what makes a
 *             taunt STICK instead of being re-decided on the next tick.
 *   PUNISH  — while the curtain stands, anything that hits the guarded ally
 *             anyway eats a free counter-swing. That is `resolveGuardCounter`
 *             in engine/talents.ts; this file only installs the `Guarding`
 *             duration it reads.
 *
 * Together: "protects an ally" and "punishes an enemy for ignoring you", with
 * no good answer to either.
 *
 * ═══ TARGETING YOURSELF IS LEGAL, AND IS THE "BRACED" READING ═══
 * game-design.md § 2's table lists this as *"AP 5, self"* while the authored
 * skill is `range: 1, target_shape: single`. Both are true: the effect lands on
 * an ALLY WITHIN 1, and you are an ally within 1 of yourself. Guarding yourself
 * is a riposte stance; guarding the Inspector is the whole class fantasy.
 *
 * ═══ IT COSTS RESOLVE, AND THAT IS THE WHOLE RESOURCE ═══
 * game-design.md § 2: Resolve *"builds when struck and when adjacent to an
 * ally; spent on guard and taunt talents."* Crude Blow and Ward Rush cost none;
 * the two talents that hold the line cost all of it. The Watchman therefore
 * cannot guard from across the room — Resolve accrues from standing next to
 * people, which is the position the guard needs him in anyway.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentEffect,
  TargetShape,
  isEnemy,
  isFriend,
  pullAggro,
  talentAttack,
  talentId,
  percent,
  talentDone,
  tomeCooldownToTurns,
  withinTiles,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent, TalentActor, TalentHit, TalentWorld } from '../engine/talents.ts';

/** FROZEN. 5 of 6 AP: raising the curtain is the round, not part of one. */
const AP_COST = 5;
/**
 * FROZEN. Resolve accrues at 6 per blow taken and 3 per adjacent ally per turn,
 * so 25 is roughly three turns of doing the job. A cost that fell with rank
 * would let a trained Watchman re-raise the curtain before the last one lapsed,
 * and `GUARD_TURNS` (3) is deliberately shorter than that. A point buys a
 * harder counter, never a cheaper one.
 */
const RESOLVE_COST = 25;
/**
 * MELEE REACH — 1.5, NOT 1, AND THE ARITHMETIC IS THE WHOLE JUSTIFICATION.
 *
 * `checkTargeting` (engine/talents.ts) and `submitTalent` (turn-engine.ts) both
 * measure with `combatDistance`, which is EUCLIDEAN — `core.fov.distance`. The
 * four diagonal neighbours sit at √2 = 1.4142…, so a range of exactly 1 refuses
 * every one of them: a Watchman standing corner-to-corner with a husk is told
 * OutOfRange on a talent whose whole point is that he is standing on it. 1.5 is
 * the only round number between √2 and the nearest non-neighbour at 2.0, so a
 * circle of that radius holds exactly the eight tiles around you.
 *
 * Imported rather than written as 1.5, because a second literal somewhere else
 * is a second definition of what melee means (engine/combat.ts `MELEE_REACH`).
 *
 * ═══ IT IS ALSO THE ADJACENCY BOUND BELOW, AND THAT IS UNCHANGED ═══
 * `wardFor` and `threatBetween` pass this to `withinTiles`, which is CHEBYSHEV
 * (engine/talents.ts). Chebyshev distance over a tile grid is an INTEGER, so
 * `<= 1.5` admits exactly the same eight neighbours `<= 1` did — the two metrics
 * agree here by arithmetic rather than by luck, and nobody's ward moved.
 */
const RANGE = MELEE_REACH;
/**
 * `damage_multiplier: 1.4` — the Watchman's heaviest single blow, and still
 * exactly 1.4 at talent level 1.
 *
 * ═══ THE CONTRADICTION AT :98-99, RESOLVED OUT LOUD ═══
 * This file cites THREE upstream talents and none of them is the source of this
 * number. Taunt (summon-utility.lua:21-40) deals no damage at all; Shield Wall
 * (weaponshield.lua:186-210) is a sustain that deals none either. Both are cited
 * for SHAPE — the retarget and the cooldown — and the header's own line about
 * "Taunt's radius scale 4 -> 8" is about `TAUNT_RADIUS` below, not about this.
 *
 *   SHAPE  — ported (summon-utility.lua, weaponshield.lua). Cited above.
 *   LOW    — AUTHORED, `content/skills/iron_curtain.json`. It wins at rank 1.
 *   HIGH   — TUNED, not ported. There is no upstream curve for a talent that
 *            does not exist upstream.
 *
 * 2.4 is tuned against Crude Blow's trained 1.8: the heavy stays a third above
 * the at-will swing at every rank, which is the ratio it shipped with (1.4 vs
 * 1.0). It is deliberately NOT stretched further — this blow is a rider on a
 * talent whose real content is the guard, and a Watchman who levels Iron
 * Curtain for the damage has been sold the wrong button.
 */
const DAMAGE_MULT_LOW = 1.4;
const DAMAGE_MULT_HIGH = 2.4;

/**
 * The PUNISH's multiplier, snapshot onto the `Guarding` effect at cast time and
 * read back by `resolveGuardCounter` (engine/talents.ts) when something strikes
 * the ally anyway.
 *
 * It used to be `GUARD_COUNTER_MULT = 0.7`, a constant in engine/talents.ts. It
 * moved here because the counter is Iron Curtain's number, not the engine's,
 * and because a counter that ignored the talent's rank would have been the one
 * part of this talent a point did nothing to — while being the part the header
 * calls "no good answer to either".
 *
 * TUNED HIGH, not ported: ToME has no guard-counter talent to copy. 0.7 -> 1.2
 * is tuned to stay below the Watchman's own at-will swing at every rank (1.0 ->
 * 1.8), because the counter is FREE — it costs no AP, no turn and no resource,
 * and it can fire once per incoming blow. A free swing that outdamages a paid
 * one turns the guard into the highest-DPS button in the game and deletes the
 * reason to ever press Crude Blow.
 *
 * SNAPSHOT, not live: the effect instance carries the number, so a curtain
 * already standing counters at the rank it was raised at. Same rule as the
 * Inspector's mark, same field, same reason.
 */
const GUARD_COUNTER_MULT_LOW = 0.7;
const GUARD_COUNTER_MULT_HIGH = 1.2;

/** The one place this talent's two curves are written. */
function damageMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, DAMAGE_MULT_LOW, DAMAGE_MULT_HIGH);
}
/**
 * EXPORTED so test/server/talent-scaling.test.ts can pin the LOW END against the
 * shipped curve rather than restating the band. A test that rewrites the
 * arithmetic is a second copy of it, and this codebase has already shipped a
 * room that killed players because a test modelled armour its own way (M-007).
 */
export function counterMult(talentLevel: number): number {
  return combatTalentScale(talentLevel, GUARD_COUNTER_MULT_LOW, GUARD_COUNTER_MULT_HIGH);
}

/** Shield Wall, weaponshield.lua:192 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;
/**
 * ToME Taunt's radius at talent level 1 (summon-utility.lua:28, scale 4 -> 8).
 *
 * FROZEN AT 4 even though upstream scales it, and the deviation is deliberate.
 * `pullAggro` here is already NARROWED to hostiles hunting the guarded ally
 * (see `onUse`) rather than the whole room, which is what makes a taunt on this
 * cooldown survivable; widening the ring on top of that narrowing pulls
 * everything that was ever pointed at the Inspector, from eight tiles, and
 * deletes positioning outright. The radius is the safety rail on the narrowing,
 * not a payoff. `MELEE_REACH` bounds the STRIKE half regardless.
 */
const TAUNT_RADIUS = 4;
/**
 * How long the curtain stands, in GAME TURNS.
 *
 * `buff_defense_self` is authored at `duration: 1` — one real-time SECOND,
 * which R2 makes one turn, and a one-turn guard expires before the monster
 * sweep it was raised against. Three turns is scheduler.ts's
 * `ENGAGEMENT_TURNS`: exactly as long as "we are still in this fight" lasts.
 *
 * FROZEN, and that pin to `ENGAGEMENT_TURNS` is exactly why. A duration that
 * grew with rank would drift off the constant it is pinned to, silently, and
 * the comment above would become the third false one in this codebase. If the
 * guard should last longer, `ENGAGEMENT_TURNS` is the number that moves.
 */
const GUARD_TURNS = 3;

/**
 * Who the curtain falls over: the adjacent ally in the worst shape, or the
 * Watchman himself if he is standing alone.
 *
 * ═══ CHOSEN FOR THE PLAYER, ON PURPOSE ═══
 * This is a `self` shape (protocol.ts's `TalentShape.Self`: *"the client must
 * not enter targeting mode"*), which means one keypress with no aiming step.
 * Under a Bell countdown, with three other people talking, the guard button is
 * the last one that should require a click on the right body — and "whoever
 * next to me is worst off" is the answer a player would have picked anyway.
 *
 * DETERMINISTIC: lowest HP FRACTION (not absolute HP — a 60 HP Alchemist at 30
 * is in more trouble than a 72 HP Watchman at 35), ties broken by id, iterated
 * over the world's insertion-ordered actor list. Two allies on equal fractions
 * must not resolve differently on two machines.
 */
function wardFor(world: TalentWorld, self: TalentActor): TalentActor {
  let best: TalentActor = self;
  let bestFraction = self.maxHp > 0 ? self.hp / self.maxHp : 1;
  for (const other of world.allActors()) {
    if (!other.alive || other.id === self.id || !isFriend(self, other)) continue;
    if (!withinTiles(self, other, RANGE)) continue;
    const fraction = other.maxHp > 0 ? other.hp / other.maxHp : 1;
    if (fraction < bestFraction || (fraction === bestFraction && other.id < best.id)) {
      best = other;
      bestFraction = fraction;
    }
  }
  return best;
}

/** Whatever is adjacent to both the Watchman and the person he is covering. */
function threatBetween(
  world: TalentWorld,
  self: TalentActor,
  ally: TalentActor,
): TalentActor | undefined {
  let best: TalentActor | undefined;
  for (const other of world.allActors()) {
    if (!other.alive || !isEnemy(self, other)) continue;
    if (!withinTiles(self, other, RANGE)) continue;
    // Prefer the one already hunting the ally; fall back to anything in reach.
    if (other.ai?.targetId === ally.id) return other;
    best ??= other;
  }
  return best;
}

export const ironCurtain: Talent = {
  id: talentId('iron_curtain'),
  name: 'Iron Curtain',
  classId: ClassId.Watchman,
  tree: 'watch/the-line',
  /** Tier 4 of its tree. See `src/shared/tiers.ts`. */
  tier: 4,
  /** the-line is about CON. See `Talent.statGate`. */
  statGate: 'con',
  kind: TalentKind.Active,
  iconId: 'icon_active_iron_curtain',
  cost: { ap: AP_COST, resource: RESOLVE_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    // SELF — no targeting mode, no aiming step. game-design.md § 2's table
    // lists this talent as "AP 5, self" and protocol.ts's `TalentShape.Self`
    // names it as the example. `wardFor` picks the ally; see its note.
    shape: TargetShape.Self,
    range: RANGE,
    minRange: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    const ally = wardFor(ctx.world, self);

    // `power` IS THE COUNTER-SWING'S MULTIPLIER, snapshot here at cast time.
    // engine/talents.ts's `resolveGuardCounter` reads it back and has no other
    // way to learn it — that module must never import a talent file or learn
    // the string `talent:iron_curtain` (the registry-cycle rule).
    ctx.engine.addEffect(self.id, {
      kind: TalentEffect.Guarding,
      otherId: ally.id,
      turns: GUARD_TURNS,
      power: counterMult(ctx.talentLevel),
    });

    // ToME's Taunt, NARROWED to what is already hunting this ally rather than
    // the whole room. A room-wide taunt on this cooldown would delete
    // positioning; pulling exactly the things that threaten the person you are
    // standing over is the same fantasy and leaves the rest of the fight alone.
    const pulled = pullAggro(
      ctx.world,
      self,
      (hostile) => hostile.ai?.targetId === ally.id && withinTiles(self, hostile, TAUNT_RADIUS),
    );

    const threat = threatBetween(ctx.world, self, ally);
    const hits: TalentHit[] = [];
    if (threat !== undefined) {
      hits.push(talentAttack(ctx, self, threat, { mult: damageMult(ctx.talentLevel) }));
    }

    const covered = ally.id === self.id ? 'himself' : ally.name;
    return talentDone(hits, [
      `${self.name} raises the curtain over ${covered} for ${GUARD_TURNS} turns.`,
      pulled > 0 ? `${pulled} turn on ${self.name}.` : `Nothing was hunting ${covered}.`,
    ]);
  },

  describe: (_self, level) =>
    `Guard the adjacent ally in the worst shape for ${GUARD_TURNS} turns — their hunters ` +
    `turn on you, and anything that strikes them anyway takes a free counter at ` +
    `${percent(counterMult(level))} weapon damage — and hit whatever is between you for ` +
    `${percent(damageMult(level))} weapon damage. ${AP_COST} AP, ${RESOLVE_COST} Resolve.`,
};
