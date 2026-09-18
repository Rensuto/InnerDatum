// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — the map below is ours) from
//   t-engine4 game/modules/tome/data/maps/zones/reknor-escape-last.lua (a hand-drawn last level:
//              arrive at one end, pass a guarded hall, leave by the other)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { UNDERMOST_PICKET, UNDERMOST_WARDEN, monsterInit } from './monsters.ts';
import { actorAdjustLevel, delveHeadroom } from './delve.ts';
import { embellish } from './encounter.ts';
import { KNOT_OF_ELSEWHERE_ID } from './items.ts';
import { qualified } from '../world/world.ts';
import { ActorRank } from '../../shared/protocol.ts';
import { canWalk } from '../../shared/level.ts';
import type { MonsterTemplate } from './monsters.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { PartyStrength } from '../world/strength.ts';
import type { World } from '../world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE UNDERMOST'S LAST FLOOR: THE ONE BETWEEN A NEW CHARACTER AND DAYLIGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's Escape from Reknor draws its last level by hand
 * (data/zones/reknor-escape/zone.lua:72-79): the way in at the top, a hall with
 * its guardian and his guards, and the way out at the far end. This is that
 * shape in a cave: `@` where you arrive, the pillared hall, a bend, a last room,
 * and `>`, the way out to the surface. `#` is rock and `.` is ground.
 *
 * Authored, so every party climbs into the same room, and so the fight at the
 * exit can be placed rather than rolled.
 *
 * ═══ AND THE FIGHT IS DRAWN ON IT, WHICH IS UPSTREAM'S OWN MECHANISM ═══
 * `W` is the warden and `p` a picket. A static map names the actor standing on
 * a tile — `defineTile(char, grid, obj, actor)`, engine/generator/map/Static.lua
 * :103-108 — and reknor-escape-last.lua:34-35 uses it for exactly this:
 * `defineTile("O", "FLOOR", nil, "BROTOQ")` flanked by two `ORC_GUARD`. Both
 * glyphs are ordinary ground; see `UNDERMOST_GARRISON` for what stands on them.
 *
 * TWO PICKETS, WHICH IS UPSTREAM'S COUNT, SPREAD, WHICH IS NOT UPSTREAM'S
 * ARRANGEMENT. The drawn hall is `....oOo....` — both guards shoulder to
 * shoulder with the boss — so a party crosses an empty hall and then meets
 * everything at once. The COUNT is kept and the placement is not, for a reason
 * that was measured rather than argued: across all twelve delves a mean of ZERO
 * bodies could see the arrival tile, so every room in the game opens on nothing,
 * and the one floor every character in the game has to walk is the place to stop
 * doing that rather than the place to do it again. One picket stands at the
 * hall's mouth, where a lantern finds it a long way before the warden does; the
 * other stands with the warden. You meet them in that order.
 *
 * A THIRD WAS TRIED AND TAKEN BACK OUT. With warden-plus-three a lone Inspector
 * — the class that cannot shoot in an unlit cave, so the class this hall is
 * hardest for — won 10 of 16; at upstream's two it wins 13, and the Redactor
 * goes 14 to 15. `delveHeadroom` is what makes the hall bigger for a party, and
 * it does it without spending a class's whole margin to do it.
 */
export const UNDERMOST_LAST_FLOOR: readonly string[] = [
  '##################################################',
  '#######################.@.########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '###############....................###############',
  '###############.........p..........###############',
  '###############....................###############',
  '###############...##..........##...###############',
  '###############...##..........##...###############',
  '###############....................###############',
  '###############....................###############',
  '###############.........W.p........###############',
  '###############....................###############',
  '###############....................###############',
  '###############...##..........##...###############',
  '###############...##..........##...###############',
  '###############....................###############',
  '###############....................###############',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...########################',
  '#######################...........################',
  '#######################...........################',
  '#######################...........################',
  '###############################...################',
  '###############################...################',
  '###############################...################',
  '###############################...################',
  '###############################...################',
  '###############################...################',
  '##########################...............#########',
  '##########################...............#########',
  '##########################...............#########',
  '##########################...............#########',
  '##########################...............#########',
  '##########################...............#########',
  '##########################...............#########',
  '#################################>################',
  '##################################################',
  '##################################################',
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A NEW CHARACTER IS TOLD ON WAKING — upstream's intro text.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream shows a new character its intro before anything else, once it is
 * standing in its starting zone (class/Game.lua:287, :299). Here it is said in
 * the margin, where the game already speaks to one player alone, and it gives
 * the character the one thing it needs: a reason to climb. Each line is its
 * text and its depth.
 */
export const UNDERMOST_WAKING: readonly (readonly [string, number])[] = [
  ['You wake on cold rock in the dark, with no memory of coming down.', 0],
  ['The air is bad and it presses on the ears. Far above you, faintly, is the city.', 1],
  [
    'Somebody filed you down here. Climb, and find the way out before the paperwork is finished.',
    1,
  ],
  ['Something is standing between you and the last door. It will not stand aside for asking.', 1],
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO STANDS ON WHICH GLYPH — upstream's `defineTile`'s fourth argument.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `defineTile(char, grid, obj, actor)` (engine/generator/map/Static.lua:103-108)
 * is how a hand-drawn level names the body on a tile, and
 * data/maps/zones/reknor-escape-last.lua:34-35 is two lines of it. This is that
 * table, and it is the ONE place the map's glyphs and the roster meet: the
 * legend in `world/realms.ts` says what the tile is, this says what is on it,
 * and `undermost.test.ts` walks the drawn rows against both so a glyph can
 * never be added to one without the other.
 */
export const UNDERMOST_GARRISON: ReadonlyMap<string, MonsterTemplate> = new Map([
  ['W', UNDERMOST_WARDEN],
  ['p', UNDERMOST_PICKET],
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIGHT AT THE WAY OUT, PLACED WHERE THE FLOOR SAYS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every body here takes its level from `actorAdjustLevel`, the same four-term
 * function every rolled body in the game takes its level from
 * (`trollmire/zone.lua:30`, and `engine/Zone.lua:747-751`, which levels EVERY
 * actor a zone adds through one function — a drawn one included). So the warden
 * is `base + rankLevelAdjust(4) + floor - 1 + rng(-1,2)`: on the Undermost's
 * last floor that is 1 + 3 + 2 + jitter, five to eight, which is upstream's own
 * arithmetic for Brotoq to the number.
 *
 * ═══ NOT A HARD LEVEL FLOOR, AND THAT WAS THE TEMPTING MISTAKE ═══
 * Brotoq carries `level_range = {7, nil}` (data/zones/reknor-escape/npcs.lua:38)
 * and it is easy to read that as "he is at least seven". It is not: a
 * `level_range` is the filter the RANDOM generator uses to decide whether an
 * entity may be rolled at a depth (engine/Zone.lua:214-222), and Brotoq is not
 * rolled — he is drawn. Pinning him at 7 would have put a boss three levels
 * over his own zone's arithmetic in front of a character four minutes old.
 *
 * ═══ THE WARDEN IS HOLDING SOMETHING, GUARANTEED ═══
 * The same rule `populateDelve` gives the Watcher: `rollDrop` is a chance for
 * the rank and file, and the one authored body in a room does not roll for
 * whether the walk was worth it. `resolvers.drops{chance=100, nb=1, ...}` —
 * data/zones/reknor-escape/npcs.lua:57.
 *
 * ═══ AND THE HORDE GROWS WITH THE PARTY, BY THE GAME'S OWN RULE ═══
 * `delveHeadroom` is how every other room in the game answers "how big is this
 * for the people who brought friends" — x1.0 / x1.5 / x2.0 / x2.5, sub-linear,
 * size and never level. A DRAWN room cannot ask it by drawing more glyphs, so
 * the glyphs are the LONE party's garrison and each extra body stands in the
 * ring around one of them. Measured before it existed: a party of three met the
 * same four bodies a lone character does and cleared the hall in 27 to 41 turns
 * without one of them dropping a hit point. Every delve in the game scales and
 * the one room every character has to walk did not.
 *
 * THE WARDEN NEVER MULTIPLIES. A set piece is one body; `delveHeadroom`'s own
 * note is that a delve's roster is its identity and the party answers the SIZE
 * of the room. Two wardens would be a different place.
 *
 * @returns how many bodies were placed, so a caller can tell an empty hall from
 *   a full one without counting actors.
 */
export function populateUndermostHall(
  world: World,
  rows: readonly string[],
  party: PartyStrength,
  baseLevel: number,
  floor: number,
): number {
  let placed = 0;
  /** Where each drawn picket stands, in the map's own reading order. */
  const posts: TileXY[] = [];
  /** Every tile something already stands on, so no two bodies share one. */
  const taken = new Set<string>();
  const key = (at: TileXY): string => `${String(at.x)},${String(at.y)}`;

  const stand = (template: MonsterTemplate, at: TileXY): void => {
    const body = world.addMonster(
      qualified(world, `${template.id}_${String(placed)}`),
      monsterInit(
        template,
        at,
        // NO NEW DRAW PER EXTRA BODY BEYOND THIS ONE: the label carries the
        // index, so a party of five and a party of one take the same first
        // draws in the same order and the warden's level never moves with the
        // headcount.
        actorAdjustLevel(
          world.rng,
          `undermost.level.${template.id}.${String(placed)}`,
          baseLevel,
          template.rank,
          floor,
        ),
      ),
    );
    if (template.rank === ActorRank.Boss) {
      /**
       * ═════════════════════════════════════════════════════════════════════
       * THE WAY OUT, AND THEN THE PAY.
       * ═════════════════════════════════════════════════════════════════════
       *
       * `NPC:onDie` (tome/class/NPC.lua:393-406) gives the Rod of Recall to the
       * first body of rank 4 or over a character kills, by NAME —
       * `makeEntityByName(game.level, "object", "ROD_OF_RECALL")` at :394, never
       * a roll against a table. So the key goes on the body as its raw id and
       * NOT through `embellish`, which forks the loot stream to roll material
       * grades, egos and money: none of those may touch a unique, and one of
       * them would turn the way out of the Undermost into `~ba2` of it.
       *
       * AND THE ORDINARY RARE IS STILL THERE, second. A boss that paid ONLY the
       * quest item would pay less than a husk in the next room, and
       * `resolvers.drops` on Brotoq is two lines (npcs.lua:57-58), not one.
       */
      const carried: string[] = [KNOT_OF_ELSEWHERE_ID];
      const prize = embellish(world, body.id, template.drops?.pick[0], party.level);
      if (prize !== undefined) carried.push(prize);
      body.carried = carried;
    }
    taken.add(key(at));
    placed += 1;
  };

  // ROW BY ROW, COLUMN BY COLUMN, so the ids are minted in the map's own
  // reading order and two runs of the same seed place the same body on the same
  // tile. A `for...of` over the table's keys would order them by the table.
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x += 1) {
      const template = UNDERMOST_GARRISON.get(row.charAt(x));
      if (template === undefined) continue;
      if (template.rank !== ActorRank.Boss) posts.push({ x, y });
      stand(template, { x, y });
    }
  }

  /**
   * THE REST OF THE HORDE, IN THE RING AROUND THE POSTS.
   *
   * Computed, never rolled, for `populateDelve`'s reason: a draw here would
   * consume a position in the world's labelled stream and shift every draw
   * after it — the litter, the lore note, and every Undermost any player has
   * ever walked. The ring is walked in a fixed order and the posts are cycled,
   * so the extras spread over the hall instead of stacking on one picket.
   */
  const wanted = Math.round(posts.length * delveHeadroom(party));
  for (let extra = posts.length; extra < wanted; extra += 1) {
    const post = posts[extra % posts.length];
    if (post === undefined) break;
    const spread = 1 + Math.floor(extra / posts.length);
    const at = freeGroundNear(world, post, spread, taken);
    if (at === undefined) continue;
    stand(UNDERMOST_PICKET, at);
  }
  return placed;
}

/**
 * The first free walkable tile exactly `ring` steps out from `post`, clockwise
 * from due north. `undefined` when that ring is solid rock or already full,
 * which a caller treats as one body fewer rather than as an error — upstream
 * drops a body it cannot place too (engine/generator/actor/Random.lua:118).
 */
function freeGroundNear(
  world: World,
  post: TileXY,
  ring: number,
  taken: ReadonlySet<string>,
): TileXY | undefined {
  for (let dy = -ring; dy <= ring; dy += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      // THE RING, NOT THE BLOCK: the inner rings were walked by earlier extras.
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const at = { x: post.x + dx, y: post.y + dy };
      if (!canWalk(world.level, at.x, at.y)) continue;
      if (taken.has(`${String(at.x)},${String(at.y)}`)) continue;
      if (world.actorAt(at.x, at.y) !== undefined) continue;
      return at;
    }
  }
  return undefined;
}
