// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { ALCHEMIST, INSPECTOR, WATCHMAN } from '../../src/server/content/classes.ts';
import { INDEX_CAIRN, INDEX_HUSK, monsterInit } from '../../src/server/content/monsters.ts';
import { DOWNED_TURNS, goDown, isErased, tickDowned } from '../../src/server/engine/downed.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { canWalk } from '../../src/shared/level.ts';
import { hasLineOfSight } from '../../src/shared/sight.ts';
import { run } from '../../tools/delve-run.mjs';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { LevelView } from '../../src/shared/protocol.ts';
import type { ProbeStage } from '../../tools/delve-run.d.mts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBE'S OWN RULES, DRIVEN THROUGH ITS OWN LOOP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `delve-run.mjs` is the instrument every balance table in this repository is
 * read off, and three of its rules decided the first hour for three classes
 * while no test could see them:
 *
 *   IT OFFERED ATTACKS NOBODY HAD LEARNED, and held still when one was refused.
 *   IT HELD STILL IN A SHOOTER'S LANE when a class with no dead zone could not
 *   pay for a shot, instead of walking in and swinging.
 *   IT REVIVED A CORPSE: an Erased member was a rescue target that `revive`
 *   refuses at no cost, so the rescuer pressed it until the turn cap.
 *
 * Measured, first hour, solo: the Alchemist 7 → 19 of 28, the Redactor 3 → 15,
 * the Inspector 13 → 18; the Watchman's 48 rows byte-identical. Each case below
 * is the smallest room that decides one of those rules, arranged with
 * `opts.stage` and then played by the unaltered loop, so removing the rule turns
 * the case red rather than a table somewhere quietly moving.
 */

const CHAPEL = SITES.get('site:drowned_chapel');

/**
 * A STRAIGHT, OPEN LANE `dist` tiles long, with a tile of floor on every side
 * of both ends, and a clear line down it. Found, never assumed — the floor is
 * generated, and a lane that ran through a pillar would make the room a
 * question about the pillar.
 */
function openLane(level: LevelView, dist: number): { from: TileXY; to: TileXY } {
  const open = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) if (!canWalk(level, x + dx, y + dy)) return false;
    }
    return true;
  };
  for (let y = 2; y < level.h - 2; y += 1) {
    for (let x = 2; x + dist < level.w - 2; x += 1) {
      let clear = true;
      for (let i = 0; i <= dist && clear; i += 1) clear = open(x + i, y);
      if (!clear) continue;
      const from = { x, y };
      const to = { x: x + dist, y };
      if (hasLineOfSight(level, from, to)) return { from, to };
    }
  }
  throw new Error(`no open lane of ${String(dist)} on this floor`);
}

/** Everything but the party off the floor, and one `template` at `dist`. */
function duel(template: MonsterTemplate, dist: number, pool?: number) {
  return ({ world, members }: ProbeStage): void => {
    const ours = new Set(members.map((m) => m.body.id));
    for (const a of world.allActors()) if (!ours.has(a.id)) world.removeActor(a.id);
    const lane = openLane(world.level, dist);
    const lead = members[0]?.body;
    if (lead === undefined) throw new Error('nobody to stage');
    world.placeAt(lead.id, lane.from);
    world.addMonster('staged-foe', monsterInit(template, lane.to));
    if (pool !== undefined) for (const m of members) m.sheet.resource.value = pool;
  };
}

describe('delve-run — the driver plays the character it built', () => {
  it('offers only what has been LEARNED: a level-1 Inspector walks into her own band', () => {
    /**
     * SIX TILES is inside Line of Enquiry's and Closed File's band (3-6) and
     * outside Revolver Shot's (3-5). A level-1 Inspector owns only the last.
     * Offered the whole hotbar, `takeShot` reported a foe in band, the engine
     * refused the unlearned talent, and she held in the Cairn's fire: 0 shots
     * in 6 runs. Offered what she knows, nothing is in band, `firingSpot`
     * walks her to five and she fires.
     */
    expect(CHAPEL, 'the Drowned Chapel is gone').toBeDefined();
    const r = run(CHAPEL, 1, 'probe-rule:learned', {
      party: [INSPECTOR],
      level: 1,
      floor: 1,
      stage: duel(INDEX_CAIRN, 6),
    });
    expect(r.roster, 'the room was not the one arranged').toBe(1);
    expect(r.outcome).toBe('clear');
    expect(
      r.orders['shot'] ?? 0,
      'she won without firing, so this asserted nothing',
    ).toBeGreaterThan(0);
  });

  it('walks in and swings when a body with no dead zone cannot pay for a shot', () => {
    /**
     * THE ALCHEMIST AT 0 REAGENTS, ONE CAIRN AT FIVE. Her Ashwick Flare reaches
     * five, so the Cairn is in band and every flare is refused for want of a
     * reagent — the state she is in for most of a kiter floor. Holding there is
     * standing in its lane at 8-12 a turn: dead by turn 13-15 in six of six.
     * Walking in, she kills it in all six and takes nothing.
     */
    const r = run(CHAPEL, 1, 'probe-rule:close', {
      party: [ALCHEMIST],
      level: 1,
      floor: 1,
      stage: duel(INDEX_CAIRN, 5, 0),
    });
    expect(r.roster).toBe(1);
    expect(r.outcome).toBe('clear');
    expect(r.orders['closed'] ?? 0, 'nothing was walked in, so the rule never ran').toBeGreaterThan(
      0,
    );
  });

  it('lets an Erased member press Respawn instead of being revived until the clock runs out', () => {
    /**
     * TWO WATCHMEN, ONE ALREADY BLED OUT, ONE HUSK. `revive` refuses an Erased
     * body and the refusal is free, so a driver that counted the Erased as a
     * rescue target pressed revive from the corpse's side for the whole run:
     * 772-832 orders a run on the Drowned Chapel, and every party failure a
     * stall. The Erased press Respawn in the game (`respawn`, downed.ts).
     */
    let erased = false;
    const r = run(CHAPEL, 2, 'probe-rule:respawn', {
      party: [WATCHMAN],
      level: 1,
      floor: 1,
      stage: (scene) => {
        duel(INDEX_HUSK, 4)(scene);
        const lead = scene.members[0]?.body;
        const fallen = scene.members[1]?.body;
        if (lead === undefined || fallen === undefined) throw new Error('no second body');
        // BESIDE THE LEAD, so the old rule's rescuer is in reach of the corpse
        // on the first turn and presses the free, refused revive from then on.
        // Measured with the corpse where the floor put it instead: the rescuer
        // bumped the husk to death on its way over, `revived` stayed 0 under the
        // old rule, and this case was green with the bug put back. `openLane`
        // keeps a tile of floor on every side of the lane's end, so this tile
        // is walkable, and the husk is four tiles down the lane.
        scene.world.placeAt(fallen.id, { x: lead.x, y: lead.y + 1 });
        goDown(scene.downed, fallen, 0);
        for (let i = 0; i < DOWNED_TURNS; i += 1) tickDowned(scene.downed, fallen);
        erased = isErased(scene.downed, fallen.id);
      },
    });
    expect(erased, 'the second body was never Erased, so this asserted nothing').toBe(true);
    // THE BUG'S OWN NUMBER FIRST, so the red it turns under the old rule names
    // the bug rather than the counter this rule added.
    expect(r.orders['revived'] ?? 0, 'somebody tried to revive the Erased').toBe(0);
    expect(r.orders['respawned'] ?? 0).toBe(1);
    expect(r.outcome).toBe('clear');
  });
});
