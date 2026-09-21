// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// HOW FULL IS A FLOOR, AND WHO CAN WALK OUT OF IT — per floor, per class.
// ═══════════════════════════════════════════════════════════════════════════
//
// `delve-run.mjs` answers "can anybody clear these" for the first floor of each
// site, with one Watchman alone and one fixed party of three. Two questions it
// cannot answer sit behind the author's complaint that delves are "too easy per
// enemy and too little enemies":
//
//   HOW MANY BODIES PER UNIT OF FLOOR. A count means nothing without the ground
//   it is spread over. `nb_npc = {20, 30}` on ToME's 50x50 first tier
//   (data/zones/ruins-kor-pul/zone.lua:55) and our `monsters: [4, 6]` are not
//   comparable until both are divided by walkable tiles — and our sites are
//   upstream's level size now, so the floors are not the 34x30 the bands were
//   authored against either.
//
//   WHO. The party is three of the four classes and solo is always the
//   Watchman, so THE INSPECTOR HAS NEVER BEEN MEASURED ALONE and the Redactor
//   has never been measured at all. A difficulty reading taken from one melee
//   class is a reading about that class.
//
// ═══ IT DOES NOT OWN A DRIVER, AND THAT IS THE POINT ═══
// Everything about how a probe plays a character — the cooldown fall-through,
// the Euclidean band, the kiter, the rescue, the firing spot, the commitment,
// the lantern — was learned once, painfully, in `delve-run.mjs` and
// `fightlib.mjs`. This imports `run` from the first of those. A second copy of
// that loop would have to learn all of it again, and this repository has the
// scars to prove it does not.
//
// Usage:
//   node tools/delve-density.mjs [runs]            every inner site, floor 1
//   node tools/delve-density.mjs [runs] --floors   every floor of every site
//   node tools/delve-density.mjs [runs] --blind    the same, on the pre-lantern
//                                                  body, to show what the probe
//                                                  fix was worth
//   node tools/delve-density.mjs 4 --only=undermost,drowned_chapel
//   node tools/delve-density.mjs 4 --only=infinity_tower --floors --depth=20
//                                                  how deep to walk a site that
//                                                  has no bottom (default 4)
//
// ═══ A BEFORE AND AN AFTER MUST BE THE SAME INVOCATION, FLAGS INCLUDED ═══
// `delve-run.mjs#run` is deterministic per invocation and NOT hermetic across
// them. `shared/rng.ts` is one sequential PCG32 stream in which a label is
// documentation: `bounded` uses rejection sampling, so changing a band's span
// changes how many `u32`s that draw consumes and shifts every later draw from
// that seed. Measured: the same site, the same seed and the same band give a
// different floor inside a `--floors` sweep than inside `--only=<that site>`.
//
// So a comparison is only a comparison when BOTH sides ran with the identical
// site list and the identical flags. `--only` is for diagnosis, never for a
// before/after table — and a row that did not move between two full sweeps is
// evidence its band did not move, which is most of what such a table says.

import { SITES, RealmKind, createRealms, floorsOfSite } from '../src/server/world/realms.ts';
import { canWalk } from '../src/shared/level.ts';
import { createTurnEngine } from '../src/server/turn-engine.ts';
import { CLASSES } from '../src/server/content/classes.ts';
import {
  DELVES,
  delveHeadroom,
  delveLevel,
  nbNpcFor,
  floorsToWalk,
  specFor,
} from '../src/server/content/delve.ts';
import { run } from './delve-run.mjs';

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => !a.startsWith('-')) ?? 4);
const ALL_FLOORS = args.includes('--floors');
const BLIND = args.includes('--blind');
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '');
// HOW DEEP A SITE WITH NO BOTTOM IS WALKED under `--floors`. See the identical
// flag in `delve-climb.mjs` for why the default cap of four is a hole here.
const DEPTH = Number((args.find((a) => a.startsWith('--depth=')) ?? '').replace('--depth=', ''));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT LEVEL THE BODY IS, AND IT IS NOT 1.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `delve-run.mjs` defaults to a level-1 character everywhere, which is why its
 * far rows read 0/8: it measures Blackwood against somebody who has never left
 * town. `DelveSpec.levelRange` is the game's own statement of who a room is
 * for — *"the ladder is the walk"* — and `delveLevel` is what the placer feeds
 * `monsterInit`. So the body is grown to the level of the floor it is standing
 * on, and each row asks the only question worth asking of a delve: is this room
 * right for the people it was built for.
 *
 * The floor's own monsters are `delveLevel + floor - 1` (engine/Zone.lua:195),
 * and the body matches them. A player who descends is a level or so behind by
 * the last floor; matching is the generous reading, and generous is the side to
 * err on when the complaint is that it is too easy.
 */
function levelFor(spec, floor) {
  return Math.max(1, delveLevel(spec) + floor - 1);
}

const label = (site) =>
  site.id.startsWith('site:redaction:') ? `${site.name} (redacted)` : site.name;

const sites = [...SITES.values()]
  .filter((s) => s.kind === RealmKind.Inner)
  .filter((s) => ONLY === '' || ONLY.split(',').some((frag) => s.id.includes(frag)));

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROW: one class, alone, on one floor of one site, `RUNS` times.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SOLO, deliberately, for every class. A party row averages four classes into
 * one number and the complaint being measured is per-class — the Inspector
 * cannot shoot in a dark cave and the Watchman does not care, and a party of
 * both prints the mean of a fact and its opposite.
 *
 * THE SEED CARRIES THE CLASS, so two classes never fight the same seeded floor
 * and then get compared as though they had. They get the same DISTRIBUTION of
 * floors, which is the comparison that means something, and mixing them would
 * make every difference between two classes partly a difference between two
 * rooms.
 */
function rowFor(site, cls, floor) {
  const spec = specFor(site.id);
  const level = spec === undefined ? 1 : levelFor(spec, floor);
  const rs = Array.from({ length: RUNS }, (_u, i) =>
    run(site, 1, `density:${site.id}:${floor}:${cls.id}:${i}`, {
      party: [cls],
      level,
      floor,
      ...(BLIND ? { lantern: false } : {}),
    }),
  );
  const clears = rs.filter((r) => r.outcome === 'clear');
  return {
    level,
    roster: avg(rs.map((r) => r.roster)),
    walkable: avg(rs.map((r) => r.walkable)),
    per100: avg(rs.map((r) => (r.walkable === 0 ? 0 : (100 * r.roster) / r.walkable))),
    // TURNS OVER THE RUNS THAT FINISHED. A stall is the turn cap by definition,
    // so averaging it in reports the cap rather than the fight.
    turns: avg(clears.map((r) => r.turns)),
    damage: avg(rs.map((r) => r.damage)),
    worst: avg(rs.map((r) => r.worst)),
    deaths: avg(rs.map((r) => r.deaths)),
    wins: clears.length,
    wipes: rs.filter((r) => r.outcome === 'wipe').length,
    stalls: rs.filter((r) => r.outcome === 'stall').length,
  };
}

console.log(
  `\n${BLIND ? 'THE BLIND BODY (no lantern) — ' : ''}` +
    `${String(RUNS)} runs per class per floor, each class ALONE at the floor's own level\n`,
);
console.log(
  `${'delve'.padEnd(30)} ${'fl'.padStart(2)} ${'lvl'.padStart(3)} ${'class'.padEnd(11)}` +
    ` ${'foes'.padStart(5)} ${'walk'.padStart(5)} ${'per100'.padStart(6)}` +
    ` ${'win'.padStart(5)} ${'wipe'.padStart(4)} ${'stall'.padStart(5)}` +
    ` ${'turns'.padStart(5)} ${'dmg'.padStart(5)} ${'hp low'.padStart(6)} ${'deaths'.padStart(6)}`,
);

for (const site of sites) {
  // BOUNDED for the same reason `delve-climb.mjs` is: one site has no
  // bottom. See `floorsToWalk` in content/delve.ts.
  const spec = specFor(site.id);
  const deep = Number.isFinite(DEPTH) && DEPTH > 0;
  const floors =
    ALL_FLOORS && spec !== undefined ? (deep ? floorsToWalk(spec, DEPTH) : floorsToWalk(spec)) : 1;
  for (let floor = 1; floor <= floors; floor += 1) {
    for (const cls of CLASSES) {
      const r = rowFor(site, cls, floor);
      console.log(
        `${label(site).slice(0, 30).padEnd(30)} ${String(floor).padStart(2)}` +
          ` ${String(r.level).padStart(3)} ${cls.name.slice(0, 11).padEnd(11)}` +
          ` ${r.roster.toFixed(1).padStart(5)} ${r.walkable.toFixed(0).padStart(5)}` +
          ` ${r.per100.toFixed(2).padStart(6)}` +
          ` ${`${String(r.wins)}/${String(RUNS)}`.padStart(5)} ${String(r.wipes).padStart(4)}` +
          ` ${String(r.stalls).padStart(5)} ${r.turns.toFixed(0).padStart(5)}` +
          ` ${r.damage.toFixed(0).padStart(5)} ${`${String(Math.round(100 * r.worst))}%`.padStart(6)}` +
          ` ${r.deaths.toFixed(2).padStart(6)}`,
      );
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT THE BANDS THEMSELVES SAY, AGAINST THE ZONE EACH ONE IS A PORT OF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rows above are what a driver managed; this is what the TABLE promises,
 * and the two are different facts.
 *
 * ═══ `UPSTREAM` IS THE FLOOR'S ZONE, AND IT IS NOT THE TARGET ═══
 * Every moor delve's FLOOR is a named upstream zone, generator and level size
 * included (`shared/mapgen/zones.ts` cites each one at the top of the file).
 * `UPSTREAM` below is that zone's own `nb_npc`, read off the zone file with its
 * line. It used to be described here as "the honest target for a delve", and it
 * is not: `content/delve.ts` takes each count from a zone whose `level_range`
 * COVERS THE LEVEL WE PLACE THE DELVE AT, which is usually a different zone,
 * and the `countFrom` field on every spec is where that citation lives. The
 * column is kept because the ratio between the two is the alignment made
 * visible — Ardhungol states 70-80 for a character in the mid-twenties and the
 * Hollow Mine stands at nine.
 *
 * ═══ AND IT IS DIVIDED BY WALKABLE GROUND, NOT BY CELLS ═══
 * A count is meaningless without the floor it is spread over, and a 50x50
 * cavern and a 50x50 ruin do not have the same amount of ground in them. The
 * denominator here is the site's OWN generated floor, counted with `canWalk`.
 *
 * THAT DENOMINATOR IS OURS AND NOT UPSTREAM'S ON THE ROWS WHERE THE COUNT
 * MOVED. It was once claimed to be "one number, both rows", true while the
 * count came from the floor's own zone. The Hollow Mine's count is now the
 * Maze's and its floor is Ardhungol's Cavern, which walks about forty per cent
 * of its cells against a widen-2 Maze's fifty — so the `x` column there is a
 * ratio between two different rooms and reads about a fifth high. Said rather
 * than corrected: `delve.ts`'s note is where a count's ground is argued, and
 * the row to trust for OUR density is `per100`, which is measured.
 */
const UPSTREAM = new Map([
  ['site:drowned_chapel', ['halfling-ruins', 20, 30, 'data/zones/halfling-ruins/zone.lua:50']],
  ['site:underworks', ['orc-breeding-pit', 40, 50, 'data/zones/orc-breeding-pit/zone.lua:47']],
  ['site:barrow_end', ['old-forest', 20, 30, 'data/zones/old-forest/zone.lua:58']],
  ['site:cairnfoot', ['heart-gloom', 20, 30, 'data/zones/heart-gloom/zone.lua:76']],
  ['site:the_weir', ['lake-nur', 20, 25, 'data/zones/lake-nur/zone.lua:54']],
  ['site:watchers_altar', ['rhaloren-camp', 20, 30, 'data/zones/rhaloren-camp/zone.lua:53']],
  ['site:hollow_mine', ['ardhungol', 70, 80, 'data/zones/ardhungol/zone.lua:50']],
  ['site:outer_index', ['maze', 50, 60, 'data/zones/maze/zone.lua:160']],
  [
    'site:glass_archive',
    ['scintillating-caves', 12, 16, 'data/zones/scintillating-caves/zone.lua:53'],
  ],
  ['site:gearford_ward', ['infinite-dungeon', 29, 39, 'data/zones/infinite-dungeon/zone.lua:88']],
  ['site:blackwood_outskirts', ['trollmire', 20, 30, 'data/zones/trollmire/zone.lua:197']],
  // THE INTRO IS ESCAPE FROM REKNOR and `delve.ts` says so in the spec's own
  // comment. Its first two levels are 50-60 bodies; its LAST is a static map
  // with `nb_npc = {0, 0}` and a boss drawn on it — which is item 6's answer
  // and the reason this row is here at all.
  ['site:undermost', ['reknor-escape', 50, 60, 'data/zones/reknor-escape/zone.lua:50']],
]);

/** Walkable tiles and cells on floor 1 of this site, averaged over a few seeds. */
function groundOf(site) {
  let walk = 0;
  let cells = 0;
  const seeds = 3;
  for (let i = 0; i < seeds; i += 1) {
    // A WORLD IS ALL THIS NEEDS, and `createRealms` insists on an engine for
    // it. The cheapest honest one is the turn engine every other probe builds;
    // nothing here ever pumps it.
    const realms = createRealms({
      seed: `ground:${site.id}:${String(i)}`,
      engineFor: (world) => createTurnEngine({ world }),
    });
    const realm = realms.open(site, `ground:${site.id}:${String(i)}`);
    const { w, h } = realm.world.level;
    cells += w * h;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) if (canWalk(realm.world.level, x, y)) walk += 1;
    }
  }
  return { walk: walk / seeds, cells: cells / seeds };
}

console.log(
  `
THE BAND EACH DELVE PLACES, AGAINST THE ZONE ITS FLOOR IS BUILT FROM

The two differ now and they are meant to: a count comes from a zone whose
level_range covers the level we place the delve at (DelveSpec.countFrom), and
the 'upstream zone' column below is the zone the FLOOR came from. A ratio away
from 1.0 is the alignment, not a divergence.
`,
);
console.log(
  `${'delve'.padEnd(26)} ${'band'.padStart(6)} ${'x3'.padStart(6)} ${'lvl'.padStart(3)}` +
    ` ${'fl'.padStart(2)} ${'cells'.padStart(5)} ${'walk'.padStart(5)} ${'per100'.padStart(6)}` +
    `  ${'upstream zone'.padEnd(20)} ${'nb_npc'.padStart(6)} ${'per100'.padStart(6)} ${'x'.padStart(5)}`,
);
for (const [id, spec] of DELVES) {
  const site = SITES.get(id);
  if (site === undefined) continue;
  const g = groundOf(site);
  // THE BAND THE PLACER USES — `nbNpcFor`: the sourced zone's own `nb_npc`,
  // verbatim, with this site's real cell count for the one zone that reads it.
  // `spec.monsters` is gone; `spec.nbNpc` is the sourced zone's raw statement.
  const band = nbNpcFor(spec, 1, g.cells);
  const mine = (100 * (band[0] + band[1])) / 2 / g.walk;
  const up = UPSTREAM.get(id);
  const theirs = up === undefined ? 0 : (100 * (up[1] + up[2])) / 2 / g.walk;
  console.log(
    `${label(site).slice(0, 26).padEnd(26)}` +
      ` ${`${String(band[0])}-${String(band[1])}`.padStart(6)}` +
      ` ${`${String(Math.round(band[0] * delveHeadroom({ level: 1, size: 3 })))}-${String(
        Math.round(band[1] * delveHeadroom({ level: 1, size: 3 })),
      )}`.padStart(6)}` +
      ` ${String(delveLevel(spec)).padStart(3)} ${String(floorsOfSite(id)).padStart(2)}` +
      ` ${g.cells.toFixed(0).padStart(5)} ${g.walk.toFixed(0).padStart(5)} ${mine.toFixed(2).padStart(6)}` +
      `  ${(up === undefined ? '-' : up[0]).padEnd(20)}` +
      ` ${(up === undefined ? '-' : `${String(up[1])}-${String(up[2])}`).padStart(6)}` +
      ` ${theirs.toFixed(2).padStart(6)} ${(mine === 0 ? 0 : theirs / mine).toFixed(1).padStart(5)}`,
  );
}
