/**
 * Install the git pre-push hook. Runs from `npm run prepare`, i.e. after every
 * `npm install` / `npm ci`.
 *
 * WHY THIS IS A SCRIPT AND NOT JUST `git config core.hooksPath .githooks`
 *
 * That one-liner is correct on a developer machine and WRONG on a deploy
 * target. The game host has no git installed and is not a working tree — the
 * repo arrives there as a file copy — so the bare command exits non-zero and
 * takes the whole `npm ci` down with it, AFTER every package has already been
 * installed correctly. The result is a red, alarming failure that means nothing
 * and hides any real one that might follow it.
 *
 * A pre-push hook is a developer convenience. Its absence on a machine that
 * never pushes is the correct state, not an error. So: install it where it
 * makes sense, no-op quietly where it does not, and never fail the install.
 *
 * Deliberately silent on the happy path — `npm ci` output is noisy enough.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// Not a working tree (a deploy copy, or a tarball). Nothing to install into.
if (!existsSync(new URL('../.git', import.meta.url))) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repo,
    stdio: 'ignore',
  });
} catch {
  // git missing, or a git that dislikes this repo. Either way the developer
  // loses a convenience, not correctness: CI runs the identical `npm run check`
  // that the hook would have run.
  console.warn('note: could not set core.hooksPath — pre-push hook not installed');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS ANYTHING ACTUALLY GOING TO ANNOUNCE COMMITS? SAY SO IF NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 * `.githooks/post-commit` is gitignored, and correctly so: it carries an
 * absolute path to a relay outside this repository, and this repository is
 * public — a tracked copy would publish the author's home directory.
 *
 * The consequence is that A FRESH CLONE HAS NO ANNOUNCER AT ALL. `pre-push` is
 * tracked and arrives; `post-commit` does not. So every commit made on that
 * clone is announced by nothing, the ledger reports `pending 0` truthfully
 * about a channel that never received them, and there is no symptom whatsoever.
 * `git clean -xfd` does the same thing to an existing clone.
 *
 * This cannot install the hook — it does not know where the relay lives — but
 * it can refuse to let the absence be silent, which is the whole difference
 * between a missing feature and an invisible one.
 */
{
  const hook = `${repo}/.githooks/post-commit`;
  /**
   * `git config <key>` EXITS NON-ZERO WHEN THE KEY IS UNSET, so reading it
   * inside the outer try swallowed the very case this check exists for: an
   * unconfigured relay threw, the catch ate it, and the warning never printed.
   * Exactly the shape of bug being hunted, in the code hunting it.
   */
  let configured;
  try {
    configured = execFileSync('git', ['config', 'discord-relay.path'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    configured = '';
  }

  if (!existsSync(hook) || configured === '') {
    console.warn('');
    console.warn('  ⚠  NOTHING ON THIS CLONE WILL ANNOUNCE COMMITS TO #updates.');
    if (!existsSync(hook))
      console.warn('     .githooks/post-commit is absent (it is gitignored by design).');
    if (configured === '') console.warn('     git config discord-relay.path is unset.');
    console.warn('     Install it from _shared/discord-relay/install-hook.mjs, then');
    console.warn('     check with:  npm run updates');
    console.warn('');
  }
}
