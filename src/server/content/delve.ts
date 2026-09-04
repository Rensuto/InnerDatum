// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — every number below is ours) from
//   t-engine4 game/engines/default/engine/Zone.lua:700-760 (`addEntity` per level — a zone is
//              populated once, at generation, from its own roster and its own density)
//   t-engine4 game/modules/tome/data/zones/*/zone.lua (`generator.actor.nb_npc` — a per-zone
//              population band rather than one global number)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              WHAT IS ACTUALLY INSIDE THE EIGHT DELVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING WAS. That is the whole reason this file exists, and it was found by
 * asking the game rather than reading it:
 *
 *     The Hollow Mine       inner   34x30   monsters= 0   floor items=0
 *     The Drowned Chapel    inner   34x30   monsters= 0   floor items=0
 *     The Outer Index       inner   34x30   monsters= 0   floor items=0
 *
 * A player is told "Cut for ore, abandoned for a reason the paperwork does not
 * give", walks thirty tiles across a moor to get there, and finds an empty
 * room. Eight of them. Every named destination on the map was a door onto
 * nothing, and no amount of writing on the threshold survives that.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EIGHT PLACES, NOT ONE PLACE EIGHT TIMES
 * ═══════════════════════════════════════════════════════════════════════════
 * The temptation is one `populate` that scatters N monsters everywhere. That
 * would fill the rooms and leave the map exactly as flat as it is now: thirteen
 * markers that all mean "some husks". So a delve carries a SPEC — how crowded,
 * what lives there, how much is lying about — and the specs differ enough that
 * a party learns which doors are worth opening.
 *
 * ToME does the same thing and in the same place: `nb_npc` is a per-zone band,
 * not an engine constant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT ADJACENT TO THE DOOR, EVER
 * ═══════════════════════════════════════════════════════════════════════════
 * `seedAmbush` learned this the expensive way and the note is worth repeating:
 * being hit before the map has finished drawing is not tension, it is a bug
 * report. An ambush is *meant* to open at four tiles; a delve is somewhere you
 * walked into on purpose, so its population starts further out still and the
 * first screen is yours to read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEEDED, AND OFF THE WORLD'S OWN SPAWN STREAM
 * ═══════════════════════════════════════════════════════════════════════════
 * `populate` runs once, at generation, before anybody is in the room — so this
 * draws on `world.rng` at a moment no combat roll can be affected by, which is
 * the same argument `world.ts` already makes for splitting placement from play.
 * A delve is therefore reproducible from the realm that opened it, which is
 * what makes "the same party re-entering finds the room they left" true.
 */

import {
  INDEX_CAIRN,
  INDEX_EIDOLON,
  INDEX_HUSK,
  INDEX_HUSK_ELITE,
  INDEX_WRAITH,
  monsterInit,
  INDEX_WATCHER,
} from './monsters.ts';
import { ActorRank } from '../../shared/protocol.ts';
import { REDACTION_SITE_ID } from '../../shared/level.ts';
import { embellish } from './encounter.ts';
import { canWalk } from '../../shared/level.ts';
import { LORE, noteIdFor } from './lore.ts';
import { PROP_IDS } from '../../shared/props.ts';
import { rollDrop } from './encounter.ts';
import { rollLoot } from './loot.ts';
import type { MonsterTemplate } from './monsters.ts';
import { LONE_BEGINNER } from '../world/strength.ts';
import { ZoneLevelScheme, zoneBaseLevel } from '../../shared/zone.ts';
import type { ZoneLevelRange } from '../../shared/zone.ts';
import type { PartyStrength } from '../world/strength.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { TileXY } from '../../shared/coords.ts';
import { DOOR_CLEARANCE } from '../../shared/sitemap.ts';
import { qualified } from '../world/world.ts';
import type { World } from '../world/world.ts';

// `DOOR_CLEARANCE` moved to `shared/sitemap.ts`. The vault placer needs the same
// number and cannot import server content — and while only this file held it,
// the placer excluded a single cell where this excludes a ring, so a drawn room
// could land wholly inside ground the populator was about to discard.

/**
 * How far over its room a set piece stands.
 *
 * SMALL ON PURPOSE, because RANK is already doing the heavy lifting: a rank-4
 * body gains life half again as fast per level as the rank-2 husks around it,
 * so two levels is a wide gap here rather than a token one. Upstream puts a
 * boss a little over its zone for the same reason — a set piece that is exactly
 * as tough as the population is not a set piece.
 */
export const BOSS_LEVELS_ABOVE_ROOM = 2;

/** What lives in one delve, and how much of it. */
export type DelveSpec = {
  /**
   * How many bodies. A BAND, not a number, so two visits to the same kind of
   * place are not the same room — and the band is per site, so the Outer Index
   * is not the Wayfarers' road.
   */
  readonly monsters: readonly [number, number];
  /**
   * The roster, in the order the placer walks it. The FIRST entry is the most
   * common: the placer cycles, so putting the elite first would make a delve
   * mostly elites.
   */
  readonly roster: readonly MonsterTemplate[];
  /**
   * Things lying on the floor before anybody arrives.
   *
   * A DELVE IS NOT ONLY A FIGHT. Somewhere with loot on the ground is somewhere
   * worth exploring rather than clearing, and it is the cheapest way to make a
   * room reward the corner you did not have to walk into.
   */
  readonly litter: readonly [number, number];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND ONE THING THAT IS PUT THERE RATHER THAN ROLLED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `roster` is a cycle and `monsters` is a count, so everything else in a delve
   * is a die falling — which is right for the population of a room and wrong for
   * the reason a room exists. A boss is not a heavier entry in a list; it is the
   * thing the door was for.
   *
   * ABSENT ON EVERY SPEC BUT ONE, which is what keeps it meaning anything: a
   * boss in each of the rooms is a difficulty tier, not a set piece.
   */
  readonly boss?: MonsterTemplate;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT LEVEL THE THINGS IN HERE ARE. ToME's `zone.base_level`, one number.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every monster in this game was level 1 — not by decision but because nothing
   * ever passed a level to `monsterInit`, whose parameter defaulted. A husk at
   * the far end of the road had the twenty-five hit points of the husk in the
   * tutorial room, while the player walking in had four hundred.
   *
   * ═══ A FIXED NUMBER PER PLACE, NOT A FUNCTION OF THE PARTY ═══
   * This is the roguelike contract and it is upstream's, exactly: a zone is as
   * dangerous as it is, and deciding whether you are ready for it is the game.
   * Scaling the room to whoever walks in is the other genre — it makes every
   * fight the same fight, makes levelling up feel like nothing, and deletes the
   * one reward this map already offers, which is that the walk you could not
   * survive last week is a walk you can survive now.
   *
   * The party is still read, three lines below, for how MANY bodies (a party of
   * three meets more of them) and for what they are CARRYING. Numbers and loot
   * follow the people; the threat of the place does not.
   *
   * ═══ AND NOT A BAND, WHICH THE REST OF THIS TABLE IS ═══
   * `monsters` and `litter` are bands because a room's POPULATION should vary.
   * A level is not population — a band here would mean a labelled draw inside
   * the placement loop, and this file's own note six lines into
   * `populateDelve` states what that costs: every later draw from the seed
   * moves, so the same seed would produce a different FLOOR rather than the
   * same floor with tougher things in it.
   *
   * THE LADDER IS THE WALK. The step counts in the comments below were already
   * the gradient this table was authored against; this reads them off, at
   * roughly a level per seven steps, so nothing about the map's difficulty order
   * changes — it is the same order, finally expressed in a number the combat
   * code can see.
   *
   * THE COUNTS ARE MEASURED, NOT ESTIMATED, and they have been re-measured since
   * they were first written down: `findPath` from the Alderbrook spawn over the
   * authored overworld, which is the ground a player actually crosses. Several
   * had drifted — two of them had the ORDER wrong — and
   * `test/server/delve-curve.test.ts` now walks the map itself rather than
   * trusting any number in a comment, including these.
   */
  readonly levelRange: ZoneLevelRange;
  /**
   * WHO DECIDES — `engine/Zone.lua:118`. Absent is upstream's own default, `fixed`,
   * which is every delve in the game: a place you walked to is as dangerous as
   * it is. The overworld ambush is the one that is `player`, and it is not in
   * this table at all. See `zoneBaseLevel` for the whole argument.
   */
  readonly levelScheme?: ZoneLevelScheme;
};

/** The common roster. Husks with a wraith or two behind them. */
const RANK_AND_FILE: readonly MonsterTemplate[] = [INDEX_HUSK, INDEX_HUSK, INDEX_WRAITH];
/** Where the Index has thinned. Fewer bodies, and the ones there are bite. */
const DEEP: readonly MonsterTemplate[] = [INDEX_WRAITH, INDEX_HUSK_ELITE, INDEX_HUSK];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO ROSTERS THAT BELONG TO A PLACE RATHER THAN TO A TIER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RANK_AND_FILE` and `DEEP` are DEPTH — they answer "how far out is this", and
 * with the gradient re-keyed by distance that is exactly what they should
 * answer. These two are CHARACTER: they answer "what is this place", and they
 * are attached to the two delves whose names have always promised something the
 * bestiary could not deliver.
 *
 * ═══ AUTHORED, NOT DERIVED, AND I CHECKED THE OTHER WAY FIRST ═══
 * The obvious move is to read the ground off the site's own overworld cell —
 * `groundAt` already exists and the ambush uses it. MEASURED, it gives nonsense
 * here: Blackwood Outskirts classifies as **fen**, because the 9x9 around its
 * marker holds fourteen water cells of the northern coastline. The classifier is
 * not wrong; it answers a question about the COUNTRY, and a dungeon's interior
 * is not its doorstep. `populateDelve`'s own note already draws this line — *"a
 * delve's roster is its identity"* — and identity is authored.
 *
 * ═══ THE CAIRN GOES IN THE EASIEST ROOM ON PURPOSE ═══
 * It is the creature that is only dangerous across water it cannot be reached
 * over, and a delve has no water — so in the Drowned Chapel it is a weak
 * shooter you walk up to and kill in three turns. THAT IS THE POINT. The chapel
 * is seventeen steps from town and the first marker most players will ever walk
 * to; meeting the thing somewhere it is harmless is how you learn what it does
 * before meeting one on the far bank of a channel where it is not.
 */
const THICKET: readonly MonsterTemplate[] = [INDEX_EIDOLON, INDEX_HUSK, INDEX_HUSK_ELITE];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHAPEL: THE TEACHING ROOM, AND THE WRAITH WAS NOT A LESSON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The paragraph above puts the Cairn here on purpose — *"a weak shooter you walk
 * up to and kill in three turns… meeting the thing somewhere it is harmless is
 * how you learn what it does"*. That argument is right and it is the whole
 * reason this roster exists. The Wraith never got the same treatment, and it is
 * not harmless anywhere.
 *
 * ═══ MEASURED, ONE ON ONE, AGAINST A LEVEL-1 WATCHMAN ═══
 * 72 hp, accuracy 9 with his passives live, defence 5, ~13 damage, armour 8 —
 * all read off the real sheet through the real protocol, and the hit chances
 * from `checkHit`'s own `hitChance`:
 *
 *     foe            hp  def   my hit%  their hit%   my turns  their turns
 *     Index Cairn    23    1       70%         58%          3           62
 *     Index Husk     25    1       70%         75%          3           96
 *     Index Wraith   80   20       23%         75%         21           14
 *
 * He needs twenty-one turns and dies in fourteen, WITH the Wraith's -30%
 * physical resistance already counted in his favour. It is not close, and it is
 * not a roll: `populateDelve` walks the roster as a CYCLE, so three monsters in
 * a three-entry roster is one of each, every time. The Wraith was guaranteed.
 *
 * ═══ AND THIS IS THE ROOM THE GAME NOW SENDS EVERY NEW PLAYER TO BY NAME ═══
 * That is what changed. When the grade was one label among seventeen markers,
 * `dangerWord`'s note made a fair trade — a per-entry sum "moved the Drowned
 * Chapel from quiet to restless… making the map disagree with the townsfolk to
 * fix a rounding error is a bad trade". It was a rounding error then. The first
 * case names this room out loud to a character that is four minutes old, so the
 * room has to be beatable by one.
 *
 * A SECOND HUSK RATHER THAN A NEW CREATURE, which is exactly how the next room
 * out is built (`RANK_AND_FILE` is husk, husk, wraith). The chapel keeps its
 * shooter and its identity — *things that shoot, and one of them barely there* —
 * and the Wraith stays in the eight rooms that are graded for it.
 */
const DROWNED: readonly MonsterTemplate[] = [INDEX_CAIRN, INDEX_HUSK, INDEX_HUSK];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EIGHT, AND THEY ARE MEANT TO BE TOLD APART
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read down the `monsters` column and the map acquires a difficulty gradient it
 * did not have: Blackwood is a walk, the Outer Index is not. That gradient is
 * the entire reason a player picks one marker over another, and until now every
 * marker was worth exactly the same as every other one — nothing.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORDERED BY HOW FAR THE WALK IS, BECAUSE THE GRADIENT WAS INVERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The comment above this table has always promised a difficulty gradient and
 * called it *"the entire reason a player picks one marker over another"*. It was
 * real. It also pointed the wrong way. Measured — eight-way BFS from the
 * Alderbrook spawn to each site cell on the shipped map:
 *
 *   BEFORE                                     steps   was          says
 *   The Drowned Chapel                            17   DEEP, elite  dangerous
 *   The Underworks                                30   6-8          dangerous
 *   ...
 *   Gearford Industrial Ward                     108   5-7          restless
 *   Blackwood Outskirts                          131   3-5          quiet
 *
 * A player leaves Alderbrook, walks seventeen steps, finds the nearest marker on
 * the map and it is one of the two hardest rooms in the game — a DEEP roster
 * with a ninety-five hit point elite in it. Meanwhile the row commented *"the
 * near country: where a level-1 party learns the game"* sat on the site that was
 * then the furthest thing on the moor.
 *
 * THE DISTANCES IN THAT TABLE ARE AS THEY WERE MEASURED THEN. The map has been
 * edited since and several have moved — Blackwood is 106 steps now and Gearford
 * 109, so Gearford is the longer walk — which is why the per-row counts below
 * were re-measured and why the gradient has a test that walks the map instead of
 * reading a comment. This block is kept as the record of the fault it describes,
 * not as a current distance table.
 *
 * That is worse than no gradient at all. With no gradient a player learns
 * nothing; with an inverted one they learn something FALSE on their first
 * evening — *the markers near town are the dangerous ones* — and every decision
 * they make afterwards is built on it. `dangerWord` had been faithfully
 * publishing that lie to the world map since the day it was written.
 *
 * ═══ DATA ONLY. NO MAP ROW MOVES. ═══
 * The eight specs are exactly the eight that shipped — same counts, same
 * rosters, same litter — re-attached to different doors. `test/shared/
 * overworld.test.ts` is untouched by construction, and the total amount of
 * content in the game is unchanged.
 *
 * ═══ AND THE FICTION ALREADY AGREED ═══
 * No blurb needed rewriting, which is the part that says this ordering is right
 * rather than merely consistent. `places.ts` describes Blackwood as *"the trees
 * start here and the road stops pretending it goes anywhere"* — an endpoint, in
 * the text, since before it had numbers to match. The Outer Index is *"the EDGE
 * of the Index"*, and an edge is not a heart.
 */
export const DELVES: ReadonlyMap<string, DelveSpec> = new Map<string, DelveSpec>([
  // ─── the near country: where a level-1 party learns the game ────────────
  //     17 steps out, and the first marker most people will ever walk to. The
  //     roster is the gentlest in the game AND it is where you meet a cairn for
  //     the first time, on dry ground, where it cannot hurt you — see `DROWNED`.
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO TO THREE, AND THE OLD THREE-TO-FIVE KILLED THE PLAYER IT WAS FOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * MEASURED over the real socket, walking a level-1 Watchman into this room and
   * fighting until something ended: he was ERASED FOUR TIMES and never cleared
   * it. Three runs, identical. This is the room the first case names out loud to
   * a character four minutes old.
   *
   * ═══ AND MY OWN TEST SAID IT WAS FINE, BECAUSE IT MODELLED DUELS ═══
   * `first-room.test.ts` fought each resident one at a time and every one of
   * them lost. A room is not a queue of duels — everything in it swings every
   * turn — and the whole-room model tells a different story:
   *
   *     foes  turns  hp left
   *       2      6      45     wins
   *       3      9      18     wins, barely
   *       4      6      -7     DIES
   *       5      5     -15     DIES
   *
   * The band was 3-5, so two of its three rolls were a death sentence and the
   * third was a coin flip. It is worse than that live, because the model puts
   * everybody in melee on turn one while the Index Cairn actually shoots across
   * the room while you walk to it.
   *
   * TWO, FLAT, AND NOT A BAND — which is the one place in this table a constant
   * is right. Three foes leaves a beginner 18 hit points of 72 in the model, and
   * the model is OPTIMISTIC: it puts everybody in melee on turn one and ignores
   * the turns actually spent crossing the room while the Cairn shoots. Live, a
   * three-foe roll killed the player four times over. A band whose top roll is a
   * death sentence is a room that kills a share of everyone sent to it, and the
   * first case sends every single new character here by name.
   *
   * Variance belongs in the rooms a player CHOOSES. This is the one the game
   * chooses for them, and its job is to be survivable.
   *
   * It also restores a gradient the old band had flattened: the next room out is
   * 4-6, so the game's gentlest room and its second were nearly the same fight.
   */
  [
    'site:drowned_chapel',
    { monsters: [2, 2], roster: DROWNED, litter: [1, 2], levelRange: [1, 1] },
  ],
  //     19 steps.
  [
    'site:underworks',
    { monsters: [4, 6], roster: RANK_AND_FILE, litter: [2, 3], levelRange: [3, 3] },
  ],
  // ─── worked places: more of them, and more to carry home ────────────────
  //     41 steps.
  [
    'site:watchers_altar',
    { monsters: [5, 7], roster: RANK_AND_FILE, litter: [2, 4], levelRange: [7, 7] },
  ],
  //     61 steps.
  [
    'site:hollow_mine',
    { monsters: [6, 8], roster: RANK_AND_FILE, litter: [2, 4], levelRange: [9, 9] },
  ],
  // ─── quiet and wrong: fewer bodies, harder ones ─────────────────────────
  //     90 steps. The roster changes here, which is the real threshold on the
  //     map: from this marker outward, things bite.
  ['site:outer_index', { monsters: [3, 4], roster: DEEP, litter: [3, 4], levelRange: [10, 10] }],
  //     77 steps.
  ['site:glass_archive', { monsters: [3, 5], roster: DEEP, litter: [2, 3], levelRange: [11, 11] }],
  // ─── the far end ────────────────────────────────────────────────────────
  //     109 steps.
  ['site:gearford_ward', { monsters: [6, 8], roster: DEEP, litter: [3, 5], levelRange: [13, 13] }],
  // ─── and the three nobody is told about ─────────────────────────────────
  //     All three sit in the MIDDLE band by distance (47-62 steps), which is
  //     deliberate: a secret that is also the hardest room in the game is a
  //     secret you can only survive after you no longer need it, and one that is
  //     trivial is a disappointment. They pay in LITTER instead — finding
  //     something should be worth more than the same danger elsewhere, and loot
  //     is the axis that rewards exploring without punishing it.
  //     48 steps, in the western downs.
  //     ═══ AND IT HAS CAIRNS IN IT, WHICH IT DID NOT ═══
  //     A site called CAIRNFOOT drew `RANK_AND_FILE` — two husks and a wraith,
  //     the same three creatures as The Underworks, The Watcher's Altar and The
  //     Hollow Mine. Four of the eleven moor delves were the same bestiary, and
  //     this was the one whose NAME promised otherwise.
  //
  //     THE MAP AGREES WITH THE NAME. The eleven-by-eleven around the marker is
  //     MIRE 85 of 121 — this is a fen, and `INDEX_CAIRN` is the creature the
  //     fen was written for ("only dangerous across water it cannot be reached
  //     over").
  //
  //     STATED PLAINLY, BECAUSE IT WOULD BE EASY TO OVERSELL: a delve has no
  //     water, so the cairn in here is the same weak shooter the Drowned Chapel
  //     teaches you on. This is a change of BESTIARY, not of difficulty — the
  //     room now belongs to its own name and stops being The Underworks with a
  //     different floor colour.
  ['site:cairnfoot', { monsters: [4, 6], roster: DROWNED, litter: [3, 4], levelRange: [6, 6] }],
  //     47 steps, in the clearing inside the southern wood — so it draws on the
  //     wood's own roster, which is the same rule Blackwood follows.
  ['site:barrow_end', { monsters: [5, 7], roster: THICKET, litter: [3, 5], levelRange: [5, 5] }],
  //     71 steps, on the beach behind the wood.
  ['site:the_weir', { monsters: [4, 6], roster: DROWNED, litter: [3, 4], levelRange: [6, 6] }],
  //     106 steps, and the worst room on the moor. NOT the furthest — Gearford
  //     Ward is 109 — which the note here claimed until the walk was measured.
  //     THE TREES START HERE, which `places.ts` has said since before there was
  //     anything in them. Now there is: `THICKET` is a third eidolons, and eight
  //     to ten bodies of which a third move faster than you do is what the far
  //     end of the road should feel like.
  [
    'site:blackwood_outskirts',
    { monsters: [8, 10], roster: THICKET, litter: [4, 6], levelRange: [15, 15] },
  ],
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW BAD IS IT IN THERE, IN ONE WORD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gradient above is real and, until this existed, entirely invisible: the
 * world map showed thirteen markers and a player had no way to tell Blackwood
 * from the Outer Index except by walking into one and finding out. A map whose
 * destinations cannot be told apart is a list, and a list is not a decision.
 *
 * DERIVED FROM THE SPEC, NEVER AUTHORED BESIDE IT. A `danger: 'grim'` field
 * would be a second opinion about the same room, free to disagree with the
 * population the day somebody retunes one and not the other — and it would
 * disagree silently, because nothing downstream compares them.
 *
 * FOUR WORDS AND NOT A NUMBER. "8-10 monsters" is a stat block; a player
 * choosing between two markers on a moor wants to know whether to go there yet.
 * The bands are wide on purpose — this is a hint, and a hint that pretends to
 * be precise is a promise the content has to keep.
 */
export function dangerWord(spec: DelveSpec): string {
  /**
   * THE TOP OF THE BAND, because what decides whether a room hurts is its
   * worst night rather than its average one.
   *
   * AND WHAT IS IN IT COUNTS SEPARATELY FROM HOW MUCH. A first version added a
   * flat bonus for "has anything nastier than a husk" and called the Watcher's
   * Altar — three to four WRAITHS AND ELITES — "quiet", which is worse than
   * saying nothing: a hint that lies is a hint a player stops reading. An elite
   * is worth more than a wraith, and a wraith more than a body, so they are
   * weighted apart.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BY PROPERTY, NOT BY NAME — AND THE OLD VERSION WENT BLIND AS THE ROSTER GREW.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * These two lines read `roster.includes(INDEX_HUSK_ELITE)` and
   * `roster.includes(INDEX_WRAITH)`, which was a complete question when the
   * bestiary was three creatures. It is nine now, and by name the grade could
   * not see the eidolon, the cairn, the glut, the Inspector or the Inquisitor —
   * five of nine, including BOTH of the Redaction's elites and the only other
   * creature in the game that shoots.
   *
   * ═══ AND THE FIX CHANGES NOTHING TODAY, WHICH IS WHY IT IS WORTH SAYING ═══
   * Measured over all seventeen rooms THAT EXISTED THEN: not one grade moves.
   * (The file is 27 now. The claim is kept as the history it is rather than
   * restated as a fact about today — it justified a change already made, and
   * re-running it is a measurement somebody should take rather than inherit.)
   * Every roster that
   * contains an elite already contains `INDEX_HUSK_ELITE`, and every roster
   * that shoots already contains `INDEX_WRAITH`, so the old lines happened to
   * be right by coincidence. This is not a behaviour change; it is the same
   * question asked in a way that survives the next creature.
   *
   * PRESENCE, NOT A SUM. `roster` is a CYCLE that `populateDelve` walks, not a
   * headcount — three entries fill a room of seven — so "can an elite appear
   * here" is the question these weights were always answering. A per-entry sum
   * was tried and it moved three rooms, including the Drowned Chapel from
   * `quiet` to `restless`; that room is the first marker most players ever walk
   * to and Merrow's own directions call it *"close and it is quiet"*. Making
   * the map disagree with the townsfolk to fix a rounding error is a bad trade.
   */
  const elite = spec.roster.some((t) => t.rank !== ActorRank.Normal) ? 3 : 0;
  const ranged = spec.roster.some((t) => t.projSpeed !== undefined) ? 2 : 0;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A BOSS, WHICH THIS DID NOT KNOW ABOUT AT ALL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `DelveSpec.boss` landed with `INDEX_WATCHER` and this function was never
   * told. So the one room in the game with two hundred and twenty hit points of
   * artillery standing in it graded `dangerous` — the same word as five other
   * rooms, including its own ordinary twin on the other map. A player planning a
   * trip had no way to know, and `partyHint` — which is the game's only way of
   * saying *"bring a party"* — stayed silent for the one fight that needs one.
   *
   * BIG ENOUGH TO DECIDE ON ITS OWN. 8 puts any room holding a boss over the
   * `grim` threshold whatever else is in it, which is the honest answer: what
   * makes that room hard is not its population. Deliberately not a fifth word —
   * `grim` already carries `partyHint`'s "bring a party", and a scale a player
   * has learned should not grow a step the day the content does.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BOSS DECIDES ON ITS OWN, AND NOW IT SAYS SO INSTEAD OF OUT-VOTING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This was a weight of 8, under the claim that *"8 puts any room holding a
   * boss over the `grim` threshold whatever else is in it"*. The intent is
   * right; the mechanism was a coincidence of the bands that existed when it was
   * written. Narrowing the beginner room to two monsters made the emptiest spec
   * in the game score `2 + ranged 2 + boss 8 = 12` — one short of `grim`, and a
   * boss room quietly downgraded to `dangerous` with nothing to say it had.
   *
   * A number chosen to out-vote every other term is a number that stops
   * out-voting them the day a term moves. The rule was never really arithmetic,
   * so it is no longer written as arithmetic: what makes that room hard is not
   * its population, and two hundred and twenty hit points of artillery is `grim`
   * in an empty hall.
   *
   * STILL NOT A FIFTH WORD. `grim` already carries `partyHint`'s "bring a
   * party", and a scale a player has learned should not grow a step the day the
   * content does.
   */
  if (spec.boss !== undefined) return 'grim';

  const weight = spec.monsters[1] + elite + ranged;

  if (weight <= 7) return 'quiet';
  if (weight <= 9) return 'restless';
  if (weight <= 12) return 'dangerous';
  return 'grim';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHETHER TO BRING SOMEBODY, WHICH IS THE PART A NUMBER CANNOT SAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The danger word grades a room; this answers the question the grade raises.
 * It matters because the co-op incentive in this game is enormous and entirely
 * invisible: `awardExperience` pays every party member a FULL share with no
 * division by headcount, so three people partied earn three times what three
 * people standing together unpartied do.
 *
 * A player has no way to discover that by playing, and every other co-op game
 * they have touched divides a kill — so the SAFE assumption is that partying
 * costs them. Two words on the worst rooms is the cheapest correction:
 * somebody who reads "grim · bring a party" and does will find out the rest by
 * levelling twice as fast.
 *
 * ONLY ON THE ROOMS WHERE IT IS TRUE. Suggesting a party for Blackwood would
 * be advice a solo player can disprove in four minutes, and advice that is
 * wrong once is advice nobody reads again.
 */
export function partyHint(spec: DelveSpec): string | null {
  const word = dangerWord(spec);
  if (word === 'grim') return 'bring a party';
  if (word === 'dangerous') return 'hard alone';
  return null;
}

/**
 * Every tile a resident could legally stand on, far enough from the door.
 *
 * SEARCHED, NOT COMPUTED — `seedAmbush`'s hard-won lesson. A generated floor
 * has whatever shape the walk gave it, so a ring of angles lands most of its
 * candidates in rock; the tiles that exist are the ones to choose from.
 */
function roomFor(world: World, door: TileXY): TileXY[] {
  const level = world.level;
  const out: TileXY[] = [];
  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 1; x += 1) {
      if (!canWalk(level, x, y)) continue;
      if (Math.max(Math.abs(x - door.x), Math.abs(y - door.y)) < DOOR_CLEARANCE) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * Fill one delve.
 *
 * @returns how many bodies were placed, so a caller can log it — a delve that
 *   silently generated nothing is the bug this whole file was written about,
 *   and it should never be able to happen quietly twice.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MUCH BIGGER A ROOM GETS FOR THE PEOPLE WHO BROUGHT FRIENDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SUB-LINEAR, and deliberately: four players are worth more than four solo
 * players, because they focus one target, they cover each other, and D1's
 * intra-turn budget lets each of them chain two at-will talents a round. A
 * straight multiply by headcount would make a full party the hardest way to
 * play, which is the exact opposite of what this game is for.
 *
 *   1 -> x1.0   2 -> x1.5   3 -> x2.0   4 -> x2.5
 *
 * SIZE ONLY, NEVER LEVEL. A delve's roster is its identity — the Underworks is
 * the Underworks whoever walks in — so the party answers the SIZE of the room
 * and never what is in it. That is the opposite rule to `ambushRoster`, which
 * grows its roster by level, and the difference is the point: an ambush is
 * generic and happens TO you, a delve is a place you chose.
 *
 * A LONE PLAYER GETS EXACTLY WHAT THEY GET TODAY. `x1.0` is not a coincidence
 * to be tuned away: every number in `DELVES` was authored and measured against
 * a single body, and a solo run must not become harder because parties were
 * fixed.
 */
export function delveHeadroom(party: PartyStrength): number {
  return 1 + 0.5 * (Math.max(1, party.size) - 1);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME DOOR, ON THE OTHER MAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six of Alderbrook's sites came through the Redaction still standing, and the
 * registry builds each one as a twin of its original — same shape, same
 * palette, same name (see `REDACTED_SITES` in world/realms.ts, and the argument
 * for keeping the name in shared/redaction.ts: recognising where you are is the
 * whole point of that map). This is the one thing about them that is NOT
 * inherited, and it is the one that decides whether going there is worth it.
 *
 * ═══ THE ROSTER STAYS. THE COUNTS DO NOT. ═══
 * Swapping every twin to one late-game roster was the obvious move and is
 * wrong: it would make four destinations one destination again, which is
 * exactly the monotony that giving each site its own SHAPE was meant to fix.
 * The Underworks is husks on both maps and the Drowned Chapel is cairns on
 * both, because that is what those places ARE.
 *
 * What changed is how much of it there is. +2 monsters, and +1 litter at both
 * ends — harder, and paying for it. A player who has cleared the Underworks and
 * walks fourteen tiles into the Sedge to find another one should meet a room
 * they recognise and cannot handle the same way, and should come out with more
 * than they went in for. Danger with no upside is a place you visit once.
 *
 * ═══ IT IS APPLIED BEFORE PARTY SCALING, WHICH IS WHAT MAKES IT WORK ═══
 * `populateDelve` rolls this range and THEN multiplies by `delveHeadroom`, so
 * the +2 grows with the party rather than being a fixed tax that a strong group
 * stops noticing. Measured against the Underworks, hostiles placed:
 *
 *     party        Alderbrook   Redaction
 *     lvl 1 solo        5            8      1.6x
 *     lvl 1 x3         10           12      1.2x
 *     lvl 4 x3          8           12      1.5x
 *     lvl 8 x5         15           21      1.4x
 *
 * A consistent half-again across the whole range, and +6 rather than +2 for the
 * party that can take it.
 *
 * ═══ AND THE LONE LEVEL-1 WHO WANDERS IN IS GATED BY GEOGRAPHY, NOT BY MERCY ═══
 * Eight hostiles would end that character. The reason it is not a trap is that
 * the door is 99 tiles from the spawn, out in the Sedge, fourteen tiles from
 * the nearest marker and behind an overworld crossing that names itself — a
 * player who gets there has been playing for a while. Softening the floor
 * instead would have made the whole map a reskin, which is the failure this
 * table exists to avoid.
 */
const REDACTED_TOWN: DelveSpec = {
  /**
   * AND THE ONE TOWN THAT SURVIVED IS NOT A TOWN OVER THERE.
   *
   * Threadneedle Row came through with its streets intact, and inheriting its
   * kind would have made it a `Common` realm on the far map: no shop (the
   * shelves are keyed by site id), no townsfolk (likewise), no monsters (a
   * shared space asserts there are none) and never reaped. Thirty tiles of
   * empty street grid with nothing in it and nothing to do — a dead end, not an
   * eerie one, and the fifth time this repo has built a room connected to
   * nothing.
   *
   * So a redacted town is an `Inner` site like the rest, and this is what is in
   * it: `DEEP`, because the things that took the country are what is standing
   * in the street now, and the litter is generous because a town that nobody
   * has walked out of still has everything people left in it.
   */
  monsters: [5, 7],
  roster: DEEP,
  litter: [3, 5],
  /**
   * AND IT IS LATE-GAME, because what is standing in the street is `DEEP` and
   * because the far map is not somewhere anybody arrives early. Level 14 puts it
   * between Gearford Ward and Blackwood Outskirts — the top of the ladder, which
   * is what a town nobody walked out of should be.
   */
  levelRange: [14, 14],
};

/**
 * What is behind a redacted door — `undefined` if `originalId` has no delve.
 *
 * IT LIVES HERE AND NOT IN THE REGISTRY because the rosters live here. Handing
 * `world/realms.ts` a way to reach `DEEP` in order to build one spec would put
 * a content decision in a wiring file, and the next one would follow it.
 */
/**
 * The one room in the game with something authored in it. See `redactedSpec`.
 *
 * The ALDERBROOK id, because that is what `redactedSpec` is handed — the twin's
 * own id is derived from it and comparing against the derived form would couple
 * this decision to how the prefix is spelled.
 */
const WATCHERS_ALTAR = 'site:watchers_altar';

export function redactedSpec(originalId: string): DelveSpec | undefined {
  const spec = DELVES.get(originalId);
  // NO ENTRY MEANS A TOWN. `DELVES` is keyed only by the sites that are fights,
  // so the absence IS the classification — the same way the registry already
  // reads it when it decides whether to attach a `populate` hook at all.
  if (spec === undefined) return REDACTED_TOWN;
  return {
    monsters: [spec.monsters[0] + 2, spec.monsters[1] + 2],
    roster: spec.roster,
    litter: [spec.litter[0] + 1, spec.litter[1] + 1],
    /**
     * AND EVERYTHING OVER THERE IS FOUR LEVELS WORSE THAN ITS TWIN.
     *
     * The same shape as the two lines above it — the twin is its original plus a
     * constant, so the map's difficulty ORDER is inherited whole and only its
     * floor moves. Four rather than two: the twins already carry +2 bodies and
     * +1 litter, and a place reached through the Redaction should be a decision,
     * not a detour. It makes the gentlest door over there (a redacted Drowned
     * Chapel, level 5) roughly the moor's midpoint, which is the honest reading
     * of what walking through that door means.
     */
    levelRange: [spec.levelRange[0] + 4, spec.levelRange[1] + 4],
    ...(spec.levelScheme === undefined ? {} : { levelScheme: spec.levelScheme }),
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * AND ONE OF THE SIX HAS SOMETHING IN IT. EXACTLY ONE, IN THE WHOLE GAME.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * THE BLURB CHOSE THE ROOM, not a difficulty table. `places.ts` on the
     * Redaction's Watcher's Altar: *"Whoever was leaving things here never
     * stopped. The pile has been added to since the country ended."* That is a
     * sentence about a thing that outlasted the erasure and is still growing,
     * and `INDEX_WATCHER` is that thing. Every other candidate would have needed
     * its blurb rewritten to justify a boss, which is the tell that it was the
     * wrong room.
     *
     * ═══ WHY THE REDACTED ONE AND NOT ALDERBROOK'S ═══
     * Alderbrook's Watcher's Altar is a `restless` room seventy steps out that a
     * level-3 party clears. Its twin sits on the far landmass, behind a level-5
     * rumour and a ninety-nine tile walk, and `redactedSpec` has already put two
     * more residents in it. The country that ENDED is where the thing that
     * outlasted the ending lives.
     *
     * ═══ AND ONE IS THE WHOLE DESIGN ═══
     * A boss behind each of seventeen doors is a difficulty tier. One, in a room
     * the fiction already pointed at, is a place people tell each other about.
     * If a second ever lands it should be argued for here, next to this.
     */
    ...(originalId === WATCHERS_ALTAR ? { boss: INDEX_WATCHER } : {}),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS BEHIND ANY DOOR ON ANY MAP — THE ONE LOOKUP EVERYTHING SHOULD USE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DELVES.get(siteId)` is right for Alderbrook and silently wrong for the
 * Redaction, whose sites are DERIVED and therefore absent from that table. The
 * absence is meaningful — it is how this file says "town" — so a caller that
 * asks the table directly cannot tell a settlement from the hardest floor in
 * the game, and gets the town answer for both.
 *
 * ONE FUNCTION SO THERE IS ONE ANSWER. The danger grade on the map, the party
 * hint beside it, and the monsters actually placed in the room all have to
 * agree, and they agree by asking the same question here rather than by three
 * call sites each remembering the prefix rule.
 */
export function specFor(siteId: string): DelveSpec | undefined {
  const direct = DELVES.get(siteId);
  if (direct !== undefined) return direct;
  if (!siteId.startsWith(`${REDACTION_SITE_ID}:`)) return undefined;
  return redactedSpec(siteId.replace(`${REDACTION_SITE_ID}:`, 'site:'));
}

/**
 * WHAT LEVEL THE THINGS IN THIS ROOM ARE — `Zone:updateBaseLevel`, applied.
 *
 * EXPORTED BECAUSE THE UI HAS TO SAY IT. A room whose danger is fixed and
 * unannounced is a room that kills people who had no way to know; `dangerWord`
 * below has been answering that question from the monster COUNT, which was the
 * only signal there was. This is the real one.
 */
export function delveLevel(spec: DelveSpec, party: PartyStrength = LONE_BEGINNER): number {
  return zoneBaseLevel(spec.levelRange, spec.levelScheme ?? ZoneLevelScheme.Fixed, party.level);
}

export function populateDelve(
  world: World,
  map: AuthoredMap,
  spec: DelveSpec,
  party: PartyStrength = LONE_BEGINNER,
): number {
  const door = map.spawns[0] ?? { x: Math.floor(map.view.w / 2), y: Math.floor(map.view.h / 2) };
  const candidates = roomFor(world, door);
  // A ROOM WITH NO FAR CORNER. Small or badly-shaped floors happen; leaving it
  // empty is honest, and the caller's log line is what makes it visible.
  if (candidates.length === 0) return 0;

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * SCALED AFTER THE DRAW, NEVER INSIDE IT, AND THAT IS NOT A STYLE CHOICE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Every draw in this game is labelled and ordered, and `rng.ts` states the
   * consequence: adding, removing or re-ranging a draw shifts every later draw
   * from that seed forever. Widening `delve.count`'s bounds by party size would
   * therefore give a party of three a different FLOOR — different loot, different
   * litter, different everything downstream — rather than the same floor with
   * more in it. So the draw is untouched and the multiply happens to its answer.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE DRAWN ROOM, IF THIS FLOOR ROLLED ONE — see `shared/vault.ts`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Read once, above BOTH placement passes, because the room is one fact and
   * the two passes are two uses of it: something is put in it, and something is
   * left standing over that.
   *
   * Empty when the floor rolled no room, when the map has no vault system at
   * all (an authored fixture, the arena), or when the room's interior is solid
   * wall and contributed no candidate tiles. All three fall through to the
   * behaviour the game had before there were rooms.
   *
   * ═══ THIS LIST USED TO OMIT THE CAUSE THAT ACTUALLY FIRED ═══
   * `roomFor` discards every tile within `DOOR_CLEARANCE` of the door, and the
   * vault placer excluded a single cell rather than that ring — so a room could
   * land wholly inside ground this function was about to throw away, and
   * `inRoom` came back empty for 206 of 400 caves and 151 of 400 works. Nobody
   * reading these three causes would have suspected it, because none of them
   * was ever the reason. The placer now honours the same clearance
   * (`shared/sitemap.ts`), and the solid-wall case above is what remains.
   */
  const room = map.vaults?.[0];
  const inRoom =
    room === undefined
      ? []
      : candidates.filter(
          (tile) =>
            tile.x >= room.at.x &&
            tile.y >= room.at.y &&
            tile.x < room.at.x + room.w &&
            tile.y < room.at.y + room.h,
        );

  const rolled = world.rng.int('delve.count', spec.monsters[0], spec.monsters[1]);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE OFFSET FOR THE FLOOR — AND IT USED TO BE ONE PER BODY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The draw was INSIDE the loop below, which made `stride` decorative: every
   * body landed at a fresh uniform position, which is precisely the "drawn
   * independently" the note down there says this arrangement exists to prevent.
   * The comment described the intended code and the code did the opposite.
   *
   * MEASURED over sixty floors of `site:gearford_ward` on an open map:
   *
   *     per body   48 pairs within 2 tiles   mean nearest-pair gap 2.55
   *     hoisted     0 pairs within 2 tiles   mean nearest-pair gap 4.78
   *
   * Forty-eight clustered pairs is not a cosmetic difference. A party that
   * opens a door onto three bodies standing together is in a fight the roster
   * numbers never described — `delveHeadroom` tunes HOW MANY are in the room,
   * and clustering silently decides how many of them you meet at once.
   */
  const offset = world.rng.int('delve.offset', 0, candidates.length - 1);
  const wanted = Math.max(1, Math.round(rolled * delveHeadroom(party)));
  let placed = 0;
  for (let i = 0; i < wanted; i += 1) {
    const template = spec.roster[i % spec.roster.length];
    if (template === undefined) continue;
    // SPREAD ACROSS THE WHOLE CANDIDATE LIST rather than drawn independently:
    // an independent draw clusters, and a cluster next to the door is the one
    // arrangement this file exists to avoid. The offset is drawn once (above
    // the loop) so two delves are not laid out identically.
    const stride = Math.max(1, Math.floor(candidates.length / Math.max(1, wanted)));
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ONE BODY STANDS IN THE DRAWN ROOM — upstream's guarded vault, in small.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The room already holds a piece of the floor's litter, which made it worth
     * the detour and made the detour FREE. Upstream's vaults are guarded; a
     * reward you can walk to unopposed is a reward the floor may as well have
     * left by the door.
     *
     * TAKEN FROM THE COUNT, NOT ADDED TO IT. `delveHeadroom` tunes how many
     * bodies are in the room and that number is unchanged — this decides where
     * ONE of them stands. A guard on top of the roster would be a silent
     * difficulty rise on every floor in the game, which is the thing the commit
     * before this one was about.
     *
     * AND IT IS THE ONE DELIBERATE EXCEPTION TO THE SPREAD above. The stride
     * exists so bodies do not clump; this puts one body somewhere specific for
     * a reason, and one is the whole of it.
     */
    const at =
      i === 0 && inRoom.length > 0
        ? inRoom[(offset + i * stride) % inRoom.length]
        : candidates[(offset + i * stride) % candidates.length];
    if (at === undefined) continue;

    // Qualified by realm — `delve_0` was the same string in every party's copy
    // of every delve, and the status, Downed and talent tables are process-wide
    // and keyed by it. See `World.id`.
    // AND AT THE LEVEL OF THE PLACE, which is what `monsterInit`'s third
    // parameter has been waiting for. Every caller in the game passed nothing,
    // so every body in it was level 1 — see `DelveSpec.level`.
    const actor = world.addMonster(
      qualified(world, `delve_${String(i)}`),
      monsterInit(template, at, delveLevel(spec, party)),
    );
    /**
     * THE SAME DROP ROLL THE OVERWORLD USES — AND NOW THE SAME EGO ROLL TOO.
     *
     * This used to be `rollDrop` alone, under a comment about not growing "a
     * second place for the tables to drift". The comment was right and the code
     * only copied half of it: `seedAmbush` wraps its `rollDrop` in `embellish`,
     * which is what rolls quality, applies egos and turns a drop into money.
     * Without it every body in all eight delves dropped a plain, unnamed item,
     * and the ego weights and the money column were unreachable from the only
     * content a party enters on purpose.
     *
     * The litter three lines below had `rollLoot` all along, so a delve's FLOOR
     * could produce a named item while nothing that died in it ever could.
     */
    const carrying = embellish(
      world,
      actor.id,
      rollDrop(world.lootRng, template.drops),
      party.level,
    );
    if (carrying !== undefined) actor.carried = [carrying];
    placed += 1;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE THING THE DOOR WAS FOR, AT THE FAR END OF THE ROOM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * FURTHEST FROM THE DOOR, COMPUTED AND NOT ROLLED, and both halves matter.
   *
   * FURTHEST, because `INDEX_WATCHER` is stationary artillery with the longest
   * reach in the game: the fight IS the crossing, and a boss that generated
   * three tiles from the entrance would be a boss you walk up to. The room's
   * own candidate list is the measure, so this works in whatever shape the
   * generator produced rather than assuming a layout.
   *
   * NOT ROLLED, because a new `rng.int` here would consume a position in the
   * world's labelled stream and shift every draw after it — the litter, and
   * every delve any player has ever seen. `pop.ts`'s rule: adding a draw
   * re-rolls the past. A `for` loop over candidates costs nothing and moves
   * nobody's floor.
   *
   * AFTER THE ROSTER LOOP for the same reason, so the ordinary population is
   * placed from exactly the draws it always was.
   *
   * IT DOES NOT COUNT TOWARDS `placed`. That number is the room's population
   * and feeds `delveHeadroom`'s scaling; a boss is additive to the room, not a
   * substitution for part of it.
   */
  if (spec.boss !== undefined) {
    let far = candidates[0];
    let best = -1;
    for (const cell of candidates) {
      const away = Math.max(Math.abs(cell.x - door.x), Math.abs(cell.y - door.y));
      if (away > best) {
        best = away;
        far = cell;
      }
    }
    if (far !== undefined) {
      // `qualified` FOR THE ID, like every other body in this room: it prefixes
      // with the realm, so two parties in two copies of this delve do not share
      // a monster id — and therefore do not share the process-wide status,
      // Downed and talent tables that key off one. See `World.id`.
      /**
       * TWO LEVELS ABOVE THE ROOM IT IS IN. Upstream puts a boss a little over
       * its zone for the same reason: a set piece that is exactly as tough as
       * the population is not a set piece, and its RANK is already doing the
       * heavy lifting — a rank-4 body gains life half again as fast per level as
       * the rank-2 husks around it, so two levels is a wide gap here and not a
       * token one.
       */
      const boss = world.addMonster(
        qualified(world, 'delve_boss'),
        monsterInit(spec.boss, far, delveLevel(spec, party) + BOSS_LEVELS_ABOVE_ROOM),
      );
      /**
       * AND IT IS HOLDING SOMETHING, GUARANTEED.
       *
       * `rollDrop` is a chance for the ordinary population; the one authored
       * body in the game does not roll for whether the walk was worth it. The
       * FIRST entry of its own `drops.pick` rather than a new table — the same
       * shape `encounter.ts` uses for the guaranteed opening drop.
       */
      const prize = embellish(world, boss.id, spec.boss.drops?.pick[0], party.level);
      if (prize !== undefined) boss.carried = [prize];

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE ROOM IT IS STANDING IN LOOKS LIKE SOMETHING HAPPENED THERE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Dressing, not content: a chalk sigil, an offering bowl and a drift of
       * loose pages, scattered on the floor around the Watcher. They block
       * nothing, do nothing and can be walked over — see `shared/props.ts`, which
       * argues why these three and not the other three.
       *
       * ═══ TIED TO THE BOSS RATHER THAN TO A SPEC FIELD ═══
       * There is exactly ONE boss in the game and it is the Watcher's Altar
       * (`redactedSpec`, which says in as many words that a second "should be
       * argued for here"). A `DelveSpec.dressing` list would be a second way to
       * say "this is the special room" with nothing else to put in it. The day a
       * second boss lands, that is the moment the field earns itself.
       *
       * ═══ A FORKED STREAM, AND THAT IS THE WHOLE CARE HERE ═══
       * `fork` does NOT advance the parent — `rng.ts` states it outright — so
       * this pass consumes zero draws from the delve stream and every floor any
       * player has ever walked stays byte-identical. Calling `world.rng.int`
       * here would re-roll the monsters, the litter and the lore note of every
       * delve in the game. Forking LAST, after every other placement, also means
       * no earlier change can move the state this child derives from.
       */
      const dressing = world.rng.fork('delve.dressing');
      const taken = new Set<string>([`${String(far.x)},${String(far.y)}`]);
      for (const propId of PROP_IDS) {
        // A RING AROUND THE BOSS, walked in the room's own order. The draw picks
        // WHERE in that order to start, so the three props do not always land on
        // the same three cells while the walk itself stays deterministic.
        const from = dressing.int(`delve.dressing.${propId}`, 0, candidates.length - 1);
        for (let step = 0; step < candidates.length; step += 1) {
          const cell = candidates[(from + step) % candidates.length];
          if (cell === undefined) continue;
          const key = `${String(cell.x)},${String(cell.y)}`;
          // NOT ON THE BOSS, NOT ON A BODY, NOT ON A PILE, NOT ON EACH OTHER.
          // Two props on one tile would draw one over the other with no way to
          // tell, and a prop under the boss is a prop nobody sees.
          if (taken.has(key)) continue;
          if (world.actorAt(cell.x, cell.y) !== undefined) continue;
          if (world.itemsAt(cell.x, cell.y).length > 0) continue;
          taken.add(key);
          world.addProp(cell, propId);
          break;
        }
      }
    }
  }

  // ─── AND SOMETHING ON THE FLOOR ───
  // Rolled off the loot stream through the ordinary generator, so litter is the
  // same kind of thing a body drops rather than a second catalogue.
  //
  // ═══ AT THE PARTY'S LEVEL, WHICH IT WAS NOT UNTIL NOW ═══
  // This passed a hard-coded `1` — exactly `LONE_BEGINNER.level` — so the third
  // argument of `rollLoot`, documented there as "party max level, for both the
  // band and `computeRarities`", was the bottom band in every delve forever.
  // The sentence above is what makes that a bug rather than a decision: a body's
  // drop goes through `encounter.ts`, which passes the real level, so litter was
  // NOT the same kind of thing a body drops.
  //
  // NOT A BREACH OF "SIZE ONLY, NEVER LEVEL". That rule is argued above
  // `partyScale` and it is about the ROSTER — the Underworks is the Underworks
  // whoever walks in, because a delve is a place you chose. It is a rule about
  // DANGER, and loot is not danger. The room is unchanged; what it pays is not.
  //
  // IT MATTERS MOST WHERE THE WALK IS LONGEST. Cairnfoot, Barrow End and The
  // Weir are `hidden`, carry the best litter counts on the map, and were paying
  // them at the level-1 band — so the reward for finding a secret was more of
  // the cheapest thing.
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE ROOM SOMEBODY DREW HAS SOMETHING IN IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `shared/vault.ts` stamps one drawn room into every delve floor, and until
   * now it was pure architecture: a player walked into a filing chamber, found
   * it empty, and learned that the interesting-looking room is not worth the
   * detour. Upstream's vaults are worth finding — that is what makes them a
   * feature rather than a tileset.
   *
   * ═══ THE VAULT STILL DOES NOT DECIDE WHAT IS IN IT ═══
   * `shared/vaults.ts` says at length why upstream's per-tile object filters are
   * not ported: rooms are populated HERE, from a weight, and a vault that also
   * spawned things would be a second answer to "what is in this room". That rule
   * is intact. The room says WHERE it is; this file still decides what lands
   * there, out of the same table, with the same roll.
   *
   * ═══ ONE PIECE, NOT ALL OF THEM ═══
   * Everything in the drawn room would make the rest of the floor not worth
   * walking, which is the opposite of the problem being fixed. One is enough to
   * make the detour pay, and the remainder are spread as they always were.
   */
  /**
   * AND THE ROOM SOMEBODY DREW HAS SOMETHING IN IT — one piece, not all of
   * them. Everything in the drawn room would make the rest of the floor not
   * worth walking. `inRoom` is computed above, beside the guard that stands
   * over this.
   */
  const litter = world.rng.int('delve.litter', spec.litter[0], spec.litter[1]);
  for (let i = 0; i < litter; i += 1) {
    // THE FIRST PIECE GOES IN THE ROOM WHEN THERE IS A ROOM TO PUT IT IN. A
    // vault whose interior is entirely wall, or that `connect` never tunnelled
    // into, contributes no candidates and this falls through to the floor —
    // which is the same answer the game gave before there were rooms at all.
    const from = i === 0 && inRoom.length > 0 ? inRoom : candidates;
    const at = from[world.rng.int('delve.litter.at', 0, from.length - 1)];
    if (at === undefined) continue;
    const base =
      INDEX_HUSK.drops?.pick[
        world.rng.int('delve.litter.pick', 0, (INDEX_HUSK.drops?.pick.length ?? 1) - 1)
      ];
    if (base === undefined) continue;
    world.addGroundItem(
      at,
      rollLoot(world.lootRng.fork(`delve.litter:${String(i)}`), base, party.level),
    );
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND SOMETIMES SOMEBODY LEFT SOMETHING WRITTEN DOWN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME scatters its lore through authored zones — a note is placed because
   * somebody decided that room should have one. We generate our floors, so the
   * nearest honest equivalent is a seeded roll: the same delve always has the
   * same note in the same place, and a different one does not.
   *
   * ═══ ONE IN THREE, AND NOT IN THE DRAWN ROOM ═══
   * The vault already holds the best piece of litter, and stacking the note
   * there too would make every other tile on the floor not worth walking —
   * which is the argument the litter loop above makes for itself. A note is a
   * reason to look in a corner.
   *
   * ═══ A REPEAT IS HARMLESS BY CONSTRUCTION ═══
   * `learnLore` marks a note known UNCONDITIONALLY and announces only when it
   * is new to the party — upstream's own order — so a party that walks the same
   * delve twice reads it once and picks up nothing the second time. There is
   * deliberately no 'have they read it' check here: the generator does not know
   * which party is about to arrive, and a floor that changed shape depending on
   * who opened it would not be the same delve.
   */
  if (world.rng.int('delve.note', 0, 2) === 0 && candidates.length > 0) {
    const at = candidates[world.rng.int('delve.note.at', 0, candidates.length - 1)];
    const note = LORE[world.rng.int('delve.note.which', 0, LORE.length - 1)];
    if (at !== undefined && note !== undefined) {
      // A FLOOR ID, not a catalogue id. A note is not an `Item` — see
      // content/lore.ts, and `money.ts` for the shape it is copied from.
      world.addGroundItem(at, noteIdFor(note.id));
    }
  }

  return placed;
}
