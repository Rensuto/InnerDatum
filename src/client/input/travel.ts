/**
 * TRAVEL: click a tile across the room and walk to it, one turn at a time.
 *
 * ===========================================================================
 * EVERY CHECK IN THIS FILE IS ADVISORY. THE SERVER RE-VALIDATES ALL OF IT.
 * ===========================================================================
 *
 * The same contract input/targeting.ts opens with, and for the same reason. A
 * route computed here is a GUESS about terrain the server owns: nothing below
 * decides whether a step is legal, it only decides which single `{t:'move',dir}`
 * to offer next. A wrong guess costs one refused move — the scheduler refunds it
 * (scheduler.ts:929), the gateway unicasts that refund as an `error` frame, and
 * main.ts's `case 'error'` cancels the walk — and no rule in this file is a
 * second copy of a server rule that could silently diverge into a client that
 * confidently walks into a wall.
 *
 * Two consequences are worth stating outright, because both look like bugs:
 *   - the path is TERRAIN-ONLY (`canWalk`), so it routes straight THROUGH the
 *     tile a body stands on. That is deliberate — path.ts's header explains that
 *     terrain-only pathing is what makes bump-attack fall out for free — and the
 *     occupancy question is asked once, per step, in `nextStep`.
 *   - DIAGONALS ARE ON and CORNER CUTTING IS ALLOWED, because world.ts:442-446
 *     says the server permits it ("RULE SEAM — CORNER CUTTING ... allowed here,
 *     which is what ToME does"). A stricter client rule would refuse routes the
 *     server would happily walk, which is the one direction of divergence a
 *     player actually notices: "it says there is no way through and there is".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A STATE MACHINE AND NOT A LOOP
 * ---------------------------------------------------------------------------
 * The party is PHASE-LOCKED (DECISIONS.md D1): every player action costs exactly
 * one full turn and the whole party decides in one shared window. A five-tile
 * walk is therefore five rounds OF THE ENTIRE PARTY, and a traveller who took
 * them at their own pace would be the straggler everyone waits on.
 *
 * So travel AUTO-COMMITS one step per turn. `nextStep` is asked once per frame
 * batch and answers with at most one direction; sending it IS the commitment
 * (barrier.ts:293-305 — "a submitted intent IS the commitment, even before it
 * resolves"), so a travelling player is the FASTEST to commit rather than the
 * slowest. NOTHING HERE EVER SENDS A `commit`: the move already resolved inside
 * its own pump, a following `commit` would find `pendingIntent === null`, submit
 * a HOLD, and burn the NEXT turn — two turns per tile.
 *
 * ---------------------------------------------------------------------------
 * THE STEP GATE. ALL THREE HALVES ARE LOAD-BEARING
 * ---------------------------------------------------------------------------
 *   (i)   the previous step LANDED — `observeSelfMoved` cleared `awaitingStep`.
 *         Without it, a second move in the same turn lands in `pendingIntent`
 *         (scheduler.ts:858-863) and auto-resolves the instant energy tops up,
 *         pre-committing the next turn behind every interrupt check below.
 *   (ii)  the turn PERMITS acting. In combat that is the self card reading
 *         `waiting` or `bell`. Out of combat it is simply "yes": barrier.ts:143
 *         is explicit that AT ZERO NOBODY EVER BLOCKS, `whoseTurn` is empty and
 *         projector.ts forces every card to `committed` — so a machine that
 *         waited for `waiting` would stall forever exactly when travel is most
 *         used, which is the failure this gate is shaped around.
 *   (iii) THE GAME TURN HAS MOVED ON since the last step this machine issued.
 *
 *         ═══ (i) IS NOT A PER-TURN LATCH ON ITS OWN, AND THAT IS THE BUG ═══
 *         The gateway broadcasts a player's own `moved` BEFORE the `turn` frame
 *         that records the commit (gateway.ts's `pumpAndBroadcast` loops
 *         `playerEvents` first and calls `broadcastTurnIfChanged` last). main.ts
 *         ticks this machine after EVERY applied frame, so the tick that fires
 *         on `moved` sees `awaitingStep` already cleared by `observeSelfMoved`
 *         AND a `turn` snapshot still describing the turn that just ended —
 *         under which gate (ii) says yes (the self card still reads `waiting`,
 *         or `inCombat` is still false). Both halves open and a SECOND move goes
 *         out inside one game turn: precisely what (i) exists to prevent.
 *
 *         `lastStepTurn` is the latch that actually holds, because it is stamped
 *         from the server's own counter rather than from a frame's arrival.
 *         IT DELIBERATELY SURVIVES `cancel()`: cancelling and re-clicking is the
 *         other way two moves reach one turn (main.ts's mousedown cancels before
 *         it starts the new walk), and a latch that reset with the walk would
 *         let a fast double-click through the same hole.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not touch the DOM, the socket, a timer, `Date.now()` or
 * `Math.random()`. It sends nothing and draws nothing: it is fed observations
 * and asked for a direction. That is what lets it be tested under vitest's node
 * environment, which deliberately has no jsdom, and it is why the interrupts
 * that are really INPUT events (a keypress, a mousedown, an `error` frame, a
 * `welcome`) are not in here at all — main.ts owns those and calls `cancel()`,
 * which is idempotent precisely so eleven call sites can all be careless.
 */

import { DIR_ORDER, sameTile, step } from '../../shared/coords.ts';
import { canRoute, canWalk, tileAt } from '../../shared/level.ts';
import { findPathAvoiding } from '../../shared/path.ts';
import { ActorKind, TurnActorState } from '../../shared/protocol.ts';
import { ON_STAND, airOf, breathes } from '../../shared/terrain.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorView, LevelView, TurnMsg } from '../../shared/protocol.ts';
import type { Breather } from '../../shared/terrain.ts';

/**
 * Hard ceiling on A* expansions for one click, DERIVED FROM THE LEVEL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS WAS THE CONSTANT 2048, AND THE REASON GIVEN FOR IT STOPPED BEING TRUE
 * ═══════════════════════════════════════════════════════════════════════════
 * The old note read: "It can never refuse a route that exists on a level this
 * game ships: floors are capped at 40x40 = 1600 tiles." Alderbrook is 64x48 =
 * 3,072 cells. The bound survived the change by luck and by 264 cells — only
 * 1,784 of the city is walkable and `findPath` closes each tile at most once —
 * but a constant that is correct by coincidence is one map edit from being a
 * bug, and the bug is invisible in the worst way: a perfectly legal walk from
 * the office to the Glass Archive returns null, which `begin()` reports as
 * NoRoute and main.ts turns into the sentence "no route to that tile".
 *
 * The player is then told a lie about the map, and it gets WORSE the further
 * they try to travel — which is exactly the one direction of divergence this
 * file's own header calls the kind a player actually notices.
 *
 * So the ceiling is now `w * h`, which by the closed-set argument above can
 * never refuse a route that exists on ANY map, however large, while still
 * bounding a click on the far side of a wall to a fraction of a millisecond.
 * `+ 1` because the check is `expanded > maxNodes` after the increment.
 */
function travelMaxNodes(level: LevelView): number {
  return level.w * level.h + 1;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO TRAVEL RADIUS, AND NO SIGHT RULE HERE EITHER. THE BOARD IS SIGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TRAVEL_ALERT_RADIUS` was 8, measured with `chebyshev`: the authored
 * `aggroRange` of the M2 monsters (monsters.ts:248, :350) and the number
 * `anyContact` arms the engagement clock with (scheduler.ts:1539). It answered
 * "how far can something notice ME", when the question travel asks is "what
 * have I just NOTICED" — upstream stops a run for whatever `spotHostiles`
 * returns, and that walks the player's own sight (Player.lua:849-858). A husk
 * that walked into view at 9 tiles down a corridor never tripped it.
 *
 * It was replaced by `canSee` from this body, because the board used to hold
 * more than this body could see: first every actor on the map, then the whole
 * party's pooled sight. Neither is true now. The server builds each player's
 * board from that player's own eyes at their own sight radius, so a hostile on
 * this client's board IS one this player can see — including by a talent or an
 * item that widens their sight, which a `canSee` at the default radius here
 * could not know about. So the rule is membership, and there is one sight rule,
 * on the server.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE WALKER BREATHES: NOTHING BUT AIR, AND NOTHING STOPS IT DROWNING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A detective carries neither `can_breath` nor `no_breath`. `createPlayerActor`
 * sets neither, no item or talent grants either, and `ActorView` does not carry
 * them, so the empty breather is the true answer for every player today rather
 * than a guess. The day something grants water breathing to a player, this
 * has to come from the wire instead. `buildRestView`'s `losing` flag
 * (`turn-engine.ts`) already reads the real body on the server.
 */
const PLAYER_BREATHER: Breather = Object.freeze({});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE A CLICKED WALK WILL NOT GO — tome/class/Player.lua:1206-1213, verbatim.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- Dont go where you cant breath
 * if not self:attr("no_breath") then
 *   if air_level then
 *     if not air_condition or not self.can_breath[air_condition] or ... <= 0 then return false
 * ```
 *
 * ANY `air_level` THE WALKER CANNOT BREATHE, so the air bubble too: its +15
 * names no condition, and nobody breathes "no condition". That is what keeps a
 * walk across the Weir from spending the bubbles a player will need on the way
 * back. And NOT LAVA: the mouse walk asks about breath and known traps, never
 * about damage. Auto-explore is the one that avoids a burn (`exploreSlowAt`).
 *
 * ADVISORY LIKE EVERYTHING ELSE IN THIS FILE. It picks a route, and the
 * server decides what the ground does to whoever stands on it.
 */
export function mouseWalkRefusesAt(level: LevelView, x: number, y: number): boolean {
  if (PLAYER_BREATHER.noBreath === true) return false;
  const air = airOf(tileAt(level, x, y));
  return air !== undefined && !breathes(PLAYER_BREATHER, air);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GROUND AUTO-EXPLORE GOES AROUND — tome/class/interface/PlayerExplore.lua:1958-1966.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * elseif terrain.mindam or terrain.maxdam then            move_cost + 32
 * elseif terrain.on_stand and not terrain.on_stand_safe then move_cost + 21
 * elseif terrain.air_level and terrain.air_level < 0
 *        and not ((self.can_breath.water or 0) > 0) then   move_cost + 15
 * ```
 *
 * "Slow terrain will be avoided if at all possible" (:1950): burning ground,
 * anything with an `on_stand` (the bubble's is a charge spent), and water this
 * walker cannot breathe. Upstream reads `can_breath.water` here and no
 * `no_breath`, and so does this. `main.ts` hands it to the explore flood.
 */
export function exploreSlowAt(level: LevelView, x: number, y: number): boolean {
  const code = tileAt(level, x, y);
  if (ON_STAND[code] !== undefined) return true;
  const air = airOf(code);
  return air !== undefined && air.level < 0 && !((PLAYER_BREATHER.canBreath?.water ?? 0) > 0);
}

/** What `begin` did. Three answers, never conflated — see path.ts:303-311. */
export const TravelStart = {
  /** A route exists and at least one step is queued. */
  Started: 'started',
  /** `findPath` returned `[]`: the destination is where you already stand. */
  AlreadyThere: 'already-there',
  /** `findPath` returned null: unreachable, a wall, over budget, or off-grid. */
  NoRoute: 'no-route',
} as const;
export type TravelStart = (typeof TravelStart)[keyof typeof TravelStart];

/**
 * What a turn edge did to the walk.
 *
 * ═══ THERE IS DELIBERATELY NO `NoProgress` HERE ANY MORE ═══
 * This enum used to carry one, inferred from "a step is still in flight and a
 * turn frame arrived, so the move must have been refused". That inference is
 * unsound in both directions and it failed both ways in practice:
 *
 *   - FALSE POSITIVE. A `turn` frame is not a game-turn edge and it is not even
 *     about the viewer: `broadcastTurnIfChanged` fires whenever ANY term of
 *     `turnKey` moves, which includes another player committing, another
 *     player's pump advancing `gameTurn`, engagement changing and the Bell
 *     arming. Any of those can legitimately land between a traveller's `move`
 *     going out and their own `moved` coming back, and the walk was killed —
 *     more often the more people were playing, which is exactly backwards.
 *   - FALSE NEGATIVE. A move refused AT RESOLUTION spends no energy, so no clock
 *     advances, so every term of `turnKey` is byte-identical and NO `turn` FRAME
 *     IS SENT AT ALL. The detector that was supposed to catch the refusal was
 *     reachable only from the frame the refusal suppresses.
 *
 * Absence is not a signal. The refund is now UNICAST by the gateway as an
 * `error` frame (see `PumpResult.refusals`), and travel interrupt 10 keys off
 * that instead — main.ts's `case 'error'` already calls `cancel()`.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE MACHINE STOPPED ITSELF. FOUR CANCELS THAT USED TO SAY NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `nextStep` and `observeSelfMoved` can each decide the route is no longer
 * walkable and cancel on the spot. The reasoning for cancelling is written out
 * beside each one and is right — *"the plan the player agreed to no longer
 * exists, and re-routing them somewhere they did not ask for is the one thing a
 * travel system must never do"* — but none of them ever argued for the SILENCE.
 *
 * They returned `null`, main.ts's driver returned on `null`, and the route line
 * vanished with nothing in the log or the status line. main.ts's own header
 * calls a refusal that never reaches the player the worst failure mode in a
 * turn-based game, and travel broke that rule four times.
 *
 * A CODE, NOT A SENTENCE, because main.ts owns travel's prose — every other
 * stop is a `cancelTravel('...')` there, and splitting the voice across two
 * modules is how two of them end up phrased differently.
 */
export const TravelHalt = {
  /** The next route tile stopped being walkable — a door closed, terrain moved. */
  Blocked: 'blocked',
  /** A body is standing on the next route tile. */
  Occupied: 'occupied',
  /** We are not where the route says we are: shoved, teleported or resynced. */
  Displaced: 'displaced',
  /** A `moved` frame arrived for a tile the machine never asked for. */
  Unexpected: 'unexpected',
} as const;
export type TravelHalt = (typeof TravelHalt)[keyof typeof TravelHalt];

export const TravelObservation = {
  Continue: 'continue',
  /** Something hostile arrived. See `hostileAlert`. */
  Hostile: 'interrupt-hostile',
  /**
   * THE WALK CROSSED SOMETHING WORTH STOPPING FOR — upstream's `runCheck`
   * (Player.lua:1126-1196), which halts on an unseen object.
   *
   * ═══ TRAVEL WALKED STRAIGHT OVER LOOT ═══
   * The route is a path to a tile, and everything between was scenery: a player
   * who clicked across a room walked over a coat and learned nothing about it.
   * Upstream stops for exactly this, and for a `notice` grid, a store entrance
   * and a talkable NPC besides — the last three name things this game does not
   * have on the floor.
   */
  Notable: 'interrupt-notable',
} as const;
export type TravelObservation = (typeof TravelObservation)[keyof typeof TravelObservation];

/**
 * The world as travel needs it, assembled by main.ts from what it already holds.
 *
 * Nulls are normal and mean "before `welcome`", not "error": every one of them
 * makes `nextStep` answer null rather than throw.
 */
export type TravelWorld = {
  /** The viewer's own tile. */
  readonly self: TileXY | null;
  readonly level: LevelView | null;
  /** Every body the client knows about, corpses included. */
  readonly actors: readonly ActorView[];
  /** The latest `turn` frame, or null before the first one. */
  readonly turn: TurnMsg | null;
};

export type TravelBegin = {
  /** Where the walk starts — the viewer's tile now. */
  readonly from: TileXY;
  /** The clicked tile. */
  readonly to: TileXY;
  readonly level: LevelView;
  /**
   * Stop one tile short of `to` rather than standing on it — the "walk up to
   * the husk" case. Sets `allowBlockedTarget` so the route may END on a body's
   * tile, and then drops that tile, which is the only way to path to something
   * you must not step onto.
   */
  readonly stopShort: boolean;
};

export type Travel = {
  readonly begin: (opts: TravelBegin) => TravelStart;
  readonly active: () => boolean;
  /** Idempotent. Safe to call when nothing is travelling — most callers do. */
  readonly cancel: () => void;
  /** THE ONLY PRODUCER OF A STEP. Null means "not this frame", not "never". */
  /**
   * Why the machine stopped ITSELF since this was last asked, or null.
   *
   * Read-and-clear. The driver asks after every `nextStep` and after every
   * `observeSelfMoved`, because either can halt, and main.ts owns the sentence.
   */
  readonly takeHalt: () => TravelHalt | null;
  readonly nextStep: (world: TravelWorld) => { readonly dir: Dir } | null;
  /**
   * A `moved` frame naming the viewer arrived.
   *
   * @param notable is there something on this tile worth stopping for — the
   *   caller's own question, because `ground` lives in main.ts and this module
   *   takes a world rather than a catalogue. See `TravelObservation.Notable`.
   */
  readonly observeSelfMoved: (at: TileXY, notable?: boolean) => TravelObservation;
  /** A `turn` frame arrived — ANY `turn` frame, including somebody else's. */
  readonly observeTurn: (world: TravelWorld) => TravelObservation;
  /** The tiles still to walk, for `Scene.path`. Never a painter. */
  readonly preview: () => readonly TileXY[];
  /** Where the walk ends, for the destination tick. Null when idle. */
  readonly destination: () => TileXY | null;
};

/**
 * One observation of the hostile situation. Two facts, both off frames main.ts
 * already holds.
 */
export type HostileSense = {
  /** `TurnMsg.inCombat`, or false before the first `turn` frame. */
  readonly inCombat: boolean;
  /** Every body the client knows about, corpses and allies included. */
  readonly actors: readonly ActorView[];
  /**
   * WHERE THE VIEWER STOOD WHEN THIS OBSERVATION WAS TAKEN. `hostileAlert` no
   * longer measures from it: the server's board already says what this seat can
   * see, and a hostile coming into view arrives on it.
   */
  readonly self: TileXY;
  /**
   * The map, only so that no board means nothing is seen. Nullable for the same reason `TravelWorld.level` is: there is
   * a window before the first board arrives, and a walk cannot be running in it.
   */
  readonly level: LevelView | null;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOSTILE FROM A PLAYER'S SEAT — AND THE FACTION SEAM IS OPEN NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The client's mirror of `isHostile` in src/server/engine/actor.ts, and the note
 * that used to sit here said what would happen next: *"FACTION SEAM: when charm
 * or summons make that untrue on the server, this is the line that follows
 * it."* Summons landed (`talents/call_shadows.ts`), so it does.
 *
 * ═══ TWO FACTIONS ARE NOT ENEMIES OF THE PERSON HOLDING THE MOUSE ═══
 * The server's rule is one predicate: `areEnemies` refuses a `Townsfolk` on
 * either side, and `reactsAs` replaces a `Bound` body with its summoner before
 * any reaction is computed (`Actor.lua:1666-1667`). Both arrive as a `Monster`
 * on the wire — same painter, same FOV, only who may hit them differs — so
 * `kind` cannot tell you and the faction string is what does.
 *
 * WHAT IT CHANGES, AND IT IS THE POINT: a left-click on your own shadow is no
 * longer a swing the server refuses, and travel no longer treats one as a
 * target. `isTownsfolkBody` below stays its own question, because a townsfolk
 * has a DOOR (`Talk to`) and a shadow has nothing to say.
 *
 * ABSENT MEANS HOSTILE-AS-BEFORE, never "unknown": the field is omitted for
 * every Redacted body on the wire.
 */
export function isHostileBody(actor: ActorView): boolean {
  if (actor.kind === ActorKind.Player) return false;
  return (
    actor.faction !== TOWNSFOLK_FACTION &&
    actor.faction !== BOUND_FACTION &&
    actor.faction !== SQUAD_FACTION
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOMEBODY WHO LIVES HERE — the one place the client asks that question.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ActorView.faction` is the SERVER'S `Faction` value verbatim (shared/
 * protocol.ts:1017: *"`'townsfolk'` is the only value a client ever needs to
 * branch on"*), and the server's rule is `engine/actor.ts#areEnemies` — a
 * townsfolk is nobody's enemy and has none.
 *
 * ═══ NOTE WHAT THIS IS NOT, BECAUSE `isHostileBody` ABOVE ANSWERS TRUE FOR HER ═══
 * A townsfolk is a `Monster` on the server, deliberately: same painter, same
 * FOV, and only who may hit her differs. So `kind` cannot tell you, and every
 * surface that needs to know has had to compare this string for itself. There
 * were three copies before this function — ui/verbs.ts's `Attack`-vs-`Talk to`
 * branch, render/canvas.ts's neutral token ring and main.ts's `neutral` flag on
 * the hover card. The two painting ones keep theirs for now; every surface that
 * decides what a CLICK MEANS reads this, so the mouse's two doors — the plain
 * left-click and the right-click menu — cannot disagree about who is a person.
 *
 * ABSENT MEANS HOSTILE-AS-BEFORE, never "unknown": the field is omitted for
 * every Redacted body on the wire.
 */
export function isTownsfolkBody(actor: ActorView): boolean {
  return actor.faction === TOWNSFOLK_FACTION;
}

/**
 * `Faction.Townsfolk` as it arrives. The client may not import the server's
 * const (`shared ← client`, never `client → server` — CLAUDE.md's dependency
 * direction), so the string is written out ONCE, here, rather than at each site
 * that needs it.
 */
export const TOWNSFOLK_FACTION = 'townsfolk';

/**
 * `Faction.Bound` as it arrives — something a player called up
 * (`talents/call_shadows.ts`). Written out for `TOWNSFOLK_FACTION`'s reason and
 * kept beside it, so the two strings a client must know are in one place.
 */
export const BOUND_FACTION = 'bound';

/**
 * `Faction.Squad` as it arrives — a temporary companion, somebody an objective
 * on this floor lent the party (`server/world/brief.ts`). Written out here for
 * `TOWNSFOLK_FACTION`'s reason and kept beside the other two, so the strings a
 * client must know are in one place and a fourth cannot be added anywhere else.
 *
 * ═══ IT IS THE THIRD AND THE LIST IS NOT OPEN-ENDED ═══
 * A client branches on a faction for exactly one question — *is this something
 * to kill* — and the three values that are not `Redacted` all answer no. That
 * is why `isHostileBody` lists them rather than testing for the absence of
 * `'redacted'`: the field is OMITTED for the whole bestiary (see
 * `ActorView.faction`), so "not redacted" would read `undefined` as friendly
 * and draw a neutral ring under every husk on the floor.
 */
export const SQUAD_FACTION = 'squad';

/**
 * The LIVING body on a tile, if any.
 *
 * CORPSES DO NOT BLOCK, matching `actorAt` in src/server/world/world.ts:290-295
 * and its comment ("a dead body is scenery, and having to walk around your
 * friend's remains for the rest of the floor is not a mechanic anybody asked
 * for"). A client that treated a corpse as an obstacle would refuse to path
 * across a battlefield the server walks freely.
 *
 * Advisory, like everything here: the answer is one frame old at worst, and a
 * body that stepped into the way since is caught by the refused move.
 */
export function liveActorAt(actors: readonly ActorView[], tile: TileXY): ActorView | undefined {
  return actors.find((actor) => actor.alive && actor.x === tile.x && actor.y === tile.y);
}

/**
 * INTERRUPT (8): "a hostile became newly visible".
 *
 * ===========================================================================
 * THIS IS A PROXY. IT IS NOT REAL VISIBILITY, BECAUSE THERE IS NONE YET
 * ===========================================================================
 * THIS WAS WRITTEN WHEN NOTHING ON THE WIRE COULD BECOME VISIBLE, because
 * nothing was ever hidden. FOV has since landed and a `joined` frame for a
 * monster now IS the event this proxy approximates — so a better rule is
 * available and this one is no longer the only thing the client can honestly
 * observe. It is kept because it is CONSERVATIVE (it stops travel in cases real
 * visibility also would) and replacing it is a behaviour change worth making on
 * its own, not as a rider. The two observations it uses:
 *
 *   1. `inCombat` crossing false -> true. The server arms the engagement clock
 *      from `anyContact` (scheduler.ts:1533-1544) the moment a monster has both
 *      line of sight to a player and chebyshev <= its `aggroRange`.
 *   2. A live hostile inside `radius` that was not inside it last time.
 *
 * ═══ EACH SET IS MEASURED FROM THE TILE THE VIEWER STOOD ON AT THE TIME ═══
 * `before` from `prev.self`, `after` from `next.self`, and the asymmetry is the
 * point rather than an oversight. Measuring both from the CURRENT tile — which
 * this function used to do — makes a hostile that never moves impossible to
 * alert on: it is added to `before` on the very observation it would have fired
 * on, so "I closed on it" and "it was already near me" become the same fact.
 *
 * That gap USED to be handed to arm 1, on the grounds that walking into a
 * monster's aggro range arms the engagement clock. It does — but arm 1 fires
 * only on a CROSSING, and ENGAGEMENT IS LEVEL-WIDE by explicit design
 * (barrier.ts:134-155, scheduler.ts:1500-1508). In a 3-6 player co-op game any
 * fight anywhere on the floor holds `inCombat` at true for turns on end, so
 * there is no crossing left to detect and NEITHER arm could fire. Travel walked
 * straight past — and sometimes straight up against — a stationary husk, and
 * only stopped once one of its swings actually connected.
 *
 * PER-PLAYER FOV LANDED, AND THIS WAS THE ONE PLACE THAT CHANGED, as this note
 * said it would be: the alert is now "an id in `next` that was not in `prev`",
 * because an id on this client's board is one this player can see. Every caller
 * and every other rule in this file stayed as it was.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVING HOSTILES THIS BODY CAN SEE. ONE ANSWER, THREE QUESTIONS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hostileAlert` asks whether the set GREW, and `nearestSeenHostile` asks which
 * member is closest; both used to spell their own scan and one of them forgot
 * the sight term for two milestones.
 *
 * ═══ ON THE BOARD IS SEEN ═══
 * This used to filter the board through `canSee` from this body, because the
 * board was the whole party's pooled sight and a husk only a teammate could see
 * was on it. Upstream draws that line for the same reason: `spotHostiles` walks
 * the player's OWN sight, *"only see LOS actors, so telepathy wont prevent
 * resting"* (Player.lua:849-858). The board is this player's own sight now, so
 * the filter was a second rule at the wrong radius, and it is gone.
 *
 * NO LEVEL MEANS NOTHING IS SEEN. Before the first board there is nothing to
 * trace through, and an empty answer stops a walk from starting rather than
 * letting one run on a frame that cannot be reasoned about.
 */
export function seenHostiles(level: LevelView | null, actors: readonly ActorView[]): ActorView[] {
  if (level === null) return [];
  // `isHostileBody` already excludes every Player, so the viewer's own body
  // needs no special case here.
  return actors.filter((actor) => actor.alive && isHostileBody(actor));
}

/**
 * The nearest hostile this body can SEE, as an offset, or null.
 *
 * The offset shape is `RestView.threat`'s, so one `bearingWord` serves the rest
 * sentence and the explore sentence without either converting.
 *
 * NEAREST BY KING-MOVE, which is only a tie-break among things already seen —
 * `seenHostiles` decides membership. Chebyshev because the bearing sentence this
 * feeds reads in king directions.
 */
export function nearestSeenHostile(
  level: LevelView | null,
  from: TileXY,
  actors: readonly ActorView[],
): { readonly name: string; readonly dx: number; readonly dy: number } | null {
  let best: { name: string; dx: number; dy: number } | null = null;
  let bestDist = Infinity;
  for (const actor of seenHostiles(level, actors)) {
    const dx = actor.x - from.x;
    const dy = actor.y - from.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist >= bestDist) continue;
    bestDist = dist;
    best = { name: actor.name, dx, dy };
  }
  return best;
}

export function hostileAlert(prev: HostileSense, next: HostileSense): boolean {
  if (!prev.inCombat && next.inCombat) return true;

  const before = new Set(seenHostiles(prev.level, prev.actors).map((a) => a.id));
  for (const actor of seenHostiles(next.level, next.actors)) {
    if (!before.has(actor.id)) return true;
  }
  return false;
}

/**
 * Does the turn permit sending a move RIGHT NOW?
 *
 * The self card is found by the server's own `isSelf` flag rather than by
 * comparing against a local id — protocol.ts is explicit that `turn` is unicast
 * precisely so the server can state which card is you, and a bodiless or
 * spectating socket genuinely has no card. (Deliberately not imported from
 * ui/turnbar.ts, which declares `selfCard`: that module pulls in
 * render/canvas.ts and with it the DOM lib, and this file stays DOM-free so its
 * test needs no `reference lib="dom"`. What is copied is one `find`, not a rule
 * that could drift.)
 *
 * OUT OF COMBAT THE ANSWER IS ALWAYS YES. See the step gate in the header:
 * `engagement === 0` means nobody blocks, every card reads `committed`, and the
 * energy fixed point refills the bank inside the same pump — so a step per
 * confirmed `moved` is legitimate free movement, and waiting for `waiting` is
 * the stall.
 */
function turnPermits(turn: TurnMsg | null): boolean {
  if (turn === null || !turn.inCombat) return true;
  const card = turn.actors.find((entry) => entry.isSelf);
  if (card === undefined) return false;
  return card.state === TurnActorState.Waiting || card.state === TurnActorState.Bell;
}

export function createTravel(): Travel {
  /** Where the walk ends. Non-null exactly while travelling — see `active`. */
  let destination: TileXY | null = null;
  /** The remaining route INCLUDING tiles already walked; `index` is the cursor. */
  let path: readonly TileXY[] = [];
  let index = 0;
  /** A move has been sent and its `moved` frame has not come back. */
  let awaitingStep = false;
  /** The tile that move should land on. Null whenever `awaitingStep` is false. */
  let expected: TileXY | null = null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * `expected` WAS A CLOSED DOOR WHEN THE STEP WENT OUT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A move into a shut door is the one command in the game that is ACCEPTED,
   * changes the world, and moves nobody: `scheduler.ts`'s Move case swings the
   * door, returns a refusal carrying `opened`, and deliberately suppresses the
   * `refunded` push so the player is not toasted for a success. `Actor.lua:1346`
   * charges a move only when the body changed tile, so it cost nothing and
   * `ActResult.Park` asks the same actor again.
   *
   * FOR THIS MACHINE THAT IS A STEP THAT PRODUCES NO `moved` FRAME, and every
   * other outcome produces one. `observeSelfMoved` is the only thing that clears
   * `awaitingStep`, so without this flag the first door on the route would leave
   * the walk waiting for a frame that is never coming — a permanent stall with
   * the route still painted across the map and nothing on screen saying why.
   */
  let expectingDoor = false;
  /**
   * The hostile situation as of the last `observeTurn`, for the visibility
   * proxy. Null until the first observation, which therefore cannot alert —
   * correctly: a husk that was already standing there when the player clicked is
   * not news, they could see it.
   */
  let sense: HostileSense | null = null;
  /** Set by `halt`, drained by `takeHalt`. See `TravelHalt`. */
  let pendingHalt: TravelHalt | null = null;
  /**
   * The `gameTurn` the last step this machine issued was stamped against, or
   * null before it has issued any.
   *
   * NOT RESET BY `cancel()`, and that is deliberate — see gate (iii) in the
   * header. It is a fact about this CLIENT's sending history, not about the
   * current walk, so a cancel-and-re-click cannot launder a second move into one
   * game turn by starting a fresh walk.
   */
  let lastStepTurn: number | null = null;

  function cancel(): void {
    destination = null;
    path = [];
    index = 0;
    awaitingStep = false;
    expected = null;
    expectingDoor = false;
    sense = null;
  }

  /**
   * Cancel AND leave a reason for main.ts to say out loud.
   *
   * Separate from `cancel` on purpose: `cancel` is also the PUBLIC verb, called
   * when main.ts stops the walk for a reason it already knows and has already
   * phrased. Setting a halt there would make the driver announce a stop the
   * player had just been told about, one frame later, in different words.
   */
  function halt(why: TravelHalt): void {
    cancel();
    pendingHalt = why;
  }

  /**
   * The reason, once. Read-and-clear because it describes a TRANSITION, and a
   * driver that polled a sticky field would re-announce the same stop on every
   * tick after it.
   */
  function takeHalt(): TravelHalt | null {
    const why = pendingHalt;
    pendingHalt = null;
    return why;
  }

  function active(): boolean {
    return destination !== null;
  }

  function begin(opts: TravelBegin): TravelStart {
    // A NEW WALK OWES NO EXPLANATION FOR THE LAST ONE. Draining here means a
    // reason nobody read cannot surface against a route it was never about.
    pendingHalt = null;
    const { from, to, level, stopShort } = opts;
    cancel();

    // TERRAIN ONLY, DIAGONALS ON — both are matching-the-server decisions and
    // the header says what each one would break. THERE IS DELIBERATELY NO
    // INJECTABLE PASSABILITY HOOK: the one way this goes wrong is somebody
    // passing an actor-aware predicate "to stop it walking into things", which
    // makes the client route politely around the very body a bump is meant to
    // reach and disagrees with the server's own A* (ai/npc.ts uses terrain only
    // for exactly this reason).
    // ═══ `canRoute`, NOT `canWalk` — A SHUT DOOR IS CROSSABLE, NOT STANDABLE ═══
    // Upstream's `couldpass` (`tome/class/Grid.lua:89-92`), and the reason this
    // file's router asks it DIRECTLY rather than through `travelTargetAllowed`:
    // that predicate answers "may travel END here" and is documented as the one
    // site for it. This is a different question — "may the plan go through here"
    // — and `shared/level.ts` holds the one definition of it.
    //
    // ═══ AROUND THE POND, UNLESS THERE IS NO WAY AROUND ═══
    // Upstream's mouse walk searches twice (engine/interface/PlayerMouse.lua:70-72):
    // first refusing every tile the walker cannot breathe on
    // (tome/class/Player.lua:1200-1217), then, only if that finds nothing, the
    // plain route. `findPathAvoiding` is that pair. Clicking a pond tile makes
    // the first search fail on the goal itself, so the walk goes the plain way.
    // A shore reachable only by wading is still reached, and main.ts stops the
    // walk once the lungs fall below three quarters (`losingBreath`, ui/air.ts),
    // as tome/class/Player.lua:771-781 does.
    const route = findPathAvoiding(
      from,
      to,
      (x, y) => canRoute(level, x, y),
      (x, y) => mouseWalkRefusesAt(level, x, y),
      { maxNodes: travelMaxNodes(level), allowBlockedTarget: stopShort },
    );

    // `[]` and null are DIFFERENT ANSWERS (path.ts:303-311) and the caller acts
    // on them differently: one is silence, the other is "no route to that tile".
    if (route === null) return TravelStart.NoRoute;
    if (route.length === 0) return TravelStart.AlreadyThere;

    // Drop the tile we must not stand on. An adjacent target leaves nothing to
    // walk, which is arrival rather than failure — you are already up against it.
    const walk = stopShort ? route.slice(0, -1) : route;
    const last = walk[walk.length - 1];
    if (last === undefined) return TravelStart.AlreadyThere;

    path = walk;
    index = 0;
    destination = last;
    return TravelStart.Started;
  }

  function nextStep(world: TravelWorld): { readonly dir: Dir } | null {
    if (!active()) return null;

    const self = world.self;
    const level = world.level;
    // No board yet. Not a cancel: main.ts cancels on `welcome`/`state` because
    // the board was REPLACED, which is a different fact from not having one.
    //
    // HOISTED ABOVE GATE (i) so the door release below can read the map. The
    // gate's own answer is unchanged either way — both paths return null.
    if (self === null || level === null) return null;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DOOR WE WALKED INTO IS OPEN NOW. TAKE THE STEP AGAIN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ A POLL, WHERE EVERYTHING ELSE HERE IS AN OBSERVATION ═══
     * `observeSelfMoved` and `observeTurn` exist because a move and a turn are
     * EVENTS. A door opening reaches this client as a `terrain` frame, and
     * main.ts applies that frame by writing straight into `level.tiles` — the
     * `case 'terrain'` comment argues at length that terrain must BE the map
     * rather than a layer beside it, so that `canWalk`, the pathfinder and the
     * minimap cannot disagree about a door.
     *
     * Which means the fact is already in the world this function is handed, and
     * an `observeTerrain` would be a third tick point telling the machine
     * something it can see. main.ts calls `tickTravel` after every applied
     * frame, so the tick that follows the `terrain` frame lands here anyway.
     *
     * ═══ `index` DOES NOT ADVANCE ═══
     * The door tile is still the next tile of the route and we are still one
     * tile short of it. Upstream's player is simply asked again for zero energy
     * (`interface/PlayerExplore.lua:2563` — *"takes a movement action but no
     * energy to do"*); this is that second ask. Advancing would skip the tile
     * and send the next step diagonally past a doorway.
     */
    if (
      awaitingStep &&
      expectingDoor &&
      expected !== null &&
      canWalk(level, expected.x, expected.y)
    ) {
      awaitingStep = false;
      expected = null;
      expectingDoor = false;
      /**
       * ═══ AND GATE (iii) IS UNLATCHED, OR THIS RELEASES INTO A CLOSED GATE ═══
       * The stamp records a step that was TAKEN; a door-open is not one. No
       * energy left the actor (`Actor.lua:1346`), nobody moved, and the game
       * turn therefore does not advance — so a stamp left in place would block
       * the re-ask until something ELSE moved the turn on, which out of combat
       * is nothing at all. The walk would stop dead on the tile it just opened.
       *
       * SAFE BECAUSE A DOOR STEP CANNOT FOLLOW A REAL ONE INSIDE ONE TURN: gate
       * (iii) itself refuses a second step while the stamp matches, so whatever
       * this clears was stamped by the door step and nothing else. The stale-map
       * case — the client believing a tile is shut when the server has it open,
       * so the move actually LANDS — never reaches here at all: that path clears
       * `expectingDoor` in `observeSelfMoved` and leaves the stamp alone, which
       * is the half that keeps a double-move out of one turn.
       */
      lastStepTurn = null;
    }

    // Gate (i): one step in flight at a time. See the header — without this the
    // second move lands in `pendingIntent` and pre-commits the next turn.
    if (awaitingStep) return null;

    // Gate (ii).
    if (!turnPermits(world.turn)) return null;

    // Gate (iii). The header explains at length why (i) cannot do this job.
    //
    // COMPARED FOR INEQUALITY RATHER THAN "STRICTLY GREATER": a floor reset
    // (turn-engine.ts's `resetFloor`) can move `gameTurn` in either direction as
    // far as this file is concerned, and a `>` test would wedge travel forever on
    // the day it goes backwards. Any DIFFERENT turn number means the world moved
    // on, which is the whole question being asked.
    //
    // A NULL `turn` LEAVES THE GATE OPEN, matching gate (ii)'s own convention for
    // "before the first frame". The gateway unicasts a `turn` immediately after
    // `welcome` (gateway.ts's `handleHello`), so the only window this covers is
    // one in which no walk can have been started yet.
    const gameTurn = world.turn?.gameTurn ?? null;
    if (gameTurn !== null && gameTurn === lastStepTurn) return null;

    // noUncheckedIndexedAccess: the guard cannot fire (arrival cancels, so
    // `index` is always in range) but `!` is banned and a silent step off the
    // end of the path would be worse than a cancel — targeting.ts:180-182 is
    // the same idiom.
    const next = path[index];
    if (next === undefined) {
      cancel();
      return null;
    }

    // The two things that make a queued step stale. Both cancel rather than
    // wait: a door that closed or a body that parked on the route means the
    // plan the player agreed to no longer exists, and re-routing them somewhere
    // they did not ask for is the one thing a travel system must never do.
    if (!canRoute(level, next.x, next.y)) {
      halt(TravelHalt.Blocked);
      return null;
    }
    if (liveActorAt(world.actors, next) !== undefined) {
      halt(TravelHalt.Occupied);
      return null;
    }

    // THE SANCTIONED IDIOM (main.ts:1758-1762): walk DIR_ORDER and compare
    // `step()`, never a hand-rolled dx/dy table. There is exactly one direction
    // vocabulary in this codebase and it is `DIR_ORDER`; a second one would be a
    // sprite-row order and a wire enum waiting to drift.
    const dir = DIR_ORDER.find((candidate) => sameTile(step(self, candidate), next));
    if (dir === undefined) {
      // We are not standing where the route says we are — shoved, teleported,
      // or resynced. The route is about somebody else's position now.
      halt(TravelHalt.Displaced);
      return null;
    }

    awaitingStep = true;
    expected = next;
    // `canRoute` let this tile through and `canWalk` is the half of it that a
    // shut door fails, so this IS "the next tile is a closed door" — asked of
    // the predicates rather than of `TileCode`, so the two can never drift.
    expectingDoor = !canWalk(level, next.x, next.y);
    // STAMPED FOR A DOOR STEP TOO. The client's map can be stale — a tile this
    // machine believes is shut may already be open on the server, in which case
    // the move lands like any other and the turn must be latched behind it.
    lastStepTurn = gameTurn;
    return { dir };
  }

  function observeSelfMoved(at: TileXY, notable = false): TravelObservation {
    if (!active()) return TravelObservation.Continue;

    const want = expected;
    // ANY move that is not the one we asked for cancels, including a move we
    // never asked for at all (`expected === null` — a shove, a Fog Step, a
    // respawn). The server put us somewhere else, so the rest of the path is a
    // route from a tile we are not on.
    if (want === null || !sameTile(want, at)) {
      halt(TravelHalt.Unexpected);
      return TravelObservation.Continue;
    }

    awaitingStep = false;
    expected = null;
    /**
     * ═══ AND `lastStepTurn` IS NOT TOUCHED, WHICH IS THE WHOLE STALE-MAP CASE ═══
     * A `moved` frame means the body changed tile, so a step was genuinely taken
     * in this game turn — even if this machine had the tile down as a shut door
     * and was expecting the `terrain` frame instead. Gate (iii) must hold behind
     * it, and that is the ONLY reason `nextStep` stamps a door step at all.
     *
     * `expectingDoor` IS DELIBERATELY LEFT ALONE. Clearing it here would read
     * like a guard and be none: the release above also requires `awaitingStep`
     * and a non-null `expected`, both of which this function has just cleared, so
     * a stale flag can never fire it — and `nextStep` recomputes the flag
     * unconditionally before the next step goes out.
     */
    index += 1;
    // ARRIVAL — a normal end rather than an interrupt. The caller learns of it
    // by `active()` going false, and the preview empties with it.
    if (index >= path.length) {
      cancel();
      return TravelObservation.Continue;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND SOMETHING IS UNDERFOOT — `runCheck`'s "unseen object" arm.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ AFTER THE ARRIVAL CHECK, DELIBERATELY ═══
     * Auto-explore aims AT item tiles, so arriving on one is the plan working
     * rather than an interruption — and reporting it as an interrupt would put a
     * "travel stopped" notice on top of a walk that finished.
     *
     * ═══ REACHING, NOT NOTICING, AND THE DIFFERENCE IS DELIBERATE ═══
     * Upstream halts when an object comes into VIEW. Ours halts when the walk
     * puts you ON one. Noticing needs "have I seen this object before" tracked
     * per item — without it the same coat across the room would stop every walk
     * that faces it — and stopping for everything ADJACENT would fire constantly
     * in a room somebody has already looted into a pile. Standing on a thing is
     * rare, unambiguous, and always actionable: `,` takes it.
     */
    return notable ? TravelObservation.Notable : TravelObservation.Continue;
  }

  /**
   * A `turn` frame arrived. THE ONLY THING LOOKED FOR HERE IS A HOSTILE.
   *
   * A step still being in flight is deliberately NOT read as evidence of
   * anything — see the note on `TravelObservation`. This runs on every `turn`
   * frame, including the many that are somebody else's pump, because the hostile
   * snapshot wants refreshing on all of them: a monster that walked into range
   * during another player's turn is exactly as dangerous as one that walked in
   * during ours.
   */
  function observeTurn(world: TravelWorld): TravelObservation {
    if (!active()) return TravelObservation.Continue;

    const self = world.self;
    // No body on the board. Nothing to look out FROM — and recording an
    // observation with a guessed tile would make the NEXT one a false alarm.
    if (self === null) return TravelObservation.Continue;

    const now: HostileSense = {
      inCombat: world.turn?.inCombat ?? false,
      actors: world.actors,
      level: world.level,
      self,
    };
    const before = sense;
    sense = now;

    if (before === null) return TravelObservation.Continue;
    if (!hostileAlert(before, now)) return TravelObservation.Continue;

    cancel();
    return TravelObservation.Hostile;
  }

  return {
    begin,
    active,
    cancel,
    takeHalt,
    nextStep,
    observeSelfMoved,
    observeTurn,
    preview: () => path.slice(index),
    destination: () => destination,
  };
}
