#!/usr/bin/env node
/**
 * Derive Inner Datum's art backlog from source syntax and the deployed files.
 *
 * Usage:
 *   node tools/art-needs.mjs
 *   node tools/art-needs.mjs --json
 *   node tools/art-needs.mjs --missing
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectAssetFiles,
  loadFilterPrefixes,
  reconcileInventory,
  scanRepository,
  unloadedIds,
} from './art-needs-lib.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ASSETS = join(REPO, 'client', 'public', 'assets');
const MANIFEST = join(ASSETS, 'manifest.placeholders.json');
const CLIENT_ENTRY = join(REPO, 'src', 'client', 'main.ts');

const scan = scanRepository(REPO);
const present = collectAssetFiles(ASSETS);

// The client's load filter. An id no prefix admits is never fetched, so it is
// missing on screen whether or not its file is on disk (see `loadFilterPrefixes`).
const loadFilter = existsSync(CLIENT_ENTRY)
  ? loadFilterPrefixes(readFileSync(CLIENT_ENTRY, 'utf8'), 'src/client/main.ts')
  : null;
if (loadFilter === null) {
  console.error(
    'art-needs: NEEDED_ASSET_PREFIXES not found in src/client/main.ts; load check skipped',
  );
}
const unloaded = loadFilter === null ? [] : unloadedIds(scan.runtime, loadFilter);

function provenanceSets() {
  const standIns = new Set();
  const upscaled = new Set();
  if (!existsSync(MANIFEST)) return { standIns, upscaled };
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    for (const asset of parsed.assets ?? []) {
      if (asset.provenance === 'stand-in') standIns.add(asset.id);
      if (asset.provenance === 'upscaled') upscaled.add(asset.id);
    }
  } catch {
    // A missing or unreadable deploy manifest is equivalent to a bare clone.
  }
  return { standIns, upscaled };
}

const provenance = provenanceSets();
const inventory = reconcileInventory({
  runtime: scan.runtime,
  requests: scan.requests,
  present,
  ...provenance,
});

function locationsFor(id) {
  return [...new Set([...(scan.runtime.get(id) ?? []), ...(scan.requests.get(id) ?? [])])].sort();
}

function sourceWindowFor(id, files) {
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(REPO, rel), 'utf8');
    } catch {
      continue;
    }
    const needles = [`'${id}'`, `"${id}"`, `\`${id}\``];
    const at = needles.map((needle) => text.indexOf(needle)).find((index) => index >= 0) ?? -1;
    if (at < 0) continue;

    const blockStart = text.lastIndexOf('export const ', at);
    const declaresTalent =
      blockStart >= 0 && /^export const \w+: Talent = \{/.test(text.slice(blockStart, at));
    const blockEnd = declaresTalent ? text.indexOf('\n};', at) : -1;
    return declaresTalent
      ? text.slice(blockStart, blockEnd < 0 ? text.length : blockEnd)
      : text.slice(Math.max(0, at - 700), at + 900);
  }
  return '';
}

function titleFromId(id) {
  return id
    .replace(
      /^(?:chr_(?:player|npc)|enemy|favicon|icon_(?:active|passive|sustain|monster|status|character)|icon|innerdatum|item|prop|tile_(?:ow|local)|tile|ui)_/,
      '',
    )
    .split('_')
    .map((word) => (word === '' ? '' : `${word[0].toUpperCase()}${word.slice(1)}`))
    .join(' ');
}

function briefFor(id) {
  const files = locationsFor(id);
  const window = sourceWindowFor(id, files);
  const name =
    /displayName:\s*'([^']+)'/.exec(window)?.[1] ??
    /\bname:\s*'([^']+)'/.exec(window)?.[1] ??
    titleFromId(id);
  const raw =
    /description:\s*'([^']+)'/.exec(window)?.[1] ??
    /describe:[\s\S]{0,240}?`([\s\S]{12,240}?)`/.exec(window)?.[1];
  const description = raw
    ?.replace(/\$\{[^}]*\}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id,
    kind: kindOf(id),
    name,
    ...(description === undefined ? {} : { description }),
    demand:
      scan.runtime.has(id) && scan.requests.has(id)
        ? 'runtime and explicit request'
        : scan.runtime.has(id)
          ? 'runtime'
          : 'explicit request',
    referencedBy: files,
  };
}

function kindOf(id) {
  if (id.startsWith('chr_player_')) return 'player sprite';
  if (id.startsWith('chr_npc_')) return 'townsfolk sprite';
  if (id.startsWith('enemy_')) return 'enemy sprite';
  if (id.startsWith('icon_active_')) return 'talent icon (active)';
  if (id.startsWith('icon_passive_')) return 'talent icon (passive)';
  if (id.startsWith('icon_sustain_')) return 'talent icon (sustain)';
  if (id.startsWith('icon_monster_')) return 'talent icon (monster)';
  if (id.startsWith('icon_status_')) return 'status icon';
  if (id.startsWith('icon_character_')) return 'character portrait';
  if (id.startsWith('icon_')) return 'UI icon';
  if (id.startsWith('tile_local_')) return 'local material tile';
  if (id.startsWith('tile_ow_')) return 'overworld tile';
  if (id.startsWith('tile_')) return 'terrain tile';
  if (id.startsWith('item_')) return 'item sprite';
  if (id.startsWith('prop_')) return 'prop sprite';
  if (id.startsWith('innerdatum_') || id.startsWith('favicon_')) return 'branding';
  return 'asset';
}

const missingBriefs = inventory.missing.map(briefFor);
const requestedPresent = inventory.requestPresent.map(briefFor);
const demandedCount = new Set([...inventory.runtimeIds, ...inventory.requestIds]).size;
const fileCount = [...present.values()].reduce((total, paths) => total + paths.length, 0);

const report = {
  generated: 'derived from TypeScript syntax and deployed files; do not hand-edit',
  runtimeReferenced: inventory.runtimeIds.length,
  explicitRequests: inventory.requestIds.length,
  demanded: demandedCount,
  onDiskIds: present.size,
  onDiskFiles: fileCount,
  missing: missingBriefs,
  runtimeMissing: inventory.runtimeMissing,
  explicitRequestMissing: inventory.requestMissing,
  explicitRequestPresentButUnwired: requestedPresent,
  placeholder: inventory.placeholder,
  forTheOldCell: inventory.forTheOldCell,
  unused: inventory.unused,
  duplicates: inventory.duplicates,
  unresolvedDynamic: scan.unresolvedDynamic,
  filteredBeforeLoading: unloaded,
};

const argv = process.argv.slice(2);
if (argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (argv.includes('--missing')) {
  for (const id of [...new Set([...inventory.missing, ...unloaded])].sort()) console.log(id);
} else {
  const bare = fileCount === 0;
  console.log('ART NEEDS — source-derived, context-aware inventory');
  console.log('='.repeat(68));
  console.log(`  runtime asset ids             : ${String(report.runtimeReferenced)}`);
  console.log(`  explicit unwired requests     : ${String(report.explicitRequests)}`);
  console.log(`  total demanded ids            : ${String(report.demanded)}`);
  console.log(
    `  files present                 : ${String(report.onDiskFiles)}${bare ? '  (bare clone)' : ''}`,
  );
  console.log(`  missing art                   : ${String(report.missing.length)}`);
  console.log(`  filtered out before loading   : ${String(unloaded.length)}`);
  if (!bare) console.log(`  active stand-ins              : ${String(report.placeholder.length)}`);
  if (!bare)
    console.log(`  active old-cell remasters     : ${String(report.forTheOldCell.length)}`);
  console.log(`  duplicate asset ids           : ${String(report.duplicates.length)}`);
  console.log(`  unresolved dynamic art ids    : ${String(report.unresolvedDynamic.length)}`);

  if (missingBriefs.length > 0) {
    console.log('\nSTILL NEEDED');
    console.log('-'.repeat(68));
    const grouped = Map.groupBy(missingBriefs, (item) => item.kind);
    for (const [kind, items] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${kind} (${String(items.length)})`);
      for (const item of items) {
        console.log(`    ${item.id} — ${item.name}`);
        console.log(`      ${item.demand}; ${item.referencedBy[0] ?? 'unknown source'}`);
      }
    }
  }

  if (unloaded.length > 0) {
    console.log('\nNAMED BY SOURCE, FILTERED OUT BEFORE LOADING (NEEDED_ASSET_PREFIXES)');
    console.log('-'.repeat(68));
    for (const id of unloaded) {
      console.log(`  ${id}${present.has(id) ? '  (on disk)' : ''}; ${locationsFor(id)[0] ?? ''}`);
    }
  }

  if (requestedPresent.length > 0) {
    console.log('\nART PRESENT, WIRING STILL REQUESTED');
    console.log('-'.repeat(68));
    for (const item of requestedPresent) console.log(`  ${item.id}`);
  }

  if (report.unresolvedDynamic.length > 0) {
    console.log('\nUNRESOLVED DYNAMIC ART IDS');
    console.log('-'.repeat(68));
    for (const item of report.unresolvedDynamic) {
      console.log(`  ${item.file}:${String(item.line)}  ${item.expression}`);
    }
  }

  if (report.duplicates.length > 0) {
    console.log('\nDUPLICATE ASSET IDS');
    console.log('-'.repeat(68));
    for (const item of report.duplicates) console.log(`  ${item.id}: ${item.paths.join(', ')}`);
  }
}
