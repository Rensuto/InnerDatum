import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import {
  MONSTER_TEMPLATES,
  monsterById,
  validateTemplate,
} from '../../src/server/content/monsters.ts';
import { specFor } from '../../src/server/content/delve.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { ActorKind, ActorRank } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE AUTHORED BODY IN THE GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ActorRank.Boss` sat in the protocol with an experience worth, a render
 * weight and its own assertions in `progression.test.ts`, and NOTHING had ever
 * been one. Seventeen destinations and not a single set piece: every room was a
 * roster rolled into a generated floor, so the case file could be closed end to
 * end without meeting anything that was PUT there.
 *
 * The assertions below are the ones that would have caught what this creature
 * got wrong on the way in — a soft-lock, and a description that did not match
 * the AI it was describing.
 */

describe('the Watcher', () => {
  it('is the only boss in the game, in exactly one room', () => {
    /**
     * ONE IS THE DESIGN. A boss behind each of seventeen doors is a difficulty
     * tier; one, in a room whose blurb already described it, is a place people
     * tell each other about. If a second ever lands, this fails and somebody has
     * to argue for it next to the first.
     */
    const bosses = MONSTER_TEMPLATES.filter((t) => t.rank === ActorRank.Boss);
    expect(bosses.map((t) => t.id)).toEqual(['index_watcher']);

    const rooms = [...SITES.keys()].filter((id) => specFor(id)?.boss !== undefined);
    expect(rooms).toEqual(['site:redaction:watchers_altar']);
  });

  it('passes the same validator as everything else', () => {
    const watcher = monsterById('index_watcher');
    expect(watcher).toBeDefined();
    if (watcher === undefined) return;
    expect(validateTemplate(watcher)).toEqual([]);
  });

  it('cannot stun-lock, which the first version did', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BUG THIS CREATURE SHIPPED WITH INTERNALLY, AND THE REASON FOR THE
     * ONLY DEVIATION FROM ITS SOURCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `crystal.lua:30` declares `talent_in = 1` and the first version ported it
     * verbatim alongside a two-turn stun. THIS ENGINE'S ORB HAS NO TO-HIT ROLL
     * — `scheduler.ts` is explicit that *"counterplay against a travelling shot
     * is 100% POSITIONAL"* — so every shot lands, and a player stunned by one
     * cannot move out of the way of the next. A permanent lock from eleven
     * tiles, with no roll anywhere to save them.
     *
     * THE INVARIANT, stated so it survives a retune of either number: the stun
     * must be strictly shorter than the gap between shots. Anything else is a
     * creature that takes a player out of the game rather than one that hurts.
     */
    const watcher = monsterById('index_watcher');
    if (watcher === undefined) throw new Error('no watcher');
    expect(watcher.onHit?.effectId).toBe('effect:stunned');

    const shotsPerPlayerTurn = watcher.globalSpeed / (watcher.talentIn ?? 1);
    const turnsBetweenShots = 1 / shotsPerPlayerTurn;
    expect(
      watcher.onHit?.turns ?? 0,
      'the stun lasts at least as long as the gap between shots — that is a lock',
    ).toBeLessThan(turnsBetweenShots);
  });

  it('is the only thing in the game that stuns a player', () => {
    // The mechanic is the whole reason it is a boss rather than a bigger cairn.
    // `EffectId.Stunned` was applied by exactly one call site before this — the
    // Watchman's own `lockdown` talent — so a monster doing it is new content
    // built entirely from proven machinery.
    const stunners = MONSTER_TEMPLATES.filter((t) => t.onHit?.effectId === 'effect:stunned');
    expect(stunners.map((t) => t.id)).toEqual(['index_watcher']);
  });

  it('does not raise the damage ceiling, and is not meant to', () => {
    /**
     * A boss is the LONGEST fight, not the sharpest. Measured: 5.95 damage a
     * player turn, below `INDEX_CAIRN`'s 7.00 — its threat is two hundred and
     * twenty hit points and the turns it takes away, not the number per shot.
     * Asserted as a comparison so a future retune of anything else has to come
     * past it.
     */
    const watcher = monsterById('index_watcher');
    if (watcher === undefined) throw new Error('no watcher');
    const perTurn = (t: (typeof MONSTER_TEMPLATES)[number]): number =>
      (((t.damageMin ?? 0) + (t.damageMax ?? 0)) / 2) * t.globalSpeed * (1 / (t.talentIn ?? 1));

    const kiters = MONSTER_TEMPLATES.filter((t) => t.projSpeed !== undefined);
    expect(kiters.length).toBeGreaterThan(2);
    expect(perTurn(watcher)).toBeLessThan(Math.max(...kiters.map(perTurn)) + 0.001);
    // AND IT IS THE BIGGEST THING IN THE GAME BY A MARGIN, which is where the
    // fight length actually comes from.
    const others = MONSTER_TEMPLATES.filter((t) => t.id !== 'index_watcher');
    expect(watcher.maxHp).toBeGreaterThan(Math.max(...others.map((t) => t.maxHp)) * 2);
  });

  it('has a dead zone you can get inside, which is the counter', () => {
    /**
     * `ai/npc.ts#kite`: inside `minRange` it backs away, and *"CORNERED. hold
     * rather than fire a shot that will be refused"*. So the counter to two
     * hundred and twenty hit points of artillery is to close on it — and
     * `populateDelve` places it at the point furthest from the door, which in a
     * generated ruin is a corner, so the ground it retreats into is ground it
     * has already used.
     *
     * The dead zone must therefore be REAL and reachable: a zero would mean no
     * counter, and `MAX_SAFE_MIN_RANGE` is 3 because beyond that the Chebyshev
     * and Euclidean tests stop agreeing.
     */
    const watcher = monsterById('index_watcher');
    if (watcher === undefined) throw new Error('no watcher');
    expect(watcher.minRange).toBeGreaterThan(0);
    expect(watcher.minRange).toBe(watcher.combat.minRange);
    expect(watcher.preferredRange).toBeGreaterThan(watcher.minRange);
  });
});

describe('the room it is in', () => {
  it('puts it at the far end, and leaves a way to reach it', () => {
    /**
     * MEASURED ON A REAL FLOOR rather than asserted about the generator. A boss
     * that spawned three tiles from the entrance is a boss you walk up to; one
     * placed somewhere unreachable is worse than none at all.
     */
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed: 'boss-room',
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });

    const site = SITES.get('site:redaction:watchers_altar');
    expect(site).toBeDefined();
    if (site === undefined) return;

    const realm = realms.open(site, 'party', { level: 8, size: 4 });
    const boss = [...realm.world.allActors()].find(
      (a) => a.kind === ActorKind.Monster && a.rank === ActorRank.Boss,
    );
    expect(boss, 'the room generated without its boss').toBeDefined();
    const door = realm.spawns[0];
    if (boss === undefined || door === undefined) return;

    // FAR. Not a fixed number — the generator decides the room — but further
    // than its own reach, or the fight starts already joined.
    const away = Math.max(Math.abs(boss.x - door.x), Math.abs(boss.y - door.y));
    expect(away).toBeGreaterThan(boss.attackRange);

    // AND HOLDING SOMETHING. The one authored body in the game does not roll
    // for whether the walk was worth it.
    expect(boss.carried?.length ?? 0).toBeGreaterThan(0);
  });

  it('leaves Alderbrook’s altar alone', () => {
    // The twin is a `restless` room seventy steps from town that a level-3
    // party clears. The country that ENDED is where the thing that outlasted
    // the ending lives — and the near country must stay learnable.
    expect(specFor('site:watchers_altar')?.boss).toBeUndefined();
  });
});
