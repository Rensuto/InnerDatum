// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/server/world/world.ts';
import { fogBytes, fogHas, fogSet } from '../../src/shared/fog.ts';

describe('a level remembers, for each character', () => {
  it('hands back one bitset a character, sized to the level, made on first asking', () => {
    const world = createWorld('memory');
    expect(world.hasMemoryOf('p1')).toBe(false);
    const mine = world.memoryOf('p1');
    expect(mine.length).toBe(fogBytes(world.level.w, world.level.h));
    expect(world.hasMemoryOf('p1')).toBe(true);
    expect(world.memoryOf('p1'), 'a second asking made a new one').toBe(mine);
    expect(world.memoryOf('p2'), 'two characters share one memory').not.toBe(mine);
  });

  it('keeps what is written into it', () => {
    const world = createWorld('memory-write');
    fogSet(world.memoryOf('p1'), world.level.w, 3, 4);
    expect(fogHas(world.memoryOf('p1'), world.level.w, 3, 4)).toBe(true);
  });

  it('takes a restored memory in place of an empty one', () => {
    const world = createWorld('memory-restore');
    const restored = new Uint8Array(fogBytes(world.level.w, world.level.h));
    fogSet(restored, world.level.w, 2, 2);
    world.setMemoryOf('p1', restored);
    expect(world.hasMemoryOf('p1')).toBe(true);
    expect(fogHas(world.memoryOf('p1'), world.level.w, 2, 2)).toBe(true);
  });

  it('is separate on two levels, for the same character', () => {
    const a = createWorld('memory-a');
    const b = createWorld('memory-b');
    fogSet(a.memoryOf('p1'), a.level.w, 1, 1);
    expect(fogHas(b.memoryOf('p1'), b.level.w, 1, 1)).toBe(false);
  });
});
