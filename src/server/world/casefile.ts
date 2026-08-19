// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Authored for this game.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              THE CASE FILE — WHAT THIS CHARACTER HAS FINISHED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This game had no memory of anything a player did. Level and gold were the
 * whole record. Twenty-odd destinations, a danger gradient across them, two
 * landmasses — and clearing the Drowned Chapel left no trace whatsoever, so the
 * only answer to *"what should I do now"* was to look at a map of markers that
 * all looked identical whether you had been into them or not.
 *
 * ═══ IT IS THE ONE MECHANIC THIS GAME WAS ALREADY NAMED AFTER ═══
 * The log is a CASE LOG. Its lanes are `Record` and `Margin`. Its panels are
 * drawn on `PanelSkin.CaseFile`. A monster you kill is *unfiled*. The fiction
 * has been that of an investigator working cases since before there was a
 * second map to work them on, and the one thing an investigator's case file
 * does — say which cases are closed — was the thing it did not do.
 *
 * ═══ AND IT IS THE STRONGEST RETENTION MECHANIC IN THE GENRE, FOR FREE ═══
 * No new art, no new panel, no quest state machine, no objective text anybody
 * has to write per site. A set of ids per character, and the map draws them
 * differently. What it buys is a REASON for the twenty-odd sites to be twenty
 * different places rather than twenty doors to the same fight: a gap in the
 * file is a thing a player can decide to go and close.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS, AND WHY IT IS NOT "EVERY SITE"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A TOWN CANNOT BE FILED. `createRealms` asserts that nothing hostile ever
 * spawns in a shared space, so a settlement has no residents to clear and would
 * be filed by the act of walking in. A file where five of the entries close
 * themselves is a progress bar that starts at 23%.
 *
 * AN AMBUSH CANNOT BE FILED EITHER, and that one is worth stating: `ENCOUNTER_
 * SITE` is deliberately NOT in `SITES` — *"every entry there is a cell somebody
 * authored on the map, and this one is a roll"*. It has no cell, it happens
 * wherever you were standing, and there are unboundedly many of them. Filing
 * rolls would make the denominator meaningless and the file unfinishable.
 *
 * THE DOOR TO THE OTHER MAP CANNOT BE FILED. It is a crossing, not a room —
 * the same reason it carries no danger grade. You do not clear a coastline.
 *
 * What is left is exactly the set a player would call *destinations*: the rooms
 * that were authored onto a map and have something in them.
 */

import { RealmKind } from './realms.ts';
import type { SiteDef } from './realms.ts';

/**
 * Can this site ever appear in a case file?
 *
 * `Inner` AND AUTHORED, which is two questions that happen to have one answer
 * today and will not always: `SiteDef.kind` says whether a party can be hurt in
 * it, and membership of the table it came from says whether it is a PLACE. The
 * caller supplies the second by only ever passing sites out of `SITES`.
 */
export function isFileable(site: SiteDef): boolean {
  return site.kind === RealmKind.Inner;
}

/**
 * How many entries a complete file has.
 *
 * COUNTED FROM THE REGISTRY RATHER THAN WRITTEN DOWN. The number is shown to
 * the player — *"filed 3 of 17"* — so a literal here would become a lie the
 * first time anybody adds a door, and it would be a lie about the size of the
 * game rather than about an implementation detail.
 */
export function fileableCount(sites: ReadonlyMap<string, SiteDef>): number {
  let n = 0;
  for (const site of sites.values()) if (isFileable(site)) n += 1;
  return n;
}

/**
 * The ids in `filed` that this build still recognises, in registry order.
 *
 * ═══ A SAVE CAN NAME A PLACE THIS BUILD DOES NOT HAVE ═══
 * A character filed under an older content set carries ids that may have been
 * renamed or removed. Dropping them is the only honest answer — the alternative
 * is a counter reading *"filed 18 of 17"*, which tells a player their file is
 * corrupt in the one place they look to feel like they are making progress.
 *
 * REGISTRY ORDER, NOT SAVE ORDER, so the same file renders identically for two
 * players who closed the same cases in a different sequence.
 */
export function knownFiled(
  filed: Iterable<string>,
  sites: ReadonlyMap<string, SiteDef>,
): readonly string[] {
  const wanted = new Set(filed);
  const out: string[] = [];
  for (const [id, site] of sites) {
    if (isFileable(site) && wanted.has(id)) out.push(id);
  }
  return out;
}
