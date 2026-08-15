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
