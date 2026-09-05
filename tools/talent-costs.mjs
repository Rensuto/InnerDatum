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
 * ═══ THE COOLDOWN COLUMN SAYS SOMETHING DIFFERENT FROM THE COST ONE ═══
 * Six actives differ from their cited cooldown once converted, and they differ
 * in BOTH DIRECTIONS — shin_crack is 3 where the citation implies 5, pistol_whip
 * is 5 where it implies 3, truncheon_sweep and scattershot are 4 against 5,
 * concussion_flask 6 against 5. Numbers moved both ways are tuning; a column of
 * zeroes against a column of costs is an omission. That difference is the whole
 * reason the cost finding is worth acting on and this one probably is not.
 *
 * `ashwick_flare` is the one that documents itself — "the Reagent IS the
 * cooldown: ToME's Flame has `cooldown = 3` and no ammunition, this has
 * ammunition and no cooldown" — and `redaction.ts` now does the same for being
 * twice its source. The other five carry their number with no note about where
 * it came from, which is the only thing here worth tidying.
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

/** ceil(actions / 2), bounded — `tomeCooldownToTurns` in engine/talents.ts. */
const TOME_ACTIONS_PER_TURN = 2;
const MAX_COOLDOWN_TURNS = 30;
const convert = (n) =>
  !Number.isFinite(n) || n <= 0
    ? 0
    : Math.min(MAX_COOLDOWN_TURNS, Math.max(0, Math.ceil(n / TOME_ACTIONS_PER_TURN)));

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

  /**
   * ═══ AND THE COOLDOWN, COMPARED CONVERTED RATHER THAN RAW ═══
   * `tomeCooldownToTurns` is `ceil(n / TOME_ACTIONS_PER_TURN)` bounded to
   * `MAX_COOLDOWN_TURNS` — upstream counts ACTIONS and this game counts TURNS,
   * and there are two actions in a turn. Comparing the raw numbers would report
   * every talent in the game as wrong by a factor of two, which is the fastest
   * way to make a sweep worth ignoring.
   */
  const cdUp = /^\s*cooldown\s*=\s*([0-9]+)/m.exec(window);
  const cdOursRef = /cooldownTurns:\s*([A-Za-z_0-9]+)/.exec(src);
  let cdOurs = null;
  if (cdOursRef !== null) {
    const token = cdOursRef[1];
    if (/^\d+$/.test(token)) cdOurs = Number(token);
    else {
      const decl = new RegExp(String.raw`const ${token}\s*=\s*(\d+)`).exec(src);
      cdOurs = decl === null ? null : Number(decl[1]);
    }
  }
  /**
   * ACTIVES ONLY, and the filter carries most of this comparison's worth.
   *
   * A passive has no cooldown to have, and a sustain's is its own affair — but
   * the ±6 window happily reports the cooldown of whatever ACTIVE talent sits
   * beside the passive's `on_learn` block upstream. Unfiltered this printed 17
   * rows of which ten were passives and sustains: `soft_places`, `walk_it_off`,
   * `seen_worse`, `careful_method` and the rest, every one correctly costing
   * nothing and every one reported as wrong.
   *
   * The same shape of false positive as `weight_of_office`'s `equilibrium = 5`
   * in the cost column, and worth filtering rather than footnoting: a sweep that
   * is more than half noise does not get read twice.
   */
  const kindHere = /kind:\s*TalentKind\.([A-Za-z]+)/.exec(src);
  const isActive = kindHere !== null && kindHere[1] === 'Active';
  /**
   * AND THE COST COLUMN NEEDS ITS OWN PREDICATE, NOT THIS ONE.
   *
   * The note above says the `weight_of_office` row is "the same shape of false
   * positive ... and worth filtering rather than footnoting". Only the cooldown
   * column was ever filtered; the cost column kept printing that row, and a
   * sweep carrying a permanent known-false row is one people learn to skim.
   *
   * `isActive` IS THE WRONG TEST HERE. A SUSTAINED talent pays -- engine/
   * talents.ts: "Pays once, stays on, and reserves a share of the pool" -- so
   * filtering on Active would hide the five sustains from a comparison they
   * belong in. Only a PASSIVE has no cost to have, which is why the cooldown
   * filter above may exclude sustains ("a sustain's is its own affair") and
   * this one may not.
   */
  const isPassive = kindHere !== null && kindHere[1] === 'Passive';
  const cdWant = cdUp === null || !isActive ? null : convert(Number(cdUp[1]));

  rows.push({
    name,
    ours,
    upstream,
    pool,
    isPassive,
    note: '',
    cdOurs,
    cdUpRaw: cdUp === null ? null : Number(cdUp[1]),
    cdWant,
  });
}

const dropped = rows.filter(
  (r) => !r.isPassive && r.upstream !== null && r.upstream > 0 && r.ours === 0,
);
// NOT SILENTLY DROPPED. A passive filtered out of the cost column is still
// counted and named below, so a wrong guess about a talent's kind cannot hide
// a real row -- it moves it somewhere visible instead.
const passivesSkipped = rows.filter(
  (r) => r.isPassive && r.upstream !== null && r.upstream > 0 && r.ours === 0,
);
const kept = rows.filter((r) => r.upstream !== null && r.upstream > 0 && r.ours > 0);
const free = rows.filter((r) => r.upstream === 0 || (r.upstream === null && r.note === ''));

console.log(`\n═══ UPSTREAM CHARGES, OURS DOES NOT (${dropped.length}) ═══`);
for (const r of dropped) {
  console.log(
    `  ${r.name.padEnd(28)} upstream ${r.pool} ${String(r.upstream).padStart(3)}  ours 0`,
  );
}

if (passivesSkipped.length > 0) {
  console.log(
    `  (${String(passivesSkipped.length)} passive(s) not compared, having no cost to have: ` +
      `${passivesSkipped.map((r) => r.name.replace(/\.ts$/, '')).join(', ')})`,
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

const cdOff = rows.filter((r) => r.cdWant !== null && r.cdOurs !== null && r.cdWant !== r.cdOurs);
console.log(`\n═══ COOLDOWN DIFFERS FROM THE CITED TALENT, CONVERTED (${cdOff.length}) ═══`);
for (const r of cdOff) {
  console.log(
    `  ${r.name.padEnd(28)} upstream ${String(r.cdUpRaw).padStart(2)} actions -> ` +
      `${String(r.cdWant)} turns   ours ${String(r.cdOurs)}`,
  );
}

const odd = rows.filter((r) => r.note !== '');
console.log(`\n═══ NOT COMPARABLE (${odd.length}) ═══`);
for (const r of odd) console.log(`  ${r.name.padEnd(28)} ${r.note}`);
