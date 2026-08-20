#!/usr/bin/env node
/**
 * art-needs — what still has to be drawn, derived from the code.
 *
 * ============================================================================
 * WHY THIS IS COMPUTED AND NOT WRITTEN DOWN
 * ============================================================================
 * Codex draws this project's art; NEXUS keeps the list of what is still needed
 * (D16). The obvious way to keep that list is a markdown file somebody updates.
 *
 * That is the single most expensive mistake in this codebase's history. A rule
 * written out as a hand-written list, with N-1 of its entries wrong, has cost
 * six separate bugs here — and a list of missing art has exactly that shape: it
 * is right on the day it is written and silently wrong every day after, because
 * the thing it describes lives somewhere else and moves without telling anyone.
 *
 * So the list is DERIVED. Every asset id the code actually references, diffed
 * against the files that actually exist. It cannot drift, because there is
 * nothing to keep in step: add a talent with a new `iconId` and the gap appears
 * here on the next run, whether or not anybody remembered.
 *
 * ============================================================================
 * IT MUST WORK IN A BARE CLONE
 * ============================================================================
 * `client/public/assets/` is gitignored and ships only via the deploy script —
 * the art is All Rights Reserved and is not distributed with this repository
 * (ASSETS-LICENSE.md). A fresh clone therefore has NO assets at all, and this
 * tool must still run and still be useful there: with nothing on disk, every
 * referenced id is reported as needed, which is the honest answer.
 *
 * ============================================================================
 * WHAT IT CANNOT SEE, STATED SO NOBODY TRUSTS IT TOO FAR
 * ============================================================================
 * It reads STRING LITERALS. An id assembled at runtime — `icon_${slot}` — is
 * invisible to it, and the report says so rather than pretending completeness.
 * A probe that shows a slice is evidence of PRESENCE, never of ABSENCE.
 *
 * Usage:
 *   node tools/art-needs.mjs            # human-readable report
 *   node tools/art-needs.mjs --json     # machine-readable, for a hand-off
 *   node tools/art-needs.mjs --missing  # just the ids, one per line
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ASSETS = join(REPO, 'client', 'public', 'assets');
const SOURCE_DIRS = ['src', 'content'];

/**
 * THE PREFIXES THAT NAME ART, and this list IS the contract.
 *
 * Derived from the manifest's own ids rather than invented: every asset in
 * `manifest.placeholders.json` starts with one of these, so a new prefix means
 * somebody introduced a category and this line is where they say so.
 */
const PREFIXES = [
  'icon',
  'enemy',
  'tile',
  'ui',
  'npc',
  'item',
  'player',
  'prop',
  'char',
  'branding',
  'innerdatum',
  'favicon',
];

const ID_RX = new RegExp(`['"\`]((?:${PREFIXES.join('|')})_[a-z0-9_]+)['"\`]`, 'gi');
/** An id being BUILT rather than written. Reported, never resolved. */
const DYNAMIC_RX = new RegExp(`['"\`](?:${PREFIXES.join('|')})_[a-z0-9_]*\\$\\{`, 'g');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|json)$/.test(entry)) out.push(full);
  }
  return out;
}

// ── what the code asks for ───────────────────────────────────────────────────
const referenced = new Map(); // id -> Set<file>
const dynamic = [];
for (const dir of SOURCE_DIRS) {
  for (const file of walk(join(REPO, dir))) {
    const text = readFileSync(file, 'utf8');
    const where = relative(REPO, file).replace(/\\/g, '/');
    for (const m of text.matchAll(ID_RX)) {
      const id = m[1];
      /**
       * A TRAILING UNDERSCORE IS A PREFIX, NOT AN ID. The client builds hotbar
       * and status ids by concatenation — "icon_active_" plus the talent name —
       * so the literal in the source is half of a name. Counting those as
       * missing art reported four gaps that can never be filled, because no file
       * could ever be called "icon_active_". They are recorded as construction
       * sites instead, which is the honest bucket: this tool cannot see what
       * they resolve to.
       */
      if (id.endsWith('_')) {
        dynamic.push(where);
        continue;
      }
      if (!referenced.has(id)) referenced.set(id, new Set());
      referenced.get(id).add(where);
    }
    if (DYNAMIC_RX.test(text)) dynamic.push(where);
    DYNAMIC_RX.lastIndex = 0;
  }
}

// ── what is actually on disk ─────────────────────────────────────────────────
const present = new Map(); // id -> relative path
function collect(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full);
    else if (/\.(png|webp|jpg|jpeg|gif|svg)$/i.test(entry)) {
      present.set(basename(entry, extname(entry)), relative(ASSETS, full).replace(/\\/g, '/'));
    }
  }
}
collect(ASSETS);

// Provenance, when the manifest is here. A stand-in is PRESENT but replaceable.
const standIns = new Set();
const manifestPath = join(ASSETS, 'manifest.placeholders.json');
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const a of manifest.assets ?? []) {
      if (a.provenance === 'stand-in') standIns.add(a.id);
    }
  } catch {
    /* a manifest we cannot read is the same as no manifest */
  }
}

const missing = [...referenced.keys()].filter((id) => !present.has(id)).sort();
const placeholder = [...referenced.keys()].filter((id) => standIns.has(id)).sort();
const unused = [...present.keys()].filter((id) => !referenced.has(id)).sort();

const byCategory = (ids) => {
  const out = new Map();
  for (const id of ids) {
    const key = id.split('_')[0];
    out.set(key, [...(out.get(key) ?? []), id]);
  }
  return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
};

// ── report ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        generated: 'derived from source; do not hand-edit',
        referenced: referenced.size,
        onDisk: present.size,
        missing,
        placeholder,
        unused,
        dynamicIdFiles: [...new Set(dynamic)],
      },
      null,
      2,
    ),
  );
} else if (argv.includes('--missing')) {
  for (const id of missing) console.log(id);
} else {
  const bare = present.size === 0;
  console.log('ART NEEDS — derived from the code, never hand-maintained (D16)');
  console.log('='.repeat(64));
  console.log(`  asset ids referenced in source : ${String(referenced.size)}`);
  console.log(
    `  files present on disk          : ${String(present.size)}${bare ? '   (bare clone — art is gitignored and ships via deploy)' : ''}`,
  );
  console.log(`  STILL NEEDED                   : ${String(missing.length)}`);
  if (!bare) console.log(`  present but a stand-in         : ${String(placeholder.length)}`);
  console.log(`  on disk, referenced by nothing : ${String(unused.length)}`);
  console.log();

  if (missing.length > 0) {
    console.log('STILL NEEDED, by category');
    console.log('-'.repeat(64));
    for (const [cat, ids] of byCategory(missing)) {
      console.log(`  ${cat}  (${String(ids.length)})`);
      for (const id of ids) {
        const [first] = [...(referenced.get(id) ?? [])];
        console.log(`      ${id.padEnd(38)} ${first ?? ''}`);
      }
      console.log();
    }
  }

  if (placeholder.length > 0) {
    console.log(`STAND-INS awaiting real art (${String(placeholder.length)})`);
    console.log('-'.repeat(64));
    console.log('  Correct size, correct name, correct palette. Replacing one is a');
    console.log('  file overwrite — no code, manifest or pipeline change.');
    console.log(`  ${placeholder.slice(0, 12).join(', ')}${placeholder.length > 12 ? ', …' : ''}`);
    console.log();
  }

  if (unused.length > 0) {
    console.log(`ON DISK BUT REFERENCED BY NOTHING (${String(unused.length)})`);
    console.log('-'.repeat(64));
    console.log('  Not necessarily waste — art often lands before the code that uses');
    console.log('  it. Worth a look if one has been sitting here for a while.');
    console.log(`  ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ', …' : ''}`);
    console.log();
  }

  if (dynamic.length > 0) {
    console.log('WHAT THIS TOOL CANNOT SEE');
    console.log('-'.repeat(64));
    console.log('  These files build an asset id at runtime, so its gaps are invisible');
    console.log('  here. A slice is evidence of presence, never of absence.');
    for (const f of [...new Set(dynamic)]) console.log(`      ${f}`);
    console.log();
  }
}
