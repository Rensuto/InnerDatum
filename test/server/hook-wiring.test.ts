import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { regenAt, walkItOff } from '../../src/server/talents/walk_it_off.ts';
import { talentLevelOf } from '../../src/server/engine/talents.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { trained } from '../helpers/trained.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES ANYTHING ACTUALLY CALL THE HOOKS? — the question nothing was asking.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fireTurnStart` was written, exported, given a context type and a dispatch
 * loop, and called by NOTHING — not the engine, not the scheduler, not a test,
 * not a tool. `walk_it_off.ts` sits in `GENERIC_PASSIVES`, the list every
 * character in this game carries, and promises *"you recover N hit points at
 * the start of each turn"*. Nobody ever recovered one.
 *
 * ═══ AND THERE WERE TESTS. THAT IS THE PART WORTH READING TWICE ═══
 * `nightshift.test.ts` covers this talent three times over — and each one calls
 *
 *     walkItOff.hooks?.onTurnStart?.(ctx)
 *
 * reaching into the module and invoking the hook by hand. Every one passes, and
 * every one would still pass if `fireTurnStart` were deleted outright. They
 * prove the hook BODY is correct, which it always was, and can say nothing at
 * all about whether the game runs it.
 *
 * `tools/status-live.mjs` names this exact trap in its own header: *"a test that
 * imports the module under test is exactly the thing that missed it."* It was
 * written after the status system shipped connected to nothing. This file is
 * that lesson applied one system along, and it goes through `engine.actBase` —
 * the real per-turn entry point — so it fails if the wiring is removed.
 *
 * See also the note in `engine/talents.ts` about `budgetPenalty`, which had zero
 * production callers and left SLOWED as a badge with no effect. Three instances
 * of one shape, in one engine.
 */
describe('the turn-start hooks are actually fired', () => {
  /** A Watchman with a wound, hooks hung on the body the way main.ts hangs them. */
  function woundedWatchman() {
    const world = createWorld('hook-wiring');
    const engine = createContentTalentEngine();
    const body = world.addPlayer('p1', 'Ren', { maxHp: WATCHMAN.maxHp });
    const sheet = engine.attach('p1', trained(sheetForClass(WATCHMAN)));

    /**
     * BOUND THE WAY `main.ts` BINDS THEM — `{ talentId, level, hooks }` hung on
     * the ACTOR, with the sheet's latch borrowed rather than copied. Building a
     * different shape here would be this file testing its own fixture.
     */
    body.talentHooks = [
      {
        talentId: walkItOff.id,
        level: talentLevelOf(sheet, walkItOff),
        hooks: walkItOff.hooks ?? {},
      },
    ];
    body.turnProcs = sheet.turnProcs;
    return { world, engine, body, sheet };
  }

  it('heals a wounded body through actBase, not through the talent object', () => {
    const { world, engine, body, sheet } = woundedWatchman();
    const level = talentLevelOf(sheet, walkItOff);
    expect(level, 'the fixture does not know Walk It Off').toBeGreaterThan(0);

    body.hp = body.maxHp - 20;
    const before = body.hp;

    // THE REAL PER-TURN ENTRY POINT. Nothing here touches `walkItOff.hooks`.
    engine.actBase('p1', world);

    expect(body.hp, 'the turn-start hook did not fire').toBe(before + regenAt(level));
  });

  /**
   * AND IT STOPS AT FULL. The talent heals to `min(maxHp, hp + n)`; a body one
   * point down must end the turn at exactly full rather than one point over,
   * which is the arithmetic `TalentActor.maxHp` was needed for.
   */
  it('never heals a body past its own ceiling', () => {
    const { world, engine, body } = woundedWatchman();
    body.hp = body.maxHp - 1;
    engine.actBase('p1', world);
    expect(body.hp).toBe(body.maxHp);
  });

  /**
   * AND A CORPSE DOES NOT MEND. The Downed system keeps a body on the board at
   * 0 hp, so a turn-start regen is a second, invisible exit from being down —
   * `walk_it_off.ts` guards it and `actBase` returns before this on a dead
   * actor. Both halves are asserted because either alone would look sufficient.
   */
  it('leaves a downed body on the floor', () => {
    const { world, engine, body } = woundedWatchman();
    body.hp = 0;
    body.alive = false;
    engine.actBase('p1', world);
    expect(body.hp, 'a body healed itself off the floor').toBe(0);
  });

  /**
   * A BODY WITH NO HOOKS IS UNTOUCHED, and byte-identically so. main.ts sets
   * `talentHooks` to `undefined` rather than `[]` precisely so a class with no
   * hooked talents composes as it did before hooks existed; the fire site has to
   * honour that or the guard is decoration.
   */
  it('does nothing at all to a body carrying no hooks', () => {
    const { world, engine, body } = woundedWatchman();
    body.talentHooks = undefined;
    body.hp = body.maxHp - 20;
    engine.actBase('p1', world);
    expect(body.hp).toBe(body.maxHp - 20);
  });
});
