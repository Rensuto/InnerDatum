// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/npcs.lua — the talents
//          that belong to creatures rather than to a class, and are priced
//          against a body that has no resource pool to spend.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE MONSTER ROSTER'S OWN TALENTS. The first things a creature can DO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Monsters could not use talents at all — not "had none authored", COULD NOT.
 * `canUseTalent` needs a sheet, `engine.attach` had two call sites and both
 * were the player path, and `decideNpcAction` never constructed a talent intent
 * in the first place. Nine creatures across two AI profiles, able only to move
 * and bump-attack, in a game shipping 84 talents.
 *
 * ═══ WHY THESE ARE NOT PLAYER TALENTS ═══
 * Nothing stops a template naming one and it would mostly work. But a husk
 * casting the Watchman's Ward Rush is a husk wearing somebody's profession, and
 * every number in a player talent was tuned against a resource pool the
 * creature does not have.
 *
 * ═══ PRICED IN COOLDOWN AND AP, NEVER IN A RESOURCE ═══
 * A creature's sheet is given six action points and no class resource worth the
 * name, because NOTHING IN THE GAME REFILLS A MONSTER'S POOL. A talent priced
 * in Resolve would fire once per creature per lifetime and then look broken.
 * Cooldowns tick for everybody — `actBase` runs for every resolved actor with
 * no player filter — so a cooldown is a price a monster can actually pay.
 *
 * ═══ AND THE COSTS MEAN THE SAME THING ON BOTH SIDES OF A FIGHT ═══
 * Six AP is a player's round too, so "two of its six" is a sentence with one
 * meaning. A separate creature budget would make every number here a figure
 * with no referent.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  talentAttack,
  talentDone,
  talentId,
  talentRefused,
  targetActor,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MARKS A TALENT AS THE BESTIARY'S. The tree prefix, and it is a REAL
 * discriminator rather than a naming convention.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A monster talent is in the registry — `talents.use` resolves it through
 * there — and in nothing else. It has no tier, because nobody ranks it up. It
 * has no entry in `TALENT_TREES`, because no panel ever draws it. It is on no
 * class's loadout, because no player can learn it.
 *
 * Every one of those is correct and every one of them breaks a test that was
 * written when `registry.all()` meant 'every talent a player can reach' —
 * which it did, until this file. The prefix is how those tests tell the two
 * populations apart, and it is exported so they ask rather than hard-code a
 * string that would drift.
 */
export const MONSTER_TREE_PREFIX = 'monster/';

/** True for a talent that belongs to the bestiary and to no player. */
export function isMonsterTalent(talent: { readonly tree: string }): boolean {
  return talent.tree.startsWith(MONSTER_TREE_PREFIX);
}

/** FROZEN. Two of a creature's six, so it still has a round left to move in. */
const CLUTCH_AP = 2;
const CLUTCH_COOLDOWN = 5;

/** How hard it bites, at a rank. Monsters are all rank 1 — see `ensureMonsterSheet`. */
const DAMAGE_LOW = 0.5;
const DAMAGE_HIGH = 1.1;
const CURVE = 0.75;

/** Weapon-damage multiplier at a rank. */
export function clutchMult(level: number): number {
  return combatTalentScale(level, DAMAGE_LOW, DAMAGE_HIGH, CURVE);
}

const SLOW_TURNS = 3;

/** The three-branch log line. `move_along.ts` carries the whole argument. */
function slowLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} pulls free.`];
  }
  return [`${name} is held (${String(landed.dur)} turns).`];
}

/**
 * GRASPING HOLD — the Index Glut's, and the first talent a monster can use.
 *
 * "It does not want to hurt you. It wants you to stay."
 *
 * ═══ IT SLOWS RATHER THAN DAMAGING, WHICH IS THE POINT OF GIVING IT ONE ═══
 * A creature that hit harder would be a husk with different art. What a talent
 * should do is change the SHAPE of the fight — and a slow is the thing this
 * game had no monster answer to: every position talent a player has bought
 * (One at a Time, Braced, Riot Line, Cold Case, the whole of Legwork) assumes
 * they can choose where to stand.
 *
 * ═══ AND IT IS THE MIRROR OF THE PLAYER'S OWN LINE OF ENQUIRY ═══
 * That one is a poor shot that slows, priced so pressing it is a choice to
 * spend a turn on position. This is the same trade from the other side of the
 * board, which is what makes it legible: a player who has used one recognises
 * what just happened to them.
 *
 * ═══ MELEE REACH, AND THAT IS WHO GETS IT ═══
 * A ranged hold would make the kiting classes unplayable, so this reaches 1.5
 * and the creature has to arrive first. It was authored onto the Index Wraith,
 * which is a `RangedKiter` that never closes — offered to the AI every turn and
 * refused on range every turn, with nothing anywhere reporting a problem.
 *
 * The Glut is the creature it was actually describing: slow, armoured, and
 * carrying a docblock that already admitted *"a wall you can simply walk away
 * from is not a wall."* This is what stops you walking away.
 */
export const graspingHold: Talent = {
  id: talentId('grasping_hold'),
  name: 'Grasping Hold',
  // NO CLASS. `classId: null` is what a shared talent uses and is honest here
  // for a different reason: this belongs to a creature, and no player can ever
  // learn it — it is in no class's loadout and in no tree's contents.
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_grasping_hold',
  cost: { ap: CLUTCH_AP },
  cooldownTurns: CLUTCH_COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: 1.5,
    minRange: 0,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    const hit = talentAttack(ctx, self, victim, { mult: clutchMult(ctx.talentLevel) });
    // A corpse cannot be held. The swing above still took its RNG draws, so the
    // stream does not depend on whether it died first — the guarantee
    // `lockdown.ts` and `damage.ts` both make for the same replay reason.
    if (!victim.alive) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Slowed, SLOW_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], slowLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Takes hold for ${percent(clutchMult(level))} weapon damage and slows for ` +
    `${String(SLOW_TURNS)} turns (physical save).`,
};

/** Every talent the bestiary owns. The registry is built from this. */
export const MONSTER_TALENTS: readonly Talent[] = Object.freeze([graspingHold]);
