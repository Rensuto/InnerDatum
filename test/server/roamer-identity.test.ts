import { describe, expect, it } from 'vitest';

import { ambushRoster } from '../../src/server/content/encounter.ts';
import { MONSTER_TEMPLATES, monsterById } from '../../src/server/content/monsters.ts';
import { ROAMER_KINDS } from '../../src/server/world/roamers.ts';
import { Ground } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THING YOU WALKED INTO IS THE THING YOU MEET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `world/roamers.ts` has carried that promise in its header since roamers
 * landed, word for word:
 *
 *   > a roamer that looked like a husk and produced a wraith would make the
 *   > decision it exists to offer a lie.
 *
 * IT WAS A LIE FOR THE WHOLE OF THAT TIME. The marker's identity was never
 * passed to `ambushRoster`, so all four kinds resolved to the same room, and
 * one of them — *Something Redacted* — had no creature behind it at all.
 *
 * The reason this file exists rather than a single assertion is that the bug
 * was INVISIBLE FROM EVERY SIDE. The roamers were correct, the ambush was
 * correct, the sprites were correct, the log line named the right creature.
 * Only the join between two correct halves was missing, and nothing in a
 * codebase points at a join that is not there. So the join is asserted from
 * both ends: the pool is honest, and the room agrees with it.
 */

describe('the roamers on the moor', () => {
  it('is a real creature for every kind, not a name and a picture of one', () => {
    // THE ONE THAT WAS BROKEN: 'Something Redacted' wore `enemy_index_glut_s`
    // and there was no glut. A kind whose template is not in the registry draws
    // a marker that opens onto somebody else's fight.
    expect(ROAMER_KINDS.length).toBeGreaterThan(0);
    for (const kind of ROAMER_KINDS) {
      expect(monsterById(kind.template.id), kind.label).toBeDefined();
      expect(MONSTER_TEMPLATES).toContain(kind.template);
    }
  });

  it('draws each one with its own creature’s sprite', () => {
    /**
     * The sprite is READ OFF the template rather than typed beside it, so this
     * holds by construction — which is the point. It is asserted anyway because
     * the previous table typed them separately and that is exactly how a marker
     * and its creature came to disagree; a future refactor that reintroduces a
     * sprite column fails here rather than in somebody's evening.
     */
    // `expect(k.template.sprite).toBe(k.template.sprite)` was here and was
    // deleted: it compares a value to itself and passes against any build. The
    // real claims are that the sprite is an ENEMY sprite rather than a marker —
    // roamers drew `tile_ow_site_breach` once and were reported from play as
    // *"the enemies do not seem to have enemy assets"* — and that the four are
    // four different pictures.
    for (const kind of ROAMER_KINDS) {
      expect(kind.template.sprite.startsWith('enemy_'), kind.label).toBe(true);
    }
    // AND NO TWO KINDS LOOK THE SAME. Four markers a player is asked to choose
    // between must be four different pictures, or the choice is not offered.
    const sprites = new Set(ROAMER_KINDS.map((k) => k.template.sprite));
    expect(sprites.size).toBe(ROAMER_KINDS.length);
  });

  it('puts that creature in the room, at every party size', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE JOIN. THIS IS THE ASSERTION THE WHOLE FILE IS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * FIRST in the roster and at every strength, because `seedAmbush` fills the
     * ring by cycling the list — being first is what guarantees it is placed
     * when only one monster fits, which is the lone level-1 case and the one
     * where being lied to costs the most.
     */
    for (const kind of ROAMER_KINDS) {
      for (const party of [
        { level: 1, size: 1 },
        { level: 4, size: 3 },
        { level: 8, size: 5 },
      ]) {
        for (const ground of [Ground.Open, Ground.Wood, Ground.Fen]) {
          const roster = ambushRoster(party, ground, kind.template);
          expect(roster[0], `${kind.label} at level ${String(party.level)}`).toBe(kind.template);
        }
      }
    }
  });

  it('still produces the roster it always did when nothing was walked into', () => {
    // NOT EVERY AMBUSH COMES FROM A MARKER, and one that does not must be
    // unchanged — the `lead` is an addition to this function, not a new
    // requirement of it.
    const roster = ambushRoster({ level: 1, size: 1 }, Ground.Upland);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe('index_husk');
  });

  it('lets the ground still add its own, on top of what you walked into', () => {
    /**
     * The two systems are independent and both have to survive. `ambushRoster`
     * says a ground *"puts ONE MORE THING in the room that belongs there"*, and
     * the lead must not have quietly replaced that: walking a wrong shadow into
     * a wood should produce the shadow AND the thing that lives in woods.
     */
    const wood = ambushRoster({ level: 1, size: 1 }, Ground.Wood, ROAMER_KINDS[3]?.template);
    expect(wood.some((t) => t.id === 'index_eidolon')).toBe(true);
    expect(wood[0]).toBe(ROAMER_KINDS[3]?.template);
  });
});

describe('the Index Glut', () => {
  it('is the only thing in the game that heals, which is its whole fight', () => {
    /**
     * Asserted as a UNIQUENESS rather than as `hpRegen === 2`, because the
     * number is a port (`troll.lua:39`) and the DESIGN is that exactly one
     * creature forces a party to out-damage a threshold rather than out-last
     * it. A second regenerating monster is a real decision somebody should make
     * on purpose, and this is what makes them notice they are making it.
     */
    const healers = MONSTER_TEMPLATES.filter((t) => t.hpRegen > 0);
    expect(healers.map((t) => t.id)).toEqual(['index_glut']);
  });

  it('is armoured and cannot hit anything, which is the trade', () => {
    const glut = monsterById('index_glut');
    expect(glut).toBeDefined();
    if (glut === undefined) return;

    // THE HIGHEST ARMOUR AND THE LOWEST ACCURACY IN THE GAME, stated as
    // comparisons so that rebalancing anything else has to come past this: the
    // creature is only interesting while both halves of the trade are true.
    // `combat.mods` is optional on the template, and an absent block means zero
    // of both — the cairn and the wraith declare no armour at all.
    const armourOf = (t: (typeof MONSTER_TEMPLATES)[number]): number => t.combat.mods?.armour ?? 0;
    const others = MONSTER_TEMPLATES.filter((t) => t.id !== 'index_glut');
    expect(Math.max(...others.map(armourOf))).toBeLessThan(armourOf(glut));
    const atkOf = (t: (typeof MONSTER_TEMPLATES)[number]): number => t.combat.weapon?.atk ?? 0;
    expect(Math.min(...others.map(atkOf))).toBeGreaterThan(atkOf(glut));
  });

  it('is not the wall the first draft of its own comment claimed', () => {
    // A CORRECTION MADE PERMANENT. That comment said sixty hit points was "the
    // largest pool in the game"; the wraith has eighty and the elite ninety-five,
    // and a level-3 party already meets the wraith. Pinned so nobody re-derives
    // a difficulty argument from a number that was never true.
    const glut = monsterById('index_glut');
    const bigger = MONSTER_TEMPLATES.filter((t) => t.maxHp > (glut?.maxHp ?? 0));
    expect(bigger.map((t) => t.id).sort()).toEqual(['index_husk_elite', 'index_wraith']);
  });
});
