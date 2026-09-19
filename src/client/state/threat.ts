// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:1427 (facing on a move)
// Ported from t-engine4 game/modules/tome/class/interface/Combat.lua:649 (facing on a blow)
// Ported from t-engine4 game/engines/default/engine/Map.lua:1459-1470 (compassDirection)
// Ported from t-engine4 game/modules/tome/class/Player.lua:971-981 (hostile spotted to the <dir>)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH WAY IS IT COMING FROM. The rules behind the arcs on your own token.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for: *"Tales of Maj Eyal combat will tell you which direction the enemy
 * is facing. we need to give a small indication to the direction that the
 * attack or enemy targetting you is coming from."*
 *
 * ═══ WHAT UPSTREAM HAS, IN THREE PIECES, AND WHICH ONE IS OURS ═══
 * ToME's FACING is a mirrored sprite and nothing else: `tome/class/Actor.lua:1427`
 * flips it on a move, `tome/class/interface/Combat.lua:649` flips it toward the
 * target at the moment of a blow, and `MOflipY` exists at
 * `engine/Entity.lua:607` with nothing calling it for facing. Horizontal only,
 * and on the ATTACKER.
 *
 * ToME's "WHICH WAY IS IT" is a SENTENCE: `tome/class/Player.lua:971-981` refuses
 * a rest with *"hostile spotted to the %s"*, where the direction comes from
 * `engine/Map.lua:1459-1470` (`compassDirection`, eight points and nil for no
 * displacement) — and it marks the body itself with a `notice_enemy` particle.
 * `Game.lua:2079` says the same for auto-explore. This game already ports that
 * half: `bearingWord` in shared/coords.ts is the same eight-point snap and
 * `RestView.threat` carries it.
 *
 * WHAT UPSTREAM HAS NOWHERE is a tell for an attacker you CANNOT see. Its
 * sentence is built from `spotHostiles`, its particle is stuck on a body the
 * player is looking at, and its facing lives on the attacker's own sprite. The
 * arc is upstream's answer drawn instead of written; the unseen half of it is
 * ours, and `DamageEvent.from` is where its honesty is enforced.
 *
 * ═══ WHY A MODULE, AND WHY IT IS NOT render/canvas.ts ═══
 * state/projectiles.ts makes the whole argument and this file is the second
 * instance of it: vitest runs in the NODE environment with no jsdom and no
 * canvas, so the half of a feature that has a RULE in it has to be reachable
 * from a node test. Everything here is a rule — when a tell is born, when it
 * dies, what happens when two of them name the same quarter, and which orbs in
 * the air count as aimed at you. The half that puts orange pixels on a
 * backbuffer is `paintThreat` in render/canvas.ts and has no rule left in it.
 *
 * IT MUST NEVER IMPORT FROM render/, for that module's stated reason. That is
 * also why `headingToward` lives HERE rather than in the renderer that used to
 * export it: the renderer never called it. It was client logic parked in a file
 * no test can reach without a canvas.
 *
 * ═══ AND WHY NOT IN main.ts, WHICH IS WHERE THIS STARTED ═══
 * test/client/travelwiring.test.ts states the line in as many words: *"ANY RULE
 * THAT CANNOT BE ASSERTED HERE BELONGS IN src/client/input/, NOT IN main.ts"* —
 * main.ts calls `boot()` at module load and cannot be imported at all. The first
 * cut of this feature kept the decay and the merge inside a closure in `boot()`,
 * where the only thing a test could do was read the source text and hope it
 * meant what it said. One of the four rules below was wrong in there, and no
 * scrape could have found it.
 */

import { DIR_ORDER } from '../../shared/coords.ts';
import type { Dir, TileXY } from '../../shared/coords.ts';
import type { ProjectileView } from '../../shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DISPLACEMENT -> ONE OF EIGHT HEADINGS. The client's whole facing rule.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dirFromVector` in shared/coords.ts is the wrong tool and says so: it maps a
 * STEP, one tile, and answers undefined for anything outside [-1, 1]. A blow
 * comes from six tiles away as often as from one.
 *
 * `null` FOR (0, 0) AND NOTHING ELSE. A direction from a square to itself is
 * not a direction; defaulting to north would be a tick confidently pointing at
 * nothing, which is the one thing a facing tell must never do.
 *
 * PURE AND EXPORTED, so the snap can be walked over a whole circle in a test
 * without a canvas — the off-by-an-eighth is the bug this shape has, and it
 * only shows on the diagonals.
 *
 * ═══ THE NEAREST EIGHTH, WHERE THE SENTENCE PREFERS THE CARDINAL ═══
 * `bearingWord` (shared/coords.ts) answers the same question in words for the
 * rest refusal, and it is upstream's `engine/Map.lua:1459-1470` rule: a cardinal
 * whenever one axis is more than twice the other, because somebody who reads
 * "north-east" and walks it is wrong for most of a journey that is mostly east.
 * This snaps to the NEAREST of the eight instead, and the two disagree in a thin
 * wedge — a body nine east and four north is `ne` here and "east" there.
 *
 * THAT IS DELIBERATE AND IT IS THE DIFFERENCE BETWEEN A WORD AND A PICTURE. The
 * word is walked; the arc is looked at, sitting on a rim beside seven other
 * possible angles, and an arc that pointed due east at something plainly
 * north-east of it would be read as wrong by anybody who could see both.
 * test/client/threat-direction.test.ts pins the agreement and the one wedge.
 *
 * `dy` IS SCREEN-DOWN, as everywhere in shared/coords.ts.
 */
export function headingToward(dx: number, dy: number): Dir | null {
  if (dx === 0 && dy === 0) return null;
  // Eighths of a turn, measured from EAST, which is where `atan2` starts.
  const turns = Math.round((Math.atan2(dy, dx) * 4) / Math.PI);
  // `DIR_ORDER` is clockwise from NORTH, which on a screen-down axis is two
  // eighths before east. The double modulo is because `%` keeps the sign in
  // JavaScript and a west-north-west blow produces a negative turn count.
  return DIR_ORDER[(((turns + 2) % 8) + 8) % 8] ?? null;
}

/**
 * ONE THING THE VIEWER IS BEING TOLD: a quarter or an eighth of the compass,
 * and how sure the frame let us be about it.
 *
 * `seen` IS THE PRECISION, NOT A COLOUR. A named dealer means this viewer holds
 * that body, so the bearing was worked out from two tiles and is an OCTANT; a
 * dealer whose name the server took away leaves `DamageEvent.from`, which is a
 * QUADRANT by protocol and is drawn as one. See `ThreatMark` in
 * render/canvas.ts for the painted half, and `DamageEvent.from` for why the
 * server refuses to send the finer answer.
 */
export type ThreatTell = {
  readonly dir: Dir;
  readonly seen: boolean;
};

/** A tell with the moment it stops being true. See `THREAT_TELL_MS`. */
export type RememberedThreat = ThreatTell & {
  /** Epoch milliseconds. Strictly greater than `now` is still live. */
  readonly until: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW LONG ONE TELL LIVES. `THREAT_TELL_MS` is 4000.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ NOT THE SWEEP BEAT, AND THE DIFFERENCE IS THE POINT ═══
 * `SWEEP_BEAT_MS` is 240 — long enough to READ as emphasis, and the sweep's own
 * header says exactly that. This is not emphasis on something that has already
 * happened; it is the answer to "which way do I turn", and the player is being
 * asked to act on it. A quarter of a second is a flicker you notice and cannot
 * use.
 *
 * FOUR SECONDS: long enough to survive reading the Case Log line that arrived
 * with it, short enough to be gone before the next monster turn in any fight
 * anybody is paying attention to. It is deliberately NOT tied to the player's
 * own turn — a party of six can sit at the barrier for a minute, and an arc
 * that lasted that long would be furniture.
 */
export const THREAT_TELL_MS = 4000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REMEMBER A BLOW. Keyed by DIRECTION, and each mark carries its own clock.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ KEYED BY DIRECTION, WHICH IS THE DEDUPLICATION THAT MATTERS ═══
 * A husk that swings three times from the east is ONE arc, not three stacked on
 * the same pixels; two attackers on opposite sides are two arcs, which is the
 * fact worth drawing. Keying by the dealer's id would draw one arc per body and
 * stack the three anyway — and it cannot be done at all for the case this
 * exists for, because a blow out of the dark has no id.
 *
 * ═══ THE WIDER ARC WINS THE KEY ═══
 * Two blows from the east, one from a body in sight and one from the dark, is
 * not a contradiction — there are two attackers. Promoting the pair to the
 * narrow arc would claim a precision the server never sent, so the quarter wins
 * and the refreshed mark carries it.
 *
 * ═══ ONE DEADLINE PER MARK, AND THIS OVERTURNS THE FIRST VERSION ═══
 * The first cut kept ONE timeout for the whole set, restarted by every blow,
 * and argued: *"the arcs go together because they are one answer to one
 * question — what is hitting me, and from where — and expiring them
 * individually would leave a player reading half a picture"*.
 *
 * That is true of ONE EXCHANGE and false of a FIGHT, which is the only place
 * this feature is ever used. Blows arrive every turn, so a shared deadline is
 * restarted every turn and nothing expires while the fight lasts: take one hit
 * from the north, then spend thirty seconds trading blows with something to the
 * south, and the north arc is still up — pointing at an empty corridor, on the
 * one tell the player is being asked to ACT on. A stale direction is not half a
 * picture, it is a wrong one. Each mark now dies four seconds after the blow
 * that made IT, which is the fact each one states.
 */
export function rememberThreat(
  marks: readonly RememberedThreat[],
  tell: ThreatTell,
  now: number,
): readonly RememberedThreat[] {
  const live = liveThreats(marks, now);
  const standing = live.find((mark) => mark.dir === tell.dir);
  return [
    ...live.filter((mark) => mark.dir !== tell.dir),
    // `standing?.seen ?? true` and not `?? false`: no standing mark means
    // nothing is arguing for the wider arc, so the new tell's own grade stands.
    { dir: tell.dir, seen: tell.seen && (standing?.seen ?? true), until: now + THREAT_TELL_MS },
  ];
}

/** The marks still true at `now`. Exported because the caller sweeps as well. */
export function liveThreats(
  marks: readonly RememberedThreat[],
  now: number,
): readonly RememberedThreat[] {
  return marks.filter((mark) => mark.until > now);
}

/**
 * When the next mark falls due, or null when nothing is standing.
 *
 * The caller arms ONE timeout at this moment, which is the shape `pings` uses: a
 * timer per mark would be eight timers for a picture that fits in eight bits.
 */
export function nextThreatExpiry(marks: readonly RememberedThreat[], now: number): number | null {
  const live = liveThreats(marks, now);
  if (live.length === 0) return null;
  return Math.min(...live.map((mark) => mark.until));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ALREADY COMMITTED TO YOUR TILE AND HAS NOT LANDED YET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the third of the three cases the tell has to answer, and the only one
 * that is not a memory: a melee blow from the body beside you and an orb that
 * crossed the room both arrive as `damage` and are remembered above, but
 * something aimed at you and STILL IN THE AIR is a fact about right now, so it
 * is derived from the live `projectiles` frame on every draw rather than
 * stored. It appears the instant the shot is on the wire and goes the instant
 * the orb does — either because it landed, or because you stepped off the tile
 * it was frozen at, which is the whole counterplay (`orbsAimedAt`).
 *
 * ═══ AND IT IS THE HONEST LIMIT OF "AIMING AT YOU" ═══
 * A monster that has DECIDED to attack you and not yet done it is not knowable
 * here and must not become knowable: `ActorView` withholds pending intent and
 * AI target by rule (CLAUDE.md non-negotiable 4), and a tell fed from that
 * would be the client reading the enemy's mind. A committed shot in the air is
 * the earliest warning the server is willing to give, and it is already on the
 * player's screen — `projectProjectiles` gates every orb on ITS OWN tile, so an
 * orb reaching this function is one the viewer can see.
 *
 * `seen: true` for that reason, and it is not a courtesy: the orb's tile is
 * held and the viewer's tile is held, so the bearing is an honest octant. It
 * says nothing about where the SHOOTER is — an orb out of the dark keeps its
 * redacted `sourceId` and this function never asks for one.
 */
export function incomingThreats(
  projectiles: readonly ProjectileView[],
  self: TileXY | null,
): readonly ThreatTell[] {
  if (self === null) return [];
  const tells: ThreatTell[] = [];
  for (const orb of projectiles) {
    // The FROZEN aim tile, exactly as `orbsAimedAt` reads it: an orb fired at
    // where you were standing is not aimed at you any more.
    if (orb.targetX !== self.x || orb.targetY !== self.y) continue;
    const dir = headingToward(orb.x - self.x, orb.y - self.y);
    // An orb ON the tile lands this pump. There is no direction left to give,
    // and "it is on top of you" is the notice line's sentence, not an arc.
    if (dir === null) continue;
    tells.push({ dir, seen: true });
  }
  return tells;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING THE VIEWER IS BEING TOLD THIS FRAME, MERGED AND IN COMPASS ORDER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two sources answer the same question — "where is it coming from" — so
 * they merge into one set rather than stacking two arcs on one rim: an orb in
 * the air from the east and a blow that already landed from the east is one
 * east, and drawing it twice would say "two attackers" on a board with one.
 *
 * WIDER STILL WINS, on `rememberThreat`'s argument. A quadrant out of the dark
 * and an octant from an orb in the same quarter is not licence to draw the
 * narrow one.
 *
 * `DIR_ORDER` ORDER RATHER THAN ARRIVAL ORDER, so the same board always paints
 * the same list. Two arcs on one token never overlap — they are at different
 * angles on one circle — so the order changes no pixel, which is exactly why it
 * may as well be stable.
 *
 * SIX PLAYERS, AND THE REASON THIS IS NOT NOISE: nothing in this file is about
 * anybody else's body. The caller only ever remembers blows on the VIEWER and
 * only ever asks about the VIEWER's tile, so a party of six sees six private
 * pictures of at most eight arcs each, not thirty-six arcs on one screen.
 */
export function threatTells(
  marks: readonly RememberedThreat[],
  projectiles: readonly ProjectileView[],
  self: TileXY | null,
  now: number,
): readonly ThreatTell[] {
  const byDir = new Map<Dir, boolean>();
  const add = (tell: ThreatTell): void => {
    byDir.set(tell.dir, (byDir.get(tell.dir) ?? true) && tell.seen);
  };
  for (const mark of liveThreats(marks, now)) add(mark);
  for (const tell of incomingThreats(projectiles, self)) add(tell);
  return DIR_ORDER.filter((dir) => byDir.has(dir)).map((dir) => ({
    dir,
    seen: byDir.get(dir) ?? true,
  }));
}
