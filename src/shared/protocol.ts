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
 *
 * v8 ADDS THE CHOOSER, AND THE BUMP IS FORCED BY A WRITE RATHER THAN A READ.
 *
 *   C -> S  `choose_class`  — "I will be the Watchman." Once, at first join.
 *   S -> C  `class_options` — the three classes, to the one player who owes a
 *                             choice. Per-recipient.
 *
 * `InspectView` also grew `className`, for the character sheet's header. Neither
 * half would force a bump on its own by this file's usual rule — an inbound verb
 * an old client never sends costs it nothing (`respawn` added one at v5 without
 * a bump) and an optional outbound field is an addition it can ignore. What
 * forces it is that the FALLBACK IS A WRITE: a client that cannot draw the
 * picker is assigned a class by rotation and the join save persists it, after
 * which the chooser never appears again. src/shared/version.ts is the long
 * version.
 *
 * v9 ADDS LEVELS, AND THE BUMP IS FORCED BY A FIELD THAT STOPPED BEING A
 * CONSTANT.
 *
 *   C -> S  `spend_point` — "put my next point into this talent."
 *   S -> C  `progress`    — the viewer's level, xp into it, and points in hand.
 *
 * `LoadoutTalent` also grew `level`, `maxLevel`, `desc` and `descNext`, and
 * `loadout` became a frame that arrives again mid-session rather than only at
 * `welcome`. None of that forces a bump on its own — an inbound verb an old
 * client never sends costs it nothing, an outbound frame it cannot name is one
 * it ignores, and `LoadoutMsg` was always specified as a wholesale replacement.
 * What forces it is that `LoadoutTalent.range` NARROWED from a class constant to
 * a per-actor value: Fog Step's only number is its range and it now scales with
 * the talent's level, so a v8 client draws a three-tile ring around a talent
 * that reaches six and refuses the tiles the player paid for. src/shared/
 * version.ts is the long version, including the two shapes deliberately avoided
 * (no new `TurnEvent` variant, no new `ErrorCode`).
 *
 * v10 ADDS LOOT, AND THE BUMP IS FORCED BY A FRAME AN OLD CLIENT CANNOT NAME.
 *
 *   C -> S  `pickup`  — "take the thing I am standing on." NO ARGUMENTS AT ALL.
 *           `equip`   — "put this on."   `unequip` — "take this off."
 *           `drop`    — "leave this here."
 *   S -> C  `ground`    — every item lying on the floor. BROADCAST, because a
 *                         tile is world state and the pile is unowned.
 *           `inventory` — what YOU are carrying, what you are wearing, and the
 *                         server's own comparison of the two. Per-recipient.
 *
 * THE FOUR VERBS NAME THE OBJECT AND NEVER THE SUBJECT, which is the rule at the
 * top of this file rather than a new one. `equip`, `unequip` and `drop` name an
 * item or a slot — a thing, not a person — and the server requires that thing to
 * be in THAT sender's own inventory, so a cross-inventory lookup table never
 * exists to be abused. `pickup` goes further and carries NOTHING: the server
 * reads the sender's own live x/y and takes the first item on that tile, which is
 * strictly stronger than range-checking a coordinate the client supplied, because
 * there is no coordinate to forge.
 *
 * THE COMPARISON ROWS ARE COMPUTED SERVER-SIDE AND THAT IS NOT NEGOTIABLE.
 * ToME's item description is COMPARATIVE: tome/dialogs/ShowEquipInven.lua:54
 * passes `self.equip_actor:getInven(item.object:wornInven())` — THE DESTINATION
 * INVENTORY, i.e. whatever is already in that slot — as the second argument of
 * `getDesc`, which is named `compare_with` at tome/class/Object.lua:2074 and
 * forwarded at :2120 into `getTextualDesc` (:1157). What comes out is a list of
 * LABEL-PLUS-SIGNED-NUMBER rows built by `compare_fields`, e.g.
 * `compare_fields(w, compare_with, field, "combat_armor", "%+d", "Armour: ")`
 * (:1285-1287, which does armour, hardiness and defence in three lines) — a
 * label and a formatted value, which is exactly `InspectRow`.
 *
 * So the comparison has to arrive ALREADY FORMATTED. eslint's
 * `NO_COMBAT_MATH_PATTERNS` blocks src/client/** from importing shared/checkhit,
 * shared/scale and shared/energy at all, and src/client/ui/tooltip.ts:6-16
 * states the rule this follows: a client that subtracted two armour numbers to
 * draw "+4 Armour" would be exactly the second copy of a combat formula that
 * file exists to prevent — and it would be wrong the first time, because
 * `rescaleCombatStats` floors and a raw +3 Strength is not +3 of anything a
 * player can see.
 *
 * A v9 CLIENT CANNOT NAME `ground`, SO IT DRAWS NO FLOOR ITEM AND HAS NO VERB TO
 * TAKE ONE — the permanently-stuck shape src/shared/version.ts used at 5 -> 6,
 * and the same argument it used at 6 -> 7 for the orb. That is the long version;
 * it also records the independent narrowing, which is that gear moves the
 * character sheet and `ActorView.maxHp` and `InspectView.rows` therefore stop
 * being facts about a CLASS.
 */

import { z } from 'zod';

import { DIR_ORDER } from './coords.ts';
import { PROTOCOL_VERSION, ZOOM_MAX, ZOOM_MIN } from './version.ts';

// ---------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------

/**
 * Tile codes as they travel on the wire and sit in a save file.
 *
 * ART SEAM: the client renders any code it has no sprite for as a flat palette
 * colour, which is how FLOOR and WALL have always drawn. The mapping
 * code -> sprite lives in the renderer; this union is the vocabulary.
 *
 * NEVER REPURPOSE A NUMBER. An old save would silently become a different
 * dungeon. Codes are append-only; 0 and 1 are frozen from M1.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO INDEPENDENT FACTS PER TILE, AND THEY ARE NOT THE SAME FACT
 * ═══════════════════════════════════════════════════════════════════════════
 * Until the overworld there were two codes and one predicate, so "solid" and
 * "opaque" were the same bit and nothing noticed. A canal is what separates
 * them: you cannot walk across it and you can see straight over it. ToME has
 * carried `block_move` and `block_sight` as separate terrain fields since
 * forever (`data/general/grids/*.lua`), and this is that split, arriving at the
 * first moment the game has a tile that needs it.
 *
 * Both predicates are FAIL-CLOSED on an unknown code, and they fail closed in
 * opposite directions on purpose — see each one.
 */
export const TileCode = {
  // ─── frozen from M1 ───
  FLOOR: 0,
  WALL: 1,
  // ─── Alderbrook, the overworld (v11) ───
  // Ground. Walkable, transparent.
  COBBLE: 2,
  PAVING: 3,
  GREEN: 4,
  MIRE: 5,
  SOOT: 6,
  RAIL: 7,
  BRIDGE: 8,
  // Blocks. Solid and opaque.
  TERRACE: 9,
  CIVIC: 10,
  WORKS: 11,
  TREES: 12,
  /** The Index has eaten this cell. The map border, and the premise. */
  ERASED: 13,
  /**
   * Canal water. THE REASON THIS ENUM HAS TWO PREDICATES: solid to a body,
   * transparent to an eye.
   */
  WATER: 14,
  // ─── the wilderness, v12. The overworld is the REGION around Alderbrook now,
  // and the city is a settlement on it. See shared/level.ts's ALDERBROOK_ROWS.
  /** Open grassland. The default ground of the whole region. */
  PLAINS: 15,
  /** Low rolling hills. Walkable, and higher than the plains. */
  HILLS: 16,
  /** Scrub and poor soil, between cultivated land and true wilderness. */
  HEATH: 17,
  /**
   * Bare rock. THE CLASSIC OVERWORLD BARRIER, and blocking is the whole point:
   * ToME's world map does the same (`grids.lua`, FOREST/mountain
   * `does_block_move = true`), and so does FF7's. The light ground threading
   * between dark masses IS the map — a mountain you could walk over would
   * delete every route decision the geography makes.
   */
  MOUNTAIN: 18,
  /** Broken rock and scree. Lets a range have an edge that is not a hard line. */
  CRAG: 19,
  /** Open sea. Darker than WATER, which is what makes a shoreline legible. */
  DEEPWATER: 20,
  /**
   * The beach. Walkable, and the transition that makes a coast read as a coast
   * rather than as land abutting a blue shape.
   */
  SHORE: 21,
  // ─── settlements at world-map scale, v14 ───
  // TERRACE and CIVIC stay exactly what they were: a street seen from inside a
  // town. These are the same buildings seen from four screens away, and the
  // difference between the two is the whole reason they are separate codes.
  /** A hamlet's roofs — a few small ones with gaps between. */
  VILLAGE_ROOF: 22,
  /** A working town's roofs — packed, chimneys. */
  TOWN_ROOF: 23,
  /** Civic stone, lead roofs, a cupola. Somewhere important. */
  CITY_ROOF: 24,
  /** A town wall or palisade. Ties a cluster into one silhouette. */
  TOWN_WALL: 25,
  /** Trodden ground between the roofs. Walkable. */
  YARD: 26,
  /** Ploughed strips around a settlement. Walkable. ToME's CULTIVATION. */
  FIELD: 27,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COLD NORTH AND THE BURNT SCAR — COUNTRY THE MAP ALREADY HAD.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The redesign's own cell table authors 1,107 cells of terrain this build had
   * no code for: 425 `frozen_water`, 257 `cold_forest`, 234 `charred` and 191
   * `snowfield`. The compatibility import resolved every one of them to the
   * nearest thing that already existed — frozen sea drew as canal, a snowfield
   * as plains, a burnt scar as heath — so a frozen north and a charred wound in
   * the Sedge were on the map and invisible.
   *
   * WALKABILITY IS UNCHANGED BY DESIGN, and that is what makes this safe: each
   * code below is walkable exactly where its fallback was, so no route opens, no
   * route closes, and nothing that pathfinds notices. Measured from the handoff:
   * charred→HEATH and snowfield→PLAINS are walkable, cold_forest→TREES and
   * frozen_water→WATER are not. This is the map being drawn as it was authored,
   * not the map changing.
   *
   * `cold_mountain` gets NO code: the handoff draws it with the same Daikara art
   * as an ordinary mountain, so a second code would be a distinction with no
   * picture behind it.
   */
  SNOWFIELD: 28,
  CHARRED: 29,
  COLD_FOREST: 30,
  /**
   * SOLID AND TRANSPARENT, like the canal it used to draw as. See `blocksSight`:
   * a code in neither set falls to the closed default, so adding this one
   * without saying so would put a sight-blocking wall across the frozen sea and
   * change every FOV in the north.
   */
  FROZEN_WATER: 31,
} as const;
export type TileCode = (typeof TileCode)[keyof typeof TileCode];

/**
 * Every code that can be stepped on. A Set rather than a comparison chain so
 * adding a code is one line in one place and cannot drift from `BLOCKS_SIGHT`.
 */
const WALKABLE: ReadonlySet<number> = new Set<number>([
  TileCode.FLOOR,
  TileCode.COBBLE,
  TileCode.PAVING,
  TileCode.GREEN,
  TileCode.MIRE,
  TileCode.SOOT,
  TileCode.RAIL,
  TileCode.BRIDGE,
  TileCode.PLAINS,
  TileCode.HILLS,
  TileCode.HEATH,
  TileCode.SHORE,
  TileCode.YARD,
  TileCode.FIELD,
  // The north and the scar. Walkable exactly where their fallbacks were —
  // `snowfield` drew as PLAINS and `charred` as HEATH.
  TileCode.SNOWFIELD,
  TileCode.CHARRED,
]);

/**
 * SOLID, AND YET YOU CAN SEE ACROSS IT. The one family that is in neither set:
 * open water, and now the frozen sea it becomes in the north. Named as a set
 * rather than a chain of `||` in `blocksSight`, because a hand-written list in
 * one function and a closed set in another is the shape this file has already
 * been bitten by — the code that was added and forgotten drew the open sea as
 * rock for a whole release.
 */
const SOLID_BUT_CLEAR: ReadonlySet<number> = new Set<number>([
  TileCode.WATER,
  TileCode.DEEPWATER,
  TileCode.FROZEN_WATER,
]);

/**
 * Every code an eye cannot see through. `WATER` is deliberately absent: it is
 * the one tile that is in neither set's complement — solid, and transparent.
 */
const BLOCKS_SIGHT: ReadonlySet<number> = new Set<number>([
  TileCode.WALL,
  TileCode.TERRACE,
  TileCode.CIVIC,
  TileCode.WORKS,
  TileCode.TREES,
  TileCode.ERASED,
  TileCode.MOUNTAIN,
  TileCode.CRAG,
  TileCode.VILLAGE_ROOF,
  TileCode.TOWN_ROOF,
  TileCode.CITY_ROOF,
  TileCode.TOWN_WALL,
  // A cold forest is still a forest.
  TileCode.COLD_FOREST,
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE DANGER MAY STAND — and therefore, by its absence, where it may not.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The wild ground: grass, heath, high ground, the marsh, the soot and the rail
 * bed. What is NOT here is the promise — the road, the paving, a settlement's
 * yard, the fields, the bridges and the strand — and `roamers.ts` states why
 * that promise matters: *"the road and a settlement's approach are SAFE, and
 * that is a promise a player learns to rely on."*
 *
 * ═══ IT LIVES HERE BECAUSE TWO SIDES NEED THE SAME ANSWER ═══
 * The server enforces it (a roamer may not be placed off this set) and the
 * client DRAWS it (the world map picks the safe network out in road colour). A
 * `client -> server` import is banned and correctly so, so the two would
 * otherwise have been two lists — and the day they disagreed, the map would
 * have been promising safety on ground that a roamer was standing on. A promise
 * a player learns to rely on is the worst possible thing to keep two copies of.
 *
 * FAIL-CLOSED THE OTHER WAY from `isWalkable`: an unrecognised code is
 * dangerous, because drawing unknown ground as safe road is the failure that
 * gets somebody killed.
 */
const HAUNTS: ReadonlySet<number> = new Set<number>([
  TileCode.PLAINS,
  TileCode.HEATH,
  TileCode.HILLS,
  TileCode.GREEN,
  TileCode.MIRE,
  TileCode.SOOT,
  TileCode.RAIL,
  /**
   * THE NORTH AND THE SCAR ARE WILD COUNTRY, and they were before they had
   * codes of their own — a snowfield drew as PLAINS and a charred scar as
   * HEATH, both of which are on this list.
   *
   * Leaving them off silently promoted 406 cells to the SAFE NETWORK: the
   * client would have picked the frozen north out in road colour and told the
   * player nothing waits there, while the server would have agreed and stopped
   * placing roamers on it. Caught by the roamer cap dropping 15 -> 14 and by
   * `ground.test.ts` finding 406 fewer cells to stand on, which is the second
   * time this file's fail-closed note has earned itself.
   */
  TileCode.SNOWFIELD,
  TileCode.CHARRED,
]);

export function isHaunt(code: number): boolean {
  return HAUNTS.has(code);
}

/**
 * Walkable ground that nothing may lie in wait on. THE SAFE NETWORK, as one
 * expression, so the map and the rule cannot drift apart.
 */
export function isSafeGround(code: number): boolean {
  return isWalkable(code) && !isHaunt(code);
}

/**
 * Takes a plain number because `LevelView.tiles` is `number[]` on the wire and
 * the alternative is a cast at every call site.
 *
 * FAIL-CLOSED: anything unrecognised is NOT walkable. An unknown code means a
 * client is older than the map it was sent, and walking into unknown terrain is
 * the worse failure — you would walk through a wall this build cannot draw.
 */
export function isWalkable(code: number): boolean {
  return WALKABLE.has(code);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS A CODE THIS BUILD KNOWS AT ALL — DERIVED, NEVER LISTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tileAt` has to answer this before it can pass a code through, and it used to
 * answer it by hand: `isWalkable(raw) || blocksSight(raw) || raw === WATER`.
 *
 * That reads as complete and is not. The two sets between them cover everything
 * EXCEPT a tile that is unwalkable AND transparent — which is exactly the water
 * family, which is why `WATER` is bolted on the end. **`DEEPWATER` is the same
 * shape and was added later, and the clause never learned it**, so all 716 of
 * its cells came out of `tileAt` as `WALL`: the open sea drew as rock, and
 * `blocksSightAt` said an eye cannot cross it while `blocksSight` — three lines
 * below, correctly updated — says it can.
 *
 * BUILT FROM `TileCode` ITSELF so the question cannot be got wrong again. A code
 * that exists is a code this build knows; there is no list to forget to update,
 * and the next tile that is solid and see-through works on the day it is added.
 *
 * The fail-closed default it guards is unchanged: a number that is not a
 * `TileCode` at all — a corrupt frame, a map from a newer build — is still
 * collapsed to `WALL` by the caller.
 */
const KNOWN: ReadonlySet<number> = new Set<number>(Object.values(TileCode));

export function isKnownTile(code: number): boolean {
  return KNOWN.has(code);
}

/**
 * FAIL-CLOSED IN THE OTHER DIRECTION, and the asymmetry is the point.
 *
 * An unrecognised code blocks sight. Both defaults resolve the same way — the
 * player is told LESS than the truth rather than more — because the failure
 * that matters is a client seeing through terrain it does not understand, which
 * is an information leak the server cannot take back. Refusing to walk is
 * visible and harmless; seeing an ambush through an unknown wall is neither.
 */
export function blocksSight(code: number): boolean {
  if (BLOCKS_SIGHT.has(code)) return true;
  // Walkable ground and the canal are the two transparent families. Spelled out
  // rather than derived so an added code that belongs in neither set lands on
  // the closed default below instead of quietly becoming see-through.
  if (WALKABLE.has(code) || SOLID_BUT_CLEAR.has(code)) return false;
  return true;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE QUESTIONS A TOWNSFOLK CAN BE ASKED. WIRE VOCABULARY, SO IT LIVES HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It began in `content/townsfolk.ts` beside the answers, which is where the
 * CONTENT belongs — and the client cannot import a server module (the
 * dependency rule is one-way and eslint enforces it), so the closed set moved
 * to `shared/` and the answers stayed put. That split is the right one anyway:
 * the ids are a contract between two processes; what Merrow says is not.
 *
 * The closed set of questions. On the wire, so it is a vocabulary rather than a
 * string a client makes up.
 */
export const TopicId = {
  /** "Where should we go?" — routed through the danger grades she can see. */
  Where: 'where',
  /** "Is it worth partying up?" — see `TownsfolkSpec.topics`. */
  Party: 'party',
  /**
   * "Is the road safe?" — AND IT IS, WHICH NOTHING HAS EVER SAID OUT LOUD.
   *
   * `isSafeGround` is enforced by the server (a roamer may not stand on made
   * ground) and drawn by the world map in road colour. Both of those are the
   * rule being TRUE; neither is the rule being TOLD. A player who has not
   * noticed the colour has no way to learn it except by surviving long enough
   * to infer it, and a promise you have to infer is not one you travel on.
   */
  Roads: 'roads',
  /**
   * "Is there anything out there?" — the only hint that `SiteDef.hidden` exists.
   *
   * Three sites are off the map until you stand near them, and a secret nobody
   * suspects is not a secret, it is content nobody finds. This is the sentence
   * that makes somebody walk into the trees on purpose.
   */
  Rumour: 'rumour',
} as const;
export type TopicId = (typeof TopicId)[keyof typeof TopicId];

/** What the menu row says, per topic. Short: it is a row, not a sentence. */
export const TOPIC_LABEL: Readonly<Record<TopicId, string>> = {
  [TopicId.Where]: 'Ask where to go',
  [TopicId.Party]: 'Ask about parties',
  [TopicId.Roads]: 'Ask about the roads',
  [TopicId.Rumour]: 'Ask what is out there',
};

export type ActorView = {
  id: string;
  name: string;
  sprite: string;
  x: number;
  y: number;
  kind: ActorKind;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH SIDE — and without it a shopkeeper is drawn as something to kill.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `kind` cannot answer this. A townsfolk is a `Monster` on the server for a
   * deliberate reason (`engine/actor.ts#Faction`: she is a body on a tile, drawn
   * by the same painter and seen by the same FOV, and only who may hit her
   * differs) — so a client reading `kind` alone puts a hostile ring under her,
   * offers `Attack` on right-click, and lets a travel path end in a swing.
   *
   * ABSENT MEANS HOSTILE-AS-BEFORE, not "unknown". Every monster in the roster
   * is `Redacted` and the field is omitted for them, so a client that ignores
   * this behaves exactly as it always has — which is why adding it forces no
   * version bump.
   *
   * `'townsfolk'` is the only value a client ever needs to branch on. The string
   * is the server's `Faction` value verbatim so there is nothing to translate.
   */
  faction?: string;
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
  /**
   * THE CLASS, AS AN IDENTITY — "The Watchman". PRESENT ONLY WHEN THE VIEWER IS
   * INSPECTING THEMSELVES.
   *
   * A FIELD RATHER THAN A ROW, and the distinction is the whole reason it is
   * here. `rows` is an ORDERED, DROPPABLE list: a narrow viewport is explicitly
   * allowed to drop rows it has no space for (see `InspectRow`), and the order
   * is the server's to change. A character sheet whose HEADER had to find the
   * class by scanning `rows` for the label 'Class' would break the moment a row
   * was reordered, relabelled or dropped — and it would break by silently
   * drawing a nameless detective, which is exactly the confidently-wrong shape
   * this protocol refuses. A class is an identity, like `name`, so it sits
   * beside `name`.
   *
   * OPTIONAL BECAUSE MOST INSPECTS HAVE NO HONEST ANSWER. A monster has no
   * class; another player's is not the viewer's to read off a hover card (see
   * inspect.ts's three-way split); and an old client that has never heard of the
   * field ignores it. Absent is the normal case, and it means "do not draw a
   * class line", never "unknown".
   */
  readonly className?: string;
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
  /**
   * Maximum EUCLIDEAN distance in tiles. 0 for a `self` shape.
   *
   * ═══ PER-ACTOR FROM v9. IT IS NO LONGER A CONSTANT OF THE CLASS ═══
   * Until v8 this was `talent.targeting.range` — one authored number, the same
   * on every Inspector's wire, safe to read once at `welcome` and cache for the
   * session. It is now `effectiveTalentRange(targeting, talentLevel)`, computed
   * per actor from the level below, and Fog Step is why: its ONLY number is its
   * range, and it scales 3/4/5/6/7 across its five ranks on its own cited
   * upstream curve (`combatTalentLimit(t, 10, 3, 7)`, mobility.lua:40-62). Two
   * detectives of the same class legitimately receive different values here.
   *
   * THAT NARROWING IS WHAT FORCED PROTOCOL_VERSION 9. A client holding the old
   * reading draws a ring three tiles wide around a talent the server will let it
   * step six, so the points a player spent do visibly nothing — the ring is a
   * convenience and never a gate, and this is the ring being convenient in the
   * wrong direction. It is also why a `loadout` frame must be re-sent whenever a
   * point is spent: this field is now stale the moment a rank changes.
   */
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH TREE IT SITS IN, AND WHAT PRESSING IT DOES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME groups talents into TYPES and the panel draws them under their type's
   * name; this game shipped one flat list per class, which PLAN.md § 5 records
   * as *0 trees* against a v1.0 ceiling of eight. `treeName` is the heading a
   * player reads and `tree` is the id the panel groups on — both, because the
   * client may not import the server's content table to look one up from the
   * other.
   *
   * `kind` is `activated`/`sustained`/`passive` in ToME's words. Everything
   * shipped so far is active; the field exists so the panel and the hotbar can
   * be built once for all three rather than rewritten when the first passive
   * lands — a passive with a keybind is a key that does nothing.
   *
   * ALL THREE OPTIONAL AND ADDITIVE, so no protocol bump: an older client
   * ignores fields it cannot name and draws the flat list it always drew.
   */
  tree?: string;
  treeName?: string;
  kind?: string;
  /**
   * THE CATEGORY'S MASTERY — the "(x1.30)" in a ToME category header.
   *
   * Sent because the client cannot compute it: masteries live in the server's
   * content table, and the header is the one place a player learns that a point
   * spent here is worth more than a point spent there. `ActorTalents.lua:834`
   * is what makes that true rather than flavour.
   *
   * Optional and additive. Absent reads as 1.0, which is what a category with no
   * opinion means — and it is what every tree ships at today.
   */
  mastery?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IS THIS STANCE UP? Only ever present on a SUSTAINED talent.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A sustain is the one talent whose state a player must READ before pressing:
   * an active is ready or on cooldown and the pip says which, a passive is never
   * pressed at all, and a stance is a toggle whose two meanings are opposite.
   * Without this the same key would sometimes put a stance up and sometimes take
   * it down, with nothing on screen to say which was about to happen.
   *
   * ABSENT ON EVERYTHING ELSE rather than `false` — `false` on an active would
   * be a claim that it could be sustained and is not.
   *
   * OPTIONAL, so adding it forces no version bump and a client that has never
   * heard of stances ignores it.
   */
  sustained?: boolean;
  /**
   * THE TALENT'S RAW LEVEL. 1 through `maxLevel`, and NEVER 0 — a talent on the
   * hotbar is one this detective has already learned.
   *
   * ═══ RAW, NOT EFFECTIVE, AND THE DISTINCTION IS ToME'S ═══
   * Upstream separates `getTalentLevelRaw` (points actually spent) from
   * `getTalentLevel` (raw plus every bonus gear and effects contribute), and the
   * number LevelupDialog puts under the icon is the raw one —
   * `local traw = self.actor:getTalentLevelRaw(t.id)`, LevelupDialog.lua:952.
   * It has to be: the panel spends POINTS, and a screen showing an effective 5
   * on a talent with two points in it would offer to sell a rank that is already
   * there. `desc` below is rendered from the level that actually applies; this
   * field is the one the `n/max` under the icon counts.
   */
  level: number;
  /**
   * THE CAP — `TALENT_MAX_LEVEL` in src/shared/progression.ts, which is ToME's
   * own `t.points` (ActorTalents.lua:71).
   *
   * ON THE WIRE RATHER THAN ASSUMED, for exactly the reason `radius` is: a
   * client must never hold a second copy of an authored number. A renderer that
   * hard-coded 5 to draw "3/5" would keep drawing "3/5" the day the cap moves,
   * on the one screen whose whole job is telling a player how much room a talent
   * has left — and it would keep drawing a `+` on a talent that had run out.
   */
  maxLevel: number;
  /**
   * WHAT THIS TALENT DOES AT `level`, AS A SENTENCE, RENDERED SERVER-SIDE.
   *
   * ═══ A STRING, NOT A BAG OF NUMBERS, AND NOT NEGOTIABLE ═══
   * eslint's `NO_COMBAT_MATH_PATTERNS` blocks src/client/** from importing
   * src/shared/scale.ts and src/shared/checkhit.ts AT ALL, so the browser cannot
   * evaluate `combatTalentScale(level, low, high)` even if somebody wanted it
   * to. `toLoadoutView`'s own docblock (src/server/content/classes.ts) already
   * states the rule this follows: every displayed number is computed
   * server-side, because a second copy of a formula in the browser always
   * diverges and the divergence shows up as a monster that was already dead.
   * Shipping the curve's endpoints instead and interpolating here would be that
   * second copy wearing a hat.
   */
  desc: string;
  /**
   * THE SAME SENTENCE AT `level + 1`. NULL at the cap, where there is no next.
   *
   * ═══ THIS PAIR IS THE CURRENT -> NEXT DIFF, AND IT IS THE POINT OF THE PANEL
   * ═══
   * Ported in spirit from LevelupDialog.lua:963-970, the branch taken when a
   * talent is learned and below its cap:
   *
   *     text:add({"font","bold"}, "Current talent level: ", tostring(traw),
   *              " [-> ", tostring(traw + 1), "]", {"font","normal"})
   *     text:merge(self.actor:getTalentFullDescription(t, 1)
   *                :diffWith(self.actor:getTalentFullDescription(t), diff))
   *
   * ToME renders the description TWICE — once at the current level, once with
   * `+1` — and shows the two side by side, green for the value you have and
   * yellow-green for the value one point buys. The at-cap branch immediately
   * below it (:971-975) renders the current description ALONE, which is exactly
   * what `null` means here.
   *
   * WITHOUT THIS PAIR A TALENT LEVEL IS A LIE. A panel that shows "3/5" and a
   * `+` button, with no statement of what the fourth point changes, asks a
   * player to spend a scarce resource on a promise. Eleven points against
   * sixteen upgrade steps means roughly five go unbought and the choice is the
   * whole screen; a choice made blind is not a choice.
   *
   * NULL RATHER THAN AN EMPTY STRING OR AN OMITTED KEY: absent and "" would be
   * two spellings of the same thing, and "" is the one that renders as a blank
   * row where the diff should be. `null` is a fact the renderer must handle.
   */
  descNext: string | null;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHETHER THE NEXT POINT MAY BE SPENT HERE AT ALL, AND WHY NOT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `level < maxLevel` used to be the whole of what the panel knew, and it was
   * the whole of what there WAS to know: no talent in the game declared a tier
   * or a stat gate, so `checkTier` said yes to every purchase.
   *
   * All 42 declare one now. Without this field the panel would draw a live
   * `+` on a talent the server is about to refuse — a button that does nothing,
   * with no sentence, on the one screen whose whole job is telling a player
   * what a point buys. That is worse than no gate at all: a refusal a player
   * cannot see is indistinguishable from the game being broken.
   *
   * ═══ COMPUTED SERVER-SIDE, LIKE EVERY OTHER NUMBER ON THIS TYPE ═══
   * `checkTier` is in src/shared/ precisely so the client COULD run it — its
   * own docblock says so. It is still rendered here, because doing it in the
   * browser would need the character's stats, level and per-tree known-count
   * shipped alongside, which is three more things to keep in step for a string
   * the server already has in hand. One answer, one place.
   *
   * OPTIONAL, so this forces no version bump: a client that has never heard of
   * tiers reads `undefined`, draws the `+` it always drew, and gets the
   * server's refusal — which is exactly the behaviour it has today.
   */
  locked?: boolean;
  /**
   * THE SENTENCE — `tierRefusalText`, so the panel and the refusal agree word
   * for word. Absent when nothing is blocking the next point, which is the
   * common case and keeps the frame small.
   */
  lockedReason?: string;
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
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ACTING BUDGET — and for four milestones no frame carried it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `DECISIONS.md` D1 is **Accepted** and its table reads *"Intra-turn budget:
   * 6 AP / 3 MP, spendable across several talents in one park"*. Every one of
   * the twelve talents is priced against it — Ward Rush at 2 is called "the
   * cheapest engage in the game" and `ward_rush.ts` derives its own cooldown
   * from *"an Inner Datum turn holds ~2 actions from a 6 AP budget"*.
   *
   * The CONTENT was priced for that round. The ENGINE was not: one submitted
   * action ends the actor's turn, so Ward Rush at 2 and Iron Curtain at 5 cost
   * a player exactly the same thing. And with no frame carrying the budget, the
   * client could not even show the number — `affordable()` in client/main.ts
   * says so in its own docblock: *"a talent that is unaffordable purely on AP
   * shows as ready and is refused by the server with a sentence."*
   *
   * This is the frame that note is waiting for. It makes the number VISIBLE and
   * TRUE; it does not yet make the round open — that is the engine change, and
   * it lands separately so a deploy is never half-tuned.
   *
   * ═══ OPTIONAL, SO NO VERSION BUMP ═══
   * An old client ignores a field it cannot name, which this file's history
   * calls *"textbook… precisely what does NOT force a bump"*. That matters more
   * than tidiness here: a bump forces every player to reload, and there is no
   * reason to interrupt a session in progress to show them a pip row.
   *
   * VIEWER-PRIVATE, like the rest of `ResourceView`. Another detective's AP is
   * not yours to see, and the party pane has never claimed otherwise.
   */
  ap?: number;
  maxAp?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OTHER HALF OF THE ROUND, AND WALKING IS PAID OUT OF IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MOVE_MP_COST` is 1: a step costs one MP out of three, which is what keeps
   * a Watchman from trading his whole round for six steps. So MP is not a
   * secondary curiosity beside AP — it is HALF the answer to the only question
   * this HUD exists to answer, which is *"can I do anything else, or am I
   * done?"*. The engine already answers it honestly across all three budgets
   * (`hasAffordableAction`); until now the wire carried two of them.
   *
   * OPTIONAL AND VIEWER-PRIVATE, exactly like `ap` above and for both of the
   * same reasons: an old client ignores a field it cannot name, so no version
   * bump and nobody is forced to reload mid-session — and another detective's
   * remaining budget is not yours to read.
   */
  mp?: number;
  maxMp?: number;
  /**
   * Draw PIPS, not a bar.
   *
   * ═══ THE FLAG DID NOT CHANGE. ITS JUSTIFICATION DID. ═══
   * This used to be argued from Reagents never refilling at all. They now do —
   * one WHOLE vial on a slow timer, on top of kills and stairs (game-design.md
   * § 2) — and the flag is unchanged, because it never meant "static". It means
   * COUNTABLE: `current` is an integer for a discrete kind at every moment the
   * wire can observe, guaranteed by where the server keeps the remainder rather
   * than by the pool standing still.
   *
   * Countability is the whole read. A bar answers "how full am I?"; pips answer
   * "how many casts do I have left?", and 3-of-8 drawn as a bar reads as 37% of
   * something continuous that will top itself up on its own. A pool that refills
   * one countable unit at a time is still eight discrete decisions.
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PARTY MEMBER WHO IS SOMEWHERE ELSE — AND STILL IN YOUR PARTY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Instances are keyed by party, so a member who walked into a breach is in a
 * room that is ALREADY YOURS. Before this existed, `projectPartyState` skipped
 * any member whose body was not in the viewer's world, and the pane simply lost
 * the row — which is indistinguishable, from the chair, from being thrown out
 * of the party the moment a fight started. It was reported as exactly that.
 *
 * The party table never changed. Only the projection lied.
 */
export type PartyAway = {
  /** Where they are, by name. "An Index Breach", "Threadneedle". */
  readonly place: string;
  /**
   * Whether `follow` would work for THIS viewer right now — they are alive, on
   * their feet, and the room still exists. The control is drawn from this
   * rather than from `away !== null`, so a button that cannot work is never
   * offered.
   */
  readonly canFollow: boolean;
};

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
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW STRONG THEY ARE — THE ONE NUMBER THIS PANE IS ABOUT AND DID NOT CARRY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The world map grades every room and `partyHint` turns the top of that scale
   * into *"bring a party"*. `populateDelve` then builds the floor against
   * `partyMaxLevel`, so the party's composition materially decides what is
   * waiting behind the door.
   *
   * And the pane that exists to show a player who they are playing with showed
   * name, portrait, hit points and turn state — everything except the number
   * those two systems key off. "Bring a party" with no way to see whether the
   * party is strong enough is half an instruction.
   *
   * CARRIED HERE RATHER THAN JOINED, for the reason `hp` is: this pane cannot
   * rely on `ActorView`, because a member across the floor is exactly who the
   * FOV seam will one day withhold and exactly who the pane most needs to show.
   *
   * OPTIONAL, so no protocol bump — a client that does not know it draws the
   * row it always drew.
   */
  level?: number;
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
  /**
   * WHERE THEY ARE, WHEN IT IS NOT WHERE YOU ARE. Null when they are standing
   * on your floor, which is the common case.
   *
   * A member with `away` set has NO ROW IN `ActorView` for this viewer — they
   * are not in this world — so every field above that would normally be joined
   * from the actor is projected from their real body in the realm they are
   * actually in. `hp` and `state` are therefore live and true, not stale.
   */
  away: PartyAway | null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ON THE FLOOR, AND HOW LONG YOU HAVE — FOR A MEMBER YOU CANNOT SEE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `PartyMember.downed` already carries this, and carries it well, for everyone
   * on YOUR floor. game-design.md § 9 is explicit about what the mechanic is for:
   * it turns *"I died"* into *"GET TO ME"*.
   *
   * GET TO ME IS ADDRESSED TO SOMEBODY WHO HAS TO KNOW. The floor roster is
   * scoped to one world, so a member who walked into an instance and went down
   * inside it was described to the rest of the party by `hp` alone — and `hp: 0`
   * is what a Downed body, an Erased body and a dead one all read. A five-turn
   * clock nobody can see is not a rescue window.
   *
   * SO IT IS CARRIED HERE TOO, and this is the field for the member who is
   * ELSEWHERE — `away` says where they are and whether you can follow; this says
   * whether you should be running. The two are one sentence, and they were split
   * across two frames, one of which does not describe that person at all.
   *
   * NOT A SECOND SOURCE OF TRUTH: both fields are `downedView` reading the same
   * survival table, exactly as `PartyMember.downed` does. The pane prefers the
   * roster where both answer, so a body on your own floor is described by the
   * frame that has always described it.
   *
   * OPTIONAL, so no protocol bump — a client that does not know it draws the row
   * it always drew.
   */
  downed?: DownedView | null;
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
// v10 — LOOT. WHAT IS ON THE FLOOR AND WHAT IS IN YOUR HANDS.
//
// The VOCABULARY lives here, above the trust boundary, because `unequip` needs
// `SLOT_ORDER` at module-evaluation time to build its `z.enum` — a `const`
// declared four hundred lines further down would be a temporal dead zone error
// at import, which in a project with no build step is a crash on boot rather
// than a compile warning. The two MESSAGES that carry these shapes are with the
// other outbound frames at the bottom, exactly as `InspectView` sits up here and
// `InspectedMsg` sits down there.
// ---------------------------------------------------------------------------

/**
 * THE SEVEN WORN SLOTS. One item each, and there is no weapon slot.
 *
 * DELIBERATELY IDENTICAL to the server's own `Slot` (src/server/content/items.ts),
 * the same arrangement `ResourceKind` above has with the engine's: two
 * declarations rather than one import, because src/shared/ may not reach into
 * src/server/ — but the string values are the same seven, so the catalogue's
 * value satisfies this type structurally and no mapping function exists to get
 * out of step. Keeping the NAME verbatim is what makes `grep -rn "Slot"` find
 * both ends of the seam in six months.
 *
 * The values are ToME's own slot names lowercased (`body`, `head`, `feet` are
 * upstream's verbatim — data/birth/descriptors.lua:56), so a grep against
 * reference/t-engine4 still lands on what this was ported from.
 *
 * THERE IS NO `mainhand`, AND THAT IS A FACT ABOUT THE ART RATHER THAN A DESIGN
 * PREFERENCE. `client/public/assets/` is gitignored wholesale and an unresolved
 * key renders as the LOUD violet missing-asset box; no `icon_weapon_*` file
 * exists, so a weapon slot would ship a violet box to every player on a bare
 * clone. A class's weapon stays part of its authored `CombatSheet`. See the head
 * of src/server/content/items.ts for the four ids that look available and are not.
 */
export const Slot = {
  Head: 'head',
  Body: 'body',
  Legs: 'legs',
  Feet: 'feet',
  Offhand: 'offhand',
  Ring: 'ring',
  Trinket: 'trinket',
} as const;
export type Slot = (typeof Slot)[keyof typeof Slot];

/**
 * THE CANONICAL SLOT ORDER, and it is the source of the `unequip` enum.
 *
 * Member-for-member `SLOT_ORDER` in src/server/content/items.ts, where the order
 * is load-bearing for a different reason (it is the order gear is folded onto
 * the combat sheet, so the fold never depends on a Map's insertion order and
 * therefore never depends on which buttons a player happened to press first).
 * Here it is simply the paper doll's top-to-bottom reading order and the tuple
 * `z.enum` needs — but the two lists must stay identical, because a slot that
 * exists on the server and not here is a slot no client can ever take an item
 * out of.
 *
 * `as const satisfies readonly Slot[]` for the same reason `DIR_ORDER` carries
 * it (src/shared/coords.ts:54-63): the `satisfies` proves every entry is a real
 * slot while the `as const` keeps the literal tuple type that `z.enum` needs.
 */
export const SLOT_ORDER = [
  'head',
  'body',
  'legs',
  'feet',
  'offhand',
  'ring',
  'trinket',
] as const satisfies readonly Slot[];

/**
 * Compile-time proof that `SLOT_ORDER` lists every slot — the same device
 * coords.ts:66-71 uses for directions. If an eighth slot is added to `Slot` and
 * not to the list, this alias fails to satisfy `never` and the error NAMES the
 * missing member. Zero runtime cost, and it is the only thing standing between a
 * new slot and an `unequip` that silently cannot address it.
 */
type _Exhaustive<T extends never> = T;
type _MissingFromSlotOrder = _Exhaustive<Exclude<Slot, (typeof SLOT_ORDER)[number]>>;

/**
 * RARITY. Three tiers, and by construction the drop table as well.
 *
 * DELIBERATELY IDENTICAL to the server's `ItemTier` (src/server/content/items.ts),
 * on the same two-declarations terms as `Slot` above.
 *
 * IT IS ON THE WIRE BECAUSE IT IS THE ONLY THING THAT COLOURS A FLOOR MARKER OR
 * AN INVENTORY ROW, and the client must not infer it. Inferring would mean a
 * table of "which items are rare" in the browser — a second copy of authored
 * content in the one place that must never hold one, and the copy that will be
 * missing the next item somebody authors. ToME does the same thing with the
 * bracket tags it stamps on a description (`[Unique]`, `[Legendary]` —
 * tome/class/Object.lua:1164-1168): rarity is a property of the object, not
 * something the renderer works out.
 */
export const ItemTier = {
  Common: 'common',
  Uncommon: 'uncommon',
  Rare: 'rare',
} as const;
export type ItemTier = (typeof ItemTier)[keyof typeof ItemTier];

/**
 * ONE ITEM, AS MUCH AS IT TAKES TO DRAW IT AND NO MORE.
 *
 * WHAT IS NOT HERE, AND MUST NEVER BE: the `wielder` table. An item's actual
 * contribution — `{ mods: { armour: 4, armourHardiness: 10 } }` — is engine data
 * (src/server/content/items.ts), and a client holding it would immediately be
 * able to work out what equipping the thing would do, which is precisely the
 * arithmetic `compare` below exists to have already done on the server. Shipping
 * the raw table and formatting it in the browser is the same mistake as shipping
 * a talent's curve endpoints (see `LoadoutTalent.desc`): the second copy of a
 * formula, wearing a hat.
 *
 * IT CARRIES NO `slot`, AND THE OMISSION IS DELIBERATE. In `InventoryMsg.equipped`
 * the map KEY is the slot, so a `slot` field in the value would be a second copy
 * of the same fact that can disagree with the first — the argument `PartyMember`
 * makes about hp, in a smaller place. The carried list, where there is no key to
 * read it off, names it on `CarriedItemView` instead.
 *
 * `itemId` and `icon` are two fields that currently hold the same string for all
 * 22 authored items, and they stay two fields for the reason the catalogue gives:
 * `itemId` is what the wire and the save file carry, `icon` is a key into a
 * manifest the SERVER never reads. Collapsing them would make recutting a sprite
 * a save migration.
 */
export type ItemView = {
  /** A catalogue id — `item_watchmans_coat`. What `equip` and `drop` name. */
  readonly itemId: string;
  /** "Watchman's Coat". Authored, not derived from the id. */
  readonly name: string;
  /** An asset KEY, never a path — the same contract as `ActorView.sprite`. */
  readonly icon: string;
  readonly tier: ItemTier;
  /**
   * ONE SENTENCE OF FLAVOUR. It decides nothing, and it travels anyway.
   *
   * `Item.desc` in src/server/content/items.ts is declared, in its own words, as
   * "one sentence, shown in the inventory" — so the field was authored FOR this
   * screen and this frame is the only path to it. Leaving it off would mean the
   * pass that draws the panel could not show the line the catalogue exists to
   * carry without bumping the protocol a second time; adding it inside the bump
   * that is already happening costs one string per item, on a frame that is sent
   * when somebody's inventory changes rather than on every pump.
   */
  readonly desc: string;
};

/**
 * ONE ITEM IN YOUR BAG, WITH THE SERVER'S OWN ANSWER TO "SHOULD I PUT THIS ON?".
 *
 * ═══ `compare` IS THE WHOLE REASON THIS TYPE EXISTS ═══
 * It is the delta against WHATEVER IS ALREADY IN `slot`, already formatted:
 * `{ label: 'Armour', value: '+4' }`. Against an empty slot it is the item's
 * full contribution; against an occupied one it is the difference, which may be
 * negative and may be empty (two items that do the same thing compare to
 * nothing, and an empty list is the honest way to say "this changes nothing you
 * are not already getting").
 *
 * Ported in spirit from tome/dialogs/ShowEquipInven.lua:54, which passes the
 * destination inventory into `getDesc` as `compare_with`
 * (tome/class/Object.lua:2074, forwarded at :2120 to `getTextualDesc` at :1157),
 * where `compare_fields(w, compare_with, field, "combat_armor", "%+d",
 * "Armour: ")` at :1285-1287 renders exactly a label and a signed number.
 *
 * REUSING `InspectRow` RATHER THAN DECLARING A FOURTH LABEL/VALUE PAIR is the
 * same move `PartyStateMember.state` makes in reusing `TurnActorState`: one
 * shape means the inventory panel and the hover card draw a stat line the same
 * way and cannot drift into two house styles on one screen. `emphasis` is
 * available and is meant for the row that decides the swap.
 *
 * THE CLIENT MAY NOT COMPUTE THIS. eslint blocks src/client/** from importing
 * shared/checkhit, shared/scale and shared/energy, so it cannot — and even the
 * subtraction that looks safe is not: `rescaleCombatStats` FLOORS
 * (src/shared/scale.ts:116), so +3 Strength is worth a different number of
 * points of damage depending on where the total already sits, and a browser
 * doing plain arithmetic would confidently promise a player something the
 * server will not deliver.
 */
export type CarriedItemView = ItemView & {
  /**
   * WHERE IT WOULD GO. Named here because a bag has no key to read it off.
   *
   * ABSENT ON A CONSUMABLE, which is also how the client knows not to offer
   * "Equip" for it — see `Item.slot`. One field answering "can this be worn"
   * rather than a second boolean that could disagree with it.
   */
  readonly slot?: Slot;
  /**
   * THE DELTA AGAINST WHAT IS IN `slot` RIGHT NOW, PRE-FORMATTED.
   *
   * EMPTY IS A REAL ANSWER and means "equipping this moves nothing you can
   * see" — which happens honestly, because armour below the attacker's armour
   * penetration measures as exactly zero (`max(0, armour - apr)`,
   * src/server/engine/damage.ts). Drawing an empty list as a blank row is the
   * correct rendering; inventing a "no change" line is not this type's job.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS SHOP WOULD PAY FOR IT. Absent outside a room with a counter.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The panel could already label a SELL control when the shelf happened to
   * stock the same item — it read the price off the shop frame — and the note on
   * that fallback is right that *"a missing label is better than a client
   * inventing a number"*. But the shelf holds four things and a player's bag
   * holds whatever they carried out of a delve, so the two rarely intersect:
   * selling was a button with no price on it almost every time it mattered.
   *
   * ABSENT RATHER THAN ZERO WHEN THERE IS NO SHOP, because a price is a fact
   * about a transaction that is not on offer, and a number sitting in a delve's
   * inventory frame is one more thing that has to be explained as meaningless.
   */
  readonly sell?: number;
  readonly compare: readonly InspectRow[];
};

/**
 * ONE ITEM LYING ON A TILE.
 *
 * ═══ `id` IS THE WORLD'S, `itemId` IS THE CATALOGUE'S, AND THEY ARE NOT THE
 *     SAME KIND OF THING ═══
 * `id` (`ground_7`) is minted per drop, never reused, and is what makes two
 * identical pairs of trousers on one tile two distinct rows. `itemId`
 * (`item_watchmans_trousers`) is what they have in common and what the icon
 * comes from. A client that keyed on `itemId` would draw one marker for two
 * items and would be permanently one short.
 *
 * ═══ `cell` IS A PAIR, NOT TWO FIELDS, AND THAT IS THE DIFFERENCE FROM
 *     `ProjectileView` ═══
 * An orb's x/y CHANGE every turn and the renderer interpolates between two
 * readings, so two independently-read numbers are the right shape there. A
 * ground item never moves at all — src/server/world/world.ts:874 freezes the
 * record with the note "a ground item is a fact about a tile, not a body: it
 * never moves" — so its tile is one immutable compound value, and it is the
 * value the client groups by to draw ONE pile marker on a tile holding three
 * things. A tuple is a key; two loose numbers are an invitation to read one of
 * them without the other.
 */
export type GroundItemView = {
  /** `ground_<n>`, from the world's monotonic counter. Never reused. */
  readonly id: string;
  /** `[x, y]`. See above for why this is one value and not two. */
  readonly cell: readonly [number, number];
  /** A catalogue id. Two items of the same kind share it; their `id`s differ. */
  readonly itemId: string;
  /** Colours the floor marker. The client must not infer it — see `ItemTier`. */
  readonly tier: ItemTier;
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHICH OF MY CHARACTERS I AM PLAYING TONIGHT.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * NOT AN IDENTITY CLAIM, AND NON-NEGOTIABLE 5 STILL HOLDS. This names a
   * character, never a person: the server resolves the OWNER from `sessionId`
   * and then asks whether that owner has a character by this id. A socket that
   * names somebody else's character id gets the same answer as one that names a
   * character that never existed — the roster, again — because the lookup is
   * `data/characters/<ownerId>/<characterId>.json` and an owner it does not
   * match simply is not a path that exists.
   *
   * ABSENT MEANS "SHOW ME THE LIST". A verified socket that names nothing gets a
   * `roster` frame and NO BODY: it is standing in the select screen, and the
   * world does not have a token in it for somebody who has not chosen yet. An
   * ANONYMOUS socket that names nothing joins straight away exactly as it always
   * has — there is no account, so there is no list, and the alternative is an
   * empty menu in front of a player who cannot ever fill it.
   */
  characterId: z.string().min(1).max(64).optional(),
  /**
   * "Make me a new one." The server allocates the id — the client never invents
   * one, because two clients inventing at once collide and the loser silently
   * plays somebody else's character.
   *
   * IGNORED WHEN `characterId` IS PRESENT rather than being an error: the two
   * together are a client bug, and refusing the connection over it would strand
   * a player at a menu with no way forward. Naming a character wins, because it
   * is the request that cannot lose data.
   */
  newCharacter: z.boolean().optional(),
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
 * Longest talent id a client may name. `talent:sniper_mark` is 18 characters and
 * the longest of the twelve is `talent:alchemic_vial` at 20; 64 matches
 * `ACTOR_ID_MAX_CHARS` and `CLASS_ID_MAX_CHARS` so there is one number to
 * remember, and it is headroom rather than a place to park a payload.
 *
 * ONE CONSTANT SHARED BY `talent` AND `spend_point`, on purpose. They name the
 * same namespace of ids, and two independent caps is how a talent whose id fits
 * one frame and not the other eventually ships.
 */
const TALENT_ID_MAX_CHARS = 64;

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
  talentId: z.string().min(1).max(TALENT_ID_MAX_CHARS),
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
 * ═══════════════════════════════════════════════════════════════════════════
 * `talk` — SPEAK TO SOMEBODY WHO LIVES HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ A TARGET ID, NOT A TILE, AND THAT IS THE DIFFERENCE FROM `point` ═══
 * `point` names a TILE because a player is pointing at ground and the server
 * resolves whatever happens to be on it. Talking names a PERSON: if the
 * shopkeeper steps aside between the click and the frame, the honest answer is
 * "she is not there" rather than a conversation with whoever moved into the
 * square. The id is re-checked server-side against range, line of sight and
 * faction — the client's opinion about who it clicked is an opinion.
 *
 * ═══ NO VERSION BUMP, AND THE REASON IS THE DIRECTION ═══
 * This is a member of `ClientMsg`, the INBOUND union. An older client simply
 * never sends it; nothing it already sends changes shape, and nothing it
 * receives does either. `src/shared/version.ts` forces a bump when an older
 * client would MISREAD something, and a frame it never emits cannot be misread.
 * The reply is an ordinary Margin `log` line, which every client since v3 draws.
 *
 * ═══ IT DOES NOT ADVANCE THE WORLD ═══
 * Like `say` and `point`, and for the reason those two carry a rate limit: a
 * frame that costs the sender nothing must not be a way to make the server do
 * work. Talking spends no turn and pumps nothing — a town has no clock running
 * anyway, which is a fact the reply logic depends on rather than ignores.
 */
const TalkSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('talk'),
  /** WHO. Re-checked server-side; see the note above. */
  targetId: z.string().min(1).max(ACTOR_ID_MAX_CHARS),
  /**
   * WHAT ABOUT. Absent is a greeting — walking up and saying hello.
   *
   * A CLOSED VOCABULARY, not free text: `content/townsfolk.ts#TopicId` is the
   * set, the server answers only from a table keyed by it, and an id it does
   * not know gets the greeting rather than an error. That is the whole reason
   * this is a topic ID and not a question string — a shopkeeper cannot be made
   * to say something nobody wrote.
   */
  topic: z.string().min(1).max(32).optional(),
});

/**
 * Longest class id a client may name. `watchman` is 8 characters and the longest
 * one MVP authors is `alchemist` at 9; 64 matches `ACTOR_ID_MAX_CHARS` and
 * `TalentSchema`'s own cap so there is one number to remember, and it is headroom
 * rather than a place to park a payload.
 */
const CLASS_ID_MAX_CHARS = 64;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `choose_class` — "I will be the Watchman." The v8 verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sent once, by a player who has no class on file, in answer to the
 * `class_options` frame below. A returning player never sends one and never sees
 * the screen that produces it.
 *
 * ═══ IT CARRIES NO `actorId` AND NO TARGET FIELD OF ANY KIND ═══
 * It is the same shape as `commit`, `hold` and `respawn` and it is in that
 * family, NOT in `party`/`inspect`'s: those two name the OBJECT of their verb
 * (who is being invited, what is being looked at) and this one has no object.
 * Choosing a class is something a socket DOES to its own body. Identity is the
 * server-side session, exactly as with `move`, and `strictObject` REJECTS a
 * smuggled `actorId` rather than quietly stripping it into a legal frame
 * (see the note at the head of `HelloSchema`) — so an attempt to pick somebody
 * else's class fails loudly in the log instead of being sanitised.
 *
 * ═══ `classId` IS A BOUNDED STRING, NOT A `z.enum` OF THE THREE IDS ═══
 * Deliberately following `TalentSchema`'s stated precedent above: the class
 * table is server-side authored content, and baking the catalogue into the wire
 * schema would make every content edit — a fourth class, a renamed id — a
 * PROTOCOL change requiring a version bump and a client redeploy. An unknown id
 * is refused one step later by the server's own `classById` lookup with
 * `bad_message`, which is the same outcome and does not couple the two.
 *
 * ═══ WHAT THIS SCHEMA DOES NOT CHECK ═══
 * That the sender is actually owed a choice. zod validates SHAPE; whether this
 * socket has an unassigned character is a question about the world, and a player
 * who already has a class gets `not_your_turn` from the handler — the same shape
 * `respawn` uses to refuse a body that has nothing to file. No new `ErrorCode`
 * member is added for it, because both codes already exist and every shipped
 * client already renders them.
 */
const ChooseClassSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('choose_class'),
  classId: z.string().min(1).max(CLASS_ID_MAX_CHARS),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `delete_character` — "PUT THIS ONE AWAY." The v19 verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The only destructive verb in this protocol, and the only one that reaches a
 * file rather than a body. It exists because the select screen can hold eight
 * characters and had no way to hold seven.
 *
 * ═══ IT NAMES A CHARACTER AND NOT AN OWNER, WHICH IS THE WHOLE SECURITY ═══
 * There is no `ownerId` here — there is no `ownerId` ANYWHERE in this protocol
 * (see the note at the head of this file), and `strictObject` is what turns a
 * smuggled one into a rejection rather than a field somebody downstream might
 * read. Whose character this is gets resolved server-side from the verified
 * session, so the worst a hostile frame can name is one of its own files.
 *
 * ═══ AND IT DOES NOT MEAN "UNLINK" ═══
 * The persist layer implements it as a rename to a timestamped name — the
 * bytes stay on disk where a human can reach them. That is deliberately NOT
 * expressed here: the wire says what the PLAYER meant ("I do not want this
 * character in my list"), and how much care the server takes about the bytes
 * behind that is the server’s business and may change without the client
 * caring. See `SaveStore.retireCharacter`.
 *
 * ═══ NO VERSION BUMP, AND THIS FILE STATES THE RULE ═══
 * `PROTOCOL_VERSION`’s own history says it: "Additions alone would not force a
 * bump — an old client ignores a frame it does not know". This is inbound and
 * purely additive; an older client simply never sends it, and there is no
 * outbound shape change at all — the answer is the `roster` frame that already
 * exists, which is how the client learns the list is one shorter.
 */
const DeleteCharacterSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('delete_character'),
  /**
   * THE SAME BOUND `hello.characterId` CARRIES, because it is the same id and a
   * second opinion about how long a character id may be is a second thing to
   * get wrong. The persist layer sanitises it again before it becomes a path
   * segment — this bound is about the wire, not about the filesystem, and the
   * filesystem does not trust anything that reaches it.
   */
  characterId: z.string().min(1).max(64),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `spend_point` — "PUT MY NEXT POINT INTO THIS TALENT." The v9 verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One point, one talent, one raw level. The panel's `+` button, and ToME's own
 * `onUseTalent(item, inc)` reduced to the only case we have (LevelupDialog.lua
 * :980-1000 — upstream also handles unlearning and category unlocks, and we have
 * neither).
 *
 * ═══ IT NAMES NO ACTOR, AND `strictObject` IS WHAT MAKES THAT A REFUSAL ═══
 * There is no `actorId` and no `playerId`, here or anywhere in this protocol
 * (see the note at the head of this file). Whose sheet gains the level is the
 * socket's business, resolved server-side from the session, exactly as with
 * `move` and `choose_class`. A frame that smuggles one in is REJECTED rather
 * than quietly stripped into a legal frame — see the note at the head of
 * `HelloSchema` — so an attempt to level somebody else's talent fails loudly in
 * the log instead of being sanitised away. That matters more here than almost
 * anywhere: a spend is IRREVERSIBLE (there is no refund verb and no unlearn),
 * so a sanitised frame would permanently spend a stranger's point.
 *
 * ═══ `talentId` IS A BOUNDED STRING, NOT A `z.enum` OF THE TWELVE IDS ═══
 * Deliberately following `TalentSchema`'s stated precedent above, and
 * `ChooseClassSchema`'s after it: the talent table is server-side authored
 * content that reloads without a protocol bump, and baking the catalogue into
 * the wire schema would make every content edit — a thirteenth talent, a renamed
 * id — a PROTOCOL change requiring a version bump and a client redeploy.
 *
 * ═══ WHAT THIS SCHEMA DOES NOT CHECK, AND MUST NOT BE MISTAKEN FOR CHECKING ═══
 * That the talent exists, that this detective has LEARNED it, that it is below
 * `TALENT_MAX_LEVEL`, and that there is an unspent point to pay with. zod
 * validates SHAPE; every one of those is a question about the world, they are
 * answered in the spend handler, and each comes back as `bad_message`. No new
 * `ErrorCode` member is added for any of them — src/shared/version.ts records
 * that a new code independently forces a bump, and v8 kept its argument to one
 * reason by reusing two existing codes. This does the same.
 *
 * ═══ IT DOES NOT PUMP THE WORLD ═══
 * Spending a point costs no energy, consumes no RNG and advances no turn, so it
 * belongs beside `inspect` and `choose_class` in the gateway's non-pumping
 * group: a frame that costs the sender nothing must never be a way to make the
 * server advance the world. What it DOES produce is a fresh `loadout` — `range`
 * and `desc` are stale the instant a rank changes — and a fresh `progress`.
 */
const SpendPointSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('spend_point'),
  talentId: z.string().min(1).max(TALENT_ID_MAX_CHARS),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `spend_stat` — "PUT MY NEXT ATTRIBUTE POINT INTO THIS ONE." The v19 verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE POINT, ONE STAT, NO AMOUNT. The frame cannot say "put three into
 * Strength", for the reason `spend_point` gives about talents: an amount is a
 * number a client can get wrong, and a repeated verb is a repeated confirmation.
 * The server decides whether a point exists to spend.
 *
 * A CLOSED SET, not a free string — the six ToME defines at `load.lua:182-189`.
 * LUCK IS NOT IN IT and its absence is the design: upstream calls Luck hidden,
 * starts it at 50 and grants no way to raise it, so a seventh row here would be
 * a promise the rest of the system does not keep.
 *
 * NOTHING IS REFUNDABLE, exactly as talents are not, and there is no
 * `unspend_stat`. ToME lets you take a point back only before you confirm the
 * levelup dialog; this game has no screen to confirm, so a point is spent the
 * moment it is sent — which is why the client asks twice before sending one.
 */
const SpendStatSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('spend_stat'),
  stat: z.enum(['str', 'dex', 'con', 'mag', 'wil', 'cun']),
});

/**
 * Longest item id a client may name. `item_inspectors_deerstalker` is 27
 * characters and is the longest of the 22 authored; 64 matches
 * `ACTOR_ID_MAX_CHARS`, `CLASS_ID_MAX_CHARS` and `TALENT_ID_MAX_CHARS` so there
 * is ONE number to remember across the whole file, and it is headroom rather
 * than a place to park a payload.
 *
 * EXPORTED so `content/resolve.ts` can prove at import time that the longest id
 * its grammar can ever build still fits. A cap that lives only in the schema is
 * a cap nothing checks until a save file is silently truncated by it.
 */
export const ITEM_ID_MAX_CHARS = 64;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `pickup` — "TAKE THE THING I AM STANDING ON." THE v10 VERB.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT CARRIES NOTHING AT ALL, AND THE EMPTINESS IS THE SECURITY PROPERTY ═══
 * No tile, no ground id, no item id, no direction. The server reads the sender's
 * OWN live x/y off the actor the session owns and takes `world.itemsAt(x, y)[0]`
 * — index 0, which src/server/world/world.ts:516-522 already names as the pickup
 * rule ("PICKUP TAKES INDEX 0. That is the whole reason the order is specified"). So this frame is in the family of `commit`, `hold` and `respawn`: a thing
 * a socket DOES to itself, with no object to point anywhere else.
 *
 * ═══ WHY THAT IS STRICTLY STRONGER THAN RANGE-CHECKING A SUPPLIED TILE ═══
 * The obvious alternative — `pickup { x, y }`, refused unless the tile is the
 * sender's own — is a check that has to be right, on a coordinate an attacker
 * chose, and the note at the head of this file (see `TileSchema`, and the M3
 * paragraph about the range ring) says a hand-crafted frame from a devtools
 * console is THE NORMAL CASE TO DESIGN FOR rather than the exotic one. Here there
 * is nothing to check because there is nothing to forge: no coordinate arrives,
 * so no off-by-one in an adjacency test can ever let somebody reach across the
 * room and take the coat a friend is standing over. `respawn`'s docblock above
 * makes the identical argument about a target field, and this is that argument
 * applied to a position.
 *
 * A `groundId` WOULD BE THE SAME MISTAKE IN A NEW COSTUME. It names something the
 * client was legitimately sent (every `GroundItemView.id` arrives in the `ground`
 * broadcast, which is the whole floor), so it would read as safe by the same
 * three tests `party`'s `targetId` passes — and it would still let a patched
 * client name a pile it is nowhere near. The floor frame is broadcast; the taking
 * is not. Carrying no id keeps those two facts apart.
 *
 * ═══ IT PUMPS THE WORLD, AND THAT IS DELIBERATE ═══
 * A pickup costs a turn. Upstream charges for it too — the pickup is an action in
 * ToME, not a free look — and the co-op reason is sharper: a FREE pickup lets a
 * player loot a whole room mid-fight while the monsters stand still.
 * test/server/gateway-progression.test.ts:70-71 argues the non-pumping group
 * (`inspect`, `choose_class`, `spend_point`) on exactly the mirror of this
 * ground — "if it pumped, a player could bank a levelled talent AND a free
 * monster turn from one click" — and loot is the case that argument was drawing
 * the line against.
 *
 * ═══ WHAT THIS SCHEMA DOES NOT CHECK ═══
 * That there is anything on the tile at all, that the sender is on their feet,
 * that their bag has room, and — the one W2 flagged — that they are not already
 * carrying an item with this id, since `carried` is a SET and a duplicate would
 * be silently dropped by the next save/reload and present as "my second cap
 * vanished when I relogged". zod validates SHAPE; every one of those is a
 * question about the world and each comes back as `bad_message` or
 * `illegal_move`. NO NEW `ErrorCode` MEMBER IS ADDED FOR ANY OF THEM — see the
 * note on `ErrorCode` below, and src/shared/version.ts, which records that a new
 * code independently forces a bump.
 */
const PickupSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('pickup'),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `equip` — "PUT THIS ON." The v10 verb that names an OBJECT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT NAMES AN ITEM, NEVER AN ACTOR, AND NEVER A SLOT ═══
 * The missing-field rule at the head of this file is about the SUBJECT of a verb.
 * Whose body puts the coat on is the socket's session, exactly as with `move`;
 * `strictObject` REJECTS a smuggled `actorId` rather than sanitising it into a
 * legal frame, which is what stops a patched client dressing somebody else.
 *
 * THE DESTINATION SLOT IS NOT ON THE WIRE EITHER, and that is the part worth
 * writing down. `Item.slot` is authored in src/server/content/items.ts — a coat
 * goes on the body and there is nowhere else it could go — so a `slot` field here
 * would be a client asserting authored content, and the only thing the server
 * could do with a disagreement is ignore it. Upstream reaches the same place by a
 * different road: `Object:wornInven()` (engines/default/engine/Object.lua:104-107)
 * derives the destination inventory FROM THE OBJECT, and the dialog never asks.
 *
 * ═══ THE ITEM MUST BE IN THE SENDER'S OWN BAG ═══
 * The server resolves `itemId` against THAT actor's `carried` and nothing else,
 * so there is no cross-inventory lookup table for a forged id to reach into. The
 * worst a made-up id achieves is a refusal.
 *
 * ═══ `itemId` IS A BOUNDED STRING, NOT A `z.enum` OF THE 22 IDS ═══
 * Following `TalentSchema`'s stated precedent, and `ChooseClassSchema`'s and
 * `SpendPointSchema`'s after it: the catalogue is server-side authored content,
 * and baking it into the wire schema would make every content edit — a
 * twenty-third item, a renamed id — a PROTOCOL change requiring a bump and a
 * client redeploy. An unknown id is refused one step later by the server's own
 * `itemById` lookup with `bad_message`, which is the same outcome and does not
 * couple the two.
 */
const EquipSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('equip'),
  itemId: z.string().min(1).max(ITEM_ID_MAX_CHARS),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `unequip` — "TAKE THIS OFF." A SLOT, and the only closed enum of the four.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHY THIS ONE IS A `z.enum` WHEN `equip` IS A BOUNDED STRING ═══
 * The three items above all name AUTHORED CONTENT, which reloads without a
 * protocol bump — so putting the catalogue in the wire schema would couple two
 * things that are meant to move independently. A SLOT is not content: it is
 * structure, it is on the wire already as `Slot`, and a v10 client and a v10
 * server necessarily agree about all seven. Adding an eighth slot is a protocol
 * change whatever this schema says, so there is nothing to decouple and the
 * closed enum is free — it buys a refusal one layer earlier and a failure message
 * that names the field.
 *
 * `z.enum(SLOT_ORDER)` rather than seven literals typed out here, so the wire
 * enum and the paper doll's order cannot drift; `_MissingFromSlotOrder` above is
 * what proves `SLOT_ORDER` is the whole of `Slot`.
 *
 * ═══ IT NAMES THE SLOT AND NOT THE ITEM, AND THE DIRECTION MATTERS ═══
 * There is exactly one item in a slot, so the slot identifies it — but the
 * reverse is not reliably true in the presence of a client that has fallen a
 * frame behind. A stale `unequip { itemId }` would ask to remove something that
 * is no longer worn and would have to be refused; a stale `unequip { slot }`
 * empties the slot the player is looking at, which is what they meant. An empty
 * slot is `bad_message` and nothing else happens.
 */
const UnequipSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('unequip'),
  slot: z.enum(SLOT_ORDER),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `drop` — "LEAVE THIS HERE." The fourth v10 verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ IT CARRIES NO DESTINATION TILE, DELIBERATELY ═══
 * A drop lands on the SENDER'S OWN tile, read server-side from the actor the
 * session owns — the same emptiness `pickup` relies on, in the other direction.
 * A `{ x, y }` here would let a patched client post items into a room it cannot
 * see, or under a monster, or onto the tile a friend is about to step on, and the
 * only defence would be an adjacency check on an attacker-supplied coordinate.
 * There is no coordinate, so there is no check to get wrong.
 *
 * ═══ IT NAMES A CARRIED ITEM, NOT A WORN ONE ═══
 * `itemId` is resolved against the sender's own `carried`, so dropping something
 * that is being worn is two verbs — `unequip` then `drop` — rather than one that
 * quietly does both. That is not fastidiousness: an item leaving a slot RECOMPOSES
 * the combat sheet (src/server/engine/effects.ts's `recomposeCombat`), and a verb
 * that silently changed a player's armour on the way to putting a coat on the
 * floor is exactly the kind of hidden write this protocol refuses elsewhere.
 *
 * ═══ AND IT IS THE ONE VERB THAT GIVES SOMETHING AWAY ═══
 * The floor pile is UNOWNED — any party member standing on the tile may take it,
 * first pickup wins. src/server/content/items.ts:77-80 states the same fact from
 * the other side ("loot on this game's floor is an UNOWNED pile that three to six
 * players are standing around") and shapes the catalogue around it.
 *
 * THAT RULE IS A DEVIATION AND THERE IS NO CITATION FOR IT. ToME is
 * single-player: `Actor:die` calls `game.level.map:addObject(dropx, dropy, o)`
 * with no owner, no reservation and no party concept, because there is no party
 * to have one. Citing that as authority for a co-op rule would be fabrication, so
 * it is labelled here the way `awardExperience` labels the party-xp rule it also
 * had to invent. What it costs, plainly: an item can be sniped by the fastest
 * clicker, and the answer is social rather than mechanical — `drop` is how "you
 * take it, I've got a coat" actually happens, and the Case Log line naming who
 * took what is the transcript that settles the argument afterwards.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `use` — DRINK SOMETHING. The verb that lets a fight end a third way.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A party at a fifth of its health could retreat or die. This is the third
 * option, and a roguelike without it has no reason for a player to carry money
 * past the coat they were always going to buy.
 *
 * ONLY AN ITEM ID, exactly like `equip`. WHAT it does is authored content the
 * server reads off the catalogue (`Item.use`), and a client that could name an
 * effect could name a bigger one. The same sentence `EquipSchema` uses about its
 * destination slot, for the same reason.
 *
 * NO TARGET. A draught is drunk by the person holding it — healing somebody
 * across the room is a TALENT, which is a thing you spend points on and which
 * the Alchemist already has. Letting an item do it would make the class's
 * defining move purchasable.
 */
const UseSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('use'),
  itemId: z.string().min(1).max(ITEM_ID_MAX_CHARS),
});

const DropSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('drop'),
  itemId: z.string().min(1).max(ITEM_ID_MAX_CHARS),
});

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

// ---------------------------------------------------------------------------
// THE KEYMAP'S BOUNDS — EXPORTED, BECAUSE THREE LAYERS HAVE TO AGREE ON THEM
//
// The `SAY_MAX_CHARS` discipline at :1594-1605, applied to four numbers instead
// of one: *"Exported so the command line's `maxlength` and this schema are ONE
// number. Two numbers means the day they drift a player types a sentence,
// watches the input accept it, and gets `bad_message` back."* Here the input is
// the Keys screen's capture field and the drift is worse than a refused
// sentence — a rebind the capture field accepted and the server refused leaves
// the player looking at a key that does nothing.
//
// THERE IS A THIRD READER AND IT IS NOT ON THIS WIRE AT ALL. A hand-edited
// character file never passes through zod (:6-14 — "CLIENT -> SERVER is zod. It
// is the single trust boundary"), so src/server/persist/saves.ts:1112-1126
// declares the identical four numbers for the disk. THE DISK CAP MUST NEVER BE
// TIGHTER THAN THESE: a map the server ACCEPTED over the wire would then come
// back repaired after a reconnect, and the player watches a binding they set
// change by itself. test/server/keybinds-wire.test.ts pins the two sets equal
// by running a map built at exactly these caps through `parseCharacterFile`.
// ---------------------------------------------------------------------------

/**
 * Ceiling on how many distinct actions one remap may name.
 *
 * A REAL BOUND WITH ONE RELEASE OF HEADROOM, NOT A SHRUG. The action namespace
 * is CLOSED and countable — eight directions, three turn commands, eight UI
 * commands, four hotbar slots, two scroll steps and cancel is 26 — so 40 is a
 * number somebody worked out rather than a round one somebody picked. A map
 * naming 41 actions is naming actions that do not exist.
 */
export const KEYBIND_MAX_ACTIONS = 40;

/** `move_northeast` is 14. 48 is a ceiling, not a fit. */
export const KEYBIND_ACTION_MAX_CHARS = 48;

/**
 * TWO SLOTS PER ACTION, WHERE ToME HAS THREE.
 *
 * `KeyBind:saveRemap` writes k1/k2/k3 (engines/default/engine/KeyBind.lua:88-103)
 * and `binds_remap[virtual]` is a three-element table. THE THIRD IS A MOUSE
 * GESTURE: KeyBinder.lua:134-184 captures it with a `GetText.new` box whose
 * strokes arrive through `d.mouse:registerZone` at :166 — not through the key
 * handler — and this project binds the mouse in src/client/input/mouseintent.ts,
 * which no keymap reaches.
 *
 * ═══ AND THE DEVIATION IS WIDER THAN "THREE SLOTS BECOME TWO" ═══
 * Upstream also accepts a MOUSE BUTTON into slots 1 and 2: the
 * `curcol == 1 or curcol == 2` branch installs `d:mouseZones` at
 * KeyBinder.lua:109-128 and writes `KeyBind:makeMouseString(button, …)` straight
 * into `binds_remap[t.type][curcol]` at :124. So ours is two slots rather than
 * three AND no mouse in any of them. That second half is not a shortfall of this
 * constant — src/client/input/mouseintent.ts argues the whole mouse vocabulary
 * separately — but a reader weighing "what does dropping to two slots cost"
 * deserves the true answer rather than one that makes the mouse sound confined
 * to the slot we dropped. A DELIBERATE DEVIATION, and a slot that could never be
 * filled would be worse than absent.
 */
export const KEYBIND_KEYS_PER_ACTION = 2;

/**
 * Longest single key string. `code:NumpadDecimal` is 18.
 *
 * A key string is one of the two tagged forms the dispatcher understands —
 * `key:h` (the layout-dependent character, so a binding follows a player's
 * keyboard) or `code:Numpad8` (the physical key, so numpad movement survives
 * NumLock). ToME makes the identical distinction and matches its two forms in
 * order (KeyBind.lua:146-148, :227-244).
 */
export const KEYBIND_KEYSTRING_MAX_CHARS = 32;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `set_keybinds` — "THESE ARE MY KEYS." The Keys screen's only verb.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHOLESALE, NEVER A DELTA. The frame carries the player's COMPLETE remap and
 * replaces whatever the server held, so RESET ALL is `binds: {}` and needs no
 * second verb. A per-action delta would need a "forget this one" spelling, and
 * two spellings of empty is the thing this protocol refuses everywhere else.
 *
 * ═══ IT NAMES NO ACTOR, AND `strictObject` IS WHAT MAKES THAT A REFUSAL ═══
 * The missing-field rule at the head of this file, unbroken: whose keyboard this
 * is is the socket's business, resolved server-side from the session exactly as
 * with `move`. A smuggled `actorId` is REJECTED rather than quietly stripped
 * into a legal frame (see the note at the head of `HelloSchema`) — so an attempt
 * to rewrite somebody else's keys fails loudly in the log instead of being
 * sanitised into a rewrite of the sender's own.
 *
 * ═══ `v` IS NOT OPTIONAL HERE, FOR `InspectSchema`'S REASON (:2101-2107) ═══
 * `parseClientMsg`'s version check is guarded by `'v' in candidate` and the
 * gateway's `wireVersion` returns undefined for a frame without one, so a frame
 * that simply OMITS the field would skip version enforcement entirely. The
 * `z.literal` is the whole of what makes it mandatory.
 *
 * ═══ THE MAP IS `Record<string, string[]>`, NOT AN ENUM OF THE 26 ACTIONS ═══
 * `TalentSchema`'s stated precedent, and `ChooseClassSchema`'s and
 * `EquipSchema`'s after it. The action table is CLIENT-side (src/client/input/
 * keys.ts) and the server has no copy of it — net/ cannot import the browser —
 * so there is nothing here to validate membership against, and baking the table
 * into the wire schema would make renaming one action a protocol change. An id
 * this build no longer binds is kept verbatim all the way to the disk and the
 * CLIENT drops what it cannot bind, exactly as `createTalentSheet` drops a
 * talent id the class no longer has.
 *
 * ═══ WHAT THIS SCHEMA DOES NOT CHECK ═══
 * That any of these actions exists, that a key string is one the dispatcher can
 * ever deliver, and — the one that matters to a player — that two actions are
 * not fighting over one key. zod validates SHAPE. Conflicts are refused at the
 * CAPTURE FIELD, where the screen can name which action already holds the key;
 * refusing them here would be a refusal with nothing to point at. NO NEW
 * `ErrorCode` MEMBER IS ADDED for any of it: a malformed or oversized map is
 * `bad_message`, exactly as v10 refused every loot failure, and src/shared/
 * version.ts records that a new code independently forces a protocol bump.
 *
 * ═══ IT DOES NOT PUMP THE WORLD ═══
 * A rebind costs no energy, queues no intent and draws no RNG, so it joins
 * `inspect`, `choose_class` and `spend_point` in the gateway's non-pumping
 * group: a frame that costs the sender nothing must never be a way to make the
 * server advance the world.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `set_zoom` — "THIS IS HOW BIG I WANT THE TILES."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A player said the tiles read smaller than Tales of Maj'Eyal's and the world
 * did not fill the space. Half of that was the viewport, which moved from
 * fifteen rows to ten. The other half is that ZOOM ALREADY EXISTED and did not
 * survive the tab: bound to `-` and `=`, listed on the Keys screen, on the
 * wheel — and reset to default on every reconnect, so the answer to "the tiles
 * are too small" was one a player had to re-give every session.
 *
 * ═══ IT CANNOT BE STORED IN THE BROWSER ═══
 * This game runs in a Discord Activity iframe, where storage is partitioned or
 * blocked outright. That is the same reason keybinds are server-side, and it is
 * why a preference here means a frame rather than a `localStorage` line.
 *
 * ═══ A STEP, NOT A SIZE ═══
 * The value is the same integer bias the renderer clamps, bounded by
 * `ZOOM_MIN`/`ZOOM_MAX` from `shared/version.ts` — imported rather than restated,
 * because a bound written down twice is the shape this codebase keeps being
 * bitten by. Sending pixels instead would let a client pick a fractional
 * magnification, which is the one thing this renderer will not do.
 */
const SetZoomSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('set_zoom'),
  zoom: z.number().int().min(ZOOM_MIN).max(ZOOM_MAX),
});

const SetKeybindsSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('set_keybinds'),
  /**
   * ACTION ID -> KEY STRINGS, in slot order. ToME's `binds_remap[virtual] =
   * {key1, key2, key3}` (KeyBind.lua:78, :88-103) with one slot removed.
   *
   * SPARSE: only actions the player actually changed appear, which is upstream's
   * own shape (`saveRemap` writes only remapped virtuals) and is what lets a
   * shipped change to a DEFAULT reach every player who never touched it.
   *
   * AN EMPTY ARRAY IS A REAL VALUE — "cleared, both slots" — and is NOT the same
   * as the action being absent. `.min(1)` on the key string rather than on the
   * array is deliberate: an empty STRING is not a key anybody pressed, an empty
   * LIST is a decision somebody made.
   */
  binds: z
    .record(
      z.string().min(1).max(KEYBIND_ACTION_MAX_CHARS),
      z.array(z.string().min(1).max(KEYBIND_KEYSTRING_MAX_CHARS)).max(KEYBIND_KEYS_PER_ACTION),
    )
    // The COUNT cap cannot be expressed in `z.record` itself, so it is a refine
    // rather than a builder call. It is the bound that stops a 16 KB frame full
    // of one-character action ids from becoming 16 KB of character file.
    .refine((map) => Object.keys(map).length <= KEYBIND_MAX_ACTIONS, {
      message: `at most ${String(KEYBIND_MAX_ACTIONS)} actions`,
    }),
});

/**
 * The complete set of things a client may say.
 *
 * A discriminated union on `t` rather than a plain union: zod can then dispatch
 * on the tag instead of trying every branch, and the failure message names the
 * field that is wrong instead of dumping eight parallel errors.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `follow` — "TAKE ME TO THEM." THE DOOR INTO A ROOM THAT IS ALREADY YOURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An instance is opened keyed by PARTY (`realms.open(site, partyId)`), so when
 * one member walks into a breach the room that opens belongs to the whole
 * party. There was simply no way to reach it: the roamer that pulled the first
 * player in is consumed, so the tile that was the door is gone, and the second
 * player stood on the overworld watching a fight they could not join.
 *
 * ═══ IT NAMES A TARGET, NEVER A SUBJECT ═══
 * `targetId` is who to follow, exactly as `attack` and `revive` name who to act
 * on. WHO IS ASKING still comes from the session and never from the wire
 * (non-negotiable #5) — and the server's check is not "is this id in my party"
 * as a lookup on a table the client can name, but `sameParty(sender, target)`,
 * which is a question about two ids the sender does not control both of.
 *
 * A forged `targetId` therefore buys nothing: naming somebody you are not in a
 * party with is refused, and naming somebody you ARE in a party with takes you
 * to a room you were already entitled to walk into.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `shop_buy` / `shop_sell` — TWO VERBS, EACH NAMING ONE ITEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEITHER NAMES A SUBJECT, a price, or a quantity, and all three omissions are
 * the point:
 *
 *   NO SUBJECT. Who is buying comes from the session, like every other verb.
 *   NO PRICE. A frame carrying what the client thinks it owes is a frame that
 *     can be edited. The server prices it from `priceOf` and the margins, and
 *     the number on screen is something the server sent in the first place.
 *   NO QUANTITY. `Store.lua` carries `nb` for stacks; nothing here stacks, and
 *     a count would be a second thing to bounds-check for no gain.
 *
 * `shop_buy` resolves the id against THE SHELF OF THE REALM THE SENDER IS
 * STANDING IN, and `shop_sell` against the SENDER'S OWN BAG — the same shape
 * `equip` and `drop` use, and the same reason: there is no cross-inventory
 * lookup a forged id could reach into, so the worst a made-up one achieves is a
 * refusal.
 */
const ShopBuySchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('shop_buy'),
  itemId: z.string().min(1).max(ITEM_ID_MAX_CHARS),
});

const ShopSellSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('shop_sell'),
  itemId: z.string().min(1).max(ITEM_ID_MAX_CHARS),
});

const FollowSchema = z.strictObject({
  v: envelopeVersion,
  t: z.literal('follow'),
  targetId: z.string().min(1).max(ACTOR_ID_MAX_CHARS),
});

export const ClientMsg = z.discriminatedUnion('t', [
  HelloSchema,
  MoveSchema,
  TalentSchema,
  CommitSchema,
  HoldSchema,
  SaySchema,
  PointSchema,
  TalkSchema,
  ReviveSchema,
  RespawnSchema,
  ChooseClassSchema,
  DeleteCharacterSchema,
  SpendPointSchema,
  SpendStatSchema,
  PickupSchema,
  EquipSchema,
  UseSchema,
  UnequipSchema,
  DropSchema,
  ShopBuySchema,
  ShopSellSchema,
  FollowSchema,
  PartySchema,
  InspectSchema,
  SetKeybindsSchema,
  SetZoomSchema,
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
export type ClientTalk = z.infer<typeof TalkSchema>;
export type ClientRevive = z.infer<typeof ReviveSchema>;
export type ClientRespawn = z.infer<typeof RespawnSchema>;
export type ClientChooseClass = z.infer<typeof ChooseClassSchema>;
export type ClientSpendPoint = z.infer<typeof SpendPointSchema>;
export type ClientSpendStat = z.infer<typeof SpendStatSchema>;
export type ClientPickup = z.infer<typeof PickupSchema>;
export type ClientEquip = z.infer<typeof EquipSchema>;
export type ClientUse = z.infer<typeof UseSchema>;
export type ClientUnequip = z.infer<typeof UnequipSchema>;
export type ClientDrop = z.infer<typeof DropSchema>;
export type ClientShopBuy = z.infer<typeof ShopBuySchema>;
export type ClientShopSell = z.infer<typeof ShopSellSchema>;
export type ClientFollow = z.infer<typeof FollowSchema>;
export type ClientParty = z.infer<typeof PartySchema>;
export type ClientInspect = z.infer<typeof InspectSchema>;
export type ClientSetKeybinds = z.infer<typeof SetKeybindsSchema>;
export type ClientSetZoom = z.infer<typeof SetZoomSchema>;
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A RULE SAID NO, AND THE `message` IS ALREADY THE SENTENCE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every other code here names a CATEGORY the client turns into prose of its
   * own — `too_close` becomes *"too close to shoot — back off a step and fire"*,
   * which is better than anything the server could write because only the client
   * knows which talent is pending and what its range is.
   *
   * This one is for the refusals where the opposite is true: the server already
   * holds the whole fact and the client cannot improve on it. `partyRefusalText`
   * and `respawnRefusalText` in turn-engine.ts exist for exactly that reason —
   * *"the engine's vocabulary is a tag and the player's is a sentence"* — and
   * *"that party is full (6)"* needs the number, which lives on the server.
   *
   * MEASURED, AND THIS IS WHY IT EXISTS: those sentences were being written,
   * sent, and thrown away. Party and respawn refusals rode `not_your_turn`, so
   * a player who invited themselves read *"not your turn yet — the clock has not
   * asked you"* — confidently wrong, about a system they were not using — while
   * *"you cannot invite yourself"* sat in the developer's status line.
   */
  Refused: 'refused',

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

  // -------------------------------------------------------------------------
  // v10 ADDED NO MEMBER HERE, AND THE ABSENCE IS DELIBERATE.
  //
  // Every way the four loot verbs are refused reuses one of the codes above.
  // `bad_message`: nothing on this tile, an item id that is not in your bag, an
  // empty slot, an item you already own, a bag that is full, an id this build
  // has never heard of. `illegal_move`: a body that may not act on the world at
  // all right now — Downed, Erased, or standing where a drop cannot land.
  //
  // src/shared/version.ts records at 2 -> 3 that a NEW `ErrorCode` INDEPENDENTLY
  // FORCES A BUMP (a v2 client renders an unknown code as raw text), and :192-197
  // and :250-256 are two later passes deliberately declining for that reason. The
  // discipline is to keep a bump entry down to ONE stated reason; v10's reason is
  // the `ground` frame, and a `no_such_item` member would have forced the same
  // bump a second time over for a refusal the panel already prevents by only
  // drawing buttons for things you are holding.
  // -------------------------------------------------------------------------
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE TALENT SAID ABOUT ITSELF — and for a milestone it said it to nobody.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every talent body returns `talentDone(hits, notes)`, and the notes are the
   * half a `hits` array cannot express: the shove that ended against a wall, the
   * ally a guard actually covered, how many bodies a cross caught, who turned to
   * face the Watchman, whether a stun was shrugged off or merely shortened.
   * Sixteen `talentDone` calls across the twelve talents author them.
   *
   * `grep -rn "\.notes" src/` returned exactly ONE line — the one that sets the
   * field — and `test/` returned zero. They were produced, carried through
   * `TalentUseResult`, and read by nothing, so a Ward Rush that pinned somebody
   * against a wall logged the damage and not the pin.
   *
   * docs/game-design.md § 11's sample Record is largely made of them:
   *
   *     [Record] Rey uses Alchemic Vial -> (12,8). Cross, radius 1.
   *     [Record]   Index Glut detonates - 18 to Index Cairn.
   *
   * "Cross, radius 1." is a note, verbatim, from `alchemic_vial.ts`.
   *
   * ═══ SERVER-RENDERED, LIKE EVERY OTHER RECORD LINE ═══
   * These are finished sentences, composed where the formulas live. The client
   * never assembles one — `LogLine.lane` exists precisely so a renderer never
   * has to parse prose to know which band a line belongs in.
   *
   * OPTIONAL, so no version bump: an old client ignores a field it cannot name,
   * which this file's own history calls "textbook... precisely what does NOT
   * force a bump". Most talents author none, and absent is not an empty array.
   */
  notes?: readonly string[];
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * WHICH OF YOUR CHARACTERS THIS BODY IS, AND WHY IT HAS TO BE SAID.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A client that asked for `newCharacter: true` does not know what it got. The
   * server allocated the id, and without hearing it back the client has only one
   * thing to send on the next `hello` — `newCharacter: true` again. A dropped
   * socket, a laptop lid, a server restart: any reconnect after the resume grace
   * expires would then CREATE A SECOND CHARACTER, and a flaky evening would fill
   * the roster with strangers wearing the same name.
   *
   * So the answer travels back and the client pins it. `resumeToken` cannot do
   * this job: it says "I am the socket that just dropped" and it dies with the
   * body, while this says "I am playing Sergeant Vell" and outlives every socket.
   * Folding the two into one field would mean a character being created every
   * time a resume expired.
   *
   * ABSENT FOR AN ANONYMOUS PLAYER, who has no account and therefore no
   * character file — the same absence that means "you were not offered a roster
   * either", and the client treats it that way.
   */
  characterId?: string;
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
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO IS MID-ROUND — a subset of `whoseTurn`, and it is NOT the same as idle.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `DECISIONS.md` D1's intra-turn budget means a player can act and STILL owe a
   * decision: Ward Rush at 2 AP leaves 4, so they park again with the round
   * open. `whoseTurn` says "we are waiting on this person", which is true of
   * somebody who has not started AND of somebody halfway through a plan — and
   * the difference is the only thing a table needs to know to tell "he is
   * thinking" from "he has walked away from the keyboard".
   *
   * Without it the card for a player who has just rushed a husk looks identical
   * to the card for one who has not touched a key, and the Bell reads as
   * punishing somebody who is visibly playing.
   *
   * OPTIONAL, SO NO VERSION BUMP: an older client ignores a field it cannot
   * name and draws exactly the two states it always drew.
   */
  acting?: readonly string[];
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
 * THE VIEWER'S OWN FOUR TALENTS. Sent with `welcome`, AND AGAIN AFTER A SPEND.
 *
 * ═══ IT WAS A ONCE-PER-SESSION FRAME UNTIL v9, AND THIS DOCBLOCK PREDICTED
 *     THE DAY IT STOPPED ═══
 * At M3 the loadouts were FIXED — four talents, no trees, no talent points — so
 * one frame at `welcome` said everything there was to say, and this comment
 * recorded that talent points would make it re-sendable and that nothing would
 * have to change when they did. They landed; nothing did. The client already
 * treats the frame as a WHOLESALE REPLACEMENT of the hotbar, which is why an old
 * client's handling of a second one is correct rather than merely tolerable, and
 * why the re-send is not part of the v9 bump argument.
 *
 * IT MUST BE RE-SENT ON EVERY SPEND, not as a courtesy but because three fields
 * on `LoadoutTalent` are STALE the instant a rank changes: `range` (per-actor
 * from v9 — Fog Step's reach is its level), `level` itself, and the
 * `desc`/`descNext` diff. A panel that spent a point and did not get a new
 * loadout would draw the old ring and the old sentence over the new rank, which
 * is the exact failure the version gate exists to refuse from an old client.
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PASSIVES — A SECOND ARRAY, AND THE SEPARATION IS THE WHOLE POINT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `talents` IS THE HOTBAR: slot 1 is `talents[0]` for the whole session, and
   * the server owns that order because muscle memory is worth more than any
   * sort a renderer could impose. A passive has nothing to press, so a passive
   * in that array would be a hotbar key that does nothing — the failure ToME
   * avoids by never putting a `mode = "passive"` talent on the bar.
   *
   * MERGING THEM AND FILTERING AT THE DRAWING END would put the rule in every
   * surface that reads a loadout, and the first one that forgets ships the dead
   * key. The server keeps two lists for exactly this reason
   * (`ClassDef.passives`); flattening them here would undo that on the wire.
   *
   * THE TALENT PANEL READS BOTH, grouped by tree — from the player's side these
   * are all talents they own and can raise. Only the BAR is exclusive.
   *
   * OPTIONAL AND ADDITIVE, so no protocol bump: an older client ignores a field
   * it cannot name and draws the four buttons it always drew.
   */
  passives?: readonly LoadoutTalent[];
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

// ---------------------------------------------------------------------------
// v8 — THE CHOOSER. WHO YOU ARE ABOUT TO BE.
// ---------------------------------------------------------------------------

/**
 * ONE CLASS ON THE PICKER, as a player deciding between three sees it.
 *
 * ═══ THE ORDER OF THE FIELDS IS ToME'S BIRTHER, REDUCED ═══
 * `Birther.lua:131-143` builds the subclass list as `display_prop="name"` rows
 * (:132) carrying a 32px icon merged by `on_drawitem` (:137-142) off
 * `setSubclassIcon` (:46-55), and the list's own `select` callback (:135) pushes
 * the highlighted item's `desc` into the side pane through `updateDesc`
 * (:516-519). NOT `:123` — that line is the RACE TreeList's identical
 * `display_prop` row (the list opens at :122), and races are precisely what the
 * paragraph below says this frame leaves out. So: a face, a name, prose, and then
 * the numbers that actually separate the three. Everything ToME puts there that
 * this game does not have — stat rolls, races, difficulty, permadeath — is
 * absent rather than sent empty.
 *
 * ═══ `sprite` AND `portrait` ARE ASSET KEYS THAT ALREADY EXIST ON DISK ═══
 * The same contract as `ActorView.sprite`, `LoadoutTalent.icon` and
 * `TurnActor.portrait`: a KEY, never a path, so re-cutting the art cannot
 * invalidate anything and the server never learns a filename.
 *
 * NO KEY HERE MAY BE DERIVED FROM A CLASS NAME. ToME derives its own by
 * mangling (`t.name:lower():gsub("[^a-z0-9]", "_")`, Birther.lua:47-48) and
 * survives a miss because it ships `unknown_32_bg.png` as a fallback. This
 * project has no such asset and cannot add one — client/public/assets/ is
 * gitignored wholesale and an unresolved key renders as the LOUD violet
 * missing-asset box, on a bare clone, on the first screen a new player sees. So
 * both keys are carried from the authored `ClassDef` (its `sprite`) and from the
 * projector's existing `PORTRAIT_BY_CLASS` table, which is keyed by exactly
 * these ids. Renaming a class is then a content edit that breaks a lookup
 * loudly, not one that silently starts asking for a file that was never cut.
 *
 * `talents` is the four-slot loadout IN HOTBAR ORDER, the same `LoadoutTalent`
 * the hotbar already draws — reused rather than redeclared, so the icons on the
 * card are the icons on the buttons and the two cannot drift into showing
 * different talents for the same class.
 */
export type ClassOptionView = {
  /** The authored class id. What a `choose_class` frame names. */
  readonly id: string;
  /** "The Watchman". The display name, already as the fiction spells it. */
  readonly name: string;
  /** One or two sentences of identity. `ClassDef.description`, verbatim. */
  readonly description: string;
  /** The map token, e.g. `chr_player_watchman_s`. An asset KEY. See above. */
  readonly sprite: string;
  /** The face, e.g. `icon_character_the_watchman`. An asset KEY. See above. */
  readonly portrait: string;
  /** Starting and maximum hit points. The first number anybody compares. */
  readonly maxHp: number;
  /** Which pool this class spends, and how much of it it starts with. */
  readonly resource: ResourceView;
  /** EXACTLY FOUR, in hotbar order. The same shape the hotbar already draws. */
  readonly talents: readonly LoadoutTalent[];
};

/**
 * "PICK ONE." Sent to a player who has no class on file, and to nobody else.
 *
 * ═══ IT IS A `ViewerMsg`, AND THAT IS THE ENFORCEMENT ═══
 * WHETHER A GIVEN SOCKET OWES A CHOICE IS TRUE FOR EXACTLY ONE PERSON. This is
 * the same argument that put `turn` in that union at v5 and `party_state` at v6:
 * the CONTENT here is not secret — the three classes are public, and everyone
 * will see all three eventually — but there is no shape of this frame that is
 * correct for two recipients, because for everybody else the correct frame is no
 * frame at all. Broadcast it and a table of four returning Watchmen is handed a
 * modal chooser over the map, at the barrier, mid-fight.
 *
 * Membership of `ViewerMsg` is what makes `broadcast(classOptionsMsg)` a BUILD
 * FAILURE rather than a rule somebody has to remember while adding the seventh
 * viewer frame. `BroadcastMsg` is `Exclude`-derived, so this is one line here.
 *
 * ═══ IT IS AN OFFER, NEVER A COMMAND, AND IT IS NOT THE DECISION ═══
 * The client draws it; the SERVER decides. A `choose_class` naming an id that is
 * not in this list is refused by the server's own lookup, so a patched client
 * that ignores the frame entirely gains nothing — the options are a courtesy to
 * the renderer, not the validation.
 *
 * Sent in the `hello` block beside the loadout and the first `turn`, and sent
 * exactly once: there is no "the chooser is closed now" frame, because the
 * server's answer to a second choice is a refusal and the client's answer is to
 * stop drawing the picker when its own `choose_class` is acknowledged by the
 * class actually changing.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          ONE CHARACTER OF THE SELECT SCREEN, AS THE PLAYER SEES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A VIEW AND NOT A FILE. `CharacterHeader` in `persist/saves.ts` is what is on
 * disk; this is what a row says. The two differ on purpose in one place — the
 * class arrives RESOLVED to its display name, because a select screen showing
 * `watchman` has leaked an id at the player, and the client has no registry to
 * turn one into "The Watchman" without importing content it does not otherwise
 * need.
 *
 * NO OWNER ID, EVER. The rows are the viewer's own characters by construction —
 * the server looked them up under the account it verified — so an owner field
 * would put a Discord snowflake on the wire to prove something the frame's
 * existence already proves.
 */
export type CharacterRow = {
  /** What `hello.characterId` must carry to play this one. */
  id: string;
  name: string;
  /** RESOLVED for display. Absent when this build no longer has the class. */
  className?: string;
  level: number;
  /** Cases closed, against `cases` on the frame. */
  filed: number;
  money: number;
  /** ISO-8601, or absent for a character whose file could not be read. */
  lastPlayed?: string;
  /**
   * FALSE MEANS "THERE, AND THIS BUILD WILL NOT PLAY IT".
   *
   * Drawn and refused rather than omitted. A roster that silently drops a
   * damaged save tells a player their character was DELETED — and the first
   * thing they will do about it is make a new one and let the autosave write
   * over the directory they were trying to recover from.
   */
  playable: boolean;
  /** Why not, in words the row can print. Absent when `playable`. */
  refusal?: string;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   `roster` — WHO YOU COULD BE TONIGHT. THE FRAME THAT MEANS "NO BODY YET".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SENT INSTEAD OF THE WORLD, NOT ALONGSIDE IT. A socket that receives this has
 * no actor: nothing was added to the overworld, no `welcome`, no `realm`, no
 * `state`. That is the whole reason the select screen is safe — a player sitting
 * in a menu is not a token standing in a field for a monster to walk up to, and
 * "play one at a time" is enforced by there being exactly one body per socket
 * and none at all before a choice.
 *
 * ONLY EVER TO A VERIFIED SOCKET. An anonymous player has no account to hold a
 * roster, so they join straight away exactly as they always have; showing them
 * an empty select screen would be a menu they can never fill.
 */
export type RosterMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'roster';
  characters: readonly CharacterRow[];
  /**
   * The size of the whole case file, so a row can read "3 of 27" without the
   * client hard-coding a number that changes when content does. Same value
   * `progress.cases` carries, for the same reason.
   */
  cases: number;
  /**
   * Whether "new character" is offered. FALSE AT THE CAP, and the client draws
   * the reason rather than a button that fails — a menu whose only affordance
   * silently does nothing is worse than one that explains itself.
   */
  canCreate: boolean;
  /** How many this account may own, so the screen can say why. */
  max: number;
};

export type ClassOptionsMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'class_options';
  /**
   * NEVER EMPTY. A player owed a choice with nothing to choose from is a server
   * with no content loaded, which is a startup failure and not a frame.
   * Authored order, and it is stable — a card that moves between two frames is a
   * card somebody misclicks, and this one is irreversible.
   */
  options: readonly ClassOptionView[];
};

// ---------------------------------------------------------------------------
// v9 — THE LEDGER, AND THE POINT NOBODY ELSE IS TOLD ABOUT
// ---------------------------------------------------------------------------

/**
 * THE VIEWER'S OWN PROGRESS: what level they are, how far into it, and how many
 * talent points are sitting unspent in their hand.
 *
 * ═══ IT IS A `ViewerMsg`, AND THAT IS ENFORCEMENT RATHER THAN ETIQUETTE ═══
 * `unspent` IS INTENT. "Ren is holding a point back" is a statement about a
 * decision somebody has not made yet, and this protocol has withheld exactly
 * that class of fact since M3 — it is the same argument that made `cooldowns`
 * viewer-private (see `ViewerMsg` below): another player's cooldowns tell you
 * which button they are saving for the boss, and an unspent point tells you they
 * are waiting to see which talent the next fight punishes. Talking about it in
 * voice is the game. Reading it off a HUD is not, and a party panel that showed
 * everyone's banked points would turn a private judgement into a queue of people
 * telling each other what to buy.
 *
 * SO IT IS NOT A FIELD ON `TurnActor` AND NOT A FIELD ON `PartyStateMember`,
 * which is where it would most naturally have gone. Both of those travel to the
 * whole party by construction, and there is no version of `unspent` that is
 * correct for two recipients. Membership of `ViewerMsg` makes
 * `broadcast(progressMsg)` a BUILD FAILURE — `BroadcastMsg` is `Exclude`-derived
 * — rather than a rule somebody has to remember at 1 a.m.
 *
 * ═══ WHY `xpToNext` TRAVELS EVEN THOUGH THE CLIENT COULD COMPUTE IT ═══
 * `expChart` lives in src/shared/progression.ts and IS importable by the browser
 * — deliberately, and that file's docblock argues it at length: an xp bar cannot
 * disagree with the server about whether something died, which is what banished
 * scale.ts from the client bundle. So the denominator is genuinely computable
 * there. It is on the wire anyway for one reason: AT THE CAP THERE IS NO NEXT
 * LEVEL, and a client deciding for itself whether to draw a full bar would need
 * `MAX_CHARACTER_LEVEL` — a second copy of an authored number in the browser,
 * the very thing `maxLevel` on `LoadoutTalent` exists to avoid. The server knows
 * where the ceiling is; it says so here, and the renderer draws what it is told.
 *
 * ═══ WHAT IS DELIBERATELY ABSENT ═══
 * NO `pendingLevels`. It is internal scheduler bookkeeping (see `PlayerActor` in
 * src/server/engine/actor.ts): between a kill and the next base-clock pass it is
 * briefly non-zero, and a panel drawing it would flicker a point that does not
 * exist yet and cannot be spent. NO total/cumulative xp either — `xp` is
 * PER-LEVEL, because `gainExp` subtracts the threshold on the way past
 * (ActorLevel.lua:104), so it is already the bar's numerator with no arithmetic.
 */
export type ProgressMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'progress';
  /** 1..`MAX_CHARACTER_LEVEL`. The character level, not a talent's. */
  level: number;
  /**
   * XP INTO THE CURRENT LEVEL, never a running total. The bar's NUMERATOR.
   * At the cap it keeps climbing rather than being zeroed, which is what lets a
   * level-10 bar sit full instead of flicking back to empty after every kill.
   */
  xp: number;
  /**
   * The bar's DENOMINATOR: `expChart(level + 1)`. See the docblock for why this
   * travels rather than being recomputed, and what the cap does to it.
   */
  xpToNext: number;
  /**
   * TALENT POINTS IN HAND. The `+` buttons are live exactly while this is > 0.
   *
   * It is a DERIVED number on the server — every point ever granted at this
   * level minus every raw point spent (`totalPointsAtLevel` is the ledger) —
   * and it is sent as a fact rather than as its two operands, because a client
   * doing that subtraction itself would need the whole spend history.
   */
  unspent: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SECOND PURSE. `unused_generics` — Actor.lua:3750, :3752.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Spendable only on a `generic/` tree, where `unspent` above is spendable only
   * on a class one. Both travel, because a panel showing one number could not
   * explain why a `+` the player can plainly see is refused.
   *
   * A SEPARATE FIELD RATHER THAN A SUM, for the reason `unspent` gives about
   * itself: a client doing the arithmetic would need the whole spend history —
   * and two purses cannot be recovered from one total at all.
   */
  unspentGenerics: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MUCH OF THE GAME THIS CHARACTER HAS FINISHED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `filed` of `cases` — see `world/casefile.ts`. It rides on THIS frame rather
   * than a new one because it is the same kind of fact as `level` and `xp`: a
   * per-character progress number, unicast, absolute, and re-sent whenever it
   * changes. A second frame would be a second thing to keep in step.
   *
   * ═══ WHY A COUNT AND NOT THE LIST ═══
   * "Which ones are left" is a question about PLACES and the world map already
   * answers it — a closed case is dimmed there, in position, with its danger
   * grade still readable. A list of seventeen names with no coordinates would be
   * a worse version of a screen that exists. What the map cannot say is HOW
   * MANY, because you would have to count dots.
   *
   * BOTH ADDITIVE AND OPTIONAL, so no protocol bump. A client that does not know
   * them draws the sheet it always drew.
   */
  filed?: number;
  /** How many there are to close. Read off the registry — never a literal. */
  cases?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OTHER HALF OF A LEVELUP — ATTRIBUTE POINTS IN HAND, AND WHERE THEY WENT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME grants three a level (`Actor.lua:3748`) and its levelup screen shows
   * both numbers at once: what you have to spend, and what each attribute is at.
   * Neither is derivable client-side — a value is the class sheet plus spent
   * points plus gear plus passives, folded by `recomposeCombat` — so both travel.
   *
   * VIEWER-PRIVATE, like `unspent` above and for the same reason: a point in
   * hand is INTENT, and this protocol has withheld intent since v9.
   *
   * OPTIONAL, so adding them forces no version bump and a client can outlive a
   * server that never sends them. Absent means "this build has nothing to
   * spend", which draws no column rather than a column of zeroes.
   */
  unspentStats?: number;
  /**
   * THE SIX, AS COMPOSED. Short codes because they are ToME's own
   * (`load.lua:182-189`) and a player who knows that game reads them without a
   * legend; the screen spells them out beside these.
   */
  stats?: {
    str: number;
    dex: number;
    con: number;
    mag: number;
    wil: number;
    cun: number;
  };
};

// ---------------------------------------------------------------------------
// v10 — THE FLOOR, AND THE BAG
// ---------------------------------------------------------------------------

/**
 * EVERYTHING ON THE FLOOR. COMPLETE AND ABSOLUTE, exactly like `ProjectilesMsg`
 * and `EffectsMsg`.
 *
 * AN EMPTY ARRAY MEANS THE FLOOR IS CLEAR. That is a CLAIM the server is making,
 * not the absence of a claim — which is why the frame is still sent when the last
 * item is taken, and why a client must replace its whole floor table on every one
 * rather than merging.
 *
 * ═══ THE CONTRACT IS `ProjectilesMsg`'S, WORD FOR WORD ═══
 * That frame's own note reads: "the orb is simply PRESENT in a frame that is
 * COMPLETE AND ABSOLUTE, the same rule `EffectsMsg` follows and for the same
 * reason: a client that dropped one patch would otherwise show a phantom orb
 * forever, and a phantom orb teaches the wrong counterplay." Substitute the noun
 * and the sentence is still true, and the consequence is worse rather than
 * milder: a phantom floor item sends somebody walking the length of the map,
 * through a fight, to a tile with nothing on it — and because the pile is UNOWNED
 * and first pickup wins, what they will conclude is that a friend took it. The
 * one failure mode this design is least able to afford is the one that makes the
 * party argue.
 *
 * ═══ A SNAPSHOT, NOT AN EVENT, FOR `ProjectileView`'S REASON ═══
 * There is no `TurnEvent` variant for a drop and there must not be one. Events
 * are for INSTANTS: the client applies a whole sweep in one synchronous pass and
 * clears its markers a quarter of a second later. A coat on the floor is a
 * standing fact that outlives the turn that produced it, frequently outlives the
 * monster that dropped it, and is still there three fights later. The engine
 * already agrees — `GameEvent.spilled` and `SweepStep.spill` are dropped at the
 * wire in two named switch arms in src/server/turn-engine.ts, each carrying the
 * written argument that the floor is a snapshot frame's job.
 *
 * ═══ IT IS A BROADCAST TODAY AND MUST MOVE TO `ViewerMsg` WITH PER-PLAYER FOV ═══
 * Verbatim the caveat `ProjectilesMsg` carries, and it applies here more sharply.
 * A floor item's tile is a POSITION, and a position is exactly the class of fact
 * the FOV projector exists to gate: a coat appearing in an unexplored room says
 * something died in it. Fog of war is still level-wide (there is one `LevelView`
 * and one actor list for everybody), so shipping this to the room leaks nothing
 * that `ActorView` does not already leak. THE DAY PER-PLAYER FOV LANDS, THIS
 * FRAME MOVES INTO `ViewerMsg` IN THE SAME COMMIT — `BroadcastMsg` is
 * `Exclude`-derived, so that move is one line here and a compile error everywhere
 * it was being broadcast. src/server/view/projector.ts's header states the same
 * accepted-leak argument from the server's side, and names the three frames
 * (actors, projectiles, ground) that move together when FOV lands.
 *
 * ═══ IT IS BROADCAST RATHER THAN PER-PLAYER FOR A SECOND, POSITIVE REASON ═══
 * The pile is unowned and shared. Per-player instancing would triple the
 * effective drop rate and delete the sentence "you take it, I've got a coat",
 * which is the entire social point of a game played in a voice channel. One floor,
 * one frame, everybody looking at the same thing.
 */
export type GroundMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'ground';
  /**
   * EVERY item on the floor, in the world's own stable insertion order — which is
   * also the order `itemsAt` returns and therefore the order `pickup` consumes
   * (src/server/world/world.ts:516-522: "PICKUP TAKES INDEX 0"). The client must
   * not sort it: the top of the pile has to mean the same thing to the server, to
   * the prompt the player reads, and to a replay.
   */
  items: readonly GroundItemView[];
};

/**
 * ONE THING ON A SHOP'S SHELF, WITH BOTH PRICES ALREADY WORKED OUT.
 *
 * ═══ THE NUMBERS ARE THE SERVER'S, AND THE CLIENT MUST NOT DERIVE THEM ═══
 * `buy` and `sell` are whole gold, computed from `priceOf` and the two margins
 * (content/shops.ts). A client that recomputed them would be a second copy of
 * the economy: the first thing to drift would be the ~24:1 spread, which is the
 * single number that stops a shop being farmable, and it would drift silently
 * because a wrong price still LOOKS like a price.
 *
 * Same rule `GroundItemView.tier` states for the floor marker, applied to the
 * thing a player is about to spend on.
 */
export type ShopItemView = {
  /** The instance id, and what `shop_buy` names. */
  readonly itemId: string;
  /** Already through the display-name filter; egos folded in. */
  readonly name: string;
  /** A manifest asset key, never a path. */
  readonly icon: string;
  readonly tier: ItemTier;
  /** What it costs YOU, in whole gold. Never zero — nothing here is free. */
  readonly buy: number;
  /**
   * What the shop would pay for one of these, in whole gold.
   *
   * SHOWN ON THE SHELF ON PURPOSE, even though you cannot sell a thing you have
   * not bought. It is how a player learns the spread without being told it, and
   * learning it is what makes the decision to sell a decision rather than a
   * shrug.
   */
  readonly sell: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ON THE SHELVES. A WHOLE-LIST REPLACEMENT, LIKE THE FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sent to everybody standing in a realm that HAS a shop, and never otherwise —
 * a client that has had no `shop` frame has no shop, which is how it knows not
 * to offer the tab.
 *
 * NOT A `ViewerMsg`, unlike `inventory`. A shelf is the same shelf for
 * everybody in the room: two players looking at the same shop see the same four
 * coats at the same prices, and one of them buying one is a fact the other
 * needs immediately. `CarriedItemView.compare` is what makes the inventory
 * viewer-private; nothing here is a delta against anybody's doll.
 */
export type ShopMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'shop';
  /** The shop's name, for the tab. "Threadneedle Row". */
  name: string;
  /**
   * EVERY item on the shelf, in the shop's own order — what it stocked first
   * comes first, so a shelf reads as a history rather than as a leaderboard.
   * The client must not sort it: `shop_buy` names an id, and two identical
   * coats are two entries.
   */
  stock: readonly ShopItemView[];
};

/**
 * ═══ WHY THE PURSE IS NOT ON THIS FRAME, THOUGH THE TAB NEEDS IT ═══
 * A first draft carried `money` here so the shop tab could grey what you
 * cannot afford. That was wrong twice over: a purse is per-VIEWER and this
 * frame is a broadcast, so it would have been one player's balance sent to
 * everybody in the room — and it would have been a second copy of a number
 * `InventoryMsg` already carries, free to disagree with it.
 *
 * The tab reads the purse off the inventory frame instead, and a transaction
 * sends BOTH, which is what keeps affordability from drawing one frame stale.
 */

/**
 * WHAT YOU ARE CARRYING, WHAT YOU ARE WEARING, AND WHAT SWAPPING WOULD DO.
 *
 * ONE FRAME FOR BOTH HALVES, WHICH IS THE PORT AND NOT A SIMPLIFICATION. ToME's
 * `SHOW_EQUIPMENT` is literally an ALIAS of `SHOW_INVENTORY`
 * (tome/class/Game.lua:2192 — `SHOW_EQUIPMENT = "SHOW_INVENTORY"`), and both open
 * the same combined `ShowEquipInven` dialog: a doll on one side, a bag on the
 * other, and the comparison drawn between them. Two frames would let the two
 * halves arrive a pump apart and render a comparison against a slot whose
 * contents had already changed.
 *
 * ═══ THE COMPARISON ROWS ARE COMPUTED HERE, ON THE SERVER, AND THAT IS NOT
 *     NEGOTIABLE ═══
 * See `CarriedItemView.compare`, and the v10 paragraph at the head of this file
 * for the upstream citation. The short version: eslint blocks src/client/** from
 * importing shared/checkhit, shared/scale and shared/energy, and
 * src/client/ui/tooltip.ts:6-16 exists to stop a second copy of a combat formula
 * reaching the browser. A client subtracting two armour numbers would be that
 * second copy, and it would be WRONG rather than merely redundant, because
 * `rescaleCombatStats` floors.
 *
 * ═══ IT IS A `ViewerMsg`. See the note on that union below. ═══
 * Sent when the sender's own bag or doll changes — a pickup, an equip, an
 * unequip, a drop, a restore at join — and not on every pump. It is low-frequency
 * by construction, which is what lets it be a wholesale replacement of both
 * halves rather than a delta.
 */
export type InventoryMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'inventory';
  /**
   * THE BAG. Complete and absolute; an empty array means you are carrying
   * nothing, which is the normal state for most of a delve.
   *
   * IT IS A SET, NOT A BAG OF DUPLICATES, and the constraint comes from
   * persistence rather than from here: `carried` is saved as a list of ids with
   * no per-instance handle, so src/server/persist/saves.ts keeps the first
   * occurrence and drops later ones. The pickup verb refuses an id the actor
   * already owns for that reason — otherwise the loss presents as "my second cap
   * vanished when I relogged" and the bug looks like it is in persistence when it
   * is in pickup.
   */
  carried: readonly CarriedItemView[];
  /**
   * THE PAPER DOLL. Slot -> what is in it; a slot with nothing in it is ABSENT
   * rather than present-and-null, because absent and null would be two spellings
   * of empty and the second one always turns up in a hand-rolled client.
   *
   * `Partial<Record<Slot, ...>>` is a mapped type over a finite literal union, so
   * `noUncheckedIndexedAccess` is not what is adding the `| undefined` here — the
   * `Partial` is, deliberately, and a renderer must handle it.
   */
  equipped: Readonly<Partial<Record<Slot, ItemView>>>;
  /**
   * GOLD. A whole number, never negative — `PlayerActor.money`, straight
   * through.
   *
   * ON THE INVENTORY FRAME rather than on a frame of its own, because a purse
   * changes for exactly the reasons a bag does (you picked something up, you
   * bought something, you sold something) and a second frame would be a second
   * thing that can arrive out of order with the first. The panel that lists
   * what you are carrying is also where a player looks to find out what they
   * can afford.
   *
   * REQUIRED, not optional: every character has a purse, exactly as every
   * character has a level, so there is no "this producer cannot say" case to
   * spell — and an optional field here would let a renderer quietly draw
   * nothing instead of drawing zero.
   */
  money: number;
};

// ---------------------------------------------------------------------------
// THE KEYMAP, COMING BACK
// ---------------------------------------------------------------------------

/**
 * WHAT THE SERVER HAS STORED FOR THIS PLAYER'S KEYS, AND WHETHER IT WILL LAST.
 *
 * Sent twice and only twice: unconditionally in the `hello` block, beside
 * `progress` / `class_options` / `party_state` / `inventory`, for the reason
 * every frame in that block is unconditional — this socket has seen nothing yet
 * — and again as an ECHO after every accepted `set_keybinds`.
 *
 * ═══ THE ECHO IS THE POINT, NOT AN ACKNOWLEDGEMENT ═══
 * The Keys screen renders THIS frame rather than the map the client just sent,
 * so what a player sees is what the SERVER stored. Without it a screen would be
 * drawing its own optimism: a map the server bounced, trimmed or never received
 * would still be on display, and the next reconnect is where the player would
 * find out. The server is authoritative (CLAUDE.md non-negotiable 4) about
 * preferences too.
 *
 * ═══ `persisted` IS THE FRAME TELLING AN ANONYMOUS PLAYER THE TRUTH ═══
 * A body with no verified owner has no character file — `openCharacter` binds
 * only somebody a server-side `GET /users/@me` has named, and net/gateway.ts
 * spells out why minting an id for the purpose would scatter orphan directories
 * nobody can reclaim. So an anonymous socket's rebinds live on its body for as
 * long as the body lives and are lost at recall. THAT IS THE SAME TREATMENT
 * anonymous play already gets for hp, cooldowns and the class picker, and
 * refusing rebinds instead would break plain-browser development and
 * tools/e2e-m1.mjs. `false` here is what lets the screen say "not saved: this
 * session is not signed in" instead of leaving the first developer to discover
 * a working feature looks broken.
 *
 * ═══ IT IS A `ViewerMsg`, AND THE REASON IS `class_options`' ═══
 * See the note on that union below. Nothing here is secret — a keymap is not
 * intent the way a cooldown is — but THERE IS NO VERSION OF THIS FRAME THAT IS
 * CORRECT FOR TWO RECIPIENTS, because a keymap is true for exactly one person.
 * Membership makes `broadcast(keybindsMsg)` a build failure.
 *
 * ═══ AND IT MUST NOT RIDE `welcome`, WHICH IS THE TEMPTING WRONG MOVE ═══
 * `WelcomeMsg` is absent from `ViewerMsg` and is therefore a `BroadcastMsg`.
 * Hanging a private preference off it would make `broadcast(welcome)` type-legal
 * for a frame that now carries one player's keys — silently disarming the exact
 * enforcement `BroadcastMsg = Exclude<ServerMsg, ViewerMsg>` exists to provide.
 * A separate frame costs one `send` and keeps the type system doing the work.
 */
export type KeybindsMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'keybinds';
  /**
   * ACTION ID -> KEY STRINGS. Complete and absolute, exactly as the client sent
   * it and exactly as the disk holds it; an empty object means "no overrides,
   * every action on its default".
   *
   * ACTION IDS THIS BUILD NO LONGER BINDS SURVIVE IN HERE. Neither the wire nor
   * the persist layer has an action table to check against — the table is
   * src/client/input/keys.ts — so a renamed-then-restored action comes back with
   * its keys, and THE CLIENT OWNS THE DROP: it must ignore an id it cannot bind
   * rather than expecting the server to have filtered it.
   */
  binds: Readonly<Record<string, readonly string[]>>;
  /**
   * Will these binds still be here tomorrow? True for a verified player on a
   * server with persistence wired in; false for an anonymous socket and for a
   * build with no save layer. See the docblock — this is the field that stops a
   * working feature reading as broken.
   */
  persisted: boolean;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * YOU ARE SOMEWHERE ELSE NOW. The frame that carries a new map mid-session.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS NOT A SECOND `welcome`. `welcome` was the only frame carrying a
 * `LevelView`, so re-sending it is the obvious way to deliver a new map — and
 * it is wrong, because `welcome` is also the RESUME frame. The client's handler
 * for it clears the case log, the party panel, the invite deadlines, the floor,
 * the bag, the orbs in flight, the pings, the badges, the turn strip and the
 * Bell, and it is entitled to: a resume genuinely starts a new session, and the
 * case log's `seq` restarts with it.
 *
 * Walking through a door is not a new session. Losing the transcript of the
 * conversation you were having, and the bag you were carrying, because you
 * stepped into the office would be a bizarre thing for a door to do.
 *
 * So this frame carries exactly what CHANGES when a body moves between realms —
 * the map, who is on it, and where you are — and says nothing about everything
 * that does not, which the client therefore keeps.
 *
 * VIEWER-SCOPED, and that is not an optimisation. A realm change is true for
 * exactly one person: the map in it is the map THEY are now looking at. Sent to
 * the room, it would hand everybody else a level they are not standing on, and
 * `ViewerMsg` membership makes `broadcast(realmChangeMsg)` a compile error
 * rather than a rule somebody has to remember at one in the morning.
 */
/**
 * A place you can walk into, as the client needs to DRAW it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SITES USED TO BE SERVER-ONLY, AND THAT WAS WRONG.
 * ═══════════════════════════════════════════════════════════════════════════
 * `AuthoredMap.sites` was deliberately kept off the wire, on the reasoning that
 * "a site's destination is a fact a player earns by walking onto it". That is a
 * good rule for a DUNGEON and a terrible one for an overworld: it left the map
 * with no towns, no dungeon mouths and no landmarks on it at all, so the only
 * way to find anywhere was to walk the whole region hoping to tread on it.
 *
 * An overworld's entire job is telling you where things are. FF7 and ToME both
 * draw their settlements on the world map; the discovery is in the JOURNEY, not
 * in the existence of the destination.
 *
 * `marker` is the ART FAMILY, not the site id: several sites share a marker and
 * a client that meets an unknown one falls back to the generic gate rather than
 * failing. `name` is prose and is shown — the id never reaches a player.
 */
export type SiteView = {
  readonly x: number;
  readonly y: number;
  /** `village` | `town` | `city` | `mine` | `ruin` | `gate` | `stair` | ... */
  readonly marker: string;
  readonly name: string;
  /**
   * A CREATURE SPRITE, when this marker is something alive.
   *
   * Present on a roamer, absent on a place. A settlement is drawn as a marker
   * lying on the map; a wandering danger is drawn as a TOKEN — bottom-anchored,
   * with a hostile ring under it — because it is the same kind of thing as the
   * creature it becomes and has to read that way at a glance.
   *
   * The first version had no such field, so roamers borrowed the breach marker
   * and looked like doors. Reported from play as "the enemies do not seem to
   * have enemy assets", which was exactly right: they had a door's.
   */
  readonly sprite?: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS PLACE'S OWN SILHOUETTE, WHERE ONE EXISTS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `marker` says what KIND of place this is and the client draws it from a
   * family — three size tiers for village/town/city, told apart by outline. That
   * makes every city look like every other city, and a player reported the
   * consequence in as many words: it is hard to tell the area you are standing in
   * is a town.
   *
   * A landmark is the same 32x32 slot with this place's own art in it —
   * Alderbrook's is a clocktower and a civic gate rather than a generic
   * settlement. Sent as a SPRITE ID for the same reason `sprite` above is: the
   * client already owns the question of what art exists, and a site whose art is
   * missing falls back to its family marker rather than drawing nothing.
   *
   * OPTIONAL AND ADDITIVE, so no protocol bump — `site:redaction` has no
   * landmark and is not meant to.
   */
  readonly landmark?: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW BAD IS IT IN THERE — one word, and the map had no way to say it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `quiet` | `restless` | `dangerous` | `grim`, from `content/delve.ts`'s
   * `dangerWord`, which weighs a delve's roster (an elite counts for more than
   * a wraith, a wraith for more than a body) against the top of its population
   * band. It is already spoken aloud on arrival — "The Drowned Chapel —
   * north-east, 18 tiles · dangerous · hard alone" — and then scrolls away.
   *
   * The world map is where that sentence belongs permanently, and it was
   * thirteen identical gold squares: a player pressed M to ask "where do I go"
   * and got a field of dots with no way to tell Saint's Rest (an empty safe
   * room) from the Outer Index. That is the one question a world map exists to
   * answer.
   *
   * ABSENT ON ANYTHING THAT IS NOT A DELVE — a town has no danger grade and
   * inventing "quiet" for one would imply the scale applies to it. Optional, so
   * no version bump: an old client ignores a field it cannot name.
   */
  readonly danger?: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS MARKER IS A WAY OFF THIS MAP, NOT A ROOM ON IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `danger` is the grade of the room behind a marker, and it is ABSENT for
   * anything that is not a delve — a town has nothing to warn about, and the
   * renderer draws a gradeless marker in gold. That was a complete rule while
   * every gradeless marker was a settlement.
   *
   * It stopped being one when a second landmass landed. The door to the
   * Redaction is not a delve, so `specFor` correctly answers nothing, so the
   * entrance to the hardest country in the game drew in the SAME INK AS
   * ALDERBROOK — and a player who has learned that gold means a town would read
   * it as one.
   *
   * ADDITIVE AND OPTIONAL, so no protocol bump: a client that does not know the
   * field draws exactly what it drew before.
   */
  readonly crossing?: boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE VIEWER HAS ALREADY CLOSED THIS ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * PER VIEWER, like `hidden`'s fog filter and unlike everything else on this
   * type: `danger` and `crossing` are facts about the place, and this is a fact
   * about the person looking. Two players standing on the same tile see the
   * same map with different marks on it, which is correct — a case file belongs
   * to a character.
   *
   * ADDITIVE AND OPTIONAL, so no protocol bump. See `world/casefile.ts`.
   */
  readonly filed?: boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHO OF YOUR PARTY IS BEHIND THIS DOOR RIGHT NOW.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `partyMarks` puts a mark on the map for every member standing on it, and
   * deliberately leaves out anybody inside an instance because their
   * coordinates belong to another level. That is honest and it is half a
   * picture: the information exists — the party pane names their place — and the
   * map, which draws all seventeen doors, is where "where" is actually a
   * direction.
   *
   * ═══ THE SERVER ANSWERS THIS, AND THE JOIN IS WHY ═══
   * The obvious client-side join is `away.place === site.name`, and it was
   * MEASURED and rejected: all twenty-two realms carry their site's name, and
   * six of them are DUPLICATES. `redaction:underworks` is "The Underworks" and
   * so is `underworks` — different landmasses, one string. A name join would
   * mark the Alderbrook door for a friend standing in the Redaction, which is
   * not a missing mark but a confident lie.
   *
   * The site ID is unambiguous and only the server holds both halves — the realm
   * registry and the party table — so the join happens there and the client
   * draws what it is told, which is this protocol's whole rule anyway.
   *
   * PER VIEWER, like `filed` above: it names YOUR party and nobody else's.
   * Absent rather than empty when there is nobody, so the common case costs no
   * bytes.
   */
  readonly party?: readonly string[];
};

/**
 * One named rectangle of a region map. Inclusive bounds, matching
 * `ALDERBROOK_REGIONS` in shared/level.ts, which is where they are authored and
 * where the tiling is guaranteed.
 */
export type RegionView = {
  readonly name: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE THE LABEL GOES — AN ANCHOR, NOT A BOX.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This carried a rectangle, because the country used to BE rectangles. The
   * redesigned moor draws its regions per cell and their bounding boxes overlap
   * so heavily that one spans x 5 to 157 and another fills 17% of its own box —
   * a rectangle on this wire would put "the Long Strand" over the mountains.
   *
   * The SHAPE stays on the server, where `regionAt` needs it and the crossing
   * announcement is decided. The client needs one thing the server cannot
   * choose for it — where to draw the name — and that is this.
   *
   * TWELVE SMALL RECORDS RATHER THAN A SECOND 17,000-CELL ARRAY. The realm frame
   * already carries the tiles; doubling it to tell a renderer which country each
   * cell is in would be paying for a fact only the label needs.
   */
  readonly x: number;
  readonly y: number;
};

export type RealmMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'realm';
  /** Opaque. The client echoes nothing and stores it only to ignore stale frames. */
  realmId: string;
  /** `overworld` | `common` | `inner`. Drives HUD affordances, not rendering. */
  kind: string;
  /** What the player calls this place. Shown; keep it prose. */
  name: string;
  level: LevelView;
  actors: ActorView[];
  /** Everywhere on THIS map you can walk into. Drawn as markers. */
  sites: SiteView[];
  /**
   * WHAT THIS CHARACTER HAS EXPLORED, base64 of one bit per cell.
   *
   * Sent once, with the map it describes, and only for a realm whose fog is
   * kept — the overworld. About 2,836 characters for a 170x100 region, against
   * roughly 130 KB for the same fact as a list of cells.
   *
   * After this the CLIENT keeps revealing locally at the same radius, so
   * neither side sends anything per step. The server's copy is the one that
   * persists; this is the seed.
   */
  explored?: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE PARTS OF THIS MAP ARE CALLED. Once, on entry. No per-step traffic.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The server has named twelve regions since the crossing line landed, and the
   * table deliberately did NOT ride the wire then: *"an unused protocol field is
   * the same disease"* as a subsystem wired to nothing. It ships now because
   * something draws it — the world map, which could tell you when you ENTERED
   * the Bracken Waste and could not tell you where it was.
   *
   * OPTIONAL, SO NO VERSION BUMP, and absent on every realm but an overworld: a
   * town interior is one room with its name on the door and an arena is not
   * anywhere.
   */
  readonly regions?: readonly RegionView[];
  /** Which actor in `actors` is the recipient — the client re-centres on it. */
  selfId: string;
};

/**
 * THE MARKERS ON THIS MAP, WITHOUT THE MAP.
 *
 * `realm` carries the level, the roster and the markers together, which is
 * right when you have just arrived and wrong every time afterwards. Roamers
 * wander, so their positions change every few turns while the level under them
 * never does — and re-sending `realm` to say so ships 17,000 tiles to describe
 * a marker moving one cell.
 *
 * That was affordable at 96x64 and stopped being so the moment the region grew
 * to ToME's 170x100. The comment that accepted the cost said the fix would be a
 * `sites` frame rather than a second marker system, and this is that frame.
 *
 * ABSOLUTE, NOT A PATCH, exactly like `ground` and `projectiles`: the client
 * REPLACES its whole marker table with this. A patch protocol would need a
 * delete verb, an ordering guarantee and a resync path, to save a few hundred
 * bytes on a message that is already the cheapest thing on the wire.
 *
 * Viewer-scoped for the same reason `realm` is — these are the markers on the
 * map THIS player is standing on.
 */
export type SitesMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'sites';
  /** Which realm they belong to, so a frame in flight across a crossing is dropped. */
  realmId: string;
  sites: SiteView[];
};

export type ServerMsg =
  | WelcomeMsg
  | RealmMsg
  | SitesMsg
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
  | ClassOptionsMsg
  | RosterMsg
  | ProgressMsg
  | GroundMsg
  | ShopMsg
  | InventoryMsg
  | KeybindsMsg
  | SettingsMsg
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
 *
 * `class_options` JOINED AT v8 FOR THE SAME REASON `turn` DID, IN ITS PUREST
 * FORM. Nothing in it is secret — the three classes are public and every player
 * will end up seeing all three. It is here because WHETHER A SOCKET OWES A
 * CHOICE IS TRUE FOR EXACTLY ONE PERSON, and for everybody else the correct
 * frame is NO FRAME AT ALL. There is no version of this message that is right
 * for two recipients, so `broadcast(classOptionsMsg)` must not compile: handed
 * to the room it puts a modal chooser over the map for four returning players
 * who already have a class, at the barrier, in the middle of a fight.
 *
 * `progress` JOINED AT v9 FOR THE FIRST REASON — THE LEAK — IN THE SAME FORM
 * COOLDOWNS DID. `unspent` is INTENT: a banked talent point is a decision
 * somebody has deliberately not made yet, and "Ren is holding one back" is
 * exactly the class of fact this union has withheld since M3. `level` and `xp`
 * are not secret in themselves, and under the full-share rule the party is
 * always the same level anyway — but there is no shape of this frame that
 * carries the level without the point, and splitting it in two to make half of
 * it broadcastable would be building a leak a frame at a time. It is also why
 * `unspent` is not a field on `TurnActor` or `PartyStateMember`, both of which
 * go to the whole party by construction.
 *
 * `inventory` JOINED AT v10 FOR THE FIRST REASON, IN THE SAME FORM `progress`
 * DID. AN INVENTORY IS WHAT A PLAYER IS CARRYING AND HOLDING BACK, which is the
 * same class of fact as `unspent` at v9 and as `cooldowns` at M3: not a secret in
 * the sense of a hidden monster, but a DECISION SOMEBODY HAS NOT MADE YET. "Ren
 * is carrying a coat she has not put on" is exactly as much of a read as "Ren is
 * holding a point back" and "Mend Wounds is ready" — it says which swap she is
 * still thinking about, and under the unowned-pile rule it also says what she is
 * about to be talked out of. Talking about it in voice is the game. Reading it
 * off four HUDs is a queue of people telling each other what to wear.
 *
 * THERE IS ALSO NO SHAPE OF THIS FRAME THAT IS CORRECT FOR TWO PEOPLE, which is
 * the `turn`/`class_options` half of the argument arriving independently.
 * `CarriedItemView.compare` is a DELTA AGAINST THE RECIPIENT'S OWN DOLL: the same
 * coat compares to +4 Armour for a bare Watchman and to nothing at all for one
 * already wearing it. One shared copy would not merely leak — it would be
 * arithmetically wrong for everybody but its author, on the one screen whose
 * whole job is answering "is this better than what I have on?".
 *
 * `keybinds` JOINED FOR THE SECOND REASON ALONE, IN `class_options`' FORM. Of
 * the two faults this union guards against, only one applies: a keymap IS NOT A
 * LEAK. It says nothing about what anybody is holding for the boss, nothing
 * about a decision they have not made, and a player who reads out their own
 * bindings in voice has given nothing away — which is exactly why this entry
 * names the reason instead of gesturing at the union.
 *
 * IT IS HERE BECAUSE THERE IS NO VERSION OF THIS FRAME THAT IS CORRECT FOR TWO
 * RECIPIENTS. A keymap is true for exactly one person, in the same sense
 * `class_options` is a question owed to exactly one person and `TurnActor.isSelf`
 * is true for exactly one person. Handed to the room it would tell three other
 * players that their `w` is bound to something they never chose — and the screen
 * it lands on is the one whose whole job is answering "what does MY keyboard
 * do?". `broadcast(keybindsMsg)` must not compile.
 *
 * AND IT IS A SEPARATE FRAME RATHER THAN A FIELD ON `welcome` FOR THAT EXACT
 * MECHANISM. `WelcomeMsg` is absent from this union, so it is a `BroadcastMsg`;
 * hanging one player's preferences off it would make `broadcast(welcome)`
 * type-legal for a frame carrying per-viewer data and would quietly disarm the
 * `Exclude` below. The enforcement only works while every viewer-private fact
 * lives in a frame that is in this list.
 *
 * `ground` DELIBERATELY DID NOT JOIN, AND THE SPLIT IS THE POINT. A floor item is
 * a POSITION, which is world state and true for everybody; an inventory is a
 * holding, which is true for one person. The two arrived in the same release and
 * landed in different unions, so `broadcast(inventoryMsg)` is a COMPILE ERROR
 * while `broadcast(groundMsg)` is the correct call — which is the whole reason
 * `BroadcastMsg` is `Exclude`-derived rather than a second hand-written list.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PREFERENCES THAT ARE NOT KEYS. Currently one: how big the tiles are.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sent at `hello` beside `keybinds`, and echoed after every accepted
 * `set_zoom`. THE ECHO IS THE POINT, exactly as it is for `KeybindsMsg`: what
 * the player sees is what the SERVER stored, so a value the server bounced or
 * clamped cannot sit on screen as the client's own optimism.
 *
 * ═══ ITS OWN FRAME RATHER THAN A FIELD ON `keybinds` ═══
 * `KeybindsMsg` is the Keys screen's frame and its name would start lying. The
 * protocol already makes this argument for keeping preferences off `welcome`:
 * *"A separate frame costs one `send` and keeps the type system doing the
 * work."* Same trade, same answer.
 *
 * ═══ A `ViewerMsg`, AND THE COMPILER ENFORCES IT ═══
 * There is no version of this frame that is correct for two recipients — how
 * big one player wants their tiles is true for exactly one person — so
 * membership here makes `broadcast(settingsMsg)` a build failure.
 *
 * ═══ NO PROTOCOL BUMP, AND THE REASON IS THE FAILURE MODE ═══
 * `PROTOCOL_VERSION` moved to 11 for `RealmMsg` because a client that ignored
 * that frame would render the wrong map, silently, while the server moved its
 * body. Ignoring THIS frame costs a returning player one keypress. An old
 * client drops an unknown `t`; an old server refuses an unknown verb and the
 * preference simply does not stick. Neither corrupts anything, and both heal on
 * the next deploy, which ships client and server together.
 */
export type SettingsMsg = {
  v: typeof PROTOCOL_VERSION;
  t: 'settings';
  /** The integer zoom step, as stored. `ZOOM_MIN`..`ZOOM_MAX`. */
  zoom: number;
  /**
   * Whether the value above will outlive the tab.
   *
   * `KeybindsMsg.persisted`'s twin and for its reason: an anonymous socket has
   * no character file, so its preference lives on its body until recall. The
   * screen can then say so rather than leaving somebody to discover a working
   * feature looks broken.
   */
  persisted: boolean;
};

export type ViewerMsg =
  | LoadoutMsg
  | CooldownsMsg
  | ResourceMsg
  | TurnMsg
  | PartyStateMsg
  | InspectedMsg
  | ClassOptionsMsg
  // YOUR characters, and nobody else's. Membership here makes
  // `broadcast(rosterMsg)` a compile error rather than a rule to remember — and
  // the mistake it prevents is handing the room a list of somebody's saves.
  | RosterMsg
  | ProgressMsg
  | InventoryMsg
  | KeybindsMsg
  | SettingsMsg
  // A realm change is true for exactly one person — the map in it is the map
  // THEY are now standing on. Membership here makes `broadcast(realmMsg)` a
  // compile error rather than a rule to remember. See `RealmMsg`.
  | RealmMsg
  | SitesMsg;

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
