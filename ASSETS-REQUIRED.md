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

