// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { drawRoster, rosterRect } from '../../src/client/ui/roster.ts';
import type { CharacterRow } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SELECT SCREEN IS A FRONT DOOR, NOT A PANEL ON TOP OF A GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED WITH A SCREENSHOT: the character list sitting over a lit moor, with
 * the party card, the case log, the minimap and a full hotbar still drawn
 * around it. The player asked whether a proper main menu would be easier than
 * hot-swapping, which was the right instinct about the wrong layer — the SERVER
 * already behaves like a menu (a socket in the select screen owns no body at
 * all, which test/server/select-screen.test.ts pins), and the client was the
 * half still holding the world.
 *
 * TWO CAUSES, ONE SYMPTOM, AND THEY NEEDED DIFFERENT FIXES:
 *
 *   THE STATE. `case 'roster'` set the list and nothing else. Every world-facing
 *   surface — the board, the party, the ground, the sky, the case log — was
 *   still holding the session the player was walking away from. That is fixed in
 *   main.ts by calling the same teardown `welcome` runs, and pinned below by
 *   reading the source, which is this codebase's established way of asserting a
 *   rule about a file that calls `boot()` at module load.
 *
 *   THE PAINT. `drawScrim` is `globalAlpha = 0.7` over whatever is already on
 *   the canvas — correct for a panel opened DURING play, wrong for this one.
 *   With the state fixed there is nothing behind it, and 70% of nothing is a
 *   panel floating in a void. That is fixed in ui/roster.ts and pinned here by
 *   painting into a recorder.
 */

const ROW: CharacterRow = {
  id: 'chr_main',
  name: 'Ren',
  className: 'The Alchemist of Ashwick Row',
  level: 2,
  filed: 0,
  money: 15,
  lastPlayed: new Date(0).toISOString(),
  playable: true,
};

type Recorded = {
  readonly calls: string[];
  readonly fills: { x: number; y: number; w: number; h: number }[];
  readonly sets: { prop: string; value: unknown }[];
};

/**
 * A RECORDER THAT SURVIVES A GRADIENT. `classpicker.test.ts` has the same shape
 * and its proxy answers every unknown property with a void function — which is
 * fine until a painter calls `createLinearGradient(...).addColorStop(...)`, at
 * which point it is reaching into `undefined`. The two gradient factories are
 * answered with a stub that records nothing and satisfies the call.
 *
 * SETS ARE RECORDED, and that is not decoration: "the ground is opaque" is a
 * statement about `globalAlpha` NOT being turned down, which is invisible in a
 * list of method calls.
 */
function recorder(into: Recorded): CanvasRenderingContext2D {
  const gradient = { addColorStop: (): void => undefined };
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'measureText') return () => ({ width: 12 });
        if (prop === 'canvas') return { width: 1280, height: 800 };
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => gradient;
        }
        if (prop === 'fillRect') {
          return (x: number, y: number, w: number, h: number) => {
            into.fills.push({ x, y, w, h });
            into.calls.push('fillRect(4)');
          };
        }
        return (...args: unknown[]) => {
          into.calls.push(`${prop}(${args.length})`);
        };
      },
      set: (_t, prop: string, value: unknown) => {
        into.sets.push({ prop, value });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function paint(w: number, h: number, characters: readonly CharacterRow[]): Recorded {
  const into: Recorded = { calls: [], fills: [], sets: [] };
  drawRoster({
    ctx: recorder(into),
    sprites: { sprite: () => undefined },
    rect: rosterRect(w, h),
    characters,
    cases: 27,
    canCreate: true,
    max: 8,
    selected: 0,
    hovered: null,
    nowMs: 0,
  });
  return into;
}

describe('the menu paints its own ground', () => {
  it('covers the whole canvas, so nothing can show through from behind', () => {
    const rec = paint(1280, 800, [ROW]);
    const whole = rec.fills.filter((f) => f.x === 0 && f.y === 0 && f.w === 1280 && f.h === 800);
    /**
     * ═══ THE ASSERTION THAT WAS FAILING ═══
     * TWO full-canvas fills: the vertical wash and the vignette over it. One
     * would be a flat field, which reads as a loading screen; none is the bug
     * in the screenshot.
     */
    expect(whole.length, 'the menu does not paint a full-canvas ground').toBeGreaterThanOrEqual(2);
  });

  it('never turns the alpha down, which is what made it a scrim', () => {
    const rec = paint(1280, 800, [ROW]);
    const faded = rec.sets.filter(
      (s) => s.prop === 'globalAlpha' && typeof s.value === 'number' && s.value < 1,
    );
    /**
     * `drawScrim` set exactly this to 0.7 and it is the whole reason the moor
     * was visible. A future panel-shaped helper reintroducing it here would
     * bring the bug back with no other symptom, which is why the property is
     * asserted rather than the import.
     */
    expect(faded, 'something is painting the menu translucently again').toEqual([]);
  });

  it('keeps every save paired, so no state leaks into the next painter', () => {
    const rec = paint(1280, 800, [ROW]);
    expect(rec.calls.filter((c) => c.startsWith('save(')).length).toBe(
      rec.calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('draws the game name, which appears nowhere else a player can see', () => {
    const rec = paint(1280, 800, [ROW]);
    // Eleven glyphs of "INNER DATUM", each drawn separately because the tracking
    // is done by hand — `ctx.letterSpacing` is Chromium-only and recent.
    const text = rec.calls.filter((c) => c.startsWith('fillText(')).length;
    expect(text, 'the wordmark was not drawn at all').toBeGreaterThan(11);
  });

  it('drops the wordmark rather than colliding with the list on a short window', () => {
    /**
     * ═══ THE SETUP HAS TO ACTUALLY BE SHORT ═══
     * `rosterRect` centres a panel up to 460 tall with a 12px margin, so the
     * band above it only closes up on a genuinely small viewport. At 300 high
     * the panel takes everything and `rect.y` is 12 — far under the 78 the
     * wordmark needs.
     */
    const tall = paint(1280, 800, [ROW]);
    const short = paint(1280, 300, [ROW]);
    expect(rosterRect(1280, 300).y, 'the short case is not short').toBeLessThan(78);
    expect(
      short.calls.filter((c) => c.startsWith('fillText(')).length,
      'the wordmark did not yield on a short window',
    ).toBeLessThan(tall.calls.filter((c) => c.startsWith('fillText(')).length);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AND THE STATE HALF, READ OFF THE SOURCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * main.ts calls `boot()` at module load and reaches for `document`, the Discord
 * SDK and a WebSocket; vitest runs in `node` with deliberately no jsdom, so it
 * cannot be imported. test/client/hudwiring.test.ts, keybindwiring.test.ts and
 * travelwiring.test.ts all state this constraint and all answer it the same
 * way — assert on the text. These are the rules that are about WHERE a line
 * sits, which is exactly the category that survives no other kind of test.
 */
const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

function block(caseLabel: string): string {
  const at = SOURCE.indexOf(`    case '${caseLabel}':`);
  if (at < 0) throw new Error(`no case '${caseLabel}' in main.ts`);
  const next = SOURCE.indexOf('\n    case ', at + 1);
  return SOURCE.slice(at, next < 0 ? SOURCE.length : next);
}

describe('a roster puts the world down', () => {
  it('runs the same teardown a welcome does', () => {
    expect(
      block('roster').includes('forgetTheWorld();'),
      'the select screen no longer tears down the world it is covering',
    ).toBe(true);
  });

  it('is the same teardown, written once', () => {
    /**
     * ═══ THE REASON THIS TEST EXISTS AT ALL ═══
     * The teardown is twenty-odd surfaces, each with its own paragraph of
     * reasoning. Copying it into the second caller would be the exact shape
     * that has cost this codebase six separate bugs — ONE RULE WRITTEN AS A
     * HAND-WRITTEN LIST, with the copy missing the entry that mattered. One
     * definition, two call sites, and the next surface somebody adds lands in
     * both by construction.
     */
    expect(
      SOURCE.split('function forgetTheWorld(): void {').length - 1,
      'forgetTheWorld is defined more than once',
    ).toBe(1);
    expect(block('welcome').includes('forgetTheWorld();')).toBe(true);
  });

  it('empties the board itself, which the shared teardown deliberately does not', () => {
    /**
     * `forgetTheWorld`'s other caller replaces these three in the same breath,
     * so it has no business writing them. A roster has nothing to replace them
     * WITH, and a board left standing is the thing the screenshot showed.
     */
    const roster = block('roster');
    expect(roster.includes('level = null;'), 'the board survives the select screen').toBe(true);
    expect(roster.includes('replaceActors([]);'), 'the actors survive the select screen').toBe(
      true,
    );
  });

  it('replaces the HUD rather than covering it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THAT CLEARING THE STATE DOES NOT BUY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Emptying `level` silences the world pass and the minimap, because both
     * read it. It silences NOTHING ELSE: there is no screen state in main.ts,
     * there are nine unrelated nullables, so the hotbar, the resource bar, the
     * xp bar, the turn bar and the prose lines each carry their own gate. The
     * screenshot had all of them.
     *
     * So the rule is structural and this is the only kind of test that can
     * reach it: the roster is drawn FIRST and returns, rather than being drawn
     * last on top. Twenty-two gates that must all agree would be twenty-two
     * chances to forget one, and forgetting one is silent.
     */
    const at = SOURCE.indexOf('const paintHud: HudPainter');
    expect(at, 'paintHud is not in main.ts any more').toBeGreaterThan(-1);
    const body = SOURCE.slice(at, SOURCE.indexOf('\n};', at));

    const roster = body.indexOf('drawRoster({');
    const turnBar = body.indexOf('drawTurnBar({');
    const hotbar = body.indexOf('drawHotbar({');
    expect(roster, 'paintHud never draws the roster').toBeGreaterThan(-1);
    expect(turnBar, 'paintHud never draws the turn bar').toBeGreaterThan(-1);
    expect(hotbar, 'paintHud never draws the hotbar').toBeGreaterThan(-1);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the change the roster was the LAST block in the function, so both
    // of these read the other way round.
    expect(roster, 'the turn bar is still painted behind the menu').toBeLessThan(turnBar);
    expect(roster, 'the hotbar is still painted behind the menu').toBeLessThan(hotbar);

    // ...and it leaves rather than falling through into all of it.
    const tail = body.slice(roster);
    expect(
      tail.slice(0, tail.indexOf('drawTurnBar({')).includes('return;'),
      'the menu is drawn first and then the whole HUD is drawn over it',
    ).toBe(true);
  });

  it('dismisses whatever it is covering, as a required screen must', () => {
    // `case 'class_options'` makes this argument in full and calls the same
    // function; the roster is the other screen that cannot be cancelled.
    expect(
      block('roster').includes('resetMenuState();'),
      'an escape menu left open under the roster has no route out',
    ).toBe(true);
  });
});
