// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  HOTBAR_TALENT_BINDINGS,
  HOTBAR_TALENT_PAGES,
  HOTBAR_TALENT_SLOTS,
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
    // A SLICE OF THE STORE, not the whole of it: the bar draws ONE page and the
    // store holds both. `page` is that slice, and it is what `armed` is
    // resolved against too — see the assertion two blocks down, which is the
    // one that catches the ring being drawn on the wrong box.
    expect(view).toContain('talentBindings.slice(');
    expect(view).toContain('page.map(');
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
    const fn = body('function reseatTalentBindings(): void {');
    expect(fn).toContain('known.has(');
    expect(fn).toContain('= null');
  });

  it('never fills a talent that is already seated somewhere', () => {
    /**
     * A player may put the same talent on two keys by dragging — that is their
     * business. The FILL must not do it on its own: a duplicate that appeared
     * without being asked for reads as the bar being broken.
     */
    const fn = body('function reseatTalentBindings(): void {');
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
     * AGAINST THE CELL, NOT THE VISIBLE INDEX. With two pages the box under the
     * pointer is slot n of the page being drawn, and the store is both pages end
     * to end — comparing a visible index to a store position would make page 2's
     * slot 0 look like page 1's, and the swap would fire against the wrong cell.
     */
    expect(fn).toContain('from !== cell');
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
  it('right-click clears a talent slot, the same gesture as an item slot', () => {
    // A bar where the same press means "clear" on four buttons and nothing on
    // six is a bar with two rules in it.
    expect(MAIN).toContain('unbindTalentSlot(rightSlot);');
  });
});

describe('the store', () => {
  it('is exactly as long as the keyed half of the bar', () => {
    /**
     * ═══ "THE DAY THE BAR GROWS A PAGE" WAS THE NEXT COMMIT ═══
     * This asserted `{ length: HOTBAR_TALENT_SLOTS }` under a comment predicting
     * exactly the change that broke it, which is a good sign about the comment
     * and a bad one about the assertion: a guard that names the CURRENT size
     * fails on a resize and says nothing about correctness.
     *
     * The property is that the store is as long as the bar can address —
     * pages times slots — and that both numbers come from the module that owns
     * them rather than being written down twice.
     */
    expect(MAIN).toContain('{ length: HOTBAR_TALENT_BINDINGS }');
    expect(HOTBAR_TALENT_BINDINGS).toBe(HOTBAR_TALENT_SLOTS * HOTBAR_TALENT_PAGES);
    expect(HOTBAR_TALENT_PAGES).toBeGreaterThan(1);
  });
});

describe('the second page', () => {
  it('is a held mode, never a toggle', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE FAILURE A PAGED BAR RELIABLY HAS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A toggled page is a state a player can be in without noticing: you press
     * 1 for your reliable attack four minutes later and get something else,
     * and nothing on screen ever told you. Held-Shift cannot do that — the
     * moment you stop asking for page 2 you are back on page 1, so the bar you
     * are looking at is always the bar your keys will press.
     *
     * The keyup and the blur are the two halves of "cannot get stuck":
     * alt-tabbing with Shift held is the ordinary way a modifier is never
     * released, and a bar frozen on page 2 is one where the player's reliable
     * attack has vanished with no way back.
     */
    expect(MAIN).toContain("window.addEventListener('keyup'");
    expect(MAIN).toContain("window.addEventListener('blur'");
    expect(MAIN).toContain('setTalentPage(0);');
  });

  it('redraws only on a change, so holding Shift is not a 60fps loop', () => {
    // `keydown` repeats while a modifier is held. This client is a dirty-flag
    // renderer and an unconditional requestDraw here would turn holding Shift
    // into a render loop — the same rule every hover in main.ts follows.
    const fn = body('function setTalentPage(page: number): void {');
    expect(fn).toContain('if (talentPage === page) return;');
  });

  it('resolves every slot index through one function', () => {
    /**
     * The pointer and the keyboard both name a box on the VISIBLE bar, and the
     * store is both pages end to end. Offsetting at each call site instead of
     * once is how a paged bar ends up with the mouse editing page 1 while the
     * keyboard presses page 2.
     */
    expect(MAIN).toContain('function cellOfSlot(index: number): number {');
    expect(body('function bindTalentSlot(index: number, talentId: string): void {')).toContain(
      'cellOfSlot(index)',
    );
    expect(body('function unbindTalentSlot(index: number): void {')).toContain('cellOfSlot(index)');
  });

  it('lights the armed ring against the page being drawn', () => {
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
    expect(view).toContain('page.indexOf(armedId)');
    expect(view.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('loadout.findIndex(');
  });
});
