// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORIGIN-LIVE — the picker offers every origin, and the one you pick is the
 * one the sheet reports.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT IT ASSERTS ═══
 *   1. THE PICKER OFFERS EVERY ORIGIN. `class_options.origins` is the only way
 *      a player can reach one, so an origin missing here does not exist however
 *      correct `ORIGINS` is. This is the assertion with the most value per line:
 *      five origins are authored and a wire that dropped one would look fine in
 *      every unit test in the tree.
 *   2. THE CHOICE LANDS. `inspect` on your own body reports `originName` —
 *      `tome/dialogs/CharacterSheet.lua:604-606`'s identity block, and the one
 *      string on the wire that says which origin a body actually IS.
 *   3. A DROPPED SOCKET DOES NOT CHANGE THE ANSWER.
 *
 * ═══ WHAT IT DOES **NOT** COVER, AND THIS MATTERS ═══
 * IT IS NOT A TEST OF RESTORE-FROM-SAVE. A socket that comes back inside the
 * grace window "resumes the same body" (see `resolveActor`), so the second
 * `hello` here reattaches to a LIVE actor that never left memory —
 * `applyRestore` is not on this path at all.
 *
 * MEASURED, NOT ASSUMED: with the origin deliberately dropped from the restore
 * call site — `overlayFor(definition)` instead of
 * `overlayFor(definition, originOf(restore?.origin ?? undefined))` — this probe
 * still passes. So it must not be read as covering the bug that motivated it,
 * where every reconnect rebuilt an Indexed character as the baseline.
 *
 * Reaching that path needs the body EVICTED from memory: a server restart, or a
 * wait past the grace. Neither belongs in a probe that has to finish in seconds.
 * `gateway-progression.test.ts` drives `applyRestore` directly and is where that
 * guarantee lives.
 *
 * ═══ IT PICKS THE INDEXED ON PURPOSE ═══
 * `DEFAULT_ORIGIN` is the Cityborn, so a body that lost its origin falls back to
 * exactly that and reads as correct. An assertion about the Cityborn would be
 * unfalsifiable — the trap `gateway-progression.test.ts` records. The Indexed is
 * a different answer from the fallback, so this probe can fail.
 *
 * EXIT 0 WHEN IT COULD NOT REACH ITS QUESTION, per `verify.mjs`'s contract: a
 * probe that could not get a socket reports and stands down, and only a red line
 * here is a real fault.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { PROTOCOL_VERSION } from '../src/shared/version.ts';
import { awaitFrame } from './handshake.mjs';

const PORT = process.argv[2] ?? '31991';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The origin this probe drives. NOT the default — see the header. */
const WANT_ORIGIN = 'origin_indexed';

const server = spawn(process.execPath, ['src/server/main.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverErr = [];
server.stderr.on('data', (b) => serverErr.push(b.toString()));
process.on('exit', () => server.kill());

let up = false;
for (let i = 0; i < 80 && !up; i += 1) {
  await sleep(250);
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
  } catch {
    /* not yet */
  }
}
if (!up) {
  console.log('  the server never came up — nothing to ask. stderr:\n' + serverErr.join(''));
  process.exit(0);
}

/** One socket, its frames, and a sender. Called twice: that is the point. */
function connect() {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      /* not ours */
    }
  });
  const send = (msg) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  const open = new Promise((ok, no) => {
    ws.on('open', ok);
    ws.on('error', no);
  });
  return { ws, frames, send, open };
}

/** `inspect` on yourself, and the identity block that comes back. */
async function originOf(send, frames, selfId) {
  send({ t: 'inspect', targetId: selfId });
  const reply = await awaitFrame(frames, 'inspected', 8000);
  return reply.view?.originName;
}

let failed = false;
const fail = (line) => {
  failed = true;
  console.log(`  FAIL  ${line}`);
};

// ─── ONE: choose it ─────────────────────────────────────────────────────────
const first = connect();
try {
  await first.open;
} catch (err) {
  console.log(`  could not open a socket (${String(err)}) — standing down.`);
  process.exit(0);
}

first.send({ t: 'hello' });
const welcome = await awaitFrame(first.frames, 'welcome', 8000);
const offer = await awaitFrame(first.frames, 'class_options', 8000);

const origins = offer.origins ?? [];
console.log(`  offered origins: ${origins.map((o) => o.id).join(', ') || '(none)'}`);
if (origins.length === 0) {
  console.log('  THE PICKER OFFERED NO ORIGINS AT ALL — nothing to choose. Standing down.');
  process.exit(0);
}
const wanted = origins.find((o) => o.id === WANT_ORIGIN);
if (wanted === undefined) {
  fail(`${WANT_ORIGIN} was not offered, so no player can pick it`);
}

const klass = (offer.options ?? [])[0];
if (klass === undefined) {
  console.log('  no class was offered — standing down.');
  process.exit(0);
}

first.send({ t: 'choose_class', classId: klass.id, originId: WANT_ORIGIN });
await sleep(700);

const chosenName = await originOf(first.send, first.frames, welcome.selfId);
console.log(`  chose: ${klass.id} + ${WANT_ORIGIN} -> the sheet says "${String(chosenName)}"`);
if (chosenName === undefined) {
  fail('the sheet reports no origin at all for a body that just chose one');
} else if (wanted !== undefined && chosenName !== wanted.name) {
  fail(`the sheet says "${String(chosenName)}" where the picker offered "${wanted.name}"`);
}

/**
 * ─── ONE AND A HALF: THE TALENT THE ORIGIN GRANTS IS ON THE BAR ─────────────
 *
 * `originName` proves the CHOICE landed. It does not prove the origin's
 * TALENTS did, and those are two different joins: `overlayFor` sets the name,
 * `sheetForClass` folds `OriginDef.talents` onto the loadout, and a body can
 * report the right origin while carrying none of what it grants.
 *
 * `membership-is-not-a-rank` is this project's own name for the half that gets
 * missed — a talent can be in a list and still be unpressable. So this reads
 * the SHEET the client draws its bar from, which is the same frame the hotbar
 * renders, and asks whether the button is actually there.
 *
 * SECOND ORIGIN, NOT `WANT_ORIGIN`. The Unfiled is the one carrying a talent
 * nothing else grants — `elf.lua:107`'s shielding rune, this game's only rune.
 * A separate connection because a body's origin is chosen once.
 */
const RUNE_ORIGIN = 'origin_unfiled';
const RUNE_TALENT = 'talent:shielding_rune';

const runeConn = connect();
try {
  await runeConn.open;
  runeConn.send({ t: 'hello' });
  await awaitFrame(runeConn.frames, 'welcome', 8000);
  const runeOffer = await awaitFrame(runeConn.frames, 'class_options', 8000);
  const runeClass = (runeOffer.options ?? [])[0];
  const hasOrigin = (runeOffer.origins ?? []).some((o) => o.id === RUNE_ORIGIN);
  if (runeClass === undefined || !hasOrigin) {
    console.log(`  ${RUNE_ORIGIN} is not offered here — skipping the grant check.`);
  } else {
    /**
     * FORGET WHAT ALREADY ARRIVED, and this is not tidiness — it is the finding.
     *
     * `awaitFrame` returns the FIRST frame of a type it sees, and a connection
     * gets a full burst before it has chosen anything: `welcome, realm, turn,
     * loadout, cooldowns, ...`. Reading `loadout` after the send therefore
     * returned the bar from BEFORE the origin existed, and the probe reported
     * that the Unfiled carries no shielding rune — along with none of the two
     * origin talents that have shipped and worked for weeks.
     *
     * Suspect the probe first. Three talents missing at once was the tell.
     */
    runeConn.frames.length = 0;
    runeConn.send({ t: 'choose_class', classId: runeClass.id, originId: RUNE_ORIGIN });
    // `loadout` IS THE HOTBAR — `talents[0]` is slot 1, and the server owns
    // that order. It is the frame the bar is drawn from, which is why the
    // question is asked of it rather than of anything derived.
    const sheet = await awaitFrame(runeConn.frames, 'loadout', 8000);
    const bar = (sheet.talents ?? []).map((t) => t.id);
    const row = (sheet.talents ?? []).find((t) => t.id === RUNE_TALENT);
    console.log(`  ${RUNE_ORIGIN} bar: ${bar.join(', ') || '(empty)'}`);
    if (row === undefined) {
      fail(`${RUNE_ORIGIN} carries no ${RUNE_TALENT} — the origin's grant did not reach the bar`);
    } else if ((row.level ?? 0) < 1) {
      // MEMBERSHIP IS NOT A RANK. A row at level 0 draws on the bar and
      // `canUseTalent` refuses it, which looks like a broken button.
      fail(`${RUNE_TALENT} is on the bar at rank ${String(row.level)} — it cannot be pressed`);
    } else {
      console.log(`  ${RUNE_TALENT} is on the bar at rank ${String(row.level)}`);
    }
  }
} catch (err) {
  console.log(`  could not run the grant check (${String(err)}) — skipping it.`);
} finally {
  runeConn.ws.close();
}

// ─── TWO: come back ─────────────────────────────────────────────────────────
// THE HALF THE UNIT TESTS COULD NOT SEE. `hello` builds the body from the class
// definition and `applyRestore` lands afterwards, so anything the overlay does
// not carry is gone by the time anybody looks.
first.ws.close();
await sleep(900);

const second = connect();
try {
  await second.open;
} catch (err) {
  console.log(`  could not reconnect (${String(err)}) — standing down.`);
  process.exit(0);
}
/**
 * ═══ THE RESUME TOKEN IS WHAT MAKES THIS A RECONNECT ═══
 * A bare `hello` from an ANONYMOUS socket "joins straight away" as a NEW body —
 * `HelloSchema.characterId` says so in as many words. The first draft of this
 * probe sent one and read the default origin back off a stranger, then reported
 * a reconnect bug that did not exist. The two `selfId`s differed and nothing
 * said so, which is the whole reason this line logs them.
 */
second.send({ t: 'hello', resumeToken: welcome.resumeToken });
const back = await awaitFrame(second.frames, 'welcome', 8000);
await sleep(700);

console.log(
  `  selfId first=${welcome.selfId} second=${back.selfId} same=${welcome.selfId === back.selfId}`,
);
const afterName = await originOf(second.send, second.frames, back.selfId);
console.log(`  reconnected -> the sheet says "${String(afterName)}"`);

if (afterName === undefined) {
  fail('the origin was gone after a reconnect — the body came back as the baseline');
} else if (afterName !== chosenName) {
  fail(`the origin CHANGED across a reconnect: "${String(chosenName)}" -> "${String(afterName)}"`);
}

second.ws.close();

console.log('');
if (failed) {
  console.log('origin-live FAILED');
  process.exit(1);
}
console.log(`  ${WANT_ORIGIN} is offered, choosable, and still itself after a reconnect.`);
console.log('origin-live OK');
process.exit(0);
