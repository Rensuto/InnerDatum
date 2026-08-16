/**
 * WHAT A TOOLTIP SAYS — computed here, on the server, and sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT IN THE CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 * A hover tooltip is the layer that makes a roguelike legible instead of
 * memorised: "can I hit this thing, and how badly will it hurt" should be a
 * glance, not a wiki tab. That answer is arithmetic over accuracy, defence,
 * armour and resistances — and the client is FORBIDDEN from importing
 * shared/checkhit, shared/scale and shared/energy (eslint blocks it, see
 * CLAUDE.md non-negotiable #4).
 *
 * That ban is not bureaucracy. A second copy of a combat formula in the browser
 * diverges the first time either side is touched, and the symptom is a tooltip
 * promising 78% while the server rolls against 71 — which reads as "the dice
 * are rigged" and is unfalsifiable from the player's chair. One implementation,
 * server-side, sent as a number.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE CONSUMES RNG
 * ═══════════════════════════════════════════════════════════════════════════
 * `hitChance` is deliberately separate from `checkHit` upstream: the first is
 * the odds, the second rolls them. A tooltip must use the former. Drawing from
 * the seeded stream to render a hover would make the world's future depend on
 * where somebody moved their mouse, and every replay would diverge from the
 * session it claims to reproduce.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOG OF WAR APPLIES TO KNOWLEDGE, NOT JUST TILES
 * ═══════════════════════════════════════════════════════════════════════════
 * `inspectActor` takes the VIEWER. An actor the viewer cannot see returns null
 * rather than a redacted record: sending a stripped-down object still confirms
 * something is there, and a client that receives one can infer a position it was
 * never meant to know. The server's answer to "what is in that dark corner" is
 * silence.
 */

import { hitChance } from '../../shared/checkhit.ts';
import { chebyshev } from '../../shared/coords.ts';
import { ActorKind } from '../../shared/protocol.ts';
import { MELEE_REACH, combatDistance } from '../engine/combat.ts';
import type { InspectRow, InspectView } from '../../shared/protocol.ts';
import {
  combatArmor,
  combatAttack,
  combatCrit,
  combatDefense,
  combatPhysicalResist,
} from '../engine/derived.ts';
import type { Combatant } from '../engine/derived.ts';
import type { Actor, World } from '../world/world.ts';
import { hasLineOfSight } from '../world/world.ts';

// `InspectRow` and `InspectView` WERE DECLARED HERE and now live in
// src/shared/protocol.ts: the tooltip painter has to name them and eslint's
// NO_SERVER_PATTERNS bans client/** -> server/** outright, so the browser can
// never reach a type declared under src/server/. Only the DECLARATIONS moved —
// this file remains the one and only implementation of what they contain.

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/**
 * An actor's combat sheet — the thing the derived-stat maths actually reads.
 *
 * THE SHEET, NOT THE ACTOR. An `Actor` and a `Combatant` share no fields: the
 * sheet hangs off `actor.combat`. Passing the actor itself compiles only behind
 * an `as unknown as Combatant`, and then every stat silently resolves to ToME's
 * level-1 default — a tooltip that is confidently, uniformly wrong, and wrong in
 * a way no test would catch because the numbers look plausible.
 *
 * This was written as a double cast first. The compiler caught it the moment the
 * cast came off, which is the entire argument against writing one.
 *
 * `?? {}` is correct rather than lazy: derived.ts documents an absent sheet as
 * meaning ToME's own defaults, so a monster authored without one inspects as a
 * baseline creature instead of throwing at a hover.
 */
function combatantOf(actor: Actor): Combatant {
  return actor.combat ?? {};
}

/**
 * What the viewer may know about `target` right now.
 *
 * Returns null when the target is not visible — see the fog-of-war note above.
 */
export function inspectActor(world: World, viewer: Actor, target: Actor): InspectView | null {
  if (!target.alive && target.kind !== ActorKind.Player) return null;
  if (target.id !== viewer.id && !hasLineOfSight(world.level, viewer, target)) return null;

  const rows: InspectRow[] = [];
  const hostile = target.kind !== ActorKind.Player && target.id !== viewer.id;

  if (hostile) {
    // THE NUMBER THE PLAYER IS ACTUALLY ASKING FOR. Everything else on the card
    // is context for this one.
    const atk = combatAttack(combatantOf(viewer));
    const def = combatDefense(combatantOf(target));
    rows.push({ label: 'Chance to hit', value: pct(hitChance(atk, def)), emphasis: true });

    const armour = combatArmor(combatantOf(target));
    if (armour > 0) rows.push({ label: 'Armour', value: String(Math.round(armour)) });

    const resist = combatPhysicalResist(combatantOf(target));
    if (resist !== 0) rows.push({ label: 'Physical save', value: String(Math.round(resist)) });

    const crit = combatCrit(combatantOf(viewer));
    if (crit > 0) rows.push({ label: 'Your crit', value: pct(crit) });

    rows.push({ label: 'Distance', value: `${chebyshev(viewer, target)} tiles` });
  } else {
    rows.push({ label: 'Defence', value: String(Math.round(combatDefense(combatantOf(target)))) });
    rows.push({ label: 'Armour', value: String(Math.round(combatArmor(combatantOf(target)))) });
  }

  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    hp: target.hp,
    maxHp: target.maxHp,
    effects: [],
    rows,
  };
}

/**
 * Why the viewer cannot attack the target, or undefined when they can.
 *
 * Deliberately mirrors the server's own resolution-time refusals rather than
 * inventing a parallel set of rules: a tooltip that says "you can hit this" and
 * a server that then refuses is worse than no tooltip, because it teaches the
 * player something false and they will act on it.
 */
export function attackBlockedReason(
  world: World,
  viewer: Actor,
  target: Actor,
  opts: { readonly minRange?: number; readonly maxRange?: number } = {},
): string | undefined {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EUCLIDEAN, BECAUSE THAT IS THE METRIC THE SERVER WILL ANSWER WITH.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This measured with CHEBYSHEV and compared against `viewer.combat.range`,
   * which is a EUCLIDEAN radius. That agreed by ACCIDENT while no player had a
   * combat sheet at all — the `?? 1` fallback happened to match the old
   * Chebyshev-1 scheduler. Now every player carries a class sheet and the two
   * disagree along the whole diagonal:
   *
   *   Inspector (range 5) at (10,10), husk at (14,14). Chebyshev 4 ≤ 5, so this
   *   returned `undefined` and the card advertised a shootable target. Euclid is
   *   5.657, so `canAttack` answers `out_of_range` and the shot is refused on
   *   click. The whole diagonal rim of her range ring said yes and meant no.
   *
   * combat.ts's own wiring note is the argument: the metrics must move together
   * or "attacks pass the legality check and then quietly do nothing". The
   * scheduler and `canAttack` were moved; this third reader was missed.
   *
   * ═══ AND IT ASKS THE QUESTION THROUGH `rangeRefusal` ═══
   * Not a re-implementation of the band — `rangeRefusal` is exported from
   * engine/combat.ts precisely so a caller can ask the IDENTICAL question the
   * scheduler will ask, including the `Math.max(attackRange, MELEE_REACH)` floor
   * that makes a diagonal melee swing legal. This function's own promise is that
   * it "mirrors the server's own resolution-time refusals rather than inventing
   * a parallel set of rules"; it now does that literally.
   */
  const dist = combatDistance(viewer, target);
  // Reach and the dead zone belong to the ATTACKER's sheet. `opts` overrides
  // only so a talent with its own range can ask the same question.
  const minRange = opts.minRange ?? viewer.combat?.minRange ?? 0;
  const maxRange =
    opts.maxRange ?? viewer.combat?.range ?? Math.max(viewer.attackRange ?? 1, MELEE_REACH);

  if (!target.alive) return 'already down';
  if (!hasLineOfSight(world.level, viewer, target)) return 'no line of sight';
  if (minRange > 0 && dist < minRange) return `too close: needs ${minRange} tiles`;
  if (dist > maxRange) {
    // ═══ WHOLE TILES IN A SENTENCE A PLAYER READS ═══
    // The metric is a real-valued radius, but "out of range: 5.66 tiles,
    // reaches 1.5" is arithmetic, not advice. `round` on the distance is the
    // number of squares between them; `floor` on the reach is what the circle
    // actually CONTAINS — `MELEE_REACH` is 1.5 exactly so that the eight
    // neighbours at √2 are inside it, and "reaches 1" is what that means to
    // somebody looking at a grid. Last week this sentence said "reaches 1" and
    // it must keep saying so.
    return `out of range: ${Math.round(dist)} tiles, reaches ${Math.floor(maxRange)}`;
  }
  return undefined;
}
