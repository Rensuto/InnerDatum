// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/skills/fog_step.json
//          (ap_cost 4, mp_cost 1, range 3, target_shape single)
// SHAPE:   t-engine4 game/modules/tome/data/talents/techniques/mobility.lua:40-62
//          (Disengage: `cooldown = 10`, `range = 7`,
//           `getDist = combatTalentLimit(t, 10, 3, 7)` — it MOVES YOU, and it
//           is the archer's answer to being closed on)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOG STEP — THE ANSWER TO SOMETHING STANDING ON TOP OF YOU.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Vanish into Alderbrook's perpetual fog, close distance, and strike before
 * your shadow catches up."
 *
 * The Inspector cannot shoot inside three tiles (game-design.md § 2). That is
 * the class, and a class defined by a hole in its range needs exactly one
 * button that works INSIDE the hole, or the hole is not a trade-off — it is a
 * bug the player experiences as "my character is broken".
 *
 * So this is the only Inspector talent with `minRange: 0`, and that zero is the
 * most load-bearing number in the file. Everything else is negotiable.
 *
 * ═══ IT DOES NOT DEAL DAMAGE, AND THAT IS A DELIBERATE CUT ═══
 * The authored skill carries `damage_multiplier: 1.2`. It is dropped. A button
 * that both repositions and attacks needs two targets (where do I go, and what
 * do I hit) and the M3 targeting UI has one; more importantly, an escape that
 * also does damage is never used as an escape — it becomes a third attack with
 * a movement rider, and the dead zone stops having an answer again. ToME's
 * Disengage does no damage either, for the same reason.
 *
 * ═══ IT WALKS, IT DOES NOT TELEPORT ═══
 * `stepToward` goes through `world.tryMove`, which world.ts declares is "the
 * ONLY thing in the process allowed to change a position" so that terrain,
 * occupancy and the corner-cutting rule live in one place. With LOS required on
 * the destination, the only board state where a walk and a blink differ is
 * around a pillar — a cheap price for not having a second position writer.
 *
 * A step that gets blocked partway is NOT a refusal: you moved as far as the
 * fog allowed, and the log says how far. A step that cannot start at all is,
 * and costs nothing.
 */

import { DamageType } from '../engine/damage.ts';
import {
  Affinity,
  ClassId,
  TalentRefusal,
  TargetShape,
  stepToward,
  talentId,
  talentDone,
  talentRefused,
  tomeCooldownToTurns,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

const AP_COST = 4;
const MP_COST = 1;
const RANGE = 3;
/** Disengage, mobility.lua:46 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;

export const fogStep: Talent = {
  id: talentId('fog_step'),
  name: 'Fog Step',
  classId: ClassId.Inspector,
  iconId: 'icon_active_fog_step',
  cost: { ap: AP_COST, mp: MP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Tile,
    range: RANGE,
    // ═══ ZERO. THE ESCAPE MUST WORK INSIDE THE DEAD ZONE. ═══
    minRange: 0,
    requiresLos: true,
    affinity: Affinity.Any,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const from = { x: self.x, y: self.y };
    const moved = stepToward(ctx.world, self, target, RANGE);
    if (moved === 0) return talentRefused(TalentRefusal.Blocked);

    // Focus is fed by holding still (engine/talents.ts's `regenResource`), so a
    // step has to say so or the Inspector would bank Focus while running.
    const sheet = ctx.engine.sheetOf(self.id);
    if (sheet !== undefined) sheet.movedThisTurn = true;

    return talentDone(
      [],
      [`${self.name} steps into the fog: (${from.x},${from.y}) to (${self.x},${self.y}).`],
    );
  },

  describe: () =>
    `Move up to ${RANGE} tiles to a visible free tile. Works at any distance — ` +
    `it is how you leave a dead zone. ${AP_COST} AP, ${MP_COST} MP.`,
};
