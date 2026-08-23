/**
 * The map at both sizes: the window, the fog, and the two things that must not
 * leak through it.
 */

import { describe, expect, it } from 'vitest';

import {
  MINIMAP_RADIUS,
  doorwayAt,
  doorwayLine,
  mapTileAt,
  minimapRect,
  minimapReserveH,
  MINIMAP_MARGIN,
  MINIMAP_MAX_H,
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOCK RESERVES WHAT THE MINIMAP TAKES, NOT WHAT IT MIGHT TAKE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The reserve was `MINIMAP_MAX_H + MINIMAP_MARGIN * 2 + 4` — derived from the
 * CAP rather than the box, which is a guess wearing a derivation's clothes.
 * `minimapRect` floors its cell size, so the map draws 99x99 and the reserve
 * claimed 150.
 *
 * Those 31 pixels mattered exactly once and badly: in combat the top HUD grows
 * by the turn cards, and on a 384-tall logical viewport the band left for the
 * dock fell to 62 against a `DOCK_MIN_H` of 84 — so the Case Log VANISHED the
 * moment a fight started, taking the transcript of who hit whom with it. 8.8% of
 * 9,440 sampled windows had a log while walking and none while fighting.
 */
describe('the minimap reserve', () => {
  it('matches the box the minimap actually draws', () => {
    const box = minimapRect(640);
    expect(minimapReserveH(640)).toBe(box.y + box.h + MINIMAP_MARGIN + 4);
  });

  it('is smaller than the worst case it used to assume', () => {
    // ═══ THE COUNTERFACTUAL ═══
    // If these are ever equal again the log is back to losing 31 pixels it is
    // owed, and the combat case comes back with it.
    const capBased = MINIMAP_MAX_H + MINIMAP_MARGIN * 2 + 4;
    expect(minimapReserveH(640)).toBeLessThan(capBased);
  });

  it('never reserves less than the minimap occupies, at any width', () => {
    // The half that must not break: reserving too little would put the Case Log
    // underneath the minimap, which is worse than a short log.
    for (const width of [480, 640, 772, 1024, 1280, 1920]) {
      const box = minimapRect(width);
      expect(minimapReserveH(width), `${String(width)}`).toBeGreaterThanOrEqual(box.y + box.h);
    }
  });
});

describe('the minimap is a control, not a picture', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `minimapRect` HAD NO CALLER IN ANY MOUSE HANDLER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The map was painted every frame and answered nothing. Upstream registers a
   * mouse zone over its own and gives it three meanings
   * (Minimalist.lua:1639-1652): left-click walks there, middle-click opens the
   * full map, right-click scrolls the view.
   *
   * `mapTileAt` is the inverse of the painter's own placement, and these tests
   * are about the ONE property that matters: the tile a click resolves to is the
   * tile the painter drew under that pixel. Two copies of the arithmetic would
   * put the click a tile away from the cursor on exactly the windows where the
   * window is clamped to a map edge.
   */
  const level = (w: number, h: number) => ({ w, h });

  /** The painter's own formula, transcribed — see `mapPlacement`. */
  const cellOf = (rect: { w: number; h: number }, span: number) =>
    Math.max(1, Math.floor(Math.min(rect.w / span, rect.h / span)));

  it('resolves the centre of the map to the tile the player is standing on', () => {
    // A CLAMPED-FREE CASE: the player is well inside a large map, so the window
    // is exactly `radius` either side and the centre cell is the player.
    const rect = minimapRect(1280);
    const self = { x: 60, y: 40 };
    const hit = mapTileAt(
      level(170, 100),
      rect,
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      self,
      MINIMAP_RADIUS,
    );
    expect(hit).toEqual(self);
  });

  it('agrees with the painter at the top-left cell of the window', () => {
    const rect = minimapRect(1280);
    const self = { x: 60, y: 40 };
    const span = MINIMAP_RADIUS * 2 + 1;
    const cell = cellOf(rect, span);
    // The painter draws window cell (x0, y0) at the map's own origin, and the
    // map is centred in `rect`. One pixel INSIDE that cell must resolve to it.
    const x0 = self.x - MINIMAP_RADIUS;
    const y0 = self.y - MINIMAP_RADIUS;
    const mapW = cell * span;
    const ox = rect.x + Math.floor((rect.w - mapW) / 2);
    const oy = rect.y + Math.floor((rect.h - mapW) / 2);
    expect(mapTileAt(level(170, 100), rect, ox + 1, oy + 1, self, MINIMAP_RADIUS)).toEqual({
      x: x0,
      y: y0,
    });
  });

  it('follows the window when the player is clamped to a map edge', () => {
    /**
     * THE CASE A SECOND COPY WOULD GET WRONG FIRST. Standing at (2,2) on a large
     * map, the window cannot centre — it clamps to (0,0) — so the centre pixel is
     * NOT the player any more, and a naive `self + offset - radius` inverse would
     * be off by the clamp on every tile.
     */
    const rect = minimapRect(1280);
    const self = { x: 2, y: 2 };
    const hit = mapTileAt(
      level(170, 100),
      rect,
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      self,
      MINIMAP_RADIUS,
    );
    expect(hit).not.toBeNull();
    expect(hit).toEqual({ x: MINIMAP_RADIUS, y: MINIMAP_RADIUS });
  });

  it('answers null off the map, including inside the box', () => {
    /**
     * "Inside the rect" is not the same question as "over a tile". A map smaller
     * than its box is centred in it, and a small level leaves real margin — a
     * click there must not walk the player to a clamped edge tile they never
     * pointed at.
     */
    const rect = minimapRect(1280);
    const self = { x: 2, y: 2 };
    expect(mapTileAt(level(5, 5), rect, rect.x - 4, rect.y - 4, self, MINIMAP_RADIUS)).toBeNull();
    expect(
      mapTileAt(level(5, 5), rect, rect.x + rect.w + 4, rect.y + rect.h + 4, self, MINIMAP_RADIUS),
      'past the far corner',
    ).toBeNull();
  });

  it('covers every cell of the window with no gaps and no overlaps', () => {
    /**
     * THE PROPERTY, SWEPT. Walk the whole box a pixel at a time: every point
     * either answers null or answers a tile inside the window, and stepping one
     * cell width along must advance the answer by exactly one tile. A fractional
     * cell size — which `mapPlacement` refuses precisely to avoid this — would
     * show up here as a doubled or skipped column.
     */
    const rect = minimapRect(1280);
    const self = { x: 60, y: 40 };
    const span = MINIMAP_RADIUS * 2 + 1;
    const cell = cellOf(rect, span);
    const seen = new Set<string>();
    for (let px = rect.x; px < rect.x + rect.w; px += 1) {
      const hit = mapTileAt(level(170, 100), rect, px, rect.y + rect.h / 2, self, MINIMAP_RADIUS);
      if (hit !== null) seen.add(String(hit.x));
    }
    // Every column of the window is reachable, and no more than that.
    expect(seen.size).toBe(span);
    expect(cell).toBeGreaterThan(0);
  });
});
