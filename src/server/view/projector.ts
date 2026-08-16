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
 * WHAT M1 DELIBERATELY DOES NOT DO.
 *
 * `projectLevel` returns the WHOLE 30x30 map and `projectActors` returns EVERY
 * actor, unfiltered. That is a deliberate M1 shortcut, not an oversight: M1's
 * definition of done is two people seeing each other move on a hand-authored
 * map, and there is no hidden information in the game yet — no monsters, no
 * traps, no loot. Sending the whole level is also the correct long-term answer
 * for the TERRAIN of an already-explored floor; it is the ACTORS on it that must
 * be filtered, and that is why the two are separate functions below.
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
import { PROTOCOL_VERSION } from '../../shared/version.ts';
import { downedView } from '../engine/downed.ts';
import { EffectStatus, effectDef, effectsOn } from '../engine/effects.ts';
import { aimTile, currentTile, turnsToImpact } from '../engine/projectile.ts';
import type {
  ActorEffects,
  ActorView,
  CooldownsMsg,
  EffectView,
  EffectsMsg,
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
import type { DownedState } from '../engine/downed.ts';
import type { EffectState } from '../engine/effects.ts';
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
 * Class icon per player sprite family. `icon_character_the_detective` is the
 * generic and it is a real portrait rather than a placeholder — three of the six
 * playable sprites have no cut icon yet (enforcer, voidling, cipher-clerk), and
 * "a detective" is what the fiction calls all of them anyway.
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
    range: talent.range,
    minRange: talent.minRange,
    shape: talent.shape,
    radius: talent.radius,
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
    resource: {
      kind: resource.kind,
      current: resource.current,
      max: resource.max,
      discrete: resource.discrete,
    },
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
export function projectEffects(world: World, effects: EffectState): EffectsMsg {
  const actors: ActorEffects[] = [];

  for (const actor of world.allActors()) {
    if (!actor.alive) continue;

    const live = effectsOn(effects, actor.id);
    if (live.length === 0) continue;

    const badges: EffectView[] = [];
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
export function projectPartyState(
  viewer: Actor,
  world: World,
  roster: PartyRoster,
  state: TurnState,
  bellMs: number | null,
  offers: readonly PartyOffer[] = [],
): PartyStateMsg {
  const blocking = new Set(state.whoseTurn);
  const standingBy = new Set(state.standingBy);
  const members: PartyStateMember[] = [];

  for (const id of roster.members) {
    const actor = world.getActor(id);
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
