import { describe, expect, it } from 'vitest';

import { REDACTOR, WATCHMAN, sheetForClass } from '../../src/server/content/classes.ts';
import {
  EffectStatus,
  SetEffectOutcome,
  creditForLanding,
} from '../../src/server/engine/effects.ts';
import { ResourceKind } from '../../src/server/engine/talents.ts';
import type { SetEffectResult } from '../../src/server/engine/effects.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INK ECONOMY, WHICH SHIPPED WORKING AND UNREACHABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ResourceKind.Ink`, `INK_PER_MARK`, `INK_PER_TURN`, the regen table entry and
 * `noteAfflicted` all landed before any class declared the resource. Every piece
 * was written, wired from `main.ts` and reviewed. None of it could run, because
 * a resource no `ClassDef` names is a branch no sheet can take.
 *
 * That is this codebase's most persistent failure — a system built, correct,
 * wired, and reachable by nothing — and the Redactor is what turns this one on.
 * These cases are about the turning on, not about the pieces.
 *
 * ═══ WHY THE RULE HAD TO MOVE BEFORE IT COULD BE TESTED ═══
 * The four conditions deciding whether a landing pays were inline in a closure
 * inside `main.ts`. Nothing can reach that without booting a server, so the rule
 * defining an entire class's income had no coverage at all. It is
 * `creditForLanding` in engine/effects.ts now, and this file is why.
 */

/** A landing, as `statusApplier` reports one. Only the fields the rule reads. */
function landing(over: Partial<SetEffectResult> = {}): SetEffectResult {
  return {
    outcome: SetEffectOutcome.Applied,
    dur: 4,
    maximum: 4,
    saveChance: null,
    savedVs: null,
    effect: null,
    ...over,
  };
}

describe('the Redactor declares the resource that was waiting for one', () => {
  it('is the only class that earns Ink, and it does earn it', () => {
    expect(REDACTOR.resource).toBe(ResourceKind.Ink);
    // AND NOBODY ELSE, because a resource three classes could earn four ways
    // would stop meaning anything — `noteAfflicted` says so in those words.
    expect(WATCHMAN.resource).not.toBe(ResourceKind.Ink);
  });

  /**
   * THE BAR EXISTS, IS BOUNDED, AND STARTS FULL.
   *
   * `RESOURCE_RULES[Ink]` has said `start: 100` since before there was a class
   * to start — "the first fight should be about spending, not about waiting".
   * This is the first thing that has ever read it.
   */
  it('walks in with a full well', () => {
    const sheet = sheetForClass(REDACTOR);
    expect(sheet.resource.kind).toBe(ResourceKind.Ink);
    expect(sheet.resource.value).toBe(sheet.resource.max);
    expect(sheet.resource.max).toBeGreaterThan(0);
  });
});

describe('who gets paid when a mark lands', () => {
  it('pays the caster for a detrimental effect that landed on somebody else', () => {
    expect(
      creditForLanding('victim', landing(), 'redactor', EffectStatus.Detrimental),
      'a mark landed on an enemy and paid nobody',
    ).toBe('redactor');
  });

  /**
   * A SAVE THE TARGET MADE PAYS NOTHING — the condition the whole class is
   * balanced on. Paying on the ATTEMPT would make Ink a flat tax on pressing
   * buttons and would reward spraying marks at things that shrug them off.
   */
  it.each([
    ['negated — the save came up saved', SetEffectOutcome.Negated],
    ['resisted — the save failed but the duration scaled to nothing', SetEffectOutcome.Resisted],
    ['immune — canBe refused it outright', SetEffectOutcome.Immune],
  ])('pays nothing for a mark that was %s', (_label, outcome) => {
    expect(
      creditForLanding(
        'victim',
        landing({ outcome, dur: 0 }),
        'redactor',
        EffectStatus.Detrimental,
      ),
    ).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND A REFRESH PAYS NOTHING, WHICH IS THE CASE THE ECONOMY RESTS ON.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Merged` is what `setEffect` returns when the effect was already live and
   * `onMerge` folded the two together. It looks like a landing and it is not a
   * new mark.
   *
   * `strike_out` costs 8 Ink and `INK_PER_MARK` pays 12 — net-positive on
   * purpose, because a class whose income is conditional needs one
   * unconditional way to prime a dry well. If a refresh paid too, a Redactor
   * could stand in front of one already-effaced husk and press the same button
   * forever at +4 Ink a press.
   *
   * This is the least obvious condition in the rule and the most expensive one
   * to get wrong, so it is tested by name rather than left to the `Applied`
   * check to imply.
   */
  it('pays nothing for re-marking something already marked', () => {
    expect(
      creditForLanding(
        'victim',
        landing({ outcome: SetEffectOutcome.Merged }),
        'redactor',
        EffectStatus.Detrimental,
      ),
      'a refresh paid, so one husk is an infinite well',
    ).toBeNull();
  });

  /**
   * AND NOTHING FOR A LANDING WITH NO TURNS ON IT. `Applied` with `dur: 0` is
   * reachable — an immunity and a refusal both report it — and without the
   * `dur > 0` half of the condition that would be free income for an effect
   * that never existed.
   */
  it('pays nothing for a landing with no duration', () => {
    expect(
      creditForLanding('victim', landing({ dur: 0 }), 'redactor', EffectStatus.Detrimental),
    ).toBeNull();
  });

  /** A Redactor who is bleeding does not get paid for bleeding. */
  it('pays nothing when the source is the victim', () => {
    expect(
      creditForLanding('redactor', landing(), 'redactor', EffectStatus.Detrimental),
    ).toBeNull();
  });

  /** A bandage on an ally is not something written down. */
  it('pays nothing for a beneficial effect', () => {
    expect(creditForLanding('ally', landing(), 'redactor', EffectStatus.Beneficial)).toBeNull();
  });

  /**
   * A TRAP, A FLOOR, A CLOUD NOBODY THREW. No `srcId` means nobody did it, and
   * an effect with no author must not pay an author.
   */
  it('pays nothing when nothing caused it', () => {
    expect(creditForLanding('victim', landing(), undefined, EffectStatus.Detrimental)).toBeNull();
  });

  /**
   * AND AN UNKNOWN EFFECT PAYS NOTHING. `effectById` returns `undefined` for an
   * id the table does not hold, and `undefined` must fall to the refusal rather
   * than to the payment — the difference between an unregistered effect being
   * inert and it being free money.
   */
  it('pays nothing for an effect the table does not know', () => {
    expect(creditForLanding('victim', landing(), 'redactor', undefined)).toBeNull();
  });
});
