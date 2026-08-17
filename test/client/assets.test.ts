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

    // ═══════════════════════════════════════════════════════════════════════
    // THE DISTINCTION THIS ASSERTION EXISTS TO DRAW, IN ONE SENTENCE:
    // A PREFIX FOR ART THAT IS ALREADY IN THE MANIFEST IS FINE. A PREFIX
    // INVENTED FOR ART THAT DOES NOT EXIST IS THE BUG.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // A prefix does not create a PNG. `isNeeded` FILTERS the manifest, so listing
    // a family that exists loads it, and listing one that does not is a harmless
    // no-op — `icon_ability_` has been exactly that since M3, on purpose, and is
    // documented as such at the array. The failure this pin is for is the other
    // direction: a feature that needs a picture nobody has cut, shipping a prefix
    // to load it under. client/public/assets/ is gitignored wholesale, so there is
    // no fallback file anywhere and `blitSprite` resolves the miss to the loud
    // violet missing-asset box — on every clone, for a feature that works.
    //
    // The three v10 entries are the FIRST kind. Verified against the COMMITTED
    // ASSETS-REQUIRED.md:84-109 (and, on this working tree, the files on disk —
    // but `client/public/assets/` is gitignored whole, manifest included, so the
    // markdown is the only half a clone can check): 23 `item_*` ids under items/,
    // 5 `ui_item_frame_*` and 2 `ui_inventory_cell_*` under ui/chrome/. The v10 map mark, by contrast, is
    // drawn with `fillRect` and asked for no prefix at all — see the `paintLoot`
    // pin below, which is the same decision from the other side.
    //
    // DELIBERATELY ABSENT: anything covering the four ids in
    // client/public/assets/items/_aliases.json. That file's `_comment` claims they
    // resolve and it is WRONG — no `icon_weapon_*` id is in the manifest and no
    // such PNG is on disk — so a prefix for them would be the invented case above,
    // wearing a comment that says otherwise.
    // `icon_active_` REPLACED `icon_ability_` HERE, AND THAT IS NOT THE THING
    // THIS TEST GUARDS AGAINST. The list is the same LENGTH — no prefix was
    // added, so no new art was smuggled in. `icon_ability_` matched zero assets
    // in every manifest this project has ever produced; every talent in
    // src/server/talents/ declares `iconId: 'icon_active_<name>'`. The dead
    // spelling filtered all twelve hand-drawn talent icons out of the load,
    // which is why the hotbar drew "AF AV B MW" for weeks after the art landed.
    //
    // Correcting a prefix that resolves to NOTHING, to one that resolves to
    // twelve assets already listed in the manifest and already on disk, is the
    // opposite of inventing a prefix for art that does not exist.
    // `tile_ow_` IS THE ONE ENTRY HERE THAT MATCHES NOTHING ON DISK TODAY, and
    // it is added with that stated rather than hidden, because it is the exact
    // shape this test exists to catch. Three things make it the legitimate case
    // and not the invented one:
    //
    //   1. THE IDS ARE SPECIFIED, not hoped for. All twenty are named in
    //      ART-OVERWORLD.md and enumerated in `TILE_SPRITES` in
    //      render/canvas.ts. This is a contract with art in production, not a
    //      prefix cast into the dark.
    //   2. THE FALLBACK IS GOOD, which no other family here can say. A missing
    //      token draws `blitSprite`'s loud violet box, because an invisible
    //      player must be loud. A missing TERRAIN tile draws the flat palette
    //      colour the renderer has always used — so zero tiles on disk is a
    //      legible, playable city, and each delivered file improves it with no
    //      code change. `paintTerrain` returns false rather than calling
    //      `blitSprite` precisely so 3,000 cells cannot become 3,000 violet
    //      boxes.
    //   3. IT COSTS NOTHING WHILE EMPTY. `loadSprites` only fetches manifest
    //      entries, and the manifest has no `tile_ow_*` rows yet, so this
    //      prefix currently admits zero requests.
    //
    // Contrast the deliberately-absent `icon_weapon_*` above: those ids are
    // claimed to resolve by a file that is wrong, resolve to nothing, and have
    // no fallback but the violet box.
    expect(prefixes).toEqual([
      'chr_player_',
      'chr_npc_',
      'enemy_',
      'tile_ow_',
      'ui_token_ring_',
      'ui_tile_marker_',
      'ui_icon_turn_',
      'ui_hotbar_slot_',
      'ui_pip_',
      'icon_active_',
      'icon_status_',
      'icon_character_',
      'ui_panel_',
      'ui_marker_',
      'ui_icon_speaking',
      'item_',
      'ui_inventory_cell_',
      'ui_item_frame_',
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
    // THE SLICE ENDS AT `paintLoot`, NOT AT `paintProjectiles`. v10 inserted a
    // third fillRect overlay between the two, and a range that swallowed it would
    // quietly make the pin below redundant while looking like it still had one
    // job — the failure mode a range-based grep has and a named one does not.
    const from = canvasSrc.indexOf('function paintPath(');
    const to = canvasSrc.indexOf('function paintLoot(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = canvasSrc.slice(from, to);

    expect(body).not.toContain('blitSprite');
    expect(body).toContain('PALETTE.GOLD');
  });

  it('paints what is on the floor with fillRect and never with blitSprite', () => {
    // ═══ THE v10 FLOOR MARK IS THE THIRD ART-FREE OVERLAY, AND IT HAD TWO
    //     TEMPTATIONS RATHER THAN ONE ═══
    // The first is `paintProjectiles`' own: a `MarkerKind.Loot` member and a
    // `ui_tile_marker_loot` blit, which follows the shape of every other overlay
    // in that file and demands a PNG of every clone. The MarkerKind pin above
    // covers half of that; this covers the other half.
    //
    // The second is SPECIFIC to this overlay and is why it earns its own test:
    // the item's own 64x64 icon IS in the manifest now — the three v10 prefixes
    // put it there — so drawing it here would resolve, look almost right, and be
    // wrong twice. A tile is 32x32, so it means either a downscale (the exact
    // resampling the backbuffer exists to prevent) or a centre crop (a quarter of
    // a picture, identifying nothing). The panel is where an icon is legible; the
    // map gets a mark.
    const from = canvasSrc.indexOf('function paintLoot(');
    const to = canvasSrc.indexOf('function paintProjectiles(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = canvasSrc.slice(from, to);

    expect(body).not.toContain('blitSprite');
    expect(body).not.toContain('drawImage');
    // The 1px INK surround, the same legibility trick the pips and the orb use: a
    // pile sits on floor, beside a wall and under the lit top edge of a wall.
    expect(body).toContain('PALETTE.INK');
    // Never VIOLET_HI, which IS the missing-asset box — a floor mark painted in it
    // is indistinguishable from the bug. Never CRIMSON, reserved for "hostiles are
    // engaged". Never GOLD, this file's affirmative/cursor colour, already spent
    // on the player's own route and targeting bracket: a pile in gold reads as
    // your own aim, and the route is frequently drawn straight at the pile.
    expect(body).not.toContain('PALETTE.VIOLET_HI');
    expect(body).not.toContain('PALETTE.CRIMSON');
    expect(body).not.toContain('PALETTE.GOLD');
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE THREE PANELS ASK FOR NO ART THAT IS NOT ALREADY ON THE WIRE
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ui/classpicker.ts is the FIRST SCREEN a new player ever sees,
   * ui/charsheet.ts is opened by a key on every floor, and ui/talents.ts (v9) is
   * where a levelled detective spends an irreversible point. All three are full
   * of pictures — three portraits, three map tokens, twenty-odd ability icons —
   * and every one of those keys arrives on the wire (`ClassOptionView.sprite`,
   * `.portrait`, `LoadoutTalent.icon`). None is built here.
   *
   * The temptation these pin against is the one Birther.lua fell to and got
   * away with: ToME MANGLES a class name into a filename
   * (`t.name:lower():gsub("[^a-z0-9]", "_")`, Birther.lua:47-48) and survives a
   * miss because it ships `unknown_32_bg.png`. We cannot ship that fallback —
   * client/public/assets/ is gitignored wholesale — so a derived key resolves to
   * the LOUD violet missing-asset box on a bare clone, on the chooser, on the
   * first screen. A comment cannot enforce that. This can.
   *
   * A NEW PANEL IS COVERED BY NEITHER GUARD UNTIL IT IS LISTED HERE, which is
   * why ui/talents.ts joined this array in the same commit that created it: the
   * panel draws four icon plates and a `+` control, and both of those are exactly
   * the shape of a feature that reaches for a PNG on its second revision.
   *
   * ui/inventory.ts (v10) joins on the same terms and is the heaviest user of art
   * of the four: up to twelve 64x64 item icons, a rarity frame behind every one of
   * them, and an empty-slot plate. It is also the FIRST panel here to name asset
   * ids as literals in its own source — `frameIdFor` returns one of three
   * `ui_item_frame_*` strings by an exhaustive switch precisely so a key is never
   * assembled from a wire field — which is what the third assertion below exists
   * to keep honest.
   */
  const sheetSrc = codeOf('src/client/ui/charsheet.ts');
  const pickerSrc = codeOf('src/client/ui/classpicker.ts');
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THIRD COLUMN IS "DOES THIS PANEL REACH THE SPRITE SOURCE AT ALL", AND IT
   * IS DATA BECAUSE THE ALTERNATIVE WAS WEAKENING THE GUARD FOR ALL FIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   * Adding ui/escapemenu.ts first turned the per-file `expect(args.length)
   * .toBeGreaterThan(0)` into a single aggregate sum, which passes as long as ANY
   * ONE entry in this array asks for a sprite. That gives up exactly the thing
   * the assertion exists for: route ui/inventory.ts's `sprites.sprite(...)`
   * through a shared helper in another module and its own `args.length` drops to
   * zero, the literal/assembled-key audit for that file silently covers no call
   * sites, and the aggregate stays green on the strength of the other three —
   * "a pin over zero call sites passes forever and proves nothing", restated.
   *
   * So the exemption is named per file instead. `false` means "this panel reaches
   * art ONLY through ui/panel.ts's `drawPanel` / `drawHeader` / `drawButton`",
   * which is true of ui/escapemenu.ts by design: there is no gear, keyboard,
   * settings or scrollbar in the manifest and it must not invent one for a test.
   * A panel that later STARTS drawing sprites, or one that stops, now fails
   * loudly in the row that made the claim.
   */
  const panels: readonly (readonly [string, string, boolean])[] = [
    ['ui/charsheet.ts', sheetSrc, true],
    ['ui/classpicker.ts', pickerSrc, true],
    ['ui/talents.ts', codeOf('src/client/ui/talents.ts'), true],
    ['ui/inventory.ts', codeOf('src/client/ui/inventory.ts'), true],
    ['ui/escapemenu.ts', codeOf('src/client/ui/escapemenu.ts'), false],
  ];

  it('asks the sprite source only for keys that came off the wire', () => {
    // The prefix list is READ FROM main.ts rather than spelled again here, so
    // the two cannot drift: adding a prefix there is already pinned above.
    const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(mainSrc);
    const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(prefixes.length).toBeGreaterThan(0);

    // A pin over zero call sites passes forever and proves nothing, so every
    // panel that claims to draw art is checked to still be doing it — PER FILE,
    // against the third column, so one panel's call sites cannot vouch for
    // another's. See the array's own note.
    for (const [name, src, drawsSprites] of panels) {
      const args = [...src.matchAll(/sprites\.sprite\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim());
      expect(
        args.length > 0,
        drawsSprites
          ? `${name} draws no sprites at all any more — this audit now covers zero call sites`
          : `${name} has started drawing sprites; flip its column to true so it is audited`,
      ).toBe(drawsSprites);

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

  it('names no asset id that is under no indexed prefix', () => {
    // ═══ THE HALF THE ASSERTION ABOVE CANNOT SEE ═══
    // The four panels that draw art reach the sprite source through a one-line helper
    // (`const sprite = sprites.sprite(id)`), so the literal branch above matches
    // nothing in any of them and only the "never assemble a key" half is live.
    // The ids themselves are handed to that helper from somewhere ELSE in the
    // file — `blitCentred(ctx, sprites, 'ui_item_frame_common', box)` — where a
    // grep for `sprites.sprite(` will never find them.
    //
    // So this reads the ids directly: every string literal in a panel that LOOKS
    // like an asset key must be under a prefix main.ts actually loads. It is the
    // rule the prefix pin states from the manifest's end, checked from the
    // drawing end, and it is what would have caught a `ui_tile_marker_loot` typed
    // into a panel instead of into the renderer.
    const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(mainSrc);
    const prefixes = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(prefixes.length).toBeGreaterThan(0);

    // The families the pipeline emits (tools/build_asset_manifest.py). A literal
    // that starts with one of these is an asset key by construction — no other
    // kind of string in these files does.
    const looksLikeAnAssetId = /^(chr_|enemy_|icon_|item_|ui_)[a-z0-9_]+$/;

    let seen = 0;
    for (const [name, src] of panels) {
      for (const match of src.matchAll(/'([^']*)'/g)) {
        const id = match[1] ?? '';
        if (!looksLikeAnAssetId.test(id)) continue;
        seen += 1;
        expect(
          prefixes.some((prefix) => id.startsWith(prefix)),
          `${name} names '${id}', which is under no indexed prefix`,
        ).toBe(true);
      }
    }
    // A pin over zero literals passes forever and proves nothing. ui/inventory.ts
    // has four (three rarity frames and the empty-slot plate); if that drops to
    // zero, somebody has moved them somewhere this test cannot see.
    expect(seen, 'no panel names an asset id at all?').toBeGreaterThan(0);
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

describe('interiors stay flat, and the overworld does not', () => {
  // THE RULE, PINNED RATHER THAN LEFT AS AN ACCIDENT OF A TABLE. The city is
  // hand-authored and gets real terrain art; an inner-world is instanced,
  // disposable and headed for a generator, and flat palette cells are the right
  // look for that rather than a placeholder for a better one — a generator that
  // needed a matching tile for every new room shape would be a generator whose
  // every change is an art commission.
  //
  // Read from disk for the same reason the prefix pin above is: `TILE_SPRITES`
  // is module-private, and exporting it purely to be asserted on would widen the
  // renderer's surface to satisfy a test.
  // Same URL-relative read the overlay pins above use — this file has no
  // node:path import, and adding one for a single join would be the wrong kind
  // of tidy.
  const source = readFileSync(
    new URL('../../src/client/render/canvas.ts', import.meta.url),
    'utf8',
  );
  const table = source.split('const TILE_SPRITES')[1]?.split('};')[0] ?? '';

  it('gives FLOOR and WALL no sprite, so an inner-world needs no art at all', () => {
    expect(table).not.toBe('');
    expect(table).not.toContain('TileCode.FLOOR');
    expect(table).not.toContain('TileCode.WALL');
  });

  it('gives every overworld code one, so Alderbrook is drawn', () => {
    for (const code of [
      'COBBLE',
      'PAVING',
      'GREEN',
      'MIRE',
      'SOOT',
      'RAIL',
      'BRIDGE',
      'TERRACE',
      'CIVIC',
      'WORKS',
      'TREES',
      'ERASED',
      'WATER',
    ]) {
      expect(table, `${code} has no tile sprite`).toContain(`TileCode.${code}`);
    }
  });

  it('names only tile_ow_ sprites, so no interior art can creep in', () => {
    const ids = [...table.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^tile_ow_/);
  });
});
