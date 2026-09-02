// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:849-887 (`spotHostiles`)
//                       game/modules/tome/class/Player.lua:974-981 (rest breaks on a spot)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/server/world/world.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { orbOnMyLine } from '../../src/server/engine/projectile.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { RestStop } from '../../src/shared/rest.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REST DID NOT BREAK FOR A SHOT ALREADY IN THE AIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `spotHostiles` takes an `actors_only` flag and rest passes it FALSE
 * (Player.lua:861), so upstream stops a rest for an inbound PROJECTILE as well
 * as for a body. Ours scanned `world.allActors()` and nothing else, so a
 * detective could sit regenerating while a bolt crossed the room at them —
 * which is the precise moment resting is worst, because a rest is accelerated
 * regeneration bought with turns the orb is also using.
 *
 * ═══ THE TUNING IS THE TWO TERMS, NOT THE SCAN ═══
 * "Is there an orb in sight" would be wrong and annoying: every shot fired
 * anywhere down a long room would keep the party standing. Upstream asks
 * whether the orb is on YOUR LINE (`dist_to_line < 1.0`) and still INBOUND (a
 * dot product from its current tile). Both are ported verbatim in
 * `orbOnMyLine`; this file drives them.
 */

function scene(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
  });
  const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
  body.x = 4;
  body.y = 4;
  engine.join('p1');
  engine.setConnected('p1', true);
  engine.pump();
  // Hurt, so the rest genuinely wants to continue and any stop is the THREAT
  // rather than "nothing to rest off".
  body.hp = 10;
  return { world, engine, body };
}

/** A shot from `from` aimed at `to`, fired by somebody other than the player. */
function shoot(world: World, from: { x: number; y: number }, to: { x: number; y: number }) {
  return world.addProjectile({
    sourceId: 'mon_a',
    origin: from,
    to,
    projSpeed: 1,
    range: 20,
    damage: { dam: 5, type: DamageType.Physical, apr: 0 },
  });
}

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

describe('orbOnMyLine', () => {
  const me = { x: 4, y: 4 };

  it('an orb aimed straight at you is on your line', () => {
    const world = createWorld('orb-at-me');
    world.level.tiles.fill(TileCode.FLOOR);
    expect(orbOnMyLine(shoot(world, { x: 10, y: 4 }, { x: 4, y: 4 }), me)).toBe(true);
  });

  it('an orb crossing the room to somewhere else is not', () => {
    /**
     * THE TERM THAT MAKES THIS BEARABLE. Without `dist_to_line < 1.0` every
     * shot fired anywhere in a long room would keep the party on their feet.
     * This one flies four rows away and never comes near.
     */
    const world = createWorld('orb-elsewhere');
    world.level.tiles.fill(TileCode.FLOOR);
    expect(orbOnMyLine(shoot(world, { x: 10, y: 8 }, { x: 1, y: 8 }), me)).toBe(false);
  });

  it('an orb that has already gone past you is not', () => {
    /**
     * THE DOT PRODUCT. The orb is on the line — it was aimed through this tile —
     * but it is now BEHIND the body relative to its target, so it can no longer
     * arrive. Without `our_way`, a shot that missed would pin a player standing
     * for the rest of its flight.
     */
    const world = createWorld('orb-past');
    world.level.tiles.fill(TileCode.FLOOR);
    const orb = shoot(world, { x: 1, y: 4 }, { x: 12, y: 4 });
    // Walk it past the body: origin x=1, body at x=4, target x=12.
    orb.cursor = 6;
    expect(orbOnMyLine(orb, me)).toBe(false);
  });

  it('and a shot with nowhere to go is not a threat', () => {
    const world = createWorld('orb-nowhere');
    world.level.tiles.fill(TileCode.FLOOR);
    expect(orbOnMyLine(shoot(world, { x: 4, y: 4 }, { x: 4, y: 4 }), me)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rest itself
// ---------------------------------------------------------------------------

describe('a rest and a shot in the air', () => {
  it('breaks for an inbound orb, and names it', () => {
    const { world, engine } = scene('rest-orb');
    shoot(world, { x: 10, y: 4 }, { x: 4, y: 4 });

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Hostile);
    expect(result.threat?.name).toBe('a shot');
    // AND IT STOPPED AT ONCE. A rest that noticed the orb after healing to full
    // would report the same `stop` and mean nothing by it.
    expect(result.turns).toBe(0);
  });

  it('does not break for a shot crossing the far side of the room', () => {
    const { world, engine, body } = scene('rest-orb-miss');
    shoot(world, { x: 10, y: 9 }, { x: 1, y: 9 });

    const result = engine.rest('p1');

    expect(result.stop).not.toBe(RestStop.Hostile);
    expect(body.hp).toBe(body.maxHp);
  });

  it('does not break for the player`s OWN shot', () => {
    // "trust ourselves but not our friends" — Player.lua:868, verbatim.
    const { world, engine, body } = scene('rest-own-orb');
    world.addProjectile({
      sourceId: 'p1',
      origin: { x: 10, y: 4 },
      to: { x: 4, y: 4 },
      projSpeed: 1,
      range: 20,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });

    const result = engine.rest('p1');

    expect(result.stop).not.toBe(RestStop.Hostile);
    expect(body.hp).toBe(body.maxHp);
  });

  it('does break for a TEAMMATE`s shot along your line', () => {
    /**
     * The other half of the same sentence, and it reads like a bug until you
     * see why: a friend firing down the line you are lying on is exactly the
     * situation a body should get up for. Upstream trusts only `self`.
     */
    const { world, engine } = scene('rest-friend-orb');
    world.addPlayer('p2', 'p2');
    world.addProjectile({
      sourceId: 'p2',
      origin: { x: 10, y: 4 },
      to: { x: 4, y: 4 },
      projSpeed: 1,
      range: 20,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });

    expect(engine.rest('p1').stop).toBe(RestStop.Hostile);
  });
});

// ---------------------------------------------------------------------------
// The metric the actor scan uses
// ---------------------------------------------------------------------------

describe('a rest and a body at a diagonal', () => {
  it('is not broken by a husk outside the sight CIRCLE', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SCAN USED THE MOVEMENT METRIC AND UPSTREAM USES A CIRCLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `buildRestView` measured with `chebyshev` — the pair `visibleEnemies`
     * uses for monster AGGRO, which is a different question — so a husk at a
     * diagonal king-distance of 10 broke rests at a TRUE distance of 14.1.
     * Upstream asks with `core.fov.calc_circle` (Player.lua:854).
     *
     * (14,14) from (4,4) is exactly that tile: chebyshev 10, true 14.14.
     */
    const { world, engine, body } = scene('rest-diagonal');
    world.addMonster('far', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 14,
      y: 14,
      profile: AiProfile.MeleeChaser,
    });

    const result = engine.rest('p1');

    expect(result.stop).not.toBe(RestStop.Hostile);
    expect(body.hp).toBe(body.maxHp);
  });

  it('and IS broken by one inside it', () => {
    // The control: a husk at a true distance of 7.1 is well inside, so the test
    // above is about the METRIC and not about the scan having stopped working.
    const { world, engine } = scene('rest-diagonal-near');
    world.addMonster('near', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 9,
      y: 9,
      profile: AiProfile.MeleeChaser,
    });

    expect(engine.rest('p1').stop).toBe(RestStop.Hostile);
  });
});
