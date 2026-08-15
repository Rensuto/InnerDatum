# Third-Party Assets and Licences

> ## No assets are distributed with this repository
>
> **The only third-party material you actually receive by cloning this repo is its npm dependencies —
> [§ 4](#4-software-dependencies).** No image, font, sound or music file is tracked here at all; the
> art tree is excluded wholesale (see [ASSETS-LICENSE.md](ASSETS-LICENSE.md)).
>
> Sections 1–3 are therefore **provenance records, not a manifest of shipped files.** They document
> material the author holds locally and that the art pipeline has drawn on, so that the licensing is
> traceable if any of it is ever distributed. Read them as "what would need to be honoured", not as
> "what is in your checkout".
>
> If you add any of this material to a fork, its obligations become yours, and they are recorded here
> so you do not have to reconstruct them from memory.

- T-Engine4 / ToME attribution → [NOTICE](NOTICE)
- The author's own art → [ASSETS-LICENSE.md](ASSETS-LICENSE.md)
- npm dependency licences → [§ 4](#4-software-dependencies)

---

## 1. Fonts — SIL Open Font License 1.1

**Not used and not shipped.** No font file exists in this repository, no stylesheet declares an
`@font-face`, and the client renders with system fonts. This section is retained because the four
families below were selected for the design and would return with a fork that restores it.

Four families, ten `.ttf` files, from the [google/fonts](https://github.com/google/fonts) `ofl/` tree.

| Family | Copyright line, verbatim from the shipped OFL file | Files | Role |
|---|---|---|---|
| Alegreya Sans | `Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans)` | `AlegreyaSans-{Regular,Medium,Bold,Italic}.ttf` | Body text |
| Alegreya Sans SC | `Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans)` | `AlegreyaSansSC-{Regular,Medium,Bold}.ttf` | Captions, labels, keycaps |
| Cinzel | `Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel)` | `Cinzel-Variable.ttf` | Display, titles |
| IM Fell English | `Copyright (c) 2010, Igino Marini (mail@iginomarini.com)` | `IMFellEnglish-{Regular,Italic}.ttf` | Lore and flavour text |

Designers, for acknowledgement: Alegreya Sans and Alegreya Sans SC by Juan Pablo del Peral / Huerta
Tipográfica; Cinzel by Natanael Gama; IM Fell English by Igino Marini, digitising John Fell's
17th-century types.

Below their copyright headers, all four licence files are byte-identical to the standard OFL 1.1 of
26 February 2007. **If fonts are ever added, the licence text must ship beside them** — as
`OFL_AlegreyaSans.txt`, `OFL_AlegreyaSansSC.txt`, `OFL_Cinzel.txt` and `OFL_IMFellEnglish.txt` — in
the same build step that writes the font files, never as a follow-up commit.

### Reserved Font Names

**None of the four declares one.** OFL 1.1 defines a Reserved Font Name as a name "specified as such
after the copyright statement(s)". In all four files the phrase occurs exactly once — inside that
definition, at line 33 — and never after a copyright line. OFL § 3's renaming requirement therefore
does not apply, and a Modified Version may keep the family name.

OFL § 4 applies regardless: the names of the Copyright Holders or Authors must not be used to promote,
endorse or advertise a Modified Version, except to acknowledge their contribution.

### Subsetting and WOFF2 conversion

**Permitted.** A subsetted or format-converted font is a "Modified Version", and OFL § 1 grants the
right to "use, study, copy, merge, embed, modify, redistribute" the Font Software. Four conditions
attach, and **"unrestricted" is the wrong word**:

1. **§ 2 — the notice travels with it.** Every copy, original or modified, must contain the copyright
   notice and this licence, as a stand-alone text file, a human-readable header, or a user-viewable
   machine-readable metadata field. Keeping `OFL_*.txt` beside the generated `.woff2` satisfies this.
2. **§ 5 — it stays OFL.** The converted file must be distributed *entirely* under OFL 1.1 and under
   no other licence. It is not swept into the GPL by living in this repository, and it is not covered
   by [ASSETS-LICENSE.md](ASSETS-LICENSE.md).
3. **§ 2 — never sold by itself.** Bundling and selling with software is expressly allowed; selling
   the font alone is not.
4. **Termination.** The licence "becomes null and void if any of the above conditions are not met."
   The practical risk is an asset pipeline that emits `.woff2` into a build directory and drops the
   `OFL_*.txt`. **Copy the licence files in the same build step that writes the fonts**, and assert
   their presence in CI.

---

## 2. Kenney asset packs — CC0 1.0 Universal

**Not shipped.** No Kenney-derived file is tracked in this repository. Recorded because these packs
informed the art the author holds locally, and because CC0 obligations are worth having written down
before rather than after somebody adds one to a fork.

Graphics and sound from [kenney.nl](https://kenney.nl). Each pack's `License.txt` was read directly.

| Pack | Version / date | Used for |
|---|---|---|
| Roguelike RPG Pack | — | Gap-filler props and fantasy tiles |
| Roguelike Modern City | 2.0, 29-10-2022 | Street and building tiles |
| Roguelike Indoors | — | Interior tiles and furniture |
| Roguelike Caves & Dungeons | — | Underworks tiles |
| Tiny Town | 1.1, 11-01-2023 | 16×16 map markers, UI icons |
| Tiny Dungeon | 1.0, 05-07-2022 | 16×16 dungeon icons |
| Particle Pack | — | `fx/` particle sprites |
| Impact Sounds | 1.0, 19-12-2019 | Combat SFX |
| Interface Sounds | 1.0, 11-02-2020 | UI SFX |
| Sci-Fi Sounds | 1.0, 11-10-2020 | Ability SFX |

Two representative `License.txt` wordings, verbatim:

> License (Creative Commons Zero, CC0)
> http://creativecommons.org/publicdomain/zero/1.0/
> You may use these graphics in personal and commercial projects.
> Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

> License: (Creative Commons Zero, CC0)
> This content is free to use in personal, educational and commercial projects.
> Support us by crediting Kenney or www.kenney.nl (this is not mandatory)

Authors as credited by the packs: **Kenney Vleugels** for Kenney (www.kenney.nl). The Roguelike RPG
Pack additionally credits **Lynn Evers**.

> **One pack is not in the local `_asset_packs/` directory.** The Kenney **Particle Pack** supplies
> the four `fx/` particle sprites per the art source's `CREDITS.md`, but its `License.txt` was never
> saved locally. **Re-download it if those sprites ship**, so the CC0 claim rests on a file you hold
> rather than on recollection.

### Obligations: none

CC0 1.0 is a public-domain dedication. The rights holder waives copyright and neighbouring rights
worldwide to the fullest extent permitted, and attribution is expressly not required — the packs say
so themselves.

### What is polite, and what this project does

- **Credit Kenney by name** here and in the in-game About panel. It costs one line and the packs saved
  real work.
- **Keep the original `License.txt`** alongside any Kenney-derived file under `client/public/assets/`,
  as `KENNEY-CC0-LICENSE.txt`, so a copied folder carries its own provenance.
- **Record source pack and original filename** for every derived file (below), so the CC0 claim is
  auditable rather than merely asserted.
- **Do not imply endorsement.** CC0 waives copyright; CC0 § 4(a) expressly does not licence trademark
  or patent rights, so "Kenney" may be used to attribute, never to suggest affiliation.
- Consider https://support.kenney.nl.

### Kenney-derived files, with provenance

| Repository path | Source pack | Original filename |
|---|---|---|
| `assets/audio/sfx/weapon_revolver_shot.ogg` | Impact Sounds | `impactPlate_heavy_000.ogg` |
| `assets/audio/sfx/enemy_die.ogg` | Impact Sounds | `impactPunch_heavy_001.ogg` |
| `assets/audio/sfx/player_hurt.ogg` | Impact Sounds | `impactSoft_heavy_000.ogg` |
| `assets/audio/sfx/ability_sigil.ogg` | Impact Sounds | `impactBell_heavy_002.ogg` |
| `assets/audio/sfx/pickup_xp.ogg` | Interface Sounds | `glass_001.ogg` |
| `assets/audio/sfx/ability_hex.ogg` | Interface Sounds | `glass_002.ogg` |
| `assets/audio/sfx/ui_confirm.ogg` | Interface Sounds | `confirmation_001.ogg` |
| `assets/audio/sfx/ability_ward.ogg` | Interface Sounds | `confirmation_002.ogg` |
| `assets/audio/sfx/ability_bind.ogg` | Interface Sounds | `glitch_001.ogg` |
| `assets/audio/sfx/sanity_band_pulse.ogg` | Sci-Fi Sounds | `forceField_000.ogg` |
| `assets/audio/sfx/ability_bulwark.ogg` | Sci-Fi Sounds | `forceField_002.ogg` |
| `assets/audio/sfx/ability_salt_ring.ogg` | Sci-Fi Sounds | `explosionCrunch_002.ogg` |
| `assets/audio/sfx/ability_verdict.ogg` | Sci-Fi Sounds | `lowFrequency_explosion_000.ogg` |
| `assets/audio/sfx/ability_spark_cascade.ogg` | Sci-Fi Sounds | `laserRetro_001.ogg` |
| `assets/fx/muzzle_flash.png` | Particle Pack | `muzzle_01.png` |
| `assets/fx/ability_circle.png` | Particle Pack | `circle_01.png` |
| `assets/fx/ability_rune.png` | Particle Pack | `magic_03.png` |
| `assets/fx/ability_glow.png` | Particle Pack | `light_01.png` |
| `assets/tiles/kenney_modern_city/atlas.png` | Roguelike Modern City | `Tilemap/tilemap_packed.png` |

Audio is cut from v1; the SFX rows apply when it lands. Twelve further SFX in the Outer Index source
rest on a blanket "these are Kenney CC0" README claim without a traced original — those are **not**
shipped until traced.

---

## 3. Not shipped, deliberately

| Excluded | Reason |
|---|---|
| ToME art and audio (`data/gfx/**`) | `COPYING-MEDIA`: "granted to use with the Tales of Maj'Eyal game only" |
| 36 Outer Index music tracks | No licence file and no provenance note in the source project |
| 12 untraced SFX | Blanket CC0 claim without a named original |
| `randomassets/**` | Legacy isometric art, unusable and unaudited |
| `ui/splash/*.png` | 3840×2160 / 2160×3840 posters, unshippable in an iframe |

---

## 4. Software dependencies

Runtime and build dependencies are listed in `package.json`. All must be GPL-compatible: MIT,
Apache-2.0, BSD-2/3-Clause and ISC are fine. **No CDDL, EPL, SSPL, BUSL, or proprietary SDK may be
linked into the same binary.** Run this in CI:

```bash
npx license-checker --summary --failOn 'CDDL;EPL-1.0;EPL-2.0;SSPL-1.0;BUSL-1.1'
```

The Discord Embedded App SDK (`@discord/embedded-app-sdk`) is MIT. Discord's platform itself is used
over the network and is not conveyed, so it is not part of the Corresponding Source.
