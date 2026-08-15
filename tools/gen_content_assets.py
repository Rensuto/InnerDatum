#!/usr/bin/env python3
"""
gen_content_assets.py — item icons, eldritch props, and the two missing humans.

Pass 3 of the placeholder pipeline. Everything here is a STAND-IN designed to be
overwritten; the point is that no milestone is blocked waiting on art.

  * items  — 23 of the 27 `item_*` sprite_ids declared in content/items/*.json
             have no PNG anywhere. The other 4 already have exact 64x64 weapon
             icons and are ALIASED, not redrawn.
  * props  — assets/sprites/props/eldritch/ contains exactly one file, so the
             Watcher's Altar boss room would be an empty room with one object.
  * humans — enemy_disgraced_inspector / enemy_high_inquisitor. Composited from
             the paper-doll kit rather than drawn, which is what the spec
             recommends and gives a genuinely different silhouette for free.

Usage:  python tools/gen_content_assets.py
"""

from __future__ import annotations

import json
from os import environ
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "client" / "public" / "assets"
# ART_SOURCE_DIR points at the outer-index-engine directory of the read-only
# Outer Index tree — the one containing `assets/` and `content/`.
#
# NOT hardcoded. This repository is public, and an absolute path here would
# publish a Windows username while being wrong on every machine but one.
#
# The art itself is NOT distributed with this repo (see ASSETS-LICENSE.md), so a
# clone without it derives nothing and says so rather than failing obscurely.
ART_ROOT = Path(environ.get("ART_SOURCE_DIR", ""))
SRC = ART_ROOT

# Decide "do we have the source art?" ONCE, here, rather than letting each stage
# infer it from a path test.
#
# An unset ART_SOURCE_DIR makes Path(""), and `Path("") / "content" / "items"`
# is not an error — it is the RELATIVE path `content/items`, resolved against
# whatever directory you happen to run this from. This repo HAS a `content/`
# directory, so the source-dependent stages below would silently read the wrong
# tree and then report success. That is worse than failing.
HAVE_SRC = bool(environ.get("ART_SOURCE_DIR", "").strip()) and SRC.is_dir()

NO_SRC_NOTE = (
    "ART_SOURCE_DIR is unset or missing — skipping the stages that need the "
    "source art. The procedural stages still run. See ASSETS-LICENSE.md."
)

INK       = (10, 8, 19, 255)
VOID      = (33, 8, 46, 255)
PANEL     = (49, 41, 56, 255)
SLATE     = (54, 48, 62, 255)
GREY      = (92, 93, 99, 255)
GREY_HI   = (153, 153, 159, 255)
SILVER    = (164, 164, 171, 255)
VIOLET    = (99, 64, 158, 255)
VIOLET_HI = (166, 112, 224, 255)
ORANGE    = (255, 132, 39, 255)
GOLD      = (255, 228, 121, 255)
PARCHMENT = (237, 230, 194, 255)
BONE      = (197, 194, 180, 255)
CRIMSON   = (150, 30, 44, 255)
CLEAR     = (0, 0, 0, 0)

MADE: list[str] = []


def img(w, h):
    im = Image.new("RGBA", (w, h), CLEAR)
    return im, ImageDraw.Draw(im)


def save(im, rel):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    im.save(p, "PNG", optimize=True)
    MADE.append(rel)


# --------------------------------------------------------------------------
# Items — 64x64, mandatory: the icon atlas is a 10-column grid computed as
# px = (i % 10) * 64, with no rect table. Any other size breaks it.
# --------------------------------------------------------------------------

# Each equipment set gets a palette so a glance at the inventory says whose kit
# it is; each SLOT gets a distinct silhouette so it reads without the label.
SETS = {
    "watchmans":   (GREY_HI, SILVER, (74, 96, 128, 255)),   # steel + police blue
    "inspectors":  ((139, 106, 74, 255), (186, 148, 106, 255), (96, 70, 46, 255)),
    "inquisitors": (VIOLET, VIOLET_HI, GOLD),
    "leather":     ((120, 82, 54, 255), (158, 112, 74, 255), (84, 58, 38, 255)),
    "iron":        (GREY, GREY_HI, SLATE),
}


def set_of(sprite_id: str):
    for k in SETS:
        if sprite_id.startswith(f"item_{k}"):
            return SETS[k]
    return SETS["iron"]


def slot_shape(d, slot, base, hi, dark):
    """One silhouette per slot, drawn in the 64x64 field with a 1 px outline."""
    if slot == "head":
        d.polygon([(16, 34), (16, 24), (22, 17), (42, 17), (48, 24), (48, 34)],
                  fill=base, outline=INK)
        d.rectangle([12, 34, 52, 40], fill=dark, outline=INK)
        d.line([(20, 22), (44, 22)], fill=hi)
    elif slot == "chest":
        d.polygon([(18, 16), (46, 16), (52, 24), (48, 50), (16, 50), (12, 24)],
                  fill=base, outline=INK)
        d.line([(32, 18), (32, 48)], fill=dark)
        d.polygon([(24, 16), (32, 26), (40, 16)], fill=dark, outline=INK)
        d.line([(16, 26), (16, 46)], fill=hi)
    elif slot == "legs":
        d.polygon([(20, 14), (44, 14), (44, 50), (35, 50), (33, 30),
                   (31, 50), (20, 50)], fill=base, outline=INK)
        d.line([(22, 18), (42, 18)], fill=dark)
        d.line([(22, 20), (22, 46)], fill=hi)
    elif slot == "boots":
        for ox in (0, 18):
            d.polygon([(14 + ox, 20), (24 + ox, 20), (24 + ox, 40),
                       (30 + ox, 40), (30 + ox, 47), (14 + ox, 47)],
                      fill=base, outline=INK)
            d.line([(15 + ox, 44), (29 + ox, 44)], fill=dark)
    elif slot == "amulet":
        d.arc([18, 10, 46, 40], 200, 340, fill=hi)
        d.arc([19, 11, 45, 41], 200, 340, fill=base)
        d.polygon([(32, 34), (40, 44), (32, 54), (24, 44)], fill=base, outline=INK)
        d.polygon([(32, 39), (36, 44), (32, 49), (28, 44)], fill=dark)
    elif slot == "ring":
        d.ellipse([20, 22, 44, 46], outline=base)
        d.ellipse([21, 23, 43, 45], outline=base)
        d.ellipse([23, 25, 41, 43], outline=dark)
        d.polygon([(32, 10), (39, 20), (32, 27), (25, 20)], fill=hi, outline=INK)
    elif slot == "off_hand":
        d.polygon([(32, 12), (52, 20), (48, 44), (32, 54), (16, 44), (12, 20)],
                  fill=base, outline=INK)
        d.ellipse([26, 26, 38, 38], fill=dark, outline=hi)
        d.line([(32, 16), (32, 24)], fill=hi)
    else:  # material
        d.polygon([(14, 34), (24, 26), (50, 26), (50, 40), (40, 48), (14, 48)],
                  fill=base, outline=INK)
        d.polygon([(14, 34), (40, 34), (50, 26)], fill=hi, outline=INK)
        d.line([(40, 34), (40, 48)], fill=dark)


def items():
    if not HAVE_SRC:
        print(f"  SKIP items: {NO_SRC_NOTE}")
        return
    idx = SRC / "content" / "items"
    if not idx.exists():
        print(f"  SKIP items: {idx} not found")
        return

    # These four already have exact 64x64 art. Alias, never redraw.
    ALIASED = {
        "item_iron_sword": "icon_weapon_iron_sword",
        "item_inspectors_revolver": "icon_weapon_inspectors_revolver",
        "item_inquisitors_reckoner": "icon_weapon_inquisitors_reckoner",
        "item_watchmans_truncheon": "icon_weapon_watchmans_truncheon",
    }
    aliases: dict[str, str] = {}

    for f in sorted(idx.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        sid = data.get("sprite_id") or data.get("spriteId")
        slot = data.get("slot") or data.get("equip_slot") or "material"
        if not sid:
            continue
        if sid in ALIASED:
            aliases[sid] = ALIASED[sid]
            continue

        base, hi, dark = set_of(sid)
        im, d = img(64, 64)
        # A neutral plate so the icon reads on any panel; the rarity frame is a
        # separate 72x72 asset that sits around this.
        d.rectangle([0, 0, 63, 63], fill=(28, 24, 34, 255))
        d.rectangle([0, 0, 63, 63], outline=INK)
        slot_shape(d, slot, base, hi, dark)
        save(im, f"items/{sid}.png")

    (OUT / "items").mkdir(parents=True, exist_ok=True)
    (OUT / "items" / "_aliases.json").write_text(
        json.dumps(
            {
                "_comment": (
                    "sprite_id -> existing icon id. These four items already "
                    "have exact 64x64 art in the source UI icon set; the build "
                    "should resolve them rather than emit MISSING_SPRITE."
                ),
                "aliases": aliases,
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    MADE.append("items/_aliases.json")


# --------------------------------------------------------------------------
# Eldritch props — the Watcher's Altar dressing.
# Each needs a sibling.meta.json in the source's own schema, so the level
# author gets blocks_movement / blocks_los / cover_level for free.
# --------------------------------------------------------------------------

PROPS = {
    "candle_row":    (32, 48, "standing"),
    "chalk_sigil":   (32, 32, "floor"),
    "bone_pile":     (32, 32, "standing"),
    "page_drift":    (32, 32, "floor"),
    "brazier_ritual": (32, 48, "standing"),
    "offering_bowl": (32, 32, "floor"),
}


def props():
    for name, (w, h, kind) in PROPS.items():
        im, d = img(w, h)
        if name == "candle_row":
            for i, x in enumerate((6, 15, 24)):
                top = 20 + (i % 2) * 4
                d.rectangle([x, top, x + 4, 43], fill=BONE, outline=INK)
                d.line([(x + 2, top - 4), (x + 2, top - 1)], fill=ORANGE)
                d.point((x + 2, top - 5), GOLD)
        elif name == "chalk_sigil":
            d.ellipse([3, 3, 28, 28], outline=BONE)
            d.ellipse([8, 8, 23, 23], outline=(197, 194, 180, 150))
            for a, b in (((16, 3), (16, 28)), ((3, 16), (28, 16)),
                         ((7, 7), (24, 24)), ((24, 7), (7, 24))):
                d.line([a, b], fill=(197, 194, 180, 120))
            d.ellipse([13, 13, 18, 18], fill=VIOLET)
        elif name == "bone_pile":
            for (x0, y0, x1, y1) in ((5, 24, 26, 27), (8, 20, 22, 23),
                                     (11, 16, 20, 19)):
                d.rectangle([x0, y0, x1, y1], fill=BONE, outline=INK)
            d.ellipse([12, 9, 21, 18], fill=PARCHMENT, outline=INK)
            d.point((15, 13), INK); d.point((18, 13), INK)
        elif name == "page_drift":
            for (x, y, r) in ((4, 18, 7), (13, 22, 6), (21, 16, 8), (9, 9, 5)):
                d.rectangle([x, y, x + r, y + r - 1], fill=PARCHMENT, outline=INK)
                d.line([(x + 1, y + 2), (x + r - 1, y + 2)], fill=GREY)
        elif name == "brazier_ritual":
            d.polygon([(8, 30), (24, 30), (21, 44), (11, 44)], fill=GREY, outline=INK)
            d.rectangle([6, 26, 26, 31], fill=GREY_HI, outline=INK)
            d.polygon([(12, 26), (16, 14), (20, 26)], fill=ORANGE)
            d.polygon([(14, 26), (16, 19), (18, 26)], fill=GOLD)
            d.line([(9, 44), (9, 47)], fill=INK); d.line([(23, 44), (23, 47)], fill=INK)
        else:  # offering_bowl
            d.ellipse([4, 14, 28, 26], fill=SLATE, outline=INK)
            d.ellipse([7, 15, 25, 22], fill=VOID, outline=GREY)
            d.ellipse([12, 16, 20, 20], fill=VIOLET_HI)
        save(im, f"props/prop_eldritch_{name}_01.png")

        meta = {
            "id": f"prop_eldritch_{name}_01",
            "category": "eldritch",
            "sprite_envelope_px": [w, h],
            "footprint_tiles": [1, 1],
            "anchor": "bottom_center",
            "z_layer": 3,
            "blocks_movement": kind == "standing",
            "blocks_los": False,
            "cover_level": 0.25 if kind == "standing" else 0.0,
            "destructible": name in ("candle_row", "bone_pile", "brazier_ritual"),
            "max_hp": 18 if kind == "standing" else 0,
            "light_radius_cells": 3 if name in ("candle_row", "brazier_ritual") else 0,
            "movement_cost_multiplier": None,
            "_placeholder": True,
        }
        p = OUT / "props" / f"prop_eldritch_{name}_01.meta.json"
        p.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        MADE.append(f"props/prop_eldritch_{name}_01.meta.json")


# --------------------------------------------------------------------------
# The two missing humans — paper-doll composites, not new pixels.
# --------------------------------------------------------------------------

FRAME_W, FRAME_H = 24, 32
CUSTOM = SRC / "assets" / "sprites" / "characters" / "custom"


def doll_frame(part: str, name: str):
    p = CUSTOM / part / f"chr_custom_{name}_s.png"
    if not p.exists():
        return None
    return Image.open(p).convert("RGBA").crop((0, 0, FRAME_W, FRAME_H))


def humans():
    if not HAVE_SRC:
        print(f"  SKIP humans: {NO_SRC_NOTE}")
        return
    recipes = {
        # Fallen from the same office as the player Inspector — same longcoat
        # language, wrecked.
        "enemy_disgraced_inspector_s.png": [
            ("base", "base_body"), ("bottoms", "bottom_04_patched_pants"),
            ("shoes", "shoe_08_wrapped_feet"), ("tops", "top_02_long_coat"),
            ("hair", "hair_03_long_loose"),
        ],
        # Heavier build, ecclesiastical. The occult robe + shawl reads as rank.
        "enemy_high_inquisitor_s.png": [
            ("base", "base_body"), ("bottoms", "bottom_08_occult_hem"),
            ("shoes", "shoe_07_armored_boots"), ("tops", "top_08_occult_robe"),
            ("hair", "hair_09_topknot"),
        ],
    }
    for out_name, layers in recipes.items():
        canvas = Image.new("RGBA", (FRAME_W, FRAME_H), CLEAR)
        n = 0
        for part, name in layers:
            fr = doll_frame(part, name)
            if fr is None:
                print(f"  WARN {out_name}: missing {part}/{name}")
                continue
            canvas.alpha_composite(fr)
            n += 1
        if n:
            save(canvas, f"enemies/{out_name}")


if __name__ == "__main__":
    if not HAVE_SRC:
        print(NO_SRC_NOTE)
    items()
    props()
    humans()
    print(f"{len(MADE)} content assets generated -> {OUT}")
    for m in MADE:
        print(f"  {m}")
