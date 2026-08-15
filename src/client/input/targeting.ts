/**
 * TARGETING MODE: the range ring, the `min_range` hole, LOS greying and the
 * shape preview, plus the cursor that both the mouse and the keyboard steer.
 *
 * ===========================================================================
 * EVERY CHECK IN THIS FILE IS ADVISORY. THE SERVER RE-VALIDATES ALL OF IT.
 * ===========================================================================
 *
 * That sentence is the contract, and it is not a disclaimer — it is the design.
 * Nothing here gates a frame: `confirm()` on an illegal tile still sends the
 * `talent` message, because the alternative is a client that silently swallows
 * an input on the strength of its own arithmetic. The server owns range, the
 * dead zone, line of sight, cooldowns and cost (see `canAttack` in
 * src/server/engine/combat.ts and the five M3 `ErrorCode` members in
 * protocol.ts), and when it disagrees with this file the answer arrives as an
 * `error` frame and the player is told which rule they broke.
 *
 * So what is this for? For the player to SEE the rule before they spend a turn
 * on it. The ring is a picture of a constraint, not an enforcement of one.
 *
 * ---------------------------------------------------------------------------
 * THE DEAD ZONE IS THE POINT
 * ---------------------------------------------------------------------------
 * game-design.md § 2 calls the Inspector's `min_range 3` "the single most
 * important number here": she cannot shoot an adjacent enemy, which is the
 * entire reason the Watchman holding a choke is worth anything. A dead zone the
 * player cannot see does not read as a positional class, it reads as a broken
 * one — the shot just fails and nobody learns why. So the hole is drawn as its
 * own marker art, it is drawn BEFORE anything else can claim those cells, and
 * it is CIRCULAR:
 *
 *     minRange 3, the target at (3,3) -> Euclidean 2.83 -> INSIDE the hole.
 *
 * That is Euclidean because `combatDistance` on the server is Euclidean
 * (`core.fov.distance`), and a Chebyshev ring would be a square that reaches
 * 7.07 tiles into its corners. The client drawing a square while the server
 * checks a circle is a lie in exactly the corners a player aims into.
 *
 * ---------------------------------------------------------------------------
 * TWO LAYERS, RECOMPUTED AT DIFFERENT RATES
 * ---------------------------------------------------------------------------
 * THE RING depends only on the caster's tile and the talent, so it is built
 * once when the mode opens and rebuilt only when the world moves under it. THE
 * STAMP — the AoE shape and the cursor — depends on the cursor and is rebuilt on
 * every hover and every arrow key. A range-7 ring is ~150 cells each doing a
 * short Bresenham walk; doing that on every mousemove would be the one hot loop
 * in a game that otherwise draws only when something changes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT KNOW
 * ---------------------------------------------------------------------------
 * Actors. It takes tiles. `begin()` accepts a list of candidate tiles (main.ts
 * passes the hostiles it can see) purely to pick a sensible opening cursor, and
 * never consults them again. Keeping the geometry free of the actor list is what
 * lets the same code aim a heal at an ally, a bolt at a monster and a vial at
 * bare floor.
 */

import { bresenham, DIR_VECTORS, inBounds } from '../../shared/coords.ts';
import { tileAt } from '../../shared/level.ts';
import { TalentShape, TileCode } from '../../shared/protocol.ts';
import { MarkerKind } from '../render/canvas.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { LevelView, LoadoutTalent } from '../../shared/protocol.ts';
import type { TargetCell } from '../render/canvas.ts';

/**
 * Why a tile is not a legal aim point — the client's OPINION, which the server
 * may overrule in either direction.
 *
 * Deliberately parallel to `AttackRefusal` on the server and to the five M3
 * `ErrorCode` members on the wire, so that a refusal arriving from the server
 * and a refusal predicted here produce the same sentence. Two vocabularies for
 * "too close" would eventually give a player one message while hovering and a
 * different one after pressing the key.
 */
export const TargetAdvice = {
  Ok: 'ok',
  /** Inside `minRange`. The dead zone. */
  TooClose: 'too_close',
  /** Beyond `range`, or off the map entirely. */
  OutOfRange: 'out_of_range',
  /** A wall between the caster and the tile. */
  NoLos: 'no_los',
  /** The tile itself is a wall, or a `tile` shape aimed where a body stands. */
  Blocked: 'blocked',
  /** A `single` shape aimed at bare floor — it needs a body to name. */
  NoTarget: 'no_target',
} as const;
export type TargetAdvice = (typeof TargetAdvice)[keyof typeof TargetAdvice];

/** The world as targeting needs it: geometry, a caster, and somewhere to start. */
export type TargetingWorld = {
  readonly level: LevelView | null;
  /** The caster's tile. Null before `welcome`, in which case nothing opens. */
  readonly origin: TileXY | null;
  /**
   * Tiles worth opening the cursor on — main.ts passes visible hostiles. Read
   * ONCE, in `begin()`. An empty list is fine and common (aiming at floor).
   */
  readonly candidates?: readonly TileXY[];
  /**
   * Every tile a LIVING body stands on, the caster included.
   *
   * Two shapes need it and they need opposite answers: `single` names an actor,
   * so bare floor is not a target; `tile` is somewhere to STAND (Fog Step), so
   * an occupied square is not a destination. protocol.ts asks for both in as
   * many words. Re-read on every `refresh`, because bodies move every turn and
   * an occupancy set cached at `begin()` would be a turn stale by the time
   * anyone pressed Enter.
   */
  readonly occupied?: readonly TileXY[];
};

export type TargetingOptions = {
  /** Something drawable changed: the mode opened, the cursor moved, it closed. */
  readonly onChange: () => void;
  /**
   * The player committed. Called with the talent and the tile EVEN WHEN THIS
   * FILE BELIEVES THE TILE IS ILLEGAL — see the header. main.ts sends it and
   * lets the server rule.
   */
  readonly onCommit: (talent: LoadoutTalent, tile: TileXY) => void;
};

export type Targeting = {
  /**
   * Open the mode. Returns false when there is nothing to aim — a `self` shape,
   * or no level/origin yet — and the caller should fire the talent directly.
   */
  readonly begin: (talent: LoadoutTalent, world: TargetingWorld) => boolean;
  /** Re-anchor on the caster's current tile. Call after the board moves. */
  readonly refresh: (world: TargetingWorld) => void;
  readonly active: () => boolean;
  /** The talent being aimed, or null. */
  readonly talent: () => LoadoutTalent | null;
  readonly cursor: () => TileXY | null;
  /** The ring, the wash, the stamp and the cursor marker, in paint order. */
  readonly cells: () => readonly TargetCell[];
  /** This client's opinion of the cursor tile. */
  readonly advice: () => TargetAdvice;
  /** One line of prose for the HUD. Empty when the mode is closed. */
  readonly hint: () => string;
  /** Keyboard steering. One tile, clamped to the map, NOT to the range. */
  readonly moveCursor: (dir: Dir) => void;
  /** Mouse steering. Null (pointer left the playfield) is ignored, not a close. */
  readonly hover: (tile: TileXY | null) => void;
  /** Fire. Returns false when the mode was not open. Closes the mode. */
  readonly confirm: () => boolean;
  /** Escape, a right-click, a `welcome`, or a refusal the player has read. */
  readonly cancel: () => void;
};

/** Euclidean, matching `combatDistance` (`core.fov.distance`) on the server. */
function distance(a: TileXY, b: TileXY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Walls block. Endpoints excluded.
 *
 * A DELIBERATE REIMPLEMENTATION of `hasLineOfSight` in src/server/world/world.ts
 * — six lines over the shared, symmetric `bresenham`, which coords.ts says in as
 * many words exists for "line of sight, bolt paths and targeting previews". It
 * is not a second copy of a FORMULA: there is no arithmetic here that could
 * diverge into a wrong number, only the same integer walk over the same tile
 * array, and the alternative is a client that cannot draw the one thing M3's
 * definition of done asks it to draw. `client -> server` imports are banned and
 * correctly so.
 *
 * Bresenham's forced symmetry is what makes it usable: `los(a, b)` and
 * `los(b, a)` cannot disagree, so the ring never offers a shot the server will
 * refuse for a corner the player cannot see.
 */
function hasLineOfSight(level: LevelView, from: TileXY, to: TileXY): boolean {
  const line = bresenham(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (tileAt(level, tile.x, tile.y) === TileCode.WALL) return false;
  }
  return true;
}

/**
 * Which tiles a talent stamps when aimed at `at`.
 *
 * The shapes are the importer's vocabulary (docs/data-schemas.md § 5 rule R8),
 * so this switch is exhaustive over `TalentShape` with no default: adding a cone
 * in M5 breaks it here and names itself, instead of silently previewing a cone
 * as a single tile.
 */
function stampTiles(
  shape: TalentShape,
  radius: number,
  origin: TileXY,
  at: TileXY,
): readonly TileXY[] {
  const r = Math.max(0, Math.floor(radius));
  switch (shape) {
    // One actor (Revolver Shot, Mend Wounds) or one free tile to stand on (Fog
    // Step). Both stamp exactly the tile under the cursor; what differs is which
    // tiles are LEGAL, and that is the ring's business rather than the stamp's.
    case TalentShape.Single:
    case TalentShape.Tile:
      return [at];
    case TalentShape.Self:
      return [origin];
    case TalentShape.Ball: {
      const tiles: TileXY[] = [];
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          // Euclidean, so a ball is a disc. A Chebyshev "ball" would be a square
          // and would over-promise by 41% along the diagonals.
          if (Math.sqrt(dx * dx + dy * dy) > r) continue;
          tiles.push({ x: at.x + dx, y: at.y + dy });
        }
      }
      return tiles;
    }
    case TalentShape.Cross: {
      const tiles: TileXY[] = [at];
      for (let step = 1; step <= r; step += 1) {
        tiles.push({ x: at.x + step, y: at.y });
        tiles.push({ x: at.x - step, y: at.y });
        tiles.push({ x: at.x, y: at.y + step });
        tiles.push({ x: at.x, y: at.y - step });
      }
      return tiles;
    }
  }
}

export function createTargeting(options: TargetingOptions): Targeting {
  let talent: LoadoutTalent | null = null;
  let level: LevelView | null = null;
  let origin: TileXY | null = null;
  let cursor: TileXY | null = null;
  /** The range/hole/wash layer. Rebuilt only when the origin or talent changes. */
  let ring: readonly TargetCell[] = [];
  /** `${x},${y}` of every living body. Refreshed whenever the board moves. */
  let occupied = new Set<string>();

  function close(): void {
    talent = null;
    level = null;
    origin = null;
    cursor = null;
    ring = [];
    occupied = new Set();
  }

  function tileKey(tile: TileXY): string {
    return `${tile.x},${tile.y}`;
  }

  function setOccupancy(tiles: readonly TileXY[]): void {
    occupied = new Set(tiles.map(tileKey));
  }

  /**
   * This client's opinion of one tile.
   *
   * The order of the tests is the order the player needs to hear them in: "too
   * close" must never be reported as "out of range", because they are opposite
   * instructions and a player told to back off while standing on the target
   * concludes the class is broken.
   */
  function adviseTile(tile: TileXY): TargetAdvice {
    if (talent === null || level === null || origin === null) return TargetAdvice.OutOfRange;
    if (!inBounds(tile.x, tile.y, level.w, level.h)) return TargetAdvice.OutOfRange;

    const d = distance(origin, tile);
    if (d > talent.range) return TargetAdvice.OutOfRange;
    // `<`, not `<=`: minRange 3 makes 3 the closest LEGAL tile, matching both the
    // authored `min_range` in content/skills/*.json and `canAttack`.
    if (talent.minRange > 0 && d < talent.minRange) return TargetAdvice.TooClose;
    if (tileAt(level, tile.x, tile.y) === TileCode.WALL) return TargetAdvice.Blocked;
    // Adjacent needs no sight check — you are standing on them. Mirrors the
    // `distance > 1` guard in `canAttack`.
    if (d > 1 && !hasLineOfSight(level, origin, tile)) return TargetAdvice.NoLos;

    // OCCUPANCY, LAST, and only for the two shapes that care. It is checked
    // after geometry because geometry is what the player can fix by moving; a
    // Fog Step onto a friend's square is a re-aim, not a repositioning problem,
    // and reporting it before "out of range" would send someone walking.
    const body = occupied.has(tileKey(tile));
    if (talent.shape === TalentShape.Single && !body) return TargetAdvice.NoTarget;
    if (talent.shape === TalentShape.Tile && body) return TargetAdvice.Blocked;
    return TargetAdvice.Ok;
  }

  /**
   * The ring: every tile the talent could reach, classified once.
   *
   * A cell is in exactly one of four states and they are tested in this order —
   * hole, then wall, then unsighted, then legal. The hole wins outright because
   * it is the constraint the player most needs to see; a cell that is both
   * inside the dead zone and behind a wall is drawn as the dead zone, because
   * walking closer will not fix it.
   *
   * THE RING ANSWERS GEOMETRY ONLY — reach, the dead zone, sight — and NOT
   * occupancy, even though `adviseTile` does. That is deliberate: for a `single`
   * shape every empty floor tile in reach would otherwise be marked unavailable,
   * which is most of the ring, and the picture the player needs ("how far can I
   * see and shoot from here") would be buried under the picture they already
   * have ("there is nobody standing there"). Occupancy is carried by the cursor
   * marker and the hint, which is where a per-tile answer belongs.
   */
  function buildRing(): void {
    const active = talent;
    const lv = level;
    const from = origin;
    if (active === null || lv === null || from === null) {
      ring = [];
      return;
    }

    const cells: TargetCell[] = [];
    const reach = Math.max(0, Math.floor(active.range));
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = from.x + dx;
        const y = from.y + dy;
        if (!inBounds(x, y, lv.w, lv.h)) continue;
        if (Math.sqrt(dx * dx + dy * dy) > reach) continue;

        // The caster's own tile is part of the HOLE when there is one — "you
        // cannot shoot what is standing on you" is exactly the thing the
        // Inspector's player has to learn — but it is not decorated with a
        // "valid" marker when there is no hole, where it would be noise under
        // the token the camera is centred on.
        const isOrigin = dx === 0 && dy === 0;
        if (isOrigin && active.minRange <= 0) continue;

        // Walls are already the most legible thing on the map. Marking them
        // would put a marker on every cell of a corridor wall and bury the ring.
        if (tileAt(lv, x, y) === TileCode.WALL) continue;

        const d = Math.sqrt(dx * dx + dy * dy);
        if (active.minRange > 0 && d < active.minRange) {
          cells.push({ x, y, marker: MarkerKind.MinRange, shaded: false });
          continue;
        }
        if (d > 1 && !hasLineOfSight(lv, from, { x, y })) {
          // LOS-GREYING: a wash and no marker. An unavailable tile must never be
          // busier than an available one.
          cells.push({ x, y, marker: null, shaded: true });
          continue;
        }
        cells.push({ x, y, marker: MarkerKind.Valid, shaded: false });
      }
    }
    ring = cells;
  }

  /** The nearest candidate the client believes is legal, or null. */
  function pickOpeningCursor(candidates: readonly TileXY[]): TileXY | null {
    const from = origin;
    if (from === null) return null;

    let best: TileXY | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const tile of candidates) {
      if (adviseTile(tile) !== TargetAdvice.Ok) continue;
      const d = distance(from, tile);
      // Ties broken on x then y so two clients aiming the same talent at the
      // same board open on the same tile. Nothing depends on it today; a
      // spectator view in M7 would.
      if (d < bestD || (d === bestD && best !== null && (tile.x - best.x || tile.y - best.y) < 0)) {
        best = tile;
        bestD = d;
      }
    }
    if (best !== null) return best;

    // Nothing hostile in reach. Fall back to the first legal cell of the ring so
    // the cursor never opens on a tile the player must first fix.
    for (const cell of ring) {
      if (cell.marker === MarkerKind.Valid) return { x: cell.x, y: cell.y };
    }
    return null;
  }

  function begin(next: LoadoutTalent, world: TargetingWorld): boolean {
    // A mode with exactly one legal target is a mode that wastes a keypress.
    if (next.shape === TalentShape.Self) return false;
    if (world.level === null || world.origin === null) return false;

    talent = next;
    level = world.level;
    origin = world.origin;
    // Occupancy before the ring and before the opening pick: `pickOpeningCursor`
    // calls `adviseTile`, which consults it, so a stale set would open a
    // `single` cursor on bare floor.
    setOccupancy(world.occupied ?? []);
    buildRing();
    cursor = pickOpeningCursor(world.candidates ?? []) ?? world.origin;
    options.onChange();
    return true;
  }

  /**
   * Re-anchor after the board moved.
   *
   * The caster can be shoved by a monster while the mode is open (Backdraft
   * pushes, and so will monsters), and a ring still drawn around where they used
   * to stand is worse than no ring: it is a picture of a rule that is no longer
   * true. The cursor is deliberately KEPT — the player is aiming at a thing, and
   * moving their aim because they got shoved would be the UI taking the shot
   * away from them.
   */
  function refresh(world: TargetingWorld): void {
    if (talent === null) return;
    if (world.level === null || world.origin === null) {
      cancel();
      return;
    }
    const moved = origin === null || origin.x !== world.origin.x || origin.y !== world.origin.y;
    level = world.level;
    origin = world.origin;
    // ALWAYS, not just when the caster moved: bodies shuffle every sweep, and a
    // Fog Step that still shows a landing square somebody has since walked onto
    // is the same lie as a stale ring, one tile smaller.
    setOccupancy(world.occupied ?? []);
    if (moved) {
      buildRing();
    }
    // A redraw regardless — the hint and the cursor marker are functions of the
    // occupancy that just changed, even when the ring itself did not.
    options.onChange();
  }

  function setCursor(tile: TileXY): void {
    if (cursor !== null && cursor.x === tile.x && cursor.y === tile.y) return;
    cursor = tile;
    options.onChange();
  }

  function moveCursor(dir: Dir): void {
    const lv = level;
    const at = cursor;
    if (talent === null || lv === null || at === null) return;

    // Steering is clamped to the MAP, never to the range: walking the cursor out
    // of the ring and watching it go red is how a player learns what the number
    // means. A cursor that refuses to leave the circle teaches nothing and feels
    // like a stuck key.
    const v = DIR_VECTORS[dir];
    const x = Math.min(Math.max(at.x + v.dx, 0), lv.w - 1);
    const y = Math.min(Math.max(at.y + v.dy, 0), lv.h - 1);
    setCursor({ x, y });
  }

  function hover(tile: TileXY | null): void {
    // Null means the pointer is on the letterbox or off the map. That is NOT a
    // cancel and must not move the cursor: the player's hand drifting off the
    // canvas mid-decision would otherwise throw away their aim.
    if (talent === null || tile === null) return;
    setCursor(tile);
  }

  function confirm(): boolean {
    const active = talent;
    const at = cursor;
    if (active === null || at === null) return false;
    // SENT EVEN WHEN THIS FILE SAYS IT IS ILLEGAL. See the header: the server is
    // the authority, and a client that eats the input on its own arithmetic is
    // the silent no-op this whole file exists to prevent. An illegal aim costs
    // one `error` frame and prints a sentence.
    close();
    options.onCommit(active, at);
    options.onChange();
    return true;
  }

  function cancel(): void {
    if (talent === null) return;
    close();
    options.onChange();
  }

  function cells(): readonly TargetCell[] {
    const active = talent;
    const at = cursor;
    if (active === null || at === null) return ring;
    const lv = level;
    const from = origin;
    if (lv === null || from === null) return ring;

    const out: TargetCell[] = [...ring];

    // The stamp, over the ring. Walls inside an AoE are skipped so the preview
    // shows where the vial actually lands rather than painting the wall it
    // splashes against.
    for (const tile of stampTiles(active.shape, active.radius, from, at)) {
      if (!inBounds(tile.x, tile.y, lv.w, lv.h)) continue;
      if (tileAt(lv, tile.x, tile.y) === TileCode.WALL) continue;
      out.push({ x: tile.x, y: tile.y, marker: MarkerKind.Aoe, shaded: false });
    }

    // The cursor itself, last, so nothing in the stamp covers it. `invalid` art
    // rather than `cursor` art when this client expects a refusal — a different
    // SHAPE, not a different colour, because roughly one man in twelve cannot
    // separate the red one from the green one and the Discord overlay is not
    // colour-managed.
    const ok = adviseTile(at) === TargetAdvice.Ok;
    out.push({
      x: at.x,
      y: at.y,
      marker: ok ? MarkerKind.Cursor : MarkerKind.Invalid,
      shaded: false,
    });
    return out;
  }

  /**
   * The sentence under the hotbar.
   *
   * "too close — needs 3 tiles" and not "invalid target": a refusal is the only
   * teaching moment a targeting mode has, and the number is the entire lesson.
   */
  function hint(): string {
    const active = talent;
    const at = cursor;
    if (active === null || at === null) return '';

    switch (adviseTile(at)) {
      case TargetAdvice.TooClose:
        return `too close — ${active.name} needs ${active.minRange} tiles`;
      case TargetAdvice.OutOfRange:
        return `out of range — ${active.name} reaches ${active.range} tiles`;
      case TargetAdvice.NoLos:
        return 'no line of sight — something is in the way';
      case TargetAdvice.Blocked:
        // Two ways to be blocked, and the instruction differs: back off a wall,
        // pick another square for a body. `tile` is the only shape that can hit
        // the second.
        return active.shape === TalentShape.Tile
          ? 'something is standing there — pick an empty tile'
          : 'that is a wall';
      case TargetAdvice.NoTarget:
        return `${active.name} needs a target — nothing is standing there`;
      case TargetAdvice.Ok:
        return `${active.name} → ${at.x},${at.y} — enter or click to fire · esc cancels`;
    }
  }

  return {
    begin,
    refresh,
    active: () => talent !== null,
    talent: () => talent,
    cursor: () => cursor,
    cells,
    advice: () => (cursor === null ? TargetAdvice.OutOfRange : adviseTile(cursor)),
    hint,
    moveCursor,
    hover,
    confirm,
    cancel,
  };
}
