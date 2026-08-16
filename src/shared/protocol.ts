/**
 * The WebSocket wire protocol. One definition, imported by both sides.
 *
 * TWO HALVES, TWO TECHNIQUES, ON PURPOSE:
 *
 *   CLIENT -> SERVER is zod. It is the single trust boundary in the whole
 *   system: everything arriving on a socket is attacker-controlled, including
 *   frames from a "friend" running a patched client in a browser devtools
 *   console. Every inbound frame goes through `parseClientMsg` and nothing else
 *   in the server ever sees an unvalidated message.
 *
 *   SERVER -> CLIENT is plain TypeScript types. Validating our own output with
 *   zod would burn CPU on every frame to defend against a bug that the compiler
 *   already catches at the construction site.
 *
 * THE MISSING FIELD, WHICH IS NOT AN OMISSION:
 *
 *   There is deliberately NO `userId`, `actorId`, `playerId` or `charId` on ANY
 *   client -> server message, and there must never be one. Identity is resolved
 *   server-side from the session established at connect time (the Discord OAuth
 *   token exchanged over HTTPS -> `GET /users/@me`), and the socket remembers
 *   it. An id on the wire is not an identifier, it is a request: "act as this
 *   actor". The first person to notice would be playing everyone else's
 *   characters. `move` says which DIRECTION, never who moves.
 *
 * M1 SCOPE: hello/move/ping and welcome/state/moved/joined/left/pong/error.
 * docs/architecture.md sketches the eventual richer shape (`cmd` with
 * idempotency ids, `ev` batches, FOV-filtered `ViewDelta`); this is the subset
 * that makes two tokens move on one map, and it grows into that rather than
 * being replaced.
 *
 * M2 ADDS THE WARRANT CLOCK (docs/game-design.md § 4):
 *
 *   C -> S  `commit` ("I have finished my turn") and `hold` ("pass").
 *   S -> C  `turn`   — WHOSE TURN IT IS. Broadcast on every barrier change,
 *                      because a player not knowing whether the game is waiting
 *                      on them is the documented killer of co-op turn-based.
 *           `sweep`  — the whole monster turn in ONE frame. Never one message
 *                      per monster; the client paces the playback.
 *           `attacked`/`damaged`/`died` — the immediate lane, for what a PLAYER
 *                      just did, which must animate at once rather than being
 *                      paced with the sweep.
 *
 * Neither `commit` nor `hold` carries an id, for the same reason `move` does
 * not: committing is something a socket does, not something it asks for on
 * someone else's behalf.
 *
 * M3 ADDS TALENTS (docs/game-design.md § 2):
 *
 *   C -> S  `talent` — a talent id and, when the talent needs one, a TARGET TILE.
 *                      Still no actor id: which body casts it is the socket's
 *                      business, exactly as with `move`.
 *   S -> C  `loadout`   — the viewer's four talents, once, at `welcome`.
 *           `cooldowns` — the viewer's own cooldowns, as turns remaining.
 *           `resource`  — the viewer's own class resource.
 *           `used`      — a talent went off; the client stamps the FX.
 *
 * THE FIRST THREE ARE VIEWER-PRIVATE and `BroadcastMsg` at the bottom of this
 * file makes sending them to the room a COMPILE ERROR. Another player's
 * cooldowns are both a leak (they tell you which button someone is holding for
 * the boss) and noise (four hotbars' worth of frames nobody draws).
 *
 * THE CLIENT'S RANGE RING IS A CONVENIENCE, NEVER A GATE. Every constraint the
 * ring draws — range, the `min_range` hole, line of sight, the cooldown wipe,
 * the resource cost — is re-checked server-side on arrival, because a
 * hand-crafted frame from a devtools console is the normal case to design for,
 * not the exotic one. That is what the five new `ErrorCode` members are for: a
 * refusal names WHICH rule it broke, so the client can light up the specific bit
 * of UI that was lying rather than printing "illegal".
 *
 * M4 ADDS THE PARTY (docs/game-design.md §§ 9, 11, 12):
 *
 *   C -> S  `say`    — one line into the Case Log's MARGIN lane.
 *           `point`  — a map ping. "There. Behind you."
 *           `revive` — pick up the Downed ally beside you.
 *   S -> C  `log`     — Case Log lines, each one tagged with its LANE.
 *           `effects` — the status badges, per actor, with turns remaining.
 *           `party`   — the party panel: the Downed timer, voice, presence.
 *           `pinged`  — somebody pointed at a tile.
 *
 * THE TWO LANES TRAVEL ON THE WIRE, PER LINE, AND THAT IS THE POINT.
 *
 *   RECORD is what the rules did: rolls, damage, saves, deaths. Machine-written
 *     and VOLUMINOUS — one AoE is eight lines.
 *   MARGIN is what the PEOPLE did: what they said (`say`), where they pointed
 *     (`point`), and the Index's own asides (§ 11 — "italic, violet"). Perhaps
 *     three lines a minute.
 *
 * The lane is a REGISTER, not an author. Merge the two into one scrolling list
 * and the Record buries the Margin within seconds of combat opening, at which
 * point the log stops being a place people talk and becomes a debug console —
 * so `LogLine.lane` is a field the SERVER sets and the client reserves a band
 * for, never something a renderer infers from the text. Deriving it in the
 * browser would put a parser there and get it wrong the first time somebody says
 * "19 physical" out loud.
 *
 * `TurnEvent` also grew five variants — effect_applied / effect_expired /
 * downed / revived / erased — and one of them narrows an existing field:
 * a DOWNED detective is at 0 hp with `alive` still TRUE (§ 9). A v3 client draws
 * that as a corpse. See src/shared/version.ts for why that forces the bump.
 *
 * `say` AND `point` DO NOT ADVANCE THE WORLD. They are the only frames besides
 * `ping` that change no state, which is exactly why they are the ones that carry
 * a rate limit (game-design.md § 4: command spam is rate-limited, 20/s): a frame
 * that costs the sender nothing must not be a way to make the server do work.
 *
 * M5 ADDS NO FRAME AND FIXES THE OLDEST OMISSION IN THIS FILE.
 *
 * Real play found it: monsters arrive, the barrier arms, and NOBODY AT THE TABLE
 * KNOWS COMBAT HAS STARTED. The server has always known — `world.turn.engagement`
 * is the level-wide combat clock and it is what decides whether anyone blocks at
 * all — and it was never projected. A client could infer "probably a fight" from
 * `whoseTurn` being non-empty, which is not the same fact, arrives with no
 * transition to announce, and reads identically to "we are waiting on one
 * straggler".
 *
 * So `TurnMsg` grew three fields — `engagement`, `inCombat` and `actors` — and
 * `turn` became per-recipient (`ViewerMsg`, because `isSelf` is true for one
 * person). `actors` is a card strip that says WHO STILL OWES A DECISION; it is
 * emphatically not an initiative order, and the long note above `TurnActorKind`
 * is the one to read before drawing it.
 *
 * ONE INBOUND VERB WAS ADDED AFTER v5 AND THE VERSION DID NOT MOVE.
 *
 *   C -> S  `respawn` — the way out of Erased, for the sender's own body only.
 *
 * The rule this file has followed since 2 -> 3 is that a bump is forced by what
 * an OLD CLIENT would silently get WRONG, never by an addition it can ignore.
 * `respawn` travels client -> server, so a v5 client simply never sends one and
 * every frame it receives means exactly what it always did: no event variant is
 * new, no `ErrorCode` is new (a refusal is `not_your_turn`, which every v5
 * client already renders), and no existing field narrowed. What a v5 client
 * loses is the KEY, not the meaning of anything on the wire — and a v5 client
 * talking to a v5 server is a client that could never have sent it anyway.
 * See src/shared/version.ts for the three bumps that were forced.
 *
 * v6 ADDS EXPLICIT PARTIES, AND THE BUMP IS FORCED BY A NARROWING.
 *
 *   C -> S  `party`       — invite / accept / decline / leave / kick.
 *   S -> C  `party_state` — your party's members, who leads, and the invites
 *                           waiting on your answer. Per-recipient.
 *
 * The barrier used to be LEVEL-WIDE: above `engagement > 0` every player on the
 * floor blocked every other one. That is right for people playing together and
 * wrong for two groups who are not, and real multiplayer found the wrong half —
 * a solo player waited on a stranger, and then on a stranger who had closed the
 * tab. From v6 the barrier is scoped to the asking player's PARTY, engagement
 * stays level-wide (a fight is a fact about the world), and `TurnMsg`'s four
 * roster fields therefore mean the recipient's party rather than the floor.
 * That is the narrowing, and it is why the version had to move — see
 * src/shared/version.ts for what a v5 client does with it.
 */

import { z } from 'zod';

import { DIR_ORDER } from './coords.ts';
import { PROTOCOL_VERSION } from './version.ts';

// ---------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------

/**
 * Tile codes as they travel on the wire and sit in a save file.
 *
 * ART SEAM: M1 has no tile atlas, so the client renders FLOOR and WALL as flat
 * palette colours. When real tiles land, the mapping code -> atlas cell goes in
 * the renderer and this union grows (DOOR, WATER, STAIRS_DOWN...). Never
 * repurpose 0 or 1 — an old save would silently become a different dungeon.
 */
export const TileCode = {
  FLOOR: 0,
  WALL: 1,
} as const;
export type TileCode = (typeof TileCode)[keyof typeof TileCode];

/**
 * Takes a plain number because `LevelView.tiles` is `number[]` on the wire and
 * the alternative is a cast at every call site. Anything unrecognised is NOT
 * walkable: an unknown code means a client is older than the map it was sent,
 * and walking into unknown terrain is the worse failure.
 */
export function isWalkable(code: number): boolean {
  return code === TileCode.FLOOR;
}

/**
 * A level as the client needs it: dimensions plus a flat row-major tile array,
 * indexed `y * w + x` (see `tileIndex` in coords.ts).
 *
 * Flat rather than nested arrays because it is half the JSON, one allocation,
 * and it dodges the double-undefined that `noUncheckedIndexedAccess` inflicts on
 * `grid[y][x]`.
 */
export type LevelView = {
  w: number;
  h: number;
  tiles: number[];
};

export const ActorKind = {
  Player: 'player',
  Monster: 'monster',
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

/**
 * How dangerous a body is, as a CATEGORY rather than a stat.
 *
 * ToME carries the same field and uses it for the same purpose: `rank` drives
 * `boss_rank_circles` (Actor.lua:1198-1204), a table of under-token circle
 * sprites drawn beneath the creature. That is exactly what
 * `ui_token_ring_elite.png` is here, which is why rank is on the wire at all —
 * the client cannot infer "elite" from hp, and it must not try.
 *
 * IT IS NOT A LEAK. Rank is the one property of a monster the fiction insists
 * you can see: the thing is visibly wrong in a way its neighbours are not. Its
 * TARGET, its energy and its pending intent stay off the wire (see `ActorView`).
 *
 * The three values match `MonsterDef.rank` in docs/data-schemas.md § 4 exactly,
 * so content JSON and the wire never need a translation table. ToME's numeric
 * ladder (1 critter … 3 elite … 4 boss, Actor.lua:1701-1751) collapses to these
 * three because MVP has no unique/rare/god tier to distinguish.
 */
export const ActorRank = {
  Normal: 'normal',
  Elite: 'elite',
  Boss: 'boss',
} as const;
export type ActorRank = (typeof ActorRank)[keyof typeof ActorRank];

/**
 * One actor, already filtered for the recipient's field of view.
 *
 * `sprite` is an asset key (e.g. 'chr_player_watchman_s'), never a path: the
 * client owns the manifest, so re-cutting the art cannot invalidate saved state.
 * Nothing here is secret, and everything added must be checked against "would
 * this leak something the viewer cannot see?" — which is why `energy`, the
 * pending intent, talent cooldowns and a monster's AI target are all absent.
 * Energy in particular would let a client compute the turn order in advance.
 *
 * VITALS ARE HERE FROM M2 because bodies now persist through death and through a
 * disconnect: a client that only learned hp from `damaged` events could not draw
 * a bar for a monster it has never hit, and could not tell a corpse from a
 * living body it has not seen take damage.
 */
export type ActorView = {
  id: string;
  name: string;
  sprite: string;
  x: number;
  y: number;
  kind: ActorKind;
  /**
   * THE UNDER-TOKEN RING, and the only reason this field is on the wire.
   *
   * `ui_token_ring_elite.png` cannot be chosen from anything else the client
   * knows: hp is not rank (a wounded elite has less life than a fresh husk) and
   * the sprite key is not rank either, because docs/art-pipeline.md:362 records
   * that `index_husk_elite` currently ships SMALLER than `index_husk` — the art
   * actively reads the wrong way round until it is regenerated, so the ring is
   * carrying the whole signal.
   *
   * ToME does exactly this: `boss_rank_circles` (Actor.lua:1198-1204) picks an
   * under-token circle sprite from `self.rank` and nothing else.
   *
   * `normal` for every player and every trash monster.
   */
  rank: ActorRank;
  hp: number;
  maxHp: number;
  /**
   * False for a corpse. THE BODY IS NOT REMOVED when it dies — it stops acting
   * and stops blocking movement but stays on the map, so the client must render
   * a dead token rather than treating its absence as the signal.
   */
  alive: boolean;
};

/**
 * WHAT A TOOLTIP SAYS. Computed in src/server/view/inspect.ts — DECLARED HERE.
 *
 * The maths is server-side and stays there (the client is banned from importing
 * shared/checkhit, shared/scale and shared/energy, so it could not compute a hit
 * chance even if it wanted to). But the tooltip PAINTER has to name the type it
 * is handed, and eslint's NO_SERVER_PATTERNS bans client/** -> server/**
 * outright: a browser file can never `import type` from under src/server/. So
 * the shape lives on the wire's own file, which is the one place both halves may
 * read. inspect.ts imports these back and remains the ONLY implementation.
 */

/**
 * One line of a tooltip. A label and a value rather than a formatted string, so
 * the client owns presentation and a narrow viewport can drop rows rather than
 * truncating sentences mid-word.
 */
export type InspectRow = {
  readonly label: string;
  readonly value: string;
  /**
   * Draws the reader's eye. Reserved for the number that decides whether to
   * commit — the hit chance, and a threat that can kill you this turn.
   */
  readonly emphasis?: boolean;
};

export type InspectView = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly hp: number;
  readonly maxHp: number;
  /** Effect ids the viewer can see on this actor, for the badge row. */
  readonly effects: readonly string[];
  readonly rows: readonly InspectRow[];
  /**
   * Why an attack would be refused right now, in the words the player should
   * read — "too close: needs 3 tiles", not `too_close`.
   *
   * PRESENT MEANS REFUSED. The Inspector's dead zone is the case that matters:
   * game-design.md calls min_range "the single most important number here", and
   * a class that silently does nothing at range 2 reads as broken rather than
   * as having a rule.
   */
  readonly blockedReason?: string;
};

// ---------------------------------------------------------------------------
// Talents — the shapes both halves of the wire need to name
// ---------------------------------------------------------------------------

/**
 * How a talent lands on the grid, and therefore what the targeting overlay
 * draws before you commit to it.
 *
 * MEMBER-FOR-MEMBER THE SERVER'S `TargetShape` (src/server/engine/talents.ts),
 * and that is a rule rather than a coincidence. The wire union must be able to
 * express every shape the server can produce, or the preview silently falls back
 * to a single tile for exactly the talents that most need a preview. Adding a
 * shape means adding it in both places in the same commit; the two are not
 * imported from one another because src/shared/ may not reach into the server.
 *
 * The authored source vocabulary is docs/data-schemas.md § 5 rule R8
 * (`target_shape`), so `grep -r cross content/skills` still finds both ends.
 * R8's `none -> passive` is deliberately absent: a passive is not a hotbar slot
 * and can never be the subject of a `talent` frame.
 */
export const TalentShape = {
  /** No target at all. Iron Curtain. The client must not enter targeting mode. */
  Self: 'self',
  /** One actor. The overlay snaps to bodies rather than to bare tiles. */
  Single: 'single',
  /** A tile plus its four orthogonal arms of length `radius` — Alchemic Vial. */
  Cross: 'cross',
  /** Every tile within `radius`, EUCLIDEAN — so the preview is a disc, not a box. */
  Ball: 'ball',
  /** A free tile to stand on. Fog Step. The overlay must reject occupied tiles. */
  Tile: 'tile',
} as const;
export type TalentShape = (typeof TalentShape)[keyof typeof TalentShape];

/**
 * What one use costs. Three budgets, because the game has three.
 *
 * AP and MP are the INTRA-TURN budget (PLAN.md § 6: a player action always
 * costs exactly one turn of energy, and AP/MP is what is spent inside that
 * turn); `resource` is the class pool named by `ResourceView.kind`. Every
 * talent uses two of the three and the unused ones are 0 rather than absent, so
 * the hotbar never has to write `?? 0` at four call sites.
 *
 * ONE OBJECT RATHER THAN THREE TOP-LEVEL FIELDS because they are one concept —
 * "what this costs" — and because the server's `TalentCost` is already shaped
 * this way, so projecting it is filling in defaults rather than flattening.
 */
export type TalentCostView = {
  /** Action points. "AP 5" in the class tables of game-design.md § 2. */
  ap: number;
  /** Movement points. Only Fog Step spends any in M3. */
  mp: number;
  /** Resolve / Focus / Reagents, per `ResourceView.kind`. */
  resource: number;
};

/**
 * ONE HOTBAR SLOT, as the owner sees it.
 *
 * Everything the client needs to draw the button AND the targeting overlay, and
 * nothing else — no damage formula, no scaling curve, no to-hit maths. Those
 * stay on the server (eslint.config.js blocks `client/** -> shared/checkhit*`
 * outright), and every number a player is shown is computed server-side and
 * sent. A second copy of a formula in the browser always diverges, and the
 * divergence shows up as a monster that was already dead.
 *
 * WHY THESE FIELDS AND NOT A TALENT'S WHOLE DEFINITION: this is the projection
 * of a server-side talent, so adding a field here is a deliberate decision to
 * let a client know something. The test is "does the hotbar or the ring need it
 * to draw?" — cost and cooldownTurns for the button, range/minRange/shape/radius
 * for the overlay.
 */
export type LoadoutTalent = {
  /** Namespaced `talent:<id>` (docs/data-schemas.md § 5 rule R6). Stable forever. */
  id: string;
  name: string;
  /** An asset key, never a path — the client owns the manifest. */
  icon: string;
  /**
   * What one use costs. The client greys the button when a budget is short; the
   * SERVER refuses the frame with `no_resource` regardless of what the button
   * looked like, because the button is a picture and the server is the rule.
   */
  cost: TalentCostView;
  /**
   * GAME TURNS, never ticks. ToME's own `game.turn` counts ticks and mixing the
   * two is a factor-of-ten bug that reads as "cooldowns feel instant".
   * 0 means at-will. Used as the DENOMINATOR of the cooldown wipe.
   */
  cooldownTurns: number;
  /** Maximum EUCLIDEAN distance in tiles. 0 for a `self` shape. */
  range: number;
  /**
   * THE DEAD ZONE. The closest legal distance; 0 means there is no hole.
   *
   * game-design.md § 2 calls the Inspector's `min_range 3` "the single most
   * important number here" — she cannot shoot an adjacent enemy, which is the
   * entire reason the Watchman holding a choke is worth anything. It is on the
   * wire so the ring can draw the hole: if the dead zone is invisible the class
   * reads as broken rather than as positional.
   *
   * The comparison is `distance < minRange`, so minRange 3 makes 3 the closest
   * LEGAL tile — and it is CIRCULAR, so the diagonal at (3,3) is 2.83 away and
   * sits INSIDE the hole. src/server/engine/combat.ts pins that with a test.
   */
  minRange: number;
  shape: TalentShape;
  /**
   * Arm length for `cross`, radius for `ball`, 0 for everything else.
   *
   * Not in the milestone's field list and here anyway, because "shape preview"
   * is in M3's definition of done and a shape without a size cannot be previewed
   * — the client would have to keep its own table of radii, which is a second
   * copy of authored data in the one place that must never hold one.
   */
  radius: number;
};

/**
 * Which resource a class spends. One per MVP class (game-design.md § 2).
 *
 * Deferred classes bring their own (the Enforcer's Shells, the Cipher-Clerk's
 * Citation), so this union grows rather than being generalised into a bag of
 * named numbers — a closed union is what lets the hotbar switch on it.
 *
 * DELIBERATELY IDENTICAL to the server's own `ResourceKind`
 * (src/server/engine/talents.ts). Two declarations rather than one import,
 * because src/shared/ may not reach into src/server/ — but the string values are
 * the same three, so the engine's value satisfies this type structurally and no
 * mapping function exists to get out of step.
 */
export const ResourceKind = {
  /** The Watchman. 0-100, builds when struck and when adjacent to an ally. */
  Resolve: 'resolve',
  /** The Inspector. Builds by holding LOS on a mark and by not moving. */
  Focus: 'focus',
  /** The Alchemist. A COUNTABLE stock of 0-8. See `discrete`. */
  Reagents: 'reagents',
} as const;
export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];

/**
 * The viewer's own resource pool, right now.
 *
 * A payload rather than fields on the message so that M4's party panel can carry
 * one of these per ally without a rename — the same reason `joined` wraps an
 * `ActorView` instead of inlining six fields.
 */
export type ResourceView = {
  kind: ResourceKind;
  current: number;
  max: number;
  /**
   * Draw PIPS, not a bar.
   *
   * game-design.md § 2 is emphatic that Reagents are "a countable stock of 0-8
   * that refills on kills and at stairs — not a regenerating bar. Every cast is
   * a discrete decision." A bar makes 3-of-8 look like 37% of something
   * continuous and quietly deletes the Alchemist's whole read.
   *
   * On the wire rather than derived from `kind` in the renderer, because
   * "which kinds are countable" is authored data, and a client-side copy of it
   * is exactly the table that will be missing the Enforcer's Shells in M5.
   */
  discrete: boolean;
};

// ---------------------------------------------------------------------------
// M4 — the Case Log, the statuses, the party panel
// ---------------------------------------------------------------------------

/**
 * THE TWO LANES OF THE CASE LOG (game-design.md § 11).
 *
 * They are not two styles of the same list, they are two different KINDS of
 * utterance, and keeping them apart is the entire design:
 *
 *   RECORD — what the rules did. Rolls, damage, saves, effects, "Marcus has not
 *     acted. Bell in 20s." Terse, mechanical, cream. It is machine-generated and
 *     it is VOLUMINOUS: one AoE produces eight lines.
 *   MARGIN — what a PERSON said (`say`), where a person pointed (`point`), and
 *     the Index's own voice. Italic, violet. Perhaps three lines a minute.
 *
 * Merged into one scrolling list, the Record buries the Margin within seconds of
 * combat opening — which means the log stops being a place people talk and
 * becomes a debug console. So the lane travels ON THE WIRE, per line, and the
 * client gives each lane its own reserved band and its own scroll position.
 * Deriving the lane client-side from the text would put a parser in the browser
 * and get it wrong the first time somebody says "19 physical" out loud.
 */
export const LogLane = {
  Record: 'record',
  Margin: 'margin',
} as const;
export type LogLane = (typeof LogLane)[keyof typeof LogLane];

/**
 * ONE LINE OF THE CASE LOG, already rendered to prose by the server.
 *
 * PROSE, NOT A TEMPLATE ID PLUS ARGUMENTS. The alternative — sending
 * `{k:'damage', amount:19, type:'physical'}` and formatting in the browser —
 * would put a second copy of the game's vocabulary in the client, and the first
 * time a talent grew a new field the log would print `undefined` at the one
 * moment anybody was reading it. The server already has every number; it writes
 * the sentence.
 *
 * FOV SEAM, AND IT IS THE SHARP ONE. architecture.md is explicit that the event
 * log leaks visibility more often than the tile grid does — "you hear a door
 * open" is a position. MVP ships SHARED PARTY FOV (game-design.md § 12), so one
 * line list is true for the whole party and `log` is broadcast. When per-player
 * FOV lands at M6 this frame becomes per-recipient and joins `ViewerMsg`.
 */
export type LogLine = {
  /**
   * Monotonic within a session, assigned by the server, never reused.
   *
   * The client de-duplicates on it (a resync resends recent lines) and anchors
   * its scroll to it, so a line arriving while the player is reading history
   * does not yank the view.
   */
  seq: number;
  lane: LogLane;
  /** The completed game turn this line belongs to. Drives the turn separators. */
  gameTurn: number;
  /**
   * The sentence. Plain text — it is drawn with `fillText` and mirrored into the
   * DOM with `textContent`, never as markup, because a `say` line is written by
   * another player and a name is a Discord nickname, which Discord does not
   * sanitise.
   */
  text: string;
  /**
   * Indent, in levels. 0 is a headline ("Dalt uses Ward Rush"), 1 is a
   * consequence hanging off it ("19 physical. Bent Watchman is Off-guard").
   * game-design.md § 11's sample log is written with exactly these two levels.
   */
  depth?: number;
  /**
   * WHO SPOKE, for a Margin line that came from a person. Absent on a Record
   * line and on the Index's own voice.
   *
   * Separate from `text` so the client can style the name and, more importantly,
   * so `text` is never trusted to contain one — a player whose nickname is
   * "Dalt: " must not be able to forge another player's attribution.
   */
  speaker?: string;
};

/**
 * NEW CASE LOG LINES, oldest first, in the order they should be appended.
 *
 * A batch rather than one frame per line: a single AoE produces eight Record
 * lines and a sweep produces dozens, and the client draws once per frame either
 * way. `seq` makes the batch idempotent, so the recovery path can simply resend
 * the tail.
 */
export type LogMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'log';
  lines: readonly LogLine[];
};

/**
 * One temporary effect on one actor, as a BADGE — never as its mechanics.
 *
 * WHAT IS NOT HERE, AND MUST NEVER BE: the save that was rolled, the power that
 * beat it, the damage-per-turn, the `globalSpeed` multiplier. Every one of those
 * is engine state (src/server/engine/effects.ts) and the client has no business
 * recomputing a duration or a tick. The badge answers exactly two questions —
 * "what is on me?" and "for how much longer?" — and the Record lane answers the
 * rest in words, which is where the save maths belongs.
 *
 * `icon` is an asset KEY, exactly like `ActorView.sprite` and `LoadoutTalent.icon`:
 * the client owns the manifest, so recutting the badge art cannot invalidate
 * anything. The three MVP statuses ship as `icon_status_{stunned,bleeding,slowed}`.
 */
export type EffectView = {
  /** Namespaced `effect:<id>`, matching the server's own registry key. */
  id: string;
  /** "Stunned". Drawn beside the badge in the party panel — never colour alone. */
  name: string;
  /** An asset key, never a path. 24x24 in the manifest. */
  icon: string;
  /**
   * GAME TURNS remaining, never ticks — the same unit as `CooldownsMsg`, and for
   * the same reason: mixing the two is a factor-of-ten bug that reads as
   * "statuses feel instant".
   */
  turns: number;
  /**
   * True when this is being done TO the bearer.
   *
   * On the wire rather than inferred from the id because "is this good for me?"
   * is authored data, and a client-side table of it is the one that will be
   * missing M5's first ambiguous buff. It decides which way the badge reads, not
   * whether it is shown.
   */
  harmful: boolean;
};

/** Every effect on one actor, in the order the server wants them drawn. */
export type ActorEffects = {
  id: string;
  effects: readonly EffectView[];
};

/**
 * WHO HAS WHAT ON THEM. COMPLETE AND ABSOLUTE, exactly like `CooldownsMsg`.
 *
 * Every actor with at least one effect appears; anything absent is CLEAN. Never
 * a patch — a client that dropped one frame would otherwise show a Stun badge on
 * a monster forever, and "is that one still stunned?" is a question that gets
 * somebody killed.
 *
 * Broadcast, not viewer-private. A status is visible on the token in ToME and it
 * is visible here: the whole party has to be able to see that the Watchman is
 * Stunned in order to decide who steps into the gap, and that conversation is
 * the game.
 */
export type EffectsMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'effects';
  actors: readonly ActorEffects[];
};

/**
 * ONE ORB IN FLIGHT, as the client draws it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS NOT AN ACTOR, AND IT MUST NEVER BECOME ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no new `ActorKind` member and there is no new `TurnEvent` variant.
 * `ActorKind` is switched on exhaustively by the renderer to pick a
 * `ui_token_ring_*` sprite, and the art is gitignored wholesale — a third member
 * would demand an asset that cannot be added and would fire the broken-manifest
 * alarm for every player, including on a bare clone. Upstream draws the same
 * line: `Projectile` inherits Entity, not Actor, and lives in `Map.PROJECTILE`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS A SNAPSHOT, NOT AN EVENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An orb is a three-turn object. Events are for instants: the client applies a
 * whole sweep in one synchronous pass and clears its markers a quarter of a
 * second later — exactly while the player is deciding whether to step out of the
 * line. So the launch is not announced; the orb is simply PRESENT in a frame
 * that is COMPLETE AND ABSOLUTE, the same rule `EffectsMsg` follows and for the
 * same reason: a client that dropped one patch would otherwise show a phantom
 * orb forever, and a phantom orb teaches the wrong counterplay.
 */
export type ProjectileView = {
  /** `proj_<n>`, from the world's monotonic counter. Stable for the whole flight. */
  id: string;
  /** Where it is RIGHT NOW. */
  x: number;
  y: number;
  /** WHO FIRED IT. May name a body that is already a corpse — an orb outlives its shooter. */
  sourceId: string;
  /**
   * THE TILE IT IS FLYING AT — the target's tile at the instant of firing, not
   * the target's tile now. It does not re-aim, and the whole counterplay is that
   * stepping off this tile makes it miss.
   */
  targetX: number;
  targetY: number;
  /**
   * GAME TURNS until it arrives, never milliseconds. The same unit as
   * `EffectView.turns` and `CooldownsMsg`, and for the same reason — mixing the
   * two is a factor-of-ten bug, and here it would be the difference between "you
   * have two turns to move" and "it lands before you can press a key".
   */
  turnsToImpact: number;
};

/**
 * EVERYTHING IN THE AIR. COMPLETE AND ABSOLUTE, exactly like `EffectsMsg`.
 *
 * An empty array means the sky is clear. Never a patch — see `ProjectileView`.
 *
 * ═══ IT IS A BROADCAST TODAY AND MUST MOVE TO `ViewerMsg` WITH PER-PLAYER FOV ═══
 * A projectile's tile is a POSITION, and a position is exactly the class of fact
 * the FOV projector exists to gate: an orb crossing an unexplored room tells you
 * something is shooting in it and roughly where from. Fog of war is still level-
 * wide (there is one `LevelView` and one actor list for everybody), so shipping
 * this to the room leaks nothing that `ActorView` does not already leak. THE DAY
 * PER-PLAYER FOV LANDS, THIS FRAME MOVES INTO `ViewerMsg` IN THE SAME COMMIT —
 * `BroadcastMsg` is `Exclude`-derived, so that move is one line here and a
 * compile error everywhere it was being broadcast.
 */
export type ProjectilesMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'projectiles';
  projectiles: readonly ProjectileView[];
};

/**
 * The two stages a body can be in below zero (game-design.md § 9).
 *
 * `up` is deliberately absent: a member who is on their feet carries `downed:
 * null`, so "is this a stage?" and "which stage?" are one question rather than
 * two, and there is no third spelling of conscious.
 *
 * MEMBER-FOR-MEMBER the engine's `Survival` minus `Up` (src/server/engine/
 * downed.ts), so the projector copies rather than translates. shared/ may not
 * import server/, which is exactly why the values have to be written out here
 * and kept identical by hand.
 */
export const DownedStatus = {
  /** 0 HP, *Unfiled*, counting down, revivable. Prone, and still in the log. */
  Downed: 'downed',
  /** The countdown ran out. Only a floor reset brings them back in MVP. */
  Erased: 'erased',
} as const;
export type DownedStatus = (typeof DownedStatus)[keyof typeof DownedStatus];

/**
 * A body on the floor, as the client draws it.
 *
 * `marker` is an ASSET KEY (`ui_marker_downed` / `ui_marker_erased`), the same
 * convention as `ActorView.sprite` and `LoadoutTalent.icon`: the client owns the
 * manifest, so recutting the overlay art cannot invalidate anything, and the
 * server never learns a path. It is carried rather than derived from `status`
 * because the two stages must be told apart at a glance across a room — one says
 * *run*, the other says *it is over* — and that is an art decision, not a
 * rendering one.
 *
 * `turnsLeft` AND `total` because a countdown without its denominator is not a
 * countdown: "2" means nothing, "2 of 5" means sprint.
 */
export type DownedView = {
  status: DownedStatus;
  marker: string;
  /** GAME TURNS until Erased. Stepped by the server; never interpolated here. */
  turnsLeft: number;
  total: number;
};

/**
 * Whether a party member's microphone is doing anything, right now.
 *
 * Three states rather than a boolean because MUTED and SILENT mean opposite
 * things to the person looking at the panel: silent is "they have not said
 * anything", muted is "they cannot", and telling someone to speak up when their
 * mic is off is exactly the confusion the indicator exists to remove.
 */
export const VoiceState = {
  Silent: 'silent',
  Speaking: 'speaking',
  Muted: 'muted',
} as const;
export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];

/**
 * ONE ROW OF THE PARTY PANEL.
 *
 * IT DELIBERATELY DOES NOT CARRY hp/maxHp, AND THAT IS THE POINT. `ActorView`
 * already carries them, `damage` events already keep them absolute and current,
 * and a second copy here would be a second copy that can disagree — visibly, in
 * the one place four people are staring to decide whether to run. The panel
 * JOINS this row to the actor of the same id and reads the bar from there; when
 * there is no actor (the body was removed after the grace expired) it draws the
 * row without a bar rather than inventing one.
 *
 * What IS here is everything `ActorView` cannot answer: the Downed timer, the
 * microphone, and whether anybody is still attached to the body.
 */
export type PartyMember = {
  /** The actor id, so the row joins to `ActorView` and to `ActorEffects`. */
  id: string;
  /** Discord nickname. Hostile input — textContent and fillText only. */
  name: string;
  /**
   * NULL WHEN THEY ARE ON THEIR FEET. Otherwise the stage and the countdown.
   *
   * A payload rather than `hp === 0` because those are different facts: a
   * monster at 0 hp is a corpse, an Erased player is at 0 hp too, and only one
   * of the three means *get to me*. It is also the field the map layer reads —
   * the downed marker and the prone body are drawn from this and nothing else.
   */
  downed: DownedView | null;
  voice: VoiceState;
  /**
   * False for a body inside its reconnect grace. Distinct from Standing By
   * (which is `TurnMsg.standingBy` and is about the QUORUM): a player can be
   * connected and standing by after two silent turns.
   */
  connected: boolean;
};

/**
 * THE PARTY, ALL OF IT, EVERY TIME.
 *
 * Low-frequency by construction — it changes when somebody goes down, gets up,
 * mutes, drops or reconnects, and not when they take a hit. That is what lets it
 * be a whole-list replacement instead of a delta, and it is why hp is not on it.
 *
 * ═══ v6 DID NOT NARROW THIS FRAME, AND THAT IS DELIBERATE ═══
 * `members` is still every player ON THE FLOOR. The level is what the server
 * simulates; the downed markers and the revive prompt are drawn from this list;
 * and reviving somebody who is not in your party is legal and always was. WHO
 * SHARES YOUR BARRIER is a different question and it has its own frame —
 * `party_state`, below, which is per-recipient because the answer is.
 */
export type PartyMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'party';
  members: readonly PartyMember[];
};

/**
 * SOMEBODY POINTED AT A TILE.
 *
 * The cheapest social mechanic in the game and the one people in a voice channel
 * do constantly: "there, behind the pillar". It is a MARKER, not an order — it
 * changes nothing, costs nothing, and expires on the client after a few seconds.
 *
 * The accompanying Margin line ("Dalt points at 12,8") is a separate `log`
 * frame, because a ping must be readable by somebody who was scrolled up or
 * looking at the other end of the map, and because the log is the transcript.
 */
export type PingedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'pinged';
  /** WHO pointed. The client labels the marker with their name. */
  id: string;
  x: number;
  y: number;
};

// ---------------------------------------------------------------------------
// v6 — EXPLICIT PARTIES. WHO SHARES YOUR BARRIER.
// ---------------------------------------------------------------------------

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * `party_state` AND `party` ARE TWO DIFFERENT FRAMES AND BOTH ARE NEEDED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `party` (`PartyMsg`, above) is the LEVEL'S roster: every detective on the
 * floor, their Downed timer, their voice dot, whether anybody is attached to
 * the body. It is what the map layer reads to draw a prone body and what the
 * revive prompt reads to know somebody is lying next to you — and reviving a
 * stranger is legal and always was, so that list must stay level-wide. It is
 * BROADCAST, because under shared party FOV it is identical for everyone.
 *
 * `party_state` is YOUR PARTY: the people who share your barrier, who is
 * leading, and the invites waiting on your answer. It is per-recipient — a
 * `ViewerMsg` — for two independent reasons, and each alone would be enough:
 * `isSelf` is true for exactly one person (the same reason `turn` joined that
 * union at v5), and `invites` is a list of decisions that belong to one player.
 *
 * A CLIENT MUST NOT DERIVE ONE FROM THE OTHER. "Everyone in `turn.actors`" is
 * not the party — from v6 the turn strip is already party-scoped, so deriving
 * membership from it is circular — and "everyone in `party`" is the floor.
 */

/**
 * ONE ROW OF THE PARTY PANE — the left-hand pane, which is where a player looks
 * to answer "who am I waiting for, and are they still there?".
 *
 * IT CARRIES hp/maxHp AND `PartyMember` DELIBERATELY DOES NOT, which looks like
 * a contradiction and is not. `PartyMember`'s note argues that a second copy of
 * a bar can disagree with `ActorView`'s — true, and the cure there is that the
 * panel JOINS to the actor of the same id. This frame cannot rely on that join:
 * a party member may be a body the viewer's actor table does not hold, because
 * `ActorView` is the FOV seam and a friend on the far side of the floor is
 * exactly who a party pane most needs to show. A row with a name and no bar for
 * the person you are trying to reach is the failure this field prevents.
 *
 * It is bounded the same way `TurnActor`'s copy is: this frame goes out only
 * when the party's own comparison key changes, which is when these numbers
 * change anyway, so a stale bar cannot sit next to a fresher one for long.
 */
export type PartyStateMember = {
  /** The actor id. Joins to `ActorView`, `PartyMember` and `TurnActor`. */
  id: string;
  /** Already through the display-name filter. Hostile input — never markup. */
  name: string;
  /**
   * AN ASSET KEY, NEVER A PATH — the same contract as `ActorView.sprite` and
   * `TurnActor.portrait`, and it is the same class icon the turn card uses, so
   * one face means one person across both surfaces. Absent when there is no
   * honest picture to use.
   */
  portrait?: string;
  hp: number;
  maxHp: number;
  /**
   * WHAT THE BARRIER IS DOING ABOUT THIS MEMBER, in the turn tracker's own
   * vocabulary (`TurnActorState`) rather than a second one.
   *
   * REUSED RATHER THAN REDECLARED, and that is the point: the values ARE the
   * art suffixes (`ui_icon_turn_${state}`), so the pane and the strip draw the
   * same chip for the same fact and cannot drift into saying different things
   * about the same player on one screen. `acting` never appears here — it
   * belongs to the monsters card alone and there is no monsters row in a party.
   */
  state: TurnActorState;
  /** Only the leader may `kick`. The client greys the control for everyone else. */
  isLeader: boolean;
  /** WHICH ROW IS YOU. The reason this frame is a `ViewerMsg`. */
  isSelf: boolean;
  /**
   * IS ANYBODY DRIVING THIS BODY RIGHT NOW?
   *
   * False for a body inside its reconnect grace — the ten minutes during which
   * it stays standing in the world (game-design.md § 4) so its owner can come
   * back to it. A disconnected member is NOT removed from the party: removing
   * somebody because their wifi blinked is the same mistake as removing their
   * body from the level, and it is the mistake real play reported.
   *
   * Distinct from `state`, which will say `standing_by` for the same body: that
   * is what the barrier is doing (nothing), this is why.
   */
  online: boolean;
};

/**
 * YOUR PARTY, ALL OF IT, EVERY TIME. Sent to the AFFECTED MEMBERS ONLY.
 *
 * A whole-list replacement rather than a delta, for the same reason `party`,
 * `effects` and `cooldowns` are: a client that dropped one frame is corrected
 * by the next, instead of showing somebody in a party they left half an hour
 * ago. It is low-frequency by construction — membership, leadership, presence
 * and invites, none of which move when somebody takes a hit.
 *
 * "AFFECTED MEMBERS ONLY" IS ENFORCED BY THE ENGINE, NOT REMEMBERED BY THE
 * GATEWAY: `PartyResult.affected` (src/server/engine/party.ts) is the union of
 * both parties involved, captured before the change, because after an accept
 * one of them no longer exists to be asked about.
 */
export type PartyStateMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'party_state';
  /** Always one of `members`. A leaderless party is not representable. */
  leaderId: string;
  /**
   * JOIN ORDER, and stable — the same guarantee `TurnMsg.actors` gives, for the
   * same reason: a row that moves between two frames is a row somebody
   * misclicks, and `kick` is on this pane.
   *
   * NEVER EMPTY. Every player is always in a party and a solo player is a party
   * of one (see engine/party.ts), so the shortest legal list is the viewer
   * alone — which is exactly what a solo player should see, and is why there is
   * no "not in a party" state for a client to render.
   */
  members: readonly PartyStateMember[];
  /** Offers waiting on the recipient, oldest first. Empty is the normal case. */
  invites: readonly PartyInviteView[];
};

/**
 * AN OFFER WAITING ON YOU. Never one you sent.
 *
 * OUTGOING INVITES ARE DELIBERATELY ABSENT: a list of them is a list of other
 * people's pending decisions, which is theirs to make and not the inviter's to
 * watch. What the inviter gets instead is a Case Log line saying the offer went
 * out — a transcript rather than a status board.
 *
 * THE NAME IS CARRIED, not joined from `members` or from `ActorView`, and that
 * is deliberate: whoever asked is by definition NOT in your party yet, and they
 * may be standing on the far side of the floor — which is exactly the body the
 * FOV seam will one day withhold. A row that said "somebody invites you" would
 * be useless at the one moment it has to be acted on.
 */
export type PartyInviteView = {
  /** The actor who asked. Joins to `ActorView` when the viewer can see them. */
  fromId: string;
  /** Their display name, already through the filter. Hostile input. */
  fromName: string;
  /**
   * How many are already in the party being offered.
   *
   * On the wire because "join Ren and 2 others" and "join Ren" are different
   * decisions, and because the recipient cannot count it themselves: this is
   * the one party whose membership they are not being sent.
   */
  size: number;
  /**
   * MILLISECONDS LEFT, not a deadline timestamp — the client's clock is not the
   * server's, and the same argument `TurnMsg.bellMs` makes applies here.
   *
   * AN INVITE LAPSING IS NOT AN EVENT THE WORLD PRODUCES. Out of combat the
   * pump reaches its idle fixed point and there may be no frame for minutes, so
   * a row with no countdown on it would sit on screen long after the server had
   * stopped honouring it. The client counts this down and drops the row itself;
   * the server refuses a lapsed invite regardless, so a client that draws one a
   * second too long costs one refusal and nothing else.
   */
  expiresInMs: number;
};

// ---------------------------------------------------------------------------
// CLIENT -> SERVER. Hostile input. zod is the only thing standing here.
// ---------------------------------------------------------------------------

/** Reused so a schema change cannot be applied to some messages and not others. */
const envelopeVersion = z.literal(PROTOCOL_VERSION);

/**
 * `strictObject`, not `object`: unknown keys are REJECTED rather than stripped.
 * A frame carrying an `actorId` is a client trying to act as someone else, and
 * it should fail loudly in the log, not get quietly sanitised.
 */
const HelloSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('hello'),
  /**
   * Opaque, server-minted, handed out in `welcome`. Proves "I am the socket that
   * dropped a moment ago" so a reconnect reattaches to the same actor instead of
   * spawning a duplicate. It is NOT an identity claim — the session behind it is
   * what carries the Discord user, and an unknown or expired token just means a
   * fresh session.
   */
  resumeToken: z.string().min(1).max(256).optional(),
  /**
   * THE ONE THING ON THE WIRE THAT LEADS TO A NAME, AND IT IS NOT A NAME.
   *
   * `session_id` from `POST /api/token` (src/server/http/auth.ts), presented
   * back verbatim. It is 32 CSPRNG bytes base64url with NO payload, NO
   * signature and NO structure — the mapping from this handle to a Discord user
   * lives in one Map in this process, put there only after a server-side
   * `GET /users/@me` said who the holder was.
   *
   * SO IT IS NOT AN IDENTITY FIELD, AND CLAUDE.md NON-NEGOTIABLE 5 STILL HOLDS.
   * The protocol has no `actorId` and no `userId`, here or anywhere: there is no
   * field in which a client can say "I am Ren". It can only say "I hold a handle
   * this server minted", and the server is the only thing that can turn that
   * into a person. A forged, expired or unknown handle is not an error and not a
   * refusal — it is simply anonymous play, exactly as an absent one is.
   *
   * SEPARATE FROM `resumeToken` ON PURPOSE. They answer different questions:
   * the resume token says "I am the socket that dropped a moment ago" (it dies
   * with the actor), this says "you already know who I am" (it outlives every
   * socket and survives a reconnect). Folding them into one field would mean a
   * dropped socket could resume as somebody else's character the moment the two
   * lifetimes disagreed.
   */
  sessionId: z.string().min(1).max(256).optional(),
});

const MoveSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('move'),
  /**
   * A direction, never a destination and never an actor. The server decides
   * whose actor moves, whether the target tile is walkable, and what the
   * resulting position is. The client is stating an intent.
   */
  dir: z.enum(DIR_ORDER),
});

/**
 * "I am done deciding; resolve my turn." The Warrant Clock's first verb.
 *
 * Carries NOTHING — not the intent, not an actor, not a turn number. The action
 * itself already arrived as a `move` (and, from M3, as `talent`) and has already
 * resolved: commit-on-submit, resolve immediately (game-design.md § 4). This
 * frame only says the player has stopped deliberating, which is what the barrier
 * and the Bell are waiting to hear.
 *
 * A `gameTurn` on the wire would be a client asserting which turn it is
 * committing to, and a stale or forged one would let a socket commit a turn it
 * has not seen. The server knows which turn is open.
 */
const CommitSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('commit'),
});

/**
 * "Pass — I brace and do nothing." The Warrant Clock's second verb, and the
 * same action the Bell applies to a straggler when it expires (game-design.md
 * § 4: on expiry, uncommitted players `hold`. NEVER a random attack — that gets
 * someone killed and ends friendships).
 *
 * Separate from `commit` rather than a flag on it because holding is a real game
 * action with a real effect (+defence), not an empty commit.
 */
const HoldSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('hold'),
});

/**
 * Highest coordinate a client may name. The map is 30x30 and the largest one
 * ever planned is nothing like 4096, so this is not a map bound — it is a bound
 * on what arithmetic the server will perform on an attacker-supplied number
 * before the real in-bounds check runs. `z.number().int()` already rejects NaN
 * and Infinity; this rejects the merely absurd.
 */
const MAX_TILE_COORD = 4095;

/** Bounded so a target cannot be a float, a NaN, or 1e300. */
const TileSchema = z.strictObject({
  x: z.number().int().min(0).max(MAX_TILE_COORD),
  y: z.number().int().min(0).max(MAX_TILE_COORD),
});

/**
 * "Use this talent, aimed here." The M3 verb.
 *
 * STILL NO IDENTITY FIELD, and `strictObject` means a frame carrying one is
 * rejected rather than sanitised. `talent` names WHICH talent and WHERE, exactly
 * as `move` names a direction; whose body casts it is the socket's business and
 * is resolved from the session.
 *
 * `talentId` is a string rather than a `z.enum` of the twelve MVP ids ON
 * PURPOSE. The talent table is server-side authored content that reloads without
 * a protocol bump (`reloadcontent`, M5), and baking the catalogue into the wire
 * schema would mean every content edit is a protocol change. An unknown id is
 * refused by the server's own lookup with `bad_message`, which is the same
 * outcome one step later and does not couple the two.
 *
 * `target` is OPTIONAL because a `self` shape has no target. It is not
 * `nullable`: an absent target and a null one would be two spellings of the same
 * thing, and the second one always turns up in a hand-rolled client.
 *
 * WHAT THIS SCHEMA DOES NOT CHECK, and must not be mistaken for checking: that
 * the talent is in your loadout, off cooldown, affordable, in range, outside the
 * dead zone, and in line of sight. zod validates SHAPE. Every one of those is a
 * question about the world, it is answered in src/server/turn-engine.ts, and a
 * frame that passes this schema is still refused with a specific `ErrorCode`.
 */
const TalentSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('talent'),
  talentId: z.string().min(1).max(64),
  target: TileSchema.optional(),
});

const PingSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('ping'),
});

/**
 * Longest thing a player may say in one line, matching docs/architecture.md § 3.
 *
 * Exported so the command line's `maxlength` and this schema are ONE number. Two
 * numbers means the day they drift a player types a sentence, watches the input
 * accept it, and gets `bad_message` back — the input lying about what the server
 * will take is worse than a short limit.
 *
 * 500 rather than Discord's 2000 because this is a log line drawn in a 200-pixel
 * column, not a chat message, and it is broadcast to everyone.
 */
export const SAY_MAX_CHARS = 500;

/**
 * `say` — ONE LINE IN THE MARGIN. The whole social half of the MVP.
 *
 * It is a game action in the same sense a `hold` is: it costs no energy, it
 * cannot be refused for being out of turn, and it is broadcast to the party as a
 * Margin `log` line. A player who is Downed can still use it — game-design.md
 * § 9 says so explicitly, and "you can still talk" is what stops being at 0 hp
 * from being a spectator seat.
 *
 * IT CARRIES NO SPEAKER. Like every other client frame, who said it is the
 * socket's business and is resolved server-side; a `speaker` field here would be
 * a request to put words in someone else's mouth, and `strictObject` rejects it.
 *
 * `.trim()` before `.min(1)`: a line of spaces is not something anybody said,
 * and letting it through would produce blank Margin lines that scroll real ones
 * off the reserved band.
 */
const SaySchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('say'),
  text: z.string().trim().min(1).max(SAY_MAX_CHARS),
});

/**
 * `point` — "there, behind the pillar".
 *
 * A TILE, deliberately, and never an actor id: people point at places, the thing
 * standing there may die before anyone looks, and naming a body would leak
 * whether something the pointer can see is alive. It changes nothing in the
 * world; the server answers with a `pinged` broadcast plus a Margin log line.
 *
 * Bounded by the same `TileSchema` the talent target uses, so a coordinate a
 * client invents is rejected before any arithmetic is done on it.
 */
const PointSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('point'),
  x: TileSchema.shape.x,
  y: TileSchema.shape.y,
});

/**
 * `revive` — PICK UP THE ALLY BESIDE YOU (game-design.md § 9).
 *
 * A DIRECTION, exactly like `move`, and for exactly the same reason: naming the
 * ally would be an identity claim on the wire, and the tile beside you is the
 * only place a revive can happen anyway. The server decides who is standing
 * there, whether they are Downed, whether the reviver can afford it, and what
 * fraction of hp they come back with.
 *
 * A separate verb rather than an overload of `move` because the two must fail
 * differently. Walking into an occupied tile is `illegal_move` and the answer is
 * "go round"; a revive that will not happen has a dozen possible reasons and the
 * player needs to be told which one.
 */
const ReviveSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('revive'),
  dir: z.enum(DIR_ORDER),
});

/**
 * `respawn` — GET YOURSELF BACK ON YOUR FEET. The way out of Erased.
 *
 * ═══ IT CARRIES NOTHING, AND THE EMPTINESS IS THE SECURITY PROPERTY ═══
 * There is no target field and there never will be: a respawn is SELF-SERVICE,
 * the actor is the one this socket owns, and `strictObject` rejects a frame that
 * tries to name somebody else rather than quietly stripping the key. It is the
 * same shape as `commit` and `hold` and for the same reason — this is something
 * a socket DOES, not something it asks for on another player's behalf.
 *
 * ═══ WHEN THE SERVER SAYS YES ═══
 * Only out of ERASED. Reported from real co-op play: a player whose countdown
 * ran out had no path back at all — `revive` refuses an erased body by design,
 * and the party wipe that would have reset the floor could not fire while a
 * disconnected friend's body counted as a survivor. Erased was terminal in a
 * game that has no permadeath, which is a contradiction somebody sat inside for
 * an evening.
 *
 * It is refused while the sender is UP (nothing to file) and — the one that
 * matters — while they are DOWNED. Downed already has a five-turn countdown and
 * an ally running at it; a self-respawn out of Downed would delete the mechanic
 * game-design.md § 9 calls the one that does most for co-op tension. The refusal
 * comes back as `not_your_turn` with the server's own sentence.
 *
 * NO PERMADEATH IS ADDED OR REMOVED HERE. The restoration is the wipe's own
 * (`standUp` in src/server/engine/downed.ts): full hp, both clocks re-zeroed,
 * nothing lost, and the body walks back on at a spawn tile.
 */
const RespawnSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('respawn'),
});

/**
 * Longest actor id a client may name. `actor_u_<16 hex>` is 24 characters and
 * `actor_<uuid>` is 42; 64 is headroom without being a place to park a payload.
 */
const ACTOR_ID_MAX_CHARS = 64;

/**
 * The five things a player may do about a party. A closed enum on the wire, so
 * an unknown verb is refused by zod rather than reaching a switch that has no
 * case for it.
 */
export const PartyAction = {
  /** "Play with me." An OFFER: it changes neither party until it is accepted. */
  Invite: 'invite',
  /** Take the offer. You leave whatever party you were in, in the same step. */
  Accept: 'accept',
  /** Turn it down. Nothing changes except that the prompt goes away. */
  Decline: 'decline',
  /** Walk out. You land in a fresh party of one, never in limbo. */
  Leave: 'leave',
  /** Remove somebody else. LEADER ONLY, and never yourself. */
  Kick: 'kick',
} as const;
export type PartyAction = (typeof PartyAction)[keyof typeof PartyAction];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `party` — WHO YOU ARE PLAYING WITH. THE v6 VERB.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The barrier is per-party from v6 (src/server/engine/party.ts): a solo player
 * must never wait on somebody who is not in their party, and this is the frame
 * that says who is. Real multiplayer found the bug first — a solo player was
 * blocked by a stranger, and then by a stranger who had closed the tab.
 *
 * ═══ `targetId` IS THE FIRST FIELD IN THIS PROTOCOL THAT NAMES ANOTHER ACTOR,
 *     AND THE MISSING-FIELD RULE AT THE TOP OF THIS FILE IS UNBROKEN ═══
 *
 * That rule is about the SUBJECT of a verb, not its object. It says a client
 * may never state WHO IS ACTING — no `userId`, no `actorId`, no `charId` — and
 * `party` still does not: who is inviting, accepting, declining, leaving or
 * kicking is resolved server-side from the socket's session, exactly as with
 * `move`. `targetId` is the OBJECT: who is being invited, or removed. There is
 * no verb here that can be pointed at somebody else's body on their behalf.
 *
 * Three things make that safe rather than merely arguable:
 *
 *   IT IS AN ACTOR ID, NEVER A DISCORD ID. `actorIdForUser` (net/gateway.ts)
 *   hashes the snowflake out of existence before any id is minted, and this
 *   protocol has never carried an account id in either direction. A client that
 *   sent one would be naming something the server has no table for.
 *
 *   IT NAMES SOMETHING THE SENDER CAN ALREADY SEE. Every actor id on this wire
 *   arrived in `ActorView` — on the map, in the party panel, on a turn card —
 *   so a `targetId` discloses nothing the recipient was not already sent. That
 *   is what makes right-clicking somebody's avatar a legal way to invite them.
 *
 *   IT CANNOT BE USED TO ACT AS SOMEBODY. The server refuses any target that is
 *   not a live player, and `kick` additionally requires that the SENDER is the
 *   leader of a party the target is actually in. The worst a forged id achieves
 *   is a refusal.
 *
 * ═══ IT IS OPTIONAL, AND WHICH ACTIONS NEED IT IS THE SERVER'S RULE ═══
 * `leave` never carries one (you can only leave your own party). `invite` and
 * `kick` require one. `accept` and `decline` MAY carry one to name which offer
 * they answer, and without one they answer the OLDEST outstanding invite —
 * which is what a bare `/accept` typed into the command line has to mean.
 *
 * Enforcing the pairing in zod would need a discriminated union of five member
 * schemas, and the refusal it bought would be `bad_message` — the same answer
 * one step later, from the layer that also has to check that the target exists,
 * is a player, and is not already in your party. One rule, one place.
 */
const PartySchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('party'),
  action: z.enum([
    PartyAction.Invite,
    PartyAction.Accept,
    PartyAction.Decline,
    PartyAction.Leave,
    PartyAction.Kick,
  ]),
  /** An ACTOR id — the object of the verb, never its subject. See above. */
  targetId: z.string().min(1).max(ACTOR_ID_MAX_CHARS).optional(),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `inspect` — "WHAT IS THAT, AND CAN I HIT IT?" The hover/right-click question.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A request/response pair rather than three more fields on `ActorView`, because
 * `ActorView` streams to everybody on every pump and an inspect card is asked
 * for perhaps twice a minute by one person. Fattening the frame everyone always
 * gets, to carry a thing almost nobody is looking at, is the wrong trade in both
 * directions — bandwidth and the FOV audit, since every field added to
 * `ActorView` has to be re-argued against "would this leak?".
 *
 * ═══ `targetId` IS THE OBJECT OF THE VERB, NEVER ITS SUBJECT ═══
 * The missing-field rule at the top of this file is about WHO IS ACTING, and
 * this frame still never says: who is doing the looking is resolved server-side
 * from the socket's session, exactly as with `move` and `party`. `targetId` says
 * WHAT IS BEING LOOKED AT. The same three things make it safe as make `party`'s
 * safe:
 *
 *   IT IS AN ACTOR ID, NEVER A DISCORD ID. Ids are minted from a hash of the
 *   snowflake (`actorIdForUser`, net/gateway.ts) and no account id has ever
 *   travelled on this wire in either direction.
 *
 *   IT NAMES SOMETHING THIS CLIENT WAS ALREADY SENT. Every id a player can
 *   point at arrived in an `ActorView`, so asking about one discloses nothing
 *   the sender did not already have — which is exactly what makes hovering a
 *   token a legal way to ask.
 *
 *   IT CANNOT BE USED TO ACT AS ANYBODY. The verb changes nothing in the world,
 *   consumes no RNG and costs no turn. The worst a forged id achieves is
 *   `inspected` with `view: null`, which is also the answer for a body the
 *   sender cannot see — see `InspectedMsg`.
 *
 * ═══ `v` IS NOT BOILERPLATE HERE, IT IS THE ONLY VERSION CHECK ═══
 * `parseClientMsg`'s own check below is guarded by `'v' in candidate`, and the
 * gateway's `wireVersion` returns undefined for a frame that has no `v` — so a
 * frame that simply OMITS the field skips version enforcement entirely. The
 * `z.literal` is what makes it mandatory. Every schema in this file carries it
 * for that reason; none of them may be the one that forgets.
 */
const InspectSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('inspect'),
  targetId: z.string().min(1).max(ACTOR_ID_MAX_CHARS),
});

/**
 * The complete set of things a client may say.
 *
 * A discriminated union on `t` rather than a plain union: zod can then dispatch
 * on the tag instead of trying every branch, and the failure message names the
 * field that is wrong instead of dumping eight parallel errors.
 */
export const ClientMsg = z.discriminatedUnion('t', [
  HelloSchema,
  MoveSchema,
  TalentSchema,
  CommitSchema,
  HoldSchema,
  SaySchema,
  PointSchema,
  ReviveSchema,
  RespawnSchema,
  PartySchema,
  InspectSchema,
  PingSchema,
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/** Narrowed aliases, so a handler can take one variant without re-deriving it. */
export type ClientHello = z.infer<typeof HelloSchema>;
export type ClientMove = z.infer<typeof MoveSchema>;
export type ClientTalent = z.infer<typeof TalentSchema>;
export type ClientCommit = z.infer<typeof CommitSchema>;
export type ClientHold = z.infer<typeof HoldSchema>;
export type ClientSay = z.infer<typeof SaySchema>;
export type ClientPoint = z.infer<typeof PointSchema>;
export type ClientRevive = z.infer<typeof ReviveSchema>;
export type ClientRespawn = z.infer<typeof RespawnSchema>;
export type ClientParty = z.infer<typeof PartySchema>;
export type ClientInspect = z.infer<typeof InspectSchema>;
export type ClientPing = z.infer<typeof PingSchema>;

// ---------------------------------------------------------------------------
// SERVER -> CLIENT. Our own data — types only, no runtime validation.
// ---------------------------------------------------------------------------

/**
 * Closed union so the client can branch on a code rather than string-matching a
 * human-readable message. Add a member here when a new failure mode appears;
 * `message` is for the player and the log, `code` is for the program.
 */
export const ErrorCode = {
  BadMessage: 'bad_message',
  VersionMismatch: 'version_mismatch',
  NotAuthenticated: 'not_authenticated',
  /**
   * "That tile, no." A wall, the edge of the map, or — from M3 — a talent aimed
   * at a tile that is not on the grid at all.
   */
  IllegalMove: 'illegal_move',
  /**
   * The barrier refused a `commit`, `hold` or `move`: this actor is not parked,
   * has already committed, or is on Standing By.
   *
   * Separate from `IllegalMove` because the two mean opposite things to a
   * client. `IllegalMove` is "that tile, no" and the player should try another
   * direction; this is "not now" and the player should wait for a `turn`. A
   * client that conflated them would tell someone their input was wrong when
   * the real answer is that the server has not asked them yet.
   */
  NotYourTurn: 'not_your_turn',
  RateLimited: 'rate_limited',
  Internal: 'internal',

  // -------------------------------------------------------------------------
  // M3: the five ways a talent frame is refused.
  //
  // FIVE CODES AND NOT ONE, BECAUSE THE CLIENT DOES FIVE DIFFERENT THINGS.
  // Collapsing these into `illegal_move` would be one line shorter here and
  // would make the whole targeting UI a guess: the ring cannot flash its hole
  // for `too_close`, the hotbar cannot flash the button for `on_cooldown`, and
  // the resource pips cannot flash for `no_resource`, so all three degrade into
  // "the server said no" and the player learns nothing about which rule they
  // broke. A refusal is the ONLY teaching moment a targeting mode has.
  //
  // They are also the audit trail for a hand-crafted frame: a client that keeps
  // sending `out_of_range` is a bug, and one that keeps sending `too_close` at
  // distance 1 is someone testing whether the dead zone is real.
  // -------------------------------------------------------------------------

  /** Beyond the talent's `range`, EUCLIDEAN — the ring is a circle, not a box. */
  OutOfRange: 'out_of_range',
  /**
   * INSIDE the dead zone: nearer than `minRange`. The Inspector cannot shoot
   * what is standing on her (game-design.md § 2).
   *
   * NEVER reported as `out_of_range` and never as a miss. It is the opposite
   * instruction — back away rather than close in — and a player told "out of
   * range" while standing on the target will conclude the class is broken.
   */
  TooClose: 'too_close',
  /** Still cooling down. `cooldowns` says how many game turns are left. */
  OnCooldown: 'on_cooldown',
  /** Not enough Resolve / Focus / Reagents. */
  NoResource: 'no_resource',
  /** A wall between the caster and the target tile. */
  NoLos: 'no_los',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Turn events — what actually happened, in resolution order
// ---------------------------------------------------------------------------

/**
 * ONE thing that happened during a pump.
 *
 * A discriminated union on `k` (not `t`) so that an event can never be mistaken
 * for a message and vice versa: `t` tags the ENVELOPE, `k` tags the CONTENT.
 * A `sweep` carries a `TurnEvent[]`; the single-event messages below carry one.
 *
 * `id` IS ALWAYS THE ACTOR THE EVENT IS ABOUT — the mover, the attacker, the
 * victim, the deceased. Not always the actor who caused it: `damage` names the
 * one who took it and puts the dealer in `sourceId`, because the client's job
 * on a damage event is to shake the thing that got hit.
 *
 * Every field here is already FOV-filtered by construction in M2, because the
 * projector sends every actor to everyone. FOV SEAM (M3): an event about an
 * actor the viewer cannot see must be dropped or redacted per recipient before
 * it reaches this type — "you hear a door open" is a position, and an event log
 * leaks visibility more often than the tile grid does.
 */
export type MoveEvent = {
  k: 'move';
  id: string;
  /** Where it came from, so the client can animate the step without guessing. */
  fromX: number;
  fromY: number;
  x: number;
  y: number;
};

/**
 * A swing. Carries `hit` because a MISS produces no damage event and would
 * otherwise be invisible — a monster that steps up and does nothing looks like
 * a bug rather than a dodge.
 */
export type AttackEvent = {
  k: 'attack';
  /** The attacker. */
  id: string;
  targetId: string;
  /** The target's tile. Saves the client a lookup for an actor that may die. */
  x: number;
  y: number;
  hit: boolean;
};

export type DamageEvent = {
  k: 'damage';
  /** The VICTIM. */
  id: string;
  amount: number;
  /**
   * The victim's hit points AFTER the hit, and their maximum. Absolute rather
   * than a delta: a client that missed a frame is corrected by the next hit
   * instead of drifting forever. Named to match `ActorView` and the engine's own
   * actor so that constructing one is a copy rather than a rename.
   */
  hp: number;
  maxHp: number;
  /** Who dealt it, when there is an actor to blame. */
  sourceId?: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE BLOW WENT THE OTHER WAY: HP RESTORED, NOT REMOVED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A heal reaches the client on THIS frame rather than a `heal` frame of its
   * own, for the reason `TalentEvent` gives for not carrying a victim list: the
   * client's job on both is identical — set `hp` to the absolute number in the
   * frame — and a second frame kind for "an actor's hp changed" is a second
   * implementation of the same fact that will eventually disagree about which
   * one wins.
   *
   * WHEN IT IS SET, `amount` IS 0 AND NO `attack` FRAME PRECEDES THIS ONE. The
   * Alchemist's Mend Wounds used to arrive as a blow with `damage: 0, hit: true`
   * because the engine's `TalentHit.healed` was dropped on the way to the wire:
   * the Case Log read "Ren hits Ren. / 0 damage. Ren 41.5/54." for the party's
   * only heal, and render/sweep.ts stamped the STRUCK-TILE marker on every
   * healed ally. Absent means damage, exactly as it always did.
   */
  healed?: number;
};

export type DeathEvent = {
  k: 'death';
  /** The deceased. */
  id: string;
  killerId?: string;
};

/**
 * A TALENT WENT OFF. The FX stamp, and nothing else.
 *
 * IT CARRIES NO DAMAGE AND NO HIT FLAG, on purpose. A talent that hurts three
 * things emits this once and then one `attack`/`damage`/`death` triple per
 * victim, in resolution order, exactly as a weapon swing does. That is what
 * keeps the client's `applyTurnEvent` a single function: an AoE is not a special
 * case of damage, it is one stamp followed by the same damage events as
 * everything else. Folding a victim list in here would be a second, parallel
 * implementation of "an actor took damage" — and two of those always end up
 * disagreeing, usually about whether something died.
 *
 * `shape` and `radius` are repeated from the caster's `loadout` rather than
 * looked up, because a spectator gets this event for a talent that is not in
 * their own loadout and has no table to look it up in. Three fields beats
 * broadcasting everyone's hotbar.
 */
export type TalentEvent = {
  k: 'talent';
  /** THE CASTER. */
  id: string;
  /** Namespaced `talent:<id>`. The client resolves the icon from its manifest. */
  talentId: string;
  /**
   * Where it landed — the centre of the stamp, the far end of a beam, and the
   * CASTER'S OWN TILE for a `self` shape (never a sentinel; -1 would be drawn).
   */
  x: number;
  y: number;
  shape: TalentShape;
  /** Arms for `cross`, radius for `ball`, 0 otherwise. */
  radius: number;
  /** Set when the talent named an ACTOR rather than a bare tile. */
  targetId?: string;
};

/**
 * A STATUS LANDED — M4, and the first event whose numbers are the whole point.
 *
 * `turns` is what SURVIVED the save; `maximum` is what was asked for. Both are
 * on the wire because `turns < maximum` IS the partial save (Actor.lua:7004-7014
 * — the duration is scaled by how narrowly the save failed, and the stochastic
 * rounding at :7011 is what stops a near-miss collapsing to nothing). It is the
 * single mechanic that makes save-boosting gear feel continuous instead of
 * binary, and a client that only knew `turns` could not tell a full-strength
 * 1-turn stun from a 3-turn one that was very nearly shrugged off. The Record
 * lane says it in words ("Slowed 1 turn, not 3"); this says it in numbers, so
 * the float over the token can be styled without parsing prose.
 *
 * IT IS NOT SENT WHEN THE SAVE NEGATES OUTRIGHT (Actor.lua:7034-7037) — no
 * effect landed, so there is no badge to pop and nothing to time. That refusal
 * is a Record line and nothing else.
 */
export type EffectAppliedEvent = {
  k: 'effect_applied';
  /** THE AFFLICTED, not the applier. See the note on `id` above. */
  id: string;
  /** Namespaced `effect:<id>`; the client resolves the badge from its manifest. */
  effectId: string;
  /** GAME TURNS that landed, after the partial save scaled them. */
  turns: number;
  /** GAME TURNS asked for, before the save. `turns < maximum` is a partial save. */
  maximum: number;
  /** Who applied it, when there is an actor to blame. */
  sourceId?: string;
};

/**
 * A STATUS FELL OFF. Expired, dispelled, or cured — the client draws the same
 * badge leaving in every case, so the reason is a Record line rather than a
 * field here.
 *
 * A separate event rather than an `effect_applied` with `turns: 0`, because the
 * two mean opposite things to a renderer and one of them must never animate a
 * badge INTO existence at zero turns.
 */
export type EffectExpiredEvent = {
  k: 'effect_expired';
  id: string;
  effectId: string;
};

/**
 * A DETECTIVE WENT DOWN (game-design.md § 9). NOT a death, and the distinction
 * is the whole mechanic.
 *
 * At 0 hp a player is *Unfiled*: prone, still able to talk in the log, and
 * revivable by any ally who reaches them for 4 AP.
 *
 * THEIR `ActorView` IS INDISTINGUISHABLE FROM A CORPSE'S — `alive: false`,
 * `hp: 0` — because the engine uses that flag to stop ticking them and to stop
 * them blocking the tile an ally has to step onto. THIS EVENT AND `PartyMsg` ARE
 * THE ONLY THINGS THAT SAY OTHERWISE, which is precisely why a client that
 * cannot read them draws a body nobody will run to, and why PROTOCOL_VERSION
 * had to move.
 *
 * `turns` is the countdown to Erased. Five (§ 9), on the wire rather than
 * assumed, because it is the number that decides whether anybody can get there
 * in time and it is the number the Bell suddenly starts to matter against.
 */
export type DownedEvent = {
  k: 'downed';
  /** The detective who went down. */
  id: string;
  /** GAME TURNS until Erased. */
  turns: number;
  /** Who put them there, when there is an actor to blame. */
  sourceId?: string;
};

/** SOMEBODY GOT THERE IN TIME. Back on their feet at a fraction of maximum hp. */
export type RevivedEvent = {
  k: 'revived';
  /** The detective who is standing up. */
  id: string;
  /** WHO reached them. The one event in the game that names a friend. */
  byId: string;
  /** Absolute, like every other vital on the wire — never a delta to apply. */
  hp: number;
  maxHp: number;
};

/**
 * Why a body was Erased. Two reasons, and they are two different evenings:
 * a timer running out is one person's mistake, a wipe is everybody's.
 */
export const ErasedReason = {
  /** The five-turn Downed timer expired with nobody in reach. */
  Timer: 'timer',
  /** Party wipe. MVP: the floor resets and the party restarts it (§ 9). */
  Wipe: 'wipe',
} as const;
export type ErasedReason = (typeof ErasedReason)[keyof typeof ErasedReason];

/**
 * ERASED — the Downed timer ran out, or the party wiped (game-design.md § 9).
 *
 * MVP HAS NO PERMADEATH AND NO LOSS: the floor resets and the party restarts it.
 * So this is not a `death` with a different name — a corpse stays on the map and
 * a death is final, whereas an erasure is followed by the floor being rebuilt
 * and a fresh `welcome`. The client must not delete the token here; the reset
 * that follows replaces the whole board.
 */
export type ErasedEvent = {
  k: 'erased';
  id: string;
  reason: ErasedReason;
};

export type TurnEvent =
  | MoveEvent
  | AttackEvent
  | DamageEvent
  | DeathEvent
  | TalentEvent
  | EffectAppliedEvent
  | EffectExpiredEvent
  | DownedEvent
  | RevivedEvent
  | ErasedEvent;

/** First frame after a successful `hello`. Full snapshot: level plus everyone. */
export type WelcomeMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'welcome';
  /** Which actor in `actors` is the recipient — the client centres on it. */
  selfId: string;
  /** Present this in the next `hello` to reattach after a drop. */
  resumeToken: string;
  level: LevelView;
  actors: ActorView[];
};

/**
 * A full actor list. The recovery path and the deliberately dumb one: when the
 * server is unsure what a client knows, it resends everything rather than
 * reasoning about deltas. At 30x30 with under ten players that is a few KB.
 */
export type StateMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'state';
  actors: ActorView[];
};

/** The common case: one actor is now at (x, y). Absolute, never a delta. */
export type MovedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'moved';
  id: string;
  x: number;
  y: number;
};

export type JoinedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'joined';
  actor: ActorView;
};

/**
 * An actor's body has been REMOVED from the world.
 *
 * M2 NARROWED THIS AND THE CHANGE MATTERS. In M1 a dropped socket removed the
 * actor and broadcast `left`. It no longer does: game-design.md § 4 says a
 * disconnect leaves the body standing where it fell (it is a MUD; you do not
 * yank someone out of a fight), puts them on Standing By, and holds the resume
 * token for a ten-minute grace. So a disconnect now shows up as a `turn` frame
 * with that id under `standingBy`, and `left` means only "the body is gone" —
 * the grace expired, or the player genuinely left.
 *
 * M4 ADDED THE SECOND SENDER, AND IT IS NOT A PLAYER: a REAPED MONSTER. A
 * corpse is removed from the world once its death has been narrated
 * (`ActorLife.lua:86-94`), and THIS FRAME IS HOW THE CLIENT IS TOLD — explicit
 * removal, stated, which is exactly the exception client/main.ts:1533-1542
 * carves out. That comment forbids inferring a death FROM ABSENCE (an actor
 * missing from a snapshot is usually an actor who walked out of view, and
 * deleting on absence makes every step through a doorway look like a death); it
 * does not forbid an explicit `left`. `death` keeps its body-stays semantics
 * verbatim — the two frames say different things and both are needed.
 */
export type LeftMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'left';
  id: string;
};

// ---------------------------------------------------------------------------
// M5 — THE TURN TRACKER. "WHO STILL OWES A DECISION", NOT "WHOSE GO IS IT"
// ---------------------------------------------------------------------------

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE DRAWING ANYTHING FROM `TurnMsg.actors`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS IS NOT AN INITIATIVE ORDER, AND IT MUST NEVER BE DRAWN AS ONE.
 *
 * Baldur's Gate 3 runs STRICT INITIATIVE: actors act one at a time in a fixed
 * order, and its portrait strip IS that order — you read it left to right to
 * learn who goes next and how long you have to wait.
 *
 * Inner Datum is PHASE-LOCKED (DECISIONS.md D1, PLAN.md § 6): a player action
 * always costs exactly one full turn of energy, so the WHOLE PARTY decides in
 * the same window, everything resolves, and then the monsters sweep as one
 * batch. There is no order among the players because there is no queue to be
 * in. Anyone in `actors` whose `state` is `waiting` can act RIGHT NOW.
 *
 * So a card strip built from this answers exactly one question — WHO HAS NOT
 * DECIDED YET — and the failure mode of getting it wrong is specific and bad: a
 * strip that reads as a running order makes three players sit and wait for
 * "their go" while the server is already waiting on all four. That is the
 * spinner D1 exists to prevent, arrived at through the UI instead of the engine.
 *
 * WHICH IS WHY THE ORDER IS JOIN ORDER AND IS STABLE ACROSS FRAMES. It carries
 * no information at all, on purpose: nothing in it can be mistaken for a queue,
 * and a card never moves under a cursor between two frames. The server sorts
 * this list; a client that re-sorts it (by state, by hp, by name) reintroduces
 * both problems at once.
 */

/**
 * WHAT ONE CARD STANDS FOR. Deliberately NOT `ActorKind`.
 *
 * `ActorKind` names what a BODY is. This names what a CARD is, and the two do
 * not agree about monsters: the hostile side gets exactly ONE card however many
 * husks are on the floor, because they resolve TOGETHER as a batched sweep
 * (`SweepMsg` — one frame for the whole monster turn, never one per monster).
 *
 * A ROW OF INDIVIDUAL MONSTER CARDS WOULD BE A LIE ABOUT THE RULES. It would
 * say eight creatures take eight separately-timed turns, which is the second
 * most common way co-op turn-based dies (game-design.md § 4) and is precisely
 * what the batched sweep exists to prevent. One card, one sweep.
 */
export const TurnActorKind = {
  /** One human. `id` is their actor id and joins to `ActorView`/`PartyMember`. */
  Player: 'player',
  /** THE WHOLE HOSTILE SIDE, aggregated. `id` is `MONSTERS_TURN_ID`. */
  Monsters: 'monsters',
} as const;
export type TurnActorKind = (typeof TurnActorKind)[keyof typeof TurnActorKind];

/**
 * WHAT ONE CARD SAYS. Five states, four of which already have art.
 *
 * `waiting` / `committed` / `bell` / `standing_by` are the four turn chips
 * (`ui_icon_turn_${state}` — the values ARE the art suffixes, exactly as
 * `TurnChip` in src/client/ui/turnbar.ts already spells them, so renaming a
 * member here renames a PNG). `acting` is the fifth and belongs to the monsters
 * card alone; it has no chip because it is not a state a player is ever in.
 *
 * SENT RATHER THAN DERIVED FROM THE THREE ID ARRAYS BELOW, and that is the
 * whole reason this field exists. The derivation is four ordered membership
 * tests over three arrays plus a null check on `bellMs`, and every renderer that
 * wants a card would have to carry its own copy of it — which is a second
 * implementation of the barrier's precedence rules living in the browser. The
 * server already knows the answer; it says it once.
 */
export const TurnActorState = {
  /**
   * OWES A DECISION AND HAS NOT MADE IT. The party is waiting on this one.
   *
   * On the monsters card it means the sweep is queued behind the party — the
   * hostile side has not moved yet this turn.
   */
  Waiting: 'waiting',
  /**
   * NOTHING IS BEING WAITED ON FROM THIS ACTOR. They said `commit` or `hold`,
   * or a standing order supplies their action.
   *
   * ALSO WHAT EVERY PLAYER READS OUT OF COMBAT, and that is not a fudge:
   * `engagement === 0` means nobody blocks and the barrier is waiting on
   * nobody, which is the same fact. `inCombat: false` is what tells the client
   * not to present the strip as a live tracker at all.
   */
  Committed: 'committed',
  /** Waiting AND the Bell is counting down on them. The last stragglers. */
  Bell: 'bell',
  /**
   * EXCLUDED FROM THE QUORUM: two consecutive auto-passes, a disconnected body,
   * or a detective on the floor. Still on the map, still gets hit, not waited
   * for. `downed` says which of those it is.
   */
  StandingBy: 'standing_by',
  /**
   * RESOLVING RIGHT NOW. The monsters card only: the party is done deciding and
   * the sweep is what happens next.
   *
   * Never a player's state. Player actions resolve the instant they arrive
   * (commit-on-submit, game-design.md § 4), so there is no window in which a
   * human is mid-action for a card to describe.
   */
  Acting: 'acting',
} as const;
export type TurnActorState = (typeof TurnActorState)[keyof typeof TurnActorState];

/**
 * The aggregate card's id. NAMESPACED SO IT CANNOT COLLIDE WITH A BODY.
 *
 * Every real actor id is `actor_u_<hex>`, an anonymous `p<n>` or a monster's
 * spawn id; none of them contains a colon. The client must NOT try to join this
 * id to an `ActorView` — there is no single body behind it, which is the point
 * of the card.
 */
export const MONSTERS_TURN_ID = 'side:monsters';

/**
 * ONE CARD ON THE TURN TRACKER, already decided by the server.
 *
 * WHY IT CARRIES ITS OWN name/hp/portrait INSTEAD OF JOINING TO `ActorView`,
 * when `PartyMember` deliberately does the opposite: the aggregate has no
 * `ActorView` to join to. Giving the players a shape and the hostile side a
 * different one would mean two card layouts and two code paths for one strip,
 * and the monsters card — the one that says "and then they all move" — would be
 * the one drawn by the less-tested path.
 *
 * The player rows are a redundant copy of hp/name, and the redundancy is bounded
 * on purpose: this frame goes out on every barrier change, which is when those
 * numbers change anyway, so the card cannot sit stale next to a fresher bar.
 */
export type TurnActor = {
  /** Actor id for a player; `MONSTERS_TURN_ID` for the aggregate. */
  id: string;
  /**
   * Already run through the display-name filter. Hostile input — `fillText` and
   * `textContent` only, never markup.
   *
   * The aggregate is named as a GROUP ("The Filed"), never as a creature: a card
   * reading "Index Husk" beside a party of four says one monster is taking a
   * turn, when what is about to happen is all of them at once.
   */
  name: string;
  kind: TurnActorKind;
  state: TurnActorState;
  /**
   * Current and maximum hit points. For the aggregate this is the SUM over the
   * living hostiles — how much fight is left in the other side, drawn as a group
   * bar and never as one creature's health.
   */
  hp: number;
  maxHp: number;
  /**
   * AN ASSET KEY, NEVER A PATH — the same contract as `ActorView.sprite` and
   * `EffectView.icon`, so recutting the art cannot invalidate a frame.
   *
   * A player's is their class icon (`icon_character_the_*`); the aggregate's is
   * the SPRITE of the most dangerous living hostile, which the client already
   * has because it is drawing that body on the map. Absent when there is no
   * honest picture to use — a card with a name and no face beats a card wearing
   * somebody else's.
   */
  portrait?: string;
  /**
   * WHICH CARD IS YOU. The reason `turn` is per-recipient rather than broadcast.
   *
   * A boolean rather than leaving the client to compare against its own
   * `selfId`, because the client already gets this wrong in one case that
   * matters: a spectating or bodiless socket has no self, and "no card is
   * highlighted" must be a fact the server states rather than a comparison that
   * happens to fail. False on the aggregate, always.
   */
  isSelf: boolean;
  /**
   * ON THE FLOOR (game-design.md § 9) — *Unfiled* or Erased, either way not
   * standing.
   *
   * Separate from `state` because they answer different questions: `state` says
   * what the barrier is doing about this actor (nothing — they are excluded from
   * the quorum), and this says WHY, which is the half that means *get to them*.
   * The countdown itself stays on `PartyMsg.downed`, which is the frame that
   * owns it; duplicating a ticking number here would put two of them on screen.
   */
  downed: boolean;
};

/**
 * WHOSE TURN IT IS. The single most important frame in a co-op turn-based game.
 *
 * Sent on every barrier change, not just when it becomes your turn: "a player
 * who does not know whether the game is waiting on them" is the documented way
 * this genre dies (game-design.md § 4), and the cure is that everyone can always
 * see the whole party's state, not just their own.
 *
 * PER-RECIPIENT SINCE v5. `actors[].isSelf` differs per socket, so this frame is
 * unicast through `sendTurn` and is a member of `ViewerMsg` — handing it to
 * `broadcast` does not compile. It holds no secret; what it holds is one flag
 * that is only true for one person, and a room-wide copy would mark the wrong
 * player's card as "you" in the one UI that exists to stop that confusion.
 *
 * THE THREE ID ARRAYS ARE THE v2 SURFACE AND THEY ARE KEPT AS THEY WERE. They
 * cannot express the tracker on their own, and it is worth naming why rather
 * than leaving the next reader to discover it:
 *
 *   `whoseTurn` holds only the actors that STILL OWE a decision (the barrier's
 *   blocking set), so `committed` — documented as "the subset of `whoseTurn`
 *   that has already committed" — is EMPTY BY CONSTRUCTION. The two cannot
 *   overlap. Redefining `whoseTurn` to mean the whole quorum would fix that and
 *   would silently invert `bannerFor`'s `whoseTurn.length - committed.length` in
 *   every client already deployed, which is a worse failure than the one it
 *   fixes because it looks like it works.
 *
 * So `actors` is the authoritative per-actor state and the arrays stay for
 * `isYourTurn` and the banner. New UI reads `actors`.
 */
export type TurnMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'turn';
  /** COMPLETED game turns, never ticks. Nine of ten ticks produce no traffic. */
  gameTurn: number;
  /**
   * TURNS OF COMBAT REMAINING. 0 MEANS FREE MOVEMENT.
   *
   * The level-wide engagement clock, straight off `world.turn.engagement`, and
   * the one fact that decides whether the barrier is armed at all: above zero
   * every player on the level owes a decision every turn — including one thirty
   * tiles away, or somebody walks fifty free tiles while a friend tanks — and at
   * zero nobody ever blocks and the pump idles.
   *
   * IT DECAYS RATHER THAN SNAPPING TO ZERO, a few turns after the last contact
   * (ToME's `checkStillInCombat`, Actor.lua:7648-7669), so it is also the number
   * behind "the floor has not lost you yet".
   *
   * THIS WAS THE MISSING FIELD, and its absence was a bug reported from real
   * play: nothing on the wire said whether combat was happening. A client could
   * only infer it from `whoseTurn` being non-empty, which gives it no TRANSITION
   * to announce and cannot tell "the fight just started" from "we are waiting on
   * one straggler". Both of those are the same frame under the old shape.
   */
  engagement: number;
  /**
   * `engagement > 0`, STATED RATHER THAN LEFT TO THE CLIENT TO DERIVE.
   *
   * It is one boolean to spell out a rule that would otherwise be copied into
   * the turn bar, the party panel, the map's token rings and the input layer.
   * Four copies of a rule is four chances to write `>=`, and two clients that
   * disagree about whether combat is on is a real bug class in a game where the
   * whole party is looking at the same fight. One authoritative flag is cheaper
   * than a shared rule, and it is the flag the combat-start announcement fires
   * on — the client watches it FLIP, which is a thing it cannot do with a number
   * it computed itself from a frame it was already holding.
   */
  inCombat: boolean;
  /**
   * THE TURN TRACKER: every card the strip draws, in STABLE JOIN ORDER.
   *
   * See the essay above `TurnActorKind` — this is not an initiative order and
   * must not be drawn as one, and a client must not re-sort it.
   *
   * Every player in the world appears, always, including the downed and the
   * disconnected: a card that vanishes when somebody falls over removes the
   * person the party most needs to see. The hostile side appears as ONE card
   * (`kind: 'monsters'`) and only while `inCombat` — out of combat there is
   * nothing hunting you, and a card for it would say the party is waiting on
   * something. It is always LAST, so its arrival and departure never shift a
   * player's card sideways.
   */
  actors: readonly TurnActor[];
  /**
   * THE QUORUM: everyone the barrier is parked on this turn, committed or not.
   * Empty out of combat, where nobody blocks and movement is free.
   */
  whoseTurn: readonly string[];
  /** The subset of `whoseTurn` that has already said `commit` or `hold`. */
  committed: readonly string[];
  /**
   * Excluded from the quorum entirely: two consecutive auto-passes, or a
   * disconnected body inside its reconnect grace. Their tokens are still on the
   * map and still get hit — they are just not being waited for.
   */
  standingBy: readonly string[];
  /**
   * MILLISECONDS LEFT ON THE BELL, or null when no Bell is running.
   *
   * Null is the normal state: there is NO timer at all until `committed`
   * reaches `whoseTurn.length - 1`. Only then does a countdown appear, and only
   * on the stragglers. Sent as remaining-time rather than a deadline timestamp
   * because the client's clock is not the server's, and a 300 ms skew on a
   * 12-second boss Bell is visible.
   */
  bellMs: number | null;
};

/**
 * THE MONSTER TURN, IN ONE FRAME.
 *
 * Every monster that acted between two player parks, batched. One message, not
 * one per monster: four players watching eight monsters each take an
 * individually-timed turn is the second-most-common way co-op turn-based dies
 * (game-design.md § 4). The SERVER never sleeps — it sends the batch the
 * instant the pump returns, and the CLIENT paces the playback (~80 ms/event,
 * capped ~2.2 s, skippable).
 *
 * `events` is in resolution order and must be played in it: a `death` after the
 * `damage` that caused it, a `move` before the `attack` it set up.
 */
export type SweepMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'sweep';
  gameTurn: number;
  events: readonly TurnEvent[];
};

/**
 * THE IMMEDIATE LANE: one thing a player just did, sent on its own.
 *
 * Player actions resolve the moment they arrive and must animate at once —
 * pacing your own attack through the sweep queue makes the game feel laggy on
 * exactly the input you care about. Monsters go in a `sweep`; players come
 * through here, plus `moved` for a step.
 *
 * Each one wraps the SAME payload the sweep carries, so a client needs exactly
 * one `applyEvent` function and cannot end up with two implementations of "an
 * actor took damage" that disagree.
 */
export type AttackedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'attacked';
  ev: AttackEvent;
};

export type DamagedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'damaged';
  ev: DamageEvent;
};

export type DiedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'died';
  ev: DeathEvent;
};

/**
 * A player used a talent. The immediate lane's fourth member.
 *
 * NAMED FOR THE VERB THE GAME ITSELF USES — the Record log's line is "Dalt uses
 * Ward Rush" (game-design.md § 11). The `move -> moved` convention would give
 * `talented`, which means something entirely different in English and would read
 * as a typo in every log line and every switch statement it appears in.
 */
export type UsedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'used';
  ev: TalentEvent;
};

// ---------------------------------------------------------------------------
// The viewer-private frames. See `BroadcastMsg` at the bottom.
// ---------------------------------------------------------------------------

/**
 * THE VIEWER'S OWN FOUR TALENTS. Sent once, with `welcome`.
 *
 * Once rather than per-turn because M3 loadouts are FIXED (PLAN.md § M3: twelve
 * talents, four per class, zero trees, zero talent points). When M6 brings
 * talent points this becomes a frame that can arrive again mid-session, and the
 * client already treats it as a wholesale replacement, so nothing changes here.
 *
 * `talents` is in HOTBAR ORDER and that order is the server's: slot 1 is
 * `talents[0]`. The client must not sort it. Muscle memory for which key is
 * Ward Rush is worth more than any ordering a renderer could impose, and a
 * client that sorted by cooldown would move the buttons around mid-fight.
 */
export type LoadoutMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'loadout';
  talents: readonly LoadoutTalent[];
};

/**
 * THE VIEWER'S OWN COOLDOWNS. Talent id -> GAME TURNS REMAINING.
 *
 * COMPLETE AND ABSOLUTE, never a delta and never a patch: this object is every
 * talent currently cooling down, so anything in `loadout` that is NOT named here
 * is READY. That mirrors the engine exactly — ToME deletes the entry at zero
 * (`talents_cd[tid] = nil`, ActorTalents.lua:1002-1013) rather than leaving a 0
 * — and it means a client that drops a frame is corrected by the next one
 * instead of holding a button grey forever.
 *
 * Turns, not milliseconds: the wipe is a fraction of `LoadoutTalent.cooldownTurns`
 * and it steps once per game turn, because that is when the value actually
 * changes. An animated sweep would be lying about a discrete number.
 */
export type CooldownsMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'cooldowns';
  cooldowns: Readonly<Record<string, number>>;
};

/** THE VIEWER'S OWN class resource. */
export type ResourceMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'resource';
  resource: ResourceView;
};

/**
 * THE ANSWER TO ONE `inspect`. Per-recipient by construction.
 *
 * ═══ `view: null` IS THE SINGLE ANSWER TO TWO DIFFERENT QUESTIONS ═══
 * "There is no actor with that id" and "there is, and you cannot see it" come
 * back identically, and the sameness is the security property rather than
 * laziness. inspect.ts's own rule (its FOG OF WAR APPLIES TO KNOWLEDGE header)
 * is that a redacted record still confirms something is there; the branch that
 * lives in the GATEWAY — id not found — leaks the same fact in the other
 * direction. A distinguishable "no such actor" turns this frame into an ORACLE:
 * a patched client walks the id space, sorts the two replies apart, and has
 * enumerated everybody on the floor without ever seeing one of them. One answer,
 * both branches, nothing to sort.
 *
 * That is also why there is no `not_visible` `ErrorCode`. A refusal code would
 * be the same oracle wearing a different hat, and adding an `ErrorCode` member
 * is one of the things src/shared/version.ts records as forcing a bump.
 *
 * ═══ IT CARRIES `targetId` BECAUSE THIS PROTOCOL HAS NO CORRELATION ID ═══
 * Nothing on this wire, in either direction, has ever carried a request id. So
 * the client cannot match an answer to its question by arrival order — a hover
 * that moves on before the reply lands would paint the previous target's card
 * over the current one. It matches BY TARGET: an `inspected` whose `targetId` is
 * not the thing currently under the pointer is discarded.
 */
export type InspectedMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'inspected';
  targetId: string;
  view: InspectView | null;
};

export type PongMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'pong';
};

/**
 * Never fatal to the socket. A rejected frame gets an `error` and the connection
 * stays open — dropping the socket on a bad message turns one typo into a
 * reconnect storm.
 */
export type ErrorMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'error';
  code: ErrorCode;
  message: string;
};

/**
 * Everything the server may say.
 *
 * Adding a member here BREAKS every `switch (msg.t)` in the client at lint time
 * — `switch-exhaustiveness-check` runs with `considerDefaultExhaustiveForUnions:
 * false`, so a `default:` clause does not let anyone off the hook. That is the
 * intended cost of extending this union: a new frame nobody handles is a frame
 * that silently does nothing.
 */
export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | MovedMsg
  | JoinedMsg
  | LeftMsg
  | TurnMsg
  | SweepMsg
  | AttackedMsg
  | DamagedMsg
  | DiedMsg
  | UsedMsg
  | LogMsg
  | EffectsMsg
  | ProjectilesMsg
  | PartyMsg
  | PartyStateMsg
  | PingedMsg
  | LoadoutMsg
  | CooldownsMsg
  | ResourceMsg
  | InspectedMsg
  | PongMsg
  | ErrorMsg;

/**
 * FRAMES THAT ARE TRUE FOR EXACTLY ONE VIEWER.
 *
 * A player's loadout, cooldowns and resource are theirs. Sending them to the
 * room is two separate faults at once:
 *
 *   A LEAK. Cooldowns are intent. "Mend Wounds is ready" and "Fog Step has four
 *   turns left" tell you what someone is holding for the boss and what they can
 *   no longer escape with — the same class of information as the pending intent
 *   and the AI's target, both of which `ActorView` already withholds. Talking
 *   about it in voice is the game; reading it off a HUD is not.
 *
 *   NOISE. Four hotbars' worth of frames that no renderer draws, on every pump.
 *
 * `turn` JOINED THIS SET AT v5 FOR NEITHER OF THOSE REASONS. It is not secret —
 * every card on the turn tracker is something the whole party is meant to see,
 * and it is still sent to everybody, one socket at a time. It is here because
 * `TurnActor.isSelf` is true for exactly one recipient, so a single frame handed
 * to the room would highlight the wrong player's card in the one UI whose entire
 * job is answering "is the game waiting on ME?". Membership of this union is
 * what makes `broadcast(turnMsg)` a build failure rather than a rule to
 * remember; the loop over sessions in `broadcastTurnIfChanged` is the correct
 * shape and always was.
 *
 * `party_state` JOINED AT v6 FOR BOTH REASONS AT ONCE, which is why it is the
 * clearest member of the set. `PartyStateMember.isSelf` is true for exactly one
 * recipient, exactly as `turn`'s is — and `PartyStateMsg.invites` is genuinely
 * private: an offer somebody has not answered yet is a decision they have not
 * made, and broadcasting the list would put every player's pending choices on
 * every other player's screen. There is no shape of this frame that is correct
 * for two people, so `broadcast(partyStateMsg)` must not compile.
 *
 * `inspected` JOINED FOR THE STRONGEST VERSION OF THE FIRST REASON. It is an
 * answer to a question ONE socket asked, and its content is FOV-gated on the
 * asker: `inspectActor` returns null for a target the VIEWER cannot see, so the
 * same target inspected by two people is legitimately two different frames — one
 * a full card, the other `view: null`. There is no correct shared form of it, and
 * handing the room a copy would post one player's card about a monster nobody
 * else can see, which is the tile-grid leak the whole FOV seam exists to stop.
 * So `broadcast(inspected)` must be a compile error, and membership here is what
 * makes it one.
 */
export type ViewerMsg =
  LoadoutMsg | CooldownsMsg | ResourceMsg | TurnMsg | PartyStateMsg | InspectedMsg;

/**
 * Everything the server may say TO EVERYONE.
 *
 * THIS TYPE IS THE ENFORCEMENT, not a comment about it. The gateway's
 * `broadcast` takes a `BroadcastMsg`, so `broadcast(cooldownsMsg)` does not
 * compile — the leak above is a build failure rather than a code-review note or
 * a rule someone has to remember at 1 a.m. while adding a fifth viewer frame.
 *
 * `Exclude` rather than a hand-written second list, so a new member of
 * `ServerMsg` lands in exactly one of the two sets and the two can never drift.
 */
export type BroadcastMsg = Exclude<ServerMsg, ViewerMsg>;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Result of `parseClientMsg`. Discriminated so `ok` narrows `msg` vs `error`. */
export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; error: string };

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const where = issue.path.map((part) => String(part)).join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate one inbound frame. NEVER THROWS — that is the point of it.
 *
 * Accepts the raw frame TEXT (JSON.parse happens in here, inside the try) or an
 * already-parsed value. The server receives binary frames, so call it as
 * `parseClientMsg(frame.toString('utf8'))` — decoding is a host concern and
 * src/shared/ has no Buffer.
 *
 * Parsing belongs on this side of the boundary because an exception escaping a
 * WebSocket `message` handler is an uncaught exception, and an uncaught
 * exception kills the Node PROCESS, not the connection. A malformed frame must
 * cost one `error` reply, not the session for everyone in the voice channel.
 *
 * The version check runs before schema validation so a client from a previous
 * deploy gets 'protocol version mismatch' rather than an inscrutable complaint
 * about a literal.
 */
export function parseClientMsg(raw: unknown): ParseResult {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'frame is not valid JSON' };
    }
  }

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, error: 'frame is not a JSON object' };
  }

  if ('v' in candidate) {
    const version: unknown = candidate.v;
    if (typeof version === 'number' && version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        error: `protocol version mismatch: frame v=${version}, server v=${PROTOCOL_VERSION}`,
      };
    }
  }

  // Checked before zod so the commonest server-side mistake — handing this the
  // raw binary frame instead of its text — reports something a human can act on
  // rather than a union-of-three type error.
  if (!('t' in candidate) || typeof candidate.t !== 'string') {
    return { ok: false, error: 'frame has no message type (t)' };
  }

  const parsed = ClientMsg.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, msg: parsed.data };
  }
  return { ok: false, error: describeIssues(parsed.error.issues) };
}
