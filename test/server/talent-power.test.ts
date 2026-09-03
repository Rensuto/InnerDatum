// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createContentTalentEngine } from '../../src/server/content/classes.ts';
import { TalentPower, scalingText } from '../../src/server/engine/derived.ts';
import type { TalentPower as TalentPowerT } from '../../src/server/engine/derived.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND LAYER UNDER `scalesWith` — COVERAGE, NOT CORRECTNESS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test/server/talent-scaling.test.ts` proves CORRECTNESS the only way it can
 * be proved: it drives four talents against a real caster and compares the
 * `applyPower` they hand `ctx.status` against the power they declare. That is
 * airtight and it does not scale — every talent added to it needs a fixture, a
 * target and a legal cast.
 *
 * This file is the cheap half, and it is about the two directions that
 * behavioural test cannot see at all:
 *
 *   A DECLARATION WITH NO IMPLEMENTATION. A talent claims to land on Mindpower
 *   and its file never calls `combatMindpower`. That is a sentence shown to a
 *   player with nothing behind it.
 *
 *   AN IMPLEMENTATION WITH NO DECLARATION. A talent rolls `applyPower` and
 *   declares nothing, so the panel stays silent about the one thing it was
 *   asked to say. This is how the feature rots: not by being wrong, but by new
 *   talents quietly not joining it.
 *
 * ═══ IT READS SOURCE, WITH COMMENTS STRIPPED, AND THAT IS DELIBERATE ═══
 * A bare grep for `combatPhysicalpower` false-positives immediately:
 * `concussion_flask.ts` names it in prose while calling `combatMindpower`, and
 * `pistol_whip.ts` writes it with parentheses in a comment. Both would pass a
 * naive check and both would be wrong. Comments come out first.
 *
 * WHAT IT STILL CANNOT SEE, stated so nobody trusts it further than it goes: a
 * file is not a talent. `leverage.ts` exports six from one shared base, and
 * only `overreach` rolls anything — the first draft of this feature put
 * `scalesWith` on that base and would have told a player that two passives
 * scale on Physical power. This file could not have caught that, and the
 * behavioural test can.
 */

const DIR = 'src/server/talents';

/** The power each `combat*power` call means, as a talent would declare it. */
const CALLS: readonly (readonly [string, TalentPowerT])[] = [
  ['combatPhysicalpower', TalentPower.Physical],
  ['combatSpellpower', TalentPower.Spell],
  ['combatMindpower', TalentPower.Mind],
  ['combatAttack', TalentPower.Accuracy],
];

/** Block comments, line comments, and nothing else. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function files(): readonly string[] {
  return readdirSync(DIR).filter((name) => name.endsWith('.ts'));
}

function sourceOf(name: string): string {
  return code(readFileSync(`${DIR}/${name}`, 'utf8'));
}

/** What a file DECLARES it lands on. */
function declared(src: string): Set<string> {
  const out = new Set<string>();
  for (const match of src.matchAll(/lands:\s*TalentPower\.(\w+)/g)) {
    const key = match[1];
    if (key !== undefined) out.add(key.toLowerCase());
  }
  return out;
}

/** What a file actually rolls an effect against — `applyPower:` and only that. */
function rolled(src: string): Set<string> {
  const out = new Set<string>();
  for (const match of src.matchAll(/applyPower:\s*([A-Za-z_$][\w$]*)/g)) {
    const callee = match[1] ?? '';
    for (const [fn, power] of CALLS) if (callee === fn) out.add(power);
    // A LOCAL BINDING — `applyPower: power` — is resolved by finding what that
    // name was assigned from. Four talents are written this way and skipping
    // them would leave the check quietly narrower than it claims to be.
    if (!CALLS.some(([fn]) => callee === fn)) {
      for (const [fn, power] of CALLS) {
        if (new RegExp(`\\b${callee}\\s*=\\s*${fn}\\s*\\(`).test(src)) out.add(power);
      }
    }
  }
  return out;
}

describe('a declared scaling has something behind it', () => {
  it('every talent that names a landing power calls it', () => {
    const wrong: string[] = [];
    for (const name of files()) {
      const src = sourceOf(name);
      const says = declared(src);
      if (says.size === 0) continue;
      const does = rolled(src);
      for (const power of says) {
        if (!does.has(power)) wrong.push(`${name} declares ${power} and never rolls it`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('and every talent that rolls one names it', () => {
    /**
     * THE DIRECTION THAT KEEPS THE FEATURE ALIVE. A talent added tomorrow that
     * applies an effect and declares nothing is a panel that has gone quiet
     * about the one thing it was built to say — and nothing else in this suite
     * would notice.
     */
    const missing: string[] = [];
    for (const name of files()) {
      const src = sourceOf(name);
      const does = rolled(src);
      if (does.size === 0) continue;
      const says = declared(src);
      for (const power of does) {
        if (!says.has(power)) missing.push(`${name} rolls ${power} and declares nothing`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the coverage ratchet', () => {
  /**
   * HOW MANY TALENTS ANSWER THE QUESTION TODAY.
   *
   * A floor rather than an equality, and a floor rather than nothing: the panel
   * is silent for a talent that declares no scaling, and silence is an honest
   * answer for one nobody has checked — but it must not become the answer for
   * one that used to speak. Raise this when more are authored; it may not fall.
   *
   * Every number here was authored against what the talent does and is held to
   * it by the two cases above plus the behavioural gate in
   * `talent-scaling.test.ts`.
   */
  const FLOOR = 35;

  it(`at least ${String(FLOOR)} talents say what makes them bigger`, () => {
    const all = createContentTalentEngine().registry.all();
    const speaking = all.filter((talent) => talent.scalesWith !== undefined);
    expect(
      speaking.length,
      `coverage fell from ${String(FLOOR)} to ${String(speaking.length)}`,
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it('and every one of them renders a sentence rather than an empty string', () => {
    /**
     * A `scalesWith: {}` typechecks and says nothing, which would put an empty
     * `Scales:` row on the panel. `scalingText` answers null for it — this is
     * the case that proves no authored value reaches that branch.
     */
    const body = { weapon: { dam: 12, damMod: { dex: 0.7, str: 0.3 } } };
    for (const talent of createContentTalentEngine().registry.all()) {
      if (talent.scalesWith === undefined) continue;
      const text = scalingText(body, talent.scalesWith);
      expect(text, `${talent.id} declares a scaling that renders nothing`).not.toBeNull();
      expect((text ?? '').length, talent.id).toBeGreaterThan(8);
    }
  });

  it('names the weapon stats the caster actually has, not a constant', () => {
    /**
     * THE HALF THAT IS NOT AUTHORED. `'weapon'` means "ask the body": the
     * Inspector's shots scale 0.7 Dexterity + 0.3 Strength because of the
     * class's `damMod`, and an item may carry its own. A talent that hard-coded
     * a stat name would go stale the first time a dropped revolver disagreed.
     */
    const scaling = { damage: TalentPower.Weapon };
    expect(scalingText({ weapon: { dam: 10, damMod: { dex: 0.7, str: 0.3 } } }, scaling)).toBe(
      'damage from your weapon (Dexterity, Strength)',
    );
    expect(scalingText({ weapon: { dam: 10, damMod: { mag: 0.5, cun: 0.3 } } }, scaling)).toBe(
      'damage from your weapon (Magic, Cunning)',
    );
    // NO WEAPON IS NOT NO SCALING. `combatDamage` falls back to `{ str: 0.6 }`,
    // so a body without one still hits with Strength and must say so.
    expect(scalingText({}, scaling)).toBe('damage from your weapon (Strength)');
  });
});
