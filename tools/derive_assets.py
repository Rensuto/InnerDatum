#!/usr/bin/env python3
"""
derive_assets.py — produce shippable tokens from the read-only Outer Index art.

These are NOT placeholders. Every pixel here comes from the existing hand-made
art; this script only crops and composites. Output is final-quality.

The "zero new pixels" moves:
  * crop frame 0 / row S out of a filmstrip  -> a 24x32 static token
  * composite the paper-doll kit             -> classes that were never drawn

The source art tree is READ-ONLY. This script opens files there and writes
only into client/public/assets/.

Usage:
    python tools/derive_assets.py [--src <ART_SOURCE_DIR>] [--out <dir>] [--check]

--check builds into a temporary directory, verifies those files against the
deployed outputs, and exits non-zero on a difference. It never writes into the
deployed art tree.

Not a CI step: the art is not distributed with this repository, so CI has
nothing to check against. This is for the machine that holds the source art.
"""

from __future__ import annotations

import argparse
import hashlib
import tempfile
from os import environ
from pathlib import Path

from PIL import Image

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

# ART_SOURCE_DIR points at the outer-index-engine directory of the read-only
# Outer Index tree — the one containing `assets/` and `content/`.
#
# NOT hardcoded. This repository is public, and an absolute path here would
# publish a Windows username while being wrong on every machine but one.
#
# The art itself is NOT distributed with this repo (see ASSETS-LICENSE.md), so a
# clone without it derives nothing and says so rather than failing obscurely.
ART_ROOT = Path(environ.get("ART_SOURCE_DIR", ""))
DEFAULT_SRC = ART_ROOT / "assets"
REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "client" / "public" / "assets"

# --------------------------------------------------------------------------
# Sprite grid facts — verified by measuring the real files.
# --------------------------------------------------------------------------

FRAME_W, FRAME_H = 24, 32          # every human in the project
ROW_ORDER = ["n", "ne", "e", "se", "s", "sw", "w", "nw"]
SOUTH_ROW = ROW_ORDER.index("s")   # 4

# Paper-doll draw order. Bottoms before tops so a coat hangs over trousers;
# shoes before tops so a long hem covers the ankle; hair last, over the skull.
DOLL_ORDER = ["base", "bottoms", "shoes", "tops", "hair"]

# A `_s` enemy source is one horizontal animation strip. Its filename does not
# encode the frame geometry, and height is not a safe proxy for width: the
# replacement Eidolon is six 64x64 frames (384x64), while the Husk is six
# 48x64 frames (288x64). The old `height > 32 -> width 48` heuristic silently
# cut sixteen columns off every Eidolon frame.
#
# Keep the contract beside the closed set of assets that consumes it. A source
# replacement with different geometry now fails loudly until this table is
# reviewed, rather than being accepted and clipped.
ENEMY_FRAME_SIZE: dict[str, tuple[int, int]] = {
    "index_husk": (48, 64),
    "index_wraith": (24, 32),
    "index_husk_elite": (24, 32),
    "index_cairn": (24, 32),
    "index_glut": (24, 32),
    "index_eidolon": (64, 64),
}


def sheet(rel: str) -> Path:
    return SRC / rel


def frame0_south(path: Path) -> Image.Image:
    """
    Take the resting south-facing frame out of a sheet.

    Handles both layouts present in the source:
      * 144x32  single-row `_s.png` filmstrip  -> crop (0,0)
      * 144x256 `_8dir.png` sheet              -> crop (0, SOUTH_ROW*32)

    Never assumes a column count. We only ever take column 0, so the varying
    frame counts (4 on the voidling, 6 elsewhere) are irrelevant here.
    """
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    if h == FRAME_H:
        top = 0
    elif h == FRAME_H * 8:
        top = SOUTH_ROW * FRAME_H
    else:
        raise SystemExit(f"{path.name}: unexpected height {h} (want 32 or 256)")
    if w % FRAME_W:
        raise SystemExit(f"{path.name}: width {w} is not a multiple of {FRAME_W}")
    return im.crop((0, top, FRAME_W, top + FRAME_H))


def enemy_frame0(path: Path, frame_size: tuple[int, int]) -> Image.Image:
    """Take frame zero from a one-row enemy strip with explicit geometry."""
    im = Image.open(path).convert("RGBA")
    frame_w, frame_h = frame_size
    if im.height != frame_h:
        raise SystemExit(
            f"{path.name}: unexpected height {im.height} (contract says {frame_h})"
        )
    if im.width % frame_w:
        raise SystemExit(
            f"{path.name}: width {im.width} is not a multiple of frame width {frame_w}"
        )
    return im.crop((0, 0, frame_w, frame_h))


def composite(layers: list[Image.Image]) -> Image.Image:
    out = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    for layer in layers:
        out.alpha_composite(layer)
    return out


def prone(tok: Image.Image) -> Image.Image:
    """
    A downed figure is 32x24 — wider than tall — and still anchors bottom_center,
    so it lands inside its tile.

    Rotating a 3/4 orthographic sprite 90 degrees looks broken: the face ends up
    in profile-from-above and the feet point sideways. A first attempt that rotated AND desaturated toward
    the palette violet produced an unreadable blob — the desaturation collapsed
    the contrast that was carrying the silhouette.

    So this keeps the rotation (the character stays recognisable by costume
    colour, which is what a player actually reads across a 30x30 room) and
    drops the recolour entirely. Instead it multiplies down slightly and stamps
    a 1 px crimson contact outline, so 'downed' is signalled by the outline
    rather than by destroying the sprite.

    Still a stand-in: these want to be hand-drawn eventually. This exists so the
    downed mechanic is legible before then.
    """
    rot = tok.rotate(90, expand=True, resample=Image.NEAREST)   # 24x32 -> 32x24
    canvas = Image.new("RGBA", (32, 24), (0, 0, 0, 0))
    canvas.alpha_composite(rot, (0, 0))

    px = canvas.load()
    # Darken to ~72%: reads as 'on the floor, out of the light' without
    # touching hue, so the costume still identifies the character.
    for y in range(24):
        for x in range(32):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (r * 72 // 100, g * 72 // 100, b * 72 // 100, a)

    # 1 px crimson outline on the outside edge of the silhouette.
    OUTLINE = (150, 30, 44, 255)
    solid = [[px[x, y][3] > 0 for y in range(24)] for x in range(32)]
    for x in range(32):
        for y in range(24):
            if solid[x][y]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < 32 and 0 <= ny < 24 and solid[nx][ny]:
                    px[x, y] = OUTLINE
                    break
    return canvas


# --------------------------------------------------------------------------
# Map-space art is drawn on a 64-pixel cell (shared/version.ts's TILE_PX), and
# every token here is authored on the 32-pixel grid the game used to draw. A
# whole-number NEAREST double is the honest answer for pixel art: it changes no
# colour, invents no pixel, and keeps a token exactly the same size RELATIVE to
# the cell it stands on -- which is the property that matters, because the
# renderer anchors a sprite bottom-centre at its natural size rather than
# stretching it to fit.
#
# ONLY MAP SPACE. `items/` and `ui/` are drawn in the INTERFACE buffer, whose
# scale did not change (render/canvas.ts's `HUD_MIN_W`), and the item atlas is
# addressed as `px = (i % 10) * 64` with no rect table -- doubling those would
# break the grid and shrink nothing.
# --------------------------------------------------------------------------
MAP_SPACE = ("characters/", "enemies/", "props/")
MAP_SCALE = 2

# Some legacy source frames carry more transparent staging canvas than the
# Inner Datum renderer contract. The Eidolon's 64x64 source frame has a narrow
# hovering body inside it; after the honest 2x pixel transform, its visible
# pixels fit the approved 96x128 large-creature envelope. Trim only the empty
# staging margins and fail if replacement art ever grows into the trim zone.
MAP_CANVAS_SIZE: dict[str, tuple[int, int]] = {
    "enemies/enemy_index_eidolon_s.png": (96, 128),
}


def to_cell(im, rel):
    """Nearest-neighbour double, for map-space art only."""
    if not rel.startswith(MAP_SPACE):
        return im
    return im.resize((im.width * MAP_SCALE, im.height * MAP_SCALE), Image.NEAREST)


def exact_2x_blocks(image: Image.Image) -> bool:
    """True when every output pixel is part of an identical 2x2 legacy block."""
    rgba = image.convert("RGBA")
    if rgba.width % 2 or rgba.height % 2:
        return False
    pixels = rgba.load()
    for y in range(0, rgba.height, 2):
        for x in range(0, rgba.width, 2):
            value = pixels[x, y]
            if (
                pixels[x + 1, y] != value
                or pixels[x, y + 1] != value
                or pixels[x + 1, y + 1] != value
            ):
                return False
    return True


def save(im: Image.Image, rel: str, output_root: Path = OUT) -> Path:
    dest = output_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    # A broad legacy rebuild must never silently replace an already installed
    # native map-space remaster with this script's old-cell fallback. Staging
    # builds still receive every legacy output, and --check will still report
    # the intentional difference. Replacing native art is an explicit reviewed
    # installer action, not a side effect of `npm run assets`.
    if (
        output_root.resolve() == OUT.resolve()
        and rel.startswith(MAP_SPACE)
        and dest.exists()
        and not exact_2x_blocks(Image.open(dest))
    ):
        print(f"  KEEP {rel}: deployed map art is already native")
        return dest
    # Deterministic: no timestamp chunk, fixed compression.
    final = to_cell(im, rel)
    canvas_size = MAP_CANVAS_SIZE.get(rel)
    if canvas_size is not None:
        target_w, target_h = canvas_size
        if final.width < target_w or final.height < target_h:
            raise SystemExit(
                f"{rel}: {final.size} is smaller than required canvas {canvas_size}"
            )
        left = (final.width - target_w) // 2
        top = final.height - target_h
        crop_box = (left, top, left + target_w, top + target_h)
        alpha_box = final.getchannel("A").getbbox()
        if alpha_box is not None:
            ax0, ay0, ax1, ay1 = alpha_box
            cx0, cy0, cx1, cy1 = crop_box
            if ax0 < cx0 or ay0 < cy0 or ax1 > cx1 or ay1 > cy1:
                raise SystemExit(
                    f"{rel}: visible pixels {alpha_box} exceed approved canvas crop {crop_box}"
                )
        final = final.crop(crop_box)
    final.save(dest, "PNG", optimize=True)
    return dest


# --------------------------------------------------------------------------
# The derivations
# --------------------------------------------------------------------------

PLAYER = "sprites/characters/player"
CUSTOM = "sprites/characters/custom"


def doll(part: str, name: str) -> Image.Image:
    return frame0_south(sheet(f"{CUSTOM}/{part}/chr_custom_{name}_s.png"))


def build(output_root: Path = OUT) -> list[tuple[str, str]]:
    made: list[tuple[str, str]] = []
    standing_tokens: dict[str, Image.Image] = {}

    # --- 1. Straight crops. The class already exists, under another name. ---
    #
    # The design's Inspector IS the detective: ranged precision, a revolver, an
    # office. The Watchman is already drawn. Both are one crop away.
    crops = {
        "chr_player_watchman_s.png":  f"{PLAYER}/chr_player_watchman_s.png",
        "chr_player_inspector_s.png": f"{PLAYER}/chr_player_detective_s.png",
        "chr_player_enforcer_s.png":  f"{PLAYER}/chr_player_enforcer_s.png",
        "chr_player_voidling_s.png":  f"{PLAYER}/chr_player_voidling_s.png",
    }
    for out_name, src_rel in crops.items():
        src = sheet(src_rel)
        if not src.exists():
            print(f"  SKIP {out_name}: missing {src_rel}")
            continue
        token = frame0_south(src)
        save(token, f"characters/{out_name}", output_root)
        standing_tokens[out_name] = token
        made.append((out_name, f"crop col0 of {Path(src_rel).name}"))

    # --- 2. Paper-doll composites. Classes nobody ever drew. ---
    #
    # 41 registered layers on the same grid. The Alchemist's costume already
    # exists as separate garments; it just was never assembled.
    recipes = {
        "chr_player_alchemist_s.png": {
            "base":    "base_body",
            "bottoms": "bottom_06_apron_skirt",
            "shoes":   "shoe_01_ankle_boots",
            "tops":    "top_07_worker_apron",
            "hair":    "hair_04_high_ponytail",
        },
        "chr_player_cipher_clerk_s.png": {
            "base":    "base_body",
            "bottoms": "bottom_09_cuffed_knickers",
            "shoes":   "shoe_03_buckle_shoes",
            "tops":    "top_04_high_collar_jacket",
            "hair":    "hair_01_side_part",
        },
        # A genuinely different silhouette from the player Watchman, which a
        # palette swap would never have given us.
        "chr_npc_bent_watchman_s.png": {
            "base":    "base_body",
            "bottoms": "bottom_07_armored_leggings",
            "shoes":   "shoe_10_iron_boots",
            "tops":    "top_09_military_tunic",
            "hair":    "hair_02_bob",
        },
    }

    for out_name, recipe in recipes.items():
        layers, missing = [], []
        for part in DOLL_ORDER:
            name = recipe.get(part)
            if not name:
                continue
            p = sheet(f"{CUSTOM}/{part}/chr_custom_{name}_s.png")
            if not p.exists():
                missing.append(f"{part}/{name}")
                continue
            layers.append(frame0_south(p))
        if missing:
            print(f"  WARN {out_name}: missing layers {missing}")
        if not layers:
            print(f"  SKIP {out_name}: no layers resolved")
            continue
        token = composite(layers)
        save(token, f"characters/{out_name}", output_root)
        standing_tokens[out_name] = token
        made.append((out_name, f"composite of {len(layers)} paper-doll layers"))

    # --- 3. Enemy tokens. THE OMISSION THAT SHIPPED A GAME WITH NO MONSTERS. ---
    #
    # content/monsters.ts has always referenced `enemy_index_husk_s` and friends;
    # this script only ever derived the PLAYER sheets, so the client fell back to
    # its missing-sprite box for every hostile on the map. It was invisible in
    # tests (nothing asserts a PNG exists) and invisible in review (the ids were
    # correct), and only showed up the first time somebody fought something.
    #
    # Frame sizes DIFFER per creature and must not be inferred from height.
    # In particular, the current Eidolon is 64x64 while the Husk is 48x64.
    for name, frame_size in ENEMY_FRAME_SIZE.items():
        src = sheet(f"sprites/enemies/enemy_{name}_s.png")
        if not src.exists():
            print(f"  SKIP enemy_{name}_s.png: no source")
            continue
        frame = enemy_frame0(src, frame_size)
        save(frame, f"enemies/enemy_{name}_s.png", output_root)
        made.append(
            (f"enemy_{name}_s.png", f"crop col0 ({frame.width}x{frame.height})")
        )

    # --- 4. Downed/prone variants, derived from the tokens above. ---
    # `prone` operates in the 24x32 source cell. Do not reopen the already
    # doubled deployed token here: rotating that 48x64 image into a 32x24
    # canvas crops away half the body before `save` doubles it a second time.
    for cls in ("watchman", "inspector", "alchemist"):
        standing_name = f"chr_player_{cls}_s.png"
        tok = standing_tokens.get(standing_name)
        if tok is None:
            print(f"  SKIP downed {cls}: {standing_name} was not produced")
            continue
        save(prone(tok), f"characters/chr_player_{cls}_downed_s.png", output_root)
        made.append((f"chr_player_{cls}_downed_s.png", "prone derivation (stand-in)"))

    return made


def output_mismatches(staged: Path, deployed: Path) -> list[str]:
    """Return generated PNGs that are absent from or differ from deployment."""
    mismatches: list[str] = []
    for expected in sorted(staged.rglob("*.png")):
        rel = expected.relative_to(staged)
        actual = deployed / rel
        expected_hash = hashlib.sha256(expected.read_bytes()).digest()
        actual_hash = hashlib.sha256(actual.read_bytes()).digest() if actual.exists() else None
        if actual_hash != expected_hash:
            mismatches.append(str(rel).replace("\\", "/"))
    return mismatches


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    global SRC
    SRC = args.src
    if not SRC.exists():
        raise SystemExit(
            "ART_SOURCE_DIR is not set, or does not exist. This tool derives sprites "
            "from the Outer Index art tree, which is NOT distributed with this "
            "repository (see ASSETS-LICENSE.md) — point ART_SOURCE_DIR at your own "
            f"copy in .env or the environment. Looked in: {SRC}"
        )

    if args.check:
        with tempfile.TemporaryDirectory(prefix="inner-datum-derive-check-") as temp:
            staged = Path(temp)
            made = build(staged)
            changed = output_mismatches(staged, args.out)
        if changed:
            raise SystemExit(f"CHECK FAILED — deployed outputs differ: {changed}")
        destination = args.out
    else:
        made = build(args.out)
        destination = args.out

    print(f"\n{len(made)} assets derived from existing art -> {destination}")
    for name, how in made:
        print(f"  {name:38s} {how}")

    if args.check:
        print("\nCHECK OK — deployed outputs are byte-identical; deployment was not written")


if __name__ == "__main__":
    main()
