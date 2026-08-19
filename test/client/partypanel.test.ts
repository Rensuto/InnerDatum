/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { createContextMenu } from '../../src/client/ui/contextmenu.ts';
import {
  PARTY_PANE_COMPACT_W,
  PARTY_PANE_W,
  PartyPaneMode,
  drawPartyPane,
  partyPaneHeight,
  partyPaneHitAt,
  partyPaneLayout,
  partyPaneView,
} from '../../src/client/ui/partypanel.ts';
import { respawnPromptHit, respawnPromptRect } from '../../src/client/ui/respawnprompt.ts';
import { ActorKind, ActorRank, DownedStatus, PartyAction } from '../../src/shared/protocol.ts';
import { TurnActorState, VoiceState } from '../../src/shared/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
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
