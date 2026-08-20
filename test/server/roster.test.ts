// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LAYOUT_REVISION } from '../../src/shared/level.ts';

import {
  LoadOutcome,
  SaveReason,
  createCharacterFile,
  createSaveStore,
} from '../../src/server/persist/saves.ts';
import type { CharacterFile, SaveLogger, SaveStore } from '../../src/server/persist/saves.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ROSTER — WHAT A CHARACTER SELECT SCREEN IS ALLOWED TO SAY IS THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/characters/<ownerId>/` has been a DIRECTORY since the first save landed,
 * and `SOLO_CHARACTER_ID` says why it was one from the start: *"so it can hold
 * `chr_0002.json` one day — the day a picker lands, this constant becomes a
 * lookup and nothing else in this file changes"*. This is that day, and this
 * file is the half of it that has to be right before any of the rest matters.
 *
 * ═══ THE ONE THAT WOULD ACTUALLY COST SOMEBODY A CHARACTER ═══
 * A save this build refuses to read — corrupt, or written by a newer build —
 * must still get a ROW. Omitting it renders as "that character is gone", and a
 * player whose character is gone makes a new one, plays it, and lets the
 * autosave write over the directory they were trying to recover from. The store
 * deliberately leaves damaged files exactly where they are so a human can
 * inspect them; a menu that hides them undoes that in a single frame.
 */
const OWNER = '284739201847583744';

function silentLogger(): SaveLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

let root: string;
let store: SaveStore;
/** The store stamps `updatedAt` itself, so the ordering test drives this. */
let clock = '2026-08-01T00:00:00.000Z';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inner-datum-roster-'));
  clock = '2026-08-01T00:00:00.000Z';
  store = createSaveStore({ root, logger: silentLogger(), debounceMs: 5, now: () => clock });
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * THROUGH `createCharacterFile`, NOT AROUND IT. `explored` and `layoutRevision`
 * are paired by that function and by nothing else — a fixture that set the
 * bitset by spreading over the result would produce a file the loader silently
 * discards the fog from, and the test would be measuring its own shortcut.
 */
function character(id: string, name: string, over: Partial<CharacterFile> = {}): CharacterFile {
  const { filed, explored, exploredElsewhere, ...rest } = over;
  return {
    ...createCharacterFile({
      id,
      ownerId: OWNER,
      name,
      classId: 'watchman',
      filed,
      explored,
      exploredElsewhere,
      resources: { hp: 60, ap: 4, mp: 0, special: { kind: 'resolve', value: 0 } },
      talentCooldowns: {},
      effects: [],
      position: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    }),
    ...rest,
  };
}

describe('the roster a character select screen is drawn from', () => {
  it('is empty for an account that has never saved, and that is not an error', async () => {
    // THE OVERWHELMINGLY COMMON CASE — every account, once. There is no
    // directory at all and `readdir` throws ENOENT for it.
    expect(await store.listCharacters(OWNER)).toEqual([]);
  });

  it('lists every character the account owns, newest played first', async () => {
    clock = '2026-08-10T00:00:00.000Z';
    await store.saveCharacter(character('chr_main', 'Sergeant Vell'), SaveReason.Manual);
    clock = '2026-08-19T00:00:00.000Z';
    await store.saveCharacter(character('chr_0002', 'Halloway'), SaveReason.Manual);

    const roster = await store.listCharacters(OWNER);
    expect(roster.map((r) => r.name)).toEqual(['Halloway', 'Sergeant Vell']);
    // ═══ NEWEST FIRST IS THE POINT ═══
    // Alphabetically 'Halloway' also comes first, so the assertion above cannot
    // tell the two orderings apart on its own. This one can.
    expect(roster[0]?.updatedAt).toBe('2026-08-19T00:00:00.000Z');
    expect(roster.every((r) => r.playable)).toBe(true);
  });

  it('carries enough to choose by, and reads it through the real loader', async () => {
    await store.saveCharacter(
      character('chr_main', 'Sergeant Vell', {
        level: 7,
        money: 240,
        filed: ['site:drowned_chapel', 'site:underworks'],
      }),
      SaveReason.Manual,
    );
    const [row] = await store.listCharacters(OWNER);
    expect(row?.level).toBe(7);
    expect(row?.money).toBe(240);
    // THE NUMBER THE CHARACTER SHEET CALLS `Cases`, counted rather than listed.
    expect(row?.filed).toBe(2);
    expect(row?.classId).toBe('watchman');
  });

  it('still shows a character whose file this build refuses to read', async () => {
    await store.saveCharacter(character('chr_main', 'Sergeant Vell'), SaveReason.Manual);
    // A file that is THERE and unreadable, written past the store so no atomic
    // write can tidy it away. Valid UTF-8, invalid JSON: the signature of a
    // truncated write, and the exact case `loadCharacter` calls corrupt.
    const dir = join(root, 'characters', OWNER);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chr_0002.json'), '{"kind":"character","id":', 'utf8');

    const roster = await store.listCharacters(OWNER);
    // ═══ THE ASSERTION THAT MATTERS ═══
    // Two rows, not one. Drop the damaged row and this reads as a deletion.
    expect(roster).toHaveLength(2);
    const broken = roster.find((r) => r.id === 'chr_0002');
    expect(broken, 'the unreadable character vanished from the roster').toBeDefined();
    expect(broken?.playable).toBe(false);
    expect(broken?.refusal).toBe(LoadOutcome.Corrupt);
    // AND IT SORTS LAST. A row you cannot click does not belong at the top of a
    // menu; it has no `updatedAt` to sort by, so this pins where it lands.
    expect(roster.at(-1)?.id).toBe('chr_0002');
  });

  it('does not offer a backup as a second character', async () => {
    // `.bak` IS THE PREVIOUS COPY of a character already in the list. The store
    // writes one on every overwrite, so without the filter every character in
    // the game would appear twice the moment it was saved a second time.
    await store.saveCharacter(character('chr_main', 'Sergeant Vell'), SaveReason.Manual);
    await store.saveCharacter(
      character('chr_main', 'Sergeant Vell', { level: 2 }),
      SaveReason.Manual,
    );

    const roster = await store.listCharacters(OWNER);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe('chr_main');
  });

  it('refuses an owner id that is not a safe path component', async () => {
    // THE HALF THAT MUST NOT MOVE. `characterPath` returns null for these and
    // `listCharacters` builds its directory path the same way — a roster that
    // read `../../` would enumerate somebody else's saves.
    expect(await store.listCharacters('../../etc')).toEqual([]);
    expect(await store.listCharacters('')).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      THE CASE FILE AND THE FOG NEVER REACHED THE DISK AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `serialiseCharacter` rebuilds a canonical object from scratch for byte
 * stability and its own comment states the consequence — *"a field missing from
 * this literal is never written at ALL"*. Four were missing: `filed`,
 * `explored`, `exploredElsewhere` and `layoutRevision`.
 *
 * So a player closed cases all evening, logged out, and came back to
 * `Cases: 0 of 27` and a black map. `casefile.ts` calls the file "the strongest
 * retention mechanic in the genre" and says it is "persisted across sessions";
 * it was persisted precisely as far as memory.
 *
 * ═══ WHY THIS TEST IS A ROUND TRIP AND NOT AN ASSERTION ABOUT A SNAPSHOT ═══
 * The chain is snapshot -> bridge -> `CharacterFile` -> serialiser -> disk ->
 * parse. `fog-persistence.test.ts` pins the first hop and the parse hop and is
 * green either way, because the deletion is in the middle. Only bytes can catch
 * a bytes bug: this writes with the real store and reads back with the real
 * loader, and nothing in between is mocked.
 */
describe('what a character still knows after a logout', () => {
  it('remembers the cases it closed and the country it walked', async () => {
    await store.saveCharacter(
      character('chr_main', 'Sergeant Vell', {
        filed: ['site:drowned_chapel', 'site:underworks'],
        explored: 'AAAA',
        exploredElsewhere: { 'realm:site:redaction': 'BBBB' },
      }),
      SaveReason.Manual,
    );

    // ═══ THE ASSERTIONS THAT WERE FAILING ═══
    // Before the fix: `filed` undefined, `explored` undefined, both dropped by
    // the serialiser and therefore absent from the bytes the loader reads.
    const back = await store.loadCharacter(OWNER, 'chr_main');
    expect(back.outcome).toBe(LoadOutcome.Loaded);
    expect(back.file?.filed, 'the case file did not survive the write').toEqual([
      'site:drowned_chapel',
      'site:underworks',
    ]);
    expect(back.file?.explored, 'the fog did not survive the write').toBe('AAAA');
    expect(back.file?.exploredElsewhere).toEqual({ 'realm:site:redaction': 'BBBB' });
  });

  it('and the roster counts those cases, because it reads the same bytes', async () => {
    // THE TWO HALVES ARE ONE BUG. A select screen that shows every character at
    // `0 cases` is indistinguishable from a select screen for a game nobody has
    // made progress in — which is what this would have shipped as.
    await store.saveCharacter(
      character('chr_main', 'Sergeant Vell', { filed: ['site:drowned_chapel'] }),
      SaveReason.Manual,
    );
    const [row] = await store.listCharacters(OWNER);
    expect(row?.filed).toBe(1);
  });

  it('writes no key for a character that has closed nothing and walked nowhere', async () => {
    /**
     * ═══ THE HALF THAT MUST NOT MOVE ═══
     * The four fields are written CONDITIONALLY, joining `carried`/`equipped`/
     * `keybinds`. Emitting `[]` and `""` instead would rewrite every save in
     * `data/characters/` on first load and step every `.bak` a generation for
     * nothing — and the serialiser's byte-stability contract, which the atomic
     * writer's "same snapshot, same bytes" assumption rests on, would break for
     * every file written before today.
     */
    await store.saveCharacter(character('chr_main', 'Sergeant Vell'), SaveReason.Manual);
    const bytes = await readFile(join(root, 'characters', OWNER, 'chr_main.json'), 'utf8');
    const keys = Object.keys(JSON.parse(bytes) as Record<string, unknown>);
    expect(keys).not.toContain('filed');
    expect(keys).not.toContain('explored');
    expect(keys).not.toContain('exploredElsewhere');
    expect(keys).not.toContain('layoutRevision');
  });

  it('keeps the fog and the stamp that says which map it belongs to together', async () => {
    // THE LOADER DROPS FOG WHOSE `layoutRevision` DOES NOT MATCH. Writing the
    // bitset without the stamp would persist a fog discarded on every load —
    // the same bug with an extra step, and one that would read as fixed.
    await store.saveCharacter(
      character('chr_main', 'Sergeant Vell', { explored: 'AAAA' }),
      SaveReason.Manual,
    );
    const bytes = await readFile(join(root, 'characters', OWNER, 'chr_main.json'), 'utf8');
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    expect(doc['explored']).toBe('AAAA');
    expect(doc['layoutRevision'], 'fog written without the map it indexes').toBe(LAYOUT_REVISION);
  });
});
