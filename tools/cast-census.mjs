// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS EACH ARMED CREATURE OFFERED, AND WHAT DID IT TAKE?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/server/monster-casts.test.ts` asks whether a creature casts AT ALL,
 * which is the question that mattered when nothing could. It cannot see the
 * two failures that are left:
 *
 *   OFFERED AND NEVER TAKEN. A creature armed with two talents takes the FIRST
 *   legal one — `castable` returns them in template order and the AI obeys that
 *   order deliberately, so an author can express a preference without a scoring
 *   function. The cost of that rule is that a SECOND talent whose window is a
 *   subset of the first's is dead on arrival, and nothing anywhere says so.
 *   The Index Husk Elite is the only creature carrying two.
 *
 *   OFFERED ALMOST NEVER. The Index Eidolon's Rush was legal on seven turns out
 *   of 287 turns of fighting, because its window is `minRange` to `range` and
 *   BOTH bodies close through it. A flat cadence roll against a window that
 *   narrow deletes fights, which is what `Talent.closesIn` exists to answer —
 *   and the only reason anybody found it was a hand-written trace.
 *
 * ═══ IT WRAPS `castable` RATHER THAN SAMPLING BETWEEN TURNS ═══
 * THIS IS THE WHOLE TRICK AND THE FIRST VERSION GOT IT WRONG. A creature with
 * `globalSpeed` above 1 can MOVE and then CAST inside one turn, so a probe that
 * asks "what is legal now" once per turn is asking at a position the AI never
 * decided from. Measured that way the Eidolon's Rush looked legal on ZERO turns
 * in twenty-four fights — while casting in all twenty-four.
 *
 * Every call to `castable` IS a decision point, by construction: `decideNpcAction`
 * calls it exactly once, at the moment it chooses. So the wrapper records the
 * truth and cannot drift from it.
 *
 * ═══ NOT PART OF `npm run verify` ═══
 * `verify` is live probes over a real socket. This is an offline simulation of
 * many fights, it takes about a minute, and its output is a table to READ
 * rather than a pass/fail. Run it when a creature is armed or a talent's
 * targeting changes.
 *
 *     node tools/cast-census.mjs [seeds]
 *
 * ═══ WHAT IT SAID ON 2026-09-06, twelve fights each ═══
 *
 *     breaching_blow  offered 176  taken  76   43%
 *     bear_down       offered 413  taken 115   28%
 *     rush            offered  12  taken  12  100%
 *     grasping_hold   offered 242  taken 102   42%
 *     uncorroborated  offered 161  taken  66   41%
 *     efface          offered 150  taken  65   43%
 *     clear_the_altar offered 192  taken  81   42%
 *
 * Nothing flagged. Three things in that table are worth knowing:
 *
 *   ~42% IS `CAST_CHANCE`, arriving where it should. A column that drifts off
 *   it without the constant moving means something is refusing casts that the
 *   AI thinks it is making.
 *
 *   BEAR DOWN AT 28% IS THE ORDERING RULE, VISIBLE. The Overwritten Husk is the
 *   only creature carrying two talents, and `breaching_blow` is first in its
 *   template, so on the turns both are legal the second one loses. That is the
 *   rule working as written — it is only a problem if the number reaches zero.
 *
 *   RUSH AT 12/12 IS `closesIn`. Exactly one legal turn per fight and it is
 *   taken every time; before that flag it was 20 of 24 fights, and four fights
 *   in twenty-four had no charge at all.
 */

import { IntentKind } from '../src/server/engine/actor.ts';
import { createBarrier } from '../src/server/engine/barrier.ts';
import { createMvpEffectState } from '../src/server/content/effects.ts';
import { statusApplier } from '../src/server/engine/effects.ts';
import { pump, submitIntent } from '../src/server/engine/scheduler.ts';
import { dirToward } from '../src/server/engine/talents.ts';
import { createContentTalentEngine } from '../src/server/content/classes.ts';
import { MONSTER_TEMPLATES, monsterInit } from '../src/server/content/monsters.ts';
import { talentRuntimeFor } from '../src/server/main.ts';
import { createWorld } from '../src/server/world/world.ts';

/** The arena is monster-casts.test.ts's, so the numbers are comparable to it. */
const APART = 8;
const LEVEL = 5;
const PLAYER_HP = 100_000;
const TURNS = 60;

const SEEDS = Number(process.argv[2] ?? 12);

const ARMED = MONSTER_TEMPLATES.filter((template) => template.talents !== undefined);

/** One creature, `SEEDS` fights. Returns per-talent offered/taken counts. */
function census(template) {
  const offered = new Map();
  const taken = new Map();
  for (const id of template.talents ?? []) {
    offered.set(id, 0);
    taken.set(id, 0);
  }
  let decisions = 0;
  let turnsAlive = 0;

  for (let seed = 0; seed < SEEDS; seed += 1) {
    const world = createWorld(`census-${template.id}-${String(seed)}`);
    const player = world.addPlayer('p1', 'Detective');
    player.maxHp = PLAYER_HP;
    player.hp = PLAYER_HP;
    world.addMonster('m1', monsterInit(template, { x: player.x + APART, y: player.y }, LEVEL));

    const barrier = createBarrier();
    const effects = createMvpEffectState();
    const runtime = talentRuntimeFor(
      createContentTalentEngine(),
      world,
      statusApplier(effects, world.rng),
    );

    /**
     * THE DECISION POINT, RECORDED WHERE IT HAPPENS. `decideNpcAction` calls
     * this exactly once per monster per turn and chooses from what comes back,
     * so counting here cannot disagree with what the AI saw.
     */
    const inner = runtime.castable;
    const talents = {
      ...runtime,
      castable: (self, target) => {
        const options = inner(self, target);
        decisions += 1;
        for (const option of options) {
          offered.set(option.talentId, (offered.get(option.talentId) ?? 0) + 1);
        }
        return options;
      },
    };

    for (let i = 0; i < TURNS; i += 1) {
      const p = world.getActor('p1');
      const m = world.getActor('m1');
      if (p === undefined || m === undefined || !m.alive) break;
      turnsAlive += 1;
      const dir = dirToward(p, m);
      submitIntent(
        world,
        barrier,
        'p1',
        dir === null ? { kind: IntentKind.Hold } : { kind: IntentKind.Move, dir },
      );
      const result = pump(world, { nowMs: i * 100, barrier, talents });
      for (const event of result.events) {
        if (event.t !== 'sweep') continue;
        for (const step of event.steps) {
          if (step.t === 'talent' && step.talentId !== undefined) {
            taken.set(step.talentId, (taken.get(step.talentId) ?? 0) + 1);
          }
        }
      }
    }
  }
  return { offered, taken, decisions, turnsAlive };
}

console.log(
  `cast census — ${String(ARMED.length)} armed creature(s), ${String(SEEDS)} fights each`,
);
console.log(`(offered = turns the AI was handed it; taken = turns it chose it)\n`);

const flags = [];
for (const template of ARMED) {
  const { offered, taken, decisions, turnsAlive } = census(template);
  console.log(
    `${template.displayName}  —  ${String(turnsAlive)} turns, ${String(decisions)} decisions`,
  );
  for (const id of template.talents ?? []) {
    const o = offered.get(id) ?? 0;
    const t = taken.get(id) ?? 0;
    const rate = o === 0 ? '   —' : `${String(Math.round((t / o) * 100)).padStart(3)}%`;
    console.log(
      `    ${id.padEnd(26)} offered ${String(o).padStart(4)}   taken ${String(t).padStart(4)}   ${rate}`,
    );
    // NEVER OFFERED is the Grasping Hold shape: armed with something the
    // creature can never be in position to use. The test file catches this one
    // already, and it is repeated here because this is the report somebody
    // reads when they arm a creature.
    if (o === 0) flags.push(`${template.displayName}: ${id} was NEVER LEGAL in any fight`);
    // OFFERED AND NEVER TAKEN is the one nothing else can see.
    else if (t === 0)
      flags.push(`${template.displayName}: ${id} was legal ${String(o)}x and NEVER CHOSEN`);
  }
  console.log('');
}

if (flags.length === 0) {
  console.log(
    'nothing to flag: every armed talent was legal at some point and chosen at some point.',
  );
} else {
  console.log('FLAGS');
  for (const flag of flags) console.log(`  ${flag}`);
}
