// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INFUSION SATURATION — Actor.lua:5850-5859 and :6356-6358, both halves.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every infusion in this game costs `ap: 0`, faithfully, because upstream's are
 * `no_energy = true`. The tuning that makes that safe is the OTHER half, and it
 * shipped without it: each use adds a stacking effect, and that effect's power
 * is added to every infusion's cooldown. Take the free button without the tax
 * and a character with three infusions fires all three the moment they are up,
 * every time, and the cooldowns never grow.
 *
 * ═══ DRIVEN THROUGH `talentRuntimeFor`, NOT THROUGH THE PARTS ═══
 * The mechanic is a JOIN across five layers — `useTalent` calls
 * `ctx.inscriptionUsed`, main.ts's closure turns that into a `status` call, the
 * effect merges its power, `recomputeAttributes` folds it onto
 * `StatusFlags.infusionSaturation`, and `useTalent` reads it back at
 * `setCooldown`. Every one of those can be individually correct while the wire
 * between two of them is cold, which is this repo's signature defect and has
 * happened six times. So the test presses the button and reads the cooldown.
 */

import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { createContentTalentEngine, sheetForClass } from '../../src/server/content/classes.ts';
import { classById } from '../../src/server/content/classes.ts';
import { effectsOn, statusApplier } from '../../src/server/engine/effects.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { projectEffects } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import { healingInfusion } from '../../src/server/talents/healing_infusion.ts';
import { regenerationInfusion } from '../../src/server/talents/regeneration_infusion.ts';
import { wildInfusion } from '../../src/server/talents/wild_infusion.ts';
import { MONSTER_TEMPLATES, monsterInit } from '../../src/server/content/monsters.ts';
import { shinCrack } from '../../src/server/talents/shin_crack.ts';
import { trained } from '../helpers/trained.ts';

/** Any creature will do; this one is the first the bestiary lists. */
const indexHusk = MONSTER_TEMPLATES[0];
if (indexHusk === undefined) throw new Error('the bestiary is empty');

/** A body with every infusion learned, and a real runtime behind it. */
function arena() {
  const world = createWorld('infusion-saturation');
  const player = world.addPlayer('p1', 'Dalt');
  // HURT, so Healing Infusion has something to do. A talent refused for
  // "nothing to heal" would set no cooldown and this would measure nothing.
  player.maxHp = 400;
  player.hp = 40;

  const effects = createMvpEffectState();
  const engine = createContentTalentEngine();
  const definition = classById('watchman');
  if (definition === undefined) throw new Error('no watchman');
  engine.attach('p1', trained(sheetForClass(definition)));

  const runtime = talentRuntimeFor(engine, world, statusApplier(effects, world.rng));
  return { world, player, effects, runtime };
}

/**
 * The sentence the CLIENT would draw under this body's saturation badge.
 *
 * Through `projectEffects`, which is the function the gateway calls, so this
 * cannot pass while the projector still sends the static `description`.
 */
function descOf(world: World, effects: ReturnType<typeof createMvpEffectState>): string {
  const frame = projectEffects(world, effects);
  for (const row of frame.actors) {
    if (row.id !== 'p1') continue;
    const badge = row.effects.find((eff) => eff.id === EffectId.InfusionSaturation);
    if (badge?.desc !== undefined) return badge.desc;
  }
  return '(no saturation badge on p1)';
}

/** The saturation power currently on a body, or 0. */
function power(effects: ReturnType<typeof createMvpEffectState>, id: string): number {
  const live = effectsOn(effects, id).find((eff) => eff.effectId === EffectId.InfusionSaturation);
  const own = live?.params['power'];
  return typeof own === 'number' ? own : 0;
}

describe('infusion saturation', () => {
  it('is applied by using an infusion, and not by anything else', () => {
    const { player, effects, runtime } = arena();
    expect(power(effects, 'p1'), 'saturated before anything was used').toBe(0);

    const used = runtime.use(player, healingInfusion.id, undefined);
    expect(used.ok, `the infusion was refused: ${used.ok ? '' : used.reason}`).toBe(true);
    // other.lua:105 — `parameters = { power = 1 }`.
    expect(power(effects, 'p1'), 'one use is one stack').toBe(1);
  });

  it('does not tax the use that applies it — Actor.lua:5850', () => {
    /**
     * Upstream wraps the `setEffect` in `game:onTickEnd` with the comment
     * *"delay it so it does not affect current inscription"*. Here the same
     * thing falls out of ordering: the cooldown is set from the saturation as
     * it stood, and the tax is raised afterwards. If those two lines were ever
     * swapped, every infusion would silently cost one extra turn from the very
     * first press, which is the kind of change nobody notices.
     */
    const { player, runtime } = arena();
    const used = runtime.use(player, healingInfusion.id, undefined);
    expect(used.ok).toBe(true);
    expect(player.cooldowns.get(healingInfusion.id)).toBe(healingInfusion.cooldownTurns);
  });

  it('makes the NEXT infusion recharge more slowly — Actor.lua:6356-6358', () => {
    /**
     * THE ASSERTION THE WHOLE FILE IS FOR, and the one that reads the join. A
     * second infusion pressed while saturated must start on a longer cooldown
     * than its own declaration.
     */
    const { player, runtime } = arena();
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    const second = runtime.use(player, wildInfusion.id, undefined);
    expect(second.ok, `the second infusion was refused: ${second.ok ? '' : second.reason}`).toBe(
      true,
    );
    expect(
      player.cooldowns.get(wildInfusion.id),
      'the second infusion started on its untaxed cooldown — the saturation ' +
        'reached the effect table but not the cooldown site, or the flag fold ' +
        'is not running',
    ).toBeGreaterThan(wildInfusion.cooldownTurns);
  });

  it('stacks, so the third press costs more than the second', () => {
    /**
     * other.lua:106-110 — `on_merge` ADDS the powers and refreshes the
     * duration. A `Refresh` stack mode would make the tax a flat +1 however
     * hard the player leaned on it, which is a different mechanic.
     */
    const { player, effects, runtime } = arena();
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    expect(power(effects, 'p1')).toBe(1);
    expect(runtime.use(player, wildInfusion.id, undefined).ok).toBe(true);
    expect(power(effects, 'p1'), 'the merge did not add the powers').toBe(2);
  });

  it('leaves a talent that is not an inscription alone', () => {
    /**
     * `Talent.inscriptionKind` is what both sites branch on. A class talent
     * declares none, so a saturated body's Shin Crack must still start on
     * exactly its own cooldown — otherwise the tax is a global slow wearing an
     * infusion's citation.
     */
    const { world, player, runtime } = arena();
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);

    // SOMETHING TO HIT, so this measures a PRESS rather than a declaration. A
    // refusal sets no cooldown at all, and a test that read `undefined` here
    // would pass just as happily against a talent that was never used.
    const foe = world.addMonster('m1', monsterInit(indexHusk, { x: player.x + 1, y: player.y }, 1));
    // SHIN CRACK RATHER THAN CRUDE BLOW, and the difference is the whole
    // test: Crude Blow declares `cooldownTurns: 0`, so `cooldowns.get` answers
    // undefined however the branch behaves and the assertion could never fail.
    const blow = runtime.use(player, shinCrack.id, { x: foe.x, y: foe.y });
    expect(blow.ok, `the class talent was refused: ${blow.ok ? '' : blow.reason}`).toBe(true);
    expect(
      player.cooldowns.get(shinCrack.id),
      'a class talent was taxed by infusion saturation — the branch on ' +
        '`inscriptionKind` at the cooldown site is not holding, so this is a ' +
        'global slow wearing an infusion citation',
    ).toBe(shinCrack.cooldownTurns);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE PLAYER CAN SEE HOW BIG THE TAX IS — other.lua:100.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `long_desc` for this effect is a FUNCTION of the instance:
 * `("...(+%d cooldowns).").format(eff.power)`. Ours shipped as a fixed
 * sentence, which told a player the tax existed and never what it was — and
 * the entire mechanic is deciding whether to pay it again.
 *
 * ASSERTED THROUGH `projectEffects`, not off the definition. `EffectDef.describe`
 * being correct proves nothing if the projector still sends `description`;
 * that join is the half that would fail silently, because the fallback is a
 * true sentence and nothing would look broken.
 */
describe('the saturation badge says how big the tax is', () => {
  it('grows its sentence as the stack grows', () => {
    const { world, player, effects, runtime } = arena();
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    const once = descOf(world, effects);
    expect(once, 'the badge did not name a number at one stack').toMatch(/\+1 turn\b/);

    /**
     * ═══ THREE STACKS, NOT TWO, AND THAT IS A FACT ABOUT THE UNITS ═══
     * The first version of this asserted the sentence moves between ONE stack
     * and TWO. It does not, and neither does upstream's: the power is in ToME
     * turns and ours are twice as coarse, so `ceil(1/2)` and `ceil(2/2)` are
     * both one turn — exactly as `ceil((12+1)/2)` and `ceil((12+2)/2)` are both
     * 7 upstream. A test demanding movement there would have asserted something
     * neither this game nor the one it is ported from does, so the test was
     * what changed.
     *
     * Three is where the tax genuinely moves, so three is what proves the
     * sentence is composed from the instance rather than frozen.
     */
    expect(runtime.use(player, wildInfusion.id, undefined).ok).toBe(true);
    expect(descOf(world, effects), 'two stacks still round to one turn').toBe(once);

    expect(runtime.use(player, regenerationInfusion.id, undefined).ok).toBe(true);
    expect(
      descOf(world, effects),
      `the sentence never moved at any stack (still "${once}") — the projector ` +
        'is sending the static `description` rather than calling `describe`',
    ).toContain('+2 turns on each');
  });

  it('says "turn" once and "turns" after that', () => {
    // A status a player reads every fight, so the grammar is worth the branch.
    const { world, player, effects, runtime } = arena();
    expect(runtime.use(player, healingInfusion.id, undefined).ok).toBe(true);
    expect(descOf(world, effects)).toContain('+1 turn on each');
  });
});
