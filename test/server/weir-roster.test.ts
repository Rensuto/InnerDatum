// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/npcs/aquatic_critter.lua:24-98
//             t-engine4 game/modules/tome/data/zones/lake-nur/zone.lua:86-94 (level 2, water_rarity)
//             t-engine4 game/modules/tome/data/zones/lake-nur/npcs.lua:20-21 (rarity renamed)
//             t-engine4 game/engines/default/engine/Zone.lua:217-221 (10000 / rarity)
//             t-engine4 game/engines/default/engine/Entity.lua:73-80 (importBase merges)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WEIR'S OWN CREATURES: THE CITED NUMBERS, THE WEIGHTS, AND THE WATER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three questions. Are the templates the Lua's numbers? Does the cycle
 * `populateDelve` walks give upstream's 5:5:1 at the sizes the Weir places? And
 * on the real floors, original and twin, alone and three-strong: does every body
 * get placed, and does anything drown once the AI starts moving it about?
 */

import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { DELVES, dangerWord, delveHeadroom, specFor } from '../../src/server/content/delve.ts';
import {
  INDEX_CAIRN,
  INDEX_INKWELL,
  INDEX_RIBBON,
  INDEX_STRONGBOX,
} from '../../src/server/content/monsters.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import { AiProfile, MAX_AIR } from '../../src/server/engine/actor.ts';
import { hasEffect } from '../../src/server/engine/effects.ts';
import { dirToward } from '../../src/server/engine/talents.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms, floorsOfSite } from '../../src/server/world/realms.ts';
import type { PartyStrength } from '../../src/server/world/strength.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';
import { canRoute } from '../../src/shared/level.ts';
import { findPath } from '../../src/shared/path.ts';

const THREE = [INDEX_RIBBON, INDEX_INKWELL, INDEX_STRONGBOX] as const;
const NAMES = new Set(THREE.map((t) => t.displayName));
const WEIRS = ['site:the_weir', 'site:redaction:the_weir'] as const;

describe('BASE_NPC_AQUATIC_CRITTER, aquatic_critter.lua:24-42, on all three', () => {
  it.each(THREE.map((t) => [t.id, t] as const))('%s carries the base', (_id, t) => {
    expect(t.canBreath).toEqual({ water: 1 }); // :38
    expect(t.noBreath).toBeUndefined();
    expect(t.autoStats).toEqual(['str', 'str', 'dex']); // :29 `warrior`
    expect(t.profile).toBe(AiProfile.MeleeChaser); // :30
    expect(t.talentIn).toBeUndefined(); // :30 `talent_in=1`
    expect(t.combat.mods).toEqual({ armour: 1, def: 1 }); // :32
    expect(t.combat.weapon).toEqual({ dam: 10, atk: 25, apr: 7, damMod: { str: 0.8 } }); // :33
    expect(t.maxHp).toBe(25); // :34 rngavg(20,30)
    expect(t.lifeRating).toBe(9); // :34
    expect(t.aggroRange).toBe(10); // :35 infravision
    expect(t.globalSpeed).toBe(1);
    expect(t.opensDoors).toBeUndefined();
    // No `resolvers.drops` anywhere in the family, and `drops` is authored on
    // every template anyway: these drop what the cairn they replaced drops, one
    // common piece, always. See the region header above `INDEX_RIBBON`.
    expect(t.drops).toEqual(INDEX_CAIRN.drops);
    expect(t.drops?.chance).toBe(100);
    // :40, and it survives the dragon turtle's own `resists` because `importBase` merges.
    expect(t.combat.profile?.resists?.[DamageType.Cold]).toBe(25);
  });
});

describe('each creature, as it differs from the base', () => {
  it('the giant eel (:44-49) is the base and nothing else, rank 1', () => {
    expect(INDEX_RIBBON.combat.stats).toEqual({ str: 12, dex: 10, con: 13, mag: 3 });
    expect(INDEX_RIBBON.combat.profile?.resists).toEqual({ [DamageType.Cold]: 25 });
    expect(INDEX_RIBBON.talents).toBeUndefined();
    expect(INDEX_RIBBON.rank).toBe(ActorRank.Normal);
  });

  it('the squid (:91-98) knows Grab (:96), rank 1', () => {
    expect(INDEX_INKWELL.combat.stats).toEqual({ str: 12, dex: 10, con: 13, mag: 3 });
    expect(INDEX_INKWELL.combat.profile?.resists).toEqual({ [DamageType.Cold]: 25 });
    expect(INDEX_INKWELL.talents).toEqual(['talent:grab']);
    expect(INDEX_INKWELL.rank).toBe(ActorRank.Normal);
  });

  it('the dragon turtle (:67-75) is Strength 22 and physical 50 ON TOP of cold 25, rank 2', () => {
    expect(INDEX_STRONGBOX.combat.stats).toEqual({ str: 22, dex: 10, con: 13, mag: 3 }); // :73
    expect(INDEX_STRONGBOX.combat.profile?.resists).toEqual({
      [DamageType.Cold]: 25,
      [DamageType.Physical]: 50, // :74
    });
    expect(INDEX_STRONGBOX.talents).toBeUndefined();
    // `Normal` IS upstream's rank 2 (RANK_VALUE, shared/leveling.ts).
    expect(INDEX_STRONGBOX.rank).toBe(ActorRank.Normal);
  });
});

describe('the Weir`s roster', () => {
  const roster = specFor('site:the_weir')?.roster ?? [];

  it('is the three, weighted 5:5:1 — `floor(10000 / rarity)` at rarities 1, 1 and 5', () => {
    const count = (t: MonsterTemplate): number => roster.filter((r) => r === t).length;
    expect(roster).toHaveLength(11);
    expect([count(INDEX_RIBBON), count(INDEX_INKWELL), count(INDEX_STRONGBOX)]).toEqual([5, 5, 1]);
  });

  it('gives a room of n bodies round(n / 11) turtles at every size, because the cycle is walked in order', () => {
    /**
     * `populateDelve` takes `roster[i % roster.length]` for body i. So a room of
     * n holds whatever the first n steps of the cycle hold, and the turtle's
     * POSITION decides the small rooms. The Weir places 4-6 alone and 8-12 for
     * three; its twin 6-8 and 12-16. Checked well past both.
     */
    for (let n = 1; n <= 40; n += 1) {
      let turtles = 0;
      let eels = 0;
      for (let i = 0; i < n; i += 1) {
        if (roster[i % roster.length] === INDEX_STRONGBOX) turtles += 1;
        if (roster[i % roster.length] === INDEX_RIBBON) eels += 1;
      }
      expect(turtles, `a room of ${String(n)}`).toBe(Math.round(n / 11));
      // Eel and squid never more than one apart.
      expect(Math.abs(eels - (n - turtles - eels)), `a room of ${String(n)}`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('holds no cairn on either map, and the cairn keeps the three rooms that still share DROWNED', () => {
    for (const siteId of WEIRS) expect(specFor(siteId)?.roster).not.toContain(INDEX_CAIRN);
    for (const siteId of ['site:drowned_chapel', 'site:undermost', 'site:cairnfoot']) {
      expect(DELVES.get(siteId)?.roster, siteId).toContain(INDEX_CAIRN);
    }
  });

  it('keeps its bands and its level: 4-6 bodies at level 6, and the twin 6-8 at 10', () => {
    expect(specFor('site:the_weir')).toMatchObject({ monsters: [4, 6], levelRange: [6, 6] });
    expect(specFor('site:redaction:the_weir')).toMatchObject({
      monsters: [6, 8],
      levelRange: [10, 10],
    });
    expect(specFor('site:redaction:the_weir')?.roster).toBe(roster);
  });

  it('grades as it did with the cairn in it — restless, and dangerous on the twin — because it is under water', () => {
    /**
     * THE GRADE IS LOAD-BEARING. The first case reads it to pick where a new
     * character is sent, and `first-room.test.ts` holds every `quiet` room to a
     * beginner's survival. Without the cairn neither of `dangerWord`'s roster
     * terms fires on three melee `Normal` bodies, so the Weir fell to `quiet`
     * and a beginner at the band's top died in two turns. The `underwater` term
     * reads `can_breath` and puts both grades back where they were.
     */
    const weir = specFor('site:the_weir');
    const twin = specFor('site:redaction:the_weir');
    if (weir === undefined || twin === undefined) throw new Error('no Weir spec');
    expect(dangerWord(weir)).toBe('restless');
    expect(dangerWord(twin)).toBe('dangerous');
    // BY PROPERTY, NOT BY NAME: a body that is none of the three but breathes
    // water grades the room the same, and the Ribbon with its `can_breath`
    // taken off is three melee `Normal` bodies again, six of which are `quiet`.
    const { canBreath: _water, ...dry } = INDEX_RIBBON;
    const wet = { ...dry, id: 'fixture_breather', canBreath: { water: 1 } };
    expect(dangerWord({ ...weir, roster: [wet] })).toBe('restless');
    expect(dangerWord({ ...weir, roster: [dry] })).toBe('quiet');
  });
});

/** One floor of a Weir, opened the way the server opens it, for this party. */
function open(siteId: string, seed: string, floor: number, party: PartyStrength) {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  const effects = createMvpEffectState();
  const realms = createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, effects, now: () => 0 }),
    effects,
  });
  const realm = realms.open(site, `party:${seed}`, party, undefined, undefined, floor);
  const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
  return { realm, effects, bodies };
}

const ALONE: PartyStrength = { level: 1, size: 1 };
const THREE_STRONG: PartyStrength = { level: 1, size: 3 };

describe('the Weir, populated', () => {
  it('places the whole band on every floor, original and twin, alone and three-strong', () => {
    /**
     * EVERY BODY, NOT "AT LEAST ONE". All three breathe the water, so
     * `breathableFor` hands each of them the whole room and nothing is skipped:
     * the count is exactly the rolled band times `delveHeadroom`. A creature
     * that lost its `can_breath` would have nowhere to stand and the count
     * would fall under the band — which is what the Weir did with husks.
     */
    for (const siteId of WEIRS) {
      const spec = specFor(siteId);
      if (spec === undefined) throw new Error(`no spec for ${siteId}`);
      for (const party of [ALONE, THREE_STRONG]) {
        const low = Math.round(spec.monsters[0] * delveHeadroom(party));
        const high = Math.round(spec.monsters[1] * delveHeadroom(party));
        for (let floor = 1; floor <= floorsOfSite(siteId); floor += 1) {
          for (let s = 0; s < 10; s += 1) {
            const at = `${siteId} floor ${String(floor)} party ${String(party.size)} seed ${String(s)}`;
            const { bodies } = open(siteId, `weir-pop:${String(s)}`, floor, party);
            expect(bodies.length, at).toBeGreaterThanOrEqual(Math.max(1, low));
            expect(bodies.length, at).toBeLessThanOrEqual(high);
            for (const body of bodies)
              expect(NAMES.has(body.name), `${at}: ${body.name}`).toBe(true);
          }
        }
      }
    }
  });

  it('drowns nothing in 200 turns of AI, with a detective walking into it', () => {
    /**
     * A detective who does not breathe and cannot be killed walks a real route
     * to the nearest living body for 200 turns, so the room wakes and chases
     * through water on every floor of both maps. Checked after EVERY pump: no
     * body has less than a full breath, and none ever wears SUFFOCATING.
     *
     * ═══ `isSuffocating` IS NOT THE QUESTION, AND ASSERTING IT FALSE WAS SEED LUCK ═══
     * A bubble's +15 names no condition, so it sets `isSuffocating` on EVERY body
     * that stands on it, water-breathers included, and hands it air: 115, bounded
     * back to 100 at the next base turn (`breathe`, engine/actor.ts, kept as
     * upstream wrote it). This asserted the flag false and passed on its one seed
     * because nothing happened to be on a bubble when it looked; 17 of 20 other
     * seeds failed it. The flag and the gift are set together in `breathe` and
     * nowhere else for these bodies, so the rule is that one never appears
     * without the other, wherever the body has walked since. Two seeds, and a
     * bubble must be seen, or the rule was never exercised.
     *
     * A STEP THE SCHEDULER REFUSES DOES NOT END THE TURN (a wall, a body in the
     * way), so a refused pump is followed by a hold — otherwise the loop spins on
     * one game turn and nothing ever acts.
     */
    let moved = 0;
    let bubbled = 0;
    for (const seed of ['weir-drown-1', 'weir-drown-2']) {
      for (const siteId of WEIRS) {
        for (let floor = 1; floor <= floorsOfSite(siteId); floor += 1) {
          const { realm, effects, bodies } = open(siteId, seed, floor, THREE_STRONG);
          const level = realm.world.level;
          const dalt = realm.world.addPlayer('p1', 'Dalt', { maxHp: 1_000_000 });
          dalt.noBreath = true;
          realm.engine.join('p1');
          const start = new Map(bodies.map((b) => [b.id, `${String(b.x)},${String(b.y)}`]));

          for (let turn = 0; turn < 200; turn += 1) {
            const nearest = bodies
              .filter((b) => b.alive)
              .sort(
                (a, b) =>
                  Math.max(Math.abs(a.x - dalt.x), Math.abs(a.y - dalt.y)) -
                  Math.max(Math.abs(b.x - dalt.x), Math.abs(b.y - dalt.y)),
              )[0];
            const route =
              nearest === undefined
                ? null
                : findPath(dalt, nearest, (x, y) => canRoute(level, x, y), { maxNodes: 20_000 });
            const next = route?.[0];
            const dir = next === undefined ? null : dirToward(dalt, next);
            if (dir === null) realm.engine.hold('p1');
            else realm.engine.submitMove('p1', dir);
            if (realm.engine.pump().refusals.length > 0) {
              realm.engine.hold('p1');
              realm.engine.pump();
            }
            dalt.hp = dalt.maxHp;
            for (const body of bodies) {
              const at = `${seed} ${siteId} floor ${String(floor)} turn ${String(turn)}: ${body.name}`;
              expect(body.maxAir, at).toBe(MAX_AIR);
              expect(body.air, `${at} lost air`).toBeGreaterThanOrEqual(body.maxAir);
              // The bubble's gift and its flag, together or not at all.
              expect(body.isSuffocating, `${at} air ${String(body.air)}`).toBe(
                body.air > body.maxAir,
              );
              if (body.isSuffocating) bubbled += 1;
              expect(hasEffect(effects, body.id, EffectId.Suffocating), at).toBe(false);
            }
          }
          for (const body of bodies) {
            if (start.get(body.id) !== `${String(body.x)},${String(body.y)}`) moved += 1;
          }
        }
      }
    }
    // A run in which nothing moved would pass the loop above by standing still.
    expect(moved, 'no body moved in 3,200 turns: the AI never ran').toBeGreaterThan(0);
    // And one in which nothing touched a bubble never asked the flag anything.
    expect(bubbled, 'no body stood on a bubble: the air rule was never exercised').toBeGreaterThan(
      0,
    );
  });
});
