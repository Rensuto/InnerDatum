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
