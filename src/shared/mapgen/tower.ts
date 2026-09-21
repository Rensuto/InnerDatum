// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/zones/infinite-dungeon/zone.lua:25-35 (the zone)
//   and game/modules/tome/data/zones/infinite-dungeon/zone.lua:207-249 (the chain and the grids)
//   and game/engines/default/engine/Zone.lua:1023-1166 (newLevel, through mapgen/level.ts)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INFINITY TOWER — THE CHAIN, AND ONE FLOOR OF IT AS A MAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mapgen/infinite.ts` is upstream's `alter_level_data`, draw for draw, and it
 * has had no caller: it rolls a floor's table and names the layout and grid set
 * of the floors its two ways on lead to, and nothing was walking that chain.
 * This file walks it, and turns one link of it into an `AuthoredMap` the way
 * `zoneLevel` turns a `ZoneDef` level into one.
 *
 * ═══ WHY THE TOWER IS NOT A ROW IN `ZONES` ═══
 * Three things a `ZoneDef` cannot say. `zoneSite` refuses a site whose row's
 * `{floor, wall}` is not its zone's `palette` (`world/realms.ts`) and the
 * Tower's palette is a different one of seventeen on every floor;
 * `sealUnreachable` takes ONE wall code and the crystals set's wall is a
 * twenty-entry table (`mapgen/gridsets.ts`); and `ZoneDef` has a fixed list of
 * levels, which is the one thing a tower with no bottom does not have. So it is
 * a hand-written `SiteDef` with a hand-written builder, as the Undermost is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHAIN IS A PURE FUNCTION OF THE FLOOR NUMBER. A DELIBERATE DIVERGENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream keeps `zone.layoutN` and `zone.vgridN` on the live zone object and
 * rolls the next pair as it builds each level (`zone.lua:207-208`, `:219-225`),
 * so a character's Infinite Dungeon is that character's: floor 7 is whatever
 * the game's rng said when they got there, and nobody else's floor 7.
 *
 * Ours is the same walk from the same start — `zone.layoutN or 1`, layout 1 in
 * set 1, then exit 1 each time — with each floor's roll on its OWN labelled
 * seed (`towerFloorSeed`) rather than on a running stream. The consequence is
 * the divergence: **there is one Tower, and its floor 7 is the same kind of
 * place for everybody, forever.** Three reasons, and they are all about this
 * game rather than about faithfulness:
 *
 * 1. A REALM IS REAPED AND RE-OPENED. `leaveRealm` climbing from floor 40 to 39
 *    calls `Realms.open(site, party, …, 39)`, and if that instance is gone the
 *    floor is built again from scratch. With a rolled chain there is nowhere to
 *    have kept what floor 39 WAS; with the chain derived, floor 39 is a sylvan
 *    cavern on the way down and a sylvan cavern on the way back up — a NEW
 *    sylvan cavern, but that floor.
 *
 *    ═══ THIS REASON WAS OVERSTATED, AND THE CORRECTION IS THE INTERESTING
 *        HALF. ═══
 *    It used to say the climb out "would walk up through thirty-nine floors
 *    that each changed species underneath the party", as though that happened
 *    on every climb. It does not, and it never did: `zoneOf` holds a party's
 *    floors open while anybody of that party is in the zone, so the reap this
 *    argument depends on cannot fire while they are climbing. DRIVEN over a
 *    socket, floors 8 down to 1: same realm id and byte-identical ground on
 *    every step of the way back up.
 *
 *    What IS true is narrower. `zoneOf` holds a WINDOW now rather than the
 *    whole site (`world/realms.ts` — an endless zone held every floor a party
 *    had ever walked, forever), so a floor more than a few below where the
 *    party is standing closes on its own five-minute linger, and a climb out of
 *    a deep Tower after a long fight DOES rebuild the floors it passes. So the
 *    reason survives as a reason and not as the loudest one; reasons 2 and 3
 *    are what this decision actually rests on.
 * 2. IT NEEDS NO NEW SAVED STATE. The alternative is a per-party ledger of the
 *    chain, which is a save-format change for a first ship.
 * 3. IT MAKES THE PLACE A PLACE. Six people in a voice channel can say "the
 *    lava floor" and mean one floor. That is worth more here than per-character
 *    variety, which the floors themselves still have in full: the MAP is built
 *    from the realm's own instance seed, so two parties on floor 7 are in two
 *    different caverns, and the same party coming back tomorrow gets a third.
 *
 * What is fixed is the SPECIES of each floor and the parameters upstream rolls
 * with the species (`TowerFloor`); what is rolled afresh every time is the
 * ground.
 *
 * ═══ AND THE SECOND WAY ON IS ROLLED AND NOT YET WALKED ═══
 * `alterLevelData` returns both of upstream's exits and `towerChain` takes exit
 * 1, which is the down stair (`:280-330` places exit 2 elsewhere on the floor,
 * through `findEventGrid`). Exit 2 is deferred rather than dropped: a second
 * stair needs two cells in `realm.sites` leading to two different floors, and
 * `STAIRS_DOWN_SITE_ID` is one string with no room for a destination in it.
 * `exits[1]` is still rolled, still in the seed contract, and `towerFloorAt`
 * hands it to whoever ports the fork.
 */

import type { AuthoredMap } from '../level.ts';
import type { TileCode } from '../protocol.ts';
import { createRng } from '../rng.ts';
import { sealUnreachable } from './connectivity.ts';
import { ID_GRID_SETS } from './gridsets.ts';
import type { GridSet } from './gridsets.ts';
import { alterLevelData } from './infinite.ts';
import type { TowerEntry, TowerFloor } from './infinite.ts';
import { keepTrying } from './level.ts';
import { refuseMostlySealed } from './zones.ts';

/**
 * `max_level = 1000000000` (`data/zones/infinite-dungeon/zone.lua:27`).
 *
 * It is upstream's own way of saying "no bottom", and it is read three times
 * here: `newLevel` never withholds a down stair, `goDown` never refuses, and
 * `DelveSpec.maxFloors` reports it as the site's depth.
 */
export const TOWER_MAX_FLOOR = 1000000000;

/**
 * The `* 1.2` in `actor_adjust_level`
 * (`data/zones/infinite-dungeon/zone.lua:28`), which is the whole difficulty
 * curve of a place with no bottom. `DelveSpec.depthScale` carries it and
 * `actorAdjustLevel` applies it; it lives here because it is a fact about the
 * Tower rather than about the population code, and because `TOWER_MAX_FLOOR`
 * two lines up comes off the neighbouring line of the same table.
 */
export const TOWER_DEPTH_SCALE = 1.2;

/**
 * Where the walk starts: `zone.layoutN or 1` and `zone.vgridN or 1`
 * (`data/zones/infinite-dungeon/zone.lua:207-208`) — the first layout in the
 * first grid set, which is the hewn Roomer. Upstream's floor 1 is this too, on
 * a fresh game, because nothing has set the fields yet.
 */
export const TOWER_FIRST_ENTRY: TowerEntry = Object.freeze({ layoutN: 1, vgridN: 1 });

/**
 * The stream one floor's table is rolled on.
 *
 * ONE SEED PER FLOOR rather than one running stream, so that a floor's table is
 * reproducible on its own — `towerFloorAt(30)` in a test rolls exactly what the
 * game rolls for floor 30 — and so that adding a draw to some LATER feature of
 * the Tower cannot move floor 1. Upstream has one stream and does not need
 * this; it also never has to answer the same question twice.
 */
function towerFloorSeed(floor: number): string {
  return `tower:floor:${String(floor)}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PREFIX, KEPT — because the chain is asked for far more often than walked.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CHAIN[n - 1]` is floor `n`'s table. It is a memo and nothing more: the chain
 * is a pure function of the floor number (see the header), so a cached answer
 * and a recomputed one are the same object's worth of the same draws, and the
 * precedent is `asciiCache` in `mapgen/rooms-loader.ts`.
 *
 * ═══ WHAT IT IS FOR, MEASURED ═══
 * `stairDownName` asks for the CURRENT floor's table to name the stair, and it
 * is called from `markersFor` once per pump PER VIEWER. Without this, that read
 * is O(depth): measured warm, 3.2 ms at floor 100, 7.7 ms at 200, 37.7 ms at
 * 1600 — against a whole pump costing about 11 ms — so four players on floor
 * 400 spent more time re-deriving the label on a staircase than playing the
 * game, growing linearly forever, in the one place in the game designed to be
 * unbounded. `Realms.open` walks it twice more (`map` and `populate`).
 *
 * ═══ BOUNDED, AND THE BOUND IS THE POINT ═══
 * `TOWER_MAX_FLOOR` is a billion. An unbounded memo would turn a caller that
 * asks for an absurd floor from a slow loop into an out-of-memory crash, which
 * is a worse failure and a harder one to read. Past `CHAIN_KEPT` the walk still
 * happens and nothing is stored, so deep-but-silly asks cost what they always
 * cost and realistic play costs one walk.
 *
 * ═══ THE TABLES ARE NEVER MUTATED BY A CALLER, WHICH IS WHAT MAKES THIS SAFE ═══
 * Two callers now share one object. `towerLevel` hands `table.spec` to
 * `keepTrying`, which reads it and returns it (`mapgen/level.ts`); `TOWER_SITE`
 * spreads a copy. Checked, because a memo behind a function that hands out a
 * mutable object is a bug that only appears on the second call.
 */
const CHAIN: TowerFloor[] = [];

/**
 * How much of the chain is kept. About three hundred floors is further than
 * any measured descent by an order of magnitude, and a thousand is still a
 * small table of parameter objects with no maps in them: MEASURED at 0.97 MB
 * for the full 1024, against roughly a megabyte for ONE built floor.
 */
const CHAIN_KEPT = 1024;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR `floor` OF THE TOWER: ITS TABLE, AND THE WAY ON IT NAMES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The walk from floor 1, taking exit 1 each time — `alter_level_data`'s own
 * chain (`zone.lua:219-225`, `:246`), followed rather than ignored.
 *
 * O(`floor`) THE FIRST TIME AND O(1) AFTERWARDS, up to `CHAIN_KEPT`. The walk
 * itself is honest rather than cheap: the only way a party has a floor number
 * is to have walked to it one stair at a time, and one `alterLevelData` is a
 * few dozen draws with no map in it. What was NOT honest was paying for the
 * walk again on every frame — see `CHAIN`.
 *
 * THROWS above `TOWER_MAX_FLOOR`, which is the same refusal `goDown` makes, so
 * a caller cannot ask for a fold that would not finish.
 */
export function towerFloorAt(floor: number): TowerFloor {
  if (!Number.isInteger(floor) || floor < 1) {
    throw new RangeError(`towerFloorAt: floor ${String(floor)} is not a floor`);
  }
  if (floor > TOWER_MAX_FLOOR) {
    throw new RangeError(`towerFloorAt: the Tower is ${String(TOWER_MAX_FLOOR)} floors deep`);
  }
  const kept = CHAIN[floor - 1];
  if (kept !== undefined) return kept;

  // START FROM THE DEEPEST FLOOR ALREADY WALKED, not from floor 1. The prefix
  // is contiguous by construction — nothing writes past `CHAIN.length` — so the
  // last entry is always a legal place to resume from.
  let lev = CHAIN.length;
  let table = CHAIN[lev - 1];
  if (table === undefined) {
    table = rollFloor(1, TOWER_FIRST_ENTRY);
    lev = 1;
    CHAIN.push(table);
  }
  while (lev < floor) {
    lev += 1;
    const entry: TowerEntry = table.exits[0];
    table = rollFloor(lev, entry);
    if (CHAIN.length === lev - 1 && lev <= CHAIN_KEPT) CHAIN.push(table);
  }
  return table;
}

/** One link: floor `lev`'s table, entered by `entry`. */
function rollFloor(lev: number, entry: TowerEntry): TowerFloor {
  return alterLevelData(lev, entry, createRng(towerFloorSeed(lev)));
}

/** The grid set a floor is drawn in, by the name its table carries. */
export function towerGridSet(floor: TowerFloor): GridSet {
  const set = ID_GRID_SETS.find((s) => s.id === floor.gridsName);
  // Unreachable: the name came out of `ID_GRID_SETS` one call ago. Thrown
  // rather than defaulted because a defaulted palette would draw a lava floor
  // in grey and look like a bad tileset rather than a bug.
  if (set === undefined) throw new Error(`towerGridSet: no grid set '${floor.gridsName}'`);
  return set;
}

/**
 * The one code `sealUnreachable` fills with.
 *
 * The crystals set's wall is twenty entries long and every one of them is
 * CRYSTAL_WALL (`mapgen/gridsets.ts`): upstream's twenty grids are one code
 * here and the array keeps its length only so that each wall cell still spends
 * the `rng.range(1, #t)` draw it spends upstream. So taking the first entry
 * loses nothing — there is only one code in there to lose.
 */
function wallCodeOf(set: GridSet): TileCode {
  const { wall } = set;
  if (!Array.isArray(wall)) return wall as TileCode;
  const first = (wall as readonly TileCode[])[0];
  if (first === undefined) throw new Error(`${set.id}: an empty wall table`);
  return first;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOOR `floor` OF THE TOWER, BUILT — `zoneLevel`'s shape, for a zone of one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The floor's own table certified by `keepTrying` with a mostly-sealed map
 * refused by the same rule every other generated floor here obeys
 * (`refuseMostlySealed`), sealed where the up stair cannot reach, lit as its
 * layout lights a room, and carrying the set's floor as what a rock door opens
 * into.
 *
 * ═══ THE REFUSAL HAS NEVER FIRED HERE, AND IT IS KEPT ANYWAY ═══
 * Measured before it was written down: 120 builds over the first forty floors,
 * three seeds each, worst pre-seal sealed share 0.184 against a
 * `MAX_SEALED_SHARE` of 0.5. The rule was written for a 30x30 Glass Archive and
 * these floors are 60 to 90 a side. It stays because a generated floor obeying
 * a different connectivity rule from every other generated floor is a special
 * case nobody would remember — and no test here claims to exercise it, which
 * `test/shared/mapgen/tower.test.ts` says in as many words.
 *
 * ═══ THE TABLE IS FIXED AND THE ATTEMPTS ARE NOT — a labelled divergence ═══
 * `zoneLevel` hands `keepTrying` a FUNCTION of the round's seed, because a zone
 * that rolls its table rolls it again on each of upstream's "keep trying"
 * (`tome/class/Game.lua:972-974` runs the whole level change again). Ours hands
 * it the floor's one table, because that table IS the floor's identity — see
 * the header. The retry is still a retry: each round and each of its fifty
 * attempts gets its own seed and its own map.
 *
 * ═══ `rockFloor`, WHICH NO GENERATED FLOOR HAS EVER SET ═══
 * Twelve of the seventeen sets shut their rooms with `ROCK_DOOR`, whose opened
 * form is the map's own floor rather than `DOOR_OPEN` (`shared/terrain.ts`
 * `openedFormOf`, `data/zones/infinite-dungeon/grids.lua:45`). Nothing in
 * `zoneLevel` sets it because no shipped zone uses that code; every sylvan,
 * lava or crystal Tower floor does, and without this line each of their doors
 * would open onto a patch of grey `FLOOR` in the middle of the grass.
 */
export function towerLevel(floor: number, seed: string): AuthoredMap {
  const table = towerFloorAt(floor);
  const set = towerGridSet(table);
  const built = keepTrying(table.spec, seed, {
    level: floor,
    maxLevel: TOWER_MAX_FLOOR,
    refuse: refuseMostlySealed,
  });
  return {
    ...sealUnreachable(built.map, wallCodeOf(set)),
    lighting: table.lighting,
    rockFloor: set.floor,
  };
}
