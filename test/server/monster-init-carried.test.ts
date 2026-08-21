// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   NOTHING A TEMPLATE SAYS IS DROPPED ON THE WAY TO THE BODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE BUG THIS EXISTS FOR ═══
 * `MonsterTemplate.talents` was added, `monsterInit` returned it, and
 * `createMonsterActor` never named it — so every creature in the game was built
 * with `talents: undefined` and no monster could cast anything. Typecheck, lint,
 * 3390 tests and the smoke test were all green, because there is nothing for any
 * of them to catch: an object literal that omits an OPTIONAL field is a
 * perfectly good object literal.
 *
 * ═══ WHY THE CONSTRUCTOR IS STILL RIGHT TO BUILD FIELD BY FIELD ═══
 * The obvious fix is `...init`, and it would be worse. A spread puts whatever
 * `content/` happened to invent onto a live actor: a typo'd key, a field meant
 * for the spawner, an authoring note. Every actor in this engine is constructed
 * explicitly for that reason, and the entire cost of the policy is this one
 * failure mode — a field that is named in exactly one of the two places.
 *
 * So the policy stays and this test pays its cost, ONCE, mechanically.
 *
 * ═══ AND IT IS DRIVEN FROM REAL CONTENT, WHICH IS THE ONLY PART THAT MATTERS ═══
 * The tempting version of this test hand-writes an init object with every field
 * set. That version rots into the exact bug it is guarding against: someone adds
 * a field to `MonsterInit`, does not add it to the fixture, and the test passes
 * while covering nothing — a test authored against a system nobody updates, one
 * more of the shape this codebase has now found seven times.
 *
 * Driving it from `MONSTER_TEMPLATES` means the covered set is *whatever the
 * bestiary actually authors*. A field nothing sets is not covered, and correctly
 * so: it cannot be dropped on the way to a body that never asked for it. The
 * moment a template does set it, this test starts checking it, with nobody
 * having to remember anything.
 */

import { describe, expect, it } from 'vitest';

import { createMonsterActor } from '../../src/server/engine/actor.ts';
import { MONSTER_TEMPLATES, monsterInit } from '../../src/server/content/monsters.ts';

/** A mid-depth spawn, so level-scaled fields resolve to something real. */
const LEVEL = 5;
const AT = { x: 4, y: 4 };

/**
 * WHERE A CARRIED FIELD IS ALLOWED TO LAND.
 *
 * Top level, or on the actor's `ai` block — the profile and its four ranges
 * live there because they are read together every turn by `decideNpcAction`,
 * and hoisting them would put nine AI fields on a body that has eleven of its
 * own. Both are "carried"; neither is a drop.
 */
function carries(actor: Record<string, unknown>, key: string): boolean {
  if (key in actor) return true;
  const ai: unknown = actor['ai'];
  return typeof ai === 'object' && ai !== null && key in ai;
}

describe('every field a monster template authors reaches the actor', () => {
  it.each(MONSTER_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s',
    (_id, template) => {
      const init = monsterInit(template, AT, LEVEL);
      const actor = createMonsterActor('probe', init) as unknown as Record<string, unknown>;

      const dropped = Object.keys(init).filter((key) => !carries(actor, key));
      /**
       * THE FAILURE MESSAGE NAMES THE FIX, because the fix is never obvious from
       * the symptom. A dropped field shows up in play as a creature that
       * silently does not do the thing it was authored to do — which is
       * indistinguishable from a creature choosing not to.
       */
      expect(
        dropped,
        `createMonsterActor drops ${dropped.join(', ')} — name the field in the constructor, ` +
          `not just on MonsterInit. The template sets it and the body never sees it.`,
      ).toEqual([]);
    },
  );

  /**
   * AND THE ONE THAT STARTED IT, PINNED BY NAME.
   *
   * The loop above is the general guard; this is the specific regression. If
   * `talents` ever stops reaching the body again, the failure should say
   * `talents` rather than making somebody read a list.
   */
  it('carries talents onto the creatures that author them', () => {
    const armed = MONSTER_TEMPLATES.filter((template) => template.talents !== undefined);
    expect(armed.length).toBeGreaterThan(0);
    for (const template of armed) {
      const actor = createMonsterActor('probe', monsterInit(template, AT, LEVEL));
      expect('talents' in actor ? actor.talents : undefined).toEqual(template.talents);
    }
  });
});
