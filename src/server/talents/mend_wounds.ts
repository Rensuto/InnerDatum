// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/mend_wounds.json
//          (ap_cost 4, effects: [{ type: "heal_self", heal_pct: 0.20 }])
//          game-design.md § 2 (AP 4, rng 2, heal 20% — "the party's only real heal")
// SHAPE:   t-engine4 game/modules/tome/data/talents/celestial/light.lua:50-80
//          (Bathe in Light: `cooldown = 20`, `radius = 2`, a ball centred on
//           the caster that heals everyone standing in it)
//          t-engine4 .../gifts/call.lua:90-130 (Nature's Touch, `cooldown = 15`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MEND WOUNDS — THE PARTY'S ONLY REAL HEAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Quickly bind injuries using an alchemic field kit. The dressings smell
 * faintly of Glassroot."
 *
 * game-design.md § 2 calls it exactly that, in bold, which makes this the
 * single most consequential number in the twelve: everything about how long a
 * fight lasts, whether Downed (§ 9) is a tense five turns or a formality, and
 * whether the Alchemist is the person everyone stands near, comes out of this
 * file.
 *
 * ═══ IT HEALS THE PARTY, NOT THE CASTER ═══
 * The authored effect is `heal_self` at 20%, because Outer Index is a
 * single-player game and has no allies to heal. game-design.md's table gives it
 * `rng 2` — a radius, on a talent whose source effect is self-only — and
 * § 2 files it under "ally utility". Both readings resolve the same way: a ball
 * of radius 2 centred on the Alchemist, healing every ally in it, INCLUDING the
 * Alchemist. That is `Bathe in Light` (light.lua:51-80) to the tile.
 *
 * The consequence is positional, and it is the whole point: the heal is worth
 * 20% to one person or 20% to four, so the party has a standing reason to be
 * within two tiles of each other, which is the same two tiles that make the
 * Watchman's Resolve tick and the same clustering that gets everyone killed by
 * an Alchemic Vial. Every co-op decision in the MVP is downstream of that
 * tension.
 *
 * ═══ 20% OF *MAX* HP, PER TARGET ═══
 * `heal_pct: 0.20` of `max_life`, not of missing life and not a flat number.
 * Percentage-of-max is what makes a heal legible on a party panel and what
 * stops it from being worthless at level 1 and mandatory at level 40.
 *
 * ═══ THE COOLDOWN IS THE FIRST NUMBER TO TUNE ═══
 * Bathe in Light is `cooldown = 20` ToME actions; at two actions per Inner
 * Datum turn that is 10 turns, which is longer than most MVP fights. It is left
 * at the honest conversion rather than pre-softened, because a cited number
 * that plays badly is a five-second edit with a paper trail, and a guessed
 * number that plays well is unfalsifiable forever. If the first playtest says
 * the only healer is useless, THIS constant is the one to move — and it is the
 * only one in the file.
 */

import { combatTalentScale } from '../../shared/scale.ts';
import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  ballTiles,
  actorsInShape,
  healActor,
  talentId,
  percent,
  talentDone,
  TargetShape,
  tomeCooldownToTurns,
  TalentKind,
} from '../engine/talents.ts';
import type { Talent, TalentHit } from '../engine/talents.ts';

/**
 * 3 OF 6, AND IT WAS 4.
 *
 * The heal is still the turn you did not spend killing anything — a 6-AP round
 * buys two Mends or nothing else worth having beside one. What it is NOT any
 * more is the turn you did not spend doing ANYTHING else: at 3 it pairs with
 * Ashwick Flare, so an Alchemist can answer a hurt friend and still contribute
 * to the fight in the same round.
 *
 * That pairing is the whole reason this moved. See `ashwick_flare.ts` for the
 * arithmetic — at 4 and 4 her cheapest pair was 8 against a budget of 6, so the
 * Alchemist was the one class the intra-turn budget could never reach.
 */
const AP_COST = 3;
/**
 * FROZEN AT 3 — the most expensive thing in the Alchemist's book, and it is
 * three-eighths of the whole stock. That price is what makes the party's only
 * real heal a genuine choice rather than a reflex, and a rank that discounted
 * it would let the Alchemist heal on cooldown all evening.
 */
const REAGENT_COST = 3;
/**
 * game-design.md § 2, "rng 2". Centred on the caster (Bathe in Light,
 * `range = 0`).
 *
 * FROZEN, and this is the single most consequential frozen number in the
 * twelve. The header spells out why: the heal is worth 20% to one person or 20%
 * to four, so the party has a standing reason to be within two tiles of each
 * other — the same two tiles that make the Watchman's Resolve tick and the same
 * clustering that gets everyone killed by an Alchemic Vial. "Every co-op
 * decision in the MVP is downstream of that tension." A radius that grew with
 * rank would relax the tension exactly as the party gained the levels to
 * exploit it, and the positioning game would quietly end. The rank buys HOW
 * MUCH, never HOW FAR.
 */
const RADIUS = 2;
/** `heal_pct: 0.20`, of each target's MAX hp. Unchanged at talent level 1. */
const HEAL_FRACTION_LOW = 0.2;
/**
 * TUNED HIGH, not ported, and this is the honest hard case of the twelve.
 *
 * Its cited source — Bathe in Light, light.lua:50-80 — is cited for SHAPE only
 * (a ball of radius 2 centred on the caster that heals everyone in it). Its
 * magnitude is `combatTalentSpellDamage`-shaped flat healing off spellpower,
 * NOT a percentage of max life, so there is no upstream curve for a
 * percentage-of-max heal to port. Nature's Touch (call.lua:90-130) is the same
 * story. Neither can supply a high; both would have to be re-derived through a
 * body-scale anchor, and an anchor-derived number presented as a port is
 * exactly what resolvers.ts exists to stop.
 *
 * 0.32 is tuned against the fight it has to survive. At rank 1 a 10-turn
 * cooldown returns 20% of one bar; at rank 5 it returns 32%, so a fully-trained
 * Alchemist restores roughly a third of the party in one cast. Beyond that the
 * heal starts outpacing the damage a 3-6 player fight puts out and Downed
 * (§ 9) stops being a real state, which is the failure mode the header warns
 * about from the other direction. If the first playtest says the healer is
 * useless, the header is explicit that `TOME_COOLDOWN` is the constant to move
 * — that judgement is unchanged and now applies at every rank.
 */
const HEAL_FRACTION_HIGH = 0.32;

/** The one place this talent's curve is written. */
/**
 * EXPORTED so a test pins this curve by CALLING it rather than restating the
 * band. A test that rewrites the arithmetic is a second copy of it, and this
 * codebase has already shipped a beginner room that killed players because a
 * test modelled armour its own way (M-007).
 */
export function healFraction(talentLevel: number): number {
  return combatTalentScale(talentLevel, HEAL_FRACTION_LOW, HEAL_FRACTION_HIGH);
}
/** Bathe in Light, light.lua:56 — `cooldown = 20` ToME actions. See the header. */
const TOME_COOLDOWN = 20;

export const mendWounds: Talent = {
  id: talentId('mend_wounds'),
  name: 'Mend Wounds',
  classId: ClassId.Alchemist,
  tree: 'ashwick/ministration',
  /** Tier 4 of its tree. See `src/shared/tiers.ts`. */
  tier: 4,
  /** ministration is about WIL. See `Talent.statGate`. */
  statGate: 'wil',
  kind: TalentKind.Active,
  iconId: 'icon_active_mend_wounds',
  cost: { ap: AP_COST, resource: REAGENT_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    // Self-centred: there is nothing to point at, which also means there is no
    // way to fumble it under pressure. The one button that must never be fiddly.
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: RADIUS,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    const tiles = ballTiles({ x: self.x, y: self.y }, RADIUS);
    const allies = actorsInShape(ctx.world, self, tiles, Affinity.Ally);

    const fraction = healFraction(ctx.talentLevel);
    const hits: TalentHit[] = [];
    for (const ally of allies) {
      const healed = healActor(ally, Math.round(ally.maxHp * fraction));
      if (healed <= 0) continue;
      hits.push({
        targetId: ally.id,
        hit: true,
        damage: 0,
        healed,
        crit: false,
        killed: false,
        type: DamageType.Physical,
      });
    }

    // Casting into a party at full health burns the Reagents anyway. Same rule
    // as the vial thrown at an empty crossroads: the refund rule covers intents
    // that went ILLEGAL, not intents that were a bad idea.
    return talentDone(hits, [`Field kit opened. ${hits.length} bound.`]);
  },

  describe: (_self, level) =>
    `Bind every ally within ${RADIUS} tiles — yourself included — for ` +
    `${percent(healFraction(level))} of their maximum health. ` +
    `${AP_COST} AP, ${REAGENT_COST} Reagents.`,
};
