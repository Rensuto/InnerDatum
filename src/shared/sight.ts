// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:178 (`t.sight = t.sight or 10`)
//                       game/engines/default/engine/Actor.lua:520 (canSee; ours is the shadowcast)
//                       game/engines/default/engine/interface/ActorFOV.lua:49-130 (computeFOV)
//                       game/modules/tome/class/NPC.lua:99-105 (doFOV: `block_sight`)
//                       game/modules/tome/class/Player.lua:646-663 (playerFOV's three passes)
//                       game/modules/tome/class/Player.lua:709-714 (lineFOV: `distance <= self.sight`)
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
 * ═══ A CIRCLE, BECAUSE `calc_circle` IS ═══
 * Not `chebyshev`, the step count: using the movement metric would make the
 * diagonal corners of a square visible at 20 while the cardinal edge at 21 was
 * not, which is the wrong shape for a torch.
 *
 * AND NOT THE EXACT EUCLIDEAN DISC PLUS A LINE, WHICH IS WHAT PLAYER SIGHT WAS.
 * Every one of `playerFOV`'s passes (tome/class/Player.lua:646-663) is a
 * `computeFOV`, and `computeFOV` is `core.fov.calc_circle` or its cached twin
 * (engine/interface/ActorFOV.lua:49-130): libfov's shadowcast over ToME's
 * ROUNDED disc (`tileDistance <= r`, the r^2 + r disc), from the whole tile.
 * Player sight measured `sqrt(dx^2 + dy^2) <= r` and then walked one Bresenham
 * line per tile. The disc lost 32 rim tiles at r = 10, and the line and the
 * shadowcast disagree both ways at a wall (`fieldOfView`). Monster sight moved
 * first; `tilesInSight` below is the same machine now, so a player and a
 * monster see by one geometry.
 */
import { blocksSightAt } from './level.ts';
import { bresenham } from './coords.ts';
import { tileDistance } from './distance.ts';
import { fogHas } from './fog.ts';
import { calcCircle } from './mapgen/fovcircle.ts';
import type { CircleApply } from './mapgen/fovcircle.ts';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW NEAR A THING HAS TO BE FOR THE MINIMAP TO MARK IT. OURS, NOT UPSTREAM'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THERE IS NO CITATION FOR THIS AND THERE MUST NOT BE ONE. ToME has no minimap
 * exception: `engine/Map.lua:594-597` hands the minimap to `toScreenMiniMap`
 * over the SAME map object the board is drawn from, so it shows what the
 * character has seen or remembers and nothing else. This is a GAME RULE OF
 * OURS, ruled by the
 * author on 2026-09-17 for a co-op game played in a voice channel: a friendly
 * face and the way in and out are the two things four people need to be able to
 * point at, and hunting for a stair you have already walked past is not the
 * fight this game is about. Hostiles are never on it unseen — the exception
 * buys navigation, not intelligence.
 *
 * ═══ DERIVED, AND THAT IS THE POINT ═══
 * Twice the sight radius: near enough to be "over there", far enough to be
 * worth a mark. Written as an expression rather than as `20` because THIS FILE
 * HAS ALREADY PAID FOR A SECOND LITERAL — `DEFAULT_SIGHT_RADIUS` existed in
 * `world.ts` with the right value while a second copy beside it shipped 20 for
 * three commits (CLAUDE.md § 4). A reader who changes the sight radius must not
 * have to know this number exists.
 *
 * It is a REVEAL radius and not a sight radius: nothing here decides what a body
 * can see. `visionOf` is still the only answer to that, and the marks this
 * radius admits carry a position and a kind and nothing else.
 */
export const MINIMAP_REVEAL_RADIUS = DEFAULT_SIGHT_RADIUS * 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW BRIGHT A TILE DRAWS — `Player.lua:510-517`, three lines above `playerFOV`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * local fovdist = {}
 * for i = 0, 30 * 30 do
 *   fovdist[i] = math.max((20 - math.sqrt(i)) / 17, 0.6)
 * end
 * ```
 *
 * The table is indexed by a SQUARED distance and immediately takes its square
 * root. `playerFOV` spends it at `game.level.map:apply(x, y, fovdist[sqdist])`
 * (tome/class/Player.lua:648-649), the SIGHT pass, and the `sqdist` the C hands
 * that callback is the ROUNDED distance squared (`map_default_seen` and
 * `map_seen` in src/fov.c, git only: `dist` is `core.fov.distance`, then
 * `sqdist = dist*dist`). So the square root gives back a whole number and the
 * rule is `max((20 - d) / 17, 0.6)` on `tileDistance`, in steps. This said
 * "the true Euclidean distance"; it never was (`sightBrightness`).
 *
 * Everything you can see right now is dimmed by how far away it is. Full
 * brightness holds out to three tiles, then falls a seventeenth a tile to the
 * 0.6 floor, which it reaches at ten — exactly `DEFAULT_SIGHT_RADIUS`. That
 * coincidence is not one: the curve was fitted to the sight radius, so the
 * dimmest thing you can see is always 0.6 and never darker.
 *
 * ═══ CLAMPED ABOVE AT 1, WHICH UPSTREAM DOES NOT NEED TO DO ═══
 * At distance 0 the formula gives 20/17 = 1.176. Upstream hands that to a C
 * renderer as a colour multiplier; ours is a canvas and the only way to change a
 * tile's brightness is to lay a darkening wash over it, which can take light
 * away and cannot add it. A value above 1 means "no wash", so the clamp is what
 * the two renderers have in common rather than a simplification.
 */
export function fovBrightness(distance: number): number {
  return Math.min(1, Math.max((20 - distance) / 17, FOV_BRIGHTNESS_FLOOR));
}

/** `math.max(..., 0.6)` — the dimmest a tile you can SEE ever draws. */
export const FOV_BRIGHTNESS_FLOOR = 0.6;

/**
 * HOW BRIGHT `at` DRAWS FOR AN EYE AT `eye`: `fovBrightness` at ToME's ROUNDED
 * distance, `fovdist[sqdist]` with the C's `sqdist` (the note above).
 *
 * It was `fovBrightness` of the exact length, which is off by a fraction of a
 * step on nearly every tile: (3,2) is 3.61, a 0.964 wash, where ToME rounds to
 * 4 and draws 16/17. The painter asks this and nothing else
 * (`client/render/canvas.ts` `paintLight`), so the curve and its key are one
 * function a test can reach.
 */
export function sightBrightness(eye: TileXY, at: TileXY): number {
  return fovBrightness(tileDistance(eye, at));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND HOW BRIGHT ONE YOU CANNOT SEE DRAWS — `engine/Map.lua:69`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * color_obscure = { 0.6, 0.6, 0.6, 0.5 }
 * ```
 *
 * Upstream's own comment calls it *"the 'obscure' factor of unseen map"* — a
 * tile you have walked past and are no longer looking at. It is TWO
 * multiplications, not one: the colour is scaled to 0.6 AND the whole thing is
 * drawn at alpha 0.5 over the black beneath, so what reaches the screen is
 * `0.6 * 0.5` of the tile.
 *
 * Reading it as 0.6 — the number that appears four times in the line — gives a
 * remembered tile exactly the brightness of the dimmest tile you can SEE, and
 * the distinction the whole mechanic exists to draw disappears.
 */
export const MAP_OBSCURE_BRIGHTNESS = 0.6 * 0.5;

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAN A PLAYER DRAW A LINE TO THIS TILE? Upstream's `Player:lineFOV`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A target the player sees gets the ordinary line: only what blocks an eye
 * stops it (class/Player.lua:705-708). A target they do not see can only be
 * reached across ground they know: every tile on the way must be within sight,
 * seen or remembered, and not block an eye. Any other tile stops the line
 * (class/Player.lua:709-714). So nobody aims down a dark corridor they have
 * never walked.
 *
 * Everybody else keeps `hasLineOfSight`: upstream's monster line is its own
 * rule (class/NPC.lua:162-226) and is not ported.
 */
export function playerLineClear(
  level: LevelView,
  from: TileXY,
  to: TileXY,
  sightRadius: number,
  seen: (x: number, y: number) => boolean,
  remembered: (x: number, y: number) => boolean,
): boolean {
  if (seen(to.x, to.y)) return hasLineOfSight(level, from, to);
  const line = bresenham(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (!seen(tile.x, tile.y) && !remembered(tile.x, tile.y)) return false;
    // "WITHIN SIGHT" IS `core.fov.distance(sx, sy, x, y) <= self.sight`
    // (tome/class/Player.lua:709), the ROUNDED distance. It was the exact
    // length, which refused a remembered tile on the rim ToME's circle holds.
    if (blocksSightAt(level, tile.x, tile.y) || tileDistance(from, tile) > sightRadius)
      return false;
  }
  return true;
}

/**
 * CAN `from` SEE `to` at `radius`? One question put to the field of view.
 *
 * It WAS its own rule: the exact length against `radius`, then a Bresenham
 * line. Sight is the shadowcast now (`tilesInSight`), and a point question
 * answered by a second geometry is the second visibility rule this file exists
 * to prevent, so this asks `fieldOfView`, whose disc pre-check keeps the old
 * range-first shape: a tile past the rounded radius is refused on arithmetic.
 *
 * A BODY ON ITS OWN TILE SEES ITSELF: `calc_circle` applies its origin last,
 * whatever blocks. Stated because the viewer is always in the set this
 * filters, and a rule that hid you from yourself would be very confusing.
 *
 * No production caller asks one tile at a time any more; the tests do.
 */
export function canSee(
  level: LevelView,
  from: TileXY,
  to: TileXY,
  radius: number = DEFAULT_SIGHT_RADIUS,
): boolean {
  return fieldOfView(level, from, radius)(to);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CELLS AN EYE REACHES — `computeFOV(radius, "block_sight", apply)`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `calc_circle` from `eye` with `blocksSightAt` as the wall: `visit` is called
 * for every ON-MAP cell reached, the eye's own last (`calcCircle`). This is
 * the one place player sight, monster sight and every light pass lay their
 * cells, so none of them can disagree about a tile.
 *
 * `radius` truncates as the C's `int` does, and a radius at or below zero is
 * the eye's own cell alone. `visit` gets the C's `(x, y, dx, dy, sqdist)`.
 */
export function forEachInSight(
  level: LevelView,
  eye: TileXY,
  radius: number,
  visit: CircleApply,
): void {
  calcCircle(level, eye.x, eye.y, radius, (x, y) => blocksSightAt(level, x, y), visit);
}

/** `forEachInSight` into the `(2r+1)`-square round the eye, row by row. */
function sightGrid(level: LevelView, eye: TileXY, r: number): Uint8Array {
  const side = 2 * r + 1;
  const grid = new Uint8Array(side * side);
  forEachInSight(level, eye, r, (_x, _y, dx, dy) => {
    grid[(dy + r) * side + (dx + r)] = 1;
  });
  return grid;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TILE A BODY CAN SEE FROM WHERE IT STANDS — one `computeFOV` sweep.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `self:computeFOV(self.sight or 10, "block_sight", ...)` calls back
 * once per visible grid and the callback writes `seens`. This returns the grids
 * instead, because the caller decides what to do with them and we have no
 * engine-owned map to write into. On-map only, each once, ROW-MAJOR (dy outer,
 * dx inner), which is the order this always returned.
 *
 * ═══ THE SHADOWCAST, WHERE IT WAS A SQUARE LOOP AND A LINE PER TILE ═══
 * It walked the square, refused a tile past the EXACT radius on arithmetic and
 * traced one Bresenham line to each of the rest. That was `canSee` in a loop.
 * It is `calc_circle` now (`forEachInSight`), the geometry of every pass
 * `playerFOV` makes (tome/class/Player.lua:646-663): the rounded disc, 32 more
 * rim tiles at a radius of 10, less what the large-actor shadowcast hides,
 * which differs from the line both ways at a wall (`fieldOfView`).
 *
 * ONE VISIBILITY RULE STILL: `forEachInSight` is the only geometry. Player
 * sight reaches it through `computeVision` (shared/vision.ts), monster sight
 * through `fieldOfView`; `tilesInSight` and `canSee` are the same machine kept
 * for tests. A viewer that remembered tiles by a different test than
 * `projectActors` filters bodies by would draw a monster the server sent
 * standing on ground it had hidden.
 *
 * PURE, AND THE REASON IS A TEST. Kept here rather than in the client closure
 * that calls it because `main.ts` is unreachable from `test/` — a rule living
 * there can only ever be guarded by reading its source text.
 */
export function tilesInSight(
  level: LevelView,
  at: TileXY,
  radius: number = DEFAULT_SIGHT_RADIUS,
): readonly TileXY[] {
  const r = Math.max(Math.trunc(radius), 0);
  const side = 2 * r + 1;
  const grid = sightGrid(level, at, r);
  const out: TileXY[] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (grid[(dy + r) * side + (dx + r)] === 1) out.push({ x: at.x + dx, y: at.y + dy });
    }
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT AN EYE AT `eye` SEES OUT TO `radius` — ToME's field of view, shadowcast.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/class/NPC.lua:99-105` is a monster's whole sense of sight:
 *
 * ```lua
 * self:computeFOV(self.sight or 10, "block_sight", nil, nil, nil, true)
 * ```
 *
 * The last argument is `cache = true`, so for a creature with no
 * `special_vision` (none here has one) `computeFOV` takes its CACHED branch,
 * `core.fov.calc_default_fov` (`engine/interface/ActorFOV.lua:65-94`), not
 * the `core.fov.calc_circle` of its uncached one (:95-129). The geometry is
 * the same: in the C core both run `fov_circle` with the default settings from
 * the body's tile (`lua_fov_calc_default_fov` and `lua_fov_calc_circle`,
 * src/fov.c, git only), and the cached branch's wall is the map's
 * `block_sight` cache, which `engine/Map.lua:545-546` fills from
 * `checkAllEntities(x, y, "block_sight")`, the property the uncached branch
 * asks directly. Every body standing on a cell it reaches goes into
 * `fov.actors_dist`. So a body is SEEN exactly when its tile is in
 * `calcCircle`'s output (`mapgen/fovcircle.ts`): the rounded disc
 * (`tileDistance <= radius`), less whatever a wall shadows.
 *
 * THE WALL IS `blocksSightAt`, the predicate `hasLineOfSight` walks, so only
 * the geometry differs from that test: a large-actor shadowcast from the whole
 * tile instead of one Bresenham line from its centre. The two disagree both
 * ways. A cell just past a pillar beside the eye is seen here and not by the
 * line; a cell the line threads between two walls can be shadowed here.
 *
 * ═══ LAZY, AND THE DISC IS ASKED FIRST ═══
 * The shadowcast runs on the first question whose tile is inside the disc, and
 * once. A question outside it is answered on arithmetic, because `calcCircle`
 * applies nothing past `tileDistance > radius` (`circleHeight`). A monster with
 * nobody near it pays for no circle at all, which is the range-first shape
 * `canSee` had when it was a line, and why this is cheap enough to run per
 * monster per turn.
 *
 * IT IS ALSO WHAT KEEPS THE GRID INDEX HONEST, so it is not only a shortcut.
 * The grid is the `(2r+1)`-square round the eye, flattened row by row, and an
 * offset off that square does not fall off the array, it WRAPS: `(r+1, 0)`
 * computes the index of `(-r, +1)`, a real cell on the next row that the
 * circle may well have reached. Every tile inside the disc is inside the
 * square, so the pre-check is the bounds check too. Take it out and an eye
 * "sees" a body one tile past its radius whenever it can see the cell the
 * index wraps onto.
 *
 * A PLAYER'S SIGHT IS THE SAME CELLS. `tilesInSight` lays them through the
 * same `forEachInSight`, and `canSee` is this function asked once.
 *
 * PURE. The returned test holds a snapshot: a door opened after the first
 * question is not seen through by this one. Ask again for a fresh view.
 */
export function fieldOfView(
  level: LevelView,
  eye: TileXY,
  radius: number,
): (to: TileXY) => boolean {
  const r = Math.max(Math.trunc(radius), 0);
  const side = 2 * r + 1;
  let seen: Uint8Array | undefined;
  return (to) => {
    if (tileDistance(eye, to) > r) return false;
    seen ??= sightGrid(level, eye, r);
    return seen[(to.y - eye.y + r) * side + (to.x - eye.x + r)] === 1;
  };
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
 * ═══ TWO TERMS ═══
 *   REMEMBERED is the character's own fog bitset for this realm: what they kept
 *     of what they saw, in every realm.
 *   SEEN is what they see this turn by the light there is (`visionOf` on the
 *     server).
 *
 * THE SERVER REMEMBERS BEFORE IT ASKS. Every pump writes what each player keeps
 * into their memory before any frame is built. Where the level is lit, the seen
 * term adds nothing once a pump has run. In the dark it is the only term for a
 * floor a lantern shows, which memory does not keep. Upstream ORs the two
 * (`engine/Object.lua:28-29`).
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
  seen: Uint8Array | undefined,
  remembered: Uint8Array | undefined,
  x: number,
  y: number,
): boolean {
  if (remembered !== undefined && fogHas(remembered, level.w, x, y)) return true;
  return seen !== undefined && fogHas(seen, level.w, x, y);
}
