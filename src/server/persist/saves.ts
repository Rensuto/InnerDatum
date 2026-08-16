// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   CHARACTER FILES. GET THIS WRONG AND SOMEONE LOSES A CHARACTER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four properties, in the order they matter:
 *
 *   1. A DISCORD USER ID NEVER REACHES A PATH UNSANITISED. The file layout is
 *      `data/characters/<discordUserId>/<charId>.json`, so a user id IS a
 *      directory name. The repo is public, which means the route from a wire
 *      field to a filesystem path is documented for anyone who wants it. See
 *      `sanitiseId` — an allowlist, plus a containment assertion, plus the
 *      Windows device names that are neither.
 *
 *   2. A CORRUPT FILE MUST NOT TAKE THE SERVER DOWN. Every failure path here
 *      RETURNS; nothing throws at boot. A truncated character file falls back
 *      to `.bak` and logs loudly, because the person whose evening ends when
 *      the server will not start is not the person who corrupted the file.
 *
 *   3. A NEWER SAVE IS NEVER WRITTEN OVER. `migrate.ts` refuses to load one;
 *      this file additionally QUARANTINES the path so the debounced autosave
 *      cannot quietly finish the job three seconds later.
 *
 *   4. TWO WRITES TO ONE PATH NEVER RACE. `writeFileAtomic` guarantees no
 *      reader sees a partial file; it does NOT order two concurrent writers,
 *      and the last rename wins. A debounced autosave overlapping a death save
 *      would therefore let the STALER snapshot win. `runExclusive` chains
 *      writes per path so it cannot.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS LAYER IS ASYNC. THE ENGINE IS NOT. THAT IS THE WHOLE ARRANGEMENT.
 * ───────────────────────────────────────────────────────────────────────────
 * `src/server/engine/**` carries six AST selectors that make `await`
 * impossible, and ESLint additionally forbids it from importing `persist/`.
 * Persistence is queued by the CALLER after `pump` returns — the turn engine
 * hands a finished snapshot to `scheduleCharacter`, and control returns
 * immediately. Nothing in a save's call graph can interleave with a turn.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STORE THE ROLL, DERIVE THE STATS (docs/data-schemas.md § 3)
 * ───────────────────────────────────────────────────────────────────────────
 * Only CURRENT values are persisted: `hp`, `ap`, `mp`, the special resource's
 * value, cooldown turns, effect durations, position. Every `max*` pool is
 * DERIVED from the class at load and is deliberately absent from this file.
 *
 * That is a KNOWING DEVIATION from the `CharacterFile` interface sketched at
 * docs/data-schemas.md:106-111, which lists `maxHp` / `maxAp` / `maxMp`
 * alongside the current values. The sketch contradicts the rule stated forty
 * lines below it in the same document ("**DERIVED** … never stored: every
 * `max*` pool"), and the rule is the half with a reason attached: a stored
 * maximum is a second source of truth that goes stale the moment a class is
 * rebalanced, and the symptom is a Watchman whose HP bar is 72 long in a build
 * where it should be 80. The M4 brief agrees with the rule — "name + class +
 * position … hp, resource, effects, cooldowns".
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROGRESSION IS PERSISTED NOW, AND THE VERSION DELIBERATELY DID NOT BUMP
 * ───────────────────────────────────────────────────────────────────────────
 * This paragraph used to open "NOT PERSISTED AT M4, deliberately: level / xp /
 * talent points (there is no levelling — PLAN.md M4)". There is levelling, so
 * that sentence is gone rather than left to mislead. What it ended on was a
 * PREDICTION — that each would land as an OPTIONAL field needing no version
 * bump — and the prediction was CHECKED rather than inherited:
 * docs/data-schemas.md:48-49 still reads, verbatim, "Adding an *optional* field
 * needs no bump; the bump is for renames, semantic changes, and new required
 * fields", and `migrateDoc` (migrate.ts:230-311) compares nothing but the
 * integer. So `level`, `xp`, `unspentPoints` and `talentPoints` are four
 * OPTIONAL fields, `SCHEMA_VERSION` stays 1, and `CHARACTER_MIGRATIONS` stays
 * empty.
 *
 * THAT IS A DECISION TAKEN, not an omission, and both failure modes were on the
 * table when it was taken:
 *
 *   NOT BUMPING — an older build opens a newer file, does not recognise the four
 *   fields, drops them, and writes a v1 file back over it on the next autosave,
 *   with the `.bak` overwritten by that same save. That is exactly the accident
 *   migrate.ts:14-27 describes. THE COST IS ONE CHARACTER'S LEVELS.
 *
 *   BUMPING — an older build REFUSES the file (migrate.ts:259-271) and this file
 *   turns the refusal into a PERMANENT QUARANTINE of the path (:963-980,
 *   :818-829), so nothing further is ever written to it and the character stays
 *   unplayable until a human moves the file aside by hand. THE COST IS A FRIEND
 *   WHO CANNOT PLAY AT ALL TONIGHT.
 *
 * We chose the first. game-design.md § 9 is "no permadeath, no loss", and a lost
 * level is strictly better than somebody sitting out the evening while the host
 * reads a file path out of a log. The migration machinery stays a drill for the
 * first genuinely breaking change — a rename, or a new REQUIRED field — which is
 * the shape it was built for.
 *
 * STILL NOT PERSISTED, deliberately: inventory and equipment (there is no loot),
 * and the two energy clocks (a save happens at a session boundary, and mid-turn
 * energy means nothing across a reload). Both are optional fields when they
 * land, on the same rule and with the same trade re-weighed at the time.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  MAX_CHARACTER_LEVEL,
  TALENT_MAX_LEVEL,
  totalPointsAtLevel,
} from '../../shared/progression.ts';
import { CURRENT_VERSIONS, MigrateOutcome, SchemaKind, migrateDoc } from './migrate.ts';
import { backupPathFor, errorCode, writeFileAtomic } from './atomic.ts';
import type { AtomicWarning, AtomicWriteOptions } from './atomic.ts';
// TYPE-ONLY, AND THE DIRECTION IS DELIBERATE. The gateway DECLARES the
// persistence contract (`PersistPort`) and this file MEETS it — the same
// arrangement `src/server/turn-engine.ts` has with `TurnEngine`. The import is
// erased by `verbatimModuleSyntax`, so there is no runtime edge from persist/
// to net/ and no cycle; only the compiler ever sees it. See "THE BRIDGE" at the
// bottom of this file.
import type { CharacterRestore, CharacterSnapshot, PersistPort } from '../net/gateway.ts';

// ---------------------------------------------------------------------------
// Path safety — the part an attacker reads first
// ---------------------------------------------------------------------------

/**
 * The one shape allowed to become a path component.
 *
 * An ALLOWLIST, not a denylist. A Discord snowflake is 17-20 decimal digits, so
 * digits alone would do; letters, `_` and `-` are permitted because character
 * ids are server-generated (`chr_a1b2`) and share this function. Everything
 * that makes traversal possible is excluded by construction rather than by
 * being blacklisted: `.` (so `..` cannot be spelled), `/` and `\`, `:` (so a
 * Windows drive-relative path cannot be spelled), NUL, and every Unicode
 * character that normalises or homoglyphs into one of those.
 *
 * 64 is a ceiling, not a fit — snowflakes are 20 — because a 4 KB "id" turned
 * into a filename is its own denial of service on some filesystems.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Windows opens these as DEVICES regardless of the directory they appear in,
 * with or without an extension. `CON.json` is the console, and writing a
 * character to it succeeds, returns no error, and stores nothing. They pass
 * `SAFE_ID` cleanly, which is exactly why they need naming.
 *
 * The host is Windows (PLAN.md), so this is the live case rather than a
 * portability courtesy.
 */
const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** The id if it is safe to put in a path, or null. Never throws, never repairs. */
export function sanitiseId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!SAFE_ID.test(raw)) return null;
  if (WINDOWS_RESERVED.has(raw.toUpperCase())) return null;
  return raw;
}

/**
 * SECOND LAYER. `sanitiseId` already makes traversal unspellable; this proves
 * the assembled path really did land under the data root.
 *
 * Two layers because they fail differently: the allowlist is a rule about
 * INPUT that a future edit could loosen ("let's allow dots, some ids have
 * them"), and this is a fact about the OUTPUT that stays true regardless.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '') return false;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** `data/characters/`. One directory per owner — see the one-file-per-character note. */
const CHARACTERS_DIR = 'characters';

/**
 * The absolute path of one character file, or null when either id is unsafe.
 *
 * Returns null rather than throwing: a bad id arrives from the network, and
 * the caller's answer is to refuse the request, not to unwind the connection
 * handler.
 */
export function characterPath(root: string, ownerId: string, characterId: string): string | null {
  const owner = sanitiseId(ownerId);
  const character = sanitiseId(characterId);
  if (owner === null || character === null) return null;
  const file = join(resolve(root), CHARACTERS_DIR, owner, `${character}.json`);
  return isInsideRoot(root, file) ? file : null;
}

/**
 * A snowflake, minus the part that identifies a person.
 *
 * CLAUDE.md non-negotiable 7: the repo is public and `data/` holds real
 * Discord ids, "never commit … a log excerpt with a raw snowflake in it". The
 * only way to be sure a log excerpt is safe to paste into an issue is for the
 * raw id never to enter the log, so it never does — not in the owner field,
 * and not smuggled in as a path.
 */
export function maskId(raw: string): string {
  return raw.length <= 4 ? '****' : `…${raw.slice(-4)}`;
}

/** Root-relative, with any snowflake-shaped path segment masked. */
function redactPath(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path));
  return rel
    .split(sep)
    .map((segment) => (/^[0-9]{8,}$/.test(segment) ? maskId(segment) : segment))
    .join('/');
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** A live status, as it survives a reload. Mirrors `EffectInstance` minimally. */
export type SavedEffect = {
  /** `effect:stunned`. A SOFT reference — see `parseCharacterFile`. */
  readonly effectId: string;
  /** `EffectInstance.dur`, in GAME TURNS. */
  readonly turnsRemaining: number;
  /** `EffectParams.power` — the bleed's damage, the slow's fraction. */
  readonly magnitude?: number;
};

export type SavedPosition = {
  readonly zoneId: string;
  readonly depth: number;
  readonly cell: readonly [number, number];
};

/** CURRENT values only. Every maximum is derived from the class at load. */
export type SavedResources = {
  readonly hp: number;
  readonly ap: number;
  readonly mp: number;
  /**
   * The class resource. `kind` is stored as a redundant cross-check so a human
   * reading the file can see what the number means; the CLASS is authoritative
   * on load, because a file whose kind disagrees with its class is a file that
   * was hand-edited.
   */
  readonly special: { readonly kind: string; readonly value: number };
};

export type CharacterFile = {
  readonly schemaVersion: number;
  readonly kind: typeof SchemaKind.Character;
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  /**
   * A SOFT reference (docs/data-schemas.md § 1). Typed `string`, not `ClassId`,
   * and validated only as non-empty: if a class id disappears from content, the
   * caller substitutes and logs. Friends' saves must outlive content edits, and
   * a persist layer that imports the class registry cannot let them.
   */
  readonly classId: string;

  // ═════════════════════════════════════════════════════════════════════════
  // PROGRESSION. FOUR OPTIONAL FIELDS — see the header for why the version did
  // not bump, and `parseCharacterFile` for what their ABSENCE is decided to
  // mean. Optional in the TYPE because a file written before this milestone
  // genuinely does not have them; always WRITTEN by `serialiseCharacter`,
  // because a save a human opens should say what level the character is.
  // ═════════════════════════════════════════════════════════════════════════

  /** Character level, 1..`MAX_CHARACTER_LEVEL`. Absent means 1. */
  readonly level?: number;
  /**
   * PER-LEVEL experience — progress into the current level, never a cumulative
   * total. `gainExp` subtracts the threshold on the way past
   * (src/shared/progression.ts, ActorLevel.lua:104).
   *
   * FRACTIONAL ON PURPOSE and never rounded on the way in or out: one kill pays
   * `killerLevel × rankWorth × 4`, which is 3.2 against a normal at level 1.
   * Flooring it here would silently shave a fifth of every early award.
   */
  readonly xp?: number;
  /**
   * Talent points earned and not yet spent.
   *
   * ═══ A CACHE OF A DERIVED NUMBER, AND THE LOADER TREATS IT AS ONE ═══
   * docs/data-schemas.md:94-104 is unambiguous — "NEVER persist a derived
   * value" — and unspent IS derived: `totalPointsAtLevel(level)` minus every
   * raw point spent. It is written anyway because it is the one progression
   * number a human reading the file cannot work out in their head, and because
   * DECISIONS.md (e) names it as one of the four. `parseCharacterFile`
   * therefore RECOMPUTES it from the ledger and records any disagreement as a
   * repair, so retuning `pointsForLevel` corrects every existing character
   * instead of stranding the ones whose file remembers the old grant.
   */
  readonly unspentPoints?: number;
  /**
   * Talent id → RAW points, 1..`TALENT_MAX_LEVEL`. THE ONLY PROGRESSION FIELD
   * THAT IS A SOURCE OF TRUTH.
   *
   * RAW, never the effective level: mastery (and anything else that ever
   * multiplies a rank) is applied at load, so a rebalance moves every existing
   * character with it. Same rule that keeps every `max*` pool out of this file.
   *
   * A SOFT REFERENCE MAP, keyed exactly like `talentCooldowns` and for the same
   * reason: a talent id that vanishes from content must not lock a friend out
   * of their character. This layer keeps the entry verbatim — it cannot import
   * the talent registry any more than it can import the class registry — and
   * the restore path is where docs/data-schemas.md:51-52's refund happens ("if
   * a talent id disappears, the load path moves its points to a `refundPool`
   * and logs it rather than throwing").
   *
   * An id ABSENT from the map is a loadout talent at its birth rank of 1; see
   * `createTalentSheet`, which seeds every loadout id it is not given.
   */
  readonly talentPoints?: Readonly<Record<string, number>>;

  readonly resources: SavedResources;
  /** Talent id → GAME TURNS remaining. Soft references, like `classId`. */
  readonly talentCooldowns: Readonly<Record<string, number>>;
  readonly effects: readonly SavedEffect[];
  readonly position: SavedPosition | null;
  /** ISO 8601. Set once, carried forever. */
  readonly createdAt: string;
  /** ISO 8601. Restamped by the store on every write. */
  readonly updatedAt: string;
};

/** Names are displayed in the Case Log and the party panel; keep them short. */
const NAME_MAX = 40;

/**
 * Strip C0 controls and truncate.
 *
 * A control character in a name is either a corrupt file or somebody probing
 * the log renderer, and both end with a Case Log that cannot be read. Repaired
 * rather than rejected on load: refusing the whole file would lock a player out
 * of their character over a stray byte.
 *
 * Written as a code-point loop rather than a regex because `no-control-regex`
 * (correctly) bans the literal that would express it.
 */
function scrubName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= NAME_MAX) break;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// WHAT ABSENCE MEANS. THIS IS A DECISION, NOT A FALLBACK.
//
// A character file with no `level`, no `xp`, no `unspentPoints` and no
// `talentPoints` is A LEVEL-1 CHARACTER WITH ITS FOUR BIRTH TALENTS AT RANK 1
// AND NOTHING SPENT. That is the right answer for the only two ways such a file
// can exist — a save written before progression shipped, and a save written by
// a build that never had any of the four to write — and it is the same state
// `createPlayerActor` and `createTalentSheet` produce for a brand-new character,
// so a pre-progression file and a first join land on identical bodies.
//
// The alternative — refuse, or guess a level from the xp — would either lock a
// friend out of a character over a field that did not exist last week, or invent
// progress nobody earned. Every constant below is therefore load-bearing enough
// to be named and asserted (test/server/persist.test.ts), rather than being an
// inline `?? 0` that reads like a typo guard.
// ---------------------------------------------------------------------------

/** Where a character starts. `MAX_CHARACTER_LEVEL` is the other end. */
const BIRTH_LEVEL = 1;

/** No progress into level 2 yet. Per-level xp, so this is a real zero. */
const BIRTH_XP = 0;

/**
 * A birth rank of 1, and 1 rather than 0 is load-bearing: `combatTalentScale`
 * maps a talent level of 0 to 0.1 (src/shared/scale.ts:191), so a talent stored
 * at 0 would not refuse to fire — it would fire, quietly, for a tenth of its
 * damage, for the rest of that character's life.
 */
const BIRTH_TALENT_POINTS = 1;

/**
 * How many points this spread REPRESENTS AS PURCHASES: `Σ (raw − 1)`.
 *
 * ═══ THE MINUS ONE IS THE BIRTH GRANT AND IT IS EASY TO DROP ═══
 * Every loadout talent starts at rank 1 for free — those four ranks are the
 * whole of our birth grant (`createTalentSheet`, and `pointsForLevel`'s docblock
 * for why upstream's separate 2-point grant was dropped in exchange). A raw 3 is
 * therefore TWO points spent, not three. Two docblocks state the ledger in the
 * shorthand `totalPointsAtLevel(level) - sum(points.values())`
 * (engine/talents.ts:908, engine/actor.ts:460); read literally that hands a
 * fresh level-1 character MINUS FOUR points, which is the arithmetic this
 * function exists to get right. protocol.ts:2700-2705 states it correctly —
 * "every point ever granted at this level minus every raw point SPENT".
 *
 * `Math.max(0, …)` per entry so a repaired-to-1 entry can never subtract.
 */
function spentTalentPoints(talentPoints: Readonly<Record<string, number>>): number {
  let spent = 0;
  for (const raw of Object.values(talentPoints)) spent += Math.max(0, raw - BIRTH_TALENT_POINTS);
  return spent;
}

/**
 * THE LEDGER: every point a character of `level` was ever granted, minus every
 * point the spread says was spent. Floored at zero.
 *
 * The floor is not paranoia — a class change, or a file carrying more talent ids
 * than the current loadout, makes the subtraction go negative, and a negative
 * "points in hand" would render as a `+` button that refuses to work with no
 * explanation. Zero is the honest answer: no points, nothing owed.
 *
 * A VANISHED TALENT ID STILL COUNTS AS SPENT HERE, and it must: this layer
 * cannot import the talent registry (the same rule that makes `classId` a soft
 * reference), so it cannot tell a deleted talent from one it has simply never
 * heard of. Giving the points back is the restore path's job —
 * docs/data-schemas.md:51-52's refund — and it has the registry to do it with.
 */
function unspentFromLedger(level: number, talentPoints: Readonly<Record<string, number>>): number {
  return Math.max(0, totalPointsAtLevel(level) - spentTalentPoints(talentPoints));
}

export type CharacterInit = {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly classId: string;
  /** Omit for a fresh character — see "WHAT ABSENCE MEANS" above. */
  readonly level?: number;
  readonly xp?: number;
  readonly unspentPoints?: number;
  /** RAW points per talent. Omit ids at their birth rank; absent means 1. */
  readonly talentPoints?: Readonly<Record<string, number>>;
  readonly resources: SavedResources;
  readonly talentCooldowns?: Readonly<Record<string, number>>;
  readonly effects?: readonly SavedEffect[];
  readonly position?: SavedPosition | null;
  /** ISO 8601. Defaults to now; pass it explicitly from a test. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

/**
 * Stamp a snapshot with the current schema version.
 *
 * Takes PLAIN DATA, never an `EngineActor`: the mapping from a live actor to
 * these fields belongs to whoever owns both (turn-engine.ts), and importing an
 * actor here would put the engine's type on the persist layer's critical path
 * for no benefit.
 */
export function createCharacterFile(init: CharacterInit): CharacterFile {
  const stamp = init.createdAt ?? new Date().toISOString();
  const level = init.level ?? BIRTH_LEVEL;
  const talentPoints = init.talentPoints ?? {};
  return {
    schemaVersion: CURRENT_VERSIONS[SchemaKind.Character],
    kind: SchemaKind.Character,
    id: init.id,
    ownerId: init.ownerId,
    name: init.name,
    classId: init.classId,
    // FILLED IN EXPLICITLY rather than left undefined, so every file this build
    // writes names all four and a human reading one never has to know what an
    // absent field would have meant. The defaults are the decision recorded
    // above; `parseCharacterFile` applies the identical ones on the way back.
    level,
    xp: init.xp ?? BIRTH_XP,
    // DERIVED WHEN IT IS NOT SUPPLIED, from the same ledger the parser uses on
    // the way back — so `serialiseCharacter(createCharacterFile(...))` reloads
    // with zero repairs. A literal 0 here would look right (a fresh character
    // does have none) and would write "0 points in hand" for a level-8
    // character whose caller passed a level and nothing else.
    unspentPoints: init.unspentPoints ?? unspentFromLedger(level, talentPoints),
    talentPoints,
    resources: init.resources,
    talentCooldowns: init.talentCooldowns ?? {},
    effects: init.effects ?? [],
    position: init.position ?? null,
    createdAt: stamp,
    updatedAt: init.updatedAt ?? stamp,
  };
}

// ---------------------------------------------------------------------------
// Reading a file back — total, forgiving where it can be, loud always
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type ParseResult =
  | { readonly ok: true; readonly file: CharacterFile; readonly problems: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

function parseResources(value: unknown, problems: string[]): SavedResources | null {
  if (!isRecord(value)) {
    problems.push('resources: missing or not an object');
    return null;
  }
  const hp = asFinite(value.hp);
  if (hp === null) {
    // The one genuinely fatal field. Everything else can be defaulted from the
    // class; a character with no HP figure has no restorable state at all.
    problems.push('resources.hp: missing or not a finite number');
    return null;
  }
  const ap = asFinite(value.ap);
  const mp = asFinite(value.mp);
  if (ap === null) problems.push('resources.ap: missing — defaulted to 0, refilled from the class');
  if (mp === null) problems.push('resources.mp: missing — defaulted to 0, refilled from the class');

  const rawSpecial = value.special;
  const special = isRecord(rawSpecial)
    ? { kind: asString(rawSpecial.kind) ?? '', value: asFinite(rawSpecial.value) ?? 0 }
    : { kind: '', value: 0 };
  if (!isRecord(rawSpecial)) {
    problems.push('resources.special: missing — the class resource is refilled from the class');
  }

  return { hp: Math.max(0, hp), ap: Math.max(0, ap ?? 0), mp: Math.max(0, mp ?? 0), special };
}

function parseCooldowns(value: unknown, problems: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) {
    problems.push('talentCooldowns: not an object — dropped');
    return out;
  }
  for (const [talentId, turns] of Object.entries(value)) {
    const left = asFinite(turns);
    // A cooldown that survived as a non-number is dropped rather than
    // defaulted: a talent wrongly READY is a smaller lie than one wrongly
    // locked for a fight, and the player can see the difference.
    if (left === null || left <= 0) {
      problems.push(`talentCooldowns.${talentId}: not a positive number — dropped`);
      continue;
    }
    out[talentId] = Math.floor(left);
  }
  return out;
}

/**
 * REPAIR, NEVER REJECT — `scrubName`'s doctrine, applied to the level.
 *
 * Absent is the documented decision (level 1). Anything present and unusable is
 * repaired loudly, because refusing the file would cost a character over a field
 * that is, at worst, a cosmetic lie for one evening.
 *
 * THE UPPER CLAMP IS THE ONE THAT LOSES DATA, so it is here on purpose and not
 * by reflex. A hand-edited `"level": 9999` would otherwise reach
 * `totalPointsAtLevel` and hand out eleven thousand talent points; and if
 * `MAX_CHARACTER_LEVEL` is ever RAISED and then rolled back, this clamp is the
 * "older build drops what it does not recognise" cost the header already weighed
 * and accepted. It is recorded in `problems` either way, which is the difference
 * between a trade and an accident.
 */
function parseLevel(value: unknown, problems: string[]): number {
  if (value === undefined || value === null) return BIRTH_LEVEL;
  const raw = asFinite(value);
  if (raw === null) {
    problems.push(`level: not a finite number — treated as ${BIRTH_LEVEL}`);
    return BIRTH_LEVEL;
  }
  const repaired = Math.min(MAX_CHARACTER_LEVEL, Math.max(BIRTH_LEVEL, Math.floor(raw)));
  if (repaired !== raw) {
    problems.push(
      `level: ${raw} is not an integer in ${BIRTH_LEVEL}..${MAX_CHARACTER_LEVEL} — repaired to ${repaired}`,
    );
  }
  return repaired;
}

/**
 * Per-level xp. NOT FLOORED, and that is the whole comment worth having here:
 * one kill against a normal pays `killerLevel × 0.8 × 4` = 3.2 at level 1
 * (src/shared/progression.ts `worthExp`), so xp is genuinely fractional and
 * rounding it on every load would quietly shave every award in the game.
 *
 * Negative is clamped rather than dropped, matching `gainExp`'s own
 * `math.max(0, …)` (ActorLevel.lua:97): xp can be drained, never below zero.
 * Not clamped from ABOVE — at `MAX_CHARACTER_LEVEL` the accumulation is
 * deliberate, and it is what lets the panel draw a full bar that does not flick
 * back to empty after every kill.
 */
function parseXp(value: unknown, problems: string[]): number {
  if (value === undefined || value === null) return BIRTH_XP;
  const raw = asFinite(value);
  if (raw === null) {
    problems.push(`xp: not a finite number — treated as ${BIRTH_XP}`);
    return BIRTH_XP;
  }
  if (raw < 0) {
    problems.push(`xp: ${raw} is negative — treated as ${BIRTH_XP}`);
    return BIRTH_XP;
  }
  return raw;
}

/**
 * RAW points per talent, repaired into 1..`TALENT_MAX_LEVEL`.
 *
 * ═══ WHY THIS REPAIRS WHERE `parseCooldowns` DROPS ═══
 * A dropped cooldown means a talent is wrongly READY, which the player can see
 * and which costs one fight. A dropped talent point means a talent the character
 * bought is silently back at rank 1 — invisible, permanent from the next
 * autosave, and exactly the loss this whole item exists to prevent. So a garbage
 * entry becomes the birth rank and SAYS SO, rather than vanishing.
 *
 * The cap is applied HERE, on a file, which does not contradict
 * src/shared/scale.ts:165-170 ("never clamp the talent level at 5") or the rule
 * that the cap belongs to the spend path. Those are about the CURVE, which must
 * extrapolate honestly for a monster or a buff above 5. This is about a number
 * that arrived from a text editor: nothing in the game can legitimately produce
 * a raw 6, so a raw 6 in a file is a hand-edit, not a talent level.
 *
 * The key is kept VERBATIM — a soft reference, like `talentCooldowns` and
 * `classId`. See the field's docblock for who does the refund.
 */
function parseTalentPoints(value: unknown, problems: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) {
    problems.push('talentPoints: not an object — dropped, every talent back to its birth rank');
    return out;
  }
  for (const [talentId, raw] of Object.entries(value)) {
    const points = asFinite(raw);
    if (points === null) {
      problems.push(
        `talentPoints.${talentId}: not a finite number — repaired to ${BIRTH_TALENT_POINTS}`,
      );
      out[talentId] = BIRTH_TALENT_POINTS;
      continue;
    }
    const repaired = Math.min(TALENT_MAX_LEVEL, Math.max(BIRTH_TALENT_POINTS, Math.floor(points)));
    if (repaired !== points) {
      problems.push(
        `talentPoints.${talentId}: ${points} is not a raw level in ` +
          `${BIRTH_TALENT_POINTS}..${TALENT_MAX_LEVEL} — repaired to ${repaired}`,
      );
    }
    out[talentId] = repaired;
  }
  return out;
}

/**
 * RECOMPUTED, NEVER TRUSTED. The file's `unspentPoints` is a cache of
 * `totalPointsAtLevel(level) − Σ (raw − 1)`, and this returns the ledger's
 * answer whatever the file says.
 *
 * WHY RECOMPUTING IS THE SAFE DIRECTION: the two operands are themselves
 * persisted (level, and the raw spread), so the ledger cannot disagree with the
 * character it is describing — whereas a stored count goes stale the moment
 * `pointsForLevel` is retuned, and the symptom is a party where the players who
 * joined last week have a different budget from the ones who joined tonight. It
 * is the same argument that keeps every `max*` pool out of this file.
 *
 * A DISAGREEMENT IS RECORDED rather than swallowed: it is either that retune, or
 * a hand-edit, and both are things the host should be able to see in the log
 * line the store already prints.
 */
function parseUnspentPoints(
  value: unknown,
  level: number,
  talentPoints: Readonly<Record<string, number>>,
  problems: string[],
): number {
  const ledger = unspentFromLedger(level, talentPoints);
  if (value === undefined || value === null) return ledger;
  const claimed = asFinite(value);
  if (claimed === null) {
    problems.push(`unspentPoints: not a finite number — recomputed from the ledger as ${ledger}`);
    return ledger;
  }
  if (claimed !== ledger) {
    problems.push(
      `unspentPoints: the file says ${claimed}, the ledger says ${ledger} — recomputed ` +
        '(level and the raw talent points are the source of truth)',
    );
  }
  return ledger;
}

function parseEffects(value: unknown, problems: string[]): SavedEffect[] {
  const out: SavedEffect[] = [];
  if (value === undefined || value === null) return out;
  if (!Array.isArray(value)) {
    problems.push('effects: not an array — dropped');
    return out;
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      problems.push(`effects[${index}]: not an object — dropped`);
      continue;
    }
    const effectId = asString(entry.effectId);
    const turnsRemaining = asFinite(entry.turnsRemaining);
    if (effectId === null || effectId === '' || turnsRemaining === null || turnsRemaining <= 0) {
      problems.push(`effects[${index}]: no effectId or no positive duration — dropped`);
      continue;
    }
    const magnitude = asFinite(entry.magnitude);
    out.push({
      effectId,
      turnsRemaining: Math.floor(turnsRemaining),
      ...(magnitude === null ? {} : { magnitude }),
    });
  }
  return out;
}

function parsePosition(value: unknown, problems: string[]): SavedPosition | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    problems.push('position: not an object — treated as unplaced');
    return null;
  }
  const zoneId = asString(value.zoneId);
  const depth = asFinite(value.depth);
  const cell = value.cell;
  if (zoneId === null || depth === null || !Array.isArray(cell)) {
    problems.push('position: incomplete — treated as unplaced');
    return null;
  }
  const x = asFinite(cell[0]);
  const y = asFinite(cell[1]);
  if (cell.length !== 2 || x === null || y === null) {
    problems.push('position.cell: not a pair of numbers — treated as unplaced');
    return null;
  }
  return { zoneId, depth: Math.floor(depth), cell: [Math.floor(x), Math.floor(y)] };
}

/**
 * Validate a migrated document into a `CharacterFile`.
 *
 * TOTAL: it returns, it never throws, and it never produces `any`. Fatal only
 * for the fields without which there is no character (identity, class, HP);
 * everything else is REPAIRED and the repair is recorded in `problems`, which
 * the store logs. Refusing a whole file over one bad cooldown entry would turn
 * a cosmetic corruption into a lost character, which is the opposite of the
 * job.
 */
export function parseCharacterFile(doc: unknown): ParseResult {
  if (!isRecord(doc)) return { ok: false, problems: ['root: not a JSON object'] };

  const problems: string[] = [];

  const schemaVersion = asFinite(doc.schemaVersion);
  if (schemaVersion === null) return { ok: false, problems: ['schemaVersion: missing'] };
  if (doc.kind !== SchemaKind.Character) {
    return { ok: false, problems: [`kind: expected '${SchemaKind.Character}'`] };
  }

  // Re-checked here even though the path was built from the caller's ids: a
  // file can be moved, and an `ownerId` that disagrees with its directory is
  // how one player's save ends up being written into another's.
  const id = sanitiseId(doc.id);
  const ownerId = sanitiseId(doc.ownerId);
  if (id === null) return { ok: false, problems: ['id: missing or not a safe identifier'] };
  if (ownerId === null) {
    return { ok: false, problems: ['ownerId: missing or not a safe identifier'] };
  }

  const rawName = asString(doc.name);
  if (rawName === null) return { ok: false, problems: ['name: missing'] };
  const name = scrubName(rawName);
  if (name === '')
    return { ok: false, problems: ['name: empty after removing control characters'] };
  if (name !== rawName) {
    problems.push(`name: repaired (control characters removed and/or truncated to ${NAME_MAX})`);
  }

  const classId = asString(doc.classId);
  if (classId === null || classId === '') return { ok: false, problems: ['classId: missing'] };

  const resources = parseResources(doc.resources, problems);
  if (resources === null) return { ok: false, problems };

  const createdAt = asString(doc.createdAt);
  if (createdAt === null) problems.push('createdAt: missing — recorded as unknown');

  // ═══ ORDER MATTERS AMONG THESE THREE ═══
  // `unspentPoints` is DERIVED from the other two, so both have to be repaired
  // before the ledger is run — otherwise a hand-edited level of 9999 or a raw
  // rank of 40 reaches `totalPointsAtLevel` before the clamp does.
  const level = parseLevel(doc.level, problems);
  const talentPoints = parseTalentPoints(doc.talentPoints, problems);
  const unspentPoints = parseUnspentPoints(doc.unspentPoints, level, talentPoints, problems);

  return {
    ok: true,
    problems,
    file: {
      schemaVersion,
      kind: SchemaKind.Character,
      id,
      ownerId,
      name,
      classId,
      // NAMED HERE OR SILENTLY DELETED. This function copies nothing it does not
      // name: a field on `CharacterFile` that is missing from this literal is
      // dropped on every load and written away by the next autosave, with no
      // error anywhere. Four fields, four lines, and a test that names each one.
      level,
      xp: parseXp(doc.xp, problems),
      unspentPoints,
      talentPoints,
      resources,
      talentCooldowns: parseCooldowns(doc.talentCooldowns, problems),
      effects: parseEffects(doc.effects, problems),
      position: parsePosition(doc.position, problems),
      createdAt: createdAt ?? '',
      updatedAt: asString(doc.updatedAt) ?? createdAt ?? '',
    },
  };
}

/**
 * The bytes that go on disk.
 *
 * Rebuilt field by field in a FIXED ORDER rather than stringified as-received,
 * so two saves of the same character produce byte-identical files and a
 * `git diff` of a copied-out save shows what changed rather than a reordered
 * object. Cooldown keys are sorted for the same reason — `Object.entries`
 * order follows insertion, and insertion order follows whatever order the
 * talents happened to fire in.
 *
 * Indented and newline-terminated on purpose: these files are read by a human
 * far more often than by the server, and at a few hundred bytes each the size
 * is irrelevant.
 */
export function serialiseCharacter(file: CharacterFile): string {
  const cooldowns: Record<string, number> = {};
  for (const key of Object.keys(file.talentCooldowns).sort()) {
    const turns = file.talentCooldowns[key];
    if (turns !== undefined) cooldowns[key] = turns;
  }
  // Sorted for the same reason the cooldowns are: insertion order here follows
  // whatever order the points happened to be SPENT in, so two identical
  // characters would otherwise produce two different files.
  const talentPoints: Record<string, number> = {};
  const rawPoints = file.talentPoints ?? {};
  for (const key of Object.keys(rawPoints).sort()) {
    const points = rawPoints[key];
    if (points !== undefined) talentPoints[key] = points;
  }
  const canonical: CharacterFile = {
    schemaVersion: file.schemaVersion,
    kind: file.kind,
    id: file.id,
    ownerId: file.ownerId,
    name: file.name,
    classId: file.classId,
    // ═══ WRITTEN UNCONDITIONALLY, EVEN THOUGH THE TYPE SAYS OPTIONAL ═══
    // A field missing from this literal is never written at ALL — the canonical
    // object is rebuilt from scratch for byte-stability, so it silently drops
    // anything it does not name. Emitting the defaults rather than omitting the
    // keys also means every file on disk states the character's level in words a
    // human can read, and `serialiseCharacter(parseCharacterFile(bytes))` is
    // byte-identical to `bytes` for anything this build ever wrote — which is
    // what the atomic writer's "same snapshot, same bytes" assumption rests on.
    level: file.level ?? BIRTH_LEVEL,
    xp: file.xp ?? BIRTH_XP,
    unspentPoints: file.unspentPoints ?? unspentFromLedger(file.level ?? BIRTH_LEVEL, talentPoints),
    talentPoints,
    resources: {
      hp: file.resources.hp,
      ap: file.resources.ap,
      mp: file.resources.mp,
      special: { kind: file.resources.special.kind, value: file.resources.special.value },
    },
    talentCooldowns: cooldowns,
    effects: file.effects.map((effect) => ({
      effectId: effect.effectId,
      turnsRemaining: effect.turnsRemaining,
      ...(effect.magnitude === undefined ? {} : { magnitude: effect.magnitude }),
    })),
    position: file.position,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export const LoadOutcome = {
  /** The primary file was read. */
  Loaded: 'loaded',
  /** THE PRIMARY WAS UNUSABLE AND THE `.bak` SAVED IT. Rewrite it promptly. */
  Recovered: 'recovered',
  /** Neither file exists. A new character, not a failure. */
  Missing: 'missing',
  /** Both files exist and neither is usable. Nothing was lost by this build. */
  Corrupt: 'corrupt',
  /** Written by a NEWER build. The path is now quarantined against writes. */
  TooNew: 'too_new',
  /** The ids handed in could not become a path. A bug, or an attack. */
  Rejected: 'rejected',
} as const;
export type LoadOutcome = (typeof LoadOutcome)[keyof typeof LoadOutcome];

export type LoadResult =
  | {
      readonly outcome: typeof LoadOutcome.Loaded | typeof LoadOutcome.Recovered;
      readonly file: CharacterFile;
      /** A migration ran; the caller should save to write the new shape down. */
      readonly migrated: boolean;
      /** Every repair and every rejected source, in order. Already logged. */
      readonly problems: readonly string[];
    }
  | {
      readonly outcome:
        | typeof LoadOutcome.Missing
        | typeof LoadOutcome.Corrupt
        | typeof LoadOutcome.TooNew
        | typeof LoadOutcome.Rejected;
      readonly file: null;
      readonly migrated: false;
      readonly problems: readonly string[];
    };

/**
 * Why a save is happening. Autosave is the debounced one; the rest are the
 * CRITICAL EVENTS, which never wait for a timer.
 */
export const SaveReason = {
  /** The debounce fired. Coalesced; may be superseded by any of the below. */
  Autosave: 'autosave',
  /** Downed or Erased (game-design.md § 9). */
  Death: 'death',
  /** Stairs, or the floor resetting after a party wipe. */
  LevelChange: 'level_change',
  /** The socket dropped. The body stays in the world; the file must not. */
  Disconnect: 'disconnect',
  /** Process shutdown. `close()` flushes everything through this. */
  Shutdown: 'shutdown',
  /** A GM command or an explicit request. */
  Manual: 'manual',
} as const;
export type SaveReason = (typeof SaveReason)[keyof typeof SaveReason];

export const SaveOutcome = {
  Written: 'written',
  /** Unsafe ids, or the store is closed. Nothing touched the disk. */
  Rejected: 'rejected',
  /** The file on disk belongs to a newer build. Refused; see `LoadOutcome.TooNew`. */
  Quarantined: 'quarantined',
  /** The atomic write exhausted its retries. Logged at error; the `.bak` still stands. */
  Failed: 'failed',
} as const;
export type SaveOutcome = (typeof SaveOutcome)[keyof typeof SaveOutcome];

export type SaveResult = {
  readonly outcome: SaveOutcome;
  /** Redacted and root-relative — safe to paste into an issue. Null when refused. */
  readonly path: string | null;
  readonly error?: string;
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Structurally Fastify's `app.log`, so the server passes its own logger and
 * every save line lands in the same stream as every request line, already
 * redacted by the config in main.ts.
 *
 * REQUIRED, not optional with a no-op default. "Fall back to `.bak` and log
 * loudly" is a requirement, and a default that silently discards would let a
 * store be constructed that satisfies the type and not the requirement. The
 * `problems` array on every result is the second half — a caller cannot miss
 * the diagnosis even if nobody reads the log.
 */
export type SaveLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

/**
 * Five seconds.
 *
 * Live combat state stays in memory (docs/data-schemas.md § 2); the debounce is
 * a safety net under the critical-event saves, not the primary mechanism. Long
 * enough that a busy turn coalesces into one write, short enough that a hard
 * power cut costs at most the last few seconds of a hub session.
 */
const DEFAULT_DEBOUNCE_MS = 5_000;

/** `flush` alternates draining timers and awaiting writes; this bounds the loop. */
const FLUSH_PASSES = 8;

export type SaveStoreOptions = {
  /** The data directory. `data/` at the repo root; created on first write. */
  readonly root: string;
  readonly logger: SaveLogger;
  readonly debounceMs?: number;
  /** ISO-8601 timestamps. Injected so a test's output is byte-stable. */
  readonly now?: () => string;
  /** Passed through to `writeFileAtomic`; `onWarn` is supplied by the store. */
  readonly atomic?: Omit<AtomicWriteOptions, 'onWarn'>;
};

export type SaveStore = {
  readonly root: string;
  /** Never throws. Falls back to `.bak`, then reports. */
  loadCharacter(ownerId: string, characterId: string): Promise<LoadResult>;
  /** IMMEDIATE. For death / level change / disconnect / shutdown. Never throws. */
  saveCharacter(file: CharacterFile, reason: SaveReason): Promise<SaveResult>;
  /**
   * DEBOUNCED. Coalesces per character; the newest snapshot wins.
   *
   * The snapshot is held BY REFERENCE until the timer fires, so hand in a
   * freshly built `CharacterFile` rather than a live object. Every field on the
   * type is `readonly`, so the compiler already refuses the obvious mistake.
   */
  scheduleCharacter(file: CharacterFile): void;
  /** Write every pending save now and wait for every in-flight one. */
  flush(): Promise<void>;
  /** Flush, then refuse further writes. Idempotent. */
  close(): Promise<void>;
  /** How many characters have an autosave waiting. For tests and the ops panel. */
  pendingCount(): number;
};

type PendingSave = {
  readonly file: CharacterFile;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ReadAttempt =
  | { readonly state: 'ok'; readonly doc: unknown }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'unparseable'; readonly reason: string };

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/** Read and parse one file. Distinguishes "absent" from "there and broken". */
async function readDoc(path: string): Promise<ReadAttempt> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: describeError(err) };
  }
  try {
    // `JSON.parse` returns `any`; the annotation narrows it to `unknown` at the
    // boundary so nothing downstream can member-access its way into a crash.
    const doc: unknown = JSON.parse(text);
    return { state: 'ok', doc };
  } catch (err) {
    // The signature failure of a truncated write: valid UTF-8, invalid JSON.
    return { state: 'unparseable', reason: describeError(err) };
  }
}

export function createSaveStore(options: SaveStoreOptions): SaveStore {
  const root = resolve(options.root);
  const logger = options.logger;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = options.now ?? ((): string => new Date().toISOString());
  const atomicOptions = options.atomic ?? {};

  const pending = new Map<string, PendingSave>();
  /** path → the tail of that path's write chain. See property 4 in the header. */
  const chains = new Map<string, Promise<void>>();
  /** Paths whose on-disk file was written by a newer build. Never written over. */
  const quarantined = new Set<string>();
  let closed = false;

  const RESOLVED: Promise<void> = Promise.resolve();

  /**
   * Run `task` after every task already queued for `key`, whether or not those
   * succeeded — a failed save must not wedge the queue for the rest of the
   * session. The chain entry is registered SYNCHRONOUSLY so two callers in the
   * same tick cannot both observe an empty queue.
   */
  const runExclusive = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? RESOLVED;
    const run = prior.then(task, task);
    const settled: Promise<void> = run.then(
      () => {
        if (chains.get(key) === settled) chains.delete(key);
      },
      () => {
        if (chains.get(key) === settled) chains.delete(key);
      },
    );
    chains.set(key, settled);
    return run;
  };

  const reportAtomicWarning = (warning: AtomicWarning): void => {
    switch (warning.kind) {
      case 'rename_retry':
        logger.warn(
          {
            file: redactPath(root, warning.path),
            attempt: warning.attempt,
            code: warning.code,
            delayMs: warning.delayMs,
          },
          'save: rename blocked (Defender or the search indexer holds the file) — retrying',
        );
        return;
      case 'backup_failed':
        logger.warn(
          { file: redactPath(root, warning.path), code: warning.code },
          'save: could not refresh the .bak — the primary write continues without a second chance',
        );
        return;
    }
  };

  const saveCharacter = async (file: CharacterFile, reason: SaveReason): Promise<SaveResult> => {
    if (closed) {
      logger.warn(
        { character: file.id, reason },
        'save refused: the store is closed (shutdown already flushed)',
      );
      return { outcome: SaveOutcome.Rejected, path: null, error: 'store is closed' };
    }

    const path = characterPath(root, file.ownerId, file.id);
    if (path === null) {
      // Not a data problem. Either a caller built an id by hand, or something
      // reached this function with a value that came off the wire unvalidated.
      logger.error(
        { character: file.id, owner: maskId(file.ownerId), reason },
        'save refused: ownerId or character id is not a safe path component',
      );
      return { outcome: SaveOutcome.Rejected, path: null, error: 'unsafe identifier' };
    }

    const shown = redactPath(root, path);

    if (quarantined.has(path)) {
      logger.error(
        { file: shown, reason },
        'save refused: the file on disk was written by a NEWER build — overwriting it would ' +
          'destroy whatever that build added',
      );
      return {
        outcome: SaveOutcome.Quarantined,
        path: shown,
        error: 'newer schemaVersion on disk',
      };
    }

    const stamped: CharacterFile = {
      ...file,
      schemaVersion: CURRENT_VERSIONS[SchemaKind.Character],
      kind: SchemaKind.Character,
      updatedAt: now(),
    };
    const text = serialiseCharacter(stamped);

    return await runExclusive(path, async (): Promise<SaveResult> => {
      try {
        await writeFileAtomic(path, text, { ...atomicOptions, onWarn: reportAtomicWarning });
        logger.info({ file: shown, reason, bytes: text.length }, 'character saved');
        return { outcome: SaveOutcome.Written, path: shown };
      } catch (err) {
        // Returned rather than thrown: most callers are fire-and-forget event
        // handlers, and an unhandled rejection out of a save would take the
        // process down over a file the .bak already protects.
        logger.error(
          { file: shown, reason, code: errorCode(err), err: describeError(err) },
          'CHARACTER SAVE FAILED — the previous file and its .bak are intact',
        );
        return { outcome: SaveOutcome.Failed, path: shown, error: describeError(err) };
      }
    });
  };

  /** Fire one pending autosave now. Used by the timer and by `flush`. */
  const fire = async (key: string): Promise<void> => {
    const entry = pending.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    await saveCharacter(entry.file, SaveReason.Autosave);
  };

  const scheduleCharacter = (file: CharacterFile): void => {
    if (closed) {
      logger.warn({ character: file.id }, 'autosave ignored: the store is closed');
      return;
    }
    const path = characterPath(root, file.ownerId, file.id);
    if (path === null) {
      logger.error(
        { character: file.id, owner: maskId(file.ownerId) },
        'autosave refused: ownerId or character id is not a safe path component',
      );
      return;
    }

    const existing = pending.get(path);
    if (existing !== undefined) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      // `void`, not `await`: a timer callback that returns a promise is an
      // unhandled rejection waiting to happen, and `saveCharacter` already
      // swallows and logs every failure.
      void fire(path);
    }, debounceMs);
    // A pending autosave must never be the reason the process refuses to exit.
    // `close()` is what guarantees it is written, not the event loop.
    timer.unref();

    pending.set(path, { file, timer });
  };

  const flush = async (): Promise<void> => {
    // Alternates: draining the timers enqueues writes, and an in-flight write
    // cannot enqueue a new timer, so two passes suffice in practice. The bound
    // exists so a future caller that schedules from a completion handler gets a
    // log line rather than a hang.
    for (let pass = 0; pass < FLUSH_PASSES; pass += 1) {
      for (const key of [...pending.keys()]) await fire(key);
      await Promise.all([...chains.values()]);
      if (pending.size === 0 && chains.size === 0) return;
    }
    logger.warn({ pending: pending.size, inFlight: chains.size }, 'flush: gave up draining');
  };

  const close = async (): Promise<void> => {
    await flush();
    closed = true;
  };

  const loadCharacter = async (ownerId: string, characterId: string): Promise<LoadResult> => {
    const path = characterPath(root, ownerId, characterId);
    if (path === null) {
      logger.error(
        { owner: maskId(ownerId), character: characterId },
        'load refused: ownerId or character id is not a safe path component',
      );
      return {
        outcome: LoadOutcome.Rejected,
        file: null,
        migrated: false,
        problems: ['unsafe identifier'],
      };
    }

    const shown = redactPath(root, path);
    const problems: string[] = [];
    let sawAnyFile = false;

    // PRIMARY FIRST, THEN THE `.bak`. In that order and no other: the backup is
    // by construction one generation behind, so reading it when the primary is
    // fine would silently roll a character back a save.
    const sources = [
      { label: 'primary', path },
      { label: 'backup', path: backupPathFor(path) },
    ] as const;

    for (const source of sources) {
      const read = await readDoc(source.path);

      if (read.state === 'absent') {
        problems.push(`${source.label}: absent`);
        continue;
      }
      sawAnyFile = true;

      if (read.state !== 'ok') {
        problems.push(`${source.label}: ${read.reason}`);
        logger.warn(
          { file: shown, source: source.label, reason: read.reason },
          'character save could not be read — trying the .bak',
        );
        continue;
      }

      const migrated = migrateDoc(SchemaKind.Character, read.doc);
      if (!migrated.ok) {
        problems.push(`${source.label}: ${migrated.reason}`);

        // ═══ THE REFUSAL, MADE PERMANENT FOR THIS PROCESS ═══
        // Falling through to the .bak here would be worse than failing: the
        // .bak is an OLDER shape, so we would load it happily and then write it
        // back over a newer file. Quarantine the path and stop.
        if (migrated.outcome === MigrateOutcome.TooNew) {
          quarantined.add(path);
          logger.error(
            {
              file: shown,
              source: source.label,
              found: migrated.found,
              expected: migrated.expected,
            },
            'character save is from a NEWER build — refusing to load, and refusing every ' +
              'later write to this path. Run the newer build, or move the file aside by hand.',
          );
          return { outcome: LoadOutcome.TooNew, file: null, migrated: false, problems };
        }

        logger.warn(
          { file: shown, source: source.label, reason: migrated.reason },
          'character save failed migration — trying the .bak',
        );
        continue;
      }

      const parsed = parseCharacterFile(migrated.doc);
      if (!parsed.ok) {
        for (const problem of parsed.problems) problems.push(`${source.label}: ${problem}`);
        logger.warn(
          { file: shown, source: source.label, problems: parsed.problems },
          'character save is malformed — trying the .bak',
        );
        continue;
      }

      for (const problem of parsed.problems) problems.push(`${source.label}: ${problem}`);
      const recovered = source.label === 'backup';
      if (recovered || parsed.problems.length > 0 || migrated.changed) {
        logger.warn(
          {
            file: shown,
            source: source.label,
            migrated: migrated.applied,
            problems: parsed.problems,
          },
          recovered
            ? 'CHARACTER RECOVERED FROM ITS .bak — the primary file was unusable. ' +
                'Save again promptly; the recovered state is one generation old.'
            : 'character loaded with repairs',
        );
      }

      return {
        outcome: recovered ? LoadOutcome.Recovered : LoadOutcome.Loaded,
        file: parsed.file,
        migrated: migrated.changed,
        problems,
      };
    }

    if (!sawAnyFile) {
      return { outcome: LoadOutcome.Missing, file: null, migrated: false, problems };
    }
    logger.error(
      { file: shown, problems },
      'CHARACTER SAVE UNRECOVERABLE — neither the file nor its .bak parsed. ' +
        'Nothing was overwritten; the files are still on disk.',
    );
    return { outcome: LoadOutcome.Corrupt, file: null, migrated: false, problems };
  };

  return {
    root,
    loadCharacter,
    saveCharacter,
    scheduleCharacter,
    flush,
    close,
    pendingCount: (): number => pending.size,
  };
}

// ---------------------------------------------------------------------------
// THE BRIDGE — the gateway's `PersistPort`, implemented
//
// WHAT IT IS FOR, IN ONE SENTENCE: it is the only thing in the process that
// knows which body belongs to which Discord account, and therefore the only
// thing that can decide whether a character is saveable at all.
//
// ═══════════════════════════════════════════════════════════════════════════
// ONE OWNER, ONE FILE, AND NO WAY TO GET SOMEBODY ELSE'S
// ═══════════════════════════════════════════════════════════════════════════
// A binding is created in exactly one place — `openCharacter`, called from
// `hello` for somebody a server-side `GET /users/@me` has already named. Every
// save then looks the actor up in that table. An ANONYMOUS body has no entry,
// so every save silently skips it, and that is the design rather than a gap:
// there is nothing to key its file on, and inventing an id would scatter
// `data/characters/` with directories nobody can ever prove they own.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DISCORD ID IS SANITISED EVEN THOUGH IT IS A NUMBER
// ═══════════════════════════════════════════════════════════════════════════
// `<ownerId>` is a DIRECTORY NAME. A snowflake is 17-20 decimal digits and
// always will be — but "always will be" is an assumption, not a check, and this
// repo is public, so the route from a wire value to a filesystem path is
// documented for anybody who wants it. Two layers stand in the way and neither
// is trusted to be the only one: `sanitiseId` here (so a rejected id never
// becomes a binding at all, and an unowned actor simply is not persisted) and
// `characterPath` again on every read and every write. The one that fires is a
// bug report; the one that never fires is the point.
//
// WHY IT MAY IMPORT FROM net/: type-only, erased at build time, and the same
// direction `src/server/turn-engine.ts` already takes to satisfy `TurnEngine`.
// The gateway declares the contract, this file meets it, and neither one has a
// runtime edge pointing at the other.
// ---------------------------------------------------------------------------

/**
 * The character id every player gets today.
 *
 * ONE CHARACTER PER ACCOUNT, because there is no character-select screen and
 * inventing one to justify a second file would be building for a milestone that
 * does not exist (CLAUDE.md: "do not write documents for systems that do not
 * exist"). The LAYOUT already supports more — `data/characters/<ownerId>/` is a
 * directory precisely so it can hold `chr_0002.json` one day — so the day a
 * picker lands, this constant becomes a lookup and nothing else in this file
 * changes.
 *
 * It is a fixed string rather than a generated one so a returning player finds
 * the same file with no index to keep, and so a human can find their own save.
 */
export const SOLO_CHARACTER_ID = 'chr_main';

/**
 * The class a character is filed under BEFORE ITS FIRST SAVE, and nothing else.
 *
 * IT IS NO LONGER ASPIRATIONAL. Classes are handed out now: the gateway picks
 * one before `world.addPlayer` (`classForJoin` in content/classes.ts), puts it
 * on the body as `PlayerActor.classId`, and every snapshot carries it — so
 * `fileFor` writes the real name from the first save onwards. This constant is
 * the value a BINDING holds in the window between `openCharacter` (which reads
 * a file that does not exist yet) and that first save, plus the value carried
 * forward for a body that genuinely has no class at all: a test fixture, the
 * e2e harness, a build with no content wired in.
 *
 * IT REMAINS A SOFT reference, exactly as `CharacterFile.classId` documents: not
 * a member of `ClassId`, deliberately, so that a file naming a class this build
 * no longer has is substituted and logged rather than refused. A file claiming
 * to be a Watchman when nobody ever chose Watchman would be worse than a file
 * that admits it does not know.
 *
 * EXPORTED so net/gateway.ts can tell "this file predates classes" apart from
 * "this file names a class that was deleted". Those look identical to
 * `classById`, which answers `undefined` to both — and since every character
 * file written before this milestone holds this exact string, the dangling-class
 * warning fired for EVERY returning player on the first evening. That line's
 * stated purpose is to be the only evidence a class was renamed, so drowning it
 * in N false alarms costs the one thing it was added for. A second literal
 * `'unassigned'` in the gateway would go stale the day this one changes.
 */
export const UNASSIGNED_CLASS = 'unassigned';

/**
 * The one level there is. `SavedPosition` is per-zone because zones are coming;
 * until they do, every save names the same one so the field is honest rather
 * than absent.
 */
const DEFAULT_ZONE_ID = 'zone:test_level';

/** What the gateway calls a save, mapped to what the store calls one. */
const REASON_BY_LABEL: Readonly<Record<string, SaveReason>> = {
  join: SaveReason.Manual,
  death: SaveReason.Death,
  disconnect: SaveReason.Disconnect,
  recall: SaveReason.Disconnect,
  shutdown: SaveReason.Shutdown,
};

/** One player's seat: which file their body writes to, and what it was created as. */
type Binding = {
  readonly ownerId: string;
  readonly characterId: string;
  /** Carried forward from the file so "first played" survives every rewrite. */
  readonly createdAt: string;
  readonly classId: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PROGRESSION AS THE FILE HAD IT WHEN IT WAS OPENED — NOW ONLY THE FALLBACK.
   * ═══════════════════════════════════════════════════════════════════════════
   * These four used to be the ONLY source `fileFor` had, because
   * `CharacterSnapshot` could not carry progression: it was `name / hp /
   * cooldowns / x / y / classId`. The binding remembered what the file said and
   * wrote it back unchanged, on the reasoning that the first autosave of the
   * evening would otherwise put the birth defaults over a level-8 character and
   * the second would take the `.bak` with it. Frozen is recoverable;
   * overwritten with 1 is not.
   *
   * THAT SEAM IS CLOSED. `CharacterSnapshot` grew `level` / `xp` /
   * `unspentPoints` / `talentPoints` as optional fields and `snapshotPlayers`
   * fills them off `PlayerActor`, so `fileFor` reads the snapshot FIRST and
   * falls back to these — exactly as the `classId` line already did. The load
   * half closed with it: `openCharacter` now returns all four on
   * `CharacterRestore`.
   *
   * SO WHY ARE THEY STILL HERE? Because "the snapshot cannot say" is still a
   * reachable answer and it is not the same answer as 1. A body whose class is
   * provisional has its `talentPoints` DELIBERATELY omitted (a spread against a
   * class nobody picked would be a lie), a test fixture builds snapshots by
   * hand, and the e2e harness has no talent sheet at all. Every one of those
   * must carry the file forward rather than reset it. The fallback is the
   * defence; it is simply no longer the only path.
   */
  readonly level: number;
  readonly xp: number;
  readonly unspentPoints: number;
  readonly talentPoints: Readonly<Record<string, number>>;
};

export type CharacterBridgeOptions = {
  readonly store: SaveStore;
  readonly logger: SaveLogger;
  /** ISO-8601 stamps for characters that have never existed. Injected for tests. */
  readonly now?: () => string;
};

/**
 * Build the bridge. The return value satisfies the gateway's `PersistPort`.
 *
 * NOTHING HERE THROWS AND NOTHING HERE REJECTS. Every method is called from a
 * `ws` event handler or a timer, where an escaping exception kills the PROCESS
 * and with it everyone else's evening. `SaveStore` already returns its failures
 * rather than throwing them; this layer keeps that promise going upwards.
 */
export function createCharacterBridge(options: CharacterBridgeOptions): PersistPort {
  const { store, logger } = options;
  const now = options.now ?? ((): string => new Date().toISOString());

  /** actor id -> the file it writes to. The whole of "who may be persisted". */
  const bindings = new Map<string, Binding>();

  const fileFor = (snapshot: CharacterSnapshot, binding: Binding): CharacterFile =>
    createCharacterFile({
      id: binding.characterId,
      ownerId: binding.ownerId,
      name: snapshot.name,
      // ═══ THE SNAPSHOT WINS, OR A NEW CLASS IS NEVER WRITTEN DOWN ═══
      // The binding's `classId` is whatever the file said when it was OPENED,
      // and on a first-ever join that is `unassigned` — so reading it alone
      // rewrote `unassigned` forever, and every session re-rolled the player's
      // class off a per-process rotation counter. The snapshot is the live body,
      // which is where the class actually is.
      //
      // THE BINDING IS STILL THE FALLBACK, for a body that has no class at all:
      // it carries forward whatever the file already held rather than
      // downgrading a saved Watchman to `unassigned` because a fixture joined
      // without one.
      classId: snapshot.classId ?? binding.classId,
      // ═══ THE SNAPSHOT WINS FOR THESE FOUR TOO, OR A LEVEL NEVER LANDS ═══
      // These lines used to read `binding.level` and friends unconditionally,
      // which froze the file at whatever it said when it was OPENED. That was
      // the correct defensive choice while `CharacterSnapshot` could not carry
      // progression — frozen is recoverable, overwritten with 1 is not. It CAN
      // carry it now (`snapshotPlayers`, net/gateway.ts, fills all four straight
      // off `PlayerActor` and through the `talentPointsOf` seam), and while the
      // freeze stood the value on disk could never become anything but the birth
      // default: the binding echoed back what it read and nothing else ever
      // wrote the field. An evening's kills reached no file at all.
      //
      // THE `??` KEEPS THE OLD DEFENCE FOR ANY PRODUCER THAT STILL CANNOT SAY.
      // A snapshot that omits a field — a test fixture, the e2e harness, a body
      // whose class is still provisional, which is exactly why `snapshotPlayers`
      // omits `talentPoints` for anyone in `classChoiceOwed` — falls back to
      // what the file already held rather than to 1. Same shape, same reason, as
      // the `classId` line above.
      level: snapshot.level ?? binding.level,
      xp: snapshot.xp ?? binding.xp,
      unspentPoints: snapshot.unspentPoints ?? binding.unspentPoints,
      talentPoints: snapshot.talentPoints ?? binding.talentPoints,
      // CURRENT VALUES ONLY — every `max*` pool is derived from the class at
      // load (docs/data-schemas.md § 3, and this file's own header). AP and MP
      // are intra-turn budgets refilled from the class every turn, so a stored
      // figure would be a number that is wrong by the time anybody reads it.
      resources: { hp: snapshot.hp, ap: 0, mp: 0, special: { kind: '', value: 0 } },
      talentCooldowns: snapshot.cooldowns,
      // Statuses are a fight's state, measured in single-figure turns, and a
      // save is a session boundary. Same reasoning as the two energy clocks.
      effects: [],
      // SAVED BUT NOT RESTORED YET — see `CharacterRestore` in net/gateway.ts.
      // It is written because the file is read by humans and because a zone id
      // is what makes it restorable the moment there is more than one level.
      position: { zoneId: DEFAULT_ZONE_ID, depth: 0, cell: [snapshot.x, snapshot.y] },
      createdAt: binding.createdAt,
    });

  const openCharacter = async (
    ownerId: string,
    actorId: string,
  ): Promise<CharacterRestore | null> => {
    const safeOwner = sanitiseId(ownerId);
    if (safeOwner === null) {
      // Not a data problem: a Discord id that is not [A-Za-z0-9_-]{1,64} either
      // means Discord changed the shape of a snowflake or something reached this
      // function from somewhere it should not have. No binding, so this player
      // is simply not persisted rather than persisted somewhere unexpected.
      logger.error(
        { actor: actorId },
        'character open refused: owner id is not a safe path component',
      );
      return null;
    }

    const result = await store.loadCharacter(safeOwner, SOLO_CHARACTER_ID);

    // ═══ TWO OUTCOMES DELIBERATELY DO NOT BIND ═══
    // `too_new` and `corrupt` both mean there is a file on disk this build must
    // not overwrite: one was written by a newer build (overwriting destroys
    // whatever it added) and one is the only remaining evidence of what went
    // wrong. Refusing the binding lets the player carry on playing NOW, with a
    // throwaway body, while the files stay exactly where a human can look at
    // them. The alternative — bind anyway — quietly finishes the job three
    // seconds later, on the autosave.
    if (result.outcome === LoadOutcome.TooNew || result.outcome === LoadOutcome.Corrupt) {
      logger.error(
        { actor: actorId, owner: maskId(safeOwner), outcome: result.outcome },
        'CHARACTER NOT LOADED AND NOT BOUND — this session will not be saved. The files on ' +
          'disk are untouched; move them aside by hand to start fresh.',
      );
      return null;
    }
    if (result.outcome === LoadOutcome.Rejected) return null;

    const file = result.file;
    bindings.set(actorId, {
      ownerId: safeOwner,
      characterId: SOLO_CHARACTER_ID,
      createdAt: file?.createdAt === undefined || file.createdAt === '' ? now() : file.createdAt,
      classId: file?.classId ?? UNASSIGNED_CLASS,
      // A file this build refused to bind never reaches here, and a file that is
      // simply ABSENT is a brand-new character — the birth defaults are the
      // right answer for both. `parseCharacterFile` has already applied the same
      // ones to anything it did read, so these `??`s only ever fire on `null`.
      level: file?.level ?? BIRTH_LEVEL,
      xp: file?.xp ?? BIRTH_XP,
      unspentPoints: file?.unspentPoints ?? 0,
      talentPoints: file?.talentPoints ?? {},
    });

    if (file === null) {
      logger.info(
        { actor: actorId, owner: maskId(safeOwner) },
        'first sight of this account — a character will be created on the first save',
      );
      return null;
    }

    logger.info(
      { actor: actorId, owner: maskId(safeOwner), outcome: result.outcome, name: file.name },
      'character loaded',
    );
    return {
      hp: file.resources.hp,
      cooldowns: file.talentCooldowns,
      // ═══ THE ONE FIELD THAT DECIDES WHO THE PLAYER IS TONIGHT ═══
      // There is no class-selection screen yet, so this string is the ONLY
      // record that this account plays the Watchman. Handed back VERBATIM —
      // including `unassigned` and including a name this build no longer has —
      // because the substitute-and-log decision belongs to the caller, which is
      // the only layer that knows what the three classes are. See
      // `classForJoin` in content/classes.ts.
      classId: file.classId,
      // ═══ AND PROGRESSION COMING BACK, WHICH IS THE OTHER HALF OF THE LOOP ═══
      // This return used to be `{hp, cooldowns, classId}` and nothing else, so
      // `CharacterRestore.level` was ALWAYS undefined and the gateway's
      // `restoreProgression` correctly took its "this port cannot say" branch on
      // every single restore — leaving the birth defaults on a character who had
      // spent an evening earning otherwise. With `fileFor` above now writing the
      // live values, a load that still refused to read them would be a one-way
      // valve: levels to disk, nothing back.
      //
      // HANDED OVER RAW, EXACTLY AS `parseCharacterFile` LEFT THEM. Every one of
      // these has already been range-checked and repaired on the way in
      // (`parseLevel` / `parseTalentPoints` / `parseUnspentPoints`), and
      // `restoreProgression` re-derives `unspentPoints` from the ledger anyway
      // rather than trusting the cached figure. Repairing again here would be a
      // second opinion that can disagree with the first.
      level: file.level,
      xp: file.xp,
      unspentPoints: file.unspentPoints,
      talentPoints: file.talentPoints,
    };
  };

  /** Snapshots with a file to go to. Everything else is dropped, silently and on purpose. */
  const owned = (snapshots: readonly CharacterSnapshot[]): [CharacterSnapshot, Binding][] => {
    const out: [CharacterSnapshot, Binding][] = [];
    for (const snapshot of snapshots) {
      const binding = bindings.get(snapshot.actorId);
      if (binding !== undefined) out.push([snapshot, binding]);
    }
    return out;
  };

  return {
    savePlayers(snapshots: readonly CharacterSnapshot[]): void {
      for (const [snapshot, binding] of owned(snapshots)) {
        store.scheduleCharacter(fileFor(snapshot, binding));
      }
    },

    savePlayersNow(snapshots: readonly CharacterSnapshot[], reason: string): void {
      const saveReason = REASON_BY_LABEL[reason] ?? SaveReason.Manual;
      for (const [snapshot, binding] of owned(snapshots)) {
        // `void`, not `await`: this method returns void by contract because the
        // frame a player is waiting for must not queue behind a disk, and
        // `saveCharacter` already swallows and logs every failure rather than
        // rejecting. A floating promise here would be an unhandled rejection
        // waiting for the first EPERM from a virus scanner.
        void store.saveCharacter(fileFor(snapshot, binding), saveReason);
      }
    },

    openCharacter,

    closeCharacter(actorId: string): void {
      bindings.delete(actorId);
    },
  };
}
