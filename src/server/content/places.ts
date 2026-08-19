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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THREE NOBODY IS TOLD ABOUT — AND THEY WERE THE ONLY SITES WITH NO LINE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Measured: twenty of twenty-three sites carried a blurb and the three
   * missing were exactly the three `hidden` ones. So the hardest discovery in
   * the game — a marker that appears on your map only because you walked
   * somewhere nobody sent you — arrived in silence, while every signposted town
   * had a sentence waiting.
   *
   * Each names what it is rather than how it feels, because a player who has
   * just found one of these already has the feeling.
   */
  [
    'site:cairnfoot',
    'Steps cut into the hill under a cairn nobody has added to in a long time. They go down further than the hill is tall.',
  ],
  [
    'site:barrow_end',
    'The last barrow in a row of them, and the only one still closed. Whoever dug the others stopped here.',
  ],
  [
    'site:the_weir',
    'Somebody built a weir in a wood with no river. It is still holding something back.',
  ],

  // ─── the other map ──────────────────────────────────────────────────────
  //     One sentence for the landmass and one for each door that survived on
  //     it. THE NAMES ARE THE SAME NAMES on purpose (shared/redaction.ts argues
  //     it at length: recognising where you are is the whole point of that
  //     map), so the blurb is the only thing on screen that can tell a player
  //     which Underworks they just walked into. It is doing more work here than
  //     anywhere else in this table, and each one is written to answer the same
  //     question: what is different about this one.
  [
    'site:redaction',
    'The same moor, and a sixth of it simply not there. The road gives out after a few hundred yards and does not start again.',
  ],
  [
    'site:redaction:threadneedle_row',
    'The shopfronts are intact and the doors are open. Nobody came out of any of them.',
  ],
  [
    'site:redaction:watchers_altar',
    'Whoever was leaving things here never stopped. The pile has been added to since the country ended.',
  ],
  [
    'site:redaction:underworks',
    'The shafts go down into a map that no longer has a surface above them.',
  ],
  [
    'site:redaction:drowned_chapel',
    'The tide still comes in. There is nothing left for it to reach.',
  ],
  ['site:redaction:cairnfoot', 'The stones are still standing. That is all that is.'],
  [
    'site:redaction:barrow_end',
    'The trees came through untouched, which is the part nobody has an answer for.',
  ],
  /**
   * THE ONE HIDDEN ROOM WITH NOTHING TO SAY, and it went unnoticed because
   * nothing on the Alderbrook side was missing. The room below it on that map
   * has a line; its mirror never did, so the hardest place in the game to find
   * rewarded finding it with silence.
   */
  ['site:redaction:the_weir', 'The weir is still holding. There is no river left to hold.'],

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
