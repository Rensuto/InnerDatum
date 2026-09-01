/**
 * WHAT A TOOLTIP SAYS — computed here, on the server, and sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT IN THE CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 * A hover tooltip is the layer that makes a roguelike legible instead of
 * memorised: "can I hit this thing, and how badly will it hurt" should be a
 * glance, not a wiki tab. That answer is arithmetic over accuracy, defence,
 * armour and resistances — and the client is FORBIDDEN from importing
 * shared/checkhit, shared/scale and shared/energy (eslint blocks it, see
 * CLAUDE.md non-negotiable #4).
 *
 * That ban is not bureaucracy. A second copy of a combat formula in the browser
 * diverges the first time either side is touched, and the symptom is a tooltip
 * promising 78% while the server rolls against 71 — which reads as "the dice
 * are rigged" and is unfalsifiable from the player's chair. One implementation,
 * server-side, sent as a number.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE CONSUMES RNG
 * ═══════════════════════════════════════════════════════════════════════════
 * `hitChance` is deliberately separate from `checkHit` upstream: the first is
 * the odds, the second rolls them. A tooltip must use the former. Drawing from
 * the seeded stream to render a hover would make the world's future depend on
 * where somebody moved their mouse, and every replay would diverge from the
 * session it claims to reproduce.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOG OF WAR APPLIES TO KNOWLEDGE, NOT JUST TILES
 * ═══════════════════════════════════════════════════════════════════════════
 * `inspectActor` takes the VIEWER. An actor the viewer cannot see returns null
 * rather than a redacted record: sending a stripped-down object still confirms
 * something is there, and a client that receives one can infer a position it was
 * never meant to know. The server's answer to "what is in that dark corner" is
 * silence.
 */

import { hitChance } from '../../shared/checkhit.ts';
import { chebyshev } from '../../shared/coords.ts';
import { DAMAGE_TYPES, damageTypeName } from '../../shared/damagetype.ts';
import { combatGetResist } from '../engine/damage.ts';
import { ActorKind, InspectGroup } from '../../shared/protocol.ts';
import { classById } from '../content/classes.ts';
import { MELEE_REACH, combatDistance } from '../engine/combat.ts';
import type { InspectRow, InspectView } from '../../shared/protocol.ts';
import {
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatCritPower,
  combatDamage,
  combatDamageRange,
  combatDefense,
  combatMentalResist,
  combatMindpower,
  combatPhysicalResist,
  combatPhysicalpower,
  combatSpellResist,
  combatSpellpower,
  healingFactor,
  ignoreDirectCrits,
  stat,
} from '../engine/derived.ts';
import type { Combatant, PrimaryStats } from '../engine/derived.ts';
import type { CombatSheet } from '../engine/combat.ts';
import type { Actor, World } from '../world/world.ts';
import { hasLineOfSight } from '../world/world.ts';

// `InspectRow` and `InspectView` WERE DECLARED HERE and now live in
// src/shared/protocol.ts: the tooltip painter has to name them and eslint's
// NO_SERVER_PATTERNS bans client/** -> server/** outright, so the browser can
// never reach a type declared under src/server/. Only the DECLARATIONS moved —
// this file remains the one and only implementation of what they contain.

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/**
 * An actor's combat sheet — the thing the derived-stat maths actually reads.
 *
 * THE SHEET, NOT THE ACTOR. An `Actor` and a `Combatant` share no fields: the
 * sheet hangs off `actor.combat`. Passing the actor itself compiles only behind
 * an `as unknown as Combatant`, and then every stat silently resolves to ToME's
 * level-1 default — a tooltip that is confidently, uniformly wrong, and wrong in
 * a way no test would catch because the numbers look plausible.
 *
 * This was written as a double cast first. The compiler caught it the moment the
 * cast came off, which is the entire argument against writing one.
 *
 * `?? {}` is correct rather than lazy: derived.ts documents an absent sheet as
 * meaning ToME's own defaults, so a monster authored without one inspects as a
 * baseline creature instead of throwing at a hover.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS LINE NEEDED NO CHANGE WHEN EQUIPMENT LANDED, AND THAT IS THE PROOF THAT
 * TRAP 1 IS CLOSED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `actor.combat` is now a DERIVED value with exactly one writer —
 * `engine/effects.ts#recomposeCombat`, running `baseCombat` -> gear fold ->
 * status flags in that fixed order. So the instant a coat lands in a slot, the
 * Armour and Defence rows this file prints move, and the hit chance a hostile
 * card advertises against a geared target moves with them. Nothing here reads
 * `equipped`, nothing here knows what an item is, and nothing here had to be
 * taught: the six existing readers of `actor.combat` (combat.ts, talents.ts,
 * damage.ts, projectile.ts, effects.ts and this line) all inherited equipment
 * for free.
 *
 * That is the whole test of "an item that changes nothing". An equipment system
 * that had needed an edit HERE would be one whose numbers reached the character
 * sheet through a second path — and a second path is a path that can disagree
 * with the one the dice roll against.
 */
function combatantOf(actor: Actor): CombatSheet {
  return actor.combat ?? {};
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RESISTANCE ROWS — CharacterSheet.lua:1310-1330.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six damage types have been landing on players since the damage pipeline was
 * written, `combatGetResist` has been a complete port the whole time, and until
 * the `Wielder.resists` channel there was no way for a player to have any. There
 * was also no row: monsters have carried resist tables for milestones and no
 * screen in the game named one, so "why did that barely scratch it" had no
 * answer available anywhere.
 *
 * ═══ THE EFFECTIVE FIGURE, NOT THE RAW TABLE ═══
 * `combatGetResist` is what the damage pipeline actually spends — it composes
 * the `all` row multiplicatively with the typed one and applies the cap that
 * stops the formula inverting above 100% (Combat.lua:2220-2231). Printing
 * `profile.resists[type]` instead would be a second opinion about a number, and
 * on a capped or `all`-bearing body it would be the WRONG one.
 *
 * ROUNDED, because that composition is floating-point: a flat -10 comes back as
 * -10.000000000000009, and a character sheet must not show a player that.
 *
 * ═══ ONLY THE NON-ZERO ONES ═══
 * Six rows of "0%" on every character would push the rows that matter off the
 * pane and teach the player to stop reading the group. A resistance is
 * interesting exactly when somebody has one.
 */
function pushResistRows(rows: InspectRow[], c: CombatSheet, group?: InspectGroup): void {
  for (const type of DAMAGE_TYPES) {
    const value = Math.round(combatGetResist(c.profile ?? {}, type));
    if (value === 0) continue;
    rows.push({
      label: `${damageTypeName(type)} resist`,
      value: `${String(value)}%`,
      ...(group === undefined ? {} : { group }),
    });
  }
}

/**
 * The class this body is, as the fiction spells it — "The Watchman".
 *
 * `classId` lives on `PlayerActor` alone (a monster has no class), so the kind
 * check is what NARROWS the union rather than being a redundant guard. It is
 * also a SOFT reference by design (persist/saves.ts): a body restored from a
 * file naming a class this build no longer has answers undefined here, and
 * `InspectView.className` is optional precisely so that absence means "draw no
 * class line" instead of drawing the word "unknown" at a player.
 */
function classNameOf(actor: Actor): string | undefined {
  if (actor.kind !== ActorKind.Player) return undefined;
  return classById(actor.classId)?.name;
}

/**
 * THE SIX PRIMARIES, IN ToME'S OWN ORDER — CharacterSheet.lua:815-820.
 *
 * STR / DEX / CON / MAG / WIL / CUN, which is neither alphabetical nor the order
 * `PrimaryStats` declares. It is the order every ToME player has read for
 * fifteen years, and the directive is explicit that the information ORDER is the
 * thing being ported. A literal list rather than `Object.keys` over the stat
 * table, for the reason derived.ts's own `STAT_KEYS` gives: key order on an
 * authored object is whatever somebody typed.
 */
const SHEET_STATS: readonly (readonly [string, keyof PrimaryStats])[] = [
  ['Strength', 'str'],
  ['Dexterity', 'dex'],
  ['Constitution', 'con'],
  ['Magic', 'mag'],
  ['Willpower', 'wil'],
  ['Cunning', 'cun'],
];

/** A whole number in a label/value pair. ToME's `%3d`, without the padding. */
function whole(n: number): string {
  return String(Math.round(n));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHARACTER SHEET — ToME'S CharacterSheet.lua, REDUCED TO WHAT EXISTS HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three sections in ToME's own spine: the six stats (:815-820), then Attack
 * (:935-1120), then Defense (:1304-1321). Each row below carries the line it
 * came from.
 *
 * ═══ WHAT IS DELIBERATELY ABSENT ═══
 * Gold, fatigue, the two speeds, vision, inscriptions and times-died are all
 * rows ToME prints and none of them is emitted, because every one reads from a
 * system this game does not have. An empty row is worse than an absent one:
 * "Level: —" invites a player to go looking for the levelling screen, and until
 * one existed there was not one. When those systems land, the rows land with
 * them.
 *
 * ═══ AND TWO OF THEM HAVE LANDED SOMEWHERE ELSE, WHICH IS WHY THEY ARE STILL
 *     NOT HERE ═══
 * This list used to name "level, experience, equipment, inventory" and justify
 * all four with "a system this game does not have". Both halves of that are now
 * false: there is a levelling screen, and from v10 there is a paper doll and a
 * bag. They are still absent from THIS frame, for a different and better
 * reason — each has its own viewer-private frame that carries it whole.
 * Progression rides `ProgressMsg` (level, xp, points in hand) and equipment
 * rides `InventoryMsg` (the doll, the bag, and the server-computed swap
 * comparison). Restating either as a row here would be a SECOND SOURCE OF TRUTH
 * for a number four people are staring at, which is the failure this file's own
 * header exists to prevent.
 *
 * It also could not be done safely at the same width. `inspectActor` has three
 * branches and only the SELF one is entitled to a full sheet; adding equipped
 * rows would mean re-arguing the ally branch's disclosure boundary — a party
 * member's gear is theirs — for a fact the recipient already has in a frame
 * shaped for it. Equipment therefore stays off `InspectView` for the same reason
 * `protocol.ts` keeps it off `ActorView`.
 *
 * ═══ NO `emphasis` ANYWHERE ═══
 * `InspectRow.emphasis` is reserved for the number that decides whether to
 * commit — the hit chance on a hostile card, and one day a threat that can kill
 * you this turn. A sheet with fifteen emphasised rows has emphasised none of
 * them, and it would steal the one piece of formatting the hostile tooltip
 * depends on.
 *
 * ═══ ROUNDING ═══
 * Whole numbers everywhere except the damage band, which TRUNCATES because that
 * is what the roll itself does (see the Damage row). ToME wraps the three saves
 * in `math.floor` (:1316, :1318, :1320) and `whole` rounds them instead —
 * deliberately, because this same file already rounds a target's Physical save
 * on the hostile card below, and one module printing one quantity two ways is
 * the "which of these is lying?" failure the header of this file exists to
 * prevent. The disagreement with upstream is at most one display point and it
 * is written down here rather than discovered.
 */
function pushSelfSheet(rows: InspectRow[], c: Combatant): void {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EACH BLOCK NAMES ITS TAB NOW. The grouping was always here; it was thrown
   * away at the wire.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * These three blocks have carried their `CharacterSheet.lua` citations since
   * they were written — :815-820, :935-1120, :1304-1321 — which are exactly
   * ToME's `[G]eneral`, `[A]ttack` and `[D]efense` tabs (`CharacterSheet.lua:54-56`).
   * The structure was correct and invisible: `InspectRow` was flat, so a client
   * wanting to tab the sheet had to guess from labels, and charsheet.ts says in
   * writing that it must not.
   *
   * `group` is what the comments already said, made readable by a machine.
   */
  // ═══ 1. THE SIX PRIMARIES — CharacterSheet.lua:815-820 ═══
  for (const [label, key] of SHEET_STATS) {
    rows.push({ label, value: whole(stat(c, key)), group: InspectGroup.General });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT CONSTITUTION BUYS BESIDES HIT POINTS — CharacterSheet.lua:715.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every heal in the game is multiplied by the RECEIVER's factor
   * (`talents.ts#healActor`), which runs from 100% at the base Constitution of
   * 10 to 150% at 100. `derived.ts` makes it the design point that *"a
   * Watchman's Field Dressing is worth more in his hands than in an
   * Alchemist's"* — a party of specialists rather than a set of health bars.
   *
   * Without this row the same bandage landing for 18 on one detective and 24 on
   * another reads as a bug rather than as a build, and nobody can answer "who
   * should I patch first". `shared/leveling.ts` records that Constitution being
   * *"close to dead currency"* was a real problem here; half the fix was still
   * invisible until this line.
   *
   * ═══ THE FIRST DERIVED ROW THE GENERAL TAB HAS EVER HAD ═══
   * It was the six primaries and nothing else. This belongs with them rather
   * than under Attack or Defence because it is neither: it is what one of those
   * six numbers is worth, which is the question a player is asking when they are
   * looking at that tab at all.
   */
  rows.push({
    label: 'Healing mod.',
    value: pct(healingFactor(c) * 100),
    group: InspectGroup.General,
  });

  // ═══ 2. ATTACK — CharacterSheet.lua:935-1120 ═══
  // "Accuracy" (:935), "Damage" (:941), "APR" (:1111), "Crit. chance" (:1113),
  // in that order. ToME's own labels, in ToME's own sequence.
  rows.push({ label: 'Accuracy', value: whole(combatAttack(c)), group: InspectGroup.Attack });
  rows.push({ label: 'Damage', value: damageBand(c), group: InspectGroup.Attack });
  rows.push({ label: 'APR', value: whole(combatAPR(c)), group: InspectGroup.Attack });
  rows.push({ label: 'Crit. chance', value: pct(combatCrit(c)), group: InspectGroup.Attack });
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND HOW MUCH A CRIT IS WORTH — CharacterSheet.lua:1115-1116, same tab, same
   * place: directly under the chance.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `combatCritPower` has been live since the damage pipeline was written —
   * `combat.ts` passes it into every melee resolve — and no screen in the game
   * printed it. SIX talents sell themselves on it (Set in Stone, Soft Places,
   * Steady Hands, Cold Case, Leverage and a Load) and an ego grants it
   * (`egos.ts:296`, `criticalPower {floor: 6, step: 4}`), so a player could
   * spend a point or wear a ring, be told "your crits land harder", and find
   * every number on this sheet unchanged.
   *
   * That is the `equipment.ts` failure exactly — an item that changes no number
   * a player can see — reached through the readout rather than the fold.
   *
   * AS A PERCENTAGE, `150 + combat_critical_power`, which is upstream's own
   * presentation: the getter carries 1.5 as a multiplier and a sheet reading
   * "Crit. power 1.5" would be the only number on it that is not a percentage
   * or a whole.
   */
  rows.push({
    label: 'Crit. power',
    value: pct(combatCritPower(c) * 100),
    group: InspectGroup.Attack,
  });
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THREE POWERS — CharacterSheet.lua:1161, :1167-1168, :1179-1181.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Upstream prints all three side by side under Physical / Magical / Mental,
   * for every character, whatever they are. These were computed here and shown
   * nowhere, and that was invisible while the sheet was one crowded page.
   *
   * ═══ THE REDACTOR IS WHY THIS IS NOT COSMETIC ═══
   * `indelible.ts` and `open_ledger` raise `genericPower` specifically to move
   * MINDPOWER — that is the whole argument in `indelible.ts`'s docblock, that
   * for a class whose economy is "did the mark land", power is what a damage
   * bonus is. A player could spend five points on it and every screen in the
   * game would look identical. A number worth building around must be a number
   * you can read.
   *
   * ALL THREE FOR EVERYONE, as upstream does, rather than only the one a class
   * uses. A Watchman's Mindpower is what says his marks would not land, and
   * hiding the two a class does not use would mean the sheet could not answer
   * "should I even try this" — which is the question the numbers are for.
   */
  const power = InspectGroup.Attack;
  rows.push({ label: 'Phys. power', value: whole(combatPhysicalpower(c)), group: power });
  rows.push({ label: 'Spellpower', value: whole(combatSpellpower(c)), group: power });
  rows.push({ label: 'Mindpower', value: whole(combatMindpower(c)), group: power });

  // ═══ 3. DEFENSE — CharacterSheet.lua:1304-1321 ═══
  // "Armor" (:1304), "Defense" (:1306), then the three saves under a "Saves:"
  // heading (:1315) as bare "Physical" / "Spell" / "Mental" (:1317, :1319,
  // :1321). `InspectRow` is a FLAT list with no section headings, so each save
  // carries the word "save" in its own label — a bare "Physical" in a list that
  // also contains "Damage" and "APR" reads as a damage type, which is the one
  // thing it is not.
  rows.push({ label: 'Armour', value: whole(combatArmor(c)), group: InspectGroup.Defence });
  rows.push({ label: 'Defence', value: whole(combatDefense(c)), group: InspectGroup.Defence });
  /**
   * ═══ ARMOUR HARDINESS — CharacterSheet.lua:1302, and :1860 in the dump ═══
   * What FRACTION of a blow armour is allowed to touch. Armour says how much it
   * could stop; hardiness says how often it is allowed to try, and a player
   * reading `Armour 4` has been told half a sentence.
   *
   * IT IS THE NUMBER `BREACHED` HALVES. `combatArmorHardiness` applies the 0.5
   * after the 0-100 bound, verbatim from Combat.lua:1334 — so a breached body's
   * armour does not merely get worse, it gets bypassed. The Redactor's
   * `redaction.ts` and the Overwritten Husk's `breaching_blow.ts` both do it,
   * and until this row there was no screen on which the effect could be seen as
   * anything but "I seem to be taking more damage".
   */
  rows.push({
    label: 'Armour hardiness',
    value: `${whole(combatArmorHardiness(c))}%`,
    group: InspectGroup.Defence,
  });
  const save = InspectGroup.Defence;
  rows.push({ label: 'Physical save', value: whole(combatPhysicalResist(c)), group: save });
  rows.push({ label: 'Spell save', value: whole(combatSpellResist(c)), group: save });
  rows.push({ label: 'Mental save', value: whole(combatMentalResist(c)), group: save });

  /**
   * AND WHAT THIS BODY SHRUGS OFF. Last in the Defence group, below the saves,
   * which is upstream's own order — CharacterSheet.lua prints the three saves
   * and then the resistance block.
   *
   * A SAVE AND A RESISTANCE ARE NOT THE SAME THING and the adjacency is the
   * point: a save is a roll against an EFFECT landing, a resistance is a
   * percentage off the DAMAGE once it has. A player who has just read three
   * saves is in exactly the right frame to be told the difference.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT DEXTERITY BUYS THAT NOTHING ELSE DOES — CharacterSheet.lua:1312.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `ignoreDirectCrits` is rolled on every incoming critical hit and cancels the
   * multiplier outright when it lands. Its own docblock calls it *"the one place
   * a Dexterity build gets something a Strength build cannot buy at any price"*
   * — and it shipped this morning with no row, which made that sentence true of
   * the code and invisible to the player.
   *
   * THE MISTAKE IS MINE AND IT IS THE ONE I HAD JUST WRITTEN DOWN. The elemental
   * resistance change earlier the same day shipped its readout in the same
   * commit precisely because *"a channel with no readout is invisible and a
   * readout with no channel is unactionable"*. The next commit added two
   * channels and no readout at all.
   */
  rows.push({
    label: 'Crit. shrug off',
    value: pct(ignoreDirectCrits(c)),
    group: InspectGroup.Defence,
  });

  pushResistRows(rows, c, InspectGroup.Defence);
}

/**
 * THE DAMAGE BAND — "12–13", and both endpoints are the roll's own.
 *
 * ═══ `combatDamageRange` IS A MULTIPLIER, NOT A SPREAD ═══
 * Combat.lua:1430-1433 returns 1.1 by default, and Combat.lua:511 spends it as
 * `rng.range(dam, dam * damrange)`. So the band is `[base, base × range]` and
 * NOT `base ± range`; read it as a spread and the Watchman's card would
 * advertise "11–13" for a weapon that cannot roll 11.
 *
 * ═══ TRUNCATED, NOT ROUNDED, AND NOT CEILED ═══
 * `rollDamageRange` (engine/damage.ts) truncates BOTH endpoints toward zero
 * before drawing, because ToME's `rng.range` is native C taking its arguments
 * through an `int`. These are therefore the exact two numbers the dice can
 * actually produce. Rounding here would print a low end no swing can roll, and
 * the ceil rule that governs every hp figure on this wire does not apply: this
 * is a damage band, and the endpoints must match the roll rather than each
 * other.
 *
 * ONE NUMBER WHEN THEY COLLAPSE, for the same reason `rollDamageRange` skips
 * the draw when `low === high`: "9–9" is arithmetic showing its working.
 */
function damageBand(c: Combatant): string {
  const base = combatDamage(c);
  const low = Math.trunc(base);
  const high = Math.trunc(base * combatDamageRange(c));
  return low === high ? String(low) : `${String(low)}–${String(high)}`;
}

/**
 * What the viewer may know about `target` right now.
 *
 * Returns null when the target is not visible — see the fog-of-war note above.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE BRANCHES, NOT TWO, AND THE THIRD ONE IS A SECURITY BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hostile` is false for ANY player target — a teammate and yourself both land
 * in the same else. So widening that else to carry the character sheet would
 * hand a party member's full combat sheet to anyone who moves a mouse over
 * them: their stats, their accuracy, their damage band, their three saves. That
 * is the class of disclosure `toActorView` already withholds `energy` and
 * `pendingIntent` for, arriving through a hover instead of through a frame.
 *
 * So:
 *   SELF    — the reduced CharacterSheet, plus `className`. It is your own body
 *             and nothing here is secret from you.
 *   ALLY    — Defence and Armour, exactly as before. Two rows, unchanged, and
 *             every existing test in test/server/inspect.test.ts still describes
 *             the truth.
 *   HOSTILE — the hit chance and its context, exactly as before.
 *
 * `InspectView.className` documents itself as SELF-ONLY and cites this split by
 * name; the two must be edited together or that doc becomes a lie.
 */
export function inspectActor(world: World, viewer: Actor, target: Actor): InspectView | null {
  if (!target.alive && target.kind !== ActorKind.Player) return null;
  if (target.id !== viewer.id && !hasLineOfSight(world.level, viewer, target)) return null;

  const rows: InspectRow[] = [];
  const self = target.id === viewer.id;
  const hostile = !self && target.kind !== ActorKind.Player;

  if (self) {
    // THE SHEET, NOT THE ACTOR — `combatantOf`, always. See its note: passing
    // the actor compiles only behind a double cast and then every number on the
    // character sheet silently resolves to ToME's level-1 default.
    pushSelfSheet(rows, combatantOf(target));
  } else if (hostile) {
    // THE NUMBER THE PLAYER IS ACTUALLY ASKING FOR. Everything else on the card
    // is context for this one.
    const atk = combatAttack(combatantOf(viewer));
    const def = combatDefense(combatantOf(target));
    rows.push({ label: 'Chance to hit', value: pct(hitChance(atk, def)), emphasis: true });

    const armour = combatArmor(combatantOf(target));
    if (armour > 0) rows.push({ label: 'Armour', value: String(Math.round(armour)) });

    const resist = combatPhysicalResist(combatantOf(target));
    if (resist !== 0) rows.push({ label: 'Physical save', value: String(Math.round(resist)) });

    const crit = combatCrit(combatantOf(viewer));
    if (crit > 0) rows.push({ label: 'Your crit', value: pct(crit) });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THIS THING SHRUGS OFF — the row that makes an element a DECISION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Seven monsters have carried resist tables for milestones and no screen in
     * the game named one. The Alchemist's whole kit is Fire; against a body
     * resisting it she was doing a fraction of the damage her own card
     * advertised, with nothing anywhere to say why. "Why did that barely
     * scratch it" was an unanswerable question about a number the server knew.
     *
     * ═══ AND THIS IS THE HALF THAT MAKES THE OTHER HALF WORTH HAVING ═══
     * A resistance CHANNEL with no readout is invisible; a readout with no
     * channel is unactionable. This card is where a player learns that elements
     * differ, and the sheet is where they learn they can answer it — which is
     * why both landed in one change rather than one being left for later.
     *
     * NO GROUP: a hostile tooltip is not tabbed (see `InspectRow.group`), so
     * these sit inline with the rest of the card in the order pushed.
     */
    pushResistRows(rows, combatantOf(target));

    rows.push({ label: 'Distance', value: `${chebyshev(viewer, target)} tiles` });
  } else {
    // ALLY — BYTE FOR BYTE WHAT IT HAS ALWAYS BEEN. Two rows, and the reason it
    // is only two is the block above: a party member's sheet is theirs.
    rows.push({ label: 'Defence', value: String(Math.round(combatDefense(combatantOf(target)))) });
    rows.push({ label: 'Armour', value: String(Math.round(combatArmor(combatantOf(target)))) });
  }

  // SELF ONLY, and a CONDITIONAL SPREAD rather than `className: undefined`: the
  // key must be genuinely ABSENT for an ally, not present-and-empty. It sits
  // beside `name` because a class is an identity, exactly as the field's own
  // doc on `InspectView` argues — a header must not have to scan `rows` for a
  // label to find out who it is drawing.
  const className = self ? classNameOf(target) : undefined;

  return {
    id: target.id,
    name: target.name,
    ...(className === undefined ? {} : { className }),
    kind: target.kind,
    hp: target.hp,
    maxHp: target.maxHp,
    effects: [],
    rows,
  };
}

/**
 * Why the viewer cannot attack the target, or undefined when they can.
 *
 * Deliberately mirrors the server's own resolution-time refusals rather than
 * inventing a parallel set of rules: a tooltip that says "you can hit this" and
 * a server that then refuses is worse than no tooltip, because it teaches the
 * player something false and they will act on it.
 */
export function attackBlockedReason(
  world: World,
  viewer: Actor,
  target: Actor,
  opts: { readonly minRange?: number; readonly maxRange?: number } = {},
): string | undefined {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EUCLIDEAN, BECAUSE THAT IS THE METRIC THE SERVER WILL ANSWER WITH.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This measured with CHEBYSHEV and compared against `viewer.combat.range`,
   * which is a EUCLIDEAN radius. That agreed by ACCIDENT while no player had a
   * combat sheet at all — the `?? 1` fallback happened to match the old
   * Chebyshev-1 scheduler. Now every player carries a class sheet and the two
   * disagree along the whole diagonal:
   *
   *   Inspector (range 5) at (10,10), husk at (14,14). Chebyshev 4 ≤ 5, so this
   *   returned `undefined` and the card advertised a shootable target. Euclid is
   *   5.657, so `canAttack` answers `out_of_range` and the shot is refused on
   *   click. The whole diagonal rim of her range ring said yes and meant no.
   *
   * combat.ts's own wiring note is the argument: the metrics must move together
   * or "attacks pass the legality check and then quietly do nothing". The
   * scheduler and `canAttack` were moved; this third reader was missed.
   *
   * ═══ AND IT ASKS THE QUESTION THROUGH `rangeRefusal` ═══
   * Not a re-implementation of the band — `rangeRefusal` is exported from
   * engine/combat.ts precisely so a caller can ask the IDENTICAL question the
   * scheduler will ask, including the `Math.max(attackRange, MELEE_REACH)` floor
   * that makes a diagonal melee swing legal. This function's own promise is that
   * it "mirrors the server's own resolution-time refusals rather than inventing
   * a parallel set of rules"; it now does that literally.
   */
  const dist = combatDistance(viewer, target);
  // Reach and the dead zone belong to the ATTACKER's sheet. `opts` overrides
  // only so a talent with its own range can ask the same question.
  const minRange = opts.minRange ?? viewer.combat?.minRange ?? 0;
  const maxRange =
    opts.maxRange ?? viewer.combat?.range ?? Math.max(viewer.attackRange ?? 1, MELEE_REACH);

  if (!target.alive) return 'already down';
  if (!hasLineOfSight(world.level, viewer, target)) return 'no line of sight';
  if (minRange > 0 && dist < minRange) return `too close: needs ${minRange} tiles`;
  if (dist > maxRange) {
    // ═══ WHOLE TILES IN A SENTENCE A PLAYER READS ═══
    // The metric is a real-valued radius, but "out of range: 5.66 tiles,
    // reaches 1.5" is arithmetic, not advice. `round` on the distance is the
    // number of squares between them; `floor` on the reach is what the circle
    // actually CONTAINS — `MELEE_REACH` is 1.5 exactly so that the eight
    // neighbours at √2 are inside it, and "reaches 1" is what that means to
    // somebody looking at a grid. Last week this sentence said "reaches 1" and
    // it must keep saying so.
    return `out of range: ${Math.round(dist)} tiles, reaches ${Math.floor(maxRange)}`;
  }
  return undefined;
}
