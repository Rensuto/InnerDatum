import { describe, expect, it } from 'vitest';

import { dangerWord, specFor } from '../../src/server/content/delve.ts';
import { RealmKind, SITES } from '../../src/server/world/realms.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE WORLD MAP SAYS ABOUT A MARKER — THE THREE ANSWERS IT CAN GIVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `markersFor` decides this and `mapview.ts` draws it, and between them they
 * had two bugs that a player planning a trip would act on:
 *
 *   1. The grade came from `DELVES.get(siteId)`. The Redaction's six doors are
 *      DERIVED from their Alderbrook originals and are absent from that table,
 *      so it answered `undefined` — which is the TOWN case. All six drew
 *      ungraded, in the ink used for settlements.
 *
 *      `specFor` was written to fix exactly this and WAS APPLIED TO ONE OF THE
 *      TWO CALL SITES. The bearing list got it; the world map, which is the
 *      thing a player actually plans on, kept asking the raw table. One of two
 *      is worse than neither, because the two surfaces then disagreed.
 *
 *   2. A gradeless marker draws gold, which was a complete rule while every
 *      gradeless marker was a settlement. The door to a second landmass is
 *      neither a room nor a town, so the entrance to the hardest country in the
 *      game drew in the same ink as Alderbrook.
 *
 * The three answers are now: a GRADE for a room, a CROSSING for a way off the
 * map, and nothing at all for a town. This asserts all three are reachable and
 * that no marker can claim two of them.
 */

/** What the server will attach to a marker, in the same order `markersFor` does. */
function labelFor(siteId: string): { danger?: string; crossing?: boolean } {
  const def = SITES.get(siteId);
  if (def === undefined) throw new Error(`no site ${siteId}`);
  const spec = specFor(siteId);
  return {
    ...(spec === undefined ? {} : { danger: dangerWord(spec) }),
    ...(def.kind === RealmKind.Overworld ? { crossing: true } : {}),
  };
}

describe('the marks on the world map', () => {
  it('grades every room, on both maps', () => {
    /**
     * THE REGRESSION, STATED OVER THE WHOLE TABLE rather than over the six that
     * were broken. Any site a party can be hurt in must carry a grade — that is
     * what `Inner` means — and the sweep is what catches the next content
     * addition that lands outside `DELVES`.
     */
    const ungraded: string[] = [];
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Inner) continue;
      if (labelFor(id).danger === undefined) ungraded.push(id);
    }
    expect(ungraded, 'rooms drawn on the map with no warning on them').toEqual([]);
  });

  it('grades the Redaction’s doors, which is the half that was missed', () => {
    // NAMED EXPLICITLY as well as swept, because the sweep above would pass if
    // somebody "fixed" it by making these sites Common.
    const twins = [...SITES.keys()].filter((id) => id.startsWith(`${REDACTION_SITE_ID}:`));
    expect(twins.length).toBeGreaterThan(3);
    for (const id of twins) {
      expect(labelFor(id).danger, id).toBeDefined();
    }
  });

  it('marks a way off the map as one, and nothing else as one', () => {
    const crossings = [...SITES.keys()].filter((id) => labelFor(id).crossing === true);
    expect(crossings).toEqual([REDACTION_SITE_ID]);
  });

  it('never claims a marker is both a room and a way out', () => {
    /**
     * `mapview.ts` orders these — a crossing wins — so a marker carrying both
     * would silently lose its grade. It cannot happen today because `specFor`
     * answers nothing for a site that is not a delve, and this is the assertion
     * that keeps the renderer's tie-break theoretical.
     */
    for (const id of SITES.keys()) {
      const label = labelFor(id);
      expect(label.danger !== undefined && label.crossing === true, id).toBe(false);
    }
  });

  it('leaves the settlements plain, which is what makes a grade mean something', () => {
    // A "quiet" beside every shop would train a player to stop reading the word
    // exactly where it matters — `nearestSites` makes the same argument.
    for (const [id, def] of SITES) {
      if (def.kind !== RealmKind.Common) continue;
      expect(labelFor(id)).toEqual({});
    }
  });
});
