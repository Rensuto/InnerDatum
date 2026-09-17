// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/zones/lake-nur/zone.lua:40-51, :86-94 (the Weir, underwater)
//             t-engine4 game/modules/tome/class/Grid.lua:102-109 (nobody is put where it cannot breathe)
//             t-engine4 game/modules/tome/class/Game.lua:1329-1335 (the level's auras on every body)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SITES DRAWN IN THEIR ZONE'S OWN TERRAIN, OPENED AS REALMS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/shared/mapgen/zones.test.ts` pins what each table draws. These are the
 * joins past it: the real `SITES` row builds the zone's floor, the floor's aura
 * reaches the bodies standing on it, and the population is placed by the rule
 * that keeps a body out of water it cannot breathe — on a floor that is almost
 * all water.
 */

import { describe, expect, it } from 'vitest';

import { EffectId, MVP_EFFECTS, createMvpEffectState } from '../../src/server/content/effects.ts';
import { effectsOn } from '../../src/server/engine/effects.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms, floorsOfSite } from '../../src/server/world/realms.ts';
import type { Realm } from '../../src/server/world/realms.ts';
import { tileAt } from '../../src/shared/level.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { airOf, breathes } from '../../src/shared/terrain.ts';

const WEIRS = ['site:the_weir', 'site:redaction:the_weir'] as const;

/** Floor `floor` of `siteId`, opened with the status table, as the server opens it. */
function open(siteId: string, seed: string, floor: number) {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  const effects = createMvpEffectState();
  const realms = createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, effects }),
    effects,
  });
  const realm = realms.open(site, `party:${seed}`, undefined, undefined, undefined, floor);
  return { realm, effects };
}

function monstersOf(realm: Realm) {
  return realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
}

describe('the Weir, underwater', () => {
  it('names the server`s own underwater aura, which is a zone-wide effect', () => {
    // `shared/` spells the id as a string; this is the other end of it.
    expect(EffectId.ZoneAuraUnderwater).toBe('effect:zone_aura_underwater');
    const def = MVP_EFFECTS.find((d) => d.id === EffectId.ZoneAuraUnderwater);
    expect(def?.zoneWide).toBe(true);
  });

  it('opens every floor, original and twin, as water with the aura on every body in it', () => {
    for (const siteId of WEIRS) {
      for (let floor = 1; floor <= floorsOfSite(siteId); floor += 1) {
        const at = `${siteId} floor ${String(floor)}`;
        const { realm, effects } = open(siteId, `weir:${String(floor)}`, floor);
        expect(realm.zoneEffects, at).toEqual([EffectId.ZoneAuraUnderwater]);
        const arrival = realm.spawns[0];
        if (arrival === undefined) throw new Error(`${at}: no arrival`);
        expect(tileAt(realm.world.level, arrival.x, arrival.y), at).toBe(TileCode.WATER_FLOOR);
        const bodies = monstersOf(realm);
        expect(bodies.length, at).toBeGreaterThan(0);
        for (const body of bodies) {
          const worn = effectsOn(effects, body.id).map((e) => e.effectId);
          expect(worn, `${at}: ${body.id}`).toContain(EffectId.ZoneAuraUnderwater);
        }
      }
    }
  });

  it('puts at least one body on every floor, and none where it would drown', () => {
    /**
     * THIS SAID EVERY BODY THE WEIR PLACED WAS AN INDEX CAIRN, and it was: the
     * Weir shared `DROWNED`, two husks to a cairn, and a husk does not breathe
     * water, so the cairns (`no_breath`, `npcs/crystal.lua:48`) stood alone, two
     * to a floor. Upstream fills this level from `water_rarity` creatures
     * (lake-nur/zone.lua:91), and the Weir has those now (`WEIR`, content/delve.ts),
     * all three `can_breath={water=1}` (`npcs/aquatic_critter.lua:38`).
     * `weir-roster.test.ts` holds the whole band and the drowning run; this is
     * the breath rule over every body on the floor.
     */
    for (const siteId of WEIRS) {
      for (let floor = 1; floor <= floorsOfSite(siteId); floor += 1) {
        for (let s = 0; s < 3; s += 1) {
          const at = `${siteId} floor ${String(floor)} seed ${String(s)}`;
          const { realm } = open(siteId, `breath:${String(s)}`, floor);
          const bodies = monstersOf(realm);
          expect(bodies.length, at).toBeGreaterThanOrEqual(1);
          for (const body of bodies) {
            const air = airOf(tileAt(realm.world.level, body.x, body.y));
            const safe = air === undefined || body.noBreath === true || breathes(body, air);
            expect(safe, `${at}: ${body.id} stands in water it cannot breathe`).toBe(true);
          }
        }
      }
    }
  });
});

describe('the sites drawn in their own codes, and dry', () => {
  it('opens Cairnfoot and the Glass Archive in their zone`s codes, with no aura', () => {
    const own: Readonly<Record<string, readonly [TileCode, TileCode]>> = {
      'site:cairnfoot': [TileCode.UNDERGROUND_FLOOR, TileCode.UNDERGROUND_TREE],
      'site:glass_archive': [TileCode.CRYSTAL_FLOOR, TileCode.CRYSTAL_WALL],
    };
    for (const [siteId, [floorCode, wallCode]] of Object.entries(own)) {
      const { realm } = open(siteId, 'own', 1);
      expect(realm.zoneEffects, siteId).toEqual([]);
      const codes = new Set(realm.world.level.tiles);
      expect(codes.has(floorCode) && codes.has(wallCode), siteId).toBe(true);
      const arrival = realm.spawns[0];
      if (arrival === undefined) throw new Error(`${siteId}: no arrival`);
      expect(tileAt(realm.world.level, arrival.x, arrival.y), siteId).toBe(floorCode);
    }
  });

  it('opens Blackwood with its ponds and no aura, and nobody placed in a pond', () => {
    let ponds = 0;
    for (let s = 0; s < 6; s += 1) {
      const { realm } = open('site:blackwood_outskirts', `pond:${String(s)}`, 1);
      expect(realm.zoneEffects).toEqual([]);
      if (realm.world.level.tiles.includes(TileCode.POND_WATER)) ponds += 1;
      for (const body of monstersOf(realm)) {
        const code = tileAt(realm.world.level, body.x, body.y);
        expect(code === TileCode.POND_WATER && body.noBreath !== true, body.id).toBe(false);
      }
    }
    expect(ponds, 'no Blackwood floor dug a pond').toBeGreaterThan(0);
  });
});
