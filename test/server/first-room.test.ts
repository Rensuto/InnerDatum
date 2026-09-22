// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord, delveLevel } from '../../src/server/content/delve.ts';
import { computeRarities, rarityShare } from '../../src/server/content/rarity.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import type { SiteDef } from '../../src/server/world/realms.ts';
import { ZONES, zoneFloor, zoneTable } from '../../src/shared/mapgen/zones.ts';
import { CLASSES } from '../../src/server/content/classes.ts';
import { run } from '../../tools/delve-run.mjs';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../src/shared/sight.ts';
import { applyArmour } from '../../src/server/engine/damage.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ROOM THE GAME NAMES OUT LOUD HAS TO BE BEATABLE BY WHO IT NAMES IT TO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first case names ONE room to a character that is four minutes old, picked
 * by grade — the gentlest available, which today means the only `quiet` one. So
 * "quiet" stopped being a label on a map and became an instruction, and a room
 * a beginner cannot clear is now the game telling them to go and lose.
 *
 * ═══ WHAT THIS FOUND ═══
 * The Drowned Chapel's roster was `[Cairn, Husk, Wraith]`, and `populateDelve`
 * walks a roster as a CYCLE — three monsters from three entries is one of each,
 * every time. So every new player met an Index Wraith: 80 hit points, defence
 * 20, against a level-1 Watchman who hits it 23% of the time.
 *
 *     foe            hp  def   my hit%  their hit%   my turns  their turns
 *     Index Cairn    23    1       70%         58%          3           62
 *     Index Husk     25    1       70%         75%          3           96
 *     Index Wraith   80   20       23%         75%         21           14
 *
 * Twenty-one turns to kill, fourteen to die, with the Wraith's own -30%
 * physical resistance already counted in the player's favour.
 *
 * ═══ THE MODEL IS DELIBERATELY CRUDE, AND THAT IS WHY IT IS SAFE ═══
 * No talents, no crits, no cooldowns, no positioning, no kiting — a straight
 * exchange of average blows. Every one of those omissions makes the estimate
 * KINDER to the monster and harsher to the player, except talents, which this
 * ignores on purpose: a beginner room that can only be won by playing it well is
 * not a beginner room. What the test asserts is the loose bound — the fight must
 * be winnable by walking into it, which is what a four-minute-old character
 * does.
 */

/**
 * A LEVEL-1 WATCHMAN, READ OFF THE REAL SHEET THROUGH THE REAL PROTOCOL.
 *
 * These are the numbers `test/server/passives-wired.test.ts` measured end to end
 * after the passive layer was fixed — accuracy 9, defence 5, armour 8 — not the
 * authored class base, which is what the sheet reads BEFORE `refreshPassives`
 * runs and is therefore a character nobody plays.
 *
 * THE WATCHMAN AND NOT THE OTHER TWO because he is the front-liner: he has the
 * most hit points and the least accuracy, so he is the class that survives a bad
 * matchup longest and resolves it slowest. A room he can walk into is a room the
 * Inspector shoots to pieces.
 */
/**
 * HOW CLOSE TWO BODIES HAVE TO BE STANDING TO SWING AT YOU TOGETHER.
 *
 * The crude model below puts every foe in melee from turn one. That is a sound
 * bound for a knot of bodies and a fiction for a line of them, so the pack it is
 * fed is the largest group standing inside this radius of one of its own — the
 * condition under which the premise is true. Three tiles is one turn of walking
 * for anything in the bestiary plus the tile it is standing on, so a group this
 * tight is in contact together.
 *
 * DELIBERATELY NOT `DEFAULT_SIGHT_RADIUS`. See `packOf`: at 10 the model kills a
 * Watchman the driven probe clears the floor with.
 */
const MELEE_CONVERGENCE = 3;

/**
 * HOW MANY DRIVEN RUNS THE CASE BELOW TAKES.
 *
 * Six, which is `packOf`'s own seed count, so the modelled half and the driven
 * half of this file sample the same number of floors. Measured on one gate run:
 * six solo Watchman runs of the Drowned Chapel at upstream's counts cost about
 * two seconds, against this suite's 20-second budget. Raising it buys precision
 * in a number that is 20 of 20 at twenty runs; the bar below is a majority, and
 * six is enough to see a room that stopped being one.
 */
const DRIVEN_SEEDS = 6;

const WATCHMAN_L1 = {
  hp: 72,
  accuracy: 9,
  defence: 5,
  damage: 13,
  armour: 8,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TERM THE FIRST VERSION OF THIS FILE LEFT OUT, AND IT WAS THE ONE THAT
   * MATTERED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The duel model treated armour as flat subtraction — `dam - armour` — so a
   * husk swinging for 5 into armour 8 did 1. The real pipeline is
   * `applyArmour(dam, armour, apr, hardiness)`, and the Watchman's
   * `armourHardiness` is TEN: armour mitigates a tenth of a blow and no more, so
   * the same swing does 4.5. The live Case Log said `5 damage` all along and the
   * model said 1, which is how a room that kills people passed its own test.
   *
   * The real function is imported rather than approximated. That is the whole
   * lesson: a model of a formula this game already owns is a second copy that
   * can be wrong on its own.
   */
  hardiness: 10,
  apr: 0,
};

type Foe = {
  readonly name: string;
  hp: number;
  readonly def: number;
  readonly armour: number;
  readonly atk: number;
  readonly dam: number;
  readonly apr: number;
  readonly res: number;
};

type RoomFight = { readonly turns: number; readonly hpLeft: number; readonly won: boolean };

function foeOf(raw: MonsterTemplate): Foe {
  const m = raw as unknown as {
    displayName: string;
    maxHp: number;
    combat?: {
      mods?: { armour?: number; def?: number };
      weapon?: { dam?: number; atk?: number; apr?: number };
      profile?: { resists?: Record<string, number> };
    };
  };
  return {
    name: m.displayName,
    hp: m.maxHp,
    def: m.combat?.mods?.def ?? 0,
    armour: m.combat?.mods?.armour ?? 0,
    atk: m.combat?.weapon?.atk ?? 0,
    dam: m.combat?.weapon?.dam ?? 0,
    apr: m.combat?.weapon?.apr ?? 0,
    // A NEGATIVE RESIST IS A VULNERABILITY, and counting it keeps this honest.
    res: m.combat?.profile?.resists?.['physical'] ?? 0,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE ROOM AT ONCE. A ROOM IS NOT A QUEUE OF DUELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first version of this file fought each resident one at a time and every
 * one of them lost, so the room passed. Then a level-1 Watchman walked in over
 * the real socket and was ERASED FOUR TIMES without clearing it — three runs,
 * identical.
 *
 * The missing term is that EVERYTHING IN THE ROOM SWINGS EVERY TURN while the
 * player can only answer one of them. That is the difference between a fight
 * you win with sixty hit points spare and one you lose.
 *
 * IT IS STILL OPTIMISTIC, DELIBERATELY. Everybody is in melee from turn one,
 * which ignores the turns a player spends walking across the room being shot at
 * by a ranged kiter — so a room this model says is survivable is the FLOOR of
 * how bad it can be, and a room it says is lethal is worse than it looks.
 */
function room(spec: DelveSpec, count: number): RoomFight {
  /**
   * ═══ THE COMPOSITION THE PLACER ACTUALLY ROLLS, NOT A CYCLE ═══
   * This walked the roster as a cycle, because `populateDelve` did. It draws
   * from a rarity-weighted list now (`computeRarities` / `pickEntity`,
   * `engine/Zone.lua:205-262` and `:318-330`), so the honest model of a pack is
   * that list's own shares at this room's level — which is also the thing that
   * moves when a creature's `rarity` or `levelRange` is edited, so the test
   * follows the content instead of restating it.
   *
   * THE REMAINDER GOES TO THE HEAVIEST SHARE, so rounding never drops a body.
   */
  const shares = rarityShare(
    computeRarities(
      spec.roster.filter(
        (t): t is MonsterTemplate & { rarity: number; levelRange: readonly [number, number] } =>
          t.rarity !== undefined && t.levelRange !== undefined,
      ),
      delveLevel(spec),
    ),
  );
  const ranked = [...shares].sort((a, b) => b.percent - a.percent);
  const foes: Foe[] = [];
  for (const { e, percent } of ranked.slice(1)) {
    for (let i = 0; i < Math.round((percent / 100) * count); i += 1) foes.push(foeOf(e));
  }
  const lead = ranked[0];
  while (foes.length < count && lead !== undefined) foes.push(foeOf(lead.e));
  foes.length = Math.min(foes.length, count);

  let hp = WATCHMAN_L1.hp;
  let turns = 0;
  while (hp > 0 && foes.some((f) => f.hp > 0) && turns < 500) {
    turns += 1;
    const target = foes.find((f) => f.hp > 0);
    if (target === undefined) break;
    // ONE SWING, at one of them. `applyArmour` with hardiness 100 is the plain
    // reduction a monster's own armour gives.
    const mine =
      applyArmour(WATCHMAN_L1.damage, target.armour, WATCHMAN_L1.apr, 100) * (1 - target.res / 100);
    target.hp -= mine * (hitChance(WATCHMAN_L1.accuracy, target.def) / 100);

    for (const f of foes) {
      if (f.hp <= 0) continue;
      hp -=
        applyArmour(f.dam, WATCHMAN_L1.armour, f.apr, WATCHMAN_L1.hardiness) *
        (hitChance(f.atk, WATCHMAN_L1.defence) / 100);
    }
  }
  return { turns, hpLeft: hp, won: hp > 0 };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WORST PACK THIS SITE CAN BUILD: bodies inside one sight radius of a body.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Driven, not modelled. It opens the site through `createRealms` with the real
 * generator and the real placer, so it moves when `nbNpcFor`, the roster weights
 * or the placement rule move — which is the whole reason it is here rather than
 * a number read off `DelveSpec`.
 *
 * `DEFAULT_SIGHT_RADIUS` is the radius because it is the one a monster sees and
 * targets at (`content/monsters.ts`'s `aggroRange` note: a body has no other
 * eyes). A pack inside it is a pack that can all decide to come at you.
 *
 * FLOOR 1, AND A LONE LEVEL-1 PARTY, because that is who the first case sends.
 */
function packOf(siteId: string): {
  readonly arrival: number;
  readonly worst: number;
  readonly together: number;
  /** Bodies on the floor, averaged over the seeds. */
  readonly roster: number;
  /**
   * The largest SHARE of one floor's bodies standing in a single knot, over the
   * seeds. Per floor, never a max knot over a mean roster: those are two
   * different floors and dividing one by the other can read above 1.
   */
  readonly knotShare: number;
} {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  let worst = 0;
  let arrival = 0;
  let together = 0;
  let roster = 0;
  let knotShare = 0;
  const seeds = 6;
  for (let seed = 0; seed < seeds; seed += 1) {
    const at = `first-room-pack:${siteId}:${String(seed)}`;
    const realms = createRealms({ seed: at, engineFor: (world) => createTurnEngine({ world }) });
    const realm = realms.open(site, at, { level: 1, size: 1 }, undefined, undefined, 1);
    const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
    roster += bodies.length / seeds;
    const packAround = (ax: number, ay: number): number => {
      let n = 0;
      for (const b of bodies) {
        if (Math.max(Math.abs(ax - b.x), Math.abs(ay - b.y)) <= DEFAULT_SIGHT_RADIUS) n += 1;
      }
      return n;
    };
    for (const a of bodies) {
      const n = packAround(a.x, a.y);
      if (n > worst) worst = n;
    }
    const door = realm.spawns[0];
    if (door === undefined) continue;
    const here = packAround(door.x, door.y);
    if (here > arrival) arrival = here;
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE PACK THAT ARRIVES AS ONE — the number this file asserts on now.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ `arrival` IS STRUCTURALLY ZERO, AND BOTH CASES BELOW WERE VACUOUS ═══
     * It is not a content fact, it is two of our own constants meeting:
     * `DOOR_CLEARANCE` (shared/sitemap.ts) is 8 and `DEFAULT_SIGHT_RADIUS` is
     * 10, so a body is visible from the arrival tile only if it lands in a
     * two-tile annulus. Measured over this file's own six seeds, the Drowned
     * Chapel — the room the first case actually names — is 0, 0, 0, 0, 0, 0.
     * `room(spec, 0)` builds an EMPTY `foes` array, so `won` was true and
     * `hpLeft` was 72 of 72 by construction, and the smallest mutation either
     * case could see was the chapel's band at five times its shipped value.
     *
     * ═══ AND THE OBVIOUS REPLACEMENT IS WRONG IN THE OTHER DIRECTION ═══
     * Feeding it the pack within one SIGHT radius of the first body met (6 in
     * the chapel) fails both cases — and the driven probe, which this file's own
     * docblock says to trust over the model, has the Watchman clearing that
     * floor 3 of 4 with 31 damage taken and a 66% low-water mark. The model
     * breaks because its premise breaks: "everybody is in melee from turn one"
     * is a sound bound for bodies standing together and a fiction for six of
     * them spread over ten tiles, who arrive one at a time with a walk between.
     *
     * So the pack is the bodies standing WITHIN `MELEE_CONVERGENCE` OF EACH
     * OTHER — close enough that they reach you within a turn of one another,
     * which is the condition under which the model is a bound at all. It is 3
     * in both quiet rooms today, it is never zero, and it moves with `nbNpcFor`,
     * with the roster weights and with the placer, because the whole thing is
     * driven through `createRealms`.
     */
    let tightest = 0;
    for (const a of bodies) {
      let n = 0;
      for (const b of bodies) {
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= MELEE_CONVERGENCE) n += 1;
      }
      if (n > tightest) tightest = n;
    }
    if (tightest > together) together = tightest;
    if (bodies.length > 0 && tightest / bodies.length > knotShare)
      knotShare = tightest / bodies.length;
  }
  return { arrival, worst, together, roster, knotShare };
}

/**
 * The delve placing the most bodies per cell of floor, over every floor of every
 * moor delve. `undefined` if nothing in `DELVES` has a zone to measure.
 *
 * PER CELL AND NOT PER WALKABLE TILE, deliberately: walkable needs a generated
 * floor and this has to be cheap enough to run inside a unit test. The two
 * orders agree on which room is fullest — the Glass Archive is 900 cells against
 * everything else's 2500 to 3600 — and the point is to FIND the exposed room
 * rather than to grade the map.
 */
function fullestRoom(): SiteDef | undefined {
  let best: { site: SiteDef; per: number } | undefined;
  for (const site of SITES.values()) {
    const spec = DELVES.get(site.id);
    const zone = ZONES.get(site.id);
    if (spec === undefined || zone === undefined) continue;
    for (let floor = 1; floor <= zone.floors.length; floor += 1) {
      const table = zoneTable(zoneFloor(zone, floor), zone.palette);
      if (typeof table === 'function') continue;
      const band = spec.nbNpcByFloor?.get(floor) ?? spec.nbNpc;
      const per = (band[0] + band[1]) / 2 / (table.width * table.height);
      if (best === undefined || per > best.per) best = { site, per };
    }
  }
  return best?.site;
}

describe('the gentlest room in the game', () => {
  /**
   * THE PICKER NAMES BY GRADE, so the invariant is about grades and not about
   * one site id. Hard-coding `site:drowned_chapel` would pass the day somebody
   * authors a second quiet room and puts an elite in it.
   */
  const quiet = [...DELVES.entries()].filter(([, spec]) => dangerWord(spec) === 'quiet');

  it('exists at all, because the first case has to have something to name', () => {
    // ═══ THE HALF THAT MUST NOT MOVE ═══
    // With no `quiet` room the picker falls to `restless`, and the game's one
    // instruction starts pointing a four-minute-old character somewhere the
    // grade itself calls unsettled.
    expect(quiet.length, 'no room in the game is graded quiet any more').toBeGreaterThan(0);
  });

  it('does not kill a beginner for walking in — DRIVEN, because the model was refuted', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS CASE USED TO BE `room(spec, packs.together)` AND IT WAS WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It fed the crude duel model the floor's TIGHTEST KNOT — the largest group
     * standing within `MELEE_CONVERGENCE` of one of its own, maxed over six
     * seeds — and pinned a level-1 Watchman in the middle of it with no talents,
     * no step back and no doorway until somebody died. At the counts this
     * repository shipped for a while (a global factor of 0.4 on every band,
     * since deleted) that knot was three
     * and the model said he lived on 7 of 72 hit points. At upstream's own
     * counts the knot is four and the model says "dead in 5 turns".
     *
     * ═══ AND THE INSTRUMENT THIS FILE ALREADY DEFERS TO SAYS OTHERWISE ═══
     * The docblock below `packOf` says it in as many words: *"no model here
     * should be trusted over it"*, meaning the driven probe. Measured through
     * `tools/delve-run.mjs` on this exact floor, at upstream's own counts, a
     * level-1 Watchman alone clears the Drowned Chapel **20 runs out of 20**,
     * taking 76 damage of 72 hit points' worth of pool and bottoming out at 31%.
     * A party of four clears it 8 of 20 and WIPES 0 of 20. The model's verdict
     * is not pessimistic, it is false, and it is false in the one direction its
     * own comment promised it could not be.
     *
     * ═══ WHY THE MODEL BREAKS HERE, NAMED RATHER THAN SHRUGGED AT ═══
     * `packs.together` is an EXTREME-VALUE statistic. It is the tightest cluster
     * anywhere on a two-thousand-tile floor in any of six generations, and its
     * expectation grows with the body count for the arithmetic reason that there
     * are more draws — not because the room got tighter per body. Upstream's
     * placer is an independent uniform draw per body
     * (`engine/generator/actor/Random.lua:112-117`) and therefore clumps exactly
     * like this at exactly these counts; a ToME level-1 character standing still
     * inside four of its own tier-1 residents dies too. The answer upstream
     * gives is not a thinner floor, it is that you do not stand there.
     *
     * ═══ SO THE QUESTION IS DRIVEN, AND THE PACK NUMBERS BECOME EVIDENCE ═══
     * `packOf` stays exactly as it was and its numbers are asserted on below —
     * they are a real fact about the placer and they move when it moves. What
     * is gone is a MODEL'S VERDICT standing in for a measurement this repository
     * already owns. `run` is imported from the same probe the balance readings
     * are taken with, so this case and those readings cannot drift apart.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * THE WATCHMAN, AND THE SENTENCE THAT USED TO JUSTIFY THAT WAS WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It read: *"the other three lose this floor at EVERY factor from 0.4 up,
     * which is a fact about them and not about the room."* Two of the three, and
     * not the third. Driven, six solo runs a cell, the Drowned Chapel's first
     * floor at level 1, sweeping the global factor this repository used to carry
     * on every band — HISTORY NOW, because that factor is deleted and the counts
     * are each zone's own (`DelveSpec.countFrom`). The column that ships is the
     * right-hand one plus about a sixth:
     *
     *     factor        0.40   0.55   0.70   0.85
     *     Watchman       6/6    6/6    6/6    6/6
     *     Inspector      0/6    0/6    0/6    0/6
     *     Alchemist      4/6    2/6    0/6    0/6
     *     Redactor       0/6    0/6    0/6    0/6
     *     party of 4     4/6    4/6    2/6    1/6
     *     party turns    445    508    718    799
     *
     * The Inspector and the Redactor are the two the sentence was true of, and
     * their failure is density-independent and belongs to the class lane. THE
     * ALCHEMIST IS A DENSITY READING and the old sentence swept her in with them:
     * she clears this floor four runs in six at 0.40 and none at 0.70. So is the
     * party of four, which is the game that actually ships — its clear rate falls
     * and its turn count nearly doubles across the same range, with ZERO wipes at
     * every factor, which is the *"merely longer rather than more urgent"*
     * failure by name.
     *
     * NONE OF THAT IS ASSERTED HERE, and deliberately: those cells cost minutes
     * (a losing class runs to the 900-turn cap) and a unit test that takes
     * minutes stops being run, which is this file's own standing argument about
     * the wipe RATE. This table is what happens when one number about twelve
     * delves is set against one instrument, and it is most of the reason there is
     * no such number any more.
     *
     * ═══ AND THE ALIGNMENT DID NOT MOVE THIS ROOM, WHICH WAS THE WORRY ═══
     * Deleting the factor took the Drowned Chapel from `{17, 26}` to the
     * Blighted Ruins' `{20, 30}` — a sixth more bodies on the floor a
     * four-minute-old character is sent to by name. Measured, eighty solo runs
     * of a level-1 Watchman: ONE wipe here and none on the Undermost, which is
     * the same rate the old note recorded at 0.85. The beginner-room bound did
     * not need a row of its own after all, and that is a measurement rather than
     * a hope.
     *
     * THE WATCHMAN is still the driven class here, because he is the class the
     * crude model was written as and the one whose answer is a fact about the
     * ROOM rather than about a class that cannot fight in it.
     */
    const beginner = CLASSES[0];
    expect(beginner?.id, 'the first class is no longer the Watchman').toContain('watchman');
    for (const [id] of quiet) {
      const site = SITES.get(id);
      expect(site, `no site for ${String(id)}`).toBeDefined();
      if (site === undefined || beginner === undefined) continue;
      const runs = Array.from({ length: DRIVEN_SEEDS }, (_unused, i) =>
        run(site, 1, `first-room-driven:${String(id)}:${String(i)}`, {
          party: [beginner],
          level: 1,
          floor: 1,
        }),
      );
      /**
       * ═══ THE PRECONDITION, BECAUSE WITHOUT IT THIS ASSERTS NOTHING ═══
       * An empty floor is cleared by walking onto the stairs. `roster` is the
       * hostiles the placer actually put down, counted through `areEnemies`.
       */
      const roster = runs.reduce((a, r) => a + r.roster, 0) / runs.length;
      expect(roster, `${String(id)} puts nothing in front of a beginner`).toBeGreaterThan(0);

      /**
       * A WIPE IS THE BAR, NOT A CLEAR. `delve-run.mjs`'s own closing note is
       * that a STALL is the driver and never the room — it walks at the nearest
       * body and bump-attacks, so a run that ends with foes left says this
       * driver could not finish, not that a player could not. A wipe is the
       * thing the case is actually about: the room killed somebody four minutes
       * old for walking in.
       *
       * ═══ IT IS A SPOT CHECK ON FIXED SEEDS, AND THE RATE IS ELSEWHERE ═══
       * These are seeds 0..N-1 of one labelled sequence, so this case is
       * DETERMINISTIC — it does not pass on Tuesday and fail on Wednesday, which
       * is the failure `vitest.config.ts` says is worse than a slow test. What
       * it cannot see is a RATE: a lone level-1 Watchman is erased on about one
       * floor of this delve in eighty, and eighty runs do not belong in a unit
       * test. MEASURED AGAIN AFTER THE COUNTS WERE ALIGNED — the Drowned Chapel
       * went from `{17, 26}` to the Blighted Ruins' `{20, 30}` when the global
       * factor came off — and the rate did not move: 1 wipe in 80 here and 0 in
       * 80 on the Undermost, worst run bottoming out at 7% of the bar. What this
       * catches is a room that became lethal rather than one that drifted a
       * point.
       *
       * ═══ AND THEN RANGES TOOK TOME'S ROUNDING, AND THE RATE DID DRIFT ═══
       * Measured 2026-09-22, eighty seeds each, one snapshot per commit:
       *
       *                          Drowned Chapel   Undermost
       *   before the port             1 / 80        0 / 80
       *   balls take the disc         1 / 80        0 / 80
       *   ranges round (0a03d5f)      5 / 80        0 / 80
       *   + the birth point probe     3 / 80        1 / 80
       *
       * Ranged monsters fire from ToME's rounded circle now — a few more tiles
       * off each axis — and a lone level-1 Watchman walking the Chapel takes a
       * shot or two more. That is ToME's geometry, reported rather than tuned
       * back. It moved the base rate from ~1% to ~5%, which put a rare wipe on
       * one of these six fixed seeds (seed 3 once the probe spends Cityborn's
       * birth point). So the bar is ONE of six: at a ~5% rate two wipes in six
       * fixed seeds is a ~3% draw, while a room that had really become lethal —
       * one in three — puts two or more in six about two times in three.
       */
      const wiped = runs.filter((r) => r.outcome === 'wipe').length;
      expect(
        wiped,
        `${String(id)} erased a level-1 Watchman ${String(wiped)} of ${String(DRIVEN_SEEDS)} times`,
      ).toBeLessThanOrEqual(1);

      /**
       * AND IT IS FINISHABLE, which is the other half and the half a wipe count
       * cannot see. A majority, not all of them: the driver is deliberately
       * unclever and a room nobody can lose is not a room.
       */
      const cleared = runs.filter((r) => r.outcome === 'clear').length;
      expect(
        cleared * 2,
        `${String(id)} was cleared ${String(cleared)} of ${String(DRIVEN_SEEDS)} times`,
      ).toBeGreaterThan(DRIVEN_SEEDS);
    }
  });

  it('does not kill the CLASS THE ROOM IS BUILT FOR in the fullest room there is', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE GUARD THAT DID NOT EXIST: NOTHING FAILED WHEN A DELVE STOPPED BEING
     * WALKABLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `grep -rn "delve-run.mjs" test/` used to return exactly one file — this
     * one — and it drove ONE floor of ONE delve with ONE class at level one.
     * Everything past the beginner's room was covered by arithmetic about the
     * table and by nobody walking into it, so the Hollow Mine could ship at ten
     * bodies per hundred walkable tiles with the suite green, and it did.
     *
     * ═══ THE ROOM IS FOUND, NOT NAMED ═══
     * A list of ids here would be the same defect one level up: it would pass
     * the day a thirteenth delve arrived. The room asked about is the one with
     * the most bodies per CELL OF FLOOR in the whole table — the most exposed to
     * a count going the wrong way, because a count landing on a small floor is
     * where density actually moves. Read off `nbNpc` and the zone's own
     * `width`/`height`, so it costs nothing to find: today it is the Glass
     * Archive, `{20, 30}` on 900 cells, whose count this alignment raised by
     * three quarters.
     *
     * ═══ AND A WIPE IS THE BAR, FOR THE REASON THE CASE ABOVE GIVES ═══
     * A stall is the driver and never the room. The Outer Index is 0 clears in
     * 64 runs and every survivor is REACHABLE at the end — it is 3600 cells of
     * two-wide corridor against a 900-turn cap, and its worst health is 68%
     * whatever the cap is raised to. Asserting clears here would pin that probe
     * limit as though it were a fact about the game. A WIPE is a fact about the
     * game: the room killed the class it is easiest on, standing at its own
     * level.
     */
    const site = fullestRoom();
    expect(site, 'no delve has a floor to measure').toBeDefined();
    const beginner = CLASSES[0];
    if (site === undefined || beginner === undefined) return;
    const spec = DELVES.get(site.id);
    expect(spec, `${site.id} is not in DELVES`).toBeDefined();
    if (spec === undefined) return;

    const runs = Array.from({ length: DRIVEN_SEEDS }, (_unused, i) =>
      run(site, 1, `fullest-room-driven:${site.id}:${String(i)}`, {
        party: [beginner],
        level: delveLevel(spec),
        floor: 1,
      }),
    );
    const roster = runs.reduce((a, r) => a + r.roster, 0) / runs.length;
    expect(roster, `${site.id} puts nothing on its floor`).toBeGreaterThan(0);

    /**
     * ═══ A MAJORITY, NOT ALL OF THEM, AND THAT IS NOT A HEDGE ═══
     * The measured rate here is one wipe in four at the moment — this IS the
     * fullest room in the game, the class is alone, and being alone is not the
     * configuration this game is built for. "Zero wipes over six fixed seeds"
     * was the first bar written and it was seed luck: the sweep and this case
     * disagreed on the same room because they draw different labels. A bar a
     * harmless change can turn red by reshuffling the stream is a bar about the
     * fixture. A MAJORITY WALKS OUT is a statement about the room, and it is the
     * one that moves when a count does: with the placer tripled it goes red.
     */
    const wiped = runs.filter((r) => r.outcome === 'wipe').length;
    expect(
      wiped * 2,
      `${site.id} — the fullest room in the game — erased a Watchman standing at its own` +
        ` level ${String(wiped)} of ${String(DRIVEN_SEEDS)} times, on ${roster.toFixed(1)} bodies`,
    ).toBeLessThan(DRIVEN_SEEDS);

    /**
     * AND IT CAN BE FINISHED. A room nobody walks out of with the floor cleared
     * is not a fight, and the wipe count above cannot see that: a room that
     * stalled every run at full health would pass it. One clear is the bar,
     * because a stall is the driver and never the room (see the case above).
     */
    const cleared = runs.filter((r) => r.outcome === 'clear').length;
    expect(
      cleared,
      `${site.id} was never finished in ${String(DRIVEN_SEEDS)} runs`,
    ).toBeGreaterThan(0);
  });

  it('leaves a beginner a real margin for walking in, not a coin flip', () => {
    /**
     * WINNING IS NOT ENOUGH. The model gives the player every benefit it can —
     * no crits against them, no bad luck — and takes them all away again by
     * putting the whole arrival pack in melee from turn one. So a fight it says
     * is won on fumes is a fight lost in practice, which is exactly what the
     * live probe found.
     *
     * A THIRD OF THE BAR is the bound, and it was the rule the old global factor
     * was set against. The factor is gone and the bound is not: it decides
     * whether the room the first case NAMES is beatable by walking into it, and
     * the counts it is asked of are upstream's own now (`DelveSpec.countFrom`).
     */
    for (const [id, spec] of quiet) {
      const packs = packOf(id);
      /**
       * ═══ TWO BARS, AND THEY ARE DIFFERENT FIGHTS ═══
       * The case above asks whether the room KILLS a beginner, and it is driven
       * because the model's answer to that was measured false. This one is the
       * question the crude model is still a sound bound for, and it is a
       * narrower one: WALKING IN. That pack is small by construction
       * (`DOOR_CLEARANCE` against `DEFAULT_SIGHT_RADIUS` — see `packOf`;
       * measured 0 or 1 on the Drowned Chapel at upstream's counts), and the
       * bar here is that it STAYS small. A placer that started dropping bodies
       * on the arrival tile would fail this line, and a beginner would meet them
       * before they had taken a turn.
       */
      expect(
        packs.arrival,
        `${String(id)} has ${String(packs.arrival)} on the arrival tile`,
      ).toBeLessThanOrEqual(MELEE_CONVERGENCE);
      /**
       * ═══ AND THE FLOOR IS SCATTERED, NOT HEAPED ═══
       * `packs.together` is the tightest knot anywhere on the floor. It is NOT a
       * bound on difficulty — that reading is what the case above had to stop
       * doing — but it IS a bound on the PLACER: upstream draws every body
       * independently and uniformly (`engine/generator/actor/Random.lua:112-117`)
       * and that clumps into knots of four or five out of twenty-five. A placer
       * that lost the independent draw, or that grew an `OnSpots` radius by a
       * digit, would pile a floor into one heap by the door, and the only thing
       * that catches it is a number about the WHOLE floor rather than about the
       * arrival tile. Measured at upstream's counts: 4 of 24.8 on the Drowned
       * Chapel, 5 of 23.0 on the Undermost.
       */
      expect(
        packs.knotShare,
        `${String(id)} stands ${(100 * packs.knotShare).toFixed(0)}% of one floor's` +
          ` ${packs.roster.toFixed(1)} bodies in a single knot (worst knot ${String(packs.together)})`,
      ).toBeLessThan(0.5);
      const fight = room(spec, packs.arrival);
      expect(
        fight.hpLeft / WATCHMAN_L1.hp,
        `${String(id)} leaves a beginner ${fight.hpLeft.toFixed(0)} of ${String(WATCHMAN_L1.hp)} hp`,
      ).toBeGreaterThan(1 / 3);
    }
  });

  it('is gentler than the room the game points at next', () => {
    /**
     * THE GRADIENT, WHICH THE OLD BAND HAD FLATTENED. The gentlest room was 3-5
     * and the next one out is 4-6 — nearly the same fight, so a player who
     * survived the first had learned nothing about what "restless" meant.
     */
    for (const [, spec] of quiet) {
      const next = [...DELVES.values()].find((other) => dangerWord(other) === 'restless');
      expect(next, 'no restless room to compare against').toBeDefined();
      if (next === undefined) continue;
      /**
       * ═══ DEEPER, AND IT USED TO BE CROWDED ═══
       * This read `spec.monsters[1] < next.monsters[1]`. The counts are
       * upstream's `nb_npc` now, and upstream's density is a fact about the ZONE
       * a delve is built as rather than about how dangerous it is: the escape
       * from Reknor holds 50-60 at `level_range = {1, 5}`
       * (`reknor-escape/zone.lua:50`) and the Old Forest 20-30 at `{7, 16}`
       * (`old-forest/zone.lua:58`). The gentlest room in our game IS the denser
       * of those two, because it is the one every character wakes up in.
       *
       * What must be ordered is the level every body in the room is born at —
       * `delveLevel`, which `actor_adjust_level` feeds and `rankLifeAdjust`
       * compounds, and which `dangerWord` now grades on.
       */
      expect(delveLevel(spec), 'the quiet room is not gentler than the next one').toBeLessThan(
        delveLevel(next),
      );
    }
  });

  it('still says quiet, so the townsfolk and the map agree with it', () => {
    /**
     * `dangerWord`'s own note refuses to let a grade drift away from what the
     * townsfolk say: Merrow's directions call this room *"close and it is
     * quiet"*, and a hint that disagrees with the map is a hint players stop
     * reading. Fixing the ROOM rather than the GRADE is what keeps both true.
     */
    const chapel = DELVES.get('site:drowned_chapel');
    expect(chapel, 'the chapel is not in the table any more').toBeDefined();
    if (chapel !== undefined) expect(dangerWord(chapel)).toBe('quiet');
  });
});
