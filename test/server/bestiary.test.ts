import { describe, expect, it } from 'vitest';

import {
  INDEX_CAIRN,
  INDEX_EIDOLON,
  INDEX_HUSK,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  validateTemplate,
} from '../../src/server/content/monsters.ts';
import { ambushRoster } from '../../src/server/content/encounter.ts';
import { resolveRngAvg } from '../../src/server/content/resolvers.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { arenaGround, makeArena } from '../../src/shared/arena.ts';
import { Ground } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO MORE THINGS TO MEET, AND EACH BELONGS SOMEWHERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three monster templates was the ceiling on everything else. Sixteen
 * destinations and six kinds of country all opened onto the same husk, the same
 * wraith and the same elite — so a forest and a moor were the same fight in two
 * colours, and every judging panel that looked at the world design independently
 * named the bestiary rather than the cartography as the real problem.
 *
 * ═══ THE DESIGN, IN ONE SENTENCE EACH ═══
 * The EIDOLON is fast and made of paper. Where sightlines are four tiles it is
 * on you before you get a second decision; on the open moor you see it coming
 * from eight and shoot it to pieces.
 * The CAIRN out-ranges everything the party owns and has twenty-three hit
 * points. Across water it cannot be reached and neither can you; the moment
 * somebody finds the ford it is over.
 *
 * Neither is a difficulty increase. Both are a reason to read the ground.
 */

describe('the two new creatures are ported, not invented', () => {
  it('gives the eidolon the wolf base, verbatim', () => {
    // canine.lua:40-43 — the base every wolf in ToME is built on, and the exact
    // creature the wood wanted: Dexterity leads by a mile, Constitution is the
    // worst stat on the sheet, and it moves at 1.2.
    expect(INDEX_EIDOLON.globalSpeed).toBe(1.2);
    expect(INDEX_EIDOLON.combat.stats).toEqual({ str: 10, dex: 17, mag: 3, con: 7 });
    expect(INDEX_EIDOLON.combat.mods).toEqual({ armour: 1, def: 1 });
    // canine.lua:52 `max_life = resolvers.rngavg(40,70)`.
    expect(INDEX_EIDOLON.maxHp).toBe(resolveRngAvg(40, 70));
  });

  it('gives the cairn the crystal base, verbatim', () => {
    // crystal.lua:34-38.
    expect(INDEX_CAIRN.globalSpeed).toBe(0.7);
    expect(INDEX_CAIRN.combat.stats).toEqual({ str: 1, dex: 5, mag: 20, con: 1 });
    expect(INDEX_CAIRN.maxHp).toBe(resolveRngAvg(12, 34));
    // `combat_armor` is absent upstream and therefore 0 here: it dodges nothing
    // and absorbs nothing. Its whole defence is the water.
    expect(INDEX_CAIRN.combat.mods?.armour).toBe(0);
  });

  it('passes the same validator as everything that shipped before them', () => {
    for (const template of MONSTER_TEMPLATES) {
      expect(validateTemplate(template), `${template.id} is malformed`).toEqual([]);
    }
    expect(MONSTER_TEMPLATES).toHaveLength(5);
  });

  it('spends art that was already cut and drawing nothing', () => {
    // Both sprites have been in the manifest since the day they were made and
    // had never been requested by anything. No new art, and no risk of the
    // violet missing-asset box.
    expect(INDEX_EIDOLON.sprite).toBe('enemy_index_eidolon_s');
    expect(INDEX_CAIRN.sprite).toBe('enemy_index_cairn_s');
  });
});

describe('each one is dangerous on its own ground and nowhere else', () => {
  it('makes the eidolon the fastest thing in the game', () => {
    /**
     * THE WHOLE CREATURE IS IN THIS NUMBER. It is the only monster that acts
     * more often than a player does, and in a room whose sightlines are four
     * tiles that is the difference between "something is coming" and "something
     * is here". If this ever drops to 1 the wood has nothing in it.
     */
    for (const other of MONSTER_TEMPLATES) {
      if (other.id === INDEX_EIDOLON.id) continue;
      expect(INDEX_EIDOLON.globalSpeed).toBeGreaterThan(other.globalSpeed);
    }
  });

  it('makes the cairn out-range the party, and pays for it in life', () => {
    /**
     * THE TRADE, AS TWO ASSERTIONS. It reaches further than the wraith — which
     * is what makes the far bank of a channel a problem to solve rather than a
     * place to ignore — and it is the frailest thing in the roster, so the
     * answer is always "get to it" and the fen is what makes that hard.
     */
    expect(INDEX_CAIRN.attackRange).toBeGreaterThan(INDEX_WRAITH.attackRange);
    for (const other of MONSTER_TEMPLATES) {
      if (other.id === INDEX_CAIRN.id) continue;
      expect(INDEX_CAIRN.maxHp).toBeLessThan(other.maxHp);
    }
    // And it is slow, so on dry ground you can simply walk away from it.
    expect(INDEX_CAIRN.globalSpeed).toBeLessThan(1);
    expect(INDEX_CAIRN.profile).toBe(AiProfile.RangedKiter);
  });
});

describe('the ground decides what is waiting in it', () => {
  it('puts the eidolon in the wood and the cairn in the fen', () => {
    const solo = { level: 1, size: 1 };
    expect(ambushRoster(solo, Ground.Wood)).toContain(INDEX_EIDOLON);
    expect(ambushRoster(solo, Ground.Fen)).toContain(INDEX_CAIRN);
  });

  it('keeps each of them off every other ground', () => {
    const solo = { level: 1, size: 1 };
    for (const ground of Object.values(Ground)) {
      const roster = ambushRoster(solo, ground);
      if (ground !== Ground.Wood) expect(roster, `${ground}`).not.toContain(INDEX_EIDOLON);
      if (ground !== Ground.Fen) expect(roster, `${ground}`).not.toContain(INDEX_CAIRN);
    }
  });

  it('ADDS to the roster and never replaces it', () => {
    /**
     * The husk is in every ambush on every ground, because the roster is the
     * game's constant and a ground that swapped it out would be a different game
     * rather than a different place. What a ground does is put one more thing in
     * the room that belongs there.
     */
    for (const ground of Object.values(Ground)) {
      expect(ambushRoster({ level: 1, size: 1 }, ground)).toContain(INDEX_HUSK);
    }
  });

  it('is unchanged for a caller that names no ground', () => {
    // Every fixture written before today, and the default room.
    expect(ambushRoster({ level: 9, size: 4 })).toEqual(
      ambushRoster({ level: 9, size: 4 }, Ground.Upland),
    );
    expect(ambushRoster({ level: 1, size: 1 })).toEqual([INDEX_HUSK]);
  });

  it('does not gate the local wildlife behind level or headcount', () => {
    /**
     * DELIBERATE, and the opposite of the wraith/elite gates above it. Those
     * exist so a lone level-1 stranger does not meet the whole bestiary in their
     * first twenty seconds. These are not escalations — they are what lives
     * here, and a level-1 player who walks into a fen SHOULD meet the thing that
     * lives in the fen. Learning it is the reward for having gone there.
     */
    expect(ambushRoster({ level: 1, size: 1 }, Ground.Fen)).toContain(INDEX_CAIRN);
    expect(ambushRoster({ level: 1, size: 1 }, Ground.Wood)).toContain(INDEX_EIDOLON);
  });
});

describe('a room remembers what ground made it', () => {
  it('reads its own ground back off its floor, for every ground', () => {
    /**
     * `SiteDef.populate` is handed the map and not the ground, and threading a
     * second parameter through a hook every site implements would carry a fact
     * the map already contains. Every ground paints a DIFFERENT floor code, so
     * the room is its own record — one fact, one place, nothing to keep in step.
     */
    for (const ground of Object.values(Ground)) {
      const map = makeArena('realm:site:encounter:11', ground);
      expect(arenaGround(map), `${ground} could not be read back`).toBe(ground);
    }
  });

  it('answers UPLAND for a map it did not build', () => {
    // Every fixture and every authored site takes this path, and UPLAND is the
    // default room — so an unknown floor gets the roster it has always had.
    const notAnArena = {
      view: { w: 8, h: 8, tiles: new Array<number>(64).fill(0) },
      spawns: [{ x: 1, y: 1 }],
      sites: new Map<string, string>(),
    };
    expect(arenaGround(notAnArena)).toBe(Ground.Upland);
  });
});
