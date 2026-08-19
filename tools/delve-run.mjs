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
import { ActorKind, ErasedReason } from '../src/shared/protocol.ts';
import { canWalk } from '../src/shared/level.ts';
import { areEnemies } from '../src/server/engine/actor.ts';
import { moneyAmountOf } from '../src/server/content/money.ts';
import { itemById } from '../src/server/content/items.ts';
import { parseItemId } from '../src/server/content/resolve.ts';
import { sellPrice } from '../src/server/content/shops.ts';
import { STEPS, firstStep } from './walk.mjs';
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

  // How many were in the room to begin with — so "pays little" can be told apart
  // from "held little", which are different facts with different answers.
  const startRoster = hostiles().length;
  // BY IDENTITY, because a reaped body leaves `allActors` altogether — counting
  // "not alive" at the end undercounts every kill the reaper has already tidied.
  const startIds = new Set(hostiles().map((a) => a.id));
  if (process.env.DELVE_DIAG === 'carry' && size === 1) {
    const carrying = hostiles().filter(
      (a) => (a.carried ?? []).length > 0 || Object.keys(a.equipped ?? {}).length > 0,
    );
    console.log(
      `  [carry] ${String(site.name).padEnd(26)} ${String(carrying.length)}/${String(startRoster)} carry something` +
        ` | e.g. ${carrying
          .slice(0, 3)
          .map(
            (a) =>
              `${a.name}:${[...(a.carried ?? []), ...Object.values(a.equipped ?? {})].join('+') || 'none'}`,
          )
          .join(' ')}`,
    );
  }
  if (process.env.DELVE_DIAG === 'who' && size === 1) {
    const names = {};
    for (const a of hostiles()) names[a.name ?? a.id] = (names[a.name ?? a.id] ?? 0) + 1;
    console.log(
      `  [who] ${(site.id.startsWith('site:redaction:') ? site.name + ' (redacted)' : site.name).padEnd(30)} ${Object.entries(
        names,
      )
        .map(([n, c]) => n + 'x' + String(c))
        .join(', ')}`,
    );
  }

  let turns = 0;
  let worst = 1;
  let wipes = 0;
  const tally = { shot: 0, moved: 0, held: 0, revived: 0 };
  if (process.env.DELVE_DIAG === 'roster') {
    const n = hostiles().length;
    console.log(`  [roster] ${site.name ?? site.id} size=${String(size)} monsters=${String(n)}`);
  }
  const refusals = new Map();
  for (; turns < TURN_CAP; turns += 1) {
    const foes = livingHostiles();
    const up = bodies.filter((m) => m.body.alive && !isDowned(downed, m.body.id));
    if (foes.length === 0 || up.length === 0) break;

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * SOMEBODY GOES AND PICKS THEM UP. THE PARTY DID NOT, AND IT SHOWED.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * This driver dropped a downed member out of `up` and fought on with two,
     * while a five-turn countdown ran out on the floor beside it. game-design.md
     * calls Downed the mechanic that turns "I died" into GET TO ME, and the
     * party section of this tool has been measuring a party that walks away.
     *
     * IT IS WHY A PARTY LOOKED WORSE THAN A SOLO WATCHMAN. Measured across all
     * 27 floors: where the party WON it won comfortably (low-water 39% against
     * the solo 26%, 72% against 28%), and where it lost it lost as a 900-turn
     * stall at 0% — a member on the floor and nobody coming.
     *
     * ONE RESCUER, NOT ALL OF THEM. The nearest able body breaks off; the rest
     * keep fighting, because a party that all downs tools to fetch one person is
     * a different and equally wrong reading.
     */
    const fallen = bodies.find(({ body }) => body.alive === false || isDowned(downed, body.id));
    const rescuer =
      fallen === undefined
        ? undefined
        : up
            .map((m) => ({
              m,
              d: Math.max(Math.abs(m.body.x - fallen.body.x), Math.abs(m.body.y - fallen.body.y)),
            }))
            .sort((x, y) => x.d - y.d)[0]?.m;

    for (const { body: b, attacks } of up) {
      if (fallen !== undefined && rescuer !== undefined && b.id === rescuer.body.id) {
        const gapToFallen = Math.max(Math.abs(b.x - fallen.body.x), Math.abs(b.y - fallen.body.y));
        if (gapToFallen <= 1) {
          // A direction, per `submitRevive` — and the server prefers a body
          // underfoot, which is where a run to a friend actually ends.
          const step = STEPS.find(
            ([dx, dy]) => b.x + dx === fallen.body.x && b.y + dy === fallen.body.y,
          );
          realm.engine.submitRevive(b.id, step === undefined ? 'n' : step[2]);
          tally.revived += 1;
          continue;
        }
        const toFallen = firstStep(
          (x, y) => canWalk(realm.world.level, x, y),
          { x: b.x, y: b.y },
          { x: fallen.body.x, y: fallen.body.y },
        );
        if (toFallen !== null) {
          realm.engine.submitMove(b.id, toFallen);
          tally.moved += 1;
          continue;
        }
      }

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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A RUN THAT WIPED IS NOT A RUN THAT CLEARED, AND THIS SCORED IT AS ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The outcome was judged at the END — "no foes left" — which a party wipe
     * satisfies for the worst possible reason. `resetFloor` deliberately clears
     * the ground and RE-SEEDS the room ("a reset means the fight did not
     * happen"), so after a wipe the original monsters are gone from the world
     * and a fresh set is fighting. Measured on Blackwood:
     *
     *     [t0]  alive 9/9   ground 4      <- the floor's authored litter
     *     [t25] alive 1/9   ground 0      <- wiped; floor cleared and re-seeded
     *
     * and the run was reported `clear`, with the vanished originals counted as
     * kills and the emptied floor counted as the pay. That is what made the
     * grim floors look like they paid nothing: they were not paying badly, they
     * were wiping the party and resetting.
     *
     * The pump says so plainly — a wipe returns `erased` with reason `Wipe` —
     * so it is read here rather than inferred from the wreckage.
     */
    const pumped = realm.engine.pump();
    for (const ev of [...(pumped?.playerEvents ?? []), ...(pumped?.sweep ?? [])]) {
      if (ev.k === 'erased' && ev.reason === ErasedReason.Wipe) wipes += 1;
    }
    if (process.env.DELVE_DIAG === 'track' && size === 1 && turns % 25 === 0) {
      const alive = livingHostiles().length;
      console.log(
        `    [t${String(turns)}] ${String(site.name).slice(0, 18).padEnd(18)} alive ${String(alive)}/${String(startRoster)}  ground ${String(realm.world.groundItems().length)}`,
      );
    }
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHAT IT PAID. NOTHING HAS EVER MEASURED THIS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Difficulty is only half the question a player asks. `seedAmbush` establishes
   * that the OPENING pays deliberately — "an item 35% of the time" — and there
   * the argument stops: what a DELVE pays has never been measured at all, and it
   * is what decides whether anybody walks to a second one.
   *
   * READ OFF THE FLOOR, which is sound precisely because this driver never picks
   * anything up: everything a corpse spilled is still lying there when the room
   * goes quiet. `WEARABLE` is the number that matters most — gold accumulates
   * and a draught is a consumable, but a thing with a SLOT is the only drop that
   * changes what your character is.
   */
  let gold = 0;
  let items = 0;
  let wearable = 0;
  let worth = 0;
  for (const drop of realm.world.groundItems()) {
    const coins = moneyAmountOf(drop.itemId);
    if (coins !== undefined) {
      gold += coins;
      continue;
    }
    items += 1;
    // WHAT A SHOP WOULD ACTUALLY HAND OVER for it, not what it is "worth":
    // `SELL_PERCENT` is 5, so the two numbers are an order of magnitude apart and
    // only one of them is money a player can spend.
    worth += sellPrice(drop.itemId);
    const base = itemById(parseItemId(drop.itemId)?.base ?? '');
    if (base?.slot !== undefined) wearable += 1;
  }

  if (process.env.DELVE_DIAG === 'loot' && size === 1) {
    const ground = realm.world.groundItems();
    const stillThere = new Set(realm.world.allActors().map((a) => a.id));
    const killed = [...startIds].filter(
      (id) => !stillThere.has(id) || realm.world.getActor(id)?.alive === false,
    ).length;
    const dead = killed;
    console.log(
      `  [loot] ${String(site.name).padEnd(26)} started ${String(startRoster)} dead ${String(dead)} ground ${String(ground.length)}: ${ground
        .map((g) => g.itemId)
        .slice(0, 6)
        .join(' ')}`,
    );
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
    // A WIPE ANYWHERE IN THE RUN OUTRANKS THE ENDING. The party may well be
    // standing in a quiet room at the end — the reset put them there.
    outcome: wipes > 0 || downCount === bodies.length ? 'wipe' : foesLeft === 0 ? 'clear' : 'stall',
    wipes,
    roster: startRoster,
    gold,
    items,
    wearable,
    worth,
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
    `${'delve'.padEnd(32)} ${'clear'.padStart(6)} ${'wipe'.padStart(5)} ${'stall'.padStart(5)}  ${'turns'.padStart(5)}  ${'hp low'.padStart(6)}  ${'downed'.padStart(6)}  ${'gold'.padStart(5)}  ${'items'.padStart(5)}  ${'worn'.padStart(4)}  ${'sells for'.padStart(9)}  ${'foes'.padStart(4)}  ${'drop/foe'.padStart(8)}`,
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
          .padStart(6)}  ` +
        // THE PAY, AVERAGED OVER THE RUNS THAT ACTUALLY CLEARED. A stalled run
        // left half the room alive, so its floor is not what the room is worth.
        `${(clears.length === 0 ? 0 : avg(clears.map((r) => r.gold))).toFixed(0).padStart(5)}  ` +
        `${(clears.length === 0 ? 0 : avg(clears.map((r) => r.items))).toFixed(1).padStart(5)}  ` +
        `${(clears.length === 0 ? 0 : avg(clears.map((r) => r.wearable))).toFixed(1).padStart(4)}  ` +
        `${(clears.length === 0 ? 0 : avg(clears.map((r) => r.worth))).toFixed(0).padStart(9)}  ` +
        `${avg(rs.map((r) => r.roster))
          .toFixed(1)
          .padStart(4)}  ` +
        `${(clears.length === 0
          ? 0
          : avg(clears.map((r) => (r.roster === 0 ? 0 : r.items / r.roster)))
        )
          .toFixed(2)
          .padStart(8)}`,
    );
  }
}

console.log(
  `\nA STALL IS THE DRIVER, NOT THE ROOM: it walks at the nearest body and\n` +
    `bump-attacks, so a party carrying the Inspector — which deliberately cannot\n` +
    `shoot adjacent — will stand next to something and do nothing. Read stalls as\n` +
    `"this driver cannot finish", never as "this delve cannot be cleared".`,
);
