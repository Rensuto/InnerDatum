import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHELL'S LAYOUT CONTRACT — src/client/styles/main.css, ONE TEST EACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT BREAKS IF THIS FILE IS NOT HERE ═══
 * The DOM shell is four boxes in a flex column — `#game`, `#cmdrow`, `#margin`,
 * `#log` — and `#game` is the `flex: 1 1 auto; min-height: 0` one that absorbs
 * whatever the other three do not take. So ANY change to the height of one of
 * the small rows resizes the canvas, and `resize` in src/client/render/canvas.ts
 * (:697-747) does not merely re-letterbox when that happens: it recomputes
 * tilesW/tilesH from the new device box (:727-730) and rebuilds the backbuffer
 * (:732-742). A whole extra tile row appears, the panel band moves and the
 * camera clamp shifts the map under the player's feet.
 *
 * That is what the player reported: opening the Escape menu made the screen
 * jump, because the menu hides `#cmdrow` and hiding it used to be
 * `display: none`. The status line had the same bug from the other direction —
 * `min-height` plus `pre-wrap` meant a long line wrapped and grew the box, and
 * `updateStatus` builds a 150-250 character string containing a `notice` that
 * appears and expires on a TIMER, so the map jumped twice per refusal with
 * nobody touching anything.
 *
 * Both fixes are one CSS declaration each and neither leaves a trace in any
 * TypeScript file, which is exactly why they need pinning: there is no type, no
 * signature and no unit test that changes if somebody "simplifies" `visibility:
 * hidden` back to `display: none` six months from now. The bug would come back
 * silently and read as a renderer problem.
 *
 * ═══ WHY IT READS SOURCE AS TEXT ═══
 * vitest.config.ts runs in `node` with deliberately no jsdom (the constraint
 * test/client/travelwiring.test.ts:26-34 sets out in full), and even with jsdom
 * there is no layout engine to ask. The precedents for pinning source text are
 * test/client/inventory.test.ts:807 (sprite ids must be literals) and
 * test/client/keybindwiring.test.ts:122-126 (a gate's position in main.ts).
 *
 * ═══ THE LINE THIS FILE DOES NOT CROSS ═══
 * It asserts DECLARATIONS, never computed pixels. "Is the row 29px tall" is a
 * question only a browser can answer and the answer changes with the font; "is
 * this row's height fixed rather than a floor, and is it hidden without leaving
 * layout" are the two properties the canvas actually depends on.
 */

const CSS_SOURCE = readFileSync(
  new URL('../../src/client/styles/main.css', import.meta.url),
  'utf8',
);

/**
 * The stylesheet with every `/* … *\/` comment removed.
 *
 * ═══ WITHOUT THIS EVERY ASSERTION BELOW IS A LIE WAITING TO HAPPEN ═══
 * Same rule keybindwiring.test.ts:53-68 states for main.ts. This stylesheet is
 * heavily commented by house rule and its comments QUOTE the declarations they
 * argue against — the block above `#cmdrow[hidden]` says the words "display:
 * none" three times explaining why it is NOT that, and the block above `#log`
 * names "min-height" for the same reason. A whole-file `not.toContain('display:
 * none')` would fail against a perfectly correct file, and a `toContain` would
 * pass against a file whose rule had been reverted and whose prose still
 * described the fix.
 */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declarations inside one rule, by its exact selector.
 *
 * Sliced rather than parsed: a CSS parser here would be a dependency (banned)
 * or a second implementation of one (worse than the thing it checks). The
 * selectors are unique strings in a 170-line file.
 */
function ruleBody(selector: string): string {
  const open = CSS.indexOf(`${selector} {`);
  expect(open, `main.css still has a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const close = CSS.indexOf('}', open);
  expect(close, `${selector}'s rule is closed`).toBeGreaterThan(open);
  return CSS.slice(open + selector.length + 2, close);
}

// ---------------------------------------------------------------------------
// 1. THE ESCAPE MENU MUST NOT RESIZE THE CANVAS
// ---------------------------------------------------------------------------

describe('#cmdrow is hidden without leaving the layout', () => {
  it('hides with visibility, never with display', () => {
    // ═══ THIS IS THE WHOLE REGRESSION ═══
    // `display: none` returns ~29px to `#game`, which is a real tile row at
    // common viewport sizes. `visibility: hidden` keeps the box, so the rect
    // canvas.ts measures is unchanged and `resize` returns false at its early
    // out (canvas.ts:707) — the frame the menu opens on is drawn at exactly the
    // same scale as the frame before it.
    const body = ruleBody('#cmdrow[hidden]');
    expect(body).toContain('visibility: hidden');
    expect(body).not.toContain('display: none');
    expect(body).not.toContain('display:none');
  });

  it('still HAS a [hidden] rule at all, which is the other half of the trap', () => {
    // Deleting the rule while leaving `cmdRowEl.toggleAttribute('hidden', …)` in
    // main.ts is the failure mode the old docblock warned about and it is
    // INVISIBLE in review: the three functional guards below still shut the
    // focus trap, so nothing misbehaves — the row simply sits there, fully
    // visible, in front of a modal, inviting a click that does nothing.
    expect(CSS).toContain('#cmdrow[hidden]');
  });

  it('keeps the author display:flex that makes the attribute mean anything', () => {
    // `[hidden] { display: none }` lives in the USER-AGENT stylesheet and an
    // author `display: flex` beats it. That is why the rule above must be
    // explicit — but it is also why the `display: flex` here cannot be dropped
    // as redundant: without it the UA rule wins the moment the attribute is set,
    // and we are back to `display: none` by a route with nobody's name on it.
    const body = ruleBody('#cmdrow');
    expect(body).toContain('display: flex');
    // ...and the base rule must not itself carry the hidden state.
    expect(body).not.toContain('visibility');
  });
});

// ---------------------------------------------------------------------------
// 2. THE STATUS LINE MUST NOT GROW
// ---------------------------------------------------------------------------

describe('#log is exactly one line tall whatever it is asked to say', () => {
  it('fixes its height instead of declaring a floor', () => {
    const body = ruleBody('#log');
    // `min-height` is a FLOOR: the box grows past it the moment the content
    // wraps, which is the whole bug. `height` under `box-sizing: border-box` is
    // the box, full stop.
    expect(body).toMatch(/(^|[\s;])height:/);
    expect(body).not.toContain('min-height');
    expect(body).not.toContain('max-height');
  });

  it('clips rather than wraps, the same way #margin already does', () => {
    const body = ruleBody('#log');
    // Three declarations working together and none of them is optional:
    // `nowrap` stops the second line existing, `overflow: hidden` stops it
    // escaping the fixed box, `text-overflow: ellipsis` tells the player the
    // sentence continues. `pre-wrap` is the value that had the bug.
    expect(body).toContain('white-space: nowrap');
    expect(body).not.toContain('pre-wrap');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
  });

  it('is the same treatment #margin gets, so the two rows cannot drift', () => {
    // If somebody ever decides a wrapping status line is worth the resize, they
    // have to argue with the Margin lane too — which has shipped nowrap +
    // ellipsis since M4 without anybody minding.
    const margin = ruleBody('#margin');
    expect(margin).toContain('white-space: nowrap');
    expect(margin).toContain('text-overflow: ellipsis');
  });
});

// ---------------------------------------------------------------------------
// 3. THE MECHANISM THAT MAKES ALL OF THE ABOVE MATTER
// ---------------------------------------------------------------------------

describe('the flex column that turns a row height into a canvas resize', () => {
  it('still gives every spare pixel to #game', () => {
    // Every argument in this file rests on these two declarations. If `#game`
    // ever stops being the flexible child — a fixed height, a grid, a second
    // `flex: 1` sibling — then hiding a row no longer resizes the canvas and the
    // reasoning in the docblocks becomes archaeology rather than fact. Failing
    // here is not "the CSS regressed", it is "go re-read why these rules exist".
    const game = ruleBody('#game');
    expect(game).toContain('flex: 1 1 auto');
    expect(game).toContain('min-height: 0');
    // Matched by regex rather than `ruleBody('body')` because `body` appears in
    // TWO selectors — the `html, body` reset comes first and does not carry the
    // flex properties, so a plain indexOf would read the wrong rule.
    expect(CSS).toMatch(/body\s*\{[^}]*flex-direction: column/);
  });
});

// ---------------------------------------------------------------------------
// 4. THE FOCUS GATE THE CSS IS ALLOWED TO STRENGTHEN AND NEVER TO REPLACE
// ---------------------------------------------------------------------------

const MAIN_TS = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

describe('setCommandLineReachable keeps all three functional guards', () => {
  it('sets disabled, sets tabIndex = -1 and calls blur()', () => {
    // ═══ WHY THIS ASSERTION LIVES IN THE CSS TEST FILE ═══
    // `visibility: hidden` genuinely does remove `#cmd` from the tab order and
    // the accessibility tree, and that is written down two files away as a
    // reason the gate got STRONGER. The predictable next step is somebody
    // reading that and concluding the TypeScript is now redundant. It is not:
    // the attribute toggle and the three guards cover different failures (a
    // stylesheet that 404s, a `hidden` attribute cleared by a future panel), and
    // `blur()` in particular covers the case no CSS can — the field that was
    // ALREADY focused when the class-options frame arrived, i.e. a player who
    // was mid-sentence when they were asked to pick a class.
    const start = MAIN_TS.indexOf('function setCommandLineReachable(reachable: boolean): void {');
    expect(start, 'setCommandLineReachable still exists').toBeGreaterThanOrEqual(0);
    const end = MAIN_TS.indexOf('\n}', start);
    expect(end, 'setCommandLineReachable has an end').toBeGreaterThan(start);
    const body = MAIN_TS.slice(start, end);

    expect(body).toContain('cmdEl.disabled = !reachable');
    expect(body).toContain('cmdEl.tabIndex = reachable ? 0 : -1');
    expect(body).toContain('cmdEl.blur()');
    // The attribute toggle is what the stylesheet above reacts to. It is the
    // COSMETIC half — but a cosmetic half that has to keep firing, or the row
    // stays visible under a modal.
    expect(body).toContain("toggleAttribute('hidden', !reachable)");
  });
});
