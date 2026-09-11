import { describe, expect, it } from 'vitest';

import { blocksSightAt, canWalk } from '../../src/shared/level.ts';
import { SiteShape, makeSiteMap } from '../../src/shared/sitemap.ts';
import { ALL_VAULTS } from '../../src/shared/vaults.ts';
import {
  TileCode,
  blocksSight,
  isKnownTile,
  isSafeGround,
  isWalkable,
} from '../../src/shared/protocol.ts';
import type { LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR PAIR, AS TERRAIN — `data/general/grids/basic.lua:217-238`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * newEntity{ define_as = "DOOR",
 *   block_sight = true, is_door = true, door_opened = "DOOR_OPEN", dig = "FLOOR" }
 * newEntity{ define_as = "DOOR_OPEN",
 *   is_door = true, door_closed = "DOOR" }
 * ```
 *
 * Nothing here opens anything — that is the move pipeline's half. This file
 * pins the half that is pure: what the two codes ARE to every predicate that
 * reads terrain, which is what the renderer, the FOV trace and both
 * pathfinders all consult.
 *
 * ═══ WHY EACH ASSERTION IS A PAIR AND NOT A VALUE ═══
 * Every rule below is stated as a DIFFERENCE between the two codes rather than
 * as a fact about one. A test that only said `isWalkable(DOOR_OPEN) === true`
 * passes just as well when a careless edit adds BOTH codes to `WALKABLE` — and
 * that edit is the plausible one, because the two live on adjacent lines and
 * are named almost the same. The difference is the mechanic; a value is not.
 */

describe('a closed door and an open one are opposites in both predicates', () => {
  it('is solid shut and walkable open', () => {
    expect(isWalkable(TileCode.DOOR), 'a shut door let a body through').toBe(false);
    expect(isWalkable(TileCode.DOOR_OPEN), 'an open door blocked a body').toBe(true);
  });

  it('is opaque shut and transparent open', () => {
    /**
     * `block_sight = true` on DOOR and ABSENT on DOOR_OPEN. This is the half a
     * port forgets, because "a door blocks you" is obvious and "a door blinds
     * you" is the tactical content: a corridor with a shut door in it is a
     * corridor you cannot see down, and opening one is a way of LOOKING.
     *
     * ═══ ONLY THE SECOND LINE IS A TEST. MEASURED, NOT ASSUMED. ═══
     * `blocksSight` fails CLOSED (:595 `return true`), so a code in neither set
     * is opaque anyway. Deleting `TileCode.DOOR` from `BLOCKS_SIGHT` was tried
     * against this file and all six assertions stayed green — the first line
     * below is true of the DEFAULT and would be true of a build that had never
     * heard of doors. It is kept because the answer it states is the one we
     * want and a reader should see it stated, not because it guards anything.
     *
     * The second line is the whole guard. It fails the moment `DOOR_OPEN` joins
     * `BLOCKS_SIGHT` — which is the mistake that is actually available here,
     * the two codes being adjacent and nearly homographic — and that mistake
     * fogs the room beyond every door the party just opened.
     */
    expect(blocksSight(TileCode.DOOR), 'you could see through a shut door').toBe(true);
    expect(blocksSight(TileCode.DOOR_OPEN), 'an open doorway still blinded you').toBe(false);
  });

  it('never lands in the fail-closed default — both are codes this build knows', () => {
    // `isKnownTile` is derived from `Object.values(TileCode)`, so this cannot
    // fail by omission. It can fail if either code is REMOVED, which is the
    // point: `tileAt` collapses an unknown code to WALL, and a DOOR_OPEN
    // collapsed to WALL is a route the client refuses to walk.
    expect(isKnownTile(TileCode.DOOR)).toBe(true);
    expect(isKnownTile(TileCode.DOOR_OPEN)).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT IS NOT SYMMETRICAL, AND IS THE REASON `miniFill` HAS A BRANCH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `isSafeGround` is `isWalkable(code) && !isHaunt(code)`, and an open door
 * satisfies both halves by accident: it is walkable, and `HAUNTS` is a list of
 * WILD OVERWORLD GROUND that nothing indoors was ever meant to be measured
 * against. So the predicate answers TRUE for a doorway in a delve.
 *
 * That is not a bug in `isSafeGround` — it is a question that has no meaning
 * indoors, being asked indoors. It IS a bug in any caller that draws or places
 * by it without excluding doors first, and there are two such callers:
 * `mapview.ts`'s `miniFill`, which now branches on the pair BEFORE reaching the
 * safe-network colour, and the gateway's roamer placement, which only ever runs
 * on the overworld and so cannot see a door at all.
 *
 * ASSERTED RATHER THAN FIXED, deliberately. Adding `DOOR_OPEN` to `HAUNTS`
 * would make this line green and would be a lie: `HAUNTS` decides where the
 * world may put a roamer, and a delve's doorway is not overworld ambush
 * country. The honest record is that the predicate says this, that we know, and
 * that the fix lives at the call site.
 */
describe('isSafeGround answers a question that has no meaning indoors', () => {
  it('calls an open doorway SAFE GROUND, which is why miniFill branches first', () => {
    expect(isSafeGround(TileCode.DOOR_OPEN)).toBe(true);
    // And a shut one is not, only because it is not walkable.
    expect(isSafeGround(TileCode.DOOR)).toBe(false);
  });
});

/**
 * The level-level wrappers, which are what every caller in the game actually
 * uses. `canWalk`/`blocksSightAt` read through `tileAt`, so this drives the
 * whole chain — an addition to `TileCode` that never reached `isKnownTile`
 * would come out of `tileAt` as `WALL` and these would disagree with the
 * predicates above while every assertion in the first block still passed.
 */
describe('through tileAt, which is the path the renderer and the FOV trace take', () => {
  const levelWith = (code: TileCode): LevelView => ({
    w: 3,
    h: 3,
    tiles: [
      TileCode.FLOOR,
      TileCode.FLOOR,
      TileCode.FLOOR,
      TileCode.FLOOR,
      code,
      TileCode.FLOOR,
      TileCode.FLOOR,
      TileCode.FLOOR,
      TileCode.FLOOR,
    ],
  });

  it('carries the shut door through as solid and opaque', () => {
    const level = levelWith(TileCode.DOOR);
    expect(canWalk(level, 1, 1), 'tileAt lost the door and answered FLOOR').toBe(false);
    expect(blocksSightAt(level, 1, 1)).toBe(true);
  });

  it('carries the open door through as floor in both respects', () => {
    const level = levelWith(TileCode.DOOR_OPEN);
    expect(canWalk(level, 1, 1), 'an open doorway was solid through tileAt').toBe(true);
    expect(blocksSightAt(level, 1, 1), 'an open doorway blinded an eye through tileAt').toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOORS ON A FLOOR SOMEBODY WILL ACTUALLY WALK INTO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `+` is upstream's own glyph for a door (`basic.lua:221` gives the DOOR entity
 * `display = '+'`), and three of the seven rooms in `vaults.ts` carry one —
 * each of them a room whose prose already called something a door before there
 * was a code for it.
 *
 * THIS BLOCK IS THE POSITIVE CONTROL FOR `sitemap.test.ts`. The two "only the
 * codes it was given" tests over there now DELETE `DOOR` from the set before
 * comparing, which is exactly the shape that passes when no door is ever
 * placed. Something has to assert that one lands.
 */
describe('doors reach a generated floor', () => {
  const doorsIn = (tiles: readonly number[]): number =>
    tiles.filter((code) => code === TileCode.DOOR).length;

  it('is drawn in three of the seven rooms, and in none of the others by accident', () => {
    const withDoor = ALL_VAULTS.filter((vault) => vault.tiles.includes(TileCode.DOOR));
    expect(withDoor.map((vault) => vault.id).sort()).toEqual([
      'vault:clerks_box',
      'vault:filing_chamber',
      'vault:sealed_shaft',
    ]);
  });

  it('lands on a built floor, shut', () => {
    const map = makeSiteMap('door-seed-0', SiteShape.Works);
    expect(doorsIn(map.view.tiles), 'no door reached a floor that rolled a room with one').toBe(1);
    // SHUT, because nothing has walked into it. An open door on a freshly
    // generated floor would mean the generator was writing the wrong half.
    expect(map.view.tiles).not.toContain(TileCode.DOOR_OPEN);
  });

  it('SURVIVES A PALETTE REPAINT, which it did not before this was written', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE REPAINT RAN AFTER THE VAULT STAMP AND ATE EVERY DOOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `makeSiteMap`'s post-pass maps FLOOR to the palette's floor and treats
     * EVERYTHING ELSE as solid. A door is not FLOOR, so it took the solid
     * branch and came out as `roof` — a wall, in the one tile that was the only
     * way into the room. Nothing about that is visible on the default palette,
     * which skips the pass entirely, so it would have shipped for every painted
     * site and nowhere else.
     */
    const plain = makeSiteMap('door-seed-0', SiteShape.Works);
    const painted = makeSiteMap('door-seed-0', SiteShape.Works, {
      floor: TileCode.SOOT,
      wall: TileCode.CRAG,
    });
    expect(doorsIn(painted.view.tiles), 'the repaint painted the door into the wall').toBe(
      doorsIn(plain.view.tiles),
    );
    // AND IT IS STILL A DOOR, not merely still one tile of something.
    expect(painted.view.tiles).toContain(TileCode.DOOR);
  });

  it('never puts one in a town', () => {
    // `VAULTS_BY_SHAPE.town` is empty by design — *"a vault there would be a
    // building among buildings"* — so a door appearing in one means a room
    // leaked into a shape that is supposed to have none.
    for (let i = 0; i < 30; i += 1) {
      const map = makeSiteMap(`town-${String(i)}`, SiteShape.Town);
      expect(doorsIn(map.view.tiles), 'a vault door appeared in a town').toBe(0);
    }
  });
});
