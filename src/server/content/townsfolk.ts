// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PEOPLE WHO LIVE HERE. THE TOWNS WERE EMPTY ROOMS WITH SHELVES IN THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is a whole shop system — stock, restock, prices, buy and sell, a client
 * tab — and until now there was nobody behind it. `net/gateway.ts` says so
 * outright: *"There is no 'are you next to the shopkeeper' check because there
 * is no shopkeeper: the shop belongs to the realm, and being in the realm is
 * being in the shop."* Five settlements, thirteen sites, and not one person.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A `MonsterActor` WITH A FACTION AND NOT A THIRD `ActorKind`
 * ═══════════════════════════════════════════════════════════════════════════
 * `ActorKind` is switched exhaustively across the client renderer, the projector
 * and the scheduler, and `protocol.ts` notes that adding a member deliberately
 * breaks every one of them at lint time. That is the right property when a new
 * kind needs each site to decide something — and a townsfolk does not. She is a
 * body on a tile with hit points and a sprite, drawn by the same painter, seen
 * by the same FOV, hovered by the same tooltip, blocked into by the same
 * occupancy check. The ONLY thing that differs is who may hit her, and
 * `Faction` already answers that in one predicate (`engine/actor.ts#areEnemies`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY LINE IS AT MOST `LINE_MAX` CHARACTERS, AND THAT IS NOT A STYLE RULE
 * ═══════════════════════════════════════════════════════════════════════════
 * These lines go into the Case Log's MARGIN lane, which is the band
 * `ui/caselog.ts` created so that machine output could never bury human speech.
 * It is about 32 glyphs wide (`DOCK_W` 208, minus the panel inset, at
 * `italic 10px ui-monospace`) with a three-row floor, and it renders as
 * `${speaker}: ${text}` — so "Merrow Stitch: " is already fifteen of the first
 * row's glyphs before she says a word.
 *
 * A 140-character answer is five or six wrapped rows: the whole reserved band,
 * one click, and the party's own conversation pushed off the screen with the
 * attribution scrolled away, leaving the room reading an unowned fragment. So
 * the cap is enforced by `assertLinesFit` at module load and by a test over the
 * whole table — not left to whoever writes the next character.
 *
 * TWO ROWS, NOT ONE, is the budget: 56 characters plus a 15-character name is
 * two rows of a three-row band, which leaves a row for somebody else to talk.
 */

import { AiProfile, Faction } from '../engine/actor.ts';
import { canWalk } from '../../shared/level.ts';
import { TileCode } from '../../shared/protocol.ts';
import type { AuthoredMap } from '../../shared/level.ts';
import type { World } from '../world/world.ts';

/**
 * The Margin lane's budget. See the header — this is a wire-and-layout fact, not
 * a preference, and `assertLinesFit` enforces it at load rather than trusting it.
 */
export const LINE_MAX = 56;

/**
 * How far from the arrival tile a townsfolk must stand.
 *
 * Far enough that she is not the first thing a party walks into on arrival —
 * being body-checked by six people the instant they cross is a poor first
 * impression for the one friendly face in the game — and near enough that she is
 * inside the room rather than off in a corner nobody visits.
 */
const MIN_FROM_ARRIVAL = 4;

export type TownsfolkSpec = {
  /** Stable, and it becomes part of the actor id. Never reused across sites. */
  readonly id: string;
  readonly name: string;
  /**
   * An asset KEY, never a path.
   *
   * ═══ A STAND-IN, AND IT IS RECORDED AS ONE ═══
   * `chr_npc_bent_watchman_s` is the only authored, unused sprite under the
   * `chr_npc_` prefix the client already loads. Its ID names a hostile from
   * game-design.md's sample log, which this is not — but the alternative was a
   * new id, and an id with no PNG behind it resolves to the loud violet
   * missing-asset box on every clone, for a feature that otherwise works.
   *
   * `chr_player_cipher_clerk_s` would read better and is NOT free: `world.ts`
   * has it in `PLAYER_SPRITES`, so a party member can be wearing it, and a
   * shopkeeper who looks like a player is worse than one in the wrong coat.
   *
   * THE ART ASK, stated so it is findable: one 24x32 `chr_npc_counter_keeper_s`.
   * Swapping this field is the whole of the change when it exists.
   */
  readonly sprite: string;
  /** Said the first time somebody walks into her, per realm. */
  readonly greetFirst: string;
  /** Said on every bump after that. */
  readonly greetAgain: string;
  /**
   * What she says when somebody keeps shoving. Three, cycled.
   *
   * THIS IS THE ANSWER TO A REAL QUESTION. Six friends in a voice channel will
   * absolutely try to murder the shopkeeper for a laugh, and `areEnemies` means
   * they cannot: the swing never resolves. Something has to happen instead, or
   * the tile just refuses and reads as a bug. She talks back — which is funnier
   * than a refusal, costs nothing, and is the only thing a group actually wants
   * from that interaction.
   */
  readonly deflect: readonly [string, string, string];
};

/**
 * Who stands where, keyed by SITE id.
 *
 * ═══ ONE PERSON, IN ONE TOWN, DELIBERATELY ═══
 * Threadneedle Row only. A first commit that populated five settlements would
 * be five times the content to get wrong before anybody had stood next to one,
 * and the shape of this table is what has to be right first. The four remaining
 * towns are a content edit with no code behind it.
 */
export const TOWNSFOLK: ReadonlyMap<string, readonly TownsfolkSpec[]> = new Map<
  string,
  readonly TownsfolkSpec[]
>([
  [
    'site:threadneedle_row',
    [
      {
        id: 'merrow',
        name: 'Merrow Stitch',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Merrow Stitch. I mend what the Index unpicks.',
        greetAgain: 'Still here. So is the counter.',
        deflect: [
          'Mind the counter.',
          'You will not move me, and I have tried.',
          'Push a third time and I stop being pleasant.',
        ],
      },
    ],
  ],
]);

/**
 * Refuse a line that cannot be read.
 *
 * AT MODULE LOAD, not in a test only. A test catches it before a deploy; this
 * catches it before a boot, and the failure mode it guards against — one long
 * line silently eating the band the party talks in — is invisible in a
 * screenshot of anything but that exact moment.
 */
function assertLinesFit(): void {
  for (const specs of TOWNSFOLK.values()) {
    for (const spec of specs) {
      const lines = [spec.greetFirst, spec.greetAgain, ...spec.deflect];
      for (const line of lines) {
        if (line.length <= LINE_MAX) continue;
        throw new Error(
          `townsfolk: ${spec.id} has a ${String(line.length)}-character line and the ` +
            `Margin lane holds ${String(LINE_MAX)}: ${line}`,
        );
      }
    }
  }
}
assertLinesFit();

/** Every spec authored for a site, or an empty list. */
export function townsfolkFor(siteId: string | undefined): readonly TownsfolkSpec[] {
  if (siteId === undefined) return [];
  return TOWNSFOLK.get(siteId) ?? [];
}

/**
 * The spec behind a placed actor id, or undefined.
 *
 * The id is `<realmId>:town:<specId>`, so this reads the tail rather than
 * keeping a second table keyed by actor id — one table, and an id that cannot
 * disagree with the spec it was minted from.
 */
export function specForActorId(actorId: string): TownsfolkSpec | undefined {
  const at = actorId.lastIndexOf(TOWNSFOLK_ID_MARK);
  if (at < 0) return undefined;
  const specId = actorId.slice(at + TOWNSFOLK_ID_MARK.length);
  for (const specs of TOWNSFOLK.values()) {
    for (const spec of specs) if (spec.id === specId) return spec;
  }
  return undefined;
}

/** Is this actor id one of ours? Used by the bump intercept and the verb menu. */
export function isTownsfolkId(actorId: string): boolean {
  return actorId.includes(TOWNSFOLK_ID_MARK);
}

/**
 * The mark that makes a townsfolk id recognisable without a table lookup.
 *
 * The gateway needs to answer "is the body on that tile a townsfolk" on the
 * movement path, which runs on every keypress. Reading the actor's `faction` is
 * the real answer and is what the rules use; this is for the two places that
 * have an id and no body yet.
 */
const TOWNSFOLK_ID_MARK = ':town:';

/**
 * Stand everybody up. Returns how many were placed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT SEARCHES, IT DOES NOT COMPUTE — `delve.ts#roomFor`'s hard-won lesson
 * ═══════════════════════════════════════════════════════════════════════════
 * A hand-authored coordinate per town is a coordinate that is inside a wall the
 * first time anybody edits the map, and nothing would throw: `addMonster`
 * settles for the nearest free tile, so she would simply drift somewhere odd and
 * stay there. So the tile is FOUND, against the map as built.
 *
 * BEHIND A COUNTER means orthogonally adjacent to a wall. It is the cheapest
 * available reading of "has her back to something", it needs no new authoring in
 * the map rows, and it puts her against a building face rather than standing in
 * the middle of a street like a bollard.
 *
 * ═══ NO RNG DRAW. NOT ONE. ═══
 * A town's map is derived from the SITE seed precisely so its streets are the
 * same every visit (`world/realms.ts`), and a draw here would do two bad things
 * at once: move her between boots, so "she stands by the north wall" stops being
 * a thing a player can learn — and shift the seeded stream for everything that
 * draws after her, which is every fight in that realm. Row-major scan, first
 * match wins, identical on every machine.
 */
export function placeTownsfolk(
  world: World,
  map: AuthoredMap,
  specs: readonly TownsfolkSpec[],
): number {
  if (specs.length === 0) return 0;

  const arrival = map.spawns[0];
  const level = map.view;
  const taken = new Set<string>();
  let placed = 0;

  for (const spec of specs) {
    const at = findCounter(level, arrival, taken);
    if (at === undefined) continue;
    taken.add(`${String(at.x)},${String(at.y)}`);

    world.addMonster(`${world.id}${TOWNSFOLK_ID_MARK}${spec.id}`, {
      name: spec.name,
      sprite: spec.sprite,
      x: at.x,
      y: at.y,
      // STATIONARY IS NOT A PROFILE YET, so she takes the melee profile and is
      // rendered harmless by the faction instead. `areEnemies` is what the AI's
      // target search reads, and it answers false for her in both directions —
      // so she has nobody to chase and nobody chases her. A dedicated profile
      // would be a second place for that rule to live.
      profile: AiProfile.MeleeChaser,
      // ENOUGH THAT NOTHING KILLS HER BY ACCIDENT. She cannot be attacked, so
      // this is a floor under bugs rather than a stat: a status that ticks or an
      // area effect that forgets to ask about factions gets a very long time to
      // be noticed before anybody dies of it.
      maxHp: 500,
      hpRegen: 0,
      faction: Faction.Townsfolk,
      // She does not fight, so a combat sheet would be a sheet nothing reads.
      // `createMonsterActor` fills its own defaults.
      aggroRange: 0,
      attackRange: 0,
    });
    placed += 1;
  }

  return placed;
}

/**
 * The first walkable tile with its back to a wall, far enough from the door.
 *
 * Row-major and deterministic — see the note on `placeTownsfolk`.
 */
function findCounter(
  level: AuthoredMap['view'],
  arrival: { readonly x: number; readonly y: number } | undefined,
  taken: ReadonlySet<string>,
): { readonly x: number; readonly y: number } | undefined {
  const wallAt = (x: number, y: number): boolean => level.tiles[y * level.w + x] === TileCode.WALL;

  /**
   * ═══ NEAREST QUALIFYING TILE, NOT THE FIRST ONE FOUND ═══
   * "First match in row-major order" was the first version and it is always the
   * TOP-LEFT CORNER: the scan starts at 1,1 and a corner has two wall faces, so
   * it qualifies immediately. Driven over a real socket, Merrow stood at 1,1 —
   * technically against a wall, four tiles from the door, and unmistakably in a
   * corner by the entrance rather than behind a counter.
   *
   * So every candidate is scored by how far it is from the arrival tile and the
   * CLOSEST one wins. That puts her on the natural line somebody walks when they
   * come in — against a wall, in the room, visible on the first screen — instead
   * of in whichever corner the scan reached first.
   *
   * STILL NO DRAW, and still row-major for ties, so the answer is a pure
   * function of the map and identical on every machine. See `placeTownsfolk`.
   */
  let best: { readonly x: number; readonly y: number } | undefined;
  let bestAway = Number.POSITIVE_INFINITY;

  for (let y = 1; y < level.h - 1; y += 1) {
    for (let x = 1; x < level.w - 1; x += 1) {
      if (!canWalk(level, x, y)) continue;
      if (taken.has(`${String(x)},${String(y)}`)) continue;
      const away =
        arrival === undefined ? 0 : Math.max(Math.abs(x - arrival.x), Math.abs(y - arrival.y));
      if (away < MIN_FROM_ARRIVAL) continue;
      // ORTHOGONAL ONLY. A diagonal wall corner is not a counter to stand
      // behind, and a body wedged into one reads as stuck rather than as placed.
      if (!(wallAt(x - 1, y) || wallAt(x + 1, y) || wallAt(x, y - 1) || wallAt(x, y + 1))) continue;
      // STRICTLY closer, so a tie keeps the row-major winner.
      if (away < bestAway) {
        bestAway = away;
        best = { x, y };
      }
    }
  }
  return best;
}
