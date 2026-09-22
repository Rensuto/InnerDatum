// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// DOES A DELVE LEVEL YOU UP BEFORE IT PUTS A BOSS IN FRONT OF YOU?
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ THE RULING THIS TOOL IS THE ACCEPTANCE TEST FOR ═══
// *"the goal is to level up before encountering the boss at the end. you are not
// meant to get to the end of the dungeon without leveling at least twice. this
// is exactly like ToME does."*
//
// So a delve is a LEVELLING CURVE and not a flat difficulty, and every reading
// this directory has taken measured the flat one: `delve-density.mjs` grows a
// body to a floor's level, sends it in, and never asks what the floor PAID. It
// asks whether a level-9 character can clear the Hollow Mine's fourth floor; it
// cannot ask whether the character who walked into the FIRST floor is a level-9
// character by the time they get there, which is the only question the ruling is
// about.
//
// ═══ IT IS ONE CHARACTER, ALL THE WAY DOWN ═══
// `delve-run.mjs#run` builds a body from `level` and `xp` and reports both back,
// so a descent is a fold: floor 1's ending level and experience bar are floor 2's
// starting ones, and the paper doll is CARRIED rather than re-rolled — see the
// note on `opts.equipped`, because re-rolling it is what manufactured the gear
// cliff the balance readings kept finding at level 2.
//
// A FLOOR THAT IS NOT CLEARED ENDS THE RUN, and the row says where it stopped.
// A character who wipes on floor 1 does not meet the boss, and averaging them in
// as though they had would be reporting a career nobody has.
//
// Upstream's own intro does BOTH halves of this and it is worth saying which is
// which: `data/zones/reknor-escape/zone.lua:85-95` force-levels the player to 2
// on the second floor and 3 on the third (ported — `AuthoredMap.forceLevel`),
// AND its floors pay for 50-60 bodies each. The forced half is a floor under the
// curve, not the curve.
//
// Usage:
//   node tools/delve-climb.mjs [runs]                  every inner site
//   node tools/delve-climb.mjs 6 --only=undermost,hollow_mine
//   node tools/delve-climb.mjs 6 --only=infinity_tower --depth=20
//                                                  how deep to walk a site that
//                                                  has no bottom (default 4)
//   node tools/delve-climb.mjs 4 --at=1                start every delve at 1

import { SITES, RealmKind } from '../src/server/world/realms.ts';
import { CLASSES } from '../src/server/content/classes.ts';
import { delveLevel, floorsToWalk, specFor } from '../src/server/content/delve.ts';
import { run } from './delve-run.mjs';

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => !a.startsWith('-')) ?? 4);
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '');
/**
 * HOW DEEP TO WALK A SITE WITH NO BOTTOM.
 *
 * `floorsToWalk` caps at four, which is right for a default sweep and wrong for
 * the one probe most likely to be pointed at the Infinity Tower: without this
 * flag `--only=infinity_tower` stopped at floor 4 WITH NO MESSAGE, and the
 * floors worth measuring there start at about 5 (three dark mazes in a row) and
 * run to 40 (where the xp economy is tightest). A probe that cannot reach the
 * interesting floors of the one endless place is a probe with a hole in it.
 *
 * `floorsToWalk` already takes a cap; this is the flag that sets it.
 */
const DEPTH = Number((args.find((a) => a.startsWith('--depth=')) ?? '').replace('--depth=', ''));
const AT = args.find((a) => a.startsWith('--at='));
const SIZE = Number(
  (args.find((a) => a.startsWith('--size=')) ?? '--size=1').replace('--size=', ''),
);
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `--dress` — PICK THE FLOOR UP ON THE WAY DOWN. THE TWO BOUNDS, NOT ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This driver never picks anything up, so a descent carries the doll it started
 * with. For a delve entered at its own level that is nearly right — you walked
 * in dressed. For the TUTORIAL it is the harshest reading there is: you wake
 * wearing a lantern, and measured, floor 1 leaves 9.8 WEARABLE items on the
 * ground when it is cleared, against ten slots on the doll. A character who
 * climbs to floor 2 still in a lantern is a character who walked past all of it.
 *
 * So both bounds are printed rather than one being chosen:
 *
 *   default   the doll is carried. NOBODY PICKS ANYTHING UP — the floor of the
 *             range, and the honest reading for a delve entered dressed.
 *   --dress   the doll is re-rolled at each floor's own level, which is what
 *             `dressFor` does. EVERYTHING FITS AND EVERYTHING IS WORN — the
 *             ceiling of the range.
 *
 * The truth is between them and this probe cannot yet say where: equipping what
 * a floor dropped is a driver it does not have. Printing one number and calling
 * it the answer is how a bound becomes a fact.
 */
const DRESS = args.includes('--dress');

const sites = [...SITES.values()]
  .filter((s) => s.kind === RealmKind.Inner)
  .filter((s) => ONLY === '' || ONLY.split(',').some((frag) => s.id.includes(frag)));

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * ONE CHARACTER, ONE DELVE, TOP TO BOTTOM.
 *
 * THE FLOOR IS BUILT FOR THE PARTY, NOT FOR THE CHARACTER'S LEVEL. `strength`
 * carries the DELVE's own level rather than the body's, because `delveLevel`
 * reads it and a room that got harder every time you levelled inside it would
 * be a treadmill rather than a curve. `size` is the real party size, so
 * `delveHeadroom` applies exactly as it does in the game.
 */
function climb(site, cls, seed) {
  const spec = specFor(site.id);
  const start = AT === undefined ? Math.max(1, delveLevel(spec)) : Number(AT.replace('--at=', ''));
  // BOUNDED: `floorsOfSite` is upstream's `max_level`, and the Infinity
  // Tower's is a billion. See `floorsToWalk` in content/delve.ts, and `DEPTH`
  // above for reaching past the default cap on purpose.
  const floors =
    Number.isFinite(DEPTH) && DEPTH > 0 ? floorsToWalk(spec, DEPTH) : floorsToWalk(spec);
  let level = start;
  let xp = 0;
  let equipped;
  const perFloor = [];
  let stoppedAt = 0;
  for (let floor = 1; floor <= floors; floor += 1) {
    const r = run(site, SIZE, `${seed}:${String(floor)}`, {
      party: [cls],
      level,
      floor,
      xp,
      ...(equipped === undefined || DRESS ? {} : { equipped }),
      strength: { level: start, size: SIZE },
    });
    perFloor.push({
      floor,
      into: level,
      out: r.levelOut[0],
      outcome: r.outcome,
      roster: r.roster,
      worst: r.worst,
      // THE LIVES THIS FLOOR COST — `r.outcome` is 'clear' for a party that
      // lost members and pressed Respawn, so the descent carries on past a
      // floor that killed somebody. See `respawned` in delve-run.mjs.
      respawned: r.respawned,
    });
    level = r.levelOut[0];
    xp = r.xpOut[0];
    equipped = r.equippedOut[0];
    if (r.outcome !== 'clear') {
      stoppedAt = floor;
      break;
    }
  }
  return {
    start,
    floors,
    perFloor,
    stoppedAt,
    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * THE LEVEL STANDING IN FRONT OF THE LAST FLOOR — REACHED, NOT SURVIVED.
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * `perFloor.length >= floors` means the boss floor was ENTERED. It does not
     * mean it was cleared, and it must not: the ruling is *"you are not meant to
     * get to the end of the dungeon without levelling at least twice"*, which is
     * a question about the character who walks through that door, not about
     * whether they walk back out.
     *
     * THE STATISTIC USED TO BE CONDITIONED ON SURVIVING and that is exactly
     * backwards. The runs dropped were the ones that reached the boss and died
     * on it — which are precisely the UNDER-LEVELLED runs, the ones the ruling
     * exists to catch. It is also why `reached` is printed beside the ratio now:
     * a delve carried by one completed descent and a delve walked by four are
     * different claims and used to print the same way.
     *
     * ═══ AND IT CHANGES WHO IS COUNTED, NOT JUST HOW MANY ═══
     * Re-walked with reached-the-boss kept, four descents a class over the
     * twelve moor delves: the Inspector reaches the Undermost's boss floor 4
     * times in 4, at +3.3 levels each time, and completes ZERO of those
     * descents. Every one of those runs is a character who levelled exactly as
     * the ruling asks and then lost to the boss — the whole population the old
     * statistic threw away.
     */
    atBoss: perFloor.length >= floors ? perFloor[floors - 1].into : null,
    end: level,
  };
}

console.log(
  `\n${String(RUNS)} descents per class, one character all the way down, party of ${String(SIZE)}\n`,
);
console.log(
  `${'delve'.padEnd(24)} ${'fl'.padStart(2)} ${'class'.padEnd(12)} ${'in'.padStart(3)}` +
    ` ${'at boss'.padStart(7)} ${'out'.padStart(4)} ${'gained'.padStart(6)}` +
    ` ${'>=2 by boss'.padStart(11)} ${'reached'.padStart(7)} ${'full runs'.padStart(9)}` +
    ` ${'stopped on'.padStart(10)} ${'respawns'.padStart(8)}`,
);

for (const site of sites) {
  for (const cls of CLASSES) {
    const rs = Array.from({ length: RUNS }, (_u, i) =>
      climb(site, cls, `climb:${site.id}:${cls.id}:${String(i)}`),
    );
    const full = rs.filter((r) => r.stoppedAt === 0);
    // REACHED THE BOSS FLOOR — see `atBoss`. A run that got there and died there
    // is the under-levelled case and belongs in this statistic, not outside it.
    const reached = rs.filter((r) => r.atBoss !== null);
    const atBoss = reached.map((r) => r.atBoss ?? r.start);
    const twice = reached.filter((r) => (r.atBoss ?? r.start) - r.start >= 2).length;
    const stops = rs.filter((r) => r.stoppedAt > 0).map((r) => r.stoppedAt);
    console.log(
      `${site.name.slice(0, 24).padEnd(24)} ${String(rs[0].floors).padStart(2)}` +
        ` ${cls.name.slice(0, 12).padEnd(12)} ${String(rs[0].start).padStart(3)}` +
        ` ${(atBoss.length === 0 ? '-' : avg(atBoss).toFixed(1)).padStart(7)}` +
        ` ${(full.length === 0 ? '-' : avg(full.map((r) => r.end)).toFixed(1)).padStart(4)}` +
        ` ${(full.length === 0 ? '-' : avg(full.map((r) => r.end - r.start)).toFixed(1)).padStart(6)}` +
        ` ${(reached.length === 0 ? '-' : `${String(twice)}/${String(reached.length)}`).padStart(11)}` +
        ` ${`${String(reached.length)}/${String(RUNS)}`.padStart(7)}` +
        ` ${`${String(full.length)}/${String(RUNS)}`.padStart(9)}` +
        ` ${(stops.length === 0 ? '-' : `fl ${avg(stops).toFixed(1)}`).padStart(10)}` +
        // PER DESCENT, summed over its floors: 0.0 on every solo row, since a
        // lone body that is Erased has wiped the floor and stopped the climb.
        ` ${avg(rs.map((r) => r.perFloor.reduce((n, f) => n + f.respawned, 0)))
          .toFixed(1)
          .padStart(8)}`,
    );
  }
}
