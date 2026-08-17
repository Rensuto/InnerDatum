#!/usr/bin/env python3
"""
Build the Alderbrook region as an actual WORLD, not a diagram.

The first pass stamped ellipses of terrain and cut L-shaped roads between them.
Everything was reachable and none of it read as a place: hard blob edges, a
staircase coastline, roads that ignored the ground they crossed.

This models the region instead, in the order the real thing happens:

  1. ELEVATION      a mountain spine plus value noise, pulled down toward the
                    edges so the land is an actual landmass with a coast
  2. SEA            everything below sea level is water; deep water further out
  3. RIVERS         start high, walk DOWNHILL to the sea, carve as they go
  4. MOISTURE       distance from fresh water, so forests grow where they would
  5. BIOMES         from (elevation, moisture) -- not from a hand-drawn shape
  6. SETTLEMENTS    scored sites: flat, low, near water, spread apart
  7. ROADS          A* on a real cost field, so a road hugs a valley, climbs a
                    pass rather than a cliff, and fords at the narrows
  8. VERIFY         reachability, marooned cells, road connectivity

Deterministic: one seeded PCG-ish RNG, no system randomness, same output every
run. The output is frozen into src/shared/level.ts as authored data -- the game
never runs this.
"""

import math

W, H = 96, 64
SEED = 20260817


# ---------------------------------------------------------------------------
# A tiny deterministic RNG. Not the game's PCG32 -- this is offline tooling and
# its only contract is "same numbers every run on every machine".
# ---------------------------------------------------------------------------
class Rng:
    def __init__(self, seed): self.s = seed & 0xFFFFFFFF
    def next(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s
    def rand(self): return self.next() / 0x100000000
    def range(self, a, b): return a + self.next() % (b - a + 1)


rng = Rng(SEED)

# ---------------------------------------------------------------------------
# 1. ELEVATION
# ---------------------------------------------------------------------------
# Value noise: a coarse lattice of random values, bilinearly interpolated and
# summed over halving scales. Cheap, smooth, and enough for terrain.
def lattice(step):
    gw, gh = W // step + 2, H // step + 2
    return [[rng.rand() for _ in range(gw)] for _ in range(gh)]


def smooth(t): return t * t * (3 - 2 * t)


def sample(grid, step, x, y):
    gx, gy = x / step, y / step
    x0, y0 = int(gx), int(gy)
    fx, fy = smooth(gx - x0), smooth(gy - y0)
    a = grid[y0][x0] * (1 - fx) + grid[y0][x0 + 1] * fx
    b = grid[y0 + 1][x0] * (1 - fx) + grid[y0 + 1][x0 + 1] * fx
    return a * (1 - fy) + b * fy


octaves = [(24, 1.0), (12, 0.5), (6, 0.25), (3, 0.12)]
grids = [(lattice(s), s, amp) for s, amp in octaves]
TOTAL_AMP = sum(a for _, a in octaves)

elev = [[0.0] * W for _ in range(H)]
for y in range(H):
    for x in range(W):
        n = sum(sample(gr, st, x, y) * a for gr, st, a in grids)
        elev[y][x] = n / TOTAL_AMP

# THE SPINE. A ridge from the north-west to the centre-north, raised by distance
# to a poly-line. This is what gives the region one dominant range instead of
# noise-blobs of high ground scattered everywhere.
SPINE = [(8, 14), (20, 11), (32, 12), (44, 9), (54, 14)]


def dist_to_spine(x, y):
    best = 1e9
    for i in range(len(SPINE) - 1):
        (x0, y0), (x1, y1) = SPINE[i], SPINE[i + 1]
        dx, dy = x1 - x0, y1 - y0
        t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
        px, py = x0 + t * dx, y0 + t * dy
        best = min(best, math.hypot(x - px, y - py))
    return best


for y in range(H):
    for x in range(W):
        ridge = max(0.0, 1.0 - dist_to_spine(x, y) / 13.0)
        elev[y][x] += ridge ** 1.6 * 0.85

# THE COAST. Pull elevation down toward the south and east edges so the land
# ends in a sea rather than at the frame. Asymmetric on purpose: a landmass with
# one open coast reads as somewhere, a symmetric island reads as a logo.
for y in range(H):
    for x in range(W):
        ex = max(0.0, (x - 58) / 38.0)
        ey = max(0.0, (y - 34) / 30.0)
        falloff = (ex ** 1.5) * 0.55 + (ey ** 1.5) * 0.75
        # Keep the outer two cells firmly under water so the erased frame never
        # borders dry land.
        edge = min(x, y, W - 1 - x, H - 1 - y)
        if edge < 4:
            falloff += (4 - edge) * 0.30
        elev[y][x] -= falloff

lo = min(min(r) for r in elev)
hi = max(max(r) for r in elev)
for y in range(H):
    for x in range(W):
        elev[y][x] = (elev[y][x] - lo) / (hi - lo)

# ═══════════════════════════════════════════════════════════════════════════
# THRESHOLDS BY PERCENTILE, NOT BY ABSOLUTE HEIGHT.
# ═══════════════════════════════════════════════════════════════════════════
# The first attempt used fixed cut-offs (sea 0.34, hills 0.56, mountain 0.80)
# and produced a region that was 70% highland and had nine cells of sea: after
# the ridge is added and the field renormalised, the DISTRIBUTION of elevation
# is not something you can predict, so fixed numbers cut it in the wrong places.
#
# Percentiles cut it in the right places by construction. "The top 6% of the
# land is mountain" is true whatever the noise did, and the mix below is the mix
# the map will actually have.
_flat = sorted(v for row in elev for v in row)


def q(p):
    return _flat[min(len(_flat) - 1, int(p * len(_flat)))]


DEEP = q(0.10)   # open sea
SEA = q(0.20)    # water's edge -- a fifth of the frame is sea
SHORE = q(0.23)  # the beach
LOW = q(0.70)    # everything below is plains / forest / marsh by moisture
HILL = q(0.86)
CRAG = q(0.95)   # the top 5% is bare rock

# ---------------------------------------------------------------------------
# 3. RIVERS -- start high, always step to the lowest neighbour, stop at the sea.
# ---------------------------------------------------------------------------
river = [[False] * W for _ in range(H)]


def carve_river(sx, sy):
    x, y, path = sx, sy, []
    for _ in range(400):
        path.append((x, y))
        if elev[y][x] < SEA:
            break
        best, bx, by = elev[y][x], None, None
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx, ny = x + dx, y + dy
            if 2 <= nx < W - 2 and 2 <= ny < H - 2 and elev[ny][nx] < best:
                best, bx, by = elev[ny][nx], nx, ny
        if bx is None:
            # A basin. Nudge toward the sea rather than pooling forever.
            bx, by = x + (1 if x < W - 6 else -1), y + (1 if y < H - 6 else -1)
            if not (2 <= bx < W - 2 and 2 <= by < H - 2):
                break
        x, y = bx, by
    else:
        return False
    if len(path) < 12:
        return False
    for (px, py) in path:
        river[py][px] = True
        elev[py][px] = min(elev[py][px], SEA + 0.01)
    return True


sources = sorted(
    ((elev[y][x], x, y) for y in range(6, H - 8) for x in range(6, W - 8) if elev[y][x] > HILL),
    reverse=True,
)
made = 0
for _, sx, sy in sources:
    if made >= 4:
        break
    if any(river[sy + dy][sx + dx] for dy in range(-4, 5) for dx in range(-4, 5)
           if 0 <= sy + dy < H and 0 <= sx + dx < W):
        continue
    if carve_river(sx, sy):
        made += 1

# ---------------------------------------------------------------------------
# 4. MOISTURE -- BFS distance from fresh water, so woods grow near rivers.
# ---------------------------------------------------------------------------
INF = 10 ** 6
moist = [[INF] * W for _ in range(H)]
wet = []
for y in range(H):
    for x in range(W):
        if river[y][x] or elev[y][x] < SEA:
            moist[y][x] = 0
            wet.append((x, y))
head = 0
while head < len(wet):
    x, y = wet[head]; head += 1
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W and 0 <= ny < H and moist[ny][nx] == INF:
            moist[ny][nx] = moist[y][x] + 1
            wet.append((nx, ny))

# ---------------------------------------------------------------------------
# 5. BIOMES from (elevation, moisture). Nothing is hand-placed.
# ---------------------------------------------------------------------------
g = [['p'] * W for _ in range(H)]
for y in range(H):
    for x in range(W):
        e, m = elev[y][x], moist[y][x]
        if e < DEEP:
            g[y][x] = 'W'
        elif e < SEA:
            g[y][x] = 'w'
        elif e < SHORE:
            g[y][x] = 's'
        elif e >= CRAG:
            g[y][x] = 'M'
        elif e >= HILL:
            g[y][x] = 'c'
        elif e >= LOW:
            g[y][x] = 'h'
        # Below the hills the ground is decided by WATER, not height: marsh in
        # the wet hollows, forest along the rivers, plains beyond, heath where
        # nothing reaches. This is the half that makes the map look grown rather
        # than drawn.
        elif m <= 1 and e < q(0.32):
            g[y][x] = ';'
        elif m <= 5:
            g[y][x] = 'T'
        elif m <= 14:
            g[y][x] = 'p'
        else:
            g[y][x] = 'e'
for y in range(H):
    for x in range(W):
        if river[y][x] and elev[y][x] >= SEA:
            g[y][x] = 'w'

# ---------------------------------------------------------------------------
# 6. SETTLEMENTS -- scored, not placed. Flat, low, near water, well spread.
# ---------------------------------------------------------------------------
def flatness(x, y):
    vs = [elev[y+dy][x+dx] for dy in (-1,0,1) for dx in (-1,0,1)]
    return max(vs) - min(vs)


def near_water(x, y, r=3):
    return any(g[y+dy][x+dx] in 'wWs'
               for dy in range(-r, r+1) for dx in range(-r, r+1)
               if 0 <= y+dy < H and 0 <= x+dx < W)


cand = []
for y in range(6, H - 8):
    for x in range(6, W - 8):
        if g[y][x] not in 'peh':
            continue
        f = flatness(x, y)
        if f > 0.06:
            continue
        score = (0.6 - f) * 10 + (1.4 if near_water(x, y) else 0) - abs(elev[y][x] - 0.45) * 4
        cand.append((score, x, y))
cand.sort(reverse=True)

SITES_WANTED = [
    ('O', 'alderbrook'), ('R', 'threadneedle_row'), ('H', 'ashwick_row'),
    ('P', 'wayfarers_camp'), ('B', 'blackwood_outskirts'), ('F', 'gearford_ward'),
    ('G', 'glass_archive'), ('U', 'underworks'), ('A', 'watchers_altar'),
]
placed = []
for score, x, y in cand:
    if len(placed) >= len(SITES_WANTED):
        break
    if all(math.hypot(x - px, y - py) >= 17 for _, px, py in placed):
        placed.append((SITES_WANTED[len(placed)][0], x, y))

# The altar belongs in the range and the Underworks under the crags: move those
# two off the "nice flat spot" list onto terrain that means something.
def relocate(ch, want, near):
    best = None
    for y in range(4, H - 6):
        for x in range(4, W - 6):
            if g[y][x] != want:
                continue
            d = math.hypot(x - near[0], y - near[1])
            if best is None or d < best[0]:
                best = (d, x, y)
    if best:
        for i, (c, px, py) in enumerate(placed):
            if c == ch:
                placed[i] = (ch, best[1], best[2])


relocate('A', 'h', (30, 12))
relocate('U', 'h', (70, 26))

# ---------------------------------------------------------------------------
# 7. ROADS -- A* on a cost field, so a road follows the land.
# ---------------------------------------------------------------------------
import heapq

COST = {'p': 1.0, 'e': 1.2, 'h': 2.6, 's': 1.4, ';': 3.2, 'T': 4.0,
        'c': 9.0, 'M': 40.0, 'w': 7.0, 'W': 400.0}


# A LITTLE JITTER, so a road is surveyed rather than ruled.
# A* on a smooth cost field takes the cheapest line exactly, which on flat
# ground is a straight one -- the first pass produced roads running dead
# straight for forty cells, which reads as a pipeline and not a road. A fixed
# per-cell wobble (hashed from the coordinates, so it is stable across runs and
# across the two A* passes that may cross the same cell) makes the cheapest
# route bend slightly, exactly as a real road bends around things too small to
# see on a map.
_jitter = [[((x * 73856093) ^ (y * 19349663)) % 1000 / 1000.0 for x in range(W)] for y in range(H)]


def road_cost(x, y):
    base = COST.get(g[y][x], 2.0)
    return base + elev[y][x] * 2.0 + _jitter[y][x] * 0.9


def astar(a, b):
    (sx, sy), (tx, ty) = a, b
    seen = {(sx, sy): 0.0}
    prev = {}
    pq = [(0.0, sx, sy)]
    while pq:
        f, x, y = heapq.heappop(pq)
        if (x, y) == (tx, ty):
            path, cur = [], (tx, ty)
            while cur in prev:
                path.append(cur); cur = prev[cur]
            path.append((sx, sy)); path.reverse(); return path
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x + dx, y + dy
            if not (2 <= nx < W - 2 and 2 <= ny < H - 2):
                continue
            ng = seen[(x, y)] + road_cost(nx, ny)
            if ng < seen.get((nx, ny), 1e18):
                seen[(nx, ny)] = ng
                prev[(nx, ny)] = (x, y)
                heapq.heappush(pq, (ng + math.hypot(nx - tx, ny - ty), nx, ny))
    return None


# Minimum spanning tree over the settlements: every place connected, no
# redundant motorways, and the shape falls out of the terrain.
nodes = [(x, y) for _, x, y in placed]
inmst, out = {0}, set(range(1, len(nodes)))
edges = []
while out:
    best = None
    for i in inmst:
        for j in out:
            d = math.hypot(nodes[i][0]-nodes[j][0], nodes[i][1]-nodes[j][1])
            if best is None or d < best[0]:
                best = (d, i, j)
    _, i, j = best
    edges.append((i, j)); inmst.add(j); out.discard(j)

for i, j in edges:
    path = astar(nodes[i], nodes[j])
    if not path:
        continue
    for (x, y) in path:
        g[y][x] = '=' if g[y][x] in 'wW' else '.'

# ---------------------------------------------------------------------------
# 8. SETTLEMENT FOOTPRINTS, then the site cells, then the frame.
# ---------------------------------------------------------------------------
BIG = {'O', 'G'}
for ch, x, y in placed:
    if ch in ('A', 'U'):
        continue                      # a shrine and a stair have no town around them
    for dy in range(-2, 3):
        for dx in range(-3, 4):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and g[ny][nx] not in 'wW=':
                g[ny][nx] = ','
    roof = 'C' if ch in BIG else '#'
    for dy in (-2, -1):
        for dx in (-3, -2):
            g[y+dy][x+dx] = roof
        for dx in (2, 3):
            g[y+dy][x+dx] = roof

for ch, x, y in placed:
    g[y][x] = ch

rect_edge = lambda: None
for y in range(H):
    for x in range(W):
        if min(x, y, W-1-x, H-1-y) < 2:
            g[y][x] = 'X'

LEGEND = {
    '.': (True, 'road'), ',': (True, 'settlement approach'), 'p': (True, 'plains'),
    'h': (True, 'hills'), 'e': (True, 'heath'), 's': (True, 'shore'),
    ';': (True, 'marsh'), '~': (True, 'blighted'), '+': (True, 'rail'),
    '=': (True, 'bridge'), 'w': (False, 'river'), 'W': (False, 'sea'),
    'T': (False, 'forest'), 'M': (False, 'mountain'), 'c': (False, 'crag'),
    '#': (False, 'roofs'), 'C': (False, 'great roofs'), 'K': (False, 'works'),
    'X': (False, 'erased'),
}
for ch, _ in SITES_WANTED:
    LEGEND[ch] = (True, f'SITE {ch}')


def reachable(sx, sy):
    seen, st = {(sx, sy)}, [(sx, sy)]
    while st:
        x, y = st.pop()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < W and 0 <= ny < H and (nx,ny) not in seen and LEGEND[g[ny][nx]][0]:
                seen.add((nx,ny)); st.append((nx,ny))
    return seen


home = next((x, y) for ch, x, y in placed if ch == 'O')
for _ in range(12):
    reach = reachable(*home)
    pockets = [(x, y) for y in range(H) for x in range(W)
               if LEGEND[g[y][x]][0] and (x, y) not in reach]
    if not pockets:
        break
    for x, y in pockets:
        counts = {}
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < W and 0 <= ny < H and not LEGEND[g[ny][nx]][0]:
                counts[g[ny][nx]] = counts.get(g[ny][nx], 0) + 1
        g[y][x] = max(counts, key=counts.get) if counts else 'X'

ROWS = [''.join(r) for r in g]

if __name__ == '__main__':
    reach = reachable(*home)
    ok = True
    for ch, x, y in placed:
        hit = (x, y) in reach
        ok &= hit and LEGEND[g[y][x]][0]
        print(f'  {"ok  " if hit else "FAIL"} {ch} at {(x,y):}  on {LEGEND[g[y][x]][1]}')
    walk = sum(1 for y in range(H) for x in range(W) if LEGEND[g[y][x]][0])
    print(f'\n  {walk} walkable, {len(reach)} reachable, {walk-len(reach)} marooned')
    from collections import Counter
    print('  mix:', dict(Counter(c for r in ROWS for c in r).most_common()))
    print()
    for i, r in enumerate(ROWS):
        print(f'{i:2d} {r}')
    print('\nOK' if ok and walk == len(reach) else '\nFAIL')
