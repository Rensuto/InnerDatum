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
import { CLASSES } from '../src/server/content/classes.ts';
import { ActorKind } from '../src/shared/protocol.ts';
import { canWalk } from '../src/shared/level.ts';
import { firstStep } from './walk.mjs';

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
  const realms = createRealms({
    seed,
    engineFor: (world) => createTurnEngine({ world, downed, effects }),
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
    bodies.push(p);
  }

  let turns = 0;
  let worst = 1;
  for (; turns < TURN_CAP; turns += 1) {
    const foes = realm.world.allActors().filter((a) => a.kind === ActorKind.Monster && a.alive);
    const up = bodies.filter((b) => b.alive && !isDowned(downed, b.id));
    if (foes.length === 0 || up.length === 0) break;

    for (const b of up) {
      const near = foes
        .filter((f) => f.alive)
        .map((f) => ({ f, d: Math.max(Math.abs(f.x - b.x), Math.abs(f.y - b.y)) }))
        .sort((x, y) => x.d - y.d)[0];
      if (near === undefined) break;
      // PATHFOUND, NOT STRAIGHT-LINE — see tools/walk.mjs.
      const dir =
        firstStep(
          (x, y) => canWalk(realm.world.level, x, y),
          { x: b.x, y: b.y },
          { x: near.f.x, y: near.f.y },
        ) ?? 'e';
      realm.engine.submitMove(b.id, dir);
    }
    realm.engine.pump();
    for (const b of bodies) worst = Math.min(worst, b.hp / b.maxHp);
  }

  const foesLeft = realm.world
    .allActors()
    .filter((a) => a.kind === ActorKind.Monster && a.alive).length;
  const downCount = bodies.filter((b) => !b.alive || isDowned(downed, b.id)).length;
  return {
    outcome: downCount === bodies.length ? 'wipe' : foesLeft === 0 ? 'clear' : 'stall',
    turns,
    worst,
    downCount,
  };
}

const delves = [...SITES.values()].filter((s) => s.kind === RealmKind.Inner);

for (const size of [1, 3]) {
  console.log(`\n${size === 1 ? 'ALONE' : 'A PARTY OF THREE'} — ${RUNS} runs each\n`);
  console.log(
    `${'delve'.padEnd(28)} ${'clear'.padStart(6)} ${'wipe'.padStart(5)} ${'stall'.padStart(5)}  ${'turns'.padStart(5)}  ${'hp low'.padStart(6)}  ${'downed'.padStart(6)}`,
  );
  for (const site of delves) {
    const rs = Array.from({ length: RUNS }, (_u, i) =>
      run(site, size, `delve-run:${site.id}:${size}:${i}`),
    );
    const clears = rs.filter((r) => r.outcome === 'clear');
    const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    console.log(
      `${site.name.padEnd(28)} ${`${clears.length}/${RUNS}`.padStart(6)} ` +
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
