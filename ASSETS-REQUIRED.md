# Assets this game expects

The artwork is **not distributed with this repository** — see
[ASSETS-LICENSE.md](ASSETS-LICENSE.md). Nothing is broken; a clone is simply expected to bring
its own art.

Of the 111 sprites the game addresses, **64 are generated procedurally** and need no
source art at all. The remaining **47** are yours to draw.

## Start here

```
python -m pip install pillow
npm run assets
```

That writes 64 PNGs — the panels, pips, cursors, markers, status and turn icons, props and
placeholder branding — plus `manifest.placeholders.json`, which is the only table the client
reads. The game is then playable.

The sprites you have not supplied draw as violet fallback boxes rather than vanishing, so what is
missing is visible on screen instead of appearing as an invisible monster. Running with no art at
all is also supported: the client logs one line and boots into all-placeholder rendering.

## Conventions

| | |
|---|---|
| Human-scale actors | 24x32, single south-facing frame |
| Large creatures | 48x64 |
| Downed/prone variants | 32x24 — wider than tall |
| Item and ability icons | 64x64 |
| Cover art | 1024x1024 |

Straight (non-premultiplied) alpha, RGBA8, hard 1px edges — the client upscales by integer
factors, so a soft edge turns to mush. World entities anchor bottom-centre and may overflow
upward out of their tile. There is no animation system: one frame, facing south.

Drop your files at these paths under `client/public/assets/`, re-run `npm run assets` to pick them
up in the manifest, and they render. Ids are addressed only through that manifest, so a complete
replacement set using the same paths drops in without touching `src/`.

## The 47 you must supply

### `branding/` — 6 files, 1024x1024, 680x240

```
innerdatum_activity_banner_680x240.png         680x240
innerdatum_activity_banner_680x240_v2.png      680x240
innerdatum_discord_bot_avatar_1024.png         1024x1024
innerdatum_discord_bot_icon_1024.png           1024x1024
innerdatum_game_app_icon_1024.png              1024x1024
innerdatum_game_app_icon_1024_v2.png           1024x1024
```

### `characters/` — 10 files, 24x32, 32x24

```
chr_npc_bent_watchman_s.png                    24x32
chr_player_alchemist_downed_s.png              32x24
chr_player_alchemist_s.png                     24x32
chr_player_cipher_clerk_s.png                  24x32
chr_player_enforcer_s.png                      24x32
chr_player_inspector_downed_s.png              32x24
chr_player_inspector_s.png                     24x32
chr_player_voidling_s.png                      24x32
chr_player_watchman_downed_s.png               32x24
chr_player_watchman_s.png                      24x32
```

### `enemies/` — 8 files, 24x32, 48x64

```
enemy_disgraced_inspector_s.png                24x32
enemy_high_inquisitor_s.png                    24x32
enemy_index_cairn_s.png                        24x32
enemy_index_eidolon_s.png                      48x64
enemy_index_glut_s.png                         24x32
enemy_index_husk_elite_s.png                   24x32
enemy_index_husk_s.png                         48x64
enemy_index_wraith_s.png                       24x32
```

### `items/` — 23 files, 64x64

```
item_inquisitors_breeches.png                  64x64
item_inquisitors_cipher.png                    64x64
item_inquisitors_cowl.png                      64x64
item_inquisitors_mantle.png                    64x64
item_inquisitors_seal.png                      64x64
item_inquisitors_tome.png                      64x64
item_inquisitors_treads.png                    64x64
item_inspectors_deerstalker.png                64x64
item_inspectors_dossier.png                    64x64
item_inspectors_locket.png                     64x64
item_inspectors_longcoat.png                   64x64
item_inspectors_oxfords.png                    64x64
item_inspectors_signet.png                     64x64
item_inspectors_slacks.png                     64x64
item_iron_ingot.png                            64x64
item_leather_chest.png                         64x64
item_watchmans_badge.png                       64x64
item_watchmans_boots.png                       64x64
item_watchmans_brass_ring.png                  64x64
item_watchmans_buckler.png                     64x64
item_watchmans_cap.png                         64x64
item_watchmans_coat.png                        64x64
item_watchmans_trousers.png                    64x64
```

## Regenerating from your own source tree

`tools/derive_assets.py` crops and composites finished tokens out of a separate source-art tree
(filmstrips and a paper-doll layer kit). It is specific to this author's art and is not required:
point `ART_SOURCE_DIR` at such a tree and run `npm run assets:all`, or ignore it entirely and draw
the files above by hand.

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

## Three status icons that are drawn and wired to nothing

`icon_status_hasted`, `icon_status_off_guard` and `icon_status_shielded` are on
disk and referenced by no source file. None of the three is a missing wiring
job, so do not treat them as one, and do not redraw them.

- **`off_guard`** is an ORPHANED NAME, not a missing effect. The mechanic ships
  as **Off-balance** (`content/effects.ts`, ported from `physical.lua:1858`,
  the cross-tier physical effect) and has its own `icon_status_off_balance`.
  The design docs called it "Off-guard" and the icon was drawn to that name;
  the code follows upstream instead, which is the name a player reads on the
  badge. Delete it, or keep it as a spare — there is nothing to wire.

- **`hasted`** is architecturally refused for a PLAYER and has no monster
  content. A player's `globalSpeed` is the literal type `1` and readonly, and
  `content/effects.ts` argues at length why: it is what keeps the party
  phase-locked so the barrier parks once per turn at full quorum. Slowing a
  player costs a movement point instead of clock speed (DECISIONS.md § D1), and
  hasting one would break the same invariant from the other side. Monsters DO
  carry a variable `globalSpeed`, so a hasted MONSTER is possible — it is
  content nobody has authored, not a system that is missing.

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

## `icon_monster_bear_down` — one talent icon, the only thing outstanding

`npm run art:needs` reports exactly one missing id and this is it. The talent
shipped in the same commit; the icon did not, so the report is the record.

**What it is:** the Index Husk Elite's stun, ported from `npcs.lua:191-217`
(the ghoul's `T_STUN`). A bruiser bearing its weight down on something.

**Cut it at 64x64**, matching its six siblings — `icon_monster_breaching_blow`,
`_clear_the_altar`, `_efface`, `_grasping_hold`, `_rush`, `_uncorroborated`,
all 64x64 and all derived.

**It is the lowest-priority icon in the game, and that is worth writing down so
nobody hurries it.** A monster talent has `classId: null` and appears in no
loadout and no tree, so this icon reaches no player screen today — the talent
panel and the hotbar draw what a PLAYER can learn. It exists because every
talent module declares an `iconId` and the manifest convention is that a
declared id has a file.

**Acceptance test:** `npm run art:needs` reports `missing art: 0`.

---

## `icon_status_infusion_saturation` — the second outstanding icon

`npm run art:needs` now reports two missing ids. This is the new one, and
unlike `icon_monster_bear_down` above it DOES reach a player screen.

**What it is:** Infusion Saturation, ported from `other.lua:97-111`
(`EFF_INFUSION_COOLDOWN`, "the more you use infusions, the longer they will take
to recharge"). A detrimental status that stacks: each infusion you drink adds
one to it, and every infusion's next cooldown is that much longer.

**What it should look like:** upstream's own is `effects/infusion_cooldown.png`,
which we may not copy — `COPYING-MEDIA` forbids redistributing t-engine4 art and
`reference/` is read-only. Draw it fresh. Something at the wrong end of a
draught: a tipped vial, a dry syringe, a stain spreading. It reads on a body
that has been leaning on its buttons.

**Cut it at 64x64**, matching the eighteen `icon_status_*` files already on
disk.

**It is drawn where the other statuses are** — the badge strip on the party
pane and the hostile card — so until the file exists the player sees the
two-letter fallback `Sa`, which is legible and says nothing. That is worse here
than for a monster talent icon, because this status is one a player is meant to
PLAN AROUND: the whole mechanic is that you can see the tax rising and choose
whether to pay it again.

**Acceptance test:** `npm run art:needs` reports `missing art: 0`.

## `icon_ui_cog` — the case log's settings button, and it is a nicety

**Not outstanding in the sense the two above are.** The button is DRAWN — a hub,
a bore and six teeth, at thirteen pixels — so it is visible, pressable and
correct on a bare clone with no art at all. `npm run art:needs` does not demand
it, because no source line names it.

**Why it is written down anyway:** the drawn version is a gear the way a wire
frame is a chair. It sits in the case log's header beside a painted 9-slice
panel and a painted header strip, and it is the only element in that strip that
is obviously not of the same hand.

**What it should look like:** a small mechanical gear in the interface's brass
and slate, reading at 13x13 in the header and still legible at 26x26 on a
doubled UI scale. It is a CONTROL, not decoration — it needs a silhouette that
survives being tinted gold when the menu under it is open.

**Cut it at 64x64**, matching every other `icon_ui_*` on disk; the header scales
it down.

**Until it exists nothing is lost**, which is why this is at the bottom of the
file rather than the top. `drawLogCog` in `src/client/ui/caselog.ts` is the
fallback, and it is the same bargain `drawLogGrip` above it makes: a widget that
needs art to be USABLE cannot ship behind a missing file.

## The first three weapons — `item_service_baton`, `item_bailiffs_hook`, `item_writ_of_seizure`

**The game had no weapon slot at all until now**, and the reason recorded in the
code was art: *"no `icon_weapon_*` file exists, and an unresolved key renders as
the LOUD violet missing-asset box on a bare clone."*

**That reason had rotted.** `src/client/ui/inventory.ts:2754-2763` draws the
item's INITIAL when a sprite is missing, and its own note calls a bare clone
*"the ORDINARY state rather than an edge case"* — the same fallback the hotbar
and the doll cell make. So these three ship now and read as `S`, `B` and `W` in
a bag until the art lands. Nothing is violet and nothing is invisible.

They are listed in `PENDING_ICON_IDS` (src/server/content/items.ts), which is
the commission register: an id must be in that list or in `KNOWN_ICON_IDS`, so a
typo is still a throw at boot rather than a letter nobody notices.

**What they are.** Constabulary tools, not fantasy swords — the game's weapons
should look like something a case officer would actually carry:

| id | tier | what it is |
|---|---|---|
| `item_service_baton` | common | A turned hardwood baton, brass ferrule, leather wrist loop. Municipal issue, well used. |
| `item_bailiffs_hook` | uncommon | A short hooked bar for forcing a door or a collar — utilitarian, blackened steel, a worn grip. |
| `item_writ_of_seizure` | rare | A rolled warrant bound in wax and wire, carried like a weapon because here it is one. Paper and seals, faintly luminous. |

**Cut them at 64x64**, matching the twenty-three `item_*` files already on disk.

**Acceptance:** each id resolves in the manifest, and moving it from
`PENDING_ICON_IDS` to `KNOWN_ICON_IDS` keeps `npm run check` green — there is a
test asserting the two lists are disjoint, so the move is the signal that the art
arrived.

## The second slot batch — neck, cloak, belt, hands

Four more of ToME's fifteen worn inventories (`load.lua:124, :127, :129, :130`),
each with one item so the slot has something to find. Same arrangement as the
weapons above: the ids are in `PENDING_ICON_IDS` and read as a letter until the
art lands.

| id | slot | tier | what it is |
|---|---|---|---|
| `item_witness_locket` | neck | common | A hinged tin locket on a cord, a stranger's photograph inside. Worn by someone who took a statement they could not forget. |
| `item_archivists_mantle` | cloak | uncommon | A heavy dust-cape, ink-stained at the cuffs, shoulders worn pale from a strap. |
| `item_evidence_belt` | belt | common | A wide leather belt hung with numbered brass tags and empty loops. |
| `item_handlers_gloves` | hands | uncommon | Close-fitting gloves, palms reinforced, one fingertip cut away for a pen. |

**Cut them at 64x64**, matching every other `item_*` file.

**Why four at once:** the paper doll's capacity is `COLS * DOLL_ROWS` minus the
four cells the portrait occupies — eight at three rows, twelve at four. A fourth
row buys exactly four slots, so adding them one at a time would leave the grid
ragged for two commits.

**The doll now sheds its tail row at the 480 floor** and says so in a line of
grey text. That is the designed drop policy and there is a test that a shed row
is always accompanied by that note — a slot may be held back, never silently
lost.
