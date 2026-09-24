// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TYPED DOOR INTO THE PROBES' SHOT RULES, FOR ONE TEST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/` is plain `.mjs` and outside the TypeScript build; `grown.d.mts` makes
 * the argument for the exceptions. This one exists for
 * test/tools/fightlib-area.test.ts: `takeShot` decides whether an area talent is
 * worth pressing by counting the bodies it would catch, and that count is a
 * JOIN between the probe and the engine's shapes (`ballTiles`, `crossTiles`).
 * A join is where this repository's bugs live, and it cannot be guarded from
 * inside `tools/`.
 *
 * DECLARATIONS ONLY, AND LOOSE ON PURPOSE — only what the test calls, typed no
 * tighter than the duck-typed objects the probes pass. The point is that the
 * module RESOLVES, not that it is checked.
 *
 * test/tools/fightlib-band.test.ts is the second reader: `reachable` is the
 * probes' copy of the engine's distance band — the join between a probe and
 * the rule it measures — and it is held to `canUseTalent` over every offset.
 */

/** One attack a probe may press, as `classStrikes` builds it. */
export type ProbeAttack = {
  readonly id: string;
  readonly range: number;
  readonly minRange: number;
  /** Ball and Cross only. */
  readonly radius?: number;
  /** Ball and Cross only: `'ball'` or `'cross'`. */
  readonly shape?: string;
};

/** Every attack a class owns that a probe may aim at a foe, longest first. */
export function classStrikes(cls: unknown, known?: ReadonlySet<string>): ProbeAttack[];

/**
 * The nearest foe this attack's band reaches, with its `tileDistance`, or
 * undefined. test/tools/fightlib-band.test.ts holds it to `canUseTalent`.
 */
export function reachable<F extends { readonly x: number; readonly y: number }>(
  attack: Pick<ProbeAttack, 'range' | 'minRange'>,
  self: { readonly x: number; readonly y: number },
  foes: readonly F[],
  ground?: unknown,
): { readonly f: F; readonly d: number } | undefined;

/** Fire the best attack the engine accepts this turn. */
export function takeShot(
  engine: { submitTalent(actorId: string, talentId: string, at: unknown): unknown },
  actorId: string,
  attacks: readonly ProbeAttack[],
  self: { readonly x: number; readonly y: number },
  foes: readonly { readonly x: number; readonly y: number; readonly alive?: boolean }[],
  onRefusal?: (talentId: string, shot: unknown) => void,
  level?: unknown,
): { fired: boolean; gap: number | null };

/** A button the probe presses when hurt: its id, and whether it is `no_energy`. */
export type ProbeHelp = { readonly id: string; readonly free: boolean };

/**
 * What a class may press on itself when hurt. test/tools/fightlib-help.test.ts
 * holds `free` to the talent's own `noEnergy` — the price the engine charges.
 */
export function selfHelp(
  cls: unknown,
  known: ReadonlySet<string> | undefined,
  inscribed: readonly unknown[],
): ProbeHelp[];
