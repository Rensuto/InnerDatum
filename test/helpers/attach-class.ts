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
 * ═══ SIX HARNESSES STILL COPY THE OLD ONE, AND THAT IS NOT AN OVERSIGHT ═══
 * `character-delete`, `character-id-race`, `character-swap`,
 * `gateway-inventory`, `gateway` and `select-screen` still inline
 * `sheetForClass(definition)`. Moving them was tried in one pass and abandoned:
 * each drives a differently-shaped world — some hold a bare `world`, some only
 * `realms.overworld.world`, some neither in that scope — so the change is six
 * separate edits rather than one, and none of those files is currently testing
 * anything a body-derived sheet would change.
 *
 * They are blind in the same way this one was. The day one of them starts
 * caring about a bought tree, an inscription or an origin, this is the function
 * it should call rather than a seventh copy.
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
