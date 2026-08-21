// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/spells/staff-combat.lua
//          (T_BLASTSTAFF) and the repulsion family — a caster's answer to being
//          stood on, priced so that closing is still correct and no longer free.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise — tools/art-needs.mjs reads a talent module whole.

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  actorsInShape,
  ballTiles,
  knockback,
  percent,
  talentBaseDamage,
  talentDone,
  talentId,
  talentProject,
  talentRefused,
} from '../engine/talents.ts';
import { MONSTER_CURVE } from './monster.ts';
import type { TalentHit } from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CLEAR THE ALTAR — the Watcher's. What it does when you finally get to it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The pile has been added to since the country ended. It does not care to be
 * stood on."
 *
 * ═══ THIS FIXES A HOLE THE TEMPLATE ITSELF WROTE DOWN ═══
 * The Watcher is mobile artillery holding a band, and its own design note reads
 * off `kite`'s three branches — advance beyond 9, fire between 3 and 9, and
 * inside `minRange` 3:
 *
 *     it BACKS AWAY, and if it cannot,
 *     *"CORNERED. hold rather than fire a shot that will be refused"*
 *     — it does nothing at all.
 *
 * A boss that does NOTHING AT ALL once you corner it is a boss whose solution
 * is "corner it". That note was written as a description of the fight and it is
 * really a description of the exploit: the counter to the whole encounter was
 * to walk it into a wall and stand on its feet, and it had no answer because
 * nothing in the game had given it one.
 *
 * ═══ AND IT DOES NOT MAKE CLOSING WRONG, ONLY EXPENSIVE ═══
 * Closing is still the right play — it is the only way to stop something with
 * `attackRange: 11` that outranges every class in the game. This just means the
 * party pays for the ground rather than getting it free, and the fight becomes
 * "get in, take the blast, stay in" instead of "get in, and the boss switches
 * off".
 *
 * ═══ THE SITUATION IS IN THE TARGETING, NOT IN A SCORING FUNCTION ═══
 * ToME picks a monster's talent with `AI_TACTICS` — a 1800-line evaluator that
 * scores every option against the board. Porting that here would be a large
 * system with almost nothing to decide: every armed creature in this bestiary
 * owns exactly one talent, so a scorer would rank a list of length one.
 *
 * `Ball` at `range: 2` does the same job for free. `castable` (main.ts) filters
 * every option through `canUseTalent`, so this one is simply NOT AVAILABLE
 * unless a hostile is within two tiles — which is precisely the cornered state
 * it exists for. The AI never has to know what the talent is for, because the
 * talent cannot be offered at a moment when it would be wasted.
 *
 * The scorer becomes worth building when a creature owns two talents that are
 * both legal at once. Nothing does yet, and building it now would be one more
 * finished system with no content pointed at it.
 */
const ALTAR_AP = 4;
const ALTAR_COOLDOWN = 6;

/**
 * REACH TWO, BLAST TWO. The reach is what makes this a cornered-only answer —
 * `minRange` is 3, so any moment this is legal is a moment the party has come
 * inside the band the creature wanted to hold.
 */
const REACH = 2;
const RADIUS = 2;

/** Authored. Real, and well short of the shot it gives up to fire this. */
const DAMAGE_LOW = 0.6;
const DAMAGE_HIGH = 1.1;

export function altarMult(level: number): number {
  return combatTalentScale(level, DAMAGE_LOW, DAMAGE_HIGH, MONSTER_CURVE);
}

/**
 * HOW FAR IT SHOVES.
 *
 * Two tiles, which is exactly the distance from "standing on it" to "outside
 * `minRange` 3" — so a successful blast restores the band the creature fights
 * in rather than merely inconveniencing anybody. A longer shove would put the
 * party back at preferred range and make the whole approach worthless.
 */
const SHOVE_TILES = 2;

export const clearTheAltar: Talent = {
  id: talentId('clear_the_altar'),
  name: 'Clear the Altar',
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_clear_the_altar',
  cost: { ap: ALTAR_AP },
  cooldownTurns: ALTAR_COOLDOWN,
  targeting: {
    shape: TargetShape.Ball,
    range: REACH,
    minRange: 0,
    radius: RADIUS,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const tiles = ballTiles(target, RADIUS);
    const victims = actorsInShape(ctx.world, self, tiles, Affinity.Hostile);
    // Legality already required a hostile within reach, so an empty sweep means
    // the board moved between the AI choosing and the turn resolving. Refusing
    // refunds rather than spending a six-turn cooldown on nobody.
    if (victims.length === 0) return talentRefused(TalentRefusal.NoTarget);

    const base = talentBaseDamage(self);
    const mult = altarMult(ctx.talentLevel);
    const hits: TalentHit[] = [];
    /**
     * DAMAGE FIRST, THEN THE SHOVE, FOR EVERY BODY IN TURN.
     *
     * `knockback` moves the victim, so shoving before projecting would compute
     * the blast against tiles nobody was standing on when it went off. The same
     * ordering `move_along.ts` uses, for the same reason.
     *
     * AND IT SHOVES FROM THE CASTER, not from the blast's centre. The centre is
     * whichever body the AI aimed at; pushing away from THAT would scatter the
     * party around the Watcher instead of off it, which is the opposite of what
     * the talent is for.
     */
    for (const victim of victims) {
      hits.push(talentProject(ctx, self, victim, base, DamageType.Physical, mult));
      if (victim.alive) knockback(ctx.world, victim, self, SHOVE_TILES);
    }

    return talentDone(hits, [`The Watcher clears its ground. ${String(hits.length)} thrown back.`]);
  },

  describe: (_self, level) =>
    `Throws everything within ${String(RADIUS)} tiles back ${String(SHOVE_TILES)} tiles for ` +
    `${percent(altarMult(level))} damage. Only when something has come inside its guard.`,
};
