import { describe, expect, it } from 'vitest';
import { LAYOUT_REVISION } from '../../src/shared/level.ts';

import {
  LoadOutcome,
  SOLO_CHARACTER_ID,
  createCharacterBridge,
  createCharacterFile,
  parseCharacterFile,
} from '../../src/server/persist/saves.ts';
import type { CharacterFile, SaveStore } from '../../src/server/persist/saves.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING A CHARACTER OWNS MAY BE DROPPED ON THE WAY BACK IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `saves.ts` rebuilds its restore object as a LITERAL rather than a spread, and
 * warns what that costs: *"a field absent from either rebuilt literal is
 * silently dropped, and dropped here would mean the fog loaded, was never
 * returned, and was overwritten as empty on the next autosave."*
 *
 * That warning is the only thing standing between a new field and a slow,
 * invisible data loss — it loads, it is not returned, and the next save writes
 * the absence back over the disk. It has already been the reason two fields
 * (`exploredElsewhere`, `filed`) were named there rather than forgotten.
 *
 * ═══ AND IT IS THE THIRD INSTANCE OF A CLASS THIS PROJECT KEEPS HITTING ═══
 * A guard that covers one of two parallel tables, where the hole is always in
 * whichever half was added second: `assertLinesFit` checked `topics` and not
 * `later`; the rumour distinctness test checked `later` and not `topics`; two
 * townsfolk tests pinned a headcount that was true only while every town held
 * one person. All three shipped.
 *
 * So this asserts the property rather than a list: **every optional field a
 * character file can carry survives being written and read back.** A new field
 * added to `CharacterFile` and forgotten in the literals fails here, by name,
 * without anybody having to remember this file exists.
 */

const OWNER = '111111111111111111';

/** Everything a character can own, each with a value nothing else would produce. */
const FULL = {
  id: SOLO_CHARACTER_ID,
  ownerId: OWNER,
  name: 'Ren',
  classId: 'class:watchman',
  level: 7,
  xp: 313,
  unspentPoints: 3,
  talentPoints: { 'talent:crude_blow': 4 },
  // A DIFFERENT ID FROM THE WORN ONE, deliberately. The parser drops a carried
  // entry that is already equipped and says why: *"an item is its id, so a
  // second copy is the same copy"*. The first version of this fixture carried
  // the coat it was wearing and read the (correct) de-duplication as a lost
  // field — the parser was right and the fixture was wrong.
  carried: ['item_watchmans_cap'],
  equipped: { body: 'item_watchmans_coat' },
  keybinds: { move_n: ['w'] },
  explored: 'AAAABBBB',
  exploredElsewhere: { 'realm:site:redaction': 'CCCCDDDD' },
  filed: ['site:underworks', 'site:cairnfoot'],
  money: 137,
  resources: { hp: 41, ap: 0, mp: 0, special: { kind: '', value: 0 } },
  talentCooldowns: { 'talent:lockdown': 2 },
  effects: [{ effectId: 'effect:bleeding', turnsRemaining: 2, magnitude: 3 }],
  position: { zoneId: 'zone:test_level', depth: 0, cell: [5, 5] },
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

/**
 * DERIVED, NOT STORED — so it cannot be asserted to round-trip.
 *
 * `unspentPoints` is recomputed from the level and what has been spent, which is
 * why `money`'s note calls itself *"a SOURCE OF TRUTH, UNLIKE `unspentPoints`"*.
 * Supplying 3 against a level of 7 with three ranks bought reads back 4, and the
 * parser is right: the file's number is a cache and the ledger is the truth.
 */
const DERIVED = new Set(['unspentPoints']);

/** A store that hands back one file and records what it is asked to write. */
function storeHolding(file: CharacterFile): { store: SaveStore; written: CharacterFile[] } {
  const written: CharacterFile[] = [];
  const store: SaveStore = {
    root: '(memory)',
    loadCharacter: () =>
      Promise.resolve({ outcome: LoadOutcome.Loaded, file, migrated: false, problems: [] }),
    saveCharacter: (doc: CharacterFile) => {
      written.push(doc);
      return Promise.resolve({ ok: true });
    },
    scheduleCharacter: (doc: CharacterFile) => {
      written.push(doc);
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    pendingCount: () => 0,
  } as unknown as SaveStore;
  return { store, written };
}

const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('fog belongs to the map it was walked on', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SAME DIMENSIONS ARE WHAT MAKE THIS DANGEROUS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `explored` is a bitset indexed by cell. The redesigned moor is the same
   * 170x100 with entirely different country in it, so every index from a v1 save
   * still RESOLVES — to somewhere the player has never been. The art handoff
   * says it plainly: *"the world has the same dimensions as v1, which makes
   * coordinate reuse deceptively unsafe."*
   *
   * Nothing would have failed. The player would simply have opened the map to
   * find patches of a country they had not walked, and holes where they had.
   */
  const WALKED = {
    id: SOLO_CHARACTER_ID,
    ownerId: '222222222222222222',
    name: 'Ren',
    classId: 'watchman',
    level: 3,
    xp: 40,
    explored: 'AAAABBBBCCCC',
    // The producer requires these; `FULL` above is the reference for what a
    // whole character carries and this is the smallest file that parses.
    resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
    position: { zoneId: 'zone:test_level', depth: 0, cell: [5, 5] },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('keeps the fog when the save was walked on this map', () => {
    const file = createCharacterFile(WALKED);
    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(parsed.ok, `parse refused: ${parsed.problems.join('; ')}`).toBe(true);
    if (!parsed.ok) return;
    // THE SETUP FIRST: the producer must have stamped the map, or "kept" below
    // would be measuring a file that never claimed anything.
    expect(
      (file as unknown as Record<string, unknown>)['layoutRevision'],
      'the writer did not stamp which moor the fog belongs to',
    ).toBe(LAYOUT_REVISION);
    expect(parsed.file.explored).toBe(WALKED.explored);
  });

  it('drops the fog when the save was walked on another one', () => {
    /**
     * A FILE FROM BEFORE THE REDESIGN HAS NO STAMP AT ALL, which is exactly the
     * case that matters: eight of them were sitting on the host when the new
     * moor landed. Dropped rather than migrated, because there is nothing to
     * migrate TO — the cells are not the same cells.
     */
    const stale = {
      ...(JSON.parse(JSON.stringify(createCharacterFile(WALKED))) as Record<string, unknown>),
      layoutRevision: 'alderbrook-moor-v1',
    };
    const parsed = parseCharacterFile(stale);
    expect(parsed.ok, `parse refused: ${parsed.problems.join('; ')}`).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.explored, 'fog from another map survived the load').toBeUndefined();
    // ...and the character is otherwise intact. Dropping the fog must not cost
    // anybody a level.
    expect(parsed.file.level).toBe(WALKED.level);
    expect(parsed.file.xp).toBe(WALKED.xp);
  });
});

describe('a character file keeps everything it was given', () => {
  it('round-trips every field through parse', () => {
    /**
     * THE FILE HALF. `createCharacterFile` and `parseCharacterDoc` are two more
     * rebuilt literals, and a field named in the type but absent from either is
     * a field that cannot be saved at all.
     *
     * ASSERTED FIELD BY FIELD FROM THE FIXTURE, not against a hand-written list:
     * adding a key to `FULL` is the only edit a new field needs, and forgetting
     * to fails here rather than in somebody's save six weeks later.
     */
    const file = createCharacterFile(FULL);
    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(parsed.ok, `parse refused: ${parsed.problems.join('; ')}`).toBe(true);
    if (!parsed.ok) return;

    const lost: string[] = [];
    for (const [key, value] of Object.entries(FULL)) {
      if (DERIVED.has(key)) continue;
      const back = (parsed.file as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(back) !== JSON.stringify(value)) {
        lost.push(`${key}: wrote ${JSON.stringify(value)}, read ${JSON.stringify(back)}`);
      }
    }
    expect(lost, 'fields that did not survive being written and read').toEqual([]);
  });

  it('hands every stored field back to the gateway on open', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THE WARNING IS ABOUT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `openCharacter` composes its answer from rebuilt literals, and a field
     * that loads but is not RETURNED is worse than one that fails to load: the
     * character plays normally, and the next autosave writes the absence back.
     * Silent, permanent, and invisible from every other angle.
     *
     * Driven through the real bridge with a store that simply hands the file
     * over, so what is under test is the mapping and nothing else.
     */
    const file = createCharacterFile(FULL);
    const { store } = storeHolding(file);
    const bridge = createCharacterBridge({ store, logger: QUIET, now: () => FULL.createdAt });

    const restore = await bridge.openCharacter?.(OWNER, 'player:test');
    expect(restore, 'the bridge refused to open a perfectly good file').not.toBeNull();
    if (restore === null || restore === undefined) return;

    const back = restore as unknown as Record<string, unknown>;
    // THE FIELDS THAT ARE THE CHARACTER'S OWN PROPERTY. Identity and timestamps
    // are the FILE's, not the player's, and the gateway neither needs nor gets
    // them — so this names what a player would notice losing.
    const owned = [
      'level',
      'xp',
      'unspentPoints',
      'talentPoints',
      'carried',
      'equipped',
      'keybinds',
      'explored',
      'exploredElsewhere',
      'filed',
      'money',
    ] as const;

    const dropped: string[] = [];
    for (const key of owned) {
      if (DERIVED.has(key)) continue;
      const want = (FULL as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(back[key]) !== JSON.stringify(want)) {
        dropped.push(
          `${key}: stored ${JSON.stringify(want)}, returned ${JSON.stringify(back[key])}`,
        );
      }
    }
    expect(
      dropped,
      'loaded from disk and then not handed back — see the warning in saves.ts',
    ).toEqual([]);
  });

  it('covers every optional field the type declares', () => {
    /**
     * THE GUARD ON THE GUARD, and the reason this file cannot rot quietly.
     *
     * The two tests above only check what `FULL` happens to mention. A field
     * added to `CharacterFile` and not added to the fixture would sail past
     * both of them — which is exactly the failure being guarded against, one
     * level up. So the fixture is compared against the type's own key set,
     * taken from a file the producer builds with everything supplied.
     */
    const file = createCharacterFile(FULL) as unknown as Record<string, unknown>;
    // Written by the producer rather than by the player: nothing a save could
    // lose, and nothing a fixture should have to state.
    // `layoutRevision` joins these: it is stamped by the WRITER to say which moor
    // the fog belongs to, not supplied by the player and not theirs to lose. Its
    // own behaviour is covered by the two tests above.
    const notTheirs = new Set([
      'schemaVersion',
      'kind',
      'id',
      'ownerId',
      'name',
      'updatedAt',
      'layoutRevision',
    ]);
    const uncovered = Object.keys(file).filter(
      (key) => !notTheirs.has(key) && !(key in FULL) && file[key] !== undefined,
    );
    expect(uncovered, 'CharacterFile grew a field this test does not exercise').toEqual([]);
  });
});
