// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Game.lua:2064-2098 (`RUN_AUTO`)
// and class/interface/PlayerExplore.lua:1822+ (`autoExplore`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTO-EXPLORE — where is there left to go?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT THIS COSTS WITHOUT IT ═══
 * Every room of every floor is hand-walked, one keypress a tile. It is the
 * second-largest sink of a player's evening after resting, and `engine/actor.ts`
 * already names the hole out loud: *"`travel` / `explore` / `rest` / `follow`
 * join it once those exist"*.
 *
 * ═══ IT IS A TARGET, AND NOTHING ELSE ═══
 * The whole feature is "which tile should I walk to next" — the WALKING is
 * `input/travel.ts`, which already exists and already carries every interrupt
 * rule (a hostile coming into view, being hit, a refusal from the server, a
 * disconnect). Auto-explore that reimplemented any of that would be a second
 * traveller with a second set of stopping rules, and the first one to drift
 * would be the one that stops for monsters.
 *
 * So this module answers a question and never moves anybody.
 *
 * ═══ A BREADTH-FIRST FLOOD, WHICH IS UPSTREAM'S SHAPE TOO ═══
 * `PlayerExplore.lua`'s `autoExplore` floods the map and scores what it finds.
 * A flood is also the only cheap way to get NEAREST-BY-PATH rather than
 * nearest-by-line: running A* to every candidate would be one search per
 * unexplored tile, and the answer would still be wrong if the near one is behind
 * a wall.
 *
 * ═══ WHAT IT AIMS AT, AND WHAT IS NOT PORTED YET ═══
 * Upstream targets unseen tiles, unseen singlets, unvisited items, special
 * terrain, unopened doors, exits and orb portals, with GREED WEIGHTS
 * (`:1856-1859`) that let a distant item outrank a near corner. Two of those
 * have a referent here — unexplored ground, and items on the floor — and this
 * takes them. The rest name things this game does not have (there are no doors
 * to open and no orb portals), and the weights are a refinement rather than the
 * feature: nearest-first with items winning a tie is honest, and it is the
 * behaviour a player expects the first hundred times.
 */

import type { TileXY } from '../../shared/coords.ts';

/** Why auto-explore did not move anybody. */
export const ExploreStop = {
  /**
   * Something hostile is in sight. Upstream refuses for the same reason and
   * NAMES what it saw with a compass bearing (Game.lua:2078-2079) — a refusal
   * that does not say what stopped it is an alarm with no information in it,
   * which is the argument `src/shared/rest.ts` makes about the same case.
   */
  Hostile: 'hostile',
  /** Upstream's own sentence: "There is nowhere left to explore". */
  Done: 'done',
  /** There is somewhere, and no walkable route to it from here. */
  Unreachable: 'unreachable',
} as const;
export type ExploreStop = (typeof ExploreStop)[keyof typeof ExploreStop];

export type ExploreAnswer =
  | { readonly go: true; readonly to: TileXY; readonly item: boolean }
  | {
      readonly go: false;
      readonly stop: ExploreStop;
      readonly threat?: { readonly name: string; readonly dx: number; readonly dy: number };
    };

export type ExploreView = {
  readonly from: TileXY;
  readonly w: number;
  readonly h: number;
  /** Can a body stand here? The caller's own walkability, never a second copy. */
  readonly passable: (x: number, y: number) => boolean;
  /** Has the viewer seen this cell? `explored` is keyed `"x,y"` per realm. */
  readonly seen: ReadonlySet<string>;
  /** Tiles holding something on the floor. Upstream's "unvisited items". */
  readonly items: readonly TileXY[];
  /** The nearest hostile the viewer can see, or null. Resolved by the caller. */
  /**
   * The nearest hostile THE VIEWER CAN SEE, as an offset, or null.
   *
   * "Can see" is the caller's job and is load-bearing: since FOV the actor list
   * is the PARTY'S union, so a body being on the board is not evidence that this
   * player can see it. `main.ts#nearestVisibleHostile` applies `canSee`.
   */
  readonly threat: { readonly name: string; readonly dx: number; readonly dy: number } | null;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO EXPLORE RADIUS ANY MORE. `threat` MEANS "I CAN SEE IT".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EXPLORE_SIGHT` was 12, chosen to equal `REVEAL_RADIUS` on the argument that a
 * hostile inside it stands on ground this player has personally lit — and the
 * argument was right for its time, because `projectActors` sent every actor on
 * the map and a radius was the only filter there was.
 *
 * IT OUTLIVED THAT TWICE OVER. FOV made the list the PARTY'S union, so the
 * radius started answering a question nobody asked: it let through a husk only a
 * teammate could see (any distance, as long as it was within 12 of ME) and shut
 * out one I could see plainly at 11, because sight is 10 and the radius was 12.
 * Two filters, neither of them "can I see it".
 *
 * So the caller now hands in only what the viewer can SEE — `canSee` from this
 * body, the same rule travel and the rest check spend — and this module tests
 * `threat !== null` and nothing else. That is a CONTRACT and it is stated on the
 * field: `ExploreView.threat` is a hostile the viewer can see, or null.
 *
 * ═══ WHY THE TEST DID NOT MOVE IN HERE ═══
 * `canSee` needs a `LevelView` to ask `blocksSightAt`, and this module
 * deliberately takes a `passable` PREDICATE rather than a map — that is what
 * makes "does it stop for a husk" a unit test rather than a session. Handing it
 * a level to keep the rule local would trade that for tidiness.
 */

/**
 * Where to go next, or why not.
 *
 * PURE — no clock, no randomness, no canvas. The whole rule is a flood over a
 * predicate, which is what makes "does it stop for a husk" a unit test rather
 * than a session.
 */
export function exploreTarget(view: ExploreView): ExploreAnswer {
  /**
   * THE HOSTILE CHECK IS FIRST, exactly as `restCheck` puts it first and for the
   * identical reason: everything below is about where to walk, and walking is
   * the thing you must not do with something in the room.
   */
  // ONE TEST, because `threat` is already defined as something the viewer can
  // see — see the note above the view's field.
  if (view.threat !== null) {
    return { go: false, stop: ExploreStop.Hostile, threat: view.threat };
  }

  const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const itemAt = new Set(view.items.map((tile) => key(tile.x, tile.y)));

  /**
   * A CELL IS A FRONTIER IF IT IS SOMEWHERE YOU CAN STAND THAT TOUCHES SOMEWHERE
   * YOU HAVE NOT SEEN. Aiming at the unseen cell itself would be aiming at
   * something that might be solid rock — the map does not say, which is the
   * point of it being unseen.
   */
  const isFrontier = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= view.w || ny >= view.h) continue;
        if (!view.seen.has(key(nx, ny))) return true;
      }
    }
    return false;
  };

  const start = { x: Math.trunc(view.from.x), y: Math.trunc(view.from.y) };
  const visited = new Set<string>([key(start.x, start.y)]);
  let ring: TileXY[] = [start];

  while (ring.length > 0) {
    /**
     * ONE WHOLE RING AT A TIME, so "nearest" is decided across everything at the
     * same distance rather than by whichever neighbour happened to be pushed
     * first. That is what makes the item-beats-frontier tie-break below mean
     * anything.
     */
    const goals: { tile: TileXY; item: boolean }[] = [];
    const next: TileXY[] = [];

    for (const at of ring) {
      const onItem = itemAt.has(key(at.x, at.y));
      // THE TILE YOU ARE STANDING ON IS NOT A DESTINATION. Without this the
      // first press on a frontier tile answers "go where you already are", and
      // travel refuses a zero-length route — which reads as the key being dead.
      if ((at.x !== start.x || at.y !== start.y) && (onItem || isFrontier(at.x, at.y))) {
        goals.push({ tile: at, item: onItem });
      }

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = at.x + dx;
          const ny = at.y + dy;
          if (nx < 0 || ny < 0 || nx >= view.w || ny >= view.h) continue;
          const k = key(nx, ny);
          if (visited.has(k)) continue;
          visited.add(k);
          if (!view.passable(nx, ny)) continue;
          next.push({ x: nx, y: ny });
        }
      }
    }

    if (goals.length > 0) {
      /**
       * ITEMS WIN A TIE — upstream's greed, at its simplest. At equal distance a
       * player would rather pick something up than round a corner, and the
       * corner is still there afterwards.
       *
       * AND THE ORDER IS THE FLOOD'S, NOT A SORT. Two goals of the same kind at
       * the same distance are genuinely equivalent, and sorting them by
       * coordinate would make the choice look considered when it is arbitrary.
       */
      const pick = goals.find((goal) => goal.item) ?? goals[0];
      if (pick !== undefined) return { go: true, to: pick.tile, item: pick.item };
    }
    ring = next;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING FOUND — AND THE TWO REASONS ARE DIFFERENT ANSWERS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream says "There is nowhere left to explore" and means the floor is
   * done. A player walled off from the last corner of it has a different
   * problem, and telling them the floor is finished would send them looking for
   * stairs that are not the answer.
   *
   * THE QUESTION IS ASKED OF THE MAP, NOT OF THE FLOOD. Whether anything is
   * still unseen is a fact about what has been revealed; whether it can be
   * REACHED is what the flood above just failed to establish. Deciding this from
   * the flood's own leftovers is what an earlier version of this did, and it
   * answered "no way through" for a player standing on the frontier with the
   * whole floor already mapped.
   */
  for (let y = 0; y < view.h; y += 1) {
    for (let x = 0; x < view.w; x += 1) {
      if (!view.seen.has(key(x, y))) return { go: false, stop: ExploreStop.Unreachable };
    }
  }
  return { go: false, stop: ExploreStop.Done };
}

/** What the player is told. One sentence, and it always says WHY. */
export function exploreStopText(stop: ExploreStop, bearing: string, name?: string): string {
  switch (stop) {
    case ExploreStop.Hostile:
      // Upstream's own sentence shape (Game.lua:2078-2079): what, and which way.
      return `${name ?? 'Something'} to the ${bearing} — not while that is there.`;
    case ExploreStop.Done:
      return 'There is nowhere left to explore.';
    case ExploreStop.Unreachable:
      return 'There is more to see, but no way through from here.';
  }
}
