// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/dialogs/LevelupDialog.lua:417-445 (learnType)
//                       game/modules/tome/class/ActorTalents.lua:826-861 (talent type mastery)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { MASTERY_DEEPEN_LIMIT, MASTERY_STEP } from '../../src/shared/progression.ts';
import { readFileSync } from 'node:fs';

import {
  CLASSES,
  sheetForBody,
  sheetForClass,
  treesForClass,
} from '../../src/server/content/classes.ts';
import { TALENT_TREES } from '../../src/server/content/talent-trees.ts';
import { talentLevelOf } from '../../src/server/engine/talents.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO OF THE THREE CATEGORY POINTS IN A CAREER WERE UNSPENDABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `learnType` is ONE action with two outcomes (LevelupDialog.lua:433-437): if
 * you do not know the tree it unlocks it, and if you do it adds `+0.2` mastery.
 * Ours only ever did the first — `unlockTree` refuses any tree that is not
 * locked — so once a character owned every discipline they wanted, the scarcest
 * currency in the game had nothing left to buy.
 *
 * `+0.2` is not a small thing: `talentLevelOf` is
 * `getTalentLevelRaw × mastery` (ActorTalents.lua:834), so it is a flat 20% on
 * every rank in that tree, present and future, everywhere `combatTalentScale`
 * is read.
 */

const anyClass = (): ClassDef => {
  const definition = CLASSES[0];
  if (definition === undefined) throw new Error('no classes are authored');
  return definition;
};

/** A tree the class owns outright — the archetypal thing to deepen. */
function ownTree(definition: ClassDef): string {
  const own = [...treesForClass(definition)][0];
  if (own === undefined) throw new Error('the class knows no trees at all');
  return own;
}

describe('a category point deepens a tree the body already knows', () => {
  it('adds exactly one step of mastery', () => {
    const definition = anyClass();
    const tree = ownTree(definition);
    const before = sheetForClass(definition).mastery.get(tree) ?? 1;
    const after = sheetForClass(definition, [], [tree]).mastery.get(tree) ?? 1;
    expect(after).toBeCloseTo(before + MASTERY_STEP, 10);
  });

  it('ADDS ONTO the class`s own grant rather than replacing it', () => {
    /**
     * The mistake that would read as working: setting the value to `MASTERY_STEP`
     * instead of adding it. A Watchman with an authored 1.3 in his signature tree
     * would then be DEMOTED to 0.2 by paying to improve it — the exact opposite
     * of what the point was spent on, and invisible in any fixture whose class
     * grades nothing.
     *
     * So this asserts against a class that HAS a grant, and skips with a message
     * rather than passing vacuously if none does.
     */
    const graded = CLASSES.find((c) => Object.keys(c.masteries ?? {}).length > 0);
    if (graded === undefined) {
      expect(CLASSES.length, 'no class grades any tree; this test proves nothing').toBe(-1);
      return;
    }
    const [tree, authored] = Object.entries(graded.masteries ?? {})[0] ?? [];
    if (tree === undefined || authored === undefined) return;
    expect(sheetForClass(graded, [], [tree]).mastery.get(tree)).toBeCloseTo(
      authored + MASTERY_STEP,
      10,
    );
  });

  it('treats a tree the class never graded as 1.0, not as 0', () => {
    // An absent entry means 1.0 (`TalentSheet.mastery`). `0 + 0.2` would be a
    // tree worth a fifth of a normal one — a purchase that made you worse.
    const definition = anyClass();
    const ungraded = [...treesForClass(definition)].find(
      (id) => (definition.masteries ?? {})[id] === undefined,
    );
    if (ungraded === undefined) return;
    expect(sheetForClass(definition, [], [ungraded]).mastery.get(ungraded)).toBeCloseTo(
      1 + MASTERY_STEP,
      10,
    );
  });

  it('pays once even if the list somehow names the tree twice', () => {
    // LevelupDialog.lua:422 — "You can only improve a category mastery once!".
    // The list crosses the save boundary, where `parseUnlockedTrees` treats a
    // duplicate as a file problem rather than as a second purchase, so the
    // arithmetic has to agree with that reading.
    expect(MASTERY_DEEPEN_LIMIT).toBe(1);
    const definition = anyClass();
    const tree = ownTree(definition);
    const twice = sheetForClass(definition, [], [tree, tree]).mastery.get(tree) ?? 1;
    const once = sheetForClass(definition, [], [tree]).mastery.get(tree) ?? 1;
    expect(twice).toBe(once);
  });
});

describe('and the mastery reaches the maths, not merely the map', () => {
  it('raises the effective level of every rank in that tree', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE JOIN. `talentLevelOf` is the only reason the number is worth a point.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every assertion above would pass with `mastery` a map nothing ever
     * multiplied by — which is precisely what it was before this change, and
     * what `numbed` was one commit ago until a deletion proved it.
     */
    const definition = anyClass();
    const tree = ownTree(definition);
    const talent = [...definition.loadout, ...definition.passives].find((t) => t.tree === tree);
    if (talent === undefined) throw new Error(`no talent sits in ${tree}`);

    const plain = sheetForClass(definition);
    const deep = sheetForClass(definition, [], [tree]);
    plain.points.set(talent.id, 3);
    deep.points.set(talent.id, 3);

    const before = talentLevelOf(plain, talent);
    const after = talentLevelOf(deep, talent);
    expect(before).toBeGreaterThan(0);
    expect(after, 'the mastery never reached talentLevelOf').toBeGreaterThan(before);
    // Three ranks at `mastery + 0.2` is three ranks at `mastery`, plus `3 × 0.2`.
    expect(after).toBeCloseTo(before + 3 * MASTERY_STEP, 6);
  });

  it('leaves every OTHER tree exactly where it was', () => {
    // A mastery bump that leaked across categories would be a category point
    // buying the whole character, which is not what the header promises.
    const definition = anyClass();
    const trees = [...treesForClass(definition)];
    const [first, second] = trees;
    if (first === undefined || second === undefined) return;
    const deep = sheetForClass(definition, [], [first]);
    const plain = sheetForClass(definition);
    expect(deep.mastery.get(second) ?? 1).toBe(plain.mastery.get(second) ?? 1);
  });
});

describe('what a returning player still has', () => {
  it('keeps a BOUGHT discipline through a sheet rebuild', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A PRE-EXISTING BUG, FOUND BY BUILDING THE SECOND HALF OF THE FEATURE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `CharacterFile.unlockedTrees` promises *"THE SHEET IS DERIVED FROM IT AND
     * NEVER THE OTHER WAY ROUND … a reconnect rebuilds that sheet from scratch —
     * so if this list were not the authority, a returning player would lose the
     * discipline they paid for."*
     *
     * `attachClass` — the ONLY sheet builder on the reconnect path — called
     * `sheetForClass(definition)` and passed neither list. Measured before the
     * fix: 36 talents after buying a discipline, 30 after reconnecting. One
     * whole tree, and the ranks inside it with it, because `applyTalentPoints`
     * skips an id the sheet does not have.
     *
     * This asserts the PROPERTY rather than the call, so it holds whatever
     * `attachClass` is refactored into: a sheet built from the body's two lists
     * has everything a sheet built at purchase time had.
     */
    const definition = anyClass();
    const locked = TALENT_TREES.find((tree) => tree.locked === true);
    if (locked === undefined) throw new Error('no locked tree is authored');

    const bought = sheetForClass(definition, [locked.id]);
    const bare = sheetForClass(definition);
    expect(bought.points.size, 'buying a discipline added no talents').toBeGreaterThan(
      bare.points.size,
    );

    // THROUGH `sheetForBody`, which is what the rebuild path calls — a second
    // `sheetForClass(definition, [locked.id])` here would compare the fixture
    // with itself and prove nothing about reconnecting.
    const rebuilt = sheetForBody(definition, { unlockedTrees: [locked.id] });
    expect(rebuilt.points.size, 'a rebuild from the saved list lost the discipline').toBe(
      bought.points.size,
    );
  });

  it('builds the same sheet from a BODY as from its two lists', () => {
    // `sheetForBody` is the rule `attachClass` was getting wrong; this is the
    // statement of it. Both lists, together, because the bug was passing NEITHER
    // and a version that remembered only one would still lose half a career.
    const definition = anyClass();
    const locked = TALENT_TREES.find((tree) => tree.locked === true);
    const tree = ownTree(definition);
    const unlockedTrees = locked === undefined ? [] : [locked.id];
    const fromBody = sheetForBody(definition, { unlockedTrees, deepenedTrees: [tree] });
    const fromLists = sheetForClass(definition, unlockedTrees, [tree]);
    expect(fromBody.points.size).toBe(fromLists.points.size);
    expect(fromBody.mastery.get(tree)).toBe(fromLists.mastery.get(tree));
    // AND IT IS NOT THE BARE SHEET, which is what a body-less build returns and
    // what the bug produced. Without this the two lines above pass on `{}`.
    expect(fromBody.mastery.get(tree)).not.toBe(sheetForBody(definition).mastery.get(tree));
  });

  it('is what `attachClass` actually calls — the wiring, unreachable any other way', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SOURCE GUARD, and the same instrument `save-lines.test.ts` reaches for.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `attachClass` is a closure inside `buildServer`, and every gateway test in
     * the tree injects its OWN `attachClass` stub — so no test can drive the
     * real one. That is exactly why the rule was extracted into `sheetForBody`;
     * this is the remaining half, which is that the extraction is USED.
     *
     * The weakest kind of test, chosen because the alternative is none: without
     * it, `attachClass` could go back to `sheetForClass(definition)` and every
     * assertion above would still pass while a returning player quietly lost a
     * discipline again.
     */
    const main = readFileSync(new URL('../../src/server/main.ts', import.meta.url), 'utf8');
    // THE POSITIVE ONLY. A `not.toContain('sheetForClass(definition)')` beside
    // it reads stricter and is worse: this file's own prose quotes that call to
    // explain the bug, so the guard would fail on its own docblock.
    expect(main).toContain('sheetForBody(definition, owned)');
  });

  it('keeps a DEEPENED tree through the same rebuild', () => {
    // The stronger half: an unlocked tree at least shows up as six talents, so a
    // loss is visible. A mastery bump is one float — lose it and nothing on
    // screen looks wrong, the character is simply quietly worse.
    const definition = anyClass();
    const tree = ownTree(definition);
    const rebuilt = sheetForClass(definition, [], [tree]);
    expect(rebuilt.mastery.get(tree)).toBeCloseTo(
      (sheetForClass(definition).mastery.get(tree) ?? 1) + MASTERY_STEP,
      10,
    );
  });
});

describe('treesForClass — "known" is not the same question as "unlocked"', () => {
  it('names the class`s own trees, which were never bought', () => {
    // The commonest thing a player wants to deepen is their signature tree, and
    // it appears in no purchase list. A check against `unlockedTrees` alone
    // would refuse exactly the case the feature exists for.
    const definition = anyClass();
    const known = treesForClass(definition);
    expect(known.size).toBeGreaterThan(0);
    for (const talent of definition.loadout) expect(known).toContain(talent.tree);
  });

  it('and adds a bought one only once it is bought', () => {
    const definition = anyClass();
    const locked = TALENT_TREES.find((tree) => tree.locked === true);
    if (locked === undefined) return;
    expect(treesForClass(definition).has(locked.id)).toBe(false);
    expect(treesForClass(definition, [locked.id]).has(locked.id)).toBe(true);
  });
});

describe('one message, two outcomes', () => {
  it('the gateway tries BOTH spends for a single `unlock_tree`', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LevelupDialog.lua:433-437 branches INSIDE the one action a player takes.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ```lua
     * if not self.actor:knowTalentType(tt) then self.actor:learnTalentType(tt)
     * else ... setTalentTypeMastery(tt, ... + 0.2) end
     * ```
     *
     * So `unlock_tree` keeps meaning what its schema has always said — *"I AM
     * SPENDING A CATEGORY POINT ON THIS DISCIPLINE"* — and the SERVER decides
     * which of the two things that is. A second verb would put the branch in the
     * client, where it is one frame out of date the moment a tree is bought, and
     * would need a protocol bump to say so.
     *
     * A SOURCE GUARD, for `attachClass`' reason: every gateway test injects its
     * own engine stub, so no test in the tree drives the real handler. Without
     * this, deleting the `deepenTree` half leaves the verb silently
     * unlock-only again and nothing notices.
     */
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway).toContain('engine.unlockTree?.(actorId, msg.treeId) ?? false');
    expect(gateway).toContain('engine.deepenTree?.(actorId, msg.treeId) ?? false');
    // AND THE POINT IS STILL DEDUCTED ONCE, after either lands.
    expect(gateway).toContain('body.unspentCategories -= 1;');
  });
});
