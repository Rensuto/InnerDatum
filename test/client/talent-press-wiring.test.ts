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
    const armsInDrag = block.indexOf('answerPressed();', drag);
    const dragReturn = at('return;', block, drag);
    expect(armsInDrag, 'the drag release does not arm').toBeGreaterThan(drag);
    expect(armsInDrag, 'the drag release does not arm').toBeLessThan(dragReturn);
    expect(
      block.indexOf('answerPressed();', dragReturn),
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

  it('decides every press against the take-back guard before any reader that can spend', () => {
    // A take-back that empties the window makes its badge vanish, and the pixels
    // under it are a deepen offer and an arm. See `takeBackGuard` in main.ts, and
    // the guard's sequences in talents.test.ts.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'", CODE));
    const decided = at('pressAgainstGuard(', mousedown);
    const deepen = at('talentPanelDeepenAt(', mousedown);
    expect(decided, 'the guard is asked after a reader that can spend').toBeLessThan(deepen);
    const guard = mousedown.slice(at('const guardHere =', mousedown), deepen);
    // ONLY INSIDE THE PANEL, asked the question with the panel's own scroll and
    // stat list, and it RETURNS — a guard that only called preventDefault would
    // fall straight through to the deepen offer.
    expect(guard).toContain('inRect(layout.talents, point.x, point.y)');
    expect(guard).toContain('takeBackStillOffered(');
    expect(guard).toContain('talentScroll,');
    expect(guard).toContain('progress?.unspendableStats ?? [],');
    expect(guard).toContain('takeBackGuard = guarded.guard;');
    expect(guard).toContain('event.preventDefault();');
    expect(guard).toContain('return;');

    const block = talentPressBlock();
    const unlearn = at('hit.kind === TalentHitKind.Unlearn', block);
    expect(
      at('takeBackGuard = guardTakeBack(hit.badge, Date.now());', block, unlearn),
    ).toBeLessThan(at('pressTalentMinus(hit.talentId)', block, unlearn));
    const unspend = at('hit.kind === TalentHitKind.UnspendStat', block);
    expect(
      at('takeBackGuard = guardTakeBack(hit.badge, Date.now());', block, unspend),
    ).toBeLessThan(at("t: 'unspend_stat'", block, unspend));
  });

  it('never lets a pointer merely moving end the guard, and clears it when the panel moves', () => {
    // A HAND AT REST IS NOT STEADY: the first guard let go on a two-pixel drift.
    // BOUNDED BY THE NEXT LISTENER, whatever it is: the wheel handler is registered
    // between mousemove and mousedown, and it clears the guard on purpose.
    const moveAt = at("canvas.addEventListener('mousemove'", CODE);
    const mousemove = CODE.slice(moveAt, at('canvas.addEventListener(', CODE, moveAt + 1));
    expect(mousemove).not.toContain('takeBackGuard');
    // ...AND IT DOES END when what lies under a still pointer changes.
    for (const head of ['function toggleTalentPanel(', 'function onViewportChange(']) {
      expect(fnBody(head), `${head} keeps a stale guard`).toContain('takeBackGuard = null;');
    }
    // AND A MESSAGE BELONGS TO THE PANEL IT WAS SAID ON: a reopened panel must
    // not repeat an old refusal at a player who has not pressed anything.
    expect(fnBody('function toggleTalentPanel(')).toContain('talentMessage = null;');
    const wheel = at('talentScroll + step,', CODE);
    expect(
      at('takeBackGuard = null;', CODE, wheel) - wheel,
      'a scroll keeps a stale guard',
    ).toBeLessThan(200);
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

  it('answers a refused attribute press in words before it can arm — LevelupDialog.lua:251-262', () => {
    const body = fnBody('function pressStatPlus(');
    const refusal = at('statPressRefusal(', body);
    expect(refusal).toBeLessThan(at('pressSpend(talentsArmedStat, stat)', body));
    expect(body.indexOf('sayOnTalentPanel(refusal)', refusal)).toBeGreaterThan(refusal);
    // ASKED WITH THE BOUGHT VALUE, THE STAT PURSE AND THE LEVEL, by name: a
    // swapped argument passes every test of the pure function.
    expect(body).toContain("const base = progress?.statBase?.[stat as 'str'] ?? null;");
    expect(body).toContain('unspent: progress?.unspentStats ?? 0,');
    expect(body).toContain('level: progress?.level ?? 1,');
    // A PRESS PAST THE REFUSAL RETIRES THE LAST ONE, before it arms or spends.
    expect(at('talentMessage = null;', body, refusal)).toBeLessThan(
      at('pressSpend(talentsArmedStat, stat)', body),
    );
    const talent = fnBody('function pressTalentPlus(');
    expect(at('talentMessage = null;', talent)).toBeLessThan(
      at('pressSpend(talentsArmedId, talentId)', talent),
    );
  });

  it('answers a talent press that cannot arm in words — LevelupDialog.lua:365-379', () => {
    // Both Row routes call `answerPressed`, which arms first and then asks
    // `talentPressRefusal` — so the words speak on exactly the presses the arm
    // declined, and say the message on the panel's own line.
    const block = talentPressBlock();
    const defined = at('const answerPressed = (): void => {', block);
    // ONE READ, AT THE MOMENT OF ACTING: the cell is looked up inside the answer,
    // so the drag route's release reads one frame for the arm and the words.
    const lookup = 'const pressedCell = pressed === null ? null : talentCellById(pressed);';
    const reads = at(lookup, block, defined);
    expect(block.indexOf('talentCellById(pressed)'), 'the cell is read before the answer').toBe(
      reads + lookup.indexOf('talentCellById(pressed)'),
    );
    const arms = at('talentsArmedId = armed;', block, defined);
    const asks = at('talentPressRefusal(pressedCell', block, defined);
    const says = at('sayOnTalentPanel(refusal)', block, defined);
    expect(reads).toBeLessThan(arms);
    expect(arms).toBeLessThan(asks);
    expect(asks).toBeLessThan(says);
    // WITH THE THREE PURSES BY NAME — a swapped pair passes every pure test.
    const call = block.slice(asks, says);
    expect(call).toContain('class: progress?.unspent ?? 0,');
    expect(call).toContain('generic: progress?.unspentGenerics ?? 0,');
    expect(call).toContain('category: progress?.unspentCategories ?? 0,');
    // AND A PRESS THAT BUYS RETIRES THE LAST REFUSAL, or it covers the arm.
    expect(call).toContain('if (refusal === null) talentMessage = null;');
  });

  it('times the message line by `talentMessageWake`, and clears it when that says gone', () => {
    // StatusBox.lua:57-69's hold and fade are `talentMessageWake`'s to state, and
    // talents.test.ts holds it to the painter's alpha; this is that the timer asks
    // it on every wake, and lets go of a message something newer has replaced.
    const body = fnBody('function sayOnTalentPanel(');
    const records = at('talentMessage = said;', body);
    const first = at('const first = talentMessageWake(said, said.at);', body);
    expect(records).toBeLessThan(first);
    const tick = body.slice(at('const tick = (): void => {', body), first);
    expect(tick).toContain('if (talentMessage !== said) return;');
    expect(tick).toContain('const wait = talentMessageWake(said, Date.now());');
    expect(tick).toContain('if (wait === null) talentMessage = null;');
    expect(tick).toContain('else talentMessageTimer = window.setTimeout(tick, wait);');
    expect(tick).toContain('requestDraw();');
    expect(body.slice(first)).toContain(
      'if (first !== null) talentMessageTimer = window.setTimeout(tick, first);',
    );
  });

  it('asks both hover readers about the same badges the press is told of', () => {
    // A hover that did not know which attributes wear a badge answered nothing
    // over the badge's overhang, while the press there took a point back.
    for (const head of ['const focusedStat = talentStatAt(', 'const card = talentTipAt(']) {
      const from = at(head, CODE);
      const call = CODE.slice(from, at(');', CODE, from));
      expect(call, head).toContain('progress?.unspendableStats ?? []');
    }
  });

  it('answers a heading that cannot deepen, after the offer and before the hit test', () => {
    // LevelupDialog.lua:417-426. The offer first, so an offered tree is never
    // refused; the refusal asked with this body's own deepened list and purse.
    const mousedown = CODE.slice(at("canvas.addEventListener('mousedown'", CODE));
    const offer = at('talentPanelDeepenAt(', mousedown);
    const asked = at('talentPanelHeadingAt(', mousedown);
    const hit = at('talentPanelHitAt(', mousedown, asked);
    expect(offer).toBeLessThan(asked);
    expect(asked).toBeLessThan(hit);
    const branch = mousedown.slice(asked, hit);
    expect(branch).toContain('deepened: deepened.includes(heading),');
    expect(branch).toContain('category: progress?.unspentCategories ?? 0,');
    expect(branch).toContain('sayOnTalentPanel(refusal);');
    expect(branch).toContain('return;');
    // AND THE LIST COMES OFF THE LOADOUT FRAME.
    expect(CODE).toContain('deepened = msg.deepened ?? [];');
    // A LOCKED HEADING WITH A POINT IN HAND ARMS ITS TREE — before any refusal,
    // and only for a tree the server lists as unlockable.
    const arms = at('pressTalentPlus(heading);', branch);
    expect(at('unlockable.some((tree) => tree.id === heading)', branch)).toBeLessThan(arms);
    expect(arms).toBeLessThan(at('headingPressRefusal(', branch));
    expect(branch.slice(0, arms)).toContain('(progress?.unspentCategories ?? 0) > 0');
    // AND ITS CONFIRM SENDS `unlock_tree`: the confirm resolves the armed id.
    expect(fnBody('function pressTalentPlus(')).toContain(
      'treeSpendFor(next.spend, deepenable, unlockable, talentCellById(next.spend))',
    );
  });

  it('hands the panel its message and the clock the fade is measured against', () => {
    // Without these two the refusal is recorded, timed and redrawn for — and
    // never painted, because the painter is the only reader of either.
    const draw = at('drawTalentPanel({', CODE);
    const call = CODE.slice(draw, at('});', CODE, draw));
    expect(call).toContain('message: talentMessage');
    expect(call).toContain('now: Date.now()');
  });
});
