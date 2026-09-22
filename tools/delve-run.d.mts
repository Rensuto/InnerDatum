// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND TYPED DOOR INTO `tools/`, AND IT EXISTS FOR ONE CASE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/` is plain `.mjs` and deliberately outside the TypeScript build
 * (CLAUDE.md § Layout). `tools/grown.d.mts` carries the argument for why a test
 * may ever reach in here at all, and this is the same argument for a different
 * function.
 *
 * `test/server/first-room.test.ts` holds one rule: the room the game NAMES to a
 * four-minute-old character must not kill them for walking in. It used to check
 * that with a crude duel model, and the model's verdict was measured false — it
 * called the Drowned Chapel lethal on a floor a level-1 Watchman clears eighty
 * runs out of eighty. The only instrument that gets that right is the driver in
 * `delve-run.mjs`, which is also the one the balance readings are taken with, so
 * importing it is what stops the test and those readings drifting apart. A
 * second copy of that driver is the thing the probe's own header spends forty
 * lines forbidding.
 *
 * DECLARATIONS ONLY, AND LOOSE ON PURPOSE, for the reason `grown.d.mts` gives:
 * the point is that the module RESOLVES, not that `tools/` grows a second
 * opinion about what a site, a class or a body is.
 */

import type { ClassDef } from '../src/server/content/classes.ts';
import type { DownedState } from '../src/server/engine/downed.ts';
import type { TalentSheet } from '../src/server/engine/talents.ts';
import type { Actor, World } from '../src/server/world/world.ts';

/** What `run` reports back. Only the fields a test may read are named. */
export type ProbeRun = {
  /** `clear` (no foes left), `stall` (the driver could not finish) or `wipe`. */
  readonly outcome: 'clear' | 'stall' | 'wipe';
  /** Hostiles the placer put on the floor, before anything died. */
  readonly roster: number;
  /** Hit points taken off the party over the whole run. */
  readonly damage: number;
  /** Base turns spent, up to `turnCap`. */
  readonly turns: number;
  /** The lowest fraction of its pool any body reached, 0..1. */
  readonly worst: number;
  /** Each body's level at the end, in party order. */
  readonly levelOut: readonly number[];
  /** Each body's experience bar at the end, in party order. */
  readonly xpOut: readonly number[];
  /**
   * Respawns pressed during the run — the deaths `deaths`/`downCount` cannot
   * see, because a respawned body is standing again by the end.
   */
  readonly respawned: number;
  /**
   * What the turns were spent on, one count per verb (`shot`, `bumped`,
   * `moved`, `held`, `closed`, `revived`, `respawned`, ...). A verb the run
   * never used may be absent rather than zero.
   */
  readonly orders: Readonly<Record<string, number>>;
};

/**
 * What `opts.stage` is handed: the floor, the survival table and each body as
 * the driver holds it. THE SERVER'S OWN TYPES, imported rather than restated —
 * a test arranging a room reaches the real objects, and a shape written out
 * here would be the second opinion the note above refuses.
 */
export type ProbeStage = {
  readonly world: World;
  readonly downed: DownedState;
  readonly members: readonly {
    readonly body: Actor;
    readonly cls: ClassDef;
    readonly sheet: TalentSheet;
  }[];
};

/** One party, one floor of one site, one seed — the driver every probe shares. */
export function run(
  site: unknown,
  size: number,
  seed: string,
  opts?: {
    party?: readonly unknown[];
    level?: number;
    floor?: number;
    xp?: number;
    turnCap?: number;
    lantern?: boolean;
    equipped?: unknown;
    strength?: { level: number; size: number };
    /** Arrange the room before the first turn. Tests only; see the call in delve-run.mjs. */
    stage?: (scene: ProbeStage) => void;
  },
): ProbeRun;
