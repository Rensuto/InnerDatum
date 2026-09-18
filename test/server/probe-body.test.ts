// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { BIRTH_KIT, ITEMS } from '../../src/server/content/items.ts';
import { parseItemId, resolveItem } from '../../src/server/content/resolve.ts';
import { liteRadiusOf } from '../../src/server/engine/derived.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { CLASSES } from '../../src/server/content/classes.ts';
import { createRng } from '../../src/shared/rng.ts';
import { Slot } from '../../src/shared/protocol.ts';
import { bearBirthKit, dressFor, growTo } from '../../tools/grown.mjs';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE PROBE'S BODY IS THE ONE THE SERVER WOULD HAVE BUILT — OR IT MEASURES
 *   NOTHING, AND IT HAS ALREADY MEASURED NOTHING ONCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/` is not in the TypeScript build and nothing in `test/` has ever
 * imported it. That is usually right — a probe asserts nothing and fails
 * nothing, and `npm run check` is the gate. It is wrong for exactly the two
 * functions below, and the reason is on the record:
 *
 *   `bearBirthKit` is a SECOND COPY of the gateway's `grantBirthKit`
 *   (`src/server/net/gateway.ts:7634`), and before it existed every delve
 *   number ever printed was taken on a body with no lantern. In the five unlit
 *   caves `visionOf` from the arrival tile saw ONE TILE — its own — so every
 *   ranged refusal past a neighbour came back `no_los` and the probe charged it
 *   to the class. Three reviews and two rewrites later, nothing anywhere would
 *   notice if the copy drifted back.
 *
 *   `dressFor` rolls the paper doll a probe body wears, and it drew the LITE
 *   slot uniformly across three lamps — so a level-2 body had a one-in-three
 *   chance of a Dwarven Lantern whose upstream `level_range` is {35, 50}. Every
 *   per-class reading above level 1 in a dark cave was taken on a lamp nobody at
 *   that level owns.
 *
 * Both faults are the same shape and it is this repository's recurring one: the
 * JOIN between two layers that are each correct. So the join is what is tested —
 * the probe's body against the catalogue the server builds from, not against a
 * copy of either.
 */
describe('a probe body is born wearing what the server gives a new character', () => {
  it('equips the birth kit, and the kit is the catalogue`s and not the probe`s', () => {
    /**
     * THE LIST IS `BIRTH_KIT` ITSELF. `grantBirthKit` walks it; so does
     * `bearBirthKit`. A probe that had its own idea of what a character starts
     * with would be measuring a character nobody is given, and the only way to
     * state that is to walk the same constant.
     */
    expect(BIRTH_KIT.length, 'the birth kit is empty').toBeGreaterThan(0);
    for (const cls of CLASSES) {
      const body: Record<string, unknown> = {
        id: `probe:${cls.id}`,
        combat: cls.combat,
        baseCombat: cls.combat,
        equipped: {},
      };
      bearBirthKit(body, createMvpEffectState());
      const worn = body['equipped'] as Partial<Record<string, string>>;
      for (const id of BIRTH_KIT) {
        const item = resolveItem(id);
        if (item?.slot === undefined) continue;
        expect(worn[item.slot], `${cls.id} was not given ${id}`).toBe(id);
      }
    }
  });

  it('can see exactly as far as a character the gateway has just dressed', () => {
    /**
     * ═══ THE NUMBER THAT DECIDES EVERYTHING, ASKED OF BOTH BODIES ═══
     * `liteRadiusOf` reads `combat.mods.lite`, and SIGHT SPENDS LIGHT — in an
     * unlit cave it is the whole of what a body can see. So the two paths are
     * built side by side and the one number is compared: the probe's
     * `bearBirthKit`, and `grantBirthKit`'s own two steps (equip the kit into a
     * free slot, then `recomposeCombat`) written out from the gateway.
     *
     * NOT A HARD-CODED 2. A test that asserted the brass lantern's radius would
     * pass on the day somebody changed the kit and left the probe behind, which
     * is precisely the failure being guarded.
     */
    const cls = CLASSES[0];
    if (cls === undefined) throw new Error('no classes');

    const probe: Record<string, unknown> = {
      id: 'probe',
      combat: cls.combat,
      baseCombat: cls.combat,
      equipped: {},
    };
    bearBirthKit(probe, createMvpEffectState());

    const born: Record<string, unknown> = {
      id: 'born',
      combat: cls.combat,
      baseCombat: cls.combat,
      equipped: {},
    };
    for (const id of BIRTH_KIT) {
      const item = resolveItem(id);
      if (item?.slot === undefined) continue;
      born['equipped'] = { ...(born['equipped'] as object), [item.slot]: id };
    }
    recomposeCombat(born as never, createMvpEffectState(), resolveItem);

    expect(liteRadiusOf(probe as never)).toBe(liteRadiusOf(born as never));
    expect(liteRadiusOf(probe as never), 'a probe body is blind').toBeGreaterThan(0);
  });

  it('never dresses a body in a lamp its level could not have found', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `level_range` ON THE LITE SLOT — the rule `Zone.lua:217-221` applies to a
     * body before it may be rolled, applied to the one item that decides sight.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * data/general/objects/lites.lua:30-70 — brass 1-20, alchemist's 20-35,
     * dwarven 35-50. Items here carry a `tier` rather than a range, so the probe
     * writes the three out; this is the case that stops that list drifting from
     * what a body at a level is allowed to be holding.
     *
     * DRIVEN, over every level the game reaches and enough seeds that a
     * one-in-three draw would show many times over.
     */
    const lamps = ITEMS.filter((item) => item.slot === Slot.Lite);
    expect(lamps.length, 'there is only one lamp, so this proves nothing').toBeGreaterThan(1);
    const radiusOf = (id: string): number => resolveItem(id)?.wielder?.mods?.lite ?? 0;
    const dimmest = lamps.reduce((a, b) => (radiusOf(a.id) <= radiusOf(b.id) ? a : b));
    const cls = CLASSES[0];
    if (cls === undefined) throw new Error('no classes');

    for (const level of [2, 5, 10, 15, 19]) {
      const seen = new Set<string>();
      for (let n = 0; n < 60; n += 1) {
        const body: Record<string, unknown> = { id: 'dressed', combat: cls.combat };
        growTo(body, cls, level);
        dressFor(body, level, createRng(`dress-lite:${String(level)}:${String(n)}`));
        const worn = (body['equipped'] as Partial<Record<string, string>>)[Slot.Lite];
        if (worn === undefined) continue;
        // THE BASE, NOT THE RESOLVED RADIUS. `rollLoot` folds an ego on top and
        // one of the lite suffixes grants light of its own — a brass lantern
        // reading 3 is a rolled ego, which is the game's own drop table doing
        // its job. What must not happen is a BASE the level cannot have.
        seen.add(parseItemId(worn)?.base ?? worn);
      }
      // Under 20 the only lamp upstream will give you is the brass one, which
      // is also the one every character is born wearing.
      expect([...seen], `a level-${String(level)} body found a better lamp`).toEqual([dimmest.id]);
    }
  });
});
