// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// HOW A PROBE PLAYS A CHARACTER, IN ONE PLACE.
// ═══════════════════════════════════════════════════════════════════════════
//
// `first-fight.mjs` and `delve-run.mjs` both drive a body through a fight, and
// both got the same two things wrong for the same reasons. This is the shared
// answer, extracted rather than copied, because a hand-written rule in one file
// and a second copy in another is the shape this codebase has been bitten by
// repeatedly — most recently `HAUNTS`, which learned two new tile codes while a
// duplicate in a test did not.
//
// ═══ WHAT IT KNOWS THAT A NAIVE DRIVER DOES NOT ═══
//
//   THE 1.5 TRAP. Melee in this engine is range 1.5 — the diagonal-inclusive
//   adjacency — NOT 1. Selecting "a ranged talent" as `range > 1` picks up the
//   Watchman's Crude Blow and has him shooting people he is standing next to.
//   The same fact made the class picker print "1.5 tiles" for every melee
//   talent. It has produced a wrong answer three times; it is `>= 2` here, once.
//
//   COOLDOWNS. Picking the single longest-reaching talent looks reasonable and
//   makes The Inspector unplayable: its longest is Sniper's Mark, which has a
//   cooldown, so after one shot the driver has nothing and shuffles to the turn
//   cap. Revolver Shot — cooldown zero, the bread-and-butter attack — was never
//   tried. Measured before the fix: 0/40 against two foes. After: 26/40.
//
//   AIM AT WHO IS REACHABLE, not who is nearest. Backing away from the closest
//   monster walks you into the second one.
//
//   THE BAND IS THE ENGINE'S LENGTH, AND THIS FILE HAS GOT THAT WRONG TWICE.
//   `reachable` measured Chebyshev — `max(|dx|, |dy|)` — and the engine measures
//   `combatDistance` (engine/talents.ts#checkTargeting, whose comment names the
//   hazard exactly: *"A Chebyshev ring is a square that reaches 7.07 tiles into
//   its corners"*). So a probe offered shots the engine then refused as `too
//   far away`: 92 of them across one 96-fight sample, and every one cost the
//   driver a whole iteration.
//
//   The fix took `sightDistance` and said it was "`core.fov.distance` itself".
//   It was not: `sightDistance` (shared/sight.ts) is the UNROUNDED length, and
//   `core.fov.distance` rounds half-up. It matched the engine only because the
//   engine's `combatDistance` was unrounded too, and the day the engine took
//   ToME's rounding this copy would have refused the Inspector every foe two
//   diagonal steps away while the server let her shoot it. So the band now asks
//   `tileDistance` (shared/distance.ts) — the function `combatDistance` IS —
//   by import, and test/tools/fightlib-band.test.ts holds `reachable` to the
//   engine's own answer for Revolver Shot over every offset.
//
//   The 1.5 note below still holds on the rounded metric: a diagonal neighbour
//   is 1 away (1.41 rounded half-up) and the nearest tile past it is 2, so 1.5
//   "admits a diagonal neighbour and nothing further".
//
//   AND THE BAND INCLUDES LINE OF SIGHT, because `checkTargeting` does. A foe at
//   a legal distance behind a wall is NOT a shot, and treating it as one is what
//   made The Inspector stall: see `firingSpot`.
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.

import { discTiles, euclidDistance, tileDistance } from '../src/shared/distance.ts';
import { hasLineOfSight } from '../src/shared/sight.ts';
import { ballTiles, crossTiles } from '../src/server/engine/talents.ts';

/**
 * Every single-target attack a class owns that actually reaches, longest first.
 *
 * `single` only: an area talent wants a different question about where to aim
 * it, and these are difficulty probes rather than an AI.
 *
 * ═══ `known` IS THE DIFFERENCE BETWEEN A CLASS AND A CHARACTER ═══
 * `cls.loadout` is the whole hotbar the class will EVENTUALLY own. A body that
 * has spent no talent points owns four birth talents, and submitting the rest
 * earns `NotLearned` — 103 refusals in a single 200-iteration run, all of them
 * noise in the log.
 *
 * It also silently corrupted the dead-zone decision, which is the part that
 * mattered: `first-fight.mjs` reads `attacks[attacks.length - 1]` as "my
 * shortest-reaching gun" to decide whether to back away, and for The Inspector
 * that was `sigil` — a talent the level-1 body does not have. The two happen to
 * share `minRange: 3`, so the bug was invisible and would have surfaced the
 * first time a gun disagreed.
 *
 * Optional, so every existing caller keeps the list it had.
 */
export function rangedAttacks(cls, known) {
  return (
    (cls.loadout ?? [])
      .filter((t) => known === undefined || known.has(t.id))
      .filter((t) => t.targeting?.shape === 'single' && (t.targeting.range ?? 0) >= 2)
      /**
       * ═══ AND IT HAS TO POINT AT SOMETHING YOU WANT TO HIT ═══
       * `Affinity.Ally` talents are `shape: 'single'` with a real range, so shape
       * and range alone let them through and this list offered them as ATTACKS.
       * Measured in one 200-turn delve: `On My Whistle` — the Watchman's rally,
       * `affinity: Ally` — was submitted at a monster and refused 183 times.
       *
       * THE NOISE IS THE SMALL HALF. `first-fight.mjs` reads
       * `attacks[attacks.length - 1]` as "my shortest-reaching gun" to decide
       * whether to back out of a dead zone, so a rally in that slot makes the
       * retreat decision on a talent that is not a weapon. That is the `sigil`
       * bug (see `known` above) one field along, and it was invisible for the
       * same reason: the numbers still came out, they were just about the wrong
       * thing.
       *
       * `Any` IS KEPT. It can legitimately be pointed at a monster; only `Ally`
       * is refused by `checkTargeting` for every foe on the floor.
       */
      .filter((t) => t.targeting?.affinity !== 'ally')
      .map((t) => ({
        id: t.id,
        range: t.targeting.range ?? 1,
        minRange: t.targeting.minRange ?? 0,
      }))
      .sort((a, b) => b.range - a.range)
  );
}

/**
 * Take the best shot actually available this turn.
 *
 * Tries each attack longest-first and STOPS AT THE FIRST ONE THE ENGINE
 * ACCEPTS, which is what makes a cooldown fall through to the next weapon
 * instead of ending the character's turn.
 *
 * @returns `{ fired, gap }` — `fired` is whether a talent was accepted, `gap` is
 *   the distance to the foe it would have shot, or null when nothing was in any
 *   band (which is the only case where backing off is the whole answer).
 */
/**
 * Every foe with its distance, NEAREST FIRST.
 *
 * `d` IS THE ENGINE'S: `tileDistance`, whole tiles, the number every band here
 * compares and every caller reports as a gap. THE ORDER IS THE EXACT LENGTH
 * (`euclidDistance`), because the rounded one ties constantly — a foe at (3,0)
 * and one at (2,2) are both 3 — and "nearest" should still mean the nearer
 * one. ToME's own target scan ranks the same way, by the exact squared length
 * (engine/Target.lua:707, sorted at :724-727). Sorting on the exact length is
 * also sorting on the rounded one, since rounding never reverses an order.
 */
function byNearest(self, foes) {
  return foes
    .map((f) => ({ f, d: tileDistance(self, f), exact: euclidDistance(self, f) }))
    .sort((a, b) => a.exact - b.exact);
}

/**
 * The nearest foe this attack can actually reach, or undefined.
 *
 * ONE COPY, USED BY BOTH SHOOTERS. The band is `minRange <= d <= range` and the
 * pick is the NEAREST inside it — and the moment that arithmetic exists twice,
 * once for the in-process engine and once for the socket, is the moment the two
 * start disagreeing about what "in range" means. This file exists because a rule
 * written down twice is how this codebase gets bitten.
 *
 * EXPORTED for test/tools/fightlib-band.test.ts, which asks it and the engine's
 * `canUseTalent` the same question over every tile around a body.
 */
export function reachable(attack, self, foes, ground) {
  const lineClear = lineFor(ground);
  return (
    byNearest(self, foes)
      // THE THREE TERMS OF `checkTargeting`, IN ITS ORDER. `> range` then
      // `< minRange` then line of sight, and LoS only beyond distance 1 — the
      // engine skips the bresenham walk for a neighbour and so does this.
      .filter((c) => c.d <= attack.range && c.d >= attack.minRange)
      .filter((c) => lineClear === null || c.d <= 1 || lineClear(self, c.f))[0]
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHOSE LINE A SHOT IS CHECKED ALONG — THE ENGINE'S, WHEN THE WORLD IS TO HAND.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `checkTargeting` asks `world.lineClearFor(actor, target)` and falls back to
 * plain line of sight only when a world has no such question. For a player that
 * is upstream's player line (server/view/eyesight.ts): what they see now and
 * what the level remembers for them. This file asked plain line of sight, and
 * in a lit room the two agree.
 *
 * IN THE DARK THEY DO NOT. On the Undermost's last floor the Inspector's
 * Sniper's Mark was refused `no_los` at six and seven tiles — past the lantern,
 * on ground the body could not see — while this band called both a shot. So
 * `takeShot` fired nothing, `firingSpot` said "you are standing on the spot",
 * and the driver stepped back and forth for the rest of the fight: 0 wins in
 * 12, charged to the class and not to this file.
 *
 * `ground` is a World (in-process probes, which have one and must pass it) or a
 * bare level view (the socket probes, which only ever hold the level a frame
 * carried, and whose server refuses in words anyway). A World is recognised by
 * the question itself, `lineClearFor`, rather than by a flag.
 */
function lineFor(ground) {
  if (ground === undefined) return null;
  if (typeof ground.lineClearFor === 'function') return (from, to) => ground.lineClearFor(from, to);
  return (from, to) => hasLineOfSight(ground, from, to);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH FOE TO WALK AT — and it is not always the nearest one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ CHASING A KITER IS HOW A PARTY SPENDS NINE HUNDRED TURNS ═══
 * Measured in The Outer Index with a level-20 party of three: four foes, two
 * `ranged_kiter` wraiths beside the party and two husks across the map. The
 * party fought the wraiths — which flee as fast as anyone can follow — for the
 * whole turn cap and never touched the husks, finishing at 99% health with
 * three foes alive. Every "stall" row in `delve-run`'s table is that shape.
 *
 * A KITER IS NOT UNKILLABLE, IT IS UNCHASEABLE. `takeShot` still fires at one
 * the moment it strays into a band, and it strays constantly because its own
 * profile wants a preferred distance rather than the horizon. What does not work
 * is WALKING at it: it steps away on the same tick, so the gap never closes and
 * the party is towed around the room.
 *
 * ═══ SO THE WALK PREFERS SOMETHING THAT WILL STAND AND FIGHT ═══
 * Nearest non-kiter first, nearest anything second. It is the choice a player
 * makes without thinking — deal with what you can catch, shoot the wraith when
 * it drifts past — and it converts a stall into progress rather than into a
 * different stall. When every foe on the floor kites, the fallback is the old
 * behaviour exactly, because then there is nothing better to walk at.
 *
 * READS `ai.profile` DIRECTLY, which is server state a probe may see and a
 * PLAYER may not. That asymmetry is fine here and would not be in the client:
 * this is a measuring instrument deciding where to point itself, not a body
 * deciding what it knows.
 */
export function nearestQuarry(foes, self) {
  const byDistance = byNearest(self, foes);
  const standing = byDistance.find((c) => c.f.ai?.profile !== 'ranged_kiter');
  return standing ?? byDistance[0];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NEAREST TILE THIS BODY COULD ACTUALLY SHOOT FROM, OR `null`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS EXISTS BECAUSE "CLOSE OR BACK OFF" IS NOT ENOUGH FOR A DEAD ZONE, and
 * the missing third option cost two of The Inspector's twenty-four fights.
 *
 * Measured before this function existed, seed `first-fight:inspector:11`, and
 * the log is a perfect two-cycle for all 200 iterations of the cap:
 *
 *     it  dist  action                  why
 *     ..  3.61  move nw (close)         revolver_shot refused: no line of sight
 *     ..  2.24  move se (BACK OFF)      nothing in band — 2.24 is inside minRange 3
 *     ..  3.61  move nw (close)         revolver_shot refused: no line of sight
 *
 * At 3.61 there was a wall on the line, so the shot was refused — but the foe
 * WAS in the distance band, so the driver's `gap === null` test for "back off"
 * stayed false and it closed instead. At 2.24 nothing was in band, so it backed
 * off. Two tiles, forever, against one monster that could not see it either.
 *
 * A player in that spot does neither: they STEP SIDEWAYS to clear the wall. So
 * the driver gets a real goal rather than a direction, which also makes it
 * terminate — it is walking to a named tile instead of pacing a gradient.
 *
 * DETERMINISTIC, because a probe that picks differently on two runs of the same
 * seed cannot be compared against itself. The scan order is fixed — `dy` then
 * `dx`, both ascending — and the first tile at the lowest step count wins, so a
 * tie breaks on that order and never on a draw.
 *
 * `steps` IS CHEBYSHEV, AND THAT IS NOT THE BUG THIS FUNCTION FIXES. "How far
 * away is that tile" is a question about MOVEMENT, which is eight-directional
 * here, so a diagonal is one step. Only the TARGETING band is
 * `core.fov.distance` (`tileDistance`, through `reachable`), and it is because
 * `checkTargeting` is. Two questions, two metrics, on purpose.
 */
export function firingSpot(attacks, self, foes, level, walkable, radius = 6) {
  let best = null;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      // NEVER THE TILE ALREADY STANDING ON, so this always means "somewhere
      // ELSE". A talent on COOLDOWN is still inside the distance band, so
      // without this the answer to "I could not shoot" is sometimes "stay here",
      // `firstStep` is asked to path a body to its own tile, answers null, and
      // the caller's `?? 'e'` walks east for no reason.
      if (dx === 0 && dy === 0) continue;
      const spot = { x: self.x + dx, y: self.y + dy };
      if (!walkable(spot.x, spot.y)) continue;
      // Somebody standing there is not a place you can stand.
      if (foes.some((f) => f.x === spot.x && f.y === spot.y)) continue;
      // THE BODY, MOVED THERE. A player's line is theirs — it reads their own
      // sight and memory by id — so the candidate carries the body's identity
      // and only its tile changes.
      const standing = { ...self, x: spot.x, y: spot.y };
      if (!attacks.some((attack) => reachable(attack, standing, foes, level) !== undefined))
        continue;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (best === null || steps < best.steps) best = { spot, steps };
    }
  }
  return best === null ? null : best.spot;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SINGLE-TARGET ATTACK A CLASS OWNS, REACHING OR NOT — `loadoutStrikes`'
 * twin, for a driver holding a CLASS DEFINITION rather than a wire frame.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WITHOUT IT, ONE CLASS IN FOUR NEVER USED ITS KIT ═══
 * `rangedAttacks` filters `range >= 2`, which this file's header already warns
 * is a trap: *"The Watchman's entire kit is range 1.5, so the reaching filter
 * returns NOTHING and a driver built around 'shoot, then close' spends the whole
 * game walking into people."* That warning was written for the SOCKET readers
 * and `loadoutStrikes` was the answer — but the in-process drivers
 * (`first-fight.mjs`, `delve-run.mjs`) hold a `ClassDef`, not a frame, so they
 * had no such function and kept calling `rangedAttacks`.
 *
 * MEASURED, over the four classes: The Watchman owns six single-target talents
 * and `rangedAttacks` offers ONE. The Inspector and the Alchemist lose one each
 * (their melee answer); the Redactor loses none. So every difficulty number this
 * repository has printed for the Watchman was a body bump-attacking with five of
 * its six buttons untouched — the same defect `first-fight.mjs`'s header records
 * as *"a game where NO CLASS HAD ANY TALENTS"*, still true for melee.
 *
 * ═══ THE 1.5 TRAP IS HANDLED IN THE BAND, NOT BY A FILTER ═══
 * `loadoutStrikes` argues this in full and it holds here: `reachable` asks
 * whether the foe is within `range`, and 1.5 admits a diagonal neighbour (1.41,
 * which rounds to 1) and nothing further. Turning that number into a category test is what produced
 * three wrong answers in this repo; leaving it a distance is what makes one
 * function serve a truncheon and a revolver.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE BUTTON THAT ANSWERS A CROWD, WHICH `shape === 'single'` THREW AWAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `single` was the whole filter, and the sibling reader's note defends it —
 * *"an area talent wants a different question about where to aim it"*. It does
 * not. `checkTargeting` (engine/talents.ts:2825-2850) runs range, dead zone and
 * line of sight on a ball and a cross exactly as on a single, and only the
 * `Single` branch below asks anything more; so aiming one at a foe's own tile is
 * a legal, ordinary shot that happens to catch its neighbours too. `takeShot`
 * already submits `{x, y}` of a body, so nothing else had to change.
 *
 * THE THREE TALENTS IT HAD NEVER PRESSED, one per class that owns one:
 * `scattershot` (ball 5), `alchemic_vial` (cross 4), `expunge` (ball 5). Those
 * are the three classes' entire answer to being surrounded, and a probe
 * measuring how many monsters a floor should hold with the anti-crowd buttons
 * disabled is measuring its own filter. It matters here and nowhere else in this
 * repo's history, because the question being asked of it is DENSITY.
 *
 * ═══ AND IT IS SPENT ON A CROWD, NOT ON A BODY — MEASURED, BOTH WAYS ═══
 * The first version sorted area ahead of single and made the Inspector WORSE:
 * The Underworks at level 3 went 3/3 to 1/3, because `scattershot` costs several
 * times a revolver shot and she spent her Focus blowing a hole around one husk.
 * So the order is unchanged (range, descending) and the RULE is the player's
 * one: `takeShot` declines an area talent aimed at a lone foe. See `AREA_MINIMUM`.
 *
 * ═══ AND IT CANNOT HURT THE PARTY ═══
 * engine/talents.ts:344 — *"Player AoE never damages allies (§ 10)"* — so this
 * is safe in the three-body table as well as the solo rows, and no aim rule is
 * needed to keep a ball off a friend.
 */
const AREA_SHAPES = new Set(['ball', 'cross']);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CHARACTER HAS LEARNED — the `known` set every caller should pass.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RANK 1 IS "LEARNED": `canUseTalent` refuses `getTalentLevelRaw(sheet, id) < 1`
 * as `NotLearned` (engine/talents.ts), and `getTalentLevelRaw` is
 * `sheet.points.get(id) ?? 0`, so this reads the same map the engine does.
 *
 * ═══ WITHOUT IT A PROBE HOLDS STILL IN FRONT OF A GUN ═══
 * `delve-run.mjs` called `classStrikes(cls)` with no `known`, so it offered
 * the whole eventual hotbar. A foe inside the band of a talent the body has not
 * learned (Sniper's Mark reaches 7, Line of Enquiry and Closed File 6) made
 * `takeShot` report a target with nothing fired, and the driver's answer to
 * that is to hold. Measured, one level-1 Inspector at full Focus against one
 * Cairn at six tiles: 0 shots in 6 runs with the whole hotbar, and 6 wins by
 * turn 5 with this set. `first-fight.mjs` already passed it, so the two probes
 * had been measuring two different characters.
 *
 * A SET BUILT FROM THE SHEET, NOT FROM A LEVEL. A level gained mid-floor spends
 * its point through `levelOnTheFloor` (grown.mjs), so a caller that wants the
 * character as it stands NOW asks again rather than keeping the first answer.
 */
export function learnedTalents(sheet) {
  return new Set([...sheet.points].filter(([, rank]) => rank >= 1).map(([id]) => id));
}

/**
 * THE NEAREST LIVING FOE, WHATEVER IT IS — `nearestQuarry` without the kiter
 * preference, for the one question where the preference is wrong: "I cannot
 * shoot, so what do I walk up to and hit?" The thing refusing you a shot is
 * usually a kiter, and the commonest is the Cairn: a `RangedKiter` at 0.7 speed
 * (`INDEX_CAIRN`, content/monsters.ts). It DOES back away — upstream's
 * `never_move = 1` (crystal.lua:39) is deliberately not ported — but a
 * speed-1.0 walker gains on it every turn, so walking in catches it.
 *
 * NOT TRUE OF EVERY KITER, and that is a known limit of this rule rather than a
 * property of it: a kiter at speed 1.0 or better (the Inquisitor) is not caught
 * by walking, and a body that walks in at one is towed round the room — the
 * failure `nearestQuarry`'s own note warns about. `d` is `tileDistance` like
 * every band here, and the order is the exact length — see `byNearest`.
 */
export function nearestFoe(foes, self) {
  return byNearest(self, foes)[0];
}

export function classStrikes(cls, known) {
  return (cls.loadout ?? [])
    .filter((t) => known === undefined || known.has(t.id))
    .filter((t) => t.targeting?.shape === 'single' || AREA_SHAPES.has(t.targeting?.shape))
    .filter((t) => t.targeting?.affinity !== 'ally')
    .map((t) => ({
      id: t.id,
      range: t.targeting.range ?? 1,
      minRange: t.targeting.minRange ?? 0,
      // `radius` is a Cross and Ball field (engine/talents.ts `TalentTargeting`)
      // and is what decides whether an aim is worth the reagents. Absent on a
      // single. The SHAPE travels with it, because the two shapes cover
      // different tiles at the same radius — see `caughtBy`.
      ...(AREA_SHAPES.has(t.targeting.shape)
        ? { radius: t.targeting.radius ?? 1, shape: t.targeting.shape }
        : {}),
    }))
    .sort((a, b) => b.range - a.range);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SINGLE-TARGET ATTACK IN A `loadout` FRAME THAT REACHES, LONGEST FIRST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `rangedAttacks` above reads a CLASS DEFINITION, where the numbers live under
 * `targeting`. The wire flattens them — `LoadoutTalent` carries `shape`, `range`
 * and `minRange` directly — so a socket driver needs its own reader.
 *
 * IT NEEDS THE SAME `>= 2`, AND THAT IS THE ONLY REASON THIS IS HERE RATHER THAN
 * INLINE IN A PROBE. Melee in this engine is range 1.5, so `range > 1` selects
 * the Watchman's Crude Blow and has him shooting people he is standing next to.
 * That mistake has been made three times in this repo; it is written once, here,
 * in both readers.
 */
export function loadoutAttacks(loadout) {
  return (loadout ?? [])
    .filter((t) => t.shape === 'single' && (t.range ?? 0) >= 2)
    .map((t) => ({ id: t.id, range: t.range ?? 1, minRange: t.minRange ?? 0 }))
    .sort((a, b) => b.range - a.range);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY SINGLE-TARGET ATTACK, REACHING OR NOT — WHICH IS A DIFFERENT QUESTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `loadoutAttacks` answers "what can I hit from a distance", which is what a
 * KITING driver needs. This answers "what can I hit this thing with right now",
 * which is what a driver that just wants to win needs — and for a melee class
 * they are not the same list at all. Measured: The Watchman's entire kit is
 * range 1.5, so the reaching filter returns NOTHING and a driver built around
 * "shoot, then close" spends the whole game walking into people.
 *
 * THE 1.5 TRAP IS STILL HANDLED, and better: it lives in the BAND rather than in
 * a filter. `bestShot` asks whether the foe is within `range`, and 1.5 admits a
 * diagonal neighbour and nothing further — which is what melee range MEANS. The
 * three wrong answers this repo has produced all came from turning that number
 * into a category test (`> 1` is ranged) instead of leaving it as a distance.
 */
export function loadoutStrikes(loadout) {
  return (loadout ?? [])
    .filter((t) => t.shape === 'single')
    .map((t) => ({ id: t.id, range: t.range ?? 1, minRange: t.minRange ?? 0 }))
    .sort((a, b) => b.range - a.range);
}

/**
 * The self-buffs, which cost a turn and are worth it once.
 *
 * Fired at the top of a fight and never again while they are cooling. A driver
 * that ignores them is measuring a character playing with part of its kit
 * switched off, which is exactly the complaint this file was written about.
 */
export function loadoutBuffs(loadout) {
  return (loadout ?? []).filter((t) => t.shape === 'self').map((t) => ({ id: t.id }));
}

/**
 * Take the best shot available, over anything.
 *
 * The transport-agnostic twin of `takeShot`: it owns the ORDER (longest first)
 * and the BANDS (`reachable`), and hands the actual attempt to the caller, which
 * is the only part a socket and an engine genuinely differ on. `tryShot` returns
 * whether the attempt was ACCEPTED — over a socket that means "no refusal frame
 * came back", which is the wire's version of `shot?.ok !== false`.
 *
 * STOPS AT THE FIRST ACCEPTED ATTACK, never at the longest-reaching one. That is
 * the cooldown lesson this file was extracted for: The Inspector's longest talent
 * is Sniper's Mark, which cools down, so a driver that picks by reach alone fires
 * once and then shuffles to the turn cap with Revolver Shot untouched. Measured
 * before the fix: 0 of 40 against two foes. After: 26 of 40.
 */
export async function bestShot(attacks, self, foes, tryShot, level) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes, level);
    if (shootable === undefined) continue;
    gap = shootable.d;
    if (await tryShot(attack.id, { x: shootable.f.x, y: shootable.f.y })) {
      return { fired: true, gap };
    }
  }
  return { fired: false, gap };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY BODIES AN AREA TALENT HAS TO CATCH BEFORE IT IS WORTH PRESSING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO. One is what the single-target button is for, and the area button costs
 * several times as much: measured, an Inspector who reached for `scattershot`
 * first went from 3/3 to 1/3 on The Underworks because her Focus was gone by the
 * third husk. Two is also the only threshold that needs no tuning — it is the
 * definition of "a crowd" rather than a number chosen against a table.
 */
const AREA_MINIMUM = 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES `body` STAND ON A TILE AN AREA TALENT AIMED AT `aim` WILL HIT?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ENGINE'S TWO SHAPES, ASKED OF THE ENGINE'S OWN FUNCTIONS — never a copy.
 * A ball is `ballTiles` itself and a cross is `crossTiles` itself. The first
 * version of this asked `tileDistance <= radius` for the ball, which was the
 * same set only by proof (test/shared/distance.test.ts) and only on open
 * ground.
 *
 * ═══ AND THE BALL STOPS AT WALLS, SO IT IS ASKED ON THE PROBE'S GROUND ═══
 * `ballTiles` takes the world now and shadowcasts over its level
 * (`shared/ball.ts`): a foe behind a pillar from the aimed body is not caught.
 * `ground` is the same argument `reachable` takes — a World, or a bare level
 * view — and a probe with NO ground has no walls, for the ball exactly as for
 * the line (`lineFor`): the open disc, `discTiles`, which is what `ballTiles`
 * lists on open ground. Asked without the ground, the probe would count a pair
 * split by a wall as a crowd and fire at one body for four times the price.
 *
 * THIS WAS ONE EUCLIDEAN TEST FOR BOTH, `sightDistance <= radius`, and at
 * radius 1 that is the five-tile plus. It was right about the cross by accident
 * and right about the ball only while `ballTiles` cut the same plus. Once balls
 * took ToME's disc — the whole 3x3 at radius 1 — one rule could be right about
 * one shape at most: `tileDistance` alone would count a foe on the vial's
 * diagonal, which the vial does not touch, and fire it at a pair it hits one of.
 */
function caughtBy(attack, aim, body, ground) {
  if (attack.shape === 'cross') {
    return crossTiles(aim, attack.radius).some((t) => t.x === body.x && t.y === body.y);
  }
  const level = levelOf(ground);
  const tiles =
    level === undefined ? discTiles(aim, attack.radius) : ballTiles({ level }, aim, attack.radius);
  return tiles.some((t) => t.x === body.x && t.y === body.y);
}

/** The level under `ground` — a World's, or `ground` itself when it is a bare view. See `lineFor`. */
function levelOf(ground) {
  if (ground === undefined) return undefined;
  return typeof ground.lineClearFor === 'function' ? ground.level : ground;
}

export function takeShot(engine, actorId, attacks, self, foes, onRefusal, level) {
  let gap = null;
  for (const attack of attacks) {
    const shootable = reachable(attack, self, foes, level);
    if (shootable === undefined) continue;
    /**
     * A BALL AIMED AT ONE BODY IS A SINGLE-TARGET SHOT AT FOUR TIMES THE PRICE.
     * The aim is the foe's own tile (below), so the catch is everything living
     * on the tiles the talent will actually hit. See `caughtBy`.
     */
    if (attack.radius !== undefined) {
      const caught = foes.filter(
        (f) => f.alive !== false && caughtBy(attack, shootable.f, f, level),
      ).length;
      if (caught < AREA_MINIMUM) continue;
    }
    gap = shootable.d;
    const shot = engine.submitTalent(actorId, attack.id, { x: shootable.f.x, y: shootable.f.y });
    if (shot?.ok !== false) return { fired: true, gap };
    if (onRefusal !== undefined) onRefusal(attack.id, shot);
  }
  return { fired: false, gap };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY BUTTON THAT HELPS THE PRESSER RATHER THAN HURTING SOMEBODY ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `classStrikes` and `rangedAttacks` both drop `affinity === 'ally'`, which is
 * right for them and left a hole: the probe party CARRIED three infusions from
 * the day inscriptions shipped and pressed none of them. Every difficulty
 * number measured since then understated survival, and the table said so
 * nowhere — a party that never heals is not the party this game ships.
 *
 * ═══ IT READS THE SHEET'S SOURCES, NOT `ClassDef.loadout` ═══
 * An inscription belongs to no class: `sheetForClass` joins `talentsFor` onto
 * every loadout, so a helper built from `cls.loadout` alone finds nothing at all.
 * That is exactly the bug this function exists to fix, so it is spelled out
 * rather than left to whoever reads it next.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `affinity === 'ally'` IS NOT THE SAME QUESTION AS "HELPS THE PRESSER".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This filtered on affinity alone, and `on_my_whistle` is `Affinity.Ally` —
 * a party-support talent whose own header says *"`Affinity.Ally` includes
 * yourself in this engine's targeting, so the refusal is explicit below"*, and
 * whose `onUse` returns `TalentRefusal.Self` for the caster. `takeHelp` targets
 * the PRESSER'S OWN TILE, so it pressed a talent that can never work there.
 *
 * IT IS ACCEPTED AT SUBMIT AND REFUSED AT RESOLUTION, and a refused player
 * intent is REFUNDED — so the body spent no energy, was re-prompted, pressed it
 * again, and the floor's clock stopped. It was the last 900-turn delve stall:
 *
 *     [refused t450] p0: no_target verb=help:talent:on_my_whistle
 *
 * `TargetShape.Self` is the distinction the function's NAME already made. The
 * infusions and the rune are `Self`; the whistle is `Single`. Filtering on the
 * shape asks "can this land on me", which is what a self-help list means.
 */
export function selfHelp(cls, known, inscribed) {
  return (
    [...(cls.loadout ?? []), ...inscribed]
      .filter((t) => known === undefined || known.has(t.id))
      /**
       * ═══ NEVER A SUSTAIN, AND IT USED TO TAKE THEM ═══
       * A stance matches the two clauses below exactly — `ally` and `self` —
       * and `turn-engine.ts#submitTalent` ACCEPTS one without ever routing it
       * through `toggleSustain` (the gateway is that function's only caller).
       * `takeHelp` returns at the first accepted submit, so a class whose first
       * self/ally talent is a stance pressed a button that did nothing and
       * never reached the heal behind it. Measured over the twelve moor delves:
       * `healing_infusion:ok` = 467 / 2270 / 2468 for the other three classes,
       * and **0** for the Redactor.
       *
       * A STANCE IS NOT FIRST AID. It goes up once, at the start, and stays up:
       * `grown.mjs#raiseBirthSustains` is where that happens, through the real
       * toggle. This list is "what do I press when I am hurt".
       */
      .filter((t) => t.kind !== 'sustained')
      .filter((t) => t.targeting?.affinity === 'ally' && t.targeting?.shape === 'self')
      // THE PRICE COMES WITH IT, because `no_energy` is the difference between a
      // button you press WHILE fighting and one you spend your turn on. See
      // `takeHelp`, which returns it so the caller can decide whether to swing.
      .map((t) => ({ id: t.id, ap: t.cost?.ap ?? 0 }))
  );
}

/**
 * PRESS ONE IF THINGS ARE GOING BADLY. Returns true if a button went down.
 *
 * ═══ A THRESHOLD, NOT A TACTICAL TABLE ═══
 * Upstream's AI weighs `tactical = { HEAL = 2 }` against everything else on the
 * bar. Our talents carry no tactical weights, so this models the one thing a
 * competent player actually does: heal when hurt, and not before. The number is
 * deliberately generous — a player presses at half, not at death's door — and it
 * is the probe's OPINION rather than the game's, which is why it lives here.
 *
 * FIRST THAT THE ENGINE ACCEPTS, in bar order. A refusal is ordinary: the
 * healing infusion refuses at full health and everything refuses on cooldown, so
 * this walks the list rather than giving up on the first no.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT RETURNS THE AP THE PRESS COST, AND null FOR "NOTHING PRESSED".
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT A BOOLEAN, and the first version was — which quietly wrecked the table it
 * was written to fix. The caller ended its turn on any success, so a body below
 * the threshold healed INSTEAD of swinging. Two of the three infusions are
 * `no_energy = true` and cost nothing at all, so the engine would happily have
 * taken the attack as well: the party stopped fighting for a reason that exists
 * nowhere in the game. Every row became a 900-turn stall and the probe could no
 * longer tell one delve from another.
 *
 * A FREE PRESS MUST NOT COST THE DRIVER ITS TURN. That is what `no_energy`
 * MEANS, and a probe that spends a turn the engine did not charge for is
 * measuring a game nobody is playing.
 */
export function takeHelp(engine, actorId, helps, body, threshold = 0.6) {
  if (helps.length === 0) return null;
  if (body.maxHp <= 0 || body.hp / body.maxHp > threshold) return null;
  for (const help of helps) {
    const out = engine.submitTalent(actorId, help.id, { x: body.x, y: body.y });
    if (out?.ok !== false) return help.ap;
  }
  return null;
}
