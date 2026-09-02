// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:971-1075 (`rest`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState, goDown } from '../../src/server/engine/downed.ts';
import { accept, createPartyState, invite } from '../../src/server/engine/party.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../src/shared/sight.ts';
import { chebyshev } from '../../src/shared/coords.ts';
import { REST_MAX_TURNS, RestStop, restStopText } from '../../src/shared/rest.ts';
import { RESOLVE_PER_TURN } from '../../src/server/engine/talents.ts';
import { createEffectState, setEffect } from '../../src/server/engine/effects.ts';
import { BLEEDING } from '../../src/server/content/effects.ts';
import { createRng } from '../../src/shared/rng.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REST, WIRED — the rule in `src/shared/rest.ts` driving a real world.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/shared/rest.test.ts` pins the RULE against a hand-built view and needs
 * no world at all. This file pins the two things that file cannot see:
 *
 *   1. that the loop actually advances the BASE clock, so regen, cooldowns and
 *      status durations all move — the thing a hundred `hold` presses bought;
 *   2. that the view is rebuilt from the world EVERY turn, so a husk that walks
 *      into sight mid-rest ends the rest rather than being noticed at the end.
 *
 * The second is the one worth writing a world for. A rest that read its own
 * conditions once would be a party asleep with something in the room.
 */

function scene(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  // The BOOK, kept so a test can reach its one write (`gainPool`). `talents`
  // above is the ENGINE — a distinction that cost a green test asserting
  // nothing, because `engine.gainPool` does not exist and the optional call
  // silently answered undefined.
  const book = createTalentBook(talents, world);
  const downed = createDownedState();
  const parties = createPartyState();
  // The catalogue the rest's own affliction arm reads, and what lets a bleed
  // actually tick during a rest — see the damage stop below.
  const effects = createEffectState([BLEEDING]);
  const engine = createTurnEngine({
    world,
    downed,
    parties,
    effects,
    talents: book,
    talentRuntime: talentRuntimeFor(talents, world),
  });

  const body = world.addPlayer('p1', 'p1', { maxHp: 40 });
  body.x = 4;
  body.y = 4;
  talents.attach('p1', sheetForClass(WATCHMAN));
  engine.join('p1');
  engine.setConnected('p1', true);
  // SETTLE FIRST, exactly as the tide's fixture does: the join leaves energy to
  // hand out, and the state a player standing about actually sits in is the one
  // after that has been spent.
  engine.pump();
  return {
    world,
    engine,
    body,
    talents,
    book,
    downed,
    parties,
    effects,
    sheet: talents.sheetOf('p1'),
  };
}

describe('rest passes turns the way holding would, without the hundred keys', () => {
  it('heals a hurt body and reports how long it took', () => {
    const { engine, body } = scene('rest-heal');
    body.hp = 10;

    const result = engine.rest('p1');

    expect(result.stop, 'nothing threatened, so it ran to Done').toBe(RestStop.Done);
    expect(result.turns, 'a rest that did nothing would be the bug').toBeGreaterThan(0);
    expect(body.hp).toBe(body.maxHp);
  });

  it('advances the world clock, which is the whole difference from a heal', () => {
    /**
     * A REST IS NOT A POTION. Cooldowns turning over and statuses expiring are
     * most of why the key is worth pressing (Player.lua:1023-1049), and all of
     * them ride the BASE clock — so if the game turn did not move, none of them
     * did, however full the health bar ended up.
     */
    const { engine, world, body } = scene('rest-clock');
    body.hp = 10;
    const before = world.turn.clock.gameTurn;

    const result = engine.rest('p1');

    expect(world.turn.clock.gameTurn).toBe(before + result.turns);
  });

  it('gets faster as it goes, so a long rest is not a long wait', () => {
    /**
     * Player.lua:986 — `math.min(cnt / 10, 8)`. The claim is not "it heals more"
     * (a flat rate would too, given enough turns) but that the SAME amount of
     * healing takes FEWER TURNS than the flat rate would need.
     *
     * `hpRegen` is 0.5 a turn and the body is 30 points down, so a flat rest
     * would need 60 turns. With the bonus it must need materially fewer.
     */
    const { engine, body } = scene('rest-accel');
    body.hp = 10;
    const flatTurns = (body.maxHp - body.hp) / body.hpRegen;

    const result = engine.rest('p1');

    expect(body.hp).toBe(body.maxHp);
    expect(result.turns).toBeLessThan(flatTurns);
  });

  it('says there was nothing to rest off rather than passing a turn', () => {
    // `restStopText` gives this its own sentence. A settled body that pressed
    // the key must not lose a turn to it — that would make rest a way to skip
    // your own turn, which is what `hold` is for.
    const { engine, world } = scene('rest-settled');
    const before = world.turn.clock.gameTurn;

    const result = engine.rest('p1');

    expect(result.turns).toBe(0);
    expect(result.stop).toBe(RestStop.Done);
    expect(world.turn.clock.gameTurn).toBe(before);
  });

  it('refills the class pool, not only health', () => {
    // Player.lua:1011-1020. Full health with an empty pool is the state a party
    // walks out of a fight in, and stopping there would leave every button grey.
    const { engine, sheet } = scene('rest-pool');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    sheet.resource.value = 0;

    engine.rest('p1');

    expect(sheet.resource.value).toBe(sheet.resource.max);
  });
});

describe('what stops it', () => {
  it('stops the moment something hostile comes into view, and says which way', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THAT MATTERS, and the reason the view is rebuilt every turn.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The husk is placed BEFORE the rest starts, so this proves the check runs
     * at all; the test below proves it runs on every iteration rather than once.
     */
    const { engine, world, body } = scene('rest-hostile');
    body.hp = 10;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: body.x + 3,
      y: body.y - 4,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
    });
    expect(husk.x - body.x, 'the fixture must land where it was asked to').toBe(3);

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Hostile);
    expect(result.turns, 'it must not rest a single turn beside a hostile').toBe(0);
    expect(result.threat?.dx).toBe(3);
    expect(result.threat?.dy).toBe(-4);
  });

  it('ends a rest ALREADY RUNNING when a hostile walks into view', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE VIEW IS REBUILT EVERY TURN, AND THIS IS WHAT PROVES IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A rest that read its conditions once and then looped would sleep through
     * a monster walking into the room, and would look completely correct in the
     * test above — which places the husk first, so a single read finds it.
     *
     * ═══ THE FIXTURE IS THE ARGUMENT ═══
     * The husk starts at `DEFAULT_SIGHT_RADIUS + 4`, OUTSIDE what the resting
     * body can see, with an aggro range long enough that IT can see US. So the
     * rest genuinely begins — and the clock it is turning is the clock the husk
     * walks on, which is the point: rest does not freeze the world while it
     * runs.
     *
     * So `turns` must be strictly between 0 (it started) and the ~11 a full heal
     * from 4 to 40 would take (it did not finish), and the stop must name the
     * husk.
     */
    const { engine, world, body } = scene('rest-interrupt');
    body.hp = 4;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: body.x + DEFAULT_SIGHT_RADIUS + 4,
      y: body.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
      // LONGER THAN OUR SIGHT, deliberately. Aggro range and sight radius are
      // different questions (see `DEFAULT_SIGHT_RADIUS`), and this fixture needs
      // the asymmetry: something that has noticed us before we can see it.
      aggroRange: 30,
    });

    const result = engine.rest('p1');

    expect(result.stop, 'the husk closed, so the rest must have ended for it').toBe(
      RestStop.Hostile,
    );
    expect(result.threat?.name).toBe('Index Husk');
    expect(
      result.turns,
      'it must have STARTED — a hostile out of sight stops nothing',
    ).toBeGreaterThan(0);
    expect(body.hp, 'and it must NOT have finished').toBeLessThan(body.maxHp);
    expect(
      chebyshev(body, husk),
      'the husk is inside sight when the rest ends, which is why it ended',
    ).toBeLessThanOrEqual(DEFAULT_SIGHT_RADIUS);
  });

  it('stops rather than spinning when health only falls', () => {
    // :1003. The rule's own note: a bleeding body at full health would otherwise
    // rest forever waiting on a number that only goes down.
    const { engine, body } = scene('rest-bleed');
    body.hp = 10;
    body.hpRegen = -1;

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Bleeding);
    expect(result.turns).toBe(0);
  });

  it('never exceeds its budget, whatever the world does', () => {
    /**
     * THE LIVENESS BOUND, and it is not a balance number. Turn resolution is
     * synchronous, so this call holds the whole realm until it returns — a rest
     * that never reached Done would be a server that never answered.
     *
     * Forced here by a body that heals a hair a turn and is enormously deep: it
     * genuinely wants more turns than the budget allows, so the engine must stop
     * and SAY it stopped rather than quietly report a finished rest.
     */
    const { engine, body } = scene('rest-budget');
    body.maxHp = 100_000;
    body.hp = 1;
    body.hpRegen = 0.01;

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Budget);
    expect(result.turns).toBe(REST_MAX_TURNS);
  });

  it('answers rather than throwing for a body that is not there', () => {
    const { engine } = scene('rest-nobody');
    expect(engine.rest('nobody').turns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The party rests together — Player.lua:983-993
// ---------------------------------------------------------------------------

describe('a rest heals the whole party', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE PLAYER PRESSED THE KEY AND ONLY THAT PLAYER GOT THE ACCELERATION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream pays the bonus inside `restCheck` and pays it to every member:
   * `for act, def in pairs(game.party.members) ... act:heal(act.life_regen *
   * perc)` (Player.lua:983-993). Ours paid `self` alone.
   *
   * The others were never FROZEN — a rest pumps real turns, so `actBase` gave
   * them their ordinary trickle. They simply got 1x while the rester got up to
   * the cap, so two detectives sitting in the same room recovered at visibly
   * different rates for no reason either could see. That is why the assertion
   * below is about the SHAPE of the recovery and not merely "did they heal".
   */
  function party(name: string) {
    const made = scene(name);
    const mate = made.world.addPlayer('p2', 'p2', { maxHp: 40 });
    mate.x = 5;
    mate.y = 4;
    made.talents.attach('p2', sheetForClass(WATCHMAN));
    made.engine.join('p2');
    made.engine.setConnected('p2', true);
    /**
     * AND THEY ARE ACTUALLY IN ONE PARTY, which the first version of this
     * fixture skipped — with expensive consequences. `checkWipe` surveys ONE
     * PARTY, so two joined-but-unpartied players are two parties of one; downing
     * `p2` wiped THEIR party, `resetFloorParty` stood them straight back up at
     * full hp, and a test about the rest bonus failed against engine behaviour
     * that was entirely correct.
     */
    invite(made.parties, 'p1', 'p2', 0);
    accept(made.parties, 'p2', 'p1', 0);
    made.engine.pump();
    return { ...made, mate };
  }

  it('brings a hurt teammate up too', () => {
    const { engine, body, mate } = party('rest-party');
    body.hp = 10;
    mate.hp = 10;

    engine.rest('p1');

    expect(body.hp, 'the rester').toBe(body.maxHp);
    expect(mate.hp, 'and the one who did not press the key').toBe(mate.maxHp);
  });

  it('and pays them the ACCELERATION, not just the ordinary trickle', () => {
    /**
     * THE ASSERTION THE COMMIT IS FOR. A teammate healed to full either way,
     * given enough turns — what changed is how many turns it takes, so the
     * claim has to be about the rate.
     *
     * The rest stops when the RESTER is done, so a teammate hurt by the same
     * amount must arrive at the same time. Before this, the rester finished in a
     * fraction of the turns and the teammate was left part-healed.
     */
    const { engine, body, mate } = party('rest-party-rate');
    body.hp = 10;
    mate.hp = 10;

    const result = engine.rest('p1');

    expect(result.stop).toBe(RestStop.Done);
    // A flat trickle over that many turns would leave the teammate short: 0.5 a
    // turn against 30 points missing needs 60 turns, and an accelerated rest
    // finishes well inside that.
    expect(result.turns, 'the acceleration is what makes this a short rest').toBeLessThan(60);
    expect(mate.hp).toBe(mate.maxHp);
  });

  it('pays each member THEIR OWN Constitution, not the rester`s', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SHARED THING IS THE ACCELERATION, NOT THE AMOUNT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream reads `act.life_regen` and calls `act:heal`, which applies the
     * RECEIVER's `healing_factor` (Actor.lua:2089) — so a sturdy teammate gets
     * more out of somebody else's rest than a frail one does.
     *
     * ═══ THE POOLS MUST NOT FILL, WHICH IS WHY THEY ARE ABSURD ═══
     * An earlier version of this test gave both teammates 400 maximum and a
     * long rest. Both reached full, both ended equal, and a mutation reading the
     * RESTER's factor for everybody passed — because "equal at the ceiling" is
     * true whatever the factor was. That failure was misdiagnosed at the time as
     * `recomposeCombat` wiping a hand-set `combat`; it does not, and a probe
     * confirmed the field survives a rest intact.
     *
     * So: a ceiling neither can approach, and a SHORT rest, so what is compared
     * is the rate rather than the destination.
     */
    const { engine, world, body, talents, parties, mate: sturdy } = party('rest-party-con');
    const frail = world.addPlayer('p3', 'p3', { maxHp: 100000 });
    frail.x = 6;
    frail.y = 4;
    talents.attach('p3', sheetForClass(WATCHMAN));
    engine.join('p3');
    engine.setConnected('p3', true);
    invite(parties, 'p1', 'p3', 0);
    accept(parties, 'p3', 'p1', 0);
    engine.pump();

    sturdy.maxHp = 100000;
    sturdy.hp = 100;
    frail.hp = 100;
    sturdy.hpRegen = 2;
    frail.hpRegen = 2;
    // The one difference between them.
    sturdy.combat = { stats: { str: 10, dex: 10, con: 100, wil: 10, cun: 10 } };
    frail.combat = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
    body.hp = 10;

    engine.rest('p1');

    expect(sturdy.hp, 'both were still climbing, so this is about the rate').toBeLessThan(100000);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RATIO, BECAUSE "THE STURDY ONE GAINS MORE" IS TRUE EITHER WAY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * That was the first assertion here and it caught nothing. `actBase`'s
     * ORDINARY per-turn regeneration also pays the healing factor (`f0c7678`),
     * and it always reads each body's OWN Constitution — so a mutation making
     * the rest bonus use the RESTER's factor still leaves the sturdy teammate
     * ahead on the trickle alone. Measured: 286.3 against 224.2 correct, and
     * 251.2 against 224.2 mutated. Both satisfy "greater than".
     *
     * Both paths scale by the same factor, so with the rule intact the TOTAL
     * gain scales by exactly the ratio of the two factors — `healingFactor` is
     * 1.5 at con 100 and 1.0 at con 10. Any share of the healing paid at the
     * wrong factor drags that ratio down, which is what makes this the
     * assertion rather than the inequality.
     */
    const ratio = (sturdy.hp - 100) / (frail.hp - 100);
    expect(ratio, 'part of the healing was paid at the wrong Constitution').toBeCloseTo(1.5, 2);
  });

  it('fills a TEAMMATE`s pool at the rest`s rate too', () => {
    /**
     * Upstream's loop pays `incStamina`/`incMana`/`incPsi` to every member in
     * the same breath as the heal (Player.lua:983-993) — the pool half is not
     * the rester's alone any more than the hit points are.
     *
     * Measured on the TEAMMATE's pool rather than the rester's, because that is
     * the half a mutation confining the payment to `self` would quietly drop.
     */
    const { engine, body, talents, mate } = party('rest-party-pool');
    body.hp = 10;
    /**
     * AND NOT STANDING NEXT TO THE RESTER. Resolve's own clause builds it "when
     * struck and when adjacent to an ally" (`regenResource`), and `party` places
     * the teammate one tile away — so the pool refilled from ADJACENCY and a
     * mutation confining the rest bonus to the rester passed twice before this
     * line existed.
     */
    mate.x = 15;
    mate.y = 15;
    const mine = talents.sheetOf('p2')?.resource;
    expect(mine, 'the teammate needs a class with a pool').toBeDefined();
    if (mine === undefined) return;
    /**
     * DRAINED INTO THE WINDOW BETWEEN THE TWO RATES, which is narrower than it
     * looks and took three tries to land in.
     *
     * The rest runs about twenty-seven turns (it ends when the RESTER's hit
     * points are full). Flat, Resolve trickles 0.6 a turn — sixteen points in
     * that time. Accelerated it is `0.6 x restBonus(turn)`, which ramps, and
     * comes to roughly forty. So thirty is short enough for the bonus to finish
     * and too deep for the trickle: at ninety NEITHER could, and the correct
     * code failed alongside the mutation.
     */
    mine.value = mine.max - 30;

    engine.rest('p1');

    expect(mine.value, 'the teammate was left on the flat trickle').toBe(mine.max);
  });

  it('heals nobody who is down, which is what makes standing them up urgent', () => {
    // Upstream's guard is `hasEntity(act) and not act.dead`.
    const { engine, world, body, mate, downed } = party('rest-party-downed');
    /**
     * A SHORT REST, and the reason is a second thing this test found.
     *
     * With the rester at 10 of 40 the rest runs for dozens of turns — long
     * enough for the downed teammate's own countdown (`DOWNED_TURNS`) to expire,
     * at which point they are erased, the floor resets and `standUp` returns
     * them at FULL health. The teammate ended at 40 and the assertion failed
     * against a guard that was working perfectly.
     *
     * So the rester is one point short: the rest is over in a turn or two, well
     * inside the countdown, and what the teammate's hit points say at the end is
     * about the rest bonus and nothing else.
     */
    body.hp = body.maxHp - 1;
    /**
     * THROUGH `goDown`, NOT BY HAND. The first version of this test set
     * `mate.alive = false` and left `hp` at 10 — a state no code path produces —
     * and something repaired it mid-rest, so the teammate healed to full and the
     * test failed against a guard that was actually correct.
     *
     * `goDown` sets `hp = 0`, `alive = false`, clears the pending intent and
     * swaps the sprite. Registering the record is what makes this a downed
     * detective rather than a contradiction.
     */
    // AND STANDING WELL CLEAR. Adjacent, a downed ally is a rescue candidate,
    // and the rest's own pumps were standing them back up — which is the
    // downed system working and had nothing to do with the bonus.
    mate.x = 20;
    mate.y = 20;
    goDown(downed, mate, world.turn.clock.gameTurn);
    expect(mate.alive, 'the fixture must actually be down').toBe(false);

    engine.rest('p1');

    expect(body.hp).toBe(body.maxHp);
    expect(mate.alive, 'the countdown must not have run out mid-test').toBe(false);
    expect(mate.hp, 'a downed detective recovers nothing from somebody else resting').toBe(0);
  });

  it('does not heal a MONSTER standing in the room', () => {
    // `world.allActors()` is everything in the realm, so the kind test is the
    // whole of the party filter — and getting it wrong would heal the thing you
    // are resting to fight.
    const { engine, world, body } = party('rest-party-husk');
    body.hp = 10;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 20,
      y: 20,
      profile: AiProfile.MeleeChaser,
    });
    /**
     * A DEEP POOL AND AN HONEST TRICKLE, which is the only shape that can tell
     * the two apart.
     *
     * The first version set `hpRegen = 0` so the husk could not gain at all —
     * and a mutation that DELETED the `kind` test still passed, because zero
     * times the bonus is zero. The second left `hpRegen = 1` with a small pool
     * and the husk simply filled up over sixty honest turns.
     *
     * So: a pool it cannot fill, a trickle of exactly one a turn, and an
     * assertion that it gained no more than the turns it lived through.
     */
    husk.maxHp = 10000;
    husk.hp = 3;
    husk.hpRegen = 1;

    const result = engine.rest('p1');

    expect(
      husk.hp,
      'the husk gained more than one a turn — the rest bonus reached a monster',
    ).toBeLessThanOrEqual(3 + result.turns);
  });
});

// ---------------------------------------------------------------------------
// Any damage ends a rest — Player.lua:722-724
// ---------------------------------------------------------------------------

describe('a rest stops when something lands a hit', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A BODY BLED AT TWO A TURN, REGENERATED AT THREE, AND RESTED IT OFF FREE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream hangs this off `onTakeHit` (Player.lua:722-724), so ANY damage ends
   * a rest before the blow is even applied. The gap it left here is not the
   * obvious one — a monster walking up is caught by `Hostile` long before it
   * swings, and that arm has worked since the rest shipped.
   *
   * IT IS THE BLEED. `restCheck` deliberately CONTINUES while a detrimental
   * effect ticks down (Player.lua:1023-1029) — waiting one out is most of why
   * the key exists — and `Bleeding` only fires when the REGEN RATE itself goes
   * negative, which a damage-over-time never touches. So the wound healed itself
   * for nothing, and the screen said "Ready."
   */
  it('a bleed ticking during a rest ends it', () => {
    const { engine, body, effects } = scene('rest-bleed');
    body.hp = 20;
    // Twenty turns of it, so the wound outlasts any plausible rest and the stop
    // has to come from the DAMAGE rather than from the effect expiring.
    setEffect(effects, body, BLEEDING.id, 20, {}, createRng('rest-bleed'));

    const result = engine.rest('p1');

    expect(result.stop, 'the wound was rested off for free').toBe(RestStop.Hurt);
    expect(body.hp, 'and it stopped early rather than at full health').toBeLessThan(body.maxHp);
  });

  it('but NOT when the blow lands on somebody else', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ID FILTER, AND IT IS NOT PEDANTRY IN A CO-OP GAME.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A pump carries EVERYBODY's events. Without `event.id === actorId` a
     * detective resting in a quiet room is hauled to their feet whenever a
     * friend two rooms away takes a scratch — and since the rest is what heals
     * the party, that friend is denied the healing by their own misfortune.
     *
     * ═══ THE BYSTANDER IS DISCONNECTED, AND THAT IS THE WHOLE FIXTURE ═══
     * Three earlier attempts ended in `Budget` after one turn, and the engine
     * was right every time: with a monster engaged, the barrier waits for every
     * player who still owes a decision, so an idle second body FREEZES the world
     * and the rest advances no game turn at all.
     *
     * `setConnected(false)` is the realistic answer rather than a workaround —
     * game-design.md § 4 leaves a dropped player's body standing where it fell
     * and puts them on Standing By, which is exactly a body that can be hit and
     * cannot hold anybody up.
     */
    const { engine, world, body, talents, parties } = scene('rest-other-hurt');
    body.hp = 20;
    const mate = world.addPlayer('p2', 'p2', { maxHp: 400 });
    mate.x = 26;
    mate.y = 26;
    mate.hp = 200;
    talents.attach('p2', sheetForClass(WATCHMAN));
    engine.join('p2');
    invite(parties, 'p1', 'p2', 0);
    accept(parties, 'p2', 'p1', 0);
    engine.setConnected('p2', true);
    engine.pump();
    // ...and then they drop. The body stays; the barrier stops waiting for it.
    engine.setConnected('p2', false);

    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 27,
      y: 26,
      profile: AiProfile.MeleeChaser,
    });
    expect(
      Math.hypot(husk.x - body.x, husk.y - body.y),
      'the husk must be out of the RESTER`s sight, or `Hostile` ends this instead',
    ).toBeGreaterThan(DEFAULT_SIGHT_RADIUS);

    const result = engine.rest('p1');

    expect(mate.hp, 'the fixture must actually have hurt the bystander').toBeLessThan(200);
    expect(result.stop, 'a friend being hit is not my reason to stand up').not.toBe(RestStop.Hurt);
    expect(body.hp).toBe(body.maxHp);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO TERMS STILL UNDRIVEN, AND BOTH ARE STRUCTURAL RATHER THAN LAZY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The scan is `event.k === 'damage' && event.id === actorId && event.healed
   * === undefined`, over `playerEvents` AND `sweep`. Deleting the arm and
   * dropping the id filter are both caught above. These two survive:
   *
   *   `.sweep` as well as `playerEvents`  A bleed lands in `playerEvents`, so
   *     dropping the sweep arm changes nothing here. It is NOT decoration — a
   *     monster's blow arrives in the sweep — but a monster cannot reach the
   *     rester to swing: `restCheck` runs BEFORE each pump and `Hostile` catches
   *     anything close enough, and nothing crosses from unseen to adjacent and
   *     attacks inside one pump. The arm is for a blow that lands without being
   *     seen coming, which no content produces today.
   *
   *   `event.healed === undefined`  A heal rides the same `DamageEvent` (its own
   *     docblock: one frame kind for "an actor's hp changed"), so without this a
   *     teammate mending the rester would read as a hit and end the rest that
   *     was doing them good. Nothing in this harness heals a resting body, and
   *     driving it means a second player casting a heal mid-rest — which the
   *     barrier will not allow while the rester holds.
   *
   * Named rather than faked, and the list is shorter than it was: the id filter
   * and the per-member Constitution were on it until a disconnected bystander
   * and a ratio assertion closed them.
   */
  it('says so, rather than stopping silently', () => {
    // Every stop has a sentence — `restStopText`. A rest that ended for a reason
    // the player cannot see is a rest that looks broken.
    expect(restStopText({ rest: false, stop: RestStop.Hurt }, 4, 'here')).toContain('hit');
  });
});

// ---------------------------------------------------------------------------
// The pool accelerates too — Player.lua:983-993
// ---------------------------------------------------------------------------

describe('a rest fills the pool at the rest`s rate', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * RESTING FOR FOCUS NEARLY RAN OUT OF BUDGET.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream pays `incStamina`/`incMana`/`incPsi` at the same `perc` as the
   * heal, in the same loop over the same members (Player.lua:983-993). Ours
   * accelerated hit points and nothing else, for anybody.
   *
   * `restCheck` keeps resting while a pool can still rise, and Focus trickles at
   * `FOCUS_PER_TURN` — 0.2 x `TOME_ACTIONS_PER_TURN`, so 0.4 a turn. Sixty
   * points took a hundred and fifty turns against a `REST_MAX_TURNS` of two
   * hundred. The symptom is the LENGTH of the rest, so that is what this
   * measures.
   */
  it('reaches a full pool in far fewer turns than the flat trickle needs', () => {
    const { engine, body, sheet } = scene('rest-pool');
    // Full health, so the rest is entirely about the pool and cannot end early
    // on hit points.
    body.hp = body.maxHp;
    const pool = sheet?.resource;
    expect(pool, 'the fixture needs a class with a pool').toBeDefined();
    if (pool === undefined) return;

    const missing = 60;
    pool.value = pool.max - missing;
    const trickle = RESOLVE_PER_TURN;
    expect(trickle, 'a pool with no trickle cannot be accelerated').toBeGreaterThan(0);
    const flatTurns = missing / trickle;

    const result = engine.rest('p1');

    expect(pool.value, 'the rest did not finish the job').toBe(pool.max);
    // NOT "fewer than 150" — derived, so a change to the trickle or the pool
    // cannot leave this asserting a number that no longer means anything.
    expect(
      result.turns,
      `filling ${String(missing)} at ${String(trickle)} a turn is ${String(flatTurns)} turns flat; ` +
        `an accelerated rest must be materially shorter`,
    ).toBeLessThan(flatTurns / 2);
  });

  it('and the write seam clamps, so a pool cannot exceed its ceiling', () => {
    /**
     * TESTED DIRECTLY, because a rest cannot reach the overshoot. The ORDINARY
     * per-turn trickle runs first and fills the last fraction before the
     * accelerated payment is due (`restBonus(0)` is 0 — the first turn of a rest
     * is worth an ordinary one), so through `engine.rest` the clamp is never
     * exercised and a mutation deleting it sails through.
     *
     * `gainPool` is the only WRITE on `TalentBook`, and it delegates to
     * `gainResource` precisely so the ceiling lives in one place.
     */
    const { world, book, sheet } = scene('rest-pool-clamp');
    const pool = sheet?.resource;
    const body = world.getActor('p1');
    if (pool === undefined || body === undefined) return;
    pool.value = pool.max - 1;

    const landed = book.gainPool(body, 10_000);

    expect(pool.value, 'the pool went over its own ceiling').toBe(pool.max);
    expect(landed, 'and it reports what actually landed, not what was asked for').toBe(1);
  });

  it('and does not push a pool past its ceiling over a whole rest', () => {
    // `gainResource` owns the clamp, which is why `gainPool` goes through it
    // rather than touching `pool.value`.
    const { engine, body, sheet } = scene('rest-pool-cap');
    // HURT, so the rest actually runs — and the pool a WHISKER short, so the
    // first payment overshoots the ceiling. Setting it exactly full made the
    // rest end before `gainPool` was ever called, and a mutation removing the
    // clamp sailed through.
    body.hp = body.maxHp - 20;
    const pool = sheet?.resource;
    if (pool === undefined) return;
    pool.value = pool.max - 0.1;

    engine.rest('p1');

    expect(pool.value, 'the pool went over its own ceiling').toBe(pool.max);
  });
});
