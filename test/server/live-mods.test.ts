// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is this codebase's own, not a port: an item may grant any
// `CombatMods` field that something reads, and only those.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEAD_MOD_KEYS, ITEMS } from '../../src/server/content/items.ts';
import { EGOS, egoWielder } from '../../src/server/content/egos.ts';
import { composeWielders } from '../../src/server/engine/equipment.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { rollLoot } from '../../src/server/content/loot.ts';
import { createRng } from '../../src/shared/rng.ts';
import { combatMindpower, combatSpellpower } from '../../src/server/engine/derived.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A GREP RESULT PASTED INTO A DOCBLOCK IS A FACT WITH NO EXPIRY DATE ON IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AdditiveMods` removed three fields from the item vocabulary and justified it
 * by quoting a grep: *"`combatSpeed|combatSpellpower|combatMindpower` ->
 * COMMENTS ONLY. Zero call sites."* It was true the day it was written.
 *
 * By the time it mattered, `combatMindpower` was the `applyPower` of TEN
 * Redactor and Alchemist talents and `combatSpellpower` of `breaching_blow`,
 * and both printed on the character sheet and in the swap comparison. Both
 * getters read the mod the `Omit` was hiding. So the type forbade an item that
 * would have worked perfectly, and the comment went on asserting otherwise.
 *
 * It was believed twice more: an audit reported the list as stale and was
 * disbelieved on the strength of the docblock, and a follow-up grep piped
 * through `head` truncated before `src/server/talents/` — which sorts after
 * `src/server/engine/` — and read the truncation as absence.
 *
 * THIS IS THE CHECK THAT PASTE COULD NOT SURVIVE: it runs the grep, now, with
 * comments stripped, against the list as it stands.
 */

/** Every `.ts` under `src/`, comments removed, so prose cannot count as a use. */
function sourceBodies(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(child, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      out.set(child.pathname, text);
    }
  };
  walk(new URL('../../src/', import.meta.url));
  return out;
}

/** Files that name `symbol` outside a comment, excluding its own definition file. */
function usersOf(symbol: string, definedIn: string): string[] {
  const found: string[] = [];
  for (const [path, text] of sourceBodies()) {
    if (path.endsWith(definedIn)) continue;
    if (new RegExp(`\\b${symbol}\\b`).test(text)) found.push(path);
  }
  return found;
}

describe('the dead-mod list is still true', () => {
  it('every field it names really has no reader', () => {
    /**
     * THE DIRECTION THAT MATTERS. A field on this list is forbidden to items and
     * to egos, so a stale entry is a silent refusal of something that works —
     * which is exactly what happened to `spellPower` and `mindPower`.
     *
     * The getter's name is derived from the field rather than listed beside it,
     * so a fourth entry cannot be added without this test knowing where to look.
     */
    const getterFor: Readonly<Record<string, string>> = {
      physSpeed: 'combatSpeed',
      spellPower: 'combatSpellpower',
      mindPower: 'combatMindpower',
    };
    for (const key of DEAD_MOD_KEYS) {
      const getter = getterFor[key];
      expect(getter, `no getter is mapped for the dead mod '${key}'`).toBeDefined();
      if (getter === undefined) continue;
      expect(
        usersOf(getter, 'engine/derived.ts'),
        `'${key}' is on DEAD_MOD_KEYS but ${getter} has readers — take it off the list ` +
          `and off the Omit in content/items.ts`,
      ).toEqual([]);
    }
  });

  it('and the two that came off it are genuinely read', () => {
    // The other direction, so removing them was not merely permitted but right.
    expect(usersOf('combatMindpower', 'engine/derived.ts').length).toBeGreaterThan(5);
    expect(usersOf('combatSpellpower', 'engine/derived.ts').length).toBeGreaterThan(0);
    expect(DEAD_MOD_KEYS).not.toContain('spellPower');
    expect(DEAD_MOD_KEYS).not.toContain('mindPower');
  });
});

describe('and an item that grants them changes the number', () => {
  it('mind power moves what a Redactor talent applies with', () => {
    /**
     * Ten talents pass `combatMindpower(self.combat)` as `applyPower`, which is
     * what a save is rolled against — so this is the difference between a status
     * landing and being shrugged off, not a cosmetic row.
     */
    const bare = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
    const kitted = { ...bare, mods: { mindPower: 12 } };
    expect(combatMindpower(kitted)).toBeGreaterThan(combatMindpower(bare));
  });

  it('spell power moves what Breaching Blow applies with', () => {
    const bare = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
    const kitted = { ...bare, mods: { spellPower: 12 } };
    expect(combatSpellpower(kitted)).toBeGreaterThan(combatSpellpower(bare));
  });

  it('and `genericPower` already fed both, which is why the ban was inconsistent', () => {
    // Two egos grant `genericPower` (egos.ts:414, :495) and both getters add it,
    // so gear has scaled spell and mind power since those shipped. Forbidding
    // the targeted field while allowing the blanket one was the inconsistency.
    const bare = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
    const generic = { ...bare, mods: { genericPower: 12 } };
    expect(combatMindpower(generic)).toBeGreaterThan(combatMindpower(bare));
    expect(combatSpellpower(generic)).toBeGreaterThan(combatSpellpower(bare));
  });
});

describe('and content actually reaches the channel that was unblocked', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * LIFTING A BAN AND AUTHORING NOTHING IS THE SAME BUG POINTING THE OTHER WAY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `0bced47` removed `mindPower` from the forbidden list because eleven talents
   * read it. That left a channel every one of them consults and no item could
   * grant — a value with no writer rather than a value with no reader, and just
   * as invisible to a player.
   */
  it('an ego grants mindPower, and it survives the fold onto a sheet', () => {
    const ego = EGOS.find((e) => e.grants.mods?.mindPower !== undefined);
    expect(ego, 'no ego grants mindPower — the channel is open and empty').toBeDefined();
    if (ego === undefined) return;

    const granted = egoWielder(ego, 3, 'rare');
    const bare = { stats: { str: 10, dex: 10, con: 10, wil: 10, cun: 10 } };
    const worn = composeWielders(bare, [granted]);
    expect(worn.mods?.mindPower).toBeGreaterThan(0);
    // THROUGH THE GETTER TEN TALENTS SPEND, not merely present on the sheet.
    expect(combatMindpower(worn)).toBeGreaterThan(combatMindpower(bare));
  });

  it('and a player can find one — the real roller and the real resolver', () => {
    /**
     * The reachability question, asked the way `immunity.test.ts` asks it: if I
     * play, will I find one, and will it work? An ego that rolls and resolves to
     * nothing is what `resolveItem`'s field-by-field merge produced for the
     * immunity channel, and only this shape of test caught it.
     */
    let found = 0;
    for (const base of ITEMS.filter((item) => item.slot !== undefined)) {
      for (let i = 0; i < 120; i += 1) {
        const id = rollLoot(createRng(`${base.id}${String(i)}`), base.id, 20);
        if (!id.includes('~')) continue;
        if ((resolveItem(id)?.wielder?.mods?.mindPower ?? 0) > 0) found += 1;
      }
    }
    expect(found, 'the ego rolls but resolves to no mindPower').toBeGreaterThan(0);
  });
});
