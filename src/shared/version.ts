/**
 * Protocol and content version constants.
 *
 * This file lives in src/shared/, which is PURE by construction: tsconfig.shared.json
 * sets `"types": []` and `"lib": ["ES2024"]`, so `process`, `fs`, `console`, `window`
 * and `setTimeout` do not resolve here. `Date.now()` and `Math.random()` are ES
 * built-ins that the compiler cannot remove, so ESLint bans them separately.
 *
 * The reason is determinism: given a seed and an action log, the engine must
 * reproduce a world state exactly. Anything that reads the clock, the filesystem
 * or an entropy source breaks that, and the failure is silent until a replay
 * diverges weeks later.
 */

/**
 * Bumped whenever the WebSocket envelope changes shape in a way an older client
 * cannot parse. The server refuses a mismatched client rather than letting it
 * fail confusingly three screens later.
 *
 * 1 -> 2 (M2, the Warrant Clock). The envelope gained `commit`/`hold` inbound
 * and `turn`/`sweep`/`attacked`/`damaged`/`died` outbound, and — the change that
 * really forces the bump — `left` NARROWED: a disconnect no longer removes the
 * body, so an M1 client would delete a token that is still standing on the map
 * and then never draw it again. A silently-misinterpreted frame is worse than a
 * refused connection.
 *
 * 2 -> 3 (M3, talents and the hotbar). The envelope gained `talent` inbound and
 * `loadout`/`cooldowns`/`resource`/`used` outbound. Additions alone would not
 * force a bump — an old client ignores a frame it does not know — but two things
 * here do, and both are silent rather than loud:
 *
 *   `TurnEvent` GREW A VARIANT. A v2 client's `applyTurnEvent` switch has no
 *   `talent` case, so a talent inside a batched `sweep` is dropped on the floor:
 *   monsters visibly take damage from nothing, and an AoE that killed three of
 *   them looks like the server desyncing.
 *
 *   `ErrorCode` GREW FIVE MEMBERS (out_of_range / too_close / on_cooldown /
 *   no_resource / no_los). A v2 client renders an unknown code as raw text, so
 *   the Inspector's dead zone — the number game-design.md § 2 calls the single
 *   most important one in the class — surfaces as the literal string
 *   `too_close: ...` instead of the ring's hole lighting up.
 *
 * Both are a client that keeps running while quietly showing the wrong game,
 * which is exactly what this constant exists to prevent.
 *
 * 3 -> 4 (M4, the party). The envelope gained `say`/`point`/`revive` inbound and
 * `log`/`effects`/`party`/`pinged` outbound. As at 2 -> 3, the additions alone
 * would not force a bump — an old client ignores a frame it cannot name. Two
 * things here do, and both are the same silent failure as last time: a v3 client
 * that keeps running while showing a game that is no longer true.
 *
 *   `TurnEvent` GREW FIVE VARIANTS (effect_applied / effect_expired / downed /
 *   revived / erased). A v3 client's `applyTurnEvent` switch has no case for any
 *   of them, and they arrive INSIDE a batched `sweep`, so they are dropped on the
 *   floor: badges never appear, and — the one that matters — a player who goes
 *   Downed inside a monster sweep is rendered as a healthy body standing up.
 *   game-design.md § 9 hangs the entire co-op tension on the five-turn Downed
 *   timer, and a client that cannot see it shows a party with nothing wrong.
 *
 *   `alive === false` NO LONGER MEANS DEAD. A Downed detective carries the same
 *   `alive: false` and `hp: 0` a corpse does — the flag is what stops the
 *   scheduler ticking them and what stops them blocking the tile an ally has to
 *   step onto (engine/downed.ts) — and the difference now lives in `party`, in
 *   the `_downed_s` sprite and in the `downed` event, none of which a v3 client
 *   can read. So it draws a corpse and nobody runs to it, which is the exact
 *   failure the five-turn timer exists to create tension around. That is a
 *   NARROWING of an existing field's meaning, the same class of change as
 *   1 -> 2's `left`, and it is why a refused connection beats a confusing one.
 *
 * 4 -> 5 (M5, the turn tracker). `TurnMsg` gained `engagement`, `inCombat` and
 * `actors`, and `turn` became per-recipient. No new frame, no new event variant
 * — and the bump is still forced, for the same reason every previous one was:
 * what a v4 client does is not "less UI", it is CONFIDENTLY WRONG UI.
 *
 *   A v4 CLIENT CANNOT SEE COMBAT AND DOES NOT KNOW IT CANNOT. It has no
 *   `inCombat`, so it infers the fight from `whoseTurn` being non-empty — the
 *   only signal it has — and that inference has no transition in it. Monsters
 *   engage, the barrier arms, and the screen says the same thing it said a
 *   moment earlier. This is not hypothetical: it is the bug report from the
 *   first real session, where players did not know combat had started and could
 *   not tell the game had become turn-based. A turn tracker that silently omits
 *   combat state is worse than no turn tracker, because a missing HUD sends
 *   somebody to ask and a lying one does not.
 *
 *   `turn` IS NO LONGER SAFE TO SHOW TO SOMEBODY ELSE. `TurnActor.isSelf` is
 *   true for exactly one recipient. A v4 client has no concept of the field, so
 *   nothing breaks in it directly — but a v4 SERVER and a v5 client, which is
 *   the shape of a half-finished deploy, gives every card `isSelf: undefined`
 *   and highlights nobody. The version check is what makes that combination
 *   refuse to connect instead of producing a HUD where the game is waiting on
 *   nobody in particular.
 *
 * 5 -> 6 (EXPLICIT PARTIES). The envelope gained `party` inbound and
 * `party_state` outbound. As at every bump since 2 -> 3, the additions alone
 * would not force this: an inbound verb a v5 client never sends costs it
 * nothing, and an outbound frame it cannot name is one it ignores. What forces
 * it is that AN EXISTING FRAME NARROWED — the same class of change as 1 -> 2's
 * `left` and 4 -> 5's `alive === false`, and the same silent failure.
 *
 *   `TurnMsg` STOPPED BEING ABOUT THE LEVEL AND STARTED BEING ABOUT YOUR PARTY.
 *   `whoseTurn`, `committed`, `standingBy` and `actors` used to hold every
 *   player on the floor, because the barrier was level-wide and that was the
 *   truth. From v6 the barrier is per-party (src/server/engine/party.ts): they
 *   hold the recipient's party and nobody else. A v5 client keeps rendering the
 *   strip with total confidence and is wrong in the one way that matters — it
 *   believes the strip is everyone it can see. Two people are visibly fighting
 *   ten tiles away, no card for either of them appears, no `left` was ever sent
 *   to explain it, and the HUD whose entire job is answering "is the game
 *   waiting on me?" now also has to answer "where did those two go?" and cannot.
 *
 *   AND IT CANNOT ASK TO JOIN THEM. `party` is the only way into a party and a
 *   v5 client has no way to send one, so the state it is misreading is also a
 *   state it can never leave. A player on a v5 client would be permanently solo
 *   with no explanation on screen — which is worse than the level-wide barrier
 *   this release exists to fix, because at least that one was visible.
 *
 * `PartyMsg` (`t: 'party'`) DELIBERATELY DID NOT NARROW and is not part of the
 * reason for this bump. It is still the whole floor's roster: it drives the
 * downed markers and the revive prompt, and reviving a stranger is legal and
 * always was.
 */
export const PROTOCOL_VERSION = 6;

/**
 * Bumped whenever a persisted save file's shape changes. Every bump needs a
 * migration and a fixture proving an old file still loads.
 *
 * Declared `as const` (not a plain `number`) so a save written with a literal
 * type cannot silently widen and skip a migration.
 */
export const SCHEMA_VERSION = 1 as const;

/** Tile size in pixels. The atlas grid, prop metadata and camera all assume this. */
export const TILE_PX = 32;

/**
 * Energy required before an actor may act, and the energy granted per game tick.
 *
 * Ported from T-Engine4's energy scheduler. Players always spend exactly
 * ENERGY_TO_ACT — action points are an intra-turn budget, never a way to buy
 * extra turns — which is what keeps a co-op party phase-locked instead of
 * drifting until three people are waiting on one.
 *
 * Monsters keep the full variable-speed model: their cost is
 * ENERGY_TO_ACT * speedFactor.
 */
export const ENERGY_TO_ACT = 1000;
export const ENERGY_PER_TICK = 100;
