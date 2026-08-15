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

const secrets = readEnvSecrets();
const bundleFiles = walk(DIST).filter((f) => /\.(js|mjs|css|html|map|json)$/i.test(f));

console.log('\nsecret containment');

if (!existsSync(DIST)) {
  console.log('  skip  client/dist not built — run `npm run build:client` for the full check');
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

const SCAN_DIRS = ['src', 'tools', 'test', 'content', 'docs', '.github'];
const SKIP = /node_modules|client[\\/]dist|reference|\.git[\\/]|package-lock\.json/;

let scanned = 0;
const hits = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(REPO, dir))) {
    if (SKIP.test(file)) continue;
    if (!/\.(ts|mjs|js|json|md|yml|yaml|html|css|py)$/i.test(file)) continue;
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      const m = re.exec(text);
      if (m) hits.push({ file: relative(REPO, file), name, sample: `${m[0].slice(0, 12)}…` });
    }
  }
}

// Root-level files that ship, checked too.
for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'vite.config.ts']) {
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

const gitignore = existsSync(join(REPO, '.gitignore'))
  ? readFileSync(join(REPO, '.gitignore'), 'utf8')
  : '';
if (!/^\.env$/m.test(gitignore)) {
  fail('.gitignore no longer contains a bare `.env` rule');
} else {
  pass('.env is gitignored');
}

console.log(
  failures === 0 ? '\nsecret containment OK\n' : `\nSECRET CONTAINMENT FAILED (${failures})\n`,
);
process.exit(failures ? 1 : 0);
