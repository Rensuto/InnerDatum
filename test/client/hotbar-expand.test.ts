/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOTBAR_STYLE,
  HOTBAR_HEADER_H,
  HOTBAR_INSET,
  HOTBAR_KEY_ROW,
  HOTBAR_SLOTS_DEFAULT,
  HOTBAR_SLOT_POOL,
  HotbarDropKind,
  HotbarSlotKind,
  ItemSlotAction,
  drawHotbar,
  hotbarDropTargetAt,
  HOTBAR_ROW_KEYS,
  hotbarKeyLabel,
  hotbarPanelSize,
  hotbarSlotAt,
  hotbarSlotForKey,
  hotbarSlotsForSize,
  slotRect,
  stepHotbarStyle,
} from '../../src/client/ui/hotbar.ts';
import { TalentShape } from '../../src/shared/protocol.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { HotbarSlot, HotbarStyle, HotbarView } from '../../src/client/ui/hotbar.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR THAT CHANGES SIZE — items 8, 9 and 10, driven rather than scraped.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hotbar.test.ts` next door pins the bar's geometry and its state machine at
 * ONE count, and `talent-bindings.test.ts` reads main.ts's wiring as source.
 * Neither can reach the property this pass is actually about, which only exists
 * BETWEEN them and only at more than one size:
 *
 *   THE KEY PRINTED ON A BOX IS THE KEY THAT FIRES IT, AT EVERY SIZE THE BAR
 *   CAN BE. Two functions produce that — `hotbarKeyLabel` draws it,
 *   `hotbarSlotForKey` resolves the press — and `hotbar.test.ts` already walks
 *   them against each other. That is the halves. What is NOT covered is the
 *   JOIN: that the label the painter actually PUT DOWN, at the pixel it put it
 *   down at, belongs to the box it landed in. A painter that drew the label
 *   from a running counter instead of the slot index would pass every existing
 *   case in this suite and would mislabel every box on a wrapped bar.
 *
 * ═══ AND THE TWO WRITERS OF ONE NUMBER ═══
 * The cogwheel's `SLOTS` row and the grip both write `HotbarStyle.slots`. Two
 * routes to one value is the shape that produces a control which disagrees with
 * a gesture, so both are driven to the same counts here and compared — not
 * against a second copy of the arithmetic, but against each other and against
 * what the painter then draws.
 *
 * NO SOURCE IS SCRAPED IN THE FIRST THREE SECTIONS. The last one reads main.ts
 * for one property that has no other reachable form (nothing truncates the
 * binding stores when the bar shrinks), in the style the file beside it uses.
 *
 * vitest.config.ts has no jsdom; the `reference lib="dom"` on line 1 is what
 * lets a `CanvasRenderingContext2D` be named. Its cost is documented at
 * test/client/turnbar.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures — a bar with BOTH kinds in it, because that is the bar now
// ---------------------------------------------------------------------------

/**
 * A slot for every index, alternating kinds so no assertion below can be true
 * of a bar that still separated them.
 *
 * TWO-DIGIT COSTS, deliberately, for the reason hotbar.test.ts:180-186 gives:
 * the cost readout is a `fillText` in the same slot as the key, so a one-digit
 * cost would be indistinguishable from a key label in the recording.
 */
function mixedSlot(index: number): HotbarSlot {
  if (index % 3 === 0) {
    return {
      kind: HotbarSlotKind.Talent,
      talent: {
        id: `talent:t${String(index)}`,
        name: `Talent ${String(index)}`,
        icon: `icon_active_t${String(index)}`,
        cost: { ap: 10, mp: 0, resource: 0 },
        cooldownTurns: 4,
        range: 5,
        minRange: 0,
        shape: TalentShape.Tile,
        radius: 0,
        level: 1,
        maxLevel: 5,
        desc: '',
        descNext: null,
      },
      cooldown: 0,
      affordable: true,
    };
  }
  if (index % 3 === 1) {
    return {
      kind: HotbarSlotKind.Item,
      itemId: `item_i${String(index)}`,
      name: `Item ${String(index)}`,
      icon: `item_i${String(index)}`,
      action: ItemSlotAction.Equip,
    };
  }
  return { kind: HotbarSlotKind.Empty };
}

function viewOf(count: number, over: Partial<HotbarView> = {}): HotbarView {
  return {
    slots: Array.from({ length: count }, (_unused, i) => mixedSlot(i)),
    hovered: -1,
    armed: -1,
    ...over,
  };
}

/** One recorded `fillText`, with the pixel it was drawn at. */
type Text = { readonly text: string; readonly x: number; readonly y: number };

/**
 * A context that records WHERE text landed.
 *
 * hotbar.test.ts's recorder keeps the strings and throws the coordinates away,
 * which is right for "did it say EQUIP" and useless for "is that label on that
 * box". Only `fillText` is recorded, for that file's stated reason: the caption
 * and the cooldown digits are outlined first, so counting `strokeText` as well
 * would report every string twice.
 */
function recorder(texts: Text[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 6 });
        if (prop === 'fillText')
          return (text: string, x: number, y: number) => {
            texts.push({ text, x, y });
          };
        if (prop === 'canvas') return undefined;
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

/** No art at all: the ordinary state of a fresh clone, since assets/ is gitignored. */
const BARE: SpriteSource = { sprite: () => undefined };

function paint(view: HotbarView, rect: PanelRect, style: HotbarStyle = DEFAULT_HOTBAR_STYLE) {
  const texts: Text[] = [];
  drawHotbar({ ctx: recorder(texts), sprites: BARE, view, rect, style });
  return texts;
}

/** The bar at the foot of a `width`-wide screen, sized for `count` slots. */
function rectFor(
  count: number,
  width = 1280,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): PanelRect {
  const size = hotbarPanelSize(count, null, width, style);
  return { x: 0, y: 480 - size.h, w: size.w, h: size.h };
}

/** Every bar a player can ask for. Walked whole — there are only eighteen. */
const EVERY_COUNT = Array.from({ length: HOTBAR_SLOT_POOL }, (_u, i) => i + 1);

// ---------------------------------------------------------------------------
// 1. THE KEY IS PRINTED ON THE BOX THAT FIRES IT — at every size
// ---------------------------------------------------------------------------

describe('a key fires the slot it is printed on, at every bar size', () => {
  it('draws each slot its own label, inside its own rect, for every count', () => {
    for (const count of EVERY_COUNT) {
      const rect = rectFor(count);
      const texts = paint(viewOf(count), rect);
      for (let i = 0; i < count; i += 1) {
        const label = hotbarKeyLabel(i);
        expect(label, `slot ${String(i)} wears no key`).not.toBeNull();
        const box = slotRect(rect, i, count);
        // THE LABEL, AT A PIXEL INSIDE THE BOX IT BELONGS TO. Matching the
        // string alone would pass for a painter that drew every key in the
        // first slot; matching the position alone would pass for one that drew
        // the wrong key in the right place.
        const hits = texts.filter(
          (t) =>
            t.text === label &&
            t.x >= box.x &&
            t.x < box.x + box.w &&
            t.y >= box.y &&
            t.y < box.y + box.h,
        );
        expect(
          hits.length,
          `bar of ${String(count)}: slot ${String(i)} label ${String(label)}`,
        ).toBe(1);
      }
    }
  });

  it('sends the press to the slot the label was drawn on, both ways', () => {
    for (const count of EVERY_COUNT) {
      const rect = rectFor(count);
      const texts = paint(viewOf(count), rect);
      for (let i = 0; i < count; i += 1) {
        const label = hotbarKeyLabel(i) ?? '';
        const shifted = label.startsWith('⇧');
        // THE POSITION IN THE ROW, LOOKED UP RATHER THAN PARSED. `Number(label)`
        // worked while every key was its own index plus one; the row is
        // upstream's twelve now and its last three say `0`, `-` and `=`.
        const digit = HOTBAR_ROW_KEYS.indexOf(shifted ? label.slice(1) : label);
        // THE CLOSED LOOP: the string on the box → the key a player presses →
        // the index that press resolves to → the box it was drawn on.
        expect(hotbarSlotForKey(digit, shifted)).toBe(i);
        const box = slotRect(rect, i, count);
        expect(texts.some((t) => t.text === label && t.x >= box.x && t.x < box.x + box.w)).toBe(
          true,
        );
        // ...AND THE POINTER AGREES WITH BOTH, which is the third route to one
        // box and the one that has its own arithmetic.
        expect(hotbarSlotAt(rect, box.x + 2, box.y + 2, count)).toBe(i);
      }
    }
  });

  it('prints no key a bar this size cannot send', () => {
    for (const count of EVERY_COUNT) {
      const rect = rectFor(count);
      const texts = paint(viewOf(count), rect);
      const drawn = new Set(texts.map((t) => t.text));
      for (let i = count; i < HOTBAR_SLOT_POOL; i += 1) {
        // A label for a slot the bar is not drawing is a key that does nothing:
        // `activateSlot` refuses an index past the count in words.
        expect(
          drawn.has(hotbarKeyLabel(i) ?? ''),
          `bar of ${String(count)} drew slot ${String(i)}`,
        ).toBe(false);
      }
    }
  });

  it('keeps the labels unique on a WRAPPED bar, which is where a counter would drift', () => {
    // A bar too narrow for its count wraps onto lines (`hotbarPanelSize`). The
    // painter walks one index space and the geometry walks two, which is the
    // arrangement a running counter gets away with on one line and never on two.
    const style = DEFAULT_HOTBAR_STYLE;
    const narrow = hotbarPanelSize(HOTBAR_SLOT_POOL, { w: 300, h: 1 }, 1280, style);
    const rect = { x: 0, y: 0, w: narrow.w, h: narrow.h };
    expect(narrow.h, 'precondition: the fixture bar must wrap').toBeGreaterThan(
      HOTBAR_INSET * 2 + HOTBAR_HEADER_H + 44,
    );
    const texts = paint(viewOf(HOTBAR_SLOT_POOL), rect, style);
    const seen = new Set<string>();
    for (let i = 0; i < HOTBAR_SLOT_POOL; i += 1) {
      const label = hotbarKeyLabel(i) ?? '';
      const box = slotRect(rect, i, HOTBAR_SLOT_POOL, style);
      const at = texts.filter(
        (t) => t.text === label && t.x >= box.x && t.x < box.x + box.w && t.y >= box.y,
      );
      expect(at.length, `wrapped slot ${String(i)}`).toBe(1);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
    }
    expect(seen.size).toBe(HOTBAR_SLOT_POOL);
  });

  it('takes a drop on every slot, of either kind, at every size', () => {
    // Item 8's whole claim, at every width rather than at one. `Bind` for each
    // box and `Miss` for the gap past the last one.
    for (const count of EVERY_COUNT) {
      const rect = rectFor(count);
      for (let i = 0; i < count; i += 1) {
        const box = slotRect(rect, i, count);
        expect(hotbarDropTargetAt(rect, box.x + 2, box.y + 2, count)).toEqual({
          kind: HotbarDropKind.Bind,
          index: i,
        });
      }
      // One pixel past the right edge of the last box on the first line is not
      // a slot, whatever is drawn there.
      const last = slotRect(rect, Math.min(count, HOTBAR_KEY_ROW * 2) - 1, count);
      expect(hotbarDropTargetAt(rect, last.x + last.w + 3, last.y + 2, count).kind).toBe(
        HotbarDropKind.Miss,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. TWO WRITERS, ONE NUMBER — the cogwheel and the grip
// ---------------------------------------------------------------------------

describe('the cogwheel and the grip reach the same bar', () => {
  /** The cogwheel route: `to - from` presses of `+` or `−`. */
  function byCog(from: number, to: number): HotbarStyle {
    let style: HotbarStyle = { ...DEFAULT_HOTBAR_STYLE, slots: from };
    const by = to >= from ? 1 : -1;
    for (let i = 0; i < Math.abs(to - from); i += 1) style = stepHotbarStyle(style, 'slots', by);
    return style;
  }

  it('lands on the same count from either control, growing and shrinking', () => {
    for (const target of EVERY_COUNT) {
      // The cog, from the shipped bar.
      expect(byCog(HOTBAR_SLOTS_DEFAULT, target).slots).toBe(target);
      // The grip, dragged to the size that count wants.
      const size = hotbarPanelSize(target, null, 4096);
      expect(hotbarSlotsForSize(size)).toBe(target);
    }
  });

  it('draws the same bar either way, box for box', () => {
    for (const target of EVERY_COUNT) {
      const cog = byCog(HOTBAR_SLOTS_DEFAULT, target);
      const grip: HotbarStyle = {
        ...DEFAULT_HOTBAR_STYLE,
        slots: hotbarSlotsForSize(hotbarPanelSize(target, null, 4096)),
      };
      expect(grip.slots).toBe(cog.slots);
      const rect = rectFor(cog.slots);
      // The geometry both routes produce, compared as rects rather than as the
      // number that produced them: two equal counts that laid out differently
      // would be two bars with one name.
      for (let i = 0; i < cog.slots; i += 1) {
        expect(slotRect(rect, i, grip.slots, grip)).toEqual(slotRect(rect, i, cog.slots, cog));
      }
    }
  });

  it('stops at one and at the pool, from both ends, and says nothing beyond', () => {
    expect(stepHotbarStyle({ ...DEFAULT_HOTBAR_STYLE, slots: 1 }, 'slots', -1).slots).toBe(1);
    expect(
      stepHotbarStyle({ ...DEFAULT_HOTBAR_STYLE, slots: HOTBAR_SLOT_POOL }, 'slots', 1).slots,
    ).toBe(HOTBAR_SLOT_POOL);
    // THE GRIP HAS THE SAME TWO ENDS, and it is reached by dragging past them
    // rather than by pressing at them. A bar dragged into the corner keeps one
    // slot; one dragged across two screens stops at the pool, because a slot
    // past the pool would have no key — `HOTBAR_SLOT_POOL`'s own argument.
    expect(hotbarSlotsForSize({ w: 0, h: 0 })).toBe(1);
    expect(hotbarSlotsForSize({ w: 20000, h: 20000 })).toBe(HOTBAR_SLOT_POOL);
  });

  it('is a fixed point at every count, so the bar does not walk while it is held', () => {
    // The grip writes the count LIVE and `hudLayout` re-derives the rect from
    // the count on the very next frame. If `size -> count -> size` moved, the
    // panel would creep a pixel a frame for as long as the button was down.
    for (const style of [
      DEFAULT_HOTBAR_STYLE,
      { ...DEFAULT_HOTBAR_STYLE, icon: 48 },
      { ...DEFAULT_HOTBAR_STYLE, vertical: true },
    ]) {
      for (const count of EVERY_COUNT) {
        const size = hotbarPanelSize(count, null, 4096, style, 4096);
        const back = hotbarSlotsForSize(size, style);
        expect(back, `${String(count)} slots`).toBe(count);
        expect(hotbarPanelSize(back, null, 4096, style, 4096)).toEqual(size);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SHRINKING HIDES BUTTONS AND NEVER ERASES THEM — and the bar says so
// ---------------------------------------------------------------------------

describe('what happens to what was in a removed slot', () => {
  it('says how many are past the end, when the pointer is on nothing', () => {
    const wide = rectFor(HOTBAR_SLOT_POOL);
    const line = paint(viewOf(HOTBAR_SLOT_POOL, { hidden: 3 }), wide).find((t) =>
      t.text.includes('past the end'),
    );
    expect(line, 'the bar said nothing about the buttons it stopped drawing').toBeDefined();
    expect(line?.text).toContain('3');
    // STILL BOUND is the whole point of the sentence: the alternative reading of
    // a button that vanished is that it was cleared, and that reading is wrong.
    expect(line?.text).toContain('still bound');
  });

  it('keeps the fact when the bar is too narrow for the sentence', () => {
    /**
     * ═══ THE FIRST VERSION OF THIS LINE LOST ITS POINT ON THE ONLY BAR THAT
     * EVER SHOWS IT ═══
     * The strip is cut to the header by `fitText`, and a five-slot bar — which
     * is precisely the bar somebody has just shrunk — holds about thirty-six
     * characters. *"3 past the end of the bar — still bound, widen it to reach
     * them"* came out as *"3 past the end of the bar — still b…"*: the clause
     * the line exists for, gone, and the one a player can already see, kept.
     *
     * So the assertion is about WORD ORDER and not about the string. It fails
     * for any rewrite that puts the reassurance after the explanation, which is
     * the natural way to write the sentence and the wrong way to draw it.
     */
    const narrow = rectFor(5);
    const drawn = paint(viewOf(5, { hidden: 3 }), narrow).find((t) => t.text.startsWith('3 '));
    expect(drawn, 'no hidden-count line at all on a shrunk bar').toBeDefined();
    expect(drawn?.text.length, 'precondition: the fixture bar must cut the line').toBeLessThan(42);
    expect(drawn?.text).toContain('still bound');
  });

  it('says nothing at all when the bar covers everything it holds', () => {
    const rect = rectFor(HOTBAR_SLOT_POOL);
    const texts = paint(viewOf(HOTBAR_SLOT_POOL, { hidden: 0 }), rect);
    expect(texts.some((t) => t.text.includes('past the end'))).toBe(false);
    // And a view that never counted reads as "nothing to report" rather than
    // as a zero it has to spell — `HotbarView.hidden` is optional.
    expect(paint(viewOf(4), rectFor(4)).some((t) => t.text.includes('past the end'))).toBe(false);
  });

  it('gives the line up the moment the pointer wants the row', () => {
    // ONE LINE, AND THE HOVER OUTRANKS IT. A count that stayed up would take
    // the strip away from the name of the talent under the pointer, which is
    // what a player is reading the strip for.
    const rect = rectFor(5);
    const hovered = paint(viewOf(5, { hidden: 3, hovered: 0 }), rect);
    expect(hovered.some((t) => t.text.includes('past the end'))).toBe(false);
    expect(hovered.some((t) => t.text.includes('Talent 0'))).toBe(true);
    // ...and an ARMED slot outranks it too, by the same rule and the same line.
    const armed = paint(viewOf(5, { hidden: 3, armed: 3 }), rect);
    expect(armed.some((t) => t.text.includes('past the end'))).toBe(false);
  });

  it('draws exactly the slots it was given and never reaches past them', () => {
    // The painter's half of "hidden, not erased": a view of five slots draws
    // five boxes whatever the pool holds, and the sixth is not drawn dimly or
    // half-drawn — it is not drawn.
    const rect = rectFor(5);
    const texts = paint(viewOf(5, { hidden: 13 }), rect);
    expect(texts.some((t) => t.text === 'Talent 6')).toBe(false);
    expect(hotbarSlotAt(rect, rect.x + rect.w + 4, rect.y + rect.h - 4, 5)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 4. THE STORES OUTLIVE THE BAR — the one property with no other reachable form
// ---------------------------------------------------------------------------

const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
/** `MAIN` with its comments removed — talent-bindings.test.ts:38-50's rule. */
const CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the bindings are pool-long whatever the bar is showing', () => {
  it('never shortens either store', () => {
    // THE ONLY WAY A SHRINK COULD ERASE ANYTHING. Both stores are built at
    // `HOTBAR_SLOT_POOL` and the count only bounds what is DRAWN, so the
    // failure would have to be an explicit truncation — and it would present
    // as "the game deleted my buttons when I dragged the bar in".
    expect(CODE).not.toMatch(/talentBindings\.length\s*=/);
    expect(CODE).not.toMatch(/hotbarBindings\.length\s*=/);
    expect(CODE).not.toContain('talentBindings.splice');
    expect(CODE).not.toContain('hotbarBindings.splice');
    expect(CODE).toContain(
      'const talentBindings: (string | null)[] = Array.from({ length: HOTBAR_SLOT_POOL }, () => null);',
    );
    expect(CODE).toContain(
      'const hotbarBindings: (ItemBinding | null)[] = Array.from({ length: HOTBAR_SLOT_POOL }, () => null);',
    );
  });

  it('counts what it is hiding through the same resolvers it draws with', () => {
    // `talentInSlot` and not `talentBindings[i] != null`: a binding whose talent
    // has left the loadout draws as an EMPTY slot when it is visible, so
    // counting it as hidden would promise a button that would not appear.
    expect(CODE).toContain(
      'if (talentInSlot(i) !== undefined || hotbarBindings[i] != null) hidden += 1;',
    );
    expect(CODE).toContain('for (let i = count; i < HOTBAR_SLOT_POOL; i += 1) {');
    // ONE READER OF THE COUNT ON THE VIEW, so the strip and the boxes cannot
    // disagree about which bar they are describing.
    expect(CODE).toContain('hidden,');
  });
});
