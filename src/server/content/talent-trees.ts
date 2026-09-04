// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// SHAPE: t-engine4 game/modules/tome/data/talents.lua — `newTalentType{ type =
//        "technique/weapon-shield", name = "weapon and shield", ... }`
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TALENT TREES — WHAT ToME CALLS A TALENT TYPE, AND WE HAD NONE OF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PLAN.md § 5 caps the MVP at *3 classes / 12 talents / 0 trees* and names the
 * v1.0 ceiling in the same line: *4 / 32 / 8 / per-level*. Twelve talents in one
 * flat list per class is exactly what shipped, and the zero is the part a player
 * feels — `classes.ts` says it outright: *"Below ~15 talents per class the
 * build-crafting evaporates"*. This file is the first half of closing that,
 * asked for directly: a tree structure like Tales of Maj'Eyal's.
 *
 * ═══ A TREE IS A GROUPING, NOT A GATE — YET ═══
 * ToME's talent type carries a mastery multiplier and a `points` requirement
 * that unlocks the tree itself. Neither is here, deliberately: the grouping is
 * what makes a panel readable and a build legible, and it is worth having on its
 * own before any of the arithmetic hangs off it. Adding mastery later changes
 * this table and `combatTalentScale`'s caller, and nothing else — which is the
 * property that makes shipping the grouping first safe rather than lazy.
 *
 * ═══ TWO TREES A CLASS, NOT ONE ═══
 * One tree per class would be the flat list with a heading over it. Two is the
 * smallest number that makes the panel say something a player can act on: these
 * two talents are the same idea and those two are a different one, so a point
 * spent is a point spent on a DIRECTION. The v1.0 ceiling of eight leaves room
 * for a third per class and a shared one.
 */

import { ClassId } from '../engine/talents.ts';

export { TalentKind } from '../engine/talents.ts';
export type { TalentKind as TalentKindType } from '../engine/talents.ts';

export type TalentTree = {
  /** `watch/discipline`. ToME's `type` string, and the shape is deliberate. */
  readonly id: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * CATEGORY MASTERY — the "(x1.30)" a ToME player reads in the header.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It is not decoration. `ActorTalents.lua:834` is the whole of it:
   *
   *     getTalentLevel(id) = getTalentLevelRaw(id) * (mastery)
   *
   * so a point spent in a x1.30 category is worth thirty percent more than the
   * same point in a x1.00 one, everywhere `combatTalentScale` is used. It is how
   * ToME says "this class is BETTER at this than that class is" without
   * authoring two copies of a talent.
   *
   * STORED AS THE MULTIPLIER ITSELF. Upstream keeps `value - 1` (:861 writes it,
   * :849 reads it back with `+ 1`) so that an absent entry means 1.0 — a save
   * compatibility trick we have no version of, and an offset nobody needs is a
   * subtraction somebody eventually forgets.
   *
   * EVERY TREE SHIPS AT 1.0 TODAY, deliberately: the field goes in live and
   * changes nothing, so the commit that tunes a category is a commit about
   * tuning rather than one that also introduces the machinery.
   */
  readonly mastery: number;
  /** What the panel's header says. Two words at most; it is a heading. */
  readonly name: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHOSE TREE IT IS — AND `null` MEANS EVERYBODY'S.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME's third category is usually not a class category at all. Every
   * character in that game carries `technique/combat-training` alongside their
   * class trees, and it is where armour training, accuracy and thick skin live —
   * the things that are true of a body rather than of a profession.
   *
   * Copying that is cheaper AND more faithful than authoring three bespoke third
   * trees: it gives every class a third category for six talents instead of
   * eighteen, and it puts the generic material where a ToME player already
   * expects to find it. `treesFor` returns a shared tree to every class.
   */
  readonly classId: ClassId | null;
  /** One line under the header, for why these belong together. */
  readonly blurb: string;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   NOBODY STARTS WITH THIS ONE. It costs a CATEGORY POINT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ToME's `talents_types` is a table of open-or-locked per class, and the
   * locked rows are the whole of what category points are for — a Bulwark opens
   * with eight of thirteen and buys into the rest one at a time
   * (warrior.lua:134-148). Three points arrive in a career, at levels 10, 20 and
   * 36, so which discipline is a decision a build is made of.
   *
   * ═══ THE LOCKED ONES ARE GENERIC, AND THAT IS ARITHMETIC RATHER THAN TASTE ═══
   * Upstream's category points buy another CLASS's discipline. Measured here, it
   * does not fit: classes carry nine or ten actives, every class tree needs
   * three or four hotbar slots, and the bar addresses twelve — so the Watchman
   * fits exactly one cross-class unlock and the Inspector, at ten, fits none.
   * Three points with nowhere to spend two of them is a currency that reads as
   * broken.
   *
   * A locked GENERIC tree of six passives needs zero bar slots, so the ceiling
   * never binds and all three points are always spendable. Upstream locks
   * generic categories too — `cunning/dirty` is closed to a Bulwark — so this is
   * the same mechanic wearing its other shape.
   *
   * ABSENT MEANS OPEN, which is every tree that shipped before this field.
   */
  readonly locked?: boolean;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOT DRAWN IN THE LEVELUP PANEL AT ALL. Ported from `hide = true`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `data/talents/misc/misc.lua:23` marks `inscriptions/infusions` — and runes,
   * and taints, and `base/class`, and `base/race` — with `hide = true`, and
   * `dialogs/LevelupDialog.lua:490` filters the category list on `not tt.hide`
   * before it draws a single row. So upstream's own answer to "where does the
   * healing infusion appear on the levelup screen" is: NOWHERE. The button is on
   * the hotbar; the category is not on the sheet.
   *
   * ═══ WHY THIS IS A REAL PROPERTY AND NOT AN EXEMPTION FOR ONE TREE ═══
   * `talent-trees.test.ts` requires every tree to hold exactly `CELLS_PER_CAT`
   * talents, because the panel slices at six and a short strip reads as content
   * that failed to load rather than as a tree with room in it. That rule is
   * right, and an inscription tree can never satisfy it: a character carries at
   * most `MAX_INSCRIPTIONS` of them, which is three. The two facts are only
   * compatible because the tree is never drawn — so the guard is exempted
   * THROUGH THE SAME FLAG THE PANEL READS, and a tree that starts drawing
   * itself starts being counted again in the same edit. An exemption keyed on
   * the tree's id would have let the strip come back unmeasured.
   *
   * A HIDDEN TREE STILL GRANTS ITS BUTTONS. This hides a heading, not a talent:
   * `sheetForClass` joins the actives on regardless and the bar draws them, which
   * is exactly the split upstream has.
   */
  readonly hidden?: boolean;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY TALENTS THIS TREE SHIPS. Absent means the usual six.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `talent-trees.test.ts` requires every tree to hold exactly `CELLS_PER_CAT`,
   * and the reason is drawn rather than arithmetic: *"a tree with four draws a
   * gap in a row of boxes, which reads as a talent that failed to load rather
   * than as a tree with room in it"*. That rule is right about accidents and
   * wrong about upstream, where tree sizes vary freely — `race/higher` has four
   * (misc/races.lua:37-140) and `LevelupDialog` draws a variable-length list.
   *
   * ═══ IT IS A DECLARATION, NOT A RELAXATION ═══
   * The guard still demands an EXACT count; this only says which count. A tree
   * that loses a talent still fails, and a tree that is short by accident still
   * fails — what stops failing is a tree that is short ON PURPOSE and says so.
   * `ui/talents.ts` centres a strip below the full width, so a declared-short
   * tree reads as deliberate rather than truncated.
   */
  readonly size?: number;
};

/**
 * THE SIX. Ordered per class, and the order is the panel's order — the tree a
 * player is expected to open with comes first.
 */
export const TALENT_TREES: readonly TalentTree[] = Object.freeze([
  {
    id: 'watch/discipline',
    mastery: 1,
    name: 'Discipline',
    classId: ClassId.Watchman,
    blurb: 'Hitting the thing in front of you, correctly.',
  },
  {
    id: 'watch/the-line',
    mastery: 1,
    name: 'The Line',
    classId: ClassId.Watchman,
    blurb: 'Standing where somebody else would have been hit.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE WATCHMAN'S THIRD, AND THE FIRST TREE IN THE GAME GATED ON WILLPOWER.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `watch/discipline` is hitting the thing in front of you and
     * `watch/the-line` is being hit instead of somebody else. Both are good and
     * both answer the same question — what to do about the body already in
     * reach — and between them the class had nine talents, every one of which
     * was a blow. Nothing a Watchman owned was about the OTHER PEOPLE in the
     * room, which is a strange gap in the class whose whole job is a doorway.
     *
     * ═══ AND IT GIVES THE CLASS A THIRD ATTRIBUTE ═══
     * Discipline is Strength, the Line is Constitution, and this is Will.
     * Authority is a thing you have rather than a thing you can lift, and
     * upstream agrees — its warcries check Willpower. Three stats across three
     * trees is what makes 157 attribute points a set of decisions rather than a
     * formality, and it is the first real fork in what a Watchman can BE.
     *
     * ═══ IT COULD NOT HAVE EXISTED A WEEK AGO ═══
     * A class tree must mix actives and passives (talent-trees.test.ts), an
     * active needs a hotbar slot, and the bar held exactly six FIXED ones — so
     * `_loadoutArityCheck` required exactly six actives and no class could grow
     * a third discipline with a button in it. The rebindable, two-page bar is
     * what unblocked this, and it was built for this.
     */
    id: 'watch/authority',
    mastery: 1,
    name: 'Authority',
    classId: ClassId.Watchman,
    blurb: 'Being the reason other people do what they do.',
  },
  {
    id: 'index/marksmanship',
    mastery: 1,
    name: 'Marksmanship',
    classId: ClassId.Inspector,
    blurb: 'Reaching what has not reached you yet.',
  },
  {
    id: 'index/fieldcraft',
    mastery: 1,
    name: 'Fieldcraft',
    classId: ClassId.Inspector,
    blurb: 'Being somewhere else by the time it looks.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE INSPECTOR'S THIRD, AND THE FIRST TREE IN THE GAME WITH A STANCE IN IT.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `index/marksmanship` is damage at range and `index/fieldcraft` is getting
     * away. Both are good and both assume the gap already exists — nothing this
     * class owned was about KEEPING one, or about how it was working a room
     * rather than what it was shooting at.
     *
     * ═══ IT EXISTS BECAUSE OF A MEASURED PROBLEM ═══
     * `tools/first-fight.mjs`, twenty-four openings per class: the Watchman
     * wins 24/24 in ten turns, the Alchemist 24/24 in six, and THE INSPECTOR
     * WINS 22/24 IN TWENTY-THREE — the two losses being stalls, kiting
     * something it cannot kill fast enough in a room too small to kite in.
     * Line of Enquiry fixes the front of that fight and Closed File the back.
     *
     * ═══ AND IT IS WHERE THE STANCE SYSTEM FINALLY GETS USED ═══
     * `Talent.sustain`, `sustainSlot`, `toggleSustain`, `sheet.sustained`,
     * `PassiveView.isSustained`, the gateway's toggle branch and the wire's
     * `sustained` flag were all built, all correct, and reachable by NOTHING —
     * `TalentKind.Sustained` said *"Nothing implements this yet"* in as many
     * words. Careful Method and Working Fast share one slot, so an Inspector is
     * always working a scene one way or the other and never both.
     */
    id: 'index/method',
    mastery: 1,
    name: 'Method',
    classId: ClassId.Inspector,
    blurb: 'How you are working this one, and what that is worth.',
  },
  {
    id: 'ashwick/reagents',
    mastery: 1,
    name: 'Reagents',
    classId: ClassId.Alchemist,
    blurb: 'What comes out of the bag and what it does to a room.',
  },
  {
    id: 'ashwick/ministration',
    mastery: 1,
    name: 'Ministration',
    classId: ClassId.Alchemist,
    blurb: 'Keeping the people around you upright.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ALCHEMIST'S THIRD, AND THE ONLY TREE THAT ADDS NO NEW BUTTON.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `ashwick/reagents` is what comes out of the bag and `ashwick/ministration`
     * is keeping the people around you upright. Between them the class had six
     * things to press and no reason to press any of them differently on
     * different nights.
     *
     * ═══ IT MAKES THE EXISTING THROWS DEEPER RATHER THAN ADDING MORE ═══
     * Three stances on one slot, and none is a button that does damage: what
     * they change is what Ashwick Flare, Alchemic Vial and Concussion Flask
     * LEAVE BEHIND. The same three buttons are a bleed, a slow or a stun
     * depending on how the bag was packed. That is upstream's own shape —
     * explosives.lua:44-51 is a five-branch if-chain on which infusion is up,
     * and `Talent.sustainSlot` has cited it since the field existed.
     *
     * ═══ CUNNING, WHICH IS THE THIRD STAT THIS CLASS DID NOT HAVE ═══
     * Reagents is Magic and Ministration is Will. Knowing which vial to reach
     * for is neither of those.
     */
    id: 'ashwick/loads',
    mastery: 1,
    name: 'Loads',
    classId: ClassId.Alchemist,
    blurb: 'What is in the vial before you throw it.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE REDACTOR'S FIRST — what you strike from the record.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * The mark tree. Every active in it puts a detrimental effect on something,
     * which is not a theme so much as the class's income statement: Ink pays
     * `INK_PER_MARK` when a mark LANDS, so this tree is where the resource comes
     * from and the other one is where it goes.
     *
     * CUNNING, which with `ledger/testimony`'s Will is the pair
     * `combatMindpower` is fed by — 0.7 Wil + 0.4 Cun, Combat.lua:2076, the only
     * power in the game fed by two stats. See `indelible.ts`: the class's stat
     * spread is the shape the engine already rewards rather than flavour laid
     * over it.
     */
    id: 'ledger/redaction',
    mastery: 1,
    name: 'Redaction',
    classId: ClassId.Redactor,
    blurb: 'What you strike from the record, and what it costs the thing you struck.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE REDACTOR'S SECOND — what the record says once you have written in it.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Where `ledger/redaction` earns, this tree spends and endures: two stances
     * on one slot, two saves, a blow that does not go all the way in, and a
     * capstone that reaches through a wall.
     *
     * ═══ THE STANCES ARE WHY THIS CLASS FEELS ITS RESERVE ═══
     * A sustain holds resource back. For an Inspector that is Focus she was not
     * spending. For a Redactor it is Ink, and Ink is what marks are made of — so
     * standing in a stance means fewer marks, and fewer marks means less income.
     * No other class in this game pays for a stance out of the thing it needs to
     * earn more of. See `ledger_stances.ts`.
     */
    id: 'ledger/testimony',
    mastery: 1,
    name: 'Testimony',
    classId: ClassId.Redactor,
    blurb: 'What the record says once you have written in it, and how hard you are to rewrite.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE REDACTOR'S THIRD — corrections, including to where you were standing.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `ledger/redaction` earns and `ledger/testimony` spends, and between them
     * the class had eleven things to do TO a body and not one place to stand.
     * A Redactor is life rating 8 with no armour answer by design; the turn
     * something closed the gap, it had no move at all.
     *
     * ═══ IT IS THE ALCHEMIST'S THIRD-TREE PROBLEM WITH A DIFFERENT ANSWER ═══
     * `ashwick/loads` deepened three buttons rather than adding more, because
     * that class already had six things to press and no reason to press them
     * differently. This class's gap is not variety, it is POSITION — so the
     * third tree adds the axis the other two do not touch, and two of its three
     * actives are worth pressing with nothing in range at all.
     *
     * CUNNING, shared with `ledger/redaction` rather than reaching for a third
     * stat. `combatMindpower` is 0.7 Wil + 0.4 Cun and nothing else this class
     * owns cares about a third; a tree gated on Dexterity would be five talents
     * asking a Redactor to raise a stat that moves none of their numbers.
     */
    id: 'ledger/errata',
    mastery: 1,
    name: 'Errata',
    classId: ClassId.Redactor,
    blurb: 'Corrections to the record, including where you were standing.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE ORIGIN'S OWN — `newTalentType{ type="race/higher" }`, misc/races.lua:37.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * THREE TALENTS OF UPSTREAM'S FOUR. `race/higher` ships Gift of the
     * Highborn, Overseer of Nations, Born into Magic and Highborn's Bloom; only
     * BORN INTO MAGIC is missing, and it is missing for a stated reason rather
     * than an oversight: it grants `resists` in ARCANE, a damage type this game
     * does not have, and a `combat_spellresist` bonus with no channel feeding
     * it. Adding a whole damage type for one racial passive is a content
     * decision, not a transcription. `size` is that fact declared rather than a
     * guard quietly relaxed — see `TalentTree.size`.
     *
     * NOT HIDDEN, unlike `generic/inscriptions`. Upstream marks the inscription
     * categories `hide = true` (misc/misc.lua:23) and does NOT mark this one: it
     * is a category a Higher can see, and this is where Gift of the Highborn
     * belongs. It sat in the hidden inscriptions tree until this commit, which
     * kept it off a stub strip at the cost of filing it under something it is
     * not.
     *
     * ═══ THE PURSE IS UNREACHABLE, AND THERE IS A TRIPWIRE FOR THE DAY IT IS NOT ═══
     * Upstream's type carries `generic = true`, and ours decides the purse from
     * the `generic/` PREFIX — `isGenericTree` lives in `src/shared/`, which may
     * not read this table, so the prefix is the only signal it has. A `race/`
     * tree therefore reads as a CLASS tree.
     *
     * That is inert today: the one talent here is `maxLevel: 1`, so no point can
     * ever be spent on it and neither purse is ever charged. `talent-trees.test.ts`
     * FAILS if a `race/` tree ever holds a raisable talent, so the day this
     * becomes a real question it is a red test rather than a wrong purse.
     */
    id: 'race/higher',
    mastery: 1,
    name: 'Higher',
    classId: null,
    size: 3,
    blurb: 'What was written into you before you went looking.',
  },
  {
    /**
     * THE ONE EVERY CLASS CARRIES. See `TalentTree.classId` for why it is shared
     * rather than tripled, and `talent-trees.test.ts` for why it is allowed to
     * be entirely passive when a class tree is not.
     */
    id: 'generic/groundwork',
    mastery: 1,
    name: 'Groundwork',
    classId: null,
    blurb: 'What everyone is taught, whatever they went on to become.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * WHAT IS WRITTEN ON YOU — the category no class owns and no point buys.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Ported from `inscriptions/infusions` (ToME's own category path). Upstream
     * keeps inscriptions on the ACTOR (`ActorInscriptions.lua:26-32`), so a
     * talent in here reaches a bar through `Actor.inscriptions` and
     * `sheetForClass` rather than through any `ClassDef` — the third route to a
     * button, beside 'your class has it' and 'you bought it'.
     *
     * `classId: null` for `generic/groundwork`'s reason: it is shared rather
     * than tripled. Unlike that one it is NOT entirely passive — an infusion is
     * a button — which is fine here because the all-passive allowance
     * `talent-trees.test.ts` grants the shared trees is a permission, not a
     * requirement.
     */
    id: 'generic/inscriptions',
    // `hide = true` (misc.lua:23) — see `TalentTree.hidden`. An infusion is not
    // a discipline you train; it is a thing written on you.
    hidden: true,
    mastery: 1,
    name: 'Inscriptions',
    classId: null,
    blurb: 'Written on the skin, and it answers when you ask.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE SECOND SHARED CATEGORY, AND THE FIRST THAT IS NOT SIX FLAT NUMBERS.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `generic/groundwork` grants armour, defence, accuracy, two saves and a
     * Constitution — six unconditional increments, which is right for a tree
     * called what everyone is TAUGHT and wrong as the only shared tree there is.
     * Every talent in this one is worth a different amount depending on what is
     * happening: how hurt you are, whether you moved, how many things are in
     * reach, how much of your class resource is gone. That is what makes buying
     * one a decision rather than a purchase.
     *
     * ═══ AND IT EXISTS BECAUSE THE POINTS HAD NOWHERE TO GO ═══
     * A character reaches the cap with 42 generic points against six talents
     * five ranks deep — 29 buyable ranks once the birth grant is taken off. A
     * THIRD of every generic point in a career was unspendable, which is not a
     * balance problem but a missing-content one: upstream runs about 0.4 points
     * per available rank and this game ran 1.45. Twelve talents halves that; the
     * trees after this one close it.
     */
    id: 'generic/nightshift',
    mastery: 1,
    name: 'Nightshift',
    classId: null,
    blurb: 'What too many of them does to a body, and what a body does back.',
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * THE FIRST LOCKED TREE IN THE GAME. See `TalentTree.locked`.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * Nobody starts with it and no class owns it. It costs one of the three
     * category points a character is handed in a whole career, and what it
     * sells is the two live combat channels that sixty-six talents had never
     * granted between them: armour penetration and the width of a damage roll.
     */
    id: 'generic/leverage',
    mastery: 1,
    name: 'Leverage',
    classId: null,
    blurb: 'Where a thing comes apart, and what it costs to find out.',
    locked: true,
  },
  {
    /**
     * THE SECOND LOCKED DISCIPLINE. See `TalentTree.locked`.
     *
     * Where Leverage is about hitting something that is resisting you, this is
     * about not being where it swings. It is also the first thing in the game
     * that moves a character further than the class they picked — `maxMp` came
     * off the class table and stayed there for a whole career.
     */
    id: 'generic/legwork',
    mastery: 1,
    name: 'Legwork',
    classId: null,
    blurb: 'Getting there, and getting out.',
    locked: true,
  },
  {
    /**
     * THE THIRD AND LAST LOCKED DISCIPLINE, and the one that fills the third
     * category point. See `TalentTree.locked`.
     *
     * It reads the status table, which twelve talents have been WRITING to
     * since the effect system landed and not one has ever read. Being afflicted
     * could only be a cost; this is the discipline where it is also a state.
     */
    id: 'generic/nerve',
    mastery: 1,
    name: 'Nerve',
    classId: null,
    blurb: 'Working through it, and what that is worth.',
    locked: true,
  },
  {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * COMPOSURE — the fourth locked discipline: being outnumbered, and staying.
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `PassiveView` offers four questions and three of them were answered.
     * `hpFraction` has five talents; `adjacentAllies` is the Watchman's and
     * `watch/authority` is built on it. `adjacentEnemies` is asked by four
     * talents and every one asks it in order to LEAVE — `generic/legwork`'s
     * disengage and the Inspector's kiting.
     *
     * Nothing was about being surrounded and STAYING, which in a party of three
     * to six is where somebody ends up every fight.
     *
     * SIX PASSIVES AND NO BUTTON, like the other three locked trees. A category
     * point buys a discipline; one that also handed out an active would be
     * competing for bar space with the class it landed on.
     */
    id: 'generic/composure',
    mastery: 1,
    name: 'Composure',
    classId: null,
    blurb: 'Being outnumbered, and what a body does about it.',
    // BOUGHT WITH A CATEGORY POINT, like the other three. See `TalentTree.locked`.
    locked: true,
  },
]);

const BY_ID = new Map(TALENT_TREES.map((tree) => [tree.id, tree]));

/** The tree, or undefined for an id nothing authored. */
export function treeById(id: string): TalentTree | undefined {
  return BY_ID.get(id);
}

/**
 * Every tree a class owns, in panel order — ITS OWN, THEN THE SHARED ONES.
 *
 * The order is the panel's, and generic last is deliberate: a player opening
 * this screen is looking for what makes their class their class, and ToME puts
 * combat-training below the class categories for the same reason.
 */
export function treesFor(classId: ClassId): readonly TalentTree[] {
  return [
    ...TALENT_TREES.filter((tree) => tree.classId === classId),
    ...TALENT_TREES.filter((tree) => tree.classId === null),
  ];
}
