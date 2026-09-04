// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rules under test are ported from t-engine4 game/modules/tome/class/Actor.lua:6951-6978.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { IMMUNITY_KEYS, MAX_ITEM_IMMUNITY } from '../../src/shared/immunity.ts';
import { EffectStatus, canBe } from '../../src/server/engine/effects.ts';
import {
  BLEEDING,
  MVP_EFFECTS,
  STUNNED,
  createMvpEffectState,
} from '../../src/server/content/effects.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { AiProfile, createMonsterActor } from '../../src/server/engine/actor.ts';
import { EGOS, egoWielder } from '../../src/server/content/egos.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import { inspectActor } from '../../src/server/view/inspect.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ITEMS } from '../../src/server/content/items.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { rollLoot } from '../../src/server/content/loot.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { Item } from '../../src/server/content/items.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FINISHED IMMUNITY ENGINE THAT NO CONTENT COULD REACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `canBe` has had the blanket check, the multiplicative subtype product and the
 * no-draw short-circuit since M4, ported line by line and tested against the
 * Lua. Its only source of numbers was `grantImmunity`, and the only callers of
 * that outside the engine were four lines in `effects.test.ts`.
 *
 * So being Stunned — three of your talents locked out, which `content/effects.ts`
 * calls *"the entire reason Stun is the most feared status in ToME"* — was
 * something the game did to you and no item, ego, class or talent could answer.
 * Half of ToME's gearing decision is "what is about to disable me, and what do I
 * put on to stop it", and that half did not exist here.
 *
 * These tests are about the CHANNEL. The engine's own arithmetic is
 * `effects.test.ts` § 4 and is unchanged by any of this.
 */

const wielder = (over: NonNullable<Item['wielder']>): Item['wielder'] => over;
const bare: CombatSheet = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };

function husk(sheet?: CombatSheet) {
  const actor = createMonsterActor('m1', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 5,
    profile: AiProfile.MeleeChaser,
  });
  if (sheet !== undefined) actor.combat = sheet;
  return actor;
}

describe('every buildable key is a key that resists something', () => {
  it('names only subtypes an authored DETRIMENTAL effect actually carries', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CHECK THAT STOPS THIS BECOMING A ROW NOTHING READS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `IMMUNITY_KEYS` is a hand-written list and `EffectDef.subtypes` is another
     * one; nothing but this test makes them agree. A key matching no effect
     * would validate, fold, price into an ego's cost and print on the character
     * sheet as a defence — against nothing at all. That is the exact failure
     * shape this project keeps finding, and it is cheap to close.
     */
    const authored = new Set<string>();
    for (const def of MVP_EFFECTS) {
      if (def.status !== EffectStatus.Detrimental) continue;
      for (const subtype of def.subtypes) authored.add(subtype);
    }
    for (const key of IMMUNITY_KEYS) {
      expect(authored, `'${key}' is buildable and resists nothing`).toContain(key);
    }
  });

  it('excludes the four blanket keys, which are truth-tested and not scaled', () => {
    // A 5% roll on one of these would be TOTAL immunity to every detrimental
    // effect in the game — `canBe` mirrors Actor.lua:6956-6960's `if attr(...)`
    // with `> 0`. See the note in shared/immunity.ts.
    for (const key of IMMUNITY_KEYS) expect(key).not.toContain('_immune');
  });
});

describe('worn immunity reaches the sheet', () => {
  it('folds a single wielder block onto the composed sheet', () => {
    const sheet = composeWielders(bare, [wielder({ immunities: { stun: 20 } })]);
    expect(sheet.immunities?.stun).toBe(20);
  });

  it('ADDS across two items, because upstream keeps one attr per key', () => {
    // `addTemporaryValue` on `stun_immune` is a plain add: two rings at 15% are
    // 30%. The MULTIPLICATIVE composition lives one level up, in `canBe`,
    // between the SUBTYPES of one effect — never between two items.
    const sheet = composeWielders(bare, [
      wielder({ immunities: { stun: 15 } }),
      wielder({ immunities: { stun: 15 } }),
    ]);
    expect(sheet.immunities?.stun).toBe(30);
  });

  it('CLAMPS at 100 where it is composed, so the sheet and the die agree', () => {
    // The other three tables are left unbounded because their readers clamp.
    // This one is bounded here as well: a sheet reading 140% is a number the
    // character panel would print and the player could not act on.
    const sheet = composeWielders(
      bare,
      Array.from({ length: 5 }, () => wielder({ immunities: { stun: 25 } })),
    );
    expect(sheet.immunities?.stun).toBe(100);
  });

  it('DISAPPEARS when the item comes off — the property grantImmunity lacks', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHY THIS RIDES THE SHEET AND NOT `EffectState`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `grantImmunity` SETS a key. That is right for a timed effect, which owns
     * its grant and drops it on expiry, and unusable for gear: two rings would
     * not stack and taking one off could not be undone without the
     * `addTemporaryValue` ledger this codebase deliberately does not have.
     * Recomposition from a bare base is what makes removal free.
     */
    expect(composeWielders(bare, [wielder({ immunities: { stun: 20 } })]).immunities?.stun).toBe(
      20,
    );
    expect(composeWielders(bare, []).immunities).toBeUndefined();
  });

  it("leaves the caller's sheet alone — one class sheet is shared by every body", () => {
    // The contamination `equipment.ts` exists to prevent: one frozen class sheet
    // is shared by every actor of that class, so a write would hand the whole
    // roster somebody else's ring.
    const base: CombatSheet = { ...bare, immunities: Object.freeze({ stun: 5 }) };
    const sheet = composeWielders(base, [wielder({ immunities: { stun: 20 } })]);
    expect(sheet.immunities?.stun).toBe(25);
    expect(base.immunities?.stun).toBe(5);
  });
});

describe('the sheet reaches canBe — the wiring every fold test above passes without', () => {
  it('refuses a Stun outright at 100%, WITH NO DRAW', () => {
    /**
     * The test this whole change exists for. Every assertion above would pass
     * with `canBe` still reading `state.immunities` alone and ignoring the
     * sheet — a number folded, displayed, priced, and never consulted by the
     * die. Delete the `actor.combat?.immunities` term in `immunityAgainst` and
     * ONLY this block and the two below it fail.
     *
     * No draw, because Actor.lua:6969 refuses before rolling.
     */
    const sheet = composeWielders(
      bare,
      Array.from({ length: 4 }, () => wielder({ immunities: { stun: 25 } })),
    );
    const rng = scriptedRng([]); // any draw at all would throw
    expect(canBe(createMvpEffectState(), husk(sheet), STUNNED, rng).can).toBe(false);
    expect(drawCount(rng)).toBe(0);
  });

  it('shifts the CHANCE by exactly what is worn', () => {
    const sheet = composeWielders(bare, [wielder({ immunities: { stun: 20 } })]);
    const result = canBe(createMvpEffectState(), husk(sheet), STUNNED, scriptedRng([80]));
    expect(result.chance).toBe(80);
    expect(result.can).toBe(true);
    // 81 misses the window, which is what makes the 20 a real 20.
    expect(canBe(createMvpEffectState(), husk(sheet), STUNNED, scriptedRng([81])).can).toBe(false);
  });

  it('composes worn subtypes MULTIPLICATIVELY, exactly as granted ones do', () => {
    // BLEEDING carries { wound, cut, bleed } — physical.lua:128. Two worn
    // fractions leave their product, not their sum.
    const sheet = composeWielders(bare, [wielder({ immunities: { wound: 25, bleed: 20 } })]);
    const result = canBe(createMvpEffectState(), husk(sheet), BLEEDING, scriptedRng([60]));
    expect(result.chance).toBe(60); // 100 × 0.75 × 0.80
  });

  it('a bare body is affected exactly as it always was', () => {
    // The regression that matters most: no `immunities` key means no behaviour
    // change and no draw, byte for byte what every pre-M5 fixture expects.
    const rng = scriptedRng([]);
    expect(canBe(createMvpEffectState(), husk(), STUNNED, rng).can).toBe(true);
    expect(drawCount(rng)).toBe(0);
  });
});

describe('content cannot author a number that deletes a status', () => {
  it('resolves every immunity ego within the cap at every power and tier', () => {
    const carriers = EGOS.filter((ego) => ego.grants.immunities !== undefined);
    expect(carriers.length).toBeGreaterThanOrEqual(2);
    for (const ego of carriers) {
      for (const tier of ['common', 'uncommon', 'rare'] as const) {
        for (let power = 0; power <= 3; power += 1) {
          const granted = egoWielder(ego, power, tier).immunities ?? {};
          for (const [key, value] of Object.entries(granted)) {
            expect(value, `${ego.code} ${key} at power ${String(power)} / ${tier}`).toBeGreaterThan(
              0,
            );
            expect(value).toBeLessThanOrEqual(MAX_ITEM_IMMUNITY);
          }
        }
      }
    }
  });

  it('and those egos actually FOLD — a resolved grant is a legal wielder block', () => {
    // `egoWielder` returning the right shape proves nothing on its own; the fold
    // has to read the key it writes. This is the same seam that let `moveMp` sit
    // in a wielder block for a whole commit while changing nothing.
    const ego = EGOS.find((e) => e.grants.immunities?.stun !== undefined);
    expect(ego, 'no ego grants stun immunity').toBeDefined();
    const granted = egoWielder(ego!, 3, 'rare');
    const sheet = composeWielders(bare, [granted]);
    expect(sheet.immunities?.stun).toBe(granted.immunities?.stun);
    expect(sheet.immunities?.stun).toBeGreaterThan(0);
  });
});

describe('and the player can SEE it, on both cards', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THIRD LEG. A CHANNEL AND AN ENGINE WITH NO READOUT IS STILL NOTHING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `pushResistRows`' own docblock states the rule this follows: *"A resistance
   * CHANNEL with no readout is invisible; a readout with no channel is
   * unactionable."* An immunity is worse than a resistance on that score — a
   * resist at least changes a number the player watches go down, while an
   * immunity that is never displayed looks exactly like good luck.
   */
  function staged(immunities: Record<string, number>) {
    const world = createWorld('immunity-readout');
    const viewer = world.addPlayer('p1', 'Dalt');
    const target = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 2,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });
    target.combat = composeWielders(target.combat ?? bare, [wielder({ immunities })]);
    return { world, viewer, target };
  }

  it('prints what a HOSTILE refuses — "should I spend my one Stun on this"', () => {
    const { world, viewer, target } = staged({ stun: 20 });
    const rows = inspectActor(world, viewer, target)?.rows ?? [];
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Stun immunity', value: '20%' }));
  });

  it('prints what YOU refuse, on your own sheet', () => {
    const world = createWorld('immunity-self');
    const viewer = world.addPlayer('p1', 'Dalt');
    viewer.combat = composeWielders(viewer.combat ?? bare, [wielder({ immunities: { cut: 15 } })]);
    const rows = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Cut immunity', value: '15%' }));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE VISION ROW READS THE CHANNEL, not a constant that happens to match.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Vision range` is asserted as `10` on the reduced sheet in
   * `inspect.test.ts`, which pins the MODULE's default against the engine's
   * twenty — a distinction this game got wrong for three commits. But ten is
   * also what `sightRadiusOf` returns for a body it never looked at, so that
   * assertion passes against a row wired to nothing. MEASURED: replacing the
   * argument with `{}` leaves the whole of `inspect.test.ts` green.
   *
   * This is the half that can only be seen with a body that actually differs.
   * `overseer_of_nations.ts` grants exactly this one tile in shipped content, so
   * the fixture is the real case rather than an invented one.
   */
  it('shows a wider vision range for a body that has one', () => {
    const world = createWorld('vision-readout');
    const viewer = world.addPlayer('p1', 'Dalt');
    const before = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(before).toContainEqual(expect.objectContaining({ label: 'Vision range', value: '10' }));

    viewer.combat = {
      ...(viewer.combat ?? bare),
      mods: { ...(viewer.combat?.mods ?? {}), sight: 1 },
    };
    const after = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(after, 'the row is wired to a constant, not to `CombatMods.sight`').toContainEqual(
      expect.objectContaining({ label: 'Vision range', value: '11' }),
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MUCH OF THAT STRENGTH IS YOURS — `CharacterSheet.lua:798`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream heads the block "Stats:        Base/Current" and prints `%3d / %d`
   * (:810). Ours printed the composed figure alone, so a player could not tell
   * what came off with the coat and unequipping was a guess.
   *
   * ═══ THE PAIR ONLY APPEARS WHEN THE TWO DIFFER ═══
   * Every fixture on the reduced sheet in `inspect.test.ts` wears nothing, so
   * bought and composed are equal there and that file asserts a bare `24` — it
   * cannot see this branch at all. This one pulls them apart.
   */
  it('brackets what a body bought when gear has moved the number', () => {
    const world = createWorld('stat-split');
    const viewer = world.addPlayer('p1', 'Dalt');

    const bare = inspectActor(world, viewer, viewer)?.rows ?? [];
    const strengthOf = (rows: readonly { label?: unknown; value?: unknown }[]): string =>
      String(rows.find((row) => row['label'] === 'Strength')?.['value']);
    expect(strengthOf(bare), 'an ungeared body shows one figure').toMatch(/^\d+$/);

    // THE BOUGHT SHEET IS `baseCombat`; the composed one is `combat`. Moving
    // only the second is exactly what wearing a coat does.
    viewer.baseCombat = { ...(viewer.combat ?? {}) };
    viewer.combat = {
      ...(viewer.combat ?? {}),
      stats: { ...(viewer.combat?.stats ?? {}), str: (viewer.combat?.stats?.str ?? 10) + 6 },
    };

    const geared = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(strengthOf(geared), 'the sheet cannot say how much of the stat is gear').toMatch(
      /^\d+ \(\d+\)$/,
    );
  });

  it('says nothing at all when there is nothing to say', () => {
    // Seven rows of 0% on every husk in the game is how a card stops being read.
    const { world, viewer, target } = staged({ stun: 0 });
    const rows = inspectActor(world, viewer, target)?.rows ?? [];
    expect(rows.filter((r) => r.label.endsWith('immunity'))).toEqual([]);
  });

  it('orders rows by IMMUNITY_KEYS, not by what happens to be worn', () => {
    /**
     * `composeWielders` builds the table by spreading the base and writing
     * whatever the gear names, so its key order is a function of the player's
     * loadout. A card whose rows reshuffle when you swap a ring is a card
     * nobody can read at a glance — so the two loadouts below, which produce
     * the same table by different routes, must print the same way.
     */
    const world = createWorld('immunity-order');
    const viewer = world.addPlayer('p1', 'Dalt');
    const labels = (blocks: readonly ReturnType<typeof wielder>[]) => {
      viewer.combat = composeWielders(bare, blocks);
      return (inspectActor(world, viewer, viewer)?.rows ?? [])
        .filter((r) => r.label.endsWith('immunity'))
        .map((r) => r.label);
    };
    const forwards = labels([
      wielder({ immunities: { stun: 10 } }),
      wielder({ immunities: { cut: 10 } }),
    ]);
    const backwards = labels([
      wielder({ immunities: { cut: 10 } }),
      wielder({ immunities: { stun: 10 } }),
    ]);
    expect(forwards).toEqual(['Stun immunity', 'Cut immunity']);
    expect(backwards).toEqual(forwards);
  });
});

describe('a player can actually FIND one', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TEST THAT CAUGHT THE BUG THE OTHER SEVENTEEN MISSED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every layer was correct and connected — the ego roster, `egoWielder`, the
   * fold, `canBe`, both readouts — and the channel still reached nobody.
   * `resolveItem` merges an ego's wielder block into the base FIELD BY FIELD,
   * and it did not know `immunities` existed. So `Shockproof ` and ` of Whole
   * Cloth` dropped as real loot 532 times in a 5,938-item sample and every one
   * resolved to an item granting nothing.
   *
   * A unit test of any single layer passes in that world. The only thing that
   * fails is the question a player asks: if I play, will I find one, and will it
   * work? So that is the question this asks — over every base item in the game,
   * through the real roller and the real resolver.
   */
  it('rolls immunity onto real loot, through the real roller and resolver', () => {
    const seen = new Map<string, number>();
    let carrying = 0;
    let egoItems = 0;
    for (const base of ITEMS.filter((item) => item.slot !== undefined)) {
      for (let i = 0; i < 120; i += 1) {
        const id = rollLoot(createRng(`${base.id}${String(i)}`), base.id, 20);
        if (!id.includes('~')) continue;
        egoItems += 1;
        const granted = resolveItem(id)?.wielder?.immunities;
        if (granted === undefined) continue;
        for (const [key, value] of Object.entries(granted)) {
          carrying += 1;
          seen.set(key, Math.max(seen.get(key) ?? 0, value));
        }
      }
    }
    expect(
      egoItems,
      'the roller produced no ego items at all — the probe is broken',
    ).toBeGreaterThan(200);
    expect(
      carrying,
      'egos roll but resolve to nothing — see resolve.ts#immunities',
    ).toBeGreaterThan(0);
    /**
     * All THREE authored subtypes are reachable, and none exceeds what one slot
     * may carry. `5 + 2 × 3 × 3 = 23` is the ego cap arithmetic.
     *
     * `confusion` is the newest and this line is the reason it is trusted:
     * adding a `Wielder` channel is a SIX-place checklist, and the place that
     * has been missed before is `content/resolve.ts`'s field-by-field ego merge
     * — the immunity channel rolled 532 times in a 5,938-item sample and every
     * one resolved to nothing, with five of six layers correct. This test rolls
     * real loot through the real roller and the real resolver, so a channel that
     * reaches no player fails here rather than in play.
     */
    expect([...seen.keys()].sort()).toEqual(['confusion', 'cut', 'stun']);
    for (const [key, value] of seen) {
      expect(value, `${key} resolved above the cap`).toBeLessThanOrEqual(MAX_ITEM_IMMUNITY);
    }
  });

  it('and what it finds survives being worn — roller to resolver to canBe', () => {
    // The end of the chain. Not "the field is present" but "the die changed".
    const found = ITEMS.filter((item) => item.slot !== undefined)
      .flatMap((base) =>
        Array.from({ length: 120 }, (_unused, i) =>
          rollLoot(createRng(`${base.id}${String(i)}`), base.id, 20),
        ),
      )
      .map((id) => resolveItem(id))
      .find((item) => item?.wielder?.immunities?.stun !== undefined);
    // A THROW RATHER THAN AN `expect`, because everything below needs the value
    // narrowed and a chain of `!` reads as though the absence were impossible.
    // It is not impossible — it is the exact bug this file was written for.
    if (found?.wielder?.immunities?.stun === undefined) {
      throw new Error('no rolled item grants stun immunity — the channel reaches no player');
    }

    const granted = found.wielder.immunities.stun;
    const sheet = composeWielders(bare, [found.wielder]);
    expect(sheet.immunities?.stun).toBe(granted);
    const result = canBe(
      createMvpEffectState(),
      husk(sheet),
      STUNNED,
      scriptedRng([100 - granted]),
    );
    expect(result.chance).toBe(100 - granted);
  });
});
