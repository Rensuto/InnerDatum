import { classById, sheetForBody } from '../../src/server/content/classes.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import type { TalentEngine } from '../../src/server/engine/talents.ts';
import type { World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE `attachClass` STUB, ONCE, GOING THROUGH THE RULE PRODUCTION GOES THROUGH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `content/classes.ts` records the hazard this exists to end:
 *
 *   "`attachClass` is a closure inside `buildServer`, and every test in the tree
 *    hands the gateway its OWN `attachClass` stub — so nothing in `test/` could
 *    reach the real one ... A rule that cannot be stated as a test is a rule
 *    that gets to be wrong indefinitely."
 *
 * `sheetForBody` was extracted so that rule could be SHARED. Seven harnesses
 * then copied a simpler version of it — `sheetForClass(definition)`, with no
 * body — and a copy of a rule is a copy that drifts. Theirs had drifted past
 * bought trees, inscriptions and origins: a talent an ORIGIN grants reached a
 * real player and not a tested one, and the first reading of that failure was
 * "the join is broken" when the join was fine and the stub was blind.
 *
 * ═══ IT TAKES THE BODY, WHICH IS THE WHOLE POINT ═══
 * Production's `attachClass` is handed a CLASS ID and finds everything else by
 * reading the actor — the bought trees, what is written on it, which origin it
 * is. A stub that ignores the body cannot see any of that, and passes for a
 * class that has nothing else going on.
 *
 * A NON-PLAYER OR AN ABSENT BODY BUILDS THE BARE SHEET, which is what
 * `sheetForBody` does with `undefined` anyway — stated here so the narrowing
 * reads as deliberate rather than as a null check somebody added.
 *
 * ═══ EVERY HARNESS USES IT NOW ═══
 * All seven did their own `sheetForClass(definition)`. The first sweep to move
 * them failed and was reverted — not because the worlds were unreachable but
 * because the import was not being added, which read at the time as "six
 * differently-shaped scopes". They are two shapes: four hold
 * `realms.overworld.world` and two hold a local `world`.
 *
 * There is no eighth copy to write. A new harness calls this.
 */
export function attachClassFor(
  talents: TalentEngine,
  world: World,
): (actorId: string, classId: string) => void {
  return (actorId, classId) => {
    const definition = classById(classId);
    if (definition === undefined) return;
    const body = world.getActor(actorId);
    talents.attach(
      actorId,
      sheetForBody(definition, body?.kind === ActorKind.Player ? body : undefined),
    );
  };
}
