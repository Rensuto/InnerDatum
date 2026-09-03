// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/spell/explosives.lua:44-51
//          -- `computeDamage` is a five-branch if-chain on WHICH INFUSION IS
//          CURRENTLY UP. `Talent.sustainSlot`'s own docblock already cites this
//          as the shape a mode-stance is for; this is that citation cashed in.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHAT IS IN THE VIAL BEFORE YOU THROW IT — THE ALCHEMIST'S LOADS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three stances on one slot, and NONE of them is a button that does damage.
 * What they do is change what the Alchemist's EXISTING throws leave behind:
 * Ashwick Flare, Alchemic Vial and Concussion Flask each ask which load is up
 * and attach the matching status. That is upstream's own pattern, and this file
 * exists because `Talent.sustainSlot` already pointed at it in as many words --
 * *"a mode the player re-picks every fight ... `computeDamage` in
 * explosives.lua:44-51 is a five-branch if-chain on which infusion is currently
 * up."*
 *
 * ═══ IT MAKES THE CLASS DEEPER WITHOUT MAKING THE BAR LONGER ═══
 * The Alchemist already had three throws. This does not add a fourth; it makes
 * the three worth re-reading, because the same button is a bleed, a slow or a
 * stun depending on a decision made before the fight. A tree of new throws
 * would have been more content and less GAME.
 *
 * ═══ WHY A STATUS AND NOT A DAMAGE TYPE, WHICH WAS THE FIRST DESIGN ═══
 * The obvious infusion changes fire to cold to acid. MEASURED FIRST: the resist
 * system is fully ported (`combatGetResist`, the multiplicative `all` row, the
 * caps that stop the formula inverting) and THE BESTIARY AUTHORS NO RESISTS AT
 * ALL -- monsters.ts:677-679 says so outright, "a giant brown ant resists
 * nothing". A load that swapped Fire for Cold would have changed no number a
 * player could see, which is this codebase's most-repeated failure and the one
 * `derived.ts:110-134` names as the worst kind. The statuses are live today.
 *
 * ═══ ONE SLOT, SO THE CHOICE IS REAL ═══
 * `LOAD_SLOT` on all three. You loaded the bag one way this morning; changing
 * it mid-fight is one press (`toggleSustain` displaces, Actor.lua:5922-5931)
 * and costs the turn's reagent economy nothing, but you cannot have two.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { SetEffectOutcome } from '../engine/effects.ts';
import { combatPhysicalpower, TalentPower } from '../engine/derived.ts';
import { EffectId } from '../content/effects.ts';
import { DamageType } from '../engine/damage.ts';
import { Affinity, ClassId, TalentKind, TargetShape, talentId } from '../engine/talents.ts';
import type { Talent, TalentActor, TalentCallCtx, TalentEngine } from '../engine/talents.ts';

/** All three answer to it. See the header. */
export const LOAD_SLOT = 'load';

/**
 * WHAT A LOAD RESERVES. Reagents is a COUNTABLE 0-8 pool, not a 0-100 one, so
 * this is a whole vial held back rather than a percentage -- you are carrying
 * one fewer throw because one of them is already mixed.
 *
 * ONE, AND ONE IS A LOT HERE. An eighth of the bag, against a resource that
 * regenerates on a slow counter rather than per turn. Two would mean a quarter
 * of the class's ammunition for a rider, which is not a trade anybody takes.
 */
const RESERVE = 1;

const TURNS_LOW = 2;
const TURNS_HIGH = 6;
const CURVE = 0.75;

/** How long the rider lasts, at a rank. Shared by all three loads. */
export function riderTurnsAt(level: number): number {
  return Math.max(1, Math.round(combatTalentScale(level, TURNS_LOW, TURNS_HIGH, CURVE)));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH LOAD IS UP, ASKED FROM INSIDE A THROW'S `onUse`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PassiveView.isSustained` is the read for a PASSIVE, which is recomputed on a
 * clock. A throw resolves NOW and has the engine in hand, so it asks the sheet
 * directly -- the same source, one indirection closer.
 *
 * RETURNS THE EFFECT AND THE RANK OF THE LOAD, not a boolean, because the
 * rider's duration is a fact about the LOAD rather than about the throw. An
 * Alchemist who has put four points into Frost Load slows for longer with the
 * same flare, which is what makes the tree worth deepening rather than dipping.
 */
export type ActiveLoad = { readonly effect: EffectId; readonly level: number };

export function loadedWith(engine: TalentEngine, self: TalentActor): ActiveLoad | null {
  const sheet = engine.sheetOf(self.id);
  if (sheet === undefined) return null;
  for (const [id, effect] of LOAD_EFFECTS) {
    if (!sheet.sustained.has(id)) continue;
    // THE LOAD'S OWN RANK, so deepening the tree lengthens the rider.
    const level = sheet.points.get(id) ?? 0;
    if (level < 1) continue;
    return { effect, level };
  }
  return null;
}

/** The one common body. Three loads differ only in name, tier and rider. */
function load(bare: string, name: string, tier: number, blurb: string, rider: string): Talent {
  return {
    id: talentId(bare),
    name,
    classId: ClassId.Alchemist,
    tree: 'ashwick/loads',
    tier,
    /** loads is about CUN — knowing which one to reach for. See `Talent.statGate`. */
    statGate: 'cun',
    kind: TalentKind.Sustained,
    iconId: `icon_sustain_${bare}`,
    // FREE TO PRESS. `careful_method.ts` carries the argument: charging AP means
    // nobody ever changes stance in the one moment it is interesting.
    cost: { ap: 0 },
    cooldownTurns: 0,
    sustain: { reserve: RESERVE },
    sustainSlot: LOAD_SLOT,
    targeting: {
      shape: TargetShape.Self,
      range: 0,
      minRange: 0,
      radius: 0,
      requiresLos: false,
      affinity: Affinity.Ally,
    },
    damageType: DamageType.Physical,
    scalesWith: { lands: TalentPower.Physical },
    /**
     * NO `passive` BLOCK, AND THAT IS THE DIFFERENCE FROM THE INSPECTOR'S
     * METHODS. A method is a set of numbers on the body; a load is a fact the
     * THROWS read. Contributing a stat here as well would be two payments for
     * one press and would make the loads strictly better than the methods.
     */
    describe: (_self, level) =>
      `A load. While it is up, your Reagents talents also ${rider} for ` +
      `${String(riderTurnsAt(level))} turns (physical save). ${blurb} ` +
      `Holds ${String(RESERVE)} Reagent in reserve, and puts the other loads down.`,
  };
}

/**
 * THE TIERS, NAMED. Two loads open the tree and the third is deep, because a
 * stun is the strongest rider in the game and the tree should have to be
 * studied before it hands one over — the same ordering every other tree keeps.
 */
const ENTRY_TIER = 1;
const DEEP_TIER = 3;

export const causticLoad = load(
  'caustic_load',
  'Caustic Load',
  ENTRY_TIER,
  'It keeps working after it lands.',
  'bleed',
);

export const frostLoad = load(
  'frost_load',
  'Frost Load',
  ENTRY_TIER,
  'Nothing moves quickly through it.',
  'slow',
);

export const concussiveLoad = load(
  'concussive_load',
  'Concussive Load',
  DEEP_TIER,
  'The loudest thing in the room, briefly.',
  'stun',
);

/**
 * THE TABLE THE THROWS READ, in the order it is searched.
 *
 * ORDER IS ARBITRARY AND MUST STAY IRRELEVANT: one slot means at most one of
 * these is ever in `sustained`, so the first match is the only match. Written
 * as a loop rather than three ifs so a fourth load is one line.
 */
const LOAD_EFFECTS: readonly (readonly [string, EffectId])[] = [
  [causticLoad.id, EffectId.Bleeding],
  [frostLoad.id, EffectId.Slowed],
  [concussiveLoad.id, EffectId.Stunned],
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LOAD'S RIDER, ATTACHED TO A BLOW THAT HAS ALREADY LANDED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The four lines that make this tree true, and they live HERE rather than in
 * each of the three throws. A load's rider is a fact about the LOAD; the throws
 * only need to ask. Copied into each caller it would be three places to add a
 * fourth load, and the third one would eventually be forgotten.
 *
 * AFTER THE DAMAGE, AND ONLY ON SOMETHING STILL STANDING. A corpse has nothing
 * to bleed. The throw still took its RNG draws either way, so the stream does
 * not depend on whether it died first — the guarantee `lockdown.ts` and
 * `damage.ts` both make, for the same replay-from-seed reason.
 *
 * NO LOAD IS THE COMMON CASE and costs one sheet lookup. An Alchemist who has
 * never bought this tree throws exactly what they threw before.
 */
export function applyLoad(
  ctx: TalentCallCtx,
  self: TalentActor,
  victim: TalentActor,
): readonly string[] {
  if (!victim.alive) return [];
  const loaded = loadedWith(ctx.engine, self);
  if (loaded === null) return [];
  const turns = riderTurnsAt(loaded.level);
  // `ctx.status` ABSENT IS A FIXTURE WITH NO TABLE, not an error — the throw
  // still hit. Every seam in the talent layer reads this way.
  const landed = ctx.status?.(victim, loaded.effect, turns, {
    applyPower: combatPhysicalpower(self.combat ?? {}),
    srcId: self.id,
  });
  if (landed === undefined || landed.outcome === SetEffectOutcome.Immune || landed.dur <= 0) {
    return [];
  }
  return [`${victim.name} takes the load (${String(landed.dur)} turns).`];
}
