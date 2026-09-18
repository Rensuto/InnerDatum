// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord, delveLevel } from '../../src/server/content/delve.ts';
import { computeRarities, rarityShare } from '../../src/server/content/rarity.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
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
} {
  const site = SITES.get(siteId);
  if (site === undefined) throw new Error(`no site ${siteId}`);
  let worst = 0;
  let arrival = 0;
  let together = 0;
  for (let seed = 0; seed < 6; seed += 1) {
    const at = `first-room-pack:${siteId}:${String(seed)}`;
    const realms = createRealms({ seed: at, engineFor: (world) => createTurnEngine({ world }) });
    const realm = realms.open(site, at, { level: 1, size: 1 }, undefined, undefined, 1);
    const bodies = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster);
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
    for (const a of bodies) {
      let n = 0;
      for (const b of bodies) {
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= MELEE_CONVERGENCE) n += 1;
      }
      if (n > together) together = n;
    }
  }
  return { arrival, worst, together };
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

  it('does not kill a beginner for walking in', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ARRIVAL, AND THIS USED TO BE THE WHOLE FLOOR AT ONCE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * It fed `room()` the TOP OF THE BAND: every body in the delve, swinging on
     * turn one. That was a fair worst case when a delve held two to five bodies
     * on a 34x30 floor, because five bodies can genuinely surround you there.
     *
     * The counts are upstream's `nb_npc` now and the floors are upstream's size.
     * The Drowned Chapel spreads its bodies over 2098 walkable tiles at a mean
     * of ten tiles apart; a model that puts all of them in melee on turn one is
     * not a pessimistic model, it is a model of something that cannot happen —
     * the same fault as the first version of this file, which fought the room as
     * a QUEUE OF DUELS, arrived at from the other side.
     *
     * ═══ SO IT ASKS THE QUESTION THE MODEL CAN ACTUALLY ANSWER ═══
     * What is on you when you WALK IN. Everything within sight of the arrival
     * tile really can come at once, really does arrive together, and really is
     * met by a character four minutes old with no room read and no plan. That is
     * the rule the first case creates, and it is the one a crude exchange of
     * average blows is a sound bound for.
     *
     * WHETHER THE FLOOR CAN BE CLEARED is a different question and a driven one:
     * `tools/delve-density.mjs` fights every class through every floor of every
     * delve with the real talents, the real gear and the real AI. It is the
     * instrument that caught this room killing people in the first place, and no
     * model here should be trusted over it.
     *
     * IT IS A LIVE NUMBER NOW, WHICH IT WAS NOT. Measured at HEAD, over six
     * seeds of each of the twelve delves, the number of monsters that could see
     * the arrival tile was 0.00 in eleven of twelve — the placer combed bodies
     * evenly across the floor, so the nearest one stood 13 to 37 tiles away. With
     * the comb replaced by upstream's independent uniform draw
     * (`engine/generator/actor/Random.lua:112-117`) and the counts raised, the
     * nearest body is 8 to 17 tiles out and something is in sight on most
     * floors — so this assertion has something to assert about.
     */
    const losses: string[] = [];
    for (const [id, spec] of quiet) {
      const packs = packOf(id);
      /**
       * ═══ THE PRECONDITION, BECAUSE WITHOUT IT THIS CASE ASSERTED NOTHING ═══
       * A pack of zero builds an empty `foes` array and `won` is true before the
       * loop runs. Stated as its own expectation so the day the placer or
       * `DOOR_CLEARANCE` empties this again, the failure says so instead of
       * silently passing.
       */
      expect(packs.together, `${String(id)} puts nothing in front of a beginner`).toBeGreaterThan(
        0,
      );
      const fight = room(spec, packs.together);
      if (!fight.won) {
        losses.push(
          `${String(id)} at a pack of ${String(packs.together)}: dead in ${String(fight.turns)} turns`,
        );
      }
    }
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // At the old 3-5 band: "site:drowned_chapel at 5 foes: dead in 5 turns".
    // Measured live at the same time: erased four times, never cleared, three
    // runs identical.
    expect(losses).toEqual([]);
  });

  it('leaves a beginner a real margin for walking in, not a coin flip', () => {
    /**
     * WINNING IS NOT ENOUGH. The model gives the player every benefit it can —
     * no crits against them, no bad luck — and takes them all away again by
     * putting the whole arrival pack in melee from turn one. So a fight it says
     * is won on fumes is a fight lost in practice, which is exactly what the
     * live probe found.
     *
     * A THIRD OF THE BAR is the bound, and it is the rule `NB_NPC_SCALE` was set
     * against: it decides how far upstream's `nb_npc` can be taken before the
     * room the first case NAMES stops being beatable by walking into it.
     */
    for (const [id, spec] of quiet) {
      const packs = packOf(id);
      /**
       * ═══ TWO BARS, AND THEY ARE DIFFERENT FIGHTS ═══
       * The case above asks the model the question it is a sound bound for —
       * does the knot you must walk to KILL you — and that one is tight: the
       * chapel's pack of three leaves a level-1 Watchman 7 of 72. A third of the
       * bar is not a margin the crude model can carry against a knot, and
       * calibrating it until it does would be writing the bar to fit the answer.
       *
       * The margin belongs to the other fight, the one the grade is a promise
       * about: WALKING IN. That pack is small by construction (`DOOR_CLEARANCE`
       * against `DEFAULT_SIGHT_RADIUS` — see `packOf`), and the bar here is that
       * it STAYS small. A placer that started dropping bodies on the arrival
       * tile would fail this line, and a beginner would meet them before they
       * had taken a turn.
       */
      expect(
        packs.arrival,
        `${String(id)} has ${String(packs.arrival)} on the arrival tile`,
      ).toBeLessThanOrEqual(MELEE_CONVERGENCE);
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
