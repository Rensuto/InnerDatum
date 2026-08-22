/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS BUILT AND REACHED BY NOTHING? — the recurring failure, made visible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This project keeps shipping systems that are written, correct, wired, tested
 * and called by no one. The pattern has cost real player-facing features:
 *
 *   - the STATUS system shipped connected to nothing for a whole milestone —
 *     115 test references, every one reaching into `engine/effects.ts` directly,
 *     none through `main.ts`, which never built the table. `tools/status-live.mjs`
 *     exists because of it.
 *   - `budgetPenalty` had ZERO production callers, so SLOWED was a badge with no
 *     effect: a slowed detective moved exactly as far as an unslowed one.
 *   - `ResourceKind.Ink`, its regen row and `noteAfflicted` all shipped before
 *     any class declared the resource, so none of it could run.
 *   - all four `fire*` hook dispatchers in `engine/hooks.ts` had no callers.
 *     `walk_it_off.ts` is in `GENERIC_PASSIVES` — the list EVERY character
 *     carries — and had never healed anybody a single point.
 *   - `MVP_EFFECTS` was registered from a three-element literal, leaving three
 *     effects inert in production.
 *
 * Every one was found by hand, late, and by accident. This is the mechanical
 * version of that search.
 *
 * ═══ WHAT IT REPORTS, IN THREE BUCKETS THAT MEAN DIFFERENT THINGS ═══
 *
 *   DEAD          nothing anywhere names it — not src, not test, not tools, not
 *                 even the file it lives in. This is the bucket worth reading.
 *                 A DISPATCHER here is a system that cannot run.
 *   OVER-EXPORTED used inside its own file and nowhere else. Not dead; the
 *                 `export` is just wider than it needs to be. Tidiness.
 *   TEST-ONLY     reached only by tests or tools. Sometimes correct (a helper
 *                 written for a probe), sometimes the exact trap above: a thing
 *                 whose only caller is the test that proves it works.
 *
 * ═══ WHY IT IS NOT PART OF `npm run check` ═══
 * Two of the three buckets are judgement calls, and a gate that fails on a
 * deliberately-unused constant teaches people to silence it. Run it when you
 * want to know, the way `tools/art-needs.mjs` is run.
 *
 * ═══ WHAT THE FIRST FULL TRIAGE FOUND, so nobody walks the list twice ═══
 * Every entry in DEAD and TEST-ONLY was read on 2026-08-22. The hook
 * dispatchers were the only wiring bugs in either. The rest fall into three
 * kinds that are NOT bugs, and telling them apart is the skill this tool needs
 * from its reader:
 *
 *   A CAPABILITY WITH NO CONTENT YET. `grantImmunity`, `dispelChannel` and
 *   `recomputeGlobalSpeed` are wiring that works and that nothing has asked for
 *   — no authored item grants an immunity, no talent dispels by channel. That
 *   is the OPPOSITE of the bug this tool hunts: there, content existed and the
 *   wiring did not. `seen_worse.ts` makes the same distinction in its own words
 *   about a mental save: "a resistance to a channel no content produces can
 *   only ever be decoration".
 *
 *   A PLACEHOLDER THAT SAYS SO. `REVIVE_AP` is documented as "CARRIED AS DATA,
 *   NOT SPENT HERE", with the reason and the day it will be read. `noteBaseline`
 *   says it exists "so the intent is expressible at the call site". Both are
 *   deliberate and both explain themselves where they are declared.
 *
 *   A CUMULATIVE TWIN OF A LIVE FUNCTION. `totalCategoryPointsAtLevel` looks
 *   alarming — if nothing granted category points, no locked tree could ever be
 *   opened — but the grant runs through `categoryPointsForLevel`, the
 *   per-level one, and the cumulative form is for restore paths and tests.
 *
 * The one genuine leftover was `physResistAt` in `seen_worse.ts`: the scaling
 * function of an earlier version of that talent, superseded by `gritAt` and
 * exported for several commits after nothing called it. Deleted.
 *
 * ═══ WHAT IT CANNOT SEE ═══
 * It matches TEXT. A symbol reached only through a string key, a dynamic import
 * or a registry lookup reads as dead here and is not; a symbol named in a
 * comment reads as live and may not be. It is a place to start looking, never
 * an answer on its own — every fix that came out of it was confirmed by reading
 * the code and then by a test that fails when the wiring is removed.
 */
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) {
      out.push(p.split(path.sep).join('/'));
    }
  }
  return out;
}

const srcFiles = walk('src', []);
const testFiles = walk('test', []);
/**
 * ITSELF EXCLUDED, AND IT HAD TO LEARN THAT THE HARD WAY.
 *
 * The header above NAMES the symbols this tool has already triaged — `REVIVE_AP`,
 * `noteBaseline`, `grantImmunity`. Those are prose, and a text search cannot tell
 * prose from a call: writing down that `REVIVE_AP` is dead made it stop counting
 * as dead, and the run after that documentation reported three fewer than the run
 * before it, with no code changed.
 *
 * A measuring instrument that moves its own reading is worse than no instrument,
 * so this file is not one of the files it reads.
 */
const toolFiles = walk('tools', []).filter((f) => f !== 'tools/inert.mjs');

const body = new Map();
for (const f of [...srcFiles, ...testFiles, ...toolFiles]) {
  body.set(f, fs.readFileSync(f, 'utf8'));
}

/**
 * VALUES ONLY. A `type` or `interface` export is usually annotated once in its
 * own file (`options: CharSheetDrawOptions`) and named nowhere else, which is
 * correct and would drown the signal — 255 of them against 88 values on the run
 * that found the hook dispatchers.
 */
const EXPORT_RE = /^export (?:async )?(?:function|const|class) ([A-Za-z_][A-Za-z0-9_]*)/gm;

const declaredIn = new Map();
for (const f of srcFiles) {
  for (const m of body.get(f).matchAll(EXPORT_RE)) {
    const name = m[1];
    if (!declaredIn.has(name)) declaredIn.set(name, new Set());
    declaredIn.get(name).add(f);
  }
}

const word = (name) => new RegExp(String.raw`\b${name}\b`, 'g');
const countIn = (files, re, skip) => {
  let n = 0;
  for (const f of files) {
    if (f === skip) continue;
    n += (body.get(f).match(re) ?? []).length;
  }
  return n;
};

const dead = [];
const overExported = [];
const testOnly = [];

for (const [name, homes] of declaredIn) {
  // A NAME DECLARED IN TWO FILES cannot be attributed by a text match, so it is
  // skipped rather than guessed at. `const X` + `type X` in one file is the
  // common case and is not a duplicate.
  if (homes.size !== 1) continue;
  const home = [...homes][0];
  const re = word(name);

  if (countIn(srcFiles, re, home) > 0) continue;

  /**
   * HOME FIRST, AND THE ORDER IS THE WHOLE ACCURACY OF THIS TOOL.
   *
   * A function its own file calls is RUNNING. That a test also names it directly
   * is ordinary — `applyArmour` and `normalFloat` are steps of the damage
   * pipeline with unit tests of their own, and they are called by the pipeline
   * every time anything is hit.
   *
   * Checking tests first put all 24 of those in the "reached only by tests"
   * bucket and buried the handful that genuinely are. The suspicious case is
   * narrower and much rarer: nothing in src/ names it, INCLUDING THE FILE IT
   * LIVES IN, and the only thing that does is a test. That is the shape
   * `walk_it_off.ts` had — a hook body three tests called by hand and nothing
   * else ever ran.
   *
   * `- 1` for the declaration line itself.
   */
  const atHome = Math.max(0, (body.get(home).match(re) ?? []).length - 1);
  if (atHome > 0) {
    overExported.push({ name, home, atHome });
    continue;
  }

  const inTests = countIn(testFiles, re, null);
  const inTools = countIn(toolFiles, re, null);
  if (inTests > 0 || inTools > 0) testOnly.push({ name, home, inTests, inTools });
  else dead.push({ name, home });
}

const by = (a, b) => a.home.localeCompare(b.home) || a.name.localeCompare(b.name);
dead.sort(by);
overExported.sort(by);
testOnly.sort(by);

const section = (title, rows, extra) => {
  console.log(`\n═══ ${title} (${rows.length}) ═══`);
  for (const row of rows) {
    console.log(`  ${row.home.padEnd(40)} ${row.name.padEnd(30)} ${extra ? extra(row) : ''}`);
  }
};

section('DEAD — named by nothing at all, including its own file', dead);
section(
  'TEST-ONLY — nothing in src names it, not even its own file',
  testOnly,
  (r) => `tests:${r.inTests} tools:${r.inTools}`,
);
section('OVER-EXPORTED — used at home and nowhere else', overExported, (r) => `home:${r.atHome}`);

console.log(
  `\n${String(dead.length)} dead · ${String(testOnly.length)} test-only · ` +
    `${String(overExported.length)} over-exported. See this file's header on how to read them.`,
);
