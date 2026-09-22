/// <reference lib="dom" />
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is ToME's: a talent whose `preUseTalent(t, true, true)`
// fails is drawn with the `disabled` frame (engine/HotkeysIconsDisplay.lua:182,
// :194) — the same `on_pre_use` (tome/class/Actor.lua:5547) that refuses it.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  HOTBAR_SLOTS_DEFAULT,
  HotbarSlotKind,
  hotbarPanelSize,
  hotbarTipAt,
  isSlotDisabled,
  slotRect,
  talentAffordable,
  unpressableReason,
} from '../../src/client/ui/hotbar.ts';
import { NO_SHOOTER_REASON } from '../../src/server/engine/talents.ts';
import { ResourceKind, TalentShape } from '../../src/shared/protocol.ts';
import type { HotbarSlot, HotbarView } from '../../src/client/ui/hotbar.ts';
import type { PanelRect } from '../../src/client/ui/panel.ts';
import type { LoadoutTalent, ResourceView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT HALF OF `LoadoutTalent.unusable`: THE BUTTON GREYS AND SAYS WHY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server writes `NO_SHOOTER_REASON` onto a gun talent while the hand holds
 * no gun (test/server/loadout-gun-gate.test.ts drives that end over a socket).
 * This end has two jobs and one function behind both: `unpressableReason`
 * (ui/hotbar.ts), which `talentAffordable` greys on and `hotbarTipAt` prints.
 * main.ts's `affordable` is a one-line call to `talentAffordable`; that line is
 * the only part read from source, because main.ts boots a DOM at import and
 * cannot be loaded here.
 */

function talent(over: Partial<LoadoutTalent> = {}): LoadoutTalent {
  return {
    id: 'talent:revolver_shot',
    name: 'Revolver Shot',
    icon: 'icon_active_revolver_shot',
    cost: { ap: 4, mp: 0, resource: 0 },
    cooldownTurns: 0,
    range: 5,
    minRange: 3,
    shape: TalentShape.Single,
    radius: 0,
    level: 1,
    maxLevel: 5,
    desc: 'Fire once.',
    descNext: 'Fire once, harder.',
    ...over,
  };
}

describe('unpressableReason — the one answer the grey and the words share', () => {
  it('is null for a learned talent the server has said nothing about', () => {
    expect(unpressableReason(talent())).toBeNull();
  });

  it('prints the server’s sentence as sent, and invents none of its own', () => {
    expect(unpressableReason(talent({ unusable: NO_SHOOTER_REASON }))).toBe(NO_SHOOTER_REASON);
    // ANY sentence, not the one it happens to know: the client holds no copy
    // of the rule, so it must not hold a copy of the words either.
    expect(unpressableReason(talent({ unusable: 'some other rule' }))).toBe('some other rule');
  });

  it('says "not learned yet" first, in the order the server refuses them', () => {
    // `canUseTalent` answers `NotLearned` before it reaches `on_pre_use`, so a
    // rank-0 gun talent held with a maul is refused for the rank — and a point,
    // not an empty hand, is the first thing that player needs.
    expect(unpressableReason(talent({ level: 0 }))).toBe('not learned yet');
    expect(unpressableReason(talent({ level: 0, unusable: NO_SHOOTER_REASON }))).toBe(
      'not learned yet',
    );
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const W = 640;

/** The bar's rect for a `W`-wide box — the hotbar suite's own construction. */
function rectFor(width: number): PanelRect {
  const size = hotbarPanelSize(HOTBAR_SLOTS_DEFAULT, null, width);
  return {
    x: Math.max(0, Math.floor((width - size.w) / 2)),
    y: 480 - size.h,
    w: size.w,
    h: size.h,
  };
}

/** Slot 0 holds `first`; the rest of the bar is empty. */
function barWith(first: HotbarSlot): HotbarView {
  const slots: HotbarSlot[] = [first];
  while (slots.length < HOTBAR_SLOTS_DEFAULT) slots.push({ kind: HotbarSlotKind.Empty });
  return { slots, hovered: -1, armed: -1 };
}

/** The card over slot 0. */
function metaOver(view: HotbarView): string {
  const rect = rectFor(W);
  const at = slotRect(rect, 0, view.slots.length);
  const card = hotbarTipAt(view, rect, at.x + 2, at.y + 2);
  expect(card, 'no card over slot 0 — the fixture is off the bar').not.toBeNull();
  return card?.meta ?? '';
}

describe('the hotbar card names the reason the server gave', () => {
  it('prints the gun sentence on a greyed gun talent, and not "not affordable"', () => {
    // `affordable` is FALSE here because main.ts folds `unusable` into it —
    // which is the input the painter and the card actually receive.
    const slot: HotbarSlot = {
      kind: HotbarSlotKind.Talent,
      talent: talent({ unusable: NO_SHOOTER_REASON }),
      cooldown: 0,
      affordable: false,
    };
    // THE GREY: the frame the painter picks for a slot it calls disabled.
    expect(isSlotDisabled(slot)).toBe(true);
    const meta = metaOver(barWith(slot));
    expect(meta).toContain(NO_SHOOTER_REASON);
    // "not affordable" would send her to wait for a pool that is already full.
    expect(meta).not.toContain('not affordable');
  });

  it('still says "not affordable" for a talent that is only short on the pool', () => {
    // THE CONTROL, so the line above is about `unusable` and not about a card
    // that stopped printing budgets at all.
    const slot: HotbarSlot = {
      kind: HotbarSlotKind.Talent,
      talent: talent(),
      cooldown: 0,
      affordable: false,
    };
    expect(metaOver(barWith(slot))).toContain('not affordable');
  });

  it('says nothing at all about a gun talent that can be fired', () => {
    const slot: HotbarSlot = {
      kind: HotbarSlotKind.Talent,
      talent: talent(),
      cooldown: 0,
      affordable: true,
    };
    expect(isSlotDisabled(slot)).toBe(false);
    expect(metaOver(barWith(slot))).not.toContain(NO_SHOOTER_REASON);
  });
});

// ---------------------------------------------------------------------------
// The join, in main.ts
// ---------------------------------------------------------------------------

const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/** Comments explain the code; they must not be able to satisfy an assertion. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** A named function's body, brace-matched — hudwiring.test.ts's technique. */
function body(head: string): string {
  const at = MAIN.indexOf(head);
  if (at < 0) throw new Error(`not found: ${head}`);
  let depth = 0;
  let seen = false;
  for (let i = at; i < MAIN.length; i += 1) {
    const ch = MAIN[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return MAIN.slice(at, i + 1);
    }
  }
  return MAIN.slice(at);
}

describe('talentAffordable — the grey, driven rather than read', () => {
  /**
   * THE GREY ITSELF, AS A FUNCTION. It lived in main.ts, which boots a DOM at
   * import, so the only guard it could have was a search of the source for
   * `unpressableReason(talent)` — and a mutant that kept those words and ignored
   * the field (`… !== null && talent.level < 1`) passed every client test.
   * Driven here instead, the field has to decide the answer.
   */
  const full: ResourceView = {
    kind: ResourceKind.Focus,
    current: 50,
    max: 50,
    ap: 12,
    maxAp: 12,
    discrete: false,
  };

  it('refuses a learned gun talent while the hand holds no gun, whatever the pools hold', () => {
    const gunless = talent({ level: 3, unusable: NO_SHOOTER_REASON });
    expect(talentAffordable(talent({ level: 3 }), full), 'the setup is not affordable').toBe(true);
    expect(talentAffordable(gunless, full)).toBe(false);
    // …and with no pool frame yet, which is the early `return true` a late ask
    // would lose to.
    expect(talentAffordable(gunless, null)).toBe(false);
  });

  it('still refuses rank 0 and still reads the budgets', () => {
    expect(talentAffordable(talent({ level: 0 }), full)).toBe(false);
    expect(talentAffordable(talent({ cost: { ap: 20, mp: 0, resource: 0 } }), full)).toBe(false);
  });
});

describe('main.ts greys on the same answer the card prints', () => {
  it('refuses a greyed press with its sentence BEFORE the cursor opens', () => {
    // Upstream's `useTalent` asks `preUseTalent` out loud and prints before
    // targeting (tome/class/Actor.lua:5547). Asked after `targeting.begin`, the
    // player aims a greyed gun, picks a tile, and only then hears why.
    const fn = code(body('function activateSlot(index: number): void {'));
    const asked = fn.indexOf('unpressableReason(talent)');
    const aimed = fn.indexOf('targeting.begin(');
    const sent = fn.indexOf('sendTalent(talent, null)');
    expect(asked, '`activateSlot` no longer asks before aiming').toBeGreaterThanOrEqual(0);
    expect(asked, 'the cursor opens before the refusal').toBeLessThan(aimed);
    expect(asked, 'a self talent is sent before the refusal').toBeLessThan(sent);
  });

  it('has `affordable` hand the whole question to `talentAffordable`', () => {
    // THE ONE LINE OF THE JOIN THAT CANNOT BE DRIVEN from a node test: main.ts
    // asks the shared function with its own last `resource` frame.
    expect(code(body('function affordable(talent: LoadoutTalent): boolean {'))).toContain(
      'return talentAffordable(talent, resource);',
    );
  });

  it('builds every talent slot’s `affordable` from `affordable(talent)`', () => {
    // The other end of the join: a slot built with `affordable: true` would
    // make the line above dead code.
    expect(code(body('function hotbarView(): HotbarView {'))).toContain(
      'affordable: affordable(talent)',
    );
  });
});
