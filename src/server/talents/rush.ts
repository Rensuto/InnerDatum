// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// PORTED:  t-engine4 game/modules/tome/data/talents/techniques/combat-techniques.lua
//          :24-95 (T_RUSH) — the base wolf's one talent, canine.lua:55-57.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license
//
// ONE TALENT PER FILE. See the roster note in monster.ts for what breaks
// otherwise — tools/art-needs.mjs reads a talent module whole.

import { combatTalentScale } from '../../shared/scale.ts';
import { EffectId } from '../content/effects.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { combatPhysicalpower } from '../engine/derived.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  percent,
  stepToward,
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
 * RUSH — the Index Eidolon's. It closes the whole distance in one turn.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "You see it at four tiles. You do not get a second decision."
 *
 * ═══ THE BASE WOLF'S ONE TALENT, AND THIS CREATURE IS THE BASE WOLF ═══
 * The Eidolon is ported from `canine.lua:40-43` — the stat block every wolf in
 * ToME is built on — and `canine.lua:55-57` gives that block exactly one thing:
 *
 *     resolvers.talents{
 *         [Talents.T_RUSH]={base=0, every=10},
 *     },
 *
 * So this is not a talent chosen for the creature. It is the creature's own,
 * and it was missing.
 *
 * ═══ IT IS THE TEMPLATE'S DESIGN NOTE MADE MECHANICAL ═══
 * That note already says what this creature is: *"you meet it at four tiles, it
 * acts 1.2 times for your one, and it is on you before you get a second
 * decision"*, and *"on the open moor you see it coming from eight tiles away
 * and shoot it to pieces, because it is made of paper."*
 *
 * `globalSpeed` alone cannot produce that. A fast creature crossing open ground
 * is a fast creature you shoot four times instead of five. Rush is the thing
 * that makes the wood lethal and leaves the moor exactly as it was — the
 * closing range is bounded, so on the moor it still has to walk most of the way
 * under fire, and the creature keeps its stated weakness.
 *
 * ═══ COOLDOWN IS UPSTREAM'S INTENT, NOT ITS ARITHMETIC ═══
 * `combatTalentLimit(t, 0, 36, 20)` is a diminishing curve that reaches 0 at
 * infinite talent level, and `canine.lua` hands the wolf `{base=0, every=10}`,
 * meaning rank 0 until level 10. A monster here is always rank 1 (see
 * `ensureMonsterSheet`), so the curve has one point on it and a literal is the
 * honest way to write a number with no second value.
 */
const RUSH_AP = 4;
const RUSH_COOLDOWN = 7;

/** combat-techniques.lua:36 — `floor(combatTalentScale(t, 6, 10))`. */
const RANGE_LOW = 6;
const RANGE_HIGH = 10;

export function rushRange(level: number): number {
  return Math.floor(combatTalentScale(level, RANGE_LOW, RANGE_HIGH, MONSTER_CURVE));
}

/** combat-techniques.lua:88 — `self:attackTarget(target, nil, 1.2, true)`. */
const RUSH_DAMAGE = 1.2;

/** combat-techniques.lua:89 — `target:setEffect(target.EFF_DAZED, 3, {})`. */
const DAZE_TURNS = 3;

/**
 * IT MUST ACTUALLY ARRIVE. `minRange` is 2, so this cannot be pressed from
 * touching distance — upstream's is a charge with `CLOSEIN = 3` in its tactical
 * table, and a Rush used as a free extra swing at melee range would be a
 * different talent wearing this one's citation.
 */
const RUSH_MIN_RANGE = 2;

/** How close it has to end up for the blow to land. */
const MELEE_REACH = 1.5;

/** The three-branch line. `move_along.ts` carries the whole argument. */
function dazeLine(name: string, landed: SetEffectResult | undefined): string[] {
  if (landed === undefined) return [];
  if (landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [`${name} rides it out.`];
  }
  return [`${name} is dazed (${String(landed.dur)} turns).`];
}

export const rush: Talent = {
  id: talentId('rush'),
  name: 'Rush',
  classId: null,
  tree: 'monster/index',
  kind: TalentKind.Active,
  iconId: 'icon_monster_rush',
  cost: { ap: RUSH_AP },
  cooldownTurns: RUSH_COOLDOWN,
  targeting: {
    shape: TargetShape.Single,
    range: RANGE_HIGH,
    minRange: RUSH_MIN_RANGE,
    radius: 0,
    requiresLos: true,
    affinity: Affinity.Hostile,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const victim = targetActor(ctx.world, target);
    if (victim === undefined) return talentRefused(TalentRefusal.NoTarget);

    /**
     * ═══ IT WALKS. IT DOES NOT TELEPORT, AND THAT IS THE COUNTERPLAY ═══
     * `stepToward` goes through `world.tryMove` one tile at a time and stops at
     * the first blocked step — upstream's Rush does the same, running its move
     * loop `until is_corner_blocked or ... checkAllEntities(block_move)`. So a
     * closed door, a corner, or a body standing in the corridor all stop it,
     * and a party that holds a doorway has answered this talent with position
     * rather than with a resistance.
     */
    const closed = stepToward(
      ctx.world,
      self,
      { x: victim.x, y: victim.y },
      rushRange(ctx.talentLevel),
    );

    /**
     * AND IF IT DID NOT GET THERE, IT SPENT ITS TURN GETTING CLOSER.
     *
     * NOT A REFUSAL. A refusal refunds the AP and the cooldown, which would make
     * this a free probe for whether the lane is clear — press it, see nothing
     * happen, press it again next turn. The creature committed to a charge and
     * ran into something; the ground it gained is what it got.
     */
    const dx = Math.abs(self.x - victim.x);
    const dy = Math.abs(self.y - victim.y);
    if (Math.max(dx, dy) > MELEE_REACH) {
      return talentDone(
        [],
        closed > 0 ? [`${self.name} closes in.`] : [`${self.name} is blocked.`],
      );
    }

    const hit = talentAttack(ctx, self, victim, { mult: RUSH_DAMAGE });
    if (!victim.alive) return talentDone([hit]);

    /**
     * THE DAZE LANDS AFTER THE BLOW, WHICH IS UPSTREAM'S ORDER AND MATTERS.
     *
     * `EFF_DAZED` carries `breaksOnDamage`, so a daze applied BEFORE the swing
     * would be removed by that same swing and this talent would silently never
     * daze anybody. Upstream has the identical ordering
     * (combat-techniques.lua:88-89) for what is presumably the identical reason.
     */
    const landed = ctx.status?.(victim, EffectId.Dazed, DAZE_TURNS, {
      applyPower: combatPhysicalpower(self.combat ?? {}),
      srcId: self.id,
    });
    return talentDone([hit], dazeLine(victim.name, landed));
  },

  describe: (_self, level) =>
    `Charges up to ${String(rushRange(level))} tiles and strikes for ` +
    `${percent(RUSH_DAMAGE)} weapon damage, leaving the target dazed for ` +
    `${String(DAZE_TURNS)} turns — until something hits them.`,
};
