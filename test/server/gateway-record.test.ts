import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RECORD'S TWO OPTIONAL-CULPRIT CLAUSES, WHICH NO SOCKET TEST REACHES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `recordFor` is a closure inside the gateway and every one of its twelve arms
 * is reachable only by staging the exact event that produces it. Two of them
 * name a body that MAY NOT BE THERE:
 *
 *   death   `killerId` is absent when the killer is out of sight
 *           (`OPTIONAL_ACTOR_IDS` redacts it) or when an effect whose source is
 *           gone finishes the job.
 *   downed  `sourceId`, same story, and its own comment argues the rule:
 *           *"a body that bled out from an effect whose source is gone has
 *           nobody to name, and inventing one would be worse than the silence."*
 *
 * The failure both share is silent and identical: reach for `nameOf` instead of
 * `nameOrNull` and the line reads "Index Husk is unfiled by someone" — a game
 * that knows and will not say. `reap-broadcast.test.ts` already asserts no line
 * contains "someone", but only for a kill that HAS a visible killer, which is
 * the case that cannot produce it.
 *
 * A SOURCE GUARD, for `xp-bar.test.ts`'s reason.
 */

const SOURCE = readFileSync(new URL('../../src/server/net/gateway.ts', import.meta.url), 'utf8');

describe('a culprit is named or not mentioned, never invented', () => {
  it('reads the killer through nameOrNull and omits it when absent', () => {
    expect(SOURCE).toContain(
      'const killer = event.killerId === undefined ? null : nameOrNull(event.killerId);',
    );
    expect(SOURCE).toContain("const by = killer === null ? '' : ` by ${killer}`;");
    expect(
      SOURCE,
      'the death line reaches for nameOf, which renders an unseen killer as "someone"',
    ).not.toContain('nameOf(event.killerId)');
  });

  it('keeps the same rule on the downed line, which established it', () => {
    expect(SOURCE).toContain(
      'const culprit = event.sourceId === undefined ? null : nameOrNull(event.sourceId);',
    );
    expect(SOURCE).not.toContain('nameOf(event.sourceId)');
  });
});
