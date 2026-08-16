/**
 * WHAT IS IN THE AIR, as this client holds it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS A MODULE HERE AT ALL, FOR THREE FUNCTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest runs in the NODE environment — there is no jsdom and no canvas (see
 * vitest.config.ts, which is blunt about that being deliberate). So the orb
 * feature is split so that the half with a RULE in it lives here, pure, and can
 * be tested, while the half that puts pixels on a backbuffer lives in
 * render/canvas.ts and is held correct by a rule instead
 * (`paintProjectiles` may only `fillRect`, so there is nothing to mock).
 *
 * KEEP IT THAT WAY. This module must never import from render/, never touch
 * `document`, `window` or a 2D context, and never grow a draw call. The moment
 * it does, the one testable piece of the feature stops being testable and the
 * split has bought nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FRAME IS COMPLETE AND ABSOLUTE. IT IS REPLACED, NEVER MERGED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ProjectilesMsg` carries EVERYTHING in the air, and an empty array means the
 * sky is clear — shared/protocol.ts says so in the same words it uses for
 * `EffectsMsg`, and for the same reason. A client that merged frames would keep
 * a phantom orb on the map forever after one dropped packet, and a phantom orb
 * is worse than no orb at all: it teaches the player to dodge something that is
 * not coming, and then to stop trusting the one that is.
 *
 * ABSENCE FROM A LATER FRAME IS THE ONLY SPELLING OF "IT LANDED". There is no
 * landed event, there is no `TurnEvent` variant, and there must not be one — the
 * orb's impact arrives as the ordinary `attack` step attributed to the shooter.
 */

import type { ProjectileView, ProjectilesMsg } from '../../shared/protocol.ts';
import type { TileXY } from '../../shared/coords.ts';

/**
 * Take a `projectiles` frame. WHOLESALE REPLACEMENT — the previous list is not
 * consulted, so there is deliberately no `previous` parameter to pass it in.
 *
 * THE COPY IS NOT DEFENSIVE PEDANTRY. `msg` is a decoded wire frame owned by the
 * socket layer, and holding a reference to an array inside it keeps that whole
 * frame alive for as long as an orb is in flight — and, worse, would make this
 * client's board state and the last received packet the same object. Board state
 * that aliases a packet is board state that changes when nobody wrote to it.
 */
export function applyProjectilesFrame(msg: ProjectilesMsg): readonly ProjectileView[] {
  return [...msg.projectiles];
}

/**
 * The sky is clear. Called from the two frames that replace the world an orb
 * belonged to — `welcome` (the reconnect path and the floor reset) and `state`
 * (a resync, meaning this client and the server had drifted).
 *
 * An orb carried across either of those is aimed at a tile on a map that no
 * longer exists, fired by an id that may now belong to somebody else. It is the
 * same argument `welcome` already makes for the sweep beat, the pings and the
 * badge map, written once more because the orb is the one thing on screen the
 * player is supposed to be MOVING AWAY FROM: a stale one sends somebody running
 * from nothing.
 */
export function clearProjectiles(): readonly ProjectileView[] {
  return [];
}

/**
 * HOW MANY ORBS ARE FLYING AT THIS EXACT TILE.
 *
 * `targetX`/`targetY` is the FROZEN aim tile — where the victim stood at the
 * instant of firing — and it never re-aims. That is the whole counterplay
 * (decision (c)): stepping off the tile makes the orb miss. So this is the one
 * question worth asking of the list, and it is asked about the viewer's own
 * tile: "is something already committed to the square I am standing on?"
 *
 * A COUNT rather than a boolean because two wraiths in a corridor is a normal
 * board, and "an orb" when there are three of them understates the situation at
 * the exact moment the player is deciding whether one step is enough.
 *
 * EVERY ORB IN THE AIR IS AN ENEMY'S. Player-fired projectiles are cut — no
 * talent declares `projSpeed` — so there is no `sourceId === selfId` filter
 * here, and adding one before that changes would be dead code pretending to be
 * a rule.
 */
export function orbsAimedAt(projectiles: readonly ProjectileView[], tile: TileXY | null): number {
  if (tile === null) return 0;
  let count = 0;
  for (const orb of projectiles) {
    if (orb.targetX === tile.x && orb.targetY === tile.y) count += 1;
  }
  return count;
}
