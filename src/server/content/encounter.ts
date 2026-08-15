/**
 * The M4 test encounter — the first monsters that actually exist in a level.
 *
 * WHY THIS FILE EXISTS
 *
 * Every combat system in the engine is built and tested: the barrier, the Bell,
 * partial-save durations, the batched monster sweep, Downed and revive. None of
 * it had ever been SEEN, because no monster was ever placed in a level. The
 * turn loop ran correctly and simply never had cause to make anybody wait.
 *
 * Three monsters, chosen to exercise the three things that are invisible
 * without an enemy:
 *
 *   index_husk        melee chaser  — makes the barrier engage at all. Once a
 *                                     hostile has line of sight, engagement
 *                                     goes above zero and every player on the
 *                                     level owes a decision each turn.
 *   index_wraith      ranged kiter  — makes POSITION matter. It backs away when
 *                                     you close, so a party that clumps gets
 *                                     kited and one that flanks does not.
 *   index_husk_elite  the elite     — a visibly harder body wearing the elite
 *                                     ring, and the reason that ring was drawn.
 *
 * DELIBERATELY HAND-PLACED, NOT GENERATED. Procedural spawning arrives with the
 * zone generator at M5. A fixed table is what makes the first playtest
 * REPRODUCIBLE: everyone meets the same three monsters in the same corners, so
 * "the Bell fired too early" is a report someone else can reproduce rather than
 * a story about a run nobody else had.
 *
 * Placement is far enough from the player spawn that nothing is hunting you the
 * instant you connect — exploration should come first, and the mode switch into
 * combat should feel like tension arriving rather than a fight already lost.
 */

import type { TileXY } from '../../shared/coords.ts';
import { canWalk } from '../../shared/level.ts';
import type { World } from '../world/world.ts';
import { INDEX_HUSK, INDEX_HUSK_ELITE, INDEX_WRAITH, monsterInit } from './monsters.ts';
import type { MonsterTemplate } from './monsters.ts';

type Placement = {
  readonly template: MonsterTemplate;
  readonly at: TileXY;
  /** Why this one is here — the encounter is a design statement, not filler. */
  readonly intent: string;
};

/**
 * The 30x30 test level's open floor sits roughly between x 1-28, y 1-28 with
 * interior wall blocks scattered through it. These tiles were chosen inside
 * open space and away from the spawn corner; `world.addMonster` settles for the
 * nearest free tile anyway, so a wall moving later degrades placement rather
 * than breaking the seed.
 */
const ENCOUNTER: readonly Placement[] = Object.freeze([
  {
    template: INDEX_HUSK,
    at: { x: 22, y: 6 },
    intent: 'the first thing that ever chases you',
  },
  {
    template: INDEX_WRAITH,
    at: { x: 25, y: 20 },
    intent: 'kites — punishes a party that clumps',
  },
  {
    template: INDEX_HUSK_ELITE,
    at: { x: 8, y: 24 },
    intent: 'the elite ring, and a reason to retreat',
  },
]);

export type SeededMonster = {
  readonly id: string;
  readonly name: string;
  readonly at: TileXY;
  readonly intent: string;
};

/**
 * Place the test encounter. Idempotent on id, like `addMonster` itself, so a
 * reconnect or a re-seed cannot double the population.
 *
 * Returns what it placed so the caller can log it — a server that quietly
 * spawned nothing because every tile was occupied is exactly the kind of
 * silence that costs an evening.
 */
export function seedTestEncounter(world: World): SeededMonster[] {
  const placed: SeededMonster[] = [];

  for (const { template, at, intent } of ENCOUNTER) {
    // Skip a tile that is solid rock rather than letting addMonster wander to
    // an arbitrary free one — a monster that silently relocated across the map
    // makes the encounter unreproducible, which defeats the point of a fixed
    // table.
    if (!canWalk(world.level, at.x, at.y)) {
      continue;
    }
    const id = `mon_${template.id}`;
    const actor = world.addMonster(id, monsterInit(template, at));
    placed.push({
      id: actor.id,
      name: template.displayName,
      at: { x: actor.x, y: actor.y },
      intent,
    });
  }

  return placed;
}
