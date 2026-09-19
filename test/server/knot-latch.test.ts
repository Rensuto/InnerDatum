// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { ITEMS, KNOT_OF_ELSEWHERE_ID } from '../../src/server/content/items.ts';
import { UNDERMOST_WARDEN, monsterInit } from '../../src/server/content/monsters.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { HOLD_INTENT, IntentKind } from '../../src/server/engine/actor.ts';
import { submitIntent } from '../../src/server/engine/scheduler.ts';
import { createCharacterFile, parseCharacterFile } from '../../src/server/persist/saves.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST WARDEN YOU KILL GIVES YOU A KNOT. NO OTHER ONE EVER DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NPC:onDie` (tome/class/NPC.lua:393-406) drops the Rod of Recall from the
 * first body of rank 4 or over a character kills and spends the latch on the
 * way out — `game.state:allowRodRecall(false)` at :406, a one-shot on that
 * character's own game state (class/GameState.lua:93-96).
 *
 * WHAT THIS FILE IS ABOUT. The Undermost is a marked, walkable, re-populating
 * destination and `realm-wipe.test.ts` puts the warden back after a wipe, so
 * before the latch existed the measurement was three visits, three wardens,
 * three Knots. That was harmless only while the Knot had no `use`; the button
 * shipped the day before this did.
 *
 * ═══ THE REAL SEAM, NOT A COPY OF IT ═══
 * Every case here drives `createTurnEngine`, which is the only thing that wires
 * `loot: { spillOrder: spillOrderOf }` — the production join. `loot.test.ts`
 * builds its own `LootResolution` by hand, and a fixture that re-implements the
 * function under test is a fixture that stays green while the rule is deleted.
 */

/**
 * A weapon that always lands and always rolls the same number — `loot.test.ts`
 * and `progression-award.test.ts` carry the same fixture and the same argument:
 * a kill arranged by picking a lucky seed converts a structural property into a
 * coincidence.
 */
const FLAT_SIX: CombatSheet = { weapon: { dam: 20, atk: 100, damRange: 1.0 }, minRange: 0 };

/**
 * WHAT THE WARDEN IS HOLDING, exactly as `populateUndermostHall` builds it: the
 * key by its raw id, then its ordinary prize. The second id is what keeps every
 * case here honest — "nothing dropped" would also be the answer if the spill
 * had simply stopped working.
 */
const PRIZE = UNDERMOST_WARDEN.drops?.pick[0] ?? 'item_inspectors_signet';

type Arena = {
  readonly world: World;
  /** A character, with a sheet that kills in one swing. */
  readonly character: (id: string) => Actor;
  /** A warden on the tile east of `x`, holding the key and its prize. */
  readonly warden: (id: string, at: TileXY) => Actor;
  /** Swing until it is down. Answers the ids left on the tile it fell on. */
  readonly kill: (characterId: string, wardenId: string) => readonly string[];
  /** Let a sourceless hazard finish it instead. Same answer, no killer. */
  readonly burn: (characterId: string, wardenId: string, at: TileXY) => readonly string[];
};

function arena(seed: string): Arena {
  const world = createWorld(seed);
  let ms = 0;
  const engine = createTurnEngine({ world, now: () => (ms += 100) });

  const character = (id: string): Actor => {
    const body = world.addPlayer(id, id);
    body.x = 11;
    body.y = 2;
    body.maxHp = 10_000;
    body.hp = 10_000;
    body.hpRegen = 0;
    body.combat = FLAT_SIX;
    engine.join(id);
    return body;
  };

  const warden = (id: string, at: TileXY): Actor => {
    const body = world.addMonster(id, monsterInit(UNDERMOST_WARDEN, at));
    // A BOSS'S REAL HIT POINTS WOULD BE A HUNDRED PUMPS OF NOTHING. The rule
    // under test is about `carried`, not about the fight — `boss-fight.test.ts`
    // is where the fight is watched.
    body.maxHp = 5;
    body.hp = 5;
    body.carried = [KNOT_OF_ELSEWHERE_ID, PRIZE];
    return body;
  };

  const kill = (characterId: string, wardenId: string): readonly string[] => {
    const body = world.getActor(wardenId);
    if (body === undefined) throw new Error(`no warden ${wardenId}`);
    const fell = { x: body.x, y: body.y };
    for (let swing = 0; swing < 40 && body.alive; swing += 1) {
      fell.x = body.x;
      fell.y = body.y;
      submitIntent(world, engine.barrier, characterId, {
        kind: IntentKind.Attack,
        targetId: wardenId,
      });
      engine.pump();
    }
    expect(body.alive, 'the warden is still standing after forty swings').toBe(false);
    return world.itemsAt(fell.x, fell.y).map((entry) => entry.itemId);
  };

  /**
   * THE FLOOR KILLS IT AND NOBODY IS CREDITED — a zone whose source is not in
   * the world, which `tickZones` describes in its own words: *"no source means
   * no mercy"*, and `tickGroundZones` says `noteCasualty` *"handles an unknown
   * killer id the way it always has"*. It is the shape of a bleed whose author
   * has already been buried.
   */
  const burn = (characterId: string, wardenId: string, at: TileXY): readonly string[] => {
    const body = world.getActor(wardenId);
    if (body === undefined) throw new Error(`no warden ${wardenId}`);
    world.addZone({
      srcId: 'nobody',
      tiles: [at],
      type: DamageType.Physical,
      damage: 50,
      turns: 3,
      selfFire: false,
      friendlyFire: true,
    });
    for (let turn = 0; turn < 10 && body.alive; turn += 1) {
      submitIntent(world, engine.barrier, characterId, HOLD_INTENT);
      engine.pump();
    }
    expect(body.alive, 'the floor never killed it').toBe(false);
    return world.itemsAt(at.x, at.y).map((entry) => entry.itemId);
  };

  return { world, character, warden, kill, burn };
}

// ---------------------------------------------------------------------------
// 1 — the latch itself
// ---------------------------------------------------------------------------

describe('the Knot is handed to a character once, ever', () => {
  it('pays the first warden in full, and writes it down', () => {
    const scene = arena('knot-first');
    const ren = scene.character('p1');
    scene.warden('w1', { x: 12, y: 2 });

    expect(scene.kill('p1', 'w1'), 'the key did not reach the floor').toEqual([
      KNOT_OF_ELSEWHERE_ID,
      PRIZE,
    ]);
    // ...AND THE LATCH IS SPENT, which is `allowRodRecall(false)` (NPC.lua:406).
    // Without this line the next case would be a coincidence.
    expect(ren.kitGranted, 'nothing was written down').toContain(KNOT_OF_ELSEWHERE_ID);
  });

  it('pays a SECOND warden its prize and nothing else', () => {
    // THE WHOLE FEATURE. Three visits used to mint three Knots, and the item
    // became worth farming the day it got a button.
    const scene = arena('knot-second');
    scene.character('p1');
    scene.warden('w1', { x: 12, y: 2 });
    scene.warden('w2', { x: 10, y: 2 });

    expect(scene.kill('p1', 'w1')).toEqual([KNOT_OF_ELSEWHERE_ID, PRIZE]);
    // THE PRIZE IS STILL THERE, and that is half the assertion: a latch that
    // swallowed the whole spill would pass a test that only looked for the key.
    expect(scene.kill('p1', 'w2'), 'a second Knot was minted').toEqual([PRIZE]);
  });

  it('pays a different character who has never been handed one', () => {
    // PER CHARACTER, NOT PER WORLD. A party of four does not spend its fifth
    // friend's Knot for them — each is paid by their own first warden, which is
    // the rule `awardExperience` is built on.
    const scene = arena('knot-two-characters');
    const ren = scene.character('p1');
    const other = scene.character('p2');
    scene.warden('w1', { x: 12, y: 2 });
    scene.warden('w2', { x: 10, y: 2 });

    expect(scene.kill('p1', 'w1')).toEqual([KNOT_OF_ELSEWHERE_ID, PRIZE]);
    expect(scene.kill('p2', 'w2'), 'the second character was latched by the first').toEqual([
      KNOT_OF_ELSEWHERE_ID,
      PRIZE,
    ]);
    expect(ren.kitGranted).toContain(KNOT_OF_ELSEWHERE_ID);
    expect(other.kitGranted).toContain(KNOT_OF_ELSEWHERE_ID);
  });

  it('does not latch a character who was paid nothing', () => {
    // A LATCH SPENT ON A KILL THAT PAID NOTHING is the failure that costs a
    // player their only Knot and is invisible until they go looking for it.
    const scene = arena('knot-no-key');
    const ren = scene.character('p1');
    const empty = scene.warden('w1', { x: 12, y: 2 });
    empty.carried = [PRIZE];

    expect(scene.kill('p1', 'w1')).toEqual([PRIZE]);
    // UNTOUCHED, NOT MERELY "WITHOUT THE KNOT". Absent is not empty in the save
    // layer either — `parseKitGranted` keeps the distinction and the gateway's
    // snapshot omits the key entirely for `undefined` — so "nothing has ever
    // been handed to this character" has to stay sayable. A write-back that ran
    // on every kill would also allocate a new array per corpse, for ever.
    expect(ren.kitGranted, 'the ledger was written by a kill that handed nothing over').toBe(
      undefined,
    );
  });

  it('hands it over, and latches nobody, when nobody is credited with the kill', () => {
    /**
     * UPSTREAM'S INSURANCE CLAUSE IS THE ARGUMENT (NPC.lua:397-401): when the
     * rod cannot be reached it goes straight into the player's bag, *"to make
     * absolutely sure they get the Rod of Recall"*. The failure upstream is
     * afraid of is the key being LOST, not the key being minted twice — so a
     * warden that bleeds out from a wound whose author has been buried pays
     * out, and no character's latch moves.
     */
    const scene = arena('knot-no-killer');
    const bystander = scene.character('p1');
    scene.warden('w1', { x: 12, y: 2 });

    expect(scene.burn('p1', 'w1', { x: 12, y: 2 })).toEqual([KNOT_OF_ELSEWHERE_ID, PRIZE]);
    expect(bystander.kitGranted ?? [], 'a latch was spent on a kill nobody made').not.toContain(
      KNOT_OF_ELSEWHERE_ID,
    );
  });

  it('is written against the character who already holds one, not the bag', () => {
    // HANDED, NEVER HOLDING. The ledger is not a second copy of the bag that
    // can disagree with it: a character who was handed one and has lost it gets
    // nothing from a second warden, deliberately, and `spillOrderOf` says why.
    const scene = arena('knot-lost-it');
    const ren = scene.character('p1');
    ren.kitGranted = [KNOT_OF_ELSEWHERE_ID];
    ren.carried = [];
    scene.warden('w1', { x: 12, y: 2 });

    expect(scene.kill('p1', 'w1')).toEqual([PRIZE]);
  });
});

// ---------------------------------------------------------------------------
// 2 — the catalogue says which ids this rule is about
// ---------------------------------------------------------------------------

describe('what the rule is keyed on', () => {
  it('is a field on the item, and only the Knot carries it', () => {
    // NOT A HARD-CODED ID IN THE ADAPTER. `spillOrderOf` asks the catalogue, so
    // a second unique needs one line of content rather than an edit to the turn
    // engine — and `resolveItem` is what it asks, which is the function that
    // survives an ego or a material grade on the id.
    expect(resolveItem(KNOT_OF_ELSEWHERE_ID)?.oncePerCharacter).toBe(true);
    expect(ITEMS.filter((item) => item.oncePerCharacter === true).map((item) => item.id)).toEqual([
      KNOT_OF_ELSEWHERE_ID,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3 — the ledger it is written in
// ---------------------------------------------------------------------------

describe('the ledger survives the disk', () => {
  const BASE = {
    id: 'chr_probe',
    ownerId: '111111111111111111',
    name: 'Ren',
    classId: 'class:watchman',
    resources: { hp: 30, ap: 0, mp: 0, special: { kind: '', value: 0 } },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('round-trips the Knot beside the lantern', () => {
    const file = createCharacterFile({
      ...BASE,
      kitGranted: ['item_brass_lantern', KNOT_OF_ELSEWHERE_ID],
    });
    const parsed = parseCharacterFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.kitGranted).toEqual(['item_brass_lantern', KNOT_OF_ELSEWHERE_ID]);
  });

  it('reads a file written before the latch existed as “never handed one”', () => {
    /**
     * THE MIGRATION THAT IS NOT ONE, and the reason the latch went into
     * `kitGranted` rather than into a flag of its own. Every character that
     * exists today was saved before this rule did, so the question "what does an
     * old file mean" is the whole compatibility story: an absent id has meant
     * "has not been given one yet" since birth kits shipped, `SCHEMA_VERSION`
     * does not move, and the character is paid by the next warden they kill.
     */
    const file = createCharacterFile({ ...BASE, kitGranted: ['item_brass_lantern'] });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    expect(doc['kitGranted'], 'the fixture is not an old file').not.toContain(KNOT_OF_ELSEWHERE_ID);

    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // ...AND THE LOADED FILE REACHES A BODY AND IS PAID. `restoreLoadout`
    // (net/gateway.ts) is the production line — `actor.kitGranted =
    // [...restore.kitGranted]` — and `gateway-inventory.test.ts` drives it over
    // a socket for the lantern. This is the half that rule cares about: what an
    // old file's ledger does at the warden.
    const scene = arena('knot-old-save');
    const ren = scene.character('p1');
    ren.kitGranted = [...(parsed.file.kitGranted ?? [])];
    scene.warden('w1', { x: 12, y: 2 });

    expect(scene.kill('p1', 'w1'), 'an old save was treated as already paid').toEqual([
      KNOT_OF_ELSEWHERE_ID,
      PRIZE,
    ]);
    expect(ren.kitGranted).toEqual(['item_brass_lantern', KNOT_OF_ELSEWHERE_ID]);
  });

  it('hands one over to a file that was carrying nothing at all', () => {
    // `kitGranted` IS OPTIONAL AND ABSENT IS NOT EMPTY anywhere else in the save
    // layer, so it must not be the one place where absent means "already paid".
    const file = createCharacterFile({ ...BASE });
    const doc = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    delete doc['kitGranted'];
    const parsed = parseCharacterFile(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.kitGranted).toBeUndefined();

    const scene = arena('knot-empty-ledger');
    const ren = scene.character('p1');
    if (parsed.file.kitGranted !== undefined) ren.kitGranted = [...parsed.file.kitGranted];
    scene.warden('w1', { x: 12, y: 2 });

    expect(scene.kill('p1', 'w1')).toEqual([KNOT_OF_ELSEWHERE_ID, PRIZE]);
    expect(ren.kitGranted).toEqual([KNOT_OF_ELSEWHERE_ID]);
  });
});
