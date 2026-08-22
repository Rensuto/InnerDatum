/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PORT WITHOUT ITS HEADER IS A LICENCE PROBLEM, SO THE GATE CHECKS FOR ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CONTRIBUTING.md: *"If you port more logic from ToME, the file header is
 * mandatory"*, and names all four lines —
 *
 *     // SPDX-License-Identifier: GPL-3.0-or-later
 *     // Copyright (C) 2026 Dalton Barraclough
 *     // Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:1444-1462
 *     // T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license
 *
 * — adding that it "is a licence courtesy and a debugging lifeline in equal
 * measure. A port without a citation will be sent back."
 *
 * Translating Lua to TypeScript produces a derivative work (CONTRIBUTING.md
 * § licence), so this is not style. It is the condition on which the port is
 * allowed to exist.
 *
 * ═══ WHY THIS ONE IS A GATE WHEN THE OTHER SWEEPS ARE NOT ═══
 * `tools/inert.mjs` and `tools/talent-costs.mjs` deliberately stay out of
 * `npm run check`, because their findings need judgement — a deliberately
 * unused constant and a deliberately rescaled cost are both fine, and a gate
 * that fails on them is a gate people learn to silence.
 *
 * This rule has no judgement in it. A file that says "Ported from" either
 * carries the other three lines or does not. There is no defensible reason to
 * declare a port and omit the attribution, so failing is always correct.
 *
 * ═══ IT ASKS THE FILE, RATHER THAN GUESSING WHETHER IT IS A PORT ═══
 * Deciding what counts as ported from the body would mean flagging every file
 * that merely MENTIONS upstream — and this codebase argues with ToME in prose
 * constantly, in files that port nothing. So the trigger is the declaration
 * itself: `Ported from`, `NUMBERS:` or `SHAPE:` in the first lines. A file that
 * makes no claim is asked for nothing, which is why 53 original client-side
 * files carry no SPDX and are not failures.
 *
 * The first run over 182 files found 110 declaring a port and every one of them
 * complete. This exists so that stays true.
 */
import fs from 'node:fs';
import path from 'node:path';

/** How many lines of header a declaration may hide in. Citations run long. */
const HEADER_LINES = 20;

const DECLARES = /^\/\/\s*(Ported from|NUMBERS:|SHAPE:)/m;
const REQUIRED = [
  { name: 'SPDX-License-Identifier', re: /SPDX-License-Identifier:\s*GPL-3\.0-or-later/ },
  { name: 'Copyright (C) … Dalton Barraclough', re: /Copyright \(C\) \d{4} Dalton Barraclough/ },
  {
    name: 'T-Engine4 (C) 2009-2018 Nicolas Casalini',
    re: /T-Engine4 \(C\) 2009-2018 Nicolas Casalini/,
  },
];

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
const failures = [];
let ports = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const head = src.split('\n').slice(0, HEADER_LINES).join('\n');
  if (!DECLARES.test(head)) continue;
  ports += 1;
  const missing = REQUIRED.filter((line) => !line.re.test(src)).map((line) => line.name);
  if (missing.length > 0) failures.push({ file, missing });
}

console.log('\nport attribution');
console.log(`  ok    ${String(files.length)} source file(s) scanned`);
console.log(`  ok    ${String(ports)} declare a port from t-engine4`);

if (failures.length === 0) {
  console.log('  ok    every one carries the full header CONTRIBUTING.md requires');
  console.log('\nport attribution OK');
} else {
  for (const { file, missing } of failures) {
    console.log(`  FAIL  ${file}`);
    for (const line of missing) console.log(`          missing: ${line}`);
  }
  console.log(
    `\nport attribution FAILED — ${String(failures.length)} file(s) declare a port without\n` +
      'the header CONTRIBUTING.md calls mandatory. Translating Lua to TypeScript makes a\n' +
      'derivative work; the attribution is the condition on which it may exist.',
  );
  process.exit(1);
}
