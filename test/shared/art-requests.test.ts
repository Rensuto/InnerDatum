// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BOSS_ART_REQUESTS,
  EFFECT_ART_REQUESTS,
  ENEMY_ART_REQUESTS,
  ITEM_ART_REQUESTS,
  PROP_ART_REQUESTS,
  STATUS_ICON_ART_REQUESTS,
  TOWNSFOLK_ART_REQUESTS,
} from '../../content/art-requests.ts';
import type { ArtRequest } from '../../content/art-requests.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMMISSION IS READ BY A SCANNER, SO IT HAS TO BE WHAT THE SCANNER READS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/art-needs.mjs` collects every string in an `*ART_REQUESTS` constant
 * that looks like an asset id: one of its stems, then lower-case words joined
 * by underscores. An id outside that shape is silently not a request, and
 * nobody draws it.
 */
const STEMS = ['chr_npc_', 'enemy_', 'icon_', 'item_', 'prop_', 'ui_'] as const;
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const ALL: readonly (readonly [string, readonly ArtRequest[]])[] = [
  ['townsfolk', TOWNSFOLK_ART_REQUESTS],
  ['enemies', ENEMY_ART_REQUESTS],
  ['bosses', BOSS_ART_REQUESTS],
  ['effects', EFFECT_ART_REQUESTS],
  ['status icons', STATUS_ICON_ART_REQUESTS],
  ['items', ITEM_ART_REQUESTS],
  ['props', PROP_ART_REQUESTS],
];

describe('the standing art commission', () => {
  it('names every piece with an id the art scanner will count', () => {
    for (const [list, requests] of ALL) {
      expect(requests.length, `${list} is empty`).toBeGreaterThan(0);
      for (const { id } of requests) {
        expect(
          STEMS.some((stem) => id.startsWith(stem) && id.length > stem.length) && ID.test(id),
          `${list}: ${id} is not an asset id the scanner reads`,
        ).toBe(true);
      }
    }
  });

  it('asks for each piece once', () => {
    const ids = ALL.flatMap(([, requests]) => requests.map((r) => r.id));
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(repeated, 'an id is requested twice').toEqual([]);
  });

  it('gives every piece a size from the scale contract and a brief to draw from', () => {
    for (const [list, requests] of ALL) {
      for (const { id, size, brief, where } of requests) {
        expect(brief.trim().length, `${list}: ${id} has no brief`).toBeGreaterThan(10);
        expect(where.trim().length, `${list}: ${id} says nowhere`).toBeGreaterThan(0);
        // STANDING BODIES FACE SOUTH IN ONE FRAME, and the id says so the way
        // every shipped actor's does.
        if (size === '48x64') expect(id.endsWith('_s'), `${list}: ${id} is a body`).toBe(true);
        if (id.startsWith('ui_fx_')) {
          expect(['256x64', '384x64'], `${list}: ${id} is not a strip`).toContain(size);
        }
        if (id.startsWith('icon_') || id.startsWith('item_') || id.startsWith('prop_')) {
          expect(size, `${list}: ${id} is not one cell`).toBe('64x64');
        }
      }
    }
  });

  it('spells every id out, because the scanner cannot read an id built at runtime', () => {
    /**
     * tools/art-needs.mjs counts only string literals inside an `*ART_REQUESTS`
     * constant, so an id assembled from a template is silently not a request.
     * Thirty-six damage-type effects were once built that way and went uncounted.
     */
    const text = readFileSync(new URL('../../content/art-requests.ts', import.meta.url), 'utf8');
    for (const [list, requests] of ALL) {
      for (const { id } of requests) {
        expect(text.includes(`'${id}'`), `${list}: ${id} is not spelled out`).toBe(true);
      }
    }
  });
});
