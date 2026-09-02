#!/usr/bin/env node
/**
 * check-citations — every `file.lua:line` in src/ points at real code.
 *
 * ============================================================================
 * WHY THIS EXISTS: THE CITATIONS ARE THE PORT'S ONLY AUDIT TRAIL
 * ============================================================================
 * There are 1,878 references to 117 Lua files in src/. They are the whole of
 * the evidence that a number came from fifteen years of somebody else's
 * playtesting rather than from a guess that felt right — CLAUDE.md's rule is
 * "when docs and the Lua disagree, the Lua wins", and a citation is how anyone
 * checks. A stale one is worse than none: it looks like proof.
 *
 * Two of the three checks below are exact and cannot produce a false positive.
 * The third is a RATCHET, and it is the one worth reading about.
 *
 * ============================================================================
 * THE RATCHET: `Actor.lua:47` NAMES TWO DIFFERENT FILES
 * ============================================================================
 * T-Engine4 is an ENGINE with a MODULE on top, and the module shadows the
 * engine class by class. `engines/default/engine/Actor.lua` and
 * `modules/tome/class/Actor.lua` are both real, both long, and a bare
 * `Actor.lua:NNN` names whichever one the reader guesses.
 *
 * THIS IS NOT HYPOTHETICAL. Sight radius shipped as 20 for three commits.
 * `engine/Actor.lua:47` is `t.sight or 20`; `tome/class/Actor.lua:178` sets
 * `t.sight = t.sight or 10` before delegating, so the engine's `or 20` never
 * fires and every module call site passes 10. The citation read `Actor.lua:47`,
 * was accurate about the engine, and was wrong about the game.
 *
 * Rewriting all of them in one commit would be a diff nobody could review, so this
 * is a ratchet instead: the count may fall and may never rise. A new ambiguous
 * citation fails the gate; an old one is paid off whenever its file is next
 * touched. `MAX_AMBIGUOUS` below is the current debt and moves in one direction.
 *
 * ============================================================================
 * IT MUST NOT BREAK A BARE CLONE
 * ============================================================================
 * `reference/t-engine4` is gitignored (CLAUDE.md non-negotiable 6: read-only,
 * never redistributed). A clone, and CI, has no reference tree at all — so with
 * nothing to check against this SKIPS and exits 0. `art-needs` makes the same
 * accommodation for the same reason: a tool that only works on one laptop is a
 * tool that stops being run.
 */

import fs from 'node:fs';
import path from 'node:path';

const REFERENCE = 'reference/t-engine4';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO. THE DEBT IS PAID, SO THIS IS A RULE RATHER THAN A RATCHET NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It started at 590 raw, was 112 once the two refinements below were applied,
 * and reached 0 by reading the remainder one at a time against both candidate
 * files. Every citation in `src/` now names which of the two it means.
 *
 * DO NOT RAISE IT. A bare `Actor.lua:NNN` is the sight-radius bug's exact shape,
 * and the fix is four characters: write `engine/` or `tome/class/` in front. The
 * value of the rule is entirely in its being absolute — at 1 it is a number
 * somebody argues about, at 0 it is a thing the gate simply will not accept.
 */
const MAX_AMBIGUOUS = 0;

/** A citation: a lua basename, a line, and optionally a range end. */
const CITE = /([A-Za-z0-9_-]+\.lua):(\d+)(?:-(\d+))?/g;

/** A citation is DISAMBIGUATED when the text just before it names a directory. */
const QUALIFIED = /[A-Za-z0-9_-]\/$/;

function walk(dir, match, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out);
    else if (match(e.name)) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

if (!fs.existsSync(REFERENCE)) {
  console.log('\nport citations');
  console.log(`  skip  no ${REFERENCE} on this machine — nothing to check against`);
  console.log('\nport citations SKIPPED');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Index the reference tree by basename. A name with more than one path is the
// ambiguity the ratchet counts.
// ---------------------------------------------------------------------------

const byName = new Map();
for (const p of walk(REFERENCE, (n) => n.endsWith('.lua'), [])) {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const list = byName.get(name) ?? [];
  list.push(p);
  byName.set(name, list);
}

const lengths = new Map();
function lineCount(p) {
  let n = lengths.get(p);
  if (n === undefined) {
    n = fs.readFileSync(p, 'utf8').split('\n').length;
    lengths.set(p, n);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Walk src/ and judge every citation.
// ---------------------------------------------------------------------------

const unknown = [];
const outOfRange = [];
const ambiguous = [];
let checked = 0;

for (const file of walk('src', (n) => n.endsWith('.ts'), [])) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(CITE)) {
      const name = m[1];
      const from = Number(m[2]);
      const to = m[3] === undefined ? from : Number(m[3]);
      const at = `${file}:${String(i + 1)}`;
      const paths = byName.get(name);
      if (paths === undefined) {
        unknown.push({ at, name });
        continue;
      }
      checked += 1;
      // IN RANGE FOR ANY CANDIDATE is the bar, because a bare basename may name
      // either file — the ratchet below is what closes that hole, and until it
      // reaches zero this check must not guess which one was meant.
      if (paths.every((p) => to > lineCount(p))) {
        outOfRange.push({ at, name, from, to, have: paths.map(lineCount) });
        continue;
      }
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ONLY THE CANDIDATES THE LINE ACTUALLY FITS IN COUNT AS AMBIGUOUS.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `Zone.lua` is a real engine/module pair, and `content/rarity.ts` cites
       * `Zone.lua:250-256` — which exists only in the engine's, because the
       * module's is a couple of hundred lines shorter. A reader cannot pick the
       * wrong one there and neither should this count.
       *
       * That leaves genuine ambiguity: a line number that names real code in
       * BOTH files, which is the `Actor.lua:47` case exactly.
       */
      const fits = paths.filter((p) => to <= lineCount(p));
      const engine = fits.some((p) => p.includes('/engines/default/'));
      const mod = fits.some((p) => p.includes('/modules/tome/'));
      // ALREADY QUALIFIED? Text like `tome/class/Actor.lua:178` carries its own
      // answer, and the character before the basename is how we know.
      const before = line.slice(0, m.index);
      if (engine && mod && !QUALIFIED.test(before)) ambiguous.push({ at, name });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\nport citations');
console.log(`  ok    ${String(checked)} citation(s) resolve to a file in ${REFERENCE}`);

let failed = false;

if (unknown.length === 0) {
  console.log('  ok    every cited .lua exists in the reference tree');
} else {
  failed = true;
  console.log(`  FAIL  ${String(unknown.length)} citation(s) name a file that is not there`);
  for (const u of unknown.slice(0, 12)) console.log(`          ${u.at}  ${u.name}`);
}

if (outOfRange.length === 0) {
  console.log('  ok    every cited line is inside the file it names');
} else {
  failed = true;
  console.log(`  FAIL  ${String(outOfRange.length)} citation(s) point past the end of the file`);
  for (const o of outOfRange.slice(0, 12)) {
    console.log(
      `          ${o.at}  ${o.name}:${String(o.from)}-${String(o.to)} (${o.have.join('/')} lines)`,
    );
  }
}

const debt = ambiguous.length;
if (debt <= MAX_AMBIGUOUS) {
  console.log(`  ok    no citation is ambiguous between the engine and the module`);
} else {
  failed = true;
  console.log(
    `  FAIL  ${String(debt)} engine/module-ambiguous citations, and the ratchet is ${String(MAX_AMBIGUOUS)}`,
  );
  console.log('          a bare `Actor.lua:47` names two different files. Sight radius');
  console.log('          shipped as 20 for three commits on exactly that mistake.');
  console.log(
    '          Qualify the new one: `engine/Actor.lua:47` or `tome/class/Actor.lua:178`.',
  );
}

if (failed) {
  console.log('\nport citations FAILED');
  process.exit(1);
}
console.log('\nport citations OK');
