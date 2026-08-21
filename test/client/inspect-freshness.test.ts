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

  it('drops the stale entry rather than papering over it', () => {
    at('function noteInspectedBodyChanged(id: string): void {');
    at('inspectCache.delete(id);');
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
   */
  it('still serves a cached answer when nothing has changed', () => {
    at('if (known !== undefined && known.gameTurn === (turn?.gameTurn ?? -1)) {');
  });

  it('still clears wholesale on the game-turn edge', () => {
    at('inspectCache.clear();');
  });
});
