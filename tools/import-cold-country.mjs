// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// THE COLD NORTH AND THE BURNT SCAR, PUT BACK ON THE MAP.
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/import-cold-country.mjs           # report only
//   node tools/import-cold-country.mjs --write   # patch src/shared/level.ts
//
// The redesign's own cell table authors 1,107 cells of terrain this build had
// no TileCode for. `import-overworld-v2.mjs` resolved every one of them to the
// nearest thing that already existed:
//
//     frozen_water 425 -> WATER      cold_forest 257 -> TREES
//     charred      234 -> HEATH      snowfield   191 -> PLAINS (9 -> COBBLE)
//
// That was the right call at the time — it is what let the whole redesigned
// world ship without touching the renderer, the legend or the protocol — but it
// meant a frozen sea drew as canal and a burnt county drew as moorland. The
// country was on the map and invisible.
//
// ═══ IT IS A REPAINT, NOT A REDESIGN, AND THAT IS CHECKED HERE ═══
// Every new code is walkable exactly where its fallback was, so no route opens
// and none closes. This tool refuses to touch a cell whose current glyph is not
// the fallback it expects, which is what makes that claim testable rather than
// hopeful: if the rows and the cell table have drifted, it reports the drift and
// writes nothing.
//
// `cold_mountain` is deliberately absent. The handoff draws it with the same
// Daikara art as an ordinary mountain, so a second code would be a distinction
// with no picture behind it.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CELLS = fileURLToPath(
  new URL(
    '../../terrain-art-production/handoff/alderbrook-overworld-redesign/cells.csv',
    import.meta.url,
  ),
);
const LEVEL = fileURLToPath(new URL('../src/shared/level.ts', import.meta.url));

/** terrain -> [new glyph, the glyphs the compatibility import is allowed to have left]. */
const REPAINT = {
  snowfield: ['n', ['p', '.']],
  frozen_water: ['i', ['w']],
  cold_forest: ['f', ['T']],
  charred: ['a', ['e']],
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CELLS THE IMPORTER DELIBERATELY CLOSED, WHICH THIS MUST NOT RE-OPEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `import-overworld-v2.mjs` seals ground the flood fill cannot reach, so a
 * pocket of walkable terrain with no way into it becomes solid rather than a
 * place a player can see and never stand in. Measured here: nine `snowfield`
 * cells along the top edge (42..46, rows 2-3) are `T` for exactly that reason.
 *
 * Painting them back to snowfield would make them walkable again and re-open
 * the pocket — which is the one thing this whole repaint promises not to do. So
 * a sealed cell is SKIPPED, counted, and reported; it is not drift and it is not
 * an error.
 */
const SEALED = new Set(['T', 'M', 'c', 'X', 'W']);

// ── the rows, exactly as level.ts holds them ───────────────────────────────
const source = readFileSync(LEVEL, 'utf8');
const START = 'const ALDERBROOK_ROWS: readonly string[] = [';
const head = source.indexOf(START);
if (head < 0) throw new Error('ALDERBROOK_ROWS not found');
const tail = source.indexOf('];', head);
const block = source.slice(head, tail);
const rows = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]).map((r) => [...r]);
console.log(`rows: ${String(rows.length)} x ${String(rows[0].length)}`);

// ── the cell table ─────────────────────────────────────────────────────────
const csv = readFileSync(CELLS, 'utf8').split('\n');
const header = csv[0].split(',');
const iX = header.indexOf('x');
const iY = header.indexOf('y');
const iT = header.indexOf('terrain');

const painted = {};
const refused = {};
const sealed = {};
for (const key of Object.keys(REPAINT)) {
  painted[key] = 0;
  refused[key] = [];
  sealed[key] = 0;
}

for (let line = 1; line < csv.length; line += 1) {
  const row = csv[line].split(',');
  if (row.length <= iT) continue;
  const terrain = row[iT];
  const rule = REPAINT[terrain];
  if (rule === undefined) continue;
  const [glyph, allowed] = rule;
  const x = Number(row[iX]);
  const y = Number(row[iY]);
  const current = rows[y]?.[x];
  if (current === undefined) continue;
  // ALREADY DONE is not a refusal — re-running this must be a no-op.
  if (current === glyph) {
    painted[terrain] += 1;
    continue;
  }
  if (!allowed.includes(current)) {
    // Sealed by the importer's flood fill — leave it solid. See `SEALED`.
    if (SEALED.has(current) && !allowed.includes(current)) {
      sealed[terrain] += 1;
      continue;
    }
    // A SITE LETTER, A ROAD, OR REAL DRIFT. Never overwritten: the site glyphs
    // carry a `site:` binding and losing one deletes a town from the world.
    refused[terrain].push(`${String(x)},${String(y)}=${current}`);
    continue;
  }
  rows[y][x] = glyph;
  painted[terrain] += 1;
}

let bad = 0;
for (const [terrain, [glyph]] of Object.entries(REPAINT)) {
  const missed = refused[terrain];
  bad += missed.length;
  console.log(
    `  ${terrain.padEnd(14)} -> '${glyph}'  ${String(painted[terrain])} painted` +
      (sealed[terrain] > 0 ? `, ${String(sealed[terrain])} left sealed` : '') +
      (missed.length > 0
        ? `, ${String(missed.length)} REFUSED: ${missed.slice(0, 6).join(' ')}`
        : ''),
  );
}
if (bad > 0) {
  console.log('\nrefused cells are drift between the rows and the cell table — writing nothing');
  process.exit(1);
}

if (process.argv.includes('--write')) {
  const rebuilt = rows.map((r) => `  '${r.join('')}',`).join('\n');
  writeFileSync(
    LEVEL,
    `${source.slice(0, head)}${START}\n${rebuilt}\n${source.slice(tail)}`,
    'utf8',
  );
  console.log('\nwritten. now: npm run check');
} else {
  console.log('\n(report only — pass --write)');
}
