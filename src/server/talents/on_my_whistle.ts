// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/warcries.lua
//          -- Battle Shout / Second Wind, the warcry tree's give-a-resource-back
//          shouts. Upstream's restore stamina and life to the SHOUTER.
// NUMBERS: authored. Ours gives action points to somebody ELSE, which is the
//          whole reason it exists -- see the header.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ON MY WHISTLE -- AUTHORITY.
 *
 * "You are not tired. Go."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FIRST TALENT IN THIS GAME THAT GIVES A FRIEND A TURN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three classes, forty-eight talents, and every single one of them acted on the
 * caster, on an enemy, or on an ally's HEALTH. Nothing could hand somebody else
 * the thing this game is actually made of, which is action points.
 *
 * That is the strongest co-op verb a turn-based game has. It is what turns four
 * people taking turns into a party: the Watchman's best move can be the
 * Inspector's shot, and deciding that is a more interesting decision than any
 * amount of damage on his own bar.
 *
 * ═══ WHY IT IS CAPPED AT THE ALLY'S OWN MAXIMUM ═══
 * `Math.min(maxAp, ...)` rather than an uncapped grant, and the reason is not
 * tidiness. AP above maximum would be bankable: a party could stack whistles
 * before a door and open it with one character taking four turns in a row,
 * which is not a combo, it is the end of the turn system. Topping somebody UP
 * is a support talent; letting them exceed their own ceiling is a different
 * game.
 *
 * ═══ AND WHY IT CANNOT TARGET THE CASTER ═══
 * `Affinity.Ally` includes yourself in this engine's targeting, so the refusal
 * is explicit below. A Watchman who could whistle himself would spend 2 AP to
 * gain 3 and never stop, and the loop would be the only thing anybody played.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * FROZEN, AND IT COSTS MORE THAN IT GIVES AT RANK 1.
 *
 * 3 AP for 1 is a bad trade and it is meant to be: the talent is not an AP pump,
 * it is a way to move a turn to where it is worth more. It only becomes an
 * outright gain at the ranks a player has paid several points for, and even
 * then the Resolve keeps it occasional.
 */
const AP_COST = 3;
const RESOLVE_COST = 2;
const COOLDOWN_TURNS = 4;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR A WHISTLE CARRIES, AND ITS RANK MOVES THIS AS WELL AS THE POINTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO NUMBERS BECAUSE ONE WAS NOT ENOUGH TO BE HONEST. The action points are a
 * small integer band, and `combatTalentScale` rounds ranks 3 and 4 to the same
 * figure — so a point spent there bought a player NOTHING they could see, and
 * `talent-scaling.test.ts`'s consecutive-rank check caught it. The options were
 * to widen the points until every rank differed, which would have ended at five
 * of a six-point budget and made this the best talent in the game, or to give
 * the rank a second thing to move.
 *
 * THE SECOND THING IS THE RIGHT ONE ANYWAY. A shout that carries further is
 * what "authority" means, it is what the tree is about, and it is worth
 * something specific: a Watchman holding a doorway and an Inspector shooting
 * from the back of the room are eight tiles apart, and at rank 1 he cannot
 * reach her. Buying the rank is buying the party's shape.
 */
const RANGE_LOW = 3;
const RANGE_HIGH = 8;

/** How far the whistle carries, at a rank. */
export function rangeAt(level: number): number {
  return Math.max(RANGE_LOW, Math.round(combatTalentScale(level, RANGE_LOW, RANGE_HIGH, CURVE)));
}

const AP_LOW = 1;
const AP_HIGH = 4;
const CURVE = 0.75;

/** Action points handed to the ally, at a rank. */
export function apGivenAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, AP_LOW, AP_HIGH, CURVE)));
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
  cooldownTurns: COOLDOWN_TURNS,
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
    // SEE THE HEADER. `Affinity.Ally` includes the caster, and a Watchman who
    // could whistle himself would do nothing else.
    if (friend.id === self.id) return talentRefused(TalentRefusal.Self);

    /**
     * A BODY WITH NO SHEET CANNOT BE GIVEN A TURN, and that is a refusal rather
     * than a silent no-op. Every player has one; a summoned or scripted ally
     * may not, and "the whistle did nothing and cost 3 AP" is the worst
     * possible reading of a support talent.
     */
    const sheet = ctx.engine.sheetOf(friend.id);
    if (sheet === undefined) return talentRefused(TalentRefusal.NotAlly);

    const wanted = apGivenAt(ctx.talentLevel);
    // CAPPED AT THEIR OWN MAXIMUM -- see the header on why bankable AP would
    // end the turn system.
    const before = sheet.ap;
    sheet.ap = Math.min(sheet.maxAp, sheet.ap + wanted);
    const given = sheet.ap - before;

    if (given <= 0) {
      // ALREADY FULL. Reported honestly rather than dressed up: the player
      // spent the AP and the Resolve, and a log line saying otherwise would
      // teach them to keep doing it.
      return talentDone([], [`${friend.name} has not stopped to need it.`]);
    }

    return talentDone(
      [],
      [`${friend.name} gets ${String(given)} more action${given === 1 ? '' : 's'} out of it.`],
    );
  },

  describe: (_self, level) =>
    `Give a friend within ${String(rangeAt(level))} tiles ${String(apGivenAt(level))} action points, ` +
    `up to their own maximum. ${String(AP_COST)} AP, ${String(RESOLVE_COST)} Resolve — a bad ` +
    `trade at first, and a way to move a turn to where it is worth more once it is not.`,
};
