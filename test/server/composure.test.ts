import { describe, expect, it } from 'vitest';

import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import {
  COMPOSURE,
  backToTheWall,
  backToWallAt,
  countThem,
  countThemAt,
  evenBreathing,
  evenBreathingAt,
  holdTheFrame,
  holdTheFrameAt,
  lastWord,
  lastWordAt,
  notTheFirstAtkAt,
  notTheFirstTime,
} from '../../src/server/talents/composure.ts';
import type { PassiveView } from '../../src/server/engine/hooks.ts';
import type { Talent } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE CONDITION ACTUALLY FIRE? — asked of every talent in the discipline.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `generic/composure` is six passives and five of them are CONDITIONAL. The
 * structural tests already covering it — tier ladder, six per tree, stat gate,
 * registration — would all pass on a tree whose conditions never came true,
 * which is the same failure this codebase has now shipped four times in other
 * shapes: built, correct, and reached by nothing.
 *
 * So each one is asked twice: with the condition false, and with it true.
 */
const view = (over: Partial<PassiveView>): PassiveView => ({ ...EMPTY_PASSIVE_VIEW, ...over });

/** What a talent contributes to one mod at a level, or 0. */
function modOf(talent: Talent, level: number, v: PassiveView, key: string): number {
  const block = talent.passive?.(level, v) ?? {};
  const mods: Record<string, number | undefined> = block.mods ?? {};
  return mods[key] ?? 0;
}

/** Surrounded, unhurt. */
const CROWDED = view({ adjacentEnemies: () => 2, hpFraction: () => 1 });
/** Hurt, alone. */
const HURT = view({ adjacentEnemies: () => 0, hpFraction: () => 0.2 });
/** Both — the state the discipline is named for. */
const CORNERED = view({ adjacentEnemies: () => 3, hpFraction: () => 0.2 });
/** Neither. */
const CALM = view({ adjacentEnemies: () => 0, hpFraction: () => 1 });

describe('composure pays only when it says it does', () => {
  it('gives nothing at all to a body that is fine', () => {
    for (const talent of COMPOSURE) {
      if (talent.id === countThem.id) continue; // the deliberate flat one
      const block = talent.passive?.(3, CALM) ?? {};
      expect(Object.keys(block.mods ?? {}), `${talent.name} paid out for nothing`).toEqual([]);
    }
  });

  it('pays the flat one whatever the room is doing', () => {
    expect(modOf(countThem, 3, CALM, 'mentalResist')).toBe(countThemAt(3));
    expect(modOf(countThem, 3, CORNERED, 'mentalResist')).toBe(countThemAt(3));
  });

  it('turns on the crowded half only when outnumbered', () => {
    expect(modOf(backToTheWall, 3, CALM, 'def')).toBe(0);
    expect(modOf(backToTheWall, 3, CROWDED, 'def')).toBe(backToWallAt(3));
    expect(modOf(holdTheFrame, 3, CALM, 'armour')).toBe(0);
    expect(modOf(holdTheFrame, 3, CROWDED, 'armour')).toBe(holdTheFrameAt(3));
    expect(modOf(notTheFirstTime, 3, CALM, 'atk')).toBe(0);
    expect(modOf(notTheFirstTime, 3, CROWDED, 'atk')).toBe(notTheFirstAtkAt(3));
  });

  /** ONE adjacent enemy is a fight, not a mistake. See `OUTNUMBERED`. */
  it('does not pay for a single adjacent enemy', () => {
    const one = view({ adjacentEnemies: () => 1 });
    expect(modOf(backToTheWall, 3, one, 'def')).toBe(0);
    expect(modOf(holdTheFrame, 3, one, 'armour')).toBe(0);
    expect(modOf(notTheFirstTime, 3, one, 'atk')).toBe(0);
  });

  it('turns on the hurt half on health alone', () => {
    expect(modOf(evenBreathing, 3, CALM, 'physResist')).toBe(0);
    expect(modOf(evenBreathing, 3, HURT, 'physResist')).toBe(evenBreathingAt(3));
  });

  /**
   * AND THE CAPSTONE WANTS BOTH, which is the one condition a partial state
   * must not satisfy — a talent that paid on either half would be two talents.
   */
  it('pays Last Word only when surrounded AND hurt', () => {
    expect(modOf(lastWord, 3, CROWDED, 'spellResist'), 'paid while unhurt').toBe(0);
    expect(modOf(lastWord, 3, HURT, 'spellResist'), 'paid while alone').toBe(0);
    expect(modOf(lastWord, 3, CORNERED, 'spellResist')).toBe(lastWordAt(3));
    expect(modOf(lastWord, 3, CORNERED, 'mentalResist')).toBe(lastWordAt(3));
  });

  it('grows with the rank, on every talent in the tree', () => {
    for (const talent of COMPOSURE) {
      const low = talent.passive?.(1, CORNERED) ?? {};
      const high = talent.passive?.(5, CORNERED) ?? {};
      const sum = (b: typeof low): number =>
        Object.values(b.mods ?? {}).reduce<number>((n, v) => n + (v ?? 0), 0);
      expect(sum(high), `${talent.name} does not grow`).toBeGreaterThan(sum(low));
    }
  });
});
