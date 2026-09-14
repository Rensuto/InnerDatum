// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BOSS_ART_COMMISSION,
  EFFECT_ART_COMMISSION,
  ENEMY_ART_COMMISSION,
  ITEM_ART_COMMISSION,
  PROP_ART_COMMISSION,
  STATUS_ICON_ART_COMMISSION,
  TOWNSFOLK_ART_COMMISSION,
} from '../../content/art-requests.ts';
import type { ArtRequest } from '../../content/art-requests.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMMISSION IS READ BY A SCANNER, SO IT HAS TO BE WHAT THE SCANNER READS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ids follow `tools/art-needs.mjs`'s shape — one of its stems, then
 * lower-case words joined by underscores — so the day one is wired, the
 * inventory counts it. Until then they stay out of that inventory: the
 * repository keeps no `*ART_REQUESTS` constant, and an id in an `id:` field is
 * a name to the scanner, not a picture.
 */
const STEMS = ['chr_npc_', 'enemy_', 'icon_', 'item_', 'prop_', 'ui_'] as const;
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const ALL: readonly (readonly [string, readonly ArtRequest[]])[] = [
  ['townsfolk', TOWNSFOLK_ART_COMMISSION],
  ['enemies', ENEMY_ART_COMMISSION],
  ['bosses', BOSS_ART_COMMISSION],
  ['effects', EFFECT_ART_COMMISSION],
  ['status icons', STATUS_ICON_ART_COMMISSION],
  ['items', ITEM_ART_COMMISSION],
  ['props', PROP_ART_COMMISSION],
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

  it('spells every id out in an `id:` field, where the art inventory leaves it alone', () => {
    /**
     * An id built from a template is one nobody can search for, and an id passed
     * anywhere but an `id:` field is read by tools/art-needs.mjs as art the code
     * already draws. Both happened to this file once: thirty-six effects were
     * built from a template, and the first version's constants were counted as
     * requests by an inventory that is meant to hold none.
     */
    const text = readFileSync(new URL('../../content/art-requests.ts', import.meta.url), 'utf8');
    expect(/\bconst\s+[A-Z_]*ART_REQUESTS\b/.test(text), 'a constant is a request list again').toBe(
      false,
    );
    for (const [list, requests] of ALL) {
      for (const { id } of requests) {
        const hits = text.split(`'${id}'`).length - 1;
        const named = text.split(`id: '${id}'`).length - 1;
        expect(hits, `${list}: ${id} is not spelled out once`).toBe(1);
        expect(named, `${list}: ${id} is not in an id field`).toBe(1);
      }
    }
  });
});
