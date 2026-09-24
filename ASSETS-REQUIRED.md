# Assets this game expects

The artwork is **not distributed with this repository**; see
[ASSETS-LICENSE.md](ASSETS-LICENSE.md). A bare clone is supported: missing art
renders as an explicit fallback instead of making an actor or interaction
silently disappear.

## Get the current worklist

The code and deployed asset tree are the inventory. Do not copy a count or a
filename list into this document.

```powershell
npm run art:needs
node tools/art-needs.mjs --missing
node tools/art-needs.mjs --json
```

`npm run art:needs` reports:

- every literal art id referenced by current source;
- explicit `*ART_REQUESTS` that are intentionally not wired yet;
- demanded ids with no deployed file;
- active stand-ins and old-cell remasters from the manifest;
- on-disk files no current source references;
- duplicate ids and dynamic expressions the scanner cannot prove.

The scanner parses source syntax rather than searching raw text, so comments
and documentation examples are not accidental commissions. A clean report has
zero duplicate ids and zero unresolved dynamic art ids. A missing file is a
valid production backlog item; silencing it by pointing code at unrelated art
is not.

## Runtime scale contract

The complete contract, including realm-specific terrain rules, anchoring, and
visual QA, is [docs/art-scale-contract.md](docs/art-scale-contract.md).

| Kind | Native production size | Placement |
|---|---:|---|
| Terrain or world-map cell | **64x64** | Exactly fills one cell |
| Standing human-scale actor | **48x64** | Bottom-centred on its occupied cell |
| Downed/prone human | **64x48** | Bottom-centred, wider than standing |
| Large creature | **96x128** | Bottom-centred; may overflow upward and sideways |
| Item and ability icon | **64x64** | UI placement owns its displayed size |
| Cell-space marker or ring | **64x64** for new art | Renderer fills exactly one 64px cell |

Straight RGBA8 alpha, hard pixel edges, no premultiplication, and no smoothing.
Actors may overflow the cell; terrain and cell-space overlays may not.

## Install and manifest

Runtime files live below `client/public/assets/` and are deployed separately
from this git repository. Replacing an asset is normally an overwrite at the
same path and id, followed by a manifest rebuild:

```powershell
python tools/build_asset_manifest.py
npm run check:assets
```

`npm run assets` regenerates the project's procedural UI/content assets before
rebuilding the manifest. Do not run it merely to inventory the art; use
`npm run art:needs` for that.

Terrain has two isolated production lanes at the workspace root:

- `local-art-production/` builds and installs the 64px material tiles used in
  common and inner realms.
- `world-settlement-art-production/` builds and installs the 64px coordinate-
  phased settlement roof surfaces used on the overworld.

Each installer validates a closed output set, dimensions, basename collisions,
and copy hashes, then rebuilds the manifest. Neither installer deletes runtime
art.

## Historical specifications

[docs/assets-needed.md](docs/assets-needed.md) preserves the 2026-08 planning
tables because many rows contain useful visual briefs and source-art notes.
They describe the former 32px cell and 24x32 actor era and are **not** the live
worklist or current size specification.

## Outstanding commission: the Alchemist's model sheet

The Alchemist is the one player class whose sprite was never cut from a game
model sheet, and it shows on screen. This section is the measured reason and the
acceptance test, so the replacement can be checked rather than eyeballed.

### What is wrong, measured

Every other actor is baked by `native-actor-art-production/` from a 6x8
idle/walk grid, taking the south row, frame zero. Those figures fill the 48x64
envelope at their own proportions:

| source figure | w x h | ratio | width at 60 px tall |
| --- | --- | --- | --- |
| watchman | 194x338 | 0.574 | 34 px |
| inspector | 142x292 | 0.486 | 29 px |
| enforcer | 157x297 | 0.529 | 32 px |
| voidling | 196x273 | 0.718 | 43 px |
| **alchemist master** | **468x1424** | **0.329** | **20 px** |

The Alchemist has no model sheet. She is baked instead from a single
full-body illustration, `final-old-cell-art-production/source-masters/
chr_player_alchemist_s_master.png`, drawn at realistic proportions: a 1424 px
figure with a head about a seventh of its height, where the model sheets are
roughly a quarter. Reduced honestly she lands 20 px wide, a third narrower than
the narrowest of her peers, with a head too small to carry a face.

So the lane stretches her. `build_final_old_cell_art.py` sets `x_stretch=1.45`
with the comment *"The authored master is fashion-illustration slender. Match
the 29-34 px shoulder/equipment read of the native Watchman/Inspector."* That
is the smear: the face is widened 45 per cent against its own height, and the
two belt vials that survive an unstretched bake are lost.

The illustration itself is good and should be the art direction reference. It
is the ENVELOPE that is wrong, and no reduction recipe fixes proportions.

### What is needed

One 6x8 idle/walk model sheet, authored the way the other four were:

- **Grid** 6 columns (frames) x 8 rows (facings), magenta `#FF00FF` key, cell
  256x384, sheet 1536x3072. Row index 4 is south; frame 0 is idle.
- **Proportions** the figure in the south idle cell must measure between 0.49
  and 0.57 wide-over-tall, so the bake needs no stretch at all. This is the
  acceptance test, and it is the whole point of the commission.
- **Head** about a quarter of figure height, matching the Watchman, so the face
  survives at 48x64.
- **Identity** carried over from the existing master: high auburn ponytail,
  stained apron over a slate coat, shoulder satchel, two capped vials on the
  belt in teal and amber, fingerless gloves, laced boots. The vials are the one
  detail that must read at 48x64: she is the class that counts them.
- **Palette** reference `randomassets/new/_source/generated/maps/ashwick/
  map_ashwick_alchemy_shop_01_source.png` in the Outer Index tree: gaslight
  amber, copper, teal and violet glass.

A matching prone master is needed for the downed sprite on the same terms:
64x48 canvas, head to the left, ponytail, apron and vials retained, no gore,
and no `y_stretch` (it is 1.43 today, for the same reason).

### Ids to swap when it lands

| id | canvas | today |
| --- | --- | --- |
| `chr_player_alchemist_s` | 48x64 | stretched 1.45x from an illustration |
| `chr_player_alchemist_downed_s` | 64x48 | stretched 1.43x from an illustration |
| `icon_character_the_alchemist` | 64x64 | portrait, recut from the same master |

Nothing in the Outer Index tree can serve as this source today: a census of
every PNG in that tree finds no alchemist, apothecary or chemist humanoid, and
the two unconsumed humanoid sheets there are a red-hooded herbalist and a
monocled office manager, both green-keyed in a way the magenta bake cannot
strip.

## Two status icons that are drawn and wired to nothing

`icon_status_off_guard` and `icon_status_shielded` are on disk and referenced
by no source file. Neither is a missing wiring job, so do not treat them as
one, and do not redraw them. (`icon_status_hasted` was the third, and is SPEED's
badge since 2026-09-24 — see below.)

- **`off_guard`** is an ORPHANED NAME, not a missing effect. The mechanic ships
  as **Off-balance** (`content/effects.ts`, ported from `physical.lua:1858`,
  the cross-tier physical effect) and has its own `icon_status_off_balance`.
  The design docs called it "Off-guard" and the icon was drawn to that name;
  the code follows upstream instead, which is the name a player reads on the
  badge. Delete it, or keep it as a spare — there is nothing to wire.

- **`hasted`** WAS architecturally refused for a player — a player's
  `globalSpeed` was pinned at 1 to keep the old simultaneous barrier
  phase-locked. A party takes its turns in initiative order now, the pin went
  on 2026-09-24, and the icon is the badge of ToME's SPEED (physical.lua:603),
  which On My Whistle lands on a friend. Wired; nothing to draw.

- **`shielded`** is art ahead of a mechanic. ToME's damage shield absorbs a
  pool of damage before hit points; nothing in this game does that. Iron
  Curtain is a guard, which is a different thing and already has `guarded`.

Recorded so the next art pass does not read three unreferenced files as a gap.

---

## The doll's frames and plates are cut for a cell that no longer exists

**Status: not missing, not broken — undersized. No placeholder needed; the
existing art draws, just smaller than its box.**

The inventory became one window on 2026-09-05 (`116d46f`): the paper doll sits
beside a scrolling list instead of behind a tab, and its cells shrank from 72 to
`CELL_PX` 40 so both fit. Everything still renders, because `blitReduced`
(ui/panel.ts) takes an exact whole-number reduction — but two assets are now
authored for a size nothing uses:

| asset | authored | box | drawn at | shortfall |
|---|---|---|---|---|
| `ui_item_frame_*` (5 files) | 72x72 | 40x40 | 36x36 (halved) | 4px |
| `ui_inventory_cell_empty` / `_hover` | 40x40 | 24x24 | 20x20 (halved) | 4px |

The item icons are unaffected and want no work: `item_*` is 64x64 and lands on
32 in a doll cell and 16 in a list row, both exact and both full-bleed.

**What to cut, when somebody is in the art tree anyway:**

- the five `ui_item_frame_*` at **40x40**, same design, one-pixel border
- `ui_inventory_cell_empty` and `ui_inventory_cell_hover` at **24x24**

**Acceptance test:** open the inventory and look at the doll. A native cut fills
its cell to the edge; the halved one leaves a two-pixel gutter on every side of
every plate. Both are legible, which is why this is a polish item and not a bug.

**Do NOT "fix" this by letting the blit scale to fit.** `blitReduced` refuses
anything that is not a whole divisor on purpose, and the reason is written where
it is declared: with smoothing off, a fractional reduction drops rows unevenly
and looks torn. Cutting the art at the size it is drawn is the fix; scaling it
is the thing that was rejected.

`tools/gen_ui_assets.py` generates both stand-ins — `img(72, 72)` for the frames
and `img(40, 40)` for the plates — so the placeholder pass changes there first.

---

## Delivered — the art-completion pass (2026-09-12)

**Twenty-six pieces landed in one pass**, closing every missing-file commission
this file carried. They were produced in `../art-completion-production/` (full
prompt set in its `PROMPTS.md`, QA contact sheets and a machine report in
`qa/`) and staged under `client/public/assets/`. Every final is straight RGBA8,
fully opaque, at most 15 colours, with the exact `#0A0813` outer border.

The per-item briefs that used to sit here — what each weapon, status and tool
should look like — described art that now exists, so they are gone from the
worklist. Their text is preserved in that `PROMPTS.md` and in git history.

| family | ids | runtime destination |
|---|---|---|
| talents (64x64) | `icon_active_phase_door_rune`, `icon_active_shielding_rune`, `icon_monster_bear_down` | `items/active/`, `items/monster/` |
| statuses (24x24) | `icon_status_blinded`, `icon_status_damage_shield`, `icon_status_infusion_saturation`, `icon_status_out_of_phase`, `icon_status_pinned`, `icon_status_rune_saturation` | `ui/icons/status/production/` |
| equipment (64x64) | `item_service_baton`, `item_bailiffs_hook`, `item_writ_of_seizure`, `item_witness_locket`, `item_archivists_mantle`, `item_evidence_belt`, `item_handlers_gloves`, `item_bailiffs_maul`, `item_paired_shivs`, `item_coroners_apron`, `item_tourniquet_band` | `items/equipment/` |
| attributes (64x64) | `icon_stat_strength`, `icon_stat_dexterity`, `icon_stat_magic`, `icon_stat_willpower`, `icon_stat_cunning`, `icon_stat_constitution` | `ui/icons/stats/` |

**The eleven equipment ids moved from `PENDING_ICON_IDS` to `KNOWN_ICON_IDS`**
(`src/server/content/items.ts`), which is the signal the commission register was
built around: the two lists are disjoint, and a move is how a commission closes.
`PENDING_ICON_IDS` is now empty — the mechanism, not a dead list.

### A second gap the same pass exposed: 72 finished icons that never loaded

Not a missing-file problem, and `npm run art:needs` could not see it. All 64
`icon_passive_*` and all 8 `icon_sustain_*` PNGs were already in the manifest and
on disk, but `NEEDED_ASSET_PREFIXES` (`src/client/main.ts`) admitted only
`icon_active_`. Every passive and sustain in the Talent panel drew its first
letter — 42 on one Alchemist screenshot. The prefixes are added, and
`test/client/talent-icon-loading.test.ts` now joins what a talent names to what
the client loads, which is the seam this lived in.

### Placed: the six attribute icons (2026-09-12)

All six are drawn now, so `npm run art:needs` no longer lists them as `unused`:

| Where | Size | Notes |
| --- | --- | --- |
| Talent page, attribute column | 32px | ToME's `LevelupDialog` layout — framed icon, `current (base)` under it. One column on a tall panel, two when folded. |
| Talent page, smallest panel | 16px | Only where two columns of 32 cannot fit: the 640x320 floor in combat. |
| Talent page, description column | 32px | Beside the stat's name when it is hovered. |
| Character sheet, General tab | 32px | Two to a line beside name and value; plain text rows on a sheet too short for them. |

Every draw goes through `blitReduced`, so only the exact 64→32 and 64→16
reductions can reach the screen.

**The one known weakness, and it is optional:** at 16px strength and
constitution still read as a brown and a red blob and dexterity as a grey smudge
(`qa/attribute_icons_16px_read_proof.png`). The 16px layout is reached only on
the smallest window in combat, and the value is printed under every icon, so
nothing is unreadable. If the set is ever revisited, hand-pixelled 16x16
versions of those three would fix it. No source names such files yet, so nothing
is missing.


## `icon_ui_cog` — the settings button on THREE panels now, and it is a nicety

**DELIVERED AND WIRED, 2026-09-19/20. This entry is closed.** The PNG is installed and
`drawCog` blits it at all three call sites; the open state is laid over the glyph with
`source-atop`, which is what the silhouette request below was for. The drawn gear stays as
the fallback and is still what a bare clone gets, pinned by
`test/client/caselog.test.ts` (blit present, blit absent, tint, and the composite put back).
The loader prefix `icon_ui_` went in with the reader, per the rule at `NEEDED_ASSET_PREFIXES`.

Kept below because the brief is the record of WHAT WAS ASKED FOR, and the three call
sites and their sizes are still true. The button is DRAWN — a hub,
a bore and six teeth, at thirteen pixels — so it is visible, pressable and
correct on a bare clone with no art at all. `npm run art:needs` does not demand
it, because no source line names it.

**THREE CALLERS, NOT ONE.** This entry said "the case log's settings button"
while `drawCog` was already shared with the ACTION BAR, and the CONVERSATION
WINDOW became the third on 2026-09-18 (the author asked that window for a cog
and a Reset position). One drawing, three headers — which raises what a real
PNG would be worth and is why the count is written down rather than left to be
rediscovered:

- `src/client/ui/caselog.ts` — `drawLogCog`, 13px, in the log's header.
- `src/client/main.ts` — `drawCog(ctx, hotbarCogRect(...), ...)`, 11px on the
  action bar's head, so the art has to read at that size too.
- `src/client/ui/dialogue.ts` — `drawCog(ctx, geometry.cog, ...)`, 13px, beside
  the conversation window's close ×.

**Why it is written down anyway:** the drawn version is a gear the way a wire
frame is a chair. It sits in each of those headers beside a painted 9-slice
panel and a painted header strip, and it is the only element in that strip that
is obviously not of the same hand.

**What it should look like:** a small mechanical gear in the interface's brass
and slate, reading at 13x13 in the header and still legible at 26x26 on a
doubled UI scale. It is a CONTROL, not decoration — it needs a silhouette that
survives being tinted gold when the menu under it is open.

**Cut it at 64x64**, matching every other `icon_ui_*` on disk; the header scales
it down.

The PNG is `ui/icons/icon_ui_cog.png` and the client consumes it. `drawCog` in
`src/client/ui/caselog.ts` remains the fallback for a checkout with no asset tree.

## Three lanterns for the light source slot

**Delivered 2026-09-17.** All three 64x64 icons are present as derived finals
in `items/equipment/`. The LITE slot and upstream's three lanterns
(`data/general/objects/lites.lua:30-70`) remain the reason for the commission.

| Id | Tier | What it is |
|---|---|---|
| `item_brass_lantern` | common | A plain brass lantern: a wick behind a sheet of greased paper, carried by a handle. The one upstream gives every character at birth. |
| `item_alchemists_lamp` | uncommon | The same brass lantern made brighter by alchemy: a whiter, hotter flame in a slightly finer case. |
| `item_dwarven_lantern` | rare | A heavy, iron-banded lantern made for the deepest workings, with a steady gold glow. |

**Cut at 64x64** beside the other item icons in `items/equipment/`; the doll and
the bag scale them down. Each must read as a lantern at 32x32 and be told apart
from the other two by shape and flame colour, not by size alone.


## The standing commission: people, bestiary, bosses, effects, items, props

**A backlog to draw from for a long while.** The list lives in
[content/art-requests.ts](content/art-requests.ts), not here. It is a catalogue
rather than code: `npm run art:needs` tracks an id once the code that draws it
names it, and not before. Each entry carries its id, size, where it appears,
the ToME entry it stands in for, and a one-line brief.

It holds seven lists:

- **Townsfolk**: the watch, clerks, shopkeepers, clergy and camp folk who fill
  the towns. The ten named townsfolk already wear their own faces and have left
  the list.
- **Enemies**: ToME's bestiary families (rodents, worm masses, molds, oozes,
  snakes, wolves, bears, spiders, ants, swarms, skeletons, ghouls, ghosts,
  wights, vampires, liches, bone giants, gangs, thieves, brutes, automata,
  crystals, plants, cats, rock-eaters, minotaurs, horrors), each renamed and
  redrawn for Alderbrook, weakest to strongest.
- **Bosses**: ToME's early uniques, each moved to the delve it now guards,
  including the intro cave's boss.
- **Effects** (`ui_fx_*`): a projectile, a hit and an area tile for each of
  ToME's twelve damage types, plus beams, weapon swings, shots, class
  signatures, heals, shields, teleports, status loops and hazards.
- **Status icons**, **items** and **props**: ToME's effects, base items and
  traps that have no picture here yet, and furniture for every town and delve.

**Effects are frame strips, and one family is wired now.** One frame per actor is
still the whole animation system, so a `ui_fx_*` strip is 64x64 frames laid left
to right: 4 frames (256x64) for a loop, 6 frames (384x64) for something played
once. Projectiles are drawn pointing east. The file header gives the full
convention and the colour family for each damage type.

**The bolts are on screen as of the projectile-art pass.** `paintProjectiles` in
src/client/render/canvas.ts draws `ui_fx_bolt_<damage type>` for every orb in
flight, and `ProjectileView.damageType` is what tells it which. Six of the twelve
are reachable today, because `shared/damagetype.ts` has six members:
`ui_fx_bolt_physical`, `_fire`, `_cold`, `_lightning`, `_darkness` and `_mind`.
The other six (`_acid`, `_nature`, `_blight`, `_light`, `_arcane`, `_temporal`)
are drawn by nothing until an element of theirs exists to fire, and they stay in
the commission. **Nothing is missing:** every element this game can fire already
had its strip. What the wiring adds is two requirements the briefs did not state,
and they are folded into R-FLIGHT below — the renderer shows FRAME 0 ONLY, and it
ROTATES the frame.

**Art delivered locally 2026-09-19:** the six reachable bolts were regenerated
as complete four-frame strips with a stable tip and a checked 32px rotation
radius. The other six remain under the review below.

**Style.** Gaslit Alderbrook: soot, brass, fog and lamplight. The Redacted show
pieces cut clean out of them, holes with depth behind them, wrong angles and a
faint static; the Taken are people. Bodies face south in one frame and must read
in silhouette at 48x64.

## Regeneration round one: the standing commission, reviewed (2026-09-16)

All 458 sprites of the standing commission (`content/art-requests.ts`) were delivered at the
ordered sizes and manifested. Each was then reviewed by eye against its brief and against the live
art, and every blocker or major was checked a second time by a reviewer trying to refute it.
**123 sprites need regenerating: 37 blockers and 94 majors.** The ids stay where they are;
regenerate each file in place at the same path, then rebuild the manifest.

| Family | Sprites | Need regeneration | Blockers |
|---|---|---|---|
| Effects (256x64 loops, 384x64 once-strips) | 86 | 66 | 33 |
| Actors 48x64 | 171 | 37 | 3 |
| Actors 96x128 | 71 | 10 | 1 |
| Items 64x64 | 41 | 1 | 0 |
| Props 64x64 | 73 | 6 | 0 |
| Status icons 64x64 | 16 | 3 | 0 |

An id is drawn by the game only once the content that uses it lands, and it leaves
`content/art-requests.ts` in the same commit. So a fault below is visible to a player only if its
id is no longer in that file; the rest are a catalogue nobody sees yet. Fix the effect strips
first: they are 33 of the 37 blockers, and the renderer that plays them is the next thing wired.

### Shared requirements for the effect regenerations

The effect briefs below refer to these by name, so each entry only lists what is specific to that sprite.

- **R-GRID6 (384x64 once-strips).** Six 64x64 frames; frame i spans x 64i to 64i+63. Draw one pose per frame, centred on the same frame-local anchor (normally x=32) on the same baseline. Leave at least 2 px of clear space on both sides, so columns 0 and 63 of every frame stay empty unless a pose deliberately fills the cell. A blank first or last frame is allowed only as a fade. Check it by slicing into six cells: no cell may contain part of another pose.
- **R-GRID4 (256x64 loops).** Four 64x64 frames under the same rules. The effect's centre may move no more than 1-2 px across the loop, and frame 4 must lead cleanly back into frame 1.
- **R-FLIGHT (projectile loops).** The projectile points east and is vertically centred. The whole projectile appears at the same size and position in all four frames, with its tip at a fixed x no further right than 58-60. Animate only the trail, streaks, flicker or spin. No shatter, burst or fade frame: impacts belong to ui_fx_hit_*. Nothing crosses a frame boundary.
  - **R-FLIGHT-F0 (frame 0 is the only one anybody sees).** The renderer draws frame 0 and no other, because animation playback is a PLAN.md non-goal. So frame 0 must be the finished, complete projectile — never a build-up, a faint lead-in or a blank. The other three frames still have to obey R-FLIGHT (they are what makes a later animated renderer possible, and a strip whose frames disagree about the subject is a strip nobody can wire), but no fault confined to frames 1-3 is visible to a player today. This is also why the shipped shatter-on-the-last-frame fault, which nine of the twelve bolts have, does not show on screen: it is in frame 3.
  - **R-FLIGHT-ROT (it gets turned).** The renderer rotates the 64x64 frame about the CELL'S CENTRE to one of eight compass headings, because an orb travels on a grid. So the bolt must read at 45 degrees as well as flat: keep it inside a circle of radius 32 centred on the cell, which in practice means the tip at x 58-60 is the outer limit and nothing may sit in the frame's corners. A long flat streak that reaches the left edge is clipped into a stub when the shot flies north-east. Nothing in the frame may depend on being horizontal — no ground shadow, no baseline, no text-like mark that would read upside down flying west.
- **R-AREA (area loops).** Content covers the whole 64x64 cell. Anything touching the left edge continues on the right edge, and top matches bottom, so a 3x3 tiling shows no seams and no repeated centred motif. Coverage stays constant across the four frames: animate by drift and flicker, not by growing and shrinking.
- **R-BEAM (beam segments).** Horizontal. The core band reaches columns 0 and 63 at the same rows in every frame, at even thickness, so copies placed end to end join with no gap or pinch. Decorative branches stay away from the edges.
- **R-OVERLAY (status overlays on a body).** Small and in the upper part of the cell, above the head. Constant size in every frame (no frame-3 swell). A silhouette no other overlay uses, and a colour outside the twelve damage-type families.

### Sheet-level notes worth acting on

1. **Effect frame layout is the biggest single defect: 33 of the 37 blockers.** Poses were spaced 32-55 px apart instead of 64. The deterministic QA only flags empty end frames and missed ui_fx_trap_trigger entirely. Add two checks: fail any strip with opaque pixels in both column 63 of frame i and column 0 of frame i+1, and fail any strip whose per-frame centre drifts more than 2 px. Smaller bleeds also exist on the hits and swings on effect_384x64_01 and _03.
   - Possible shortcut: a column-run probe found the right number of separated poses, each under 60 px wide, in summon, blood_splash, heal, cleanse, revive, loot_glint, swing_bite, critical_hit, buff, level_up, shield_break, shield_up, fear, dig, teleport_in, stealth_fade, regeneration, asleep, confused, poison_cloud, smoke, ink_pool and thrown_flask. Cutting each pose out and re-centring it in its own cell fixes the grid without a redraw.
   - That alone clears the blocker where the drawing is already on brief: summon, blood_splash, heal, cleanse, revive, loot_glint, swing_bite, critical_hit (after removing the hook) and hit_arcane (its gaps are only 2-3 px, but the second reviewer found them clear). Slice and re-check afterwards.
   - The others still need their content fixes. Evidence_mark's peak ring is 64 px wide and trap_trigger's poses are about 3 px apart, so both need redrawing.
2. **Effect templates were reused across types.**
   - Nine of the twelve bolts, plus the arrow, crossbow bolt and pistol, end their flight loop on a shatter or impact frame. Fix the template once.
   - Every area loop, plus poison_cloud, smoke, ink_pool and burning_ground, is one centred mound that doesn't tile. The four areas on effect_256x64_03 (darkness, arcane, mind, temporal) were only rated minor but have the same defect; regenerate them in the same pass, or the set will be inconsistent.
   - None of the four beams tiles end to end.
   - The status overlays (regeneration, asleep, confused, poison_cloud, stunned) share a flame-on-ring look with a frame-3 swell.
3. **All twelve ui_fx_hit_* strips start with a streak arriving from the west (frames 1-2).** content/art-requests.ts says hits are centred on the struck cell and only projectiles rotate. The second reviewer found hits aren't wired into the client yet, so decide once for the whole set (a non-directional start, or the engine mirrors the strip) before regenerating any single hit.
4. **Damage colours collide.**
   - Acid (bolt, area, hit), the nature hit and the blight hit share one lime-white core: settle acid's colour and retune all three acid effects together, and give blight a purple-dominant, non-lime core.
   - Other near-collisions: the light area reads as fire by form; the mind bolt shares arcane's hue; swing_pierce and stunned sit in the cold family; trap_trigger's orange sits in fire.
   - Non-damage effects (status overlays, trap flashes, swings) should keep out of all twelve families.
5. **Small creatures and objects are fit to the full canvas.** Rodents, ants, the mouse, the dream seed, the young rock-eater, grain sack, anvil, bedroll and toadstool ring all fill 48x64 or 64x64. The second reviewers would not fix them one sprite at a time. Set one scale rule per family (for example, vermin at about half height and knee-high props at 36 px or less) and apply it in the bake. Human NPCs must stay at 59-60 px; the crier and lamplighter were shrunk to fit their props.
6. **Repeated actor templates cause near-duplicates.**
   - A hooded void-eye figure with a disc-topped staff recurs across several bosses on actors_48x64_01.
   - Five of the ten bosses on actors_96x128_01 are symmetric tendril diamonds with a finial and sparkle glints.
   - Four bosses on actors_96x128_03 have a central gaping slit or maw.
   - All four ink spills were drawn as hooded wraiths, and most ants have spider bodies (no antennae, no waist).
   - Keep the antlered deer skull for the Index faction only.
7. **Readability falls short of the live reference.** Many commissions use heavy speckle or dither and a ragged black pixel spray instead of the live art's firm dark outline (actors_48x64_01 and _03, the 96x128 tendril bosses, the horned horror). Their silhouettes break up at native size.
8. **The props that define a character are too small or missing.** Many NPC props are a few pixels or absent (bell, pick, mortar, loupe, clipboard, rope), and so are the props that mark a boss (knotted rat tails, chain of office, knives, caught shadows). Regeneration briefs should call for defining props at least 5-8 px across.
9. **Named materials come out brown.** Brass, iron and black wood end up generic brown on items (sabre, wand, boathook, surveyor's staff, riot shield) and props (shop bell, Norgos's picks). Each named material needs its own hue.
10. **The trap runes need to be one family.** prop_trap_rune_acid, a flat chalk circle, is the model. Fire, ice and lightning should match its form and change only glyph and colour, and the teleport glyph should be grey static rather than green.
11. **Status icons need one framing decision.** Six have purple frames, three grey frames and seven none. The reviewer wanted purple frames everywhere, while the second reviewer points out that unframed dark squares are also live style. Choose one and apply it to all sixteen. Four icons carry grey residue blobs. Judge icons at the real 24 px badge size (partypanel.ts BADGE_PX = 24).
12. **Townsfolk coherence.** chr_npc_city_watch_s (green, spiked helm) and chr_npc_watch_sergeant_s (navy, crested helm) don't read as one force, and the secretary, registry clerk and citizen woman share one updo head.
13. **Suppress QA noise.** "Fully opaque square" on items and icons, and "not bottom-anchored" for foot margins of 2-5 px, are house style. Suppressing those flags would let real defects stand out.

### Confirmed blockers and majors, by category

#### 1. Wrong subject (4 blockers, 2 majors)

- **enemy_ink_spill_red_s** (actors_48x64_01) [BLOCKER]
  - Problem: this is a navy hooded wraith in a tan robe. It has no red at all (visible pixels average 45,44,42), no pool shape and no steam. The ooze family is told apart by colour and blob shape, so players will read it as a ghost.
  - Regenerate: a low, crawling puddle of glossy red ooze hugging the floor, bottom-centred in the lower half of the canvas. Give it a thick liquid edge with a few pseudopod-like runs, a wet highlight, and pale steam wisps rising from its leading edge. Crimson with near-black shadows. Nothing humanoid: no hood, no face.
- **enemy_pageworm_mass_green_s** (actors_48x64_01) [BLOCKER]
  - Problem: a hooded, dripping humanoid with a dark face slit and long clawed arms. It has no worms, no heap and no etched stone; only the green matches the brief.
  - Regenerate: use the same subject and silhouette as enemy_pageworm_mass_s, a low heap of writhing worms knotted round a small black hole in the floor. Recolour it as the acid kind: sickly green worms that visibly drip, with pale pitted stone at the base where it has crawled. No hood, face or arms.
- **enemy_weaver_young_s** (actors_48x64_02) [BLOCKER]
  - Problem: a narrow (25 px) vertical pale figure with red-brown hair-like streaks, which reads as a hanging corpse or long-haired ghoul. It has no round body, no legs and no eyes, and looks nothing like the three spiders beside it.
  - Regenerate: a pale young spider facing south, low in the frame. It needs a small round body and eight very long, thin, jointed legs spread wide; legs too long for the body is the point. Pale bone and grey with a dark 1 px outline. It must read as a spider in silhouette at 1x.
- **enemy_weaver_patriarch** (actors_96x128_04) [BLOCKER]
  - Problem: an upright two-armed, two-legged hooded humanoid covered in hanging paper strips (a paper golem). ToME's spider.lua files the weaver patriarch as a Fate Weaver spider, and the matriarch beside it on the sheet is an eight-legged spider.
  - Regenerate: a huge front-on spider in the same view and anatomy family as enemy_weaver_matriarch: eight legs, cephalothorax, abdomen and fangs. Make the male visibly different from her: a leaner abdomen, longer and heavier front legs, no egg sac. Drape a shawl of grey shroud-cloth stitched together with visible thread over the cephalothorax and upper abdomen. Use the matriarch's black-and-bone palette, spread the legs wide, and leave 2-4 px under the leg tips.
- **enemy_the_rat_registrar_s** (actors_48x64_01) [MAJOR]
  - Problem: on zoom a rat skull and body are there, but nothing marks it as the boss, and green vines wrap the whole body instead of witchfire glowing in the sockets. At sheet scale it reads as the same creature as enemy_the_skeletal_bloom_s beside it.
  - Regenerate: a skeletal rat king facing south (rat skull, spine, ribcage, long bony tail) with the tails of three or four smaller dead rats knotted into its own and trailing behind it, each small skull at least 5 px across. The only green is glowing witchfire points in the eye sockets. No vines or tendrils, and a silhouette clearly different from the skeletal bloom's.
- **enemy_carrion_pageworm_mass_s** (actors_48x64_01) [MAJOR]
  - Problem: an upright man in a bowler hat and a long brown coat. It has no worms and no heap, and it is brown rather than grey-red.
  - Regenerate: a heap of grey-red worms in the same form as enemy_pageworm_mass_s, piled over a slumped or fallen body whose coat shows through as a sleeve, lapel or collar. Nothing standing upright. Diseased grey-red palette.

#### 2. Animation and frame layout (33 blockers, 16 majors)

##### 2a. Poses off the frame grid (33 blockers)

In every entry here the poses were drawn 32-55 px apart instead of one per 64 px frame. The engine slices the strip at multiples of 64, so each played frame holds pieces of two poses, the end frames come out empty or hold a sliver, and the effect jumps sideways. The QA "frame 0/5 empty" flags on these strips are a symptom of this, not a deliberate fade. Every entry takes R-GRID6 or R-GRID4, plus whatever content changes are listed.

- **ui_fx_regeneration** (effect_256x64_05) [BLOCKER]. The figures sit at x 34-72, 81-123, 128-174 and 183-220, about 49 px apart. The centre drifts about 43 px and snaps back, and 12-13 rows are cut flat on frames 1, 3 and 4. Regenerate: R-GRID4, as a gentle breathing loop of green healing wisps over a body. No frame-3 peak followed by a collapse, and it must not read as a bonfire.
- **ui_fx_asleep** (effect_256x64_05) [BLOCKER]. The figures sit at x 20-67, 81-122, 130-180 and 188-234, a steady 24 px slide. Frame 1 is cut flat on its right edge and frame 4 on its left. Regenerate: R-GRID4, plus the content brief in section 6.
- **ui_fx_poison_cloud** (effect_256x64_05) [BLOCKER]. The figures sit at x 14-66, 71-125, 129-185 and 189-241, a 17 px slide with visible edge cuts. Regenerate: R-GRID4, plus the tiling brief in section 3.
- **ui_fx_smoke** (effect_256x64_06) [BLOCKER]. About 52 px apart (x 24-70, 76-125, 129-178, 184-230). The centre moves 46, 35, 27, 16 and snaps back, and 11-17 px slivers sit on the cell edges. Regenerate: R-GRID4, plus the content brief in section 6.
- **ui_fx_ink_pool** (effect_256x64_06) [BLOCKER]. The figures sit at x 16-69, 73-126, 130-184 and 188-239, drifting about 20 px, with 6-8 px slivers on the edges. Regenerate: R-GRID4, plus the content brief in section 4.
- **ui_fx_hit_arcane** (effect_384x64_02) [BLOCKER]. About 50 px apart (x 53-81 ... 291-332). Frame 1 holds 29 px of the streak's tail and frame 6 a 54 px scrap, so the opening and fade beats are lost and the peak is clipped. Regenerate: R-GRID6 only. The magenta vortex design and its six beats are on brief, and every gap between poses is clear, so re-slotting may be enough (see style note 1).
- **ui_fx_swing_crush** (effect_384x64_03) [BLOCKER]. About 45 px apart (x 65-317). Frames 0 and 5 are empty and the peak is split across x=192. Regenerate: R-GRID6. In the same pass, fold in the downgraded minor: a low, wide, elliptical ring of grey-brown dust spreading along the ground, so it reads as a blow landing from above rather than an upward jet.
- **ui_fx_swing_bite** (effect_384x64_03) [BLOCKER]. About 50 px apart; five of six poses cross a boundary, and every frame carries a sliver of the next pose. Regenerate: R-GRID6. Keep the crimson fanged maw, and make it plainly open, then snap shut with the upper and lower teeth meeting by frame 4, then disperse.
- **ui_fx_flask_shatter** (effect_384x64_04) [BLOCKER]. About 50 px apart (x 62-324), and the peak burst is split across two frames. The content also shows no flask or glass, and frame 0 is a sideways streak that reads as a bolt. Regenerate: R-GRID6. Frame 0 is a recognisable glass flask (pale glass outline, reagent inside) cracking at the centre. It bursts into pale glass shards and a reagent cloud that grows through frames 2-3 and thins out by frame 5. Keep the reagent in one colour family, with no bolt-like streak.
- **ui_fx_redaction_strike** (effect_384x64_04) [BLOCKER]. About 45-50 px apart, and the peak is split between frames 2 and 3. The content is also a spiky ink starburst with a cyan rim, not a redaction bar. Regenerate: R-GRID6. The subject is a thick, hard-edged, horizontal black rectangle, about 48x14 px at peak. It slams across the target's middle in frames 1-2, holds solid in frame 3, then flakes into loose rectangular black chips and paper scraps in frames 4-5. Faint static or strike-through accents are fine; no round splat or starburst.
- **ui_fx_warrant_whistle** (effect_384x64_04) [BLOCKER]. About 45 px apart; frames 0 and 5 are empty and the central star is split. The content is also a cyan lens-flare star wrapped in brass blade shapes, which reads as an arcane or lightning burst. Regenerate: R-GRID6. Show a small brass police whistle, or just a sharp blast point, at the centre, with 2-3 pale concentric sound rings that grow each frame, reach near the cell edge by frames 3-4, and fade in frame 5. Muted brass and off-white; no cyan, and nothing that points like a projectile.
- **ui_fx_evidence_mark** (effect_384x64_04) [BLOCKER]. About 55 px apart, and the three largest rings are cut. The peak ring is 64 px wide, so it cannot fit as drawn. Regenerate: R-GRID6. Keep the chalk circle, the arrow and the grit, but hold the circle at a steady 52-56 px. Ideally the circle draws itself stroke by stroke in frames 0-2, the arrow appears in frame 3, and it fades in frame 5. Make the arrow chalk-white rather than brass.
- **ui_fx_heal** (effect_384x64_04) [BLOCKER]. About 40 px apart; frames 0 and 5 are empty and the rising light is cut in frames 1, 3 and 4. Regenerate: R-GRID6 only. The pale green-white light and rising motes are on brief.
- **ui_fx_shield_up** (effect_384x64_04) [BLOCKER]. About 47 px apart, with the oval shields cut in half. Every pose also has a fully opaque cyan human silhouette, about 30 px tall at the peak, painted inside the shield; drawn over an actor, it would put a second, smaller body on top. Regenerate: R-GRID6. Draw only the shield: a translucent-looking cyan-teal pane or oval of force with a brass rim, sized to wrap a 48x64 body, with the centre empty or very lightly tinted. No human figure. The brass edge segments snap inward and lock over frames 0-2, flash on lock in frame 3, then settle to a faint shimmer in frames 4-5.
- **ui_fx_shield_break** (effect_384x64_05) [BLOCKER]. About 40 px apart (centres near x 83-298); frames 0 and 5 are empty, and poses cross x=128, 192 and 256. Regenerate: R-GRID6. In the same pass, fold in the minor: frame 1 matches the final pane of ui_fx_shield_up, cracks spread in frames 2-3, it shatters with a flash in frame 4, and brass pieces and cyan shards fall down and out in frames 5-6.
- **ui_fx_buff** (effect_384x64_05) [BLOCKER]. 44-49 px apart, crossing four of the five boundaries, with the peak split across frames 3 and 4. Regenerate: R-GRID6, keeping the warm gold palette. Fold in the minor: chevrons that point up (^) and climb, with new ones appearing at the base as older ones fade near the top.
- **ui_fx_debuff** (effect_384x64_05) [BLOCKER]. About 42 px apart; frames 0 and 5 are empty. Regenerate: R-GRID6, plus the content brief in section 4.
- **ui_fx_cleanse** (effect_384x64_05) [BLOCKER]. 34-39 px apart, squeezed into frames 1-4, with the peak clipped. Regenerate: R-GRID6 only; the white-mint wash rising through a body is on brief.
- **ui_fx_level_up** (effect_384x64_05) [BLOCKER]. About 34 px apart; the peak column straddles x=192, so it never appears whole. Regenerate: R-GRID6. Fold in the minor: on the peak frame, stamp a round gold/brass seal (simple emblem, no letters) on the rising gold column, and drop the dark navy halo.
- **ui_fx_revive** (effect_384x64_05) [BLOCKER]. 34-40 px apart, with the peak split across frames 2 and 3. Regenerate: R-GRID6 only, keeping the warm, lit-from-below peach light with the ground glow on one baseline.
- **ui_fx_teleport_out** (effect_384x64_06) [BLOCKER]. About 32 px apart across x 101-286, with two bodies in each of frames 2 and 3. The motion is also a sliver-body-sliver pulse, the same as teleport_in. Regenerate: R-GRID6. Frame 0 is a full human-scale body silhouette (about 48 px tall, feet near the bottom) with the first crease of static. In frames 1-4 the body folds along a vertical crease into a thin line of static. Frame 5 is a fading sliver or blank. It only shrinks.
- **ui_fx_teleport_in** (effect_384x64_06) [BLOCKER]. Same layout fault and the same symmetric pulse. Regenerate: R-GRID6 as the exact reverse of teleport_out. Frame 0 is a thin static crease (or blank), the body unfolds out of it in frames 1-4, and frame 5 is the full body with the last static flecks settling. It only grows.
- **ui_fx_summon** (effect_384x64_06) [BLOCKER]. About 32 px apart; two rings each in frames 2 and 3, and the peak is clipped at x=192. Regenerate: R-GRID6 only. Keep the pale chalk ellipse and dark violet tendrils on the same baseline in every frame: build-up in frames 0-2, flare peak in frames 3-4, fade in frame 5.
- **ui_fx_stealth_fade** (effect_384x64_06) [BLOCKER]. About 32 px apart, with doubled figures. The content is also a teal sliver-body-sliver pulse that reads as another teleport. Regenerate: R-GRID6. Frame 0 is a clear, fully visible body about 48 px tall. In frames 1-5 dark smoke rises over it while it loses detail in place through dithered erosion (no shrinking into a crease), ending as a faint wisp. Smoky near-black and dim grey-violet; no cyan static.
- **ui_fx_death_erase** (effect_384x64_06) [BLOCKER]. About 32 px apart, with doubled bodies and the peak split. The content has no tearing and no hole, and reads as a teleport. Regenerate: R-GRID6. Frame 0 is a Redacted body (about 48 px) in near-black and static. In frames 1-3 its edges tear away in ragged strips that are pulled inward, while a flat black hole with no shading opens across the middle of the figure. In frames 4-5 the shape folds into the hole and the hole closes to a single dark speck. Near-black, torn grey and faint static dominate; drop the cyan glow.
- **ui_fx_page_burst** (effect_384x64_06) [BLOCKER]. About 32 px apart, with doubled bursts and the peak clipped. The content is a cyan-white crystal star that reads as a cold hit. Regenerate: R-GRID6. Frame 0 is a small impact flash. In frames 1-3 ragged scraps of flat black with torn pale-grey edges, plus a few static flecks, tumble outward. In frames 4-5 they scatter further and fade. No crystal star shapes and no cyan.
- **ui_fx_fear** (effect_384x64_07) [BLOCKER]. About 32 px apart. Each pose also fills in an opaque dark-navy body (pixel 205,35 is 5,14,28 at full alpha) that would cover the actor. Regenerate: R-GRID6. Draw only a cold, trembling outline and loose flecks tracing a 48x64 standing body (bottom-centred, about 56 px tall), with a transparent interior. Make the line wavering rather than crystalline, so it doesn't read as cold damage.
- **ui_fx_critical_hit** (effect_384x64_07) [BLOCKER]. 32-38 px apart. Regenerate: R-GRID6. Keep the sharp gold/white four-point star and dark flecks, and remove the curled '?'-like hook in pose 5.
- **ui_fx_blood_splash** (effect_384x64_07) [BLOCKER]. About 38 px apart. Regenerate: R-GRID6 only, anchored at the same low ground line in every cell. The restrained dark maroon is right.
- **ui_fx_trap_trigger** (effect_384x64_07) [BLOCKER]. 44 px apart; every boundary is crossed, and the deterministic QA did not flag it at all. Regenerate: R-GRID6, with the plate on one ground line. Change the ember-orange flash to a clear warning red (orange sits in the fire family), and replace the 'S'/'K'-shaped spark squiggles with plain sparks.
- **ui_fx_alarm_pulse** (effect_384x64_07) [BLOCKER]. 35-45 px apart. Regenerate: R-GRID6, making sure the widest pose (about 47 px) still fits. Draw concentric red rings growing outward and fading, with little or no crosshair spikes (it currently reads as a targeting reticle), and remove the hook artefact in pose 5.
- **ui_fx_dig** (effect_384x64_07) [BLOCKER]. 35-45 px apart. Regenerate: R-GRID6, with the burst on one ground line. Use chunky, angular grey-brown rock chips instead of long wooden-looking splinters, add a grey-brown dust puff that spreads and fades, and remove the long pale streak in pose 4.
- **ui_fx_loot_glint** (effect_384x64_08) [BLOCKER]. About 38 px apart, so two glints show in frames 2 and 3 and cut-off shards flash in frame 4. Regenerate: R-GRID6 only, on a fixed anchor so the sparkle stays put. The cream-gold core, teal rays and grow-peak-shrink arc are good.

##### 2b. Frame bleed (1 major)

- **ui_fx_hit_temporal** (effect_384x64_02) [MAJOR]. About 54 px apart. The streak tip spills into frame 2, the peak's brass arcs are cut flat on frame 4's left edge (82 px in its leftmost 4 columns), and stray teal rays sit on the edges of frames 4-5. Regenerate: R-GRID6, keeping the teal-and-brass clock-arc burst (the most distinct hit in the set). Shrink the peak ring a few px so it fits.

##### 2c. Flight loops that break every cycle (15 majors)

Every entry takes R-FLIGHT, and the six that the renderer now draws additionally take R-FLIGHT-F0 and R-FLIGHT-ROT: `ui_fx_bolt_physical`, `_fire`, `_cold`, `_lightning`, `_darkness` and `_mind`. **Those six were replaced locally 2026-09-19; the observations below record the old strips.** The other six are still a catalogue nobody sees.

- **ui_fx_bolt_physical** (effect_256x64_01) [MAJOR]. Frame 4 is loose shards (3.1% visible, against 8.8-14.6% in the other frames), so the bolt blinks out every fourth frame. Frame 3's tip runs about 3 px past x=192, and the tip creeps 51, 56, 63 and snaps back. Keep the steel shaft, bone-white point and grey/bone palette.
- **ui_fx_bolt_fire** (effect_256x64_01) [MAJOR]. Frame 4 is five orange fragments, frame 3's tip crosses into frame 4, and the tip creeps 50 to 63. Keep orange and yellow. Letting flame dominate over the metal casing is optional.
- **ui_fx_bolt_cold** (effect_256x64_01) [MAJOR]. Frame 4 is scattered ice chips, frame 3's tip crosses x=192 by about 3 px, and a trail pixel crosses x=128. The body is the physical bolt's finned shell with an icy point. Regenerate as a crystalline ice shard or icicle (not a metal shell) with a frost-mist trail, in pale blue and white.
- **ui_fx_bolt_lightning** (effect_256x64_01) [MAJOR]. Frame 4 collapses into flecks, frame 3's point crosses x=192, and the tip creeps 49, 54, 63. Keep the forked electric-yellow arcs in a violet streak, and animate by re-routing the forks.
- **ui_fx_bolt_acid** (effect_256x64_02) [MAJOR]. Frame 4 is a broken tip and two green shards with no casing, and the tip creeps. See also section 10. Keep the brass-cased acid dart, and use the acid colour settled in section 5.
- **ui_fx_bolt_nature** (effect_256x64_02) [MAJOR]. Frame 4 is scattered leaves, soil flecks and a detached tip, and the tip creeps 53 to 63. Keep the leaf-wrapped stake, and animate only the trailing leaves, twigs and soil.
- **ui_fx_bolt_blight** (effect_256x64_02) [MAJOR]. Frame 4 is a detached tip, one shard and purple specks (4.9% visible). Keep the dart. Fold in the minors: raise the purple to a mid-value, saturated violet that carries at least half the colour, and keep bile green as an accent clearly unlike acid's lime.
- **ui_fx_bolt_light** (effect_256x64_02) [MAJOR]. Frame 4 is a gold burst of shards and sparks, which is an impact effect (ui_fx_hit_light) inside a flight loop. The tip runs from x=52 to the edge. Keep gold and white, and animate only the white streaks and gold sparks.
- **ui_fx_bolt_darkness** (effect_256x64_03) [MAJOR]. Frame 3's pale-blue arrowhead is cut at the cell edge and about 10 px of it lands on frame 4's left edge. Frame 4 has no bolt body (4.8% visible), and the head creeps 57, 60, 64+. Keep frames 1-3's black and deep-blue ink streak with its pale-blue arrowhead, end the tip by x=60, and make frame 4 a complete bolt.
- **ui_fx_shot_arrow** (effect_256x64_04) [MAJOR]. Frame 4 has no shaft (140 opaque px against 279-666), so the arrow blinks out. A bright teal wind burst in frame 3 and teal fletching glow make a plain arrow look enchanted, and 2 px of frame 3's tip crosses x=192. Regenerate as a plain arrow (steel head, wooden shaft, fletching), complete and in the same place in all four frames, with only subtle fletching flutter and faint neutral grey speed lines. No teal or cyan.
- **ui_fx_shot_crossbow_bolt** (effect_256x64_04) [MAJOR]. Frame 4 is the head plus two vane chips with no shaft, frame 3 smears the vanes, and frame 2 is frame 1 shifted 4 px. Keep the short, stout bolt with a broad steel head and brown vanes, complete and fixed in all four frames, with a slight vane flutter and a faint neutral streak.
- **ui_fx_shot_pistol** (effect_256x64_04) [MAJOR]. Bright pixels per frame run 50, 61, 99 and then 4, so the tracer vanishes in frame 4; opaque area swings from 227 to 753 to 208. Frames 2-3 draw a whole brass slug in a smoke plume. Regenerate as a short, bright tracer: a white-hot tip fading into a 20-30 px brass-yellow streak, at similar size and brightness in all four frames, with a slight flicker and a faint grey wisp. Keep brass flecks minimal.
- **ui_fx_shot_sling_stone** (effect_256x64_04) [MAJOR]. The stone grows from about 21 to about 31 px wide, then drops to about 13 px and sheds debris. The spin comes only from thick cream arcs that read as a claw rake. Regenerate as one rounded grey-brown stone at a constant 12-16 px, rotated through four positions so the rock itself spins, with one or two thin arcs behind it and no fragments.
- **ui_fx_thrown_knife** (effect_256x64_05) [MAJOR]. The blade never rotates, frame 4 loses the grip (about 33 px against 39), the tip advances 10 px and then snaps back, and navy ink trails suggest magic. Regenerate as a plain steel throwing knife with a flat, clearly knife-shaped blade and a short wrapped grip, fixed in length and centre. Show the spin by rotating it about its long axis (flat, angled, edge-on, angled), with thin neutral grey-white motion arcs and no coloured smoke.
- **ui_fx_thrown_flask** (effect_256x64_05) [MAJOR]. The neck angle steps +37, +71, +182, +70 degrees, so frame 3 to 4 is a half-turn flip and frame 4 mirrors frame 1. Frame 2's stopper is cut at its left edge, with one column sitting in frame 1. Regenerate with an even end-over-end rotation of about 90 degrees per frame in one direction, the liquid sloshing to the low side, centred with at least 2 px clear. Fold in the minor: shrink the flask to 30-36 px on its longest side.

#### 3. Tiling (10 majors)

Area entries take R-AREA and beam entries take R-BEAM. The off-brief areas and beams in section 4 (area_cold, area_lightning, area_acid, beam_fire) share the same tiling failure.

- **ui_fx_area_physical** (effect_256x64_01) [MAJOR]. One centred ring with clear margins, so a 3x3 tiling is a grid of separate rings. Frame 1 is a faint dot (3.8% visible), so every cell pulses in lockstep, and the four-point star glints read as magic. Regenerate as one cell of churning grit and dust, small shock ripples and cracked flagstone chips in grey and bone white, with drifting dust and shifting debris. No glints or sparkles.
- **ui_fx_area_fire** (effect_256x64_01) [MAJOR]. One bonfire mound peaked in the centre with empty space above and below, so it tiles as rows of campfires; coverage pulses 11, 20, 27, 13%. Regenerate as a bed of embers and low flame tongues spread over the whole cell, flickering at constant height and density. Smoke is optional and must also wrap across the edges.
- **ui_fx_area_acid** (effect_256x64_02) [MAJOR]. A flame mound on a ground line at y=53; the top 21-24 rows are empty in frames 1 and 4, and the top and bottom edge rows are empty in every frame. Regenerate: see the combined brief in section 4.
- **ui_fx_area_nature** (effect_256x64_02) [MAJOR]. A centred tuft on a soil line at y=56 with the top 26-28 rows empty, and the frame-3 plume reads as flame. Regenerate as roots, thorny growth, leaves and soil spread across the whole cell, with swaying stems and drifting leaves distributed evenly. No central plume.
- **ui_fx_area_blight** (effect_256x64_02) [MAJOR]. A centred flame mound with its base at y=57, so it tiles as rows of purple-green fires with dark gaps. Regenerate as a blight miasma or rot patch in bruise purple (dominant) and bile green, reaching all four edges, with wisps and spores spread across the cell.
- **ui_fx_area_light** (effect_256x64_02) [MAJOR]. A single centred bonfire with its base at y=58, top rows empty. Regenerate: see the combined brief in section 6.
- **ui_fx_poison_cloud** (effect_256x64_05) [MAJOR]. A single mound on the cell floor with the top 26 rows empty in frames 1 and 4 and a flame-like peak in frame 3. Its mask matches confused and asleep (IoU 0.59-0.60). Regenerate as one cell of low, drifting poison gas filling the cell edge to edge: a dithered haze of sickly green wisps with soft pockets, no central peak and no ground ring. Wisps that leave one edge re-enter on the opposite edge, so frame 4 loops into frame 1. Also R-GRID4.
- **ui_fx_burning_ground** (effect_256x64_06) [MAJOR]. The frames are aligned correctly, but it is a single campfire with empty margins. In the tall frame the flame reaches y=2 (about 60 px), so it would hide an actor, and it tiles as nine campfires. Regenerate as a low carpet of flames and embers with tongues no higher than the lower half of the cell, gentle flicker, and embers and char matching the neighbouring edges. Keep the current red-orange fire palette, which reads well.
- **ui_fx_beam_lightning** (effect_256x64_04) [MAJOR]. The look is right, but every frame has an empty edge column (a 2 px break at every seam), and where the bolt reaches an edge it is only 3 rows thick; the frame-3 starburst makes it pulse like a bead. Regenerate keeping the look and palette, with the main bolt line (rows 35-40) reaching columns 0 and 63 in all four frames at the same rows. Keep the crackle branches away from the edges.
- **ui_fx_beam_light** (effect_256x64_04) [MAJOR]. Each frame is a centred starburst whose core thins to a single 1 px row (row 34) at the edges; frames 1 and 4 leave 3 px gaps. It reads as a string of pulsing beads. Regenerate keeping the gold and white, as a steady beam with a core 3-4 rows thick (rows 32-36) at even thickness across the full 64 px, animated by shimmer or glints travelling along it. No central starburst.

#### 4. Off-brief (41 majors)

##### Actors 48x64 (19)

- **enemy_the_master_of_saints_rest_s** (actors_48x64_01)
  - Problem: wild pale hair, a gaping black mouth and flaring red and black rags make it a banshee. There is no chain of office, and the brief says "perfectly calm".
  - Regenerate: an upright, composed ancient vampire with a calm, closed-mouth face in neat dark formal robes or a frock coat, with a prominent gold/brass mayoral chain across the shoulders and chest. A still, orderly silhouette.
- **enemy_the_simulacrum_s** (actors_48x64_01)
  - Problem: a grey-blue static-noise figure with a pointed hood. There is no hat and no glass; static is the Redacted visual language, not a glass copy.
  - Regenerate: a detective silhouette (bowler or brimmed hat, long overcoat, standing straight) made of clear glass: pale cyan-white clean planes, sharp specular highlights along the edges, and a hollow interior with faint refraction lines. No noise.
- **enemy_filio_flightfond_s** (actors_48x64_01)
  - Problem: a teal and red-brown smear spanning x 3-46. Neither knife is visible, and it is as big as any boss.
  - Regenerate: a small, lithe ghost-thief about two-thirds of human height, bottom-centred, in a crouched ready stance, with a clearly visible pale ghostly knife in each hand. Spectral palette, compact clean silhouette.
- **enemy_undermost_picket_s** (actors_48x64_01)
  - Problem: the pick is a 1-2 px line that vanishes at native size, and the black void head is a loose scribble that can read as hair. This is one of the first enemies every player meets on the intro cave floor. The orange harness does read.
  - Regenerate: a miner in work clothes and a torn safety harness (keep the orange straps) holding an obvious pick, with the head gone: a tight knot of black void, hard-edged, darker than anything around it and clearly not hair, where the face should be. The pick and the void head must both read at 48x64.
- **enemy_ink_bloom_grey_s** (actors_48x64_01)
  - Problem: blood-red caps on a brown stalk; visible pixels average 58,40,39. ToME tells the mold variants apart by colour alone (grey mold is SLATE).
  - Regenerate: keep the rooted cup-fungus shape and the black stain at the base, recoloured to desaturated grey: ash-grey caps, charcoal stalk, a black stain that looks deeper than the floor. No red.
- **enemy_ink_bloom_shining_s** (actors_48x64_01)
  - Problem: a rust-brown mass of trailing roots around a cream core, shaped like a jellyfish and close to the brown bloom in colour. No crackle; ToME's shining mold is YELLOW.
  - Regenerate: a floor-rooted fungal bloom whose caps and core glow pale yellow-white, with a few crisp electric-yellow spark arcs over a dark base that sits on the ground.
- **enemy_ink_spill_green_s** (actors_48x64_01)
  - Problem: an olive-khaki compost mound (average 78,63,39, more brown than green) with nothing glossy or liquid. The sunken shapes are present, but as pages rather than bones.
  - Regenerate: a low, flat, spreading pool of glossy green ooze with a liquid edge and wet highlights, and two or three half-dissolved bones sinking in it. Mostly horizontal.
- **enemy_ink_spill_blue_s** (actors_48x64_02)
  - Problem: a hooded, robed wraith with a face, hands and brown robe bands.
  - Regenerate: a low, spreading blob of blue-black liquid ooze with wet highlights and a pale frosted crust or ice-rimmed edge, with drips and splashes across the floor. Blue-black and pale frost blue only.
- **enemy_ink_spill_white_s** (actors_48x64_02)
  - Problem: a white shrouded ghost with a hooded face and trailing clawed arms.
  - Regenerate: a chalk-white spill of blankness shaped as an ooze or puddle: a blank, matte mass whose rim wipes out the floor texture beneath it. Low silhouette, white and pale grey with a dark outline so it reads on light floors.
- **enemy_ink_spill_black_s** (actors_48x64_02)
  - Problem: a hooded, robed wraith. It is mostly near-black, so the colour is acceptable; the shape is the defect.
  - Regenerate: a low, spreading mass of glossy near-black ooze with faint rim highlights and a slight dark halo at its edge suggesting it swallows light. Neutral black, no olive or khaki highlights.
- **enemy_ink_jelly_black_s** (actors_48x64_02)
  - Problem: large pale lavender-grey chunks that read as rubble, about half pale, with no depth to them.
  - Regenerate: a mound matching the other jellies' silhouette, with a glossy, predominantly black body holding a few faint pinprick lights deep inside it, like a night sky seen through jelly. No faces, skulls or rock chunks.
- **enemy_static_hound_s** (actors_48x64_02)
  - Problem: a solid brown dog with orange flecks spraying off it like embers (45% red and 12% orange saturated pixels). It reads as a fire creature, and no teeth are visible.
  - Regenerate: a stray hound facing south whose body is mostly grey, white and black TV static with a broken, flickering outline. Only the bared teeth are drawn solid and crisp. No warm flecks.
- **enemy_unfiled_ghoul_s** (actors_48x64_03)
  - Problem: an upright cream sheeted ghost with navy streaks, no hunch and no nails. It is nearly the same as enemy_ruin_banshee_s, and several undead share Saint's Rest.
  - Regenerate: a grey-skinned, visibly hunched corpse (head forward and down, back curved, knees bent) with a torn, dirty-grey burial shroud hanging off it. Arms forward and down, with long cracked grey-yellow nails that stand out in the silhouette. Grave-dirt greys and bone; no blue.
- **enemy_broken_automaton_s** (actors_48x64_04)
  - Problem: a brown, green and rust organic hulk with an empty chest cavity. There is no brass, no metal highlight and no gear; the only mechanical cue is a small spring. (The claim that it blends with the young rock-eater was refuted.)
  - Regenerate: plainly man-made. Riveted brass and iron plates with soot and verdigris and hard metal highlights. Lopsided and half-collapsed: slumped to one side, one leg dragging with loose cabling, one arm hanging. An open chest or hip panel shows 2-3 bright brass gear wheels against a dark cavity. Angular plates, not lumpy masses.
- **enemy_umbral_horror_s** (actors_48x64_05)
  - Problem: the white pinprick eyes are missing. The brightest pixels are 139,150,166 streaks on the torso, and the hood is solid dark.
  - Regenerate: keep the tendril body and claws, and add two 1-2 px near-white (about 240,240,250) pinprick eyes inside the hood as the brightest point in the sprite. Tone down the torso streaks.
- **chr_npc_mourner_s** (actors_48x64_05)
  - Problem: slate-blue veil and dress with crimson trim and a red rose; the held flowers are a tan cross shape. Nothing is black.
  - Regenerate: head to toe in black (long black veil over the face, high-collared black dress, black gloves) with only dark-grey highlights. She holds 2-3 white lilies (white trumpet flowers on green stems) at the chest as the one bright accent.
- **chr_npc_merrow_stitch_s** (actors_48x64_05)
  - Problem: no tape measure, needles or spool. The big cream apron and mob cap make her a near-twin of the repeatable chr_npc_citizen_woman_s.
  - Regenerate: make the patched waistcoat the focus (no large apron). Add a yellow tape measure draped round the neck with both ends hanging, 2-3 silver needle pixels on a lapel, and a spool of black thread in one hand. Drop or shrink the mob cap.
- **chr_npc_miner_s** (actors_48x64_06)
  - Problem: the helmet is a mottled cap or turban with no lamp, the pick reads as a staff or crossguard sword, and the face is warm skin rather than dust-grey.
  - Regenerate: a hard miner's helmet (dome and brim) with a brass lamp whose lens is 2-3 px of warm light. A pickaxe with a plainly visible double-pointed iron head at least 7-8 px wide, held or on the shoulder. Dust-grey face and clothes. One hand held out and tensed.
- **chr_npc_quartermaster_s** (actors_48x64_06)
  - Problem: bare chest under an open blue coat (reads as a sailor or pirate). The rope is a solid red sash, and the clipboard is a 3x4 grey smudge.
  - Regenerate: a shirt and waistcoat, or a buttoned work coat. A clipboard at chest height with a board, a pale sheet and a metal clip (about 6x8 px). A coil of hemp rope over one shoulder shown as stacked tan loops with dark separations. The blue coat can stay.

##### Actors 96x128 (8)

- **enemy_the_watcher** (actors_96x128_01)
  - Problem: none against the new brief. The delivered navy and cream tendril mass around one large open eye is what this creature is; the old order asked for filing drawers and is withdrawn. What is missing is the altar it grew out of, and the silhouette is dark enough to sink into a dark floor.
  - Regenerate: keep the tendril mass and the single large open eye. Root the tendrils in a low heap of stacked grey stones and left-out offerings (a cup, a doll, a candle stub, 4-6 px each) so it reads as an altar still being added to, and give the whole silhouette a firm dark outline. No filing drawers, pages, redaction bars or ink; no symmetric diamond or sparkle glints.
- **enemy_the_prism_record** (actors_96x128_01)
  - Problem: cream root tendrils bury the cyan facets, and the red core reads as an eye or gem. No burning hole.
  - Regenerate: plainly mineral: a faceted crystal cluster with straight edges, flat planes and glassy highlights, and no tendrils. Visible inside it is a single ragged black hole rimmed in orange-yellow fire, reaching further back than the crystal is thick. Pale cyan or white glass (not navy and cream), with a solid angular outline.
- **enemy_ninandra_the_great_weaver** (actors_96x128_03)
  - Problem: a mirrored gold filigree around a glowing cyan lattice. There is no body, no eyes and nothing caught in anything, so it reads as a heraldic crest or a frost rune, and the cyan reads as a cold or lightning effect.
  - Regenerate: an unmistakable giant spider facing south, with a fat abdomen, a head with a cluster of eyes, and eight separately readable jointed legs. Behind her is a web with recognisable human shadows caught in its strands (flat black person-shapes with no shading, some torn, one or two still reaching). Dark, solid body; cyan only as small highlights. It must read in silhouette first.
- **enemy_the_archive_queen** (actors_96x128_03)
  - Problem: an unsegmented fleshy mass. At play size two round pale bulges above a long dark vertical slit read as breasts and genitals, a tone failure for this setting. There are no nests (the eggs on the lower body do read).
  - Regenerate: a segmented ant queen facing south: head with mandibles and antennae, narrow thorax, six jointed legs, and a huge swollen abdomen carrying clusters of small pale ovals. No central slit or opening and no pair of large round forms. Her base is surrounded by nests of bone, hair and dried gut built into comb-like cells. Chitin brown and bone cream with a clear dark outline.
- **enemy_brown_bear** (actors_96x128_04)
  - Problem: a steel blue-grey coat (47% of pixels lean blue, 0% warm) beside the genuinely brown war bear. ToME's bear.lua gives it colors.UMBER.
  - Regenerate: keep the reared, roaring pose and fur detail, and repaint in warm browns: umber shadow, chestnut mid-tones, dusty tan highlights on the shoulders and muzzle. No blue. Lighter or more grizzled than the war bear, so the two stay apart.
- **enemy_archlich** (actors_96x128_05)
  - Problem: the crown is tapered brown spikes (no joints or nails), and the robe is split by a glowing purple seam rather than a flat black hole. Purple glow alone is fine, since it is the Index accent.
  - Regenerate: keep the floating lich, the outstretched skeletal hands and the dark palette. The crown becomes 4-6 recognisable long black fingers standing upright, jointed, with a pale nail catching the light on one or two. The robe, or a wide band down its front, is a flat-black, hard-edged hole with nothing behind it. Accents stay small (violet or faint static), and the skull face is not split by an energy seam.
- **enemy_eternal_bone_giant** (actors_96x128_05)
  - Problem: the bones are smooth bone-white, with no pitting even at 10-12x zoom. That feature is the only thing tying this giant to the setting. Its silhouette resemblance to the other giants is normal family likeness, so changing the pose is optional.
  - Regenerate: cover the large bone surfaces (ribs, upper arms, thighs, shins, skull crest) in dense rows of 1 px black pits and holes, following the length of each bone, so they read as bone riddled deeper than it is thick at 1x.
- **enemy_patchwork_brute** (actors_96x128_06)
  - Problem: no brass anywhere (none of its 48 colours is brass), teal lines that wander like veins, no head, and four or more embedded skulls, so it reads as a necromantic bone golem. A teal lacing over the chest slit does exist.
  - Regenerate: keep the hulking brute made of several bodies. Give it a head, even a mismatched one. Add suture seams with short cross-stitches where limbs and panels of skin meet, with mismatched skin tones either side, and several bright brass staples or clamps readable at native size. At most one skull.

##### Effects (8)

- **ui_fx_area_cold** (effect_256x64_01)
  - Problem: the fire area's flame mound recoloured blue, dominated by a big wispy tongue, so frames 1 and 4 read as blue flame. It has the same tiling failure, and coverage pulses from 15% to 37%.
  - Regenerate: R-AREA. Frozen ground in pale blue and white: rime, frost ferns, small ice crystals and low freezing mist across the whole cell. Animate with glinting crystals and drifting mist at constant coverage. No flame shapes and no shared silhouette with fire.
- **ui_fx_area_lightning** (effect_256x64_01)
  - Problem: violet flame tongues with yellow veins on the fire mound; it reads as purple fire, tiles as rows, and pulses from 13% to 32%.
  - Regenerate: R-AREA. Electrified ground: thin, crisp, branching electric-yellow arcs over a faint violet static haze across the whole cell. Arcs leaving one edge enter the opposite edge at the same point. Animate by re-routing arcs and flashing sparks at steady coverage.
- **ui_fx_area_acid** (effect_256x64_02)
  - Problem: it reads as green fire, with the same rising flame silhouette as fire, blight and light. Its hue overlaps nature (acid 39% at 60-80 deg and 52% at 80-100 deg; nature 62% at 60-80 deg). It also fails tiling (section 3).
  - Regenerate: R-AREA, as a liquid hazard: a corrosive puddle or spatter with popping bubbles, thin fumes and pitted edges, low and not flame-shaped. Use the acid colour settled in section 5, clearly apart from nature's leaf green and brown.
- **ui_fx_beam_fire** (effect_256x64_04)
  - Problem: each frame is a campfire on a 1 px ground line (row 49) with grey smoke rising. Its edge columns are empty in every frame, so it tiles as a row of bonfires, and on a diagonal or vertical beam the flames would point sideways.
  - Regenerate: R-BEAM, as a horizontal jet of fire pushing east along the beam: a white-yellow core streaming inside orange and red flame, with licks trailing along the axis. The flame body is at least 6-8 rows thick and reaches columns 0 and 63 at matching rows in every frame. No ground line and no vertical smoke; animate as flow along the axis.
- **ui_fx_stunned** (effect_256x64_05)
  - Problem: a wide (about 50 px) cyan ellipse over the torso with gold sparks. Frame 3 swells into a cyan tornado (1035 px against about 410) and collapses in frame 4. It reads as a wind or cold effect.
  - Regenerate: R-OVERLAY. A tight elliptical ring 28-36 px wide in the top 20 px of the cell, with 3-4 warm spark or star glints moving a quarter-turn per frame. Constant size, neutral ring, no saturated cyan.
- **ui_fx_confused** (effect_256x64_05)
  - Problem: no question marks. A mauve flame spirals up from a ground ring, the same template as asleep and poison_cloud (IoU 0.57-0.60), with a colour near the mind and arcane families. It drifts about 15 px across the loop.
  - Regenerate: R-OVERLAY and R-GRID4. 2-3 small hand-scrawled question-mark squiggles in ink-scribble strokes circling in the top 24 px, rotating or bobbing between frames. No ground ripple or flame column.
- **ui_fx_ink_pool** (effect_256x64_06)
  - Problem: a black flame or ink geyser rising from a ripple ring to y=2. The base stays the same width, so nothing spreads, and it tiles as nine fountains.
  - Regenerate: R-AREA and R-GRID4. A low, flat pool of glossy black ink that visibly spreads outward over the frames (creeping edges, seeping tendrils), with an optional faint redaction-bar or smeared-type texture in the sheen and little or no height.
- **ui_fx_debuff** (effect_384x64_05)
  - Problem: there is no downward motion; the vertical centroid rises and falls (37.7 to 32.0 to 40.2) and the effect is a coiled tendril cage. The brightest pixel is 63,104,104 and mean luminance is 31.5, so it vanishes on dark floors, and the teal-black sits near the darkness family.
  - Regenerate: R-GRID6, as ink running down over a body. Beads of ink gather at the top in frame 1, drips and runnels fall visibly lower each frame in frames 2-4, and drops splash and fade at the base in frames 5-6. Near-black ink with a cold grey or violet-grey highlight rim and a few light specular dots. Not deep blue.

##### Items and props (6)

- **item_wand** (item_64x64_01)
  - Problem: a mid-brown stick running the full diagonal, with a leaf-shaped tan spearhead and a grey rag, so it reads as a javelin. The claim that it duplicates the rod was refuted; it sits closer to the surveyor's staff and boathook.
  - Regenerate: a short wand about half the icon's diagonal, centred, in black or very dark wood, with a slim brass ferrule or rounded cap at the tip (never a blade). No rags. Slender and plain, distinct from rod, staff and boathook.
- **prop_evidence_box_open** (prop_64x64_03)
  - Problem: the closed box is a wide, low rusty tin case with a handle, corner caps and keyhole plate, but the open one is a tall wooden plank crate. When a player opens the chest it turns into a different object.
  - Regenerate: the open version of the exact prop_evidence_box_closed sprite: the same rusty grey tin with orange rust, the same iron corner caps and carry handle, the same footprint and baseline. Lid hinged back, hasp hanging open, dark empty interior. No wood grain or crate bracing.
- **prop_trap_rune_ice** (prop_64x64_03)
  - Problem: an upright mossy standing stone with a carved rune, the full cell height, sitting on rubble. It reads as an obstacle, not a trap you step on.
  - Regenerate: a flat chalk sigil on the floor with the angle, line weight and footprint of prop_trap_rune_acid: a thin chalk circle with a snowflake or crystal glyph glowing faintly icy blue. Nothing rising off the floor.
- **prop_trap_rune_lightning** (prop_64x64_03)
  - Problem: a wooden two-post frame holding a parchment banner painted with a bolt. It reads as upright furniture.
  - Regenerate: the same flat chalk circle as the acid rune, with a jagged lightning glyph glowing faintly yellow, clearly apart from the fire rune's orange. No frame, posts or parchment.
- **prop_trap_time_pocket** (prop_64x64_03)
  - Problem: a solid brass armillary sphere on a pedestal, which reads as furniture or loot. Brass clockwork belongs to Alderbrook, not the Outer Index, and nothing about it is a ripple in the air.
  - Regenerate: a small, intangible, lens-shaped warp floating mid-cell, drawn with concentric ripple rings, the floor behind it slightly doubled or offset, and a few frozen motes or clock-hand ticks hanging in it. Cool pale silver-blue with faint Index static at the edges. Hard-edged opaque pixels that still read as translucent; it must not look solid.
- **prop_trap_teleport_glyph** (prop_64x64_03)
  - Problem: a clean, symmetrical dark-green wheel with brass studs and no static at all. As a green concentric floor circle the same size as the acid rune, a player will read it as acid.
  - Regenerate: a rough floor circle made of static: broken, jittery rings of grey-white noise pixels with gaps and misaligned segments, plus stray specks inside. No green and no brass; an optional faint Index violet tint.

#### 5. Damage colour (6 majors)

- **enemy_archive_ant_fire_s** (actors_48x64_02)
  - Problem: the only saturated hues are cyan and green-cyan on a near-black shell, with no red, orange or yellow at all. No antennae, and the body looks like a spider's.
  - Regenerate: an ant (head, thorax, narrow waist, separate abdomen, six legs, antennae) whose dark cracked shell glows orange-red from inside, like a coal with ember light in the cracks. Fire family only.
- **enemy_archive_ant_ice_s** (actors_48x64_02)
  - Problem: no blue pixels at all; the body is rust-brown with desaturated frost. Next to the cyan fire ant, the two elemental ants read the wrong way round.
  - Regenerate: a plainly blue ant (icy blue body, white frost crust on the back and legs) with three body segments, a narrow waist, six legs and antennae. No brown or rust as the main tone.
- **enemy_archive_ant_acid_s** (actors_48x64_02)
  - Problem: 79% of pixels are mustard and none are green, so it blends with the lightning ant and gum spitter. No antennae, and too many legs.
  - Regenerate: a sickly bright green ant with glossy green acid dripping from the abdomen and pooling under it, with the same ant anatomy as above. No mustard or khaki.
- **ui_fx_beam_arcane** (effect_256x64_04)
  - Problem: mean saturation 0.65, value 0.27 and 2% bright pixels, against 0.90, 0.39 and 15% on the arcane bolt. It is a dim violet (hue 277) knot around a black bar, with no glyph flecks. Frame 1's columns 0-1 and frame 4's columns 62-63 are empty, so seams break for half the loop.
  - Regenerate: R-BEAM, in the same bright magenta family as ui_fx_bolt_arcane and ui_fx_area_arcane: a glowing magenta-pink core with a near-white centre line instead of a black bar, plus small drifting glyph or rune flecks. The core band (rows 31-36) reaches columns 0 and 63 in all four frames at matching rows, and it must read on a near-black floor.
- **ui_fx_hit_acid** (effect_384x64_01)
  - Problem: the peak frames are a lime-yellow starburst of the same shape, size and colour as ui_fx_hit_nature (mean hue about 81 deg against 63 deg); only bubbles versus leaves tell them apart. The collision is family-wide: ui_fx_hit_blight has the same lime-white core, and ui_fx_bolt_acid and ui_fx_area_acid use the same saturated lime.
  - Regenerate: first settle one acid colour and retune acid's bolt, area and hit together (or push nature toward olive and brown and give blight a non-lime core). For the hit, use a poisonous, bilious green (cooler emerald or toxic green with sallow yellow-grey highlights), with corrosive fizz, hissing droplets and thin acrid smoke instead of a radiant star. Side by side at 1x it must not be confused with hit_nature, and it must stay clear of blight's bile green. Keep the 6-frame burst-then-fade timing, with nothing crossing frame boundaries. Do not fix the streak arriving from the west on this sprite alone (style note 3).
- **ui_fx_hit_blight** (effect_384x64_02)
  - Problem: 41% of pixels sit in the 60-89 deg yellow-green band (acid is 50%), only about 15% are chromatic purple, and 36% are near-black, so the purple sinks into a dark floor. It reads as acid. The frames also bleed: about 54 px apart, with frames 4-6 cut flat on the left.
  - Regenerate: R-GRID6. Bruise purple is the main readable mass: a mid-value sickly purple-mauve cloud with lighter purple highlights. Bile green appears only as spatter droplets and a sickly olive edge. The core highlight is pale greenish-mauve or dirty cream, not acid's yellow-green.

#### 6. Duplicate-looking (8 majors)

- **enemy_fillarel_aldaren_s** (actors_48x64_01), looks like enemy_aluin_the_lapsed_curate_s
  - Problem: the same hooded red-brown robe, void face, disc-topped staff and ragged black spray, with silhouette overlap 0.77. The disc staff is Aluin's trait, and the brief's grey robes and plain staff are missing. They are in different zones, but both are named bosses.
  - Regenerate: a severe, upright mage in plain grey travelling robes (cool grey, no red or brown) with a visible stern face, and a straight, unadorned dark-wood staff with no disc, eye or sun. A clean silhouette without the black ragged spray.
- **enemy_grave_wight_s** (actors_48x64_03), looks like enemy_master_vampire_s and the lesser vampire (all in Saint's Rest)
  - Problem: a pale bald head on a dark long coat. There are zero blue or cyan pixels, so the cold chest light that was meant to set it apart is missing.
  - Regenerate: a clear cold blue glow in the centre of the chest (a 2-4 px cyan-blue core with a dimmer halo), visible through open grave clothes. Show the grave clothes as a burial suit or winding cloth in dusty grey-brown, not a dark purple frock coat. A gaunt dead gentleman facing south.
- **enemy_cutpurse_s** (actors_48x64_04), looks like enemy_bandit_s
  - Problem: the same green long coat, red face scarf, cap, cross-belts, boots and stance. At native size only the weapon differs; the cutpurse is slightly slimmer, but not enough to read.
  - Regenerate: a noticeably skinny, narrow-shouldered cutpurse in a short tight jacket or waistcoat, in a palette clearly apart from the bandit's (faded mustard, grey-brown or dirty blue). Face uncovered, with sharp eyes glancing sideways. A small, sickle-like hooked purse knife held forward, the other hand low and ready to snatch. The slimmest human on the sheet.
- **chr_npc_foundry_hand_s** (actors_48x64_05), looks like chr_npc_smallholder_s
  - Problem: a red cloth cap, red apron, clean cream sleeves and a long tool held low, with nothing soot-black; the tongs read as a trident. They spawn in different zones, but the defining trait is missing.
  - Regenerate: a soot-black foundry hand in charcoal clothes and a dark brown leather skullcap, with soot-smeared face and forearms and maybe one hot orange forge glint. Heavy tan leather gauntlets to the elbow, and long two-jawed iron tongs held diagonally. No red cap and no cream sleeves.
- **enemy_ancient_lich** (actors_96x128_04), looks like the live enemy_index_husk_elite_s and enemy_index_eidolon_s
  - Problem: an antlered deer skull above a robe tapering to a ragged floating hem, close to a recolour of husk_elite. No brief outside the Index faction uses antlers, and it clashes with enemy_lich_s. The ash is scattered flecks rather than a column, and the navy robe edges sink into dark floors.
  - Regenerate: no antlers and no deer skull. A withered ancient human skull, perhaps hooded, consistent with enemy_lich_s, in tattered grave robes, floating. A readable vertical column of pale ash falls upward past the body, a little brighter than the robe. Raise the robe values or add a rim light.
- **ui_fx_area_light** (effect_256x64_02), looks like ui_fx_area_fire
  - Problem: a near-identical silhouette and pulse (low flicker, a tall central tongue in frame 3, flanking tongues). It is gold where fire is red-orange, but golden flame tongues still read as fire. It also fails tiling (section 3).
  - Regenerate: R-AREA, as an even field of radiance: glare, glinting motes and soft rays in pale gold with a dominant white core. No flame tongues and no orange.
- **ui_fx_asleep** (effect_256x64_05), looks like ui_fx_confused (and ui_fx_poison_cloud)
  - Problem: a navy flame spiralling up from a ground ring with crescent hooks, the same drawing as confused apart from colour (mask IoU 0.57). It reads as a darkness or cold area, not as motes above a sleeper.
  - Regenerate: R-OVERLAY and R-GRID4. A few small, soft, pale motes drifting slowly upward in the top third of the cell, above where a head would be. No ground ring and no flame column. Quiet, small motion, in a muted colour.
- **ui_fx_smoke** (effect_256x64_06), looks like ui_fx_ink_pool
  - Problem: the same template (ripple rings, rising S-curve tendrils, flying chunks, small-medium-tall-small), tinted blue-teal (median hue 201, mean 53,65,71) rather than grey. The ripples make it read as a steaming puddle, and it tiles as nine separate puffs.
  - Regenerate: R-AREA and R-GRID4. A soft, neutral grey smoke cloud (low saturation, no teal) filling the cell with rolling billows that drift and thin. No ripple rings or splash chunks, and an outline clearly unlike the ink and fire ground effects.

#### 7. Unreadable (7 majors)

- **enemy_barrow_end_shade_s** (actors_48x64_01)
  - Problem: a speckle cloud of pale pink, blue-grey and dark pixels. There is a faint head but no readable collar, and the orbiting scraps are single-pixel noise. It is a named zone boss.
  - Regenerate: a ghostly sorcerer with a readable head framed by a tall stiff collar, in pale spectral tones, with a few distinct scraps of his own shadow (small ragged near-black shapes with a faint pale rim) orbiting him. A solid central silhouette with no scatter noise.
- **enemy_bee_swarm_s** (actors_48x64_03)
  - Problem: slate and teal speckle with zero amber pixels and no individual bees. Its roughly diamond outline sits next to the moth swarm's similar shape.
  - Regenerate: 10-20 separate small bees, each with a readable body and wing pixels, in dull amber and soot-black banding (grim, not cute). Space them unevenly, with a few darting out from the edges, and avoid a symmetric diamond outline.
- **enemy_archive_ant_army_s** (actors_48x64_03)
  - Problem: an upright tapering cone of orange ovals that reads as a burning pine cone or a pillar of embers. No heads, legs or gaps.
  - Regenerate: ants readable at native size (3-5 px bodies with head, thorax and abdomen, 1 px legs) in dark chitin brown-black with only a faint amber highlight. Arrange them as a low, wide marching column or a stream winding toward the viewer, not a vertical pillar, with space between ants.
- **enemy_blade_horror_s** (actors_48x64_05)
  - Problem: a purple diamond-shaped void swirl with speckle and no knife shapes. The brightest pixel is 137,123,165, so nothing catches the light like steel.
  - Regenerate: keep the dark empty centre, and orbit it in a pinwheel with 5-7 separate knife-shaped blades, each with a pale steel 1 px edge highlight, a dark spine and a small hilt, points trailing the spin. Clean gaps with no stray pixels. Faint ink or static is allowed, but the knives dominate.
- **icon_status_disarmed** (status_icon_64x64_01)
  - Problem: a downward sword wrapped in red and yellow flame-like wings, with nothing showing it falling. At the real 24 px badge size (partypanel.ts BADGE_PX = 24) it is a red-orange blob close to icon_status_burning.
  - Regenerate: one steel-grey sword with a brass hilt, tilted 30-45 degrees and dropping, with 2-3 short motion lines above it or a small gap below an open hand. No red, orange or yellow, and it must read at 24 px. A frame is not required: unframed dark squares are also live style.
- **icon_status_stealthed** (status_icon_64x64_01)
  - Problem: an abstract broken "A" or chevron with a fragment floating off it; at 24 px it is a dark navy hook on near-black.
  - Regenerate: a clear front-facing hooded cowl with a rounded peak and a dark void face opening, lit so one vertical half is muted slate blue and the other falls into near-black. It must read as a hood from its silhouette alone at 24 px, with more contrast against the ground.
- **prop_trap_tripwire** (prop_64x64_03)
  - Problem: a 1 px wire (about 60,47,35) between dark pins along the bottom edge, covering 5% of the cell. On flat dark delve floors only the teal tag survives, and a detected trap has to be visible.
  - Regenerate: keep the two pins and the wire. Thicker pins with lighter metal caps, a wire in pale dull steel or pale twine with a 1 px dark shadow beneath, running across the lower middle rather than hugging the bottom edge, and one small pale tag or bell on the wire as the focal point.

#### 8. Scale (2 majors)

- **chr_npc_street_crier_s** (actors_48x64_05)
  - Problem: the body was shrunk to 50 px (cap top at y=12) to fit the raised broadsheet, against 59-60 px for every other human on the sheet, so he reads as a youth. The brief says adult.
  - Regenerate: full human scale (cap at about y=2, feet at y=61, the same height as chr_npc_citizen_man_s). Hold the broadsheet at head height beside the face, or angle the arm outward, instead of shrinking the body. Keep the navy coat, satchel of papers and adult face.
- **chr_npc_lamplighter_s** (actors_48x64_05)
  - Problem: the body top is at y=15, making a 47 px figure, while Reeve Ashcombe carries a lantern pole and still stands 57 px. The face is a featureless tan strip like a beak mask, and the pole is brown rather than brass.
  - Regenerate: full human scale (head at y=2-4, feet at y=61), with the pole running past the head to the top edge or leaning diagonally. A brass pole with warm yellow highlights, a turned-up collar with a readable face above it, and a soot-dark coat suited to fog.

#### 9. Off-style (1 major)

- **icon_status_terrified** (status_icon_64x64_01)
  - Problem: a cream cartoon head fills the tile, with goggle eyes, a bowl-cut cap and fang nubs, so it reads as comic and breaks the grim tone. The sweat drop's highlight is a letter-like "k"/"L" glyph.
  - Regenerate: only a pair of wide, staring eyes (small pupils, strained raised brows) and one pale sweat drop. No face, hat or teeth. Muted pale bone and ink grey with a cold blue-green drop, centred with a 4-6 px margin; the drop highlight is a plain 1-2 px shine. A frame is not required.

#### 10. Cropped (1 major)

- **ui_fx_bolt_acid** (effect_256x64_02)
  - Problem: frame 3's bright lime tip runs about 4 px into frame 4 (columns 188-195 hold 8,8,6,6 then 4,4,3,2 px). Frame 3 plays with its point cut flat and frame 4 flickers a sliver.
  - Regenerate: covered by R-FLIGHT in section 2c; keep at least 2 px clear at the east edge of every frame.

### Look-alikes to separate (regenerate the first sprite)

| Regenerate | Looks like | Evidence |
|---|---|---|
| enemy_fillarel_aldaren_s | enemy_aluin_the_lapsed_curate_s | silhouette overlap 0.77; same robe, void face, disc staff |
| enemy_grave_wight_s | enemy_master_vampire_s, lesser vampire | same pale head on dark long coat, all in Saint's Rest |
| enemy_cutpurse_s | enemy_bandit_s | same coat, face scarf, cap, belts and stance |
| chr_npc_foundry_hand_s | chr_npc_smallholder_s | red cap, cream sleeves, red torso, long tool held low |
| enemy_ancient_lich | enemy_index_husk_elite_s, enemy_index_eidolon_s (live) | antlered deer skull over a tapering floating robe |
| ui_fx_area_light | ui_fx_area_fire | same flame silhouette and pulse |
| ui_fx_asleep, ui_fx_confused, ui_fx_poison_cloud | each other | one flame-on-ring template, mask IoU 0.57-0.60; all three regenerate |
| ui_fx_smoke, ui_fx_ink_pool | each other | one ripple-and-tendril template; both regenerate |

The second reviewer also confirmed these look-alikes inside other majors: chr_npc_merrow_stitch_s with chr_npc_citizen_woman_s; enemy_unfiled_ghoul_s with enemy_ruin_banshee_s; ui_fx_area_cold and ui_fx_area_lightning as recolours of ui_fx_area_fire; and ui_fx_teleport_out, ui_fx_teleport_in and ui_fx_stealth_fade, which share one motion.

Downgraded or refuted pairs, with no separate regeneration needed: enemy_the_prism_record / enemy_the_watcher (minor; both regenerate anyway), enemy_blood_lich / enemy_index_eidolon_s (minor; overlap 0.49), item_clerks_coat / item_leather_duster (minor), item_wand / item_rod (refuted), enemy_copperhead_s / enemy_hooded_cobra_s (refuted).

### Polish, optional, in the same pass

Each line gives the issue, then the fix. (v) marks a finding the second reviewer downgraded from major; the rest were raised as minor and never verified.

**actors_48x64_01**
- enemy_struck_rat_spectral_s (v): opaque purple rat with a visible spine and ribs, not a see-through static outline. Fix: a bright static outline around a hollow dark interior, no ribs.
- enemy_ledger_mouse_s (v): 44x59, bigger than a watchman for a terrier-sized mouse. Fix: settle it with the rest of the family (style note 5).
- enemy_ledger_rat_s (v): 43x60 for a forearm-long rat. Fix: same family decision.
- enemy_aletta_soultorn_s: reuses Aluin's eye-disc staff and void-eye face, and doesn't read as a woman. Fix: no staff; a feminine head and gown split down the middle into solid and static halves.
- enemy_borfast_the_broken_s: the head reads as a beaked mask; lamp and loose jaw aren't legible. Fix: a clear miner's helmet with a bright lamp and a visibly dropped jaw.
- enemy_struck_rat_ghoulish_s: human height; stitched mouth invisible. Fix: rat scale, with broken pale thread stitches across the mouth.
- enemy_struck_rat_vampire_s: fills the canvas. Fix: about 30-36 px tall, with blacker fur.
- enemy_struck_rat_skeletal_s: 60 px tall. Fix: rat scale.

**actors_48x64_02**
- enemy_archive_ant_carpenter_s (v): no antennae, spider-like legs, sawdust unreadable. Fix: ant silhouette, bent antennae, visible pale sawdust at the jaws.
- enemy_archive_ant_white_s (v): the carried load reads as an extra body segment; no antennae. Fix: the torn-off hand as a separate pale shape with readable fingers and a ragged wrist.
- enemy_archive_ant_brown_s (v): an evenly segmented tube, like a termite or tick. Fix: big head, antennae, narrow waist, rounded abdomen.
- enemy_moor_wolf_s (v): lowered head hard to read, teal tint, no ribs. Fix: plain grey, readable muzzle, ribs along the flanks.
- enemy_hooded_cobra_s: gold trim and heraldic glyphs. Fix: natural muted snake colours.
- enemy_rattlesnake_s: saturated indigo and violet. Fix: dusty tan and brown with dark diamond bands.
- enemy_archive_ant_lightning_s: fat oval body, no waist; olive-gold close to the acid ant. Fix: ant segments, cleaner electric yellow.
- enemy_gum_spitter_s: no swollen jaw. Fix: bulging chelicerae with a string of black gum.
- enemy_great_wolf_s: no torn ear or scarred muzzle; green cast. Fix: notched ear, pale muzzle scar, grey-brown coat.

**actors_48x64_03**
- enemy_filed_bruiser_s: an unexplained shadow tendril or third arm. Fix: remove it.
- enemy_citation_moth_swarm_s: no eyes on the wings. Fix: a 2x2 px pale eyespot with a dark pupil on each wing of the 3-5 largest moths.
- enemy_banshee_s: muddy grey-brown, mouth not open. Fix: pale cold grey-white with a clearly open mouth.
- enemy_lich_s: the held object is a beige blob with no glow. Fix: a small lantern of about 5x5 px whose glass is black, with a 1 px pale halo around it.
- enemy_risen_corpse_s: rotted, no pennies on the eyes. Fix: waxy fresh corpse in dark Sunday clothes with two dull copper pennies on its eyes.
- enemy_forest_wight_s: no marsh-light eyes. Fix: two small glowing pale green-yellow eyes.
- enemy_ruin_banshee_s: green streaks read as moss. Fix: plaster whites and dust greys with falling chunks.
- enemy_wrong_shadow_master_s: not taller than wrong_shadow; pale cross glyph; blob orbiters. Fix: a taller, broader shadow with 4-6 small person-shaped shadows orbiting it.

**actors_48x64_04**
- enemy_archive_glass_multihued_s: a ragged three-blob starburst. Fix: one faceted prism in the shard family's shape, with refraction bands and coloured light spots on the floor.
- enemy_rogue_sapper_s: fuse unlit. Fix: a charge with a bright spark and a pixel of smoke.
- enemy_filed_firebrand_s: no fuel tank. Fix: tank tops above the shoulders, harness straps, a hose to the brand.
- enemy_filed_grand_knife_s: no blade in the teeth. Fix: a pale blade across the mask's mouth.
- enemy_filed_master_knife_s: no scar. Fix: a 1 px diagonal scar across the lips and chin.
- enemy_rock_eater_young_s: fills the cell though young; no gravel teeth. Fix: 60-70% of the cell height, jagged gravel teeth, cooler grey stone.

**actors_48x64_05**
- chr_npc_city_watch_s (v): green uniform where the sergeant wears navy; no truncheon; blank face. Fix: the sergeant's uniform family (navy, brass buttons, matching helm, no sash), a truncheon at the hip, simple features.
- chr_npc_thessaly_vaunt_s: blue cloth apron and no glowing flask. Fix: stained leather apron and a small flask with a faint non-damage-colour glow.
- chr_npc_curate_s: green cassock and hat. Fix: black cassock with a white collar.
- chr_npc_office_secretary_s: green dress, no glasses or tin, same updo as the registry clerk. Fix: plain dark dress, glasses on a cord, a round silver tin, a different hairstyle.
- chr_npc_registry_clerk_s: the eyeshade reads as a blindfold; pen hard to find. Fix: translucent green visor with the eyes visible, a clear pen, short hair.
- chr_npc_alchemy_apprentice_s: jars are blobs; face hidden. Fix: 3-4 distinct jars with rim highlights, an oversized brown apron, a visible face.
- enemy_dream_seed_s: 60 px tall; diamond outline echoes the blade horror. Fix: about 28-34 px with a rounder seed shape.

**actors_48x64_06**
- chr_npc_chapel_warden_s (v): no bell. Fix: a bronze handbell (about 5x6 px, dark mouth) and a wetter hem.
- chr_npc_apothecary_s: mortar, pestle and bottles unreadable; green hat and coat echo the drover. Fix: a pale stone mortar and pestle, 3-4 tiny bottles at the belt, a different hat or coat colour.
- chr_npc_pawnbroker_s: no readable spectacles, loupe or ticket book. Fix: 1 px spectacle rim, a black loupe with a highlight, a small ticket book; clean the skirt edge.
- chr_npc_fence_s: faceless grey wedge under the brim, which edges toward the Redacted look. Fix: a human face with eyes glancing sideways.
- chr_npc_archivist_s: skin-toned hands; the case reads as a framed picture. Fix: white gloves; a glass case with a bright rim, a diagonal highlight and a document inside.

**actors_96x128_01**
- enemy_the_prism_record, look-alike of the watcher (v): shares the symmetric tendril-diamond template. Fix: resolved by regenerating both (section 4).
- enemy_the_dreaming_one (v): no sleeper's head or mouth; smoke rises from the peak; sparkle glints. Fix: a readable head with a slack open mouth pouring pale blue dream-smoke, sodden sheets, no glints.
- enemy_undermost_warden (v): the eyes are a flat single-colour band that reads as a blindfold; the blouse and apron read as a smith. Fix: noisy grey-white static in the eye sockets and more obvious mining gear (pit helmet with a dead lamp). The black shoulder erasure patch can stay as the static source.
- enemy_shax_who_drinks_the_mire: central slit and crown finial read as a shrine doorway. Fix: a hunched low head with a hanging jaw draped in pondweed.
- enemy_norgos_the_pit_bear: embedded picks painted in fur brown; root-like leg strands. Fix: dull iron pick heads with rust and broken haft stubs; matted fur.
- enemy_wrathroot: pale driftwood, no thorns, unreadable face, cross-shaped finial and glints. Fix: near-black bark, long pale thorns, a big snarling face, a ragged thorny crown.

**actors_96x128_02**
- enemy_the_pale_drake: no pale fire in the ribs; small skull. Fix: pale cold flame in the ribcage and a larger skull.
- enemy_snaproot: tall pyramid for a low treant. Fix: about two-thirds height, with roots spreading across the full width.
- enemy_varsha_the_writhing: no readable drake head. Fix: head, horns and jaw at the top of the smoke column.
- enemy_horned_horror: speckled body with no mass or outline. Fix: merge into solid masses with a consistent dark outline.
- enemy_rantha_the_frost_drake: no cairn. Fix: a small frosted stone cairn under the coil.

**actors_96x128_03**
- enemy_kratorr_the_glutton: no dragged table; an unreadable caged lump in the hand. Fix: a chain in the fist running back to a laden table edge behind his flank.
- enemy_gigantic_bone_rat: no hanging teeth; Index-purple shadows. Fix: small pale teeth strung from ribs and spine; cold grave palette.
- enemy_the_blotter: the hat reads as a stone. Fix: a bowler or deerstalker with a clear brim, in soot-brown.

**actors_96x128_04**
- enemy_vampire_lord: the hole half of the bat cloak is lost, and shards fray the silhouette. Fix: a third of the bats as flat black bat-shaped holes with a faint violet rim; pull the shards in.
- enemy_weaver_matriarch: egg sac not wrapped in grave cloth. Fix: grey-white grave-cloth strips criss-crossed with thread.
- enemy_war_bear: barding reads as green cloth; same pose as the black and cave bears. Fix: grey-iron mail scraps and a visible broken collar and chain; vary the pose.

**actors_96x128_05**
- enemy_blood_lich (v): antlered-skull motif shared with the Index eidolon (overlap only 0.49, so not a duplicate); hem drips run downward. Fix: a human lich skull, and blood rivulets visibly climbing with a wet sheen.
- enemy_runed_bone_giant: spine runes are right but dim. Fix: separated 3x5 px runes with a hot pale core, like open wounds.
- enemy_furnace_brute: furnace-grille helmet and lava veins read as a fire elemental. Fix: a scarred brutish face and blistered soot-black skin with dull ember burns.
- enemy_cave_brute: ice-blue flares behind the arms read as a cold aura. Fix: remove them; short drips from the hair and fingers instead.

**actors_96x128_06**
- enemy_striped_tiger: the broken collar chain is unreadable; the orange is too saturated. Fix: a visible collar with 3-4 steel links ending in a snapped one; soot-dulled ochre.
- enemy_hedge_wizard_brute: the herb bundle blends into the arm; nothing burns. Fix: a twine-tied dry sage bundle with an orange ember tip.
- enemy_honey_tree: tall and spindly for a squat tree. Fix: a low, thick trunk with the canopy topping out at about two-thirds height.
- enemy_blackwood_treant: olive moss, no thorns, faint face. Fix: near-black bark, sharp thorns, deep eye hollows and a mouth.
- enemy_ritch_hive_mother: two pale bulbs make the head ambiguous; the larvae read as speckle. Fix: one head at bottom-centre and 4-6 outlined grubs.

**actors_96x128_07**
- enemy_umber_hulk: the eyes don't read. Fix: 6-10 distinct pale-amber eyes with dark rims above the mandibles.
- enemy_bloated_horror: the central maw reads as one big eye; the small eyes are closed with no tears. Fix: tiny open wet eyes with tear streaks, and a slack mouth.

**effect_256x64_02**
- ui_fx_bolt_nature, cropped (v): about 3 px of frame 3's tip lands in frame 4. Fix: resolved by R-FLIGHT.
- ui_fx_bolt_blight, cropped: 1 px overrun. Fix: resolved by R-FLIGHT.
- ui_fx_bolt_blight, colour: near-black purple and an acid-lime head. Fix: folded into its section 2c brief.
- ui_fx_bolt_light, cropped: about 2 px overrun. Fix: resolved by R-FLIGHT.

**effect_256x64_03** (the four areas have the same tiling defect that was rated major on sheets 01-02; see style note 2)
- ui_fx_bolt_temporal: 2-3 px of the tip crosses into frame 4; the head shuffles. Fix: pin the core and tip, with the tip ending by x=61.
- ui_fx_bolt_mind: **resolved locally 2026-09-19.** The old dusty rose (hue 300-315) sat in arcane's band and did not match area_mind's lavender; the replacement is pale lavender-violet.
- ui_fx_area_darkness: a centred plume that tiles as fountains; 1-2 px edge cuts; slate highlights. Fix: R-AREA with deep-blue highlights.
- ui_fx_area_arcane: a centred magenta campfire that tiles as a grid. Fix: R-AREA, keeping the magenta.
- ui_fx_area_mind: rings cut at alternating side edges. Fix: R-AREA and R-GRID4.
- ui_fx_area_temporal: a brass shard split across the frame 1/2 line. Fix: R-AREA and R-GRID4.

**effect_256x64_05**
- ui_fx_thrown_flask, scale: a 45-58 px flask as big as a body. Fix: folded into its section 2c brief.
- ui_fx_boulder_roll: 3 debris px cross into frame 4. Fix: pull frame 3's debris back 2 px or more.

**effect_384x64_01** (for the west-arriving streak on every hit, see style note 3)
- ui_fx_hit_lightning: straight spikes, no forks; navy droplets read as ink; frame 1 tip crosses by 1 px. Fix: jagged forking bolts in yellow and brighter violet, fading as sparks.
- ui_fx_hit_physical: an arrowhead streak from the west; a shard straddles frames 5/6. Fix: a non-directional start, with shards inside their cells.
- ui_fx_hit_nature: west streak; leaves clipped at the peak; lime core shared with acid. Fix: a warmer cream and leaf core with a 1-2 px margin.
- ui_fx_hit_fire: west streak; embers straddle frames 4/5. Fix: a non-directional ignition flash.
- ui_fx_hit_cold: west streak; saturated mid-blue. Fix: paler frost blue.

**effect_384x64_02**
- ui_fx_hit_darkness: the peak burst crosses x=192 by 4 px and a speck crosses x=320. Fix: shift the peak about 4 px right and clear the specks.

**effect_384x64_03**
- ui_fx_swing_crush, off-brief (v): an upward jet with no ground dust ring (the palette is dull tan and grey rubble, not gold). Fix: folded into its blocker brief.
- ui_fx_swing_pierce, animation: peak rays spill 3 px into frame 4, and debris into frame 5. Fix: pull them back 4-6 px.
- ui_fx_swing_pierce, colour: saturated royal blue reads as cold or lightning. Fix: a neutral steel palette.
- ui_fx_swing_slash: 3 px of the frame-0 chevron spills over, plus stray pixels at x 320-321. Fix: shift it 4 px left and clear the strays.

**effect_384x64_05**
- ui_fx_level_up, off-brief: no seal; a navy halo smudge. Fix: folded into its blocker brief.
- ui_fx_shield_break, off-brief: pulses instead of breaking. Fix: folded into its blocker brief.
- ui_fx_buff, off-brief: chevrons sag downward. Fix: folded into its blocker brief.

**item_64x64_01**
- item_rod (v): a bone-coloured cap streaked red with a blood-like rag, and no crystal; it still reads as a heavy sceptre. Fix: a faceted, glassy crystal cap in a metal claw; no blood or rag.
- item_clerks_coat (v): the same caped overcoat silhouette as item_leather_duster (the hues do separate at native size). Fix: a charcoal buttoned, fitted frock coat with no cape and flat cloth shading.
- item_lodestone: rough stone with a strap, cross medallion and stabbed pins. Fix: a smooth polished near-black stone with pins clinging to it.
- item_sabre: the guard is the blade's dull tan. Fix: a warm brass guard and pommel over a cool steel blade.
- item_cleaver: a short kitchen cleaver on a long handle. Fix: a long, broad two-handed cleaver blade.
- item_boathook: a thin brown shaft and a low-contrast hook. Fix: a thicker grey iron shaft with a larger hook and barb.
- item_surveyors_staff: a blotchy baton with a wrist loop and no brass. Fix: a slim graduated staff with brass rings and a brass-shod foot.
- item_riot_shield: the rim is the same brown as the planks. Fix: dark iron rim and rivets.

**item_64x64_02**
- item_gem_blue (v): a rust-red crust around the blue stone. Fix: a clean sapphire in item_gem_white's cut.
- item_gem_red: a rough orange-leaning nugget. Fix: a symmetrical ruby cut in the same style.
- item_infusion_vial: all one dull ochre; nothing glows. Fix: glowing saturated liquid with a darker glass layer.
- item_lore_page: no handwriting. Fix: short, uneven, illegible ink lines, with less staining.
- item_plain_ring: a mottled, warped, stone-like band. Fix: a smooth even iron band with a crisp highlight.

**prop_64x64_01**
- prop_grain_sack: 54x60, as tall as an actor. Fix: 30-36 px tall (style note 5).
- prop_anvil: full cell width and chest-high, with green moss. Fix: 40-48 wide by 28-34 tall in dark forged iron.
- prop_shop_counter: the bell is wood brown. Fix: a warm brass call bell with a specular pixel and plunger.
- prop_crate: no stamp. Fix: a faded ink stencil with no readable text.
- prop_gravestone_a: noisy mossy fieldstone; the lean barely shows. Fix: a thin dark slate tilted 10-15 degrees.

**prop_64x64_02**
- prop_bedroll (v): a 60x59 pack taller than the tent and wagon, though consistent with the batch's roughly 60 px scaling. Fix: 36-44 wide and at most 32-36 tall, with the roll beside the pack; decide with the batch scale rule.
- prop_mine_cart: glowing turquoise crystals read as treasure. Fix: dull ore matching prop_ore_pile.
- prop_open_grave: a 1 px spade and stray blue blobs; it reads as a hut doorway. Fix: a rectangular pit, a spoil mound, and a spade with a 2-3 px shaft and a grey blade.
- prop_toadstools: an upright wreath. Fix: a flattened ellipse on the ground with the floor showing through.
- prop_broken_altar: no visible water. Fix: a shallow water band with a waterline and ripples.
- prop_gravestone_b: saturated royal-blue inlay. Fix: carved recesses or tarnished dark metal.

**prop_64x64_03**
- prop_trap_rune_fire: a heavy stone disc ringed by candles. Fix: a thin chalk circle with a faint orange flame glyph matching the acid rune.
- prop_trap_rune_acid: the glow reads cream-khaki (122,115,91); its form is the model for the family. Fix: a faint sickly yellow-green glow.
- prop_trap_pressure_plate: a visible front face and ornate frame, like a box or tome. Fix: a flush plate with a thin recessed seam.

**status_icon_64x64_01** (for framing, see style note 11)
- icon_status_crippled: grey residue blobs. Fix: a clean ground.
- icon_status_wet: grey ovals and a scribble. Fix: a clean ground.
- icon_status_poisoned: grey corner blobs. Fix: remove them.
- icon_status_asleep: a grey blob behind the moon. Fix: remove it.
- icon_status_burning: notched frame, grey ground. Fix: a clean frame in the chosen set style.
- icon_status_cursed: the mark looks like a compass rose; halo pixels. Fix: an irregular ink blot or jagged split, no halo.
- icon_status_invisible: the figure runs edge to edge. Fix: leave a 4-6 px margin.
- icon_status_weakened: the arm is hard to parse. Fix: a clean flexed arm with a clear elbow and fist.
- icon_status_taunted: the ring touches the tile edges. Fix: shrink it slightly.

## The Undermost's mouth on the overworld

**Art delivered locally 2026-09-19.** The intro cave is a place on the moor now — glyph `J`
at (109,62), six tiles off Alderbrook's gate — and every other site on that map
draws its own 32x32 silhouette. The 32x32 hole now replaces the generic
`stair` family marker when the local art tree is deployed.

| Id | Size | What it is |
|---|---|---|
| `tile_ow_landmark_undermost` | 32x32 | A torn hole in a field: cropped turf, a shored-up timber collar half fallen in, and a black shaft going down out of sight. No building, no headgear, nothing industrial — this is not a mine, it is where somebody was put.

It must read at 32x32 against FIELD and must not be mistakable for the Hollow
Mine's or the Underworks' silhouette, which are both worked places.

## The Knot of Elsewhere

**Art delivered locally 2026-09-19.** The Undermost's warden holds it, and it is
the port of upstream's Rod of Recall. The icon now resolves from the manifest;
`PENDING_ICON_IDS` in `src/server/content/items.ts` still carries the old
commission classification and should be reconciled with `KNOWN_ICON_IDS` by the
content owner.

| Id | Size | What it is |
|---|---|---|
| `item_knot_of_elsewhere` | 64x64 | A loop of something that is not string, tied by something that was not hands: a closed knot of dark, faintly iridescent cord whose ends do not meet anywhere you can see, with a thin fringe of the background showing THROUGH the strands where they cross.

Not a rod, not a key, not a scroll — nothing manufactured and nothing
bureaucratic. It must read as a single closed shape at 64x64 and must not be
mistakable for the rope, cord or belt icons.

### And the badge for its wind-up

`icon_status_elsewhere` was a procedural stand-in from `status_badges()` in
`tools/gen_ui_assets.py`. Drawn art replaced the runtime file locally on
2026-09-19. It is wired and loads.

| Id | Size | What it is |
|---|---|---|
| `icon_status_elsewhere` | 24x24 | The twenty turns between pulling the Knot and the room letting go. The same knot as the item, coming APART: the strands slackening, with a gap opening where they crossed.

It must be told apart at a glance from `icon_status_spellshocked` (a broken
ring), `icon_status_confused` (a ring with marks inside it) and
`icon_status_out_of_phase`, which are the three nearest silhouettes in the badge
set. It is a BENEFICIAL status — the party panel draws it without the harm tint,
so the shape has to carry "something is about to happen to you" on its own.

## The Unwritten — the Redactor's fourth tree

**Drawn art delivered locally 2026-09-19.** All four ids below had shipped as
procedural stand-ins in the gitignored asset tree. Their runtime files are now
replaced. This section preserves the acceptance brief and the reason stand-ins
need explicit review even when `art:needs --missing` is empty.

Register: `ledger/unwritten` is void-eldritch, not clerical. No pages, no
stamps, no ink bottles, no clerks — the resource happens to be called Ink and
that is the only clerical word allowed anywhere near these four.

| Id | Size | What it is |
|---|---|---|
| `enemy_bound_shadow_s` | 48x64 native | A piece of the dark that has agreed, for now, to stand where it is put. Roughly upright and roughly person-sized, with NO edges you could point to: the silhouette should dissolve at its boundary rather than end. No face, no limbs you could count, no cloth. It must read as a body occupying a tile and must not be mistakable for `enemy_index_wraith`, which is the nearest silhouette in the bestiary and is a THING THAT WANTS SOMETHING; this one wants nothing and is simply in the way. |
| `icon_sustain_call_shadows` | 64x64 native, 24px read | The stance that puts a body between you and what is coming. Two shapes, one in front of the other, the front one darker and less resolved than the back. Not a summoning circle, not hands, not a sigil. |
| `icon_sustain_gesture_of_pain` | 64x64 native, 24px read | The stance where the attack stops being physical. A hand held open — the only anatomical shape in this set, and deliberately so, because the whole talent is "both hands empty" — with the strike leaving it as a distortion rather than a line. It must be told apart at a glance from `icon_sustain_call_shadows`, which sits next to it on the same tree and the same bar. |
| `icon_passive_shadow_warriors` | 64x64 native, 24px read | Hate lent to something that has none. The same two-shape motif as Call Shadows with the FRONT shape sharpened rather than softened — the passive's whole effect is that the thing you put in front hits harder. It must read as a passive: the passive icons in this set carry no frame, where the two sustains above do. |

All three 24x24 icons must survive the bar's own contrast at `HOTBAR` scale and
must not be mistakable for the three `ledger/testimony` stance icons, which are
the nearest neighbours a Redactor actually looks at.

## The Infinity Tower's mouth on the overworld

**Not drawn.** The Tower is a cell on the moor now — glyph `Y` at (57,4), in the
northern snowfield, 101 steps from Alderbrook's gate and 27 tiles from the
nearest other marker, which is the furthest walkable ground on the map from
anything already drawn on it. Every other site there draws its own 32x32
silhouette; `landmarkIdFor` (`src/shared/redaction.ts`) names this one so that
the missing id resolves to nothing and the client draws the generic `stair`
family marker, which is the right fallback. With NO row at all it would fall
through to `tile_ow_landmark_redaction` — the gate onto the dark territory —
which is the one wrong picture that would be read as a second door to somewhere
real.

| Id | Size | What it is |
|---|---|---|
| `tile_ow_landmark_infinity_tower` | 32x32 | A tower driven DOWNWARD into the snow: what is above the ground is the last few courses of something much longer, canted, with the drifts up one side and a mouth at the top going straight down out of sight. It must read as a way DOWN, because that is what it is — you enter at the top and descend for ever. No door, no windows, no roof, nothing lived in. |

It must read at 32x32 against SNOWFIELD, must not be mistakable for
`tile_ow_landmark_undermost` (a torn hole in a field, which is also a way down
but is somewhere a person was put), and must not read as a building — the
Watcher's Altar and the Glass Archive are the nearest silhouettes that do, and
both are places with a last room.
