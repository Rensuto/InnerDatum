/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES ANYTHING ACTUALLY PUT THIS STATUS ON A BODY?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An authored effect is content, and content this codebase has shipped before
 * without the one line that reaches it. `Wielder.immunities` was correct in five
 * of six layers and reached NO PLAYER, because `content/resolve.ts` merged ego
 * blocks field by field and did not know the new field existed — the egos rolled
 * 532 times in a 5,938-item sample and every one resolved to nothing.
 *
 * A status with a name, a badge, a description and a save channel that NOTHING
 * APPLIES is the same shape and reads the same way from inside: every unit test
 * passes, because each layer is right. `seen_worse.ts` says it about the mirror
 * case — "a resistance to a channel no content produces can only ever be
 * decoration".
 *
 * So: every `EffectId` must be named by something under `src/server` that is not
 * the catalogue itself, or be exempt below.
 *
 * ═══ THE ONE EXEMPTION, AND IT IS NOT A LOOPHOLE ═══
 * A CROSS-TIER effect is reached through a REGISTRY, never by name. Off-balance,
 * Spellshocked and Brainlocked declare `crossTierFor: <channel>`;
 * `createEffectState` indexes them by channel and `crossTierEffect` looks the id
 * up at :755-759, so the engine deliberately never writes `EffectId.OffBalance`
 * anywhere. A text search cannot see that and would report all three forever,
 * which is how a checker becomes noise and stops being read.
 *
 * The exemption is therefore keyed on the DECLARATION (`crossTierFor` present),
 * not on an allowlist of names — an effect only earns it by actually being in
 * the registry the engine reads.
 *
 * ═══ WHAT IT CANNOT SEE ═══
 * The same blind spot `tools/inert.mjs` documents: it matches TEXT. An effect
 * reached by some future string key would read as unreached here. It is a place
 * to start looking, and every finding needs the code read before it is believed.
 */
import fs from 'node:fs';
import path from 'node:path';

const CATALOGUE = 'src/server/content/effects.ts';

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const src = fs.readFileSync(CATALOGUE, 'utf8');

/** `  Stunned: 'effect:stunned',` inside the `EffectId` block. */
const ids = [...src.matchAll(/^ {2}([A-Za-z]+): '(effect:[a-z_]+)',/gm)].map((m) => ({
  key: m[1],
  id: m[2],
}));

/**
 * Which ids declare `crossTierFor`. Read off the DEF BLOCK rather than a list:
 * `export const OFF_BALANCE: EffectDef = Object.freeze({ id: EffectId.OffBalance,
 * ... crossTierFor: SaveChannel.Physical, ... });`
 */
const crossTier = new Set();
{
  /**
   * NEAREST PRECEDING `id:`, not a brace-matched block. These defs are long and
   * do not close at column zero, so a `Object.freeze({...})` regex silently
   * matched NOTHING and the first run reported all three cross-tier effects as
   * unreached — the exact false alarm this exemption exists to prevent, produced
   * by the exemption itself. Position association has no such failure mode:
   * both markers are one line each and neither nests.
   */
  const marks = [];
  for (const m of src.matchAll(/id:\s*EffectId\.([A-Za-z]+)|\bcrossTierFor:/g)) {
    marks.push({ at: m.index, key: m[1] });
  }
  let current = null;
  for (const mark of marks) {
    if (mark.key !== undefined) current = mark.key;
    else if (current !== null) crossTier.add(current);
  }
}

// Only the SERVER can apply a status. The client draws them and must not.
const files = walk('src/server', []).filter((f) => f !== CATALOGUE);
const blob = files.map((f) => [f, fs.readFileSync(f, 'utf8')]);

const unreached = [];
for (const { key, id } of ids) {
  if (crossTier.has(key)) continue;
  const hits = blob.filter(([, t]) => t.includes(`EffectId.${key}`) || t.includes(`'${id}'`));
  if (hits.length === 0) unreached.push({ key, id });
}

console.log('\neffect reach');
console.log(
  `  ${String(ids.length)} authored · ${String(crossTier.size)} reached through the ` +
    `cross-tier registry · ${String(ids.length - crossTier.size - unreached.length)} applied by name`,
);

for (const u of unreached) {
  console.log(
    `\nNOTHING APPLIES ${u.id}\n` +
      `  It has a name, a badge and a description, and no code under src/server\n` +
      `  names it. Every unit test for it can pass while no body ever gets it.\n` +
      `  Wire the thing that applies it, or delete the definition.`,
  );
}

console.log(
  unreached.length === 0
    ? '\neffect reach OK\n'
    : `\nEFFECT REACH FAILED — ${String(unreached.length)} authored status(es) reach nobody.\n`,
);
process.exit(unreached.length === 0 ? 0 : 1);
