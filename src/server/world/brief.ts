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

import { ActorKind, ActorRank, TileCode } from '../../shared/protocol.ts';
import { DEFAULT_SIGHT_RADIUS } from '../../shared/sight.ts';
import { FOLLOW_LEASH } from '../ai/npc.ts';
import { Faction, areEnemies } from '../engine/actor.ts';
import { DIR_ORDER, DIR_VECTORS, bearingWord, chebyshev } from '../../shared/coords.ts';
import { canWalk, tileAt } from '../../shared/level.ts';
import { monsterInit } from '../content/monsters.ts';
import { standFolk } from '../content/townsfolk.ts';
// FROM THE LEAF AND NOT FROM THE REGISTRY, which is the one line that keeps
// this module out of an import cycle: the registry reaches `content/briefs.ts`
// for a site's authored objectives, and that file reaches back here for
// `BriefKind`. See `world/stairs.ts`.
import { stairsDownOf } from './stairs.ts';

import type { EngineActor, MonsterActor, MonsterInit, Sided } from '../engine/actor.ts';
import type { MonsterTemplate } from '../content/monsters.ts';
import type { Realm } from './realms.ts';
import type { TileXY } from '../../shared/coords.ts';
import type { TownsfolkSpec } from '../content/townsfolk.ts';
import type { BriefView, LevelView } from '../../shared/protocol.ts';

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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE BODY ITSELF, BESIDE ITS ID — IDENTITY, NOT PRESENCE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `turn-engine.ts` already solved this exact shape once and wrote the rule
       * out: *"`world.getActor(id) === body` is the whole test, and it has to be
       * the OBJECT and not merely 'is something there', because the re-seeded
       * body answers to the same string."*
       *
       * A delve's roster is minted with INDEX ids (`delve_<i>`, `content/delve.ts`).
       * A party wipe reaps every monster inside the pump and re-seeds the floor
       * with a fresh roll, so `delve_7` after a wipe is a brand-new, full-health
       * body that has nothing to do with the one somebody agreed to unmake —
       * and when the new roll is SHORTER than the old one, the id resolves to
       * nothing at all. Both were read as *"it is not standing there any more,
       * so it must be done"*, and both paid the party for a floor they died on.
       *
       * So the id names it on the floor and this names it in memory. An id that
       * resolves to a DIFFERENT object, or to nothing, is a floor that deleted
       * the body — which is VOID, and never done.
       */
      body: MonsterActor | null;
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
  /**
   * THE BODY WALKING WITH THE PARTY, while one is. Escort only, and null both
   * before the accept and after the close.
   *
   * IT IS THE SAME BODY AS `offererId`, WHICH IS THE WHOLE SHAPE OF THE KIND.
   * The person standing on the floor offering to be taken out IS the person
   * you then take out; accepting flips their faction rather than spawning a
   * second body (`acceptBrief`). So this field is not a second placement — it
   * is the record that the body standing there is now in the fight, and the
   * floor's edge removes it through `clearOfferer` exactly once.
   */
  companionId: string | null;
  /**
   * THE BODY ITSELF, BESIDE ITS ID — IDENTITY, NOT PRESENCE.
   *
   * `BriefTarget.body` states this rule in full for the quarry and it is the
   * same rule for the same reason: a party wipe reaps every monster on the
   * floor and re-seeds it, so "the id no longer resolves" means THE FLOOR
   * DELETED IT and never "they died". A dead companion is a corpse still
   * standing on the tile it fell on — `alive` false, the same object — and
   * that is the only thing that fails this brief.
   */
  companion: MonsterActor | null;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ESCORT ONLY — WHERE THEY ARE GOING, AND WHAT THEY ARE MADE OF.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `body` IS A SHEET AND NOT A SECOND PERSON. `offerer` above is who they are
   * — the name, the face, the things they say — and this is what they can take
   * and what they can swing, because the body that offers an escort has to be
   * able to walk through the fight it is asking you to walk it through. A
   * Townsfolk stood up by `standFolk` alone cannot: five hundred hit points, no
   * weapon, no aggro range, harmless by construction, which is exactly right
   * for a shopkeeper and useless for somebody who has to survive a floor.
   *
   * A TEMPLATE RATHER THAN NUMBERS HERE, so the sheet lives beside every other
   * creature's in `content/monsters.ts` and is validated by the same rules.
   */
  readonly escort?: { readonly after: 'leaves' | 'stays'; readonly body: MonsterTemplate };
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
 * ═══ AND `hasQuest` IS THE OTHER HALF OF IT, WHICH WAS CITED AND NOT BUILT ═══
 * A live-field guard alone only refuses a second arrival while the first brief
 * is still ON the realm — and the floor's edge clears that field. So walking
 * out of the delve mouth and straight back in through the same door minted the
 * SAME id on the SAME instance a second time, with a second quarry, a second
 * payout and a second lamp on the floor. Measured over a socket: `xp 0 -> 36 ->
 * 72` for both members, two `Done:` lines, two lamps.
 *
 * `Realm.granted` is `hasQuest`, and it is what makes `Brief.id` load-bearing
 * rather than decorative. It lives on the INSTANCE, so a genuinely new instance
 * — one opened after the last one's linger ran out — offers the floor's work
 * again, which is the same lifetime `check_level` has upstream.
 *
 * @returns the brief now on the realm, or undefined when this floor carries none.
 */
export function armBrief(realm: Realm): Brief | undefined {
  // ALREADY ARMED. A second arrival changes nothing, and neither does a second
  // call in one pump.
  if (realm.brief !== undefined) return realm.brief;
  const spec = briefSpecFor(realm.briefs, realm.floor);
  if (spec === undefined) return undefined;
  // ONE PER ID, EVER, ON THIS INSTANCE — `engine/interface/ActorQuest.lua:50`,
  // `if self:hasQuest(quest.id) then return end`. See the header.
  const id = floorBriefId(realm);
  if (realm.granted.has(id)) return undefined;
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
    id,
    kind: spec.kind,
    realmId: realm.id,
    title: spec.title,
    detail: spec.detail,
    state: BriefState.Offered,
    acceptedBy: null,
    companionId: null,
    companion: null,
    offererId: standFolk(realm.world, spec.offerer, at, companionSheet(realm, spec, at)),
    target,
    progress: null,
    reward: spec.reward,
  };
  // WRITTEN WHERE THE BRIEF IS, AND NOT AT THE FLOOR'S EDGE. Every path that
  // ends one — the accept, the decline, the close, the failure, the last body
  // out — then needs no line of its own, and a brief that was armed and never
  // answered is as spent as one that was finished.
  realm.granted.add(id);
  realm.brief = brief;
  return brief;
}

/**
 * The id the objective on THIS floor of THIS instance would carry.
 *
 * SPELLED ONCE, because `armBrief` writes it into `Realm.granted` and
 * `rearmBrief` has to take the same string back out — and an id built two ways
 * is an id that is only equal by luck.
 */
function floorBriefId(realm: Realm): string {
  return briefIdFor(realm.siteId ?? realm.id, realm.floor);
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
  // AND THE GRANT GOES WITH IT, FOR THE SAME REASON. `Realm.granted` is
  // `hasQuest` and it is what stops a floor's work being re-minted by walking
  // out and back in; a wipe is not walking out. *"A RESET MEANS THE FIGHT DID
  // NOT HAPPEN"* — so the floor is handed back exactly as it was on arrival,
  // which includes being offerable. Nothing is farmed by it: the reward is paid
  // only on a close, and wipe churn already prices a repeat attempt.
  realm.granted.delete(floorBriefId(realm));
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
 * HOW MUCH ROOM AN ERRAND'S DESTINATION HAS TO HAVE — five of eight neighbours
 * walkable. See `errandCell`: a party and a companion have to be able to stand
 * there together, which is exactly what the close condition asks for.
 */
const ERRAND_MIN_OPEN = 5;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE PERSON OFFERING AN ESCORT IS MADE OF — AND A QUARRY'S OFFERER IS
 * MADE OF NOTHING, WHICH IS `standFolk`'s DEFAULT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `undefined` for every kind but the Escort, and `standFolk` then stands up the
 * harmless body it always has: five hundred hit points nothing may touch, no
 * weapon, no aggro range. That is exactly right for somebody who will never be
 * in the fight, and it is the wrong body entirely for somebody the party is
 * about to walk through one.
 *
 * ═══ THE SHEET IS BUILT AT ARM TIME, WHICH IS WHEN THE FLOOR IS WHOLE ═══
 * `monsterInit` is the same function every body on this floor was born
 * through, so a companion grows its life, its stats and its talent ranks by the
 * rules the roster grew by rather than by a table of its own.
 */
function companionSheet(realm: Realm, spec: BriefSpec, at: TileXY): MonsterInit | undefined {
  const escort = spec.escort;
  if (escort === undefined) return undefined;
  return monsterInit(escort.body, at, companionLevel(realm, spec));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW DEEP A COMPANION IS — READ OFF THE FLOOR, NEVER AUTHORED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream levels its escortee off the zone's own ordinary roll —
 * `reknor-escape/zone.lua:26` is
 * `zone.base_level + e:getRankLevelAdjust() + level.level-1 + rng.range(-1,2)`,
 * the identical line every body on that floor is born through. Ours cannot call
 * that expression: it takes a labelled RNG draw, and `content/delve.ts` states
 * what a new draw on a live world costs — *"it would consume a position in the
 * world's labelled stream and shift every draw after it"*. A body stood up on
 * arrival must move no draw at all.
 *
 * SO IT READS THE ANSWER INSTEAD OF RE-DERIVING IT. The deepest body the floor
 * actually put down is that expression already evaluated, jitter and rank term
 * and all, and it rescales with every future change to the delve curve with no
 * second table to keep in step. A hand-authored level is a number that goes
 * stale silently.
 *
 * AT ARM TIME, so it is the floor as the party found it. Reading it at the
 * accept would make a companion recruited after a good fight weaker than one
 * recruited before it, which is an objective punishing the party for playing.
 *
 * AND AN EMPTY FLOOR FALLS BACK TO WHAT THE BRIEF PAYS, because `BriefReward`
 * is already denominated as a notional corpse of this floor — the one number in
 * the spec that is a statement about this floor's depth.
 */
function companionLevel(realm: Realm, spec: BriefSpec): number {
  const party: Sided = { kind: ActorKind.Player };
  let deepest = 0;
  for (const body of realm.world.allActors()) {
    if (body.kind !== ActorKind.Monster || !body.alive) continue;
    // THROUGH THE ONE PREDICATE, so the offerer already standing on a re-armed
    // floor and a companion from a brief before this one are both excluded
    // without a second copy of the rule.
    if (!areEnemies(body, party)) continue;
    deepest = Math.max(deepest, body.level);
  }
  return (deepest === 0 ? spec.reward.level : deepest) + COMPANION_LEVEL_BONUS;
}

/**
 * ONE LEVEL OVER THE DEEPEST THING ON THE FLOOR.
 *
 * Upstream's escortee takes the zone's ordinary roll with no bonus at all, and
 * ours takes one because ours is doing a different job: ToME's Norgan walks
 * beside ONE player through a corridor, and a companion here walks in front of
 * up to four through a room sized for four. One level is the smallest step that
 * is not zero, it is inside the jitter upstream's own roll already spans
 * (`rng.range(-1,2)`), and it is a single number to move when the probe says so.
 */
const COMPANION_LEVEL_BONUS = 1;

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
    return {
      k: BriefKind.Quarry,
      actorId: null,
      body: null,
      name: quarry.name,
      mark: quarry.mark,
    };
  }
  const after = spec.escort?.after;
  if (after === undefined) return undefined;
  // THE WAY OUT: the stair down where there is one, and otherwise the tile you
  // came in on, which `world/realms.ts` already establishes is *"the door you
  // leave by"* on a last floor.
  //
  // ═══ OR A PLACE ON THIS FLOOR, WHICH IS THE ENTIRE DIFFERENCE ═══
  // `errandCell` picks it, and the two configurations share every other line in
  // the feature: one walks somebody to the door and the other walks them to
  // somewhere they wanted to be.
  const at = after === 'leaves' ? (stairsDownOf(realm) ?? realm.spawns[0]) : errandCell(realm);
  if (at === undefined) return undefined;
  return { k: BriefKind.Escort, at: { x: at.x, y: at.y }, after };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ERRAND'S DESTINATION — A PREDICATE OVER CELLS, NOT AN AUTHORED PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is what makes the Errand the cheapest variety in this design and why it
 * is different on every seed: nobody writes down where it is, the floor
 * answers. Three preferences, best first, and the first one any cell satisfies
 * wins its whole rank:
 *
 *   A LAMP IN THE DARK. A lit cell on a floor whose own arrival is unlit. Our
 *     caves are dark (`SHAPE_LIGHTING`, `world/realms.ts`) and what light
 *     there is was put there by the generator, so a lit cell in a dark mine is
 *     somewhere somebody made — which is a reason to want to be taken to it.
 *   A ROOM BEHIND A DOOR. A cell beside a closed door: the party has to open
 *     something to finish, and a door is the one piece of terrain this game
 *     draws that reads as a threshold.
 *   ANYWHERE FAR FROM BOTH ENDS. The fallback, and the reason this function
 *     cannot fail on a floor that has any ground at all.
 *
 * ═══ AND TWO THINGS A CELL MUST BE BEFORE ANY OF THAT — BOTH MEASURED ═══
 * The three preferences above answer *"which of these is interesting"*. They do
 * not answer *"is this a place at all"*, and the tie-break below actively works
 * against it: maximising the distance from both ends of the floor pushes the
 * answer into the corners. MEASURED over 24 seeds of the Underworks before
 * these two lines: EIGHTEEN put the destination on the map's outer ring —
 * (0,16), (1,0), (49,44) — and rendered through the real client that is a place
 * with nothing drawn around it, no beacon and no marker, which the party is
 * told to walk somebody to.
 *
 *   NOT THE OUTER RING. A tile with the edge of the world on one side is the
 *     end of the map, not a room. ~5% of a floor's walkable cells are on it and
 *     the tie-break preferred almost all of them.
 *   ROOM AROUND IT. `ERRAND_MIN_OPEN` of the eight neighbours walkable — enough
 *     that a party and a companion can stand there together, which is what the
 *     close condition asks for. A dead end in the rock is somewhere you can
 *     reach and not somewhere anybody wanted to be taken. Measured on the same
 *     floors: roughly half of all walkable cells pass, so this narrows the
 *     choice without ever emptying it.
 *
 * ═══ FAR FROM BOTH, WHICH IS NOT "FURTHEST" ═══
 * The tie-break is `min(distance from the arrival, distance from the stair)`,
 * maximised. Ranking on the arrival alone would put the errand in the same
 * corner the stair is in on most floors, and the Errand would become the Walk
 * Out with extra steps — the exact collapse this configuration exists to avoid.
 *
 * ═══ A SWEEP AND NOT A DRAW, AND ROW-MAJOR SO IT IS TOTAL ═══
 * `offererCell`'s rule verbatim: a draw here would shift the seeded stream for
 * everything that draws after it, which is every fight in the realm. Ties break
 * on row then column, so two machines answer identically.
 *
 * ═══ WHAT IS NOT BUILT, SAID PLAINLY ═══
 * *"The far side of water"* is in the design's list and is not here. It is a
 * reachability question — far side OF WHAT, from WHERE — and answering it
 * honestly needs a flood fill this function has no reason to own. The two
 * preferences that ARE here are single-cell predicates, which is why they cost
 * one sweep.
 */
function errandCell(realm: Realm): TileXY | undefined {
  const from = realm.spawns[0];
  if (from === undefined) return undefined;
  const { level, lit } = realm.world;
  // NULL IS "THIS FLOOR HAS NO STAIR DOWN" — a last floor — and the tie-break
  // below then has one end to measure from instead of two.
  const stair = stairsDownOf(realm) ?? undefined;
  // A DARK FLOOR IS ONE WHOSE OWN ARRIVAL IS UNLIT. Asked once, off the tile
  // every party starts on, rather than counted over the whole map: a lit works
  // has a lit doorstep and a cave does not, which is the distinction the
  // preference is about.
  const dark = lit[from.y * level.w + from.x] === 0;
  let best: TileXY | undefined;
  let bestRank = -1;
  let bestAway = -1;
  for (let y = 0; y < level.h; y += 1) {
    for (let x = 0; x < level.w; x += 1) {
      if (!canWalk(level, x, y)) continue;
      // A PLACE BEFORE A PREFERENCE — see the header. Both of these are about
      // whether the cell is somewhere at all, so they sit above the ranks
      // rather than inside them.
      if (x === 0 || y === 0 || x === level.w - 1 || y === level.h - 1) continue;
      if (openAround(level, x, y) < ERRAND_MIN_OPEN) continue;
      const key = `${String(x)},${String(y)}`;
      // NEVER A WAY IN OR OUT — `canEventGrid` (`tome/class/GameState.lua:2296-2298`)
      // refuses a `change_level` grid, and walking somebody onto the stair is
      // the OTHER configuration.
      if (realm.sites.has(key)) continue;
      if (realm.spawns.some((t) => t.x === x && t.y === y)) continue;
      const awayFromDoor = chebyshev({ x, y }, from);
      // FURTHER THAN THE PERSON WHO ASKS, so the errand is always a walk from
      // where the party met them. Derived rather than a second literal.
      if (awayFromDoor < OFFERER_MAX_FROM_ARRIVAL) continue;
      const away =
        stair === undefined ? awayFromDoor : Math.min(awayFromDoor, chebyshev({ x, y }, stair));
      const rank = dark && lit[y * level.w + x] !== 0 ? 2 : behindDoor(realm, x, y) ? 1 : 0;
      if (rank < bestRank || (rank === bestRank && away <= bestAway)) continue;
      best = { x, y };
      bestRank = rank;
      bestAway = away;
    }
  }
  return best;
}

/**
 * HOW MANY OF THE EIGHT NEIGHBOURS A BODY COULD STAND ON. Eight-way, because
 * movement is eight-way and the question is how much room there is here.
 */
function openAround(level: LevelView, x: number, y: number): number {
  let open = 0;
  for (const dir of DIR_ORDER) {
    const vector = DIR_VECTORS[dir];
    if (canWalk(level, x + vector.dx, y + vector.dy)) open += 1;
  }
  return open;
}

/** A cell with a closed door beside it — four ways, the way a door opens. */
function behindDoor(realm: Realm, x: number, y: number): boolean {
  const { level } = realm.world;
  return (
    tileAt(level, x + 1, y) === TileCode.DOOR ||
    tileAt(level, x - 1, y) === TileCode.DOOR ||
    tileAt(level, x, y + 1) === TileCode.DOOR ||
    tileAt(level, x, y - 1) === TileCode.DOOR
  );
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
    // AND THE BODY, NOT ONLY ITS NAME ON THE FLOOR. See `BriefTarget.body`: a
    // wipe re-mints this id onto a different monster, and the close asks which
    // OBJECT it is looking at.
    brief.target.body = body;
  }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND AN ESCORT'S BODY CHANGES SIDES — THE SAME BODY, IN THIS ORDER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Nothing is spawned. The person who has been standing there offering to be
   * taken out IS the companion, and accepting is what puts them in the fight:
   * before it `areEnemies` short-circuits on `Townsfolk`, so nothing on the
   * floor may touch them and they raise no engagement; after it they are on the
   * party's side of the one predicate and every husk on the floor can see them.
   *
   * ═══ THE ORDER IS UPSTREAM'S OWN LESSON, IN A DIFFERENT PLACE ═══
   * ToME sets `ai_state.tactic_leash` BEFORE calling `addMember` precisely so
   * that `tome/class/Party.lua:69`'s `or 10` default cannot overwrite it. Ours
   * is the same lesson: the anchor is written before the faction, because a
   * `Squad` body with nothing to follow is what one pump between those two
   * lines would produce — and `actMonster`'s idle gate reads the faction.
   *
   * ═══ AND THE RANK IS NOT TOUCHED, WHICH THE DESIGN SAID IT WOULD BE ═══
   * The plan for this step was to promote the body to `ActorRank.Elite` here,
   * on the argument that *"the under-token ring is the only thing on the wire
   * that says this one matters"*. THAT ARGUMENT DOES NOT SURVIVE
   * `client/render/canvas.ts#ringIdFor`: its faction branch answers
   * `ui_token_ring_neutral` for a Townsfolk, a Bound shadow and a Squad
   * companion alike, and RETURNS — the rank is read only on the line below it,
   * which a body on your own side never reaches. An Elite companion and a
   * Normal one are drawn identically.
   *
   * SO THE RANK LIVES WHERE IT BUYS SOMETHING: on the template, where
   * `monsterInit` spends it through `rankLifeAdjust` at arm time. A write here
   * would have been a line that changed one number nothing reads.
   */
  if (brief.target.k === BriefKind.Escort) {
    const body = brief.offererId === null ? undefined : realm.world.getActor(brief.offererId);
    // NOBODY LEFT TO WALK ANYWHERE. The offer refuses rather than opening an
    // objective with no body in it — the same guard, and the same reason, as
    // the quarry's above.
    if (body === undefined || body.kind !== ActorKind.Monster || !body.alive) return undefined;
    body.anchorId = leadId;
    body.faction = Faction.Squad;
    brief.companionId = body.id;
    // AND THE OBJECT, NOT ONLY THE ID. See `Brief.companion`.
    brief.companion = body;
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
 * ═══ AND IT ASKS FOR THE OBJECT, NOT FOR THE ID — IDENTITY, NOT PRESENCE ═══
 * The first version read *"gone from the world"* as *"unmade"*, and its own
 * header argued for it. IT PAID THE PARTY FOR WIPING. `resetFloor` runs INSIDE
 * the pump, reaps every monster and re-seeds the floor with a fresh roll, and
 * this sweep runs on the far side of that in the same breath — so a quarry at
 * `delve_21` on a floor whose new roll holds twenty-one bodies resolved to
 * nothing, read as unmade, paid both members and wrote *"Done:"* into the Case
 * Log of a party that had just died. Measured over a socket: xp 0 -> 36 each,
 * on a floor they never cleared, re-offerable in the same pump.
 *
 * `turn-engine.ts` had already written the rule down for the identical bug —
 * *"`world.getActor(id) === body` is the whole test, and it has to be the
 * OBJECT and not merely 'is something there', because the re-seeded body
 * answers to the same string"*. So:
 *
 *   THE SAME OBJECT, DEAD          the objective is met. The reap window has
 *                                  not run yet, so the corpse is still there to
 *                                  read a tile off for the reward.
 *   A DIFFERENT OBJECT, OR NONE    the floor deleted it. That is VOID, not
 *                                  done: nothing is paid, nothing is said, and
 *                                  the wipe branch re-arms the whole objective
 *                                  from scratch a few lines later.
 *
 * @returns the brief IF it changed state in this pump, and undefined otherwise.
 */
export function noteBriefProgress(realm: Realm): Brief | undefined {
  const brief = realm.brief;
  if (brief === undefined || brief.state !== BriefState.Open) return undefined;
  if (brief.target.k === BriefKind.Escort) return noteEscort(realm, brief, brief.target);
  const wanted = brief.target.actorId;
  const marked = brief.target.body;
  if (wanted === null || marked === null) return undefined;
  // IDENTITY, NOT PRESENCE. An id that now names a different body — or nothing
  // at all — is a floor that unmade its own monster, and a floor doing that is
  // a floor being reset under a party that just died.
  if (realm.world.getActor(wanted) !== marked) return undefined;
  if (marked.alive) return undefined;
  brief.state = BriefState.Closed;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ESCORT ASKS TWO QUESTIONS OF ONE BODY: IS IT STILL STANDING, AND IS IT
 * THERE YET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * IN THAT ORDER, AND THE ORDER IS THE RULE. A companion that fell on the
 * destination tile has not arrived; upstream's escort is `disappear()` at the
 * portal and a corpse cannot walk through one. Asking "arrived?" first would
 * pay the party for a body they failed to keep alive, on the tile it died on.
 *
 * ═══ IDENTITY, NOT PRESENCE — THE QUARRY'S OWN LESSON, AND IT IS SHARPER HERE ═══
 * `resetFloor` reaps every monster on the floor inside the pump and this sweep
 * runs on the far side of that in the same breath. So "the id no longer
 * resolves" is what a WIPE looks like from here, not what a death looks like: a
 * body that died is a corpse still standing where it fell, `alive` false and
 * the same object. Reading absence as death would fail the brief for a party
 * that is about to have the whole floor handed back to them by `rearmBrief`,
 * and the failure line would be the last thing they read before it.
 */
function noteEscort(
  realm: Realm,
  brief: Brief,
  target: Extract<BriefTarget, { k: typeof BriefKind.Escort }>,
): Brief | undefined {
  const walking = brief.companion;
  if (brief.companionId === null || walking === null) return undefined;
  if (realm.world.getActor(brief.companionId) !== walking) return undefined;
  if (!walking.alive) {
    brief.state = BriefState.Failed;
    // THE BODY IS NOT TAKEN AWAY. A corpse on the floor is what the party can
    // see, and the reap window buries it with everything else that died this
    // pump — a companion deleted by its own objective would vanish out of the
    // room mid-fight with no frame that says why.
    brief.companionId = null;
    brief.companion = null;
    return brief;
  }
  // BEFORE THE ARRIVAL QUESTION AND AFTER THE DEATH ONE: a body that is about
  // to be paid for does not need an owner, and a corpse cannot follow anybody.
  keepAnchor(realm, walking);
  if (!arrivedEscort(realm, walking, target)) return undefined;
  brief.state = BriefState.Closed;
  landCompanion(realm, brief, target);
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PERSON THEY ARE WITH LEFT THE FLOOR — SO THEY ARE WITH SOMEBODY ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/class/Game.lua:1282-1283`, on re-adding actors after a level change:
 *
 *     if act.ai_state and act.ai_state.tactic_leash_anchor then
 *       act.ai_state.tactic_leash_anchor = self.player
 *     end
 *
 * The anchor is re-pointed at whoever the player currently IS. Upstream has one
 * player and does it on arrival; ours has a party and does it on the floor the
 * companion is standing on, which is the same sentence with more than one
 * person in it.
 *
 * ═══ WITHOUT IT THE SHIPPED OBJECTIVE IS UNWINNABLE FOR HALF A PARTY ═══
 * `anchorId` was written once, at the accept, and cleared once, at the close.
 * Driven over two sockets: lead and mate accept, the lead takes the threshold,
 * and `walking.anchorId` is STILL the departed lead's id — so
 * `scheduler.ts#makeAiCtx`'s `anchorAt` refuses it, the companion never takes
 * another step for the rest of the floor, and her kills pay nobody because
 * `awardExperience`'s owner branch cannot resolve the anchor either. The mate
 * walks to the way out alone and `endOpenBrief` fails it. Splitting at a stair
 * is an ordinary co-op move, not an edge.
 *
 * ═══ ANY PLAYER ON THE FLOOR IS THE ACCEPTING PARTY ═══
 * `arrivedEscort`'s argument, verbatim: an Inner realm holds exactly one party,
 * so the bodies standing on it ARE that party, and asking a party table would
 * mean threading one through `world/` to answer a question the floor already
 * answers.
 *
 * ═══ THREE RULES, EACH A DECISION ═══
 *   ONLY WHEN THE HELD ONE IS GONE. A DOWNED anchor keeps the anchor: `anchorAt`
 *     refuses them deliberately so the companion fights over the body instead
 *     of walking off, and re-pointing on `alive` would undo that.
 *   ONLY TO SOMEBODY ON THEIR FEET. Handing the leash to the nearest body when
 *     that body is face down is the same mistake from the other side.
 *   NOBODY LEFT IS NOT A RE-POINT. That leaver was the last one and
 *     `closeFloorBriefs` is already running; inventing an owner would be
 *     inventing a party row.
 *
 * NEAREST, TIES BY ID. The tie-break is not cosmetic — two members equidistant
 * from a body is the commonest board state there is, and without a total order
 * the answer would depend on iteration order and two machines would diverge.
 */
function keepAnchor(realm: Realm, walking: MonsterActor): void {
  const held = walking.anchorId;
  if (held !== undefined && realm.world.getActor(held)?.kind === ActorKind.Player) return;
  let nearest: EngineActor | undefined;
  for (const body of realm.world.allActors()) {
    if (body.kind !== ActorKind.Player || !body.alive) continue;
    if (nearest === undefined) {
      nearest = body;
      continue;
    }
    const theirs = chebyshev(walking, body);
    const best = chebyshev(walking, nearest);
    if (theirs < best || (theirs === best && body.id < nearest.id)) nearest = body;
  }
  if (nearest !== undefined) walking.anchorId = nearest.id;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HAVE THEY GOT THERE — AND HAS ANYBODY WHO AGREED TO TAKE THEM GOT THERE TOO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ `FOLLOW_LEASH + 1` AND NOT THE TILE ITSELF, BECAUSE THE LEASH IS WHAT
 *     "WITH YOU" MEANS IN THIS GAME ═══
 * A companion follows to within `FOLLOW_LEASH` of its person and then stops —
 * that is the whole of `ai/npc.ts#followStep` and it is what keeps a stationary
 * party at the idle fixed point. So a party standing ON the destination leaves
 * its companion standing up to that far from it, and a close condition reading
 * the destination tile exactly would be a condition the follow rule can never
 * satisfy: the objective would hang until somebody happened to walk a route
 * that pushed the body onto one cell.
 *
 * ═══ AND THE `+ 1` IS THE TILE THE PARTY CANNOT STAND ON ═══
 * `FOLLOW_LEASH` ALONE WAS STILL ONE TILE SHORT, and it was short in the
 * configuration that ships. For `after: 'leaves'` the destination IS the way
 * out, and standing on it is LEAVING (`net/gateway.ts#leaveRealm` fires on the
 * step that lands there) — so the nearest a living party can hold is ONE TILE
 * OFF IT, which holds the companion at `FOLLOW_LEASH + 1`. Rendered through
 * the real client: lead at (34,29), destination (33,28), the companion at
 * (36,29) — chebyshev 3 — and EIGHT TURNS OF WAITING changed nothing, with
 * nothing on screen to say why. The objective then closed only at the seam,
 * where `closeFloorBriefs` re-asks it with the body already half gone.
 *
 * DERIVED AND NOT A SECOND LITERAL: one constant, two uses, and the second is
 * the first plus the tile the rule itself forbids anybody to occupy. Widening
 * it wins nothing — a party may not run ahead, because of the clause below.
 *
 * ═══ AND SOMEBODY WHO TOOK IT ON HAS TO BE IN SIGHT OF IT ═══
 * Otherwise a party accepts, runs ahead, and wins by standing at the stair
 * while the body walks the floor alone behind them. ONE member and never the
 * whole party: a fifty-by-fifty floor with four bodies on it is a floor where
 * the party is usually in two places, and an objective must not become a second
 * reason to stand and wait for somebody.
 *
 * `DEFAULT_SIGHT_RADIUS`, EUCLIDEAN, because that is what this game means by
 * being able to see something (`shared/vision.ts`, `distanceBand` above), and
 * the sentence the rule is written from is *"you were there when they got
 * there"*.
 *
 * ═══ ANY PLAYER ON THE FLOOR IS THE ACCEPTING PARTY ═══
 * An Inner realm holds exactly one party — `Realms.open` is keyed on
 * `(partyId, siteId, floor)` — so the bodies standing on it are that party,
 * which is the same answer `net/gateway.ts#briefAudience` falls back to. It
 * also keeps this file pure: a party table would have to be threaded through
 * `world/` to ask a question the floor already answers.
 */
function arrivedEscort(
  realm: Realm,
  walking: MonsterActor,
  target: Extract<BriefTarget, { k: typeof BriefKind.Escort }>,
): boolean {
  if (chebyshev(walking, target.at) > FOLLOW_LEASH + 1) return false;
  return realm.world
    .allActors()
    .some(
      (a) =>
        a.kind === ActorKind.Player &&
        a.alive &&
        Math.hypot(a.x - target.at.x, a.y - target.at.y) <= DEFAULT_SIGHT_RADIUS,
    );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENS TO THE BODY AT THE CLOSE — THE ENTIRE DIFFERENCE BETWEEN THE
 * TWO CONFIGURATIONS, IN FOUR LINES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   'leaves'  THEY GO. The destination is the way out and they take it, so the
 *             body is REMOVED and never killed — no `died` event, no corpse, no
 *             loot and no Record kill line. Upstream is `disappear()` +
 *             `removed()`, and `tome/class/Party.lua:136-139` is the half of it
 *             that is in this checkout. A quest-giver who leaves a body behind
 *             is a quest-giver somebody looted.
 *   'stays'   THEY STOP BEING YOURS. They are where they asked to be, so the
 *             anchor goes and the faction goes back to `Townsfolk` — which is
 *             not a flourish: leave them `Squad` with an anchor and the follow
 *             rule walks them out of the place you just walked them to, and
 *             every husk on the floor still wants them dead. Townsfolk is the
 *             state they were in before you took them on, and it is the honest
 *             description of somebody the floor has stopped noticing.
 *
 * THE BODY IS NOT REMOVED FOR 'stays' AND THAT IS THE POINT OF THE
 * CONFIGURATION: the party walks back to the stair unescorted, which is what
 * stops the second half of an Errand being the most tedious minute this design
 * could produce. The floor's edge takes them away with everything else.
 */
function landCompanion(
  realm: Realm,
  brief: Brief,
  target: Extract<BriefTarget, { k: typeof BriefKind.Escort }>,
): void {
  const body = brief.companion;
  if (body === null) return;
  brief.companionId = null;
  brief.companion = null;
  if (target.after === 'leaves') {
    realm.world.removeActor(body.id);
    // THE SAME BODY AS THE OFFERER, so the floor's edge has nothing left to
    // clear and must not be left holding an id that resolves to nothing.
    brief.offererId = null;
    return;
  }
  body.anchorId = undefined;
  body.faction = Faction.Townsfolk;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LAST CHANCE, AND IT IS ASKED BEFORE THE BODY IS TAKEN AWAY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `tome/class/GameState.lua:2630-2632` runs `on_exit_check` at the moment of
   * leaving and only then forces the failure. FOR AN ESCORT WHOSE DESTINATION
   * IS THE WAY OUT THAT IS THE MAIN SUCCESS PATH RATHER THAN AN EDGE CASE: the
   * companion is standing on the tile you are stepping off, and the pump that
   * would have noticed it is the one that never runs because the party crossed
   * instead of acting.
   *
   * ═══ ABOVE `clearOfferer`, AND THE TWO CANNOT SWAP ═══
   * An escort's offerer IS its companion, so clearing first would delete the
   * body the condition is about and turn every success at the door into a
   * failure. That is the same ordering rule the gateway applies one layer out
   * — the close runs before `removePlayer`, because after it the member who was
   * standing beside the destination is gone.
   */
  const ended = brief.state === BriefState.Open ? endOpenBrief(realm, brief) : undefined;
  clearOfferer(realm, brief);
  // NOTHING IS WALKING WITH ANYBODY ANY MORE. The body is off the floor a line
  // above; this is the record of it, and it is what stops a torn-down realm
  // holding a live reference to a body nobody can reach.
  brief.companionId = null;
  brief.companion = null;
  if (ended !== undefined) return ended;
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
  return undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN OPEN OBJECTIVE, AT THE MOMENT THE LAST OF THEM STEPS OFF THE FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tome/class/GameState.lua:2624`, `:2631` — the condition is asked one last
 * time and only then forced to a failure. A QUARRY HAS NOTHING TO ASK HERE and
 * takes the failure directly: its condition is a body coming apart, which the
 * post-pump sweep sees in the pump it happens in, so an open quarry at the
 * floor's edge is a quarry still standing. An ESCORT's condition is a position,
 * and positions are exactly what stops being readable one line later.
 *
 * NOT A SECOND COPY OF THE RULE: `arrivedEscort` is the same predicate the
 * sweep asks, called from the second of its two callers.
 */
function endOpenBrief(realm: Realm, brief: Brief): Brief {
  const walking = brief.companion;
  if (
    brief.target.k === BriefKind.Escort &&
    walking !== null &&
    brief.companionId !== null &&
    realm.world.getActor(brief.companionId) === walking &&
    walking.alive &&
    arrivedEscort(realm, walking, brief.target)
  ) {
    brief.state = BriefState.Closed;
    return brief;
  }
  // OTHERWISE IT FAILS, which is the user's ruling sitting in upstream's own
  // source: the quest id contains the floor number
  // (`tome/class/Player.lua:234`), so walking off the floor is DEFINITIONALLY
  // the failure — `tome/class/GameState.lua:2632-2635`.
  brief.state = BriefState.Failed;
  return brief;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GOES ON THE WIRE, AND WHO IT GOES TO. ONE RULE, NOT THREE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The strip shows WHAT THE PARTY HOLDING THIS FLOOR TOOK ON. Everything else
 * falls out of that single sentence rather than needing a case of its own:
 *
 *   OFFERED     `acceptedBy` is null, so nobody gets a frame. An offer you have
 *               not accepted is not an objective; it is a person standing on
 *               the floor, and the Case Log announces them once.
 *   OPEN        the party that holds the floor, and only them.
 *   CLOSED/FAILED the same party, with the true state — the client stops
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
  holders: readonly string[],
): BriefView | null {
  if (brief === undefined) return null;
  if (brief.acceptedBy === null) return null;
  /**
   * ═══ THE PARTY THAT HOLDS THE FLOOR, AND THE READER IS IN IT OR THEY ARE NOT ═══
   * `holders` is the membership of `Realm.partyId` — the party the instance was
   * opened under — read at SEND time rather than recorded at the accept, so
   * somebody who joined afterwards reads the strip exactly as they are paid by
   * the close.
   *
   * IT WAS `taker !== viewer && !party.includes(taker)`, WHICH IS A DIFFERENT
   * QUESTION: *"is the person who answered in the reader's party"*. That made
   * the taker themselves an unconditional reader, so a lead who walked out of
   * the party kept the band on screen for the rest of the floor — measured over
   * a socket, `state: 'open'` for an objective their party no longer held.
   */
  if (!holders.includes(viewer)) return null;
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
