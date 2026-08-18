/**
 * ONE PATHFINDER, SHARED BY EVERY TOOL THAT HAS TO GET SOMEWHERE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * Every driver in tools/ walked in straight lines, and it produced false
 * negatives in all of them for five passes running:
 *
 *   `first-session.mjs` reported "the first fight never happens" four times.
 *   `first-fight.mjs` reports 3 stalls in 16 and calls them the driver.
 *   `delve-run.mjs` reports whole delves as unclearable.
 *
 * None of those were the game. A straight-line walker pins itself against the
 * first wall between it and its target and never arrives — and in a carved
 * cave, which is what an arena and half the delves are, that is most of the
 * time. Flood-filling forty arena seeds finds ZERO unreachable floor: the rooms
 * were always fine.
 *
 * A stall in a balance table is not a neutral gap. It reads as "this room could
 * not be finished", and it silently drops the hardest runs — the ones that go
 * long — out of every average beside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT ASKS THE GAME WHAT IS WALKABLE
 * ═══════════════════════════════════════════════════════════════════════════
 * An earlier copy of this hard-coded "TileCode 0 is WALL". FLOOR is 0 and WALL
 * is 1 — exactly backwards — so it routed through walls and refused open floor.
 * A second opinion about walkability is precisely the thing that must not
 * exist, so callers pass the real predicate in.
 */

/** Eight-way, in a fixed order so a tie is broken the same way every run. */
export const STEPS = [
  [0, -1, 'n'],
  [1, -1, 'ne'],
  [1, 0, 'e'],
  [1, 1, 'se'],
  [0, 1, 's'],
  [-1, 1, 'sw'],
  [-1, 0, 'w'],
  [-1, -1, 'nw'],
];

/**
 * The first step of a shortest path from `from` to `to`, or null when there is
 * no route at all.
 *
 * @param walkable (x, y) => boolean. THE GAME'S OWN, never a copy.
 *
 * THE TARGET TILE IS NEVER TREATED AS BLOCKED, because stepping onto an
 * occupied tile is how you attack and how you walk into a roamer. Refusing it
 * would make every enemy unreachable by construction, which is the shape of
 * bug this whole file exists to stop reporting.
 */
export function firstStep(walkable, from, to) {
  if (from.x === to.x && from.y === to.y) return null;
  const key = (x, y) => `${x},${y}`;
  const prev = new Map([[key(from.x, from.y), null]]);
  const queue = [from];
  let head = 0;
  let found = false;
  while (head < queue.length) {
    const c = queue[head];
    head += 1;
    if (c.x === to.x && c.y === to.y) {
      found = true;
      break;
    }
    for (const [dx, dy] of STEPS) {
      const x = c.x + dx;
      const y = c.y + dy;
      if ((x !== to.x || y !== to.y) && !walkable(x, y)) continue;
      if (prev.has(key(x, y))) continue;
      prev.set(key(x, y), c);
      queue.push({ x, y });
    }
  }
  if (!found) return null;
  let cur = to;
  for (;;) {
    const back = prev.get(key(cur.x, cur.y));
    if (back === null || back === undefined) return null;
    if (back.x === from.x && back.y === from.y) break;
    cur = back;
  }
  const dir = STEPS.find(([dx, dy]) => from.x + dx === cur.x && from.y + dy === cur.y);
  return dir === undefined ? null : dir[2];
}
