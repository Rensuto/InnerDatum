// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The FORMAT is ported from t-engine4 game/modules/tome/data/maps/vaults/*.lua.
// The rooms below are original to Inner Datum; none of upstream's maps are used.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    THE ROOMS SOMEBODY ACTUALLY DREW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/vault.ts` is the format. This is the content, and it is deliberately
 * a very short list: a vault is worth having because it is RECOGNISED, and a
 * player recognises a room they have met three times, not one of forty they
 * have met once. Upstream ships hundreds because it has eighty zones to fill;
 * this has four shapes and needs a handful.
 *
 * ═══ THE ROOMS SAY SOMETHING THE NOISE CANNOT ═══
 * A cave generator makes caves. It cannot make a room that was BUILT and then
 * left, because that is a statement about people, and every one of these is
 * that statement in a different tense: a filing chamber with its door still on,
 * a partition that stops halfway, a shaft somebody walled off from the inside.
 *
 * ═══ NO ITEMS, NO MONSTERS, NO EXCEPTIONS ═══
 * Upstream's `defineTile` can carry object and actor filters. These carry
 * neither, and `shared/vault.ts` says why at length: rooms here are populated
 * by `content/delve.ts` from a weight, and a vault that also spawned things
 * would be a second answer to "what is in this room".
 */

import { TileCode } from './protocol.ts';
import { VaultTurn, defineVault } from './vault.ts';
import type { Vault } from './vault.ts';

/** `#` wall, `.` floor, and a SPACE is "leave whatever is already here". */
const LEGEND: Readonly<Record<string, number>> = {
  '#': TileCode.WALL,
  '.': TileCode.FLOOR,
};

/**
 * A FILING CHAMBER, with its door still on it.
 *
 * The one closed shape in the list, and the reason the format needed a
 * clearance at all: it reads as a room only if there is open ground around it.
 * The gap in the south wall is the door — a sealed box would be a room nobody
 * can enter, which `vaultFits` cannot prevent because it tests the OUTSIDE.
 */
const FILING_CHAMBER = defineVault(
  'vault:filing_chamber',
  ['#######', '#.....#', '#.###.#', '#.#...#', '#.#.###', '#.....#', '###.###'],
  LEGEND,
  { border: 1 },
);

/**
 * A PARTITION THAT STOPS HALFWAY.
 *
 * Open on every side, so it can never seal anything — it is a piece of cover in
 * the middle of a floor, which is the thing four generators of open ground are
 * worst at producing. The asymmetry is what makes the six orientations worth
 * having: turned, it is a different piece of cover.
 */
const HALF_PARTITION = defineVault(
  'vault:half_partition',
  [' ##### ', ' #   # ', ' #     ', '       '],
  LEGEND,
  { border: 1 },
);

/**
 * A SHAFT WALLED OFF FROM THE INSIDE.
 *
 * A dead end with a room at the end of it. The corridor is one tile wide on
 * purpose: it is the only shape here that makes a player commit to walking in,
 * and a fight in a one-tile corridor is a different fight.
 */
const SEALED_SHAFT = defineVault(
  'vault:sealed_shaft',
  ['#####', '#...#', '#...#', '##.##', ' #.# ', ' #.# ', ' # # '],
  LEGEND,
  { border: 1 },
);

/**
 * A COLLAPSED GALLERY.
 *
 * The only room here with no straight line in it. Caves are dug and then they
 * fall in, and a fall reads as a fall precisely because it is not square — the
 * three built rooms above cannot say this and the cave generator cannot either,
 * because noise makes texture rather than events.
 *
 * Open on both ends, so it is a passage that got worse rather than a dead end.
 */
const COLLAPSED_GALLERY = defineVault(
  'vault:collapsed_gallery',
  ['  ##   ', ' ##### ', '### ###', '##   ##', ' #  ## ', '  ###  '],
  LEGEND,
  { border: 1 },
);

/**
 * A SUMP — a small chamber hung off one side of nothing.
 *
 * Three walls and a mouth. It is the cheapest possible "somewhere to put a
 * thing", and that is the point: a floor needs a few places that are obviously
 * FOR something, or every corner reads the same and a player stops looking in
 * any of them.
 */
const SUMP = defineVault('vault:sump', ['####', '#  #', '#  #', '## #'], LEGEND, { border: 1 });

/**
 * A RUN OF SHELVING.
 *
 * Parallel walls with aisles between them — the one shape in the list that is
 * about SIGHT rather than about walls. An archive is dangerous because you
 * cannot see down the next aisle, and three parallel lines produce that in a way
 * a block of rock never does. It is also the shape the six orientations change
 * most: turned, the aisles run the other way and the whole approach changes.
 */
const SHELVING_RUN = defineVault(
  'vault:shelving_run',
  ['#######', '       ', '#######', '       ', '#######'],
  LEGEND,
  { border: 1 },
);

/**
 * A CLERK'S BOX — one wall with a gap in it, and nothing else.
 *
 * The smallest room in the list and the only one that is not a room at all: it
 * is a doorway with no building, which in a works reads as a partition somebody
 * put up and somebody else walked through. It exists because a floor with only
 * BIG set pieces has all its character in three places, and a small one can land
 * where none of the others fit.
 */
const CLERKS_BOX = defineVault('vault:clerks_box', ['##.##', '#   #', '#####'], LEGEND, {
  border: 1,
});

/**
 * WHICH ROOMS SUIT WHICH GROUND.
 *
 * A filing chamber in a cave would be a built room in a dug hole, and the point
 * of a vault is that it reads as deliberate — a room that contradicts the floor
 * around it reads as a bug instead. So the list is per shape, and `Town` has
 * none: a town is already all buildings, and a vault there would be a building
 * among buildings, which is noise with extra steps.
 */
export const VAULTS_BY_SHAPE: Readonly<Record<string, readonly Vault[]>> = {
  cave: [SEALED_SHAFT, HALF_PARTITION, COLLAPSED_GALLERY, SUMP],
  ruin: [HALF_PARTITION, FILING_CHAMBER, COLLAPSED_GALLERY, CLERKS_BOX],
  works: [FILING_CHAMBER, HALF_PARTITION, SEALED_SHAFT, SHELVING_RUN, CLERKS_BOX],
  town: [],
};

/** Every room, for the tests that must cover all of them. */
export const ALL_VAULTS: readonly Vault[] = [
  FILING_CHAMBER,
  HALF_PARTITION,
  SEALED_SHAFT,
  COLLAPSED_GALLERY,
  SUMP,
  SHELVING_RUN,
  CLERKS_BOX,
];

export { VaultTurn };
