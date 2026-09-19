/// <reference lib="dom" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DIALOGUE_MARGIN,
  DIALOGUE_MAX_W,
  DIALOGUE_RESET_LABEL,
  DialogueAnswerKind,
  DialogueHitKind,
  LINE_ROWS,
  OPTION_ROW_H,
  PORTRAIT_PX,
  PORTRAIT_UNKNOWN,
  PortraitSource,
  dialogueAnswerAt,
  dialogueAnswerForDigit,
  dialogueDragAt,
  dialogueFirstEnabled,
  dialogueGeometry,
  dialogueHitAt,
  dialogueInitials,
  dialogueLines,
  dialoguePortraitSource,
  dialogueRect,
  dialogueSettingsRect,
  dialogueStep,
  drawDialogue,
} from '../../src/client/ui/dialogue.ts';
import { HEADER_H, PANEL_CORNER, PANEL_PAD } from '../../src/client/ui/panel.ts';
import { NO_OFFSET, moveIntoBand, nextOffset, settleOffset } from '../../src/client/ui/drag.ts';
import { HOTBAR_TOTAL_H } from '../../src/client/ui/hotbar.ts';
import { TURN_BAR_H } from '../../src/client/ui/turnbar.ts';
import { PALETTE } from '../../src/client/render/canvas.ts';
import { DialogueScope } from '../../src/shared/protocol.ts';
import type { DialogueGeometry, DialogueRow } from '../../src/client/ui/dialogue.ts';
import type { DialogueOptionView, DialogueView } from '../../src/shared/protocol.ts';
import type { Sprite, SpriteSource } from '../../src/client/render/assets.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONVERSATION WINDOW, READ THE WAY A KEYPRESS AND A CLICK READ IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that the environment is `node` with deliberately
 * no jsdom and no canvas, so nothing below paints a pixel. What is tested is the
 * layer where this surface can be wrong in a way nobody notices:
 *
 *   THE HOST RULE      a story answer a non-lead may not give is DRAWN, with the
 *                      lead's name on it, and cannot be fired by the mouse, by
 *                      the arrows, or by its own number key. The number key is
 *                      the route round a greyed row and it has its own case.
 *   THE COLUMN         every string is measured against the column it is DRAWN
 *                      in. ui/caselog.ts shipped the other version of this and
 *                      it hung every rule past the panel border.
 *   THE BAND           the window is laid out in `panelBand`'s REAL band, in and
 *                      out of combat, not in a round fixture. Memory
 *                      `fixture-bands-are-not-panel-bands`: 640x320 top 40
 *                      bottom 280 is not what a panel is given, and a
 *                      size-sensitive layout has already passed the fixture and
 *                      dropped content live.
 *   THE FALLBACK       no art is a SUPPORTED state (a bare clone has none), so
 *                      the face chain is asserted at every step of it.
 *
 * The hit tests SCAN a column of points rather than asserting coordinates, for
 * test/client/classpicker.test.ts's reason: an assertion that row 2 starts at
 * y=204 would pass while it was drawn at y=202, because it would be testing the
 * test's own copy of the arithmetic.
 */

// ---------------------------------------------------------------------------
// The real band, read out of main.ts rather than guessed at
// ---------------------------------------------------------------------------

const root = new URL('../../', import.meta.url);

/** Comments stripped, exactly as `wired-art-loading.test.ts`'s `codeOf` does it. */
function codeOf(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * `panelBand(height, hudTop)`, REBUILT FROM ITS OWN SOURCE.
 *
 * main.ts boots the client on import, so it cannot be imported and the two
 * constants it uses are private to it. The body is PINNED below, so a rebuild
 * that has drifted from the real band fails here rather than quietly measuring
 * a band no panel is ever given — which is precisely the failure the memory note
 * above records, twice in one session.
 */
function realBand(height: number, _inCombat: boolean): { top: number; bottom: number } {
  const code = codeOf('src/client/main.ts');
  expect(code, 'panelBand was reshaped; this rebuild is measuring a band nothing uses').toContain(
    '    top: hudTop + DOCK_MARGIN,\n',
  );
  expect(code, 'panelBand’s floor moved; rebuild it here').toContain(
    '    bottom: height - HOTBAR_TOTAL_H - LINE_H * 2 - DOCK_MARGIN,\n',
  );
  const read = (name: string): number => {
    const found = new RegExp(`const ${name} = (\\d+);`).exec(code);
    expect(found, `${name} is no longer a numeric literal in main.ts`).not.toBeNull();
    return Number(found?.[1]);
  };
  const dock = read('DOCK_MARGIN');
  const lineH = read('LINE_H');
  /**
   * ═══ THE TOP HUD IS `TURN_BAR_H`, IN COMBAT AND OUT OF IT ═══
   * It was `TURN_BAR_H + turnCardsHeight(turn)` — 14 walking around and 60 in a
   * fight, because a strip of turn cards sat under the banner whenever there was
   * one. That strip is deleted and the party pane carries what it carried, so
   * this band no longer moves when a monster joins the initiative.
   *
   * THE PARAMETER IS KEPT AND IGNORED, deliberately. Forty-one call sites below
   * drive both states, and several of them loop over `[false, true]` to prove a
   * rule holds in a fight as well as out of one. Dropping it would delete that
   * sweep along with the argument; keeping it means every one of those cases
   * still runs, against a band that is now asserted to be the same either way
   * (test/client/turnband.test.ts measures the difference that used to exist).
   */
  const hudTop = TURN_BAR_H;
  return { top: hudTop + dock, bottom: height - HOTBAR_TOTAL_H - lineH * 2 - dock };
}

/**
 * THE THREE VIEWPORTS, AND NOT ONE OF THEM IS ROUND.
 *
 * 640x320 is `HUD_MIN_W`/`HUD_MIN_H`, the floor this client renders at. 1262x428
 * is the measured Discord Activity box from DECISIONS.md's own UI-scale table
 * (dpr 1, `hudScale` 1). 772x367 is neither, and is there so nothing can pass by
 * being true of a special case.
 */
const VIEWPORTS: readonly (readonly [number, number])[] = [
  [640, 320],
  [1262, 428],
  [772, 367],
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function option(
  id: string,
  label: string,
  over: Partial<DialogueOptionView> = {},
): DialogueOptionView {
  return { id, label, scope: DialogueScope.Personal, enabled: true, ...over };
}

const STORY_REASON = 'Only Dalt can answer for the party';

/** A greyed story row: what a NON-LEAD is sent for an answer only the lead may give. */
function storyRow(id: string, label: string): DialogueOptionView {
  return { id, label, scope: DialogueScope.Story, enabled: false, reason: STORY_REASON };
}

function view(over: Partial<DialogueView> = {}): DialogueView {
  return {
    speakerId: 'npc_merrow',
    speakerName: 'Merrow Stitch',
    portrait: 'chr_portrait_merrow_stitch',
    sprite: 'chr_npc_merrow_stitch_s',
    nodeId: 'greet',
    text: 'Threadneedle Row. Coats, boots, and I do not ask.',
    options: [
      option('topic:where', 'Where should I go?'),
      option('shop', 'Let me see your wares.'),
      option('leave', 'Nothing for now.'),
    ],
    ...over,
  };
}

/** The frame a NON-LEAD gets on the rumour node: one story row among personal ones. */
const NON_LEAD = view({
  nodeId: 'topic:rumour',
  options: [
    option('route:self', 'Put that country on my map.'),
    storyRow('route:party', "Put it on the whole party's map."),
    option('back', 'Ask something else.'),
    option('leave', 'Nothing for now.'),
  ],
});

/**
 * The window as it would really be laid out, at a viewport and a selection.
 *
 * EVERY DIGIT CASE GOES THROUGH THIS, because a digit answers a row that was
 * PLACED and placement is a function of the band. A test that handed
 * `dialogueAnswerForDigit` the option list would be testing the bug it exists
 * to stop.
 */
function geometryOf(
  v: DialogueView,
  w = 1262,
  h = 428,
  inCombat = false,
  selected = 0,
): DialogueGeometry {
  const band = realBand(h, inCombat);
  return dialogueGeometry(v, dialogueRect(v, w, band), selected);
}

function sprite(id: string, w: number, h: number): Sprite {
  return { id, image: { id, w, h } as unknown as HTMLImageElement, w, h };
}

/** A source that answers only the ids it is given, at the sizes they really are. */
function sourceOf(sizes: Readonly<Record<string, readonly [number, number]>>): SpriteSource {
  return {
    sprite: (id: string) => {
      const size = sizes[id];
      return size === undefined ? undefined : sprite(id, size[0], size[1]);
    },
  };
}

const NO_ART: SpriteSource = { sprite: () => undefined };

// ---------------------------------------------------------------------------
// A recording context that really keeps its state, so a leak is visible
// ---------------------------------------------------------------------------

/**
 * ONE DRAWN STRING, WITH THE INK AND THE FACE IT WAS DRAWN IN.
 *
 * The ink is recorded because two of this window's rules are about it and
 * neither can be read off the geometry: a greyed row must be DIM AND LEGIBLE
 * (`GREY_HI`, not `GREY` — sampled at 1.63:1 and 1.36:1 on the real skin), and
 * the painter must decide live-or-greyed from `enabled` and never from a scope.
 */
type Written = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fill: string;
  readonly font: string;
};

/** One filled box, with the ink it was filled in. Shapes are rules too. */
type Filled = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
};

type Recorder = {
  readonly ctx: CanvasRenderingContext2D;
  readonly texts: Written[];
  readonly rects: Filled[];
  readonly blits: string[];
  /**
   * Every `arc` the painter traced. The cogwheel is DRAWN rather than written
   * (ui/caselog.ts's `drawCog`), so a recorder that only sees `fillText` cannot
   * tell whether it was painted at all — which is exactly how it came to be
   * both invisible and inert with the whole suite green.
   */
  readonly arcs: { x: number; y: number; r: number }[];
  /** The style fields, as they stand right now. */
  readonly style: () => Record<string, unknown>;
};

/**
 * `measureText` answers SIX PIXELS A CHARACTER, which is what the 10px
 * monospace this panel draws with actually measures and what every other painter
 * test in this suite assumes (`CHAR_W` in ui/classpicker.ts, ui/tooltip.ts,
 * ui/contextmenu.ts). A flat constant would make `fitText` and `wrapText`
 * untestable, because both of them are length-dependent by construction.
 *
 * `save`/`restore` ARE REAL HERE, and that is the point of writing this rather
 * than reusing canvasstub's proxy: the leak test below asserts that the painter
 * left `font`, `fillStyle`, `textAlign`, `textBaseline` and `globalAlpha` as it
 * found them, and that claim is meaningless against a stub where `restore` is a
 * no-op and every assignment is swallowed.
 */
function recorder(): Recorder {
  const texts: Written[] = [];
  const rects: Filled[] = [];
  const blits: string[] = [];
  const arcs: { x: number; y: number; r: number }[] = [];
  let style: Record<string, unknown> = {
    font: 'initial-font',
    fillStyle: 'initial-fill',
    strokeStyle: 'initial-stroke',
    textAlign: 'initial-align',
    textBaseline: 'initial-baseline',
    globalAlpha: 0.5,
    imageSmoothingEnabled: true,
  };
  const stack: Record<string, unknown>[] = [];
  const api: Record<string, unknown> = {
    canvas: { width: 1920, height: 1080 },
    save: () => stack.push({ ...style }),
    restore: () => {
      const back = stack.pop();
      if (back !== undefined) style = back;
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText: (text: string, x: number, y: number) =>
      texts.push({ text, x, y, fill: String(style['fillStyle']), font: String(style['font']) }),
    strokeText: (text: string, x: number, y: number) =>
      texts.push({ text, x, y, fill: String(style['fillStyle']), font: String(style['font']) }),
    fillRect: (x: number, y: number, w: number, h: number) =>
      rects.push({ x, y, w, h, fill: String(style['fillStyle']) }),
    strokeRect: () => undefined,
    drawImage: (image: { id?: string }) => blits.push(image.id ?? '?'),
    arc: (x: number, y: number, r: number) => arcs.push({ x, y, r }),
    beginPath: () => undefined,
    closePath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
  };
  const ctx = new Proxy(api, {
    get: (target, prop: string) =>
      prop in style ? style[prop] : (target[prop] ?? (() => undefined)),
    set: (_target, prop: string, value: unknown) => {
      style[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts, rects, blits, arcs, style: () => ({ ...style }) };
}

/** A context good enough to measure with, for the pure geometry helpers. */
function measuring(): CanvasRenderingContext2D {
  return recorder().ctx;
}

// ---------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------

describe('dialogueRect', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * CENTRED ON X, AND THIS TEST IS THE REVERSAL OF THE ONE THAT WAS HERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It read *"RIGHT-DOCKED, NOT CENTRED, AND THE LOG IS THE REASON"*, and the
   * measurement behind it was real: centred at 1262x428 the window hid the right
   * 41% of every Case Log line, and at the 640x320 floor it covered the MARGIN
   * chip. The author asked for it centred anyway — *"the x axis needs to be
   * centered"* — and in the same breath asked for the window to be DRAGGABLE
   * with a Reset position. The overlap is now the player's to resolve, once, and
   * the server remembers the answer; the dock was a guess on their behalf.
   *
   * ═══ ASSERTED AS EQUAL MARGINS, NOT AS `floor((w - rect.w) / 2)` ═══
   * Restating the formula would be testing this file's own copy of the
   * arithmetic — the rule the hit tests below follow for the same reason. Equal
   * margins to within the odd pixel is the PROPERTY "centred" means, and it
   * fails for a right-dock, a left-dock and an off-by-any-amount alike.
   */
  it('is centred horizontally, capped, and inside the band at every viewport', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        const rect = dialogueRect(view(), w, band);
        const where = `${String(w)}x${String(h)} combat=${String(inCombat)}`;
        const left = rect.x;
        const right = w - (rect.x + rect.w);
        // ONE PIXEL OF SLACK AND NO MORE, because an odd remainder has to go
        // somewhere. Two would admit a window a whole margin off centre.
        expect(
          Math.abs(left - right),
          `${where}: ${String(left)} vs ${String(right)}`,
        ).toBeLessThanOrEqual(1);
        expect(Number.isInteger(rect.x), `${where}: fractional x`).toBe(true);
        expect(rect.w).toBeLessThanOrEqual(DIALOGUE_MAX_W);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(w);
        // IN THE BAND, BOTH EDGES. The floor is what keeps it off the hotbar and
        // the two prose lines; the ceiling is what keeps it under the turn HUD.
        expect(rect.y).toBeGreaterThanOrEqual(band.top);
        expect(rect.y + rect.h).toBeLessThanOrEqual(band.bottom);
      }
    }
  });

  /**
   * AND AT WIDTHS NO VIEWPORT IN THE LIST HAPPENS TO HAVE, including the two
   * that bracket the cap. Below `DIALOGUE_MAX_W + MARGIN * 2` the window is as
   * wide as the band allows and the centre IS the margin — `dialogueRect`'s note
   * claims that is not a special case, and this is what makes the claim checkable.
   */
  it('centres at every width, and the margin is the centre once the cap bites', () => {
    const band = realBand(428, false);
    for (const w of [520, 531, 532, 533, 640, 700, 901, 1262, 1920]) {
      const rect = dialogueRect(view(), w, band);
      const where = `w=${String(w)}`;
      expect(w - (rect.x + rect.w), where).toBe(rect.x + ((w - rect.w) % 2));
      if (rect.w >= w - DIALOGUE_MARGIN * 2) {
        expect(rect.x, `${where}: the cap should leave exactly the margin`).toBe(DIALOGUE_MARGIN);
      }
    }
  });

  /**
   * THE Y IS UNTOUCHED BY THE CENTRING — *"centered on its current y axis"* is
   * the author's phrase for "leave it where it is vertically", and the window
   * still stands on the floor of the band.
   */
  it('keeps its y on the floor of the band, which is what centring did not change', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        const rect = dialogueRect(view(), w, band);
        expect(rect.y + rect.h, `${String(w)}x${String(h)}`).toBe(band.bottom);
      }
    }
  });

  it('is docked to the FLOOR of the band, so a shorter band shortens it', () => {
    /**
     * ═══ THIS USED TO SAY "so it rises when the turn cards appear" ═══
     * It compared the band in combat with the band out of it, and the turn card
     * strip was what made those two differ. The cards are deleted, the band no
     * longer moves, and asserting against two identical bands would be asserting
     * nothing — so the RULE is driven directly instead: the window stands on the
     * floor of whatever band it is given, and a band with a lower ceiling makes
     * it shorter rather than lower. That is the property the old fixture was
     * reaching for, stated without needing a fight to produce it.
     */
    const [w, h] = [1262, 428];
    const roomy = realBand(h, false);
    const squeezed = { top: roomy.top + 46, bottom: roomy.bottom };
    const big = view({
      options: Array.from({ length: 20 }, (_, i) => option(`o${String(i)}`, 'x')),
    });
    expect(dialogueRect(big, w, roomy).y + dialogueRect(big, w, roomy).h).toBe(roomy.bottom);
    expect(dialogueRect(big, w, squeezed).y + dialogueRect(big, w, squeezed).h).toBe(
      squeezed.bottom,
    );
    expect(dialogueRect(big, w, squeezed).h).toBeLessThan(dialogueRect(big, w, roomy).h);
  });

  it('grows with the answer list rather than being one fixed height', () => {
    const band = realBand(428, false);
    const small = dialogueRect(
      view({ options: [option('leave', 'Nothing for now.')] }),
      1262,
      band,
    );
    const large = dialogueRect(NON_LEAD, 1262, band);
    expect(large.h - small.h).toBe(
      // Three more rows than the one-row frame, one of which is greyed and
      // therefore carries a reason line under it. Asserted as a DIFFERENCE, so it
      // does not restate the panel's own arithmetic for the chrome.
      dialogueGeometry(NON_LEAD, large)
        .rows.slice(1)
        .reduce((sum, row) => sum + row.rect.h, 0),
    );
  });
});

// ---------------------------------------------------------------------------
// One geometry, three readers
// ---------------------------------------------------------------------------

describe('dialogueHitAt — the painter, the keyboard and the pointer read one layout', () => {
  const band = realBand(428, false);
  const rect = dialogueRect(NON_LEAD, 1262, band);

  /** The row under a point, or null — the shape every row case here wants. */
  function rowAt(x: number, y: number, settingsOpen = false): DialogueRow | null {
    const hit = dialogueHitAt(NON_LEAD, rect, 0, x, y, settingsOpen);
    return hit !== null && hit.kind === DialogueHitKind.Row ? hit.row : null;
  }

  it('finds each row at every point down its own band, and nothing above the list', () => {
    const geometry = dialogueGeometry(NON_LEAD, rect, 0);
    expect(geometry.rows).toHaveLength(NON_LEAD.options.length);
    for (const row of geometry.rows) {
      // SCANNED, never asserted at a coordinate. Every y inside the row, at the
      // row's own left edge and at its right edge.
      for (let y = row.rect.y; y < row.rect.y + row.rect.h; y += 1) {
        for (const x of [row.rect.x, row.rect.x + row.rect.w - 1]) {
          expect(rowAt(x, y)?.index, `${String(x)},${String(y)}`).toBe(row.index);
        }
      }
    }
    const first = geometry.rows[0];
    expect(first).toBeDefined();
    // The separator, the line and the portrait are not rows. THE HEADER IS
    // SKIPPED, because it now carries two controls that answer for themselves —
    // see the header-controls suite below.
    for (let y = rect.y + HEADER_H; y < (first?.rect.y ?? 0); y += 1) {
      expect(dialogueHitAt(NON_LEAD, rect, 0, rect.x + rect.w / 2, y, false)).toBeNull();
    }
  });

  it('answers the GREYED row too, so the caller can swallow the press and say why', () => {
    // A greyed row that answered null would fall through to the map, and travel
    // is a turn verb, and a turn verb closes the conversation on the server. The
    // press has to land ON the row for `sayDialogue` to refuse it.
    const geometry = dialogueGeometry(NON_LEAD, rect, 0);
    const greyed = geometry.rows.find((row) => !row.option.enabled);
    expect(greyed).toBeDefined();
    const row = rowAt((greyed?.rect.x ?? 0) + 2, (greyed?.rect.y ?? 0) + 2);
    expect(row?.index).toBe(greyed?.index);
    expect(row?.option.enabled).toBe(false);
  });

  it('is null outside the window on every side', () => {
    for (const [x, y] of [
      [rect.x - 1, rect.y + rect.h - 2],
      [rect.x + rect.w + 1, rect.y + rect.h - 2],
      [rect.x + 2, rect.y - 1],
      [rect.x + 2, rect.y + rect.h + 1],
    ]) {
      expect(dialogueHitAt(NON_LEAD, rect, 0, x ?? 0, y ?? 0, false)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The header controls — the ×, the cogwheel, and the strip they carved up
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE CLOSE CONTROL, ONE COGWHEEL, AND A HANDLE THAT CLAIMS NEITHER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for as *"a single (X) button a the top right to close the dialogue"* and
 * *"the dialogue box should have a (cog wheel settings button) and be dragable"*.
 *
 * THE BUG THESE EXIST TO REFUSE is the one ui/panel.ts's `headerDragRect` note
 * records as SHIPPED on another panel: a header that looks grabbable everywhere
 * starts a drag when you press the control, which then fires on mouseup having
 * moved the window first. So the two controls and the handle are asserted to be
 * disjoint, at every viewport, by scanning rather than by arithmetic.
 */
describe('the window closes and configures itself from its own header', () => {
  it('puts both controls inside the header strip, at the right end, not overlapping', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        const rect = dialogueRect(view(), w, band);
        const { close, cog } = dialogueGeometry(view(), rect, 0);
        const where = `${String(w)}x${String(h)} combat=${String(inCombat)}`;
        for (const [name, box] of [
          ['close', close],
          ['cog', cog],
        ] as const) {
          expect(box.w, `${where} ${name} width`).toBeGreaterThan(0);
          expect(box.y, `${where} ${name} top`).toBeGreaterThanOrEqual(rect.y);
          expect(box.y + box.h, `${where} ${name} bottom`).toBeLessThanOrEqual(rect.y + HEADER_H);
          // BOTH EDGES. Only asserting the right one let a control sit at a
          // NEGATIVE offset from the window, outside it on the left, and pass.
          expect(box.x, `${where} ${name} left`).toBeGreaterThanOrEqual(rect.x);
          expect(box.x + box.w, `${where} ${name} right`).toBeLessThanOrEqual(rect.x + rect.w);
        }
        // ═══ TOP RIGHT, WHICH IS THE HALF OF THE REQUEST A LAYOUT CAN GET
        //     WRONG WITHOUT ANYTHING ELSE NOTICING ═══
        // *"a single (X) button a the top right"*. Flush against the panel
        // gutter, exactly as ui/charsheet.ts, ui/inventory.ts and
        // ui/escapemenu.ts place theirs — a player who has closed one panel
        // looks there and finds this one. Without this claim the × could be
        // docked to the LEFT end of the strip and every other assertion here
        // would still pass; that mutation was run.
        expect(rect.x + rect.w - (close.x + close.w), `${where}: × off the right gutter`).toBe(
          PANEL_PAD,
        );
        // AND THE COGWHEEL IS BESIDE IT, INSIDE, with clear air between the two.
        expect(cog.x + cog.w, where).toBeLessThan(close.x);
        expect(cog.x, where).toBeGreaterThan(rect.x + rect.w / 2);
      }
    }
  });

  it('answers Close on the × and Cog on the cogwheel, at every pixel of each', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(view(), 1262, band);
    const { close, cog } = dialogueGeometry(view(), rect, 0);
    for (const [kind, box] of [
      [DialogueHitKind.Close, close],
      [DialogueHitKind.Cog, cog],
    ] as const) {
      for (let y = box.y; y < box.y + box.h; y += 1) {
        for (let x = box.x; x < box.x + box.w; x += 1) {
          expect(
            dialogueHitAt(view(), rect, 0, x, y, false)?.kind,
            `${kind} at ${String(x)},${String(y)}`,
          ).toBe(kind);
        }
      }
    }
  });

  /**
   * AND THE HANDLE IS WHAT IS LEFT. Scanned across the whole strip: every pixel
   * either grabs the window or presses a control, and NEVER both.
   */
  it('gives the drag handle the strip minus the two controls, and never a pixel of either', () => {
    for (const [w, h] of VIEWPORTS) {
      const band = realBand(h, false);
      const rect = dialogueRect(view(), w, band);
      const { close, cog } = dialogueGeometry(view(), rect, 0);
      const onControl = (x: number, y: number): boolean =>
        [close, cog].some(
          (box) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h,
        );
      let grabbable = 0;
      for (let y = rect.y; y < rect.y + HEADER_H; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          const drag = dialogueDragAt(rect, x, y);
          if (drag) grabbable += 1;
          expect(
            drag && onControl(x, y),
            `${String(w)}: ${String(x)},${String(y)} is both handle and control`,
          ).toBe(false);
        }
      }
      // AND THERE IS A HANDLE AT ALL. A reservation that ate the whole strip
      // would pass the disjointness claim above and leave a window nobody can
      // move — which is exactly the failure ui/caselog.ts's `logComposerRect`
      // records for a grip got wrong, in the other direction.
      expect(grabbable, `${String(w)}: no grabbable header`).toBeGreaterThan(rect.w / 2);
    }
  });

  it('is not a handle anywhere below the header, so a press on a row never drags', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    for (const row of dialogueGeometry(NON_LEAD, rect, 0).rows) {
      for (const x of [row.rect.x, row.rect.x + row.rect.w - 1]) {
        expect(dialogueDragAt(rect, x, row.rect.y + 1)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The cogwheel's popover
// ---------------------------------------------------------------------------

describe('the cogwheel opens a settings popover with Reset position in it', () => {
  /**
   * ═══ IT IS DRAWN INSIDE THE WINDOW, AND THAT IS A CORRECTNESS CLAIM ═══
   * `overPanel` and mousedown's step 1b both swallow a press by testing the
   * WINDOW'S rect. A control drawn outside it would be a button whose press
   * falls through to the map — and travel is a turn verb, and a turn verb ends
   * the conversation server-side. ui/caselog.ts's popover is allowed to hang
   * below its panel; this one may not, and the difference is written down in
   * `dialogueSettingsRect`.
   */
  it('keeps the whole popover inside the window at every viewport, in and out of combat', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        for (const v of [view(), NON_LEAD]) {
          const rect = dialogueRect(v, w, band);
          const { box, reset } = dialogueSettingsRect(rect);
          const where = `${String(w)}x${String(h)} combat=${String(inCombat)}`;
          for (const [name, part] of [
            ['box', box],
            ['reset', reset],
          ] as const) {
            expect(part.w, `${where} ${name} width`).toBeGreaterThan(0);
            expect(part.x, `${where} ${name} left`).toBeGreaterThanOrEqual(rect.x);
            expect(part.y, `${where} ${name} top`).toBeGreaterThanOrEqual(rect.y);
            expect(part.x + part.w, `${where} ${name} right`).toBeLessThanOrEqual(rect.x + rect.w);
            expect(part.y + part.h, `${where} ${name} bottom`).toBeLessThanOrEqual(rect.y + rect.h);
          }
        }
      }
    }
  });

  it('is tall enough for the skin it says it wears', () => {
    /**
     * ═══ IT WAS 26 TALL AND `drawPanel` DEGRADES BELOW 32 ═══
     * A nine-slice needs two corners' worth of height before it has an edge to
     * stretch, so `drawPanel` falls back to `tracePanel` under `PANEL_CORNER *
     * 2` — and this box shipped at `POP_ROW_H + PANEL_PAD * 2` = 26. What was
     * drawn was a flat PANEL rectangle with a 1px SLATE border, which this
     * module's own note measures at 1.09:1 against that fill: a menu with
     * effectively no edge, floating on the window it is meant to sit on top of.
     * The Case Log's popover is three rows and 58 tall, so it never hit this and
     * the two looked nothing like each other side by side.
     */
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const rect = dialogueRect(NON_LEAD, w, realBand(h, inCombat));
        const { box, reset } = dialogueSettingsRect(rect);
        const where = `${String(w)}x${String(h)} combat=${String(inCombat)}`;
        expect(box.h, `${where}: the popover fell back to a traced box`).toBeGreaterThanOrEqual(
          PANEL_CORNER * 2,
        );
        // ...AND THE BUTTON IS CENTRED IN WHAT THAT LEAVES, rather than pinned
        // to the top with the slack hanging under it.
        const above = reset.y - box.y;
        const below = box.y + box.h - (reset.y + reset.h);
        expect(
          Math.abs(above - below),
          `${where}: the reset button is not centred`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('answers nothing while it is shut, and Reset on its button once it is open', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const { reset } = dialogueSettingsRect(rect);
    const mid: readonly [number, number] = [
      reset.x + Math.floor(reset.w / 2),
      reset.y + Math.floor(reset.h / 2),
    ];
    // SHUT: the popover is not there, so the point answers whatever is under it
    // — never `Reset`. A closed menu whose button still fired would be a control
    // nobody can see reaching into a conversation.
    expect(dialogueHitAt(NON_LEAD, rect, 0, mid[0], mid[1], false)?.kind).not.toBe(
      DialogueHitKind.Reset,
    );
    expect(dialogueHitAt(NON_LEAD, rect, 0, mid[0], mid[1], true)?.kind).toBe(
      DialogueHitKind.Reset,
    );
  });

  /**
   * AND EVERY OTHER PIXEL OF IT IS SWALLOWED. ui/caselog.ts's `settingsPress`:
   * *"it swallows every press on itself, not only the ones that land on a
   * button"* — here the thing underneath is an ANSWER ROW, so a press on the
   * popover's padding that fell through would say something to somebody.
   */
  it('swallows a press on its own background rather than answering the row beneath', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const { box, reset } = dialogueSettingsRect(rect);
    let background = 0;
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const onReset =
          x >= reset.x && x < reset.x + reset.w && y >= reset.y && y < reset.y + reset.h;
        if (onReset) continue;
        background += 1;
        const kind = dialogueHitAt(NON_LEAD, rect, 0, x, y, true)?.kind;
        // Close and Cog are above it in the strip and win where they overlap;
        // what must NEVER happen is a ROW.
        expect(kind, `${String(x)},${String(y)}`).not.toBe(DialogueHitKind.Row);
        expect(kind, `${String(x)},${String(y)}`).not.toBeUndefined();
      }
    }
    expect(background, 'the popover has no background at all').toBeGreaterThan(0);
  });

  /**
   * ═══ THE FLAG IS WHAT MAKES THOSE PIXELS ANSWER AT ALL ═══
   *
   * MEASURED, SO THE CLAIM IS THE TRUE ONE: the popover hangs under the header
   * and the answer rows start `HEADER_H + INSET + PORTRAIT_PX + SEPARATOR_H`
   * below the top, so at every viewport this client renders it lands over the
   * FACE and the SPOKEN LINE — never over a row. That is a happy accident of two
   * numbers rather than a rule, which is exactly why `dialogueHitAt` is asked
   * with the flag rather than trusted to miss: the day the popover grows a
   * second row, or the face shrinks, the pixels move and the swallow is already
   * in place. Both halves are asserted here, so a change to either number shows
   * up as a failing claim rather than as a press that says something out loud.
   */
  it('answers only while it is open, and is never a row either way', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const { box } = dialogueSettingsRect(rect);
    let changed = 0;
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const shut = dialogueHitAt(NON_LEAD, rect, 0, x, y, false)?.kind;
        const open = dialogueHitAt(NON_LEAD, rect, 0, x, y, true)?.kind;
        expect(shut, `${String(x)},${String(y)} shut`).not.toBe(DialogueHitKind.Row);
        expect(open, `${String(x)},${String(y)} open`).not.toBe(DialogueHitKind.Row);
        if (shut !== open) changed += 1;
      }
    }
    expect(changed, 'opening the popover changed no answer, so the flag does nothing').toBe(
      box.w * box.h,
    );
  });

  it('draws the reset button only while it is open, and names it in words', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const shut = recorder();
    drawDialogue({ ctx: shut.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    expect(shut.texts.map((t) => t.text)).not.toContain(DIALOGUE_RESET_LABEL);
    const open = recorder();
    drawDialogue({
      ctx: open.ctx,
      sprites: NO_ART,
      rect,
      view: NON_LEAD,
      selected: 0,
      settingsOpen: true,
    });
    expect(open.texts.map((t) => t.text)).toContain(DIALOGUE_RESET_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Clipping — the caselog bug, as two assertions
// ---------------------------------------------------------------------------

describe('nothing is drawn past the column it is measured against', () => {
  it('wraps the spoken line into the text column, not the panel', () => {
    const ctx = measuring();
    const band = realBand(320, false);
    const long = view({ text: 'wednesday '.repeat(60) });
    const rect = dialogueRect(long, 640, band);
    const geometry = dialogueGeometry(long, rect, 0);
    const lines = dialogueLines(ctx, long, geometry);

    // THE COLUMN IS NARROWER THAN THE PANEL BY THE PORTRAIT AND THE GAP, which
    // is the whole of the caselog bug: measuring against `rect.w` passes this
    // suite's arithmetic and hangs the prose over the face.
    expect(geometry.text.w).toBeLessThan(rect.w - PORTRAIT_PX);
    expect(lines).toHaveLength(LINE_ROWS);
    for (const line of lines) {
      expect(ctx.measureText(line).width, line).toBeLessThanOrEqual(geometry.text.w);
    }
    // CLAMPED, AND IT SAYS SO. `wrapClamped` marks the last kept row when it cut.
    expect(lines[LINE_ROWS - 1]?.endsWith('…')).toBe(true);
  });

  it('gives the label a column that excludes the marker and the number', () => {
    const band = realBand(320, false);
    const rect = dialogueRect(NON_LEAD, 640, band);
    for (const row of dialogueGeometry(NON_LEAD, rect, 0).rows) {
      expect(row.label.x).toBeGreaterThan(row.rect.x);
      expect(row.label.x + row.label.w).toBeLessThanOrEqual(row.rect.x + row.rect.w);
      // And the reason sits UNDER the label, at the same indent, on a row of its
      // own — so a sixty-character sentence naming a lead is not ellipsised down
      // to the part that carries no name.
      if (!row.option.enabled) {
        expect(row.reason.h).toBeGreaterThan(0);
        expect(row.reason.x).toBe(row.label.x);
        expect(row.reason.y).toBeGreaterThanOrEqual(row.label.y + OPTION_ROW_H);
        expect(row.reason.y + row.reason.h).toBeLessThanOrEqual(row.rect.y + row.rect.h);
      } else {
        expect(row.reason.h).toBe(0);
      }
    }
  });

  it('every string it actually draws lands inside the window', () => {
    const rec = recorder();
    const band = realBand(320, false);
    const long = view({ text: 'wednesday '.repeat(60) });
    const rect = dialogueRect(long, 640, band);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: long, selected: 0 });
    expect(rec.texts.length).toBeGreaterThan(0);
    for (const written of rec.texts) {
      expect(written.x, written.text).toBeGreaterThanOrEqual(rect.x);
      // Right-aligned strings (the hint, the count) are drawn AT their right
      // edge, so the bound is the same either way: no glyph starts past the box.
      expect(written.x, written.text).toBeLessThanOrEqual(rect.x + rect.w);
      expect(written.y, written.text).toBeGreaterThanOrEqual(rect.y);
      expect(written.y, written.text).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe('a list taller than the band pages rather than overflowing', () => {
  const MANY = view({
    options: Array.from({ length: 20 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
  });

  it('places only whole rows, all inside the window, and counts what it did not', () => {
    const band = realBand(320, true);
    const rect = dialogueRect(MANY, 640, band);
    const geometry = dialogueGeometry(MANY, rect, 0);
    expect(geometry.rows.length).toBeLessThan(MANY.options.length);
    expect(geometry.hidden).toBe(MANY.options.length - geometry.rows.length);
    expect(geometry.count).not.toBeNull();
    for (const row of geometry.rows) {
      expect(row.rect.y).toBeGreaterThanOrEqual(rect.y);
      expect(row.rect.y + row.rect.h).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });

  /**
   * NEVER HALF A ROW, AND THE COUNT LINE IS WHERE THAT IS VISIBLE.
   *
   * MEASURED, because the obvious assertion does not catch it: the rows floor
   * sits an inset ABOVE the panel's own bottom edge, so a row placed by "does it
   * START inside the box" overruns the floor by up to thirteen pixels and still
   * lands inside `rect`. At the 640x320 floor in combat that is a sixth answer
   * drawn from y=193 to y=207 straight through the "1-5 of 20" line at y=197.
   * So the assertion is against the count line, which is the thing it collides
   * with — ui/escapemenu.ts's `place()` states the same rule from its side.
   */
  it('leaves the count line clear, rather than drawing a row through it', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        const rect = dialogueRect(MANY, w, band);
        const geometry = dialogueGeometry(MANY, rect, 0);
        const last = geometry.rows[geometry.rows.length - 1];
        expect(
          geometry.count,
          `${String(w)}x${String(h)} combat=${String(inCombat)}`,
        ).not.toBeNull();
        if (last !== undefined && geometry.count !== null) {
          expect(last.rect.y + last.rect.h).toBeLessThanOrEqual(geometry.count.y);
        }
      }
    }
  });

  it('says how many are showing, in words and a count', () => {
    const rec = recorder();
    const band = realBand(320, true);
    const rect = dialogueRect(MANY, 640, band);
    const geometry = dialogueGeometry(MANY, rect, 0);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: MANY, selected: 0 });
    const shown = geometry.rows.length;
    expect(rec.texts.map((t) => t.text)).toContain(`1-${String(shown)} of 20`);
  });

  it('scrolls the window to keep the selection on screen', () => {
    const band = realBand(320, true);
    const rect = dialogueRect(MANY, 640, band);
    const last = MANY.options.length - 1;
    const geometry = dialogueGeometry(MANY, rect, last);
    expect(geometry.rows.some((row) => row.index === last)).toBe(true);
    expect(geometry.first).toBeGreaterThan(0);
    // And the row at the top of the page is not row 0 any more, which is what
    // makes this a scroll rather than a clamp that happens to include the end.
    expect(geometry.rows[0]?.index).toBe(geometry.first);
  });
});

// ---------------------------------------------------------------------------
// The host rule at the keyboard and the mouse
// ---------------------------------------------------------------------------

describe('a story row a non-lead cannot give', () => {
  it('is shown rather than hidden, and its reason names the lead', () => {
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const drawn = rec.texts.map((t) => t.text);
    expect(drawn).toContain("Put it on the whole party's map.");
    expect(drawn).toContain(STORY_REASON);
    // AND THE PERSONAL ROWS ARE STILL THERE, LIVE. The ruling is that everybody
    // may talk and shop; only the story answer is the lead's.
    expect(drawn).toContain('Put that country on my map.');
  });

  it('cannot be reached by the arrows', () => {
    const greyed = NON_LEAD.options.findIndex((o) => !o.enabled);
    expect(greyed).toBeGreaterThanOrEqual(0);
    // Walk the whole list in both directions, twice round, and never land on it.
    let at = dialogueFirstEnabled(NON_LEAD);
    for (let n = 0; n < NON_LEAD.options.length * 2; n += 1) {
      at = dialogueStep(NON_LEAD, at, 1);
      expect(at).not.toBe(greyed);
    }
    for (let n = 0; n < NON_LEAD.options.length * 2; n += 1) {
      at = dialogueStep(NON_LEAD, at, -1);
      expect(at).not.toBe(greyed);
    }
  });

  it('WRAPS past it rather than stopping at it', () => {
    // `engine/ui/VariableList.lua:108-115` wraps with `util.boundWrap`. The greyed
    // row sits at index 1 in this frame, so a wrap that failed would show up as
    // the selection sticking at either end.
    const seen = new Set<number>();
    let at = dialogueFirstEnabled(NON_LEAD);
    for (let n = 0; n < NON_LEAD.options.length * 2; n += 1) {
      seen.add(at);
      at = dialogueStep(NON_LEAD, at, 1);
    }
    expect([...seen].sort()).toEqual(
      NON_LEAD.options.flatMap((o, i) => (o.enabled ? [i] : [])).sort(),
    );
  });

  it('cannot be fired by its own NUMBER KEY, which is the route round a grey row', () => {
    const greyed = NON_LEAD.options.findIndex((o) => !o.enabled);
    const answer = dialogueAnswerForDigit(geometryOf(NON_LEAD), greyed + 1);
    expect(answer?.kind).toBe(DialogueAnswerKind.Refused);
    expect(answer?.kind === DialogueAnswerKind.Refused ? answer.reason : '').toBe(STORY_REASON);
  });

  it('cannot be fired by a click on it either, and says the same sentence', () => {
    const greyed = NON_LEAD.options.findIndex((o) => !o.enabled);
    const answer = dialogueAnswerAt(NON_LEAD, greyed);
    expect(answer?.kind).toBe(DialogueAnswerKind.Refused);
    expect(answer?.kind === DialogueAnswerKind.Refused ? answer.reason : '').toBe(STORY_REASON);
  });

  it('is fired normally the moment the frame says this viewer may give it', () => {
    // THE LEAD'S COPY OF THE SAME NODE. Nothing about the row changed but
    // `enabled`, which is the server's answer and not a scope comparison done
    // here — a client that derived one from the other would be a second copy of
    // the lead rule.
    const lead = view({
      nodeId: NON_LEAD.nodeId,
      options: NON_LEAD.options.map((o) => ({ ...o, enabled: true, reason: undefined })),
    });
    const at = lead.options.findIndex((o) => o.scope === DialogueScope.Story);
    const answer = dialogueAnswerForDigit(geometryOf(lead), at + 1);
    expect(answer?.kind).toBe(DialogueAnswerKind.Say);
    expect(answer?.kind === DialogueAnswerKind.Say ? answer.optionId : '').toBe('route:party');
  });

  /**
   * AND THE PAINTER READS `enabled` TOO — THE FOURTH DOOR.
   *
   * Three of the four doors are pinned by the cases above (the click, the
   * arrows, the number key). The PAINT was not, and a mutant that decided
   * live-or-greyed with `scope !== 'story'` passed the whole suite while drawing
   * the LEAD's own story row greyed, with a reason line under it, in a window
   * whose number key still fired it. That is the picture telling a host they may
   * not answer their own quest.
   *
   * SO IT IS ASSERTED ON THE LEAD'S COPY, where the two facts disagree: the row
   * is `story` AND `enabled`, and what must be drawn is a LIVE row — no reason
   * line anywhere on the window, and the label in the ink a live row wears.
   */
  it('is drawn live for the lead, however the row is scoped', () => {
    const rec = recorder();
    const lead = view({
      nodeId: NON_LEAD.nodeId,
      options: NON_LEAD.options.map((o) => ({ ...o, enabled: true, reason: undefined })),
    });
    const band = realBand(428, false);
    const rect = dialogueRect(lead, 1262, band);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: lead, selected: 0 });
    expect(rec.texts.map((t) => t.text)).not.toContain(STORY_REASON);
    const story = rec.texts.find((t) => t.text === "Put it on the whole party's map.");
    expect(story?.fill, 'the lead’s own story row was drawn greyed').not.toBe(PALETTE.GREY_HI);
    expect(story?.fill).toBe(PALETTE.BONE);
  });

  /**
   * DIM AND LEGIBLE ARE NOT THE SAME THING, and this row is the one that has to
   * be both. Sampled on the real CaseFile skin, `GREY` label ink measured 1.63:1
   * and the italic reason 1.36:1 — the sentence naming the lead, which is the
   * entire payload of the host ruling, was the least readable text on screen.
   * `GREY_HI` is 4.93:1 and still plainly below the BONE of a live row.
   */
  it('is drawn in an ink a player can actually read', () => {
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const label = rec.texts.find((t) => t.text === "Put it on the whole party's map.");
    const reason = rec.texts.find((t) => t.text === STORY_REASON);
    expect(label?.fill).toBe(PALETTE.GREY_HI);
    expect(reason?.fill).toBe(PALETTE.GREY_HI);
    // AND THE REASON IS STILL THE MARGIN'S ITALIC, which is what separates a
    // narration about a row from the label on it now that both are one ink.
    expect(reason?.font).toContain('italic');
    // A LIVE ROW IS STILL BRIGHTER. "Not through you" has to survive the fix.
    expect(rec.texts.find((t) => t.text === 'Put that country on my map.')?.fill).not.toBe(
      PALETTE.GREY_HI,
    );
  });
});

describe('the digits are bounded by the rows that were placed', () => {
  it('finds nothing past the end of a short list', () => {
    const three = view();
    expect(three.options).toHaveLength(3);
    expect(dialogueAnswerForDigit(geometryOf(three), 9)).toBeNull();
    expect(dialogueAnswerForDigit(geometryOf(three), 4)).toBeNull();
  });

  it('says the last row of a short list', () => {
    const three = view();
    const answer = dialogueAnswerForDigit(geometryOf(three), 3);
    expect(answer?.kind).toBe(DialogueAnswerKind.Say);
    expect(answer?.kind === DialogueAnswerKind.Say ? answer.optionId : '').toBe('leave');
  });

  it('refuses a zero and a negative rather than reading backwards off the list', () => {
    expect(dialogueAnswerForDigit(geometryOf(view()), 0)).toBeNull();
    expect(dialogueAnswerForDigit(geometryOf(view()), -1)).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A KEY CANNOT ANSWER A ROW THAT WAS NEVER DRAWN. THIS IS A REGRESSION CASE.
   * ═══════════════════════════════════════════════════════════════════════════
   * Measured on the shipped build before the fix: 640x320 in combat, a twenty
   * answer node, TWO rows placed — and digit 9 answered `Say` for `o8`, an
   * option nobody had read. For a party lead every row is enabled, so the same
   * press on a real node is a STORY answer given to a question the player never
   * saw. The digits are bounded by the placement, not by the list.
   */
  it('answers nothing for a digit whose row did not fit on the band', () => {
    const many = view({
      options: Array.from({ length: 20 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
    });
    const geometry = geometryOf(many, 640, 320, true);
    expect(geometry.rows.length, 'this band was expected to page').toBeLessThan(9);
    for (let digit = 1; digit <= 9; digit += 1) {
      const drawn = geometry.rows.some((row) => row.digit === digit);
      expect(dialogueAnswerForDigit(geometry, digit) === null, `digit ${String(digit)}`).toBe(
        !drawn,
      );
    }
  });

  /**
   * AND ON A SCROLLED PAGE THE KEY FOLLOWS THE BRACKET. The digit a row wears is
   * its index in the whole list, so a page that starts at row 12 is answered by
   * the keys 13 and up — which past `MAX_DIGIT` means no key at all, and the
   * hint says so rather than offering `1-9`.
   */
  it('follows the brackets when the list has scrolled under the selection', () => {
    const many = view({
      options: Array.from({ length: 20 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
    });
    // A PAGE THAT STARTS PART-WAY DOWN AND STILL CARRIES KEYS. This is where a
    // digit that counted ROWS instead of reading the bracket answers the wrong
    // option: on this page the first row wears `[5]`, not `[1]`.
    const geometry = geometryOf(many, 640, 320, true, 5);
    expect(geometry.first).toBeGreaterThan(0);
    const drawn = geometry.rows.flatMap((row) => (row.digit === null ? [] : [row]));
    expect(drawn.length, 'this page was expected to carry digits').toBeGreaterThan(0);
    for (const row of drawn) {
      expect(row.digit).toBe(row.index + 1);
      const byKey = dialogueAnswerForDigit(geometry, row.digit ?? 0);
      expect(byKey?.kind === DialogueAnswerKind.Say ? byKey.optionId : '').toBe(row.option.id);
    }
    // AND EVERY OTHER KEY ON THIS PAGE DOES NOTHING — including the low digits,
    // which have scrolled off the top and belong to nobody now.
    for (let digit = 1; digit <= 9; digit += 1) {
      if (drawn.some((row) => row.digit === digit)) continue;
      expect(dialogueAnswerForDigit(geometry, digit), `digit ${String(digit)}`).toBeNull();
    }

    // AND A PAGE PAST THE NINTH ROW CARRIES NO KEYS AT ALL.
    const far = geometryOf(many, 640, 320, true, 19);
    expect(far.rows.every((row) => row.digit === null)).toBe(true);
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(
        dialogueAnswerForDigit(far, digit),
        `digit ${String(digit)} past the ninth`,
      ).toBeNull();
    }
  });

  /**
   * A ROW WITH NO BRACKET CANNOT BE FIRED BY A NUMBER, AND ONE WITH A BRACKET CAN.
   *
   * THE PAIRING IS THE INVARIANT, not either half. The bound on the digits and
   * the bound on the drawn `[n]` are the same fact — `MAX_DIGIT` — and the bug
   * worth guarding is the two of them disagreeing, which draws a row with no
   * shortcut that a key fires anyway, or a row wearing a bracket that does
   * nothing.
   *
   * IT IS A CONTRACT TEST AND SAYS SO: `input/keys.ts` binds Digit1-Digit8
   * today, so `onSlot` cannot deliver a tenth digit and no player can reach the
   * disagreement by pressing anything. That is exactly why it is asserted on the
   * function rather than left to be noticed — the day the keymap grows a ninth
   * or tenth slot, this stays true instead of quietly becoming false.
   */
  it('pairs the drawn bracket with the key that fires it, row for row', () => {
    const many = view({
      options: Array.from({ length: 12 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
    });
    const geometry = geometryOf(many);
    for (const row of geometry.rows) {
      const byKey = dialogueAnswerForDigit(geometry, row.index + 1);
      expect(byKey === null, `row ${String(row.index)}`).toBe(row.digit === null);
    }
    // AND THE FIRST ROW PAST THE LAST DIGIT IS THE ONE THAT MUST REFUSE.
    expect(dialogueAnswerForDigit(geometry, 10)).toBeNull();
    expect(dialogueAnswerForDigit(geometry, 9)?.kind).toBe(DialogueAnswerKind.Say);
  });

  it('draws no bracket past the ninth row, because there is no tenth digit key', () => {
    const band = realBand(428, false);
    const many = view({
      options: Array.from({ length: 12 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
    });
    const rect = dialogueRect(many, 1262, band);
    for (const row of dialogueGeometry(many, rect, 0).rows) {
      expect(row.digit, `row ${String(row.index)}`).toBe(row.index < 9 ? row.index + 1 : null);
    }
  });
});

// ---------------------------------------------------------------------------
// The strip of keys, and where the selection starts
// ---------------------------------------------------------------------------

describe('the printed key hint is gone, and every key it named still answers', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THESE THREE REPLACE THE `dialogueHint` SUITE. READ THIS BEFORE DELETING THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for as *"remove the 1-5 pick, arrows move, enter answer and esc
   * leave"*. `dialogueHint` is deleted and so are the three tests that asserted
   * its text — but those tests were carrying a rule underneath the wording, and
   * the rule is NOT deleted with them.
   *
   * THE RULE: the `[n]` a player can SEE and the key that fires it are the same
   * fact, and both are bounded by the rows that were PLACED rather than by the
   * answer list. The measured bug was a twenty-answer node on the 640x320 floor
   * in combat placing TWO rows while digit 9 answered `Say` for an option nobody
   * had read — a STORY answer sent off a keypress against a row never drawn.
   * `dialogueAnswerForDigit` resolves through `DialogueGeometry.rows` because of
   * it, and the suite above ("the digits are bounded by the rows that were
   * placed") is that rule's home. What follows is what the HINT's two tests were
   * separately holding: the paged case, asserted against the keys rather than
   * against a sentence about them.
   */
  const MANY = view({
    options: Array.from({ length: 20 }, (_, i) => option(`o${String(i)}`, `answer ${String(i)}`)),
  });

  it('no longer prints a word about picks, arrows, Enter or Escape', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const band = realBand(h, inCombat);
        for (const v of [view(), NON_LEAD, MANY]) {
          const rect = dialogueRect(v, w, band);
          const rec = recorder();
          drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: v, selected: 0 });
          const drawn = rec.texts.map((t) => t.text).join('\n');
          for (const word of ['pick', 'arrows', 'Enter', 'Esc']) {
            expect(drawn, `${String(w)}x${String(h)} still prints "${word}"`).not.toContain(word);
          }
        }
      }
    }
  });

  /**
   * THE HALF THE HINT WAS THE VISIBLE END OF: on a page that shows two of twenty
   * answers, exactly the two brackets on the screen answer a key, and every
   * other digit answers nothing. This is the same claim the deleted test made
   * about the printed range — made against the keys themselves, which is where
   * it has teeth.
   */
  it('fires exactly the digits that are drawn on the page, and no others', () => {
    const paged = geometryOf(MANY, 640, 320, true);
    const digits = paged.rows.flatMap((row) => (row.digit === null ? [] : [row.digit]));
    expect(digits.length).toBeGreaterThan(0);
    expect(digits.length).toBeLessThan(9);
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(dialogueAnswerForDigit(paged, digit) === null, `digit ${String(digit)}`).toBe(
        !digits.includes(digit),
      );
    }
    // A PAGE PAST THE NINTH ROW HAS NO KEYS AT ALL — the case the deleted test
    // covered by asserting the hint had no `pick` clause.
    const far = geometryOf(MANY, 640, 320, true, 19);
    expect(far.rows.every((row) => row.digit === null)).toBe(true);
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(dialogueAnswerForDigit(far, digit), `digit ${String(digit)} off the page`).toBeNull();
    }
  });

  /**
   * AND THE ONE CONTROL THAT REPLACED THE SENTENCE IS REALLY ON THE STRIP —
   * paired with the hit test the way the hint used to be paired with the drawn
   * brackets, because a control nobody paints is a control nobody can press.
   */
  it('draws the cogwheel on the header strip, where the hit test says it is', () => {
    /**
     * ═══ TWO ONE-LINE MUTANTS SURVIVED THE WHOLE SUITE ON THIS CONTROL ═══
     * Deleting `drawCog(ctx, geometry.cog, settingsOpen)` — the cog never
     * painted — and `dialogueSettingsOpen = !dialogueSettingsOpen` changed to
     * `= false` — the cog never opening anything. Together, item 4's settings
     * control is a button nobody can see that does nothing, with 6495 tests
     * green. Every cog test read `dialogueGeometry().cog` or
     * `dialogueSettingsRect()`, both pure, so the entire popover suite passed on
     * a window where the popover could never be opened.
     *
     * THIS IS THE ×'S PAIRING, GIVEN TO THE COG: found in the paint at the rect
     * the hit test answers on, and then fed back through the hit test. The
     * wiring half — that the press flips the flag — is in hudwiring.test.ts,
     * because that half lives in main.ts.
     */
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const { cog } = dialogueGeometry(NON_LEAD, rect, 0);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const cx = cog.x + cog.w / 2;
    const cy = cog.y + cog.h / 2;
    const body = rec.arcs.find((a) => a.x === cx && a.y === cy);
    expect(body, 'the cogwheel was never drawn').toBeDefined();
    // ...AND IT IS A GEAR RATHER THAN A DOT: `drawCog` traces the body and then
    // punches the bore out of it, so there are at least two arcs on that centre.
    expect(rec.arcs.filter((a) => a.x === cx && a.y === cy).length).toBeGreaterThanOrEqual(2);
    expect(dialogueHitAt(NON_LEAD, rect, 0, cx, cy, false)?.kind).toBe(DialogueHitKind.Cog);
  });

  it('centres both header controls in the strip, at the same height', () => {
    /**
     * A SURVIVOR: `y: rect.y + Math.floor((HEADER_H - CLOSE_PX) / 2)` changed to
     * `rect.y` passed everything. The placement tests bound the controls INSIDE
     * the strip and every other assertion reads the same geometry back, so a
     * control pinned to the top of the header was invisible to the suite. It is
     * the one axis of *"a single (X) button at the top right"* nothing held.
     */
    for (const [w, h, combat] of [
      [640, 320, false],
      [640, 320, true],
      [1262, 428, false],
      [1920, 1080, false],
    ] as const) {
      const rect = dialogueRect(NON_LEAD, w, realBand(h, combat));
      const { close, cog } = dialogueGeometry(NON_LEAD, rect, 0);
      expect(close.y, `${String(w)}x${String(h)}: the two controls are at different heights`).toBe(
        cog.y,
      );
      // CENTRED, not merely inside: the air above equals the air below, give or
      // take the odd pixel `Math.floor` leaves at the bottom.
      const above = close.y - rect.y;
      const below = rect.y + HEADER_H - (close.y + close.h);
      expect(
        Math.abs(above - below),
        'the controls are not centred in the strip',
      ).toBeLessThanOrEqual(1);
      expect(above).toBeGreaterThan(0);
    }
  });

  it('keeps a long speaker name clear of the two header controls', () => {
    /**
     * ═══ A SURVIVOR: `HEADER_CONTROLS_W` SET TO 0 PASSED THE WHOLE SUITE ═══
     * That constant is the only thing stopping a long `speakerName` being drawn
     * straight under the × and the cogwheel, and it REPLACED the hint strip's
     * previously measured width — a measured number swapped for an unmeasured
     * one. Driven here against the painter rather than against the constant:
     * the drawn title is measured at the face it is drawn in and has to end
     * before the cogwheel begins.
     */
    const longName = view({
      // LONG ENOUGH THAT IT MUST BE CLIPPED at every viewport this client
      // renders: the window is a fixed 516 wide, which is 79 characters of the
      // 10px monospace once both controls have taken their 32.
      speakerName:
        'Merrow Stitch of the Nine Wells, Her Attendant and the Second Clerk of the Lower Registry',
    });
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const rec = recorder();
        const rect = dialogueRect(longName, w, realBand(h, inCombat));
        const { cog } = dialogueGeometry(longName, rect, 0);
        drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: longName, selected: 0 });
        const where = `${String(w)}x${String(h)} combat=${String(inCombat)}`;
        const title = rec.texts.find((t) => t.text.startsWith('Merrow'));
        expect(title, `${where}: the speaker was never drawn`).toBeDefined();
        // SIX PIXELS A CHARACTER, which is what this file's recorder measures
        // and what the 10px monospace actually advances.
        const right = (title?.x ?? 0) + (title?.text.length ?? 0) * 6;
        expect(right, `${where}: the name was drawn under the controls`).toBeLessThanOrEqual(cog.x);
        // ...AND IT WAS CLIPPED RATHER THAN DROPPED: something is still said.
        expect(title?.text.length ?? 0).toBeGreaterThan(3);
      }
    }
  });

  it('draws the close × on the header strip, where the hit test says it is', () => {
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const { close } = dialogueGeometry(NON_LEAD, rect, 0);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const glyph = rec.texts.find((t) => t.text === '×');
    expect(glyph, 'the close control was never drawn').toBeDefined();
    // `drawButton` centres its label, so the glyph lands in the middle of the
    // rect the hit test answers on — which is the pairing being asserted.
    expect(glyph?.x).toBe(close.x + close.w / 2);
    expect(glyph?.y).toBe(close.y + close.h / 2);
    expect(dialogueHitAt(NON_LEAD, rect, 0, glyph?.x ?? 0, glyph?.y ?? 0, false)?.kind).toBe(
      DialogueHitKind.Close,
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A WINDOW NEVER OPENS WITH THE SELECTION ON A ROW THIS PLAYER CANNOT GIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   * The fixture is the one that matters and was missing: a frame whose FIRST row
   * is the greyed story row. Against a frame that starts with a live row, "the
   * first enabled row" and "row 0" are the same number, and a `dialogueFirstEnabled`
   * that simply answered 0 passed the whole suite.
   */
  it('opens the selection on the first row that can be given, not on row 0', () => {
    const storyFirst = view({
      nodeId: 'topic:rumour',
      options: [
        storyRow('route:party', "Put it on the whole party's map."),
        option('route:self', 'Put that country on my map.'),
        option('leave', 'Nothing for now.'),
      ],
    });
    const at = dialogueFirstEnabled(storyFirst);
    expect(at).toBe(1);
    expect(dialogueAnswerAt(storyFirst, at)?.kind).toBe(DialogueAnswerKind.Say);
  });

  /**
   * THE HOVER IS A SHAPE. ui/escapemenu.ts:2124-2126 — *"A row that is only
   * brighter is a row a player with the contrast turned down cannot find."* The
   * window shipped with BONE -> PARCHMENT and nothing else, which at 1:1 is
   * barely perceptible; the bar in the marker column is the second signal.
   */
  it('marks a hovered row with a shape and not only with a brighter ink', () => {
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const geometry = dialogueGeometry(NON_LEAD, rect, 0);
    const hovered = geometry.rows.find((row) => row.option.enabled && row.index !== 0);
    if (hovered === undefined) throw new Error('no second live row to hover');
    const plain = recorder();
    drawDialogue({ ctx: plain.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const rec = recorder();
    drawDialogue({
      ctx: rec.ctx,
      sprites: NO_ART,
      rect,
      view: NON_LEAD,
      selected: 0,
      hovered: hovered.index,
    });
    // IN THE MARKER COLUMN OF THAT ROW, which is empty on any row that is not
    // the selected one — so the bar and the `▸` can never collide.
    const inMarkerColumn = (box: Filled): boolean =>
      box.x === hovered.rect.x &&
      box.y >= hovered.rect.y &&
      box.y + box.h <= hovered.rect.y + OPTION_ROW_H &&
      box.w > 0 &&
      box.w <= MARK_COLUMN_MAX;
    expect(rec.rects.filter(inMarkerColumn), 'a hovered row has no mark of its own').toHaveLength(
      1,
    );
    // AND THE SAME WINDOW WITHOUT THE HOVER DRAWS NOTHING THERE, so the mark is
    // the hover and not some part of the chrome that happens to sit under it.
    expect(plain.rects.filter(inMarkerColumn)).toHaveLength(0);
  });

  /**
   * THE RULE BETWEEN THE LINE AND THE LIST IS VISIBLE — `engine/dialogs/Chat.lua:55`.
   * It was SLATE on the CaseFile skin, sampled at 1.09:1: a separator that is
   * not there is a port of `:55` in name only.
   */
  it('rules a separator that can actually be seen', () => {
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    const geometry = dialogueGeometry(NON_LEAD, rect, 0);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: NON_LEAD, selected: 0 });
    const rule = rec.rects.find((box) => box.y === geometry.separatorY && box.h === 1);
    expect(rule, 'the separator was never drawn').toBeDefined();
    expect(rule?.fill).not.toBe(PALETTE.SLATE);
    expect(rule?.fill).toBe(PALETTE.GREY);
  });
});

/** The marker column is one glyph wide; a hover mark must live inside it. */
const MARK_COLUMN_MAX = 6;

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

describe('the portrait falls back one step at a time and never throws', () => {
  it('takes the 64x64 portrait when there is one', () => {
    const sprites = sourceOf({
      chr_portrait_merrow_stitch: [PORTRAIT_PX, PORTRAIT_PX],
      chr_npc_merrow_stitch_s: [48, 64],
      [PORTRAIT_UNKNOWN]: [PORTRAIT_PX, PORTRAIT_PX],
    });
    expect(dialoguePortraitSource(view(), sprites)).toBe(PortraitSource.Portrait);
  });

  it('falls to the speaker’s own 48x64 body when the portrait is not installed', () => {
    const sprites = sourceOf({
      chr_npc_merrow_stitch_s: [48, 64],
      [PORTRAIT_UNKNOWN]: [PORTRAIT_PX, PORTRAIT_PX],
    });
    expect(dialoguePortraitSource(view(), sprites)).toBe(PortraitSource.Sprite);
    // AND WHEN THE FRAME NAMES NO PORTRAIT AT ALL, which the wire allows.
    expect(dialoguePortraitSource(view({ portrait: undefined }), sprites)).toBe(
      PortraitSource.Sprite,
    );
  });

  it('falls to the generic face when there is neither', () => {
    const sprites = sourceOf({ [PORTRAIT_UNKNOWN]: [PORTRAIT_PX, PORTRAIT_PX] });
    expect(dialoguePortraitSource(view(), sprites)).toBe(PortraitSource.Unknown);
  });

  it('falls to initials on a bare clone, and draws them', () => {
    expect(dialoguePortraitSource(view(), NO_ART)).toBe(PortraitSource.Initials);
    const rec = recorder();
    const band = realBand(428, false);
    const rect = dialogueRect(view(), 1262, band);
    drawDialogue({ ctx: rec.ctx, sprites: NO_ART, rect, view: view(), selected: 0 });
    expect(rec.texts.map((t) => t.text)).toContain('MS');
    expect(rec.blits).toEqual([]);
  });

  it('refuses a portrait that is not the authored size rather than squashing it', () => {
    // `blitReduced` only divides by whole factors, and this asks it for d=1. A
    // 96x96 face is refused and the body is drawn instead, which is a worse
    // picture and an honest one — panel.ts records the three surfaces that
    // cropped instead and shipped a nose.
    const sprites = sourceOf({
      chr_portrait_merrow_stitch: [96, 96],
      chr_npc_merrow_stitch_s: [48, 64],
    });
    expect(dialoguePortraitSource(view(), sprites)).toBe(PortraitSource.Sprite);
  });

  it('takes two letters off a name and never comes back empty', () => {
    expect(dialogueInitials('Merrow Stitch')).toBe('MS');
    expect(dialogueInitials('Reeve')).toBe('R');
    expect(dialogueInitials('   ')).toBe('?');
  });
});

// ---------------------------------------------------------------------------
// The context is left as it was found
// ---------------------------------------------------------------------------

describe('drawDialogue leaks no context state', () => {
  it('restores font, fill, alignment, baseline and alpha', () => {
    const rec = recorder();
    const before = rec.style();
    const band = realBand(428, false);
    const rect = dialogueRect(NON_LEAD, 1262, band);
    drawDialogue({
      ctx: rec.ctx,
      sprites: sourceOf({ chr_npc_merrow_stitch_s: [48, 64] }),
      rect,
      view: NON_LEAD,
      selected: 0,
      hovered: 2,
    });
    expect(rec.texts.length).toBeGreaterThan(0);
    expect(rec.style()).toEqual(before);
  });

  it('draws nothing at all into a box with no width or height', () => {
    const rec = recorder();
    drawDialogue({
      ctx: rec.ctx,
      sprites: NO_ART,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      view: view(),
      selected: 0,
    });
    expect(rec.texts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The window moves, and Reset puts it back
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WINDOW AGAINST THE DRAG PRIMITIVES, IN ITS OWN BAND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ui/drag.ts's suite proves `moveIntoBand`, `nextOffset` and `settleOffset` are
 * right about rectangles in general. What it cannot see is whether THIS rect —
 * which is centred, floored to the band and as tall as its answer list makes it
 * — survives them: a window whose height is a function of its content is the one
 * shape a clamp written for fixed-size panels can surprise.
 *
 * `test/client/hudwiring.test.ts` pins that main.ts really calls these; this
 * pins that the answers are the ones a player would accept.
 */
describe('the conversation window moves like every other panel', () => {
  const band = realBand(428, false);
  const width = 1262;
  const unmoved = dialogueRect(NON_LEAD, width, band);

  it('follows the pointer, and a gesture composes from the grab rather than per frame', () => {
    // 40 right and 60 up from a grab at (500, 300) — the offset is a function of
    // the TOTAL travel, so a dropped frame cannot make it drift.
    const raw = nextOffset(NO_OFFSET, 500, 300, 540, 240);
    expect(raw).toEqual({ dx: 40, dy: -60 });
    expect(moveIntoBand(unmoved, raw, band, width)).toEqual({
      x: unmoved.x + 40,
      y: unmoved.y - 60,
      w: unmoved.w,
      h: unmoved.h,
    });
  });

  it('never comes to rest over the hotbar, the strips or off the top of the screen', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const own = realBand(h, inCombat);
        const rect = dialogueRect(NON_LEAD, w, own);
        for (const raw of [
          { dx: 4000, dy: 4000 },
          { dx: -4000, dy: -4000 },
          { dx: 0, dy: 4000 },
          { dx: 4000, dy: -4000 },
        ]) {
          const placed = moveIntoBand(rect, raw, own, w);
          const where = `${String(w)}x${String(h)} ${String(raw.dx)},${String(raw.dy)}`;
          expect(placed.y, where).toBeGreaterThanOrEqual(own.top);
          expect(placed.y + placed.h, where).toBeLessThanOrEqual(own.bottom);
          expect(placed.x, where).toBeGreaterThanOrEqual(0);
          expect(placed.x + placed.w, where).toBeLessThanOrEqual(w);
          // A MOVE MAY NEVER RESIZE — `moveIntoBand`'s own rule, asserted on the
          // one panel whose height is a function of its content.
          expect(placed.w, where).toBe(rect.w);
          expect(placed.h, where).toBe(rect.h);
        }
      }
    }
  });

  /**
   * ═══ RESET IS `NO_OFFSET`, AND THAT HAS TO BE THE COMPUTED DEFAULT ═══
   * The cogwheel's one button writes `NO_OFFSET` into the store. If applying
   * that to a freshly computed rect were not the identity, "Reset position"
   * would move the window somewhere the player had never put it — which is the
   * failure that reads as the button being broken rather than absent.
   */
  it('puts the window back exactly where the layout would have drawn it', () => {
    for (const [w, h] of VIEWPORTS) {
      for (const inCombat of [false, true]) {
        const own = realBand(h, inCombat);
        for (const v of [view(), NON_LEAD]) {
          const rect = dialogueRect(v, w, own);
          expect(moveIntoBand(rect, NO_OFFSET, own, w), `${String(w)}x${String(h)}`).toEqual(rect);
        }
      }
    }
  });

  /**
   * AND THE SETTLE RECORDS WHAT THE CLAMP HONOURED, not what the pointer
   * reached. ui/drag.ts records the shipped bug: a raw offset left in the store
   * banked hundreds of pixels of dead travel, and four consecutive full-height
   * drags then moved the panel nothing at all.
   */
  it('settles to an offset the band was willing to draw, and settling again is a no-op', () => {
    const raw = { dx: 4000, dy: -4000 };
    const settled = settleOffset(unmoved, raw, band, width);
    expect(settled).not.toEqual(raw);
    expect(moveIntoBand(unmoved, settled, band, width)).toEqual(
      moveIntoBand(unmoved, raw, band, width),
    );
    expect(settleOffset(unmoved, settled, band, width)).toEqual(settled);
  });
});
