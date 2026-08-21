// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HOTBAR_TALENT_SLOTS } from '../../src/client/ui/hotbar.ts';

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
    expect(view).toContain('talentBindings.map(');
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
    expect(fn).toContain('from !== index');
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
    // One number, taken from the module that owns it — a second copy would
    // drift the day the bar grows a page.
    expect(MAIN).toContain('{ length: HOTBAR_TALENT_SLOTS }');
    expect(HOTBAR_TALENT_SLOTS).toBeGreaterThan(0);
  });
});
