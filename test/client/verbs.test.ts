/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { MapVerb } from '../../src/client/ui/contextmenu.ts';
import { TileLoot, verbsFor } from '../../src/client/ui/verbs.ts';
import { ActorKind, ActorRank, PartyAction } from '../../src/shared/protocol.ts';
import type { MenuItem } from '../../src/client/ui/contextmenu.ts';
import type { VerbContext, VerbTarget } from '../../src/client/ui/verbs.ts';
import type { ActorView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A RIGHT-CLICK OFFERS. NO PIXELS ARE ASSERTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no canvas test and no
 * jsdom here, and nothing below draws anything — the `/// <reference lib="dom">`
 * at the top exists only so that `MenuItem`, which comes from a file that also
 * declares a `CanvasRenderingContext2D` painter, resolves under
 * tsconfig.server.json's DOM-less lib set.
 *
 * TWO CLAIMS ARE LOAD-BEARING AND EVERYTHING ELSE IS BOOKKEEPING.
 *
 * FIRST, ZERO ROWS. `openTokenMenu` returns false on an empty list, and that
 * false is what preserves right-click's older meaning — cancelling an aim. Two
 * cases must produce nothing (yourself with nobody to leave, and a wall), and if
 * either ever starts offering a row the symptom is a targeting ring that cannot
 * be dismissed, which nobody would trace back to a menu.
 *
 * SECOND, GREYED RATHER THAN DROPPED. A row that vanishes when it is unavailable
 * teaches the player nothing about why. Kick out of leadership and Attack at
 * range are both still DRAWN, and asserting the enabled flag rather than the
 * row's presence is the only way to tell those two designs apart from a test.
 */

function actor(id: string, name: string, kind: ActorKind, alive = true): ActorView {
  return {
    id,
    name,
    sprite: kind === ActorKind.Player ? 'chr_player_watchman_s' : 'chr_husk_s',
    x: 4,
    y: 3,
    kind,
    rank: ActorRank.Normal,
    hp: alive ? 17 : 0,
    maxHp: 17,
    alive,
  };
}

const SELF_ID = 'actor_u_0000000000000001';

/** Everything but the target, which is what each case below varies. */
function ctxFor(
  target: VerbTarget,
  over: {
    readonly partyIds?: readonly string[];
    readonly selfLeads?: boolean;
    readonly adjacent?: boolean;
  } = {},
): VerbContext {
  return {
    target,
    selfId: SELF_ID,
    partyIds: new Set(over.partyIds ?? [SELF_ID]),
    selfLeads: over.selfLeads ?? false,
    adjacent: over.adjacent ?? false,
  };
}

const actionsOf = (items: readonly MenuItem[]): readonly string[] =>
  items.map((item) => item.action);

describe('verbsFor — a player', () => {
  it('offers nothing at all to yourself in a party of one', () => {
    const self = actor(SELF_ID, 'Dalt', ActorKind.Player);
    const menu = verbsFor(ctxFor({ kind: 'player', actor: self }));

    // ZERO ROWS IS THE RESULT, not a missing case. See the header.
    expect(menu.items).toHaveLength(0);
    expect(menu.title).toBe('Dalt');
  });

  it('offers exactly Leave to yourself once there is somebody to leave', () => {
    const self = actor(SELF_ID, 'Dalt', ActorKind.Player);
    const menu = verbsFor(
      ctxFor({ kind: 'player', actor: self }, { partyIds: [SELF_ID, 'actor_u_02'] }),
    );

    expect(actionsOf(menu.items)).toEqual([PartyAction.Leave]);
    expect(menu.items[0]?.enabled).toBe(true);
  });

  it('offers Kick for a party member, greyed unless you lead', () => {
    const mate = actor('actor_u_02', 'Sam', ActorKind.Player);
    const target: VerbTarget = { kind: 'player', actor: mate };
    const follower = verbsFor(ctxFor(target, { partyIds: [SELF_ID, 'actor_u_02'] }));
    const leader = verbsFor(ctxFor(target, { partyIds: [SELF_ID, 'actor_u_02'], selfLeads: true }));

    expect(actionsOf(follower.items)).toEqual([PartyAction.Kick]);
    expect(follower.items[0]?.enabled).toBe(false);

    // Same shape, one flag apart — the row does not appear and disappear.
    expect(actionsOf(leader.items)).toEqual([PartyAction.Kick]);
    expect(leader.items[0]?.enabled).toBe(true);
  });

  it('offers Invite to somebody who is not in the party', () => {
    const stranger = actor('actor_u_09', 'Ren', ActorKind.Player);
    const menu = verbsFor(ctxFor({ kind: 'player', actor: stranger }));

    expect(actionsOf(menu.items)).toEqual([PartyAction.Invite]);
    expect(menu.items[0]?.enabled).toBe(true);
  });
});

describe('verbsFor — a hostile', () => {
  const husk = actor('actor_m_01', 'index husk', ActorKind.Monster);

  it('enables Attack when adjacent, beside Walk up to and Inspect', () => {
    const menu = verbsFor(ctxFor({ kind: 'hostile', actor: husk }, { adjacent: true }));

    expect(actionsOf(menu.items)).toEqual([MapVerb.Attack, MapVerb.Travel, MapVerb.Inspect]);
    expect(menu.items.map((item) => item.enabled)).toEqual([true, true, true]);
  });

  it('still DRAWS Attack at range, greyed', () => {
    const menu = verbsFor(ctxFor({ kind: 'hostile', actor: husk }, { adjacent: false }));

    // Greyed rather than dropped — the same rule the hotbar follows for a slot
    // on cooldown. Dropping it would move the two rows underneath it.
    expect(actionsOf(menu.items)).toEqual([MapVerb.Attack, MapVerb.Travel, MapVerb.Inspect]);
    expect(menu.items[0]?.enabled).toBe(false);
    expect(menu.items[1]?.enabled).toBe(true);
    expect(menu.items[2]?.enabled).toBe(true);
  });
});

describe('verbsFor — a body', () => {
  it('offers Inspect and nothing else', () => {
    const corpse = actor('actor_m_02', 'index husk', ActorKind.Monster, false);
    const menu = verbsFor(ctxFor({ kind: 'body', actor: corpse }, { adjacent: true }));

    // Adjacency is deliberately true here: there is still no Attack row. A
    // corpse blocks nothing and answers nothing.
    expect(actionsOf(menu.items)).toEqual([MapVerb.Inspect]);
    expect(menu.items[0]?.enabled).toBe(true);
  });
});

describe('verbsFor — bare ground', () => {
  it('offers Travel here and Point here on walkable floor', () => {
    const menu = verbsFor(ctxFor({ kind: 'tile', tile: { x: 12, y: 7 }, walkable: true }));

    expect(actionsOf(menu.items)).toEqual([MapVerb.Travel, MapVerb.Point]);
    expect(menu.items.every((item) => item.enabled)).toBe(true);
    expect(menu.title).toContain('12,7');
  });

  it('offers nothing on a wall or off the grid', () => {
    const wall = verbsFor(ctxFor({ kind: 'tile', tile: { x: 0, y: 0 }, walkable: false }));

    // `walkable` is `travelTargetAllowed`'s answer, which is false for both.
    expect(wall.items).toHaveLength(0);
  });
});

describe('verbsFor — loot on the floor', () => {
  const tile = { x: 12, y: 7 };

  it('offers Pick up, enabled, on the tile the viewer is standing on', () => {
    const menu = verbsFor(ctxFor({ kind: 'tile', tile, walkable: true, loot: TileLoot.Underfoot }));

    // FIRST IN THE LIST: it is the only row here that is about the world rather
    // than about the pointer, and on the tile you are already standing on
    // "Travel here" is a no-op that would otherwise sit under the cursor.
    expect(actionsOf(menu.items)).toEqual([MapVerb.Pickup, MapVerb.Travel, MapVerb.Point]);
    expect(menu.items.map((item) => item.enabled)).toEqual([true, true, true]);
  });

  it('still DRAWS Pick up on a pile out of reach, greyed', () => {
    const menu = verbsFor(
      ctxFor({ kind: 'tile', tile, walkable: true, loot: TileLoot.OutOfReach }),
    );

    // The Attack-at-range case exactly: greyed rather than dropped, because "there
    // is something there, walk onto it" is the whole lesson. It cannot be enabled
    // at range — `pickup` carries no coordinate, the server reads the sender's own
    // live tile — so an enabled row would lie about what the click does.
    expect(actionsOf(menu.items)).toEqual([MapVerb.Pickup, MapVerb.Travel, MapVerb.Point]);
    expect(menu.items.map((item) => item.enabled)).toEqual([false, true, true]);
  });

  it('drops the row entirely on a tile with nothing on it', () => {
    // NOT the greyed treatment, and the difference is deliberate: a permanently
    // greyed Pick up on every square of the map would be furniture on the surface
    // a player right-clicks most, and it would teach nothing about loot because it
    // would never change.
    const none = verbsFor(ctxFor({ kind: 'tile', tile, walkable: true, loot: TileLoot.None }));
    expect(actionsOf(none.items)).toEqual([MapVerb.Travel, MapVerb.Point]);
  });

  it('drops the row when the caller cannot say, rather than guessing', () => {
    // `loot` is optional and absent means "this caller does not read the `ground`
    // frame yet" — main.ts, until the frame is wired up. Both readings drop the
    // row, so an unwired caller offers nothing rather than promising something it
    // cannot deliver.
    const unwired = verbsFor(ctxFor({ kind: 'tile', tile, walkable: true }));
    expect(actionsOf(unwired.items)).toEqual([MapVerb.Travel, MapVerb.Point]);
  });

  it('offers nothing at all on a wall, whatever it is told about loot', () => {
    // Loot cannot be on a wall, but the menu must not be the thing that depends on
    // that: a wall keeps right-click's older meaning over the two thirds of the map
    // that is not walkable, and one contradictory field must not reopen it.
    const wall = verbsFor(
      ctxFor({ kind: 'tile', tile, walkable: false, loot: TileLoot.Underfoot }),
    );
    expect(wall.items).toHaveLength(0);
  });
});

describe('verbsFor — every label fits the box', () => {
  it('keeps every label short enough for contextmenu.ts to draw whole', () => {
    const husk = actor('actor_m_01', 'index husk', ActorKind.Monster);
    const mate = actor('actor_u_02', 'Sam', ActorKind.Player);
    const everything: readonly VerbContext[] = [
      ctxFor(
        { kind: 'player', actor: actor(SELF_ID, 'Dalt', ActorKind.Player) },
        { partyIds: [SELF_ID, 'actor_u_02'] },
      ),
      ctxFor({ kind: 'player', actor: mate }, { partyIds: [SELF_ID, 'actor_u_02'] }),
      ctxFor({ kind: 'player', actor: actor('actor_u_09', 'Ren', ActorKind.Player) }),
      ctxFor({ kind: 'hostile', actor: husk }, { adjacent: true }),
      ctxFor({ kind: 'body', actor: actor('actor_m_02', 'index husk', ActorKind.Monster, false) }),
      ctxFor({ kind: 'tile', tile: { x: 12, y: 7 }, walkable: true }),
      // The loot row is in the sweep too, or the one label added at v10 would be
      // the one label nothing measures.
      ctxFor({ kind: 'tile', tile: { x: 12, y: 7 }, walkable: true, loot: TileLoot.Underfoot }),
    ];

    // MAX_W 184 less one border and one gutter each side is 172 pixels, and at
    // CHAR_W 6 that is 28 glyphs. A longer label is drawn past the border.
    const labels = everything.flatMap((ctx) => verbsFor(ctx).items.map((item) => item.label));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(29);
  });
});
