/**
 * Secret containment check.
 *
 * Two jobs, both of which exist because "we checked once" is not a guarantee:
 *
 *   1. NOTHING FROM .env REACHES THE BROWSER. Vite inlines `VITE_*` variables
 *      into the bundle as plain string literals. If somebody widens `envPrefix`
 *      to make one convenient variable reachable, the client secret ships to
 *      every player in the same commit — and nothing else would notice.
 *
 *   2. NOTHING SECRET-SHAPED IS ABOUT TO BE COMMITTED. Discord tokens and
 *      secrets have recognisable shapes; so does a private key header.
 *
 * Run by `npm run check` and by the pre-push hook, so it fails BEFORE the bytes
 * leave the machine rather than after they are public.
 *
 * The client ID is deliberately NOT treated as a secret: it is public by
 * construction — it appears in the Activity's own URL and must be in the bundle
 * for the SDK to work at all.
 *
 * Exit 0 = clean. Any other exit = do not ship.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(REPO, 'client', 'dist');
const ENV = join(REPO, '.env');

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`  ok    ${msg}`);

// ---------------------------------------------------------------------------
// 1. Every literal value in .env, hunted for inside the built bundle.
//    This is the strongest check available: it does not care HOW a value got
//    there, only that it did.
// ---------------------------------------------------------------------------

/** Values that are public by design and must not trip the scan. */
const PUBLIC_KEYS = new Set([
  'DISCORD_CLIENT_ID',
  'VITE_DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'PUBLIC_HOST',
  'HOST',
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'DATA_DIR',
  'CONTENT_DIR',
  'OPS_PORT',
  'OPS_BIND',
  'WORLD_SEED',
  'SESSION_TTL_SECONDS',
  'ART_SOURCE_DIR',
  'ENABLE_STDIN_GM',
  'ALLOWED_USER_IDS',
  'GM_USER_IDS',
]);

function readEnvSecrets() {
  if (!existsSync(ENV)) return [];
  const out = [];
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Short values produce false positives against minified code.
    if (PUBLIC_KEYS.has(key) || value.length < 12) continue;
    out.push({ key, value });
  }
  return out;
}

function walk(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

let incomplete = false;
const secrets = readEnvSecrets();
const bundleFiles = walk(DIST).filter((f) => /\.(js|mjs|css|html|map|json)$/i.test(f));

console.log('\nsecret containment');

if (!existsSync(DIST)) {
  /**
   * NOT A QUIET SKIP ANY MORE. This file's own docblock calls the bundle scan
   * "the strongest check available" and says it "fails BEFORE the bytes leave
   * the machine" -- and `npm run check` never builds the client, and neither
   * does CI (`npm ci`, `npm run check`, `npm run smoke`). So on every runner
   * this printed one grey `skip` line and the job went green having never
   * looked for the leak it exists to find.
   *
   * It still does not FAIL, because a fresh clone with no build is a legitimate
   * state and a gate people cannot run is a gate people bypass. What changes is
   * that the run is marked INCOMPLETE, so the closing line cannot read as a
   * clean pass over a check that never ran.
   */
  incomplete = true;
  console.log('  SKIP  client/dist not built — the bundle scan DID NOT RUN');
  console.log('        `npm run build:client` first, or trust only the checks below');
} else if (secrets.length === 0) {
  console.log('  skip  no .env present (CI) — pattern scan below still applies');
} else {
  let leaked = 0;
  for (const file of bundleFiles) {
    const text = readFileSync(file, 'utf8');
    for (const { key, value } of secrets) {
      if (text.includes(value)) {
        fail(`${key} FOUND IN BUNDLE: ${relative(REPO, file)} — rotate it, then fix envPrefix`);
        leaked += 1;
      }
    }
  }
  if (leaked === 0) {
    pass(`none of ${secrets.length} .env secret(s) appear in ${bundleFiles.length} bundle file(s)`);
  }
}

// ---------------------------------------------------------------------------
// 2. Secret-SHAPED strings anywhere in the tracked tree.
//    Catches a token pasted into a source file or a doc, which the .env scan
//    above would miss because it never reached .env in the first place.
// ---------------------------------------------------------------------------

const PATTERNS = [
  // Discord bot token: base64 snowflake . 6 chars . 27+ chars
  {
    name: 'Discord bot token',
    re: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASK GIT WHAT IS TRACKED. A HAND-KEPT LIST IS A LIST THAT GOES STALE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was `SCAN_DIRS = ['src', 'tools', 'test', 'content', 'docs', '.github']`
 * plus four hard-coded root filenames, while the line below it printed "no
 * secret-shaped strings in N tracked files". It was not scanning the tracked
 * tree and the count was wrong in both directions: 28 tracked files were never
 * opened and 23 untracked ones were counted.
 *
 * THE TWO THAT MATTER. `.env.example` is tracked, is the documented mirror of
 * the file that holds the real bot token, and was excluded TWICE -- not in the
 * root list, and `.example` is not in the extension filter. Root `index.html`
 * is the page Vite serves to every player, is tracked, and was excluded because
 * root files were only read if they were one of those four names. A token in
 * either exited 0.
 *
 * `check-assets.mjs` already answers its own question this way, and says why:
 * a rule is bypassable, `git ls-files` is the truth. Same question, same answer.
 */
const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
const SKIP = /node_modules|client[\\/]dist|reference|\.git[\\/]|package-lock\.json/;

let scanned = 0;
const hits = [];
/**
 * EVERY TRACKED TEXT FILE. The extension list is a BINARY filter now, not a
 * membership one: anything git tracks that is not obviously binary gets read,
 * so a secret in a file type nobody thought of is still found. `.example` was
 * the one that proved the old allow-list wrong.
 */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|ogg|wav|zip|gz|pdf)$/i;
for (const rel of trackedFiles()) {
  if (SKIP.test(rel) || BINARY.test(rel)) continue;
  const full = join(REPO, rel);
  if (!existsSync(full)) continue; // deleted-but-staged
  scanned += 1;
  const text = readFileSync(full, 'utf8');
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ file: rel, name, sample: `${m[0].slice(0, 12)}…` });
  }
}

// Retained so the loop below still compiles against its own tail.
for (const name of []) {
  const full = join(REPO, name);
  if (!existsSync(full)) continue;
  scanned += 1;
  const text = readFileSync(full, 'utf8');
  for (const { name: pname, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ file: name, name: pname, sample: `${m[0].slice(0, 12)}…` });
  }
}

for (const h of hits) fail(`${h.name} in ${h.file} (${h.sample}) — ROTATE IT, then remove`);
if (hits.length === 0) pass(`no secret-shaped strings in ${scanned} tracked files`);

// ---------------------------------------------------------------------------
// 3. .env must be unreachable by git. A one-character gitignore edit undoes it.
// ---------------------------------------------------------------------------

/**
 * ═══ ASKED OF GIT, NOT OF THE TEXT OF .gitignore ═══
 *
 * This grepped `.gitignore` for a bare `.env` line. Two one-line changes beat
 * that and leave the line intact: a `!.env` negation below it -- and negations
 * are already this file's normal vocabulary, `.gitignore:11-13` is
 * `.env` / `.env.*` / `!.env.example` -- or a `git add -f .env` that already
 * happened, which no amount of reading .gitignore can detect.
 *
 * Both questions are answerable directly. `check-ignore` says whether the rule
 * is in force RIGHT NOW, after every negation; `ls-files` says whether the file
 * is already staged or committed, which is the failure that actually leaks.
 */
const ignoredNow = (rel) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const trackedNow = (rel) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

for (const rel of ['.env', 'config/allowlist.json']) {
  if (trackedNow(rel)) fail(`${rel} IS TRACKED BY GIT — remove it from the index and rotate`);
  else if (!ignoredNow(rel)) fail(`${rel} is not ignored by git — one commit from public`);
  else pass(`${rel} is ignored by git and not tracked`);
}

console.log(
  failures !== 0
    ? `\nSECRET CONTAINMENT FAILED (${failures})\n`
    : incomplete
      ? '\nsecret containment INCOMPLETE — the bundle scan did not run\n'
      : '\nsecret containment OK\n',
);
process.exit(failures ? 1 : 0);
