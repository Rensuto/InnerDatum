// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  HOTBAR_KEY_ROW,
  HOTBAR_KEY_ROWS,
  HOTBAR_SLOTS_DEFAULT,
  HOTBAR_SLOT_POOL,
  HOTBAR_ROW_KEYS,
  hotbarKeyLabel,
  hotbarSlotForKey,
} from '../../src/client/ui/hotbar.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE BAR STOPPED BEING `loadout[n]`, AND THAT UNBLOCKS THE CLASS TREES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A class may hold exactly six actives because `_loadoutArityCheck` says so,
 * and it says so because the bar was six FIXED slots. So no class could gain a
 * third discipline with a button in it — which is most of what stands between
 * this game and the one it is a port of.
 *
 * ═══ SOURCE-SHAPE, LIKE `hudwiring.test.ts` NEXT DOOR, AND FOR ITS REASONS ═══
 * `main.ts` is one module with no exports worth importing and a canvas at the
 * bottom of every code path. The properties below are facts about the WIRING —
 * which function is called from where, in what order — and the failure they
 * guard is a feature that silently stops being reachable. That is exactly what
 * that file already tests this way, and a second style beside it would be two
 * conventions for one job.
 */

const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/**
 * `MAIN` WITH EVERY COMMENT REMOVED.
 *
 * ═══ WHY AN ABSENCE MUST NEVER BE ASSERTED AGAINST THE RAW TEXT ═══
 * This codebase explains a change by QUOTING what it replaced — the house rule
 * that a comment which lies is worse than no comment. So the paragraph
 * explaining that `talentPage` is gone contains the string `talentPage`, and a
 * `not.toContain` against the raw file fails on the explanation rather than on
 * the code. Three of the cases below did exactly that on their first run.
 *
 * `toContain` assertions stay on the raw text where they are matching a line
 * this file quotes verbatim; only the ABSENCE checks need the stripped copy.
 */
const CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The body of a function with its comments removed. `body` + `CODE`'s rule. */
function code(open: string): string {
  return body(open)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * The body of a function, by its opening line — BRACE-MATCHED, not guessed.
 *
 * The first version of this looked for the next line that was `}` or `  }`,
 * which is the obvious cheap trick and is wrong in the one direction that
 * matters: it stops at the first nested block, so a function whose interesting
 * line is inside a `for` reads as if it does not contain it. Both of the
 * assertions below that failed on the first run failed for that reason and not
 * because the code was wrong — a test that lies about the source it is reading
 * is worse than no test.
 */
function body(open: string): string {
  const at = MAIN.indexOf(open);
  expect(at, `no such function: ${open}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let seen = false;
  for (let i = at; i < MAIN.length; i += 1) {
    const ch = MAIN[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return MAIN.slice(at, i + 1);
    }
  }
  return MAIN.slice(at);
}

describe('the bar is built from bindings, not from the loadout', () => {
  it('resolves each slot through the binding store', () => {
    const view = body('function hotbarView(): HotbarView {');
    // ONE RESOLVER, and `armed` is resolved against the same list — see the
    // assertion at the bottom of this file, which is the one that catches the
    // ring being drawn on the wrong box.
    expect(view).toContain('talentInSlot(');
    /**
     * `loadout.map(...)` INSIDE THIS FUNCTION is the old contract — slot n IS
     * loadout[n] — and it is the one thing that must not come back, because it
     * makes every binding in the store ornamental without failing anything else.
     *
     * The docblock above the replacement quotes the old expression to explain
     * what changed, so the check is against the function's CODE rather than its
     * whole text: stripping block comments is the difference between a guard
     * and a string search that trips over its own explanation.
     */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('loadout.map(');
  });

  it('presses what it painted, through the same resolver', () => {
    /**
     * THE HOLE THE TEST ABOVE COULD NOT SEE. It guarded `hotbarView` against
     * `loadout.map(` and passed for months while `activateSlot` — the function
     * a KEY actually reaches — read `loadout[index]`: authored order, no page
     * offset, no binding. Page 2 pressed page 1's talents, dragging moved only
     * the picture, and once the fill stopped seating unlearned talents a
     * level-1 Redactor had four keys that painted one thing and fired another.
     *
     * A guard on the paint is not a guard on the press. This is the press.
     */
    const press = body('function activateSlot(index: number): void {');
    expect(press).toContain('talentInSlot(index)');
    const code = press.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('loadout[index]');
  });

  it('draws an unresolvable binding as empty rather than stale', () => {
    /**
     * A class swap, a character load or a talent this build deleted leaves an id
     * that resolves to nothing. Drawing its remembered name is the same failure
     * as an item slot reading EQUIP for an item that is gone — a button that
     * cannot do what it says.
     */
    const view = body('function hotbarView(): HotbarView {');
    expect(view).toContain('HotbarSlotKind.Empty');
  });
});

describe('a loadout frame puts the bar in order without disturbing it', () => {
  it('reseats on every loadout frame', () => {
    // The frame is re-sent on every rank change, every learn, every class
    // choice and every restore. A bar that only seeded once would be empty for
    // anybody who arrived before their class did.
    expect(MAIN).toContain('reseatTalentBindings();');
  });

  it('reseats AFTER the assignment, never before', () => {
    /**
     * ═══ THE CLASS-SWAP BUG, PINNED ═══
     * `reseatTalentBindings` resolves ids against `loadout`. Called above the
     * assignment it would arrange the bar around the PREVIOUS class, and the
     * symptom is a bar keeping one talent from the character you stopped being.
     */
    const assign = MAIN.indexOf('loadout = msg.talents;');
    const reseat = MAIN.indexOf('reseatTalentBindings();');
    expect(assign).toBeGreaterThanOrEqual(0);
    expect(reseat).toBeGreaterThan(assign);
  });

  it('clears a dead binding before filling, so the slot is genuinely free', () => {
    const fn = body('function reseatTalentBindings(): readonly SeatedTalent[] {');
    expect(fn).toContain('known.has(');
    expect(fn).toContain('= null');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT NEVER SEATS SOMETHING THE CHARACTER HAS NOT LEARNED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `loadout` is the WHOLE class list, learned and unlearned alike, which is
   * correct — the talent panel reads the same array and needs the rank-0 rows to
   * sell them. The fill did not care: it walked that list in authored order and
   * handed out every free key.
   *
   * Measured over a socket before the fix: a level-1 Redactor holds eleven
   * talents and knows TWO, so six keys came back bound and four pointed at
   * abilities the character cannot use. Pressing one is refused `NotLearned` —
   * so a new player's bar taught them that half their keys are broken.
   *
   * ASSERTED ON THE RANK TEST rather than on behaviour, because main.ts cannot
   * be imported (it touches `document` at module scope) and this file's whole
   * device is reading the source. The guard is one line and its absence is the
   * bug, so its presence is the thing worth pinning.
   */
  it('never seats a talent the character has not learned', () => {
    const fn = body('function reseatTalentBindings(): readonly SeatedTalent[] {');
    expect(fn).toContain('level');
    expect(fn).toMatch(/<\s*1|>=\s*1|level\s*\?\?\s*0/);
  });

  it('never fills a talent that is already seated somewhere', () => {
    /**
     * A player may put the same talent on two keys by dragging — that is their
     * business. The FILL must not do it on its own: a duplicate that appeared
     * without being asked for reads as the bar being broken.
     */
    const fn = body('function reseatTalentBindings(): readonly SeatedTalent[] {');
    expect(fn).toContain('seated');
    expect(fn).toContain('continue');
  });
});

describe('binding a talent', () => {
  it('swaps rather than overwriting, so nothing is lost off the bar', () => {
    /**
     * Dragging key 1 onto key 3 must leave key 1 holding what key 3 had — not
     * empty. Overwriting would make every rearrangement a two-step chore and
     * would silently remove a talent the player never asked to remove.
     */
    const fn = body('function bindTalentSlot(index: number, talentId: string): void {');
    expect(fn).toContain('displaced');
    /**
     * AGAINST THE INDEX ITSELF, WHICH IS NOW THE CELL. This read
     * `from !== cell`, because with two pages the box under the pointer was
     * slot n of the page being drawn and the store was both pages end to end.
     * There is one coordinate space now (`cellOfSlot` is gone), so the swap
     * compares the store position to the store position.
     */
    expect(fn).toContain('from !== index');
    /**
     * ═══ AND IT IS WRITTEN BACK, WHICH IS WHAT `toContain('displaced')` MISSED ═══
     * Those two assertions are satisfied by a function that COMPUTES both
     * displaced occupants and writes neither — the local would still be named
     * `displacedTalent` and the comparison would still be `from !== index`,
     * and the button the player dragged off would simply be gone. That is
     * `membership-is-not-a-rank` in a test: it read the shape of the code and
     * not the act. The two writes are the act, and they are different for the
     * two kinds on purpose — a talent TRADES with where it came from, an item
     * is REHOMED to the first free slot, because a drop may not have come from
     * a slot at all (the bag and the talent panel are both sources).
     */
    expect(fn).toContain(
      'if (from >= 0 && from !== index) talentBindings[from] = displacedTalent;',
    );
    expect(fn).toContain(
      'const moved = displacedItem === null ? null : rehomeItem(displacedItem);',
    );
    // THE OTHER KIND KEEPS THE SAME PROMISE, or a player learns that dropping
    // an item on an occupied slot is safe and dropping a talent on one is not.
    const item = body('function bindItemSlot(index: number, subject: DragSubject): void {');
    expect(item).toContain(
      'if (from >= 0 && from !== index) hotbarBindings[from] = displacedItem;',
    );
    expect(item).toContain(
      'const moved = displacedTalent === null ? null : rehomeTalent(displacedTalent);',
    );
    // AND A REHOME ACTUALLY SEATS THE THING, in the slot the ported scan found
    // — not merely names one. `firstFreeSlot` is `PlayerHotkeys.lua:123-128`.
    expect(body('function rehomeTalent(talentId: string): string {')).toContain(
      'talentBindings[free] = talentId;',
    );
    expect(body('function rehomeItem(binding: ItemBinding): string {')).toContain(
      'hotbarBindings[free] = binding;',
    );
    // ...AND SAYS SO. A button that moved on its own without a sentence is the
    // report this file's notices exist to prevent.
    expect(fn).toContain('showNotice(');
  });

  it('refuses a talent that is not in the loadout, in words', () => {
    const fn = body('function bindTalentSlot(index: number, talentId: string): void {');
    expect(fn).toContain('showNotice(');
  });

  it('is reachable — the panel is a drag source', () => {
    // Without this the store, the view and the drop target all exist and no
    // talent can ever reach a slot: the "control that does nothing" trap, one
    // indirection deep.
    expect(MAIN).toContain('kind: DragKind.Talent, talentId:');
  });

  it('will not bind a talent nobody has learned', () => {
    // A slot that refuses every press is worse than an empty one. Rank 0 is an
    // ordinary state since birth grants landed.
    expect(MAIN).toContain('bindable.level >= 1');
  });
});

describe('clearing', () => {
  it('right-click clears whatever is on a slot, through ONE function', () => {
    // A bar where the same press means "clear" on four buttons and nothing on
    // nine is a bar with two rules in it. It was two functions keeping one
    // promise, split by `isItemSlotIndex`; one function cannot break it.
    expect(MAIN).toContain('clearSlot(rightSlot);');
    expect(CODE).not.toContain('unbindTalentSlot(');
    expect(CODE).not.toContain('unbindItemSlot(');
    const fn = body('function clearSlot(index: number): void {');
    expect(fn).toContain('vacateSlot(index);');
    // BOTH KINDS ARE TESTED before anything is said, so clearing an item slot
    // is silent on the wire and clearing a talent slot is not.
    expect(fn).toContain('hadTalent');
    expect(fn).toContain('hadItem');
    expect(fn).toContain('if (hadTalent) sendHotbar();');
  });
});

describe('the store', () => {
  it('is exactly as long as the bar can address, and so is the item store', () => {
    /**
     * ═══ "THE DAY THE BAR GROWS A PAGE" WAS THE NEXT COMMIT, TWICE ═══
     * This asserted `{ length: HOTBAR_TALENT_SLOTS }`, then
     * `{ length: HOTBAR_TALENT_BINDINGS }`. The property has not moved: the
     * store is as long as the bar can ADDRESS, and the number comes from the
     * module that owns it rather than being written down twice.
     *
     * BOTH STORES, AND THAT IS THE NEW HALF. `hotbarBindings` was four cells
     * read at `index - HOTBAR_TALENT_SLOTS`; the two are parallel now, and a
     * pair of arrays of different lengths indexed by one number is an
     * out-of-bounds read waiting for somebody to widen the bar.
     */
    expect(MAIN).toContain('Array.from({ length: HOTBAR_SLOT_POOL }, () => null)');
    expect(MAIN).toContain('{ length: HOTBAR_SLOT_POOL },');
    expect(HOTBAR_SLOT_POOL).toBe(HOTBAR_KEY_ROW * HOTBAR_KEY_ROWS);
    // THE DEFAULT IS INSIDE THE POOL. A bar that shipped wider than it can
    // address would put a box on screen with no key and no way to get one.
    expect(HOTBAR_SLOTS_DEFAULT).toBeLessThanOrEqual(HOTBAR_SLOT_POOL);
    expect(HOTBAR_SLOTS_DEFAULT).toBeGreaterThan(0);
  });
});

describe('one bar: every slot takes either kind, and every slot has a key', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS DESCRIBE WAS `the second page` AND EVERY CASE IN IT IS GONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It pinned three properties of a PAGED bar: that the page was a held mode
   * and never a toggle (`keyup` + `blur`), that `setTalentPage` redrew only on
   * a change, and that every index was resolved through `cellOfSlot`. All three
   * were correct and all three were defences of a bar that swapped its own
   * buttons under the player's hand.
   *
   * The author asked for the opposite bar: *"the hotbar/actionbar should not
   * segregate items from abilities. we need it it be 1 bar to rearange as
   * people like."* So Shift reaches the second nine SLOTS rather than the
   * second page of nine talents, and what has to be pinned is the mapping
   * between a key and a box — which is the same failure the page cases were
   * about, one layer down.
   */

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A SENTENCE ABOUT A SLOT NAMES THE KEY PRINTED ON IT, NOT ITS INDEX.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `slotWord` exists for this — `slot 3`, `slot ⇧4` — and every notice written
   * for the one-bar pass already used it. Three did not, and they were the
   * three that matter most: `activateSlot`'s own docblock says the refusal it
   * prints *"is the only thing that explains `⇧7` on a bar somebody has shrunk
   * to five slots"*, and the sentence it actually printed was **slot 16** — a
   * number belonging to an array the player has never seen, about a key that is
   * right there under their finger. The bar has eighteen boxes and nine digits,
   * so the index and the label agree for exactly half the bar and disagree,
   * silently, for the other half.
   *
   * ONE FUNCTION, WHICH IS WHY THIS IS AN ABSENCE. `slotWord` reads
   * `hotbarKeyLabel`, the same function the painter draws with, so a notice and
   * a box cannot disagree about what to call one square. A second `index + 1`
   * anywhere in either handler is that disagreement growing back.
   */
  it('names a slot by the key drawn on it, in every sentence about one', () => {
    for (const fn of [
      'function activateSlot(index: number): void {',
      'function pressItemSlot(index: number): void {',
    ]) {
      const arm = code(fn);
      expect(arm, `${fn} stopped naming slots by their key`).toContain('slotWord(index)');
      expect(arm, `${fn} named a slot by its index`).not.toContain('String(index + 1)');
    }
    // AND `slotWord` IS STILL THE LABEL AND NOT A SECOND COPY OF IT.
    expect(code('function slotWord(index: number): string {')).toContain('hotbarKeyLabel(index)');
  });

  it('has no page left anywhere in main.ts', () => {
    // A HALF-REMOVED MODE IS THE WORST OF BOTH. `talentPage` was read by the
    // draw, the hit test, the bind and the unbind; one surviving reader would
    // resolve through a variable nothing writes.
    expect(CODE).not.toContain('talentPage');
    expect(CODE).not.toContain('setTalentPage');
    expect(CODE).not.toContain('cellOfSlot');
  });

  it('maps a digit and a modifier to exactly one slot, both ways', () => {
    /**
     * THE PRINTED KEY AND THE SENT KEY ARE ONE FUNCTION READ TWICE.
     * `hotbarKeyLabel` is what the box wears; `hotbarSlotForKey` is what the
     * press resolves. A bar that printed `4` on the box that `⇧4` fires does
     * not look broken — it just casts the wrong thing, which is the single
     * worst failure a hotbar has.
     */
    for (let digit = 0; digit < HOTBAR_KEY_ROW; digit += 1) {
      const plain = hotbarSlotForKey(digit, false);
      const shifted = hotbarSlotForKey(digit, true);
      // `HOTBAR_ROW_KEYS`, NOT `digit + 1`: the row is upstream's twelve and
      // its tenth key says `0`. `hotbar.test.ts` spells the row out as the spec.
      expect(hotbarKeyLabel(plain)).toBe(HOTBAR_ROW_KEYS[digit]);
      expect(hotbarKeyLabel(shifted)).toBe(`⇧${String(HOTBAR_ROW_KEYS[digit])}`);
      expect(plain).not.toBe(shifted);
    }
    // EVERY SLOT IN THE POOL IS REACHABLE, and no two share a key.
    const reached = new Set<number>();
    for (let row = 0; row < HOTBAR_KEY_ROWS; row += 1) {
      for (let digit = 0; digit < HOTBAR_KEY_ROW; digit += 1) {
        reached.add(hotbarSlotForKey(digit, row === 1));
      }
    }
    expect(reached.size).toBe(HOTBAR_SLOT_POOL);
    // ...AND NOTHING PAST IT WEARS A LABEL, so a box can never advertise a key
    // that sends nothing.
    expect(hotbarKeyLabel(HOTBAR_SLOT_POOL)).toBeNull();
    expect(hotbarKeyLabel(-1)).toBeNull();
  });

  it('never leaves one index holding a talent AND an item', () => {
    /**
     * ═══ THE INVARIANT THE TWO PARALLEL STORES COST ═══
     * `hotbarView` reads the talent store first, so an index holding both draws
     * the talent and keeps the item invisible underneath. The player then
     * right-clicks, the talent goes, the item appears, and the bar looks like
     * it ignored a press. Every write goes through `vacateSlot`.
     */
    expect(body('function vacateSlot(index: number): void {')).toContain(
      'hotbarBindings[index] = null',
    );
    for (const fn of [
      'function bindTalentSlot(index: number, talentId: string): void {',
      'function bindItemSlot(index: number, subject: DragSubject): void {',
      'function clearSlot(index: number): void {',
    ]) {
      expect(body(fn), fn).toContain('vacateSlot(index);');
    }
  });

  it('auto-seats a newly learnt talent in the first free slot, testing BOTH stores', () => {
    /**
     * ═══ PORTED: `PlayerHotkeys.lua:123-128` / `:147-152` / `:207-215` ═══
     * Upstream scans `1 .. 12 * nb_hotkey_pages` for the first index where
     * `not self.hotkey[i]` — ONE table holding both kinds. Ours has two stores
     * for the one reason stated at `ItemBinding` (only one of them is on the
     * wire), so the port is that both are tested.
     *
     * `talentBindings.indexOf(null)` was the whole fill and it could not see an
     * item: a draught on slot 3 and a talent learned the next level would both
     * claim slot 3, the talent would win the draw, and the draught would be a
     * binding nobody could see or press.
     */
    const fill = body('function firstFreeSlot(): number {');
    expect(fill).toContain('talentBindings[i] == null && hotbarBindings[i] == null');
    /**
     * ═══ THE VISIBLE SLOTS FIRST, THEN THE REST OF THE POOL ═══
     * TWO loops, and the bounds are what makes them two. A single pass over the
     * pool survived a pin that only asked for `hotbarSlotCount()` to be
     * MENTIONED — the mutant kept the `const visible = …` line and walked the
     * whole pool anyway — so the bounds are named. `i < visible` then
     * `i = visible`: both, in that order.
     */
    expect(fill).toMatch(/i < visible;[\s\S]+let i = visible;[\s\S]+HOTBAR_SLOT_POOL/);
    expect(fill).toContain('const visible = hotbarSlotCount();');
    expect(body('function reseatTalentBindings(): readonly SeatedTalent[] {')).toContain(
      'firstFreeSlot()',
    );
    expect(code('function reseatTalentBindings(): readonly SeatedTalent[] {')).not.toContain(
      'talentBindings.indexOf(null)',
    );
  });

  it('says so when the fill seats a talent past the end of the bar', () => {
    /**
     * Upstream has this state and says nothing about it — its layout loop
     * simply stops (`HotkeysIconsDisplay.lua:270`). A silent button is the
     * "control that does nothing" this client refuses everywhere else, so the
     * fill reports what it seated off the bar and the `loadout` arm announces
     * it. The JOIN path deliberately does not: see its own comment.
     */
    const reseat = body('function reseatTalentBindings(): readonly SeatedTalent[] {');
    expect(reseat).toContain('if (free >= hotbarSlotCount()) offBar.push(');
    expect(MAIN).toContain('announceOffBar(reseatTalentBindings());');
    expect(body('function announceOffBar(seated: readonly SeatedTalent[]): void {')).toContain(
      'onRefusal(',
    );
  });

  it('picks a slot up as well as pressing it, which is what "rearrange" means', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BAR IS A DRAG SOURCE NOW, AND IT WAS ONLY EVER A DROP TARGET.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * *"1 bar to rearange as people like"*. A bar that can only be filled from
     * the talent panel and the bag is not one: moving key 1 to key 5 meant
     * finding the talent in the panel again. Upstream registers a drag zone for
     * EVERY slot, occupied or not (`HotkeysIconsDisplay.lua:167`, outside the
     * `if ts then` at :169) and takes a drop of either kind onto any slot at
     * :349; this is the pick-up half of the same thing.
     *
     * ═══ AND THE PRESS SURVIVES, WHICH IS THE HALF THAT COULD SILENTLY GO ═══
     * `beginDrag`'s fourth argument is what a SUB-THRESHOLD release means. A
     * `beginDrag` without it would turn every click on the bar into a gesture
     * that does nothing — the whole bar dead, with no error and no refusal, in
     * the one panel this client's header says a refusal must never be silent
     * in. So the ORDER and the CALLBACK are both pinned.
     */
    expect(CODE).toContain('beginDrag(carrying, point.x, point.y, () => activateSlot(slot));');
    // AN EMPTY SLOT STARTS NOTHING, and still presses.
    expect(CODE).toContain('if (carrying === null) activateSlot(slot);');
    const pick = body('function dragSubjectForSlot(index: number): DragSubject | null {');
    // A TALENT FIRST, because a slot holding one holds nothing else
    // (`vacateSlot`), and the talent store is what `hotbarView` reads first.
    expect(pick.indexOf('DragKind.Talent')).toBeLessThan(pick.indexOf('DragKind.Worn'));
    // WORN BEFORE CARRIED. `bindItemSlot` resolves a `Carried` subject against
    // the bag alone, so a coat on the doll picked up as `Carried` would be
    // refused with "that is not in your hands any more" about something plainly
    // being worn.
    expect(pick.indexOf('DragKind.Worn')).toBeLessThan(pick.indexOf('DragKind.Carried'));
    expect(pick).toContain('wornSlotOf(binding.itemId');
    // A GONE BINDING CARRIES NOTHING — there is nothing for the drop to resolve.
    expect(pick).toContain('held ? { kind: DragKind.Carried, itemId: binding.itemId } : null');
  });

  it('presses an ITEM off the same key a talent would use', () => {
    /**
     * THE WHOLE OF ITEM 8 IN ONE ASSERTION. `activateSlot` branched on
     * `isItemSlotIndex(index)` — the INDEX decided which half of the bar it
     * was in. It dispatches on the CONTENTS now, which is upstream's own shape:
     * `PlayerHotkeys.lua:161-162` calls `self["hotkey"..kind:capitalize()]`
     * off the kind stored IN the slot.
     */
    const press = body('function activateSlot(index: number): void {');
    expect(code('function activateSlot(index: number): void {')).not.toContain('isItemSlotIndex');
    expect(press).toContain('if (hotbarBindings[index] != null) {');
    expect(press).toContain('pressItemSlot(index);');
    // AND THE ITEM PRESS NO LONGER SUBTRACTS AN OFFSET from its index.
    expect(body('function pressItemSlot(index: number): void {')).toContain(
      'hotbarBindings[index]',
    );
    expect(code('function pressItemSlot(index: number): void {')).not.toContain(
      'HOTBAR_TALENT_SLOTS',
    );
  });
});

describe('the armed ring', () => {
  it('is resolved against the slots being drawn, never the loadout', () => {
    /**
     * ═══ THIS WAS WRONG FOR ONE COMMIT, AND IT DID NOT FAIL ANYTHING ═══
     * `armed` read `loadout.findIndex`, which was right for exactly as long as
     * slot n was loadout[n]. Once the bar took a binding the two were different
     * lists, and the ring was drawn on whichever box sat at the talent's
     * position in the LOADOUT — a different button the moment anybody
     * rearranged anything. A lit button that is not the one you pressed does
     * not fail; it quietly points at the wrong thing while an aim is open.
     */
    const view = body('function hotbarView(): HotbarView {');
    const code = view.replace(/\/\*[\s\S]*?\*\//g, '');
    /**
     * THE PROPERTY, NOT THE EXPRESSION. This pinned the literal
     * `page.indexOf(armedId)` and so failed the moment the paint and the press
     * were unified onto `talentInSlot` — a green-to-red on a change that made
     * the guarded property STRONGER, which is the tell that a test was holding
     * a copy of the implementation rather than its rule.
     *
     * The rule is: the ring is resolved against the slots being DRAWN.
     * `slots` is that list, built out of the same resolver the press uses, so
     * the ring and the button under it cannot disagree — and it is bounded by
     * the VISIBLE count, so a talent armed from a slot the player has since
     * shrunk off the bar rings nothing rather than ringing the wrong box.
     */
    expect(code).toMatch(/armed:[\s\S]{0,200}slots\.findIndex\(/);
    expect(code).not.toContain('loadout.findIndex(');
    expect(code).not.toContain('loadout.indexOf(');
  });
});
