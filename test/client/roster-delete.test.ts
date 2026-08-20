// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  RosterHitKind,
  drawRoster,
  rosterHitAt,
  rosterRect,
  rosterRows,
  rosterVisibleCount,
} from '../../src/client/ui/roster.ts';
import type { CharacterRow } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONLY DESTRUCTIVE CONTROL IN THE CLIENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The select screen could hold eight characters and had no way to hold seven,
 * which stopped being academic the moment a swap bug produced three copies of
 * the same one.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE is not that the button exists — it is the
 * two rules whose failure is SILENT:
 *
 *   THE CONTROL IS HIT-TESTED BEFORE THE ROW IT SITS ON. Get that backwards and
 *   the row swallows the click, the button is simply unreachable, and nothing
 *   anywhere reports a problem: selecting a row is a completely plausible thing
 *   to have happened, so it reads as "the button does nothing sometimes".
 *
 *   THERE IS ONE CONTROL PER *DRAWN* ROW. `geometryFor` stops laying out cards
 *   when the next one would cross the buttons, so a nine-character account on a
 *   short window draws fewer rows than it has characters. A control built from
 *   the character count rather than the row count would sit in empty space below
 *   the list and delete a character the player cannot see.
 */

function rowsOf(n: number): CharacterRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `chr_${String(i).padStart(4, '0')}`,
    name: `Ren ${String(i)}`,
    className: 'The Watchman of Alderbrook',
    level: 3,
    filed: 1,
    money: 20,
    lastPlayed: new Date(0).toISOString(),
    playable: true,
  }));
}

const centre = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({
  x: Math.floor(r.x + r.w / 2),
  y: Math.floor(r.y + r.h / 2),
});

describe('the delete control', () => {
  it('is reachable — it is tested before the row it sits on', () => {
    const rect = rosterRect(1280, 800);
    const count = 3;
    const rows = rosterRows(count, rect);
    expect(rows.length, 'no rows were laid out').toBe(count);

    /**
     * THE SETUP HAS TO FIND THE CONTROL FIRST, or this test proves only that
     * some pixel answers Row. Sweeping the row's own band is how a player finds
     * it too, and it also pins that the control is INSIDE the row rather than
     * floating somewhere the row's fill does not reach.
     */
    const row = rows[1];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const found: { x: number; y: number }[] = [];
    for (let y = row.y; y < row.y + row.h; y += 1) {
      for (let x = row.x; x < row.x + row.w; x += 1) {
        if (rosterHitAt(count, rect, true, x, y)?.kind === RosterHitKind.Delete) {
          found.push({ x, y });
        }
      }
    }

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // With the two tests in the other order this is empty: every pixel of the
    // row, including the button's, answers Row.
    expect(found.length, 'no pixel of the row answers the delete control').toBeGreaterThan(0);

    const hit = rosterHitAt(count, rect, true, found[0]?.x ?? 0, found[0]?.y ?? 0);
    expect(hit?.kind).toBe(RosterHitKind.Delete);
    expect(hit && 'index' in hit ? hit.index : -1, 'the control names the wrong row').toBe(1);
  });

  it('leaves the rest of the row selecting the row', () => {
    const rect = rosterRect(1280, 800);
    const rows = rosterRows(2, rect);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // The LEFT side of the card, where the name is — nowhere near the control,
    // which lives at the right edge beside the shortcut digit.
    const hit = rosterHitAt(2, rect, true, row.x + 4, centre(row).y);
    expect(hit?.kind, 'the control has eaten the whole row').toBe(RosterHitKind.Row);
  });

  it('exists for drawn rows only, never for a character that is off-screen', () => {
    /**
     * ═══ THE SETUP HAS TO ACTUALLY OVERFLOW ═══
     * Eight characters in a panel that only has room for a few. If this window
     * happened to fit all eight, the test below would pass by proving nothing.
     */
    const rect = rosterRect(1280, 320);
    const count = 8;
    const drawn = rosterVisibleCount(count, rect);
    expect(drawn, 'the list did not overflow, so this proves nothing').toBeLessThan(count);
    expect(drawn, 'nothing was drawn at all').toBeGreaterThan(0);

    // No pixel anywhere on the panel may answer Delete for a row that was never
    // laid out — that is a click that deletes a character nobody can see.
    let worst = -1;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const hit = rosterHitAt(count, rect, true, x, y);
        if (hit?.kind === RosterHitKind.Delete) worst = Math.max(worst, hit.index);
      }
    }
    expect(worst, 'a delete control exists for a row that is not on screen').toBeLessThan(drawn);
  });
});

describe('arming it', () => {
  function words(characters: readonly CharacterRow[], armedDeleteId: string | null): string[] {
    const texts: string[] = [];
    const gradient = { addColorStop: (): void => undefined };
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 12 });
          if (prop === 'canvas') return { width: 1280, height: 800 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
            return () => gradient;
          }
          if (prop === 'fillText') {
            return (text: unknown) => {
              texts.push(String(text));
            };
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    drawRoster({
      ctx,
      sprites: { sprite: () => undefined },
      rect: rosterRect(1280, 800),
      characters,
      cases: 27,
      canCreate: true,
      max: 8,
      selected: 0,
      hovered: null,
      armedDeleteId,
      nowMs: 0,
    });
    return texts;
  }

  it('changes the WORD, not only the colour', () => {
    /**
     * The talent panel makes this argument about its armed `+` and it is the
     * same one here: a warning carried entirely by colour is no warning to a
     * player who cannot see the difference between grey and orange. GREY_HI to
     * ORANGE still happens — it is just not the only thing that happens.
     */
    const rows = rowsOf(3);
    const resting = words(rows, null);
    expect(resting.filter((t) => t === 'DEL').length, 'the control was not drawn').toBe(3);
    expect(resting, 'something is armed when nothing should be').not.toContain('SURE?');

    const armed = words(rows, 'chr_0001');
    expect(armed.filter((t) => t === 'SURE?').length, 'arming drew no confirmation').toBe(1);
    expect(armed.filter((t) => t === 'DEL').length, 'the other rows did not stay resting').toBe(2);
  });

  it('arms by id, so a shorter list cannot move the arm onto somebody else', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE REASON THE ARMED STATE IS AN ID AND NOT AN INDEX.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The server answers EVERY delete outcome with the whole roster, so the list
     * can come back one row shorter between the two presses. Armed on index 1,
     * the arm would now be sitting on whichever character slid up into that slot
     * — and the next press would delete the wrong one, with no way back.
     *
     * Armed on `chr_0002`, removing `chr_0000` moves that row from index 2 to
     * index 1 and the arm goes with it, because it was never about the slot.
     */
    const armed = words(
      rowsOf(3).filter((r) => r.id !== 'chr_0000'),
      'chr_0002',
    );
    expect(armed.filter((t) => t === 'SURE?').length, 'the arm was lost with the list').toBe(1);

    // ...and an id that is no longer on the list arms nothing at all, rather
    // than falling back to a position.
    const gone = words(
      rowsOf(3).filter((r) => r.id !== 'chr_0002'),
      'chr_0002',
    );
    expect(gone, 'a deleted character left its arm behind on somebody else').not.toContain('SURE?');
  });
});
