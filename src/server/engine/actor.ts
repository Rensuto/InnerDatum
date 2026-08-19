// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:139-150, 476-609, 1353-1360, 3948-3953
//             t-engine4 game/engines/default/engine/Actor.lua:41-61, 469-485
//             t-engine4 game/engines/default/engine/interface/ActorTalents.lua:1002-1013
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * The actor, as the TURN ENGINE sees it: identity, position, the two energy
 * clocks, vitals, cooldowns, and the control state the barrier reads.
 *
 * There is exactly ONE actor type in the process. `world.ts` re-exports the
 * union below as `Actor` and its table holds these objects directly, so the
 * engine, the world and the projector are all looking at the same bytes. A
 * second "engine view" of an actor would need syncing, and the first thing to
 * fall out of sync would be `hp`.
 *
 * ===========================================================================
 * THE PLAYER / MONSTER ASYMMETRY IS ENFORCED BY THE TYPE, NOT BY DISCIPLINE
 * ===========================================================================
 *
 * DECISIONS.md § D1, restated: a PLAYER action always costs exactly
 * ENERGY_TO_ACT and a player's `globalSpeed` is pinned to 1.0. AP is an
 * intra-turn budget spent inside one park; it is never a way to buy an extra
 * park. That is the single property that keeps a party PHASE-LOCKED, which is
 * what makes the barrier park ONCE PER TURN AT FULL QUORUM — the one condition
 * the Bell was designed around. MONSTERS keep ToME's full variable-speed model
 * on both sides: `globalSpeed` scales what they gain, `speedFactor` scales what
 * an action costs them.
 *
 * Simulate the alternative once and the reason for the pin is obvious: four
 * players spending 2 AP / 6 AP / a move / 4 AP land on 667 / 0 / 0 / 333 energy
 * and never re-align. The scheduler then parks six times over the next ten
 * ticks with quorum sizes 1, 2, 3, 2, 1, 3, and the solo-Bell exemption — which
 * exists for the last survivor — fires on the single-player parks while three
 * people sit frozen watching one person think.
 *
 * So `PlayerActor` declares `globalSpeed` and `speedFactor` as the LITERAL type
 * `1`, readonly. `player.speedFactor = 1.4` is a compile error, not a code
 * review note. Every energy spend goes through `spendTurn`, which derives the
 * multiplier from the actor's own kind, so there is no call site left where a
 * caller could pass the wrong one.
 *
 * ===========================================================================
 * THE TWO CLOCKS (src/shared/energy.ts owns the loop; this file owns actBase)
 * ===========================================================================
 *
 * `energy` is the ACT clock and is speed-dependent. `energyBase` is the BASE
 * clock, accrues a flat ENERGY_PER_TICK, and therefore fires exactly once per
 * game turn at any speed. `actBase` below is what fires on it: cooldowns,
 * regeneration and (from M4) status durations. Nothing in `actBase` may consult
 * `globalSpeed` or `speedFactor` — haste grants more ACTIONS and must never
 * shorten a cooldown or a debuff.
 *
 * SYNCHRONOUS AND DETERMINISTIC. src/server/engine/** carries the six anti-async
 * AST selectors plus the ban on `Date.now`/`Math.random`. Nothing here reads a
 * clock or an entropy source; damage rolls take an `Rng` from the caller.
 */

import { createEnergyActor } from '../../shared/energy.ts';
import { spendForAction } from '../../shared/energy.ts';
import { ActorKind, ActorRank } from '../../shared/protocol.ts';
import type { EnergyActor } from '../../shared/energy.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
// TYPE-ONLY, AND THAT IS LOAD-BEARING. `engine/combat.ts` imports
// `world/world.ts`, which imports this file. A value import would close that
// loop at runtime; an `import type` is erased entirely (verbatimModuleSyntax
// plus the separate-type-imports lint rule), so the module graph is unchanged
// and only the compiler ever sees the reference.
import type { CombatSheet } from './combat.ts';
// TYPE-ONLY, and for the same reason as the line above. `Slot` is a content
// type; a VALUE import of it would put a runtime edge from the engine into
// content/, and content/classes.ts already imports engine/combat.ts. An
// `import type` is erased entirely, so the module graph is unchanged.
import type { Slot } from '../content/items.ts';

// ---------------------------------------------------------------------------
// Intents — what an actor has decided to do with its turn
// ---------------------------------------------------------------------------

/**
 * The verb set. Object + union rather than an `enum`, because
 * `erasableSyntaxOnly` is on and Node type-strips this file to run it.
 *
 * M3 added `Talent`, which is the one member the M2 header predicted, and
 * nothing else about this union changed.
 */
export const IntentKind = {
  Move: 'move',
  Attack: 'attack',
  /** Brace in place. What the Bell forces on a straggler, and never anything else. */
  Hold: 'hold',
  /** Use a talent, optionally aimed at a tile. M3. */
  Talent: 'talent',
  /**
   * Pick up a Downed ally. M4 — game-design.md § 9, engine/downed.ts.
   *
   * The one verb that names an ACTOR rather than a tile or a direction, and the
   * exception is the point: you are not aiming at a square, you are reaching for
   * a specific person who is lying on the floor with a countdown over their
   * head. A tile would resolve to "whoever is prone there", and the answer to
   * that between the click and the tick is exactly the wrong kind of surprise.
   */
  Revive: 'revive',
} as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];

/**
 * A submitted decision, not a resolved one.
 *
 * LEGALITY IS CHECKED AT RESOLUTION, NOT HERE (docs/architecture.md § 2). An
 * intent that goes illegal between submission and resolution — the target died,
 * you were knocked out of range — costs ZERO energy, clears, and re-prompts.
 * That refund rule is what removes hesitation, and it only falls out for free
 * as long as this type stays a plain description of a wish.
 */
export type Intent =
  | { readonly kind: typeof IntentKind.Move; readonly dir: Dir }
  | { readonly kind: typeof IntentKind.Attack; readonly targetId: string }
  | { readonly kind: typeof IntentKind.Hold }
  /**
   * A TILE, never an actor id, even when a talent is obviously aimed at a
   * monster. The tile is what the player clicked and it is what an AoE needs;
   * which body is standing on it at RESOLUTION is a question that must be asked
   * then, not now. Storing a target id here would resurrect the bug the refund
   * rule exists to remove — a talent that follows its victim across the room
   * because the victim moved between the click and the tick.
   *
   * `target` is absent for a `self` shape.
   */
  | {
      readonly kind: typeof IntentKind.Talent;
      readonly talentId: string;
      readonly target?: TileXY;
    }
  /**
   * Reach a Downed ally and put them back on their feet (game-design.md § 9).
   *
   * BY ID, not by tile — see `IntentKind.Revive`. Legality (are they actually
   * down, are you actually adjacent, are you yourself still standing) is decided
   * at RESOLUTION like everything else, so a rescue that somebody else got to
   * first costs zero and re-prompts. That refund is what makes the button safe
   * to press in the one moment a player must not hesitate.
   */
  | { readonly kind: typeof IntentKind.Revive; readonly targetId: string };

/**
 * The one shared hold. Frozen and reused because the Bell installs it on every
 * expiry and Standing By installs it every turn; allocating a fresh empty
 * object each time would be pure noise in the hottest path in the engine.
 */
export const HOLD_INTENT: Intent = Object.freeze({ kind: IntentKind.Hold });

/**
 * A standing order supplies an action every time its owner would park, so a
 * player with one NEVER BLOCKS — ported in spirit from Player.lua:401-406,
 * which runs rest/run steps until energy is exhausted and only then pauses.
 *
 * M2 ships `hold` alone, and that is deliberate rather than a stub: `hold` is
 * the one order the engine can already satisfy with no pathing, no explored-map
 * memory and no interrupt rules. `travel` / `explore` / `rest` / `follow` join
 * it once those exist; the barrier clause that reads this field
 * (`standingOrder === null`) does not change when they do.
 */
export const StandingOrder = {
  Hold: 'hold',
} as const;
export type StandingOrder = (typeof StandingOrder)[keyof typeof StandingOrder];

// ---------------------------------------------------------------------------
// AI profiles — the data half; the behaviour lives in src/server/ai/npc.ts
// ---------------------------------------------------------------------------

/**
 * Which behaviour drives a monster. Declared HERE rather than in ai/npc.ts so
 * the dependency runs one way only (`ai → engine/actor`, never back), and so a
 * monster loaded from content JSON at M4 can name its profile without pulling
 * the AI into the loader.
 */
export const AiProfile = {
  /** A* toward the nearest visible player; bump-attack on contact. */
  MeleeChaser: 'melee_chaser',
  /** Approach to its stand-off range, shoot, and back off if crowded. */
  RangedKiter: 'ranged_kiter',
} as const;
export type AiProfile = (typeof AiProfile)[keyof typeof AiProfile];

/** Per-monster AI state and tuning. Content-authored from M4; defaulted here. */
export type MonsterAi = {
  readonly profile: AiProfile;
  /**
   * Who this monster is chasing, remembered across turns.
   *
   * Kept rather than recomputed every turn because ToME keeps its target 90% of
   * the time (ai/simple.lua:253) — that hysteresis is what stops a monster
   * standing between two players and oscillating instead of committing.
   */
  targetId: string | null;
  /** How far it notices a player, in chebyshev tiles. Line of sight is also required. */
  aggroRange: number;
  /** Stand-off distance. A melee profile leaves this at 1. */
  preferredRange: number;
  /**
   * Closer than this and a kiter retreats. 0 disables backing off.
   *
   * MUST EQUAL `combat.minRange` on the same actor. This one makes the AI give
   * ground; that one makes `canAttack` refuse the shot. Two dead zones that
   * disagree produce a monster that walks to a tile it then refuses to fire
   * from, every turn, forever. `validateTemplate` in content/monsters.ts proves
   * the pair for every authored creature.
   */
  minRange: number;

  // --- ELITE BEHAVIOUR ------------------------------------------------------
  // Two flags rather than a `rank === elite` test, because rank is what the
  // player SEES (it picks the token ring) and these are what the monster DOES.
  // Keeping them separable means a future creature can flank without wearing an
  // elite ring, or wear one for a reason of its own.

  /**
   * Hunt the most ISOLATED hostile instead of the nearest.
   *
   * The behaviour half of "close ranks": an elite walks past the front line to
   * reach whoever wandered off. ToME has no equivalent — its targeting is
   * strictly nearest-first (ai/simple.lua:259-267) — so this is authored for
   * this game, where the party is four humans in a voice channel and the whole
   * design is trying to produce "get over here".
   */
  readonly huntsIsolated: boolean;
  /**
   * Consecutive blocked turns before re-routing AROUND its own kin. 0 = never.
   *
   * ToME's `move_complex` escalation (ai/simple.lua:199-247): count the turns a
   * monster spent unable to advance and, past a threshold, re-run A* with an
   * actor-aware predicate so it stops stacking up in a chokepoint. Upstream's
   * threshold is 5 (simple.lua:225).
   */
  readonly shoulderAfter: number;
  /**
   * Turns spent unable to advance — ToME's `ai_state.blocked_turns`
   * (simple.lua:224-227). Reset to 0 by any successful move or attack.
   */
  blockedTurns: number;
  /**
   * Turns of the shoulder manoeuvre still to run, or NEGATIVE while it is on
   * cooldown after one failed.
   *
   * ToME splits the same state across two places — it swaps `ai_state.ai_move`
   * to `move_blocked_astar` (simple.lua:226-227) and lets THAT ai count
   * `blocked_turns` down and swap back at zero (:155-161) — because the mode has
   * to OUTLIVE the turn that armed it. An escalation lasting a single turn walks
   * the elite one tile sideways and straight back into the queue it just left,
   * which is the first thing that happened when this was written without it.
   *
   * The negative half is simple.lua:176's `blocked_turns = -5`: a failed
   * escalation must not be retried every turn for the rest of the fight.
   */
  shoulderTurns: number;
};

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/** Everything both kinds carry. The discriminant and the speed fields are not here. */
type ActorCommon = {
  /** Stable identity. Never reused, never reassigned. */
  readonly id: string;
  name: string;
  /** An asset key, never a path — the client owns the manifest. */
  sprite: string;
  /**
   * Danger CATEGORY, projected straight onto the wire so the client can pick an
   * under-token ring. ToME keys `boss_rank_circles` off the same field for the
   * same reason (Actor.lua:1198-1204). `normal` for every player.
   */
  rank: ActorRank;
  x: number;
  y: number;

  // --- the two clocks (structurally an EnergyActor) -------------------------
  /** THE ACT CLOCK. Speed-dependent. At >= ENERGY_TO_ACT the actor may act. */
  energy: number;
  /** THE BASE CLOCK. Flat ENERGY_PER_TICK per tick, never multiplied. */
  energyBase: number;
  /** Per-actor gain multiplier (GameEnergyBased.lua:125). 1 for everything in M2. */
  energyMod: number;
  /** Set by `spendForAction`; the loop uses it to tell a real action from a free one. */
  energyUsed: boolean;

  // --- vitals ---------------------------------------------------------------
  hp: number;
  maxHp: number;
  /** Restored per GAME TURN on the base clock (Actor.lua:525 `regenLife`). */
  hpRegen: number;
  /**
   * False once hp reaches 0. THE BODY IS NOT REMOVED: it stops being ticked
   * (`isActive`) and stops blocking movement, but it stays in the actor table
   * so the log, the death events and — for a player — the reconnect path all
   * still have something to point at.
   */
  alive: boolean;

  // --- combat ---------------------------------------------------------------
  /**
   * CHEBYSHEV reach — what the scheduler's legality check and the AI's chase
   * band read. 1 is melee, and 1 is the Moore neighbourhood, which is what makes
   * bump-attack work on the diagonals.
   *
   * Its Euclidean twin is `combat.range`, which is what `canAttack` refuses on.
   * A melee creature therefore carries `attackRange: 1` AND `combat.range: 1.5`
   * — see the two-metrics note in content/monsters.ts.
   */
  attackRange: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PROJECTILE PATH'S FROZEN DAMAGE. THE MELEE PATH NO LONGER READS THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * They were the M2 bump-damage placeholder. `scheduler.ts#strike` now resolves
   * through `combat.ts#attackTarget` and reads the `combat` sheet below, so the
   * ONLY surviving reader of these two fields is `scheduler.ts#fire`: the roll
   * that is taken at the muzzle and FROZEN onto the orb (`ActorProject.lua:353`
   * stores exactly that fixed number in `project.def.dam`).
   *
   * They were NOT deleted along with the melee use, and that is deliberate. The
   * alternative was to have `fire` compute `rollDamageRange(combatDamage(sheet),
   * …)`, which loses twice: it sources the orb's damage from the creature's
   * MELEE weapon block (the wraith's orb is T_VOID_BLAST, misc/npcs.lua:739 — the
   * `self:projectile(tg, x, y, DamageType.VOID_BLAST, …)` line; :735 is the bare
   * `action = function(self, t)` header and carries no damage expression, which
   * is what content/monsters.ts corrects it to in five places — not
   * losgoroth.lua:30's `combat`), and for the wraith it collapses to a flat 5 —
   * `damage.ts:276` takes NO draw when the truncated endpoints agree, which
   * deletes a draw from the middle of every wraith's turn and shifts every
   * replay after it. Keeping them template-authored keeps EXACTLY ONE labelled
   * `combat.bump.damage` draw at EXACTLY the stream position it has always
   * occupied, which is the property scheduler.ts#fire insists on.
   *
   * So: two fields that used to mean "placeholder melee damage" now mean "orb
   * damage, authored per template". They are the tuning lever for a ranged
   * creature and they belong in content/monsters.ts.
   */
  damageMin: number;
  /** As above: the PROJECTILE path's frozen damage, authored per template. */
  damageMax: number;
  /**
   * THE REAL SHEET: stats, mods, weapon, resistances, reach and dead zone.
   *
   * Optional because the M2 test fixtures and `createPlayerActor` do not have
   * one yet — a sheet-less actor falls through to ToME's own defaults inside
   * `derived.ts` (base 10 primaries, everything else 0), which is exactly the
   * hand-traceable level-1 actor test/server/derived.test.ts pins. Content
   * templates (content/monsters.ts) always supply one.
   */
  combat?: CombatSheet;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SHEET BEFORE GEAR AND BEFORE STATUSES. THE THING `combat` IS DERIVED
   * FROM, AND THE ONLY ONE OF THE PAIR ANYTHING MAY WRITE DIRECTLY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `combat` above is now a DERIVED value, recomposed by
   * `engine/effects.ts#recomposeCombat` in a fixed order:
   *
   *     baseCombat  ->  composeSheet(worn gear)  ->  recomputeAttributes(flags)
   *
   * This field is stage zero: the class's own sheet exactly as
   * content/classes.ts authored it (or a monster template's, or
   * `DEFAULT_PLAYER_COMBAT`), never written to by the equipment or status
   * systems and therefore always safe to recompose from. That is what makes
   * "take the coat off" exact — it is not a subtraction, it is the same fold
   * re-run over a smaller set.
   *
   * OPTIONAL, for the same reason `combat` is: an M2-era fixture has neither,
   * and a body with no `baseCombat` recomposes from whatever `combat` holds,
   * which is the pre-equipment behaviour unchanged.
   */
  baseCombat?: CombatSheet;

  // --- items ----------------------------------------------------------------
  /**
   * WHAT IS BEING WORN: slot -> item id, at most one per slot.
   *
   * IDS, NOT ITEMS. The catalogue is content (content/items.ts) and this is the
   * engine's actor; storing the resolved object here would put a content table
   * inside every save file and inside every actor the projector walks. An id is
   * also the only thing a save can honestly hold across a build that renamed a
   * stat — `wornOf` drops an id it cannot resolve rather than refusing to load
   * the character.
   *
   * ═══ ON THE ACTOR, NOT IN A SIDE TABLE, AND THE ARGUMENT IS ALREADY WRITTEN ═══
   * See `PlayerActor.level` below: `snapshotPlayers` (persist/saves.ts) RUNS IN A
   * LAYER THAT CANNOT REACH THE TALENT ENGINE, so anything the save file must
   * write down has to be reachable from the actor. An inventory kept in an
   * equipment-engine side table would be an inventory that survives exactly
   * until somebody closes the tab. `classId`, `level`, `xp` and `unspentPoints`
   * are all here for that reason and these two join them.
   */
  equipped?: Partial<Record<Slot, string>>;
  /**
   * THE BACKPACK: item ids held and not worn, in pickup order.
   *
   * ToME's `INVEN_INVEN` (descriptors.lua:56's `INVEN = 1000`), minus the cap —
   * a 1000-slot limit is a limit nobody in a four-hour session will ever meet,
   * and a cap that never binds is a rule that only exists to be got wrong.
   *
   * `readonly` array: it is REPLACED on every change rather than spliced, which
   * is the same discipline `combat` follows and for the same reason — a live
   * reference that somebody mutated is how two players end up sharing a coat.
   */
  carried?: readonly string[];

  // --- preferences ----------------------------------------------------------
  /**
   * WHICH KEYS THIS PLAYER HAS REBOUND: action id -> key strings, in slot order.
   *
   * ═══ INERT DATA. NO ENGINE RULE READS IT, AND NONE EVER MAY ═══
   * This is the only field on an actor that the WORLD has no opinion about. It
   * decides nothing, it is never branched on, it costs no energy and it takes no
   * RNG draw — a keymap is a fact about a person's keyboard, not about a body on
   * a floor. `tickLevel`, `actBase`, the barrier, the scheduler and every talent
   * are all unchanged by its presence, which is exactly what keeps replay from a
   * seed deterministic: two runs whose only difference is a rebind must produce
   * byte-identical worlds. Anything in engine/ that ever reads this is a bug.
   *
   * ═══ SO WHY IS IT ON THE ACTOR AT ALL? THE `carried`/`equipped` ARGUMENT ═══
   * Verbatim the one those two fields make immediately above, and the one
   * `PlayerActor.classId` and `level` make below: `snapshotPlayers`
   * (net/gateway.ts) RUNS IN A LAYER THAT CANNOT REACH ANYTHING BUT THE ACTOR
   * TABLE, so anything the save file must write down has to be readable from the
   * body. A keymap kept in a side table beside the sockets would be a keymap
   * that survives exactly until somebody closes the tab — which is the one
   * failure the whole feature exists to prevent ("no one likes to reconfigure
   * keybinds").
   *
   * IT ALSO HAS TO LIVE HERE RATHER THAN ON THE SESSION FOR A SECOND REASON. Two
   * browser tabs are ONE player: the second resolves to the same actor id,
   * claims the same body, and the older socket is hung up on with close code
   * 4001. There is exactly one body, therefore exactly one map, therefore no
   * last-writer-wins between windows. Cached on a `Session` it would be one file
   * with two writers.
   *
   * ABSENT IS NOT EMPTY, and the two must never be collapsed. `undefined` is
   * "this player has never opened the Keys screen"; `{}` is "they pressed RESET
   * ALL". The save layer reads them completely differently — an absence leaves
   * the disk exactly as it found it, an empty object overwrites a returning
   * player's binds with nothing.
   *
   * A PLAIN `string` KEY, never a union of the authored action ids. The action
   * table is CLIENT content (src/client/input/keys.ts) and the server may not
   * import it, so an id this build no longer binds is carried verbatim and the
   * client drops what it cannot bind — the same soft-reference treatment
   * `classId` documents below.
   *
   * `readonly` values, REPLACED wholesale on every change rather than mutated,
   * which is the same discipline `carried` follows and for the same reason.
   */
  keybinds?: Readonly<Record<string, readonly string[]>>;

  /**
   * HOW BIG THIS PLAYER WANTS THEIR TILES — the integer zoom step, or absent.
   *
   * ON THE BODY FOR `keybinds`' REASONS, both of them: `snapshotPlayers` runs in
   * a layer that can reach nothing but the actor table, so anything the save file
   * must write down has to be readable from the body — and two browser tabs are
   * one player resolving to one actor, so one body means one setting means no
   * last-writer-wins between windows.
   *
   * ABSENT IS NOT ZERO. `undefined` is "never touched it"; `0` is "deliberately
   * back to the default". They persist identically today and the distinction
   * costs nothing to keep, which is the same care `keybinds` takes over `{}`.
   *
   * ANYTHING IN engine/ THAT READS THIS IS A BUG. It is a display preference and
   * the simulation must stay byte-identical without it.
   */
  zoom?: number;

  // --- talents --------------------------------------------------------------
  /**
   * Talent id -> GAME TURNS remaining. Ticked by `actBase`, so it is immune to
   * haste by construction (ActorTalents.lua:1002-1013).
   */
  readonly cooldowns: Map<string, number>;

  // --- control --------------------------------------------------------------
  /**
   * One pending intent per actor; a second submission REPLACES the first (you
   * changed your mind). Cleared at resolution, whether or not it was legal.
   */
  pendingIntent: Intent | null;
  /** A player with an order never blocks; the order supplies the action instead. */
  standingOrder: StandingOrder | null;
  /**
   * Is a socket currently driving this body? A disconnect sets this false and
   * LEAVES THE BODY IN THE WORLD — it is a MUD, you do not yank someone out of
   * a fight (game-design.md § 4, edge cases).
   */
  connected: boolean;
  /**
   * Excluded from quorum and auto-holding every turn with no Bell delay.
   *
   * SINGLE WRITER: src/server/engine/barrier.ts. It is stored on the actor
   * because `isBlocking` must be a cheap side-effect-free predicate over one
   * actor, but the policy that sets it — two consecutive auto-passes, or a
   * disconnect — belongs to the barrier and lives nowhere else.
   */
  standingBy: boolean;
};

/**
 * A human's body.
 *
 * `globalSpeed` and `speedFactor` are the LITERAL type `1` and readonly, so D1
 * is a compile error to violate rather than a convention to remember. If a
 * player-side haste effect ever lands, it grants AP — see the file header.
 */
export type PlayerActor = ActorCommon & {
  readonly kind: typeof ActorKind.Player;
  /** Pinned. Energy GAIN multiplier; see the header for why it is not free. */
  readonly globalSpeed: 1;
  /** Pinned. Action COST multiplier; every player action costs exactly one turn. */
  readonly speedFactor: 1;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY TIMES THIS BODY HAS ACTED INSIDE THE ROUND IT IS STILL IN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `DECISIONS.md` D1: *"Intra-turn budget: 6 AP / 3 MP, spendable across
   * several talents in one park"*. Zero means the round has not started; above
   * zero means the player is MID-ROUND — parked, holding budget, and owed
   * another decision.
   *
   * PLAYER-ONLY, which keeps `BarrierActor` (a structural subset) untouched and
   * therefore keeps `engine/barrier.ts` out of this change entirely.
   */
  roundActions: number;
  /**
   * WHEN THIS ROUND CLOSES ITSELF. Wall clock, absolute; null when no round is
   * open.
   *
   * WALL CLOCK AND NOT GAME TURNS, and the reason is the same one that nearly
   * broke the townsfolk dialogue: `shared/energy.ts` advances `gameTurn` only
   * while something can gain energy, so a table sitting mid-round thinking is by
   * definition not advancing it. A game-turn deadline would never arrive.
   */
  roundTailMs: number | null;
  /**
   * WHICH CLASS THIS BODY IS, AS A LABEL. Absent for a classless body.
   *
   * ═══ SOFT ON PURPOSE — A PLAIN STRING, NOT `ClassId` ═══
   * The AUTHORITATIVE record of what a class can DO is the `TalentSheet` held by
   * `engine/talents.ts`, keyed by actor id: the loadout, the resource pool, the
   * AP/MP budget and every rule that reads them. This field decides nothing and
   * must never be branched on for a rule. It exists for exactly one reason:
   * `snapshotPlayers` (persist/saves.ts:239-244, which persists "name + class +
   * position") runs in a layer that cannot reach the talent engine, and a save
   * that cannot name the class restores a Watchman as a classless body with the
   * Watchman's 72 hp clamped back to 60.
   *
   * A plain `string` rather than the enum for the same reason the save file uses
   * one: a save written by an older build may name a class this build no longer
   * has, and a load path that cannot represent that is a load path that throws
   * on somebody's character.
   */
  classId?: string;

  // --- progression ----------------------------------------------------------
  /**
   * CHARACTER LEVEL, 1..`MAX_CHARACTER_LEVEL`. Starts at 1.
   *
   * ═══ WHY THE FOUR PROGRESSION FIELDS ARE HERE AND NOT ON THE TalentSheet ═══
   * The same argument `classId` above makes, and it is the same layer that
   * forces it: `snapshotPlayers` (persist/saves.ts, which persists "name + class
   * + position") RUNS IN A LAYER THAT CANNOT REACH THE TALENT ENGINE. Anything
   * the save file must write down therefore has to be reachable from the actor,
   * and a save that cannot name a level restores a level-8 detective as a
   * level-1 one with eleven points quietly deleted.
   *
   * SO THE SPLIT IS STATED ONCE, IN BOTH FILES, AND NEITHER CLAIMS THE OTHER'S
   * AUTHORITY (engine/talents.ts:892-912 is the other half, written verbatim to
   * match):
   *
   *     THE ACTOR owns `level`, `xp`, `unspentPoints`, `pendingLevels`.
   *     THE SHEET owns `points` — the per-talent map, 1..5, which is THE TRUTH
   *                about what a talent does and the only thing persisted raw.
   *
   * Put `level` on the sheet as well and there are two fields called level, one
   * of which is the one that got saved.
   *
   * NOTHING HERE IS BRANCHED ON FOR A COMBAT RULE. `getTalentLevel` reads the
   * SHEET, never this; a character level does not scale a talent by itself, it
   * buys the point that does. That indirection is what lets `level` change
   * mid-pump (see `pendingLevels`) without moving a single RNG draw.
   */
  level: number;
  /**
   * PER-LEVEL experience, never a cumulative total.
   *
   * `gainExp` (src/shared/progression.ts) SUBTRACTS the threshold on the way
   * past — ActorLevel.lua:104 — so this is always "progress into the current
   * level" and the panel's bar is `xp / expChart(level + 1)` with no bookkeeping
   * anywhere. A cumulative implementation type-checks, passes a one-level test,
   * and then levels a character on every kill once they are past the total.
   */
  xp: number;
  /**
   * Talent points earned and not yet spent. Spending is the panel's job.
   *
   * A STORED NUMBER RATHER THAN `totalPointsAtLevel(level) - sum(points)`
   * BECAUSE THE ENGINE CANNOT SEE THE SHEET — that sum lives in the talent
   * engine and this file may not import it (the cycle `talents.ts` -> `actor.ts`
   * is one-way). It is therefore a CACHE of a derived quantity, and the load
   * path is what must reconcile it: docs/data-schemas.md § 1's "NEVER persist a
   * derived value" is why the save stores raw per-talent points and recomputes
   * this from `totalPointsAtLevel` rather than trusting whatever was written.
   */
  unspentPoints: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * GOLD. A WHOLE NUMBER, NEVER NEGATIVE, AND NOT A DERIVED VALUE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Actor.lua:260` (`money = 0`) with the birth grant from
   * `descriptors.lua:74` — a character starts with `STARTING_MONEY`.
   *
   * ON THE BODY, for the same reason `level`, `xp` and `carried` are: the save
   * layer cannot reach the engine, so anything a file must write down has to be
   * readable straight off the actor.
   *
   * UNLIKE `unspentPoints` THIS IS A SOURCE OF TRUTH, not a cache — there is no
   * ledger to recompute it from, so the file's number is the number. That makes
   * `parseMoney`'s repair the only thing standing between a hand-edited save and
   * a negative purse, which is why it clamps rather than rejects.
   *
   * WHOLE GOLD, NEVER FRACTIONAL. ToME rounds prices to 0.01 and carries a
   * float; we floor and carry an integer, on the same argument that keeps ego
   * magnitudes integral — a currency that can hold 0.30000000000000004 will
   * eventually show it to somebody.
   */
  money: number;
  /**
   * LEVELS CROSSED THIS PUMP WHOSE POINTS HAVE NOT BEEN HANDED OUT YET.
   *
   * ═══ THE REPLAY-DIVERGENCE SPLIT, IN ONE FIELD ═══
   * The award happens the instant something dies, in the middle of a pump. `xp`
   * and `level` may move there safely — neither is read by any dice roll. A
   * TALENT POINT is different: it can be spent, spending raises a talent's raw
   * level, and `combatTalentScale` turns that into damage. A point that appeared
   * between the first and the third blow of one AoE would let the scaling change
   * inside a single frozen-snapshot pump, which moves the labelled draw stream
   * and breaks replay-from-seed (CLAUDE.md § 3).
   *
   * So the points WAIT here and are handed out on the BASE CLOCK, in the
   * scheduler's own once-per-game-turn-per-actor pass beside `actBase`. Zero for
   * the overwhelming majority of the game's life.
   */
  pendingLevels: number;
};

/** Everything the world drives. Full ToME speed model, both directions. */
export type MonsterActor = ActorCommon & {
  readonly kind: typeof ActorKind.Monster;
  /** Energy GAIN multiplier. 1.4 means it acts 14 times per 10 game turns. */
  globalSpeed: number;
  /** Action COST multiplier (Actor.lua:5863). 0.5 is a half-turn action. */
  speedFactor: number;
  /**
   * How fast this creature's ranged attack TRAVELS, in TILES PER GAME TURN.
   *
   * `t.proj_speed` — ActorTalents.lua:987-991, and read the guard rather than
   * the value: `if not t.proj_speed then return nil end`. ABSENT MEANS
   * INSTANTANEOUS, which is exactly what every attack in this game does today,
   * so a monster without this field behaves identically to one from before the
   * field existed. Upstream's tooltip spells the two cases out at
   * tome/class/Actor.lua:6272-6274 — "Travel Speed: N% of base" against
   * "Travel Speed: instantaneous".
   *
   * SAME MULTIPLIER AS `energyMod`, DIFFERENT UNIT BY CONVENTION: `energyMod` 6
   * is six actions per turn, `projSpeed` 6 is six tiles per turn, because a
   * projectile spends one action's worth of energy per tile it crosses
   * (Projectile.lua:142, :168-172).
   */
  projSpeed?: number;
  /**
   * `ai_state.talent_in` — a 1-IN-N CHANCE PER TURN of using an attack talent,
   * NOT a cadence of one use every N turns (talented.lua:122,
   * `rng.chance(self.ai_state.talent_in or 6)`).
   *
   * ABSENT means every turn, which is both the current behaviour and what
   * upstream's own `talent_in = 1` means. Read by `ai/npc.ts#kite` and by
   * nothing else.
   */
  talentIn?: number;
  /** What a landed blow from this creature also inflicts. See `OnHitStatus`. */
  readonly onHit?: OnHitStatus;
  /** Which side. `Redacted` for the whole bestiary; see `Faction`. */
  readonly faction: Faction;
  readonly ai: MonsterAi;
};

/**
 * The one actor type. Discriminated on `kind`, so narrowing to a player is what
 * unlocks the player-only fields and narrowing to a monster is what unlocks
 * `ai` — you cannot reach either by accident.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STATUS A CREATURE'S LANDED BLOW TRIES TO INFLICT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's melee riders are per-creature data, not per-attack code — a ghoul's
 * paralysis and a bone giant's stun are `on_melee_hit`-shaped rows on the NPC
 * definition, and the swing itself is the same swing everything else makes.
 * This is the same idea in this codebase's vocabulary: `strike` stays one
 * function, and what a particular creature ADDS to a hit is authored beside its
 * hit points.
 *
 * ═══ `power` IS THE APPLY POWER, AND ITS ABSENCE MEANS SOMETHING ═══
 * Present → the victim rolls the effect's typed save, and a save that bites
 * SHORTENS the duration rather than erasing it (Actor.lua:7004-7014). Absent →
 * no save, no draw, full duration, every time (Actor.lua:6999). The second is a
 * real design choice for a rider you want unconditional, and it is deliberately
 * spelled as an absence rather than as `power: 0`, because zero is a number the
 * save maths would happily use.
 *
 * ═══ IT ONLY FIRES ON A LANDED HIT ═══
 * A miss inflicts nothing. This is checked at the one site that applies it
 * (`strike`) rather than promised here, because "the swing connected" is a fact
 * that site owns and this row has no way to know.
 */
export type OnHitStatus = {
  /** Namespaced — `effect:<id>`, from content/effects.ts. */
  readonly effectId: string;
  /** GAME TURNS asked for, before any save scales it down. */
  readonly turns: number;
  /** Apply power for the typed save. ABSENT MEANS NO SAVE — see above. */
  readonly power?: number;
  /** Magnitude: Bleeding's damage per turn, Slowed's fraction. */
  readonly magnitude?: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH SIDE A BODY IS ON — because "which KIND" was never the same question.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hostility in this game has always been `a.kind !== b.kind`: players fight
 * monsters, monsters fight players, and nothing else exists. That is exactly
 * right for a bestiary and it has no way to express a shopkeeper.
 *
 * A THIRD `ActorKind` WAS THE OTHER OPTION AND IS NOT TAKEN. `ActorKind` is
 * switched exhaustively across the client renderer, the projector and the
 * scheduler, and `protocol.ts` notes that adding a member deliberately breaks
 * every one of those at lint time. That is a good property when a new kind
 * genuinely needs every site to decide something — and a townsfolk does not.
 * She is a body on a tile with hit points and a sprite, drawn by the same
 * painter, seen by the same FOV, inspected by the same panel. The ONLY thing
 * about her that differs is who may hit her. So the answer is a field on the
 * body, not a new category of body.
 *
 * `Redacted` is the default and the name is the fiction's: everything hostile
 * in this game is something the Index has been editing.
 */
export const Faction = {
  /** The Index's work. Every monster in the roster today. */
  Redacted: 'redacted',
  /** Alderbrook's living. Cannot be attacked and never attacks. */
  Townsfolk: 'townsfolk',
} as const;
export type Faction = (typeof Faction)[keyof typeof Faction];

/**
 * The narrowest view of "a body with a side", so ONE predicate can serve three
 * modules that must not import each other.
 *
 * `faction` is optional because a PLAYER has none — players are one side by
 * construction and giving them a field would invite somebody to set it.
 */
export type Sided = {
  readonly kind: ActorKind;
  readonly faction?: Faction;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ARE THESE TWO ENEMIES? THE ONE ANSWER, AND THERE USED TO BE THREE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `a.kind !== b.kind` was written out THREE independent times:
 *
 *   `engine/actor.ts#isHostile`     — this file, the one everybody knows about
 *   `engine/talents.ts#isEnemy`     — a second copy, same line
 *   `engine/talents.ts#canUseTalent` — a third, written inline as
 *                                      `victim.kind === actor.kind`
 *
 * NONE of the other two is reachable from a `grep isHostile`, none is a compile
 * error, and none is a lint error. Fixing only this function would have left the
 * Inspector's Revolver Shot landing on a shopkeeper on day one — `'player' ===
 * 'monster'` is false, so `canUseTalent` would never refuse — and put her inside
 * an Alchemic Vial through `actorsInShape(..., Affinity.Hostile)`.
 *
 * Two more callers ride `isEnemy` and come right for free: `pullAggro` and
 * `resolveGuardCounter`.
 *
 * THE RULE: a Townsfolk is nobody's enemy and has none. It is stated once, as
 * two lines, in a predicate both modules can reach — `Sided` is structural, so
 * `engine/talents.ts` uses it without importing anything it must not.
 */
export function areEnemies(a: Sided, b: Sided): boolean {
  if (a.faction === Faction.Townsfolk || b.faction === Faction.Townsfolk) return false;
  return a.kind !== b.kind;
}

export type EngineActor = PlayerActor | MonsterActor;

/**
 * Compile-time proof that an actor is a valid input to `tickLevel`. If a field
 * is renamed on either side this fails here rather than at the call site with
 * an error pointing at the wrong file.
 */
const _energyShapeCheck = (actor: EngineActor): EnergyActor => actor;

export function isPlayer(actor: EngineActor): actor is PlayerActor {
  return actor.kind === ActorKind.Player;
}

export function isMonster(actor: EngineActor): actor is MonsterActor {
  return actor.kind === ActorKind.Monster;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * PLACEHOLDER VITALS. Real numbers arrive with content/classes/*.json and
 * content/monsters/*.json at M4; these exist so M2 can prove the turn rhythm
 * with something that can actually die. They are deliberately small — a fight
 * that lasts three turns exercises the barrier far more times per minute of
 * play than one that lasts fifteen.
 */
const DEFAULT_PLAYER_MAX_HP = 60;
const DEFAULT_PLAYER_HP_REGEN = 0.5;
const DEFAULT_PLAYER_DAMAGE_MIN = 4;
const DEFAULT_PLAYER_DAMAGE_MAX = 7;

/**
 * What a character is born with. `data/birth/descriptors.lua:74`.
 *
 * HERE AND NOT IN content/money.ts, because the engine owns the birth values —
 * `level: 1` and `xp: 0` are three lines below and this is the same kind of
 * fact. content/ may import engine/ (items.ts already does); the reverse is the
 * edge scheduler.ts:515-527 routes the whole talent system around.
 *
 * Fifteen is enough to matter and not enough to skip the first sale, which is
 * exactly what a starting purse is for.
 */
export const STARTING_MONEY = 15;

const DEFAULT_MONSTER_MAX_HP = 24;
const DEFAULT_MONSTER_HP_REGEN = 0;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORB'S FALLBACK DAMAGE. NOT THE MELEE SWING'S — NOT ANY MORE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Finding, recorded here because it is invisible from either end on its own:
 * `content/monsters.ts#monsterInit` copies name, sprite, rank, profile, maxHp,
 * hpRegen, both speeds, all four ranges and the whole `combat` sheet — and it
 * never passed `damageMin` or `damageMax`, so every authored monster fell
 * through to the two constants below and hit for 3-6 whatever its stat block
 * said. `scheduler.ts#strike` was `world.rng.int('combat.bump.damage', min,
 * max)` straight into a placeholder `applyDamage`: no `checkHit`, no armour, no
 * armour penetration, no resists, no crit, and therefore every `weapon.dam` /
 * `weapon.atk` / `weapon.apr` ported into the roster from ToME was INERT on the
 * attacker side.
 *
 * THAT IS FIXED. `strike` now resolves through `combat.ts#attackTarget`, which
 * was one change and not two — the scheduler's Chebyshev range check and
 * `canAttack`'s Euclidean one had to move together or attacks pass legality and
 * then quietly do nothing (see the wiring note at the head of engine/combat.ts).
 * An accuracy of 19 on a husk now means what it says.
 *
 * WHAT THESE TWO STILL DO, and it is a smaller job: they are the fallback for
 * `scheduler.ts#fire`, the frozen damage a TRAVELLING orb carries. Only a
 * creature with a `projSpeed` ever reads them, and the roster's one such
 * creature should author its own pair rather than inherit 3-6 — see the note on
 * `ActorCommon.damageMin`.
 */
const DEFAULT_MONSTER_DAMAGE_MIN = 3;
const DEFAULT_MONSTER_DAMAGE_MAX = 6;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR UNDER A CLASSLESS BODY. A PLACEHOLDER, SAID OUT LOUD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY IT HAS TO EXIST AT ALL. `strike` now runs the full pipeline, and a
 * SHEET-LESS attacker collapses to ToME's own bare level-1 defaults inside
 * derived.ts: accuracy 4, `combatDamage({}) = 4.408`, damRange 1.1 — and 4.408
 * and 4.849 both truncate to 4, so the roll is a FLAT 4 (damage.ts:276 takes no
 * draw when the endpoints agree) at 58% against a husk's defence 1. That is
 * 2.3 hp per turn against the 5.5 the M2 bump dealt: a 25 hp husk goes from
 * about four and a half player turns to eleven, and the difficulty of the game
 * inverts in one commit while every monster simultaneously gets its real sheet.
 *
 * So this sheet is tuned to hold TODAY'S behaviour rather than to be good:
 *
 *   `weapon.atk` 15  -> `combatAttack` 19  -> ceil(50 + 2.5 × (19 − 1)) = 95%
 *                       against `index_husk`'s defence 1. The M2 bump never
 *                       missed; 95% is the closest honest thing to "never".
 *   `weapon.dam` 20  -> `combatDamage` 6.270, × damRange 1.2 = 7.524
 *                    -> the range roll is [6, 7], mean 6.5.
 *                       Through a husk's armour 1 at hardiness 30 that is
 *                       max(6.5×0.3 − 1, 0) + 6.5×0.7 = 5.5 — the exact mean of
 *                       the M2 roll of 4-7, which is the point.
 *
 * NO `range` FIELD, AND THAT IS NOT AN OMISSION. `canAttack` floors a missing
 * `combat.range` at `MELEE_REACH` (`Math.max(attackRange ?? 1, MELEE_REACH)`),
 * so a classless player already reaches its eight neighbours and no further.
 * Importing `MELEE_REACH` here to say so twice would add a VALUE import from
 * this file to engine/combat.ts, and combat.ts imports world/world.ts, which
 * imports this file — see the note on the type-only import at the top. A
 * module-level constant built from the far side of that cycle is a
 * ReferenceError the first time a test imports combat.ts before world.ts.
 *
 * IT IS REPLACED WHOLESALE, NOT MERGED. `createPlayerActor` takes `init.combat`
 * in preference to this, and content/classes.ts's real class sheet is what
 * arrives there. A body that has a class never reads a byte of this.
 */
export const DEFAULT_PLAYER_COMBAT: CombatSheet = Object.freeze({
  weapon: Object.freeze({ dam: 20, atk: 15, damRange: 1.2 }),
  minRange: 0,
});

/** Per-profile defaults, so a spawn only names what makes this monster unusual. */
const PROFILE_RANGES: Readonly<
  Record<AiProfile, { readonly aggro: number; readonly preferred: number; readonly min: number }>
> = {
  [AiProfile.MeleeChaser]: { aggro: 8, preferred: 1, min: 0 },
  // `min` 3 mirrors the Inspector's authored `min_range` (game-design.md § 2):
  // something that cannot shoot what is standing on it has to keep its distance,
  // and that is what makes a melee ally worth standing behind.
  [AiProfile.RangedKiter]: { aggro: 9, preferred: 5, min: 3 },
};

export type PlayerInit = {
  readonly name: string;
  readonly sprite: string;
  readonly x: number;
  readonly y: number;
  readonly maxHp?: number;
  readonly hpRegen?: number;
  readonly damageMin?: number;
  readonly damageMax?: number;
  /**
   * The real combat sheet — content/classes.ts's, when a class has been
   * assigned. Absent → `DEFAULT_PLAYER_COMBAT`, the documented placeholder.
   */
  readonly combat?: CombatSheet;
  /** Which class this is, as a LABEL for the save file. See `PlayerActor.classId`. */
  readonly classId?: string;
};

export type MonsterInit = {
  readonly name: string;
  readonly sprite: string;
  readonly x: number;
  readonly y: number;
  readonly profile: AiProfile;
  /** Danger category. Defaults to `normal`; `elite` is what draws the ring. */
  readonly rank?: ActorRank;
  readonly maxHp?: number;
  readonly hpRegen?: number;
  /** Energy GAIN multiplier. The haste knob. */
  readonly globalSpeed?: number;
  /** Action COST multiplier. The opposite knob — see the file header. */
  readonly speedFactor?: number;
  readonly attackRange?: number;
  readonly damageMin?: number;
  readonly damageMax?: number;
  readonly aggroRange?: number;
  readonly preferredRange?: number;
  readonly minRange?: number;
  /** ELITE: hunt the most isolated hostile rather than the nearest. */
  readonly huntsIsolated?: boolean;
  /** ELITE: consecutive blocked turns before routing around its own kin. */
  readonly shoulderAfter?: number;
  /**
   * Ranged-attack travel speed in TILES PER GAME TURN. Absent = instantaneous,
   * which is what every attack does today (ActorTalents.lua:988). See
   * `MonsterActor.projSpeed`.
   */
  readonly projSpeed?: number;
  /**
   * `ai_state.talent_in` — a 1-in-N CHANCE per turn, not a cadence
   * (talented.lua:122). Absent = every turn. See `MonsterActor.talentIn`.
   */
  readonly talentIn?: number;
  /** A status this creature's landed blows inflict. See `OnHitStatus`. */
  readonly onHit?: OnHitStatus;
  /**
   * Which side. DEFAULTS TO `Redacted`, so every existing roster entry is
   * byte-identical and no seeded stream moves.
   */
  readonly faction?: Faction;
  /** The real combat sheet. content/monsters.ts always supplies one. */
  readonly combat?: CombatSheet;
};

/**
 * A player body at full health, both clocks at zero.
 *
 * Starting at zero means a player who joins mid-level waits a full game turn
 * before their first `actBase`, which is correct: they have not yet lived a
 * turn, so they have not yet earned a tick of regeneration.
 */
export function createPlayerActor(id: string, init: PlayerInit): PlayerActor {
  const maxHp = init.maxHp ?? DEFAULT_PLAYER_MAX_HP;
  // ONE EXPRESSION, TWO FIELDS, AND THEY MUST START IDENTICAL. `baseCombat` is
  // what gear and statuses recompose FROM; `combat` is the composed result. A
  // body wearing nothing and carrying no effect has them equal by identity,
  // which is what keeps `expect(body.combat).toBe(WATCHMAN.combat)` true for a
  // freshly joined player and keeps the classless fallback exactly as cheap as
  // it was before this field existed.
  const sheet = init.combat ?? DEFAULT_PLAYER_COMBAT;
  return {
    // The energy fields come from their owner in src/shared/energy.ts, so a
    // change to how a clock is initialised lands in one place.
    ...createEnergyActor(id, { globalSpeed: 1 }),
    kind: ActorKind.Player,
    // NO ROUND IS OPEN ON A BODY THAT HAS NEVER ACTED. See `PlayerActor`.
    roundActions: 0,
    roundTailMs: null,
    name: init.name,
    sprite: init.sprite,
    // A detective is never an elite. Rank exists to warn you about the room, and
    // a ring around your own party is noise.
    rank: ActorRank.Normal,
    x: init.x,
    y: init.y,
    // Restated as literals so the TYPE is `1`, not `number`. This is the D1 pin.
    globalSpeed: 1,
    speedFactor: 1,
    hp: maxHp,
    maxHp,
    hpRegen: init.hpRegen ?? DEFAULT_PLAYER_HP_REGEN,
    alive: true,
    attackRange: 1,
    damageMin: init.damageMin ?? DEFAULT_PLAYER_DAMAGE_MIN,
    damageMax: init.damageMax ?? DEFAULT_PLAYER_DAMAGE_MAX,
    // WHOLESALE, never merged: a class sheet is a complete stat block and
    // half of one blended with the placeholder is a body nobody authored.
    combat: sheet,
    baseCombat: sheet,
    classId: init.classId,
    // PROGRESSION STARTS AT THE BOTTOM AND EMPTY. Level 1 with no spare points
    // is the whole birth grant argument: ToME hands a fresh character 2 unused
    // points on top of its free birth talents (Actor.lua:171, warrior.lua:80-86),
    // and OUR birth grant is the four loadout talents themselves, already
    // learned at level 1 — see `pointsForLevel` in src/shared/progression.ts for
    // the budget arithmetic that falls out of dropping the 2.
    //
    // A RESTORED CHARACTER OVERWRITES ALL FOUR. They are mutable and the save
    // path assigns them after construction; there is deliberately no
    // `PlayerInit` field for them, because a half-restored character (level set,
    // raw talent points not) is the one state `unspentPoints` cannot be
    // reconciled from — the restore has to do the sheet and the actor together.
    level: 1,
    xp: 0,
    unspentPoints: 0,
    money: STARTING_MONEY,
    pendingLevels: 0,
    cooldowns: new Map<string, number>(),
    pendingIntent: null,
    standingOrder: null,
    connected: true,
    standingBy: false,
  };
}

/**
 * Add to (or take from) a purse. `Actor.lua:1686-1699`.
 *
 * THE ONE MUTATOR, and it clamps at zero exactly as upstream does — a debit
 * larger than the purse empties it rather than going negative. Everything else
 * in `incMoney` is ToME's: a summoner redirect (no summons here), three
 * achievements (none here) and two sound effects (the client owns audio).
 *
 * FLOORS ITS INPUT. Every caller passes an integer today; flooring here means a
 * fractional price arriving from a future shop cannot put 0.30000000000000004
 * in somebody's purse, which is a number a player would eventually see.
 */
export function incMoney(actor: PlayerActor, delta: number): number {
  if (!Number.isFinite(delta)) return actor.money;
  actor.money = Math.max(0, actor.money + Math.floor(delta));
  return actor.money;
}

/** A monster body. Speed is free here, in both directions — that is the point. */
export function createMonsterActor(id: string, init: MonsterInit): MonsterActor {
  const maxHp = init.maxHp ?? DEFAULT_MONSTER_MAX_HP;
  const ranges = PROFILE_RANGES[init.profile];
  const preferredRange = init.preferredRange ?? ranges.preferred;
  return {
    ...createEnergyActor(id, { globalSpeed: init.globalSpeed ?? 1 }),
    kind: ActorKind.Monster,
    name: init.name,
    sprite: init.sprite,
    rank: init.rank ?? ActorRank.Normal,
    x: init.x,
    y: init.y,
    speedFactor: init.speedFactor ?? 1,
    hp: maxHp,
    maxHp,
    hpRegen: init.hpRegen ?? DEFAULT_MONSTER_HP_REGEN,
    alive: true,
    // A kiter's reach is its stand-off distance unless it says otherwise;
    // anything else and it walks to exactly where it refuses to shoot from.
    attackRange: init.attackRange ?? Math.max(1, preferredRange),
    damageMin: init.damageMin ?? DEFAULT_MONSTER_DAMAGE_MIN,
    damageMax: init.damageMax ?? DEFAULT_MONSTER_DAMAGE_MAX,
    // BOTH, and both possibly `undefined` — a monster template that authors no
    // sheet keeps ToME's bare defaults on both halves, exactly as before. The
    // pair is set here rather than only on players because a monster CAN carry
    // items (its drop, decided at spawn) and because `recomposeCombat` must
    // never find a body whose baseline is a sheet something else already
    // composed onto.
    combat: init.combat,
    baseCombat: init.combat,
    cooldowns: new Map<string, number>(),
    pendingIntent: null,
    standingOrder: null,
    connected: true,
    standingBy: false,
    // NOT INSIDE `ai` BELOW, and the split is the same one `ai` already makes:
    // `ai` holds what this monster is THINKING (its target, its blocked-turn
    // counters), while these two are facts about the creature that outlive any
    // decision. `projSpeed` will also be read by whatever creates a projectile,
    // which has no business reaching into an AI state bag.
    //
    // Both are copied through as `undefined` when absent rather than defaulted.
    // Absent `projSpeed` is ToME's "instantaneous" (ActorTalents.lua:988) and
    // absent `talentIn` is "every turn" (talented.lua:122) — defaulting either
    // would change the behaviour of every monster that never asked for one, and
    // a defaulted `talentIn` in particular would put an rng draw into every
    // melee monster's turn and shift the seeded stream for the whole roster.
    projSpeed: init.projSpeed,
    talentIn: init.talentIn,
    // Copied through as `undefined` when absent, like the two above: a creature
    // that inflicts nothing must reach `strike`'s guard and take the branch it
    // has always taken, with no draw and no seeded-stream shift.
    onHit: init.onHit,
    // DEFAULTED, not required: the three roster templates author nothing, so
    // they stay exactly the bodies they were.
    faction: init.faction ?? Faction.Redacted,
    ai: {
      profile: init.profile,
      targetId: null,
      aggroRange: init.aggroRange ?? ranges.aggro,
      preferredRange,
      minRange: init.minRange ?? ranges.min,
      huntsIsolated: init.huntsIsolated ?? false,
      shoulderAfter: init.shoulderAfter ?? 0,
      blockedTurns: 0,
      shoulderTurns: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Energy — the D1 pin, in one function
// ---------------------------------------------------------------------------

/**
 * What one action costs this actor, as a multiple of ENERGY_TO_ACT.
 *
 * Players: always exactly 1. Monsters: their own `speedFactor`. There is no
 * third answer, and no caller supplies this number — which is exactly why D1
 * cannot be violated by a talent that forgets.
 */
export function actionCostMultiplier(actor: EngineActor): number {
  return actor.kind === ActorKind.Player ? 1 : actor.speedFactor;
}

/**
 * Spend one action's worth of act-energy — engine/Actor.lua:479-485
 * (`useEnergy`), with the cost shape of tome/class/Actor.lua:5863.
 *
 * THE ONLY sanctioned way for the engine to spend energy. It also sets
 * `energyUsed`, which is how `tickLevel` distinguishes a real action from a
 * free one and therefore how "the world did not change" stays decidable.
 *
 * @returns the energy actually deducted.
 */
export function spendTurn(actor: EngineActor): number {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ROUND ENDS WHERE THE TURN IS SPENT, AND NOWHERE ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This function's own docblock calls it "THE ONLY sanctioned way for the
   * engine to spend energy", and that is exactly why the reset belongs here
   * rather than at the call sites. `actPlayer` is not the only one: `autoHold`,
   * the Bell's expiry pass and anything added later all route through here, and
   * a reset written at three call sites is a reset the fourth forgets.
   *
   * A body that has spent its turn is not mid-round by definition, so clearing
   * unconditionally is correct even for a monster — `clearRound` is a no-op on
   * anything without the fields.
   */
  clearRound(actor);
  return spendForAction(actor, actionCostMultiplier(actor));
}

/**
 * Forget that a round was open.
 *
 * EXPORTED because two places need it that are not `spendTurn`: a floor reset,
 * which stands bodies back up in the spawn cluster and must not leave one
 * holding a deadline from the fight that was just annulled, and `actPlayer`'s
 * out-of-combat fallthrough — engagement can drop while somebody is mid-round,
 * and a stale deadline would then sit on them until the next fight.
 *
 * A NO-OP ON A MONSTER. Written against the union rather than `PlayerActor` so
 * callers holding an `EngineActor` do not each have to narrow first.
 */
export function clearRound(actor: EngineActor): void {
  if (actor.kind !== ActorKind.Player) return;
  actor.roundActions = 0;
  actor.roundTailMs = null;
}

// ---------------------------------------------------------------------------
// actBase — the once-per-GAME-TURN pass (tome/class/Actor.lua:476-609)
// ---------------------------------------------------------------------------

/**
 * The minimum the three cooldown helpers need.
 *
 * Structural rather than `EngineActor` so that engine/talents.ts — whose own
 * actor type is structural for the same reasons combat.ts's is — can share the
 * ONE cooldown store rather than opening a second one. There is exactly one
 * `cooldowns` map per actor and exactly one thing that decrements it; a second
 * store would be a second answer to "is this talent ready?".
 */
export type CooldownHolder = { readonly cooldowns: Map<string, number> };

/**
 * Tick every cooldown down by one GAME TURN — ActorTalents.lua:1002-1013.
 *
 * Deleting the entry at zero rather than leaving a 0 is ToME's own behaviour
 * (`talents_cd[tid] = nil`) and it keeps "is this talent ready?" a single
 * `has` check with no sentinel to get wrong.
 *
 * Deleting from a Map while iterating it is well-defined in JS: the deleted key
 * is simply not revisited.
 */
export function tickCooldowns(actor: CooldownHolder): void {
  for (const [talentId, turns] of actor.cooldowns) {
    const left = turns - 1;
    if (left <= 0) actor.cooldowns.delete(talentId);
    else actor.cooldowns.set(talentId, left);
  }
}

/** Turns remaining on a talent, or 0 when it is ready. */
export function cooldownOf(actor: CooldownHolder, talentId: string): number {
  return actor.cooldowns.get(talentId) ?? 0;
}

/** Put a talent on cooldown for `turns` GAME TURNS. Non-positive clears it. */
export function setCooldown(actor: CooldownHolder, talentId: string, turns: number): void {
  if (turns <= 0) actor.cooldowns.delete(talentId);
  else actor.cooldowns.set(talentId, turns);
}

/**
 * The status pass `actBase` runs at Actor.lua:597, injected rather than imported.
 *
 * Returns ToME's `no_talents_cooldown` attr — true when this actor's cooldowns
 * must NOT tick this turn (Actor.lua:606). `engine/effects.ts#statusPass` builds
 * one of these; a caller with no status system passes nothing and gets the M2/M3
 * behaviour unchanged.
 *
 * A CALLBACK, NOT AN IMPORT, and the direction is the reason: `effects.ts`
 * imports `setCooldown` from this file for Stunned's talent lockout
 * (physical.lua:495-504). Importing back would close the cycle, and moving the
 * lockout out of the engine would put `setCooldown` in the content layer.
 */
export type StatusPass = (actor: EngineActor) => boolean;

/**
 * THE SPEED-INDEPENDENT PASS — tome/class/Actor.lua:476-609.
 *
 * Called by `tickLevel` exactly once per game turn per living actor, at any
 * speed, because it fires on the base clock. `consumeBaseTurn` has already run.
 *
 * NOTHING IN HERE MAY READ `globalSpeed` OR `speedFactor`. That single rule is
 * why a hasted actor gets more actions but never faster cooldowns or shorter
 * debuffs, and the M2 test that pins it is: globalSpeed 1.4 -> 14 actions
 * across 10 game turns while cooldowns tick exactly 10 times.
 *
 * WHAT IS NOT HERE YET, and where it goes when it lands:
 *   - `checkStillInCombat` (Actor.lua:608) — engagement is LEVEL-WIDE in this
 *     game rather than per-actor, so it lives in the scheduler's game-turn hook
 *     instead of here. See scheduler.ts.
 */
export function actBase(actor: EngineActor, statusPass?: StatusPass): void {
  if (!actor.alive) return;

  // Actor.lua:525 `regenLife`. Clamped rather than accumulated past max so a
  // long rest cannot bank overheal.
  if (actor.hpRegen !== 0 && actor.hp < actor.maxHp) {
    actor.hp = Math.min(actor.maxHp, actor.hp + actor.hpRegen);
  }

  // Actor.lua:597 — `self:timedEffects()`. Status durations tick HERE, before
  // the cooldown pass, because upstream's own comment at :605 says so: "Cooldown
  // talents after effects, because some of them involve breaking sustains."
  const frozen = statusPass?.(actor) ?? false;

  // Actor.lua:606 — `if not self:attr("no_talents_cooldown") then
  // self:cooldownTalents() end`. THIS IS WHY A STUNNED ACTOR'S COOLDOWNS FREEZE,
  // and it is the difference between stun ending a fight and stun being a mild
  // damage debuff the victim waits out with a full bar of talents ready.
  if (!frozen) tickCooldowns(actor);
}

// ---------------------------------------------------------------------------
// Damage — MOVED
// ---------------------------------------------------------------------------

// `applyDamage` lived here as the M2 placeholder and is GONE; the one that
// applies damage is `engine/damage.ts#applyDamage`, at the end of the ordered
// pipeline. The corpse-camp guard moved with it — damage.ts:589 still returns an
// empty outcome against a body that is already down, which is the property
// the `damage.ts `applyDamage`` row in engine/downed.ts's "what Downed changes"
// table depends on. That row named THIS file until the move; it now names the
// function that actually holds the guard.

/**
 * Hostility, M2 edition: players and monsters, nothing else.
 *
 * FACTION SEAM. ToME resolves this through `reactionToward` (ai/simple.lua:253,
 * :263) over faction tables, which is what charm, summons and monster-on-monster
 * chains all need. Until one of those exists, a faction table would be a lookup
 * with one row.
 */
export function isHostile(a: EngineActor, b: EngineActor): boolean {
  // ONE ANSWER. See `areEnemies` — this line used to be written out three times
  // across two modules, and two of the copies were unreachable from a grep for
  // this function's name.
  return areEnemies(a, b);
}
