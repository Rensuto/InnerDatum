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
 *   - 1-4 fire the four talents of the loadout. FOUR BECAUSE A CLASS HAS FOUR —
 *     `ClassDef.loadout` is exactly four talents and the arity is enforced at
 *     import time (src/server/content/classes.ts) — so the digit IS the talent
 *     and there is nothing to rebind. (This used to say "no trees and no talent
 *     points"; v9 brought BOTH, and neither changed this line. A talent point
 *     raises a talent's RANK, never the number of them, so the four digits mean
 *     what they always did and the panel that spends the points is on `g`.)
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
 * v9 ADDS ONE KEY, AND IT IS A CHOICE RATHER THAN A PORT:
 *   - G OPENS THE TALENT PANEL, where a levelled detective spends a point. ToME
 *     binds its levelup screen to a VIRTUAL action (Game.lua:2215) whose default
 *     lives in /data/keybinds/*.lua, a directory absent from the reference clone
 *     — the same missing-defaults problem M's entry above sets out, with the same
 *     conclusion. See the comment on the row itself for why `l` is unavailable
 *     even though CharacterSheet.lua prints "[L]evelup".
 *
 * v10 ADDS TWO KEYS, AND THEY ARE OF DIFFERENT KINDS:
 *   - I OPENS THE INVENTORY, and it is the nearest thing to a port any key in
 *     this file has short of C. `SHOW_INVENTORY` is a real virtual action and
 *     `SHOW_EQUIPMENT` is literally an alias of it (class/Game.lua:2192), so ONE
 *     key opening ONE combined screen is the upstream behaviour rather than a
 *     simplification. The LETTER comes from a button label and a dialog-local
 *     handler ("Manage [I]nventory", CharacterSheet.lua:95-98 and :287-288) and
 *     not from a bindings table, because there is no bindings table in this
 *     clone — see the row itself, which sets that out with the grep that proves
 *     it.
 *   - `,` PICKS UP THE THING YOU ARE STANDING ON, and it is CONVENTIONAL rather
 *     than ported: ToME's own mnemonic is G (PICKUP_FLOOR, Game.lua:2169) and G
 *     has been the talent panel since v9. It sits with space, enter and '.' in
 *     KEY_TO_COMMAND because it SPENDS A TURN and because punctuation does not
 *     move with the keyboard layout.
 *
 * THE LETTERS ARE THE ONES vi MOVEMENT LEFT FREE. h/j/k/l and y/u/b/n are spoken
 * for and always will be; r, f, t, c, m, p, g and i are not, and picking anything
 * shifted would collide with the capitals a shift-holding player still means as
 * moves.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * v11: THE SEVEN TABLES HAVE MOVED, AND THIS FILE NO LONGER OWNS ANY KEY
 * ═══════════════════════════════════════════════════════════════════════════
 * Every paragraph above still describes the DEFAULTS, and every one of those
 * arguments — the citation for `c`, the grep that proves `g` is a choice, the
 * reason `l` could never be the levelup key — has moved VERBATIM onto the action
 * row it justifies in `src/client/input/keymap.ts`. What is left here is the
 * dispatch: the eight-step order, the modifier policy and the text-entry guard.
 *
 * WHAT THIS FILE READS IS NOW A LIVE OBJECT, DEREFERENCED PER PRESS. A rebind
 * arrives long after boot — `bindGameKeys` runs on main.ts's boot path, before
 * any frame carrying persisted preferences can have been received — so the only
 * mechanism that can work at all is mutating the object this handler already
 * holds. NOT dispose-and-rebind: the disposer's own docblock below sets out, at
 * length, why re-registering inverts a listener order two files independently
 * call load-bearing.
 *
 * THE ACTION NAMES BELOW DID NOT CHANGE, and that is the whole point of having
 * named actions rather than keys since M2: `UiCommand.ToggleLog` is still
 * `ToggleLog` whether it is on `m`, on `c` or on whatever its owner rebound it
 * to this evening. Nothing downstream of this file knows which key anything is
 * on, and after v11 nothing downstream may assume it.
 */

import { compileKeymap, ACTIONS, type Keymap, type KeyRemap } from './keymap.ts';

import type { Dir } from '../../shared/coords.ts';

/** Called with the direction the player asked to move in. */
export type MoveIntent = (dir: Dir) => void;

/**
 * The verbs that SPEND A TURN, as the client speaks them. They map one-to-one
 * onto the `commit`, `hold` and `pickup` frames in protocol.ts; the indirection
 * exists so that the key table names an ACTION rather than a wire tag, and a
 * rebinding UI (M5) never has to know what a frame looks like.
 *
 * TWO OF THE THREE ARE THE WARRANT CLOCK'S and the third joined them at v10.
 * `Pickup` belongs here rather than beside the panel toggles in `UiCommand`
 * because of what it COSTS: it is an intent the server rules on, it pumps the
 * scheduler, and pressing it out of turn earns exactly the same `not_your_turn`
 * refusal `commit` does. Nothing in `UiCommand` moves the world's clock —
 * `Revive` and `Respawn` are server verbs too, but they are answers to a body on
 * the floor rather than ordinary turns, and they live on letters for the reason
 * the table below gives.
 */
export const TurnCommand = {
  Commit: 'commit',
  Hold: 'hold',
  /**
   * Take the top thing off the tile you are standing on (v10).
   *
   * IT CARRIES NO COORDINATE, HERE OR ON THE WIRE. The server reads the sender's
   * own live x/y and takes index 0 of that tile (`GroundMsg` in
   * shared/protocol.ts, and src/server/world/world.ts:516-522's "PICKUP TAKES
   * INDEX 0"), which is strictly stronger than range-checking a tile a client
   * supplied: there is no coordinate to forge. So this key means "here", always,
   * and the right-click row on a distant pile is greyed rather than enabled.
   */
  Pickup: 'pickup',
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
  /**
   * Open — or put away — the talent panel (v9).
   *
   * ONE KEY THAT TOGGLES, for exactly the reason `ShowSheet` above gives and
   * with exactly the same consequence: the panel is a dock PANEL rather than a
   * modal, main.ts's cancel chain backs out of one thing per press and no dock
   * surface is in it, so the key that opened this one is the key that has to put
   * it away. The × on its header is the mouse's copy of the same act.
   */
  ShowTalents: 'show_talents',
  /**
   * Open — or put away — the inventory panel (v10).
   *
   * ONE KEY THAT TOGGLES, for exactly the reason `ShowSheet` and `ShowTalents`
   * above give and with exactly the same consequence: the panel is a dock PANEL
   * rather than a modal, main.ts's cancel chain backs out of one thing per press
   * and no dock surface is in it, so the key that opened this one is the key that
   * has to put it away. The × on its header is the mouse's copy of the same act.
   *
   * ONE MEMBER FOR BOTH HALVES OF THE SCREEN, AND THAT IS THE PORT rather than a
   * saving: `SHOW_EQUIPMENT = "SHOW_INVENTORY"` (modules/tome/class/Game.lua:2192)
   * is an ALIAS, and both actions open the same combined `ShowEquipInven` dialog.
   * A second member for equipment would be a deviation wearing a port's clothes.
   */
  ShowInventory: 'show_inventory',
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE KEYMAP: ONE BOX, MUTATED IN PLACE, DEREFERENCED ON EVERY PRESS
 * ═══════════════════════════════════════════════════════════════════════════
 * A box rather than the compiled object itself, because the compiled object is
 * frozen-by-convention: `setKeymap` REPLACES `current` and the already-registered
 * handler picks the new tables up on the very next keydown, with no listener
 * touched and no ordering disturbed.
 *
 * THIS IS THE ONLY MECHANISM THAT CAN WORK, and the reason is timing rather
 * than taste. `bindGameKeys(window, {...})` runs on main.ts's boot path, before
 * the socket has said hello and therefore before any frame carrying a player's
 * persisted keymap can have arrived. Whatever tables the handler closed over at
 * registration would be the tables it used for the rest of the session.
 *
 * AND DISPOSE-AND-REBIND IS FORBIDDEN OUTRIGHT — see the disposer's docblock
 * below, which explains that re-registering this handler moves it AFTER
 * main.ts's travel-cancel listener and inverts an Escape precedence two files
 * independently call load-bearing.
 */
export type LiveKeymap = {
  current: Keymap;
};

/**
 * The one the game uses. `bindGameKeys` takes it by default so main.ts's call
 * site did not have to learn about any of this, and W5's `keybinds` frame
 * handler hands its map straight to `setKeymap`.
 */
export const gameKeymap: LiveKeymap = { current: compileKeymap(ACTIONS, {}) };

/**
 * Adopt a player's overlay. `{}` is RESET ALL and is a real value, not a
 * missing field.
 *
 * The compile happens HERE — once per frame that changes the keys — rather than
 * on any keypress. An unknown action id in `remap` is ignored rather than
 * thrown: the compile walks `ACTIONS`, so an id this build no longer binds
 * simply never matches anything. THE CLIENT OWNS THAT DROP, exactly as
 * `createTalentSheet` drops a talent id the class no longer has; persist and the
 * wire both keep it verbatim so a renamed-then-restored action comes back.
 */
export function setKeymap(remap: KeyRemap, live: LiveKeymap = gameKeymap): void {
  live.current = compileKeymap(ACTIONS, remap);
}

/** A private keymap, for a test or a preview that must not touch the game's. */
export function createLiveKeymap(remap: KeyRemap = {}): LiveKeymap {
  return { current: compileKeymap(ACTIONS, remap) };
}

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

/**
 * `code` FIRST, THEN LOWERCASED `key`, and the order inside this one line is as
 * load-bearing as the order of the eight steps below: the numpad is the only
 * thing in the `code` namespace and it has to claim its own keys before the
 * digits NumLock reports them as are read as anything else.
 *
 * ToME matches its two key-string forms in exactly this shape — `sym:` first,
 * then the layout `sym:=` form (KeyBind.lua:227-244).
 */
function directionFor(event: KeyboardEvent, keymap: Keymap): Dir | undefined {
  return keymap.dirByCode.get(event.code) ?? keymap.dirByKey.get(event.key.toLowerCase());
}

function commandFor(event: KeyboardEvent, keymap: Keymap): TurnCommand | undefined {
  return keymap.commandByCode.get(event.code) ?? keymap.commandByKey.get(event.key.toLowerCase());
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
 *
 * ═══ `live` IS READ ON EVERY PRESS, WHICH IS WHAT MAKES REBINDING POSSIBLE ═══
 * It defaults to the module's own `gameKeymap` so main.ts's boot-path call did
 * not change; `setKeymap` swaps the compiled tables inside it and the very next
 * keydown uses them. A test that wants isolation passes its own box.
 */
export function bindGameKeys(
  target: EventTarget,
  handlers: KeyHandlers,
  live: LiveKeymap = gameKeymap,
): KeyBinding {
  const handler = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (hasCommandModifier(event) || isTextEntry(event.target)) return;

    // DEREFERENCED HERE, ONCE PER PRESS AND NOT ONCE PER REGISTRATION. Reading it
    // into a local also means a `setKeymap` that lands mid-dispatch cannot make
    // one press consult two different keymaps.
    const keymap = live.current;

    // FIRST, and it must stay first: this is the lookup that reads `event.code`,
    // so it claims Numpad1/3/7/9 as diagonals before `slotByKey` can see them as
    // the digits NumLock reports them to be.
    const dir = directionFor(event, keymap);
    if (dir !== undefined) {
      // Only for keys we actually consumed. The arrows are the reason this call
      // exists: unprevented, they scroll the activity iframe, and the canvas
      // drifts out of view while the player wonders why walking north moves the
      // whole page. Space is the other one — it scrolls too.
      event.preventDefault();
      handlers.onMove(dir);
      return;
    }

    // LOWERCASED, WHERE IT USED TO READ `event.key` RAW. Harmless for the four
    // digits this table has held since M3 — a digit has no case — but the table
    // is rebindable now, and it was the ONE key-side lookup in this file that did
    // not lower. A capture field reporting 'H' would have bound a hotbar slot to
    // a key no press could ever match.
    const slot = keymap.slotByKey.get(event.key.toLowerCase());
    if (slot !== undefined) {
      event.preventDefault();
      handlers.onSlot(slot);
      return;
    }

    if (keymap.cancelKeys.has(event.key.toLowerCase())) {
      event.preventDefault();
      handlers.onCancel();
      return;
    }

    const lower = event.key.toLowerCase();

    // AFTER the slot digits and BEFORE the turn verbs. After the digits because
    // nothing here is a digit and the order is only load-bearing for the numpad;
    // before the verbs because `commandFor` reads `event.code` and must not get
    // the chance to claim a letter under some exotic layout.
    const scroll = keymap.scrollByKey.get(lower);
    if (scroll !== undefined) {
      // Page Up scrolls the activity iframe if it is not swallowed, which drags
      // the canvas out of view — the same failure the arrow keys have.
      event.preventDefault();
      handlers.onScroll(scroll, event.shiftKey);
      return;
    }

    const ui = keymap.uiByKey.get(lower);
    if (ui !== undefined) {
      event.preventDefault();
      handlers.onUi(ui);
      return;
    }

    const command = commandFor(event, keymap);
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
