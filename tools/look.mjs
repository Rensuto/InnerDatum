// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// LOOK AT THE GAME. `node tools/look.mjs [--all] [--open-doors] [--px 8] [--out shot.png]`
// ═══════════════════════════════════════════════════════════════════════════
//
// Every art decision in this project so far has been made BLIND. The world was
// repainted, a variant hash was replaced because its first row was literally
// `012345012345`, the viewport was widened, towns were given their own
// landmarks — and not one of those changes was ever looked at. The only picture
// anybody has seen of this game is the one the player photographed to say the
// overworld was hard to read.
//
// That is a bad way to build the half of the brief that is entirely visual, so
// this composites a frame offline, from the real sprites, and writes a PNG.
//
// ═══ IT JOINS AS A PLAYER RATHER THAN RECONSTRUCTING THE MAP ═══
//
// It boots the server, opens a socket, picks a class and renders THE FRAMES IT
// WAS SENT — the same `realm.level` tiles and the same `sites` list the browser
// gets, including each site's `marker` and `landmark`. A tool that rebuilt the
// world from `level.ts` instead would be a second renderer, and the first thing
// it would stop reproducing is the bug you are looking for.
//
// For the same reason `TILE_SPRITES`, `tileVariant` and `DEFAULT_VIEWPORT` are
// IMPORTED from `render/canvas.ts` rather than restated here. A hand-written
// second copy of a table one file owns is the shape this codebase has been
// bitten by repeatedly.
//
// ═══ NO DEPENDENCY, INCLUDING FOR THE PNGs ═══
// `zlib` is in Node and PNG is inflate plus five filter types, so decode and
// encode are ~60 lines below. Adding a dependency to look at a picture would be
// a poor trade in a project whose runtime is deliberately four packages.
//
//   node tools/look.mjs                 the player's viewport, 1:1, as shipped
//   node tools/look.mjs --site site:alderbrook --actor chr_player_redactor_s
//                                       a pure local scale probe with chosen actor
//   node tools/look.mjs --all --px 6    the whole world at 6px a tile
//
// PLAIN .mjs AND NOT IN THE TS BUILD, like everything else in tools/.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { WebSocket } from 'ws';

import {
  DEFAULT_VIEWPORT,
  LOCAL_WALL_FACE_SPRITES,
  TILE_SPRITES,
  localDoorSpriteId,
  settlementRoofSpriteId,
  tileSpritesForRealm,
  tileVariant,
} from '../src/client/render/canvas.ts';
import { isWalkable, TileCode } from '../src/shared/protocol.ts';
// THE SERVER'S OWN NUMBER, NEVER A LITERAL. These tools hardcoded `v: 18`
// and could not connect at all from the day PROTOCOL_VERSION became 19 — the
// handshake was refused with `version_mismatch` and the fixed sleep after it
// turned that into "Cannot read properties of undefined". Eight gameplay
// verification tools were dead and silent about it.
import { PROTOCOL_VERSION } from '../src/shared/version.ts';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = fileURLToPath(new URL('../client/public/assets/', import.meta.url));

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const WHOLE = process.argv.includes('--all');
const PX = Number(argOf('--px', WHOLE ? '8' : '64'));
const OUT = argOf('--out', WHOLE ? 'world.png' : 'view.png');
const PORT = argOf('--port', '31991');
const SITE = argOf('--site', null);
const OVERWORLD = process.argv.includes('--overworld');
const OPEN_DOORS = process.argv.includes('--open-doors');
const ACTOR = argOf('--actor', 'chr_player_watchman_s');

// ═══════════════════════════════════════════════════════════════════════════
// PNG, BOTH WAYS.
// ═══════════════════════════════════════════════════════════════════════════

/** Decode an 8-bit PNG to `{w, h, rgba}`. Loud on anything the art tree is not. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    at += 12 + len;
  }
  if (ihdr === null) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${String(ihdr.depth)} interlace ${String(ihdr.interlace)}`,
    );
  }
  // 6 = RGBA, 2 = RGB. The whole art tree is 6; 2 is here so a stray export reads.
  const chan = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 0;
  if (chan === 0) throw new Error(`unsupported PNG colour type ${String(ihdr.color)}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * chan;
  const out = Buffer.alloc(ihdr.w * ihdr.h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // The five filters, verbatim from the spec. `a` is the pixel to the left,
    // `b` the one above, `c` the one above-left.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= chan ? line[i - chan] : 0;
      const b = prev[i];
      const c = i >= chan ? prev[i - chan] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < ihdr.w; x += 1) {
      const s = x * chan;
      const d = (y * ihdr.w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = chan === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w: ihdr.w, h: ihdr.h, rgba: out };
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (b) => {
    let c = -1;
    for (const byte of b) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function encodePng(w, h, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y += 1) {
    rows[y * (w * 4 + 1)] = 0; // filter none: this is written once and read by eye
    rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE CANVAS.
// ═══════════════════════════════════════════════════════════════════════════

const nameOf = (code) => Object.entries(TileCode).find(([, v]) => v === code)?.[0] ?? String(code);

const cache = new Map();
/** A sprite by id, or null. Missing art is a MISS, never a throw — see `paintTerrain`. */
function spriteOf(id) {
  if (cache.has(id)) return cache.get(id);
  let found = null;
  for (const dir of [
    'tiles/world-settlement',
    'tiles/local',
    'tiles',
    'characters/commission',
    'characters',
    'props/commission',
    'props',
    'enemies',
    'items',
    'ui',
    'branding',
  ]) {
    const p = `${ASSETS}${dir}/${id}.png`;
    if (existsSync(p)) {
      found = decodePng(readFileSync(p));
      break;
    }
  }
  cache.set(id, found);
  return found;
}

function makeCanvas(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { w, h, rgba };
}

/**
 * Draw a sprite into a cell, AREA-AVERAGED when the cell is smaller than 32px.
 *
 * Nearest-neighbour at 6px a tile throws away five of every six pixels, and the
 * question this tool exists to answer — does the ground read as one country or
 * as noise — is exactly the question that sampling destroys.
 */
function blitSized(dst, sprite, dx, dy, dw, dh) {
  if (sprite === null) return false;
  const stepX = sprite.w / dw;
  const stepY = sprite.h / dh;
  for (let y = 0; y < dh; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < dw; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (
        let sy = Math.floor(y * stepY);
        sy < Math.max(Math.floor((y + 1) * stepY), Math.floor(y * stepY) + 1);
        sy += 1
      ) {
        for (
          let sx = Math.floor(x * stepX);
          sx < Math.max(Math.floor((x + 1) * stepX), Math.floor(x * stepX) + 1);
          sx += 1
        ) {
          if (sx >= sprite.w || sy >= sprite.h) continue;
          const s = (sy * sprite.w + sx) * 4;
          r += sprite.rgba[s];
          g += sprite.rgba[s + 1];
          b += sprite.rgba[s + 2];
          a += sprite.rgba[s + 3];
          n += 1;
        }
      }
      if (n === 0) continue;
      const alpha = a / n / 255;
      if (alpha <= 0) continue;
      const d = (ty * dst.w + tx) * 4;
      dst.rgba[d] = Math.round((r / n) * alpha + dst.rgba[d] * (1 - alpha));
      dst.rgba[d + 1] = Math.round((g / n) * alpha + dst.rgba[d + 1] * (1 - alpha));
      dst.rgba[d + 2] = Math.round((b / n) * alpha + dst.rgba[d + 2] * (1 - alpha));
    }
  }
  return true;
}

function blit(dst, sprite, dx, dy, px) {
  return blitSized(dst, sprite, dx, dy, px, px);
}

function cropSprite(sprite, x, y, w, h) {
  if (sprite === null) return null;
  const crop = { w, h, rgba: Buffer.alloc(w * h * 4) };
  for (let row = 0; row < h; row += 1) {
    const sourceStart = ((y + row) * sprite.w + x) * 4;
    const targetStart = row * w * 4;
    sprite.rgba.copy(crop.rgba, targetStart, sourceStart, sourceStart + w * 4);
  }
  return crop;
}

/** Match the live renderer: native aspect ratio, bottom-centred in one cell. */
function blitActor(dst, sprite, cellX, cellY, px) {
  if (sprite === null) return false;
  const scale = px / 64;
  const dw = Math.max(1, Math.round(sprite.w * scale));
  const dh = Math.max(1, Math.round(sprite.h * scale));
  const dx = cellX + Math.floor((px - dw) / 2);
  const dy = cellY + px - dh;
  return blitSized(dst, sprite, dx, dy, dw, dh);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `--sheet` — EVERY VARIANT OF EVERY TERRAIN, ONE ROW EACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A variant set is supposed to break up a texture, not to change what the
 * ground IS. Measured across the installed art, `TREES` spans 19 units of mean
 * colour and `PLAINS` spans 0.7 — while `FIELD` spans 167 and `MOUNTAIN` 140.
 * Those are not variants; they are different terrains being dealt out per tile
 * by a hash, which is exactly what "it looks checkerboarded" describes.
 *
 * Needs no server: it reads the table and the disk, so it runs in a repo with
 * the art installed and nothing else.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `--variants` — IS EACH VARIANT SET THE SAME TERRAIN?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A variant breaks up a texture. It must not change what the ground IS, because
 * the position hash scatters the set evenly and a set holding two different
 * colours draws confetti — which is precisely the word a player used about the
 * overworld ("it looks checkerboarded").
 *
 * The number is the largest pairwise distance between the MEAN COLOURS of a
 * set, in RGB. Coherent sets measure in the low tens; the three that shipped
 * broken measured 167, 140 and 116, every one of them because
 * `import-overworld-art.mjs` suffixes from `_b` and so leaves whatever sprite
 * already sat at the bare stem inside the new set.
 *
 * THE THRESHOLD IS A REPORTING LINE, NOT A GATE. This cannot live in `npm run
 * check`: the art tree is gitignored, so CI and a bare clone have no pixels to
 * measure and a test would be permanently skipped or permanently red. It is a
 * tool you run when the art changes, which is the same standing this project
 * gives `status-live` and `delve-run`.
 */
const COHERENT = 40;
if (process.argv.includes('--variants')) {
  const rows = [];
  for (const [code, ids] of Object.entries(TILE_SPRITES)) {
    const found = ids.map((id) => [id, spriteOf(id)]).filter(([, sp]) => sp !== null);
    if (found.length < 2) continue;
    const mean = found.map(([id, sp]) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < sp.rgba.length; i += 4) {
        r += sp.rgba[i];
        g += sp.rgba[i + 1];
        b += sp.rgba[i + 2];
      }
      const n = sp.rgba.length / 4;
      return [id, r / n, g / n, b / n];
    });
    let worst = 0;
    let pair = '';
    for (let i = 0; i < mean.length; i += 1) {
      for (let j = i + 1; j < mean.length; j += 1) {
        const d = Math.hypot(
          mean[i][1] - mean[j][1],
          mean[i][2] - mean[j][2],
          mean[i][3] - mean[j][3],
        );
        if (d > worst) {
          worst = d;
          pair = `${mean[i][0].replace('tile_ow_', '')} vs ${mean[j][0].replace('tile_ow_', '')}`;
        }
      }
    }
    rows.push([nameOf(Number(code)), found.length, worst, pair]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  console.log('terrain          variants  spread  worst pair');
  let bad = 0;
  for (const [n, c, d, pair] of rows) {
    const flag = d > COHERENT ? '  <-- NOT ONE TERRAIN' : '';
    if (d > COHERENT) bad += 1;
    console.log(
      `  ${n.padEnd(14)} ${String(c).padStart(4)}  ${d.toFixed(1).padStart(6)}  ${pair}${flag}`,
    );
  }
  console.log(
    `INCOHERENT` +
      `: ${String(bad)} of ${String(rows.length)} sets (threshold ${String(COHERENT)})`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes('--sheet')) {
  const rows = [];
  for (const [code, ids] of Object.entries(TILE_SPRITES)) {
    const found = ids.map((id) => spriteOf(id)).filter((x) => x !== null);
    if (found.length > 0) rows.push([nameOf(Number(code)), found]);
  }
  const widest = Math.max(...rows.map((r) => r[1].length));
  const sheet = makeCanvas(widest * 32, rows.length * 32);
  rows.forEach(([, found], y) => {
    found.forEach((sp, x) => blit(sheet, sp, x * 32, y * 32, 32));
  });
  writeFileSync(OUT, encodePng(sheet.w, sheet.h, sheet.rgba));
  console.log(`${OUT}  ${String(sheet.w)}x${String(sheet.h)}`);
  rows.forEach(([n, found], i) => {
    console.log(
      `  row ${String(i + 1).padStart(2)}  ${n.padEnd(14)} ${String(found.length)} variant(s)`,
    );
  });
  process.exit(0);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `--redaction` — THE SECOND LANDMASS, WITHOUT WALKING THERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything below joins a socket and draws whatever realm that socket is in,
 * which is the right default and is why the header argues for it — a
 * reconstruction stops reproducing the bug you are hunting. It also means this
 * tool could only ever see the spawn map, and getting a socket to the Redaction
 * costs three minutes of clearing delves to earn the directions.
 *
 * `makeRedaction()` is PURE. `shared/redaction.ts` is the single authority on
 * what is over there — the realm itself calls the same function — so rendering
 * from it is not a second answer to the question, it is the same one. The site
 * ids come off the same map, and `landmarkIdFor` is the function the gateway
 * uses, imported rather than restated.
 *
 * WHAT THIS MODE CANNOT SHOW is anything the SERVER decides: danger grades,
 * roamers, who is standing where. Those are gateway facts and they are already
 * measured by `the-long-road.mjs`, which walks there properly.
 */
let pureLevel = null;
let pureSites = null;
let pureRealmName = null;
let pureRealmKind = null;
let pureActor = null;
let pureActors = null;
let pureProps = null;
const pureModeCount =
  Number(SITE !== null) + Number(OVERWORLD) + Number(process.argv.includes('--redaction'));
if (pureModeCount > 1) {
  throw new Error('--site, --overworld, and --redaction select different pure realms; choose one');
}
if (SITE !== null) {
  const { SITES, createRealms } = await import('../src/server/world/realms.ts');
  const { createTurnEngine } = await import('../src/server/turn-engine.ts');
  const site = SITES.get(SITE);
  if (site === undefined) throw new Error(`unknown site: ${SITE}`);
  const registry = createRealms({
    seed: `look:${SITE}`,
    engineFor: (world) => createTurnEngine({ world }),
  });
  const built =
    registry.all().find((realm) => realm.siteId === SITE) ?? registry.open(site, 'look');
  pureLevel = {
    w: built.world.level.w,
    h: built.world.level.h,
    tiles: built.world.level.tiles,
  };
  pureSites = [];
  pureRealmName = site.name;
  pureRealmKind = site.kind;
  pureActors = built.world
    .allActors()
    .map((actor) => ({ x: actor.x, y: actor.y, sprite: actor.sprite }));
  pureProps = built.world.props().map((prop) => ({ x: prop.x, y: prop.y, sprite: prop.propId }));
  const spawn = built.spawns[0] ?? {
    x: Math.floor(built.world.level.w / 2),
    y: Math.floor(built.world.level.h / 2),
  };
  pureActor = { ...spawn, sprite: ACTOR };
}
if (OVERWORLD) {
  const { makeOverworld } = await import('../src/shared/level.ts');
  const { landmarkIdFor } = await import('../src/shared/redaction.ts');
  const map = makeOverworld();
  pureLevel = { w: map.view.w, h: map.view.h, tiles: map.view.tiles };
  pureSites = [...map.sites.entries()].map(([cell, siteId]) => {
    const [x, y] = cell.split(',').map(Number);
    return { x, y, name: String(siteId), marker: 'gate', landmark: landmarkIdFor(String(siteId)) };
  });
  pureRealmName = 'Alderbrook Moor';
  pureRealmKind = 'overworld';
  const spawn = map.spawns[0] ?? { x: Math.floor(map.view.w / 2), y: Math.floor(map.view.h / 2) };
  pureActor = { ...spawn, sprite: ACTOR };
}
if (process.argv.includes('--redaction')) {
  const { makeRedaction, landmarkIdFor } = await import('../src/shared/redaction.ts');
  const map = makeRedaction();
  pureLevel = { w: map.view.w, h: map.view.h, tiles: map.view.tiles };
  pureRealmName = 'The Redaction';
  pureRealmKind = 'overworld';
  pureSites = [...map.sites.entries()].map(([cell, siteId]) => {
    const [x, y] = cell.split(',').map(Number);
    return { x, y, name: String(siteId), marker: 'gate', landmark: landmarkIdFor(String(siteId)) };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A SOCKET, BECAUSE THE FRAME IS THE TRUTH.
// ═══════════════════════════════════════════════════════════════════════════
// Pure-realm visual QA can photograph the passable state without scripting a
// player route to every hinge. This changes the throwaway view only; the game
// still opens doors through its normal bump action.
if (OPEN_DOORS && pureLevel !== null) {
  pureLevel = {
    ...pureLevel,
    tiles: pureLevel.tiles.map((code) => (code === TileCode.DOOR ? TileCode.DOOR_OPEN : code)),
  };
}

const server =
  pureLevel !== null
    ? { kill() {} }
    : spawn(process.execPath, ['src/server/main.ts'], {
        cwd: CWD,
        env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
process.on('exit', () => server.kill());

let up = pureLevel !== null;
for (let i = 0; i < 60 && !up; i += 1) {
  await sleep(250);
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
  } catch {
    up = false;
  }
}
if (!up) {
  console.log('the server never came up');
  process.exit(1);
}

const frames = [];
const ws =
  pureLevel !== null ? { close() {}, on() {} } : new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on('message', (r) => {
  try {
    frames.push(JSON.parse(r.toString()));
  } catch {
    /* a frame this tool cannot read is not a frame it needs */
  }
});
let selfId;
if (pureLevel === null) {
  await new Promise((r) => ws.on('open', r));
  const send = (o) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...o }));
  send({ t: 'hello' });
  await sleep(900);
  selfId = frames.find((f) => f.t === 'welcome')?.selfId;
  const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
  send({ t: 'choose_class', classId: opts[0].id });
  await sleep(1100);
}

const latest = (t) => frames.filter((f) => f.t === t).at(-1);
const realm =
  pureLevel === null
    ? latest('realm')
    : { name: pureRealmName, kind: pureRealmKind, level: pureLevel };
const sites = pureSites ?? latest('sites')?.sites ?? [];
const level = realm?.level;
if (level === undefined) {
  console.log('no level frame');
  process.exit(1);
}

const me = pureActor ?? (realm.actors ?? []).find((a) => a.id === selfId) ?? { x: 0, y: 0 };
/**
 * `--at x,y --size WxH` — LOOK AT A PLACE, not at wherever you happen to spawn.
 *
 * The viewport is what a player sees and is the right frame for "is this
 * readable in play". It is the wrong frame for "does this settlement read as a
 * settlement", which needs the whole footprint at once and does not fit in
 * twenty by ten.
 */
const AT = argOf('--at', null);
const SIZE = argOf('--size', '40x30');
const window =
  AT === null
    ? null
    : (() => {
        const [cx, cy] = AT.split(',').map(Number);
        const [w, h] = SIZE.split('x').map(Number);
        return {
          x0: Math.max(0, Math.min(level.w - w, cx - (w >> 1))),
          y0: Math.max(0, Math.min(level.h - h, cy - (h >> 1))),
          w: Math.min(w, level.w),
          h: Math.min(h, level.h),
        };
      })();

const view =
  window ??
  (WHOLE
    ? { x0: 0, y0: 0, w: level.w, h: level.h }
    : {
        x0: Math.max(
          0,
          Math.min(level.w - DEFAULT_VIEWPORT.tilesW, me.x - (DEFAULT_VIEWPORT.tilesW >> 1)),
        ),
        y0: Math.max(
          0,
          Math.min(level.h - DEFAULT_VIEWPORT.tilesH, me.y - (DEFAULT_VIEWPORT.tilesH >> 1)),
        ),
        w: DEFAULT_VIEWPORT.tilesW,
        h: DEFAULT_VIEWPORT.tilesH,
      });

const canvas = makeCanvas(view.w * PX, view.h * PX);
const missing = new Map();
let painted = 0;
const terrainSprites = tileSpritesForRealm(realm.kind ?? null);
const codeAt = (x, y) =>
  x < 0 || y < 0 || x >= level.w || y >= level.h ? TileCode.WALL : level.tiles[y * level.w + x];
const groundCode = (primary, alternate) =>
  isWalkable(primary) && primary !== TileCode.DOOR_OPEN
    ? primary
    : isWalkable(alternate) && alternate !== TileCode.DOOR_OPEN
      ? alternate
      : TileCode.FLOOR;
const terrainSprite = (code, tx, ty) => {
  const ids = terrainSprites[code];
  if (ids === undefined) return { id: `code ${String(code)}`, sprite: null };
  const id = ids.length === 1 ? ids[0] : ids[tileVariant(tx, ty, ids.length)];
  return { id, sprite: spriteOf(id) };
};

function blitDoorHalf(code, tx, ty, orientation, second, dx, dy) {
  const { id, sprite } = terrainSprite(code, tx, ty);
  if (sprite === null) {
    missing.set(id, (missing.get(id) ?? 0) + 1);
    return false;
  }
  const horizontalSplit = Math.floor(sprite.w / 2);
  const verticalSplit = Math.floor(sprite.h / 2);
  const destinationSplit = Math.floor(PX / 2);
  const crop =
    orientation === 'ns'
      ? cropSprite(
          sprite,
          0,
          second ? verticalSplit : 0,
          sprite.w,
          second ? sprite.h - verticalSplit : verticalSplit,
        )
      : cropSprite(
          sprite,
          second ? horizontalSplit : 0,
          0,
          second ? sprite.w - horizontalSplit : horizontalSplit,
          sprite.h,
        );
  const targetX = dx + (orientation === 'ew' && second ? destinationSplit : 0);
  const targetY = dy + (orientation === 'ns' && second ? destinationSplit : 0);
  const targetW = orientation === 'ew' ? (second ? PX - destinationSplit : destinationSplit) : PX;
  const targetH = orientation === 'ns' ? (second ? PX - destinationSplit : destinationSplit) : PX;
  return blitSized(canvas, crop, targetX, targetY, targetW, targetH);
}

for (let y = 0; y < view.h; y += 1) {
  for (let x = 0; x < view.w; x += 1) {
    const tx = view.x0 + x;
    const ty = view.y0 + y;
    const code = level.tiles[ty * level.w + tx];
    const roofId = realm.kind === 'overworld' ? settlementRoofSpriteId(code, tx, ty) : null;
    const doorId = realm.kind === 'overworld' ? null : localDoorSpriteId(level, code, tx, ty);
    if (doorId !== null) {
      const orientation = doorId.endsWith('_ns') ? 'ns' : 'ew';
      const firstNeighbor = orientation === 'ns' ? codeAt(tx, ty - 1) : codeAt(tx - 1, ty);
      const secondNeighbor = orientation === 'ns' ? codeAt(tx, ty + 1) : codeAt(tx + 1, ty);
      blitDoorHalf(
        groundCode(firstNeighbor, secondNeighbor),
        tx,
        ty,
        orientation,
        false,
        x * PX,
        y * PX,
      );
      blitDoorHalf(
        groundCode(secondNeighbor, firstNeighbor),
        tx,
        ty,
        orientation,
        true,
        x * PX,
        y * PX,
      );
      if (blit(canvas, spriteOf(doorId), x * PX, y * PX, PX)) painted += 1;
      else missing.set(doorId, (missing.get(doorId) ?? 0) + 1);
    } else {
      const ids = roofId === null ? terrainSprites[code] : [roofId];
      if (ids === undefined) {
        missing.set(`code ${String(code)}`, (missing.get(`code ${String(code)}`) ?? 0) + 1);
        continue;
      }
      const id = ids.length === 1 ? ids[0] : ids[tileVariant(tx, ty, ids.length)];
      if (blit(canvas, spriteOf(id), x * PX, y * PX, PX)) painted += 1;
      else missing.set(id, (missing.get(id) ?? 0) + 1);
    }

    // Match the browser's local architectural-height pass. The south cell is
    // the only adjacency that exposes a full vertical face in this viewpoint.
    if (realm.kind === 'common' || realm.kind === 'inner') {
      const south = ty + 1 < level.h ? level.tiles[(ty + 1) * level.w + tx] : TileCode.WALL;
      const faceIds = isWalkable(south) ? LOCAL_WALL_FACE_SPRITES[code] : undefined;
      if (faceIds !== undefined) {
        const faceId =
          faceIds.length === 1 ? faceIds[0] : faceIds[tileVariant(tx, ty, faceIds.length)];
        if (!blit(canvas, spriteOf(faceId), x * PX, y * PX, PX)) {
          missing.set(faceId, (missing.get(faceId) ?? 0) + 1);
        }
      }
    }
  }
}

// Sites on top, landmark first, exactly as `paintSites` prefers them.
let landmarks = 0;
let markers = 0;
for (const s of sites) {
  const x = s.x - view.x0;
  const y = s.y - view.y0;
  if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
  const art =
    (s.landmark === undefined ? null : spriteOf(s.landmark)) ??
    (s.sprite === undefined ? null : spriteOf(s.sprite)) ??
    spriteOf(`tile_ow_site_${String(s.marker)}`) ??
    spriteOf('tile_ow_site_gate');
  if (blit(canvas, art, x * PX, y * PX, PX)) {
    if (s.landmark !== undefined && spriteOf(s.landmark) !== null) landmarks += 1;
    else markers += 1;
  }
}

// Furnishings and residents for a pure settlement probe. These come from the
// built World, not the content tables, so the image catches missing wiring as
// well as bad coordinates.
for (const prop of pureProps ?? []) {
  const x = prop.x - view.x0;
  const y = prop.y - view.y0;
  if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
  if (!blit(canvas, spriteOf(prop.sprite), x * PX, y * PX, PX)) {
    missing.set(prop.sprite, (missing.get(prop.sprite) ?? 0) + 1);
  }
}
for (const actor of pureActors ?? []) {
  const x = actor.x - view.x0;
  const y = actor.y - view.y0;
  if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
  if (!blitActor(canvas, spriteOf(actor.sprite ?? ''), x * PX, y * PX, PX)) {
    missing.set(actor.sprite ?? '(actor)', (missing.get(actor.sprite ?? '(actor)') ?? 0) + 1);
  }
}

// And the player, so the shot is framed the way the screenshot was.
if (!WHOLE) {
  blitActor(canvas, spriteOf(me.sprite ?? ''), (me.x - view.x0) * PX, (me.y - view.y0) * PX, PX);
}

/**
 * WHAT THE GROUND ACTUALLY IS, in the same frame that was just drawn.
 *
 * "It looks checkerboarded" is a report about pixels, and answering it means
 * naming the tile codes under them. Read off the frame rather than rebuilt from
 * `level.ts`, for the reason in the header.
 */
if (process.argv.includes('--codes')) {
  const nameOfCode = Object.fromEntries(Object.entries(TileCode).map(([k, v]) => [v, k]));
  const seen = new Map();
  const lines = [];
  // The grid is for reading by eye; past about sixty columns it is a wall of
  // text and only the tally below is useful.
  const drawGrid = view.w <= 60;
  for (let y = 0; y < view.h; y += 1) {
    let row = '';
    for (let x = 0; x < view.w; x += 1) {
      const code = level.tiles[(view.y0 + y) * level.w + (view.x0 + x)];
      const n = nameOfCode[code] ?? String(code);
      seen.set(n, (seen.get(n) ?? 0) + 1);
      row += n.slice(0, 3).padEnd(4);
    }
    if (drawGrid) lines.push(row);
  }
  if (drawGrid) console.log(`\n${lines.join('\n')}`);
  console.log('\n  in view:');
  for (const [n, c] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(c).padStart(4)}  ${n}`);
  }
}

writeFileSync(OUT, encodePng(canvas.w, canvas.h, canvas.rgba));
console.log(`${OUT}  ${String(canvas.w)}x${String(canvas.h)}  (${String(PX)}px tiles)`);
console.log(
  `  realm: ${String(realm.name)}, viewport ${String(view.w)}x${String(view.h)} at ${String(view.x0)},${String(view.y0)}`,
);
console.log(
  `  ${String(painted)} ground tiles, ${String(landmarks)} landmarks, ${String(markers)} family markers`,
);
if (missing.size > 0) {
  const worst = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  NOT DRAWN: ${worst.map(([k, n]) => `${k} x${String(n)}`).join(', ')}`);
}

ws.close();
server.kill();
process.exit(0);
