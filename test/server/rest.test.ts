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
    talents: createTalentBook(talents, world),
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
  return { world, engine, body, talents, downed, parties, effects, sheet: talents.sheetOf('p1') };
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOT ASSERTED HERE: THAT EACH MEMBER PAYS THEIR OWN CONSTITUTION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The heal reads `healingFactor(member.combat ?? {})`, so a sturdy teammate
   * should get more out of somebody else's rest than a frail one. A mutation
   * that reads the RESTER's factor for everybody SURVIVES this file, and it is
   * worth saying why rather than leaving a hole nobody can see.
   *
   * `actor.combat` is written by `recomposeCombat`, which this harness never
   * runs — `createTurnEngine` plus `talents.attach` leaves the field undefined,
   * so `healingFactor({})` answers 1 for every body and the two branches of the
   * mutation are numerically identical. Two attempts confirmed it: assigning
   * `combat` by hand (wiped), and giving the teammates different CLASSES
   * (Watchman con 20 against Inspector con 12 — both still came out at 224.2).
   *
   * A green test here would have asserted nothing, which is the failure this
   * file exists to avoid. What IS covered: `healing-factor.test.ts` pins
   * `healingFactor` itself at both ends of its range and pins that `healActor`
   * pays the RECEIVER, and the line here is the same expression the rester used
   * before the bonus went party-wide — `member` in place of `self` and nothing
   * else. The gap is the harness, not the rule.
   */
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THREE NARROWING TERMS THIS HARNESS CANNOT DRIVE, NAMED RATHER THAN FAKED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The scan is `event.k === 'damage' && event.id === actorId && event.healed
   * === undefined`, over `playerEvents` AND `sweep`. Deleting the whole arm is
   * caught above. These three mutations SURVIVE, and each is worth a sentence so
   * the hole is a known one:
   *
   *   `event.id === actorId`  A pump carries everybody's events, so without it a
   *     detective resting in a quiet room stands up whenever a friend two rooms
   *     away takes a scratch — and since the rest is what heals the party, that
   *     friend is denied the healing by their own misfortune. Driving it needs a
   *     second player hurt at a distance, and every attempt ended in `Budget`
   *     after one turn: a second body has to be joined, connected, PARTIED and
   *     pumped before the game turn can complete, and even then this fixture
   *     stopped early for reasons unrelated to the claim.
   *
   *   `.sweep` as well as `playerEvents`  A bleed lands in `playerEvents`, so
   *     dropping the sweep arm changes nothing here. It is not decoration: a
   *     monster's blow arrives in the sweep. It is hard to reach because
   *     `restCheck` runs BEFORE the pump and `Hostile` catches anything close
   *     enough to swing, so the arm is for what hits without being seen.
   *
   *   `event.healed === undefined`  A heal rides the same `DamageEvent` (its own
   *     docblock: one frame kind for "an actor's hp changed"), so without this a
   *     teammate mending the rester would read as a hit and end the rest that
   *     was doing them good. Nothing in this harness heals a resting body.
   *
   * A green test for any of the three would have asserted nothing, which is the
   * failure this file keeps finding. The gap is the harness, not the rule.
   */
  it('says so, rather than stopping silently', () => {
    // Every stop has a sentence — `restStopText`. A rest that ended for a reason
    // the player cannot see is a rest that looks broken.
    expect(restStopText({ rest: false, stop: RestStop.Hurt }, 4, 'here')).toContain('hit');
  });
});
