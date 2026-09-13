import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PRESS ON A TALENT ICON ARMS IT — the join between two tested halves.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `talentPanelHitAt` returns `Spend` only for the icon that is ALREADY armed
 * (test/client/talents.test.ts pins that), and `pressSpend` owns arm-then-confirm
 * (pinned there too). Nothing armed an icon: main.ts's Row branch pinned the
 * description column or began a drag, and returned. So `spend_point` — and
 * `unlock_tree` from a locked tree's icon — could not be sent with the mouse at
 * all, while both halves were green.
 *
 * main.ts is the whole client and cannot be driven from a test, so this reads
 * the mousedown handler the way test/client/keybindwiring.test.ts does: comments
 * stripped, so a deleted call whose comment survived cannot pass.
 */

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

/** The talent panel's press handling, from its hit test to the sheet block below it. */
function talentPressBlock(): string {
  const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'", CODE));
  const start = at('const hit = talentPanelHitAt(', mousedown);
  const end = at('layout.sheet !== null', mousedown, start);
  return mousedown.slice(start, end);
}

/** A plain named function's body, brace-matched. */
function fnBody(head: string): string {
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

describe('the talent panel press wiring', () => {
  it('arms the pressed icon, and only one a press could buy', () => {
    const block = talentPressBlock();
    expect(block).toContain(
      'const armed = pressedCell !== null && pressedCell.canSpend ? pressedCell.id : null;',
    );
    expect(block).toContain('talentsArmedId = armed;');
  });

  it('arms on BOTH routes a Row press takes — the drag release and the plain press', () => {
    // A learned active's press becomes a drag whose click callback is the only
    // code that runs if the pointer stays put; a rank-0 or passive icon takes
    // the plain path. Arming on one and not the other leaves half the grid dead.
    const block = talentPressBlock();
    const drag = at('beginDrag({ kind: DragKind.Talent', block);
    const armsInDrag = block.indexOf('armPressed();', drag);
    const dragReturn = at('return;', block, drag);
    expect(armsInDrag, 'the drag release does not arm').toBeGreaterThan(drag);
    expect(armsInDrag, 'the drag release does not arm').toBeLessThan(dragReturn);
    expect(
      block.indexOf('armPressed();', dragReturn),
      'the plain press does not arm',
    ).toBeGreaterThan(dragReturn);
  });

  it('never spends from the Row branch — the confirm is the Spend branch alone', () => {
    // A Row hit is by construction not the confirm half. Routing it through
    // `pressTalentPlus` would spend if the arm had moved to this icon between
    // the press and a drag's release.
    const block = talentPressBlock();
    const spendBranch = at('hit.kind === TalentHitKind.Spend', block);
    const rowStart = at('const pressed = talentIdAt(', block);
    expect(spendBranch).toBeLessThan(rowStart);
    expect(block.slice(rowStart)).not.toContain('pressTalentPlus(');
  });

  it('pins the description column to a pressed attribute before pressing it', () => {
    const block = talentPressBlock();
    const branch = at('hit.kind === TalentHitKind.Stat', block);
    const focus = at('talentFocusStat = hit.stat;', block, branch);
    const press = at('pressStatPlus(hit.stat);', block, branch);
    expect(focus).toBeLessThan(press);
  });

  it('reads a double-click as one gesture on both currencies', () => {
    // The icon is the control now, and a double-click on it is both presses.
    // `confirmTooSoon` is tested as a number; this is that each press asks it
    // BEFORE `pressSpend` can turn the second press into a spend.
    for (const [head, armed] of [
      ['function pressTalentPlus(', 'confirmTooSoon(talentsArmedAt, Date.now())'],
      ['function pressStatPlus(', 'confirmTooSoon(talentsArmedStatAt, Date.now())'],
    ] as const) {
      const body = fnBody(head);
      expect(at(armed, body), `${head} spends before asking`).toBeLessThan(at('pressSpend(', body));
    }
    // ...and the arm from a Row press is stamped, or the first confirm after it
    // would be measured against a stale clock.
    expect(talentPressBlock()).toContain('talentsArmedAt = Date.now();');
  });

  it('answers an empty hand before arming an attribute — LevelupDialog.lua:251-254', () => {
    const body = fnBody('function pressStatPlus(');
    const empty = at('(progress?.unspentStats ?? 0) <= 0', body);
    expect(empty).toBeLessThan(at('pressSpend(talentsArmedStat, stat)', body));
  });
});
