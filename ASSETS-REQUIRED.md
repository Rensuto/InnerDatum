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


## `icon_ui_cog` — the case log's settings button, and it is a nicety

**Still open, but not outstanding in the sense a missing file is.** The button is DRAWN — a hub,
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

**Until it exists nothing is lost**, which is why it is the last open item in
this file rather than the first. `drawLogCog` in `src/client/ui/caselog.ts` is the
fallback, and it is the same bargain `drawLogGrip` above it makes: a widget that
needs art to be USABLE cannot ship behind a missing file.
