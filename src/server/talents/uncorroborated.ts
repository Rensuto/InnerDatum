// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/npcs.lua — the talents
//          that belong to creatures rather than to a class, and are priced
//          against a body that has no resource pool to spend.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise — tools/art-needs.mjs reads a talent module whole.

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { countAdjacentKin } from '../engine/actor.ts';
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
import { MONSTER_CURVE } from './monster.ts';
import type { SetEffectResult } from '../engine/effects.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UNCORROBORATED — the Disgraced Inspector's. It hits hardest when you are
 * standing on your own.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "One witness is a story. Two is a fact."
 *
 * That is the epigraph of the PLAYER Inspector's Corroboration
 * (`corroboration.ts`), and this is the same sentence read from the other end.
 * The Disgraced Inspector is what happened to somebody doing your job on this
 * exact ground before it was erased — so the talent it brings is not a monster
 * ability at all, it is a method, and it is yours.
 *
 * ═══ IT MAKES THE AI'S OWN BEHAVIOUR INTO SOMETHING YOU CAN FEEL ═══
 * This creature already TARGETS whoever is alone — `huntsIsolated`, and
 * `mostIsolated` in ai/npc.ts. That is invisible: a player who gets picked on
 * cannot tell targeting from bad luck, and the design note for the elite pair
 * says out loud that the point is to manufacture the sentence *"get over here"*.
 *
 * A number that triples when nobody is beside you says it in one blow. The
 * counterplay is not a talent, an item or a resistance — it is standing next to
 * somebody, which is the thing the whole elite pair exists to be about.
 *
 * ═══ AND IT ASKS THE SAME QUESTION THE TARGETING DOES ═══
 * `countAdjacentKin` (engine/actor.ts) is shared with `supportOf` in ai/npc.ts
 * for exactly this reason. Two definitions of "alone" would eventually disagree,
 * and the symptom would be a creature that walks past a lone Alchemist to reach
 * someone it thinks is more alone and then hits them for less. Nothing would
 * report that. It would just feel wrong.
 *
 * MELEE, because this is a `MeleeChaser` with `attackRange: 1`. The reach and
 * the profile are one decision — see the roster note in monster.ts for the
 * afternoon that lesson cost.
 */
const UNCORROBORATED_AP = 3;
const UNCORROBORATED_COOLDOWN = 6;

/** The base swing, before anybody counts who is standing about. */
const DAMAGE_LOW = 0.7;
const DAMAGE_HIGH = 1.2;

/**
 * WHAT BEING ALONE COSTS YOU, INDEXED BY LIVING FRIENDS ADJACENT.
 *
 * ═══ A TABLE RATHER THAN A CURVE, BECAUSE A PLAYER HAS TO READ IT MID-FIGHT ═══
 * "Three times as hard when nobody is next to you, half again with one, nothing
 * with two" is a sentence somebody can say in a voice channel. A continuous
 * falloff would be tidier arithmetic and unlearnable in play — and this number
 * is only worth having if the party can act on it.
 *
 * TWO IS THE CEILING. Standing in a crowd is not better than standing in a
 * pair; the talent asks for a witness, and one is enough to make it a fact.
 */
/** Nobody beside you. */
const ALONE_MULT = 3;
/** One witness. Half the bonus, because a story is not yet a fact. */
const PAIRED_MULT = 1.5;
/** Two or more. The talent has nothing to work with. */
const WITNESSED_MULT = 1;

const ISOLATION_MULT = [ALONE_MULT, PAIRED_MULT, WITNESSED_MULT] as const;
const CROWD = ISOLATION_MULT.length - 1;

export function isolationMultFor(support: number): number {
  return ISOLATION_MULT[Math.min(Math.max(support, 0), CROWD)] ?? 1;
}

export function uncorroboratedMult(level: number, support: number): number {
  return (
    combatTalentScale(level, DAMAGE_LOW, DAMAGE_HIGH, MONSTER_CURVE) * isolationMultFor(support)
  );
}

/**
 * AND A WOUND, BUT ONLY IF THERE WAS GENUINELY NOBODY THERE.
 *
 * The bleed is the part that persists after the blow, and it is gated on TRUE
 * isolation rather than scaled like the damage — a partial bleed for a partial
 * crowd would be a second dial doing the first dial's job. One witness stops it
 * outright, which is the same rule the epigraph states.
 */
const BLEED_TURNS = 4;
const BLEED_MAGNITUDE = 3;

/** The three-branch line. `move_along.ts` carries the whole argument. */
function woundLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} keeps their feet.`];
  }
  return [`${name} is bleeding (${String(landed.dur)} turns).`];
}

export const uncorroborated: Talent = {
  id: talentId('uncorroborated'),
  name: 'Uncorroborated',
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_uncorroborated',
  cost: { ap: UNCORROBORATED_AP },
  cooldownTurns: UNCORROBORATED_COOLDOWN,
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

    /**
     * COUNTED BEFORE THE BLOW, which matters in the one case that decides
     * fights: a victim who dies is removed, and a victim who is knocked about
     * has moved. The number the talent priced itself on must be the arrangement
     * the player was actually looking at when they chose to stand there.
     */
    const support = countAdjacentKin(victim, (x, y) => ctx.world.actorAt(x, y));
    const hit = talentAttack(ctx, self, victim, {
      mult: uncorroboratedMult(ctx.talentLevel, support),
    });
    if (!victim.alive) return talentDone([hit]);

    // A witness is a witness. No bleed at all, rather than a smaller one.
    if (support > 0) return talentDone([hit]);

    const landed = ctx.status?.(victim, EffectId.Bleeding, BLEED_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      power: BLEED_MAGNITUDE,
      srcId: self.id,
    });
    return talentDone([hit], woundLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Strikes for ${percent(uncorroboratedMult(level, CROWD))} weapon damage, rising to ` +
    `${percent(uncorroboratedMult(level, 0))} against someone with nobody beside them — ` +
    `and opens a wound if they are truly alone.`,
};
