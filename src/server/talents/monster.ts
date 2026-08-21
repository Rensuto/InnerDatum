// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE:   t-engine4 game/modules/tome/data/talents/misc/npcs.lua — the talents
//          that belong to creatures rather than to a class, and are priced
//          against a body that has no resource pool to spend.
// NUMBERS: authored.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE MONSTER ROSTER'S OWN TALENTS. The first things a creature can DO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Monsters could not use talents at all — not "had none authored", COULD NOT.
 * `canUseTalent` needs a sheet, `engine.attach` had two call sites and both
 * were the player path, and `decideNpcAction` never constructed a talent intent
 * in the first place. Nine creatures across two AI profiles, able only to move
 * and bump-attack, in a game shipping 84 talents.
 *
 * ═══ WHY THESE ARE NOT PLAYER TALENTS ═══
 * Nothing stops a template naming one and it would mostly work. But a husk
 * casting the Watchman's Ward Rush is a husk wearing somebody's profession, and
 * every number in a player talent was tuned against a resource pool the
 * creature does not have.
 *
 * ═══ PRICED IN COOLDOWN AND AP, NEVER IN A RESOURCE ═══
 * A creature's sheet is given six action points and no class resource worth the
 * name, because NOTHING IN THE GAME REFILLS A MONSTER'S POOL. A talent priced
 * in Resolve would fire once per creature per lifetime and then look broken.
 * Cooldowns tick for everybody — `actBase` runs for every resolved actor with
 * no player filter — so a cooldown is a price a monster can actually pay.
 *
 * ═══ AND THE COSTS MEAN THE SAME THING ON BOTH SIDES OF A FIGHT ═══
 * Six AP is a player's round too, so "two of its six" is a sentence with one
 * meaning. A separate creature budget would make every number here a figure
 * with no referent.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MARKS A TALENT AS THE BESTIARY'S. The tree prefix, and it is a REAL
 * discriminator rather than a naming convention.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A monster talent is in the registry — `talents.use` resolves it through
 * there — and in nothing else. It has no tier, because nobody ranks it up. It
 * has no entry in `TALENT_TREES`, because no panel ever draws it. It is on no
 * class's loadout, because no player can learn it.
 *
 * Every one of those is correct and every one of them breaks a test that was
 * written when `registry.all()` meant 'every talent a player can reach' —
 * which it did, until this file. The prefix is how those tests tell the two
 * populations apart, and it is exported so they ask rather than hard-code a
 * string that would drift.
 */
export const MONSTER_TREE_PREFIX = 'monster/';

/** True for a talent that belongs to the bestiary and to no player. */
export function isMonsterTalent(talent: { readonly tree: string }): boolean {
  return talent.tree.startsWith(MONSTER_TREE_PREFIX);
}

import { breachingBlow } from './breaching_blow.ts';
import { clearTheAltar } from './clear_the_altar.ts';
import { efface } from './efface.ts';
import { rush } from './rush.ts';
import { uncorroborated } from './uncorroborated.ts';
import { graspingHold } from './grasping_hold.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * THE SCALING CURVE EVERY CREATURE TALENT USES.
 *
 * `combatTalentScale`'s fourth argument, shared from here so the three talent
 * files cannot drift into three different curves. A creature's abilities should
 * all sharpen at the same rate; nothing in the fiction distinguishes them.
 */
export const MONSTER_CURVE = 0.75;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TALENT THE BESTIARY OWNS. The registry is built from this.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ ONE TALENT PER FILE, WHICH IS A PROJECT RULE AND NOT A PREFERENCE ═══
 * These three lived in this one file for an afternoon and it broke something
 * immediately. `tools/art-needs.mjs` reads a talent module WHOLE, because a
 * talent module is one talent and its `iconId` and its `describe` sit further
 * apart than any window would span:
 *
 *     const perFile = rel.includes('/talents/') …
 *     const window  = perFile ? text : text.slice(…)
 *
 * Three talents in one file meant it took the FIRST name it found, and briefed
 * every icon in the file to the artist as "Grasping Hold". The art for this
 * project is drawn by hand from those briefs, so that is a wrongly drawn icon
 * rather than a cosmetic slip in a tool.
 *
 * The tool was right and the file was wrong. Splitting fixed the briefs with no
 * change to the tool at all.
 */
export const MONSTER_TALENTS: readonly Talent[] = Object.freeze([
  graspingHold,
  breachingBlow,
  efface,
  uncorroborated,
  rush,
  clearTheAltar,
]);
