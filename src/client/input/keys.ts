/**
 * Keyboard input: a keydown becomes a direction or a turn verb, and either one
 * becomes an intent on the wire.
 *
 * THREE KEY SETS FOR MOVEMENT, because a roguelike that only reads the arrow
 * keys will be described as broken by every player who has touched one before:
 *   - arrows, for everyone else;
 *   - vi keys hjkl + the diagonals yubn, which is the roguelike standard;
 *   - the numpad, which is what the diagonals were invented to replace.
 *
 * TWO TURN VERBS, added in M2 with the Warrant Clock:
 *   - SPACE or ENTER commits — "I have finished deciding, resolve my turn".
 *     Space because it is the largest key on the board and this is the most
 *     pressed key in the game; Enter because half the table will try it first.
 *   - '.' or NUMPAD-5 holds — pass, brace, do nothing. Both are the roguelike
 *     idiom for "wait" and have been since Rogue; numpad-5 is the middle of the
 *     movement ring, which is exactly what "stay put" means with a numpad.
 *
 * M3 ADDS THE HOTBAR AND ONE MODE KEY:
 *   - 1-4 fire the four talents of a FIXED loadout. Four because PLAN.md caps
 *     the MVP at four talents per class with no trees and no talent points, so
 *     the digit IS the talent and there is nothing to rebind.
 *   - ESCAPE cancels. It is the one key in the game that means "put that back",
 *     and it must never reach the server: cancelling a targeting mode is a
 *     decision about a UI that only this browser knows exists.
 *
 * THIS FILE DECIDES NOTHING. It does not check whether the destination tile is
 * walkable, does not know whose turn it is, and does not gate a commit on being
 * parked: it emits intents and the server rules on them. That is not laziness —
 * a client that pre-filters has a second copy of the rules, and the moment the
 * two disagree the player sees an action that "worked" and then snapped back.
 * Pressing space out of turn costs one `error` frame with code `not_your_turn`,
 * which is the correct price for keeping one authority.
 *
 * IT ALSO DOES NOT KNOW ABOUT MODES, and that is why targeting did not change
 * this file's shape. While a talent is being aimed, an arrow key moves the
 * CURSOR and Enter CONFIRMS instead of committing the turn — but the key still
 * reports itself as `onMove(Dir.N)` and `TurnCommand.Commit`, and main.ts routes
 * it. Naming the KEY here and its MEANING there is what keeps one keymap for two
 * modes; a `targeting: boolean` parameter on `bindGameKeys` would put half the
 * mode's logic in the input layer and the other half in the caller.
 *
 * KEY REPEAT IS FORWARDED. Holding a direction to walk down a corridor is the
 * expected feel, and every repeat is a genuine intent. Rate limiting lives on
 * the server, where it can see all the sockets, and the barrier makes the
 * question mostly moot: in combat, extra actions have no energy to spend.
 *
 * M4 ADDS FIVE KEYS, AND ONE OF THEM IS THE POINT OF THE MILESTONE:
 *   - R revives the Downed ally beside you. game-design.md § 9 is explicit that
 *     this mechanic *"turns 'I died' into 'GET TO ME'"*, and a rescue that costs
 *     two keystrokes in a five-turn window is a rescue people fumble. One key,
 *     and main.ts resolves which neighbour it meant.
 *   - T and / open the command line, which is a real `<input>` in the DOM rather
 *     than something drawn on the canvas — it gets the IME, the clipboard, the
 *     caret and screen-reader support for free, and `isTextEntry` below has
 *     guarded against exactly this element since M2 (the comment there predicted
 *     it: "typing 'j' in the chat box walks your character south").
 *   - M toggles the Case Log and P the party panel. Both are dock surfaces that
 *     overlay the map; on a small window somebody will want the tiles back. (M4
 *     put the log on C. v8 took C for the character sheet and moved it — see the
 *     paragraph below, which says which of those two keys is a port and which is
 *     a choice.)
 *   - PAGE UP / PAGE DOWN scroll the log, with SHIFT choosing the other lane.
 *
 * AND ONE MORE, ADDED AFTER REAL PLAY STRANDED SOMEBODY:
 *   - F refiles YOU. Once the five turns have run out there is nothing an ally
 *     can do — `revive` refuses an erased body by design — and until now there
 *     was no key at all for the player sitting inside that state. It is refused
 *     server-side in every stage but Erased, so it cannot be used to skip the
 *     countdown that makes a rescue matter.
 *
 * v8 ADDS ONE KEY AND MOVES ONE, AND THE TWO ARE THE SAME EVENT:
 *   - C OPENS THE CHARACTER SHEET, AND IT IS A PORT. ToME's Classic HUD asks the
 *     keybinding layer which key is bound to SHOW_CHARACTER_SHEET and prints the
 *     mnemonic "#GOLD#C#LAST#haracter Sheet" only `if (key == "C")` — a branch
 *     that is only meaningful for the shipped default (uiset/Classic.lua:270),
 *     corroborated independently by the button text at
 *     dialogs/debug/RandomObject.lua:417. That is the single ToME default with
 *     hard in-source evidence which lands on a screen this game now has, so it
 *     wins the letter and the Case Log moves.
 *   - THE CASE LOG'S NEW KEY, M, IS A CHOICE AND NOT A PORT, and this file says
 *     so rather than dressing it up. ToME does have a SHOW_MESSAGE_LOG action and
 *     this same HUD triggers it (uiset/Classic.lua:238, with the tooltip branch
 *     that would print its key at :281) — but the DEFAULT KEY for every action
 *     lives in /data/keybinds/*.lua, and that directory was never fetched into
 *     the reference clone: `grep -rn defineAction reference/t-engine4` returns
 *     exactly two hits, both inside engine/KeyBind.lua's own definition of the
 *     function, and zero call sites. There is nothing in the tree to read. M is
 *     the conventional roguelike message key and it is chosen on that basis. The
 *     day data/keybinds is fetched, this line either earns a citation or gets
 *     corrected; until then it must not be quoted as ported.
 *   The member name did not change — `ToggleLog` is still `ToggleLog`. Only its
 *   row moved, which is the whole point of naming actions rather than keys.
 *
 * THE LETTERS ARE THE ONES vi MOVEMENT LEFT FREE. h/j/k/l and y/u/b/n are spoken
 * for and always will be; r, f, t, c, m and p are not, and picking anything
 * shifted would collide with the capitals a shift-holding player still means as
 * moves.
 */

import { Dir } from '../../shared/coords.ts';

/** Called with the direction the player asked to move in. */
export type MoveIntent = (dir: Dir) => void;

/**
 * The two Warrant Clock verbs, as the client speaks them. They map one-to-one
 * onto the `commit` and `hold` frames in protocol.ts; the indirection exists so
 * that the key table names an ACTION rather than a wire tag, and a rebinding UI
 * (M5) never has to know what a frame looks like.
 */
export const TurnCommand = {
  Commit: 'commit',
  Hold: 'hold',
} as const;
export type TurnCommand = (typeof TurnCommand)[keyof typeof TurnCommand];

/**
 * The M4 verbs that are not a direction, a slot or a turn verb.
 *
 * A closed union rather than four more handler fields, so `KeyHandlers` does not
 * grow a member per key and `main.ts` gets one exhaustive switch that breaks at
 * lint time when a fifth lands — the same shape `TurnCommand` already has, for
 * the same reason.
 *
 * NAMED FOR THE ACTION, NOT THE KEY. A rebinding screen (M5) changes the tables
 * below and nothing else; nothing downstream of this file knows that revive is
 * on R.
 */
export const UiCommand = {
  /** Open the command line. `say` is typed, never bound to a key of its own. */
  Say: 'say',
  /** Stand up the Downed ally beside you. main.ts works out which one. */
  Revive: 'revive',
  /**
   * Stand YOURSELF up, once the countdown has run out. The way out of Erased.
   *
   * A SEPARATE VERB FROM `Revive`, not a smart R. The two are opposites — one
   * spends your turn on somebody else, the other is the last thing a player who
   * has run out of options can do for themselves — and a key that quietly means
   * whichever the game thinks you wanted is a key nobody can trust at the moment
   * they most need it. The server refuses it in every state but Erased, so the
   * only way to press it by accident is to already be erased.
   */
  Respawn: 'respawn',
  /**
   * Open — or put away — the character sheet (v8).
   *
   * ONE KEY THAT TOGGLES, not an open-here/close-there pair, and that follows
   * from the sheet being a dock PANEL rather than a modal. main.ts's cancel chain
   * backs out of exactly one thing per press and neither the Case Log nor the
   * party pane is in it, so the sheet is not either — which leaves the key that
   * opened it as the key that has to put it away. The close button on the panel
   * is the mouse's copy of the same act.
   */
  ShowSheet: 'show_sheet',
  ToggleLog: 'toggle_log',
  ToggleParty: 'toggle_party',
} as const;
export type UiCommand = (typeof UiCommand)[keyof typeof UiCommand];

export type KeyHandlers = {
  readonly onMove: MoveIntent;
  readonly onCommand: (command: TurnCommand) => void;
  /** A hotbar key. `slot` is ZERO-BASED — key 1 is slot 0, matching `loadout`. */
  readonly onSlot: (slot: number) => void;
  /** Escape. Always local: it never becomes a frame. */
  readonly onCancel: () => void;
  /** M4. One of the four verbs above; the caller decides what each means. */
  readonly onUi: (command: UiCommand) => void;
  /**
   * Page Up / Page Down over the Case Log.
   *
   * `steps` is +1 for BACK IN TIME and -1 for forward; `alternate` is Shift, and
   * this file deliberately does not know that it selects the Margin lane. Which
   * lane a modifier picks is a fact about a panel, and panels are main.ts's.
   */
  readonly onScroll: (steps: number, alternate: boolean) => void;
};

export type KeyBinding = {
  readonly dispose: () => void;
};

/**
 * Matched on `event.key`, lowercased. `key` rather than `code` so the binding
 * follows the player's keyboard layout: on AZERTY the physical KeyH is not
 * where an H is printed, and the vi keys are muscle memory about letters.
 */
const KEY_TO_DIR: ReadonlyMap<string, Dir> = new Map([
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
]);

/**
 * The numpad is matched on `event.code` instead, and it has to be: with NumLock
 * on, `event.key` for Numpad8 is the string '8', indistinguishable from the
 * number row; with NumLock off it is 'ArrowUp'. The physical key is the only
 * stable identity here.
 */
const CODE_TO_DIR: ReadonlyMap<string, Dir> = new Map([
  ['Numpad8', Dir.N],
  ['Numpad2', Dir.S],
  ['Numpad4', Dir.W],
  ['Numpad6', Dir.E],
  ['Numpad7', Dir.NW],
  ['Numpad9', Dir.NE],
  ['Numpad1', Dir.SW],
  ['Numpad3', Dir.SE],
]);

/**
 * Numpad-5 is the reason this table is keyed on `code`: NumLock on reports the
 * key as '5' and NumLock off reports 'Clear', and neither is something to bind.
 * NumpadEnter is here so the numpad hand can commit without leaving the pad.
 */
const CODE_TO_COMMAND: ReadonlyMap<string, TurnCommand> = new Map([
  ['Numpad5', TurnCommand.Hold],
  ['NumpadEnter', TurnCommand.Commit],
]);

/** Layout-independent by nature — space, enter and full stop are where they are. */
const KEY_TO_COMMAND: ReadonlyMap<string, TurnCommand> = new Map([
  [' ', TurnCommand.Commit],
  ['enter', TurnCommand.Commit],
  ['.', TurnCommand.Hold],
]);

/**
 * The hotbar digits, matched on `event.key`.
 *
 * KEY AND NOT CODE, so that a French AZERTY player — where the number row is
 * shifted — still presses what is printed on the cap. The counterpart risk is
 * the numpad: with NumLock on, Numpad1 reports `key === '1'` and would fire
 * slot 1 instead of stepping south-west. That is why `directionFor` is consulted
 * FIRST in the handler below and why it checks `event.code`; the numpad claims
 * its four diagonal keys before this table is ever read. Reordering those two
 * lookups silently breaks numpad movement, which is why the order carries this
 * comment rather than a passing mention.
 */
const KEY_TO_SLOT: ReadonlyMap<string, number> = new Map([
  ['1', 0],
  ['2', 1],
  ['3', 2],
  ['4', 3],
]);

/**
 * The M4 verbs, on `event.key` for the same layout reason as the vi keys: these
 * are muscle memory about LETTERS, and on AZERTY the physical KeyR is not where
 * an R is printed.
 *
 * `/` is here beside `t` because it is the chat key in every MUD, every IRC
 * client and Discord itself, and half the table will reach for it first.
 */
const KEY_TO_UI: ReadonlyMap<string, UiCommand> = new Map([
  ['r', UiCommand.Revive],
  // F FOR REFILE — the game's own word for coming back (a body at 0 hp is
  // *Unfiled*, a body whose countdown ran out is *erased*). It is a letter vi
  // movement never claimed, it is nowhere near R, and it is the only key in the
  // game a player will look for while reading a prompt rather than from memory:
  // the HUD names it, and it only ever appears while they are Erased.
  ['f', UiCommand.Respawn],
  ['t', UiCommand.Say],
  ['/', UiCommand.Say],
  // v8 — THE CHARACTER SHEET, ON ToME'S OWN LETTER. PORTED, and the citation is
  // a mnemonic rather than a bindings table: uiset/Classic.lua:270 asks which key
  // is bound to SHOW_CHARACTER_SHEET and prints "#GOLD#C#LAST#haracter Sheet"
  // only `if (key == "C")`, a branch that is only meaningful for the shipped
  // default. Corroborated independently at dialogs/debug/RandomObject.lua:417,
  // whose button reads "Show #GOLD#C#LAST#haracter Sheet".
  ['c', UiCommand.ShowSheet],
  // ...AND THAT IS WHY THE CASE LOG IS HERE NOW. THE KEY IS CHOSEN, NOT PORTED.
  //
  // ═══ SAID PLAINLY, BECAUSE A GUESS DRESSED AS A CITATION IS WORSE THAN A GUESS ═══
  // ToME has a SHOW_MESSAGE_LOG action and this very HUD triggers it
  // (uiset/Classic.lua:238, and the tooltip branch at :281 that would print
  // whatever key it finds) — but the DEFAULT for every action lives in
  // /data/keybinds/*.lua, which is not in the reference clone:
  // `grep -rn defineAction reference/t-engine4` returns exactly two hits, both
  // inside engine/KeyBind.lua's own definition of the function, and zero call
  // sites. So there is no default to read, and M is the conventional roguelike
  // message key chosen in its place. The MEMBER did not change, only its row.
  ['m', UiCommand.ToggleLog],
  ['p', UiCommand.ToggleParty],
]);

/**
 * Log scrolling. `+1` is back in time, matching what Page Up does in every
 * document ever written.
 */
const KEY_TO_SCROLL: ReadonlyMap<string, number> = new Map([
  ['pageup', 1],
  ['pagedown', -1],
]);

/**
 * The universal "put that back" key. Never sent to the server: it cancels a
 * targeting mode, which is a thing that exists only in this browser.
 */
const CANCEL_KEY = 'escape';

/**
 * Shift is deliberately NOT excluded — a capslocked or shift-holding player
 * still means 'move west' by H. Ctrl/Alt/Meta are, because those are the
 * browser's and Discord's shortcut space (Ctrl+L is the address bar, Ctrl+W
 * closes the tab) and stealing them is how an activity gets uninstalled.
 */
function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}

/**
 * True while the player is typing somewhere real. There is no text input in M2,
 * but chat arrives in M5 and the alternative is discovering that typing 'j' in
 * the chat box walks your character south — or worse, that hitting space to put
 * a word break in a sentence ends your turn.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function directionFor(event: KeyboardEvent): Dir | undefined {
  return CODE_TO_DIR.get(event.code) ?? KEY_TO_DIR.get(event.key.toLowerCase());
}

function commandFor(event: KeyboardEvent): TurnCommand | undefined {
  return CODE_TO_COMMAND.get(event.code) ?? KEY_TO_COMMAND.get(event.key.toLowerCase());
}

/**
 * Bind the game keys on `target` (normally `window`).
 *
 * ═══ THE DISPOSER IS FOR TEARDOWN. IT IS NOT HOW A MODAL SUSPENDS INPUT ═══
 * This comment used to recommend exactly that, and following it breaks something
 * real. main.ts registers `bindGameKeys` BEFORE its travel-cancel listener and
 * documents that order as load-bearing: listeners on one target fire in
 * registration order, so Escape reaches the ordered cancel chain with the walk
 * STILL RUNNING and is consumed there. Dispose-then-rebind re-registers this
 * handler AFTER the travel listener and inverts precisely that — one press then
 * stops the walk and also cancels an aim, "one key doing two things, which is the
 * one thing that chain exists to prevent". The bug needs travel, targeting and a
 * modal alive in one session to reproduce, which is to say it would be found by a
 * player and not by a test.
 *
 * A MODAL THEREFORE GATES IN main.ts's OWN HANDLERS, with an early return at the
 * top of each. The v8 class chooser does that: every key still arrives here and
 * still means what this file says it means, and the caller decides that while the
 * chooser is up an arrow moves a card rather than a body. Which is the same
 * division of labour targeting mode has had since M3 — the key names the ACTION,
 * the caller owns the MODE.
 */
export function bindGameKeys(target: EventTarget, handlers: KeyHandlers): KeyBinding {
  const handler = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (hasCommandModifier(event) || isTextEntry(event.target)) return;

    // FIRST, and it must stay first: this is the lookup that reads `event.code`,
    // so it claims Numpad1/3/7/9 as diagonals before KEY_TO_SLOT can see them as
    // the digits NumLock reports them to be.
    const dir = directionFor(event);
    if (dir !== undefined) {
      // Only for keys we actually consumed. The arrows are the reason this call
      // exists: unprevented, they scroll the activity iframe, and the canvas
      // drifts out of view while the player wonders why walking north moves the
      // whole page. Space is the other one — it scrolls too.
      event.preventDefault();
      handlers.onMove(dir);
      return;
    }

    const slot = KEY_TO_SLOT.get(event.key);
    if (slot !== undefined) {
      event.preventDefault();
      handlers.onSlot(slot);
      return;
    }

    if (event.key.toLowerCase() === CANCEL_KEY) {
      event.preventDefault();
      handlers.onCancel();
      return;
    }

    const lower = event.key.toLowerCase();

    // AFTER the slot digits and BEFORE the turn verbs. After the digits because
    // nothing here is a digit and the order is only load-bearing for the numpad;
    // before the verbs because `commandFor` reads `event.code` and must not get
    // the chance to claim a letter under some exotic layout.
    const scroll = KEY_TO_SCROLL.get(lower);
    if (scroll !== undefined) {
      // Page Up scrolls the activity iframe if it is not swallowed, which drags
      // the canvas out of view — the same failure the arrow keys have.
      event.preventDefault();
      handlers.onScroll(scroll, event.shiftKey);
      return;
    }

    const ui = KEY_TO_UI.get(lower);
    if (ui !== undefined) {
      event.preventDefault();
      handlers.onUi(ui);
      return;
    }

    const command = commandFor(event);
    if (command === undefined) return;
    event.preventDefault();
    handlers.onCommand(command);
  };

  target.addEventListener('keydown', handler);
  return {
    dispose: () => {
      target.removeEventListener('keydown', handler);
    },
  };
}
