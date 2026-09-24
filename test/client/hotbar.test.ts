import { cardStatLines } from '../../src/client/ui/panel.ts';
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HUD_MIN_W } from '../../src/client/render/canvas.ts';
import { PANEL_CORNER } from '../../src/client/ui/panel.ts';

/**
 * THE NARROWEST INTERFACE BOX THIS CLIENT CAN PRODUCE, DERIVED RATHER THAN TYPED.
 *
 * This was the literal 640 at four call sites, then
 * `DEFAULT_VIEWPORT.tilesW * TILE_PX` — which was the same number by
 * coincidence and stopped being so when the map's cell doubled. The hotbar has
 * never been laid out against the MAP; it is laid out against the box the
 * interface is drawn in, and that box has its own floor now. `HUD_MIN_W` is
 * exported for exactly this: there is no reason to hold a copy.
 */
const FLOOR_W = HUD_MIN_W;

import { DragKind, DraggablePanel } from '../../src/client/ui/drag.ts';
import {
  HOTBAR_HEADER_H,
  HOTBAR_INSET,
  HOTBAR_KEY_ROW,
  HOTBAR_KEY_ROWS,
  HOTBAR_SLOTS_DEFAULT,
  HOTBAR_SLOT_POOL,
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
  DEFAULT_HOTBAR_STYLE,
  hotbarCogRect,
  hotbarFloor,
  hotbarPanelSize,
  hotbarSettingText,
  hotbarSettingsButtons,
  hotbarSettingsHitAt,
  hotbarSettingsRect,
  snapHotbarStyle,
  stepHotbarStyle,
  hotbarKeyLabel,
  hotbarSlotForKey,
  hotbarSlotsForSize,
  isSlotDisabled,
  itemActionWord,
  itemSlotAction,
  itemStrip,
  slotRect,
  wornSlotOf,
} from '../../src/client/ui/hotbar.ts';
import { ResourceKind, TalentShape } from '../../src/shared/protocol.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { HotbarSlot, HotbarStyle, HotbarView } from '../../src/client/ui/hotbar.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';
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
 * test/client/turnbar.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function talent(over: Partial<LoadoutTalent> = {}): LoadoutTalent {
  return {
    id: 'talent:fog_step',
    name: 'Fog Step',
    icon: 'icon_active_fog_step',
    cost: { resource: 0 },
    usage: { type: 'standard', speed: 1 },
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SPLIT BELOW IS THE FIXTURE'S ARRANGEMENT, NOT THE BAR'S RULE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `FIRST_ITEM` was `FIRST_ITEM` — the boundary the BAR enforced, and
 * the assertions that read it were true of that rule. There is no boundary any
 * more: every slot takes either kind. So this fixture keeps the same PICTURE —
 * nine talents then four item slots, which is exactly what a default bar looked
 * like the day the partition was removed — purely so the drawing cases below
 * have one of each kind at a known index.
 *
 * NOTHING HERE MAY BE READ AS A RULE ABOUT THE BAR. The cases that used to
 * assert "index >= FIRST_ITEM is an item slot" are gone; what is left uses it
 * only to say "the fixture put an item HERE". A case that would still pass if
 * the bar refused an item on slot 0 is a case testing this fixture.
 */
const ITEM_TAIL = 4;
const FIRST_ITEM = HOTBAR_SLOTS_DEFAULT - ITEM_TAIL;

function barSlots(items: readonly HotbarSlot[] = []): HotbarSlot[] {
  const out: HotbarSlot[] = [];
  for (let i = 0; i < FIRST_ITEM; i += 1) {
    out.push(
      talentSlot({
        talent: talent({
          id: `talent:t${String(i)}`,
          name: `Talent ${String(i)}`,
          // NO POOL PRICE, DELIBERATELY. The cost readout draws in the same
          // corner family as the key digit, and draws nothing for a talent that
          // takes nothing from the pool — so these slots put no digit in the
          // recorded text for the key assertion to mistake for a key. (This was
          // `ap: 10`, two digits for the same reason, while the corner drew the
          // AP price.)
          cost: { resource: 0 },
        }),
      }),
    );
  }
  for (let i = 0; i < ITEM_TAIL; i += 1) out.push(items[i] ?? EMPTY_SLOT);
  return out;
}

function view(over: Partial<HotbarView> = {}): HotbarView {
  return { slots: barSlots(), hovered: -1, armed: -1, ...over };
}

function itemView(itemId: string): ItemView {
  // `compare: []` — an empty list is the honest answer for a fixture with no
  // body behind it. It no longer means "a bar slot cannot show rows": it can,
  // and `hotbarTipAt` draws them ABOVE the prose (it drew them under it once,
  // which is the bug the ordering test below pins). The rows a slot shows are
  // joined in main.ts out of the bag the binding names, so this fixture — which
  // has no bag — has nothing to join and says so.
  return { itemId, name: itemId, icon: itemId, tier: 'common', compare: [] };
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

/**
 * The bar where main.ts puts it by default on a `width`-wide, 480-tall screen:
 * the whole row's left edge, centred, at the foot. `stored` is a grip's size.
 */
function rectFor(width: number, stored: { w: number; h: number } | null = null): PanelRect {
  const size = hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, stored, width);
  const row = hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, null, width);
  return { x: Math.max(0, Math.floor((width - row.w) / 2)), y: 480 - size.h, w: size.w, h: size.h };
}

/** A bar given exactly the width of `across` slots a line. */
function rectAcross(across: number): PanelRect {
  return rectFor(1280, { w: HOTBAR_INSET * 2 + hotbarRowWidth(across), h: 1 });
}

// ---------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------

describe('geometry', () => {
  it('is one line of slots in its frame, and the total is DERIVED', () => {
    // The height main.ts's panel bands leave free at the foot of the screen.
    // Stated as a relation, so a change to any term moves the bands with it.
    expect(HOTBAR_TOTAL_H).toBe(HOTBAR_INSET * 2 + HOTBAR_HEADER_H + SLOT_PX);
    expect(hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, null, 1920).h).toBe(HOTBAR_TOTAL_H);
    expect(hotbarFloor()).toEqual({ w: HOTBAR_INSET * 2 + SLOT_PX, h: HOTBAR_TOTAL_H });
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

  it('fits every slot on one line on the narrowest backbuffer this client can render', () => {
    // 13*44 + 12*4 = 620 against the 640 floor render/canvas.ts pins as
    // `HUD_MIN_W`, and the frame's two insets make it 636. That is why the talent
    // half stopped at NINE: one more slot and the default bar wraps on the floor.
    expect(hotbarRowWidth(HOTBAR_SLOTS_DEFAULT)).toBe(620);
    const floor = hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, null, FLOOR_W);
    expect(floor.w).toBeLessThanOrEqual(FLOOR_W);
    expect(floor.h, 'the default bar wrapped on the floor').toBe(HOTBAR_TOTAL_H);
    expect(hotbarPanelSize(HOTBAR_SLOTS_DEFAULT + 1, null, FLOOR_W).h).toBeGreaterThan(
      HOTBAR_TOTAL_H,
    );
  });

  it('wraps a narrower bar onto more lines rather than hiding a slot', () => {
    // REPORTED: the bar was a strip the width of the screen with bare wings at
    // its sides. It is a panel whose width is the player's, and a narrow one
    // wraps as upstream's hotkey box does (engine/HotkeysIconsDisplay.lua:265-271).
    for (let across = 1; across <= HOTBAR_SLOTS_DEFAULT; across += 1) {
      const rect = rectAcross(across);
      const lines = Math.ceil(HOTBAR_SLOTS_DEFAULT / across);
      expect(rect.w, String(across)).toBe(HOTBAR_INSET * 2 + hotbarRowWidth(across));
      expect(rect.h, String(across)).toBe(
        HOTBAR_INSET * 2 + HOTBAR_HEADER_H + hotbarRowWidth(lines),
      );
      for (let i = 0; i < HOTBAR_SLOTS_DEFAULT; i += 1) {
        const r = slotRect(rect, i, HOTBAR_SLOTS_DEFAULT);
        const at = `${String(across)}:${String(i)}`;
        expect(r.x, at).toBeGreaterThanOrEqual(rect.x + HOTBAR_INSET);
        expect(r.x + r.w, at).toBeLessThanOrEqual(rect.x + rect.w - HOTBAR_INSET);
        expect(r.y, at).toBeGreaterThanOrEqual(rect.y + HOTBAR_INSET + HOTBAR_HEADER_H);
        expect(r.y + r.h, at).toBeLessThanOrEqual(rect.y + rect.h - HOTBAR_INSET);
      }
    }
  });

  it('is never narrower than one slot, or wider than the screen', () => {
    expect(hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, { w: 1, h: 1 }, 1280).w).toBe(hotbarFloor().w);
    expect(hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, { w: 5000, h: 1 }, 700).w).toBeLessThanOrEqual(
      700,
    );
  });

  it('round-trips every slot centre through the hit test at every shape', () => {
    for (const across of [1, 2, 5, HOTBAR_SLOTS_DEFAULT]) {
      const rect = rectAcross(across);
      for (let i = 0; i < HOTBAR_SLOTS_DEFAULT; i += 1) {
        const r = slotRect(rect, i, HOTBAR_SLOTS_DEFAULT);
        const cx = r.x + Math.floor(r.w / 2);
        const cy = r.y + Math.floor(r.h / 2);
        const at = `${String(across)}:${String(i)}`;
        expect(hotbarSlotAt(rect, cx, cy, HOTBAR_SLOTS_DEFAULT), at).toBe(i);
        // The corners too: a half-open box is where an off-by-one hides.
        expect(hotbarSlotAt(rect, r.x, r.y, HOTBAR_SLOTS_DEFAULT), at).toBe(i);
        expect(hotbarSlotAt(rect, r.x + r.w - 1, r.y + r.h - 1, HOTBAR_SLOTS_DEFAULT), at).toBe(i);
      }
      // The header and the frame are the bar, not a slot.
      const head = { x: rect.x + HOTBAR_INSET + 1, y: rect.y + HOTBAR_INSET + 1 };
      expect(hotbarSlotAt(rect, head.x, head.y, HOTBAR_SLOTS_DEFAULT)).toBe(-1);
      expect(hotbarSlotAt(rect, rect.x + 1, rect.y + rect.h - 2, HOTBAR_SLOTS_DEFAULT)).toBe(-1);
    }
    expect(hotbarSlotAt(null, 10, 10, HOTBAR_SLOTS_DEFAULT)).toBe(-1);
  });

  it('does not answer for a slot past the count it is given', () => {
    // Both numbers are the caller's. A stale, shorter count must not reach a slot
    // it does not know about: that press would fire whatever sits there. It is
    // the live case now rather than a hypothetical — the cogwheel and the grip
    // both change the count while the bar is on screen.
    const rect = rectFor(1280);
    const r = slotRect(rect, FIRST_ITEM + 1, HOTBAR_SLOTS_DEFAULT);
    expect(hotbarSlotAt(rect, r.x + 2, r.y + 2, HOTBAR_SLOTS_DEFAULT)).toBe(FIRST_ITEM + 1);
    expect(hotbarSlotAt(rect, r.x + 2, r.y + 2, FIRST_ITEM)).toBe(-1);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS CASE WAS `splits the row four and four, and says which half an index
   * is in`, AND THE SPLIT IS WHAT THE AUTHOR REPORTED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It walked `isItemSlotIndex` over every index and asserted the boundary. The
   * boundary is gone; what replaces it is the mapping that had to exist before
   * it could go — every slot in the pool wears a key, and the key it wears is
   * the key that fires it.
   */
  it('gives every slot in the pool a key, and nothing past it', () => {
    expect(HOTBAR_SLOT_POOL).toBe(HOTBAR_KEY_ROW * HOTBAR_KEY_ROWS);
    const labels = new Set<string>();
    for (let i = 0; i < HOTBAR_SLOT_POOL; i += 1) {
      const label = hotbarKeyLabel(i);
      expect(label, `slot ${String(i)} wears no key`).not.toBeNull();
      labels.add(label ?? '');
    }
    // NO TWO SLOTS SHARE ONE. A duplicate label is a box that lies about what
    // pressing it does, which is the failure the partition's mouse-only item
    // slots were introduced to avoid and this replaces.
    expect(labels.size).toBe(HOTBAR_SLOT_POOL);
    expect(hotbarKeyLabel(HOTBAR_SLOT_POOL)).toBeNull();
    expect(hotbarKeyLabel(-1)).toBeNull();
    /**
     * ...AND THE INVERSE AGREES AT EVERY POSITION, AGAINST THE ROW SPELLED OUT.
     *
     * THIS READ `String(digit + 1)`, WHICH WAS THE PAINT'S OWN ARITHMETIC. It
     * proved the label and the press agreed and said nothing about WHICH keys
     * the row is — so when the row grew to upstream's twelve
     * (`PlayerHotkeys.lua:314`) and the tenth became `0` rather than "10", this
     * fixture was the thing asserting the wrong answer.
     *
     * The literal below is the SPEC: the number row, left to right. Everything
     * else in the suite reads `HOTBAR_ROW_KEYS`; this one restates it on
     * purpose, because a spec asserted against itself is not a spec.
     */
    const ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
    expect(ROW).toHaveLength(HOTBAR_KEY_ROW);
    for (let digit = 0; digit < HOTBAR_KEY_ROW; digit += 1) {
      expect(hotbarKeyLabel(hotbarSlotForKey(digit, false))).toBe(ROW[digit]);
      expect(hotbarKeyLabel(hotbarSlotForKey(digit, true))).toBe(`\u21e7${String(ROW[digit])}`);
    }
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

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * AND AN ITEM CAN BE ON COOLDOWN NOW, WHICH IT COULD NOT WHEN THAT WAS WRITTEN.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * The Knot of Elsewhere rides `actor.cooldowns` keyed by its ITEM id, so the
   * number was on the wire from the day it shipped and nothing read it.
   * Observed live at `cooldowns: {item_knot_of_elsewhere: 25}`: the slot was
   * undimmed, carried no wedge, and its card still read *"press to use it"* —
   * a button promising something the server would refuse for the next
   * twenty-five turns, which is the exact shape of the bug this whole feature
   * was reported for.
   */
  it('greys a bound item that is still cooling, and lets a ready one alone', () => {
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Use, { cooldown: 25 }))).toBe(true);
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Use, { cooldown: 0 }))).toBe(false);
    // ABSENT MEANS READY, which is how the `cooldowns` frame spells it (the
    // server deletes the entry at zero) and how every slot built before this
    // field existed still behaves.
    expect(isSlotDisabled(itemSlot(ItemSlotAction.Use))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE DROP TEST — a refusal is an answer, not silence
// ---------------------------------------------------------------------------

describe('hotbarDropTargetAt', () => {
  const RECT = rectFor(1280);

  function centreOf(index: number): { x: number; y: number } {
    const r = slotRect(RECT, index, HOTBAR_SLOTS_DEFAULT);
    return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
  }

  it('answers BIND with the index for EVERY slot, whatever is in it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS WAS TWO CASES: BIND for the item half, TALENT for the talent half.
     * ═══════════════════════════════════════════════════════════════════════
     * The second one's note read *"the class talents cannot be rebound, so the
     * caller has to be able to say 'the first four slots are your class
     * talents' instead of letting the item snap back for no stated reason."*
     * There is nothing to refuse and nothing to say: `HotbarDropKind.Talent`
     * is gone from the union with the refusal it routed to.
     *
     * WALKED OVER A BAR HOLDING BOTH KINDS, so a drop test that had quietly
     * reacquired an opinion about the contents of the slot under it would fail
     * here rather than in somebody's hand.
     */
    for (let i = 0; i < HOTBAR_SLOTS_DEFAULT; i += 1) {
      const p = centreOf(i);
      expect(hotbarDropTargetAt(RECT, p.x, p.y, HOTBAR_SLOTS_DEFAULT), `slot ${String(i)}`).toEqual(
        { kind: HotbarDropKind.Bind, index: i },
      );
    }
  });

  it('answers MISS off the bar, so whatever is underneath still gets the release', () => {
    const r = slotRect(RECT, 0, HOTBAR_SLOTS_DEFAULT);
    expect(hotbarDropTargetAt(RECT, 0, r.y, HOTBAR_SLOTS_DEFAULT)).toEqual({
      kind: HotbarDropKind.Miss,
    });
    expect(hotbarDropTargetAt(RECT, r.x, r.y - 1, HOTBAR_SLOTS_DEFAULT)).toEqual({
      kind: HotbarDropKind.Miss,
    });
  });

  it('reads the SAME geometry as the hover test at every viewport', () => {
    for (const width of WIDTHS) {
      const rect = rectFor(width);
      for (let i = 0; i < HOTBAR_SLOTS_DEFAULT; i += 1) {
        const r = slotRect(rect, i, HOTBAR_SLOTS_DEFAULT);
        const x = r.x + 1;
        const y = r.y + 1;
        const drop = hotbarDropTargetAt(rect, x, y, HOTBAR_SLOTS_DEFAULT);
        const hover = hotbarSlotAt(rect, x, y, HOTBAR_SLOTS_DEFAULT);
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
      rect: rectFor(width),
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
    // happens to be drawn next (ui/panel.ts's `drawScrim` records the same trap).
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
    // complaint. It reads EMPTY rather than ITEM: a slot takes either kind
    // now, and naming one of them would send a player who wanted a talent on
    // it to the wrong panel.
    expect(texts.filter((t) => t === 'EMPTY').length).toBe(ITEM_TAIL);
    expect(texts).not.toContain('ITEM');
  });

  it('lights the empty slots on a live ITEM drag and not on a panel drag', () => {
    const carried = paint(
      view({ drag: { kind: DragKind.Carried, itemId: 'item_watchmans_coat' } }),
    );
    // The well is the same skin in every state now; HOVER is a drawn gold edge
    // rather than a second PNG, so what this pins is that the slot is PAINTED
    // during a live item drag at all. The edge itself is a fill, not a sprite.
    expect(carried.asked).toContain('ui_panel_9slice_inset');
    // BIND, not EMPTY: while something droppable is in hand the caption says
    // what the release will DO.
    expect(carried.texts).toContain('BIND');
    expect(carried.texts).not.toContain('EMPTY');

    // A worn item dragged off the doll is equally bindable.
    const worn = paint(view({ drag: { kind: DragKind.Worn, slot: 'body' } }));
    expect(worn.texts).toContain('BIND');

    // A panel header is clamped into panelBand and can never reach the hotbar.
    const panel = paint(view({ drag: { kind: DragKind.Panel, panel: DraggablePanel.Inventory } }));
    expect(panel.texts).not.toContain('BIND');
    expect(panel.texts).toContain('EMPTY');
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

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A KEY ON EVERY SLOT, AND THIS CASE USED TO ASSERT THE OPPOSITE.
     * ═══════════════════════════════════════════════════════════════════════
     * It read *"one digit per TALENT slot, in order, and none on an item slot.
     * The item half stays mouse-only: a digit there would have to be 0 or a
     * punctuation cap"* — the partition, stated as a drawing rule. The item
     * half is not mouse-only and the key past nine is `\u21e7` plus a digit, so
     * what is pinned is the label `hotbarKeyLabel` gives for that index.
     *
     * AGAINST THE FUNCTION, NOT A WRITTEN-OUT LIST. The painter and the press
     * read one mapping; a test that re-derived the list here would be a third
     * copy, and the one that could disagree silently.
     */
    const keys = texts.filter((t) => /^\u21e7?[0-9=-]$/.test(t));
    expect(keys).toEqual(
      Array.from({ length: HOTBAR_SLOTS_DEFAULT }, (_unused, i) => hotbarKeyLabel(i)),
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
      ['empty', view(), 'EMPTY'],
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
        HOTBAR_SLOTS_DEFAULT * 4,
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

    // ONE SENTENCE FOR AN EMPTY SLOT, whichever slot it is. It used to pick a
    // noun off `isItemSlotIndex`, and naming one of the two kinds a slot now
    // takes would send a player to the wrong panel — the same bug the old
    // split-sentence was written to avoid, with the halves swapped.
    const onEmpty = paint(view({ hovered: FIRST_ITEM }));
    expect(onEmpty.texts.some((t) => t.includes('drag a talent or an item here'))).toBe(true);
    const onEmptyKeyed = paint(view({ hovered: 0, slots: [EMPTY_SLOT] }));
    expect(onEmptyKeyed.texts.some((t) => t.includes('drag a talent or an item here'))).toBe(true);

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

    // THE STRIP LEADS WITH THE KEY THE BOX WEARS, not `index + 1`: slot 10
    // reads `\u21e71.` and pressing `10` does nothing at all.
    const onTalent = paint(view({ hovered: 1 }));
    expect(onTalent.texts.some((t) => t.includes('2. Talent 1'))).toBe(true);
    const onShifted = paint(view({ hovered: FIRST_ITEM }));
    expect(onShifted.texts.some((t) => t.startsWith(`${hotbarKeyLabel(FIRST_ITEM) ?? ''}.`))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// THE REFUSAL — a slot that will not fit is announced, never dropped in silence
// ---------------------------------------------------------------------------

describe('a bar narrower than its row', () => {
  function paintAt(stored: { w: number; h: number } | null): string[] {
    const texts: string[] = [];
    drawHotbar({
      ctx: new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
            if (prop === 'fillText')
              return (text: string) => {
                texts.push(text);
              };
            if (prop === 'canvas') return undefined;
            return () => undefined;
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D,
      sprites: { sprite: () => undefined },
      view: view(),
      rect: rectFor(1280, stored),
    });
    return texts;
  }

  it('draws every slot, wrapped, and has nothing to apologise for', () => {
    const texts = paintAt({ w: hotbarFloor().w, h: 1 });
    expect(texts.filter((t) => /^\u21e7?[0-9=-]$/.test(t))).toEqual(
      Array.from({ length: HOTBAR_SLOTS_DEFAULT }, (_unused, i) => hotbarKeyLabel(i)),
    );
    expect(texts.filter((t) => t === 'EMPTY').length).toBe(ITEM_TAIL);
    // The strip used to say `9 of 13 slots` or `hotbar hidden` here. Nothing is hidden.
    expect(texts.some((t) => t.includes('slots —') || t.includes('hidden'))).toBe(false);
  });

  it('draws nothing at all before the loadout arrives', () => {
    const calls: string[] = [];
    drawHotbar({
      ctx: new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'canvas') return undefined;
            return (...args: unknown[]) => {
              calls.push(`${prop}(${String(args.length)})`);
            };
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D,
      sprites: { sprite: () => undefined },
      view: { slots: [], hovered: -1, armed: -1 },
      rect: rectFor(1280),
    });
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

  const barView = (): HotbarView => ({ slots: barSlots(), hovered: -1, armed: -1 });

  it('names the talent under the pointer and what it costs', () => {
    const view = barView();
    const rect = slotRect(rectFor(W), 0, view.slots.length);
    const card = hotbarTipAt(view, rectFor(W), rect.x + 2, rect.y + 2);
    expect(card).not.toBeNull();
    expect(card?.title.length).toBeGreaterThan(0);
    // A LABELLED ROW IN `lines`, not a clause in `meta`: `meta` carries what
    // is true this instant, the rows carry what the talent costs. What it costs
    // in TIME is upstream's `Usage Speed:` row, where `AP cost:` was until v32.
    expect((card?.lines ?? []).join('\n')).toContain('Usage Speed: Standard (100% of a turn)');
    expect((card?.lines ?? []).join('\n')).not.toContain('AP cost');
  });

  it('names the pool the body actually spends, not always Resolve', () => {
    /**
     * The cost clause was the hard-coded word `resolve`, so an Alchemist
     * hovering Concussion Flask read "2 resolve" directly above a description
     * that said "2 Reagents" -- one card naming two pools, and the wrong one
     * for three of the four classes.
     */
    // The bar fixture's talents cost no resource, and a zero cost prints no
    // clause at all — so the pool has to actually be spent for a word to appear.
    const slots = barSlots();
    slots[0] = talentSlot({
      talent: talent({
        id: 'talent:costed',
        name: 'Costed',
        cost: { resource: 2 },
      }),
    });
    const rect = slotRect(rectFor(W), 0, slots.length);
    const tipFor = (pool: ResourceKind): string => {
      const card = hotbarTipAt(
        { slots, hovered: -1, armed: -1, pool },
        rectFor(W),
        rect.x + 2,
        rect.y + 2,
      );
      return (card?.lines ?? []).join('\n');
    };

    expect(tipFor(ResourceKind.Reagents)).toContain('Reagents');
    expect(tipFor(ResourceKind.Focus)).toContain('Focus');
    // AND THE WATCHMAN'S OWN WORD IS NOT SPECIAL. The bug passed every earlier
    // reading of this card because Resolve happened to be what it said.
    expect(tipFor(ResourceKind.Reagents)).not.toContain('Resolve');
  });

  it('prices the cooldown on a talent that is ready, not only one that is down', () => {
    // `cooling - 3t` is STATE and shows only while the talent is down. The
    // cooldown a talent COSTS is what a player compares two buttons on, and it
    // was reachable only by reading the prose -- which is why 46 talents had
    // taken to restating their own costs in a sentence.
    const view = barView();
    const rect = slotRect(rectFor(W), 0, view.slots.length);
    const card = hotbarTipAt(view, rectFor(W), rect.x + 2, rect.y + 2);
    expect((card?.lines ?? []).join('\n')).toContain('Cooldown:');
    // `cooling - Nt` is STATE and belongs to `meta`, which a ready talent
    // leaves empty. The two must not be confusable.
    expect(card?.meta ?? '').not.toContain('cooling');
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
    const rect = slotRect(rectFor(W), 0, cooling.slots.length);
    const card = hotbarTipAt(cooling, rectFor(W), rect.x + 2, rect.y + 2);
    expect(card?.meta ?? '').toContain('cooling');
    expect(card?.meta ?? '').toContain('not affordable');
  });

  it('says nothing off the bar', () => {
    expect(hotbarTipAt(barView(), rectFor(W), 2, 2)).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAR IS WHERE A DRAUGHT IS ACTUALLY DRUNK, and it used to name it and
   * stop.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `hotbarTipAt` returned `{ title, meta, lines: [] }` for an item slot: a name
   * and the word "drink". So the one surface a consumable is used from was the
   * one surface that never said what using it would do — while the bag's card,
   * reading the same wire field, said it in full. Reported from play as part of
   * "inventory, equipped items, floor items and anything i may be missing".
   */
  it('says what a bound item does, not just its name', () => {
    // A BOUND SLOT BUILT ON PURPOSE. `barSlots()` fills the item half with
    // EMPTY_SLOT, so the bar has no binding to hover unless one is supplied.
    const bound = itemSlot(ItemSlotAction.Use, {
      desc: 'Restores 24 hit points.  Ashwick work.',
      rows: [{ label: 'Armour', value: '+3' }],
    });
    const withFacts: HotbarView = { slots: barSlots([bound]), hovered: -1, armed: -1 };
    const index = withFacts.slots.findIndex((slot) => slot.kind === HotbarSlotKind.Item);
    expect(index, 'the fixture bar has no bound item').toBeGreaterThanOrEqual(0);
    const rect = slotRect(rectFor(W), index, withFacts.slots.length);
    const card = hotbarTipAt(withFacts, rectFor(W), rect.x + 2, rect.y + 2);
    expect(card, 'the bound item produced no card').not.toBeNull();
    expect(card?.lines.join(' ')).toContain('Restores 24 hit points.');
    expect(card?.lines.join(' ')).toContain('Armour');
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════
   * AND IT WRAPS, WHICH IS WHY A SENTENCE FITS ON A CARD AT ALL.
   * ══════════════════════════════════════════════════════════════════════════════
   *
   * The talent branch called `wrapForCard`; the item branch pushed the raw
   * string. Measured at the Activity viewport the Knot of Elsewhere's card was
   * 924 pixels wide — 73% of the window, one line, laid over the Case Log —
   * and at the 640 floor it truncated at *"Pull it again to call it of…"*,
   * losing the cancel affordance and the lead-only refusal. The bag's card
   * wrapped the identical sentence correctly, so two surfaces disagreed about
   * one string.
   *
   * NO PIXEL MEASUREMENT HERE: the measurer needs a DOM canvas and returns the
   * whole string when there is none, so what is asserted is the SHAPE — the
   * long sentence no longer arrives as one undivided line while a short one is
   * left alone.
   */
  it('lays an item sentence out exactly as it lays a talent sentence out', () => {
    const long =
      'Pull it and, 20 turns later, it takes the party out to the moor you came in from. ' +
      'Pull it again to call it off. Not usable everywhere, and only by whoever is leading.';

    // A TWO-SLOT BAR BUILT BY HAND, because `barSlots` owns the talent half and
    // would discard the description under test.
    const view: HotbarView = {
      slots: [
        talentSlot({ talent: { ...talent(), desc: long } }),
        itemSlot(ItemSlotAction.Use, { desc: long }),
      ],
      hovered: -1,
      armed: -1,
    };
    const talentRect = slotRect(rectFor(W), 0, view.slots.length);
    const itemRect = slotRect(rectFor(W), 1, view.slots.length);
    const talentCard = hotbarTipAt(view, rectFor(W), talentRect.x + 2, talentRect.y + 2);
    const itemCard = hotbarTipAt(view, rectFor(W), itemRect.x + 2, itemRect.y + 2);

    expect(itemCard, 'the bound item produced no card').not.toBeNull();
    expect(talentCard, 'the talent produced no card').not.toBeNull();
    // THE RULE IS THAT THEY AGREE. Under this runner there is no DOM measurer
    // and both come back whole, so what this pins is the JOIN rather than a
    // pixel: an item branch that stops calling the wrapper starts disagreeing
    // with the talent branch, in one assertion, whatever the environment.
    //
    // CONTAINMENT RATHER THAN EQUALITY, because a talent card carries stat rows
    // above its prose and a `Scales:` row below it. What must match is the
    // paragraph, line for line: two surfaces breaking one sentence in two
    // different places is the bug.
    const prose = itemCard?.lines ?? [];
    expect(prose.length, 'the item card has no prose at all').toBeGreaterThan(0);
    expect(talentCard?.lines).toEqual(expect.arrayContaining([...prose]));
    expect(prose.join(' ')).toContain('only by whoever is leading');
  });

  /**
   * AND THE SOURCE SAYS IT ONCE, because this runner is deliberately node-only
   * (see vitest.config.ts: *"no test for the canvas, no jsdom"*) and the
   * wrapper is a no-op without a DOM. The assertion above cannot see a wrap; it
   * can only see a disagreement. This one sees the call.
   */
  it('runs a bound item`s prose through the card wrapper', () => {
    const source = readFileSync(new URL('../../src/client/ui/hotbar.ts', import.meta.url), 'utf8');
    const branch = source.slice(source.indexOf('if (slot.kind === HotbarSlotKind.Item) {'));
    const prose = branch.slice(0, branch.indexOf('itemMetaLine'));
    expect(prose, 'the item card builds its prose unwrapped').toContain('wrapForCard(slot.desc)');
  });

  /**
   * AND THE HEADER SAYS WHY IT CANNOT BE PRESSED, in the talent card's own
   * words and units. It read *"press to use it"* for all thirty turns of the
   * Knot's cooldown.
   */
  it('says how long an item has left instead of offering the verb', () => {
    const cooling = itemSlot(ItemSlotAction.Use, { cooldown: 25 });
    const view: HotbarView = { slots: barSlots([cooling]), hovered: -1, armed: -1 };
    const index = view.slots.findIndex((slot) => slot.kind === HotbarSlotKind.Item);
    const rect = slotRect(rectFor(W), index, view.slots.length);
    const card = hotbarTipAt(view, rectFor(W), rect.x + 2, rect.y + 2);
    expect(card?.meta).toBe('cooling — 25t');

    const ready: HotbarView = {
      slots: barSlots([itemSlot(ItemSlotAction.Use)]),
      hovered: -1,
      armed: -1,
    };
    const readyCard = hotbarTipAt(ready, rectFor(W), rect.x + 2, rect.y + 2);
    expect(readyCard?.meta).toBe('press to use it');
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
    drawHotbar({ ctx, sprites, view: v, rect: rectFor(W) });
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
    const rect = slotRect(rectFor(W), 0, withSustain(true).slots.length);
    const up = hotbarTipAt(withSustain(true), rectFor(W), rect.x + 2, rect.y + 2);
    const down = hotbarTipAt(withSustain(false), rectFor(W), rect.x + 2, rect.y + 2);
    expect(up?.meta ?? '').toContain('UP');
    expect(down?.meta ?? '').toContain('press to raise');
  });

  it('says nothing about stances on a talent that is not one', () => {
    const rect = slotRect(rectFor(W), 0, withSustain(undefined).slots.length);
    const card = hotbarTipAt(withSustain(undefined), rectFor(W), rect.x + 2, rect.y + 2);
    expect(card?.meta ?? '').not.toContain('press to raise');
    expect(card?.meta ?? '').not.toContain('UP');
    // ...and it still says the ordinary things.
    expect((card?.lines ?? []).join('\n')).toContain('Usage Speed:');
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
    const rect = slotRect(rectFor(W), 0, view.slots.length);
    const card = hotbarTipAt(view, rectFor(W), rect.x + 2, rect.y + 2);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STATS FIRST, PROSE LAST — `Object.lua:2027-2028`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream merges `getUseDesc` at the very END of `getTextualDesc`, after the
 * wielder block. `inventoryTipAt` was corrected to that order and cites it; this
 * card kept the old one under a comment claiming it MATCHED the bag's — *"the
 * stats come last, under the prose, in the order `inventoryTipAt` uses"* — while
 * doing the reverse.
 *
 * It matters on the one item that has both. The Draught of Mending's sentence
 * pushed its numbers down the card, on the surface a player is looking at while
 * deciding whether to drink it — and the action bar is the surface the report
 * that started this work actually named.
 */
describe('an item card puts its numbers above its sentence', () => {
  const W = 640;
  const ROWS = [
    { label: 'Armour', value: '9' },
    { label: 'Defence', value: '21' },
  ];
  const PROSE = 'Restores 40 hit points.';

  function itemTip(over: Partial<HotbarSlot> = {}): readonly string[] {
    const slots = barSlots();
    slots[0] = itemSlot(ItemSlotAction.Use, {
      itemId: 'item_draught_mending',
      name: 'Draught of Mending',
      icon: 'item_draught_mending',
      desc: PROSE,
      rows: ROWS,
      ...over,
    });
    const view: HotbarView = { slots, hovered: -1, armed: -1 };
    const rect = slotRect(rectFor(W), 0, slots.length);
    return hotbarTipAt(view, rectFor(W), rect.x + 2, rect.y + 2)?.lines ?? [];
  }

  it('draws every stat before the prose line', () => {
    const lines = itemTip();
    const prose = lines.indexOf(PROSE);
    expect(prose, 'the sentence is missing from the card').toBeGreaterThan(-1);
    // EVERY row, not just the first: an ordering bug that put one stat above the
    // prose and the rest below would pass a "first line is a stat" check.
    for (const row of ROWS) {
      const at = lines.findIndex((l) => l.startsWith(row.label));
      expect(at, `${row.label} is missing`).toBeGreaterThan(-1);
      expect(at, `${row.label} fell below the prose`).toBeLessThan(prose);
    }
  });

  /** A coat has numbers and no sentence; a draught with no rows is still legal. */
  it('is happy with either half missing', () => {
    expect(itemTip({ desc: '' })).toEqual(cardStatLines(ROWS));
    expect(itemTip({ rows: [] })).toEqual([PROSE]);
  });
});

// ---------------------------------------------------------------------------
// THE COGWHEEL: LAYOUT, SIZE AND FADE
// ---------------------------------------------------------------------------

describe('the bar’s cogwheel settings', () => {
  /**
   * Asked for: the bar's own settings button, like the case log's, with a setting
   * to stand it on end along with the others. Upstream offers icon sizes "From
   * 32 to 64" (GameOptions.lua:307) and lays its box out row by row or column by
   * column (engine/HotkeysIconsDisplay.lua:265-278).
   */
  const VERTICAL: HotbarStyle = { ...DEFAULT_HOTBAR_STYLE, vertical: true };
  const HUGE: HotbarStyle = { ...DEFAULT_HOTBAR_STYLE, icon: 64 };
  const rectIn = (
    style: HotbarStyle,
    stored: { w: number; h: number } | null = null,
  ): PanelRect => {
    const size = hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, stored, 1280, style, 480);
    return { x: 100, y: 20, w: size.w, h: size.h };
  };

  it('stands the bar on end: its slots run down a column, then across', () => {
    const tall = HOTBAR_INSET * 2 + HOTBAR_HEADER_H + hotbarRowWidth(5);
    const rect = rectIn(VERTICAL, { w: 1, h: tall });
    expect(rect.h).toBe(tall);
    expect(rect.w).toBe(HOTBAR_INSET * 2 + hotbarRowWidth(Math.ceil(HOTBAR_SLOTS_DEFAULT / 5)));
    const first = slotRect(rect, 0, HOTBAR_SLOTS_DEFAULT, VERTICAL);
    const down = slotRect(rect, 1, HOTBAR_SLOTS_DEFAULT, VERTICAL);
    const across = slotRect(rect, 5, HOTBAR_SLOTS_DEFAULT, VERTICAL);
    expect(down.x).toBe(first.x);
    expect(down.y).toBeGreaterThan(first.y);
    expect(across.y).toBe(first.y);
    expect(across.x).toBeGreaterThan(first.x);
  });

  it('scales the slot with the icon, up to upstream’s 64', () => {
    const huge = rectIn(HUGE);
    expect(slotRect(huge, 0, HOTBAR_SLOTS_DEFAULT, HUGE).w).toBe(SLOT_PX * 2);
    const one = HOTBAR_INSET * 2 + SLOT_PX * 2;
    expect(hotbarFloor(HUGE)).toEqual({ w: one, h: one + HOTBAR_HEADER_H });
    expect(hotbarFloor(DEFAULT_HOTBAR_STYLE)).toEqual({
      w: HOTBAR_INSET * 2 + SLOT_PX,
      h: HOTBAR_TOTAL_H,
    });
  });

  it('round-trips every slot through the hit test at every style, inside the frame', () => {
    const styles: HotbarStyle[] = [
      DEFAULT_HOTBAR_STYLE,
      VERTICAL,
      HUGE,
      { vertical: true, icon: 48, opacity: 60, slots: HOTBAR_SLOTS_DEFAULT },
    ];
    for (const style of styles) {
      for (const stored of [null, hotbarFloor(style)]) {
        const rect = rectIn(style, stored);
        for (let i = 0; i < HOTBAR_SLOTS_DEFAULT; i += 1) {
          const r = slotRect(rect, i, HOTBAR_SLOTS_DEFAULT, style);
          const at = `${JSON.stringify(style)} ${String(i)}`;
          const cx = r.x + Math.floor(r.w / 2);
          const cy = r.y + Math.floor(r.h / 2);
          expect(hotbarSlotAt(rect, cx, cy, HOTBAR_SLOTS_DEFAULT, style), at).toBe(i);
          expect(r.x, at).toBeGreaterThanOrEqual(rect.x + HOTBAR_INSET);
          expect(r.x + r.w, at).toBeLessThanOrEqual(rect.x + rect.w - HOTBAR_INSET);
          expect(r.y, at).toBeGreaterThanOrEqual(rect.y + HOTBAR_INSET + HOTBAR_HEADER_H);
          expect(r.y + r.h, at).toBeLessThanOrEqual(rect.y + rect.h - HOTBAR_INSET);
        }
      }
    }
  });

  it('steps each setting, and stops at its ends', () => {
    expect(stepHotbarStyle(DEFAULT_HOTBAR_STYLE, 'vertical', 1).vertical).toBe(true);
    expect(stepHotbarStyle(VERTICAL, 'vertical', 1).vertical).toBe(true);
    expect(stepHotbarStyle(VERTICAL, 'vertical', -1).vertical).toBe(false);
    expect(stepHotbarStyle(DEFAULT_HOTBAR_STYLE, 'icon', -1).icon).toBe(32);
    expect(stepHotbarStyle(DEFAULT_HOTBAR_STYLE, 'icon', 1).icon).toBe(48);
    expect(stepHotbarStyle(HUGE, 'icon', 1).icon).toBe(64);
    expect(stepHotbarStyle(DEFAULT_HOTBAR_STYLE, 'opacity', 1).opacity).toBe(100);
    expect(stepHotbarStyle(DEFAULT_HOTBAR_STYLE, 'opacity', -1).opacity).toBe(80);
  });

  it('snaps a style from another build onto the nearest step', () => {
    expect(snapHotbarStyle({ vertical: true, icon: 50, opacity: 55, slots: 7 })).toEqual({
      vertical: true,
      icon: 48,
      opacity: 60,
      // CLAMPED, NOT SNAPPED. The count has no steps — every whole number from
      // one to the pool is a bar somebody might want — so seven survives
      // unchanged where 50 becomes 48.
      slots: 7,
    });
    // ...AND THE CLAMP IS BOTH ENDS. A file written by a build with a bigger
    // pool would otherwise hand this one a count it has no key for.
    expect(snapHotbarStyle({ ...DEFAULT_HOTBAR_STYLE, slots: 999 }).slots).toBe(HOTBAR_SLOT_POOL);
    expect(snapHotbarStyle({ ...DEFAULT_HOTBAR_STYLE, slots: 0 }).slots).toBe(1);
    expect(snapHotbarStyle({ ...DEFAULT_HOTBAR_STYLE, slots: -4 }).slots).toBe(1);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COGWHEEL ADDS SLOTS, AND THE GRIP ADDS THE SAME ONES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Two controls, one number — asked for as two requests: *"i want the cogwheel
   * settings button for the action bar to allow you to add more slots to
   * expand"* and *"resizing the actionbar should dynamically add slots."*
   */
  it('steps the slot count one at a time and stops at both ends', () => {
    const at = (n: number): HotbarStyle => ({ ...DEFAULT_HOTBAR_STYLE, slots: n });
    expect(stepHotbarStyle(at(9), 'slots', 1).slots).toBe(10);
    expect(stepHotbarStyle(at(9), 'slots', -1).slots).toBe(8);
    expect(stepHotbarStyle(at(1), 'slots', -1).slots).toBe(1);
    expect(stepHotbarStyle(at(HOTBAR_SLOT_POOL), 'slots', 1).slots).toBe(HOTBAR_SLOT_POOL);
    // THE ROW READS THE NUMBER ITSELF. There is no name for a bar of thirteen
    // the way `Large` names an icon size, and inventing one would hide the only
    // fact somebody pressing `+` is watching.
    expect(hotbarSettingText(at(13), 'slots')).toBe('13');
  });

  it('derives the count from the dragged size, as upstream derives its columns', () => {
    /**
     * PORTED: `HotkeysIconsDisplay.lua:108-109` is
     * `max_cols = floor(w / frames.w)` and `max_rows = floor(h / frames.h)`,
     * and the layout loop stops when it runs out of either (`:270`, `:276`).
     */
    const oneRow = (n: number): { w: number; h: number } => ({
      w: HOTBAR_INSET * 2 + hotbarRowWidth(n),
      h: HOTBAR_TOTAL_H,
    });
    for (let n = 1; n <= HOTBAR_SLOTS_DEFAULT; n += 1) {
      expect(hotbarSlotsForSize(oneRow(n)), `one row of ${String(n)}`).toBe(n);
    }
    // A SECOND ROW IS A SECOND ROW OF SLOTS, which is the whole gesture.
    const twoRows = { w: oneRow(5).w, h: HOTBAR_TOTAL_H + SLOT_PX + 4 };
    expect(hotbarSlotsForSize(twoRows)).toBe(10);
    // AT LEAST ONE, AT MOST THE POOL.
    expect(hotbarSlotsForSize({ w: 0, h: 0 })).toBe(1);
    expect(hotbarSlotsForSize({ w: 100000, h: 100000 })).toBe(HOTBAR_SLOT_POOL);
  });

  it('is a fixed point: a size gives a count that gives the same size back', () => {
    /**
     * ═══ THE BUG THIS RULES OUT IS A PANEL THAT WALKS A PIXEL A FRAME ═══
     * The grip writes the COUNT and `hudLayout` re-derives the RECT from the
     * count on the next frame. If `size -> count -> size` were not a fixed
     * point the bar would resize itself every frame for as long as it was on
     * screen, which is not something a drag test would catch — the gesture ends
     * and the panel keeps moving.
     */
    for (const style of [DEFAULT_HOTBAR_STYLE, HUGE, VERTICAL]) {
      for (let n = 1; n <= HOTBAR_SLOT_POOL; n += 1) {
        const size = hotbarPanelSize(n, null, 4000, style, 4000);
        const count = hotbarSlotsForSize(size, style);
        const again = hotbarPanelSize(count, size, 4000, style, 4000);
        expect(count, `${JSON.stringify(style)} ${String(n)}`).toBe(n);
        expect(again, `${JSON.stringify(style)} ${String(n)}`).toEqual(size);
      }
    }
  });

  it('names each setting as a player reads it', () => {
    expect(hotbarSettingText(DEFAULT_HOTBAR_STYLE, 'vertical')).toBe('Horizontal');
    expect(hotbarSettingText(VERTICAL, 'vertical')).toBe('Vertical');
    expect(hotbarSettingText(DEFAULT_HOTBAR_STYLE, 'icon')).toBe('Normal');
    expect(hotbarSettingText(HUGE, 'icon')).toBe('Huge');
    expect(hotbarSettingText({ ...DEFAULT_HOTBAR_STYLE, opacity: 60 }, 'opacity')).toBe('60%');
  });

  it('presses the button it drew, swallows its own background, and nothing else', () => {
    const pop = hotbarSettingsRect(rectFor(1280), 1280, 480, 17);
    const buttons = hotbarSettingsButtons(pop);
    // SLOTS IS FIRST: it is the one row that changes what the bar HOLDS, and a
    // player who opened the cogwheel for it should not have to read past two
    // appearance settings to find it.
    expect(buttons.map((b) => `${b.key}${String(b.by)}`)).toEqual([
      'slots-1',
      'slots1',
      'vertical-1',
      'vertical1',
      'icon-1',
      'icon1',
      'opacity-1',
      'opacity1',
    ]);
    for (const b of buttons) {
      expect(hotbarSettingsHitAt(pop, b.rect.x + 1, b.rect.y + 1)).toEqual({
        key: b.key,
        by: b.by,
      });
    }
    expect(hotbarSettingsHitAt(pop, pop.x + 2, pop.y + 2)).toBe('inside');
    expect(hotbarSettingsHitAt(pop, pop.x - 1, pop.y)).toBeNull();
  });

  it('opens above the bar when there is room, below it when not, and on the screen', () => {
    const bar = rectFor(1280);
    const above = hotbarSettingsRect(bar, 1280, 480, 17);
    expect(above.y + above.h).toBeLessThanOrEqual(bar.y);
    const high = { ...bar, y: 20 };
    expect(hotbarSettingsRect(high, 1280, 480, 17).y).toBeGreaterThanOrEqual(high.y + high.h);
    const left = hotbarSettingsRect({ ...bar, x: 0, w: hotbarFloor().w }, 1280, 480, 17);
    expect(left.x).toBeGreaterThanOrEqual(0);
    expect(left.x + left.w).toBeLessThanOrEqual(1280);
  });

  it('puts its cogwheel in the header, clear of every slot', () => {
    const rect = rectFor(1280);
    const cog = hotbarCogRect(rect);
    expect(cog.y + cog.h).toBeLessThanOrEqual(rect.y + HOTBAR_INSET + HOTBAR_HEADER_H);
    expect(cog.x + cog.w).toBeLessThanOrEqual(rect.x + rect.w - HOTBAR_INSET);
    expect(hotbarSlotAt(rect, cog.x + 1, cog.y + 1, HOTBAR_SLOTS_DEFAULT)).toBe(-1);
  });

  function events(style: HotbarStyle): string[] {
    const out: string[] = [];
    drawHotbar({
      ctx: new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
            if (prop === 'canvas') return undefined;
            return (...args: unknown[]) => {
              out.push(`${prop}(${args.map(String).join(',')})`);
            };
          },
          set: (_t, prop: string, value: unknown) => {
            if (prop === 'globalAlpha') out.push(`alpha=${String(value)}`);
            return true;
          },
        },
      ) as unknown as CanvasRenderingContext2D,
      sprites: { sprite: () => undefined },
      view: view(),
      rect: rectIn(style),
      style,
    });
    return out;
  }

  it('fades the frame and never the slots', () => {
    const out = events({ ...DEFAULT_HOTBAR_STYLE, opacity: 40 });
    expect(out).toContain('alpha=0.4');
    const firstDigit = out.findIndex((e) => e.startsWith('fillText(1,'));
    expect(firstDigit).toBeGreaterThan(0);
    const alphas = out.slice(0, firstDigit).filter((e) => e.startsWith('alpha='));
    expect(alphas[alphas.length - 1]).toBe('alpha=1');
  });

  it('draws a bigger slot by scaling the drawing, inside a save and restore', () => {
    const out = events(HUGE);
    expect(out.filter((e) => e === 'scale(2,2)').length).toBe(HOTBAR_SLOTS_DEFAULT);
    expect(out.filter((e) => e.startsWith('save(')).length).toBe(
      out.filter((e) => e.startsWith('restore(')).length,
    );
    expect(events(DEFAULT_HOTBAR_STYLE).some((e) => e.startsWith('scale('))).toBe(false);
  });
});
