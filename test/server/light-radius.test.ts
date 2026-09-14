import { describe, expect, it } from 'vitest';

import { liteRadiusOf } from '../../src/server/engine/derived.ts';
import { Slot, itemById } from '../../src/server/content/items.ts';
import { composeSheet, composeWielders } from '../../src/server/engine/equipment.ts';
import { inspectActor } from '../../src/server/view/inspect.ts';
import { createWorld } from '../../src/server/world/world.ts';

describe('the light a body carries', () => {
  it('is none by default, as upstream starts every actor', () => {
    // tome/class/Actor.lua:182: `t.lite = t.lite or 0`.
    expect(liteRadiusOf({})).toBe(0);
    expect(liteRadiusOf({ combat: {} })).toBe(0);
  });

  it('adds what gear grants, and two grants stack', () => {
    const sheet = composeWielders({}, [{ mods: { lite: 2 } }, { mods: { lite: 1 } }]);
    expect(liteRadiusOf({ combat: sheet })).toBe(3);
  });

  it('may go below zero, which is how upstream’s stealth carries darkness', () => {
    // data/talents/cunning/stealth.lua:91 takes a thousand off it. Not floored.
    expect(liteRadiusOf({ combat: { mods: { lite: -1000 } } })).toBe(-1000);
  });

  it('prints on your own sheet, read from the channel and not a constant', () => {
    const world = createWorld('light-readout');
    const viewer = world.addPlayer('p1', 'Dalt');
    const before = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(before).toContainEqual(expect.objectContaining({ label: 'Light radius', value: '0' }));

    viewer.combat = {
      ...(viewer.combat ?? {}),
      mods: { ...(viewer.combat?.mods ?? {}), lite: 2 },
    };
    const after = inspectActor(world, viewer, viewer)?.rows ?? [];
    expect(after, 'the row is wired to a constant, not to `CombatMods.lite`').toContainEqual(
      expect.objectContaining({ label: 'Light radius', value: '2' }),
    );
  });
});

describe('upstream’s three lanterns', () => {
  it('are worn in the light slot and light 2, 3 and 4 tiles', () => {
    // data/general/objects/lites.lua:30-70.
    const lanterns = [
      ['item_brass_lantern', 2],
      ['item_alchemists_lamp', 3],
      ['item_dwarven_lantern', 4],
    ] as const;
    for (const [id, lite] of lanterns) {
      const item = itemById(id);
      expect(item?.slot, id).toBe(Slot.Lite);
      const sheet = composeSheet({}, item === undefined ? [] : [item]);
      expect(liteRadiusOf({ combat: sheet }), id).toBe(lite);
    }
  });
});
