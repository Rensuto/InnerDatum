// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Player.lua:971-1075 (`restCheck`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REST — pass turns until there is a reason to stop.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS IS ONE OF THE FIRST THINGS TO PORT ═══
 * Regeneration in this game is 0.5 hit points a GAME TURN, and inside a delve a
 * game turn only passes when somebody acts. So a party that wanted to walk into
 * the next room at full health had exactly one way to get there: press hold,
 * over and over, watching a number climb by a half.
 *
 * Upstream solved that fifteen years ago and tuned the solution the whole time.
 * This is that rule, ported: WHAT counts as a reason to keep resting, WHAT
 * interrupts it, and the detail that makes it feel generous rather than tedious
 * — rest gets faster the longer it goes on.
 *
 * ═══ IT IS A PREDICATE, AND UPSTREAM'S IS NOT ═══
 * `restCheck` heals inside itself (`act:heal(act.life_regen * perc)` at :988) as
 * well as answering whether to continue. That is a function named `check` with a
 * side effect on the party, and porting it faithfully would put a heal inside
 * something every future caller will assume is safe to ask twice.
 *
 * So the two halves are separated: this file ANSWERS, and the caller
 * (`turn-engine.ts`) does the healing with `restBonus` below. The arithmetic is
 * upstream's; only the seam moved.
 *
 * ═══ AND IT IS PURE, SO THE RULE IS TESTABLE WITHOUT A WORLD ═══
 * `src/shared/` may not read a clock, a file or a die. A rest that ran for
 * twelve turns is twelve applications of a function of a view — which is what
 * makes "does it stop when a husk walks in" a unit test rather than a session.
 */

/** Why resting stopped. The player is told, always — see `restStopText`. */
export const RestStop = {
  /**
   * Something hostile is in sight. Upstream's first check after the dialog one
   * (Player.lua:974-981) and the only one that carries a DIRECTION, because
   * "you stopped" without "and it is north-east of you" is an alarm with no
   * information in it.
   */
  Hostile: 'hostile',
  /** Player.lua:1003 — `life_regen <= 0`, "losing health!". */
  Bleeding: 'bleeding',
  /**
   * Nothing left to gain: full health, a full pool, no affliction still running
   * and no cooldown still turning. Upstream reaches this by falling off the end
   * of every `return true`.
   */
  Done: 'done',
  /**
   * The caller's bound, not upstream's. `restCheck` has no turn limit because a
   * Lua game loop can be interrupted by a keypress; turn resolution here is
   * synchronous and a rest that never answered would be a server that never
   * answered. See `REST_MAX_TURNS`.
   */
  Budget: 'budget',
} as const;
export type RestStop = (typeof RestStop)[keyof typeof RestStop];

/**
 * The most turns one rest may pass.
 *
 * NOT A BALANCE NUMBER — a liveness one. Every turn resolves synchronously, so
 * this is the bound on how long one intent can hold the whole realm. Two hundred
 * turns of regeneration is far more than any body needs (a 60-point Watchman
 * heals from one hit point in about forty), so a rest that hits this limit has
 * found a state where `restCheck` never says Done, and the honest answer is to
 * stop and say so rather than to spin.
 */
export const REST_MAX_TURNS = 200;

/** What one rest turn can see. Everything the rule asks about, and nothing else. */
export type RestView = {
  readonly hp: number;
  readonly maxHp: number;
  /** Per game turn. Zero or less is `Bleeding` — upstream's `life_regen <= 0`. */
  readonly hpRegen: number;
  /** The class pool, or null for a body that has none (a fixture, a monster). */
  readonly resource: {
    readonly value: number;
    readonly max: number;
    readonly regenPerTurn: number;
  } | null;
  /**
   * Is any DETRIMENTAL effect still running? Upstream walks `self.tmp` and keeps
   * resting while one is found (Player.lua:1023-1029), which is what makes rest
   * the way you wait out a slow rather than a second thing you have to remember.
   *
   * A boolean rather than the list: the rule only asks whether any exists, and
   * handing the whole table across a purity boundary would drag the effect
   * catalogue into `src/shared/`.
   */
  readonly afflicted: boolean;
  /** Any talent still on cooldown — Player.lua:1041-1049's `wait_cooldowns`. */
  readonly cooling: boolean;
  /**
   * The nearest hostile this body can SEE, or null. Resolved by the caller,
   * because line of sight lives in the engine and this file may not import it.
   */
  readonly threat: { readonly name: string; readonly dx: number; readonly dy: number } | null;
};

export type RestAnswer =
  | { readonly rest: true }
  | { readonly rest: false; readonly stop: RestStop; readonly threat?: RestView['threat'] };

/**
 * Should this body keep resting? Ported from Player.lua:971-1058.
 *
 * THE ORDER IS UPSTREAM'S AND IT IS LOAD-BEARING. A hostile outranks everything,
 * including bleeding: a body that is losing health AND being approached should
 * be told about the thing that is approaching, because that is the fact it can
 * still do something about.
 */
export function restCheck(view: RestView): RestAnswer {
  // :974-981 — spotted hostiles, first and with a bearing.
  if (view.threat !== null) {
    return { rest: false, stop: RestStop.Hostile, threat: view.threat };
  }

  // :1003 — `if self.life_regen <= 0 then return false, "losing health!"`.
  // Checked BEFORE the "is there anything to gain" questions, or a bleeding body
  // at full health would rest forever waiting for a number that only falls.
  if (view.hpRegen <= 0) return { rest: false, stop: RestStop.Bleeding };

  // :1004 — health still to recover, and a regen that can recover it.
  if (view.hp < view.maxHp) return { rest: true };

  // :1011-1020 — a resource below its ceiling with a positive trickle.
  const pool = view.resource;
  if (pool !== null && pool.value < pool.max && pool.regenPerTurn > 0) return { rest: true };

  // :1023-1029 — wait out anything still afflicting the body.
  if (view.afflicted) return { rest: true };

  // :1041-1049 — and anything still on cooldown.
  if (view.cooling) return { rest: true };

  return { rest: false, stop: RestStop.Done };
}

/**
 * REST GETS FASTER THE LONGER IT RUNS — Player.lua:986, `math.min(cnt / 10, 8)`.
 *
 * The whole feel of resting is in this line. A flat rate would make a long rest
 * a long wait; this makes the first few turns ordinary and a settled rest brisk,
 * so a player who genuinely needs eighty turns of healing does not sit through
 * eighty turns of it.
 *
 * MULTIPLIES THE REGEN THAT ALREADY HAPPENED, and it is a BONUS on top of the
 * ordinary per-turn tick rather than a replacement for it — upstream calls
 * `act:heal(...)` in addition to the regen `actBase` already applied.
 *
 * @param turnsRested how many turns this rest has already passed. 0 on the first.
 */
export function restBonus(turnsRested: number): number {
  return Math.min(turnsRested / 10, 8);
}

/**
 * WHAT ONE REST DID — how many turns went by, and why it stopped.
 *
 * HERE AND NOT IN THE ENGINE, because two places name it and neither may import
 * the other: `turn-engine.ts` returns it, and `net/gateway.ts` declares the
 * narrow `TurnEngine` contract the gateway is allowed to see (that contract
 * exists precisely so net/ does not depend on the engine). A type made of a
 * number and a reason is the rule's own vocabulary, so it belongs beside the rule.
 */
export type RestResult = {
  readonly turns: number;
  readonly stop: RestStop;
  /** Present only for `RestStop.Hostile` — what stopped it, and which way. */
  readonly threat?: { readonly name: string; readonly dx: number; readonly dy: number };
};

/** What the player is told. One sentence, and it always says WHY. */
export function restStopText(answer: RestAnswer, turnsRested: number, bearing: string): string {
  const spent =
    turnsRested === 0
      ? 'You do not settle'
      : turnsRested === 1
        ? 'You rest a turn'
        : `You rest ${String(turnsRested)} turns`;
  if (answer.rest) return spent;
  switch (answer.stop) {
    case RestStop.Hostile:
      // Upstream's own sentence shape (Player.lua:980): what, and which way.
      return `${spent} — ${answer.threat?.name ?? 'something'} to the ${bearing}.`;
    case RestStop.Bleeding:
      return `${spent} — you are losing blood faster than you make it.`;
    case RestStop.Budget:
      return `${spent}, and stop there.`;
    case RestStop.Done:
      return turnsRested === 0 ? 'Nothing to rest off.' : `${spent}. Ready.`;
  }
}
