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
import { TileCode, TopicId, isWalkable } from '../../shared/protocol.ts';
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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT SHE CAN BE ASKED ABOUT — and the second one is the point of all this.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Keyed by `TopicId`, so the wire carries a closed set rather than free text
   * and a client cannot invent a question.
   *
   * `Party` IS THE HIGHEST-VALUE LINE IN THE GAME. `DECISIONS.md` D12 and
   * `scheduler.ts` both state it: `awardExperience` pays every party member a
   * FULL share, with no division by headcount and no proximity radius. So three
   * people partied earn three times what three people standing in the same room
   * unpartied do — and `delve.ts` says why that matters: *"A player has no way
   * to discover that by playing, and every other co-op game they have touched
   * divides a kill — so the SAFE assumption is that partying costs them."*
   *
   * A player acting on the safe assumption plays the game wrong for their whole
   * first session. Teaching an invisible rule is the one thing dialogue is
   * uniquely good at, and it costs one sentence.
   */
  readonly topics: Readonly<Partial<Record<TopicId, string>>>;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT SHE TELLS SOMEBODY WHO HAS BEEN AROUND — AND WHY IT HAD TO EXIST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * THE SECOND LANDMASS WAS UNFINDABLE. Not hard to find — unfindable. Three
   * commits built the Redaction: a whole second overworld, six delves, two
   * creatures nothing else in the game has. Then a player audit of the client
   * turned up every one of the channels that could have led anybody there, and
   * every one was shut:
   *
   *   - The door is at (22,60), 99 tiles from the spawn and 14 from the nearest
   *     marker, which was a deliberate choice: *"somewhere you went looking"*.
   *   - Site markers on the world map are FOG-GATED (`mapview.ts`: `if (seen
   *     !== undefined && !seen.has(...)) continue`), so the marker does not
   *     appear until you have already walked onto the cell.
   *   - Region captions need a fifth of the region walked, so even "the Sedge"
   *     is not a signpost until you are standing in it.
   *   - `nearestSites` reports the three nearest and the door is ninety-ninth.
   *
   * So the only route to the largest content in the game was to walk the entire
   * western moor on spec. Nobody does that. THIS TABLE IS THE FIX, and it is
   * here rather than on the map because a rumour is what this game already uses
   * to point at things it has hidden — the three `hidden` sites are hinted the
   * same way, in the same topic, and that mechanism was already working.
   *
   * ═══ EARNED, NOT GIVEN, AND THAT IS THE WHOLE REASON IT IS A SECOND TABLE ═══
   * Telling a level-1 character to walk west would be a trap: `redactedSpec`'s
   * own note says the floors over there are not softened for somebody who
   * wandered in, and the reason that is fair is that the walk is long. Handing
   * out directions removes the gate, so the DIRECTIONS are gated instead. Below
   * `STANDING_LEVEL` she says what she always said.
   *
   * It also gives the topic a reason to be asked twice, which is the first time
   * anything in this game rewards going back to talk to somebody.
   *
   * KEYED BY TOPIC RATHER THAN BEING ONE `rumourLater` STRING because it is the
   * same size either way and the next thing that deepens will not be a rumour.
   * Only `Rumour` is populated today; a topic absent here simply falls through
   * to `topics`, so a person with nothing more to say needs no entry at all.
   */
  readonly later?: Readonly<Partial<Record<TopicId, string>>>;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN SOMEBODY STOPS BEING A STRANGER. HALF WAY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MAX_CHARACTER_LEVEL` is 10, so this is the midpoint, and it is chosen
 * against what is actually on the other side rather than for tidiness. The
 * Redaction's roamers are half elite — `INDEX_INSPECTOR` hunts whoever is alone
 * and `INDEX_INQUISITOR` out-walks the party — and its delves carry
 * `redactedSpec`'s +2. Measured: a lone level-1 opening the redacted Underworks
 * meets eight hostiles.
 *
 * A character at 5 has talents bought, gear on, and has cleared some of the
 * near country. They can make the walk and decide for themselves at the far end
 * of it. A character at 1 would be told to go and die, by the one system in
 * this game whose entire job is to be trustworthy.
 */
export const STANDING_LEVEL = 5;

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
        topics: {
          // 56 characters is the Margin lane's whole budget — see `LINE_MAX`.
          // WAS "Blackwood first", WHICH IS NOW THE WORST ROOM IN THE GAME.
          // The difficulty gradient used to run backwards down the map and this
          // line was written against it; re-keying the delves by distance turned
          // three helpful sentences into three ways to get a beginner killed.
          // The chapel is seventeen steps out and the gentlest room there is.
          [TopicId.Where]: 'The chapel first. It is close and it is quiet.',
          [TopicId.Party]: 'Party up. You each get a full share, not a split.',
          [TopicId.Roads]: 'Nothing waits on made ground. Keep to the road.',
          [TopicId.Rumour]: 'There is more out there than the map admits to.',
        },
        later: {
          // MERROW MENDS THINGS. She is the one who would notice a hole.
          [TopicId.Rumour]: 'West past the Sedge. The road stops and stays stopped.',
        },
      },
    ],
  ],
  /**
   * ═══ THREE TOWNS, BECAUSE ONE WAS WORSE THAN NONE ═══
   * A single populated settlement makes the other four read as deserted rather
   * than as quiet — the player learns "towns have people in them" and then finds
   * four that do not. These two are content only: the code that places them, the
   * verb that talks to them and the lines' length cap are all already in place.
   */
  [
    'site:alderbrook',
    [
      {
        id: 'reeve',
        name: 'Reeve Ashcombe',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Ashcombe. I keep the gate and the gate keeps me.',
        greetAgain: 'Gate is still here. So am I.',
        deflect: [
          'The gate, not me.',
          'I have stood here through worse than you.',
          'Try that once more and we will both be sorry.',
        ],
        topics: {
          // WAS "Blackwood if you must" — see Merrow's line. Blackwood is now
          // a hundred and thirty-one steps out and the far end of everything.
          [TopicId.Where]: 'Threadneedle for goods. The chapel to blood a coat.',
          [TopicId.Party]: 'Travel together. Nobody earns less for sharing.',
          [TopicId.Roads]: 'The made ground is safe. That is the whole of it.',
          [TopicId.Rumour]: 'Folk come off the Grey Downs having seen a thing.',
        },
        later: {
          // THE REEVE KEEPS RECORDS. Hers is the administrative version.
          [TopicId.Rumour]: 'West of the Sedge is country I still file returns on.',
        },
      },
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE SECOND PERSON IN ANY TOWN, AND ALDERBROOK GETS HER FIRST.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * MEASURED: every town is 34x30 with seven to eight hundred walkable
       * tiles and exactly ONE person standing in it. Three of the five have no
       * shop either — so Alderbrook, which is one step from the spawn and the
       * room every player stands in first and most, was seven hundred and
       * twenty-seven tiles containing a single sentence.
       *
       * A town with one person is a room with a sprite in it.
       *
       * ═══ HERE FIRST, AND NOT EVERYWHERE AT ONCE ═══
       * This table's own header argues it: *"A first commit that populated five
       * settlements would be five times the content to get wrong before anybody
       * had stood next to one."* The same reasoning applies to doubling them.
       * Alderbrook is the highest-traffic room in the game by a distance, so it
       * is where a second voice is worth the most and where it will be read
       * enough to find out whether it works.
       *
       * ═══ AND SHE ANSWERS THE SAME FOUR TOPICS, DELIBERATELY ═══
       * A second person with different topics would be a second SYSTEM. The
       * topic set is closed on purpose (`TopicId`, so a client cannot invent a
       * question), and the value of two people is that the same four questions
       * get two answers from two positions. The Reeve keeps the gate and speaks
       * administratively; Bell has been out there and speaks from having come
       * back — which is also why hers is the line that tells a newcomer the
       * chapel is survivable rather than merely near.
       *
       * SAME SPRITE AS EVERYONE ELSE. All five townsfolk share
       * `chr_npc_bent_watchman_s` and the art ask for more is stated above and
       * still open; a sixth person does not make that worse and waiting for art
       * would mean shipping nothing.
       */
      {
        id: 'bell',
        name: 'Halloway Bell',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Bell. I came back, which is the whole of my trade.',
        greetAgain: 'Still back. Still here.',
        deflect: [
          'Mind yourself.',
          'I have been shoved by worse and colder.',
          'Push again and I will stop being polite about it.',
        ],
        topics: {
          // THE ONE A NEWCOMER NEEDS. The Reeve names the chapel too, but as an
          // errand; this says the thing a first-timer is actually asking, which
          // is whether they will survive it.
          [TopicId.Where]: 'The chapel. Small, and it lets you leave.',
          // D12 FROM THE OTHER SIDE. The Reeve states the rule; Bell states what
          // happens when you ignore it, which is the half people act on.
          [TopicId.Party]: 'I went alone once. That is why I mend coats now.',
          [TopicId.Roads]: 'Made ground holds. Step off it and find out.',
          [TopicId.Rumour]: 'A stair on the Grey Downs, on no map I own.',
        },
        later: {
          // SHE HAS BEEN THERE. The only first-hand account in Alderbrook.
          [TopicId.Rumour]: 'West past the Sedge. I got a mile in and turned.',
        },
      },
    ],
  ],
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE LAST TWO, BECAUSE THREE OF FIVE IS STILL FOUR-FIFTHS OF A PROBLEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The note at the top of this table already made the argument for going from
   * one town to three: *"A single populated settlement makes the other four read
   * as deserted rather than as quiet — the player learns 'towns have people in
   * them' and then finds four that do not."* The same sentence applies at three
   * of five, and it applies hardest to these two: Saint's Rest is one of the
   * four doors on the far side of the range, so it is the first settlement a
   * player reaches after the longest walk in the game, and the Wayfarers' Camp
   * is the only thing in the western downs at all.
   *
   * Arriving at either after that walk and finding nobody home is the moment a
   * world stops feeling inhabited.
   */
  [
    'site:saints_rest',
    [
      {
        id: 'sexton',
        name: 'Sexton Pell',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Pell. I dig, and lately I do not dig much.',
        greetAgain: 'Nothing new in the ground today.',
        deflect: [
          'Not over the plots.',
          'I have buried better-mannered than you.',
          'One more and I find you a spot of your own.',
        ],
        topics: {
          [TopicId.Where]: 'Down to the chapel. Everyone starts there.',
          [TopicId.Party]: 'Bring somebody. The stones here are all singles.',
          [TopicId.Roads]: 'The road is kept. What is off it is not.',
          [TopicId.Rumour]: 'Older markers than mine, out in the Blackwater Wood.',
        },
        later: {
          // THE SEXTON BURIES PEOPLE. His version is about who is not buried.
          [TopicId.Rumour]: 'West past the Sedge there are no stones at all.',
        },
      },
    ],
  ],
  [
    'site:wayfarers_camp',
    [
      {
        id: 'carrow',
        name: 'Carrow Ninefold',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Ninefold. I walk it all and I write none of it.',
        greetAgain: 'Still walking. Still not writing.',
        deflect: [
          'Mind the fire.',
          'I have walked off worse than a shove.',
          'Do that again and you can find the road yourself.',
        ],
        topics: {
          [TopicId.Where]: 'East and south. The near markers are the kind ones.',
          [TopicId.Party]: 'Two walk further than one. That is just arithmetic.',
          [TopicId.Roads]: 'I sleep on the road. That is not laziness.',
          // THE STRONGEST HINT IN THE GAME, and it is on the person furthest
          // from anywhere, in the region that holds one of the three.
          [TopicId.Rumour]: 'A stair on the Grey Downs, on no map I own.',
        },
        later: {
          // CARROW WALKS EVERYWHERE. Hers is the only first-hand account.
          [TopicId.Rumour]: 'I walked west past the Sedge once. I turned round.',
        },
      },
    ],
  ],
  [
    'site:ashwick_row',
    [
      {
        id: 'thessaly',
        name: 'Thessaly Vaunt',
        sprite: 'chr_npc_bent_watchman_s',
        greetFirst: 'Vaunt. I mix what the Index has not read yet.',
        greetAgain: 'Still mixing. Mind the fumes.',
        deflect: [
          'Not the shelves.',
          'Break one of those and we will both regret it.',
          'I have a bottle here I would rather not open.',
        ],
        topics: {
          // WAS "Gearford", which the re-key made one of the two worst rooms.
          [TopicId.Where]: 'The Underworks. Close, and it goes down gently.',
          [TopicId.Party]: 'Go in threes. The Index counts you one at a time.',
          [TopicId.Roads]: 'Off the road is where the wandering things are.',
          [TopicId.Rumour]: 'Water moves in the Blackwater Wood. Nothing feeds it.',
        },
        later: {
          // THESSALY IS AN ALCHEMIST. Hers is the one that names the mechanism.
          [TopicId.Rumour]: 'West of the Sedge the Index took the ground itself.',
        },
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
      const lines = [
        spec.greetFirst,
        spec.greetAgain,
        ...spec.deflect,
        // TOPICS TOO. They land in the same lane and a long one eats the same
        // band; a cap that covered only greetings would be a cap with a hole in
        // it exactly where the longest sentences live.
        ...Object.values(spec.topics),
        /**
         * ═════════════════════════════════════════════════════════════════════
         * AND `later`, WHICH WAS THE HOLE, EXACTLY WHERE THE COMMENT SAID.
         * ═════════════════════════════════════════════════════════════════════
         *
         * `later` was added for the Redaction's directions and this list was
         * not. Measured: all five of those lines ran 106 to 132 characters
         * against a lane that holds 56 — between fifty and seventy-six over,
         * every one of them shipped and live.
         *
         * The line above says a cap covering only greetings would have a hole
         * *"exactly where the longest sentences live"*, and that is what
         * happened: the deepest, most-written lines in the game were the ones
         * nothing checked.
         */
        ...Object.values(spec.later ?? {}),
      ];
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
  /**
   * SOLID, not "is code 1". A shopkeeper's whole placement rule is *"stand with
   * your back to something"*, and once a town's walls are TERRACE or CIVIC
   * rather than `TileCode.WALL` a comparison to the one code says every tile in
   * the room is open ground — so Merrow would be scored as standing in the
   * middle of the floor and would end up wherever the tie-break sent her.
   *
   * `isWalkable` and not `blocksSight`: what she wants at her back is something
   * a body cannot walk through, which is the same thing the counter is.
   */
  const wallAt = (x: number, y: number): boolean =>
    !isWalkable(level.tiles[y * level.w + x] ?? TileCode.WALL);

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
