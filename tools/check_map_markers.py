#!/usr/bin/env python3
"""Validate the thirteen map-space UI assets at their native 64px contract."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


EXPECTED = (
    "ui/markers/ui_token_ring_self.png",
    "ui/markers/ui_token_ring_hostile.png",
    "ui/markers/ui_token_ring_elite.png",
    "ui/markers/ui_token_ring_ally.png",
    "ui/markers/ui_token_ring_neutral.png",
    "ui/markers/ui_tile_marker_cursor.png",
    "ui/markers/ui_tile_marker_valid.png",
    "ui/markers/ui_tile_marker_invalid.png",
    "ui/markers/ui_tile_marker_aoe.png",
    "ui/markers/ui_tile_marker_minrange.png",
    "ui/markers/ui_marker_point.png",
    "ui/markers/ui_marker_downed.png",
    "ui/markers/ui_marker_erased.png",
)


def is_exact_two_x_repeat(im: Image.Image) -> bool:
    """True when every 2x2 block is one colour: evidence of a doubled 32px file."""
    pixels = im.load()
    for y in range(0, 64, 2):
        for x in range(0, 64, 2):
            sample = pixels[x, y]
            if any(
                pixels[x + dx, y + dy] != sample
                for dx, dy in ((1, 0), (0, 1), (1, 1))
            ):
                return False
    return True


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    expected = set(EXPECTED)
    found = {
        path.relative_to(root).as_posix()
        for path in (root / "ui" / "markers").glob("*.png")
    } if (root / "ui" / "markers").exists() else set()

    for rel in sorted(expected - found):
        errors.append(f"missing: {rel}")
    for rel in sorted(found - expected):
        errors.append(f"unexpected: {rel}")

    for rel in sorted(expected & found):
        path = root / rel
        with Image.open(path) as source:
            if source.mode != "RGBA":
                errors.append(f"{rel}: mode {source.mode}, expected RGBA")
                continue
            if source.size != (64, 64):
                errors.append(f"{rel}: size {source.size}, expected (64, 64)")
                continue
            im = source.copy()

        colours = im.getcolors(maxcolors=4096) or []
        if len(colours) < 3:
            errors.append(f"{rel}: only {len(colours)} colours; marker detail is missing")
        if is_exact_two_x_repeat(im):
            errors.append(f"{rel}: exact 2x repetition; still an upscaled 32px source")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="asset root containing ui/markers")
    args = parser.parse_args()
    errors = validate(args.root.resolve())
    if errors:
        for error in errors:
            print(f"FAIL {error}")
        return 1
    print(f"PASS {len(EXPECTED)} native 64x64 map-space assets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
