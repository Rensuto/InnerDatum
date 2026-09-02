// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/timed_effects/mental.lua:67-87 (CONFUSED)
//                       game/modules/tome/class/Actor.lua:1316-1321 (the scrambled step)
//                       game/modules/tome/class/Actor.lua:5499-5504 (the talent that fails)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import {
  CONFUSE_FLOOR,
  CONFUSE_POWER,
  EffectId,
  createMvpEffectState,
} from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { grantImmunity, setEffect } from '../../src/server/engine/effects.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFUSED — THE FIRST STATUS THAT CHANGES WHAT AN ACTION DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other status in the game moves a number: Slowed a speed, Effaced eight
 * rolls, Breached an armour bound. A player reads those on their sheet. This one
 * is read on the FLOOR — you press east and go north-west — and it is the only
 * one whose whole expression is that the board did not do what you told it.
 *
 * ═══ IT IS DRIVEN THROUGH THE REAL ENTRY POINT, NOT THE ROLL ═══
 * The roll is four lines and testing it directly would prove nothing: the whole
 * risk here is the JOIN — a percentage that lives on a status table, folded into
 * a combat sheet by `recomputeAttributes`, read at intent resolution, turned
 * back into a direction. Every one of those halves can be right while the
 * feature does nothing. So these submit a move and read the tile the body is
 * standing on afterwards, which is what a player would do.
 */

function floor(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const effects = createMvpEffectState();
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    effects,
  });
  const body = world.addPlayer('p1', 'Detective', { maxHp: 500 });
  // MIDDLE OF AN OPEN ROOM, so a scrambled step is never refused by terrain and
  // the only thing that can move this body sideways is the confusion.
  body.x = 20;
  body.y = 20;
  engine.join('p1');
  engine.setConnected('p1', true);
  engine.pump();
  return { world, engine, body, effects };
}

/** Land the status the way a monster's `onHit` does — no save, so it always sticks. */
function confuse(world: World, effects: ReturnType<typeof createMvpEffectState>, body: unknown) {
  return setEffect(
    effects,
    body as never,
    EffectId.Confused,
    20,
    // NO `applyPower`, so there is no save to make: this file is about what
    // confusion DOES, and a fixture that let the target shrug it off half the
    // time would be measuring `applySave` instead.
    {},
    world.rng,
  );
}

/**
 * Pace east and west `steps` times, and report every distinct ROW the body stood
 * on.
 *
 * ═══ IT PACES RATHER THAN WALKING, AND THE FIRST VERSION DID NOT ═══
 * Forty steps due east from the middle of the default level runs off the end of
 * it, and a move into the edge is REFUSED — which refunds the turn. So the
 * fixture that measured "forty steps cost forty turns" measured twenty-one, and
 * the failure looked exactly like the stumble being refunded rather than held:
 * the right symptom for the wrong reason, which is the worst kind.
 *
 * Alternating keeps every move legal and inside the room, and the claim is
 * untouched: an east-west pace can never change `y` either.
 */
function pace(scene: ReturnType<typeof floor>, steps: number): Set<number> {
  const rows = new Set<number>();
  for (let i = 0; i < steps; i += 1) {
    scene.engine.submitMove('p1', i % 2 === 0 ? 'e' : 'w');
    scene.engine.commit('p1');
    scene.engine.pump();
    rows.add(scene.body.y);
  }
  return rows;
}

describe('a confused step is not the step you asked for', () => {
  it('takes a body off the row it was walking down', () => {
    /**
     * `Actor.lua:1316-1321` — the destination is replaced at the TOP of `move`,
     * before the bump, the swap and the terrain test:
     *
     *     if not force and self:attr("confused") then
     *       if rng.percent(self:attr("confused")) then
     *         x, y = self.x + rng.range(-1, 1), self.y + rng.range(-1, 1)
     *
     * Walking due east can never change `y`. So one row is the control's whole
     * answer and more than one is the mechanic, without this test having to know
     * which way any particular scramble went.
     */
    const scene = floor('confused-walk');
    const landed = confuse(scene.world, scene.effects, scene.body);
    expect(landed.dur, 'the status never landed, so nothing below means anything').toBeGreaterThan(
      0,
    );

    const rows = pace(scene, 40);
    expect(rows.size, 'forty paces and the body never left its row').toBeGreaterThan(1);
  });

  it('and an unconfused one walks a straight line, which is what makes that mean something', () => {
    // THE CONTROL. Without it the test above passes for a body that wanders for
    // any reason at all — a bug in `tryMove`, a fixture on rough ground, an
    // engine that ignores the direction it is handed.
    const scene = floor('unconfused-walk');
    expect(pace(scene, 40)).toEqual(new Set([20]));
  });

  it('spends the turn when the stumble goes nowhere, rather than refunding it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE NINTH OUTCOME, AND WHY IT IS A HOLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream draws TWO independent offsets in [-1, 1], so both can come up
     * zero and the body walks onto its own tile — moved, energy spent, nowhere
     * gained. Our resolution layer has only two shapes for a step, and the wrong
     * one is tempting: a REFUSAL costs zero and re-prompts (the refund rule), so
     * expressing the stumble that way would make confusion a free re-roll —
     * press again, roll again, until it works. That is the opposite of the
     * mechanic.
     *
     * MEASURED BY THE CLOCK. Forty steps must cost forty turns whether they went
     * anywhere or not; a refunded stumble would cost fewer.
     */
    const scene = floor('confused-stumble');
    confuse(scene.world, scene.effects, scene.body);
    const before = scene.world.turn.clock.gameTurn;
    pace(scene, 40);
    expect(scene.world.turn.clock.gameTurn - before).toBe(40);
  });
});

describe('the die is only rolled when there is something to roll', () => {
  it('consumes no draw from a body that is not confused', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PROPERTY THAT MAKES THIS STATUS FREE TO ADD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every draw in this engine is labelled and the stream is seeded, so a new
     * roll in a hot path SHIFTS EVERY SUBSEQUENT DRAW for every existing seed —
     * loot, crits, monster targeting, the moor. `confusionTakes` returns before
     * touching the rng when the percentage is zero, which is what keeps that
     * from happening, and it is exactly the kind of guard that gets deleted as
     * a tidy-up by somebody who reads it as a micro-optimisation.
     */
    const scene = floor('no-confusion-no-draw');
    const before = JSON.stringify(scene.world.rng.getState());
    pace(scene, 20);
    expect(JSON.stringify(scene.world.rng.getState())).toBe(before);
  });
});

describe('the chance is upstream’s, and it comes off the status', () => {
  it('is the fifty percent mental.lua:74 declares, bounded by mental.lua:79', () => {
    // Upstream's `parameters = { power = 50 }`, and its `activate` bounds any
    // rolled power to `util.bound(eff.power, 0, 50)` — so fifty is both the
    // default and the ceiling ToME will ever apply.
    expect(CONFUSE_POWER).toBe(50);
  });

  it('reaches the combat sheet as a percentage, not as a flag', () => {
    /**
     * THE JOIN, ASSERTED ON ITS OWN because it is the one link with no visible
     * symptom when it breaks: `recomputeAttributes` folds `confusedPercent` into
     * `StatusFlags.confused`, and a fold that dropped it would leave a badge on
     * screen, a description in the tooltip, and a body that walks perfectly
     * straight. That is the shape of the wiring bug this codebase has now hit
     * nine times.
     */
    const scene = floor('confused-sheet');
    expect(scene.body.combat?.flags?.confused ?? 0).toBe(0);
    confuse(scene.world, scene.effects, scene.body);
    expect(scene.body.combat?.flags?.confused).toBe(CONFUSE_POWER);
  });
});

// ---------------------------------------------------------------------------
// The other consumer: a talent that fails, for its full turn
// ---------------------------------------------------------------------------

/**
 * A Watchman in reach of something that cannot die, and a talent with no
 * cooldown to get in the way (`crude_blow`, `cooldownTurns: 0`).
 */
function brawl(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const effects = createMvpEffectState();
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    effects,
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });
  const body = world.addPlayer('p1', 'Detective', { maxHp: 500 });
  body.x = 4;
  body.y = 4;
  talents.attach('p1', sheetForClass(WATCHMAN));
  engine.join('p1');
  engine.setConnected('p1', true);
  // UNKILLABLE, so every swing of the run lands on the same body and the count
  // is not cut short by the fight ending.
  const foe = world.addMonster('foe', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 5,
    y: 4,
    profile: AiProfile.MeleeChaser,
    maxHp: 999_999,
  });
  engine.pump();
  return { world, engine, body, foe, effects };
}

/**
 * Swing `times`, and report how many swings actually resolved.
 *
 * ═══ A HOLD BETWEEN SWINGS, AND IT IS NOT PADDING ═══
 * `crude_blow` costs 3 AP against a budget of 6, so a Watchman gets exactly two
 * per game turn and the third comes back `no_resource` — the first version of
 * this helper counted that refusal as a confused fizzle and made the whole test
 * a measurement of the AP budget. Passing the turn puts every attempt on a full
 * budget, so the only thing that can stop one is the status.
 *
 * COUNTS `talent` EVENTS, which is what a resolved talent emits. (`used` is what
 * this looked for first, and it does not exist: the count came back zero for the
 * CONTROL as well, which is the only reason it was caught.)
 */
function swing(scene: ReturnType<typeof brawl>, times: number): number {
  let landed = 0;
  for (let i = 0; i < times; i += 1) {
    scene.engine.submitTalent('p1', 'talent:crude_blow', { x: scene.foe.x, y: scene.foe.y });
    scene.engine.commit('p1');
    for (const ev of scene.engine.pump().playerEvents) {
      if (ev.k === 'talent') landed += 1;
    }
    // AND PASS THE TURN, so the next attempt starts with its AP back.
    scene.engine.hold('p1');
    scene.engine.commit('p1');
    scene.engine.pump();
  }
  return landed;
}

describe('a confused talent fails, and the turn goes with it', () => {
  it('lands fewer swings than the same body would unconfused', () => {
    /**
     * `Actor.lua:5499-5504` — the roll sits inside `preUseTalent`, ahead of
     * everything the talent would have done:
     *
     *     if rng.percent(self:attr("confused")) then
     *       game.logSeen(self, "%s is confused and fails to use %s.", ...)
     *       self:useEnergy()
     *       return false
     *
     * MEASURED AGAINST A CONTROL rather than against a number, because the
     * chance is a die: what the port claims is that confusion COSTS you swings,
     * and at fifty percent over forty attempts the gap is not a coincidence.
     *
     * ═══ AND THE TURN IS STILL SPENT — `self:useEnergy()` ═══
     * That half is asserted at the movement site ("spends the turn when the
     * stumble goes nowhere"), because both fizzles return the same
     * `{ kind: 'hold' }` and the clock is legible there: a swing chains inside
     * its own turn while AP lasts, so counting game turns around one would
     * measure the AP budget rather than the refund rule. The reason it must not
     * be a refusal is the same in both places — `submitTalent` is free and
     * re-prompts, so a roll checked there would be a roll you could press again.
     */
    const clear = brawl('swing-clear');
    const clearLanded = swing(clear, 40);
    expect(clearLanded, 'the control never swung at all — the fixture is broken').toBeGreaterThan(
      0,
    );

    const muddled = brawl('swing-confused');
    confuse(muddled.world, muddled.effects, muddled.body);
    const muddledLanded = swing(muddled, 40);

    expect(muddledLanded, 'confusion cost the caster nothing').toBeLessThan(clearLanded);
  });
});

// ---------------------------------------------------------------------------
// Immunity — mental.lua:78-79, the subtype that pays twice
// ---------------------------------------------------------------------------

/**
 * Apply until it sticks, and report the power that landed.
 *
 * ═══ THE RETRY IS THE POINT, NOT A WORKAROUND ═══
 * Confusion immunity feeds `canBe` as well, so an immune body REFUSES some
 * applications outright — that is the first of its two payments and is already
 * covered by `immunity.test.ts`. This file is about the second, so it keeps
 * asking until one lands and then reads how strong it was.
 */
function landedPower(scene: ReturnType<typeof floor>, asked?: number): number {
  for (let i = 0; i < 200; i += 1) {
    const out = setEffect(
      scene.effects,
      scene.body,
      EffectId.Confused,
      20,
      asked === undefined ? {} : { power: asked },
      scene.world.rng,
    );
    if (out.dur > 0) return scene.body.combat?.flags?.confused ?? 0;
  }
  throw new Error('two hundred applications and none of them landed');
}

describe('confusion immunity makes it weaker as well as rarer', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `mental.lua:78-79` — THE ONLY IMMUNITY IN THE GAME THAT PAYS TWICE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *     eff.power = math.floor(math.max(eff.power - (self:attr("confusion_immune") or 0) * 100, 10))
   *     eff.power = util.bound(eff.power, 0, 50)
   *
   * Every other subtype only feeds `canBe`: a chance the status does not land.
   * Against a base chance of fifty percent that alone would make twenty points
   * of immunity worth almost nothing — a fifth of the landings refused and no
   * difference whatever to the four fifths that stick. This is what makes
   * ` of Plain Reading` worth a slot.
   */
  it('lands at fifty on a body with no immunity, which is the control', () => {
    const scene = floor('confuse-bare');
    expect(landedPower(scene)).toBe(CONFUSE_POWER);
  });

  it('subtracts the immunity from the power that lands', () => {
    const scene = floor('confuse-immune');
    grantImmunity(scene.effects, 'p1', 'confusion', 20);
    expect(landedPower(scene)).toBe(CONFUSE_POWER - 20);
  });

  it('never grinds it below ten, however much is worn', () => {
    /**
     * `math.max(..., 10)`. Total immunity comes from `canBe` refusing the effect
     * outright, never from taking the power to nothing — keeping the two apart
     * is what stops one deep affix from quietly deleting a status the bestiary
     * is built around.
     *
     * NINETY RATHER THAN A HUNDRED, because at a hundred `canBe` refuses every
     * application and the loop above would never find one to measure. That is
     * the separation working, and it is why this asks at ninety.
     */
    const scene = floor('confuse-floored');
    grantImmunity(scene.effects, 'p1', 'confusion', 90);
    expect(landedPower(scene)).toBe(CONFUSE_FLOOR);
  });

  it('and the ceiling still bounds a caller who asked for more', () => {
    // `util.bound(eff.power, 0, 50)` runs AFTER the subtraction, so it bounds
    // the CALLER rather than the immunity's work.
    const scene = floor('confuse-ceiling');
    expect(landedPower(scene, 90)).toBe(CONFUSE_POWER);
  });
});
