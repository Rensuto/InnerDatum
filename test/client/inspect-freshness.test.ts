// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE INSPECT CARD MUST NOT STATE HIT POINTS FROM BEFORE THE SHOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from a live session with a screenshot. The Case Log read
 *
 *     Ren uses Sniper's Mark. Ren hits Index Glut.
 *     36 damage. Index Glut 14/60.
 *
 * and the inspect card beside it said `50/60` — the answer from before the shot,
 * held for the rest of the turn and stated in bold next to a health bar that was
 * already correct.
 *
 * ═══ THE CAUSE WAS A PREMISE, NOT A TYPO ═══
 * `requestInspect` reuses a cached answer while `known.gameTurn ===
 * turn.gameTurn`, under a comment reading *"hit points and hit chances are
 * answers about one game turn"*. Hit points are not. They change several times
 * WITHIN a turn — every shot a player fires moves a body's hp while the turn
 * number stands still — so the cache was correct about its own rule and the rule
 * was wrong.
 *
 * ═══ WHY THIS IS A SOURCE TEST ═══
 * main.ts touches `document` at import time and there is no jsdom here, so
 * nothing in it can be imported. Every rule below is about WHERE a line sits —
 * which is what the whole class of client wiring test in this directory pins,
 * and is the only reachable way to state them.
 */

const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/**
 * The same file with every comment line removed.
 *
 * main.ts quotes the code its comments justify, and this file's whole subject is
 * a comment that described a rule correctly while the rule was wrong. An
 * assertion run against the prose would be exactly the failure under test.
 */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

function at(snippet: string): number {
  const index = CODE.indexOf(snippet);
  expect(index, `main.ts still contains: ${snippet}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('a body that takes damage stops having a cached card', () => {
  /**
   * THE ASSERTION THE BUG TURNS ON. Without this line the card keeps the answer
   * from before the blow until the game turn ticks over.
   */
  it('invalidates the inspect answer from the damage handler', () => {
    const apply = at('actors.set(event.id, { ...actor, hp: event.hp, maxHp: event.maxHp });');
    const invalidate = at('noteInspectedBodyChanged(event.id);');
    expect(
      invalidate,
      'the card is invalidated somewhere other than immediately after the hp is applied',
    ).toBeGreaterThan(apply);
    expect(invalidate - apply, 'the invalidation drifted away from the hp it follows').toBeLessThan(
      400,
    );
  });

  it('marks the stale entry rather than papering over it', () => {
    at('function noteInspectedBodyChanged(id: string): void {');
    at('markInspectStale(id);');
  });

  /**
   * ═══ AND IT MAY NOT BLANK THE CARD IT IS INVALIDATING ═══
   *
   * This used to be `inspectCache.delete(id)`, and that is the second bug this
   * file is about. Every reader draws `?.view ?? null` and `null` means DRAW
   * NOTHING, so removing the entry emptied the card for the whole round trip.
   * Reported as *"if you were hovering over something and had a tooltip, it
   * would just close the tooltip when the tick/refresh happens"*.
   *
   * The mark keeps both properties at once: the answer is still refused by
   * `requestInspect` (so the 50/60 bug above cannot come back) and still drawn
   * (so the card does not blink once per blow).
   */
  it('does not delete the entry a card may be drawing', () => {
    const fn = at('function noteInspectedBodyChanged(id: string): void {');
    // The function is twenty lines; a fixed window keeps this off a brittle
    // brace-matching parse and still cannot reach the next declaration.
    const body = CODE.slice(fn, fn + 700);
    expect(
      body.includes('inspectCache.delete('),
      'noteInspectedBodyChanged deletes the entry again — the card will blank on every blow',
    ).toBe(false);
  });

  /**
   * ═══ ALL THREE READERS, BECAUSE ONLY ONE OF THEM IS THE POINTER ═══
   * `tooltipView` consults the pin BEFORE the cache, so a pinned card shadows
   * any cache rule entirely — that is a bug this file's subject already caused
   * once, on the game-turn edge. The sheet reads the cache directly and nothing
   * else re-asks about a body the pointer is not on.
   */
  it('re-asks every reader that could be looking at that body', () => {
    at('if (pinnedInspectId === id) refreshPinnedInspect();');
    at('if (hoveredActorId === id) refreshHoveredInspect();');
    at('if (selfId === id) refreshSelfSheet();');
  });

  /**
   * A HOVER CARD CANNOT RE-ASK FOR ITSELF. `requestInspect` fires from pointer
   * events, and a player who rests the pointer on a husk and then spends the
   * turn shooting it generates none — which is precisely the reported case.
   */
  it('gives the hover card its own refresher, like the pin has', () => {
    at('let refreshHoveredInspect: () => void = () => {');
    const impl = at('refreshHoveredInspect = () => {');
    const send = CODE.indexOf(
      "socket.send({ v: PROTOCOL_VERSION, t: 'inspect', targetId: id });",
      impl,
    );
    expect(send, 'the hover refresher never sends anything').toBeGreaterThan(impl);
  });

  /**
   * ═══ AND IT MUST NOT GO THROUGH `requestInspect` ═══
   * That function returns early on a cache hit for the current turn, which is
   * the exact rule being overridden. Routing a refresh through it would restore
   * the bug while looking like a fix.
   */
  it('does not route the refresh through the cache-guarded request', () => {
    const start = at('function noteInspectedBodyChanged(id: string): void {');
    const end = CODE.indexOf('\n}', start);
    const body = CODE.slice(start, end);
    expect(body, 'the invalidator calls the cache-guarded requestInspect').not.toContain(
      'requestInspect(',
    );
  });
});

describe('and it costs one question per body, not one per blow', () => {
  /**
   * A sweep can carry several blows against one body. Each invalidates the same
   * card, and without a ledger each would also send its own `inspect` — three
   * questions with one answer, on a socket with a token bucket.
   */
  it('keeps a ledger of refreshes already in the post', () => {
    at('const inspectRefreshPending = new Set<string>();');
    at('if (!watched || inspectRefreshPending.has(id)) return;');
    at('inspectRefreshPending.add(id);');
  });

  it('clears the ledger when the answer arrives', () => {
    at('inspectRefreshPending.delete(msg.targetId);');
  });

  /** A board replacement forgets everything, this ledger included. */
  it('clears the ledger when the world is replaced', () => {
    const forget = at('function forgetInspections(): void {');
    const clear = CODE.indexOf('inspectRefreshPending.clear();', forget);
    expect(clear, 'forgetInspections leaves the refresh ledger behind').toBeGreaterThan(forget);
  });

  /**
   * NOBODY LOOKING MEANS NOTHING SENT. The guards are `=== id`, so eight husks
   * hitting each other across the room cost nothing at all.
   */
  it('sends nothing for a body nobody is looking at', () => {
    at('const watched = pinnedInspectId === id || hoveredActorId === id || selfId === id;');
  });
});

describe('the cache itself survives', () => {
  /**
   * The fix is INVALIDATION, not removal. The per-turn cache is why resting a
   * pointer on a token does not poll the server every frame, and the reasons for
   * it are argued at length where it is declared. A change that deleted it would
   * fix this bug by creating a worse one.
   *
   * BOTH HALVES OF THE GUARD ARE IN THE ONE LINE: the stamp is what expires an
   * answer at a turn edge, and `!known.stale` is what expires one WITHIN a turn.
   * Drop either term and a card goes on quoting a number it should have re-asked.
   */
  it('still serves a cached answer when nothing has changed', () => {
    at('if (known !== undefined && !known.stale && known.gameTurn === (turn?.gameTurn ?? -1)) {');
  });

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * THE GAME-TURN EDGE MAY NOT CLEAR. THIS TEST USED TO SAY IT MUST.
   * ════════════════════════════════════════════════════════════════════════════
   * The old assertion was `at('inspectCache.clear();')` under the title *"still
   * clears wholesale on the game-turn edge"*. Once the edge stopped clearing,
   * that assertion KEPT PASSING — it was matching the `clear()` inside
   * `forgetInspections`, which is a different rule about a different edge. A
   * test true of the fixture rather than of the rule.
   *
   * So it is pinned by POSITION now. `clear()` is legal in exactly one place: a
   * board replacement, where the entries are not stale but are about other
   * people entirely.
   */
  it('clears only when the whole board is replaced', () => {
    const occurrences = CODE.split('inspectCache.clear();').length - 1;
    expect(occurrences, 'inspectCache.clear() appears somewhere new').toBe(1);
    const forget = at('function forgetInspections(): void {');
    const clear = CODE.indexOf('inspectCache.clear();');
    expect(clear, 'the only clear() is outside forgetInspections').toBeGreaterThan(forget);
    expect(clear - forget, 'the clear() drifted out of forgetInspections').toBeLessThan(200);
  });

  /**
   * The tick marks instead. Without this the flash is back and nothing else in
   * this file would notice — every other rule here is about a single body.
   */
  it('marks the whole map stale on the game-turn edge', () => {
    at('markAllInspectStale();');
    at('function markAllInspectStale(): void {');
  });

  /** And an arriving answer is what clears the mark. */
  it('an arriving answer lands unmarked', () => {
    at('stale: false,');
  });
});
