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

import { INDEX_HUSK, INDEX_HUSK_ELITE, INDEX_WRAITH, monsterInit } from './monsters.ts';
import { canWalk } from '../../shared/level.ts';
import { rollDrop } from './encounter.ts';
import { rollLoot } from './loot.ts';
import type { MonsterTemplate } from './monsters.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { TileXY } from '../../shared/coords.ts';
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
 * THE EIGHT, AND THEY ARE MEANT TO BE TOLD APART
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read down the `monsters` column and the map acquires a difficulty gradient it
 * did not have: Blackwood is a walk, the Outer Index is not. That gradient is
 * the entire reason a player picks one marker over another, and until now every
 * marker was worth exactly the same as every other one — nothing.
 */
export const DELVES: ReadonlyMap<string, DelveSpec> = new Map<string, DelveSpec>([
  // ─── the near country: where a level-1 party learns the game ────────────
  ['site:blackwood_outskirts', { monsters: [3, 5], roster: RANK_AND_FILE, litter: [1, 2] }],
  ['site:hollow_mine', { monsters: [4, 6], roster: RANK_AND_FILE, litter: [2, 3] }],
  // ─── worked places: more of them, and more to carry home ────────────────
  ['site:gearford_ward', { monsters: [5, 7], roster: RANK_AND_FILE, litter: [2, 4] }],
  ['site:underworks', { monsters: [6, 8], roster: RANK_AND_FILE, litter: [2, 4] }],
  // ─── quiet and wrong: fewer bodies, harder ones ─────────────────────────
  ['site:drowned_chapel', { monsters: [3, 5], roster: DEEP, litter: [2, 3] }],
  ['site:watchers_altar', { monsters: [3, 4], roster: DEEP, litter: [3, 4] }],
  // ─── the far end ────────────────────────────────────────────────────────
  ['site:glass_archive', { monsters: [6, 8], roster: DEEP, litter: [3, 5] }],
  ['site:outer_index', { monsters: [8, 10], roster: DEEP, litter: [4, 6] }],
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
export function populateDelve(world: World, map: AuthoredMap, spec: DelveSpec): number {
  const door = map.spawns[0] ?? { x: Math.floor(map.view.w / 2), y: Math.floor(map.view.h / 2) };
  const candidates = roomFor(world, door);
  // A ROOM WITH NO FAR CORNER. Small or badly-shaped floors happen; leaving it
  // empty is honest, and the caller's log line is what makes it visible.
  if (candidates.length === 0) return 0;

  const wanted = world.rng.int('delve.count', spec.monsters[0], spec.monsters[1]);
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

    const actor = world.addMonster(`delve_${String(i)}`, monsterInit(template, at));
    // THE SAME DROP ROLL THE OVERWORLD USES, on the same stream and with the
    // same labels — a delve's husk is not a different kind of husk, and a
    // second loot path would be a second place for the tables to drift.
    const carrying = rollDrop(world.lootRng, template.drops);
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
