// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's anti-stairscum re-entry pass
// (Game.lua:1369-1388): a floor recovers while nobody is standing on it.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/server/net/gateway.ts', 'utf8');

/**
 * The body of a named binding, brace-matched. The same technique
 * test/server/gate-refresh.test.ts uses on this very file, for the same reason:
 * these are closures inside `wsGateway` and nothing can import one.
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

const CODE = code(SOURCE);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE IS TESTED ELSEWHERE. THIS IS ABOUT WHETHER ANYTHING CALLS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `restoreOnReentry` is covered in test/server/effects.test.ts, and none of
 * those tests can prove that a player walking back into a delve ever REACHES it
 * — which is precisely how a feature ships dead.
 * `test/client/ground-access.test.ts` records the same shape happening for
 * real: *"it was built, dispatched, and covered, while `targetAt` returned a
 * `player` target that carried no `loot` at all"*.
 *
 * These are WIRING GUARDS, not behavioural catches, and the difference is worth
 * stating: they read the source rather than driving a socket. A socket test
 * would be better and is not cheap here — the only harness that walks a body
 * through a door plants a ROAMER, and a roamer ambush is sealed on exit
 * (`lingerMs === 0`), so it is the one realm kind that can never be re-entered.
 * A delve can (`INSTANCE_LINGER_MS`), which is what makes the rule live.
 */
describe('the re-entry pass is actually reached', () => {
  it('stamps ONLY once the realm is confirmed empty', () => {
    /**
     * ═══ THE GRIEFING BUG THIS REPLACED ═══
     * The first version stamped beside every `removePlayer`. A party of four in
     * a delve, one of whom steps out to sell loot and walks back in, would have
     * had the boss the other three were still fighting healed to full with its
     * cooldowns back and their debuffs stripped — the rule that exists to stop a
     * fight being paused, handing them a way to reset one. Upstream never meets
     * it because leaving IS emptying when there is one player.
     *
     * So the stamp lives behind `reapIfEmpty`'s own "is anybody left" check, and
     * nowhere else.
     */
    expect(CODE, 'a stamp at the threshold is the bug').not.toMatch(/markLeft\s*\(/);

    const text = code(body('const reapIfEmpty = '));
    const guard = text.indexOf('.some((a: Actor) => a.kind === ActorKind.Player)) return;');
    const stamp = text.indexOf('realm.leftAtMs = Date.now()');
    expect(guard, 'the emptiness check moved').toBeGreaterThan(-1);
    expect(stamp, 'nothing stamps the realm').toBeGreaterThan(-1);
    expect(stamp, 'the stamp runs before the "is anybody left" check').toBeGreaterThan(guard);
  });

  it('is reached from the paths that are not a door', () => {
    /**
     * `reapIfEmpty` is called from the crossings AND from the reconnect-grace
     * recall, so a delve emptied by a dropped socket or a character swap is
     * stamped too. A stamp at the threshold missed both: ten minutes offline and
     * walking back in would have healed nothing.
     */
    const calls = [...CODE.matchAll(/reapIfEmpty\(/g)];
    expect(calls.length, 'the seam lost a caller').toBeGreaterThanOrEqual(3);
  });

  it('restores on EVERY path that puts a player into a realm', () => {
    const arrivals = [...CODE.matchAll(/const placed = to\.world\.addPlayer\(/g)];
    expect(arrivals.length, 'the shape of the crossing changed').toBe(2);

    for (const match of arrivals) {
      const before = CODE.slice(Math.max(0, (match.index ?? 0) - 400), match.index);
      expect(before, 'an arrival that does not restore the floor').toContain(
        'restoreRealm(to, body)',
      );
    }
  });

  it('restores BEFORE the body is placed', () => {
    /**
     * Order, not merely presence. `restoreOnReentry` heals every hostile on the
     * floor; running it after the arrival would mean a monster standing beside
     * the player heals in front of them, and the newly added body would be in
     * `allActors()` with only the `isHostile` predicate keeping it from being
     * healed too. Doing it first makes that a belt rather than the only thing
     * holding the trousers up.
     */
    for (const fn of ['const leaveRealm = ', 'const crossIntoRealm = ']) {
      const text = code(body(fn));
      const restore = text.indexOf('restoreRealm(to, body)');
      const place = text.indexOf('to.world.addPlayer(');
      if (restore < 0) continue;
      expect(place, `${fn} places a body without restoring`).toBeGreaterThan(-1);
      expect(restore, `${fn} restores after placing`).toBeLessThan(place);
    }
  });

  it('clears the stamp so a party of four is not four rounds of recovery', () => {
    const text = code(body('const restoreRealm = '));
    expect(text).toContain('realm.leftAtMs = undefined');
    // ...and BEFORE the restore, so an exception mid-restore cannot leave the
    // stamp behind for a second pass.
    expect(text.indexOf('realm.leftAtMs = undefined')).toBeLessThan(
      text.indexOf('restoreOnReentry('),
    );
  });

  it('measures the absence on a clock that does not freeze', () => {
    /**
     * ═══ THE ONE THAT WOULD HAVE ANSWERED "TWO TURNS" FOR AN HOUR AWAY ═══
     * The first version measured against the OVERWORLD's game turn. Every realm
     * keeps its own clock and the tide only advances an OCCUPIED one, so the
     * overworld freezes the moment everybody is indoors — a solo player who
     * leaves a delve, walks into a town and rests three hundred turns measures as
     * two turns away, and the rule barely fires in the exact scenario it targets.
     *
     * The wall clock is the only monotonic reference the process has, and
     * `tideMs` is the conversion — one game turn per tide on an occupied realm.
     */
    const text = code(body('const restoreRealm = '));
    expect(text).toContain('Date.now() - left');
    expect(text).toContain('tideMs');
    expect(text, 'a realm clock freezes while the realm is empty').not.toMatch(
      /turn\.clock\.gameTurn/,
    );
  });

  it('stands down rather than dividing by a stopped tide', () => {
    // `tideMs` of zero stops the clock (`WsGatewayOptions.tideMs`), and a realm
    // whose clock does not run cannot measure an absence in turns.
    const text = code(body('const restoreRealm = '));
    expect(text).toContain('tideMs <= 0');
  });
});
