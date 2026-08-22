import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  DEFAULT_KEYMAP,
  SLOT_DEFAULT,
  SLOT_NONE,
  SLOTS_PER_ACTION,
  actionById,
  bindingsFor,
  canDeliver,
  clearBinding,
  compileKeymap,
  conflictsFor,
  labelFor,
  labelForBinding,
  parseBinding,
  pressesFor,
  resetAll,
  resetOne,
  resolve,
  resolveAction,
  setBinding,
} from '../../../src/client/input/keymap.ts';
import { KEYBIND_MAX_ACTIONS } from '../../../src/shared/protocol.ts';
import { Dir } from '../../../src/shared/coords.ts';
import { TurnCommand, UiCommand } from '../../../src/client/input/keys.ts';
import type { ActionDef, Binding, KeyRemap } from '../../../src/client/input/keymap.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEYMAP MODEL. PURE — NOTHING IS FAKED HERE, BECAUSE NOTHING IS DOM.
 * ═══════════════════════════════════════════════════════════════════════════
 * test/client/input/keys.test.ts has to install `KeyboardEvent` and
 * `HTMLElement` on `globalThis` before it can reach keys.ts at all. This file
 * installs nothing: `compileKeymap`, `resolve` and `conflictsFor` take plain
 * records, and the conflict detector walks synthetic `{ key, code }` presses.
 * That purity is the reason the model was extracted into its own module rather
 * than grown inside the handler.
 *
 * THE FIRST BLOCK IS THE REGRESSION NET FOR THE EXTRACTION ITSELF. It asserts
 * the seven compiled tables against the seven literal tables keys.ts declared
 * before v11, row for row. If the registry ever drops or mistypes a row, that is
 * where it fails — not in a game somebody is playing.
 */

function def(id: string): ActionDef {
  const action = actionById(id);
  if (action === undefined) throw new Error(`no action ${id}`);
  return action;
}

function key(value: string): Binding {
  return { kind: 'key', value };
}

function code(value: string): Binding {
  return { kind: 'code', value };
}

/** Map equality that does not care about insertion order. */
function entries<V>(map: ReadonlyMap<string, V>): readonly (readonly [string, V])[] {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function sorted<V>(rows: readonly (readonly [string, V])[]): readonly (readonly [string, V])[] {
  return [...rows].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// THE EXTRACTION: SEVEN TABLES, UNCHANGED
// ---------------------------------------------------------------------------

describe('the defaults compile to the seven tables keys.ts used to declare', () => {
  it('KEY_TO_DIR — the arrows and the vi keys, on lowercased `event.key`', () => {
    expect(entries(DEFAULT_KEYMAP.dirByKey)).toEqual(
      sorted([
        ['arrowup', Dir.N],
        ['arrowdown', Dir.S],
        ['arrowleft', Dir.W],
        ['arrowright', Dir.E],
        ['k', Dir.N],
        ['j', Dir.S],
        ['h', Dir.W],
        ['l', Dir.E],
        ['y', Dir.NW],
        ['u', Dir.NE],
        ['b', Dir.SW],
        ['n', Dir.SE],
      ]),
    );
  });

  it('CODE_TO_DIR — the numpad, on `event.code`, because NumLock moves `key`', () => {
    expect(entries(DEFAULT_KEYMAP.dirByCode)).toEqual(
      sorted([
        ['Numpad8', Dir.N],
        ['Numpad2', Dir.S],
        ['Numpad4', Dir.W],
        ['Numpad6', Dir.E],
        ['Numpad7', Dir.NW],
        ['Numpad9', Dir.NE],
        ['Numpad1', Dir.SW],
        ['Numpad3', Dir.SE],
      ]),
    );
  });

  it('CODE_TO_COMMAND — Numpad5 holds and NumpadEnter commits', () => {
    expect(entries(DEFAULT_KEYMAP.commandByCode)).toEqual(
      sorted([
        ['Numpad5', TurnCommand.Hold],
        ['NumpadEnter', TurnCommand.Commit],
      ]),
    );
  });

  it('KEY_TO_COMMAND — the punctuation, which does not move with the layout', () => {
    expect(entries(DEFAULT_KEYMAP.commandByKey)).toEqual(
      sorted([
        [' ', TurnCommand.Commit],
        ['enter', TurnCommand.Commit],
        ['.', TurnCommand.Hold],
        [',', TurnCommand.Pickup],
      ]),
    );
  });

  it('KEY_TO_SLOT — 1-4, ZERO-BASED', () => {
    expect(entries(DEFAULT_KEYMAP.slotByKey)).toEqual(
      sorted([
        ['1', 0],
        ['2', 1],
        ['3', 2],
        ['4', 3],
      ]),
    );
  });

  it('KEY_TO_UI — every row for every verb, `/` beside `t`', () => {
    expect(entries(DEFAULT_KEYMAP.uiByKey)).toEqual(
      sorted([
        ['r', UiCommand.Revive],
        ['f', UiCommand.Respawn],
        ['t', UiCommand.Say],
        ['/', UiCommand.Say],
        ['c', UiCommand.ShowSheet],
        ['v', UiCommand.ToggleLog],
        ['m', UiCommand.ShowWorldMap],
        ['-', UiCommand.ZoomOut],
        ['=', UiCommand.ZoomIn],
        ['p', UiCommand.ToggleParty],
        ['g', UiCommand.ShowTalents],
        ['i', UiCommand.ShowInventory],
      ]),
    );
  });

  it('KEY_TO_SCROLL — +1 is BACK IN TIME', () => {
    expect(entries(DEFAULT_KEYMAP.scrollByKey)).toEqual(
      sorted([
        ['pageup', 1],
        ['pagedown', -1],
      ]),
    );
  });

  it('CANCEL_KEY is a set of exactly one, and it is escape', () => {
    expect([...DEFAULT_KEYMAP.cancelKeys]).toEqual(['escape']);
  });

  it('binds an action for every TurnCommand and every UiCommand member', () => {
    // The no-dead-action rule, from the registry's side: a verb with no key is a
    // screen nobody can reach, and this is where a ninth UiCommand is noticed.
    expect(new Set(DEFAULT_KEYMAP.commandByKey.values())).toEqual(
      new Set(Object.values(TurnCommand)),
    );
    expect(new Set(DEFAULT_KEYMAP.uiByKey.values())).toEqual(new Set(Object.values(UiCommand)));
  });
});

// ---------------------------------------------------------------------------
// THE REGISTRY'S OWN SHAPE
// ---------------------------------------------------------------------------

describe('the action registry', () => {
  it("`order` is definition order, which is ToME's monotonic bind_order", () => {
    // KeyBind.lua:38-40 hands out `_M.bind_order` and increments it. Ours is
    // written down rather than counted, so this is what stops a copy-pasted row
    // from silently sorting on top of its neighbour in the Keys screen.
    expect(ACTIONS.map((action) => action.order)).toEqual(ACTIONS.map((_, index) => index + 1));
  });

  it('names 34 actions, and stays under the cap the wire was sized for', () => {
    // src/shared/protocol.ts justifies the wire cap with an enumeration, and if
    // the table outgrows it a complete keymap starts getting refused as
    // `bad_message` with nobody able to guess why. THE SECOND ASSERTION IS THE
    // ONE THAT MATTERS; the first is here so growing the table stays a
    // deliberate act with a diff. 29 -> 31 when the bar gained slots 5 and 6;
    // 31 -> 34 when it gained 7, 8 and 9 and became one row of nine keys.
    expect(ACTIONS).toHaveLength(34);
    expect(ACTIONS.length).toBeLessThanOrEqual(KEYBIND_MAX_ACTIONS);
  });

  it('has no duplicate ids', () => {
    expect(new Set(ACTIONS.map((action) => action.id)).size).toBe(ACTIONS.length);
  });

  it('every default and every frozen binding is one this action can be handed', () => {
    // keys.ts has exactly two `code`-keyed tables. A shipped default that named
    // a namespace the dispatcher cannot reach would be a key that draws in the
    // Keys screen and does nothing at all — the dead-entry failure, one layer
    // down from the menu.
    for (const action of ACTIONS) {
      for (const binding of [...action.defaults, ...action.fixed]) {
        expect(canDeliver(action, binding)).toBe(true);
      }
    }
  });

  it('every action the player cannot rebind still has a key', () => {
    for (const action of ACTIONS) {
      if (action.rebindable) continue;
      expect(bindingsFor(action, {}).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// COMPOSITION
// ---------------------------------------------------------------------------

describe('an empty remap resolves to the defaults', () => {
  it('resolves both slots from `defaults` and nothing else', () => {
    expect(resolve(def('say'), {})).toEqual([key('t'), key('/')]);
    expect(resolve(def('move_north'), {})).toEqual([key('k'), undefined]);
  });

  it('the frozen floor is compiled in as well as the two slots', () => {
    expect(bindingsFor(def('move_north'), {})).toEqual([key('k'), key('arrowup'), code('Numpad8')]);
  });
});

describe('composition is PER SLOT, which is the property ToME lacks', () => {
  it('a remap of slot 0 leaves slot 1 at its default', () => {
    // `getBindTable` returns `binds_remap[type] or type.default`
    // (KeyBind.lua:114-116), so upstream's first rebind shadows the WHOLE array
    // and the alternate key vanishes with it. Ours does not.
    expect(resolve(def('say'), { say: ['key:;'] })).toEqual([key(';'), key('/')]);
  });

  it('a remap of slot 1 alone leaves slot 0 at its default', () => {
    const remap = setBinding({}, 'say', 1, key(';'));
    // The positional array has to say SOMETHING at index 0, and 'default' is the
    // word for "no override" — so a changed shipped default still reaches this
    // player in the slot they never touched.
    expect(remap.say).toEqual([SLOT_DEFAULT, 'key:;']);
    expect(resolve(def('say'), remap)).toEqual([key('t'), key(';')]);
  });

  it('an absent action falls back to its defaults, so the store stays sparse', () => {
    const remap = setBinding({}, 'say', 0, key(';'));
    expect(Object.keys(remap)).toEqual(['say']);
    expect(resolve(def('move_north'), remap)).toEqual([key('k'), undefined]);
  });

  it("an EMPTY array is 'no override in either slot', not 'cleared'", () => {
    // src/server/persist/saves.ts:1229-1236 keeps an action whose keys all
    // dropped as `[]` rather than deleting it, precisely so the resolver reads it
    // this way and nothing is bricked.
    expect(resolve(def('say'), { say: [] })).toEqual([key('t'), key('/')]);
  });

  it("'none' is the cleared slot, and it is a different thing from absent", () => {
    // KeyBinder.lua:95-97's Backspace, which upstream can spell as a Lua nil in a
    // positional file and JSON cannot.
    expect(resolve(def('say'), { say: [SLOT_NONE] })).toEqual([undefined, key('/')]);
  });

  it('an unreadable key string falls back to the default rather than to nothing', () => {
    // NEVER BRICK. "Your rebind was ignored" is recoverable; "your movement key
    // does nothing" is a player who cannot reach the menu that would fix it.
    expect(resolve(def('say'), { say: ['not a key string'] })).toEqual([key('t'), key('/')]);
  });

  it('key-side values are lowercased, so a captured capital still matches', () => {
    const keymap = compileKeymap(ACTIONS, { toggle_log: ['key:Q'] });
    expect(keymap.uiByKey.get('q')).toBe(UiCommand.ToggleLog);
    expect(parseBinding('key:Q')).toEqual(key('q'));
  });
});

describe('an unknown action id is ignored, not thrown', () => {
  const REMAP: KeyRemap = { ui_toggle_lore: ['key:z'], move_north: ['key:w'] };

  it('compiles without complaint and binds nothing for it', () => {
    const keymap = compileKeymap(ACTIONS, REMAP);
    expect(keymap.dirByKey.get('w')).toBe(Dir.N);
    expect(keymap.uiByKey.get('z')).toBeUndefined();
    expect(resolveAction({ key: 'z', code: '' }, keymap)).toBeUndefined();
  });

  it('a write to it is refused rather than inventing a row', () => {
    expect(setBinding({}, 'ui_toggle_lore', 0, key('z'))).toEqual({});
    expect(labelFor('ui_toggle_lore', DEFAULT_KEYMAP)).toBe('--');
  });
});

// ---------------------------------------------------------------------------
// THE ALIASING BUG ToME HAS, AND WE MUST NOT
// ---------------------------------------------------------------------------

describe('a write never mutates the registry', () => {
  /**
   * KeyBinder.lua:96-97, :102-103, :123-124 and :143 all do
   * `KeyBind.binds_remap[t.type] = KeyBind.binds_remap[t.type] or t.k.default`
   * and then WRITE THROUGH the result — `t.k.default` is stored BY REFERENCE, so
   * the first rebind permanently corrupts `binds_def[type].default` for the
   * session. That is why upstream has no reset-to-default button: by the time
   * you want one, the defaults are gone. This test is that bug, asserted absent.
   */
  it('every mutator leaves ACTIONS deeply identical', () => {
    const before = structuredClone(ACTIONS);
    let remap: KeyRemap = {};
    remap = setBinding(remap, 'move_north', 0, key('w'));
    remap = setBinding(remap, 'move_north', 1, code('Numpad8'));
    remap = clearBinding(remap, 'say', 0);
    expect(resetOne(remap, 'move_north')).toEqual({ say: [SLOT_NONE] });
    expect(resetAll()).toEqual({});
    expect(structuredClone(ACTIONS)).toEqual(before);
    // ...and the shipped defaults are still the shipped defaults afterwards,
    // which is the half of the bug a shallow object comparison would miss.
    expect(resolve(def('move_north'), {})).toEqual([key('k'), undefined]);
    expect(resolve(def('say'), {})).toEqual([key('t'), key('/')]);
  });

  it('each write allocates a new remap and a new slot array', () => {
    const first = setBinding({}, 'say', 0, key(';'));
    const second = setBinding(first, 'say', 1, key('x'));
    expect(second).not.toBe(first);
    expect(second.say).not.toBe(first.say);
    // ...and the earlier value is untouched, so an undo is a variable and not a
    // rebuild.
    expect(first.say).toEqual(['key:;']);
    expect(second.say).toEqual(['key:;', 'key:x']);
  });
});

describe('reset', () => {
  it('resetOne drops just that action back to its shipped keys', () => {
    let remap: KeyRemap = {};
    remap = setBinding(remap, 'say', 0, key(';'));
    remap = setBinding(remap, 'toggle_log', 0, key('z'));
    const after = resetOne(remap, 'say');
    expect(resolve(def('say'), after)).toEqual([key('t'), key('/')]);
    expect(resolve(def('toggle_log'), after)).toEqual([key('z'), undefined]);
    expect(Object.keys(after)).toEqual(['toggle_log']);
  });

  it('resetOne on an action with no override changes nothing at all', () => {
    const remap: KeyRemap = { say: ['key:;'] };
    expect(resetOne(remap, 'move_north')).toBe(remap);
  });

  it('resetAll is an empty overlay, which is a real value and not a missing one', () => {
    expect(resetAll()).toEqual({});
    expect(compileKeymap(ACTIONS, resetAll())).toEqual(DEFAULT_KEYMAP);
  });
});

// ---------------------------------------------------------------------------
// WHAT CANNOT BE REBOUND
// ---------------------------------------------------------------------------

describe('a locked action refuses every write', () => {
  const LOCKED = ACTIONS.filter((action) => !action.rebindable).map((action) => action.id);

  it('is exactly cancel and the nine hotbar digits', () => {
    // Escape because it is the command line's only exit and the escape menu's
    // opener, so freezing it keeps RESET ALL one press away whatever else the
    // player has done. The digits because src/client/ui/hotbar.ts:391 PAINTS
    // `${i + 1}` on each slot, and a rebound digit makes four on-screen buttons
    // lie with no art budget to redraw them.
    // Slots 5 to 9 are locked for the same reason 1-4 are: `ui/hotbar.ts`
    // PAINTS the slot number on every square, so a rebound digit makes an
    // on-screen button lie.
    expect(LOCKED).toEqual([
      'cancel',
      'hotbar_1',
      'hotbar_2',
      'hotbar_3',
      'hotbar_4',
      'hotbar_5',
      'hotbar_6',
      'hotbar_7',
      'hotbar_8',
      'hotbar_9',
    ]);
  });

  for (const id of LOCKED) {
    it(`${id} ignores setBinding, clearBinding and a hand-edited overlay`, () => {
      expect(setBinding({}, id, 0, key('z'))).toEqual({});
      expect(clearBinding({}, id, 0)).toEqual({});
      // ...and the overlay is not even consulted, so a save file that names it
      // changes nothing.
      const keymap = compileKeymap(ACTIONS, { [id]: ['key:z'] });
      expect(keymap.uiByKey.get('z')).toBeUndefined();
      expect(bindingsFor(def(id), { [id]: ['key:z'] })).toEqual(bindingsFor(def(id), {}));
    });
  }

  it('escape survives a remap that tries to take it', () => {
    const keymap = compileKeymap(ACTIONS, { cancel: [SLOT_NONE], toggle_log: ['key:escape'] });
    // Cancel is checked BEFORE the UI table in the dispatch, so even a binding
    // that reached the compiled tables loses the press.
    expect(keymap.cancelKeys.has('escape')).toBe(true);
    expect(resolveAction({ key: 'Escape', code: 'Escape' }, keymap)).toBe('cancel');
  });

  it('escape survives a remap that puts it on a MOVEMENT action, which is the real brick', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TEST ABOVE PROVES ALMOST NOTHING ON ITS OWN, AND THIS IS WHY.
     * ═══════════════════════════════════════════════════════════════════════
     * It picks `toggle_log` — a UI verb — and the UI table is read AFTER cancel
     * in the eight-step dispatch, so cancel wins by position and nothing about
     * the data model was tested. `compileKeymap` fills eight INDEPENDENT
     * namespace maps and `claim` only refuses a cell inside ONE of them, so the
     * frozen `fixed: [{kind:'key', value:'escape'}]` on `cancel` never saw a
     * `dirByKey` entry at all — and `bindGameKeys` consults `directionFor` FIRST
     * (keys.ts:418) and `cancelKeys` only THIRD (:441).
     *
     * So one hand-edited line — `"keybinds": {"move_north": ["key:escape"]}` in a
     * file this codebase says humans read and edit, or one frame from any
     * non-shipped client — walked the player north on Escape and took the escape
     * menu, the cancel chain, the command line's only exit and every keyboard
     * route to RESET ALL with it. Two docblocks promised that could not happen.
     *
     * THE OVERRIDE FALLS BACK TO THE SHIPPED DEFAULT rather than being dropped,
     * which is `resolveSlot`'s standing rule: refusing a binding must never be a
     * second way to end up with no key at all.
     */
    for (const spelling of ['key:escape', 'key:Escape', 'code:Escape']) {
      const keymap = compileKeymap(ACTIONS, { move_north: [spelling] });
      expect(keymap.cancelKeys.has('escape')).toBe(true);
      expect(resolveAction({ key: 'Escape', code: 'Escape' }, keymap)).toBe('cancel');
      expect(keymap.dirByKey.get('escape')).toBeUndefined();
      expect(keymap.dirByCode.get('Escape')).toBeUndefined();
      // ...AND NORTH IS NOT BRICKED EITHER: `k` is back, standing behind the
      // override the resolver refused.
      expect(keymap.dirByKey.get('k')).toBe(Dir.N);
    }

    // The same refusal at the write end, so the Keys screen never stores a
    // binding the resolver would then quietly ignore.
    expect(setBinding({}, 'move_north', 0, key('escape'))).toEqual({});
    expect(setBinding({}, 'toggle_log', 0, key('escape'))).toEqual({});

    // And the SECOND slot is covered too — the resolver is per-slot, so a rule
    // that only guarded slot 0 would be half a rule.
    const secondSlot = compileKeymap(ACTIONS, { move_north: [SLOT_DEFAULT, 'key:escape'] });
    expect(resolveAction({ key: 'Escape', code: '' }, secondSlot)).toBe('cancel');
  });

  it('a slot outside the two the wire carries is refused', () => {
    expect(setBinding({}, 'say', SLOTS_PER_ACTION, key('z'))).toEqual({});
    expect(setBinding({}, 'say', -1, key('z'))).toEqual({});
  });

  it('a `code` binding on a namespace with no code table is refused', () => {
    // keys.ts has two code-keyed lookups — directions and turn commands — and
    // adding a third would mean editing the eight-step dispatch order, which two
    // comments and a test call load-bearing. So the refusal happens here, where
    // the capture field can say why, rather than as a bind that silently does
    // nothing.
    expect(canDeliver(def('toggle_log'), code('KeyV'))).toBe(false);
    expect(canDeliver(def('move_north'), code('Numpad8'))).toBe(true);
    expect(canDeliver(def('commit'), code('NumpadEnter'))).toBe(true);
    expect(setBinding({}, 'toggle_log', 0, code('KeyV'))).toEqual({});
    // And if one reaches the compiler through a hand-edited save it is dropped
    // rather than installed somewhere it can never be read.
    expect(compileKeymap(ACTIONS, { toggle_log: ['code:KeyV'] }).uiByKey.get('v')).toBe(
      UiCommand.ToggleLog,
    );
  });
});

// ---------------------------------------------------------------------------
// CONFLICTS, ARBITRATED BY THE REAL DISPATCH
// ---------------------------------------------------------------------------

describe('conflicts are resolved by dispatch and not by string equality', () => {
  it('reports the code-vs-key Numpad1 / hotbar "1" collision', () => {
    // THE ONE STRING COMPARISON MISSES. Numpad1 is matched on `code` and the
    // hotbar's '1' on `key`, and with NumLock on they are the SAME PHYSICAL
    // PRESS — arbitrated only by the dispatch order. A player binding the
    // inventory to '1' loses it twice over, and neither loss is visible in the
    // key strings.
    const found = conflictsFor({ action: 'show_inventory', binding: key('1') }, DEFAULT_KEYMAP);
    expect(found.map((conflict) => conflict.holder).sort()).toEqual(['hotbar_1', 'move_southwest']);
    expect(found.map((conflict) => conflict.holderName)).toContain('Move south-west');
  });

  it('reports a plain key-vs-key collision, with the holder named', () => {
    const found = conflictsFor({ action: 'show_inventory', binding: key('v') }, DEFAULT_KEYMAP);
    expect(found).toEqual([
      { holder: 'toggle_log', holderName: 'Case Log', press: { key: 'v', code: '' } },
    ]);
  });

  it('reports across namespaces in the other direction too', () => {
    // Binding a turn verb to the physical Numpad8 loses to `move_north`, which
    // owns that code. No key string the two share would have shown it.
    const found = conflictsFor({ action: 'hold', binding: code('Numpad8') }, DEFAULT_KEYMAP);
    expect(found.map((conflict) => conflict.holder)).toEqual(['move_north']);
  });

  it('does NOT report the pre-existing comma / numpad-decimal baseline', () => {
    // keys.ts recorded this in writing before the detector existed: on German
    // and French layouts the numpad decimal reports ',' rather than '.', so that
    // key picks up. ONE HONEST COLLISION, STATED RATHER THAN DISCOVERED — and
    // nagging a player about a decision the codebase already made is the
    // false-alarm storm, not a warning.
    expect(conflictsFor({ action: 'pickup', binding: key(',') }, DEFAULT_KEYMAP)).toEqual([]);
    // ...and it is silent because it was CONSIDERED, not because the decimal key
    // is a blind spot. The press is in the set the detector walks.
    expect(pressesFor(key(','))).toContainEqual({ key: ',', code: 'NumpadDecimal' });
  });

  it('does NOT report a collision the shipped defaults already have', () => {
    // `hotbar_1` re-affirming its own '1' is the same Numpad1 press as the first
    // test in this block, and it is the baseline rather than the player's doing.
    expect(conflictsFor({ action: 'hotbar_1', binding: key('1') }, DEFAULT_KEYMAP)).toEqual([]);
  });

  it('an action does not conflict with itself', () => {
    expect(conflictsFor({ action: 'toggle_log', binding: key('v') }, DEFAULT_KEYMAP)).toEqual([]);
  });

  it('a free key conflicts with nothing', () => {
    expect(conflictsFor({ action: 'toggle_log', binding: key('z') }, DEFAULT_KEYMAP)).toEqual([]);
  });

  it('is asked about the CURRENT keymap, so a freed key stops conflicting', () => {
    const after = compileKeymap(ACTIONS, { toggle_log: ['key:z'] });
    expect(conflictsFor({ action: 'show_inventory', binding: key('v') }, after)).toEqual([]);
    expect(
      conflictsFor({ action: 'show_inventory', binding: key('z') }, after).map((c) => c.holder),
    ).toEqual(['toggle_log']);
  });

  it('resolveAction walks the same eight-step order the handler walks', () => {
    // dir (code, then key) -> slot -> cancel -> scroll -> ui -> command. If these
    // two ever disagree, the Keys screen confidently names the wrong holder.
    expect(resolveAction({ key: '1', code: 'Numpad1' }, DEFAULT_KEYMAP)).toBe('move_southwest');
    expect(resolveAction({ key: '1', code: 'Digit1' }, DEFAULT_KEYMAP)).toBe('hotbar_1');
    expect(resolveAction({ key: 'Escape', code: 'Escape' }, DEFAULT_KEYMAP)).toBe('cancel');
    expect(resolveAction({ key: 'PageUp', code: 'PageUp' }, DEFAULT_KEYMAP)).toBe('scroll_back');
    expect(resolveAction({ key: 'C', code: 'KeyC' }, DEFAULT_KEYMAP)).toBe('show_sheet');
    expect(resolveAction({ key: ' ', code: 'Space' }, DEFAULT_KEYMAP)).toBe('commit');
    expect(resolveAction({ key: 'q', code: 'KeyQ' }, DEFAULT_KEYMAP)).toBeUndefined();
  });

  it('a compiled collision is settled by definition order, not by hash order', () => {
    // ToME resolves two virtuals on one key string by `pairs` iteration
    // (KeyBind.lua:227-232), so its winner can differ between runs of the same
    // build. Only a hand-edited save can reach this state here — the capture
    // field refuses the bind — but when it does, the lower `order` keeps the key
    // and the answer is the same every time.
    const keymap = compileKeymap(ACTIONS, { show_sheet: ['key:z'], toggle_log: ['key:z'] });
    expect(resolveAction({ key: 'z', code: '' }, keymap)).toBe('show_sheet');
  });
});

// ---------------------------------------------------------------------------
// DISPLAY
// ---------------------------------------------------------------------------

describe('labelFor never shows the stored form', () => {
  it("returns '--' for an empty slot, which is formatKeyString's own answer", () => {
    // KeyBind.lua:158-160 — `if not ks then return "--" end`.
    expect(labelFor('move_northeast', DEFAULT_KEYMAP, 1)).toBe('--');
    expect(labelForBinding(undefined)).toBe('--');
  });

  it('names a slot the way a player reads it', () => {
    expect(labelFor('move_north', DEFAULT_KEYMAP, 0)).toBe('K');
    expect(labelFor('commit', DEFAULT_KEYMAP, 0)).toBe('Space');
    expect(labelFor('commit', DEFAULT_KEYMAP, 1)).toBe('Enter');
    expect(labelFor('scroll_back', DEFAULT_KEYMAP, 0)).toBe('PgUp');
    // ToME does the same substitution on its own numpad names —
    // `sym:gsub("Keypad ", "k")`, KeyBind.lua:179.
    expect(labelForBinding(code('Numpad8'))).toBe('Num8');
    expect(labelForBinding(code('NumpadEnter'))).toBe('NumEnter');
  });

  it('without a slot it shows the frozen floor too, so the row is honest', () => {
    // A player who rewrote `k` needs to see that the arrows and the numpad still
    // work, or they will report the rebind as having broken movement.
    expect(labelFor('move_north', DEFAULT_KEYMAP)).toBe('K / Up / Num8');
    expect(labelFor('cancel', DEFAULT_KEYMAP)).toBe('Esc');
  });

  it('follows a rebind, which is the point — a hard-coded mnemonic is a lie', () => {
    const keymap = compileKeymap(ACTIONS, { show_inventory: ['key:v'] });
    expect(labelFor('show_inventory', keymap)).toBe('V');
    expect(labelFor('show_inventory', DEFAULT_KEYMAP)).toBe('I');
  });

  it("a cleared action reads '--' rather than blank", () => {
    const keymap = compileKeymap(ACTIONS, { toggle_log: [SLOT_NONE, SLOT_NONE] });
    expect(labelFor('toggle_log', keymap)).toBe('--');
    expect(keymap.uiByKey.get('v')).toBeUndefined();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SLOT BOUND BY CODE LANDS IN THE CODE MAP — WHICH IT DID NOT USED TO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `case 'slot'` claimed EVERY slot into `slotByKey`, whatever it was bound by.
 * So a `{ kind: 'code' }` slot was stored under 'Digit5' and then matched
 * against `event.key`, which is '5'. It could never fire, and it failed
 * silently — no throw, no warning, just a key that did nothing.
 *
 * Nothing in `ACTIONS` binds a slot by code TODAY (see the note above
 * `hotbar_1` for why slots 5-8 wait for the talents that fill them), so this
 * feeds `compileKeymap` a synthetic table instead. That is the whole reason it
 * takes one rather than reading the module-level constant.
 *
 * WHY IT MATTERS BEFORE ANYTHING USES IT: this is what makes a bar wider than
 * four possible at all. The numpad reports Numpad5-Numpad9 as the STRINGS
 * '5'-'9', so a slot bound by key collides with the cardinal directions; bound
 * by code it cannot, because the numpad never emits `Digit5`.
 */
describe('a slot bound by code', () => {
  const CODE_SLOT: ActionDef = {
    id: 'hotbar_5',
    name: 'Talent slot 5',
    group: 'Hotbar',
    order: 1,
    effect: { kind: 'slot', slot: 4 },
    defaults: [],
    fixed: [{ kind: 'code', value: 'Digit5' }],
    rebindable: false,
  };

  it('goes in slotByCode, not slotByKey', () => {
    const keymap = compileKeymap([CODE_SLOT], {});
    expect(keymap.slotByCode.get('Digit5')).toBe(4);
    // THE HALF THAT WAS BROKEN. 'Digit5' under the key map is a dead entry:
    // `event.key` for that press is '5', so the lookup could never hit it.
    expect(keymap.slotByKey.get('digit5')).toBeUndefined();
    expect(keymap.slotByKey.size).toBe(0);
  });

  it('cannot be reached from the numpad, which is the entire point', () => {
    const keymap = compileKeymap([CODE_SLOT], {});
    expect(keymap.slotByCode.get('Numpad5')).toBeUndefined();
  });

  it('is named by resolveAction, so the Keys screen agrees with the game', () => {
    // keys.ts reads code-then-key; `resolveAction` is the second reader of that
    // same order. A press the game answers and this function cannot name would
    // put "unbound" on the Keys screen beside a key that works.
    const keymap = compileKeymap([CODE_SLOT], {});
    expect(resolveAction({ code: 'Digit5', key: '5' }, keymap)).toBe('hotbar_5');
  });

  it('still reaches a KEY-bound slot the old way', () => {
    // The branch is a fork, not a replacement — `hotbar_1`-`hotbar_4` are bound
    // by key and all four have worked since M3.
    const keymap = compileKeymap(ACTIONS, {});
    expect(keymap.slotByKey.get('1')).toBe(0);
    // AND BOTH MAPS ARE NOW POPULATED FROM THE REAL TABLE. Slots 1-4 are bound
    // by key and 5-6 by code, which is the pair this branch exists for.
    expect(keymap.slotByCode.get('Digit5')).toBe(4);
    expect(keymap.slotByCode.get('Digit6')).toBe(5);
  });
});
