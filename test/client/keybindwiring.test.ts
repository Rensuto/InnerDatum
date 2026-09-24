/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { bindGameKeys, createLiveKeymap } from '../../src/client/input/keys.ts';
import { createTravel, TravelStart } from '../../src/client/input/travel.ts';
import { DRAGGABLE_PANELS, DraggablePanel } from '../../src/client/ui/drag.ts';
import { applyCapture, CaptureKind } from '../../src/client/ui/escapemenu.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { KeyHandlers } from '../../src/client/input/keys.ts';
import type { ArmedCapture } from '../../src/client/ui/escapemenu.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ESCAPE MENU'S WIRING CONTRACT — src/client/main.ts, ONE TEST EACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS FILE READS SOURCE RATHER THAN IMPORTING IT ═══
 * test/client/travelwiring.test.ts:26-34 states the constraint in full and it
 * has not changed: main.ts calls `boot()` at module load, which reaches for
 * `document.getElementById`, the Discord SDK and a WebSocket, and vitest.config
 * .ts is emphatic that the environment is `node` with deliberately no jsdom.
 * There is no way to assert anything about that file by importing it.
 *
 * So this file asks its questions two ways, and each way is honest about what it
 * can prove:
 *
 *   STRUCTURALLY, by reading main.ts as text. Every assertion below is about a
 *   POSITION or an ABSENCE — where a gate sits relative to another gate, which
 *   function a rect is derived from, that a hit test appears in a disjunction —
 *   because those are the properties that decide whether this feature stalls a
 *   party, spends somebody's talent point, or leaves a player unable to type.
 *   None of them is reachable any other way, and all of them are exactly the
 *   kind of thing a later edit moves by accident.
 *
 *   BEHAVIOURALLY, by driving the REAL pure modules the way main.ts drives them
 *   — `applyCapture`, `bindGameKeys` and `createTravel`, with the two DOM globals
 *   test/client/input/keys.test.ts already fakes. Nothing here re-implements a
 *   rule; the modules are imported and used.
 *
 * ═══ THE LINE THIS FILE DOES NOT CROSS ═══
 * Same as travelwiring's: ANY RULE THAT CANNOT BE ASSERTED HERE BELONGS IN A
 * PURE MODULE. The rows, the capture state machine, the geometry, the conflict
 * detector and the paging arithmetic all live in src/client/ui/escapemenu.ts and
 * src/client/input/keymap.ts, and they have their own suites. main.ts is allowed
 * to be wiring and nothing else — which is precisely why its wiring is worth
 * pinning.
 */

const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/**
 * The same file with every comment line removed.
 *
 * ═══ WITHOUT THIS EVERY ASSERTION BELOW IS A LIE WAITING TO HAPPEN ═══
 * main.ts is heavily commented by house rule, and its comments QUOTE the code
 * they justify — "a gate here would take them back", "`if (menuOpen)`". A
 * `source.includes('if (menuOpen)')` would therefore pass against a file whose
 * gate had been deleted and whose comment still described it, which is the worst
 * possible failure for a structural test: green, and asserting the prose.
 */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

/**
 * The body of one `KeyHandlers` member, comments stripped.
 *
 * Sliced between the six markers rather than parsed: a parser here would be a
 * second implementation of TypeScript, and the markers are unique strings that
 * cannot be edited without deliberately editing this file too.
 */
const HANDLER_MARKERS = [
  'onMove: (dir) => {',
  'onCommand: (command) => {',
  // `shifted` is the bar's second page — Shift picks the lane, exactly as it
  // does for the log scroll. See .
  'onSlot: (slot, shifted) => {',
  'onCancel: () => {',
  'onUi: (command) => {',
  'onScroll: (steps, alternate) => {',
] as const;

function handlerBody(name: (typeof HANDLER_MARKERS)[number]): string {
  const start = CODE.indexOf(name);
  expect(start, `${name} is still a KeyHandlers member`).toBeGreaterThanOrEqual(0);
  const index = HANDLER_MARKERS.indexOf(name);
  const nextMarker = HANDLER_MARKERS[index + 1];
  const end =
    nextMarker === undefined ? CODE.indexOf('});', start) : CODE.indexOf(nextMarker, start);
  expect(end, `${name} has an end`).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

/**
 * The body of a plain named function, brace-matched.
 *
 * NOT `handlerBody`, which slices between the six `KeyHandlers` markers and
 * would silently return the wrong region for anything else — it did, and the
 * assertion below passed on a slice that was not the function at all.
 */
function fnBody(head: string): string {
  const start = CODE.indexOf(head);
  expect(start, `${head} still exists`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let seen = false;
  for (let i = start; i < CODE.length; i += 1) {
    const ch = CODE[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return CODE.slice(start, i + 1);
    }
  }
  throw new Error(`${head} has no end`);
}

/** Where a snippet sits in the whole file, asserted to exist as it goes. */
function at(snippet: string, within: string = CODE): number {
  const index = within.indexOf(snippet);
  expect(index, `main.ts still contains: ${snippet}`).toBeGreaterThanOrEqual(0);
  return index;
}

// ---------------------------------------------------------------------------
// 1. THE BARRIER GUARANTEE, MECHANISED
// ---------------------------------------------------------------------------

describe('the menu is a PANEL, and its rect is where that is decided', () => {
  it('derives the rect from panelBand like the other three panels, never from the viewport', () => {
    // ═══ THIS IS THE WHOLE BARRIER ANSWER AND IT IS ONE LINE ═══
    // The class picker — the only genuine modal in this client — is the only
    // member of `HudLayout` built from the full viewport, because a modal is
    // allowed to cover the hotbar. Everything derived from `panelBand` is
    // clamped under the top HUD and above the bottom bands, so it CANNOT come to
    // rest over the hotbar, the resource strip or the prose lines: the four
    // talent keys stay visible and pressable while somebody reads.
    //
    // A pass that "tidied" this into `escapeMenuRect(width, height)` would turn
    // the menu into a modal without touching a single line that says "modal",
    // and the failure would be five people waiting at a barrier on somebody who
    // opened a menu — a CRITICAL this codebase has shipped once already.
    //
    // ═══════════════════════════════════════════════════════════════════════
    // v12: THE SHAPE CHANGED AND THE ASSERTION WAS UPDATED DELIBERATELY.
    // ═══════════════════════════════════════════════════════════════════════
    // This used to match `menu: menuOpen ? escapeMenuRect({…}) : null` as one
    // expression. Draggable panels put `movePanel` between the helper and the
    // field — it adds the player's stored offset and re-clamps the result into
    // the SAME band — so the ternary is now that call's second argument. The
    // regex was widened rather than deleted, and it still asserts the whole of
    // the original property: the rect comes from `escapeMenuRect`, and it is
    // told `band.top` and `band.bottom` rather than the viewport.
    //
    // AND IT NOW ASSERTS THE BAND TWICE OVER, which is the stronger statement.
    // `movePanel`'s own third argument is `band`, so a pass that clamped a
    // dragged menu to the VIEWPORT instead — letting a player park it over the
    // hotbar and hide the four talent keys, which is the panel-not-modal promise
    // broken by a gesture rather than by a code change — fails here too.
    // ═══════════════════════════════════════════════════════════════════════
    // AND IT MOVED AGAIN, FOR A REASON, AND IS ASSERTED IN BOTH HALVES.
    // ═══════════════════════════════════════════════════════════════════════
    // The unmoved rect now comes from `unmovedPanelRect`, because a RELEASE has
    // to settle the stored offset against exactly the rect the painter drew
    // from, and two producers of that rect is how a settle banks a position that
    // was never on screen. So the property is asserted where each half of it now
    // lives: `hudLayout` still routes the field through `movePanel` with the
    // band, and `unmovedPanelRect` still builds the menu's rect from
    // `band.top`/`band.bottom` rather than from the viewport. A pass that
    // "tidied" either half into `escapeMenuRect(width, height)` still fails.
    const menuLine =
      /menu: movePanel\(\s*DraggablePanel\.Menu,\s*unmovedPanelRect\(DraggablePanel\.Menu, width, height, band\),\s*band,\s*width,\s*\)/.exec(
        CODE,
      );
    expect(menuLine, 'hudLayout still derives `menu` through movePanel').not.toBeNull();

    const producer = /function unmovedPanelRect\([\s\S]*?\n}/.exec(CODE)?.[0] ?? '';
    expect(producer, 'unmovedPanelRect exists').not.toBe('');
    // The options object every case is handed, and it is the BAND.
    const options = /const options = \{([^}]*)\}/.exec(producer)?.[1] ?? '';
    expect(options).toContain('top: band.top');
    expect(options).toContain('bottom: band.bottom');
    // ...and the menu's case is still `escapeMenuRect` of exactly that.
    //
    // ═══ IT SPREADS `options` NOW, AND THE GUARD IS UNCHANGED IN SUBSTANCE ═══
    // The keys screen is sized from the window while the root menu stays
    // compact, so the resolver is told WHICH SCREEN is up — one resolver for
    // both the painter and the hit test, which is what stops a grown panel from
    // being drawn in one place and clicked in another. `screen` is an addition
    // to the options object and not a replacement for its band: the two
    // assertions above still read `top: band.top` and `bottom: band.bottom` off
    // the same literal, so a pass that "tidied" this into
    // `escapeMenuRect(width, height)` still fails exactly as before.
    //
    // ═══ AND IT CARRIES THE ROWS NOW, WHICH IS THE THIRD FIELD ═══
    // WAS `/return menuOpen \? escapeMenuRect\(\{ \.\.\.options, screen:
    // menuScreen \}\) : null;/` — one line. The Journal is sized to its
    // CONTENTS (`escapeMenuRect`'s `rows`), so the resolver has to be handed
    // them, and it is handed them HERE for the reason `screen` is: one resolver
    // for the painter and the hit test. The claim is unchanged — the band is
    // still spread, the rows are still built from `escapeMenuRows`, and a pass
    // that tidied this into `escapeMenuRect(width, height)` still fails.
    expect(producer).toMatch(/return menuOpen[\s\S]{0,40}\? escapeMenuRect\(\{/);
    expect(producer).toMatch(/\.\.\.options,\s+screen: menuScreen,/);
    expect(producer).toMatch(
      /rows: escapeMenuRows\(escapeMenuView\(liveUiScale, liveUiScalePercent\)\),/,
    );
    expect(producer).toMatch(/\}\)\s+: null;/);

    // ...and the picker, one line below it, still is not derived that way — so
    // this test fails if somebody makes the two the same in EITHER direction.
    //
    // MATCHED AS A SHAPE, not as a literal line. It used to pin
    // `classPickerRect(width, height)` verbatim and broke the day the modal's
    // width cap started counting the classes — a test failing on an added
    // argument rather than on the claim it is making. What the claim actually is:
    // the picker is built from the VIEWPORT and never from `panelBand`, because
    // it is the one real modal here and is allowed to cover the hotbar.
    expect(CODE).toMatch(
      /picker: classOptions === null \? null : classPickerRect\(width, height[^)]*\)/,
    );
    expect(CODE).not.toMatch(/picker:.*panelBand/);
  });

  it('re-applies that refusal when the window shrinks UNDER an open menu', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE RECT CAN DISAPPEAR TWICE, AND ONLY ONE OF THEM WAS GUARDED.
    // ═══════════════════════════════════════════════════════════════════════
    // `openMenu` refuses a menu the band cannot hold because this surface routes
    // the arrows and Enter, so an open-but-undrawable one is an invisible thing
    // swallowing the movement keys. Nothing asked that question again after the
    // window MOVED: `hudLayout` simply answered `menu: null`, so the panel
    // stopped being painted and stopped being hit-tested while every keyboard
    // gate kept firing. Drag a Discord Activity panel under ~236 logical px and
    // the arrows stop walking, silently; Up lights the invisible list from the
    // END (`at < 0 && move < 0`), which is LEAVE PARTY, and the next Enter sends
    // a `party leave` frame from a menu the player never saw.
    const start = at('function onViewportChange(): void {');
    const body = CODE.slice(start, CODE.indexOf('window.addEventListener(', start));
    expect(body).toContain('if (menuOpen) {');
    expect(body).toContain('if (hudLayout(logicalW, logicalH).menu === null) {');
    expect(body).toContain('closeMenu();');
    // The same sentence `openMenu` uses — "nothing happened" is indistinguishable
    // from a dropped input, and here the player did not even press a key.
    expect(body).toContain("showNotice('no room for the menu — make the window taller');");
  });

  it('refuses to open a menu the band cannot hold, rather than opening it blind', () => {
    // ═══ AN OPEN-BUT-UNDRAWABLE MENU WOULD EAT THE MOVEMENT KEYS ═══
    // `escapeMenuRect` answers null on a band too short for a panel, exactly as
    // `inventoryPanelRect` refuses a viewport too narrow for four item frames.
    // The difference is that THIS surface routes the arrows and Enter while it
    // is open, so the failure would present as "walking stopped working" with
    // nothing on screen to connect it to the key that was pressed.
    const start = at('function openMenu(');
    const body = CODE.slice(start, at('function closeMenu('));
    expect(body).toContain('if (hudLayout(logicalW, logicalH).menu === null) {');
    expect(body).toContain('menuOpen = false;');
    expect(body).toContain("showNotice('no room for the menu — make the window taller');");
  });

  it('gives the menu no park, no standing order and no new client verb', () => {
    // decision (j): the mechanism reused is the panel shape, NOT the server-side
    // park. `parkForClassChoice` has its own documented stranding bug — the first
    // version left anonymous sockets held forever — and taking that machinery on
    // for a panel that does not need it would be adding the bug back rather than
    // preventing it.
    // Against CODE and not SOURCE: main.ts's class-chooser block NAMES
    // `parkForClassChoice` in a comment, to explain why that modal is safe to
    // swallow the keyboard and this panel needs no such thing. The prose is the
    // reasoning; the assertion is about the code.
    expect(CODE).not.toContain('parkForClassChoice');
    expect(CODE).not.toContain('standingOrder');
    expect(CODE).not.toContain('StandingOrder');

    // AND THE CLIENT'S VOCABULARY GREW BY EXACTLY ONE VERB. `set_keybinds` is
    // the Keys screen's only frame; nothing about opening, closing, paging or
    // reading this menu is ever told to the server, because the moment it is,
    // the barrier has something to wait for.
    const verbs = new Set([...CODE.matchAll(/\bt: '([a-z_]+)'/g)].map((match) => match[1]));
    expect([...verbs].sort()).toEqual([
      'choose_class',
      // NO `commit` ANY MORE: every action ends the turn, so the client never
      // sends one (`TurnCommand.Commit` confirms an aim and does nothing else).
      // THE SELECT SCREEN'S, and the only destructive verb the client has. Added
      // deliberately and listed here so it stays a thing somebody had to decide:
      // the screen could hold eight characters and had no way to hold seven,
      // which stopped being academic the moment a swap bug made three copies of
      // the same one.
      //
      // IT IS THE ONE ENTRY THE BARRIER CANNOT BE MADE TO WAIT FOR, and that is
      // not an exception to this assertion's rule so much as the far end of it:
      // it is spoken from a socket that HAS NO BODY, before the handshake has
      // completed, so there is no turn for it to be part of. See the second
      // exemption in the gateway's pre-handshake gate.
      'delete_character',
      // THE ANSWER, v27, and the second half of the pair below. It names an
      // OPTION ID and the NODE it was offered on — never a row number, and never
      // a subject: whose conversation it is comes from the session, exactly as
      // `choose_class` argues. `sayDialogue` is its only constructor.
      //
      // IT IS SENT FOR A LIVE ROW ONLY. A greyed story row consumes its press and
      // puts the server's reason — which names the lead — up as a notice, because
      // sending it anyway would earn a `refused` from the server, which is the
      // same outcome plus a round trip and an error code on screen.
      'dialogue_choose',
      // THE WAY OUT OF A CONVERSATION, v27, and listed here for `follow`'s
      // reason rather than exempted from the rule. It IS a frame the barrier can
      // be made to wait for — the opposite way round from every other entry:
      // while a window is open the SERVER has parked this body (`closeDialogue`
      // in net/gateway.ts), so the barrier is not waiting, and this frame is
      // what ends that. Escape sends it and nothing else; the local copy is
      // cleared by the server's `view: null` and never by this client deciding.
      //
      'dialogue_close',
      'drop',
      'equip',
      // NOT THE KEYS SCREEN'S. `follow` is the party pane's, added because a
      // member who crossed into an instance had no door back to the party — see
      // protocol.ts on `follow`. It is listed here so that the verb set stays a
      // thing somebody has to decide to grow, which is the whole point of this
      // assertion: every entry is a frame the barrier can be made to wait for.
      'follow',
      // NOT THE KEYS SCREEN'S EITHER, and listed here for `follow`'s reason.
      // `give` is the context menu's — the port of ToME's `PartySendItem`
      // dialog, reached by right-clicking a teammate rather than through the two
      // nested modals upstream uses. It is a genuine new verb and the barrier
      // CAN be made to wait for it: it costs the sender a turn, exactly as
      // `drop` does (Actor.lua:7323), because a free handover is the thing
      // `drop`'s own comment argues against.
      'give',
      'hold',
      'inspect',
      'move',
      'party',
      'pickup',
      'point',
      'respawn',
      // ONE FRAME FOR AS MANY AS TWO HUNDRED TURNS — ToME's `rest`
      // (Player.lua:971), ported v11. It is in this list rather than exempt from
      // it because it is a genuine new verb: the server decides how many turns
      // pass and why it stops, and the client's whole part is the empty frame.
      'rest',
      'revive',
      'say',
      // THE BAR'S ARRANGEMENT, and it belongs in this list for the reason the
      // list exists: it is a verb somebody had to decide to add. Same ground as
      // 'set_keybinds' beside it — a Discord Activity iframe partitions or
      // blocks localStorage, so a setting the player chose has nowhere to live
      // but the server, and a bar that forgot itself every session would read
      // as broken rather than as unsaved.
      //
      // IT DOES NOT GIVE THE BARRIER ANYTHING TO WAIT FOR. Dragging a talent
      // onto a key is not a turn and takes none: the frame is stored and
      // echoed, and nothing in the scheduler ever hears about it.
      'set_hotbar',
      'set_keybinds',
      /**
       * AND THE PANEL LAYOUT'S. The third preference verb, and it is listed here
       * for the reason the two around it are: a PREFERENCE, never an intent, so
       * the barrier does not wait for it and it costs the sender no turn.
       *
       * It exists because panel positions were the one display preference that
       * did NOT persist — they lived in a module-scope record and reset on every
       * reload, so a player who arranged their screen did it again each session.
       * Upstream saves the equivalent table in one act (`Minimalist.lua:393`),
       * which is why this carries the whole layout rather than one panel.
       */
      'set_panel_layout',
      // AND THE INTERFACE SIZE'S: a PREFERENCE and not an intent, so the barrier
      // never waits for it. Asked for as "an option in the settings for UI
      // scaling to lower or increase it" — `hudScale` was computed by
      // `viewLayout` alone with no way for a player to say otherwise.
      //
      // IT HAD A TWIN ON THIS LIST, `set_zoom`, AND THE VERB IS GONE. That is a
      // PROTOCOL BUMP and not a tidy-up (`27 -> 28` in shared/version.ts), so it
      // is listed here as an absence: this array is the whole of what this
      // client may say, and a verb removed from the schema while a caller
      // survived would be a frame refused as `bad_message` with nobody able to
      // guess why.
      'set_ui_scale',
      // THE PANEL'S TWO, and the only frames the shop tab sends. Opening,
      // paging and browsing a shelf are told to nobody: the shelf is a
      // broadcast the server already sends, and a "I opened the shop" frame
      // would be one more thing the barrier could be made to wait for.
      'shop_buy',
      'shop_sell',
      'spend_point',
      // AND THE ATTRIBUTE HALF OF THE SAME SCREEN. `spend_stat` is on this list
      // for exactly the reason `spend_point` is: the levelup panel sends it, it
      // names one of six stats rather than a tile or a target, and it advances
      // no clock. A verb added to that panel without appearing here would be a
      // verb nobody had thought about the barrier consequences of.
      'spend_stat',
      'talent',
      // NOT THE KEYS SCREEN'S EITHER, and listed for the same reason `follow`
      // is: it is the townsfolk verb, sent when somebody picks `Talk to` off a
      // right-click menu. It names a TARGET ID rather than a tile, because if
      // she steps aside between the click and the frame the honest answer is
      // "there is nobody there" rather than a conversation with whoever moved
      // into the square.
      //
      // IT COSTS THE BARRIER NOTHING, which is what this assertion is really
      // guarding. `handleTalk` spends no turn and pumps nothing — the same rule
      // `say` and `point` follow — so growing the set by this one entry does not
      // grow the set of things the barrier can be made to wait for.
      'talk',
      'unequip',
      // THE TAKE-BACK. The second destructive verb the client has, and listed
      // here for `delete_character`'s reason — so it stays a thing somebody had
      // to decide rather than a thing that appeared. It is bounded on the server
      // (the last four class / three generic spends, and only somewhere quiet)
      // and the panel draws its badge only on what the server marked, so the
      // client cannot offer a refund that will be refused.
      'unlearn',
      // BUYING A LOCKED DISCIPLINE, and it is its own verb rather than a branch
      // of spend_point because the three currencies do not convert — a frame
      // that sometimes cost the scarcest one would eventually cost it by
      // mistake, and nothing refunds a category point.
      //
      // IT GIVES THE BARRIER NOTHING TO WAIT FOR. Unlocking is not a turn and
      // takes none: the sheet grows, three frames go back, and the scheduler
      // never hears about it.
      'unlock_tree',
      // THE ATTRIBUTE TAKE-BACK. It joins `unlearn` rather than being an
      // exception to this list's rule: sent from a PANEL press and never from a
      // key, it neither parks the sender nor issues a standing order — the sheet
      // shrinks, three frames go back, and the scheduler never hears about it.
      'unspend_stat',
      // ADDED WITH THE DRAUGHTS. It is a frame the barrier can be made to wait
      // for — drinking costs the turn, exactly as equipping does — which is the
      // property this whole list exists to make somebody decide about on purpose.
      'use',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. THE ESCAPE CHAIN — BOTH ENDS
// ---------------------------------------------------------------------------

describe('the Escape chain gained three head links and one tail link', () => {
  const body = handlerBody('onCancel: () => {');

  it('offers a revive only to somebody who could actually perform one', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * "GO AND PICK YOUR FRIEND UP", SAID TO SOMEBODY LYING BESIDE THEM.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Both prompts — the canvas hint line and the aria-live status — branched on
     * `selfErased()`, and `adjacentDowned()` is about OTHER bodies. So a viewer
     * who was merely DOWNED fell through to the revive arm and was told, seen
     * and heard, to revive the ally on the floor next to them. `revive` needs a
     * body that can act and theirs cannot: `submitIntent` refuses anything not
     * `alive`, and a Downed player is `alive === false` deliberately.
     *
     * The ERASED arm already made the whole argument — "an erased player cannot
     * act at all — they cannot revive anybody, so the prompt below would be an
     * instruction they cannot follow" — and it was simply written one stage too
     * late.
     *
     * ASSERTED ON EVERY CALL SITE rather than on one named function, because
     * there are THREE surfaces and they must not drift: the canvas hint, the
     * aria-live status, and `attemptRevive` — seen, heard, and pressed. A screen
     * reader and a canvas disagreeing about what a stuck player can do is the
     * cruellest bug this state has, and a key that fires anyway makes liars of
     * both.
     *
     * THE ASSERTION IS "IT ASKED", NOT A PARTICULAR SPELLING. The prompts skip
     * themselves with `selfDowned() === null` and the action early-returns on
     * `!== null` with a sentence, which is right for each — pinning one form
     * would force the other to contort.
     */
    const calls = [...CODE.matchAll(/adjacentDowned\(\)/g)].filter(
      // The declaration itself, not a use of it.
      (call) => !CODE.slice(Math.max(0, (call.index ?? 0) - 40), call.index).includes('function '),
    );
    expect(calls.length, 'the revive lost a surface').toBeGreaterThanOrEqual(3);

    for (const call of calls) {
      const before = CODE.slice(Math.max(0, (call.index ?? 0) - 320), call.index);
      expect(before, 'a revive is offered or sent without asking if the viewer is up').toContain(
        'selfDowned()',
      );
    }
  });

  it('closes an open panel before it opens the menu over the top of it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * REPORTED FROM PLAY: "the interface is clunky as each panel can only be
     * opened AND closed with hotkey".
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A player who opened the inventory with `i` had exactly one way out of it,
     * and Escape — the key every other game has trained them to press — opened
     * the escape menu ON TOP of the panel instead.
     *
     * This file's own chain comment used to argue the panels should stay out,
     * because adding ONLY the character sheet would make Escape depend on which
     * panel happened to be open. That was a fair objection to a half measure:
     * all three answer now, so there is nothing left to depend on. It is also
     * the more faithful port, which the old comment conceded in passing —
     * "ToME's sheet IS closed by Escape".
     */
    const panels = at('if (closeTopPanel()) return;', body);
    const menu = at('openMenu();', body);
    expect(panels, 'no panel link in the chain').toBeGreaterThan(-1);
    expect(panels, 'the menu opens over a panel that is still up').toBeLessThan(menu);

    // AND BELOW THE IN-PROGRESS ACTIONS. A running walk and a live aim are
    // things the player STARTED and the panel is a surface they left open;
    // Escape stops the action first, which is the order the rest of this chain
    // already argues for.
    expect(at('if (cancelTravelIfActive()) return;', body)).toBeLessThan(panels);
    expect(at('if (targeting !== null && targeting.active()) {', body)).toBeLessThan(panels);
  });

  it('closes the panel on top, and leaves the HUD furniture alone', () => {
    /**
     * ═══ THE ORDER IS THE HIT-TEST ORDER, WHICH IS PAINT ORDER REVERSED ═══
     * `mousedown` tests inventory, then talents, then sheet. Escape reading the
     * same list is what makes one press and one click do the same thing to the
     * same surface — the one the player can see on top.
     */
    const picker = fnBody('function closeTopPanel(): boolean {');
    const inv = at('if (invVisible) {', picker);
    const talents = at('if (talentsVisible) {', picker);
    const sheet = at('if (sheetVisible) {', picker);
    expect(inv).toBeGreaterThan(-1);
    expect(inv, 'talents close before the inventory drawn over them').toBeLessThan(talents);
    expect(talents, 'the sheet closes before the talents drawn over it').toBeLessThan(sheet);

    /**
     * ═══ AND THE CASE LOG AND PARTY PANE ARE NOT IN IT ═══
     * They default ON and are HUD furniture, not opened interfaces. ToME's
     * message log and party frame are not dialogs and its Escape does not close
     * them either, so `m` and `p` stay their only toggles. Escape hiding the
     * party pane would be a key that quietly removes the thing telling you a
     * friend is bleeding out.
     */
    expect(picker, 'Escape hides the Case Log').not.toContain('logVisible');
    expect(picker, 'Escape hides the party pane').not.toContain('partyVisible');
  });

  it('puts all three head links below the picker swallow and above the token menu', () => {
    // BELOW THE PICKER because a required screen must stay undismissible: there
    // is no second copy of the `class_options` frame, so a player who escaped
    // out of it would be left on a map with a provisional class and nothing on
    // screen saying what happened.
    //
    // ABOVE THE TOKEN MENU on the identical argument the token menu already
    // makes for itself — the most recently opened, most modal-feeling surface
    // goes first.
    const picker = at('if (classOptions !== null) return;', body);
    const armed = at('if (menuArmed !== null) {', body);
    const keys = at('if (menuOpen && menuScreen === MenuScreen.Keys) {', body);
    const close = at('if (menuOpen) {', body);
    const token = at('if (tokenMenu?.close() === true) return;', body);

    expect(picker).toBeLessThan(armed);
    expect(armed).toBeLessThan(keys);
    expect(keys).toBeLessThan(close);
    expect(close).toBeLessThan(token);
  });

  it('orders the three innermost-first, so one press backs out of exactly one thing', () => {
    // The arm is inside the Keys screen, which is inside the menu. Any other
    // order means one press skips a level: closing the menu while a capture was
    // armed would leave the arm with no screen explaining it, and it would
    // swallow the next keypress on a bare map.
    const armed = at('menuArmed = null;', body);
    const backToRoot = at('showMenuScreen(MenuScreen.Root);', body);
    const close = at('closeMenu();', body);
    expect(armed).toBeLessThan(backToRoot);
    expect(backToRoot).toBeLessThan(close);
  });

  it('does not touch the five links in between', () => {
    // The whole point of inserting at the ENDS: travel, targeting, the armed
    // revive and the log keep their existing order, and travelwiring.test.ts's
    // interrupt (3) still describes where it sits.
    //
    // "BOTH LOG LANES" WAS TWO LINKS AND IS NOW ONE. The log was two bands with
    // a scroll position each, so Escape snapped both and the chain tested the
    // pair; it is one merged stream with one offset, and `toBottom` takes no
    // argument.
    const token = at('if (tokenMenu?.close() === true) return;', body);
    const travel = at('if (cancelTravelIfActive()) return;', body);
    const targeting = at('if (targeting !== null && targeting.active()) {', body);
    const revive = at('if (reviveArmed) {', body);
    const lanes = at('if (caseLog?.toBottom() === true) return;', body);
    expect(token).toBeLessThan(travel);
    expect(travel).toBeLessThan(targeting);
    expect(targeting).toBeLessThan(revive);
    expect(revive).toBeLessThan(lanes);
  });

  it('tests the notice explicitly at the tail instead of appending openMenu to clearNotice', () => {
    // ═══ THE BUG THIS TEST EXISTS FOR, AND IT IS ONE LINE WIDE ═══
    // The tail used to be `if (!record && !margin) clearNotice();`. Appending
    // `openMenu()` to that is the obvious edit and it BREAKS the contract:
    // `clearNotice` early-returns when `notice === null` and reports nothing, so
    // one press would both wipe a refusal off the screen AND open a menu over
    // the map. The explicit test is the only shape that keeps one press to one
    // thing.
    //
    // The two-lane form of that mistake is gone with the two lanes, so the
    // guard below is the log's single link rather than a test of two booleans.
    expect(body).not.toContain('if (!record && !margin) clearNotice();');

    const guard = at('if (caseLog?.toBottom() === true) return;', body);
    const noticeTest = at('if (notice !== null) {', body);
    const open = at('openMenu();', body);
    expect(guard).toBeLessThan(noticeTest);
    expect(noticeTest).toBeLessThan(open);

    // The notice branch RETURNS. Without this the explicit test would be
    // decoration and the two acts would still happen on one press.
    const between = body.slice(noticeTest, open);
    expect(between).toContain('clearNotice();');
    expect(between).toContain('return;');
  });
});

// ---------------------------------------------------------------------------
// 3. THE SIX KEYBOARD GATES
// ---------------------------------------------------------------------------

describe('the six keyboard gates', () => {
  it('keeps the class picker FIRST in every one of them', () => {
    // The picker is a screen that cannot be dismissed; the menu is one that can.
    // If the menu's gate ever came first, a player who owed a class choice and
    // somehow had a menu open would be typing at the wrong surface — and worse,
    // the picker's own swallow would stop being unconditional.
    for (const marker of HANDLER_MARKERS) {
      const body = handlerBody(marker);
      const picker = body.indexOf('classOptions !== null');
      expect(picker, `${marker} still gates on the picker`).toBeGreaterThanOrEqual(0);
      const menu = body.search(/\bmenuOpen\b|\bmenuArmed\b/);
      if (menu >= 0)
        expect(menu, `${marker} gates the menu after the picker`).toBeGreaterThan(picker);
    }
  });

  it('routes the arrows and Enter to the menu, and says what each one is for', () => {
    // A MODE ROUTES THE KEY, exactly as targeting mode has since M3. The Enter
    // gate is the one that earns its keep on its own: without it, a player who
    // pressed Enter meaning "do the lit row" would send `{t:'commit'}` and end
    // their turn from behind a panel.
    const move = handlerBody('onMove: (dir) => {');
    expect(move).toContain('moveMenuSelection(dir);');

    const command = handlerBody('onCommand: (command) => {');
    expect(command).toContain(
      'if (menuOpen && command === TurnCommand.Commit && menuHovered !== null) {',
    );

    // ...and the gate comes FIRST, so a lit row genuinely wins the press. What
    // would otherwise happen is nothing: Commit sends no frame now, because
    // every action ends the turn by itself.
    expect(at('pressMenuSelection()', command)).toBeLessThan(
      at('case TurnCommand.Commit:', command),
    );
  });

  it('NEVER swallows Hold or Pickup', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE CLASS-PICKER CRITICAL, REPRODUCED WITH TWO PLAYERS AND NO BACKSTOP.
    // ═══════════════════════════════════════════════════════════════════════
    // This gate used to be an unconditional `if (menuOpen) { ...; return; }`,
    // which ate Commit, Hold AND Pickup. A player with the menu up therefore
    // could not act at all — and the server is never told the menu is open, so
    // `surveyQuorum` counts them as BLOCKING. One reader was survivable: `bell()`
    // arms only at `committed >= total - 1`, so the Warrant Clock can bound
    // exactly ONE straggler. TWO readers and no Bell ever arms, `tickLevel`
    // returns `parked`, every monster on the level stops, and the world clock
    // halts with no timer that ends it.
    //
    // `panelBand` is NOT the answer to that and never was: keeping the hotbar
    // visible says nothing about the two handlers that were gated. THIS is.
    const command = handlerBody('onCommand: (command) => {');

    // The gate names Commit explicitly, so Hold and Pickup cannot be inside it.
    expect(command).not.toMatch(/if \(menuOpen\) \{/);
    expect(command).toContain('command === TurnCommand.Commit');

    // Hold and Pickup still reach the socket below it, unconditionally. Commit
    // sends NOTHING outside aiming and menus: every action ends the turn, and a
    // stray Space must never queue a hold that burns the next one.
    expect(command).not.toContain("t: 'commit'");
    expect(command).toContain("socket.send({ v: PROTOCOL_VERSION, t: 'hold' });");
    expect(command).toContain('sendPickup();');

    // AND THE SWALLOW IS CONDITIONAL ON SOMETHING ACTUALLY HAPPENING.
    // `pressMenuSelection` reports; a row that went disabled between the hover
    // and the press must fall through to the commit rather than become a silent
    // no-op, which this file's header calls the worst failure mode there is.
    expect(command).toContain('if (pressMenuSelection()) return;');
    expect(CODE).toContain('function pressMenuSelection(): boolean {');
  });

  it('exempts an armed revive from the menu gate, so the two-stage verb completes', () => {
    // `onUi` lets `Revive` through with the menu open on purpose. With more than
    // one downed ally adjacent that verb ARMS and asks for a direction — and the
    // direction was eaten by the menu gate, so the menu advertised a verb and
    // delivered half of it, during the one countdown where turns are the
    // resource being spent.
    const move = handlerBody('onMove: (dir) => {');
    expect(move).toContain('if (menuOpen && !reviveArmed) {');
    // ...and the exemption is UNDER targeting, so an open aim keeps the
    // precedence it has had since M3.
    expect(at('if (targeting !== null && targeting.active()) {', move)).toBeLessThan(
      at('if (reviveArmed) {', move),
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE CONVERSATION'S DIGIT GATE IS THE FIRST STATEMENT OF `onSlot`.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * It used to be pinned ABOVE `setTalentPage`, because that call was the first
   * statement of the handler and it was a WRITE: *"a gate placed under it would
   * let `2` in a conversation flip the action bar to page two on the way past —
   * and the page is a mode every later read resolves through, so the bar would
   * still be flipped after the conversation ended."*
   *
   * There is no page and no write. The handler's first statements are now pure
   * reads, so the thing to pin is the one that has not changed: the dialogue
   * gate comes before ANYTHING that can act, and `slot` is turned into a bar
   * index only after it has been offered to the conversation. Pinned against
   * `hotbarSlotForKey` — the only remaining act on a digit — so a later pass
   * that puts a second writer at the top of this handler fails here.
   */
  it('gates the conversation above every other reader of a digit', () => {
    const body = handlerBody('onSlot: (slot, shifted) => {');
    expect(at('if (dialogueView !== null) {', body)).toBeLessThan(at('hotbarSlotForKey(', body));
    // AND NOTHING WRITES BEFORE IT. The whole class of bug the old pin caught
    // was a WRITE on the way past a gate, so the absence of one is what is
    // asserted rather than the absence of one particular call.
    expect(body.slice(0, at('if (dialogueView !== null) {', body))).not.toMatch(/=[^=>]/);
    // AND IT IS THE DIGIT AS DRAWN, one-based, bounded by ui/dialogue.ts rather
    // than by a length read here: `slot` is zero-based everywhere else in this
    // handler, so passing it straight through would be off by one on every row.
    expect(body).toContain('slot + 1');
    /**
     * AND IT IS RESOLVED THROUGH THE LAID-OUT ROWS, WHICH IS WHY THE LAYOUT IS
     * REBUILT IN A KEY HANDLER.
     *
     * The first version indexed `dialogueView.options`, and on a band that could
     * place two of twenty answers `4` fired the fourth OPTION — a row that was
     * never drawn, and for a party lead a story row that commits the run. The
     * selection goes in with it because the selection is what PAGES the list, so
     * the rows this reads are the rows on the screen.
     */
    expect(body).toContain('dialogueGeometry(dialogueView, box, dialogueSelected)');
    expect(body).toContain('dialogueAnswerForDigit(');
  });

  it('swallows every turn verb in a conversation, and makes Enter the answer', () => {
    // Commit, Hold, Rest, Explore and Pickup all reach `unparkOnCommand` on the
    // server, which hands the body back AND CLOSES THE CONVERSATION. Letting one
    // through would end a conversation with a key that looks like it ends a turn.
    // It costs the other five players nothing because the body is ALREADY
    // parked, so `barrier.ts`'s `isBlocking` has stopped counting it.
    const body = handlerBody('onCommand: (command) => {');
    const gate = at('if (dialogueView !== null) {', body);
    expect(gate).toBeGreaterThan(at('if (classOptions !== null) {', body));
    expect(body).toContain('if (command === TurnCommand.Commit) sayDialogue(dialogueSelected);');
    // Above the menu's Enter gate, which would otherwise consume the key first.
    expect(gate).toBeLessThan(at('if (menuOpen && command === TurnCommand.Commit', body));
  });

  it('routes the arrows to the answer list instead of the body', () => {
    // The body is parked, so a step could not be acted on anyway — it would
    // arrive as a turn verb and close the window mid-sentence.
    const body = handlerBody('onMove: (dir) => {');
    const gate = at('if (dialogueView !== null) {', body);
    expect(gate).toBeGreaterThan(at('if (classOptions !== null) {', body));
    expect(gate).toBeLessThan(at('if (menuOpen && !reviveArmed) {', body));
    expect(gate).toBeLessThan(at("socket.send({ v: PROTOCOL_VERSION, t: 'move', dir });", body));
  });

  it('makes `say` the ACCEPT key in a conversation, because Enter IS `say`', () => {
    // NOT SYMMETRY WITH THE MENU ABOVE — a fact about the keymap. `commit` gave
    // Enter up to `say` and kept Space, and keymap.ts records at that binding
    // that the UI table is consulted BEFORE the command table. So an ungated
    // Enter in a conversation never reaches `onCommand` at all: it would open
    // the chat box over a window whose own hint line has just said "Enter say".
    const body = handlerBody('onUi: (command) => {');
    expect(body).toContain('if (dialogueView !== null && command === UiCommand.Say) {');
    expect(body).toContain('sayDialogue(dialogueSelected);');
    // EVERY OTHER UI VERB GOES THROUGH. A blanket return would take the panels
    // away from somebody who is only reading their own sheet.
    expect(body).not.toContain('if (dialogueView !== null) return;');
    // AND ONE KEY MEANS ONE THING: both routes call the same sender, so Enter
    // here and Space through `onCommand` cannot drift apart.
    expect(handlerBody('onCommand: (command) => {')).toContain('sayDialogue(dialogueSelected)');
  });

  it('leaves the chat row reachable while a conversation is open', () => {
    // THE OPPOSITE OF THE CHOOSER AND THE MENU, deliberately. Both of those put
    // `#cmd` out of reach because a focused field under them is a trap; this is
    // a dock panel over a live world, the composer is visible, and this is six
    // friends in a voice channel — a conversation must not mute one of them.
    // The keyboard route is spent on the answer list, and the mouse still opens
    // the box.
    expect(CODE).toContain('setCommandLineReachable(classOptions === null && !menuOpen);');
    expect(CODE).not.toContain('dialogueView === null && classOptions === null');
  });

  it('takes `say` and nothing else in onUi, because #cmd is out of reach', () => {
    // The row is `disabled` while the menu is open (`syncCommandLineReach`), so
    // `openCommandLine` would focus nothing and the key would silently do
    // nothing — the failure this file's header calls the worst one there is.
    // Every other UI verb is deliberately let through: `c`, `g` and `i` are the
    // same acts the menu's own rows perform.
    const body = handlerBody('onUi: (command) => {');
    expect(body).toContain('if (menuOpen && command === UiCommand.Say) {');
    expect(body).not.toContain('if (menuOpen) return;');
  });

  it('pages the Keys screen from the scroll keys, and leaves the root screen to the log', () => {
    const body = handlerBody('onScroll: (steps, alternate) => {');
    expect(body).toContain('if (menuOpen && menuScreen === MenuScreen.Keys) {');
    // Page Up is `steps: +1` ("back in time") in keymap.ts, and back in a paged
    // list is the EARLIER page. Reading it straight through would make Page Up
    // mean "later", which is the one thing no Page Up has ever meant.
    expect(body).toContain('pageMenu(steps > 0 ? -1 : 1);');
  });

  it('never REFUSES a talent digit, and closes the menu before the talent can aim', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // TWO HALVES, AND THE SECOND ONE IS WHY "UNGATED" WAS NOT ENOUGH.
    // ═══════════════════════════════════════════════════════════════════════
    // HALF ONE — NO REFUSAL. `layout.menu` comes from `panelBand` precisely so
    // this surface stays off the hotbar, and the stated reason for that is that
    // the four talent keys still work while somebody reads the menu. A gate that
    // dropped the press would take them back and leave the geometry arguing for
    // a property the keyboard no longer had.
    //
    // HALF TWO — THE MENU GETS OUT OF THE WAY FIRST. `activateSlot` sends
    // immediately only for `TalentShape.Self`; every other shape opens an AIM,
    // and an aim under an open menu was unreachable in all three directions at
    // once — `onMove`'s gate sits above `targeting.moveCursor`, `onCommand`'s
    // above `targeting.confirm()`/`cancel()`, and the menu head links in
    // `onCancel` consume Escape before the ring can see it. The player was left
    // with a live cursor, half of it behind the panel, that the keyboard could
    // neither steer, fire nor put away.
    //
    // The order is `runMenuEffect`'s `'ui'` case: close, THEN act, ported from
    // tome/class/Game.lua:2307-2308.
    const body = handlerBody('onSlot: (slot, shifted) => {');
    expect(body).toContain('if (menuOpen) closeMenu();');
    // `activateSlot(hotbarSlotForKey(slot, shifted))` — the digit and the
    // modifier resolve to ONE index, and Shift reaches the second nine rather
    // than swapping the first nine underneath the player.
    expect(body).toContain('activateSlot(hotbarSlotForKey(slot, shifted));');
    // NOT A REFUSAL: no early return anywhere between the picker gate and the
    // activation, so the digit always reaches a talent.
    expect(at('if (menuOpen) closeMenu();', body)).toBeLessThan(
      at('activateSlot(hotbarSlotForKey(slot, shifted));', body),
    );
    expect(body).not.toMatch(/if \(menuOpen\) return;/);
    // The reason is written where the refusal would have gone, so the next pass
    // reads it before adding one.
    const commented = SOURCE.slice(
      SOURCE.indexOf('onSlot: (slot, shifted) => {'),
      SOURCE.indexOf('onCancel: () => {'),
    );
    expect(commented).toContain('THE DIGITS ARE NEVER REFUSED HERE');
  });

  it('never disposes the key binding to suspend input', () => {
    // keys.ts forbids dispose-then-rebind outright: re-registering moves
    // `bindGameKeys` AFTER main.ts's travel-cancel listener and inverts an
    // Escape precedence two files independently call load-bearing. Gating in the
    // caller is the sanctioned mechanism and the menu uses it.
    expect(CODE).not.toContain('.dispose()');
  });
});

// ---------------------------------------------------------------------------
// 4. THE MOUSE
// ---------------------------------------------------------------------------

describe('the mouse layer', () => {
  it('lists the menu in overPanel, or the aim drags across tiles under a solid panel', () => {
    // Without this the targeting cursor follows the pointer across whatever is
    // underneath the panel and fires an `inspect` per hover-settle for every
    // body it passes over — and an exhausted token bucket answers `error`, which
    // cancels the player's aim (HOVER_SETTLE_MS states the cost in full).
    const start = at('function overPanel(clientX: number, clientY: number): boolean {');
    const body = CODE.slice(start, CODE.indexOf('canvas.addEventListener', start));
    expect(body).toContain('inRect(layout.menu, point.x, point.y)');
  });

  it('lists the conversation window in overPanel, and swallows a press on it', () => {
    // WORSE THAN THE OTHER FIVE IF OMITTED. An unswallowed press on the window's
    // own padding falls through to the travel branch, and travel is a TURN VERB,
    // and a turn verb reaches `unparkOnCommand` — so a misclick on a margin
    // would not merely walk the party, it would END THE CONVERSATION it landed
    // on and walk the body away from the person it was talking to.
    const start = at('function overPanel(clientX: number, clientY: number): boolean {');
    const body = CODE.slice(start, CODE.indexOf('canvas.addEventListener', start));
    expect(body).toContain('inRect(layout.dialogue, point.x, point.y)');

    // BOTH BUTTONS, and a press on no row still returns — a right-click inside
    // the window would otherwise open a verb menu on the tile behind it. It sits
    // below the token menu and above the right-click branch.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'"));
    const gate = at(
      'if (layout.dialogue !== null && dialogueView !== null && point !== null) {',
      mousedown,
    );
    expect(gate).toBeGreaterThan(at('if (tokenMenu !== null && tokenMenu.visible()) {', mousedown));
    expect(gate).toBeLessThan(at('if (event.button !== 0) {', mousedown));
  });

  it('pages a conversation under the wheel, before every other surface', () => {
    /**
     * ══════════════════════════════════════════════════════════════════════
     * THE HINT THAT NAMED THE KEYS IS GONE, SO THE MOUSE NEEDS A ROUTE.
     * ══════════════════════════════════════════════════════════════════════
     * The window shows the answers that FIT and prints "1-4 of 20" when they do
     * not; the strip under it used to read *"arrows move"*. Taking the strip
     * away was the request; it left the count line as the only sign more existed
     * with nothing naming a way to reach it, and four wheel notches over the
     * list left the window's pixels byte-identical. At the 640 floor IN COMBAT
     * an ordinary five-answer greet shows "1-2 of 5".
     *
     * IT IS THE SELECTION, NOT A SECOND SCROLL POSITION: `dialogueGeometry`
     * pages to keep the selected row on screen, so the list already has exactly
     * one thing driving it.
     */
    const start = at("'wheel',");
    const body = CODE.slice(start, CODE.indexOf('{ passive: false }', start));
    expect(body).toContain('moveDialogueSelection(');
    const paged = at('moveDialogueSelection(', body);
    // FIRST OF EVERY SURFACE, because the window is painted last of all but the
    // class picker — the same order `mousedown` step 1b keeps.
    for (const later of ['wheelLayout.menu', 'wheelLayout.sheet', 'caseLog?.bodyAt(']) {
      expect(paged, `the wheel reached ${later} before the conversation`).toBeLessThan(
        at(later, body),
      );
    }
    // AND IT CONSUMES THE GESTURE, or the activity iframe scrolls the page and
    // drags the canvas out of view.
    expect(body.slice(paged - 200, paged)).toContain('event.preventDefault();');
    // ...ONLY OVER THE WINDOW. A wheel anywhere else is not the list's.
    expect(body.slice(paged - 300, paged)).toContain(
      'inRect(wheelLayout.dialogue, point.x, point.y)',
    );
  });

  it('swallows a press on the open menu that no control claimed', () => {
    /**
     * `escapeMenuHitAt` answers null for the panel's chrome, for a greyed row
     * and — since the interface-size arrows stopped cycling from their ends —
     * for a greyed ARROW. Every one of those pixels is drawn over the map, the
     * log or the party pane. This used to rely on `overPanel` catching them nine
     * blocks further down, which is true today and one reorder away from not
     * being; step 1b makes the same promise for the conversation window and
     * gives the reason a press that got through would not merely misfire.
     */
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'"));
    const block = mousedown.slice(at('if (point !== null && layout.menu !== null) {', mousedown));
    const hit = at(
      'const hit = escapeMenuHitAt(layout.menu, menuRows(), point.x, point.y);',
      block,
    );
    const swallow = at('if (inRect(layout.menu, point.x, point.y)) {', block);
    // AFTER the controls, or the panel would swallow its own buttons.
    expect(hit).toBeLessThan(swallow);
    expect(block.slice(swallow, swallow + 120)).toContain('event.preventDefault();');
  });

  it('guards the wheel against the menu, as an occlusion guard', () => {
    const start = at("'wheel',");
    const body = CODE.slice(start, CODE.indexOf('{ passive: false }', start));
    expect(body).toContain('if (inRect(wheelLayout.menu, point.x, point.y)) return;');
    // MIRRORING PAINT ORDER: the menu is painted over all three, so it is tested
    // before all three.
    expect(at('wheelLayout.menu', body)).toBeLessThan(at('wheelLayout.sheet', body));
  });

  it('claims the wheel for the log only after every surface has declined it', () => {
    /**
     * THE ORDER IS THE FEATURE, AND IT OUTLIVED THE ACT IT USED TO GUARD.
     *
     * Every `return` above the tail is a surface saying "this wheel is mine, or
     * I am drawn over something whose it would be" — the chooser, the escape
     * menu, the sheet, the talent panel and the inventory. The TAIL used to
     * zoom the map; *"remove the (zoom) option"* took that, and what is left is
     * the Log's own lane, which must still be reached last.
     *
     * A hit test of the form "is the pointer NOT over any panel" would be a
     * second copy of that list, and the copy is what goes stale the next time a
     * panel is added — silently, because the symptom is a wheel that scrolls a
     * transcript from over a panel drawn on top of it.
     */
    const start = at("'wheel',");
    const body = CODE.slice(start, CODE.indexOf('{ passive: false }', start));
    const log = body.indexOf('caseLog?.scroll(');
    expect(log, 'nothing claims the wheel at all').toBeGreaterThan(-1);
    for (const guard of [
      'wheelLayout.menu',
      'wheelLayout.sheet',
      'wheelLayout.talents',
      'wheelLayout.inventory',
    ]) {
      expect(body.indexOf(guard), `${guard} must be tested before the log`).toBeLessThan(log);
    }
    // The lane guard is what decides it, and it comes before the act.
    expect(body.indexOf('caseLog.laneAt(')).toBeLessThan(log);
    // It suppresses the page scroll where it DOES act, or the activity iframe
    // drags the canvas out of view.
    expect(body.slice(0, log)).toContain('event.preventDefault();');
  });

  it('does nothing at all when the pointer is over the world', () => {
    /**
     * THE TAIL IS A BARE `return` NOW. The wheel over the world used to zoom the
     * map and the control is gone, so this client no longer has an opinion about
     * that gesture — and it must not claim one: `preventDefault` on a wheel it
     * does not use would be swallowing a browser gesture for nothing.
     *
     * SCANNED FOR THE ABSENCE OF THE WHOLE FEATURE, not just of one call, because
     * a wheel binding is exactly the kind of orphan a half-removal leaves: there
     * is no menu row and no key left, so a surviving wheel would be the only
     * route to a setting with no readout anywhere.
     */
    const start = at("'wheel',");
    const body = CODE.slice(start, CODE.indexOf('{ passive: false }', start));
    expect(body, 'the wheel still zooms').not.toContain('applyZoom');
    expect(body).not.toContain('renderer.setZoom');
    expect(body).not.toContain('renderer.zoom()');
  });

  it('hit-tests the menu before the three panels it is painted over', () => {
    // HIT-TEST ORDER MIRRORS PAINT ORDER — the rule main.ts states four times.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'"));
    const menu = at('escapeMenuHitAt(layout.menu, menuRows(), point.x, point.y)', mousedown);
    const inventory = at('inventoryPanelHitAt(', mousedown);
    const talents = at('talentPanelHitAt(', mousedown);
    const sheet = at('charSheetHitAt(layout.sheet, point.x, point.y)', mousedown);
    expect(menu).toBeLessThan(inventory);
    expect(inventory).toBeLessThan(talents);
    expect(talents).toBeLessThan(sheet);
  });

  it('adds the menu twin to every guard that stops a click reaching a control underneath', () => {
    // ═══ THE BUG RECORDED IN mousedown STEP 4, WITH A FOURTH PANEL ON TOP ═══
    // A null hit means "on the menu, but not on a control", and the instruction
    // for that case is to fall through to the `overPanel` swallow — NOT to the
    // hit tests in between. Without these a click on bare menu reaches a `+`, a
    // ×, a DROP or a DECLINE drawn underneath it, and the `+` version of that
    // spends an irreversible talent point.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'"));
    /**
     * ═══ COUNTED ACROSS BOTH SPELLINGS, BECAUSE FOUR OF THEM WERE FACTORED ═══
     * The menu is one of four panels painted over everything in the band, and
     * five blocks now ask the same question through `overFloating` rather than
     * writing the four rects out apiece. What this test is for is unchanged —
     * that every block which could reach a control UNDER the menu refuses — so
     * it counts the guard however it is spelled and then checks that the shared
     * expression really does name the menu.
     */
    const guards = [
      ...mousedown.matchAll(/!inRect\(layout\.menu, point\.x, point\.y\)/g),
      ...mousedown.matchAll(/!overFloating\(point\.x, point\.y\)/g),
    ];
    // The inventory block, the talent block, the sheet block, the party pane,
    // the Case Log, the pane's grip and the minimap.
    expect(guards.length).toBeGreaterThanOrEqual(4);
    expect(
      CODE.slice(at('const overFloating = (px: number, py: number): boolean =>')),
      'the shared occlusion expression stopped naming the escape menu',
    ).toContain('inRect(layout.menu, px, py)');

    // ...and the right-click branch treats it as occlusion over the party pane
    // too, which is where DECLINE lives.
    expect(mousedown).toContain(
      'overFloating(point.x, point.y) || inRect(layout.log, point.x, point.y);',
    );
  });

  it('keeps RESET ALL and every other control pointer-reachable', () => {
    // THE MOUSE IS THE RECOVERY ROUTE FOR A BRICKED KEYBOARD (decision (c)), so
    // every control on this surface has to be reachable without a key — and
    // RESET ALL must have no confirmation step, because a second press in front
    // of the recovery hatch is how a player with a broken keymap fails to reach
    // it.
    const start = at('function runMenuHit(hit: MenuHit): void {');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    for (const kind of [
      'MenuHitKind.Close',
      'MenuHitKind.Entry',
      'MenuHitKind.Rebind',
      'MenuHitKind.Clear',
      'MenuHitKind.Reset',
      'MenuHitKind.ResetAll',
      'MenuHitKind.Back',
      'MenuHitKind.Page',
    ]) {
      expect(body, `${kind} is routed`).toContain(kind);
    }
    expect(body).toContain('commitRemap(resetAll());');
  });

  it('stands the erased plate down while the menu is open, so it steals no click', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // TWO RECTS CENTRED IN THE SAME BAND, PAINTED IN ONE ORDER AND HIT-TESTED
    // IN THE OTHER.
    // ═══════════════════════════════════════════════════════════════════════
    // `respawnPromptRect` is 304x66 at `top + (band-66)/3` and `escapeMenuRect`
    // is 360x252 at `top + (band-252)/2`, so the plate always lands INSIDE the
    // menu and never beside it. `paintHud` draws the menu and THEN the plate,
    // while `mousedown` tests the plate at step 3 and the menu at step 3a — so a
    // click on where CHARACTER SHEET, TALENTS or INVENTORY is drawn fired
    // `attemptRespawn()` and sent a `respawn` frame instead. On the Keys screen
    // the same 48px strip hid four consecutive action rows and every control on
    // them, in exactly the state where a player is most likely to open the menu.
    //
    // NOTHING IS LOST BY SUPPRESSING IT: the plate's key is let through by
    // `onUi`, and this menu carries no respawn row for it to have been shadowing.
    // MATCHED AS THE CLAIM, not the literal. This pinned `selfErased() &&
    // !menuOpen` verbatim and broke when the plate learned to cover the DOWNED
    // stage as well — a failure about which predicate names the state, not about
    // the thing being guarded, which is that the menu stands the plate down.
    expect(CODE).toMatch(/deathView\(\) !== null && !menuOpen/);
  });

  it('opens no token menu while the escape menu is up, so the cancel chain agrees', () => {
    // `onCancel` puts the escape menu's head links ABOVE `tokenMenu.close()` on
    // the rule that the most recently opened surface answers first. That was not
    // invariant: the occlusion guard only refuses a right-click landing INSIDE
    // `layout.menu`, so a right-click on bare map still opened a token menu OVER
    // the escape menu — painted last of everything — and Escape then closed the
    // big panel underneath the little one the player was looking at.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'"));
    expect(mousedown).toContain('if (point !== null && !menuOpen) {');
    // The chain keeps its order, which is now true in both directions.
    const chain = handlerBody('onCancel: () => {');
    expect(at('if (menuOpen) {', chain)).toBeLessThan(
      at('if (tokenMenu?.close() === true) return;', chain),
    );
  });

  it('leaves a conversation on Escape, above the world map and every menu', () => {
    /**
     * ═══ *"escape should still work like normal"* — AND NOTHING ASSERTED IT ═══
     *
     * Neutering this arm survived the entire suite: the key fell through to the
     * world map and the escape menu while the SERVER still held the body parked,
     * which is a character braced for the rest of the session. The test named
     * `closes on the × through the same helper Escape uses` checks the × and the
     * helper and says nothing at all about the key — and `git show HEAD` says it
     * never did, so this is an inherited hole under a new mechanism.
     *
     * BELOW THE CHOOSER, which must stay undismissible, and ABOVE the world map
     * and the menus: while the window is up the server does not act on this
     * body, so one press must reach the thing actually holding the player.
     */
    const chain = handlerBody('onCancel: () => {');
    expect(chain, 'Escape stopped leaving the conversation').toContain('closeDialogue();');
    const leave = at('closeDialogue();', chain);
    expect(at('if (classOptions !== null) return;', chain)).toBeLessThan(leave);
    for (const later of ['if (worldMapOpen) {', 'if (menuOpen) {', 'tokenMenu?.close()']) {
      expect(leave, `Escape reached ${later} before the conversation`).toBeLessThan(
        at(later, chain),
      );
    }
    // ...AND IT IS THE SAME ONE ACT THE × PERFORMS. One writer of the frame.
    expect(CODE.split("t: 'dialogue_close'").length - 1, 'one dialogue_close').toBe(1);
  });

  it('dismisses the cog popover before the conversation under it', () => {
    /**
     * ═══ INNERMOST FIRST, WHICH IS WHAT *"work like normal"* MEANS HERE ═══
     *
     * Ruled by the author after the first draft closed both in one press. Every
     * other layered surface in this client dismisses the thing most recently
     * opened ON TOP first, and a popover standing over the answers is that
     * thing; one press taking the whole conversation with it is the shape where
     * a player loses a window they were mid-way through reading.
     *
     * IT COSTS THE PARKED BODY NOTHING, which is the objection this had to
     * answer. The popover is drawn by this client and held nowhere else, so
     * dismissing it sends no frame and leaves the body parked exactly as long as
     * it already was. The NEXT press reaches the conversation, still above the
     * world map and the menus.
     *
     * ORDER IS THE WHOLE RULE, so the assertion is on the order: a test that
     * only found both arms would pass with them the wrong way round, which is
     * precisely the bug.
     */
    const chain = handlerBody('onCancel: () => {');
    expect(chain, 'Escape stopped dismissing the popover').toContain(
      'dialogueSettingsOpen = false;',
    );
    expect(
      at('dialogueSettingsOpen = false;', chain),
      'Escape closed the conversation before the popover standing on it',
    ).toBeLessThan(at('closeDialogue();', chain));
  });

  it('redraws on a hover only when something actually changed', () => {
    // An unconditional `requestDraw` per mousemove turns this client's
    // dirty-flag renderer into a 60 fps one, which the header at the top of
    // main.ts forbids at length. ONE hit test feeds both hovers, and both
    // compare before they draw.
    const start = at("canvas.addEventListener('mousemove'");
    const body = CODE.slice(start, at("'wheel',"));
    expect(body).toContain('if (overMenuClose !== menuCloseHovered) {');
    expect(body).toContain('if (overMenuEntry !== menuHovered) {');
    expect((body.match(/escapeMenuHitAt\(/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. THE COMMAND LINE
// ---------------------------------------------------------------------------

describe('the command line is put out of reach by a RECOMPUTE', () => {
  it('has no third independent caller of setCommandLineReachable', () => {
    // ═══ A BARE BOOLEAN WITH TWO OWNERS IS A HOLE, NOT A GATE ═══
    // It had exactly two callers, both the class chooser's. A menu calling
    // `(true)` on close while the chooser was still up would hand the keyboard's
    // only escape route back in front of a screen that cannot be dismissed —
    // reopening the exact trap the function was written to shut.
    const calls = [...CODE.matchAll(/setCommandLineReachable\(/g)];
    // One declaration, one call — and the call is inside the recompute.
    expect(calls.length).toBe(2);
    expect(CODE).toContain('setCommandLineReachable(classOptions === null && !menuOpen);');
  });

  it('recomputes from both reasons at all three sites', () => {
    // Required whenever the MENU is open and not only while a capture is armed:
    // Tab is a legitimate key to BIND, and `#cmd` is the only tabbable element
    // on the page.
    expect((CODE.match(/syncCommandLineReach\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
    const open = at('function openMenu(');
    const close = at('function closeMenu(');
    expect(CODE.slice(open, CODE.indexOf('function closeMenu(', open))).toContain(
      'syncCommandLineReach();',
    );
    expect(CODE.slice(close, CODE.indexOf('function showMenuScreen(', close))).toContain(
      'syncCommandLineReach();',
    );
  });

  it('names the say key from the keymap rather than from the markup', () => {
    // index.html's placeholder names three keys in a string no TypeScript can
    // see, and one of them is rebindable — the same drift `maxLength` is set
    // from the schema to avoid.
    expect(CODE).toContain("labelFor('say', gameKeymap.current)");
    expect(CODE).toContain('syncCommandLinePlaceholder();');
  });

  it('reads every other key mnemonic off the live keymap too', () => {
    // A printed 'press g' is a lie the moment somebody rebinds. Five hard-coded
    // letters were on the canvas and in the aria-live region before v11.
    expect(CODE).not.toMatch(/press g[`'"]/);
    expect(CODE).toContain("keyHint('show_talents')");
    expect(CODE).toContain("keyHint('revive')");
    expect(CODE).toContain("keyHint('respawn')");
    // The respawn plate's speech is CALLED, not read off the frozen constant —
    // that constant is the shipped-default spelling by construction.
    expect(CODE).toContain('respawnPromptSpeech()');
    expect(CODE).not.toContain('RESPAWN_PROMPT_SPEECH');
  });
});

// ---------------------------------------------------------------------------
// 6. THE FRAME
// ---------------------------------------------------------------------------

describe('the keybinds frame', () => {
  it('applies the echo to the live keymap and never re-binds the handler', () => {
    // `setKeymap` mutates the live box, so the very next keydown uses the new
    // tables with no listener touched. Re-registering would move `bindGameKeys`
    // after the travel-cancel listener and invert the Escape precedence.
    const start = at("case 'keybinds':");
    const body = CODE.slice(start, CODE.indexOf("case 'pong':", start));
    expect(body).toContain('const migrated = migrateStoredKeymap(ACTIONS, msg.binds);');
    expect(body).toContain('setKeymap(migrated);');
    // MIGRATED ON THE WAY IN. Keybinds persist server-side, so a save written
    // before an action existed can still hold a key that a newer default now
    // owns — `toggle_log` kept `m` after the world map took it, and the
    // returning player pressed M and got the Case Log; `move_south` kept `j`
    // after WASD, and `j` is the Journal. The repair happens here, at the one
    // door those bindings come through.
    //
    // ...AND IT IS WRITTEN BACK, ONCE, WHICH IS WHAT MAKES IT AN UPGRADE. The
    // send cannot happen in this switch — `applyServerMessage` is module scope
    // and the socket lives in `boot`'s closure — so the corrected map is parked
    // on `keymapRepair` exactly as `storedUiScale` parks an interface step, and
    // `onMessage` drains it through `commitRemap`. Without the write-back the
    // rule would re-run every load and silently undo the next deliberate rebind
    // to a retired key.
    //
    // ═══ WHOLE STATEMENTS, NOT PREFIXES — THREE MUTANTS LIVED IN THE GAP ═══
    // This arm is the ONLY test of the migration-on-load path and it is a source
    // scrape, so every assertion has to be a statement a broken body cannot also
    // satisfy. It used to assert the prefix `keymapRepair = msg.persisted &&
    // !sameRemap(migrated, msg.binds)`, which stops before the `?`: a mutated
    // `... ? null : null` passed, the corrected map was never written back, and
    // the migration re-ran every session — the exact failure the write-back
    // exists to prevent. It asked only that `commitRemap(repair);` appeared
    // within 200 characters of the drain's `if`: deleting `keymapRepair = null;`
    // passed, and `commitRemap` then fired on EVERY subsequent server frame, a
    // `set_keybinds` and a character-file write per received message for the
    // rest of the session. And `toContain('setKeymap(migrated);')` is
    // presence-only: a second `setKeymap(msg.binds);` after it passed, and the
    // live tables then compiled from the RAW stored map.
    expect(body).toContain(
      'keymapRepair = msg.persisted && !sameRemap(migrated, msg.binds) ? migrated : null;',
    );
    // ONE `setKeymap` IN THIS ARM, so nothing can write the raw map after it.
    expect(body.match(/setKeymap\(/g) ?? []).toHaveLength(1);
    const drain = CODE.slice(at('if (keymapRepair !== null) {'), at('if (targeting !== null'));
    expect(drain).toContain('keymapRepair = null;');
    expect(drain).toContain('commitRemap(repair);');
    // CLEARED BEFORE THE SEND, which the docblock promises in as many words and
    // which is what stops a failing `commitRemap` becoming a frame per message.
    expect(drain.indexOf('keymapRepair = null;')).toBeLessThan(
      drain.indexOf('commitRemap(repair);'),
    );
    expect(body).toContain('keybindsPersisted = msg.persisted;');
    expect(body).not.toContain('bindGameKeys');
  });

  it('sends set_keybinds on every accepted change rather than batching to close', () => {
    // ToME saves only when its binder dialog is dismissed
    // (KeyBinder.lua:64-70 calls `saveRemap` from `unload`), and a disconnect
    // there silently discards everything. Worse here: the player may not get the
    // same socket back.
    const start = at('function commitRemap(remap: KeyRemap): void {');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    expect(body).toContain('setKeymap(remap);');
    expect(body).toContain("t: 'set_keybinds'");
    // ...and `closeMenu` sends nothing at all.
    const close = at('function closeMenu(): void {');
    expect(CODE.slice(close, CODE.indexOf('function showMenuScreen(', close))).not.toContain(
      'socket.send',
    );
  });

  it('tears the menu down when the class chooser arrives', () => {
    // ═══ A REQUIRED SCREEN MUST DISMISS THE OPTIONAL ONE IT COVERS ═══
    // `onCancel` returns unconditionally while `classOptions !== null`, the
    // picker is painted last of everything, and `overPanel` answers true for the
    // whole viewport while it is up — so an escape menu that was open when this
    // frame landed had no keyboard route out AND no pointer route out. A
    // reconnect re-sends `class_options` in the `hello` block, so this is
    // reachable by dropping a socket. The menu sat behind the chooser until a
    // class was picked, then reappeared over the map with whatever was armed on
    // it still armed.
    const start = at("case 'class_options':");
    const body = CODE.slice(start, CODE.indexOf("case 'log':", start));
    expect(body).toContain('resetMenuState();');
    expect(at('classOptions = msg.options;', body)).toBeLessThan(at('resetMenuState();', body));

    // ONE COPY OF THE RESET, shared with `closeMenu` — a second spelling of
    // "every piece of its state goes with it" is how the arm survives one of the
    // two exits.
    expect(CODE).toContain('function resetMenuState(): void {');
    const close = at('function closeMenu(): void {');
    expect(CODE.slice(close, CODE.indexOf('function showMenuScreen(', close))).toContain(
      'resetMenuState();',
    );
  });

  it('routes /keys straight to the Keys screen', () => {
    const start = at("case 'keys':");
    const body = CODE.slice(start, CODE.indexOf("case 'none':", start));
    expect(body).toContain('openMenu(MenuScreen.Keys);');
  });

  it('routes the four screen entries to the existing toggles', () => {
    // `Game.lua:2306-2307` fires the ordinary keybinding rather than opening a
    // second inventory, and so does this: one code path, shared with the key.
    const start = at('function runMenuEffect(effect: MenuEffect): void {');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    expect(body).toContain('runUiCommand(effect.command);');
    expect(body).toContain('sendParty(effect.action, null);');
    expect(body).toContain('showMenuScreen(MenuScreen.Keys);');
  });

  it('closes the menu BEFORE firing a screen verb, as upstream does', () => {
    // ═══ THE ORDER IS PORTED AND IT IS NOT DECORATION ═══
    // `Game.lua:2306-2307` reads `self:unregisterDialog(menu)` and THEN
    // `self.key:triggerVirtual("SHOW_CHARACTER_SHEET")`. This panel is painted
    // LAST and is wider than the sheet, the talent panel and the inventory
    // panel — so a row that opened one of them and stayed up would paint itself
    // straight over the thing the player just asked for, and the row would look
    // broken while working perfectly.
    const start = at('function runMenuEffect(effect: MenuEffect): void {');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    const ui = at('runUiCommand(effect.command);', body);
    const party = at('sendParty(effect.action, null);', body);
    // Every `closeMenu()` before the two verbs, and one immediately above each.
    expect(body.slice(0, ui).lastIndexOf('closeMenu();')).toBeGreaterThanOrEqual(0);
    expect(body.slice(0, party).lastIndexOf('closeMenu();')).toBeGreaterThan(
      body.slice(0, ui).lastIndexOf('closeMenu();'),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. THE CAPTURE LISTENER — behavioural, with keys.test.ts's fakes
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO FAKED GLOBALS, AND WHAT NODE'S EventTarget CAN AND CANNOT PROVE
 * ═══════════════════════════════════════════════════════════════════════════
 * The classes are test/client/input/keys.test.ts's, for its reason: Node has
 * `Event` and `EventTarget` natively but not `KeyboardEvent` or `HTMLElement`,
 * and keys.ts branches on `instanceof` for both — an undefined global in an
 * `instanceof` is a ReferenceError, not a false.
 *
 * ═══ NODE HAS NO PROPAGATION PATH, SO `{capture: true}` DOES NOT ORDER HERE ═══
 * A browser fires capture-phase listeners on `window` BEFORE any bubble-phase
 * listener, whatever order they were registered in — that is the property
 * main.ts relies on, and it is asserted STRUCTURALLY above (the `{ capture: true
 * }` option is in the source). Node's `EventTarget` has no tree, so it runs
 * listeners in registration order and ignores the flag. The listener is
 * therefore registered FIRST below, which reproduces the position the capture
 * phase guarantees in a browser.
 *
 * WHAT IS GENUINELY UNDER TEST IS THE CONSEQUENCE, and it is the half that could
 * actually be got wrong: that `stopImmediatePropagation` from that position
 * reaches a key the keymap has no meaning for AT ALL, and stops BOTH bubble
 * listeners together — so a key being bound cannot also cancel somebody's walk.
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
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
};

class FakeKeyboardEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  constructor(init: KeyInit) {
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

/** A walled 10x8 field, exactly travelwiring.test.ts's. */
const OPEN: LevelView = (() => {
  const rows = [
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ];
  const tiles: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < row.length; x += 1) {
      tiles.push(row.charAt(x) === '#' ? TileCode.WALL : TileCode.FLOOR);
    }
  }
  return { w: rows[0]?.length ?? 0, h: rows.length, tiles };
})();

/**
 * main.ts's three window listeners, wired the way main.ts wires them.
 *
 * The bodies are the real ones: `applyCapture` decides the capture, `bindGameKeys`
 * decides the keymap, and the travel listener does what main.ts's does — cancel,
 * and nothing else.
 */
function wireWindow(armed: { current: ArmedCapture | null }) {
  const target = new EventTarget();
  const seen: string[] = [];
  const live = createLiveKeymap();
  const outcomes: string[] = [];

  // FIRST, standing in for the capture phase. See the header.
  target.addEventListener(
    'keydown',
    (event) => {
      if (!(event instanceof FakeKeyboardEvent)) return;
      if (armed.current === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const outcome = applyCapture(armed.current, event, live.current);
      outcomes.push(outcome.kind);
      if (outcome.kind !== CaptureKind.Ignored) armed.current = null;
    },
    { capture: true },
  );

  const handlers: KeyHandlers = {
    onMove: () => seen.push('move'),
    onCommand: () => seen.push('command'),
    onSlot: () => seen.push('slot'),
    onCancel: () => seen.push('cancel'),
    onUi: () => seen.push('ui'),
    onScroll: () => seen.push('scroll'),
  };
  bindGameKeys(target, handlers, live);

  const travel = createTravel();
  target.addEventListener('keydown', () => {
    seen.push('travel-cancel');
    travel.cancel();
  });

  return {
    press: (init: KeyInit) => {
      const event = new FakeKeyboardEvent(init);
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    seen,
    outcomes,
    travel,
  };
}

describe('the capture-phase listener', () => {
  it('consumes Tab while armed — a key the keymap has no meaning for at all', () => {
    // THE PROOF THAT THIS CANNOT BE A `KeyHandlers` MEMBER. keys.ts drops an
    // unmapped key on its terminal `if (command === undefined) return;`, so Tab
    // never reaches a handler — a capture field riding the keymap could only
    // ever capture keys that were already bound.
    const armed = { current: { actionId: 'show_sheet', slot: 0 } as ArmedCapture | null };
    const wired = wireWindow(armed);

    expect(wired.press({ key: 'Tab', code: 'Tab' })).toBe(true);
    expect(wired.outcomes).toEqual([CaptureKind.Bound]);
    // Neither bubble listener ran: not the keymap, and not the travel cancel.
    expect(wired.seen).toEqual([]);
    // ONE PRESS WIDE. Every outcome but a bare modifier disarms, which is what
    // makes the barrier question not arise — there is no state in which this
    // screen is holding the keyboard and waiting for a human.
    expect(armed.current).toBeNull();
  });

  it('takes Escape as a disarm rather than letting it reach the cancel chain', () => {
    // KeyBinder.lua:98 compares the RAW sym for exactly this, deliberately
    // outside the virtual system, and it is the single reason upstream's binder
    // is not self-bricking.
    const armed = { current: { actionId: 'show_sheet', slot: 0 } as ArmedCapture | null };
    const wired = wireWindow(armed);

    expect(wired.press({ key: 'Escape' })).toBe(true);
    expect(wired.outcomes).toEqual([CaptureKind.Disarmed]);
    expect(wired.seen).toEqual([]);
    expect(armed.current).toBeNull();
  });

  it('stays armed through a bare modifier, so reaching for a key does not close it', () => {
    // KeyBinder.lua:88-93 skips its eight modifier syms and RETURNS WITHOUT
    // CLOSING, so the capture is still waiting when the player finishes reaching
    // for the key they actually meant.
    const armed = { current: { actionId: 'show_sheet', slot: 0 } as ArmedCapture | null };
    const wired = wireWindow(armed);

    expect(wired.press({ key: 'Shift', shiftKey: true })).toBe(true);
    expect(wired.outcomes).toEqual([CaptureKind.Ignored]);
    expect(armed.current).not.toBeNull();
    expect(wired.seen).toEqual([]);
  });

  it('is completely inert while nothing is armed', () => {
    // One comparison and a return. Escape still reaches the cancel chain, and an
    // unmapped key still reaches the travel-cancel listener — which is the whole
    // of interrupt (2) and must not have been quietly broken by adding a third
    // listener to this target.
    const armed = { current: null as ArmedCapture | null };
    const wired = wireWindow(armed);

    wired.press({ key: 'Escape' });
    expect(wired.seen).toEqual(['cancel', 'travel-cancel']);

    wired.seen.length = 0;
    wired.press({ key: 'Tab', code: 'Tab' });
    // Tab is unmapped, so the keymap says nothing — and the travel listener,
    // which is not a `KeyHandlers` member precisely for this reason, still runs.
    expect(wired.seen).toEqual(['travel-cancel']);
    expect(wired.outcomes).toEqual([]);
  });

  it('does not cancel a walk when a key is captured', () => {
    // ═══ THE SIDE EFFECT THE CAPTURE PHASE EXISTS TO PREVENT ═══
    // Every keydown reaching the window stops a walk (interrupt 2). Binding a
    // key is not "the player reached for the keyboard mid-walk" — it is the
    // player using a screen — and a rebind that silently stranded somebody two
    // thirds of the way across a room would be blamed on the walk, not on the
    // menu.
    const armed = { current: { actionId: 'show_sheet', slot: 0 } as ArmedCapture | null };
    const wired = wireWindow(armed);

    expect(
      wired.travel.begin({
        from: { x: 2, y: 2 },
        to: { x: 6, y: 2 },
        level: OPEN,
        stopShort: false,
      }),
    ).toBe(TravelStart.Started);
    expect(wired.travel.active()).toBe(true);

    // F9: unmapped, unbindable by accident, and therefore a key that reaches
    // the travel-cancel listener and nothing else when nothing is armed.
    wired.press({ key: 'F9', code: 'F9' });

    expect(wired.outcomes).toEqual([CaptureKind.Bound]);
    expect(wired.seen).toEqual([]);
    expect(wired.travel.active()).toBe(true);
  });

  it('registers with { capture: true } in main.ts, which is what orders it in a browser', () => {
    // Node cannot prove the ordering (see the header), so the option itself is
    // asserted structurally. Without it the listener runs LAST — after the
    // keymap has already fired and after the walk has already been cancelled —
    // and every behavioural claim above becomes false in the browser while
    // staying true here.
    const start = at("window.addEventListener(\n    'keydown',");
    const body = CODE.slice(start, CODE.indexOf('  );', start));
    expect(body).toContain('if (menuArmed === null) return;');
    expect(body).toContain('event.stopImmediatePropagation();');
    expect(body).toContain('{ capture: true }');
  });
});

describe('the menu rows that end something take two presses', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `SWITCH CHARACTER` AND `LEAVE PARTY` FIRED ON ONE CLICK.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ui/escapemenu.ts tests the LABEL. This pins the GATE — and the gate is the
   * half that matters, because a row that says `SURE?` and commits anyway is
   * worse than one that never asked.
   *
   * Upstream interposes a yes/no popup on the equivalent (Game.lua:2561-2570,
   * :2577-2587: "Save and go back to main menu?").
   */
  const gate = (): string => {
    const start = at('function armsFirst(index: number): boolean {');
    return CODE.slice(start, start + 700);
  };

  it('routes BOTH press paths through the arm', () => {
    /**
     * The keyboard path (`pressMenuSelection`, Enter on the hovered row) and the
     * pointer path (`runMenuHit`) are two entry points into the same act. A gate
     * on one of them is a gate a player walks around by using the other hand.
     */
    expect(CODE).toContain('armsFirst(row.index)');
    expect(CODE).toContain('armsFirst(hit.index)');
  });

  it('spends the press on arming, so it cannot fall through to the turn', () => {
    // `pressMenuSelection` returns FALSE for "nothing was activated" and the
    // caller then lets the key reach the commit underneath. An arm that reported
    // false would end the player's turn as the price of asking them a question.
    expect(CODE).toContain('if (armsFirst(row.index)) return true;');
  });

  it('names the rows by constant rather than by number', () => {
    // The indices belong to `rootRows`, which exports them. A literal 5 or 6 here
    // would move the confirmation onto INVENTORY the day a row is inserted — a
    // guard protecting the wrong thing, which reads as protection.
    expect(gate()).toContain('ROW_LEAVE_PARTY');
    expect(gate()).toContain('ROW_SWITCH_CHARACTER');
    expect(gate(), 'a bare index would drift').not.toMatch(/index === [0-9]/);
  });

  it('disarms on anything else, including the second press that commits', () => {
    // ONE BRANCH FOR BOTH, so there is no path that leaves a stale arm behind.
    expect(gate()).toContain('if (!guarded || menuConfirm === index) {');
  });
});

describe('the ui-size row changes the setting rather than owning it', () => {
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ONE PREFERENCE, THREE ROUTES, ONE FUNCTION.
   * ═════════════════════════════════════════════════════════════════════════
   * The two arrows, the Left/Right keys on the lit row and the row's own press
   * must all go through `applyUiScale` — that is where the clamp is read, where
   * the `set_ui_scale` frame is sent, and where both "that will not be saved"
   * warnings are said. A route that called `renderer.setUiScale` directly would
   * be a setting that silently stopped persisting, which is what the comment
   * above `applyUiScale` records having already happened once to its twin.
   */
  /** The `ui-scale` case's own body, ending where the next case begins. */
  const arm = (): string => {
    const start = at("case 'ui-scale': {");
    const end = CODE.indexOf("      case '", start + 10);
    expect(end, 'the ui-scale case has a neighbour below it').toBeGreaterThan(start);
    return CODE.slice(start, end);
  };

  it('goes through applyUiScale, not through the renderer', () => {
    expect(arm()).toContain('applyUiScale(next)');
    expect(arm(), 'a direct setUiScale would skip the persist and the warnings').not.toContain(
      'renderer.setUiScale(',
    );
  });

  it('cycles on the row itself and steps on an arrow', () => {
    // `delta: 0` is the row's own press and it WRAPS, which is what keeps a
    // keyboard-only player from being stranded at the top of the range;
    // anything else is one arrow and clamps at the renderer.
    expect(arm()).toContain('effect.delta === 0');
    expect(arm()).toContain('>= UI_SCALE_MAX ? UI_SCALE_MIN :');
    expect(arm()).toContain('at + effect.delta');
  });

  it('leaves the menu open, unlike every other row', () => {
    // The whole point is to look at the result and press again.
    expect(arm()).not.toContain('closeMenu()');
  });

  it('reads the step off the renderer rather than off a mirror', () => {
    // `liveUiScale` is a MIRROR for the painter, which is module scope. The ACT
    // runs inside boot and must ask the renderer, or two copies of the clamp
    // would disagree the first time a window had no room for a step.
    expect(arm()).toContain('renderer.uiScale()');
  });

  it('gives the keyboard the same two steps the arrows have', () => {
    /**
     * WITHOUT THIS THE ARROWS ARE POINTER-ONLY. The row is selectable with the
     * arrow keys like every other, and a horizontal key on it means what the
     * two buttons mean — the same argument that gave the setting a pointer
     * route in the first place, read in the other direction.
     */
    const start = at('function moveMenuSelection(');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    expect(body).toContain("runMenuEffect({ kind: 'ui-scale', delta: delta.x })");
    // ...and only on a row that HAS steppers, or a horizontal key would stop
    // moving the selection everywhere else on the screen.
    expect(body).toContain('lit.steppers !== undefined');
  });

  it('walks only the entries that are actually on the panel', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SELECTION USED TO STEP PAST THE EDGE OF THE PANEL.
     * ═══════════════════════════════════════════════════════════════════════
     * `enabledEntryIndices` was a filter over the whole ROW LIST while the
     * geometry truncates — the panel prints `N more — panel too small` and this
     * surface has no pager for the Journal — so on a short window the marker
     * stepped onto a note that is not drawn and Enter unfolded it, invisibly.
     * The pointer could never reach those rows, so the keyboard and the mouse
     * disagreed about what the panel contained. Both go through the ONE geometry
     * now, which is the same rule `rectFor` states for the rect itself.
     */
    const start = at('function enabledEntryIndices(');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    expect(body).toContain('escapeMenuVisibleEntries(rect, rows)');
    // THE RECT COMES FROM `hudLayout`, the one resolver the painter reads — not
    // from a second copy of the arithmetic.
    expect(body).toContain('hudLayout(logicalW, logicalH).menu');
    // ...and a panel that is not on screen offers nothing, rather than offering
    // rows behind it.
    expect(body).toContain('if (rect === null) return [];');
    // AND THE OLD SHAPE IS GONE: a bare walk of `rows` here is the bug.
    expect(body).not.toContain('for (const row of rows)');
  });

  it('mirrors the step, the percentage and the cap from one writer', () => {
    /**
     * THREE FACTS ABOUT ONE SETTING THAT GO STALE AT DIFFERENT MOMENTS: the
     * step moves on a press, the percentage moves with the step AND the window,
     * and the cap moves with the window alone. Five sites used to write two of
     * them by hand. A mirror written in five places is the mirror that drifts.
     */
    expect(CODE).toContain('function mirrorInterfaceSize()');
    const start = at('function mirrorInterfaceSize()');
    const body = CODE.slice(start, CODE.indexOf('\n  }\n', start));
    expect(body).toContain('liveUiScale = renderer.uiScale()');
    expect(body).toContain('liveUiScalePercent = renderer.uiScalePercent()');
    expect(body).toContain('liveUiScaleFixed = renderer.uiScaleFixed()');
    // AND NOBODY ELSE WRITES THEM. A second `= renderer.uiScaleFixed()` is the
    // drift this helper exists to prevent, so the ASSIGNMENT is counted rather
    // than the declaration -- `let liveUiScaleFixed = false` is the opening
    // value and not a writer.
    expect(CODE.split('liveUiScaleFixed = renderer').length - 1, 'a second writer').toBe(1);
    expect(CODE.split('liveUiScalePercent = renderer').length - 1).toBe(1);
    expect(CODE.split('liveUiScale = renderer').length - 1).toBe(1);
  });

  it('hands the menu both the step and the percentage, not one derived from the other', () => {
    // The step decides which arrow is greyed; the percentage is what the
    // renderer settled on. Computing one from the other in main.ts would be a
    // second opinion about a clamp that belongs to `setUiScale`.
    expect(CODE).toContain('escapeMenuView(liveUiScale, liveUiScalePercent)');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND NO HALF OF THE ZOOM SURVIVES ANYWHERE IN main.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * *"remove the (zoom) option"* took a menu row, two key bindings, the mouse
 * wheel, a wire verb and a stored preference. `check:inert` catches a dead
 * EXPORT; none of these was one. This is the scrape that catches the rest, and
 * it is a source-text test on purpose: the failure it guards against is a
 * surviving CALLER, which no type would complain about once the symbol is back.
 */
describe('the zoom is gone from the client, in every half it had', () => {
  it('has no renderer zoom call left', () => {
    for (const dead of [
      'renderer.setZoom',
      'renderer.zoom()',
      'renderer.zoomFixed',
      'applyZoom',
      'liveZoom',
      'storedZoom',
    ]) {
      expect(CODE, `main.ts still calls ${dead}`).not.toContain(dead);
    }
  });

  it('sends no set_zoom frame and reads no zoom field off settings', () => {
    expect(CODE).not.toContain("t: 'set_zoom'");
    expect(CODE).not.toContain('msg.zoom');
  });

  it('names no zoom UI command', () => {
    expect(CODE).not.toContain('UiCommand.ZoomIn');
    expect(CODE).not.toContain('UiCommand.ZoomOut');
  });

  it('keeps the interface step, which is a different control', () => {
    // THE HALF THAT STOPS THE ABOVE PASSING BY DELETING THE WRONG THING.
    // `hudScale` was split from the map's magnification on purpose
    // (test/client/hudscale.test.ts), and the surviving half is the one a player
    // asked for.
    expect(CODE).toContain("t: 'set_ui_scale'");
    expect(CODE).toContain('renderer.setUiScale(');
  });
});

describe('reset-panels puts all four back', () => {
  /**
   * ui/escapemenu.ts tests the ROW. This pins the act — and the thing that
   * matters about it is that it cannot leave a panel behind.
   */
  it('walks DRAGGABLE_PANELS rather than naming them', () => {
    /**
     * `createPanelOffsets` walks the same list for the same reason: a fifth
     * draggable panel must not be able to appear with no way to reset it. A
     * hand-written four would be a list to keep in step with a list.
     */
    const start = at("case 'reset-panels':");
    const arm = CODE.slice(start, CODE.indexOf("      case 'ui-scale': {", start));
    /**
     * ═══ TWO WHOLE STATEMENTS, BECAUSE TWO PREFIXES WERE SATISFIED BY ONE ═══
     * This asserted `toContain('for (const panel of DRAGGABLE_PANELS)')` and
     * `toContain('panelOffsets[panel] = NO_OFFSET')` — two assertions that a
     * mutant satisfied with two DIFFERENT statements. Narrowing the offsets loop
     * to `DRAGGABLE_PANELS.filter((p) => p !== DraggablePanel.Menu)` left the
     * first string in the SIZES loop below it and the second in the mutated
     * line's own tail, and the whole suite passed while a dragged Journal stayed
     * dragged under a row that had just said "panels put back". The membership
     * test further down could not see it either: `DRAGGABLE_PANELS` still
     * CONTAINED the menu. That is `membership-is-not-a-rank` twice in one arm.
     */
    expect(arm).toContain('for (const panel of DRAGGABLE_PANELS) panelOffsets[panel] = NO_OFFSET;');
    expect(arm).toContain('for (const panel of DRAGGABLE_PANELS) panelSizes[panel] = null;');
    // ...AND NEITHER LIST IS NARROWED ON ITS WAY INTO THE LOOP.
    expect(arm).not.toMatch(/DRAGGABLE_PANELS\s*\./);
  });

  it('leaves the menu open and says something happened', () => {
    // A control that resets four panels the player cannot see behind the menu
    // and then says nothing is indistinguishable from a dead row.
    const start = at("case 'reset-panels':");
    const arm = CODE.slice(start, CODE.indexOf("      case 'ui-scale': {", start));
    expect(arm).toContain('showNotice(');
    expect(arm).not.toContain('closeMenu()');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BAR'S SLOT COUNT IS PART OF THE ACT, BECAUSE IT IS A SIZE.
   * ═══════════════════════════════════════════════════════════════════════════
   * The sizes loop above puts `panelSizes[Hotbar]` back to null, and on its own
   * that does NOTHING a player can see: `hotbarPanelSize` re-derives the bar's
   * rect from `hotbarStyle.slots`, so an eighteen-slot bar with no stored size
   * is still an eighteen-slot bar. The one panel somebody resized with a GRIP
   * would be the one panel this row failed to put back, under a notice reading
   * "panels put back".
   */
  it('puts the action bar back to the width it ships with', () => {
    const start = at("case 'reset-panels':");
    const arm = CODE.slice(start, CODE.indexOf("      case 'ui-scale': {", start));
    expect(arm).toContain('hotbarStyle = { ...hotbarStyle, slots: DEFAULT_HOTBAR_STYLE.slots };');
    // THE SHIPPED COUNT AND NOT A LITERAL. A hard-coded thirteen here would go
    // stale the day the default moves and would reset the bar to a width
    // nothing else in the client agrees is the default.
    expect(arm).not.toMatch(/slots:\s*\d/);
    // AND ONLY THAT FIELD. `vertical`, `icon` and `opacity` are cogwheel
    // preferences of the same kind as the Case Log's font, which this row has
    // never claimed to reset; a whole-style assignment would take away choices
    // nobody made with a gesture.
    expect(arm).not.toContain('hotbarStyle = DEFAULT_HOTBAR_STYLE');
    // ...AND IT IS SAVED, or the reset is undone by the next reload.
    expect(arm.indexOf('savePanelLayout()')).toBeGreaterThan(arm.indexOf('hotbarStyle ='));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PREDICATE AND THE EFFECT ARE ONE LIST, OR THE ROW LIES ABOUT ITSELF.
   * ═══════════════════════════════════════════════════════════════════════════
   * This asserted `toContain('panelsMoved: DRAGGABLE_PANELS.some(')` — and that
   * WAS the bug it was pinning in place. `.some` over the offsets was the whole
   * predicate while the arm above had grown to clear every size and now the
   * bar's count, so a player who had only ever used a GRIP was shown a grey row
   * captioned "nothing has been moved" over a screen they had plainly changed,
   * with the one control that would put it back refusing to act. That is
   * `membership-is-not-a-rank`: a `.some` over one of three stores is a
   * membership test that has forgotten two of them.
   *
   * WHAT IS PINNED NOW IS THAT THERE IS NO SECOND COPY. `panelsTouched`
   * (ui/drag.ts, driven for real in test/client/drag.test.ts) is the list, and
   * the assertion below is that the view asks it rather than re-deriving
   * anything — an inline predicate is exactly what shipped wrong twice.
   */
  it('greys the row from the same list the row would clear', () => {
    expect(CODE).toContain('panelsMoved: panelsTouched(layoutState()),');
    // NOT A FLAG KEPT BESIDE THE STORES, which is a second copy of the same
    // fact and the one that goes stale; and not a second `.some` anywhere.
    expect(CODE).not.toMatch(/panelsMoved:\s*DRAGGABLE_PANELS/);
    expect(CODE).not.toMatch(/let panelsDirty|panelsHaveMoved/);
    // AND `layoutState` READS THE LIVE STORES rather than a captured object: a
    // value built once at boot would answer for the bar somebody had before
    // they touched it, which is the failure this predicate exists to fix.
    const fn = fnBody('function layoutState(): PanelLayoutState {');
    expect(fn).toContain('offsets: panelOffsets,');
    expect(fn).toContain('sizes: panelSizes,');
    expect(fn).toContain(
      'hotbarSlots: { at: hotbarStyle.slots, shipped: DEFAULT_HOTBAR_STYLE.slots }',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. THE ARROWS, WHICH MOVEMENT NO LONGER OWNS
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `onNavigate` IS `onMove` WITH THE SERVER CUT OFF, AND THAT IS STRUCTURAL.
 * ═══════════════════════════════════════════════════════════════════════════
 * Ruled: *"i want to remove the other directional keys from the keyboard"*. The
 * arrows left `move_*`'s frozen floor and landed on a handler that steers
 * SELECTIONS. The two handlers carry the same `Dir`, so the only thing making
 * "an arrow does not move the body" true is that this one contains no send —
 * and that is a property of a function body, which is what this file asserts.
 */
describe('the arrow-key lane', () => {
  /** `onNavigate`'s body, from its opening line to the handler after it. */
  function navBody(): string {
    const start = at('onNavigate: (dir) => {');
    return CODE.slice(start, CODE.indexOf('onTab:', start));
  }

  it('sends no move and no revive from its own body', () => {
    const body = navBody();
    // The two verbs `onMove` ends with. A `move` frame here is the ruling
    // reversed; a `revive` frame is the two-stage verb being completed by a key
    // that cannot answer its prompt.
    expect(body).not.toContain("t: 'move'");
    expect(body).not.toContain("t: 'revive'");
    expect(body).not.toContain('reviveArmed = false');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE SAME OF EVERYTHING IT CALLS, WHICH IS THE PROPERTY THAT MATTERS.
   * ═══════════════════════════════════════════════════════════════════════════
   * This block used to assert `expect(body).not.toContain('socket.send')` and
   * call that "sends NOTHING to the server". Review measured the CALL SET
   * instead of the text and the claim was false one call deep: Left or Right
   * with the UI SIZE row lit goes `onNavigate` -> `moveMenuSelection` ->
   * `runMenuEffect({kind:'ui-scale'})` -> `applyUiScale` -> `set_ui_scale`. That
   * frame is wanted — it is how the keyboard reaches a setting the pointer
   * already reaches — so the CLAIM was wrong, not the code.
   *
   * The guarantee anybody actually cares about is "an arrow never moves the
   * body", and four `not.toContain`s over one function body cannot see a
   * `{t:'move'}` in a callee. So this walks the transitive callee set from
   * `onNavigate` and asserts it of every function in it: memory
   * `test-the-join-not-the-halves`, applied to a scrape.
   */
  it('reaches no move frame through ANY function it calls, however deep', () => {
    /**
     * A REAL BODY, MATCHED BY BRACES. A slice "to the next line starting with
     * `}`" is worthless in this file — almost every handler lives inside
     * `boot`'s closure, so such a slice runs to the end of the closure and
     * swallows `onMove` itself. Strings and comments are skipped because a brace
     * inside either is not a brace.
     */
    function bodyFrom(open: number): string {
      let depth = 0;
      let i = open;
      while (i < CODE.length) {
        const ch = CODE[i];
        const two = CODE.slice(i, i + 2);
        if (two === '//') {
          i = CODE.indexOf('\n', i);
          if (i === -1) break;
          continue;
        }
        if (two === '/*') {
          const close = CODE.indexOf('*/', i + 2);
          i = close === -1 ? CODE.length : close + 2;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          i += 1;
          while (i < CODE.length && CODE[i] !== ch) i += CODE[i] === '\\' ? 2 : 1;
          i += 1;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return CODE.slice(open, i + 1);
        }
        i += 1;
      }
      throw new Error('unbalanced braces from ' + String(open));
    }

    /** Every named function in the file, by name, with its real body. */
    const bodies = new Map<string, string>();
    const decl =
      /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)[^{=]*=>\s*\{|^\s{4}([A-Za-z_$][\w$]*)\s*:\s*\([^)]*\)\s*=>\s*\{)/gm;
    for (let m = decl.exec(CODE); m !== null; m = decl.exec(CODE)) {
      const name = m[1] ?? m[2] ?? m[3];
      if (name === undefined) continue;
      const open = CODE.indexOf('{', m.index + m[0].length - 1);
      if (open === -1) continue;
      if (!bodies.has(name)) bodies.set(name, bodyFrom(open));
    }
    bodies.set('onNavigate', navBody());

    // THE EXTRACTOR IS ITSELF CHECKED, or a regex that matched nothing would
    // make every assertion below vacuous.
    expect(bodies.get('onMove')).toContain("t: 'move'");
    expect(bodies.get('moveMenuSelection')).not.toContain("t: 'move'");

    const seen = new Set<string>(['onNavigate']);
    const queue = ['onNavigate'];
    const visited: string[] = [];
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined) continue;
      const body = bodies.get(name);
      if (body === undefined) continue;
      visited.push(name);
      // THE ASSERTION, on every body in the transitive set.
      expect(`${name} sends a move frame: ${String(body.includes("t: 'move'"))}`).toBe(
        `${name} sends a move frame: false`,
      );
      const calls = /([A-Za-z_$][\w$]*)\s*\(/g;
      for (let c = calls.exec(body); c !== null; c = calls.exec(body)) {
        const callee = c[1];
        if (callee === undefined || seen.has(callee) || !bodies.has(callee)) continue;
        seen.add(callee);
        queue.push(callee);
      }
    }
    // THE WALK ACTUALLY WALKED, and it reached the callee that DOES send a frame
    // — `applyUiScale` by way of `runMenuEffect` — which is the one this test
    // exists to have looked at and passed.
    expect(visited).toContain('moveMenuSelection');
    expect(visited).toContain('runMenuEffect');
    expect(visited.length).toBeGreaterThan(8);
    // ...and it never reached `onMove`, which is the shortest statement of the
    // whole property.
    expect(visited).not.toContain('onMove');
  });

  it('routes to the same surfaces in the same order as onMove', () => {
    // A DIFFERENT ORDER IS A DIFFERENT GAME depending on which hand you used.
    // Both chains put the two undismissible screens first, the conversation
    // above the menu and the menu above targeting; `onMove` alone continues past
    // them to the body.
    const body = navBody();
    const order = [
      'roster !== null',
      'classOptions !== null',
      'dialogueView !== null',
      'menuOpen && !reviveArmed',
      'targeting !== null && targeting.active()',
      // AND THE LOG LAST, which is the ordering argument in one line: the panel
      // is open almost always, so a branch any higher would take the arrows
      // away from every surface under it.
      'hudLayout(navW, navH).log',
    ];
    let cursor = -1;
    for (const gate of order) {
      const found = body.indexOf(gate);
      expect(found).toBeGreaterThan(cursor);
      cursor = found;
    }
  });

  it('keeps the revive arm gate, so neither hand answers a prompt the other cannot', () => {
    // `onMove` lets a direction fall PAST an open menu while a revive is armed,
    // because the key is answering "press a direction". An arrow can never reach
    // that frame, so if it took the menu selection instead the same prompt would
    // mean two things. The identical gate is the honest answer.
    expect(navBody()).toContain('menuOpen && !reviveArmed');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOG WAS THE THIRD THING THE RULING NAMED AND THE ONLY ONE LEFT OUT.
   * ═══════════════════════════════════════════════════════════════════════════
   * *"the arrow keys come OUT of movement's `fixed` list so they are free for
   * the dialogue window's selection, the log and menus"*. Two of the three were
   * wired. With nothing else open all four arrows fell off the end of this chain
   * doing nothing, in front of a panel that had just grown a three-tab strip
   * with no keyboard route at all.
   */
  it('gives the log the arrows when nothing else wants them', () => {
    const body = navBody();
    // THE RECT, NOT THE FLAG: `logVisible` is true on a viewport too narrow to
    // dock the panel, and a key that scrolled a box nobody can see is worse than
    // a key that does nothing.
    // THE WHOLE GATE, not its parts: `if (false && logRect !== null ...)` keeps
    // every string below it and would otherwise pass while the branch is dead.
    expect(body).toContain('const logRect = hudLayout(navW, navH).log;');
    expect(body).toContain('if (logRect !== null && caseLog !== null) {');
    expect(body).not.toContain('if (logVisible)');
    // VERTICAL SCROLLS, HORIZONTAL TURNS THE TAB.
    expect(body).toContain('caseLog.scroll(delta.y < 0 ? SCROLL_STEP : -SCROLL_STEP);');
    expect(body).toContain('LOG_TABS.indexOf(caseLog.activeTab())');
    expect(body).toContain('caseLog.selectTab(next)');
    // ONE STEP SIZE FOR THE PANEL, shared with `onScroll` — two would be two
    // opinions about how far "down" is.
    expect(body).not.toMatch(/scroll\(\s*\d/);
    // CLAMPED, NOT WRAPPED: a row of three buttons has ends.
    expect(body).toContain('Math.min(Math.max(0, at + delta.x), LOG_TABS.length - 1)');
    expect(body).not.toContain('% LOG_TABS.length');
  });

  it('is handed to bindGameKeys, not merely declared', () => {
    // The handler is optional, so a declaration that never reached the call site
    // would compile, pass every unit test in keys.test.ts, and leave the arrows
    // doing nothing in the actual game.
    const start = at('bindGameKeys(window, {');
    const block = CODE.slice(start, CODE.indexOf('onCommand:', start));
    expect(block).toContain('onNavigate: (dir) => {');
  });
});
// ---------------------------------------------------------------------------
// 8. THE JOURNAL — one screen, two ways in, and the panel it lives inside
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEY AND THE MENU ROW MUST BE ONE ACT, NOT TWO THAT AGREE TODAY.
 * ═══════════════════════════════════════════════════════════════════════════
 * Ruled: *"case notes should actually be 'Journal' which will serve as a quest
 * log/ similar"*, *"we can put journal to the J key"*.
 *
 * `Game.lua:2307-2308` is upstream making exactly this decision the right way:
 * its menu row triggers the VIRTUAL ACTION rather than reimplementing the open.
 * Two routes that each call `showMenuScreen` would pass every test in
 * escapemenu.test.ts and still drift the day one of them learns to close.
 */
describe('the Journal opens by one route, from the key and from the row', () => {
  /** `showJournal`'s body, from its opening line to the function after it. */
  function journalBody(): string {
    const start = at('function showJournal(): void {');
    return CODE.slice(start, CODE.indexOf('function showMenuScreen(', start));
  }

  it('is reached from the menu row and from the UI verb, and by nothing else', () => {
    // BOTH ARMS CALL THE SAME FUNCTION. If either one reached
    // `showMenuScreen(MenuScreen.Journal)` directly it would be a second opener,
    // and the first thing to go wrong is the toggle: `j` would close a Journal
    // the row could only ever open.
    const row = CODE.slice(at("case 'journal':"), at("      case 'note':"));
    expect(row).toContain('showJournal()');
    expect(row).not.toContain('showMenuScreen(');

    const verb = CODE.slice(at('case UiCommand.ShowJournal:'), at('case UiCommand.ToggleLog:'));
    expect(verb).toContain('showJournal()');
    expect(verb).not.toContain('showMenuScreen(');

    // ...AND `showJournal` IS THE ONLY PLACE THE SCREEN IS NAMED AT ALL. Three
    // matches, all three inside it: the `if` that recognises it is already up,
    // the swap for a menu open on another screen, and the open from closed. A
    // fourth is a second opener somewhere else in the file.
    expect(CODE.match(/MenuScreen\.Journal/g) ?? []).toHaveLength(3);
    expect(journalBody().match(/MenuScreen\.Journal/g) ?? []).toHaveLength(3);
  });

  it('toggles: the same key that opened it puts it away', () => {
    // `UiCommand.ShowSheet`'s note is the argument in full — nothing in
    // `onCancel`'s chain backs out of a menu SCREEN, so the key that opened it
    // is the key that has to close it. A `j` that only opened would be the one
    // screen key in this client needing a different key to shut it.
    const body = journalBody();
    expect(body).toContain('menuOpen && menuScreen === MenuScreen.Journal');
    expect(body).toContain('closeMenu()');
  });

  it('swaps screens without closing when the menu is already up on another one', () => {
    // THE MIDDLE STATE IS THE MENU ROW'S OWN. Pressing `JOURNAL` on the root
    // must not close the menu and reopen it — that is a flicker and a lost
    // `menuPage` — so the open-on-something-else case swaps rather than reopens.
    const body = journalBody();
    const swap = body.indexOf('showMenuScreen(MenuScreen.Journal)');
    const open = body.indexOf('openMenu(MenuScreen.Journal)');
    expect(swap).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(swap);
  });

  it('opens folded, every time', () => {
    // `openNoteId` is cleared on the way IN rather than on the way out, so a
    // Journal reopened after a session that ended mid-note is still a list
    // first — `showMenuScreen`'s own rule for the arm, one level up.
    expect(journalBody()).toContain('openNoteId = null');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOURNAL IS THE MENU PANEL. That is what makes RESET PANELS honest.
 * ═══════════════════════════════════════════════════════════════════════════
 * `RESET PANELS` and `panelsMoved` both walk `DRAGGABLE_PANELS` (section 6
 * above pins both). So the whole of "the Journal drags, and the row that puts
 * panels back puts it back" is: the Journal has NO rect of its own, it is drawn
 * in `layout.menu`, and `layout.menu` is a `DraggablePanel.Menu` that is in that
 * list. A Journal with its own geometry would be a panel the row silently
 * skipped while still claiming to have put everything back —
 * `membership-is-not-a-rank`.
 */
describe('the Journal drags with the menu, and RESET PANELS covers it', () => {
  it('is a member of the list both the reset and the predicate walk', () => {
    // THE REAL LIST, IMPORTED — not a string in main.ts. This is the membership
    // assertion, and it is the one that fails if somebody splits the Journal out
    // into a panel of its own without adding it here.
    expect(DRAGGABLE_PANELS).toContain(DraggablePanel.Menu);
  });

  it('has no rect of its own: one geometry call, one draw call, both the menu', () => {
    // ONE `escapeMenuRect` AND ONE `drawEscapeMenu` IN THE WHOLE FILE. A second
    // of either is how a screen ends up drawn in one place and clicked in
    // another — `escapeMenuRect`'s own docblock — and it is also how the Journal
    // would escape the drag offset without anything else changing.
    expect(CODE.match(/escapeMenuRect\(/g) ?? []).toHaveLength(1);
    expect(CODE.match(/drawEscapeMenu\(/g) ?? []).toHaveLength(1);

    const draw = CODE.slice(at('drawEscapeMenu({'), at('if (layout.hotbar !== null)'));
    expect(draw).toContain('rect: layout.menu');
    expect(draw).toContain('screen: menuScreen');
  });

  it('gets its rect through movePanel, which is where the drag offset is applied', () => {
    // `movePanel` is the ONE copy of "add the offset, clamp into the band"
    // (ui/drag.ts). A rect built without it is a panel that cannot be dragged
    // and that `RESET PANELS` would claim to have reset.
    const start = at('menu: movePanel(');
    expect(CODE.slice(start, start + 240)).toContain('DraggablePanel.Menu');
    // AND THE SCREEN AND THE ROWS ARE PASSED THROUGH, so the hit test and the
    // painter agree about the size of whichever screen is up — including the
    // Journal, whose size is a function of what is IN it.
    //
    // WAS `toContain('escapeMenuRect({ ...options, screen: menuScreen })')`.
    expect(CODE).toContain('screen: menuScreen,');
    expect(CODE).toContain(
      'rows: escapeMenuRows(escapeMenuView(liveUiScale, liveUiScalePercent)),',
    );
    // ...and there is still exactly ONE geometry call in the whole client.
    expect(CODE.match(/escapeMenuRect\(/g) ?? []).toHaveLength(1);
  });
});
