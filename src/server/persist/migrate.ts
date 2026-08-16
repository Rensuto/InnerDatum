// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE MIGRATION CHAIN — and, more importantly, THE REFUSAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * docs/data-schemas.md § 1 states the rule this file exists to enforce:
 *
 *   > Refuse to down-convert. A save written by a NEWER build must never be
 *   > coerced — that is how you destroy a friend's level-30 character.
 *
 * That is the whole reason a version integer is worth having. A chain that
 * only walks FORWARD is a convenience; the refusal is the safety property.
 * Consider the shape of the accident it prevents: someone runs a newer build
 * on the host for one session, then rolls back after a bad patch. The old
 * build opens a v2 file, does not recognise a field it therefore drops, and
 * writes a v1 file back over it. Nothing errored. Nothing logged. The
 * character is now missing everything v2 added, and the `.bak` — the one
 * copy that still held it — was overwritten by the same save.
 *
 * So `migrateDoc` refuses a future version, and `saves.ts` turns that refusal
 * into a QUARANTINE: the path is marked, and every later write to it is
 * rejected. Refusing to READ a newer save without also refusing to WRITE over
 * it is a half-measure that loses the data on the next autosave tick.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MIGRATIONS ARE PURE AND TOTAL
 * ───────────────────────────────────────────────────────────────────────────
 * No I/O, no RNG, no clock — docs/data-schemas.md § 1. A migration is replayed
 * every time an old file is opened, on any machine, in any order relative to
 * other saves; if it reads the wall clock, two loads of the same bytes produce
 * two different characters. Nothing here can enforce that, so it is stated
 * once, loudly, where a migration author will read it.
 *
 * `up` takes a plain record and returns a plain record. NOT the typed
 * `CharacterFile`: a migration's INPUT is by definition an older shape that no
 * longer has a type in this codebase, and typing it as the current one is how
 * you end up writing a migration against the shape you wish the file had.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE CHAIN IS EMPTY TODAY, AND WHY THAT IS NOT A STUB
 * ───────────────────────────────────────────────────────────────────────────
 * SCHEMA_VERSION is 1 and v1 is the first shape ever written, so there is
 * nothing to migrate FROM. What ships here is the machinery plus the refusal,
 * because the refusal has to be in the build BEFORE the first newer build
 * exists — retrofitting it is exactly the scenario it defends against.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MILESTONE THIS HEADER USED TO POINT AT HAS BEEN REACHED, AND THE
 * MIGRATION WAS CONSIDERED AND DELIBERATELY DECLINED.
 * ═══════════════════════════════════════════════════════════════════════════
 * This paragraph used to end "docs/data-schemas.md § 7 puts 'the first real
 * migration' at M6". M6 is here: progression landed, and `CharacterFile` grew
 * `level`, `xp`, `unspentPoints` and `talentPoints`. The chain is STILL empty,
 * and that is a decision rather than an oversight — without this note the next
 * reader would reasonably assume the bump was forgotten in the rush.
 *
 * THE RULE SAYS NO BUMP IS NEEDED. docs/data-schemas.md:48-49: "Adding an
 * *optional* field needs no bump; the bump is for renames, semantic changes,
 * and new required fields." All four are optional, and `migrateDoc` below
 * compares nothing but the integer, so a v1 file with none of them loads
 * untouched and `parseCharacterFile` supplies the documented birth defaults.
 *
 * AND THE COST OF BUMPING ANYWAY IS NOT SYMMETRIC WITH THE COST OF NOT. Bumping
 * makes every OLDER build refuse these files (THE REFUSAL, :259-271) and
 * saves.ts turn that refusal into a permanent QUARANTINE of the path
 * (saves.ts:963-980, :818-829) — the character is unplayable until a human
 * moves the file by hand. Not bumping means an older build drops the four
 * fields and writes them away, which costs one character's levels. For a game
 * whose game-design.md § 9 is "no permadeath, no loss", a lost level beats a
 * friend who cannot play at all. saves.ts's header states the same trade from
 * the other side; neither file is the sole record of it.
 *
 * NOTE WHAT THE WORKED EXAMPLE BELOW SAYS. It has always read `from: 1, to: 2,
 * note: 'talents split into raw points + refundPool'` — which is EXACTLY this
 * change, written down before it happened. It was never needed: we store RAW
 * per-talent points from the first file that has any, so there is no collapsed
 * "effective level" for a later migration to split, and there is no persisted
 * `refundPool` because a spend is irrevocable and the refund of a VANISHED
 * talent id is computed at load from the raw spread. The example stays as an
 * example — the day a rename or a new REQUIRED field lands, it is one entry in
 * `CHARACTER_MIGRATIONS` and a fixture, and nothing else here moves.
 */

import { SCHEMA_VERSION } from '../../shared/version.ts';

/**
 * The kinds of file that carry their own version integer.
 *
 * docs/data-schemas.md § 1 lists eleven and insists on **one integer per file
 * kind**, not a global — a monster-definition bump must not force every
 * character file through a no-op migration. One member today because one kind
 * is persisted today; the table below is the seam, so the second kind is an
 * entry rather than a refactor.
 */
export const SchemaKind = {
  Character: 'character',
} as const;
export type SchemaKind = (typeof SchemaKind)[keyof typeof SchemaKind];

/**
 * The version each kind is at NOW.
 *
 * Sourced from `SCHEMA_VERSION` rather than a literal `1` so there is exactly
 * one place the number lives while the kinds are all in lockstep. When they
 * diverge — and they will, because that is the point of per-kind integers —
 * this table is where they diverge, and `test/server/persist.test.ts` pins the
 * current values so a bump cannot be silent.
 */
export const CURRENT_VERSIONS: Readonly<Record<SchemaKind, number>> = {
  [SchemaKind.Character]: SCHEMA_VERSION,
};

/**
 * One step. `from` → `to`, and `to` must be exactly `from + 1`: a step that
 * skips a version cannot be composed with one that does not, and the first
 * time two branches both add a migration you would get a chain with a hole in
 * it that only fails for whoever happens to hold that intermediate version.
 */
export type Migration = {
  readonly kind: SchemaKind;
  readonly from: number;
  readonly to: number;
  /** Why this bump exists. Printed in the load log, so write it for a human. */
  readonly note: string;
  /** PURE AND TOTAL. See the header. */
  readonly up: (doc: Readonly<Record<string, unknown>>) => Record<string, unknown>;
};

/** `kind:from` → step. Built once; lookups are the hot path of nothing at all. */
export type MigrationRegistry = ReadonlyMap<string, Migration>;

function stepKey(kind: SchemaKind, from: number): string {
  return `${kind}:${from}`;
}

/**
 * Index the steps, rejecting a malformed chain AT CONSTRUCTION.
 *
 * Both checks turn a class of bug that would otherwise appear as a hang or a
 * silently-skipped migration into a startup crash:
 *
 *   - `to !== from + 1` would let the walk below step over a version nobody
 *     ever wrote a migration for.
 *   - `to <= from` would make the walk loop forever on a file that happens to
 *     be at `from`, which presents as the server hanging on boot with no error.
 */
export function createMigrationRegistry(steps: readonly Migration[]): MigrationRegistry {
  const registry = new Map<string, Migration>();
  for (const step of steps) {
    if (step.to !== step.from + 1) {
      throw new Error(
        `migrate: ${step.kind} v${step.from} → v${step.to} must advance by exactly one version`,
      );
    }
    const key = stepKey(step.kind, step.from);
    if (registry.has(key)) {
      throw new Error(`migrate: two migrations claim ${step.kind} v${step.from}`);
    }
    registry.set(key, step);
  }
  return registry;
}

/**
 * THE CHARACTER CHAIN. Empty by design — see the header, which records that the
 * progression fields were weighed against this array and deliberately added as
 * OPTIONAL fields instead.
 *
 * When the first entry lands, it looks like this and nothing else changes. The
 * example is kept verbatim although the change it describes is the one we just
 * declined to make — see the header for why raw points from day one mean there
 * is nothing to split and no `refundPool` to create:
 *
 * ```ts
 * {
 *   kind: SchemaKind.Character, from: 1, to: 2,
 *   note: 'talents split into raw points + refundPool',
 *   up: (doc) => ({ ...doc, talents: {}, refundPool: [] }),
 * }
 * ```
 */
export const CHARACTER_MIGRATIONS: readonly Migration[] = [];

/** Every step this build knows. */
export const MIGRATIONS: readonly Migration[] = [...CHARACTER_MIGRATIONS];

export const DEFAULT_MIGRATIONS: MigrationRegistry = createMigrationRegistry(MIGRATIONS);

/** Every way `migrateDoc` can end. Named, because `saves.ts` logs each differently. */
export const MigrateOutcome = {
  /** Already at the current version. No step ran, the document is untouched. */
  Current: 'current',
  /** One or more steps ran. The caller should write the result back. */
  Migrated: 'migrated',
  /** ═══ THE REFUSAL ═══ Written by a NEWER build. Never coerce it. */
  TooNew: 'too_new',
  /** Older than anything this build can migrate from — a gap in the chain. */
  NoPath: 'no_path',
  /** Not an object, or no usable `schemaVersion`. Not a save file we wrote. */
  Malformed: 'malformed',
} as const;
export type MigrateOutcome = (typeof MigrateOutcome)[keyof typeof MigrateOutcome];

export type MigrateResult =
  | {
      readonly ok: true;
      readonly outcome: typeof MigrateOutcome.Current | typeof MigrateOutcome.Migrated;
      readonly doc: Record<string, unknown>;
      readonly from: number;
      readonly to: number;
      /** True when at least one step ran — i.e. when the file must be rewritten. */
      readonly changed: boolean;
      /** The `note` of each step applied, in order. Straight into the log line. */
      readonly applied: readonly string[];
    }
  | {
      readonly ok: false;
      readonly outcome:
        | typeof MigrateOutcome.TooNew
        | typeof MigrateOutcome.NoPath
        | typeof MigrateOutcome.Malformed;
      readonly reason: string;
      /** The version found on disk, or null when there was not a usable one. */
      readonly found: number | null;
      readonly expected: number;
    };

/**
 * A hard ceiling on the walk. Belt to `createMigrationRegistry`'s braces: a
 * registry assembled at runtime from a config could still be cyclic, and a
 * boot that hangs is much harder to diagnose than a boot that says why.
 */
const MAX_STEPS = 64;

/**
 * The version integer off an unknown document, or null.
 *
 * ═══ A MISSING `schemaVersion` IS MALFORMED, NOT VERSION 0 ═══
 * DELIBERATE DEVIATION from the sketch in docs/data-schemas.md § 1, which
 * writes `let v = doc.schemaVersion ?? 0`. `SCHEMA_VERSION` shipped in the
 * first commit (src/shared/version.ts calls it "the one thing that cannot be
 * retrofitted"), so no build of this game has EVER written a file without one.
 * A document lacking the field is therefore not an ancient save — it is a
 * truncated file, a half-written file, or a file from something else entirely,
 * and treating it as v0 means running the whole chain over arbitrary JSON and
 * writing the result back as a character. Refusing sends it down the `.bak`
 * recovery path in `saves.ts` instead, which is where it belongs.
 */
export function readSchemaVersion(doc: unknown): number | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  if (!('schemaVersion' in doc)) return null;
  const raw = doc.schemaVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

/**
 * Walk `doc` from its own version up to `CURRENT_VERSIONS[kind]`.
 *
 * Returns rather than throws, for every outcome including the refusal. A save
 * layer that throws on a bad file takes the server down at boot for one
 * corrupt character, and the person who loses their evening is not the one who
 * corrupted the file. The caller gets a closed union it has to handle.
 */
export function migrateDoc(
  kind: SchemaKind,
  doc: unknown,
  registry: MigrationRegistry = DEFAULT_MIGRATIONS,
  /**
   * The version to walk TO. Defaults to this build's.
   *
   * Exposed because the chain is empty at v1 and would otherwise be untestable
   * until M6 — the drill docs/data-schemas.md § 1 asks for ("write the first
   * migration deliberately as a drill while the stakes are zero") needs a
   * target above 1 to have anything to walk. It does NOT weaken the refusal:
   * that branch compares `found` against whatever the target is, so a lower
   * target refuses MORE, never less.
   */
  expectedVersion: number = CURRENT_VERSIONS[kind],
): MigrateResult {
  const expected = expectedVersion;
  const found = readSchemaVersion(doc);

  if (found === null || typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      outcome: MigrateOutcome.Malformed,
      reason: 'no usable integer schemaVersion at the document root',
      found: null,
      expected,
    };
  }

  // ═══ THE REFUSAL. Read the header before touching this branch. ═══
  if (found > expected) {
    return {
      ok: false,
      outcome: MigrateOutcome.TooNew,
      reason:
        `${kind} file is schemaVersion ${found} but this build understands ${expected}. ` +
        'It was written by a newer build; loading it would silently drop whatever that ' +
        'build added, and the next save would make the loss permanent.',
      found,
      expected,
    };
  }

  let current: Record<string, unknown> = { ...doc };
  let version = found;
  const applied: string[] = [];

  while (version < expected) {
    if (applied.length >= MAX_STEPS) {
      return {
        ok: false,
        outcome: MigrateOutcome.NoPath,
        reason: `migration chain for ${kind} exceeded ${MAX_STEPS} steps — it is cyclic`,
        found,
        expected,
      };
    }
    const step = registry.get(stepKey(kind, version));
    if (step === undefined) {
      return {
        ok: false,
        outcome: MigrateOutcome.NoPath,
        reason: `no migration ${kind} v${version} → v${version + 1}`,
        found,
        expected,
      };
    }
    current = { ...step.up(current), schemaVersion: step.to };
    version = step.to;
    applied.push(`v${step.from}→v${step.to}: ${step.note}`);
  }

  return {
    ok: true,
    outcome: applied.length === 0 ? MigrateOutcome.Current : MigrateOutcome.Migrated,
    doc: current,
    from: found,
    to: version,
    changed: applied.length > 0,
    applied,
  };
}
