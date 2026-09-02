#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INSTALL THE 64-PIXEL TERRAIN, WHICH WAS ALREADY DRAWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TILE_PX` is 64 now — upstream's own default (`tome/class/Game.lua:565-567`
 * falls back to `tw, th = 64, 64`) and the size the orthographic art for this
 * port has been authored at all along. The shipped tileset was the 32-pixel
 * export of the same families, so every cell was a whole-number double: chunky
 * rather than blurred, and half the picture that exists on disk.
 *
 * All 115 of them have a 64-pixel twin already rendered. This installs them.
 *
 * ═══ THE TABLE IS BYTE-DERIVED, NOT GUESSED ═══
 * Each row was found by hashing the shipped 32-pixel file and locating the
 * identical bytes under `terrain-art-production/`, then swapping `-32` for
 * `-64` in that path. 91 of the 115 resolved that way exactly. The remaining 24
 * are `inner-datum-32` names whose shipped copy had been re-exported since, so
 * the bytes no longer matched — for those the NAME is the mapping, and it is
 * unambiguous because `inner-datum-64` carries the same 39 filenames.
 *
 * Writing the table down rather than re-deriving it at run time is the point:
 * once this has run, the 32-pixel bytes are gone and the derivation cannot be
 * repeated. A mapping that only works before it is used is not a mapping.
 *
 * ═══ ART NEVER REACHES GIT ═══
 * `client/public/assets/` is gitignored wholesale and ships through the deploy
 * script. This writes there and nowhere else; `npm run check`'s `check:assets`
 * is what proves it stayed out. A bare clone has neither the source tree nor
 * the destination, and this says so and exits 0 rather than failing.
 *
 * Usage:  node tools/import-tiles-64.mjs           # report only
 *         node tools/import-tiles-64.mjs --write   # install
 */
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../terrain-art-production/final/', import.meta.url));
const TILES = fileURLToPath(new URL('../client/public/assets/tiles/', import.meta.url));

/** Asset id -> its 64x64 source, relative to `terrain-art-production/final/`. */
const SOURCES = new Map([
  ['tile_ow_bridge', 'inner-datum-64/tile_ow_bridge.png'],
  ['tile_ow_bridge_horizontal', 'topology-64/bridges/horizontal.png'],
  ['tile_ow_bridge_vertical', 'topology-64/bridges/vertical.png'],
  ['tile_ow_charred', 'tome-wilderness-64/CHARRED_SCAR.png'],
  ['tile_ow_charred_b', 'tome-wilderness-64/CHARRED_SCAR_PATCH1.png'],
  ['tile_ow_charred_c', 'tome-wilderness-64/CHARRED_SCAR_PATCH2.png'],
  ['tile_ow_charred_d', 'tome-wilderness-64/CHARRED_SCAR_PATCH3.png'],
  ['tile_ow_charred_e', 'tome-wilderness-64/CHARRED_SCAR_PATCH4.png'],
  ['tile_ow_charred_f', 'tome-wilderness-64/CHARRED_SCAR_PATCH5.png'],
  ['tile_ow_city_roof', 'inner-datum-64/tile_ow_city_roof.png'],
  ['tile_ow_civic', 'inner-datum-64/tile_ow_civic.png'],
  ['tile_ow_cobble', 'inner-datum-64/tile_ow_cobble.png'],
  ['tile_ow_cobble_b', 'inner-datum-64/tile_ow_cobble_b.png'],
  ['tile_ow_cold_forest', 'tome-wilderness-64/COLD_FOREST.png'],
  ['tile_ow_cold_forest_b', 'tome-wilderness-64/COLD_FOREST1.png'],
  ['tile_ow_cold_forest_c', 'tome-wilderness-64/COLD_FOREST2.png'],
  ['tile_ow_cold_forest_d', 'tome-wilderness-64/COLD_FOREST3.png'],
  ['tile_ow_cold_forest_e', 'tome-wilderness-64/COLD_FOREST4.png'],
  ['tile_ow_cold_forest_f', 'tome-wilderness-64/COLD_FOREST5.png'],
  ['tile_ow_crag', 'inner-datum-64/tile_ow_crag.png'],
  ['tile_ow_deepwater', 'inner-datum-64/tile_ow_deepwater.png'],
  ['tile_ow_erased', 'inner-datum-64/tile_ow_erased.png'],
  ['tile_ow_field', 'inner-datum-64/tile_ow_field.png'],
  ['tile_ow_field_b', 'tome-wilderness-64/CULTIVATION.png'],
  ['tile_ow_field_c', 'tome-wilderness-64/CULTIVATION1.png'],
  ['tile_ow_field_d', 'tome-wilderness-64/CULTIVATION2.png'],
  ['tile_ow_field_e', 'tome-wilderness-64/CULTIVATION3.png'],
  ['tile_ow_field_f', 'tome-wilderness-64/CULTIVATION4.png'],
  ['tile_ow_frozen_water', 'tome-wilderness-64/FROZEN_SEA.png'],
  ['tile_ow_frozen_water_b', 'tome-wilderness-64/FROZEN_SEA1.png'],
  ['tile_ow_frozen_water_c', 'tome-wilderness-64/FROZEN_SEA2.png'],
  ['tile_ow_frozen_water_d', 'tome-wilderness-64/FROZEN_SEA3.png'],
  ['tile_ow_green', 'inner-datum-64/tile_ow_green.png'],
  ['tile_ow_heath', 'inner-datum-64/tile_ow_heath.png'],
  ['tile_ow_hills', 'inner-datum-64/tile_ow_hills.png'],
  ['tile_ow_hills_b', 'tome-wilderness-64/LOW_HILLS.png'],
  ['tile_ow_hills_c', 'tome-wilderness-64/LOW_HILLS1.png'],
  ['tile_ow_hills_d', 'tome-wilderness-64/LOW_HILLS2.png'],
  ['tile_ow_hills_e', 'tome-wilderness-64/LOW_HILLS3.png'],
  ['tile_ow_hills_f', 'tome-wilderness-64/LOW_HILLS4.png'],
  ['tile_ow_hills_g', 'tome-wilderness-64/LOW_HILLS5.png'],
  ['tile_ow_landmark_alderbrook', 'landmarks-64/landmark_alderbrook.png'],
  ['tile_ow_landmark_ashwick_row', 'inner-datum-64/tile_ow_site_town.png'],
  ['tile_ow_landmark_barrow_end', 'landmarks-64/landmark_barrow_end.png'],
  ['tile_ow_landmark_blackwood_outskirts', 'inner-datum-64/tile_ow_site_gate.png'],
  ['tile_ow_landmark_cairnfoot', 'landmarks-64/landmark_cairnfoot.png'],
  ['tile_ow_landmark_drowned_chapel', 'landmarks-64/landmark_drowned_chapel.png'],
  ['tile_ow_landmark_gearford_ward', 'landmarks-64/landmark_gearford_ward.png'],
  ['tile_ow_landmark_glass_archive', 'landmarks-64/landmark_glass_archive.png'],
  ['tile_ow_landmark_hollow_mine', 'inner-datum-64/tile_ow_site_mine.png'],
  ['tile_ow_landmark_outer_index', 'landmarks-64/landmark_outer_index.png'],
  ['tile_ow_landmark_saints_rest', 'inner-datum-64/tile_ow_site_ruin.png'],
  ['tile_ow_landmark_the_weir', 'landmarks-64/landmark_the_weir.png'],
  ['tile_ow_landmark_threadneedle_row', 'inner-datum-64/tile_ow_site_town.png'],
  ['tile_ow_landmark_underworks', 'landmarks-64/landmark_underworks.png'],
  ['tile_ow_landmark_watchers_altar', 'landmarks-64/landmark_watchers_altar.png'],
  ['tile_ow_landmark_wayfarers_camp', 'inner-datum-64/tile_ow_site_village.png'],
  ['tile_ow_mire', 'inner-datum-64/tile_ow_mire.png'],
  ['tile_ow_mountain', 'inner-datum-64/tile_ow_mountain.png'],
  ['tile_ow_mountain_b', 'tome-wilderness-64/DAIKARA_MOUNTAIN.png'],
  ['tile_ow_mountain_c', 'tome-wilderness-64/DAIKARA_MOUNTAIN_WALL1.png'],
  ['tile_ow_mountain_d', 'tome-wilderness-64/DAIKARA_MOUNTAIN_WALL2.png'],
  ['tile_ow_mountain_e', 'tome-wilderness-64/DAIKARA_MOUNTAIN_WALL3.png'],
  ['tile_ow_mountain_f', 'tome-wilderness-64/DAIKARA_MOUNTAIN_WALL4.png'],
  ['tile_ow_mountain_g', 'tome-wilderness-64/DAIKARA_MOUNTAIN_WALL5.png'],
  ['tile_ow_paving', 'inner-datum-64/tile_ow_paving.png'],
  ['tile_ow_plains', 'inner-datum-64/tile_ow_plains.png'],
  ['tile_ow_plains_b', 'inner-datum-64/tile_ow_plains_b.png'],
  ['tile_ow_rail', 'inner-datum-64/tile_ow_rail.png'],
  ['tile_ow_rail_horizontal', 'topology-64/rails/road_horizontal.png'],
  ['tile_ow_rail_n', 'topology-64/rails/road_n.png'],
  ['tile_ow_rail_ne', 'topology-64/rails/road_ne.png'],
  ['tile_ow_rail_s', 'topology-64/rails/road_s.png'],
  ['tile_ow_rail_sw', 'topology-64/rails/road_sw.png'],
  ['tile_ow_rail_vertical', 'topology-64/rails/road_vertical.png'],
  ['tile_ow_road_cross', 'topology-64/roads/paving/road_cross.png'],
  ['tile_ow_road_horizontal', 'topology-64/roads/paving/road_horizontal.png'],
  ['tile_ow_road_n', 'topology-64/roads/paving/road_n.png'],
  ['tile_ow_road_ne', 'topology-64/roads/paving/road_ne.png'],
  ['tile_ow_road_nw', 'topology-64/roads/paving/road_nw.png'],
  ['tile_ow_road_se', 'topology-64/roads/paving/road_se.png'],
  ['tile_ow_road_sw', 'topology-64/roads/paving/road_sw.png'],
  ['tile_ow_road_t_e', 'topology-64/roads/paving/road_t_e.png'],
  ['tile_ow_road_t_n', 'topology-64/roads/paving/road_t_n.png'],
  ['tile_ow_road_t_s', 'topology-64/roads/paving/road_t_s.png'],
  ['tile_ow_road_t_w', 'topology-64/roads/paving/road_t_w.png'],
  ['tile_ow_road_vertical', 'topology-64/roads/paving/road_vertical.png'],
  ['tile_ow_shore', 'inner-datum-64/tile_ow_shore.png'],
  ['tile_ow_site_altar', 'inner-datum-64/tile_ow_site_altar.png'],
  ['tile_ow_site_archive', 'inner-datum-64/tile_ow_site_archive.png'],
  ['tile_ow_site_breach', 'inner-datum-64/tile_ow_site_breach.png'],
  ['tile_ow_site_city', 'inner-datum-64/tile_ow_site_city.png'],
  ['tile_ow_site_gate', 'inner-datum-64/tile_ow_site_gate.png'],
  ['tile_ow_site_mine', 'inner-datum-64/tile_ow_site_mine.png'],
  ['tile_ow_site_office', 'inner-datum-64/tile_ow_site_office.png'],
  ['tile_ow_site_ruin', 'inner-datum-64/tile_ow_site_ruin.png'],
  ['tile_ow_site_stair', 'inner-datum-64/tile_ow_site_stair.png'],
  ['tile_ow_site_town', 'inner-datum-64/tile_ow_site_town.png'],
  ['tile_ow_site_village', 'inner-datum-64/tile_ow_site_village.png'],
  ['tile_ow_snowfield', 'tome-wilderness-64/POLAR_CAP.png'],
  ['tile_ow_soot', 'inner-datum-64/tile_ow_soot.png'],
  ['tile_ow_terrace', 'inner-datum-64/tile_ow_terrace.png'],
  ['tile_ow_town_roof', 'inner-datum-64/tile_ow_town_roof.png'],
  ['tile_ow_trees', 'inner-datum-64/tile_ow_trees.png'],
  ['tile_ow_trees_b', 'tome-wilderness-64/FOREST.png'],
  ['tile_ow_trees_c', 'tome-wilderness-64/FOREST1.png'],
  ['tile_ow_trees_d', 'tome-wilderness-64/FOREST10.png'],
  ['tile_ow_trees_e', 'tome-wilderness-64/FOREST11.png'],
  ['tile_ow_trees_f', 'tome-wilderness-64/FOREST12.png'],
  ['tile_ow_trees_g', 'tome-wilderness-64/FOREST2.png'],
  ['tile_ow_village_roof', 'inner-datum-64/tile_ow_village_roof.png'],
  ['tile_ow_wall', 'inner-datum-64/tile_ow_wall.png'],
  ['tile_ow_water', 'inner-datum-64/tile_ow_water.png'],
  ['tile_ow_works', 'inner-datum-64/tile_ow_works.png'],
  ['tile_ow_yard', 'inner-datum-64/tile_ow_yard.png'],
]);

/** PNG width and height, straight out of the IHDR. No dependency for four bytes. */
function pngSize(path) {
  const head = readFileSync(path).subarray(0, 24);
  if (head.length < 24) return null;
  if (head.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

if (!existsSync(SRC) || !existsSync(TILES)) {
  console.log('\n64-pixel terrain');
  console.log(`  skip  no art tree at ${SRC}`);
  console.log('        The artwork is not distributed with this repository.');
  process.exit(0);
}

const write = process.argv.includes('--write');
const shipped = readdirSync(TILES).filter((f) => f.endsWith('.png'));
const problems = [];
const ready = [];

for (const file of shipped) {
  const id = file.slice(0, -4);
  const rel = SOURCES.get(id);
  if (rel === undefined) {
    problems.push(`${file} is shipped and this table does not name a 64-pixel source for it`);
    continue;
  }
  const from = `${SRC}${rel}`;
  if (!existsSync(from)) {
    problems.push(`${id} -> ${rel} is not on disk`);
    continue;
  }
  const size = pngSize(from);
  if (size === null || size.w !== 64 || size.h !== 64) {
    problems.push(`${rel} is ${size === null ? 'not a PNG' : `${size.w}x${size.h}`}, not 64x64`);
    continue;
  }
  const now = pngSize(`${TILES}${file}`);
  ready.push({ file, from, was: now === null ? '?' : `${now.w}x${now.h}` });
}

console.log('\n64-pixel terrain');
console.log(`  ok    ${ready.length} tile(s) resolve to a 64x64 source`);
const already = ready.filter((r) => r.was === '64x64').length;
if (already > 0) console.log(`  ok    ${already} of them are already 64x64 on disk`);

for (const p of problems) console.log(`  FAIL  ${p}`);
if (problems.length > 0) {
  console.log('\n64-pixel terrain FAILED');
  process.exit(1);
}

if (!write) {
  console.log('\n  (report only — pass --write to install)');
  process.exit(0);
}

for (const r of ready) copyFileSync(r.from, `${TILES}${r.file}`);
console.log(`  ok    installed ${ready.length} tile(s)`);
console.log('\n64-pixel terrain OK');
