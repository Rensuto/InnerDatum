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
/**
 * ═══ `10_000` IS A NUMBER, AND THIS PATTERN COULD NOT SEE ONE ═══
 *
 * The value group was `-?\d+(\.\d+)?`, so a numeric separator ended the match:
 * `\d+` took "10" and then wanted `[;,]` and found `_`. Eighteen constants in
 * src/ are written that way — every timeout and TTL in client/net/, http/auth.ts
 * and engine/party.ts — and the gate could not check a claim about any of them.
 *
 * IT ALSO BROKE THE AMBIGUITY GUARD, which is the worse half. `DEFAULT_MAX_TICKS`
 * is 200 in engine/scheduler.ts and 10_000 in shared/energy.ts. A name with two
 * values is supposed to resolve to `null` and be SKIPPED rather than guessed at
 * — but only one of the two declarations was ever seen, so the name looked
 * unambiguous and a claim about it would have been checked against 200.
 *
 * The separators are stripped where the value is stored, because a comment
 * states the number the way a person writes it.
 */
const DECL =
  /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\s*(?::[^=]+)?=\s*(-?[\d_]+(?:\.\d+)?)\s*[;,]/gm;
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
    const value = m[2].replaceAll('_', '');
    here.set(m[1], value);
    const seen = global.get(m[1]);
    global.set(m[1], seen === undefined || seen === value ? value : null);
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
    //
    // `/*` IS IN THE LIST BECAUSE OF THE ONE-LINE DOCBLOCK. `*` catches the
    // CONTINUATION lines of a block comment and `//` the line comments, so
    // `/** ... */` written on a single line -- which trims to a string starting
    // with `/` -- was silently skipped. This codebase writes that form
    // constantly, and the gate could not see a claim in any of them.
    //
    // MEASURED, NOT ARGUED. The check saw 17 claims before this line and 18
    // after: the one it had never looked at is in content/money.ts, and it
    // happened to be TRUE, so nothing was silently false. The hole is what
    // matters -- falsify that same comment and the committed gate printed
    // "constants in prose OK" over it. A gate that cannot see a whole comment
    // form is one stale edit away from mattering, and not drifting is the
    // entire point of this check.
    if (!trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*'))
      continue;
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

// ---------------------------------------------------------------------------
// SECOND PASS — THE SAME MISTAKE IN A STRING RATHER THAN IN A COMMENT
// ---------------------------------------------------------------------------
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SENTENCE THE PLAYER READS IS A PROMISE, AND IT DRIFTS THE SAME WAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The pass above checks COMMENTS, and on 2026-09-07 that turned out to be half
 * the problem. Four magnitudes reached the player as bare numerals inside
 * strings while the maths read them from a constant:
 *
 *     Stunned       "Deals 40% damage"     vs 0.4 in engine/damage.ts
 *     Stunned       "Three ready talents"  vs STUN_TALENT_LOCKOUT
 *     Off-balance   "15% less damage"      vs OFF_BALANCE_NUMBED
 *     Spellshocked  "by 20%"               vs SPELLSHOCK_RESIST
 *
 * MEASURED: moving `SPELLSHOCK_RESIST` from 20 to 25 left this gate green and
 * the sentence still promising 20%. A comment that lies costs the next reader
 * an hour; a status description that lies is the game explaining its own rules
 * wrongly to somebody who cannot read the source.
 *
 * ═══ SAME FILE ONLY, WHICH IS TWO OF THOSE FOUR ═══
 * A numeral matched against every constant in the codebase matches almost
 * everything — 1, 2, 3 and 4 are declared dozens of times — so this resolves
 * against the file's OWN declarations, exactly as the pass above prefers them.
 * That catches the Off-balance and Spellshocked shapes and NOT the Stunned one,
 * whose constant lived in another module. Naming that constant is what fixed
 * it, and no cheap check finds the next one of those; a rule that fires on 1s
 * and 2s across the tree would be switched off within a week, which protects
 * nothing.
 *
 * ═══ WHAT COUNTS AS A SENTENCE ═══
 * A quoted literal of twelve characters or more containing a space, on a line
 * that is not a comment, in `content/` or `talents/` — the two directories
 * where authored player text lives. Template holes are blanked first, because
 * `${String(FOO)}` is the composed form this check exists to encourage.
 *
 * A LINE WITH UNBALANCED BACKTICKS IS SKIPPED. A template literal spanning
 * several lines presents each middle line as a fragment with one backtick, and
 * the fragment is CODE — that produced the only false positive this rule had,
 * `shops.ts`'s `" ? 12 : item.tier === "`, which is the text between two holes
 * of a multi-line template and is not a sentence at all.
 */
const PROSE_ROOTS = ['src/server/content', 'src/server/talents'];
const LITERAL_MIN = 12;
const AS_PERCENT = 100;

/**
 * Quoted literals on a line, with template holes blanked to a non-digit.
 *
 * ═══ SCANNED LEFT TO RIGHT, BECAUSE A REGEX CANNOT PAIR QUOTES ═══
 * The first version used `/'([^'\n\\]{12,})'/g` and reported `shops.ts`'s
 * `rarity: item.tier === 'rare' ? 12 : item.tier === 'uncommon' ? 6 : 3` as a
 * sentence saying 12. It had matched from the CLOSING quote of `'rare'` to the
 * OPENING quote of `'uncommon'` — the code between two strings, which is not a
 * string at all. Consuming each literal and resuming after it is the fix, and
 * it is the difference between a rule with a permanent allowlist entry and a
 * rule that is simply right.
 */
function sentencesOn(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    const quote = line[i];
    if (quote !== "'" && quote !== '`') continue;
    let j = i + 1;
    while (j < line.length && line[j] !== quote) j += line[j] === '\\' ? 2 : 1;
    // An unterminated literal is a template spanning lines: the rest of this
    // line is CODE, so take nothing from it.
    if (j >= line.length) break;
    const text = line.slice(i + 1, j);
    if (text.length >= LITERAL_MIN && text.includes(' ')) {
      out.push(quote === '`' ? text.replaceAll(/\$\{[^}]*\}/g, 'X') : text);
    }
    i = j;
  }
  return out;
}

const prose = [];
let sentences = 0;
for (const [file, src] of sources) {
  if (!PROSE_ROOTS.some((root) => file.split(path.sep).join('/').startsWith(root))) continue;
  const here = perFile.get(file);
  if (here === undefined || here.size === 0) continue;

  for (const [i, line] of src.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const text of sentencesOn(line)) {
      sentences += 1;
      for (const num of text.match(/(?<![\w.X])\d+(?:\.\d+)?(?![\w])/g) ?? []) {
        for (const [name, raw] of here) {
          const value = Number(raw);
          const asWritten = value === Number(num);
          const asPercent =
            value > 0 && value < 1 && Math.round(value * AS_PERCENT) === Number(num);
          if (asWritten || asPercent) {
            prose.push({ at: `${file}:${String(i + 1)}`, name, value: raw, num, text });
          }
        }
      }
    }
  }
}

console.log('\nconstants in prose');
console.log(`  ok    ${String(checked)} comment(s) state a constant's value`);

if (wrong.length === 0) {
  console.log('  ok    every one of them matches the declaration');
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

console.log(`  ok    ${String(sentences)} authored sentence(s) in content/ and talents/`);
if (prose.length === 0) {
  console.log('  ok    none of them restates a number the same file declares');
  console.log('\nconstants in prose OK');
} else {
  for (const p of prose) {
    console.log(`  FAIL  ${p.at}`);
    console.log(`          "${p.text.slice(0, 68)}"`);
    console.log(`          says ${p.num}, and this file declares \`${p.name}\` = ${p.value}`);
  }
  console.log(
    `\nconstants in prose FAILED — ${String(prose.length)} authored sentence(s) state a\n` +
      'number the same file also declares as a constant. Compose it — `${String(FOO)}` —\n' +
      'so the sentence cannot drift from the maths. If the numeral genuinely has\n' +
      'nothing to do with that constant, rewording is the fix; this rule resolves\n' +
      'same-file only precisely so a coincidence is rare enough to be worth a look.',
  );
  process.exit(1);
}
