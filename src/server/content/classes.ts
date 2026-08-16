// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// NUMBERS: Outer Index content/enemies/{city_watchman,rogue_inspector}.json —
//          the ONLY three source entities with max_ap / max_mp / initiative /
//          resists, and therefore the calibration anchors (6/3/9 and 6/4/12)
//          Outer Index content/characters/{the_watchman,the_detective}.json —
//          the HP ratio (110 / 100) and the class silhouettes
//          t-engine4 game/modules/tome/load.lua:182-189 — primary stat defaults
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              THE THREE MVP CLASSES — FIXED LOADOUTS, NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ZERO trees. ZERO talent points. ZERO levelling. Four talents each, chosen
 * here and never edited (PLAN.md § 5's hard cap: *MVP 3 classes / 12 talents /
 * 0 trees / 0 points; v1.0 ceiling 4 / 32 / 8 / per-level*). M6 owns
 * progression, and the shape of this file is what makes that a change rather
 * than a rewrite: `loadout` becomes mutable and gains a `points` sibling, and
 * nothing else here moves.
 *
 * Below ~15 talents per class the build-crafting evaporates — but you do not
 * GET build-crafting at MVP, because there are no talent points. You get four
 * buttons that each do something distinct, which is what the first four
 * sessions actually need (tome-port.md § 5).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT EACH SLOT IS FOR (game-design.md § 2)
 * ───────────────────────────────────────────────────────────────────────────
 * Every class gets the same four roles, so the hotbar reads the same way for
 * everyone and nobody has to learn three layouts:
 *
 *   1  reliable    at-will, cheap, gated by AP alone
 *   2  signature   the class fantasy in one button
 *   3  defensive / mobility / control
 *   4  ALLY UTILITY — *"that last slot is what makes this co-op rather than
 *      four solo games."*
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE COMBAT CURVE, THREE WEAPONS
 * ───────────────────────────────────────────────────────────────────────────
 * All three classes deal damage through `combatDamage` (derived.ts), and their
 * identity lives in the WEAPON's `damMod` and the talent's damage TYPE — the
 * Watchman's truncheon converts Strength, the revolver converts Dexterity, the
 * gauntlet converts Magic and Cunning. No class has its own damage formula,
 * because a second formula is a second thing to balance and a second place for
 * a rounding difference to hide.
 *
 * The resulting level-1 swings, hand-traceable against derived.test.ts's
 * vectors: Watchman ~12, Inspector ~11.5 (x0.9 = ~10, x1.65 = ~19),
 * Alchemist ~9.7 (x1.3 = ~13). Against 24-HP M2 monsters that is two to three
 * hits, which is the fight length the barrier is most exercised by.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SPRITES ARE ALREADY ON DISK
 * ───────────────────────────────────────────────────────────────────────────
 * `chr_player_{watchman,inspector,alchemist}_s.png`, plus a `_downed_s` variant
 * for each — verified present under client/public/assets/characters/. These are
 * asset KEYS, never paths; the client owns the manifest.
 *
 * PURE DATA + ONE REGISTRAR + THE TWO SEAMS THAT NEED BOTH. No I/O, no clock,
 * no randomness. This file is the only thing that imports all twelve talent
 * modules, which is what keeps `engine/talents.ts` from importing them and
 * turning the module graph into a cycle.
 *
 * The two seams are `classForJoin` (which class a joining body gets — the one
 * place that decision is made) and `createTalentBook` (the read-only submission
 * gate the turn adapter validates against). Both live here for the same reason
 * the registrar does: they need the class definitions AND the engine, and this
 * is the only layer allowed to see both.
 */

import { MELEE_REACH } from '../engine/combat.ts';
import { DamageType } from '../engine/damage.ts';
import {
  ClassId,
  RESOURCE_RULES,
  ResourceKind,
  TalentRefusal,
  canUseTalent,
  createTalentEngine,
  createTalentRegistry,
  createTalentSheet,
} from '../engine/talents.ts';
import { alchemicVial } from '../talents/alchemic_vial.ts';
import { ashwickFlare } from '../talents/ashwick_flare.ts';
import { backdraft } from '../talents/backdraft.ts';
import { crudeBlow } from '../talents/crude_blow.ts';
import { fogStep } from '../talents/fog_step.ts';
import { ironCurtain } from '../talents/iron_curtain.ts';
import { lockdown } from '../talents/lockdown.ts';
import { mendWounds } from '../talents/mend_wounds.ts';
import { revolverShot, INSPECTOR_MIN_RANGE } from '../talents/revolver_shot.ts';
import { sigil } from '../talents/sigil.ts';
import { snipersMark } from '../talents/sniper_mark.ts';
import { wardRush } from '../talents/ward_rush.ts';
import { ErrorCode } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { LoadoutTalent, ResourceView } from '../../shared/protocol.ts';
import type { CombatSheet } from '../engine/combat.ts';
import type { Talent, TalentEngine, TalentRegistry, TalentSheet } from '../engine/talents.ts';
import type { Actor, World } from '../world/world.ts';

/**
 * The 6-AP / 3-MP round, from `city_watchman.json`'s `max_ap: 6` / `max_mp: 3`
 * (game-design.md § 6). Move = 1 MP; talents cost their authored `ap_cost`.
 *
 * The Inspector gets the fourth MP that `rogue_inspector.json` authors — it is
 * the calibration anchor for a ranged body, and a class that cannot shoot
 * inside three tiles needs one more step of legwork than everyone else.
 */
const BASE_MAX_AP = 6;
const BASE_MAX_MP = 3;
const INSPECTOR_MAX_MP = 4;

export type ClassDef = {
  readonly id: ClassId;
  readonly name: string;
  readonly description: string;
  /** An asset KEY, never a path. Present on disk; see the file header. */
  readonly sprite: string;
  /** Shown while Downed (game-design.md § 9). Also present on disk. */
  readonly downedSprite: string;
  readonly maxHp: number;
  /** Per GAME TURN, on the base clock. Deliberately small: this is not a heal. */
  readonly hpRegen: number;
  readonly resource: ResourceKind;
  readonly maxAp: number;
  readonly maxMp: number;
  /** Stats, gear-equivalent mods and the class weapon. Fed to derived.ts. */
  readonly combat: CombatSheet;
  /** EXACTLY FOUR, in hotbar order: reliable, signature, defensive, ally. */
  readonly loadout: readonly Talent[];
};

// ---------------------------------------------------------------------------
// The Watchman — melee anchor · Resolve
// ---------------------------------------------------------------------------

/**
 * The most Strength, the most armour, the most HP, and the only class whose
 * resource is earned by standing next to people.
 *
 * `armourHardiness: +10` puts him at 40% rather than ToME's base 30
 * (Combat.lua:1336), so his armour bites into a larger slice of every blow —
 * which is the difference between a body with armour and a body that is armour.
 */
export const WATCHMAN: ClassDef = {
  id: ClassId.Watchman,
  name: 'The Watchman',
  description:
    'A serving constable on a long beat. Shield strapped tight, helmet low. ' +
    'Walks into the swarm so the people behind him do not have to.',
  sprite: 'chr_player_watchman_s',
  downedSprite: 'chr_player_watchman_downed_s',
  maxHp: 72,
  hpRegen: 0.5,
  resource: ResourceKind.Resolve,
  maxAp: BASE_MAX_AP,
  maxMp: BASE_MAX_MP,
  combat: {
    stats: { str: 24, dex: 14, con: 20, cun: 12, wil: 14, mag: 10 },
    mods: { armour: 6, armourHardiness: 10, def: 3 },
    weapon: {
      // A truncheon. `damMod` is ToME's default `{ str = 0.6 }` (Combat.lua:1625).
      dam: 20,
      physCrit: 2,
      damRange: 1.1,
      damMod: { str: 0.6 },
    },
    /**
     * ═══ MELEE_REACH, NOT 1, AND THE ARITHMETIC IS THE WHOLE REASON ═══
     *
     * `CombatSheet.range` is a EUCLIDEAN radius — `canAttack` measures with
     * `combatDistance`, which is `core.fov.distance` (engine/combat.ts). The
     * four diagonal neighbours sit at √2 = 1.4142…, so a reach of exactly 1
     * REFUSES ALL FOUR DIAGONALS: the Watchman standing corner-to-corner with a
     * husk passes the scheduler's legality check and then quietly does nothing.
     * 1.5 is the only round number between √2 and the nearest non-neighbour at
     * 2.0, which is what makes a circle of that radius exactly the eight tiles
     * around you.
     *
     * Imported rather than written as 1.5 here, because a second literal is a
     * second definition of what melee means — see the constant's own note.
     */
    range: MELEE_REACH,
    minRange: 0,
    damageType: DamageType.Physical,
  },
  loadout: [crudeBlow, wardRush, ironCurtain, lockdown],
};

// ---------------------------------------------------------------------------
// The Inspector — ranged precision · Focus
// ---------------------------------------------------------------------------

/**
 * ═══ `minRange: 3` IS ON THE SHEET, NOT ONLY ON THE TALENTS ═══
 *
 * game-design.md § 2: *"`min_range 3` is the single most important number here:
 * the Inspector **cannot shoot adjacent**."* Putting it on the combat sheet
 * means `canAttack` (combat.ts) refuses a basic bump-attack from inside the
 * hole with `AttackRefusal.MinRange` — a distinct refusal, never a miss — and
 * the three gun talents carry the same 3 independently. Both layers, because
 * the dead zone being invisible is the failure mode game-design.md warns about
 * by name: *"if the dead zone is invisible the class reads as broken."*
 *
 * `apr: 3` is what a bullet is: armour matters less against it than against a
 * truncheon, and armour penetration is SUBTRACTIVE against armour (damage.ts
 * step 2) rather than multiplicative like resistance penetration.
 */
export const INSPECTOR: ClassDef = {
  id: ClassId.Inspector,
  name: 'The Inspector',
  description:
    'A disgraced detective who treats Alderbrook itself as the case eating his mind. ' +
    'Lethal at range and helpless in a doorway.',
  sprite: 'chr_player_inspector_s',
  downedSprite: 'chr_player_inspector_downed_s',
  maxHp: 60,
  hpRegen: 0.5,
  resource: ResourceKind.Focus,
  maxAp: BASE_MAX_AP,
  maxMp: INSPECTOR_MAX_MP,
  combat: {
    stats: { dex: 24, cun: 20, str: 12, con: 12, wil: 12, mag: 10 },
    mods: { atk: 4, physCrit: 4, apr: 3 },
    weapon: {
      // A constable revolver. Bow-shaped `dammod` (Dex-led, Str-assisted), the
      // ToME convention for anything fired rather than swung.
      dam: 18,
      atk: 0,
      apr: 3,
      physCrit: 3,
      damRange: 1.2,
      damMod: { dex: 0.7, str: 0.3 },
    },
    range: 5,
    minRange: INSPECTOR_MIN_RANGE,
    damageType: DamageType.Physical,
  },
  loadout: [revolverShot, snipersMark, fogStep, sigil],
};

// ---------------------------------------------------------------------------
// The Alchemist of Ashwick Row — AoE and the only healer · Reagents
// ---------------------------------------------------------------------------

/**
 * The squishiest body, the only AoE, and the only heal in the game.
 *
 * Reagents are a COUNTABLE STOCK of 0-8 that refills on kills and at stairs and
 * NEVER regenerates (`RESOURCE_RULES` in engine/talents.ts encodes that as
 * `regenPerTurn: 0`, in one place, so it cannot quietly become a bar). Starting
 * full is deliberate: you walked in carrying eight vials, and the first fight
 * should be about spending them rather than about waiting for them.
 *
 * `increase: { fire: 10 }` is the Ashwick specialisation — an ADDITIVE
 * percentage inside the projector (damage_types.lua:270), which is why it is
 * `+10%` flat and not a multiplier that would compound with the talent's own.
 */
export const ALCHEMIST: ClassDef = {
  id: ClassId.Alchemist,
  name: 'The Alchemist of Ashwick Row',
  description:
    'Trained on the Row, where the apothecaries mix something different every week. ' +
    'Carries eight vials and a field kit, and counts both.',
  sprite: 'chr_player_alchemist_s',
  downedSprite: 'chr_player_alchemist_downed_s',
  maxHp: 54,
  hpRegen: 0.5,
  resource: ResourceKind.Reagents,
  maxAp: BASE_MAX_AP,
  maxMp: BASE_MAX_MP,
  combat: {
    stats: { mag: 22, cun: 18, wil: 14, con: 12, str: 10, dex: 12 },
    mods: { spellPower: 4 },
    weapon: {
      // A reagent gauntlet. The `damMod` is where the class identity lives: it
      // is the same `combatDamage` curve as everyone else, fed by Magic.
      dam: 16,
      damRange: 1.15,
      damMod: { mag: 0.5, cun: 0.3 },
    },
    increase: { fire: 10 },
    range: 5,
    minRange: 0,
    damageType: DamageType.Fire,
  },
  loadout: [ashwickFlare, alchemicVial, backdraft, mendWounds],
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The three, in the order the art was cut and the order the picker shows them. */
export const CLASSES: readonly ClassDef[] = [WATCHMAN, INSPECTOR, ALCHEMIST];

/**
 * KEYED BY `string`, NOT BY `ClassId`, AND THAT IS THE POINT OF THE LOOKUP.
 *
 * Every id that reaches `classById` came off a DISK: `CharacterFile.classId` is
 * a SOFT reference (persist/saves.ts) precisely so that a save written before a
 * class was renamed — or by a build that had a fourth class — still parses. A
 * map that could only be asked about ids this build already has would need the
 * caller to narrow first, and the only way to narrow is to ask.
 */
const BY_ID: ReadonlyMap<string, ClassDef> = new Map(
  CLASSES.map((definition) => [definition.id as string, definition]),
);

/** The class with this id, or undefined for one this build no longer has. */
export function classById(id: string | null | undefined): ClassDef | undefined {
  return id === null || id === undefined ? undefined : BY_ID.get(id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH CLASS A JOINING BODY GETS. THE DECISION, IN EXACTLY ONE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE FILE WINS, ROTATION IS THE FALLBACK. `actorIdForUser` is a stable hash of
 * the Discord snowflake (net/gateway.ts), so the same person returning tomorrow
 * IS the same actor id — and a rotation counter is per-PROCESS and never
 * decremented, so rotation alone would make somebody a different class every
 * evening. Their character file is the only thing that remembers.
 *
 * A DANGLING id SUBSTITUTES RATHER THAN THROWS. `classById` answers undefined
 * for a class this build no longer has, which is exactly the substitute-and-log
 * path persist/saves.ts describes for a soft reference. The caller logs it; a
 * player whose file names a deleted class gets a playable body rather than a
 * refused connection.
 *
 * ROTATION RATHER THAN A FIXED DEFAULT, because three friends joining on the
 * first evening the feature exists must not all be handed the same four
 * buttons. There is no chooser yet — that is the next job — and this is the
 * one line it replaces.
 */
export function classForJoin(savedClassId: string | null, rotation: number): ClassDef {
  const saved = classById(savedClassId);
  if (saved !== undefined) return saved;
  // `CLASSES` is non-empty by construction (the arity check at the foot of this
  // file throws at import time otherwise), but the index still needs a value
  // under noUncheckedIndexedAccess and `!` is banned project-wide.
  return CLASSES[((rotation % CLASSES.length) + CLASSES.length) % CLASSES.length] ?? WATCHMAN;
}

/**
 * Register all twelve talents.
 *
 * A duplicate id THROWS inside `createTalentRegistry`, which is what turns
 * "two classes accidentally share a talent id" into a startup crash rather than
 * into one class silently getting the other's button.
 */
export function registerAllTalents(): TalentRegistry {
  const registry = createTalentRegistry();
  for (const definition of CLASSES) {
    for (const talent of definition.loadout) registry.register(talent);
  }
  return registry;
}

/** A talent engine with every MVP talent already in it. The normal entry point. */
export function createContentTalentEngine(): TalentEngine {
  return createTalentEngine(registerAllTalents());
}

/**
 * The per-actor sheet for a class: the fixed loadout, an empty (or full)
 * resource pool, and the AP/MP budget.
 *
 * The caller attaches it: `engine.attach(actor.id, sheetForClass(WATCHMAN))`.
 * That is the one line character creation needs, and there is nothing else to
 * choose — which is the entire point of MVP loadouts being fixed.
 */
export function sheetForClass(definition: ClassDef): TalentSheet {
  return createTalentSheet({
    classId: definition.id,
    loadout: definition.loadout.map((talent) => talent.id),
    resource: definition.resource,
    maxAp: definition.maxAp,
    maxMp: definition.maxMp,
  });
}

// ---------------------------------------------------------------------------
// The wire bridge — engine shapes into view shapes, in one place
// ---------------------------------------------------------------------------

/**
 * A talent as the HOTBAR sees it — src/shared/protocol.ts's `LoadoutTalent`.
 *
 * view/projector.ts takes these pre-shaped (`projectLoadout(viewer, talents)`),
 * which is the right split: the projector decides what a client is ALLOWED to
 * see, and this decides how a server-side talent maps onto that. Both halves
 * exist so nothing between the registry and the wire has to know both.
 *
 * WHAT DELIBERATELY DOES NOT CROSS: `onUse`, `describe`, the damage type, the
 * affinity, and every number the tooltip would need to recompute. eslint blocks
 * src/client/** from importing the combat formulas at all, and every displayed
 * number is computed server-side — a second copy in the browser always
 * diverges, and the divergence shows up as a monster that was already dead.
 *
 * `radius` defaults to 0 rather than being optional, because the wire type
 * declares it required so the renderer never writes `?? 0` at four call sites.
 */
export function toLoadoutView(talent: Talent): LoadoutTalent {
  return {
    // Already `talent:<id>` — the registry key IS the wire id, so the cooldown
    // map `projectCooldowns` sends verbatim matches these buttons by string.
    id: talent.id,
    name: talent.name,
    icon: talent.iconId,
    cost: {
      ap: talent.cost.ap ?? 0,
      mp: talent.cost.mp ?? 0,
      resource: talent.cost.resource ?? 0,
    },
    cooldownTurns: talent.cooldownTurns,
    range: talent.targeting.range,
    minRange: talent.targeting.minRange,
    // `TargetShape` and `TalentShape` are member-for-member identical by rule
    // (protocol.ts says so out loud). Two declarations because src/shared/ may
    // not reach into src/server/; the string values make them interchangeable.
    shape: talent.targeting.shape,
    radius: talent.targeting.radius ?? 0,
  };
}

/** The four buttons, in hotbar order. Slot 1 is `[0]`; the client must not sort. */
export function loadoutViewFor(definition: ClassDef): readonly LoadoutTalent[] {
  return definition.loadout.map(toLoadoutView);
}

/**
 * A resource pool as the pip strip sees it.
 *
 * `discrete` is on the wire rather than derived from `kind` in the renderer,
 * because "which kinds are countable" is authored data and a client-side copy
 * of it is exactly the table that will be missing the Enforcer's Shells at M5.
 * It is read from `RESOURCE_RULES` — the same table that pins Reagents at
 * `regenPerTurn: 0` — so a resource cannot be a bar in one place and pips in
 * another.
 */
export function toResourceView(sheet: TalentSheet): ResourceView {
  return {
    kind: sheet.resource.kind,
    current: sheet.resource.value,
    max: sheet.resource.max,
    discrete: RESOURCE_RULES[sheet.resource.kind].discrete,
  };
}

// ---------------------------------------------------------------------------
// THE TALENT BOOK — what the SUBMISSION GATE is allowed to ask
// ---------------------------------------------------------------------------

/**
 * The refusal codes a talent submission may answer with.
 *
 * WRITTEN OUT RATHER THAN IMPORTED, and the duplication is deliberate: this is
 * the same `Extract` net/gateway.ts declares as `TalentRefusal`, so the two
 * unions are the identical type and the compiler proves they meet — but
 * `src/server/content/**` importing `net/**` would be a runtime edge pointing
 * the wrong way through the module graph.
 */
type RefusalCode = Extract<
  ErrorCode,
  | 'bad_message'
  | 'not_your_turn'
  | 'illegal_move'
  | 'out_of_range'
  | 'too_close'
  | 'on_cooldown'
  | 'no_resource'
  | 'no_los'
>;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ENGINE'S REFUSAL VOCABULARY -> THE CLIENT'S. FIFTEEN INTO EIGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TalentRefusal` (engine/talents.ts) is about the RULE that said no;
 * `ErrorCode` is about what the player is supposed to DO about it. The
 * collapsing is where the meaning is:
 *
 *   TOO_CLOSE IS NEVER OUT_OF_RANGE. The two carry OPPOSITE instructions — one
 *   says close in, the other says back away — and turn-engine.ts:317 calls
 *   mislabelling them the documented way a positional class reads as broken.
 *   The ordered check that produces the two is turn-engine.ts:1128 and the
 *   emit sites are :1218 and :1228; the range cited here used to point at
 *   `reap`'s doc block, which is about orbs in flight.
 *   game-design.md § 2 makes `min_range 3` the single most important number in
 *   the Inspector; this row is what keeps it legible.
 *
 *   THE THREE BUDGETS COLLAPSE. `no_ap`, `no_mp` and `no_resource` are one
 *   sentence to a player: you cannot pay for that yet. AP and MP are
 *   deliberately not on the wire (they are structurally incapable of being
 *   short — see test/server/talent-resolution.ts's AP-cap guard), so a distinct
 *   code would name a bar the client cannot draw.
 *
 *   "YOU DO NOT HAVE THAT TALENT" IS A BAD FRAME, NOT A GAME RULE. M3 loadouts
 *   are FIXED, so a frame naming a talent that is not in your four — or one no
 *   registry has ever heard of — was hand-crafted rather than clicked.
 *
 *   `dead` IS `not_your_turn`. "Not now", not "not there": the body is a corpse
 *   or on the floor, and no amount of re-aiming will help.
 *
 *   THE FIVE TARGETING REFUSALS ARE ALL `illegal_move`. Blocked terrain, an
 *   empty tile, yourself, an ally under a hostile talent, a hostile under an
 *   ally talent — every one of them means "not at THAT", which is the one thing
 *   a targeting UI can act on by asking for another tile.
 */
const REFUSAL_TO_CODE: Readonly<Record<TalentRefusal, RefusalCode>> = {
  [TalentRefusal.MinRange]: ErrorCode.TooClose,
  [TalentRefusal.OutOfRange]: ErrorCode.OutOfRange,
  [TalentRefusal.NoLineOfSight]: ErrorCode.NoLos,
  [TalentRefusal.OnCooldown]: ErrorCode.OnCooldown,
  [TalentRefusal.NoAp]: ErrorCode.NoResource,
  [TalentRefusal.NoMp]: ErrorCode.NoResource,
  [TalentRefusal.NoResource]: ErrorCode.NoResource,
  [TalentRefusal.NotLearned]: ErrorCode.BadMessage,
  [TalentRefusal.UnknownTalent]: ErrorCode.BadMessage,
  [TalentRefusal.Dead]: ErrorCode.NotYourTurn,
  [TalentRefusal.Blocked]: ErrorCode.IllegalMove,
  [TalentRefusal.NoTarget]: ErrorCode.IllegalMove,
  [TalentRefusal.Self]: ErrorCode.IllegalMove,
  [TalentRefusal.NotHostile]: ErrorCode.IllegalMove,
  [TalentRefusal.NotAlly]: ErrorCode.IllegalMove,
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOTBAR, THE RESOURCE AND THE LEGALITY CHECK, AS THE ADAPTER SEES THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * STRUCTURAL, NOT NOMINAL. The return value satisfies `TalentBook`
 * (src/server/turn-engine.ts) by SHAPE, which is the same trick that file plays
 * with the gateway's `TurnEngine`: the adapter declares the contract, this file
 * meets it, and neither imports the other. `createTurnEngine({ talents: … })`
 * type-checks against it at the one call site that has both — src/server/main.ts.
 *
 * ═══ THE SHEET IS AUTHORITATIVE, NOT THE `ClassDef` ═══
 * `loadoutOf` maps `sheet.loadout` (the per-ACTOR ids) through the registry
 * rather than reading `definition.loadout`. The two are the same four talents
 * today and would stop being so the moment anything ever edits a sheet — and on
 * that day the hotbar has to show what this body can actually use, not what its
 * class was authored with. It is also what makes an actor with no sheet answer
 * an empty hotbar rather than one belonging to a class it does not have.
 *
 * ═══ SUPPLYING `check` MAKES THE CATALOGUE FALLBACK DEAD CODE IN PRODUCTION ═══
 * ...BY DESIGN, and turn-engine.ts:1171 says so out loud — "this branch is the
 * catalogue-only fallback; running both would be two…", with the port doc at
 * turn-engine.ts:108-109: when the real
 * checker is wired in it wins outright, because running both would be two
 * implementations of one rule and the second is always the one that is wrong
 * about a corner tile. The fallback must NOT be deleted — turn-engine.test.ts
 * still covers it through a book with no `check`, which is exactly the shape a
 * server with a hand-written two-talent book has.
 *
 * IT IS READ-ONLY. Nothing here spends AP, a resource or a cooldown: an intent
 * that goes illegal between submission and resolution must cost ZERO (the
 * refund rule, docs/architecture.md § 2), so the deduction happens at
 * RESOLUTION and `canUseTalent` is a pure predicate over the world.
 */
export function createTalentBook(
  engine: TalentEngine,
  world: World,
): {
  loadoutOf(actor: Actor): readonly LoadoutTalent[];
  resourceOf(actor: Actor): ResourceView | undefined;
  check(actor: Actor, talentId: string, target: TileXY | undefined): RefusalCode | null;
} {
  return {
    loadoutOf: (actor: Actor): readonly LoadoutTalent[] => {
      const sheet = engine.sheetOf(actor.id);
      if (sheet === undefined) return [];
      const out: LoadoutTalent[] = [];
      for (const id of sheet.loadout) {
        const talent = engine.registry.get(id);
        // A sheet naming a talent this registry does not have is a content bug,
        // not a reason to refuse the other three buttons. It cannot be USED
        // either — `canUseTalent` answers `unknown_talent` — so dropping it here
        // keeps the hotbar and the rule agreeing.
        if (talent !== undefined) out.push(toLoadoutView(talent));
      }
      return out;
    },

    resourceOf: (actor: Actor): ResourceView | undefined => {
      const sheet = engine.sheetOf(actor.id);
      return sheet === undefined ? undefined : toResourceView(sheet);
    },

    check: (actor: Actor, id: string, target: TileXY | undefined): RefusalCode | null => {
      const talent = engine.registry.get(id);
      if (talent === undefined) return ErrorCode.BadMessage;

      // A `self` shape has no target tile, and `checkTargeting` returns before
      // it reads one — but the argument is not optional, and the caster's own
      // tile is the honest origin rather than a sentinel.
      const at = target ?? { x: actor.x, y: actor.y };
      // WHO IS STANDING THERE, resolved HERE rather than carried on the wire:
      // the client sends a TILE (that is what an AoE needs and what the player
      // clicked), and `Affinity` is checked against whatever body is on it.
      const standing = world.actorAt(at.x, at.y);
      const refusal = canUseTalent(
        engine,
        actor,
        talent,
        { x: at.x, y: at.y, ...(standing === undefined ? {} : { actorId: standing.id }) },
        world,
      );
      return refusal === null ? null : REFUSAL_TO_CODE[refusal];
    },
  };
}

/**
 * Compile-time proof that every class ships EXACTLY four talents.
 *
 * PLAN.md's cap is 12 talents / 4 per class / 0 trees / 0 points. A fifth
 * button added "just for this one idea" is how a 12-talent MVP becomes a
 * 40-talent one over three weekends, so the cap is enforced by the type system
 * rather than by remembering it. Widening this line is a deliberate act with a
 * diff, which is exactly what it should be.
 */
const TALENTS_PER_CLASS = 4;
type FourTalents = readonly [Talent, Talent, Talent, Talent];
const _loadoutArityCheck: readonly FourTalents[] = CLASSES.map((definition) => {
  const [a, b, c, d] = definition.loadout;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error(`classes: ${definition.id} needs ${TALENTS_PER_CLASS} talents`);
  }
  if (definition.loadout.length !== TALENTS_PER_CLASS) {
    throw new Error(`classes: ${definition.id} has ${definition.loadout.length} talents`);
  }
  return [a, b, c, d];
});
