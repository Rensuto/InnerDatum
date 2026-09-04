// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from
//   t-engine4 game/modules/tome/data/general/grids/burntland.lua:64-71 ("ALTAR" — a FLOOR
//              grid whose base `image` is the ground it sits on and whose pentagram rides
//              as `add_displays`, blocking neither movement nor sight)
//   t-engine4 game/engines/default/engine/Map.lua (`add_displays` — the second draw on one
//              cell, which is the shape this file exists to express)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRESSING. A picture on a floor tile that changes nothing about the floor.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six prop sprites were cut for this game and none of them could be shown,
 * because there was no way to say "this cell also draws that". These three are
 * the ones that need nothing else to be true.
 *
 * ═══ WHY THIS IS NOT A `TileCode`, WHICH IS THE OBVIOUS ANSWER ═══
 * Upstream's props ARE grids and ours are not, and the difference is ours
 * rather than ToME's:
 *
 *   ONE CELL IS ONE CODE AND ONE PICTURE. `paintTerrain` scales a tile sprite
 *   to exactly `TILE_PX` square at the cell origin and says so —
 *   *"NO BOTTOM-CENTRE ANCHOR EITHER. A terrain tile is exactly TILE_PX square
 *   ... a ground tile that overflowed anywhere would tear the grid."* A code
 *   also carries the FLOOR's appearance, so "sigil on soot" and "sigil on
 *   plains" would be two codes, not one.
 *
 *   AND TWO SHIPPED TESTS REFUSE A THIRD CODE. `sitemap.test.ts` asserts a
 *   finished grid holds exactly the two codes it was given — *"a third code
 *   appearing in a finished grid would be a bug in the carvers"* — quantified
 *   over every shape and palette, so it is a rule test and not a fixture.
 *
 * Upstream reaches the same place by a different road: its ALTAR is a FLOOR
 * grid and the pentagram is an `add_displays` — a SECOND DRAW on the cell, with
 * the floor underneath unchanged. That is what a `PropView` is.
 *
 * ═══ WHAT THE ART'S OWN METADATA ASKS FOR, AND WHAT BECOMES OF IT ═══
 * Each PNG ships a `.meta.json` — and NOTHING READS IT. `build_asset_manifest.py`
 * keeps id, path, w, h and provenance; `render/assets.ts` keeps the first four.
 * Every gameplay fact in those files exists only if it is re-declared here, so
 * the fields are listed rather than assumed:
 *
 *   sprite_envelope_px   KEPT, as `envelope`. Asserted against the manifest.
 *   footprint_tiles      1x1 ONLY, and a bigger one throws below. A multi-cell
 *                        prop needs an occupancy rule this game has nowhere to
 *                        put, and truncating one silently is how a two-tile
 *                        brazier becomes half a brazier nobody can explain.
 *   anchor               NOT PORTED IN THIS SLICE. All three below are 64x64 on
 *                        a 64-pixel tile, so bottom-centre and cell-origin are
 *                        the same pixel. The 64x96 brazier is what needs it.
 *   z_layer              NOT PORTED. Draw order here is the painter's, and it is
 *                        one line in `canvas.ts` rather than a number per prop.
 *   blocks_movement      DECLARED and asserted FALSE for all three. It is the
 *                        line between this slice and the next: the three props
 *                        that block are held back rather than shipped inert.
 *   blocks_los           NOT PORTED — nothing here blocks sight, so there is no
 *                        channel to write and no prop that wants one.
 *   cover_level          NOT PORTED. There is no cover system; all three are 0.
 *   destructible/max_hp  NOT PORTED. Nothing can damage terrain or dressing, and
 *                        all three are `false`/`0`.
 *   light_radius_cells   NOT PORTED, AND NOT PORTABLE. There is no light system
 *                        — `overseer_of_nations.ts` names the same absence for
 *                        `esight`. All three are 0.
 *   movement_cost_mult   NOT PORTED. There is no per-tile movement cost; all
 *                        three are null.
 *
 * THE THREE HELD BACK — bone pile, ritual brazier, candle row — are exactly the
 * three whose metas use a field with nowhere to go: all block movement, all
 * carry `cover_level: 0.25`, two are destructible with real hit points, and the
 * brazier is 64x96 and asks for light. Shipping them as pretty rugs you walk
 * through would be a lie the art itself contradicts.
 */

/**
 * 64. NOT imported from `version.ts`'s `TILE_PX`, deliberately: that constant is
 * how big a tile is DRAWN, and this is how big a prop's art may BE. They are
 * equal today and the day the viewport scales they are two different questions.
 */
const TILE_ENVELOPE = 64;

/** The prop ids this build knows. Sprite ids, and the asset key is the id. */
export const PropId = {
  ChalkSigil: 'prop_eldritch_chalk_sigil_01',
  OfferingBowl: 'prop_eldritch_offering_bowl_01',
  PageDrift: 'prop_eldritch_page_drift_01',
} as const;
export type PropId = (typeof PropId)[keyof typeof PropId];

export type PropDef = {
  /** The asset key. Identical to the id — a prop IS its picture. */
  readonly sprite: PropId;
  /** `sprite_envelope_px`, verbatim from the meta. */
  readonly envelope: readonly [number, number];
  /**
   * `blocks_movement`. FALSE for every prop in this slice, and the reason the
   * field is here at all rather than assumed: the day one is true, the reader
   * that forgot to ask is a body walking through a brazier.
   */
  readonly blocksMovement: boolean;
};

const DEFS: Readonly<Record<PropId, PropDef>> = Object.freeze({
  [PropId.ChalkSigil]: {
    sprite: PropId.ChalkSigil,
    envelope: [64, 64],
    blocksMovement: false,
  },
  [PropId.OfferingBowl]: {
    sprite: PropId.OfferingBowl,
    envelope: [64, 64],
    blocksMovement: false,
  },
  [PropId.PageDrift]: {
    sprite: PropId.PageDrift,
    envelope: [64, 64],
    blocksMovement: false,
  },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GUARD THAT MAKES THE OMISSIONS ABOVE SAFE RATHER THAN MERELY WRITTEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every unported field above is unported because every prop in this slice
 * declares the inert value for it. That is a fact about THIS TABLE, and a
 * fourth entry added without reading the docblock would break it silently — a
 * blocking prop would simply be walked through, and a 64x96 one would draw into
 * the tile above with no anchor to hold it.
 *
 * So the table checks itself at module load, where a wrong entry cannot reach a
 * player: the server refuses to boot, exactly as `validateItems` does for an
 * icon that would render as a violet box.
 */
for (const [id, def] of Object.entries(DEFS)) {
  if (def.blocksMovement) {
    throw new Error(
      `props: ${id} declares blocksMovement — nothing reads it yet, so the body ` +
        `would walk through. See the slice note in props.ts before adding one.`,
    );
  }
  const [w, h] = def.envelope;
  if (w !== TILE_ENVELOPE || h !== TILE_ENVELOPE) {
    throw new Error(
      `props: ${id} is ${String(w)}x${String(h)} — a prop taller than one tile needs ` +
        `the bottom-centre anchor this slice does not port (see props.ts)`,
    );
  }
}

export const PROPS: ReadonlyMap<PropId, PropDef> = new Map(
  Object.entries(DEFS) as readonly (readonly [PropId, PropDef])[],
);

/** Every prop this build knows, in authored order. */
export const PROP_IDS: readonly PropId[] = Object.freeze(Object.keys(DEFS) as PropId[]);

export function propById(id: string): PropDef | undefined {
  return PROPS.get(id as PropId);
}
