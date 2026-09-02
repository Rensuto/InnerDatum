#!/usr/bin/env python3
"""
build_asset_manifest.py — index every generated asset and mark its provenance.

Produces client/public/assets/manifest.placeholders.json: one record per file
with its real measured size, how it was made, and whether it is final art or a
stand-in waiting to be replaced.

This is the file that makes "swap them in later" a mechanical operation rather
than an archaeology exercise. Overwrite a PNG, re-run this, and the diff tells
you exactly what changed and what is still placeholder.

Usage:  python tools/build_asset_manifest.py [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "client" / "public" / "assets"
OUT = ASSETS / "manifest.placeholders.json"

# provenance:
#   derived  — cropped/composited from real Outer Index art. FINAL QUALITY.
#   stand-in — procedurally generated. Replace with hand-drawn art.
#   upscaled — real art, but DRAWN FOR A SMALLER CELL and doubled to fit this
#              one. Not final: the pixels are duplicated, not painted. This is
#              DETECTED rather than declared (see `is_upscaled`), so it clears
#              itself the moment native art is dropped in its place.
PROVENANCE = [
    ("characters/chr_player_watchman_s.png",        "derived",  "crop col0 chr_player_watchman_s"),
    ("characters/chr_player_inspector_s.png",       "derived",  "crop col0 chr_player_detective_s"),
    ("characters/chr_player_enforcer_s.png",        "derived",  "crop col0 chr_player_enforcer_s"),
    ("characters/chr_player_voidling_s.png",        "derived",  "crop col0 chr_player_voidling_s"),
    ("characters/chr_player_alchemist_s.png",       "derived",  "paper-doll composite"),
    ("characters/chr_player_cipher_clerk_s.png",    "derived",  "paper-doll composite"),
    ("characters/chr_npc_bent_watchman_s.png",      "derived",  "paper-doll composite"),
    ("enemies/",                                    "derived",  "paper-doll composite"),
    ("characters/chr_player_watchman_downed_s.png", "stand-in", "rotated token + contact outline"),
    ("characters/chr_player_inspector_downed_s.png","stand-in", "rotated token + contact outline"),
    ("characters/chr_player_alchemist_downed_s.png","stand-in", "rotated token + contact outline"),
    # The overworld tileset is hand-drawn to ART-OVERWORLD.md, like the icons.
    ("tiles/",                                      "derived",  "hand-drawn overworld tileset"),
    ("branding/",                                   "stand-in", "procedural emblem"),
    ("items/",                                      "stand-in", "procedural slot silhouette"),
    ("props/",                                      "stand-in", "procedural"),
    ("ui/",                                         "stand-in", "procedural"),
]

# Which milestone first needs each family.
MILESTONE = [
    ("branding/",            "M0"),
    ("ui/markers/ui_token_ring_", "M1"),
    ("ui/icons/turn/",       "M2"),
    ("ui/chrome/ui_hotbar",  "M3"),
    ("ui/pips/",             "M3"),
    ("ui/cursors/",          "M3"),
    ("ui/markers/ui_tile_",  "M3"),
    ("ui/icons/characters/", "M3"),
    ("characters/",          "M3"),
    ("ui/icons/status/",     "M4"),
    ("ui/icons/ui_icon_speaking", "M4"),
    ("ui/panels/",           "M4"),
    ("ui/markers/ui_marker_","M4"),
    ("enemies/",             "M5"),
    ("props/",               "M5"),
    ("items/",               "M6"),
    ("ui/chrome/ui_item_frame", "M6"),
    ("ui/chrome/ui_inventory",  "M6"),
    ("tiles/",               "M7"),   # the overworld
]


# Map-space art is doubled to the 64-pixel cell by the generators (see
# `MAP_SPACE` in gen_content_assets.py). Anything whose every 2x2 block is one
# flat colour came through that double and has no detail at this size.
MAP_SPACE = ("characters/", "enemies/", "props/")


def is_upscaled(im: Image.Image, rel: str) -> bool:
    if not rel.startswith(MAP_SPACE):
        return False
    w, h = im.size
    if w % 2 or h % 2 or w < 2 or h < 2:
        return False
    px = im.convert("RGBA").load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            a = px[x, y]
            if px[x + 1, y] != a or px[x, y + 1] != a or px[x + 1, y + 1] != a:
                return False
    return True


def match(rel: str, table):
    best = None
    for prefix, *rest in table:
        if rel.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, *rest)
    return best


def build():
    records = []
    for p in sorted(ASSETS.rglob("*.png")):
        rel = str(p.relative_to(ASSETS)).replace("\\", "/")
        im = Image.open(p)
        w, h = im.size
        prov = match(rel, PROVENANCE)
        ms = match(rel, [(a, b) for a, b in MILESTONE])
        records.append({
            "id": Path(rel).stem,
            "path": rel,
            "w": w,
            "h": h,
            "provenance": (
                "upscaled" if is_upscaled(im, rel) else (prov[1] if prov else "unknown")
            ),
            "method": prov[2] if prov else "",
            "milestone": ms[1] if ms else "?",
            "sha256_16": hashlib.sha256(p.read_bytes()).hexdigest()[:16],
        })

    stand_ins = [r for r in records if r["provenance"] == "stand-in"]
    derived = [r for r in records if r["provenance"] == "derived"]
    upscaled = [r for r in records if r["provenance"] == "upscaled"]

    doc = {
        "_comment": (
            "Generated by tools/build_asset_manifest.py. 'derived' assets are "
            "cropped or composited from the author's existing Outer Index art "
            "and are final quality. 'stand-in' assets are procedurally "
            "generated placeholders: correct dimensions, correct names, correct "
            "palette, meant to be overwritten by hand-drawn art. Replacing one "
            "is a file overwrite -- no code, manifest or pipeline change. "
            "'upscaled' assets are real art drawn for a smaller cell and "
            "doubled to fit this one; the flag is measured from the pixels, so "
            "it clears itself when native art replaces them."
        ),
        "counts": {
            "total": len(records),
            "derived_final": len(derived),
            "stand_in_replaceable": len(stand_ins),
            "upscaled_for_the_cell": len(upscaled),
        },
        "by_milestone": {
            m: sum(1 for r in records if r["milestone"] == m)
            for m in sorted({r["milestone"] for r in records})
        },
        "assets": records,
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    before = OUT.read_text(encoding="utf-8") if OUT.exists() else None
    doc = build()

    c = doc["counts"]
    print(f"{c['total']} assets indexed -> {OUT.relative_to(REPO)}")
    print(f"  {c['derived_final']:3d} derived from real art (final quality)")
    print(f"  {c['stand_in_replaceable']:3d} procedural stand-ins (replace at leisure)")
    print(f"  {c['upscaled_for_the_cell']:3d} drawn for the old cell and doubled (needs native art)")
    print("  by milestone: " + ", ".join(
        f"{k}={v}" for k, v in sorted(doc["by_milestone"].items())))

    if args.check and before is not None:
        if before != OUT.read_text(encoding="utf-8"):
            raise SystemExit("CHECK FAILED — manifest is stale, re-run and commit")
        print("CHECK OK")
