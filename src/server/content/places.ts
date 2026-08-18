// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Authored for this game. Nothing here is ported: T-Engine4's zone descriptions
// are its own writing and its own setting, and copying the SHAPE of a one-line
// room blurb is not the same as copying a line.

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *            WHAT A PLACE SAYS WHEN YOU FIRST STAND IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE SENTENCE PER PLACE, SAID ONCE, TO THE PERSON WHO ARRIVED.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 * Driving a real first session is what made the case. A stranger joined, got
 * thirteen frames of state, and was told NOTHING — not where they were, not
 * what the place was, not that the thirteen markers on their map were anywhere
 * worth walking to. The Case Log, which is the most valuable strip of text on
 * the screen, contained seven lines reading `Player 1 moves E.` and nothing
 * else.
 *
 * A map with thirteen named destinations and no writing anywhere is a map of
 * labels. One sentence at the threshold is what turns "site:hollow_mine" into
 * somewhere a player wants to see the inside of, and it is the cheapest
 * possible version of that: no new frame, no new panel, no art.
 *
 * ═══ ONE SENTENCE, AND THE DISCIPLINE IS THE POINT ═══
 * A paragraph printed every time somebody re-enters a town is something players
 * learn to scroll past — and the log is where the things they must NOT scroll
 * past live. So each of these is one line, in the game's own voice, and says
 * something a player could act on or be unsettled by rather than something
 * decorative.
 *
 * ═══ KEYED BY SITE, NOT BY REALM ═══
 * An instanced realm's id carries a party and a sequence number
 * (`realm:site:hollow_mine:7`), so a table keyed by realm id would match the
 * five towns and miss every delve — which is exactly the half where the writing
 * does the most work. Callers pass `realm.siteId ?? realm.id`.
 */
export const PLACE_BLURBS: ReadonlyMap<string, string> = new Map<string, string>([
  // ─── the open country ───────────────────────────────────────────────────
  [
    'realm:overworld',
    'Rain on the moor, and the road going somewhere. Things wander out here; you will see them before they see you.',
  ],

  // ─── the settlements: safe, and each one is for something ───────────────
  ['site:alderbrook', 'Gaslight and wet stone. Everyone passes through Alderbrook eventually.'],
  [
    'site:threadneedle_row',
    'Shutters up, lamps lit, and somebody behind every counter who will take your gold.',
  ],
  [
    'site:ashwick_row',
    'The air tastes of copper here. Alchemists work late and do not much like being watched.',
  ],
  ['site:wayfarers_camp', 'Canvas, a low fire, and people who were not going to stop but did.'],
  ['site:saints_rest', 'A quiet town with too many headstones for its size. Nobody mentions it.'],

  // ─── the places you go into on purpose ──────────────────────────────────
  [
    'site:blackwood_outskirts',
    'The trees start here and the road stops pretending it goes anywhere.',
  ],
  ['site:gearford_ward', 'Machinery still running with nobody left to run it. Mind the floor.'],
  ['site:underworks', 'Below the ward, below the water table, and still going down.'],
  [
    'site:glass_archive',
    'Shelves of records nobody filed, in a building nobody built. The Index keeps its own copies.',
  ],
  ['site:watchers_altar', 'Somebody has been leaving things here. Recently.'],
  ['site:hollow_mine', 'Cut for ore, abandoned for a reason the paperwork does not give.'],
  [
    'site:drowned_chapel',
    'The tide took the nave and left the arches. It is quieter than water should be.',
  ],
  ['site:outer_index', 'The edge of the Index, where the city stops agreeing with itself.'],

  // ─── the roaming encounter ──────────────────────────────────────────────
  ['site:encounter', 'It has your attention now. There is one way out and it is behind you.'],
]);

/**
 * The blurb for a realm, or undefined for one with nothing to say.
 *
 * `siteId` first: an instanced realm's own id carries a party and a sequence
 * number, so matching on it would find the five towns and miss every delve.
 */
export function blurbFor(realmId: string, siteId: string | undefined): string | undefined {
  return PLACE_BLURBS.get(siteId ?? realmId) ?? PLACE_BLURBS.get(realmId);
}
