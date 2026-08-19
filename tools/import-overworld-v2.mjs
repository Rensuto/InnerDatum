/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REDESIGNED MOOR, TURNED BACK INTO THE GLYPH ROWS THIS GAME AUTHORS IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Codex produced a v2 overworld — an irregular landmass with peninsulas, a
 * broken mountain spine with two passes and one collapsed cut, three rivers
 * with real bridges, a railway, and all sixteen canonical sites redistributed.
 * Its handoff offers two integration paths and this tool takes the smaller one
 * deliberately: `runtime-fallback.json` resolves every cell to a TileCode THIS
 * BUILD ALREADY KNOWS, so the world changes and the renderer, the legend, the
 * fog, the pathfinder and the protocol do not.
 *
 * The cost is stated in the handoff and accepted here: the fallback cannot
 * express snowfield-versus-plains or cold-forest-versus-trees, because this
 * build has no codes for them. Those are visual distinctions and they wait for
 * the 32px asset import; the LAYOUT is what a player walks through, and that
 * arrives whole.
 *
 * Usage:  node tools/import-overworld-v2.mjs           # report only
 *         node tools/import-overworld-v2.mjs --write   # rewrite the rows
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC =
  '../../terrain-art-production/handoff/alderbrook-overworld-redesign/runtime-fallback.json';
const world = JSON.parse(readFileSync(new URL(SRC, import.meta.url), 'utf8'));
const { w, h } = world;
const tiles = [...world.tiles];

/** TileCode -> the glyph `ALDERBROOK_LEGEND` already spells it with. */
const GLYPH = new Map([
  [15, 'p'],
  [16, 'h'],
  [17, 'e'],
  [21, 's'],
  [14, 'w'],
  [20, 'W'],
  [12, 'T'],
  [18, 'M'],
  [19, 'c'],
  [23, 't'],
  [24, 'k'],
  [25, 'L'],
  [26, 'y'],
  [27, 'j'],
  [13, 'X'],
  [2, '.'],
  [3, ','],
  [5, ';'],
  [7, 'r'],
  [8, 'b'],
]);

/** Site -> the glyph the legend already gives it. */
const SITE_GLYPH = new Map([
  ['site:alderbrook', 'O'],
  ['site:threadneedle_row', 'R'],
  ['site:ashwick_row', 'H'],
  ['site:wayfarers_camp', 'P'],
  ['site:saints_rest', 'S'],
  ['site:blackwood_outskirts', 'B'],
  ['site:gearford_ward', 'F'],
  ['site:glass_archive', 'G'],
  ['site:underworks', 'U'],
  ['site:watchers_altar', 'A'],
  ['site:hollow_mine', 'N'],
  ['site:drowned_chapel', 'D'],
  ['site:outer_index', 'I'],
  ['site:cairnfoot', 'K'],
  ['site:barrow_end', 'V'],
  ['site:the_weir', 'Z'],
]);

/** The tile each site glyph carries, so the walkable count can be recomputed. */
const SITE_TILE = new Map([
  ['O', 3],
  ['R', 3],
  ['H', 3],
  ['P', 3],
  ['S', 3],
  ['B', 3],
  ['F', 3],
  ['G', 3],
  ['I', 3],
  ['U', 16],
  ['A', 16],
  ['N', 16],
  ['D', 16],
  ['K', 16],
  ['E', 16],
  ['V', 15],
  ['Z', 21],
]);

const WALKABLE = new Set([15, 16, 17, 21, 26, 27, 2, 3, 5, 7, 8]);

const at = (x, y) => tiles[y * w + x];

// ── 1. GROUND NOBODY CAN REACH BECOMES FOREST ───────────────────────────────
// v2 leaves sixteen walkable cells of hills and plains on a shelf at rows 2-3,
// sealed by the eroded border above and a forest belt below: visible on the
// world map and impossible to stand on, which is the exact thing
// `overworld.test.ts` forbids.
//
// THE FIRST VERSION OPENED A GAP IN THE TREES AND THAT WAS THE WRONG TRADE.
// Measured afterwards: the belt is EIGHT cells deep at its thinnest, so reaching
// a shelf that holds nothing would mean carving a corridor through a forest
// somebody drew. Sealing the shelf costs sixteen cells at the map's edge and
// leaves the treeline whole.
//
// DONE BY FLOOD FILL RATHER THAN BY COORDINATE, so a re-import of a different
// layout gets the same guarantee instead of the same sixteen cells.
function sealUnreachable() {
  const reachNow = reachableFromSpawn();
  let sealed = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!WALKABLE.has(at(x, y))) continue;
      if (reachNow.has(`${String(x)},${String(y)}`)) continue;
      tiles[y * w + x] = 12;
      sealed += 1;
    }
  }
  return sealed;
}

function reachableFromSpawn() {
  const s = world.spawns[0];
  const seen = new Set([`${String(s.x)},${String(s.y)}`]);
  const edge = [s];
  while (edge.length > 0) {
    const cur = edge.pop();
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const key = `${String(nx)},${String(ny)}`;
        if (seen.has(key) || !WALKABLE.has(at(nx, ny))) continue;
        seen.add(key);
        edge.push({ x: nx, y: ny });
      }
    }
  }
  return seen;
}

const sealed = sealUnreachable();

// ── 2. THE REDACTION CROSSING ───────────────────────────────────────────────
// v2 carries all sixteen CANONICAL sites and not the seventeenth: the crossing
// to the second landmass. It was not content Codex was given, and it cannot be
// dropped — five townsfolk point at it ("west past the Sedge"), the rumour gate
// opens on it at level 5, and `makeRedaction` mirrors THIS map through it.
//
// WEST, because that is what the rumours say; on hills, because that is the
// tile its glyph carries; reachable, because a door nobody can walk to is the
// bug this project has already shipped once; and clear of every other site, so
// the map does not stack two markers.
const layout = JSON.parse(
  readFileSync(
    new URL(
      '../../terrain-art-production/handoff/alderbrook-overworld-redesign/layout.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const regionsMeta = JSON.parse(
  readFileSync(
    new URL(
      '../../terrain-art-production/handoff/alderbrook-overworld-redesign/regions.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const regionOf = new Int16Array(w * h);
for (let i = 0; i < w * h; i += 1) regionOf[i] = layout.layers.region[i] ?? 0;
for (let pass = 0; pass < 4; pass += 1) {
  let moved = 0;
  const next = Int16Array.from(regionOf);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const mine = regionOf[y * w + x];
      const tally = new Map();
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const n = regionOf[(y + dy) * w + (x + dx)];
          tally.set(n, (tally.get(n) ?? 0) + 1);
        }
      }
      let top = mine;
      let best = 0;
      for (const [n, c] of tally) {
        if (c > best) {
          best = c;
          top = n;
        }
      }
      // FIVE OF EIGHT, not six. Six left one-cell slivers standing on boundaries
      // where the split is five to three — measured at x=141,y=25 and x=52,y=70,
      // both single walkable cells of one region inside another, both of them a
      // stutter in the Record lane.
      if (top !== mine && best >= 5) {
        next[y * w + x] = top;
        moved += 1;
      }
    }
  }
  regionOf.set(next);
  if (moved === 0) break;
  if (pass === 3)
    console.log(`  region smoothing still moving ${String(moved)} cells at the last pass`);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND A SECOND PASS THAT COUNTS ONLY THE GROUND YOU COULD HAVE COME FROM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The pass above weighs all eight neighbours, and on a coastline most of them
 * are sea belonging to the same coastal region — so a lone walkable cell of
 * "the Drowned Coast" sitting between two inland regions is never outvoted, and
 * a player crossing it reads two Record lines a tile apart.
 *
 * MEASURED: one such cell at 141,25 and one at 128,45 survived the first pass.
 * Walking is done on ground, so the tie is broken by ground: a walkable cell
 * whose walkable neighbours mostly belong to somebody else joins them.
 */
for (let pass = 0; pass < 3; pass += 1) {
  let moved = 0;
  const next = Int16Array.from(regionOf);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      if (!WALKABLE.has(at(x, y))) continue;
      const mine = regionOf[y * w + x];
      const tally = new Map();
      let ground = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!WALKABLE.has(at(nx, ny))) continue;
          ground += 1;
          const n = regionOf[ny * w + nx];
          tally.set(n, (tally.get(n) ?? 0) + 1);
        }
      }
      if (ground === 0) continue;
      let top = mine;
      let best = tally.get(mine) ?? 0;
      for (const [n, c] of tally) {
        if (c > best) {
          best = c;
          top = n;
        }
      }
      // A STRICT MAJORITY, OR NO COMPANY AT ALL. The second clause is what
      // catches a cell whose walkable neighbours split evenly between two other
      // regions and none of them is its own — measured at 128,45, where a lone
      // cell of Kettleflat sat in a four-four tie and stayed put.
      const kin = tally.get(mine) ?? 0;
      if (top !== mine && (best * 2 > ground || kin === 0)) {
        next[y * w + x] = top;
        moved += 1;
      }
    }
  }
  regionOf.set(next);
  if (moved === 0) break;
}

/** Which index the region layer uses for a given region id. */
function layoutRegionIndex(id) {
  const i = layout.palettes.region.indexOf(id);
  if (i < 0) throw new Error(`no region called ${String(id)}`);
  return i;
}

// IN THE SEDGE, because that is the country every rumour names — *"west past
// the Sedge"*, five times over, and `rumour.test.ts` checks the door is in the
// place the lines send you to. The glyph carries HILLS, so the cell becomes a
// rise with a door in it whatever the bog around it was.
const reach = reachableFromSpawn();
const sedgeIndex = layoutRegionIndex('sedge');
let redaction = null;
for (let y = 2; y < h - 2; y += 1) {
  for (let x = 2; x < w - 2; x += 1) {
    if (regionOf[y * w + x] !== sedgeIndex) continue;
    if (!WALKABLE.has(at(x, y))) continue;
    if (!reach.has(`${String(x)},${String(y)}`)) continue;
    if (!world.sites.every((s) => Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) > 8)) continue;
    if (redaction === null || x < redaction.x) redaction = { x, y };
  }
}
if (redaction === null) throw new Error('nowhere in the west to put the Redaction crossing');

// ── 3. GLYPHS ───────────────────────────────────────────────────────────────
const rows = [];
for (let y = 0; y < h; y += 1) {
  let row = '';
  for (let x = 0; x < w; x += 1) {
    const g = GLYPH.get(at(x, y));
    if (g === undefined) throw new Error(`no glyph for TileCode ${String(at(x, y))} at ${x},${y}`);
    row += g;
  }
  rows.push(row);
}
const put = (x, y, glyph) => {
  rows[y] = `${rows[y].slice(0, x)}${glyph}${rows[y].slice(x + 1)}`;
};
for (const s of world.sites) {
  const g = SITE_GLYPH.get(s.id);
  if (g === undefined) throw new Error(`no glyph for ${s.id}`);
  put(s.x, s.y, g);
}
put(redaction.x, redaction.y, 'E');

// ── 3b. THE GATE COURTYARD ──────────────────────────────────────────────────
// v2 declares ONE spawn cell. `world.ts#findSpawn` walks the authored cluster
// and then falls through to a uniform draw over every free tile on the level, so
// a single tile means the SECOND player to join lands somewhere random on a
// 170x100 moor — and overworld.test.ts exists because that shipped once: *"the
// first thing they saw on connecting was empty country"*.
//
// So the gate gets a courtyard, the way v1 authored one: walkable ground within
// two tiles of Alderbrook becomes `o` (yard + spawn), with the site glyph itself
// left alone at the centre.
const gate = world.sites.find((s) => s.id === 'site:alderbrook');
if (gate === undefined) throw new Error('v2 has no Alderbrook to spawn at');
let yard = 1;
for (let dy = -2; dy <= 2; dy += 1) {
  for (let dx = -2; dx <= 2; dx += 1) {
    if (dx === 0 && dy === 0) continue;
    const x = gate.x + dx;
    const y = gate.y + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (!WALKABLE.has(at(x, y))) continue;
    if (rows[y][x] !== GLYPH.get(at(x, y))) continue;
    put(x, y, 'o');
    yard += 1;
  }
}
if (yard < 8) throw new Error(`only ${String(yard)} spawn tiles at the gate; a party needs eight`);
console.log(`  ${String(yard)} spawn tiles in the gate courtyard`);

// ── 4. REPORT ───────────────────────────────────────────────────────────────
let walkable = 0;
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const g = rows[y][x];
    const code = SITE_TILE.has(g) ? SITE_TILE.get(g) : at(x, y);
    if (WALKABLE.has(code)) walkable += 1;
  }
}
console.log(`v2 layout ${world.layout_revision}`);
console.log(`  ${String(w)}x${String(h)}, ${String(walkable)} walkable cells (v1 had 9327)`);
console.log(`  spawn ${String(world.spawns[0].x)},${String(world.spawns[0].y)}`);
console.log(
  `  ${String(world.sites.length)} canonical sites + the Redaction crossing at ${String(redaction.x)},${String(redaction.y)}`,
);
console.log(`  sealed ${String(sealed)} cells of ground no player could reach`);

// ── 5. THE REGIONS, WHICH ARE NO LONGER RECTANGLES ──────────────────────────
// v1 modelled country as twelve boxes. v2 draws them per cell — *"irregular
// per-cell regions; seed is label anchor, not a rectangle"* — and the bounding
// boxes overlap so badly (one spans x 5..157, another fills as little as 17% of
// its box) that keeping rectangles would announce the wrong country on most of
// the map.
//
// So the shape comes across as it was drawn: one character per cell, in the
// same row style the tiles use, plus the twelve names and the anchor each label
// is drawn at. Index 0 is unregioned ground.
const REGION_CHARS = '0123456789abc';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SLIVERS SMOOTHED AWAY, BECAUSE A ONE-CELL CLIP IS A STUTTER IN THE LOG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `noteRegion` announces the country you walk into, once, when it changes. Two
 * rectangles could only ever meet on a straight seam; irregular country can clip
 * a corner, and a single cell of a neighbouring region inside another one makes
 * a walker read "You come to the Sedge" and "You come to the Grey Downs" on
 * consecutive steps for a place they never really entered.
 *
 * MEASURED: one-cell strips on row 25 before this ran. So a cell whose region
 * disagrees with at least six of its eight neighbours takes the majority's, and
 * the pass repeats until nothing moves — the smallest change that removes the
 * stutter without redrawing anybody's borders.
 */
const regionRows = [];
for (let y = 0; y < h; y += 1) {
  let row = '';
  for (let x = 0; x < w; x += 1) {
    const idx = regionOf[y * w + x] ?? 0;
    const ch = REGION_CHARS[idx];
    if (ch === undefined) throw new Error(`region index ${String(idx)} has no character`);
    row += ch;
  }
  regionRows.push(row);
}
const palette = layout.palettes.region;
const byId = new Map(regionsMeta.regions.map((r) => [r.id, r]));
const regionList = [];
let moved = 0;
for (let i = 1; i < palette.length; i += 1) {
  const meta = byId.get(palette[i]);
  if (meta === undefined) throw new Error(`no metadata for region ${String(palette[i])}`);
  const [sx, sy] = meta.seed;
  /**
   * THE SEED IS A LABEL ANCHOR AND THREE OF THE TWELVE ARE NOT IN THEIR OWN
   * COUNTRY. Measured against the region layer: `cold_furrows` (84,11) and
   * `saintswood` (142,19) both land on `drowned_coast`, and `drowned_coast`
   * (85,93) lands in `blackwater_wood`. Drawn as given, "the Cold Furrows"
   * would be written across open water.
   *
   * So a seed is used where it belongs and otherwise replaced by the nearest
   * cell that does belong — the smallest correction that keeps the artist's
   * intent (roughly here) while making the label true.
   */
  const inOwn = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && palette[regionOf[y * w + x] ?? 0] === meta.id;
  let anchor = { x: sx, y: sy };
  if (!inOwn(sx, sy)) {
    let best = null;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!inOwn(x, y)) continue;
        const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
        if (best === null || d < best.d) best = { x, y, d };
      }
    }
    if (best === null) throw new Error(`region ${String(meta.id)} has no cells at all`);
    anchor = { x: best.x, y: best.y };
    moved += 1;
  }
  regionList.push({ name: meta.name, x: anchor.x, y: anchor.y });
}
if (moved > 0) console.log(`  moved ${String(moved)} label anchors onto their own ground`);
console.log(`  ${String(regionList.length)} regions, drawn per cell rather than as boxes`);

if (process.argv.includes('--write')) {
  const body = rows.map((r) => `  '${r}',`).join('\n');
  const file = new URL('../src/shared/level.ts', import.meta.url);
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('const ALDERBROOK_ROWS: readonly string[] = [');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('could not find ALDERBROOK_ROWS');
  writeFileSync(
    file,
    `${src.slice(0, start)}const ALDERBROOK_ROWS: readonly string[] = [\n${body}${src.slice(end)}`,
  );
  const NL = String.fromCharCode(10);
  const regionBody = regionRows.map((r) => `  '${r}',`).join(NL);
  const after = readFileSync(file, 'utf8');
  const marker = 'const ALDERBROOK_REGION_ROWS: readonly string[] = [';
  const rs = after.indexOf(marker);
  const re = after.indexOf(`${NL}];`, rs);
  if (rs >= 0 && re >= 0) {
    writeFileSync(file, `${after.slice(0, rs)}${marker}${NL}${regionBody}${after.slice(re)}`);
  }
  writeFileSync(
    new URL('../../terrain-art-production/region-anchors.json', import.meta.url),
    `${JSON.stringify(regionList, null, 2)}${NL}`,
  );
  console.log('  wrote src/shared/level.ts');
}
