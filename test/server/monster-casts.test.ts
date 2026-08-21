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
import { INDEX_GLUT, monsterInit } from '../../src/server/content/monsters.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { graspingHold } from '../../src/server/talents/monster.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { SweepStep } from '../../src/server/engine/scheduler.ts';

/** Long enough that a 40%-per-turn draw on a 5-turn cooldown is a certainty. */
const TURNS = 40;
const MS_PER_PUMP = 100;

/** Enough hit points that we are measuring a fight rather than a corpse. */
const PLAYER_HP = 100_000;

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
function everyStep(world: ReturnType<typeof createWorld>, turns: number): SweepStep[] {
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
 * A DETECTIVE AND A GLUT, TWO TILES APART.
 *
 * The Glut rather than the wraith, and that is the second half of this file's
 * story. Grasping Hold was authored onto the Index Wraith, which is a
 * `RangedKiter` with `attackRange: 6` against a talent that reaches 1.5 — it
 * kites for a living and never closes, so the AI was offered the option every
 * turn and refused it on range every turn. The Glut is a `MeleeChaser` that
 * arrives, which is the only kind of creature this talent was ever about.
 */
function standoff(seed: string): ReturnType<typeof createWorld> {
  const world = createWorld(seed);
  const player = world.addPlayer('p1', 'Detective');
  player.maxHp = PLAYER_HP;
  player.hp = PLAYER_HP;
  world.addMonster('w1', monsterInit(INDEX_GLUT, { x: player.x + 2, y: player.y }, 5));
  return world;
}

describe('a creature casts its talent in a real fight', () => {
  /**
   * THE BODY CARRIES WHAT THE TEMPLATE NAMED.
   *
   * This is the assertion that was false while everything else was true, and it
   * is one line because the bug was one missing line. `createMonsterActor`
   * constructs field by field — the right call, since a spread would put
   * anything `content/` invented onto a live actor — so a field it does not
   * name is dropped in silence with nothing to typecheck against.
   */
  it('puts the template talents on the actor', () => {
    const world = standoff('carry');
    const glut = world.getActor('w1');
    expect(glut?.kind).toBe('monster');
    expect(glut !== undefined && 'talents' in glut ? glut.talents : undefined).toEqual([
      graspingHold.id,
    ]);
  });

  /**
   * AND IT ACTUALLY PRESSES IT. The whole point.
   *
   * Nothing here is stubbed: the real content engine, the real AI, the real
   * scheduler, the real sheet attach. If any single link in that chain is cold,
   * this fails — which is exactly what it is for.
   */
  it('emits a talent step, from the creature, for the talent it knows', () => {
    const steps = everyStep(standoff('cast'), TURNS);
    const casts = steps.filter((step) => step.t === 'talent');
    expect(casts.length).toBeGreaterThan(0);
    for (const cast of casts) {
      expect(cast.id).toBe('w1');
      expect(cast.talentId).toBe(graspingHold.id);
    }
  });

  /**
   * THE STAMP IS FOLLOWED BY ITS DAMAGE, rather than swallowing it.
   *
   * `sweepStepFor` returned a bare `hold` for a monster's talent until this
   * work — a cast rendered as "it stood there". One stamp then one `attack` per
   * victim is the shape the player lane has always used, and both now map to
   * the identical `{ k: 'talent' }` wire event, so the client draws a creature's
   * cast with no new code and no protocol bump.
   */
  it('follows the stamp with an ordinary attack step', () => {
    const steps = everyStep(standoff('damage'), TURNS);
    const at = steps.findIndex((step) => step.t === 'talent');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(steps[at + 1]?.t).toBe('attack');
  });

  /**
   * A CREATURE THAT KNOWS NOTHING IS UNTOUCHED BY ANY OF THIS.
   *
   * The husks are the overwhelming majority of the bestiary and they were never
   * meant to change. `ensureMonsterSheet` returns early on an absent list, so a
   * husk never builds a sheet at all — and if this ever fails, the cost is not
   * a husk that casts, it is a husk that pays for a sheet every turn forever.
   */
  it('leaves a creature with no talents alone', () => {
    const world = createWorld('husk');
    const player = world.addPlayer('p1', 'Detective');
    player.maxHp = PLAYER_HP;
    player.hp = PLAYER_HP;
    world.addMonster('h1', {
      name: 'Index Husk',
      sprite: 'sprite_husk',
      x: player.x + 2,
      y: player.y,
      profile: 'melee_chaser',
    });
    const husk = world.getActor('h1');
    expect(husk !== undefined && 'talents' in husk ? husk.talents : undefined).toBeUndefined();
    expect(everyStep(world, TURNS).filter((step) => step.t === 'talent')).toHaveLength(0);
  });
});
