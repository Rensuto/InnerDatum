/**
 * HOW FAR IS A RESCUE, IN TURNS, AND HOW LONG DO YOU HAVE.
 *
 * The party pane now tells everyone that a member is Downed with N of 5 turns
 * left, where they are, and that you can follow. `handleFollow` crosses you into
 * the instance INSTANTLY and costs no delve turn — so the whole of the question
 * is the walk from the arrival tile to the body, and every step of that walk
 * pumps the delve, which is what ticks the clock.
 *
 * Prints, for every delve: the BFS distance from the arrival tile to each body
 * on the floor, against DOWNED_TURNS.
 */
import { createRealms, SITES } from '../src/server/world/realms.ts';
import { DOWNED_TURNS } from '../src/server/engine/downed.ts';
import { canWalk } from '../src/shared/level.ts';

const realms = createRealms({ seed: 'rescue-reach', engineFor: () => ({}) });

/** Eight-way BFS, because that is how a body walks here. */
function distances(level, from) {
  const key = (x, y) => y * level.w + x;
  const seen = new Map([[key(from.x, from.y), 0]]);
  let edge = [from];
  while (edge.length > 0) {
    const next = [];
    for (const cell of edge) {
      const d = seen.get(key(cell.x, cell.y));
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const x = cell.x + dx;
          const y = cell.y + dy;
          if (x < 0 || y < 0 || x >= level.w || y >= level.h) continue;
          if (!canWalk(level, x, y)) continue;
          if (seen.has(key(x, y))) continue;
          seen.set(key(x, y), d + 1);
          next.push({ x, y });
        }
      }
    }
    edge = next;
  }
  return { at: (x, y) => seen.get(key(x, y)) };
}

const rows = [];
for (const [id, def] of SITES) {
  if (def.kind !== 'inner') continue;
  const realm = realms.open(def, 'party:probe');
  if (realm === undefined) continue;
  const { world } = realm;
  // THE ARRIVAL TILE, which is where `crossIntoRealm` puts a follower and is
  // drawn to the player as "The way out".
  const spawn = realm.spawns[0] ?? {
    x: Math.floor(world.level.w / 2),
    y: Math.floor(world.level.h / 2),
  };
  const dist = distances(world.level, spawn);
  const found = [];
  for (const actor of world.allActors()) {
    if (actor.kind === 'player') continue;
    const d = dist.at(actor.x, actor.y);
    if (d !== undefined) found.push(d);
  }
  found.sort((a, b) => a - b);
  rows.push({
    id,
    n: found.length,
    min: found[0],
    med: found[Math.floor(found.length / 2)],
    max: found[found.length - 1],
  });
}

console.log(
  `DOWNED_TURNS = ${DOWNED_TURNS}. A follower arrives at the way out and walks from there.\n`,
);
console.log(
  '  delve                            bodies   nearest   median   furthest   reachable in 5?',
);
let reachable = 0;
let total = 0;
for (const r of rows) {
  total += 1;
  const ok = r.med !== undefined && r.med <= DOWNED_TURNS;
  if (ok) reachable += 1;
  console.log(
    `  ${r.id.replace('site:', '').padEnd(32)} ${String(r.n).padStart(5)} ${String(r.min).padStart(9)} ${String(r.med).padStart(8)} ${String(r.max).padStart(10)}   ${ok ? 'yes' : 'NO'}`,
  );
}
console.log(`\n  ${reachable} of ${total} delves have a MEDIAN body within the whole clock.`);
