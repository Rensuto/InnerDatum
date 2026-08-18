import { describe, expect, it } from 'vitest';

import {
  INSPECTOR,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TalentEffect } from '../../src/server/engine/talents.ts';
import { projectEffects } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO EFFECT SYSTEMS, AND ONLY ONE OF THEM WAS EVER DRAWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `engine/effects.ts` holds Stunned, Bleeding and Slowed and has had a badge
 * channel since M4. `engine/talents.ts` holds Marked, Guarding and Taunted and
 * had nothing — so the Inspector's Sigil, whose entire purpose is to tell the
 * party WHICH of six husks to focus, was invisible to every client. The only
 * way anybody learned which one was marked was a Case Log line that scrolls
 * away, or the Inspector saying it out loud and being believed.
 *
 * `docs/game-design.md` § 10 names *"it's sigiled, hit it"* as the conversation
 * the design is trying to manufacture. A mechanic nobody can see cannot
 * manufacture a conversation about itself.
 */

function scene() {
  const world = createWorld('talent-badges');
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const effects = createMvpEffectState();

  const sam = world.addPlayer('p1', 'Sam', { maxHp: INSPECTOR.maxHp });
  sam.x = 5;
  sam.y = 5;
  talents.attach('p1', sheetForClass(INSPECTOR));

  world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: 'enemy_index_husk_s',
    x: 9,
    y: 5,
    profile: AiProfile.MeleeChaser,
    maxHp: 25,
  });

  return { world, talents, effects };
}

describe('a sigilled body is visibly sigilled', () => {
  it('puts Marked on the badge row of the thing that was marked', () => {
    const { world, talents, effects } = scene();
    talents.addEffect('m_husk', {
      kind: TalentEffect.Marked,
      otherId: 'p1',
      turns: 4,
      power: 25,
    });

    const row = projectEffects(world, effects, talents).actors.find((a) => a.id === 'm_husk');
    expect(row, 'the marked husk carries no badges at all').toBeDefined();
    const badge = row?.effects.find((e) => e.name === 'Marked');
    expect(badge).toBeDefined();
    expect(badge?.turns).toBe(4);
    // HARMFUL, because `harmful` means "is this being done TO you" — and a red
    // pip over the thing the party should hit is the correct reading.
    expect(badge?.harmful).toBe(true);
    // THE ART EXISTS AND WAS NEVER ASKED FOR. `icon_status_marked` is cut, in
    // the manifest, and loaded by the `icon_status_` prefix; nothing had ever
    // requested it. A key with no PNG draws the violet missing-asset box.
    expect(badge?.icon).toBe('icon_status_marked');
  });

  it('puts Guarded on the ally being covered, and calls it beneficial', () => {
    const { world, talents, effects } = scene();
    talents.addEffect('p1', { kind: TalentEffect.Guarding, otherId: 'p1', turns: 3, power: 0 });

    const badge = projectEffects(world, effects, talents)
      .actors.find((a) => a.id === 'p1')
      ?.effects.find((e) => e.name === 'Guarded');
    expect(badge).toBeDefined();
    expect(badge?.harmful).toBe(false);
    expect(badge?.icon).toBe('icon_status_guarded');
  });

  it('draws nothing without the talent table — which is what shipped until now', () => {
    // THE ABSENT SEAM, and the regression this file exists to hold. Every
    // fixture built before this wires no talent engine, and the badge row must
    // be byte-for-byte what it always was for them.
    const { world, talents, effects } = scene();
    talents.addEffect('m_husk', {
      kind: TalentEffect.Marked,
      otherId: 'p1',
      turns: 4,
      power: 25,
    });
    expect(projectEffects(world, effects).actors).toEqual([]);
  });

  it('does not badge a taunt', () => {
    /**
     * DELIBERATE. A taunt is a fact about the MONSTER'S MIND — who it has
     * decided to chase — and the honest place for that is its behaviour, which a
     * player reads by watching it walk at the Watchman.
     *
     * A badge would state it more loudly than the game can guarantee: the taunt
     * expires, `ai.targetId` is re-acquired on its own when a target leaves view
     * (npc.ts self-heals), and a pip that outlived either would be a confident
     * lie about what a monster is about to do.
     */
    const { world, talents, effects } = scene();
    talents.addEffect('m_husk', { kind: TalentEffect.Taunted, otherId: 'p1', turns: 3, power: 0 });
    expect(projectEffects(world, effects, talents).actors).toEqual([]);
  });
});
