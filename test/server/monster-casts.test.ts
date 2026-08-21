// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A CREATURE ACTUALLY CASTS. End to end, through the real scheduler.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS FILE EXISTS, WHICH IS THE ONLY INTERESTING THING ABOUT IT ═══
 * Monster talents were built in one sitting: a talent authored, a `castable`
 * seam on `TalentResolution`, an `AiCtx` that could reach it, a cast branch in
 * `decideNpcAction`, a lazy sheet attach, and `MonsterTemplate.talents` naming
 * `grasping_hold` on the Index Wraith. Every piece was correct. The full gate
 * was green — 160 files, 3390 tests, typecheck, lint, smoke.
 *
 * And no monster could cast anything, because `createMonsterActor` builds its
 * body FIELD BY FIELD and nobody had added `talents` to the constructor. The
 * template carried it, `monsterInit` returned it, tsc had no complaint to make,
 * and `wraith.talents` was `undefined` in a live fight.
 *
 * ═══ THE FAILURE MODE IS ALWAYS THE SAME AND IT IS NEVER A BROKEN PART ═══
 * Five times before this the shape was a field nobody sets or a system nothing
 * reaches: `Talent.tier` on 0 of 42 talents, `monsterInit`'s level parameter
 * with 0 callers, `TalentTree.mastery` at 1.0 everywhere, `Talent.sustain` on
 * nothing, and monster talents having no path at all. Every unit test passed
 * every time, because a unit test asks whether a part works and the part always
 * worked. What was missing was the WIRE.
 *
 * So this file tests no part. It builds the world the server builds, pumps the
 * scheduler the server pumps, and asks the only question that matters: did the
 * thing happen. A test that mocks `castable` would have passed on the broken
 * build, which is the entire reason it does not.
 */

import { describe, expect, it } from 'vitest';

import { IntentKind } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { MONSTER_TEMPLATES, monsterInit } from '../../src/server/content/monsters.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { SweepStep } from '../../src/server/engine/scheduler.ts';
import type { World } from '../../src/server/world/world.ts';

/** Long enough that a 40%-per-turn draw on a 5-turn cooldown is a certainty. */
/** Long enough that a 40%-per-turn draw on a long cooldown is a certainty. */
const TURNS = 60;
const MS_PER_PUMP = 100;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR APART A FIGHT STARTS — every creature's own `aggroRange`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THIS WAS 2, AND 2 IS NOT A FIGHT, IT IS THE MIDDLE OF ONE ═══
 * Two tiles is fine for a talent with melee reach and useless for a creature
 * whose talent is CLOSING that distance. The Index Eidolon's Rush carries
 * `minRange: 2` — deliberately, since a charge usable from touching distance is
 * a free extra swing wearing a charge's citation — so a melee chaser dropped
 * two tiles away steps into contact on its first turn and is never again in a
 * position to use the one talent it owns. It failed this test, correctly.
 *
 * ═══ AND THE FIX IS NOT TO LOOSEN THE TEST ═══
 * That is worth writing down, because the tempting repair was to drop
 * `minRange` and let Rush fire at melee — which would have made the assertion
 * pass by making the talent wrong.
 *
 * Eight is where a fight with these creatures ACTUALLY BEGINS: every template
 * in the bestiary carries `aggroRange: 8`, so this is the range at which the
 * AI first notices you, not a generous number chosen to accommodate a talent.
 * A kiter backs off to its preferred range from here, a chaser closes, and a
 * charger gets the approach its whole design is about. Starting anywhere nearer
 * tests one profile properly and the other two mid-fight.
 */
const APART = 8;

/** Enough hit points that we are measuring a fight rather than a corpse. */
const PLAYER_HP = 100_000;

/** A mid-depth spawn, so level-scaled numbers resolve to something real. */
const LEVEL = 5;

/**
 * RUN THE FIGHT AND KEEP EVERY STEP THE MONSTERS TOOK.
 *
 * ═══ THE DETECTIVE HOLDS EVERY TURN, AND SHE HAS TO ═══
 * The barrier will not release a turn until every living player has committed
 * something. The first version of this helper just called `pump` forty times
 * and asserted on the result — it produced one `engagement`, one
 * `turn_ended` and no monster steps whatsoever, because the turn never
 * advanced past the first. Forty pumps of a fight that had not started, and the
 * only symptom was an empty array that read exactly like a monster declining to
 * cast.
 *
 * Holding is also the honest test: the creature gets its chance to act while
 * the player does nothing to stop it.
 */
function everyStep(world: World, turns: number): SweepStep[] {
  const barrier = createBarrier();
  const talents = talentRuntimeFor(createContentTalentEngine(), world);
  const steps: SweepStep[] = [];
  for (let i = 0; i < turns; i += 1) {
    submitIntent(world, barrier, 'p1', { kind: IntentKind.Hold });
    const result = pump(world, { nowMs: i * MS_PER_PUMP, barrier, talents });
    for (const event of result.events) {
      if (event.t === 'sweep') steps.push(...event.steps);
    }
  }
  return steps;
}

/**
 * A DETECTIVE AND ONE CREATURE, ON OPEN GROUND, AT `APART` TILES.
 *
 * See `APART` for why that distance and not a closer one — it is the range a
 * fight with any of these creatures actually starts at.
 */
function standoff(seed: string, template: MonsterTemplate): World {
  const world = createWorld(seed);
  const player = world.addPlayer('p1', 'Detective');
  player.maxHp = PLAYER_HP;
  player.hp = PLAYER_HP;
  world.addMonster('m1', monsterInit(template, { x: player.x + APART, y: player.y }, LEVEL));
  return world;
}

/** Every creature the bestiary has actually armed. */
const ARMED = MONSTER_TEMPLATES.filter((template) => template.talents !== undefined);

describe('every armed creature casts, in a real fight', () => {
  it('has creatures to test', () => {
    expect(ARMED.length).toBeGreaterThan(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ASSERTION THIS WHOLE FILE IS FOR, RUN ONCE PER ARMED CREATURE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Nothing is stubbed: the real content engine, the real AI, the real
   * scheduler, the real lazy sheet attach. If any link is cold, this fails.
   *
   * ═══ AND IT CATCHES THE MISTAKE THAT IS NOT A BUG ═══
   * Grasping Hold was authored onto the Index Wraith — a `RangedKiter` with
   * `attackRange: 6`, against a talent reaching 1.5. Every part worked. The AI
   * was offered the option every turn and `canUseTalent` refused it on range
   * every turn, and nothing anywhere reported a problem, because a creature
   * that CANNOT use its talent is indistinguishable from one that chose not to.
   *
   * Iterating `MONSTER_TEMPLATES` rather than naming creatures is what makes
   * that permanent: arm a creature with something it can never be in position
   * to use, and this test says so on the next run.
   */
  it.each(ARMED.map((template) => [template.displayName, template] as const))(
    '%s',
    (_name, template) => {
      const steps = everyStep(standoff(`cast-${template.id}`, template), TURNS);
      const casts = steps.filter((step) => step.t === 'talent');
      expect(
        casts.length,
        `${template.displayName} never cast anything in ${String(TURNS)} turns. Its talents are ` +
          `${(template.talents ?? []).join(', ')} — check the talent's range against this ` +
          `creature's profile and attackRange before checking anything else.`,
      ).toBeGreaterThan(0);
      for (const cast of casts) {
        expect(cast.id).toBe('m1');
        expect(template.talents).toContain(cast.talentId);
      }
    },
  );

  /**
   * A CAST THAT DEALS DAMAGE IS FOLLOWED BY ITS DAMAGE.
   *
   * `sweepStepFor` returned a bare `hold` for a monster's talent until this
   * work — a cast rendered as "it stood there". One stamp then one `attack` per
   * victim is the shape the player lane has always used, and both map to the
   * identical `{ k: 'talent' }` wire event.
   *
   * THE GLUT SPECIFICALLY, because Efface deals no damage on purpose and would
   * be a legitimate counter-example. A talent that hits is the case under test.
   */
  it('follows a damaging stamp with an ordinary attack step', () => {
    const glut = ARMED.find((template) => template.id === 'index_glut');
    expect(glut).toBeDefined();
    if (glut === undefined) return;
    const steps = everyStep(standoff('damage', glut), TURNS);
    const at = steps.findIndex((step) => step.t === 'talent');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(steps[at + 1]?.t).toBe('attack');
  });

  /**
   * A CREATURE THAT KNOWS NOTHING IS UNTOUCHED BY ANY OF THIS.
   *
   * The plain husks are most of the bestiary and were never meant to change.
   * `ensureMonsterSheet` returns early on an absent list, so a husk never builds
   * a sheet at all — and if this ever fails, the cost is not a husk that casts,
   * it is a husk paying for a sheet every turn forever.
   */
  it('leaves a creature with no talents alone', () => {
    const bare = MONSTER_TEMPLATES.find((template) => template.talents === undefined);
    expect(bare).toBeDefined();
    if (bare === undefined) return;
    const world = standoff('bare', bare);
    const actor = world.getActor('m1');
    expect(actor !== undefined && 'talents' in actor ? actor.talents : undefined).toBeUndefined();
    expect(everyStep(world, TURNS).filter((step) => step.t === 'talent')).toHaveLength(0);
  });
});
