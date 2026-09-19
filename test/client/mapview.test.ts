/**
 * The map at both sizes: the window, the fog, and the two things that must not
 * leak through it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MINIMAP_FLOOR,
  MINIMAP_MAX_CELL,
  MINIMAP_MIN_CELL,
  MINIMAP_RADIUS,
  MINIMAP_SPAN,
  doorwayAt,
  doorwayLine,
  fitZoneLabel,
  mapTileAt,
  minimapBoxSize,
  minimapCard,
  minimapCellFor,
  minimapRect,
  minimapReserveH,
  MINIMAP_MARGIN,
  MINIMAP_MAX_H,
  partyMarks,
  zoneLabelBaseline,
} from '../../src/client/ui/mapview.ts';
import {
  GripCorner,
  NO_OFFSET,
  moveIntoBand,
  nextSize,
  settleOffset,
  sizeIntoBand,
} from '../../src/client/ui/drag.ts';
import { logGripRect } from '../../src/client/ui/caselog.ts';
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
 * Those 31 pixels mattered exactly once and badly: in combat the top HUD grew
 * by a strip of turn cards (since deleted), and on a 384-tall logical viewport
 * the band left for the
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

// ---------------------------------------------------------------------------
// THE ZONE LABEL — Game.lua:1497-1507, uiset/Classic.lua:303-308
// ---------------------------------------------------------------------------

describe('the name of the place you are standing in', () => {
  // A monospace stand-in: every glyph six wide. Real metrics come from the
  // canvas, and the rule under test is about WIDTH, not about a font.
  const measure = (text: string): number => text.length * 6;

  it('leaves a name that fits completely alone', () => {
    expect(fitZoneLabel(measure, 'Alderbrook', 200)).toBe('Alderbrook');
    // Exactly the available width is a fit, not an overflow.
    expect(fitZoneLabel(measure, 'Alderbrook', 60)).toBe('Alderbrook');
  });

  it('cuts a long name rather than letting it run the width of the screen', () => {
    /**
     * The label is right-aligned to the minimap and runs LEFT across empty
     * screen. The cut was for the turn card strip, which appeared across that
     * top-left the moment a fight started; the strip is deleted and the cut
     * stays, because a label with nothing to stop it ends up across the middle
     * of the map.
     */
    const said = fitZoneLabel(measure, 'The Drowned Chapel of Saint Alder', 60);
    expect(measure(said)).toBeLessThanOrEqual(60);
    expect(said.endsWith('…'), `did not mark the cut: ${said}`).toBe(true);
    expect(said.startsWith('The Drow'), `cut from the wrong end: ${said}`).toBe(true);
  });

  it('says nothing at all rather than a bare ellipsis', () => {
    /**
     * Below the width of one ellipsis there is no honest shortening left. A "…"
     * on its own beside the minimap reads as a rendering fault rather than as a
     * place, which is worse than the silence it replaced.
     */
    expect(fitZoneLabel(measure, 'Alderbrook', 5)).toBe('');
    expect(fitZoneLabel(measure, 'Alderbrook', 0)).toBe('');
    expect(fitZoneLabel(measure, 'Alderbrook', -10)).toBe('');
    /**
     * AND THE WIDTH THAT FITS THE ELLIPSIS AND NOTHING ELSE — the case the two
     * above cannot reach, because they fail the cheap "is there room for a `…`
     * at all" check before the shortening loop is entered. At exactly one
     * ellipsis wide the loop runs, eats the whole name, and the question is
     * what it does with what is left.
     */
    expect(fitZoneLabel(measure, 'Alderbrook', measure('…'))).toBe('');
  });

  it('stays inside the space the minimap reserve already holds', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THAT MATTERS, AND IT IS ABOUT A DIFFERENT PANEL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `minimapReserveH`'s own docblock records the Case Log VANISHING the
     * instant a fight began, because the reserve was thirty-one pixels greedier
     * than the box it was reserving for; the repair left about nine to spare.
     * A label that grew the reserve would have spent that and put the
     * transcript of who hit whom back on the edge of disappearing — to make
     * room for a line saying where it happened.
     *
     * So the baseline has to sit inside the reserve, and this is what notices
     * if somebody moves it out.
     */
    for (const width of [320, 480, 640, 960, 1280]) {
      const box = minimapRect(width);
      const baseline = zoneLabelBaseline(box);
      expect(baseline, `label above the minimap at ${String(width)}`).toBeGreaterThan(
        box.y + box.h,
      );
      expect(baseline, `label past the reserve at ${String(width)}`).toBeLessThanOrEqual(
        minimapReserveH(width),
      );
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR LAYER, AS SOURCE TEXT — `Map.lua:493-506`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `paintMap` paints with `fillRect`, and `test/client/canvasstub.ts` records
 * only `drawImage` — so every fill in this file is invisible to a stub-driven
 * test. `zonewash.test.ts` hit the same wall and says so at length. What CAN be
 * checked is the SHAPE of the painter, and the three rules below are the ones
 * that are wrong in ways nobody would notice from a screenshot.
 */
describe('what is on the floor, on the map', () => {
  const SOURCE = readFileSync(new URL('../../src/client/ui/mapview.ts', import.meta.url), 'utf8');

  it('carries upstream’s own two minimap colours', () => {
    // `mo:minimap(240, 240, 0)` on Trap and `mo:minimap(0, 0, 240)` on Object.
    // At one pixel a cell the colour IS the message, and these two are already
    // as far apart as two colours get — re-choosing them would throw that away.
    expect(SOURCE).toContain("const TRAP_INK = '#f0f000'");
    expect(SOURCE).toContain("const LOOT_INK = '#0000f0'");
  });

  it('draws the floor UNDER the places and OVER the ground', () => {
    /**
     * Upstream's layer order is terrain (1), trap (4), object (7), actor (10).
     * A site is a destination and a piece of loot is a detour; a map that let
     * the detour cover the destination would be answering the wrong question.
     *
     * Asserted by position, because the two loops are twenty lines apart and
     * nothing else in the file would fail if they swapped.
     */
    const terrain = SOURCE.indexOf('miniFill(code as TileCode)');
    const floor = SOURCE.indexOf('floorMark(loot, LOOT_INK)');
    const sites = SOURCE.indexOf('for (const site of sites)');
    expect(terrain).toBeGreaterThan(-1);
    expect(floor, 'the floor layer is gone').toBeGreaterThan(terrain);
    expect(floor, 'loot and traps are drawn over the site dots').toBeLessThan(sites);
  });

  it('draws a trap OVER a pile, which is where it departs from upstream', () => {
    /**
     * Upstream draws the object layer over the trap (7 over 4) — right when each
     * has its own sprite. With one flat cell each, the one you MUST NOT STEP ON
     * is the one that has to survive the overlap.
     *
     * The order of these two calls is the whole rule, and it is the sort of
     * thing a tidying pass would reverse without noticing.
     */
    const loot = SOURCE.indexOf('floorMark(loot, LOOT_INK)');
    const traps = SOURCE.indexOf('floorMark(traps, TRAP_INK)');
    expect(traps, 'a pile now hides the trap under it').toBeGreaterThan(loot);
  });

  it('carries upstream’s actor colours, with the boss branch first', () => {
    /**
     * `tome/class/Actor.lua:874-878`. The rank branch `return`s BEFORE the
     * reaction is computed, so a boss is magenta whatever its side — and on a
     * one-pixel cell that is the right priority: "something here will kill you"
     * is a louder fact than whose side it is on.
     */
    expect(SOURCE).toContain("const BOSS_INK = '#c000af'");
    expect(SOURCE).toContain("const HOSTILE_INK = '#f00000'");
    const pick = SOURCE.indexOf('mark.boss ? BOSS_INK');
    expect(pick, 'the boss no longer outranks its reaction').toBeGreaterThan(-1);
  });

  it('draws bodies OVER the floor, which is upstream’s layer order', () => {
    // terrain (1), trap (4), object (7), actor (10) — `Map.lua:490-521`. A thing
    // walking towards you outranks a thing lying still.
    const floor = SOURCE.indexOf('floorMark(traps, TRAP_INK)');
    const bodies = SOURCE.indexOf('for (const mark of actors)');
    expect(bodies, 'the actor layer is gone').toBeGreaterThan(floor);
  });

  it('still honours the fog for both lists', () => {
    /**
     * Both lists are already per-viewer, but a remembered tile can leave `seen`
     * when a realm changes under a stale frame, and a mark floating on unseen
     * ground reads as a bug rather than as loot.
     *
     * ═══ ASSERTED ON THE EXPRESSION, NOT ON THE WORD ═══
     * The first version looked for `seen` in this slice and PASSED with the
     * check deleted, because the docblock inside `floorMark` argues about the
     * fog in prose. `zonewash.test.ts` records the identical trap — a source
     * window that swallows the comment is a window that tests the comment.
     * `seen.has(` appears only in code.
     */
    const body = SOURCE.slice(
      SOURCE.indexOf('const floorMark ='),
      SOURCE.indexOf('floorMark(loot, LOOT_INK)'),
    );
    expect(body, 'the floor layer ignores the fog').toContain('seen.has(');
  });
});

// ---------------------------------------------------------------------------
// THE MINIMAP MOVES AND RESIZES
// ---------------------------------------------------------------------------

describe('the minimap is furniture the player owns', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * *"the minimap ui should also be draggable and resizable like the other UIs.
   * the goal is to have the player customize their UI/HUD to their liking."*
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream's is both: `Minimalist.lua:307` gives it a move handle, `:378` a
   * place with a scale, `:1634-1635` routes a press on that handle into
   * `uiMoveResize`, and `:590` bounds the scale to `0.5 .. 2`.
   *
   * `minimapRect(width, size, band)` is the box before anybody drags it — the
   * size already settled against the band so the MOVE never has to touch it —
   * and `moveIntoBand` is the slide. Those are the two calls main.ts makes and
   * the two this block drives, against `mapTileAt`: the join, not the halves.
   */
  const band = { top: MINIMAP_MARGIN, bottom: 320 - 72 - 3 };
  const W = 1262;
  /** The unmoved box, exactly as `unmovedPanelRect` builds it. */
  const base = (size: { w: number; h: number } | null = null, own = band, width = W) =>
    minimapRect(width, size, own);
  /**
   * THE TWO CALLS main.ts MAKES, IN THE ORDER IT MAKES THEM.
   *
   * `unmovedPanelRect` builds the box from `minimapRect(width, size, band)` and
   * `movePanel` — which has NO minimap branch — slides it with `moveIntoBand`.
   * `hudwiring.test.ts` is what pins that main.ts still composes these two;
   * this is what says the composition is right.
   */
  const placed = (
    size: { w: number; h: number } | null,
    offset: { dx: number; dy: number },
    own = band,
    width = W,
  ) => moveIntoBand(minimapRect(width, size, own), offset, own, width);

  it('comes at the size it always came at, and nothing about that moved', () => {
    // A REGRESSION PIN. The box is derived from a clamp now; the default must
    // still be the 99x99 at the top-right margin that shipped.
    expect(minimapRect(W)).toEqual({ x: W - 99 - MINIMAP_MARGIN, y: MINIMAP_MARGIN, w: 99, h: 99 });
    expect(minimapCellFor(null)).toBe(3);
  });

  /**
   * ═══ THE BOX IS SQUARE AND IS A WHOLE NUMBER OF CELLS, AT EVERY SIZE ═══
   * `mapPlacement` letterboxes a map that does not fill its rect, so a box that
   * is not an exact multiple of the cell draws a dead border inside its own
   * frame. Snapping is what makes the frame the map's edge.
   */
  it('is always square and always a whole number of cells', () => {
    for (const w of [0, 12, 40, 66, 70, 99, 130, 132, 180, 198, 260, 4000]) {
      for (const h of [0, 40, 66, 99, 132, 198, 4000]) {
        const box = placed({ w, h }, NO_OFFSET);
        expect(box.w, `${String(w)}x${String(h)} is not square`).toBe(box.h);
        expect(box.w % MINIMAP_SPAN, `${String(w)}x${String(h)} letterboxes`).toBe(0);
      }
    }
  });

  /**
   * ═══ UPSTREAM'S OWN BOUND — `util.bound(scale, 0.5, 2)`, Minimalist.lua:590 ═══
   * The default is three pixels a cell, so the ceiling is six. The floor is two
   * rather than upstream's 1.5 because cells are whole pixels here and a
   * one-pixel cell draws the player, a boss, a friendly and a dropped coat as
   * four single pixels.
   */
  it('cannot be made useless, and cannot be made into a second map view', () => {
    expect(minimapCellFor({ w: 1, h: 1 })).toBe(MINIMAP_MIN_CELL);
    expect(minimapCellFor({ w: 10_000, h: 10_000 })).toBe(MINIMAP_MAX_CELL);
    expect(MINIMAP_MAX_CELL).toBe(minimapCellFor(null) * 2);
    // AND THE CEILING IS REACHABLE: a grip dragged to the corner of a big
    // window gets the whole of upstream's range, not a band-clipped part of it.
    const big = placed({ w: 4000, h: 4000 }, NO_OFFSET, { top: 8, bottom: 700 }, 1920);
    expect(big.w).toBe(MINIMAP_MAX_CELL * MINIMAP_SPAN);
  });

  /**
   * ═══ THE FLOOR IS THIS BOX'S OWN, NOT THE SHARED 160x72 ═══
   * `DEFAULT_PANEL_FLOOR` would cap `w` back up to 160 and the player could
   * never choose the small box at all — the party pane's argument, applied to a
   * box whose smallest legal size is 66.
   */
  it('carries its own floor rather than the Case Log’s', () => {
    expect(MINIMAP_FLOOR).toEqual({
      w: MINIMAP_MIN_CELL * MINIMAP_SPAN,
      h: MINIMAP_MIN_CELL * MINIMAP_SPAN,
    });
    const small = placed({ w: 66, h: 66 }, NO_OFFSET);
    expect(small.w).toBe(MINIMAP_MIN_CELL * MINIMAP_SPAN);
  });

  /**
   * ═══ THE BAND IS THE CLAMP, AS IT IS FOR EVERY OTHER PANEL ═══
   * Its top is `MINIMAP_MARGIN`, above `panelBand.top`, because the box is
   * painted over the turn bar by design; its bottom is the action bar, which it
   * must never cover.
   */
  it('cannot be dragged off the screen or onto the action bar', () => {
    for (const dx of [-5000, -400, -1, 0, 1, 400, 5000]) {
      for (const dy of [-5000, -200, -1, 0, 1, 200, 5000]) {
        const box = placed(null, { dx, dy });
        // THE WHOLE BOX, not merely its floor: a move may never resize, so the
        // box that is clamped is the box that is drawn.
        expect(box.y, `dy ${String(dy)} left the band`).toBeGreaterThanOrEqual(band.top);
        expect(box.y + box.h, `dy ${String(dy)} reached the bar`).toBeLessThanOrEqual(band.bottom);
        expect(box.x, `dx ${String(dx)} left the screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w, `dx ${String(dx)} left the screen`).toBeLessThanOrEqual(W);
        // AND IT IS STILL THE SAME BOX. This is the one that caught the first
        // draft: placed with `resizeIntoBand`, a drag 180 pixels down turned
        // 99x99 into 66x66 — a move that resized the map.
        expect(box.w, `dx ${String(dx)} dy ${String(dy)} resized the map`).toBe(
          minimapRect(W, null, band).w,
        );
      }
    }
  });

  /**
   * ═══ A SHORT BAND SHRINKS THE BOX RATHER THAN LETTERBOXING IT ═══
   * `resizeIntoBand` caps `w` and `h` independently, so without the squaring a
   * 198-pixel box in a 150-pixel band is a 198x142 frame holding a 132-pixel
   * map, with 66 pixels of dead border down one side.
   */
  it('shrinks to fit a short band, and stays square doing it', () => {
    const short = { top: 8, bottom: 158 };
    const box = placed({ w: 198, h: 198 }, NO_OFFSET, short);
    expect(box.w).toBe(box.h);
    expect(box.h).toBeLessThanOrEqual(short.bottom - short.top);
    expect(box.w % MINIMAP_SPAN).toBe(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE JOIN: THE BOX MOVED, AND THE CLICK MOVED WITH IT. PIXEL FOR PIXEL.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * main.ts:3205 records the one this replaces — `minimapRect` painted every
   * frame with no caller in any mouse handler. Now that the box can be placed
   * anywhere, the failure mode is worse and quieter: the map is drawn where the
   * player put it and the click is resolved against the factory corner, so
   * every click walks the party to the wrong tile by exactly the offset they
   * dragged. This is the test that would see it.
   */
  it('a click anywhere on the moved box resolves to the tile drawn there', () => {
    const map = { w: 170, h: 100 };
    const self = { x: 60, y: 40 };
    const still = placed(null, NO_OFFSET);
    const moved = placed(null, { dx: -700, dy: 180 });
    // A MOVE IS NOT A RESIZE: same box, somewhere else.
    expect(moved.w).toBe(still.w);
    expect({ x: moved.x, y: moved.y }).not.toEqual({ x: still.x, y: still.y });

    for (let oy = 0; oy < still.h; oy += 3) {
      for (let ox = 0; ox < still.w; ox += 3) {
        expect(
          mapTileAt(map, moved, moved.x + ox, moved.y + oy, self, MINIMAP_RADIUS),
          `pixel ${String(ox)},${String(oy)} inside the box`,
        ).toEqual(mapTileAt(map, still, still.x + ox, still.y + oy, self, MINIMAP_RADIUS));
      }
    }
  });

  it('and after a resize as well, at the cell the bigger box draws', () => {
    const map = { w: 170, h: 100 };
    const self = { x: 60, y: 40 };
    const box = placed({ w: 200, h: 200 }, { dx: -500, dy: 120 });
    const cell = box.w / MINIMAP_SPAN;
    expect(cell).toBe(6);

    // THE CENTRE IS THE PLAYER, wherever the box is and however big it is.
    const mid = mapTileAt(
      map,
      box,
      box.x + Math.floor(box.w / 2),
      box.y + Math.floor(box.h / 2),
      self,
      MINIMAP_RADIUS,
    );
    expect(mid).toEqual(self);

    // AND ONE CELL ACROSS IS ONE TILE ACROSS, in the resized cell size — which
    // is the half a resize that showed more WORLD would get wrong.
    for (const step of [-4, -1, 1, 5]) {
      expect(
        mapTileAt(
          map,
          box,
          box.x + Math.floor(box.w / 2) + step * cell,
          box.y + Math.floor(box.h / 2),
          self,
          MINIMAP_RADIUS,
        ),
      ).toEqual({ x: self.x + step, y: self.y });
    }

    // AND THE WINDOW IS STILL 33 TILES, not 33 scaled by anything. Upstream's
    // is a fixed 50 (`Minimalist.lua:1611-1614`) and the reason ours is fixed
    // is stronger: `MINIMAP_REVEAL_RADIUS` is 20, so past 16 the server stops
    // marking what is out there.
    const left = mapTileAt(
      map,
      box,
      box.x + 1,
      box.y + Math.floor(box.h / 2),
      self,
      MINIMAP_RADIUS,
    );
    const right = mapTileAt(
      map,
      box,
      box.x + box.w - 1,
      box.y + Math.floor(box.h / 2),
      self,
      MINIMAP_RADIUS,
    );
    expect(left).toEqual({ x: self.x - MINIMAP_RADIUS, y: self.y });
    expect(right).toEqual({ x: self.x + MINIMAP_RADIUS, y: self.y });
  });

  /**
   * ═══ THE SETTLE LANDS WHERE THE PAINT DREW ═══
   * `settleOffset`'s own note: *"a settle that rounded differently from the
   * draw would put the panel one pixel from where it was released"*. Here it
   * would be up to ninety-four, because this box lives against the right-hand
   * edge — so the settle runs `resizeIntoBand` with the SAME floor
   * the painter takes, in the same band, and this is what says so.
   */
  it('settles on exactly the position it was drawn at', () => {
    for (const offset of [
      { dx: 0, dy: 0 },
      { dx: -3000, dy: 40 },
      { dx: 900, dy: -900 },
      { dx: -120, dy: 260 },
    ]) {
      const unmoved = base({ w: 132, h: 132 });
      const drawn = moveIntoBand(unmoved, offset, band, W);
      const settled = settleOffset(unmoved, offset, band, W);
      expect({ x: unmoved.x + settled.dx, y: unmoved.y + settled.dy }).toEqual({
        x: drawn.x,
        y: drawn.y,
      });
      // AND IT IS IDEMPOTENT, so a second release cannot walk the box.
      expect(moveIntoBand(unmoved, settled, band, W)).toEqual(drawn);
    }
  });

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * THE GRIP, DRIVEN AS A GESTURE — WHICH IS THE HALF THAT WAS NEVER TESTED.
   * ════════════════════════════════════════════════════════════════════════════
   *
   * "Five reachable sizes: 66, 99, 132, 165, 198" was true of `minimapCellFor`
   * and FALSE OF THE GESTURE. The box is right-docked at `viewW - box - 8`, the
   * grip was in its bottom-right corner, and `resizeIntoBand` caps `w` to
   * `width - x` — so the pointer had eight pixels of travel and the clamp handed
   * back the size the box already was. Dragging the grip +400,+400 stored
   * `{w:107, h:345}` and drew 99x99 at 1262x428, 1920x1080, 2560x1440 and the
   * 640 floor alike; shrink it once to 66 and the room right of its own origin
   * became 74, so the box was pinned at its floor FOREVER — and `minimapSize`
   * persists server-side, so one accidental shrink was a half-size minimap in
   * every session after it.
   *
   * So this block drives the whole chain main.ts composes, in its order: the
   * grip rect, the grab, `nextSize` with the corner, the store's clamp, and the
   * box that comes back out of `minimapRect`. `hudwiring.test.ts` pins that
   * main.ts still composes exactly these; this says the composition is right.
   */
  describe('the grip makes it bigger as well as smaller', () => {
    const CORNER = GripCorner.BottomLeft;
    const SIZES = [66, 99, 132, 165, 198];

    /** One resize gesture, exactly as `beginDrag` + `onDragMove` compose it. */
    const dragGrip = (
      size: { w: number; h: number } | null,
      offset: { dx: number; dy: number },
      dx: number,
      dy: number,
    ) => {
      const rect = placed(size, offset);
      const grip = logGripRect(rect, CORNER);
      const grabX = grip.x + 6;
      const grabY = grip.y + 6;
      const origin = { x: rect.x + rect.w, y: rect.y };
      const gripOffset = { dx: grabX - rect.x, dy: grabY - (rect.y + rect.h) };
      const asked = nextSize(origin, gripOffset, grabX + dx, grabY + dy, MINIMAP_FLOOR, CORNER);
      const stored = sizeIntoBand(asked, band, W, MINIMAP_FLOOR);
      return { stored, drawn: placed(stored, offset) };
    };

    it('says what the cell under the pointer is, and what pressing it does', () => {
      /**
       * ═══ THIS WAS PINNED BY A SCRAPE AND THE SCRAPE SAW ONLY THE CALL ═══
       * `minimapCardAt` returning null for every point survived the whole suite:
       * the assertion was that the hover chain MENTIONED it, which is the same
       * "wired to something" shape that rotted one level up on `minimapRect`
       * itself. The words live in ui/mapview.ts now so that they can be driven.
       *
       * THE TILE IS ON THE CARD because the map is two to six pixels a cell —
       * "walk here" is only useful if the player can tell WHICH cell.
       */
      expect(minimapCard({ x: 12, y: 40 }, true).title).toBe('12,40');
      expect(minimapCard({ x: 12, y: 40 }, true).meta).toBe('click to travel here');
      // AND THE REFUSAL IS THE VERB MENU'S OWN SENTENCE, not a shrug: water and
      // walls are on this map and pointing at one is an ordinary thing to do.
      expect(minimapCard({ x: 0, y: 0 }, false).meta).toBe('you cannot walk there');
      // ...AND THE SECOND GESTURE IS NAMED, because nothing else names it.
      expect(minimapCard({ x: 1, y: 1 }, true).lines).toContain(
        'middle-click opens the region map',
      );
    });

    it('puts the grip in the corner the box grows towards', () => {
      // The box is docked to the right margin, so its left edge is the one that
      // moves. A grip on the right edge is a grip with `MINIMAP_MARGIN` pixels
      // of room, which is the whole of the bug above.
      const rect = placed(null, NO_OFFSET);
      const grip = logGripRect(rect, CORNER);
      expect(grip.x).toBe(rect.x);
      expect(grip.y + grip.h).toBe(rect.y + rect.h);
      // ...and it is INSIDE the box, so the press is the box's own.
      expect(grip.x + grip.w).toBeLessThanOrEqual(rect.x + rect.w);
    });

    it('reaches every size from the place it ships in', () => {
      /**
       * FROM `NO_OFFSET` AND THE DEFAULT SIZE, which is the state a player is
       * actually in when they first reach for the corner. The old grip could
       * reach exactly one of these from here, and it was the one it was already
       * at.
       */
      const reached = new Set<number>();
      for (let dx = -600; dx <= 40; dx += 1) {
        for (const dy of [-40, 0, 60, 200, 400]) {
          reached.add(dragGrip(null, NO_OFFSET, dx, dy).drawn.w);
        }
      }
      for (const size of SIZES) {
        expect(reached.has(size), `${String(size)} is unreachable from the shipped position`).toBe(
          true,
        );
      }
    });

    it('round-trips: a box shrunk to its floor can be grown again', () => {
      // THE ABSORBING STATE. At 66 the old clamp had 74 pixels to work with and
      // `floor(74/33)` is 2, so the box could never leave its floor again — in
      // this session or any later one, because the size is persisted.
      const small = dragGrip(null, NO_OFFSET, 400, -400);
      expect(small.drawn.w).toBe(66);
      const big = dragGrip(small.stored, NO_OFFSET, -600, 400);
      expect(big.drawn.w).toBe(198);
      // ...and back down again, so it is a control and not a ratchet.
      expect(dragGrip(big.stored, NO_OFFSET, 600, -400).drawn.w).toBe(66);
    });

    it('is the same control wherever the box has been dragged to', () => {
      // The old one worked only after the player discovered they had to move
      // the box left first. Both ends of the range, from four positions.
      for (const offset of [
        NO_OFFSET,
        { dx: -500, dy: 0 },
        { dx: -1100, dy: 100 },
        { dx: 40, dy: 180 },
      ]) {
        expect(dragGrip(null, offset, -600, 400).drawn.w, `grow at ${JSON.stringify(offset)}`).toBe(
          198,
        );
        expect(
          dragGrip(null, offset, 600, -400).drawn.w,
          `shrink at ${JSON.stringify(offset)}`,
        ).toBe(66);
      }
    });

    it('keeps the grabbed pixel under the pointer', () => {
      // `nextSize`'s whole reason for taking `gripOffset`: the corner must not
      // snap to the pointer. A grab six pixels into the grip and a drag of
      // exactly one cell moves the left edge by exactly one cell.
      const before = placed(null, NO_OFFSET);
      const after = dragGrip(null, NO_OFFSET, -MINIMAP_SPAN, MINIMAP_SPAN).drawn;
      expect(after.w).toBe(before.w + MINIMAP_SPAN);
      expect(after.x).toBe(before.x - MINIMAP_SPAN);
      // AND THE ANCHORED CORNER DID NOT MOVE. The top-right is the fixed one.
      expect(after.x + after.w).toBe(before.x + before.w);
      expect(after.y).toBe(before.y);
    });

    it('does not resize on a press that goes nowhere', () => {
      // The grip is inside the box and a press that never moves is still a
      // click. Zero travel must be zero change, or every press on the corner
      // would snap the box to wherever the pointer happened to be.
      expect(dragGrip(null, NO_OFFSET, 0, 0).drawn.w).toBe(placed(null, NO_OFFSET).w);
      expect(dragGrip({ w: 132, h: 132 }, NO_OFFSET, 0, 0).drawn.w).toBe(132);
    });
  });

  /**
   * ═══ THE NAME OF THE PLACE TRAVELS WITH THE BOX ═══
   * `zoneLabelBaseline` used to take the viewport and call `minimapRect` for
   * itself, which would have left the label in the corner while the map it
   * names sat in the middle of the screen.
   */
  it('keeps the zone label under the box wherever the box is', () => {
    const moved = placed(null, { dx: -600, dy: 150 });
    expect(zoneLabelBaseline(moved)).toBeGreaterThan(moved.y + moved.h);
    expect(zoneLabelBaseline(moved)).toBe(moved.y + moved.h + 10);
    // AND IT IS NOT THE DEFAULT BOX'S BASELINE, which is the bug it replaces.
    expect(zoneLabelBaseline(moved)).not.toBe(zoneLabelBaseline(minimapRect(W)));
  });

  it('exposes one answer to how big the box is', () => {
    // `minimapBoxSize` is what `minimapRect` and every reader of "how big is
    // this box" goes through. Two answers is the fault this whole block guards.
    expect(minimapBoxSize(null)).toBe(minimapCellFor(null) * MINIMAP_SPAN);
    expect(minimapBoxSize({ w: 132, h: 132 })).toBe(132);
    expect(minimapBoxSize({ w: 131, h: 131 })).toBe(99);
    /**
     * ═══ AND THE SHORTER SIDE DECIDES, WHICH NO TEST SAID ═══
     * A MUTANT SURVIVED ON THIS: `Math.max(size.w, size.h)` passed everything,
     * because the only caller handed it two equal numbers. The stored size is
     * the RAW box a gesture reached and `nextSize` computes `w` and `h`
     * independently, so a real drag sideways stores an oblong — and sizing from
     * the longer side would draw a map the shorter side cannot hold.
     */
    expect(minimapBoxSize({ w: 198, h: 90 })).toBe(66);
    expect(minimapBoxSize({ w: 90, h: 198 })).toBe(66);
  });
});
