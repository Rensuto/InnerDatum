/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEWPORT } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import { PANEL_CORNER } from '../../src/client/ui/panel.ts';

/**
 * THE NARROWEST BACKBUFFER THIS CLIENT CAN PRODUCE, DERIVED RATHER THAN TYPED.
 *
 * This was the literal 640 at four call sites. 640 is not a constant anybody
 * chose — it is `DEFAULT_VIEWPORT.tilesW * TILE_PX`, and if either moves, a
 * typed 640 keeps passing while asserting something about a floor that no
 * longer exists. Both are exported; there is no reason to hold a copy.
 */
const FLOOR_W = DEFAULT_VIEWPORT.tilesW * TILE_PX;

import { DragKind, DraggablePanel } from '../../src/client/ui/drag.ts';
import {
  HOTBAR_H,
  HOTBAR_ITEM_SLOTS,
  HOTBAR_LABEL_H,
  HOTBAR_SLOTS,
  HOTBAR_TALENT_SLOTS,
  HOTBAR_TOTAL_H,
  HotbarDropKind,
  HotbarSlotKind,
  ItemSlotAction,
  SLOT_PX,
  drawHotbar,
  hotbarDropTargetAt,
  hotbarRowWidth,
  hotbarSlotAt,
  hotbarTipAt,
  hotbarVisibleCount,
  isItemSlotIndex,
  isSlotDisabled,
  itemActionWord,
  itemSlotAction,
  itemStrip,
  slotRect,
  wornSlotOf,
} from '../../src/client/ui/hotbar.ts';
import { TalentShape } from '../../src/shared/protocol.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { HotbarSlot, HotbarView } from '../../src/client/ui/hotbar.ts';
import type { ItemView, LoadoutTalent, Slot } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOTBAR, AND THE ONE THING AN EIGHT-SLOT BAR CAN GET WRONG SILENTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file did not exist while the bar was four fixed talents: nothing in
 * test/ imported the module, so every number in it — the slot pitch, the total
 * height `panelBand` subtracts, the hit test — was unpinned. Four boxes that
 * never changed shape got away with that. Four DROP TARGETS do not, for three
 * reasons that are all the same reason:
 *
 *   THE DEAD TARGET   an empty slot you can release an item onto that then does
 *                     nothing is worse than no slot at all. The state machine
 *                     (`itemSlotAction`) is therefore driven here directly, with
 *                     no DOM and no socket, including the transition NOBODY
 *                     PRESSES — carried→equipped, where the caption must flip
 *                     from EQUIP to REMOVE with no other input.
 *
 *   THE VANISHED      the painter used to skip a slot that did not fit, with a
 *   TARGET            bare `continue` and no word anywhere. On a talent bar that
 *                     was untidy; on a drop-target bar it is a box the player
 *                     aims at that is not there. `hotbarVisibleCount` makes that
 *                     one explicit decision and the strip says what it decided.
 *
 *   THE BARE CLONE    client/public/assets/ is gitignored in its entirety, so a
 *                     sprite source that resolves NOTHING is the ordinary state
 *                     of a fresh checkout, not an edge case. Every slot state is
 *                     painted through it here and must still produce a border
 *                     and a word.
 *
 * NO PIXELS ARE ASSERTED FOR THEIR OWN SAKE. The hit tests SCAN — an assertion
 * that a slot starts at x=18 would pass while it was drawn at x=20, because it
 * would be testing the test's own copy of the arithmetic (the reason
 * test/client/partypanel.test.ts:56-61 gives). What IS asserted literally is the
 * art contract (`SLOT_PX`) and the two heights another file subtracts.
 *
 * vitest.config.ts is explicit that there is no jsdom and no canvas here. The
 * `reference lib="dom"` on line 1 is required and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function talent(over: Partial<LoadoutTalent> = {}): LoadoutTalent {
  return {
    id: 'talent:fog_step',
    name: 'Fog Step',
    icon: 'icon_active_fog_step',
    cost: { ap: 5, mp: 0, resource: 0 },
    cooldownTurns: 4,
    range: 5,
    minRange: 0,
    shape: TalentShape.Tile,
    radius: 0,
    level: 1,
    maxLevel: 5,
    // Both rendered SERVER-SIDE (protocol.ts:588-601). The hotbar never reads
    // either — the talent panel behind G does — but they are required fields and
    // omitting them here would be a fixture that no frame could ever produce.
    desc: 'Step through the fog.',
    descNext: 'Step further through the fog.',
    ...over,
  };
}

function talentSlot(over: Partial<HotbarSlot> = {}): HotbarSlot {
  // ═══ THE DISCRIMINANT IS SPELLED, AND THAT IS THE POINT OF THIS FIXTURE ═══
  // It used to omit `kind` deliberately, to hold `HotbarTalentSlot.kind?` open
  // while main.ts still built bare `{talent, cooldown, affordable}` literals.
  // main.ts:2261 spells it now, the `?` is gone and the four
  // `case undefined:` arms with it, so a fixture that still omitted it would be
  // asserting the drawing of a slot shape the client can no longer produce.
  // `as HotbarSlot` is kept only so `over` can widen the union in the item cases.
  return {
    kind: HotbarSlotKind.Talent,
    talent: talent(),
    cooldown: 0,
    affordable: true,
    ...over,
  } as HotbarSlot;
}

function itemSlot(action: ItemSlotAction, over: Partial<HotbarSlot> = {}): HotbarSlot {
  return {
    kind: HotbarSlotKind.Item,
    itemId: 'item_watchmans_coat',
    name: "Watchman's Coat",
    icon: 'item_watchmans_coat',
    action,
    ...over,
  } as HotbarSlot;
}

const EMPTY_SLOT: HotbarSlot = { kind: HotbarSlotKind.Empty };

/** A bar in the shape the wiring pass will build: four talents, then four item slots. */
/**
 * THE FIRST ITEM SLOT, DERIVED. It was the literal 4 until the bar grew to six
 * talents, at which point a hard-coded 4 silently became a TALENT slot and the
 * item-slot caption tests were asserting about the wrong square.
 */
const FIRST_ITEM = HOTBAR_TALENT_SLOTS;

function barSlots(items: readonly HotbarSlot[] = []): HotbarSlot[] {
  const out: HotbarSlot[] = [];
  for (let i = 0; i < HOTBAR_TALENT_SLOTS; i += 1) {
    out.push(
      talentSlot({
        talent: talent({
          id: `talent:t${String(i)}`,
          name: `Talent ${String(i)}`,
          // TWO DIGITS, DELIBERATELY. The cost readout draws `${ap}` in the same
          // corner family as the key digit, so a single-digit cost would be
          // indistinguishable from a key in the recorded text and the "no digit
          // on an item slot" assertion would be reading the wrong number.
          cost: { ap: 10, mp: 0, resource: 0 },
        }),
      }),
    );
  }
  for (let i = 0; i < HOTBAR_ITEM_SLOTS; i += 1) out.push(items[i] ?? EMPTY_SLOT);
  return out;
}

function view(over: Partial<HotbarView> = {}): HotbarView {
  return { slots: barSlots(), hovered: -1, armed: -1, ...over };
}

function itemView(itemId: string): ItemView {
  // `compare: []` — a hotbar binding never draws stat rows, and an empty list
  // is the honest answer for a fixture with no body behind it.
  return { itemId, name: itemId, icon: itemId, tier: 'common', desc: '', compare: [] };
}

/**
 * EVERY SPRITE ID THIS FILE EXPECTS THE PAINTER TO NAME, transcribed from
 * client/public/assets/manifest.placeholders.json rather than read from it.
 *
 * The manifest is gitignored — that is the whole point of the bare-clone tests
 * below — so reading it here would make this file pass on the author's machine
 * and skip on a fork. The three `ui_hotbar_slot_*` and the two
 * `ui_inventory_cell_*` are the complete families in the manifest; `item_*` and
 * `icon_active_*` are checked by PREFIX against the same list
 * test/client/assets.test.ts:231-249 pins on main.ts's loader, because the
 * painter is handed those ids by the server and never spells one itself.
 */
const CHROME_IDS = [
  // The frame is now `ui_panel_9slice_inset`, drawn at the slot's size — see
  // the SLOT_PX test. The three `ui_hotbar_slot_*` PNGs are no longer asked for.
  'ui_panel_9slice_inset',
  'ui_inventory_cell_empty',
  'ui_inventory_cell_hover',
];
const CONTENT_PREFIXES = ['item_', 'icon_active_'];

/** Widths a real client renders at. 640 is the FLOOR (render/canvas.ts:344). */
const WIDTHS = [640, 800, 1280, 1920];

// ---------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------

describe('geometry', () => {
  it('is 48 tall with a 60-pixel total, and the total is DERIVED', () => {
    // The two numbers main.ts:534-541 subtracts from the viewport to get
    // panelBand. 76/88 before the nine-slice rebuild; the 28 pixels went
    // straight to the four draggable panels with no edit in main.ts, which only
    // works while the total stays derived.
    expect(HOTBAR_H).toBe(48);
    expect(HOTBAR_LABEL_H).toBe(12);
    expect(HOTBAR_TOTAL_H).toBe(60);
    expect(HOTBAR_TOTAL_H).toBe(HOTBAR_H + HOTBAR_LABEL_H);
    // Pad is 2 either side of the slot. Stated as a relation so a change to
    // SLOT_PX cannot leave HOTBAR_H behind.
    expect(HOTBAR_H).toBe(SLOT_PX + 4);
  });

  it('sizes SLOT_PX for the NINE-SLICE, which is what freed it from 72', () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE OLD RULE WAS RIGHT ABOUT THE BLIT AND WRONG ABOUT THE CONCLUSION.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This test used to read `expect(SLOT_PX).toBe(72)` under a comment calling
     * it "an ART CONTRACT and not a layout choice": `drawFrame` blitted
     * `ui_hotbar_slot_*` at the sprite's own 72x72 and ignored the rect, so a
     * smaller slot left a 72-pixel PICTURE over a smaller HIT BOX and clicks
     * along two edges fell through to the map. All true.
     *
     * But the constraint was the BLIT, not the art. The frame is now
     * `ui_panel_9slice_inset` — 48x48 with 16-pixel corners, drawn through
     * `ui/panel.ts` at whatever size it is asked for, which is the entire point
     * of a nine-slice and which the Case Log has relied on all along. Corners
     * blit 1:1; only the flat edges and centre stretch. Nothing is resampled.
     *
     * So the number is now a LAYOUT choice with two floors, and both are
     * asserted rather than described:
     */
    // A 16-pixel corner needs 32 before opposite corners would overlap.
    expect(SLOT_PX).toBeGreaterThanOrEqual(PANEL_CORNER * 2);
    // ...and the icon inside is drawn at 32, so the slot cannot be smaller than
    // its own contents.
    expect(SLOT_PX).toBeGreaterThanOrEqual(32);
    expect(SLOT_PX).toBe(44);
  });

  it('fits every slot on the narrowest backbuffer this client can render', () => {
    // 13*44 + 12*4 = 620 against the 640 floor render/canvas.ts pins with
    // DEFAULT_VIEWPORT.tilesW 20. Twenty pixels of slack — down from 164 when
    // the bar was ten, and the reason the talent half stopped at NINE rather
    // than ten: fourteen slots is 668 and the floor stops holding them.
    //
    // THE SECOND ASSERTION IS THE INVARIANT and the first is its arithmetic.
    // A bar that does not fit the floor does not merely look cramped — the
    // fallback drops the four item slots, which are drop targets, and a drop
    // target that is absent on small windows is the failure `hotbarVisibleCount`
    // was written to make loud.
    expect(hotbarRowWidth(HOTBAR_SLOTS)).toBe(620);
    expect(hotbarRowWidth(HOTBAR_SLOTS)).toBeLessThanOrEqual(FLOOR_W);
    expect(hotbarVisibleCount(HOTBAR_SLOTS, FLOOR_W)).toBe(HOTBAR_SLOTS);
    // And one more slot would NOT fit, which is what pins the count at nine.
    expect(hotbarRowWidth(HOTBAR_SLOTS + 1)).toBeGreaterThan(FLOOR_W);

    const first = slotRect(0, HOTBAR_SLOTS, FLOOR_W, 480);
    const last = slotRect(HOTBAR_SLOTS - 1, HOTBAR_SLOTS, FLOOR_W, 480);
    expect(first.x).toBeGreaterThanOrEqual(0);
    expect(last.x + last.w).toBeLessThanOrEqual(FLOOR_W);
  });

  it('round-trips every slot centre through the hit test at every viewport', () => {
    for (const width of WIDTHS) {
      const height = 480;
      for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
        const r = slotRect(i, HOTBAR_SLOTS, width, height);
        const cx = r.x + Math.floor(r.w / 2);
        const cy = r.y + Math.floor(r.h / 2);
        expect(hotbarSlotAt(cx, cy, HOTBAR_SLOTS, width, height), `centre @${String(width)}`).toBe(
          i,
        );
        // The corners too: a half-open box is where an off-by-one hides.
        expect(hotbarSlotAt(r.x, r.y, HOTBAR_SLOTS, width, height)).toBe(i);
        expect(hotbarSlotAt(r.x + r.w - 1, r.y + r.h - 1, HOTBAR_SLOTS, width, height)).toBe(i);
      }
      // Above the row is the map, not the bar.
      const row = slotRect(0, HOTBAR_SLOTS, width, height);
      expect(hotbarSlotAt(row.x, row.y - 1, HOTBAR_SLOTS, width, height)).toBe(-1);
      expect(hotbarSlotAt(0, row.y, HOTBAR_SLOTS, width, height)).toBe(-1);
    }
  });

  it('is centred on the count it is GIVEN — the one-word mistake the wiring pass can make', () => {
    // ═══ THIS IS A HAZARD NOTE WITH AN ASSERTION ON IT ═══
    // main.ts:5930's `slotUnder` passes `loadout.length` — FOUR — and that is
    // right today only because `hotbarView` returns four slots. Return eight
    // from one and four from the other and the row is centred on 604 pixels by
    // the painter and on 300 by the hit test: every hover and click lands
    // somewhere else, at every viewport, with no line of ui/hotbar.ts having
    // changed. Both numbers are the caller's, so this is the only place the
    // mismatch can be made to fail loudly.
    const r = slotRect(6, HOTBAR_SLOTS, 1280, 480);
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    expect(hotbarSlotAt(cx, cy, HOTBAR_SLOTS, 1280, 480)).toBe(6);
    // ═══ THE SAME POINT, ASKED WITH THE STALE TALENT COUNT: A DIFFERENT SLOT ═══
    // It used to answer -1 — off the bar entirely — because six slots of eight
    // did not reach that far. With ten slots and six talents it answers a real
    // but WRONG index, which is the worse failure of the two and the one this
    // note is about: a click that lands on nothing is visible, and a click that
    // fires the wrong talent is not. The assertion is therefore "not 6" rather
    // than any particular number.
    expect(hotbarSlotAt(cx, cy, HOTBAR_TALENT_SLOTS, 1280, 480)).not.toBe(6);
  });

  it('splits the row four and four, and says which half an index is in', () => {
    expect(HOTBAR_SLOTS).toBe(HOTBAR_TALENT_SLOTS + HOTBAR_ITEM_SLOTS);
    for (let i = 0; i < HOTBAR_TALENT_SLOTS; i += 1) expect(isItemSlotIndex(i)).toBe(false);
    for (let i = HOTBAR_TALENT_SLOTS; i < HOTBAR_SLOTS; i += 1)
      expect(isItemSlotIndex(i)).toBe(true);
    expect(isItemSlotIndex(-1)).toBe(false);
    expect(isItemSlotIndex(HOTBAR_SLOTS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE STATE MACHINE — the test that stops a dead drop target
// ---------------------------------------------------------------------------

describe('itemSlotAction', () => {
  const COAT = 'item_watchmans_coat';
  const DRAUGHT = 'item_draught';

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE FIXTURES HERE USED TO SAY `{ itemId }` AND MEAN "A COAT".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * They were written when `ItemIdentity` was `{itemId}` and every carried thing
   * was wearable, so leaving the slot off cost nothing. It costs something now:
   * an absent slot is exactly how `CarriedItemView` says "this is a consumable",
   * so those fixtures had quietly become draughts and asserted that a draught
   * offers EQUIP.
   *
   * Naming the slot is not ceremony — it is the difference between the two
   * cases this function now distinguishes.
   */
  const wearable = (itemId: string): { itemId: string; slot: Slot } => ({ itemId, slot: 'body' });

  it('answers EQUIP for a wearable thing in the bag', () => {
    expect(itemSlotAction(COAT, [wearable(COAT)], {})).toBe(ItemSlotAction.Equip);
  });

  it('answers USE for something in the bag that cannot be worn', () => {
    /**
     * The bar captioned a draught EQUIP and sent that intent, and the server
     * answers "that is not something you can wear" — so the one item a player
     * most wants a keypress away was the one the bar refused. `slot` absent IS
     * the consumable test, and `CarriedItemView` documents it as such.
     */
    expect(itemSlotAction(DRAUGHT, [{ itemId: DRAUGHT }], {})).toBe(ItemSlotAction.Use);
  });

  it('does not confuse the two when the bag holds both', () => {
    const bag = [wearable(COAT), { itemId: DRAUGHT }];
    expect(itemSlotAction(COAT, bag, {})).toBe(ItemSlotAction.Equip);
    expect(itemSlotAction(DRAUGHT, bag, {})).toBe(ItemSlotAction.Use);
  });

  it('answers UNEQUIP for the occupant of a worn slot, and names that slot', () => {
    const equipped: Partial<Record<Slot, ItemView>> = { body: itemView(COAT) };
    expect(itemSlotAction(COAT, [], equipped)).toBe(ItemSlotAction.Unequip);
    // The caption is useless without the slot: `unequip` takes a Slot, not an id
    // (protocol.ts:1949 is z.enum(SLOT_ORDER)).
    expect(wornSlotOf(COAT, equipped)).toBe('body');
    expect(wornSlotOf('item_boots', equipped)).toBeNull();
  });

  it('answers GONE when the id is in neither collection', () => {
    expect(
      itemSlotAction(COAT, [{ itemId: 'item_boots' }], { head: itemView('item_locket') }),
    ).toBe(ItemSlotAction.Gone);
    expect(itemSlotAction(COAT, [], {})).toBe(ItemSlotAction.Gone);
  });

  it('flips EQUIP → UNEQUIP the moment the item moves carried → equipped, with no other input', () => {
    // ═══ THE TRANSITION NOBODY PRESSES ═══
    // The binding is one string and never changes. Everything else about the
    // slot is recomputed from the world, which is why equipping the coat from
    // the INVENTORY PANEL — or having it equipped by anything else — still flips
    // this caption. A slot that cached "this equips" would keep saying so over an
    // item already on the body, and the player would only find out from a server
    // refusal.
    const before = itemSlotAction(COAT, [wearable(COAT)], {});
    const after = itemSlotAction(COAT, [], { body: itemView(COAT) });
    expect(before).toBe(ItemSlotAction.Equip);
    expect(after).toBe(ItemSlotAction.Unequip);
  });

  it('never answers EQUIP once the item has left both collections', () => {
    // Dropped, destroyed, or traded. Upstream's own dangling case
    // (PlayerHotkeys.lua:176-177) and it is loud there too.
    let action = itemSlotAction(COAT, [wearable(COAT)], {});
    expect(action).toBe(ItemSlotAction.Equip);
    action = itemSlotAction(COAT, [], { body: itemView(COAT) });
    expect(action).toBe(ItemSlotAction.Unequip);
    action = itemSlotAction(COAT, [], {});
    expect(action).toBe(ItemSlotAction.Gone);
    // ...and it stays gone. There is no path back except the server sending it.
    expect(itemSlotAction(COAT, [{ itemId: 'item_boots' }], {})).toBe(ItemSlotAction.Gone);
  });

  it('greys only the GONE state — an empty slot is a target, not a dead button', () => {
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Gone))).toBe(true);
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Equip))).toBe(false);
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Unequip))).toBe(false);
    expect(isSlotDisabled(EMPTY_SLOT)).toBe(false);
    // The talent rule is unchanged: cooldown OR unaffordable.
    expect(isSlotDisabled(talentSlot())).toBe(false);
    expect(isSlotDisabled(talentSlot({ cooldown: 2 }))).toBe(true);
    expect(isSlotDisabled(talentSlot({ affordable: false }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE DROP TEST — a refusal is an answer, not silence
// ---------------------------------------------------------------------------

describe('hotbarDropTargetAt', () => {
  const W = 1280;
  const H = 480;

  function centreOf(index: number): { x: number; y: number } {
    const r = slotRect(index, HOTBAR_SLOTS, W, H);
    return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  }

  it('answers BIND with the index for the four item slots', () => {
    for (let i = HOTBAR_TALENT_SLOTS; i < HOTBAR_SLOTS; i += 1) {
      const p = centreOf(i);
      expect(hotbarDropTargetAt(p.x, p.y, HOTBAR_SLOTS, W, H)).toEqual({
        kind: HotbarDropKind.Bind,
        index: i,
      });
    }
  });

  it('answers TALENT — WITH THE INDEX — for a release over slots 0-3', () => {
    // NOT a miss and NOT silence. The class talents cannot be rebound, so the
    // caller has to be able to say "the first four slots are your class talents"
    // instead of letting the item snap back for no stated reason. Carrying the
    // index is what lets the sentence name the slot.
    for (let i = 0; i < HOTBAR_TALENT_SLOTS; i += 1) {
      const p = centreOf(i);
      expect(hotbarDropTargetAt(p.x, p.y, HOTBAR_SLOTS, W, H)).toEqual({
        kind: HotbarDropKind.Talent,
        index: i,
      });
    }
  });

  it('answers MISS off the bar, so whatever is underneath still gets the release', () => {
    const r = slotRect(0, HOTBAR_SLOTS, W, H);
    expect(hotbarDropTargetAt(0, r.y, HOTBAR_SLOTS, W, H)).toEqual({ kind: HotbarDropKind.Miss });
    expect(hotbarDropTargetAt(r.x, r.y - 1, HOTBAR_SLOTS, W, H)).toEqual({
      kind: HotbarDropKind.Miss,
    });
  });

  it('reads the SAME geometry as the hover test at every viewport', () => {
    for (const width of WIDTHS) {
      for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
        const r = slotRect(i, HOTBAR_SLOTS, width, H);
        const x = r.x + 1;
        const y = r.y + 1;
        const drop = hotbarDropTargetAt(x, y, HOTBAR_SLOTS, width, H);
        const hover = hotbarSlotAt(x, y, HOTBAR_SLOTS, width, H);
        expect(drop.kind === HotbarDropKind.Miss ? -1 : drop.index).toBe(hover);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PAINTING
// ---------------------------------------------------------------------------

describe('drawing', () => {
  /**
   * The Proxy recorder from test/client/inventory.test.ts:1328-1355, plus one
   * addition: `asked` records every id handed to `sprites.sprite()`.
   *
   * ASKING is the right thing to record, not `drawImage`'s arguments. What has to
   * be caught here is the painter NAMING a sprite id that no manifest holds —
   * which is how twelve talent icons sat unloaded behind a dead `icon_ability_`
   * prefix for weeks with every line of drawing code correct. A drawImage
   * assertion would only ever see ids that already resolved.
   *
   * `measureText` answers SIX PIXELS PER CHARACTER rather than a flat constant,
   * which is load-bearing: a constant width makes `fitText` truncate every string
   * it is given, so the recorded text would be an ellipsis and nothing could be
   * read back. Six is the advance of the 10px monospace this file draws with.
   */
  function recorder(calls: string[], texts: string[]) {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          // ONLY `fillText` FEEDS `texts`. The captions and the cooldown digits
          // are outlined — `strokeText` draws the very same string a moment
          // earlier — so counting both would report every word twice and a
          // "four empty slots means four ITEM captions" assertion would be
          // silently reading eight.
          if (prop === 'fillText')
            return (text: string, ...rest: unknown[]) => {
              texts.push(text);
              calls.push(`fillText(${String(rest.length + 1)})`);
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${String(args.length)})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  /**
   * A sprite source built at the manifest's REAL sizes.
   *
   * The sizes are load-bearing, not decoration: `drawEmptyPlate` refuses a plate
   * bigger than its 64-pixel well, exactly as ui/inventory.ts's `blitCentred`
   * does, so a flat fake size would silently exercise the fallback twice and the
   * "it blits the plate" assertion would be testing nothing.
   */
  function art(asked: string[]): SpriteSource {
    const sizes: Record<string, readonly [number, number]> = {
      ui_panel_9slice_inset: [48, 48],
      ui_inventory_cell_empty: [40, 40],
      ui_inventory_cell_hover: [40, 40],
    };
    return {
      sprite: (id: string) => {
        asked.push(id);
        const wh =
          sizes[id] ?? (id.startsWith('item_') || id.startsWith('icon_') ? [64, 64] : null);
        if (wh === null) return undefined;
        return { id, image: { id } as unknown as HTMLImageElement, w: wh[0], h: wh[1] };
      },
    };
  }

  /** No art at all: the state of every fresh clone, since assets/ is gitignored. */
  function bare(asked: string[]): SpriteSource {
    return {
      sprite: (id: string) => {
        asked.push(id);
        return undefined;
      },
    };
  }

  function paint(v: HotbarView, width = 1280, sprites?: (asked: string[]) => SpriteSource) {
    const calls: string[] = [];
    const texts: string[] = [];
    const asked: string[] = [];
    drawHotbar({
      ctx: recorder(calls, texts),
      sprites: (sprites ?? art)(asked),
      view: v,
      width,
      height: 480,
    });
    /**
     * HOW MANY STROKES THE PAINTER MADE.
     *
     * The disabled state used to be a PNG with a hatch baked into it, so a test
     * could assert it by sprite id. `drawFrame` now draws the hatch — which is
     * strictly better, because the hatch is the one channel that says "you
     * cannot press this" without relying on colour — and a drawn thing has no
     * id to assert. The stroke count is what is left, and it is enough: no other
     * state strokes anything at all.
     */
    const strokes = calls.filter((c) => c.startsWith('stroke(')).length;
    return { calls, texts, asked, strokes };
  }

  it('pairs every save with a restore', () => {
    // An unbalanced restore leaks a font, an alignment or an alpha into every
    // painter later in the frame, and it presents as a bug in whichever surface
    // happens to be drawn next (ui/turncards.ts:786-790 records the same trap).
    const { calls } = paint(view({ slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }));
    expect(calls.filter((c) => c.startsWith('save(')).length).toBe(
      calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('wears the nine-slice inset well, and draws the empty plate itself', () => {
    const { asked, texts } = paint(view());
    expect(asked).toContain('ui_panel_9slice_inset');
    // NOT `ui_inventory_cell_empty` any more: that plate is 40x40 and the icon
    // well is now 32, and this file's own rule is that a plate which does not
    // fit its well is never scaled to make it. `drawEmptyPlate` traces the
    // square instead — the path that was already the refusal and bare-clone
    // path — so the empty slot asks for no content sprite at all.
    expect(asked).not.toContain('ui_inventory_cell_empty');
    // The word is what makes it a SLOT and not a gap — the player's own
    // complaint. Four of them, one per empty item slot.
    expect(texts.filter((t) => t === 'ITEM').length).toBe(HOTBAR_ITEM_SLOTS);
  });

  it('lights the empty slots on a live ITEM drag and not on a panel drag', () => {
    const carried = paint(
      view({ drag: { kind: DragKind.Carried, itemId: 'item_watchmans_coat' } }),
    );
    // The well is the same skin in every state now; HOVER is a drawn gold edge
    // rather than a second PNG, so what this pins is that the slot is PAINTED
    // during a live item drag at all. The edge itself is a fill, not a sprite.
    expect(carried.asked).toContain('ui_panel_9slice_inset');
    // BIND, not ITEM: while something droppable is in hand the caption says what
    // the release will DO.
    expect(carried.texts).toContain('BIND');
    expect(carried.texts).not.toContain('ITEM');

    // A worn item dragged off the doll is equally bindable.
    const worn = paint(view({ drag: { kind: DragKind.Worn, slot: 'body' } }));
    expect(worn.texts).toContain('BIND');

    // A panel header is clamped into panelBand and can never reach the hotbar.
    const panel = paint(view({ drag: { kind: DragKind.Panel, panel: DraggablePanel.Inventory } }));
    expect(panel.texts).not.toContain('BIND');
    expect(panel.texts).toContain('ITEM');
  });

  it('draws EQUIP, REMOVE and GONE, and hatches only the GONE slot', () => {
    const equip = paint(view({ slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }));
    expect(equip.texts).toContain('EQUIP');
    // GONE is hatched by `drawFrame` with strokes rather than by a disabled
    // PNG, so the distinction is no longer visible as a sprite id. What still
    // separates the three is the CAPTION, asserted above — and the hatch itself
    // is exercised by the stroke count below.
    expect(equip.strokes).toBe(0);
    // The item's own icon, which the server named. Never spelled here.
    expect(equip.asked).toContain('item_watchmans_coat');

    const remove = paint(view({ slots: barSlots([itemSlot(ItemSlotAction.Unequip)]) }));
    expect(remove.texts).toContain('REMOVE');
    expect(remove.strokes).toBe(0);

    const gone = paint(view({ slots: barSlots([itemSlot(ItemSlotAction.Gone)]) }));
    expect(gone.texts).toContain('GONE');
    // The hatch: a run of diagonal strokes across the well, and the only state
    // that draws any. This is the colour-independent channel that says "you
    // cannot press this" — see `drawFrame`.
    expect(gone.strokes).toBeGreaterThan(0);
  });

  it('draws the talent icons the manifest actually holds, and a digit only on talent keys', () => {
    // ═══ THE INVISIBLE-PREREQUISITE CHECK ═══
    // `icon_active_*` is what every talent in src/server/talents/ declares and
    // what main.ts's loader prefix list now carries. The bar drew "AF AV B MW"
    // for weeks because that prefix read `icon_ability_`, with every line of
    // drawing code correct. So: the ids reach the sprite source, and they
    // resolve.
    const { asked, texts } = paint(view());
    expect(asked).toContain('icon_active_fog_step');

    // One digit per TALENT slot, in order, and none on an item slot. The item
    // half stays mouse-only: a digit there would have to be 0 or a punctuation
    // cap, and `HOTBAR_ITEM_SLOTS`' own note argues that case.
    //
    // DERIVED FROM THE CONSTANT. This read `['1', '2', '3', '4']` under a
    // comment saying "exactly four digits" while asserting six — the list and
    // its explanation had already drifted apart once.
    const digits = texts.filter((t) => /^[0-9]$/.test(t));
    expect(digits).toEqual(
      Array.from({ length: HOTBAR_TALENT_SLOTS }, (_unused, i) => String(i + 1)),
    );
  });

  it('never names a sprite id outside the manifest families that already exist', () => {
    // assets.test.ts:231-249 pins the loader's prefix array exactly, so an id
    // this file invents would resolve to the loud violet missing-asset box on
    // every clone, for a feature that otherwise works.
    const states: HotbarView[] = [
      view(),
      view({ hovered: 5 }),
      view({ drag: { kind: DragKind.Carried, itemId: 'item_boots' } }),
      view({ slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }),
      view({ slots: barSlots([itemSlot(ItemSlotAction.Unequip)]) }),
      view({ slots: barSlots([itemSlot(ItemSlotAction.Gone)]) }),
      view({ hovered: 1, armed: 2, slots: barSlots() }),
      view({ slots: barSlots().map((s, i) => (i === 0 ? talentSlot({ cooldown: 3 }) : s)) }),
    ];
    for (const state of states) {
      const { asked } = paint(state);
      expect(asked.length).toBeGreaterThan(0);
      for (const id of asked) {
        const known =
          CHROME_IDS.includes(id) || CONTENT_PREFIXES.some((prefix) => id.startsWith(prefix));
        expect(known, `unknown sprite id: ${id}`).toBe(true);
      }
    }
  });

  it('gives EVERY slot state a border and a word with no art installed at all', () => {
    // ═══ THE BARE-CLONE PATH, WHICH IS THE ONLY PATH ON A FRESH CHECKOUT ═══
    // client/public/assets/ is gitignored in its entirety. If a state's only
    // rendering were its sprite, that state would be an invisible box here — and
    // an invisible DROP TARGET is worse than none.
    const states: readonly (readonly [string, HotbarView, string])[] = [
      ['empty', view(), 'ITEM'],
      ['empty+drag', view({ drag: { kind: DragKind.Carried, itemId: 'item_boots' } }), 'BIND'],
      ['equip', view({ slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }), 'EQUIP'],
      ['remove', view({ slots: barSlots([itemSlot(ItemSlotAction.Unequip)]) }), 'REMOVE'],
      ['gone', view({ slots: barSlots([itemSlot(ItemSlotAction.Gone)]) }), 'GONE'],
    ];
    for (const [label, state, word] of states) {
      const { calls, texts } = paint(state, 1280, bare);
      expect(texts, label).toContain(word);
      // The traced frame: `drawFrame`'s fallback is four 1px fillRects per slot
      // on top of the fill, and nothing else in this painter reaches that count.
      expect(calls.filter((c) => c.startsWith('fillRect(')).length, label).toBeGreaterThan(
        HOTBAR_SLOTS * 4,
      );
      // Nothing was blitted, because nothing resolved.
      expect(
        calls.some((c) => c.startsWith('drawImage(')),
        label,
      ).toBe(false);
    }
    // The bound item's INITIALS, so eight boxes are still distinguishable.
    const { texts } = paint(
      view({ slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }),
      1280,
      bare,
    );
    expect(texts).toContain('WC');
  });

  it('says what the pointer is on, per kind, and says nothing when it is on nothing', () => {
    expect(paint(view()).texts.some((t) => t.includes('click to'))).toBe(false);

    const onEmpty = paint(view({ hovered: FIRST_ITEM }));
    expect(onEmpty.texts.some((t) => t.includes('drag an item here'))).toBe(true);

    const onEquip = paint(
      view({ hovered: FIRST_ITEM, slots: barSlots([itemSlot(ItemSlotAction.Equip)]) }),
    );
    expect(onEquip.texts.some((t) => t.includes("Watchman's Coat — click to equip"))).toBe(true);

    const onWorn = paint(
      view({ hovered: FIRST_ITEM, slots: barSlots([itemSlot(ItemSlotAction.Unequip)]) }),
    );
    expect(onWorn.texts.some((t) => t.includes('click to remove'))).toBe(true);

    const onGone = paint(
      view({ hovered: FIRST_ITEM, slots: barSlots([itemSlot(ItemSlotAction.Gone)]) }),
    );
    expect(onGone.texts.some((t) => t.includes('you no longer have it'))).toBe(true);

    const onTalent = paint(view({ hovered: 1 }));
    expect(onTalent.texts.some((t) => t.includes('2. Talent 1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE REFUSAL — a slot that will not fit is announced, never dropped in silence
// ---------------------------------------------------------------------------

describe('a row that does not fit', () => {
  function paintAt(width: number) {
    const calls: string[] = [];
    const texts: string[] = [];
    drawHotbar({
      ctx: new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
            // fillText only — see the recorder above on why the outline pass is
            // deliberately not counted.
            if (prop === 'fillText')
              return (text: string) => {
                texts.push(text);
              };
            if (prop === 'canvas') return undefined;
            return (...args: unknown[]) => {
              calls.push(`${prop}(${String(args.length)})`);
            };
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D,
      sprites: { sprite: () => undefined },
      view: view(),
      width,
      height: 480,
    });
    return { calls, texts };
  }

  it('drops to the TALENT slots — the half with keys — and says so in the strip', () => {
    // STATED AS ARITHMETIC ON THE REAL CONSTANTS, which is what let this test
    // survive the bar going eight -> ten -> thirteen slots without a number
    // moving: thirteen slots are 620 wide and the nine talents are 428, so the
    // band that shows only the talents runs 428..619.
    expect(hotbarVisibleCount(HOTBAR_SLOTS, hotbarRowWidth(HOTBAR_SLOTS) - 1)).toBe(
      HOTBAR_TALENT_SLOTS,
    );

    const { texts } = paintAt(hotbarRowWidth(HOTBAR_SLOTS) - 1);
    // Every talent digit is still drawn; the item captions are gone. DERIVED,
    // so raising the talent half does not need this list retyped.
    expect(texts.filter((t) => /^[0-9]$/.test(t))).toEqual(
      Array.from({ length: HOTBAR_TALENT_SLOTS }, (_unused, i) => String(i + 1)),
    );
    expect(texts).not.toContain('ITEM');
    // AND THE SENTENCE. The old painter had a bare `continue` here: four drop
    // targets simply were not painted and nothing anywhere said why.
    expect(
      texts.some((t) =>
        t.includes(`${String(HOTBAR_TALENT_SLOTS)} of ${String(HOTBAR_SLOTS)} slots`),
      ),
    ).toBe(true);
    // The refusal names the width it needs, whatever that width currently is.
    expect(texts.some((t) => t.includes(`${String(hotbarRowWidth(HOTBAR_SLOTS))}px`))).toBe(true);
  });

  it('hides the bar entirely rather than half-drawing it, and still explains itself', () => {
    expect(hotbarVisibleCount(HOTBAR_SLOTS, hotbarRowWidth(HOTBAR_TALENT_SLOTS) - 1)).toBe(0);
    const { texts } = paintAt(hotbarRowWidth(HOTBAR_TALENT_SLOTS) - 1);
    expect(texts.filter((t) => /^[0-9]$/.test(t))).toEqual([]);
    expect(texts.some((t) => t.includes('hotbar hidden'))).toBe(true);
  });

  it('keeps the hit test and the painter agreeing about a refused row', () => {
    // THE PROPERTY THAT MATTERS: a slot the painter refused must not be
    // clickable, and a slot it drew must be. Both read hotbarVisibleCount.
    const width = hotbarRowWidth(HOTBAR_SLOTS) - 1;
    for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
      const r = slotRect(i, HOTBAR_TALENT_SLOTS, width, 480);
      const hit = hotbarSlotAt(r.x + 1, r.y + 1, HOTBAR_SLOTS, width, 480);
      expect(hit).toBe(i < HOTBAR_TALENT_SLOTS ? i : -1);
    }
  });

  it('draws nothing at all before the loadout arrives', () => {
    const { calls } = (() => {
      const c: string[] = [];
      drawHotbar({
        ctx: new Proxy(
          {},
          {
            get: (_t, prop: string) => {
              if (prop === 'canvas') return undefined;
              return (...args: unknown[]) => {
                c.push(`${prop}(${String(args.length)})`);
              };
            },
            set: () => true,
          },
        ) as unknown as CanvasRenderingContext2D,
        sprites: { sprite: () => undefined },
        view: { slots: [], hovered: -1, armed: -1 },
        width: 1280,
        height: 480,
      });
      return { calls: c };
    })();
    expect(calls).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOVERING A SLOT EXPLAINS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The bar is eight 32-pixel squares and a digit. What the talent does, what it
 * costs, why it is greyed, what the item in slot 6 even IS — all of it was only
 * discoverable by pressing and finding out, which is a poor deal in a game where
 * a press costs the turn.
 */
describe('hotbarTipAt', () => {
  const W = 640;
  const H = 320;

  const barView = (): HotbarView => ({ slots: barSlots(), hovered: -1, armed: -1 });

  it('names the talent under the pointer and what it costs', () => {
    const view = barView();
    const rect = slotRect(0, view.slots.length, W, H);
    const card = hotbarTipAt(view, rect.x + 2, rect.y + 2, W, H);
    expect(card).not.toBeNull();
    expect(card?.title.length).toBeGreaterThan(0);
    expect(card?.meta ?? '').toContain('AP');
  });

  it('still explains a slot that cannot be pressed', () => {
    /**
     * A GREYED SLOT IS THE ONE MOST WORTH EXPLAINING: the player's question is
     * "why can I not press this", and the meta line is the answer. Refusing a
     * card there would withhold the information exactly when it is wanted.
     */
    const base = barView();
    const first = base.slots[0];
    if (first === undefined || first.kind !== HotbarSlotKind.Talent) return;
    const cooling = {
      ...base,
      slots: [{ ...first, cooldown: 3, affordable: false }, ...base.slots.slice(1)],
    };
    const rect = slotRect(0, cooling.slots.length, W, H);
    const card = hotbarTipAt(cooling, rect.x + 2, rect.y + 2, W, H);
    expect(card?.meta ?? '').toContain('cooling');
    expect(card?.meta ?? '').toContain('not affordable');
  });

  it('says nothing off the bar', () => {
    expect(hotbarTipAt(barView(), 2, 2, W, H)).toBeNull();
  });
});

describe('a stance that is up says so', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GAP: `LoadoutTalent.sustained` was on the wire and the client read it
   * NOWHERE. `grep -rn sustained src/client/` returned nothing functional.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The wire type argues the case itself: *"a sustain is the one talent whose
   * state a player must READ before pressing … without this the same key would
   * sometimes put a stance up and sometimes take it down, with nothing on screen
   * to say which was about to happen."* The field shipped; nothing drew it. A
   * raised stance was pixel-identical to a dropped one.
   *
   * ToME says it twice and both are permanent: a sustain frame on the hotkey
   * slot (HotkeysIconsDisplay.lua:120-125, :184-186) and a persistent icon in
   * the buff column (Minimalist.lua:1274-1338). We have no buff column yet, so
   * the frame is the one that matters most.
   */

  const W = 1280;
  const H = 480;

  const withSustain = (sustained: boolean | undefined): HotbarView => ({
    slots: barSlots().map((slot, i) =>
      i === 0 && slot.kind === HotbarSlotKind.Talent
        ? { ...slot, talent: { ...slot.talent, sustained } }
        : slot,
    ),
    hovered: -1,
    armed: -1,
  });

  /**
   * How many rectangles the painter filled. The ring is four of them.
   *
   * ITS OWN RECORDER rather than `describe('drawing')`'s `paint`, which is
   * scoped to that block — and this needs only one channel, so a four-line proxy
   * is honester than widening a shared harness for one caller.
   */
  function rects(v: HotbarView): number {
    let filled = 0;
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'canvas') return undefined;
          return () => {
            if (prop === 'fillRect') filled += 1;
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const sprites: SpriteSource = {
      sprite: (id: string) =>
        id.startsWith('item_') || id.startsWith('icon_') || id.startsWith('ui_')
          ? { id, image: { id } as unknown as HTMLImageElement, w: 48, h: 48 }
          : undefined,
    };
    drawHotbar({ ctx, sprites, view: v, width: W, height: H });
    return filled;
  }

  it('draws a ring a dropped stance does not', () => {
    // A DIFFERENTIAL, not an absolute: the exact rectangle count of the whole
    // bar is nobody's business and would break on any unrelated change. What
    // must hold is that raising a stance ADDS the ring's four sides.
    expect(rects(withSustain(true))).toBe(rects(withSustain(false)) + 4);
  });

  it('draws nothing extra for a talent that is not a stance at all', () => {
    /**
     * `sustained` is ABSENT on everything but a sustain — the wire type says
     * `false` on an active would be a claim that it could be sustained. Absent
     * and false must draw identically; only `true` may add anything.
     */
    expect(rects(withSustain(undefined))).toBe(rects(withSustain(false)));
  });

  it('is not a fourth FrameState, so hovering a raised stance still shows it', () => {
    /**
     * THE DESIGN POINT. The three frame states are mutually exclusive answers to
     * "can I press this"; being up is a different question, and a stance can be
     * up AND hovered at once. Folding them into one enum would hide the raised
     * ring at exactly the moment the player is about to press the key.
     */
    const up = withSustain(true);
    const hoveredUp: HotbarView = { ...up, hovered: 0 };
    const hoveredDown: HotbarView = { ...withSustain(false), hovered: 0 };
    expect(rects(hoveredUp)).toBe(rects(hoveredDown) + 4);
  });

  it('tells the pointer which way the key goes', () => {
    const rect = slotRect(0, withSustain(true).slots.length, W, H);
    const up = hotbarTipAt(withSustain(true), rect.x + 2, rect.y + 2, W, H);
    const down = hotbarTipAt(withSustain(false), rect.x + 2, rect.y + 2, W, H);
    expect(up?.meta ?? '').toContain('UP');
    expect(down?.meta ?? '').toContain('press to raise');
  });

  it('says nothing about stances on a talent that is not one', () => {
    const rect = slotRect(0, withSustain(undefined).slots.length, W, H);
    const card = hotbarTipAt(withSustain(undefined), rect.x + 2, rect.y + 2, W, H);
    expect(card?.meta ?? '').not.toContain('press to raise');
    expect(card?.meta ?? '').not.toContain('UP');
    // ...and it still says the ordinary things.
    expect(card?.meta ?? '').toContain('AP');
  });
});

describe('a consumable on the bar is drunk, not worn', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAR ACCEPTED THE DRAUGHT AND THEN REFUSED IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Worse than absent: the four item slots took the consumable you dragged onto
   * them, captioned it EQUIP, and answered the keypress with the server's "that
   * is not something you can wear" — so a player concluded the bar was broken,
   * while the party waited at the barrier.
   *
   * The rule was right when it was written. `hotbar.ts`'s header argued that
   * shipping a `use` intent would be "a verb with nothing behind it, which is
   * the 'control that does nothing' trap wearing a protocol change". Then `use`
   * shipped — and keeping the rule inverted the trap.
   *
   * ═══ THE SWITCHES ARE THE COMPILER'S JOB, NOT A TEST'S ═══
   * Four `switch`es read this union and every one is exhaustive with no default,
   * so a member that nothing handles is a BUILD failure — adding `Use` produced
   * exactly that until each arm was written. What a test can add is that the
   * arms AGREE: the caption a player reads and the hover line they read half a
   * second later must name one verb, because two verbs for one press is how a
   * control stops being trusted.
   */
  const DRAUGHT = 'item_draught';
  const W = 640;
  const H = 320;

  const withDraught = (action: ItemSlotAction): HotbarView => ({
    slots: [
      {
        kind: HotbarSlotKind.Item,
        itemId: DRAUGHT,
        name: 'Steadying Draught',
        icon: 'icon_item_draught',
        action,
      },
    ],
    hovered: -1,
    armed: -1,
  });

  it('resolves to USE rather than EQUIP', () => {
    expect(itemSlotAction(DRAUGHT, [{ itemId: DRAUGHT }], {})).toBe(ItemSlotAction.Use);
  });

  it('offers to use it under the pointer, and does not offer to equip it', () => {
    const view = withDraught(ItemSlotAction.Use);
    const rect = slotRect(0, view.slots.length, W, H);
    const card = hotbarTipAt(view, rect.x + 2, rect.y + 2, W, H);
    expect(card, 'no hover card over a consumable slot').not.toBeNull();
    const said = `${card?.title ?? ''} ${card?.meta ?? ''} ${(card?.lines ?? []).join(' ')}`;
    expect(said).toMatch(/use/i);
    expect(said, 'the hover line still offers to equip a draught').not.toMatch(/equip/i);
  });

  it('says the same verb in both places a player reads it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO SENTENCES ABOUT ONE PRESS, AND ONLY ONE WAS REACHABLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The hover CARD comes from `itemActionWord`; the strip under the bar comes
     * from `itemStrip`. The first version of this test drove the card only —
     * so a mutation making the strip say "click to equip" over a draught PASSED,
     * because the card still said "use". Two verbs for one button is how a
     * control stops being trusted, and the test could only see one of them.
     */
    const strip = itemStrip('Steadying Draught', ItemSlotAction.Use);
    expect(strip.text).toMatch(/use/i);
    expect(strip.text, 'the strip under the bar still offers to equip it').not.toMatch(/equip/i);

    const word = itemActionWord(ItemSlotAction.Use);
    expect(word).toMatch(/use/i);
    expect(word, 'the hover card still offers to equip it').not.toMatch(/equip|wear|put it on/i);

    // ...and the wearable case still says the other verb, in both places.
    expect(itemStrip('Coat', ItemSlotAction.Equip).text).toMatch(/equip/i);
    expect(itemActionWord(ItemSlotAction.Equip)).toMatch(/put it on/i);
  });

  it('is a live slot — pressing it does something', () => {
    // `isSlotDisabled` greys the states a press cannot act on. A new member that
    // fell through to "dead" would grey out the one slot that now works.
    const live = withDraught(ItemSlotAction.Use);
    const gone = withDraught(ItemSlotAction.Gone);
    expect(isSlotDisabled(live.slots[0] as HotbarSlot)).toBe(false);
    expect(isSlotDisabled(gone.slots[0] as HotbarSlot)).toBe(true);
  });
});
