// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { createFog, fogSet, fogToBase64 } from '../../src/shared/fog.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { readVisionFrame, visionViewOf } from '../../src/client/vision.ts';
import type { VisionMsg } from '../../src/shared/protocol.ts';

/** A 5x4 window with its corner at (10, 20) of a larger level. */
function frame(): VisionMsg {
  const seen = createFog(5, 4);
  fogSet(seen, 5, 0, 0);
  fogSet(seen, 5, 4, 3);
  const remembered = createFog(5, 4);
  fogSet(remembered, 5, 1, 1);
  fogSet(remembered, 5, 2, 2);
  return {
    v: PROTOCOL_VERSION,
    t: 'vision',
    realmId: 'realm:test',
    x0: 10,
    y0: 20,
    w: 5,
    h: 4,
    seen: fogToBase64(seen),
    remembered: fogToBase64(remembered),
    sight: 10,
  };
}

describe('readVisionFrame', () => {
  it('adds the remembered bits to memory at their level tiles, and nothing else', () => {
    const memory = new Set<string>();
    readVisionFrame(frame(), memory, new Set<string>());
    expect([...memory].sort()).toEqual(['11,21', '12,22']);
  });

  it('keeps what memory already held, so memory only grows', () => {
    const memory = new Set<string>(['0,0']);
    readVisionFrame(frame(), memory, new Set<string>());
    expect(memory.has('0,0')).toBe(true);
    expect(memory.size).toBe(3);
  });

  it('adds every seen AND every remembered bit to has-seen, and keeps what it held', () => {
    // The frame's two sets are disjoint on purpose: a seen tile it does not
    // remember is dark ground in a lantern, and a remembered one it does not see
    // is ground behind the body. Upstream's `has_seens` holds both.
    const hasSeen = new Set<string>(['0,0']);
    const memory = new Set<string>();
    readVisionFrame(frame(), memory, hasSeen);
    expect([...hasSeen].sort()).toEqual(['0,0', '10,20', '11,21', '12,22', '14,23']);
    expect([...memory].sort(), 'seen ground was remembered').toEqual(['11,21', '12,22']);
  });
});

describe('visionViewOf', () => {
  it('answers seen at level coordinates, and only inside the window', () => {
    const memory = new Set<string>();
    const view = visionViewOf(
      readVisionFrame(frame(), memory, new Set<string>()),
      'realm:test',
      memory,
    );
    if (view === null) throw new Error('no view for the map on screen');
    expect(view.seen(10, 20)).toBe(true);
    expect(view.seen(14, 23)).toBe(true);
    expect(view.seen(11, 20), 'a tile in the window the server did not mark').toBe(false);
    expect(view.seen(9, 20), 'a tile left of the window').toBe(false);
    expect(view.seen(15, 23), 'a tile right of the window').toBe(false);
    // AND TWO THAT WOULD LAND ON A MARKED BIT if the window's edges were ignored:
    // one row above the corner aliases to (0, 0), and four columns past the
    // right edge on the third row aliases to (4, 3).
    expect(view.seen(15, 19), 'a tile above the window, aliasing onto a marked bit').toBe(false);
    expect(view.seen(19, 22), 'a tile right of the window, aliasing onto a marked bit').toBe(false);
  });

  it('remembers whatever memory holds, inside the window or not', () => {
    const memory = new Set<string>(['0,0']);
    const view = visionViewOf(
      readVisionFrame(frame(), memory, new Set<string>()),
      'realm:test',
      memory,
    );
    if (view === null) throw new Error('no view for the map on screen');
    expect(view.remembered(0, 0)).toBe(true);
    expect(view.remembered(11, 21)).toBe(true);
    expect(view.remembered(13, 22)).toBe(false);
  });

  it('carries the viewer`s sight radius, which the aim preview draws its line with', () => {
    const memory = new Set<string>();
    const window = readVisionFrame(frame(), memory, new Set<string>());
    expect(window.sight).toBe(10);
    expect(visionViewOf(window, 'realm:test', memory)?.sight).toBe(10);
  });

  it('says nothing before a window arrives, or for a window of another map', () => {
    const memory = new Set<string>();
    expect(visionViewOf(null, 'realm:test', memory)).toBeNull();
    expect(
      visionViewOf(readVisionFrame(frame(), memory, new Set<string>()), 'realm:other', memory),
    ).toBeNull();
  });
});
