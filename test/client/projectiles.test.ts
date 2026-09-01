import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  applyProjectilesFrame,
  clearProjectiles,
  orbsAimedAt,
  impactClause,
  soonestImpact,
} from '../../src/client/state/projectiles.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import type { ProjectileView, ProjectilesMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORB'S ONLY LOGIC, AND THE ONLY PART OF IT A NODE TEST CAN REACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts runs in the NODE environment with no jsdom and no canvas, on
 * purpose. So this feature was split: `src/client/state/projectiles.ts` holds
 * the rule (the frame is complete and absolute, and it REPLACES) and
 * `paintProjectiles` in render/canvas.ts holds the pixels.
 *
 * THE PAINTER IS NOT TESTED HERE AND MUST NOT BE. Mocking a 2D context to assert
 * a sequence of `fillRect` calls tests the mock and pins the drawing to whatever
 * arithmetic it happens to have today — it would fail on a two-pixel change to
 * the dot and pass on a wholly invisible orb. Its actual correctness constraints
 * are structural (no `blitSprite`, no new `MarkerKind`, no new asset prefix), and
 * those are pinned by the grep in test/client/assets.test.ts.
 *
 * WHAT IS PINNED HERE INSTEAD: replacement, emptiness, and the fact that this
 * module never touches the DOM — the property that keeps it testable at all.
 */

function orb(over: Partial<ProjectileView> & { id: string }): ProjectileView {
  return {
    x: 0,
    y: 0,
    sourceId: 'm_wraith',
    targetX: 5,
    targetY: 5,
    turnsToImpact: 2,
    ...over,
  };
}

function frame(projectiles: readonly ProjectileView[]): ProjectilesMsg {
  return { v: PROTOCOL_VERSION, t: 'projectiles', projectiles };
}

describe('applyProjectilesFrame', () => {
  it('REPLACES the previous list rather than merging into it', () => {
    // THE BUG THIS TEST EXISTS FOR: two orbs in the air, then one lands. A
    // merging client keeps the landed one forever — a phantom orb that teaches
    // the player to dodge something that is not coming.
    const two = applyProjectilesFrame(frame([orb({ id: 'proj_1' }), orb({ id: 'proj_2' })]));
    expect(two).toHaveLength(2);

    const one = applyProjectilesFrame(frame([orb({ id: 'proj_2', x: 3, y: 4 })]));
    expect(one).toHaveLength(1);
    expect(one.map((p) => p.id)).toEqual(['proj_2']);
    // ...and the survivor's position comes from the NEW frame, not the old one.
    expect(one[0]?.x).toBe(3);
    expect(one[0]?.y).toBe(4);
  });

  it('treats an empty frame as "the sky is clear"', () => {
    // The only spelling of "it landed" on this wire. There is no landed event.
    expect(applyProjectilesFrame(frame([orb({ id: 'proj_1' })]))).toHaveLength(1);
    expect(applyProjectilesFrame(frame([]))).toEqual([]);
  });

  it('does not alias the array inside the message', () => {
    // Board state that IS the last received packet is board state that changes
    // when nobody wrote to it — and it pins the whole decoded frame in memory
    // for as long as an orb is in flight.
    const msg = frame([orb({ id: 'proj_1' })]);
    const held = applyProjectilesFrame(msg);
    expect(held).not.toBe(msg.projectiles);
    expect(held).toEqual(msg.projectiles);
  });
});

describe('clearProjectiles', () => {
  it('returns an empty list, for the two frames that replace the world', () => {
    // `welcome` and `state`. An orb carried across either is aimed at a tile on
    // a map that no longer exists.
    expect(clearProjectiles()).toEqual([]);
  });

  it('does not hand out one shared array that a caller could mutate', () => {
    expect(clearProjectiles()).not.toBe(clearProjectiles());
  });
});

describe('orbsAimedAt', () => {
  it('counts only the orbs whose FROZEN aim tile is this exact tile', () => {
    // The aim tile is where the victim STOOD when the shot was fired, and it
    // never re-aims: stepping off it is the whole counterplay, so an orb whose
    // aim is one tile away must not raise the warning.
    const air = [
      orb({ id: 'proj_1', targetX: 5, targetY: 5 }),
      orb({ id: 'proj_2', targetX: 5, targetY: 6 }),
      orb({ id: 'proj_3', targetX: 5, targetY: 5 }),
    ];
    expect(orbsAimedAt(air, { x: 5, y: 5 })).toBe(2);
    expect(orbsAimedAt(air, { x: 5, y: 6 })).toBe(1);
    expect(orbsAimedAt(air, { x: 4, y: 5 })).toBe(0);
  });

  it('ignores where the orb is RIGHT NOW', () => {
    // `x`/`y` is the current tile and moves every turn; the warning is about the
    // destination. An orb passing over your head is not aimed at you.
    const air = [orb({ id: 'proj_1', x: 2, y: 2, targetX: 9, targetY: 9 })];
    expect(orbsAimedAt(air, { x: 2, y: 2 })).toBe(0);
    expect(orbsAimedAt(air, { x: 9, y: 9 })).toBe(1);
  });

  it('answers zero before `welcome` puts a body on the map', () => {
    // `selfTile()` is null until then, and a frame can arrive first.
    expect(orbsAimedAt([orb({ id: 'proj_1' })], null)).toBe(0);
    expect(orbsAimedAt([], { x: 1, y: 1 })).toBe(0);
  });
});

describe('the module stays testable', () => {
  const source = readFileSync(
    new URL('../../src/client/state/projectiles.ts', import.meta.url),
    'utf8',
  );
  /**
   * CODE ONLY. The prose in that file NAMES the globals it is forbidden to
   * touch — that is the comment doing its job — so matching the raw text would
   * fail on the warning rather than on the violation, and the obvious fix
   * (delete the warning) is the wrong one.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('imports nothing from render/ and touches no DOM global', () => {
    // THE POINT OF THE SPLIT. The moment this module imports a painter or
    // reaches for a context, it stops being reachable from a node test and the
    // only tested part of the orb feature is gone. Asserted on the text because
    // a node test cannot detect the import it would then fail to load.
    expect(code).not.toMatch(/from '\.\.\/render\//);
    expect(code).not.toMatch(/\bdocument\b|\bwindow\b|CanvasRenderingContext2D/);
  });

  it('imports only types from shared/, so nothing is loaded at runtime', () => {
    // Every import in the file is `import type`. That is what keeps this module
    // free of a runtime edge to protocol.ts, and it is also the rule the
    // type-stripping loader needs (see eslint's consistent-type-imports).
    const imports = code.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line.startsWith('import type ')).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `turnsToImpact` WAS COMPUTED, SENT ON EVERY FRAME, AND READ BY NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine computes it (`engine/projectile.ts`), `projectLoadout`'s sibling
 * puts it on the wire, `ProjectileView` documents its unit at length — *"the
 * difference between 'you have two turns to move' and 'it lands before you can
 * press a key'"* — and `grep -rn turnsToImpact src/client/` returned exactly one
 * hit, in a comment.
 *
 * The notice line beside it already said "an orb is aimed at this tile — move".
 * That is the half of the sentence that does not answer whether moving is still
 * possible, which is the only question a player has at that moment.
 */
describe('soonestImpact', () => {
  it('answers null when nothing is aimed at the tile', () => {
    expect(soonestImpact([orb({ id: 'a', targetX: 9, targetY: 9 })], { x: 1, y: 1 })).toBeNull();
    expect(soonestImpact([], { x: 1, y: 1 })).toBeNull();
  });

  it('answers null for no tile at all — a viewer with no body', () => {
    expect(soonestImpact([orb({ id: 'a' })], null)).toBeNull();
  });

  it('takes the SOONEST, not the first and not the latest', () => {
    /**
     * THE RULE, AND THE ONE THAT WOULD BE WRONG BY ACCIDENT. Three orbs landing
     * in four turns and one landing next turn is a ONE-turn problem; a player
     * told "4" would spend the turn they had. Ordered so that neither "first
     * match" nor "last match" would pass.
     */
    const aimed = [
      orb({ id: 'a', targetX: 3, targetY: 3, turnsToImpact: 4 }),
      orb({ id: 'b', targetX: 3, targetY: 3, turnsToImpact: 1 }),
      orb({ id: 'c', targetX: 3, targetY: 3, turnsToImpact: 3 }),
    ];
    expect(soonestImpact(aimed, { x: 3, y: 3 })).toBe(1);
  });

  it('ignores an orb aimed at a DIFFERENT tile, however soon it lands', () => {
    // The whole counterplay is that the orb does not re-aim, so an orb about to
    // land next door is not this player's problem and must not raise their
    // notice — that is the "phantom warning" failure the frame rules exist for.
    const mixed = [
      orb({ id: 'near', targetX: 4, targetY: 4, turnsToImpact: 1 }),
      orb({ id: 'mine', targetX: 3, targetY: 3, turnsToImpact: 5 }),
    ];
    expect(soonestImpact(mixed, { x: 3, y: 3 })).toBe(5);
  });
});

describe('impactClause', () => {
  it('says nothing when there is nothing to say', () => {
    // So the caller can concatenate unconditionally rather than branching twice.
    expect(impactClause(null)).toBe('');
  });

  it('reads zero as NOW rather than as "0 turns"', () => {
    // `turnsToImpact` floors at 0 for an orb landing this pump, and "0 turns to
    // move" is a sentence that invites a player to try.
    expect(impactClause(0)).toBe(' — landing now');
    expect(impactClause(-1)).toBe(' — landing now');
  });

  it('agrees with itself about singular and plural', () => {
    expect(impactClause(1)).toBe(' — 1 turn');
    expect(impactClause(2)).toBe(' — 2 turns');
  });
});

describe('and the sentence actually carries it', () => {
  it('main.ts hangs the clause on both the one-orb and the many-orb line', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SOURCE GUARD, and this file's own header says why it is the only option.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * *"vitest has no jsdom, so the half of this feature with a rule in it has
     * to be reachable from a node test, and the half that draws must have
     * nothing in it worth reaching."* The rule above is reachable; the line that
     * SPENDS it lives in `main.ts` beside a canvas, and nothing here can call it.
     *
     * Without this, `soonestImpact` is a correct function with no caller —
     * which is precisely the state `turnsToImpact` was in for the whole life of
     * the feature, and precisely what this commit exists to end.
     *
     * BOTH BRANCHES, because the plural one is the easy one to forget: a player
     * with two orbs incoming is in more trouble, not less.
     */
    const main = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('impactClause(soonestImpact(projectiles, tile))');
    expect(main).toContain(
      '`an orb is aimed at this tile${clause} — move, or break line of sight`',
    );
    expect(main).toContain('`${incoming} orbs are aimed at this tile${clause} — move`');
  });
});
