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
import { canWalk } from '../../shared/level.ts';
import { canSee } from '../../shared/sight.ts';
import { findPath } from '../../shared/path.ts';
import { ActorKind, TurnActorState } from '../../shared/protocol.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ActorView, LevelView, TurnMsg } from '../../shared/protocol.ts';

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
 * THERE IS NO TRAVEL RADIUS ANY MORE. `hostileAlert` ASKS `canSee`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TRAVEL_ALERT_RADIUS` was 8, measured with `chebyshev`, and the reasoning was
 * sound for the game it was written in: 8 is the authored `aggroRange` of the M2
 * monsters (monsters.ts:248, :350) and the number `anyContact` arms the
 * engagement clock with (scheduler.ts:1539), so the radius arm and the
 * `inCombat` arm tended to fire on the same turn.
 *
 * TWO THINGS MADE IT WRONG. It answers "how far can something notice ME", and
 * the question travel asks is "what have I just NOTICED" — upstream stops a run
 * for anything `spotHostiles` returns, which is bounded by sight, not by the
 * monster's aggro range (Player.lua:854). And the client used to be sent every
 * actor on the map, so a radius was the only filter available; since FOV the
 * list is already fogged and the radius is a second, narrower one on top.
 *
 * The two did not line up in either direction. A husk that walks into view at 9
 * tiles down a corridor never tripped it, so the walk carried on toward
 * something the player could see; and chebyshev 8 on a pure diagonal is
 * euclidean 11.3, further than the server would ever have sent.
 *
 * So the rule is `canSee` from `shared/sight.ts` — the same function the FOV
 * projection and the rest check spend, at the same radius, measured the same
 * way. One sight rule.
 */

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
   * WHERE THE VIEWER STOOD WHEN THIS OBSERVATION WAS TAKEN, and the whole reason
   * the radius arm of `hostileAlert` can fire at all. Measuring both ends of the
   * comparison from the CURRENT tile makes a stationary hostile permanently
   * old news — see that function's header.
   */
  readonly self: TileXY;
  /**
   * The map, because the rule this feeds is now `canSee` and `canSee` asks
   * about walls. Nullable for the same reason `TravelWorld.level` is: there is
   * a window before the first board arrives, and a walk cannot be running in it.
   */
  readonly level: LevelView | null;
};

/**
 * Hostile FROM A PLAYER'S SEAT.
 *
 * The client's mirror of `isHostile` in src/server/engine/actor.ts:724, which is
 * `a.kind !== b.kind` — with the viewer's kind pinned to Player, since the only
 * thing holding a mouse is a detective. FACTION SEAM: when charm or summons make
 * that untrue on the server, this is the line that follows it.
 */
export function isHostileBody(actor: ActorView): boolean {
  return actor.kind !== ActorKind.Player;
}

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
 * WHEN PER-PLAYER FOV LANDS, THIS FUNCTION IS THE ONE PLACE THAT CHANGES: it
 * becomes "an id in `next.actors` that was not in `prev.actors` at all", and
 * every caller and every other rule in this file stays exactly as it is.
 */
export function hostileAlert(prev: HostileSense, next: HostileSense): boolean {
  if (!prev.inCombat && next.inCombat) return true;

  const spotted = (sense: HostileSense): Set<string> => {
    const out = new Set<string>();
    if (sense.level === null) return out;
    for (const actor of sense.actors) {
      if (!actor.alive || !isHostileBody(actor)) continue;
      if (!canSee(sense.level, sense.self, actor)) continue;
      out.add(actor.id);
    }
    return out;
  };

  const before = spotted(prev);
  for (const id of spotted(next)) {
    if (!before.has(id)) return true;
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
 * ui/turncards.ts: that module pulls in render/canvas.ts and with it the DOM
 * lib, and this file stays DOM-free so its test needs no `reference lib="dom"`.
 * What is copied is one `find`, not a rule that could drift.)
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
    const route = findPath(from, to, (x, y) => canWalk(level, x, y), {
      maxNodes: travelMaxNodes(level),
      allowBlockedTarget: stopShort,
    });

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
    // Gate (i): one step in flight at a time. See the header — without this the
    // second move lands in `pendingIntent` and pre-commits the next turn.
    if (awaitingStep) return null;

    const self = world.self;
    const level = world.level;
    // No board yet. Not a cancel: main.ts cancels on `welcome`/`state` because
    // the board was REPLACED, which is a different fact from not having one.
    if (self === null || level === null) return null;

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
    if (!canWalk(level, next.x, next.y)) {
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
