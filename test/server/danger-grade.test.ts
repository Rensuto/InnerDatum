import { describe, expect, it } from 'vitest';

import { dangerWord, partyHint, specFor } from '../../src/server/content/delve.ts';
import { MONSTER_TEMPLATES } from '../../src/server/content/monsters.ts';
import { TOWNSFOLK } from '../../src/server/content/townsfolk.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { ActorRank, TopicId } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE SENTENCE THE MAP SAYS ABOUT A ROOM BEFORE YOU WALK INTO IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dangerWord` is the whole of this game's pre-commitment information. It is
 * printed beside every marker on the world map, it colours the dot, and
 * `partyHint` turns the top of it into *"bring a party"* — which is the only
 * mechanism this game has for telling three to six friends that a fight needs
 * all of them.
 *
 * Its own header records what happens when it lies: a first version called the
 * Watcher's Altar *"quiet"* and the note says *"a hint that lies is a hint a
 * player stops reading"*. These are the assertions that keep it honest as the
 * content grows past what it was written for.
 */

describe('the grade sees what is actually in the room', () => {
  it('asks by property, not by name', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE OLD VERSION NAMED TWO TEMPLATES AND WENT BLIND AS THE ROSTER GREW.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `roster.includes(INDEX_HUSK_ELITE)` and `roster.includes(INDEX_WRAITH)`
     * was a complete question when the bestiary was three creatures. It is nine
     * now, and by name the grade could not see the eidolon, the cairn, the glut,
     * the Inspector or the Inquisitor — five of nine, including both of the
     * Redaction's elites and the only other creature that shoots.
     *
     * ASSERTED AS A PROPERTY OF THE ROSTER rather than by re-running the old
     * formula: any room whose roster can produce an elite must grade above the
     * same room without one. That is what the +3 meant, and it now holds for
     * every elite rather than for one named template.
     */
    const graded = [...SITES.keys()].flatMap((id) => {
      const spec = specFor(id);
      return spec === undefined ? [] : [{ id, spec }];
    });
    expect(graded.length).toBeGreaterThan(10);

    for (const { id, spec } of graded) {
      const hasElite = spec.roster.some((t) => t.rank !== ActorRank.Normal);
      const hasRanged = spec.roster.some((t) => t.projSpeed !== undefined);
      const plain = dangerWord({ ...spec, roster: [MONSTER_TEMPLATES[0]!], boss: undefined });
      if (hasElite || hasRanged) {
        // A ROOM THAT CAN PRODUCE ONE IS NEVER GRADED BELOW THE SAME ROOM THAT
        // CANNOT. Stated as an ordering rather than a number so retuning the
        // bands does not have to come back here.
        const order = ['quiet', 'restless', 'dangerous', 'grim'];
        expect(order.indexOf(dangerWord(spec)), id).toBeGreaterThanOrEqual(order.indexOf(plain));
      }
    }
  });

  it('grades the boss room above every other room in the game', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `DelveSpec.boss` LANDED AND THIS FUNCTION WAS NEVER TOLD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * So the one room holding two hundred and twenty hit points of artillery
     * graded `dangerous` — the same word as five other rooms, including its own
     * ordinary twin on the other map — and `partyHint` stayed silent for the one
     * fight in the game that actually needs a party.
     */
    const bossRooms = [...SITES.keys()].filter((id) => specFor(id)?.boss !== undefined);
    expect(bossRooms).toHaveLength(1);

    for (const id of bossRooms) {
      const spec = specFor(id);
      if (spec === undefined) continue;
      expect(dangerWord(spec), id).toBe('grim');
      // AND THE HINT IS THE POINT. `grim` is the only grade that says it.
      expect(partyHint(spec), id).toBe('bring a party');
    }
  });

  it('says so whatever else is in the room', () => {
    // THE BOSS TERM DECIDES ON ITS OWN. What makes that room hard is not its
    // population, so a boss dropped into the emptiest spec in the game must
    // still grade `grim` — otherwise the warning depends on a headcount that
    // has nothing to do with the reason for it.
    const gentlest = specFor('site:drowned_chapel');
    expect(gentlest).toBeDefined();
    if (gentlest === undefined) return;
    expect(dangerWord(gentlest)).toBe('quiet');

    const watcher = MONSTER_TEMPLATES.find((t) => t.rank === ActorRank.Boss);
    expect(watcher).toBeDefined();
    if (watcher === undefined) return;
    expect(dangerWord({ ...gentlest, boss: watcher })).toBe('grim');
  });
});

describe('the grade and the townsfolk agree', () => {
  it('leaves the chapel quiet, because Merrow says it is', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO SURFACES, ONE FACT — AND A REFACTOR NEARLY BROKE IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A per-entry weighting was tried while generalising this function and it
     * moved three rooms, including the Drowned Chapel from `quiet` to
     * `restless`. That room is seventeen steps out and the first marker most
     * players ever walk to, and Merrow Stitch's own directions call it *"close
     * and it is quiet"*. The map and the person giving you directions must not
     * disagree, and fixing a rounding error is not worth making them.
     *
     * The presence-based version was kept instead, and this is the assertion
     * that ties the two together so the next attempt has to notice.
     */
    const chapel = specFor('site:drowned_chapel');
    expect(chapel).toBeDefined();
    if (chapel === undefined) return;
    const grade = dangerWord(chapel);

    const said = [...TOWNSFOLK.values()]
      .flat()
      .map((person) => person.topics[TopicId.Where] ?? '')
      .filter((line) => line.toLowerCase().includes('chapel'));
    expect(said.length, 'nobody points a newcomer at the chapel any more').toBeGreaterThan(0);

    const promisesQuiet = said.some((line) => line.toLowerCase().includes(grade));
    expect(
      promisesQuiet,
      `the chapel grades "${grade}" and the directions to it say something else: ${said.join(' | ')}`,
    ).toBe(true);
  });
});
