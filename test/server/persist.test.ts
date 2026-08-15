import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from '../../src/shared/version.ts';
import {
  CURRENT_VERSIONS,
  MigrateOutcome,
  SchemaKind,
  createMigrationRegistry,
  migrateDoc,
  readSchemaVersion,
} from '../../src/server/persist/migrate.ts';
import { backupPathFor, writeFileAtomic } from '../../src/server/persist/atomic.ts';
import {
  LoadOutcome,
  SaveOutcome,
  SaveReason,
  characterPath,
  createCharacterFile,
  createSaveStore,
  maskId,
  parseCharacterFile,
  sanitiseId,
  serialiseCharacter,
} from '../../src/server/persist/saves.ts';
import type * as NodeFsPromises from 'node:fs/promises';
import type { AtomicWarning } from '../../src/server/persist/atomic.ts';
import type { Migration } from '../../src/server/persist/migrate.ts';
import type { CharacterFile, SaveLogger, SaveStore } from '../../src/server/persist/saves.ts';

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
