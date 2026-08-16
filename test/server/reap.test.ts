import { describe, expect, it } from 'vitest';

import { seedTestEncounter } from '../../src/server/content/encounter.ts';
import { AiProfile, setCooldown } from '../../src/server/engine/actor.ts';
import { Survival, createDownedState, goDown, survivalOf } from '../../src/server/engine/downed.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { effectsOn, setEffect } from '../../src/server/engine/effects.ts';
import { createPartyState, partyIdOf } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { EffectState } from '../../src/server/engine/effects.ts';
import type { TalentRuntime } from '../../src/server/turn-engine.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEAD MONSTERS LEAVE THE MAP. THE ENGINE NAMES THEM; THE CALLER BURIES THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME ends a death at `tome/class/Actor.lua:2975`, which calls
 * `engines/default/engine/interface/ActorLife.lua:86-94`:
 *
 * ```lua
 * if game.level:hasEntity(self) then game.level:removeEntity(self) end
 * ```
 *
 * Ours never did. `world.removeActor` was called for a monster in exactly one
 * place — `resetFloor`, i.e. only on a party wipe — so an ordinary kill left the
 * corpse in `world.allActors()` forever. `projectActors` maps every actor with
 * no `alive` filter and the renderer never checks the flag, so a dead husk kept
 * drawing with its LIVE sprite and was indistinguishable from a living one. A
 * player reported it.
 *
 * THREE PROPERTIES ARE PINNED HERE AND EACH ONE HAS COST SOMETHING:
 *
 *   THE ENROLMENT IS EXACTLY ONCE PER BODY, even when two blows land on the same
 *   corpse in one sweep.
 *
 *   THE CLEANUP IS COMPLETE AND ORDERED, ending with the world — once the body
 *   is out of the actor table there is no way left to enumerate which side
 *   tables still hold its id.
 *
 *   A PLAYER IS NEVER ENROLLED AND NEVER REMOVED. `world.removePlayer` IS
 *   `world.removeActor` (the `removePlayer: removeActor` row in world.ts's
 *   returned literal), a DOWNED body is `alive === false`
 *   by design, and engine/downed.ts:20-36 is explicit that M4 ships no
 *   permadeath and that deleting a body loses somebody's character.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * Accuracy that beats any defence in this file, so a kill is decided by the
 * fixture rather than by the seed. Re-rolling seeds until a 60% swing landed
 * would convert a structural test into a coincidence that stops holding.
 */
const NEVER_MISSES: CombatSheet = { mods: { atk: 30 } };

/** A talent runtime that records what it was asked to forget, and nothing else. */
function spyTalents(): TalentRuntime & { readonly forgotten: string[] } {
  const forgotten: string[] = [];
  return {
    forgotten,
    use: () => ({ ok: false as const, reason: 'unknown_talent' as const }),
    actBase: () => undefined,
    noteMoved: () => undefined,
    noteKill: () => undefined,
    noteStruck: () => undefined,
    forget: (actorId: string) => forgotten.push(actorId),
  };
}

type Scene = {
  readonly world: World;
  readonly effects: EffectState;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly talents: ReturnType<typeof spyTalents>;
  readonly actor: (id: string) => Actor;
};

/**
 * One detective at (10,10) with a husk on the tile east of them, on open floor,
 * with the fight already armed.
 */
function scene(seed: string, options: { readonly huskHp?: number } = {}): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 10;
  ren.y = 10;
  ren.hpRegen = 0;
  ren.combat = NEVER_MISSES;

  world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 11,
    y: 10,
    profile: AiProfile.MeleeChaser,
    maxHp: options.huskHp ?? 40,
  });

  const effects = createMvpEffectState();
  const downed = createDownedState();
  const parties = createPartyState();
  const talents = spyTalents();

  const engine = createTurnEngine({
    world,
    downed,
    parties,
    effects,
    talentRuntime: talents,
    now: () => 0,
  });
  engine.join('p1');
  world.turn.engagement = 3;

  return {
    world,
    effects,
    engine,
    talents,
    actor: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      return found;
    },
  };
}

describe('the reap list', () => {
  it('names a killed monster exactly once, and LEAVES THE BODY IN THE WORLD', () => {
    const table = scene('reap-once');
    table.actor('m_husk').hp = 1;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(result.reaped).toEqual(['m_husk']);
    // ═══ STILL THERE, AND THAT IS THE POINT OF THE TWO-STEP ═══
    // The Record lane re-resolves ids through `world.getActor` after the pump
    // has returned. Delete the body inside the pump and `hitToWire` ships
    // `maxHp: 0` and the log narrates "someone 0/0" — nothing throws, the log
    // simply starts lying. See `PumpResult.reaped` in engine/scheduler.ts.
    expect(table.world.getActor('m_husk')).toBeDefined();
    expect(table.actor('m_husk').alive).toBe(false);
  });

  it('names it ONCE even when two blows land on it inside a single sweep', () => {
    // The commonest way a double-report happens in co-op: two attackers resolve
    // against the same body on the same turn. Enrolment reads the damage
    // outcome's `killed`, which damage.ts:594-597 sets only on the blow that
    // crossed zero — so the second swing is a swing at a corpse, which
    // damage.ts:589 charges its draws and returns empty for.
    const world = createWorld('reap-two-blows');
    world.level.tiles.fill(TileCode.FLOOR);

    const victim = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 10,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
    });

    // Two husks either side of a THIRD husk is not a fight; two players are.
    for (const [id, x] of [
      ['p1', 9],
      ['p2', 11],
    ] as const) {
      const body = world.addPlayer(id, id);
      body.x = x;
      body.y = 10;
      body.hpRegen = 0;
      body.combat = { mods: { atk: 30, dam: 2000 } };
    }

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    engine.join('p2');
    world.turn.engagement = 3;
    victim.hp = 1;

    expect(engine.submitMove('p1', 'e').ok).toBe(true);
    expect(engine.submitMove('p2', 'w').ok).toBe(true);
    const result = engine.pump();

    // Both swings happened — the second was a swing at a corpse and is still
    // reported, because a monster that visibly wasted its turn is the honest
    // account and because the draws were taken either way.
    expect(result.reaped).toEqual(['m_husk']);
    expect(victim.hp).toBe(0);
  });

  it('is empty on a pump where nothing died', () => {
    const table = scene('reap-quiet');
    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    expect(table.engine.pump().reaped).toEqual([]);
  });
});

describe('engine.reap', () => {
  it('clears every side table and removes the body LAST', () => {
    const table = scene('reap-cleanup');
    const husk = table.actor('m_husk');

    // Something in each of the tables the contract names.
    setCooldown(husk, 'talent:gutting_strike', 9);
    setEffect(table.effects, husk, EffectId.Stunned, 3, {}, scriptedRng([]));
    expect(effectsOn(table.effects, 'm_husk')).toHaveLength(1);

    expect(table.engine.reap('m_husk')).toBe(true);

    expect(table.world.getActor('m_husk')).toBeUndefined();
    expect(effectsOn(table.effects, 'm_husk')).toEqual([]);
    // The talent engine keys its sheets AND its Guard/Taunt/Mark table by actor
    // id; `forget` is the one call that empties both.
    expect(table.talents.forgotten).toEqual(['m_husk']);
  });

  it('is idempotent — a second call is free and answers false', () => {
    // The gateway drains `reaped` and calls this per id; a body already taken
    // out by a floor reset in the same pump must not throw or double-broadcast.
    const table = scene('reap-idempotent');
    expect(table.engine.reap('m_husk')).toBe(true);
    expect(table.engine.reap('m_husk')).toBe(false);
    expect(table.engine.reap('no_such_actor')).toBe(false);
  });

  it('REFUSES A PLAYER — up, downed, or erased', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE GUARD IS POSITIVE, AND THIS IS WHY IT HAS TO BE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `world.removePlayer` is literally the same closure as `world.removeActor`
    // (the `removePlayer: removeActor` row in world.ts's returned literal), so
    // there is no type-level protection here at all. A
    // guard written as "not a monster" would be correct; one written as "not
    // alive" would delete every downed body on the floor, and engine/downed.ts
    // is explicit that a deleted body loses somebody's character — an ally has
    // to be able to walk to it.
    const table = scene('reap-refuses-players');
    const ren = table.actor('p1');

    expect(table.engine.reap('p1')).toBe(false);
    expect(table.world.getActor('p1')).toBeDefined();

    // ...and again once they are on the floor, which is the state that would
    // trip a negative guard.
    ren.hp = 0;
    ren.alive = false;
    expect(table.engine.reap('p1')).toBe(false);
    expect(table.world.getActor('p1')).toBeDefined();
    expect(table.talents.forgotten).toEqual([]);
  });

  it('never enrols a DOWNED or an ERASED player, however they got there', () => {
    const world = createWorld('reap-never-players');
    world.level.tiles.fill(TileCode.FLOOR);
    const downed = createDownedState();

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 10;
    ren.y = 10;
    ren.hpRegen = 0;

    // A SECOND DETECTIVE, ACROSS THE ROOM AND UNTOUCHED. Without one this is a
    // party of one, the first body hitting the floor IS a wipe, and the floor
    // reset puts them straight back up — which would make `survivalOf` answer
    // `Up` for a reason that has nothing to do with the claim being tested.
    const dalt = world.addPlayer('p2', 'Dalt');
    dalt.x = 4;
    dalt.y = 4;
    dalt.hpRegen = 0;

    world.addMonster('m_killer', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      // Lands every blow, for enough to take a whole detective down in one.
      combat: { mods: { atk: 30, dam: 2000 } },
    });

    const engine = createTurnEngine({ world, downed, now: () => 0 });
    engine.join('p1');
    engine.join('p2');
    world.turn.engagement = 3;
    expect(engine.hold('p1').ok).toBe(true);
    expect(engine.hold('p2').ok).toBe(true);

    const result = engine.pump();

    // The blow landed and put them on the floor...
    expect(survivalOf(downed, 'p1')).toBe(Survival.Downed);
    // ...and the reap list is empty, because the only thing that died is a
    // player and players do not die in M4.
    expect(result.reaped).toEqual([]);
    expect(world.getActor('p1')).toBeDefined();
  });

  it('leaves a downed body enrolled even when the pump ALSO reaped a monster', () => {
    // Both branches of `noteCasualty` in one call, so the monster branch cannot
    // be shown to work by a test in which nothing else happens.
    const world = createWorld('reap-both-branches');
    world.level.tiles.fill(TileCode.FLOOR);
    const downed = createDownedState();

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 10;
    ren.y = 10;
    ren.hpRegen = 0;
    ren.hp = 1;
    ren.combat = { mods: { atk: 30, dam: 2000 } };

    // Again, a standing witness so that one body on the floor is not a wipe.
    const dalt = world.addPlayer('p2', 'Dalt');
    dalt.x = 4;
    dalt.y = 4;
    dalt.hpRegen = 0;

    // East: the one Ren kills. West: the one that kills Ren.
    world.addMonster('m_victim', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 11,
      y: 10,
      profile: AiProfile.MeleeChaser,
      maxHp: 1,
    });
    world.addMonster('m_killer', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 9,
      y: 10,
      profile: AiProfile.MeleeChaser,
      combat: { mods: { atk: 30, dam: 2000 } },
    });

    const engine = createTurnEngine({ world, downed, now: () => 0 });
    engine.join('p1');
    engine.join('p2');
    world.turn.engagement = 3;
    expect(engine.submitMove('p1', 'e').ok).toBe(true);
    expect(engine.hold('p2').ok).toBe(true);

    const result = engine.pump();

    expect(result.reaped).toEqual(['m_victim']);
    expect(survivalOf(downed, 'p1')).toBe(Survival.Downed);
    expect(world.getActor('p1')).toBeDefined();
  });
});

describe('a floor reset routes through the same function', () => {
  it('a re-seeded monster carries no cooldowns and no talent effects from the body it replaces', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE IDS ARE STABLE, WHICH IS WHY THIS IS NOT THEORETICAL.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // content/encounter.ts mints `mon_<template.id>`, so the husk that stands up
    // after a wipe carries the SAME key every side table used. Delete it from
    // the world alone and the new body inherits the old one's talent effects: a
    // freshly-seeded husk that is still Marked, still Taunted, still counting
    // down a Guard it never received.
    const world = createWorld('reset-through-reap');
    const downed = createDownedState();
    const effects = createMvpEffectState();
    const talents = spyTalents();

    const ren = world.addPlayer('p1', 'Ren');
    ren.hpRegen = 0;
    ren.x = 22;
    ren.y = 20;

    const engine = createTurnEngine({
      world,
      downed,
      effects,
      talentRuntime: talents,
      now: () => 0,
    });
    engine.join('p1');

    // Put the authored encounter on the floor and dirty one of its members.
    seedTestEncounter(world);
    const husk = world.getActor('mon_index_husk');
    if (husk === undefined) throw new Error('fixture: the encounter did not seed');
    setCooldown(husk, 'talent:gutting_strike', 9);
    setEffect(effects, husk, EffectId.Stunned, 3, {}, scriptedRng([]));

    // Wipe the party of one, which is what triggers the reset.
    ren.hp = 0;
    ren.alive = false;
    goDown(downed, ren, world.turn.clock.gameTurn);
    engine.pump();

    // The floor was rebuilt: same id, different body.
    const rebuilt = world.getActor('mon_index_husk');
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(husk);
    expect(rebuilt?.cooldowns.size).toBe(0);
    // ...and every side table keyed by that id was emptied on the way through.
    expect(effectsOn(effects, 'mon_index_husk')).toEqual([]);
    expect(talents.forgotten).toContain('mon_index_husk');
  });

  it('does not remove the party it just put back on its feet', () => {
    // The same function, the same call site, the opposite answer — which is the
    // whole reason the guard is `kind === 'monster'` and not `!alive`. At the
    // instant `resetFloor` runs, the restored bodies have only just stopped
    // being corpses.
    const world = createWorld('reset-keeps-players');
    const downed = createDownedState();
    const parties = createPartyState();

    const ren = world.addPlayer('p1', 'Ren');
    ren.hpRegen = 0;
    ren.x = 22;
    ren.y = 20;

    const engine = createTurnEngine({ world, downed, parties, now: () => 0 });
    engine.join('p1');
    const party = partyIdOf(parties, 'p1');

    ren.hp = 0;
    ren.alive = false;
    goDown(downed, ren, world.turn.clock.gameTurn);
    engine.pump();

    expect(world.getActor('p1')).toBeDefined();
    expect(world.getActor('p1')?.alive).toBe(true);
    expect(survivalOf(downed, 'p1')).toBe(Survival.Up);
    // And their party row survived: `forgetParty` is on the cleanup contract and
    // must never have run for this body.
    expect(partyIdOf(parties, 'p1')).toBe(party);
  });

  it('does not let the caller reap the FRESH body a reset just put under the dead one’s id', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE INTERSECTION NOTHING COVERED: A KILL AND A WIPE IN THE SAME PUMP.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The gateway drains `PumpResult.reaped` by BARE ID after `pump()` returns.
    // `resetFloor` has already run inside that same call, has buried every
    // monster, and `reseedFloor` has re-minted the encounter with STABLE IDS —
    // so `mon_index_husk` now names a BRAND NEW husk at full health. Forward the
    // id unfiltered and `engine.reap` finds it, passes its `kind === 'monster'`
    // guard and deletes it; the resync the gateway ships one line later then
    // faithfully broadcasts a reset floor permanently one monster short, and
    // every later wipe-with-a-kill drains one more.
    //
    // The other reap tests each cover one half: this file's "a floor reset
    // routes through the same function" wipes with an EMPTY `reaped`, and
    // reap-broadcast.test.ts never wipes at all. Nothing crossed them.
    const world = createWorld('reap-vs-reseed');
    const downed = createDownedState();

    const ren = world.addPlayer('p1', 'Ren');
    ren.hpRegen = 0;
    ren.x = 22;
    ren.y = 20;
    // Enough accuracy and damage that the bump below is decided by the fixture.
    ren.combat = { mods: { atk: 60, dam: 400 } };

    const engine = createTurnEngine({ world, downed, now: () => 0 });
    engine.join('p1');
    seedTestEncounter(world);

    // A husk on one hp beside her — she kills it on her own turn...
    const husk = world.getActor('mon_index_husk');
    if (husk === undefined) throw new Error('fixture: the encounter did not seed');
    husk.x = 23;
    husk.y = 20;
    husk.hp = 1;

    // ...and the elite on her other side puts her down in the SAME pump's sweep,
    // which is the wipe, which is the reset, which re-seeds the husk she killed.
    const elite = world.getActor('mon_index_husk_elite');
    if (elite === undefined) throw new Error('fixture: the encounter did not seed');
    elite.x = 21;
    elite.y = 20;
    elite.combat = { ...elite.combat, mods: { atk: 60, dam: 400 } };
    ren.hp = 1;

    world.turn.engagement = 3;
    expect(engine.submitMove('p1', 'e').ok).toBe(true);
    const result = engine.pump();

    // The husk really did die and the floor really did reset.
    expect(survivalOf(downed, 'p1')).toBe(Survival.Up);
    const rebuilt = world.getActor('mon_index_husk');
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(husk);
    expect(rebuilt?.alive).toBe(true);

    // THE ASSERTION. The id is NOT handed back, because the body it named is
    // gone and the body wearing it now is somebody else.
    expect(result.reaped).not.toContain('mon_index_husk');

    // ...and draining whatever IS handed back, exactly as the gateway does,
    // leaves the re-seeded encounter whole.
    for (const id of result.reaped) engine.reap(id);
    const monsters = world
      .allActors()
      .filter((actor) => actor.kind === 'monster')
      .map((actor) => actor.id)
      .sort();
    expect(monsters).toEqual(['mon_index_husk', 'mon_index_husk_elite', 'mon_index_wraith']);
  });
});
