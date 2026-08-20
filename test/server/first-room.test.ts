// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord } from '../../src/server/content/delve.ts';
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
  const foes: Foe[] = [];
  for (let i = 0; i < count; i += 1) {
    const template = spec.roster[i % spec.roster.length];
    if (template === undefined) continue;
    foes.push(foeOf(template));
  }

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

  it('can be cleared by a beginner at the WORST roll of its band', () => {
    /**
     * ═══ THE TOP OF THE BAND, NOT THE BOTTOM ═══
     * `populateDelve` rolls `monsters[0]..monsters[1]`, so the honest question
     * is whether the unluckiest roll is survivable — a room that is winnable
     * only when it spawns light is a room that kills a share of the players sent
     * to it, and the first case sends every one of them.
     */
    const losses: string[] = [];
    for (const [id, spec] of quiet) {
      const worst = room(spec, spec.monsters[1]);
      if (!worst.won) {
        losses.push(
          `${String(id)} at ${String(spec.monsters[1])} foes: dead in ${String(worst.turns)} turns`,
        );
      }
    }
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // At the old 3-5 band: "site:drowned_chapel at 5 foes: dead in 5 turns".
    // Measured live at the same time: erased four times, never cleared, three
    // runs identical.
    expect(losses).toEqual([]);
  });

  it('leaves a beginner a real margin at the worst roll, not a coin flip', () => {
    /**
     * WINNING IS NOT ENOUGH. This model gives the player every benefit it can:
     * no crits against them, no bad luck, and everybody in melee from turn one —
     * which ignores the turns actually spent walking across a room while a
     * ranged kiter shoots. So a fight it says is won on fumes is a fight lost in
     * practice, which is exactly what the live probe found.
     *
     * A THIRD OF THE BAR is the bound. It is not a tuning knob for these two
     * monsters — they clear it comfortably — it is there to catch the next thing
     * somebody puts in the game's beginner room.
     */
    for (const [id, spec] of quiet) {
      const worst = room(spec, spec.monsters[1]);
      expect(
        worst.hpLeft / WATCHMAN_L1.hp,
        `${String(id)} leaves a beginner ${worst.hpLeft.toFixed(0)} of ${String(WATCHMAN_L1.hp)} hp`,
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
      expect(spec.monsters[1], 'the quiet room is as crowded as the restless one').toBeLessThan(
        next.monsters[1],
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
