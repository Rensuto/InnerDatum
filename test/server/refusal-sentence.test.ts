// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REFUSAL IS A SENTENCE. IT WAS PRINTING THE WIRE CODE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `submitTalent` hands the authoritative checker's answer back as the player's
 * message, and it built that message as `` `${talent.name}: ${code}` ``. For
 * most codes the client rewrites the category itself — `refusalText` turns
 * `out_of_range` into "too far away" — but `bad_message` is the one arm where it
 * deliberately DEFERS: *"a game rule, and the server already wrote the
 * sentence."*
 *
 * The server had not written one. So a Watchman pressing one of the seven
 * hotbar buttons they have not raised yet was told, verbatim:
 *
 *     Ward Rush: bad_message
 *
 * MEASURED by `tools/round-live.mjs`, which reported `casts landed: 0` with
 * three of those errors — and then concluded from zero casts that the
 * multi-action round was "CLOSED", which is the vacuous green a probe reports
 * when the thing it was measuring never happened.
 */

function watchman(name: string) {
  const world = createWorld(name);
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const engine = createTurnEngine({
    world,
    downed: createDownedState(),
    parties: createPartyState(),
    effects: createMvpEffectState(),
    // THE PRODUCTION SEAMS. `talents.check` is what answers here, and without
    // the runtime this file would be testing the catalogue-only fallback — a
    // different code path with a different message.
    talents: createTalentBook(talents, world),
    talentRuntime: talentRuntimeFor(talents, world),
  });
  const body = world.addPlayer('p1', 'Detective', { maxHp: 900 });
  body.x = 10;
  body.y = 10;
  talents.attach('p1', sheetForClass(WATCHMAN));
  engine.join('p1');
  engine.setConnected('p1', true);
  const foe = world.addMonster('foe', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 11,
    y: 10,
    profile: AiProfile.MeleeChaser,
    maxHp: 9999,
  });
  engine.pump();
  return { world, engine, body, foe };
}

describe('what a player is told when a talent is refused', () => {
  it('carries nine talents and has learned two, which is why this matters', () => {
    /**
     * THE SETUP, ASSERTED, because the whole defect lives in the gap between
     * those two numbers: the hotbar draws what is in the LOADOUT, and seven of
     * those rows are buttons a player can press and has not raised.
     *
     * `REFUSAL_TO_CODE`'s note still argues the opposite — *"M3 loadouts are
     * FIXED, so a frame naming a talent that is not in your four was
     * hand-crafted rather than clicked"* — which is the same stale sentence the
     * membership check in `submitTalent` already corrected in its own comment.
     */
    const scene = watchman('refusal-setup');
    const loadout = scene.engine.loadoutOf('p1');
    expect(loadout.length).toBeGreaterThan(2);
    expect(loadout.some((t) => t.id === 'talent:ward_rush')).toBe(true);
  });

  it('says you have not learned it, rather than saying `bad_message`', () => {
    const scene = watchman('refusal-unlearned');
    const refused = scene.engine.submitTalent('p1', 'talent:ward_rush', {
      x: scene.foe.x,
      y: scene.foe.y,
    });

    expect(refused.ok).toBe(false);
    const reason = refused.ok ? '' : refused.reason;
    // THE CODE STAYS `bad_message` — the client's `refusalText` defers to the
    // server's words for exactly that arm, so the fix is the sentence and not a
    // new code (and a new `ErrorCode` member would be a protocol bump).
    expect(refused.ok ? '' : refused.code).toBe('bad_message');
    expect(reason, 'the wire code is being printed at the player').not.toMatch(/bad_message/);
    expect(reason).toMatch(/learn/i);
    expect(reason).toMatch(/Ward Rush/);
  });

  it('and never prints a raw code for any refusal the checker gives', () => {
    /**
     * THE GENERAL RULE, not just the one arm. Every code this path can answer
     * used to arrive as its own name; asserting the whole vocabulary is absent
     * is what stops the next one added from reintroducing it.
     */
    const scene = watchman('refusal-codes');
    const codes = [
      'bad_message',
      'illegal_move',
      'out_of_range',
      'too_close',
      'on_cooldown',
      'no_resource',
      'no_los',
      'not_your_turn',
    ];
    const attempts = [
      // Unlearned.
      scene.engine.submitTalent('p1', 'talent:ward_rush', { x: 11, y: 10 }),
      // Learned, but aimed at empty floor.
      scene.engine.submitTalent('p1', 'talent:crude_blow', { x: 14, y: 14 }),
      // Learned, aimed at a body it cannot reach.
      scene.engine.submitTalent('p1', 'talent:crude_blow', { x: 25, y: 25 }),
    ];
    for (const attempt of attempts) {
      if (attempt.ok) continue;
      for (const code of codes) {
        expect(attempt.reason, `a refusal printed the code ${code}`).not.toContain(code);
      }
    }
  });
});
