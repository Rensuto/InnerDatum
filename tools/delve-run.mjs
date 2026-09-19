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
import { effectsOn, recomposeCombat } from '../src/server/engine/effects.ts';
import { resolveItem } from '../src/server/content/resolve.ts';
import {
  CLASSES,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../src/server/content/classes.ts';
import { talentRuntimeFor } from '../src/server/main.ts';
import { ActorKind, ErasedReason } from '../src/shared/protocol.ts';
import { canRoute, canWalk } from '../src/shared/level.ts';
import {
  bearBirthKit,
  growTo,
  dressFor,
  foldPassives,
  levelOnTheFloor,
  rememberWhatProbesSee,
  spendPointsTo,
} from './grown.mjs';
import { areEnemies } from '../src/server/engine/actor.ts';
import { canAttack } from '../src/server/engine/combat.ts';
import { moneyAmountOf } from '../src/server/content/money.ts';
import { itemById } from '../src/server/content/items.ts';
import { parseItemId } from '../src/server/content/resolve.ts';
import { sellPrice } from '../src/server/content/shops.ts';
import { STEPS, firstStep } from './walk.mjs';
import {
  classStrikes,
  firingSpot,
  nearestQuarry,
  selfHelp,
  takeHelp,
  takeShot,
} from './fightlib.mjs';
import { BIRTH_INSCRIPTIONS, talentsFor } from '../src/server/content/inscriptions.ts';
import { accept, createPartyState, invite, MAX_PARTY_SIZE } from '../src/server/engine/party.ts';

const RUNS = Number(process.argv[2] ?? 8);

/**
 * WHAT LEVEL THE PARTY IS — `node tools/delve-run.mjs 8 6`.
 *
 * ═══ EVERY NUMBER THIS TOOL EVER PRINTED WAS A LEVEL-1 BODY WEARING NOTHING ═══
 * The bodies below were built the way every probe here builds one: `addPlayer`,
 * the class combat sheet, `sheetForClass`. That is a character with four birth
 * talents at rank 1 and an empty paper doll, plus the brass lantern every
 * character is born wearing (`bearBirthKit`) — which is NOT a cosmetic detail
 * and was missing for as long as this tool has existed. See `grown.mjs`.
 *
 * It is the wrong body for a DELVE. This tool sent it into all sixteen,
 * including the ones a party reaches after twenty levels and a lot of gear, and
 * reported 0 of 8 on every row. A row measured against a character nobody has
 * ever played is a measurement of the probe.
 *
 * Defaults to 1, so running it bare prints what it has always printed and every
 * number anybody wrote down still compares.
 */
const LEVEL = Number(process.argv[3] ?? 1);
/** Long enough to cross a 34x30 room several times and kill ten things. */
const TURN_CAP = 900;

/** The three classes, so a party is a real party rather than one body tripled. */
const PARTY = CLASSES.slice(0, 3);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE RUN, AND IT IS EXPORTED BECAUSE A SECOND TOOL NEEDS THE SAME ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tools/delve-density.mjs` asks a different question of the same fight — per
 * CLASS and per FLOOR rather than per site — and the one thing that must not
 * happen is a second copy of this driver. Every lesson in this file's header
 * and in `fightlib.mjs` was learned once and would have to be learned again in
 * a duplicate.
 *
 * `opts` is what the second question needs and nothing else:
 *
 *   `party`    which classes are in the room, in order. Defaults to `PARTY`, so
 *              a bare call is exactly the run this tool has always made.
 *   `level`    what level to grow each body to. Defaults to the CLI's `LEVEL`.
 *   `floor`    which floor of the site to open, from 1.
 *   `strength` the `PartyStrength` the FLOOR is built for — `delveHeadroom`
 *              reads its `size`, and `delveLevel` its `level`. See the call.
 *   `turnCap`  how long before a run is called a stall.
 *   `xp`       what is already in the experience bar. A descent carries a
 *              part-filled level down from the floor above.
 *   `equipped`  the paper doll to wear instead of rolling a fresh one. See the
 *              call — a descent carries its gear rather than re-rolling it.
 *   `lantern`  false rebuilds the BLIND body every number here was measured on
 *              before `bearBirthKit` existed. It is the before-picture switch,
 *              and it is here rather than in a note because "the fix moved the
 *              numbers" is a claim somebody has to be able to re-run. Nothing
 *              but `delve-density.mjs --blind` passes it.
 */
export function run(site, size, seed, opts = {}) {
  const party = opts.party ?? PARTY;
  const level = opts.level ?? LEVEL;
  const floor = opts.floor ?? 1;
  const turnCap = opts.turnCap ?? TURN_CAP;
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
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE BODIES THE LEVELLING SEAM HAS TO FIND, KEYED BY ID.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `engineFor` runs inside `createRealms`, which is BEFORE a single body
   * exists, so the seam below cannot close over the bodies themselves. It
   * closes over this map and the map is filled a few lines later — the same
   * shape main.ts uses for `refreshPassives`, which is declared a hundred lines
   * after the call that installs it and is wrapped in an arrow for exactly this
   * reason ("a temporal dead zone and the server refuses to boot").
   */
  const born = new Map();
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AND THE SEAM ITSELF — WHAT A LEVEL GAINED MID-FLOOR IS WORTH.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `awardExperience` has always fired in this probe, because this probe has
   * always driven the real pump: a body's `level` and `xp` moved with every
   * kill. NOTHING SPENT WHAT THAT LEVEL PAID. `applyPendingLevels` banked the
   * talent point and the three attribute points into `unspentPoints` /
   * `unspentStatPoints`, and in production a player spends them and
   * `refreshPassives` resizes the body; a probe has no player and wired no
   * refresh, so every row this tool has printed is a character whose level
   * counted up and whose Strength, talents and hit-point ceiling did not.
   *
   * See `levelOnTheFloor` in grown.mjs. Installed in BOTH places main.ts hangs
   * `refreshPassives`, because they catch different events and the tool needs
   * both: `onSheetDirty` is the forced level on arrival and an effect that
   * grants stats, `onActBase` is once per base turn, which is what catches a
   * level gained in the middle of a pump.
   */
  const refreshBody = (actorId) => {
    const m = born.get(actorId);
    if (m === undefined) return;
    /**
     * THE THIRD ARGUMENT IS THE BOARD, AND IT IS WHAT MAKES THE PASSIVES REAL.
     * `foldPassives` (grown.mjs) needs the world to answer "who is next to me"
     * and the registry to find a talent's `passive` block — the same two things
     * main.ts#refreshPassives resolves on its first two lines. Without it every
     * passive in the game contributed nothing to every row this tool printed.
     */
    levelOnTheFloor(m.body, m.cls, m.sheet, effects, {
      world: realm.world,
      registry: talentEngine.registry,
      engine: talentEngine,
    });
  };
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AND THEY ARE IN A PARTY, WHICH DECIDES WHO GETS PAID FOR A KILL.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `awardExperience` pays `membersOf(run.ctx.parties, killerId)`; with no party
   * table it pays the killer ALONE. So every multi-body row this tool has
   * printed levelled only whoever landed each blow — DECISIONS.md D12 is a full
   * share to every member, and the whole design consequence of it ("everyone is
   * always the same level") was absent from the measurement.
   *
   * A SOLO ROW IS BYTE-IDENTICAL: `partyOf` mints a party of one on demand and
   * `membersOf` returns `[self]`, which is the no-table answer.
   *
   * `MAX_PARTY_SIZE` IS 4 AND THIS TOOL MEASURES FIVE. A sixth body cannot join
   * and would then be paid alone, so past the cap the table is left out
   * altogether and every body earns its own kills — the old behaviour, applied
   * deliberately at the one size where the real game would refuse the party.
   */
  const parties = size <= MAX_PARTY_SIZE ? createPartyState() : undefined;
  const realms = createRealms({
    seed,
    engineFor: (world) =>
      createTurnEngine({
        world,
        downed,
        effects,
        ...(parties === undefined ? {} : { parties }),
        onSheetDirty: refreshBody,
        talents: createTalentBook(talentEngine, world),
        talentRuntime: talentRuntimeFor(
          talentEngine,
          world,
          undefined,
          undefined,
          undefined,
          undefined,
          refreshBody,
        ),
      }),
  });
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE FLOOR IS BUILT FOR THE PARTY WALKING INTO IT, AND THIS PASSED NOBODY.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `open(site, partyId)` leaves `party` undefined, which `populateDelve`
   * defaults to `LONE_BEGINNER`. So every "A PARTY OF THREE" row this tool has
   * ever printed fought a room sized for ONE person: `delveHeadroom(3)` is
   * x2.0, and none of it was ever applied. Three bodies against a solo
   * population is not the game, and it is the direction that flatters.
   *
   * SIZE ONLY BY DEFAULT, never level: `delveLevel` reads `.level` and the
   * classic rows are level-1 bodies, so the floor stays the floor it was.
   * `opts.strength` is what the density tool overrides when it wants the floor
   * built for the party that would actually be standing in it.
   */
  const strength = opts.strength ?? { level, size };
  const realm = realms.open(site, seed, strength, undefined, undefined, floor);

  const bodies = [];
  for (let i = 0; i < size; i += 1) {
    const cls = party[i % party.length];
    const p = realm.world.addPlayer(`p${i}`, `P${i}`);
    // THE COMBAT SHEET. See the header.
    p.combat = cls.combat;
    p.baseCombat = cls.combat;
    p.maxHp = cls.maxHp;
    p.hp = cls.maxHp;
    p.hpRegen = cls.hpRegen;
    // THE SHEET IS WHAT MAKES THE BOOK ANSWER: without one `loadoutOf` is empty
    // and every talent is refused as "no such talent in this loadout".
    // GROWN FIRST, THEN DRESSED, THEN THE SHEET — see tools/grown.mjs for why
    // the order is `monsters.ts`'s: a pool sized before the stats exist cannot
    // include the Constitution they bought.
    growTo(p, cls, level);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT IT IS WEARING — ROLLED FRESH, OR CARRIED DOWN THE STAIRS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `dressFor` rolls one item per slot at this level's band, which is the
     * right answer for a ONE-FLOOR row: it asks "is this room fair to somebody
     * who got here", and somebody who got here has gear.
     *
     * IT IS THE WRONG ANSWER FOR A DESCENT. `delve-climb.mjs` walks one
     * character down three floors, and re-rolling the doll on each one would
     * hand a level-1 body that walked into the intro wearing a lantern a full
     * suit of armour the moment it crossed into floor 2 — which is the gear
     * cliff the balance readings kept finding, manufactured by the probe. So a
     * caller that is carrying a character passes the doll it already had.
     */
    if (opts.equipped !== undefined) p.equipped = { ...opts.equipped };
    else if (level > 1) dressFor(p, level, realm.world.lootRng.fork(`delve.dress.p${String(i)}`));
    const sheet = sheetForClass(cls);
    spendPointsTo(sheet, cls, level);
    talentEngine.attach(p.id, sheet);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THE LANTERN, WHICH IS WHY HALF THIS TABLE WAS FICTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * AFTER `dressFor`, never before: `dressFor` assigns `body.equipped = worn`
     * outright, so a kit granted first is thrown away. `bearBirthKit` skips a
     * slot that is already filled, so a dressed body keeps the lantern the loot
     * table rolled it and a bare one gets the brass lantern the gateway hands
     * every new character.
     *
     * IT ALSO DOES THE `recomposeCombat` THIS BLOCK USED TO GUARD ON `level > 1`.
     * Unconditional now, and it has to be: the doll is non-empty at every level
     * the moment the lantern is on it.
     *
     * MEASURED on the five dark caves before it existed — `visionOf` from the
     * arrival tile saw ONE TILE, its own, because `computeVision`'s `lite <= 0`
     * branch is exactly that (class/Player.lua:653) and a cave lights nothing.
     * Every `no_los` refusal past a neighbour was then charged to the class.
     */
    if (opts.lantern === false) recomposeCombat(p, effects, resolveItem);
    else bearBirthKit(p, effects);
    /**
     * AND THE PASSIVES, BEFORE THE FIRST TURN RATHER THAN AFTER IT.
     * `refreshBody` above folds them on `onActBase`, which is once the clock has
     * started — so without this line the opening turns of every run, which are
     * the turns a level-1 body is most likely to die in, were fought by a
     * character with no passive talents. Production folds at `join`.
     */
    foldPassives(p, sheet, effects, {
      world: realm.world,
      registry: talentEngine.registry,
      engine: talentEngine,
    });
    recomposeCombat(p, effects, resolveItem);
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND ONLY NOW DOES IT ARRIVE. `join` WAS THE FIRST THING AND HAD TO MOVE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `join` runs `levelUpOnArrival` — the port of reknor-escape's `on_enter`,
     * which force-levels whoever walks onto floors 2 and 3 of the intro. It was
     * being called on a LEVEL-1 body before `growTo` had run, so on the tutorial
     * it banked two or three levels' worth of `pendingLevels` and then `growTo`
     * set the level again on top: the body was paid the same points twice, once
     * by `spendPointsTo` and once by `applyPendingLevels`.
     *
     * Built first, arrives second. `forceLevelup` is a FLOOR and never a set
     * (progression.ts), so a body already grown to the floor's own level gains
     * nothing here, which is exactly what a returning player gets — and the
     * seam above is registered before the arrival, so the forced level's own
     * `onSheetDirty` can find this body.
     */
    /**
     * AND WHAT IS ALREADY IN THE BAR. A descent carries a part-filled level
     * from the floor above; without this every floor of a delve would start at
     * `xp = 0` and the third one would be measuring a character that had killed
     * nothing, which is the whole thing this probe was just fixed to stop doing.
     */
    if (opts.xp !== undefined) p.xp = opts.xp;
    born.set(p.id, { body: p, cls, sheet });
    realm.engine.join(p.id);
    realm.engine.setConnected(p.id, true);
    bodies.push({
      body: p,
      attacks: classStrikes(cls),
      // AND THE BUTTONS THAT HELP THE PRESSER. Read from the same two sources
      // `sheetForClass` joins, because an inscription is in neither `ClassDef`.
      helps: selfHelp(cls, undefined, talentsFor(BIRTH_INSCRIPTIONS)),
    });
  }

  /**
   * WHAT LEVEL EACH BODY WALKED IN AT, so the run can report what the FLOOR
   * paid rather than what the probe was grown to. See `levelsGained` below.
   */
  const arrivedAt = bodies.map(({ body: b }) => b.level);

  /**
   * ONE PARTY, FORMED THE WAY A PARTY IS FORMED — invite, accept. There is no
   * back door into `PartyState` and there should not be: `accept` is what moves
   * a member between rows and clears the offer, and a hand-built table would be
   * a second opinion about what being in a party means.
   */
  if (parties !== undefined && bodies.length > 1) {
    const lead = bodies[0].body.id;
    for (const { body: b } of bodies.slice(1)) {
      invite(parties, lead, b.id, 0);
      accept(parties, b.id, lead, 0);
    }
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
  /** Hit points actually taken off the party, summed over the run. See below. */
  let damage = 0;
  const tally = { shot: 0, bumped: 0, moved: 0, held: 0, revived: 0 };
  if (process.env.DELVE_DIAG === 'roster') {
    const n = hostiles().length;
    console.log(`  [roster] ${site.name ?? site.id} size=${String(size)} monsters=${String(n)}`);
  }
  const refusals = new Map();
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHERE EACH BODY DECIDED TO GO, KEPT UNTIL IT GETS THERE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * WITHOUT THIS THE DRIVER OSCILLATES BETWEEN TWO TILES FOREVER, and it looks
   * exactly like a hard-stuck body. It was misdiagnosed three times in this
   * project's notes — as a kiter, as unreachable foes, and finally as "a body
   * that cannot step onto an adjacent empty tile" — because the `stuck`
   * diagnostic sampled every 150 turns and a 2-cycle shows the same phase every
   * even sample. Sampling every turn shows it plainly:
   *
   *     [t190] p0 at 8,19 -> e 9,19 | goal 18,25   (the quarry)
   *     [t191] p0 at 9,19 -> w 8,19 | goal 15,18   (a firing spot)
   *     [t192] p0 at 8,19 -> e 9,19 | goal 18,25
   *
   * ═══ THE CAUSE IS THAT THE DESTINATION IS A FUNCTION OF WHERE YOU STAND ═══
   * `firingSpot` (fightlib.mjs:213) scans a radius-6 box CENTRED ON THE BODY, so
   * the candidate set moves with the body: a spot on the box edge is visible
   * from one tile and gone from its neighbour. When the route to that spot
   * happens to start by stepping AWAY from it — around a wall, which is most of
   * a carved cave — the body steps off the tile that could see it, the spot
   * vanishes, the fallback goal is the quarry in the other direction, and the
   * next step puts it back. Neither function is wrong on its own.
   *
   * ═══ COMMITMENT, WHICH IS ALSO WHAT UPSTREAM'S AI DOES ═══
   * ToME keeps `ai_target.actor` and a move target across turns rather than
   * re-deciding from scratch (`ai/simple.lua`). A goal is dropped only when it
   * is REACHED, when the quarry that justified it is gone, or when the tile
   * stops being somewhere you could stand. Re-deciding every turn from a
   * position-dependent function cannot be made stable by improving the function.
   *
   * IT DOES NOT DELAY A SHOT. The "can I attack right now" branch runs before
   * any of this and holds the turn; commitment only decides where to walk on a
   * turn the body was going to walk anyway.
   */
  const heading = new Map();
  /**
   * THE LAST ORDER EACH BODY GAVE, AND FROM WHERE. Only read to notice that a
   * body is re-sending a step it already had refused from the same tile — see
   * the through-ally note below. A refused player intent costs no energy, so
   * without this the driver can order one blocked direction forever.
   */
  const lastOrder = new Map();
  const lastVerb = new Map();
  for (; turns < turnCap; turns += 1) {
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

    for (const { body: b, attacks, helps } of up) {
      if (fallen !== undefined && rescuer !== undefined && b.id === rescuer.body.id) {
        const gapToFallen = Math.max(Math.abs(b.x - fallen.body.x), Math.abs(b.y - fallen.body.y));
        if (gapToFallen <= 1) {
          // A direction, per `submitRevive` — and the server prefers a body
          // underfoot, which is where a run to a friend actually ends.
          const step = STEPS.find(
            ([dx, dy]) => b.x + dx === fallen.body.x && b.y + dy === fallen.body.y,
          );
          lastVerb.set(b.id, `revive:${step === undefined ? 'underfoot' : step[2]}`);
          realm.engine.submitRevive(b.id, step === undefined ? 'n' : step[2]);
          tally.revived += 1;
          continue;
        }
        const toFallen = firstStep(
          (x, y) => canRoute(realm.world.level, x, y),
          { x: b.x, y: b.y },
          { x: fallen.body.x, y: fallen.body.y },
        );
        if (toFallen !== null) {
          lastVerb.set(b.id, 'move:toFallen');
          realm.engine.submitMove(b.id, toFallen);
          tally.moved += 1;
          continue;
        }
      }

      /**
       * ═══ PATCH YOURSELF UP FIRST, WHICH THIS DRIVER NEVER DID ═══
       * Three infusions have been on every body since inscriptions shipped and
       * this loop pressed none of them, so every row below understated survival.
       * BEFORE the shot, because a heal that costs no turn and a heal that costs
       * one are both worth more than a swing you take at 30% health.
       */
      const helpCost = takeHelp(realm.engine, b.id, helps, b);
      if (helpCost !== null) lastVerb.set(b.id, 'help');
      if (helpCost !== null) {
        tally.helped = (tally.helped ?? 0) + 1;
        // ONLY A PRESS THAT COST A TURN ENDS THE TURN. `no_energy = true` is
        // two of the three infusions, and a driver that stopped to drink one
        // was throwing away an attack the engine never charged for.
        if (helpCost > 0) continue;
      }

      const living = foes.filter((f) => f.alive);
      // WHAT TO WALK AT — nearest thing that will stand and fight, and only
      // then the nearest thing at all. See `fightlib.mjs#nearestQuarry`: every
      // stall row in this table was a party towed around a room by a kiter.
      const near = nearestQuarry(living, b);
      if (near === undefined) break;

      /**
       * SHOOT IF YOU CAN SHOOT. Two of the three classes in this party are
       * ranged and one of them has a dead zone, so a party that only ever walks
       * at the nearest monster is not the party this game ships. See
       * `fightlib.mjs`.
       */
      const { fired, gap } = takeShot(
        realm.engine,
        b.id,
        attacks,
        b,
        living,
        (id, shot) => {
          if (process.env.DELVE_DIAG === '3') {
            refusals.set(String(shot?.code), (refusals.get(String(shot?.code)) ?? 0) + 1);
          }
        },
        // THE WORLD, so the band asks the engine's own question about the
        // line: WALLS, and in a dark delve whether this body can see that far.
        // Without walls a foe behind one counted as a shot and this driver paced
        // between two tiles. See `lineFor` in fightlib.mjs.
        realm.world,
      );
      if (fired) {
        lastVerb.set(b.id, 'shot');
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * BUT A HUSK ON YOUR SHOULDER IS NOT A DISTANCE YOU ARE KEEPING.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The paragraph above is right about the Inspector at six tiles and it was
       * applied to every body at every range, including one standing IN CONTACT
       * with its full remaining resource spent. The result is not a player
       * waiting, it is a player watching:
       *
       *   Blackwood floor 1, level 15, three runs each, HEAD
       *     class          outcome   turns   held   dmg taken   hp low
       *     The Alchemist  wipe x3     900  554-630  2485-5524    0-1%
       *     The Redactor   wipe x2     900  672-716  1998-2717    0-1%
       *     The Watchman   clear x3 175-214   21-34      17-71   95-99%
       *
       * Six hundred of nine hundred turns spent holding, four hundred of them
       * drinking an infusion, and the run ends as a wipe. The Alchemist and the
       * Redactor have NO dead zone (`minRange: 0` on every talent they own) and
       * a bump-attack costs no resource at all — so the one thing a real player
       * does when the flasks run out was the one thing this driver could not do,
       * and it was never in the tally because nothing ever incremented it.
       *
       * ═══ AND THE ENGINE IS ASKED, NOT RE-IMPLEMENTED — BY THE RIGHT CALL ═══
       * The Inspector genuinely cannot swing at contact: `scheduler.ts:2725-2761`
       * runs `canAttack` on the occupant of the tile stepped into and refuses her
       * bump with `TooClose`, saying in as many words that a melee exemption
       * would be "the whole class's counterplay deleted by accident". So the
       * DRIVER ASKS `canAttack` TOO, which is literally the function the bump is
       * about to be judged by. Null means swing. ANYTHING ELSE MEANS HOLD,
       * exactly as before — the Inspector's rows are unchanged by this edit, by
       * construction, and that is deliberate.
       *
       * NOT `submitMove`'s RETURN VALUE, which was the first attempt and is a
       * trap: `submitMove` reports whether the INTENT was accepted (`no_actor` is
       * its only refusal) and the dead zone is judged at RESOLUTION, inside the
       * pump. Measured — the Inspector "bumped" 875 times in 900 turns, dealt
       * nothing, took nothing and stalled at 100% health, because every one of
       * those was an intent accepted and then thrown away.
       *
       * ═══ AND THE DEAD ZONE IS LEFT ALONE, HAVING BEEN TRIED ═══
       * Backing a body out of contact when `canAttack` refuses looks like the
       * obvious other half and it makes the measurement WORSE: the Inspector
       * retreats one tile, the husk closes one tile, and she paces to the turn
       * cap. Measured, The Underworks at level 3, three runs — `clear` in 175-208
       * turns became `stall` at 900 with 895 moves and 3 shots, and Blackwood's
       * wipes became stalls at 100% health. A body that survives by never
       * fighting is not a reading about the floor. Her escape is `fog_step`, a
       * blink this driver does not press; until it does, holding is the honest
       * measurement of a class in a bind and the bind is real.
       */
      if (gap !== null && attacks.length > 0) {
        const contact = living.find(
          (f) => Math.max(Math.abs(f.x - b.x), Math.abs(f.y - b.y)) === 1,
        );
        const into =
          contact === undefined
            ? undefined
            : STEPS.find(([dx, dy]) => b.x + dx === contact.x && b.y + dy === contact.y);
        if (
          contact !== undefined &&
          into !== undefined &&
          canAttack(b, contact, realm.world) === null
        ) {
          tally.bumped += 1;
          lastVerb.set(b.id, `bump:${into[2]}`);
          realm.engine.submitMove(b.id, into[2]);
          continue;
        }
        tally.held += 1;
        realm.engine.hold(b.id);
        continue;
      }

      // Nothing was in a band this turn: back out of a dead zone, or close.
      const shortest = attacks[attacks.length - 1] ?? null;
      const away = shortest !== null && gap === null && near.d < shortest.minRange;
      // ═══ AND THE THIRD OPTION `first-fight.mjs` LEARNED IT NEEDED ═══
      // Close and back off are both moves along the line to the foe, so neither
      // answers a WALL. `firingSpot` names a tile with a real shot from it.
      /**
       * THE HEADING THIS BODY IS ALREADY WALKING TO, if it is still worth
       * walking to. See `heading` above for why this exists at all.
       *
       * `away` drops it deliberately: backing out of a dead zone is a REACTION
       * to where the foe is now, and a body that kept walking to a firing spot
       * while standing inside its own minimum range would be committed to the
       * one thing it must not do.
       */
      const held = heading.get(b.id);
      const keep =
        held !== undefined &&
        !away &&
        held.quarry === near.f.id &&
        !(b.x === held.x && b.y === held.y) &&
        canWalk(realm.world.level, held.x, held.y) &&
        realm.world.actorAt(held.x, held.y) === undefined;
      const spot = keep
        ? { x: held.x, y: held.y }
        : away
          ? null
          : firingSpot(attacks, b, living, realm.world, (x, y) => canWalk(realm.world.level, x, y));
      const goal =
        spot !== null
          ? spot
          : away
            ? { x: b.x + Math.sign(b.x - near.f.x), y: b.y + Math.sign(b.y - near.f.y) }
            : { x: near.f.x, y: near.f.y };
      /**
       * ONLY A FIRING SPOT IS COMMITTED TO. Walking AT the quarry is already
       * stable — the goal is the foe's own tile, which does not move because
       * this body stepped — and backing off is a reaction that must be re-taken
       * every turn. The unstable one is the only one worth remembering.
       */
      if (spot !== null && !keep) heading.set(b.id, { x: spot.x, y: spot.y, quarry: near.f.id });
      else if (spot === null) heading.delete(b.id);
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
      const terrain = (x, y) => canRoute(realm.world.level, x, y);
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
       * So: round the party if that works, THROUGH it if it does not, and hold
       * only when there is no route on terrain at all.
       *
       * ═══════════════════════════════════════════════════════════════════════
       * AND THE REASON GIVEN FOR WALKING THROUGH WAS FALSE.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * It read: *"the step is refused at resolution and costs a turn, which is
       * honest — that is what a real player pressing into a friend gets"*. It
       * costs NOTHING. `actPlayer` returns `Park` on a refusal — energy unspent,
       * *"the loop comes back to them before the world moves"* — so a driver
       * re-issuing the same blocked direction spins at full energy and the
       * floor's clock never advances for anybody. Measured on Blackwood:
       *
       *     [t750] p0 at 9,15 -> w 8,15 | occupant p2 | energy 1000
       *
       * — 750 turns, three bodies, nothing moving.
       *
       * A real player pressing into a friend now SWAPS with them (the shove
       * rule was one-sided in the same pass that found this), so the through-
       * route is legal far more often than it was. What it must not become is a
       * direction re-sent forever: if the same blocked step is ordered twice
       * running from the same tile, hold instead and let the world move.
       */
      const dir =
        firstStep(clear, { x: b.x, y: b.y }, goal) ?? firstStep(terrain, { x: b.x, y: b.y }, goal);
      /**
       * ANY step ordered twice from the same tile, not just one through an ally.
       * The engine is not frozen by a refusal — test/server/ally-swap.test.ts
       * pins that a body pressing into a shopkeeper does not stop anybody else
       * taking a turn — so a repeat here is purely the DRIVER wasting the floor's
       * remaining turns on an order it has already watched fail. The refusals
       * seen in practice are `occupied`, and an occupant may be a townsfolk or a
       * downed body, neither of which an ally check would have caught.
       */
      const repeat = lastOrder.get(b.id);
      if (
        dir !== null &&
        repeat !== undefined &&
        repeat.dir === dir &&
        repeat.x === b.x &&
        repeat.y === b.y
      ) {
        // THE SAME ORDER, FROM THE SAME TILE, TWICE — so the first one did not
        // move this body. Standing still is a turn the engine will actually
        // take, which is the whole difference.
        tally.held += 1;
        lastOrder.delete(b.id);
        realm.engine.hold(b.id);
        continue;
      }
      lastOrder.set(b.id, { dir, x: b.x, y: b.y });
      if (dir === null) {
        tally.held += 1;
        realm.engine.hold(b.id);
        continue;
      }
      tally.moved += 1;
      lastVerb.set(b.id, `move:${dir}`);
      const moved = realm.engine.submitMove(b.id, dir);
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * `DELVE_DIAG=stuck` — WHY A BODY IS NOT MOVING, in one line per sample.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The `2` trace above shows a leader FROZEN at one tile for 600 turns at
       * full health. That is the symptom; this is the question. Every field here
       * exists because it eliminated a hypothesis:
       *
       *   `energy`   — 1000 means the body never SPENT a turn. A refused player
       *                intent is refunded and re-prompted (scheduler.ts:2090),
       *                so a driver re-issuing one direction spins at full energy.
       *   `party`    — 1 rules out allies blocking the corridor, which is the
       *                cause the driver's own notes were written for.
       *   `effects`  — a permanent stun would look exactly like this. It is not.
       *   `target`   — the tile the order actually names, its terrain and its
       *                occupant. `walk true occupant none` is the finding: the
       *                order is legal and it does not happen.
       *
       *   `whoseTurn` — the barrier's blocking set. It named a body the driver
       *                had not commanded yet this turn, which looked like a
       *                deadlock and was a sampling artefact of reading it from
       *                inside the loop.
       *   `shovedBy` — the ally-swap mark. `p0 -> w | occupant p2 | shovedBy p2`
       *                is the whole of one real bug, in one line.
       *
       * ═══ AND THE CONCLUSION IT USED TO CARRY WAS WRONG, THREE TIMES ═══
       * This block said: *"a solo body, no effects, full energy, ordering a move
       * onto an adjacent empty walkable tile … and the body does not move, for
       * 750 turns"*, and named the BARRIER as the suspect. Before that the same
       * stall was blamed on a kiter, and before that on unreachable foes.
       *
       * It was none of them. The sample interval was 150 turns and the body was
       * in a TWO-CYCLE, so every sample caught the same phase. `DELVE_EVERY=1`
       * shows it in three lines — see the `heading` note at the top of this
       * function for the cause and the fix. A stall diagnostic that samples must
       * be able to sample every turn, which is what `DELVE_EVERY` is for.
       */
      if (
        process.env.DELVE_DIAG === 'stuck' &&
        turns % (Number(process.env.DELVE_EVERY) || 150) === 0 &&
        b.id === bodies[0].body.id
      ) {
        const DELTA = {
          n: [0, -1],
          ne: [1, -1],
          e: [1, 0],
          se: [1, 1],
          s: [0, 1],
          sw: [-1, 1],
          w: [-1, 0],
          nw: [-1, -1],
        };
        const [dx, dy] = DELTA[dir] ?? [0, 0];
        const tx = b.x + dx;
        const ty = b.y + dy;
        const who = realm.world.actorAt(tx, ty);
        console.log(
          `  [stuck t${String(turns)}] ${b.id} at ${String(b.x)},${String(b.y)} -> ${String(dir)} ${String(tx)},${String(ty)}` +
            ` | walk ${String(canWalk(realm.world.level, tx, ty))} occupant ${who === undefined ? 'none' : String(who.id)}` +
            ` | party ${String(bodies.length)} energy ${String(b.energy)}` +
            // THE BARRIER, WHICH IS THE STANDING SUSPECT. `whoseTurn` is who the
            // quorum is waiting on; if it names a body the driver never commands
            // — a downed one, a disconnected one — the level never ticks and
            // every field above stays exactly as it was.
            ` | accepted ${String(moved?.ok)}` +
            ` | whoseTurn ${realm.engine.turnState().whoseTurn.join('/') || 'none'}` +
            ` | standingBy ${realm.engine.turnState().standingBy.join('/') || 'none'}` +
            ` | engagement ${String(realm.engine.turnState().engagement)}` +
            ` | bodies ${bodies
              .map(
                (m) =>
                  `${m.body.id}:${m.body.alive ? 'up' : 'dead'}${isDowned(downed, m.body.id) ? '/down' : ''}:e${String(m.body.energy)}:i${m.body.pendingIntent === null || m.body.pendingIntent === undefined ? '-' : m.body.pendingIntent.kind}`,
              )
              .join(' ')}` +
            ` | shovedBy ${String(b.shovedBy)}` +
            ` | goal ${String(goal.x)},${String(goal.y)} quarry ${String(near.f.id)}@${String(near.f.x)},${String(near.f.y)} d${String(near.d)}` +
            ` | effects ${
              effectsOn(effects, b.id)
                .map((e) => `${e.effectId}:${String(e.dur)}`)
                .join(',') || 'none'
            }`,
        );
      }
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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND THEN EVERYBODY REMEMBERS WHERE THEY HAVE BEEN — the gateway's
     * `rememberWhatPlayersSee`, which an in-process probe never ran.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `playerLineClear` is TWO terms, seen and REMEMBERED, and without this the
     * second was empty for the whole run: a body could not draw a line back
     * down the corridor it had just walked up, which a real player can. AFTER
     * the pump for the gateway's own reason — the tile a body stands on is only
     * decided when its intent resolves.
     */
    rememberWhatProbesSee(realm.world);
    if (
      process.env.DELVE_DIAG === 'stuck' &&
      turns % (Number(process.env.DELVE_EVERY) || 150) === 0 &&
      turns > 0
    ) {
      // WHAT THE PUMP ACTUALLY SAID. `actPlayer` pushes `{t:'refunded', reason}`
      // on the refund path, which is the one thing that distinguishes "the
      // resolver said no" from "the loop never reached this body".
      const evs = [...(pumped?.playerEvents ?? []), ...(pumped?.sweep ?? [])];
      for (const r of pumped?.refusals ?? []) {
        console.log(
          `  [refused t${String(turns)}] ${String(r.id)}: ${String(r.reason)} verb=${String(lastVerb.get(r.id))}`,
        );
      }
      console.log(
        `  [ev t${String(turns)}] ${evs.map((e) => `${String(e.t ?? e.k)}${e.reason === undefined ? '' : ':' + String(e.reason)}${e.id === undefined ? '' : '@' + String(e.id)}`).join(' ') || 'none'}`,
      );
    }
    if (process.env.DELVE_DIAG === 'stuck' && turns % 300 === 0 && turns > 0) {
      console.log(
        `  [pump t${String(turns)}] returned ${pumped === undefined ? 'undefined' : pumped === null ? 'null' : `{events ${String(pumped.playerEvents?.length ?? 0)} sweep ${String(pumped.sweep?.length ?? 0)}}`}`,
      );
    }
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
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * WHY IT CANNOT MOVE — the eight tiles around it, terrain and bodies.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The trace above shows a leader FROZEN at one tile for 600 turns at full
       * health, ordering a move every turn and never arriving, with the nearest
       * foe equally frozen. `moved 900 held 0` says the driver kept trying. That
       * is not a slow grind and it is not a kiter — it is a body that cannot
       * take a step, and the only thing that tells you which is to look at what
       * is around it.
       */
      const ring = [];
      for (const [dx, dy] of [
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
      ]) {
        const nx = me.x + dx;
        const ny = me.y + dy;
        const walk = canWalk(realm.world.level, nx, ny);
        const who = realm.world.actorAt(nx, ny);
        ring.push(
          !walk ? '#' : who !== undefined ? (who.kind === ActorKind.Monster ? 'M' : 'P') : '.',
        );
      }
      console.log(`  [t${String(turns)}] ring N,NE,E,SE,S,SW,W,NW = ${ring.join('')}`);
      console.log(
        `  [t${String(turns)}] leader ${String(Math.round(me.hp))}/${String(me.maxHp)} at ${String(me.x)},${String(me.y)}` +
          (nearest === undefined
            ? '  no foes'
            : `  nearest ${String(nearest.f.name ?? nearest.f.id)} ${String(Math.round(nearest.f.hp))}hp at gap ${String(nearest.d)}`),
      );
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THE ROOM TOOK OUT OF THEM, WHICH THE LOW-WATER MARK CANNOT SAY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `worst` is one instant — the deepest any body ever got — and a floor that
     * grinds you from full to half four times over reads identically to one
     * that took you to half once. Damage is the integral, so it is summed turn
     * by turn against what each body had last turn, and a heal simply
     * contributes nothing (the drop is clamped at zero rather than netted).
     * That is what "how much did this floor hurt" means to a player.
     */
    for (const m of bodies) {
      const b = m.body;
      worst = Math.min(worst, b.hp / b.maxHp);
      const before = m.was ?? b.maxHp;
      if (b.hp < before) damage += before - b.hp;
      m.was = b.hp;
    }
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
  if (['1', '3'].includes(process.env.DELVE_DIAG ?? '') && foesLeft > 0 && turns >= turnCap) {
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
              (x, y) => canRoute(realm.world.level, x, y),
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
  /**
   * DEAD IS NOT DOWNED, AND ONLY ONE OF THEM IS A DEATH. `downCount` counts both
   * because a party that is all on the floor has lost the room either way; this
   * counts the bodies the room actually killed, which is the number a player
   * means by "how many times did we die in there".
   */
  const deaths = bodies.filter(({ body: b }) => !b.alive).length;
  /**
   * THE FLOOR ITSELF, so a density can be worked out from a row rather than
   * re-derived by whoever reads it. `canWalk` is the same predicate the placer
   * uses to decide where a body may stand (`roomFor`), so "monsters per hundred
   * walkable tiles" compares like with like across a 34x30 ruin and a 50x50 cave.
   */
  let walkable = 0;
  for (let y = 0; y < realm.world.level.h; y += 1) {
    for (let x = 0; x < realm.world.level.w; x += 1) {
      if (canWalk(realm.world.level, x, y)) walkable += 1;
    }
  }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE FLOOR PAID IN LEVELS — the acceptance test for the whole density
   * question, and the one number nothing here has ever reported.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The author's ruling: *"the goal is to level up before encountering the boss
   * at the end. you are not meant to get to the end of the dungeon without
   * leveling at least twice."* A delve is a curve, so a row that says how many
   * bodies were in the room and not how much the room paid is answering half a
   * question.
   *
   * `arrivedAt` is read after the build and before the first turn; `level` here
   * is read after the last one. Both are the body's own field, written by
   * `awardExperience` and `forceLevelup`, so this is a report and not a second
   * opinion.
   */
  const levelIn = arrivedAt;
  const levelOut = bodies.map(({ body: b }) => b.level);
  const xpOut = bodies.map(({ body: b }) => b.xp);
  return {
    deaths,
    damage,
    levelIn,
    levelOut,
    xpOut,
    /** What each body is wearing at the end, so a descent can carry it down. */
    equippedOut: bodies.map(({ body: b }) => ({ ...b.equipped })),
    /** Levels gained by the body that gained the fewest — the honest floor. */
    levelsGained: Math.min(...levelOut.map((l, i) => l - (levelIn[i] ?? l))),
    unspentPoints: bodies.map(({ body: b }) => b.unspentPoints),
    /**
     * WHAT THE TURNS WERE SPENT ON. `moved` against `shot` is the walking share
     * of a floor, and it is the number that decides whether "more monsters"
     * costs clock time: bodies placed a stride apart are met one at a time with
     * a walk between each, and that walk is most of a delve.
     */
    orders: { ...tally },
    walkable,
    w: realm.world.level.w,
    h: realm.world.level.h,
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TABLE ONLY PRINTS WHEN THIS FILE IS THE ONE THAT WAS RUN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `run` is exported, and an export nobody may import without also running
 * twenty-seven delves twice is not an export. `import.meta.main` is Node's own
 * answer (24.2+, and this repo is on 24.19), so `node tools/delve-run.mjs`
 * prints exactly what it always printed and `import { run }` costs nothing.
 */
if (import.meta.main) {
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
}
