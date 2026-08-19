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

import { combatTalentLimit } from '../../shared/scale.ts';
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
  TalentKind,
} from '../engine/talents.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * FROZEN. 4 AP plus 1 MP is a whole round minus a step: escaping costs you the
 * turn you would have shot in, which is what stops the escape from being an
 * opener. A rank that made it cheaper would make it the first button pressed.
 */
const AP_COST = 4;
const MP_COST = 1;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY TALENT IN THE TWELVE WHOSE LEVEL BUYS DISTANCE INSTEAD OF DAMAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Fog Step deals no damage at all — that cut is argued in the header — so its
 * range is the only number it has. A rank that moved nothing here would be
 * exactly the lie the panel must not tell.
 *
 * PORTED HIGH: mobility.lua:40-62. Disengage's own distance is
 * `getDist = combatTalentLimit(t, 10, 3, 7)` — this file's `SHAPE:` header has
 * cited that call, endpoints and all, since it shipped. So both ends are
 * upstream's and so is the CURVE: 3 at level 1, 7 at level 5, asymptotic to 10.
 *
 * `combatTalentLimit` is used rather than `combatTalentScale` for the same
 * reason upstream does: a distance approaching a ceiling, not a linear-ish fit.
 * Raw it gives 3, 4.75, 5.8, 6.5, 7; FLOORED it gives 3, 4, 5, 6, 7 — one tile
 * per rank, monotone, with no dead rank in the middle. The floor is what makes
 * every point visibly worth something; without it ranks 2 and 3 both round to
 * "about five tiles" in play and the second one feels stolen.
 *
 * `RANGE_LOW` is also the static `targeting.range`, so a caller that never
 * resolves the level (there are none in the server, but the wire's
 * `LoadoutTalent.range` had exactly this shape before P6) reads the level-1
 * number rather than a sentinel.
 */
const RANGE_LIMIT = 10;
const RANGE_LOW = 3;
const RANGE_HIGH = 7;

/**
 * Tiles this Inspector can step, at this rank. Whole tiles — a fractional
 * range would let `stepToward` walk a step the targeting ring did not offer.
 *
 * THE ONE PLACE THIS IS COMPUTED. `targeting.rangeAt` hands it to
 * `canUseTalent` (which refuses OutOfRange against it), `onUse` walks it, and
 * `describe` prints it, so the ring the client draws, the tile the server
 * accepts and the distance actually walked cannot disagree.
 */
function stepRange(talentLevel: number): number {
  return Math.floor(combatTalentLimit(talentLevel, RANGE_LIMIT, RANGE_LOW, RANGE_HIGH));
}

/** Disengage, mobility.lua:46 — `cooldown = 10` ToME actions. */
const TOME_COOLDOWN = 10;

export const fogStep: Talent = {
  id: talentId('fog_step'),
  name: 'Fog Step',
  classId: ClassId.Inspector,
  tree: 'index/fieldcraft',
  kind: TalentKind.Active,
  iconId: 'icon_active_fog_step',
  cost: { ap: AP_COST, mp: MP_COST },
  cooldownTurns: tomeCooldownToTurns(TOME_COOLDOWN),
  targeting: {
    shape: TargetShape.Tile,
    range: RANGE_LOW,
    // …and the level-1 range above is a FLOOR, not the answer: `rangeAt` is what
    // `canUseTalent` and the projector actually resolve. See `stepRange`.
    rangeAt: stepRange,
    // ═══ ZERO. THE ESCAPE MUST WORK INSIDE THE DEAD ZONE. ═══
    minRange: 0,
    requiresLos: true,
    affinity: Affinity.Any,
  },
  damageType: DamageType.Physical,

  onUse: (ctx, self, target) => {
    const from = { x: self.x, y: self.y };
    const moved = stepToward(ctx.world, self, target, stepRange(ctx.talentLevel));
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

  describe: (_self, level) =>
    `Move up to ${stepRange(level)} tiles to a visible free tile. Works at any distance — ` +
    `it is how you leave a dead zone. ${AP_COST} AP, ${MP_COST} MP.`,
};
