/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAssetLibrary } from '../../src/client/render/assets.ts';
import type { AssetEntry } from '../../src/client/render/assets.ts';
import {
  LOCAL_TILE_SPRITES,
  LOCAL_WALL_FACE_SPRITES,
  localDoorSpriteId,
  loneTreeSpriteId,
} from '../../src/client/render/canvas.ts';
import { registerAllTalents } from '../../src/server/content/classes.ts';
import { MVP_EFFECTS } from '../../src/server/content/effects.ts';
import { MONSTER_TEMPLATES } from '../../src/server/content/monsters.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY PICTURE THE GAME IS WIRED TO DRAW IS ONE THE CLIENT ACTUALLY LOADS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The join that has hidden finished art three times: `NEEDED_ASSET_PREFIXES` in
 * src/client/main.ts filters the manifest before a single PNG loads, so an id
 * with a manifest row and a file on disk still draws its fallback when no
 * prefix admits it (`icon_ability_`, the passive and sustain icons, and the
 * town furnishings, each in turn). `art-needs` compares source with disk and
 * cannot see the filter; this compares the renderer's and the content's own
 * tables with it.
 *
 * TWO HALVES, AND ONLY ONE NEEDS THE ART. That the filter admits every id reads
 * committed source, so it holds on a bare clone. That the manifest has a row for
 * each, and that the real loader hands the renderer a sprite for it, reads the
 * gitignored manifest, and is skipped where there is none, as the reference/
 * checks are skipped without reference/.
 */

const root = new URL('../../', import.meta.url);

/** Comments stripped, the same way `assets.test.ts`'s `codeOf` does it. */
function codeOf(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * main.ts's `isNeeded`, rebuilt from its own source. main.ts boots the client
 * when imported, so the list is read rather than imported, and the function's
 * body is pinned below so the rebuild cannot drift from the real filter.
 */
function mainFilter(): (id: string) => boolean {
  const code = codeOf('src/client/main.ts');
  const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(code);
  expect(block, 'NEEDED_ASSET_PREFIXES was renamed or reshaped; this join is blind').not.toBeNull();
  expect(
    code,
    'isNeeded is no longer a prefix match over NEEDED_ASSET_PREFIXES; rebuild it here',
  ).toContain(
    'function isNeeded(entry: AssetEntry): boolean {\n' +
      '  return NEEDED_ASSET_PREFIXES.some((prefix) => entry.id.startsWith(prefix));\n' +
      '}',
  );
  const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  expect(prefixes.length).toBeGreaterThan(0);
  return (id) => prefixes.some((prefix) => id.startsWith(prefix));
}

/** A 3x3 level with `code` in the middle, walled on two opposite sides. */
function doorIn(code: TileCode, walls: 'north-south' | 'west-east') {
  const { FLOOR, WALL } = TileCode;
  const tiles: number[] = new Array<number>(9).fill(FLOOR);
  if (walls === 'north-south') {
    tiles[1] = WALL;
    tiles[7] = WALL;
  } else {
    tiles[3] = WALL;
    tiles[5] = WALL;
  }
  tiles[4] = code;
  return { w: 3, h: 3, tiles };
}

/**
 * A field of trees planted three apart, so every one of them is lone.
 *
 * 24 WIDE BECAUSE THE VARIANT IS A POSITIONAL HASH. A smaller field is a
 * smaller sample of `tileVariant` and deals only seven of the eight; measured,
 * 24x24 on this stride deals all eight, and the control below fails if that
 * ever stops being true.
 */
function loneTreeField() {
  const { GREEN, TREES } = TileCode;
  const side = 24;
  const tiles: number[] = new Array<number>(side * side).fill(GREEN);
  for (let y = 1; y < side; y += 3) {
    for (let x = 1; x < side; x += 3) tiles[y * side + x] = TREES;
  }
  return { w: side, h: side, tiles };
}

/** Every id the renderer's terrain tables, its doors and the content name, and who names it. */
function wiredIds(): ReadonlyMap<string, string> {
  const named = new Map<string, string>();
  const add = (id: string | null | undefined, where: string): void => {
    if (id !== null && id !== undefined && !named.has(id)) named.set(id, where);
  };
  for (const [code, ids] of Object.entries(LOCAL_TILE_SPRITES)) {
    for (const id of ids) add(id, `LOCAL_TILE_SPRITES[${code}]`);
  }
  for (const [code, ids] of Object.entries(LOCAL_WALL_FACE_SPRITES)) {
    for (const id of ids) add(id, `LOCAL_WALL_FACE_SPRITES[${code}]`);
  }
  // THE DOORS THROUGH THE FUNCTION THE PAINTER CALLS, both ways a wall can
  // run, so the table behind it needs no export and a door code it forgets to
  // map is found here as a missing id rather than not looked for.
  for (const code of [TileCode.DOOR, TileCode.DOOR_OPEN, TileCode.ROCK_DOOR]) {
    for (const walls of ['north-south', 'west-east'] as const) {
      add(localDoorSpriteId(doorIn(code, walls), code, 1, 1), `door ${String(code)}, ${walls}`);
    }
  }
  // AND THE LONE TREES THE SAME WAY. The overlay set is exported, but walking
  // it directly would not prove the painter can reach it: the id comes back
  // through `loneTreeSpriteId`, cell by cell, so a renamed sprite is a missing
  // id here rather than one nobody looked for.
  const field = loneTreeField();
  for (let ty = 0; ty < field.h; ty += 1) {
    for (let tx = 0; tx < field.w; tx += 1) {
      add(loneTreeSpriteId(field, tx, ty), `lone tree (${String(tx)},${String(ty)})`);
    }
  }
  for (const template of MONSTER_TEMPLATES) add(template.sprite, `monster ${template.id}`);
  for (const talent of registerAllTalents().all()) add(talent.iconId, `talent ${talent.id}`);
  for (const effect of MVP_EFFECTS) add(effect.icon, `effect ${effect.id}`);
  return named;
}

describe('the art the game is wired to draw passes the load filter', () => {
  it('reaches every table it reads — the control', () => {
    // A WALK THAT FOUND NOTHING PASSES BOTH CHECKS BELOW FOREVER. One id from
    // each source, and the pictures wired most recently.
    const ids = wiredIds();
    for (const id of [
      'tile_local_floor',
      'tile_local_water_floor_bubble_h',
      'tile_local_frozen_water',
      'tile_local_wall_face',
      'tile_local_door_closed_ew',
      'tile_local_door_open_ns',
      'tile_local_rock_door',
      // BOTH ENDS OF THE LONE-TREE SET: the stem proves the walk reached the
      // painter at all, and `_h` proves it reached the whole variant set rather
      // than the one variant the first cell happened to hash to.
      'tile_local_tree_single',
      'tile_local_tree_single_h',
      'enemy_index_ribbon_s',
      'enemy_index_inkwell_s',
      'enemy_index_strongbox_s',
      'icon_monster_grab',
      'icon_active_fire_bolt',
      'icon_status_suffocating',
      'icon_status_zone_aura_underwater',
    ]) {
      expect(ids.has(id), `${id} was not enumerated`).toBe(true);
    }
  });

  it('admits every one of them', () => {
    const isNeeded = mainFilter();
    const filtered = [...wiredIds()]
      .filter(([id]) => !isNeeded(id))
      .map(([id, where]) => `${id}  (${where})`);
    expect(filtered, 'filtered out before loading, so drawn as a fallback').toEqual([]);
  });
});

const MANIFEST = new URL('client/public/assets/manifest.placeholders.json', root);
const HAVE_MANIFEST = existsSync(MANIFEST);

describe('and the installed art gives each one a sprite (reads the manifest, skipped without it)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.skipIf(!HAVE_MANIFEST)('loads every one through the real loader and filter', async () => {
    const manifest = readFileSync(MANIFEST, 'utf8');
    const rows = new Set(
      (JSON.parse(manifest) as { assets: readonly { id: string }[] }).assets.map((a) => a.id),
    );
    const ids = wiredIds();
    const unlisted = [...ids]
      .filter(([id]) => !rows.has(id))
      .map(([id, where]) => `${id}  (${where})`);
    expect(unlisted, 'no manifest row: install the art, or see `npm run art:needs`').toEqual([]);

    // THE LOADER ITSELF, fed the manifest on disk: `loadAssetLibrary` is what
    // main.ts boots with, and `isNeeded` is its selector. An image "loads" the
    // moment its src is set; which ids reach the library is the question.
    vi.stubGlobal('document', { baseURI: 'https://example.test/.proxy/' });
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(manifest)) }),
    );
    vi.stubGlobal(
      'Image',
      class {
        decoding = '';
        naturalWidth = 0;
        naturalHeight = 0;
        private onLoad: (() => void) | undefined;
        addEventListener(type: string, listener: () => void): void {
          if (type === 'load') this.onLoad = listener;
        }
        set src(_url: string) {
          queueMicrotask(() => this.onLoad?.());
        }
      },
    );
    const isNeeded = mainFilter();
    const library = await loadAssetLibrary((entry: AssetEntry) => isNeeded(entry.id));
    const unloaded = [...ids]
      .filter(([id]) => library.sprite(id) === undefined)
      .map(([id, where]) => `${id}  (${where})`);
    expect(unloaded, 'in the manifest, and still no sprite from the loader').toEqual([]);
  });
});
