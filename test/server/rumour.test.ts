import { describe, expect, it } from 'vitest';

import { STANDING_LEVEL, TOWNSFOLK } from '../../src/server/content/townsfolk.ts';
import { SITES } from '../../src/server/world/realms.ts';
import {
  ALDERBROOK_REGIONS,
  REDACTION_SITE_ID,
  makeOverworld,
  regionAt,
} from '../../src/shared/level.ts';
import { PLACE_BLURBS } from '../../src/server/content/places.ts';
import { MAX_CHARACTER_LEVEL } from '../../src/shared/progression.ts';
import { TopicId } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND LANDMASS WAS UNFINDABLE, AND THIS IS THE CHANNEL THAT FIXES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three commits built the Redaction — a whole second overworld, six delves, two
 * creatures nothing else in the game has. Then an audit of the client asked the
 * only question that mattered, *how does a player ever hear about this*, and
 * every channel turned out to be shut:
 *
 *   - the door is 99 tiles from the spawn and 14 from the nearest marker
 *   - world-map site markers are FOG-GATED, so it does not draw until you have
 *     already walked onto the cell
 *   - region captions need a fifth of the region walked
 *   - the bearing list carries the three nearest and the door is ninety-ninth
 *
 * The rumour topic is this game's existing answer to "content I have hidden" —
 * the three `hidden` sites are hinted through it and that mechanism works. So
 * the fix is content in a channel that already exists, gated so it cannot send
 * a beginner to their death.
 *
 * THESE ARE PROPERTIES, NOT A SCRIPT. None of them asserts a line of dialogue
 * word for word: the writing is meant to be rewritten, and a test that pins
 * prose makes the next edit look like a regression.
 */

/** Every townsfolk spec in the game, flattened. */
const EVERYONE = [...TOWNSFOLK.values()].flat();

describe('the rumour that leads somewhere', () => {
  it('is told by everybody, so it cannot be missed by meeting the wrong person', () => {
    /**
     * A DISCOVERY PATH THAT DEPENDS ON MEETING ONE SPECIFIC NPC IN ONE SPECIFIC
     * TOWN IS ANOTHER WAY TO BE UNFINDABLE. The five of them stand in five
     * different settlements and a player might reasonably only ever talk to
     * the one in the town they spawned beside.
     */
    expect(EVERYONE.length).toBeGreaterThanOrEqual(5);
    for (const person of EVERYONE) {
      expect(person.later?.[TopicId.Rumour], person.name).toBeDefined();
    }
  });

  it('says the same thing a different way for every person', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TEN PEOPLE, TEN VOICES — AND THIS ONLY COVERED HALF OF WHAT THEY SAY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The sexton buries people and the reeve files returns; if they said the
     * same sentence the towns would be one person wearing ten sprites, which is
     * the failure the whole table exists to avoid.
     *
     * IT CHECKED `later` AND NOT `topics`, AND THAT LET A DUPLICATE THROUGH.
     * Halloway Bell was added to Alderbrook and given *"A stair on the Grey
     * Downs, on no map I own"* — word for word what Carrow Ninefold had been
     * saying in the Wayfarers' Camp. Two people, one sentence, and nothing
     * noticed, because the only distinctness this file asserted was on the
     * OTHER tier.
     *
     * The same shape as `assertLinesFit` forgetting `later`: a guard that
     * covers one of two parallel tables is a guard with a hole in it, and the
     * hole is always in whichever half was added second.
     */
    const later = EVERYONE.map((person) => person.later?.[TopicId.Rumour] ?? '');
    expect(new Set(later).size, 'two people give the same directions west').toBe(later.length);

    const early = EVERYONE.map((person) => person.topics[TopicId.Rumour] ?? '');
    expect(new Set(early).size, 'two people tell the same rumour').toBe(early.length);

    // AND NOTHING ELSE THEY SAY IS SHARED EITHER. The greeting is the first
    // thing a player reads, and two identical ones in adjacent towns is the
    // cheapest possible way to look like a stub.
    const greetings = EVERYONE.map((person) => person.greetFirst);
    expect(new Set(greetings).size, 'two people introduce themselves the same way').toBe(
      greetings.length,
    );
  });

  it('names a place that is on the map and in the right direction', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE WHOLE FILE IS FOR: THE DIRECTIONS HAVE TO BE TRUE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A rumour is only a discovery path if acting on it works. Every line names
     * a REGION rather than a coordinate, because a region is a caption the
     * player will see drawn on the world map when they arrive — confirmation
     * they are in the right country. So the region has to exist, the door has
     * to be in it, and it has to actually be west of where they started.
     */
    const sedge = ALDERBROOK_REGIONS.find((r) => r.name.toLowerCase().includes('sedge'));
    expect(sedge, 'the rumours name a region that does not exist').toBeDefined();
    if (sedge === undefined) return;

    const base = makeOverworld();
    const door = [...base.sites].find(([, id]) => id === REDACTION_SITE_ID);
    expect(door).toBeDefined();
    if (door === undefined) return;
    const [xs, ys] = door[0].split(',');
    const x = Number(xs);
    const y = Number(ys);

    // THE DOOR IS IN THE COUNTRY THEY WERE SENT TO — asked of the map rather
    // than of a rectangle, because the redesigned moor draws its regions per
    // cell and `sedge` is now the label's anchor rather than its bounds.
    expect(regionAt(x, y), 'the crossing is not in the country the rumours name').toBe(sedge.name);

    // AND IT IS WEST, which is the one word every line uses.
    const spawn = base.spawns[0];
    if (spawn === undefined) throw new Error('no spawn');
    expect(x).toBeLessThan(spawn.x);
    for (const person of EVERYONE) {
      const line = (person.later?.[TopicId.Rumour] ?? '').toLowerCase();
      expect(line, person.name).toContain('west');
      expect(line, person.name).toContain(sedge.name.replace('the ', '').toLowerCase());
    }
  });

  it('is earned, and the gate is inside the range a character can reach', () => {
    /**
     * Telling a level-1 character to walk west is a trap — `redactedSpec` notes
     * that the floors over there are deliberately not softened for somebody who
     * wandered in, and the reason that is FAIR is that the walk is long. Handing
     * out directions removes the gate, so the directions are gated instead.
     *
     * ASSERTED AS A RANGE RATHER THAN AS 5. The number is a tuning decision; the
     * property is that it is above a beginner and reachable well before the cap,
     * so the content is not effectively locked behind finishing the game.
     */
    expect(STANDING_LEVEL).toBeGreaterThan(1);
    expect(STANDING_LEVEL).toBeLessThan(MAX_CHARACTER_LEVEL);
  });

  it('leaves the beginner with the rumours that point at reachable things', () => {
    // THE FIRST-TIER LINES ARE NOT FILLER. They hint the three `hidden` sites,
    // which are on this map, near, and appropriate — a beginner asking about
    // rumours still gets a real answer and a real destination.
    for (const person of EVERYONE) {
      const early = person.topics[TopicId.Rumour];
      expect(early, person.name).toBeDefined();
      expect(early).not.toBe(person.later?.[TopicId.Rumour]);
    }
  });

  it('points at every site the map does not draw, in the region it is in', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THREE ROOMS WERE UNFINDABLE, AND THE CASE FILE MADE THAT MATTER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `SiteDef.hidden` keeps a marker off the world map until the player's own
     * fog covers its cell, and `REVEAL_RADIUS` is 12. Measured: a player who
     * walks from the spawn to EVERY visible marker — 469 steps, 10,164 cells
     * revealed — uncovers none of the three. They sit 26, 41 and 44 tiles from
     * the nearest thing anybody is sent to.
     *
     * That was a deliberate reward for wandering, and it cost nothing while it
     * cost nothing. Then the case file started counting all seventeen rooms, so
     * two of them being unfindable means a counter that stops at 15 of 17 with
     * no way to learn what is missing.
     *
     * ═══ AND TWO OF THE FIVE RUMOURS NAMED THE WRONG COUNTRY ═══
     * Three said *"the downs"* — where exactly ONE of the three is. The other
     * two are in the Blackwater Wood and nothing named it. One line even said
     * *"the strand"*, and `the Long Strand` is a real region elsewhere on the
     * map, so it did not merely fail to help, it sent people to the wrong place.
     *
     * THE PROPERTY, not the prose: every hidden site must be named by some
     * rumour, by a region that actually contains it. The writing is meant to be
     * rewritten and this must survive that.
     */
    const base = makeOverworld();
    const said = EVERYONE.map((person) => (person.topics[TopicId.Rumour] ?? '').toLowerCase());
    expect(said.length).toBeGreaterThanOrEqual(5);

    const unpointed: string[] = [];
    for (const [cell, siteId] of base.sites) {
      if (SITES.get(siteId)?.hidden !== true) continue;
      const [xs, ys] = cell.split(',');
      const region = regionAt(Number(xs), Number(ys));
      // `the Grey Downs` -> `grey downs`, so a line may say "off the Grey Downs"
      // or "on the Grey Downs" and still count.
      const needle = region.replace(/^the /i, '').toLowerCase();
      if (!said.some((line) => line.includes(needle))) unpointed.push(`${siteId} (${region})`);
    }
    expect(unpointed, 'hidden rooms nobody is ever told how to find').toEqual([]);
  });

  it('gives the three nobody is told about something to say on arrival', () => {
    /**
     * Measured: twenty of twenty-three sites carried a blurb and the three
     * missing were EXACTLY the three hidden ones. The hardest discovery in the
     * game — a marker that appears because you walked somewhere nobody sent you
     * — arrived in silence, while every signposted town had a sentence ready.
     */
    const silent: string[] = [];
    for (const [id, def] of SITES) {
      if (def.hidden !== true) continue;
      if (PLACE_BLURBS.get(id) === undefined) silent.push(id);
    }
    expect(silent, 'a hidden site with nothing to say when you find it').toEqual([]);
  });

  it('is pointing at something that is actually there', () => {
    // THE DOOR IS A REGISTERED SITE and it opens onto a realm. A rumour aimed at
    // a marker that no longer exists is worse than no rumour, and this is the
    // assertion that fails if the Redaction is ever unwired.
    const def = SITES.get(REDACTION_SITE_ID);
    expect(def, 'the rumours point at a site that is not in the registry').toBeDefined();
    expect(def?.name).toBe('The Redaction');
  });
});
