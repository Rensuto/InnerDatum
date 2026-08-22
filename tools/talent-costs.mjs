/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DID THE PORT CARRY THE PRICE? — every talent, against the source it cites.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each file in `src/server/talents/` names the upstream talent it came from, by
 * file and line, in its `NUMBERS` or `SHAPE` header. This reads that citation,
 * opens the cited range in `reference/t-engine4`, and compares the resource cost
 * it finds there with the one we charge.
 *
 * ═══ WHAT THE FIRST RUN FOUND, AND WHY IT IS ONE FINDING RATHER THAN FIVE ═══
 * Five ported talents charge nothing where upstream charges, and every one of
 * them belongs to the two classes that `tools/class-live.mjs` reports cannot
 * spend their resource at level 1:
 *
 *     shin_crack       Watchman    Crippling Shot        stamina 15  ->  0
 *     truncheon_sweep  Watchman    Death Dance           stamina 30  ->  0
 *     ward_rush        Watchman    Shield Pummel         stamina  8  ->  0
 *     pistol_whip      Inspector   Stunning Blow         stamina  8  ->  0
 *     scattershot      Inspector   Fragmentation Shot    stamina 12  ->  0
 *
 * Meanwhile every Alchemist talent kept its price, converted to the reagent
 * scale (mana 5 -> 2, 12 -> 1, 32 -> 2), and the Inspector's `sniper_mark` kept
 * its too (stamina 20 -> 35 Focus). So this was not a policy of free talents; it
 * is a gap that opened in one place and closed in another.
 *
 * The Watchman keeps Resolve costs only on `lockdown` and `iron_curtain`, which
 * are this game's own designs rather than ports — the ported half lost its
 * prices and the authored half kept them.
 *
 * ═══ IT IS A LEAD, NOT A VERDICT — THE FIRST RUN HAD A FALSE POSITIVE ═══
 * The comparison widens the cited range by six lines, because a citation often
 * points at the interesting function rather than the head of the table. That
 * window can spill into the NEXT talent: `weight_of_office` cites
 * `fire-drake.lua:30-34`, which is an `on_learn` block, and the sweep reported
 * `equilibrium = 5` from the ACTIVE talent those lines live inside. Our
 * `weight_of_office` is a passive and correctly costs nothing.
 *
 * So: read the cited range before believing a row. Each of the five above was
 * checked by hand — the `stamina` line is inside the range and the talent name
 * at the head of it matches what our file says it ported.
 *
 * ═══ NOT IN `npm run check` ═══
 * A number differing from upstream is usually a deliberate conversion, not a
 * bug: our pools are not upstream's size and the whole `BOTH CHARGE` column is
 * rescaled on purpose. A gate that failed on that would be a gate people learn
 * to silence. Run it like `tools/inert.mjs`, when you want to know.
 */
import fs from 'node:fs';
import path from 'node:path';

const REF = 'reference/t-engine4';
const DIR = 'src/server/talents';

/** ToME's resource fields, as they appear in a talent table. */
const POOLS = [
  'stamina',
  'mana',
  'psi',
  'vim',
  'equilibrium',
  'positive',
  'negative',
  'hate',
  'paradox',
  'feedback',
  'insanity',
];

const rows = [];
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
  const file = path.join(DIR, name);
  const src = fs.readFileSync(file, 'utf8');

  // ── our cost ────────────────────────────────────────────────────────────
  const costLine = /cost:\s*\{([^}]*)\}/.exec(src);
  if (costLine === null) continue;
  const resourceRef = /resource:\s*([A-Za-z_0-9]+)/.exec(costLine[1]);
  let ours = 0;
  if (resourceRef !== null) {
    const token = resourceRef[1];
    if (/^\d+$/.test(token)) ours = Number(token);
    else {
      const decl = new RegExp(`const ${token}\\s*=\\s*(\\d+)`).exec(src);
      ours = decl === null ? NaN : Number(decl[1]);
    }
  }

  // ── the citation ────────────────────────────────────────────────────────
  const cite = /t-engine4 (game\/modules\/tome\/data\/talents\/[^\s:]+):(\d+)(?:-(\d+))?/.exec(src);
  if (cite === null) {
    rows.push({ name, ours, upstream: null, pool: null, note: 'no talent citation' });
    continue;
  }
  const [, rel, fromRaw, toRaw] = cite;
  const upstreamPath = path.join(REF, rel);
  if (!fs.existsSync(upstreamPath)) {
    rows.push({ name, ours, upstream: null, pool: null, note: 'cited file missing' });
    continue;
  }
  const lines = fs.readFileSync(upstreamPath, 'utf8').split('\n');
  const from = Number(fromRaw) - 1;
  const to = toRaw === undefined ? from + 30 : Number(toRaw);
  const window = lines.slice(Math.max(0, from - 6), Math.min(lines.length, to + 6)).join('\n');

  let upstream = null;
  let pool = null;
  for (const p of POOLS) {
    const m = new RegExp(`^\\s*${p}\\s*=\\s*([0-9.]+)`, 'm').exec(window);
    if (m !== null) {
      upstream = Number(m[1]);
      pool = p;
      break;
    }
  }
  rows.push({ name, ours, upstream, pool, note: '' });
}

const dropped = rows.filter((r) => r.upstream !== null && r.upstream > 0 && r.ours === 0);
const kept = rows.filter((r) => r.upstream !== null && r.upstream > 0 && r.ours > 0);
const free = rows.filter((r) => r.upstream === 0 || (r.upstream === null && r.note === ''));

console.log(`\n═══ UPSTREAM CHARGES, OURS DOES NOT (${dropped.length}) ═══`);
for (const r of dropped) {
  console.log(
    `  ${r.name.padEnd(28)} upstream ${r.pool} ${String(r.upstream).padStart(3)}  ours 0`,
  );
}

console.log(`\n═══ BOTH CHARGE (${kept.length}) ═══`);
for (const r of kept) {
  console.log(
    `  ${r.name.padEnd(28)} upstream ${r.pool} ${String(r.upstream).padStart(3)}  ours ${String(r.ours)}`,
  );
}

console.log(`\n═══ NO COST FOUND IN THE CITED WINDOW (${free.length}) ═══`);
for (const r of free) console.log(`  ${r.name.padEnd(28)} ours ${String(r.ours)}`);

const odd = rows.filter((r) => r.note !== '');
console.log(`\n═══ NOT COMPARABLE (${odd.length}) ═══`);
for (const r of odd) console.log(`  ${r.name.padEnd(28)} ${r.note}`);
