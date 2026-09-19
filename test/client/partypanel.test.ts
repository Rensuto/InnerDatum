/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { createContextMenu } from '../../src/client/ui/contextmenu.ts';
import {
  WIDEST_POOL_LINE_W,
  poolLineW,
  poolText,
  resourceStripH,
} from '../../src/client/ui/resource.ts';
import {
  PARTY_PANE_COMPACT_W,
  PARTY_PANE_MIN_H,
  PARTY_PANE_W,
  PartyPaneMode,
  drawPartyPane,
  paneRowW,
  partyPaneHeight,
  partyPaneHitAt,
  partyPaneLayout,
  partyPaneTipAt,
  partyPaneView,
  poolStripW,
  survivalWord,
} from '../../src/client/ui/partypanel.ts';
// ═══ THE REAL CLASS TABLE AND THE REAL POOL RULES, FROM THE SERVER ═══
// Not a fixture. The whole point of the width test below is that it walks what
// the game actually authors — `fixture-bands-are-not-panel-bands` is exactly
// this class of bug, a layout that passed its own fixture and dropped content
// live. A client module may not import these; a test may, and must.
import { CLASSES } from '../../src/server/content/classes.ts';
import { RESOURCE_RULES } from '../../src/server/engine/talents.ts';
import {
  DeathStage,
  deathAction,
  deathCause,
  deathHeadline,
  respawnPromptHit,
  respawnPromptRect,
} from '../../src/client/ui/respawnprompt.ts';
import type { DeathView } from '../../src/client/ui/respawnprompt.ts';
import { DEFAULT_KEYMAP } from '../../src/client/input/keymap.ts';
import { ActorKind, ActorRank, DownedStatus, PartyAction } from '../../src/shared/protocol.ts';
import { ResourceKind, TurnActorState, VoiceState } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { readFileSync } from 'node:fs';
import { PALETTE } from '../../src/client/render/canvas.ts';
import type { SpriteSource } from '../../src/client/render/assets.ts';
import type { MapVerb } from '../../src/client/ui/contextmenu.ts';
import type {
  PartyPaneHit,
  PartyPaneLayout,
  PartyPaneView,
} from '../../src/client/ui/partypanel.ts';
import type {
  ActorView,
  EffectView,
  PartyInviteView,
  PartyMember,
  PartyStateMember,
  PartyStateMsg,
} from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PARTY PANE, READ THE WAY A CLICK READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no canvas test and no
 * jsdom here, and nothing below paints anything. What is tested is the layer
 * between the frame and the paint, and it is the layer where a bug is expensive:
 *
 *   THE JOIN     `party_state` carries the party; the Downed countdown, the
 *                microphone and the token sprite come from three other frames.
 *                A row that lost one of them silently would be a row that stops
 *                saying somebody is on the floor.
 *   THE ORDER    the server's, never re-sorted, because KICK IS ON THIS PANE and
 *                a row that moves between two frames is a row somebody misclicks
 *                into removing the wrong person.
 *   THE LAYOUT   full rows, or portraits-only, or nothing — decided by how much
 *                MAP would be left. The pane must never bury the playfield.
 *   THE HIT TEST the painter and the pointer read ONE geometry function, so
 *                ACCEPT cannot be drawn in one place and pressed in another.
 *
 * The hit tests below SCAN a column of points rather than asserting coordinates,
 * on purpose: an assertion that "accept is at y=61" would pass while being drawn
 * at y=59, because it would be testing the test's copy of the arithmetic. What
 * is asserted instead is what a player experiences — the buttons come before the
 * roster, ACCEPT is the left half and DECLINE the right, and the rows appear in
 * the frame's own order.
 *
 * The `reference lib="dom"` at the top has the same cost the turn-card test
 * documents: tests compile under tsconfig.server.json, whose lib has no DOM, and
 * ui/partypanel.ts is typed against `CanvasRenderingContext2D`.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function member(over: Partial<PartyStateMember> & { id: string; name: string }): PartyStateMember {
  return {
    hp: 40,
    maxHp: 58,
    state: TurnActorState.Waiting,
    isLeader: false,
    isSelf: false,
    online: true,
    // NULL, NOT ABSENT. Every member row says where they are, and "here" is a
    // real answer rather than a missing one — see `PartyStateMember.away`.
    away: null,
    ...over,
  };
}

function state(members: readonly PartyStateMember[], invites: readonly PartyInviteView[] = []) {
  const msg: PartyStateMsg = {
    v: PROTOCOL_VERSION,
    t: 'party_state',
    leaderId: members[0]?.id ?? 'actor_a',
    members,
    invites,
  };
  return msg;
}

function actor(id: string, name: string): ActorView {
  return {
    id,
    name,
    sprite: 'chr_player_alchemist_s',
    x: 3,
    y: 4,
    kind: ActorKind.Player,
    rank: ActorRank.Normal,
    hp: 40,
    maxHp: 58,
    alive: true,
  };
}

function rosterRow(id: string, name: string, over: Partial<PartyMember> = {}): PartyMember {
  return { id, name, downed: null, voice: VoiceState.Silent, connected: true, ...over };
}

/** A party of three, with one of them the viewer. */
function trio(invites: readonly PartyInviteView[] = []): PartyPaneView {
  return partyPaneView({
    state: state(
      [
        member({ id: 'actor_a', name: 'Dalt', isSelf: true, isLeader: true }),
        member({ id: 'actor_b', name: 'Sam', state: TurnActorState.Committed }),
        member({ id: 'actor_c', name: 'Mo', online: false }),
      ],
      invites,
    ),
    invites,
    roster: [
      rosterRow('actor_a', 'Dalt'),
      rosterRow('actor_b', 'Sam', { voice: VoiceState.Speaking }),
      rosterRow('actor_c', 'Mo', {
        connected: false,
        downed: { status: DownedStatus.Downed, marker: 'ui_marker_downed', turnsLeft: 3, total: 5 },
      }),
    ],
    actors: new Map([
      ['actor_a', actor('actor_a', 'Dalt')],
      ['actor_b', actor('actor_b', 'Sam')],
      // 'actor_c' is deliberately absent: a party member out of the viewer's FOV.
    ]),
    effects: new Map<string, readonly EffectView[]>([
      [
        'actor_b',
        [{ id: 'stun', name: 'Stunned', icon: 'icon_status_stun', turns: 2, harmful: true }],
      ],
    ]),
    inCombat: true,
    resource: null,
    progress: null,
    money: null,
  });
}

/** A wide viewport, with the Case Log taking its usual 208 on the right. */
function wideLayout(view: PartyPaneView): PartyPaneLayout {
  const layout = partyPaneLayout({ view, width: 900, top: 20, bottom: 420, rightReserved: 214 });
  if (layout === null) throw new Error('expected a pane on a 900px viewport');
  return layout;
}

/**
 * Every distinct thing a vertical line of points lands on, top to bottom.
 *
 * Consecutive duplicates are collapsed, so the result is the ORDER of the
 * controls rather than how many pixels each one is tall.
 */
function scan(view: PartyPaneView, layout: PartyPaneLayout, x: number): PartyPaneHit[] {
  const out: PartyPaneHit[] = [];
  for (let y = layout.rect.y; y < layout.rect.y + layout.rect.h; y += 1) {
    const hit = partyPaneHitAt(view, layout, x, y);
    if (hit === null) continue;
    const last = out[out.length - 1];
    if (last !== undefined && JSON.stringify(last) === JSON.stringify(hit)) continue;
    out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

describe('the pane draws the party frame and joins only what that frame cannot carry', () => {
  it('keeps the hp, the leader and the presence flag the server sent', () => {
    const view = trio();
    expect(view.rows.map((row) => row.member.name)).toEqual(['Dalt', 'Sam', 'Mo']);
    expect(view.rows[0]?.member.isLeader).toBe(true);
    expect(view.rows[2]?.member.online).toBe(false);
  });

  it('joins the Downed countdown from the level roster, which owns the number', () => {
    const view = trio();
    expect(view.rows[2]?.downed).toEqual({
      status: DownedStatus.Downed,
      marker: 'ui_marker_downed',
      turnsLeft: 3,
      total: 5,
    });
    expect(view.rows[0]?.downed).toBeNull();
  });

  it('joins the microphone and the badges by actor id', () => {
    const view = trio();
    expect(view.rows[1]?.voice).toBe(VoiceState.Speaking);
    expect(view.rows[1]?.effects).toHaveLength(1);
    expect(view.rows[0]?.effects).toEqual([]);
  });

  it('still draws a row for a member who is OUT OF VIEW, without a sprite', () => {
    // The party pane earns its keep for exactly this person: a friend on the far
    // side of the floor, absent from the actor map, whose hp still has to show.
    const view = trio();
    expect(view.rows[2]?.sprite).toBeNull();
    expect(view.rows[2]?.member.hp).toBe(40);
  });

  it('does not put a stopwatch on a race that cannot be run', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE NUMBER IS ONLY TRUE ADVICE IF YOU ARE ON THEIR FLOOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * MEASURED, over a socket and across the content: following is instant and
     * costs no turn, but it drops you at the way out, `DOOR_CLEARANCE` puts no
     * body nearer than eight tiles to that spot, and one step is exactly one
     * tick. The follower closed from seven tiles to three as the clock went
     * 5, 4, 3, 2, 1, 0 — in the friendliest delve in the game. None of the
     * seventeen has a median body within the whole five turns.
     *
     * So the row keeps what is true — they are down, and the name still says
     * where — and drops the countdown, which from another floor is an
     * instruction to run that always ends three tiles short.
     */
    const clock = {
      status: DownedStatus.Downed,
      marker: 'ui_marker_downed',
      turnsLeft: 3,
      total: 5,
    };
    expect(survivalWord(clock, false)).toBe('DOWN 3/5');
    expect(survivalWord(clock, true)).toBe('DOWN');
  });

  it('says ERASED the same way wherever you are standing', () => {
    /**
     * NOT A COUNTDOWN IN EITHER PLACE, so there is nothing to withhold. Erased
     * is a state rather than a window — `revive` refuses an erased body by
     * design — and a body on your own floor is no more rescuable than one two
     * realms away. Asserted so a later edit to the branch above cannot quietly
     * take the word with it.
     */
    const gone = {
      status: DownedStatus.Erased,
      marker: 'ui_marker_erased',
      turnsLeft: 0,
      total: 5,
    };
    expect(survivalWord(gone, false)).toBe('ERASED');
    expect(survivalWord(gone, true)).toBe('ERASED');
  });

  it('takes the countdown off the party frame for a member on another floor', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ROSTER CANNOT DESCRIBE SOMEBODY WHO IS NOT ON YOUR FLOOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `PartyMember.downed` is scoped to one world, so a member who walked into
     * an instance is in no roster of yours — and this join read `null` for them
     * and drew no countdown, which is the one thing Downed exists to show. See
     * `PartyStateMember.downed`.
     */
    const view = partyPaneView({
      state: state([
        member({
          id: 'actor_gone',
          name: 'Sam',
          hp: 0,
          away: { place: 'Blackwood Outskirts', canFollow: true },
          downed: {
            status: DownedStatus.Downed,
            marker: 'ui_marker_downed',
            turnsLeft: 3,
            total: 5,
          },
        }),
      ]),
      invites: [],
      // EMPTY, AND THAT IS THE POINT — they are not on this floor.
      roster: [],
      actors: new Map(),
      effects: new Map(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    expect(view.rows[0]?.downed).toEqual({
      status: DownedStatus.Downed,
      marker: 'ui_marker_downed',
      turnsLeft: 3,
      total: 5,
    });
  });

  it('prefers the floor roster where both frames describe the same body', () => {
    /**
     * THE PRECEDENCE, AND WHY IT IS NOT ARBITRARY. Both fields are `downedView`
     * reading one survival table, so on your own floor they agree — and reading
     * the roster first keeps a body you can see described by the frame that has
     * always described it. Asserted with two DIFFERENT values so the test can
     * tell which one was used, rather than passing on the agreement.
     */
    const view = partyPaneView({
      state: state([
        member({
          id: 'actor_b',
          name: 'Sam',
          downed: {
            status: DownedStatus.Erased,
            marker: 'ui_marker_erased',
            turnsLeft: 0,
            total: 5,
          },
        }),
      ]),
      invites: [],
      roster: [
        rosterRow('actor_b', 'Sam', {
          downed: {
            status: DownedStatus.Downed,
            marker: 'ui_marker_downed',
            turnsLeft: 2,
            total: 5,
          },
        }),
      ],
      actors: new Map(),
      effects: new Map(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    expect(view.rows[0]?.downed?.status).toBe(DownedStatus.Downed);
    expect(view.rows[0]?.downed?.turnsLeft).toBe(2);
  });

  it('NEVER RE-SORTS. The order is the server’s, self included', () => {
    const view = partyPaneView({
      state: state([
        member({ id: 'actor_z', name: 'Zed' }),
        member({ id: 'actor_a', name: 'Ada', isSelf: true }),
      ]),
      invites: [],
      roster: [],
      actors: new Map(),
      effects: new Map(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    // Alphabetical would be Ada first; "self first" would be Ada first too. Both
    // would move a row under a cursor that is about to press Kick.
    expect(view.rows.map((row) => row.member.id)).toEqual(['actor_z', 'actor_a']);
  });
});

// ---------------------------------------------------------------------------
// The layout — the map is the game
// ---------------------------------------------------------------------------

describe('the pane collapses rather than burying the map', () => {
  it('draws full rows when ten tile columns are still clear', () => {
    const layout = partyPaneLayout({
      view: trio(),
      width: 900,
      top: 20,
      bottom: 420,
      rightReserved: 214,
    });
    expect(layout?.mode).toBe(PartyPaneMode.Rows);
    expect(layout?.rect.w).toBe(PARTY_PANE_W);
  });

  it('collapses to portraits on the 640px minimum viewport, instead of shrinking the map', () => {
    const layout = partyPaneLayout({
      view: trio(),
      width: 640,
      top: 20,
      bottom: 420,
      rightReserved: 214,
    });
    expect(layout?.mode).toBe(PartyPaneMode.Portraits);
    expect(layout?.rect.w).toBe(PARTY_PANE_COMPACT_W);
  });

  it('takes the full width back when the log is closed', () => {
    const layout = partyPaneLayout({
      view: trio(),
      width: 640,
      top: 20,
      bottom: 420,
      rightReserved: 0,
    });
    expect(layout?.mode).toBe(PartyPaneMode.Rows);
  });

  it('draws nothing at all rather than leaving the playfield unplayable', () => {
    const layout = partyPaneLayout({
      view: trio(),
      width: 300,
      top: 20,
      bottom: 420,
      rightReserved: 0,
    });
    expect(layout).toBeNull();
  });

  it('draws nothing before the server has described the party — never an empty box', () => {
    const empty = partyPaneView({
      state: state([]),
      invites: [],
      roster: [],
      actors: new Map(),
      effects: new Map(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    expect(
      partyPaneLayout({ view: empty, width: 900, top: 20, bottom: 420, rightReserved: 214 }),
    ).toBeNull();
  });

  it('shows a party of ONE as one row, not as nothing', () => {
    const solo = partyPaneView({
      state: state([member({ id: 'actor_a', name: 'Dalt', isSelf: true, isLeader: true })]),
      invites: [],
      roster: [rosterRow('actor_a', 'Dalt')],
      actors: new Map([['actor_a', actor('actor_a', 'Dalt')]]),
      effects: new Map(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    const layout = partyPaneLayout({
      view: solo,
      width: 900,
      top: 20,
      bottom: 420,
      rightReserved: 214,
    });
    expect(layout).not.toBeNull();
    expect(scan(solo, wideLayout(solo), wideLayout(solo).rect.x + 20)).toEqual([
      { kind: 'member', id: 'actor_a' },
    ]);
  });

  it('never asks for more height than the band it was given', () => {
    const view = trio();
    const layout = partyPaneLayout({
      view,
      width: 900,
      top: 20,
      bottom: 120,
      rightReserved: 214,
    });
    expect(layout).not.toBeNull();
    expect(layout?.rect.h).toBeLessThanOrEqual(100);
    // ...and it wanted more than that, which is why the clamp matters.
    expect(partyPaneHeight(view, PartyPaneMode.Rows)).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// The hit test — the painter and the pointer read one geometry
// ---------------------------------------------------------------------------

describe('what a click on the pane lands on', () => {
  it('answers the member rows in the frame’s order, top to bottom', () => {
    const view = trio();
    const layout = wideLayout(view);
    expect(scan(view, layout, layout.rect.x + 20)).toEqual([
      { kind: 'member', id: 'actor_a' },
      { kind: 'member', id: 'actor_b' },
      { kind: 'member', id: 'actor_c' },
    ]);
  });

  it('puts ACCEPT and DECLINE above the roster, and never on the same half', () => {
    const invites: readonly PartyInviteView[] = [
      { fromId: 'actor_x', fromName: 'Ren', size: 2, expiresInMs: 45_000 },
    ];
    const view = trio(invites);
    const layout = wideLayout(view);

    const left = scan(view, layout, layout.rect.x + 20);
    const right = scan(view, layout, layout.rect.x + layout.rect.w - 20);

    expect(left[0]).toEqual({ kind: 'accept', fromId: 'actor_x' });
    expect(right[0]).toEqual({ kind: 'decline', fromId: 'actor_x' });
    // The roster follows the invite in both columns, in the frame's order.
    expect(left.slice(1)).toEqual([
      { kind: 'member', id: 'actor_a' },
      { kind: 'member', id: 'actor_b' },
      { kind: 'member', id: 'actor_c' },
    ]);
  });

  it('answers null outside the panel', () => {
    const view = trio();
    const layout = wideLayout(view);
    expect(
      partyPaneHitAt(view, layout, layout.rect.x + layout.rect.w + 4, layout.rect.y + 30),
    ).toBeNull();
    expect(partyPaneHitAt(view, layout, layout.rect.x + 20, layout.rect.y - 4)).toBeNull();
  });

  it('has no buttons at all in the portraits-only form, only rows', () => {
    // There is no room for two labelled buttons at 44 pixels, so the compact
    // pane carries a mark and `/accept` is the way through. A button too small
    // to read would be worse than a command.
    const invites: readonly PartyInviteView[] = [
      { fromId: 'actor_x', fromName: 'Ren', size: 2, expiresInMs: 45_000 },
    ];
    const view = trio(invites);
    const layout = partyPaneLayout({
      view,
      width: 640,
      top: 20,
      bottom: 420,
      rightReserved: 214,
    });
    if (layout === null) throw new Error('expected a compact pane');
    const kinds = scan(view, layout, layout.rect.x + 14).map((hit) => hit.kind);
    expect(kinds).not.toContain('accept');
    expect(kinds).toEqual(['member', 'member', 'member']);
  });

  it('grows by exactly one invite block when an offer arrives', () => {
    const view = trio();
    const invited = trio([{ fromId: 'actor_x', fromName: 'Ren', size: 2, expiresInMs: 45_000 }]);
    expect(partyPaneHeight(invited, PartyPaneMode.Rows)).toBeGreaterThan(
      partyPaneHeight(view, PartyPaneMode.Rows),
    );
  });
});

// ---------------------------------------------------------------------------
// The token menu
// ---------------------------------------------------------------------------

describe('the token menu', () => {
  function menuWith(items: { action: PartyAction; label: string; enabled: boolean }[]) {
    let changes = 0;
    const menu = createContextMenu({
      onChange: () => {
        changes += 1;
      },
    });
    menu.open({
      x: 100,
      y: 100,
      title: 'Sam',
      items,
      viewportW: 640,
      viewportH: 480,
      targetId: 'actor_b',
    });
    return { menu, changes: () => changes };
  }

  it('opens where it was asked to, and remembers who it is about', () => {
    const { menu } = menuWith([
      { action: PartyAction.Invite, label: 'Invite to party', enabled: true },
    ]);
    expect(menu.visible()).toBe(true);
    expect(menu.targetId()).toBe('actor_b');
    expect(menu.rect()?.x).toBe(100);
  });

  it('flips rather than overflowing at the right edge', () => {
    const menu = createContextMenu({ onChange: () => undefined });
    menu.open({
      x: 630,
      y: 470,
      title: 'Sam',
      items: [{ action: PartyAction.Kick, label: 'Remove from party', enabled: true }],
      viewportW: 640,
      viewportH: 480,
      targetId: 'actor_b',
    });
    const rect = menu.rect();
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error('unreachable');
    expect(rect.x + rect.w).toBeLessThanOrEqual(640);
    expect(rect.y + rect.h).toBeLessThanOrEqual(480);
  });

  it('returns the row under the pointer', () => {
    const { menu } = menuWith([
      { action: PartyAction.Invite, label: 'Invite to party', enabled: true },
    ]);
    const rect = menu.rect();
    if (rect === null) throw new Error('unreachable');
    // `MenuItem.action` widened to `PartyAction | MapVerb` when the token menu
    // grew map verbs; the row under test is still a party one.
    let found: PartyAction | MapVerb | null = null;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const item = menu.itemAt(rect.x + 8, y);
      if (item !== null) found = item.action;
    }
    expect(found).toBe(PartyAction.Invite);
  });

  it('SWALLOWS a click on a disabled row instead of letting it reach the map', () => {
    const { menu } = menuWith([
      { action: PartyAction.Kick, label: 'Remove from party', enabled: false },
    ]);
    const rect = menu.rect();
    if (rect === null) throw new Error('unreachable');
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      expect(menu.itemAt(rect.x + 8, y)).toBeNull();
    }
    // ...and the pointer is still demonstrably ON the menu, which is what makes
    // it a swallowed click rather than a miss.
    expect(menu.contains(rect.x + 8, rect.y + 4)).toBe(true);
  });

  it('closes once, and says whether it had anything to close', () => {
    const { menu } = menuWith([{ action: PartyAction.Leave, label: 'Leave party', enabled: true }]);
    expect(menu.close()).toBe(true);
    expect(menu.close()).toBe(false);
    expect(menu.visible()).toBe(false);
    expect(menu.itemAt(100, 100)).toBeNull();
  });

  it('reports a hover change once per row, so an idle mouse cannot queue draws', () => {
    const { menu, changes } = menuWith([
      { action: PartyAction.Invite, label: 'Invite to party', enabled: true },
    ]);
    const rect = menu.rect();
    if (rect === null) throw new Error('unreachable');
    // Find the row by scanning rather than by re-deriving where it was drawn —
    // the same reason the pane's hit tests scan. See the header.
    let rowY = -1;
    for (let y = rect.y; y < rect.y + rect.h && rowY < 0; y += 1) {
      if (menu.itemAt(rect.x + 8, y) !== null) rowY = y;
    }
    expect(rowY).toBeGreaterThan(0);

    const before = changes();
    const first = menu.hoverAt(rect.x + 8, rowY);
    const again = menu.hoverAt(rect.x + 9, rowY);
    expect(first).toBe(true);
    expect(again).toBe(false);
    expect(changes()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// The erased plate
// ---------------------------------------------------------------------------

describe('the respawn prompt', () => {
  it('sits inside the band it was given, centred', () => {
    const rect = respawnPromptRect({ width: 640, top: 20, bottom: 400 });
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error('unreachable');
    expect(rect.x + rect.w).toBeLessThanOrEqual(640);
    expect(rect.x).toBe(Math.floor((640 - rect.w) / 2));
    expect(rect.y).toBeGreaterThanOrEqual(20);
    expect(rect.y + rect.h).toBeLessThanOrEqual(400);
  });

  it('is a BUTTON: the rect it is drawn in is the rect it is pressed in', () => {
    const rect = respawnPromptRect({ width: 640, top: 20, bottom: 400 });
    if (rect === null) throw new Error('unreachable');
    expect(respawnPromptHit(rect, rect.x + 4, rect.y + 4)).toBe(true);
    expect(respawnPromptHit(rect, rect.x - 1, rect.y + 4)).toBe(false);
    expect(respawnPromptHit(rect, rect.x + 4, rect.y + rect.h)).toBe(false);
    // Null is "there is no prompt", which must never read as a hit.
    expect(respawnPromptHit(null, 10, 10)).toBe(false);
  });

  it('gives up rather than drawing a plate taller than the map band', () => {
    expect(respawnPromptRect({ width: 640, top: 20, bottom: 60 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One paint, to prove the drawer is wired to the geometry it advertises
// ---------------------------------------------------------------------------

describe('drawing', () => {
  it('paints without touching anything outside its own rect', () => {
    // The context is a recorder, not a canvas: every drawing call is captured
    // and the clip rect is the only thing asserted. There is deliberately no
    // pixel test in this project — what matters here is that the pane clips to
    // itself, so a long nickname cannot bleed onto the map.
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const view = trio([{ fromId: 'actor_x', fromName: 'Ren', size: 2, expiresInMs: 45_000 }]);
    const layout = wideLayout(view);
    drawPartyPane({
      ctx: stub,
      // No art at all, which is also the honest state of half the manifest:
      // every fallback path in the pane runs here.
      sprites: { sprite: () => undefined },
      view,
      layout,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(clips[0]).toEqual({
      x: layout.rect.x,
      y: layout.rect.y,
      w: layout.rect.w,
      h: layout.rect.h,
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PORTRAITS MODE SAYS ALMOST NOTHING, AND THE CARD IS WHERE THE WORDS WENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED FIRST. Painting this pane at 640 wide through a context that answers
 * six pixels a character — the real width of the 10px monospace — draws exactly
 * three strings: `["D","S","M"]`. Three initials, for a party of three. No
 * name, no hp numbers, no `WAITING`, no `DOWN 3/5`, no header. Everything else
 * the compact row conveys it conveys as a SHADE: a three-pixel gold stripe for
 * the leader, orange for a body on the floor, grey for one erased, hatching for
 * offline.
 *
 * `ui/caselog.ts:467-478` is the rule that forbids exactly that, and 44 pixels
 * has no room to obey it. So the words go where they cost no width.
 */
describe('the party card carries what the pane cannot', () => {
  /** The narrow case: a 640 viewport with the log taking its usual slice. */
  function compactLayout(view: PartyPaneView): PartyPaneLayout {
    const layout = partyPaneLayout({ view, width: 640, top: 20, bottom: 300, rightReserved: 214 });
    if (layout === null) throw new Error('expected a pane on a 640px viewport');
    return layout;
  }

  function measuring(texts: string[]): CanvasRenderingContext2D {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'fillText')
            return (text: string) => {
              texts.push(text);
            };
          if (prop === 'canvas') return { width: 640, height: 320 };
          return () => {};
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  /** The centre of a member's row, which is where a pointer would be. */
  function pointAt(view: PartyPaneView, layout: PartyPaneLayout, id: string) {
    const rect = layout.rect;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const hit = partyPaneHitAt(view, layout, rect.x + Math.floor(rect.w / 2), y);
      if (hit !== null && hit.kind === 'member' && hit.id === id) {
        return { x: rect.x + Math.floor(rect.w / 2), y };
      }
    }
    throw new Error(`no row for ${id}`);
  }

  it('says how many of the party it could fit, when it could not fit them all', () => {
    /**
     * ══════════════════════════════════════════════════════════════════════
     * `paneGeometry` PLACES ROWS WHILE THEY FIT AND THEN STOPS — SILENTLY.
     * ══════════════════════════════════════════════════════════════════════
     * Which is right for the pixels and wrong for the FACT: a pane squeezed by
     * the Case Log, by a short band or by the player's own grip showed two faces
     * under a header reading "PARTY · 3", and the missing person was
     * indistinguishable from somebody who had left the party.
     */
    // NOBODY DOWN in this fixture: the title's FIRST job is "N DOWN", which is
    // more urgent than a count and rightly wins the strip. What is asserted here
    // is the other branch.
    const view = partyPaneView({
      state: state([
        member({ id: 'actor_a', name: 'Dalt', isSelf: true, isLeader: true }),
        member({ id: 'actor_b', name: 'Sam' }),
        member({ id: 'actor_c', name: 'Mo' }),
      ]),
      invites: [],
      roster: [
        rosterRow('actor_a', 'Dalt'),
        rosterRow('actor_b', 'Sam'),
        rosterRow('actor_c', 'Mo'),
      ],
      actors: new Map([
        ['actor_a', actor('actor_a', 'Dalt')],
        ['actor_b', actor('actor_b', 'Sam')],
        ['actor_c', actor('actor_c', 'Mo')],
      ]),
      effects: new Map<string, readonly EffectView[]>(),
      inCombat: false,
      resource: null,
      progress: null,
      money: null,
    });
    const short = partyPaneLayout({
      view,
      width: 1262,
      top: 20,
      bottom: 20 + PARTY_PANE_MIN_H + 2,
      rightReserved: 0,
    });
    expect(short, 'the fixture no longer squeezes the pane').not.toBeNull();
    if (short === null) return;
    expect(short.mode).toBe(PartyPaneMode.Rows);
    const cut: string[] = [];
    drawPartyPane({
      ctx: measuring(cut),
      sprites: { sprite: () => undefined },
      view,
      layout: short,
    });
    const title = cut.find((t) => t.startsWith('PARTY'));
    expect(title, 'no title was drawn').toBeDefined();
    expect(title, 'the title claimed a party it did not draw').toContain('/3');

    // ...AND A PANE WITH ROOM FOR EVERYBODY SAYS THE PLAIN COUNT, unchanged:
    // "PARTY · 1" is how somebody playing alone learns the pane is right rather
    // than broken, and a fraction there would be noise.
    const roomy = partyPaneLayout({ view, width: 1262, top: 20, bottom: 320, rightReserved: 0 });
    expect(roomy).not.toBeNull();
    if (roomy === null) return;
    const whole: string[] = [];
    drawPartyPane({
      ctx: measuring(whole),
      sprites: { sprite: () => undefined },
      view,
      layout: roomy,
    });
    expect(whole.find((t) => t.startsWith('PARTY'))).toBe('PARTY · 3');
  });

  it('paints only initials in Portraits mode, which is why the card exists', () => {
    // THE MEASUREMENT THIS FEATURE IS FOR. If a later pass gives the compact row
    // real words, this fails and the card can be reconsidered — which is the
    // point of pinning the premise rather than only the fix.
    const view = trio();
    const layout = compactLayout(view);
    expect(layout.mode).toBe(PartyPaneMode.Portraits);
    const texts: string[] = [];
    drawPartyPane({ ctx: measuring(texts), sprites: { sprite: () => undefined }, view, layout });
    expect(texts).toEqual(['D', 'S', 'M']);
  });

  it('names the member, with their level, under the pointer', () => {
    const view = trio();
    const layout = compactLayout(view);
    const point = pointAt(view, layout, 'actor_b');
    const card = partyPaneTipAt(view, layout, point.x, point.y);
    expect(card).not.toBeNull();
    expect(card?.title).toContain('Sam');
  });

  it('gives the hp as NUMBERS, which the bar cannot', () => {
    // A bar answers "roughly". The question in a fight is "can they take another
    // hit", and that is a number.
    const view = trio();
    const layout = compactLayout(view);
    const point = pointAt(view, layout, 'actor_b');
    const card = partyPaneTipAt(view, layout, point.x, point.y);
    expect(card?.lines.some((line) => line.includes('40/58'))).toBe(true);
  });

  it('says the state word, which is what the barrier is waiting on', () => {
    const view = trio();
    const layout = compactLayout(view);
    const point = pointAt(view, layout, 'actor_b');
    expect(partyPaneTipAt(view, layout, point.x, point.y)?.meta).toBe('DONE');
  });

  it('spells out the downed clock instead of leaving it a stripe', () => {
    // Mo is downed AND disconnected in this fixture. In Portraits mode the whole
    // of that is a three-pixel orange bar and some hatching.
    const view = trio();
    const layout = compactLayout(view);
    const point = pointAt(view, layout, 'actor_c');
    const card = partyPaneTipAt(view, layout, point.x, point.y);
    expect(card?.lines.some((line) => line.startsWith('DOWN'))).toBe(true);
    expect(card?.lines).toContain('Disconnected.');
  });

  it('drops the hp line for a body on the floor, as the row does', () => {
    // `0/58` beside a countdown is the thing the row painter already refuses to
    // draw; the card must not reintroduce it by being more thorough.
    const view = trio();
    const layout = compactLayout(view);
    const point = pointAt(view, layout, 'actor_c');
    const card = partyPaneTipAt(view, layout, point.x, point.y);
    expect(card?.lines.some((line) => line.startsWith('Life'))).toBe(false);
  });

  it('answers null off the rows', () => {
    const view = trio();
    const layout = compactLayout(view);
    expect(partyPaneTipAt(view, layout, -50, -50)).toBeNull();
  });

  it('works in Rows mode too, where it un-abbreviates the line', () => {
    const view = trio();
    const layout = wideLayout(view);
    expect(layout.mode).toBe(PartyPaneMode.Rows);
    const point = pointAt(view, layout, 'actor_a');
    const card = partyPaneTipAt(view, layout, point.x, point.y);
    expect(card).not.toBeNull();
    expect(card?.title).toContain('Dalt');
  });
});

describe('the death plate covers both stages', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A PLAYER WHO DIED SAW NOTHING FOR FIVE TURNS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The plate was gated on ERASED alone, so the five turns that decide whether
   * the run continues — the loudest moment in the game — had no surface at all.
   * The countdown lived in the party pane, which toggles off with `p` and sheds
   * its digits on a narrow window, and in the Case Log, which is a transcript
   * nobody reads while dying.
   */
  const view = (over: Partial<DeathView> = {}): DeathView => ({
    stage: DeathStage.Down,
    turnsLeft: 5,
    by: 'Index Husk',
    rescuers: false,
    ...over,
  });

  it('says DOWN while the clock is running and ERASED once it has stopped', () => {
    expect(deathHeadline(view())).toBe('YOU ARE DOWN');
    expect(deathHeadline(view({ stage: DeathStage.Erased }))).toBe('YOU ARE ERASED');
  });

  it('names what put you there', () => {
    // `DownedEvent.sourceId` was declared on the wire and filled by nothing.
    // "You are down" with no cause is the one sentence a player is guaranteed to
    // read carefully and guaranteed to learn nothing from.
    expect(deathCause(view())).toBe('Index Husk put you here');
  });

  it('loses the line rather than inventing a culprit', () => {
    // A body that bled out from an effect whose source is gone has nobody to
    // name, and the plate reads as the tight two-line surface it always was.
    expect(deathCause(view({ by: null }))).toBe('');
  });

  it('does NOT advertise the respawn key while you are merely down', () => {
    /**
     * THE ONE THAT WOULD BE CRUEL. `attemptRespawn` refuses in the Downed stage —
     * the countdown and the ally running at you ARE the mechanic — so naming the
     * key here would be an instruction that does not work, given to the one
     * player in the game who cannot do anything else.
     */
    expect(deathAction(view(), DEFAULT_KEYMAP)).not.toMatch(/refile/);
    expect(deathAction(view({ stage: DeathStage.Erased }), DEFAULT_KEYMAP)).toMatch(/refile/);
  });

  it('has a stage for the death a solo player actually dies', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STAGE THE OTHER TWO COULD NOT REACH.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Both stages above are read off `PartyMember.downed`. A wipe deletes that
     * record — `resetFloorParty` -> `standUp` -> `state.byActor.delete` — INSIDE
     * the pump that raised the death, so the `party` frame at the end of it
     * already says the body is up. The plate had nothing to draw from on any
     * frame.
     *
     * And one player alone IS the whole party, so every solo death is a wipe:
     * the unreachable stage was the one that covers playing by yourself.
     * Measured over a real socket in test/server/killer-named.test.ts, which
     * saw `downed, erased/wipe` arrive for a lone Watchman's death.
     */
    const wiped = view({ stage: DeathStage.Wiped, turnsLeft: 0 });
    // The Record lane says "erased" for a wipe in the same breath
    // ("X is erased — nobody is left standing. The floor resets."), and two
    // vocabularies for one event would read as two different deaths.
    expect(deathHeadline(wiped)).toBe('YOU ARE ERASED');
    // The culprit still survives the reset — it is held on the client from the
    // `downed` event, which arrives in the same batch as the wipe.
    expect(deathCause(wiped)).toBe('Index Husk put you here');
  });

  it('tells a wiped player it is already over, not that a clock is running', () => {
    /**
     * PAST TENSE, AND NOT A COUNTDOWN. By the time this plate can be drawn the
     * floor is rebuilt and the body is standing on it at full hp. A countdown
     * here would be the one sentence on this surface that is actively false, and
     * "refile yourself" would be an instruction to do a thing the server has
     * already done without asking.
     */
    const said = deathAction(view({ stage: DeathStage.Wiped, turnsLeft: 0 }), DEFAULT_KEYMAP);
    expect(said).toMatch(/floor has reset/);
    expect(said, 'a wipe has no clock left to run').not.toMatch(/turn/);
    expect(said, 'the body is already up — there is nothing to refile').not.toMatch(/refile/);
    // It still names a key. The plate has to go away, and one that dismisses
    // itself on a timer is one a player who looked away never reads.
    expect(said).toMatch(/press/);
  });

  it('counts the turns, and says whether anyone could reach you', () => {
    /**
     * THE SAME DISTINCTION THE CASE LOG ALREADY MAKES: "turns to reach you" is
     * addressed to somebody, and read by a player alone it is an instruction
     * about help that is not coming.
     */
    expect(deathAction(view({ turnsLeft: 4, rescuers: true }), DEFAULT_KEYMAP)).toBe(
      '4 turns for an ally to reach you',
    );
    expect(deathAction(view({ turnsLeft: 4, rescuers: false }), DEFAULT_KEYMAP)).toBe(
      '4 turns, and nobody is coming',
    );
  });

  it('says "one turn" rather than "1 turns" on the last one', () => {
    // The turn a player is most likely to be reading it on.
    expect(deathAction(view({ turnsLeft: 1, rescuers: true }), DEFAULT_KEYMAP)).toBe(
      'one turn for an ally to reach you',
    );
  });

  it('never counts below zero', () => {
    expect(deathAction(view({ turnsLeft: -2, rescuers: false }), DEFAULT_KEYMAP)).toBe(
      '0 turns, and nobody is coming',
    );
  });
});

describe('a badge says what it is doing to you', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SENTENCE WAS WRITTEN AND NO SCREEN COULD REACH IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `EffectDef.description` is authored on every effect in the game, and it is
   * specific and good — *"Dragging. Monsters act less often; detectives lose a
   * point of movement."* `EffectView` did not carry it, so a card could name a
   * status and never say what it did. A player was Stunned and nothing told
   * them their cooldowns had stopped ticking, which is the one they will sit
   * and wait out believing their abilities are coming back.
   */
  const SLOWED_DESC = 'Dragging. Monsters act less often; detectives lose a point of movement.';

  /** The pointer over a named member. Local, because the suite's own copy is
   *  scoped inside another block and reaching for it would be a second reason
   *  for these tests to break. */
  function pointOver(view: PartyPaneView, layout: PartyPaneLayout, id: string) {
    const rect = layout.rect;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const hit = partyPaneHitAt(view, layout, rect.x + Math.floor(rect.w / 2), y);
      if (hit !== null && hit.kind === 'member' && hit.id === id) {
        return { x: rect.x + Math.floor(rect.w / 2), y };
      }
    }
    throw new Error(`no row for ${id}`);
  }

  function cardFor(effects: readonly EffectView[]) {
    const base = trio();
    const view: PartyPaneView = {
      ...base,
      rows: base.rows.map((row) => (row.member.id === 'actor_b' ? { ...row, effects } : row)),
    };
    const layout = wideLayout(view);
    const point = pointOver(view, layout, 'actor_b');
    return partyPaneTipAt(view, layout, point.x, point.y);
  }

  const SLOWED: EffectView = {
    id: 'slow',
    name: 'Slowed',
    icon: 'icon_status_slow',
    desc: SLOWED_DESC,
    turns: 3,
    harmful: true,
  };

  it('prints the sentence under the name', () => {
    const card = cardFor([SLOWED]);
    expect(card?.lines.some((l) => l.includes('Slowed'))).toBe(true);
    expect(
      card?.lines.some((l) => l.includes('lose a point of movement')),
      'the card named the status and never said what it does',
    ).toBe(true);
  });

  it('keeps the name and the turns on their own line', () => {
    // ON SEPARATE LINES rather than appended: the card wraps nothing, so a name
    // plus a sentence on one line would ellipsise away exactly the half that is
    // new.
    const lines = cardFor([SLOWED])?.lines ?? [];
    const named = lines.findIndex((l) => l.includes('Slowed'));
    expect(named).toBeGreaterThanOrEqual(0);
    expect(lines[named]).toContain('3t');
    expect(lines[named]).not.toContain('Dragging');
    expect(lines[named + 1]).toContain('Dragging');
  });

  it('says only the name for an effect authored without a sentence', () => {
    // `desc` is optional, so an effect with none — and every client that has
    // never heard of the field — behaves exactly as it always did.
    const bare: EffectView = { ...SLOWED };
    delete (bare as { desc?: string }).desc;
    const lines = cardFor([bare])?.lines ?? [];
    const named = lines.findIndex((l) => l.includes('Slowed'));
    expect(named).toBeGreaterThanOrEqual(0);
    expect(lines[named + 1] ?? '').not.toContain('Dragging');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VIEWER'S POOLS SIT UNDER THE VIEWER'S NAME — Minimalist.lua:376-377.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported: "the resources, AP, MP, reagents is easy to miss at the bottom left
 * hand of the screen. we need to include all of that info in the hp hud/'party'
 * at the top left."
 *
 * Upstream puts `player` at `{x=0,y=0}` and `resources` at `{x=0,y=111}` — one
 * left column, pools under the portrait. These pin the three properties that
 * makes true here: the strip is DRAWN, it is drawn on the SELF row, and it is
 * drawn on NOBODY ELSE'S — the last one is the protocol's rule, not a taste.
 */
describe('the viewer’s own pools on the pane', () => {
  const pools = {
    kind: ResourceKind.Reagents,
    current: 3,
    max: 8,
    discrete: true,
    ap: 4,
    maxAp: 6,
    mp: 2,
    maxMp: 3,
  } as const;

  /** Every `drawImage`/`fillRect` y, so a strip can be told from a row. */
  function paintedRows(view: PartyPaneView): { height: number; drew: number } {
    let drew = 0;
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'canvas') return undefined;
          // COUNTS EVERY DRAWING CALL. With no art at all the pips fall back
          // to hollow outlines, so counting `drawImage` alone would count zero
          // in both arms and the test would pass on nothing.
          return () => {
            drew += 1;
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const layout = wideLayout(view);
    drawPartyPane({
      ctx: stub,
      sprites: { sprite: () => undefined },
      view,
      layout,
    });
    return { height: partyPaneHeight(view, PartyPaneMode.Rows), drew };
  }

  it('gives the self row the height its pools need, and nobody else’s row', () => {
    const without = trio();
    const withPools = { ...trio(), resource: pools };
    const grew =
      partyPaneHeight(withPools, PartyPaneMode.Rows) - partyPaneHeight(without, PartyPaneMode.Rows);
    // EXACTLY ONE STRIP. Three members in the fixture and only one of them is
    // the viewer, so a per-row implementation would show up here as 3x.
    // THE STACKED HEIGHT, because the pane draws the two-line shape -- see
    // `RESOURCE_STRIP_H`. Naming the flat one here would pass while the pane
    // reserved a line less than it draws, which is the clipping this fixed.
    expect(grew, 'the pane grew by something other than one strip').toBe(resourceStripH(true));
  });

  it('draws pips once the frame has arrived and none before it', () => {
    const before = paintedRows(trio());
    const after = paintedRows({ ...trio(), resource: pools });
    expect(after.drew, 'no pips were drawn for the viewer').toBeGreaterThan(before.drew);
  });

  /**
   * AND THE HIT TEST FOLLOWS THE PAINTER. `paneGeometry` is the one place row
   * rects are computed, so a taller self row must move the rows under it — if
   * these two ever disagree a click lands on the wrong member, which is the
   * failure `partyPaneLayout`'s header warns about.
   */
  it('moves the rows below the self row rather than overlapping them', () => {
    const view = { ...trio(), resource: pools };
    const layout = wideLayout(view);
    const ids = view.rows.map((row) => row.member.id);
    const hits = new Set<string>();
    for (let y = layout.rect.y; y < layout.rect.y + layout.rect.h; y += 1) {
      const hit = partyPaneHitAt(view, layout, layout.rect.x + 30, y);
      if (hit?.kind === 'member') hits.add(hit.id);
    }
    for (const id of ids) {
      expect(hits, `${id} became unreachable`).toContain(id);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LEVEL, THE XP TRACK AND THE PURSE, WHICH USED TO BE ON A BOTTOM STRIP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That strip was deleted — every number on it was already here or belonged
 * here, and it was standing in the corner the Case Log occupies upstream
 * (`Minimalist.lua:381`). These three had nowhere else permanent to be, so they
 * moved onto the viewer's own row.
 *
 * THE THING THAT BREAKS SILENTLY IS THE RESERVATION. `rowHeightFor` decides a
 * row's height and two other functions read it; draw a band the height was not
 * reserved for and it paints over the row beneath, on a pane that is already
 * clamped for height on a short window.
 */
/**
 * A one-member view carrying the viewer's own row, with the two viewer-private
 * fields under test supplied by the caller.
 */
function viewWith(over: {
  readonly progress: PartyPaneView['progress'];
  readonly money: PartyPaneView['money'];
}): PartyPaneView {
  return partyPaneView({
    state: state([member({ id: 'actor_a', name: 'Dalt', isSelf: true })]),
    invites: [],
    roster: [],
    actors: new Map(),
    effects: new Map(),
    inCombat: false,
    resource: null,
    progress: over.progress,
    money: over.money,
  });
}

describe('the viewer’s own level and purse on the pane', () => {
  const progress = {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 3,
    xp: 40,
    xpToNext: 100,
    unspent: 0,
    unspentGenerics: 0,
  } as const;

  it('makes the self row taller only once a frame has landed', () => {
    const bare = viewWith({ progress: null, money: null });
    const withProgress = viewWith({ progress, money: null });
    expect(
      partyPaneHeight(withProgress, PartyPaneMode.Rows),
      'the band was drawn without being reserved',
    ).toBeGreaterThan(partyPaneHeight(bare, PartyPaneMode.Rows));
  });

  it('reserves for the purse alone, with no xp frame at all', () => {
    /**
     * THE TWO ARRIVE FROM DIFFERENT FRAMES and either can be the one that is
     * missing — `progress` lands with the first xp and `inventory` with the
     * first bag. A reservation gated on `progress` alone would draw the purse
     * into a band it never asked for.
     */
    const bare = viewWith({ progress: null, money: null });
    const withMoney = viewWith({ progress: null, money: 15 });
    expect(partyPaneHeight(withMoney, PartyPaneMode.Rows)).toBeGreaterThan(
      partyPaneHeight(bare, PartyPaneMode.Rows),
    );
  });

  it('survives a view that predates the two fields entirely', () => {
    /**
     * `undefined` IS NOT `null`, and this is not hypothetical: every fixture in
     * this file predated these fields, and `self.progress !== null` passed for
     * `undefined` and walked into `xpBarGeometry(undefined)` and a TypeError on
     * `xpToNext`. Both the reservation and the draw normalise with `?? null`;
     * this is the test that caught it.
     */
    const legacy = { ...viewWith({ progress: null, money: null }) } as Record<string, unknown>;
    delete legacy['progress'];
    delete legacy['money'];
    const view = legacy as unknown as PartyPaneView;

    // THE HEIGHT PATH IS NOT WHERE IT THREW. `partyPaneHeight` only reserves;
    // the TypeError was inside `drawRow`, and a test that exercised the
    // reservation alone passed with the guard removed. This drives the real
    // painter, which is the half that touched `progress.xpToNext`.
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'canvas') return undefined;
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const layout = partyPaneLayout({
      view,
      width: 900,
      top: 0,
      bottom: 500,
      rightReserved: 0,
    });
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(() =>
      drawPartyPane({ ctx: stub, sprites: { sprite: () => undefined }, view, layout }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// THE PANE IS WIDE ENOUGH FOR THE POOL IT DRAWS
// ---------------------------------------------------------------------------

describe('the pane is wide enough for every class to read its own pool', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * REPORTED AS THE REDACTOR'S INK BEING CUT OFF. THREE CLASSES OF FOUR WERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * *"the Party UI needs to be slightly widened as it can cut resourcces off.
   * example: the redactor character has its Ink initially cut off on the party
   * display until you manually drag to widenen it a bit to accomodate."*
   *
   * ═══ THE PANE CLIPS, WHICH IS WHY THIS SHIPPED ═══
   * `drawPartyPane` clips to its own rect, so an over-long line is not drawn
   * across the map where somebody would see it and call it a bug. It is cut at
   * the frame and looks like a design.
   *
   * ═══ EVERY REAL CLASS, NOT A FIXTURE STRING ═══
   * `CLASSES` is the server's own table and `RESOURCE_RULES` its own maxima, so
   * this measures what a player actually sees. A fixture here would be the
   * `fixture-bands-are-not-panel-bands` failure again: the pane passed every
   * test it had while cutting the Watchman's line by 47 pixels.
   */
  const poolFor = (kind: (typeof CLASSES)[number]['resource']) => {
    const rule = RESOURCE_RULES[kind];
    // FULL, because that is where every class starts and it is the widest the
    // figure ever prints — `Resolve 100/100` is longer than `Resolve 7/100`.
    return { kind, current: rule.max, max: rule.max, discrete: rule.discrete };
  };

  /** What the painter actually hands `drawResource` for a default-width pane. */
  const room = poolStripW(paneRowW(PARTY_PANE_W));

  it('fits the line every authored class draws, at full pool', () => {
    for (const def of CLASSES) {
      const pool = poolFor(def.resource);
      expect(
        poolLineW(pool),
        `${def.name}: "${poolText(pool)}" is cut off on the party pane`,
      ).toBeLessThanOrEqual(room);
    }
  });

  /**
   * THE REPORT NAMED THE REDACTOR AND THE WATCHMAN WAS WORSE — which is the
   * reason this walks the table instead of fixing the class that was reported.
   * `hardcoded-word-for-a-value`'s rule, applied to a width: the moment you
   * find one, grep the twins.
   */
  it('is sized by the widest class, which is not the one that was reported', () => {
    const widest = [...CLASSES].sort(
      (a, b) => poolLineW(poolFor(b.resource)) - poolLineW(poolFor(a.resource)),
    )[0];
    expect(widest).toBeDefined();
    if (widest === undefined) return;
    expect(poolText(poolFor(widest.resource))).toBe('Resolve 100/100');
    const ink = CLASSES.find((def) => def.resource === ResourceKind.Ink);
    expect(ink, 'the Redactor is still in the roster').toBeDefined();
    if (ink === undefined) return;
    expect(poolLineW(poolFor(ink.resource))).toBeLessThan(poolLineW(poolFor(widest.resource)));
  });

  /**
   * THE WITNESS. At the width that shipped, the reported class and two others
   * were cut — so this test would have caught it, which is the only evidence
   * that it is testing the rule rather than the current numbers.
   */
  it('would have failed at the width that shipped', () => {
    const was = poolStripW(paneRowW(208));
    const cut = CLASSES.filter((def) => poolLineW(poolFor(def.resource)) > was);
    expect(cut.map((def) => def.resource).sort()).toEqual(
      [ResourceKind.Focus, ResourceKind.Ink, ResourceKind.Resolve].sort(),
    );
  });

  /**
   * THE WIDTH IS THE DERIVATION AND NOTHING ELSE — no slack, no magic number
   * added on top. Exactly `WIDEST_POOL_LINE_W` of room, which is what makes the
   * constant move by itself when a fifth resource is named.
   */
  it('is exactly the derivation, with nothing added by hand', () => {
    expect(room).toBe(WIDEST_POOL_LINE_W);
  });

  /**
   * AND THE CLEAR-MAP HEURISTIC IS UNMOVED AT THE FLOOR. The pane got 53 pixels
   * wider, and the one thing that could have cost is the form it picks on a
   * small window — `MAP_MIN_CLEAR_PX` is 320 against a 640-wide viewport.
   */
  it('still picks Rows at the narrowest viewport this client renders', () => {
    const layout = partyPaneLayout({
      view: trio(),
      width: 640,
      top: 0,
      bottom: 320,
      rightReserved: 0,
    });
    expect(layout?.mode).toBe(PartyPaneMode.Rows);
    expect(layout?.rect.w).toBe(PARTY_PANE_W);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE PAINTER ITSELF DRAWS NOTHING PAST THE ROW, FOR ANY CLASS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The test above is arithmetic about the rule. This drives `drawPartyPane` —
   * the real painter, the real geometry, the real `drawResource` — and catches
   * the string as it is written, so a change to WHERE the strip starts fails
   * here even if `poolLineW` still agrees with itself.
   *
   * `measureText` IS THE SAME SIX-PIXEL ADVANCE the box sizes are derived from
   * (ui/resource.ts's `CHAR_W`), which is a deliberate over-estimate of Consolas
   * at 10px — so a line that fits here fits on a screen.
   */
  it('draws every class’s pool line inside the row, through the real painter', () => {
    for (const def of CLASSES) {
      const pool = poolFor(def.resource);
      const wanted = poolText(pool);
      const drawn: { text: string; x: number }[] = [];
      const stub = new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop === 'measureText') {
              return (text: string) => ({ width: text.length * 6 });
            }
            if (prop === 'canvas') return undefined;
            if (prop === 'fillText') {
              return (text: string, x: number) => {
                drawn.push({ text, x });
              };
            }
            return () => undefined;
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;

      const view = { ...trio(), resource: { ...pool, ap: 6, maxAp: 6, mp: 3, maxMp: 3 } };
      const layout = partyPaneLayout({
        view,
        width: 900,
        top: 0,
        bottom: 500,
        rightReserved: 0,
      });
      expect(layout, `${def.name}: no pane`).not.toBeNull();
      if (layout === null) continue;
      drawPartyPane({ ctx: stub, sprites: { sprite: () => undefined }, view, layout });

      const line = drawn.find((call) => call.text === wanted);
      expect(line, `${def.name}: the pane never drew "${wanted}"`).toBeDefined();
      if (line === undefined) continue;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND `poolLineW` IS THE PAINTER'S OWN CURSOR, TERM FOR TERM.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * A MUTANT SURVIVED THE FIRST DRAFT AND THIS IS WHY IT DOES NOT NOW.
       * Dropping the `PIP_GAP * 2` before the label made `poolLineW` four
       * pixels short — and every other test here passed, because the pane
       * width is DERIVED from `poolLineW`, so both sides of every comparison
       * moved together. A derivation can only be checked against something it
       * does not define, and the only such thing is the pixel the painter puts
       * the string at.
       *
       * The slack left at the row's right edge must be exactly the slack the
       * derivation predicts. Four pixels of drift shows up here as four.
       */
      const room = poolStripW(paneRowW(layout.rect.w));
      const right = layout.rect.x + layout.rect.w - (layout.rect.w - paneRowW(layout.rect.w)) / 2;
      expect(
        right - (line.x + wanted.length * 6),
        `${def.name}: poolLineW does not describe where the painter drew "${wanted}"`,
      ).toBe(room - poolLineW(pool));
      // THE ROW'S RIGHT EDGE, which is where the content has to stop — the clip
      // is further out at the pane's own frame, and a line that reaches it is
      // already touching the border.
      const rowRight =
        layout.rect.x + layout.rect.w - (layout.rect.w - paneRowW(layout.rect.w)) / 2;
      expect(
        line.x + wanted.length * 6,
        `${def.name}: "${wanted}" runs past the row`,
      ).toBeLessThanOrEqual(rowRight);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PANE CARRIES THE TURN NOW, AND IT IS THE ONLY SURFACE THAT DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A strip of portrait cards across the top of the screen used to answer "who
 * still owes a decision". It is deleted, on the author's ruling of 2026-09-18:
 * *"lets just go no cards at all, no turn order indicator. it will also free up
 * more space. we can use the 'Party' hud UI to indicate that its the players
 * turn, even when doing multiplayer."* test/client/turnband.test.ts measures the
 * space; this measures the indication.
 *
 * EVERY ASSERTION BELOW IS A PAINT ASSERTION, because that is the only
 * instrument that can see this. The pane's own history is the argument: the
 * hover card exists because painting it at 640 wide showed it drawing three
 * initials and nothing else, which no structural test in the tree could have
 * told anybody.
 */
describe('the party row is what says whose turn it is', () => {
  type Painted = {
    readonly texts: readonly string[];
    /** `fillText` calls as {text, ink}, so a word and its colour stay together. */
    readonly inked: readonly { readonly text: string; readonly ink: string }[];
    /** `fillRect` calls as {x, y, w, h, ink}. The rail is found in here. */
    readonly rects: readonly {
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly ink: string;
    }[];
    /** Asset ids handed to `drawImage`, in order. The chips are found in here. */
    readonly blits: readonly string[];
  };

  /**
   * A recorder that keeps the CONTEXT STATE a call was made under.
   *
   * Six pixels a character, the real advance of the 10px monospace this pane
   * draws with — the same figure every other measuring stub in this file uses,
   * so a word that fits here fits on the screen.
   */
  function painted(): { readonly ctx: CanvasRenderingContext2D; readonly out: Painted } {
    const texts: string[] = [];
    const inked: { text: string; ink: string }[] = [];
    const rects: { x: number; y: number; w: number; h: number; ink: string }[] = [];
    const blits: string[] = [];
    let fill = '';
    const ctx = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'fillStyle') return fill;
          if (prop === 'measureText') return (t: string) => ({ width: t.length * 6 });
          if (prop === 'fillText')
            return (text: string) => {
              texts.push(text);
              inked.push({ text, ink: fill });
            };
          if (prop === 'fillRect')
            return (x: number, y: number, w: number, h: number) => {
              rects.push({ x, y, w, h, ink: fill });
            };
          if (prop === 'drawImage')
            return (image: { readonly id?: string }) => {
              if (image.id !== undefined) blits.push(image.id);
            };
          if (prop === 'canvas') return { width: 640, height: 320 };
          return () => {};
        },
        set: (_target, prop: string, value: unknown) => {
          if (prop === 'fillStyle') fill = String(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, out: { texts, inked, rects, blits } };
  }

  /**
   * Every `ui_icon_turn_*` at its authored 24x24, and NOTHING else.
   *
   * The pane must draw the chips from real art and must keep working without
   * any: `blitReduced` refuses rather than smudging, so a face with no PNG falls
   * through to initials in the same pass. Returning only the chips exercises
   * both halves at once.
   */
  const CHIPS: SpriteSource = {
    sprite: (id: string) =>
      id.startsWith('ui_icon_turn_')
        ? { id, w: 24, h: 24, image: { id } as unknown as HTMLImageElement }
        : undefined,
  };

  /** A party of `states.length`, the first of whom is the viewer. */
  function party(states: readonly TurnActorState[], over: Partial<PartyStateMember> = {}) {
    const names = ['Dalt', 'Sam', 'Mo', 'Ren', 'Wen', 'Isa'];
    const members = states.map((turnState, i) =>
      member({
        id: `actor_${String(i)}`,
        name: names[i] ?? `P${String(i)}`,
        state: turnState,
        isSelf: i === 0,
        isLeader: i === 0,
        ...(i === 0 ? over : {}),
      }),
    );
    return partyPaneView({
      state: state(members),
      invites: [],
      roster: members.map((m) => rosterRow(m.id, m.name)),
      actors: new Map(members.map((m) => [m.id, actor(m.id, m.name)])),
      effects: new Map<string, readonly EffectView[]>(),
      inCombat: true,
      resource: null,
      progress: null,
      money: null,
    });
  }

  /**
   * THE FLOOR VIEWPORT, WITH NOTHING RESERVED — the pane's own note measured it:
   * at 640 wide the pane leaves 373 clear pixels against `MAP_MIN_CLEAR_PX` 320,
   * so this is Rows, which is the form a player at the floor actually gets. The
   * narrow form is reached by opening the log, and is covered further down.
   */
  function floorLayout(view: PartyPaneView): PartyPaneLayout {
    const layout = partyPaneLayout({ view, width: 640, top: 14, bottom: 217, rightReserved: 0 });
    if (layout === null) throw new Error('expected a pane at the 640 floor');
    return layout;
  }

  /**
   * The same 640-wide row form in a box tall enough for a party of six — the
   * measured Discord Activity box's band (main.ts stacks `panelBand` at 17 and
   * stops it above the hotbar and the two prose lines). Width is still the
   * floor's, because width is what decides whether a name survives the row.
   */
  function roomyLayout(view: PartyPaneView): PartyPaneLayout {
    const layout = partyPaneLayout({ view, width: 640, top: 17, bottom: 325, rightReserved: 0 });
    if (layout === null) throw new Error('expected a pane at 640 wide');
    return layout;
  }

  function paint(view: PartyPaneView, layout: PartyPaneLayout = floorLayout(view)): Painted {
    const { ctx, out } = painted();
    drawPartyPane({ ctx, sprites: CHIPS, view, layout });
    return out;
  }

  // -------------------------------------------------------------------------

  it('reads the state the SERVER decided, and nothing else', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BUG THAT KILLED THE PREDECESSOR, AS AN ASSERTION.
     * ═══════════════════════════════════════════════════════════════════════
     * The old `chipFor` worked the barrier's precedence out in the BROWSER from
     * three id arrays — whose turn, who has committed, who is standing by — and
     * `PartyStateMember` carries none of them. Every fact on this row has to
     * come off `state`, so the same member, with the same id, the same name and
     * the same roster row, must paint a different word when and only when the
     * server says a different thing.
     */
    // THE VIEWER IS `waiting` IN EVERY CASE, so their own row says YOUR MOVE and
    // the only word from the ally vocabulary on screen is the ALLY's. A `find`
    // over a party whose viewer shared that vocabulary would answer with row one
    // every time and assert nothing about row two.
    const words = (s: TurnActorState): string =>
      paint(party([TurnActorState.Waiting, s])).texts.find((t) =>
        ['WAITING', 'BELL', 'DONE', 'STANDBY', 'ACTING'].includes(t),
      ) ?? 'nothing';

    expect(words(TurnActorState.Waiting)).toBe('WAITING');
    expect(words(TurnActorState.Bell)).toBe('BELL');
    expect(words(TurnActorState.Committed)).toBe('DONE');
    expect(words(TurnActorState.StandingBy)).toBe('STANDBY');

    // ═══ AND THE SOURCE HAS NO SECOND ROUTE TO THE ANSWER ═══
    // A word that happened to be right for the four cases above and was derived
    // from something else would pass everything up to here. `whoseTurn`,
    // `committed` and `standingBy` are the three arrays the deleted derivation
    // read; none of them is on this frame, and none of them may be named here.
    const source = readFileSync('src/client/ui/partypanel.ts', 'utf8');
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
      })
      .join('\n');
    // `committed` is matched with its dot, because `ui_icon_turn_committed` is
    // an ASSET KEY the pane legitimately names — a bare substring would go red
    // for the chip and say nothing about the derivation.
    for (const array of ['whoseTurn', 'standingBy', '.committed']) {
      expect(code, `the pane derives the barrier from ${array}`).not.toContain(array);
    }
    expect(code, 'the state word stopped reading the server’s answer').toContain(
      'switch (row.member.state)',
    );
  });

  it('renders every state distinctly, and without leaning on colour', () => {
    /**
     * Roughly one man in twelve cannot separate the red from the green and the
     * Discord overlay is not colour-managed. So the five states must differ in
     * their WORDS — take the ink away and the pane still reads.
     */
    const ally = (s: TurnActorState): string | undefined =>
      paint(party([TurnActorState.Waiting, s])).texts.find((t) =>
        ['WAITING', 'BELL', 'DONE', 'STANDBY'].includes(t),
      );
    const seen = [
      TurnActorState.Waiting,
      TurnActorState.Bell,
      TurnActorState.Committed,
      TurnActorState.StandingBy,
    ].map(ally);
    expect(new Set(seen).size, 'two states paint the same word').toBe(seen.length);
    expect(seen.includes(undefined)).toBe(false);

    // And the chip is a second, non-textual channel: one authored silhouette per
    // state, on the token's top-right corner in both forms of the pane.
    const chips = (s: TurnActorState) =>
      paint(party([TurnActorState.Waiting, s])).blits.filter((id) =>
        id.startsWith('ui_icon_turn_'),
      );
    expect(chips(TurnActorState.Waiting)).toContain('ui_icon_turn_waiting');
    expect(chips(TurnActorState.Bell)).toContain('ui_icon_turn_bell');
    expect(chips(TurnActorState.StandingBy)).toContain('ui_icon_turn_standing_by');
    expect(chips(TurnActorState.Committed)).toContain('ui_icon_turn_committed');
  });

  it('never lets a body on the floor read as somebody who has taken their turn', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS IS THE BUG THE WHOLE `TurnActor.state` SEAM EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     * `surveyQuorum` skips a body that is not standing before it decides
     * anything, so a Downed detective is in NEITHER `whoseTurn` NOR
     * `standingBy` — the one case three id arrays cannot express. The browser's
     * old lookup fell through to "committed" and told the party that the person
     * bleeding out on the floor had taken their turn.
     *
     * They arrive as `standing_by` WITH a survival table, and the countdown is
     * what the row says. Never DONE, and never STANDBY either: "excluded from
     * the quorum" and "bleeding out" must not read the same.
     */
    const members = [
      member({ id: 'actor_0', name: 'Dalt', isSelf: true, isLeader: true }),
      member({ id: 'actor_1', name: 'Sam', state: TurnActorState.StandingBy }),
    ];
    const view = partyPaneView({
      state: state(members),
      invites: [],
      roster: [
        rosterRow('actor_0', 'Dalt'),
        rosterRow('actor_1', 'Sam', {
          downed: {
            status: DownedStatus.Downed,
            marker: 'ui_marker_downed',
            turnsLeft: 3,
            total: 5,
          },
        }),
      ],
      actors: new Map(members.map((m) => [m.id, actor(m.id, m.name)])),
      effects: new Map<string, readonly EffectView[]>(),
      inCombat: true,
      resource: null,
      progress: null,
      money: null,
    });

    const out = paint(view);
    expect(out.texts).toContain('DOWN 3/5');
    expect(out.texts, 'the fallen ally reads as having committed').not.toContain('DONE');
    expect(out.texts, 'the fallen ally reads as merely out of the quorum').not.toContain('STANDBY');
    // The hover card is the only surface with words in the narrow form, and it
    // must agree rather than falling back to the state word.
    const rect = view.rows.length > 0 ? floorLayout(view).rect : null;
    expect(rect).not.toBeNull();
    // The countdown, never the barrier's word.
    expect(
      survivalWord({ status: DownedStatus.Downed, marker: 'm', turnsLeft: 3, total: 5 }, false),
    ).toBe('DOWN 3/5');
  });

  it('is unmistakable on your own row while the game is waiting on you', () => {
    /**
     * The single most important fact on this screen. "WAITING" beside your own
     * name is the passive voice for it and reads as *you are waiting*, which is
     * the opposite of what is true.
     */
    const out = paint(party([TurnActorState.Waiting, TurnActorState.Committed]));
    expect(out.texts).toContain('YOUR MOVE');
    expect(out.inked.find((i) => i.text === 'YOUR MOVE')?.ink).toBe(PALETTE.GOLD);
    // ...and a gold rail down the left of that row, which is the mark you catch
    // while looking at the map rather than at the pane.
    expect(out.rects.some((r) => r.w === 3 && r.ink === PALETTE.GOLD)).toBe(true);

    // The ally who still owes gets the rail too — the pane is a CHECKLIST, and
    // "who are we waiting on" is answered by the rails without reading a word.
    const two = paint(party([TurnActorState.Committed, TurnActorState.Waiting]));
    expect(two.rects.some((r) => r.w === 3 && r.ink === PALETTE.VIOLET_HI)).toBe(true);
    // Nobody who has finished wears one.
    const none = paint(party([TurnActorState.Committed, TurnActorState.Committed]));
    expect(none.rects.some((r) => r.w === 3 && r.ink === PALETTE.VIOLET_HI)).toBe(false);
    expect(none.rects.some((r) => r.w === 3 && r.ink === PALETTE.GOLD)).toBe(false);
    expect(none.texts).toContain('DONE');
  });

  it('says YOUR MOVE to a party of one, which is who most needs telling', () => {
    // A solo player is a party of one (engine/party.ts) and still has to know
    // the game is waiting on them. There is nobody else's row to compare with.
    const out = paint(party([TurnActorState.Waiting]));
    expect(out.texts).toContain('YOUR MOVE');
    expect(out.blits).toContain('ui_icon_turn_waiting');
  });

  it('keeps the rows in the server’s order whatever the barrier says', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NO IMPLIED ORDERING, EVER. DECISIONS.md D1.
     * ═══════════════════════════════════════════════════════════════════════
     * The game is phase-locked: a player action always costs one full turn, so
     * the WHOLE party decides in the same window and everybody reading `waiting`
     * can act RIGHT NOW. Sorting rows by state would invent a queue that does
     * not exist and make three people sit waiting for "their go" — and KICK is
     * on this pane, so a row that moves between two frames is a row somebody
     * misclicks.
     */
    const shuffled = party([
      TurnActorState.Committed,
      TurnActorState.Waiting,
      TurnActorState.StandingBy,
      TurnActorState.Waiting,
      TurnActorState.Committed,
      TurnActorState.Bell,
    ]);
    expect(shuffled.rows.map((r) => r.member.name)).toEqual([
      'Dalt',
      'Sam',
      'Mo',
      'Ren',
      'Wen',
      'Isa',
    ]);
    // And the PAINT follows the rows: names come out top to bottom in the same
    // order, whatever each of them owes. A box tall enough for all six, so a
    // truncated pane cannot make a sorted one look unsorted.
    const out = paint(shuffled, roomyLayout(shuffled));
    const names = out.texts.filter((t) => /^>?(Dalt|Sam|Mo|Ren|Wen|Isa)$/.test(t));
    expect(names.map((n) => n.replace('>', ''))).toEqual([
      'Dalt',
      'Sam',
      'Mo',
      'Ren',
      'Wen',
      'Isa',
    ]);
  });

  it('is legible for six at the 640 floor: every row keeps its name AND its word', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PARTY CAP IS SIX AND THE HUD FLOOR IS 640 WIDE. BOTH AT ONCE.
     * ═══════════════════════════════════════════════════════════════════════
     * `fitText` truncates to what is left, and the state word is drawn FIRST and
     * takes its width off the name's. Six rows of `WAITING` beside six names
     * that came out as `…` would pass every other assertion in this file, so
     * this asserts the WHOLE of each name and the word beside it.
     *
     * ═══ WIDTH IS THE FLOOR'S; HEIGHT IS THE WINDOW'S, AND IT IS MEASURED ═══
     * At 640 wide with nothing reserved the pane takes the Rows form — its own
     * width note measured 373 clear pixels against `MAP_MIN_CLEAR_PX` 320. The
     * HEIGHT is a different question and `paneGeometry` places rows only while
     * they fit, so the band has to be one that holds six: at the 640x320 HUD
     * floor the dock band is 200 pixels and six rows want 244, which is the
     * `PARTY · 4/6` case the header already exists for. The row form itself is
     * what is under test here, and this is the box it gets in any window with
     * the height for a party of six.
     */
    const view = party([
      TurnActorState.Waiting,
      TurnActorState.Waiting,
      TurnActorState.Bell,
      TurnActorState.Committed,
      TurnActorState.StandingBy,
      TurnActorState.Committed,
    ]);
    const layout = roomyLayout(view);
    expect(layout.mode, 'the floor width no longer gets the row form').toBe(PartyPaneMode.Rows);
    expect(partyPaneHeight(view, layout.mode)).toBeLessThanOrEqual(layout.rect.h);

    const out = paint(view, layout);
    // Every name, whole — not an ellipsis, not a prefix of one.
    for (const name of ['>Dalt', 'Sam', 'Mo', 'Ren', 'Wen', 'Isa']) {
      expect(out.texts, `${name} did not survive the row`).toContain(name);
    }
    // ...and the word beside each of them.
    expect(out.texts.filter((t) => t === 'WAITING')).toHaveLength(1); // Sam
    expect(out.texts).toContain('YOUR MOVE'); // Dalt, the viewer
    expect(out.texts).toContain('BELL');
    expect(out.texts.filter((t) => t === 'DONE')).toHaveLength(2);
    expect(out.texts).toContain('STANDBY');
  });

  it('shows more of the party at the 640x320 floor than the card strip left room for', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THE DELETION BOUGHT, COUNTED IN PEOPLE RATHER THAN PIXELS.
     * ═══════════════════════════════════════════════════════════════════════
     * The dock band in combat was `TURN_BAR_H + 46 + DOCK_MARGIN` down to the
     * hotbar's reserve: 63..217 at the HUD floor, 154 pixels. It is 17..217 now,
     * 200 — and `paneGeometry` places rows while they fit and then stops, so the
     * band is the party. Measured here through the real layout rather than
     * asserted from arithmetic, because `partyPaneHeight`'s own note is that the
     * self row is taller than everybody else's.
     */
    const view = party([
      TurnActorState.Waiting,
      TurnActorState.Waiting,
      TurnActorState.Bell,
      TurnActorState.Committed,
      TurnActorState.StandingBy,
      TurnActorState.Committed,
    ]);
    const rowsIn = (top: number, bottom: number): number => {
      const layout = partyPaneLayout({ view, width: 640, top, bottom, rightReserved: 0 });
      if (layout === null) return 0;
      const out = painted();
      drawPartyPane({ ctx: out.ctx, sprites: CHIPS, view, layout });
      return out.out.texts.filter((t) => /^>?(Dalt|Sam|Mo|Ren|Wen|Isa)$/.test(t)).length;
    };
    // The band's floor is the hotbar's reserve and did not move; only its top did.
    const was = rowsIn(14 + 46 + 3, 217);
    const now = rowsIn(14 + 3, 217);
    expect(now, 'the reclaimed band did not reach the pane').toBeGreaterThan(was);
  });

  it('says nothing about the turn while nobody is fighting', () => {
    /**
     * Out of combat `engagement` is 0, nobody blocks, and the projector marks
     * every member `committed` — a true statement about the BARRIER and the
     * opposite of the truth about the PLAYER, who may act freely. Printing DONE
     * beside four names would tell four people they are waiting on each other
     * while they walk around a town.
     */
    const view = party([TurnActorState.Committed, TurnActorState.Committed]);
    const quiet: PartyPaneView = { ...view, inCombat: false };
    const out = paint(quiet, floorLayout(quiet));
    expect(out.texts).not.toContain('DONE');
    expect(out.texts).not.toContain('YOUR MOVE');
    expect(out.blits.filter((id) => id.startsWith('ui_icon_turn_'))).toHaveLength(0);
    // The slot the word would have used says who is in charge instead.
    expect(out.texts).toContain('LEAD');
  });

  it('carries the turn into the narrow form, where there is no room for a word', () => {
    /**
     * Portraits mode paints three initials and nothing else — measured, and the
     * reason the hover card exists. With the card strip deleted, a player on a
     * narrow window would otherwise have NO per-member turn state anywhere on
     * screen. The chip costs no width: it is in the same corner of the same
     * token as in the wide form.
     */
    const view = party([TurnActorState.Waiting, TurnActorState.Committed]);
    const narrow = partyPaneLayout({ view, width: 640, top: 14, bottom: 300, rightReserved: 214 });
    expect(narrow).not.toBeNull();
    if (narrow === null) return;
    expect(narrow.mode).toBe(PartyPaneMode.Portraits);

    const out = paint(view, narrow);
    expect(out.texts).toEqual(['D', 'S']); // still only initials
    expect(out.blits).toContain('ui_icon_turn_waiting');
    expect(out.blits).toContain('ui_icon_turn_committed');
  });
});
