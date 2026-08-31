// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                  WHEN A BODY IS IN TROUBLE — ONE ANSWER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ui/life.ts` states the rule this file exists to keep, and states it as an
 * argument rather than a preference: *"the colour is the party pane's, exactly
 * — GOLD, turning ORANGE under a third. Two health readouts that disagreed
 * about when a body is in trouble would be worse than one."*
 *
 * That rule was written down three times. `HP_LOW = 1 / 3` appeared in
 * `ui/life.ts`, `ui/partypanel.ts` and `ui/turncards.ts`, each with its own
 * copy of the same number — which is precisely the shape `shared/version.ts`
 * says keeps biting this codebase: *"a bound written out twice is the shape
 * this codebase keeps getting bitten by — most recently `HAUNTS`, which learned
 * two tile codes while a duplicate did not."*
 *
 * Nothing had drifted yet. Three copies of a number that must never disagree is
 * a bug that has not happened, and the moment to collapse it is before a fourth
 * surface is added rather than after one of them moves.
 *
 * ═══ IN `shared/` BECAUSE `render/` MAY NOT REACH INTO `ui/` ═══
 * The life bar on a creature token lives in `render/canvas.ts`, which imports
 * only from `shared/` and from its own directory — a layering worth keeping.
 * `src/shared/` is the one module both the widgets and the renderer can name,
 * which is the same reason `DamageType` and `DOOR_CLEARANCE` moved here.
 *
 * ═══ IT IS A FACT ABOUT THE GAME, NOT ABOUT A WIDGET ═══
 * "A third of your life left" is a statement about how much trouble a body is
 * in. Every surface then chooses its own INK for that — the party pane pairs it
 * with GOLD, a dimmed turn card with GREY — because contrast against different
 * backgrounds is a widget's problem. The THRESHOLD is not.
 */

/**
 * Below this fraction of maximum life, every readout in the game says so.
 *
 * ToME steps its own tactical frame at .75/.50/.25 (Actor.lua:947-957). This
 * game answers the same question with one step and a proportional bar, because
 * `ui/life.ts` also reserves CRIMSON for "hostiles are engaged" and a four-band
 * ramp would spend it — and because every surface that carries this also
 * carries DIGITS, except the creature token, whose bar is proportional and says
 * the rest by its height.
 */
export const HP_LOW = 1 / 3;

/**
 * Is this body in trouble?
 *
 * TAKES THE TWO NUMBERS, not a fraction, so no caller can divide by a zero
 * maximum — a body with `maxHp: 0` is a fixture that got away, and answering
 * `NaN <= HP_LOW` is `false`, which would paint a corpse as healthy.
 */
export function isLowLife(hp: number, maxHp: number): boolean {
  return lifeFraction(hp, maxHp) <= HP_LOW;
}

/** How full, clamped to 0..1. The denominator is floored at 1 for the reason above. */
export function lifeFraction(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp)) return 0;
  return Math.min(1, Math.max(0, hp / Math.max(1, maxHp)));
}
