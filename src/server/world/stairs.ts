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
import { INFINITY_TOWER_SITE_ID } from '../../shared/level.ts';
// THE TOWER'S CHAIN, for the one stair that says where it goes. `src/shared/`
// is a leaf to the server, so this keeps the file acyclic exactly as before.
import { towerFloorAt } from '../../shared/mapgen/tower.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE STAIR DOWN IS CALLED — and, for one place, WHERE IT GOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * *"Next level"* is upstream's own name for its DOWN grid
 * (`data/general/grids/basic.lua:47`) and it is the right label for a delve
 * three floors deep, where the next level is the same place one floor further
 * in.
 *
 * THE INFINITY TOWER IS THE ONE PLACE WHERE THAT IS THE LEAST INTERESTING TRUE
 * THING ABOUT THE STAIR. Its ways on are a choice of terrain and upstream
 * writes the destination's own words on them
 * (`data/zones/infinite-dungeon/zone.lua:312`):
 *
 *     ("\nEncroaching terrain:\n%s%s"):format(
 *         ae.grids.desc or "indistinct",
 *         ae.layout.desc or "continuation of the Infinite Dungeon")
 *
 * — which is the whole reason `TowerExit` carries a `desc` — and the stair is
 * already DRAWN in the destination's floor code (`:246`), so the map was
 * telling the player something the label contradicted.
 *
 * ═══ THE COMPOSED `desc` IS UPSTREAM'S; THE RENDERING IS OURS, AND SAYS SO ═══
 * Quoted in full above because the earlier note paraphrased it as
 * `"Encroaching terrain: "..grids.desc..layout.desc` — a space where upstream
 * has two newlines, a label where upstream has a tooltip on the exit grid, and
 * no mention of the two `or` fallbacks. `grids.desc .. layout.desc` is exact
 * and is what `TowerExit.desc` carries; *"Down, into …"* is honestly ours. The
 * fallbacks are unreachable here because every one of the seventeen grid sets
 * and all eight layouts names a `desc`.
 *
 * ═══ HERE RATHER THAN IN THE GATEWAY, WHERE IT WAS WRITTEN FIRST ═══
 * It is a fact about a `Realm`'s stair, exactly as `stairsDownOf` above is, and
 * `markersFor` is a two-hundred-line closure over a live socket registry that
 * nothing can call from a test. Same rule, same file, and now a function
 * somebody can ask.
 *
 * ═══ NO WIRE CHANGE ═══
 * `SiteView.name` is prose on the wire already, so this costs no protocol
 * change and no `PROTOCOL_VERSION` bump.
 */
export function stairDownName(realm: Realm): string {
  if (realm.siteId !== INFINITY_TOWER_SITE_ID || realm.floor === undefined) return 'Next level';
  return `Down, into ${towerFloorAt(realm.floor).exits[0].desc}`;
}
