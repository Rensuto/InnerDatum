// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PARTY THAT WIPES IN A DELVE STANDS BACK UP IN THAT DELVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resetFloor` reaps every monster and calls the engine's `reseedFloor`, which
 * defaulted to `seedTestEncounter`: three hand-placed Alderbrook monsters at the
 * test map's coordinates. No realm engine passed anything else, so a wipe in any
 * delve brought back whichever of those three landed on walkable ground, and
 * never the floor's own population — on a boss floor, never the boss.
 *
 * THE ENGINES HERE ARE BUILT THE WAY `main.ts` BUILDS THEM: `createTurnEngine`
 * with no `reseedFloor` of its own. What puts the floor back is whatever the
 * realm handed its world (`World.reseedFloor`), which is the join under test.
 */

import { describe, expect, it } from 'vitest';

import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { DEEPER_FLOORS, floorsToWalk, specFor } from '../../src/server/content/delve.ts';
import {
  ENCOUNTER_SITE,
  RealmKind,
  SITES,
  createRealms,
  floorsOfSite,
} from '../../src/server/world/realms.ts';
import { Ground } from '../../src/shared/level.ts';
import type { DownedState } from '../../src/server/engine/downed.ts';
import type { Realm, Realms } from '../../src/server/world/realms.ts';
import type { Actor } from '../../src/server/world/world.ts';

type Rig = { readonly realms: Realms; readonly downed: DownedState };

function rig(seed: string): Rig {
  const downed = createDownedState();
  return {
    downed,
    realms: createRealms({
      seed,
      engineFor: (world) => createTurnEngine({ world, downed, now: () => 0 }),
    }),
  };
}

function monstersOf(realm: Realm): Actor[] {
  return realm.world.allActors().filter((a) => a.kind === 'monster');
}

/** The part of a monster's id its realm did not add. */
function bareId(realm: Realm, actor: Actor): string {
  return actor.id.slice(realm.id.length + 1);
}

type Floor = {
  readonly monsters: readonly string[];
  readonly ground: number;
  readonly traps: number;
  readonly props: number;
};

function snapshot(realm: Realm): Floor {
  return {
    monsters: monstersOf(realm)
      .map((a) => bareId(realm, a))
      .toSorted(),
    ground: realm.world.groundItems().length,
    traps: realm.world.traps().length,
    props: realm.world.props().length,
  };
}

/** One body walks in and goes down alone, which is a party wipe. */
function wipe(realm: Realm, downed: DownedState): void {
  const body = realm.world.addPlayer('p1', 'Ren');
  body.hpRegen = 0;
  body.hp = 0;
  body.alive = false;
  goDown(downed, body, realm.world.turn.clock.gameTurn);
  realm.engine.pump();
  const back = realm.world.getActor('p1');
  // THE PRECONDITION, so a pump that did not wipe cannot pass every check below
  // by never having reset anything.
  expect(back?.alive, `${realm.id}: the wipe did not restore the body`).toBe(true);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIRST FLOOR AND LAST, FOR EVERY DELVE THAT BUILDS A POPULATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `floorsToWalk` RATHER THAN `floorsOfSite`, AND THIS FILE IS THE READER THAT
 * SWEEP MISSED. `floorsToWalk`'s own note lists eleven callers that ENUMERATED
 * a site's floors and had to be bounded when a site with no bottom landed. This
 * was the twelfth, and it was missed because it does not enumerate: it uses the
 * answer as a FLOOR NUMBER, one row of an `it.each`. `[1, 1000000000]` is two
 * rows and looks cheap — and then `realms.open` calls `site.map(seed, ground,
 * 1000000000)` unconditionally (`world/realms.ts`), which is a billion links of
 * the Tower's chain, about four core-hours, in a synchronous loop that
 * `--testTimeout` cannot interrupt. Not a slow test: a suite that never returns.
 *
 * So the shape to check a new caller against is not the `for` loop. It is
 * ANY use of a site's depth as a number to hand to something.
 */
const DELVE_FLOORS = [...SITES.values()]
  .filter((site) => site.kind === RealmKind.Inner && site.populate !== undefined)
  .flatMap((site) => {
    const spec = specFor(site.id);
    const last = spec === undefined ? floorsOfSite(site.id) : floorsToWalk(spec);
    return [...new Set([1, last])].map((floor) => ({ site, floor }));
  });

/**
 * AND THE BOUND IS CHECKED AT IMPORT, NOT IN A CASE — because the failure it
 * guards is a HANG, and a hang inside `it.each` never reaches an assertion. A
 * `throw` here fails the whole file in milliseconds with the reason on it;
 * an `expect` in the first case would go red and then the run would stop
 * anyway on the case after it. Revert the two lines above and this fires.
 */
const DEEPEST_SWEPT = Math.max(...DELVE_FLOORS.map(({ floor }) => floor));
if (DEEPEST_SWEPT > DEEPER_FLOORS) {
  throw new Error(
    `realm-wipe: this sweep opens floor ${String(DEEPEST_SWEPT)}, past the deepest floor any ` +
      `site with a bottom has (${String(DEEPER_FLOORS)}). Opening a floor is not free — see ` +
      `\`floorsToWalk\`. Bound it rather than letting the run hang.`,
  );
}

describe('a party wipe puts the floor back as itself', () => {
  it('covers every delve that builds a population, first floor and last', () => {
    // A SWEEP IS ONLY AS GOOD AS WHAT IT SWEEPS. Three `populate` bodies call
    // `populateDelve` (authored delves, their redacted twins, the Undermost),
    // and each forwards the scope on its own.
    expect(DELVE_FLOORS.length).toBeGreaterThan(20);
    expect(DELVE_FLOORS.some(({ site }) => site.id.startsWith('site:redaction:'))).toBe(true);
    expect(DELVE_FLOORS.some(({ site }) => site.birthplace === true)).toBe(true);
  });

  it.each(DELVE_FLOORS.map(({ site, floor }) => [site.id, floor] as const))(
    '%s floor %i: its own hostiles, and nothing else rolled again',
    (siteId, floor) => {
      const { realms, downed } = rig(`realm-wipe:${siteId}:${String(floor)}`);
      const site = SITES.get(siteId);
      if (site === undefined) throw new Error(`no such site: ${siteId}`);
      const realm = realms.open(
        site,
        'party-a',
        { level: 1, size: 1 },
        undefined,
        undefined,
        floor,
      );
      const before = snapshot(realm);

      wipe(realm, downed);
      const after = snapshot(realm);

      // THE FLOOR'S OWN NAMES. `populateDelve` mints `delve_<n>` and
      // `delve_boss`; the test encounter mints `mon_<template>`.
      //
      // AND THE ONE DRAWN FLOOR MINTS ITS OWN. The Undermost's last floor
      // places its fight by glyph rather than rolling it
      // (`populateUndermostHall`), so its names are `undermost_warden_<n>` and
      // `undermost_picket_<n>`. They are in this pattern for the reason the
      // other two are: a body that came back under a name nothing here knows
      // is a re-seed that ran the wrong populator.
      for (const id of after.monsters) {
        expect(id, siteId).toMatch(/^(delve_(\d+|boss)|undermost_(warden|picket)_\d+)$/);
      }
      // A POPULATED FLOOR COMES BACK POPULATED, AND AN EMPTY ONE STAYS EMPTY.
      expect(after.monsters.length > 0, `${siteId} floor ${String(floor)}`).toBe(
        before.monsters.length > 0,
      );
      // AND THE BOSS WITH IT — either kind of boss. A party that clears the
      // Undermost's hall by DYING in it would be a party that walked out past
      // an empty doorway.
      const bossOf = (ids: readonly string[]): number =>
        ids.filter((id) => id === 'delve_boss' || id.startsWith('undermost_warden_')).length;
      expect(bossOf(after.monsters), siteId).toBe(bossOf(before.monsters));

      // NOTHING THAT IS THE FLOOR RATHER THAN ON IT. `resetFloor` took the items
      // and left the traps and props; putting hostiles back must not re-roll
      // the litter onto the floor or lay a second set of either.
      expect(after.ground, `${siteId}: litter rolled again`).toBe(0);
      expect(after.traps, `${siteId}: traps laid again`).toBe(before.traps);
      expect(after.props, `${siteId}: props laid again`).toBe(before.props);
    },
  );

  it('puts a boss floor`s dressing down once, so the props check above has something to catch', () => {
    const bossFloors = DELVE_FLOORS.filter(({ site, floor }) => {
      const { realms } = rig(`realm-wipe-boss:${site.id}`);
      const realm = realms.open(
        site,
        'party-a',
        { level: 1, size: 1 },
        undefined,
        undefined,
        floor,
      );
      return snapshot(realm).props > 0;
    });
    expect(bossFloors.length).toBeGreaterThan(0);
  });

  it('puts an ambush back as the same ambush', () => {
    const { realms, downed } = rig('realm-wipe:ambush');
    const realm = realms.open(ENCOUNTER_SITE, 'party-a', { level: 1, size: 1 }, Ground.Upland);
    const before = snapshot(realm);
    expect(before.monsters.length).toBeGreaterThan(0);

    wipe(realm, downed);

    expect(snapshot(realm).monsters).toEqual(before.monsters);
  });

  it('leaves a world with nothing to put back on the engine`s own default', () => {
    // THE OVERWORLD AND THE TOWNS HAND THEIR WORLD NOTHING: no hostiles live
    // there, and a fixture built with `createWorld(seed)` keeps the default it
    // has always had.
    const { realms } = rig('realm-wipe:overworld');
    expect(realms.overworld.world.reseedFloor).toBeUndefined();
    for (const site of SITES.values()) {
      if (site.kind === RealmKind.Inner) continue;
      expect(realms.open(site, 'party-a').world.reseedFloor, site.id).toBeUndefined();
    }
  });
});
