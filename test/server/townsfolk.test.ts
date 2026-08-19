import { describe, expect, it } from 'vitest';

import { LINE_MAX, TOWNSFOLK, isTownsfolkId } from '../../src/server/content/townsfolk.ts';
import { Faction, isMonster } from '../../src/server/engine/actor.ts';
import { RealmKind, SITES, createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { ActorKind, TopicId, isWalkable } from '../../src/shared/protocol.ts';
import { DELVES, dangerWord } from '../../src/server/content/delve.ts';
import type { Realms } from '../../src/server/world/realms.ts';

const ROW = 'site:threadneedle_row';

function realms(seed: string): Realms {
  return createRealms({ seed, engineFor: (world) => createTurnEngine({ world }) });
}

function site(id: string) {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no site ${id}`);
  return def;
}

function folkIn(realm: ReturnType<Realms['open']>) {
  return realm.world
    .allActors()
    .filter((a) => a.kind === ActorKind.Monster && a.faction === Faction.Townsfolk);
}

describe('somebody lives here', () => {
  it('stands Merrow in Threadneedle Row', () => {
    const realm = realms('folk-1').open(site(ROW), 'party-a');
    const folk = folkIn(realm);
    /**
     * SHE IS THERE — not that she is ALONE. This asserted a headcount of one,
     * which was true when every town held a single person and became a lie the
     * moment a second voice was written for the busiest of them. A test that
     * pins the SIZE of the content fails on every addition while saying nothing
     * about whether the thing it names still works.
     */
    expect(folk.map((who) => who.name)).toContain('Merrow Stitch');
    for (const who of folk) expect(isTownsfolkId(who.id)).toBe(true);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BOTH CONSTRUCTION PATHS, BECAUSE THIS REPO HAS SHIPPED THIS BUG BEFORE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `realms.ts`'s own note on the `shop` field: *"IN `build` AND NOT IN THE BOOT
   * LOOP. There are TWO call sites — the eager pass that opens every shared realm
   * at startup, and `open`, which builds a Common realm lazily if it was never
   * opened. A shop wired into only the first would leave a town with no shelves
   * on the second path, and the only thing that would notice is a test supplying
   * its own sites."*
   *
   * That is this test. `createRealms` eagerly opens every shared realm, so
   * reading the registry exercises the boot path; calling `open` on a fresh
   * registry that was given no sites exercises the lazy one. A townsfolk wired
   * into only one would leave a town with nobody in it on the other, and nothing
   * in the toolchain would say so.
   */
  it('is there on the eager boot path as well as the lazy one', () => {
    const eager = realms('folk-boot');
    const fromRegistry = [...eager.all()].find((r) => r.siteId === ROW);
    expect(fromRegistry, 'the boot loop never built Threadneedle Row').toBeDefined();
    // THE SAME COUNT ON BOTH PATHS, whatever that count is. The bug this guards
    // is a town populated on one construction path and empty on the other, so
    // what matters is that the two AGREE and that neither is empty — not the
    // number, which is content and moves.
    const authored = TOWNSFOLK.get(ROW)?.length ?? 0;
    expect(authored).toBeGreaterThan(0);
    if (fromRegistry !== undefined) expect(folkIn(fromRegistry)).toHaveLength(authored);

    const lazy = realms('folk-lazy').open(site(ROW), 'party-b');
    expect(folkIn(lazy)).toHaveLength(authored);
  });

  it('stands on the same tile every boot, with no rng draw', () => {
    /**
     * A town's map is derived from the SITE seed so its streets are the same
     * every visit. Placing her with a draw would do two bad things at once: move
     * her between boots, so "she is by the north wall" stops being learnable —
     * and shift the seeded stream for everything that draws after her.
     *
     * Two DIFFERENT registry seeds, same tile: proof she is found rather than
     * rolled.
     */
    const a = folkIn(realms('seed-a').open(site(ROW), 'p'))[0];
    const b = folkIn(realms('seed-b').open(site(ROW), 'p'))[0];
    expect({ x: a?.x, y: a?.y }).toEqual({ x: b?.x, y: b?.y });
  });

  it('fits more than one person in a town, on separate ground', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A TOWN WITH ONE PERSON IN IT IS A ROOM WITH A SPRITE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Measured: every town is 34x30 with seven to eight hundred walkable tiles
     * and held exactly one person, and three of the five have no shop either.
     * Alderbrook — one step from the spawn, the room every player stands in
     * first and most — was 727 tiles containing a single sentence.
     *
     * `placeTownsfolk` already looped over its specs with a `taken` set, so the
     * capability was there and nothing had used it.
     *
     * ═══ AND THE FIRST VERSION OF THIS COMMENT MISATTRIBUTED THE GUARANTEE ═══
     * It said the no-stacking half guards `placeTownsfolk`'s `taken`
     * bookkeeping. It does not. Removing `taken.add` entirely and re-measuring:
     * the two still land on separate tiles, (15,23) and (15,22), because
     * `world.addMonster` will not put a body on an occupied cell. What `taken`
     * actually buys is SPREAD — with it they stand at (15,23) and (13,24), each
     * at its own counter rather than shoulder to shoulder.
     *
     * So what these two assertions really hold is worth stating plainly: every
     * authored person reaches the floor, and no two share a tile. The second is
     * guaranteed by the world rather than by this function, and it is still
     * worth asserting — two bodies on one tile is one body as far as a player
     * clicking on them is concerned, whichever layer would have to break.
     */
    const built = realms('two-in-a-town');
    const populated = built
      .all()
      .filter((realm) => realm.kind === RealmKind.Common)
      .map((realm) => ({
        realm,
        folk: [...realm.world.allActors()].filter((actor) => isTownsfolkId(actor.id)),
      }));

    // AT LEAST ONE TOWN HAS TWO, or this whole property is vacuous.
    const crowded = populated.filter((entry) => entry.folk.length > 1);
    expect(crowded.length, 'no town has more than one person in it').toBeGreaterThan(0);

    for (const { realm, folk } of populated) {
      // EVERY AUTHORED PERSON REACHED THE FLOOR. `findCounter` can decline a
      // cell, and a spec that quietly failed to place is content nobody can
      // reach — the failure this repo has shipped more than any other.
      const authored = TOWNSFOLK.get(realm.siteId ?? '')?.length ?? 0;
      expect(folk.length, `${String(realm.siteId)} lost somebody on the way in`).toBe(authored);

      // AND NOBODY IS STANDING ON ANYBODY.
      const tiles = new Set(folk.map((actor) => `${String(actor.x)},${String(actor.y)}`));
      expect(tiles.size, `${String(realm.siteId)} stacked two people on one tile`).toBe(
        folk.length,
      );
    }
  });

  it('stands on walkable ground, away from the door', () => {
    const realm = realms('folk-tile').open(site(ROW), 'p');
    const her = folkIn(realm)[0];
    expect(her).toBeDefined();
    if (her === undefined) return;

    const code = realm.world.level.tiles[her.y * realm.world.level.w + her.x];
    expect(code === undefined ? false : isWalkable(code)).toBe(true);

    // Not on top of the arrival tile: being body-checked by six people the
    // instant they cross is a poor first impression for the one friendly face in
    // the game.
    const arrival = realm.spawns[0];
    if (arrival !== undefined) {
      const away = Math.max(Math.abs(her.x - arrival.x), Math.abs(her.y - arrival.y));
      expect(away).toBeGreaterThanOrEqual(4);
    }
  });

  it('does not put the town into combat', () => {
    // THE PROPERTY THAT MAKES A SHARED TOWN SHAREABLE. `anyContact` asked `kind`
    // under a docblock reading "hostile pair", so one shopkeeper in line of sight
    // set engagement for every party standing there at once — permanently,
    // because she never leaves. See realms.test.ts.
    const realm = realms('folk-calm').open(site(ROW), 'p');
    const her = folkIn(realm)[0];
    expect(her).toBeDefined();
    if (her === undefined) return;

    const player = realm.world.addPlayer('p1', 'Ren');
    player.x = her.x;
    player.y = her.y + 1;

    /**
     * ═══ HER AGGRO RANGE IS RAISED ON PURPOSE, OR THIS TEST PROVES NOTHING ═══
     * She is authored at `aggroRange: 0`, so `chebyshev > aggroRange` skips her
     * before the faction is ever consulted — and this test passed with the
     * `areEnemies` fix stashed. That is a belt, not the braces: the moment
     * anybody authors a townsfolk who should NOTICE you (a guard, a crier), the
     * kind-based check comes straight back and takes every shared town with it.
     *
     * So the belt is removed here and the braces are what is measured.
     */
    // `isMonster` narrows the union — `folkIn` filters on `kind` at runtime but
    // returns `EngineActor`, and a player has no `ai`.
    if (isMonster(her)) her.ai.aggroRange = 8;

    realm.engine.join('p1');
    realm.engine.hold('p1');
    realm.engine.pump();

    // ENGAGEMENT IS THE WHOLE PROPERTY. `inCombat` is a projected view field,
    // not state on `TurnState` — engagement above zero is what `isBlocking`
    // reads and what puts a stranger's town into turn-by-turn.
    expect(realm.world.turn.engagement).toBe(0);
  });
});

describe('every line fits the Margin lane', () => {
  it(`holds each authored line to ${String(LINE_MAX)} characters`, () => {
    /**
     * The lane is ~32 glyphs wide with a three-row floor and renders as
     * `${speaker}: ${text}`, so "Merrow Stitch: " is already fifteen of the first
     * row. A 140-character line is five or six wrapped rows — the entire band
     * that `ui/caselog.ts` reserved so machine output could never bury human
     * speech, spent on one greeting, with the attribution scrolled away.
     *
     * `townsfolk.ts` throws at module load on a long line; this reports WHICH,
     * which is the difference between a failing boot and a fixable one.
     */
    const tooLong: string[] = [];
    for (const specs of TOWNSFOLK.values()) {
      for (const spec of specs) {
        for (const line of [spec.greetFirst, spec.greetAgain, ...spec.deflect]) {
          if (line.length > LINE_MAX) tooLong.push(`${spec.id}: ${String(line.length)} — ${line}`);
        }
      }
    }
    expect(tooLong).toEqual([]);
  });

  it('authors somebody for a Common site and nowhere else', () => {
    // A townsfolk in a delve would be a body that cannot be killed standing in a
    // room whose whole purpose is that everything in it can be.
    for (const siteId of TOWNSFOLK.keys()) {
      expect(SITES.get(siteId)?.kind, siteId).toBe(RealmKind.Common);
    }
  });
});

describe('what they tell you is still true', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ADVICE THAT IS WRONG ONCE IS ADVICE NOBODY READS AGAIN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THIS IS A REGRESSION TEST FOR A BUG I SHIPPED. Merrow's "where should I go"
   * line read *"Blackwood first. It is the one that lets you leave"* — written
   * when Blackwood was the gentlest room on the map and three steps from the
   * gate in difficulty terms. Re-keying the delve gradient by distance made
   * Blackwood the FURTHEST and WORST room in the game, and turned three helpful
   * sentences in three different towns into three ways to get a beginner killed.
   *
   * Nothing failed. Prose does not typecheck, and the one system that could have
   * noticed — the table that decides which room is which — has no idea anybody
   * is quoting it.
   *
   * So this reads the two together. It cannot check that a line is GOOD advice;
   * it can check that no townsperson sends a stranger to a room the map itself
   * grades `grim`, which is the specific way this broke and the specific way it
   * will break again the next time the gradient moves.
   */
  it('never sends a stranger to a room the map calls grim', () => {
    const grimWords = [...DELVES.entries()]
      .filter(([, spec]) => dangerWord(spec) === 'grim')
      .map(([siteId]) => SITES.get(siteId)?.name.split(' ')[0] ?? '')
      .filter((word) => word.length > 3);

    expect(grimWords.length, 'no grim delves — has the gradient gone flat?').toBeGreaterThan(0);

    for (const [siteId, specs] of TOWNSFOLK) {
      for (const spec of specs) {
        const advice = spec.topics[TopicId.Where];
        if (advice === undefined) continue;
        for (const word of grimWords) {
          expect(advice.includes(word), `${siteId} sends people to ${word}: "${advice}"`).toBe(
            false,
          );
        }
      }
    }
  });

  it('has somebody in every town, because a partly-lived-in world reads as empty', () => {
    /**
     * The note on this table already made the argument for one town becoming
     * three: *"A single populated settlement makes the other four read as
     * deserted rather than as quiet."* The same sentence applies at three of
     * five, and hardest to the two that were left: Saint's Rest is the first
     * settlement past the range after the longest walk in the game, and the
     * Wayfarers' Camp is the only thing in the western downs at all.
     */
    const towns = [...SITES.entries()].filter(([, def]) => def.kind === RealmKind.Common);
    expect(towns.length).toBeGreaterThan(3);
    for (const [siteId] of towns) {
      expect(TOWNSFOLK.get(siteId)?.length ?? 0, `${siteId} is deserted`).toBeGreaterThan(0);
    }
  });

  it('gives everybody every topic, so no row is a dead button', () => {
    // A menu row that answers with a fallback greeting is a row the player
    // learns to stop pressing, and one silent person teaches that about all of
    // them. `verbs.ts` builds the rows from `TOPIC_LABEL`, so a topic added
    // there appears on every townsperson whether or not they have a line.
    for (const [siteId, specs] of TOWNSFOLK) {
      for (const spec of specs) {
        for (const topic of Object.values(TopicId)) {
          expect(spec.topics[topic], `${siteId}/${spec.id} has nothing for ${topic}`).toBeDefined();
        }
      }
    }
  });
});
