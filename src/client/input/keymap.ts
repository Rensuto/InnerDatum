/**
 * THE KEYMAP MODEL: an ACTION table, a sparse per-player overlay, and the seven
 * lookup tables `bindGameKeys` reads on every press.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS PORTED, AND FROM WHERE
 * ═══════════════════════════════════════════════════════════════════════════
 * The MODEL is `engines/default/engine/KeyBind.lua`:
 *   - an action record with `type`, `name`, `default`, `group` and a monotonic
 *     `order` handed out at definition time (KeyBind.lua:33-41, `_M.bind_order`);
 *   - a remap keyed by the VIRTUAL action rather than by the key
 *     (`binds_remap[virtual] = {key1, key2, key3}`, KeyBind.lua:78, :88-103);
 *   - defaults that the remap OVERLAYS rather than replaces at the table level
 *     (`_M.binds_remap[type] or t.default`, KeyBind.lua:114-116, :131);
 *   - a compile step that flattens actions into one key -> action lookup before
 *     any key is pressed (`bindKeys`, KeyBind.lua:127-136);
 *   - and a display layer that never shows the STORED form of a binding
 *     (`formatKeyString`, KeyBind.lua:158-212, whose first line is
 *     `if not ks then return "--" end` — the '--' this file's `labelFor` uses).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OUR DEFAULT KEYS ARE A DEVIATION WITH NOTHING TO CITE, AND THIS SAYS SO
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME's own default tables are NOT in `reference/t-engine4`. Only
 * `game/engines/default/engine/` is extracted; `/data/keybinds/*.lua` — the
 * directory `KeyBind:load` reads by name (KeyBind.lua:44-53) — is absent, even
 * though the SET NAMES appear at `engine/init.lua:153` and
 * `modules/tome/load.lua:114`. `grep -rn defineAction reference/t-engine4`
 * returns exactly two hits, both inside KeyBind.lua's own definition of the
 * function, and zero call sites.
 *
 * SO EVERY `defaults` ROW BELOW IS OURS. They are seeded VERBATIM from the
 * seven tables `src/client/input/keys.ts` has shipped since M2, and the
 * paragraph-length arguments for the individual letters have moved here with
 * them, unchanged, because this is now the file that decides them. The two
 * genuine ports among them (`c` for the character sheet, `i` for the inventory)
 * carry their citations on the row; everything else is labelled a CHOICE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE ADDITION ToME DOES NOT NEED: A BINDING IS A TAGGED PAIR
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME reads raw SDL syms. A browser gives us TWO identities for one press and
 * they disagree, so `keys.ts` has always kept five tables on lowercased
 * `event.key` and two on `event.code`, and argued both sides:
 *   - `key`, so a binding follows the player's LAYOUT — "on AZERTY the physical
 *     KeyH is not where an H is printed", and the vi keys are muscle memory
 *     about letters;
 *   - `code`, because the numpad has no stable `key` at all — with NumLock on,
 *     Numpad8 reports the string '8'; with it off it reports 'ArrowUp'.
 * A remap that flattened those into one namespace breaks numpad movement
 * invisibly on every laptop-tested build, so `Binding` carries the namespace
 * with it: `{ kind: 'key' | 'code', value }`, serialised as `key:h` /
 * `code:Numpad8`.
 *
 * ToME makes the identical distinction — `makeKeyString` returns BOTH a
 * `sym:<name>` form and a layout `sym:=<key>` form (KeyBind.lua:146-148) and
 * `receiveKey` matches them IN ORDER (:227-244). One tag instead of two return
 * values is the whole of the difference.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO DOM, NO TIMERS, NO RANDOMNESS
 * ═══════════════════════════════════════════════════════════════════════════
 * Nothing here touches `window`, `document` or a `KeyboardEvent`. The conflict
 * detector walks SYNTHETIC presses — plain `{ key, code }` records — which is
 * what lets the whole model be tested in node with no fakes at all, unlike
 * keys.ts (see the header of test/client/input/keys.test.ts).
 */

import { KEYBIND_KEYS_PER_ACTION } from '../../shared/protocol.ts';
import { Dir } from '../../shared/coords.ts';

// TYPE-ONLY, AND THAT IS LOAD-BEARING. keys.ts imports this module for VALUES
// (the compiled tables), so a value import back would be a runtime cycle and
// `ACTIONS` below — evaluated at module load — would read `TurnCommand` inside
// its temporal dead zone and throw on boot. `import type` is erased entirely,
// so the cycle exists only for the type checker, which does not mind.
import type { TurnCommand, UiCommand } from './keys.ts';

// ---------------------------------------------------------------------------
// A BINDING
// ---------------------------------------------------------------------------

/**
 * Which of the two identities of a keypress this binding names.
 *
 * `key` is `event.key`, lowercased — it follows the layout. `code` is
 * `event.code` — it is the physical key and survives NumLock.
 */
export type BindingKind = 'key' | 'code';

/** One key, in one of the two namespaces. `value` is already lowercased for `key`. */
export type Binding = {
  readonly kind: BindingKind;
  readonly value: string;
};

/**
 * THE TWO RESERVED KEY STRINGS, AND WHY THERE ARE TWO OF THEM.
 *
 * A remap entry is a POSITIONAL array on the wire (`binds: { move_north:
 * ['key:w', 'code:Numpad8'] }`), so writing slot 1 forces writing *something*
 * at index 0. There are two different somethings and collapsing them is the bug
 * this whole feature is most likely to ship:
 *
 *   'default' — NO OVERRIDE IN THIS SLOT. Read as "whatever the shipped default
 *     is", so a changed default still reaches this player. This is what keeps
 *     storage sparse per SLOT rather than merely per ACTION, which is more than
 *     ToME manages: `getBindTable` returns `binds_remap[type] or type.default`
 *     (KeyBind.lua:114-116), so upstream's first rebind shadows the WHOLE array.
 *
 *   'none' — DELIBERATELY EMPTY. The player pressed Backspace on this slot
 *     (KeyBinder.lua:95-97 does the same with a Lua nil, which its positional
 *     file format can express and JSON cannot). Falls back to nothing, and
 *     `labelFor` shows '--'.
 *
 * NEITHER CAN COLLIDE WITH A REAL KEY STRING: every real one is TAGGED and
 * therefore contains a colon. Both survive `parseKeybinds` untouched
 * (src/server/persist/saves.ts:1208 only requires a non-empty string within the
 * length cap), which is the property that lets them round-trip to disk.
 */
export const SLOT_DEFAULT = 'default';
/** See `SLOT_DEFAULT`. */
export const SLOT_NONE = 'none';

/** How many slots a player may write per action. Two, and the wire agrees. */
export const SLOTS_PER_ACTION = KEYBIND_KEYS_PER_ACTION;

/**
 * The player's overlay, exactly as it travels on the wire and sits on disk:
 * action id -> ordered key strings. SPARSE — only actions the player actually
 * touched appear, which is upstream's own shape (`saveRemap` writes only
 * remapped virtuals, KeyBind.lua:88-103).
 *
 * `Record<string, ...>` and NOT `Record<ActionId, ...>`, because this value
 * arrives from a FILE by way of a wire schema that deliberately does not know
 * the action table (src/shared/protocol.ts:2196-2204). An id this build no
 * longer binds is kept verbatim by every layer beneath, and THE CLIENT OWNS THE
 * DROP — `compileKeymap` iterates `ACTIONS`, so an unknown id is ignored rather
 * than thrown, exactly as `createTalentSheet` drops a talent the class lost.
 */
export type KeyRemap = Readonly<Record<string, readonly string[]>>;

/** `key:h` / `code:Numpad8`, the one canonical string form (KeyBind.lua:146-148). */
export function formatBinding(binding: Binding): string {
  return `${binding.kind}:${binding.value}`;
}

/**
 * Read a stored key string. `undefined` for anything unreadable — including
 * both reserved words, which are not bindings and are handled by `resolveSlot`.
 *
 * KEY-SIDE VALUES ARE LOWERCASED HERE AS WELL AS AT COMPILE TIME. A capture
 * field that reported 'H' would otherwise store a binding the dispatcher can
 * never match, because every key-side lookup in keys.ts lowercases first.
 */
export function parseBinding(text: string): Binding | undefined {
  if (text.startsWith('key:')) {
    const value = text.slice(4).toLowerCase();
    return value === '' ? undefined : { kind: 'key', value };
  }
  if (text.startsWith('code:')) {
    const value = text.slice(5);
    return value === '' ? undefined : { kind: 'code', value };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// THE ACTION REGISTRY
// ---------------------------------------------------------------------------

/**
 * The sections of the Keys screen, in the order they are drawn.
 *
 * ToME sorts by `group` and then by `order` (KeyBinder.lua:196-202) and builds
 * one tree node per group (:227-236) — but it sorts the GROUPS alphabetically
 * (`table.sort(tree, ...a.sortname < b.sortname`, :236), which is why upstream's
 * screen opens on "Actions" rather than on movement. Ours is an explicit list so
 * the sections read in the order a player learns them.
 */
export const KEY_GROUPS = ['Movement', 'Turn', 'Screens', 'Hotbar', 'Log'] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

/**
 * WHAT AN ACTION DOES WHEN ITS KEY IS PRESSED.
 *
 * ═══ THIS FIELD IS AN ADDITION TO ToME'S RECORD, AND IT IS NOT OPTIONAL ═══
 * Upstream's action record carries a `type` string and the game hangs a CLOSURE
 * off it separately (`key:addBinds{ EXIT = function() ... end }`), so the table
 * and the behaviour are joined by a string lookup at run time. That is exactly
 * the shape `GameMenu.lua:125-133` demonstrates the failure of — it silently
 * drops any name it cannot resolve. Carrying the effect ON the record makes the
 * compile below TOTAL: a new action with no effect is a compile error, and the
 * seven tables cannot drift from the registry because they are derived from it.
 */
export type ActionEffect =
  | { readonly kind: 'move'; readonly dir: Dir }
  | { readonly kind: 'command'; readonly command: TurnCommand }
  | { readonly kind: 'slot'; readonly slot: number }
  | { readonly kind: 'ui'; readonly command: UiCommand }
  | { readonly kind: 'scroll'; readonly steps: number }
  | { readonly kind: 'cancel' };

export type ActionDef = {
  readonly id: string;
  /** What the Keys screen calls it. ToME's `t.name` (KeyBind.lua:35). */
  readonly name: string;
  readonly group: KeyGroup;
  /** Definition order, ToME's monotonic `_M.bind_order` (KeyBind.lua:38-40). */
  readonly order: number;
  readonly effect: ActionEffect;
  /**
   * The two REBINDABLE slots' shipped values. Fewer than two entries means the
   * remaining slots start empty and the player may fill them.
   */
  readonly defaults: readonly Binding[];
  /**
   * THE PERMANENT FLOOR: bindings no remap can touch, reach or clear.
   *
   * ═══ THIS IS HOW "REBINDABLE" IS PER-SLOT WITHOUT A THIRD WIRE SLOT ═══
   * Decision (c) freezes the ARROWS and the NUMPAD on every direction, NumpadEnter
   * on Commit and Numpad5 on Hold, while leaving the vi letters, Space, Enter and
   * '.' fully rebindable. Those are per-SLOT freezes on actions that are otherwise
   * open, and the wire carries exactly two slots
   * (src/shared/protocol.ts:2149-2159), so they cannot live in `defaults`: the
   * orthogonal directions would need three.
   *
   * SO THE FROZEN BINDINGS SIT OUTSIDE THE OVERLAY ENTIRELY. They are compiled in
   * unconditionally, they are never serialised, and no `setBinding` can name
   * them. That is what makes "I bound every movement key to the same key"
   * structurally unreachable rather than merely refused — the recovery hatch is a
   * property of the data model, not of a validation somebody could bypass with a
   * hand-edited save.
   *
   * ═══ WITH ONE THING THIS ALONE DID NOT BUY, NOW BOUGHT SEPARATELY ═══
   * Sitting outside the overlay stops a frozen binding being CLEARED. It does not
   * stop another action's override being pointed at the same key: `compileKeymap`
   * fills eight independent namespace maps, `claim` only defends a cell inside
   * one of them, and keys.ts reads directions before it reads cancel. So
   * `key:escape` on a rebindable movement action took the entire cancel chain
   * while `cancel`'s own frozen row sat there being irrelevant. That hole is shut
   * by `FROZEN_CANCEL_CELLS` and `resolveSlot`, one screen down — and it is shut
   * as a FALLBACK to the default rather than a drop, because refusing a binding
   * must never be a second way to end up with no key at all.
   *
   * NOTHING IN ToME CORRESPONDS TO THIS. Upstream's only hard-coded escape hatch
   * is `sym ~= KeyBind._ESCAPE` inside the capture dialog (KeyBinder.lua:98) — a
   * raw sym compare, deliberately outside the virtual system, and the single
   * reason its binder is not self-bricking. A DEVIATION, and a wider one.
   */
  readonly fixed: readonly Binding[];
  /**
   * May the player write this action's two slots at all?
   *
   * `false` means the overlay is ignored for this action outright: `resolve`
   * never reads the remap and `setBinding` refuses. The Keys screen still LISTS
   * these — decision (c)'s "anything the player has no way to see" clause — with
   * the reason on the row.
   */
  readonly rebindable: boolean;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TABLE. `order` IS THE ARRAY INDEX PLUS ONE, AND A TEST PINS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * Twenty-six actions, and the count is not a coincidence: it is the same
 * enumeration `src/shared/protocol.ts:2138-2142` uses to justify
 * `KEYBIND_MAX_ACTIONS = 40` — "eight directions, three turn commands, eight UI
 * commands, four hotbar slots, two scroll steps and cancel is 26". If this table
 * ever exceeds forty rows, that constant is wrong and the wire will start
 * refusing complete keymaps.
 */
export const ACTIONS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // MOVEMENT — in `DIR_ORDER`, clockwise from north (src/shared/coords.ts:46-53)
  //
  // THREE KEY SETS, AND THAT IS NOT NEGOTIABLE PER keys.ts's OWN HEADER: "a
  // roguelike that only reads the arrow keys will be described as broken by
  // every player who has touched one before". The vi letters are the MNEMONIC
  // set and are the ones a player has an opinion about, so they are the
  // rebindable slot; the arrows and the numpad carry no mnemonic argument at all
  // and are frozen as the permanent floor.
  //
  // THE NUMPAD IS ON `code` AND MUST STAY THERE. With NumLock on, Numpad8's
  // `event.key` is the string '8' — indistinguishable from the number row and
  // therefore from the hotbar; with NumLock off it is 'ArrowUp'. The physical key
  // is the only stable identity.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'move_north',
    name: 'Move north',
    group: 'Movement',
    order: 1,
    effect: { kind: 'move', dir: Dir.N },
    defaults: [{ kind: 'key', value: 'k' }],
    fixed: [
      { kind: 'key', value: 'arrowup' },
      { kind: 'code', value: 'Numpad8' },
    ],
    rebindable: true,
  },
  {
    id: 'move_northeast',
    name: 'Move north-east',
    group: 'Movement',
    order: 2,
    effect: { kind: 'move', dir: Dir.NE },
    defaults: [{ kind: 'key', value: 'u' }],
    fixed: [{ kind: 'code', value: 'Numpad9' }],
    rebindable: true,
  },
  {
    id: 'move_east',
    name: 'Move east',
    group: 'Movement',
    order: 3,
    effect: { kind: 'move', dir: Dir.E },
    // `l` IS EAST AND THAT IS WHY THE TALENT PANEL COULD NOT HAVE IT. ToME's own
    // levelup mnemonic is dialog-local ("[L]evelup", dialogs/CharacterSheet.lua:99
    // and the `c == 'l'` branch at :289) and it is moot regardless: `dirByKey` is
    // consulted FIRST in the dispatch, an order keys.ts calls load-bearing. Shift
    // cannot rescue it either — every key-side lookup lowercases and deliberately
    // does not exclude Shift, so `L` is `l`.
    defaults: [{ kind: 'key', value: 'l' }],
    fixed: [
      { kind: 'key', value: 'arrowright' },
      { kind: 'code', value: 'Numpad6' },
    ],
    rebindable: true,
  },
  {
    id: 'move_southeast',
    name: 'Move south-east',
    group: 'Movement',
    order: 4,
    effect: { kind: 'move', dir: Dir.SE },
    defaults: [{ kind: 'key', value: 'n' }],
    fixed: [{ kind: 'code', value: 'Numpad3' }],
    rebindable: true,
  },
  {
    id: 'move_south',
    name: 'Move south',
    group: 'Movement',
    order: 5,
    effect: { kind: 'move', dir: Dir.S },
    defaults: [{ kind: 'key', value: 'j' }],
    fixed: [
      { kind: 'key', value: 'arrowdown' },
      { kind: 'code', value: 'Numpad2' },
    ],
    rebindable: true,
  },
  {
    id: 'move_southwest',
    name: 'Move south-west',
    group: 'Movement',
    order: 6,
    effect: { kind: 'move', dir: Dir.SW },
    defaults: [{ kind: 'key', value: 'b' }],
    fixed: [{ kind: 'code', value: 'Numpad1' }],
    rebindable: true,
  },
  {
    id: 'move_west',
    name: 'Move west',
    group: 'Movement',
    order: 7,
    effect: { kind: 'move', dir: Dir.W },
    defaults: [{ kind: 'key', value: 'h' }],
    fixed: [
      { kind: 'key', value: 'arrowleft' },
      { kind: 'code', value: 'Numpad4' },
    ],
    rebindable: true,
  },
  {
    id: 'move_northwest',
    name: 'Move north-west',
    group: 'Movement',
    order: 8,
    effect: { kind: 'move', dir: Dir.NW },
    defaults: [{ kind: 'key', value: 'y' }],
    fixed: [{ kind: 'code', value: 'Numpad7' }],
    rebindable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TURN — the verbs that cost the world's clock, plus the two answers to a body
  // on the floor and the one key that is never sent anywhere.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'commit',
    name: 'Commit turn',
    group: 'Turn',
    order: 9,
    effect: { kind: 'command', command: 'commit' },
    // SPACE because it is the largest key on the board and this is the most
    // pressed key in the game; ENTER because half the table will try it first.
    defaults: [
      { kind: 'key', value: ' ' },
      { kind: 'key', value: 'enter' },
    ],
    // NumpadEnter is FROZEN so the numpad hand can always end a turn without
    // leaving the pad, whatever the other two slots have been rewritten to.
    fixed: [{ kind: 'code', value: 'NumpadEnter' }],
    rebindable: true,
  },
  {
    id: 'hold',
    name: 'Hold (pass the turn)',
    group: 'Turn',
    order: 10,
    effect: { kind: 'command', command: 'hold' },
    // '.' has been the roguelike idiom for "wait" since Rogue.
    defaults: [{ kind: 'key', value: '.' }],
    // Numpad5 is FROZEN and is on `code` for the reason the whole numpad is:
    // NumLock on reports '5' and off reports 'Clear', and neither is bindable.
    // It is the middle of the movement ring, which is exactly what "stay put"
    // means with a numpad in your hand.
    fixed: [{ kind: 'code', value: 'Numpad5' }],
    rebindable: true,
  },
  {
    id: 'pickup',
    name: 'Pick up',
    group: 'Turn',
    order: 11,
    effect: { kind: 'command', command: 'pickup' },
    // ═══ `,` PICKS UP. CONVENTIONAL, NOT PORTED, AND IT SAYS SO ═══
    // ToME's own mnemonic for this act is `g`: `PICKUP_FLOOR` is a real virtual
    // action (modules/tome/class/Game.lua:2169-2172, calling `playerPickup`).
    // `g` IS ALREADY OURS FOR THE TALENT PANEL and moving it would break a
    // binding players have used since v9 to spend a point. So `,` — the other
    // roguelike convention, and free. There is no citation for it and none is
    // offered.
    //
    // ONE HONEST COLLISION, STATED RATHER THAN DISCOVERED: on the layouts where
    // the numpad's decimal key reports ',' instead of '.' — German and French
    // among them — that key now picks up rather than doing nothing. It is
    // KNOWINGLY ACCEPTED, and `conflictsFor` below treats it as a baseline so
    // the Keys screen does not nag about a collision this codebase already
    // agreed to in writing.
    defaults: [{ kind: 'key', value: ',' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'revive',
    name: 'Revive a fallen ally',
    group: 'Turn',
    order: 12,
    effect: { kind: 'ui', command: 'revive' },
    defaults: [{ kind: 'key', value: 'r' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'respawn',
    name: 'Refile yourself',
    group: 'Turn',
    order: 13,
    effect: { kind: 'ui', command: 'respawn' },
    // F FOR REFILE — the game's own word for coming back. A letter vi movement
    // never claimed, nowhere near R, and the only key in the game a player will
    // look for while reading a prompt rather than from memory.
    defaults: [{ kind: 'key', value: 'f' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'cancel',
    name: 'Cancel / menu',
    group: 'Turn',
    order: 14,
    effect: { kind: 'cancel' },
    // ═══ ESCAPE IS FROZEN, AND IT IS THE PRIMARY RECOVERY HATCH ═══
    // keys.ts calls it "the one key in the game that means 'put that back', and
    // it must never reach the server". It is also the command line's only exit
    // and the escape menu's opener, so freezing it guarantees the menu — and
    // therefore RESET ALL — is always exactly one press away no matter what the
    // player has done to the rest of the keyboard.
    //
    // ═══ AND THAT GUARANTEE TAKES TWO MECHANISMS, NOT ONE ═══
    // `rebindable: false` stops this row being edited. It does NOT stop another
    // row being pointed at Escape, and the dispatcher reads directions, slots and
    // scrolls out of maps it consults BEFORE `cancelKeys` — so a single stored
    // `move_north: ['key:escape']` used to take this key away entirely. The
    // second mechanism is `FROZEN_CANCEL_CELLS`, which makes every other action's
    // overlay fall back to its default rather than claim this cell. Both are
    // needed; neither is sufficient.
    //
    // ToME freezes the same key in the same place and for the same reason:
    // KeyBinder.lua:98 compares `sym ~= KeyBind._ESCAPE` as a RAW SYM, outside
    // the virtual system entirely. It is upstream's only hard-coded hatch.
    defaults: [],
    fixed: [{ kind: 'key', value: 'escape' }],
    rebindable: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREENS — the letters vi movement left free. h/j/k/l and y/u/b/n are spoken
  // for and always will be; r, f, t, c, m, p, g and i are not, and picking
  // anything shifted would collide with the capitals a shift-holding player
  // still means as moves.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'say',
    name: 'Open the command line',
    group: 'Screens',
    order: 15,
    effect: { kind: 'ui', command: 'say' },
    // `/` sits beside `t` because it is the chat key in every MUD, every IRC
    // client and Discord itself, and half the table will reach for it first.
    defaults: [
      { kind: 'key', value: 't' },
      { kind: 'key', value: '/' },
    ],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'show_sheet',
    name: 'Character sheet',
    group: 'Screens',
    order: 16,
    effect: { kind: 'ui', command: 'show_sheet' },
    // ═══ PORTED, and the citation is a mnemonic rather than a bindings table ═══
    // uiset/Classic.lua:270 asks which key is bound to SHOW_CHARACTER_SHEET and
    // prints "#GOLD#C#LAST#haracter Sheet" only `if (key == "C")` — a branch that
    // is only meaningful for the shipped default. Corroborated independently at
    // dialogs/debug/RandomObject.lua:417, whose button reads
    // "Show #GOLD#C#LAST#haracter Sheet". That is the single ToME default with
    // hard in-source evidence which lands on a screen this game has.
    defaults: [{ kind: 'key', value: 'c' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'show_talents',
    name: 'Talents',
    group: 'Screens',
    order: 17,
    effect: { kind: 'ui', command: 'show_talents' },
    // THE KEY IS CHOSEN, NOT PORTED. ToME's levelup screen is opened by a VIRTUAL
    // action (class/Game.lua:2215) whose default lives in the /data/keybinds
    // directory this clone does not have — see this file's header, which sets out
    // the grep that proves it. `g` is one of the letters vi movement left free.
    defaults: [{ kind: 'key', value: 'g' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'show_inventory',
    name: 'Inventory',
    group: 'Screens',
    order: 18,
    effect: { kind: 'ui', command: 'show_inventory' },
    // ═══ ToME'S OWN LETTER, VIA A DIALOG-LOCAL MNEMONIC ═══
    // `SHOW_INVENTORY` is a real virtual action (class/Game.lua:2177-2191) and
    // `SHOW_EQUIPMENT` is literally an alias of it at :2192 — so ONE key opening
    // ONE combined screen IS the upstream behaviour rather than a simplification,
    // and a second action for equipment would be an invention. The LETTER comes
    // from dialogs/CharacterSheet.lua:95-98's `Button.new{text="Manage
    // [I]nventory"}` and :287-288's `elseif (c == 'i' or c == 'I')`, which is a
    // BUTTON LABEL AND NOT A BINDING. Do not read `e` as a second key:
    // CharacterSheet.lua:285-286's `c == 'e'` selects a TAB inside that dialog.
    defaults: [{ kind: 'key', value: 'i' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'show_world_map',
    name: 'World map',
    group: 'Screens',
    order: 19,
    effect: { kind: 'ui', command: 'show_world_map' },
    /**
     * `M`, which is what every map in the genre is bound to, and ToME is no
     * exception — `SHOW_MAP` sits on it in `engine/KeyBind.lua`'s defaults.
     * There is nothing to port here beyond the letter; upstream's map is a
     * different thing.
     */
    defaults: [{ kind: 'key', value: 'm' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'zoom_out',
    name: 'Zoom out',
    group: 'Screens',
    order: 20,
    effect: { kind: 'ui', command: 'zoom_out' },
    defaults: [{ kind: 'key', value: '-' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'zoom_in',
    name: 'Zoom in',
    group: 'Screens',
    order: 21,
    effect: { kind: 'ui', command: 'zoom_in' },
    // `=` rather than `+`: it is the unshifted key, so it works without a
    // modifier on every layout this game has been played on.
    defaults: [{ kind: 'key', value: '=' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'toggle_party',
    name: 'Party panel',
    group: 'Screens',
    order: 22,
    effect: { kind: 'ui', command: 'toggle_party' },
    defaults: [{ kind: 'key', value: 'p' }],
    fixed: [],
    rebindable: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HOTBAR — FOUR KEYED SLOTS OUT OF EIGHT, NONE OF THE FOUR REBINDABLE, AND THE
  // REASON IS PAINTED ON THE SCREEN. src/client/ui/hotbar.ts:953-957 draws
  // `${index + 1}` as the label of each slot below `HOTBAR_TALENT_SLOTS`, so a
  // rebound digit makes four on-screen buttons lie, and there is no art budget to
  // redraw them — the manifest has no keycap glyphs. The other four slots are the
  // ITEM half of the bar (hotbar.ts:215): mouse-only, no key, no digit, and
  // therefore nothing here at all.
  //
  // MATCHED ON `key` AND NOT `code`, so a French AZERTY player (where the number
  // row is shifted) still presses what is printed on the cap. The counterpart
  // risk is the numpad: with NumLock on, Numpad1 reports `key === '1'`, which is
  // why the direction lookup runs FIRST and reads `event.code`. That order is
  // load-bearing and `conflictsFor` below arbitrates by walking it rather than by
  // comparing strings.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'hotbar_1',
    name: 'Talent slot 1',
    group: 'Hotbar',
    order: 23,
    effect: { kind: 'slot', slot: 0 },
    defaults: [],
    fixed: [{ kind: 'key', value: '1' }],
    rebindable: false,
  },
  {
    id: 'hotbar_2',
    name: 'Talent slot 2',
    group: 'Hotbar',
    order: 24,
    effect: { kind: 'slot', slot: 1 },
    defaults: [],
    fixed: [{ kind: 'key', value: '2' }],
    rebindable: false,
  },
  {
    id: 'hotbar_3',
    name: 'Talent slot 3',
    group: 'Hotbar',
    order: 25,
    effect: { kind: 'slot', slot: 2 },
    defaults: [],
    fixed: [{ kind: 'key', value: '3' }],
    rebindable: false,
  },
  {
    id: 'hotbar_4',
    name: 'Talent slot 4',
    group: 'Hotbar',
    order: 26,
    effect: { kind: 'slot', slot: 3 },
    defaults: [],
    fixed: [{ kind: 'key', value: '4' }],
    rebindable: false,
  },
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THERE IS NO SLOT 5 HERE YET, AND WHAT WOULD HAVE TO LAND WITH IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ui/hotbar.ts` argued slots 5-8 were impossible: the browser reports
   * Numpad5-Numpad9 as the strings '5'-'9', so binding them by KEY would put
   * four collisions on move_north, move_east, move_northwest and move_northeast
   * — the CARDINALS, far worse than the diagonal collisions slots 1-4 carry.
   *
   * That reasoning is exactly right about bindings by KEY, and it is why every
   * numpad binding in this file is already `{ kind: 'code' }`. It says nothing
   * about bindings by CODE: the top row reports `Digit5` and the numpad reports
   * `Numpad5`, different strings, so a code-bound slot cannot be reached from
   * the numpad at all. `Keymap.slotByCode` is the other half of that pair and
   * now exists, so the KEYBOARD is no longer what caps the bar at four.
   *
   * ═══ THE REMAINING CAP IS CONTENT, AND IT IS LOAD-BEARING ═══
   * `client/main.ts` appends the item slots ONLY when the loadout is exactly
   * `HOTBAR_TALENT_SLOTS` long. Raising that constant to 8 against classes that
   * author four talents would therefore not add four empty squares — it would
   * delete the item slots outright. And with the constant left at 4, a
   * `hotbar_5` would fire `pressItemSlot`, putting a key on a surface
   * `HOTBAR_ITEM_SLOTS` deliberately keeps mouse-only.
   *
   * So slots 5-8 arrive with the talents that fill them, in one diff, or they
   * arrive broken. The mechanism is here; the actions are not.
   *
   * SLOTS 1-4 STAY ON THEIR KEY BINDINGS when that day comes. Moving them to
   * codes would fix their diagonal collision too, and would also change what a
   * player on a non-QWERTY layout presses, on four keys that have worked since
   * M3. Separate decision, separate risk.
   */

  // ═══════════════════════════════════════════════════════════════════════════
  // LOG
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'toggle_log',
    name: 'Case Log',
    group: 'Log',
    order: 27,
    effect: { kind: 'ui', command: 'toggle_log' },
    // THE KEY IS CHOSEN, NOT PORTED, AND THIS SAYS SO RATHER THAN DRESSING A
    // GUESS AS A CITATION. ToME has a SHOW_MESSAGE_LOG action and its Classic HUD
    // triggers it (uiset/Classic.lua:238, with the tooltip branch at :281 that
    // would print whatever key it finds) — but there is no default to read in
    // this clone.
    //
    // ═══ IT WAS `m`, AND `m` WENT TO THE WORLD MAP ═══
    // M is the conventional roguelike MESSAGE key and also the conventional MAP
    // key, and only one of them can have it. The map won: it is the thing a
    // player reaches for constantly on a 170x100 region, and the Case Log is
    // already visible in the dock without being toggled at all.
    //
    // `v` FOR "VIEW" IS ARBITRARY AND SAYS SO. The vi-keys take h/j/k/l/y/u/b/n
    // for movement and the screens take c/g/i/p/t, so the honest options were
    // few and none of them are mnemonic. THE MEMBER DID NOT CHANGE, which is the
    // entire point of naming actions rather than keys — this row moved off `c`
    // at v8 and off `m` now, and nothing downstream noticed either time. It is
    // rebindable, so anyone who disagrees has one screen to visit.
    defaults: [{ kind: 'key', value: 'v' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'scroll_back',
    name: 'Scroll the log back',
    group: 'Log',
    order: 28,
    // +1 is BACK IN TIME, matching what Page Up does in every document ever
    // written. Shift picks the other lane, and that is a fact about a panel
    // rather than about a key, so it is not an action here.
    effect: { kind: 'scroll', steps: 1 },
    defaults: [{ kind: 'key', value: 'pageup' }],
    fixed: [],
    rebindable: true,
  },
  {
    id: 'scroll_forward',
    name: 'Scroll the log forward',
    group: 'Log',
    order: 29,
    effect: { kind: 'scroll', steps: -1 },
    defaults: [{ kind: 'key', value: 'pagedown' }],
    fixed: [],
    rebindable: true,
  },
] as const satisfies readonly ActionDef[];

/** Every action id this build binds. Derived, so the table is the only source. */
export type ActionId = (typeof ACTIONS)[number]['id'];

const BY_ID: ReadonlyMap<string, ActionDef> = new Map(
  ACTIONS.map((action) => [action.id, action] as const),
);

/** The action with this id, or `undefined` — the client's own membership check. */
export function actionById(id: string): ActionDef | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// COMPOSITION — PER-SLOT, COPY-ON-WRITE
// ---------------------------------------------------------------------------

/** The two slots of one action, resolved. `undefined` is an empty slot. */
export type ResolvedSlots = readonly [Binding | undefined, Binding | undefined];

function resolveSlot(action: ActionDef, stored: string | undefined, fallback: Binding | undefined) {
  // NO OVERRIDE. Absent entirely, or the explicit reserved word — both mean the
  // shipped default, which is what lets a changed default reach a player who
  // rewrote the OTHER slot. KeyBind.lua:131's `binds_remap[type] or t.default`
  // has this property per ACTION; this has it per SLOT.
  if (stored === undefined || stored === SLOT_DEFAULT) return fallback;
  // DELIBERATELY EMPTY. KeyBinder.lua:95-97's Backspace, which upstream spells
  // as a Lua nil in a positional table.
  if (stored === SLOT_NONE) return undefined;
  // AN UNREADABLE STRING FALLS BACK TO THE DEFAULT rather than to nothing. The
  // persist layer already drops what it cannot use (saves.ts:1208), so anything
  // that reaches here is a shape nobody anticipated — and the failure mode of
  // "your movement key does nothing" is strictly worse than "your rebind was
  // ignored". Never brick.
  //
  // AND AN UNDELIVERABLE ONE FALLS BACK FOR THE SAME REASON, which is a rule this
  // test suite forced rather than a rule anybody wrote down first: dropping a
  // `code:` binding on a UI verb at COMPILE time would have left that action with
  // no key at all, because the slot it was written into had already shadowed the
  // default. Refusing it HERE means the default is still standing behind it.
  //
  // AND SO DOES ONE THAT WOULD TAKE THE FROZEN CANCEL KEY. See
  // `FROZEN_CANCEL_CELLS`: `claim` only defends a cell inside ONE namespace map,
  // and the dispatcher reads directions before it reads cancel — so `key:escape`
  // on a movement action was enough to take the escape menu, the command line's
  // exit and the whole cancel chain away from a player, from one line of a
  // hand-edited save. Refused HERE, and refused as a FALLBACK, so the shipped
  // default is still standing behind it and the action keeps a key.
  const parsed = parseBinding(stored);
  if (parsed === undefined || !canDeliver(action, parsed)) return fallback;
  if (stealsFrozenCancel(action, parsed)) return fallback;
  return parsed;
}

/**
 * The two slots of `action` under `remap`.
 *
 * ═══ A DELIBERATE DEVIATION, TWICE OVER ═══
 * ToME replaces the WHOLE record: `getBindTable` returns `binds_remap[type] or
 * type.default` (KeyBind.lua:114-116, :131), so any remap shadows the entire
 * default array. Worse, `KeyBinder.lua:96-97/102-103/123-124/143` all read
 * `KeyBind.binds_remap[t.type] = KeyBind.binds_remap[t.type] or t.k.default` and
 * then WRITE THROUGH the result — `t.k.default` is stored BY REFERENCE, so the
 * first rebind permanently corrupts `binds_def[type].default` for the session.
 * That is precisely why upstream has no reset-to-default button: by the time you
 * wanted one, the defaults are gone.
 *
 * Here every slot is resolved independently and every write below ALLOCATES A
 * NEW ARRAY. `ACTIONS` is never mutated, which is what makes `resetOne` and
 * `resetAll` one line each and a `defaults` object safe to hand to a renderer.
 *
 * A NON-REBINDABLE ACTION IGNORES THE OVERLAY ENTIRELY, so a hand-edited save
 * naming `hotbar_1` changes nothing.
 */
export function resolve(action: ActionDef, remap: KeyRemap): ResolvedSlots {
  const stored = action.rebindable ? remap[action.id] : undefined;
  return [
    resolveSlot(action, stored?.[0], action.defaults[0]),
    resolveSlot(action, stored?.[1], action.defaults[1]),
  ];
}

/**
 * Every binding that will actually be compiled for this action: the resolved
 * slots first, then the permanent floor.
 */
export function bindingsFor(action: ActionDef, remap: KeyRemap): readonly Binding[] {
  const out: Binding[] = [];
  for (const slot of resolve(action, remap)) if (slot !== undefined) out.push(slot);
  for (const fixed of action.fixed) out.push(fixed);
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FROZEN CANCEL CELLS — THE ONE PART OF THE PERMANENT FLOOR THAT HAD TO BE
 * DEFENDED ACROSS NAMESPACES AS WELL AS INSIDE ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 * `ActionDef.fixed` promises that a frozen binding is "structurally unreachable
 * rather than merely refused", and the `cancel` row goes further: freezing Escape
 * "guarantees the menu — and therefore RESET ALL — is always exactly one press
 * away no matter what the player has done to the rest of the keyboard".
 *
 * THAT WAS NOT DELIVERED BY `fixed` ALONE, AND THE GAP IS ONE THE DATA MODEL
 * COULD NOT SEE. `compileKeymap` fills eight independent namespace maps and
 * `claim` only refuses a cell WITHIN ONE of them, so a stored override putting
 * `key:escape` on a rebindable movement action lands in `dirByKey` — and
 * `bindGameKeys` consults `directionFor` FIRST (keys.ts:418) and `cancelKeys`
 * only THIRD (:441). Escape would have walked the player north and NEVER reached
 * the cancel branch: no escape menu, no way out of targeting, no way out of the
 * command line, and no keyboard route to RESET ALL. The frozen entry on `cancel`
 * was irrelevant, because the two bindings lived in different maps read in a
 * fixed order.
 *
 * The capture field already refuses it — `conflictsFor` names `cancel` as the
 * holder — but that is exactly the UI-level validation `fixed`'s docblock says
 * the model is supposed to make unnecessary, and NOTHING on the persist path or
 * the wire path filters it: `parseKeybinds` accepts any non-empty ≤32-char
 * string, `SetKeybindsSchema` the same, and the gateway's `restoreKeybinds`
 * assigns verbatim BY DESIGN (net/ may not import the client's action table).
 * One hand-edited line in a character file — a file this codebase repeatedly
 * says humans read and edit — was enough.
 *
 * SO IT IS ENFORCED AT `resolveSlot`, WHICH IS A FALLBACK AND NOT A DROP. The
 * override is ignored and THE SHIPPED DEFAULT IS STILL STANDING BEHIND IT, which
 * is `canDeliver`'s own rule three lines down and the "never brick" rule this
 * file states twice: refusing the binding must not also cost the action its key.
 *
 * DERIVED FROM `ACTIONS` RATHER THAN LISTED. A hand-written 'escape' here would
 * rot the day the floor moves; this cannot, and it is empty for a caller who
 * compiles a table with no cancel action at all.
 *
 * LOWERCASED ON BOTH SIDES AND *NOT* SPLIT BY NAMESPACE, which is the one place
 * this predicate is deliberately blunter than `claim`. `code:Escape` reaches
 * `dirByCode` and shadows the cancel branch exactly as `key:escape` reaches
 * `dirByKey` and shadows it — same physical key, same brick, two spellings — so
 * both are refused. Nothing else in either namespace lowercases to 'escape', so
 * the bluntness costs no legitimate binding.
 */
const FROZEN_CANCEL_CELLS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const action of ACTIONS) {
    if (action.effect.kind !== 'cancel') continue;
    for (const binding of action.fixed) out.add(binding.value.toLowerCase());
  }
  return out;
})();

/**
 * Would this override steal a cell the cancel chain is frozen onto?
 *
 * Asked of every action but `cancel` itself — that row is `rebindable: false`, so
 * the overlay is never read for it and it can never be the thief.
 */
function stealsFrozenCancel(action: ActionDef, binding: Binding): boolean {
  if (action.effect.kind === 'cancel') return false;
  return FROZEN_CANCEL_CELLS.has(binding.value.toLowerCase());
}

/**
 * Can this namespace actually deliver a press to this kind of action?
 *
 * keys.ts has exactly TWO `code`-keyed tables — directions and turn commands —
 * because those are the two namespaces the numpad reaches, and the eight-step
 * dispatch order is load-bearing enough that adding lookups to it is not a free
 * change. So a `code:` binding on a UI verb, a hotbar slot, a scroll step or
 * cancel is a binding the dispatcher can never deliver.
 *
 * IT IS REFUSED AT THE CAPTURE FIELD RATHER THAN DROPPED SILENTLY. This is the
 * predicate that lets W4 do that, and `compileKeymap` drops such a binding as a
 * second line of defence — a rebind that appears to take and then does nothing
 * is the exact failure this whole feature exists to avoid.
 */
export function canDeliver(action: ActionDef, binding: Binding): boolean {
  if (binding.kind === 'key') return true;
  // THREE CODE-KEYED TABLES IN keys.ts NOW, not two. `slot` joined `move` and
  // `command` when the hotbar needed keys 5-8: they are bound to `Digit5`-
  // `Digit8` precisely so the numpad, which reports those as the strings
  // '5'-'9', cannot reach them. See `Keymap.slotByCode`.
  return (
    action.effect.kind === 'move' ||
    action.effect.kind === 'command' ||
    action.effect.kind === 'slot'
  );
}

// ---------------------------------------------------------------------------
// WRITES — every one of them allocates
// ---------------------------------------------------------------------------

/** Trailing "no override" entries carry no information; drop them. */
function tidy(slots: readonly string[]): readonly string[] {
  let end = slots.length;
  while (end > 0 && slots[end - 1] === SLOT_DEFAULT) end -= 1;
  return slots.slice(0, end);
}

function writeSlot(remap: KeyRemap, action: ActionDef, slot: number, value: string): KeyRemap {
  const current = remap[action.id];
  const slots: string[] = [];
  for (let i = 0; i < SLOTS_PER_ACTION; i += 1) slots.push(current?.[i] ?? SLOT_DEFAULT);
  slots[slot] = value;
  const next: Record<string, readonly string[]> = { ...remap };
  next[action.id] = tidy(slots);
  return next;
}

/**
 * Put `binding` in `slot` of `actionId`. Answers a NEW remap, or the one it was
 * given when the write is refused.
 *
 * REFUSED, NOT THROWN, in five cases: an unknown action, a locked one, a slot
 * outside the two the wire carries, a binding this action's namespace cannot
 * deliver, and one that would take a key the cancel chain is frozen onto. Every
 * one of them is a state the Keys screen should never reach, and every one of
 * them is a state a hand-edited save can produce.
 *
 * THE LAST OF THE FIVE IS BELT TO `resolveSlot`'S BRACES. That is where the
 * frozen-cancel rule is actually enforced — it has to be, because a stored map
 * reaches the compile without ever passing through this function. Refusing it
 * here as well means the screen never WRITES a binding the resolver would then
 * quietly ignore, which would read as a rebind that took and then did nothing.
 */
export function setBinding(
  remap: KeyRemap,
  actionId: string,
  slot: number,
  binding: Binding,
): KeyRemap {
  const action = actionById(actionId);
  if (action === undefined || !action.rebindable) return remap;
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_ACTION) return remap;
  if (!canDeliver(action, binding)) return remap;
  if (stealsFrozenCancel(action, binding)) return remap;
  return writeSlot(remap, action, slot, formatBinding(binding));
}

/** Backspace on a row — KeyBinder.lua:95-97, whose Lua nil this spells `'none'`. */
export function clearBinding(remap: KeyRemap, actionId: string, slot: number): KeyRemap {
  const action = actionById(actionId);
  if (action === undefined || !action.rebindable) return remap;
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_ACTION) return remap;
  return writeSlot(remap, action, slot, SLOT_NONE);
}

/**
 * RESET ONE. Delete the overlay entry and the shipped defaults are back.
 *
 * One line, and it is one line only because `defaults` was never mutated —
 * which is the whole practical payoff of the copy-on-write deviation above, and
 * the button ToME cannot offer.
 */
export function resetOne(remap: KeyRemap, actionId: string): KeyRemap {
  if (!(actionId in remap)) return remap;
  const next: Record<string, readonly string[]> = { ...remap };
  delete next[actionId];
  return next;
}

/** RESET ALL. An empty overlay is a real value on the wire, not a missing field. */
export function resetAll(): KeyRemap {
  return {};
}

// ---------------------------------------------------------------------------
// THE COMPILE
// ---------------------------------------------------------------------------

/** The seven tables keys.ts reads, plus the cancel set, plus their action twins. */
export type KeymapActions = {
  readonly dirByCode: ReadonlyMap<string, ActionId>;
  readonly dirByKey: ReadonlyMap<string, ActionId>;
  readonly slotByKey: ReadonlyMap<string, ActionId>;
  readonly slotByCode: ReadonlyMap<string, ActionId>;
  readonly cancelByKey: ReadonlyMap<string, ActionId>;
  readonly scrollByKey: ReadonlyMap<string, ActionId>;
  readonly uiByKey: ReadonlyMap<string, ActionId>;
  readonly commandByCode: ReadonlyMap<string, ActionId>;
  readonly commandByKey: ReadonlyMap<string, ActionId>;
};

/**
 * A COMPILED KEYMAP: everything a keypress needs, with no searching.
 *
 * ToME's `bindKeys` does exactly this and for the same reason — it flattens
 * every action's binding table into one `self.binds[keystring][virtual]` lookup
 * before any key arrives (KeyBind.lua:127-136). Ours splits by namespace because
 * a browser hands us two identities per press.
 *
 * THE SEVEN VALUE TABLES ARE BYTE-FOR-BYTE THE ONES keys.ts USED TO DECLARE, and
 * test/client/input/keymap.test.ts asserts that against the literal rows. They
 * are DERIVED from the action tables below them in the same loop, so the
 * dispatcher and the conflict detector cannot disagree about who owns a key.
 */
export type Keymap = {
  /** The overlay this was compiled from — `labelFor` needs it, so it travels. */
  readonly remap: KeyRemap;
  readonly dirByCode: ReadonlyMap<string, Dir>;
  readonly dirByKey: ReadonlyMap<string, Dir>;
  readonly commandByCode: ReadonlyMap<string, TurnCommand>;
  readonly commandByKey: ReadonlyMap<string, TurnCommand>;
  readonly slotByKey: ReadonlyMap<string, number>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SLOTS BOUND BY PHYSICAL KEY, WHICH IS WHAT LETS THERE BE MORE THAN FOUR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ui/hotbar.ts` records why keys 5-8 could not exist: the browser reports
   * Numpad5-Numpad9 as the STRINGS '5'-'9', so a `hotbar_5` bound by KEY would
   * fire on Numpad8 — which is `move_north`. Four more collisions on the
   * CARDINAL directions, where the existing four are only on the diagonals.
   *
   * That is true of bindings by KEY. It is not true of bindings by CODE: the top
   * row reports `Digit5` and the numpad reports `Numpad5`, and they are different
   * strings. Movement has always known this — every numpad binding in this file
   * is `{ kind: 'code' }` for exactly that reason — and the slot case simply did
   * not have the other half of the pair.
   *
   * WORSE THAN MISSING: `case 'slot'` claimed a code binding INTO `slotByKey`,
   * so a `{ kind: 'code' }` slot would have been stored under 'Digit5' and
   * matched against `event.key`, which is '5'. It could never fire, silently.
   */
  readonly slotByCode: ReadonlyMap<string, number>;
  readonly uiByKey: ReadonlyMap<string, UiCommand>;
  readonly scrollByKey: ReadonlyMap<string, number>;
  /** Escape, and nothing else unless somebody unfreezes it. */
  readonly cancelKeys: ReadonlySet<string>;
  readonly actions: KeymapActions;
};

/**
 * FIRST WINS inside a namespace, and that is a deviation worth having.
 *
 * Two actions can only reach the same table cell through a hand-edited save —
 * the capture field refuses a conflict — but when they do, the lower `order`
 * keeps the key. ToME resolves the same collision by `pairs` hash order
 * (KeyBind.lua:227-232), so upstream's winner can differ between runs of the
 * same build. Deterministic beats clever here: a player reporting "my key does
 * the wrong thing sometimes" is unfixable.
 */
function claim<T>(
  values: Map<string, T>,
  actions: Map<string, ActionId>,
  cell: string,
  value: T,
  id: ActionId,
): void {
  if (actions.has(cell)) return;
  actions.set(cell, id);
  values.set(cell, value);
}

/**
 * Flatten `actions` under `remap` into the tables a keypress reads.
 *
 * KEY-SIDE VALUES ARE LOWERCASED HERE. Every key-side lookup in keys.ts calls
 * `event.key.toLowerCase()` first, so a stored 'H' that was not lowered would
 * simply never match — the rebind would appear to take and then do nothing.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STORED KEYMAP CAN HOLD A KEY THE DEFAULTS HAVE SINCE GIVEN AWAY.
 * ═══════════════════════════════════════════════════════════════════════════
 * Keybinds persist server-side, deliberately: nobody should reconfigure them
 * twice. That means a save written before the world map existed still says
 * `toggle_log: ['key:m']` — and `m` is now the world map's default. Both land
 * in `uiByKey`, the later action wins, and the returning player presses M and
 * gets the Case Log with no explanation. Reported from play as a map that
 * "won't open properly".
 *
 * The rule this applies is narrow on purpose: a stored binding is only dropped
 * when it holds a key that action NO LONGER DEFAULTS TO and another action now
 * does. That is exactly the upgrade case and nothing else — a player who
 * deliberately bound the log to `m` after this shipped is expressing a
 * preference and keeps it, because their remap will also have moved the world
 * map off `m` and the conflict will not exist.
 *
 * IT DROPS RATHER THAN REWRITES. Moving the stored binding to the new default
 * would be inventing a preference nobody expressed; dropping it falls back to
 * the action's own default, which is the value the player would get on a fresh
 * clone and the one the Keys screen shows.
 */
export function migrateStoredKeymap(actions: readonly ActionDef[], remap: KeyRemap): KeyRemap {
  const defaultOwner = new Map<string, string>();
  for (const action of actions) {
    for (const b of action.defaults) {
      if (b.kind === 'key') defaultOwner.set(b.value.toLowerCase(), action.id);
    }
  }

  const out: Record<string, readonly string[]> = {};
  let dropped = 0;
  for (const [actionId, slots] of Object.entries(remap)) {
    const kept = slots.map((slot) => {
      if (typeof slot !== 'string' || !slot.startsWith('key:')) return slot;
      const key = slot.slice(4).toLowerCase();
      const owner = defaultOwner.get(key);
      // Held by somebody else's default now, and not by this action's own.
      if (owner !== undefined && owner !== actionId) {
        const mine = actions.find((a) => a.id === actionId);
        const stillMine = mine?.defaults.some(
          (b) => b.kind === 'key' && b.value.toLowerCase() === key,
        );
        if (stillMine !== true) {
          dropped += 1;
          return SLOT_NONE;
        }
      }
      return slot;
    });
    out[actionId] = kept;
  }
  if (dropped > 0) {
    console.warn(
      `keymap: dropped ${dropped} stored binding(s) that a newer default now owns; ` +
        'those actions fall back to their defaults. Rebind them on the Keys screen if you want them back.',
    );
  }
  return out;
}

export function compileKeymap(actions: readonly ActionDef[], remap: KeyRemap): Keymap {
  const dirByCode = new Map<string, Dir>();
  const dirByKey = new Map<string, Dir>();
  const commandByCode = new Map<string, TurnCommand>();
  const commandByKey = new Map<string, TurnCommand>();
  const slotByKey = new Map<string, number>();
  const slotByCode = new Map<string, number>();
  const uiByKey = new Map<string, UiCommand>();
  const scrollByKey = new Map<string, number>();
  const cancelKeys = new Set<string>();

  const aDirByCode = new Map<string, ActionId>();
  const aDirByKey = new Map<string, ActionId>();
  const aCommandByCode = new Map<string, ActionId>();
  const aCommandByKey = new Map<string, ActionId>();
  const aSlotByKey = new Map<string, ActionId>();
  const aSlotByCode = new Map<string, ActionId>();
  const aUiByKey = new Map<string, ActionId>();
  const aScrollByKey = new Map<string, ActionId>();
  const aCancelByKey = new Map<string, ActionId>();

  for (const action of actions) {
    const id = action.id as ActionId;
    for (const binding of bindingsFor(action, remap)) {
      if (!canDeliver(action, binding)) continue;
      const cell = binding.kind === 'key' ? binding.value.toLowerCase() : binding.value;
      const byCode = binding.kind === 'code';
      switch (action.effect.kind) {
        case 'move':
          if (byCode) claim(dirByCode, aDirByCode, cell, action.effect.dir, id);
          else claim(dirByKey, aDirByKey, cell, action.effect.dir, id);
          break;
        case 'command':
          if (byCode) claim(commandByCode, aCommandByCode, cell, action.effect.command, id);
          else claim(commandByKey, aCommandByKey, cell, action.effect.command, id);
          break;
        case 'slot':
          // BY CODE OR BY KEY, like `move` and `command` above — and unlike the
          // version of this line that claimed every slot into the key map
          // whatever it was bound by. See `slotByCode`.
          if (byCode) claim(slotByCode, aSlotByCode, cell, action.effect.slot, id);
          else claim(slotByKey, aSlotByKey, cell, action.effect.slot, id);
          break;
        case 'ui':
          claim(uiByKey, aUiByKey, cell, action.effect.command, id);
          break;
        case 'scroll':
          claim(scrollByKey, aScrollByKey, cell, action.effect.steps, id);
          break;
        case 'cancel':
          if (!aCancelByKey.has(cell)) {
            aCancelByKey.set(cell, id);
            cancelKeys.add(cell);
          }
          break;
      }
    }
  }

  return {
    remap,
    dirByCode,
    dirByKey,
    commandByCode,
    commandByKey,
    slotByKey,
    slotByCode,
    uiByKey,
    scrollByKey,
    cancelKeys,
    actions: {
      dirByCode: aDirByCode,
      dirByKey: aDirByKey,
      slotByKey: aSlotByKey,
      slotByCode: aSlotByCode,
      cancelByKey: aCancelByKey,
      scrollByKey: aScrollByKey,
      uiByKey: aUiByKey,
      commandByCode: aCommandByCode,
      commandByKey: aCommandByKey,
    },
  };
}

/** The shipped keymap with no overlay at all. Also the conflict baseline. */
export const DEFAULT_KEYMAP: Keymap = compileKeymap(ACTIONS, {});

// ---------------------------------------------------------------------------
// CONFLICTS — RESOLVED BY THE REAL DISPATCHER, NOT BY STRING EQUALITY
// ---------------------------------------------------------------------------

/**
 * ONE PHYSICAL PRESS, as the two fields keys.ts reads.
 *
 * A plain record and not a `KeyboardEvent`, which is what keeps this module pure
 * and testable in node with no fakes.
 */
export type Press = {
  readonly key: string;
  readonly code: string;
};

/**
 * WHAT `event.key` A GIVEN `event.code` CAN REPORT.
 *
 * ═══ A DEVIATION WITH NO UPSTREAM ANALOGUE, BECAUSE ToME READS RAW SDL SYMS ═══
 * The browser gives one physical key two names and the numpad's second name
 * changes with NumLock, so a table is the only way to know that Numpad1 and the
 * hotbar's '1' are THE SAME PRESS. Without it a conflict detector built on
 * string equality misses precisely the collisions that brick movement, and both
 * of them are in the shipped defaults already.
 *
 * The 'off' forms are the NumLock-off names (Numpad1 -> 'End', Numpad8 ->
 * 'ArrowUp'); the 'on' forms are the digits. NumpadDecimal carries THREE,
 * because German and French layouts report ',' where US layouts report '.' —
 * the collision `pickup`'s row above records as knowingly accepted.
 */
const KEY_FORMS_BY_CODE: ReadonlyMap<string, readonly string[]> = new Map([
  ['Numpad0', ['0', 'insert']],
  ['Numpad1', ['1', 'end']],
  ['Numpad2', ['2', 'arrowdown']],
  ['Numpad3', ['3', 'pagedown']],
  ['Numpad4', ['4', 'arrowleft']],
  ['Numpad5', ['5', 'clear']],
  ['Numpad6', ['6', 'arrowright']],
  ['Numpad7', ['7', 'home']],
  ['Numpad8', ['8', 'arrowup']],
  ['Numpad9', ['9', 'pageup']],
  ['NumpadDecimal', ['.', ',', 'delete']],
  ['NumpadEnter', ['enter']],
  ['NumpadAdd', ['+']],
  ['NumpadSubtract', ['-']],
  ['NumpadMultiply', ['*']],
  ['NumpadDivide', ['/']],
]);

/** The reverse: which physical keys can report this `event.key`. */
const CODES_BY_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [code, forms] of KEY_FORMS_BY_CODE) {
    for (const form of forms) {
      const list = out.get(form);
      if (list === undefined) out.set(form, [code]);
      else list.push(code);
    }
  }
  return out;
})();

/**
 * Every press this binding could arrive as.
 *
 * A `code` binding produces one press per NumLock form; a `key` binding produces
 * the plain press PLUS one for every physical key that can report that character
 * — which is what catches "you bound this to '1' and the numpad eats it".
 */
export function pressesFor(binding: Binding): readonly Press[] {
  if (binding.kind === 'code') {
    const forms = KEY_FORMS_BY_CODE.get(binding.value) ?? [''];
    return forms.map((key) => ({ key, code: binding.value }));
  }
  const key = binding.value.toLowerCase();
  const out: Press[] = [{ key, code: '' }];
  for (const code of CODES_BY_KEY.get(key) ?? []) out.push({ key, code });
  return out;
}

/**
 * WHICH ACTION ACTUALLY ANSWERS THIS PRESS.
 *
 * ═══ THE SAME EIGHT-STEP ORDER `bindGameKeys` WALKS, AND IT MUST STAY SO ═══
 * dir (code, then key) -> slot (code, then key) -> cancel -> scroll -> ui ->
 * command (code, then key). keys.ts marks that order load-bearing in two separate comments and
 * test/client/input/keys.test.ts pins it; this function is the second reader of
 * the same rule, and if the two ever disagree the Keys screen will confidently
 * name the wrong holder.
 */
export function resolveAction(press: Press, keymap: Keymap): ActionId | undefined {
  const lower = press.key.toLowerCase();
  const a = keymap.actions;
  const dir = a.dirByCode.get(press.code) ?? a.dirByKey.get(lower);
  if (dir !== undefined) return dir;
  // CODE THEN KEY, exactly as `bindGameKeys` reads it. A slot bound by code that
  // this function looked up by key would make the Keys screen name no holder for
  // a press the game answers, which is the disagreement the note above forbids.
  const slot = a.slotByCode.get(press.code) ?? a.slotByKey.get(lower);
  if (slot !== undefined) return slot;
  const cancel = a.cancelByKey.get(lower);
  if (cancel !== undefined) return cancel;
  const scroll = a.scrollByKey.get(lower);
  if (scroll !== undefined) return scroll;
  const ui = a.uiByKey.get(lower);
  if (ui !== undefined) return ui;
  return a.commandByCode.get(press.code) ?? a.commandByKey.get(lower);
}

/** One reason a bind cannot be taken: this press is already somebody else's. */
export type Conflict = {
  /** The action that would actually win the press. */
  readonly holder: ActionId;
  /** Its display name, so the screen can say it without a second lookup. */
  readonly holderName: string;
  /** The press that collides — `code` is '' when only the character collides. */
  readonly press: Press;
};

function signature(candidate: string, press: Press, holder: string): string {
  return `${candidate}|${press.code}|${press.key}|${holder}`;
}

/**
 * THE COLLISIONS THE SHIPPED DEFAULTS ALREADY HAVE, AND WHICH ARE ACCEPTED.
 *
 * There is one, and this codebase agreed to it in writing before this file
 * existed: `hotbar_1`'s '1' is eaten by `move_southwest` whenever NumLock is on
 * and the press came from Numpad1. The direction lookup runs first ON PURPOSE —
 * that is the whole reason the dispatch order is load-bearing — so it is not a
 * bug to report, it is the design.
 *
 * COMPUTED RATHER THAN LISTED, by running every action's OWN default bindings
 * through the detector against the default keymap. A hand-written list would
 * rot the first time a default moved; this cannot.
 */
const BASELINE: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const action of ACTIONS) {
    for (const binding of bindingsFor(action, {})) {
      for (const press of pressesFor(binding)) {
        const holder = resolveAction(press, DEFAULT_KEYMAP);
        if (holder !== undefined && holder !== action.id) {
          out.add(signature(action.id, press, holder));
        }
      }
    }
  }
  return out;
})();

/**
 * WOULD THIS BIND BE STOLEN, OR STEAL SOMETHING?
 *
 * ═══ A DEVIATION WITH NO UPSTREAM DESIGN. DO NOT CITE ToME FOR ANY OF IT ═══
 * `KeyBinder.lua:98-104` is the ENTIRE assignment path and it performs no lookup
 * for an existing holder — no scan of `binds_def`, none of `binds_remap`. Its
 * only diagnostic is `print("Binding", t.name, "to", ks, "::", curcol)` to
 * stdout. The collision materialises later, inside `bindKeys`
 * (KeyBind.lua:127-136), and is then resolved by `pairs` hash order at :227-232,
 * so which action wins can differ between runs. There is nothing here to port.
 *
 * ═══ IT ARBITRATES BY DISPATCH, NOT BY STRING EQUALITY ═══
 * Comparing key strings would miss the two collisions most likely to brick
 * movement, and both are present in the table TODAY: Numpad1 (`code`) and hotbar
 * slot '1' (`key`) are the same physical press, arbitrated only by dispatch
 * order; and the numpad decimal reports ',' on German and French layouts, where
 * `pickup` lives. So the candidate is expanded into every press it can produce
 * and each one is run through `resolveAction` — the same walk a real keydown
 * takes. Cross-namespace shadowing falls out for free because the dispatcher is
 * the arbiter.
 *
 * ═══ THE BASELINE IS SUBTRACTED, SO IT REPORTS ONLY WHAT IS NEW ═══
 * A collision the shipped defaults already have is not the player's doing and
 * naming it would be a nag they cannot act on — the `UNASSIGNED_CLASS`
 * false-alarm lesson, one layer up.
 *
 * The keymap passed in is the one WITHOUT the candidate applied, which is what
 * makes "who holds this now" the question being answered.
 */
export function conflictsFor(
  candidate: { readonly action: string; readonly binding: Binding },
  keymap: Keymap,
): readonly Conflict[] {
  const out: Conflict[] = [];
  // ONE ROW PER HOLDER, keeping the first press that reached it. `code:Numpad8`
  // expands to two presses (NumLock on and off) and both land on `move_north`;
  // telling a player twice that north already has that key is noise, and the
  // screen's sentence is "X is already Y — clear that first", which names an
  // action rather than a press. The BASELINE is still subtracted per PRESS,
  // because a collision can be pre-existing on one NumLock state and new on the
  // other.
  const seen = new Set<string>();
  for (const press of pressesFor(candidate.binding)) {
    const holder = resolveAction(press, keymap);
    if (holder === undefined || holder === candidate.action) continue;
    if (BASELINE.has(signature(candidate.action, press, holder)) || seen.has(holder)) continue;
    seen.add(holder);
    out.push({ holder, holderName: actionById(holder)?.name ?? holder, press });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DISPLAY — NEVER THE STORED FORM
// ---------------------------------------------------------------------------

/**
 * The names a player recognises. ToME's `formatKeyString` does the same job and
 * even the same kind of substitution — `sym:gsub("Keypad ", "k")`,
 * KeyBind.lua:179 — so 'Numpad8' reads as 'Num8' here.
 */
const KEY_LABELS: ReadonlyMap<string, string> = new Map([
  [' ', 'Space'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
  ['enter', 'Enter'],
  ['escape', 'Esc'],
  ['pageup', 'PgUp'],
  ['pagedown', 'PgDn'],
  ['tab', 'Tab'],
  ['backspace', 'Bksp'],
  ['home', 'Home'],
  ['end', 'End'],
  ['insert', 'Ins'],
  ['delete', 'Del'],
  ['clear', 'Clear'],
]);

/**
 * ONE BINDING, AS A PLAYER READS IT. '--' for an empty slot, which is
 * `formatKeyString`'s own first line: `if not ks then return "--" end`
 * (KeyBind.lua:158-160).
 *
 * A PURE DISPLAY LAYER. It never shows the stored form — a row reading
 * `key:h` would be leaking a serialisation into a screen.
 */
export function labelForBinding(binding: Binding | undefined): string {
  if (binding === undefined) return '--';
  if (binding.kind === 'code') {
    return binding.value.startsWith('Numpad')
      ? `Num${binding.value.slice('Numpad'.length)}`
      : binding.value;
  }
  const named = KEY_LABELS.get(binding.value);
  if (named !== undefined) return named;
  return binding.value.length === 1 ? binding.value.toUpperCase() : binding.value;
}

/**
 * WHAT AN ACTION'S ROW SAYS.
 *
 * With `slot`, one column — ToME's `b1`/`b2` (KeyBinder.lua:218-219), '--' when
 * that slot is empty. Without one, everything the action answers to including
 * the frozen floor, so the row can show a player that the arrows still work
 * after they rewrote `k`.
 *
 * W4's Keys screen and W5's hint line both read this rather than hard-coding a
 * mnemonic, because a hard-coded 'press C' is a lie the moment somebody rebinds.
 */
export function labelFor(actionId: string, keymap: Keymap, slot?: number): string {
  const action = actionById(actionId);
  if (action === undefined) return '--';
  if (slot !== undefined) {
    return labelForBinding(resolve(action, keymap.remap)[slot === 0 ? 0 : 1]);
  }
  const all = bindingsFor(action, keymap.remap).map(labelForBinding);
  return all.length === 0 ? '--' : all.join(' / ');
}
