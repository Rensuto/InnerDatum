/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { TurnCommand, UiCommand, bindGameKeys } from '../../../src/client/input/keys.ts';
import { Dir } from '../../../src/shared/coords.ts';
import type { KeyHandlers } from '../../../src/client/input/keys.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEYMAP, READ THE WAY A KEYPRESS READS IT. NOTHING IS DRAWN AND NOTHING
 * IS SENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until v8 there was NO test over src/client/input/keys.ts at all — eleven files
 * in test/client/ and no input/ directory — so the three rules that file states
 * at length were protected by prose alone:
 *
 *   THE DISPATCH ORDER   `directionFor` reads `event.code` and runs FIRST, which
 *                        is the only thing stopping the numpad's diagonals from
 *                        being eaten by the hotbar digits. With NumLock on,
 *                        Numpad1 reports `event.key === '1'`. Reorder those two
 *                        lookups and numpad movement silently becomes a hotbar
 *                        press — the failure is invisible to anyone testing on a
 *                        laptop, and it is the exact shape keys.ts:201-211 warns
 *                        about in a comment.
 *   THE MODIFIER POLICY  ctrl/alt/meta are refused because they are the browser's
 *                        and Discord's shortcut space; SHIFT IS NOT, because a
 *                        shift-holding player still means H as "move west".
 *                        Excluding shift by accident would break the vi keys for
 *                        anyone with capslock on and nothing else.
 *   THE TEXT-ENTRY GUARD A keydown whose target is an INPUT is dropped whole, or
 *                        typing "j" in the command line walks your character
 *                        south and hitting space mid-sentence ends your turn.
 *
 * v8 moves a key (the Case Log from `c` to `m`) and adds one (`c` opens the
 * character sheet), which is precisely the kind of edit that quietly drops a row
 * on the way past. Every pre-existing row is asserted here so that the next such
 * move has to be deliberate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO DOM GLOBALS ARE FAKED, AND THERE IS NO OTHER WAY TO REACH THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 * vitest.config.ts is explicit that the environment is `node` and that there is
 * deliberately no jsdom. Node supplies `Event` and `EventTarget` natively, so the
 * listener plumbing is real — but `KeyboardEvent` and `HTMLElement` do not exist
 * there, and keys.ts branches on `instanceof` for both. An undefined global in an
 * `instanceof` is a ReferenceError, not a false, so the two classes below are
 * installed on `globalThis` before anything is dispatched. They are the ONLY
 * fakes here: the binding, the dispatch, the listener order and the
 * `preventDefault` are all Node's own, so what is under test is the real
 * handler and not a re-implementation of it.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented in
 * test/client/turncards.test.ts:52-63: tests compile under tsconfig.server.json,
 * whose `lib` is ES2024 with no DOM, and keys.ts is typed against
 * `KeyboardEvent`, `HTMLElement` and `EventTarget`.
 */

// ---------------------------------------------------------------------------
// The two faked globals
// ---------------------------------------------------------------------------

/**
 * Stands in for an `<input>` — or for any element, via `tagName`.
 *
 * It extends the real `EventTarget` so that a press can be dispatched ON it and
 * arrive with `event.target` already pointing at it, which is exactly the shape
 * the browser produces when somebody types into the command line. Faking the
 * `target` accessor on the event instead would be testing our own getter.
 */
class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
}

type KeyInit = {
  /** `event.key`, exactly as the browser spells it — 'ArrowUp', ' ', 'Escape'. */
  readonly key: string;
  /** `event.code`, the PHYSICAL key. 'Numpad1' is the whole point of this file. */
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
};

/** A keydown with the six fields keys.ts actually reads, and nothing else. */
class FakeKeyboardEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;

  constructor(init: KeyInit) {
    // `cancelable`, or `defaultPrevented` never flips and the assertions about
    // swallowed keys would pass against a handler that had stopped calling
    // preventDefault — which is the bug that scrolls the activity iframe and
    // drags the canvas out of view.
    super('keydown', { cancelable: true });
    this.key = init.key;
    this.code = init.code ?? '';
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.KeyboardEvent = FakeKeyboardEvent;
globals.HTMLElement = FakeElement;

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * One handler call, as a value.
 *
 * A tagged list rather than six spies, so a press can be asserted as "this and
 * NOTHING ELSE" in one comparison — which is the actual claim for the numpad: not
 * merely that it moved, but that it did not ALSO fire a hotbar slot.
 */
type Call =
  | { readonly kind: 'move'; readonly dir: Dir }
  | { readonly kind: 'command'; readonly command: TurnCommand }
  | { readonly kind: 'slot'; readonly slot: number }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ui'; readonly command: UiCommand }
  | { readonly kind: 'scroll'; readonly steps: number; readonly alternate: boolean };

function recorder(calls: Call[]): KeyHandlers {
  return {
    onMove: (dir) => {
      calls.push({ kind: 'move', dir });
    },
    onCommand: (command) => {
      calls.push({ kind: 'command', command });
    },
    onSlot: (slot) => {
      calls.push({ kind: 'slot', slot });
    },
    onCancel: () => {
      calls.push({ kind: 'cancel' });
    },
    onUi: (command) => {
      calls.push({ kind: 'ui', command });
    },
    onScroll: (steps, alternate) => {
      calls.push({ kind: 'scroll', steps, alternate });
    },
  };
}

/**
 * Bind, press once, unbind. Answers what the handlers saw and whether the key was
 * swallowed.
 *
 * A fresh binding per press so no test can be affected by a listener another one
 * left behind — the disposer is exercised on every single call as a side effect,
 * which is worth more than the one test that asserts it directly.
 */
function press(init: KeyInit, on?: EventTarget): { calls: Call[]; prevented: boolean } {
  const calls: Call[] = [];
  const target = on ?? new EventTarget();
  const binding = bindGameKeys(target, recorder(calls));
  const event = new FakeKeyboardEvent(init);
  target.dispatchEvent(event);
  binding.dispose();
  return { calls, prevented: event.defaultPrevented };
}

// ---------------------------------------------------------------------------
// The numpad rule — the silent breakage
// ---------------------------------------------------------------------------

describe('the numpad claims its diagonals before the hotbar digits', () => {
  /**
   * With NumLock ON these four keys report `event.key` as a bare digit. If
   * KEY_TO_SLOT were consulted first — or if a new lookup were inserted above
   * `directionFor` — each one would fire a talent instead of stepping, and the
   * player would see a hotbar press they never made.
   */
  const NUMLOCK_DIAGONALS: readonly (readonly [string, string, Dir])[] = [
    ['Numpad1', '1', Dir.SW],
    ['Numpad3', '3', Dir.SE],
    ['Numpad7', '7', Dir.NW],
    ['Numpad9', '9', Dir.NE],
  ];

  for (const [code, key, dir] of NUMLOCK_DIAGONALS) {
    it(`${code} reporting key "${key}" steps ${dir} and fires no slot`, () => {
      const { calls, prevented } = press({ key, code });
      expect(calls).toEqual([{ kind: 'move', dir }]);
      expect(prevented).toBe(true);
    });
  }

  it('the NUMBER ROW still fires the hotbar, so the fix costs the digits nothing', () => {
    expect(press({ key: '1', code: 'Digit1' }).calls).toEqual([{ kind: 'slot', slot: 0 }]);
    expect(press({ key: '3', code: 'Digit3' }).calls).toEqual([{ kind: 'slot', slot: 2 }]);
  });

  it('the orthogonal numpad keys move too, NumLock on or off', () => {
    // NumLock OFF reports 'ArrowUp' for Numpad8; ON reports '8'. Both are the
    // same physical key and both must step north.
    expect(press({ key: '8', code: 'Numpad8' }).calls).toEqual([{ kind: 'move', dir: Dir.N }]);
    expect(press({ key: 'ArrowUp', code: 'Numpad8' }).calls).toEqual([
      { kind: 'move', dir: Dir.N },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The modifier policy
// ---------------------------------------------------------------------------

describe('the modifier policy', () => {
  it('drops ctrl, alt and meta entirely — they belong to the browser and Discord', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      const { calls, prevented } = press({ key: 'h', [modifier]: true });
      expect(calls).toEqual([]);
      // NOT swallowed either: Ctrl+W must still close the tab, and a key this
      // file refuses is a key it must leave completely alone.
      expect(prevented).toBe(false);
    }
  });

  it('does NOT drop shift — a shift-holding player still means H as "move west"', () => {
    expect(press({ key: 'h', shiftKey: true }).calls).toEqual([{ kind: 'move', dir: Dir.W }]);
    // ...and the same key with capslock on arrives as a capital.
    expect(press({ key: 'H' }).calls).toEqual([{ kind: 'move', dir: Dir.W }]);
  });
});

// ---------------------------------------------------------------------------
// The text-entry guard
// ---------------------------------------------------------------------------

describe('the text-entry guard', () => {
  it('drops every key whose target is an INPUT', () => {
    const field = new FakeElement('INPUT');
    // 'j' would walk south and ' ' would end the turn. Both are what somebody
    // typing "on my way" into the command line is actually doing.
    expect(press({ key: 'j' }, field).calls).toEqual([]);
    expect(press({ key: ' ' }, field).calls).toEqual([]);
    expect(press({ key: ' ' }, field).prevented).toBe(false);
  });

  it('still dispatches for a target that is not a text field', () => {
    expect(press({ key: 'j' }, new FakeElement('CANVAS')).calls).toEqual([
      { kind: 'move', dir: Dir.S },
    ]);
  });
});

// ---------------------------------------------------------------------------
// v8: the two rows that moved
// ---------------------------------------------------------------------------

describe('v8 puts the character sheet on C and the Case Log on M', () => {
  it("c opens the character sheet — ToME's own default (uiset/Classic.lua:270)", () => {
    expect(press({ key: 'c' }).calls).toEqual([{ kind: 'ui', command: UiCommand.ShowSheet }]);
  });

  it('c no longer toggles the Case Log', () => {
    // The regression this move could introduce is silent in the other direction:
    // both are `onUi` calls, so a stale table would still "work".
    expect(press({ key: 'c' }).calls).not.toContainEqual({
      kind: 'ui',
      command: UiCommand.ToggleLog,
    });
  });

  it('m toggles the Case Log — conventional, NOT ported (see keys.ts)', () => {
    expect(press({ key: 'm' }).calls).toEqual([{ kind: 'ui', command: UiCommand.ToggleLog }]);
  });
});

// ---------------------------------------------------------------------------
// v9: the talent panel's key
// ---------------------------------------------------------------------------

describe('v9 puts the talent panel on G, and takes nothing away', () => {
  it('g opens the talent panel — CHOSEN, not ported (see keys.ts)', () => {
    // ToME's LEVELUP is a VIRTUAL action (class/Game.lua:2215) whose default
    // lives in /data/keybinds/*.lua (engine/KeyBind.lua:44-53), a directory
    // absent from the reference clone — `grep -rn defineAction reference/t-engine4`
    // finds only KeyBind.lua's own two lines and zero call sites. There is no
    // default to read, so this key is a choice and this file says so rather than
    // pinning a citation that does not exist.
    expect(press({ key: 'g' }).calls).toEqual([{ kind: 'ui', command: UiCommand.ShowTalents }]);
  });

  it('l is STILL Dir.E, which is why the talent panel could not have it', () => {
    // The only in-tree evidence for `l` is dialog-local (CharacterSheet.lua:99's
    // "[L]evelup" label and :289's `c == 'l'` branch), and it is moot regardless:
    // KEY_TO_DIR binds `l` east and `directionFor` is consulted FIRST, an order
    // keys.ts calls load-bearing. This is the assertion that would fail if
    // somebody "fixed" the mnemonic by taking the letter.
    expect(press({ key: 'l' }).calls).toEqual([{ kind: 'move', dir: Dir.E }]);
    expect(press({ key: 'l' }).calls).not.toContainEqual({
      kind: 'ui',
      command: UiCommand.ShowTalents,
    });
    // Shift cannot rescue it either: the handler lowercases and deliberately does
    // not exclude Shift, so a capital L is still a step east.
    expect(press({ key: 'L', shiftKey: true }).calls).toEqual([{ kind: 'move', dir: Dir.E }]);
  });

  it('g takes nothing from the sheet or the Case Log', () => {
    expect(press({ key: 'c' }).calls).toEqual([{ kind: 'ui', command: UiCommand.ShowSheet }]);
    expect(press({ key: 'm' }).calls).toEqual([{ kind: 'ui', command: UiCommand.ToggleLog }]);
  });
});

// ---------------------------------------------------------------------------
// Every pre-existing row
// ---------------------------------------------------------------------------

describe('every row that already worked still works', () => {
  const MOVES: readonly (readonly [KeyInit, Dir])[] = [
    [{ key: 'ArrowUp' }, Dir.N],
    [{ key: 'ArrowDown' }, Dir.S],
    [{ key: 'ArrowLeft' }, Dir.W],
    [{ key: 'ArrowRight' }, Dir.E],
    [{ key: 'k' }, Dir.N],
    [{ key: 'j' }, Dir.S],
    [{ key: 'h' }, Dir.W],
    [{ key: 'l' }, Dir.E],
    [{ key: 'y' }, Dir.NW],
    [{ key: 'u' }, Dir.NE],
    [{ key: 'b' }, Dir.SW],
    [{ key: 'n' }, Dir.SE],
    [{ key: '2', code: 'Numpad2' }, Dir.S],
    [{ key: '4', code: 'Numpad4' }, Dir.W],
    [{ key: '6', code: 'Numpad6' }, Dir.E],
  ];

  for (const [init, dir] of MOVES) {
    it(`${init.code ?? init.key} moves ${dir}`, () => {
      expect(press(init).calls).toEqual([{ kind: 'move', dir }]);
    });
  }

  const COMMANDS: readonly (readonly [KeyInit, TurnCommand])[] = [
    [{ key: ' ' }, TurnCommand.Commit],
    [{ key: 'Enter' }, TurnCommand.Commit],
    [{ key: 'Enter', code: 'NumpadEnter' }, TurnCommand.Commit],
    [{ key: '.' }, TurnCommand.Hold],
    // NumLock on reports '5' and off reports 'Clear'; neither is bindable, which
    // is why this row is keyed on the physical code.
    [{ key: '5', code: 'Numpad5' }, TurnCommand.Hold],
    [{ key: 'Clear', code: 'Numpad5' }, TurnCommand.Hold],
  ];

  for (const [init, command] of COMMANDS) {
    it(`${init.code ?? init.key} is ${command}`, () => {
      expect(press(init).calls).toEqual([{ kind: 'command', command }]);
    });
  }

  it('1-4 are the four hotbar slots, ZERO-BASED', () => {
    expect(press({ key: '1', code: 'Digit1' }).calls).toEqual([{ kind: 'slot', slot: 0 }]);
    expect(press({ key: '2', code: 'Digit2' }).calls).toEqual([{ kind: 'slot', slot: 1 }]);
    expect(press({ key: '3', code: 'Digit3' }).calls).toEqual([{ kind: 'slot', slot: 2 }]);
    expect(press({ key: '4', code: 'Digit4' }).calls).toEqual([{ kind: 'slot', slot: 3 }]);
  });

  /**
   * THE WHOLE UI TABLE, and it doubles as the completeness check below: every
   * `UiCommand` member has to appear in this list or the last test in this block
   * fails. That is the enforcement of the directive's own rule that a key which
   * opens nothing is worse than an unbound key — read in the other direction, a
   * verb with no key is a screen nobody can reach.
   */
  const UI_ROWS: readonly (readonly [string, UiCommand])[] = [
    ['r', UiCommand.Revive],
    ['f', UiCommand.Respawn],
    ['t', UiCommand.Say],
    ['/', UiCommand.Say],
    ['c', UiCommand.ShowSheet],
    ['g', UiCommand.ShowTalents],
    ['m', UiCommand.ToggleLog],
    ['p', UiCommand.ToggleParty],
  ];

  for (const [key, command] of UI_ROWS) {
    it(`${key} is ${command}`, () => {
      expect(press({ key }).calls).toEqual([{ kind: 'ui', command }]);
    });
  }

  it('Page Up and Page Down scroll, and SHIFT picks the other lane', () => {
    // +1 is BACK IN TIME, matching every document ever written.
    expect(press({ key: 'PageUp' }).calls).toEqual([
      { kind: 'scroll', steps: 1, alternate: false },
    ]);
    expect(press({ key: 'PageDown' }).calls).toEqual([
      { kind: 'scroll', steps: -1, alternate: false },
    ]);
    expect(press({ key: 'PageUp', shiftKey: true }).calls).toEqual([
      { kind: 'scroll', steps: 1, alternate: true },
    ]);
    expect(press({ key: 'PageDown', shiftKey: true }).calls).toEqual([
      { kind: 'scroll', steps: -1, alternate: true },
    ]);
  });

  it('Escape cancels, and never becomes anything else', () => {
    expect(press({ key: 'Escape' }).calls).toEqual([{ kind: 'cancel' }]);
  });

  it('binds a key for every UiCommand member, so an eighth verb is considered here', () => {
    expect(new Set(UI_ROWS.map(([, command]) => command))).toEqual(
      new Set(Object.values(UiCommand)),
    );
  });
});

// ---------------------------------------------------------------------------
// The two properties main.ts depends on
// ---------------------------------------------------------------------------

describe('what the keymap deliberately does NOT do', () => {
  it('names exactly seven UI verbs', () => {
    // An eighth member has to be added here on purpose, which is the point: the
    // exhaustive switch in main.ts breaks at lint time, and this breaks at test
    // time with the list of what the game claims to have. v9 added
    // `show_talents` and that is the whole of the change to this list.
    expect(Object.values(UiCommand).slice().sort()).toEqual([
      'respawn',
      'revive',
      'say',
      'show_sheet',
      'show_talents',
      'toggle_log',
      'toggle_party',
    ]);
  });

  it('lets an unmapped key sail past untouched', () => {
    // main.ts's travel-cancel listener depends on this: it runs BESIDE
    // bindGameKeys on the same event because a rule phrased as "any keyboard
    // input cancels the walk" is unreachable through a keymap that drops
    // everything it has no meaning for.
    const { calls, prevented } = press({ key: 'q' });
    expect(calls).toEqual([]);
    expect(prevented).toBe(false);
  });

  it('stops listening once disposed', () => {
    const calls: Call[] = [];
    const target = new EventTarget();
    bindGameKeys(target, recorder(calls)).dispose();
    target.dispatchEvent(new FakeKeyboardEvent({ key: 'j' }));
    expect(calls).toEqual([]);
  });
});
