// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Game.lua:1322-1335 (off every body, then the level's list on)
//             t-engine4 game/modules/tome/class/Actor.lua:7263-7267 (and on each body added later)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              A PLACE'S AURAS, ON EVERY BODY STANDING IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/effects.ts` holds the rule for one body (`applyZoneEffects`,
 * `stripZoneEffects`). This is the rule for a WORLD, and it lives here because
 * two things it needs are not the engine's to hold: every body in the world,
 * and the item catalogue a sheet is rebuilt with.
 *
 * ═══ WHO CALLS IT, AND WHY THOSE ARE ALL THE WAYS A BODY GETS IN ═══
 * Upstream lays the list on every entity when a level is entered
 * (tome/class/Game.lua:1329-1335) and on each body added after that
 * (tome/class/Actor.lua:7263-7267). Bodies reach a realm here in these ways,
 * and each one calls this:
 *
 *   - its population, at `Realms.open`, right after `site.populate`;
 *   - a wipe's re-seed, which re-mints that population (`World.reseedFloor`);
 *   - a player crossing in, from `crossIntoRealm` and `leaveRealm`, which lays
 *     the list on EVERY body — the newcomer and, idempotently, the rest, which
 *     is what reaches the townsfolk of a shared realm that has no `populate`;
 *   - a player's `hello`, placed or resumed, once their file is on the body.
 *
 * Nothing else adds a body mid-fight yet: no talent summons, no escorts.
 *
 * And the way out is `carryAcross`, which strips a crosser before its sheet is
 * rebuilt. A body left behind in a realm keeps what that realm gave it.
 *
 * ═══ THE SHEET IS REBUILT PER AURA, NOT ONCE AT THE END ═══
 * An aura's `activate` reads the body's sheet — `-math.ceil(self:combatArmor()
 * * 0.1)` — and upstream's `effectTemporaryValue` changes that sheet before the
 * next aura's `activate` runs. So `sheetDirty` recomposes as each one lands, and
 * two auras on one body read the sheet in the order upstream does.
 */

import { resolveItem } from '../content/resolve.ts';
import { applyZoneEffects, recomposeCombat } from '../engine/effects.ts';
import type { EffectState } from '../engine/effects.ts';
import type { World } from './world.ts';

/**
 * Lay `effectIds` on every body in `world` that does not already carry them,
 * rebuilding each sheet an aura lands on. Returns how many landed, in total.
 *
 * A no-op for a server with no status table, and for a place with no list.
 * Draws nothing: an aura rolls no save and `canBe` resolves at 100%, so the
 * world's rng is handed in only because `setEffect` takes one.
 */
export function applyZoneEffectsIn(
  world: World,
  effectIds: readonly string[],
  state: EffectState | undefined,
): number {
  if (state === undefined || effectIds.length === 0) return 0;
  let landed = 0;
  for (const body of world.allActors()) {
    landed += applyZoneEffects(state, body, effectIds, world.rng, {
      sheetDirty: (): void => {
        recomposeCombat(body, state, resolveItem);
      },
    }).length;
  }
  return landed;
}
