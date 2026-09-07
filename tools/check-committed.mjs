// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES WHAT IS IN GIT COMPILE? — asked of the COMMIT, not of the desk.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `npm run check` reads the WORKING TREE. For most of this repo's life that was
 * the same thing as the commit, and the distinction never mattered.
 *
 * ── THE DAY IT MATTERED ──
 *
 * Two agents work in this tree at once, so `git add <file>` would commit
 * somebody else's half-finished lines. The answer is to stage hunk by hunk —
 * and a script that dropped hunks by marker matched the marker against the
 * whole hunk, `@@` header included. Git writes the ENCLOSING FUNCTION'S
 * SIGNATURE into that header, so a marker naming a function dropped every hunk
 * inside it, mine among them. What went into git was a `Renderer` type
 * declaring `setUiScale` and `uiScale` with no implementation and a return
 * object missing both:
 *
 *     canvas.ts(2779,3): error TS2739: ... is missing the following properties
 *     from type 'Renderer': setUiScale, uiScale
 *
 * It survived two commits, a full green gate, and a live deploy. Nothing was
 * broken and nothing could see it: the gate checks the tree and the tree was
 * complete, and `tools/deploy-live.ps1` packages the tree too, so the running
 * game was built from the code that existed rather than the code that shipped.
 * A clean clone did not build.
 *
 * A TREE-CHECKING GATE IS STRUCTURALLY BLIND TO A PARTIAL COMMIT, and partial
 * commits are routine here. So this asks the other question, and the only way
 * to ask it honestly is to build what is actually in the object database.
 *
 * ── WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT ──
 *
 * TYPECHECK ONLY, all three projects. That is the whole failure class: a
 * commit missing lines is a commit that does not compile. Lint, format and
 * 4,600 tests would find it too, and would turn a 40-second guard into a
 * four-minute one at the exact moment somebody is trying to push a hotfix
 * during a live session. `npm run check` already ran all of that against a
 * tree that is a SUPERSET of the commit.
 *
 * THE TIP ONLY, not every commit in the push. Bisecting through a broken
 * middle commit is a real cost and this does not pay it; walking a weekend of
 * commits is minutes per push, which is how a gate gets `--no-verify`d.
 *
 * NOTHING IS STASHED, MOVED OR CLEANED. It builds a detached worktree in the
 * system temp directory and removes it afterwards. The tree you are working in
 * is never touched, which is the point — the manual version of this check was
 * `git stash --include-untracked && npm run check && git stash pop`, and that
 * is a dangerous thing to advise somebody to run while another agent is
 * writing files.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ref = process.argv[2] ?? 'HEAD';

/** Run a command, return {status, out}. Never throws on a non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const root = run('git', ['rev-parse', '--show-toplevel']).out.trim();
if (root === '') {
  console.log('check-committed: not a git repository — nothing to check.');
  process.exit(0);
}

/**
 * NODE_MODULES IS LINKED, NEVER INSTALLED. `npm ci` into a throwaway worktree
 * is a minute and a network round trip; the dependencies of a commit made five
 * seconds ago are the ones already on disk. If they are absent this cannot run
 * at all, and says so rather than passing — a guard that reports OK when it did
 * nothing is worse than no guard.
 */
const modules = path.join(root, 'node_modules');
if (!fs.existsSync(modules)) {
  console.error('check-committed: node_modules is missing — run `npm install` first.');
  process.exit(1);
}

const tsc = path.join(modules, 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.error('check-committed: typescript is not installed — run `npm install` first.');
  process.exit(1);
}

const sha = run('git', ['rev-parse', '--short', ref]).out.trim();
const subject = run('git', ['log', '-1', '--format=%s', ref]).out.trim();

const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'innerdatum-committed-'));
// mkdtemp CREATES the directory and `git worktree add` refuses a non-empty one,
// so hand git a path one level down that does not exist yet.
const tree = path.join(wt, 'tree');

let failed = false;
try {
  const add = run('git', ['worktree', 'add', '--detach', '--quiet', tree, ref], { cwd: root });
  if (add.status !== 0) {
    console.error(`check-committed: could not check out ${ref}\n${add.out}`);
    process.exit(1);
  }

  // 'junction' rather than 'dir': on Windows a directory symlink needs either
  // Developer Mode or an elevated shell, and a junction needs neither. It is
  // ignored on POSIX, where the third argument does not apply.
  fs.symlinkSync(modules, path.join(tree, 'node_modules'), 'junction');

  console.log(`check-committed: ${sha}  ${subject}`);

  for (const project of ['tsconfig.shared.json', 'tsconfig.server.json', 'tsconfig.client.json']) {
    const res = run(process.execPath, [tsc, '-p', project, '--noEmit'], { cwd: tree });
    if (res.status === 0) {
      console.log(`  ok    ${project}`);
      continue;
    }
    failed = true;
    console.error(`  FAIL  ${project}`);
    // Paths in the output are relative to the throwaway worktree, which is a
    // directory the reader has never heard of. Say which is which rather than
    // leaving them to work it out from a temp path.
    console.error(res.out.trim().replace(/^/gm, '        '));
  }
} finally {
  // `--force` because the worktree has a node_modules link git did not put
  // there. Failure to clean up must not fail the check: a leftover directory in
  // the temp folder is a nuisance, a false red is a bypassed gate.
  run('git', ['worktree', 'remove', '--force', tree], { cwd: root });
  fs.rmSync(wt, { recursive: true, force: true });
}

if (failed) {
  console.error('');
  console.error(`check-committed: ${sha} does not compile from a clean checkout.`);
  console.error('  Your working tree may well be fine — that is the whole point of this');
  console.error('  check. Something you changed is on disk but not in the commit.');
  console.error('  Look at:  git diff HEAD -- <the file named above>');
  process.exit(1);
}

console.log('check-committed OK');
