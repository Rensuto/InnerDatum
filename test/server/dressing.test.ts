import { describe, expect, it } from 'vitest';

import { populateDelve, specFor } from '../../src/server/content/delve.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { PROP_IDS } from '../../src/shared/props.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRESSING IN THE WATCHER'S ROOM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six prop sprites were cut for this game and none of them could be shown,
 * because nothing could say "this cell also draws that". Three are placed now,
 * around the one boss in the game.
 *
 * See `shared/props.ts` for why these three and not the other three, and for
 * what the art's own metadata asks for that this build cannot yet honour.
 */

function delveOn(spec: DelveSpec, seed = 'dressing'): ReturnType<typeof createWorld> {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  const map: AuthoredMap = {
    view: world.level,
    spawns: [{ x: 4, y: 4 }],
    sites: new Map<string, string>(),
  };
  populateDelve(world, map, spec);
  return world;
}

/** The one site in the game that carries a boss — `redactedSpec` says so. */
function altarSpec(): DelveSpec {
  for (const [id] of SITES) {
    const spec = specFor(id);
    if (spec?.boss !== undefined) return spec;
  }
  throw new Error('no site in SITES carries a boss');
}

describe('a boss room is dressed', () => {
  it('places every prop this build knows, once each', () => {
    const world = delveOn(altarSpec());
    const placed = world.props();

    expect(placed.length, 'the altar room came up bare').toBe(PROP_IDS.length);
    expect(new Set(placed.map((p) => p.propId)), 'a prop was placed twice').toEqual(
      new Set(PROP_IDS),
    );
  });

  /**
   * ═══ NOT STACKED, AND NOT UNDER THE THING YOU CAME TO FIGHT ═══
   * Two props on one tile draw one over the other with no way to tell them
   * apart, and a prop under the boss is a prop nobody ever sees. Both are cheap
   * to get wrong in a placement loop and invisible until somebody stands there.
   */
  it('gives each prop its own empty tile', () => {
    const world = delveOn(altarSpec());
    const placed = world.props();

    const cells = placed.map((p) => `${String(p.x)},${String(p.y)}`);
    expect(new Set(cells).size, 'two props share a tile').toBe(cells.length);

    for (const prop of placed) {
      expect(
        world.actorAt(prop.x, prop.y),
        `a prop was placed under a body at ${String(prop.x)},${String(prop.y)}`,
      ).toBeUndefined();
    }
  });

  /**
   * ═══ AND AN ORDINARY DELVE IS NOT DRESSED ═══
   * The pass hangs off the boss, which exists in exactly one room. Without this
   * the first assertion would pass just as well against a build that scattered
   * sigils through every corridor in the game.
   */
  it('leaves a delve with no boss undressed', () => {
    // FILTERED TO REAL DELVES FIRST. `specFor` answers undefined for a site that
    // is not a delve at all, and `undefined?.boss === undefined` is true — so a
    // bare `find` hands back a non-delve, which then reads as "not found".
    const plain = [...SITES.keys()]
      .map((id) => specFor(id))
      .filter((spec): spec is DelveSpec => spec !== undefined)
      .find((spec) => spec.boss === undefined);
    if (plain === undefined) throw new Error('every delve has a boss — the premise is gone');

    expect(delveOn(plain).props()).toEqual([]);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DETERMINISM — AND THIS TEST CANNOT SEE THE THING IT WAS WRITTEN FOR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `rng.ts` states that `fork` does NOT advance the parent, which is why the
   * dressing pass can exist at all: `world.rng.int` here would have re-rolled
   * the monsters, the litter and the lore note of every delve any player has
   * ever walked into.
   *
   * BE HONEST ABOUT WHAT IS ASSERTED. Two runs of the same seed agreeing proves
   * the pass is DETERMINISTIC; it would agree just as well if the dressing had
   * shifted the stream, because both runs shift identically. The evidence that
   * the stream did NOT move is external to this file: `delve-scaling.test.ts`
   * and the rest of the suite pin populations that were authored before this
   * pass existed, and they still pass.
   *
   * Determinism is worth pinning on its own — a placement that drifted between
   * two builds of one floor would desync two clients of one party.
   */
  it('builds the same floor twice from one seed', () => {
    const spec = altarSpec();
    const world = createWorld('fork-proof');
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    const monsters = populateDelve(world, map, spec);

    // The same floor, built again: the dressing must not have moved the stream
    // between the boss and the litter that follows it.
    const again = createWorld('fork-proof');
    again.level.tiles.fill(TileCode.FLOOR);
    const secondMap: AuthoredMap = {
      view: again.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    expect(populateDelve(again, secondMap, spec)).toBe(monsters);
    expect(again.groundItems().map((g) => g.itemId)).toEqual(
      world.groundItems().map((g) => g.itemId),
    );
  });
});
