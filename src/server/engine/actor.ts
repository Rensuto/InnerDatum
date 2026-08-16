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
  /** PLACEHOLDER, for `scheduler.ts#strike` until it moves onto `attackTarget`. */
  damageMin: number;
  /** PLACEHOLDER, as above. */
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
  readonly ai: MonsterAi;
};

/**
 * The one actor type. Discriminated on `kind`, so narrowing to a player is what
 * unlocks the player-only fields and narrowing to a monster is what unlocks
 * `ai` — you cannot reach either by accident.
 */
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

const DEFAULT_MONSTER_MAX_HP = 24;
const DEFAULT_MONSTER_HP_REGEN = 0;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE TWO ARE WHAT THE ENTIRE ROSTER ACTUALLY DEALS. NOT A DEFAULT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Finding, recorded here because it is invisible from either end on its own:
 * `content/monsters.ts#monsterInit` copies name, sprite, rank, profile, maxHp,
 * hpRegen, both speeds, all four ranges and the whole `combat` sheet — and it
 * NEVER passes `damageMin` or `damageMax`. So every authored monster falls
 * through to the two constants below and hits for 3-6, whatever its stat block
 * says.
 *
 * CONSEQUENCE, so nobody re-derives it from the sheet: `scheduler.ts` resolves
 * `IntentKind.Attack` through `strike`, which is
 * `world.rng.int('combat.bump.damage', min, max)` straight into `applyDamage` —
 * no `checkHit`, no armour, no armour penetration, no resists, no crit. Every
 * `weapon.dam` / `weapon.atk` / `weapon.apr` ported into the roster from ToME is
 * therefore INERT ON THE ATTACKER SIDE. Those numbers are live in exactly two
 * places: `derived.ts` computing the inspect card, and the TARGET half of the
 * pipeline when a player talent (the only caller of `combat.ts#attackTarget`)
 * lands on the creature.
 *
 * The fix is to move the scheduler onto `attackTarget`, and it is ONE change,
 * not two — the scheduler's Chebyshev range check and `canAttack`'s Euclidean
 * one must move together or attacks pass legality and then quietly do nothing
 * (see the wiring note at the foot of engine/combat.ts). Until that lands, an
 * accuracy of 19 on a husk does not mean it never misses; it means nothing at
 * all rolls to hit.
 */
const DEFAULT_MONSTER_DAMAGE_MIN = 3;
const DEFAULT_MONSTER_DAMAGE_MAX = 6;

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
  /** The real combat sheet. Absent → ToME's own level-1 defaults (derived.ts). */
  readonly combat?: CombatSheet;
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
  return {
    // The energy fields come from their owner in src/shared/energy.ts, so a
    // change to how a clock is initialised lands in one place.
    ...createEnergyActor(id, { globalSpeed: 1 }),
    kind: ActorKind.Player,
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
    combat: init.combat,
    cooldowns: new Map<string, number>(),
    pendingIntent: null,
    standingOrder: null,
    connected: true,
    standingBy: false,
  };
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
    combat: init.combat,
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
  return spendForAction(actor, actionCostMultiplier(actor));
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
// Damage — placeholder until M3
// ---------------------------------------------------------------------------

/**
 * Apply damage and kill at zero.
 *
 * PLACEHOLDER. M3 replaces every caller with the ordered pipeline in
 * docs/tome-mechanics.md — checkHit, roll the weapon range BEFORE armour, then
 * armour/hardiness, then the crit, then the multiplier, then the damage-type
 * projector. The ordering there is load-bearing and none of it is here. What IS
 * here is the part M2 needs: hp goes down, `alive` goes false, and the body
 * stays in the world.
 *
 * @returns the damage actually applied, which is 0 against something already
 * dead — so a monster that swings at a corpse still visibly wasted its turn.
 */
export function applyDamage(target: EngineActor, amount: number): number {
  if (!target.alive || amount <= 0) return 0;
  const dealt = Math.min(target.hp, amount);
  target.hp -= dealt;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    // A dead body holds no decisions. Leaving a pending intent on a corpse
    // would let it resolve if it were ever revived mid-turn.
    target.pendingIntent = null;
  }
  return dealt;
}

/**
 * Hostility, M2 edition: players and monsters, nothing else.
 *
 * FACTION SEAM. ToME resolves this through `reactionToward` (ai/simple.lua:253,
 * :263) over faction tables, which is what charm, summons and monster-on-monster
 * chains all need. Until one of those exists, a faction table would be a lookup
 * with one row.
 */
export function isHostile(a: EngineActor, b: EngineActor): boolean {
  return a.kind !== b.kind;
}
