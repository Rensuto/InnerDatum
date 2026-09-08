// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/talents/misc/inscriptions.lua:1313-1344 ("Rune: Phase Door" —
//              `is_teleport = true`, `self:teleportRandom(self.x, self.y, data.range)`,
//              then `EFF_OUT_OF_PHASE` for `data.dur`)
//   t-engine4 game/modules/tome/class/Actor.lua:1540-1604 (`teleportRandom` — the MODULE'S,
//              which overrides `engine/Actor.lua:331` and adds the vault rule)
//   t-engine4 game/modules/tome/data/birth/races/elf.lua:108 (the Shalore are born with one:
//              `{cooldown=7, range=10, dur=5, power=15}`)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PHASE DOOR RUNE. The button ToME players press more than any other.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fifteen years of tuning went into making this the answer to "I am about to
 * die and walking will not save me". It is worth being precise about WHY, since
 * a blink looks like a convenience and is not:
 *
 * ═══ IT IS THE ONLY ESCAPE THAT BEATS SOMETHING FASTER THAN YOU ═══
 * `fog_step` is Disengage — it walks you three tiles, and a monster with
 * `globalSpeed: 1.2` closes that back in two turns while you spent one. A
 * teleport is not a walk: ten tiles at once, through the wall, and the thing
 * chasing you has to find you again. That is a different KIND of answer, and
 * before this the game had none.
 *
 * ═══ THE PHASE AFTERWARDS IS HALF THE TALENT ═══
 * `EFF_OUT_OF_PHASE` for five turns: +15 defence, +15% to all resistances, and
 * new afflictions land 15% shorter. Distance alone buys a turn; the phase is
 * what stops the turn you bought being spent on the stun that follows you.
 *
 * ═══ IT COSTS NO TURN — and this one is NOT `no_energy` upstream ═══
 * `inscriptions.lua:1313-1344` declares `is_spell` and `is_teleport` but no
 * `no_energy`, unlike every other inscription in that file. It is offered here
 * at `ap: 0` anyway, because in THIS engine an inscription is defined by being
 * the thing you do while the fight goes on (`healing_infusion.ts` carries the
 * argument) and a single rune that cost a turn where its three siblings do not
 * would read as a bug rather than as a cost. The seven-turn cooldown — the
 * shortest of any inscription here — is upstream's own price for it.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  TalentKind,
  TalentRefusal,
  TargetShape,
  talentDone,
  talentId,
  talentRefused,
  teleportRandom,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';
import { EffectId } from '../content/effects.ts';

/**
 * `range = 10` (elf.lua:108), and it is EXACTLY `DEFAULT_SIGHT_RADIUS`.
 *
 * That coincidence is worth stating because it is the tuning: a blink that
 * lands inside your own sight radius has not lost you, and one that goes
 * further leaves you somewhere you cannot see. Ten is the edge — the furthest
 * you can go and still know what is around you when you arrive.
 */
const RANGE = 10;

/**
 * `power = 15` (elf.lua:108), and one figure drives all three phase channels —
 * `inscriptions.lua:1327-1330` computes `(data.power or data.range) +
 * inc_stat * 3` once and passes it to defence, resists and effect reduction
 * alike. We have no `inc_stat`, so 15 is the whole of it.
 */
const PHASE_POWER = 15;

/** `dur = 5` (elf.lua:108), in UPSTREAM turns. Two of those are one of ours. */
const TOME_DURATION = 5;

/**
 * `cooldown = 7` (elf.lua:108) — the SHORTEST inscription cooldown in the game,
 * against the healing infusion's twelve and the shielding rune's sixteen.
 *
 * Upstream means that. An escape that is not there when you need it is not an
 * escape, and the thing it buys is a turn rather than a fight.
 */
const TOME_COOLDOWN = 7;

/** See the header: `ap: 0` is a stated divergence, not an omission. */
const AP_COST = 0;

export const phaseDoorRune: Talent = {
  id: talentId('phase_door_rune'),
  name: 'Phase Door Rune',
  /** NO CLASS OWNS IT — see `healing_infusion.ts`. An origin grants it. */
  classId: null,
  tree: 'generic/inscriptions',
  /** `type = {"inscriptions/runes", 1}` (:1315) — the rune pool, not the infusion one. */
  inscriptionKind: 'rune',
  tier: 1,
  kind: TalentKind.Active,
  /** ITS OWN ICON, UNDRAWN FOR NOW — `Talent.iconId` states the rule. */
  iconId: 'icon_active_phase_door_rune',
  /** ONE RANK — `points = 1` on every `newInscription`. */
  maxLevel: 1,
  cost: { ap: AP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    /**
     * SELF, AND NOT A POINT YOU CHOOSE. Upstream's is `teleportRandom(self.x,
     * self.y, range)` — centred on YOU, landing somewhere random within it. The
     * one you aim is `Rune: Controlled Phase Door` (:1346), a different and
     * rarer inscription, and collapsing the two would hand a starting character
     * the good version for free.
     */
    shape: TargetShape.Self,
    range: 0,
    minRange: 0,
    radius: 0,
    requiresLos: false,
    affinity: Affinity.Ally,
  },
  /** Required by the type and never rolled: this one moves you. */
  damageType: DamageType.Physical,

  onUse: (ctx, self) => {
    /**
     * NOWHERE TO GO IS A REFUSAL, not a spent cooldown.
     *
     * `teleportRandom` answers false when nothing in range is both walkable and
     * empty — a sealed room, or a corridor packed with bodies. Upstream returns
     * `false` from the same call and the action fails; here that becomes a
     * refusal, so the seven turns are not burned on a blink that did not happen.
     */
    if (!teleportRandom(ctx.world, self, RANGE, ctx.rng)) {
      return talentRefused(TalentRefusal.Blocked);
    }

    /**
     * THE PHASE, AFTER THE MOVE. Upstream's order (:1321-1327) and it matters
     * here for a reason it does not upstream: if the teleport is refused above,
     * nothing has been applied — no phase without a blink.
     */
    ctx.status?.(self, EffectId.OutOfPhase, tomeCooldownToTurns(TOME_DURATION), {
      power: PHASE_POWER,
    });

    return talentDone([], [`${self.name} steps sideways out of the world.`]);
  },

  describe: () =>
    `Blink to a random spot within ${String(RANGE)} tiles, wall or no wall. ` +
    `For a few turns afterwards you are hard to hit, hard to hurt and hard to hold. ` +
    `Costs no time at all.`,
};
