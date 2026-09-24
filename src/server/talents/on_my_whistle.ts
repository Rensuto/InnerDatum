// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/warcries.lua
//          -- the warcry tree's shouts. Upstream's buff the shouter (Battle
//          Shout, warcries.lua:92); ours is heard by a friend.
// NUMBERS: Blinding Speed's, whole -- techniques/combat-techniques.lua:148-170:
//          EFF_SPEED at combatTalentScale(t, 0.14, 0.45, 0.75) for 5 turns,
//          cooldown 55, no_energy. Ours lands it on a FRIEND; the range and the
//          Resolve are authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ON MY WHISTLE -- AUTHORITY.
 *
 * "You are not tired. Go."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONE TALENT IN THIS GAME THAT GIVES A FRIEND MORE TURNS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is the strongest co-op verb a turn-based game has: the Watchman's best
 * move can be the Inspector's shot, and deciding that is a more interesting
 * decision than any amount of damage on his own bar.
 *
 * IT HANDED OUT ACTION POINTS, and a point is only worth something inside the
 * decision it is spent in — every action ends the turn (2026-09-23) — so the
 * whistle bought a friend nothing. ToME gives a body more turns with a faster
 * clock (`global_speed_add`), and EFF_SPEED is its generic haste
 * (physical.lua:603-619; HASTE and QUICKNESS add the same attribute). Nothing
 * in it hands another body energy directly — every energy grant under
 * data/talents targets its caster — but EFF_SPEED IS landed on others
 * (Temporal Vigour on its hounds, chronomancy/temporal-hounds.lua:340). So this
 * is EFF_SPEED, landed on the friend.
 *
 * ═══ THE NUMBERS ARE BLINDING SPEED'S, WHOLE ═══
 * The one technique that grants EFF_SPEED (combat-techniques.lua:148-170):
 * 14% at rank 1 and 45% at rank 5, for five turns, on a 55-turn cooldown, and
 * FREE — `no_energy`, so the whistle is a word and not a turn. Taking one of
 * those numbers and authoring the rest is how a tuned pipeline stops being
 * ToME's, so they come together. The duration and cooldown go through
 * `tomeCooldownToTurns` like every other port's.
 *
 * ═══ AND WHY IT CANNOT TARGET THE CASTER ═══
 * `Affinity.Ally` includes yourself in this engine's targeting, so the refusal
 * is explicit below. Blinding Speed is the self-cast; this is the one you give
 * away, and a Watchman who could keep it would never give it.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentKind,
  TalentRefusal,
  TargetShape,
  isFriend,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * `ap: 0`, THE CONVENTION EVERY `no_energy` TALENT CARRIES (healing_infusion.ts
 * says so). It mattered while a free action shared its decision's AP budget:
 * three points here would have taken the Watchman's Lockdown off him for the
 * turn he whistled in. That budget is retired, so the figure is a price nothing
 * spends. Blinding Speed costs stamina and nothing else of the turn; the
 * Resolve is that price.
 */
const AP_COST = 0;
const RESOLVE_COST = 2;

/** combat-techniques.lua:153 — Blinding Speed's `cooldown = 55`. */
const TOME_COOLDOWN = 55;
/** combat-techniques.lua:165 — `setEffect(self.EFF_SPEED, 5, ...)`. */
const TOME_DURATION = 5;
const DURATION_TURNS = tomeCooldownToTurns(TOME_DURATION);

/** combat-techniques.lua:163 — `combatTalentScale(t, 0.14, 0.45, 0.75)`. */
const SPEED_LOW = 0.14;
const SPEED_HIGH = 0.45;
const SPEED_CURVE = 0.75;
/** A formatting factor for the tooltip's truncated percent, not a tunable. */
const PER_CENT = 100;

/** EFF_SPEED's `power` — the friend's `global_speed_add` — at a rank. */
export function speedGivenAt(level: number): number {
  return combatTalentScale(level, SPEED_LOW, SPEED_HIGH, SPEED_CURVE);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR A WHISTLE CARRIES, AND ITS RANK MOVES THIS AS WELL AS THE SPEED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ours, not Blinding Speed's, which is a self-cast and has no range. A shout
 * that carries further is what "authority" means, and it is worth something
 * specific: a Watchman holding a doorway and an Inspector shooting from the
 * back of the room are eight tiles apart, and at rank 1 he cannot reach her.
 * Buying the rank is buying the party's shape.
 *
 * ═══ THE PRECEDENT call_shadows.ts CITES ═══
 * The range was given to the rank as a SECOND thing to move when the old
 * action-point band rounded ranks 3 and 4 to one figure, so a point spent
 * there bought nothing a player could see (talent-scaling.test.ts caught it).
 * The answer was not to widen the band until it differed — it was to give the
 * rank something else to move that means what the talent means. The speed
 * differs at every rank now; the range stays for the reason above.
 */
const RANGE_LOW = 3;
const RANGE_HIGH = 8;
const RANGE_CURVE = 0.75;

/** How far the whistle carries, at a rank. */
export function rangeAt(level: number): number {
  return Math.max(
    RANGE_LOW,
    Math.round(combatTalentScale(level, RANGE_LOW, RANGE_HIGH, RANGE_CURVE)),
  );
}

export const onMyWhistle: Talent = {
  id: talentId('on_my_whistle'),
  name: 'On My Whistle',
  classId: ClassId.Watchman,
  tree: 'watch/authority',
  /** Tier 2 of its tree. See `src/shared/tiers.ts`. */
  tier: 2,
  /** authority is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_on_my_whistle',
  cost: { ap: AP_COST, resource: RESOLVE_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  // combat-techniques.lua:155 — Blinding Speed is `no_energy = true`. So no
  // `speed` either: upstream never charges one (tome/class/Actor.lua:5862).
  noEnergy: true,
  targeting: {
    shape: TargetShape.Single,
    // The level-1 range is a FLOOR, not the answer: `rangeAt` is what
    // `canUseTalent` and the projector actually resolve. Fog Step's own note
    // makes the same point about the same pair of fields.
    range: RANGE_LOW,
    rangeAt,
    minRange: 0,
    radius: 0,
    // A SHOUT NEEDS TO BE HEARD, so line of sight is required where Field
    // Dressing's touch is not. Shouting through a wall at somebody you cannot
    // see is the kind of thing that reads as a bug even when it is intended.
    requiresLos: true,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const friend = targetActor(ctx.world, target);
    if (friend === undefined) return talentRefused(TalentRefusal.NoTarget);
    // SEE THE HEADER. `Affinity.Ally` includes the caster.
    if (friend.id === self.id) return talentRefused(TalentRefusal.Self);
    /**
     * AND A TOWNSFOLK IS NOBODY'S FRIEND. The targeting gate asks only "not an
     * enemy", and a shopkeeper is neither side (`isFriend`); the old action-
     * point grant was kept off her by her having no sheet, and a status needs
     * none. A Bound companion is on the caster's side and still hears it.
     */
    if (!isFriend(self, friend)) return talentRefused(TalentRefusal.NotAlly);

    /**
     * THROUGH THE STATUS DOOR, like every effect a talent lands. A runtime
     * with no status table is a fixture, never anything a player can produce,
     * and "the whistle did nothing and cost the Resolve" is refused rather than
     * reported as a success.
     */
    const power = speedGivenAt(ctx.talentLevel);
    const landed = ctx.status?.(friend, EffectId.Speed, DURATION_TURNS, {
      power,
      srcId: self.id,
    });
    if (landed === undefined) return talentRefused(TalentRefusal.NoTarget);

    // TRUNCATED, as the tooltip and the Speed badge both are (`%d`).
    return talentDone(
      [],
      [`${friend.name} picks up the pace: ${String(Math.floor(power * PER_CENT))}% faster.`],
    );
  },

  // Blinding Speed's info — "increasing your speed by %d%% for 5 turns" — for a
  // friend, and `%d` truncates.
  describe: (_self, level) =>
    `A friend within ${String(rangeAt(level))} tiles acts ` +
    `${String(Math.floor(speedGivenAt(level) * PER_CENT))}% faster for ` +
    `${String(DURATION_TURNS)} turns. Whistling takes no time.`,
};
