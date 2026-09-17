import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { reconcileInventory, scanRepository, scanSource } from '../../tools/art-needs-lib.mjs';

describe('art-needs source scanner', () => {
  it('reads syntax, not comments or semantic save ids', () => {
    const source = `
      // 'icon_active_comment_only'
      /** \`item_coat\` is prose, not a sprite. */
      const record = {
        id: 'item_draught_mending',
        itemId: 'item_second_semantic_id',
        icon: 'icon_active_alchemic_vial',
        sprite: 'chr_player_redactor_s',
      };
      const saveId = 'chr_main';
      const TOWNSFOLK_ART_REQUESTS = ['chr_npc_counter_keeper_s'] as const;
    `;

    const result = scanSource(source, 'fixture.ts');
    expect(result.runtimeIds).toEqual(['chr_player_redactor_s', 'icon_active_alchemic_vial']);
    expect(result.requestedIds).toEqual(['chr_npc_counter_keeper_s']);
    expect(result.unresolvedDynamic).toEqual([]);
  });

  it('reports an asset template whose concrete names cannot be proven', () => {
    const result = scanSource('const id = `icon_active_${slug}`;', 'dynamic.ts');
    expect(result.runtimeIds).toEqual([]);
    expect(result.unresolvedDynamic).toEqual([
      { line: 1, column: 12, expression: '`icon_active_${slug}`' },
    ]);
  });

  it('reconciles missing, replacement, duplicate, and unused files separately', () => {
    const runtime = new Map([
      ['icon_active_missing', new Set(['a.ts'])],
      ['icon_active_standin', new Set(['b.ts'])],
      ['chr_player_old_s', new Set(['c.ts'])],
    ]);
    const requests = new Map([['chr_npc_requested_s', new Set(['d.ts'])]]);
    const present = new Map([
      ['icon_active_standin', ['icons/icon_active_standin.png']],
      ['chr_player_old_s', ['characters/chr_player_old_s.png']],
      ['unused_art', ['misc/unused_art.png', 'other/unused_art.png']],
    ]);

    const result = reconcileInventory({
      runtime,
      requests,
      present,
      standIns: new Set(['icon_active_standin']),
      upscaled: new Set(['chr_player_old_s']),
    });

    expect(result.missing).toEqual(['chr_npc_requested_s', 'icon_active_missing']);
    expect(result.runtimeMissing).toEqual(['icon_active_missing']);
    expect(result.requestMissing).toEqual(['chr_npc_requested_s']);
    expect(result.placeholder).toEqual(['icon_active_standin']);
    expect(result.forTheOldCell).toEqual(['chr_player_old_s']);
    expect(result.unused).toEqual(['unused_art']);
    expect(result.duplicates).toEqual([
      { id: 'unused_art', paths: ['misc/unused_art.png', 'other/unused_art.png'] },
    ]);
  });
});

describe('the repository art inventory', () => {
  it('has no runtime-composed art families left outside the ledger', () => {
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    const result = scanRepository(repo);

    expect(result.unresolvedDynamic).toEqual([]);
    expect(result.requests.size).toBe(0);

    for (const id of [
      'chr_player_redactor_s',
      'chr_player_redactor_downed_s',
      'icon_character_the_redactor',
      'icon_sustain_caustic_load',
      'icon_sustain_frost_load',
      'icon_sustain_concussive_load',
      'ui_tile_marker_cursor',
      'ui_tile_marker_minrange',
      'ui_icon_turn_waiting',
      'ui_icon_turn_standing_by',
      'tile_ow_landmark_alderbrook',
      'tile_ow_landmark_the_weir',
      'tile_ow_landmark_redaction',
      'ui_pip_ink',
    ]) {
      expect(result.runtime.has(id), `${id} is absent from the runtime inventory`).toBe(true);
    }

    for (const falsePositive of [
      'chr_main',
      'item_draught_mending',
      'item_coat',
      'item_coat3',
      'item_watchmans_truncheon',
      'item_inspectors_revolver',
      'item_inquisitors_reckoner',
      'item_iron_sword',
      'ui_tile_marker_loot',
      'ui_tile_marker_orb',
      'ui_tile_marker_path',
    ]) {
      expect(
        result.runtime.has(falsePositive),
        `${falsePositive} is documentation or a semantic id, not runtime art`,
      ).toBe(false);
    }
  });
});
