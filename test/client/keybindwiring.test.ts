/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { bindGameKeys, createLiveKeymap } from '../../src/client/input/keys.ts';
import { createTravel, TravelStart } from '../../src/client/input/travel.ts';
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
  'onSlot: (slot) => {',
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
    const menuLine = /menu: menuOpen \? escapeMenuRect\(\{([^}]*)\}\) : null/.exec(CODE);
    expect(menuLine, 'hudLayout still derives `menu`').not.toBeNull();
    const args = menuLine?.[1] ?? '';
    expect(args).toContain('top: band.top');
    expect(args).toContain('bottom: band.bottom');

    // ...and the picker, one line below it, still is not derived that way — so
    // this test fails if somebody makes the two the same in EITHER direction.
    expect(CODE).toContain('picker: classOptions === null ? null : classPickerRect(width, height)');
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
      'commit',
      'drop',
      'equip',
      'hold',
      'inspect',
      'move',
      'party',
      'pickup',
      'point',
      'respawn',
      'revive',
      'say',
      'set_keybinds',
      'spend_point',
      'talent',
      'unequip',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. THE ESCAPE CHAIN — BOTH ENDS
// ---------------------------------------------------------------------------

describe('the Escape chain gained three head links and one tail link', () => {
  const body = handlerBody('onCancel: () => {');

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
    // revive and both log lanes keep their existing order, and
    // travelwiring.test.ts's interrupt (3) still describes where it sits.
    const token = at('if (tokenMenu?.close() === true) return;', body);
    const travel = at('if (cancelTravelIfActive()) return;', body);
    const targeting = at('if (targeting !== null && targeting.active()) {', body);
    const revive = at('if (reviveArmed) {', body);
    const lanes = at('const record = caseLog?.toBottom(LogLane.Record) ?? false;', body);
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
    expect(body).not.toContain('if (!record && !margin) clearNotice();');

    const guard = at('if (record || margin) return;', body);
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

    // ...and the commit that would otherwise go out is BELOW the gate, so a lit
    // row genuinely wins the press.
    expect(at('pressMenuSelection()', command)).toBeLessThan(
      at("socket.send({ v: PROTOCOL_VERSION, t: 'commit' });", command),
    );
  });

  it('NEVER swallows Hold or Pickup, and lets an unlit Enter through to the commit', () => {
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

    // All three verbs still reach the socket below it, unconditionally.
    expect(command).toContain("socket.send({ v: PROTOCOL_VERSION, t: 'commit' });");
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
    const body = handlerBody('onSlot: (slot) => {');
    expect(body).toContain('if (menuOpen) closeMenu();');
    expect(body).toContain('activateSlot(slot);');
    // NOT A REFUSAL: no early return anywhere between the picker gate and the
    // activation, so the digit always reaches a talent.
    expect(at('if (menuOpen) closeMenu();', body)).toBeLessThan(at('activateSlot(slot);', body));
    expect(body).not.toMatch(/if \(menuOpen\) return;/);
    // The reason is written where the refusal would have gone, so the next pass
    // reads it before adding one.
    const commented = SOURCE.slice(
      SOURCE.indexOf('onSlot: (slot) => {'),
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

  it('guards the wheel against the menu, as an occlusion guard', () => {
    const start = at("'wheel',");
    const body = CODE.slice(start, CODE.indexOf('{ passive: false }', start));
    expect(body).toContain('if (inRect(wheelLayout.menu, point.x, point.y)) return;');
    // MIRRORING PAINT ORDER: the menu is painted over all three, so it is tested
    // before all three.
    expect(at('wheelLayout.menu', body)).toBeLessThan(at('wheelLayout.sheet', body));
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
    const guards = [...mousedown.matchAll(/!inRect\(layout\.menu, point\.x, point\.y\)/g)];
    // The inventory block, the talent block, the sheet block and the party pane.
    expect(guards.length).toBeGreaterThanOrEqual(4);

    // ...and the right-click branch treats it as occlusion over the party pane
    // too, which is where DECLINE lives.
    expect(mousedown).toContain('inRect(layout.menu, point.x, point.y);');
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
    // `respawnPromptRect` is 304x48 at `top + (band-48)/3` and `escapeMenuRect`
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
    expect(CODE).toContain('selfErased() && !menuOpen');
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
    expect(body).toContain('setKeymap(msg.binds);');
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
