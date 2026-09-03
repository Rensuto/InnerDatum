/**
 * HOW HARD IS THE FIRST FIGHT? Ask the game, not a feeling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A TOOL AND NOT A TEST
 * ═══════════════════════════════════════════════════════════════════════════
 * A test asserts a number and fails when it moves. Difficulty is not that kind
 * of fact: it is meant to move, repeatedly, and the useful question is not "is
 * it 94%" but "what is it now, and is that what we wanted". A test pinning a
 * win rate would either be so loose it proves nothing or so tight that every
 * balance change is a test edit — which is how a suite stops being believed.
 *
 * So this prints, and a human reads it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT EXISTS BECAUSE I GOT THE ANSWER WRONG BY GUESSING A FIELD NAME
 * ═══════════════════════════════════════════════════════════════════════════
 * A throwaway script set `p.combat = sheetForClass(cls)` — which returns the
 * TALENT sheet, not the combat sheet — and reported that the opening ambush was
 * won with 95% of health left. The conclusion happened to survive being
 * measured properly, but it was luck: the body under test had no weapon, no
 * armour and no defence, and every number that came out of it was about a
 * character that does not exist.
 *
 * A named tool in the repo, with the sheet wired once and correctly, is how
 * that stops being re-discovered. `ClassDef.combat` is the combat sheet.
 * `sheetForClass` is the talent sheet. They are different things and both are
 * called "sheet".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT CANNOT TELL YOU
 * ═══════════════════════════════════════════════════════════════════════════
 * The driver SHOOTS — it has since the dead zone was understood — and it now
 * walks to a tile it could shoot from when a wall is in the way. What it still
 * cannot tell you is how a class plays with points spent: the body is always
 * level 1 (see `LEVEL`), and nothing here spends a talent point.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT ONCE TOLD ME, CONFIDENTLY, AND WRONGLY
 * ═══════════════════════════════════════════════════════════════════════════
 * Three separate readings of this tool have been wrong ABOUT THE INSPECTOR
 * specifically, because it is the only class whose kit interacts with geometry:
 *
 *   1. "0/24, 24 stalls" — the driver bump-attacked and could not play a gun.
 *   2. "23 turns to kill one monster" — the `turns` column averaged two stalls
 *      at the 200-iteration cap in with the wins. Its real winning fight is 6.
 *      That number reached a planning document as a balance problem.
 *   3. The two stalls behind (2) — the band was a Chebyshev square that ignored
 *      walls, so a foe behind one counted as a shot and the driver paced
 *      between two tiles for 200 iterations.
 *
 * Every one of those read as a fact about the class. None of them was. When a
 * column here disagrees with the other three classes by a factor, suspect this
 * file first: the dead zone makes The Inspector the canary for every geometry
 * bug the driver has.
 *
 * Usage:  node tools/first-fight.mjs [runs] [ground] [room-level]
 */

import { createRealms, ENCOUNTER_SITE } from '../src/server/world/realms.ts';
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
import { canWalk, Ground } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';
import { firingSpot, rangedAttacks, takeShot } from './fightlib.mjs';

/** Enough that one lucky seed cannot carry a column. */
const RUNS = Number(process.argv[2] ?? 24);

/**
 * WHICH GROUND THE AMBUSH HAPPENS ON — `node tools/first-fight.mjs 24 wood`.
 *
 * Six kinds of country now build six different rooms AND two of them put
 * something extra in the room. "Is the first fight fair" therefore has six
 * answers, and the two that matter most are the ones a level-1 stranger can
 * wander into without being warned: the wood, which is a corridor system with
 * something fast in it, and the fen, which has a turret behind water.
 *
 * Defaults to the ground the game has always built, so running it bare compares
 * against every number anybody has written down before today.
 */
const GROUND = process.argv[3] ?? Ground.Upland;
/** Long enough for a slow win, short enough that a stall is obvious. */
/**
 * WHICH LEVEL THE PARTY IS — `node tools/first-fight.mjs 24 upland 3`.
 *
 * One point is not a curve. The opening reads as safe for two classes of three,
 * and "safe at level 1" and "safe forever" are different findings with different
 * answers: the first is a deliberate on-ramp, the second is a game that never
 * threatens anybody. `seedAmbush` scales its roster with `PartyStrength`, so this
 * is the knob that shows which one is true.
 *
 * ═══ IT SCALES THE ROOM ONLY. THE BODY IS ALWAYS LEVEL 1. ═══
 * This number reaches `realms.open` and nothing else. The character is whatever
 * `sheetForClass(cls)` builds — four birth talents, no points spent, base stats,
 * base hp — at every value of this argument. So `first-fight 24 upland 8` is a
 * LEVEL-1 BODY IN A LEVEL-8 ROOM.
 *
 * That is a legitimate question ("how far can an unlevelled character walk
 * before the world kills them") and it is NOT the question the paragraph above
 * claims to answer, which needs the party to grow too. No probe in `tools/`
 * levels a character; every one of them calls `sheetForClass` and stops. Reading
 * a high row here as "the endgame is too easy" would be reading it backwards.
 */
const LEVEL = Number(process.argv[4] ?? 1);

const TURN_CAP = 200;

/** One fight, driven the way somebody who has never played would drive it. */
function fight(cls, seed) {
  const downed = createDownedState();
  // ONE PER RUN, like the server's: it holds the sheets, and a fresh one per
  // world would hand every character a full bar on every frame.
  const talentEngine = createContentTalentEngine();
  // THE STATUS TABLE. Without it the Overwritten Husk's bleed never lands and
  // this tool measures a fight the game does not have.
  const effects = createMvpEffectState();
  const realms = createRealms({
    seed,
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WITH THE TALENTS WIRED IN, WHICH THEY WERE NOT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This probe built its engine as `createTurnEngine({ world, downed, effects })`
     * with NO `talents` option — so the book defaulted to `EMPTY_TALENT_BOOK`,
     * whose entire body is `loadoutOf: () => []`. Every measurement this tool has
     * ever printed was taken in a game where NO CLASS HAD ANY TALENTS.
     *
     * src/server/main.ts carries the same mistake as a warning, because the real
     * server had it first: *"Three files of finished content, wired to nothing."*
     * It was fixed there and the probe kept the broken copy, which is worse than
     * never having measured — the Watchman's 24/24 read as a statement about the
     * opening fight and was a statement about punching.
     */
    engineFor: (world) =>
      createTurnEngine({
        world,
        downed,
        effects,
        talents: createTalentBook(talentEngine, world),
        talentRuntime: talentRuntimeFor(talentEngine, world),
      }),
  });
  const arena = realms.open(ENCOUNTER_SITE, seed, { level: LEVEL, size: 1 }, GROUND);

  const p = arena.world.addPlayer('p1', 'Ren');
  // THE SHEET IS WHAT MAKES THE BOOK ANSWER. `createTalentBook` reads a per-actor
  // sheet; without one, `loadoutOf` is empty and every talent is refused as "no
  // such talent in this loadout" — which is exactly what The Inspector got.
  // HELD, NOT JUST HANDED OVER: `rangedAttacks` needs to know which of the
  // class's talents this body has actually learned. See that function.
  const sheet = sheetForClass(cls);
  talentEngine.attach('p1', sheet);
  // THE COMBAT SHEET. See the header — this one line is the whole reason the
  // tool exists.
  p.combat = cls.combat;
  p.baseCombat = cls.combat;
  p.maxHp = cls.maxHp;
  p.hp = cls.maxHp;
  p.hpRegen = cls.hpRegen;
  arena.engine.join('p1');
  arena.engine.setConnected('p1', true);

  /**
   * Every shot this class owns, longest first — and `fightlib.mjs` owns the two
   * rules that were learned here the hard way: melee is 1.5 rather than 1, and
   * a cooldown must fall through to the next weapon rather than end the turn.
   * `delve-run.mjs` needs both, and two copies of a rule is how one of them
   * stops being true.
   */
  // RANK 1 IS "LEARNED"; the engine's own test is `getTalentLevelRaw >= 1`
  // (`TalentRefusal.NotLearned`), so this reads the same map it does.
  const attacks = rangedAttacks(
    cls,
    new Set([...sheet.points].filter(([, rank]) => rank >= 1).map(([id]) => id)),
  );

  // HOW MANY WERE ACTUALLY IN THERE. `seedAmbush`'s own note says "exactly one
  // monster in the room" at level 1, which is a claim worth printing rather than
  // trusting — `first-session.mjs` has met two.
  const roster = arena.world.allActors().filter((a) => a.kind === 'monster').length;

  let turns = 0;
  let worst = 1;
  for (; turns < TURN_CAP; turns += 1) {
    const foes = arena.world.allActors().filter((a) => a.kind === 'monster' && a.alive);
    if (foes.length === 0 || !p.alive || isDowned(downed, 'p1')) break;
    const near = foes
      .map((f) => ({ f, d: Math.max(Math.abs(f.x - p.x), Math.abs(f.y - p.y)) }))
      .sort((a, b) => a.d - b.d)[0];
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SHOOT IF YOU CAN SHOOT. A BUMP DRIVER CANNOT PLAY A GUNMAN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This printed `0/24, 24 stalls` for The Inspector and explained it away in
     * its own footer — "a stall is this driver, not the class". True, and it
     * meant A THIRD OF THE ROSTER HAD NEVER BEEN MEASURED AT ALL. The Inspector
     * is the one class whose defining trait is a DEAD ZONE (`minRange: 3`,
     * which game-design.md calls "the single most important thing" about it),
     * so the one class the driver could not play is the one whose opening fight
     * is least predictable.
     *
     * A player with a revolver does not walk up and hit somebody with it. So
     * the driver now asks, in order: can I shoot this from here — am I too
     * close and should back off — otherwise close the distance.
     */
    const { fired: acted, gap: shootableGap } = takeShot(
      arena.engine,
      'p1',
      attacks,
      p,
      foes,
      (id, shot) => {
        if (process.env.FIGHT_DIAG === '1' && turns < 6) {
          console.log(`  [diag] ${cls.name} ${id}: ${JSON.stringify(shot)}`);
        }
      },
      // THE LEVEL, so the band can ask about walls. Without it `takeShot` counted
      // a foe behind a wall as a shot and this driver never backed off.
      arena.world.level,
    );
    const gap = near.d;
    const nearest = attacks[attacks.length - 1] ?? null;

    if (!acted) {
      /**
       * BACKING OFF IS PART OF THE CLASS, not a fallback. Inside the dead zone a
       * revolver is useless and the only correct move is a step away — which is
       * exactly the decision the dead zone exists to force.
       */
      // Inside the dead zone of the SHORTEST-ranged shot is the only case where
      // backing off is the whole answer; `shootableGap` being null means nothing
      // at all was in a band this turn.
      const away = nearest !== null && shootableGap === null && gap < nearest.minRange;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * WALK TO SOMEWHERE YOU CAN SHOOT FROM. The third option, and the one
       * whose absence was the whole of The Inspector's stall.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * "Close" and "back off" are both moves along the line to the foe, so
       * neither can answer a WALL — and a class with a dead zone spends its life
       * at exactly the distance where a wall is the difference between a shot and
       * nothing. Seeds 11 and 13 paced between 2.24 and 3.61 tiles for all 200
       * iterations of the cap. See `fightlib.mjs#firingSpot` for the log.
       *
       * It goes FIRST because it is strictly better informed than the other two:
       * it only answers when a real tile exists with a real shot from it. When it
       * answers `null` — nothing within six tiles works — the old two-way choice
       * is still the right fallback.
       */
      const spot = away
        ? null
        : firingSpot(attacks, p, foes, arena.world.level, (x, y) =>
            canWalk(arena.world.level, x, y),
          );
      const goal =
        spot !== null
          ? spot
          : away
            ? { x: p.x + Math.sign(p.x - near.f.x), y: p.y + Math.sign(p.y - near.f.y) }
            : { x: near.f.x, y: near.f.y };
      // PATHFOUND, NOT STRAIGHT-LINE. See tools/walk.mjs: a straight-line walker
      // pins itself on the first wall and reports the room as unclearable.
      const dir =
        firstStep((x, y) => canWalk(arena.world.level, x, y), { x: p.x, y: p.y }, goal) ?? 'e';
      arena.engine.submitMove('p1', dir);
    }
    arena.engine.pump();
    worst = Math.min(worst, p.hp / p.maxHp);
  }

  const left = arena.world.allActors().filter((a) => a.kind === 'monster' && a.alive).length;
  const down = !p.alive || isDowned(downed, 'p1');
  return {
    outcome: down ? 'down' : left === 0 ? 'win' : 'stall',
    roster,
    turns,
    hp: p.hp / p.maxHp,
    // THE LOW-WATER MARK IS THE INTERESTING NUMBER. Ending on 94% can mean a
    // fight that never threatened you OR one you nearly lost and regenerated
    // out of, and those are opposite reports about the same encounter.
    worst,
  };
}

console.log(`the opening ambush at level ${String(LEVEL)}, ${RUNS} runs per class\n`);
console.log(
  `${'class'.padEnd(30)} ${'won'.padStart(7)} ${'down'.padStart(5)} ${'stall'.padStart(5)}  ${'foes'.padStart(4)}  ${'turns/win'.padStart(9)}  ${'hp end'.padStart(6)}  ${'hp low'.padStart(6)}`,
);

for (const cls of CLASSES) {
  const results = Array.from({ length: RUNS }, (_unused, i) =>
    fight(cls, `first-fight:${cls.id}:${i}`),
  );
  const wins = results.filter((r) => r.outcome === 'win');
  const downs = results.filter((r) => r.outcome === 'down').length;
  const stalls = results.filter((r) => r.outcome === 'stall').length;
  const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  console.log(
    `${cls.name.padEnd(30)} ${`${wins.length}/${RUNS}`.padStart(7)} ${String(downs).padStart(5)} ${String(stalls).padStart(5)}  ` +
      `${avg(results.map((r) => r.roster))
        .toFixed(1)
        .padStart(4)}  ` +
      `${String(Math.round(avg(wins.map((r) => r.turns)))).padStart(9)}  ` +
      `${`${Math.round(100 * avg(wins.map((r) => r.hp)))}%`.padStart(6)}  ` +
      `${`${Math.round(100 * avg(wins.map((r) => r.worst)))}%`.padStart(6)}`,
  );
}

console.log(
  `\nhp low is the LOW-WATER MARK across the fight. A high "hp end" with a high\n` +
    `"hp low" is an encounter that never threatened anybody; a high "hp end" with\n` +
    `a low "hp low" is one that did and was regenerated out of afterwards.\n\n` +
    `EVERY AVERAGE HERE IS OVER THE WINS, and the column says so now. It used to\n` +
    `say "turns" and average the STALLS IN TOO, at the 200-iteration cap, while\n` +
    `the two hp columns beside it were already wins-only. Two stalls out of 24\n` +
    `therefore printed The Inspector as 23 turns when its winning fights took 7.2,\n` +
    `and that number was written down and nearly acted on as a balance problem.\n` +
    `The Inspector is in fact the second-fastest opener of the four. A mean over a\n` +
    `capped failure is not a duration, it is the cap.\n\n` +
    `A stall is still this driver rather than the class, and the two that were\n` +
    `left had one cause: "close" and "back off" are both moves along the line to\n` +
    `the foe, so neither answers a WALL. The driver now walks to a tile it could\n` +
    `actually shoot from (fightlib.mjs#firingSpot), and the band it asks about is\n` +
    `the engine's -- Euclidean, line of sight included -- rather than a Chebyshev\n` +
    `square that called a foe 7.07 tiles away a shot.\n\n` +
    `THE LEVEL ARGUMENT SCALES THE ROOM, NOT THE PARTY. seedAmbush grows its\n` +
    `roster, and the body stays exactly the level-1 character sheetForClass\n` +
    `builds -- no points spent, no stats grown. So "first-fight 24 upland 8" is a\n` +
    `level-1 body in a level-8 room, which is a real question but not the one the\n` +
    `argument's name implies. Levelling the body is not built yet.`,
);
