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
} from '../engine/talents.ts';
import type { Talent, TalentActor, TalentHit, TalentWorld } from '../engine/talents.ts';

const AP_COST = 5;
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
/** `damage_multiplier: 1.4` — the Watchman's heaviest single blow. */
const DAMAGE_MULT = 1.4;
/** Shield Wall, weaponshield.lua:192 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;
/** ToME Taunt's radius at talent level 1 (summon-utility.lua:28, scale 4 -> 8). */
const TAUNT_RADIUS = 4;
/**
 * How long the curtain stands, in GAME TURNS.
 *
 * `buff_defense_self` is authored at `duration: 1` — one real-time SECOND,
 * which R2 makes one turn, and a one-turn guard expires before the monster
 * sweep it was raised against. Three turns is scheduler.ts's
 * `ENGAGEMENT_TURNS`: exactly as long as "we are still in this fight" lasts.
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

    ctx.engine.addEffect(self.id, {
      kind: TalentEffect.Guarding,
      otherId: ally.id,
      turns: GUARD_TURNS,
      power: 0,
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
    if (threat !== undefined) hits.push(talentAttack(ctx, self, threat, { mult: DAMAGE_MULT }));

    const covered = ally.id === self.id ? 'himself' : ally.name;
    return talentDone(hits, [
      `${self.name} raises the curtain over ${covered} for ${GUARD_TURNS} turns.`,
      pulled > 0 ? `${pulled} turn on ${self.name}.` : `Nothing was hunting ${covered}.`,
    ]);
  },

  describe: () =>
    `Guard the adjacent ally in the worst shape for ${GUARD_TURNS} turns — their hunters ` +
    `turn on you, and anything that strikes them anyway takes a free counter — and hit ` +
    `whatever is between you for ${percent(DAMAGE_MULT)} weapon damage. ` +
    `${AP_COST} AP, ${RESOLVE_COST} Resolve.`,
};
