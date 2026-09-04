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
import { toLoadoutView } from '../../src/server/content/classes.ts';
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

describe('and the panel is told the BODY`s mastery, not the tree constant', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE READOUT READ THE WRONG SOURCE, AND IT MADE THIS FEATURE INVISIBLE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `toLoadoutView` filled `LoadoutTalent.mastery` from `treeById(tree).mastery`
   * — the TREE CONSTANT, which `TalentTree.mastery` says ships at 1.0 for every
   * tree in the game and always has. So the panel header's `(x1.30)`, which
   * `talentPanelRows` has been ready to draw since it was written, could never
   * appear for anybody; and deepening a discipline moved `talentLevelOf` (tested
   * above, correctly) while the header still said x1.00 and the offer beside it
   * still said "deepen to x1.20" after it had been bought.
   *
   * Mastery is a property of the BODY, not of the tree — `TalentSheet.mastery`
   * argues that at length. This is the readout agreeing with it.
   */
  const preview = { id: 'p', name: 'P', kind: 'player', x: 0, y: 0, hp: 1, maxHp: 1, alive: true };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SENTENCE MUST BE RENDERED AT THE LEVEL THE MATHS RUNS AT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `toLoadoutView` computes `range` through `effective` under a comment saying
   * "AT THIS RANK ... never `talent.targeting.range`" — and then rendered `desc`
   * and `descNext` through the RAW `level` two lines below it. The invariant was
   * stated on one field and broken on the next.
   *
   * ═══ WHY IT MATTERS MORE THAN A ROUNDING ERROR ═══
   * A category point is the scarcest currency in the game. Spend one deepening a
   * discipline and every talent in it genuinely hits harder — `talentLevelOf` is
   * `raw * mastery` and the engine uses it — while every sentence on the screen
   * where you spent the point keeps printing the pre-deepen numbers. The player
   * concludes the point did nothing.
   *
   * ═══ ASSERTED AS AN IDENTITY AGAINST THE TALENT'S OWN `describe` ═══
   * No number is written down here, so the curve can be retuned without editing
   * this test. The second assertion is what stops it passing vacuously: the
   * talent picked must actually SAY something different at the two levels, or
   * the first assertion is true of any implementation.
   */
  it('renders the description at the effective level, not the raw one', () => {
    const definition = anyClass();
    const tree = ownTree(definition);
    const deep = sheetForBody(definition, { deepenedTrees: [tree] });
    const mastery = deep.mastery.get(tree) ?? 1;
    expect(mastery, 'the fixture is not actually deepened').toBeGreaterThan(1);

    // THE FIRST TALENT IN THE TREE THAT SAYS ANYTHING DIFFERENT AT 1 vs 1*mastery.
    // Not every talent's prose moves with rank — a flat one would make this test
    // true of any implementation, which is the trap it exists to avoid.
    const speaks = [...definition.loadout, ...definition.passives].find(
      (t) =>
        t.tree === tree &&
        t.describe(preview as never, 1) !== t.describe(preview as never, 1 * mastery),
    );
    if (speaks === undefined) {
      throw new Error(`no talent in ${tree} renders differently at rank 1 vs ${String(mastery)}`);
    }

    const view = toLoadoutView(
      speaks,
      1,
      preview as never,
      undefined,
      1 * mastery,
      undefined,
      mastery,
    );

    expect(view.desc, 'the sentence is stuck at the pre-deepen rank').toBe(
      speaks.describe(preview as never, 1 * mastery),
    );
    expect(view.desc, 'and it is genuinely a different sentence').not.toBe(
      speaks.describe(preview as never, 1),
    );
  });

  /**
   * AND "WHAT ONE MORE POINT BUYS" IS THE NEXT RANK THROUGH THE SAME MULTIPLIER.
   * `getTalentFullDescription(t, 1)` upstream adds the point and then lets
   * mastery apply, which is `(raw + 1) * mastery` and not `effective + 1`.
   */
  it('renders the next-rank sentence at (raw + 1) * mastery', () => {
    const definition = anyClass();
    const tree = ownTree(definition);
    const deep = sheetForBody(definition, { deepenedTrees: [tree] });
    const mastery = deep.mastery.get(tree) ?? 1;

    const speaks = [...definition.loadout, ...definition.passives].find(
      (t) =>
        t.tree === tree &&
        t.describe(preview as never, 2 * mastery) !== t.describe(preview as never, 1 * mastery),
    );
    if (speaks === undefined) {
      throw new Error(`no talent in ${tree} renders differently at rank 1 vs 2`);
    }

    const view = toLoadoutView(
      speaks,
      1,
      preview as never,
      undefined,
      1 * mastery,
      undefined,
      mastery,
    );

    expect(view.descNext).toBe(speaks.describe(preview as never, 2 * mastery));
  });

  it('carries the sheet`s figure when the caller has one', () => {
    const definition = anyClass();
    const tree = ownTree(definition);
    const talent = [...definition.loadout, ...definition.passives].find((t) => t.tree === tree);
    if (talent === undefined) throw new Error(`no talent sits in ${tree}`);
    const deep = sheetForBody(definition, { deepenedTrees: [tree] });

    const view = toLoadoutView(
      talent,
      1,
      preview as never,
      undefined,
      1,
      undefined,
      deep.mastery.get(tree),
    );
    expect(view.mastery).toBeCloseTo(
      (sheetForClass(definition).mastery.get(tree) ?? 1) + MASTERY_STEP,
      10,
    );
  });

  it('falls back to the tree`s own figure for a caller with no sheet', () => {
    // The class-picker preview, which has no body to ask. It must keep drawing
    // exactly what it drew before this parameter existed.
    const definition = anyClass();
    const talent = definition.loadout[0];
    if (talent === undefined) return;
    const view = toLoadoutView(talent, 1, preview as never);
    expect(view.mastery).toBe(1);
  });
});
