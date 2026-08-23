// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's: `canLearnTalent` (ActorTalents.lua:690-738)
// is re-asked every time the dialog is drawn, so a level or a stat that has just
// moved is reflected immediately.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/server/net/gateway.ts', 'utf8');

/**
 * The body of a named binding, brace-matched. The same technique
 * test/client/hudwiring.test.ts uses on main.ts, for the same reason: these are
 * closures inside `wsGateway` and nothing can import one.
 */
function body(head: string): string {
  const at = SOURCE.indexOf(head);
  if (at < 0) throw new Error(`not found: ${head}`);
  let depth = 0;
  let seen = false;
  for (let i = at; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return SOURCE.slice(at, i + 1);
    }
  }
  return SOURCE.slice(at);
}

/** Comments explain the code; they must not be able to satisfy an assertion. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('a gate that has just opened is reported', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE HARD STUCK THIS EXISTS FOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `LoadoutTalent.locked` is computed server-side by `gateFor` and travels on
   * the `loadout` frame. The CLIENT refuses to send a spend for a locked row at
   * all — `canSpend` is `... && talent.locked !== true` (ui/talents.ts) and the
   * press is gated on it. That is the right design and it is what makes a stale
   * `locked` a dead end rather than a cosmetic slip.
   *
   * `sendLoadout` had five callers: hello, choose class, unlock tree, toggle
   * sustain, and spending a TALENT point. Not levelling up, and not spending an
   * ATTRIBUTE point — the two events whose whole purpose is to clear a gate.
   *
   * So a player who reached exactly the level their one wanted talent needed sat
   * looking at a greyed `+` with a point in hand. The server would have allowed
   * the spend; the client would not ask. Nothing moved until they spent a point
   * on something else or reconnected.
   */
  it('resends the hotbar when an attribute point is spent', () => {
    const handler = code(body('const handleSpendStat = '));
    expect(handler).toContain('sendLoadoutIfGatesMoved');
  });

  it('resends the hotbar when a level lands, which nobody asked for', () => {
    /**
     * A LEVEL MOVES UNDER A PUMP THE VIEWER DID NOT CAUSE — the whole party is
     * paid for one killing blow, which is exactly why `sendProgressIfChanged`
     * rides this loop. The gate check rides it for the identical reason, and the
     * assertion is that the two travel together.
     */
    const frames = code(body('const refreshViewers = '));
    const progressAt = frames.indexOf('sendProgressIfChanged');
    const gateAt = frames.indexOf('sendLoadoutIfGatesMoved');
    expect(progressAt, 'the per-viewer loop no longer checks progress').toBeGreaterThanOrEqual(0);
    expect(gateAt, 'the per-viewer loop does not check the gates').toBeGreaterThanOrEqual(0);
  });

  it('keys on what can open a gate, and NOT on experience', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHY THIS IS NOT FOLDED INTO `progressKey`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * That key includes `xp`, which moves on every kill. Reusing it would resend
     * the whole loadout — every talent, both prose lines each — several times a
     * fight, and `progressKey`'s own note is explicit that the keys are separate
     * precisely because the frames move on different schedules.
     *
     * `checkTier` reads two numbers: the character level against
     * `levelRequiredFor`, and one attribute against `statRequiredFor`. The tree
     * depth is the third input and cannot move without a talent point being
     * spent — a path that already resends.
     */
    /**
     * TAKEN BY LINES, not brace-matched and not sliced to the first `;`.
     *
     * This one is an arrow with a template-literal body, and BOTH of the obvious
     * extractors land inside its type annotation — `(viewer: { level: number;
     * combat?: Combatant })` carries the first `{` AND the first `;` in the
     * declaration. Four lines is the whole expression.
     */
    const lines = SOURCE.split('\n');
    const at = lines.findIndex((line) => line.includes('const gateKeyFor = '));
    expect(at, 'gateKeyFor is gone').toBeGreaterThanOrEqual(0);
    const key = code(lines.slice(at, at + 4).join('\n'));
    expect(key).toContain('level');
    expect(key).toContain('STAT_ORDER');
    expect(key, 'experience would resend the hotbar on every kill').not.toContain('xp');
  });

  it('answers a gated spend with the ladder sentence, not an internal error', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A PLAYER TWO POINTS OF WILLPOWER SHORT WAS TOLD THE BUILD WAS BROKEN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `raiseTalentPoint` answered `null` for three different things — no talent
     * engine, not on this sheet, and THE TIER LADDER REFUSED YOU — and the
     * gateway mapped all three to `ErrorCode.Internal` with "talent points are
     * not wired into this build".
     *
     * `tierRefusalText` exists so "the panel and the log agree word for word"
     * (shared/tiers.ts). It reached the panel and never this path. Upstream
     * returns `nil, "not enough stat: STR"` (ActorTalents.lua:698) and shows it.
     *
     * NOT REACHABLE FROM A SOCKET TEST: a level-1 character holds no talent
     * points, so every probe is stopped by "no class points in hand" long before
     * the ladder is consulted — which is precisely why nothing caught this.
     */
    const handler = code(body('const handleSpendPoint = '));
    const raiseAt = handler.indexOf('raiseTalentPoint');
    const refusedAt = handler.indexOf('ErrorCode.Refused', raiseAt);
    const notWiredAt = handler.indexOf('not wired into this build', raiseAt);
    expect(raiseAt, 'the seam is gone').toBeGreaterThanOrEqual(0);
    expect(refusedAt, 'a gated spend has no sentence of its own again').toBeGreaterThanOrEqual(0);
    /**
     * BETWEEN THE CALL AND THE null BRANCH, which is the whole ordering that
     * matters: `null` still means "this seam cannot answer" and still earns the
     * build message, but it must no longer be reached by a refusal. Anchored
     * from the raise call because this handler answers `Internal` earlier for an
     * unrelated reason, and a bare first-index comparison reads that instead.
     */
    expect(refusedAt, 'the build message answers a refusal again').toBeLessThan(notWiredAt);
  });

  it('says nothing the first time it sees a body', () => {
    /**
     * The frame that introduced this actor already carried its loadout. Sending
     * again on the first sight would make the largest viewer-private frame there
     * is arrive twice at every join, which is the cost this memo exists to
     * avoid — so the first call seeds the key and stays quiet.
     */
    const send = code(body('const sendLoadoutIfGatesMoved = '));
    expect(send).toContain('session.gateKey');
    expect(send).toMatch(/seeded|!== null/);
  });
});
