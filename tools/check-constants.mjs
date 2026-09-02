#!/usr/bin/env node
/**
 * check-constants — a comment that states a constant's value must be right.
 *
 * ============================================================================
 * WHY: THE NUMBER MOVES AND THE SENTENCE DOES NOT
 * ============================================================================
 * This codebase explains its numbers, at length, which is most of what makes it
 * possible to change them safely. The failure mode is the obvious one: somebody
 * raises a constant, updates every call site because the compiler makes them,
 * and leaves behind a paragraph that says what it used to be.
 *
 * FOUND BY WRITING THIS, three of them, and the third is why it is a gate
 * rather than a one-off sweep:
 *
 *   `MAX_CHARACTER_LEVEL` went from 10 to 50 — *"raising the cap is what makes
 *   the port a port"* — and `content/townsfolk.ts` still argued that
 *   `STANDING_LEVEL = 5` is *"the midpoint"*. It is a tenth. The number is
 *   still right; the reason given for it stopped being true.
 *
 *   `turn-engine.ts` told the reader *"`PROTOCOL_VERSION` is 9, the wire has no
 *   `ground` message and no `pickup` verb... so this event is real, logged,
 *   tested and deliberately not drawn"*. The version is 19, `ground` is a
 *   `ViewerMsg` and `pickup` is a client verb — the note was describing floor
 *   loot as invisible in a game that draws it.
 *
 * ============================================================================
 * THE CONVENTION IT ENFORCES: "IS" IS THE PRESENT TENSE
 * ============================================================================
 * `` `FOO` is 12 `` is checked. `` `FOO` was 12 `` is not — history is worth
 * writing down and this codebase writes a great deal of it, so the tense is the
 * distinction. Rewording a stale claim to the past is a correct fix, not a way
 * round the check: it turns a false statement into a true one.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 * It resolves only `const NAME = <number>` — not computed values, not object
 * fields, not enums. A name it cannot resolve to a numeric literal is SKIPPED
 * rather than reported: `DEFAULT_VIEWPORT` is derived and `INDEX_HUSK_ELITE` is
 * a monster, and flagging those would be noise that gets the tool switched off.
 *
 * SAME-FILE FIRST. `TALENT_ROW_H` exists in two client files with different
 * values, and the comment in each is right about its own. Resolving globally
 * reported a mismatch that was not one.
 *
 * AND A RANGE IS NOT AN ASSERTION. `` `ZOOM_MIN`..`ZOOM_MAX` is -1..1 `` reads
 * as "ZOOM_MAX is -1" to a naive regex and is perfectly correct prose.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `` `NAME` is 12 `` — present tense only, and never the left half of a range. */
const CLAIM = /`([A-Z][A-Z0-9_]{3,})`\s+(?:here\s+)?is\s+(-?\d+(?:\.\d+)?)(?!\s*\.\.)/g;
const DECL =
  /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\s*(?::[^=]+)?=\s*(-?\d+(?:\.\d+)?)\s*[;,]/gm;
/** Any declaration of the name, numeric or not — see `OWNED` below. */
const ANY_DECL = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\s*(?::[^=]+)?=/gm;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const files = walk('src', []);
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

/** name -> value, per file and globally. A name with two values globally is ambiguous. */
const perFile = new Map();
const owned = new Map();
const global = new Map();
for (const [file, src] of sources) {
  const here = new Map();
  for (const m of src.matchAll(DECL)) {
    here.set(m[1], m[2]);
    const seen = global.get(m[1]);
    global.set(m[1], seen === undefined || seen === m[2] ? m[2] : null);
  }
  perFile.set(file, here);
  // EVERY declaration, including computed ones. `TALENT_ROW_H` is
  // `ICON_PX + LEVEL_LABEL_H + 8` here and a plain 18 in `classpicker.ts`; a
  // file that declares the name OWNS it, and falling through to the other file's
  // literal reported a mismatch that was not one.
  owned.set(file, new Set([...src.matchAll(ANY_DECL)].map((m) => m[1])));
}

const wrong = [];
let checked = 0;

for (const [file, src] of sources) {
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    // COMMENTS ONLY. A claim in code is code, and the compiler owns it.
    if (!trimmed.startsWith('*') && !trimmed.startsWith('//')) continue;
    for (const m of line.matchAll(CLAIM)) {
      const name = m[1];
      const claim = m[2];
      // SAME FILE FIRST, and a file that declares the name at all keeps it —
      // see `owned`.
      const actual =
        perFile.get(file)?.get(name) ??
        (owned.get(file)?.has(name) === true ? undefined : global.get(name));
      if (actual === undefined || actual === null) continue;
      checked += 1;
      if (Number(actual) !== Number(claim)) {
        wrong.push({ at: `${file}:${String(i + 1)}`, name, claim, actual });
      }
    }
  }
}

console.log('\nconstants in prose');
console.log(`  ok    ${String(checked)} comment(s) state a constant's value`);

if (wrong.length === 0) {
  console.log('  ok    every one of them matches the declaration');
  console.log('\nconstants in prose OK');
} else {
  for (const w of wrong) {
    console.log(`  FAIL  ${w.at}`);
    console.log(`          says \`${w.name}\` is ${w.claim}, and it is ${w.actual}`);
  }
  console.log(
    `\nconstants in prose FAILED — ${String(wrong.length)} comment(s) state a value the\n` +
      'declaration disagrees with. If the sentence is HISTORY, say "was" rather than\n' +
      '"is"; the tense is what tells a reader whether to trust it.',
  );
  process.exit(1);
}
