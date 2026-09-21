/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import { ringIdFor } from '../../src/client/render/canvas.ts';
import { isHostileBody, isTownsfolkBody, seenHostiles } from '../../src/client/input/travel.ts';
import { ActorRank, TileCode } from '../../src/shared/protocol.ts';
import type { ActorView, LevelView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RING UNDER A BODY — "whose side", and the one the wire was widened for.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ActorView.faction` opens its own docblock with *"WHICH SIDE — and without it
 * a shopkeeper is drawn as something to kill"*, and names three consequences of
 * reading `kind` alone: a hostile ring under her, `Attack` on right-click, and a
 * travel path ending in a swing.
 *
 * TWO OF THE THREE WERE FIXED. `ui/verbs.ts` reads the field for the menu, and
 * the server refuses the swing — `areEnemies` is false the moment either side is
 * Townsfolk, and `greetOnBump` intercepts the step before it is even submitted.
 * THE RING, the one the docblock names FIRST, kept switching on `kind` alone.
 *
 * This file exists because a source grep cannot tell that apart: `faction`
 * appears in this file's prose several times over, and any assertion looking for
 * the word would have gone green against the shipped bug.
 */

const BODY: ActorView = {
  id: 'm1',
  name: 'Index Husk',
  sprite: 'enemy_index_husk_s',
  x: 3,
  y: 3,
  kind: 'monster',
  rank: ActorRank.Normal,
  hp: 10,
  maxHp: 10,
  alive: true,
};

describe('the ring says whose side', () => {
  it('puts the NEUTRAL ring under a townsfolk, not the hostile one', () => {
    // The bug the wire field was added to fix, asserted on the value that
    // shipped wrong rather than on the presence of a word.
    expect(ringIdFor({ ...BODY, faction: 'townsfolk' }, 'p1')).toBe('ui_token_ring_neutral');
  });

  it('still rings an ordinary monster as hostile', () => {
    // The other half: a fix that neutralised EVERY monster would pass the test
    // above and delete the game.
    expect(ringIdFor(BODY, 'p1')).toBe('ui_token_ring_hostile');
  });

  it('keeps the elite ring for anything above Normal, townsfolk or not', () => {
    /**
     * `rank` is on the wire for exactly this: the client cannot infer "elite"
     * from hp, and `art-pipeline.md` records that `index_husk_elite` currently
     * ships SMALLER than `index_husk`, so the art reads the wrong way round and
     * the ring carries the whole signal.
     */
    expect(ringIdFor({ ...BODY, rank: ActorRank.Elite }, 'p1')).toBe('ui_token_ring_elite');
    expect(ringIdFor({ ...BODY, rank: ActorRank.Boss }, 'p1')).toBe('ui_token_ring_elite');
  });

  it('gives a corpse the neutral ring whatever it was in life', () => {
    // Checked FIRST upstream of every other branch, because a body stays on the
    // board after death and a hostile ring around something that cannot act
    // makes "is that one dead?" a question asked out loud mid-fight.
    expect(ringIdFor({ ...BODY, alive: false, rank: ActorRank.Boss }, 'p1')).toBe(
      'ui_token_ring_neutral',
    );
  });

  it('knows your own body from your allies', () => {
    const ally: ActorView = { ...BODY, id: 'p2', kind: 'player' };
    expect(ringIdFor({ ...ally, id: 'p1' }, 'p1')).toBe('ui_token_ring_self');
    expect(ringIdFor(ally, 'p1')).toBe('ui_token_ring_ally');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE SECOND FRIENDLY FACTION, WHICH ARRIVED WITH NO CLIENT TEST AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Faction.Bound` is a body a PLAYER called up (`talents/call_shadows.ts`), and
 * it reaches the wire exactly as a townsfolk does: `kind: 'monster'`, same
 * painter, same FOV, only who may hit it differs. Three client surfaces branch
 * on that and every one of them was written by hand.
 *
 * MEASURED: dropping `|| actor.faction === 'bound'` from `ringIdFor`, and
 * dropping `&& actor.faction !== BOUND_FACTION` from `isHostileBody`, each left
 * ALL 2013 client tests green — `grep -rn "'bound'" test/` returned two lines,
 * both server-side. The consequence is the same three the townsfolk docblock
 * names, arriving again: a hostile ring under your own shadow, a left-click
 * that becomes a swing the server refuses, and travel treating it as a target.
 */
describe('a body you called up is on your side, on every surface', () => {
  const SHADOW: ActorView = { ...BODY, id: 'shadow:p1:0', name: 'Bound Shadow', faction: 'bound' };
  // A board, because `seenHostiles` answers an empty list without one — *"before
  // the first board there is nothing to trace through"*.
  const LEVEL: LevelView = { w: 8, h: 8, tiles: new Array<number>(64).fill(TileCode.FLOOR) };

  it('gets the neutral ring, not the hostile one', () => {
    expect(ringIdFor(SHADOW, 'p1')).toBe('ui_token_ring_neutral');
    // AND THE DISCRIMINATOR, which is the shape this file already uses: a fix
    // that neutralised every monster would pass the line above and delete the
    // game.
    expect(ringIdFor(BODY, 'p1')).toBe('ui_token_ring_hostile');
  });

  it('is not a hostile body, so a click on it is not a swing', () => {
    expect(isHostileBody(SHADOW)).toBe(false);
    expect(isHostileBody(BODY), 'every monster stopped being hostile').toBe(true);
    // AND IT IS NOT A PERSON EITHER. A townsfolk has a DOOR (`Talk to`); a
    // shadow has nothing to say, so the two questions stay separate.
    expect(isTownsfolkBody(SHADOW)).toBe(false);
    expect(isTownsfolkBody({ ...BODY, faction: 'townsfolk' })).toBe(true);
  });

  it('is left out of the list travel hunts through', () => {
    // `seenHostiles` is what the travel planner and the rest sentence walk; a
    // shadow standing in a doorway must not read as something to walk at.
    const bodies: ActorView[] = [SHADOW, BODY, { ...BODY, id: 'm2', faction: 'townsfolk' }];
    expect(seenHostiles(LEVEL, bodies).map((a) => a.id)).toEqual(['m1']);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE THIRD, WHICH IS THE ONE THE PARTY IS ASKED TO KEEP ALIVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Faction.Squad` is a temporary companion — somebody an objective on the floor
 * lent the party (`server/world/brief.ts`). It reaches the wire exactly as the
 * other two do, and the consequence of a client that does not know the string
 * is worse than it was for either of them: a hostile ring under the body the
 * objective FAILS IF YOU KILL, `Attack` on its right-click menu, and a travel
 * path that ends in a swing `areEnemies` refuses with nothing on screen to
 * explain why. That is the whole argument for `PROTOCOL_VERSION` 29 — see
 * `shared/version.ts` — and these are the branches it is about.
 *
 * MUTANT for each: drop `|| actor.faction === 'squad'` from `ringIdFor`, and
 * `&& actor.faction !== SQUAD_FACTION` from `isHostileBody`.
 */
describe('a body the floor lent you is on your side, on every surface', () => {
  const KEEL: ActorView = { ...BODY, id: 'npc:callow', name: 'Maud Callow', faction: 'squad' };
  const LEVEL: LevelView = { w: 8, h: 8, tiles: new Array<number>(64).fill(TileCode.FLOOR) };

  it('gets the neutral ring, not the hostile one', () => {
    expect(ringIdFor(KEEL, 'p1')).toBe('ui_token_ring_neutral');
    // AND NOT THE ELITE ONE EITHER, which is worth pinning rather than
    // assuming: the faction branch RETURNS before the rank is read, so a
    // companion built from an Elite sheet is drawn exactly as a Normal one.
    // The design asked for `rank = Elite` on the accept on the grounds that the
    // ring says "this one matters"; this is the line that says it does not.
    expect(ringIdFor({ ...KEEL, rank: ActorRank.Elite }, 'p1')).toBe('ui_token_ring_neutral');
    expect(ringIdFor(BODY, 'p1'), 'every monster stopped being hostile').toBe(
      'ui_token_ring_hostile',
    );
  });

  it('is not a hostile body, so a click on it is not a swing', () => {
    expect(isHostileBody(KEEL)).toBe(false);
    expect(isHostileBody(BODY), 'every monster stopped being hostile').toBe(true);
    // AND NOT A PERSON WITH A DOOR. A companion is not a conversation — they
    // are already walking with you — and the server refuses a `talk` at one,
    // because `dialogueStanding` wants `Faction.Townsfolk`.
    expect(isTownsfolkBody(KEEL)).toBe(false);
  });

  it('is left out of the list travel hunts through', () => {
    const bodies: ActorView[] = [KEEL, BODY];
    expect(seenHostiles(LEVEL, bodies).map((a) => a.id)).toEqual(['m1']);
  });
});
