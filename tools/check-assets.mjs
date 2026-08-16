#!/usr/bin/env node
/**
 * check-assets — refuse to ship art.
 *
 * ============================================================================
 * WHY THIS EXISTS WHEN .gitignore ALREADY COVERS IT
 * ============================================================================
 * `client/public/assets/` is ignored as a whole directory, and that is the
 * primary control. This is the second one, and it exists because the first is
 * bypassable in three ordinary ways that leave no trace until the push lands:
 *
 *   `git add -f`        one flag, and the rule is gone for that file
 *   a .gitignore edit   un-ignoring a path is a one-line diff nobody reads
 *   a new directory     art dropped somewhere the rule does not name
 *
 * The art is All Rights Reserved and is NOT distributed with this repository
 * (ASSETS-LICENSE.md). Unlike a secret, a leaked PNG cannot be rotated: a
 * published git history cannot be retracted, and a force-push removes nothing
 * from the clones, the forks, or the GitHub Events API record. So this runs in
 * `npm run check`, which the pre-push hook and CI both invoke — the last two
 * places before something becomes permanent.
 *
 * It is deliberately NOT a hook of its own. A hook lives on one machine and is
 * bypassable with --no-verify; the gate travels with the repository.
 *
 * ============================================================================
 * WHAT IT REFUSES
 * ============================================================================
 * 1. Any TRACKED file with a media extension, anywhere in the tree.
 * 2. Any TRACKED path under an art directory, whatever it is named.
 *
 * Both are checked against `git ls-files`, i.e. what git would actually ship —
 * not against the working tree, which legitimately holds 126 sprites right now.
 *
 * No dependencies: Node 24 and node:* only.
 */

import { execFileSync } from 'node:child_process';

/**
 * Extensions that are art, audio or fonts. Deliberately broad: the cost of a
 * false positive is one conversation, the cost of a false negative is
 * permanent. `.svg` and `.ico` are included — an icon is still art.
 */
const MEDIA =
  /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|ico|ttf|otf|woff2?|eot|mp3|m4a|ogg|wav|flac|mp4|webm|mov)$/i;

/**
 * Directories whose entire contents are art by definition. Matched as a path
 * prefix so a file added anywhere beneath one is caught, including in a
 * subdirectory that does not exist yet.
 */
const ART_DIRS = ['client/public/assets/', 'assets/', 'art/'];

function tracked() {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (error) {
    // A missing git, or not a repository. Say so rather than passing silently:
    // a check that cannot run has not passed.
    console.error(`check-assets: could not list tracked files (${String(error)})`);
    process.exitCode = 1;
    return null;
  }
}

const files = tracked();
if (files === null) {
  // exitCode already set above.
} else {
  const byMedia = files.filter((f) => MEDIA.test(f));
  const byDir = files.filter((f) => ART_DIRS.some((d) => f.startsWith(d)));

  // A file can trip both rules; report it once, under the more specific one.
  const inDir = new Set(byDir);
  const offenders = [...byDir, ...byMedia.filter((f) => !inDir.has(f))];

  console.log('art containment');

  if (offenders.length === 0) {
    console.log(`  ok    no media file is tracked (${files.length} tracked files scanned)`);
    console.log(`  ok    no tracked path under ${ART_DIRS.join(', ')}`);
    console.log('\nart containment OK');
  } else {
    console.error(
      `\ncheck-assets: ${offenders.length} tracked file(s) are art and must not be published.\n`,
    );
    for (const f of offenders.slice(0, 40)) console.error(`    ${f}`);
    if (offenders.length > 40) console.error(`    ... and ${offenders.length - 40} more`);
    console.error(
      '\n' +
        'The art is All Rights Reserved and is not distributed with this repository.\n' +
        'See ASSETS-LICENSE.md. To untrack these while KEEPING them on disk:\n\n' +
        '    git rm --cached <path>\n\n' +
        'If one of these is genuinely not art, add the exception here with a reason\n' +
        'rather than widening the pattern — the pattern is deliberately broad.\n',
    );
    process.exitCode = 1;
  }
}
