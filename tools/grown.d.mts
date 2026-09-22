// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE TYPED DOOR INTO `tools/`, AND IT EXISTS FOR ONE TEST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/` is plain `.mjs` and deliberately outside the TypeScript build
 * (CLAUDE.md § Layout). Nothing in `test/` has ever reached into it and almost
 * nothing should: a probe asserts nothing, fails nothing, and `npm run check` is
 * the gate.
 *
 * `test/server/probe-body.test.ts` is the exception, and its own header carries
 * the argument. `bearBirthKit` is a second copy of the gateway's
 * `grantBirthKit`, and while the first copy did not exist every delve number
 * this project ever printed was measured on a blind body in five unlit caves.
 * `dressFor` decides which lamp a probe body is holding, which in those same
 * caves is the whole of what it can see. Both are JOINS between two correct
 * layers, which is this repository's recurring failure, and neither can be
 * guarded from inside `tools/`.
 *
 * `test/tools/grown-budget.test.ts` is the second reader, for the same shape of
 * join: `growTo`, `spendPointsTo` and `levelOnTheFloor` spend the purses the
 * server seeds and must refuse what its spend path refuses.
 *
 * DECLARATIONS ONLY, AND LOOSE ON PURPOSE. The probe's bodies are duck-typed
 * plain objects assembled by `World.addPlayer` and by fixtures; giving them a
 * real type here would be a second opinion about what a body is, living in the
 * one directory that is not allowed to have opinions about the game. The point
 * is that the module RESOLVES, not that it is checked.
 */

/** Grow a body to `level` the way the server would have. */
export function growTo<T>(body: T, cls: unknown, level: number): T;

/**
 * Spend the class points a character of `level` holds, down the class loadout,
 * refusing every rank the server's tier gate refuses. `body` is required: the
 * gate reads its level and composed stats, and a point nothing can take is left
 * in its `unspentPoints`. Returns how many points were spent.
 */
export function spendPointsTo(
  sheet: unknown,
  cls: unknown,
  level: number,
  body: unknown,
  registry?: unknown,
): number;

/** One rolled item per slot at this level's band — and the lamp its level allows. */
export function dressFor<T>(body: T, level: number, rng: unknown): T;

/** The loot band this level sees. */
export function bandAt(level: number): number;

/** Put on what `grantBirthKit` gives every new character, and refold the sheet. */
export function bearBirthKit<T>(body: T, effects?: unknown): T;

/** The gateway's `rememberWhatPlayersSee`, for a probe that drives the engine. */
export function rememberWhatProbesSee(world: unknown): void;

/** Spend what a level bought and resize the body — `refreshPassives`' seam. */
export function levelOnTheFloor(
  body: unknown,
  cls: unknown,
  sheet: unknown,
  effects: unknown,
  ctx?: { readonly registry?: unknown; readonly engine?: unknown; readonly world?: unknown },
): void;
