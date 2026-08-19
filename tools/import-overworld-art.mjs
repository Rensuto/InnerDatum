/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REDESIGNED MOOR'S ART, INSTALLED INTO THE SPRITE FOLDER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase one shipped the LAYOUT through `runtime-fallback.json`, deliberately
 * leaving the art alone so the renderer, legend and protocol never moved. This
 * is the other half, and it needs no code change either — because two things
 * were already true and only had to be noticed:
 *
 *   THE MANIFEST IS A FILE INDEX. `build_asset_manifest.py` says it outright:
 *     swapping art in later "is a file overwrite -- no code, manifest or
 *     pipeline change". Fifteen of the incoming assets carry this repo's own
 *     tile semantics and are simply better versions of them.
 *
 *   THE RENDERER ALREADY PICKS VARIANTS. `TILE_SPRITES` maps a TileCode to an
 *     ARRAY and canvas.ts chooses with a positional hash — `ids[((tx * 73) ^
 *     (ty * 151)) % ids.length]`. Every code has been carrying a one-element
 *     array, so a forest has been one tile repeated. The handoff ships thirteen
 *     forests, seven mountains, seven hill faces and five field patterns.
 *
 * ART NEVER REACHES GIT. `client/public/assets/` is gitignored wholesale and
 * ships through the deploy script, which is why a deploy reports its sprite
 * count. This writes there and nowhere else; `npm run check`'s `check:assets`
 * is what proves it stayed out.
 *
 * NO SITE LAYERS ARE TOUCHED. The handoff is explicit that `sites_author_*` must
 * not ship — hidden site visibility is a server projection and those rasters
 * contain Cairnfoot, Barrow End and Weir markers. This installs terrain only.
 *
 * Usage:  node tools/import-overworld-art.mjs           # report only
 *         node tools/import-overworld-art.mjs --write   # install
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(
  new URL(
    '../../terrain-art-production/handoff/alderbrook-overworld-redesign/runtime-import-32/',
    import.meta.url,
  ),
);
const TILES = fileURLToPath(new URL('../client/public/assets/tiles/', import.meta.url));
const CANVAS = fileURLToPath(new URL('../src/client/render/canvas.ts', import.meta.url));

/**
 * How many variants a single semantic is worth.
 *
 * Six, not thirteen. The positional hash spreads them evenly, and past about
 * half a dozen a player cannot tell the difference between "varied" and "more
 * varied" — while every file is bytes in the deploy package and a frame of
 * decode at boot. Six is enough that a diagonal run of forest never repeats
 * inside a screen.
 */
const MAX_VARIANTS = 6;

/**
 * The incoming families that map onto a TileCode THIS BUILD ALREADY DRAWS.
 *
 * `charred_scar`, `frozen_sea` and `cold_forest` are deliberately absent: they
 * are the distinctions the compatibility layout cannot express, because there
 * is no code for snowfield-versus-plains or cold-forest-versus-trees. Importing
 * their art without a code to draw it under would put files on the host that
 * nothing can reach — the same dead-asset shape the deepwater sprite was in.
 */
const FAMILIES = [
  { stem: 'tile_ow_trees', from: ['forest', 'old_forest'] },
  // `daikara_mountain_wall1..6` are the mountain FACES — the same family with a
  // suffix my first pass missed, which is why this asked for two variants of a
  // range that ships seven.
  { stem: 'tile_ow_mountain', from: ['mountain', 'daikara_mountain', 'daikara_mountain_wall'] },
  { stem: 'tile_ow_hills', from: ['low_hills'] },
  { stem: 'tile_ow_field', from: ['cultivation'] },
];

const SUFFIX = 'bcdefghijk';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRANSPORT OVERLAYS — road, rail and bridge, drawn ON TOP of the ground.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED: these are ~70% transparent with BINARY alpha (zero soft pixels), so
 * they composite over the terrain tile rather than replacing it. The handoff
 * warns that transport art MAY use intentional soft alpha and to blend
 * source-over rather than enforce a binary validator — this set happens not to,
 * and the renderer blends source-over regardless.
 *
 * Named for what they ARE rather than for the family they came from, because
 * `canvas.ts` indexes them by a connection mask and a reader of that table
 * should not have to know the word "topology".
 */
const TRANSPORT = [
  ['roads_paving_road_cross', 'tile_ow_road_cross'],
  ['roads_paving_road_horizontal', 'tile_ow_road_horizontal'],
  ['roads_paving_road_vertical', 'tile_ow_road_vertical'],
  ['roads_paving_road_n', 'tile_ow_road_n'],
  ['roads_paving_road_ne', 'tile_ow_road_ne'],
  ['roads_paving_road_nw', 'tile_ow_road_nw'],
  ['roads_paving_road_se', 'tile_ow_road_se'],
  ['roads_paving_road_sw', 'tile_ow_road_sw'],
  ['roads_paving_road_t_n', 'tile_ow_road_t_n'],
  ['roads_paving_road_t_e', 'tile_ow_road_t_e'],
  ['roads_paving_road_t_s', 'tile_ow_road_t_s'],
  ['roads_paving_road_t_w', 'tile_ow_road_t_w'],
  ['rails_road_horizontal', 'tile_ow_rail_horizontal'],
  ['rails_road_vertical', 'tile_ow_rail_vertical'],
  ['rails_road_n', 'tile_ow_rail_n'],
  ['rails_road_s', 'tile_ow_rail_s'],
  ['rails_road_ne', 'tile_ow_rail_ne'],
  ['rails_road_sw', 'tile_ow_rail_sw'],
  ['bridges_horizontal', 'tile_ow_bridge_horizontal'],
  ['bridges_vertical', 'tile_ow_bridge_vertical'],
];

function incoming() {
  if (!existsSync(SRC)) throw new Error(`no art at ${SRC}`);
  return readdirSync(SRC).filter((f) => f.endsWith('.png'));
}

const files = incoming();

// ── 1. THE FIFTEEN THAT ARE THIS REPO'S OWN TILES, ONLY BETTER ─────────────
const upgrades = [];
for (const f of files) {
  if (!f.startsWith('base_inner_datum_tile_ow_')) continue;
  const stem = f.replace('base_inner_datum_', '');
  const dest = `${TILES}${stem}`;
  if (!existsSync(dest)) continue;
  const was = statSync(dest).size;
  const now = statSync(`${SRC}${f}`).size;
  upgrades.push({ from: f, to: stem, was, now });
}

// ── 2. VARIANTS FOR THE FAMILIES ALREADY ON THE MAP ────────────────────────
const variants = [];
for (const family of FAMILIES) {
  const pool = [];
  for (const name of family.from) {
    // `forest1.png`, `forest2.png` … and the bare `forest.png`. The numbered
    // ones are the variants; anything with `_patch` is a decal, not a tile.
    const rx = new RegExp(`^base_tome_wilderness_${name}\\d*\\.png$`);
    for (const f of files) if (rx.test(f)) pool.push(f);
  }
  pool.sort();
  let n = 0;
  for (const f of pool) {
    if (n >= MAX_VARIANTS) break;
    // The base stem keeps its own art from step 1 or from before; variants take
    // the `_b`, `_c` … suffix this folder already uses (`tile_ow_cobble_b`).
    const suffix = SUFFIX[n];
    if (suffix === undefined) break;
    variants.push({ from: f, to: `${family.stem}_${suffix}.png`, stem: family.stem });
    n += 1;
  }
}

const transport = [];
for (const [from, to] of TRANSPORT) {
  // NO `base_tome_wilderness_` PREFIX on these — the transport art is named
  // `transport_topology_*` outright, unlike the terrain families. Guessed wrong
  // twice; read one filename instead.
  const name = `transport_topology_${from}.png`;
  if (!files.includes(name)) throw new Error(`the handoff has no ${name}`);
  transport.push({ from: name, to: `${to}.png` });
}

console.log(`incoming assets: ${String(files.length)}`);
console.log(`  ${String(upgrades.length)} replace this repo's own tiles with richer versions`);
for (const u of upgrades.slice(0, 4)) {
  console.log(`      ${u.to.padEnd(24)} ${String(u.was)} -> ${String(u.now)} bytes`);
}
console.log(`  ${String(variants.length)} install as variants the renderer can already pick from`);
console.log(`  ${String(transport.length)} transport overlays (road, rail, bridge) by connection`);
for (const family of FAMILIES) {
  const mine = variants.filter((v) => v.stem === family.stem);
  console.log(`      ${family.stem.padEnd(20)} ${String(mine.length)} variants`);
}

if (process.argv.includes('--write')) {
  for (const u of upgrades) copyFileSync(`${SRC}${u.from}`, `${TILES}${u.to}`);
  for (const v of variants) copyFileSync(`${SRC}${v.from}`, `${TILES}${v.to}`);
  for (const t of transport) copyFileSync(`${SRC}${t.from}`, `${TILES}${t.to}`);
  console.log(
    `  installed ${String(upgrades.length + variants.length + transport.length)} files into client/public/assets/tiles/`,
  );
  console.log('  now re-run: python tools/build_asset_manifest.py');

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * EVERY TILE INSTALLED IS DRAWN, AND EVERY TILE DRAWN IS INSTALLED.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Checked here rather than in a test, because `client/public/assets/` is
   * gitignored and CI has no art to look at — a test would pass by finding
   * nothing.
   *
   * Both halves matter and neither is loud on its own. A file nobody draws is
   * bytes in every deploy for a picture no player sees; a name nothing installs
   * is a hole in the map the first time the positional hash lands on it. This
   * pass installed five field variants and the table listed four, which is the
   * first kind — caught immediately, and only because both directions are asked.
   */
  const drawn = new Set(
    [...readFileSync(CANVAS, 'utf8').matchAll(/'(tile_ow_[a-z_]+)'/g)].map((m) => m[1]),
  );
  const onDisk = new Set(
    readdirSync(TILES)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -4)),
  );
  const dead = [...onDisk].filter((f) => !drawn.has(f));
  const holes = [...drawn].filter((f) => !onDisk.has(f));
  if (dead.length > 0) console.log(`  WARN installed and never drawn: ${dead.join(', ')}`);
  if (holes.length > 0) console.log(`  WARN drawn and not installed: ${holes.join(', ')}`);
  if (dead.length === 0 && holes.length === 0) {
    console.log('  ok   every installed tile is drawn, and every drawn tile is installed');
  }
}
