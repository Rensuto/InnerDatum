import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HUD'S WIRING CONTRACT — src/client/main.ts, v12
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS FILE READS SOURCE RATHER THAN IMPORTING IT ═══
 * The identical constraint test/client/keybindwiring.test.ts:19-24 and
 * test/client/travelwiring.test.ts:26-34 both state, and it has not changed:
 * main.ts calls `boot()` at module load, which reaches for
 * `document.getElementById`, the Discord SDK and a WebSocket, and
 * vitest.config.ts is emphatic that the environment is `node` with deliberately
 * no jsdom. There is no way to assert anything about that file by importing it.
 *
 * ═══ WHAT THIS FILE IS FOR, AND WHY IT IS NOT keybindwiring.test.ts ═══
 * That file pins the ESCAPE MENU's wiring. This one pins the four properties the
 * v12 drag depends on, and every one of them is a property no unit test can
 * reach because the rule is WHERE a line sits rather than what a function
 * returns:
 *
 *   A DRAG THAT CANNOT LATCH.  Move and release are on `window`. On the canvas
 *                              they would freeze the instant the pointer crossed
 *                              onto `#cmdrow` (canvas `mouseleave` clears the
 *                              pointer state) and a release outside the canvas
 *                              would never arrive at all — leaving a panel
 *                              welded to a cursor with no button held.
 *   A DRAG THAT COSTS NOTHING. The canvas `mousemove` handler short-circuits, or
 *                              a gesture rebuilds the whole doll, the whole bag
 *                              and twenty-six menu rows per pointer event and
 *                              spends the socket's token bucket on hovering.
 *   A DRAG THAT WALKS NOBODY.  `overPanel` answers true for the whole screen
 *                              while one is live, or a release over bare map
 *                              falls into the travel branch and the party runs.
 *   A PANEL THAT STAYS A PANEL. All four movable rects go through `moveIntoBand`
 *                              against `panelBand`, and the seven that are not
 *                              movable go through nothing.
 *
 * ═══ THE LINE THIS FILE DOES NOT CROSS ═══
 * ANY RULE THAT CAN BE ASSERTED WITHOUT READING SOURCE BELONGS IN A PURE MODULE.
 * The clamp, the 6-pixel threshold, the offset composition and the closed set of
 * draggable panels all live in src/client/ui/drag.ts and are covered by
 * test/client/drag.test.ts; the four panels' handles live in their own modules
 * with their own suites. main.ts is allowed to be wiring and nothing else —
 * which is precisely why its wiring is worth pinning.
 */

const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/**
 * The same file with every comment line removed.
 *
 * ═══ WITHOUT THIS EVERY ASSERTION BELOW IS A LIE WAITING TO HAPPEN ═══
 * keybindwiring.test.ts:56-62 states the reason and it applies word for word
 * here: main.ts is heavily commented by house rule and its comments QUOTE the
 * code they justify. A `SOURCE.includes('if (drag !== null) return;')` would
 * pass against a file whose short-circuit had been deleted and whose comment
 * still described it — green, and asserting the prose.
 *
 * It also matters in the other direction for `localStorage` below: the decision
 * NOT to persist panel positions is argued at length in a comment that names
 * `localStorage` as the mechanism being refused, so the absence assertion has to
 * run against the code or it would fail on its own justification.
 */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

/** Where a snippet sits in the whole file, asserted to exist as it goes. */
function at(snippet: string, within: string = CODE): number {
  const index = within.indexOf(snippet);
  expect(index, `main.ts still contains: ${snippet}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** Everything from `start` up to `end`, both asserted to exist and in order. */
function between(start: string, end: string): string {
  const from = at(start);
  const to = CODE.indexOf(end, from);
  expect(to, `${end} follows ${start}`).toBeGreaterThan(from);
  return CODE.slice(from, to);
}

// ---------------------------------------------------------------------------
// 1. THE DRAG CANNOT LATCH
// ---------------------------------------------------------------------------

describe('the drag ends on window, not on the canvas', () => {
  it('registers mousemove, mouseup and blur on `window`', () => {
    // ═══ THIS IS THE HALF THAT DECIDES WHETHER A PANEL CAN GET STUCK ═══
    // A canvas-driven drag freezes the moment the pointer crosses onto
    // `#cmdrow` — which sits directly under the canvas in the flex column, and
    // is exactly where a pointer goes when somebody drags a panel towards the
    // bottom of the screen — because the canvas `mouseleave` handler clears the
    // pointer state. And a `mouseup` released outside the canvas never fires a
    // canvas listener at all, so the panel would follow a cursor whose button is
    // already up, for as long as the player left the page open.
    expect(CODE).toContain("window.addEventListener('mousemove'");
    expect(CODE).toContain("window.addEventListener('mouseup'");
    // BLUR IS NOT OPTIONAL AND IS THE ONE MOST LIKELY TO BE DROPPED AS
    // BELT-AND-BRACES. Alt-tab, a Discord overlay taking focus, the activity
    // iframe losing it: the browser stops delivering mouse events and the
    // `mouseup` that would have ended the gesture is never seen.
    expect(CODE).toContain("window.addEventListener('blur'");
  });

  it('does NOT register mouseup or blur on the canvas', () => {
    // The negative half, and it is the assertion that survives a refactor: a
    // later pass "tidying the mouse listeners together" onto one element is
    // exactly how this regresses, and nothing about the resulting code would
    // look wrong.
    expect(CODE).not.toContain("canvas.addEventListener('mouseup'");
    expect(CODE).not.toContain("canvas.addEventListener('blur'");
  });

  it('gives the gesture three exits and never captures the pointer', () => {
    // `setPointerCapture` would be the obvious browser primitive for this and it
    // is deliberately not used: capture redirects events to one element until
    // released, so a bug on the release path is a page whose mouse has stopped
    // working entirely. Three ordinary listeners plus the Escape link degrade to
    // "the panel stopped following", which a player can recover from.
    expect(CODE).not.toContain('setPointerCapture');
    // Escape is the third exit, and it is the FIRST link of the cancel chain.
    expect(CODE).toContain('if (cancelDrag()) return;');
    // ...and the two `window` handlers are the other two.
    expect(CODE).toContain('endDrag(event.clientX, event.clientY);');
  });
});

// ---------------------------------------------------------------------------
// 2. THE DRAG COSTS NOTHING PER POINTER EVENT
// ---------------------------------------------------------------------------

describe('a live drag short-circuits the canvas mousemove handler', () => {
  it('returns at the HEAD of the handler, above every hit test', () => {
    // ═══ IT IS NOT A TIDY-UP, IT IS THE SOCKET BUDGET ═══
    // Below this line: `slotUnder` rebuilds the hotbar view,
    // `inventoryPanelRows` rebuilds the whole doll AND the bag,
    // `escapeMenuRows` builds twenty-six rows with four formatted strings each,
    // and `noteHoveredActor` drives a settle-gated `inspect` ON THE WIRE. A drag
    // is the one gesture in this client that fires `mousemove` continuously for
    // a second or more, and `overPanel`'s own note says what an exhausted token
    // bucket costs: the server answers `error`, which this client turns into a
    // refusal AND uses to cancel the player's aim. Somebody dragging the
    // inventory panel would cancel a teammate's shot.
    const handler = between("canvas.addEventListener('mousemove', (event) => {", '});');
    const guard = at('if (drag !== null) return;', handler);
    // ...and it is genuinely FIRST: every one of the expensive calls is below it.
    expect(guard).toBeLessThan(at('const slot = slotUnder(event);', handler));
    // `inventoryRowsFor` IS that call: main.ts routes all six readers through
    // one helper now, so the rows are chunked to the width the panel actually
    // got. The expense is identical — it still rebuilds the doll and the bag.
    expect(guard).toBeLessThan(at('inventoryRowsFor(', handler));
    expect(guard).toBeLessThan(at('noteHoveredActor', handler));
  });

  it('does NOT tear the gesture down when the pointer leaves the canvas', () => {
    // The canvas is one row of a flex column: `#cmdrow` and `#log` sit directly
    // under it, so a pointer dragged towards the bottom of the screen crosses
    // off the canvas WITH THE BUTTON STILL DOWN and fires `mouseleave`. Clearing
    // the gesture there would abandon a drag the player is still making, and the
    // panel would snap back for no stated reason.
    const handler = between("canvas.addEventListener('mouseleave', () => {", '});');
    expect(handler).not.toContain('drag = null');
    expect(handler).not.toContain('cancelDrag()');
  });
});

// ---------------------------------------------------------------------------
// 3. A RELEASE OVER BARE MAP DOES NOT WALK THE PARTY
// ---------------------------------------------------------------------------

describe('overPanel answers true for the whole screen while a drag is live', () => {
  it('has the drag term, above the backbufferPoint guard', () => {
    // The same shape the class picker already takes in this function, and for
    // the same reason: while a gesture owns the pointer there is no tile
    // underneath worth reaching. Without it a release over bare map falls
    // through the swallow at the foot of `mousedown` into the travel branch, and
    // the party walks across the room at the end of every drag — which the
    // player will report as "dragging a window makes everybody run".
    const fn = between('function overPanel(clientX: number, clientY: number): boolean {', '\n  }');
    const guard = at('if (drag !== null) return true;', fn);
    // ABOVE `point === null`: "not on the backbuffer" is not a reason to let a
    // gesture through, which is the identical argument the picker line makes.
    expect(guard).toBeLessThan(at('const point = renderer.backbufferPoint(clientX, clientY);', fn));
    expect(guard).toBeLessThan(at('if (layout.picker !== null) return true;', fn));
  });

  it('keeps travel interrupt (1) and the sweep settle at the top of mousedown', () => {
    // ═══ THE DRAG GUARD MUST NOT HAVE JUMPED THE QUEUE ═══
    // A click that is later swallowed by a panel, by an open menu or by a live
    // gesture STILL means "stop what you are doing" — the player reached for the
    // mouse. These two lines fire for every press whatever else happens, and the
    // v12 abandon-the-gesture guard was placed BELOW them for exactly that
    // reason.
    const handler = between(
      "canvas.addEventListener('mousedown', (event) => {",
      '\n    const point',
    );
    const travel = at('cancelTravel();', handler);
    const settle = at('sweep?.settle();', handler);
    expect(travel).toBeLessThan(settle);
    expect(settle).toBeLessThan(at('if (cancelDrag()) {', handler));
  });
});

// ---------------------------------------------------------------------------
// 4. FOUR PANELS MOVE. SEVEN DO NOT.
// ---------------------------------------------------------------------------

describe('hudLayout clamps exactly the four movable panels into the band', () => {
  it('has exactly ONE call to moveIntoBand, inside movePanel', () => {
    // ═══ ONE CLAMP, THE WAY ui/drag.ts DEMANDS ═══
    // "There is exactly ONE copy of this and it is this one" is that module's
    // own claim about `moveIntoBand`; this is the caller's half of it. A second
    // call site is how a panel ends up drawn in one place and clicked in
    // another, and the bug only shows up on somebody else's window size.
    const calls = CODE.split('moveIntoBand(').length - 1;
    expect(calls, 'moveIntoBand is called exactly once').toBe(1);
    const fn = between('function movePanel(', '\n}');
    expect(fn).toContain('moveIntoBand(rect, panelOffsets[panel], band, width)');
    // THE BAND, NOT THE VIEWPORT. A viewport clamp would let a player park the
    // escape menu over the hotbar and hide the four talent keys while it was up
    // — the panel-not-modal promise broken by a gesture rather than by a code
    // change, which no review catches because no line of code changed to cause
    // it.
    expect(fn).toContain('band: { readonly top: number; readonly bottom: number }');
  });

  it('routes all four dock rects through movePanel', () => {
    const layout = between('function hudLayout(width: number, height: number): HudLayout {', '\n}');
    for (const [field, panel] of [
      ['sheet', 'DraggablePanel.Sheet'],
      ['talents', 'DraggablePanel.Talents'],
      ['inventory', 'DraggablePanel.Inventory'],
      ['menu', 'DraggablePanel.Menu'],
    ] as const) {
      const start = at(`${field}: movePanel(`, layout);
      // TO THE CALL'S OWN CLOSING PAREN, which is the one at this indentation.
      // `indexOf('),')` was close enough while the rect was built inline, and
      // stopped short the moment the second argument became a CALL that also
      // ends in `),` — leaving a slice with the panel name in it and no `band`,
      // which is a test that fails for a formatting change and would equally
      // have passed for a real one.
      const call = layout.slice(start, layout.indexOf('\n    ),', start));
      expect(call, `${field} names its own panel`).toContain(panel);
      // ...and is handed the same `band` every other rect in this function is
      // measured against, rather than a second computation of it.
      expect(call, `${field} is clamped into band`).toContain('band,');
    }
  });

  it('routes NONE of picker, pane, log or respawn through it', () => {
    // ═══ EVERY ONE OF THESE IS A DECISION, NOT AN OMISSION ═══
    // ui/drag.ts's `DraggablePanel` records a reason each. The picker is a
    // scrimmed full-viewport MODAL whose rect is not band-derived at all, so
    // `moveIntoBand` does not even describe it. The pane and the log are two
    // halves of one `rightReserved` handshake — a free-floating pane would still
    // shrink itself to protect a strip of map it was no longer sitting next to.
    // The erased plate says one thing, offers one key, and already stands down
    // entirely under the escape menu.
    const layout = between('function hudLayout(width: number, height: number): HudLayout {', '\n}');
    for (const field of ['picker:', 'pane,', 'log,', 'respawn:'] as const) {
      const start = at(field, layout);
      const line = layout.slice(start, layout.indexOf('\n', start));
      expect(line, `${field} is not moved`).not.toContain('movePanel');
    }
    // Stated positively as well, so a rename of `movePanel` cannot make the four
    // assertions above vacuous while these four still pass.
    //
    // A SHAPE, NOT A LITERAL. This pinned the call verbatim and broke when the
    // modal's width cap started counting the classes it is about to draw — a
    // failure about an argument list rather than about the claim. The claim is
    // that the picker comes straight from the viewport.
    expect(layout).toMatch(
      /picker: classOptions === null \? null : classPickerRect\(width, height[^)]*\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE XP TRACK SHARES THE RESOURCE STRIP
// ---------------------------------------------------------------------------

describe('the level badge and the xp track are drawn on the resource strip', () => {
  it('shares one measured strip with the life readout and the pips', () => {
    /**
     * ═══ THE SHARED BOX IS THE WHOLE POINT ═══
     * THREE widgets live on this 18-pixel row and none of them measures another:
     * life is a fixed `LIFE_W` at the left, the pips are left-aligned in what is
     * left of the box (ui/resource.ts:70-74), and ui/xpbar.ts right-aligns itself
     * inside the FULL box — so it takes the empty end without needing to know how
     * much the two on the left used. Handing any of them a different box is how
     * they start overlapping on narrow windows only.
     *
     * ASSERTED AS THE ARITHMETIC RATHER THAN AS A LITERAL LINE. This test used
     * to pin `drawResource({ ctx, sprites, resource, x: 4, … });` verbatim and
     * broke on the reformat that added the third widget, which is a test failing
     * on whitespace rather than on the claim it is making.
     */
    const strip = between('const resourceY =', 'const hint =');
    // Life first, at the left edge.
    expect(strip).toMatch(/drawLife\(\{[\s\S]*?x: 4,/);
    // Pips after it, in what is left.
    expect(strip).toMatch(
      /drawResource\(\{[\s\S]*?x: 4 \+ LIFE_W,[\s\S]*?width: width - 8 - LIFE_W,/,
    );
    // XP right-aligned inside the FULL box — deliberately NOT offset, because it
    // aligns from the far end and offsetting it would move it left by 88px.
    expect(strip).toContain(
      'drawXpBar({ ctx, progress, x: 4, y: resourceY + 3, width: width - 8 });',
    );
    // ...and all of them inside the same measured strip, not at a hand-copied y.
    expect(CODE).toContain('const resourceY = height - HOTBAR_TOTAL_H - RESOURCE_H;');
  });

  it('routes the level-up through onGoodNews and not through onRefusal', () => {
    // The single best piece of news in the game used to arrive through a hook
    // spelled `onRefusal`, beside "too close", "not your turn yet" and "not
    // connected — that did not go out". Same timer, same line, different name.
    const block = between("case 'progress':", "case 'cooldowns':");
    expect(block).toContain('onGoodNews(');
    expect(block).not.toContain('onRefusal(');
    // ...and it is ONE sentence rather than an `else if`, because crossing a
    // level and gaining a point is the common case: `src/shared/progression.ts`
    // grants a point on every level, so the old chain printed the level and
    // never the count on nearly every frame this branch fired on.
    expect(block).toContain('if (levelled || gained) {');
  });
});

// ---------------------------------------------------------------------------
// 6. THE COMMAND LINE'S FUNCTIONAL GATE SURVIVED THE CSS CHANGE
// ---------------------------------------------------------------------------

describe('setCommandLineReachable still does all four things', () => {
  it('sets disabled, tabIndex = -1, blur() and the hidden attribute', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE CSS NOW DUPLICATES PART OF THIS, AND THAT IS WHY THE TEST EXISTS.
    // ═══════════════════════════════════════════════════════════════════════
    // `#cmdrow[hidden]` became `visibility: hidden` so that hiding the row stops
    // reflowing the flex column and resizing the canvas under the player. Per
    // spec a `visibility: hidden` subtree is not a focusable area, so the
    // stylesheet now also removes `#cmd` from the tab order, from the
    // accessibility tree and from pointer events — and the predictable next move
    // is to conclude the TypeScript is redundant.
    //
    // IT IS NOT. These four run in a build whose stylesheet failed to load, and
    // `blur()` in particular covers what no declaration can: the field that was
    // ALREADY focused when the `class_options` frame arrived — a player who was
    // mid-sentence when they were asked to pick a class.
    const fn = between('function setCommandLineReachable(reachable: boolean): void {', '\n}');
    expect(fn).toContain('cmdEl.disabled = !reachable;');
    expect(fn).toContain('cmdEl.tabIndex = reachable ? 0 : -1;');
    expect(fn).toContain('if (!reachable) cmdEl.blur();');
    expect(fn).toContain("cmdRowEl?.toggleAttribute('hidden', !reachable);");
  });
});

// ---------------------------------------------------------------------------
// 7. NOTHING IS PERSISTED IN THE BROWSER
// ---------------------------------------------------------------------------

describe('panel offsets and hotbar bindings are session-local', () => {
  it('uses no browser storage anywhere in main.ts', () => {
    // ═══ THE DECISION, MECHANISED ═══
    // DECISIONS.md D14 and D16: a dragged panel's position and a bound hotbar
    // slot are forgotten on reload, exactly like `logVisible` and `partyVisible`
    // two lines from where they live. Persisting either needs one of two
    // mechanisms and both are worse than forgetting — a new client intent, a new
    // unicast echo, a new optional save field and a new validator, or a SECOND
    // persistence mechanism competing with the save file in a client that has
    // none at all (net/socket.ts:16 says the auth token is memory-only).
    //
    // AGAINST `CODE` AND NOT `SOURCE`: the decision is argued at length in a
    // comment that NAMES `localStorage` as the mechanism being refused, so this
    // assertion would otherwise fail on its own justification.
    expect(CODE).not.toContain('localStorage');
    expect(CODE).not.toContain('sessionStorage');
    expect(CODE).not.toContain('indexedDB');
    // ...and the two stores really are module-scope client state.
    expect(CODE).toContain(
      'const panelOffsets: Record<DraggablePanel, PanelOffset> = createPanelOffsets();',
    );
    expect(CODE).toContain('const hotbarBindings: (ItemBinding | null)[]');
  });
});

// ---------------------------------------------------------------------------
// 8. THE BAR IS HIT-TESTED AT THE LENGTH IT IS DRAWN AT
// ---------------------------------------------------------------------------

describe('slotUnder asks the view how many slots there are', () => {
  it('passes `hotbarView().slots.length`, never `loadout.length`', () => {
    // ═══ THIS WAS A SILENT, EVERY-VIEWPORT BUG WAITING FOR THE ITEM SLOTS ═══
    // `hotbarSlotAt` centres the row on the count it is GIVEN, exactly as
    // `drawHotbar` centres it on the slots it is given. `loadout.length` was
    // correct only while the view returned four slots; the moment it returned
    // eight the painter centred a 604-pixel row and the hit test centred a
    // 300-pixel one, so every hover and every click landed on the wrong box or
    // on nothing — at every viewport, with no line of ui/hotbar.ts having
    // changed. There is one number, and both readers take it from the view.
    const fn = between('function slotUnder(event: MouseEvent): number {', '\n  }');
    expect(fn).toContain('hotbarView().slots.length');
    expect(fn).not.toContain('loadout.length');
  });

  it('binds a talent to a keyed slot, and refuses an item there in words', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS TEST USED TO ASSERT THE REFUSAL WAS UNCONDITIONAL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read "refuses to bind a talent slot and says so in words", and it was
     * right: slot n WAS `loadout[n]` for the session, so nothing could be put
     * on the left half of the bar and the only correct behaviour was a sentence
     * explaining why.
     *
     * The six keyed slots hold a binding now, so HALF of that is wrong and half
     * is still exactly right — a talent lands, an item does not — and the
     * branch has to tell them apart. Both halves are asserted here, because the
     * failure mode of getting it half-done is silent: a drop that snapped back
     * with no sentence would teach the player the bar is broken, which is the
     * thing the original test existed to prevent and still is.
     */
    const fn = between('function resolveDrop(', '\n  }');
    expect(fn).toContain('case HotbarDropKind.Talent:');
    // The talent half — it BINDS.
    expect(fn).toContain('bindTalentSlot(drop.index, subject.talentId);');
    // The item half — it REFUSES, in words a player can act on.
    expect(fn).toContain('takes a talent');
    expect(fn).toContain('bindItemSlot(drop.index, subject);');
  });
});

// ---------------------------------------------------------------------------
// 9. A RELEASE BANKS THE POSITION THE CLAMP HONOURED
// ---------------------------------------------------------------------------

describe('endDrag settles the panel offset', () => {
  it('calls settlePanel on the release path, after the drop is resolved', () => {
    // ═══ WITHOUT THIS THE TITLE BAR STOPS WORKING, AND SAYS NOTHING ═══
    // `onDragMove` stores a RAW offset and `hudLayout` clamps it on read, which
    // is correct for the duration of a gesture. Left in the store it is poison:
    // the next `beginDrag` re-bases on the raw value while `grabX/grabY` come
    // from the CLAMPED position on screen, so one sweep past the band edge banks
    // hundreds of pixels of dead travel. The character sheet has 29 pixels of
    // legal vertical travel on a 1248x480 backbuffer; a single sweep to the
    // bottom of the window banks 423, and the next four FULL-HEIGHT drags then
    // move it nothing at all.
    const fn = between('function endDrag(clientX: number, clientY: number): void {', '\n  }');
    expect(fn).toContain('settlePanel(live.subject);');
    // AFTER the drop: `resolveDrop` reads `hudLayout`, and settling first would
    // move the panel out from under the point the release is being resolved at.
    expect(at('resolveDrop(live, renderer.backbufferPoint(clientX, clientY));', fn)).toBeLessThan(
      at('settlePanel(live.subject);', fn),
    );
  });

  it('settles against the SAME unmoved rect hudLayout draws from', () => {
    // Two producers of "where would this panel be" is how a settle records a
    // position the painter never drew, and the panel then jumps a few pixels
    // every time the player lets go of it. `unmovedPanelRect` is the one
    // producer; `hudLayout` reads it through `movePanel` and this reads it
    // directly.
    const fn = between('function settlePanel(subject: DragSubject): void {', '\n  }');
    expect(fn).toContain('unmovedPanelRect(subject.panel, logicalW, logicalH, band)');
    expect(fn).toContain('settleOffset(');
    // The band is recomputed the same way `hudLayout` computes it, from the live
    // turn HUD height rather than from anything cached.
    expect(fn).toContain('panelBand(logicalH, turnHudHeight(turnView()))');
    const layout = between('function hudLayout(width: number, height: number): HudLayout {', '\n}');
    for (const panel of [
      'DraggablePanel.Sheet',
      'DraggablePanel.Talents',
      'DraggablePanel.Inventory',
      'DraggablePanel.Menu',
    ] as const) {
      expect(layout).toContain(`unmovedPanelRect(${panel}, width, height, band)`);
    }
  });

  it('clears the frozen hover state at every exit from a gesture', () => {
    // The canvas `mousemove` handler short-circuits while a drag is live, so
    // every hover flag is stuck at its pre-press value for the whole gesture and
    // stale afterwards until the pointer next moves — which it usually does not,
    // because the player has just finished moving it. The visible half was a
    // hover card pinned at the old point and painted OVER the item in the
    // player's hand, and an inventory × still lit after the panel was dragged
    // out from under it.
    expect(
      between('function endDrag(clientX: number, clientY: number): void {', '\n  }'),
    ).toContain('clearHoverState();');
    expect(between('function cancelDrag(): boolean {', '\n  }')).toContain('clearHoverState();');
    // ...and the card is additionally suppressed for the duration, which is the
    // rule the token menu already has for the same reason.
    expect(CODE).toContain(
      'if (tip !== null && pointerPoint !== null && drag === null && tokenMenu?.visible() !== true)',
    );
  });
});

// ---------------------------------------------------------------------------
// 9b. THE PAPER DOLL IS A DROP TARGET SOMETHING CAN ACTUALLY BE DROPPED ON
// ---------------------------------------------------------------------------

describe('an item drag springs the inventory tab it is heading for', () => {
  it('is driven from onDragMove, for item drags only', () => {
    // ═══ WITHOUT IT, THREE WORKING THINGS HAVE NO ROUTE TO THEM ═══
    // The doll and the bag are on MUTUALLY EXCLUSIVE tabs, so a carried item is
    // dragged across a panel showing no doll cell and a worn item across a panel
    // showing no bag. Both inventory branches of `resolveDrop` were therefore
    // unreachable, and so was the `ui_inventory_cell_hover` plate the doll blits
    // on a valid target — code that works, with nothing able to reach it, which
    // is the same failure shape as the dead `icon_ability_` prefix.
    const fn = between('function onDragMove(clientX: number, clientY: number): void {', '\n  }');
    expect(fn).toContain('springInventoryTab(point);');
    // A PANEL drag must not spring anything: it is the `else` of the panel
    // branch, so the two are mutually exclusive by construction.
    expect(at('if (subject.kind === DragKind.Panel) {', fn)).toBeLessThan(
      at('springInventoryTab(point);', fn),
    );
  });

  it('does the panel-shaped work only when the pointer is over the panel', () => {
    // `inventoryPanelRows` walks the whole doll and the whole bag, which is
    // exactly the per-pointer-event work the canvas `mousemove` short-circuit
    // exists to keep out of a gesture. The rect test comes first.
    const fn = between('function springInventoryTab(point: TileXY): void {', '\n  }');
    expect(at('if (!inRect(layout.inventory, point.x, point.y)', fn)).toBeLessThan(
      at('inventoryRowsFor(', fn),
    );
    // It only ever switches, never sends: a tab is client-local.
    expect(fn).toContain('invTab = hit.tab;');
    expect(fn).not.toContain('send');
  });

  it('keeps both inventory drops reachable on the release path', () => {
    const fn = between('function resolveDrop(', '\n  }');
    // A bag item onto a doll cell, filled or empty, is `equip`.
    expect(fn).toContain('sendEquip(subject.itemId);');
    // A worn item onto a bag cell is `unequip`, named by SLOT.
    expect(fn).toContain('sendUnequip(subject.slot);');
    // ...and a release back on the cell it came from is the deferred CLICK,
    // which is what stops a seven-pixel hand tremor swallowing an equip.
    expect(fn).toContain('live.click?.();');
  });
});

// ---------------------------------------------------------------------------
// 10. A CONTROL THE PLAYER CANNOT SEE IS NOT PRESSABLE — ALL FOUR TERMS
// ---------------------------------------------------------------------------

describe('the character sheet block is guarded against every panel drawn over it', () => {
  it('names talents, inventory and menu', () => {
    // ═══ THE TALENT TERM WAS MISSING AND THE DRAG HANDLE MADE IT MATTER ═══
    // Step 4a returns for only two of the talent panel's outcomes — Close and
    // Spend — so a press on a talent ROW, on the badge or on bare panel falls
    // through to the sheet block. That was harmless while `charSheetHitAt`
    // answered only 'close' and 'talents'; it now answers 'header' for the whole
    // title strip, and on a 1248x480 backbuffer the sheet's header sits BEHIND
    // the talent panel's first content row. A press aimed at a talent row began
    // dragging a sheet the player could not see.
    const block = between('layout.sheet !== null &&', 'const hit = charSheetHitAt(');
    for (const term of ['layout.talents', 'layout.inventory', 'layout.menu']) {
      expect(block, `the sheet block skips ${term}`).toContain(
        `!inRect(${term}, point.x, point.y)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// THE LIFE READOUT IS ON PERMANENT FURNITURE
// ---------------------------------------------------------------------------

describe('the player can always see their own health', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GAP: this is a combat roguelike and there was no self HP anywhere that
   * is always on screen.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Three copies existed and each could be absent when it mattered: the party
   * pane toggles off with `p` and degrades to a three-pixel sliver with no
   * digits on a narrow window; the turn cards are drawn only in combat; the
   * character sheet is behind a keypress. ToME spends its largest permanent
   * element on life (Minimalist.lua:762-830).
   *
   * `ui/life.ts` owns the drawing and is tested on its own. THIS file pins the
   * WIRING, which is the half that can rot silently — a widget nobody calls is
   * indistinguishable from one that was never written.
   */
  it('draws it every frame, unconditionally', () => {
    const frame = between('const resourceY =', 'const hint =');
    expect(frame).toContain('drawLife({');
    // NOT INSIDE A BRANCH. `drawLife` makes its own refusal (no body yet), and
    // a caller-side `if` would be a second, different answer to "when is this
    // on screen" — which is precisely how the party pane came to be the only
    // copy of the number.
    const call = frame.slice(frame.indexOf('drawLife({'));
    const line = frame.slice(0, frame.indexOf('drawLife({')).split('\n').at(-1) ?? '';
    expect(line.trim(), 'drawLife is a statement, not a conditional expression').toBe('');
    expect(call).toContain('hp:');
  });

  it('reads its HP from `actors`, the one map that is always populated', () => {
    /**
     * NOT from the party frame and not from the turn frame. `actors` holds the
     * body under this socket's control in combat and out of it, solo and in a
     * party — so the widget has the same lifetime as the strip it sits on.
     * Sourcing it from `turn` would have rebuilt the combat-only bug in a new
     * place.
     */
    const frame = between('const resourceY =', 'drawLife({');
    expect(frame).toContain('actors.get(selfId)');
  });

  it('offsets the resource pips by the widget, so the two cannot overlap', () => {
    const frame = between('drawLife({', 'const hint =');
    expect(frame).toContain('x: 4 + LIFE_W');
    expect(frame).toContain('width: width - 8 - LIFE_W');
  });
});

// ---------------------------------------------------------------------------
// THE MINIMAP ANSWERS THE MOUSE
// ---------------------------------------------------------------------------

describe('the minimap is wired to something', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IT WAS PAINTED EVERY FRAME AND HAD NO CALLER IN ANY MOUSE HANDLER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ui/mapview.ts tests `mapTileAt` against the painter's own placement. This
   * pins the WIRING, which is the half that rots silently — a resolver nobody
   * calls is indistinguishable from one that was never written, and that is
   * exactly the state the minimap was in.
   *
   * Upstream gives its own minimap three meanings (Minimalist.lua:1639-1652).
   */
  it('resolves a click on it to a tile', () => {
    // A plain containment check: `between` needs two anchors in one function and
    // the mousedown handler has no stable second one this far down.
    expect(CODE).toContain('minimapTileAt(point.x, point.y, logicalW)');
  });

  it('travels through the SAME call the verb menu uses', () => {
    /**
     * `beginTravel` and not a second walk path — so the minimap gains a route to
     * travel rather than its own implementation of it, including the
     * interruption rules that stop travel being a way to cross a fight.
     */
    const start = at('minimapTileAt(point.x, point.y, logicalW)');
    const body = CODE.slice(start, start + 700);
    expect(body).toContain('beginTravel(mapped, false)');
    // AND IT REFUSES IN WORDS on ground you cannot walk on, rather than being a
    // dead click on the water that is drawn right there on the map.
    expect(body).toContain('travelTargetAllowed(level, mapped)');
  });

  it('sits after the panel guard and before shift-click and targeting', () => {
    /**
     * AFTER the panels, because one dragged over the corner is something the
     * player put there and should win. BEFORE shift-click and the aim, because
     * both of those read a WORLD tile through `tileAtClient` and would silently
     * resolve a minimap click to whatever is behind that corner of the screen.
     */
    const guard = at('if (overPanel(event.clientX, event.clientY)) {');
    const mini = at('minimapTileAt(point.x, point.y, logicalW)');
    const shift = at('if (event.shiftKey) {');
    expect(guard).toBeLessThan(mini);
    expect(mini).toBeLessThan(shift);
  });

  it('says what it does, because a control nobody knows about is not one', () => {
    // Upstream registers a `desc_fct` over the zone (Minimalist.lua:1652) for
    // the same reason. Ours is a hover card, asked first because nothing else is
    // docked in that corner.
    expect(CODE).toContain('minimapCardAt(pointerPoint.x, pointerPoint.y, width)');
  });
});

describe('there is a pointer route into the escape menu', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IT OPENED ON THE ESCAPE KEY AND ON NOTHING ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `escapemenu.ts` says of its RESUME row that "a surface that changed what
   * Escape means owes the player a visible, clickable way OUT". That was true and
   * implemented; there was no clickable way IN, so a pointer-only player inside a
   * Discord Activity could reach the character sheet, the talents, the inventory
   * and the key bindings by no route at all.
   *
   * ui/menubutton.ts tests the control. This pins the WIRING.
   */
  it('draws the button every frame, not only when the bar is drawn', () => {
    // `drawTurnBar` returns early with no `turn` frame. A route into the menu
    // that came and went with a frame would be worse than none.
    expect(CODE).toContain('drawMenuButton(');
    const start = at('drawMenuButton(');
    const line = CODE.slice(CODE.lastIndexOf('\n', start), start);
    expect(line.trim(), 'drawMenuButton is a statement, not a conditional').toBe('');
  });

  it('opens the SAME menu the key opens', () => {
    // Upstream's `tb_mainmenu` fires `triggerVirtual("EXIT")` — the very key
    // Escape sends. One verb, two ways in, and the menu's own "no room" refusal
    // lives inside `openMenu` so both routes answer alike.
    const start = at('menuButtonHit(point.x, point.y)');
    expect(CODE.slice(start, start + 200)).toContain('openMenu()');
  });

  it('takes the click before anything that reads a world tile', () => {
    // Both the minimap branch and shift-click resolve a TILE; either would walk
    // the player somewhere because they reached for the menu.
    const button = at('menuButtonHit(point.x, point.y)');
    const mini = at('minimapTileAt(point.x, point.y, logicalW)');
    const shift = at('if (event.shiftKey) {');
    expect(button).toBeLessThan(mini);
    expect(mini).toBeLessThan(shift);
  });
});

describe('auto-explore walks through the travel system', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `RUN_AUTO` (Game.lua:2064-2098) WAS ABSENT ENTIRELY, and `engine/actor.ts`
   * already named the hole: "`travel` / `explore` / `rest` / `follow` join it
   * once those exist".
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * input/explore.ts tests the RULE against a map drawn as a picture. This pins
   * the thing that makes the feature safe: it does not walk anybody itself.
   */
  it('picks a target and hands it to beginTravel', () => {
    /**
     * TRAVEL ALREADY STOPS for a hostile coming into view, for being hit, for a
     * refusal from the server and for a disconnect. An explorer with its own
     * copy of those rules would be a second traveller, and the first one to
     * drift would be the one that stops for monsters.
     */
    const start = at('case TurnCommand.Explore: {');
    const arm = CODE.slice(start, CODE.indexOf('case TurnCommand.Rest:', start));
    expect(arm).toContain('exploreTarget({');
    expect(arm).toContain('beginTravel(answer.to, false)');
    // NO FRAME OF ITS OWN. The server is never told an explore happened; it sees
    // the same moves a hand-walked route would send.
    expect(arm, 'explore must not invent a wire verb').not.toContain('socket.send(');
  });

  it('asks the SAME walkability question the verb menu greys its row on', () => {
    // "Somewhere I can walk" is one question and must have one answer, or the
    // explorer aims at a tile travel will then refuse.
    const start = at('case TurnCommand.Explore: {');
    const arm = CODE.slice(start, CODE.indexOf('case TurnCommand.Rest:', start));
    expect(arm).toContain('travelTargetAllowed(here, { x, y })');
  });

  it('refuses in words rather than doing nothing', () => {
    // Three reasons and three sentences — see `exploreStopText`. A key that
    // appears to do nothing is indistinguishable from one that is not bound.
    const start = at('case TurnCommand.Explore: {');
    const arm = CODE.slice(start, CODE.indexOf('case TurnCommand.Rest:', start));
    expect(arm).toContain('exploreStopText(');
    expect(arm).toContain('bearingWord(');
  });
});

describe('a walk that crosses loot stops on it', () => {
  /**
   * input/travel.ts tests the machine. This pins the half main.ts owns: `ground`
   * lives here, so the "is there something underfoot" question is asked here and
   * handed in — the module takes a world, not a catalogue.
   */
  it('asks the ground frame and hands the answer to travel', () => {
    const start = at('onSelfMoved = (x, y) => {');
    const body = CODE.slice(start, start + 900);
    expect(body).toContain('ground.some(');
    expect(body).toContain('observeSelfMoved({ x, y }, underfoot)');
  });

  it('names the key, because a stop the player cannot act on is just a stop', () => {
    const start = at('onSelfMoved = (x, y) => {');
    const body = CODE.slice(start, start + 900);
    expect(body).toContain('TravelObservation.Notable');
    // `keyHint` and never a printed letter — `,` is rebindable like everything
    // else, and a hard-coded one is a lie the moment somebody changes it.
    expect(body).toContain("keyHint('pickup')");
  });
});
