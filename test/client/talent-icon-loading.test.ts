import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY ICON A TALENT NAMES IS ONE THE CLIENT ACTUALLY LOADS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS IS THE JOIN, AND IT IS THE ONLY PLACE THE BUG COULD BE SEEN FROM.
 *
 * Two halves, each correct on its own:
 *
 *   `src/server/talents/*.ts` declare `iconId: 'icon_passive_second_wind'`.
 *   `main.ts`'s `NEEDED_ASSET_PREFIXES` filters the manifest before loading.
 *
 * The prefix list admitted `icon_active_` and never `icon_passive_` or
 * `icon_sustain_`. So all 64 passive and all 8 sustain PNGs sat registered in the
 * manifest and on disk, were filtered out before they could load, and every one
 * drew its first letter in the Talent panel — 42 on a single Alchemist
 * screenshot.
 *
 * `npm run art:needs` reported ZERO missing art the entire time, and it was
 * right: nothing was missing. It checks what source NAMES against what is on
 * DISK, and it has no idea a third thing — the client's load filter — sits in
 * between. `drawTalentIcon` then fell back to the letter correctly, exactly as a
 * bare clone is supposed to. Every component told the truth and the player saw
 * letters.
 *
 * It had happened once already, one spelling over: the list read `icon_ability_`
 * for M3-M6 and matched nothing, and main.ts carries the note. That fix
 * corrected ONE prefix rather than asking which families a talent can name,
 * which is how the same failure came back for seventy-two icons.
 *
 * ═══ SOURCE, NOT THE MANIFEST ═══
 * `client/public/assets/` is gitignored whole, manifest included, so a check
 * against it passes vacuously on a bare clone — exactly the machine that most
 * needs it. Both halves of THIS join are committed source, so it holds anywhere.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Comments stripped, the same way `assets.test.ts`'s `codeOf` does it. */
function codeOf(path: string): string {
  return readFileSync(join(root, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...tsFilesUnder(rel));
    else if (name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** Every `iconId: '...'` literal a talent declares, with the file it is in. */
function declaredTalentIcons(): readonly { readonly id: string; readonly file: string }[] {
  const found: { id: string; file: string }[] = [];
  for (const file of tsFilesUnder('src/server/talents')) {
    for (const m of codeOf(file).matchAll(/iconId:\s*'([^']+)'/g)) {
      const id = m[1];
      if (id !== undefined) found.push({ id, file });
    }
  }
  return found;
}

function neededPrefixes(): readonly string[] {
  const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(
    codeOf('src/client/main.ts'),
  );
  expect(
    block,
    'NEEDED_ASSET_PREFIXES was renamed or reshaped — this guard is blind',
  ).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

describe('the talent icons and the load filter agree', () => {
  it('finds the talent icons at all — the control', () => {
    /**
     * A SCAN THAT MATCHES NOTHING PASSES THE ASSERTION BELOW FOREVER. Pinned to
     * the families that exist rather than to a count, so authoring a talent
     * does not break it, while a regex that stopped finding `iconId` does.
     */
    const families = new Set(declaredTalentIcons().map(({ id }) => /^icon_[a-z]+_/.exec(id)?.[0]));
    expect([...families].sort()).toEqual([
      'icon_active_',
      'icon_monster_',
      'icon_passive_',
      'icon_sustain_',
    ]);
  });

  it('admits every icon any talent declares', () => {
    const prefixes = neededPrefixes();
    const filtered = declaredTalentIcons().filter(
      ({ id }) => !prefixes.some((prefix) => id.startsWith(prefix)),
    );
    expect(
      filtered.map(({ id, file }) => `${id}  (${file})`),
      'these talent icons are filtered out before loading and will draw a LETTER',
    ).toEqual([]);
  });
});
