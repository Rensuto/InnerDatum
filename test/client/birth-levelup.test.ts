import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { opensAtBirth, pointsWaiting } from '../../src/client/ui/talents.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BIRTH LEVEL-UP SCREEN — `tome/class/Game.lua:320-321`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream opens `LevelupDialog` at birth (`playerLevelup(birthend, true)`,
 * `tome/class/Player.lua:1487-1490`). Ours opens the talent panel on the
 * `loadout` frame that answers the class chooser, when any purse holds a point.
 *
 * Two halves and the join between them: `opensAtBirth` decides, `case 'loadout'`
 * records the debt at module scope, and `onMessage` — the only code that can
 * reach `toggleTalentPanel` — pays it. main.ts is the whole client and cannot be
 * driven from a test, so the wiring is read as source with comments stripped,
 * the way test/client/talent-press-wiring.test.ts reads it.
 */

/**
 * A frame with every purse named, so no purse is `undefined` by accident —
 * talents.test.ts's `progress` fixture records what an `as ProgressMsg` cast
 * that left a purse out once hid.
 */
function frame(purses: {
  unspent: number;
  unspentGenerics: number;
  unspentCategories: number;
  unspentStats: number;
}): ProgressMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 1,
    xp: 0,
    xpToNext: 60,
    ...purses,
  };
}

const EMPTY = { unspent: 0, unspentGenerics: 0, unspentCategories: 0, unspentStats: 0 };

describe('opensAtBirth', () => {
  it('opens for an attribute point alone — the purse a class-only count misses', () => {
    const statsOnly = frame({ ...EMPTY, unspentStats: 3 });
    // THE FIXTURE FIRST: the three talent purses really are empty, so the only
    // thing that can open the panel here is the attribute purse.
    expect(statsOnly.unspent).toBe(0);
    expect(statsOnly.unspentGenerics).toBe(0);
    expect(statsOnly.unspentCategories).toBe(0);
    expect(pointsWaiting(statsOnly)).toBe(3);
    expect(opensAtBirth(statsOnly)).toBe(true);
  });

  it('opens for each purse on its own', () => {
    for (const purse of [
      'unspent',
      'unspentGenerics',
      'unspentCategories',
      'unspentStats',
    ] as const) {
      expect(opensAtBirth(frame({ ...EMPTY, [purse]: 1 })), purse).toBe(true);
    }
  });

  it('stays shut when every purse is empty, and before any frame has arrived', () => {
    expect(opensAtBirth(frame(EMPTY))).toBe(false);
    // An older server sends only the two required purses; absent reads as empty.
    const older: ProgressMsg = {
      v: PROTOCOL_VERSION,
      t: 'progress',
      level: 1,
      xp: 0,
      xpToNext: 60,
      unspent: 0,
      unspentGenerics: 0,
    };
    expect(opensAtBirth(older)).toBe(false);
    expect(opensAtBirth(null)).toBe(false);
  });
});

const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

function at(snippet: string, within: string, from = 0): number {
  const index = within.indexOf(snippet, from);
  expect(index, `main.ts still contains: ${snippet}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** A body, brace-matched from the first `{` at or after `head`. */
function bodyFrom(head: string): string {
  const start = at(head, CODE);
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

const OWED = 'if (choseClass && opensAtBirth(progress)) birthPanelOwed = true;';

describe('the birth level-up screen wiring', () => {
  it('reads whether the chooser was up BEFORE the loadout frame clears it', () => {
    const arm = bodyFrom("case 'loadout': {");
    const capture = at('const choseClass = classOptions !== null;', arm);
    const clear = at('classOptions = null;', arm);
    expect(capture, 'the capture reads the picker after it was cleared').toBeLessThan(clear);
    // AND IT IS THE ONLY WRITE OF THE PICKER IN THIS ARM, so there is no second
    // clear above the capture for the ordering to be measured against instead.
    expect(arm.indexOf('classOptions = null;', clear + 1)).toBe(-1);
    expect(arm.slice(0, capture)).not.toContain('classOptions =');
  });

  it('owes the panel only inside the choseClass guard, after the clear', () => {
    const arm = bodyFrom("case 'loadout': {");
    const owed = at(OWED, arm);
    expect(owed).toBeGreaterThan(at('classOptions = null;', arm));
    // THREE WRITES OF THE DEBT IN THE WHOLE FILE: the declaration, this owe
    // line and the pay's clear. Any other assignment — `= true` elsewhere, or
    // `= opensAtBirth(progress)` on every loadout — would open the panel on a
    // frame that answered nothing, and counting only `= true` let the second
    // shape through.
    expect(CODE.split('birthPanelOwed = true').length - 1).toBe(1);
    expect(CODE.match(/birthPanelOwed\s*=[^=]/g)?.length).toBe(3);
  });

  it('pays the debt in onMessage, once, through the toggle', () => {
    const handler = bodyFrom('onMessage: (msg) => {');
    const applied = at('applyServerMessage(msg);', handler);
    const guard = at('if (birthPanelOwed) {', handler);
    const cleared = at('birthPanelOwed = false;', handler, guard);
    const opened = at('toggleTalentPanel(true);', handler, guard);
    // AFTER the frame is applied, or it reads the debt the frame has not yet
    // recorded; CLEARED BEFORE the call, so the next frame cannot pay it again.
    expect(applied).toBeLessThan(guard);
    expect(cleared).toBeLessThan(opened);
    const block = handler.slice(guard, at('}', handler, opened));
    expect(block).toContain('birthPanelOwed = false;');
    expect(block).toContain('toggleTalentPanel(true);');
    // AT THE TOP LEVEL OF THE HANDLER, not nested inside another condition
    // (the keymap repair's, say) that almost never holds: the braces between
    // the apply and the guard must balance.
    const between = handler.slice(applied, guard);
    const depth = [...between].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
    expect(depth, 'the pay block is nested inside another block').toBe(0);
    // AND IT IS THE ONLY OPEN: a second, unguarded call would open the panel on
    // every frame with points waiting.
    expect(CODE.split('toggleTalentPanel(true)').length - 1).toBe(1);
  });
});
