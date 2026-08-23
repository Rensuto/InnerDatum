// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:971-1075 (`restCheck`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { RestStop, restBonus, restCheck, restStopText } from '../../src/shared/rest.ts';
import type { RestView } from '../../src/shared/rest.ts';

/** A body with nothing wrong with it: full, calm, unafflicted, alone. */
const settled: RestView = {
  hp: 60,
  maxHp: 60,
  hpRegen: 0.5,
  resource: { value: 100, max: 100, regenPerTurn: 0.6 },
  afflicted: false,
  cooling: false,
  threat: null,
};

const hurt = (over: Partial<RestView> = {}): RestView => ({ ...settled, hp: 20, ...over });

describe('what keeps a body resting', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * REST IS NOT "UNTIL HEALTH IS FULL". That is the version everybody writes,
   * and upstream spent fifteen years not writing it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Player.lua:1004-1049 keeps going for FOUR different reasons, and three of
   * them are the ones that make rest worth pressing: a pool still filling, an
   * affliction still running, a cooldown still turning. A rest that stopped at
   * full health would leave a party walking into the next room slowed, poisoned
   * and with every button grey.
   */
  it('rests while health is missing', () => {
    expect(restCheck(hurt()).rest).toBe(true);
  });

  it('rests while the class pool is still filling', () => {
    expect(
      restCheck({ ...settled, resource: { value: 10, max: 100, regenPerTurn: 0.6 } }).rest,
    ).toBe(true);
  });

  it('rests off an affliction, which is most of why you press it', () => {
    // :1023-1029. Full health, full pool, still slowed — keep going.
    expect(restCheck({ ...settled, afflicted: true }).rest).toBe(true);
  });

  it('rests out a cooldown, so the next room starts with buttons', () => {
    // :1041-1049's `wait_cooldowns`.
    expect(restCheck({ ...settled, cooling: true }).rest).toBe(true);
  });

  it('stops when there is genuinely nothing left to gain', () => {
    const answer = restCheck(settled);
    expect(answer.rest).toBe(false);
    if (answer.rest) return;
    expect(answer.stop).toBe(RestStop.Done);
  });
});

describe('what interrupts it', () => {
  it('stops for a hostile, and says which way', () => {
    /**
     * Player.lua:974-981, and the DIRECTION is the point. Upstream formats
     * "hostile spotted to the %s (%s)" because a rest that ends with no
     * explanation is an alarm with no information in it — the player has to
     * find the thing before they can decide anything.
     */
    const answer = restCheck({ ...hurt(), threat: { name: 'Index Husk', dx: 3, dy: -4 } });
    expect(answer.rest).toBe(false);
    if (answer.rest) return;
    expect(answer.stop).toBe(RestStop.Hostile);
    expect(answer.threat?.name).toBe('Index Husk');
  });

  it('reports the hostile even while bleeding, because that is the actionable half', () => {
    /**
     * THE ORDER IS UPSTREAM'S AND IT IS LOAD-BEARING. `restCheck` tests spotted
     * hostiles at :974, long before `life_regen <= 0` at :1003. A body that is
     * both bleeding and being approached is told about the thing approaching,
     * because that is the fact it can still do something about.
     */
    const answer = restCheck({ ...hurt({ hpRegen: -1 }), threat: { name: 'Husk', dx: 1, dy: 0 } });
    expect(answer.rest).toBe(false);
    if (answer.rest) return;
    expect(answer.stop).toBe(RestStop.Hostile);
  });

  it('stops when health is going DOWN rather than up', () => {
    // :1003 — `if self.life_regen <= 0 then return false, "losing health!"`.
    const answer = restCheck(hurt({ hpRegen: -0.5 }));
    expect(answer.rest).toBe(false);
    if (answer.rest) return;
    expect(answer.stop).toBe(RestStop.Bleeding);
  });

  it('stops rather than waiting on a pool that cannot fill', () => {
    /**
     * A REST THAT NEVER ENDS IS THE BUG THIS GUARDS. Upstream's own comment at
     * :1000 says it: *"Check resources, make sure they CAN go up, otherwise we
     * will never stop"*. A pool at half with a zero trickle is exactly that
     * state, and the Alchemist's Reagents regenerate on a slow counter rather
     * than per turn.
     */
    const answer = restCheck({
      ...settled,
      resource: { value: 4, max: 8, regenPerTurn: 0 },
    });
    expect(answer.rest).toBe(false);
    if (answer.rest) return;
    expect(answer.stop).toBe(RestStop.Done);
  });

  it('does not wait on a body with no pool at all', () => {
    expect(restCheck({ ...settled, resource: null }).rest).toBe(false);
  });
});

describe('rest gets faster the longer it runs', () => {
  /**
   * Player.lua:986 — `local perc = math.min(self.resting.cnt / 10, 8)`.
   *
   * The whole FEEL of resting is this one line. Flat regen makes a long rest a
   * long wait; this makes the first few turns ordinary and a settled rest brisk,
   * so a player who needs eighty turns of healing does not sit through eighty
   * turns of it.
   */
  it('starts at nothing and climbs a tenth a turn', () => {
    expect(restBonus(0)).toBe(0);
    expect(restBonus(10)).toBe(1);
    expect(restBonus(35)).toBe(3.5);
  });

  it('caps at eight, which is upstream’s own ceiling', () => {
    expect(restBonus(80)).toBe(8);
    expect(restBonus(10_000)).toBe(8);
  });
});

describe('the player is always told why it ended', () => {
  it('names the creature and the bearing', () => {
    const answer = restCheck({ ...hurt(), threat: { name: 'Bent Watchman', dx: 0, dy: -5 } });
    const line = restStopText(answer, 12, 'north');
    expect(line).toContain('12');
    expect(line).toContain('Bent Watchman');
    expect(line).toContain('north');
  });

  it('says something different for a rest that never started', () => {
    // "You rest 0 turns" is a sentence about nothing. A player who pressed the
    // key and got no time should be told there was nothing to rest off.
    expect(restStopText(restCheck(settled), 0, 'here')).toBe('Nothing to rest off.');
  });

  it('reads as finished when it finished', () => {
    expect(restStopText(restCheck(settled), 30, 'here')).toContain('Ready');
  });
});
