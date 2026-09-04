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
