import { describe, expect, it } from 'vitest';

import { createDownedState } from '../../src/server/engine/downed.ts';
import { createPartyState } from '../../src/server/engine/party.ts';
import { createRealms } from '../../src/server/world/realms.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import type { Realm } from '../../src/server/world/realms.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      AN ACTION ADVANCES THE REALM IT HAPPENED IN. NOT EVERY REALM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every player action used to pump every realm in the process. Measured on
 * this machine: 24 players on one map with six realms open cost about 57 ms of
 * pure projection for one round of everybody acting — six times what it needed
 * to, because five of those realms had not changed and their frames were
 * rebuilt, stringified and thrown away.
 *
 * IT GROWS WITH THE NUMBER OF OPEN INSTANCES, which is exactly the number that
 * grows on a busy evening: five parties in five breaches means five realms, and
 * every keystroke by anybody pays for all of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A TEST AND NOT A NOTE IN A COMMIT MESSAGE
 * ═══════════════════════════════════════════════════════════════════════════
 * The property is INVISIBLE. Pumping too much is not a bug — every frame is
 * memoised, so the extra work produces no wrong output, only heat. So nothing
 * fails when somebody widens it back, and nothing will fail until a Friday
 * night with six people in four instances.
 *
 * These tests are therefore about the ENGINE-LEVEL invariant the narrowing
 * rests on, which is the part that could actually be wrong: a realm nobody is
 * acting in has nothing that needs another realm's keystroke to advance it.
 */

function scene(seed: string): {
  realms: ReturnType<typeof createRealms>;
  overworld: Realm;
} {
  const downed = createDownedState();
  const parties = createPartyState();
  const realms = createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, downed, parties }),
  });
  return { realms, overworld: realms.overworld };
}

describe('a realm advances only when somebody in it acts', () => {
  it('leaves an untouched realm’s clock exactly where it was', () => {
    // THE WHOLE CLAIM. Pumping realm A must not move realm B's clock, because
    // B's clock is what its own players are waiting on.
    const { realms, overworld } = scene('pump-scope');
    const others = realms.all().filter((realm) => realm.id !== overworld.id);
    expect(others.length).toBeGreaterThan(0);

    const player = overworld.world.addPlayer('p1', 'Ren');
    overworld.engine.join(player.id);
    overworld.engine.setConnected(player.id, true);

    const before = others.map((realm) => realm.world.turn.clock.tick);
    for (let i = 0; i < 20; i += 1) overworld.engine.pump();
    expect(others.map((realm) => realm.world.turn.clock.tick)).toEqual(before);
  });

  it('advances a realm with nobody in it not at all, however hard it is pumped', () => {
    // The other half of the same fact, and the reason narrowing is safe rather
    // than merely cheaper: an empty realm has nothing to advance. Pumping it
    // from another realm's keystroke was never doing work — it was doing
    // arithmetic and throwing it away.
    const { realms, overworld } = scene('pump-empty');
    const empty = realms.all().find((realm) => realm.id !== overworld.id);
    if (empty === undefined) throw new Error('unreachable');

    const before = empty.world.turn.clock.tick;
    for (let i = 0; i < 50; i += 1) empty.engine.pump();
    expect(empty.world.turn.clock.tick).toBe(before);
  });

  it('keeps a monster in one realm still while another realm runs', () => {
    // The failure this would present as if the narrowing were wrong: a party
    // fighting in a breach would find their monsters frozen while somebody
    // walked around Alderbrook. It is worth stating as a MONSTER position and
    // not only as a clock, because that is the symptom a player would report.
    const { realms, overworld } = scene('pump-monster');
    const other = realms.all().find((realm) => realm.id !== overworld.id);
    if (other === undefined) throw new Error('unreachable');

    const husk = other.world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 6,
      y: 6,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
    });
    const at = { x: husk.x, y: husk.y };

    const player = overworld.world.addPlayer('p1', 'Ren');
    overworld.engine.join(player.id);
    overworld.engine.setConnected(player.id, true);
    for (let i = 0; i < 30; i += 1) overworld.engine.pump();

    // Still exactly where it was. Nobody is in there to fight it, and nobody
    // outside can make it act.
    expect({ x: husk.x, y: husk.y }).toEqual(at);
  });

  it('does advance the realm that IS acting, so this is not a proof about a dead engine', () => {
    // THE CONTROL. Without it every assertion above would pass on a build where
    // `pump` did nothing at all.
    const { overworld } = scene('pump-control');
    const player = overworld.world.addPlayer('p1', 'Ren');
    overworld.engine.join(player.id);
    overworld.engine.setConnected(player.id, true);
    overworld.world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: player.x + 2,
      y: player.y,
      profile: AiProfile.MeleeChaser,
      maxHp: 30,
    });

    const before = overworld.world.turn.clock.tick;
    for (let i = 0; i < 30; i += 1) overworld.engine.pump();
    expect(overworld.world.turn.clock.tick).toBeGreaterThan(before);
  });
});
