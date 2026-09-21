// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/modules/tome/class/GameState.lua:2692-2705 — the exterminate challenge
//        t-engine4 game/modules/tome/class/GameState.lua:2698 — marked at grant time, and why
//        t-engine4 game/modules/tome/class/Player.lua:117-138 — which floors carry one
//        t-engine4 game/modules/tome/class/GameState.lua:2928 — the offer states what it pays
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE OBJECTIVES A FLOOR MAY OFFER — AUTHORED, AND NOT ROLLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `world/brief.ts` is the live object and its rules; this is the content it is
 * built from, and it is in `content/` because it names a person, a reward and
 * three sentences somebody wrote.
 *
 * ═══ AUTHORED, WITH THE ROLL WRITTEN DOWN AND NOT BUILT ═══
 * Every roll is a floor whose difficulty nobody measured, and `content/delve.ts`
 * records that *"every number in `DELVES` was authored and measured"*. Upstream
 * brackets the rate it would take — the Infinite Dungeon's challenge is
 * `20 + ceil(9 * ln(lev))` percent from floor 3 (`GameState.lua:2561-2562`) and
 * the escort is nine floors drawn without replacement from twenty
 * (`Player.lua:117-138`) — so the number is known and the lane is not this one.
 * When it lands it belongs at realm BUILD and off `world.rng.fork('brief')`: a
 * new `rng.int` on that path would consume a position in the world's labelled
 * stream and shift every draw after it, which is every delve any player has
 * ever walked.
 *
 * ═══ ONE FLOOR, ONE SITE, AND NOWHERE ELSE ═══
 * `site:underworks` floor 2. It is the first real delve after waking
 * (`content/delve.ts`, `levelRange: [3, 3]`), which makes it the right place for
 * the first objective a player meets that is not the tutorial's — and floor 2 of
 * 3 rather than floor 1, because the first floor of anything is where a party
 * learns the room. Upstream draws the same line in one clause: `if lev < 3 ...
 * return` (`GameState.lua:2562`).
 *
 * ═══ AND NEVER IN A TOWN ═══
 * `world/realms.ts` refuses a `Common` site that carries any of these, beside
 * the identical refusal for `populate` and for a sharper version of its reason:
 * a delve floor holds ONE party of at most four, so an objective is offered to
 * people who chose to play together. A town is shared by everybody standing in
 * it and has no party for an objective to belong to.
 */

import { ActorRank } from '../../shared/protocol.ts';
import { BriefKind } from '../world/brief.ts';
import { FIELD_FOLK } from './townsfolk.ts';

import type { BriefSpec } from '../world/brief.ts';
import type { TownsfolkSpec } from './townsfolk.ts';

/**
 * The person a spec names, or a throw at module load.
 *
 * AT LOAD RATHER THAN AT ARM TIME. A brief whose offerer does not exist is a
 * floor that silently carries nothing: `armBrief` would have no body to stand
 * up, the objective would never be offered, and the only symptom would be a
 * delve that felt slightly emptier than it was written to be. This turns that
 * into a boot failure naming the id.
 */
function offerer(specId: string): TownsfolkSpec {
  const spec = FIELD_FOLK.get(specId);
  if (spec === undefined) {
    throw new Error(
      `briefs: no such person as '${specId}' — see FIELD_FOLK in content/townsfolk.ts`,
    );
  }
  return spec;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UNDERWORKS: ONE OF THEM KEPT ITS NAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT THE PLAYER READS, AND WHAT THEY NEVER READ ═══
 * `title` is what the strip carries for the length of the floor, so it is the
 * objective's own words and never a system word: "brief" is an engineering term
 * like Record and Margin and it does not reach the canvas. `detail` is one
 * sentence for the Case Log line on the accept.
 *
 * ═══ THE REWARD IS A NOTIONAL CORPSE, AND THAT IS WHAT MAKES IT RESCALE ═══
 * `level` and `rank` are fed to `worthExp` exactly as a kill is, so the payout
 * is denominated in the units of the fight it pays for and moves with the
 * floor's own curve without a second table to tune. `level: 3` is this delve's
 * own `levelRange`; `Elite` is one rank above the room. It also inherits
 * upstream's anti-farming floor for nothing (`tome/class/Actor.lua:6514`) — a
 * body far beneath you is worth nothing — which a bespoke reward number would
 * quietly not.
 *
 * ═══ AND AN ITEM, ON THE FLOOR ═══
 * An Alchemist's Lamp — `lite` 3, upstream's second lantern
 * (`data/general/objects/lites.lua:30-70`) and STRICTLY BETTER THAN THE ONE
 * EVERY CHARACTER IS BORN WITH (`BIRTH_KIT` is the brass lantern at `lite` 2).
 * The Underworks is an unlit cave (`SHAPE_LIGHTING`), light is what decides
 * what a party can see and therefore shoot, and a reward that duplicated the
 * birth kit would be a reward the player already had in their hand.
 *
 * PAID IN CAPABILITY RATHER THAN COIN, which is upstream's own shape for this
 * kind of objective — its escort pays stats, saves, talents and talent
 * categories and never gold. (`modules/tome/data/quests/` is ABSENT from this
 * checkout, so that is read off the design pass that rebuilt the escort from
 * its call sites rather than off a line anybody here can open.) It is dropped on the quarry's own tile at the
 * close and never into anybody's bag — this game's rule for material things is
 * first-come off the ground, and an item that always went to the lead would
 * make the lead a hoarder by construction.
 */
const UNDERWORKS_BRIEFS: readonly BriefSpec[] = [
  {
    id: 'underworks:kept-its-name',
    kind: BriefKind.Quarry,
    floors: [2, 2],
    title: 'It kept its name',
    detail: 'Something in the deep galleries still answers to what it was called.',
    reward: { level: 3, rank: ActorRank.Elite, item: 'item_alchemists_lamp' },
    offerer: offerer('pell'),
    quarry: {
      /**
       * THE NAME IS THE MARK ON THE MAP. A floor of husks with numbers for
       * names has one body in it that a hover card calls something, and that
       * is the whole of how a party tells which one it is — which is E.1's
       * rule stated as content: the map never tells you where it is, and the
       * body's own card confirms it once you can already see it.
       */
      name: 'Sallow Cordage',
      mark: 'THIS ONE KEPT ITS NAME',
    },
  },
];

/**
 * Who offers what, keyed by SITE id.
 *
 * KEYED BY SITE rather than by floor, because a site's list is what a `SiteDef`
 * carries onto every instance of it and `armBrief` asks which of them THIS
 * floor is in. That question has an answer only once a floor has been built.
 */
export const BRIEFS: ReadonlyMap<string, readonly BriefSpec[]> = new Map<
  string,
  readonly BriefSpec[]
>([['site:underworks', UNDERWORKS_BRIEFS]]);

/** Every objective authored for a site, or an empty list. */
export function briefsForSite(siteId: string | undefined): readonly BriefSpec[] {
  if (siteId === undefined) return [];
  return BRIEFS.get(siteId) ?? [];
}
