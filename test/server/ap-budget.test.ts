import { describe, expect, it } from 'vitest';

import {
  CLASSES,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAN THIS CLASS SPEND ITS ROUND ON TWO THINGS? THE ALCHEMIST COULD NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DECISIONS.md` D1 is Accepted and its table reads *"Intra-turn budget: 6 AP /
 * 3 MP, spendable across several talents in one park"*. Every talent in the
 * game is priced against that round, and `ward_rush.ts` derives its own cooldown
 * from *"an Inner Datum turn holds ~2 actions from a 6 AP budget"*.
 *
 * The engine has never enforced it — one submitted action ends the actor's turn
 * — so the whole table has been decorative. Making it real is under way, and
 * this file guards the half that has to be right BEFORE the engine changes:
 * that the numbers actually admit the decision they promise.
 *
 * They did not. At the authored prices the Alchemist's kit was {4, 5, 4, 4} and
 * her cheapest PAIR was 8 against a budget of 6 — **no two-talent round existed
 * for her at all**, so the feature would have shipped for two classes of three
 * and silently skipped the third. Ashwick Flare 4→3 and Mend Wounds 4→3 are the
 * change; this is the assertion that stops the next reprice undoing it without
 * anybody noticing, because nothing else in the suite can see it.
 */

/** The round, from `content/classes.ts`. Every class shares it today. */
const BUDGET = 6;

/** Every pair of loadout talents this class could afford in one round. */
function chainsFor(classDef: (typeof CLASSES)[number]): string[] {
  const engine = createContentTalentEngine();
  const sheet = sheetForClass(classDef);
  const costs = sheet.loadout.flatMap((id) => {
    const talent = engine.registry.get(id);
    return talent === undefined ? [] : [{ name: talent.name, ap: talent.cost.ap ?? 0 }];
  });

  const out: string[] = [];
  for (let i = 0; i < costs.length; i += 1) {
    for (let j = i; j < costs.length; j += 1) {
      const a = costs[i];
      const b = costs[j];
      if (a === undefined || b === undefined) continue;
      if (a.ap + b.ap <= BUDGET) out.push(`${a.name} + ${b.name}`);
    }
  }
  return out;
}

describe('the 6-AP round admits a decision, for every class', () => {
  it.each(CLASSES.map((c) => ({ name: c.name, def: c })))(
    '$name can spend one round on two talents',
    ({ def }) => {
      const chains = chainsFor(def);
      // THE ALCHEMIST'S CASE, and the reason this file exists. An empty list
      // means that class experiences the intra-turn budget as "one talent, then
      // your round is over" — which is the behaviour the budget replaces.
      expect(chains.length, `${def.name} has no affordable two-talent round`).toBeGreaterThan(0);
    },
  );

  it('keeps the signatures worth their price — a 5 is your whole round', () => {
    /**
     * The other half, and it is what stops "make everything cheap" being the
     * answer to the test above. Lockdown, Iron Curtain, Sniper's Mark and
     * Alchemic Vial cost 5 of 6 deliberately: the signature IS the round, with
     * 1 AP stranded. If one of them ever pairs with anything, the choice between
     * "one big thing" and "two small things" has quietly stopped existing.
     */
    const engine = createContentTalentEngine();
    const signatures = ['lockdown', 'iron_curtain', 'snipers_mark', 'alchemic_vial'];
    for (const bare of signatures) {
      const talent = engine.registry.get(`talent:${bare}`);
      expect(talent, bare).toBeDefined();
      if (talent === undefined) continue;
      const ap = talent.cost.ap ?? 0;
      // Nothing else in the game costs less than 2, so a signature that leaves
      // 2 or more would pair with Ward Rush.
      expect(BUDGET - ap, `${talent.name} leaves room for a second talent`).toBeLessThan(2);
    }
  });

  it('leaves the cheapest engage in the game genuinely cheapest', () => {
    // ward_rush.ts calls itself "the cheapest engage in the game" and derives its
    // cooldown from the two-action round. A reprice that made something cheaper
    // would make that sentence false in a file that reasons from it.
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AMONG THINGS THAT *RESOLVE*. A STANCE COSTS NOTHING AND IS NOT AN ENGAGE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This walked the whole loadout, which was the same list while every entry
     * on it was an active that resolved. The Inspector's Method tree put two
     * SUSTAINS on the bar — Careful Method and Working Fast — and a stance
     * deliberately costs 0 AP: charging for one would mean putting it up costs a
     * turn's action, and a player would simply never change stance mid-fight,
     * which is the one moment the choice is interesting. A stance pays in
     * `sustain.reserve`, off the pool's ceiling.
     *
     * So a 0 here is not a reprice that undercut Ward Rush; it is a different
     * kind of thing being compared to it. Filtered on `onUse`, which is the
     * field the engine itself dispatches on — the same rule
     * `talent-scaling.test.ts` uses to decide what counts as an active.
     */
    const engine = createContentTalentEngine();
    const all = CLASSES.flatMap((c) =>
      sheetForClass(c).loadout.flatMap((id) => {
        const t = engine.registry.get(id);
        return t === undefined || t.onUse === undefined
          ? []
          : [{ name: t.name, ap: t.cost.ap ?? 0 }];
      }),
    );
    const cheapest = Math.min(...all.map((t) => t.ap));
    const ward = engine.registry.get('talent:ward_rush');
    expect(ward?.cost.ap).toBe(cheapest);
  });
});
