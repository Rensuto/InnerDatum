/**
 * The monster turn, played as ONE beat.
 *
 * WHAT THIS IS NOT. It is not a tweening system, an animation queue or a
 * per-frame loop, and it must never become one — PLAN.md § 10 lists "animation
 * playback of any kind" under Never, and the renderer is built around static
 * sprites on a 32px grid with a dirty flag instead of a 60fps rAF loop. There
 * is no interpolation here, no easing, and nothing that runs per frame.
 *
 * WHAT IT IS. The server resolves every monster between two player parks in one
 * `pump()` and sends ONE `sweep` (game-design.md § 4: "four players watching
 * eight monsters each take an individually-timed turn is the second-most-common
 * way co-op turn-based dies"). This module turns that single frame into exactly
 * TWO board states and one timer:
 *
 *   1. THE BEAT. Every event in the batch is applied to the board at once — the
 *      whole enemy line steps forward in a single draw — and each tile that did
 *      something wears a marker: a reticle where a monster arrived, a strike on
 *      a tile that was hit, a hole where a swing missed. That is the frame the
 *      player reads.
 *   2. THE SETTLED BOARD. ~240 ms later the markers clear and what remains is
 *      the truth the server sent. One more draw. Then nothing.
 *
 * THE BOARD IS UPDATED IMMEDIATELY, NOT AFTER THE BEAT. Holding the old
 * positions for a fifth of a second to "play" the move would mean the screen
 * deliberately lies about where a monster is standing while the player is
 * deciding whether to step there. In a turn-based game the truth arrives first
 * and the emphasis follows it; the markers are the emphasis.
 *
 * INTERRUPTIBLE, NEVER QUEUED. A second `sweep` while a beat is on screen
 * settles the first instantly and starts its own. Queueing would let a slow
 * client fall further and further behind the server's idea of the board, which
 * is the one failure a batched sweep exists to prevent. `settle()` is public for
 * the same reason: any keypress skips the beat, so the player is never waiting
 * on a flourish.
 */

import { MarkerKind } from './canvas.ts';
import type { TileOverlay } from './canvas.ts';
import type { SweepMsg, TurnEvent } from '../../shared/protocol.ts';

/**
 * How long the markers stay up.
 *
 * Long enough to register as a beat, short enough that nobody waits on it: a
 * batched sweep is read in one glance, so this does NOT scale with the number
 * of events. game-design.md's "~80 ms per event, capped ~2.2 s" describes
 * per-event pacing, which is the design this module deliberately replaced with
 * one simultaneous pass — eight monsters moving together take exactly as long
 * to read as one.
 */
export const SWEEP_BEAT_MS = 240;

export type SweepOptions = {
  /**
   * Apply the whole batch to the board. Called ONCE per sweep with every event
   * in resolution order — never once per monster.
   */
  readonly onBoard: (events: readonly TurnEvent[]) => void;
  /** Something drawable changed: the beat began, or it ended. */
  readonly onChange: () => void;
};

export type SweepPlayback = {
  /** Consume one `sweep`. Any beat still on screen is settled first. */
  readonly play: (msg: SweepMsg) => void;
  /** The markers for the current beat; empty once settled. */
  readonly overlays: () => readonly TileOverlay[];
  /** Skip to the settled board now. Safe to call at any time. */
  readonly settle: () => void;
  readonly dispose: () => void;
};

/**
 * Which marker each event leaves behind.
 *
 * ART SEAM, and an honest one: these are the M1 targeting markers doing a job
 * they were not drawn for. `invalid` is a struck tile and `minrange` is a whiff
 * because they are the two most distinct SHAPES in the marker set, not because
 * of what they mean in a targeting cursor. M5's hit flashes replace this
 * function and nothing else.
 *
 * `damage` and `death` draw nothing: the `attack` that caused them already
 * marked the tile, and a second marker on the same square would read as two
 * separate blows.
 */
function markersFor(events: readonly TurnEvent[]): TileOverlay[] {
  const arrivals: TileOverlay[] = [];
  const blows: TileOverlay[] = [];

  for (const event of events) {
    switch (event.k) {
      case 'move':
        arrivals.push({ x: event.x, y: event.y, kind: MarkerKind.Cursor });
        break;
      case 'attack':
        blows.push({
          x: event.x,
          y: event.y,
          kind: event.hit ? MarkerKind.Invalid : MarkerKind.MinRange,
        });
        break;
      case 'damage':
        break;
      case 'death':
        break;
      // FX SEAM (M3 client). A `talent` carries `shape` and `radius` precisely
      // so the stamp can be drawn without a second copy of the talent table in
      // the browser: `ball`/`cross` expand into a set of tiles from the two
      // fields, `beam` walks the line from the caster. Nothing is drawn yet —
      // the marker set has no AoE glyph — and the ordering below already puts
      // blows on top of arrivals, which is where the stamp belongs too.
      case 'talent':
        break;

      // -------------------------------------------------------------------
      // M4. NONE OF THESE CAN MARK A TILE, AND THE REASON IS STRUCTURAL RATHER
      // THAN A DECISION TO DEFER.
      //
      // Every one of them names an ACTOR and carries no coordinates: a status
      // landing, a status falling off, a detective going down, somebody being
      // picked up, a body being erased. This module works in tiles — it is
      // handed a batch and returns `TileOverlay[]` — and it deliberately has no
      // actor map to resolve an id against, because giving it one would make the
      // beat depend on board state that `onBoard` is in the middle of changing.
      //
      // They are drawn instead by the things that DO have the board: the downed
      // marker and the prone sprite come from `Scene.downed`, and the badge pips
      // from `Scene.effects`, both keyed by id in render/canvas.ts. If a flash
      // on the tile is ever wanted, the honest place for it is a marker built in
      // main.ts, where the actor's position is already known.
      // -------------------------------------------------------------------
      case 'effect_applied':
      case 'effect_expired':
      case 'downed':
      case 'revived':
      case 'erased':
        break;
    }
  }

  // Blows last so that a monster which stepped up and swung shows the strike,
  // not the footprint: the renderer paints overlays in array order.
  return [...arrivals, ...blows];
}

export function createSweepPlayback(options: SweepOptions): SweepPlayback {
  /** The current beat's markers. Empty means settled. */
  let marks: readonly TileOverlay[] = [];
  /** window.setTimeout never returns 0, so 0 is a safe "no beat running". */
  let beatTimer = 0;

  function stopTimer(): void {
    if (beatTimer === 0) return;
    window.clearTimeout(beatTimer);
    beatTimer = 0;
  }

  function endBeat(): void {
    beatTimer = 0;
    marks = [];
    options.onChange();
  }

  function settle(): void {
    stopTimer();
    if (marks.length === 0) return;
    marks = [];
    options.onChange();
  }

  function play(msg: SweepMsg): void {
    // Interrupt rather than queue. The previous beat's markers are dropped
    // without a draw of their own — this call is about to request one anyway.
    stopTimer();
    marks = [];

    options.onBoard(msg.events);
    marks = markersFor(msg.events);
    if (marks.length > 0) {
      beatTimer = window.setTimeout(endBeat, SWEEP_BEAT_MS);
    }
    options.onChange();
  }

  return {
    play,
    overlays: () => marks,
    settle,
    dispose: stopTimer,
  };
}
