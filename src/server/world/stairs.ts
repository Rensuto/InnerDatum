// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              WHERE A FLOOR'S STAIR DOWN IS. THAT IS THE WHOLE FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ A LEAF, AND THAT IS WHY IT IS ITS OWN FILE ═══
 * This lived in `world/realms.ts` beside the registry that builds the maps, and
 * it is not a fact about the registry at all: it is a one-line read of
 * `Realm.sites`, which is a plain map on an object the caller already holds.
 *
 * It moved because `world/brief.ts` needs it, and the registry imports
 * `content/briefs.ts` to give a site its authored objectives — so
 * `brief.ts -> realms.ts -> briefs.ts -> brief.ts` is a cycle, and an ES module
 * cycle does not fail: it hands whichever module starts second a HALF-BUILT
 * namespace, so a `const` read during evaluation is `undefined` and the failure
 * is a `TypeError` from a file that looks innocent, in whatever order the entry
 * point happened to reach them. Measured, exactly once: `BriefKind.Quarry` read
 * as `undefined` in one test file and worked in every other.
 *
 * So the shared half is a leaf. It imports the `Realm` TYPE and nothing else,
 * and a type import erases — which means this module cannot participate in a
 * cycle no matter who reaches for it next. `world/realms.ts` re-exports both
 * names so every existing caller keeps its import unchanged.
 */

import type { TileXY } from '../../shared/coords.ts';
import type { Realm } from './realms.ts';

/**
 * THE SITE ID A STAIR DOWN IS FILED UNDER in a floor's `sites`. Not a site in
 * `SITES`: walking onto it takes the party's next floor of the site they are in.
 * Upstream's DOWN grid (data/general/grids/basic.lua:44-52).
 */
export const STAIRS_DOWN_SITE_ID = 'stairs:down';

/** Where a floor's stair down is, or null on a floor with none. */
export function stairsDownOf(realm: Realm): TileXY | null {
  for (const [cell, siteId] of realm.sites) {
    if (siteId !== STAIRS_DOWN_SITE_ID) continue;
    const [x, y] = cell.split(',');
    return { x: Number(x), y: Number(y) };
  }
  return null;
}
