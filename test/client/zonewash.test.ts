/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DAMAGE_INK, PALETTE, ZONE_WASH_INK } from '../../src/client/render/canvas.ts';
import { DAMAGE_TYPES, DamageType } from '../../src/shared/damagetype.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ZONE WASH, CHECKED THE ONLY TWO WAYS IT CAN BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING BELOW IS DRAWN, and here that is not a stylistic choice like it is in
 * `pathpreview.test.ts` — it is the only option. `test/client/canvasstub.ts`
 * records `drawImage` and NOTHING else: every `save`, `restore`, `fillRect` and
 * `globalAlpha` assignment is a silent no-op on the stub. A `fillRect` painter
 * is therefore invisible to every stub-driven test in this repo.
 *
 * So the two things that CAN be checked are checked: the table it paints from,
 * as data; and the shape of the painter, as SOURCE TEXT. That second one is the
 * same instrument `paintLoot`, `paintProjectiles` and `paintProps` are each held
 * by, and for the same reason.
 */

const SOURCE = readFileSync(new URL('../../src/client/render/canvas.ts', import.meta.url), 'utf8');

/**
 * The painter's body — its declaration to the start of the NEXT docblock.
 *
 * NOT "to `function paintProps(`", which was the first draft and was wrong in
 * the direction that matters: that slice swallows `paintProps`'s own docblock,
 * and that docblock argues at length about `blitSprite`. The negative
 * assertions below would then have been testing the neighbour's prose. The
 * guarded windows in the other four files have the same property and get away
 * with it; this one is asserting the opposite of what they assert, so it cannot.
 */
function paintZonesBody(): string {
  const start = SOURCE.indexOf('function paintZones(');
  expect(start, 'paintZones was renamed — this guard is now blind').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n  /**', start);
  expect(end, 'no docblock follows paintZones — re-anchor this slice').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('ZONE_WASH_INK — the table the floor is tinted from', () => {
  it('covers all six damage types', () => {
    // TOTAL, because `paintZones` indexes it with whatever the wire sent. A
    // missing entry is `undefined` into `fillStyle`, which the canvas ignores
    // silently — the cell would draw in whatever colour was set last.
    for (const type of DAMAGE_TYPES) {
      expect(ZONE_WASH_INK[type], `no wash ink for ${type}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(ZONE_WASH_INK)).toHaveLength(DAMAGE_TYPES.length);
  });

  it('keeps the four the Case Log already uses', () => {
    /**
     * The log prints "9 fire damage" in `DAMAGE_INK[Fire]`. A floor wash in a
     * different red would be two facts about one element that a player has to
     * learn separately, so four of the six are copied rather than re-chosen and
     * this is what keeps them in step when either table moves.
     */
    for (const type of [
      DamageType.Fire,
      DamageType.Cold,
      DamageType.Lightning,
      DamageType.Darkness,
    ]) {
      expect(ZONE_WASH_INK[type], `${type} drifted from the log's ink`).toBe(DAMAGE_INK[type]);
    }
  });

  it('overrides exactly the two that cannot be a fill', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * PARCHMENT MEANS "NO COLOUR" AND GOLD MEANS "YOUR OWN AIM".
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `DAMAGE_INK[Physical]` is PARCHMENT because a word that means "no
     * element" should be the same ink as every other word. A FILL cannot be
     * untinted — parchment over a floor tile is a pale rectangle that reads as
     * light — and physical is the commonest zone in the game, since it is what
     * the Glut leaves.
     *
     * `DAMAGE_INK[Mind]` is GOLD, and GOLD is this canvas's colour for the
     * player's own route and cursor. A full-cell gold wash would say "your aim
     * is here" on a tile that is hurting you.
     */
    expect(ZONE_WASH_INK[DamageType.Physical]).not.toBe(PALETTE.PARCHMENT);
    expect(ZONE_WASH_INK[DamageType.Mind]).not.toBe(PALETTE.GOLD);
  });

  it('spends none of the reserved inks', () => {
    // CRIMSON means "hostiles are engaged" and nothing else; VIOLET_HI is the
    // missing-asset box, so a wash wearing it would read as broken art.
    const reserved: readonly string[] = [PALETTE.CRIMSON, PALETTE.VIOLET_HI, PALETTE.GOLD];
    for (const type of DAMAGE_TYPES) {
      expect(reserved, `${type}'s wash claims a reserved ink`).not.toContain(ZONE_WASH_INK[type]);
    }
  });
});

describe('paintZones — the shape of it, as source text', () => {
  it('is quieter than the out-of-sight shade', () => {
    /**
     * The shade means "you cannot reach this"; a zone means "something is
     * happening here". If the hazard ever shouts louder than the availability
     * marker, the two compete on the one screen where a player is deciding
     * where to stand. Read out of the source because both are module-private.
     */
    const alpha = /const ZONE_WASH_ALPHA = ([\d.]+);/.exec(SOURCE)?.[1];
    const shade = /const LOS_SHADE_ALPHA = ([\d.]+);/.exec(SOURCE)?.[1];
    expect(alpha, 'ZONE_WASH_ALPHA is gone or is no longer a literal').toBeDefined();
    expect(shade, 'LOS_SHADE_ALPHA is gone or is no longer a literal').toBeDefined();
    expect(Number(alpha)).toBeGreaterThan(0);
    expect(Number(alpha)).toBeLessThan(Number(shade));
  });

  it('balances its save with a restore, and sets the alpha once', () => {
    /**
     * A LEAKED `globalAlpha` IS THIS FILE'S NAMED FAILURE MODE, written down
     * three separate times: every subsequent sprite in the frame goes
     * translucent and it "looks like a broken PNG rather than like a missing
     * restore". Nothing else in the repo can catch it — the canvas stub swallows
     * every property assignment — so this slice is the only guard there is.
     */
    const body = paintZonesBody();
    expect(body).toContain('backCtx.save()');
    expect(body).toContain('backCtx.restore()');
    expect(body).toContain('globalAlpha = ZONE_WASH_ALPHA');
    // ONCE, outside the loop: setting it per cell would still be correct and
    // would be a per-cell state change on the hottest path in the renderer.
    expect((body.match(/globalAlpha/g) ?? []).length).toBe(1);
  });

  it('draws no art at all, and reuses the camera arithmetic it was given', () => {
    // `client/public/assets/` is gitignored wholesale, so a bare clone has no
    // manifest and `blitSprite` paints a loud violet box on a miss — a new
    // overlay id would fire the broken-manifest alarm for a feature that works.
    const body = paintZonesBody();
    expect(body).not.toContain('blitSprite');
    expect(body).not.toContain('blitCell');
    expect(body).not.toContain('drawImage');
    // AND IT CULLS. Every ground painter in this file tests `visible` before it
    // fills; one that did not would draw the whole level every frame.
    expect(body).toContain('visible(');
  });

  it('is defined outside every guarded source window in this file', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PLACEMENT IS LOAD-BEARING AND NOTHING ELSE STATES IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Four other test files slice this one between named functions and assert
     * that no `blitSprite`/`drawImage` appears in each window. A painter defined
     * inside one is silently held to a rule it was never meant for — and one of
     * those files is owned by another agent and cannot be edited to widen it.
     *
     * `paintZones` sits between `paintTargeting` and `paintProps`, which is
     * outside all of them. This asserts that ordering directly, so moving the
     * definition into a guarded window fails HERE with a reason rather than
     * over there with a confusing one.
     */
    const at = (name: string): number => SOURCE.indexOf(`function ${name}(`);
    expect(at('paintZones')).toBeGreaterThan(at('paintTargeting'));
    expect(at('paintZones')).toBeLessThan(at('paintProps'));
    // ...and the guarded windows all begin at or after `paintPath`.
    expect(at('paintZones')).toBeLessThan(at('paintPath'));
  });
});
