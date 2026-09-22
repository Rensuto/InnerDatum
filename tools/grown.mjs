// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// ═══════════════════════════════════════════════════════════════════════════
// A PROBE BODY THAT SOMEBODY COULD ACTUALLY BE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Every difficulty probe in this directory builds its character the same way —
// `addPlayer`, `p.combat = cls.combat`, `sheetForClass(cls)` — and that body is
// LEVEL 1, WEARING NOTHING, with four birth talents at rank 1. For the opening
// ambush that is nearly right: the classes have no starting kit, so a level-1
// body with an empty doll is the honest measurement of the first fight.
//
// ═══ EXCEPT FOR THE ONE THING IT IS BORN WEARING, AND THAT WAS THE BUG ═══
// This header used to finish that sentence with "a brass lantern (`grantBirthKit`
// in the gateway), WHICH MOVES NO COMBAT NUMBER". It moves the only one that
// decides whether the body can see: `liteRadiusOf` is `combat.mods.lite`, and
// SIGHT SPENDS LIGHT. See `bearBirthKit` at the bottom for what one tile of
// vision did to five delves' worth of numbers.
//
// It is the WRONG body for everything after it. `delve-run.mjs` sends that
// character into all sixteen delves and reports 0 of 8 on every row — including
// the deepest, which a real party reaches after twenty levels and a lot of
// gear. A number measured against a character nobody has ever played is not a
// difficulty measurement; it is a measurement of the probe.
//
// ═══ WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT ═══
//
// It grows the two things the server would have grown by the time a player got
// there — STATS and HIT POINTS — and spends the talent points that came with
// them. It does NOT invent a levelling path: the stats go round-robin down the
// class's own sheet, the same deal `monsters.ts` makes for `autoStats`, so the
// character is the straightforward build rather than an optimised one, and that
// is the honest baseline for "is this room fair".
//
// ═══ THE SERVER'S PURSES AND THE SERVER'S REFUSALS, OR IT IS NOT A PLAYER ═══
// Both halves used to be the probe's own arithmetic. The stats came from
// `statPointsGainedTo` — the MONSTER formula (shared/leveling.ts), which has no
// birth term and no ceiling — so a level-2 Watchman stood at Strength 25 where
// `statCeilingForLevel(2)` is 22.8 and `handleSpendStat` would have refused
// the point. The talents went round-robin with no tier gate, so a level-3 body
// held a tier-3 rank the server opens at level 8. Now every point is one the
// server would have seeded (`totalStatPointsAtLevel`, `totalPointsAtLevel` —
// `seedFreshPurses` in net/gateway.ts) and every spend asks the question the
// server asks (`canRaiseStat` over `boughtSheet`, `checkTier` over the composed
// sheet). A point the server would refuse stays in the purse, as it would for a
// player, and `levelOnTheFloor` tries it again at the next level.
//
// GEAR IS ROLLED FROM THE GAME'S OWN TABLE, never authored here. `rollLoot` is
// what the floor uses, so a grown body wears what the floor would have given it
// by that level — which is the whole point, and is why this takes an `Rng`
// rather than picking the best of everything.

import { maxLifeFor, PLAYER_RANK } from '../src/shared/leveling.ts';
import {
  canRaiseStat,
  isGenericTree,
  totalPointsAtLevel,
  totalStatPointsAtLevel,
  TALENT_MAX_LEVEL,
} from '../src/shared/progression.ts';
import { checkTier } from '../src/shared/tiers.ts';
import { registerAllTalents, spendByPurse } from '../src/server/content/classes.ts';
import { classPointBonus, originOf } from '../src/server/content/origins.ts';
import { rollLoot, bandFor } from '../src/server/content/loot.ts';
import { ITEMS, birthKitFor } from '../src/server/content/items.ts';
import { resolveItem } from '../src/server/content/resolve.ts';
import {
  EffectStatus,
  boughtSheet,
  effectsOn,
  recomposeCombat,
} from '../src/server/engine/effects.ts';
import {
  TalentKind,
  effectiveResourceMax,
  talentLevelOf,
  toggleSustain,
} from '../src/server/engine/talents.ts';
import { maxLifeOf } from '../src/server/engine/pools.ts';
import { stat as statValue } from '../src/server/engine/derived.ts';
import { ActorKind, Slot, SLOT_ORDER } from '../src/shared/protocol.ts';
import { visionOf } from '../src/server/view/eyesight.ts';
import { rememberSeen } from '../src/shared/vision.ts';

/**
 * WHICH STATS A CLASS GROWS INTO, in the order it grows them.
 *
 * DERIVED FROM THE CLASS RATHER THAN LISTED, so a fourth class needs no edit
 * here and a rebalance of an existing one cannot leave this table stale: the
 * order is simply the class's own sheet, biggest first. A Watchman built around
 * Strength grows Strength; an Alchemist grows Magic. That is what a player does
 * without thinking about it, and a hand-written table would be a second opinion
 * about what each class is for.
 */
function growthOrder(cls) {
  const stats = cls.combat?.stats ?? {};
  return Object.keys(stats)
    .filter((key) => (stats[key] ?? 0) > 0)
    .sort((a, b) => (stats[b] ?? 0) - (stats[a] ?? 0));
}

/** The content registry, built once, for a caller that has no engine to hand. */
let CONTENT_REGISTRY;
function contentRegistry() {
  CONTENT_REGISTRY ??= registerAllTalents();
  return CONTENT_REGISTRY;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GROW A BODY TO `level`, the way the server would have.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ORDER IS LOAD-BEARING AND IS `monsters.ts`'s: stats FIRST, then the pool,
 * because `maxLifeFor` pays for Constitution ABOVE the class's own and a pool
 * sized before the stats exist cannot include it. That file records the same
 * thing as a bug it once had — *"THIS USED TO COME AFTER `maxHp`, AND THE ORDER
 * WAS THE BUG"*.
 *
 * ═══ THE PURSE IS THE SERVER'S, AND SO IS EVERY REFUSAL ═══
 * `totalStatPointsAtLevel` is what `seedFreshPurses` (net/gateway.ts) hands a
 * character of this level, and the points go through `spendBankedStats` — the
 * loop the floor already spends with, which asks `canRaiseStat` of exactly what
 * `handleSpendStat` asks it of. This used to be `statPointsGainedTo(level,
 * PLAYER_RANK)` dealt by `spreadStatPoints`: the MONSTER formula, with no birth
 * term and no ceiling, so a level-2 Watchman was built at Strength 25 against
 * a ceiling of 22.8 — a body the server refuses to create.
 *
 * ═══ AND IT RUNS AT LEVEL 1 ═══
 * There was a `level <= 1` early return. A level-1 character has whatever the
 * level-1 purse holds — nothing today, and the birth grant the day one lands —
 * and a probe that skipped the purse at level 1 would never see that change.
 * With nothing to spend, a level-1 body comes out exactly as it went in: the
 * class sheet, by reference, and the class's own pool.
 *
 * ═══ THE LEDGER, NOT A SECOND CLASS SHEET ═══
 * `baseCombat` is the CLASS sheet and `spentStats` the points bought, which is
 * how the server holds them (`boughtSheet` folds one onto the other, and
 * `recomposeCombat` does it again with gear). The old body wrote the grown
 * stats INTO `baseCombat`; the composed numbers are the same either way, but
 * only this shape lets the floor's spends continue the same ledger and lets a
 * test count what was spent.
 *
 * Returns the body, so a caller can chain.
 */
export function growTo(body, cls, level) {
  body.level = level;
  body.baseCombat = cls.combat;
  // A FRESH LEDGER. Growing a body is its whole career from the class sheet;
  // points already on it would be bought twice.
  delete body.spentStats;
  body.unspentStatPoints = totalStatPointsAtLevel(level);
  spendBankedStats(body, cls);
  // THE LIVE SHEET, folded the server's way. No gear yet — the caller dresses
  // the body and `recomposeCombat` folds the doll on top of this.
  body.combat = boughtSheet(body, body.baseCombat);

  // AND THE POOL THE STATS JUST EARNED. `conAbove` is exactly what
  // `engine/pools.ts#maxLifeOf` passes — the Constitution over the class's own.
  const conAbove = statValue(body.combat, 'con') - statValue(cls.combat, 'con');
  body.maxHp = maxLifeFor(cls.maxHp, cls.lifeRating, level, PLAYER_RANK, conAbove);
  body.hp = body.maxHp;
  return body;
}

/**
 * THE TALENT POINTS THAT CAME WITH THOSE LEVELS, spent down the loadout.
 *
 * ROUND-ROBIN ACROSS THE CLASS'S OWN TALENTS, refused wherever the server
 * refuses. Like the stat spread this is the straightforward build
 * rather than a good one — a probe that measured an optimised character would
 * be answering a question no first-time player is asking.
 *
 * `points` is a Map on the sheet and rank 1 is what `NotLearned` tests, so this
 * writes the same field `spend_point` does.
 *
 * ═══ THE PURSE IS `totalPointsAtLevel`, LESS WHAT THE SHEET HAS SPENT ═══
 * That is `seedFreshPurses` for a fresh sheet and `restoreProgression`'s
 * arithmetic for any other — the total the level grants, minus `spendByPurse`,
 * the ledger the restore path reads (main.ts#talentSpendOf). It was a sum of
 * `pointsForLevel` from level 2, which is the same number today and stops being
 * the same number the moment the total grows a birth term.
 *
 * ═══ WITH THE ORIGIN'S BONUS, BECAUSE THERE IS NO SUCH THING AS NO ORIGIN ═══
 * The server asks `totalPointsAtLevel(level, classPointBonus(origin))`, and a
 * body with no `origin` is `originOf(undefined)` — the default, Cityborn, one
 * point at birth and one every ten levels (human.lua:128-132, :142-143). The
 * first version left the bonus out and measured a body no player can be:
 * Cityborn's stats with a purse 1 short at level 1 and 6 short at level 50.
 *
 * ═══ EVERY RANK ASKS THE TIER GATE FIRST ═══
 * `serverWouldRaise` below is main.ts#raiseTalentPoint's question, so the body
 * has to come along: the gate reads its level and its composed stats. Without
 * it this bought tier-3 and tier-4 ranks at level 3 that the server opens at 8
 * and 12. A point no talent can take is left in `body.unspentPoints`, which is
 * where the server leaves it, and `levelOnTheFloor` spends it when it opens.
 *
 * `registry` defaults to the content registry; pass the engine's where there
 * is one.
 *
 * @returns how many points were spent.
 */
export function spendPointsTo(sheet, cls, level, body, registry = contentRegistry()) {
  if (body === undefined) {
    throw new Error('spendPointsTo needs the body: the tier gate reads its level and its stats');
  }
  const spent = spendByPurse(sheet, cls, (id) => registry.get(id)?.tree).class;
  const bonus = classPointBonus(originOf(body.origin));
  body.unspentPoints = Math.max(0, totalPointsAtLevel(level, bonus) - spent);
  return spendClassPoints(body, sheet, cls, registry);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WOULD THE SERVER TAKE THIS POINT? — the spend path's refusals, in its order.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   THE PURSE      `handleSpendPoint` pays a `generic/` tree from the generic
 *                  purse. This probe spends only the class purse, so a
 *                  generic talent is not something it may buy.
 *   THE CAP        `talent.maxLevel ?? TALENT_MAX_LEVEL` (`toLoadoutView`'s
 *                  `maxLevel`, which `handleSpendPoint` refuses at), and
 *                  `raiseTalentPoint`'s own `TALENT_MAX_LEVEL`.
 *   NOT A RANK     an id with no entry in `points` is not on this sheet, and
 *                  `raiseTalentPoint` answers null.
 *   THE LADDER     `checkTier`, with the context `raiseTalentPoint` builds:
 *                  the rank AFTER the point, the COMPOSED stat, the body's
 *                  level, and the OTHER talents of the tree at rank 1 or more.
 *
 * `checkTier` is the function the server asks, not a copy of it. The context
 * has to be assembled here because main.ts assembles it inline; it is the same
 * five reads `content/classes.ts#gateFor` makes for the panel, and a test holds
 * this answer against that one.
 */
function serverWouldRaise(body, sheet, id, registry) {
  const talent = registry.get(id);
  if (talent === undefined) return false;
  if (isGenericTree(talent.tree ?? '')) return false;
  const current = sheet.points.get(id);
  if (current === undefined) return false;
  if (current >= (talent.maxLevel ?? TALENT_MAX_LEVEL) || current >= TALENT_MAX_LEVEL) {
    return false;
  }
  const known = [...sheet.points.entries()].filter(
    ([other, rank]) => other !== id && rank >= 1 && registry.get(other)?.tree === talent.tree,
  ).length;
  return checkTier({
    tier: talent.tier,
    rank: current + 1,
    stat: talent.statGate,
    statValue: talent.statGate === undefined ? 0 : (body.combat?.stats?.[talent.statGate] ?? 0),
    characterLevel: body.level ?? 1,
    treeKnown: known,
  }).ok;
}

/**
 * THE ONE ROUND-ROBIN BOTH TALENT SPENDERS USE, down the class loadout.
 *
 * Starts at the top of the loadout every call and skips what the server would
 * refuse, so with nothing refused it deals exactly as the old loop did. Stops
 * when the purse is empty or nothing left can take a point.
 */
function spendClassPoints(body, sheet, cls, registry) {
  const ids = (cls.loadout ?? []).map((t) => t.id);
  let spent = 0;
  if (ids.length === 0) return spent;
  let i = 0;
  while ((body.unspentPoints ?? 0) > 0) {
    let raised = false;
    for (let step = 0; step < ids.length; step += 1) {
      const id = ids[(i + step) % ids.length];
      if (id === undefined) continue;
      if (!serverWouldRaise(body, sheet, id, registry)) continue;
      sheet.points.set(id, (sheet.points.get(id) ?? 0) + 1);
      body.unspentPoints -= 1;
      spent += 1;
      i = i + step + 1;
      raised = true;
      break;
    }
    if (!raised) break;
  }
  return spent;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE SLOT WHERE A UNIFORM ROLL IS NOT A ROLL, IT IS A DIFFERENT GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dressFor` draws a uniformly random BASE for every slot. For a coat or a ring
 * that is the honest reading of "what would this character be wearing" — the
 * bands differ by a few points of armour. For the LITE slot it is not, because
 * `liteRadiusOf` is the only number in the game that decides whether a ranged
 * class can see far enough to shoot, and the three lamps are 2, 3 and 4 tiles.
 *
 * MEASURED: a level-2 probe body had a ONE IN THREE chance of the Dwarven
 * Lantern. Upstream's own `level_range` for that item is {35, 50}
 * (data/general/objects/lites.lua:59-70) — a level-2 character cannot see one.
 * Every per-class number this directory has printed above level 1 in the five
 * unlit caves was taken on a lamp nobody at that level owns.
 *
 * ═══ IT IS UPSTREAM'S OWN RULE AND NOT A PATCH OVER A SYMPTOM ═══
 * `level_range` is exactly the gate `Zone.lua:217-221` applies to a monster
 * before it may be rolled, and `src/server/content/rarity.ts` ports it. Items
 * here carry a `tier` rather than a range, so the three ranges are written out
 * from the file they were ported from — `items.ts` cites the same lines in its
 * own docblock, brass 1-20, lamp 20-35, dwarven 35-50.
 *
 * A LEVEL OUTSIDE EVERY RANGE KEEPS THE BRASS LANTERN, which is what a
 * character is born wearing (`BIRTH_KIT`) and therefore the only honest floor.
 */
const LITE_LEVEL_RANGE = new Map([
  // data/general/objects/lites.lua:30-41, :44-55, :59-70.
  ['item_brass_lantern', [1, 20]],
  ['item_alchemists_lamp', [20, 35]],
  ['item_dwarven_lantern', [35, 50]],
]);

/** Could a character of this level have found this lamp? `Zone.lua:217-221`. */
function litAtLevel(id, level) {
  const range = LITE_LEVEL_RANGE.get(id);
  if (range === undefined) return true;
  return level >= range[0] && level <= range[1];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRESS A BODY IN WHAT THE FLOOR WOULD HAVE GIVEN IT BY NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE ROLL PER SLOT, through `rollLoot` — the same function the delve litter and
 * a monster's drop both use — at the band this level actually sees. So the
 * character wears the game's own idea of level-`n` gear, egos and all, rather
 * than a hand-picked set that would flatter the numbers.
 *
 * SEEDED, and the caller supplies the rng: two runs of one seed must dress the
 * same character, or the difficulty table stops being comparable with itself.
 *
 * A SLOT WITH NO BASE IN THE CATALOGUE IS LEFT EMPTY rather than filled with
 * something from another slot — `validateItems` guarantees every slot has at
 * least one item today, and if that ever stops being true a bare shoulder is a
 * better answer than a coat worn on the head.
 */
export function dressFor(body, level, rng) {
  const worn = {};
  for (const slot of SLOT_ORDER) {
    const bases = ITEMS.filter((item) => item.slot === slot).filter((item) =>
      slot === Slot.Lite ? litAtLevel(item.id, level) : true,
    );
    if (bases.length === 0) continue;
    const base = bases[rng.int(`grown.dress.${slot}`, 0, bases.length - 1)];
    if (base === undefined) continue;
    // THE BASE'S ID, NOT THE ROW: `rollLoot` takes a catalogue id and returns
    // one with any ego folded in, exactly as `delve.ts`'s litter does.
    const rolled = rollLoot(rng.fork(`grown.dress.roll.${slot}`), base.id, level);
    // RESOLVED BEFORE IT IS WORN, so an id the catalogue cannot answer for never
    // reaches the doll — the same check `handleEquip` makes.
    if (resolveItem(rolled) === undefined) continue;
    /**
     * ═══ A GUNMAN DOES NOT PUT HER GUN DOWN FOR A MAUL ═══
     * The roll is class-blind, and for one class that is not a character
     * anybody plays. Every mainhand in the catalogue is a melee weapon, and
     * with one in her hand the Inspector's six gun talents refuse
     * (`archerPreUse`, engine/talents.ts — upstream's own `on_pre_use`), so a
     * player who picked one up would be told *"you need your gun in your hand"*
     * and put it back. Measured before the refusal existed: 35 of 40 dressed
     * Inspector rows were holding a melee weapon; after it, those rows measured
     * a gunless melee body, and her first hour read 14 of 28 instead of 19.
     *
     * DRAWN AND THEN LEFT ON THE FLOOR, not skipped: the draw above has
     * already been taken, so every other slot on this body is rolled exactly as
     * before and the rows stay comparable with every table printed before this.
     */
    if (slot === Slot.Mainhand && body.combat?.weapon?.archery === true) {
      if (resolveItem(rolled)?.combat?.archery !== true) continue;
    }
    worn[slot] = rolled;
  }
  body.equipped = worn;
  return body;
}

/** The loot band this level sees, exported so a probe can print what it dressed at. */
export function bandAt(level) {
  return bandFor(level);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LANTERN. EVERY CHARACTER IN THIS GAME IS BORN WEARING ONE AND NO PROBE
 * HAS EVER PUT IT ON, SO EVERY DARK DELVE WAS MEASURED ON A BLIND BODY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The header above says the empty doll is "still the honest measurement of the
 * first fight" because the lantern "moves no combat number". That is true of
 * `armour`, `atk` and every other field on the sheet, and it is the wrong test:
 * `liteRadiusOf` reads `combat.mods.lite`, and SIGHT SPENDS LIGHT (CLAUDE.md
 * § 4). The lantern moves the only number that decides whether a body can see
 * anything at all.
 *
 * ═══ MEASURED, ON THE FIVE DARK CAVES, BEFORE THIS EXISTED ═══
 * `visionOf` for a probe body standing on the arrival tile, averaged over three
 * seeds — tiles SEEN out of ~1000 walkable, and the level's own lit tiles:
 *
 *     delve              level lit   seen without   seen with
 *     The Underworks           0          1.0         10.0
 *     The Hollow Mine          0          1.0         12.3
 *     The Outer Index          0          1.0         11.0
 *     The Weir                 0          1.0         10.3
 *     The Undermost            0          1.0         12.0
 *
 * ONE TILE. Its own. `computeVision` has exactly that branch — `radii.lite <= 0`
 * sees the eye's own grid and stops (class/Player.lua:653) — and a cave lights
 * nothing (`SHAPE_LIGHTING`, `litRoomChance: 0`). So `lineOfSightFor` handed a
 * PLAYER-kind body `playerLineClear` over a seen set of one tile and a memory of
 * none, and every shot past a neighbour came back `no_los`. The probes then
 * charged that to the class.
 *
 * MIRRORS THE GATEWAY'S `grantBirthKit` and deliberately not more than that:
 * worn when the slot is free, and the SHEET REBUILT, because a lantern worn and
 * not folded onto `combat.mods` is the "correct value with no reader" this
 * repository keeps shipping. The bag path is the gateway's problem; a probe body
 * has an empty doll.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS `birthKitFor`, NOT `BIRTH_KIT` — THE KIT IS PER CLASS NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `BIRTH_KIT` is upstream's UNIVERSAL half (`descriptors.lua:75-77`, the brass
 * lantern). The other half is `resolvers.equipbirth`, authored on every SUBCLASS
 * descriptor and different for all four — a sword, a shield and mail for the
 * Bulwark (warrior.lua:175-179), leather for the Archer (:241-245), a robe with
 * no `wielder` table at all for both casters (mage.lua:104-107,
 * afflicted.lua:155-159).
 *
 * A probe that dressed every body in a lantern alone was measuring a character
 * nobody has ever played — which is `delve-run.mjs`'s own charge against the
 * bodies it used to build, one layer up. `classId` is read off the body, so a
 * probe that never set one keeps exactly the kit it had.
 *
 * `effects` is the status table (`createMvpEffectState`) so `recomposeCombat`
 * folds the doll the same way the server does. Pass `null` where a probe has none.
 */
export function bearBirthKit(body, effects = null) {
  for (const id of birthKitFor(body.classId)) {
    const item = resolveItem(id);
    if (item?.slot === undefined) continue;
    if (body.equipped?.[item.slot] !== undefined) continue;
    body.equipped = { ...body.equipped, [item.slot]: id };
  }
  recomposeCombat(body, effects, resolveItem);
  return body;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE OTHER HALF OF SIGHT: WHAT THE BODY REMEMBERS IT WALKED PAST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `playerLineClear` has two terms — seen, and REMEMBERED — and an in-process
 * probe only ever had the first, because the thing that writes the second lives
 * in the gateway (`rememberWhatPlayersSee`, called after every pump) and a probe
 * drives `realm.engine` directly. So a probe body walked a level and kept
 * nothing: it could not draw a line back down a corridor it had just come up,
 * which a real player can.
 *
 * THE SAME TWO LINES THE GATEWAY RUNS (`revealFor`), and no more: the ways
 * ledger and the save queue are the gateway's business. Call it AFTER the pump,
 * for the same reason the gateway does — the tile a body stands on is only
 * decided when its intent resolves.
 */
export function rememberWhatProbesSee(world) {
  for (const body of world.allActors()) {
    if (body.kind !== ActorKind.Player) continue;
    rememberSeen(world.memoryOf(body.id), visionOf(world, body).remember);
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE THIRD THING NO PROBE HAS EVER DONE: LET THE BODY LEVEL UP MID-FLOOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE RULING THIS EXISTS FOR ═══
 * *"the goal is to level up before encountering the boss at the end. you are not
 * meant to get to the end of the dungeon without leveling at least twice. this
 * is exactly like ToME does."*
 *
 * A delve is a LEVELLING CURVE, not a flat difficulty. Every number this
 * directory has printed measured a character who kills ten things at level 1 and
 * is still, in every way that matters, level 1 at the end of the floor — which
 * is neither this game nor ToME.
 *
 * ═══ THE EXPERIENCE WAS NEVER THE MISSING HALF ═══
 * It is easy to assume a probe has to award its own experience. It does not, and
 * writing one would have been a second copy of the rule: `awardExperience`
 * (engine/scheduler.ts) fires inside the pump the instant something dies, and
 * these probes have always driven the real pump. `level` and `xp` HAVE been
 * moving the whole time.
 *
 * WHAT WAS MISSING IS EVERYTHING A LEVEL BUYS. `applyPendingLevels` banks the
 * talent point, the generic, the three attribute points and the discipline into
 * `unspentPoints` / `unspentStatPoints`, and in production a PLAYER spends them
 * and `refreshPassives` resizes the body. A probe has no player and never wired
 * `refreshPassives`, so a probe body's level counted up while its Strength, its
 * talents and its hit-point ceiling stood exactly where `growTo` left them —
 * and a rising level with a frozen body is strictly WORSE than a frozen level,
 * because the next level costs more (`expChart`) and buys nothing.
 *
 * ═══ THIS IS `refreshPassives`' SEAM, NOT A SECOND OPINION ABOUT LEVELS ═══
 * It is handed to the engine as `onSheetDirty` AND as `talentRuntimeFor`'s
 * `onActBase`, which are the two places main.ts hangs `refreshPassives` — so it
 * runs on exactly the occasions production's does: an arrival that force-levels
 * you, an effect that grants stats, and once per base turn, which is what
 * catches a level gained in the middle of a pump.
 *
 * ═══ AND IT DOES THE PASSIVE FOLD NOW. IT USED NOT TO, AND THAT WAS THE GAP ═══
 * This note read: *"a probe body's PASSIVE talents contribute nothing, at every
 * level ... it biases every number here in the HARD direction"*, on the grounds
 * that the fold is *"a hundred and fifty lines inside `buildServer`"*. It is
 * thirty-five, and `foldPassives` below is those thirty-five — the same walk
 * over `[...sheet.passives, ...sheet.sustained]`, the same `points < 1` skip,
 * the same `talentLevelOf`, the same additive collect into `passiveCombat`,
 * asking the same production functions.
 *
 * THE GAP WAS NOT UNIFORM, WHICH IS WHY IT HAD TO CLOSE. It hid one thing per
 * class and they are not the same size: the Watchman's `standingOrders` is ARMOUR
 * and the other three get offence, so the bias ran against him. And it hid
 * `coldReading`'s `heightened_senses` entirely — a talent whose whole effect is
 * on what a body can SEE, on a class measured at 4% win rate in the dark against
 * 47% in the light. A probe that cannot see the change cannot be asked whether
 * the change worked.
 *
 * ═══ AND A SUSTAIN THAT WAS NEVER LIVE IS THE SAME GAP ONE STEP OVER ═══
 * `foldPassives` walks `[...sheet.passives, ...sheet.sustained]`, and
 * `sheet.sustained` was EMPTY for every probe body at every level — so a class
 * born in a stance contributed nothing from it, and the fold reported "no
 * bias" while carrying one. `raiseBirthSustains` is the other half; the two
 * are called in that order, always, and the order is the rule.
 *
 * IT WAS TWO BUGS WEARING ONE COAT. `fightlib.mjs#selfHelp` selected exactly
 * the shape a sustain has and `takeHelp` returned at the first ACCEPTED
 * submit — and `turn-engine.ts#submitTalent` accepts a sustain without ever
 * routing it through `toggleSustain`. So the stance did not go up AND the heal
 * behind it was never reached: `healing_infusion:ok` over the twelve moor
 * delves was 467 / 2270 / 2468 for the other three classes and **0** for the
 * Redactor. That column was not a fact about the class.
 *
 * WHAT IS STILL NOT HERE: `absorb`. It is the one line of the production fold
 * that reaches a closure rather than the sheet (`absorbShield` keys on an id
 * inside `buildServer`), and no talent any of the four classes owns puts a
 * shield up. Still a bias, still in the hard direction, still said out loud.
 */
export function levelOnTheFloor(body, cls, sheet, effects, ctx = undefined) {
  /**
   * STATS FIRST, AND REFOLDED BEFORE ANY TALENT IS BOUGHT. `handleSpendStat`
   * recomposes the moment a point lands, so a player who raises Willpower and
   * then presses `+` on a Willpower talent is gated on the new figure. The tier
   * gate below reads `body.combat`, so without this refold it would be asking
   * about the body from before this level's three points.
   */
  if (spendBankedStats(body, cls) > 0 && (body.unspentPoints ?? 0) > 0) {
    recomposeCombat(body, effects, resolveItem);
  }
  spendBankedTalents(body, sheet, cls, ctx?.registry);
  foldPassives(body, sheet, effects, ctx);
  // `recomposeCombat` IS THE ONLY WRITER OF `combat` — this writes its inputs
  // and asks it to run, exactly as main.ts#refreshPassives does.
  recomposeCombat(body, effects, resolveItem);
  /**
   * AND HOW MUCH OF THIS BODY THERE IS, from the sheet that was just composed.
   * `maxLifeOf` reads `combat.stats.con` — the live one, gear and all — which is
   * the bug engine/pools.ts exists to record. CLAMPED DOWN AND NEVER UP: a level
   * widens the pool and leaves the blood where it was (Actor.lua:3823), and the
   * one place that heals to the new ceiling is the FORCED level on arrival,
   * which `turn-engine.ts#levelUpOnArrival` does for itself after calling this.
   */
  body.maxHp = maxLifeOf(body, cls, PLAYER_RANK);
  body.hp = Math.min(body.hp, body.maxHp);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `actor.passiveCombat`, REBUILT — main.ts#refreshPassives:1435-1515, condensed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production builds a `PassiveView` over the board, walks the sheet's passives
 * and live sustains, skips anything at rank 0, calls `talent.passive(rank, view)`
 * and adds the `stats`/`mods` blocks up. That is exactly this, and every rule in
 * it is asked of a production function rather than restated:
 *
 *   WHICH RANK      `talentLevelOf` — not the raw point map, which is the one
 *                   place a talent can behave at a rank the panel does not show.
 *   RANK 0 IS NOT   `points.get(id) < 1` skips. A class OWNS more passives than
 *   A TENTH OF ONE  it KNOWS since birth talents landed, and
 *                   `combatTalentScale(0)` would hand the fold a tenth of a
 *                   talent nobody has.
 *   ABSENT, NOT {}  a body with no passives composes byte-identically to one
 *                   from before passives existed.
 *
 * ═══ THE VIEW IS THE HONEST HALF AND `ctx` IS WHY IT IS OPTIONAL ═══
 * Four of the eight questions need the BOARD (who is next to me, how far is the
 * nearest enemy) and the probe's callers have one. A caller that does not —
 * anything building a body outside a world — gets the same fold with an empty
 * board, which is what a body standing alone honestly sees. It is not a second
 * opinion about the rule; it is the same rule asked from a quieter room.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE STANCES A CLASS IS BORN IN, PUT UP — AND IT IS NOT A CONVENIENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A probe body used to reach the first tile of a delve with `sheet.sustained`
 * EMPTY, for ever, at every level. That was harmless while a stance was only a
 * modifier; it stopped being harmless the day a class was BORN in one.
 *
 * ═══ WHAT WAS ACTUALLY WRONG, WHICH IS WORSE THAN "THE DRIVER CANNOT PRESS ONE" ═══
 * `fightlib.mjs#selfHelp` selects `affinity === 'ally' && shape === 'self'`,
 * which is exactly what a sustain is, and `takeHelp` returns at the first
 * submit the engine ACCEPTS. But `turn-engine.ts#submitTalent` never routes a
 * sustain through `toggleSustain` — the only caller of that is the gateway —
 * so the submit was accepted, the stance did not go up, and the chain
 * short-circuited there. Measured over the twelve moor delves:
 * `talent:call_shadows:ok = 2019`, turns with a shadow alive = 0, and
 * `healing_infusion:ok` = 467 / 2270 / 2468 for the other three classes
 * against **0** for the Redactor. The one class in the game that never drank.
 *
 * So there were two bugs wearing one coat: a stance that never rose, and every
 * heal behind it that was never reached. `selfHelp` now refuses a sustain and
 * says why; this is the other half.
 *
 * ═══ BIRTH STANCES ONLY, AND THROUGH THE PRODUCTION TOGGLE ═══
 * What a player does on turn one is put up the stance their class came with.
 * They do not buy one first, so this reads `birthTalents` and not `loadout` —
 * `openLedger` is a Redactor's first PURCHASE now, not her birthright, and a
 * probe that pressed it would be measuring a character nobody starts as.
 *
 * `toggleSustain` is the real seam, with the real refusals: the rank test
 * (`getTalentLevelRaw >= 1`), the slot displacement, and the reservation
 * arithmetic that can answer `NoRoom`. A refusal is left refused and the body
 * fights without it, which is the honest reading of a stance it cannot afford.
 *
 * THE CALLER RE-FOLDS. `foldPassives` walks `[...sheet.passives,
 * ...sheet.sustained]`, so this must run BEFORE it or the stance contributes
 * nothing — which is the same ordering `main.ts#toggleSustain` keeps when it
 * calls `refreshPassives` after the toggle.
 */
export function raiseBirthSustains(cls, sheet, engine) {
  if (sheet === undefined || engine === undefined) return [];
  const up = [];
  for (const talent of cls?.birthTalents ?? []) {
    if (talent.kind !== TalentKind.Sustained) continue;
    const out = toggleSustain(engine, sheet, talent.id);
    if (out?.ok === true && out.on === true) up.push(talent.id);
  }
  return up;
}

export function foldPassives(body, sheet, effects, ctx = undefined) {
  const registry = ctx?.registry;
  const engine = ctx?.engine;
  if (registry === undefined || sheet === undefined) return;
  const world = ctx?.world;
  const neighbours = () =>
    (world?.allActors() ?? []).filter(
      (o) =>
        o.id !== body.id &&
        o.alive &&
        Math.max(Math.abs(o.x - body.x), Math.abs(o.y - body.y)) <= 1,
    );
  const view = {
    adjacentEnemies: () => neighbours().filter((o) => o.kind !== body.kind).length,
    adjacentAllies: () => neighbours().filter((o) => o.kind === body.kind).length,
    hpFraction: () => (body.maxHp > 0 ? Math.max(0, Math.min(1, body.hp / body.maxHp)) : 1),
    resourceFraction: () => {
      if (engine === undefined) return 1;
      const ceiling = effectiveResourceMax(engine, sheet);
      return ceiling > 0 ? Math.max(0, Math.min(1, sheet.resource.value / ceiling)) : 1;
    },
    movedThisTurn: () => sheet.movedThisTurn,
    isSustained: (id) => sheet.sustained.has(id),
    nearestEnemyDistance: () => {
      let best = Number.POSITIVE_INFINITY;
      for (const o of world?.allActors() ?? []) {
        if (o.id === body.id || !o.alive || o.kind === body.kind) continue;
        const d = Math.max(Math.abs(o.x - body.x), Math.abs(o.y - body.y));
        if (d < best) best = d;
      }
      return best;
    },
    afflicted: () =>
      effects === null || effects === undefined
        ? 0
        : effectsOn(effects, body.id).filter(
            (i) => effects.defs.get(i.effectId)?.status === EffectStatus.Detrimental,
          ).length,
  };

  const stats = {};
  const mods = {};
  /**
   * AND THE HOOKS, BOUND WITH THEIR RANK — main.ts:1486-1488.
   *
   * COLLECTED OUTSIDE THE `passive` GUARD, as production collects them: a
   * talent may carry a hook and no `passive` block at all, and `indelible`'s
   * `onKill` heal is exactly that shape. A probe that folded only the numbers
   * would report a class as unsurvivable while the talent meant to save it sat
   * in the registry doing nothing.
   */
  const bound = [];
  for (const id of [...sheet.passives, ...sheet.sustained]) {
    if ((sheet.points.get(id) ?? 0) < 1) continue;
    const talent = registry.get(id);
    if (talent === undefined) continue;
    if (talent.hooks !== undefined) {
      bound.push({ talentId: id, level: talentLevelOf(sheet, talent), hooks: talent.hooks });
    }
    if (talent.passive === undefined) continue;
    const block = talent.passive(talentLevelOf(sheet, talent), view);
    for (const [key, value] of Object.entries(block.stats ?? {})) {
      if (typeof value === 'number') stats[key] = (stats[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(block.mods ?? {})) {
      if (typeof value === 'number') mods[key] = (mods[key] ?? 0) + value;
    }
  }
  const any = Object.keys(stats).length > 0 || Object.keys(mods).length > 0;
  body.passiveCombat = any
    ? {
        ...(Object.keys(stats).length > 0 ? { stats } : {}),
        ...(Object.keys(mods).length > 0 ? { mods } : {}),
      }
    : undefined;
  // ABSENT RATHER THAN EMPTY, for production's reason: `applyDamage`
  // short-circuits on an absent array.
  body.talentHooks = bound.length > 0 ? bound : undefined;
  // THE LATCH THE HOOKS READ, borrowed from the sheet rather than copied —
  // two latches would be two answers to "has this fired this turn".
  body.turnProcs = sheet.turnProcs;
}

/**
 * THE ATTRIBUTE POINTS IN THE PURSE, SPENT DOWN THE CLASS'S OWN ORDER.
 *
 * `spentStats` is the ledger a player writes with the `+` button and the one
 * `boughtSheet` folds at stage one and a half — so this is the same arithmetic
 * `handleSpendStat` performs, minus the wire. The ceiling question is the
 * gateway's line verbatim — `canRaiseStat` of `stat(boughtSheet(body,
 * body.baseCombat ?? body.combat))` — because `statCeilingForLevel` is a real
 * cap and a probe that walked past it would be measuring a character the
 * server refuses to create.
 *
 * `growTo` spends a whole career through here and the floor spends each level
 * through here, so there is one loop and one ceiling.
 *
 * ROUND-ROBIN, starting from the top of the order every call. A stat at its
 * ceiling is skipped and the point goes to the next one — a class can author a
 * stat above a low level's ceiling, and the Watchman's Strength at level 2 is
 * one. A point NO stat can take stays in `unspentStatPoints`, where the server
 * would leave it, and the next level's call tries it again.
 *
 * @returns how many points were spent.
 */
function spendBankedStats(body, cls) {
  let spent = 0;
  if ((body.unspentStatPoints ?? 0) <= 0) return spent;
  const order = growthOrder(cls);
  if (order.length === 0) return spent;
  let i = 0;
  while (body.unspentStatPoints > 0) {
    let raised = false;
    for (let step = 0; step < order.length; step += 1) {
      const key = order[(i + step) % order.length];
      if (key === undefined) continue;
      // net/gateway.ts#handleSpendStat, the two lines that decide it.
      const base = statValue(boughtSheet(body, body.baseCombat ?? body.combat) ?? {}, key);
      if (!canRaiseStat(base, body.level)) continue;
      body.spentStats = { ...body.spentStats, [key]: (body.spentStats?.[key] ?? 0) + 1 };
      body.unspentStatPoints -= 1;
      spent += 1;
      i = i + step + 1;
      raised = true;
      break;
    }
    if (!raised) break;
  }
  return spent;
}

/**
 * AND THE TALENT POINTS, down the same loadout `spendPointsTo` uses at birth,
 * through the same round-robin and the same refusals (`serverWouldRaise`).
 *
 * A point with nowhere to go stays in `unspentPoints`, as it would for a
 * player: a rank the ladder refuses at this level may open at the next, and
 * this runs again on every base turn.
 *
 * THE GENERICS AND THE CATEGORY POINTS ARE LEFT WHERE THEY LAND. Both buy trees
 * this probe does not model (`unlockTree` is a gateway verb), and spending them
 * into the class loadout would be inventing a build rather than measuring one.
 * Like the passive fold above, that biases every number in the HARD direction.
 */
function spendBankedTalents(body, sheet, cls, registry = contentRegistry()) {
  if (sheet === undefined || (body.unspentPoints ?? 0) <= 0) return;
  spendClassPoints(body, sheet, cls, registry);
}
