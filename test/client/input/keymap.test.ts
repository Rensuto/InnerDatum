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
  migrateStoredKeymap,
  KEYMAP_GEN,
  KEYMAP_GEN_ID,
  resolve,
  resolveAction,
  RETIRED_DEFAULTS,
  sameRemap,
  setBinding,
} from '../../../src/client/input/keymap.ts';
import { KEYBIND_ACTION_MAX_CHARS, KEYBIND_MAX_ACTIONS } from '../../../src/shared/protocol.ts';
import { HOTBAR_KEY_ROW, HOTBAR_ROW_KEYS } from '../../../src/client/ui/hotbar.ts';
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
  it('KEY_TO_DIR — W/A/S/D and nothing else on lowercased `event.key`', () => {
    // ═══ FOUR ROWS, WHERE THIS USED TO HAVE TWELVE ═══
    // It asserted the four arrows and the eight vi letters. The author ruled
    // both sets off: *"we would prefer WASD for basic movements, then numpad for
    // all directional movements. i want to remove the other directional keys
    // from the keyboard"*. THE DIAGONALS HAVE NO LETTER AT ALL — the numpad map
    // below is the whole of them — and the arrows are not merely absent from
    // this table, they are absent from the keymap entirely: keys.ts's
    // `ARROW_NAV` moves a SELECTION with them, never a body.
    expect(entries(DEFAULT_KEYMAP.dirByKey)).toEqual(
      sorted([
        ['w', Dir.N],
        ['s', Dir.S],
        ['a', Dir.W],
        ['d', Dir.E],
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
        // NO `enter` ROW. It opens the command line now — see `uiByKey` below —
        // and the dispatcher reads that table first, so a commit binding on
        // Enter would be one nothing could reach. `NumpadEnter` still commits,
        // because that lookup is keyed on `code` and runs before this one.
        ['.', TurnCommand.Hold],
        [',', TurnCommand.Pickup],
        // TWO LETTERS AMONG THE PUNCTUATION, and they are the reason the note
        // below the table is worth reading. Every other row here is a mark that
        // does not move with the keyboard layout; these two are here because
        // rest and auto-explore are the turn verbs the genre already has letters
        // for — `r` from Angband's lineage, `z` from ToME's own `RUN_AUTO`.
        ['r', TurnCommand.Rest],
        ['z', TurnCommand.Explore],
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

  it('KEY_TO_UI — every row for every verb, and Enter talks', () => {
    expect(entries(DEFAULT_KEYMAP.uiByKey)).toEqual(
      sorted([
        ['e', UiCommand.Revive],
        ['f', UiCommand.Respawn],
        // ENTER, AND IT USED TO BE `t` AND `/`. Asked for as "we will not use
        // the / or t button but instead just the enter key to active".
        ['enter', UiCommand.Say],
        ['c', UiCommand.ShowSheet],
        ['v', UiCommand.ToggleLog],
        ['m', UiCommand.ShowWorldMap],
        // NO `-` OR `=` ROW. They were `zoom_out` and `zoom_in` and both went
        // with the control (*"remove the (zoom) option"*). The two keys are
        // unbound now, which is what lets `lets an unmapped key sail past
        // untouched` be true of them.
        ['p', UiCommand.ToggleParty],
        ['g', UiCommand.ShowTalents],
        ['i', UiCommand.ShowInventory],
        // v12. THE JOURNAL, ON THE LETTER THE WASD RULING FREED IN THIS SAME
        // PASS (*"we can put journal to the J key"*). It is the FIRST row this
        // table has gained on a letter another action shipped with, which is
        // why `migrateStoredKeymap` had to exist before this row did.
        ['j', UiCommand.ShowJournal],
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

  it('puts every row in the group its screen prints it under', () => {
    // `order` was pinned and `group` was not, so moving `show_journal` from
    // `Screens` to `Turn` survived the whole suite — the Journal row simply
    // appeared in the wrong block of the Keys screen, under a heading that is
    // about taking a turn. The screen groups by whatever the table says, which
    // is exactly why the table needs asserting somewhere.
    const groups = new Map(ACTIONS.map((action) => [action.id, action.group]));
    expect(groups.get('show_journal')).toBe('Screens');
    expect(groups.get('show_sheet')).toBe('Screens');
    expect(groups.get('toggle_log')).toBe('Log');
    expect(groups.get('move_north')).toBe('Movement');
    expect(groups.get('rest')).toBe('Turn');
    // ...and every row belongs to a group the screen actually renders a heading
    // for, so a typo cannot hide a row off the bottom of the list.
    const known = new Set(ACTIONS.map((action) => action.group));
    expect([...known].sort()).toEqual(['Hotbar', 'Log', 'Movement', 'Screens', 'Turn']);
  });

  it('names 38 actions, and stays under the cap the wire was sized for', () => {
    // src/shared/protocol.ts justifies the wire cap with an enumeration, and if
    // the table outgrows it a complete keymap starts getting refused as
    // `bad_message` with nobody able to guess why. THE SECOND ASSERTION IS THE
    // ONE THAT MATTERS; the first is here so growing the table stays a
    // deliberate act with a diff. 29 -> 31 when the bar gained slots 5 and 6;
    // 31 -> 34 when it gained 7, 8 and 9 and became one row of nine keys;
    // 34 -> 35 when `rest` was ported (Player.lua:971); 35 -> 36 with
    // auto-explore (Game.lua:2064); 36 -> 34 when `zoom_out` and `zoom_in` went
    // with the control (*"remove the (zoom) option"*) -- the only time this
    // number has gone DOWN, and the rows below them were renumbered so `order`
    // stays definition order; 34 -> 35 when the Journal joined the Screens
    // group (*"case notes should actually be 'Journal'"*), which renumbered the
    // twelve Hotbar and Log rows below it for that same reason; 35 -> 38 when
    // the number row grew to upstream's TWELVE (`PlayerHotkeys.lua:314`,
    // `for x = 1, 12`) and slots 10, 11 and 12 arrived on `Digit0`, `Minus` and
    // `Equal` -- which renumbered the three rows below them for that same reason.
    expect(ACTIONS).toHaveLength(38);
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
    expect(resolve(def('say'), {})).toEqual([key('enter'), undefined]);
    expect(resolve(def('move_north'), {})).toEqual([key('w'), undefined]);
    // A DIAGONAL SHIPS WITH BOTH SLOTS EMPTY. WASD has no diagonal and the vi
    // ring went with the cardinals, so the numpad `fixed` row below is the whole
    // of north-east — and the slots stay open for a player who wants a letter.
    expect(resolve(def('move_northeast'), {})).toEqual([undefined, undefined]);
  });

  it('the frozen floor is compiled in as well as the two slots', () => {
    // ONE FROZEN BINDING NOW, NOT TWO: the arrows left movement's floor with the
    // ruling, and the numpad is the whole of it.
    expect(bindingsFor(def('move_north'), {})).toEqual([key('w'), code('Numpad8')]);
    expect(bindingsFor(def('move_northeast'), {})).toEqual([code('Numpad9')]);
  });
});

describe('composition is PER SLOT, which is the property ToME lacks', () => {
  it('a remap of slot 0 leaves slot 1 at its default', () => {
    // `getBindTable` returns `binds_remap[type] or type.default`
    // (KeyBind.lua:114-116), so upstream's first rebind shadows the WHOLE array
    // and the alternate key vanishes with it. Ours does not.
    expect(resolve(def('say'), { say: ['key:;'] })).toEqual([key(';'), undefined]);
  });

  it('a remap of slot 1 alone leaves slot 0 at its default', () => {
    const remap = setBinding({}, 'say', 1, key(';'));
    // The positional array has to say SOMETHING at index 0, and 'default' is the
    // word for "no override" — so a changed shipped default still reaches this
    // player in the slot they never touched.
    expect(remap.say).toEqual([SLOT_DEFAULT, 'key:;']);
    expect(resolve(def('say'), remap)).toEqual([key('enter'), key(';')]);
  });

  it('an absent action falls back to its defaults, so the store stays sparse', () => {
    const remap = setBinding({}, 'say', 0, key(';'));
    expect(Object.keys(remap)).toEqual(['say']);
    expect(resolve(def('move_north'), remap)).toEqual([key('w'), undefined]);
  });

  it("an EMPTY array is 'no override in either slot', not 'cleared'", () => {
    // src/server/persist/saves.ts:1229-1236 keeps an action whose keys all
    // dropped as `[]` rather than deleting it, precisely so the resolver reads it
    // this way and nothing is bricked.
    expect(resolve(def('say'), { say: [] })).toEqual([key('enter'), undefined]);
  });

  it("'none' is the cleared slot, and it is a different thing from absent", () => {
    // KeyBinder.lua:95-97's Backspace, which upstream can spell as a Lua nil in a
    // positional file and JSON cannot.
    expect(resolve(def('say'), { say: [SLOT_NONE] })).toEqual([undefined, undefined]);
  });

  it('an unreadable key string falls back to the default rather than to nothing', () => {
    // NEVER BRICK. "Your rebind was ignored" is recoverable; "your movement key
    // does nothing" is a player who cannot reach the menu that would fix it.
    expect(resolve(def('say'), { say: ['not a key string'] })).toEqual([key('enter'), undefined]);
  });

  it('key-side values are lowercased, so a captured capital still matches', () => {
    const keymap = compileKeymap(ACTIONS, { toggle_log: ['key:Q'] });
    expect(keymap.uiByKey.get('q')).toBe(UiCommand.ToggleLog);
    expect(parseBinding('key:Q')).toEqual(key('q'));
  });
});

describe('an unknown action id is ignored, not thrown', () => {
  const REMAP: KeyRemap = { ui_toggle_lore: ['key:q'], move_north: ['key:w'] };

  it('compiles without complaint and binds nothing for it', () => {
    const keymap = compileKeymap(ACTIONS, REMAP);
    expect(keymap.dirByKey.get('w')).toBe(Dir.N);
    expect(keymap.uiByKey.get('q')).toBeUndefined();
    expect(resolveAction({ key: 'q', code: '' }, keymap)).toBeUndefined();
  });

  it('a write to it is refused rather than inventing a row', () => {
    expect(setBinding({}, 'ui_toggle_lore', 0, key('q'))).toEqual({});
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
    remap = setBinding(remap, 'move_north', 0, key('t'));
    remap = setBinding(remap, 'move_north', 1, code('Numpad8'));
    remap = clearBinding(remap, 'say', 0);
    expect(resetOne(remap, 'move_north')).toEqual({ say: [SLOT_NONE] });
    // WAS `toEqual({})`. RESET ALL keeps the migration stamp and nothing else —
    // see the test below, which argues why dropping it would be a bug.
    expect(resetAll()).toEqual({ [KEYMAP_GEN_ID]: [KEYMAP_GEN] });
    expect(structuredClone(ACTIONS)).toEqual(before);
    // ...and the shipped defaults are still the shipped defaults afterwards,
    // which is the half of the bug a shallow object comparison would miss.
    expect(resolve(def('move_north'), {})).toEqual([key('w'), undefined]);
    expect(resolve(def('say'), {})).toEqual([key('enter'), undefined]);
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
    remap = setBinding(remap, 'toggle_log', 0, key('q'));
    const after = resetOne(remap, 'say');
    expect(resolve(def('say'), after)).toEqual([key('enter'), undefined]);
    expect(resolve(def('toggle_log'), after)).toEqual([key('q'), undefined]);
    expect(Object.keys(after)).toEqual(['toggle_log']);
  });

  it('resetOne on an action with no override changes nothing at all', () => {
    const remap: KeyRemap = { say: ['key:;'] };
    expect(resetOne(remap, 'move_north')).toBe(remap);
  });

  it('resetAll is the shipped defaults, and it does NOT unstamp the player', () => {
    // WAS `expect(resetAll()).toEqual({})`, and that is now the bug rather than
    // the rule. The stamp records that the one-time upgrade rules have already
    // run against this player's file (`KEYMAP_GEN_ID`); an overlay without it is
    // a file those rules will run against again, so a bare `{}` here would mean
    // RESET ALL quietly re-armed them — and the next key the player chose that
    // happened to be a retired default would be taken off them on the following
    // load. The reset is still total: every ACTION is back to its shipped key,
    // which the second assertion is.
    expect(resetAll()).toEqual({ [KEYMAP_GEN_ID]: [KEYMAP_GEN] });
    // EVERY COMPILED TABLE IS THE SHIPPED ONE. The overlay it was compiled from
    // rides on the result (`Keymap.remap`), so that one field is the stamp and
    // the eight tables are `DEFAULT_KEYMAP`'s, cell for cell.
    expect(compileKeymap(ACTIONS, resetAll())).toEqual({
      ...DEFAULT_KEYMAP,
      remap: { [KEYMAP_GEN_ID]: [KEYMAP_GEN] },
    });
    // ...and the stamp is not an action, so nothing on the Keys screen can see
    // it and no compiled table holds a row for it.
    expect(actionById(KEYMAP_GEN_ID)).toBeUndefined();
    // ...and a key bound AFTER a RESET ALL survives the next load. This is the
    // whole point, driven end to end: `k` was north's shipped key until the WASD
    // ruling, so it is exactly the value the upgrade rule would have eaten.
    const afterReset = setBinding(resetAll(), 'move_north', 1, key('k'));
    expect(sameRemap(migrateStoredKeymap(ACTIONS, afterReset), afterReset)).toBe(true);
    expect(compileKeymap(ACTIONS, afterReset).dirByKey.get('k')).toBe(Dir.N);
  });
});

// ---------------------------------------------------------------------------
// WHAT CANNOT BE REBOUND
// ---------------------------------------------------------------------------

describe('a locked action refuses every write', () => {
  const LOCKED = ACTIONS.filter((action) => !action.rebindable).map((action) => action.id);

  it('is exactly cancel and the twelve hotbar keys', () => {
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
      // AND THE THREE THAT MADE THE ROW TWELVE. Locked for the identical
      // reason and one more: `ROW_KEYS` (ui/hotbar.ts) paints `0`, `-` and `=`
      // on these squares, so a rebind would make an on-screen button lie in a
      // row where the other nine cannot.
      'hotbar_10',
      'hotbar_11',
      'hotbar_12',
    ]);
  });

  for (const id of LOCKED) {
    it(`${id} ignores setBinding, clearBinding and a hand-edited overlay`, () => {
      expect(setBinding({}, id, 0, key('q'))).toEqual({});
      expect(clearBinding({}, id, 0)).toEqual({});
      // ...and the overlay is not even consulted, so a save file that names it
      // changes nothing.
      const keymap = compileKeymap(ACTIONS, { [id]: ['key:q'] });
      expect(keymap.uiByKey.get('q')).toBeUndefined();
      expect(bindingsFor(def(id), { [id]: ['key:q'] })).toEqual(bindingsFor(def(id), {}));
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
      // ...AND NORTH IS NOT BRICKED EITHER: `w` is back, standing behind the
      // override the resolver refused.
      expect(keymap.dirByKey.get('w')).toBe(Dir.N);
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
    expect(setBinding({}, 'say', SLOTS_PER_ACTION, key('q'))).toEqual({});
    expect(setBinding({}, 'say', -1, key('q'))).toEqual({});
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
      // `Log`, NOT `Case Log`: the panel was renamed and this row is a name a
      // player reads on the Keys screen. The ACTION ID did not move, which is
      // what keeps every stored bind for it working.
      { holder: 'toggle_log', holderName: 'Log', press: { key: 'v', code: '' } },
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
    expect(conflictsFor({ action: 'toggle_log', binding: key('q') }, DEFAULT_KEYMAP)).toEqual([]);
  });

  it('is asked about the CURRENT keymap, so a freed key stops conflicting', () => {
    const after = compileKeymap(ACTIONS, { toggle_log: ['key:q'] });
    expect(conflictsFor({ action: 'show_inventory', binding: key('v') }, after)).toEqual([]);
    expect(
      conflictsFor({ action: 'show_inventory', binding: key('q') }, after).map((c) => c.holder),
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
    const keymap = compileKeymap(ACTIONS, { show_sheet: ['key:q'], toggle_log: ['key:q'] });
    expect(resolveAction({ key: 'q', code: '' }, keymap)).toBe('show_sheet');
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
    expect(labelFor('move_north', DEFAULT_KEYMAP, 0)).toBe('W');
    // A DIAGONAL'S TWO SLOTS ARE BOTH EMPTY and the row still draws: '--' is
    // `formatKeyString`'s own first line (KeyBind.lua:158-160).
    expect(labelFor('move_northeast', DEFAULT_KEYMAP, 0)).toBe('--');
    expect(labelFor('commit', DEFAULT_KEYMAP, 0)).toBe('Space');
    // Slot 1 is empty: Enter left `commit` for `say`. An unbound slot reads as
    // a dash rather than as nothing, so the Keys screen has something to draw.
    expect(labelFor('commit', DEFAULT_KEYMAP, 1)).toBe('--');
    expect(labelFor('say', DEFAULT_KEYMAP, 0)).toBe('Enter');
    expect(labelFor('scroll_back', DEFAULT_KEYMAP, 0)).toBe('PgUp');
    // ToME does the same substitution on its own numpad names —
    // `sym:gsub("Keypad ", "k")`, KeyBind.lua:179.
    expect(labelForBinding(code('Numpad8'))).toBe('Num8');
    expect(labelForBinding(code('NumpadEnter'))).toBe('NumEnter');
  });

  it('without a slot it shows the frozen floor too, so the row is honest', () => {
    // A player who rewrote `w` needs to see that the numpad still works, or they
    // will report the rebind as having broken movement. THE ARROWS ARE NOT IN
    // THIS STRING ANY MORE and that is the point of asserting it: they left
    // movement's frozen floor with the WASD ruling, so a row that still named
    // them would be telling the player a key works that does not.
    expect(labelFor('move_north', DEFAULT_KEYMAP)).toBe('W / Num8');
    expect(labelFor('move_northeast', DEFAULT_KEYMAP)).toBe('Num9');
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

// ---------------------------------------------------------------------------
// THE WASD RULING, AND THE UPGRADE PATH FOR EVERY KEYMAP ALREADY ON DISK
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHIPPED MOVEMENT DEFAULTS, ASSERTED AS A WHOLE TABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Ruled verbatim: *"we would prefer WASD for basic movements, then numpad for
 * all directional movements. i want to remove the other directional keys from
 * the keyboard. players can always rebind them later"*.
 *
 * ROW BY ROW RATHER THAN BY SPOT CHECK, because the failure this guards is a
 * copy-paste: four cardinals that all read `w` compile, run, and are only wrong
 * under somebody's fingers.
 */
describe('movement ships as W/A/S/D plus the numpad, and nothing else', () => {
  const CARDINALS: readonly (readonly [string, string, Dir, string])[] = [
    ['move_north', 'w', Dir.N, 'Numpad8'],
    ['move_west', 'a', Dir.W, 'Numpad4'],
    ['move_south', 's', Dir.S, 'Numpad2'],
    ['move_east', 'd', Dir.E, 'Numpad6'],
  ];

  for (const [id, letter, dir, pad] of CARDINALS) {
    it(`${id} defaults to ${letter} and freezes ${pad}`, () => {
      expect(resolve(def(id), {})).toEqual([key(letter), undefined]);
      expect(def(id).fixed).toEqual([code(pad)]);
      expect(DEFAULT_KEYMAP.dirByKey.get(letter)).toBe(dir);
      expect(DEFAULT_KEYMAP.dirByCode.get(pad)).toBe(dir);
    });
  }

  const DIAGONALS: readonly (readonly [string, Dir, string])[] = [
    ['move_northeast', Dir.NE, 'Numpad9'],
    ['move_southeast', Dir.SE, 'Numpad3'],
    ['move_southwest', Dir.SW, 'Numpad1'],
    ['move_northwest', Dir.NW, 'Numpad7'],
  ];

  for (const [id, dir, pad] of DIAGONALS) {
    it(`${id} has no letter at all, and ${pad} is the whole of it`, () => {
      expect(def(id).defaults).toEqual([]);
      expect(bindingsFor(def(id), {})).toEqual([code(pad)]);
      expect(DEFAULT_KEYMAP.dirByCode.get(pad)).toBe(dir);
    });
  }

  it('NOT q/e/z/c — the letters the author was told this pass would not take', () => {
    // Asked about and refused in writing: a laptop with no numpad is answered by
    // a chord, not by four more letters. `z` is auto-explore, `c` is the
    // character sheet and `e` is revive, so three of the four are not even free.
    for (const letter of ['q', 'e', 'z', 'c']) {
      expect(DEFAULT_KEYMAP.dirByKey.get(letter)).toBeUndefined();
    }
  });

  it('the vi ring is unbound as a DIRECTION, not reassigned to one', () => {
    for (const letter of ['h', 'j', 'k', 'l', 'y', 'u', 'b', 'n']) {
      expect(DEFAULT_KEYMAP.dirByKey.get(letter)).toBeUndefined();
    }
    // SEVEN OF THE EIGHT REACH NOTHING AT ALL, which is what "unbound" means.
    for (const letter of ['h', 'k', 'l', 'y', 'u', 'b', 'n']) {
      expect(
        resolveAction({ key: letter, code: `Key${letter.toUpperCase()}` }, DEFAULT_KEYMAP),
      ).toBeUndefined();
    }
    // `j` IS THE EXCEPTION AND IT IS THE POINT. This case used to assert that
    // `j` reached nothing either, "because it is the one another action is
    // waiting for". The action landed: the Journal holds it now, and what still
    // has to be true is that it is the JOURNAL and not a step.
    expect(resolveAction({ key: 'j', code: 'KeyJ' }, DEFAULT_KEYMAP)).toBe('show_journal');
  });

  it('the arrows are not in the keymap at all — not as a default, not as a floor', () => {
    for (const arrow of ['arrowup', 'arrowdown', 'arrowleft', 'arrowright']) {
      expect(DEFAULT_KEYMAP.dirByKey.get(arrow)).toBeUndefined();
      expect(resolveAction({ key: arrow, code: '' }, DEFAULT_KEYMAP)).toBeUndefined();
    }
    // AND NO ROW STILL DECLARES ONE. `fixed` is outside the overlay, so an arrow
    // left on one action would be a key no screen can clear and no test above
    // would name.
    for (const action of ACTIONS) {
      for (const binding of [...action.defaults, ...action.fixed]) {
        expect(binding.value.toLowerCase().startsWith('arrow')).toBe(false);
      }
    }
  });

  it('Numpad5 still holds, which the ruling kept by name', () => {
    expect(DEFAULT_KEYMAP.commandByCode.get('Numpad5')).toBe(TurnCommand.Hold);
    expect(resolveAction({ key: 'Clear', code: 'Numpad5' }, DEFAULT_KEYMAP)).toBe('hold');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * *"PLAYERS CAN ALWAYS REBIND THEM LATER"* — THE HALF THAT HAD TO BE CHECKED
   * RATHER THAN ASSUMED, BECAUSE THE CONFLICT DETECTOR COULD HAVE REFUSED IT.
   * ═══════════════════════════════════════════════════════════════════════════
   * `conflictsFor` expands a `key` binding into every physical key that can
   * report that character, and the numpad reports 'ArrowUp' for Numpad8 with
   * NumLock off. So "put Up back on north" runs straight into `move_north`'s own
   * frozen Numpad8 — and would be refused, leaving the ruling's promise false
   * for the one set of keys it took away, if the detector did not skip a holder
   * that IS the candidate's own action.
   */
  it('a player can put the arrows and the vi ring back where they were', () => {
    // `move_south`/`j` IS NOT IN THIS LIST AND ITS ABSENCE IS THE NEXT CASE.
    // It was here, and it left when the Journal took `j` — which is not a hole
    // in the ruling but the conflict detector doing its job on a key that now
    // has an owner. The case below asserts the refusal NAMES that owner.
    const BACK: readonly (readonly [string, string])[] = [
      ['move_north', 'arrowup'],
      ['move_south', 'arrowdown'],
      ['move_west', 'arrowleft'],
      ['move_east', 'arrowright'],
      ['move_north', 'k'],
      ['move_west', 'h'],
      ['move_east', 'l'],
      ['move_northwest', 'y'],
      ['move_northeast', 'u'],
      ['move_southwest', 'b'],
      ['move_southeast', 'n'],
    ];
    for (const [action, value] of BACK) {
      expect(conflictsFor({ action, binding: key(value) }, DEFAULT_KEYMAP)).toEqual([]);
      const written = setBinding({}, action, 1, key(value));
      expect(resolve(def(action), written)[1]).toEqual(key(value));
      expect(compileKeymap(ACTIONS, written).dirByKey.get(value)).toBe(
        (def(action).effect as { readonly dir: Dir }).dir,
      );
    }
  });

  it('...but an arrow on the WRONG direction is refused, and honestly', () => {
    // Up on `move_west` really would be eaten: with NumLock off Numpad8 reports
    // 'ArrowUp', and `directionFor` reads `event.code` FIRST, so north keeps it.
    // The screen names north rather than letting the bind appear to take.
    const clash = conflictsFor({ action: 'move_west', binding: key('arrowup') }, DEFAULT_KEYMAP);
    expect(clash.map((c) => c.holder)).toEqual(['move_north']);
  });

  it('...and `j` back onto south is refused by NAME, because the Journal holds it', () => {
    // ═══ THE ONE KEY THE RULING TOOK AWAY AND DID NOT GIVE BACK ═══
    // *"players can always rebind them later"* is true of seven of the vi ring;
    // `j` is the eighth and it has an owner now. That is not the promise broken
    // — a player who wants south on `j` clears the Journal's slot first, which
    // is the ordinary two-step every occupied key in this screen takes — but a
    // SILENT take would be: `directionFor` runs before `uiByKey`, so a bind that
    // "worked" would have stolen the Journal key with nothing said.
    const clash = conflictsFor({ action: 'move_south', binding: key('j') }, DEFAULT_KEYMAP);
    expect(clash.map((c) => c.holder)).toEqual(['show_journal']);

    // AND IT REALLY IS RELEASABLE, so the refusal is a queue and not a wall.
    const freed = compileKeymap(ACTIONS, { show_journal: [SLOT_NONE] });
    expect(conflictsFor({ action: 'move_south', binding: key('j') }, freed)).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MIGRATION. KEYBINDS PERSIST SERVER-SIDE, SO EVERY MAP ALREADY WRITTEN IS
 * A MAP THIS BUILD HAS TO ACCEPT.
 * ═══════════════════════════════════════════════════════════════════════════
 * STORAGE IS OVERRIDES ONLY, and that is the fact the whole rule rests on: the
 * overlay is SPARSE (`KeyRemap`, and `writeSlot`/`tidy` keep it so), so a player
 * who never opened the Keys screen has NO entry for `move_north` and simply gets
 * `w`. The only maps needing repair are the ones somebody actually wrote.
 */
describe('a stored keymap written before the WASD ruling', () => {
  /**
   * WHAT A MIGRATED MAP LOOKS LIKE ON DISK: the repaired overlay PLUS the stamp.
   *
   * Every `toEqual` below used to compare against the bare map — `expect(
   * migrated).toEqual(mine)` — which was right until `migrateStoredKeymap`
   * started recording that it had run. It has to record it: without the stamp
   * the rules run on EVERY `keybinds` frame, the server echoes one after every
   * accepted `set_keybinds`, and a player who deliberately bound a retired key
   * had it stripped on the echo and then deleted from their character file by
   * the write-back. See `KEYMAP_GEN_ID`.
   */
  const stamped = (map: KeyRemap): KeyRemap => ({ ...map, [KEYMAP_GEN_ID]: [KEYMAP_GEN] });

  /** What a player who had rebound the vi ring to itself has on disk. */
  const OLD_DEFAULTS: KeyRemap = {
    move_north: ['key:k'],
    move_south: ['key:j'],
    move_west: ['key:h'],
    move_east: ['key:l'],
    move_northwest: ['key:y'],
  };

  it('moves to the new defaults, slot by slot', () => {
    const migrated = migrateStoredKeymap(ACTIONS, OLD_DEFAULTS);
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.dirByKey.get('w')).toBe(Dir.N);
    expect(keymap.dirByKey.get('a')).toBe(Dir.W);
    expect(keymap.dirByKey.get('s')).toBe(Dir.S);
    expect(keymap.dirByKey.get('d')).toBe(Dir.E);
    // ...and the retired letters answer to nothing.
    for (const letter of ['k', 'j', 'h', 'l', 'y']) {
      expect(keymap.dirByKey.get(letter)).toBeUndefined();
    }
  });

  it('resets to `default` and NOT to `none`, which would leave a direction dead', () => {
    // ═══ THIS IS THE BUG THE OLD MIGRATION SHIPPED WITH ═══
    // It wrote `SLOT_NONE` while its own docblock promised the slot "falls back
    // to the action's own default". `SLOT_NONE` is DELIBERATELY EMPTY —
    // `resolveSlot` answers `undefined` for it — so a migrated row ended with no
    // key at all. Harmless-looking for `toggle_log`; for `move_south` it is a
    // direction the player cannot walk in, on a map, with no explanation.
    const migrated = migrateStoredKeymap(ACTIONS, OLD_DEFAULTS);
    expect(migrated.move_south).not.toContain(SLOT_NONE);
    expect(resolve(def('move_south'), migrated)).toEqual([key('s'), undefined]);
    // AND THE ENTRY IS TIDIED AWAY ENTIRELY, so the store goes back to sparse.
    expect(migrated.move_south).toEqual([]);
  });

  it("frees `j`, so the Journal's key cannot be swallowed by a stale step", () => {
    // ═══ THE ONE THAT WOULD HAVE BEEN FOUND IN PLAY, NOT IN A TEST ═══
    // `directionFor` reads the direction tables BEFORE `uiByKey` — keys.ts calls
    // that order load-bearing — so a surviving `move_south: ['key:j']` does not
    // merely coexist with a Journal on `j`, it TAKES it. The one player who had
    // rebound movement would be the one player for whom the new panel silently
    // walks them south.
    //
    // ═══ DRIVEN AGAINST THE SHIPPED TABLE NOW, AND IT USED TO BE A FIXTURE ═══
    // This case was written an hour before the panel existed, against a
    // synthetic `toggle_journal` row appended to `ACTIONS`, so that the RULE
    // could be tested without waiting on it. The row landed as `show_journal`,
    // and a test still asserting against its own invented row would be
    // `tests-true-of-the-fixture` written down: it would pass for ever whatever
    // the real table did. `ACTIONS` is the subject.
    const migrated = migrateStoredKeymap(ACTIONS, OLD_DEFAULTS);
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.dirByKey.get('j')).toBeUndefined();
    expect(resolveAction({ key: 'j', code: 'KeyJ' }, keymap)).toBe('show_journal');

    // AND THE MIGRATION IS WHAT DID IT, not the compile: the SAME stored map
    // handed straight to `compileKeymap` walks the player south on the Journal
    // key. This is the line that fails if rule two is ever weakened.
    const unmigrated = compileKeymap(ACTIONS, OLD_DEFAULTS);
    expect(unmigrated.dirByKey.get('j')).toBe(Dir.S);
    expect(resolveAction({ key: 'j', code: 'KeyJ' }, unmigrated)).toBe('move_south');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OTHER HALF OF ADDING A ROW ON AN OCCUPIED-LOOKING LETTER: `j` STORED ON
   * SOMETHING THAT IS NOT MOVEMENT.
   * ═══════════════════════════════════════════════════════════════════════════
   * Rule two only knows about keys an action USED to ship. A player who went to
   * the Keys screen and put `j` on the log themselves is holding a key no
   * `RETIRED_DEFAULTS` entry names — and `compileKeymap` settles a collision by
   * `order`, so the Journal (23) would win over `toggle_log` (33) and that
   * player's deliberate bind would be a dead key with nothing saying so.
   *
   * Rule one is what answers it, and this is the first time the shipped table
   * has moved a default onto a letter another action could already be holding.
   */
  it('gives a deliberate `j` bind back its own default rather than leaving it dead', () => {
    const migrated = migrateStoredKeymap(ACTIONS, { toggle_log: ['key:j'] });
    // RESET, NOT REWRITTEN: the slot falls back to `v`, which is what
    // `SLOT_DEFAULT` means. Moving it to some other letter would be inventing a
    // preference nobody expressed.
    expect(resolve(def('toggle_log'), migrated)[0]).toEqual(key('v'));
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.uiByKey.get('v')).toBe(UiCommand.ToggleLog);
    expect(keymap.uiByKey.get('j')).toBe(UiCommand.ShowJournal);
  });

  it('...but keeps it when the player moved the Journal off `j` themselves', () => {
    // NO COLLISION, NOTHING TO REPAIR. `ownerKeeps` asks whether the owner still
    // RESOLVES to that key for THIS player, not whether the shipped table says
    // it does — so a player who rebound the Journal to `x` and the log to `j`
    // has expressed two preferences and keeps both. Byte-identical, because
    // "keeps it" has to mean the stored map is not rewritten at all.
    const stored: KeyRemap = { toggle_log: ['key:j'], show_journal: ['key:x'] };
    const migrated = migrateStoredKeymap(ACTIONS, stored);
    // WAS `toEqual(stored)`. The stamp is the only difference; see `stamped`.
    expect(migrated).toEqual(stamped(stored));
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.uiByKey.get('j')).toBe(UiCommand.ToggleLog);
    expect(keymap.uiByKey.get('x')).toBe(UiCommand.ShowJournal);
  });

  it('leaves a DELIBERATE rebind exactly where the player put it', () => {
    // The other half of the ruling, and the half a blunt "reset every movement
    // action" would have broken: a stored key that was never a default of this
    // action is a preference, and preferences survive upgrades.
    const mine: KeyRemap = {
      move_north: ['key:t'],
      move_southwest: [SLOT_DEFAULT, 'key:x'],
      say: ['key:q'],
    };
    const migrated = migrateStoredKeymap(ACTIONS, mine);
    // WAS `toEqual(mine)` / `sameRemap(migrated, mine) === true`. The stamp is
    // the only difference, and it is what makes the NEXT load leave this alone.
    expect(migrated).toEqual(stamped(mine));
    expect(sameRemap(migrateStoredKeymap(ACTIONS, migrated), migrated)).toBe(true);
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.dirByKey.get('t')).toBe(Dir.N);
    expect(keymap.dirByKey.get('x')).toBe(Dir.SW);
    // ...and `w` is NOT also north: slot 0 was overwritten, which is `resolve`'s
    // per-slot rule rather than anything the migration did.
    expect(keymap.dirByKey.get('w')).toBeUndefined();
  });

  it('only resets a retired key on the action that used to ship it', () => {
    // `k` was north's. On `rest` it is somebody's own choice and it stays —
    // otherwise `RETIRED_DEFAULTS` would be a blocklist of eight letters nobody
    // could ever use again.
    const migrated = migrateStoredKeymap(ACTIONS, { rest: ['key:k'] });
    // WAS `toEqual({ rest: ['key:k'] })`.
    expect(migrated).toEqual(stamped({ rest: ['key:k'] }));
    expect(compileKeymap(ACTIONS, migrated).commandByKey.get('k')).toBe(TurnCommand.Rest);
  });

  it('repairs a key another action now defaults to — the world-map case', () => {
    // The rule that was already here: a save written before the world map still
    // says `toggle_log: ['key:m']`, both land in `uiByKey`, the later action
    // wins, and the returning player presses M and gets the log.
    const migrated = migrateStoredKeymap(ACTIONS, { toggle_log: ['key:m'] });
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.uiByKey.get('m')).toBe(UiCommand.ShowWorldMap);
    // ...AND THE LOG STILL HAS A KEY, which is what `SLOT_NONE` used to cost it.
    expect(keymap.uiByKey.get('v')).toBe(UiCommand.ToggleLog);
  });

  it('...but not when the owner has itself been rebound away', () => {
    // There is no collision to repair when the player has moved the world map
    // off `m` themselves. The docblock always claimed such a player "keeps it";
    // before `ownerKeeps` existed they did not, because the owner was read off
    // the SHIPPED table and never off this player's own map.
    const mine: KeyRemap = { toggle_log: ['key:m'], show_world_map: ['key:o'] };
    const migrated = migrateStoredKeymap(ACTIONS, mine);
    // WAS `toEqual(mine)`.
    expect(migrated).toEqual(stamped(mine));
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.uiByKey.get('m')).toBe(UiCommand.ToggleLog);
    expect(keymap.uiByKey.get('o')).toBe(UiCommand.ShowWorldMap);
  });

  it('runs to a fixed point, so the caller never writes back twice', () => {
    // Rule two frees `s` by resetting `j`, and only THEN is the stored `s` on
    // another action a collision rule one can see. One pass would leave this map
    // changing again next load — and since `main.ts` writes the result back,
    // that is a `set_keybinds` frame every session for ever.
    const chained: KeyRemap = { move_south: ['key:j'], toggle_log: ['key:s'] };
    const once = migrateStoredKeymap(ACTIONS, chained);
    expect(migrateStoredKeymap(ACTIONS, once)).toEqual(once);
    const keymap = compileKeymap(ACTIONS, once);
    expect(keymap.dirByKey.get('s')).toBe(Dir.S);
    expect(keymap.uiByKey.get('v')).toBe(UiCommand.ToggleLog);
  });

  it('is idempotent on a map it has already repaired', () => {
    const once = migrateStoredKeymap(ACTIONS, OLD_DEFAULTS);
    expect(sameRemap(migrateStoredKeymap(ACTIONS, once), once)).toBe(true);
  });

  it('touches nothing for the player who never opened the Keys screen', () => {
    // The common case, and the reason storage being OVERRIDES ONLY matters: an
    // empty overlay needs no migration and gets the new defaults for free.
    // WAS `toEqual({})` and `sameRemap(..., {}) === true`. An empty overlay
    // still needs NOTHING repaired — and it is the map that most needs the
    // stamp, because the player who has never opened the Keys screen is the one
    // most likely to open it tomorrow and choose a retired letter.
    expect(migrateStoredKeymap(ACTIONS, {})).toEqual(stamped({}));
    const once = migrateStoredKeymap(ACTIONS, {});
    expect(sameRemap(migrateStoredKeymap(ACTIONS, once), once)).toBe(true);
  });

  it('leaves a `code:` slot and an unknown action id alone', () => {
    // The migration reads key-side strings only. A numpad override and an id
    // this build no longer binds both round-trip, which is what lets a
    // renamed-then-restored action come back.
    const odd: KeyRemap = { ui_toggle_lore: ['key:k'], commit: ['code:NumpadAdd'] };
    // WAS `toEqual(odd)`.
    expect(migrateStoredKeymap(ACTIONS, odd)).toEqual(stamped(odd));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BUG THIS BLOCK EXISTS FOR: A REBIND MADE TODAY IS NOT AN OLD DEFAULT.
   * ═══════════════════════════════════════════════════════════════════════════
   * Rule two resets a slot holding a key `RETIRED_DEFAULTS` names for that
   * action. Four bytes of `key:k` on `move_north` are the same four bytes
   * whether the file was written in M2 or five seconds ago, and this ran on
   * EVERY `keybinds` frame — including the echo the server sends after every
   * accepted `set_keybinds`. So the returning roguelike player who put K back on
   * north watched the status line accept it, watched the row revert to `W --`
   * one round trip later, and had the binding deleted from their character file
   * by the write-back that was supposed to be the mitigation.
   *
   * The old suite could not see it: its "deliberate rebind survives" case used
   * `t`, `x` and `q` — three keys no `RETIRED_DEFAULTS` row names — which is
   * `tests-true-of-the-fixture` exactly. And nothing ran a map through the
   * migration TWICE WITH A COMMIT IN BETWEEN, which is what an echo is.
   */
  describe('the stamp, which is what makes it an upgrade and not a standing rule', () => {
    it('leaves a stamped map completely alone, retired keys and all', () => {
      // EVERY letter of the vi ring, put back deliberately, on its own action.
      const deliberate: KeyRemap = {
        move_north: [SLOT_DEFAULT, 'key:k'],
        move_south: [SLOT_DEFAULT, 'key:j'],
        move_west: [SLOT_DEFAULT, 'key:h'],
        move_east: [SLOT_DEFAULT, 'key:l'],
        move_northeast: [SLOT_DEFAULT, 'key:u'],
        move_northwest: [SLOT_DEFAULT, 'key:y'],
        move_southwest: [SLOT_DEFAULT, 'key:b'],
        move_southeast: [SLOT_DEFAULT, 'key:n'],
        [KEYMAP_GEN_ID]: [KEYMAP_GEN],
      };
      expect(migrateStoredKeymap(ACTIONS, deliberate)).toBe(deliberate);
      const keymap = compileKeymap(ACTIONS, deliberate);
      expect(keymap.dirByKey.get('k')).toBe(Dir.N);
      expect(keymap.dirByKey.get('y')).toBe(Dir.NW);
      // ...and WASD is still there, because these went in the SECOND slot.
      expect(keymap.dirByKey.get('w')).toBe(Dir.N);
    });

    it('survives the echo: bind, migrate, migrate again, still bound', () => {
      // THE ROUND TRIP, NOT A SINGLE CALL. `main.ts` migrates every `keybinds`
      // frame and the server echoes one after every accepted `set_keybinds`, so
      // "the player kept it" means the SECOND migration is a no-op too.
      const live = migrateStoredKeymap(ACTIONS, {});
      const bound = setBinding(live, 'move_north', 1, key('k'));
      const echo = migrateStoredKeymap(ACTIONS, bound);
      expect(sameRemap(echo, bound)).toBe(true);
      expect(compileKeymap(ACTIONS, echo).dirByKey.get('k')).toBe(Dir.N);
      // ...and the login after that.
      expect(sameRemap(migrateStoredKeymap(ACTIONS, echo), echo)).toBe(true);
    });

    it('upgrades a file stamped with an OLDER generation', () => {
      // THE STAMP IS COMPARED, NOT MERELY PRESENT — which is what makes bumping
      // `KEYMAP_GEN` the upgrade switch. A build that changes a shipped default
      // adds the old key to `RETIRED_DEFAULTS` and bumps the number, and every
      // stored map in the world is migrated exactly once more. If this only
      // asked "is there a stamp?", that bump would do nothing.
      const older: KeyRemap = { move_south: ['key:j'], [KEYMAP_GEN_ID]: ['1'] };
      expect(KEYMAP_GEN).not.toBe('1');
      const migrated = migrateStoredKeymap(ACTIONS, older);
      expect(migrated).toEqual(stamped({ move_south: [] }));
      expect(compileKeymap(ACTIONS, migrated).uiByKey.get('j')).toBe(UiCommand.ShowJournal);
    });

    it('still repairs a file written before the stamp existed', () => {
      // The other side of the same coin: absence of the stamp IS generation one.
      expect(OLD_DEFAULTS[KEYMAP_GEN_ID]).toBeUndefined();
      const migrated = migrateStoredKeymap(ACTIONS, OLD_DEFAULTS);
      expect(migrated[KEYMAP_GEN_ID]).toEqual([KEYMAP_GEN]);
      expect(compileKeymap(ACTIONS, migrated).dirByKey.get('k')).toBeUndefined();
    });

    it('is an id no action can ever own', () => {
      // The leading underscore is the guard, so it has to be a guard: every
      // shipped id starts with a LETTER, which is what makes `_keymap_gen`
      // unable to collide with an action somebody adds later.
      expect(KEYMAP_GEN_ID.startsWith('_')).toBe(true);
      for (const action of ACTIONS) expect(action.id).toMatch(/^[a-z][a-z0-9_]*$/);
      // ...and it fits the wire, with room to spare on both caps.
      expect(KEYMAP_GEN_ID.length).toBeLessThanOrEqual(KEYBIND_ACTION_MAX_CHARS);
      expect(ACTIONS.length + 1).toBeLessThanOrEqual(KEYBIND_MAX_ACTIONS);
    });

    it('does not shadow, hide or rename any action row', () => {
      // The stamp rides in the same record as the bindings, so the one thing
      // that must never happen is it being read AS one.
      const stampedOnly = migrateStoredKeymap(ACTIONS, {});
      expect(compileKeymap(ACTIONS, stampedOnly)).toEqual({
        ...DEFAULT_KEYMAP,
        remap: stampedOnly,
      });
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE POPULATION MOST LIKELY TO EXIST: hjkl KEPT, wasd ADDED BESIDE IT.
   * ═══════════════════════════════════════════════════════════════════════════
   * W/A/S/D were free before the ruling, so "I will keep the vi keys and put
   * WASD in the other slot" is what a player did with two slots and four spare
   * letters. Rule two frees slot 0, slot 0 falls back to the SHIPPED default —
   * which is now `w` — and the row reads `W  W`: a second key they deliberately
   * configured is gone and the screen advertises the redundancy in its place.
   */
  it('never leaves a freed slot duplicating a key the player still holds', () => {
    const both: KeyRemap = {
      move_north: ['key:k', 'key:w'],
      move_west: ['key:h', 'key:a'],
      move_south: ['key:j', 'key:s'],
      move_east: ['key:l', 'key:d'],
    };
    const migrated = migrateStoredKeymap(ACTIONS, both);
    // PURE DEFAULTS. Both slots said `w`; one of them was saying nothing.
    expect(migrated).toEqual(
      stamped({ move_north: [], move_west: [], move_south: [], move_east: [] }),
    );
    for (const [id, letter, dir] of [
      ['move_north', 'w', Dir.N],
      ['move_west', 'a', Dir.W],
      ['move_south', 's', Dir.S],
      ['move_east', 'd', Dir.E],
    ] as const) {
      expect(resolve(def(id), migrated)).toEqual([key(letter), undefined]);
      expect(compileKeymap(ACTIONS, migrated).dirByKey.get(letter)).toBe(dir);
    }
  });

  it('does not collapse a slot that is a genuinely different key', () => {
    // The guard on the rule above: only a slot saying the SAME thing as the
    // freed one goes. A second key the player can actually press is a second
    // key, and it stays.
    const mixed: KeyRemap = { move_north: ['key:k', 'key:t'] };
    const migrated = migrateStoredKeymap(ACTIONS, mixed);
    expect(migrated).toEqual(stamped({ move_north: [SLOT_DEFAULT, 'key:t'] }));
    const live = compileKeymap(ACTIONS, migrated);
    expect(live.dirByKey.get('w')).toBe(Dir.N);
    expect(live.dirByKey.get('t')).toBe(Dir.N);
    expect(live.dirByKey.get('k')).toBeUndefined();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `sameRemap` IS THE WRITE-BACK'S GATE, AND ITS VALUE COMPARISON WAS UNTESTED.
   * ═══════════════════════════════════════════════════════════════════════════
   * Every call in this file was `toBe(true)`, and every migration fixture used
   * ONE-SLOT arrays — where a reset changes the LENGTH, which a comparison that
   * only checked ids and lengths can still see. Deleting the value loop survived
   * the whole suite. A repair in slot 0 with slot 1 occupied keeps the length,
   * and that map is the one that then gets no write-back at all.
   */
  it('sameRemap is FALSE when only a slot string moved', () => {
    expect(
      sameRemap({ move_south: [SLOT_DEFAULT, 'key:t'] }, { move_south: ['key:j', 'key:t'] }),
    ).toBe(false);
  });

  it('repairs slot 0 of a two-slot entry, and says the map changed', () => {
    const stored: KeyRemap = { toggle_log: ['key:m', 'key:t'] };
    const migrated = migrateStoredKeymap(ACTIONS, stored);
    expect(migrated.toggle_log).toEqual([SLOT_DEFAULT, 'key:t']);
    // THE GATE ITSELF. `main.ts` sends the corrected map only when this is
    // false, so a `true` here is a player whose file keeps the stale binding.
    expect(sameRemap(migrated, stored)).toBe(false);
  });

  it('runs the chained case to a fixed point with both entries two slots wide', () => {
    // The existing fixed-point test uses one-slot entries, so it cannot fail for
    // a `sameRemap` that stopped comparing values. This one can: pass one
    // repairs `move_south`, pass two is the only place `toggle_log`'s `s`
    // becomes a collision, and both lengths stay at two throughout.
    const chained: KeyRemap = { move_south: ['key:j', 'key:t'], toggle_log: ['key:s', 'key:0'] };
    const migrated = migrateStoredKeymap(ACTIONS, chained);
    expect(migrated.move_south).toEqual([SLOT_DEFAULT, 'key:t']);
    expect(migrated.toggle_log).toEqual([SLOT_DEFAULT, 'key:0']);
    expect(sameRemap(migrateStoredKeymap(ACTIONS, migrated), migrated)).toBe(true);
    const keymap = compileKeymap(ACTIONS, migrated);
    expect(keymap.dirByKey.get('s')).toBe(Dir.S);
    expect(keymap.uiByKey.get('v')).toBe(UiCommand.ToggleLog);
  });

  /**
   * THE `!stillMine` GUARD, WHICH TODAY'S TABLE CANNOT REACH.
   *
   * No action's CURRENT default is also in its `RETIRED_DEFAULTS` row, so
   * dropping `!stillMine` from rule two is an equivalent mutant against the
   * shipped table — measured, not assumed. It is still real insurance: a ledger
   * row that named a LIVE default would reset the shipped key on every load, and
   * this guard is the only thing that stops it. `migrateStoredKeymap` takes
   * `actions` as a parameter precisely so a synthetic table can ask.
   */
  it('never resets a key the action still defaults to, even if the ledger names it', () => {
    const stillK: readonly ActionDef[] = ACTIONS.map((action) =>
      action.id === 'move_north' ? { ...action, defaults: [key('k')] } : action,
    );
    expect(RETIRED_DEFAULTS.get('move_north')).toEqual(['key:k']);
    const stored: KeyRemap = { move_north: ['key:k'] };
    expect(migrateStoredKeymap(stillK, stored)).toEqual(stamped(stored));
  });

  it('names the vi ring and nothing else, and no arrow', () => {
    // `RETIRED_DEFAULTS` is an UPGRADE LEDGER: every row costs a player a key
    // they cannot keep across one load, so it must hold only what a stored map
    // can actually contain. The arrows were `fixed` — outside the overlay, never
    // serialised — so no save has ever held one and no row may claim otherwise.
    expect([...RETIRED_DEFAULTS.keys()].sort()).toEqual(
      ACTIONS.filter((a) => a.effect.kind === 'move')
        .map((a) => a.id)
        .sort(),
    );
    for (const [, keys] of RETIRED_DEFAULTS) {
      for (const stored of keys) {
        expect(stored.startsWith('key:')).toBe(true);
        expect(stored.includes('arrow')).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE NUMBER ROW, KEY BY KEY — the join nobody was making
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWELVE PHYSICAL KEYS, AND THE EVENT EACH ONE PRODUCES. THE SPEC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Written out here and derived from NOTHING in `src/`, which is the only shape
 * that can fail. The coverage this replaces was a three-line spot check —
 * `slotByKey.get('1') === 0`, `slotByCode.get('Digit5') === 4`, `Digit6 === 5`
 * — so mutating `hotbar_5` was caught and mutating `hotbar_8` was not, and the
 * three slots added for `ledger/unwritten` arrived asserted only as MEMBERS of
 * two lists. Measured: moving `hotbar_11`'s effect from slot 10 to slot 11 —
 * which makes `-` and `=` both fire slot 12 and leaves slot 11 UNPRESSABLE —
 * left all 6970 tests green, and re-binding `hotbar_10` from `Digit0` to
 * `BracketLeft` while the bar kept painting `0` on it left all 2013 client
 * tests green. That second one is the failure `hotbarKeyLabel`'s own note
 * calls *"the single worst failure a hotbar has"*.
 *
 * `key` and `code` are what a browser reports on a US layout: the digits are
 * `Digit0`-`Digit9`, and the two beside them are `Minus` and `Equal`.
 * `keys.ts` reads `slotByCode` first and `slotByKey` second (:666, :673), so a
 * row bound either way is reachable by the press this table describes.
 */
const NUMBER_ROW: readonly { readonly printed: string; readonly code: string }[] = [
  { printed: '1', code: 'Digit1' },
  { printed: '2', code: 'Digit2' },
  { printed: '3', code: 'Digit3' },
  { printed: '4', code: 'Digit4' },
  { printed: '5', code: 'Digit5' },
  { printed: '6', code: 'Digit6' },
  { printed: '7', code: 'Digit7' },
  { printed: '8', code: 'Digit8' },
  { printed: '9', code: 'Digit9' },
  { printed: '0', code: 'Digit0' },
  { printed: '-', code: 'Minus' },
  { printed: '=', code: 'Equal' },
];

describe('every hotbar slot has a key, and it is the key the bar prints', () => {
  it('has one row entry per slot', () => {
    expect(NUMBER_ROW).toHaveLength(HOTBAR_KEY_ROW);
    // AND THE BAR PRINTS EXACTLY THESE, IN THIS ORDER. `HOTBAR_ROW_KEYS` is
    // what `hotbarKeyLabel` paints; this table is what a keyboard sends. The
    // two have never been compared to each other anywhere in the suite.
    expect(NUMBER_ROW.map((row) => row.printed)).toEqual([...HOTBAR_ROW_KEYS]);
  });

  it('walks every slot from the press to the number', () => {
    const keymap = compileKeymap(ACTIONS, {});
    NUMBER_ROW.forEach((row, slot) => {
      const fromCode = keymap.slotByCode.get(row.code);
      const fromKey = keymap.slotByKey.get(row.printed);
      const reached = fromCode ?? fromKey;
      expect(reached, `pressing ${row.printed} reaches no slot at all`).toBeDefined();
      expect(reached, `pressing ${row.printed} reaches the wrong slot`).toBe(slot);
    });
  });

  it('gives each slot exactly one key, so no two keys share one', () => {
    // The `hotbar_11 -> slot 11` mutant makes `-` and `=` both fire slot 12 and
    // leaves slot 11 with nothing at all. A per-slot walk catches the second
    // half; this catches the first, and says which failure it is.
    const keymap = compileKeymap(ACTIONS, {});
    const reached = NUMBER_ROW.map(
      (row) => keymap.slotByCode.get(row.code) ?? keymap.slotByKey.get(row.printed),
    );
    expect(new Set(reached).size, 'two keys fire the same slot').toBe(HOTBAR_KEY_ROW);
  });

  it('names every one of them, so the Keys screen agrees with the game', () => {
    // `resolveAction` is the Keys screen's reader of the same tables. A press
    // the game answers and that function cannot name puts "unbound" beside a
    // key that works.
    const keymap = compileKeymap(ACTIONS, {});
    NUMBER_ROW.forEach((row, slot) => {
      const named = resolveAction({ code: row.code, key: row.printed }, keymap);
      expect(named, `pressing ${row.printed} is nameless`).toBe(`hotbar_${String(slot + 1)}`);
    });
  });
});
