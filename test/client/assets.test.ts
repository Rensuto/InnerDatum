import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadManifest } from '../../src/client/render/assets.ts';
import type { MockInstance } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ART IS NOT DISTRIBUTED, SO "NO ART" IS A SUPPORTED STATE — NOT A FAULT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * client/public/assets/ is excluded from version control in its entirety (see
 * ASSETS-LICENSE.md). A fresh clone therefore has no manifest until somebody
 * runs `npm run assets`, and may never have one at all.
 *
 * That used to take the client down at boot. `loadManifest` threw on any
 * non-OK response, `main.ts` awaits it with no catch, and the throw happened
 * before the canvas existed — so the first thing every person cloning this
 * would have seen is a dead frame and a fetch error naming neither the cause
 * nor the cure.
 *
 * The rule this file defends: A MISSING ASSET MUST NEVER STOP THE GAME FROM
 * STARTING. A 404 is the ordinary state of a fresh clone and boots into
 * placeholder rendering; anything else is a real defect and stays loud.
 *
 * There is no jsdom here (vitest.config.ts is explicit about that), so the two
 * browser globals this path touches are stubbed directly: `fetch`, and
 * `document.baseURI`, which `assetUrl` resolves relative paths against.
 */

const BASE = 'https://example.test/.proxy/';

/** Minimal stand-in for the one Response member this code path reads. */
function reply(status: number, body?: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  // `document` does not exist in the node environment; assetUrl needs baseURI.
  vi.stubGlobal('document', { baseURI: BASE });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('loadManifest with no art installed', () => {
  it('treats a 404 as an empty library rather than an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(reply(404)));

    // The assertion is the absence of a throw as much as the empty array:
    // this is the exact call main.ts awaits on the boot path.
    await expect(loadManifest()).resolves.toEqual([]);
  });

  it('says what is missing and how to fix it, once', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(reply(404)));
    await loadManifest();

    expect(warn).toHaveBeenCalledTimes(1);
    // A warning that does not name the remedy just relocates the confusion.
    const said = String(warn.mock.calls[0]?.[0] ?? '');
    expect(said).toContain('npm run assets');
    expect(said).toContain('ASSETS-REQUIRED.md');
  });

  it('resolves the manifest against baseURI, so the Discord proxy prefix survives', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url);
      return Promise.resolve(reply(404));
    });
    await loadManifest();

    // Relative on purpose. An absolute '/assets/...' would escape the
    // /.proxy/ mount Discord serves the Activity under.
    expect(seen[0]).toBe(`${BASE}assets/manifest.placeholders.json`);
  });
});

describe('loadManifest when something is actually wrong', () => {
  it('still throws on a server error, because that is not a fresh clone', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(reply(500)));

    // 500 means the origin is broken. Booting into placeholders would hide a
    // real outage behind cosmetic damage.
    await expect(loadManifest()).rejects.toThrow('HTTP 500');
  });

  it('throws when the manifest exists but carries no assets array', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(reply(200, { version: 3 })));

    // The file is there, so this is the pipeline emitting something broken.
    await expect(loadManifest()).rejects.toThrow('no "assets" array');
  });

  it('throws when every entry is malformed, rather than booting blank', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(reply(200, { assets: [{ id: '', path: '' }, { nope: true }] })),
    );

    await expect(loadManifest()).rejects.toThrow('no usable assets');
  });
});

describe('loadManifest on a normal install', () => {
  it('keeps the well-formed entries and drops the junk beside them', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        reply(200, {
          assets: [
            { id: 'ui_pip_hp', path: 'ui/pips/ui_pip_hp.png', w: 12, h: 12 },
            { id: 'broken', path: 'x.png', w: '32', h: 32 },
            { id: 'enemy_husk', path: 'enemies/enemy_index_husk_s.png', w: 48, h: 64 },
          ],
        }),
      ),
    );

    const entries = await loadManifest();

    // One bad row must not cost you the other two: the renderer paints a
    // fallback box for whatever is absent, which is strictly better than
    // refusing to draw the sprites that are fine.
    expect(entries.map((e) => e.id)).toEqual(['ui_pip_hp', 'enemy_husk']);
    expect(entries[1]).toEqual({
      id: 'enemy_husk',
      path: 'enemies/enemy_index_husk_s.png',
      w: 48,
      h: 64,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FEATURE THAT NEEDS NEW ART MUST NOT SHIP AS A NEW ASSET PREFIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tests above defend "no art installed" at BOOT. These defend it at DRAW
 * time, for the overlays that keep being tempted into art they cannot have.
 *
 * render/canvas.ts spells the trap out twice — once over `paintPath` and once
 * over `paintProjectiles`: adding a `MarkerKind` member and blitting
 * `ui_tile_marker_<it>` follows the shape of every other overlay in that file
 * and fails loudly for EVERYONE, because the id is in no manifest, the art is
 * gitignored wholesale so a bare clone has no manifest at all, and `blitSprite`
 * resolves a miss to the intentionally shouty violet fallback box. The result is
 * the broken-manifest alarm being fired by a feature that works perfectly, which
 * is the one thing that alarm must never do.
 *
 * A COMMENT CANNOT ENFORCE THAT AND A CANVAS TEST CANNOT EITHER — there is no
 * jsdom here, and mocking a 2D context to count `drawImage` calls would test the
 * mock. So it is pinned by grep: the two overlays that draw with `fillRect`
 * alone must not acquire a sprite, a marker kind, or a prefix to load one under.
 */
describe('the fillRect overlays stay art-free', () => {
  const root = new URL('../../', import.meta.url);
  /**
   * CODE ONLY, COMMENTS STRIPPED, and both halves of that matter here. The
   * prose in these files NAMES the sprite call and the marker ids it is
   * forbidding — that is the comment doing its job — so a grep over the raw text
   * would fail on the warning rather than on the violation, and the obvious fix
   * (delete the warning) is the wrong one. It also keeps an apostrophe in a
   * comment ("the turn cards' portraits") from being read as a string quote.
   */
  function codeOf(path: string): string {
    return readFileSync(new URL(path, root), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }
  const canvasSrc = codeOf('src/client/render/canvas.ts');
  const mainSrc = codeOf('src/client/main.ts');

  it('loads exactly the asset prefixes it loaded before the orb landed', () => {
    // The v7 projectile is drawn as an ORANGE fillRect dot. If this list ever
    // grows a `fx_`, a `ui_orb_` or a second `ui_tile_marker_`-shaped entry for
    // it, somebody has reached for a PNG that does not exist.
    const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(mainSrc);
    expect(block).not.toBeNull();
    const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(prefixes).toEqual([
      'chr_player_',
      'chr_npc_',
      'enemy_',
      'ui_token_ring_',
      'ui_tile_marker_',
      'ui_icon_turn_',
      'ui_hotbar_slot_',
      'ui_pip_',
      'icon_ability_',
      'icon_status_',
      'icon_character_',
      'ui_panel_',
      'ui_marker_',
      'ui_icon_speaking',
    ]);
  });

  it('keeps MarkerKind at the five members that have manifest art', () => {
    // `ui_tile_marker_${kind}` is blitted from this enum in two places, so a
    // sixth member is a sixth PNG demanded of every clone.
    const block = /export const MarkerKind = \{([\s\S]*?)\} as const;/.exec(canvasSrc);
    expect(block).not.toBeNull();
    const kinds = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(kinds).toEqual(['cursor', 'valid', 'invalid', 'aoe', 'minrange']);
  });

  it('paints projectiles with fillRect and never with blitSprite', () => {
    const from = canvasSrc.indexOf('function paintProjectiles(');
    const to = canvasSrc.indexOf('function cornerTicks(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = canvasSrc.slice(from, to);

    expect(body).not.toContain('blitSprite');
    expect(body).not.toContain('drawImage');
    expect(body).toContain('PALETTE.ORANGE');
    // The 1px INK surround, the legibility trick the status pips use: the orb
    // crosses floor, wall and the lit top edge of a wall in one flight.
    expect(body).toContain('PALETTE.INK');
    // Never GOLD (the player's own route and cursor — an enemy orb in gold reads
    // as your own aim), never CRIMSON (reserved for "hostiles are engaged"), and
    // never VIOLET_HI, which IS the missing-asset box.
    expect(body).not.toContain('PALETTE.GOLD');
    expect(body).not.toContain('PALETTE.CRIMSON');
    expect(body).not.toContain('PALETTE.VIOLET_HI');
  });

  it('still paints the travel route with fillRect and never with blitSprite', () => {
    const from = canvasSrc.indexOf('function paintPath(');
    const to = canvasSrc.indexOf('function paintProjectiles(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = canvasSrc.slice(from, to);

    expect(body).not.toContain('blitSprite');
    expect(body).toContain('PALETTE.GOLD');
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE TWO v8 PANELS ASK FOR NO ART THAT IS NOT ALREADY ON THE WIRE
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ui/classpicker.ts is the FIRST SCREEN a new player ever sees, and
   * ui/charsheet.ts is opened by a key on every floor. Both are full of
   * pictures — three portraits, three map tokens, sixteen ability icons — and
   * every one of those keys arrives on the wire (`ClassOptionView.sprite`,
   * `.portrait`, `LoadoutTalent.icon`). None is built here.
   *
   * The temptation these pin against is the one Birther.lua fell to and got
   * away with: ToME MANGLES a class name into a filename
   * (`t.name:lower():gsub("[^a-z0-9]", "_")`, Birther.lua:47-48) and survives a
   * miss because it ships `unknown_32_bg.png`. We cannot ship that fallback —
   * client/public/assets/ is gitignored wholesale — so a derived key resolves to
   * the LOUD violet missing-asset box on a bare clone, on the chooser, on the
   * first screen. A comment cannot enforce that. This can.
   */
  const sheetSrc = codeOf('src/client/ui/charsheet.ts');
  const pickerSrc = codeOf('src/client/ui/classpicker.ts');
  const panels: readonly (readonly [string, string])[] = [
    ['ui/charsheet.ts', sheetSrc],
    ['ui/classpicker.ts', pickerSrc],
  ];

  it('asks the sprite source only for keys that came off the wire', () => {
    // The prefix list is READ FROM main.ts rather than spelled again here, so
    // the two cannot drift: adding a prefix there is already pinned above.
    const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(mainSrc);
    const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(prefixes.length).toBeGreaterThan(0);

    for (const [name, src] of panels) {
      const args = [...src.matchAll(/sprites\.sprite\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim());
      // Both files DO ask for sprites — a pin over zero call sites passes
      // forever and proves nothing.
      expect(args.length, `${name} draws no sprites at all?`).toBeGreaterThan(0);

      for (const arg of args) {
        const literal = /^['"`]/.test(arg);
        if (!literal) {
          // An expression: it is a wire field or a parameter carrying one.
          // What it must NOT be is a key assembled from a name.
          expect(arg, `${name} builds a sprite key: ${arg}`).not.toMatch(/[+`]/);
          continue;
        }
        const id = arg.slice(1, -1);
        expect(
          prefixes.some((prefix) => id.startsWith(prefix)),
          `${name} asks for '${id}', which is under no indexed prefix`,
        ).toBe(true);
      }
    }
  });

  it('spends neither of the two reserved palette entries', () => {
    for (const [name, src] of panels) {
      // CRIMSON means "hostiles are engaged" and nothing else; VIOLET_HI IS the
      // missing-asset box. A selected class card is marked with a drawn border,
      // the word SELECTED and GOLD — never a reserved colour, and never colour
      // alone (ui/partypanel.ts:78-92).
      expect(src, `${name} spends CRIMSON`).not.toContain('CRIMSON');
      expect(src, `${name} spends VIOLET_HI`).not.toContain('VIOLET_HI');
    }
  });
});
