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
} from './monsters.ts';
import { embellish } from './encounter.ts';
import { canWalk } from '../../shared/level.ts';
import { rollDrop } from './encounter.ts';
import { rollLoot } from './loot.ts';
import type { MonsterTemplate } from './monsters.ts';
import { LONE_BEGINNER } from '../world/strength.ts';
import type { PartyStrength } from '../world/strength.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { TileXY } from '../../shared/coords.ts';
import { qualified } from '../world/world.ts';
import type { World } from '../world/world.ts';

/**
 * How far from the door the nearest resident may stand.
 *
 * LARGER THAN THE AMBUSH'S FOUR, deliberately. An ambush is something that
 * happened TO you and opening at four tiles is the point; a delve is somewhere
 * you chose to walk into, and the first thing it owes you is a look at the room
 * before anything is in reach.
 */
const DOOR_CLEARANCE = 8;

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

/** The chapel: things that shoot, and one of them barely there. */
const DROWNED: readonly MonsterTemplate[] = [INDEX_CAIRN, INDEX_HUSK, INDEX_WRAITH];

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
 * near country: where a level-1 party learns the game"* sat on the site that is
 * a hundred and thirty-one steps away, the furthest thing on the moor.
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
  ['site:drowned_chapel', { monsters: [3, 5], roster: DROWNED, litter: [1, 2] }],
  //     30 steps.
  ['site:underworks', { monsters: [4, 6], roster: RANK_AND_FILE, litter: [2, 3] }],
  // ─── worked places: more of them, and more to carry home ────────────────
  //     70 steps.
  ['site:watchers_altar', { monsters: [5, 7], roster: RANK_AND_FILE, litter: [2, 4] }],
  //     87 steps.
  ['site:hollow_mine', { monsters: [6, 8], roster: RANK_AND_FILE, litter: [2, 4] }],
  // ─── quiet and wrong: fewer bodies, harder ones ─────────────────────────
  //     88 steps. The roster changes here, which is the real threshold on the
  //     map: from this marker outward, things bite.
  ['site:outer_index', { monsters: [3, 4], roster: DEEP, litter: [3, 4] }],
  //     92 steps.
  ['site:glass_archive', { monsters: [3, 5], roster: DEEP, litter: [2, 3] }],
  // ─── the far end ────────────────────────────────────────────────────────
  //     108 steps.
  ['site:gearford_ward', { monsters: [6, 8], roster: DEEP, litter: [3, 5] }],
  // ─── and the three nobody is told about ─────────────────────────────────
  //     All three sit in the MIDDLE band by distance (47-62 steps), which is
  //     deliberate: a secret that is also the hardest room in the game is a
  //     secret you can only survive after you no longer need it, and one that is
  //     trivial is a disappointment. They pay in LITTER instead — finding
  //     something should be worth more than the same danger elsewhere, and loot
  //     is the axis that rewards exploring without punishing it.
  //     62 steps, in the western downs.
  ['site:cairnfoot', { monsters: [4, 6], roster: RANK_AND_FILE, litter: [3, 4] }],
  //     47 steps, in the clearing inside the southern wood — so it draws on the
  //     wood's own roster, which is the same rule Blackwood follows.
  ['site:barrow_end', { monsters: [5, 7], roster: THICKET, litter: [3, 5] }],
  //     62 steps, on the beach behind the wood.
  ['site:the_weir', { monsters: [4, 6], roster: DROWNED, litter: [3, 4] }],
  //     131 steps, the furthest walk on the moor, and now the worst room on it.
  //     THE TREES START HERE, which `places.ts` has said since before there was
  //     anything in them. Now there is: `THICKET` is a third eidolons, and eight
  //     to ten bodies of which a third move faster than you do is what the far
  //     end of the road should feel like.
  ['site:blackwood_outskirts', { monsters: [8, 10], roster: THICKET, litter: [4, 6] }],
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
  const elite = spec.roster.includes(INDEX_HUSK_ELITE) ? 3 : 0;
  const ranged = spec.roster.includes(INDEX_WRAITH) ? 2 : 0;
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
  const rolled = world.rng.int('delve.count', spec.monsters[0], spec.monsters[1]);
  const wanted = Math.max(1, Math.round(rolled * delveHeadroom(party)));
  let placed = 0;
  for (let i = 0; i < wanted; i += 1) {
    const template = spec.roster[i % spec.roster.length];
    if (template === undefined) continue;
    // SPREAD ACROSS THE WHOLE CANDIDATE LIST rather than drawn independently:
    // an independent draw clusters, and a cluster next to the door is the one
    // arrangement this file exists to avoid. The offset is drawn once so two
    // delves are not laid out identically.
    const offset = world.rng.int('delve.offset', 0, candidates.length - 1);
    const stride = Math.max(1, Math.floor(candidates.length / Math.max(1, wanted)));
    const at = candidates[(offset + i * stride) % candidates.length];
    if (at === undefined) continue;

    // Qualified by realm — `delve_0` was the same string in every party's copy
    // of every delve, and the status, Downed and talent tables are process-wide
    // and keyed by it. See `World.id`.
    const actor = world.addMonster(
      qualified(world, `delve_${String(i)}`),
      monsterInit(template, at),
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
    const carrying = embellish(world, actor.id, rollDrop(world.lootRng, template.drops));
    if (carrying !== undefined) actor.carried = [carrying];
    placed += 1;
  }

  // ─── AND SOMETHING ON THE FLOOR ───
  // Rolled off the loot stream through the ordinary generator, so litter is the
  // same kind of thing a body drops rather than a second catalogue.
  const litter = world.rng.int('delve.litter', spec.litter[0], spec.litter[1]);
  for (let i = 0; i < litter; i += 1) {
    const at = candidates[world.rng.int('delve.litter.at', 0, candidates.length - 1)];
    if (at === undefined) continue;
    const base =
      INDEX_HUSK.drops?.pick[
        world.rng.int('delve.litter.pick', 0, (INDEX_HUSK.drops?.pick.length ?? 1) - 1)
      ];
    if (base === undefined) continue;
    world.addGroundItem(at, rollLoot(world.lootRng.fork(`delve.litter:${String(i)}`), base, 1));
  }

  return placed;
}
