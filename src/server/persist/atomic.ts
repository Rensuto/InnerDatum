// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE HAND-ROLLED ATOMIC WRITE — PLAN.md risk R9, and the reason no library
 *   is used for the one operation a library exists for.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ON WINDOWS, `fs.rename` OVER AN EXISTING FILE THROWS. Defender's real-time
 * scanner and the Windows Search indexer both open recently-written files
 * WITHOUT `FILE_SHARE_DELETE`, and while such a handle is open `MoveFileEx`
 * fails: `ERROR_SHARING_VIOLATION` surfaces as `EBUSY` and
 * `ERROR_ACCESS_DENIED` as `EPERM`. The window is milliseconds and it opens
 * precisely because we just wrote the temp file — which is to say, it opens on
 * every single save, and the odds of losing one are a coin the host machine
 * flips for us. The dev box and the deploy target are both Windows
 * (DECISIONS.md), so this is not a portability nicety; it is the main case.
 *
 * NEITHER LIBRARY HELPS, AND BOTH LOOK LIKE THEY WOULD:
 *
 *   `write-file-atomic` — temp file, `fsync`, rename. No retry ANYWHERE in the
 *     rename path. Its one `EPERM` special case is for `chown`/`chmod`, not for
 *     the rename. An EPERM from the rename propagates to the caller unmodified.
 *
 *   `graceful-fs` — patches `fs.rename` with a backoff retry, and it is the
 *     obvious answer until you read the condition: it retries only while
 *     `er.code === 'EPERM'` AND `fs.stat(dest)` reports the destination is
 *     ABSENT. For an overwrite the destination is by definition present, so the
 *     retry never fires. It is written for `rename`-onto-nothing, which is the
 *     case that was never failing.
 *
 * So: ~60 lines, five decisions, each with its reason spelled out.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE GUARANTEES
 * ───────────────────────────────────────────────────────────────────────────
 * At every instant, and after any crash at any instant, the destination path
 * holds EITHER the complete previous contents OR the complete new contents.
 * Never a prefix, never a zero-byte file. Plus a one-generation `.bak` of the
 * previous contents, as a second chance when the "complete previous contents"
 * turn out to have been complete garbage.
 *
 * It does NOT guarantee mutual exclusion between two concurrent writers of the
 * same path — the last rename wins, and the loser is silently discarded. That
 * is `saves.ts`'s job (it serialises per path) because the ordering policy
 * belongs to whoever knows which snapshot is newer.
 *
 * NOT IN src/server/engine/**. The engine is synchronous by AST rule; this
 * file is nothing but `await`. Persistence is queued by the CALLER after
 * `pump` returns, and the direction of that dependency is enforced by ESLint.
 */

import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pid, platform } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Rename failures worth waiting out.
 *
 * `EPERM` / `EBUSY` are the two Defender and the indexer actually produce.
 * `EACCES` is the same class of transient lock from an antivirus that reports
 * differently, and `UNKNOWN` is what libuv emits when the underlying Win32
 * error has no errno mapping — which several third-party filter drivers hit.
 *
 * Deliberately NOT retried: `ENOENT` (the temp file vanished — a real bug, and
 * retrying hides it), `ENOSPC` (waiting will not create disk space), `EXDEV`
 * (a cross-device rename, which cannot happen here because the temp file is
 * created in the destination's own directory, and if it ever did the rename
 * would not be atomic anyway).
 */
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'UNKNOWN',
]);

/**
 * Eight attempts at 10 ms doubling to a 250 ms ceiling ≈ 0.9 s of patience.
 *
 * Sized against the thing being waited out: a Defender scan of a file measured
 * in kilobytes is tens of milliseconds, and the indexer's handle is comparably
 * short. Nine hundred milliseconds is therefore ~20× the expected hold. Longer
 * would mean a genuinely stuck file (a save opened in an editor) blocks the
 * autosave loop for seconds at a time, which is worse than surfacing the error.
 *
 * No jitter, on purpose: `saves.ts` serialises writes per path and this is a
 * single-process server for under ten players, so there is no herd to spread.
 */
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 10;
const MAX_DELAY_MS = 250;

/** Something recoverable happened. Surfaced rather than swallowed; see `onWarn`. */
export type AtomicWarning =
  | {
      readonly kind: 'rename_retry';
      readonly path: string;
      /** 1-based. `attempt === attempts` never appears — that one throws. */
      readonly attempt: number;
      readonly code: string;
      readonly delayMs: number;
    }
  | {
      /**
       * The `.bak` copy failed. NON-FATAL, and that is the point: a missing
       * second chance must never cost you the first one, so the primary write
       * proceeds regardless.
       */
      readonly kind: 'backup_failed';
      readonly path: string;
      readonly code: string;
    };

export type AtomicWriteOptions = {
  /** Keep a one-generation `.bak` of the previous contents. Default true. */
  readonly backup?: boolean;
  /** Total rename attempts, including the first. Default 8. */
  readonly attempts?: number;
  /** First backoff step in ms; doubles to a 250 ms ceiling. Default 10. */
  readonly baseDelayMs?: number;
  /**
   * Injected so a test can prove the backoff SCHEDULE without spending a real
   * second of wall clock on it. Default is `node:timers/promises`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries and backup failures. `saves.ts` forwards these to the logger. */
  readonly onWarn?: (warning: AtomicWarning) => void;
};

/**
 * The previous generation, beside the file rather than in a `.bak/` directory.
 *
 * docs/data-schemas.md § 2 sketches `data/.bak/`; a sibling is used instead so
 * that the backup is unconditionally on the same volume and in the same
 * directory as the file it protects. A backup one directory-permission change
 * away from being unwritable is not a backup.
 */
export function backupPathFor(file: string): string {
  return `${file}.bak`;
}

/** Monotonic within the process; the pid separates processes. */
let tempSequence = 0;

/**
 * The temp file goes IN THE DESTINATION'S OWN DIRECTORY. This is the single
 * most important line in the file: `rename` is only atomic within a
 * filesystem, and a `data/.tmp/` directory is one `mklink` or one moved data
 * folder away from being a different volume — at which point Node falls back
 * to copy-then-unlink, the write stops being atomic, and nothing anywhere
 * reports that it happened.
 *
 * Leading dot plus a trailing `.tmp` so a half-written file is obviously
 * scratch to a human looking at the directory after a crash.
 */
function tempPathFor(file: string): string {
  tempSequence += 1;
  return join(dirname(file), `.${basename(file)}.${pid}.${tempSequence}.tmp`);
}

/** The errno off an unknown thrown value, or '' when it carries none. */
export function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return '';
}

/**
 * Rename, waiting out the transient Windows locks described in the header.
 *
 * The loop exits only by returning or throwing, so a non-retryable error and
 * an exhausted budget both surface the ORIGINAL error object — errno, path and
 * stack intact — rather than a wrapper that loses the cause.
 */
async function renameWithBackoff(
  from: string,
  to: string,
  attempts: number,
  baseDelayMs: number,
  sleep: (ms: number) => Promise<void>,
  onWarn: ((warning: AtomicWarning) => void) | undefined,
): Promise<void> {
  let wait = baseDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(code)) throw err;
      onWarn?.({ kind: 'rename_retry', path: to, attempt, code, delayMs: wait });
      await sleep(wait);
      wait = Math.min(wait * 2, MAX_DELAY_MS);
    }
  }
}

/**
 * Write `contents` to `file` so that a reader never sees a partial file.
 *
 * THE ORDER, and every step is load-bearing:
 *
 *   1. `mkdir -p` the destination directory. Cheap, idempotent, and the
 *      alternative is an ENOENT on the first save of a fresh install.
 *   2. Write the whole payload to a temp file in THAT SAME DIRECTORY.
 *   3. `fh.sync()` BEFORE closing. A rename is atomic with respect to other
 *      readers, but it says nothing about the disk: without the fsync the
 *      directory entry can reach the platter while the data is still in the
 *      page cache, and a power cut in that window leaves a correctly-named
 *      file full of zeroes. This is the step every hand-rolled version forgets
 *      and the one that only ever fails during an actual power cut.
 *   4. Copy the current contents to `.bak` — a COPY, not a rename, so the
 *      destination is never momentarily absent. A torn `.bak` is survivable; a
 *      missing primary is not.
 *   5. Rename temp → destination, with the backoff above.
 *   6. fsync the PARENT DIRECTORY — on POSIX only. See the note there.
 *
 * On any failure after step 2 the temp file is removed, so a run of failures
 * cannot litter the data directory.
 */
export async function writeFileAtomic(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => delay(ms));
  const directory = dirname(file);

  await mkdir(directory, { recursive: true });

  // `wx` — fail rather than clobber. The name already carries the pid and a
  // per-process counter, so an EEXIST means a crashed run left this exact name
  // behind, and silently overwriting someone else's in-flight temp file is the
  // one way this function could corrupt a write it was not even asked to make.
  const temp = tempPathFor(file);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (options.backup !== false) {
      try {
        await copyFile(file, backupPathFor(file));
      } catch (err) {
        const code = errorCode(err);
        // ENOENT is the first-ever write: there is no previous generation to
        // keep. Anything else is a real failure of the SECOND chance, which
        // must not cost us the first — so it is reported and the write goes on.
        if (code !== 'ENOENT') options.onWarn?.({ kind: 'backup_failed', path: file, code });
      }
    }

    await renameWithBackoff(temp, file, attempts, baseDelayMs, sleep, options.onWarn);
  } catch (err) {
    // Best effort. If the cleanup itself is blocked by the same lock that just
    // broke the rename, a stray `.tmp` is a far better outcome than replacing
    // the caller's real error with the cleanup's.
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }

  // ═══ NO PARENT-DIRECTORY FSYNC ON WIN32 ═══
  // On POSIX, fsyncing the directory is what makes the RENAME itself durable —
  // without it the file's data survives a power cut but the new directory entry
  // may not. On Windows there is no such call: opening a directory as a file
  // fails with EPERM (libuv cannot get a handle with the right access), so the
  // POSIX-ism is not merely useless here, it throws on the happy path and would
  // turn every successful save into a reported failure.
  if (platform !== 'win32') {
    try {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some filesystems (and some containers) refuse directory fsync outright.
      // The data is already synced and the rename has already happened; this is
      // the last 1% of durability and is not worth failing a save over.
    }
  }
}
