import { ROAMER_KINDS } from '../../src/server/world/roamers.ts';
import { describe, expect, it } from 'vitest';

import {
  INDEX_CAIRN,
  INDEX_EIDOLON,
  INDEX_HUSK,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  validateTemplate,
  INDEX_GLUT,
  INDEX_INSPECTOR,
  INDEX_INQUISITOR,
  INDEX_WATCHER,
} from '../../src/server/content/monsters.ts';
import { ambushRoster } from '../../src/server/content/encounter.ts';
import { resolveRngAvg } from '../../src/server/content/resolvers.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { ENCOUNTER_SITE, createRealms } from '../../src/server/world/realms.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
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
    expect(MONSTER_TEMPLATES).toHaveLength(9);
  });

  it('spends art that was already cut and drawing nothing', () => {
    /**
     * All three sprites have been in the manifest since the day they were made.
     * No new art, and no risk of the violet missing-asset box.
     *
     * THE GLUT'S CASE IS THE WORST OF THE THREE AND IS WORTH THE EXTRA LINE:
     * `enemy_index_glut_s` was not merely unused, it was BEING DRAWN — as a
     * roamer named *Something Redacted* on the overworld — and there was no
     * creature behind it. Walking into that marker produced a room of husks.
     * See `test/server/roamer-identity.test.ts` for the join that was missing.
     */
    expect(INDEX_EIDOLON.sprite).toBe('enemy_index_eidolon_s');
    expect(INDEX_CAIRN.sprite).toBe('enemy_index_cairn_s');
    expect(INDEX_GLUT.sprite).toBe('enemy_index_glut_s');
    // AND THE LAST TWO IN THE MANIFEST. `enemy_disgraced_inspector_s` was
    // referenced by no file at all; `enemy_high_inquisitor_s` appeared once, in
    // a comment in content/items.ts explaining that it is a monster sprite and
    // NOT a player class. Every enemy sprite that ships now has a creature.
    expect(INDEX_INSPECTOR.sprite).toBe('enemy_disgraced_inspector_s');
    expect(INDEX_INQUISITOR.sprite).toBe('enemy_high_inquisitor_s');

    /**
     * AND THE BOSS SPENDS NO ART AT ALL, WHICH IS A DIFFERENT STATEMENT.
     *
     * `INDEX_WATCHER` RE-USES `enemy_index_cairn_s` rather than asking for a
     * sprite. That is not a shortcut, it is the fiction: `places.ts` describes
     * its room as *"the pile has been added to since the country ended"* and
     * INDEX_CAIRN is *"a stack of citations weathered into the shape of a marker
     * stone"* — the boss IS that, at the size the sentence implies.
     *
     * There is also no boss ring in the manifest: `canvas.ts` maps every
     * non-Normal rank to `ui_token_ring_elite`, so it wears the elite's. Stated
     * here rather than left to be noticed, because a reader who assumes a boss
     * looks distinct will go looking for the asset.
     */
    expect(INDEX_WATCHER.sprite).toBe(INDEX_CAIRN.sprite);
    expect(MONSTER_TEMPLATES.filter((t) => t.sprite === INDEX_WATCHER.sprite)).toHaveLength(2);
  });
});

describe('each one is dangerous on its own ground and nowhere else', () => {
  it('makes the eidolon the fastest thing on the moor, and not on the other map', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS SAID "THE FASTEST THING IN THE GAME" AND IS NOW TWO CLAIMS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * THE WHOLE CREATURE IS IN THIS NUMBER. It acts more often than a player
     * does, and in a room whose sightlines are four tiles that is the difference
     * between "something is coming" and "something is here". If it ever drops to
     * 1 the wood has nothing in it.
     *
     * `INDEX_INSPECTOR` is 1.25 — `feline.lua:30`, verbatim — so the superlative
     * had to be narrowed rather than defended. NARROWED HONESTLY AND NOT
     * DELETED: the eidolon is still the fastest thing a player will meet for as
     * long as they stay on Alderbrook, which is the map its essay is about, and
     * the one thing that is faster lives on a landmass 99 tiles and a door away.
     *
     * That the dark territory holds something faster than anything on the moor
     * is the intended shape of a second map, and it is a claim worth asserting
     * rather than a fact to apologise for. See `ROAMER_KINDS` / `REDACTED_KINDS`.
     */
    for (const other of MONSTER_TEMPLATES) {
      if (other.id === INDEX_EIDOLON.id) continue;
      if (other.id === INDEX_INSPECTOR.id) continue;
      expect(INDEX_EIDOLON.globalSpeed, other.id).toBeGreaterThan(other.globalSpeed);
    }

    // AND THE ONE EXCEPTION IS ON THE OTHER MAP AND ONLY THERE. If the Inspector
    // ever joins Alderbrook's pool, this fails — and it should, because the
    // eidolon's essay would then be describing a creature that is no longer the
    // thing it says it is.
    expect(INDEX_INSPECTOR.globalSpeed).toBeGreaterThan(INDEX_EIDOLON.globalSpeed);
    expect(ROAMER_KINDS.map((k) => k.template.id)).not.toContain(INDEX_INSPECTOR.id);
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

describe('the first fight pays', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SINGLE MOST IMPORTANT ENCOUNTER IN THE GAME, MEASURED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tools/first-session.mjs` drives a real opening and prints one line that is
   * the whole argument: `LOOTS THE ROOM: (nothing)`.
   *
   * Measured over 60 opening ambushes at level 1 solo: exactly one monster in
   * the room, an item **35% of the time** (the husk's ported drop chance), and no
   * floor litter at all — an ambush is a fight rather than a place, so unlike a
   * delve there is nothing lying about. So the median first encounter was *kill
   * the thing, get nothing, walk away with the fifteen coins you started with*.
   *
   * That is where somebody decides whether the loop pays, and no amount of world
   * design matters if the answer on the first swing is no.
   */
  function opening(level: number, size: number, seed: string): number {
    const downed = createDownedState();
    const parties = createPartyState();
    const realms = createRealms({
      seed,
      engineFor: (world) => createTurnEngine({ world, downed, parties }),
    });
    const realm = realms.open(ENCOUNTER_SITE, `p:${seed}`, { level, size }, Ground.Upland);
    return realm.world
      .allActors()
      .filter((a) => a.kind === ActorKind.Monster)
      .flatMap((m) => m.carried ?? []).length;
  }

  it('always gives a level-1 opening something to carry home', () => {
    for (let i = 0; i < 12; i += 1) {
      expect(
        opening(1, 1, `first-pays-${String(i)}`),
        `run ${String(i)} paid nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('leaves the husk’s own drop rate alone from level 2 on', () => {
    /**
     * THE ALTERNATIVE WAS RAISING `INDEX_HUSK.drops.chance`, and the husk is the
     * commonest creature in the game — moving it inflates every fight forever to
     * fix the first one. This is a floor under the OPENING and nothing else, so
     * by level 2 the rate is upstream's again and a player who has been paid once
     * is being taught by the game rather than by a special case.
     *
     * Measured at 30% over 60 rooms, which is the 35% table with rounding; the
     * assertion is a band because the point is that it is NOT 100%.
     */
    let paid = 0;
    const runs = 40;
    for (let i = 0; i < runs; i += 1) {
      if (opening(2, 1, `later-${String(i)}`) > 0) paid += 1;
    }
    expect(paid).toBeGreaterThan(0);
    expect(paid, 'level 2 is being handed a guaranteed drop too').toBeLessThan(runs);
  });
});
