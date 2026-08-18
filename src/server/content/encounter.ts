/**
 * The M4 test encounter — the first monsters that actually exist in a level.
 *
 * WHY THIS FILE EXISTS
 *
 * Every combat system in the engine is built and tested: the barrier, the Bell,
 * partial-save durations, the batched monster sweep, Downed and revive. None of
 * it had ever been SEEN, because no monster was ever placed in a level. The
 * turn loop ran correctly and simply never had cause to make anybody wait.
 *
 * Three monsters, chosen to exercise the three things that are invisible
 * without an enemy:
 *
 *   index_husk        melee chaser  — makes the barrier engage at all. Once a
 *                                     hostile has line of sight, engagement
 *                                     goes above zero and every player on the
 *                                     level owes a decision each turn.
 *   index_wraith      ranged kiter  — makes POSITION matter. It backs away when
 *                                     you close, so a party that clumps gets
 *                                     kited and one that flanks does not.
 *   index_husk_elite  the elite     — a visibly harder body wearing the elite
 *                                     ring, and the reason that ring was drawn.
 *
 * DELIBERATELY HAND-PLACED, NOT GENERATED. Procedural spawning arrives with the
 * zone generator at M5. A fixed table is what makes the first playtest
 * REPRODUCIBLE: everyone meets the same three monsters in the same corners, so
 * "the Bell fired too early" is a report someone else can reproduce rather than
 * a story about a run nobody else had.
 *
 * Placement is far enough from the player spawn that nothing is hunting you the
 * instant you connect — exploration should come first, and the mode switch into
 * combat should feel like tension arriving rather than a fight already lost.
 */

import type { TileXY } from '../../shared/coords.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { canWalk } from '../../shared/level.ts';
import { partyMaxLevel, rollLoot } from './loot.ts';
import type { Rng } from '../../shared/rng.ts';
import type { World } from '../world/world.ts';
import { INDEX_HUSK, INDEX_HUSK_ELITE, INDEX_WRAITH, monsterInit } from './monsters.ts';
import type { MonsterTemplate } from './monsters.ts';
import type { PartyStrength } from '../world/strength.ts';

type Placement = {
  readonly template: MonsterTemplate;
  readonly at: TileXY;
  /** Why this one is here — the encounter is a design statement, not filler. */
  readonly intent: string;
};

/**
 * The 30x30 test level's open floor sits roughly between x 1-28, y 1-28 with
 * interior wall blocks scattered through it. These tiles were chosen inside
 * open space and away from the spawn corner; `world.addMonster` settles for the
 * nearest free tile anyway, so a wall moving later degrades placement rather
 * than breaking the seed.
 */
const ENCOUNTER: readonly Placement[] = Object.freeze([
  {
    template: INDEX_HUSK,
    at: { x: 22, y: 6 },
    intent: 'the first thing that ever chases you',
  },
  {
    template: INDEX_WRAITH,
    at: { x: 25, y: 20 },
    intent: 'kites — punishes a party that clumps',
  },
  {
    template: INDEX_HUSK_ELITE,
    at: { x: 8, y: 24 },
    intent: 'the elite ring, and a reason to retreat',
  },
]);

export type SeededMonster = {
  readonly id: string;
  readonly name: string;
  readonly at: TileXY;
  readonly intent: string;
  /**
   * What this body will leave on the floor when it dies, DECIDED NOW.
   *
   * `undefined` for a creature with no drop table and for one whose chance roll
   * came up short. Returned so the boot log can say what the floor is worth,
   * which is also the only way to notice a drop table that has quietly stopped
   * producing anything.
   */
  readonly carrying?: string;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DROP ROLL. TWO DRAWS, TWO FROZEN LABELS, ON THE LOOT STREAM AND NOWHERE
 * ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from `resolvers.calc.drops`, modules/tome/resolvers.lua:427-434:
 *
 * ```lua
 * function resolvers.calc.drops(t, e)
 *     t = t[1]
 *     if not rng.percent(t.chance or 100) then return nil end   -- :429
 *     for i = 1, (t.nb or 1) do
 *         local filter = table.clone(t[rng.range(1, #t)])       -- :434
 * ```
 *
 * Two lines, two draws, and the EARLY RETURN at :429 is ported exactly: a failed
 * chance roll takes ONE draw and never reaches the pick. That is not a
 * micro-optimisation, it is the stream contract — src/shared/rng.ts:31-39 states
 * that renaming a label never alters a replay and adding or removing a DRAW
 * always does, so "how many draws does a husk cost" is a number this function
 * owes every future seed.
 *
 * ═══ THE TWO LABELS ARE FROZEN FROM THIS COMMIT ═══
 * `loot.chance` then `loot.pick`. Labels are diagnostics and renaming one cannot
 * change a replay (rng.ts:31-39), but these two are asserted by name in
 * test/server/loot.test.ts against `RngState.lastLabel`, which is the only
 * mechanism in the process that can prove a drop draw did not land on the wrong
 * generator.
 *
 * ═══ `rng.percent` IS NATIVE C AND IS NOT IN THE REFERENCE CLONE ═══
 * The clone holds 1,656 `.lua` files and zero `.c` (docs/tome-mechanics.md § 10),
 * so this is a REIMPLEMENTATION of documented semantics rather than a
 * translation: `rand_range(1, 100) <= v`, both ends inclusive. Identical to the
 * `rollPercent` helpers already in src/shared/checkhit.ts:114 and
 * engine/effects.ts:661, and deliberately spelled out here rather than imported
 * from either — checkhit.ts's is private, and reaching into engine/ from content/
 * for a two-line d100 would be a dependency edge bought very cheaply.
 *
 * `rng.range(1, #t)` is a 1-based INDEX draw over the filter array; ours is
 * 0-based over `pick` because JavaScript arrays are. Same span, same uniformity,
 * same number of draws.
 *
 * ═══ EXPORTED FOR ONE REASON: THE DRAW COUNT NEEDS A TEST OF ITS OWN ═══
 * The three shipped templates can only demonstrate two of the three cases — the
 * husk's 35 and the wraith's 100 — and the third, `chance: 0`, is the one whose
 * behaviour is easiest to get wrong (short-circuiting it to zero draws would
 * shift every drop after it on that seed). Pinning "0 costs one draw, 100 costs
 * two, absent costs none" needs a template that does not exist in the roster, and
 * a test cannot make one for a function it cannot call. Same reason
 * `validateItems` and `validateTemplate` are exported.
 */
export function rollDrop(rng: Rng, drops: MonsterTemplate['drops']): string | undefined {
  // A creature with no drop table never enters `resolvers.calc.drops` at all —
  // the resolver is not on it. ZERO DRAWS, which is what keeps a roster of
  // dropless monsters byte-identical to the world before this function existed.
  if (drops === undefined) return undefined;

  // resolvers.lua:429. Drawn UNCONDITIONALLY, even at chance 0 and chance 100
  // where the outcome is already decided — the same rule and the same reason
  // shared/checkhit.ts:108-112 gives: a short-circuit that skips a draw makes a
  // guaranteed outcome desynchronise every roll after it.
  if (rng.int('loot.chance', 1, 100) > drops.chance) return undefined;

  // resolvers.lua:434. `validateTemplate` has already refused an empty `pick`,
  // so the span is never negative; the `?? undefined` is `noUncheckedIndexedAccess`
  // asking for a proof the type system cannot see rather than a real branch.
  return drops.pick[rng.int('loot.pick', 0, drops.pick.length - 1)];
}

/**
 * Turn the base id `rollDrop` picked into the id of the thing that actually
 * dropped — which may have a name on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT TAKES ITS DRAWS ON A FORK, AND `rollDrop` ABOVE IS UNTOUCHED
 * ═══════════════════════════════════════════════════════════════════════════
 * `world.lootRng` still sits at exactly `loot.chance` then `loot.pick`, in that
 * order, per monster. Every draw the ego system takes is on a child stream
 * derived from (the parent's current state, its inc, this label), and `fork`
 * does not advance its parent (rng.ts:261-274).
 *
 * So the ego system's draw count is NOT LOAD-BEARING. That is worth stating
 * plainly because it is the property that pays for the whole design: the next
 * person to add an ego, change the quality table or add a third ego slot moves
 * no seeded test in this repository, and `test/server/loot.test.ts` pins
 * `world.lootRng`'s count across this change to prove the claim rather than
 * assert it.
 *
 * THE LABEL CARRIES THE ACTOR AND THE DROP INDEX. rng.ts:266-272: forking one
 * label in a loop hands every monster the same sequence, which here would mean
 * every husk in an ambush carrying the identically-named coat. The parent's
 * state has also moved between monsters, so this is belt and braces — but the
 * belt is the one that keeps working when somebody reorders the loop.
 *
 * LEVEL IS PARTY MAX. There is no zone level here; see `partyMaxLevel`.
 */
function embellish(world: World, actorId: string, baseId: string | undefined): string | undefined {
  if (baseId === undefined) return undefined;
  const level = partyMaxLevel(
    world.allActors().flatMap((a) => (a.kind === ActorKind.Player ? [a.level] : [])),
  );
  return rollLoot(world.lootRng.fork(`loot.ego:${actorId}:0`), baseId, level);
}

/**
 * Place the test encounter. Idempotent on id, like `addMonster` itself, so a
 * reconnect or a re-seed cannot double the population.
 *
 * Returns what it placed so the caller can log it — a server that quietly
 * spawned nothing because every tile was occupied is exactly the kind of
 * silence that costs an evening.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT DRAWS NOW. TWO LABELS, ON `world.lootRng`, IN THE ENCOUNTER'S AUTHORED
 * ORDER, AND THAT ORDER IS PART OF THE SEED CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This used to be a draw-free function and it is not one any more. Everything
 * that follows is what makes that safe:
 *
 *   THE STREAM IS `world.lootRng` AND ONLY EVER `world.lootRng`. It is a third
 *     fork off the root (world.ts), and `fork` is a pure function of (state,
 *     inc, label) that DOES NOT ADVANCE ITS PARENT (shared/rng.ts:261-274) — so
 *     `world.spawn` and `world.turn` are byte-identical to what they were before
 *     drops existed, and not one seeded test in the suite moved. Taking these
 *     draws on `world.rng` would shift every to-hit, crit, damage and AI roll in
 *     the game; taking them on the spawn stream would shift placement, which
 *     draws `world.spawn.overflow` at world.ts:524.
 *   THE ORDER IS THE `ENCOUNTER` ARRAY'S ORDER, top to bottom, because that is
 *     the only order in this file that a human wrote down. Iterating a Map or
 *     sorting by id would give the same three monsters different drops on a
 *     re-read of the same seed the first time somebody re-orders anything.
 *   THE SKIPPED-TILE `continue` COMES FIRST, DELIBERATELY. A creature that was
 *     never placed takes no draws, exactly as an entity that was never resolved
 *     never reaches `resolvers.calc.drops`. The alternative — roll, then decide
 *     whether to place — would make the drop stream depend on the level's wall
 *     layout, which is a fact from a different file entirely.
 *
 * ═══ A RE-SEED IS A NEW ROLL, AND IT HAS TO BE ═══
 * `resetFloor` (turn-engine.ts) reaps every monster and calls this again, so the
 * husk that stands up after a party wipe is a BRAND NEW BODY that takes its own
 * two draws off a stream that has moved on. It is very deliberately NOT the same
 * drop the dead one carried. Upstream agrees, structurally: a re-seeded floor
 * resolves new entities, and `resolvers.calc.drops` runs per entity. And the
 * alternative is worse than untidy — remembering a per-id result would make the
 * loot on the floor a function of how many times you have wiped, which is the
 * one thing a floor reset is supposed to erase.
 */
export function seedTestEncounter(world: World): SeededMonster[] {
  const placed: SeededMonster[] = [];

  for (const { template, at, intent } of ENCOUNTER) {
    // Skip a tile that is solid rock rather than letting addMonster wander to
    // an arbitrary free one — a monster that silently relocated across the map
    // makes the encounter unreproducible, which defeats the point of a fixed
    // table. NB this is ABOVE the roll on purpose; see the header.
    if (!canWalk(world.level, at.x, at.y)) {
      continue;
    }
    const id = `mon_${template.id}`;
    const actor = world.addMonster(id, monsterInit(template, at));

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE DROP IS DECIDED HERE AND WRITTEN ONTO THE BODY. DEATH TAKES NO DRAW.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `resolvers.calc.drops` creates the resolved object straight into the
     * creature's own inventory (resolvers.lua:441-446) and `Actor:die` spills
     * that already-decided inventory with no drop-table draw anywhere in it
     * (class/Actor.lua:3011-3060). `actor.carried` is our inventory, so this is
     * the same two lines of Lua with our nouns in them.
     *
     * WHAT THE ALTERNATIVE WOULD HAVE COST, since it is the obvious design and it
     * is a trap: our kill site is `damage.ts:596-597`, deep inside `applyDamage`,
     * inside the pump, on `world.rng` — the single linear stream that
     * `combat.checkhit`, `combat.crit`, `combat.bump.damage`, `ai.fire.chance`,
     * `ai.flee.side`, `ai.flee.hardside` and `ai.target.keep` all consume. One
     * new draw at the moment a monster dies moves every subsequent draw in that
     * pump and in every pump after it, forever.
     *
     * ═══ WHY THIS FILE MAY SEE BOTH THE CATALOGUE AND THE WORLD ═══
     * `content/` is the layer that is allowed to know about both: the engine may
     * not import content (scheduler.ts:515-527 states the rule and routes the
     * whole talent system around it), and content/items.ts imports types only.
     * The roll needs a random stream from the world and an id list from the
     * catalogue, so this is the one place in the process where it can live at
     * all.
     *
     * ASSIGNED ONLY WHEN SOMETHING DROPPED. `carried` stays `undefined` on a body
     * that is carrying nothing rather than becoming `[]`, because absent and
     * empty are read differently everywhere else in this system (persist/saves.ts
     * is explicit: `[]` means "carries nothing", `undefined` means "this producer
     * cannot say"), and a monster is a producer that genuinely said nothing.
     */
    const carrying = embellish(world, actor.id, rollDrop(world.lootRng, template.drops));
    if (carrying !== undefined) actor.carried = [carrying];

    placed.push({
      id: actor.id,
      name: template.displayName,
      at: { x: actor.x, y: actor.y },
      intent,
      carrying,
    });
  }

  return placed;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN AMBUSH PUTS THE FIGHT WHERE YOU ARE STANDING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `seedTestEncounter` above places three monsters at authored coordinates
 * chosen for a hand-explored floor: far from the spawn, "so nothing is hunting
 * you the instant you connect — exploration should come first."
 *
 * That is exactly right for a floor you walk into and exactly wrong for an
 * AMBUSH, and reusing it produced a bug that read as broken rather than as
 * mistuned. A player pulled off the overworld arrives in the map's spawn corner
 * at (3,2) while the nearest monster is at (22,6) — nineteen tiles away, and
 * the viewport inside a Discord iframe is roughly twenty tiles wide. So the
 * ambush fired, the map changed, and the screen showed an empty room. Reported
 * from play, twice, as "encounters start but there are no enemies".
 *
 * ToME does not have this problem because its ambush GENERATES a 20x20 zone
 * around the player rather than dropping them into a corner of a larger one
 * (`GameState.lua`'s ambush zone: `width = enc.width or 20`).
 *
 * ═══ THE RING, AND WHY IT IS A RING ═══
 * Monsters are placed at a fixed distance from the arrival tile: far enough
 * that nothing is adjacent on the first turn — being hit before the map has
 * even drawn is not tension, it is a bug report — and close enough to be on
 * screen at the smallest viewport this game ships. Angles are spread evenly so
 * a party is surrounded rather than facing a queue.
 *
 * NO DRAWS. Positions are a pure function of the arrival tile, so an ambush is
 * reproducible from the seed that caused it, and `world.addMonster` settles to
 * the nearest free tile if geometry lands one in a wall.
 */
/** Closest and furthest an ambusher may stand from the arrival tile. */
const AMBUSH_MIN = 4;
const AMBUSH_MAX = 7;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO IS WAITING, AND IT USED TO BE EVERYBODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The roster was the whole bestiary, always: a husk, a wraith AND the
 * sixty-hit-point elite, in the first encounter a level-1 character ever has.
 *
 * Walking the full first session is what made that indefensible. A stranger
 * joins, picks the Watchman, walks eighteen steps, meets all three, and is dead
 * twenty seconds later at level 1 with an empty bag. That is the entire game
 * they saw. An engine-level driver wins that fight 12 times in 12 — which is
 * how it survived this long — but it plays every turn optimally with no latency
 * and no misread, and a person does not.
 *
 * ═══ IT GROWS WITH WHAT THE PARTY CAN ANSWER ═══
 * One husk for somebody's first fight: winnable, drops something, teaches that
 * walking into a marker starts a fight. The wraith arrives when there is either
 * a second body to draw it or the levels to catch it; the elite when there is a
 * real party. ToME does the same thing by another name — a zone's population is
 * a function of its level, and its level is a function of when you can get
 * there.
 *
 * BY LEVEL **OR** BY HEADCOUNT, not both, because they are two different ways
 * of being ready and a party of three at level 1 is as entitled to a real fight
 * as a lone level-6.
 */
export function ambushRoster(party: PartyStrength): readonly MonsterTemplate[] {
  const roster: MonsterTemplate[] = [INDEX_HUSK];
  if (party.level >= 3 || party.size >= 2) roster.push(INDEX_WRAITH);
  if (party.level >= 6 || party.size >= 3) roster.push(INDEX_HUSK_ELITE);
  return roster;
}

export function seedAmbush(
  world: World,
  near: TileXY,
  party: PartyStrength = { level: 1, size: 1 },
): SeededMonster[] {
  const roster = ambushRoster(party);

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE ANNULUS IS SEARCHED, NOT COMPUTED. A RING OF ANGLES DOES NOT SURVIVE A
   * CORNER.
   * ═════════════════════════════════════════════════════════════════════════
   * The first version placed each monster at a fixed radius and even angle and
   * let `addMonster` settle a bad tile to the nearest free one. On this map the
   * arrival tile is (3,2) — a CORNER — so most of that ring is wall or off-grid,
   * every settle pulled inward, and the elite ended up ADJACENT on arrival.
   * Being hit before the map has finished drawing is not tension, it is a bug
   * report, and it is the one thing the radius existed to prevent.
   *
   * So the candidates are the tiles that actually exist: walkable, in the
   * distance band, in row-major order. Chebyshev, because that is the metric
   * movement uses — a diagonal step costs the same as an orthogonal one, so a
   * monster "five tiles away" diagonally is five turns away, not seven.
   *
   * STILL NO DRAWS. Row-major order plus an even stride is a pure function of
   * the arrival tile, so an ambush is reproducible from the seed that caused it.
   */
  const candidates: TileXY[] = [];
  for (let y = near.y - AMBUSH_MAX; y <= near.y + AMBUSH_MAX; y += 1) {
    for (let x = near.x - AMBUSH_MAX; x <= near.x + AMBUSH_MAX; x += 1) {
      const d = Math.max(Math.abs(x - near.x), Math.abs(y - near.y));
      if (d < AMBUSH_MIN || d > AMBUSH_MAX) continue;
      if (!canWalk(world.level, x, y)) continue;
      if (world.actorAt(x, y) !== undefined) continue;
      candidates.push({ x, y });
    }
  }

  const placed: SeededMonster[] = [];
  if (candidates.length === 0) return placed;

  // Spread across whatever the room actually offers, rather than clustering at
  // the start of the list — three monsters in a queue is not an ambush.
  const stride = Math.max(1, Math.floor(candidates.length / roster.length));

  for (let i = 0; i < roster.length; i += 1) {
    const template = roster[i];
    const at = candidates[(i * stride) % candidates.length];
    if (template === undefined || at === undefined) continue;
    const id = `mon_${template.id}`;
    const actor = world.addMonster(id, monsterInit(template, at));
    const carrying = embellish(world, actor.id, rollDrop(world.lootRng, template.drops));
    if (carrying !== undefined) actor.carried = [carrying];
    placed.push({
      id: actor.id,
      name: template.displayName,
      at: { x: actor.x, y: actor.y },
      intent: 'ambush',
      carrying,
    });
  }
  return placed;
}
