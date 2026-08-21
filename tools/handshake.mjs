// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   WAIT FOR THE FRAME, NOT FOR THE CLOCK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every socket tool in this directory opened the same way:
 *
 *     send({ t: 'hello' });
 *     await sleep(900);
 *     const opts = frames.find((f) => f.t === 'class_options')?.options ?? [];
 *     send({ t: 'choose_class', classId: opts[0].id });
 *
 * 900ms is a bet on how long a cold Node process takes to boot a server, open a
 * socket and answer a handshake. On a quiet machine it wins. On a machine that
 * is also running tsc, or a full test suite, or another one of these tools, it
 * loses — and it loses as
 *
 *     TypeError: Cannot read properties of undefined (reading 'id')
 *
 * which names nothing, points at the tool rather than the wait, and stops the
 * run dead on line one.
 *
 * ═══ WHY THIS IS WORTH A FILE OF ITS OWN ═══
 * These tools are how gameplay gets verified. `npm run check` proves the parts
 * work; only these prove the GAME does — and the day an outage shipped past a
 * green gate, two of them were the first thing reached for, and neither would
 * start. A verification harness that is itself unreliable is worse than none,
 * because its silence reads like an all-clear.
 *
 * Polling costs nothing in the common case: it returns on the first check when
 * the frame has already arrived, so the tools also got faster.
 */

const POLL_MS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolve once a frame of `type` is in `frames`, or throw a sentence that says
 * what was being waited for and what did arrive.
 *
 * THROWS RATHER THAN RETURNING UNDEFINED, unlike the equivalents in test/: a
 * tool has no assertion library behind it, so the throw IS the failure report,
 * and it is worth more than a `TypeError` fifteen lines later.
 */
export async function awaitFrame(frames, type, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = frames.find((f) => f.t === type);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) {
      const seen = [...new Set(frames.map((f) => f.t))].join(', ') || '(nothing)';
      /**
       * AN ERROR FRAME IS AN ANSWER, NOT A MISSING ONE — and the two used to
       * look identical from here. A handshake refused for a stated reason is a
       * completely different problem from one that was ignored, and the reason
       * is already on the wire; not printing it was throwing away the finding.
       */
      const refusal = frames.find((f) => f.t === 'error');
      const said =
        refusal === undefined
          ? ''
          : ` The server refused it: ${String(refusal.code)} — ${String(refusal.message)}.`;
      throw new Error(
        `waited ${String(timeoutMs)}ms for a '${type}' frame and it never came. ` +
          `Frames that did arrive: ${seen}.${said}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * THE WHOLE OPENING, AS ONE CALL: say hello, wait for the two frames that
 * matter, and answer with a class.
 *
 * `pick` is an index into the offered classes, so a caller can ask for "the
 * second one" without knowing what the roster is this week.
 *
 * ═══ IT RETURNS THE CHOSEN CLASS AS WELL AS THE ID ═══
 * Several tools print "JOINS AS ..." and every one of them re-found the option
 * afterwards. One lookup, handed back.
 */
export async function helloAndChoose(send, frames, pick = 0, timeoutMs = DEFAULT_TIMEOUT_MS) {
  send({ t: 'hello' });
  const welcome = await awaitFrame(frames, 'welcome', timeoutMs);
  const offer = await awaitFrame(frames, 'class_options', timeoutMs);
  const options = offer.options ?? [];
  const chosen = options[pick];
  if (chosen === undefined) {
    throw new Error(
      `the server offered ${String(options.length)} classes and this run wanted index ` +
        `${String(pick)}. Offered: ${options.map((o) => o.id).join(', ') || '(none)'}`,
    );
  }
  send({ t: 'choose_class', classId: chosen.id });
  return { selfId: welcome.selfId, chosen, options };
}
