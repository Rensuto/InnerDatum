/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT HOLDS NO PROP MEMORY, AND THAT IS THE WHOLE OF ITS HALF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from a screenshot of Alderbrook on the live server: *"i can see
 * assets, people and props through walls, you should only see what you have
 * vision of"*, and then, ruling out the obvious half-fix: *"i dont want it to be
 * the props you remember. the props should only be visible if you have actual
 * line of sight with it."*
 *
 * The server's half is `PropsMsg` — a per-viewer frame built from the CURRENT
 * seen set, never `knownTile`, with `[]` as the withdrawal (`test/server/
 * fov.test.ts`). This is the client's half, and it is a claim about a thing
 * that cannot be read off the source: THE RENDERER IS STATEFUL, and a painter
 * that kept last frame's list — or a cache added later for the honest reason
 * that a prop never moves — would leave the furniture on screen after the
 * server had taken it away, which is the reported bug exactly, surviving the fix.
 *
 * So each case here paints TWO frames through ONE renderer and measures the
 * second. The harness is `trap-paint.test.ts`'s, for the reason its header
 * gives: `canvasstub.ts` records `drawImage` only, and this needs the ops in
 * order with the fills beside them.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRenderer } from '../../src/client/render/canvas.ts';
import { TILE_PX } from '../../src/shared/version.ts';
import type { Sprite, SpriteSource } from '../../src/client/render/assets.ts';
import type { PropView } from '../../src/shared/protocol.ts';

type Op = {
  readonly op: 'blit';
  readonly id: string | null;
  readonly source: unknown;
};

type RecordingCanvas = {
  width: number;
  height: number;
  readonly ops: Op[];
  getContext: (kind: string) => unknown;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
};

function recordingCanvas(cssW = 0, cssH = 0): RecordingCanvas {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
  };
  let ctx: unknown = null;
  const canvas: RecordingCanvas = {
    width: 0,
    height: 0,
    ops,
    getContext(kind) {
      if (kind !== '2d') return null;
      ctx ??= new Proxy(state, {
        get(target, prop) {
          if (prop === 'canvas') return canvas;
          if (prop === 'drawImage') {
            return (source: unknown) => {
              const id =
                typeof source === 'object' && source !== null && 'id' in source
                  ? String(source.id)
                  : null;
              ops.push({ op: 'blit', id, source });
            };
          }
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
            return () => ({ addColorStop: () => undefined });
          }
          if (typeof prop === 'string' && prop in target) return target[prop];
          return () => undefined;
        },
        set(target, prop, value) {
          if (typeof prop === 'string') target[prop] = value;
          return true;
        },
      });
      return ctx;
    },
    getBoundingClientRect: () => ({ width: cssW, height: cssH, left: 0, top: 0 }),
  };
  return canvas;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return recordingCanvas();
    },
  };
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
});

/** Every id answers. A prop IS its art, so a missing one would draw the loud box. */
function everyPicture(): SpriteSource {
  return {
    sprite: (id: string): Sprite => ({
      id,
      image: { id } as unknown as HTMLImageElement,
      w: TILE_PX,
      h: TILE_PX,
    }),
  };
}

/** The bookshelf that was on every client standing in the street of Alderbrook. */
const BOOKSHELF: PropView = { x: 3, y: 2, sprite: 'prop_town_bookshelf' };

/**
 * One renderer, a list of frames, and what each frame blitted onto the map
 * buffer. The renderer is built ONCE so the second frame sees whatever the
 * first left behind — which is the entire measurement.
 */
function framesOf(props: readonly (readonly PropView[] | undefined)[]): readonly string[][] {
  const visible = recordingCanvas(1248, 860);
  const renderer = createRenderer({
    canvas: visible as unknown as HTMLCanvasElement,
    sprites: everyPicture(),
  });
  renderer.resize();
  const { logicalW, logicalH } = renderer.metrics();
  const w = logicalW / TILE_PX;
  const h = logicalH / TILE_PX;
  const out: string[][] = [];
  for (const list of props) {
    const before = visible.ops.length;
    renderer.draw({
      level: { w, h, tiles: new Array<number>(w * h).fill(1) },
      realmKind: null,
      actors: [],
      selfId: null,
      ...(list === undefined ? {} : { props: list }),
    });
    // The map buffer is composited onto the visible canvas; what this frame
    // drew is what landed on that buffer.
    const composite = visible.ops.slice(before).find((op) => op.op === 'blit');
    const back = (composite?.source ?? null) as RecordingCanvas | null;
    expect(back?.ops, 'the map buffer was never presented').toBeDefined();
    out.push((back?.ops ?? []).flatMap((op) => (op.id === null ? [] : [op.id])));
    // The buffer is reused across frames, so it is emptied between them or the
    // second frame would be measured with the first one still in it.
    if (back !== null) back.ops.length = 0;
  }
  return out;
}

describe('the dressing you can see right now', () => {
  it('draws a prop the server says is in sight', () => {
    const [frame] = framesOf([[BOOKSHELF]]);
    expect(frame).toContain(BOOKSHELF.sprite);
  });

  it('takes it off the screen again the moment the server withdraws it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CASE THE WHOLE COMMIT IS, MEASURED THROUGH ONE STATEFUL RENDERER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * You step into a room, you see the bookshelf, you step back into the
     * street. The empty list is not an edge case — it is half of what the frame
     * does, and a client that treated it as "nothing to update" would leave the
     * furniture painted on alpha-1 black through the wall, which is the reported
     * bug reappearing with the server fixed.
     *
     * THE MUTANT THIS KILLS is any cache in the prop path: `props ??= last`, a
     * memo keyed by realm, a `props.length === 0 && return` in the painter. Each
     * is a reasonable-looking optimisation for a thing that *"never moves"*, and
     * each one silently restores the leak. The first frame has to draw it, or
     * the second proves nothing at all.
     */
    const [inside, street] = framesOf([[BOOKSHELF], []]);
    expect(inside, 'the prop was never drawn, so its absence means nothing').toContain(
      BOOKSHELF.sprite,
    );
    expect(street, 'the client is drawing a prop the server took away').not.toContain(
      BOOKSHELF.sprite,
    );
  });

  it('treats an absent list exactly as an empty one', () => {
    // A floor with nothing in sight omits the key; both mean "draw nothing".
    const [, absent] = framesOf([[BOOKSHELF], undefined]);
    expect(absent).not.toContain(BOOKSHELF.sprite);
  });

  it('draws it again when you walk back in', () => {
    // The withdrawal must not be sticky either: the same list arriving again is
    // the same picture again, with nothing on this side remembering the gap.
    const [, , back] = framesOf([[BOOKSHELF], [], [BOOKSHELF]]);
    expect(back).toContain(BOOKSHELF.sprite);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHERE THE LIST COMES FROM, WHICH ONLY THE SOURCE CAN SAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/client/main.ts` is a module of side effects with no seam to drive, so
 * these are assertions about its text. They are narrow on purpose: each one
 * names a single statement whose deletion is a bug nobody would see in a
 * screenshot until they were standing in the wrong place on the wrong map.
 */
describe('what feeds the prop table', () => {
  const MAIN = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
  const CANVAS = readFileSync(
    new URL('../../src/client/render/canvas.ts', import.meta.url),
    'utf8',
  );

  it('is written by exactly three statements and no more', () => {
    /**
     * The declaration, the `realm` frame, the `props` frame, and the board
     * reset. A FIFTH writer is the thing to catch: every past version of this
     * leak was a second place that decided what the dressing was, and the
     * failure is silent — one screen in one situation drawing a room the player
     * is not in.
     */
    const writes = [...MAIN.matchAll(/(?<![A-Za-z0-9_.])props = [^;]*;/g)].map((match) => match[0]);
    expect(writes).toEqual([
      // The board reset — `forgetTheWorld`, for `welcome` and for `roster`.
      'props = [];',
      // Arrival: what is in sight of the tile you are standing on.
      'props = msg.props ?? [];',
      // And every change afterwards, the empty list included.
      'props = msg.props;',
    ]);
    expect(MAIN).toContain('let props: readonly PropView[] = [];');
  });

  it('drops a props frame stamped with a realm this client has left', () => {
    /**
     * Without the guard, a frame in flight across a crossing paints the last
     * map's furniture onto this one — and it would stay until the next pump,
     * because the memo on the server has already recorded it as sent.
     */
    expect(MAIN).toContain('if (msg.realmId === currentRealmId) props = msg.props;');
  });

  it('empties the table when the board is taken away', () => {
    /**
     * A REAL BUG THIS FIXED. `props` was written by `case 'realm'` and by
     * nothing else, and `welcome` never touched it, so a reconnect or a party
     * wipe left the previous map's dressing on screen until a `realm` frame
     * happened to land behind it. Harmless while a prop was a fact about a floor
     * everyone held; a wrong picture now that it is a fact about what one viewer
     * can see.
     *
     * Asserted INSIDE `forgetTheWorld`, because a `props = []` anywhere else in
     * the file would satisfy a whole-file search and fix nothing.
     */
    const body = MAIN.slice(
      MAIN.indexOf('function forgetTheWorld(): void {'),
      MAIN.indexOf('function applyServerMessage('),
    );
    expect(body.length, 'forgetTheWorld has moved or been renamed').toBeGreaterThan(0);
    expect(body, 'a welcome now keeps the last map’s dressing').toContain('props = [];');
  });

  it('never re-tests the fog in the painter', () => {
    /**
     * The server decided, once, against that viewer's own eyes. A `vision` read
     * in this loop would be a second copy of the sight rule in the process that
     * must never hold one — and the copy that drifts. Asserted on the LOOP, not
     * on the file: `paintProps`' docblock argues about vision at length, and a
     * window that swallowed the comment would be a test of the comment
     * (`zonewash.test.ts` records that trap, and `mapview.test.ts` repeats it).
     */
    const open = CANVAS.indexOf('function paintProps(');
    const body = CANVAS.slice(open, CANVAS.indexOf('\n  }\n', open));
    expect(open, 'paintProps has been renamed').toBeGreaterThan(-1);
    expect(body).not.toContain('vision');
    expect(body).not.toContain('remember');
  });
});
