#!/usr/bin/env node
/**
 * updates — is the #updates channel current with the work?
 *
 * ============================================================================
 * WHY THIS EXISTS WHEN `relay.mjs status` ALREADY DOES MOST OF IT
 * ============================================================================
 * Because `pending 0` answers the wrong question.
 *
 * `relay.mjs status` compares the ANNOUNCEMENT LEDGER against the COMMIT LOG,
 * so it says "every commit has been announced". That is true and insufficient:
 * the failure that actually happened on this project was nine hundred lines
 * sitting uncommitted for an hour while `pending 0` was perfectly accurate the
 * whole time. The channel was silent, the machinery was working, and the status
 * command agreed with the machinery rather than with the person watching the
 * channel.
 *
 * What a reader of #updates cares about is not "is the ledger consistent" but
 * "does the channel know what has been done". So this compares the ledger
 * against the WORKING TREE, which is the only definition under which "current"
 * means what it sounds like.
 *
 * ============================================================================
 * IT DOES NOT FAIL, AND THAT IS DELIBERATE
 * ============================================================================
 * A dirty tree is the normal state of someone mid-task. Exiting non-zero for it
 * would make this unrunnable during the exact work it is meant to keep honest,
 * and a check people cannot run during work is a check people stop running.
 * It reports; the pre-push hook is what enforces, at the last moment before the
 * work becomes public.
 *
 * No dependencies: Node 24 and node:* only.
 */

import { execFileSync, spawnSync } from 'node:child_process';

const RELAY = 'c:/Users/dalto/Desktop/Files/VSCode Projects/_shared/discord-relay/relay.mjs';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 1. The ledger's answer: which COMMITS are not announced.
// ---------------------------------------------------------------------------
// ═══ THE REPORT COMES BACK ON *STDERR*, AND READING ONLY STDOUT BROKE THIS ═══
// relay.mjs routes routine diagnostics through `warn` (stderr) and keeps stdout
// for the one line a hook cares about ("posted <sha>"). `status` is entirely
// routine, so `execFileSync` — which returns stdout — captured an empty string:
// the report printed nothing, and worse, the `pending` count below parsed 0 out
// of that emptiness and would have declared a real backlog clean.
//
// `spawnSync` is used instead of `execFileSync` for exactly that reason: it
// hands back BOTH streams, so the count is read from the text that actually
// contains it. A fittingly ironic bug for a tool whose job is noticing silence.
const run = spawnSync(process.execPath, [RELAY, 'status', '--repo', '.'], {
  encoding: 'utf8',
});

if (run.error !== undefined || run.status !== 0) {
  // A relay that cannot run is itself the finding, and it must be LOUD: a
  // silent channel and a broken relay look identical from the outside, which is
  // the whole reason this project keeps auditing this pipeline.
  console.error('updates: THE RELAY DID NOT RUN. The channel cannot be trusted.');
  console.error('');
  console.error(run.stderr || String(run.error ?? `exit ${String(run.status)}`));
  process.exitCode = 1;
}

const report = `${run.stdout ?? ''}${run.stderr ?? ''}`;

if (process.exitCode !== 1) {
  process.stdout.write(report);

  const pending = Number(/pending\s+(\d+)/.exec(report)?.[1] ?? '0');

  // -------------------------------------------------------------------------
  // 2. The honest answer: what the channel CANNOT know about, because it is not
  //    a commit yet.
  // -------------------------------------------------------------------------
  const dirty = git(['status', '--porcelain'])
    .split('\n')
    .filter((l) => l.trim() !== '');

  console.log('');
  console.log('─'.repeat(64));

  if (pending > 0) {
    console.log(`  ${pending} commit(s) made but NOT announced.`);
    console.log('  Fix:  npm run updates:catchup');
    /**
     * NON-ZERO, so this is checkable by a machine and not only by a reader.
     *
     * A verification command that exits 0 while reporting a backlog can be
     * "run" without being READ, which is precisely the failure this whole
     * pipeline keeps having: everything works, nobody notices, the channel is
     * silent. An unannounced commit is a defect, so it exits like one.
     *
     * THE DIRTY-TREE BRANCH BELOW DELIBERATELY DOES NOT. That is the normal
     * state of someone mid-task, and failing on it would make this unrunnable
     * during the exact work it exists to keep honest.
     */
    process.exitCode = 1;
  }

  if (dirty.length > 0) {
    console.log(`  ${dirty.length} file(s) changed but NOT committed.`);
    console.log('  The channel cannot know about work that is not a commit —');
    console.log('  this is the failure mode that has actually happened here.');
    console.log('  Fix:  commit in increments small enough to be worth announcing.');
    for (const line of dirty.slice(0, 8)) console.log(`      ${line}`);
    if (dirty.length > 8) console.log(`      ... and ${dirty.length - 8} more`);
  }

  if (pending === 0 && dirty.length === 0) {
    console.log('  CURRENT — every change is committed and every commit is announced.');
  }
  console.log('─'.repeat(64));
}
