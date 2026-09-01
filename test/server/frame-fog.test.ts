// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Actor.lua:30-34 (display_on_seen, remember FALSE)
//                       game/engines/default/engine/Object.lua:28-29 (remember TRUE — see the note below)
//                       game/engines/default/engine/Grid.lua:30-32 (terrain remembered)
//                       game/modules/tome/class/Projectile.lua:29-31 (seen only, never remembered)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { projectEffects, projectProjectiles } from '../../src/server/view/projector.ts';
import { visibleActorIds } from '../../src/server/view/projector.ts';
import { SIGHT_RADIUS } from '../../src/server/world/sight.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { STUNNED } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BADGE IS A FACT ABOUT A BODY. AN ORB IS A POSITION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `6d201c3` fogged the board and `3911b1b` fogged the event stream, and both
 * left these two frames going to the whole realm. Each leaked in its own way:
 *
 *   `EffectsMsg`      told you an unseen monster was Off-balance, which names
 *                     it. `Actor.lua:30-34` is `display_on_seen = true`,
 *                     `display_on_remember = FALSE` — a body you cannot see is
 *                     not drawn, and nor is anything about it.
 *   `ProjectilesMsg`  drew every orb in the sky. `Projectile.lua:29-31` is the
 *                     same pair, and sharper: never remembered, because where a
 *                     bolt was two turns ago is not where it is.
 *
 * ═══ WHAT IS DELIBERATELY NOT IN THIS COMMIT ═══
 * `GroundMsg`. Objects are NOT gated like actors — `Object.lua:28-29` sets
 * `display_on_seen = true` AND `display_on_remember = true`, exactly as
 * `Grid.lua:30-32` does for terrain. You remember a coat you walked past. So
 * fogging floor loot to currently-visible tiles would be a DEVIATION dressed as
 * a fidelity fix; the faithful version filters against each player's EXPLORED
 * bitset, which is per-player, persisted, and a larger job. It is its own commit.
 */

const RNG = () => createRng('frame-fog');

/** An open field, so only the rule under test can hide anything. */
function field(): World {
  const world = createWorld('frame-fog');
  world.level.tiles.fill(TileCode.FLOOR);
  return world;
}

function husk(world: World, id: string, x: number, y: number) {
  return world.addMonster(id, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
  });
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

describe('the effects frame', () => {
  /** A world with one stunned husk near the door and one stunned husk far off. */
  function stunned() {
    const world = field();
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    const near = husk(world, 'near', 3, 1);
    const far = husk(world, 'far', 1 + SIGHT_RADIUS + 3, 1);
    expect(world.level.w).toBeGreaterThan(far.x);

    const effects = createEffectState([STUNNED]);
    setEffect(effects, near, STUNNED.id, 3, {}, RNG());
    setEffect(effects, far, STUNNED.id, 3, {}, RNG());
    return { world, effects };
  }

  it('carries the badge of a monster you can see', () => {
    const { world, effects } = stunned();
    const seen = visibleActorIds(world, [{ x: 1, y: 1 }]);
    const rows = projectEffects(world, effects, undefined, seen).actors.map((a) => a.id);
    expect(rows).toContain('near');
  });

  it('says nothing about a monster you cannot', () => {
    /**
     * THE LEAK. A badge row names an actor id, so shipping it for an unseen
     * husk told the client that something out there was Stunned — and the id is
     * enough to ask about, and the row's existence is enough to count.
     */
    const { world, effects } = stunned();
    const seen = visibleActorIds(world, [{ x: 1, y: 1 }]);
    const rows = projectEffects(world, effects, undefined, seen).actors.map((a) => a.id);
    expect(rows).not.toContain('far');
  });

  it('and with no eyes given, says everything — the GM console', () => {
    const { world, effects } = stunned();
    const rows = projectEffects(world, effects).actors.map((a) => a.id);
    expect(rows).toContain('near');
    expect(rows).toContain('far');
  });
});

// ---------------------------------------------------------------------------
// Orbs
// ---------------------------------------------------------------------------

describe('the projectiles frame', () => {
  function sky() {
    const world = field();
    const player = world.addPlayer('p1', 'Dalt');
    player.x = 1;
    player.y = 1;
    husk(world, 'shooter', 4, 1);
    husk(world, 'sniper', 1 + SIGHT_RADIUS + 3, 1);

    // One orb in front of the party, one crossing the far end of the map.
    const near = world.addProjectile({
      sourceId: 'shooter',
      origin: { x: 4, y: 1 },
      to: { x: 2, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    const far = world.addProjectile({
      sourceId: 'sniper',
      origin: { x: 1 + SIGHT_RADIUS + 3, y: 1 },
      to: { x: 1 + SIGHT_RADIUS + 1, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    return { world, near: near.id, far: far.id };
  }

  const EYES = [{ x: 1, y: 1 }];

  it('draws an orb over ground you can see', () => {
    const { world, near } = sky();
    expect(projectProjectiles(world, EYES).projectiles.map((p) => p.id)).toContain(near);
  });

  it('does not draw one crossing the far end of the map', () => {
    const { world, far } = sky();
    expect(projectProjectiles(world, EYES).projectiles.map((p) => p.id)).not.toContain(far);
  });

  it('names the shooter when you can see them', () => {
    const { world, near } = sky();
    const orb = projectProjectiles(world, EYES).projectiles.find((p) => p.id === near);
    expect(orb?.sourceId).toBe('shooter');
  });

  it('DRAWS a shot from the dark, and does not name who fired it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE WHOLE REDACTION RULE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The orb is gated on ITS OWN tile and never on its shooter. Gating on the
     * shooter would hide incoming fire from the dark — the one thing a player
     * most needs to see, and which the engine is going to resolve either way.
     *
     * So the shot shows and the shooter does not. Upstream draws the orb by the
     * same rule (`Projectile.lua:29-31` is about the projectile's own tile) and
     * keeps `src` as an object reference that is never rendered.
     */
    const { world } = sky();
    const sniperShot = world.addProjectile({
      sourceId: 'sniper',
      origin: { x: 5, y: 1 },
      to: { x: 2, y: 1 },
      projSpeed: 1,
      range: 10,
      damage: { dam: 5, type: DamageType.Physical, apr: 0 },
    });
    const orb = projectProjectiles(world, EYES).projectiles.find((p) => p.id === sniperShot.id);
    expect(orb, 'a shot over visible ground was withheld because of its shooter').toBeDefined();
    expect(orb?.sourceId, 'the unseen shooter was named').toBeUndefined();
    expect(JSON.stringify(orb), 'the name survived serialisation').not.toContain('sniper');
  });

  it('and with no eyes given, the whole sky — the GM console', () => {
    const { world, far } = sky();
    expect(projectProjectiles(world).projectiles.map((p) => p.id)).toContain(far);
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('every player-facing frame is built with eyes', () => {
  it('the gateway never builds one without them', () => {
    /**
     * A SOURCE GUARD, on the terms `fov.test.ts` sets out: there is no runtime
     * seam that can tell a GM read from a player read, and every call in the
     * gateway serves a player. Both fogged forms take their argument at a fixed
     * place, so "is the fog argument there" is checkable by reading the call.
     */
    const text = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const [fn, needs] of [
      ['projectEffects', 'visibleActorIds'],
      ['projectProjectiles', 'eyesIn'],
    ] as const) {
      for (const match of text.matchAll(new RegExp(`${fn}\\(`, 'g'))) {
        const call = text.slice(match.index, match.index + 220);
        expect(
          call.includes(needs),
          `a ${fn} call in the gateway has no ${needs} — that frame goes out unfogged`,
        ).toBe(true);
      }
    }
  });

  it('and the ground frame is still deliberately unfogged, with a reason on file', () => {
    /**
     * PINNED SO IT IS A DECISION AND NOT AN OVERSIGHT. `Object.lua:28-29` sets
     * `display_on_remember = true`, so floor loot is remembered like terrain and
     * gating it on current sight would be a deviation. When it IS fogged it must
     * be against each player's explored bitset — and this assertion should fail
     * then, which is the point of writing it down.
     */
    const projector = readFileSync(
      new URL('../../src/server/view/projector.ts', import.meta.url),
      'utf8',
    );
    expect(projector).toContain('export function projectGroundItems(world: World): GroundMsg');
  });
});
