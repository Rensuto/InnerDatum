import { describe, expect, it } from 'vitest';

import {
  REDACTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { strikeOut } from '../../src/server/talents/strike_out.ts';
import {
  EffectStatus,
  SetEffectOutcome,
  creditForLanding,
} from '../../src/server/engine/effects.ts';
import { INK_PER_KILL, ResourceKind, inkForKill } from '../../src/server/engine/talents.ts';
import { ActorRank } from '../../src/shared/protocol.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A KILL PAYS — `hate_per_kill`, tome/class/Actor.lua:253.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The archetype the Redactor ports has NO passive income at all
 * (tome/class/Actor.lua:240, `hate_regen = 0 -- Hate does not regen`); it is paid
 * 8 per kill and by `T_FEED`. We had the trickle and neither of the other two,
 * and the measurement said so: a lone level-1 Redactor on the intro floor
 * reported `no_resource x380` in one run and spent 141-351 turns of 900 holding.
 *
 * DRIVEN THROUGH `noteKill`, WHICH IS THE ENGINE'S OWN ENTRY POINT and has
 * exactly one caller — `noteMonsterDeath` in the scheduler, which is where every
 * lane's kill arrives (`noteCasualty` for the swing, the talent and the orb;
 * `resolveStatusHits` for a bleed that finishes somebody) — for exactly the
 * reason its docblock gives.
 */
describe('a kill pays Ink — hate_per_kill, tome/class/Actor.lua:253', () => {
  /** A live engine with one attached body of this class. */
  function attached(cls: typeof REDACTOR) {
    const engine = createContentTalentEngine();
    const sheet = sheetForClass(cls);
    engine.attach('body', sheet);
    return { engine, sheet };
  }

  /** An ordinary body, at the killer's own level. Nothing multiplies it. */
  const RAT = { rank: ActorRank.Normal, level: 1, killerLevel: 1 };

  it('pays INK_PER_KILL, and pays it into the Redactor’s own pool', () => {
    const { engine, sheet } = attached(REDACTOR);
    // Spend first: a full pool would clamp the grant and hide it entirely.
    sheet.resource.value = 0;
    engine.noteKill('body', RAT);
    expect(sheet.resource.value).toBe(INK_PER_KILL);
    expect(INK_PER_KILL).toBe(8);
  });

  it('never pays past the ceiling', () => {
    const { engine, sheet } = attached(REDACTOR);
    sheet.resource.value = sheet.resource.max;
    engine.noteKill('body', RAT);
    expect(sheet.resource.value).toBe(sheet.resource.max);
  });

  it('pays nobody else — a kill-fed Resolve bar would reward stealing a kill', () => {
    const { engine, sheet } = attached(WATCHMAN);
    sheet.resource.value = 0;
    engine.noteKill('body', RAT);
    expect(sheet.resource.kind).toBe(ResourceKind.Resolve);
    expect(sheet.resource.value, 'the Watchman earns by standing there').toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT DIED MULTIPLIES IT — misc.lua:209-234, the clause we did not have.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `hate_per_kill = 8` (tome/class/Actor.lua:253) is the BASE and this file
   * used to assert it as though it were the payout. Upstream routes every kill
   * through the Hate Pool talent (tome/class/Actor.lua:3103-3108), which pays
   * `x2` for an elite and `x4` for a boss — so a flat 8 was upstream's figure
   * for a rat and one QUARTER of its figure for the fight a controller is for.
   *
   * DRIVEN THROUGH THE ENGINE, not through `inkForKill` alone: the arithmetic
   * being right while `noteKill` still paid the flat base is exactly the bug.
   */
  it('pays a boss four times over, and an elite twice — through the engine', () => {
    const { engine, sheet } = attached(REDACTOR);
    for (const [rank, expected] of [
      [ActorRank.Normal, INK_PER_KILL],
      [ActorRank.Elite, INK_PER_KILL * 2],
      [ActorRank.Boss, INK_PER_KILL * 4],
    ] as const) {
      sheet.resource.value = 0;
      engine.noteKill('body', { rank, level: 1, killerLevel: 1 });
      expect(sheet.resource.value, `a ${rank} paid the wrong figure`).toBe(expected);
    }
  });

  it('pays a bonus for a foe out of depth, and nothing for one that is not', () => {
    // misc.lua:213 — `target.level - 2 > self.level`, so exactly two levels over
    // is NOT out of depth and three is. The bonus itself is
    // `ceil(combatTalentScale(depth, 2, 10, 'log', 0, 1))`, which at depth 1 is
    // 2 — the fitted low — so the boundary is visible without pinning the curve.
    expect(inkForKill({ rank: ActorRank.Normal, level: 3, killerLevel: 1 })).toBe(INK_PER_KILL);
    expect(inkForKill({ rank: ActorRank.Normal, level: 4, killerLevel: 1 })).toBe(INK_PER_KILL + 2);
    // …and it is inside the multiplier, as upstream's order has it: the bonus is
    // added to `hateGain` BEFORE the rank clause multiplies it (misc.lua:215
    // then :219).
    expect(inkForKill({ rank: ActorRank.Elite, level: 4, killerLevel: 1 })).toBe(
      (INK_PER_KILL + 2) * 2,
    );
  });

  it('never pays more than the pool holds — misc.lua:228', () => {
    // `math.min(hateGain, 100)`. A boss far out of depth would otherwise pay
    // more than `max_hate`, which upstream refuses at the source rather than at
    // the pool, and so do we.
    expect(inkForKill({ rank: ActorRank.Boss, level: 60, killerLevel: 1 })).toBe(100);
  });

  /**
   * THE COST IS PINNED AT ITS FIGURE, not at a relation with a `?? 0` in it.
   * This case used to read `expect(INK_PER_KILL).toBeGreaterThan(strikeOut.cost.resource ?? 0)`
   * — and deleting the `resource` field outright left the whole suite green,
   * because an absent cost is `0` and 8 is greater than 0. The number this run
   * deliberately moved (8 -> 5) was pinned by nothing at all.
   */
  it('costs what Willful Strike costs — cursed/force-of-will.lua:27', () => {
    expect(strikeOut.cost?.resource).toBe(5);
  });

  it('buys a Strike Out outright, which is the whole point of the number', () => {
    // 8 Ink for a 5-Ink talent: one kill funds the next mark with change, which
    // is what turns a run of kills into a class that can keep acting.
    //
    // `?? NaN` RATHER THAN `?? 0`: an absent cost must FAIL this, not sail
    // through it. Every comparison against NaN is false, so deleting the field
    // goes red here as well as in the case above.
    expect(INK_PER_KILL).toBeGreaterThan(strikeOut.cost?.resource ?? Number.NaN);
  });
});
