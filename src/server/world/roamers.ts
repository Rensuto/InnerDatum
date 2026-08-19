/**
 * Roamers — the danger you can see coming on the overworld.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AND WHY IT IS NOT A MONSTER
 * ═══════════════════════════════════════════════════════════════════════════
 * The overworld had no visible enemies, and the defence for that was ToME's own
 * design: the world map has no monsters on it, and travelling is dangerous
 * because a step can pull you into a zone. That is true, and it was still the
 * wrong call here, because it left the overworld with no DECISION in it. You
 * walked, and sometimes a fight happened at you. Danger you cannot see is danger
 * you cannot weigh, avoid, or choose.
 *
 * A roamer is a visible thing that wanders the region and pulls you into an
 * ambush arena when you walk onto it. So the overworld gets what a visible
 * enemy is actually for: see it, judge the ground, go around it or go at it.
 *
 * ═══ IT IS A MARKER, NOT AN ACTOR, AND THE DISTINCTION IS LOAD-BEARING ═══
 * A roamer is never in `world.actors`. It has no hp, no energy, no turn, no AI.
 * That is what keeps `engagement` on the shared overworld at exactly zero, and
 * engagement is the last clause of `isBlocking` (barrier.ts:293-306) — one real
 * hostile standing on Alderbrook would put every unrelated player in the region
 * into a single barrier, waiting on strangers, with a Bell running and nothing
 * on screen to explain it. That is the precise bug parties were introduced to
 * fix, and `assertNoCombatInSharedSpace` throws to prevent the content version
 * of it. This is the same rule honoured in a way the player can actually see.
 *
 * The fight still happens somewhere private. Only the WARNING is public.
 *
 * ═══ EVERY DRAW IS LABELLED, ON THE OVERWORLD'S OWN STREAM ═══
 * `world.rng` on the overworld has no other consumer — no combat, no AI, by the
 * invariant above — so spawning and wandering cost nothing downstream. Same
 * argument `rollForEncounter` makes for its d100.
 */

import { canWalk } from '../../shared/level.ts';
import { isHaunt } from '../../shared/protocol.ts';
import { tileAt } from '../../shared/level.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Realm, Roamer } from './realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MUCH GROUND ONE ROAMER IS WORTH. The density, not the headcount.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Enough that you meet one on a long crossing and have to decide something; few
 * enough that the map is not a minefield and a careful player can still cross it
 * untouched.
 *
 * THIS WAS `MAX_ROAMERS = 18`, AND ITS OWN COMMENT DESCRIBED A DENSITY: *"Seven
 * was tuned against 6,144 cells; the map is now 17,000... Eighteen keeps roughly
 * the same density — about one per five hundred cells — which is the number that
 * was actually playtested, expressed against the map that exists."* The intent
 * was always the ratio; 18 was that ratio worked out by hand for one map and
 * then written down as if it were the rule.
 *
 * THAT HELD EXACTLY AS LONG AS THERE WAS ONE MAP. A second landmass under a flat
 * cap would have HALVED the danger on both: the same eighteen creatures spread
 * over twice the ground, on a map whose whole design premise is that it is worse
 * than the first. It is the fourth of the four things that assumed one overworld
 * — see `test/server/realms.test.ts` — and the only one that could be measured
 * today, because the ratio is a fact about a single map.
 *
 * ═══ AGAINST HAUNTABLE GROUND, NOT WALKABLE ═══
 * `HAUNTS` is where a roamer may stand, and it is 7,643 of the moor's 9,327
 * walkable cells — the road and the settlements are the difference, and they are
 * SAFE by promise. Dividing by walkable would let a map with more road quietly
 * carry more danger per acre of wild country. Dividing by hauntable asks the
 * question that matters: how thick is the danger where danger can be?
 *
 * 7,643 / 18 = 425, so that is the number, and eighteen is what it still answers
 * for Alderbrook. Nothing about today's play changes.
 */
export const CELLS_PER_ROAMER = 425;

/**
 * The ceiling for one map, from the ground it actually has.
 *
 * MEMOISED BY REALM ID because it is a fold over seventeen thousand cells and
 * `tickRoamers` runs on a pump. Ids are never recycled (world/realms.ts) and
 * roamers only ever exist on an overworld, which is never reaped — so this is
 * bounded by the number of landmasses rather than by uptime.
 */
const capByRealm = new Map<string, number>();

export function maxRoamersFor(realm: Realm): number {
  const cached = capByRealm.get(realm.id);
  if (cached !== undefined) return cached;

  const level = realm.world.level;
  let hauntable = 0;
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      if (canHauntTile(level, x, y)) hauntable += 1;
    }
  }
  // AT LEAST ONE on any map with somewhere to stand: a landmass with a handful
  // of wild cells should still have something on it, and a cap of zero would
  // read as a bug rather than as a quiet region.
  const cap = hauntable === 0 ? 0 : Math.max(1, Math.round(hauntable / CELLS_PER_ROAMER));
  capByRealm.set(realm.id, cap);
  return cap;
}

/** One step every this many game turns, so they drift rather than chase. */
const MOVE_EVERY_TURNS = 3;

/**
 * Where one may stand.
 *
 * The same ground the encounter roll already treats as dangerous, and for the
 * same reason: the road and a settlement's approach are SAFE, and that is a
 * promise a player learns to rely on. A roamer sitting on the road would break
 * it more visibly than an invisible roll ever did.
 */
/**
 * WHERE THE LIST WENT: `isHaunt` in shared/protocol.ts, because the client has
 * to draw the same answer that this file enforces and cannot import it from
 * here. Two lists would have meant that the day they disagreed, the world map
 * promised safety on ground a roamer was standing on.
 */

/**
 * What wanders, paired with what it looks like.
 *
 * The sprites are the AMBUSH ROSTER's own (content/monsters.ts), so the thing
 * you decided to walk into is the thing you meet — a roamer that looked like a
 * husk and produced a wraith would make the decision it exists to offer a lie.
 */
const KINDS: readonly { readonly name: string; readonly sprite: string }[] = [
  { name: 'An Index Husk', sprite: 'enemy_index_husk_s' },
  { name: 'An Index Wraith', sprite: 'enemy_index_wraith_s' },
  { name: 'Something Redacted', sprite: 'enemy_index_glut_s' },
  { name: 'A Wrong Shadow', sprite: 'enemy_index_cairn_s' },
];

/** The eight steps. Fixed order — the index is a draw, so order is seed contract. */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function canHaunt(realm: Realm, x: number, y: number): boolean {
  return canHauntTile(realm.world.level, x, y);
}

/**
 * The same question against a bare level, so `maxRoamersFor` can count the
 * ground without a realm's other machinery. One predicate, two callers — a
 * second copy of "where may danger stand" is the last thing this file wants.
 */
function canHauntTile(level: LevelView, x: number, y: number): boolean {
  if (!canWalk(level, x, y)) return false;
  return isHaunt(tileAt(level, x, y));
}

/**
 * Advance the roamers on one realm. Call once per pump; a no-op anywhere but
 * the overworld, and a no-op on any turn that is not a movement turn.
 *
 * Returns true when anything moved or appeared, so the caller can decide
 * whether to send a frame rather than sending one every pump.
 */
export function tickRoamers(realm: Realm, seq: number): boolean {
  let changed = false;

  // ─── SPAWN, one at a time, so the map fills gradually rather than at boot ───
  if (realm.roamers.size < maxRoamersFor(realm)) {
    const level = realm.world.level;
    // A bounded search rather than a scan of six thousand cells every pump.
    for (let tries = 0; tries < 24; tries += 1) {
      const x = realm.world.rng.int('roamer.spawn.x', 1, level.w - 2);
      const y = realm.world.rng.int('roamer.spawn.y', 1, level.h - 2);
      if (!canHaunt(realm, x, y)) continue;
      // NEVER ON TOP OF SOMEBODY. Materialising under a player's feet is an
      // ambush they had no chance to see, which is the whole thing this
      // replaces.
      if (realm.world.actorAt(x, y) !== undefined) continue;
      if ([...realm.roamers.values()].some((r) => r.x === x && r.y === y)) continue;
      const id = `roam_${String(seq)}_${String(realm.roamers.size)}`;
      const kind = KINDS[realm.world.rng.int('roamer.kind', 0, KINDS.length - 1)] ?? KINDS[0];
      realm.roamers.set(id, {
        id,
        x,
        y,
        name: kind?.name ?? 'An Index Husk',
        sprite: kind?.sprite ?? 'enemy_index_husk_s',
      });
      changed = true;
      break;
    }
  }

  // ─── WANDER ───
  if (seq % MOVE_EVERY_TURNS !== 0) return changed;

  for (const roamer of realm.roamers.values()) {
    const step = STEPS[realm.world.rng.int('roamer.step', 0, STEPS.length - 1)];
    if (step === undefined) continue;
    const nx = roamer.x + step[0];
    const ny = roamer.y + step[1];
    if (!canHaunt(realm, nx, ny)) continue;
    // A roamer does not walk ONTO a player. Being caught by something that
    // moved into you is a fight you did not choose, and choosing is the point.
    // It waits; you decide.
    if (realm.world.actorAt(nx, ny) !== undefined) continue;
    if ([...realm.roamers.values()].some((r) => r !== roamer && r.x === nx && r.y === ny)) continue;
    roamer.x = nx;
    roamer.y = ny;
    changed = true;
  }

  return changed;
}

/** The roamer standing on this tile, if any. */
export function roamerAt(realm: Realm, x: number, y: number): Roamer | undefined {
  for (const r of realm.roamers.values()) {
    if (r.x === x && r.y === y) return r;
  }
  return undefined;
}
