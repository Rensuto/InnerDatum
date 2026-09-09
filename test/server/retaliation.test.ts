import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { PlayerActor } from '../../src/server/engine/actor.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `on_melee_hit` — WHAT IT COSTS TO PUT A HAND ON SOMEBODY. Combat.lua:851-891.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if hitted then
 *   for typ, dam in pairs(target.on_melee_hit) do
 *     if dam > 0 then DT.projector(target, self.x, self.y, typ, dam) end
 * ```
 *
 * That is the whole rule with Close Combat Management absent, which sets the
 * `fa`/`pct` pair the loop otherwise consults; nothing in this game grants it.
 *
 * ═══ EVERY TEST HERE DRIVES `engine.pump()` AND NOT `noteRetaliation` ═══
 * The function is a loop of flat arithmetic wrapped in a lane. The lane is the
 * part that can be wrong: whether it runs on a monster's turn as well as a
 * player's, whether the damage reaches a real body's `hp`, whether a kill it
 * causes reaches the reap list under the DEFENDER's name rather than the
 * attacker's. A unit test of the arithmetic would pass with both call sites
 * deleted, which is the failure mode this repository keeps rediscovering.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BOTH SIDES OF THE COIN TOSS REMOVED, AND THE SECOND HALF IS NOT DECORATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hitChance` is `bound(ceil(50 + 2.5 * (atk - def)), 0, 100)` — no floor and
 * no ceiling short of the ends — so accuracy 30 against defence 0 is a certain
 * hit and accuracy 4 against defence 400 is a certain miss. Every outcome in
 * this file is decided by the fixture rather than by the seed.
 *
 * The DEFENCE matters as much as the accuracy: a pump runs the husk's turn too,
 * and its swing back landed 4 points on the detective in the first draft of
 * every test here. An hp assertion that quietly included somebody else's blow
 * would have passed with the retaliation deleted.
 */
const NEVER_MISSES: CombatSheet = { mods: { atk: 30, def: 400 } };

/** The mirror: this body cannot land a blow, and the swing back cannot land on it. */
const NEVER_CONNECTS: CombatSheet = { mods: { def: 400 } };

type Scene = {
  readonly world: World;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
  /**
   * The same body NARROWED TO A PLAYER, because `xp` lives on `PlayerActor` and
   * not on the union — asking a husk for experience is a compile error here
   * rather than an `undefined` that reads as zero.
   */
  readonly detective: (id: string) => PlayerActor;
};

/**
 * One detective at (10,10) and one husk on the tile east of them, each able to
 * reach the other, with the fight already armed.
 */
function scene(
  seed: string,
  options: {
    readonly huskHp?: number;
    readonly huskSheet?: CombatSheet;
    readonly playerSheet?: CombatSheet;
  } = {},
): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 10;
  ren.y = 10;
  // No regeneration anywhere in this file: every hp difference asserted below
  // has to be the retaliation and not a tick of healing that happened to land.
  ren.hpRegen = 0;
  ren.combat = options.playerSheet ?? NEVER_MISSES;

  const husk = world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 11,
    y: 10,
    profile: AiProfile.MeleeChaser,
    maxHp: options.huskHp ?? 40,
  });
  husk.hpRegen = 0;
  if (options.huskSheet !== undefined) husk.combat = options.huskSheet;

  const engine = createTurnEngine({ world, now: () => 0 });
  engine.join('p1');
  world.turn.engagement = 3;

  return {
    world,
    engine,
    actor: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      return found;
    },
    detective: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      if (found.kind !== ActorKind.Player) throw new Error(`test fixture: ${id} is not a player`);
      return found;
    },
  };
}

describe('retaliation — the player lane', () => {
  it('costs the attacker hp when the body they hit is wearing spikes', () => {
    const table = scene('retal-player', {
      huskSheet: { retaliation: { [DamageType.Physical]: 5 } },
    });
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    // Five points, exactly: a flat projector, no crit, no damage band, and —
    // the finding of the commit before this one — no armour step either.
    expect(table.actor('p1').hp).toBe(before - 5);
  });

  it('leaves nothing on a MISS, which is upstream only guard', () => {
    // A swing with no accuracy bonus against a defence nothing beats.
    const table = scene('retal-miss', {
      playerSheet: NEVER_CONNECTS,
      huskSheet: { mods: { def: 400 }, retaliation: { [DamageType.Physical]: 5 } },
    });
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('p1').hp).toBe(before);
  });

  it('STILL fires when the blow was fully absorbed, unlike the guard counter', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE PLACE THIS RULE AND `noteGuardCounter` DELIBERATELY DIVERGE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * That function refuses `effect.damage <= 0` — a fully-armoured zero is a
     * non-event, and for a Watchman's punish that is right. Upstream sets
     * `hitted = true` at Combat.lua:621 unconditionally inside the branch where
     * the blow connected, AFTER armour and after any parry. So a blow a
     * breastplate reduced to nothing still connected and the spikes still went
     * in. Being untouchable and being unhittable are different things, and the
     * affix is bought for the first.
     */
    const table = scene('retal-absorbed', {
      // Armour far past the swing, at high hardiness: the hit lands and deals
      // nothing. See `applyArmour` — only the hardiness fraction is eligible.
      huskSheet: {
        mods: { armour: 500, armourHardiness: 70, atk: 30 },
        retaliation: { [DamageType.Physical]: 5 },
      },
    });
    const before = table.actor('p1').hp;
    const huskBefore = table.actor('m_husk').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('m_husk').hp, 'the swing got through the armour').toBe(huskBefore);
    expect(table.actor('p1').hp, 'a landed blow that dealt nothing paid nothing').toBe(before - 5);
  });

  it('fires from a body the blow just KILLED — the guard upstream does not write', () => {
    /**
     * The brand at Combat.lua:723 is guarded by `not target.dead`. The Acid
     * Blood block two lines BELOW this one, at :893, is guarded by
     * `not target.dead`. This block is not, in a file that plainly knows how to
     * write it. So a body can trade its last moment for the kill.
     */
    const table = scene('retal-dying', {
      huskSheet: { retaliation: { [DamageType.Physical]: 5 } },
    });
    table.actor('m_husk').hp = 1;
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(result.reaped, 'the husk survived a swing that should have killed it').toEqual([
      'm_husk',
    ]);
    expect(table.actor('m_husk').alive).toBe(false);
    expect(table.actor('p1').hp, 'a corpse kept its spikes to itself').toBe(before - 5);
  });

  it('adds across types and reports the first that landed', () => {
    // Upstream loops the whole table and projects each type separately, so two
    // rows are two projections. The wire carries one `type` per blow.
    const table = scene('retal-two-types', {
      huskSheet: {
        retaliation: { [DamageType.Physical]: 4, [DamageType.Fire]: 3 },
      },
    });
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(table.actor('p1').hp).toBe(before - 7);
    // ONE `damage` line, ATTRIBUTED TO THE HUSK. That attribution is the whole
    // reason this is re-entered as its own effect rather than folded into the
    // detective's swing — see the sweep-lane kill test below.
    const paid = result.playerEvents.filter((e) => e.k === 'damage' && e.id === 'p1');
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      amount: 7,
      sourceId: 'm_husk',
      type: DamageType.Physical,
    });
  });

  it('is skipped entirely when every row is zero', () => {
    // `if dam > 0`. No damage, and therefore no `attacked` event narrating a
    // blow that did not happen.
    const table = scene('retal-zero', {
      huskSheet: { retaliation: { [DamageType.Physical]: 0 } },
    });
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(table.actor('p1').hp).toBe(before);
    expect(result.playerEvents.filter((e) => e.k === 'damage' && e.id === 'p1')).toEqual([]);
  });
});

describe('retaliation — the sweep lane', () => {
  it('bleeds a husk that swings at a detective in spiked plate', () => {
    const table = scene('retal-sweep', {
      // The detective swings and CANNOT connect, so the only thing that moves
      // the husk's hp in this pump is the husk's own swing coming back at it.
      playerSheet: { retaliation: { [DamageType.Physical]: 6 } },
      huskSheet: { mods: { def: 400, atk: 30 } },
    });
    const huskBefore = table.actor('m_husk').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('m_husk').hp).toBe(huskBefore - 6);
  });

  it('reaps a husk its own swing killed, crediting the DEFENDER', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE WHOLE REASON THIS IS ITS OWN EFFECT AND NOT A FIELD ON THE SWING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `noteCasualty` spends ONE `killerId` on `noteKill` and on
     * `awardExperience`. Ride the retaliation on the husk's own attack effect
     * and the husk is paid experience for killing itself. Re-entered under the
     * defender's id, every rule downstream — reap enrolment, the kill credit,
     * the party share — applies unchanged.
     */
    const table = scene('retal-sweep-kill', {
      huskHp: 4,
      playerSheet: { retaliation: { [DamageType.Physical]: 6 } },
      huskSheet: { mods: { def: 400, atk: 30 } },
    });

    const husk = table.actor('m_husk');
    expect(table.detective('p1').xp).toBe(0);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(result.reaped).toEqual(['m_husk']);
    expect(husk.alive).toBe(false);
    // THE ASSERTION THE ATTRIBUTION IS FOR. `awardExperience` pays the
    // `killerId` `noteCasualty` was handed; pass the husk's own id and this is
    // 0 while everything above it still passes.
    expect(table.detective('p1').xp).toBeGreaterThan(0);
  });
});
