// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — every number below is ours) from
//   t-engine4 game/engines/default/engine/Zone.lua:700-760 (`addEntity` per level — a zone is
//              populated once, at generation, from its own roster and its own density)
//   t-engine4 game/modules/tome/data/zones/*/zone.lua (`generator.actor.nb_npc` — a per-zone
//              population band rather than one global number)
//   t-engine4 game/modules/tome/class/Grid.lua:102-109 (a body is never put where it cannot breathe)
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
 * A player is told "Cut for ore, abandoned when the tunnels went deeper than
 * anyone dug", walks thirty tiles across a moor to get there, and finds an empty
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
  INDEX_INKWELL,
  INDEX_RIBBON,
  INDEX_STRONGBOX,
  INDEX_WRAITH,
  monsterInit,
  INDEX_WATCHER,
} from './monsters.ts';
import { ActorRank } from '../../shared/protocol.ts';
import { RANK_VALUE, rankLevelAdjust } from '../../shared/leveling.ts';
import { computeRarities, pickEntity } from './rarity.ts';
import type { RarityCandidate, RarityList } from './rarity.ts';
import type { Rng } from '../../shared/rng.ts';
import { INFINITY_TOWER_SITE_ID, REDACTION_SITE_ID } from '../../shared/level.ts';
// THE TOWER'S OWN THREE NUMBERS, EACH READ OFF ITS OWN LINE OF ITS OWN ZONE
// FILE — `max_level` (:27), the `* 1.2` (:28) and `enemy_count`'s numerator
// (:255). They live in `shared/mapgen/` because the map generator needs them
// too, and a second copy here would be a second answer.
import { TOWER_DEPTH_SCALE, TOWER_MAX_FLOOR } from '../../shared/mapgen/tower.ts';
import {
  TOWER_ENEMY_COUNT_AREA,
  TOWER_ENEMY_COUNT_PER_AREA,
  towerEnemyCountPerArea,
} from '../../shared/mapgen/infinite.ts';
import { embellish } from './encounter.ts';
import { canWalk, tileAt } from '../../shared/level.ts';
import { airOf, breathes } from '../../shared/terrain.ts';
import type { Breather } from '../../shared/terrain.ts';
import { reachableSet } from '../../shared/mapgen/connectivity.ts';
import { LORE, noteIdFor } from './lore.ts';
import { PROP_IDS } from '../../shared/props.ts';
import { rollDrop } from './encounter.ts';
import { rollLoot } from './loot.ts';
import { rollTrap } from './traps.ts';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR OVER ITS ROOM A SET PIECE STANDS — AND IT IS NO LONGER A CONSTANT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was a hand-picked `2`, argued as *"rank is already doing the heavy
 * lifting… upstream puts a boss a little over its zone for the same reason"*.
 * The reasoning was right and the number was ours. Upstream states it exactly,
 * for every body on every floor and not only for the boss:
 *
 * ```lua
 * actor_adjust_level = function(zone, level, e)
 *     return zone.base_level + e:getRankLevelAdjust() + level.level-1 + rng.range(-1,2) end
 * ```
 *
 * — `tome/data/zones/trollmire/zone.lua:30`, and seventy-nine occurrences of that
 * line across seventy-four of ToME's eighty-nine zone files. `getRankLevelAdjust`
 * (`tome/class/Actor.lua:1714-1725`, ported as `rankLevelAdjust`) is +3 for a
 * rank-4 boss, +2 for a rank-3.5 elite and 0 for the rank-2 rank and file. So
 * the boss is THREE over its floor rather than two, the elites beside it are
 * two over, and neither number is authored here any more.
 *
 * KEPT AS AN EXPORT because `test/server/boss-fight.test.ts` states the boss's
 * life against it, and because the value is worth being able to name. It is
 * DERIVED now — change `rankLevelAdjust` and this follows.
 */
export const BOSS_LEVELS_ABOVE_ROOM = rankLevelAdjust(RANK_VALUE[ActorRank.Boss]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LEVEL EVERY BODY IN A ROOM IS BORN AT — `actor_adjust_level`, applied.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `zone.base_level + e:getRankLevelAdjust() + level.level - 1 + rng.range(-1,2)`,
 * the line quoted above. Four terms, and until now this file had two of them:
 * `delveLevel(spec, party) + floor - 1`.
 *
 * ═══ THE RANK TERM IS HOW UPSTREAM MAKES ONE BODY DANGEROUS ═══
 * Not by putting twenty more in the room. An elite is born two levels over the
 * floor and a boss three, and `rankLifeAdjust` then multiplies the life those
 * levels buy — so the thing with the ring under it is genuinely a different
 * creature rather than the same creature with a bigger number typed in.
 *
 * ═══ THE JITTER IS NOT DECORATION ═══
 * `rng.range(-1, 2)` is asymmetric: it can take one level off and add two, mean
 * +0.5. So a floor holds bodies at three different levels and leans UP. A room
 * of identical bodies reads as a spawn table; a room where one of them is
 * visibly harder than its neighbours reads as a place. It costs one labelled
 * draw per body.
 *
 * THE FLOOR OF 1 IS OURS. `rng.range(-1,2)` on a base_level-1 zone can ask for
 * level 0, and a level-0 body divides through the life curve as one that never
 * levelled — harmless-looking rather than loud. Upstream never meets it because
 * no ToME zone has `base_level` 1 with a rank-1 resident; the Undermost does.
 */
export function actorAdjustLevel(
  rng: Rng,
  label: string,
  baseLevel: number,
  rank: ActorRank,
  floor: number,
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AND THE ONE ZONE THAT MULTIPLIES ITS DEPTH — `DelveSpec.depthScale`.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The Trollmire line above is seventy-nine zones' line. The Infinite Dungeon
   * writes its own:
   *
   * ```lua
   * actor_adjust_level = function(zone, level, e)
   *     return math.floor((zone.base_level + level.level-1) * 1.2)
   *            + e:getRankLevelAdjust() + rng.range(-1,2) end
   * ```
   *
   * — `data/zones/infinite-dungeon/zone.lua:28`. Same four terms, and the first
   * two are multiplied before the other two are added: `math.floor` of the
   * product, THEN rank, THEN the jitter. It is the only thing making a tower
   * with no bottom get harder faster than a straight line, and without it a
   * floor-50 body would be level 50 where upstream's is 60, widening forever.
   *
   * ONE, WHICH IS EVERY OTHER ZONE, and `Math.floor` of an integer times one is
   * that integer — so the default is not an approximation of the old line, it
   * IS the old line. See `DelveSpec.depthScale`.
   */
  depthScale = 1,
): number {
  const jitter = rng.int(label, -1, 2);
  const depth = Math.floor((baseLevel + floor - 1) * depthScale);
  return Math.max(1, depth + rankLevelAdjust(RANK_VALUE[rank]) + jitter);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WHERE A COUNT COMES FROM — AND IT IS NO LONGER "THE ZONE THIS DELVE IS".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every `nbNpc` in `DELVES` is an upstream `nb_npc`, read off a zone file. For
 * a long time the zone it was read off was the zone the site's FLOOR is built
 * from (`shared/mapgen/zones.ts` names those), and nothing checked that the
 * level we stand the delve at is a level upstream builds that count for. It
 * mostly was not. The Underworks carried orc-breeding-pit's forty to fifty —
 * `level_range = {30, 60}` — at level three. The Hollow Mine carried
 * ardhungol's seventy to eighty, `{25, 32}`, at level nine.
 *
 * `NB_NPC_SCALE`, a single global factor, WAS 0.85 and stood here to absorb
 * that. It could not: lowering it starves a delve standing above its band and
 * raising it kills you in one standing below, and the measured sweep it was set
 * from was PEAKED for exactly that reason. It is deleted. This field is what
 * replaced it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIRST, THE THING THAT MAKES "GIVE EACH DELVE ITS ZONE'S BAND" THE WRONG FIX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EVERY ToME ZONE THAT ROLLS A POPULATION IS `level_scheme = "player"`.
 * Counted over the tree: eighty-one zone files carry an `nb_npc` and
 * seventy-eight of them set it (`data/zones/orc-breeding-pit/zone.lua:23`,
 * `data/zones/ardhungol/zone.lua:23`, `data/zones/deep-bellow/zone.lua:23`, and
 * so on). The three that do not are two Sher'Tul fortresses whose count is
 * `{0, 0}` (`data/zones/shertul-fortress/zone.lua:46`) and a town
 * (`data/zones/town-lumberjack-village/zone.lua:41`) — none of them rolls
 * anybody onto a generated floor. `engine/Zone.lua:141-148` is
 *
 * ```lua
 * self.base_level = self.level_range[1]
 * if self.level_scheme == "player" then
 *     self.base_level = util.bound(plev, self.level_range[1], self.level_range[2])
 * ```
 *
 * so a zone's `level_range` is A CLAMP ON THE PLAYER'S OWN LEVEL, not a
 * statement of what level the content is. Inside the band, `base_level` IS the
 * player's level: the zone's `nb_npc` is the count upstream puts in front of a
 * character standing at exactly their own level. Outside it the clamp fires and
 * the zone stops being tuned for whoever walked in.
 *
 * THE COUNTS ARE THEREFORE ALMOST BAND-INDEPENDENT. Twenty-four of the
 * sixty-three fight-zone variants that state a count carry `{20, 30}`, and they
 * carry it at `{1, 5}`, `{7, 16}`, `{10, 25}`, `{15, 25}`, `{15, 26}`,
 * `{30, 40}`, `{30, 45}`, `{35, 45}` and `{45, 55}` alike. Moving our levels to
 * the source zones' bands would push a
 * twelve-delve overworld that spans one to fifteen up to twenty-five and sixty,
 * and it would be answering a question `level_range` does not ask.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SO THE RULE IS ABOUT THE COUNT, AND IT IS ONE RULE RATHER THAN TWELVE NUMBERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     A DELVE'S COUNT IS READ FROM AN UPSTREAM ZONE WHOSE `level_range`
 *     COVERS THE LEVEL WE PLACE THE DELVE AT. The zone's out-of-depth
 *     `filters` come with it, because `filters` sits inside `generator.actor`
 *     beside `nb_npc` and is half of the same answer. The SCATTER (`class`,
 *     `nb_spots`, `on_spot_chance`) does not: that is a fact about the shape
 *     of the room, and it stays with the zone the floor came from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE FLOOR'S SIZE IS NOT A SECOND CLAUSE. IT WAS, AND ToME REFUTES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This rule used to end "...AND WHOSE FLOOR IS THE SIZE WE BUILD — so the count
 * transfers as a DENSITY rather than as a bare number". That clause was OURS. It
 * was never checked against upstream, and upstream does not do it.
 *
 * `nb_npc` IS A PROPERTY OF THE ZONE, AND A FLOOR INHERITS IT WHATEVER SIZE IT
 * IS. Scanned over every `levels[n]` in the tree that changes a floor's
 * `width`/`height`, there are fifteen that also roll a population, and:
 *
 *   SIX KEEP THE COUNT EXACTLY. `data/zones/high-peak/zone.lua:190-207` is the
 *     plainest: six floors shrinking from 50x75 (`:191`) to 30x30 (`:206`) — a
 *     quarter of the ground — every one inheriting `{35, 40}` (`:64`), a
 *     four-fold density CLIMB authored on purpose as the zone gets worse.
 *     `data/zones/ardhungol/zone.lua:69` drops 60x60 to 40x40 and keeps
 *     `{70, 80}` (`:50`). And the limit case is
 *     `data/zones/orc-breeding-pit/zone.lua:83`: a 15x15 floor, `min_floor=120`
 *     written on the same line, inheriting `{40, 50}` (`:47`). FORTY BODIES ON A
 *     HUNDRED AND TWENTY WALKABLE TILES. Whatever upstream is doing with a
 *     count, it is not holding a density.
 *   NINE RESTATE IT, and only one of the nine is anywhere near proportional
 *     (`data/zones/sandworm-lair/zone.lua:134`, ground x0.36 and count x0.33).
 *     The rest move the count far less than the ground:
 *     `data/zones/maze/zone.lua:181` and `:186` are x0.11 ground and x0.20
 *     count, `data/zones/ancient-elven-ruins/zone.lua:68` and `:78` x11.1
 *     ground and x3.0 count.
 *
 * So a count is a NUMBER OF BODIES that belongs to a zone, and the density that
 * falls out of it is a property of the floor it lands on. The old clause did two
 * pieces of damage while it stood: it split the Hollow Mine's four floors across
 * two Maze layouts that upstream picks BETWEEN and never runs together
 * (`data/zones/maze/zone.lua:20`), and it condemned the Glass Archive as
 * permanently unalignable on a density objection that
 * `data/zones/orc-breeding-pit/zone.lua:83` had already answered.
 *
 * ═══ WHAT REPLACES IT: THE GROUND IS STATED, NOT ENFORCED ═══
 * `CountSource.floor`/`floorCite` carry the source zone's own `width`/`height`,
 * so every row says what ground its number was authored over and
 * `test/server/delve-alignment.test.ts` reads that off the Lua line too. Where
 * ours differs the row says so and by how much. That is the difference between
 * the density ToME built and the density we get, written down — which is what
 * the clause was really for, and all it could honestly be.
 *
 * ═══ WHAT THE RULE COSTS: THE IDENTITY OF A DELVE IS NOW A SPLIT ═══
 * After this a delve is not "a port of zone X". It is
 *
 *     generator + floor size + terrain palette + lighting from zone X;
 *     population count and its out-of-depth filter from zone Y, a zone
 *     upstream authors at this delve's level; roster ours.
 *
 * That split was already half-true — `zones.ts` has owned the generator and this
 * file the count since both existed — and the two were merely pretending to name
 * the same zone. IT IS A FIELD AND NOT A COMMENT (`countFrom`, below) so that
 * every row states its own split, `check:citations` proves the line exists, and
 * `test/server/delve-alignment.test.ts` opens that line in `reference/` and
 * proves it says what the row says it says.
 *
 * ═══ AND THE RATIOS SURVIVE, WHICH IS THE POINT OF SOURCING AT ALL ═══
 * Every band carries its own spread: `{1, 5}` runs `{7, 10}`
 * (`data/zones/slazish-fen/zone.lua:61`) to `{50, 60}`
 * (`data/zones/reknor-escape/zone.lua:50`), and `{7, 16}` runs `{20, 30}`
 * (`data/zones/daikara/zone.lua:56`) to `{50, 60}`
 * (`data/zones/maze/zone.lua:160`). The rule is KEEP EACH DELVE'S RANK WITHIN
 * ITS OWN LEVEL'S SPREAD — the Hollow Mine takes the Maze's counts rather than
 * Daikara's because it is the most crowded room on the moor and the Maze is the
 * most crowded thing `{7, 16}` states. That is still one rule. Twelve
 * hand-picked numbers is where this file started, and it is not where it is
 * going back to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NINE OF TWELVE DID NOT NEED A NUMBER CHANGED, AND THAT IS THE EVIDENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `{20, 30}` is upstream's answer for a 50x50 at every band from `{1, 5}` to
 * `{45, 55}`, so eight of the twelve rows re-cite the count they already carried
 * and place the identical band. Their drift was a CITATION defect, not a balance
 * defect — which is exactly why Barrow End, the Watcher's Altar, Cairnfoot and
 * Blackwood never behaved like broken rooms while the drift table said they
 * should. Four counts actually move, and they are the four extremes:
 *
 *     delve              was        is        why
 *     The Underworks     40-50      20-30     27 levels below its band
 *     The Hollow Mine    70-80      35-40     16 levels below its band
 *     The Glass Archive  12-16      20-30     6 levels ABOVE its band, and the
 *                                             only room that could not pay two
 *                                             levels at any factor
 *     The Weir           20-25      20-30     no zone states 20-25 at a band
 *                                             anywhere near six
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO THINGS THE RULE CANNOT REACH, BOTH NAMED RATHER THAN AVERAGED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There were three. The Glass Archive was the third, marked `CountFit.Unaligned`
 * because no 30x30 count could pay at level eleven and a 50x50 count on a 30x30
 * floor was refused on density. The refusal was the size clause's and the size
 * clause is gone, so the Archive takes `data/zones/halfling-ruins/zone.lua:50`
 * at `{10, 25}` and the label came off. `CountFit.Unaligned` now has NO members,
 * and the census in `test/server/delve-alignment.test.ts` asserts that, so
 * earning one back is a deliberate act with an argument attached.
 *
 * ONE — LEVEL SIX IS A GAP IN ToME. No upstream zone that GENERATES a floor and
 * rolls a population has a `level_range` covering six: the bands run `{1, 5}`
 * and then `{7, 16}`. The tables spanning six are the two arenas
 * (`data/zones/arena/zone.lua:22` `{1, 50}` and
 * `data/zones/arena-unlock/zone.lua:22` `{5, 12}`, neither of which rolls onto a
 * generated floor), the developer zone (`data/zones/test/zone.lua:22` `{1, 50}`,
 * whose count is `{0, 0}` at `:95`), three talent-summoned planes, a sixth town
 * that rolls nobody (`data/zones/town-point-zero/zone.lua:51`, `{0, 0}`), and
 * the five perpetual towns that do, whose `{10, 10}`
 * (`data/zones/town-derth/zone.lua:47`) populates a hand-drawn Static map
 * (`:42`, `towns/derth` at `:43`) with townsfolk. Cairnfoot and The Weir stand at
 * six. Both are marked `CountFit.Clamped` and BOTH CLAMP DOWN, to `{1, 5}` —
 * one step, which is what `engine/Zone.lua:141-148`'s own clamp hands a
 * level-six character. Down rather than up because `{1, 5}` is where upstream
 * writes a tier's whole spread, `{7, 10}` to `{50, 60}`, and because the
 * tier-one `max_ood` refusal comes with it; `{7, 16}` states three counts and no
 * filter at all. Cairnfoot takes heart-gloom, which is its own floor's zone, so
 * nothing about it splits; The Weir takes Murgol Lair, a dark 50x50 Roomer lair
 * of the things that live in ToME's water, which is what `WEIR` is. Neither
 * count moves by a body: `{20, 30}` either way.
 *
 * TWO — GEARFORD WARD AND THE REDACTED TOWNS HAVE NO BAND TO ALIGN. The
 * Infinite Dungeon is `level_range = {1, 1}` with `level_scheme = "player"` and
 * `max_level = 1000000000` (`data/zones/infinite-dungeon/zone.lua:25-27`), and
 * its bodies are levelled off the FLOOR NUMBER rather than off the band:
 * `actor_adjust_level` at `:28` is `floor((base_level + level.level-1) * 1.2)`.
 * Its count is a function of the floor's own area (`:255-256`, `nbNpcPerArea`).
 * `{1, 1}` is not a band, a drift against it is not a number, and those rows are
 * marked `CountFit.PlayerScheme`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE TWINS RE-CITE RATHER THAN INHERIT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Redaction twin is its original four levels up (`redactedSpec`). Three of
 * them land outside their original's band — the Underworks' at seven, Barrow
 * End's at nine and Cairnfoot's at ten, all sourced from `{1, 5}` zones — and
 * each takes its own `countFrom` at its own level. THE COUNT DOES NOT MOVE IN
 * ANY OF THE THREE: it is `{20, 30}` before and after, because `{20, 30}` is
 * what upstream states at `{1, 5}`, at `{7, 16}` and at `{10, 25}` alike. That
 * is the band-independence at the top of this note, demonstrated on our own
 * table rather than asserted.
 */

/** How a `countFrom` row's band stands to the level the delve is placed at. */
export const CountFit = {
  /**
   * The band covers our level. Upstream's clamp is a no-op there, so this count
   * is what it hands a character standing at exactly their own level.
   */
  Covers: 'covers',
  /**
   * Our level is ONE step outside the band, because upstream authors no
   * generated-floor population at it at all. Six, and only six — see the note
   * above. A row may not claim this without being exactly one level out, and
   * both rows that carry it clamp DOWN, to `{1, 5}`.
   */
  Clamped: 'clamped',
  /**
   * The band does not cover our level and no zone upstream states a count this
   * room could take. Argued at the site. A row claiming this MUST be out of
   * band, so the label dies the moment its cause does.
   *
   * ═══ IT HAS NO MEMBERS, AND THAT IS THE LABEL WORKING ═══
   * The Glass Archive carried it, on the ground that a 50x50 count on its 30x30
   * floor was denser than anything upstream builds. That was the size clause
   * talking and `data/zones/orc-breeding-pit/zone.lua:83` refutes it, so the
   * Archive took a band-covering count and the label came off by itself. The
   * census in `test/server/delve-alignment.test.ts` pins the count at zero: a
   * new one is a deliberate act with an argument, not a place to put a room
   * nobody wants to think about.
   */
  Unaligned: 'unaligned',
  /**
   * The source's `level_range` is not a band at all: `level_scheme = "player"`
   * with an unbounded `max_level`, whose bodies are levelled off the floor
   * number. The Infinite Dungeon, and only it. Requires `nbNpcPerArea` on the
   * spec, because that is the mechanism that makes its count level-independent.
   */
  PlayerScheme: 'player-scheme',
} as const;

export type CountFit = (typeof CountFit)[keyof typeof CountFit];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE ONE BAND IN `DELVES` WAS READ FROM — the citation, as data.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `cite` and `bandCite` are ordinary `file.lua:line` citations, so
 * `npm run check:citations` proves the line exists, and
 * `test/server/delve-alignment.test.ts` opens that line in `reference/` and
 * proves it says what this row says it says. That is the half `check:citations`
 * cannot do — it can only prove a cited line EXISTS — and this file has already
 * shipped four `max_ood` citations that were each one line low, plus two
 * sentences invented outright, with the gate green throughout.
 */
export type CountSource = {
  /** The source zone's `level_range`. */
  readonly band: ZoneLevelRange;
  /** Where that `level_range` is written. */
  readonly bandCite: string;
  /** The source zone's `nb_npc`, verbatim — the band this delve places. */
  readonly nbNpc: readonly [number, number];
  /** Where that `nb_npc` is written. */
  readonly cite: string;
  /**
   * The source zone's own `width`/`height` — THE GROUND ITS COUNT WAS AUTHORED
   * OVER, which is not a constraint on what we may take and is not decoration
   * either. A count is a number of bodies (see the note above `CountFit`);
   * where this differs from the floor we build, the density differs by the same
   * ratio and the row is expected to say so in words.
   */
  readonly floor: readonly [number, number];
  /** Where that `width`/`height` pair is written. */
  readonly floorCite: string;
  /**
   * Which floors take this count, from 1. Absent means "every floor with no
   * override" — the row that `DelveSpec.nbNpc` itself states.
   */
  readonly floors?: readonly number[];
  /** `filters = { {max_ood=N} }` beside the count. Absent is no filter. */
  readonly maxOod?: number;
  /** Where that filter is written. Present exactly when `maxOod` is. */
  readonly maxOodCite?: string;
  /** How this band stands to the level the delve is placed at. */
  readonly fit: CountFit;
};

/** How a floor's bodies are scattered over it — upstream's `OnSpots` fields. */
export type SpotSpec = {
  /** `nb_spots`. engine/generator/actor/OnSpots.lua:36. */
  readonly nbSpots: number;
  /** `spot_radius`, default 5. engine/generator/actor/OnSpots.lua:31. */
  readonly spotRadius: number;
  /** `on_spot_chance`, default 70. engine/generator/actor/OnSpots.lua:30. */
  readonly onSpotChance: number;
};

/** What lives in one delve, and how much of it. */
export type DelveSpec = {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY BODIES — `nb_npc`, READ OFF THE ZONE EACH DELVE IS A PORT OF.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This field was called `monsters` and every value in it was authored here:
   * 2-2 for the Drowned Chapel, 8-10 for Blackwood. Measured against the
   * upstream zone each site is built as (`shared/mapgen/zones.ts` names them,
   * generator and level size included) the shortfall ran from 2.8x to 27.5x,
   * median ~5x, and the direction of the error was not even consistent — our
   * density ranged 0.10 to 1.45 bodies per 100 walkable tiles because the bands
   * were per-site constants while the floors vary from 276 to 2064 walkable
   * tiles. Density was an accident of which generator a site drew.
   *
   * ═══ SO IT IS `nb_npc` NOW, AND THE NAME IS UPSTREAM'S ON PURPOSE ═══
   * `engine/generator/actor/Random.lua:126` is
   * `for i = current, rng.range(self.nb_npc[1], self.nb_npc[2]) do generateOne()`
   * — one body per count, no area term, no headcount term.
   *
   * ═══ AND THE ZONE IT IS READ OFF IS `countFrom`, NOT THE SITE'S OWN ═══
   * It used to be the zone the site's FLOOR is built from, and the level we
   * stand the delve at was nobody's business. It is a zone whose `level_range`
   * covers that level now, and `countFrom` below is where the citation lives —
   * as data, so a test can read the Lua line rather than trust a comment.
   *
   * ═══ AND THE FLOORS ARE ALREADY UPSTREAM'S SIZE, WHICH IS WHY IT TRANSFERS ═══
   * `shared/sitemap.ts` builds each site at its zone's own `width`/`height`, so
   * the ground a count is spread over here is the ground it was tuned on there —
   * and `countFrom` will only take a count from a zone built at the size we
   * build, for exactly that reason. `forArea` still scales LITTER and TRAPS off
   * a 34x30 baseline — those bands are ours — and deliberately does not touch
   * this one.
   */
  readonly nbNpc: readonly [number, number];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE `nbNpc` AND `nbNpcByFloor` WERE READ FROM. ONE ROW PER BAND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The row with no `floors` states `nbNpc`; a row with `floors` states the
   * `nbNpcByFloor` entry for each of them. Every floor of every delve must be
   * covered by exactly one row, and each row's `nbNpc` must be the band the
   * placer actually uses on the floors it claims —
   * `test/server/delve-alignment.test.ts` drives `nbNpcFor` to check it rather
   * than reading the table.
   *
   * REQUIRED, NOT OPTIONAL. A spec without a source is a count nobody can check,
   * which is the state this file was in for the whole of its life.
   */
  readonly countFrom: readonly CountSource[];
  /**
   * `levels[n].generator.actor.nb_npc` — the zone's override for one floor
   * (`engine/Zone.lua:833-843` deep-merges it over the base table). Indexed by
   * floor from 1; a floor with no entry uses `nbNpc`.
   *
   * ONE OF OUR FLOOR ZONES CARRIES ONE THAT IS READ: the escape from Reknor's
   * last, `{0, 0}` (`reknor-escape/zone.lua:79`), because its bodies are drawn
   * on a static map instead. That is also the answer to "the tutorial's final
   * floor is empty": the floor is meant to hold no ROLLED population, and the
   * bug was that `populate` returned before placing anything at all — no boss,
   * no litter, no note.
   *
   * ═══ AND IT IS ALSO WHERE A DELVE WHOSE FLOORS CHANGE SIZE STATES ITS SECOND
   * COUNT. THE HOLLOW MINE IS THE ONLY ONE. ═══
   * Its floor 1 is 60x60 and its floors 2-4 are 40x40 (ardhungol's level 1 and
   * level 2, `shared/mapgen/zones.ts`), and a count only means a density on the
   * floor it was authored for. The Maze is authored at BOTH sizes inside one
   * band — `{50, 60}` on a 60x60 (`maze/zone.lua:160`) and `{35, 40}` on a 40x40
   * (`:49`) — so each of our floors takes the one built for its size. That is a
   * use of this field upstream does not make (its overrides are one zone's own
   * levels, not two layouts of it), and it is written down in the row.
   */
  readonly nbNpcByFloor?: ReadonlyMap<number, readonly [number, number]>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE ZONE THAT SCALES ITS COUNT WITH AREA, AND ITS OWN CONSTANT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tome/data/zones/infinite-dungeon/zone.lua:255-256`:
   *
   * ```lua
   * local enemy_count = layout.enemy_count or math.ceil(vx * vy * 34/4900)
   * data.generator.actor.nb_npc = {enemy_count-5, enemy_count+5}
   * ```
   *
   * — and the "building" layout, which Gearford Ward is built as, overrides the
   * numerator to 60 (`:161`, commented *"more room for enemies and more cover on
   * this map"*). This field is that numerator; the `±5` band is upstream's and
   * is not authored per site.
   *
   * IT IS THE EXCEPTION THAT PROVES THE RULE. A previous attempt scaled EVERY
   * delve's count by floor area and made nearly every one unclearable. Upstream
   * area-scales in exactly one zone, the one whose floor size is itself rolled
   * per level (`infiniteDungeonSize`, `shared/mapgen/building.ts`) — everywhere
   * else `nb_npc` is a flat band on a fixed level size.
   */
  readonly nbNpcPerArea?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ROSTER — a zone's `npcs.lua` list, WEIGHTED, no longer a cycle.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It used to be walked as `roster[i % roster.length]`, which made the array's
   * LENGTH AND ORDER the whole of the composition rule: three entries filled a
   * room of seven with one of each, a floor could not change what was in it as
   * you descended, and `WEIR` had to spell 5:5:1 out in eleven repeated entries
   * because there was nowhere to write a weight down.
   *
   * It is upstream's candidate list now. `computeRarities` weights each member
   * by its own `rarity` and `levelRange` against the floor's level and
   * `pickEntity` draws one per body (`engine/Zone.lua:205-262`, `:318-330`) —
   * the same two functions the loot path has used since the item pass.
   *
   * ORDER IS STILL SEED CONTRACT (the cumulative array is walked in it), but it
   * no longer decides anything about composition.
   *
   * ═══ AND NO PER-FAMILY `rarity(add)` IS APPLIED — A LABELLED DIVERGENCE ═══
   * A ToME zone tunes its roster by re-weighting whole FAMILIES as it loads them
   * (`tome/data/zones/trollmire/npcs.lua:21-30`: `rarity(5)` on rodents,
   * `rarity(0)` on canines, `rarity(4, 35)` on the catch-all — `engine/Entity.lua:1182`
   * is `ceil(rarity * mult + add)`). Ours are three-entry hand-authored lists
   * rather than eight family loads, and there is no honest correspondence for
   * most of them, so every member keeps its source entity's own `rarity`
   * unmodified — which is `rarity(0)`, upstream's own no-op and the commonest
   * line in those files.
   */
  readonly roster: readonly MonsterTemplate[];
  /**
   * HOW THE BODIES ARE SCATTERED. Absent is `mod.class.generator.actor.Random`,
   * which draws each body uniformly over the whole map and independently of
   * every other (`Random.lua:112-117`) — eleven of our twelve zones.
   *
   * Present is `OnSpots`: pick `nb_spots` spots, and each body has
   * `on_spot_chance` percent of being born within `spot_radius` of one of them
   * (`engine/generator/actor/OnSpots.lua:30-38, 43-56`). ONE of our twelve uses
   * it — the Trollmire, which Blackwood Outskirts is built as.
   */
  readonly spots?: SpotSpec;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW FAR OUT OF DEPTH A BODY MAY BE — `filters = { {max_ood=2} }`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `engine/Zone.lua:306`:
   *
   * ```lua
   * if filter.max_ood and resolvers.current_level and e.level_range and
   *    resolvers.current_level + filter.max_ood < e.level_range[1] then ... return false end
   * ```
   *
   * A HARD REFUSAL ON TOP OF THE WEIGHT. `computeRarities` already makes an
   * under-depth candidate rare — divided by `3 x levelsBelow` — but rare is not
   * never, and a zone that does not want its floor-one player meeting a
   * floor-fifteen body says so with this instead of hoping the division is
   * enough.
   *
   * ═══ IT COMES WITH THE COUNT NOW, AND THAT MADE IT A TIER-1 DEVICE ═══
   * `filters` sits inside `generator.actor` beside `nb_npc`, so it is part of
   * the same answer to "who may stand on this floor and how many" and it is
   * sourced with it (`countFrom.maxOod`). Read off the aligned sources rather
   * than off the zones our floors are drawn from, the pattern is stark and is
   * upstream's own: EVERY `{1, 5}` zone carries `max_ood = 2` —
   * `data/zones/blighted-ruins/zone.lua:54`, `data/zones/deep-bellow/zone.lua:49`,
   * `data/zones/norgos-lair/zone.lua:58`, `data/zones/heart-gloom/zone.lua:77`,
   * `data/zones/ruins-kor-pul/zone.lua:56`, `data/zones/reknor-escape/zone.lua:51`,
   * `data/zones/scintillating-caves/zone.lua:54` — and NOTHING at `{7, 16}`,
   * `{10, 25}` or `{15, 25}` carries one: not daikara, not the Maze, not
   * halfling-ruins, not mark-spellblaze. The filter protects a beginner, and
   * upstream stops protecting you after the first tier. The one exception is the
   * Infinite Dungeon at 6 (`data/zones/infinite-dungeon/zone.lua:89`), the zone
   * whose whole job is to hand you something over your head.
   *
   * ABSENT IS NO FILTER, which is upstream's own default.
   *
   * ═══ AN EARLIER LIST HERE HAD FOUR LINES POINTING AT `nb_npc + 2`, AND TWO
   * SENTENCES INVENTED OUTRIGHT. `check:citations` PASSED ALL OF THEM. ═══
   * The four `max_ood` lines were each one line low — a guessed offset, not a
   * read — and this paragraph used to say old-forest "passes an empty one
   * (`old-forest/zone.lua:59`)" and lake-nur "a `special_rarity` one
   * (`lake-nur/zone.lua:56`)". `:59` is old-forest's `guardian` line and its
   * `filters = { {} }` at `:65` belongs to the OBJECT generator; `:56` is
   * lake-nur's `object = {`, and the `special_rarity` filter at `:91` is inside
   * the FLOODED variant, which our Weir is not built from. The conclusion —
   * neither zone gets a `maxOod` — was right, which is exactly why nobody
   * checked. `tools/check-citations.mjs` can only prove a cited line EXISTS.
   * `test/server/delve-alignment.test.ts` is the half that was missing: it opens
   * every `countFrom` line in `reference/` and reads the value off it.
   */
  readonly maxOod?: number;
  /**
   * Things lying on the floor before anybody arrives.
   *
   * A DELVE IS NOT ONLY A FIGHT. Somewhere with loot on the ground is somewhere
   * worth exploring rather than clearing, and it is the cheapest way to make a
   * room reward the corner you did not have to walk into.
   */
  readonly litter: readonly [number, number];
  /**
   * How many traps are under this floor — upstream's `nb_trap`, a per-zone band.
   *
   * ABSENT MEANS NONE, which is both the common case and the gentlest room's
   * deliberate answer: `data/zones/trollmire/zone.lua:83` gives ToME's opening
   * zone `nb_trap = {0, 0}`. Optional rather than `[0, 0]` so that a delve
   * without traps takes no draw at all and its floor is byte-identical to the
   * one it generated before traps existed.
   */
  readonly traps?: readonly [number, number];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND ONE THING THAT IS PUT THERE RATHER THAN ROLLED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `roster` is a weighted draw and `nbNpc` is a count, so everything else in a
   * delve is a die falling — which is right for the population of a room and
   * wrong for the reason a room exists. A boss is not a heavier entry in a list;
   * it is the thing the door was for. It carries no `rarity` and no `levelRange`
   * for exactly that reason, which is upstream's own way of marking an entity
   * that is never rolled (`engine/Zone.lua:214`, `crystal.lua:73`).
   *
   * ABSENT ON EVERY SPEC BUT ONE, which is what keeps it meaning anything: a
   * boss in each of the rooms is a difficulty tier, not a set piece.
   */
  readonly boss?: MonsterTemplate;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THERE IS A BOSS IN HERE AND IT IS NOT IN `boss` — the Undermost's warden.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `populateDelve` places `spec.boss` on the furthest tile from the door; the
   * Undermost's warden is DRAWN ON THE MAP instead, by glyph, because upstream's
   * last level of Escape from Reknor is a static map with its bodies painted on
   * it (`data/maps/zones/reknor-escape-last.lua:34-35`). That is the right
   * mechanism and it is not changing.
   *
   * WHAT IT BROKE IS THE GRADE. `dangerWord`'s one shortcut for "this room has a
   * set piece" is `spec.boss !== undefined`, so the tutorial published to the
   * world map as `quiet` — the gentlest word the game owns — for a room holding
   * a rank-4 body with four hundred and thirty hit points. That did not matter
   * while the Undermost was on no map; item 7 put a marker on it.
   *
   * A FLAG AND NOT A SECOND `boss` FIELD, because the alternative is handing
   * `DELVES` a template that `populateDelve` would then also place: two wardens,
   * one of them in the wrong room.
   */
  readonly drawnBoss?: true;
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
   * `nbNpc` and `litter` are bands because a room's POPULATION should vary.
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW DEEP, WHEN THE TIER CANNOT SAY — upstream's `max_level`, stated.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `floorsOf` reads a delve's depth off the tier its level falls in, because a
   * delve names a level rather than an upstream zone and every ToME zone in
   * that tier is the same depth. ONE ZONE IN THE GAME BREAKS THAT, and it is
   * the one whose whole point is that it does: the Infinite Dungeon is
   * `max_level = 1000000000` (`data/zones/infinite-dungeon/zone.lua:27`) with a
   * `level_range` of `{1, 1}`, so the tier rule would call it three floors deep
   * and a party would find the way down withheld at the bottom of floor 3.
   *
   * ABSENT ON EVERY OTHER ROW, and it must stay that way unless a row can cite
   * a `max_level` that its tier gets wrong: this field is an override of a rule
   * that is right eleven times out of twelve, and a table full of them would be
   * the rule deleted one row at a time.
   */
  readonly maxFloors?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW FAST DEPTH TURNS INTO LEVELS — the ×1.2 in one zone's own line.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `math.floor((zone.base_level + level.level-1) * 1.2)`
   * (`data/zones/infinite-dungeon/zone.lua:28`) where every other zone here
   * writes `zone.base_level + level.level-1` — see `actorAdjustLevel`, which
   * takes this as its last argument and defaults it to 1.
   *
   * IT IS THE WHOLE DIFFICULTY CURVE OF A PLACE WITH NO BOTTOM. Upstream's
   * Infinite Dungeon is entered at any character level and admits everybody
   * (`level_range = {1, 1}`, `level_scheme = "player"`, `:25-26`), so `base_level`
   * is pinned at 1 for every character forever (`engine/Zone.lua:141-148` is
   * `util.bound(plev, 1, 1)`) and ALL of its danger comes from the floor number.
   * A straight line would put a floor-50 body at 50; upstream puts it at 60, and
   * the gap grows without limit. The multiplier is not a tuning knob we chose.
   *
   * NOTHING CLAMPS IT AND NOTHING NEEDS TO. `actorAdjustLevel` floors at 1 and
   * the life curve is monotonic; the ceiling in this game is
   * `MAX_CHARACTER_LEVEL`, which bounds the PLAYER and says nothing about how
   * deep a floor may be.
   */
  readonly depthScale?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `infinite_dungeon = true` — and the OTHER half of `depthScale`'s bargain.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `data/zones/infinite-dungeon/zone.lua:33`, the only zone upstream that sets
   * it, and it is read in exactly one place: `Actor.lua:6519` picks a SECOND
   * rank ladder for `worthExp` (`shared/progression.ts` `RANK_WORTH_INFINITE`).
   * An ordinary body pays 2 there instead of 0.8, an elite 3.5 instead of 3 and
   * a boss 6 instead of 25.
   *
   * ═══ WHY IT IS A SEPARATE FIELD FROM `depthScale` AND NOT THE SAME FLAG ═══
   * They are two lines of the same table five apart (`:28` and `:33`) and today
   * exactly one row carries both, so one field would work and would be wrong:
   * `:28` is read by `actorAdjustLevel` and is a number a future zone could
   * want at 1.1, while `:33` is a boolean upstream reads in a different file for
   * a different purpose. Upstream keeps them apart; so does this.
   *
   * ═══ AND IT SHIPPED HALF-DONE ONCE, WHICH IS WHY THIS NOTE IS LONG ═══
   * The Tower landed with `depthScale` and without this, so it took the
   * difficulty half of upstream's bargain and left the payout. Measured on the
   * built floors: clearing one paid 0.57-1.15 character levels from floor 10
   * down against the 1.2 a floor the bodies gain, so a descending party fell
   * behind about 0.2 levels per floor and never caught up. `progression.ts`'s
   * own note had named `:6519` and ported past it — correctly, on the day it
   * was written, because there was no infinite dungeon then.
   *
   * It reaches the payout on the BODY (`MonsterActor.infiniteDungeon`), set by
   * `populateDelve` from this field, because `payParty` is handed a corpse and
   * has no zone to ask.
   */
  readonly infiniteDungeon?: true;
};

/** The common roster. Husks with a wraith or two behind them. */
/**
 * TWO ENTRIES, AND IT WAS THREE — `[HUSK, HUSK, WRAITH]`. The second husk was
 * how a CYCLE said "twice as many husks as wraiths"; the list is weighted now
 * (`computeRarities`), and upstream's own weights are `rarity = 1` on the giant
 * brown ant (`ant.lua:57`) and `rarity = 1` on the losgoroth
 * (`losgoroth.lua:62`) — one to one. The duplicate would double a weight nobody
 * wrote down.
 */
const RANK_AND_FILE: readonly MonsterTemplate[] = [INDEX_HUSK, INDEX_WRAITH];
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
 * over, and no delve has that water: the Weir's seabed and Blackwood's ponds
 * are walked through — so in the Drowned Chapel it is a weak
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
 * not a roll: `populateDelve` walked the roster as a CYCLE then, so three monsters
 * in a three-entry roster was one of each, every time. The Wraith was guaranteed.
 * (The roster is a rarity-weighted draw now and this room's is two entries, so a
 * wraith is no longer even a candidate here — the fix below is what removed it,
 * and the draw is what stops the next one being guaranteed.)
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
/**
 * TWO ENTRIES NOW. The second husk was the cycle's way of saying "mostly husks",
 * and the argument above it — a beginner must not be guaranteed a wraith — is
 * carried by the ROSTER not containing one, not by the repeat. Upstream weights
 * the red crystal and the giant brown ant the same (`crystal.lua:100`,
 * `ant.lua:57`, both `rarity = 1`), so the room is half and half.
 */
const DROWNED: readonly MonsterTemplate[] = [INDEX_CAIRN, INDEX_HUSK];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WEIR: WHAT BREATHES THE WATER, AT UPSTREAM'S WEIGHTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Weir is `lake-nur` level 2, and that level draws only from `water_rarity`
 * (data/zones/lake-nur/zone.lua:91), which is `aquatic_critter.lua`'s own
 * `rarity` renamed as it loads (data/zones/lake-nur/npcs.lua:20). It shared
 * `DROWNED` until now, and on a floor that is all water the husks had nowhere
 * they could breathe: every body placed was a cairn. See the region header
 * above `INDEX_RIBBON` in content/monsters.ts for the three and what is not
 * ported.
 *
 * ═══ 5 : 5 : 1, AND THE PLACER DOES NOT ROLL ═══
 * `engine/Zone.lua:217-221` weights an entity inside its level range at
 * `floor(10000 / rarity)`: the eel and the squid 10000, the turtle 2000. So one
 * body in eleven is a turtle and the rest split evenly. That is the ratio AMONG
 * THE THREE. Upstream's draw also holds five creatures whose talents are not
 * ported, weighted in even where their level floor is above the room's, and the
 * three are 72% of it here and 56% on the twin: see the region header above
 * `INDEX_RIBBON`.
 *
 * ═══ AND THE LIST NO LONGER HAS TO SPELL THAT OUT ═══
 * `populateDelve` used to walk this as a CYCLE (`roster[i % roster.length]`), so
 * the weighting WAS the list's length and order: eleven entries, five of each and
 * one turtle, with the turtle sixth so that a room of `n` held `round(n / 11)` of
 * them. Every one of those decisions was a workaround for having nowhere to write
 * a weight down.
 *
 * `computeRarities` reads each creature's own `rarity` now and `pickEntity` draws
 * from the cumulative list, so three entries carry the same 5 : 5 : 1 and carry it
 * where upstream put it. `test/server/weir-roster.test.ts` asserts the computed
 * shares — 45.45% : 45.45% : 9.09% — and draws six hundred bodies to check them.
 */
/**
 * THREE ENTRIES, AND IT WAS ELEVEN. The eleven spelled 5 : 5 : 1 out in repeats
 * because a CYCLE has no other way to carry a weight — the docblock above says
 * so in as many words, and works out where the turtle has to sit for a room of
 * four to six to hold the right number of them. None of that is needed now:
 * `computeRarities` reads `rarity` off each creature (`aquatic_critter.lua:48`,
 * `:95`, `:71` — 1, 1 and 5) and `engine/Zone.lua:217-221` turns those into
 * 10000 : 10000 : 2000, which is the same 5 : 5 : 1 stated where it came from.
 */
const WEIR: readonly MonsterTemplate[] = [INDEX_RIBBON, INDEX_INKWELL, INDEX_STRONGBOX];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWELVE, AND THEY ARE MEANT TO BE TOLD APART
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The map acquires a difficulty gradient it did not have: Blackwood is a walk for
 * somebody who has earned it, the Outer Index is not. That gradient is the entire
 * reason a player picks one marker over another, and before there was one every
 * marker was worth exactly the same as every other one — nothing.
 *
 * ═══ AND IT IS THE `levelRange` COLUMN, NOT THE COUNT ═══
 * It used to be read down the `monsters` column, which worked while every band
 * in this table was authored here. The bands are upstream's `nb_npc` now, taken
 * from a zone whose band covers the level we place each delve at (`countFrom`),
 * and a count is a fact about a ZONE rather than about danger. Eight of the
 * twelve state the identical `{20, 30}` — at levels one, three, five, six, six,
 * seven, eleven and fifteen — so the column no longer sorts anything at all. What orders the map is the level every body in a room is born at
 * — `delveLevel`, which `actor_adjust_level` feeds and `rankLifeAdjust` compounds
 * — and `dangerWord` reads that column now.
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
    {
      /**
       * THE FLOOR IS halfling-ruins (`shared/mapgen/zones.ts`) AND THE COUNT IS
       * NOT, and the count did not move by a body.
       *
       * halfling-ruins is `level_range = {10, 25}`
       * (`data/zones/halfling-ruins/zone.lua:22`) and this room is level one:
       * nine levels of drift, and it read `{20, 30}` off that zone anyway. The
       * Blighted Ruins is the same 50x50 (`:28`) Roomer (`:38`) at `{1, 5}`
       * (`:22`) and states the same `{20, 30}` — because `{20, 30}` is what
       * upstream states for a 50x50 at every band it has. The drift was a
       * citation defect and this room was never the broken one.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/blighted-ruins/zone.lua:22',
          nbNpc: [20, 30],
          cite: 'data/zones/blighted-ruins/zone.lua:53',
          floor: [50, 50],
          floorCite: 'data/zones/blighted-ruins/zone.lua:28',
          maxOod: 2,
          maxOodCite: 'data/zones/blighted-ruins/zone.lua:54',
          fit: CountFit.Covers,
        },
      ],
      // AND THE FILTER CAME WITH IT — every `{1, 5}` zone carries `max_ood = 2`
      // and this room had none, because halfling-ruins passes no filter at all.
      // Inert on this roster (`DROWNED` is two entities both `levelRange` `[1,
      // undefined]`), and kept anyway: it is half of the sourced answer, and the
      // day a deep creature joins this roster it is the line that keeps it out
      // of the room the first case sends every new character to by name.
      maxOod: 2,
      roster: DROWNED,
      litter: [1, 2],
      levelRange: [1, 1],
    },
  ],
  //     NOT ON ANY MAP. Where a new character wakes: upstream's Escape from
  //     Reknor, `level_range = {1, 5}` and three levels
  //     (data/zones/reknor-escape/zone.lua:22-24). The gentlest roster, and the
  //     Drowned Chapel's band exactly: at a third foe the worst roll left a
  //     level-1 body a quarter of its life, under the margin every character's
  //     first room has to leave (test/server/first-room.test.ts).
  [
    'site:undermost',
    {
      // reknor-escape. `nb_npc = {50, 60}` — data/zones/reknor-escape/zone.lua:50.
      // THE DENSEST ZONE IN THE WHOLE OF ToME'S FIRST TIER, and it is the one a
      // character wakes up in: you are meant to run for the stairs, not clear it.
      nbNpc: [50, 60],
      // `filters = { {max_ood=2} }` — reknor-escape/zone.lua:51.
      maxOod: 2,
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE FIRST TWO FLOORS ARE POPULATED LIKE AN ORDINARY TIER-1 ZONE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `{20, 30}`, which is the band EVERY other `level_range = {1, 5}` zone in
       * ToME carries: the Trollmire (`trollmire/zone.lua:197`), the Heart of the
       * Gloom (`heart-gloom/zone.lua:76`), the Rhaloren camp
       * (`rhaloren-camp/zone.lua:53`) and the Ruins of Kor'Pul
       * (`ruins-kor-pul/zone.lua:55`). Not the escape from Reknor's own 50-60.
       *
       * ═══ BECAUSE THE TWO THINGS THAT PAY FOR 50-60 ARE NOT PORTED ═══
       * Upstream's escape is the only tier-1 zone at that density and it does
       * not hand a lone level-1 character to it. `reknor-escape/zone.lua:85-95`:
       *
       * ```lua
       * on_enter = function(lev, old_lev, new_zone)
       *     if lev == 2 then
       *         game.player:forceLevelup(2)
       *         local norgan = game.party:findMember{type="squadmate"}
       *         if norgan then norgan:forceLevelup(2) end
       * ```
       *
       * The player is force-levelled on each descent, and NORGAN WALKS WITH THEM
       * and is levelled too.
       *
       * ═══ HALF OF THAT HAS LANDED SINCE, AND THIS NOTE SAID IT NEVER WOULD ═══
       * It read *"we have neither: `forceLevelup` is unported and there is no
       * escort"*. `forceLevelup` IS ported — `shared/progression.ts` has the
       * rule, `AuthoredMap.forceLevel` carries it, `realms.ts` sets it on every
       * floor of this site from the second down, and `turn-engine.ts` pays it on
       * arrival with upstream's full heal. The note was written before that and
       * went on arguing from its absence, which is the failure mode a deferral
       * note has: *"we cannot because we lack Y"* outlives Y shipping.
       *
       * ═══ AND THE HALF THAT IS STILL TRUE IS THE HALF THAT MATTERS HERE ═══
       * THERE IS NO ESCORT, and `forceLevel` is only set from floor 2 — because
       * upstream's `on_enter` only fires from `lev == 2`. So FLOOR ONE, which is
       * the room every character in this game wakes up in, gets neither of the
       * two things that pay for fifty to sixty bodies. That is what this
       * override is still for, and it is now a claim about floor 1 alone.
       *
       * ═══ THIS IS THE ROW THAT REVERTS ═══
       * The day the escort lands — the tutorial lane's work — this override
       * comes out and the Undermost carries `nbNpc` like everything else. It
       * was a separate divergence from the global `NB_NPC_SCALE`, and it
       * outlived it: that factor is deleted and this row is not, because it is
       * one cited count about one floor rather than one uncited number about
       * twelve delves.
       */
      // And `levels[3].generator.actor.nb_npc = {0, 0}` — reknor-escape/zone.lua:79.
      // The last level is a STATIC map with its bodies drawn on it
      // (`data/maps/zones/reknor-escape-last.lua`), so nothing is rolled there.
      // Ours is `UNDERMOST_LAST_FLOOR` and its bodies are the tutorial lane's.
      nbNpcByFloor: new Map<number, readonly [number, number]>([
        [1, [20, 30]],
        [2, [20, 30]],
        [3, [0, 0]],
      ]),
      /**
       * THE ONE DELVE WHOSE FLOOR ZONE ALREADY STOOD AT THE RIGHT LEVEL. The
       * escape from Reknor is `{1, 5}` and this is level one, so the base row
       * needs nothing re-sourced; the `{20, 30}` override above is the one that
       * has to name a different zone, and it names the Ruins of Kor'Pul —
       * `{1, 5}`, 50x50, the first of the four tier-1 zones the note above
       * already cites.
       *
       * (The Ruins of Kor'Pul scatters on spots rather than uniformly,
       * `ruins-kor-pul/zone.lua:54`. That does NOT come with the count: see
       * `DelveSpec.spots` and the rule at the top of this file. The floors here
       * are the escape's, so the scatter is the escape's.)
       */
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/reknor-escape/zone.lua:22',
          nbNpc: [50, 60],
          cite: 'data/zones/reknor-escape/zone.lua:50',
          floor: [50, 50],
          floorCite: 'data/zones/reknor-escape/zone.lua:27',
          maxOod: 2,
          maxOodCite: 'data/zones/reknor-escape/zone.lua:51',
          fit: CountFit.Covers,
        },
        {
          floors: [1, 2],
          band: [1, 5],
          bandCite: 'data/zones/ruins-kor-pul/zone.lua:25',
          nbNpc: [20, 30],
          cite: 'data/zones/ruins-kor-pul/zone.lua:55',
          floor: [50, 50],
          floorCite: 'data/zones/ruins-kor-pul/zone.lua:30',
          maxOod: 2,
          maxOodCite: 'data/zones/ruins-kor-pul/zone.lua:56',
          fit: CountFit.Covers,
        },
        {
          floors: [3],
          band: [1, 5],
          bandCite: 'data/zones/reknor-escape/zone.lua:22',
          nbNpc: [0, 0],
          cite: 'data/zones/reknor-escape/zone.lua:79',
          floor: [50, 50],
          floorCite: 'data/zones/reknor-escape/zone.lua:27',
          maxOod: 2,
          maxOodCite: 'data/zones/reknor-escape/zone.lua:51',
          fit: CountFit.Covers,
        },
      ],
      roster: DROWNED,
      litter: [1, 2],
      levelRange: [1, 1],
      // THE WARDEN IS DRAWN ON THE MAP, NOT PLACED FROM HERE — `drawnBoss`.
      // `content/undermost.ts` paints him on a glyph of the last floor; this
      // field is what lets `dangerWord` know he is there, and it is the whole
      // reason the tutorial no longer publishes to the world map as `quiet`.
      drawnBoss: true,
    },
  ],
  //     19 steps.
  [
    'site:underworks',
    {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * FORTY TO FIFTY WAS A LEVEL-THIRTY ROOM'S COUNT, AND THIS IS LEVEL THREE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The worst drift in the table by a distance. The floor is the orc
       * breeding pit (`shared/mapgen/zones.ts`), whose `level_range` is
       * `{30, 60}` (`data/zones/orc-breeding-pit/zone.lua:22`), and this room
       * read its `{40, 50}` (`:47`) and stood at three — twenty-seven levels
       * below the shallowest character upstream ever hands that count to. It is
       * also the only count in our twelve that is illegal by the rule at any
       * level we use: the earliest band anywhere in ToME carrying `{40, 50}` is
       * `{15, 22}` (`data/zones/tempest-peak/zone.lua:22`, `:49`).
       *
       * ═══ AND UPSTREAM WROTE THE TIER-1 EDITION OF THIS EXACT ROOM ═══
       * The Deep Bellow is `{1, 5}` (`data/zones/deep-bellow/zone.lua:22`), a
       * 50x50 (`:27`) `Cavern` (`:37`) on `UNDERGROUND_FLOOR` and
       * `UNDERGROUND_TREE` (`:40-41`) — THE SAME GENERATOR CLASS, THE SAME
       * FLOOR SIZE AND THE SAME TWO GRIDS as the breeding pit (`:36`, `:27`,
       * `:39-40`). They differ in zoom (14 against 23), in `min_floor` (700
       * against 900, in the same map table) and in lighting — the Deep Bellow
       * sets `all_lited` (`:30`) and the pit does not — and in nothing else that
       * decides what the room IS. Upstream wrote both editions of it and we had
       * taken the count off the wrong one.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/deep-bellow/zone.lua:22',
          nbNpc: [20, 30],
          cite: 'data/zones/deep-bellow/zone.lua:48',
          floor: [50, 50],
          floorCite: 'data/zones/deep-bellow/zone.lua:27',
          maxOod: 2,
          maxOodCite: 'data/zones/deep-bellow/zone.lua:49',
          fit: CountFit.Covers,
        },
      ],
      // The breeding pit passes no filter; every `{1, 5}` zone does. Inert on
      // `RANK_AND_FILE`, whose two entities are both `levelRange` `[1,
      // undefined]` — kept because it is half of the sourced answer.
      maxOod: 2,
      roster: RANK_AND_FILE,
      litter: [2, 3],
      levelRange: [3, 3],
      traps: [1, 2],
    },
  ],
  // ─── worked places: more of them, and more to carry home ────────────────
  //     41 steps.
  [
    'site:watchers_altar',
    {
      /**
       * THE FLOOR IS THE RHALOREN CAMP AND THE COUNT IS DAIKARA'S — same band,
       * same 50x50 Roomer, same `{20, 30}`, six levels later.
       *
       * The camp is `{1, 5}` (`data/zones/rhaloren-camp/zone.lua:26`) and this
       * room is seven. Daikara is `{7, 16}`
       * (`data/zones/daikara/zone.lua:25`), 50x50 (`:30`), Roomer (`:41`) and
       * states the identical `{20, 30}` (`:56`). Not one body moves.
       *
       * ═══ AND `max_ood` COMES OFF, WHICH IS UPSTREAM'S OWN RULE ═══
       * The camp filters at 2 (`:54`); Daikara passes no filter, and neither
       * does anything else at `{7, 16}`. That is not an oversight in ToME — the
       * out-of-depth refusal is a tier-1 protection and upstream stops applying
       * it past the first tier. Inert here either way (`RANK_AND_FILE` is two
       * entities at `levelRange` `[1, undefined]`), so this is a change of
       * citation rather than of room.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [7, 16],
          bandCite: 'data/zones/daikara/zone.lua:25',
          nbNpc: [20, 30],
          cite: 'data/zones/daikara/zone.lua:56',
          floor: [50, 50],
          floorCite: 'data/zones/daikara/zone.lua:30',
          fit: CountFit.Covers,
        },
      ],
      roster: RANK_AND_FILE,
      litter: [2, 4],
      levelRange: [7, 7],
      traps: [1, 2],
    },
  ],
  //     61 steps.
  [
    'site:hollow_mine',
    {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE ONE ROW WHERE THE SPLIT COSTS SOMETHING, AND IT IS SAID OUT LOUD.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The floor is ardhungol — a 60x60 Cavern and then three 40x40s
       * (`shared/mapgen/zones.ts`) — and it stays ardhungol: the webbing, the
       * palette, the shape of the tunnels. THE COUNT IS THE MAZE'S, and a Maze
       * is not a spider hole. That sentence is the price of this row and there
       * is no version of it that is not paid.
       *
       * ═══ WHY THE COUNT COULD NOT STAY ═══
       * Ardhungol is `level_range = {25, 32}` (`data/zones/ardhungol/zone.lua:22`)
       * and this room is level nine. Its `{70, 80}` (`:50`) is what upstream
       * hands a character in the mid-twenties, and on our floors 2-4 — 40x40,
       * about 650 walkable tiles — that measured at ten bodies per hundred
       * walkable, twice the densest thing anywhere else on the moor. It is the
       * first delve to become uncompletable in every sweep ever run here.
       *
       * ═══ WHY THE MAZE AND NOT DAIKARA ═══
       * `{7, 16}` runs from `{20, 30}` to `{50, 60}`, and the rule is to keep
       * each delve's rank inside its own level's spread. This is the most
       * crowded room on the moor at its own floor size, and the Maze is the most
       * crowded thing `{7, 16}` states on ground anything like ours — so it
       * takes the Maze's count and not Daikara's `{20, 30}`.
       *
       * ═══ WHAT THAT RANK IS, MEASURED, AND IT IS NOT FIRST ═══
       * `{35, 40}` on our 40x40 floors is 5.6 to 5.7 bodies per hundred walkable
       * tiles (`tools/delve-density.mjs 4 --floors`), against a moor median of
       * 2.7. Two rooms are denser: Cairnfoot at 6.2, whose Octopus generator
       * walks only 404 of 2500 cells, and the Glass Archive at 9 to 10, which is
       * a 900-cell floor. BOTH OF THOSE ARE THE FLOOR AND NOT THE COUNT — all
       * three rooms carry a band upstream states, and the ground under them is
       * what differs. Rank inside a BAND is the thing this rule orders, and
       * inside `{7, 16}` the Maze is still above Daikara.
       *
       * ═══ AND THERE IS NO `Cavern` AT `{7, 16}` AT ALL ═══
       * Checked, zone by zone: the second tier is Roomers and Mazes. So the
       * generator could not have been matched either, and this row pays for
       * that in the sentence at the top rather than pretending otherwise.
       *
       * ═══════════════════════════════════════════════════════════════════════
       * ONE MAZE LAYOUT, NOT TWO: THE SPLICE WAS AN ARTEFACT OF THE SIZE CLAUSE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * This row used to take the DEFAULT layout's `{50, 60}` (`:160`) on floor
       * one because our floor one is 60x60, and the COLLAPSED layout's
       * `{35, 40}` (`:49`) on floors 2-4 because those are 40x40 — each floor
       * matched to the Maze authored at its size. `data/zones/maze/zone.lua:20`
       * is `game.state:alternateZone(short_name, {"COLLAPSED", 2})`: THOSE TWO
       * TABLES ARE ALTERNATIVES. Upstream rolls one of them per game and never
       * runs a DEFAULT first floor into a COLLAPSED second. Splicing them
       * produced a Maze that exists in no ToME game, and the note above
       * `CountFit` is where the clause that forced it is retired.
       *
       * ═══ AND COLLAPSED IS THE ONE THAT IS OUR SHAPE ═══
       * It is the only four-floor Maze upstream authors — `max_level = 4`
       * (`:27`) against DEFAULT's 2 (`:139`) — and its `levels` block (`:62-72`)
       * overrides no count on any of the four, so every floor of a four-floor
       * `{7, 16}` Maze carries `{35, 40}`. We have four floors. It states one
       * count for them and we take it for all four, which is what upstream does
       * with its own.
       *
       * ═══ AND OUR FIRST FLOOR IS 3600 CELLS AGAINST ITS 1600 ═══
       * Said rather than corrected, because a count is a number of bodies:
       * `data/zones/ardhungol/zone.lua:69` — this delve's own floor zone — runs
       * `{70, 80}` across exactly that step, 60x60 down to 40x40, without
       * touching the count. So floor one is the thin one here, 37 bodies over
       * about 1400 walkable tiles against 37 over about 660 below it, and the
       * delve gets worse as it goes down. That is the right direction and it is
       * the direction the spliced version ran backwards: floor one used to carry
       * 56 bodies and stopped the Watchman 2 runs in 4 while floors 2-4, denser
       * and deeper, went 4/4, 3/4 and 4/4.
       */
      nbNpc: [35, 40],
      countFrom: [
        {
          band: [7, 16],
          bandCite: 'data/zones/maze/zone.lua:25',
          nbNpc: [35, 40],
          cite: 'data/zones/maze/zone.lua:49',
          floor: [40, 40],
          floorCite: 'data/zones/maze/zone.lua:30',
          fit: CountFit.Covers,
        },
      ],
      roster: RANK_AND_FILE,
      litter: [2, 4],
      levelRange: [9, 9],
      traps: [2, 3],
    },
  ],
  // ─── quiet and wrong: fewer bodies, harder ones ─────────────────────────
  //     90 steps. The roster changes here, which is the real threshold on the
  //     map: from this marker outward, things bite.
  [
    'site:outer_index',
    {
      /**
       * ALREADY IN BAND, AND THE DRIFT TABLE SAID OTHERWISE FOR MONTHS.
       *
       * The Maze is `{7, 16}` and this room is ten, so it is the one delve that
       * never needed re-sourcing at all. The old table read it as "+3" because
       * it measured against `level_range[0]` — the FIXED-scheme base level — and
       * every ToME zone carrying an `nb_npc` is `player`-scheme, where the first
       * number is the bottom of a clamp rather than the level of the content.
       *
       * ═══ AND THE BAND'S CITATION NAMED THE WRONG TABLE ═══
       * It was `maze/zone.lua:25`, which is the COLLAPSED layout's
       * `level_range`. We build the DEFAULT layout (`shared/mapgen/zones.ts`
       * says `'maze DEFAULT'`), whose `level_range` is `:137`. Same two numbers,
       * different table — and `check:citations` verifies that a line exists, not
       * that it is the line the value was read from. This is the shape of defect
       * `countFrom` and its test exist for.
       *
       * Its `levels[2]` `{10, 12}` (`data/zones/maze/zone.lua:186`) is not
       * reachable: every floor here is maze level 1.
       *
       * ═══════════════════════════════════════════════════════════════════════
       * AND IT IS THE ONE DELVE WHERE THE FLOOR AND THE COUNT ARE THE SAME LINE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `zones.ts` builds it as `'maze DEFAULT'` and the count is that same
       * table's — one layout, one zone, no split at all. THAT IS WHY THE COUNT
       * DID NOT MOVE HERE even though the sweeps say this is the only room on
       * the map nobody finishes: zero clears in sixty-four solo runs, zero full
       * descents, and zero for a party of four Watchmen.
       *
       * ═══ BECAUSE IT IS NOT A DIFFICULTY, AND THAT IS MEASURED ═══
       * Every one of those is a STALL, not a wipe. `tools/delve-run.mjs`'s own
       * reachability diagnostic (`DELVE_DIAG=1`) reports every survivor
       * `reachable` at ranges out to fifty-four tiles, with five hundred of the
       * nine hundred turns spent moving. Driven at the same seeds with the turn
       * cap as the only lever — 900, 1800, 3600, 7200 — the Watchman goes 0/4,
       * 1/4, 2/4, 2/4 and HIS WORST HEALTH IS 68% AT EVERY ONE OF THEM.
       * Fifty-four bodies over 1800 walkable tiles is 3.0 per hundred — a
       * shade over this map's median of 2.7 and under a third of the Glass
       * Archive's. The room is not hurting anybody; a 900-turn probe cannot
       * sweep 3600 cells of corridor two tiles wide.
       *
       * So the count stays where the zone put it, and the thing that is short
       * here is the PROBE'S BAR — "clear" means exterminate, and no player
       * exterminates a maze. `levelling-curve.test.ts` scores this delve the
       * largest payer on the map at 3.4x two levels, which is the half a player
       * actually collects.
       */
      nbNpc: [50, 60],
      countFrom: [
        {
          band: [7, 16],
          bandCite: 'data/zones/maze/zone.lua:137',
          nbNpc: [50, 60],
          cite: 'data/zones/maze/zone.lua:160',
          floor: [60, 60],
          floorCite: 'data/zones/maze/zone.lua:142',
          fit: CountFit.Covers,
        },
      ],
      roster: DEEP,
      litter: [3, 4],
      levelRange: [10, 10],
      traps: [2, 3],
    },
  ],
  //     77 steps.
  [
    'site:glass_archive',
    {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE ROOM THAT WAS STARVED, AND THE LABEL THAT WAS HOLDING IT THERE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The floor is the Scintillating Caves' TWISTED layout, 30x30
       * (`data/zones/scintillating-caves/zone.lua:30`) — 900 cells, about 280
       * walkable, the smallest floor in the game — and it stays that. The COUNT
       * used to be that layout's too: `{12, 16}` (`:53`) at a `{1, 5}` band
       * (`:25`), read off a tier-one room and placed at level ELEVEN. It is the
       * starved end of the whole drift. A body pays linearly in its level
       * (`worthExp`) while `expChart` climbs quadratically, so sixteen bodies at
       * eleven paid 0.79 of the two levels this delve owes by its boss — the
       * only room on the moor that could not pay at any factor.
       *
       * ═══ IT WAS MARKED `Unaligned` ON A DENSITY ARGUMENT THAT WAS NOT ToME'S ═══
       * The refusal ran: every count that would pay is a 50x50 count, and
       * `{20, 30}` on 280 walkable tiles is nine bodies per hundred, "half again
       * denser than anything upstream builds anywhere". The second half of that
       * sentence is false. `data/zones/orc-breeding-pit/zone.lua:83` is a 15x15
       * floor with `min_floor=120` on the same line, inheriting `{40, 50}`
       * (`:47`) — FORTY BODIES ON A HUNDRED AND TWENTY WALKABLE TILES, three or
       * four times what this room is being refused. The clause that produced the
       * refusal was ours; it is retired in the note above `CountFit`, and the
       * label went with it. THAT IS THE ANTI-ROT MECHANISM WORKING: `Unaligned`
       * was written to die the moment its cause did.
       *
       * ═══ SO IT TAKES THE COUNT ITS OWN ROW ALREADY NAMED AS THE EXIT ═══
       * `data/zones/halfling-ruins/zone.lua:50` `{20, 30}`, band `{10, 25}`
       * (`:22`) — a band that starts at ten and covers both this room at eleven
       * and its twin at fifteen — on a 50x50 (`:27`). It is `{20, 30}`, which is
       * what upstream states at `{1, 5}`, `{7, 16}`, `{10, 25}` and `{15, 25}`
       * alike: the count ToME places when it is not making a point. It pays 1.4.
       *
       * ═══ AND THE FLOOR IS STILL THE UNUSUAL THING HERE, SAID PLAINLY ═══
       * Measured (`tools/delve-density.mjs 4 --floors`): 25 bodies over about
       * 250 walkable tiles, 9 to 10 PER HUNDRED on all four floors. THIS IS NOW
       * THE MOST CROWDED ROOM IN THE GAME — all eight of the densest floors
       * across both maps are this delve and its twin — against Cairnfoot's 6.2
       * and a moor median of 2.7. That is a consequence of a 900-cell floor and
       * not of the count: every other room carrying this band runs at 1.2 to
       * 3.8. Upstream's own small floors look exactly like this
       * (`data/zones/high-peak/zone.lua:206` is a 30x30 carrying `{35, 40}`,
       * MORE than this takes), and it is the character of the room: a tiny
       * bright vault, packed. The solo Watchman's cost is measured and real — he
       * went from four clears in four to three, taking 373 damage where he took
       * 131 — and in a party of four the room is cleared 3 of 4 times by one of
       * each class, which is the shape this game is played in.
       *
       * ═══ WHAT IT COSTS: THE ONE `max_ood` THAT DID ANYTHING COMES OFF ═══
       * The Caves filter at 2 (`:54`) and nothing at `{10, 25}` filters at all —
       * the refusal is a tier-one device (see `maxOod` on `DelveSpec`). It was
       * the only filter in the game that bit: at eleven with `DEEP` it rejected
       * `INDEX_HUSK_ELITE` (`[15, undefined]`) on floors 1-2 and admitted it
       * from floor 3, the single place where a roster changed with depth. Losing
       * it means the elite is drawn from floor one here. That is a real loss and
       * it is not this file's to make up: ten of the eleven bestiary templates
       * are `levelRange` `[1, undefined]`, so the rarity gate has nothing to gate
       * and NO sourcing decision can make floors escalate. That is
       * `content/monsters.ts`.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [10, 25],
          bandCite: 'data/zones/halfling-ruins/zone.lua:22',
          nbNpc: [20, 30],
          cite: 'data/zones/halfling-ruins/zone.lua:50',
          floor: [50, 50],
          floorCite: 'data/zones/halfling-ruins/zone.lua:27',
          fit: CountFit.Covers,
        },
      ],
      roster: DEEP,
      litter: [2, 3],
      levelRange: [11, 11],
      traps: [2, 3],
    },
  ],
  // ─── the far end ────────────────────────────────────────────────────────
  //     109 steps.
  [
    'site:gearford_ward',
    {
      // infinite-dungeon, the "building" layout (`zones.ts`). The base table is
      // `nb_npc = {29, 39}` (data/zones/infinite-dungeon/zone.lua:88) but
      // `alter_level_data` overwrites it per floor from the floor's own area
      // (:255-256) with the building layout's own numerator (:161) — see
      // `nbNpcPerArea`. The band below is the base table, used if a floor ever
      // reports no area.
      //
      // THE BUILDING LAYOUT'S OWN NUMERATOR, ASKED FOR RATHER THAN SPELLED.
      // `towerEnemyCountPerArea('building')` is `:161`'s 60, and it is the same
      // function `TOWER_SITE.populate` asks per floor — so this row and the
      // Tower cannot answer the same question differently.
      nbNpc: [29, 39],
      nbNpcPerArea: towerEnemyCountPerArea('building'),
      /**
       * AND IT IS THE ONE DELVE WITH NO BAND TO ALIGN, WHICH IS A FACT ABOUT THE
       * ZONE RATHER THAN AN EXEMPTION WE GRANTED IT.
       *
       * The Infinite Dungeon is `level_range = {1, 1}` with
       * `level_scheme = "player"` and `max_level = 1000000000`
       * (`data/zones/infinite-dungeon/zone.lua:25-27`): it admits everybody and
       * levels its bodies off the FLOOR NUMBER, not off the band —
       * `actor_adjust_level` at `:28` is
       * `floor((base_level + level.level-1) * 1.2)`. Its count is a function of
       * the floor's own area rather than a stated pair. `{1, 1}` is not a band
       * and a drift against it is not a number, so this row is
       * `CountFit.PlayerScheme` — a label the test only accepts from a spec that
       * carries `nbNpcPerArea`, which is the mechanism that earns it.
       */
      countFrom: [
        {
          band: [1, 1],
          bandCite: 'data/zones/infinite-dungeon/zone.lua:25',
          nbNpc: [29, 39],
          cite: 'data/zones/infinite-dungeon/zone.lua:88',
          floor: [70, 70],
          floorCite: 'data/zones/infinite-dungeon/zone.lua:29',
          maxOod: 6,
          maxOodCite: 'data/zones/infinite-dungeon/zone.lua:89',
          fit: CountFit.PlayerScheme,
        },
      ],
      // `filters = { {max_ood=6} }` — infinite-dungeon/zone.lua:89. Six, not two:
      // the one zone in the game that is meant to hand you something well over
      // your head.
      maxOod: 6,
      roster: DEEP,
      litter: [3, 5],
      levelRange: [13, 13],
      traps: [2, 3],
    },
  ],
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
  //     STATED PLAINLY, BECAUSE IT WOULD BE EASY TO OVERSELL: no delve has
  //     water a body cannot walk into, so the cairn in here is the same weak
  //     shooter the Drowned Chapel teaches you on. This is a change of BESTIARY,
  //     not of difficulty — the room now belongs to its own name and stops
  //     being The Underworks with a different floor colour.
  [
    'site:cairnfoot',
    {
      /**
       * LEVEL SIX, AND ToME HAS NO RUNG THERE. Scanned over every zone file:
       * the bands run `{1, 5}` and then `{7, 16}`, and the only tables spanning
       * six carry no rolled population at all — the arena
       * (`data/zones/arena-unlock/zone.lua:22`), three talent-summoned planes,
       * and the perpetual towns, whose `{10, 10}`
       * (`data/zones/town-derth/zone.lua:47`) fills a hand-drawn Static map
       * (`:42`, `towns/derth` at `:43`) with townsfolk.
       *
       * So this row is `CountFit.Clamped` — one step outside, which is exactly
       * what `engine/Zone.lua:141-148` hands a level-six character walking into
       * a `{1, 5}` zone. IT CLAMPS DOWN, to heart-gloom, WHICH IS ITS OWN
       * FLOOR'S ZONE: the count does not move, the filter does not move, and
       * this is the one delve on the moor with no split in its identity at all.
       * The test refuses this label to anything more than one level out.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/heart-gloom/zone.lua:25',
          nbNpc: [20, 30],
          cite: 'data/zones/heart-gloom/zone.lua:76',
          floor: [50, 50],
          floorCite: 'data/zones/heart-gloom/zone.lua:30',
          maxOod: 2,
          maxOodCite: 'data/zones/heart-gloom/zone.lua:77',
          fit: CountFit.Clamped,
        },
      ],
      maxOod: 2,
      roster: DROWNED,
      litter: [3, 4],
      levelRange: [6, 6],
    },
  ],
  //     47 steps, in the clearing inside the southern wood — so it draws on the
  //     wood's own roster, which is the same rule Blackwood follows.
  [
    'site:barrow_end',
    {
      /**
       * THE FLOOR IS THE OLD FOREST, `{7, 16}`
       * (`data/zones/old-forest/zone.lua:25`), and this room is level five — two
       * below. Norgos' Lair is `{1, 5}` (`data/zones/norgos-lair/zone.lua:25`),
       * the same 50x50 (`:30`) Roomer (`:45`), a lair among trees, and states
       * the same `{20, 30}` (`:57`). Nothing in the room changes.
       *
       * ═══ EXCEPT ONE THING, AND IT IS THE ONLY ROSTER THIS PASS MOVES ═══
       * `max_ood = 2` comes with the count (`:58`) and `THICKET` holds
       * `INDEX_HUSK_ELITE` at `levelRange` `[15, undefined]`. At level five,
       * `5 + 2 < 15`, so the elite is now REFUSED here rather than drawn at
       * three tenths of a percent. That is upstream's tier-1 rule doing exactly
       * what it is for: a beginner's room does not hand out a level-fifteen
       * body, however rarely. Its twin on the far map is level nine, sources
       * from Daikara, carries no filter, and draws elites from its first floor —
       * so the escalation is between the two maps rather than inside this one.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/norgos-lair/zone.lua:25',
          nbNpc: [20, 30],
          cite: 'data/zones/norgos-lair/zone.lua:57',
          floor: [50, 50],
          floorCite: 'data/zones/norgos-lair/zone.lua:30',
          maxOod: 2,
          maxOodCite: 'data/zones/norgos-lair/zone.lua:58',
          fit: CountFit.Covers,
        },
      ],
      maxOod: 2,
      roster: THICKET,
      litter: [3, 5],
      levelRange: [5, 5],
    },
  ],
  //     71 steps, on the beach behind the wood. What lives in the Lake of Nur's
  //     water lives here — see `WEIR`.
  [
    'site:the_weir',
    {
      /**
       * THE SECOND OF THE TWO ROOMS STANDING IN ToME'S GAP AT SIX — see
       * Cairnfoot for the scan. BOTH OF THEM CLAMP DOWN, to `{1, 5}`, and that
       * is a rule rather than a pair of choices.
       *
       * ═══ WHY DOWN, NOW THAT THE DIRECTION IS ARGUED AND NOT ASSUMED ═══
       * This row used to clamp UP to Daikara's `{7, 16}`, reasoned from where
       * its own FLOOR's zone sits: the Lake of Nur is `{15, 25}`
       * (`data/zones/lake-nur/zone.lua:25`), nine levels above, so "the whole of
       * its distance is upward". That is a fact about the zone we LEFT, and it
       * decided nothing — `{20, 30}` is what `{1, 5}` and `{7, 16}` both state,
       * so the direction picked a citation and not a number. What it did pick
       * was an identity: Daikara is an `all_lited` snowy mountain pass
       * (`data/zones/daikara/zone.lua:32`) and this is a dark flooded room, and
       * that transfer was never argued the way the Hollow Mine's is.
       *
       * ═══ SO IT TAKES MURGOL LAIR, AND ALMOST NOTHING ABOUT IT IS A SPLIT ═══
       * `data/zones/murgol-lair/zone.lua:56` `{20, 30}`, band `{1, 5}` (`:25`),
       * a 50x50 (`:30`) Roomer (`:43`) with `all_lited` commented out (`:33`) —
       * dark, the size we build, the generator we build, and the lair of the
       * things that live in ToME's water. `WEIR` is what lives in the Lake of
       * Nur's water. The count does not move by one body and the clamp is now
       * the same one step DOWN that Cairnfoot takes, from the same tier.
       *
       * ═══ AND THE FILTER COMES BACK WITH IT ═══
       * `filters = { {max_ood=2} }` (`:57`). Daikara states none, so this row
       * had none; murgol-lair is `{1, 5}` and every `{1, 5}` zone in the tree
       * carries the tier-one refusal. It is inert on `WEIR` — ribbon, inkwell
       * and strongbox are all `levelRange` `[1, undefined]` — so it changes no
       * draw here. It is carried because it is half of the answer the count came
       * from, not because it does anything.
       *
       * Lake-nur's own `{20, 25}` (`:54`) exists nowhere in ToME below
       * `{15, 25}`; its level 1 is `{0, 0}` (`:76`) and its level 3 `{30, 35}`
       * (`:106`). None of the three was ever reachable from here.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [1, 5],
          bandCite: 'data/zones/murgol-lair/zone.lua:25',
          nbNpc: [20, 30],
          cite: 'data/zones/murgol-lair/zone.lua:56',
          floor: [50, 50],
          floorCite: 'data/zones/murgol-lair/zone.lua:30',
          maxOod: 2,
          maxOodCite: 'data/zones/murgol-lair/zone.lua:57',
          fit: CountFit.Clamped,
        },
      ],
      maxOod: 2,
      roster: WEIR,
      litter: [3, 4],
      levelRange: [6, 6],
    },
  ],
  //     106 steps, and the worst room on the moor. NOT the furthest — Gearford
  //     Ward is 109 — which the note here claimed until the walk was measured.
  //     THE TREES START HERE, which `places.ts` has said since before there was
  //     anything in them. Now there is: `THICKET` is a third eidolons, and eight
  //     to ten bodies of which a third move faster than you do is what the far
  //     end of the road should feel like.
  [
    'site:blackwood_outskirts',
    {
      /**
       * THE FLOOR IS THE TROLLMIRE AND THE COUNT IS THE MARK OF THE SPELLBLAZE'S
       * — same `{20, 30}`, fourteen levels later, and still a forest.
       *
       * The Trollmire's DEFAULT layout is `{1, 5}`
       * (`data/zones/trollmire/zone.lua:155`, the table at `:151-242`) and this
       * is the level-fifteen end of the road: the worst drift in the table after
       * the Underworks and the Hollow Mine, and the one that never showed,
       * because `{20, 30}` is what upstream states at `{15, 25}` as well. The
       * Mark of the Spellblaze is that band (`data/zones/mark-spellblaze/zone.lua:22`),
       * a `Forest` (`:38`) like this one, with the identical count (`:55`).
       *
       * ═══ AND ITS FLOOR IS 50x50 (`:27`) WHERE OURS IS 65x40 ═══
       * 2500 cells against 2600 — four per cent, the closest mismatch in the
       * table and still a mismatch, so it is written down rather than rounded
       * away. Our floor is the Trollmire's own
       * (`data/zones/trollmire/zone.lua:160`), and no zone at any band covering
       * fifteen is 65x40, so it could not have been matched on size even when
       * the rule asked for that. It does not matter: upstream carries one count
       * across far larger steps than this — see the note above `CountFit` — and
       * four per cent of a body is not a body.
       *
       * ═══ AND `max_ood` COMES OFF ═══
       * The Trollmire filters at 2 (`:198`); nothing at `{15, 25}` filters at
       * all. Inert either way here — at level fifteen `15 + 2 >= 15`, so
       * `THICKET`'s elite was already admitted — so the room does not move.
       */
      nbNpc: [20, 30],
      countFrom: [
        {
          band: [15, 25],
          bandCite: 'data/zones/mark-spellblaze/zone.lua:22',
          nbNpc: [20, 30],
          cite: 'data/zones/mark-spellblaze/zone.lua:55',
          floor: [50, 50],
          floorCite: 'data/zones/mark-spellblaze/zone.lua:27',
          fit: CountFit.Covers,
        },
      ],
      // AND THE ONE ZONE IN OUR TWELVE THAT CLUSTERS. `class =
      // "mod.class.generator.actor.OnSpots"` with `nb_spots = 2,
      // on_spot_chance = 35` — trollmire/zone.lua:196 and :199. `spot_radius`
      // is not set, so it is OnSpots' own default of 5
      // (engine/generator/actor/OnSpots.lua:31).
      spots: { nbSpots: 2, spotRadius: 5, onSpotChance: 35 },
      roster: THICKET,
      litter: [4, 6],
      levelRange: [15, 15],
    },
  ],
  // ─── and the one with no far end ────────────────────────────────────────
  //     101 steps, in the northern snow. See `INFINITY_TOWER_SITE_ID`.
  [
    INFINITY_TOWER_SITE_ID,
    {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE INFINITY TOWER — ToME's INFINITE DUNGEON, ROW FOR ROW.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Every other entry in this table is a level we chose, standing in for a
       * zone whose band happens to cover it. This one IS the zone
       * (`data/zones/infinite-dungeon/zone.lua`), and the floors are that zone's
       * floors: `shared/mapgen/tower.ts` walks `alter_level_data`'s own chain of
       * layouts and grid sets, so what is on the far side of the door is what
       * upstream would have built there.
       *
       * ═══ THE COUNT IS A FUNCTION OF THE FLOOR'S AREA, AND ONLY HERE ═══
       * `nb_npc = {29, 39}` (`:88`) is the base table, and `alter_level_data`
       * overwrites it on every floor from the floor's own size:
       * `enemy_count = layout.enemy_count or math.ceil(vx * vy * 34/4900)`
       * (`:255`), `nb_npc = {enemy_count-5, enemy_count+5}` (`:256`). This is
       * the one zone in ToME that does that, and it does it because it is the
       * one zone whose level SIZE is rolled per floor (`infiniteDungeonSize`).
       * `nbNpcPerArea` is that numerator; the band below is the base table, used
       * only if a floor ever reports no area.
       *
       * THE NUMERATOR CHANGES WITH THE LAYOUT — 40 on a forest floor (`:129`),
       * 60 on a building floor (`:161`) — and the floor's own layout picks it.
       * `TOWER_SITE` passes the right one per floor
       * (`towerEnemyCountPerArea`, `shared/mapgen/infinite.ts`); 34 stands here
       * as the zone's stated default so a reader of this table sees the row
       * upstream wrote.
       *
       * ═══ NO BAND TO ALIGN AGAINST, WHICH IS A FACT ABOUT THE ZONE ═══
       * `level_range = {1, 1}` with `level_scheme = "player"` and
       * `max_level = 1000000000` (`:25-27`) — so `Zone:updateBaseLevel`
       * (`engine/Zone.lua:141-148`) is `util.bound(plev, 1, 1)` and the base
       * level is 1 for a level-40 Inspector exactly as it is for a level-1
       * Watchman. `level_scheme = "player"` is INERT on this zone, and it is
       * worth saying plainly because the word promises otherwise: the depth
       * comes entirely from the floor number, through `depthScale`.
       *
       * ═══ SIX TO NINE OBJECTS, FLAT, AND NO TRAPS AT ALL ═══
       * `nb_object = {6, 9}` (`:93`) and `nb_trap = {0, 0}` (`:97`). The trap
       * band is ABSENT rather than `[0, 0]` because absent is what this file
       * means by "this place lays none". The litter band is NOT scaled by
       * `forArea` here — see `TOWER_SITE`, which calls `populateDelve` with this
       * spec unscaled: `forArea`'s 34x30 baseline is ours, every band in this
       * table was measured on it, and upstream states this one flat over a floor
       * whose own size it rolls.
       *
       * ═══ NO BOSS ROW ═══
       * `populateDelve` places `spec.boss` on the last floor, and this zone has
       * no last floor. Upstream's set piece here is a different mechanism
       * entirely — `RandomStairGuard` (`:76-90`) puts a rank-3.5 random boss
       * within five tiles of the DOWN stair on nearly every floor, on a curve —
       * and it is deferred with the second exit rather than faked with a boss
       * that fires at floor a billion.
       */
      nbNpc: [29, 39],
      nbNpcPerArea: TOWER_ENEMY_COUNT_PER_AREA,
      countFrom: [
        {
          band: [1, 1],
          bandCite: 'data/zones/infinite-dungeon/zone.lua:25',
          nbNpc: [29, 39],
          cite: 'data/zones/infinite-dungeon/zone.lua:88',
          floor: [70, 70],
          floorCite: 'data/zones/infinite-dungeon/zone.lua:29',
          maxOod: 6,
          maxOodCite: 'data/zones/infinite-dungeon/zone.lua:89',
          fit: CountFit.PlayerScheme,
        },
      ],
      // `filters = { {max_ood=6} }` — infinite-dungeon/zone.lua:89. Six, not
      // two: the one zone in the game meant to hand you something well over
      // your head.
      maxOod: 6,
      roster: DEEP,
      litter: [6, 9],
      levelRange: [1, 1],
      levelScheme: ZoneLevelScheme.Player,
      maxFloors: TOWER_MAX_FLOOR,
      depthScale: TOWER_DEPTH_SCALE,
      // ═══ AND THE OTHER HALF OF THE SAME BARGAIN — `:33` ═══
      // `infinite_dungeon = true`, which is upstream's second xp ladder
      // (`Actor.lua:6519`). `depthScale` two lines up makes the floors harder
      // at 1.2 a floor; this is what pays for them. Shipping one without the
      // other is a difficulty increase with the reward removed, and that is
      // exactly what the first cut of this row was.
      infiniteDungeon: true,
    },
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
   * PRESENCE, NOT A SUM, AND THE DRAW MAKES THAT MORE TRUE RATHER THAN LESS.
   * `roster` is a rarity-weighted candidate list, so "can an elite appear here"
   * is exactly what membership answers and HOW OFTEN is a function of the floor's
   * level rather than of the array. A per-entry sum was tried back when the list
   * was a cycle and it moved three rooms, including the Drowned Chapel from
   * `quiet` to `restless`; that room is the first marker most players ever walk
   * to and Merrow's own directions call it *"close and it is quiet"*. Making
   * the map disagree with the townsfolk to fix a rounding error is a bad trade.
   */
  const elite = spec.roster.some((t) => t.rank !== ActorRank.Normal) ? 3 : 0;
  const ranged = spec.roster.some((t) => t.projSpeed !== undefined) ? 2 : 0;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A ROOM UNDER WATER, WHICH THE TWO TERMS ABOVE CANNOT SEE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The Weir read `restless` while it held a cairn, and only because the cairn
   * shoots. Its own roster (`WEIR`) is three melee bodies at `Normal` rank, so
   * neither term fired and six bodies graded `quiet` — the grade the first case
   * reads to pick where to send a new character (`first-room.test.ts`, which
   * caught it: a beginner is dead in two turns at the band's top).
   *
   * BY PROPERTY, as the rest of this function is: a roster that breathes water
   * is one authored for a floor under water, where every turn spent fighting
   * costs the party air and costs the residents nothing. 3, the elite's weight, and
   * it puts back exactly the grades these rooms had — `restless` for the Weir,
   * `dangerous` for its twin — so the map says what it said before. MEASURED
   * GENEROUS: `tools/delve-run.mjs 4` at level 1 has the Weir at 0/4 solo clears
   * against `restless` Cairnfoot's 2/4 at the same level, and the probe runs
   * without the underwater aura.
   */
  const underwater = spec.roster.some((t) => (t.canBreath?.water ?? 0) > 0) ? 3 : 0;
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
  // OR A BOSS DRAWN ON THE MAP RATHER THAN PLACED — see `DelveSpec.drawnBoss`.
  // The question is "is there a set piece in this room", and where the placer
  // got it from is not a fact about the room.
  if (spec.boss !== undefined || spec.drawnBoss === true) return 'grim';

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE GRADE IS THE LEVEL NOW, NOT THE HEADCOUNT — AND IT HAD TO MOVE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * This read `spec.monsters[1] + elite + ranged + underwater` against
   * thresholds of 7 / 9 / 12, and it worked because the counts were authored on
   * a scale of two to ten. They are upstream's `nb_npc` now — twelve to sixty,
   * and twelve to eighty before the counts were sourced at each delve's own
   * level — and on that scale every room in the game is `grim`, which is the
   * same as no grade at all.
   *
   * ═══ AND THE COUNT WAS NEVER THE GRADIENT ANYWAY ═══
   * The Hollow Mine holds fifty to sixty bodies on its first floor and Blackwood
   * Outskirts twenty to thirty, while Blackwood is six levels deeper. Density is
   * a fact about the ZONE a delve's count is read from — a Maze packs more than
   * a forest — and has never been a fact about how dangerous the place is. The thing that
   * actually decides that is the level everything in the room is born at, which
   * is `delveLevel` and which this table has carried in `levelRange` since the
   * curve pass.
   *
   * ═══ THE CUTS ARE READ OFF THE SHIPPED TABLE, NOT INVENTED ═══
   * `delveLevel` over the twelve runs 1, 1, 3, 5, 6, 6, 7, 9, 10, 11, 13, 15,
   * and the three roster terms add on top exactly as they did. Cutting at
   * 4 / 9 / 16 gives:
   *
   *     quiet      the Drowned Chapel (3), the Undermost (3)
   *     restless   the Underworks (5), Barrow End (8), Cairnfoot (8),
   *                the Weir (9), the Watcher's Altar (9)
   *     dangerous  the Hollow Mine (11), the Outer Index (15),
   *                the Glass Archive (16)
   *     grim       Gearford Ward (18), Blackwood Outskirts (18)
   *
   * The `quiet` pair is exactly the pair that was quiet before, which is the one
   * that must not move: `first-room.test.ts` and the first case both read this
   * function to decide where a four-minute-old character is sent.
   *
   * ═══ TWO ROOMS SWAP, AND BOTH SWAPS ARE CORRECTIONS ═══
   * Barrow End falls from `dangerous` to `restless` and the Outer Index rises
   * from `restless` to `dangerous`. Under the old formula a LEVEL-5 room graded
   * worse than a LEVEL-10 one because it held seven bodies against four — which
   * is the count speaking about danger again, and it was wrong about it. The
   * order now runs with the walk, which is what the gradient was authored to be.
   */
  const weight = delveLevel(spec) + elite + ranged + underwater;

  if (weight <= 4) return 'quiet';
  if (weight <= 9) return 'restless';
  if (weight <= 16) return 'dangerous';
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
 *
 * ═══ ONLY GROUND A PARTY CAN GET TO — OUR RULE, NOT UPSTREAM'S ═══
 * ToME's generators place on any open cell (`engine/generator/actor/Random.lua:114`),
 * and a Roomer floor can keep a room its tunnels never opened: upstream only
 * refuses a level whose stairs or vault entrances are cut off
 * (`engine/Zone.lua:1131-1158`). A ToME player digs into the rest. Nobody here
 * can dig, so a monster sealed in rock is a floor that can never be cleared and
 * litter there is loot nobody can pick up. A candidate must be reachable from
 * the door by the rule that certified the level: eight neighbours, a shut door
 * passable (`shared/mapgen/connectivity.ts`).
 *
 * ═══ AND NEVER ON A STAIR, OR ON THE ARRIVAL ═══
 * Upstream marks a stair's cell `special` (`engine/generator/map/Roomer.lua:53`)
 * and its actor, object and trap generators all skip special cells
 * (`engine/generator/actor/Random.lua:114`, `object/Random.lua:50`,
 * `trap/Random.lua:47`). A cell in `sites` is the stair down or the way out,
 * and a cell in `spawns` is where a party lands; nothing is put on either. The
 * arrival half was missing and could not fire while a ring eight cells wide
 * already covered it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND `DOOR_CLEARANCE` IS OURS, AND IT IS NOT WHY THE ROOMS WERE EMPTY.
 * ═══════════════════════════════════════════════════════════════════════════
 * Upstream has no ring at all — `Random.lua:112-117` draws uniformly over the
 * whole map and refuses only the `special` cell — and at HEAD, measured over six
 * seeds of each of the twelve delves, **0.00 monsters could see the arrival tile
 * in eleven of twelve sites** against a sight radius of 10. The obvious suspect
 * was this ring. It was the wrong suspect: the nearest body stood 13 to 37 tiles
 * out, far beyond eight, because the placer COMBED the bodies evenly across the
 * whole floor. With the comb replaced by upstream's independent draw and the
 * counts raised to the zone's own `nb_npc`, the nearest body is 8 to 17 tiles
 * out and something is in sight of the arrival on most floors — with the ring
 * still in place.
 *
 * SO IT STAYS, AND IT IS A DELIBERATE DIVERGENCE. A body born in melee with the
 * arrival tile is not tension: a new character wakes in the Undermost with a
 * brass lantern, no tutorial and no escort, where upstream's player reaches the
 * escape from Reknor through character creation with Norgan beside them
 * (`reknor-escape/zone.lua:88-94`). Eight cells is a turn to read the room.
 */
function roomFor(world: World, map: AuthoredMap, door: TileXY): TileXY[] {
  const level = world.level;
  const reached = reachableSet(level, door);
  const spawns = new Set(map.spawns.map((t) => `${String(t.x)},${String(t.y)}`));
  const out: TileXY[] = [];
  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 1; x += 1) {
      if (!canWalk(level, x, y)) continue;
      if (reached[y * level.w + x] !== 1) continue;
      if (map.sites.has(`${String(x)},${String(y)}`)) continue;
      // `special`, upstream's own word for it: a stair cell and an arrival cell
      // are refused by every generator it has (`actor/Random.lua:114`,
      // `object/Random.lua:50`, `trap/Random.lua:47`). Nothing is born on one at
      // any clearance.
      if (spawns.has(`${String(x)},${String(y)}`)) continue;
      if (Math.max(Math.abs(x - door.x), Math.abs(y - door.y)) < DOOR_CLEARANCE) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND NEVER WHERE THE BODY WOULD DROWN — tome/class/Grid.lua:102-109.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Huge hack, if we are an actor without position this means we are not yet put on the map
 * -- If so make sure we can only go where we can breathe
 * if e.__is_actor and not e.x and not e:attr("no_breath") then
 *   local air_level, air_condition = self:check("air_level"), self:check("air_condition")
 *   if air_level and (not air_condition or not e.can_breath[air_condition] or e.can_breath[air_condition] <= 0) then
 *     return true
 * ```
 *
 * A body that is not on the map yet treats every grid with an `air_level` as a
 * wall, unless it has `no_breath` or breathes that air. The check is only that
 * `air_level` is set, not that it is negative, so a bubble refuses too: it names
 * no condition, and nobody breathes a grid with no condition.
 *
 * ═══ `roomFor`'S LIST, TRIMMED PER BODY, AND NO DRAW MOVES ═══
 * `roomFor` answers for the room, and the room is also what the litter, the
 * props and the note stand in. `delve.offset` and the stride are still taken
 * over that whole list; only the index lands in this body's share of it. On a
 * floor with no air grids every body's share is the whole room, in the same
 * order, so every floor generated before water existed is laid out as it was.
 */
function breathableFor(world: World, room: readonly TileXY[], body: Breather): readonly TileXY[] {
  if (body.noBreath === true) return room;
  return room.filter((tile) => {
    const air = airOf(tileAt(world.level, tile.x, tile.y));
    return air === undefined || breathes(body, air);
  });
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
 * What changed is how HARD it is, and it is no longer the count. The twin used to
 * carry +2 bodies; that was half again on a band of two to ten and would be noise
 * on a band of twenty to thirty, so what it carries now is the four LEVELS it
 * always also carried — which `actor_adjust_level` puts on every body in the room
 * and `rankLifeAdjust` compounds. The litter is still +1 at both ends: a player
 * who has cleared the Underworks and walks fourteen tiles into the Sedge to find
 * another one should meet a room they recognise and cannot handle the same way,
 * and should come out with more than they went in for. Danger with no upside is a
 * place you visit once.
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
  /**
   * AND ITS COUNT IS A TOWN'S, WHICH UPSTREAM HAS A ZONE FOR.
   *
   * `data/zones/infinite-dungeon/zone.lua:143-151` is the "town" layout — built
   * streets and buildings, like this — and it takes the zone's default
   * numerator, `enemy_count = ceil(vx * vy * 34/4900)` at `:255`, because it
   * carries no `enemy_count` of its own. So the band is that formula against
   * this floor's own area, and it is the same mechanism Gearford Ward uses with
   * a different numerator. The flat pair below is the base table's `{29, 39}`
   * (`:88`), used only if a floor reports no area.
   */
  nbNpc: [29, 39],
  // THE TOWN LAYOUT'S NUMERATOR, which is the zone's default because the town
  // layout states none (`:255`). Asked for, not spelled — see Gearford Ward.
  nbNpcPerArea: towerEnemyCountPerArea('town'),
  /**
   * NO BAND TO ALIGN, FOR THE ZONE'S OWN REASON — the same one Gearford Ward
   * carries. The Infinite Dungeon is `level_range = {1, 1}` with
   * `level_scheme = "player"` and an unbounded `max_level`
   * (`data/zones/infinite-dungeon/zone.lua:25-27`); its bodies take their level
   * from the floor number (`:28`) and its count from the floor's own area
   * (`:255`). `CountFit.PlayerScheme`, and the test only grants that label to a
   * spec carrying `nbNpcPerArea`.
   */
  countFrom: [
    {
      band: [1, 1],
      bandCite: 'data/zones/infinite-dungeon/zone.lua:25',
      nbNpc: [29, 39],
      cite: 'data/zones/infinite-dungeon/zone.lua:88',
      floor: [70, 70],
      floorCite: 'data/zones/infinite-dungeon/zone.lua:29',
      maxOod: 6,
      maxOodCite: 'data/zones/infinite-dungeon/zone.lua:89',
      fit: CountFit.PlayerScheme,
    },
  ],
  /**
   * AND THE FILTER THAT CAME WITH THE COUNT WAS MISSING HERE. `alter_level_data`
   * overwrites `generator.actor.nb_npc` and nothing else
   * (`data/zones/infinite-dungeon/zone.lua:256`), so the base table's
   * `filters = { {max_ood=6} }` (`:89`) applies to the town layout exactly as it
   * does to the building layout Gearford Ward is built from. Inert on `DEEP` at
   * level fourteen — `14 + 6` clears `INDEX_HUSK_ELITE`'s floor of fifteen on
   * every floor — so this is the citation being completed rather than the room
   * changing.
   */
  maxOod: 6,
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR TWINS WHOSE ORIGINAL'S BAND DOES NOT REACH FOUR LEVELS UP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A twin is its original plus four (`redactedSpec`), and a `{1, 5}` source
 * cannot cover seven, nine or ten. Those four re-cite at their own level —
 * everything else inherits, because its original's band already covers the
 * twin's level: Daikara's `{7, 16}` reaches thirteen, the Maze's reaches
 * thirteen and fourteen, halfling-ruins' `{10, 25}` reaches fifteen,
 * mark-spellblaze's `{15, 25}` reaches nineteen, and the Drowned Chapel's
 * `{1, 5}` covers its twin's level five exactly.
 *
 * ═══ AND A RE-CITE IS THE ONLY WAY A TWIN'S SOURCE MOVES ═══
 * There used to be a second mechanism beside this one: `alignedFourLevelsUp`,
 * which silently upgraded an inherited `Clamped` or `Unaligned` row to `Covers`
 * when the twin's own level happened to fall inside the band. It existed for
 * exactly one row — The Weir's, clamping up to Daikara — and that row now
 * clamps DOWN with the other level-six room, so nothing was left for it to
 * re-judge. It is deleted rather than kept inert. What it was guarding against
 * is guarded better: `test/server/delve-alignment.test.ts` drives every row
 * over `SITES` and judges each `fit` from both sides, so a twin carrying a
 * label that stopped being true goes RED and gets an argument, which is what
 * the deleted function's own docblock said should happen.
 *
 * ═══ AND NOT ONE OF THE THREE COUNTS MOVES ═══
 * `{20, 30}` before and `{20, 30}` after, at `{1, 5}`, at `{7, 16}` and at
 * `{10, 25}` alike. That is the whole argument at the top of this file — a
 * `level_range` is a clamp on the player and not a statement about the count —
 * demonstrated on our own table rather than asserted about ToME's.
 *
 * ═══ THE FILTER DOES MOVE, AND THAT IS THE ONE ROSTER CHANGE ON THIS MAP ═══
 * All three originals source from `{1, 5}` zones and carry `max_ood = 2`; none
 * of the second-tier zones filters at all. So a redacted Barrow End draws
 * `INDEX_HUSK_ELITE` from its first floor while Alderbrook's refuses it — the
 * escalation is between the two maps, which is what walking through that door
 * is supposed to mean.
 */
const TWIN_COUNT_FROM: ReadonlyMap<string, readonly CountSource[]> = new Map<
  string,
  readonly CountSource[]
>([
  [
    // Level 7. Deep Bellow's `{1, 5}` does not reach it; Daikara's does, with
    // the identical count on the identical 50x50.
    'site:underworks',
    [
      {
        band: [7, 16],
        bandCite: 'data/zones/daikara/zone.lua:25',
        nbNpc: [20, 30],
        cite: 'data/zones/daikara/zone.lua:56',
        floor: [50, 50],
        floorCite: 'data/zones/daikara/zone.lua:30',
        fit: CountFit.Covers,
      },
    ],
  ],
  [
    // Level 9. Norgos' Lair's `{1, 5}` does not reach it.
    'site:barrow_end',
    [
      {
        band: [7, 16],
        bandCite: 'data/zones/daikara/zone.lua:25',
        nbNpc: [20, 30],
        cite: 'data/zones/daikara/zone.lua:56',
        floor: [50, 50],
        floorCite: 'data/zones/daikara/zone.lua:30',
        fit: CountFit.Covers,
      },
    ],
  ],
  [
    // Level 10. Murgol Lair's `{1, 5}` does not reach it, and the Halfling Ruins
    // is the band that starts exactly there with the identical count. The
    // tier-one `max_ood` does NOT come with it — nothing at `{10, 25}` filters —
    // which is inert on `WEIR` either way.
    'site:the_weir',
    [
      {
        band: [10, 25],
        bandCite: 'data/zones/halfling-ruins/zone.lua:22',
        nbNpc: [20, 30],
        cite: 'data/zones/halfling-ruins/zone.lua:50',
        floor: [50, 50],
        floorCite: 'data/zones/halfling-ruins/zone.lua:27',
        fit: CountFit.Covers,
      },
    ],
  ],
  [
    // Level 10. Heart of the Gloom's `{1, 5}` does not reach it. The Halfling
    // Ruins is `{10, 25}` — the band that starts exactly here — 50x50 (`:27`),
    // and states the same count. It is also the zone the Drowned Chapel's floor
    // is built from, which is where this whole drift was first read off.
    'site:cairnfoot',
    [
      {
        band: [10, 25],
        bandCite: 'data/zones/halfling-ruins/zone.lua:22',
        nbNpc: [20, 30],
        cite: 'data/zones/halfling-ruins/zone.lua:50',
        floor: [50, 50],
        floorCite: 'data/zones/halfling-ruins/zone.lua:27',
        fit: CountFit.Covers,
      },
    ],
  ],
]);

export function redactedSpec(originalId: string): DelveSpec | undefined {
  const spec = DELVES.get(originalId);
  // NO ENTRY MEANS A TOWN. `DELVES` is keyed only by the sites that are fights,
  // so the absence IS the classification — the same way the registry already
  // reads it when it decides whether to attach a `populate` hook at all.
  if (spec === undefined) return REDACTED_TOWN;
  const countFrom = TWIN_COUNT_FROM.get(originalId) ?? spec.countFrom;
  return {
    /**
     * THE COUNT IS ITS TWIN'S, UNCHANGED — AND THAT IS A CHANGE.
     *
     * This read `[spec.monsters[0] + 2, spec.monsters[1] + 2]`, argued as *"a
     * consistent half-again across the whole range"* against bands of two to
     * ten. The bands are upstream's `nb_npc` now, twelve to sixty, and +2 on
     * those is between 3% and 17% — a constant that used to mean something and
     * would now be noise dressed as a rule. The twin is four levels worse than
     * its original (`levelRange` below), which is upstream's own way of saying
     * "the same place, further in": `actor_adjust_level` puts every body in it
     * four levels up, and `rankLifeAdjust` compounds that.
     */
    nbNpc: spec.nbNpc,
    ...(spec.nbNpcByFloor === undefined ? {} : { nbNpcByFloor: spec.nbNpcByFloor }),
    ...(spec.nbNpcPerArea === undefined ? {} : { nbNpcPerArea: spec.nbNpcPerArea }),
    ...(spec.spots === undefined ? {} : { spots: spec.spots }),
    /**
     * THE SOURCE IS RE-READ AT THE TWIN'S OWN LEVEL, and the filter follows it.
     *
     * `maxOod` is the `filters` beside the count, so it cannot be inherited past
     * a row that re-cites: a twin sourcing from Daikara carries Daikara's
     * absence of a filter, not its original's `{1, 5}` two. Taken off the rows
     * rather than off `spec.maxOod` so there is no second place for the two to
     * disagree — `test/server/delve-alignment.test.ts` pins that they cannot.
     */
    countFrom,
    ...(countFrom[0]?.maxOod === undefined ? {} : { maxOod: countFrom[0].maxOod }),
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY BODIES THIS FLOOR IS FOR — the zone's `nb_npc`, for one player.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/Zone.lua:833-843` merges `levels[n]` over the zone's own table, so a
 * floor's band is its override if it has one; `infinite-dungeon/zone.lua:255-256`
 * computes the band from the floor's own area instead, which `nbNpcPerArea`
 * carries. AND THEN NOTHING: the band this returns is verbatim upstream.
 *
 * There used to be a third step, a global `NB_NPC_SCALE`, and it was 0.85. It
 * is deleted — see the note above `CountFit` for why one factor could never be
 * right for a table that drifted in both directions at once, and for the
 * measurements that replaced it.
 *
 * EXPORTED so the probes and the tests ask the same question the placer does,
 * rather than re-deriving three quarters of it and drifting.
 *
 * `area` is the floor's cell count, needed only by the one zone that scales
 * with it; absent falls back to that zone's base table.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO MAY STAND ON THIS FLOOR — the placer's own two lines.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Zone:makeEntity` (`engine/Zone.lua:380-427`) builds a probability list from
 * the zone's npc list at `resolvers.current_level = base_level + level.level - 1`
 * and draws one entity from it per body. Both halves of that are here: the LEVEL
 * the floor is drawn at, and the weighted list `Zone.lua:214` produces from the
 * roster behind `checkFilter`'s `max_ood` (`:306`).
 *
 * ═══ EXPORTED BECAUSE TWO TEST FILES HAD COPIED IT ═══
 * `delve-alignment.test.ts` computed `delveLevel(spec) + floor - 1` and rebuilt
 * this filter to census the rosters, and `levelling-curve.test.ts` carries the
 * same pair in `averageWorth`. A mutation audit proved the cost: dropping
 * `+ floor - 1` from the placer, and switching the filter off in the placer,
 * both left the whole alignment file GREEN, because the file was asking its own
 * copy. One function now, called by the placer and read by the tests.
 *
 * ═══ `DelveSpec.depthScale` IS DELIBERATELY NOT APPLIED HERE ═══
 * The Infinity Tower multiplies its depth by 1.2, and that multiply belongs to
 * `actor_adjust_level` (`data/zones/infinite-dungeon/zone.lua:28`), which
 * decides what level a body is BORN at. The level a candidate is WEIGHED at is
 * a different number: `resolvers.current_level = base_level + level.level - 1`
 * (`engine/Zone.lua:1031`), unscaled, which is what `Zone:makeEntity` builds
 * its probability list against. Scaling it here would thin a roster faster than
 * upstream thins it, and on a floor deep enough would leave nobody eligible at
 * all — see `test/server/tower.test.ts`, which asks at a billion.
 */
export function eligibleOn(
  spec: DelveSpec,
  floor: number,
  party?: PartyStrength,
): RarityList<MonsterTemplate & RarityCandidate> {
  const roomLevel = delveLevel(spec, party) + floor - 1;
  return computeRarities(
    spec.roster.filter(
      // `Zone.lua:214` — an entity with no `rarity` or no `level_range` is not
      // a candidate at all. `INDEX_WATCHER` is ours: a guardian, placed apart.
      (t): t is MonsterTemplate & RarityCandidate =>
        t.rarity !== undefined && t.levelRange !== undefined,
    ),
    roomLevel,
    // `checkFilter`'s `max_ood` — engine/Zone.lua:306, and `computeRarities`
    // takes a filter for exactly this (`Zone.lua:214`'s `not filter or filter(e)`).
    spec.maxOod === undefined
      ? undefined
      : (e) => roomLevel + (spec.maxOod ?? 0) >= e.levelRange[0],
  );
}

export function nbNpcFor(spec: DelveSpec, floor: number, area?: number): readonly [number, number] {
  const perArea =
    spec.nbNpcPerArea === undefined || area === undefined
      ? undefined
      : Math.ceil((area * spec.nbNpcPerArea) / TOWER_ENEMY_COUNT_AREA);
  if (perArea !== undefined) {
    // CLAMPED AT ZERO, WHICH UPSTREAM IS NOT. `infinite-dungeon/zone.lua:256`
    // is a bare `enemy_count-5`, and on a floor small enough to make that
    // negative `rng.range(-2, 8)` would still place bodies — Lua's own range
    // simply runs from the lower number. Ours would hand `Math.max(1, ...)`'s
    // successor a negative floor. Labelled rather than silent, because it is
    // the only divergence left in this function.
    return [Math.max(0, perArea - 5), perArea + 5];
  }
  return spec.nbNpcByFloor?.get(floor) ?? spec.nbNpc;
}

/**
 * The top of upstream's first tier of zones. Every early zone that spans it is a
 * `level_range = {1, 5}` zone.
 */
const FIRST_TIER_TOP_LEVEL = 5;
/** How deep a first-tier zone goes. See `floorsOf`. */
const FIRST_TIER_FLOORS = 3;
/**
 * How deep a zone past the first tier goes. See `floorsOf`.
 *
 * EXPORTED because it is `floorsToWalk`'s default cap, and a sweep that wants
 * to assert it stayed bounded needs the number rather than a second copy of 4
 * (`test/server/realm-wipe.test.ts`).
 */
export const DEEPER_FLOORS = 4;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY FLOORS A DELVE HAS — upstream's `max_level`, by tier.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's zones are several levels deep, and the depth follows the tier. The
 * first-tier zones are all the same depth: Trollmire
 * (data/zones/trollmire/zone.lua:28), the Ruins of Kor'Pul
 * (data/zones/ruins-kor-pul/zone.lua:27), the Ritch Tunnels, the Blighted Ruins,
 * Murgol's lair, Norgos' lair, the Heart of the Gloom, the Rhaloren camp and the
 * escape from Reknor. The tier after it (the Old Forest, Daikara, the Maze, the
 * Sandworm lair) and the commonest zones past that (Reknor, the temporal rift,
 * the Conclave vault) go one floor deeper.
 *
 * A delve names a level rather than an upstream zone, so its depth is read off
 * the tier its level falls in.
 */
export function floorsOf(spec: DelveSpec): number {
  // AND THE ONE ZONE THAT STATES ITS OWN. See `DelveSpec.maxFloors`: the tier
  // rule would read the Infinite Dungeon's `level_range = {1, 1}` as a
  // first-tier zone and stop it at three floors.
  if (spec.maxFloors !== undefined) return spec.maxFloors;
  return spec.levelRange[0] <= FIRST_TIER_TOP_LEVEL ? FIRST_TIER_FLOORS : DEEPER_FLOORS;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY FLOORS TO WALK, FOR A CALLER THAT WALKS THEM ONE AT A TIME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `floorsOf` is upstream's `max_level` and is asked as a BOUND — `goDown`
 * refuses at it, `withStairsDown` withholds a stair at it, the case file closes
 * at it. None of those enumerate. ELEVEN CALLERS DID, across six test files and
 * two probes: the art census over every floor of every site, the per-floor
 * source check in `delve-alignment`, four density and depth loops in
 * `monster-scaling`, three in `levelling-curve` — one of which OPENS A REALM
 * per floor — `zone-floors`, and both delve probes. The Infinity Tower's
 * `max_level` is a billion (`DelveSpec.maxFloors`), so every one of them was a
 * HANG rather than a slow loop: no failure, no message, a test run that simply
 * stops. It is the one thing an endless site breaks in a codebase that had only
 * ever had places with a bottom, and it is worth checking a new caller against.
 *
 * THE ONES THAT ARE SAFE ARE SAFE FOR A REASON, not by luck: they walk a NAMED
 * site, or the Redaction's twins (the Tower has none), or they guard on
 * membership of a zone table the Tower is not in, or — `casefile-wire` — they
 * descend the first FILEABLE site, and the Tower is not one.
 *
 * FOUR IS THE DEEPEST PLACE IN THE GAME THAT HAS ONE (`DEEPER_FLOORS`), so for
 * every site but the Tower this returns `floorsOf` unchanged and the walk is
 * still every floor. For the Tower it returns a prefix, which is the honest
 * answer: a census of per-floor authored data over a place that authors none is
 * as complete after four floors as after a billion, and the questions that ARE
 * depth-dependent belong in `test/server/tower.test.ts`, asked at depths chosen
 * on purpose.
 */
export function floorsToWalk(spec: DelveSpec, cap = DEEPER_FLOORS): number {
  return Math.min(floorsOf(spec), cap);
}

/**
 * WHERE A FLOOR'S STAIR DOWN GOES: the walkable tile furthest from the door, by
 * steps. Upstream's generators put the down stair somewhere the floor has to be
 * crossed to reach; the furthest tile is that, and it is decided by the map
 * alone, so a floor's stair is always in the same place for the same seed.
 */
export function stairsDownCell(map: AuthoredMap): TileXY | undefined {
  const door = map.spawns[0];
  if (door === undefined) return undefined;
  const { w, h } = map.view;
  const seen = new Uint8Array(w * h);
  const doors = new Set(map.spawns.map((t) => `${String(t.x)},${String(t.y)}`));
  const queue: TileXY[] = [door];
  seen[door.y * w + door.x] = 1;
  let furthest: TileXY | undefined;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (at === undefined) continue;
    if (!doors.has(`${String(at.x)},${String(at.y)}`)) furthest = at;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x] === 1) continue;
      if (!canWalk(map.view, x, y)) continue;
      seen[y * w + x] = 1;
      queue.push({ x, y });
    }
  }
  return furthest;
}

/** The site width every band in `DELVES` was measured on. See `forArea`. */
const TUNED_SITE_WIDTH = 34;
/** The site height every band in `DELVES` was measured on. See `forArea`. */
const TUNED_SITE_HEIGHT = 30;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DELVE'S BANDS, FOR THE FLOOR THEY ARE SPREAD OVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every band in `DELVES` was measured on a site of `TUNED_SITE_WIDTH` by
 * `TUNED_SITE_HEIGHT`. Sites are upstream's level size now (shared/sitemap.ts),
 * so the litter and the traps grow with the floor's area: a bigger floor is not
 * a barer one.
 *
 * ═══ THE MONSTERS DO NOT, AND THAT WAS MEASURED ═══
 * Upstream's first-tier levels hold `nb_npc = {20, 30}` on that area
 * (data/zones/ruins-kor-pul/zone.lua:55), and growing the monster band with the
 * area would land a dense delve near it. `tools/delve-run.mjs` said what that
 * does to fights tuned on the smaller floor: nearly every floor a lone body or
 * a party used to clear became one almost nobody cleared, resting between
 * fights or not. The monster band is the fight a delve was tuned to be, so it
 * stays that fight, spread over more ground.
 */
export function forArea(spec: DelveSpec, map: AuthoredMap): DelveSpec {
  const scale = (map.view.w * map.view.h) / (TUNED_SITE_WIDTH * TUNED_SITE_HEIGHT);
  const band = (b: readonly [number, number]): readonly [number, number] => [
    Math.round(b[0] * scale),
    Math.round(b[1] * scale),
  ];
  return {
    ...spec,
    litter: band(spec.litter),
    ...(spec.traps === undefined ? {} : { traps: band(spec.traps) }),
  };
}

/**
 * WHAT A CALL TO `populateDelve` PUTS DOWN.
 *
 * `Everything` builds a floor: its roster, its boss and the boss's dressing,
 * the litter, the lore note and the traps.
 *
 * `Hostiles` is what a party wipe puts back (`World.reseedFloor`): the roster
 * and the boss, rolled again, and nothing else. `resetFloor` has already taken
 * every item off the floor so that losing is not a consolation prize, and it
 * leaves the traps and the props where they are because they are the floor.
 * Re-running the rest would hand the loot back and lay a second set of traps and
 * a second ring of props over the first.
 */
export const PopulationScope = {
  Everything: 'everything',
  Hostiles: 'hostiles',
} as const;
export type PopulationScope = (typeof PopulationScope)[keyof typeof PopulationScope];

export function populateDelve(
  world: World,
  map: AuthoredMap,
  spec: DelveSpec,
  party: PartyStrength = LONE_BEGINNER,
  /** Which floor this is, from 1. Upstream's `level.level`. */
  floor = 1,
  /** A whole floor, or only what a party wipe puts back. See `PopulationScope`. */
  scope: PopulationScope = PopulationScope.Everything,
): number {
  const door = map.spawns[0] ?? { x: Math.floor(map.view.w / 2), y: Math.floor(map.view.h / 2) };
  const candidates = roomFor(world, map, door);
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
   * was ever the reason. The ruin placer now honours the same clearance
   * (`shared/sitemap.ts`), and the solid-wall case above is what remains for
   * it. A cave is ToME's Cavern now and lays no room at all.
   *
   * ═══ A WORKS HAS SEVERAL, AND THE DRAWN ONES COME FIRST ═══
   * A works is ToME's Roomer, which can lay a money vault and more than one
   * drawn room on a floor, and lays its rooms before it picks its stairs,
   * anywhere, so the arrival can come down beside one. The guarded room is the
   * first drawn room (`vault:`) that offers a candidate, else the first room
   * function's (`room:`) that does: a drawn room is the one somebody composed,
   * and a money vault is a room upstream fills with coin rather than builds.
   * Measured over 300 works: 145 had a drawn room and 40 more than one, and
   * picking `vaults[0]` alone guarded a money vault on 23 of the 145. 8 floors
   * with a room have none offering a candidate, and fall through as above. A
   * ruin has at most one room, so for it this is the room it always was; a cave
   * has none.
   */
  const insideOf = (room: NonNullable<AuthoredMap['vaults']>[number]): TileXY[] =>
    candidates.filter(
      (tile) =>
        tile.x >= room.at.x &&
        tile.y >= room.at.y &&
        tile.x < room.at.x + room.w &&
        tile.y < room.at.y + room.h,
    );
  const vaults = map.vaults ?? [];
  const drawnRooms = vaults.filter((room) => room.id.startsWith('vault:'));
  let inRoom: TileXY[] = [];
  for (const room of [...drawnRooms, ...vaults.filter((room) => !drawnRooms.includes(room))]) {
    inRoom = insideOf(room);
    if (inRoom.length > 0) break;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY — `nb_npc` FOR THIS FLOOR, WHICH MAY BE THE ZONE'S OVERRIDE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `engine/Zone.lua:833-843` deep-merges `levels[n]` over the zone's own table,
   * so a floor's band is its override if it has one and the zone's otherwise.
   * `infinite-dungeon/zone.lua:255-256` goes further and computes the band from
   * the floor's own area; `nbNpcPerArea` is that, and it is the only zone in the
   * twelve that does it.
   *
   * ONE DRAW, SAME LABEL, SAME POSITION as the `delve.count` this replaces, so a
   * floor's later draws are where they were.
   */
  const band = nbNpcFor(spec, floor, map.view.w * map.view.h);
  const rolled = world.rng.int('delve.count', band[0], band[1]);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH BODIES — `computeRarities` ONCE FOR THE FLOOR, `pickEntity` PER BODY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Zone:makeEntity` (engine/Zone.lua:380-427) builds a probability list from
   * the zone's npc list at `resolvers.current_level = base_level + level.level - 1`
   * and draws one entity from it per body. That level is exactly the one the
   * bodies are then born at, below.
   *
   * COMPUTED ONCE because the list is pure over the floor — upstream rebuilds it
   * per call and gets the same answer — and because `pickEntity` is one draw
   * whatever the list length, so the seed cost is one label per body and nothing
   * else.
   *
   * AN EMPTY LIST IS A REAL OUTCOME, not an error: it is what a roster whose
   * every member is far out of depth produces, and `Zone.lua:243`'s
   * `genprob > 0` is the same rule. The loop below places nobody and the
   * caller's log line says so.
   */
  const weighted = eligibleOn(spec, floor, party);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE THEY STAND — AND THE STRIDE IS GONE, WHICH WAS THE WHOLE PROBLEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This placed each body at `(offset + i * stride) % candidates.length`, an
   * even comb across the floor, under a note calling a cluster by the door *"the
   * one arrangement this file exists to avoid"*. Upstream's is the exact
   * opposite and is deliberate:
   *
   * ```lua
   * -- engine/generator/actor/Random.lua:112-117
   * local x, y = rng.range(self.area.x1, self.area.x2), rng.range(self.area.y1, self.area.y2)
   * while (not m:canMove(x, y) or ... .special) and tries < 100 do ... end
   * ```
   *
   * Every body is drawn INDEPENDENTLY AND UNIFORMLY over the whole map. That is
   * Poisson, and Poisson clumps: the measurement that justified the comb —
   * *"per body: 48 pairs within 2 tiles; hoisted: 0"* — measured the difference
   * and read it backwards. Forty-eight clustered pairs is what a floor of
   * upstream's looks like, and it is what "I opened a door onto five things" is
   * made of.
   *
   * ═══ AND ONE ZONE CLUSTERS ON PURPOSE, HARDER ═══
   * `OnSpots` picks `nb_spots` spots up front and gives each body
   * `on_spot_chance` percent of being born within `spot_radius` of one of them
   * (`engine/generator/actor/OnSpots.lua:30-38`, `:43-56`). The Trollmire, which
   * Blackwood Outskirts is built as, sets `nb_spots = 2, on_spot_chance = 35`
   * (`trollmire/zone.lua:199`). Reknor-escape's table carries the same two
   * fields and they are DEAD there: its class is `engine.generator.actor.Random`
   * (`reknor-escape/zone.lua:48`, with the `mod.class` line commented out on the
   * next), and the engine's Random never reads them — only `OnSpots` does. Ours
   * does the same, so the spots exist only when the spec carries them.
   *
   * ═══ THE SPOTS ARE DRAWN GROUND, AND THAT IS A LABELLED DIVERGENCE ═══
   * Upstream's are `level:pickSpot(...)` (`engine/Level.lua:253-259`), a random
   * entry from the list the MAP generator recorded — room centres, stairs,
   * guardian spots. Our generated maps keep no such list, so a spot here is a
   * uniformly drawn placeable tile. Same shape (a few anchors, bodies clustered
   * round them) with a weaker notion of "interesting place".
   */
  const spots: TileXY[] = [];
  if (spec.spots !== undefined) {
    for (let i = 0; i < spec.spots.nbSpots; i += 1) {
      const at = candidates[world.rng.int(`delve.spot.${String(i)}`, 0, candidates.length - 1)];
      if (at !== undefined) spots.push(at);
    }
  }

  /**
   * A ZERO ROLL PLACES NOBODY, and the `Math.max(1, ...)` this replaces made
   * that impossible: the escape from Reknor's static last level is
   * `nb_npc = {0, 0}` (`reknor-escape/zone.lua:79`) and one body was born on it
   * anyway. Upstream's loop is `for i = 1, rng.range(nb_npc[1], nb_npc[2])`
   * (`engine/generator/actor/Random.lua:126`) — zero iterations at zero. The
   * floor of one survives for every other roll, so a band that rounds to a
   * single body still puts one down.
   */
  const wanted = rolled === 0 ? 0 : Math.max(1, Math.round(rolled * delveHeadroom(party)));
  let placed = 0;
  for (let i = 0; i < wanted; i += 1) {
    /**
     * ONE DRAW FROM THE WEIGHTED LIST — `Zone.lua:318-330`, through `pickEntity`.
     * The roster is no longer walked as a cycle, so what a floor holds is what
     * its own level makes likely.
     */
    const template = pickEntity(world.rng, `delve.pick.${String(i)}`, weighted);
    if (template === undefined) continue;
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
     * ONE of them stands.
     *
     * BOTH LISTS ARE THIS BODY'S SHARE (`breathableFor`). A guarded room that is
     * all water to it hands the guard to the floor; a floor that is all water to
     * it places nobody, as upstream's placer gives up on a body with nowhere to
     * stand.
     */
    const guarded = breathableFor(world, inRoom, template);
    const room = breathableFor(world, candidates, template);
    const share = i === 0 && guarded.length > 0 ? guarded : room;
    if (share.length === 0) continue;
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DRAW, AND THEN THE NEXT FREE TILE — `Random.lua:113-117`'s retry loop.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream redraws up to 100 times and gives up; walking on from the aim
     * through this body's own share is the same refusal with no extra draws and
     * no failure mode, and the share holds only ground this body may be born on
     * (a bubble nothing may be born on is `tome/class/Grid.lua:102-109`, which
     * `breathableFor` ports).
     */
    const onSpot =
      spec.spots !== undefined &&
      spots.length > 0 &&
      // `rng.percent(on_spot_chance)` — engine/generator/actor/OnSpots.lua:44.
      world.rng.int(`delve.onspot.${String(i)}`, 1, 100) <= spec.spots.onSpotChance;
    const radius = spec.spots?.spotRadius ?? 0;
    const anchor = onSpot
      ? spots[world.rng.int(`delve.spotpick.${String(i)}`, 0, spots.length - 1)]
      : undefined;
    const near =
      anchor === undefined
        ? share
        : share.filter(
            (t) => Math.max(Math.abs(t.x - anchor.x), Math.abs(t.y - anchor.y)) <= radius,
          );
    // `util.findFreeGrid` finding nothing inside the radius is
    // engine/generator/actor/OnSpots.lua:58's
    // "No more free space for spawning": upstream returns and places nobody. We
    // fall back to the whole floor, which keeps the count honest.
    const from = near.length > 0 ? near : share;
    const aim = world.rng.int(`delve.at.${String(i)}`, 0, from.length - 1);
    let at: TileXY | undefined;
    for (let step = 0; step < from.length; step += 1) {
      const tile = from[(aim + step) % from.length];
      if (tile !== undefined && world.actorAt(tile.x, tile.y) === undefined) {
        at = tile;
        break;
      }
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FLOOR WITH NOWHERE LEFT PLACES NOBODY — `Random.lua:118`, exactly.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * if tries < 100 then
     *     self.zone:addEntity(self.level, m, "actor", x, y)
     * ```
     *
     * Upstream redraws a hundred times and, if every one of them was refused,
     * DROPS THE BODY. There is no fallback and no ring search.
     *
     * This used to fall back to the aim even when the walk above found every
     * tile taken, and hand that occupied tile to `world.addMonster`, whose ring
     * search then threw `no free tile within 8`. It could not fire while the
     * bands were two to ten on a fifty-by-fifty floor. At upstream's counts it
     * fires the moment a floor is narrow: a twenty-one cell corridor asked for
     * sixteen bodies crashes generation.
     */
    if (at === undefined) continue;

    // Qualified by realm — `delve_0` was the same string in every party's copy
    // of every delve, and the status, Downed and talent tables are process-wide
    // and keyed by it. See `World.id`.
    // AND AT THE LEVEL OF THE PLACE, which is what `monsterInit`'s third
    // parameter has been waiting for. Every caller in the game passed nothing,
    // so every body in it was level 1 — see `DelveSpec.level`.
    const actor = world.addMonster(
      qualified(world, `delve_${String(i)}`),
      // `actor_adjust_level` — the zone's own line, all four of its terms. See
      // `actorAdjustLevel`. This used to be the first and third only, so every
      // body on a floor was exactly the same level and an elite was an ordinary
      // body with a ring under it.
      monsterInit(
        template,
        at,
        actorAdjustLevel(
          world.rng,
          `delve.level.${String(i)}`,
          delveLevel(spec, party),
          template.rank,
          floor,
          spec.depthScale,
        ),
        // WHICH LADDER ITS CORPSE PAYS ON — `DelveSpec.infiniteDungeon`. Absent
        // everywhere but the Tower, and absent means upstream's ordinary ladder.
        spec.infiniteDungeon,
      ),
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
  // ON THE LAST FLOOR, where upstream keeps its set piece: the escape from
  // Reknor's last level is a static map with its boss in it
  // (data/zones/reknor-escape/zone.lua:72-82).
  if (spec.boss !== undefined && floor >= floorsOf(spec)) {
    // THE FAR END OF THE GROUND IT CAN BREATHE ON (`breathableFor`).
    const bossRoom = breathableFor(world, candidates, spec.boss);
    let far = bossRoom[0];
    let best = -1;
    for (const cell of bossRoom) {
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
       * ABOVE THE ROOM IT IS IN, BY ITS RANK — `getRankLevelAdjust`, which is
       * THREE for a rank-4 boss. (This comment said TWO for as long as the
       * number was hand-picked; it has been derived since `rankLevelAdjust`
       * landed, and a stale constant in a sentence is how a derived number
       * quietly becomes two numbers again.)
       *
       * Upstream puts a boss a little over its zone for the same reason: a set
       * piece that is exactly as tough as the population is not a set piece, and
       * its RANK is already doing the heavy lifting — a rank-4 body gains life
       * half again as fast per level as the rank-2 husks around it.
       */
      const boss = world.addMonster(
        qualified(world, 'delve_boss'),
        // THE SAME LINE EVERY OTHER BODY GETS. `actor_adjust_level` already
        // carries the set piece's promotion in `getRankLevelAdjust`: rank 4 is
        // +3, which is where `BOSS_LEVELS_ABOVE_ROOM` now comes from. The jitter
        // is upstream's too and applies to a guardian exactly as it does to the
        // rank and file — `Zone:addEntity` (engine/Zone.lua:747-751) levels every
        // actor through the one function.
        monsterInit(
          spec.boss,
          far,
          actorAdjustLevel(
            world.rng,
            'delve.level.boss',
            delveLevel(spec, party),
            spec.boss.rank,
            floor,
            spec.depthScale,
          ),
          // AS EVERY OTHER BODY ON THE FLOOR — see the rank-and-file call above.
          // A set piece in an infinite dungeon is paid on the same ladder as the
          // things around it; upstream's branch is on the ZONE, not the rank.
          spec.infiniteDungeon,
        ),
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
      // A WIPE PUTS THE BOSS BACK AND NOT ITS ROOM. The props are the floor and
      // `resetFloor` leaves them standing; a second pass would ring the boss
      // twice. Everything after this is the floor too. See `PopulationScope`.
      if (scope === PopulationScope.Hostiles) return placed;
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

  // ─── WHAT A WIPE PUTS BACK ENDS HERE ───
  // Everything below is the floor rather than what stands on it: the litter,
  // the lore note and the traps. See `PopulationScope`.
  if (scope === PopulationScope.Hostiles) return placed;

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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND SOMETHING UNDER THE FLOOR — `generator/trap/Random.lua:36-60`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ```lua
   * for i = 1, rng.range(self.nb_trap[1], self.nb_trap[2]) do self:generateOne() end
   * ```
   *
   * `nb_trap` is a PER-ZONE BAND, exactly as `nb_npc` is, which is the same
   * argument this file's header already makes for `monsters` and `litter`: the
   * roster says what a place is, the engine does not.
   *
   * ═══ ABSENT MEANS NONE, AND THE GENTLEST ROOM HAS NONE ON PURPOSE ═══
   * The Trollmire — the first zone a ToME character ever walks into — is
   * `nb_trap = {0, 0}` (`data/zones/trollmire/zone.lua:83`). The Drowned Chapel
   * is ours, the room the first case names out loud to a character four minutes
   * old, and it has no `traps` band for the same reason.
   *
   * ═══ BUILT PLACES, NOT WILD ONES ═══
   * Upstream puts traps in the thieves' tunnels {3,3}, Tannen's tower {6,6} and
   * the conclave vault {4,4}, and none in a bog. Somebody has to have PUT a trap
   * there. So the works, the mine, the altar, the index, the archive and the
   * ward have them; the drowned places, the barrow and the wood do not.
   *
   * ═══ A FORKED STREAM, WHICH IS WHY THIS COSTS NO EXISTING FLOOR ANYTHING ═══
   * The dressing pass twenty lines up states the rule in full: `fork` does not
   * advance the parent, so this consumes zero draws from the delve stream and
   * every floor any player has ever walked stays byte-identical — including
   * every delve that has no `traps` band and therefore no traps. Calling
   * `world.rng.int` here would have re-rolled the monsters, the litter and the
   * lore note of every delve in the game.
   */
  if (spec.traps !== undefined) {
    const trapRng = world.rng.fork('delve.traps');
    const count = trapRng.int('delve.traps.count', spec.traps[0], spec.traps[1]);
    /**
     * NOT IN A DRAWN ROOM. Upstream rejects any cell whose `room_map` entry is
     * `special` (`generator/trap/Random.lua:47`), which is exactly its vaults — a hand-drawn
     * room is somebody's composition and a generator scattering hazards through
     * it is the generator arguing with the author. That is every `vault:` room
     * on the floor, not only the guarded one, and the guarded room besides.
     *
     * `candidates` has already dropped everything within `DOOR_CLEARANCE` of the
     * arrival tile, which does the other half of the job this file's header
     * insists on: *"being hit before the map has finished drawing is not tension,
     * it is a bug report."* A trap on the threshold is the purest form of that.
     */
    const keyOf = (cell: TileXY): string => `${String(cell.x)},${String(cell.y)}`;
    const special = new Set([...inRoom, ...drawnRooms.flatMap(insideOf)].map(keyOf));
    const open = candidates.filter((cell) => !special.has(keyOf(cell)));
    const offset = open.length === 0 ? 0 : trapRng.int('delve.traps.offset', 0, open.length - 1);
    const stride = Math.max(1, Math.floor(open.length / Math.max(1, count)));
    for (let i = 0; i < count; i += 1) {
      // SPREAD, for the roster loop's reason: three traps drawn independently
      // clump, and a clump is one tile you cannot cross rather than three
      // hazards on a floor.
      const at = open[(offset + i * stride) % Math.max(1, open.length)];
      if (at === undefined) continue;
      // ONE PER TILE — `Map.TRAP` holds one entity per cell and upstream's
      // placer re-rolls rather than stacking. `addTrap` replaces, so skipping is
      // what keeps the count honest.
      if (world.trapAt(at.x, at.y) !== undefined) continue;
      /**
       * NOTHING ELIGIBLE IS A REAL ANSWER, not a failure. `computeRarities`
       * drops a candidate whose weight floors to zero, so a floor deep enough
       * past every trap's band simply has none — which is `generateOne`'s own
       * behaviour when `makeEntity` returns nil. `continue`, so the rest of the
       * count is still tried rather than the whole pass being abandoned.
       */
      const kit = rollTrap(delveLevel(spec, party), trapRng, `delve.traps.${String(i)}`);
      if (kit === undefined) continue;
      world.addTrap({ ...kit, x: at.x, y: at.y });
    }
  }

  return placed;
}
