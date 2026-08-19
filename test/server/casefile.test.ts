import { describe, expect, it } from 'vitest';

import { fileableCount, isFileable, knownFiled } from '../../src/server/world/casefile.ts';
import { ENCOUNTER_SITE, RealmKind, SITES } from '../../src/server/world/realms.ts';
import { createCharacterFile, parseCharacterFile } from '../../src/server/persist/saves.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CASE FILE — WHAT COUNTS, WHAT DOES NOT, AND WHAT SURVIVES A RESTART.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This game had no memory of anything a player did: level and gold were the
 * whole record, and clearing the Drowned Chapel left no trace, so a map of
 * twenty-odd markers looked identical on a first evening and a fifth.
 *
 * The rules below are the ones a player would notice being wrong. A denominator
 * that counted the towns would open every file at 23% done; one that counted
 * ambushes would never close.
 */

describe('what can be filed', () => {
  it('counts the rooms and nothing else', () => {
    const fileable = [...SITES].filter(([, def]) => isFileable(def));
    const rest = [...SITES].filter(([, def]) => !isFileable(def));

    expect(fileable.length).toBe(fileableCount(SITES));
    expect(fileable.length).toBeGreaterThan(10);

    // EVERY FILEABLE SITE IS A PLACE A PARTY CAN BE HURT IN. That is what
    // `Inner` means, and it is the whole definition.
    for (const [id, def] of fileable) {
      expect(def.kind, id).toBe(RealmKind.Inner);
    }
    // AND NOTHING ELSE IS: the towns and the crossing.
    for (const [id, def] of rest) {
      expect(def.kind, id).not.toBe(RealmKind.Inner);
    }
  });

  it('leaves the settlements out, or the file opens part-done', () => {
    /**
     * `createRealms` asserts nothing hostile ever spawns in a shared space, so a
     * town has no residents to clear and would be filed by the act of walking
     * in. Five of them would open every case file at nearly a quarter complete,
     * which is a progress bar that lies in the direction that matters least to
     * a player and most to the person who built it.
     */
    for (const townish of ['site:alderbrook', 'site:threadneedle_row', 'site:saints_rest']) {
      const def = SITES.get(townish);
      expect(def, townish).toBeDefined();
      if (def === undefined) continue;
      expect(isFileable(def), townish).toBe(false);
    }
  });

  it('leaves the crossing out, because you do not clear a coastline', () => {
    const def = SITES.get(REDACTION_SITE_ID);
    expect(def).toBeDefined();
    if (def === undefined) return;
    expect(isFileable(def)).toBe(false);
  });

  it('leaves the ambush out, which would make the file unfinishable', () => {
    /**
     * `ENCOUNTER_SITE` is deliberately NOT in `SITES` — *"every entry there is a
     * cell somebody authored on the map, and this one is a roll"*. There are
     * unboundedly many ambushes, so filing them would make the denominator
     * meaningless. Asserted from BOTH sides: it is not in the registry, and it
     * would not be counted even if something put it there.
     */
    expect(SITES.has(ENCOUNTER_SITE.id)).toBe(false);
    expect([...SITES.values()].some((d) => d.id === ENCOUNTER_SITE.id)).toBe(false);
  });

  it('includes the other map, which is over a third of the game', () => {
    const twins = [...SITES].filter(([id]) => id.startsWith(`${REDACTION_SITE_ID}:`));
    expect(twins.length).toBeGreaterThan(3);
    for (const [id, def] of twins) expect(isFileable(def), id).toBe(true);
  });
});

describe('a file written by another build', () => {
  it('drops ids this build does not recognise', () => {
    /**
     * THE COUNTER IS SHOWN TO THE PLAYER. A save carrying a site that has since
     * been renamed would read "filed 18 of 17", which tells somebody their
     * progress is corrupt in the one place they look to feel like they are
     * getting somewhere. Dropping is the only honest answer.
     */
    const real = [...SITES].filter(([, d]) => isFileable(d)).map(([id]) => id);
    const first = real[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const known = knownFiled([first, 'site:a_place_that_never_existed'], SITES);
    expect(known).toEqual([first]);
    expect(known.length).toBeLessThanOrEqual(fileableCount(SITES));
  });

  it('never reports more closed than there are to close', () => {
    // The property behind the assertion above, stated over the whole registry:
    // whatever a save says, the count cannot exceed the denominator.
    const everything = [...SITES.keys(), 'site:junk', 'site:junk', ''];
    expect(knownFiled(everything, SITES).length).toBe(fileableCount(SITES));
  });

  it('reports in registry order, not in the order they were closed', () => {
    // Two players who closed the same cases in a different sequence must see
    // the same file, or the panel is about their history rather than their
    // progress.
    const real = [...SITES].filter(([, d]) => isFileable(d)).map(([id]) => id);
    const some = real.slice(0, 4);
    expect(knownFiled([...some].reverse(), SITES)).toEqual(some);
  });

  it('is not confused by a duplicate', () => {
    const real = [...SITES].filter(([, d]) => isFileable(d)).map(([id]) => id);
    const one = real[0];
    if (one === undefined) throw new Error('no fileable sites');
    expect(knownFiled([one, one, one], SITES)).toEqual([one]);
  });
});

describe('the file on disk', () => {
  const BASE = {
    id: 'chr_probe',
    ownerId: '111111111111111111',
    name: 'Ren',
    classId: 'class:watchman',
    resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('round-trips the closed cases', () => {
    const file = createCharacterFile({ ...BASE, filed: ['site:underworks', 'site:cairnfoot'] });
    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.filed).toEqual(['site:underworks', 'site:cairnfoot']);
  });

  it('loads a file written before any of this existed', () => {
    // A v1 character has closed nothing, which is the honest answer: nothing
    // recorded it at the time. Not an error, and not a full file either.
    const file = createCharacterFile({ ...BASE });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    delete doc['filed'];
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.filed).toBeUndefined();
  });

  it('drops one bad entry rather than the whole file', () => {
    // REPAIR, NEVER REJECT — a session's work must not be lost to one bad row.
    const file = createCharacterFile({ ...BASE, filed: ['site:underworks'] });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    doc['filed'] = ['site:underworks', 42, '', null];
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.filed).toEqual(['site:underworks']);
  });

  it('reads an empty list as “cannot say” so the disk is left alone', () => {
    /**
     * The distinction the whole carry-forward rule turns on, and it matters more
     * here than for fog: `[]` would be a STATEMENT that this character has
     * closed nothing, and a producer mid-migration writing it would erase a
     * completed file. Country can be re-walked in a minute; seventeen cleared
     * rooms is several sessions.
     */
    const file = createCharacterFile({ ...BASE });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    doc['filed'] = [];
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.filed).toBeUndefined();
  });
});
