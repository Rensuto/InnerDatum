/**
 * The map at both sizes: the window, the fog, and the two things that must not
 * leak through it.
 */

import { describe, expect, it } from 'vitest';

import {
  MINIMAP_RADIUS,
  doorwayAt,
  doorwayLine,
  minimapRect,
  partyMarks,
} from '../../src/client/ui/mapview.ts';
import type { SiteView } from '../../src/shared/protocol.ts';

describe('where your party is on the map you plan on', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE MAP DREW THE COUNTRY, THE DOORS, THE FOG AND YOU — AND NOBODY ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * MEASURED against what the server already sends: the world map draws terrain,
   * `seen` fog, all seventeen sites with their danger grade, filed state and
   * crossing mark, the twelve region names, and a mark for `self`. In a game
   * whose design is three to six friends in a voice channel it drew nothing for
   * the other five.
   *
   * The party PANE answers *"who am I with and are they upright"*. It cannot
   * answer *"where"*, and for somebody on the same map that is the question —
   * a place name is a name until the map turns it into a direction.
   *
   * NO PROTOCOL CHANGE: `projectWorld` sends every body in the realm unfiltered,
   * so the client already held the tiles. `party_state` says WHO, `actors` says
   * WHERE, and `partyMarks` is where they meet.
   */
  const bodies = new Map([
    ['a', { x: 10, y: 20 }],
    ['b', { x: 30, y: 40 }],
  ]);
  const member = (id: string, name: string, isSelf = false) => ({ id, name, isSelf });

  it('marks a party member standing on this map', () => {
    expect(partyMarks([member('b', 'Sam')], bodies, true)).toEqual([{ x: 30, y: 40, name: 'Sam' }]);
  });

  it('never marks you twice', () => {
    /**
     * `self` is drawn separately, larger and on top. A second mark underneath it
     * is a party member who does not exist, and the player goes looking.
     */
    expect(partyMarks([member('a', 'Ren', true)], bodies, true)).toEqual([]);
  });

  it('draws nobody at all when the viewer is not standing on this map', () => {
    /**
     * THE ONE THAT WOULD HAVE BEEN A CONFIDENT LIE. The world map is always the
     * OVERWORLD's, even while you stand in a delve — and a body inside an
     * instance carries INSTANCE coordinates. Painting those would put a friend's
     * delve position on the world map, which is worse than drawing nothing.
     */
    expect(partyMarks([member('b', 'Sam')], bodies, false)).toEqual([]);
  });

  it('leaves out a member with no body on this map rather than guessing', () => {
    /**
     * They are in an instance, or a realm this client has no frame for. Absent
     * is honest; the party pane answers for them by name, because it is the
     * surface that knows about realms.
     */
    expect(partyMarks([member('gone', 'Mo')], bodies, true)).toEqual([]);
    // ...and the ones who ARE here still come through, so an absent member does
    // not take the rest of the party with it.
    expect(partyMarks([member('gone', 'Mo'), member('b', 'Sam')], bodies, true)).toHaveLength(1);
  });
});

describe('the minimap is a window, not the whole world', () => {
  it('is square and sized from the radius rather than from the level', () => {
    // A minimap that showed all of a 170x100 region would be a postage stamp of
    // a continent: every cell under a pixel, the player a dot among dots, and
    // no answer to the only question it is asked — what is just off the edge of
    // my screen. So its size depends on the RADIUS and not on the map, which is
    // also what stops it changing shape when you walk into a 24x24 arena.
    const wide = minimapRect(1280);
    const narrow = minimapRect(800);
    expect(wide.w).toBe(wide.h);
    expect(wide.w).toBe(narrow.w);
    expect(wide.h).toBe(narrow.h);
  });

  it('sits in the top-right corner, whatever the width', () => {
    for (const width of [640, 900, 1280, 1920]) {
      const r = minimapRect(width);
      expect(r.y).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThan(width);
      // Hard against the right edge, allowing only the margin.
      expect(width - (r.x + r.w)).toBeLessThan(16);
    }
  });

  it('reaches further than the viewport, which is the whole point', () => {
    // "A slightly bigger area than the player can currently see." The viewport
    // is at most 48x32 tiles and usually nearer 20x11, so a radius of 16 shows
    // the screen plus a margin of what is about to matter. A minimap showing
    // exactly what is already on screen would be decoration.
    expect(MINIMAP_RADIUS * 2 + 1).toBeGreaterThan(20);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR YOU ARE STANDING NEXT TO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The board never said what a place IS. Every answer the game has lives
 * somewhere else — spoken on arrival and scrolled away, on the world map behind
 * a key, or in a warning that fires once you are already inside — and none of
 * them is on screen at the moment a player is beside a door deciding whether to
 * open it.
 */
const ALDERBROOK: SiteView = { x: 10, y: 10, marker: 'city', name: 'Alderbrook' };
const CHAPEL: SiteView = {
  x: 10,
  y: 12,
  marker: 'breach',
  name: 'The Drowned Chapel',
  danger: 'dangerous',
};

describe('doorwayAt', () => {
  it('names the place you are standing beside', () => {
    expect(doorwayAt([ALDERBROOK], { x: 11, y: 11 })?.name).toBe('Alderbrook');
  });

  it('says nothing about a door two tiles off', () => {
    // Adjacent is the whole point: this is a prompt about a step you can take
    // now, not a directory of the county.
    expect(doorwayAt([ALDERBROOK], { x: 12, y: 10 })).toBeUndefined();
  });

  it('says nothing while you are standing ON it', () => {
    // Stepping onto a site cell IS the door, so a body on one has just come
    // out. "Step in" there reads as an instruction to leave and come back.
    expect(doorwayAt([ALDERBROOK], { x: 10, y: 10 })).toBeUndefined();
  });

  it('never calls a roamer a door', () => {
    // A wandering danger carries `sprite` and stepping onto it starts a fight.
    // Labelling that "step in" would invite exactly the wrong act.
    const roamer: SiteView = { ...ALDERBROOK, sprite: 'mon_husk', name: 'something moving' };
    expect(doorwayAt([roamer], { x: 11, y: 11 })).toBeUndefined();
  });

  it('picks the same one of two corners every frame', () => {
    // Ordered by position, not by the order the server happened to send, or the
    // line flickers between two names while the player stands still.
    const a = doorwayAt([ALDERBROOK, CHAPEL], { x: 11, y: 11 });
    const b = doorwayAt([CHAPEL, ALDERBROOK], { x: 11, y: 11 });
    expect(a?.name).toBe(b?.name);
  });

  it('is quiet before a body is on the map', () => {
    expect(doorwayAt([ALDERBROOK], null)).toBeUndefined();
  });
});

describe('doorwayLine', () => {
  it('carries the grade when there is one', () => {
    expect(doorwayLine(CHAPEL)).toBe('The Drowned Chapel — dangerous · step in');
  });

  it('invents no grade for a town', () => {
    // A "quiet" beside every settlement would train a player to stop reading
    // the word — the same argument `nearestSites` makes.
    expect(doorwayLine(ALDERBROOK)).toBe('Alderbrook — step in');
  });
});
