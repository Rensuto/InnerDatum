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
 */

import { Dir } from '../../shared/coords.ts';

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

/**
 * Layout-independent by nature — space, enter, full stop and comma are where
 * they are, and none of them is a letter whose position moves with the layout.
 * That is why the punctuation lives here and the mnemonics live in KEY_TO_UI.
 */
const KEY_TO_COMMAND: ReadonlyMap<string, TurnCommand> = new Map([
  [' ', TurnCommand.Commit],
  ['enter', TurnCommand.Commit],
  ['.', TurnCommand.Hold],
  // ═══ v10 — `,` PICKS UP. CONVENTIONAL, NOT PORTED, AND IT SAYS SO ═══
  // ToME's own mnemonic for this act is `g`: `PICKUP_FLOOR` is a real virtual
  // action (modules/tome/class/Game.lua:2169-2172, calling `playerPickup`) and
  // the letter G is the roguelike tradition it comes from. `g` IS ALREADY OURS
  // FOR THE TALENT PANEL (see KEY_TO_UI below), and moving it would break a
  // binding players have been using since v9 to spend a point.
  //
  // So `,` — the other roguelike convention for picking a thing up, and free.
  // There is no citation for it and none is offered; the shipped ToME default
  // for any action is not recoverable from this reference clone at all (the
  // paragraph on `g` below sets out why, with the grep that proves it).
  //
  // ONE HONEST COLLISION, STATED RATHER THAN DISCOVERED: on the layouts where
  // the numpad's decimal key reports `,` instead of `.` — German and French
  // among them — that key now picks up rather than doing nothing, which is what
  // it did before. The numpad's own hold is Numpad5 and is matched on
  // `event.code`, so it is untouched either way.
  [',', TurnCommand.Pickup],
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
  // v9 — THE TALENT PANEL. THE KEY IS CHOSEN, NOT PORTED, and this entry says so
  // in the same words the Case Log's does above rather than dressing a guess as
  // a citation.
  //
  // ═══ THERE IS NO ToME DEFAULT TO READ, AND THAT IS A FACT ABOUT THE CLONE ═══
  // ToME's levelup screen is opened by a VIRTUAL action — `LEVELUP = function()
  // ... playerLevelup(...)` at class/Game.lua:2215 — and the default key for
  // every action lives in /data/keybinds/*.lua, loaded by name at
  // engine/KeyBind.lua:44-53. That directory is not in the reference clone:
  // `grep -rn defineAction reference/t-engine4` returns exactly two hits, both
  // inside engine/KeyBind.lua's own definition of the function (:33 and the
  // closure at :53 that forwards to it), and zero call sites. So the shipped
  // binding is unrecoverable from this tree and must not be quoted as ported.
  //
  // ═══ AND `l` IS UNAVAILABLE ANYWAY ═══
  // The only in-tree evidence for a letter is DIALOG-LOCAL: dialogs/
  // CharacterSheet.lua:99 labels a button "[L]evelup" and :289's `c == 'l'`
  // branch triggers the virtual action — both inside that one dialog's own key
  // handler, not a keybind default. It is moot regardless: keys.ts:198 binds `l`
  // to Dir.E and `directionFor` is consulted FIRST in the dispatch (:371-373),
  // an order this file calls load-bearing. Shift cannot rescue it either — the
  // handler lowercases everything and deliberately does not exclude Shift, so
  // `L` is `l`.
  //
  // `g` IS CHOSEN ON THAT BASIS. It is one of the letters vi movement left free
  // (h/j/k/l and y/u/b/n are spoken for and always will be) and the full taken
  // set is arrows, those eight, '.', enter, r, f, t, /, c, m, p, 1-4, escape and
  // the two page keys. The day data/keybinds is fetched, this line either earns
  // a citation or gets corrected.
  ['g', UiCommand.ShowTalents],
  // ═══ v10 — THE INVENTORY, ON ToME'S OWN LETTER. A DIALOG-LOCAL MNEMONIC ═══
  //
  // WHAT IS BEING CITED, AND WHAT IS NOT. `SHOW_INVENTORY` is a real virtual
  // action (modules/tome/class/Game.lua:2177-2191) and `SHOW_EQUIPMENT` is
  // literally an alias of it at :2192 — so one key opening one combined screen
  // IS the upstream behaviour, and a second key for equipment would be an
  // invention. But the DEFAULT KEY for any action lives in
  // /data/keybinds/<name>.lua, loaded by name at engine/KeyBind.lua:44-53, and
  // THAT DIRECTORY IS NOT IN THIS REFERENCE CLONE: `find reference/t-engine4
  // -type d -name keybinds` returns nothing, and `grep -rn defineAction` returns
  // exactly two hits — engine/KeyBind.lua:33, where the function is defined, and
  // the closure at :53 that forwards to it — with zero call sites. There is no
  // shipped default in this tree to read, and this line must not be quoted as
  // one. It is the identical fact the M, G and C entries above already record.
  //
  // WHAT DOES EXIST IS DIALOG-LOCAL EVIDENCE OF EXACTLY THE CLASS THIS REPO HAS
  // ALREADY ACCEPTED: dialogs/CharacterSheet.lua:95-98 is
  // `Button.new{text="Manage [I]nventory", fct=function() self:showInventory() end}`
  // and :287-288 is `elseif (c == 'i' or c == 'I') then self:showInventory()`.
  // That is the same evidentiary class as :99's `Button.new{text="[L]evelup"}`
  // plus :289-290, which src/client/ui/charsheet.ts:215-225 already cites as the
  // reason our `[G]` control exists. A BUTTON LABEL IS AN INFERENCE, NOT A
  // BINDING, and this comment is the whole of the argument for it.
  //
  // AND DO NOT READ `e` AS A SECOND KEY: CharacterSheet.lua:285-286's
  // `c == 'e'` selects a TAB inside that dialog (`self.c_equipment:select()`),
  // sitting beside the `g`/`a`/`d`/`t` tab selectors. It opens nothing.
  //
  // `i` IS FREE. The complete taken set is the arrows, k/j/h/l, y/u/b/n,
  // Numpad1-9, Numpad5, NumpadEnter, space, enter, '.', ',', 1-4, r, f, t, /, c,
  // m, p, g, pageup, pagedown and escape. Note that the handler lowercases
  // without excluding Shift, so `I` resolves to `i` — which matches ToME, whose
  // own branch is `c == 'i' or c == 'I'`.
  ['i', UiCommand.ShowInventory],
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
