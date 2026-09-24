// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:6276-6294 (the `Usage Speed:` line
//             of `getTalentFullDescription`).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import type { UsageSpeedView } from './protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "USAGE SPEED" — WHAT A TALENT COSTS, IN THE ONE CURRENCY IT IS CHARGED IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's tooltip, whole (tome/class/Actor.lua:6276-6294, colour codes
 * dropped and the `display_speed` override omitted — no talent here sets one):
 *
 *     local uspeed = "Full Turn"
 *     if no_energy == true then uspeed = "Instant (0% of a turn)"
 *     else
 *       local speed = self:getTalentSpeed(t)
 *       local speed_type = self:getTalentSpeedType(t)
 *       if type(speed_type) == "string" then speed_type = speed_type:capitalize()
 *       else speed_type = 'Special' end
 *       uspeed = ("%s (%d%% of a turn)"):format(speed_type, speed * 100)
 *     end
 *     d:add("Usage Speed: ", uspeed)
 *
 * ═══ IT REPLACED THE AP PRICE, WHICH HAD STOPPED BEING TRUE ═══
 * Every talent here was priced in action points, and the hotbar, the tooltip,
 * the talent panel, the class picker and the character sheet all printed the
 * figure. Slice C retired the budget those points were spent from: every action
 * ends the turn and pays ToME's energy price (`talentSpeed`, engine/talents.ts).
 * So "AP cost: 5" sat on a button that cost exactly what "AP cost: 2" did —
 * one turn — and nothing on screen said what the button actually cost. This is
 * that, in upstream's words.
 *
 * ═══ INSTANT IS `no_energy`, NEVER A ZERO PRICE ═══
 * The branch reads the talent's `no_energy` flag, and the server sends
 * `instant` for `Talent.noEnergy` — and for a stance, whose toggle this engine
 * never charges (`usageSpeedOf`, engine/talents.ts, argues that one). Phase
 * Door Rune was priced `ap: 0` and still costs the turn upstream, which is
 * precisely the reading this must not make: it is "Spell (100% of a turn)".
 *
 * ═══ `%d` TRUNCATES, SO THIS FLOORS ═══
 * Lua's `string.format("%d", x)` casts to an integer, so 0.8 prints 80 and a
 * speed a hair under a whole percentage prints the percentage below it. The
 * speed is floored at 0.1 before it gets here (`talentSpeed`), so the floor of
 * a positive number is the truncation.
 *
 * ONE SENTENCE-MAKER. The hotbar tooltip and the talent panel both print this,
 * and the server's tests assert on it through the real projection; a second
 * copy of the format in either place would be the first thing to drift.
 */
export function usageSpeedText(usage: UsageSpeedView): string {
  if (usage.type === 'instant') return 'Instant (0% of a turn)';
  return `${capitalize(usage.type)} (${String(Math.floor(usage.speed * 100))}% of a turn)`;
}

/**
 * `string.capitalize` — the first character upper-cased, the rest untouched
 * (t-engine4 game/engines/default/engine/utils.lua:789-797).
 */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
