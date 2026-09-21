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
 * `20 + ceil(9 * ln(lev))` percent from floor 3 (`GameState.lua:2561-2564`) and
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
 * return` (`GameState.lua:2564`). THE LINE NUMBER WAS 2562 AND 2562 IS THE
 * function's `id_challenge` initialiser — a citation one clause early, of the
 * kind `check:citations` cannot catch because the line exists.
 *
 * ═══ AND NEVER IN A TOWN ═══
 * `world/realms.ts` refuses a `Common` site that carries any of these, beside
 * the identical refusal for `populate` and for a sharper version of its reason:
 * a delve floor holds ONE party of at most four, so an objective is offered to
 * people who chose to play together. A town is shared by everybody standing in
 * it and has no party for an objective to belong to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ═══ AND NOT IN THE INFINITY TOWER EITHER, WHICH IS A DECISION AND NOT AN
 *     OMISSION — BECAUSE THE TOWER IS WHERE UPSTREAM PUTS ITS OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stated here rather than only in the site, because this is the file a reader
 * would check, and because the Tower is precisely the place the paragraph above
 * describes: ToME rolls its challenges in the Infinite Dungeon and nowhere else
 * (`tome/class/GameState.lua:2561-2589`, eight of them on a rarity table). Now
 * that the Tower exists here, the absence has to be argued rather than assumed.
 *
 * ═══ THE MACHINERY WOULD WORK TODAY, UNCHANGED ═══
 * Checked rather than guessed. `BriefSpec.floors` is an inclusive `[lo, hi]`
 * and `armBrief` takes the first match, so `floors: [3, 1000000000]` would arm
 * from floor 3 up — which is upstream's own `if lev < 3 then return`
 * (`GameState.lua:2564`) — and `Realm.granted` is per instance, so no floor
 * could mint twice. Nothing in `world/brief.ts` needs a line for this.
 *
 * ═══ WHAT IS MISSING IS THE MEASUREMENT, AND THAT IS THE WHOLE REASON ═══
 * `content/delve.ts` records that *"every number in `DELVES` was authored and
 * measured"*, and every brief above is written against a floor whose population
 * and clear time somebody watched. NO TOWER FLOOR HAS BEEN MEASURED: its floors
 * are 60 to 90 a side against the moor's 34x30, its bodies grow at 1.2 levels
 * per floor without limit (`DelveSpec.depthScale`), and its count is a function
 * of an area that is itself rolled. An objective with a timer, a body count or
 * a survival clause on a floor nobody has timed is not an objective, it is a
 * number somebody typed.
 *
 * SO THE TOWER SHIPS WITH NONE, AND THEREFORE WITH NO TEMPORARY COMPANION
 * EITHER — a companion arrives with a brief (`world/brief.ts`), so this one
 * decision answers both. The first Tower brief should be authored the day
 * somebody has run the staged-fight probe on a Tower floor, and it should use
 * the roll that is already quoted above rather than an authored floor number,
 * because a place with no bottom has no floor 2 to put a set piece on.
 */

import { ActorRank } from '../../shared/protocol.ts';
import { BriefKind } from '../world/brief.ts';
import { FIELD_FOLK } from './townsfolk.ts';
import { STRANDED_HAND } from './monsters.ts';

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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND ONE FLOOR DOWN, SOMEBODY WHO WANTS TO LEAVE WITH YOU.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ FLOOR 3, WHICH IS THE LAST ONE, AND THAT IS WHAT MAKES IT THE WAY OUT ═══
   * `world/brief.ts#targetFor` resolves a `leaves` escort to the stair down
   * where there is one and otherwise to the tile the party came in on — and
   * `world/realms.ts` already establishes that on a last floor that tile IS
   * *"the door you leave by"*. So the objective is literally *walk this person
   * back to the surface*, and the destination needs no new terrain, no new
   * glyph and nothing authored: the floor already knows where its own door is.
   *
   * ═══ THE SAME DELVE AS THE QUARRY, AND ONE FLOOR APART ═══
   * A party meeting its first objective on floor 2 and its second on floor 3
   * meets both configurations of this feature inside one delve, on a roster
   * that has been measured, before anything deeper. `world/brief.ts` allows one
   * objective per FLOOR, so the two never overlap and neither is a second
   * concurrent thing to track.
   *
   * ═══ IT PAYS EXPERIENCE AND NOTHING ELSE, AND THE OFFER SAYS SO ═══
   * `reward.item` is absent, which `content/chats.ts` already has a line for —
   * *"I have nothing to give you but the quiet."* — and it is the honest one
   * here: she came down with a crew and is walking out with what is left of
   * her own kit. The Quarry one floor above pays the lamp; two lamps in one
   * delve would be the payout that stopped meaning anything.
   */
  {
    id: 'underworks:one-still-walking',
    kind: BriefKind.Escort,
    floors: [3, 3],
    title: 'The way back, with her',
    detail: 'One of the crew that came down here is still on her feet, and wants the surface.',
    reward: { level: 3, rank: ActorRank.Elite },
    offerer: offerer('callow'),
    escort: { after: 'leaves', body: STRANDED_HAND },
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
