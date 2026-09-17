import { describe, expect, it } from 'vitest';

import { EffectId, PINNED, createMvpEffectState } from '../../src/server/content/effects.ts';
import { itemById } from '../../src/server/content/items.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { statusApplier } from '../../src/server/engine/effects.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PINNED — `physical.lua:982-998`, AND THE READER'S COMMENT IS THE MECHANIC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Never move but tries to attack ? ok
 * elseif not force and self:attr("never_move") then
 *   if not game.level.map:checkAllEntities(x, y, "block_move", self, true) then
 *     game.logPlayer(self, "You are unable to move!")
 * ```
 *
 * `Actor.lua:1337-1342`. Two facts, and a build can satisfy either alone:
 * the step onto free floor is refused, AND the step into a hostile is still an
 * attack. A gate above the bump would take the swing as well and look correct
 * in every test that only checks the body did not move.
 */

const LANE_Y = 3;

function scene(seed: string, opts: { withHusk?: boolean } = {}) {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 2;
  ren.y = LANE_Y;
  ren.hpRegen = 0;

  if (opts.withHusk === true) {
    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 3,
      y: LANE_Y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
    });
    husk.hpRegen = 0;
  }

  const engine = createTurnEngine({ world, now: () => 0 });
  engine.join('p1');
  const actor = (id: string) => {
    const found = world.getActor(id);
    if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
    return found;
  };
  /**
   * THROUGH THE STATUS DOOR, NOT THE FLAG. This set `flags.pinned` by hand, on
   * the grounds that "the composer is not on trial" — and the composer never
   * collected `pinned`, so every Pinned in the game did nothing while all three
   * cases here passed. No `applyPower`, so no save is rolled.
   */
  const effects = createMvpEffectState();
  const status = statusApplier(effects, world.rng);
  const pin = (id: string): void => {
    expect(status(actor(id), EffectId.Pinned, 3).dur, 'the pin did not land').toBe(3);
  };
  return { world, engine, actor, pin };
}

describe('a pinned body', () => {
  it('cannot step onto free floor', () => {
    const table = scene('pin-move');
    table.pin('p1');

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('p1').x, 'a pinned body walked').toBe(2);
  });

  it('and an unpinned one on the same floor walks — the control', () => {
    // Without this the assertion above is satisfied by a fixture where nothing
    // can move at all, which is exactly how a broken `tryMove` would read.
    const table = scene('pin-control');

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('p1').x).toBe(3);
  });

  it('still swings at what it walked into', () => {
    /**
     * THE HALF A GATE ABOVE THE BUMP WOULD DELETE, and upstream names it in the
     * branch's own comment. The husk is adjacent east; the same order that was
     * refused as a move must land as an attack.
     */
    const table = scene('pin-swing', { withHusk: true });
    table.pin('p1');
    const before = table.actor('m_husk').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('m_husk').hp, 'a pinned body could not fight back').toBeLessThan(before);
    expect(table.actor('p1').x, 'the attack moved the attacker').toBe(2);
  });
});

describe('the status itself', () => {
  it('is a flag, because upstream’s is an attribute with no magnitude', () => {
    expect(PINNED.modifiers?.pinned).toBe(true);
    // NOTHING TO SCALE. `physical.lua` gives it no `parameters`, so there is no
    // power for an immunity to subtract from — unlike CONFUSED, which is the
    // one status in the game whose immunity pays twice.
    expect(PINNED.parameters).toBeUndefined();
    expect(PINNED.subtypes).toEqual(['pin']);
  });
});

describe('something can actually do it', () => {
  it('the Writ of Seizure holds what it hits, at upstream’s tenth and three turns', () => {
    /**
     * `egos/ammo.lua:509-518` — ` of gravity`, `rng.percent(10)`, `EFF_PINNED`
     * for 3. A status with no source is the dead-guard failure this project
     * keeps finding; this is the source, and it is on the RARE mainhand because
     * upstream's is a `greater_ego` at `level_range = {30, 50}`.
     */
    const writ = itemById('item_writ_of_seizure');
    expect(writ?.wielder?.onHit?.effectId).toBe(EffectId.Pinned);
    expect(writ?.wielder?.onHit?.chance).toBe(10);
    expect(writ?.wielder?.onHit?.turns).toBe(3);
    // AND IT ROLLS A SAVE. `items.test.ts` refuses an unsaveable worn rider
    // outright; this pins the VALUE, which sits under the elite claw's 12.
    expect(writ?.wielder?.onHit?.power).toBe(10);
  });
});
