// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * THE CONTACT BANNER SAYS WHAT CHANGED, AND IT CHANGED DIFFERENTLY ALONE.
 *
 * Since 2026-09-23 a party in a fight takes its turns one at a time, in
 * initiative order, and the banner that announces the fight says so. A player
 * on their own has no order to be told about — the world moves on every action,
 * as ToME's does — so their banner says nothing about one.
 */

import { describe, expect, it } from 'vitest';

import { CombatCue, combatAnnouncement } from '../../src/client/ui/combatbanner.ts';
import { TurnActorKind, TurnActorState } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { TurnActor, TurnMsg } from '../../src/shared/protocol.ts';

function card(id: string, name: string, isSelf: boolean): TurnActor {
  return {
    id,
    name,
    kind: TurnActorKind.Player,
    state: TurnActorState.Waiting,
    hp: 30,
    maxHp: 30,
    isSelf,
    downed: false,
  };
}

function contact(players: readonly TurnActor[]): TurnMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'turn',
    gameTurn: 4,
    engagement: 3,
    inCombat: true,
    actors: players,
    whoseTurn: players.map((player) => player.id),
    current: players[0]?.id ?? null,
    committed: [],
    standingBy: [],
    bellMs: null,
  };
}

describe('the contact banner', () => {
  it('tells a party its turns go in order', () => {
    const party = contact([card('a', 'Dalt', true), card('b', 'Sam', false)]);
    expect(combatAnnouncement(CombatCue.Opened, party).detail).toContain('turns in order');
  });

  it('tells a player alone nothing about an order, or about a party', () => {
    const detail = combatAnnouncement(CombatCue.Opened, contact([card('a', 'Dalt', true)])).detail;
    expect(detail).toContain('every move costs a turn');
    expect(detail).not.toContain('order');
    expect(detail).not.toContain('party');
  });
});
