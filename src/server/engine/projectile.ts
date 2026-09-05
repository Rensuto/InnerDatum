// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/Projectile.lua:27-41 (Entity, not Actor; the birth energy)
//                                                                 :82-142 (move, and useEnergy inside it)
//                                                                 :168-172 (useEnergy defaults to energy_to_act)
//                                                                 :210-230 (act — the while loop and the stop branch)
//                                                                 :250-267 (on_move — something walks into a live orb)
//             t-engine4 game/engines/default/engine/interface/ActorProject.lua:327-357 (projectile)
//                                                                             :372-405 (projectDoMove)
//                                                                             :497-500 (projectDoStop, the single-target branch)
//             t-engine4 game/engines/default/engine/Target.lua:441-510 (block_path)
//                                                             :583-584 (bolt -> stop_block, beam -> line)
//                                                             :640-643 (getType applies only the matching entry)
//             t-engine4 game/modules/tome/data/talents/misc/npcs.lua:723-747 (T_VOID_BLAST — a BEAM; deviation 1)
//             t-engine4 game/engines/default/engine/interface/ActorTalents.lua:987-991 (getTalentProjectileSpeed)
//             t-engine4 game/engines/default/engine/GameEnergyBased.lua:113-125 (the two clocks)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                        THE TRAVELLING PROJECTILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An orb that crosses tiles on the energy clock instead of arriving the instant
 * it is fired, so that a shot can be DODGED and a wall can be STOOD BEHIND.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRAVEL IS OPT-IN, AND THAT IS THE WHOLE SAFETY ARGUMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME does NOT make every bolt travel. `getTalentProjectileSpeed`
 * (ActorTalents.lua:987-991) opens with `if not t.proj_speed then return nil
 * end`, and upstream's own tooltip spells the two cases out in words
 * (tome/class/Actor.lua:6272-6274): *"Travel Speed: N% of base"* when the field
 * is present, *"Travel Speed: instantaneous"* when it is not.
 *
 * So ABSENT `projSpeed` MEANS EXACTLY WHAT EVERY ATTACK IN THIS GAME ALREADY
 * DOES. Nothing that existed before this file changes behaviour by one byte;
 * only an attack that OPTS IN starts travelling. The fork lives in
 * `scheduler.ts`'s `IntentKind.Attack` case, which still calls `strike` verbatim
 * for anything without the field.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS AN ENTITY, NOT AN ACTOR — engine/Projectile.lua:27, :32, :96
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's `Projectile` inherits `Entity` (not `Actor`), declares
 * `__is_projectile`, and writes itself into `Map.PROJECTILE` — never
 * `Map.ACTOR`. We keep that split for five concrete local reasons, all of them
 * silent breakages if it were merged into the actor table: `isHostile` is
 * `a.kind !== b.kind` (actor.ts) so a third kind would be hostile to BOTH sides
 * and the AI would start shooting at orbs; `world.actorAt` would make the orb
 * block movement; `projectActors` would ship it as an `ActorView` with an hp bar
 * and a rank ring; `ringIdFor` in the client switches exhaustively over a
 * two-member `ActorKind` and would demand a `ui_token_ring_*` sprite that cannot
 * be added (the art is gitignored wholesale); and `actMonster` would run
 * `decideNpcAction` on it.
 *
 * The seam is already structural: `tickLevel` takes `readonly EnergyActor[]` —
 * six fields, "deliberately not the actor" (shared/energy.ts) — so a `Projectile`
 * joins the scheduler by SHAPE and by nothing else. `_energyShapeCheck` below is
 * the compile-time proof, exactly as `actor.ts` has one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT TAKES ZERO RNG DRAWS. EVER. THAT IS THE DETERMINISM ARGUMENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The damage NUMBER is rolled at FIRE, inside the shooter's own `act`, at the
 * same stream position and under the same `combat.bump.damage` label an instant
 * attack uses today — then FROZEN onto the orb. Flight is pure integer energy
 * arithmetic over a frozen Bresenham path. Impact calls `applyDamage` with
 * `damageRange` and `critChance` DELIBERATELY OMITTED, and damage.ts:463 / :475
 * are the ONLY two draw sites in `resolveDamage`, both guarded on exactly those
 * two optional fields.
 *
 * Therefore THE NUMBER OF ORBS IN THE AIR CANNOT PERTURB ANY ACTOR'S STREAM, and
 * replay-from-seed is identical whether three orbs are flying or none. That is a
 * proof rather than a mitigation, which is why no per-projectile forked stream
 * exists here: two orbs forked at the same parent state under the same label
 * would draw the same sequence anyway (rng.ts's `fork` note), so the fork would
 * have been a hazard bought with nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HOMING (Projectile.lua:319-341) — a second target-tracking state machine
 * reachable only through `makeHoming`, which has no `proj_speed` path and no
 * in-scope caller. BALL / CONE / WALL GEOMETRY (ActorProject.lua:438-500) —
 * ~70 lines of `core.fov.calc_circle` / `calc_beam_any_angle` / `calc_wall` for
 * AoE talents none of which exist; only the `-- Deal damage: single` branch at
 * :497-500 is ported. PARTICLES and trails. SAVE/LOAD line re-import
 * (engine/Projectile.lua:44-59) — the world is rebuilt at every boot, so an in-flight
 * orb simply evaporates and no SCHEMA_VERSION moves. `on_project_acquire` /
 * `on_projectile_target` / `slow_projectiles`. The `__project_source`
 * attribution chain (Actor.lua:5727-5789), replaced by one `sourceId` string.
 * REFLECT / DEFLECT.
 *
 * AND NO min_range CHECK IN FLIGHT. `projectile()` has none upstream — only
 * `project()` does (ActorProject.lua:187-189) — so adding one would be a
 * divergence wearing a citation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE DELIBERATE DEVIATIONS FROM UPSTREAM, NUMBERED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE ORB IS A `bolt`, AND THE TALENT ITS SPEED WAS READ FROM IS A `beam`.
 *    THIS IS THE BIG ONE AND IT USED TO GO UNSAID. T_VOID_BLAST — the
 *    losgoroth's only granted talent and where `proj_speed = 2` comes from —
 *    declares `target = {type="beam", ...}` at misc/npcs.lua:734. Target.lua:584
 *    maps `beam` to `dest.line = true` AND SETS NO `stop_block`; `stop_block` is
 *    what the `bolt` entry at :583 sets, and `Target:getType` (:640-643) applies
 *    only the entries whose name the type string contains. So UPSTREAM'S VOID
 *    BLAST DOES NOT STOP ON A BODY: `block_path`'s actor clause (Target.lua:471)
 *    is gated on `typ.stop_block`, and ActorProject.lua:400 — `if typ.line and
 *    (lx ~= tgtx or ly ~= tgty) then return lx, ly, true, false` — fires
 *    `projectDoAct` on EVERY intermediate grid, so the real orb damages
 *    everything it passes over and flies on to the aim tile. Projectile.lua:258
 *    confirms it from the other side: walking into a live beam projectile calls
 *    `projectDoAct`, not `projectDoStop`.
 *
 *    WHAT IS HERE IS THE `bolt` INSTEAD: one victim, the first body on the line,
 *    and the flight ends there. The reason is plumbing rather than taste — a
 *    beam has N victims per flight and `ProjectileOutcome` carries ONE `impact`,
 *    which `actProjectile` turns into ONE `attack` sweep step and one Case Log
 *    line. Porting the beam means widening the outcome, the Effect variant, the
 *    sweep step and the client's playback, and none of that is in this scope.
 *    The consequence a reader must know: a body standing between the wraith and
 *    its target BLOCKS the shot here and merely gets clipped by it upstream.
 *    Widen `impact` to a list and this becomes `typ.line` on a flag.
 *
 * 2. THE RANGE METRIC IS CHEBYSHEV, not `core.fov.distance`'s Euclidean. The
 *    whole argument is on `blockPath` below, where the line lives.
 *
 * 3. WALK-INTO-A-LIVE-ORB IS TESTED IN FLIGHT, NOT IN THE MOVER. Upstream's
 *    `Projectile:on_move` (:250-267) is called BY the mover when something
 *    enters the orb's grid — the orb occupies a tile in `Map.PROJECTILE`, so the
 *    swap cannot happen there. Our orb is deliberately not in `world.actorAt`
 *    (see the entity/actor split above), so `tryMove` cannot see it and the only
 *    hook upstream offers is inside the single position writer in the process.
 *    Putting a damage call there is a seam this port will not open. Instead
 *    `stepProjectile` re-tests THE ORB'S OWN TILE at the top of every iteration,
 *    which closes the same hole from the other side and one act later: the same
 *    `projectDoStop` on the same tile (:258-259), just scheduled rather than
 *    synchronous with the step that caused it. Without it the orb and a charging
 *    body exchange tiles with no collision test in either direction, and walking
 *    straight at the shooter — the single most obvious anti-ranged move — is a
 *    guaranteed clean dodge.
 *
 * SYNCHRONOUS. src/server/engine/** carries the six anti-async AST selectors:
 * an orb advances on the energy clock, never on a timer. A timer here would be
 * the one thing the phase-lock constraint cannot survive.
 */

import { bresenham } from '../../shared/coords.ts';
import { ENERGY_TO_ACT, canAct, spendForAction } from '../../shared/energy.ts';
import { canWalk } from '../../shared/level.ts';
import { DamageType, applyDamage } from './damage.ts';
import type { OnHitStatus } from './actor.ts';
import type { TileXY } from '../../shared/coords.ts';
import { onFlightPath } from '../../shared/flight.ts';
import type { EnergyActor } from '../../shared/energy.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { Intent } from './actor.ts';
import type { DamageTarget, TypeTable } from './damage.ts';
import type { CombatSheet } from './combat.ts';

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Everything about the blow that was decided AT FIRE and must not be re-read
 * from the shooter's body at impact.
 *
 * FROZEN, because the shooter may be a corpse by the time this lands. Upstream
 * holds a hard reference to `self.src` and calls back into it three times per
 * step (Projectile.lua:215, :218, :230) with no liveness check at all; we copy
 * the BEHAVIOUR (the orb still flies, and the damage is still attributed to the
 * dead shooter — tome/class/Game.lua:1713) and deliberately not the hazard.
 */
export type ProjectileDamage = {
  /** The frozen `combat.bump.damage` roll. `project.def.dam`, ActorProject.lua:353. */
  readonly dam: number;
  readonly type: DamageType;
  /** The shooter's `combatAPR` at the instant of firing. */
  readonly apr: number;
  /** The shooter's `inc_damage` table. */
  readonly increase?: TypeTable;
  /** The shooter's `resists_pen` table. */
  readonly penetration?: TypeTable;
  /**
   * THE SHOOTER'S OWN DEBUFFS, frozen at the instant of firing like everything
   * else here — Dazed and Stunned as flags, `numbed` as a percentage
   * (damage_types.lua:146-160).
   *
   * CARRIED RATHER THAN READ ON IMPACT, and it has to be: `ProjectileWorld` is
   * deliberately narrowed to `level`, `actorAt` and `rng`, so the flight has no
   * way back to the shooter's body — the same constraint that made `apr`,
   * `increase` and `penetration` snapshots. Upstream reads them at impact off a
   * live `src`; ours differ only for a debuff that lands in the same turn as
   * the bolt, which is the trade `apr` already makes.
   */
  readonly sourceDazed?: boolean;
  readonly sourceStunned?: boolean;
  readonly sourceNumbed?: number;
};

/**
 * An orb in flight. Structurally an `EnergyActor` (shared/energy.ts) plus the
 * six fields a flight needs.
 */
export type Projectile = {
  /** `proj_<n>`, minted by the world's monotonic counter. Never reused. */
  readonly id: string;

  // --- the scheduler's view (EnergyActor) -----------------------------------
  /**
   * THE ACT CLOCK, and it is BORN FULL — engine/Projectile.lua:37-39,
   * `self.energy.value = self.energy.value or game.energy_to_act`.
   *
   * That single line is why a shot visibly leaves the muzzle. `grantEnergy`'s
   * anti-stockpiling guard (energy.ts:253) refuses to add anything to an actor
   * already at the threshold, so an orb created holding ENERGY_TO_ACT spends its
   * first tile on its very first tick and only then starts accruing.
   */
  energy: number;
  /**
   * THE BASE CLOCK, and it is never used: `actBase` returns immediately for a
   * projectile, mirroring GameEnergyBased.lua:113-114, which guards the
   * base-clock block on `e.actBase and e.energyBase` and therefore ticks an
   * entity without them for `act` only.
   */
  energyBase: number;
  /**
   * TILES PER GAME TURN, as an energy GAIN multiplier — `energy.mod`,
   * engine/Projectile.lua:37 and :304-305, granted at GameEnergyBased.lua:125.
   *
   * The arithmetic, once: a tick grants `ENERGY_PER_TICK * energyMod *
   * globalSpeed` = `100 * projSpeed * 1`; ten ticks make a game turn; a tile
   * costs ENERGY_TO_ACT = 1000. So tiles per turn = 100·projSpeed·10/1000 =
   * projSpeed, exactly. Upstream's tooltip agrees from the other direction
   * (tome/class/Actor.lua:6272-6274 prints `speed * 100 .. "% of base"`).
   *
   * NOT READONLY, and that is a port rather than an oversight: upstream mutates
   * `proj.energy.mod` after creation (tome/class/Actor.lua:7181-7195, the
   * `slow_projectiles` attr).
   */
  energyMod: number;
  /** 1. A projectile has no `global_speed`, so GameEnergyBased.lua:125's factor is 1. */
  globalSpeed: number;
  /** Set by `spendForAction`; the loop reads it to tell a real step from a free pass. */
  energyUsed: boolean;

  // --- the flight -----------------------------------------------------------
  /**
   * WHO FIRED IT, AS AN ID — never an object reference. See `ProjectileDamage`:
   * the shooter may be a corpse, and nothing at impact may touch its body.
   */
  readonly sourceId: string;
  /**
   * Where it was fired FROM, frozen. Upstream passes `start_x`/`start_y`
   * explicitly rather than reading `src.x` (Projectile.lua:215,
   * ActorProject.lua:341-342), which is exactly what makes a dead shooter safe.
   * It is also the anchor the range check measures from (Target.lua:446-448).
   */
  readonly origin: TileXY;
  /**
   * The frozen tile list, ORIGIN INCLUDED AT INDEX 0 — see `cursor`.
   *
   * Built ONCE, at fire, from the two endpoints at that instant
   * (ActorProject.lua:343-347 builds `typ.line_function` once and every later
   * step only advances it at :373). IT DOES NOT TRACK: the orb flies to the tile
   * you were standing on when it was fired, and stepping off that tile is the
   * counterplay.
   */
  readonly path: readonly TileXY[];
  /**
   * THE NEXT TILE TO STEP ONTO. STARTS AT 1, NOT 0.
   *
   * Our `bresenham` INCLUDES the origin as `path[0]`, whereas ToME's
   * `line_function:step()` yields the first tile AWAY from the source — the orb
   * is placed on `start_x, start_y` when it is added to the level
   * (ActorProject.lua:354, Zone.lua:757) and its first act steps off it. One
   * off-by-one here is an orb that spends its first turn detonating on its own
   * shooter.
   */
  cursor: number;
  /** Reach, from `origin`. Target.lua:446-452 — past it the orb stops. */
  readonly range: number;
  /** Frozen at fire. See `ProjectileDamage`. */
  readonly damage: ProjectileDamage;
  /**
   * A STATUS THIS ORB INFLICTS WHERE IT LANDS — frozen at the muzzle, exactly
   * like `damage` one line above, and for the identical reason.
   *
   * `damage` is rolled at the cast and carried (`ActorProject.lua:353` stores
   * the fixed number in `project.def.dam` for the projectile to hold). Reading
   * either off the shooter at IMPACT would mean an orb's effect depended on
   * what happened to the creature during two or three game turns of flight —
   * whether it was stunned, whether it died, whether it walked out of the
   * realm. An orb in the air is a fact, not a promise.
   *
   * ═══ THIS FILE CARRIES IT AND DOES NOT APPLY IT ═══
   * The scheduler does, one line after `stepProjectile` returns, off
   * `ProjectileImpact.targetId`. That is not a layering nicety: `applyDamage`
   * takes a `ProjectileVictim`, which is deliberately the narrowest view of a
   * body this module can work with, and `setEffect` needs a whole actor. Rather
   * than widen the narrow type or thread an effect table into a flight
   * simulation, the orb carries the DATA and the caller — which already holds
   * both the world and the status door — performs the act.
   */
  readonly onHit?: OnHitStatus;
  /**
   * Upstream's `dead` (Projectile.lua:211, :213). Once true the orb has already
   * detonated: `isActive` stops ticking it and the world drops it. It is a FLAG
   * rather than "absent from the table" because the scheduler ticks a SNAPSHOT
   * of the array and an orb that lands mid-pump is still in that snapshot.
   */
  landed: boolean;
  /**
   * THE ANTI-LEAK ANCHOR — Projectile.lua:220-229, ActorProject.lua:232-237.
   *
   * Three lines, kept even though nothing in scope has an area of effect, and
   * they are the difference between an explosion leaking through a one-tile wall
   * and not: when the stopping tile is one the orb MOVED ONTO but may not
   * radiate from, the radius anchors on the tile BEFORE it.
   *
   * ═══ IT IS A WALL RULE, NOT A "SOMETHING STOPPED ME" RULE ═══
   * `hit_radius` is FALSE FOR TERRAIN ONLY. Target.lua:466 returns
   * `true, true, false` for a wall, and Target.lua:501 returns `true, true, TRUE`
   * for a body under `stop_block` — so a body-stop radiates FROM THE VICTIM'S
   * OWN TILE and only a wall-stop steps back. This comment used to say "both a
   * wall and a body", and `blockPath` encoded that wrong value, which would have
   * centred every body-stop explosion one tile back along the line and
   * systematically spared the creature that was actually hit. Nothing would have
   * failed: the first AoE to read this field would simply have been wrong.
   *
   * The single-target branch does not read it — `projectDoStop` uses `lx, ly`,
   * the orb's own tile — so it is recorded and not consulted, which is the
   * honest shape for a field whose only consumer is the AoE that does not exist
   * yet. `Block.hitRadius` IS read, by `projectDoMove`, so the value cannot rot.
   */
  radiusAt: TileXY;
};

/** Compile-time proof that an orb is a legal input to `tickLevel`. */
const _energyShapeCheck = (proj: Projectile): EnergyActor => proj;

/** What `world.addProjectile` needs. The world adds only the id. */
export type ProjectileInit = {
  readonly sourceId: string;
  /** The shooter's tile at the instant of firing. */
  readonly origin: TileXY;
  /** The TARGET'S TILE at the instant of firing. Not the target. See `path`. */
  readonly to: TileXY;
  /** Tiles per game turn. `t.proj_speed`, ActorTalents.lua:987-991. */
  readonly projSpeed: number;
  readonly range: number;
  readonly damage: ProjectileDamage;
  /** The rider this shot carries. See `Projectile.onHit` — frozen at the muzzle. */
  readonly onHit?: OnHitStatus;
};

/**
 * Mint one orb. `id` comes from the world's monotonic counter — `Date.now` and
 * `Math.random` are ESLint errors in this directory, so a counter is the only
 * legal id source and that is a feature: ids are replay-stable.
 *
 * ═══ THE ONE THROW, AND IT IS A HANG GUARD RATHER THAN A TYPO CHECK ═══
 * `projSpeed` becomes `energyMod`, and a zero or non-finite `energyMod` makes
 * `energyGainPerTick` answer 0 while `anyCanGainEnergy` (energy.ts:676) still
 * answers TRUE — the orb sits below the threshold forever, `tickLevel` burns its
 * whole 10,000-tick budget on this pump AND ON EVERY PUMP FOR THE REST OF THE
 * SESSION, and `isActive` never drops it because `landed` stays false. The
 * scheduler's own `maxTicks` note has the sentence: an unbounded loop here is
 * not a dropped frame. `validateTemplate` in content/monsters.ts says the same
 * thing about the same field, but it is called from a test — so it covers the
 * three authored templates and nothing else. THIS is on the runtime path, which
 * is where the value actually enters the energy loop. Same shape as
 * `spendForAction`'s non-finite refusal (energy.ts:302-304).
 */
export function createProjectile(id: string, init: ProjectileInit): Projectile {
  if (!Number.isFinite(init.projSpeed) || init.projSpeed <= 0) {
    throw new RangeError(
      `createProjectile(${id}): projSpeed must be a positive finite number, got ${init.projSpeed}`,
    );
  }

  const origin: TileXY = Object.freeze({ x: init.origin.x, y: init.origin.y });
  const path = Object.freeze(bresenham(origin, init.to).map((tile) => Object.freeze(tile)));

  return {
    id,
    // BORN HOLDING A FULL TURN — engine/Projectile.lua:37-39. See the field's note.
    energy: ENERGY_TO_ACT,
    // Never used. GameEnergyBased.lua:113-114.
    energyBase: 0,
    energyMod: init.projSpeed,
    globalSpeed: 1,
    energyUsed: false,
    sourceId: init.sourceId,
    origin,
    path,
    // path[0] IS the origin; ToME's line steps off it. See `cursor`.
    cursor: 1,
    range: init.range,
    damage: Object.freeze({ ...init.damage }),
    // FROZEN AND COPIED, like the damage above. The template's row is already
    // frozen, but copying means a live orb can never be a window onto content
    // that some later edit reaches through.
    ...(init.onHit === undefined ? {} : { onHit: Object.freeze({ ...init.onHit }) }),
    landed: false,
    radiusAt: origin,
  };
}

// ---------------------------------------------------------------------------
// The world, as an orb sees it
// ---------------------------------------------------------------------------

/**
 * The body an orb can land on. `EngineActor` satisfies it; so does a four-field
 * test fixture, which is the point — the same argument `CombatActor` makes in
 * engine/combat.ts.
 */
export type ProjectileVictim = DamageTarget & {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Cleared on a killing blow. See `projectDoStop`. */
  pendingIntent: Intent | null;
  readonly combat?: CombatSheet;
};

/**
 * Just enough world for a flight. `World` satisfies it structurally, so this
 * file needs no value import from world/ and there is no module cycle to close.
 */
export type ProjectileWorld = {
  readonly level: LevelView;
  /** THE LIVING body on a tile. A corpse is scenery — world.ts's own rule. */
  actorAt(x: number, y: number): ProjectileVictim | undefined;
  readonly rng: Rng;
};

// ---------------------------------------------------------------------------
// The flight
// ---------------------------------------------------------------------------

/**
 * WHY AN ORB STOPPED. Five conditions, and every one of them is a line in
 * `projectDoMove` or `block_path`.
 */
export const ProjectileStop = {
  /** Terrain. Target.lua:459-468 — `block=true, hit=true`: it MOVES ONTO the wall tile, then stops. */
  Wall: 'wall',
  /**
   * A body. Target.lua:471-501 under `stop_block`, which the `bolt` type sets
   * (:583) and the `beam` type does NOT (:584) — moves on, then detonates.
   * DEVIATION 1 in the header: the talent this port's `proj_speed` was read from
   * is a beam, which passes through bodies. This is the bolt rule.
   */
  Actor: 'actor',
  /** Past `range`. Target.lua:446-452 — `block=true, hit=false`: NO move, but stop, so it detonates where it is. */
  Range: 'range',
  /** Off the map. Target.lua:443-444 plus ActorProject.lua:395-397. Same shape as `Range`. */
  Edge: 'edge',
  /** The line ran out on an empty tile. ActorProject.lua:403. */
  EndOfLine: 'end_of_line',
} as const;
export type ProjectileStop = (typeof ProjectileStop)[keyof typeof ProjectileStop];

/** A landed orb that found somebody. Everything the sweep step needs. */
export type ProjectileImpact = {
  readonly targetId: string;
  /** HP actually removed. */
  readonly damage: number;
  readonly killed: boolean;
  /**
   * WHAT KIND OF DAMAGE — a wraith's void blast is darkness, and the Case Log
   * printed it as a bare number because this dropped it. `applyDamage` resolves
   * the type and returns it on the outcome one line below; carrying it costs
   * nothing and is the third hop in this chain that was losing it (`Blow` and
   * `hitToWire` were the others).
   *
   * NO `crit` BESIDE IT, and that is not an oversight: the impact call passes no
   * `critChance`, and `DamageSpec.critChance`'s contract is "absent → no crit
   * and no draw". An orb genuinely cannot crit, so reporting one would be the
   * invention these fields exist to prevent.
   */
  readonly type: DamageType;
  /** The victim's hp and tile the instant this landed — `GameEvent.attacked`'s rule. */
  readonly hp: number;
  /**
   * And its maximum, snapshotted for the same reason. See `Blow.maxHp`.
   *
   * OPTIONAL because the narrow actor this module is handed makes `maxHp`
   * optional too (damage.ts says why: dozens of fixtures pass `{ hp, alive }`).
   * Absent means "ask the world", which is what `hitToWire` did for everybody
   * before the snapshot existed.
   */
  readonly maxHp?: number;
  readonly at: TileXY;
};

/** What one `act` call did. */
export type ProjectileOutcome = {
  /** True once it has detonated. The caller drops it from the world. */
  readonly landed: boolean;
  /** Why. Null while it is still flying. */
  readonly stop: ProjectileStop | null;
  /** The orb's tile now. */
  readonly at: TileXY;
  /** Null when it landed on empty air — which is what a dodge looks like. */
  readonly impact: ProjectileImpact | null;
};

/** Chebyshev, on purpose. See the range branch of `blockPath`. */
function distance(a: TileXY, b: TileXY): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** What `block_path` answers, in ToME's own three-value shape (Target.lua:441). */
type Block = {
  /** Does this tile stop the projection? */
  readonly block: boolean;
  /** May the projectile MOVE ONTO it first? False = stop where you are. */
  readonly hit: boolean;
  /** May an area of effect radiate FROM it? See `Projectile.radiusAt`. */
  readonly hitRadius: boolean;
};

const PASSES: Block = { block: false, hit: true, hitRadius: true };

/**
 * `block_path` — Target.lua:441-510, in upstream's own order, minus everything
 * that needs a system we do not have.
 *
 * ═══ DEVIATION 2 OF 3: THE RANGE METRIC IS CHEBYSHEV ═══
 * Upstream measures with `core.fov.distance`, which is EUCLIDEAN (engine/
 * combat.ts's `combatDistance` is the port of it). This uses Chebyshev because
 * the scheduler's own legality gate does — `chebyshev(actor, target) >
 * actor.attackRange` is what let this shot be fired at all — and mixing the two
 * metrics means an orb fired at a diagonal target that PASSED the legality check
 * stops short of it and detonates on empty floor, every single time, with
 * nothing failing anywhere. engine/combat.ts's wiring note says the same thing
 * about the same pair of metrics: they move together or not at all. When the
 * scheduler moves onto `attackTarget` and its Euclidean `canAttack`, this line
 * moves with it.
 *
 * NOT PORTED, and each is a system rather than a line: `requires_knowledge` (no
 * remembered-map layer yet), `pass_terrain` / `pass_projectile` (no terrain
 * carries the flag), `friendlyblock` / `actorblock` (ToME's default for a bolt
 * is that ANY body blocks, and that is what we want — an ally standing in the
 * line eats the orb, which is a rule players can see and use).
 */
function blockPath(proj: Projectile, world: ProjectileWorld, tile: TileXY): Block {
  // Target.lua:443-444 — off the map. `true, false, false`: no move.
  if (tile.x < 0 || tile.y < 0 || tile.x >= world.level.w || tile.y >= world.level.h) {
    return { block: true, hit: false, hitRadius: false };
  }

  // Target.lua:446-452 — past the reach, measured from `start_x, start_y`.
  // `true, false, false`: no move, so it detonates on the last in-range tile.
  if (distance(proj.origin, tile) > proj.range) {
    return { block: true, hit: false, hitRadius: false };
  }

  // Target.lua:459-468 — terrain. `true, true, false`: it MOVES ONTO the wall
  // and stops there, and `hitRadius` false is the anti-leak rule.
  if (!canWalk(world.level, tile.x, tile.y)) {
    return { block: true, hit: true, hitRadius: false };
  }

  // Target.lua:471-501 — a body, under `stop_block`, which the `bolt` target
  // type sets (Target.lua:583) and the `beam` type does not (:584; see DEVIATION
  // 1 in the file header — the talent this speed came from is a beam).
  //
  // `true, true, TRUE` — Target.lua:501, and the third value is NOT the wall's.
  // A body-stop may radiate from the victim's own tile; only terrain forces the
  // anchor back a step. See `Projectile.radiusAt`.
  if (world.actorAt(tile.x, tile.y) !== undefined) {
    return { block: true, hit: true, hitRadius: true };
  }

  return PASSES;
}

/** One step's worth of decision — ActorProject.lua:372-405, `projectDoMove`. */
type Move = {
  /** The tile to move onto, or null for "stay where you are". */
  readonly to: TileXY | null;
  readonly stop: ProjectileStop | null;
  /**
   * May an AoE radiate from the tile this step ENDS on? `Block.hitRadius` for
   * the tile that was moved onto, and `true` whenever the orb did not move —
   * because upstream re-runs `block_path` on the orb's own tile at
   * Projectile.lua:220-221, and an orb that did not move is standing on a tile
   * it already passed, which answers `false, true, true` (Target.lua:509).
   */
  readonly hitRadius: boolean;
};

function projectDoMove(proj: Projectile, world: ProjectileWorld): Move {
  const next = proj.path[proj.cursor];

  // ActorProject.lua:403 — `if (not lx and not ly) then return lx, ly, false, true`.
  // The line ran out. Nothing to move onto, and this is the last tile.
  if (next === undefined) return { to: null, stop: ProjectileStop.EndOfLine, hitRadius: true };

  const blocked = blockPath(proj, world, next);
  if (blocked.block) {
    // ActorProject.lua:379-386. `hit` decides whether the orb reaches the tile
    // that stopped it, and it is the whole difference between an orb that
    // detonates ON you and one that fizzles at the edge of its range.
    if (!blocked.hit) {
      const beyondMap =
        next.x < 0 || next.y < 0 || next.x >= world.level.w || next.y >= world.level.h;
      return {
        to: null,
        stop: beyondMap ? ProjectileStop.Edge : ProjectileStop.Range,
        hitRadius: true,
      };
    }
    return {
      to: next,
      stop: canWalk(world.level, next.x, next.y) ? ProjectileStop.Actor : ProjectileStop.Wall,
      // THE VALUE FROM `block_path`, NOT `stop === null`. A wall is false and a
      // body is true (Target.lua:466 vs :501) — see `Projectile.radiusAt`.
      hitRadius: blocked.hitRadius,
    };
  }

  // ActorProject.lua:400 — the BEAM branch (`typ.line`) would return act=true
  // here and keep going. See DEVIATION 1 in the file header: the orb ported here
  // is the `bolt`, so a pass-through tile is exactly that and nothing more.
  return { to: next, stop: null, hitRadius: blocked.hitRadius };
}

/**
 * `projectDoStop`, THE SINGLE-TARGET BRANCH ONLY — ActorProject.lua:497-500,
 * `-- Deal damage: single ... addGrid(lx, ly)`.
 *
 * `lx, ly` is the ORB'S OWN TILE, not `radius_x, radius_y`: the radius pair is
 * read by the ball / cone / wall geometry at :438-496 and by nothing else.
 *
 * ═══ THIS CALL IS PROVABLY DRAW-FREE, AND THAT IS THE DETERMINISM ARGUMENT ═══
 * `damageRange` and `critChance` are OMITTED. damage.ts:463 and :475 are the
 * only two draw sites in `resolveDamage` and both are guarded on exactly those
 * fields, so impact consumes ZERO rng draws — which is what makes the number of
 * orbs in the air incapable of shifting any actor's stream. Do not add either
 * field here without moving the roll to FIRE time, where the shooter's own
 * `combat.bump.damage` draw already lives.
 */
function projectDoStop(
  proj: Projectile,
  world: ProjectileWorld,
  at: TileXY,
): ProjectileImpact | null {
  const foe = world.actorAt(at.x, at.y);
  // NOBODY HOME. The target died (world.actorAt skips corpses — "a dead body is
  // scenery"), or stepped off the tile the orb was aimed at. The second one is
  // the counterplay and it must never be softened into a re-aim.
  if (foe === undefined) return null;

  const outcome = applyDamage(
    foe,
    proj.damage.dam,
    proj.damage.type,
    { id: proj.sourceId },
    world.rng,
    {
      /**
       * ═════════════════════════════════════════════════════════════════
       * NO ARMOUR HERE. THE PROJECTOR PATH DOES NOT WEAR IT.
       * ═════════════════════════════════════════════════════════════════
       * This passed `combatArmor` and `combatArmorHardiness`, which is the
       * natural assumption — an orb is an attack, so armour should stop some
       * of it — and it is not what ToME does. `combatArmor()` is called once
       * in the module, at `Combat.lua:439`, inside `attackTargetWith`: the
       * MELEE path. `defaultProjector` (damage_types.lua:48-528) carries the
       * percentage resists and `flat_damage_armor` and NO armour stage at
       * all. A spell, a bolt and an effect are all reduced the same way, and
       * plate does nothing about any of them.
       *
       * ═══ AND OUR OWN DERIVATION SAYS THE SAME THING ═══
       * The wraith's 12-16 is derived in content/monsters.ts as 24.14% of an
       * upstream level-1 life bar mapped onto our median class bar of 60 — a
       * FRACTION OF A HEALTH BAR, with no armour term anywhere in it. The
       * armour stage was then quietly taking that back: against a Watchman
       * (armour 6, hardiness 40) a 16-point orb landed as 10, so the orb hit
       * for 14% of his bar where the derivation asked for about 24%.
       *
       * So removing it is not a buff invented here. It is what upstream does
       * AND what this game's own arithmetic already intended.
       */
      apr: proj.damage.apr,
      increase: proj.damage.increase,
      penetration: proj.damage.penetration,
      // FROZEN AT LAUNCH — the source here is a bare `{ id }`, so `applyDamage`
      // cannot read the shooter's sheet the way it does for every other path.
      sourceDazed: proj.damage.sourceDazed,
      sourceStunned: proj.damage.sourceStunned,
      sourceNumbed: proj.damage.sourceNumbed,
    },
  );

  // engine/actor.ts's `applyDamage` clears this on a killing blow and damage.ts's
  // does not, because damage.ts knows nothing about intents. A body that goes
  // down holding a pending intent would resolve it the moment an ally picks them
  // up, which is a turn nobody took.
  if (outcome.killed) foe.pendingIntent = null;

  return {
    targetId: foe.id,
    damage: outcome.dealt,
    killed: outcome.killed,
    type: outcome.type,
    // Read HERE, one line after the blow, and never again — `GameEvent.attacked`
    // has the Case Log transcript that produced that rule.
    hp: foe.hp,
    maxHp: foe.maxHp,
    at: { x: foe.x, y: foe.y },
  };
}

/**
 * ONE `act` CALL — Projectile.lua:210-230.
 *
 * ═══ THE `while` LOOP IS MANDATORY, NOT AN OPTIMISATION ═══
 * `grantEnergy` DISCARDS SURPLUS (energy.ts:253: nothing is added once the actor
 * is at or over the threshold), so an orb fast enough to be granted two turns'
 * worth in a single tick must spend BOTH inside one `act` call or its speed
 * silently halves. A `projSpeed` of 20 is granted 2000 per tick and must move
 * two tiles; ToME's own declared values run 2, 3, 4, 5, 6, 10, 15, 20. Writing
 * this as a single `if` type-checks, passes every test that ships today, and is
 * wrong — which is exactly why there is a test for it even though nothing in the
 * roster flies that fast.
 *
 * @returns what happened. The CALLER drops a landed orb from the world and turns
 * the impact into a sweep step; this function touches neither.
 */
export function stepProjectile(proj: Projectile, world: ProjectileWorld): ProjectileOutcome {
  let stop: ProjectileStop | null = null;
  let impact: ProjectileImpact | null = null;

  // Projectile.lua:213 — `while self:enoughEnergy() and not self.dead do`.
  while (canAct(proj) && !proj.landed) {
    // ═══════════════════════════════════════════════════════════════════════
    // SOMEBODY WALKED INTO IT — Projectile.lua:250-267 (`on_move`), DEVIATION 3
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `projectDoMove` only ever inspects the NEXT tile, so without this the orb
    // and a body walking down the line SWAP tiles with no collision test in
    // either direction — classic projectile tunneling, and it voids the shot at
    // exactly the distance the wraith fights at. Upstream cannot have that hole:
    // its orb occupies a grid in `Map.PROJECTILE` and the mover calls
    // `on_move`, which for a `stop_block` type runs `projectDoStop` on the orb's
    // OWN tile (:258-259). Ours is not in `world.actorAt` by design, so the test
    // moves here: one `actorAt` on the tile the orb is standing on, at the top
    // of every iteration, one act after the body arrived.
    //
    // ═══ THE `cursor > 1` GUARD IS THE WHOLE CORRECTNESS ARGUMENT ═══
    // `path[0]` IS the origin, i.e. the shooter's own tile, and the orb is born
    // standing on it (see `cursor`). Without the guard the very first act finds
    // the shooter under itself and every wraith detonates its own orb in its own
    // face. Past the first step the tile the orb stands on was proved empty by
    // `blockPath` before it moved there, so this can only ever fire for somebody
    // who arrived in between — which is precisely the case being closed.
    //
    // DRAW-FREE like everything else in this loop: `projectDoStop` omits
    // `damageRange` and `critChance`. See its header.
    if (proj.cursor > 1) {
      const here = currentTile(proj);
      const arrived = world.actorAt(here.x, here.y);
      if (arrived !== undefined) {
        stop = ProjectileStop.Actor;
        proj.landed = true;
        // Target.lua:501 — a body-stop radiates from the victim's own tile.
        proj.radiusAt = here;
        impact = projectDoStop(proj, world, here);
        continue;
      }
    }

    const move = projectDoMove(proj, world);

    // Projectile.lua:216 — `if x and y then self:move(x, y) end`. The energy is
    // spent INSIDE `move` (:142), so a stop that does not move costs nothing.
    if (move.to !== null) {
      const previous = proj.path[proj.cursor - 1] ?? proj.origin;
      proj.cursor += 1;
      spendForAction(proj);

      // Projectile.lua:220-229, kept whole. See `Projectile.radiusAt` — and
      // note this reads `move.hitRadius` rather than deriving it from
      // `stop === null`, because a BODY-stop radiates from the body's tile
      // (Target.lua:501) and only a WALL-stop steps back (:466).
      proj.radiusAt = move.hitRadius ? move.to : previous;
    }

    if (move.stop === null) continue;

    // Projectile.lua:219-230 — the stop branch. `projectDoStop` runs on the
    // orb's CURRENT tile, which is `move.to` when it moved onto what stopped it
    // and its existing tile when it did not.
    stop = move.stop;
    proj.landed = true;
    impact = projectDoStop(proj, world, move.to ?? currentTile(proj));
  }

  return { landed: proj.landed, stop, at: currentTile(proj), impact };
}

/**
 * Where the orb is standing. `path[cursor - 1]`, because `cursor` is the NEXT
 * tile; at birth that is `path[0]`, the origin, exactly as upstream places the
 * entity on `start_x, start_y` (ActorProject.lua:354, Zone.lua:757).
 */
export function currentTile(proj: Projectile): TileXY {
  return proj.path[proj.cursor - 1] ?? proj.origin;
}

/**
 * GAME TURNS until it lands if nothing gets in the way — what the wire's
 * `ProjectileView.turnsToImpact` carries.
 *
 * TURNS, NEVER MILLISECONDS (protocol.ts's `EffectView.turns` rule: mixing the
 * two is a factor-of-ten bug). Tiles left divided by tiles per turn, rounded UP,
 * because a partial turn is still a turn the player gets to act in.
 */
export function turnsToImpact(proj: Projectile): number {
  const tilesLeft = Math.max(0, proj.path.length - proj.cursor);
  if (proj.energyMod <= 0) return 0;
  return Math.ceil(tilesLeft / proj.energyMod);
}

/**
 * The tile it is aimed at — the last tile on the frozen line. Used by the wire
 * frame so a client can draw the orb's destination without re-deriving the path.
 */
export function aimTile(proj: Projectile): TileXY {
  return proj.path[proj.path.length - 1] ?? proj.origin;
}

/** The default an attack with no authored damage type deals. Combat.lua:396. */
export const DEFAULT_PROJECTILE_DAMAGE_TYPE = DamageType.Physical;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS ORB COMING AT ME? THE TEST THAT BREAKS A REST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from Player.lua:872-882, inside `spotHostiles`. Upstream stops a rest
 * for a PROJECTILE as well as for a monster, and ours only ever looked at
 * bodies — so a detective could sit and regenerate while a bolt crossed the
 * room at them, which is the exact moment resting is worst.
 *
 * ═══ AND IT IS NOT "IS THERE AN ORB IN SIGHT" — THAT IS THE TUNING ═══
 * Two terms, both from upstream, and together they mean "on my line, still
 * inbound":
 *
 *   dist_to_line  the PERPENDICULAR distance from the body to the orb's line of
 *                 flight, `< 1.0`. An orb crossing the far side of the room on
 *                 its way somewhere else does not interrupt anybody. Upstream's
 *                 own comment gives the reason it is a line test and not a tile
 *                 test: *"Bresenham is too so check if we're anywhere near the
 *                 mathematical line of flight"* — the drawn path is a staircase
 *                 and the real trajectory is not.
 *
 *   our_way       a DOT PRODUCT from the orb's current tile: is the body on the
 *                 same side as the target? An orb that has already passed you is
 *                 not a threat, and without this term every shot that ever flew
 *                 down your corridor would keep you standing.
 *
 * ═══ "TRUST OURSELVES BUT NOT OUR FRIENDS" ═══
 * Upstream's words, at :868. Your own shot never interrupts you; a TEAMMATE'S
 * does. That is not an oversight — a friend firing along your line is exactly
 * the situation a body should stand up for.
 */
export function orbOnMyLine(proj: Projectile, self: TileXY): boolean {
  // THE GEOMETRY IS `shared/flight.ts` NOW, because the CLIENT needs the same
  // answer to stop a walk and cannot import this file. Upstream stops both a
  // rest and a run by one rule (`spotHostiles` with `actors_only` false at
  // Player.lua:973 and :1131); having two copies of it here would have been the
  // fourth duplicated rule in as many days.
  //
  // The origin is passed because that is what the Lua divides by. The client
  // passes the orb's CURRENT tile, which lies on the same line and so names the
  // same perpendicular distance — see `onFlightPath`.
  return onFlightPath(proj.origin, aimTile(proj), currentTile(proj), self);
}
