// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Zone.lua:141-148.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import { ZoneLevelScheme, zoneBaseLevel } from '../../src/shared/zone.ts';

describe('a fixed zone', () => {
  it('is its own level and nobody else’s', () => {
    /**
     * ═══ THE PROPERTY THE WHOLE ROGUELIKE CONTRACT RESTS ON ═══
     * A place you walked to is as dangerous as it is. If this ever starts
     * reading the party level, the single clearest reward this map offers — the
     * walk you could not survive last week — quietly stops existing, and no
     * amount of tuning anywhere else brings it back.
     */
    for (const level of [1, 5, 25, MAX_CHARACTER_LEVEL]) {
      expect(zoneBaseLevel([7, 9], ZoneLevelScheme.Fixed, level)).toBe(7);
    }
  });

  it('reads the bottom of its range, exactly as upstream does', () => {
    // `base_level = level_range[1]` — Zone.lua:143. The top of a fixed zone's
    // range is not a level; it is what its OTHER content is allowed to reach.
    expect(zoneBaseLevel([12, 40], ZoneLevelScheme.Fixed, 1)).toBe(12);
  });
});

describe('a player-scheme zone', () => {
  it('arrives at the level of whoever it is arriving at', () => {
    for (const level of [1, 6, 19, MAX_CHARACTER_LEVEL]) {
      expect(zoneBaseLevel([1, MAX_CHARACTER_LEVEL], ZoneLevelScheme.Player, level)).toBe(level);
    }
  });

  it('is bounded by its range in both directions', () => {
    // `util.bound(plev, range[1], range[2])` — Zone.lua:146. The clamp is what
    // lets content say "this stops being a threat eventually" and mean it.
    expect(zoneBaseLevel([10, 20], ZoneLevelScheme.Player, 3)).toBe(10);
    expect(zoneBaseLevel([10, 20], ZoneLevelScheme.Player, 44)).toBe(20);
    expect(zoneBaseLevel([10, 20], ZoneLevelScheme.Player, 14)).toBe(14);
  });
});

describe('the floor of 1, which is ours and not upstream’s', () => {
  it('refuses a level-0 body however the range was typed', () => {
    // A level-0 monster is not a crash — it is a body that never levelled, which
    // looks exactly like a correctly-spawned weak one. That is the bug worth a
    // line of code to make impossible.
    expect(zoneBaseLevel([0, 0], ZoneLevelScheme.Fixed, 9)).toBe(1);
    expect(zoneBaseLevel([-5, 3], ZoneLevelScheme.Player, 0)).toBe(1);
  });

  it('survives a range written backwards', () => {
    // Not upstream behaviour — upstream would return a nonsense bound. An
    // authored table is written by hand and this is the typo it will make.
    expect(zoneBaseLevel([9, 4], ZoneLevelScheme.Player, 30)).toBe(9);
  });
});
