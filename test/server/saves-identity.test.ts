import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { actorIdForUser } from '../../src/server/net/gateway.ts';
import {
  LoadOutcome,
  SOLO_CHARACTER_ID,
  SaveOutcome,
  SaveReason,
  characterPath,
  createCharacterBridge,
  createCharacterFile,
  createSaveStore,
  sanitiseId,
} from '../../src/server/persist/saves.ts';
import type { CharacterSnapshot, PersistPort } from '../../src/server/net/gateway.ts';
import type { SaveLogger, SaveStore } from '../../src/server/persist/saves.ts';

// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
//   WHOSE CHARACTER IS THIS, AND WHERE IS IT ALLOWED TO BE WRITTEN?
// ═══════════════════════════════════════════════════════════════════════════
//
// Three claims, and all three are about identity rather than about JSON:
//
//   1. A CHARACTER COMES BACK. The same Discord account, on a later day and a
//      later process, gets its own body with the hp and cooldowns it left with.
//   2. AN ANONYMOUS PLAYER LEAVES NOTHING BEHIND. No binding, therefore no
//      file — not an empty one, not an orphan directory, nothing. There is
//      nothing to key a file on and minting an id for the purpose would litter
//      `data/characters/` with directories nobody can prove they own.
//   3. NOTHING ESCAPES `data/`. `<ownerId>` is a DIRECTORY NAME, and the value
//      that becomes it starts life on the network. Two layers stand in the way
//      (an allowlist in `sanitiseId`, a containment check in `characterPath`)
//      and this file attacks both with the inputs an attacker would actually
//      use, then proves the disk is untouched afterwards.
//
// These tests write REAL BYTES to a REAL TEMPORARY DIRECTORY. A mocked fs would
// prove that the code calls the functions the test expects it to call, which is
// not the question — the question is where the file ends up.
//
// EVERY HOSTILE ASSERTION HAS A POSITIVE CONTROL beside it. "No file was
// written" passes trivially when the save machinery is broken, so each traversal
// test is paired with a legitimate save that DOES land, in the one place it is
// supposed to.
// ---------------------------------------------------------------------------

/** Snowflake-SHAPED, and nobody's real id. */
const REN_ID = '222222222222222222';
const ALEX_ID = '444444444444444444';

/** ISO stamps are injected so the written bytes are the same on every run. */
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

type Recorded = { readonly level: string; readonly message: string; readonly context: string };

/** Records every line AND its context, so a test can grep both. */
function recordingLogger(): SaveLogger & { readonly lines: Recorded[] } {
  const lines: Recorded[] = [];
  const record =
    (level: string) =>
    (context: Record<string, unknown>, message: string): void => {
      lines.push({ level, message, context: JSON.stringify(context) });
    };
  return { lines, info: record('info'), warn: record('warn'), error: record('error') };
}

function snapshot(actorId: string, overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    actorId,
    name: 'Ren',
    hp: 31,
    cooldowns: { 'talent:strike': 2 },
    x: 7,
    y: 9,
    ...overrides,
  };
}

/** Everything under a directory, relative and sorted. `[]` when it does not exist. */
async function treeOf(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(root.length + 1)
          .split(sep)
          .join('/'),
      )
      .sort();
  } catch {
    return [];
  }
}

let parent: string;
let root: string;
let logger: ReturnType<typeof recordingLogger>;
let store: SaveStore;

beforeEach(async () => {
  // The data root sits INSIDE a scratch parent that also holds a canary, so a
  // traversal that escapes by one level has somewhere obvious to land and is
  // detected rather than merely assumed impossible.
  parent = await mkdtemp(join(tmpdir(), 'inner-datum-identity-'));
  root = join(parent, 'data');
  await mkdir(join(parent, 'outside'), { recursive: true });
  await writeFile(join(parent, 'outside', 'canary.txt'), 'untouched', 'utf8');

  logger = recordingLogger();
  store = createSaveStore({ root, logger, debounceMs: 5, now: (): string => FIXED_NOW });
});

afterEach(async () => {
  await store.close();
  await rm(parent, { recursive: true, force: true });
});

function bridgeOn(target: SaveStore = store): PersistPort {
  return createCharacterBridge({ store: target, logger, now: (): string => FIXED_NOW });
}

// ===========================================================================
// 1. A CHARACTER COMES BACK
// ===========================================================================

describe('a verified player rejoins', () => {
  it('loads the character that was saved, and it matches', async () => {
    const actorId = actorIdForUser(REN_ID);

    // --- the first session ---------------------------------------------------
    const first = bridgeOn();
    expect(await first.openCharacter?.(REN_ID, actorId)).toBeNull(); // first sight

    first.savePlayersNow?.(
      [snapshot(actorId, { hp: 23, cooldowns: { 'talent:strike': 4 } })],
      'disconnect',
    );
    await store.flush();

    // The file is where the three-tier key scheme says it is
    // (docs/discord-activity.md § 6): permanent, per-player, keyed on the
    // server-verified snowflake — never on the instance id.
    expect(await treeOf(root)).toContain(`characters/${REN_ID}/${SOLO_CHARACTER_ID}.json`);
    const onDisk: unknown = JSON.parse(
      await readFile(join(root, 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`), 'utf8'),
    );
    expect(onDisk).toMatchObject({
      id: SOLO_CHARACTER_ID,
      ownerId: REN_ID,
      name: 'Ren',
      resources: { hp: 23 },
      talentCooldowns: { 'talent:strike': 4 },
    });

    // --- a restart: a new store and a new bridge, same directory -------------
    const later = createSaveStore({ root, logger, now: (): string => FIXED_NOW });
    const second = bridgeOn(later);
    const restored = await second.openCharacter?.(REN_ID, actorId);

    expect(restored).not.toBeNull();
    expect(restored?.hp).toBe(23);
    expect(restored?.cooldowns).toEqual({ 'talent:strike': 4 });
    await later.close();
  });

  it('writes the class assigned at the first join, and hands it back next session', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // WITHOUT THIS THE CLASS IS RE-ROLLED EVERY EVENING.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // There is no chooser yet, so the gateway assigns a class off a rotation
    // counter that is PER-PROCESS and never decremented — while `actorIdForUser`
    // is a stable hash, so the same person coming back is the same actor id. The
    // file is therefore the only thing in the system that remembers that this
    // account plays the Watchman.
    //
    // `fileFor` used to write `binding.classId`, which is whatever the file said
    // when it was OPENED — `unassigned` on a first-ever join. So a brand-new
    // character was filed as `unassigned` and rewrote that value forever: the
    // class went round the rotation again on every reconnect, and a player's
    // hotbar changed under them between sessions.
    const actorId = actorIdForUser(REN_ID);

    const first = bridgeOn();
    expect(await first.openCharacter?.(REN_ID, actorId)).toBeNull(); // first sight
    first.savePlayersNow?.([snapshot(actorId, { classId: 'watchman' })], 'join');
    await store.flush();

    const onDisk: unknown = JSON.parse(
      await readFile(join(root, 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`), 'utf8'),
    );
    expect(onDisk).toMatchObject({ classId: 'watchman' });

    // --- a restart: a new store and a new bridge, same directory -------------
    const later = createSaveStore({ root, logger, now: (): string => FIXED_NOW });
    const second = bridgeOn(later);
    const restored = await second.openCharacter?.(REN_ID, actorId);
    expect(restored?.classId).toBe('watchman');

    // …and a save from a body that has NO class does not downgrade the file.
    // The binding carries the loaded value forward, which is what makes the
    // snapshot's absence mean "unchanged" rather than "unassign me".
    second.savePlayersNow?.([snapshot(actorId, { hp: 9 })], 'disconnect');
    await later.flush();
    const again: unknown = JSON.parse(
      await readFile(join(root, 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`), 'utf8'),
    );
    expect(again).toMatchObject({ classId: 'watchman', resources: { hp: 9 } });
    await later.close();
  });

  it('files a body that never had a class as `unassigned`, not as a guess', async () => {
    // ═══ `CharacterSnapshot.classId` IS OPTIONAL, AND ON PURPOSE ═══
    // `PlayerActor.classId` is itself optional — a classless body is a real
    // thing (a fixture, tools/e2e-m1.mjs, a build with no content wired in) — so
    // a REQUIRED field here would force every producer to invent a class for a
    // body that has none, and this file's own `snapshot` helper (which omits it,
    // as every other test in this file does) would not compile.
    //
    // The honest answer is a soft reference that admits it does not know: a file
    // claiming to be a Watchman when nobody ever chose Watchman is worse.
    const actorId = actorIdForUser(ALEX_ID);
    const bridge = bridgeOn();
    await bridge.openCharacter?.(ALEX_ID, actorId);

    bridge.savePlayersNow?.([snapshot(actorId, { name: 'Alex' })], 'disconnect');
    await store.flush();

    const onDisk: unknown = JSON.parse(
      await readFile(join(root, 'characters', ALEX_ID, `${SOLO_CHARACTER_ID}.json`), 'utf8'),
    );
    expect(onDisk).toMatchObject({ classId: 'unassigned' });
    // …and it comes back as that string rather than as null, so the caller
    // takes the same substitute-and-log path a renamed class would.
    const restored = await bridge.openCharacter?.(ALEX_ID, actorId);
    expect(restored?.classId).toBe('unassigned');
  });

  it('gives a different account a different file, and neither can see the other', async () => {
    const renActor = actorIdForUser(REN_ID);
    const alexActor = actorIdForUser(ALEX_ID);
    const bridge = bridgeOn();

    await bridge.openCharacter?.(REN_ID, renActor);
    await bridge.openCharacter?.(ALEX_ID, alexActor);
    bridge.savePlayersNow?.(
      [snapshot(renActor, { name: 'Ren', hp: 12 }), snapshot(alexActor, { name: 'Alex', hp: 34 })],
      'disconnect',
    );
    await store.flush();

    expect(await treeOf(root)).toEqual([
      `characters/${REN_ID}/${SOLO_CHARACTER_ID}.json`,
      `characters/${ALEX_ID}/${SOLO_CHARACTER_ID}.json`,
    ]);

    // Ren's actor id cannot open Alex's file: the owner is what selects the
    // directory, and the owner came from `/users/@me`.
    const asAlex = await store.loadCharacter(ALEX_ID, SOLO_CHARACTER_ID);
    expect(asAlex.file?.name).toBe('Alex');
    expect(asAlex.file?.resources.hp).toBe(34);
    const asRen = await store.loadCharacter(REN_ID, SOLO_CHARACTER_ID);
    expect(asRen.file?.name).toBe('Ren');
    expect(asRen.file?.resources.hp).toBe(12);
  });

  it('keeps the first-played stamp across a rewrite', async () => {
    const actorId = actorIdForUser(REN_ID);
    const bridge = bridgeOn();
    await bridge.openCharacter?.(REN_ID, actorId);
    bridge.savePlayersNow?.([snapshot(actorId)], 'disconnect');
    await store.flush();

    const path = join(root, 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`);
    const created: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(created).toMatchObject({ createdAt: FIXED_NOW });

    // A later session must carry the same `createdAt` forward rather than
    // restamping it — it is the one field that says "first played".
    const later = createSaveStore({ root, logger, now: (): string => '2026-06-06T00:00:00.000Z' });
    const second = bridgeOn(later);
    await second.openCharacter?.(REN_ID, actorId);
    second.savePlayersNow?.([snapshot(actorId, { hp: 8 })], 'disconnect');
    await later.flush();

    const rewritten: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(rewritten).toMatchObject({ createdAt: FIXED_NOW, resources: { hp: 8 } });
    await later.close();
  });

  it('never writes the raw snowflake into a log line', async () => {
    const actorId = actorIdForUser(REN_ID);
    const bridge = bridgeOn();
    await bridge.openCharacter?.(REN_ID, actorId);
    bridge.savePlayersNow?.([snapshot(actorId)], 'disconnect');
    await store.flush();

    // POSITIVE: the save really was logged, so the negative below means
    // something.
    const everything = JSON.stringify(logger.lines);
    expect(logger.lines.some((line) => line.message === 'character saved')).toBe(true);
    // CLAUDE.md non-negotiable 7 — including the path, where a snowflake is a
    // directory name and would otherwise be smuggled in whole.
    expect(everything).not.toContain(REN_ID);
    expect(everything).toContain('…2222');
  });
});

// ===========================================================================
// 2. AN ANONYMOUS PLAYER LEAVES NOTHING BEHIND
// ===========================================================================

describe('an anonymous player', () => {
  it('writes no file at all — not an empty one, not a directory', async () => {
    const bridge = bridgeOn();
    // No `openCharacter`, because there is nobody to open a character for. This
    // is exactly the plain-browser and e2e path.
    const anonymous = 'actor_2f9f1a5e-0c39-4f2f-9a03-1f8f7d6e5c4b';

    bridge.savePlayers([snapshot(anonymous, { name: 'Player 1' })]);
    bridge.savePlayersNow?.([snapshot(anonymous, { name: 'Player 1' })], 'disconnect');
    bridge.savePlayersNow?.([snapshot(anonymous, { name: 'Player 1' })], 'death');
    await store.flush();

    expect(store.pendingCount()).toBe(0);
    expect(await treeOf(root)).toEqual([]);
    // Not even the directory tree: a server nobody verified on leaves no trace.
    expect(await readdir(parent)).toEqual(['outside']);
  });

  it('is skipped silently while a verified player in the same batch is written', async () => {
    const renActor = actorIdForUser(REN_ID);
    const anonymous = 'actor_2f9f1a5e-0c39-4f2f-9a03-1f8f7d6e5c4b';
    const bridge = bridgeOn();
    await bridge.openCharacter?.(REN_ID, renActor);

    bridge.savePlayersNow?.(
      [snapshot(anonymous, { name: 'Player 1' }), snapshot(renActor)],
      'disconnect',
    );
    await store.flush();

    // ONE file, and it is the one with an owner. The positive control that
    // makes the test above meaningful.
    expect(await treeOf(root)).toEqual([`characters/${REN_ID}/${SOLO_CHARACTER_ID}.json`]);
  });

  it('stops being saved the moment the body is recalled', async () => {
    const renActor = actorIdForUser(REN_ID);
    const bridge = bridgeOn();
    await bridge.openCharacter?.(REN_ID, renActor);
    bridge.savePlayersNow?.([snapshot(renActor, { hp: 20 })], 'disconnect');
    await store.flush();

    // The grace expired: the gateway drops the binding. Anything that arrives
    // afterwards is an unowned body again, and unowned bodies are not written.
    bridge.closeCharacter?.(renActor);
    bridge.savePlayersNow?.([snapshot(renActor, { hp: 1 })], 'recall');
    bridge.savePlayers([snapshot(renActor, { hp: 1 })]);
    await store.flush();

    const path = join(root, 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`);
    const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toMatchObject({ resources: { hp: 20 } });
  });
});

// ===========================================================================
// 3. NOTHING ESCAPES THE DATA DIRECTORY
// ===========================================================================

/**
 * Genuinely hostile ids. Each one is a real technique, not a variation on a
 * theme:
 *
 *   traversal, in both slash conventions and in a form that only escapes once
 *   the path is joined; a Windows DRIVE-RELATIVE path, which `join` does not
 *   neutralise; an NTFS ALTERNATE DATA STREAM; a NUL, which truncates a path
 *   inside some syscalls; a device name, which Windows opens as a DEVICE from
 *   any directory; a trailing newline, because `$` in some regex dialects
 *   matches before one; a UNC path; and lengths that a filesystem answers with
 *   ENAMETOOLONG rather than a refusal.
 */
const HOSTILE_IDS: readonly string[] = [
  '../../../etc/passwd',
  '..\\..\\..\\Windows\\System32',
  '..',
  '.',
  './..',
  'a/../../b',
  'characters/../../outside/canary.txt',
  'C:',
  'C:\\Windows\\System32\\config',
  'C:/Windows',
  '\\\\server\\share',
  '/etc/passwd',
  'ren:$DATA',
  'ren\u0000extra',
  '222222222222222222\u0000/../outside',
  '222222222222222222\n',
  'CON',
  'nul',
  'Com1',
  'LPT9',
  '%2e%2e%2f%2e%2e%2foutside',
  '..%5c..%5coutside',
  '\uFF0E\uFF0E\uFF0Foutside',
  '',
  ' ',
  '.hidden',
  'chr_main.json',
  'a'.repeat(65),
  'a'.repeat(5000),
];

describe('a hostile id never becomes a path', () => {
  it('is refused by the allowlist, every one of them', () => {
    for (const hostile of HOSTILE_IDS) {
      expect(sanitiseId(hostile), `sanitiseId(${JSON.stringify(hostile)})`).toBeNull();
    }
    // POSITIVE CONTROL: the shapes that must keep working still do — a
    // snowflake, the character id, and both actor-id shapes the gateway mints.
    expect(sanitiseId(REN_ID)).toBe(REN_ID);
    expect(sanitiseId(SOLO_CHARACTER_ID)).toBe(SOLO_CHARACTER_ID);
    expect(sanitiseId(actorIdForUser(REN_ID))).toBe(actorIdForUser(REN_ID));
    // An anonymous `actor_<uuid>` is path-SAFE too, which is deliberate: both
    // actor-id shapes satisfy this one rule. Being spellable in a path is not
    // the same as being persisted — an anonymous body still has no owner, and
    // the tests above are what prove nothing is written for it.
    expect(sanitiseId('actor_2f9f1a5e-0c39-4f2f-9a03-1f8f7d6e5c4b')).not.toBeNull();
  });

  it('cannot become a path as an owner or as a character id', () => {
    for (const hostile of HOSTILE_IDS) {
      expect(characterPath(root, hostile, SOLO_CHARACTER_ID)).toBeNull();
      expect(characterPath(root, REN_ID, hostile)).toBeNull();
      expect(characterPath(root, hostile, hostile)).toBeNull();
    }

    // POSITIVE CONTROL: a legitimate pair resolves, and lands under the root.
    const good = characterPath(root, REN_ID, SOLO_CHARACTER_ID);
    expect(good).toBe(join(resolve(root), 'characters', REN_ID, `${SOLO_CHARACTER_ID}.json`));
    expect(good?.startsWith(resolve(root) + sep)).toBe(true);
  });

  it('is refused by the store, loudly, and touches no disk', async () => {
    for (const hostile of HOSTILE_IDS) {
      const load = await store.loadCharacter(hostile, SOLO_CHARACTER_ID);
      expect(load.outcome).toBe(LoadOutcome.Rejected);
      expect(load.file).toBeNull();

      const save = await store.saveCharacter(
        createCharacterFile({
          id: SOLO_CHARACTER_ID,
          ownerId: hostile,
          name: 'Ren',
          classId: 'unassigned',
          resources: { hp: 1, ap: 0, mp: 0, special: { kind: '', value: 0 } },
          createdAt: FIXED_NOW,
        }),
        SaveReason.Manual,
      );
      expect(save.outcome).toBe(SaveOutcome.Rejected);
      expect(save.path).toBeNull();

      store.scheduleCharacter(
        createCharacterFile({
          id: hostile,
          ownerId: REN_ID,
          name: 'Ren',
          classId: 'unassigned',
          resources: { hp: 1, ap: 0, mp: 0, special: { kind: '', value: 0 } },
          createdAt: FIXED_NOW,
        }),
      );
      expect(store.pendingCount()).toBe(0);
    }
    await store.flush();

    // NOTHING WAS WRITTEN, ANYWHERE. Not under the data root, not beside it,
    // and the canary one level up is exactly as it was.
    expect(await treeOf(root)).toEqual([]);
    expect(await treeOf(join(parent, 'outside'))).toEqual(['canary.txt']);
    expect(await readFile(join(parent, 'outside', 'canary.txt'), 'utf8')).toBe('untouched');
    expect((await readdir(parent)).sort()).toEqual(['outside']);

    // …and every refusal was logged as an error, because a rejected id is
    // either a bug or an attack and both deserve a line.
    expect(logger.lines.filter((line) => line.level === 'error').length).toBeGreaterThan(0);
  });

  it('never binds, so a rejected owner is simply never persisted', async () => {
    const bridge = bridgeOn();
    const actorId = actorIdForUser(REN_ID);

    for (const hostile of HOSTILE_IDS) {
      expect(await bridge.openCharacter?.(hostile, actorId)).toBeNull();
    }
    // No binding means every later save silently skips this body — the actor is
    // playable, and nothing about it reaches the disk.
    bridge.savePlayersNow?.([snapshot(actorId)], 'disconnect');
    bridge.savePlayers([snapshot(actorId)]);
    await store.flush();

    expect(await treeOf(root)).toEqual([]);

    // POSITIVE CONTROL: the same actor, opened under a legitimate owner, is
    // written immediately — so the emptiness above is the refusal and not a
    // broken bridge.
    await bridge.openCharacter?.(REN_ID, actorId);
    bridge.savePlayersNow?.([snapshot(actorId)], 'disconnect');
    await store.flush();
    expect(await treeOf(root)).toEqual([`characters/${REN_ID}/${SOLO_CHARACTER_ID}.json`]);
  });

  it('cannot reach a real file that already exists outside its own directory', async () => {
    // A file that legitimately exists, written by somebody else's account.
    const alexBridge = bridgeOn();
    await alexBridge.openCharacter?.(ALEX_ID, actorIdForUser(ALEX_ID));
    alexBridge.savePlayersNow?.(
      [snapshot(actorIdForUser(ALEX_ID), { name: 'Alex', hp: 40 })],
      'disconnect',
    );
    await store.flush();

    // Every spelling of "…/<Alex's directory>/chr_main" refuses before it ever
    // becomes a path, so the file cannot be read OR overwritten by anyone else.
    for (const attempt of [
      `../${ALEX_ID}`,
      `${REN_ID}/../${ALEX_ID}`,
      `..\\${ALEX_ID}`,
      `./${ALEX_ID}`,
    ]) {
      expect(characterPath(root, attempt, SOLO_CHARACTER_ID)).toBeNull();
      expect((await store.loadCharacter(attempt, SOLO_CHARACTER_ID)).outcome).toBe(
        LoadOutcome.Rejected,
      );
    }

    // Alex's file is untouched, and still Alex's.
    const alex = await store.loadCharacter(ALEX_ID, SOLO_CHARACTER_ID);
    expect(alex.outcome).toBe(LoadOutcome.Loaded);
    expect(alex.file?.resources.hp).toBe(40);
    expect(await treeOf(root)).toEqual([`characters/${ALEX_ID}/${SOLO_CHARACTER_ID}.json`]);
  });
});
