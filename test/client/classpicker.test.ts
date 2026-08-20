/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import {
  ClassPickerHitKind,
  classPickerCards,
  classPickerHitAt,
  classPickerRect,
  drawClassPicker,
  talentShorthand,
} from '../../src/client/ui/classpicker.ts';
import { ResourceKind, TalentShape } from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { ClassOptionView, LoadoutTalent } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLASS CHOOSER, READ THE WAY A CLICK READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * test here, and nothing below paints anything. What is tested is the layer
 * where a bug on this screen is IRREVERSIBLE:
 *
 *   THE ORDER      `ClassOptionsMsg.options` is authored order and protocol.ts
 *                  asks for it to be respected because "a card that moves
 *                  between two frames is a card somebody misclicks, and this one
 *                  is irreversible". The class is written to a file; there is no
 *                  second chance and no re-picker.
 *   THE HIT TEST   the painter, the keyboard and the pointer read ONE geometry
 *                  function, so card 2 cannot be drawn where card 3 is pressed.
 *   THE CONFIRM    it answers a click even with nothing selected, so a
 *                  disabled-looking button SWALLOWS its press rather than
 *                  letting it fall through to the map underneath.
 *
 * The hit tests SCAN a row or a column of points rather than asserting
 * coordinates, for the reason test/client/partypanel.test.ts:56-61 gives: an
 * assertion that card 2 starts at x=204 would pass while it was drawn at x=202,
 * because it would be testing the test's own copy of the arithmetic.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function talent(id: string, name: string): LoadoutTalent {
  return {
    id,
    name,
    icon: `icon_active_${id}`,
    cost: { ap: 5, mp: 0, resource: 10 },
    cooldownTurns: 3,
    range: 4,
    minRange: 0,
    shape: TalentShape.Single,
    radius: 0,
    // BIRTH RANK, because that is what a picker shows: `loadoutViewFor` has no
    // actor to read a level from and passes 1 explicitly — an unlearned class is
    // previewed at the level you would get if you took it.
    level: 1,
    maxLevel: TALENT_MAX_LEVEL,
    desc: `${name} does something.`,
    descNext: `${name} does something slightly better.`,
  };
}

function option(id: string, name: string, over: Partial<ClassOptionView> = {}): ClassOptionView {
  return {
    id,
    name,
    description: 'Holds the line so nobody behind it has to. Two sentences, and no more than two.',
    sprite: `chr_player_${id}_s`,
    portrait: `icon_character_the_${id}`,
    maxHp: 68,
    resource: { kind: ResourceKind.Resolve, current: 0, max: 100, discrete: false },
    talents: [
      talent('a', 'Ward Rush'),
      talent('b', 'Iron Curtain'),
      talent('c', 'Hold'),
      talent('d', 'Cite'),
    ],
    ...over,
  };
}

/**
 * THREE OPTIONS WHOSE AUTHORED ORDER IS THE OPPOSITE OF EVERY ORDER A CLIENT
 * MIGHT BE TEMPTED TO IMPOSE: reverse-alphabetical by name AND by id, and
 * descending by hp. Any sort at all reorders this list, so the assertion below
 * cannot pass by accident.
 */
const OPTIONS: readonly ClassOptionView[] = [
  option('zeta', 'The Zealot', { maxHp: 90 }),
  option('mid', 'The Middler', { maxHp: 70 }),
  option('alpha', 'The Alchemist', { maxHp: 50 }),
];

// ---------------------------------------------------------------------------
// The modal's box
// ---------------------------------------------------------------------------

describe('classPickerRect', () => {
  it('is centred in the viewport and never runs off it', () => {
    const rect = classPickerRect(640, 400);
    expect(rect.x).toBe(Math.floor((640 - rect.w) / 2));
    expect(rect.y).toBe(Math.floor((400 - rect.h) / 2));
    expect(rect.x + rect.w).toBeLessThanOrEqual(640);
    expect(rect.y + rect.h).toBeLessThanOrEqual(400);
  });

  it('shrinks rather than disappearing, because a player owing a choice is stuck', () => {
    // Every dock panel in this client has a "not now" answer. This one must
    // not: no modal means a map that cannot be moved on and nothing on screen
    // saying why.
    const rect = classPickerRect(320, 200);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(320);
    expect(rect.y + rect.h).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// THE ORDER — the one that cannot be undone
// ---------------------------------------------------------------------------

describe('classPickerCards', () => {
  const rect = classPickerRect(640, 400);

  it('lays the cards out in the SERVER’S order, left to right, never sorted', () => {
    const cards = classPickerCards(OPTIONS, rect);
    expect(cards).toHaveLength(3);
    // Strictly increasing x: card i is left of card i+1, so index i really is
    // the i-th option and not the i-th of some re-ranked list.
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i]?.x ?? 0).toBeGreaterThan(cards[i - 1]?.x ?? 0);
    }
    // ...and the hit test agrees, which is the half that actually decides who
    // the player becomes.
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      if (card === undefined) throw new Error('unreachable');
      expect(classPickerHitAt(OPTIONS, rect, card.x + Math.floor(card.w / 2), card.y + 4)).toEqual({
        kind: ClassPickerHitKind.Card,
        index: i,
      });
    }
  });

  it('keeps every card inside the modal, in one fixed row that never wraps', () => {
    const cards = classPickerCards(OPTIONS, rect);
    for (const card of cards) {
      expect(card.x).toBeGreaterThanOrEqual(rect.x);
      expect(card.x + card.w).toBeLessThanOrEqual(rect.x + rect.w);
      expect(card.y).toBeGreaterThanOrEqual(rect.y);
      expect(card.y + card.h).toBeLessThanOrEqual(rect.y + rect.h);
    }
    // ONE ROW: every card shares a top edge. A wrapped row would put card 3
    // under card 1, which is the "card that moved" protocol.ts refuses.
    expect(new Set(cards.map((card) => card.y)).size).toBe(1);
  });

  it('answers an empty list with no cards rather than a divide by zero', () => {
    expect(classPickerCards([], rect)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

describe('classPickerHitAt', () => {
  const rect = classPickerRect(640, 400);

  it('hands back ascending indices as the pointer crosses the row', () => {
    // A SCAN across the whole panel at the cards' own height, describing what
    // was found rather than asserting where it starts.
    const cards = classPickerCards(OPTIONS, rect);
    const y = (cards[0]?.y ?? 0) + 4;
    const seen: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const hit = classPickerHitAt(OPTIONS, rect, x, y);
      if (hit?.kind !== ClassPickerHitKind.Card) continue;
      if (seen[seen.length - 1] !== hit.index) seen.push(hit.index);
    }
    // Each index appears in exactly one contiguous run, in order. A repeat
    // would mean two cards interleaved; a gap would mean one is unreachable.
    expect(seen).toEqual([0, 1, 2]);
  });

  it('answers CONFIRM even when nothing is selected, so the click is swallowed', () => {
    // The signature takes no `selected` at all, deliberately: a disabled-looking
    // button that let its click through would land on the tile behind the modal.
    // ui/contextmenu.ts:282-287 states the same rule for a disabled row.
    const column = rect.x + Math.floor(rect.w / 2);
    const hits: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      if (classPickerHitAt(OPTIONS, rect, column, y)?.kind === ClassPickerHitKind.Confirm) {
        hits.push(y);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    // Below the cards — the button is the last thing on the panel, as it is in
    // every dialog anybody has used.
    const cards = classPickerCards(OPTIONS, rect);
    expect(hits[0] ?? 0).toBeGreaterThan((cards[0]?.y ?? 0) + (cards[0]?.h ?? 0) - 1);
    expect(hits[hits.length - 1] ?? 0).toBeLessThan(rect.y + rect.h);
  });

  it('answers null off the panel, which the caller still swallows', () => {
    expect(classPickerHitAt(OPTIONS, rect, rect.x - 5, rect.y - 5)).toBeNull();
    // ...and null inside the panel between two cards: "on the modal, but not on
    // a control" is not the same as "fall through to the map".
    expect(classPickerHitAt(OPTIONS, rect, rect.x + 1, rect.y + 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One paint, to prove the drawer is wired to the geometry it advertises
// ---------------------------------------------------------------------------

describe('drawing', () => {
  function recorder(clips: { x: number; y: number; w: number; h: number }[], calls: string[]) {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          // The scrim is sized from the backbuffer, which IS the logical
          // viewport (render/canvas.ts:581-584).
          if (prop === 'canvas') return { width: 640, height: 400 };
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  it('paints without touching anything outside its own rect', () => {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const rect = classPickerRect(640, 400);

    drawClassPicker({
      ctx: recorder(clips, calls),
      // No art at all — which is the honest state of the ability icons today,
      // since `icon_active_*` is in no manifest. Every missing-art fallback
      // path on every card runs here.
      sprites: { sprite: () => undefined },
      rect,
      options: OPTIONS,
      selected: 1,
      hovered: 2,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(clips[0]).toEqual({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    // Every save is paired. The scrim sets `globalAlpha`, and an unbalanced
    // restore leaks it to every painter later in the frame — it presents as
    // translucent sprites across the whole screen and gets diagnosed as a
    // broken PNG (ui/turncards.ts:786-790 records the same trap for `filter`).
    expect(calls.filter((c) => c.startsWith('save(')).length).toBe(
      calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('paints the confirm button with nothing selected, rather than hiding it', () => {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    drawClassPicker({
      ctx: recorder(clips, calls),
      sprites: { sprite: () => undefined },
      rect: classPickerRect(640, 400),
      options: OPTIONS,
      selected: null,
      hovered: null,
    });
    // It cannot be asserted by colour here, so it is asserted by presence: the
    // unselected pass still draws text and rects, and still clips to the panel.
    expect(calls.some((c) => c.startsWith('fillText('))).toBe(true);
    expect(clips.length).toBeGreaterThan(0);
  });
});

describe('what a talent is, in the width a card has', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FIRST DECISION IN THE GAME HAD THE LEAST INFORMATION BEHIND IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The picker drew four talent NAMES per class while the frame it was drawing
   * from already carried `cost`, `range`, `minRange` and `cooldownTurns` for
   * every one. "Iron Curtain" and "Fog Step" are good names and they are not
   * information — a player picking a character for an evening could not tell a
   * melee talent from a ranged one.
   *
   * THE NUMBERS BELOW ARE THE REAL ONES, read off a live `class_options` frame
   * rather than invented, which is the only reason this test is worth anything:
   * a first version of `talentShorthand` tested `range <= 1` and printed
   * "1.5 tiles" on every Watchman talent, and called Mend Wounds — a heal for
   * every ally within two tiles — "melee".
   */
  const shaped = (over: Partial<LoadoutTalent>): LoadoutTalent => ({
    ...talent('t', 'T'),
    ...over,
  });

  it('calls the diagonal-inclusive adjacency melee, not "1.5 tiles"', () => {
    // Crude Blow, Ward Rush, Iron Curtain and Lockdown are all range 1.5.
    expect(
      talentShorthand(shaped({ range: 1.5, minRange: 0, cost: { ap: 3, mp: 0, resource: 0 } })),
    ).toBe('3 AP · melee');
  });

  it('shows the dead zone as a band, because it is the thing to know', () => {
    /**
     * game-design.md § 2 calls the Inspector's `min_range 3` "the single most
     * important thing" about the class — they are helpless in a doorway. A
     * player who finds that out after choosing was told too late, and it fits
     * in three characters.
     */
    expect(
      talentShorthand(shaped({ range: 5, minRange: 3, cost: { ap: 3, mp: 0, resource: 0 } })),
    ).toBe('3 AP · 3-5');
    expect(
      talentShorthand(shaped({ range: 7, minRange: 3, cost: { ap: 5, mp: 0, resource: 0 } })),
    ).toBe('5 AP · 3-7');
  });

  it('gives a plain reach when there is no hole in it', () => {
    // Fog Step, Ashwick Flare, Backdraft — range with minRange 0.
    expect(
      talentShorthand(shaped({ range: 3, minRange: 0, cost: { ap: 4, mp: 0, resource: 0 } })),
    ).toBe('4 AP · 3 tiles');
  });

  it('calls a self-centred talent self rather than melee', () => {
    // Mend Wounds is range 0 and heals everybody within two tiles of YOU.
    expect(
      talentShorthand(shaped({ range: 0, minRange: 0, cost: { ap: 3, mp: 0, resource: 0 } })),
    ).toBe('3 AP · self');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST SCREEN A NEW PLAYER SEES SHOWS WHOLE WORDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FOUND BY PAINTING IT AT FIVE SIZES. The modal was a fixed 560x340, which put
 * three cards at about 176 pixels each and left ten monospace characters for a
 * talent name after the icon. `Iron Curtain` is twelve, so it read
 * `Iron Curta…` -- at the 640x320 floor and equally at 1280x720, because a
 * fixed modal cannot be helped by a bigger window.
 *
 * That is the worst place in this client to truncate a string: the player is
 * being asked to choose a class, permanently, off four talent names each.
 *
 * `measureText` answers six pixels a character here, which is what the 10px
 * monospace measures, so an ellipsis in this output is one the client draws.
 */
describe('the class picker at every window size', () => {
  const VIEWPORTS = [
    [640, 320],
    [640, 400],
    [772, 480],
    [1024, 600],
    [1280, 720],
  ] as const;

  /** Measures for real, and owns a `canvas` — this painter reads one. */
  function measuring(texts: string[]): CanvasRenderingContext2D {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'fillText')
            return (text: string) => {
              texts.push(text);
            };
          if (prop === 'canvas') return { width: 1280, height: 720 };
          return () => {};
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  function paintAt(width: number, height: number): string[] {
    const texts: string[] = [];
    drawClassPicker({
      ctx: measuring(texts),
      sprites: { sprite: () => undefined },
      rect: classPickerRect(width, height),
      options: OPTIONS,
      selected: 0,
      hovered: null,
    });
    return texts;
  }

  it('ellipsises nothing at any viewport', () => {
    const bad: string[] = [];
    for (const [w, h] of VIEWPORTS) {
      for (const text of paintAt(w, h)) {
        if (text.includes('…')) bad.push(`${String(w)}x${String(h)}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('grows with the window instead of ignoring it', () => {
    const small = classPickerRect(640, 400);
    const large = classPickerRect(1280, 720);
    expect(large.w).toBeGreaterThan(small.w);
    expect(large.h).toBeGreaterThan(small.h);
  });

  it('uses the room the SMALLEST window has, which a fraction did not', () => {
    // ═══ THE FIRST ATTEMPT MISSED THE ONE VIEWPORT THAT WAS BROKEN ═══
    // Sizing this as 0.78 of the width gives 499 at 640 -- LESS than the 560 it
    // already was -- so every viewport grew except the narrow one still cutting
    // `Iron Curtain`. There are 624 usable pixels at 640 and the modal was
    // taking 560 of them for no reason. A modal covers the hotbar by design, so
    // there is nothing underneath worth leaving visible.
    expect(classPickerRect(640, 400).w).toBe(640 - 8 * 2);
  });

  it('shows every talent name whole once the window is a realistic size', () => {
    for (const [w, h] of VIEWPORTS.filter(([, height]) => height >= 400)) {
      const texts = paintAt(w, h);
      for (const opt of OPTIONS) {
        for (const t of opt.talents) {
          expect(texts, `${String(w)}x${String(h)} ${t.name}`).toContain(t.name);
        }
      }
    }
  });

  it('says how many talents it dropped rather than just stopping', () => {
    // ═══ IT USED TO BREAK OUT OF THE LOOP AND SAY NOTHING ═══
    // At the 640x320 floor the card cannot hold four talent rows, and it used
    // to simply stop drawing them -- so the player chose between three classes
    // on half the information with nothing on screen saying so.
    // `ui/caselog.ts:467-478` is the rule this now follows: a surface that has
    // quietly stopped showing everything says so in WORDS, never in a shade.
    const texts = paintAt(640, 320);
    const note = texts.find((text) => /^\+\d+ more$/.test(text));
    expect(note, 'the card states the omission').toBeDefined();

    // And the count is TRUE: names present plus the number in the note is the
    // whole list. A note saying "+2" over three hidden rows is worse than none.
    const perCard = OPTIONS[0]?.talents ?? [];
    const shown = perCard.filter((t) => texts.includes(t.name)).length;
    const claimed = Number(/\+(\d+) more/.exec(note ?? '')?.[1] ?? '0');
    expect(shown + claimed).toBe(perCard.length);
  });

  it('says nothing when nothing was dropped', () => {
    // The mirror. A permanent "+0 more" is furniture, and furniture that looks
    // like a warning is worse than furniture.
    expect(paintAt(1280, 720).some((text) => /^\+\d+ more$/.test(text))).toBe(false);
  });

  it('never runs off the viewport it is centred in', () => {
    for (const [w, h] of VIEWPORTS) {
      const rect = classPickerRect(w, h);
      expect(rect.x, `${String(w)}x${String(h)} left`).toBeGreaterThanOrEqual(0);
      expect(rect.y, `${String(w)}x${String(h)} top`).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w, `${String(w)}x${String(h)} right`).toBeLessThanOrEqual(w);
      expect(rect.y + rect.h, `${String(w)}x${String(h)} bottom`).toBeLessThanOrEqual(h);
    }
  });

  it('still shrinks rather than disappearing on a tiny viewport', () => {
    // Unchanged, and re-asserted here because the growth rule touches the same
    // line: a player who owes a choice cannot play until they make it, so there
    // is no size at which this returns nothing.
    const rect = classPickerRect(320, 200);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
  });
});
