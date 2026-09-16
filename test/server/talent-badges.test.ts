import { describe, expect, it } from 'vitest';

import {
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TalentEffect, talentId, useTalent } from '../../src/server/engine/talents.ts';
import { projectEffects } from '../../src/server/view/projector.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { EffectsMsg } from '../../src/shared/protocol.ts';
import { trained } from '../helpers/trained.ts';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CURTAIN IS DRAWN OVER THE BODY IT COVERS, NOT OVER THE ONE HOLDING IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TalentEffect.Guarding` is held by the GUARDIAN and NAMES the ally in
 * `otherId` (engine/talents.ts), and iron_curtain.ts installs it exactly that
 * way: on `self.id`, with `otherId: ally.id`. The projector read the badge off
 * the actor HOLDING the effect, so a Watchman who raised the curtain over the
 * Inspector wore "Guarded" himself while the Inspector's row stayed bare — the
 * one body the badge exists to mark was the one without it.
 *
 * The test that was meant to hold this installed the guard p1 -> p1. On that
 * fixture the holder and the ally are the same body, so it passed under the
 * wrong rule and would have passed under the right one: it was true of its
 * fixture, not of the rule. Every case below separates the two bodies.
 */
function guardScene() {
  const world = createWorld('guard-badges');
  world.level.tiles.fill(TileCode.FLOOR);
  const talents = createContentTalentEngine();
  const effects = createMvpEffectState();

  const dalt = world.addPlayer('p1', 'Dalt', { maxHp: WATCHMAN.maxHp });
  dalt.x = 5;
  dalt.y = 5;
  // TRAINED, because Iron Curtain is tier 4 and not a birth talent; this file
  // is about what the badge row says once the curtain is up, not about the
  // levels it takes to afford it.
  talents.attach('p1', trained(sheetForClass(WATCHMAN)));

  const sam = world.addPlayer('p2', 'Sam', { maxHp: INSPECTOR.maxHp });
  sam.x = 6;
  sam.y = 5;
  talents.attach('p2', sheetForClass(INSPECTOR));

  return { world, talents, effects, dalt, sam };
}

/** Every "Guarded" badge in a frame, as [bearer, turns] pairs. */
function guardedIn(msg: EffectsMsg): (readonly [string, number])[] {
  return msg.actors.flatMap((row) =>
    row.effects.filter((e) => e.name === 'Guarded').map((e) => [row.id, e.turns] as const),
  );
}

describe('a guarded body is visibly guarded', () => {
  it('puts Guarded on the ally being covered, not on the Watchman holding the curtain', () => {
    const { world, talents, effects } = guardScene();
    talents.addEffect('p1', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 3, power: 0 });

    const msg = projectEffects(world, effects, talents);
    expect(guardedIn(msg)).toEqual([['p2', 3]]);
    // AND THE WATCHMAN CARRIES NOTHING AT ALL. He has no other effect on him,
    // so a row for p1 could only be the badge landing on the wrong body.
    expect(msg.actors.find((a) => a.id === 'p1')).toBeUndefined();

    const badge = msg.actors.find((a) => a.id === 'p2')?.effects.find((e) => e.name === 'Guarded');
    // BENEFICIAL: it is being done FOR the ally, not to them.
    expect(badge?.harmful).toBe(false);
    expect(badge?.icon).toBe('icon_status_guarded');
  });

  it('lands where the real Iron Curtain cast puts it', () => {
    /**
     * THE JOIN. The case above installs the effect by hand, in the shape
     * engine/talents.ts documents; this one lets iron_curtain.ts install it, so
     * the badge is measured against what the talent actually stores rather than
     * against what a comment says it stores. `wardFor` picks the adjacent ally
     * in the worst shape, so Sam is hurt enough to be the one covered.
     */
    const { world, talents, effects, dalt, sam } = guardScene();
    sam.hp = 6;

    const ctx = { engine: talents, world, rng: world.rng };
    const result = useTalent(talents, dalt, talentId('iron_curtain'), { x: 5, y: 5 }, ctx);
    expect(result.ok, 'the curtain never went up, so there is nothing to badge').toBe(true);

    // 3 is iron_curtain.ts's `GUARD_TURNS`, fresh off the cast.
    expect(guardedIn(projectEffects(world, effects, talents))).toEqual([['p2', 3]]);
  });

  it('shows nothing once the Watchman holding the curtain is on the floor', () => {
    /**
     * A GUARD NOBODY CAN SWING FOR. `resolveGuardCounter` (engine/talents.ts)
     * skips a guardian that is not alive, and a Downed body is `alive === false`
     * (engine/downed.ts `goDown`), so the ally is not covered while he is down,
     * however many turns are still on his `Guarding`. A badge over the ally
     * would promise a counter nobody is standing up to throw.
     *
     * Before the badge moved it was read off the Watchman's own row, which the
     * projector already skips for a body that is not alive. Moving it to the
     * ally must not lose that.
     */
    const { world, talents, effects, dalt } = guardScene();
    talents.addEffect('p1', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 3, power: 0 });
    dalt.alive = false;

    expect(guardedIn(projectEffects(world, effects, talents))).toEqual([]);
  });

  it('draws one badge for two curtains over one ally, lasting as long as the longer', () => {
    /**
     * Two Watchmen can cover the same Inspector. The row answers "is this body
     * guarded, and for how long", so it is ONE badge carrying the turns of the
     * curtain that stands longest — the shorter one lapsing changes nothing the
     * ally can see.
     *
     * THREE guardians, with the longest in the MIDDLE of the world's insertion
     * order, so neither "first one wins" nor "last one wins" can pass for it.
     */
    const { world, talents, effects } = guardScene();
    for (const id of ['p3', 'p4']) {
      const body = world.addPlayer(id, id, { maxHp: WATCHMAN.maxHp });
      body.x = 5;
      body.y = 6;
    }
    talents.addEffect('p1', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 1, power: 0 });
    talents.addEffect('p3', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 3, power: 0 });
    talents.addEffect('p4', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 2, power: 0 });

    expect(guardedIn(projectEffects(world, effects, talents))).toEqual([['p2', 3]]);
  });

  it('is still gated on the COVERED body being seen', () => {
    // A badge is a fact about the body it is drawn on (`projectEffects`'s
    // `seen`), so an ally out of this viewer's sight carries none — even though
    // the guardian holding the effect is in plain view. And the other way round:
    // the ally in view keeps the badge when the guardian is not, because the
    // guardian's visibility is not what the badge describes.
    const { world, talents, effects } = guardScene();
    talents.addEffect('p1', { kind: TalentEffect.Guarding, otherId: 'p2', turns: 3, power: 0 });

    expect(guardedIn(projectEffects(world, effects, talents, new Set(['p1'])))).toEqual([]);
    expect(guardedIn(projectEffects(world, effects, talents, new Set(['p2'])))).toEqual([
      ['p2', 3],
    ]);
  });
});
