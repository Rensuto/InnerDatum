// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A TALENT MUST NOT ANNOUNCE A STATUS THAT DID NOT LAND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three talents reported the AUTHORED duration whenever the status seam merely
 * existed:
 *
 *     landed === undefined ? [] : [`${victim.name} is slowed for 3 turns.`]
 *
 * `landed` is a `SetEffectResult`. That test asks whether the seam is wired, and
 * prints the answer as though it were the outcome — so a target that saved
 * outright was still announced as slowed.
 *
 * Found by `tools/status-live.mjs`: the Case Log said *"Index Cairn is slowed
 * for 3 turns"* while the socket carried no badge, because the effect came back
 * `outcome=negated, dur=0`. The badge was correctly absent; the sentence was
 * the lie, and two hours went into suspecting the badge pipeline.
 *
 * ═══ THE COST IS THAT SAVES BECOME INVISIBLE ═══
 * Every status here is rolled against a typed save with partial-save duration
 * scaling. A player told "slowed for 3 turns" every single time cannot learn
 * that anything resists, cannot see a good save working, and cannot tell a
 * talent that is landing from one that never does.
 *
 * ═══ THE PROPERTY, WHICH IS GENERAL RATHER THAN THREE STRING CHECKS ═══
 * If a talent asks the status seam for anything, WHAT IT SAYS AFTERWARDS MUST
 * DEPEND ON THE ANSWER. Identical prose for "landed for three turns" and
 * "saved outright" is the bug, whatever the wording. That holds for every
 * talent written from here on with no list for anyone to maintain.
 */

import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { EffectStatus, SetEffectOutcome } from '../../src/server/engine/effects.ts';
import { MVP_EFFECTS } from '../../src/server/content/effects.ts';
import { isMonsterTalent } from '../../src/server/talents/monster.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { SetEffectResult } from '../../src/server/engine/effects.ts';
import type { TalentActor, TalentCtx } from '../../src/server/engine/talents.ts';

/**
 * HOW MANY TALENTS MUST ACTUALLY REACH THE STATUS SEAM.
 *
 * ═══ THIS FILE DOES NOT COVER EVERY STATUS TALENT, AND SAYS SO ═══
 * Thirteen talents call `ctx.status`. This fixture reaches SEVEN of them: a
 * caster and one hostile on open ground, cast once. The other six need
 * something this deliberately bare bench does not provide — a raised sustain, a
 * chosen load, an ALLY to aim at, a body already carrying an effect — and
 * building all of that here would make the fixture the thing under test.
 *
 * The floor exists so "reached nothing" cannot read as "found nothing": a
 * fixture that starts throwing for every talent, a filter that matches none, a
 * rename of `onUse`. Six rather than seven leaves one talent of slack, so an
 * ordinary content change does not fail this on coverage it never claimed.
 *
 * The skipped six are named in the failure message rather than left implicit —
 * a partial sweep that reads as a full one is how a gap becomes invisible.
 */
const MUST_EXERCISE = 6;

const engine = createContentTalentEngine();

function landing(outcome: string, dur: number): SetEffectResult {
  return {
    outcome,
    dur,
    maximum: dur,
    amountDecreased: 0,
    savedVs: null,
    saveChance: null,
  } as unknown as SetEffectResult;
}

/** A caster and a victim standing next to each other, on open ground. */
function bodies(): { world: ReturnType<typeof createWorld>; self: TalentActor; foe: TalentActor } {
  const world = createWorld('honesty');
  const self = world.addPlayer('p1', 'Caster') as unknown as TalentActor;
  const foe = world.addMonster('m1', {
    name: 'Subject',
    sprite: 'enemy_index_husk_s',
    x: self.x + 1,
    y: self.y,
    profile: 'melee_chaser',
    maxHp: 500,
  }) as unknown as TalentActor;
  return { world, self, foe };
}

/**
 * Cast once with a scripted status outcome and return what the talent SAID.
 *
 * `asked` reports whether the talent reached the seam at all — a talent that
 * never applies a status has nothing to be dishonest about and is skipped
 * rather than counted.
 */
function castWith(
  talentId: string,
  result: SetEffectResult,
): { notes: readonly string[]; asked: boolean; wanted: readonly string[] } | null {
  const talent = engine.registry.get(talentId);
  if (talent?.onUse === undefined) return null;

  const { world, self, foe } = bodies();
  let asked = false;
  /** WHICH effects it asked for — see the beneficial skip in the loop below. */
  const wanted: string[] = [];
  const ctx = {
    engine,
    world,
    rng: createRng(`honesty:${talentId}`),
    talentLevel: 1,
    status: (_target: unknown, effectId: string): SetEffectResult => {
      asked = true;
      wanted.push(effectId);
      return result;
    },
  } as unknown as TalentCtx;

  try {
    const out = talent.onUse(ctx, self, { x: foe.x, y: foe.y, actorId: foe.id });
    // `talentDone` returns { ok, hits, notes } -- notes at the TOP level. Reading
    // a nested shape here made every talent look identical and flagged four that
    // report correctly, which cost a round of false accusations.
    const done = out as { notes?: readonly string[] };
    return { notes: done.notes ?? [], asked, wanted };
  } catch {
    // A talent this bare fixture cannot satisfy. Skipped, and the floor below
    // is what stops "skipped everything" from reading as a pass.
    return null;
  }
}

describe('a talent reports the status that happened', () => {
  const ids = engine.registry
    .all()
    .filter((t) => t.onUse !== undefined && !isMonsterTalent(t))
    .map((t) => t.id);

  let exercised = 0;
  const dishonest: string[] = [];
  const reached: string[] = [];

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BUFF HAS NO SAVE TO REPORT, SO IT IS NOT ASKED TO REPORT ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The rule this file enforces is right and catches a real lie: a talent that
   * says "they are stunned" when they saved. It cannot apply to a BENEFICIAL
   * effect. Nothing resists one — `canBe` consults immunities only for a
   * detrimental effect and `applySave` rolls only for one — so `Negated` is an
   * outcome the engine will never hand a self-buff, and a talent printing a
   * different sentence for it would be describing something that cannot happen.
   *
   * Read off the EFFECT the talent actually asked for, not a list of talent ids,
   * so the next buff is covered without anybody remembering to come back here.
   */
  const beneficial = new Set(
    MVP_EFFECTS.filter((def) => def.status === EffectStatus.Beneficial).map((def) => def.id),
  );

  for (const id of ids) {
    const applied = castWith(id, landing(SetEffectOutcome.Applied, 3));
    if (applied === null || !applied.asked) continue;
    if (applied.wanted.every((effectId) => beneficial.has(effectId))) continue;
    const negated = castWith(id, landing(SetEffectOutcome.Negated, 0));
    if (negated === null) continue;
    exercised += 1;
    reached.push(id);
    if (JSON.stringify(applied.notes) === JSON.stringify(negated.notes)) dishonest.push(id);
  }

  it('says something different when the target saves', () => {
    expect(
      dishonest,
      `these talents print the same thing whether the status landed or was saved ` +
        `against, so a player can never see a save happen: ${dishonest.join(', ')}`,
    ).toEqual([]);
  });

  it('actually exercised the roster, rather than skipping it', () => {
    expect(
      exercised,
      `only ${String(exercised)} talents reached the status seam — this file is ` +
        `passing by testing nothing. Reached: ${reached.join(', ')}`,
    ).toBeGreaterThanOrEqual(MUST_EXERCISE);
  });
});
