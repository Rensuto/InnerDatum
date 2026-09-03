// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/class/interface/ActorInscriptions.lua:26-32
//              (`self.inscriptions`, `max_inscriptions = 3` — a slot group ON THE ACTOR)
//   t-engine4 game/modules/tome/data/birth/races/human.lua:55
//              (every character is born carrying one healing infusion)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INSCRIPTIONS — what is written ON a body, and the talents that come with it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ AN INSCRIPTION IS NOT AN ITEM, AND ASSUMING IT WAS COST A WHOLE DESIGN ═══
 * `ActorInscriptions.lua` keeps `self.inscriptions` as its own table with its own
 * cap (`max_inscriptions = 3`) and never touches `INVEN_INVEN`. Upstream hands
 * you a SCROLL and inscribing consumes it into a slot; what you carry afterwards
 * is not an object, it is a fact about you.
 *
 * That distinction is why this file can exist at all. An `Item` needs a unique
 * icon out of `KNOWN_ICON_IDS`, every entry of which is claimed, and the
 * catalogue refuses a declared-but-undrawn one because it would put a violet box
 * in front of whoever is playing tonight. A fact about a body needs no picture —
 * and the TALENT it grants falls back to a drawn letter, which `Talent.iconId`
 * states is the practice thirty talents already follow.
 *
 * ═══ THE SHAPE IS `knownLore`'s ═══
 * A list of ids on the actor, resolved through this table. `85082a2` established
 * it for case notes and it holds here: the world stores ids, the content module
 * owns what they mean, and nothing in between learns a second kind of thing.
 */

import { healingInfusion } from '../talents/healing_infusion.ts';
import type { Talent } from '../engine/talents.ts';

/**
 * HOW MANY MAY BE WRITTEN ON ONE BODY — `max_inscriptions = 3`
 * (ActorInscriptions.lua:29), ported verbatim.
 *
 * NOT ENFORCED YET, and declared before it is on purpose: there is one
 * inscription in the game, so a cap of three is a rule nobody can reach. It
 * lives here rather than at a future enforcement site so that the day a second
 * exists the number is already upstream's rather than something re-derived.
 */
export const MAX_INSCRIPTIONS = 3;

export type Inscription = {
  /** Stable, and the id an actor's `inscriptions` list holds. */
  readonly id: string;
  readonly name: string;
  /**
   * THE TALENT IT PUTS ON YOUR BAR while it is written on you.
   *
   * ONE TALENT, NOT A LIST: upstream's `setInscription` grants exactly
   * `T_<name>_1` per inscription, and a list would be a shape nothing upstream
   * has and nothing here needs.
   */
  readonly grants: Talent;
};

/**
 * EVERY INSCRIPTION THAT SHIPS. Frozen and ordered, as `LORE` is.
 *
 * ONE, AND NO SLOT MACHINERY AROUND IT. `setInscription`'s two-of-a-kind cap,
 * the swap screen and the three slots are worth having when there is a shelf to
 * choose from; with one entry they would be a menu whose answer never changes.
 * CLAUDE.md's *"do not write documents for systems that do not exist"* is the
 * same rule pointed at code.
 */
export const INSCRIPTIONS: readonly Inscription[] = Object.freeze([
  { id: 'inscription_healing_infusion', name: 'Healing Infusion', grants: healingInfusion },
]);

/** The talents inscriptions can put on a bar. One derivation, never a second list. */
export const INSCRIPTION_TALENTS: readonly Talent[] = Object.freeze(
  INSCRIPTIONS.map((entry) => entry.grants),
);

const BY_ID = new Map<string, Inscription>(INSCRIPTIONS.map((entry) => [entry.id, entry]));

export function inscriptionById(id: string): Inscription | undefined {
  return BY_ID.get(id);
}

/**
 * WHAT A NEW CHARACTER IS BORN WITH — `human.lua:55`.
 *
 * Every character, with no class variation, because upstream puts it on the RACE
 * and we have one kind of person.
 */
export const BIRTH_INSCRIPTIONS: readonly string[] = Object.freeze([
  'inscription_healing_infusion',
]);

/**
 * The talents these ids grant, in `INSCRIPTIONS` order, skipping any this build
 * no longer ships.
 *
 * SKIPS RATHER THAN THROWS, which is `loreById`'s contract and for its reason: a
 * character saved by a build with an inscription this one lacks comes back
 * carrying its id, and a bar without that button is a better answer than a body
 * that cannot load.
 */
export function talentsFor(inscribed: readonly string[]): readonly Talent[] {
  const held = new Set(inscribed);
  return INSCRIPTIONS.filter((entry) => held.has(entry.id)).map((entry) => entry.grants);
}
