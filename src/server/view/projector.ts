/**
 * The projection layer: the one place where the server's world becomes something
 * a client is allowed to see.
 *
 * WHY THIS FILE EXISTS AT ALL IN M1, WHEN IT COPIES SIX FIELDS.
 *
 * It is the seam for fog of war, and a seam has to be in place BEFORE the thing
 * it separates arrives — retrofitting FOV means auditing every `send` in the
 * gateway instead of editing two functions here. eslint.config.js already names
 * this file as the sole producer of the future `Projected` brand for the same
 * reason.
 *
 * WHAT IS STILL UNFILTERED, AND IT IS NO LONGER TRUE THAT NOTHING IS HIDDEN.
 *
 * `projectLevel` returns the WHOLE 30x30 map and `projectActors` returns EVERY
 * actor, unfiltered. That was a deliberate M1 shortcut when M1's definition of
 * done was two people seeing each other move on a hand-authored map.
 *
 * THIS PARAGRAPH USED TO END "there is no hidden information in the game yet —
 * no monsters, no traps, no loot". ALL THREE CLAUSES ARE NOW FALSE. There are
 * monsters (content/monsters.ts), there are orbs in the air
 * (`projectProjectiles`), and from v10 there are ITEMS ON THE FLOOR
 * (`projectGroundItems` below). Every one of the three is broadcast to the whole
 * room today, and that is an ACCEPTED LEAK rather than a gate: fog of war is
 * still level-wide — one `LevelView`, one actor list for everybody
 * (game-design.md § 12 makes per-player FOV an M6 refinement) — so a floor item
 * leaks nothing `projectActors` does not already leak. It is written down as a
 * leak rather than dressed up as a filter, because an unowned pile IS hidden
 * information the moment FOV lands: a coat lying in an unexplored room says
 * something died in it.
 *
 * Sending the whole level is also the correct long-term answer for the TERRAIN
 * of an already-explored floor; it is the ACTORS on it — and the orbs, and the
 * loot — that must be filtered, and that is why they are separate functions
 * below.
 *
 * WHEN FOV LANDS (M3) both functions take the viewing `Actor` as a second
 * parameter and `projectActors` becomes
 *
 *   world.allActors().filter((a) => a.id === viewer.id || visible(viewer, a))
 *
 * with `visible` built on the shadowcaster and `bresenham` from coords.ts.
 * Nothing outside this file changes. The event log will need the same treatment
 * and it leaks visibility more often than the tile grid does — "you hear a door
 * open" is a position.
 *
 * SYNCHRONOUS: src/server/view/** carries the engine's no-async lint block.
 */

import {
  ActorKind,
  ActorRank,
  MONSTERS_TURN_ID,
  TurnActorKind,
  TurnActorState,
  VoiceState,
} from '../../shared/protocol.ts';
import { TalentEffect } from '../engine/talents.ts';
import { Faction } from '../engine/actor.ts';
import { PROTOCOL_VERSION } from '../../shared/version.ts';
import { CLASSES, loadoutViewFor, sheetForClass, toResourceView } from '../content/classes.ts';
import { SLOT_ORDER } from '../content/items.ts';
import { isMoneyId } from '../content/money.ts';
import { buyPrice, sellPrice } from '../content/shops.ts';
import { resolveItem } from '../content/resolve.ts';
import {
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatDamage,
  combatDamageRange,
  combatDefense,
  combatMentalResist,
  combatPhysicalResist,
  combatSpellResist,
  stat,
} from '../engine/derived.ts';
import { downedView } from '../engine/downed.ts';
import { EffectStatus, effectDef, effectsOn } from '../engine/effects.ts';
import { composeSheet, wornOf } from '../engine/equipment.ts';
import { aimTile, currentTile, turnsToImpact } from '../engine/projectile.ts';
import type {
  ActorEffects,
  ActorView,
  CarriedItemView,
  ClassOptionView,
  ClassOptionsMsg,
  CooldownsMsg,
  EffectView,
  EffectsMsg,
  GroundItemView,
  GroundMsg,
  ShopItemView,
  ShopMsg,
  InspectRow,
  InventoryMsg,
  ItemView,
  LevelView,
  LoadoutMsg,
  LoadoutTalent,
  PartyInviteView,
  PartyMember,
  PartyMsg,
  PartyStateMember,
  PartyStateMsg,
  ProjectileView,
  ProjectilesMsg,
  ResourceMsg,
  ResourceView,
  TurnActor,
  TurnMsg,
} from '../../shared/protocol.ts';
import type { ClassDef } from '../content/classes.ts';
import type { Item, Slot } from '../content/items.ts';
import type { Combatant, PrimaryStats } from '../engine/derived.ts';
import type { DownedState } from '../engine/downed.ts';
import type { EffectState } from '../engine/effects.ts';
import type { CombatSheet } from '../engine/combat.ts';
import type { Actor, World } from '../world/world.ts';

/**
 * Nobody is speaking. A frozen shared instance rather than a fresh `new Set()`
 * per call, because `projectParty` runs once per pump per party and the empty
 * case is the common one.
 */
const EMPTY_SPEAKING: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// DISPLAY NAMES — M5. What a player is CALLED, versus who they ARE
// ---------------------------------------------------------------------------

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * A DISCORD ID NEVER LEAVES THIS PROCESS. A NAME AND AN ACTOR ID DO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From M5 a player's name is their Discord global name and their actor id is
 * derived from their Discord snowflake. Two things follow and both are enforced
 * before this file is reached, which is why they are written down here — this is
 * the last function every one of those strings passes through on its way to four
 * other people's screens.
 *
 *   THE ID ON THE WIRE IS NOT THE SNOWFLAKE. `actorIdForUser` in
 *   src/server/net/gateway.ts is the one producer of a verified player's actor
 *   id and it hashes: `actor_u_<16 hex>`. Nothing downstream has to remember to
 *   strip anything, because there is nothing here to strip. CLAUDE.md
 *   non-negotiable 7 — the repo is public and `data/` holds real people's
 *   Discord ids — is satisfied by the snowflake never entering the wire, a log
 *   line or a client's memory in the first place. A friend's account id is their
 *   personal data and the party does not need it to draw a token: an actor id
 *   and a name are enough, which is exactly what `ActorView` carries.
 *
 *   THE NAME IS HOSTILE INPUT. docs/discord-activity.md § 5 quotes Discord's own
 *   rule — "data coming from the Discord client is not sanitized beforehand" — so
 *   a global name is arbitrary text chosen by a person who may be curious about
 *   what happens if it contains a control character. `safeDisplayName` in
 *   http/auth.ts already strips the deceptive ones and caps the length; this is
 *   the second, unconditional layer, and it covers the names this file projects
 *   that never came from Discord at all (a `Player 3`, a monster loaded from
 *   content, a name repaired out of a corrupt save).
 */

/** Long enough for any real name, short enough to fit a party row. */
const DISPLAY_NAME_MAX = 32;

/** Substituted for a name that is empty once the unprintable parts are gone. */
const NAMELESS = 'Detective';

/**
 * One name, safe to draw.
 *
 * WHAT IT REMOVES: C0 and C1 controls (a newline in a name breaks the Case Log's
 * line model; a `\r` rewrites the line a player was reading) and the Unicode
 * bidi overrides, which are the ones that let a name reorder the text AROUND it
 * — a party row that renders as somebody else's is not a cosmetic problem.
 *
 * WHAT IT DOES NOT DO IS ESCAPE ANYTHING, because there is no markup context to
 * escape into: the client draws names with `fillText` and mirrors them with
 * `textContent`, and eslint.config.js § group 6 makes `innerHTML` an error in
 * src/client/. Escaping here would put `&amp;` in somebody's name on a canvas.
 *
 * A CODE-POINT LOOP RATHER THAN A REGEX, for two reasons: `no-control-regex`
 * (correctly) bans the literal that would express the first half, and slicing a
 * string at 32 UTF-16 units can cut an emoji in half and leave a lone surrogate
 * — which is the one thing that reliably breaks a JSON round-trip.
 */
export function toDisplayName(raw: string): string {
  let out = '';
  let count = 0;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // LRO / RLO / PDF / LRI / RLI / FSI / PDI — the reordering controls.
    if (code === 0x202d || code === 0x202e || code === 0x202c) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += ch;
    count += 1;
    if (count >= DISPLAY_NAME_MAX) break;
  }
  const trimmed = out.trim();
  return trimmed === '' ? NAMELESS : trimmed;
}

/** A whole-world snapshot, shaped for `WelcomeMsg`. */
export type WorldView = {
  level: LevelView;
  actors: ActorView[];
};

/**
 * The barrier, as the scheduler holds it — one step before the wire.
 *
 * WHY IT IS DECLARED HERE, IN view/, AND NOT IN engine/.
 *
 * Two modules need to name this shape: the scheduler that produces it and the
 * gateway that ships it. They may not import each other — eslint.config.js bans
 * `engine/** -> net/**` outright, and view/ is downstream of engine/ and
 * upstream of net/, so this is the one directory both can legally reach. The
 * scheduler therefore satisfies it STRUCTURALLY, without importing anything at
 * all; if its return type ever stops matching, the error lands at the gateway's
 * wiring line rather than somewhere inside the turn loop.
 *
 * `bellDurationMs` and not `bellMs`: the engine decides HOW LONG the Bell should
 * run (null / 20 s / 12 s on a boss floor / 120 s when quorum is 1) and the
 * gateway owns the wall clock that counts it down. Nothing under view/ or
 * engine/ may call Date.now — the same lint block that bans `await` bans that
 * too — so the remaining milliseconds arrive as an argument.
 */
export type TurnState = {
  /** COMPLETED game turns. Never ticks. */
  readonly gameTurn: number;
  /**
   * TURNS OF COMBAT REMAINING — `world.turn.engagement`, carried through the
   * snapshot rather than read off the world at the far end.
   *
   * It is here because it is a BARRIER INPUT, not decoration: `isBlocking`
   * consults it (engine/barrier.ts `BarrierLevel.engagement`) and it is the sole
   * reason `whoseTurn` is empty out of combat. Reading it off `world.turn` in
   * the gateway instead would work today — everything in the turn path is
   * synchronous — but it would let the frame and the "has the barrier changed?"
   * key describe two different instants the first time something between the
   * pump and the broadcast touches the world.
   *
   * 0 means free movement. Above zero, every player on the level owes a decision
   * every turn.
   */
  readonly engagement: number;
  /** The quorum: everyone parked at the barrier this turn, committed or not. */
  readonly whoseTurn: readonly string[];
  /** The subset of `whoseTurn` that has already committed or held. */
  readonly committed: readonly string[];
  /** Excluded from quorum: two silent turns, or a disconnected body. */
  readonly standingBy: readonly string[];
  /** Blocking players who have already acted this round. See `TurnMsg.acting`. */
  readonly acting?: readonly string[];
  /** How long a freshly-armed Bell should run, or null for no Bell at all. */
  readonly bellDurationMs: number | null;
  /**
   * WHOSE BARRIER THIS SNAPSHOT DESCRIBES — the members of one party.
   *
   * ABSENT MEANS THE WHOLE LEVEL, which is what every snapshot meant before
   * parties existed and is still what the gateway's "has the barrier changed?"
   * key is built from: the level-wide blocking set is the exact UNION of every
   * party's, because `isBlocking` is a fact about one actor and the scope only
   * decides whose quorum counts it. So one cheap level-wide comparison cannot
   * miss a per-party change, and the per-recipient frames are built from
   * per-recipient snapshots.
   *
   * It is here rather than passed beside `TurnState` because the two must not
   * be able to disagree: `whoseTurn` was computed against this membership, and
   * a card strip built from one party's blocking set and another party's roster
   * would say the game is waiting on nobody in particular.
   */
  readonly party?: readonly string[];
};

/**
 * One actor, field by field.
 *
 * Written out rather than spread (`{ ...actor }`) ON PURPOSE. A spread copies
 * whatever the server type happens to hold, so the day `hp`, `energy` or
 * `talentCooldowns` is added to `Actor` it would silently appear on the wire.
 * This way the compiler stops at this function and asks whether the client is
 * allowed to know.
 */
export function toActorView(actor: Actor): ActorView {
  return {
    // NOT A DISCORD SNOWFLAKE, and it cannot become one: `actorIdForUser` in
    // net/gateway.ts is the only thing that names a verified player's body and
    // it hashes. See the display-name block at the top of this file.
    id: actor.id,
    name: toDisplayName(actor.name),
    sprite: actor.sprite,
    x: actor.x,
    y: actor.y,
    kind: actor.kind,
    // Rank, from M3. The one property of a monster the fiction insists you can
    // see — the thing is visibly wrong in a way its neighbours are not — and the
    // client cannot infer it from hp or from the sprite key. It drives the
    // under-token ring, exactly as `boss_rank_circles` does in ToME.
    rank: actor.rank,
    // WHICH SIDE, when it is not the default. Omitted for every hostile, so a
    // client that ignores it is unchanged — see `ActorView.faction`.
    ...(actor.kind === ActorKind.Monster && actor.faction !== Faction.Redacted
      ? { faction: actor.faction }
      : {}),
    // Vitals, from M2. Note what is still NOT copied even though the engine's
    // actor carries it: `energy` and `energyBase` (a client that knew them could
    // compute the turn order in advance), `pendingIntent` (what someone is about
    // to do is the one thing you are supposed to have to ask them in voice) and
    // a monster's `ai.targetId` (which tells you who it is about to hit).
    hp: actor.hp,
    maxHp: actor.maxHp,
    alive: actor.alive,
  };
}

/**
 * The terrain a viewer may see.
 *
 * FOV SEAM: gains a `viewer: Actor` parameter and returns a copy with unexplored
 * tiles masked. M1 returns the live level object — nothing mutates it, and
 * JSON.stringify copies it onto the wire anyway.
 */
export function projectLevel(world: World): LevelView {
  return world.level;
}

/**
 * The actors a viewer may see.
 *
 * FOV SEAM: this is the one that matters. Everything hidden in a roguelike is
 * hidden here — invisible monsters, actors behind a wall, an ally's exact tile
 * when they are out of sight. Today: everyone.
 */
export function projectActors(world: World): ActorView[] {
  return world.allActors().map(toActorView);
}

/**
 * The full snapshot sent in `welcome`, and the recovery path when the server is
 * unsure what a client knows.
 */
export function projectWorld(world: World): WorldView {
  return {
    level: projectLevel(world),
    actors: projectActors(world),
  };
}

// ---------------------------------------------------------------------------
// M5 — THE TURN TRACKER. The cards, decided here and nowhere else
// ---------------------------------------------------------------------------

/*
 * WHY THE SERVER DECIDES THE CARD AND NOT THE RENDERER.
 *
 * A card's state is the barrier's precedence rules — Standing By outranks a
 * commit, a commit outranks the Bell, the Bell is only ever a decoration on
 * "waiting", and a body on the floor is outside the quorum entirely. Those rules
 * live in engine/barrier.ts. Deriving them again in the browser from three id
 * arrays is a second implementation of them in the one process that must never
 * hold one, and the day the two disagree the disagreement is DISPLAYED: four
 * people looking at four HUDs, one of which says the game is waiting on somebody
 * who has already committed.
 *
 * So `projectTurn` answers per actor, once, and the client draws what it is
 * told. That is the same argument `LogLine.lane` and `EffectView.harmful` are
 * already built on.
 */

/**
 * WHAT THE HOSTILE SIDE IS CALLED, as a group.
 *
 * The Index files people; these are the ones already filed. It must never be a
 * creature's name — "Index Husk" on a card beside four detectives says one husk
 * is taking a turn, when what is about to happen is every hostile on the floor
 * moving at once as a single batched sweep.
 */
const MONSTERS_DISPLAY_NAME = 'The Filed';

/**
 * Class icon per player sprite family — KEYED OFF THE THREE REAL CLASSES.
 *
 * These three rows are exactly `CLASSES` in content/classes.ts: the Watchman,
 * the Inspector and the Alchemist of Ashwick Row, which is every class a joining
 * body can now be handed (`classForJoin`). A player who has a class always finds
 * their own face here, because the sprite came off the same `ClassDef`.
 *
 * `icon_character_the_detective` is the generic and it is a REAL portrait rather
 * than a placeholder. It still has work to do: `world.ts#PLAYER_SPRITES` keeps
 * three sprites for classes that do not exist (enforcer, voidling, cipher-clerk)
 * as the CLASSLESS fallback — a fixture, the e2e harness, a build with no
 * content wired in — and "a detective" is what the fiction calls all of them
 * anyway. A key for art that is not on disk would draw a missing-asset box in
 * the middle of the most-looked-at UI in the game.
 */
const PORTRAIT_BY_CLASS: Record<string, string> = {
  watchman: 'icon_character_the_watchman',
  inspector: 'icon_character_the_inspector',
  alchemist: 'icon_character_the_alchemist',
};

const GENERIC_PORTRAIT = 'icon_character_the_detective';

/**
 * The class icon for one player, from their sprite key.
 *
 * THE `_downed_s` VARIANT MUST MAP TO THE SAME FACE. `goDown` swaps a player's
 * sprite to `chr_player_watchman_downed_s` (engine/downed.ts), and a lookup on
 * the whole key would miss it and quietly fall through to the generic — so the
 * card's portrait would CHANGE at the exact moment the party needs to recognise
 * whose body is on the floor. The suffixes are stripped for that one reason.
 *
 * An asset KEY, never a path: the client owns the manifest.
 */
function portraitForPlayer(sprite: string): string {
  const token = sprite.replace(/^chr_player_/, '').replace(/_downed_s$|_s$/, '');
  return PORTRAIT_BY_CLASS[token] ?? GENERIC_PORTRAIT;
}

/** Ranks, ordered by how much a card should want to show that face. */
const RANK_WEIGHT: Record<ActorRank, number> = {
  [ActorRank.Normal]: 0,
  [ActorRank.Elite]: 1,
  [ActorRank.Boss]: 2,
};

/** The aggregate card's numbers, summed over the living hostiles. */
type HostileSide = {
  readonly hp: number;
  readonly maxHp: number;
  readonly portrait: string | undefined;
  readonly count: number;
};

/**
 * THE WHOLE HOSTILE SIDE, as one row of numbers.
 *
 * `hp`/`maxHp` are SUMS, and the card must draw them as a group bar — "how much
 * fight is left in the other side" — never as one creature's health. Nothing new
 * reaches the client: every monster's hp and maxHp already travel on `ActorView`
 * and always have, so this is arithmetic over what the viewer was sent, not a
 * disclosure.
 *
 * FOV SEAM, AND IT IS THE SHARP ONE. Under shared party FOV (game-design.md
 * § 12) that argument holds exactly. When per-player FOV lands at M6 it stops
 * holding: a sum over hostiles the viewer cannot see is a count of what is in
 * the next room, which is the strongest single leak in this file. At that point
 * this function takes the viewer and sums only what `visible(viewer, actor)`
 * admits — and the aggregate's `portrait` has to be filtered the same way, for
 * the same reason.
 *
 * The FACE is the highest-ranked living hostile, ties broken by turn order so
 * the answer is stable frame to frame. It is a face for the side, not a roster:
 * an elite in the room should be what the card shows.
 */
function hostileSide(world: World): HostileSide {
  let hp = 0;
  let maxHp = 0;
  let count = 0;
  let portrait: string | undefined;
  let bestWeight = -1;

  for (const actor of world.actorsInTurnOrder()) {
    if (actor.kind !== ActorKind.Monster) continue;
    // Corpses are scenery. They are still on the map and still drawn, but they
    // are not part of what the party is fighting and a card that counted them
    // would say the fight is going worse than it is.
    if (!actor.alive) continue;
    hp += actor.hp;
    maxHp += actor.maxHp;
    count += 1;
    const weight = RANK_WEIGHT[actor.rank];
    if (weight > bestWeight) {
      bestWeight = weight;
      portrait = actor.sprite;
    }
  }

  return { hp, maxHp, portrait, count };
}

/**
 * WHICH CARD ONE PLAYER WEARS. The barrier's precedence, in the barrier's order.
 *
 * `alive` is checked FIRST because it is the case the three id arrays cannot
 * express at all: `surveyQuorum` skips a body that is not standing before it
 * decides anything, so a Downed detective appears in NEITHER `whoseTurn` NOR
 * `standingBy` — and a card built from the arrays alone would fall through to
 * "committed" and tell the party that the person bleeding out on the floor has
 * taken their turn.
 */
function playerCardState(
  actor: Actor,
  blocking: ReadonlySet<string>,
  standingBy: ReadonlySet<string>,
  bellMs: number | null,
): TurnActor['state'] {
  if (!actor.alive) return TurnActorState.StandingBy;
  if (standingBy.has(actor.id)) return TurnActorState.StandingBy;
  if (blocking.has(actor.id)) {
    // The Bell only ever runs on the last straggler, so "blocking while a Bell
    // is up" IS being the straggler. No second field needed on the wire.
    return bellMs === null ? TurnActorState.Waiting : TurnActorState.Bell;
  }
  // In combat: they have submitted, held, or a standing order covers them.
  // Out of combat: nothing blocks, so the barrier is waiting on nobody — which
  // is the same statement. `inCombat` is what stops a client presenting a strip
  // of eight ticks as a live tracker.
  return TurnActorState.Committed;
}

/**
 * THE CARD STRIP, IN STABLE JOIN ORDER.
 *
 * `world.allActors()` walks the actor map in insertion order and players are
 * inserted as they join, so filtering it preserves join order for free — the
 * same property ToME's `Party.lua:71` forces for its own party list. That order
 * is chosen because it carries NO INFORMATION: it cannot be mistaken for an
 * initiative queue (there is none — DECISIONS.md D1 phase-locks the party), and
 * no card moves under a cursor between two frames.
 *
 * EVERY PLAYER APPEARS, ALWAYS, including the erased and the disconnected. A
 * card that disappeared when somebody went down would delete the person the
 * party most needs to be looking at.
 *
 * THE AGGREGATE IS LAST AND ONLY IN COMBAT. Out of combat there is no hostile
 * side owing anything and a card for it would imply the party is waiting on
 * something; putting it last means it can appear and vanish without shifting a
 * single player's card sideways.
 */
function projectTurnActors(
  viewer: Actor,
  world: World,
  state: TurnState,
  bellMs: number | null,
  downed: DownedState | undefined,
): TurnActor[] {
  const blocking = new Set(state.whoseTurn);
  const standingBy = new Set(state.standingBy);
  const cards: TurnActor[] = [];

  for (const actor of world.allActors()) {
    if (actor.kind !== ActorKind.Player) continue;
    // v6: THE STRIP IS THE VIEWER'S PARTY, NOT THE FLOOR. `state.party` is the
    // membership the blocking set above was computed against, so filtering on
    // it is what keeps the two halves of one card describing one barrier. A
    // player from another party who fell through to this loop would be drawn
    // `committed` — the fall-through in `playerCardState` — and the strip would
    // quietly claim the game was waiting on nobody in particular.
    if (state.party !== undefined && !state.party.includes(actor.id)) continue;

    // The survival table is the ONLY thing that can tell a Downed detective from
    // a corpse — both carry `alive: false` and `hp: 0` by construction. Absent,
    // nobody is ever down, which is the honest answer for a server with no
    // survival system rather than a fabricated "they can be saved".
    const survival = downed === undefined ? undefined : downedView(downed, actor.id);

    cards.push({
      id: actor.id,
      // Hostile input, filtered here for the third time in this file and for the
      // same reason: this is the last function it passes through on its way to
      // four other people's screens.
      name: toDisplayName(actor.name),
      kind: TurnActorKind.Player,
      state: playerCardState(actor, blocking, standingBy, bellMs),
      hp: actor.hp,
      maxHp: actor.maxHp,
      portrait: portraitForPlayer(actor.sprite),
      // THE ONLY PER-RECIPIENT FIELD IN THE FRAME, and the reason `turn` is a
      // `ViewerMsg`. Never a Discord id on either side of the comparison — both
      // are actor ids, and `actorIdForUser` hashed the snowflake out of
      // existence before either one was minted.
      isSelf: actor.id === viewer.id,
      downed: survival !== undefined,
    });
  }

  if (state.engagement > 0) {
    const side = hostileSide(world);
    cards.push({
      id: MONSTERS_TURN_ID,
      name: MONSTERS_DISPLAY_NAME,
      kind: TurnActorKind.Monsters,
      // WAITING while any human still owes a decision — the sweep is queued
      // behind the party — and ACTING the moment the party is done, because the
      // monster turn is then the thing that is happening. It never says
      // `committed` (nothing committed) and never `bell` (the Bell is a courtesy
      // extended to people).
      state: blocking.size > 0 ? TurnActorState.Waiting : TurnActorState.Acting,
      hp: side.hp,
      maxHp: side.maxHp,
      // A monster SPRITE key, not a portrait icon: it is the art the client is
      // already drawing on the map for that body. Absent when the last hostile
      // died on the turn engagement has yet to decay off — a card with a name
      // and no face beats one wearing a corpse's.
      portrait: side.portrait,
      isSelf: false,
      downed: false,
    });
  }

  return cards;
}

/**
 * The barrier, as ONE PLAYER may see it.
 *
 * `viewer` WAS unused and is not any more: `TurnActor.isSelf` is true for
 * exactly one card, which is what made `turn` a `ViewerMsg` at v5. The seam this
 * parameter was reserved for is still coming — a summoned ally or a charmed
 * monster in `whoseTurn` names an actor whose existence the recipient may not be
 * entitled to know, and "who is the game waiting for" is a stronger position
 * leak than the tile grid — and it is still an edit to this body when it lands.
 *
 * THE COPIES ARE LOAD-BEARING, not defensive habit. The scheduler owns those
 * arrays and mutates them in place as the turn proceeds; the gateway keeps the
 * last payload it broadcast in order to answer "did the barrier change?". Alias
 * the engine's arrays into that memo and the comparison is between an object and
 * itself, so it always says "no change" and the turn indicator freezes on turn
 * one — the exact bug this message exists to prevent.
 *
 * @param bellMs milliseconds LEFT on the Bell, or null when none is running.
 *   Computed by the gateway: the wall clock is not allowed in this directory.
 * @param downed the survival table, or undefined for a server with no survival
 *   system wired in — in which case nobody is ever down, exactly as in
 *   `projectParty`.
 */
export function projectTurn(
  viewer: Actor,
  world: World,
  state: TurnState,
  bellMs: number | null,
  downed?: DownedState,
): TurnMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'turn',
    gameTurn: state.gameTurn,
    engagement: state.engagement,
    // DERIVED ONCE, HERE. The rule is `> 0` and it is written in exactly one
    // place in the process, so no two clients can disagree about whether the
    // party is in a fight — see the note on `TurnMsg.inCombat`.
    inCombat: state.engagement > 0,
    actors: projectTurnActors(viewer, world, state, bellMs, downed),
    whoseTurn: [...state.whoseTurn],
    committed: [...state.committed],
    standingBy: [...state.standingBy],
    // OMITTED WHEN EMPTY, which is the common case and the whole of the game
    // before the intra-turn budget. See `TurnMsg.acting`.
    ...(state.acting === undefined || state.acting.length === 0
      ? {}
      : { acting: [...state.acting] }),
    bellMs,
  };
}

// ---------------------------------------------------------------------------
// THE HOTBAR — three frames that belong to ONE VIEWER
// ---------------------------------------------------------------------------

/*
 * WHY ALL THREE TAKE `viewer` AS THE FIRST PARAMETER, INCLUDING THE ONE THAT
 * BARELY USES IT.
 *
 * `projectTurn` above takes a viewer it does not read, and the note there
 * explains why: the parameter is the seam, and it has to exist before the thing
 * it separates arrives. These three are the same idea one step further along,
 * except the hiding is REAL from day one rather than pending. A loadout, a
 * cooldown table and a resource pool are one player's, and the party gets to
 * know them by asking in voice.
 *
 * Cooldowns in particular are INTENT, which is the category `ActorView`
 * deliberately withholds twice over (`pendingIntent`, `ai.targetId`). "Mend
 * Wounds is ready" and "Fog Step has four turns left" tell you what the
 * Alchemist is saving and what the Inspector can no longer escape with. That is
 * a conversation, not a HUD element.
 *
 * The structural half of the guarantee is in protocol.ts: `broadcast` in the
 * gateway takes a `BroadcastMsg`, which is `ServerMsg` minus these three, so
 * handing one of them to the room does not compile. This file's job is the other
 * half — building them from ONE actor, so there is no shape here that could
 * carry a second player's row even if someone did find a way to send it.
 */

/**
 * The viewer's hotbar.
 *
 * `talents` arrives already shaped for the wire because it comes from the talent
 * book, which is authored content — see `TalentBook` in src/server/turn-engine.ts.
 * The copy is not defensive habit: the book may hand back a live array, the
 * gateway may hold the last frame it sent, and an aliased array compares equal to
 * itself forever. That is the same bug the copies in `projectTurn` prevent.
 */
export function projectLoadout(viewer: Actor, talents: readonly LoadoutTalent[]): LoadoutMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'loadout',
    // HOTBAR ORDER IS THE SERVER'S. Not sorted, not filtered — slot 1 is
    // talents[0] for the whole session, because muscle memory is worth more
    // than any ordering a renderer could impose.
    talents: talents.map(toLoadoutTalent),
  };
}

/**
 * Field by field, for the same reason `toActorView` is: the day a talent
 * definition grows `damageFormula`, `scriptPath` or a `debugNotes`, a spread
 * would put it on the wire and this function stops the compiler here to ask
 * whether the client is allowed to know.
 */
function toLoadoutTalent(talent: LoadoutTalent): LoadoutTalent {
  return {
    id: talent.id,
    name: talent.name,
    icon: talent.icon,
    cost: talent.cost,
    cooldownTurns: talent.cooldownTurns,
    // PER-ACTOR FROM v9 — `toLoadoutView` (content/classes.ts) resolved this at
    // the caster's own rank. Copied verbatim: this function decides WHAT a
    // client may know, never what the number is.
    range: talent.range,
    minRange: talent.minRange,
    shape: talent.shape,
    radius: talent.radius,
    // ═══ THE FOUR v9 FIELDS. A FIELD MISSED HERE IS A FIELD THAT NEVER SHIPS
    // ═══
    // This is a hand-written copy rather than a spread (see the docblock), so
    // adding a field upstream in `LoadoutTalent` silently drops it at this line
    // unless it is named. The compiler catches the omission because every one
    // of these is REQUIRED on the wire type — which is precisely why they are
    // required rather than optional.
    level: talent.level,
    maxLevel: talent.maxLevel,
    desc: talent.desc,
    descNext: talent.descNext,
  };
}

/**
 * The viewer's own cooldowns, as GAME TURNS REMAINING.
 *
 * Read straight off the actor — `EngineActor.cooldowns` is a `Map<string,
 * number>` ticked once per game turn by `actBase`, which is why it is immune to
 * haste by construction (ActorTalents.lua:1002-1013). A Map does not survive
 * `JSON.stringify` (it serialises as `{}`, silently, which would show every
 * button ready), so the conversion has to happen somewhere; here is the only
 * place that is allowed to decide what a client sees.
 *
 * THE RESULT IS COMPLETE, NOT A DELTA. Every talent cooling down appears;
 * anything in `loadout` that is absent is READY. The engine deletes an entry at
 * zero rather than storing a 0, so "absent" and "ready" are already the same
 * fact on both sides of the wire.
 */
export function projectCooldowns(viewer: Actor): CooldownsMsg {
  const cooldowns: Record<string, number> = {};
  for (const [talentId, turns] of viewer.cooldowns) {
    cooldowns[talentId] = turns;
  }
  return { v: PROTOCOL_VERSION, t: 'cooldowns', cooldowns };
}

/**
 * The viewer's own class resource.
 *
 * Returns null for an actor that has none — a monster, or a player before a
 * class exists to give them one — rather than inventing a zeroed pool, because
 * a hotbar with a 0/0 bar under it is a bug report and an absent frame is not.
 */
export function projectResource(
  viewer: Actor,
  resource: ResourceView | undefined,
): ResourceMsg | null {
  if (resource === undefined) return null;
  return {
    v: PROTOCOL_VERSION,
    t: 'resource',
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * REBUILT FIELD BY FIELD, WHICH IS WHY `ap` HAD TO BE ADDED HERE TOO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `toResourceView` was taught to carry the acting budget and the gateway's
     * memo key was taught to notice it change — and the number still never
     * reached a socket, because this function copies four named fields and
     * silently drops everything else. `tools/status-live.mjs` said so in one
     * line: "NO `resource` frame carried `ap`".
     *
     * The explicit copy stays rather than becoming a spread: it is what makes
     * this the ONE place that decides what a viewer is told about their own
     * budgets, and a spread would forward whatever a future `ResourceView`
     * happens to gain — which is how a server-only field ends up on a wire
     * nobody audited. The cost is exactly this: a new field is two edits, and
     * the second one is easy to forget. A live probe is what catches it.
     */
    resource: {
      kind: resource.kind,
      current: resource.current,
      max: resource.max,
      discrete: resource.discrete,
      ...(resource.ap === undefined ? {} : { ap: resource.ap }),
      ...(resource.maxAp === undefined ? {} : { maxAp: resource.maxAp }),
    },
  };
}

// ---------------------------------------------------------------------------
// v8 — THE PICKER. THE THREE CLASSES, TO THE ONE PLAYER WHO OWES A CHOICE
// ---------------------------------------------------------------------------

/*
 * WHY THIS IS A PROJECTION AND NOT A CONSTANT.
 *
 * `CLASSES` is authored content and every field on it is server-side: the
 * combat sheet, the `Talent` closures, the AP/MP budget, the downed sprite. A
 * picker needs six of those fields and none of the rest, so the frame is built
 * by the same field-by-field copy `toActorView` is — see its note. The day a
 * `ClassDef` grows a `secretUnlockCondition` or an `aiHints`, the compiler stops
 * at `toClassOptionView` and asks whether the client is allowed to know, instead
 * of a spread putting it on the first screen a new player sees.
 *
 * IT IS A `ViewerMsg`, so `broadcast(projectClassOptions())` does not compile —
 * see the note on `ClassOptionsMsg`. Handed to the room it puts a modal chooser
 * over the map for four returning players who already have a class.
 *
 * NOTHING IS COMPOSED FRESH HERE. The four talents come through
 * `loadoutViewFor`, which is the SAME function the hotbar's rows come from, so
 * the icons on a card are the icons on the buttons. The resource comes through
 * `toResourceView(sheetForClass(def))`, so `discrete` still arrives from
 * `RESOURCE_RULES` and a resource cannot be pips on the picker and a bar in the
 * HUD. The portrait comes from `PORTRAIT_BY_CLASS` above, which is already the
 * turn card's and the party pane's table, so one face means one class on every
 * surface in the game.
 */

/**
 * "PICK ONE" — the three classes, in the order `content/classes.ts` authors them.
 *
 * AUTHORED ORDER, NEVER SORTED, and the client must not sort either
 * (`ClassOptionsMsg.options` says so on the wire). A card that moves between two
 * frames is a card somebody misclicks, and this choice is irreversible.
 *
 * TAKES NO VIEWER, deliberately: the three classes are public and the frame is
 * byte-identical for everybody who receives one. What is per-viewer is WHETHER
 * THEY RECEIVE ONE AT ALL, and that decision belongs to the gateway — it is a
 * fact about a character file, which nothing in this directory may read.
 */
export function projectClassOptions(): ClassOptionsMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'class_options',
    options: CLASSES.map(toClassOptionView),
  };
}

/**
 * One class, field by field. Never a spread — see the block above.
 *
 * ═══ BOTH ASSET KEYS ARE CARRIED, NEITHER IS DERIVED FROM THE NAME ═══
 * `sprite` is `ClassDef.sprite` verbatim and `portrait` is a lookup in the
 * table this file already keeps. ToME derives its own birther icon by mangling
 * the class name (`t.name:lower():gsub("[^a-z0-9]", "_")`, Birther.lua:47-48)
 * and survives a miss because it ships `unknown_32_bg.png`. We have no such
 * asset and cannot add one — client/public/assets/ is gitignored wholesale and
 * an unresolved key renders as the LOUD violet missing-asset box, on a bare
 * clone, on the first screen a new player ever sees.
 *
 * The `?? GENERIC_PORTRAIT` is the SAME fallback `portraitForPlayer` uses and
 * not a second one, for exactly that reason: a class whose id is missing from
 * the table must draw a real detective rather than a violet box. It is
 * unreachable today — the table's keys are precisely the three `ClassId` values
 * — and test/server/class-wiring.test.ts pins that it stays unreachable, so
 * adding a fourth class cannot silently ship a generic face.
 */
function toClassOptionView(definition: ClassDef): ClassOptionView {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    sprite: definition.sprite,
    portrait: PORTRAIT_BY_CLASS[definition.id] ?? GENERIC_PORTRAIT,
    // The first number anybody compares. NOT rounded: `ClassDef.maxHp` is an
    // authored integer, unlike a live actor's fractional `hp`.
    maxHp: definition.maxHp,
    // A FRESH sheet, so the card shows the pool a new detective STARTS with —
    // Reagents 8/8 because you walked in carrying eight vials, Resolve and Focus
    // at 0 because a fresh sheet has earned nothing yet.
    //
    // IT IS A STARTING LINE AND NOT A CEILING, which the wording used to get
    // wrong: it said Resolve and Focus were 0 "because nothing in this game gives
    // you a resource for existing", and that rule has since been reversed. All
    // three pools trickle now (engine/talents.ts's `RESOURCE_RULES` — Resolve
    // 0.6/turn, Focus 0.4/turn, one whole Reagent every twelve turns), so the two
    // empty pools begin filling on the first base turn. `rule.start` is still the
    // right number for this card; only the reason is different.
    resource: toResourceView(sheetForClass(definition)),
    talents: loadoutViewFor(definition),
  };
}

// ---------------------------------------------------------------------------
// M4 — THE BADGE ROW AND THE PARTY PANEL
// ---------------------------------------------------------------------------

/*
 * WHY THESE TWO ARE WHOLE-WORLD AND NOT PER-VIEWER, TODAY.
 *
 * MVP ships SHARED PARTY FOV (game-design.md § 12 — per-player FOV is an M6
 * refinement that "roughly quadruples netcode complexity"). Under shared FOV
 * every recipient's answer to "who has what on them" is byte-identical, so
 * building the frame once and broadcasting it is not a shortcut, it is the
 * correct amount of work — and protocol.ts's `EffectsMsg` and `PartyMsg` are
 * `BroadcastMsg` members for exactly that reason.
 *
 * THE SEAM IS THE SAME ONE `projectActors` ALREADY CARRIES, and it is why these
 * live here rather than being built in the gateway: when per-player FOV lands,
 * `projectEffects` gains a `viewer: Actor` parameter and a
 * `visible(viewer, actorId)` test, and `EffectsMsg` moves from `BroadcastMsg` to
 * `ViewerMsg`. Two edits in this file plus a loop in the gateway. Nothing else
 * in the process learns anything new — which is the entire argument for a
 * projection layer that copies fields by hand.
 *
 * A BADGE IS NOT A LEAK; THE MECHANICS BEHIND IT WOULD BE. What goes on the wire
 * is the icon, the name and the turns remaining. The save that was rolled, the
 * power that beat it, the bleed's damage-per-turn and the slow's `globalSpeed`
 * multiplier all stay server-side, exactly as `toActorView` withholds `energy`
 * and `pendingIntent` — the party is meant to SEE that the Watchman is stunned
 * and to have to ASK how bad it is.
 */

/**
 * EVERY LIVE STATUS IN THE WORLD, grouped by actor.
 *
 * COMPLETE AND ABSOLUTE, exactly like `projectCooldowns`: an actor with no
 * entry here is clean. That is what makes the frame safe to drop — the next one
 * corrects it — and it is why the client must replace rather than merge. The
 * failure mode of a patch stream is a Stun badge that stays on a monster
 * forever, and "is that one still stunned?" is a question that gets somebody
 * killed.
 *
 * A `Map` does not survive `JSON.stringify` (it serialises as `{}`, silently),
 * so the conversion has to happen somewhere; here is the only place allowed to
 * decide what a client sees.
 *
 * BODIES THAT ARE NOT ALIVE ARE SKIPPED, AND THAT COVERS THE DOWNED TOO.
 *
 * `setEffect` already refuses to afflict a corpse (engine/effects.ts — "a corpse
 * is immune to everything by construction"), so anything still attached to one
 * is a leftover from the turn it fell, and a badge over a body says the fight
 * with it is not over when it is.
 *
 * A DOWNED detective carries `alive === false` as well — `goDown` in
 * engine/downed.ts sets it, because that flag is what stops the scheduler
 * ticking them and what stops them blocking the tile an ally must step onto. So
 * their statuses are FROZEN, not running: `timedEffects` never reaches them, the
 * bleed does not tick, and the durations sit exactly where they were. Drawing
 * badges with counts that will not move would say the opposite. What the client
 * draws over a body on the floor is the Downed countdown from `PartyMsg`, which
 * is the only number about them that is still going down.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TALENT LAYER'S OWN EFFECTS, ON THE BADGE ROW THE STATUS SYSTEM ALREADY HAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are TWO effect systems in this server and only one of them was ever
 * drawn. `engine/effects.ts` holds Stunned, Bleeding and Slowed and has a badge
 * channel; `engine/talents.ts` holds Marked, Guarding and Taunted and had
 * nothing — so the Inspector's Sigil, whose whole purpose is to tell the party
 * WHICH of six husks to focus, was invisible to every client. The only way a
 * player learned which one was sigiled was one Case Log line that scrolls away,
 * or the Inspector saying it out loud.
 *
 * `docs/game-design.md` § 10 names *"it's sigiled, hit it"* as the conversation
 * the design is trying to manufacture. It cannot be manufactured by a mechanic
 * nobody can see.
 *
 * ═══ THE SAME ROW, NOT A SECOND ONE ═══
 * A separate frame would mean a second badge strip, a second thing for the token
 * renderer to stack, and two answers to "what is on this body". The client
 * already draws `EffectView` badges on tokens and in the party pane; these are
 * the same kind of fact and belong in the same list.
 *
 * ═══ THE ART ALREADY EXISTS AND WAS NEVER ASKED FOR ═══
 * `icon_status_marked` and `icon_status_guarded` are cut, in the manifest, and
 * loaded by the `icon_status_` prefix — they have simply never been requested by
 * anything. No new art, no missing-asset box.
 *
 * TAUNTED IS DELIBERATELY NOT HERE. It is a fact about the MONSTER'S mind — who
 * it has decided to chase — and the honest place for that is the creature's
 * behaviour, which a player reads by watching it walk at the Watchman. A badge
 * would state it more loudly than the game can guarantee it: the taunt expires,
 * the AI retargets on its own, and a badge that outlived either would be a
 * confident lie about what a monster is about to do.
 */
type TalentBadgeSource = {
  effectOn(actorId: string, kind: TalentEffect): { readonly turns: number } | undefined;
};

const TALENT_BADGES: readonly {
  readonly kind: TalentEffect;
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly harmful: boolean;
}[] = [
  {
    kind: TalentEffect.Marked,
    id: 'effect:marked',
    name: 'Marked',
    icon: 'icon_status_marked',
    // HARMFUL TO THE BEARER, which is a monster. `harmful` is "is this being
    // done TO you", and the party reading a red pip over the thing they should
    // hit is exactly the right reading.
    harmful: true,
  },
  {
    kind: TalentEffect.Guarding,
    id: 'effect:guarded',
    name: 'Guarded',
    icon: 'icon_status_guarded',
    // The Watchman's Iron Curtain, on the ALLY being covered. Good for them.
    harmful: false,
  },
];

export function projectEffects(
  world: World,
  effects: EffectState,
  /**
   * The talent engine's effect table. Absent means the talent layer is not
   * wired — every fixture, and the game before this — and the badge row is
   * exactly what it always was.
   */
  talents?: TalentBadgeSource,
): EffectsMsg {
  const actors: ActorEffects[] = [];

  for (const actor of world.allActors()) {
    if (!actor.alive) continue;

    const live = effectsOn(effects, actor.id);
    const badges: EffectView[] = [];

    for (const row of TALENT_BADGES) {
      const held = talents?.effectOn(actor.id, row.kind);
      if (held === undefined) continue;
      badges.push({
        id: row.id,
        name: row.name,
        icon: row.icon,
        // Clamped for the reason the status badges are: a negative number on a
        // HUD is a bug report.
        turns: Math.max(0, held.turns),
        harmful: row.harmful,
      });
    }

    if (live.length === 0 && badges.length === 0) continue;
    for (const eff of live) {
      const def = effectDef(effects, eff.effectId);
      // An instance whose definition is gone is a content reload that dropped an
      // effect out from under a live game. The engine's own tick reaps it on the
      // next pass; until then it has no name and no icon, so there is nothing
      // honest to draw.
      if (def === undefined) continue;
      badges.push({
        id: eff.effectId,
        name: def.displayName,
        icon: def.icon,
        // `dur` reaches 0 for one pass before the effect is removed
        // (ActorTemporaryEffects.lua:80-81 — an expired effect survives one
        // extra tick). Clamped rather than hidden: the badge is still on the
        // actor, and a negative number on a HUD is a bug report.
        turns: Math.max(0, eff.dur),
        harmful: def.status === EffectStatus.Detrimental,
      });
    }

    if (badges.length > 0) actors.push({ id: actor.id, effects: badges });
  }

  return { v: PROTOCOL_VERSION, t: 'effects', actors };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING IN THE AIR. COMPLETE AND ABSOLUTE, exactly like `projectEffects`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An empty array means the sky is clear, and a client REPLACES its list rather
 * than merging into it. That is the same rule the badge row follows and it is
 * here for a sharper version of the same reason: an orb is a three-turn object
 * with a tile, so a patch stream that dropped one frame would leave a PHANTOM
 * ORB hanging over a tile forever — and a phantom orb does not merely look
 * wrong, it teaches the wrong counterplay. Somebody steps around a threat that
 * is not there, or stops trusting the ones that are.
 *
 * IT IS NOT AN EVENT, AND THAT IS WHY THIS FUNCTION EXISTS AT ALL. The launch
 * is never announced: src/client/render/sweep.ts applies a whole sweep in one
 * synchronous pass and clears its markers a quarter of a second later — exactly
 * while the player is deciding whether to step out of the line. A snapshot is
 * the only representation that survives a park, a reconnect and a resync, which
 * are the three moments an orb is most likely to be in flight.
 *
 * ═══ FOV SEAM, AND IT IS THE ONE PLACE THE FILTER WILL GO (M6) ═══
 *
 * Upstream marks a projectile `display_on_seen = true`, `display_on_remember =
 * false`, `display_on_unknown = false` (Projectile.lua:29-31): an orb is drawn
 * on tiles you can SEE RIGHT NOW and is never remembered, because where a bolt
 * was two turns ago is not where it is. Ours is level-wide today — there is one
 * `LevelView` and one actor list for everybody — so shipping the whole sky
 * leaks nothing `projectActors` does not already leak.
 *
 * THE DAY PER-PLAYER FOV LANDS, THE FILTER IS AN EDIT TO THIS BODY AND TO
 * NOTHING ELSE: this function takes the viewer and admits only orbs whose
 * CURRENT tile `visible(viewer, tile)` allows, with no remembered-tile fallback.
 * An orb's tile is a POSITION, and an orb crossing an unexplored room says
 * something is shooting in it and roughly where from — which is the shooter's
 * position, arrived at by inference, and therefore exactly the class of leak
 * CLAUDE.md non-negotiable 4 exists for. `ProjectilesMsg` moves from
 * `BroadcastMsg` to `ViewerMsg` in the same commit; `BroadcastMsg` is
 * `Exclude`-derived, so that move is one line in protocol.ts and a compile error
 * at every site that was broadcasting it.
 *
 * ═══ TURNS, NEVER MILLISECONDS ═══
 *
 * `turnsToImpact` is GAME TURNS, computed by `engine/projectile.ts` from the
 * tiles left and the orb's own `energyMod` — tiles per game turn, which is
 * `proj_speed` exactly (Projectile.lua:304-305 into GameEnergyBased.lua:125).
 * There is no deadline and no millisecond figure anywhere in the frame, and
 * there could not be: nothing under src/server/view/** may call `Date.now` (see
 * the note on `TurnState.bellDurationMs` above — the lint block that bans
 * `await` here bans the clock too). The same unit as `EffectView.turns` and
 * `CooldownsMsg`, and mixing the two would be the difference between "you have
 * two turns to move" and "it lands before you can press a key".
 *
 * FIELD BY FIELD, never a spread, for the reason `toActorView` gives: the orb
 * carries its frozen damage roll, its armour penetration, the whole `path` it
 * will take and the id of a shooter whose body may be a corpse. A spread would
 * put the flight plan — and therefore the shot's destination BEFORE it gets
 * there, and the exact number it will deal — on the wire the day somebody adds a
 * field. The compiler stopping here and asking whether the client is allowed to
 * know IS the point.
 */
export function projectProjectiles(world: World): ProjectilesMsg {
  const projectiles: ProjectileView[] = [];

  for (const proj of world.projectilesInFlight()) {
    // A DETONATED ORB IS NOT IN THE AIR. `actProjectile` drops a landed orb from
    // the world in the same synchronous step it lands, so this is unreachable
    // today and is written down anyway: the flag exists because the scheduler
    // ticks a SNAPSHOT of the array (`Projectile.landed`), and the day anything
    // defers the removal, drawing the orb would say a shot that has already
    // been resolved is still coming.
    if (proj.landed) continue;

    const at = currentTile(proj);
    const aim = aimTile(proj);

    projectiles.push({
      id: proj.id,
      // WHERE IT IS RIGHT NOW — `path[cursor - 1]`, the tile it is standing on.
      x: at.x,
      y: at.y,
      // WHO FIRED IT. May name a corpse: an orb outlives its shooter, upstream
      // included (Projectile.lua holds a hard `src` reference with no liveness
      // check, and attributes the kill to the dead shooter).
      sourceId: proj.sourceId,
      // THE TILE IT IS FLYING AT — the last tile of the frozen line, which is
      // where the target was standing when it was fired and NOT where they are
      // now. The orb does not re-aim, and this field is what lets a client draw
      // that fact. Softening it into the target's current tile would delete the
      // counterplay from the screen while leaving it in the engine.
      targetX: aim.x,
      targetY: aim.y,
      turnsToImpact: turnsToImpact(proj),
    });
    // NOT COPIED, AND EACH IS A REASON THE SPREAD IS BANNED ABOVE: `damage` (the
    // frozen roll, the apr and the resist penetration — a client that knew it
    // could decide whether to bother dodging), `path` (every tile the shot will
    // cross, i.e. the future), `range`, `origin`, and all four energy fields,
    // which would let a client compute the exact tick of impact and therefore
    // the whole turn order — the same disclosure `toActorView` withholds.
  }

  return { v: PROTOCOL_VERSION, t: 'projectiles', projectiles };
}

// ---------------------------------------------------------------------------
// v10 — THE FLOOR AND THE BAG. Two frames, two unions, and the split is the
// point: a floor item is a POSITION and an inventory is a HOLDING.
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY ITEM ON THE FLOOR. COMPLETE AND ABSOLUTE, exactly like
 * `projectProjectiles` directly above — and it is a BROADCAST, not a gate.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An empty array means the floor is clear, and a client REPLACES its list
 * rather than merging into it. Same rule as the badge row and the sky, and the
 * failure mode is the sharper version of the phantom-orb one: a client that
 * dropped a patch would show a coat lying on a tile forever, and somebody would
 * walk the length of the map to pick up a thing that is not there. NEVER A
 * PATCH — there is no "taken" or "dropped" message and there must not be one.
 *
 * ═══ IT IS NOT FOV-GATED AND THIS COMMENT WILL NOT PRETEND OTHERWISE ═══
 * Ground items go to the whole room, matching the accepted leak `ProjectilesMsg`
 * already carries (protocol.ts:846-865 — broadcast today, with the written
 * caveat that it moves to `ViewerMsg` the day per-player FOV lands). The caveat
 * applies here VERBATIM and it is sharper: an orb crossing an unexplored room
 * says something is shooting in it; a coat lying in one says something DIED in
 * it, and it stays there for the rest of the delve. Fog of war is level-wide
 * today (one `LevelView`, one actor list), so this leaks nothing
 * `projectActors` does not already leak — but the day FOV lands, this function
 * takes the viewer, admits only items on tiles `visible(viewer, cell)` allows,
 * and `GroundMsg` moves from `BroadcastMsg` to `ViewerMsg` in the same commit.
 * `BroadcastMsg` is `Exclude`-derived, so that is one line in protocol.ts plus a
 * compile error at every site that was broadcasting it.
 *
 * ═══ IT IS BROADCAST FOR A SECOND, POSITIVE REASON TOO ═══
 * The pile is UNOWNED and shared, first pickup wins (see `DropSchema`, which
 * labels that rule a DEVIATION with no upstream citation — ToME is
 * single-player and has no party to own anything). Per-player instancing would
 * triple the effective drop rate and delete the sentence "you take it, I've got
 * a coat", which is the entire social point of a game played in a voice
 * channel. One floor, one frame, everybody looking at the same thing.
 *
 * ═══ INSERTION ORDER, AND IT IS THE PICKUP ORDER ═══
 * `world.groundItems()` hands back the world's own stable insertion order, which
 * is the order `itemsAt` filters and therefore the order `pickup` consumes
 * (world.ts:516-522: "PICKUP TAKES INDEX 0"). Sorting here would make the top of
 * the pile mean one thing to the client's prompt and another to the server.
 *
 * AN ITEM THE CATALOGUE NO LONGER KNOWS IS SKIPPED rather than drawn as a
 * violet box: `tier` comes off the catalogue and there is nothing honest to
 * colour a marker with. It is reachable only from a content reload that deleted
 * an authored item out from under a live floor.
 */
export function projectGroundItems(world: World): GroundMsg {
  const items: GroundItemView[] = [];

  for (const dropped of world.groundItems()) {
    // MONEY FIRST, because `resolveItem` cannot answer for it and never will —
    // a coin pile has no `slot`, so it is not an `Item` (content/money.ts). It
    // draws at the plainest tier: a pile of gold is not a rare find, it is the
    // most ordinary thing on the floor.
    if (isMoneyId(dropped.itemId)) {
      items.push({
        id: dropped.id,
        cell: [dropped.x, dropped.y],
        itemId: dropped.itemId,
        tier: 'common',
      });
      continue;
    }

    const item = resolveItem(dropped.itemId);
    if (item === undefined) continue;
    items.push({
      // THE WORLD'S id, not the catalogue's — see `GroundItemView`. Two
      // identical pairs of trousers on one tile are two rows, and a client that
      // keyed on `itemId` would draw one marker and be permanently one short.
      id: dropped.id,
      cell: [dropped.x, dropped.y],
      itemId: dropped.itemId,
      tier: item.tier,
    });
    // NOT COPIED, and the omission is the same field-by-field discipline
    // `toActorView` and `projectProjectiles` keep: the catalogue row also holds
    // the `wielder` table, which is what equipping the thing would DO. Shipping
    // it would hand the client the arithmetic `CarriedItemView.compare` exists
    // to have already done — and it would do it for an item nobody has picked
    // up, which is a preview of a decision the player has not earned yet.
  }

  return { v: PROTOCOL_VERSION, t: 'ground', items };
}

/**
 * One catalogue row, field by field. Never a spread — see `toActorView`.
 *
 * THE `wielder` TABLE IS THE FIELD THIS FUNCTION EXISTS TO WITHHOLD. `ItemView`
 * says so on the wire; this is where the compiler enforces it, because the day
 * `Item` grows a `dropWeight` or a `debugNotes` a spread would put it in front
 * of every player and nothing would stop it.
 */
function toItemView(item: Item): ItemView {
  return {
    itemId: item.id,
    name: item.name,
    icon: item.icon,
    tier: item.tier,
    // Authored FOR this screen — `Item.desc` calls itself "one sentence, shown
    // in the inventory" — and this frame is the only path to it.
    desc: item.desc,
  };
}

/**
 * THE COMPARISON TABLE: which derived numbers a swap is allowed to talk about,
 * and how each one reads.
 *
 * ═══ IT IS THE CHARACTER SHEET'S OWN VOCABULARY, IN THE CHARACTER SHEET'S OWN
 *     ORDER ═══
 * Six primaries in ToME's order (CharacterSheet.lua:815-820), then Attack
 * (:935-1120), then Defense (:1304-1321) — the identical spine
 * `view/inspect.ts#pushSelfSheet` prints, because the panel and the hover card
 * are two windows onto one body and a player reading "+3 Armour" here and
 * "Armour 9" there must be able to add them up. A second ordering would be a
 * second house style on one screen.
 *
 * `Hardiness` is here and is NOT on the inspect sheet, and that asymmetry is
 * deliberate rather than an oversight: `combatArmorHardiness` decides what
 * FRACTION of a blow armour is allowed to bite (Combat.lua:1336), the Watchman's
 * coat is the only item in the catalogue that moves it, and an item whose
 * headline contribution had no row would read as an item that does nothing —
 * Trap 1 arriving through the tooltip instead of through the maths.
 *
 * ═══ WHY THERE IS NO `Damage` BAND HERE ═══
 * `inspect.ts#damageBand` prints "12–13" because both endpoints are real dice.
 * A DELTA of a band is not a band, so this row carries the single number
 * `combatDamage` returns and lets the sheet show the spread.
 */
const COMPARE_STATS: readonly (readonly [string, keyof PrimaryStats])[] = [
  ['Strength', 'str'],
  ['Dexterity', 'dex'],
  ['Constitution', 'con'],
  ['Magic', 'mag'],
  ['Willpower', 'wil'],
  ['Cunning', 'cun'],
];

/** A signed whole number — ToME's `"%+d"` (Object.lua:1285-1287). */
function signed(n: number): string {
  return n > 0 ? `+${String(n)}` : String(n);
}

/**
 * HOW A ROW RENDERS A DIFFERENCE, AND WHY IT IS NOT ALWAYS `Math.round`.
 *
 * Every row here must equal the difference between the two numbers the
 * CHARACTER SHEET PRINTS (see `compareRows`), so the shape of a row is decided
 * by how the sheet prints that quantity — not by a house rounding rule.
 * `inspect.ts#appendCombatRows` prints nine of these ten as `whole(...)`, a
 * rounded scalar. It prints Damage as `damageBand`: a TRUNCATED pair,
 * `trunc(dam)`–`trunc(dam × damRange)`. One `Scalar` and one `Band`, because
 * there is exactly one row on the sheet that is not a rounded scalar.
 */
const CompareShape = {
  /** The sheet prints one rounded number. Round both sides, then subtract. */
  Scalar: 'scalar',
  /** As `Scalar`, and the sheet prints a `%` after it. */
  Percent: 'percent',
  /** The sheet prints a truncated band. See `damageBandDelta`. */
  Band: 'band',
} as const;
type CompareShape = (typeof CompareShape)[keyof typeof CompareShape];

/** Derived getters a swap may move, in sheet order. */
const COMPARE_ROWS: readonly (readonly [string, (c: Combatant) => number, CompareShape])[] = [
  ['Accuracy', combatAttack, CompareShape.Scalar],
  ['Damage', combatDamage, CompareShape.Band],
  ['APR', combatAPR, CompareShape.Scalar],
  ['Crit. chance', combatCrit, CompareShape.Percent],
  ['Armour', combatArmor, CompareShape.Scalar],
  ['Hardiness', combatArmorHardiness, CompareShape.Percent],
  ['Defence', combatDefense, CompareShape.Scalar],
  ['Physical save', combatPhysicalResist, CompareShape.Scalar],
  ['Spell save', combatSpellResist, CompareShape.Scalar],
  ['Mental save', combatMentalResist, CompareShape.Scalar],
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DAMAGE ROW, MEASURED THE WAY THE SHEET MEASURES IT — TRUNCATED, AND ON
 * BOTH ENDPOINTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS ROW USED TO BE `Math.round(after) - Math.round(before)` LIKE THE OTHER
 * NINE, AND IT SILENTLY ATE THE BIGGEST OFFENSIVE ITEMS IN THE GAME. An
 * Inspector holding her own Dossier (`mods.dam 4`, her only offensive piece)
 * went 11.542 -> 12.430: the sheet's band moves 11–13 -> 12–14, a full point on
 * BOTH ends, but `round(12.430) - round(11.542)` is `12 - 12 = 0`, so no row was
 * emitted and `compare` came back EMPTY — which `CarriedItemView.compare`
 * defines as "this changes nothing you can see". Five class/item pairs measured
 * the same way: inspector×dossier, inspector×tome, inspector×oxfords,
 * alchemist×brass ring, alchemist×cowl.
 *
 * ═══ WHY THE RANGE IS READ OFF EACH COMPOSED SHEET AND NOT OFF `base` ═══
 * `damRange` is a foldable mod (`AdditiveMods`, content/items.ts), so an item
 * may move the high end WITHOUT moving `dam` at all. Reading the multiplier
 * once off the base sheet would report such an item as inert for the same
 * reason rounding did.
 *
 * ═══ WHY BOTH ENDPOINTS, AND WHY THEY ARE PRINTED APART WHEN THEY DISAGREE ═══
 * `rollDamageRange` draws `rng.range(low, high)` over the truncated pair, so the
 * two endpoints are independent facts about the dice: an item can lift the high
 * end by 1 and leave the low end where it was. `+0–+1` is that item told
 * honestly; collapsing it to `+0` would be the same lie in a smaller costume.
 * When they agree — the usual case — one number is printed, exactly as
 * `damageBand` collapses `9–9` to `9`.
 *
 * @returns the formatted delta, or null when neither endpoint moved.
 */
function damageBandDelta(
  before: Combatant,
  after: Combatant,
  read: (c: Combatant) => number,
): string | null {
  // `Math.trunc`, not `Math.round` and not `Math.floor` — inspect.ts:250-259
  // states the reason at the sheet: ToME's `rng.range` is native C taking its
  // arguments through an `int`, so these are the numbers the dice can produce.
  const lowDelta = Math.trunc(read(after)) - Math.trunc(read(before));
  const highDelta =
    Math.trunc(read(after) * combatDamageRange(after)) -
    Math.trunc(read(before) * combatDamageRange(before));

  if (lowDelta === 0 && highDelta === 0) return null;
  return lowDelta === highDelta ? signed(lowDelta) : `${signed(lowDelta)}–${signed(highDelta)}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "SHOULD I PUT THIS ON?" — ANSWERED ON THE SERVER, AGAINST THIS VIEWER'S OWN
 * PAPER DOLL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported in spirit from tome/dialogs/ShowEquipInven.lua:54, which passes the
 * destination inventory into `getDesc` as `compare_with`
 * (tome/class/Object.lua:2074, forwarded at :2120 to `getTextualDesc` at :1157),
 * where `compare_fields(w, compare_with, field, "combat_armor", "%+d",
 * "Armour: ")` at :1285-1287 renders exactly a label and a signed number. Ours
 * compares DERIVED getters rather than raw `combat_*` fields, and that is a
 * deliberate improvement rather than a drift: `rescaleCombatStats` is concave
 * and FLOORS (shared/scale.ts:116), so +3 Strength is worth a different number
 * of points of damage depending on where the total already sits. Comparing the
 * raw field would promise a player a number the server will not deliver.
 *
 * ═══ THE COMPARISON IS RUN OVER `baseCombat` + GEAR, NEVER OVER `actor.combat`
 * ═══
 * `actor.combat` is stage three of `recomposeCombat` — it carries live status
 * flags. Diffing two sheets that both carry them cancels them out arithmetically
 * today, but the day an effect writes a stat rather than a flag, a Stun would
 * start changing what a coat appears to be worth. Both sides of this subtraction
 * are stage-two sheets, which is the only pair that describes the swap and
 * nothing else.
 *
 * ═══ AN EMPTY LIST IS A REAL ANSWER ═══
 * "Equipping this moves nothing you can see", and it happens honestly:
 * `max(0, armour - apr)` (engine/damage.ts:301) means an armour grant below the
 * attacker's penetration measures as exactly zero, and two items that do the
 * same thing compare to nothing. `CarriedItemView.compare` says an empty list is
 * to be drawn as a blank row rather than as an invented "no change" line.
 *
 * ROUNDED BEFORE SUBTRACTING, not after. The row must equal the difference
 * between the two numbers the character sheet PRINTS, or a player watching
 * "Armour 6" become "Armour 9" would be told the swap was worth +2.6.
 *
 * AND "WHAT THE SHEET PRINTS" IS NOT ALWAYS A ROUNDED SCALAR. Damage is printed
 * as a truncated BAND (inspect.ts#damageBand), so measuring it with `Math.round`
 * satisfies the sentence above in letter and breaks it in fact. That is what
 * `CompareShape` tags and what `damageBandDelta` measures.
 */
function compareRows(base: CombatSheet, worn: readonly Item[], candidate: Item): InspectRow[] {
  // THE SWAP, NOT THE ADDITION. Whatever is already in this item's slot comes
  // OFF — that is what `equip` will do — so the "after" set is the worn set with
  // the occupant of `candidate.slot` replaced rather than joined.
  const after = worn.filter((item) => item.slot !== candidate.slot);
  after.push(candidate);

  const before = composeSheet(base, worn);
  const withIt = composeSheet(base, after);

  const rows: InspectRow[] = [];
  for (const [label, key] of COMPARE_STATS) {
    const delta = Math.round(stat(withIt, key)) - Math.round(stat(before, key));
    if (delta !== 0) rows.push({ label, value: signed(delta) });
  }
  for (const [label, read, shape] of COMPARE_ROWS) {
    if (shape === CompareShape.Band) {
      // The one row the sheet does not print as a rounded scalar. IN PLACE in
      // the tuple rather than appended afterwards, so the panel keeps sheet
      // order — Accuracy, Damage, APR — and the special case cannot silently
      // move the row to the bottom of the list.
      const value = damageBandDelta(before, withIt, read);
      if (value !== null) rows.push({ label, value });
      continue;
    }
    const delta = Math.round(read(withIt)) - Math.round(read(before));
    if (delta !== 0) {
      rows.push({
        label,
        value: shape === CompareShape.Percent ? `${signed(delta)}%` : signed(delta),
      });
    }
  }
  return rows;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE PLAYER'S BAG AND ONE PLAYER'S PAPER DOLL. A `ViewerMsg`, and there is no
 * shape of this frame that is correct for two people.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE FRAME FOR BOTH HALVES, WHICH IS THE PORT RATHER THAN A SIMPLIFICATION:
 * ToME's `SHOW_EQUIPMENT` is literally an alias of `SHOW_INVENTORY`
 * (tome/class/Game.lua:2192) and both open the same combined `ShowEquipInven`
 * dialog. Two frames would let the doll and the bag arrive a pump apart and
 * render a comparison against a slot whose contents had already changed.
 *
 * ═══ WHY IT CANNOT BE BROADCAST, AND IT IS NOT ONLY PRIVACY ═══
 * `compare` is a DELTA AGAINST THE RECIPIENT'S OWN DOLL: the same coat is +4
 * Armour to a bare Watchman and nothing at all to one already wearing it. A
 * shared copy would not merely leak — it would be arithmetically WRONG for
 * everybody but its author, on the one screen whose whole job is answering "is
 * this better than what I have on?". The privacy half is `ViewerMsg`'s own
 * argument: what somebody is carrying and has not put on is a decision they have
 * not made yet, exactly like a banked talent point.
 *
 * ═══ SLOT ORDER, NEVER MAP ORDER ═══
 * The doll is walked in `SLOT_ORDER` — the gear fold's own order
 * (content/items.ts) — so the frame does not depend on which buttons a player
 * happened to press. `equipped` is a `Partial<Record<Slot, string>>` built by
 * hand, and a JSON object preserves insertion order, so without this the same
 * two items would serialise differently for two players wearing them.
 *
 * ═══ REPAIR, NEVER REJECT ═══
 * An id the catalogue does not know, and an id filed under a slot it does not
 * belong in, are both SKIPPED — the same rule `wornOf` follows for the fold, and
 * for the same reason: both are reachable from a save written by a build that
 * authored an item this one does not, and neither is worth refusing to draw a
 * panel over. What is skipped here is skipped there too, so the panel and the
 * sheet cannot disagree about what is being worn.
 *
 * TAKES THE ACTOR, NOT THE WORLD, because everything it needs is on the body:
 * `carried`, `equipped` and `baseCombat` are all fields on `ActorCommon` for the
 * stated reason that the save layer cannot reach the talent engine.
 */
export function projectInventory(viewer: Actor): InventoryMsg {
  const equipped: { [K in Slot]?: ItemView } = {};
  for (const slot of SLOT_ORDER) {
    const id = viewer.equipped?.[slot];
    if (id === undefined) continue;
    const item = resolveItem(id);
    if (item === undefined || item.slot !== slot) continue;
    equipped[slot] = toItemView(item);
  }

  // The same fold `recomposeCombat` ran to build `actor.combat`, re-run here so
  // the "before" side of every comparison is the sheet the player is actually
  // wearing rather than one this function guessed at.
  const base = viewer.baseCombat ?? viewer.combat;
  const worn = wornOf(viewer.equipped, resolveItem);

  const carried: CarriedItemView[] = [];
  for (const id of viewer.carried ?? []) {
    const item = resolveItem(id);
    if (item === undefined) continue;
    carried.push({
      ...toItemView(item),
      // NAMED HERE because a bag has no key to read it off — see `ItemView`,
      // which deliberately omits `slot` for the doll where the key IS the slot.
      // OMITTED ENTIRELY for a draught rather than sent as null: absence is what
      // tells the client there is no Equip for this row.
      ...(item.slot === undefined ? {} : { slot: item.slot }),
      // A body with no sheet at all (an M2-era fixture, a classless e2e body)
      // has nothing to compare against, and an invented baseline would be a
      // promise about numbers that body does not have.
      compare: base === undefined ? [] : compareRows(base, worn, item),
    });
  }

  // NARROWED, NOT ASSERTED. `money` lives on `PlayerActor` alone, exactly as
  // `level` and `xp` do — a monster with a purse would be a monster somebody
  // could rob, which is a design nobody has made. Zero is the honest reading
  // for a body that cannot have money, unlike a bag where absent and empty are
  // different claims.
  return {
    v: PROTOCOL_VERSION,
    t: 'inventory',
    carried,
    equipped,
    money: viewer.kind === ActorKind.Player ? viewer.money : 0,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ON THE SHELVES, PRICED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TAKES THE SHELF AND THE LEVEL RATHER THAN THE REALM, so this directory does
 * not have to know what a `Realm` is — the same seam `bellMs` and `speaking`
 * use, and the reason it can be tested with an array of strings.
 *
 * BOTH PRICES ARE COMPUTED HERE AND SENT. A client that derived them would be a
 * second copy of the economy, and the first thing to drift would be the ~24:1
 * spread — silently, because a wrong price still looks like a price.
 *
 * A SLOT THAT DOES NOT RESOLVE IS SKIPPED, exactly as `projectGroundItems`
 * skips a floor item a content reload deleted. It is reachable the same way and
 * deserves the same answer: show what can be shown rather than refusing the
 * whole shelf over one row.
 */
export function projectShop(name: string, stock: readonly string[], level: number): ShopMsg {
  const items: ShopItemView[] = [];
  for (const itemId of stock) {
    const item = resolveItem(itemId);
    if (item === undefined) continue;
    items.push({
      itemId,
      name: item.name,
      icon: item.icon,
      tier: item.tier,
      buy: buyPrice(itemId, level),
      sell: sellPrice(itemId),
    });
  }
  return { v: PROTOCOL_VERSION, t: 'shop', name, stock: items };
}

/**
 * THE PARTY PANEL. Every detective, every time.
 *
 * NO HIT POINTS, AND THAT IS `PartyMember`'S DESIGN RATHER THAN AN OMISSION:
 * `ActorView` already carries hp/maxHp, `damage` events keep them absolute, and
 * a second copy here is a second copy that can disagree in the one place four
 * people are staring to decide whether to run. The panel joins this row to the
 * actor of the same id.
 *
 * WHAT IT DOES CARRY is everything `ActorView` cannot answer: the Downed timer,
 * whether anybody is still attached to the body, and the voice dot.
 *
 * @param downed the survival table (engine/downed.ts), or undefined for a server
 *   with no survival system wired in — in which case nobody is ever down, which
 *   is the honest answer rather than a fabricated timer.
 * @param speaking actor ids the gateway has heard from recently. A SET rather
 *   than a timestamp map because the wall clock lives in the gateway: nothing
 *   under src/server/view/** may call `Date.now` (eslint.config.js groups 2+3),
 *   so the decision arrives already made, exactly as `bellMs` does.
 */
export function projectParty(
  world: World,
  downed: DownedState | undefined,
  speaking: ReadonlySet<string> = EMPTY_SPEAKING,
): PartyMsg {
  const members: PartyMember[] = [];

  for (const actor of world.allActors()) {
    if (actor.kind !== ActorKind.Player) continue;

    // `downedView` answers both halves at once — Downed vs Erased, and how many
    // turns are left — so there is no window in which the flag and the countdown
    // can disagree with each other.
    const survival = downed === undefined ? undefined : downedView(downed, actor.id);

    members.push({
      id: actor.id,
      // The same two guarantees `toActorView` carries, and for the same reason:
      // the panel is where a player's Discord name is most visible, so it is
      // where a name that reorders the row would do the most damage.
      name: toDisplayName(actor.name),
      // NULL WHEN THEY ARE ON THEIR FEET — `downedView` returns undefined for
      // `Survival.Up`, and the wire spells "not down" as null.
      //
      // COPIED FIELD BY FIELD rather than passed through, for the same reason
      // `toActorView` is: the engine's `DownedView` and the wire's are the same
      // four fields TODAY, and the day the engine's grows a `revivedBy` or a
      // `sinceTurn` the compiler stops here and asks whether the client is
      // allowed to know. A spread would put it on the wire silently.
      //
      // ERASED IS NOT DOWNED, and both statuses travel: an erased body has no
      // revive prompt, and a panel that hid it would leave a row with nothing on
      // it at the exact moment somebody needs to be told why.
      downed:
        survival === undefined
          ? null
          : {
              status: survival.status,
              marker: survival.marker,
              turnsLeft: survival.turnsLeft,
              total: survival.total,
            },
      // MUTED IS NEVER SERVER-SIDE TRUTH. The server knows one thing about a
      // microphone: nothing. What it knows is that this player put a line in the
      // Margin within the last few seconds, which is what `speaking` carries.
      // Discord's own `SPEAKING_START`/`SPEAKING_STOP` and the mute state arrive
      // in the CLIENT over `rpc.voice.read`, which docs/discord-activity.md:204
      // records as available-but-unproven with an explicit instruction to
      // degrade gracefully — so the client ORs the two and the panel still has a
      // liveness signal on the night the scope does not work.
      voice: speaking.has(actor.id) ? VoiceState.Speaking : VoiceState.Silent,
      connected: actor.connected,
    });
  }

  // STILL THE WHOLE FLOOR, UNCHANGED BY v6. Who shares a barrier with whom is
  // `party_state`'s question, and it is per-recipient because the answer is —
  // see `projectPartyState` below.
  return { v: PROTOCOL_VERSION, t: 'party', members };
}

// ---------------------------------------------------------------------------
// v6 — THE PARTY PANE. WHO SHARES YOUR BARRIER.
// ---------------------------------------------------------------------------

/**
 * ONE PARTY, AS PLAIN DATA, exactly as the engine holds it.
 *
 * STRUCTURAL RATHER THAN AN IMPORT OF `Party` from engine/party.ts, and it is
 * the same trick `TurnEngine` and `TalentBook` play: this file states what it
 * needs and the engine's own type satisfies it without either side importing
 * the other. It also means a test can hand `projectPartyState` a three-line
 * object literal with no party table behind it at all.
 */
export type PartyRoster = {
  readonly leaderId: string;
  /** JOIN ORDER, and the projection preserves it. Never empty. */
  readonly members: readonly string[];
};

/**
 * ONE OUTSTANDING OFFER, with the wall clock ALREADY APPLIED.
 *
 * `expiresInMs` rather than `expiresAtMs`, and the subtraction happens in
 * src/server/turn-engine.ts, because nothing under src/server/view/** may call
 * `Date.now` (eslint.config.js groups 2+3). The decision arrives already made,
 * exactly as `bellMs` and `projectParty`'s `speaking` set do.
 */
export type PartyOffer = {
  readonly fromId: string;
  readonly expiresInMs: number;
  /** How many are already in the party being offered. */
  readonly size: number;
};

/**
 * THE LEFT-HAND PANE: your party, who leads it, and what is waiting on you.
 *
 * PER-RECIPIENT, and the frame is a `ViewerMsg` so handing it to `broadcast`
 * does not compile. Two independent fields make it one — `isSelf` is true for
 * exactly one person, and `invites` is a list of decisions that belong to the
 * recipient alone — and either would be enough on its own.
 *
 * ═══ A MEMBER WITH NO BODY IS STILL A MEMBER ═══
 * A party member whose actor has left the world (the reconnect grace expired
 * between the party change and this frame) is skipped rather than drawn from
 * invented numbers: the engine's `forgetActor` removes them from the party in
 * the same synchronous step the body leaves, so this can only be a race with a
 * frame already in flight, and the next `party_state` corrects it. Inventing a
 * 0/0 row would put a permanent ghost in the pane.
 *
 * @param state the barrier snapshot FOR THIS PARTY — `TurnState.party` must be
 *   this same membership, or the chips describe one party's barrier over
 *   another party's roster.
 * @param bellMs milliseconds left on the Bell, or null. Computed by the
 *   gateway; the wall clock is not allowed in this directory.
 */
/**
 * A member who is not in the viewer's world, and where to find them.
 *
 * SUPPLIED BY THE GATEWAY because only the gateway can see across realms — this
 * directory may not reach the realm registry, exactly as it may not call
 * `Date.now`. The ACTOR comes through whole rather than pre-shaped into a row,
 * so every field below is projected here, once, in one place: a gateway that
 * built half a `PartyStateMember` would be a second copy of this projection
 * that drifts the first time a field is added.
 */
export type AwayMember = {
  /** Their real body, in the realm they are actually in. */
  readonly actor: Actor;
  /** That realm's name, for the row. */
  readonly place: string;
  /** Whether `follow` would work for this viewer right now. */
  readonly canFollow: boolean;
};

export function projectPartyState(
  viewer: Actor,
  world: World,
  roster: PartyRoster,
  state: TurnState,
  bellMs: number | null,
  offers: readonly PartyOffer[] = [],
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * MEMBERS WHO ARE ELSEWHERE. DEFAULTS TO EMPTY, WHICH IS THE OLD BEHAVIOUR.
   * ═══════════════════════════════════════════════════════════════════════════
   * A member with no body in this world and no entry here is still dropped —
   * that is right for somebody who has genuinely left the game, whose party row
   * would name a person who is not playing.
   *
   * What it is NOT right for is a member who walked into an instance, which is
   * the case that reached play: the row vanished, and losing your row the
   * instant a fight starts is indistinguishable from being thrown out of the
   * party. The party table was never touched; this projection was the whole bug.
   */
  away: ReadonlyMap<string, AwayMember> = EMPTY_AWAY,
): PartyStateMsg {
  const blocking = new Set(state.whoseTurn);
  const standingBy = new Set(state.standingBy);
  const members: PartyStateMember[] = [];

  for (const id of roster.members) {
    // THE VIEWER'S WORLD FIRST, then the away table. A body can only be in one
    // realm, so these never both answer — and preferring the local one keeps
    // the common case a single Map lookup.
    const elsewhere = world.getActor(id) === undefined ? away.get(id) : undefined;
    const actor = world.getActor(id) ?? elsewhere?.actor;
    if (actor === undefined) continue;
    members.push({
      id: actor.id,
      // Hostile input, filtered here as it is in every other projection, and
      // for the same reason: this is the last function it passes through.
      name: toDisplayName(actor.name),
      // The SAME class icon the turn card wears, so one face means one person
      // across both surfaces rather than two pictures of the same detective.
      portrait: portraitForPlayer(actor.sprite),
      // CARRIED HERE AND NOT ON `PartyMember`, on purpose — see the note on
      // `PartyStateMember`: this pane cannot rely on a join to `ActorView`,
      // because a party member across the floor is exactly who the FOV seam
      // will one day withhold and exactly who the pane most needs to show.
      hp: actor.hp,
      maxHp: actor.maxHp,
      // The turn tracker's own vocabulary and the turn tracker's own precedence
      // — `playerCardState` is shared rather than reimplemented, so the chip in
      // the pane and the chip on the strip can never say different things about
      // the same player on the same screen.
      state: playerCardState(actor, blocking, standingBy, bellMs),
      isLeader: actor.id === roster.leaderId,
      // Never a Discord id on either side of the comparison: both are actor
      // ids, and `actorIdForUser` hashed the snowflake out before either was
      // minted.
      isSelf: actor.id === viewer.id,
      // A DISCONNECTED MEMBER IS STILL A MEMBER. The body stands in the world
      // for its ten-minute grace and stays in the party for all of it; this is
      // the field that says nobody is driving it. See `PartyStateMember.online`.
      online: actor.connected,
      // NULL FOR THE COMMON CASE, and the field is what turns "their row
      // disappeared" into "they are in An Index Breach, and here is the way
      // in".
      away:
        elsewhere === undefined ? null : { place: elsewhere.place, canFollow: elsewhere.canFollow },
    });
  }

  return {
    v: PROTOCOL_VERSION,
    t: 'party_state',
    leaderId: roster.leaderId,
    members,
    invites: toInviteViews(world, offers),
  };
}

/**
 * Offers -> wire rows, dropping any whose ends are no longer in the world.
 *
 * A ROW NAMING SOMEBODY WHO IS NOT THERE IS WORSE THAN NO ROW: the engine
 * refuses such an invite anyway (the party it named has dissolved with the
 * body), so drawing it would put a button on screen whose only possible outcome
 * is a refusal. Shared by both projections so the two lists cannot disagree
 * about which offers exist.
 */
/** Allocated once — `projectPartyState` runs per party per pump. */
const EMPTY_AWAY: ReadonlyMap<string, AwayMember> = new Map<string, AwayMember>();

function toInviteViews(world: World, offers: readonly PartyOffer[]): PartyInviteView[] {
  const views: PartyInviteView[] = [];
  for (const offer of offers) {
    const from = world.getActor(offer.fromId);
    if (from === undefined) continue;
    views.push({
      fromId: from.id,
      fromName: toDisplayName(from.name),
      size: offer.size,
      expiresInMs: offer.expiresInMs,
    });
  }
  return views;
}
