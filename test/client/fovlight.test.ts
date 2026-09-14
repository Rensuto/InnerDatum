/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIGHT_RADIUS,
  FOV_BRIGHTNESS_FLOOR,
  MAP_OBSCURE_BRIGHTNESS,
  fovBrightness,
} from '../../src/shared/sight.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW BRIGHT THE FLOOR DRAWS — `Player.lua:510-517` and `engine/Map.lua:68-69`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * fovdist[i] = math.max((20 - math.sqrt(i)) / 17, 0.6)
 * color_shown   = { 1, 1, 1, 1 }
 * color_obscure = { 0.6, 0.6, 0.6, 0.5 }
 * ```
 *
 * THE CURVE IS A UNIT TEST AND THE PAINTER IS NOT, and the split is forced.
 * `test/client/canvasstub.ts` records `drawImage` and nothing else, so every
 * `fillRect` and every `globalAlpha` assignment is a silent no-op — a wash
 * painter is invisible to every stub-driven test in this repo. `zonewash.test.ts`
 * states the same constraint and answers it the same way: the arithmetic as
 * data, the painter as SOURCE TEXT.
 */

const SOURCE = readFileSync(new URL('../../src/client/render/canvas.ts', import.meta.url), 'utf8');

/**
 * `paintLight`'s body — its declaration to the NEXT SIBLING FUNCTION.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT "TO THE NEXT DOCBLOCK", WHICH IS WHAT THIS SAID AND IT WAS BLIND.
 * ═══════════════════════════════════════════════════════════════════════════
 * `zonewash.test.ts` writes the warning out in full: a window that runs to the
 * next docblock swallows whatever follows when the neighbour has none of its
 * own. `paintTiles` is that neighbour, it has none, and it contains
 * `realmKind === 'overworld'` for a completely unrelated reason
 * (`paintsWorldTopology`). So the overworld assertion below was passing against
 * the WRONG FUNCTION — deleting the guard from `paintLight` left all nine green.
 *
 * Caught by mutation, which is the only thing that catches this. A sibling
 * declaration is the reliable anchor: everything inside a function here is
 * indented four or more, so a two-space `function` cannot appear until the next
 * one starts.
 */
function paintLightBody(): string {
  const start = SOURCE.indexOf('function paintLight(');
  expect(start, 'paintLight was renamed — this guard is now blind').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n  function ', start + 1);
  expect(end, 'no sibling follows paintLight — re-anchor this slice').toBeGreaterThan(start);
  const body = SOURCE.slice(start, end);
  // AND THE WINDOW IS THE RIGHT SIZE. A slice that grew to swallow a neighbour
  // again would satisfy every `toContain` below without testing this function.
  expect(body, 'the paintLight window swallowed a neighbour').not.toContain('paintsWorldTopology');
  return body;
}

describe('fovBrightness — the sight curve', () => {
  it('is full brightness out to three tiles', () => {
    // `(20 - 3) / 17` is exactly 1, which is why three is the number and not a
    // rounding artefact: it is where the line crosses. Inside it the formula
    // gives MORE than 1 and the clamp is what holds it.
    expect(fovBrightness(0)).toBe(1);
    expect(fovBrightness(3)).toBe(1);
  });

  it('bottoms out at the floor exactly at the sight radius', () => {
    /**
     * `(20 - 10) / 17` = 0.588, which is BELOW 0.6, so the floor takes over at
     * ten — `DEFAULT_SIGHT_RADIUS`. The curve was fitted to the radius, so the
     * dimmest thing a body can see is always the floor and never darker.
     */
    expect(fovBrightness(DEFAULT_SIGHT_RADIUS)).toBe(FOV_BRIGHTNESS_FLOOR);
    expect(fovBrightness(30)).toBe(FOV_BRIGHTNESS_FLOOR);
  });

  it('falls linearly in between, on the real formula', () => {
    // SPOT-CHECKED AGAINST THE LUA rather than against itself: `(20 - d) / 17`.
    for (const d of [4, 5, 6, 7, 8]) {
      expect(fovBrightness(d), `distance ${String(d)}`).toBeCloseTo((20 - d) / 17, 10);
    }
    // AND IT IS MONOTONIC, which a sign error in the numerator would break while
    // leaving both endpoints above correct.
    for (let d = 0; d < 20; d += 1) {
      expect(fovBrightness(d + 1)).toBeLessThanOrEqual(fovBrightness(d));
    }
  });
});

describe('MAP_OBSCURE_BRIGHTNESS — what a tile out of sight drops to', () => {
  it('is BOTH multiplications, not the 0.6 that appears four times', () => {
    /**
     * ═══ THE MISREADING THIS EXISTS TO STOP ═══
     * `color_obscure = { 0.6, 0.6, 0.6, 0.5 }` scales the colour to 0.6 AND
     * draws it at alpha 0.5 over the black beneath, so 0.3 reaches the screen.
     * Reading only the 0.6 gives an obscured tile exactly the brightness of the
     * dimmest tile you can SEE, and the distinction the pass exists to draw
     * disappears.
     */
    expect(MAP_OBSCURE_BRIGHTNESS).toBeCloseTo(0.3, 10);
    expect(MAP_OBSCURE_BRIGHTNESS).toBeLessThan(FOV_BRIGHTNESS_FLOOR);
  });
});

describe('paintLight — the painter, as source', () => {
  it('refuses to light anything when there is no body to see from', () => {
    // Dimming from the CAMERA instead would light whatever it happened to be
    // centred on, which is not a claim anything can make.
    expect(paintLightBody()).toContain(
      'if (eye === null || vision === null || vision === undefined) return;',
    );
  });

  it('lights the overworld like anywhere else, as this port ruled', () => {
    // `playerFOV` opens `if game.zone.wilderness then` with a different radius
    // and a different curve. We model neither.
    expect(paintLightBody()).not.toContain("realmKind === 'overworld'");
  });

  it('draws the sight the server sent rather than working one out', () => {
    /**
     * A SECOND OPINION ABOUT VISIBILITY IS THE FAILURE MODE HERE. `canSee` is
     * what `projectActors` filters bodies with, so a renderer that answered the
     * question its own way would draw a token the server had decided you can
     * see standing on ground it had decided you cannot.
     */
    const body = paintLightBody();
    expect(body, 'the painter works its own sight out again').not.toContain('canSee(');
    expect(body).toContain('vision.seen(');
    expect(body).toContain('fovBrightness(');
    expect(body, 'the out-of-sight arm stopped using the ported constant').toContain(
      'OBSCURE_WASH_ALPHA',
    );
  });

  it('skips a tile that needs no wash at all', () => {
    // `fovBrightness` is 1 within three tiles, so the tiles a player is standing
    // among must cost nothing — this pass runs every frame.
    expect(paintLightBody()).toContain('if (alpha <= 0) continue;');
  });

  it('is called by `draw`, after the floor and before every marker', () => {
    /**
     * THE JOIN. Everything above is true of a painter nothing invokes — the
     * whole function could be unreachable and every assertion would still pass.
     * Order matters twice over: after `paintTiles` or it dims nothing, before
     * `paintSites`/`paintTargeting` or it dims the interface.
     */
    const draw = SOURCE.indexOf('function draw(scene: Scene)');
    expect(draw, 'draw was renamed — this guard is now blind').toBeGreaterThan(-1);
    const tiles = SOURCE.indexOf('paintTiles(level,', draw);
    const light = SOURCE.indexOf('paintLight(', draw);
    const sites = SOURCE.indexOf('paintSites(', draw);
    expect(light, 'draw never calls paintLight').toBeGreaterThan(-1);
    expect(light, 'the light pass runs before the floor it dims').toBeGreaterThan(tiles);
    expect(sites, 'the light pass dims the markers over it').toBeGreaterThan(light);
  });
});
