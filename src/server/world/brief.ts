// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/engines/default/engine/Quest.lua:26-29 — PENDING, DONE, FAILED
//        t-engine4 game/engines/default/engine/interface/ActorQuest.lua:50 — one per id, ever
//        t-engine4 game/modules/tome/class/Player.lua:234 — the FLOOR is in the id
//        t-engine4 game/modules/tome/class/Player.lua:228-239 — leaving the floor fails it
//        t-engine4 game/modules/tome/class/GameState.lua:2601 — `check_level`, the instance
//        t-engine4 game/modules/tome/class/GameState.lua:2630-2634 — last chance, then nil
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      A BRIEF — ONE OBJECTIVE, ONE FLOOR, ONE INSTANCE, AND NO SAVE FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ruling this implements, verbatim: *"temporary companions in level usually
 * come with an in level quest. so either way the companion npc is gone by the
 * time you exit that floor. so the companion needs a proper in level quest
 * variety, whether its bodyguard to destination or elite mob kill, etc."*
 *
 * ═══ THE FLOOR IS IN THE IDENTITY, AND THAT IS UPSTREAM'S OWN TRICK ═══
 * `tome/class/Player.lua:234` builds `"escort-duty-"..zone.short_name.."-"..level.level`
 * and `tome/class/GameState.lua:2593` builds `"id-challenge-"..level.level`. In
 * both, the floor number is part of the quest's NAME, which is what makes "you
 * walked off the floor" a string lookup rather than a rule somebody has to
 * remember to apply. Ours is `brief:<siteId>:<floor>` for the same reason, and
 * `briefIdFor` is the only place it is spelled.
 *
 * ═══ WHY THIS IS NOT A QUEST SYSTEM, STATED WHERE IT WOULD BECOME ONE ═══
 * `docs/tome-port.md` cuts `Quest` outright. A brief is the narrowest thing
 * that can carry the ruling above and it stays narrow by three mechanisms
 * rather than by good intentions:
 *
 *   ONE FIELD.  `Realm.brief` is a single optional field, so a second
 *               concurrent objective on one floor cannot be represented. That
 *               is upstream's rule too — `engine/interface/ActorQuest.lua:50`
 *               is `if self:hasQuest(quest.id) then return end`, and the id
 *               contains the floor.
 *   ONE HOME.   Nothing else stores a brief: no map in the gateway, no field on
 *               a session, and nothing on `CharacterFile`. A brief is not
 *               persisted and never has been; the moment it is, the cut above
 *               is gone.
 *   ONE EDGE.   It dies when the last body leaves the floor (`closeFloorBriefs`),
 *               which is upstream's `check_level = nil`
 *               (`tome/class/GameState.lua:2614`, `:2618`, `:2624`, `:2634`).
 *
 * ═══ PURE, AND THE MUTATIONS ARE FUNCTIONS THE GATEWAY CALLS ═══
 * `src/server/world/` may not reach `net/`, and this file is imported by the
 * realm registry and by the gateway. So it holds types and functions over a
 * `Realm` and nothing else: no socket, no clock, no RNG. Every brief mutation
 * happens from the gateway BETWEEN pumps, which is the rule
 * `engine/scheduler.ts` states for anything that can move a labelled RNG draw.
 */

import { ActorKind, ActorRank } from '../../shared/protocol.ts';
import { areEnemies } from '../engine/actor.ts';
import { bearingWord } from '../../shared/coords.ts';
import { canWalk } from '../../shared/level.ts';
import { standFolk } from '../content/townsfolk.ts';
// FROM THE LEAF AND NOT FROM THE REGISTRY, which is the one line that keeps
// this module out of an import cycle: the registry reaches `content/briefs.ts`
// for a site's authored objectives, and that file reaches back here for
// `BriefKind`. See `world/stairs.ts`.
import { stairsDownOf } from './stairs.ts';

import type { MonsterActor, Sided } from '../engine/actor.ts';
import type { Realm } from './realms.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { TownsfolkSpec } from '../content/townsfolk.ts';
import type { BriefView } from '../../shared/protocol.ts';

/**
 * WHAT KIND OF OBJECTIVE IT IS. Two, and the second carries two shapes.
 *
 * ═══ TWO, NOT EIGHT, AND NOT THREE ═══
 * A member of an `as const` union that nothing constructs is dead code every
 * reader has to check for callers. Briefs are not persisted, so adding a kind
 * later migrates nothing and costs nothing — which removes the usual argument
 * for declaring the whole family up front.
 */
export const BriefKind = {
  /**
   * Unmake one named body. Upstream's nearest shape is the Infinite Dungeon's
   * exterminate challenge, `tome/class/GameState.lua:2692-2705`, which writes
   * the objective onto the body itself at grant time.
   */
  Quarry: 'quarry',
  /** Walk somebody to a tile. Upstream: `escort-duty` and its `escort_portal` grid. */
  Escort: 'escort',
} as const;
export type BriefKind = (typeof BriefKind)[keyof typeof BriefKind];

/**
 * THE FOUR STATES — `engine/Quest.lua:26-29`, minus the one we do not need and
 * plus the one upstream does not have.
 *
 * Upstream has PENDING (`:26`), COMPLETED (`:27`), DONE (`:28`) and FAILED
 * (`:29`). COMPLETED/DONE is a two-step for quests whose reward is claimed in a
 * conversation after the deed; a brief pays at the moment it closes, so the two
 * collapse into one.
 *
 * `Offered` is OURS and upstream has nothing like it: `grantQuest("escort-duty")`
 * fires on entering the level (`tome/class/Player.lua:170`), so upstream's quest
 * exists before you have spoken to anybody and declining FAILS an already-granted
 * quest. Ours is not granted until a party agrees to it, which is why walking
 * away from one produces no failure line at all — nobody agreed to anything.
 */
export const BriefState = {
  /** On the floor, offered, un-agreed. Not on anybody's strip. */
  Offered: 'offered',
  /** Taken. `engine/Quest.lua:26` PENDING. */
  Open: 'open',
  /** Met. `engine/Quest.lua:28` DONE. */
  Closed: 'closed',
  /** Not met, and the floor is behind you. `engine/Quest.lua:29` FAILED. */
  Failed: 'failed',
} as const;
export type BriefState = (typeof BriefState)[keyof typeof BriefState];

/**
 * WHAT ENDS IT — a discriminated union, because the two kinds are asked
 * completely different questions and neither field is meaningful to the other.
 */
export type BriefTarget =
  | {
      readonly k: typeof BriefKind.Quarry;
      /**
       * The body that must come apart. NULL UNTIL THE ACCEPT SPAWNS IT.
       *
       * The name is authored and known the moment the floor is armed; the body
       * is not, because a quarry standing on the floor before anybody agreed to
       * hunt it is an extra elite on a floor that was measured without one.
       * Upstream marks the body AT GRANT TIME for the same class of reason —
       * `tome/class/GameState.lua:2698` says it is done then *"to prevent
       * summons and any newly spawned npcs from preventing completion"*.
       */
      actorId: string | null;
      /** The name it kept. What the offerer says, and what the card reads. */
      readonly name: string;
      /**
       * THE FIRST LINE OF ITS CARD, once the party can see it.
       *
       * `tome/class/GameState.lua:2702` writes the objective onto the body
       * itself, `e.desc = "#LIGHT_RED#EXTERMINATE THIS FOE#LAST#\n"..e.desc`.
       * It CONFIRMS and it never reveals: a card exists only for a body inside
       * the reader's own seen set (`view/inspect.ts`), so this is the answer to
       * *"is this the one?"* and never to *"where is it?"*.
       */
      readonly mark: string;
    }
  | {
      readonly k: typeof BriefKind.Escort;
      readonly at: TileXY;
      /**
       * WHAT HAPPENS WHEN THEY ARRIVE, and the whole difference between the two
       * escort shapes.
       *
       *   'leaves' — the destination is this floor's way out. They step onto it
       *              and go.
       *   'stays'  — the destination is a place on this floor. They stay there
       *              and the party walks back unescorted, which is what stops
       *              the second half being the most tedious minute this design
       *              could produce.
       */
      readonly after: 'leaves' | 'stays';
    };

/**
 * WHAT IT PAYS.
 *
 * ═══ A NOTIONAL CORPSE, NOT A BESPOKE NUMBER ═══
 * `level` and `rank` are fed to `worthExp` (`shared/progression.ts`) exactly as
 * a kill is. Denominating the payout in the units of the fight is what makes it
 * rescale with the floor without a second table to tune — and `worthExp`
 * already carries upstream's anti-farming floor (`tome/class/Actor.lua:6514`,
 * a body far beneath you is worth nothing), which a bespoke reward number
 * would quietly not.
 */
export type BriefReward = {
  readonly level: number;
  readonly rank: ActorRank;
  /** One item id, dropped ON THE FLOOR at the close. Absent is ordinary. */
  readonly item?: string;
};

/** The live objective on one floor of one instance. */
export type Brief = {
  /** `brief:<siteId>:<floor>` — see `briefIdFor`. */
  readonly id: string;
  readonly kind: BriefKind;
  /** The instance it belongs to. Upstream's `check_level`, `tome/class/GameState.lua:2601`. */
  readonly realmId: string;
  /** What the strip shows. Never a system word: the player never reads "brief". */
  readonly title: string;
  /** One sentence, for the Case Log line on the accept. */
  readonly detail: string;
  state: BriefState;
  /**
   * The lead who took it, and null while it is merely offered. Their PARTY is
   * paid and their party is who the strip is sent to.
   */
  acceptedBy: string | null;
  /** The body, while one exists. Escort only. */
  companionId: string | null;
  /**
   * THE PERSON WHO IS OFFERING IT, while they are standing on the floor.
   *
   * They are placed by `armBrief` and taken away by `declineBrief` or by the
   * floor's edge, so this is null before the first and after the last. It is an
   * ID AND NOT A BODY for this codebase's standing reason: a reaped corpse and
   * a realm being torn down both make a held reference a way to keep a dead
   * object alive.
   */
  offererId: string | null;
  readonly target: BriefTarget;
  /** Null when the brief has no count. Neither shipped kind has one. */
  progress: { readonly done: number; readonly total: number } | null;
  readonly reward: BriefReward;
};

/**
 * THE AUTHORED CONTENT A BRIEF IS BUILT FROM.
 *
 * ═══ THE TYPE IS HERE AND THE SPECS ARE NOT ═══
 * `SiteDef.briefs` needs this type, and `world/realms.ts` may not import the
 * authored table without pulling monster templates and prose into the realm
 * registry. So the SHAPE lives beside the live object it builds, exactly as
 * `Roamer` does, and the authored instances live in `content/`.
 */
export type BriefSpec = {
  readonly id: string;
  readonly kind: BriefKind;
  /** Which floors of its site may carry it, inclusive. */
  readonly floors: readonly [number, number];
  readonly title: string;
  readonly detail: string;
  readonly reward: BriefReward;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO OFFERS IT — AN ORDINARY `Faction.Townsfolk` PERSON WITH A SPEC.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The dialogue window is reachable through two gates, re-checked on every
   * frame of a conversation (`net/gateway.ts#dialogueStanding`): the body must
   * be `Faction.Townsfolk`, and `specForActorId` must find a spec behind its id.
   * BOTH ARE SATISFIED RATHER THAN WIDENED, which is zero edits to `handleTalk`
   * and zero to the standing check.
   *
   * Townsfolk buys four things before the accept and none of them is incidental:
   * `areEnemies` short-circuits on the faction, so nothing on the floor can kill
   * the offerer before the party has met them; `anyContact` is faction-aware, so
   * they raise no engagement and do not keep an empty floor ticking; the
   * cleared-count filter excludes them, so an un-accepted offerer cannot block
   * the case being filed; and the verb menu already gives them `Talk to` and
   * suppresses `Attack`.
   *
   * AND THE FICTION IS RIGHT, which is the part worth keeping: a person standing
   * in a delve that nothing is attacking is somebody the floor has not noticed
   * yet.
   */
  readonly offerer: TownsfolkSpec;
  /** Quarry only: the name the body kept, and the line its card opens with. */
  readonly quarry?: { readonly name: string; readonly mark: string };
  /** Escort only. */
  readonly escort?: { readonly after: 'leaves' | 'stays' };
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BRIEF AS THE PERSON OFFERING IT DESCRIBES IT, TO ONE ASKER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A READ-ONLY SNAPSHOT and never the `Brief` itself: `content/` may not reach
 * `net/`, and a chat action holding the live object could write to it from
 * inside a `text` closure, which runs on every frame of every window.
 *
 * ═══ `band` AND `bearing` ARE COMPUTED FOR THIS ASKER'S OWN BODY ═══
 * `Party.lua:410-418` is upstream's escortee answering the same question IN
 * WORDS — three distance bands and a compass direction, never a mark on the
 * map. Four people standing in four places get four different answers and all
 * four are true, which is also what settles the log routing: the answer is a
 * `personal` one and goes only to the person who asked.
 *
 * Both are undefined until there is somewhere to point at: a quarry has no tile
 * until the accept marks a body, which is exactly what makes finding it a search.
 */
export type BriefSnapshot = {
  readonly title: string;
  readonly detail: string;
  readonly state: BriefState;
  /** What it pays, in the offerer's own words. An offer states its price. */
  readonly reward: BriefReward;
  /** The name the quarry kept, for the sentence that names it. Quarry only. */
  readonly name?: string;
  /** `very close` / `close` / `still far away` — `Party.lua:412-414`. */
  readonly band?: string;
  /** `north-east`, `east` — `shared/coords.ts#bearingWord`. */
  readonly bearing?: string;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ID, AND IT IS SPELLED IN EXACTLY ONE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream builds the same string twice, in two systems, and both put the floor
 * in it: `tome/class/Player.lua:234` and `tome/class/GameState.lua:2593`. The
 * property that buys is worth stating: two floors of one delve can never share
 * a brief, and "is this the brief I took?" is a string comparison rather than a
 * tuple somebody has to remember to compare all of.
 */
export function briefIdFor(siteId: string, floor: number): string {
  return `brief:${siteId}:${String(floor)}`;
}

/**
 * Which authored brief this floor carries, or undefined for a floor with none.
 *
 * FIRST MATCH WINS AND THERE IS NO ROLL. `content/delve.ts` records that *"every
 * number in `DELVES` was authored and measured"*, and a brief adds an elite body
 * to a floor sized without one — so which floors carry one is authored until
 * somebody has measured the cost of the extra body. The roll, when it lands,
 * belongs at realm BUILD and off `world.rng.fork('brief')`: a new `rng.int` in
 * that path would consume a position in the world's labelled stream and shift
 * every draw after it, which is every delve any player has ever seen.
 */
export function briefSpecFor(
  specs: readonly BriefSpec[] | undefined,
  floor: number,
): BriefSpec | undefined {
  return specs?.find((spec) => spec.floors[0] <= floor && floor <= spec.floors[1]);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ARM THE FLOOR — `tome/class/Player.lua:140-171` `onEnterLevel`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called by the gateway on arrival, and again after a party wipe. Both callers
 * are the same line, which is what makes the wipe case free: a wipe reaps every
 * monster on the floor and `resetFloor`'s own header says *"A RESET MEANS THE
 * FIGHT DID NOT HAPPEN"* — so the brief is re-armed from scratch rather than
 * exempted from the reap, and a companion that fell before the wipe comes back
 * because this function does not care whether the last one died.
 *
 * ═══ IDEMPOTENT, WHICH UPSTREAM GETS BY CONSTRUCTION AND WE MUST STATE ═══
 * `engine/interface/ActorQuest.lua:50` refuses a second grant of an id the
 * player already holds. Upstream's arrivals are once per level; ours are not —
 * a party walks back up a stair and down it again — so the guard is written out.
 *
 * @returns the brief now on the realm, or undefined when this floor carries none.
 */
export function armBrief(realm: Realm): Brief | undefined {
  // ALREADY ARMED. A second arrival changes nothing, and neither does a second
  // call in one pump.
  if (realm.brief !== undefined) return realm.brief;
  const spec = briefSpecFor(realm.briefs, realm.floor);
  if (spec === undefined) return undefined;
  const target = targetFor(spec, realm);
  // THE CONTENT DECLINES TO PLACE ITSELF AND IS SIMPLY ABSENT — upstream's own
  // first answer when a piece of content will not go down:
  // `tome/class/GameState.lua:2510-2511` un-marks the event before running it
  // and re-marks it only if it returned something, so an event that declined
  // simply did not happen. The other sanctioned answer is to regenerate the
  // level, which here would rebuild a floor the party is standing on.
  if (target === undefined) return undefined;
  // ═══ AND THE PERSON WHO OFFERS IT IS STOOD UP ═══ Near the arrival cluster,
  // so a party meets them before committing to a route, and never ON it: being
  // body-checked by four people the instant they cross is the same poor first
  // impression `placeTownsfolk` keeps its own distance for.
  //
  // NOBODY TO OFFER IT MEANS NO OBJECTIVE. A floor with no room for a body is
  // upstream's `findEventGrid` giving up (`tome/class/GameState.lua:2310-2320`),
  // and its first sanctioned outcome is the one taken here: the content declines
  // to place itself and is simply absent. The other — regenerate the level — is
  // a floor the party is standing on being rebuilt under them.
  const at = offererCell(realm);
  if (at === undefined) return undefined;
  const brief: Brief = {
    id: briefIdFor(realm.siteId ?? realm.id, realm.floor),
    kind: spec.kind,
    realmId: realm.id,
    title: spec.title,
    detail: spec.detail,
    state: BriefState.Offered,
    acceptedBy: null,
    companionId: null,
    offererId: standFolk(realm.world, spec.offerer, at),
    target,
    progress: null,
    reward: spec.reward,
  };
  realm.brief = brief;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WIPE UNDOES A BRIEF. IT DOES NOT FAIL IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `turn-engine.ts`'s `resetFloor` is a total undo and its own header says so —
 * *"A RESET MEANS THE FIGHT DID NOT HAPPEN"*. It stands the party up at full,
 * dispels everything, reaps EVERY monster (`if (actor.kind === 'monster')
 * reap(actor.id)`), sweeps the ground and re-runs the floor's population. A
 * brief that survived a reset would be the one thing a wipe did not undo, and
 * an objective naming a body that the reset deleted is an objective that can
 * never close.
 *
 * ═══ AND `resetFloor` GETS NO EXEMPTION, WHICH IS THE WHOLE POINT ═══
 * The obvious answer is to spare the offerer and the marked body from the reap.
 * This is better, and the reasons are worth writing down because the exemption
 * is what a reader will reach for:
 *
 *   ONE RULE INSTEAD OF THREE. *Everything the brief added, the brief re-adds.*
 *     No clause in the scheduler, no side record of what fell, no second path
 *     that restores a body to full and clears its cooldowns.
 *   IT FIXES THE HARD CASE FOR FREE. `armBrief` does not care whether the last
 *     offerer died, so a floor whose objective had already failed comes back
 *     offerable — which an exemption would have needed its own ledger for.
 *   IT KEEPS THE EXEMPTION OUT OF A LOAD-BEARING LINE. `turn-engine.ts` records
 *     that its reap guard is deliberately POSITIVE — `kind === 'monster'`, never
 *     "not a player" — and a faction clause bolted onto it is exactly the edit
 *     that survives a test written against the fixture rather than the rule.
 *
 * NOTHING IS FARMED BY IT: the reward is paid only on a close, and wipe churn
 * already prices repeat attempts.
 *
 * @returns the freshly offered brief, or undefined for a floor carrying none.
 */
export function rearmBrief(realm: Realm): Brief | undefined {
  // DROPPED FIRST, BECAUSE `armBrief` IS IDEMPOTENT. Its guard is what makes a
  // party of four arriving one at a time arm one objective rather than four;
  // here it would make a wipe change nothing at all.
  realm.brief = undefined;
  return armBrief(realm);
}

/**
 * Where the offerer stands: the nearest cell to the arrival that is far enough
 * from it, walkable, empty, and not a way in or out.
 *
 * ═══ A RING WALK AND NOT A DRAW, WHICH IS `placeTownsfolk`'s RULE VERBATIM ═══
 * *"A draw here would do two bad things at once: move her between boots... and
 * shift the seeded stream for everything that draws after her, which is every
 * fight in that realm."* Arming happens on arrival, after the floor's own
 * population has been rolled, so a draw here would re-roll nothing already on
 * the floor and everything after it — which is worse, not better. Radius-major,
 * then row-major, first match wins, identical on every machine.
 *
 * NOT ON A SITE TILE. `canEventGrid` (`tome/class/GameState.lua:2296-2298`)
 * refuses a `change_level` or `special` grid, and ours refuses anything in
 * `realm.sites` for the same reason: a body standing on the stair is a body
 * between the party and the way on.
 */
function offererCell(realm: Realm): TileXY | undefined {
  const from = realm.spawns[0];
  if (from === undefined) return undefined;
  const { level } = realm.world;
  const spawns = new Set(realm.spawns.map((t) => `${String(t.x)},${String(t.y)}`));
  for (let radius = OFFERER_MIN_FROM_ARRIVAL; radius <= OFFERER_MAX_FROM_ARRIVAL; radius += 1) {
    for (let y = from.y - radius; y <= from.y + radius; y += 1) {
      for (let x = from.x - radius; x <= from.x + radius; x += 1) {
        // THE RING AND NOT THE DISC: a cell nearer than `radius` was offered by
        // an earlier pass and refused, so re-offering it here would make the
        // walk quadratic for nothing.
        if (Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) !== radius) continue;
        const key = `${String(x)},${String(y)}`;
        if (spawns.has(key) || realm.sites.has(key)) continue;
        if (!canWalk(level, x, y)) continue;
        if (realm.world.actorAt(x, y) !== undefined) continue;
        return { x, y };
      }
    }
  }
  return undefined;
}

/**
 * How far from the arrival the offerer stands. `placeTownsfolk`'s own four, for
 * its own reason, plus a ceiling: a person the party has to cross the floor to
 * find is a person the party never meets, and an objective nobody was offered
 * is the same floor with a body standing in a corner of it.
 */
const OFFERER_MIN_FROM_ARRIVAL = 4;
const OFFERER_MAX_FROM_ARRIVAL = 12;

/**
 * Where the objective is, at the moment the floor is armed.
 *
 * A QUARRY HAS NO TILE YET — the body is spawned by the accept, so only its name
 * is known here. An ESCORT'S DESTINATION IS RESOLVED NOW, because the
 * conversation offering it describes the way there and a destination decided at
 * accept time could not be described before it.
 */
function targetFor(spec: BriefSpec, realm: Realm): BriefTarget | undefined {
  if (spec.kind === BriefKind.Quarry) {
    const quarry = spec.quarry;
    if (quarry === undefined) return undefined;
    return { k: BriefKind.Quarry, actorId: null, name: quarry.name, mark: quarry.mark };
  }
  const after = spec.escort?.after;
  // ═══ 'stays' HAS NO DESTINATION RULE YET, AND IT ARMS NOTHING RATHER THAN
  //     PICKING A WRONG TILE ═══
  // The Errand's destination is a predicate over cells — a lit room on a dark
  // floor, a cell behind a door, the far side of water — and until that
  // predicate exists the only tile this function could offer is the stair,
  // which is the OTHER configuration wearing the wrong words.
  if (after !== 'leaves') return undefined;
  // THE WAY OUT: the stair down where there is one, and otherwise the tile you
  // came in on, which `world/realms.ts` already establishes is *"the door you
  // leave by"* on a last floor.
  const at = stairsDownOf(realm) ?? realm.spawns[0];
  if (at === undefined) return undefined;
  return { k: BriefKind.Escort, at: { x: at.x, y: at.y }, after };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TAKE IT. The lead has answered for the party, and the floor changes.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE LEAD GATE IS UPSTREAM OF HERE. `handleDialogueChoose` refuses a `story`
 * option from a non-lead before any action runs, which is where the author's
 * ruling lives — *"story driving conversations should only be applicable to the
 * host to protect their playthrough"* — and upstream arrives at the same rule
 * from a single-player engine: `tome/class/interface/ActorPartyQuest.lua:28-31`,
 * `:71-74`, `:87-90`, `:98-101` and `:112-115` each open by forwarding the
 * operation to `findMember{main=true}`. There is exactly one quest log in ToME
 * and it belongs to the party's main member.
 *
 * ═══ IDEMPOTENT, AND THAT IS NOT OPTIONAL ═══
 * Two frames can cross. `engine/interface/ActorQuest.lua:50` refuses a second
 * grant of an id the player already holds; ours refuses a second accept of a
 * brief that is no longer merely offered, and answers the caller honestly so
 * the conversation can say nothing rather than say it twice.
 *
 * @returns the brief now open, or undefined when there was nothing to take.
 */
export function acceptBrief(realm: Realm, leadId: string): Brief | undefined {
  const brief = realm.brief;
  if (brief === undefined || brief.state !== BriefState.Offered) return undefined;
  /**
   * ═══ THE QUARRY IS NAMED NOW, NOT WHEN THE FLOOR WAS ARMED ═══
   * Upstream marks the body AT GRANT TIME and says why in one line —
   * `tome/class/GameState.lua:2698`, *"to prevent summons and any newly spawned
   * npcs from preventing completion"*. Ours has a second reason of its own: a
   * body that already answered to a name before anybody agreed to hunt it would
   * be an objective the floor was advertising, and the whole of `Offered` is
   * that nobody has agreed to anything yet.
   *
   * BEFORE THE STATE MOVES, so a floor with nothing left to name refuses the
   * accept outright rather than opening an objective that can never close. The
   * offer stands and the conversation says nothing.
   */
  if (brief.target.k === BriefKind.Quarry) {
    const body = markQuarry(realm, brief.target.name, brief.target.mark);
    if (body === undefined) return undefined;
    brief.target.actorId = body.id;
  }
  brief.state = BriefState.Open;
  brief.acceptedBy = leadId;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT THIS TIME — AND REFUSING DELETES THE CONTENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/class/GameState.lua:2974-2976` is `for _, m in ipairs(mlist) do
 * m:disappear() m:removed() end`: upstream removes the encounter on a refusal
 * rather than leaving it standing. Ours does the same, for the same reason — an
 * offer you may decline and then walk back to is an offer with no weight, and a
 * person who keeps asking is furniture.
 *
 * NO REPROACH AND NO SECOND ASK, AND THAT IS A DEPARTURE. Upstream writes its
 * refusals as contempt — `modules/tome/data/quests/` is ABSENT from this
 * checkout, so that is read off the design pass that reconstructed the escort
 * from its call sites rather than off a line anybody here can open. The lead is
 * declining on behalf of three other people, sometimes for good reasons, and
 * the game must not make that a moral event.
 *
 * @returns the brief as it was, for the line the party reads, or undefined.
 */
export function declineBrief(realm: Realm): Brief | undefined {
  const brief = realm.brief;
  if (brief === undefined || brief.state !== BriefState.Offered) return undefined;
  clearOfferer(realm, brief);
  realm.brief = undefined;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE BODY ON THIS FLOOR KEPT ITS NAME — AND IT IS ONE THAT WAS ALREADY THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ MARKED, NOT SPAWNED, AND THAT IS A MEASUREMENT ARGUMENT ═══
 * `content/delve.ts` records that *"every number in `DELVES` was authored and
 * measured"*, and `populateDelve` rolls a floor's roster from ToME's own
 * `nb_npc` band with rarity weighting and `actor_adjust_level`. Adding an elite
 * body at the accept would be a population increase on a floor sized without
 * one — a change to the fight that nobody measured, arriving through a
 * conversation. Naming one of the bodies already standing there costs the floor
 * nothing and is the same objective.
 *
 * ═══ DETERMINISTIC, AND NOT A DRAW ═══
 * `content/delve.ts` states the rule this obeys: a new `rng.int` on this path
 * *"would consume a position in the world's labelled stream and shift every
 * draw after it"*. So the choice is computed — the highest rank first, because
 * the under-token ring is the only thing on the wire that says "this one
 * matters" and a quarry drawn as trash reads as trash; then the furthest from
 * the arrival, which is the measure `populateDelve` already puts its boss by,
 * so the name is at the far end of a floor that has to be crossed; then the id,
 * so a tie has one answer on every machine.
 *
 * FOG IS NOT CONSULTED AND MUST NOT BE. This picks a body; what the party can
 * SEE of it is decided where it always is — `view/projector.ts` filters the
 * actor list against each viewer's own seen set and `view/inspect.ts` refuses a
 * card for a body outside it. A mark cannot reveal what fog withholds, because
 * the mark travels on the body and the body does not travel at all.
 */
export function markQuarry(realm: Realm, name: string, mark: string): MonsterActor | undefined {
  const from = realm.spawns[0];
  const party: Sided = { kind: ActorKind.Player };
  let best: MonsterActor | undefined;
  let bestRank = -1;
  let bestAway = -1;
  for (const body of realm.world.allActors()) {
    if (body.kind !== ActorKind.Monster || !body.alive) continue;
    // AN ENEMY OF THE PARTY, through the predicate that states the rule once.
    // It excludes the offerer standing four tiles away, and it will exclude a
    // companion the day one can stand here, with no second copy of the rule.
    if (!areEnemies(body, party)) continue;
    const rank = RANK_ORDER.indexOf(body.rank);
    const away =
      from === undefined ? 0 : Math.max(Math.abs(body.x - from.x), Math.abs(body.y - from.y));
    const better =
      best === undefined ||
      rank > bestRank ||
      (rank === bestRank && away > bestAway) ||
      (rank === bestRank && away === bestAway && body.id < best.id);
    if (!better) continue;
    best = body;
    bestRank = rank;
    bestAway = away;
  }
  if (best === undefined) return undefined;
  // ═══ THE NAME IS THE MARK ON THE MAP; THE LINE IS THE MARK ON THE CARD ═══
  // Upstream writes the objective onto the body itself — `GameState.lua:2702`
  // prepends `EXTERMINATE THIS FOE` to `e.desc`. Ours does both halves on the
  // body for the same reason: a fact carried by the body travels exactly as far
  // as the body is visible, and no further.
  best.name = name;
  best.mark = mark;
  return best;
}

/**
 * Rank, weakest first, so `indexOf` is an ordering.
 *
 * WRITTEN OUT rather than derived from `ActorRank`'s declaration order, because
 * that order is a vocabulary and this is a comparison — a member inserted into
 * the middle of the union would silently re-rank every body in the game.
 */
const RANK_ORDER: readonly ActorRank[] = [ActorRank.Normal, ActorRank.Elite, ActorRank.Boss];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE PUMP JUST DID TO THE OBJECTIVE. The only place a brief advances.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called by the gateway from its post-pump sweep, beside the cleared check. A
 * brief is mutated BETWEEN pumps and never inside one, which is
 * `engine/scheduler.ts`'s standing rule: the pump walks one frozen actor
 * snapshot and every RNG draw in it is labelled and ordered, so anything that
 * can change a formula's answer moves the stream.
 *
 * ═══ WHOEVER OR WHATEVER KILLED IT ═══
 * A trap, another monster, burning ground, or the party. Upstream already pays
 * the player for any rank-above-3 death regardless of who swung
 * (`tome/class/Actor.lua:2983-2995`), and generalising that removes a whole
 * class of feel-bad. Upstream's `headhunter` does the opposite
 * (`tome/class/GameState.lua:2960-2972`) because that objective is about ORDER;
 * ours is not, so we do not take it.
 *
 * ═══ IT ASKS THE BODY, NOT THE PUMP'S DEATH LIST, AND THAT IS THE RULE ═══
 * The obvious shape is to scan `result` for a `death` event naming the quarry,
 * and it is wrong in a way no unit test would have caught: THE FLOOR'S OWN
 * DAMAGE EMITS NO `death` EVENT AT ALL. `turn-engine.ts#hitToWire` takes the
 * heal's exit on `ambient` — *"one `damage` frame, no verb, no swinger"* —
 * because a burning tile has nobody to name, so a quarry killed by a zone or a
 * trap dies with only a `damage` frame behind it. A death-list reading of
 * *"whoever or whatever killed it"* would therefore have excluded the one
 * killer that is not a who at all. Measured over a socket: the body at 0 hp and
 * not alive, the objective still open.
 *
 * ASKING THE BODY also covers the case the list cannot represent — a body that
 * is GONE. A floor reset reaps every monster, so `getActor` answering undefined
 * is the honest end of a quarry that no longer exists; a wipe then re-arms the
 * whole objective from scratch (`rearmBrief`) and this never fires for it,
 * because the reset clears `Open` before the next pump reads it.
 *
 * @returns the brief IF it changed state in this pump, and undefined otherwise.
 */
export function noteBriefProgress(realm: Realm): Brief | undefined {
  const brief = realm.brief;
  if (brief === undefined || brief.state !== BriefState.Open) return undefined;
  if (brief.target.k !== BriefKind.Quarry) return undefined;
  const wanted = brief.target.actorId;
  if (wanted === null) return undefined;
  const body = realm.world.getActor(wanted);
  if (body !== undefined && body.alive) return undefined;
  brief.state = BriefState.Closed;
  return brief;
}

/**
 * WHERE THE REWARD LANDS: the objective's own tile, and nobody's bag.
 *
 * `docs`' house rule for material things is first-come off the ground —
 * `spillLoot` puts a corpse's carry on its tile and gold is whoever gets there
 * first — and upstream asks the party who wants it through a dialog
 * (`tome/class/Party.lua:456-463`) that we have no equivalent of and should not
 * build for one case. An item that always went to the lead would make the lead a
 * hoarder by construction; an item on the floor makes the close a moment with a
 * thing lying in it, and the party sorts it out in the voice channel.
 *
 * `undefined` for a brief whose objective has left the world — a quarry already
 * reaped — and the caller then pays the experience and no item.
 */
export function rewardCell(realm: Realm, brief: Brief): TileXY | undefined {
  return objectiveCell(realm, brief);
}

/**
 * The offerer's body, taken off the floor and forgotten.
 *
 * REMOVED AND NEVER KILLED: `removeActor` leaves no `died` event, no corpse, no
 * loot and no Record kill line, which is upstream's `disappear()` + `removed()`
 * pair — `tome/class/Party.lua:136-139` is the half of it that IS in this
 * checkout, and it is what `leftLevel` does to a temporary member. A quest-giver who
 * leaves a body behind is a quest-giver somebody looted.
 */
function clearOfferer(realm: Realm, brief: Brief): void {
  if (brief.offererId === null) return;
  realm.world.removeActor(brief.offererId);
  brief.offererId = null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE OFFERER SAYS ABOUT IT, TO THIS ASKER, RIGHT NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Built per asker and never cached, because the two interesting fields are
 * facts about where THIS body is standing. See `BriefSnapshot`.
 *
 * `undefined` WHEN THIS SPEAKER IS NOT THE ONE OFFERING IT, which is what keeps
 * the brief rows out of every other conversation in the game: the chat graph is
 * projected from a person's spec and the rows are conditional on this answer,
 * so a shopkeeper in Threadneedle is asked the same question and says no.
 */
export function briefSnapshotFor(
  realm: Realm,
  speakerId: string,
  asker: TileXY,
): BriefSnapshot | undefined {
  const brief = realm.brief;
  if (brief === undefined || brief.offererId !== speakerId) return undefined;
  const name = brief.target.k === BriefKind.Quarry ? brief.target.name : undefined;
  const at = objectiveCell(realm, brief);
  const where =
    at === undefined
      ? {}
      : {
          band: distanceBand(Math.hypot(at.x - asker.x, at.y - asker.y)),
          bearing: bearingWord(at.x - asker.x, at.y - asker.y),
        };
  return {
    title: brief.title,
    detail: brief.detail,
    state: brief.state,
    reward: brief.reward,
    ...(name === undefined ? {} : { name }),
    ...where,
  };
}

/**
 * Where the objective is, or undefined while nothing on the floor is it yet.
 *
 * A QUARRY HAS NO TILE UNTIL THE ACCEPT NAMES A BODY, which is deliberate and
 * is what makes finding it a search on a fifty-by-fifty floor: before the
 * accept the offerer can say what it is and what it pays, and not where.
 */
function objectiveCell(realm: Realm, brief: Brief): TileXY | undefined {
  if (brief.target.k === BriefKind.Escort) return brief.target.at;
  if (brief.target.actorId === null) return undefined;
  const body = realm.world.getActor(brief.target.actorId);
  return body === undefined ? undefined : { x: body.x, y: body.y };
}

/**
 * `tome/class/Party.lua:412-414`, ported as its three bands and no fourth:
 *
 * ```lua
 * if dist < 8 then dist = "very close"
 * elseif dist < 16 then dist = "close"
 * else dist = "still far away" end
 * ```
 *
 * EUCLIDEAN, because upstream's is — `core.fov.distance` (`Party.lua:411`) is a
 * straight-line radius and the bands were chosen against it. This is a sentence
 * somebody reads and then walks, so it is deliberately coarse: a number would be
 * a map mark with extra steps, and `BeaconView`'s header is emphatic that an
 * objective's position is *"the intelligence the fog exists to withhold"*.
 */
export function distanceBand(distance: number): string {
  if (distance < 8) return 'very close';
  if (distance < 16) return 'close';
  return 'still far away';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLOOR'S EDGE — `tome/class/Player.lua:228-239` and `Party.lua:123-139`,
 * both driven from one place, `tome/class/Game.lua:1024`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called by the gateway from both crossing seams, BEFORE the body is taken out
 * of the world it is leaving — after that the question can no longer be
 * evaluated, because the member who was standing near the destination is gone.
 *
 * Upstream fails an unfinished escort unconditionally on `onLeaveLevel`, and it
 * can, because it has one player and leaving IS emptying. Ours asks the
 * emptiness question first and the gateway owns it: one member stepping
 * downstairs while three keep fighting is a party that has split up, which the
 * barrier already tolerates.
 *
 * ═══ AN UNACCEPTED BRIEF IS REAPED IN SILENCE ═══
 * It returns undefined for one, and that is the whole of the rule: nobody
 * agreed to anything, so there is nothing to report and no line to write. The
 * floor a refusing party walks is the floor it would have been.
 *
 * @returns the brief AS IT ENDED when that is something the party must be told,
 *          and undefined when there is nothing to say.
 */
export function closeFloorBriefs(realm: Realm): Brief | undefined {
  const brief = realm.brief;
  // UPSTREAM'S `check_level = nil` (`tome/class/GameState.lua:2614`, `:2618`,
  // `:2624`, `:2634`): nothing may reach back into a floor nobody is standing
  // on. Unconditional, and it happens whatever the state was.
  realm.brief = undefined;
  if (brief === undefined) return undefined;
  /**
   * ═══ THE PERSON GOES, WHATEVER THE STATE WAS ═══
   * `tome/class/Party.lua:123-139` `leftLevel` deletes the level's temporary
   * members unconditionally, and ours is the same statement: the offerer is a
   * fact about a floor being walked, so a floor nobody is standing on has
   * nobody left to offer anything to. The QUARRY is not touched — it is a
   * monster on a floor now, and the floor is behind you.
   */
  clearOfferer(realm, brief);
  /**
   * ═══ ONE GUARD, AND IT CARRIES BOTH HALVES OF THE RULE ═══
   * There is something to report only about an objective that was OPEN at the
   * moment the floor emptied, and the two states it excludes are excluded for
   * two different reasons:
   *
   *   OFFERED          nobody agreed to anything, so there is nothing to fail
   *                    and no line anybody earned. Upstream cannot do this —
   *                    `grantQuest` fires on entering the level
   *                    (tome/class/Player.lua:170), so ITS quest exists before
   *                    you have spoken to anybody and leaving fails it.
   *   CLOSED / FAILED  it ended in the pump it ended in, which is where it paid
   *                    and where it said its piece. The edge has nothing to add.
   *
   * WRITTEN ONCE RATHER THAN TWICE. A separate `Offered` arm above this line
   * read well and was unreachable: deleting it changed no behaviour and no test,
   * which is the definition of a line that is not carrying its own rule.
   */
  if (brief.state !== BriefState.Open) return undefined;
  /**
   * ═══ THE LAST CHANCE BELONGS HERE, AND THERE IS NOTHING YET TO CHECK ═══
   * `tome/class/GameState.lua:2630-2632` runs `on_exit_check` at the moment of
   * leaving and only then forces the failure. For an escort whose destination
   * IS the way out that is the main success path rather than an edge case — the
   * companion is standing on the tile you are stepping off. No kind carries a
   * close condition until one has a body on the floor, so today every open
   * brief fails here, and the check goes in above this line when the first one
   * does.
   */
  brief.state = BriefState.Failed;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GOES ON THE WIRE, AND WHO IT GOES TO. ONE RULE, NOT THREE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The strip shows WHAT YOUR PARTY TOOK ON. Everything else falls out of that
 * single sentence rather than needing a case of its own:
 *
 *   OFFERED     `acceptedBy` is null, nobody is in a null party, so nobody gets
 *               a frame. An offer you have not accepted is not an objective; it
 *               is a person standing on the floor, and the Case Log announces
 *               them once.
 *   OPEN        the accepting party, and only them.
 *   CLOSED/FAILED the accepting party, with the true state — the client stops
 *               drawing a brief that has ended, and the Case Log carries the
 *               outcome. Nothing on this frame is a secret; `state` is verbatim
 *               on the wire the way `ActorView.faction` is.
 *
 * ═══ NO POSITION, AND THAT IS A RULE RATHER THAN AN OMISSION ═══
 * `BeaconView`'s header forbids a beacon carrying a hostile on the grounds that
 * a position is *"the intelligence the fog exists to withhold"*. A mark on this
 * frame would be a beacon under another name and one field away from pointing
 * at a quarry. An objective's location reaches a player out of somebody's mouth,
 * off terrain they have seen, or off the body's own card once it is in sight.
 */
export function briefViewFor(
  brief: Brief | undefined,
  viewer: string,
  party: readonly string[],
): BriefView | null {
  if (brief === undefined) return null;
  const taker = brief.acceptedBy;
  if (taker === null) return null;
  // THE VIEWER'S OWN PARTY, asked at send time rather than recorded at accept
  // time — somebody who joined after the accept reads the strip, exactly as
  // they are paid by the close.
  if (taker !== viewer && !party.includes(taker)) return null;
  const progress = progressText(brief.progress);
  return {
    state: brief.state,
    title: brief.title,
    ...(progress === undefined ? {} : { progress }),
  };
}

/**
 * "1 / 3", and undefined for a brief with no count — which is both shipped
 * kinds. Upstream's own player display carries the counter as text for the same
 * reason the strip does: a number in a colour is a number nobody reads out in a
 * voice channel.
 */
export function progressText(
  progress: { readonly done: number; readonly total: number } | null,
): string | undefined {
  if (progress === null) return undefined;
  return `${String(progress.done)} / ${String(progress.total)}`;
}
