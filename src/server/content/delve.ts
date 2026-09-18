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
import type { RarityCandidate } from './rarity.ts';
import type { Rng } from '../../shared/rng.ts';
import { REDACTION_SITE_ID } from '../../shared/level.ts';
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
): number {
  const jitter = rng.int(label, -1, 2);
  return Math.max(1, baseLevel + rankLevelAdjust(RANK_VALUE[rank]) + floor - 1 + jitter);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE NUMBER THAT IS NOT UPSTREAM'S, AND IT IS HERE SO THERE IS ONLY ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every `nbNpc` in `DELVES` is its zone's own `nb_npc`, read off the zone file
 * with the line cited beside it. This is the single factor they are all taken
 * at, and it exists because `nb_npc` is the one piece of the pipeline that
 * genuinely cannot cross at face value.
 *
 * ═══ WHY IT CANNOT CROSS, MEASURED ═══
 * A count is only meaningful against what one body costs to kill and what it
 * costs you to be near. Ported at 1.00 and measured with `tools/delve-density.mjs`
 * — every class, alone, at the floor's own level, on every floor of every delve:
 *
 *     The Drowned Chapel, level 1, 21 bodies   Watchman 0/2   538 damage taken
 *     The Undermost,      level 1, 55 bodies   every class 0/2
 *     The Underworks,     level 3, 46 bodies   Watchman 1/2, everyone else 0/2
 *
 * The beginner room the first case NAMES BY GRADE to a four-minute-old
 * character became unsurvivable, and so did the room every character wakes up
 * in. That is not difficulty, it is deletion — the exact failure the previous
 * area-scaling attempt produced and the reason this pass was told to measure.
 *
 * ═══ AND THE CAUSE IS NOT THE COUNT ═══
 * ToME puts 20-30 bodies in front of a LEVEL-1 character in four of its tier-1
 * zones (`trollmire/zone.lua:197`, `heart-gloom/zone.lua:76`,
 * `rhaloren-camp/zone.lua:53`, `ruins-kor-pul/zone.lua:55` — all `level_range =
 * {1, 5}`), and its level-1 characters live. Ours do not, because a body here
 * costs far more turns to kill and deals far more per turn relative to what a
 * level-1 character has. The count is upstream's; the per-body arithmetic is
 * not, and this factor is the receipt for that gap rather than a decision about
 * how crowded a room should be.
 *
 * ═══ WHY ONE GLOBAL FACTOR RATHER THAN A BAND PER SITE ═══
 * Because the RATIOS are the tuning. Ardhungol is 3.5x the Glass Archive's
 * original, the escape from Reknor is the densest thing in the first tier, the
 * Maze is denser than the forest it sits under — fifteen years of somebody
 * deciding that, and per-site bands would throw all of it away and put us back
 * where this file started, with twelve numbers somebody picked. One factor keeps
 * every relative decision upstream made and admits the one thing we know is
 * different, in one place, with the measurement that set it written above it.
 *
 * ═══ ITS VALUE IS A MEASUREMENT, NOT A TASTE ═══
 * THE LARGEST FACTOR AT WHICH THE ROOM THE FIRST CASE NAMES IS STILL BEATABLE BY
 * WALKING INTO IT. Swept against `test/server/first-room.test.ts`, which opens
 * the quiet rooms with the real generator and the real placer and fights the
 * pack that can see the arrival tile:
 *
 *     0.60  the Undermost leaves a beginner  7 of 72 hp
 *     0.50  the Undermost leaves a beginner  7 of 72 hp
 *     0.45  the Undermost leaves a beginner  7 of 72 hp
 *     0.40  passes                                        <- here
 *     0.35  passes
 *
 * At 0.40 no delve in the game is less crowded than it was, which is the other
 * bound worth stating: a factor low enough to keep the beginner room also has to
 * be high enough that the author's complaint — *"too little enemies"* — is
 * actually answered. Against HEAD's authored bands, by midpoint:
 *
 *     Blackwood Outskirts  8-10 ->  8-12   1.1x      the Underworks   4-6 -> 16-20  3.6x
 *     The Glass Archive     3-5 ->   5-6   1.4x      The Hollow Mine  6-8 -> 28-32  4.3x
 *     Barrow End            5-7 ->  8-12   1.7x      The Drowned Chapel 2-2 -> 8-12 5.0x
 *     The Watcher's Altar   5-7 ->  8-12   1.7x      The Undermost    2-2 ->  8-12  5.0x
 *     Gearford Ward         6-8 -> 10-14   1.7x      The Outer Index  3-4 -> 20-24  6.3x
 *     The Weir              4-6 ->  8-10   1.8x
 *     Cairnfoot             4-6 ->  8-12   2.0x
 *
 * Median 1.9x, and `test/server/monster-scaling.test.ts` holds the floor of it:
 * no site may be less crowded than the row above.
 *
 * ═══ AND THE DRIVEN PROBE IS WHAT SAYS WHETHER IT IS PLAYABLE ═══
 * `tools/delve-density.mjs` fights every class through every floor of every
 * delve. Read its per-class column before moving this: at HEAD it was Watchman
 * 98%, Alchemist 54%, Inspector 46%, Redactor 17% — three of the four classes
 * were already losing most floors BEFORE any density change, and this factor
 * cannot fix that.
 *
 * ═══ IT IS MEANT TO REACH 1.00 ═══
 * Not by raising it. By fixing what it is paying for: one rolled item per slot
 * erases 50-69% of incoming damage from level 3 on, a body takes ~35 player
 * turns to kill, and monster hit points reach 180-516 while the damage that
 * answers them does not keep up. Every point of that closed is a point this can
 * rise by, and the day it is 1.00 this constant deletes itself.
 */
export const NB_NPC_SCALE = 0.4;

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
   * — one body per count, no area term, no headcount term. Every row below cites
   * the zone file and line it was read from, so `npm run check:citations`
   * verifies the numbers exist rather than taking this comment's word for it.
   *
   * ═══ AND THE FLOORS ARE ALREADY UPSTREAM'S SIZE, WHICH IS WHY IT TRANSFERS ═══
   * `shared/sitemap.ts` builds each site at its zone's own `width`/`height`, so
   * the ground a count is spread over here is the ground it was tuned on there.
   * `forArea` still scales LITTER and TRAPS off a 34x30 baseline — those bands
   * are ours — and deliberately does not touch this one.
   */
  readonly nbNpc: readonly [number, number];
  /**
   * `levels[n].generator.actor.nb_npc` — the zone's override for one floor
   * (`engine/Zone.lua:833-843` deep-merges it over the base table). Indexed by
   * floor from 1; a floor with no entry uses `nbNpc`.
   *
   * THREE OF OUR TWELVE ZONES CARRY ONE AND EXACTLY ONE IS REACHABLE. Ardhungol's
   * third level drops from 70-80 to 20-25 on a 20x20 (`ardhungol/zone.lua:70`)
   * and the Maze's second from 50-60 to 10-12 (`maze/zone.lua:186`), but
   * `shared/mapgen/zones.ts` maps our floors onto those zones' earlier levels and
   * repeats the last entry, so neither override is ever read — stated in the row
   * it belongs to rather than left for somebody to discover.
   *
   * The one that IS read is the escape from Reknor's last, `{0, 0}`
   * (`reknor-escape/zone.lua:79`), because its bodies are drawn on a static map
   * instead. That is also the answer to "the tutorial's final floor is empty":
   * the floor is meant to hold no ROLLED population, and the bug was that
   * `populate` returned before placing anything at all — no boss, no litter, no
   * note.
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
   * enough. Six of our twelve zones carry it: heart-gloom (`zone.lua:77`),
   * rhaloren-camp (`:54`), scintillating-caves (`:54`), trollmire (`:198`),
   * reknor-escape (`:51`) at 2, and infinite-dungeon (`:89`) at 6.
   *
   * ABSENT IS NO FILTER, which is upstream's own default and what the other six
   * zones do: NONE of halfling-ruins, orc-breeding-pit, ardhungol, maze,
   * old-forest or lake-nur passes a filter to its ACTOR generator at all.
   *
   * ═══ FOUR OF THE SIX LINES ABOVE POINTED AT `nb_npc + 2`, AND TWO SENTENCES
   * HERE WERE INVENTED OUTRIGHT. `check:citations` PASSED ALL OF THEM. ═══
   * The four `max_ood` lines were each one line low — a guessed offset, not a
   * read — and this paragraph used to say old-forest "passes an empty one
   * (`old-forest/zone.lua:59`)" and lake-nur "a `special_rarity` one
   * (`lake-nur/zone.lua:56`)". `:59` is old-forest's `guardian` line and its
   * `filters = { {} }` at `:65` belongs to the OBJECT generator; `:56` is
   * lake-nur's `object = {`, and the `special_rarity` filter at `:91` is inside
   * the FLOODED variant, which our Weir is not built from. The conclusion —
   * neither zone gets a `maxOod` — was right, which is exactly why nobody
   * checked. `tools/check-citations.mjs` can only prove a cited line EXISTS.
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
 * in this table was authored here. The bands are their zones' own `nb_npc` now,
 * and upstream's density is a fact about the ZONE rather than about danger:
 * Ardhungol packs 70-80 bodies and the Trollmire 20-30, and the Trollmire is the
 * gentler place. What orders the map is the level every body in a room is born at
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
      // halfling-ruins, levels 1-3. `nb_npc = {20, 30}` —
      // data/zones/halfling-ruins/zone.lua:50.
      nbNpc: [20, 30],
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
       * and is levelled too. We have neither: `forceLevelup` is unported and
       * there is no escort. Measured with the count its own zone states, a
       * level-1 character is killed by the pack that can see the arrival tile
       * before it has read the room (`test/server/first-room.test.ts`).
       *
       * ═══ THIS IS THE ROW THAT REVERTS ═══
       * The day `forceLevelup` and the escort land — which is the tutorial lane's
       * work, and the same pair `docs/wip/d3b` is waiting on — this override
       * comes out and the Undermost carries `nbNpc` like everything else.
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
      // orc-breeding-pit, level 2 on every floor (`shared/mapgen/zones.ts`).
      // `nb_npc = {40, 50}` — data/zones/orc-breeding-pit/zone.lua:47.
      nbNpc: [40, 50],
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
      // rhaloren-camp. `nb_npc = {20, 30}` — data/zones/rhaloren-camp/zone.lua:53.
      nbNpc: [20, 30],
      // `filters = { {max_ood=2} }` — rhaloren-camp/zone.lua:54.
      maxOod: 2,
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
      // ardhungol, levels 1-2. `nb_npc = {70, 80}` — data/zones/ardhungol/zone.lua:50,
      // the densest band in our twelve. Its `levels[3]` drop to {20, 25}
      // (ardhungol/zone.lua:70) is NOT reachable here: `zones.ts` gives this site
      // two level entries, so floors 3 and 4 repeat ardhungol level 2.
      nbNpc: [70, 80],
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
      // maze, the DEFAULT layout (`zones.ts`). `nb_npc = {50, 60}` —
      // data/zones/maze/zone.lua:160. Its `levels[2]` {10, 12} (maze/zone.lua:186)
      // is not reachable: every floor here is maze level 1.
      nbNpc: [50, 60],
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
      // scintillating-caves, the TWISTED layout (`zones.ts`), which is 30x30 and
      // the smallest floor in the game. `nb_npc = {12, 16}` —
      // data/zones/scintillating-caves/zone.lua:53.
      nbNpc: [12, 16],
      // `filters = { {max_ood=2} }` — scintillating-caves/zone.lua:54.
      maxOod: 2,
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
      nbNpc: [29, 39],
      nbNpcPerArea: 60,
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
      // heart-gloom. `nb_npc = {20, 30}` — data/zones/heart-gloom/zone.lua:76.
      nbNpc: [20, 30],
      // `filters = { {max_ood=2} }` — heart-gloom/zone.lua:77.
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
      // old-forest. `nb_npc = {20, 30}` — data/zones/old-forest/zone.lua:58.
      nbNpc: [20, 30],
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
      // lake-nur, level 2 on every floor (`zones.ts`). `nb_npc = {20, 25}` —
      // data/zones/lake-nur/zone.lua:54. Its level 1 is {0, 0} (:76) and its
      // level 3 {30, 35} (:106); neither is reachable from here.
      nbNpc: [20, 25],
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
      // trollmire, the DEFAULT layout (`zones.ts`). `nb_npc = {20, 30}` —
      // data/zones/trollmire/zone.lua:197.
      nbNpc: [20, 30],
      // `filters = { {max_ood=2} }` — trollmire/zone.lua:198.
      maxOod: 2,
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
   * a scale of two to ten. They are upstream's `nb_npc` now — twelve to eighty —
   * and on that scale every room in the game is `grim`, which is the same as no
   * grade at all.
   *
   * ═══ AND THE COUNT WAS NEVER THE GRADIENT ANYWAY ═══
   * Under upstream's numbers the Hollow Mine holds 70-80 bodies and Blackwood
   * Outskirts 20-30, while Blackwood is six levels deeper. Density is a fact
   * about the ZONE a delve is built as — a cavern packs more than a forest — and
   * has never been a fact about how dangerous the place is. The thing that
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
  nbNpcPerArea: 34,
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
    /**
     * THE COUNT IS ITS TWIN'S, UNCHANGED — AND THAT IS A CHANGE.
     *
     * This read `[spec.monsters[0] + 2, spec.monsters[1] + 2]`, argued as *"a
     * consistent half-again across the whole range"* against bands of two to
     * ten. The bands are upstream's `nb_npc` now, twelve to eighty, and +2 on
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
    ...(spec.maxOod === undefined ? {} : { maxOod: spec.maxOod }),
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
 * carries. Then `NB_NPC_SCALE`, which is the one number here that is not
 * upstream's and has its own argument written above it.
 *
 * EXPORTED so the probes and the tests ask the same question the placer does,
 * rather than re-deriving three quarters of it and drifting.
 *
 * `area` is the floor's cell count, needed only by the one zone that scales
 * with it; absent falls back to that zone's base table.
 */
export function nbNpcFor(spec: DelveSpec, floor: number, area?: number): readonly [number, number] {
  const perArea =
    spec.nbNpcPerArea === undefined || area === undefined
      ? undefined
      : Math.ceil((area * spec.nbNpcPerArea) / 4900);
  const stated: readonly [number, number] =
    perArea !== undefined
      ? // CLAMPED AT ZERO, WHICH UPSTREAM IS NOT. `infinite-dungeon/zone.lua:256`
        // is a bare `enemy_count-5`, and on a floor small enough to make that
        // negative `rng.range(-2, 8)` would still place bodies — Lua's own
        // range simply runs from the lower number. Ours would hand
        // `Math.max(1, ...)`'s successor a negative floor. Labelled rather than
        // silent, because it is the only divergence in this function.
        [Math.max(0, perArea - 5), perArea + 5]
      : (spec.nbNpcByFloor?.get(floor) ?? spec.nbNpc);
  // APPLIED TO THE BAND, NOT TO THE DRAW: a scaled draw would be a different
  // number of random values taken and would move every later draw on the floor.
  // `{0, 0}` stays `{0, 0}` under any factor, which is what keeps the escape
  // from Reknor's static last level empty of rolled bodies.
  return [Math.round(stated[0] * NB_NPC_SCALE), Math.round(stated[1] * NB_NPC_SCALE)];
}

/**
 * The top of upstream's first tier of zones. Every early zone that spans it is a
 * `level_range = {1, 5}` zone.
 */
const FIRST_TIER_TOP_LEVEL = 5;
/** How deep a first-tier zone goes. See `floorsOf`. */
const FIRST_TIER_FLOORS = 3;
/** How deep a zone past the first tier goes. See `floorsOf`. */
const DEEPER_FLOORS = 4;

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
  return spec.levelRange[0] <= FIRST_TIER_TOP_LEVEL ? FIRST_TIER_FLOORS : DEEPER_FLOORS;
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
  const roomLevel = delveLevel(spec, party) + floor - 1;
  const weighted = computeRarities(
    spec.roster.filter(
      // `Zone.lua:214` — an entity with no `rarity` or no `level_range` is not a
      // candidate at all. `INDEX_WATCHER` is ours: a guardian, placed below.
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
        ),
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
          ),
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
