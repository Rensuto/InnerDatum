/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { MapVerb } from '../../src/client/ui/contextmenu.ts';
import { TileLoot, verbsFor } from '../../src/client/ui/verbs.ts';
import {
  ActorKind,
  ActorRank,
  PartyAction,
  TOPIC_LABEL,
  TopicId,
} from '../../src/shared/protocol.ts';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY QUESTION THE TOWNSFOLK CAN ANSWER HAS A ROW TO ASK IT WITH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TOPIC_ROWS` was a hand-written list of TWO, against a `TopicId` of four —
 * under a comment claiming the opposite: "The ids and labels are
 * content/townsfolk.ts's — imported rather than retyped, so a topic added there
 * appears here." Only the LABELS were imported. The rows were retyped, so the
 * two topics added later never grew a button.
 *
 * WHAT THAT COST, counted from the content: 51 authored answers across ten
 * people, of which 30 had no way to be asked for. Both level-gated `later`
 * rumours and — since `handleTalk` is the only caller of `regionNamedIn` — the
 * entire rumour-marks-your-map mechanic, which had therefore never fired for
 * any player.
 *
 * The server half was green the whole time: `test/server/rumour-gate.test.ts`
 * passes because it writes `{t:'talk', topic:'rumour'}` straight onto the
 * socket, which no client could produce. A probe that speaks the protocol
 * directly cannot see a missing button.
 *
 * ASSERTED FROM `TopicId`, not from a list of four strings — a fifth topic must
 * fail this until it has a row, which is the whole point.
 */
describe('the ask rows cover every topic that exists', () => {
  it('offers one row per TopicId when adjacent to a townsperson', () => {
    const townsfolk: ActorView = {
      ...actor('npc_merrow', 'Merrow the Carter', ActorKind.Monster),
      faction: 'townsfolk',
    };

    const items = verbsFor(ctxFor({ kind: 'hostile', actor: townsfolk }, { adjacent: true })).items;
    const asked = items.flatMap((item) => (item.topic === undefined ? [] : [item.topic]));

    expect([...asked].sort()).toEqual([...Object.values(TopicId)].sort());
  });

  it('labels each row from the shared table, so the words cannot drift', () => {
    const townsfolk: ActorView = {
      ...actor('npc_merrow', 'Merrow the Carter', ActorKind.Monster),
      faction: 'townsfolk',
    };

    const items = verbsFor(ctxFor({ kind: 'hostile', actor: townsfolk }, { adjacent: true })).items;
    for (const topic of Object.values(TopicId)) {
      const row = items.find((item) => item.topic === topic);
      expect(row?.label, topic).toBe(TOPIC_LABEL[topic]);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE PICK UP ROW MUST BE REACHABLE IN THE STATE IT IS FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It was built, dispatched correctly, covered by tests, and could never render
 * enabled on any tile in the game.
 *
 * `loot` lived only on the `tile` target, which `targetAt` returns ONLY when no
 * actor stands there — and `lootAt` answers `Underfoot` ONLY on the tile the
 * viewer is standing on, where the actor is the viewer. The two conditions were
 * mutually exclusive by construction. Solo, standing on a pile, the menu did
 * not open at all: the self arm returned `NO_ITEMS` and `openVerbMenu` bails on
 * an empty list.
 *
 * The existing tests passed throughout, because every one of them asked the
 * `tile` arm for a tile the viewer was NOT standing on — a state in which the
 * row is correctly absent.
 *
 * ═══ ToME COMPOSES LAYERS INSTEAD OF CLASSIFYING A TILE ═══
 * MapMenu.lua:128-133 queries TERRAIN, TRAP, OBJECT, ACTOR and PROJECTILE
 * independently, and its "Pickup item" row (MapMenu.lua:138) sits beside the
 * actor row (:140) on one tile. Upstream never collapses a tile to one kind.
 */
describe('picking up what is under your own feet', () => {
  it('offers the row to yourself when you are standing on a pile', () => {
    const self = actor(SELF_ID, 'Dalt', ActorKind.Player);
    const menu = verbsFor(ctxFor({ kind: 'player', actor: self, loot: TileLoot.Underfoot }));

    expect(actionsOf(menu.items)).toContain(MapVerb.Pickup);
    const row = menu.items.find((item) => item.action === MapVerb.Pickup);
    expect(row?.enabled, 'the row is offered greyed, which is the dead state again').toBe(true);
  });

  /**
   * AND THE SILENCE SURVIVES WHERE IT MATTERS. An empty self menu is what keeps
   * right-click-to-cancel-aim alive, so a tile with nothing on it must still
   * produce no rows at all.
   */
  it('still offers nothing to yourself on bare floor, alone', () => {
    const self = actor(SELF_ID, 'Dalt', ActorKind.Player);
    expect(verbsFor(ctxFor({ kind: 'player', actor: self })).items).toHaveLength(0);
    expect(
      verbsFor(ctxFor({ kind: 'player', actor: self, loot: TileLoot.None })).items,
    ).toHaveLength(0);
  });

  it('puts the world before the party when both have something to say', () => {
    const self = actor(SELF_ID, 'Dalt', ActorKind.Player);
    const menu = verbsFor(
      ctxFor(
        { kind: 'player', actor: self, loot: TileLoot.Underfoot },
        { partyIds: [SELF_ID, 'actor_u_02'] },
      ),
    );

    // Pick up acts on the WORLD; Leave acts on the party. The world row leads.
    expect(actionsOf(menu.items)).toEqual([MapVerb.Pickup, PartyAction.Leave]);
  });

  /**
   * A ROW ON SOMEBODY ELSE'S TILE WOULD LIE. `pickup` carries no coordinate —
   * the server takes what is under the SENDER — so the only honest place for
   * this row is the viewer's own body.
   */
  it('never offers it on a teammate, whatever is under them', () => {
    const mate = actor('actor_u_02', 'Sam', ActorKind.Player);
    const menu = verbsFor(
      ctxFor(
        { kind: 'player', actor: mate, loot: TileLoot.Underfoot },
        { partyIds: [SELF_ID, 'actor_u_02'] },
      ),
    );
    expect(actionsOf(menu.items)).not.toContain(MapVerb.Pickup);
  });
});

describe('a pile is a list, not a lid', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `pickup` TOOK INDEX 0 AND NOTHING ELSE, SO INDEX 0 COULD BE A WALL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * An item the player ALREADY OWNS sitting on top of a pile made everything
   * under it permanently unreachable — the refusal is "you already have a
   * Watchman's Coat" and no control anywhere could ask for the thing beneath.
   * Same for a full bag over a pile with coins in it.
   *
   * Upstream's answer is `ShowPickupFloor`: the tile's whole list, and you pick.
   * These rows are that list, in the menu that already exists.
   */
  const tile = { x: 12, y: 7 };
  const pileOf = (...names: string[]) => names.map((name, i) => ({ id: `g${String(i)}`, name }));

  const rows = (
    pile: readonly { id: string; name?: string }[],
    loot: TileLoot = TileLoot.Underfoot,
  ) =>
    verbsFor(ctxFor({ kind: 'tile', tile, walkable: true, loot, pile })).items.filter(
      (item) => item.action === MapVerb.Pickup,
    );

  it('keeps one bare row when there is nothing to choose between', () => {
    // WITH ONE ITEM the bare frame is the right frame — it is what `,` sends,
    // and two controls saying the same thing beats naming something the player
    // can already see. Upstream opens its dialog on the same condition.
    const only = rows(pileOf('Watchman’s Coat'));
    expect(only).toHaveLength(1);
    expect(only[0]?.label).toBe('Pick up');
    expect(only[0]?.groundId, 'a lone row means the top of the pile').toBeUndefined();
  });

  it('names every item once there is a choice', () => {
    const many = rows(pileOf('Watchman’s Coat', 'Signet', 'Boots'));
    expect(many).toHaveLength(3);
    expect(many.map((item) => item.label)).toEqual([
      'Take Watchman’s Coat',
      'Take Signet',
      'Take Boots',
    ]);
    // THE ID IS WHAT MAKES THE SECOND ITEM REACHABLE AT ALL.
    expect(many.map((item) => item.groundId)).toEqual(['g0', 'g1', 'g2']);
  });

  it('keeps the server’s order and never re-sorts it', () => {
    // `World.itemsAt` fixes the order so "the top of the pile" means one thing
    // to the server, this menu and a replay. A sort here would make the bare
    // `,` frame and the first row disagree about which item that is.
    const many = rows(pileOf('Zeta', 'Alpha', 'Mid'));
    expect(many.map((item) => item.label)).toEqual(['Take Zeta', 'Take Alpha', 'Take Mid']);
  });

  it('still lists what is on a tile you are not standing on, greyed', () => {
    // A greyed row is how a player learns what is over there, which is what
    // makes walking to it a decision.
    const far = rows(pileOf('Coat', 'Signet'), TileLoot.OutOfReach);
    expect(far).toHaveLength(2);
    expect(far.every((item) => !item.enabled)).toBe(true);
  });

  it('says out loud when a pile is deeper than the menu', () => {
    // ui/caselog.ts's rule: a list that has stopped short says so. The menu has
    // no scroll, so an unbounded pile would be a box taller than the window.
    const deep = rows(pileOf('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'));
    expect(deep).toHaveLength(7);
    expect(deep.at(-1)?.label).toBe('…and 2 more underneath');
    expect(deep.at(-1)?.enabled, 'the note is a sentence, not a control').toBe(false);
  });

  it('falls back to the bare verb for an item with no name', () => {
    // `GroundItemView.name` is optional on the wire, and a blank label is worse
    // than a generic one.
    const rowsHere = rows([{ id: 'g0' }, { id: 'g1', name: 'Signet' }]);
    expect(rowsHere[0]?.label).toBe('Pick up');
    expect(rowsHere[0]?.groundId, 'it still names WHICH one').toBe('g0');
  });
});
