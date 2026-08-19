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

import { REDACTION_SITE_ID, canWalk } from '../../shared/level.ts';
import { isHaunt } from '../../shared/protocol.ts';
import {
  INDEX_CAIRN,
  INDEX_GLUT,
  INDEX_HUSK,
  INDEX_INQUISITOR,
  INDEX_INSPECTOR,
  INDEX_WRAITH,
} from '../content/monsters.ts';
import type { MonsterTemplate } from '../content/monsters.ts';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WANDERS — AND IT IS A CREATURE NOW, NOT A NAME AND A PICTURE OF ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The version this replaces was a table of `{ name, sprite }` pairs, under a
 * comment that stated the promise it was breaking:
 *
 *   > The sprites are the AMBUSH ROSTER's own, so the thing you decided to walk
 *   > into is the thing you meet — a roamer that looked like a husk and produced
 *   > a wraith would make the decision it exists to offer a lie.
 *
 * NOTHING CARRIED THE MARKER'S IDENTITY INTO THE FIGHT. `ambushRoster` was
 * given the party and the ground and never the roamer, so all four kinds
 * resolved to the same room: a husk, plus a wraith above level 3, plus an elite
 * above level 6. A player who crossed half the moor to reach the wrong shadow
 * rather than the husk beside them got the husk.
 *
 * ═══ WHY IT MATTERED MORE THAN IT LOOKS ═══
 * Roamers exist to turn danger on the overworld from a die roll into a DECISION
 * — the encounter roll they replaced was invisible and this is meant to be
 * something you see coming and choose. Four options that resolve identically is
 * not a decision, it is four coats of paint on one. And it quietly stranded the
 * bestiary: the cairn and the eidolon could only ever be met on the two grounds
 * that summon them, however many of them a player walked past.
 *
 * So a kind IS a template. The sprite is read off the creature rather than
 * typed beside it, which is what makes the two incapable of drifting again.
 *
 * ═══ THE LABEL IS STILL WRITTEN, AND DELIBERATELY ═══
 * `displayName` is what the Case Log calls a thing once you are fighting it;
 * this is what the MOOR calls it at four hundred yards, and they are not the
 * same register. "A Wrong Shadow" is what an Index Cairn looks like when it is
 * a shape on a hill you have not reached yet. The creature is the same creature
 * either way, which is the whole point — the fix is that the room now agrees,
 * not that the map has to stop being atmospheric.
 *
 * FIXED ORDER: the kind is a seeded draw, so this is seed contract. Appending
 * is safe; reordering or removing shifts every roamer that has ever spawned.
 */
export const ROAMER_KINDS: readonly {
  readonly label: string;
  readonly template: MonsterTemplate;
}[] = [
  { label: 'An Index Husk', template: INDEX_HUSK },
  { label: 'An Index Wraith', template: INDEX_WRAITH },
  { label: 'Something Redacted', template: INDEX_GLUT },
  { label: 'A Wrong Shadow', template: INDEX_CAIRN },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT WANDERS ON THE OTHER MAP, WHICH WAS THE SAME FOUR UNTIL NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Redaction shipped with harder DELVES and Alderbrook's open country. That
 * is the wrong way round: a player who crosses the door spends most of their
 * time WALKING, and walking was identical on both maps — so the dark territory
 * read as the moor with holes in it until they happened to open a door.
 *
 * ═══ WHAT IS GONE IS AS MUCH OF THE STATEMENT AS WHAT IS ADDED ═══
 * No husk and no wrong shadow. The husk is the game's baseline threat, the
 * thing a player learns first and stops reading after an hour — and its absence
 * is the fastest way to say that the ordinary population of this country is not
 * here any more. What is left of Alderbrook's four are the two that were never
 * ordinary: the glut, which the Index made out of something, and the wraith,
 * which is a citation of an absence.
 *
 * THE CAIRN IS NOT LOST BY DROPPING IT. `ambushRoster` still adds one on
 * `Ground.Fen` wherever the fight happens, so the fen keeps its firing line on
 * both maps — the ground supplies it and the marker no longer has to. The two
 * systems being independent is what makes this subtraction cheap.
 *
 * FOUR HERE AS WELL, AND NOT BECAUSE FOUR IS A RULE. It happens to be what the
 * design wanted, and the length carries no seed contract across maps: each
 * realm has its own `World` and therefore its own rng stream, so this list's
 * length cannot disturb Alderbrook's `roamer.kind` draws. Alderbrook's own list
 * is the one that must not be reordered.
 */
export const REDACTED_KINDS: readonly {
  readonly label: string;
  readonly template: MonsterTemplate;
}[] = [
  { label: 'A Disgraced Inspector', template: INDEX_INSPECTOR },
  { label: 'A High Inquisitor', template: INDEX_INQUISITOR },
  { label: 'Something Redacted', template: INDEX_GLUT },
  { label: 'An Index Wraith', template: INDEX_WRAITH },
];

/**
 * Which pool this realm draws from.
 *
 * BY `siteId` AND NOT BY REALM ID. A realm id is minted by the registry and an
 * instanced one carries a sequence number; the site id is the authored identity
 * and is the thing that means "this is the Redaction". Comparing the realm id
 * string would work today and break the first time anything about instancing
 * changes underneath it.
 */
export function kindsFor(realm: Realm): readonly {
  readonly label: string;
  readonly template: MonsterTemplate;
}[] {
  return realm.siteId === REDACTION_SITE_ID ? REDACTED_KINDS : ROAMER_KINDS;
}

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
      // WHICH MAP THIS IS. See `kindsFor` — the Redaction has its own people.
      const kinds = kindsFor(realm);
      const kind = kinds[realm.world.rng.int('roamer.kind', 0, kinds.length - 1)] ?? kinds[0];
      const template = kind?.template ?? INDEX_HUSK;
      realm.roamers.set(id, {
        id,
        x,
        y,
        name: kind?.label ?? 'An Index Husk',
        // BOTH READ OFF THE CREATURE. The sprite the player sees on the moor and
        // the sprite standing in the room are now one field, so they cannot be
        // separately edited into disagreeing.
        templateId: template.id,
        sprite: template.sprite,
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
