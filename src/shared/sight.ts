// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:178 (`t.sight = t.sight or 10`)
//                       game/engines/default/engine/Actor.lua:520 (canSee: distance AND line)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    HOW FAR A BODY CAN SEE, AND PAST WHAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/Actor.lua:520`:
 *
 * ```lua
 * local sees_target = (self.sight and core.fov.distance(sx, sy, tx, ty) <= self.sight
 *                      or not self.sight) and ...
 * ```
 *
 * TWO TERMS, AND BOTH ARE NECESSARY. Range alone sees through walls; line alone
 * sees to the horizon. Ours had the second and not the first: `hasLineOfSight`
 * has gated combat, talents and monster AI since M2, and nothing anywhere
 * bounded how FAR a body could see.
 *
 * ═══ THE RADIUS IS 10, AND THE FIRST VERSION OF THIS FILE SAID 20 ═══
 * IT CITED THE ENGINE AND MISSED THE MODULE. `engine/Actor.lua:47` really does
 * read `self.sight = t.sight or 20` — but ToME is a MODULE on that engine, and
 * `modules/tome/class/Actor.lua:178` sets `t.sight = t.sight or 10` inside its
 * own `init`, then delegates to `engine.Actor.init` at :264. By the time the
 * engine's line runs, `t.sight` is already 10 and the `or 20` never fires.
 * Every call site in the module agrees — `Player.lua:648`, `:854`,
 * `NPC.lua:102`, `:114`, `Game.lua:2068` all pass `self.sight or 10`.
 *
 * So a player sees TEN tiles, and shipping 20 doubled it for three commits.
 *
 * ═══ AND THE CONSTANT ALREADY EXISTED, WITH THE RIGHT VALUE ═══
 * `DEFAULT_SIGHT_RADIUS` has been in `world.ts` since M2, documented as *"how
 * far a body can SEE"*, citing `self.sight or 10`, and used by `buildRestView`
 * to decide when a rest is interrupted. It sits 26 lines above the
 * `hasLineOfSight` this file imports. A second constant was added beside it
 * with a different value because nobody searched for the concept first.
 *
 * There is one now, and this module does not own it: `world.ts` does, because
 * this file imports `hasLineOfSight` from there and the reverse would be a
 * cycle.
 *
 * ═══ EUCLIDEAN, BECAUSE `core.fov.distance` IS ═══
 * Not `chebyshev`, which this codebase uses for REACH — a weapon's range is a
 * king-move count and sight is a circle. Using the movement metric would make
 * the diagonal corners of a square visible at 20 while the cardinal edge at 21
 * was not, which is the wrong shape for a torch.
 */
import { blocksSightAt } from './level.ts';
import { bresenham } from './coords.ts';
import { fogHas } from './fog.ts';
import type { LevelView } from './protocol.ts';
import type { TileXY } from './coords.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW FAR A BODY NOTICES THINGS — ported from `self.sight or 10`
 * (Player.lua:854, inside `spotHostiles`).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS HAD TO EXIST BEFORE REST COULD ═══
 * `hasLineOfSight` answers "is anything solid between these two tiles" and
 * NOTHING ELSE — no range at all. On an open floor that is true across the whole
 * map, so the first thing built on it that means "can see" rather than "can
 * shoot" discovered the gap immediately: a rest was interrupted by a husk
 * EIGHTEEN TILES AWAY, which on any open level means nobody can ever rest.
 *
 * Upstream never had that problem because its `spotHostiles` walks a
 * `calc_circle` of radius `sight` and asks about line of sight only INSIDE it.
 * This is that radius.
 *
 * ═══ A DEFAULT, NOT A CONSTANT ═══
 * Upstream reads it off the actor (`self.sight`) and only falls back to 10, so
 * blindness, a lit radius and a telescope all have somewhere to live. Nothing
 * here carries a per-body sight yet, so every body uses this — and when one
 * does, the name already says which end wins.
 *
 * ═══ AND IT IS NOT `aggroRange` ═══
 * Monsters have their own (8 for a MeleeChaser, `AI_RANGES` in engine/actor.ts),
 * and it is a different question: how far something will START HUNTING, tuned
 * per profile so a pack does not all wake at once. This is how far a body can
 * SEE, and the asymmetry is deliberate — a husk you can see from ten tiles has
 * not necessarily noticed you.
 */
export const DEFAULT_SIGHT_RADIUS = 10;

/**
 * Line of sight between two tiles, walls blocking.
 *
 * Bresenham's symmetry is what makes this usable as a visibility test: the walk
 * is done from a canonical endpoint and reversed, so `hasLineOfSight(a, b)` and
 * `hasLineOfSight(b, a)` cannot disagree. Without that you get the oldest
 * roguelike bug report there is — the archer shoots you through a corner you
 * cannot shoot back through.
 *
 * Endpoints are excluded: standing IN a wall (a phasing monster, a door being
 * opened) must not blind you, and the target's own tile is what you are looking
 * at.
 *
 * FOV SEAM — CLOSED. This function used to trace with `canWalk`, and the note
 * here said opacity and passability were the same thing "because every blocker
 * on the M2 map is a wall", to be split "when glass, chasms and open doors
 * arrive". Alderbrook's canal is that case: solid to a body, transparent to an
 * eye. So the trace now asks `blocksSightAt`, which is the predicate protocol.ts
 * keeps beside `isWalkable` precisely so the two cannot drift.
 *
 * NOTHING ON THE M1 MAP CHANGES. Its only blocker is WALL, which is opaque and
 * solid in both predicates, so every existing FOV test still describes the same
 * game — the split is observable only where WATER or BRIDGE exists.
 */
export function hasLineOfSight(level: LevelView, from: TileXY, to: TileXY): boolean {
  const line = bresenham(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (blocksSightAt(level, tile.x, tile.y)) return false;
  }
  return true;
}

/** `core.fov.distance` — the straight line between two tiles, in tiles. */
export function sightDistance(from: TileXY, to: TileXY): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * CAN `from` SEE `to`? Range first, then the wall test.
 *
 * RANGE FIRST BECAUSE IT IS CHEAP. `hasLineOfSight` walks a bresenham line and
 * is the expensive half; a body across the map fails on arithmetic and never
 * pays for it. `projectActors` runs this once per actor per viewer per frame.
 *
 * A BODY ON ITS OWN TILE SEES ITSELF — distance 0, and `hasLineOfSight` returns
 * true for a line of length one. Stated because the viewer is always in the set
 * this filters, and a rule that hid you from yourself would be very confusing.
 */
export function canSee(
  level: LevelView,
  from: TileXY,
  to: TileXY,
  radius: number = DEFAULT_SIGHT_RADIUS,
): boolean {
  if (sightDistance(from, to) > radius) return false;
  return hasLineOfSight(level, from, to);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAY THIS CHARACTER BE SHOWN WHAT IS LYING ON THIS TILE? SEEN, OR REMEMBERED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/Object.lua:28-29` gives objects `display_on_seen = true` AND
 * `display_on_remember = true` — the same pair `engine/Grid.lua:30-32` gives TERRAIN,
 * and the opposite of `engine/Actor.lua:30-34`, which is remember-FALSE. You remember a
 * coat you walked past; you do not remember where a husk was standing.
 *
 * ═══ TWO TERMS, AND THE SIGHT ONE IS ALMOST ALWAYS SUBSUMED ═══
 *   REMEMBERED is the character's own persisted fog bitset, revealed at
 *     `REVEAL_RADIUS` (12) as they walk.
 *   SEEN is `canSee` at `DEFAULT_SIGHT_RADIUS` (10).
 *
 * SIGHT IS INSIDE REVEAL, so once a character has taken one step, everything
 * they can see is already remembered and the second term adds nothing. It is
 * kept because upstream ORs the two (`engine/Object.lua:28-29`) and because "before
 * the first step" is a real state — not because it is load-bearing.
 *
 * ═══ AND THIS PARAGRAPH USED TO SAY THE OPPOSITE ═══
 * It read *"THOSE RADII DISAGREE BY EIGHT TILES"* and flagged a divergence from
 * upstream for somebody to decide about, because sight was wrongly 20. Upstream
 * has ONE radius — `self.sight` drives FOV and remembering follows — and with
 * the radius corrected to 10 that relationship is restored here too: reveal
 * covers sight. The divergence was a symptom of the wrong number, and fixing
 * the number removed it.
 *
 * ═══ WHY IT IS HERE AND NOT IN THE GATEWAY CLOSURE ═══
 * It was in the closure, and two mutations survived — delete the memory term,
 * delete the sight term — because every test passed its own predicate to
 * `projectGroundItems` and nothing ever drove the real one. The rule is
 * extracted and the plumbing left behind, which is the shape `sheetForBody` and
 * `spendByPurse` already established here.
 */
export function knownTile(
  level: LevelView,
  eyes: readonly TileXY[],
  remembered: Uint8Array | undefined,
  x: number,
  y: number,
): boolean {
  if (remembered !== undefined && fogHas(remembered, level.w, x, y)) return true;
  return eyes.some((eye) => canSee(level, eye, { x, y }));
}
