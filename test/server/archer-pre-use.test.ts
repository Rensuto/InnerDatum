// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  CLASSES,
  INSPECTOR,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { Slot, itemById } from '../../src/server/content/items.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { AttackRefusal, canAttack } from '../../src/server/engine/combat.ts';
import { TalentPower } from '../../src/server/engine/derived.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { recomposeCombat } from '../../src/server/engine/effects.ts';
import { composeSheet } from '../../src/server/engine/equipment.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { NO_SHOOTER_REASON, TalentKind } from '../../src/server/engine/talents.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MAUL IN THE INSPECTOR'S HAND IS A MAUL — techniques/archery.lua:46-50.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `composeSheet` takes a worn mainhand over the class's own weapon, and the
 * Inspector's own weapon is her revolver. Found by the first-hour diagnosis
 * rather than by a player: the probe dresses a body class-blind, and in 35 of
 * 40 dressed rows it put a melee weapon in her hand. Two things then went wrong
 * together, and upstream has neither:
 *
 *   HER BUMP WAS REFUSED. The sheet kept the gun's `minRange: 3`, so a maul
 *   was a maul with a dead zone — at Blackwood she was refused at contact 1807
 *   times and never landed one blow.
 *
 *   HER GUN FIRED THE MAUL. Revolver Shot resolved with the sheet's weapon, the
 *   maul's 60 base damage against the revolver's 18, from five tiles.
 *
 * Upstream: a melee weapon is swung at melee reach with no minimum
 * (Combat.lua:175-192), and every archery talent refuses without a launcher in
 * the mainhand (`archerPreUse`, `on_pre_use` at archery.lua:82, :334, :802,
 * sniper.lua:272). Both halves are driven here through the production seams.
 */

const MAUL = 'item_bailiffs_maul';

function inspector(name: string, mainhand?: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const effects = createMvpEffectState();
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    effects,
    // THE PRODUCTION SEAMS — the content book's `check` is what refuses at
    // submission, and the runtime is what resolves the shot.
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });
  const body = world.addPlayer('p1', 'Detective', {
    maxHp: 900,
    combat: INSPECTOR.combat,
    classId: INSPECTOR.id,
  });
  body.x = 10;
  body.y = 10;
  const hold = (item: string | undefined): void => {
    body.equipped = item === undefined ? {} : { [Slot.Mainhand]: item };
    recomposeCombat(body, effects, resolveItem);
  };
  hold(mainhand);
  talents.attach('p1', sheetForClass(INSPECTOR));
  engine.join('p1');
  engine.setConnected('p1', true);
  return { world, engine, body, hold };
}

function foeAt(world: ReturnType<typeof createWorld>, x: number, y: number) {
  return world.addMonster(`foe-${String(x)}-${String(y)}`, {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x,
    y,
    profile: AiProfile.MeleeChaser,
    maxHp: 9999,
  });
}

describe('a melee weapon swings like one — the gun takes its reach and dead zone with it', () => {
  const maul = itemById(MAUL);

  it('drops the revolver’s `range` and `minRange` when a maul replaces it', () => {
    expect(maul?.slot, `${MAUL} is not a mainhand weapon any more`).toBe(Slot.Mainhand);
    if (maul === undefined) return;
    // THE PRECONDITION: the class sheet carries both, because of its gun.
    expect(INSPECTOR.combat.weapon?.archery).toBe(true);
    expect(INSPECTOR.combat.minRange).toBeGreaterThan(0);

    const held = composeSheet(INSPECTOR.combat, [maul]);
    expect(held.weapon?.archery, 'the maul came out as a gun').not.toBe(true);
    expect(held.minRange, 'the maul kept the revolver’s dead zone').toBeUndefined();
    expect(held.range, 'the maul kept the revolver’s five tiles').toBeUndefined();

    // …and an empty hand is still the revolver, hole and all.
    const bare = composeSheet(INSPECTOR.combat, []);
    expect(bare.range).toBe(INSPECTOR.combat.range);
    expect(bare.minRange).toBe(INSPECTOR.combat.minRange);
  });

  it('leaves a sheet whose weapon was never a gun exactly the reach it authored', () => {
    // A fixture on purpose: no shipped body has a dead zone AND a non-archery
    // weapon, and this is the clause that says the strip is about the GUN and
    // not about every mainhand. A wraith-shaped sheet keeps its band.
    if (maul === undefined) return;
    const shooter: CombatSheet = { range: 6, minRange: 2, weapon: { dam: 5 } };
    const held = composeSheet(shooter, [maul]);
    expect(held.range).toBe(6);
    expect(held.minRange).toBe(2);

    // AND ON A SHIPPED BODY, which is the one that would lose something: the
    // Alchemist's sheet authors a reach and her weapon is not a gun, so a maul
    // in her hand must leave her flares' reach where it was. A strip that forgot
    // its `archery` clause turns only this and the fixture above red.
    expect(ALCHEMIST.combat.weapon?.archery, 'the Alchemist carries a gun now').not.toBe(true);
    expect(ALCHEMIST.combat.range, 'the Alchemist authors no reach any more').toBeDefined();
    expect(composeSheet(ALCHEMIST.combat, [maul]).range).toBe(ALCHEMIST.combat.range);
  });

  it('lands the bump at contact, through the turn engine, where it used to be refused', () => {
    const scene = inspector('maul-bump', MAUL);
    const foe = foeAt(scene.world, 11, 10);
    // THE ENGINE'S OWN QUESTION FIRST, so a red below says which layer moved.
    expect(canAttack(scene.body, foe, scene.world)).toBeNull();
    scene.engine.pump();
    const before = foe.hp;
    expect(Math.max(Math.abs(foe.x - scene.body.x), Math.abs(foe.y - scene.body.y))).toBe(1);
    const dir =
      foe.x > scene.body.x ? 'e' : foe.x < scene.body.x ? 'w' : foe.y > scene.body.y ? 's' : 'n';
    scene.engine.submitMove('p1', dir);
    scene.engine.pump();
    expect(foe.hp, 'the maul was swung at nothing').toBeLessThan(before);
  });

  it('still refuses the revolver inside its dead zone — the hole is the gun’s, and it is intact', () => {
    const scene = inspector('gun-hole');
    const foe = foeAt(scene.world, 12, 10);
    expect(canAttack(scene.body, foe, scene.world)).toBe(AttackRefusal.MinRange);
  });
});

describe('a gun talent with no gun in the hand is refused — archerPreUse', () => {
  it('refuses Revolver Shot at submission while a maul is held, and says why', () => {
    const scene = inspector('maul-shot', MAUL);
    foeAt(scene.world, 14, 10);
    const refused = scene.engine.submitTalent('p1', 'talent:revolver_shot', { x: 14, y: 10 });
    expect(refused.ok, 'the maul fired from four tiles').toBe(false);
    if (refused.ok) return;
    // `refused`, whose sentence the server writes and the client shows as is.
    expect(refused.code).toBe('refused');
    expect(refused.reason).toMatch(/Revolver Shot/);
    // THE SENTENCE THE HOTBAR SHOWS TOO, which names the one thing she can do:
    // her gun is her sheet's, not an item, so she empties her hand.
    expect(refused.reason).toContain(NO_SHOOTER_REASON);

    // THE SAME SHOT, THE SAME TILE, THE GUN BACK IN HAND: legal. So the refusal
    // above is the weapon and not the aim.
    scene.hold(undefined);
    const fired = scene.engine.submitTalent('p1', 'talent:revolver_shot', { x: 14, y: 10 });
    expect(fired.ok, fired.ok ? '' : fired.reason).toBe(true);
  });

  it('refuses it at RESOLUTION too, when the maul went into her hand after the press', () => {
    // `canUseTalent` is asked again when the intent resolves (the refund rule),
    // so a swap between the press and the tick costs the shot, not the maul.
    const scene = inspector('maul-late');
    const foe = foeAt(scene.world, 14, 10);
    scene.engine.pump();
    const at = { x: foe.x, y: foe.y };
    const accepted = scene.engine.submitTalent('p1', 'talent:revolver_shot', at);
    expect(accepted.ok, accepted.ok ? '' : accepted.reason).toBe(true);
    const before = foe.hp;
    scene.hold(MAUL);
    scene.engine.pump();
    expect(foe.hp, 'the maul went off from range after all').toBe(before);
  });

  /**
   * THE FLAG FOLLOWS THE GUN, DERIVED RATHER THAN LISTED. A class whose own
   * weapon is `archery` fires every weapon-scaled talent that reaches past
   * contact, so each of those must carry `archery`; a class with no gun must
   * carry none, or it would own a button nothing can ever let it press. A new
   * gun talent without the flag, or the flag copied onto a flask, turns this red.
   */
  it('is carried by exactly the talents that fire a class’s gun', () => {
    let shots = 0;
    for (const cls of CLASSES) {
      const gun = cls.combat.weapon?.archery === true;
      for (const t of new Map(
        [...cls.loadout, ...cls.birthTalents].map((x) => [x.id, x]),
      ).values()) {
        const fires =
          t.kind === TalentKind.Active &&
          t.scalesWith?.damage === TalentPower.Weapon &&
          t.targeting.range >= 2;
        if (gun && fires) {
          shots += 1;
          expect(t.archery, `${cls.name}'s ${t.name} fires the gun without needing it`).toBe(true);
        } else {
          expect(t.archery, `${cls.name}'s ${t.name} needs a gun it does not fire`).not.toBe(true);
        }
      }
    }
    expect(shots, 'no class fires a gun, so this asserted nothing').toBeGreaterThan(0);
  });
});
