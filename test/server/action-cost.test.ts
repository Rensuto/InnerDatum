// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:1346, 1353-1360 (a step's price)
//                       game/modules/tome/class/interface/Combat.lua:66-71 (a swap's)
//                       game/modules/tome/class/interface/Combat.lua:234-236 (a swing's)
//                       game/modules/tome/class/Actor.lua:5816-5830, 5862-5863 (a talent's)
//                       game/modules/tome/class/interface/Combat.lua:2280-2293 (combatMovementSpeed)
//                       game/modules/tome/data/timed_effects/physical.lua:493 (STUNNED's -0.5)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { trained } from '../helpers/trained.ts';
import { describe, expect, it, vi } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile, FLAT_CHARGE, Faction, actionCost } from '../../src/server/engine/actor.ts';
import { MELEE_REACH } from '../../src/server/engine/combat.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import {
  EffectStatus,
  SaveChannel,
  StackMode,
  hasEffect,
  registerEffect,
  recomposeCombat,
  removeEffect,
  setEffect,
} from '../../src/server/engine/effects.ts';
import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { longStride } from '../../src/server/talents/legwork.ts';
import { onMyWhistle, speedGivenAt } from '../../src/server/talents/on_my_whistle.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { talentId, tomeCooldownToTurns } from '../../src/server/engine/talents.ts';
import { realmTalentRuntime } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ENERGY_PER_TICK, ENERGY_TO_ACT } from '../../src/shared/energy.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { EffectDef, EffectState } from '../../src/server/engine/effects.ts';
import type { TalentEngine } from '../../src/server/engine/talents.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY ACTION PAYS WHAT ToME CHARGES FOR IT — AND IT WAS ONE TURN FOR ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `spendTurn` used to charge exactly one turn for anything a player did, while
 * upstream prices each action by its own speed: a step at the body's movement
 * speed, a swing at the weapon's, a talent at the talent's. So STUNNED's
 * −50% movement speed (physical.lua:493) was carried on the effect and read by
 * nothing, and a stunned detective walked exactly as fast as a steady one.
 *
 * ═══ DRIVEN THROUGH THE REAL TURN ENGINE, AND MEASURED OFF THE CLOCK ═══
 * Every case submits a real intent and pumps a real `createTurnEngine` with the
 * production talent runtime (`realmTalentRuntime`, main.ts) and the real status
 * table. The price is read as the number of ticks the world runs before the
 * body is back at `ENERGY_TO_ACT`: it starts there, pays the action, and gains
 * `ENERGY_PER_TICK` a tick at full speed, so `ticks × ENERGY_PER_TICK` IS what
 * the action cost — and it is also exactly what a player feels, which is how
 * long the world moves before they are asked again.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';
const HOME = { x: 10, y: 10 } as const;

type Room = {
  readonly world: World;
  readonly effects: EffectState;
  readonly talents: TalentEngine;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly body: Actor;
};

/**
 * A Watchman alone on open floor, wired as production wires a realm: the real
 * status table, the real talent book and the production talent runtime with its
 * status door (`realmTalentRuntime`, main.ts — what `engineFor` builds).
 */
function room(seed: string, options: { readonly husk?: boolean } = {}): Room {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const effects = createMvpEffectState();
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    now: () => 0,
    downed: createDownedState(),
    parties: createPartyState(),
    effects,
    talents: createTalentBook(talents, world),
    talentRuntime: realmTalentRuntime(talents, effects, world, () => undefined),
  });
  const body = world.addPlayer('p1', 'Dalt', { maxHp: 500 });
  body.x = HOME.x;
  body.y = HOME.y;
  body.hpRegen = 0;
  // THE CLASS'S OWN SHEET, with the reach `canAttack` asks for. See
  // talent-resolution.test.ts for why MELEE_REACH rather than the authored 1.
  body.combat = { ...WATCHMAN.combat, range: MELEE_REACH };
  body.baseCombat = body.combat;
  talents.attach('p1', trained(sheetForClass(WATCHMAN)));

  if (options.husk === true) {
    // UNKILLABLE and next door, so every swing lands on the same body and the
    // fight stays armed — the barrier then parks on the detective's next
    // decision, which is where the clock is read.
    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: HOME.x + 1,
      y: HOME.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 999_999,
    });
    husk.hpRegen = 0;
  }

  engine.join('p1');
  engine.setConnected('p1', true);
  // Up to the first decision, so every case starts on a turn the body chooses.
  engine.pump();
  return { world, effects, talents, engine, body };
}

/**
 * What one action cost the body, in energy, read off the clock.
 *
 * THE PRECONDITION IS ASSERTED, NOT ASSUMED: the arithmetic is only the price
 * if the body starts at exactly `ENERGY_TO_ACT` and gains at full speed, so a
 * fixture that drifted from either would be measuring itself.
 */
function spent(scene: Room, act: () => void): number {
  expect(scene.body.energy, 'the body was not waiting on a decision').toBe(ENERGY_TO_ACT);
  expect(scene.body.globalSpeed).toBe(1);
  const before = scene.world.turn.clock.tick;
  act();
  scene.engine.pump();
  expect(scene.body.energy, 'the pump stopped before the body was asked again').toBe(ENERGY_TO_ACT);
  return (scene.world.turn.clock.tick - before) * ENERGY_PER_TICK;
}

/** Stun through the real status door — no `applyPower`, so there is no save. */
function stun(world: World, effects: EffectState, body: Actor): void {
  setEffect(effects, body, EffectId.Stunned, 99, {}, world.rng);
  expect(hasEffect(effects, body.id, EffectId.Stunned), 'the stun did not land').toBe(true);
}

function tile(world: World, x: number, y: number, code: number): void {
  world.level.tiles[y * world.level.w + x] = code;
}

describe('a step costs the body its movement speed', () => {
  it('one turn on a steady detective, two on a stunned one', () => {
    const scene = room('cost-step');
    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(ENERGY_TO_ACT);

    stun(scene.world, scene.effects, scene.body);
    // THE JOIN: the effect's −0.5, folded onto the body by `recomputeAttributes`.
    expect(scene.body.movementSpeed).toBe(0.5);
    expect(spent(scene, () => scene.engine.submitMove('p1', 'w'))).toBe(2 * ENERGY_TO_ACT);
    expect(scene.body.x, 'the stunned step did not land').toBe(HOME.x);

    // AND BACK WHEN IT ENDS. The stun is the body's only effect, so removing it
    // empties the table — the path where the fold hands back no add at all, and
    // a recompute that only wrote a speed it was given would leave the half.
    removeEffect(scene.effects, scene.body, EffectId.Stunned, scene.world.rng);
    expect(hasEffect(scene.effects, scene.body.id, EffectId.Stunned)).toBe(false);
    expect(scene.body.movementSpeed).toBe(1);
    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(ENERGY_TO_ACT);
  });

  it('and a stunned swing and a stunned wait still cost one turn each', () => {
    /**
     * THE STUN SLOWS THE FEET AND NOTHING ELSE. `movement_speed` prices a step
     * and nothing but a step — a swing is `combatSpeed` (Combat.lua:234-236),
     * a wait is a bare `useEnergy()` (tome/class/Actor.lua:1459). A build that
     * doubled every action under a stun passes the case above and fails this.
     */
    const scene = room('cost-stunned-swing', { husk: true });
    stun(scene.world, scene.effects, scene.body);

    // The bump into the husk east is the swing: priced, and nobody moved. A
    // refused bump would cost nothing, and a step would have cost two turns.
    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(ENERGY_TO_ACT);
    expect(scene.body.x, 'a swing moved the body').toBe(HOME.x);
    expect(scene.world.getActor('m_husk')?.x).toBe(HOME.x + 1);

    expect(spent(scene, () => scene.engine.hold('p1'))).toBe(ENERGY_TO_ACT);
  });

  it('trading places with an ally costs the mover one step at HER speed, and the ally nothing', () => {
    /**
     * Combat.lua:66-71 — `energy_to_act * self:combatMovementSpeed(x, y)`, on the
     * mover alone. Stunned, so a swap priced as a flat turn fails here.
     */
    const scene = room('cost-swap');
    const ren = scene.world.addPlayer('p2', 'Ren', { maxHp: 500 });
    ren.x = HOME.x + 1;
    ren.y = HOME.y;
    scene.engine.join('p2');
    scene.engine.setConnected('p2', true);
    scene.engine.pump();
    expect(ren.energy).toBe(ENERGY_TO_ACT);

    stun(scene.world, scene.effects, scene.body);
    // REN'S CLOCK ALL BUT STOPPED, so a charge on her could not be refilled
    // while the mover works off the step: at a hundredth of the usual gain, the
    // twenty ticks a stunned step takes put back 20 energy, and any price shows.
    ren.globalSpeed = 0.01;
    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(2 * ENERGY_TO_ACT);
    expect(scene.body.x, 'the two did not trade places').toBe(HOME.x + 1);
    expect(ren.x).toBe(HOME.x);
    expect(ren.energy, 'the body that was moved paid for it').toBe(ENERGY_TO_ACT);
  });

  it('a refused step costs nothing, and neither does opening a door', () => {
    /**
     * tome/class/Actor.lua:1346 charges a step only when the tile changed, and
     * engine/Actor.lua:243 answers a blocked move without moving. A player's
     * refusal is refunded (`actPlayer` parks it) — and a door-open is that same
     * refusal with the door swung, Grid.lua's `return true` (doors.test.ts has
     * the full argument). Asserted here as ZERO energy, stunned, so no price
     * the charge could put on it hides behind a coincidence.
     */
    const scene = room('cost-refused');
    stun(scene.world, scene.effects, scene.body);
    tile(scene.world, HOME.x + 1, HOME.y, TileCode.WALL);
    tile(scene.world, HOME.x - 1, HOME.y, TileCode.DOOR);

    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(0);
    expect(scene.body.x).toBe(HOME.x);

    expect(spent(scene, () => scene.engine.submitMove('p1', 'w'))).toBe(0);
    expect(scene.world.level.tiles[HOME.y * scene.world.level.w + HOME.x - 1]).toBe(
      TileCode.DOOR_OPEN,
    );
    expect(scene.body.x, 'the body walked through the door it opened').toBe(HOME.x);
  });

  it('floors at 0.1: a −5 add costs ten turns, never a negative or infinite price', () => {
    /**
     * `math.max(movement_speed, 0.1)` (Combat.lua:2291). Without it 1 − 5 is −4,
     * a negative divisor and a NEGATIVE price, which `actionCost`'s own floor
     * would then round up to a tenth of a turn: a body mired to a standstill
     * stepping ten times as fast as a free one. At exactly −1 it is 1/0.
     *
     * A made-up effect rather than five stuns, because a stun re-applied
     * REFRESHES (physical.lua has no `on_merge`) and never takes more than half.
     */
    const MIRE: EffectDef = {
      id: 'effect:test_mire',
      displayName: 'Mire',
      description: 'A test effect: a large movement penalty.',
      type: SaveChannel.Physical,
      status: EffectStatus.Detrimental,
      stackMode: StackMode.Refresh,
      subtypes: [],
      decrease: 1,
      icon: 'icon_status_stunned',
      badge: 'Mi',
      modifiers: { movementSpeedAdd: -5 },
      parameters: {},
    };
    const scene = room('cost-floor');
    registerEffect(scene.effects, MIRE);
    setEffect(scene.effects, scene.body, MIRE.id, 99, {}, scene.world.rng);
    expect(scene.body.movementSpeed).toBe(-4);

    expect(actionCost(scene.body, { kind: 'move' })).toBe(10);
    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(10 * ENERGY_TO_ACT);
  });
});

describe('Long Stride makes a step cheaper — Lightning Speed’s passive', () => {
  /**
   * THE PASSIVE AS PRODUCTION LANDS IT: `refreshPassives` (main.ts) writes the
   * talent's block onto `passiveCombat` and calls `recomposeCombat`, which folds
   * it through `WIELDER_MOD_KEYS` and ends in `recomputeAttributes`. The same
   * two steps here, so a key the fold drops or a sum that forgets the sheet
   * shows up as the price of a step.
   */
  function stride(scene: Room, level: number): void {
    scene.body.passiveCombat = longStride.passive?.(level, EMPTY_PASSIVE_VIEW);
    recomposeCombat(scene.body, scene.effects, resolveItem);
  }

  it('rank 1 is 8% faster: a step costs 1/1.08 of a turn', () => {
    /**
     * Not a whole number of ticks, so it is read off what is left rather than
     * off the clock: from a full turn, pay 1000 / 1.08 and gain 100 a tick
     * until ready again — ten ticks, and 1000 − 925.9 + 1000 left over.
     */
    const scene = room('cost-stride');
    stride(scene, 1);
    expect(scene.body.movementSpeed).toBeCloseTo(1.08, 10);
    expect(scene.body.energy).toBe(ENERGY_TO_ACT);
    const before = scene.world.turn.clock.tick;
    scene.engine.submitMove('p1', 'e');
    scene.engine.pump();
    expect(scene.body.x, 'the step did not land').toBe(HOME.x + 1);
    expect(scene.world.turn.clock.tick - before).toBe(10);
    expect(scene.body.energy).toBeCloseTo(2 * ENERGY_TO_ACT - ENERGY_TO_ACT / 1.08, 6);
  });

  it('and adds to a stun rather than replacing it: 1 + 0.08 − 0.5', () => {
    // Upstream sums every source into the one attribute (`movement_speed =
    // "add"`, tome/class/Actor.lua:105), so a stunned Long Strider is slowed
    // from where the talent put them.
    const scene = room('cost-stride-stunned');
    stride(scene, 1);
    stun(scene.world, scene.effects, scene.body);
    expect(scene.body.movementSpeed).toBeCloseTo(0.58, 10);
    expect(actionCost(scene.body, { kind: 'move' })).toBeCloseTo(1 / 0.58, 10);
  });
});

describe('On My Whistle hands a friend ToME’s SPEED — Blinding Speed’s numbers', () => {
  it('costs the Watchman no turn, and the friend’s clock fills 14% faster at rank 1', () => {
    /**
     * `no_energy`, as Blinding Speed is (combat-techniques.lua:155): the world
     * does not move for the whistle. And the power is the one the rank asks
     * for, through the real status door to the friend's own `globalSpeed` —
     * which is what makes them asked more often than game turns pass.
     */
    const scene = room('cost-whistle');
    const ren = scene.world.addPlayer('p2', 'Ren', { maxHp: 500 });
    ren.x = HOME.x + 2;
    ren.y = HOME.y;
    scene.engine.join('p2');
    scene.engine.setConnected('p2', true);
    scene.engine.pump();
    const sheet = scene.talents.sheetOf('p1');
    if (sheet === undefined) throw new Error('fixture: no sheet');
    sheet.resource.value = 100;

    const tick = scene.world.turn.clock.tick;
    const sent = scene.engine.submitTalent('p1', talentId('on_my_whistle'), {
      x: ren.x,
      y: ren.y,
    });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    scene.engine.pump();
    expect(scene.world.turn.clock.tick, 'the whistle cost a turn').toBe(tick);
    expect(hasEffect(scene.effects, 'p2', EffectId.Speed)).toBe(true);
    expect(ren.globalSpeed).toBeCloseTo(1 + speedGivenAt(1), 10);
    expect(speedGivenAt(1)).toBeCloseTo(0.14, 10);
    expect(scene.body.globalSpeed, 'the Watchman whistled himself').toBe(1);
  });

  it('will not whistle the Watchman himself, nor a shopkeeper who is on nobody’s side', () => {
    const scene = room('cost-whistle-refused');
    const sheet = scene.talents.sheetOf('p1');
    if (sheet === undefined) throw new Error('fixture: no sheet');
    sheet.resource.value = 100;
    const self = scene.engine.submitTalent('p1', talentId('on_my_whistle'), HOME);
    scene.engine.pump();
    expect(self.ok && hasEffect(scene.effects, 'p1', EffectId.Speed), 'whistled himself').toBe(
      false,
    );

    const merrow = scene.world.addMonster('m_shop', {
      name: 'Merrow Stitch',
      sprite: HUSK_SPRITE,
      x: HOME.x + 2,
      y: HOME.y,
      profile: AiProfile.MeleeChaser,
      faction: Faction.Townsfolk,
      maxHp: 500,
    });
    scene.engine.submitTalent('p1', talentId('on_my_whistle'), { x: merrow.x, y: merrow.y });
    scene.engine.pump();
    expect(hasEffect(scene.effects, merrow.id, EffectId.Speed), 'the shopkeeper sped up').toBe(
      false,
    );
    expect(merrow.globalSpeed).toBe(1);
  });

  it('pins Blinding Speed’s numbers: the curve, three of our turns, and the text', () => {
    // combat-techniques.lua:163 — 0.14 to 0.45 on a 0.75 curve; rank 3 is where
    // the exponent shows. And `%d` truncates, so rank 3's 30.92% reads 30.
    expect(speedGivenAt(3)).toBeCloseTo(0.30924, 4);
    expect(speedGivenAt(5)).toBeCloseTo(0.45, 10);
    expect(onMyWhistle.describe({} as never, 3)).toContain('30% faster for 3 turns');
    expect(onMyWhistle.cooldownTurns).toBe(tomeCooldownToTurns(55));
  });
});

describe('every decision a hasted body gets is a whole one', () => {
  it('two costly talents on two decisions inside one game turn — there is no budget to run short', () => {
    /**
     * A turn is a decision, and there is no budget beyond it. There was one: a
     * per-turn AP/MP budget that refilled only on the game turn's `actBase`, so
     * a hasted body's second decision in one game turn found the first one's
     * points spent — Crude Blow (3) then Iron Curtain (5) on a budget of 6 was
     * refused. It was refilled per decision for a commit, then retired, and
     * this pins that nothing took its place. At a clock of 10 the body decides
     * every tick, so both land inside one game turn by construction.
     */
    const scene = room('cost-hasted-budget', { husk: true });
    setEffect(scene.effects, scene.body, EffectId.Speed, 99, { power: 9 }, scene.world.rng);
    expect(scene.body.globalSpeed).toBeCloseTo(10, 10);
    const sheet = scene.talents.sheetOf('p1');
    if (sheet === undefined) throw new Error('fixture: no sheet');
    sheet.resource.value = 100;
    const at = { x: HOME.x + 1, y: HOME.y };
    const turn = scene.world.turn.clock.gameTurn;

    expect(scene.engine.submitTalent('p1', talentId('crude_blow'), at).ok).toBe(true);
    scene.engine.pump();
    expect(scene.body.energy, 'not asked again').toBeGreaterThanOrEqual(ENERGY_TO_ACT);
    const second = scene.engine.submitTalent('p1', talentId('iron_curtain'), at);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    scene.engine.pump();
    expect(scene.world.turn.clock.gameTurn, 'the fixture crossed a game turn').toBe(turn);
    expect(
      scene.body.cooldowns.get(talentId('iron_curtain')) ?? 0,
      'Iron Curtain was refunded rather than used',
    ).toBeGreaterThan(0);
  });
});

describe('Highborn’s Bloom waives the resource, never the turn', () => {
  it('a talent the bloom pays for costs the same energy as one paid in Resolve', () => {
    /**
     * "All active talents will be used without resource cost" (other.lua:1576),
     * and upstream still spends energy either way: a talent that cost no time
     * would let a body act without end. talents.test.ts pins the resource half
     * at `useTalent`, which spends no energy at all — the turn is the
     * scheduler's to charge — so this half is measured here, off the clock, with
     * the real effect through the real status door. It read the AP budget
     * until that was retired, and "the budget went down" was never the turn.
     */
    const at = { x: HOME.x + 1, y: HOME.y };
    const cast = (scene: Room): { readonly price: number; readonly drop: number } => {
      const sheet = scene.talents.sheetOf('p1');
      if (sheet === undefined) throw new Error('fixture: no sheet');
      sheet.resource.value = 100;
      const price = spent(scene, () => {
        const sent = scene.engine.submitTalent('p1', talentId('iron_curtain'), at);
        expect(sent.ok, JSON.stringify(sent)).toBe(true);
      });
      expect(
        scene.body.cooldowns.get(talentId('iron_curtain')) ?? 0,
        'Iron Curtain was refunded rather than used',
      ).toBeGreaterThan(0);
      // NET of the trickle and of being struck, which only ever ADD Resolve.
      return { price, drop: 100 - sheet.resource.value };
    };

    const paid = cast(room('cost-bloom-paid', { husk: true }));
    const bloomed = room('cost-bloom-free', { husk: true });
    setEffect(bloomed.effects, bloomed.body, EffectId.HighbornsBloom, 99, {}, bloomed.world.rng);
    expect(hasEffect(bloomed.effects, 'p1', EffectId.HighbornsBloom)).toBe(true);
    const free = cast(bloomed);

    // THE CONTROL: the paid cast did pay, so the free one's zero means something.
    expect(paid.drop, 'the paid cast spent no Resolve').toBeGreaterThan(0);
    expect(free.drop, 'the bloom did not waive the Resolve').toBeLessThanOrEqual(0);
    expect(free.price, 'a free talent must still cost the turn').toBe(paid.price);
    expect(free.price).toBeGreaterThan(0);
  });
});

describe('a swing costs the weapon speed', () => {
  it('a weapon with physspeed 0.8 swings for 800 — whips.lua:30', () => {
    /**
     * `combatSpeed` is `physspeed / combat_physspeed` (Combat.lua:1409-1412), and
     * a whip's `physspeed = 0.8` makes every blow four fifths of a turn. No
     * weapon in this game authors one yet, so the number is put on the sheet by
     * hand — both halves of it, so no recompose can quietly drop it.
     */
    const scene = room('cost-whip', { husk: true });
    const weapon = { ...WATCHMAN.combat.weapon, physSpeed: 0.8 };
    scene.body.combat = { ...WATCHMAN.combat, range: MELEE_REACH, weapon };
    scene.body.baseCombat = scene.body.combat;

    expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(800);
  });

  it('and a MISS costs the same swing — Combat.lua:677 returns the speed hit or miss', () => {
    /**
     * `attackTargetWith` returns `self:combatSpeed(weapon)` on both branches, so
     * a whiff is not a cheaper action than a blow. The to-hit draw is forced
     * to its top so the swing misses whatever the two sheets say, and the husk's
     * untouched life is what proves it did.
     */
    const scene = room('cost-whip-miss', { husk: true });
    const weapon = { ...WATCHMAN.combat.weapon, physSpeed: 0.8 };
    scene.body.combat = { ...WATCHMAN.combat, range: MELEE_REACH, weapon };
    scene.body.baseCombat = scene.body.combat;
    const husk = scene.world.getActor('m_husk');
    if (husk === undefined) throw new Error('fixture: no husk');
    const int = scene.world.rng.int.bind(scene.world.rng);
    const spy = vi
      .spyOn(scene.world.rng, 'int')
      .mockImplementation((label, min, max) =>
        label === 'combat.checkhit' ? max : int(label, min, max),
      );
    try {
      expect(spent(scene, () => scene.engine.submitMove('p1', 'e'))).toBe(800);
    } finally {
      spy.mockRestore();
    }
    expect(husk.hp, 'the swing landed, so this is not the miss').toBe(husk.maxHp);
  });
});

describe('a talent costs the talent speed', () => {
  /** The whip, then the talent, at the husk beside the body. */
  function armed(seed: string): Room {
    const scene = room(seed, { husk: true });
    const weapon = { ...WATCHMAN.combat.weapon, physSpeed: 0.8 };
    scene.body.combat = { ...WATCHMAN.combat, range: MELEE_REACH, weapon };
    scene.body.baseCombat = scene.body.combat;
    const sheet = scene.talents.sheetOf('p1');
    if (sheet === undefined) throw new Error('fixture: no sheet');
    sheet.resource.value = 100;
    return scene;
  }

  it('a weapon technique costs the swing, a standard talent one turn', () => {
    /**
     * Crude Blow is the basic swing (`speed: 'weapon'`): `getSpeed("weapon")`
     * is the weapon's `combatSpeed`. The Regeneration infusion names no speed
     * and is no technique (`inscriptions/infusions`, misc/inscriptions.lua), so
     * it is `standard` — one turn whatever is in the hand. Same body, same whip.
     */
    const at = { x: HOME.x + 1, y: HOME.y };
    const blow = armed('cost-talent-weapon');
    expect(
      spent(blow, () => {
        expect(blow.engine.submitTalent('p1', talentId('crude_blow'), at).ok).toBe(true);
      }),
    ).toBe(800);

    // A SCENE OF ITS OWN, so nothing the swing spent can refuse it.
    const infusion = armed('cost-talent-standard');
    infusion.body.hp = infusion.body.maxHp - 60;
    expect(
      spent(infusion, () => {
        const sent = infusion.engine.submitTalent('p1', talentId('regeneration_infusion'));
        expect(sent.ok, JSON.stringify(sent)).toBe(true);
      }),
    ).toBe(ENERGY_TO_ACT);
  });

  it('a no_energy talent costs nothing — tome/class/Actor.lua:5862', () => {
    const scene = armed('cost-free');
    scene.body.hp = scene.body.maxHp - 60;
    const hurt = scene.body.hp;
    expect(
      spent(scene, () => {
        expect(scene.engine.submitTalent('p1', talentId('healing_infusion')).ok).toBe(true);
      }),
    ).toBe(0);
    expect(scene.body.hp, 'the infusion did not resolve').toBeGreaterThan(hurt);
  });
});

describe('a monster pays by the same rule', () => {
  /**
   * A husk walking at a detective who only waits. Counted in steps over eight
   * game turns, because a monster's energy is spent inside the pump and never
   * stands still long enough to read — and "how often it moves" is the thing a
   * player sees.
   */
  function stepsIn(seed: string, stunned: boolean): number {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createMvpEffectState();
    const engine = createTurnEngine({ world, now: () => 0, effects });
    const body = world.addPlayer('p1', 'Dalt', { maxHp: 500 });
    body.x = 5;
    body.y = HOME.y;
    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 17,
      y: HOME.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
      aggroRange: 20,
    });
    engine.join('p1');
    engine.setConnected('p1', true);
    world.turn.engagement = 3;
    engine.pump();
    if (stunned) stun(world, effects, husk);

    let steps = 0;
    const start = world.turn.clock.gameTurn;
    for (let pass = 0; pass < 50 && world.turn.clock.gameTurn < start + 8; pass += 1) {
      world.turn.engagement = 3;
      const x = husk.x;
      engine.hold('p1');
      engine.pump();
      if (husk.x !== x) steps += 1;
    }
    return steps;
  }

  it('a stunned husk steps half as often as a steady one', () => {
    const steady = stepsIn('cost-husk-steady', false);
    const stunned = stepsIn('cost-husk-stunned', true);
    // A FLOOR on the control, or a husk that never moved would pass the ceiling.
    expect(steady, 'the steady husk did not walk').toBeGreaterThanOrEqual(7);
    // Two turns a step: four in eight, and one more at most if it banked a turn.
    expect(stunned).toBeGreaterThanOrEqual(3);
    expect(stunned).toBeLessThanOrEqual(5);
  });

  it('and speedFactor still multiplies a monster’s price — 1 on every template today', () => {
    const scene = room('cost-factor', { husk: true });
    const husk = scene.world.getActor('m_husk');
    if (husk === undefined || husk.kind !== 'monster') throw new Error('fixture: no husk');
    expect(actionCost(husk, FLAT_CHARGE)).toBe(1);
    husk.speedFactor = 0.5;
    expect(actionCost(husk, FLAT_CHARGE)).toBe(0.5);
    expect(actionCost(husk, { kind: 'attack', speed: 2 })).toBe(1);
  });
});

describe('confusion never rolls for a talent that costs no turn', () => {
  it('skips the roll for a no_energy talent, and still rolls for one that costs a turn', () => {
    /**
     * `util.getval(ab.no_energy, self, ab) ~= true` is inside upstream's guard
     * (tome/class/Actor.lua:5499), so a free talent is never confused. This
     * rolled for every talent and then parked the free one for nothing — so a
     * confused infusion that failed could simply be pressed again, a FREE
     * RE-ROLL. Asserted on the draw itself: the roll is labelled
     * `confused.talent.<id>`, and a free talent must take none.
     */
    const scene = room('cost-confused', { husk: true });
    setEffect(scene.effects, scene.body, EffectId.Confused, 99, {}, scene.world.rng);
    expect(scene.body.combat?.flags?.confused ?? 0, 'the confusion did not land').toBeGreaterThan(
      0,
    );
    const labels: string[] = [];
    const int = scene.world.rng.int.bind(scene.world.rng);
    const spy = vi.spyOn(scene.world.rng, 'int').mockImplementation((label, min, max) => {
      labels.push(label);
      return int(label, min, max);
    });
    try {
      scene.body.hp = scene.body.maxHp - 60;
      expect(scene.engine.submitTalent('p1', talentId('healing_infusion')).ok).toBe(true);
      scene.engine.pump();
      expect(labels, 'a free talent was rolled for confusion').not.toContain('confused.talent.p1');

      // THE CONTROL: the same body, confused AGAIN — the infusion cured the
      // first one through the status door (`healing_infusion.ts`'s cure) — and a
      // talent that costs a turn.
      setEffect(scene.effects, scene.body, EffectId.Confused, 99, {}, scene.world.rng);
      const sheet = scene.talents.sheetOf('p1');
      if (sheet !== undefined) sheet.resource.value = 100;
      const at = { x: HOME.x + 1, y: HOME.y };
      expect(scene.engine.submitTalent('p1', talentId('crude_blow'), at).ok).toBe(true);
      scene.engine.pump();
      expect(labels, 'the fixture cannot see the roll at all').toContain('confused.talent.p1');
    } finally {
      spy.mockRestore();
    }
  });
});
