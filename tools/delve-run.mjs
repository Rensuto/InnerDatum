/**
 * CAN ANYBODY ACTUALLY CLEAR THESE? Ask the game.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT SITS BESIDE first-fight.mjs RATHER THAN INSIDE IT
 * ═══════════════════════════════════════════════════════════════════════════
 * `first-fight.mjs` asks one question — how hard is the opening ambush — and
 * answers it in one table. This asks a different one: eight rooms, each with a
 * population band chosen by hand, and the question is whether the GRADIENT
 * between them is real and whether the far end is survivable at all.
 *
 * Same discipline as its sibling, and the same two traps it exists to avoid:
 *
 *   THE COMBAT SHEET IS `ClassDef.combat`. `sheetForClass` returns the TALENT
 *   sheet. Both are called "sheet", and getting it wrong produces a body with
 *   no weapon, no armour and no defence whose numbers look plausible.
 *
 *   END-STATE HEALTH IS NOT WHAT THE FIGHT COST. Health regenerates, so a run
 *   that ends on 90% may have spent most of itself at 15%. The LOW-WATER MARK
 *   is the number that describes the room.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT MEASURES A PARTY AS WELL AS A LONE BODY, AND THAT IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 * This is a co-op game whose whole reason to exist is people in a voice
 * channel. "Solo can clear the Outer Index" and "three people can" are
 * different games, and the second one is the one being built — so a delve that
 * is impossible alone is not necessarily wrong, it is possibly the point. The
 * table prints both so the difference is visible rather than argued about.
 *
 * Usage:  node tools/delve-run.mjs [runs]
 */

import { SITES, RealmKind, createRealms } from '../src/server/world/realms.ts';
import { createTurnEngine } from '../src/server/turn-engine.ts';
import { createDownedState, isDowned } from '../src/server/engine/downed.ts';
import { createMvpEffectState } from '../src/server/content/effects.ts';
import {
  CLASSES,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../src/server/content/classes.ts';
import { talentRuntimeFor } from '../src/server/main.ts';
import { ActorKind } from '../src/shared/protocol.ts';
import { canWalk } from '../src/shared/level.ts';
import { areEnemies } from '../src/server/engine/actor.ts';
import { firstStep } from './walk.mjs';
import { rangedAttacks, takeShot } from './fightlib.mjs';

const RUNS = Number(process.argv[2] ?? 8);
/** Long enough to cross a 34x30 room several times and kill ten things. */
const TURN_CAP = 900;

/** The three classes, so a party is a real party rather than one body tripled. */
const PARTY = CLASSES.slice(0, 3);

function run(site, size, seed) {
  const downed = createDownedState();
  // THE STATUS TABLE. Without it the Overwritten Husk's bleed never lands and
  // this tool measures a fight the game does not have.
  const effects = createMvpEffectState();
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE TALENTS, WHICH THIS TOOL HAS NEVER HAD.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `createTurnEngine({ world, downed, effects })` with no `talents` option
   * defaults the book to `EMPTY_TALENT_BOOK`, whose entire body is
   * `loadoutOf: () => []`. So EVERY DELVE NUMBER THIS TOOL HAS EVER PRINTED was
   * measured in a game where nobody could use a talent — a party of three
   * walking up and punching seventeen floors.
   *
   * `first-fight.mjs` had the identical fault and src/server/main.ts carries it
   * as a warning because the real server had it first: *"Three files of finished
   * content, wired to nothing."* Fixed there, fixed in the sibling probe, and
   * still here — which is the third instance and the reason `fightlib.mjs` now
   * exists.
   */
  const talentEngine = createContentTalentEngine();
  const realms = createRealms({
    seed,
    engineFor: (world) =>
      createTurnEngine({
        world,
        downed,
        effects,
        talents: createTalentBook(talentEngine, world),
        talentRuntime: talentRuntimeFor(talentEngine, world),
      }),
  });
  const realm = realms.open(site, seed);

  const bodies = [];
  for (let i = 0; i < size; i += 1) {
    const cls = PARTY[i % PARTY.length];
    const p = realm.world.addPlayer(`p${i}`, `P${i}`);
    // THE COMBAT SHEET. See the header.
    p.combat = cls.combat;
    p.baseCombat = cls.combat;
    p.maxHp = cls.maxHp;
    p.hp = cls.maxHp;
    p.hpRegen = cls.hpRegen;
    realm.engine.join(p.id);
    realm.engine.setConnected(p.id, true);
    // THE SHEET IS WHAT MAKES THE BOOK ANSWER: without one `loadoutOf` is empty
    // and every talent is refused as "no such talent in this loadout".
    talentEngine.attach(p.id, sheetForClass(cls));
    bodies.push({ body: p, attacks: rangedAttacks(cls) });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A TOWNSFOLK IS NOT A FOE, AND THIS TOOL HAS BEEN HUNTING THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `kind === Monster` is the wrong question. Townsfolk are monster-KIND actors
   * carrying `Faction.Townsfolk`, and `areEnemies` exists to say so — realms.ts
   * leans on it for "a town stays a town". Measured: this tool counted SIX foes
   * in Alderbrook and seven in Ashwick Alchemy Row and then spent 900 turns
   * failing to murder the shopkeepers, which is the whole reason every
   * settlement row read as a stall.
   *
   * ONE definition, used by the roster count, the fight loop and the survivor
   * report. It was three hand-written copies of `kind === Monster`, which is the
   * shape that lets one of them stay wrong.
   */
  const hostiles = () =>
    realm.world.allActors().filter((a) => bodies.some(({ body }) => areEnemies(body, a)));
  const livingHostiles = () => hostiles().filter((a) => a.alive);

  let turns = 0;
  let worst = 1;
  const tally = { shot: 0, moved: 0, held: 0 };
  if (process.env.DELVE_DIAG === 'roster') {
    const n = hostiles().length;
    console.log(`  [roster] ${site.name ?? site.id} size=${String(size)} monsters=${String(n)}`);
  }
  const refusals = new Map();
  for (; turns < TURN_CAP; turns += 1) {
    const foes = livingHostiles();
    const up = bodies.filter((m) => m.body.alive && !isDowned(downed, m.body.id));
    if (foes.length === 0 || up.length === 0) break;

    for (const { body: b, attacks } of up) {
      const living = foes.filter((f) => f.alive);
      const near = living
        .map((f) => ({ f, d: Math.max(Math.abs(f.x - b.x), Math.abs(f.y - b.y)) }))
        .sort((x, y) => x.d - y.d)[0];
      if (near === undefined) break;

      /**
       * SHOOT IF YOU CAN SHOOT. Two of the three classes in this party are
       * ranged and one of them has a dead zone, so a party that only ever walks
       * at the nearest monster is not the party this game ships. See
       * `fightlib.mjs`.
       */
      const { fired, gap } = takeShot(realm.engine, b.id, attacks, b, living, (id, shot) => {
        if (process.env.DELVE_DIAG === '3') {
          refusals.set(String(shot?.code), (refusals.get(String(shot?.code)) ?? 0) + 1);
        }
      });
      if (fired) {
        tally.shot += 1;
        continue;
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * OUT OF FOCUS IS NOT A REASON TO WALK INTO A DOORWAY.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `gap !== null` means a foe WAS inside a firing band and the engine
       * refused the shot anyway. Measured over a stalled floor, the refusals are
       * overwhelmingly `no_resource` (up to 2,680) and `on_cooldown` (~897): the
       * ranged pair empty their Focus and Reagents in the opening turns and then
       * every shot for the rest of the run is refused.
       *
       * The old code closed the distance at that point, which walks The
       * Inspector into melee — where `combat.minRange` 3 forbids her from
       * striking at all. So the party became one Watchman and two spectators,
       * and eight reachable monsters never died.
       *
       * A player waits. Holding keeps the distance that makes the class work and
       * lets the resource come back, which is the whole shape of "lethal at
       * range and helpless in a doorway".
       */
      if (gap !== null && attacks.length > 0) {
        tally.held += 1;
        realm.engine.hold(b.id);
        continue;
      }

      // Nothing was in a band this turn: back out of a dead zone, or close.
      const shortest = attacks[attacks.length - 1] ?? null;
      const away = shortest !== null && gap === null && near.d < shortest.minRange;
      const goal = away
        ? { x: b.x + Math.sign(b.x - near.f.x), y: b.y + Math.sign(b.y - near.f.y) }
        : { x: near.f.x, y: near.f.y };
      // PATHFOUND, NOT STRAIGHT-LINE — see tools/walk.mjs.
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * PATH AROUND THE PARTY, NOT THROUGH IT.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The predicate was terrain only, which is correct for ONE body and wrong
       * for three: a party in a corridor paths each member through the others,
       * every step is refused at resolution, and nobody moves. Measured — a
       * leader at full health, its target at full health, and TWO TILES of
       * progress in a hundred and fifty turns:
       *
       *     [t300] leader 72/72 at 3,16   nearest Overwritten Husk 95hp gap 8
       *     [t450] leader 72/72 at 5,18   nearest Overwritten Husk 95hp gap 6
       *
       * which is why a solo run cleared 8/8 and a party of three stalled 0/8 on
       * the same floor. `world.actorAt` skips anything not alive — "corpses do
       * not block" — so this routes round the living and still walks over the
       * dead, and `firstStep` exempts the TARGET tile so a bump is still a bump.
       */
      const terrain = (x, y) => canWalk(realm.world.level, x, y);
      const clear = (x, y) => terrain(x, y) && realm.world.actorAt(x, y) === undefined;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * AND IF THERE IS NO PATH, STAND STILL — DO NOT WALK EAST.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The fallback was `?? 'e'`: no route, so step east. That is not a
       * fallback, it is a body wandering off, and it is what a stalled party
       * actually looked like — a leader at FULL health with the gap to its
       * target GROWING while it strolled:
       *
       *     [t300] leader 72/72 at 6,19   Overwritten Husk 95hp at gap 5
       *     [t450] leader 72/72 at 2,15   Overwritten Husk 95hp at gap 9
       *
       * Routing round the party made it worse rather than better, because every
       * ally in a corridor is one more reason for the route to come back null.
       *
       * So: round the party if that works, THROUGH it if it does not (the step
       * is refused at resolution and costs a turn, which is honest — that is
       * what a real player pressing into a friend gets), and hold only when
       * there is no route on terrain at all.
       */
      const dir =
        firstStep(clear, { x: b.x, y: b.y }, goal) ?? firstStep(terrain, { x: b.x, y: b.y }, goal);
      if (dir === null) {
        tally.held += 1;
        realm.engine.hold(b.id);
        continue;
      }
      tally.moved += 1;
      const moved = realm.engine.submitMove(b.id, dir);
      if (process.env.DELVE_DIAG === '1' && moved?.ok === false && turns > 20 && turns < 24) {
        console.log(
          `  [diag] ${b.id} move ${dir} refused at gap ${String(near.d)}: ${JSON.stringify(moved)}`,
        );
      }
    }
    realm.engine.pump();
    if (process.env.DELVE_DIAG === '2' && turns % 150 === 0) {
      const me = bodies[0].body;
      const nearest = realm.world
        .allActors()
        .filter((a) => a.kind === ActorKind.Monster && a.alive)
        .map((f) => ({ f, d: Math.max(Math.abs(f.x - me.x), Math.abs(f.y - me.y)) }))
        .sort((x, y) => x.d - y.d)[0];
      console.log(
        `  [t${String(turns)}] leader ${String(Math.round(me.hp))}/${String(me.maxHp)} at ${String(me.x)},${String(me.y)}` +
          (nearest === undefined
            ? '  no foes'
            : `  nearest ${String(nearest.f.name ?? nearest.f.id)} ${String(Math.round(nearest.f.hp))}hp at gap ${String(nearest.d)}`),
      );
    }
    for (const { body: b } of bodies) worst = Math.min(worst, b.hp / b.maxHp);
  }

  const survivors = livingHostiles();
  const foesLeft = survivors.length;
  /**
   * WHAT WAS STILL STANDING, AND HOW FAR AWAY. A stall with the party at 91%
   * health is not a difficulty reading — it is the driver failing to finish, and
   * the only way to tell which is to look at what it left alive.
   */
  if (['1', '3'].includes(process.env.DELVE_DIAG ?? '') && foesLeft > 0 && turns >= TURN_CAP) {
    const me = bodies[0]?.body;
    /**
     * REACHABLE, OR JUST FAR? A stall where every survivor is unroutable is a
     * fact about the MAP; a stall where they are all reachable is a fact about
     * this driver. Nothing else tells the two apart.
     */
    const reach = survivors.map((f) => {
      const step =
        me === undefined
          ? null
          : firstStep(
              (x, y) => canWalk(realm.world.level, x, y),
              { x: me.x, y: me.y },
              { x: f.x, y: f.y },
            );
      return step === null ? 'NO-ROUTE' : 'reachable';
    });
    console.log(
      `  [diag] refusals ${[...refusals].map(([k, n]) => `${k}x${String(n)}`).join(' ') || 'none'} | bodies ${String(bodies.length)} | routes: ${reach.join(' ')} | orders shot ${String(tally.shot)} moved ${String(tally.moved)} held ${String(tally.held)}`,
    );
    const far = survivors.map((f) =>
      me === undefined
        ? '?'
        : `${f.name ?? f.templateId ?? f.id}@${String(Math.max(Math.abs(f.x - me.x), Math.abs(f.y - me.y)))}`,
    );
    console.log(`  [diag] stalled with ${String(foesLeft)} left: ${far.slice(0, 8).join(' ')}`);
  }
  const downCount = bodies.filter(({ body: b }) => !b.alive || isDowned(downed, b.id)).length;
  return {
    outcome: downCount === bodies.length ? 'wipe' : foesLeft === 0 ? 'clear' : 'stall',
    turns,
    worst,
    downCount,
  };
}

const delves = [...SITES.values()].filter((s) => s.kind === RealmKind.Inner);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SAY WHICH "THE WEIR" THIS ROW IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are 27 inner sites and every delve on the moor has a `site:redaction:*`
 * TWIN that inherits its display name. So the table printed two rows called
 * "The Weir" — one 8/8, one 3/8 — with nothing to say which was which, and any
 * reading taken off it was a coin flip between a moor floor and its dark mirror.
 */
const label = (site) =>
  site.id.startsWith('site:redaction:') ? `${site.name} (redacted)` : site.name;

for (const size of [1, 3]) {
  console.log(`\n${size === 1 ? 'ALONE' : 'A PARTY OF THREE'} — ${RUNS} runs each\n`);
  console.log(
    `${'delve'.padEnd(32)} ${'clear'.padStart(6)} ${'wipe'.padStart(5)} ${'stall'.padStart(5)}  ${'turns'.padStart(5)}  ${'hp low'.padStart(6)}  ${'downed'.padStart(6)}`,
  );
  for (const site of delves) {
    const rs = Array.from({ length: RUNS }, (_u, i) =>
      run(site, size, `delve-run:${site.id}:${size}:${i}`),
    );
    const clears = rs.filter((r) => r.outcome === 'clear');
    const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    console.log(
      `${label(site).padEnd(32)} ${`${clears.length}/${RUNS}`.padStart(6)} ` +
        `${String(rs.filter((r) => r.outcome === 'wipe').length).padStart(5)} ` +
        `${String(rs.filter((r) => r.outcome === 'stall').length).padStart(5)}  ` +
        `${String(Math.round(avg(rs.map((r) => r.turns)))).padStart(5)}  ` +
        `${`${Math.round(100 * avg(rs.map((r) => r.worst)))}%`.padStart(6)}  ` +
        `${avg(rs.map((r) => r.downCount))
          .toFixed(1)
          .padStart(6)}`,
    );
  }
}

console.log(
  `\nA STALL IS THE DRIVER, NOT THE ROOM: it walks at the nearest body and\n` +
    `bump-attacks, so a party carrying the Inspector — which deliberately cannot\n` +
    `shoot adjacent — will stand next to something and do nothing. Read stalls as\n` +
    `"this driver cannot finish", never as "this delve cannot be cleared".`,
);
