/**
 * The world: one level, one actor table, one turn state, and the only code in
 * the process that is allowed to change where a token stands.
 *
 * AUTHORITY. `tryMove` is the whole point of this file. The client sends a
 * DIRECTION and nothing else (see the missing-field note in protocol.ts); the
 * decision about whether that direction is legal, and what the resulting
 * coordinates are, is made here and broadcast to everyone — including the person
 * who asked. A client that patches its own renderer sees a lie for one frame and
 * then gets corrected by the next update.
 *
 * SYNCHRONOUS, AND ESLint ENFORCES IT. src/server/world/** carries the same six
 * anti-async AST selectors as the engine: no await, no Promise, no timers. That
 * synchronicity IS the mutex — a WebSocket frame cannot interleave with another
 * frame's mutation because there is no point in the middle of `tryMove` where
 * control returns to the event loop. If you ever want a lock here, the real bug
 * is that something above became asynchronous.
 *
 * DETERMINISM. The same lint block bans `Math.random` and `Date.now`. Spawn
 * placement and combat both draw from the seeded PCG32 in src/shared/rng.ts, so
 * a given seed and a given join order produce the same game on any machine.
 *
 * M2 SCOPE. Actors now carry energy, hp and control state (see
 * src/server/engine/actor.ts, which owns the actor type), the level carries a
 * turn state, and monsters exist. The scheduler in src/server/engine/ drives all
 * of it; nothing in this file knows what a turn is. Fog of war is still M3.
 *
 * DEPENDENCY DIRECTION. This file imports the actor MODEL from engine/actor.ts,
 * the projectile model from engine/projectile.ts, and `recomposeCombat` from
 * engine/effects.ts. The scheduler imports the world. One direction, no cycle,
 * and one actor type in the process rather than an engine copy that has to be
 * kept in sync with a world copy — the first field to drift would be `hp`, and
 * it would drift silently.
 *
 * ═══ THE ONE CONTENT IMPORT, AND WHY IT IS NOT THE CYCLE THE OTHER ONE WOULD BE
 * `content/resolve.ts` is imported for `resolveItem`. `content/classes.ts` is
 * still forbidden, and the note on `PLAYER_SPRITES` below says why:
 * `world -> content/classes -> engine/talents -> world` is a real cycle, closed
 * by engine/talents.ts:103's VALUE import of `hasLineOfSight` from this file,
 * and a module cycle in a project with no build step is a ReferenceError at
 * import time rather than a warning. `content/resolve.ts` reaches only
 * `content/items.ts` (which imports TYPES ONLY) and one constant from
 * `shared/protocol.ts`, so it sits at the bottom of the graph with nothing to
 * close.
 */

import { bresenham, step } from '../../shared/coords.ts';
import { createTurnClock } from '../../shared/energy.ts';
import { blocksSightAt, canWalk, makeTestMap } from '../../shared/level.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { createRng } from '../../shared/rng.ts';
import { resolveItem } from '../content/resolve.ts';
import { createMonsterActor, createPlayerActor } from '../engine/actor.ts';
import { createProjectile } from '../engine/projectile.ts';
import { recomposeCombat } from '../engine/effects.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { TurnClock } from '../../shared/energy.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { LevelView } from '../../shared/protocol.ts';
import type { Rng } from '../../shared/rng.ts';
import type { EngineActor, MonsterInit, PlayerInit } from '../engine/actor.ts';
import type { Projectile, ProjectileInit } from '../engine/projectile.ts';

/**
 * An actor as the SERVER holds it — deliberately not an `ActorView`.
 *
 * The two were the same six fields in M1 and are not remotely the same now: hp,
 * both energy clocks, cooldowns and the control flags all live on this type, and
 * none of them may reach a client except through src/server/view/projector.ts.
 * Collapsing the two types would mean the first secret field added is on the
 * wire by default, which is the wrong direction for a mistake to fall.
 *
 * The definition lives in src/server/engine/actor.ts (the engine owns the actor
 * model) and is aliased here so that every existing importer of
 * `world.ts#Actor` keeps working.
 */
export type Actor = EngineActor;

/**
 * The level's clock and combat state. One level per party, ever — two live
 * levels means two clocks and an unsolvable UX problem for a Friday night.
 */
export type TurnState = {
  /**
   * Engine ticks and completed game turns. Ten ticks to a turn; both numbers
   * are carried explicitly so nobody has to guess which one a bare `turn` meant
   * (ToME's own `game.turn` counts TICKS, hence its `self.turn % 10`).
   */
  readonly clock: TurnClock;
  /**
   * Turns of engagement remaining. Above zero the barrier is armed and every
   * player on the level owes a decision each turn; at zero nobody ever blocks
   * and the pump idles at ~0% CPU. Owned by the scheduler's game-turn hook —
   * see `updateEngagement` there for why it is level-wide rather than per-actor.
   */
  engagement: number;
  /** Boss floors run a shorter Bell (12s rather than 20s). */
  bossFloor: boolean;
};

/**
 * Why a move was refused. A closed union rather than free-form prose so the
 * gateway can map it to an `ErrorCode` and a test can assert on it; the strings
 * are also short enough to log on every rejected keystroke without noise.
 */
export const MoveBlock = {
  /** No such actor. A socket asking to move before `hello`, or after removal. */
  NoActor: 'no_actor',
  /** Wall, or off the edge of the map — `tileAt` treats both as solid rock. */
  Terrain: 'terrain',
  /** Another LIVING body is standing there. Corpses do not block. */
  Occupied: 'occupied',
} as const;
export type MoveBlock = (typeof MoveBlock)[keyof typeof MoveBlock];

/** Discriminated on `ok`, so a caller cannot read `x` off a failed move. */
export type MoveResult =
  | { readonly ok: true; readonly x: number; readonly y: number }
  | { readonly ok: false; readonly reason: MoveBlock };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLASSLESS FALLBACK, AND NOTHING ELSE ANY MORE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONLY THE FIRST THREE ARE REAL CLASSES. `chr_player_watchman_s`,
 * `chr_player_inspector_s` and `chr_player_alchemist_s` are the Watchman, the
 * Inspector and the Alchemist of Ashwick Row (content/classes.ts). The other
 * three are art for classes that do not exist: there is no Enforcer, no
 * Voidling and no Cipher Clerk in `CLASSES`, they have no `_downed_s` variant
 * (engine/downed.ts derives that key by appending the infix) and no portrait
 * (view/projector.ts falls back to the generic detective for them).
 *
 * WHICH IS WHY THIS ROTATION NO LONGER DECIDES ANYTHING. A joining player's
 * class is picked by `classForJoin` in content/classes.ts and PUSHED DOWN from
 * the gateway as the `PlayerOverlay` below, sprite included, so that "a Watchman
 * drawn as an Alchemist" is unrepresentable rather than merely avoided. This
 * list is what a body gets when nobody supplied one — a test fixture, the e2e
 * harness, a plain-browser session against a build with no content wired in.
 *
 * IT STAYS SIX WIDE. Shrinking it to three would be a second, silent copy of
 * "which classes exist" living in the layer that must not know: world.ts MAY NOT
 * import content/classes.ts, because that closes
 * `world -> content/classes -> engine/talents -> world`. The closing edge is
 * engine/talents.ts:103, which VALUE-imports `hasLineOfSight` from this file —
 * cited as the edge rather than as a paragraph, because the note that used to
 * be cited here (engine/talents.ts's `engine -> talents -> engine` warning) is
 * about the twelve talent FILES and says nothing about world.ts at all.
 */
const PLAYER_SPRITES = [
  'chr_player_watchman_s',
  'chr_player_inspector_s',
  'chr_player_alchemist_s',
  'chr_player_enforcer_s',
  'chr_player_voidling_s',
  'chr_player_cipher_clerk_s',
] as const;

/**
 * Used only if the list above is ever emptied. `PLAYER_SPRITES[i]` is
 * `string | undefined` under noUncheckedIndexedAccess and a `!` to silence that
 * is exactly the shortcut this project bans, so there is a real value to fall
 * back to instead.
 */
const FALLBACK_SPRITE = 'chr_player_watchman_s';

/** How far `addMonster` will look for a free tile before giving up. */
const SPAWN_SEARCH_RADIUS = 8;

/**
 * Line of sight between two tiles, walls blocking.
 *
 * Bresenham's symmetry is what makes this usable as a visibility test: the walk
 * is done from a canonical endpoint and reversed, so `hasLineOfSight(a, b)` and
 * `hasLineOfSight(b, a)` cannot disagree. Without that you get the oldest
 * roguelike bug report there is — the archer shoots you through a corner you
 * cannot shoot back through.
 *
 * Endpoints are excluded: standing IN a wall (a phasing monster, a door being
 * opened) must not blind you, and the target's own tile is what you are looking
 * at.
 *
 * FOV SEAM — CLOSED. This function used to trace with `canWalk`, and the note
 * here said opacity and passability were the same thing "because every blocker
 * on the M2 map is a wall", to be split "when glass, chasms and open doors
 * arrive". Alderbrook's canal is that case: solid to a body, transparent to an
 * eye. So the trace now asks `blocksSightAt`, which is the predicate protocol.ts
 * keeps beside `isWalkable` precisely so the two cannot drift.
 *
 * NOTHING ON THE M1 MAP CHANGES. Its only blocker is WALL, which is opaque and
 * solid in both predicates, so every existing FOV test still describes the same
 * game — the split is observable only where WATER or BRIDGE exists.
 */
export function hasLineOfSight(level: LevelView, from: TileXY, to: TileXY): boolean {
  const line = bresenham(from, to);
  for (let i = 1; i < line.length - 1; i += 1) {
    const tile = line[i];
    if (tile === undefined) continue;
    if (blocksSightAt(level, tile.x, tile.y)) return false;
  }
  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CLASS PUTS ON A JOINING BODY. PUSHED DOWN, NEVER PULLED UP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every field is one the caller read off a `ClassDef` (content/classes.ts) and
 * is forwarded verbatim to `createPlayerActor`, which has accepted all of them
 * since the class sheet landed (engine/actor.ts's `PlayerInit`). It is a
 * `Partial<Pick<…>>` of that type rather than a hand-written twin so the two
 * cannot drift: rename a field on `PlayerInit` and this stops compiling.
 *
 * ═══ WHY IT IS AN ARGUMENT AND NOT A LATER MUTATION ═══
 * `applyRestore` (net/gateway.ts) clamps a restored hp to `actor.maxHp`, and a
 * classless body defaults to 60. Apply the class AFTER `addPlayer` and every
 * returning Watchman — maxHp 72 — silently loses up to 12 hp per resume, once
 * per evening, with nothing failing anywhere.
 *
 * ═══ WHY THE WORLD DOES NOT JUST ASK FOR THE CLASS ═══
 * Because it may not know what one is. `world -> content/classes ->
 * engine/talents -> world` is a real cycle — engine/talents.ts:103 value-imports
 * `hasLineOfSight` from this file, which is the edge that closes it — and a
 * module cycle in a project with no build step is a
 * ReferenceError at import time rather than a warning. So the layer that can see
 * both — the gateway — reads the `ClassDef` and hands the pieces down.
 *
 * ═══ `downedSprite` IS DELIBERATELY ABSENT ═══
 * `ClassDef` authors one, but nothing on an actor stores it: `downedSpriteFor`
 * (engine/downed.ts) DERIVES `chr_player_watchman_downed_s` from the standing
 * key by appending an infix, which is what keeps the engine free of the content
 * layer. Carrying the authored value here as well would be a second source of
 * truth for one string; test/server/downed.test.ts and class-wiring.test.ts both
 * pin the derivation against all three authored values instead.
 */
export type PlayerOverlay = Partial<
  Pick<PlayerInit, 'sprite' | 'maxHp' | 'hpRegen' | 'combat' | 'classId'>
>;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ITEM LYING ON THE FLOOR. A THIRD TABLE, NOT A ROW IN `actors`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same split, for the same five reasons, that the projectile table is
 * written around (see the block comment on `World.addProjectile`). Restated
 * rather than cross-referenced, because the failure mode of each is silent:
 *
 *   `actorAt` WOULD MAKE LOOT BLOCK MOVEMENT. You could not walk onto the tile a
 *     coat is lying on — which is also the tile you have to stand on to pick it
 *     up — and `isFree` would refuse to spawn anybody there.
 *   `allActors` / `actorsInTurnOrder` WOULD HAND IT TO THE AI. `decideNpcAction`
 *     would consider a pair of boots as a target, and `visibleEnemies` would
 *     count it toward the elite's isolation hunt.
 *   `tryMove` WOULD TREAT IT AS AN OCCUPANT TO BUMP-ATTACK. Walking into your
 *     own dropped ring would be an attack that costs a turn.
 *   THE PROJECTOR WOULD SHIP IT AS AN `ActorView` with an hp bar and a rank
 *     ring.
 *   THE CLIENT'S `ringIdFor` SWITCHES EXHAUSTIVELY over a TWO-MEMBER
 *     `ActorKind` to pick a `ui_token_ring_*` sprite, and the art is gitignored
 *     wholesale, so the third case cannot be drawn at all.
 *
 * `id` is the world's to give and is never reused. `itemId` names a row in
 * `content/items.ts` — an id, never the resolved object, for the same reason
 * `actor.equipped` holds ids.
 */
export type GroundItem = {
  /** Unique within this world, monotonic, never reused. */
  readonly id: string;
  /** An id `resolveItem` can turn into an item — see content/resolve.ts. */
  readonly itemId: string;
  readonly x: number;
  readonly y: number;
};

export type World = {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH WORLD THIS IS — and everything in it used to be anonymous.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every Inner realm is a SEPARATE `World` closure, one per party
   * (`realms.ts#open`), so two parties in the Hollow Mine hold two independent
   * levels, actor tables and rng streams. That isolation is real and it stops
   * exactly at the point where something outside the world keys a table by an
   * actor id — and `main.ts` holds three such tables for the whole process: the
   * status table, the Downed countdown, and the talent engine's sheets and
   * marks.
   *
   * Monsters were minted `mon_index_husk` and `delve_0`, IDENTICALLY IN EVERY
   * INSTANCE. So the second party to open the same delve got a roster whose ids
   * collided with the first party's, and the process-wide tables could not tell
   * them apart: a stun landed by one party appeared on the other party's
   * monster, one party's Sigil mark multiplied the other's plain attacks, and a
   * kill called `forgetActor` on a body across the map that was still standing.
   * Nothing threw. It silently played somebody else's game onto your board.
   *
   * PREFIXING AT THE MINT IS WHAT FIXES ALL OF THEM AT ONCE, and none of those
   * tables has to learn what a realm is — which is the "correct by construction
   * rather than by vigilance" argument realms.ts's own header makes.
   *
   * ═══ THE DEFAULT IS THE EMPTY STRING, AND IT MEANS "DO NOT QUALIFY" ═══
   * A world built without an id is a whole game on its own — every fixture,
   * every pre-realms test, `createWorld(seed)` in a tool. Those mint BARE ids
   * exactly as they always have, so this change is invisible to everything that
   * was never at risk. Only a world that was handed a realm id qualifies, which
   * is precisely the set of worlds that can collide with another.
   */
  readonly id: string;
  /**
   * The authoritative level. Mutable in type because M4 digs doors into it; in
   * M1 and M2 nothing writes to it after construction.
   */
  readonly level: LevelView;
  /** The clock and the combat state. Mutated by the scheduler, nobody else. */
  readonly turn: TurnState;
  /**
   * The world's random stream, for anything that happens DURING play: damage
   * rolls, AI coin flips, and later loot and generation.
   *
   * Forked away from spawn placement on purpose. Placement draws happen at
   * CONNECT time, driven by network timing nobody controls; if they shared a
   * stream with combat, a replay would depend on when somebody's laptop woke up.
   */
  readonly rng: Rng;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOOT STREAM. A THIRD FORK OFF THE ROOT, AND IT IS NOT FASTIDIOUSNESS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every draw a drop rule takes comes from HERE and from nothing else.
   *
   * `fork` is a pure function of (state, inc, label) and DOES NOT ADVANCE THE
   * PARENT (src/shared/rng.ts:261-274), so adding this third child leaves
   * `world.spawn` and `world.turn` BYTE-IDENTICAL. That is not "probably zero
   * effect on the existing seeded tests", it is provably zero, and it is the
   * reason this is a fork rather than a couple of extra draws on an existing
   * stream: `world.spawn` is consumed by `world.spawn.overflow` (below) and
   * `world.turn` by `combat.checkhit`, `combat.crit`, `combat.bump.damage`,
   * `ai.fire.chance`, `ai.flee.side`, `ai.flee.hardside` and `ai.target.keep`.
   * ONE new draw on either of those moves every subsequent draw in that stream
   * and in every pump after it — rng.ts:31-39 states the rule outright: renaming
   * a label never alters a replay, adding or removing a DRAW always does.
   *
   * HONEST CAVEAT, so nobody reads more into this than it says: `grep -rn rng
   * src/server/persist/` returns nothing. No RNG state is persisted anywhere, so
   * replay-from-seed is a WITHIN-PROCESS guarantee today. A drop is reproducible
   * across a restart of the same seed; it is not reproducible across a
   * save/load, because nothing saves a cursor. This fork does not change that in
   * either direction.
   */
  readonly lootRng: Rng;
  /**
   * THE SHOP'S OWN STREAM. See the fork for why it is a fourth one.
   *
   * A shop is opened at a moment decided by somebody's mouse, so browsing must
   * never be able to move a combat roll. Fork again per restock batch on
   * `stockSeedLabel(shopId, epoch)` — that makes a shelf a pure function of
   * (seed, shop, epoch), so a catch-up loop is idempotent and a lost batch can
   * be regenerated rather than guessed at.
   */
  readonly shopRng: Rng;
  /**
   * Place a player on a free tile and return it.
   *
   * IDEMPOTENT on `id`: calling it again for an actor that already exists
   * returns that actor untouched and does NOT move them. That is the resume
   * path — a reconnecting socket must reattach to its token, not teleport it.
   *
   * THROWS if the level has no free tile at all. With 761 floor tiles and under
   * ten players that is unreachable, but silently stacking two bodies on one
   * tile would corrupt the invariant the rest of this file depends on. The
   * caller (the gateway) catches it and answers `internal`.
   *
   * @param overlay the class this body is, already read off a `ClassDef` — see
   * `PlayerOverlay`. OPTIONAL, AND THAT IS LOAD-BEARING RATHER THAN POLITE:
   * roughly forty two-argument call sites exist across the test suite and every
   * one of them describes the same game it always did. Absent means a classless
   * body: the sprite rotation above, 60 hp, and `DEFAULT_PLAYER_COMBAT`.
   *
   * IGNORED ON THE IDEMPOTENT PATH, like every other argument. An id that is
   * already in the world comes back untouched — that is the resume path, and a
   * reconnecting socket must reattach to its body rather than re-clothe it.
   */
  addPlayer(id: string, name: string, overlay?: PlayerOverlay): Actor;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * RE-CLOTHE AN ALREADY-PLACED BODY. THE CHOOSER'S PATH, AND NOTHING ELSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THE NARROW, ONCE-PER-BODY EXCEPTION TO THE PARAGRAPH DIRECTLY ABOVE. The
   * `overlay` note on `addPlayer` says a re-entrant id "comes back untouched —
   * that is the resume path, and a reconnecting socket must reattach to its body
   * rather than re-clothe it" (see :493-495 and its idempotency clause). That
   * rule is intact and this method does not weaken it, because it is not the
   * resume path: it is character creation finishing a step late.
   *
   * THE BODY IS NEVER CLASSLESS, which is why this exists at all. A joining
   * player is clothed by the rotation the instant `addPlayer` runs — there is no
   * moment where a token stands on the map with no sprite, no maxHp and no
   * combat sheet, and there must not be, because the whole party can already see
   * it. What the class chooser does is REPLACE a provisional assignment with the
   * one its owner actually picked, a few seconds later, on a body that has done
   * nothing yet.
   *
   * ═══ hp FILLS ONLY A BODY THAT WAS ALREADY FULL; ANYTHING ELSE IS CLAMPED ═══
   * THIS FILE USED TO SAY THE BODY WAS "UNDAMAGED BY CONSTRUCTION" AND THAT THE
   * FILL "CANNOT BECOME A HEAL". BOTH WERE FALSE, and each was false for its own
   * reason:
   *
   *   A RETURNING PLAYER IS RESTORED DAMAGED AND *THEN* ASKED. Every character
   *   file written before classes existed holds `UNASSIGNED_CLASS`
   *   (persist/saves.ts), so `applyRestore` writes the file's hp onto the body
   *   and the gateway's `owes` read then offers that same body the chooser. The
   *   commonest caller is therefore a body at 30/60, not a body at 60/60.
   *
   *   THE BODY IS IN THE WORLD WHILE THE MODAL IS UP. Nothing stops a monster
   *   acting on a player who has not answered yet — `net/gateway.ts` parks them
   *   on a standing hold so they cannot FREEZE the floor, but a standing hold is
   *   a brace, not a shield. A picker left open through a fight comes back to a
   *   body that has been hit.
   *
   * So the rule is stated as arithmetic rather than as an assumption: a body at
   * its old ceiling goes to the new ceiling (the brand-new-character case, which
   * is still the ordinary one and still means "this character starts full"), and
   * a body that is short of it keeps exactly the damage it had, clamped into the
   * new maximum. Nobody is ever healed by finishing character creation.
   *
   * NOT A PROPORTION, deliberately. Carrying 50% across from a 34-hp Watchman to
   * a 72-hp Alchemist would INVENT 19 hit points out of a ratio; keeping the
   * deficit is the only reading under which no health is created.
   *
   * ═══ IT DOES NOT MOVE THE BODY AND DOES NOT RENAME IT ═══
   * The tile is `addPlayer`'s own free-tile search and the name is Discord's —
   * neither is a property of a class, and re-running placement would teleport a
   * token that four other people are already looking at.
   *
   * @returns false for an unknown id and for a monster, which is the honest
   * answer for both: a monster has no class, and an id that is not in the world
   * cannot be dressed. It never throws — the caller is a player pressing a
   * button.
   */
  reclothePlayer(id: string, overlay: PlayerOverlay): boolean;
  /**
   * Place a monster, preferring the requested tile and settling for the nearest
   * free one. Idempotent on `id`, like `addPlayer`.
   */
  addMonster(id: string, init: MonsterInit): Actor;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PUT AN EXISTING BODY BACK ON A SPAWN TILE. The respawn path, and nothing else.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * PLACEMENT, NOT MOVEMENT, and the distinction is what keeps `tryMove`'s claim
   * to be the only legal way to change a position honest. `addPlayer` and
   * `addMonster` write `x`/`y` directly too: a body appearing somewhere is not a
   * STEP, so there is no terrain rule, no corner-cutting rule and no bump-attack
   * to get wrong. What both share with this is the ONE invariant that matters —
   * the tile is free of living bodies before anything is written to it.
   *
   * It exists because an Erased body can be stood on: `actorAt` skips anything
   * not alive ("corpses do not block"), so a monster or an ally may be standing
   * exactly where the erased detective fell. Standing them up in place would put
   * two living bodies on one tile, which is the single invariant this file is
   * written around. A spawn tile is also the safe, authored answer to "where do
   * you come back" — the same one game-design.md gives for a session that ended.
   *
   * @returns the tile, or undefined for an unknown id or a level with no free
   * tile at all. It NEVER throws: the caller is a player pressing a key to get
   * out of a stranded state, and an exception there is the bug all over again.
   */
  /** Put a body on a named tile. False if it is solid or taken. See the impl. */
  placeAt(id: string, tile: TileXY): boolean;
  placeAtSpawn(id: string): TileXY | undefined;
  /**
   * Remove a player outright.
   *
   * NOT THE DISCONNECT PATH. A dropped socket leaves the body in the world —
   * see `disconnectActor` in the scheduler, which marks it Standing By and
   * starts the ten-minute grace. This is for a player who has genuinely left.
   */
  removePlayer(id: string): boolean;
  /** Remove any actor. Reaping a corpse, or a GM `remove`. */
  removeActor(id: string): boolean;
  getActor(id: string): Actor | undefined;
  /** A fresh array; the `Actor` objects inside are live references. */
  allActors(): Actor[];
  /**
   * The order the scheduler ticks actors in: the whole party first, then
   * everything the world drives.
   *
   * Ported in spirit from ToME's `Party.lua:71`, which forces the party to be
   * contiguous in the level's entity list for exactly this reason. Insertion
   * order within each group, so it is stable across a save and a reload.
   */
  actorsInTurnOrder(): Actor[];
  /** The LIVING body standing on a tile, if any. Terrain is not consulted. */
  actorAt(x: number, y: number): Actor | undefined;
  /** The one legal way to change a position. */
  tryMove(id: string, dir: Dir): MoveResult;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO BODIES TRADE TILES. The SECOND writer of a position, and the last.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ported from Combat.lua:32-74 (`Actor:bumpInto`), the friendly half: when a
   * bump lands on somebody you are not hostile to, ToME checks that both can
   * stand where they are about to end up, force-moves each onto the other's
   * tile, and charges the mover one move's energy. `Party.lua:271-272` is what
   * turns it on — *"actor.move_others = true"* is set on every actor added to
   * the party — and `descriptors.lua:60` gives the player it at birth.
   *
   * WHY IT IS NOT `tryMove` TWICE: the intermediate state is illegal. Whichever
   * body moved first would be standing on a tile the other still occupies, and
   * `tryMove` would refuse it as `Occupied`. The exchange is atomic or it is
   * nothing, which is exactly why it lives here beside `tryMove` rather than
   * being assembled by a caller out of two legal-looking halves.
   *
   * TERRAIN IS STILL CHECKED, both ways, even though a standing body is prima
   * facie proof its own tile is walkable. It costs two array reads and it is
   * the guard that survives the day something makes a tile impassable underneath
   * somebody — which is exactly the shape of bug that would otherwise put a
   * body inside a wall and be blamed on the swap six weeks later.
   *
   * @returns false, having changed nothing, if either id is unknown or either
   *   destination is not walkable.
   */
  swapPlaces(aId: string, bId: string): boolean;

  // --- projectiles ----------------------------------------------------------
  // ═══════════════════════════════════════════════════════════════════════════
  // A SECOND TABLE, NOT A ROW IN `actors`. Projectile.lua:27, :32, :96.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Upstream's `Projectile` inherits Entity rather than Actor (:27), declares
  // `__is_projectile` (:32) and writes itself into `Map.PROJECTILE`, never
  // `Map.ACTOR` (:96). The same split is load-bearing HERE for reasons that are
  // all silent breakages rather than style:
  //
  //   `actorAt` would make an orb BLOCK MOVEMENT, so you could not walk through
  //   the tile a bolt is passing over — and `isFree` would refuse to spawn on it.
  //   `allActors` / `actorsInTurnOrder` would hand it to the AI and to
  //   `decideNpcAction`. `tryMove` would treat it as an occupant to bump-attack.
  //   The projector would ship it to the client as an `ActorView` with an hp bar
  //   and a rank ring, and the client's `ringIdFor` switches exhaustively over a
  //   TWO-MEMBER `ActorKind` to pick a `ui_token_ring_*` sprite that cannot be
  //   added, because the art is gitignored wholesale.
  //
  // So: its own table, its own accessors, and the scheduler concatenates the two
  // at exactly ONE call site (the array it hands `tickLevel`).

  /** Mint an orb and put it in the air. The id is the world's to give. */
  addProjectile(init: ProjectileInit): Projectile;
  /** It landed, or the floor reset under it. @returns false for an unknown id. */
  removeProjectile(id: string): boolean;
  getProjectile(id: string): Projectile | undefined;
  /**
   * Everything in the air, in INSERTION ORDER — a fresh array, live references.
   *
   * Insertion order rather than any other is what makes replay stable: two orbs
   * fired on the same turn must step in the order they were fired on every
   * machine, and a Map preserves insertion order by specification.
   */
  projectilesInFlight(): readonly Projectile[];

  // --- ground items ---------------------------------------------------------
  // A THIRD TABLE, for the five reasons written out on `GroundItem` above. The
  // shape is modelled line-for-line on the projectile table directly overhead,
  // because the argument is identical and a second argument for the same
  // decision is a second thing that can drift.

  /**
   * Drop an item onto a tile. The id is the world's to give.
   *
   * NO TERRAIN CHECK AND NO OCCUPANCY CHECK, deliberately. A corpse spills its
   * gear where it fell and a player drops onto the tile they are standing on;
   * both are places somebody was legally standing a moment ago. Adding a walk
   * check here would mean a monster killed in a doorway loses its drop with no
   * error anywhere, which is the worst of the three outcomes.
   */
  addGroundItem(cell: TileXY, itemId: string): string;
  /** Somebody took it, or the floor reset. @returns false for an unknown id. */
  removeGroundItem(id: string): boolean;
  /**
   * Everything on the floor, in INSERTION ORDER — a fresh array, live values.
   *
   * Insertion order rather than any other for exactly the reason
   * `projectilesInFlight` gives: two items dropped on the same turn must be
   * listed in the order they were dropped on every machine, and a Map preserves
   * insertion order by specification. ToME sorts its inventories before spilling
   * a corpse (Actor.lua:3038-3040) for the same reason — a hash-ordered spill
   * gives two replays of one seed the same items in a different floor order, and
   * since pickup takes the FIRST item on the tile, that is a different item.
   */
  groundItems(): readonly GroundItem[];
  /**
   * One tile's items, in that same stable order. Empty is the common case.
   *
   * PICKUP TAKES INDEX 0. That is the whole reason the order is specified: "the
   * top of the pile" has to mean the same thing to the server, to the client's
   * prompt, and to a replay.
   */
  itemsAt(x: number, y: number): readonly GroundItem[];
};

function spriteForJoinIndex(index: number): string {
  return PLAYER_SPRITES[index % PLAYER_SPRITES.length] ?? FALLBACK_SPRITE;
}

/**
 * Build the world. `seed` names this world's random stream — pass a stable
 * string (`env.WORLD_SEED`) so a restart reproduces the same placements.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `map` IS OPTIONAL, AND THE DEFAULT IS LOAD-BEARING RATHER THAN POLITE
 * ═══════════════════════════════════════════════════════════════════════════
 * Absent means the M1 test level, which is what this function built
 * unconditionally for its whole life. Roughly forty call sites across the test
 * suite pass a seed and nothing else, and every one of them still describes the
 * same game it always did.
 *
 * ═══ TWO WORLDS FROM ONE SEED ARE IDENTICAL, NOT INDEPENDENT ═══
 * The three fork labels below are hard-coded, so the SEED STRING is the only
 * lever that can distinguish two worlds. `createWorld(SEED)` twice gives two
 * worlds rolling the same to-hit sequence, the same crits, the same AI coin
 * flips and the same drops, in lockstep, for as long as they take the same
 * number of draws — mirrored streams, not shared ones, which is the more
 * confusing of the two failures because each world looks correct alone.
 *
 * So a caller building more than one MUST qualify the seed —
 * `createWorld(`${SEED}:${realmId}`)` — and realms.ts is the only such caller.
 * Distinct strings decorrelate properly: `hashSeed` FNV-1a's to 64 bits and
 * `seedStream` runs two SplitMix64 passes precisely so that low-entropy inputs
 * do not start in correlated neighbourhoods (rng.ts:131-169).
 *
 * Sharing ONE stream between two worlds would be worse and the codebase already
 * says why: adding or removing a draw shifts every subsequent draw on that
 * stream forever (rng.ts:31-39), so an overworld player's AI roll would move an
 * instance's damage roll, and replay-from-seed would depend on what strangers
 * were doing somewhere else.
 */
/**
 * An id that cannot collide with the same name in another realm.
 *
 * `world.id` is the realm's id, or `''` for a standalone world. Empty returns
 * the local name untouched, so every fixture and every single-world tool mints
 * exactly the strings it always did and only a realm-registered world qualifies
 * — which is the only kind that can collide. See `World.id` for what shared
 * monster ids did to the process-wide status, Downed and talent tables.
 */
export function qualified(world: Pick<World, 'id'>, local: string): string {
  return world.id === '' ? local : `${world.id}:${local}`;
}

export function createWorld(
  seed: number | string,
  map?: AuthoredMap,
  /**
   * WHICH WORLD THIS IS — see `World.id`. Empty means "do not qualify": a world
   * built without a realm registry is still a whole game, and every fixture is
   * one, so those keep minting the bare ids they always did.
   */
  id = '',
): World {
  const authored = map ?? makeTestMap();
  const level = authored.view;
  const spawns = authored.spawns;
  const actors = new Map<string, Actor>();
  /**
   * ORBS IN FLIGHT. Deliberately not in `actors` — see the block comment on
   * `World.addProjectile` for the five things that would silently break.
   */
  const projectiles = new Map<string, Projectile>();
  /**
   * ITEMS ON THE FLOOR. Deliberately not in `actors` either — see the block
   * comment on `GroundItem` for the five things that would silently break.
   *
   * Insertion order is the emission order, and `itemsAt` filters it rather than
   * keeping a per-tile index. A second index would be a second source of truth
   * that has to be updated in lockstep with every drop and every pickup, and the
   * failure mode of a stale one is an item that can be taken twice — which is
   * precisely the race an unowned shared pile is most exposed to. Same argument
   * `actorAt` makes for its linear scan a few lines down.
   */
  const ground = new Map<string, GroundItem>();
  /**
   * Monotonic, never reused, and the ONLY legal id source in this directory:
   * `Date.now` and `Math.random` are ESLint errors here (the determinism block
   * in eslint.config.js), which is exactly the point — an id derived from a
   * clock would make two replays of the same seed disagree about a name.
   */
  let projectileSeq = 0;
  /** Same rule, its own counter, so a projectile id and an item id never collide. */
  let groundSeq = 0;

  const turn: TurnState = {
    clock: createTurnClock(),
    engagement: 0,
    bossFloor: false,
  };

  /**
   * THREE FORKED SUB-STREAMS, not the world's main generator.
   *
   * `fork` is a pure function of (state, inc, label) and does not advance the
   * parent, so no stream can shift another's numbers however many draws it
   * takes. Placement is driven by connect timing; play is driven by the action
   * log; loot is drawn at spawn, at authored positions in an authored encounter
   * list. They must not share a cursor.
   *
   * THE THIRD FORK IS WHY ADDING DROPS MOVED ZERO SEEDED TESTS — and it is
   * required rather than tidy. `world.spawn` is drawn on by
   * `world.spawn.overflow` below; `world.turn` is drawn on by every combat and
   * AI roll in the game. Taking the loot draws on either would shift every
   * subsequent draw in it. See the note on `World.lootRng` for the full
   * argument, including what a DEATH-time roll would have cost instead.
   */
  const root = createRng(seed);
  const spawnRng = root.fork('world.spawn');
  const playRng = root.fork('world.turn');
  const lootRng = root.fork('world.loot');
  /**
   * THE FOURTH FORK, AND IT IS FREE FOR THE REASON THE THIRD WAS.
   *
   * `fork` is pure over (state, inc, label) and does NOT advance its parent
   * (rng.ts:273-274), so adding this line moved no seeded test — the same
   * property `world.loot` relies on, checked the same way.
   *
   * A SHOP'S OWN STREAM, because a shop is opened at an arbitrary moment
   * decided by somebody's mouse. Browsing must not be able to move a combat
   * roll, which is the "network timing nobody controls" argument this file
   * already makes for splitting placement from play. Per restock, fork again on
   * `stockSeedLabel(shopId, epoch)` so a batch is a pure function of
   * (seed, shop, epoch) and a lost one can be re-derived.
   */
  const shopRng = root.fork('world.shop');

  /** Where the next join starts scanning the authored spawn cluster. */
  let spawnCursor = 0;
  /**
   * Monotonic join counter, and the ONLY thing it still rotates is the
   * CLASSLESS fallback sprite — see `PLAYER_SPRITES`. A body that arrives with
   * a `PlayerOverlay` never reads it, because its class already named the
   * sprite, and the class rotation that decides which class a joining player
   * gets is the gateway's (it has to survive across worlds and be suppressed on
   * a resume, neither of which this counter can express).
   *
   * NEVER DECREMENTED, which is the other half of why it cannot decide a class:
   * it is per-process, so the fourth person to connect this evening is the
   * fourth even if the first three left an hour ago.
   */
  let joinIndex = 0;

  /**
   * Linear scan, on purpose. This is a co-op game for under ten players: a
   * position -> actor index would be a second source of truth that has to be
   * updated in lockstep with every move, and the failure mode of a stale index
   * is two players standing on one tile — the exact bug this function exists to
   * prevent. Ten comparisons per move is not worth that risk.
   *
   * Corpses are skipped: a dead body is scenery, and having to walk around your
   * friend's remains for the rest of the floor is not a mechanic anybody asked
   * for.
   */
  const actorAt = (x: number, y: number): Actor | undefined => {
    for (const actor of actors.values()) {
      if (actor.alive && actor.x === x && actor.y === y) return actor;
    }
    return undefined;
  };

  /** Walkable terrain AND unoccupied. Terrain alone is `canWalk`. */
  const isFree = (x: number, y: number): boolean =>
    canWalk(level, x, y) && actorAt(x, y) === undefined;

  /**
   * Preference order: the authored spawn cluster in order (wrapping), then any
   * free floor tile at all.
   *
   * The cluster is walked deterministically rather than drawn from the RNG
   * because two people joining a session should land next to each other every
   * time.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THE OVERFLOW USED TO SAY "FOR THE SEVENTH PLAYER ONWARDS". IT MEANT SECOND.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * That sentence was written against the TEST level, whose 3x2 cluster really
   * does hold six. The shipped OVERWORLD carried exactly ONE tile with
   * `spawn: true` — a single `O` at Alderbrook's gate on a 170x100 map — so the
   * cluster was exhausted by player TWO and everybody from the second person
   * onward was placed by `spawnRng.pick` over every free tile on the level. A
   * uniform draw across the whole moor.
   *
   * For a co-op game played by friends in a voice channel that is close to the
   * worst possible first frame: you open the Activity together and are scattered
   * up to a hundred tiles apart, in fog, with no way to find one another — the
   * world map draws only `self`, `PartyMember` carries no position, and `follow`
   * refuses because you are technically already in the same realm.
   *
   * Every test covering spawn adjacency runs on the test level, which is exactly
   * why nothing caught it: the fixture had the cluster the shipped map lacked.
   *
   * TWO CHANGES, BELT AND BRACES. `shared/level.ts` now paints ten more spawn
   * tiles around the gate (the `o` glyph, an identical YARD tile that changes
   * nothing but the flag), and the fallback below tries the gate's own
   * neighbourhood before it will consider the rest of the world.
   *
   * UNDEFINED when the level has no free tile at all — which takes more than 761
   * players. `addPlayer` turns that into the throw it has always been; the
   * respawn path answers a refusal instead, because a player pressing a key to
   * get themselves unstuck must never meet an exception.
   */
  const findSpawn = (): TileXY | undefined => {
    // THE LEVEL'S OWN SPAWNS, not a module constant. This read
    // `TEST_LEVEL_SPAWNS` directly for as long as there was one map, which
    // meant a world built around any other map would place every joining body
    // at the 30x30 test level's cluster coordinates — possibly inside a wall,
    // and always in the wrong city. `placeAtSpawn` is also the respawn and
    // floor-reset path, so the same bug would relocate a dying body to another
    // map's corner.
    const count = spawns.length;
    for (let i = 0; i < count; i += 1) {
      const index = (spawnCursor + i) % count;
      const tile = spawns[index];
      if (tile === undefined) continue;
      if (isFree(tile.x, tile.y)) {
        spawnCursor = (index + 1) % count;
        return tile;
      }
    }

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * BEFORE THE WHOLE WORLD, TRY NEXT DOOR.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * A full cluster means a lot of people arrived at once, and the honest
     * answer to that is "stand behind them", not "be somewhere else entirely".
     * `nearestFreeTile` rings outward from a requested tile in row-major order
     * with no draw at all, so this is deterministic and reproducible in the same
     * way the cluster walk above is — and it puts the eleventh arrival one step
     * further out rather than a hundred tiles away.
     *
     * FROM `spawns[0]`, the first authored tile, so the ring is anchored to the
     * gate even if every tile of the cluster is occupied. A level with no
     * authored spawn at all falls straight through to the draw below, which is
     * the behaviour it has always had.
     */
    const anchor = spawns[0];
    if (anchor !== undefined) {
      const near = nearestFreeTile(anchor.x, anchor.y);
      if (near !== undefined) return near;
    }

    // Row-major, so the candidate list is identical on every machine and the
    // draw below is reproducible. Reached only when the gate's whole
    // neighbourhood out to `SPAWN_SEARCH_RADIUS` is full, or the level authored
    // no spawn at all.
    const free: TileXY[] = [];
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        if (isFree(x, y)) free.push({ x, y });
      }
    }
    return spawnRng.pick('world.spawn.overflow', free);
  };

  /**
   * The requested tile, or the closest free one to it.
   *
   * Rings outward in row-major order within each radius, so the answer is a
   * pure function of the map and the request — no draw, and identical on every
   * machine. An authored encounter that names an occupied tile shuffles by one
   * step rather than failing to spawn, which matters because the commonest
   * cause of an occupied spawn tile is a second monster from the same encounter.
   */
  const nearestFreeTile = (x: number, y: number): TileXY | undefined => {
    if (isFree(x, y)) return { x, y };
    for (let radius = 1; radius <= SPAWN_SEARCH_RADIUS; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          // Only the ring, not the filled square — the interior was covered by
          // a smaller radius.
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          if (isFree(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return undefined;
  };

  const addPlayer = (id: string, name: string, overlay?: PlayerOverlay): Actor => {
    const existing = actors.get(id);
    if (existing !== undefined) return existing;

    const tile = findSpawn();
    if (tile === undefined) {
      throw new Error('world.addPlayer: the level has no free tile');
    }
    const actor = createPlayerActor(id, {
      // SPREAD FIRST, so that the three fields below cannot be overridden by a
      // caller: `name` is Discord's, and the tile is this function's own
      // free-tile search, which is the one invariant the whole file is written
      // around. Everything the overlay legitimately carries — the sprite, the
      // vitals, the combat sheet, the class label — is optional on `PlayerInit`
      // and falls back to the documented placeholder when absent, so an overlay
      // that names only a sprite is not half a class.
      ...overlay,
      name,
      sprite: overlay?.sprite ?? spriteForJoinIndex(joinIndex),
      x: tile.x,
      y: tile.y,
    });
    joinIndex += 1;
    actors.set(id, actor);
    return actor;
  };

  /**
   * The chooser's path. See `World.reclothePlayer` for why this is the one
   * narrow exception to `addPlayer`'s "reattach, never re-clothe" rule, and why
   * a body that is short of its ceiling keeps its damage instead of being filled.
   */
  const reclothePlayer = (id: string, overlay: PlayerOverlay): boolean => {
    const actor = actors.get(id);
    if (actor === undefined) return false;
    // A monster has no class and no `classId` field to write one into. Answered
    // rather than thrown, and narrowed rather than asserted, because the
    // discriminant is what makes `classId` reachable at all.
    if (actor.kind !== ActorKind.Player) return false;

    // READ BEFORE `maxHp` MOVES. "Was this body full?" is a question about the
    // ceiling it had a moment ago, and asking it after the write can only ever
    // compare `maxHp` with `maxHp` — which is how the old unconditional fill
    // read as obviously correct.
    const wasWhole = actor.hp >= actor.maxHp;

    // FIELD BY FIELD, and each one guarded on presence rather than spread: a
    // `PlayerOverlay` is a `Partial`, so `actor.maxHp = overlay.maxHp` for an
    // overlay that named only a sprite would write `undefined` over a real
    // number and take the body's ceiling out with it.
    if (overlay.sprite !== undefined) actor.sprite = overlay.sprite;
    if (overlay.maxHp !== undefined) actor.maxHp = overlay.maxHp;
    if (overlay.hpRegen !== undefined) actor.hpRegen = overlay.hpRegen;
    if (overlay.combat !== undefined) {
      // ═══════════════════════════════════════════════════════════════════════
      // IT WRITES THE BASELINE AND RECOMPOSES. IT USED TO WRITE `combat`
      // DIRECTLY, AND THAT WAS A LIVE BUG THE MOMENT ITEMS EXISTED.
      // ═══════════════════════════════════════════════════════════════════════
      //
      // THE OWNERSHIP SPLIT, stated here and stated verbatim at the other site
      // (engine/effects.ts#recomputeAttributes). Neither claims the other's
      // authority:
      //
      //     `baseCombat` is OWNED BY THE THING THAT DRESSES THE BODY — which is
      //         this function, `createPlayerActor` and `createMonsterActor`.
      //     `equipped` is OWNED BY THE EQUIPMENT VERBS.
      //     `combat` is OWNED BY `recomposeCombat`, and by nothing else. It is
      //         DERIVED: baseCombat, then gear, then status flags.
      //
      // `actor.combat = overlay.combat` replaced the WHOLE sheet, so a player
      // who had equipped anything and then finished character creation silently
      // lost every contribution — the ids stayed in `equipped`, the inventory
      // screen kept drawing them, and the armour was gone with nothing failing
      // anywhere. Writing the baseline and recomposing is the fix, and it is
      // also what makes the two writers of this field agree on where a sheet
      // comes from.
      //
      // `null` FOR THE EFFECT STATE, and it is honest rather than lazy: this
      // file may not import the status system (the dependency note at the top of
      // the file), so it genuinely cannot speak for stage three. `null` tells
      // `recomposeCombat` to carry the live flags across unchanged, which is
      // exactly right — nothing in stages one and two can alter a flag.
      //
      // A BODY WEARING NOTHING GETS THE OVERLAY'S SHEET BY IDENTITY, not a copy,
      // which is what keeps "the class was applied WHOLESALE, never blended"
      // assertable with `toBe` in class-choice.test.ts and class-wiring.test.ts.
      actor.baseCombat = overlay.combat;
      recomposeCombat(actor, null, resolveItem);
    }
    if (overlay.classId !== undefined) actor.classId = overlay.classId;

    // AFTER `maxHp`, or a Watchman chosen over a provisional Alchemist starts at
    // the Alchemist's ceiling. See the doc block: a body that was whole a line
    // ago is a brand-new character and starts full at the NEW ceiling; a body
    // that had already been hurt keeps that hurt and is only clamped, so
    // finishing character creation can never be a heal.
    actor.hp = wasWhole ? actor.maxHp : Math.min(actor.hp, actor.maxHp);

    // `x`, `y` and `name` are deliberately untouched — see the doc block.
    return true;
  };

  const addMonster = (id: string, init: MonsterInit): Actor => {
    const existing = actors.get(id);
    if (existing !== undefined) return existing;

    const tile = nearestFreeTile(init.x, init.y);
    if (tile === undefined) {
      throw new Error(
        `world.addMonster: no free tile within ${SPAWN_SEARCH_RADIUS} of ${init.x},${init.y}`,
      );
    }
    const actor = createMonsterActor(id, { ...init, x: tile.x, y: tile.y });
    actors.set(id, actor);
    return actor;
  };

  /**
   * The respawn placement. See `World.placeAtSpawn` for why it is placement
   * rather than movement, and why it never throws.
   *
   * CALLED WHILE THE BODY IS STILL ERASED, which is what makes it safe: `isFree`
   * consults `actorAt`, `actorAt` skips anything not alive, so the body cannot
   * be blocked by itself and cannot block anybody else on the way past. The
   * caller stands it up immediately afterwards, on a tile that has just been
   * proven empty of the living.
   */
  /**
   * Put a body on a NAMED tile. The realm-crossing path, and nothing else.
   *
   * WHY THIS IS ALLOWED TO WRITE x/y DIRECTLY, when `tryMove` is the whole point
   * of this file: it is placement, not movement, and it is the same exception
   * `placeAtSpawn` directly below already takes. A crossing is not a step — no
   * energy, no bump, no corner rule — and routing it through `tryMove` would
   * mean pathing a body across a map it is not on yet.
   *
   * REFUSES rather than shoving: an occupied or solid tile answers false and
   * leaves the body where it was. The caller (a return from a delve, aiming for
   * the doorstep somebody walked in from) has already been placed somewhere
   * legal, so a refusal costs a step of accuracy and never a stuck body.
   */
  const placeAt = (id: string, tile: TileXY): boolean => {
    const actor = actors.get(id);
    if (actor === undefined) return false;
    if (!canWalk(level, tile.x, tile.y)) return false;
    const sitting = actorAt(tile.x, tile.y);
    if (sitting !== undefined && sitting.id !== id) return false;
    actor.x = tile.x;
    actor.y = tile.y;
    return true;
  };

  const placeAtSpawn = (id: string): TileXY | undefined => {
    const actor = actors.get(id);
    if (actor === undefined) return undefined;
    const tile = findSpawn();
    if (tile === undefined) return undefined;
    actor.x = tile.x;
    actor.y = tile.y;
    return { x: tile.x, y: tile.y };
  };

  const actorsInTurnOrder = (): Actor[] => {
    const party: Actor[] = [];
    const rest: Actor[] = [];
    for (const actor of actors.values()) {
      if (actor.kind === ActorKind.Player) party.push(actor);
      else rest.push(actor);
    }
    return [...party, ...rest];
  };

  const tryMove = (id: string, dir: Dir): MoveResult => {
    const actor = actors.get(id);
    if (actor === undefined) return { ok: false, reason: MoveBlock.NoActor };

    // `step` reads only x/y off the actor, and every direction vector is
    // non-zero, so the target is never the mover's own tile.
    const target = step(actor, dir);

    // Terrain first: it is the cheaper check and the commoner rejection.
    // `canWalk` fails closed off-grid, so the map border needs no special case.
    if (!canWalk(level, target.x, target.y)) {
      return { ok: false, reason: MoveBlock.Terrain };
    }
    if (actorAt(target.x, target.y) !== undefined) {
      return { ok: false, reason: MoveBlock.Occupied };
    }

    // RULE SEAM — CORNER CUTTING. A diagonal step between two orthogonally
    // adjacent walls is allowed here, which is what ToME does and what row 20 of
    // the test map (alternating pillars) is for. If that ever needs to change,
    // it changes HERE and only here, and the client is unaffected because the
    // client never decides legality.
    actor.x = target.x;
    actor.y = target.y;
    return { ok: true, x: actor.x, y: actor.y };
  };

  /** See the note on `World.swapPlaces`. Atomic: both tiles or neither. */
  const swapPlaces = (aId: string, bId: string): boolean => {
    const a = actors.get(aId);
    const b = actors.get(bId);
    if (a === undefined || b === undefined || a === b) return false;
    if (!canWalk(level, b.x, b.y) || !canWalk(level, a.x, a.y)) return false;

    const ax = a.x;
    const ay = a.y;
    a.x = b.x;
    a.y = b.y;
    b.x = ax;
    b.y = ay;
    return true;
  };

  const removeActor = (id: string): boolean => actors.delete(id);

  const addProjectile = (init: ProjectileInit): Projectile => {
    projectileSeq += 1;
    const proj = createProjectile(`proj_${projectileSeq}`, init);
    projectiles.set(proj.id, proj);
    return proj;
  };

  const addGroundItem = (cell: TileXY, itemId: string): string => {
    groundSeq += 1;
    const id = `ground_${groundSeq}`;
    // FROZEN. A ground item is a fact about a tile, not a body: it never moves,
    // never takes damage, and is removed rather than edited. Freezing it means
    // `groundItems()` can hand out the live values without the aliasing note
    // `allActors` has to carry.
    ground.set(id, Object.freeze({ id, itemId, x: cell.x, y: cell.y }));
    return id;
  };

  /**
   * One tile's pile, filtered out of the insertion-ordered table.
   *
   * A LINEAR SCAN, on purpose, and it is the same trade `actorAt` makes: a
   * position -> item index would be a second source of truth updated in lockstep
   * with every drop and pickup, and a stale one lets an item be taken twice.
   * With at most three drops per floor (the encounter places three monsters)
   * this walks a table of three.
   */
  const itemsAt = (x: number, y: number): readonly GroundItem[] => {
    const out: GroundItem[] = [];
    for (const item of ground.values()) {
      if (item.x === x && item.y === y) out.push(item);
    }
    return out;
  };

  return {
    id,
    level,
    turn,
    rng: playRng,
    lootRng,
    shopRng,
    addPlayer,
    reclothePlayer,
    addMonster,
    placeAt,
    placeAtSpawn,
    removePlayer: removeActor,
    removeActor,
    getActor: (id: string): Actor | undefined => actors.get(id),
    allActors: (): Actor[] => [...actors.values()],
    actorsInTurnOrder,
    actorAt,
    tryMove,
    swapPlaces,
    addProjectile,
    removeProjectile: (id: string): boolean => projectiles.delete(id),
    getProjectile: (id: string): Projectile | undefined => projectiles.get(id),
    projectilesInFlight: (): readonly Projectile[] => [...projectiles.values()],
    addGroundItem,
    removeGroundItem: (id: string): boolean => ground.delete(id),
    groundItems: (): readonly GroundItem[] => [...ground.values()],
    itemsAt,
  };
}
