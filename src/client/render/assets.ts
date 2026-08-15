/**
 * Asset loading: the manifest, the image cache, and the synchronous lookup the
 * renderer uses while drawing a frame.
 *
 * WHY A MANIFEST AT ALL. `ActorView.sprite` on the wire is an asset KEY
 * ('chr_player_watchman_s'), never a path. The server therefore never needs to
 * know how the art is cut, and re-cutting an atlas cannot invalidate a save
 * file. This module is the only place that turns a key into a URL, and
 * client/public/assets/manifest.placeholders.json is the only table it reads.
 * The manifest is fetched at runtime rather than imported, because it and the
 * PNGs it indexes are the author's proprietary art and must stay OUT of the
 * GPL-licensed JS bundle as separate files on disk (see build.assetsInlineLimit
 * in vite.config.ts — same rule, other end).
 *
 * THE BASE PATH IS RELATIVE, AND THAT IS LOAD-BEARING.
 * `./assets/foo.png`, never `/assets/foo.png`. Inside a Discord Activity the
 * app is served through Discord's proxy, which can mount it under a `/.proxy/`
 * prefix; a root-absolute URL then resolves against the proxy's root instead of
 * the app's and returns Discord's 404 rather than the art. Resolving against
 * `document.baseURI` gets this right under `/`, under `/.proxy/`, and under the
 * Vite dev server, with no environment switch.
 */

/**
 * One entry from the manifest. The file carries more fields (provenance,
 * method, milestone, sha256_16); only these four are load-bearing at runtime,
 * and reading a narrow subset means the asset pipeline can add columns without
 * touching the client.
 */
export type AssetEntry = {
  readonly id: string;
  readonly path: string;
  readonly w: number;
  readonly h: number;
};

/** A decoded image plus its intrinsic size, ready to blit. */
export type Sprite = {
  readonly id: string;
  readonly image: HTMLImageElement;
  readonly w: number;
  readonly h: number;
};

/**
 * The renderer's view of the asset store: one synchronous lookup, no promises.
 * A frame must never await anything, so everything drawable is loaded before
 * the first draw and a miss is a visible fallback rather than a stall.
 */
export type SpriteSource = {
  readonly sprite: (id: string) => Sprite | undefined;
};

export type AssetLibrary = SpriteSource & {
  /** The entries this library attempted to load, in manifest order. */
  readonly entries: readonly AssetEntry[];
  readonly entry: (id: string) => AssetEntry | undefined;
  /** Ids whose PNG failed to load. Non-fatal; the renderer draws a loud box. */
  readonly missing: readonly string[];
};

/** Relative on purpose — see the header. Do not "fix" this to '/assets/'. */
const ASSET_BASE = './assets/';
const MANIFEST_FILE = 'manifest.placeholders.json';

/**
 * Resolve an asset path from the manifest into a URL for THIS deployment.
 *
 * `document.baseURI` is the document's own URL (or a <base> if one is ever
 * added), so this follows the app wherever the proxy mounts it.
 */
export function assetUrl(relativePath: string): string {
  return new URL(`${ASSET_BASE}${relativePath}`, document.baseURI).href;
}

// ---------------------------------------------------------------------------
// Image cache
// ---------------------------------------------------------------------------

/**
 * Keyed by resolved URL, and holding the PROMISE rather than the image: two
 * callers asking for the same PNG at the same time must share one request, not
 * race two. A failed load is evicted so a later retry is not permanently poisoned
 * by a cached rejection.
 */
const imageCache = new Map<string, Promise<HTMLImageElement>>();

/** Load (or return the in-flight load of) one image by resolved URL. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached !== undefined) return cached;

  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener(
      'load',
      () => {
        resolve(image);
      },
      { once: true },
    );
    image.addEventListener(
      'error',
      () => {
        imageCache.delete(url);
        reject(new Error(`asset failed to load: ${url}`));
      },
      { once: true },
    );
    image.src = url;
  });

  imageCache.set(url, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows an `unknown` to `any[]`, which then leaks `any`
 * through every element read. This narrows to `readonly unknown[]` instead, so
 * each field still has to be checked before it is used.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function toEntry(value: unknown): AssetEntry | null {
  if (!isRecord(value)) return null;
  const { id, path, w, h } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  return { id, path, w, h };
}

/**
 * Fetch and parse the asset manifest.
 *
 * Hand-rolled validation rather than zod: this file is a build artifact from
 * our own pipeline sitting on our own origin, not attacker-controlled input, so
 * the job here is "fail with a readable message if the pipeline regressed", not
 * "defend a trust boundary". The one trust boundary in this system is the
 * server's socket dispatch, and it is the only place zod belongs.
 */
export async function loadManifest(): Promise<readonly AssetEntry[]> {
  const url = assetUrl(MANIFEST_FILE);
  const response = await fetch(url, { credentials: 'same-origin' });

  // A 404 here is not damage — it is the ordinary state of a fresh clone.
  //
  // The artwork is not distributed with this repository (see ASSETS-LICENSE.md)
  // and the manifest is generated FROM that artwork, so the two are absent
  // together. Throwing would take the whole client down at boot, before the
  // canvas exists, behind a fetch error that names neither the cause nor the
  // cure — and it would do that to every single person who clones this.
  //
  // So an absent art tree boots into an entirely playable game drawn in
  // fallback boxes, and says once, in words, what is missing and how to fix it.
  // Every other manifest failure below still throws: those mean the pipeline
  // produced something broken, which is a real defect and should be loud.
  if (response.status === 404) {
    console.warn(
      `No asset manifest at ${url} — the artwork is not distributed with this ` +
        `repository, so the game will draw placeholder boxes. ` +
        `Run \`npm run assets\` to generate the procedural set, and see ` +
        `ASSETS-REQUIRED.md for the sprites you need to supply yourself.`,
    );
    return [];
  }

  if (!response.ok) {
    throw new Error(`asset manifest ${url} returned HTTP ${response.status}`);
  }

  const raw: unknown = await response.json();
  if (!isRecord(raw) || !isUnknownArray(raw.assets)) {
    throw new Error(`asset manifest ${url} has no "assets" array`);
  }

  const entries: AssetEntry[] = [];
  for (const item of raw.assets) {
    const entry = toEntry(item);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error(`asset manifest ${url} listed no usable assets`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function tryLoadSprite(entry: AssetEntry): Promise<Sprite | null> {
  try {
    const image = await loadImage(assetUrl(entry.path));
    // The decoded image is the truth on disk; the manifest is the declared
    // contract. When they disagree, someone re-cut the art without rerunning
    // `npm run assets`, and the sprite would silently draw at the wrong anchor.
    const w = image.naturalWidth > 0 ? image.naturalWidth : entry.w;
    const h = image.naturalHeight > 0 ? image.naturalHeight : entry.h;
    if (w !== entry.w || h !== entry.h) {
      console.warn(
        `asset ${entry.id} is ${w}x${h} on disk but ${entry.w}x${entry.h} in the manifest`,
      );
    }
    return { id: entry.id, image, w, h };
  } catch (error) {
    console.warn(`asset ${entry.id} failed to load`, error);
    return null;
  }
}

/**
 * Load a set of manifest entries into a library.
 *
 * One broken PNG must not black out the game: failures are collected into
 * `missing` and the renderer paints its fallback box for them. A missing token
 * ring is a cosmetic bug; a client that refuses to boot because of one is an
 * outage.
 */
export async function loadSprites(entries: readonly AssetEntry[]): Promise<AssetLibrary> {
  const results = await Promise.all(
    entries.map(async (entry) => ({ entry, sprite: await tryLoadSprite(entry) })),
  );

  const byId = new Map<string, Sprite>();
  const index = new Map<string, AssetEntry>();
  const missing: string[] = [];
  for (const result of results) {
    index.set(result.entry.id, result.entry);
    if (result.sprite === null) {
      missing.push(result.entry.id);
    } else {
      byId.set(result.entry.id, result.sprite);
    }
  }

  return {
    entries,
    missing,
    sprite: (id) => byId.get(id),
    entry: (id) => index.get(id),
  };
}

/**
 * Manifest + images in one call.
 *
 * `select` exists so the client loads the ~15 PNGs a session actually draws
 * instead of all 99: adding art to the pipeline should not add latency to the
 * boot path, and the selector lives at the call site that knows what it renders.
 */
export async function loadAssetLibrary(
  select?: (entry: AssetEntry) => boolean,
): Promise<AssetLibrary> {
  const all = await loadManifest();
  const wanted = select === undefined ? all : all.filter(select);
  return loadSprites(wanted);
}
