// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { DELVES, dangerWord } from '../../src/server/content/delve.ts';
import { hitChance } from '../../src/shared/checkhit.ts';
import type { MonsterTemplate } from '../../src/server/content/monsters.ts';

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
const WATCHMAN_L1 = { hp: 72, accuracy: 9, defence: 5, damage: 13, armour: 8 };

type Duel = {
  readonly name: string;
  readonly myTurns: number;
  readonly theirTurns: number;
};

function duel(raw: MonsterTemplate): Duel {
  const m = raw as unknown as {
    displayName: string;
    maxHp: number;
    combat?: {
      mods?: { armour?: number; def?: number };
      weapon?: { dam?: number; atk?: number };
      profile?: { resists?: Record<string, number> };
    };
  };
  const def = m.combat?.mods?.def ?? 0;
  const armour = m.combat?.mods?.armour ?? 0;
  const theirAtk = m.combat?.weapon?.atk ?? 0;
  const theirDam = m.combat?.weapon?.dam ?? 0;
  // A NEGATIVE RESIST IS A VULNERABILITY, and counting it is what keeps this
  // honest: the Wraith takes 30% MORE physical, and it still wins.
  const physResist = m.combat?.profile?.resists?.['physical'] ?? 0;

  const myHit = hitChance(WATCHMAN_L1.accuracy, def) / 100;
  const theirHit = hitChance(theirAtk, WATCHMAN_L1.defence) / 100;
  const myPerHit = Math.max(1, (WATCHMAN_L1.damage - armour) * (1 - physResist / 100));
  const theirPerHit = Math.max(1, theirDam - WATCHMAN_L1.armour);

  return {
    name: m.displayName,
    myTurns: m.maxHp / (myPerHit * myHit),
    theirTurns: WATCHMAN_L1.hp / (theirPerHit * theirHit),
  };
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

  it('holds nothing a beginner cannot beat by walking into it', () => {
    const losses: string[] = [];
    for (const [id, spec] of quiet) {
      for (const monster of spec.roster) {
        const fight = duel(monster);
        if (fight.myTurns >= fight.theirTurns) {
          losses.push(
            `${String(id)} / ${fight.name}: ${fight.myTurns.toFixed(0)} turns to kill, ` +
              `${fight.theirTurns.toFixed(0)} to die`,
          );
        }
      }
    }
    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the roster changed: "site:drowned_chapel / Index Wraith: 21 turns
    // to kill, 14 to die". Put `INDEX_WRAITH` back in `DROWNED` and it returns.
    expect(losses).toEqual([]);
  });

  it('leaves a beginner a real margin, not a coin flip', () => {
    /**
     * WINNING IS NOT ENOUGH. A fight won on the last hit point is a fight most
     * players lose, because this model has no crits, no bad luck and no second
     * monster — and a beginner room contains three at once.
     *
     * TWICE OVER is the bound, and it is loose on purpose: the Cairn and the
     * Husk clear it by a factor of twenty. It exists to catch the next monster
     * somebody drops in here, not to tune the two that are.
     */
    for (const [id, spec] of quiet) {
      for (const monster of spec.roster) {
        const fight = duel(monster);
        expect(
          fight.theirTurns / fight.myTurns,
          `${String(id)} / ${fight.name} is a close-run thing`,
        ).toBeGreaterThan(2);
      }
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
