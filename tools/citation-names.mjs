/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE CITED LINE HOLD THE TALENT THE CITATION NAMES?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/check-citations.mjs` is in the gate and answers two questions well:
 * the cited .lua exists, and the cited line is inside it. It cannot answer the
 * third, because it never reads what is AT that line — so
 *
 *     conditioning.lua:100-129 -- Unbreakable Will
 *
 * passes while those lines are Daunting Presence, and Unbreakable Will lives in
 * a different file, a different tree and a different kind of talent. A sweep of
 * the 67 talent files that claim ported NUMBERS found roughly eighteen
 * citations wrong in exactly that way: right file, right line range, wrong
 * talent. Some name a talent that exists nowhere in the reference tree at all.
 *
 * That is worse than a missing citation. A reader who follows it lands on real
 * Lua, reads the wrong formula, and concludes our number is wrong — or worse,
 * "corrects" ours to match a talent it was never ported from.
 *
 * ═══ WHAT IT DOES ═══
 * Indexes every `newTalent{` / `uberTalent{` / `newInscription{` block in the
 * cited file, reads the
 * `name = "..."` inside each, and asks whether the cited range overlaps the
 * block of the talent the citation names.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 * It only judges a citation that NAMES something. Most citations point at a
 * function, a table or a range of prose, and a name hint like
 * `statBonus = ceil(...)` or `(attackTarget)` is not a talent name — those are
 * skipped rather than guessed at. A checker that guessed would produce a column
 * of false rows, and `tools/talent-costs.mjs` records what that costs: "a sweep
 * that is more than half noise does not get read twice".
 *
 * ═══ IN `npm run check`, AND IT READS ZERO ═══
 * It was promoted once the eighteen defects it was written for were fixed. This
 * used to say "not yet... adding it to the gate today would just make the gate
 * red", which stayed true-looking long after it stopped being true — the same
 * shape of stale note this tool exists to catch, one level up.
 *
 * The count it prints is the number of citations JUDGED, not defects found, and
 * it is the number worth watching: 14 -> 18 when wrapped citations were joined,
 * 18 -> 28 when the bare `SHAPE:` form was added, 30 -> 41 for the QUOTED paren
 * form and 41 -> 51 for `(Name:` and the one-word-plus-dash. A drop means a form
 * stopped matching, which reads as "clean" and is not.
 *
 * ═══ 51 OF 61, AND THE REMAINING TEN ARE SUPPOSED TO BE THERE ═══
 * Every one of them cites a FORMULA rather than a talent: five stat passives at
 * `ghoul.lua:26` for `combatTalentScale(t, 2, 15, 0.75)`, two stances at
 * `chants.lua:31` for `sustain_positive = 20`, `loads` at `explosives.lua:44`
 * for a five-branch `computeDamage`, and `weight_of_office` at an `on_learn`
 * block. Naming a talent on any of those would claim a port that did not happen,
 * so the floor here is ten and not zero.
 *
 * IT NOW PRINTS ITS DENOMINATOR TOO, which is what made the last jump findable:
 * "41 judged" beside "20 name none" says how much of the port is actually
 * checked. It was 30 of 61 and nobody could see the 61.
 *
 * ═══ THE QUOTED FORM CAME WITH A LESSON WORTH KEEPING ═══
 * Adding it turned five CORRECT citations red at once, and every one was this
 * tool's fault rather than theirs: three Infusions are declared with
 * `newInscription{`, which the index did not know, and two names wrap across a
 * comment line and arrived with the join inside them. A gate that fails a
 * correct citation is worse than one that misses a wrong one — so the rule is
 * that a new FORM lands with whatever indexing and normalising it turns out to
 * need, in the same commit, not after somebody trusts the red.
 */
import fs from 'node:fs';
import path from 'node:path';

const REF = 'reference/t-engine4';
/**
 * How far above a citation to look for the talent's `short_name` before
 * concluding the lines are not about it. Ten is the gap in the one real case —
 * `called-shots.lua` names the talent at :21 and computes at :25-26 — and it is
 * short enough that the next talent's block cannot reach back over it.
 */
const HELPER_LOOKBEHIND = 10;
const DIR = 'src/server/talents';

/** A citation: a .lua path, a line or range, and whatever follows it. */
const CITE = /([A-Za-z0-9_/-]+\.lua):(\d+)(?:-(\d+))?([^\n]*)/g;

/** A Title Case run of two or more words, with ToME's lowercase particles. */
const TITLE = "[A-Z][A-Za-z']*(?:\\s+(?:of|the|a|an|and|on|in|to|for|from)|\\s+[A-Z][A-Za-z']*)+";

/**
 * The name a citation claims, from any of SIX house forms:
 *
 *     ...conditioning.lua:51-98 -- Vitality, the tree's regeneration talent.
 *     ...explosives.lua:207 (Shockwave Bomb) for the damage
 *     ...races.lua:332-347 ("Unshackled" — the Yeek's own, and the reason ...)
 *     ...explosives.lua:20-42 (Throw Bomb: `cooldown = 4`, a ball projector)
 *     ...npcs.lua:191-217 Stun -- the ghoul's own, and the melee half of ...
 *     ...combat-training.lua:125-127
 *              Light Armour Training -- `getArmorHardiness`, an asymptotic ...
 *
 * ═══ THE THIRD ONE IS THE `SHAPE:` BLOCK, AND IT WAS THE MAJORITY ═══
 * The first two require the name to follow `-- ` or sit inside parentheses. The
 * SHAPE:/NUMBERS: header wraps and puts the name BARE at the head of the next
 * line, so every citation written in the house's own most common form was
 * unjudged — ten of them, including the one defect this pass found
 * (`the_long_shift.ts`, which cited `getDefense`'s line for a hardiness curve).
 *
 * BARE MATCHING IS DELIBERATELY NARROW: two words minimum and every word
 * capitalised bar a particle. One capitalised word would read the `The` of any
 * wrapped sentence as a talent, which is the column of noise the header below
 * refuses to produce.
 */
function claimedName(tail) {
  const dash = /^\s*--\s+([A-Z][A-Za-z']*(?:\s+[A-Za-z'][A-Za-z']*)*)/.exec(tail);
  const paren = /^\s*\(([A-Z][A-Za-z']*(?:\s+[A-Za-z'][A-Za-z']*)*)\)/.exec(tail);
  /**
   * ═══ A FOURTH FORM, AND FOUR FILES WERE ALREADY WRITING IT ═══
   *
   *     ...races.lua:332-347 ("Unshackled" — the Yeek's own, and the reason ...)
   *
   * A QUOTED name inside the parenthesis, with prose after it. The `paren` form
   * above wants the bracket to close straight after the name, so every one of
   * these was skipped — `unshackled`, `wrath_of_the_woods`,
   * `overseer_of_nations` and `resilience_of_the_archived`, all of which name
   * their talent correctly and none of which was being checked.
   *
   * Found by trying to "fix" the files instead: appending ` -- Unshackled` to a
   * line that already said `("Unshackled"` produced a duplicate and taught the
   * lesson that the tool should learn the house's forms rather than the house
   * rewrite itself for the tool.
   */
  const quoted = /^\s*\("([^"]{2,})"/.exec(tail);
  /**
   * FIFTH AND SIXTH FORMS, both found by asking what the twenty UNJUDGED
   * citations actually look like rather than guessing:
   *
   *     ...explosives.lua:20-42 (Throw Bomb: `cooldown = 4`, a ball projector)
   *     ...npcs.lua:191-217 Stun -- the ghoul's own, and the melee half of ...
   *
   * `parenColon` is the commonest of the lot -- six files -- and `paren` above
   * misses it because that one wants the bracket to CLOSE after the name.
   *
   * `oneWordDash` exists because a talent may simply have a one-word name, and
   * the bare form refuses those on purpose: a lone capitalised word would read
   * the "The" of every wrapped sentence as a talent. Requiring a dash straight
   * after it is what makes it safe -- "Stun --", "Foresight —", "Unshackled --"
   * are names; "The armour must close again" is not.
   */
  const parenColon = /^\s*\(([A-Z][A-Za-z' ]{1,40}?):/.exec(tail);
  const oneWordDash = /^\s+([A-Z][A-Za-z']+)\s+(?:--|—)\s/.exec(tail);
  const bare = new RegExp(`^\\s+(${TITLE})`).exec(tail);
  const raw = (
    dash?.[1] ??
    paren?.[1] ??
    quoted?.[1] ??
    parenColon?.[1] ??
    bare?.[1] ??
    oneWordDash?.[1] ??
    ''
  ).trim();
  if (raw.length < 2) return null;
  // A name runs to the first comma; the rest of the line is prose about it.
  // A WRAPPED NAME ARRIVES WITH THE JOIN IN IT: "Luck of the Little" plus a
  // continuation line becomes "Luck of the Little              Folk" once the
  // two are glued, and that matches nothing. Collapse runs of space first.
  const name = raw.split(',')[0].trim().replace(/\s+/g, ' ');
  // One-word lowercase-ish tails and obvious code are not talent names.
  if (!/^[A-Z]/.test(name)) return null;
  if (name.includes('=') || name.includes('(')) return null;
  return name;
}

/** Every talent block in a Lua file: name -> [{ from, to, short }], 1-indexed. */
function talentBlocks(luaPath) {
  const lines = fs.readFileSync(luaPath, 'utf8').split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    // `newInscription` IS A TALENT DECLARATION TOO. `misc/inscriptions.lua`
    // declares all five Infusions with it, so indexing only newTalent/uberTalent
    // reported "Infusion: Healing is not in inscriptions.lua" about a name that
    // is on line 88 of it.
    if (/^\s*(newTalent|uberTalent|newInscription)\s*\{/.test(line)) starts.push(i);
  });
  const blocks = new Map();
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    // The block's `short_name`, when it declares one — it may sit on the same
    // line as `name` or its own, so the whole block is scanned for it.
    let short = null;
    for (let i = start; i < end; i += 1) {
      const sm = /short_name\s*=\s*"([^"]+)"/.exec(lines[i]);
      if (sm !== null) {
        short = sm[1];
        break;
      }
    }
    for (let i = start; i < end; i += 1) {
      const m = /^\s*name\s*=\s*"([^"]+)"/.exec(lines[i]);
      if (m === null) continue;
      const list = blocks.get(m[1]) ?? [];
      // 1-indexed and inclusive, to match how a citation is written.
      list.push({ from: start + 1, to: end, short });
      blocks.set(m[1], list);
      break;
    }
  });
  return blocks;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.lua')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NO REFERENCE TREE IS NOT A FAILURE — IT IS EVERY CLONE BUT THIS ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `reference/t-engine4` is gitignored and deliberately not distributed, so on a
 * fresh clone this directory does not exist and `walk` threw `ENOENT` — which
 * `npm run check` reported as a failed gate. Somebody cloning the repository to
 * read it got a red build on their first command, caused by the one directory
 * the repository tells them it does not ship.
 *
 * `check-citations.mjs` has had this guard since it was written and this tool,
 * its younger sibling, never grew one. Skipping is the honest answer: the
 * question this asks — does the cited Lua describe the talent it names — cannot
 * be asked without the Lua, and a check that cannot reach its question has not
 * failed, it has abstained. That is the same rule `npm run verify` states for
 * its probes: exit 0 when you proved your thing OR could not get to it, so only
 * a red line is ever a real fault.
 */
if (!fs.existsSync(REF)) {
  console.log('\ncitation names');
  console.log(`  skip  no ${REF} on this machine — nothing to check against`);
  console.log('\ncitation names SKIPPED');
  process.exit(0);
}

const byName = new Map();
for (const p of walk(`${REF}/game`, [])) {
  const base = p.split('/').pop();
  if (!byName.has(base)) byName.set(base, []);
  byName.get(base).push(p);
}

const wrongLines = [];
const notInFile = [];
let judged = 0;
/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE DENOMINATOR. "28 judged" says nothing without "of how many".
 * ════════════════════════════════════════════════════════════════════════════
 * This file's header already says to watch the judged COUNT rather than the
 * verdict, because a drop means a form stopped matching and that reads as clean.
 * It could not be watched properly: nothing said how many citations into a
 * `data/talents/` file were passed over, so 28 could have been 28 of 30 or 28 of
 * 90 and the output looked identical.
 *
 * `--unnamed` lists them. It is a LIST AND NOT A FAILURE, because most are
 * correct: a citation may point at a FORMULA rather than a talent -- five of our
 * stat passives cite `ghoul.lua:26` for `combatTalentScale(t, 2, 15, 0.75)`, and
 * naming "Ghoul" there would claim a port that did not happen. What the list is
 * for is finding the ones that SHOULD carry a name and do not, which is the only
 * way a citation becomes checkable at all.
 */
const unnamed = [];
const LIST_UNNAMED = process.argv.includes('--unnamed');

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const raw = src.split('\n');
  /**
   * ═══ THE NAME IS OFTEN ON THE NEXT LINE ═══
   * The house form wraps, and the wrapped half is where the name lives:
   *
   *     // SHAPE:   t-engine4 .../conditioning.lua:51-98
   *     //          -- Vitality, the conditioning tree's regeneration talent.
   *
   * Scanning line by line finds the citation with an empty tail and then a name
   * with no citation, so the first version of this tool judged 14 citations and
   * reported NOTHING — against a hand sweep that had already found eighteen. A
   * checker that comes back clean has to be run against a case known to be
   * wrong before it is believed.
   *
   * So a citation line carries the comment lines under it, up to the next line
   * that holds a citation of its own.
   */
  const lines = raw.map((line, i) => {
    CITE.lastIndex = 0;
    if (!CITE.test(line)) return line;
    let joined = line;
    for (let k = i + 1; k < raw.length; k += 1) {
      const next = raw[k];
      if (!/^\s*(\/\/|\*)/.test(next)) break;
      CITE.lastIndex = 0;
      if (CITE.test(next)) break;
      joined += ` ${next.replace(/^\s*(\/\/|\*)\s?/, '')}`;
    }
    CITE.lastIndex = 0;
    return joined;
  });
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CITE)) {
      const name = claimedName(m[4]);
      if (name === null) {
        // ONLY A TALENTS FILE. A citation into `class/` or `timed_effects/` names
        // no talent by construction and is not a gap.
        if (/\/data\/talents\//.test(m[1])) {
          unnamed.push({
            at: `${file}:${String(i + 1)}`,
            cited: `${m[1].split('/').pop()}:${m[2]}`,
          });
        }
        continue;
      }
      const base = m[1].split('/').pop();
      const candidates = byName.get(base);
      if (candidates === undefined) continue; // check-citations owns missing files
      const from = Number(m[2]);
      const to = Number(m[3] ?? m[2]);
      const at = `${file}:${String(i + 1)}`;

      // ANY candidate that HOLDS the name decides it — a bare basename may name
      // the engine's copy or the module's, and check-citations owns that split.
      let sawName = false;
      let overlapped = false;
      for (const lua of candidates) {
        const blocks = talentBlocks(lua);
        const spans = blocks.get(name);
        if (spans === undefined) continue;
        sawName = true;
        if (spans.some((s) => from <= s.to && to >= s.from)) overlapped = true;
        /**
         * ═══ A TALENT'S NUMBERS NEED NOT BE INSIDE ITS OWN BLOCK ═══
         * ToME hoists shared arithmetic into a file-local helper above the
         * talents that use it. `called-shots.lua` computes Sling Sniper's whole
         * band in `sniper_bonuses` at the TOP of the file, keyed off
         * `T_SKIRMISHER_SLING_SNIPER`, and `steady_hands.ts` correctly cites
         * :25-26 for it — 200 lines above the block named "Sling Sniper".
         *
         * Without this the first run of the bare form failed that citation, and
         * a gate that fails a CORRECT citation is worse than one that misses a
         * wrong one: the only way to green is to weaken a true reference.
         *
         * So a citation also passes when the talent's own `short_name` is in
         * view of the cited lines — the helper names the talent it computes for,
         * which is exactly what makes the citation honest.
         */
        const luaLines = fs.readFileSync(lua, 'utf8').split('\n');
        const near = luaLines.slice(Math.max(0, from - 1 - HELPER_LOOKBEHIND), to).join('\n');
        if (spans.some((s) => s.short !== null && near.includes(s.short))) overlapped = true;
      }
      judged += 1;
      if (sawName && !overlapped) {
        const lua = candidates[0];
        const spans = talentBlocks(lua).get(name) ?? [];
        wrongLines.push({
          at,
          name,
          cited: `${base}:${String(from)}${m[3] === undefined ? '' : `-${String(to)}`}`,
          actually: spans.map((s) => `${String(s.from)}-${String(s.to)}`).join(', '),
        });
      } else if (!sawName) {
        notInFile.push({ at, name, cited: base });
      }
    }
  });
}

console.log('\ncitation names');
console.log(`  ${String(judged)} citation(s) name a talent and were judged`);
console.log(
  `  ${String(unnamed.length)} citation(s) into a talents file name none ` +
    `(run with --unnamed to list them)`,
);
if (LIST_UNNAMED) {
  console.log('\n═══ CITES A TALENTS FILE AND NAMES NO TALENT ═══');
  console.log('  Not a fault list: a citation may name a FORMULA rather than a talent.');
  for (const u of unnamed) console.log(`  ${u.at.padEnd(40)} ${u.cited}`);
}

console.log(`\n═══ CITED LINES ARE NOT THAT TALENT (${String(wrongLines.length)}) ═══`);
for (const r of wrongLines) {
  console.log(`  ${r.at.padEnd(34)} "${r.name}" cited at ${r.cited}, actually ${r.actually}`);
}

console.log(`\n═══ NAMED TALENT IS NOT IN THE CITED FILE (${String(notInFile.length)}) ═══`);
for (const r of notInFile) {
  console.log(`  ${r.at.padEnd(34)} "${r.name}" is not in ${r.cited}`);
}

const wrong = wrongLines.length + notInFile.length;
console.log(
  wrong === 0
    ? '\ncitation names OK\n'
    : `\nCITATION NAMES FAILED — ${String(wrong)} citation(s) name something other than what is there.\nA citation that lands on real Lua and names the wrong talent is worse than a missing one:\nthe reader checks it, reads a formula we never ported from, and "corrects" ours to match.\n`,
);
process.exit(wrong === 0 ? 0 : 1);
