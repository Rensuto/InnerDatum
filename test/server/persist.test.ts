import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from '../../src/shared/version.ts';
import {
  MAX_CHARACTER_LEVEL,
  TALENT_MAX_LEVEL,
  totalPointsAtLevel,
} from '../../src/shared/progression.ts';
import {
  CHARACTER_MIGRATIONS,
  CURRENT_VERSIONS,
  MigrateOutcome,
  SchemaKind,
  createMigrationRegistry,
  migrateDoc,
  readSchemaVersion,
} from '../../src/server/persist/migrate.ts';
import {
  ClassId,
  ResourceKind,
  createTalentSheet,
  getTalentLevel,
} from '../../src/server/engine/talents.ts';
import { backupPathFor, writeFileAtomic } from '../../src/server/persist/atomic.ts';
import {
  LoadOutcome,
  SaveOutcome,
  SaveReason,
  characterPath,
  createCharacterFile,
  createCharacterBridge,
  createSaveStore,
  maskId,
  parseCharacterFile,
  sanitiseId,
  serialiseCharacter,
} from '../../src/server/persist/saves.ts';
import type * as NodeFsPromises from 'node:fs/promises';
import type { AtomicWarning } from '../../src/server/persist/atomic.ts';
import type { Migration } from '../../src/server/persist/migrate.ts';
import type { CharacterRestore, CharacterSnapshot } from '../../src/server/net/gateway.ts';
import type {
  CharacterFile,
  SaveLogger,
  SaveStore,
  SavedLoadout,
} from '../../src/server/persist/saves.ts';

// ---------------------------------------------------------------------------
// FAULT INJECTION FOR RISK R9
//
// The failure this whole layer exists for — Defender or the search indexer
// holding a freshly written file so that `rename` throws EPERM/EBUSY — is real,
// is the reason no library is used, and cannot be produced on demand from a
// test. So `rename` is wrapped: the real one, with a queue of errors in front
// of it. Everything else in node:fs/promises is the genuine article, so these
// tests still write real bytes to a real disk.
//
// `vi.mock` is hoisted above the imports, hence `vi.hoisted` for the shared
// queue.
// ---------------------------------------------------------------------------

const renameFaults = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const code = renameFaults.queue.shift();
      if (code !== undefined) {
        const err: NodeJS.ErrnoException = new Error(`injected ${code} renaming ${from} → ${to}`);
        err.code = code;
        throw err;
      }
      await actual.rename(from, to);
    },
  };
});

/** Records every line, so a test can assert that a failure was LOUD. */
function recordingLogger(): SaveLogger & { readonly lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    info: (_context, message): void => {
      lines.push({ level: 'info', message });
    },
    warn: (_context, message): void => {
      lines.push({ level: 'warn', message });
    },
    error: (_context, message): void => {
      lines.push({ level: 'error', message });
    },
  };
}

const OWNER = '284739201847583744';
const CHAR = 'chr_a1b2';

function sampleCharacter(overrides: Partial<CharacterFile> = {}): CharacterFile {
  return {
    ...createCharacterFile({
      id: CHAR,
      ownerId: OWNER,
      name: 'Sergeant Vell',
      classId: 'watchman',
      resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
      talentCooldowns: { 'talent:lockdown': 3, 'talent:crude_blow': 1 },
      effects: [{ effectId: 'effect:bleeding', turnsRemaining: 2, magnitude: 6 }],
      position: { zoneId: 'alderbrook', depth: 1, cell: [12, 7] },
      createdAt: '2026-08-15T00:00:00.000Z',
    }),
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  renameFaults.queue.length = 0;
  root = await mkdtemp(join(tmpdir(), 'inner-datum-persist-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ===========================================================================
// atomic.ts — risk R9
// ===========================================================================

describe('writeFileAtomic', () => {
  it('creates the directory and writes the file', async () => {
    const file = join(root, 'nested', 'deeper', 'a.json');
    await writeFileAtomic(file, '{"a":1}\n');
    await expect(readFile(file, 'utf8')).resolves.toBe('{"a":1}\n');
  });

  it('leaves no temp file behind on success', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    const entries = await readdir(root);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('writes no .bak on the first write and keeps the PREVIOUS contents on the second', async () => {
    const file = join(root, 'a.json');

    await writeFileAtomic(file, 'first');
    await expect(readFile(backupPathFor(file), 'utf8')).rejects.toThrow();

    await writeFileAtomic(file, 'second');
    expect(await readFile(file, 'utf8')).toBe('second');
    // One generation, and it is the generation BEFORE the current file.
    expect(await readFile(backupPathFor(file), 'utf8')).toBe('first');

    await writeFileAtomic(file, 'third');
    expect(await readFile(backupPathFor(file), 'utf8')).toBe('second');
  });

  it('honours backup:false', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second', { backup: false });
    await expect(readFile(backupPathFor(file), 'utf8')).rejects.toThrow();
  });

  // ═══ THE R9 TEST ═══
  it('retries EPERM and EBUSY on an exponential schedule and still lands the write', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'before');

    renameFaults.queue.push('EPERM', 'EBUSY', 'EPERM');
    const slept: number[] = [];
    const warnings: AtomicWarning[] = [];

    await writeFileAtomic(file, 'after', {
      baseDelayMs: 10,
      sleep: async (ms: number): Promise<void> => {
        slept.push(ms);
        await Promise.resolve();
      },
      onWarn: (warning): void => {
        warnings.push(warning);
      },
    });

    // 10 → 20 → 40. Three failures, three waits, fourth attempt succeeds.
    expect(slept).toEqual([10, 20, 40]);
    expect(warnings.map((w) => w.kind)).toEqual(['rename_retry', 'rename_retry', 'rename_retry']);
    expect(await readFile(file, 'utf8')).toBe('after');
    // And the previous generation is still there — the .bak is taken before the
    // rename, so a run of retries does not cost the second chance.
    expect(await readFile(backupPathFor(file), 'utf8')).toBe('before');
  });

  it('caps the backoff at 250 ms rather than doubling forever', async () => {
    const file = join(root, 'a.json');
    renameFaults.queue.push('EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY');
    const slept: number[] = [];
    await writeFileAtomic(file, 'x', {
      baseDelayMs: 40,
      sleep: async (ms: number): Promise<void> => {
        slept.push(ms);
        await Promise.resolve();
      },
    });
    expect(slept).toEqual([40, 80, 160, 250, 250, 250]);
  });

  it('gives up after the attempt budget and leaves the previous file intact', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'original');

    renameFaults.queue.push('EPERM', 'EPERM', 'EPERM');
    await expect(
      writeFileAtomic(file, 'never lands', {
        attempts: 3,
        sleep: async (): Promise<void> => {
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(/EPERM/);

    // The destination is untouched, and the scratch file was cleaned up.
    expect(await readFile(file, 'utf8')).toBe('original');
    const entries = await readdir(root);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * INTERRUPTED MID-WRITE: A READER SEES THE COMPLETE PREVIOUS FILE, NEVER A
   * PREFIX. That single sentence is the entire reason this module exists.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The window is real and it is exactly the retry window: the temp file is
   * written and synced, the rename has not landed yet, and on Windows it may not
   * land for the better part of a second while Defender lets go. `sleep` is the
   * seam — every assertion below runs INSIDE that window, with the process
   * "interrupted" between the two halves of the write.
   */
  it('never exposes a partial file: mid-write, the destination is still the OLD one', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'the complete previous contents');

    renameFaults.queue.push('EBUSY', 'EBUSY');
    const midWrite: string[] = [];
    const scratchSeen: string[] = [];

    await writeFileAtomic(file, 'the complete new contents', {
      baseDelayMs: 1,
      sleep: async (): Promise<void> => {
        // The destination: whole, and still the PREVIOUS generation.
        midWrite.push(await readFile(file, 'utf8'));
        // The new bytes are all present — but under a scratch name, so nothing
        // that reads `file` can ever see half of them.
        const scratch = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
        for (const name of scratch) scratchSeen.push(await readFile(join(root, name), 'utf8'));
      },
    });

    expect(midWrite).toEqual(['the complete previous contents', 'the complete previous contents']);
    expect(scratchSeen).toEqual(['the complete new contents', 'the complete new contents']);
    expect(await readFile(file, 'utf8')).toBe('the complete new contents');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('cleans up its scratch file when the write is abandoned', async () => {
    const file = join(root, 'a.json');
    await writeFileAtomic(file, 'original');

    renameFaults.queue.push('EPERM', 'EPERM');
    await expect(
      writeFileAtomic(file, 'abandoned', {
        attempts: 2,
        sleep: async (): Promise<void> => {
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(/EPERM/);

    // Nothing half-written anywhere in the directory: not at the destination,
    // not under a scratch name. A run of failures cannot litter `data/`.
    const entries = await readdir(root);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('does NOT retry an error that waiting cannot fix', async () => {
    const file = join(root, 'a.json');
    renameFaults.queue.push('ENOSPC');
    const slept: number[] = [];
    await expect(
      writeFileAtomic(file, 'x', {
        sleep: async (ms: number): Promise<void> => {
          slept.push(ms);
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(/ENOSPC/);
    expect(slept).toEqual([]);
  });
});

// ===========================================================================
// migrate.ts — the chain, and the refusal
// ===========================================================================

describe('migrateDoc', () => {
  it('pins the current version of every kind', () => {
    expect(CURRENT_VERSIONS[SchemaKind.Character]).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BUMP THAT WAS CONSIDERED AND DECLINED. THIS PIN MUST NOT MOVE QUIETLY.
   * ═══════════════════════════════════════════════════════════════════════════
   * Progression added four fields to `CharacterFile` and every one of them is
   * OPTIONAL, which docs/data-schemas.md:48-49 says needs no bump. The trade was
   * weighed both ways (migrate.ts's header, saves.ts's header): bumping makes an
   * older build REFUSE the file and QUARANTINE the path, so the character is
   * unplayable until a human intervenes, while not bumping costs at most one
   * character's levels. game-design.md § 9 is "no permadeath, no loss".
   *
   * So the assertion is not "the number is 1" — it is "the number is still 1 AND
   * the chain is still empty", together, because the pair is what says the
   * decision was taken rather than forgotten.
   */
  it('kept SCHEMA_VERSION at 1 and the chain empty when the progression fields landed', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(CURRENT_VERSIONS[SchemaKind.Character]).toBe(1);
    expect(CHARACTER_MIGRATIONS).toEqual([]);
  });

  it('passes a current document through untouched', () => {
    const result = migrateDoc(SchemaKind.Character, { schemaVersion: 1, kind: 'character' });
    expect(result.ok && result.outcome).toBe(MigrateOutcome.Current);
    expect(result.ok && result.changed).toBe(false);
  });

  // ═══ THE REFUSAL. docs/data-schemas.md § 1. ═══
  it('REFUSES a save written by a newer build rather than down-converting it', () => {
    const result = migrateDoc(SchemaKind.Character, { schemaVersion: 2, kind: 'character' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.outcome).toBe(MigrateOutcome.TooNew);
    expect(!result.ok && result.found).toBe(2);
  });

  it('treats a missing or non-integer schemaVersion as malformed, not as version 0', () => {
    expect(readSchemaVersion({ kind: 'character' })).toBeNull();
    expect(readSchemaVersion({ schemaVersion: '1' })).toBeNull();
    expect(readSchemaVersion({ schemaVersion: 1.5 })).toBeNull();
    expect(readSchemaVersion([1, 2, 3])).toBeNull();
    const result = migrateDoc(SchemaKind.Character, { kind: 'character' });
    expect(!result.ok && result.outcome).toBe(MigrateOutcome.Malformed);
  });

  // The drill docs/data-schemas.md § 1 asks for, run while the stakes are zero.
  const step = (
    from: number,
    to: number,
    note: string,
    patch: Record<string, unknown>,
  ): Migration =>
    ({ kind: SchemaKind.Character, from, to, note, up: (doc) => ({ ...doc, ...patch }) }) as const;

  it('walks a multi-step chain in order and stamps the version at each step', () => {
    const registry = createMigrationRegistry([
      step(1, 2, 'adds refundPool', { refundPool: [] }),
      step(2, 3, 'renames hp → vitality', { vitality: 61 }),
    ]);
    const result = migrateDoc(
      SchemaKind.Character,
      { schemaVersion: 1, kind: 'character', name: 'Vell' },
      registry,
      3,
    );
    expect(result.ok && result.outcome).toBe(MigrateOutcome.Migrated);
    expect(result.ok && result.doc).toMatchObject({
      schemaVersion: 3,
      name: 'Vell',
      refundPool: [],
      vitality: 61,
    });
    expect(result.ok && result.applied).toEqual([
      'v1→v2: adds refundPool',
      'v2→v3: renames hp → vitality',
    ]);
  });

  it('reports a hole in the chain instead of guessing', () => {
    const registry = createMigrationRegistry([step(2, 3, 'later', {})]);
    const result = migrateDoc(SchemaKind.Character, { schemaVersion: 1 }, registry, 3);
    expect(!result.ok && result.outcome).toBe(MigrateOutcome.NoPath);
    expect(!result.ok && result.reason).toContain('v1 → v2');
  });

  it('rejects a malformed chain at construction rather than hanging at boot', () => {
    expect(() => createMigrationRegistry([step(1, 3, 'skips v2', {})])).toThrow(/exactly one/);
    expect(() => createMigrationRegistry([step(1, 1, 'goes nowhere', {})])).toThrow(/exactly one/);
    expect(() => createMigrationRegistry([step(1, 2, 'a', {}), step(1, 2, 'b', {})])).toThrow(
      /two migrations/,
    );
  });

  /**
   * THE FULL DRILL: an OLD FIXTURE ON THE OLD SHAPE, walked forward, and the
   * result handed to the real validator to prove it is genuinely the CURRENT
   * shape rather than merely a document with a higher integer on it.
   *
   * docs/data-schemas.md § 1 asks for exactly this rehearsal while the stakes
   * are zero: `CHARACTER_MIGRATIONS` is empty at v1 because v1 is the first
   * shape ever written, so the fixture and the steps are supplied here. The day
   * the first real migration lands it is one entry in that array and this test
   * changes by one line.
   */
  it('migrates an older fixture and produces a document the current build parses', () => {
    // v1 as it would have been written: `hp` at the root, no `resources`, and
    // the position as three loose fields.
    const ancient = {
      schemaVersion: 1,
      kind: 'character',
      id: CHAR,
      ownerId: OWNER,
      name: 'Sergeant Vell',
      classId: 'watchman',
      hp: 61,
      zoneId: 'alderbrook',
      depth: 1,
      x: 12,
      y: 7,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };

    const registry = createMigrationRegistry([
      {
        kind: SchemaKind.Character,
        from: 1,
        to: 2,
        note: 'hp/ap/mp folded into resources',
        up: (doc) => {
          const { hp, ...rest } = doc;
          return {
            ...rest,
            resources: { hp, ap: 0, mp: 0, special: { kind: 'resolve', value: 0 } },
          };
        },
      },
      {
        kind: SchemaKind.Character,
        from: 2,
        to: 3,
        note: 'loose coordinates folded into position',
        up: (doc) => {
          const { zoneId, depth, x, y, ...rest } = doc;
          return { ...rest, position: { zoneId, depth, cell: [x, y] } };
        },
      },
    ]);

    const migrated = migrateDoc(SchemaKind.Character, ancient, registry, 3);
    expect(migrated.ok && migrated.changed).toBe(true);
    expect(migrated.ok && migrated.from).toBe(1);
    expect(migrated.ok && migrated.to).toBe(3);

    // ═══ AND IT REALLY IS THE CURRENT SHAPE ═══
    // The same validator the store runs on every load, with no repairs needed
    // for anything a migration was supposed to have fixed.
    const parsed = parseCharacterFile(migrated.ok ? migrated.doc : {});
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.file.resources.hp).toBe(61);
    expect(parsed.ok && parsed.file.position).toEqual({
      zoneId: 'alderbrook',
      depth: 1,
      cell: [12, 7],
    });
    expect(parsed.ok && parsed.file.name).toBe('Sergeant Vell');
    expect(parsed.ok && parsed.file.classId).toBe('watchman');
    // Nothing was silently dropped and nothing needed repairing on the way.
    expect(parsed.ok && parsed.problems).toEqual([]);
  });

  it('a step that forgets to stamp schemaVersion is corrected by the walker', () => {
    const forgetful: Migration = {
      kind: SchemaKind.Character,
      from: 1,
      to: 2,
      note: 'forgets the stamp',
      up: (doc) => ({ ...doc }),
    };
    const result = migrateDoc(
      SchemaKind.Character,
      { schemaVersion: 1 },
      createMigrationRegistry([forgetful]),
      2,
    );
    expect(result.ok && result.doc.schemaVersion).toBe(2);
  });
});

// ===========================================================================
// saves.ts — path safety
// ===========================================================================

describe('sanitiseId', () => {
  it('accepts a Discord snowflake and a generated character id', () => {
    expect(sanitiseId(OWNER)).toBe(OWNER);
    expect(sanitiseId('chr_a1b2-3')).toBe('chr_a1b2-3');
  });

  it('refuses every shape that could escape the data directory', () => {
    for (const hostile of [
      '..',
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      'a/b',
      'a\\b',
      'C:',
      'C:\\evil',
      '/absolute',
      '.',
      '.hidden',
      'with space',
      'nul\u0000byte',
      '',
      'a'.repeat(65),
    ]) {
      expect(sanitiseId(hostile)).toBeNull();
    }
  });

  it('refuses the Windows device names, which are otherwise perfectly safe strings', () => {
    for (const device of ['CON', 'con', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT9']) {
      expect(sanitiseId(device)).toBeNull();
    }
  });

  it('refuses a non-string, so an unvalidated wire value cannot reach a path', () => {
    expect(sanitiseId(undefined)).toBeNull();
    expect(sanitiseId(12345)).toBeNull();
    expect(sanitiseId({ toString: () => 'ok' })).toBeNull();
  });
});

describe('characterPath', () => {
  it('lands under the root, one directory per owner', () => {
    const path = characterPath(root, OWNER, CHAR);
    expect(path).toBe(join(root, 'characters', OWNER, `${CHAR}.json`));
  });

  it('returns null rather than a path when either id is unsafe', () => {
    expect(characterPath(root, '../..', CHAR)).toBeNull();
    expect(characterPath(root, OWNER, '../../../secrets')).toBeNull();
  });
});

describe('maskId', () => {
  it('never puts a whole snowflake anywhere it could be pasted into an issue', () => {
    expect(maskId(OWNER)).toBe('…3744');
    expect(maskId(OWNER)).not.toContain(OWNER);
    expect(maskId('12')).toBe('****');
  });
});

// ===========================================================================
// saves.ts — the round trip
// ===========================================================================

describe('character files', () => {
  let logger: ReturnType<typeof recordingLogger>;
  let store: SaveStore;

  beforeEach(() => {
    logger = recordingLogger();
    store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it('round-trips name, class and position — the M4 definition of done', async () => {
    const written = await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    expect(written.outcome).toBe(SaveOutcome.Written);

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.outcome).toBe(LoadOutcome.Loaded);
    expect(loaded.file).toEqual(sampleCharacter({ updatedAt: '2026-08-15T12:00:00.000Z' }));
  });

  it('reports a character that has never existed as missing, not as an error', async () => {
    const loaded = await store.loadCharacter(OWNER, 'chr_nobody');
    expect(loaded.outcome).toBe(LoadOutcome.Missing);
    expect(logger.lines.filter((line) => line.level === 'error')).toHaveLength(0);
  });

  it('serialises to stable bytes, with cooldown keys sorted', async () => {
    const unsorted = sampleCharacter({
      talentCooldowns: { 'talent:zzz': 1, 'talent:aaa': 2, 'talent:mmm': 3 },
    });
    const once = serialiseCharacter(unsorted);
    expect(once).toBe(serialiseCharacter(unsorted));
    expect(once.indexOf('talent:aaa')).toBeLessThan(once.indexOf('talent:mmm'));
    expect(once.endsWith('\n')).toBe(true);

    await store.saveCharacter(unsorted, SaveReason.Manual);
    const path = characterPath(root, OWNER, CHAR);
    expect(path).not.toBeNull();
    expect(await readFile(path ?? '', 'utf8')).toBe(
      serialiseCharacter({ ...unsorted, updatedAt: '2026-08-15T12:00:00.000Z' }),
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PATH TRAVERSAL, WITH REAL HOSTILE INPUTS, THROUGH THE PUBLIC DOORS
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `sanitiseId` is unit-tested above; this is the same inputs arriving the way
   * they actually would — as an `ownerId` or a character id on a load or a save.
   * The repo is public, so the route from a wire field to a filesystem path is
   * documented for anyone who cares to read it, and "the caller validates first"
   * is not a property anyone can check. Both doors refuse, and nothing is
   * created outside the data root — asserted by the root still being EMPTY.
   */
  it('never lets a hostile id escape the data directory, on either door', async () => {
    const hostile = [
      '..',
      '../../etc/passwd',
      '..\\..\\..\\Windows\\System32\\config\\SAM',
      'C:\\Windows\\System32',
      'C:',
      '/etc/shadow',
      'nul\u0000byte',
      '.',
      '.ssh',
      'CON',
      'a'.repeat(65),
      '',
    ];

    for (const id of hostile) {
      // As the OWNER — the directory component.
      expect(characterPath(root, id, CHAR)).toBeNull();
      const loadedOwner = await store.loadCharacter(id, CHAR);
      expect(loadedOwner.outcome).toBe(LoadOutcome.Rejected);
      const savedOwner = await store.saveCharacter(
        sampleCharacter({ ownerId: id }),
        SaveReason.Manual,
      );
      expect(savedOwner.outcome).toBe(SaveOutcome.Rejected);
      expect(savedOwner.path).toBeNull();

      // As the CHARACTER id — the filename component.
      expect(characterPath(root, OWNER, id)).toBeNull();
      const loadedChar = await store.loadCharacter(OWNER, id);
      expect(loadedChar.outcome).toBe(LoadOutcome.Rejected);
      const savedChar = await store.saveCharacter(sampleCharacter({ id }), SaveReason.Manual);
      expect(savedChar.outcome).toBe(SaveOutcome.Rejected);
    }

    // THE CONTAINMENT ASSERTION: after 48 hostile requests the data root has not
    // so much as a directory in it, and nothing was written above it either.
    expect(await readdir(root)).toEqual([]);
    // And every refusal was recorded — a silent refusal is how this stops being
    // noticed the day something legitimate starts being rejected.
    expect(logger.lines.filter((line) => line.level === 'error').length).toBeGreaterThan(0);
  });

  /**
   * A crashed run leaves its scratch file beside the real one. The loader reads
   * exactly two paths — the file and its `.bak` — so a stray `.tmp` full of a
   * half-written previous attempt can never be mistaken for either.
   */
  it('ignores a scratch file left behind by a crashed write', async () => {
    await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    const path = characterPath(root, OWNER, CHAR) ?? '';

    await writeFile(
      join(root, 'characters', OWNER, `.${CHAR}.json.9999.1.tmp`),
      '{"schemaVersion":1,"kind":"character","name":"half',
      'utf8',
    );

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.outcome).toBe(LoadOutcome.Loaded);
    expect(loaded.file?.name).toBe('Sergeant Vell');
    // Untouched — cleaning up other processes' scratch is not this layer's job.
    expect(await readFile(path, 'utf8')).toContain('Sergeant Vell');
  });

  it('refuses to write a file for an unsafe id, and touches no disk', async () => {
    const result = await store.saveCharacter(
      sampleCharacter({ ownerId: '../../../../etc' }),
      SaveReason.Manual,
    );
    expect(result.outcome).toBe(SaveOutcome.Rejected);
    expect(result.path).toBeNull();
    await expect(readdir(join(root, 'characters'))).rejects.toThrow();
  });

  // ═══ CRASH RECOVERY ═══
  it('recovers from the .bak when the primary is truncated, and says so LOUDLY', async () => {
    await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    await store.saveCharacter(sampleCharacter({ name: 'Sergeant Vell II' }), SaveReason.Manual);

    // Exactly what a power cut mid-write used to produce before this layer
    // existed: a valid-looking file holding half a document.
    const path = characterPath(root, OWNER, CHAR) ?? '';
    const whole = await readFile(path, 'utf8');
    await writeFile(path, whole.slice(0, Math.floor(whole.length / 2)), 'utf8');

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.outcome).toBe(LoadOutcome.Recovered);
    // One generation back: the .bak holds the FIRST save, not the second.
    expect(loaded.file?.name).toBe('Sergeant Vell');
    expect(loaded.problems.some((problem) => problem.startsWith('primary:'))).toBe(true);
    expect(logger.lines.some((line) => line.message.includes('RECOVERED FROM ITS .bak'))).toBe(
      true,
    );
  });

  it('reports both files being corrupt without throwing — a bad save never kills boot', async () => {
    await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    const path = characterPath(root, OWNER, CHAR) ?? '';
    await writeFile(path, '{ truncated', 'utf8');
    await writeFile(backupPathFor(path), 'not json at all', 'utf8');

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.outcome).toBe(LoadOutcome.Corrupt);
    expect(loaded.file).toBeNull();
    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  // ═══ THE REFUSAL, END TO END ═══
  it('refuses a newer save AND refuses to write over it', async () => {
    const path = characterPath(root, OWNER, CHAR) ?? '';
    await mkdir(join(root, 'characters', OWNER), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ ...sampleCharacter(), schemaVersion: SCHEMA_VERSION + 1 }),
      'utf8',
    );
    // A perfectly good older backup sits right next to it — the trap.
    await writeFile(backupPathFor(path), serialiseCharacter(sampleCharacter()), 'utf8');

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.outcome).toBe(LoadOutcome.TooNew);
    expect(loaded.file).toBeNull();

    const attempted = await store.saveCharacter(sampleCharacter(), SaveReason.Death);
    expect(attempted.outcome).toBe(SaveOutcome.Quarantined);
    // Still the newer build's bytes. Nothing was coerced.
    const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(readSchemaVersion(onDisk)).toBe(SCHEMA_VERSION + 1);
  });

  // ═══ DEBOUNCE + CRITICAL EVENTS ═══
  it('coalesces repeated autosaves into one write of the newest snapshot', async () => {
    store.scheduleCharacter(sampleCharacter({ name: 'One' }));
    store.scheduleCharacter(sampleCharacter({ name: 'Two' }));
    store.scheduleCharacter(sampleCharacter({ name: 'Three' }));
    expect(store.pendingCount()).toBe(1);

    await store.flush();
    expect(store.pendingCount()).toBe(0);

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.file?.name).toBe('Three');
    // One write, so there is no previous generation to have backed up.
    await expect(readFile(backupPathFor(characterPath(root, OWNER, CHAR) ?? ''))).rejects.toThrow();
  });

  it('writes a critical event immediately rather than waiting for the debounce', async () => {
    store.scheduleCharacter(sampleCharacter({ name: 'pending' }));
    const result = await store.saveCharacter(
      sampleCharacter({ name: 'died' }),
      SaveReason.Disconnect,
    );
    expect(result.outcome).toBe(SaveOutcome.Written);
    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.file?.name).toBe('died');
  });

  it('close() flushes what was pending and then refuses further writes', async () => {
    store.scheduleCharacter(sampleCharacter({ name: 'last words' }));
    await store.close();

    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.file?.name).toBe('last words');

    const after = await store.saveCharacter(sampleCharacter(), SaveReason.Manual);
    expect(after.outcome).toBe(SaveOutcome.Rejected);
  });

  it('serialises two writes of one path so the newer snapshot cannot lose the race', async () => {
    // Both are launched before either awaits, which without the per-path chain
    // is exactly the interleaving where the staler rename lands last.
    const first = store.saveCharacter(sampleCharacter({ name: 'older' }), SaveReason.Autosave);
    const second = store.saveCharacter(sampleCharacter({ name: 'newer' }), SaveReason.Death);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.outcome)).toEqual([
      SaveOutcome.Written,
      SaveOutcome.Written,
    ]);
    const loaded = await store.loadCharacter(OWNER, CHAR);
    expect(loaded.file?.name).toBe('newer');
  });

  it('survives a save whose rename needed the R9 retry', async () => {
    renameFaults.queue.push('EBUSY', 'EPERM');
    const quick = createSaveStore({
      root,
      logger,
      now: () => '2026-08-15T12:00:00.000Z',
      atomic: {
        baseDelayMs: 1,
        sleep: async (): Promise<void> => {
          await Promise.resolve();
        },
      },
    });
    const result = await quick.saveCharacter(sampleCharacter(), SaveReason.Death);
    expect(result.outcome).toBe(SaveOutcome.Written);
    expect(logger.lines.some((line) => line.message.includes('rename blocked'))).toBe(true);
    // The redacted path is what reached the log — never the raw snowflake.
    expect(logger.lines.every((line) => !line.message.includes(OWNER))).toBe(true);
    await quick.close();
  });

  it('reports a failed write instead of throwing out of a fire-and-forget handler', async () => {
    renameFaults.queue.push('EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM');
    const doomed = createSaveStore({
      root,
      logger,
      atomic: {
        sleep: async (): Promise<void> => {
          await Promise.resolve();
        },
      },
    });
    const result = await doomed.saveCharacter(sampleCharacter(), SaveReason.Death);
    expect(result.outcome).toBe(SaveOutcome.Failed);
    expect(logger.lines.some((line) => line.message.includes('CHARACTER SAVE FAILED'))).toBe(true);
    await doomed.close();
  });
});

// ===========================================================================
// saves.ts — the validator
// ===========================================================================

describe('parseCharacterFile', () => {
  it('accepts what serialiseCharacter produces', () => {
    const parsed = parseCharacterFile(JSON.parse(serialiseCharacter(sampleCharacter())));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.problems).toEqual([]);
  });

  it('is fatal only for identity, class and HP', () => {
    const base = JSON.parse(serialiseCharacter(sampleCharacter())) as Record<string, unknown>;
    for (const missing of ['id', 'ownerId', 'name', 'classId', 'kind', 'schemaVersion']) {
      const doc = { ...base };
      delete doc[missing];
      expect(parseCharacterFile(doc).ok).toBe(false);
    }
    expect(parseCharacterFile({ ...base, resources: { ap: 1, mp: 1 } }).ok).toBe(false);
  });

  it('REPAIRS the survivable damage rather than losing the character over it', () => {
    const base = JSON.parse(serialiseCharacter(sampleCharacter())) as Record<string, unknown>;
    const parsed = parseCharacterFile({
      ...base,
      talentCooldowns: { 'talent:ok': 2, 'talent:bad': 'soon', 'talent:zero': 0 },
      effects: [
        { effectId: 'effect:stunned', turnsRemaining: 1 },
        { effectId: 'effect:gone', turnsRemaining: 0 },
        'not an object',
      ],
      position: { zoneId: 'alderbrook', depth: 1, cell: [4] },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.file.talentCooldowns).toEqual({ 'talent:ok': 2 });
    expect(parsed.ok && parsed.file.effects).toEqual([
      { effectId: 'effect:stunned', turnsRemaining: 1 },
    ]);
    expect(parsed.ok && parsed.file.position).toBeNull();
    // Five repairs, every one of them recorded: two cooldowns, two effects, the
    // cell. A repair that is not in `problems` is a silent data change.
    expect(parsed.ok && parsed.problems).toEqual([
      'talentCooldowns.talent:bad: not a positive number — dropped',
      'talentCooldowns.talent:zero: not a positive number — dropped',
      'effects[1]: no effectId or no positive duration — dropped',
      'effects[2]: not an object — dropped',
      'position.cell: not a pair of numbers — treated as unplaced',
    ]);
  });

  it('strips control characters and over-long names', () => {
    const base = JSON.parse(serialiseCharacter(sampleCharacter())) as Record<string, unknown>;
    const parsed = parseCharacterFile({ ...base, name: `Ve\u0007ll\u001b[31m` });
    expect(parsed.ok && parsed.file.name).toBe('Vell[31m');
    expect(parsed.ok && parsed.problems.some((p) => p.startsWith('name:'))).toBe(true);

    const long = parseCharacterFile({ ...base, name: 'x'.repeat(200) });
    expect(long.ok && long.file.name).toHaveLength(40);
  });

  it('keeps a dangling classId as a SOFT reference for the caller to resolve', () => {
    const base = JSON.parse(serialiseCharacter(sampleCharacter())) as Record<string, unknown>;
    const parsed = parseCharacterFile({ ...base, classId: 'class_deleted_in_m6' });
    expect(parsed.ok && parsed.file.classId).toBe('class_deleted_in_m6');
  });

  it('stores no derived maximum — every max* pool is recomputed from the class', () => {
    const text = serialiseCharacter(sampleCharacter());
    for (const derived of ['maxHp', 'maxAp', 'maxMp', 'accuracy', 'defence', 'armour']) {
      expect(text).not.toContain(derived);
    }
  });
});

// ===========================================================================
// saves.ts — THE FOUR PROGRESSION FIELDS
//
// The whole hazard in one sentence: `parseCharacterFile` copies only the fields
// it NAMES and `serialiseCharacter` rebuilds a fixed canonical literal, so a
// field that exists on the type and is missed by either is deleted on every load
// and written away by the next autosave, silently, with both halves consistently
// wrong. `parseCharacterFile accepts what serialiseCharacter produces` above
// cannot see that — a symmetric omission passes it. Every test below therefore
// names its field and its value out loud.
// ===========================================================================

/** The Watchman's four, as `classes.ts:191` orders them. Namespaced ids, like the sheet's. */
const WATCHMAN_LOADOUT = [
  'talent:crude_blow',
  'talent:ward_rush',
  'talent:iron_curtain',
  'talent:lockdown',
] as const;

/**
 * A REAL PRE-PROGRESSION FILE — v1, exactly as this game wrote them before
 * levelling existed. Written out longhand rather than derived by deleting keys
 * from `sampleCharacter()`, because the point of the fixture is that it is what
 * is actually sitting in somebody's `data/characters/` right now.
 */
const V1_BEFORE_PROGRESSION = {
  schemaVersion: 1,
  kind: 'character',
  id: CHAR,
  ownerId: OWNER,
  name: 'Sergeant Vell',
  classId: 'watchman',
  resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
  talentCooldowns: { 'talent:lockdown': 3 },
  effects: [],
  position: { zoneId: 'alderbrook', depth: 1, cell: [12, 7] },
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
} as const;

/** The sheet a restore would build from a parsed spread. Mirrors the real path. */
function sheetFrom(talentPoints: Readonly<Record<string, number>> | undefined) {
  return createTalentSheet({
    classId: ClassId.Watchman,
    loadout: [...WATCHMAN_LOADOUT],
    resource: ResourceKind.Resolve,
    maxAp: 6,
    maxMp: 3,
    points: new Map(Object.entries(talentPoints ?? {})),
  });
}

describe('character files: level, xp, unspent points and raw talent points', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOAD-BEARING ONE. "ABSENT MEANS A LEVEL-1 CHARACTER WITH ITS FOUR BIRTH
   * TALENTS" IS A DECISION, SO IT GETS AN ASSERTION RATHER THAN A DEFAULT.
   * ═══════════════════════════════════════════════════════════════════════════
   * Every save on disk today is this file. If it loads as anything other than a
   * fresh level-1 Watchman — or, worse, refuses — then shipping progression cost
   * every existing character. The four talents at rank 1 matter as much as the
   * level does: `combatTalentScale` maps a talent level of 0 to 0.1
   * (src/shared/scale.ts:191), so a talent seeded at 0 does not error, it simply
   * does a tenth of its damage forever.
   */
  it('loads a v1 file with none of the four fields as a level-1 character, four talents at rank 1', () => {
    const parsed = parseCharacterFile(V1_BEFORE_PROGRESSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.level).toBe(1);
    expect(parsed.file.xp).toBe(0);
    expect(parsed.file.unspentPoints).toBe(0);
    expect(parsed.file.talentPoints).toEqual({});

    // AN ABSENCE IS NOT A REPAIR. Nothing was wrong with this file, so nothing
    // is reported — a `problems` entry here would make the store log a warning
    // for every returning player on the first evening.
    expect(parsed.problems).toEqual([]);

    // And through the constructor a restore would really use: four talents, each
    // at exactly its birth rank, nothing at 0 and nothing missing.
    const sheet = sheetFrom(parsed.file.talentPoints);
    for (const id of WATCHMAN_LOADOUT) expect(getTalentLevel(sheet, id)).toBe(1);
    expect(sheet.points.size).toBe(4);
  });

  /**
   * THE ROUND TRIP, WITH EVERY FIELD NAMED AND EVERY VALUE CONCRETE.
   *
   * `parseCharacterFile accepts what serialiseCharacter produces` is the test
   * this one exists to backstop: drop `level` from BOTH the parser and the
   * serialiser and that test still passes, because both halves agree about a
   * field neither one has. These assertions name the field and the number.
   */
  it('carries all four fields through create → serialise → parse with their values intact', () => {
    // Level 7 grants 7 points (levels 2-7, plus the extra at 5). The spread below
    // spends 3 + 1 + 0 + 2 = 6 of them, so exactly one is left in hand.
    const spread = {
      'talent:crude_blow': 4,
      'talent:ward_rush': 2,
      'talent:iron_curtain': 1,
      'talent:lockdown': 3,
    };
    const created = createCharacterFile({
      id: CHAR,
      ownerId: OWNER,
      name: 'Sergeant Vell',
      classId: 'watchman',
      level: 7,
      // FRACTIONAL ON PURPOSE: one kill against a normal pays `level × 0.8 × 4`,
      // so a rounded xp field would shave a fifth off every early award.
      xp: 123.5,
      talentPoints: spread,
      resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    const parsed = parseCharacterFile(JSON.parse(serialiseCharacter(created)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.level).toBe(7);
    expect(parsed.file.xp).toBe(123.5);
    expect(parsed.file.talentPoints).toEqual(spread);
    expect(parsed.file.unspentPoints).toBe(1);
    // The same number as the ledger, spelled out so a retune of `pointsForLevel`
    // moves this test rather than leaving it asserting a stale literal.
    expect(parsed.file.unspentPoints).toBe(totalPointsAtLevel(7) - 6);
    expect(parsed.problems).toEqual([]);

    // And the raw spread really does reach the sheet as talent levels.
    const sheet = sheetFrom(parsed.file.talentPoints);
    expect(getTalentLevel(sheet, 'talent:crude_blow')).toBe(4);
    expect(getTalentLevel(sheet, 'talent:iron_curtain')).toBe(1);
  });

  /**
   * A GENERAL NET UNDER THE SPECIFIC ONES. Whatever `createCharacterFile` builds,
   * `serialiseCharacter` writes and `parseCharacterFile` reads back — key for
   * key. The next field added to the type fails HERE if it is missed in either,
   * without anybody having to remember to extend the test above.
   */
  it('loses no field between create, serialise and parse — the whole key set survives', () => {
    const created = sampleCharacter();
    const parsed = parseCharacterFile(JSON.parse(serialiseCharacter(created)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.file).sort()).toEqual(Object.keys(created).sort());
  });

  /**
   * BYTE STABILITY. `writeFileAtomic` and the `.bak` generation rest on the same
   * snapshot producing the same bytes: if a load-then-save cycle reordered or
   * dropped a key, every autosave would rewrite the file and the backup would
   * step a generation for no reason.
   */
  it('re-serialises a file that already has the four fields byte-identically', () => {
    const created = createCharacterFile({
      id: CHAR,
      ownerId: OWNER,
      name: 'Sergeant Vell',
      classId: 'watchman',
      level: 4,
      xp: 12.8,
      talentPoints: { 'talent:lockdown': 3, 'talent:crude_blow': 2 },
      resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    const once = serialiseCharacter(created);
    const parsed = parseCharacterFile(JSON.parse(once));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serialiseCharacter(parsed.file)).toBe(once);

    // Sorted keys, for the reason the cooldowns are sorted: insertion order here
    // follows the order the points happened to be SPENT in.
    expect(once.indexOf('talent:crude_blow')).toBeLessThan(once.indexOf('talent:lockdown'));
  });

  /**
   * ═══ THE SOFT REFERENCE. FRIENDS' SAVES MUST OUTLIVE CONTENT EDITS. ═══
   * docs/data-schemas.md:51-52. A talent id that has been renamed or deleted is
   * carried through verbatim, not rejected: this layer cannot import the talent
   * registry (the same rule that makes `classId` soft), so it cannot tell a
   * deleted talent from one it has never heard of. The restore path owns the
   * refund, and it is the only layer with the registry to do it with.
   */
  it('tolerates a talentPoints id that no longer exists in content', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      level: 5,
      talentPoints: { 'talent:crude_blow': 2, 'talent:deleted_in_m7': 3 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Kept, unrepaired, with no complaint — the id is data, not a schema error.
    expect(parsed.file.talentPoints).toEqual({
      'talent:crude_blow': 2,
      'talent:deleted_in_m7': 3,
    });
    expect(parsed.problems).toEqual([]);

    // The sheet drops what the class no longer has, which is why the refund is
    // owed: 3 points went into a talent that is not in the loadout any more.
    const sheet = sheetFrom(parsed.file.talentPoints);
    expect(sheet.points.has('talent:deleted_in_m7')).toBe(false);
    expect(getTalentLevel(sheet, 'talent:crude_blow')).toBe(2);
  });

  /**
   * REPAIR, DON'T REJECT — `scrubName`'s doctrine (saves.ts:258-276) applied to
   * a hand-edited or half-written progression block. Losing a character over a
   * stray byte is the failure this whole layer exists to avoid, and every repair
   * is recorded because a silent repair is a silent data change.
   */
  it('repairs garbage talent points rather than throwing or refusing the file', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      level: 10,
      talentPoints: {
        'talent:crude_blow': -3,
        'talent:ward_rush': 2.7,
        'talent:iron_curtain': TALENT_MAX_LEVEL + 40,
        'talent:lockdown': Number.NaN,
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.talentPoints).toEqual({
      // Below the birth rank is not a talent level at all — a rank-0 talent
      // fires for a tenth of its damage rather than refusing (scale.ts:191).
      'talent:crude_blow': 1,
      'talent:ward_rush': 2,
      'talent:iron_curtain': TALENT_MAX_LEVEL,
      'talent:lockdown': 1,
    });
    expect(parsed.problems).toHaveLength(4);
    expect(parsed.problems.every((problem) => problem.startsWith('talentPoints.'))).toBe(true);
  });

  it('repairs a level outside 1..MAX_CHARACTER_LEVEL and an xp that is not a number', () => {
    const high = parseCharacterFile({ ...V1_BEFORE_PROGRESSION, level: 9999, xp: 'soon' });
    expect(high.ok).toBe(true);
    if (!high.ok) return;
    // Clamped rather than trusted: `totalPointsAtLevel(9999)` would hand out
    // eleven thousand talent points to a file somebody edited in Notepad.
    expect(high.file.level).toBe(MAX_CHARACTER_LEVEL);
    expect(high.file.xp).toBe(0);
    expect(high.problems.some((problem) => problem.startsWith('level:'))).toBe(true);
    expect(high.problems.some((problem) => problem.startsWith('xp:'))).toBe(true);

    const low = parseCharacterFile({ ...V1_BEFORE_PROGRESSION, level: 0, xp: -50 });
    expect(low.ok && low.file.level).toBe(1);
    expect(low.ok && low.file.xp).toBe(0);

    const fractional = parseCharacterFile({ ...V1_BEFORE_PROGRESSION, level: 3.9 });
    expect(fractional.ok && fractional.file.level).toBe(3);
  });

  /**
   * ═══ THE STORED COUNT IS A CACHE, AND THE LEDGER OVERRULES IT ═══
   * docs/data-schemas.md:94-104's "NEVER persist a derived value". Unspent is
   * `totalPointsAtLevel(level)` minus every raw point SPENT — and the minus-one
   * per talent is the birth grant, which is the arithmetic that is easy to get
   * wrong: four talents at rank 1 is a fresh character with nothing spent, not
   * four points gone.
   *
   * Recomputing is what makes a retune of `pointsForLevel` correct every
   * existing character instead of stranding the ones saved under the old grant.
   */
  it('recomputes unspentPoints from the ledger instead of trusting the file', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      level: 5,
      unspentPoints: 99,
      talentPoints: { 'talent:crude_blow': 3 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Level 5 grants 5 (one each for levels 2-5, plus the fifth-level extra);
    // rank 3 in one talent is 2 points spent, because rank 1 was free.
    expect(totalPointsAtLevel(5)).toBe(5);
    expect(parsed.file.unspentPoints).toBe(3);
    expect(parsed.problems.some((problem) => problem.startsWith('unspentPoints:'))).toBe(true);
  });

  it('never reports a negative points balance, however many talents the file names', () => {
    // A class change, or a file carrying more ids than the current loadout: the
    // subtraction goes negative and a negative "points in hand" would render as
    // a `+` button that silently refuses.
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      level: 1,
      talentPoints: { 'talent:a': 5, 'talent:b': 5, 'talent:c': 5 },
    });
    expect(parsed.ok && parsed.file.unspentPoints).toBe(0);
  });

  /**
   * A fresh character's four talents cost nothing. If the birth grant is ever
   * dropped from the ledger, a brand-new level-1 Watchman shows minus four
   * points in hand and the panel is unusable from the first second.
   */
  it('charges nothing for the four birth talents at rank 1', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      level: 1,
      talentPoints: Object.fromEntries(WATCHMAN_LOADOUT.map((id) => [id, 1])),
    });
    expect(parsed.ok && parsed.file.unspentPoints).toBe(0);
    expect(parsed.ok && parsed.problems).toEqual([]);
  });

  it('survives the real store: a save and a load keep the level and the spread', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });
    const file = sampleCharacter({
      level: 6,
      xp: 40.8,
      unspentPoints: 4,
      talentPoints: { 'talent:crude_blow': 3 },
    });

    expect((await store.saveCharacter(file, SaveReason.Manual)).outcome).toBe(SaveOutcome.Written);
    const loaded = await store.loadCharacter(OWNER, CHAR);

    expect(loaded.outcome).toBe(LoadOutcome.Loaded);
    expect(loaded.file?.level).toBe(6);
    expect(loaded.file?.xp).toBe(40.8);
    expect(loaded.file?.talentPoints).toEqual({ 'talent:crude_blow': 3 });
    // 6 granted at level 6, 2 spent on rank 3 — the file's own 4 agrees, so the
    // reconciliation is silent rather than logging a repair on every load.
    expect(loaded.file?.unspentPoints).toBe(4);
    expect(loaded.problems.filter((problem) => problem.includes('unspentPoints'))).toEqual([]);

    await store.close();
  });
});

// ===========================================================================
// saves.ts — THE TWO ITEM FIELDS
//
// Identical hazard to the four above and it gets the identical treatment: a
// field named on `CharacterFile` and missed by either `parseCharacterFile` or
// `serialiseCharacter` is deleted on every load and written away by the next
// autosave, with both halves consistently wrong and the gate green. Every test
// below names its field and its value out loud.
//
// The one thing that is NOT like progression: absent is not empty. A character
// file with no `carried` key is not a character with an empty bag, it is a file
// written by something that could not say — and `fileFor`'s `?? binding` chain
// reads the two completely differently. Both branches are asserted separately,
// here and in the bridge suite at the bottom of the file.
// ===========================================================================

/** A full seven-slot Watchman kit, one real catalogue id per slot. */
const WORN_KIT: Readonly<Record<string, string>> = {
  head: 'item_watchmans_cap',
  body: 'item_watchmans_coat',
  legs: 'item_watchmans_trousers',
  feet: 'item_watchmans_boots',
  offhand: 'item_watchmans_buckler',
  ring: 'item_watchmans_brass_ring',
  trinket: 'item_watchmans_badge',
};

/** Three real ids in the bag, none of them worn above. */
const IN_THE_BAG: readonly string[] = [
  'item_leather_chest',
  'item_inspectors_signet',
  'item_inquisitors_tome',
];

describe('character files: the bag and the paper doll', () => {
  /**
   * THE GENERAL NET, EXTENDED. :1075's sibling — whatever `createCharacterFile`
   * builds survives serialise and parse key for key — but with the two new names
   * spelled out, because the general test passes vacuously for a field that is
   * missing from BOTH halves.
   */
  it('loses no field between create, serialise and parse — including carried and equipped', () => {
    const created = createCharacterFile({
      id: CHAR,
      ownerId: OWNER,
      name: 'Sergeant Vell',
      classId: 'watchman',
      carried: IN_THE_BAG,
      equipped: WORN_KIT,
      resources: { hp: 61, ap: 4, mp: 2, special: { kind: 'resolve', value: 3 } },
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    const parsed = parseCharacterFile(JSON.parse(serialiseCharacter(created)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(Object.keys(parsed.file).sort()).toEqual(Object.keys(created).sort());
    // Named, so that dropping one from the parser AND the serialiser together —
    // the symmetric omission the key-set check cannot see — still fails here.
    expect(Object.keys(parsed.file)).toContain('carried');
    expect(Object.keys(parsed.file)).toContain('equipped');
    expect(parsed.file.equipped).toEqual(WORN_KIT);
    expect(parsed.file.carried).toEqual(IN_THE_BAG);
    expect(parsed.problems).toEqual([]);
  });

  /**
   * ═══ ABSENT IS NOT EMPTY, AT THE PARSER ═══
   * Every save on disk today has neither key. It must load clean — no repair
   * logged, because an absence is not damage — and it must load as UNDEFINED
   * rather than as `[]`, or the bridge one layer up can no longer tell "this
   * character owns nothing" from "this file never mentioned items" and will
   * happily write an empty bag over a full one.
   */
  it('loads a file with neither key clean, with both fields undefined', () => {
    const parsed = parseCharacterFile(V1_BEFORE_PROGRESSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.carried).toBeUndefined();
    expect(parsed.file.equipped).toBeUndefined();
    expect(parsed.problems).toEqual([]);
  });

  /**
   * AND THE ABSENCE SURVIVES TO THE BYTES. `JSON.stringify` omits an
   * undefined-valued key, which is what keeps a pre-items file byte-identical
   * through a load-and-save cycle: emitting `"carried": []` instead would
   * rewrite every file in `data/characters/` on first sight and step every
   * `.bak` a generation for nothing.
   */
  it('writes no carried or equipped key for a character that has never had either', () => {
    const text = serialiseCharacter(sampleCharacter());
    expect(text).not.toContain('carried');
    expect(text).not.toContain('equipped');

    const once = `${JSON.stringify(V1_BEFORE_PROGRESSION, null, 2)}\n`;
    const parsed = parseCharacterFile(JSON.parse(once));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Not byte-identical to `once` — that file predates the four progression
    // fields, which ARE written unconditionally — but it gains no item keys.
    const rewritten = serialiseCharacter(parsed.file);
    expect(rewritten).not.toContain('carried');
    expect(rewritten).not.toContain('equipped');
  });

  /**
   * ═══ BYTE STABILITY. THE WORN MAP IS SORTED BECAUSE ITS ORDER IS AN ACCIDENT ═══
   * `Object.entries` follows insertion order, and insertion order here follows
   * whichever order the player happened to put their gear on in. Two saves of
   * one character must produce identical bytes or every autosave rewrites the
   * file. Same reason the cooldown and talent-point sorts exist.
   */
  it('serialises the same loadout to the same bytes whatever order the slots were filled in', () => {
    const dressedTopDown = sampleCharacter({
      equipped: { head: WORN_KIT.head ?? '', body: WORN_KIT.body ?? '', ring: WORN_KIT.ring ?? '' },
    });
    const dressedInAPanic = sampleCharacter({
      equipped: { ring: WORN_KIT.ring ?? '', head: WORN_KIT.head ?? '', body: WORN_KIT.body ?? '' },
    });

    const once = serialiseCharacter(dressedTopDown);
    expect(once).toBe(serialiseCharacter(dressedTopDown));
    expect(once).toBe(serialiseCharacter(dressedInAPanic));
    // Sorted, spelled out: body, head, ring.
    expect(once.indexOf('"body"')).toBeLessThan(once.indexOf('"head"'));
    expect(once.indexOf('"head"')).toBeLessThan(once.indexOf('"ring"'));

    // THE BAG IS NOT SORTED, and that is deliberate: an array already has one
    // order, and that order is PICKUP order, which is what the panel draws.
    const bagged = sampleCharacter({ carried: ['item_inquisitors_tome', 'item_leather_chest'] });
    const bytes = serialiseCharacter(bagged);
    expect(bytes).toBe(serialiseCharacter(bagged));
    expect(bytes.indexOf('item_inquisitors_tome')).toBeLessThan(
      bytes.indexOf('item_leather_chest'),
    );
  });

  /**
   * REPAIR, NEVER REJECT — `parseTalentPoints`'s doctrine, applied to a
   * hand-edited or content-drifted loadout. Losing a character over a stray item
   * id would be the whole layer failing at its one job; losing an ITEM silently
   * would be this feature failing at its one job. So every drop is recorded.
   */
  it('drops an item id this build does not know, and says so', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      carried: ['item_leather_chest', 'item_deleted_in_m8', 'item_watchmans_boots'],
      equipped: { head: 'item_watchmans_cap', ring: 'item_cut_before_ship' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.carried).toEqual(['item_leather_chest', 'item_watchmans_boots']);
    expect(parsed.file.equipped).toEqual({ head: 'item_watchmans_cap' });
    expect(parsed.problems).toEqual([
      "equipped.ring: 'item_cut_before_ship' is not an item this build knows — dropped",
      "carried[1]: 'item_deleted_in_m8' is not an item this build knows — dropped",
    ]);
  });

  /**
   * A slot key and an item id are coherent together or not at all, and only the
   * catalogue knows which. This is the one field in the file where two values
   * have to AGREE, which is why it is validated where a talent id is kept
   * verbatim.
   */
  it('drops an equipped entry filed under the wrong slot, and says so', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      // A cap is a HEAD item; a buckler is an OFFHAND one. Neither belongs where
      // this file puts it. `wibble` is not a slot at all, which the same check
      // catches — no item's slot is `wibble`.
      equipped: {
        feet: 'item_watchmans_cap',
        offhand: 'item_watchmans_buckler',
        wibble: 'item_watchmans_badge',
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.equipped).toEqual({ offhand: 'item_watchmans_buckler' });
    expect(parsed.problems).toEqual([
      "equipped.feet: 'item_watchmans_cap' is worn in the 'head' slot, not 'feet' — dropped",
      "equipped.wibble: 'item_watchmans_badge' is worn in the 'trinket' slot, not 'wibble' — dropped",
    ]);
  });

  /**
   * ═══ ONE LOADOUT, NOT TWO LISTS ═══
   * An id in both places keeps the WORN copy: it is the more specific claim, it
   * names a slot, and it is moving the character's numbers right now. Duplicates
   * inside the bag collapse for the same reason — with no `uid` (rejected in
   * `CharacterFile`'s docblock, with the dangling-index bug it would have
   * brought), two entries of one id are indistinguishable to every consumer.
   */
  it('keeps the equipped copy when an id is in both lists, and collapses bag duplicates', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      equipped: { head: 'item_watchmans_cap' },
      carried: [
        'item_watchmans_cap',
        'item_leather_chest',
        'item_leather_chest',
        'item_inspectors_signet',
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.equipped).toEqual({ head: 'item_watchmans_cap' });
    expect(parsed.file.carried).toEqual(['item_leather_chest', 'item_inspectors_signet']);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems.every((problem) => problem.startsWith('carried['))).toBe(true);
  });

  /**
   * ORDER BETWEEN THE TWO PARSERS. `parseCarried` de-duplicates against what is
   * WORN, so `equipped` has to be validated first: an id that is about to be
   * dropped out of `equipped` must not still suppress the bag's copy, or the
   * character loses the item twice over for one mistake.
   */
  it('does not let a REJECTED equipped entry suppress the same id in the bag', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      // The cap is filed under FEET, so the worn entry is dropped. The bag's copy
      // is the only surviving record that this character owns a cap.
      equipped: { feet: 'item_watchmans_cap' },
      carried: ['item_watchmans_cap'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.equipped).toEqual({});
    expect(parsed.file.carried).toEqual(['item_watchmans_cap']);
  });

  /**
   * PRESENT-BUT-UNREADABLE IS NOT ABSENT. The file did speak; what it said is
   * unusable. `{}` / `[]` is the honest reading, and it is `parseCooldowns`'s
   * rule applied to two more fields.
   */
  it('turns a present-but-garbage key into an empty loadout, not into an absent one', () => {
    const parsed = parseCharacterFile({
      ...V1_BEFORE_PROGRESSION,
      carried: 'my coat',
      equipped: 42,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.file.carried).toEqual([]);
    expect(parsed.file.equipped).toEqual({});
    expect(parsed.problems).toHaveLength(2);
  });

  it('survives the real store: a save and a load keep the kit and the bag', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });
    const file = sampleCharacter({ equipped: WORN_KIT, carried: IN_THE_BAG });

    expect((await store.saveCharacter(file, SaveReason.Manual)).outcome).toBe(SaveOutcome.Written);
    const loaded = await store.loadCharacter(OWNER, CHAR);

    expect(loaded.outcome).toBe(LoadOutcome.Loaded);
    expect(loaded.file?.equipped).toEqual(WORN_KIT);
    expect(loaded.file?.carried).toEqual(IN_THE_BAG);
    // A clean load: nothing in a file this build just wrote should need repairing.
    expect(loaded.problems.filter((problem) => problem.includes('item_'))).toEqual([]);

    await store.close();
  });
});

// ===========================================================================
// saves.ts — THE BRIDGE, END TO END. `createCharacterBridge` and nothing faked.
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEST THAT WAS MISSING WHILE PROGRESSION DID NOT PERSIST AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other suite in this file drives `createSaveStore` — the disk half — and
 * test/server/gateway-progression.test.ts drives a HAND-WRITTEN `saves.restore`
 * object. Nothing anywhere walked `createCharacterBridge`, which is the piece
 * that sits between them, and that is precisely how a build shipped in which
 * `fileFor` wrote `binding.level` (the value frozen when the file was OPENED,
 * so provably 1 forever) and `openCharacter` returned `{hp, cooldowns, classId}`
 * and nothing else. Both halves were honestly documented as open handoffs; the
 * 1,400-test gate was green with the feature completely inert on disk.
 *
 * SO THIS DRIVES THE REAL BRIDGE, BOTH DIRECTIONS: bind, save a level-6
 * snapshot with a spread, rebuild the bridge from scratch (a new evening, a new
 * process), reopen, and assert all four came back. Reverting either half of the
 * fix fails it.
 */
describe('the character bridge carries progression in both directions', () => {
  const ACTOR = 'act_ren';

  /** A bridge over the real store, rooted in this test's temp directory. */
  const bridgeOver = (
    store: SaveStore,
    logger: SaveLogger,
  ): ReturnType<typeof createCharacterBridge> =>
    createCharacterBridge({ store, logger, now: () => '2026-08-15T12:00:00.000Z' });

  it('saves a level-6 spread and hands it back on the next open', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    // ── EVENING ONE ────────────────────────────────────────────────────────
    // A brand-new account: `openCharacter` answers null (there is no file yet)
    // but STILL BINDS, which is what makes the save below legal at all.
    const first = bridgeOver(store, logger);
    expect(await first.openCharacter?.(OWNER, ACTOR)).toBe(null);

    // Ren ends the evening at level 6 with Crude Blow at rank 3 and Iron Curtain
    // at rank 2 — three raw points spent out of the six a level-6 character has,
    // so three are still in hand. This is exactly the shape `snapshotPlayers`
    // builds off `PlayerActor` plus the `talentPointsOf` seam.
    first.savePlayersNow?.(
      [
        {
          actorId: ACTOR,
          name: 'Ren',
          hp: 44,
          cooldowns: { 'talent:crude_blow': 2 },
          x: 12,
          y: 7,
          classId: 'watchman',
          level: 6,
          xp: 41.6,
          unspentPoints: 3,
          talentPoints: { 'talent:crude_blow': 3, 'talent:iron_curtain': 2 },
        },
      ],
      'disconnect',
    );
    await store.flush();

    // ── EVENING TWO ────────────────────────────────────────────────────────
    // A FRESH BRIDGE, because the bug being pinned is that the binding echoed
    // back what it read: reusing the first bridge would let a broken build pass
    // on its own in-memory copy.
    const second = bridgeOver(store, logger);
    const restored = await second.openCharacter?.(OWNER, ACTOR);

    expect(restored?.level).toBe(6);
    expect(restored?.xp).toBe(41.6);
    expect(restored?.unspentPoints).toBe(3);
    expect(restored?.talentPoints).toEqual({
      'talent:crude_blow': 3,
      'talent:iron_curtain': 2,
    });
    // The three fields that always worked, so a regression in the new lines is
    // told apart from a regression in the file format.
    expect(restored?.hp).toBe(44);
    expect(restored?.classId).toBe('watchman');
    expect(restored?.cooldowns).toEqual({ 'talent:crude_blow': 2 });

    // `totalPointsAtLevel(6)` minus the two raw points spent above (3-1 and 2-1)
    // is 3 — the number the file claims — so `parseCharacterFile` reconciled
    // silently rather than logging a repair on a file it had just written.
    expect(totalPointsAtLevel(6) - 2 - 1).toBe(3);

    await store.close();
  });

  it('keeps the file when the snapshot cannot say — the `?? binding` fallback', async () => {
    // A body whose class is still provisional has `talentPoints` DELIBERATELY
    // omitted by `snapshotPlayers` (a spread against a class nobody picked would
    // be a lie), and test fixtures omit progression entirely. Neither may be
    // read as "reset this character to level 1", which is the exact failure the
    // frozen-binding design was originally built to prevent — so the fallback
    // has to survive the fix that made the snapshot win.
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    // A file already on disk at level 8.
    await store.saveCharacter(
      sampleCharacter({
        id: 'chr_main',
        level: 8,
        xp: 12,
        unspentPoints: 9,
        talentPoints: { 'talent:crude_blow': 1 },
      }),
      SaveReason.Manual,
    );

    const bridge = bridgeOver(store, logger);
    const opened = await bridge.openCharacter?.(OWNER, ACTOR);
    expect(opened?.level).toBe(8);

    // A snapshot with NO progression at all — the pre-progression producer.
    bridge.savePlayersNow?.(
      [{ actorId: ACTOR, name: 'Ren', hp: 30, cooldowns: {}, x: 1, y: 1 }],
      'disconnect',
    );
    await store.flush();

    const again = bridgeOver(store, logger);
    const reopened = await again.openCharacter?.(OWNER, ACTOR);
    // Carried forward, NOT overwritten with the birth defaults.
    expect(reopened?.level).toBe(8);
    expect(reopened?.talentPoints).toEqual({ 'talent:crude_blow': 1 });

    await store.close();
  });
});

// ===========================================================================
// saves.ts — THE BRIDGE, FOR ITEMS. Same seam, same two half-failures.
// ===========================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEST THAT WOULD HAVE CAUGHT THE PROGRESSION BUG, WRITTEN FIRST THIS TIME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The bridge has TWO independent halves and each one fails quietly on its own:
 *
 *   `fileFor` reading `binding.carried` unconditionally freezes the disk at
 *   whatever the file said when it was OPENED, so an evening's drops reach no
 *   file at all and every autosave writes the morning's bag back over them.
 *
 *   `openCharacter` not RETURNING the fields leaves `CharacterRestore.carried`
 *   undefined forever, so the restore path correctly and permanently takes its
 *   "this port cannot say" branch on a file that says it perfectly clearly.
 *
 * Both are individually defensible-looking, both were shipped once already for
 * progression, and the 1,400-test gate was green through it. So this walks the
 * REAL `createSaveStore` and the REAL `createCharacterBridge`, both directions,
 * and BUILDS A FRESH BRIDGE for the second evening — reusing the first would let
 * a broken build pass on its own in-memory copy.
 */
describe('the character bridge carries inventory and equipment in both directions', () => {
  const ACTOR = 'act_ren';

  const bridgeOver = (
    store: SaveStore,
    logger: SaveLogger,
  ): ReturnType<typeof createCharacterBridge> =>
    createCharacterBridge({ store, logger, now: () => '2026-08-15T12:00:00.000Z' });

  /**
   * ═══ THE GATEWAY SEAM, NAMED RATHER THAN CAST OVER ═══
   * `CharacterSnapshot` and `CharacterRestore` are owned by the pass that wires
   * the loot verbs to the wire; saves.ts states the two item fields structurally
   * as `SavedLoadout` and intersects them on. These two helpers are the test
   * saying the same thing: a producer that knows about items builds the richer
   * shape, and the bridge takes it because both fields are optional.
   *
   * NEITHER IS A CAST. Both are identity functions with a declared parameter
   * type, and TypeScript accepts the assignment in both directions precisely
   * because every field `SavedLoadout` adds is optional — which is the same
   * property that lets an untaught producer keep working. An `as` here would
   * have hidden the day the two shapes stop lining up; this fails to compile
   * instead.
   */
  const withLoadout = (snapshot: CharacterSnapshot & SavedLoadout): CharacterSnapshot => snapshot;
  const restored = (
    value: (CharacterRestore & SavedLoadout) | null | undefined,
  ): (CharacterRestore & SavedLoadout) | null | undefined => value;

  it('saves a full seven-slot kit and a bag, and hands both back on the next open', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    // ── EVENING ONE ────────────────────────────────────────────────────────
    const first = bridgeOver(store, logger);
    expect(await first.openCharacter?.(OWNER, ACTOR)).toBe(null);

    // Ren ends the evening in a complete Watchman kit with three things in the
    // bag. This is the shape `snapshotPlayers` builds straight off `PlayerActor`.
    first.savePlayersNow?.(
      [
        withLoadout({
          actorId: ACTOR,
          name: 'Ren',
          hp: 44,
          cooldowns: { 'talent:crude_blow': 2 },
          x: 12,
          y: 7,
          classId: 'watchman',
          equipped: WORN_KIT,
          carried: IN_THE_BAG,
        }),
      ],
      'disconnect',
    );
    await store.flush();

    // The bytes really did land, with the slot keys sorted.
    const path = characterPath(root, OWNER, 'chr_main') ?? '';
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('item_watchmans_coat');
    expect(onDisk.indexOf('"body"')).toBeLessThan(onDisk.indexOf('"feet"'));

    // ── EVENING TWO ────────────────────────────────────────────────────────
    // A FRESH BRIDGE. The bug being pinned is a binding that echoes back what it
    // read, so the first bridge's memory must not be available to answer with.
    const second = bridgeOver(store, logger);
    const back = restored(await second.openCharacter?.(OWNER, ACTOR));

    expect(back?.equipped).toEqual(WORN_KIT);
    expect(back?.carried).toEqual(IN_THE_BAG);
    // The fields that always worked, so a regression in the two new lines is told
    // apart from a regression in the file format.
    expect(back?.hp).toBe(44);
    expect(back?.classId).toBe('watchman');

    await store.close();
  });

  /**
   * ═══ ABSENT IS NOT EMPTY, AT THE BRIDGE. BOTH BRANCHES, SEPARATELY. ═══
   * BRANCH ONE: a snapshot that CANNOT SAY — a fixture, the e2e harness, any
   * producer not yet taught to fill the two fields — falls back to the binding,
   * which is what the file said. Reading it as "the bag is empty" would delete
   * an evening's loot on the first autosave of the next session.
   */
  it('keeps the loadout when the snapshot cannot say — the `?? binding` fallback', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    await store.saveCharacter(
      sampleCharacter({ id: 'chr_main', equipped: WORN_KIT, carried: IN_THE_BAG }),
      SaveReason.Manual,
    );

    const bridge = bridgeOver(store, logger);
    expect(restored(await bridge.openCharacter?.(OWNER, ACTOR))?.equipped).toEqual(WORN_KIT);

    // A snapshot with no item fields at all — the pre-loot producer.
    bridge.savePlayersNow?.(
      [{ actorId: ACTOR, name: 'Ren', hp: 30, cooldowns: {}, x: 1, y: 1 }],
      'disconnect',
    );
    await store.flush();

    const again = bridgeOver(store, logger);
    const back = restored(await again.openCharacter?.(OWNER, ACTOR));
    expect(back?.equipped).toEqual(WORN_KIT);
    expect(back?.carried).toEqual(IN_THE_BAG);

    await store.close();
  });

  /**
   * BRANCH TWO, AND IT IS THE ONE A `?? {}` DEFAULT WOULD BREAK: a snapshot that
   * says EMPTY must WRITE empty. A player who dropped everything on the floor and
   * logged off has an empty bag, and a bridge that treated `[]` as "no opinion"
   * would hand them their old coat back every session — an item duplicator built
   * out of a falsy check.
   */
  it('writes an EMPTY loadout when the snapshot says empty, rather than falling back', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    await store.saveCharacter(
      sampleCharacter({ id: 'chr_main', equipped: WORN_KIT, carried: IN_THE_BAG }),
      SaveReason.Manual,
    );

    const bridge = bridgeOver(store, logger);
    await bridge.openCharacter?.(OWNER, ACTOR);

    bridge.savePlayersNow?.(
      [
        withLoadout({
          actorId: ACTOR,
          name: 'Ren',
          hp: 30,
          cooldowns: {},
          x: 1,
          y: 1,
          equipped: {},
          carried: [],
        }),
      ],
      'disconnect',
    );
    await store.flush();

    const again = bridgeOver(store, logger);
    const back = restored(await again.openCharacter?.(OWNER, ACTOR));
    // EMPTY, and — the assertion that separates this from the branch above —
    // NOT undefined. The file states it, so the next producer inherits a fact
    // rather than an absence.
    expect(back?.equipped).toEqual({});
    expect(back?.carried).toEqual([]);
    expect(back?.carried).not.toBeUndefined();

    await store.close();
  });

  /**
   * AND THE THIRD STATE, WHICH IS NEITHER: a character nobody has ever given an
   * item writes NO KEYS AT ALL. This is what keeps every save already sitting in
   * `data/characters/` byte-identical through a session that never touched loot.
   */
  it('leaves both keys off the file for a character that has never held anything', async () => {
    const logger = recordingLogger();
    const store = createSaveStore({
      root,
      logger,
      debounceMs: 5,
      now: () => '2026-08-15T12:00:00.000Z',
    });

    const bridge = bridgeOver(store, logger);
    await bridge.openCharacter?.(OWNER, ACTOR);
    bridge.savePlayersNow?.(
      [{ actorId: ACTOR, name: 'Ren', hp: 30, cooldowns: {}, x: 1, y: 1 }],
      'disconnect',
    );
    await store.flush();

    const onDisk = await readFile(characterPath(root, OWNER, 'chr_main') ?? '', 'utf8');
    expect(onDisk).not.toContain('carried');
    expect(onDisk).not.toContain('equipped');

    const again = bridgeOver(store, logger);
    const back = restored(await again.openCharacter?.(OWNER, ACTOR));
    expect(back?.carried).toBeUndefined();
    expect(back?.equipped).toBeUndefined();

    await store.close();
  });
});
