// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// THE WHOLE CURVE, IN ONE COMMAND.  `node tools/career.mjs`
// ═══════════════════════════════════════════════════════════════════════════
//
// `first-session.mjs` drives the first six seconds. This prints the other ten
// levels: what drops, what the shelves hold, how many rooms are left, and how
// many kills stand between here and the cap.
//
// ═══ IT EXISTS BECAUSE THE NUMBERS ARE SPREAD ACROSS FIVE FILES ═══
// `expChart` and `worthExp` are in shared/progression.ts, `bandFor` in
// content/loot.ts, `epochFor` and `restock` in content/shops.ts, `dangerWord`
// in content/delve.ts, the fileable set in world/casefile.ts. Every one of them
// is individually tested and NONE of those tests can see the shape of a career.
// Two constants ported verbatim from ToME — `ceil(level / 10)` for loot bands
// and `1 + floor(level / 10)` for restocks — were both silently collapsed by
// this game's level cap of 10, and neither was visible from inside its own
// file. They are visible here in four lines of output.
//
// A READING, NOT A TEST. It asserts nothing and fails nothing; `npm run check`
// is the gate. This is for a human deciding whether the curve feels like a game.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.

import { bandFor, rollQuality } from '../src/server/content/loot.ts';
import {
  NB_FILL,
  ShopShelf,
  buyPrice,
  epochFor,
  restock,
  stockLevelFor,
} from '../src/server/content/shops.ts';
import { MAX_CHARACTER_LEVEL, expChart, worthExp } from '../src/shared/progression.ts';
import { createRng } from '../src/shared/rng.ts';
import { dangerWord, partyHint, specFor } from '../src/server/content/delve.ts';
import { SITES } from '../src/server/world/realms.ts';
import { fileableCount, isFileable } from '../src/server/world/casefile.ts';

const SAMPLES = 4000;

// ─── the curve ─────────────────────────────────────────────────────────────
console.log('──── THE CURVE A CHARACTER WALKS');
console.log('');
console.log('lvl   xp to next   loot band   shop epoch   two-ego drops   what changed');
let lastBand = null;
let lastEpoch = null;
for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
  const band = bandFor(level);
  const epoch = epochFor(level);
  const rng = createRng(`career:${level}`);
  let two = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    if (rollQuality(rng, band) === 'double_ego') two += 1;
  }
  const changed =
    lastBand === null
      ? '(start)'
      : [
          band !== lastBand ? 'loot got better' : null,
          epoch !== lastEpoch ? 'shops restocked' : null,
        ]
          .filter(Boolean)
          .join(' + ') || '—';
  const next = level < MAX_CHARACTER_LEVEL ? String(expChart(level + 1)) : 'top level';
  console.log(
    ` ${String(level).padStart(2)}   ${next.padStart(10)}   ${String(band).padStart(9)}   ${String(epoch).padStart(10)}   ${(String(Math.round((100 * two) / SAMPLES)) + '%').padStart(13)}   ${changed}`,
  );
  lastBand = band;
  lastEpoch = epoch;
}

// ─── the shelves ───────────────────────────────────────────────────────────
//
// `NB_FILL * (epoch + 1)` IS THE TARGET, not `NB_FILL`. world/shopstate.ts
// passes it, so a shelf GROWS as the epochs pass and stock accumulates
// (`empty_before_restock = false` on every shop in basic.lua). Reading this
// with the default target instead showed a flat four forever and looked
// exactly like a shop that never restocks.
console.log('');
console.log('──── WHAT A SHELF HOLDS, IF NOBODY BUYS ANYTHING');
console.log('');
let keep = [];
let epoch = -1;
const sizes = [];
for (let level = 1; level <= MAX_CHARACTER_LEVEL; level += 1) {
  const target = epochFor(level);
  while (epoch < target) {
    epoch += 1;
    keep = restock(
      createRng(`shop:outfitter:${epoch}`),
      keep,
      stockLevelFor(level),
      NB_FILL * (epoch + 1),
      ShopShelf.Outfitter,
    );
  }
  sizes.push(`${String(level)}:${String(keep.length)}`);
}
console.log(`  items on the shelf at each level   ${sizes.join('  ')}`);
console.log('');
console.log('  a sample of the level-10 shelf:');
for (const id of keep.slice(0, 6)) {
  console.log(`    ${String(id).slice(0, 58).padEnd(58)} ${String(buyPrice(id, 10)).padStart(4)}g`);
}
// SHOP QUALITY IS FLAT ACROSS BANDS AND THAT IS FAITHFUL, not an oversight:
// `SHOP_EGO_CHANCE` cites GameState.lua:1165-1221, where every store tier sets
// `basic = 0`. The curve lives on the FLOOR; a shop is a targeted service.
console.log('');
console.log('  (shelf QUALITY is deliberately flat across bands — see SHOP_EGO_CHANCE)');

// ─── the case file ─────────────────────────────────────────────────────────
console.log('');
console.log('──── THE CASE FILE');
console.log('');
const byGrade = {};
for (const [id, def] of SITES) {
  if (!isFileable(def)) continue;
  const spec = specFor(id);
  if (spec === undefined) continue;
  (byGrade[dangerWord(spec)] ??= []).push(id.replace('site:', ''));
}
console.log(`  ${String(fileableCount(SITES))} rooms to close:`);
for (const grade of ['quiet', 'restless', 'dangerous', 'grim']) {
  const list = byGrade[grade] ?? [];
  const hint = list.length > 0 ? (partyHint(specFor(`site:${list[0]}`)) ?? '') : '';
  console.log(
    `    ${grade.padEnd(10)} ${String(list.length).padStart(2)}${hint ? ' · ' + hint : ''}`,
  );
  for (const name of list) console.log(`               ${name}`);
}

// ─── the grind ─────────────────────────────────────────────────────────────
console.log('');
console.log('──── KILLS TO THE CAP, SOLO');
console.log('');
let total = 0;
for (let level = 1; level < MAX_CHARACTER_LEVEL; level += 1) {
  total += Math.ceil(expChart(level + 1) / worthExp(level, 'normal'));
}
console.log(
  `  ${String(total)} ordinary kills, against ${String(fileableCount(SITES))} rooms holding five to sixteen each.`,
);
console.log('  A party earns a FULL share each, so three friends walk it in a third of the time.');
