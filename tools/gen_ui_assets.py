#!/usr/bin/env python3
"""
gen_ui_assets.py — generate the HUD chrome Outer Index never drew.

The source project was a card game, so it has world art but no roguelike
interface. This script produces that chrome procedurally: dimensionally exact, palette-correct, deterministic, and designed
to be REPLACED. Swapping in hand-drawn art is a file overwrite — nothing else
in the pipeline changes.

Everything is drawn at native resolution with hard 1 px edges and no
antialiasing, because the client upscales by integer factors. A soft edge turns to mush; a hard edge stays a line.

Palette is sampled from the real art, not invented — see PALETTE below.

Usage:
    python tools/gen_ui_assets.py [--only <substring>] [--contact]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "client" / "public" / "assets"

# --------------------------------------------------------------------------
# Palette — measured from the existing art, not chosen.
#
#   python: Counter over icon_active_vigil, icon_passive_ironhide,
#           card_frame_active_common, icon_character_the_watchman,
#           icon_weapon_iron_sword, card_row_frame_common
#
# The house style is a deep violet-black ground, cool greys for metal, a violet
# accent, and warm gold/orange for anything that wants attention.
# --------------------------------------------------------------------------

INK       = (10, 8, 19, 255)        # #0a0813  deepest shadow
VOID      = (33, 8, 46, 255)        # #21082e  the signature purple-black
PANEL     = (49, 41, 56, 255)       # #312938  panel fill
PANEL_HI  = (56, 50, 64, 255)       # #383240  panel bevel light
SLATE     = (54, 48, 62, 255)       # #36303e
GREY      = (92, 93, 99, 255)       # #5c5d63  metal mid
GREY_HI   = (153, 153, 159, 255)    # #99999f  metal light
SILVER    = (164, 164, 171, 255)    # #a4a4ab  metal highlight
VIOLET    = (99, 64, 158, 255)      # #63409e  accent
VIOLET_HI = (166, 112, 224, 255)    # #a670e0  accent light
ORANGE    = (255, 132, 39, 255)     # #ff8427  alert / fire
GOLD      = (255, 228, 121, 255)    # #ffe479  highlight / self
PARCHMENT = (237, 230, 194, 255)    # #ede6c2  paper, text-ish
BONE      = (197, 194, 180, 255)    # #c5c2b4

# Semantic additions. Only two, both required for readability and both chosen
# to sit inside the existing warm/violet range rather than fight it.
CRIMSON   = (150, 30, 44, 255)      # hostile, invalid, downed
CRIMSON_HI= (206, 62, 74, 255)
VERDIGRIS = (86, 138, 116, 255)     # 'valid' — the one cool hue; the palette
                                    # has no green, so it is desaturated hard
                                    # to avoid reading as a different game.
CLEAR     = (0, 0, 0, 0)


def img(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGBA", (w, h), CLEAR)
    return im, ImageDraw.Draw(im)


def save(im: Image.Image, rel: str) -> None:
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "PNG", optimize=True)
    MADE.append(rel)


MADE: list[str] = []


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------

def bevel_box(d, x0, y0, x1, y1, fill, light, dark):
    """A 1 px raised box. Light top/left, dark bottom/right."""
    d.rectangle([x0, y0, x1, y1], fill=fill)
    d.line([(x0, y0), (x1, y0)], fill=light)
    d.line([(x0, y0), (x0, y1)], fill=light)
    d.line([(x0, y1), (x1, y1)], fill=dark)
    d.line([(x1, y0), (x1, y1)], fill=dark)


def corner_ticks(d, x0, y0, x1, y1, col, n=3):
    """Small corner brackets — the card frames' ornament, reduced to 1 px."""
    for i in range(n):
        d.point((x0 + i, y0), col); d.point((x0, y0 + i), col)
        d.point((x1 - i, y0), col); d.point((x1, y0 + i), col)
        d.point((x0 + i, y1), col); d.point((x0, y1 - i), col)
        d.point((x1 - i, y1), col); d.point((x1, y1 - i), col)


def ring(d, cx, cy, rx, ry, col, width=1):
    for w in range(width):
        d.ellipse([cx - rx + w, cy - ry + w, cx + rx - w, cy + ry - w], outline=col)


def glyph(d, cells, col, ox=0, oy=0, scale=1):
    """Paint a small ASCII-art glyph. '.' is transparent, anything else is col."""
    for y, row in enumerate(cells):
        for x, ch in enumerate(row):
            if ch != ".":
                if scale == 1:
                    d.point((ox + x, oy + y), col)
                else:
                    d.rectangle(
                        [ox + x * scale, oy + y * scale,
                         ox + x * scale + scale - 1, oy + y * scale + scale - 1],
                        fill=col)


# --------------------------------------------------------------------------
# 1. Token rings (M1) — 32x32, ellipse in the bottom ~12 px
# --------------------------------------------------------------------------

def token_rings():
    variants = {
        "self":    (GOLD,      (255, 228, 121, 70)),
        "ally":    (VIOLET_HI, (166, 112, 224, 60)),
        "hostile": (CRIMSON_HI,(206, 62, 74, 60)),
        "neutral": (GREY_HI,   (153, 153, 159, 50)),
    }
    for name, (edge, fill) in variants.items():
        im, d = img(32, 32)
        # Ellipse sits on the floor plane under the feet: bottom 12 px.
        d.ellipse([3, 19, 28, 30], fill=fill)
        d.ellipse([3, 19, 28, 30], outline=edge)
        # Break the ring left/right so overlapping tokens still read.
        d.point((3, 24), CLEAR); d.point((28, 24), CLEAR)
        save(im, f"ui/markers/ui_token_ring_{name}.png")

    # Elite: the base hostile ring plus four spikes. index_husk_elite is 24x32
    # while base index_husk is 48x64, so without this the elite reads as the
    # SMALLER creature.
    im, d = img(32, 32)
    d.ellipse([3, 19, 28, 30], fill=(206, 62, 74, 60))
    d.ellipse([3, 19, 28, 30], outline=ORANGE)
    for x in (7, 15, 23):
        d.line([(x, 18), (x, 15)], fill=ORANGE)
        d.point((x, 14), GOLD)
    save(im, "ui/markers/ui_token_ring_elite.png")


# --------------------------------------------------------------------------
# 2. Turn-state chips (M2) — 24x24. The Warrant Clock's whole UX surface.
# --------------------------------------------------------------------------

TURN_GLYPHS = {
    # you have committed — a check
    "committed": ([
        "..............",
        "............#.",
        "...........##.",
        "..........###.",
        ".#.......###..",
        ".##.....###...",
        "..##...###....",
        "...##.###.....",
        "....#####.....",
        ".....###......",
        "......#.......",
        "..............",
    ], VERDIGRIS),
    # you owe a decision — an hourglass
    "waiting": ([
        ".##########...",
        ".#........#...",
        "..#......#....",
        "...#....#.....",
        "....#..#......",
        ".....##.......",
        ".....##.......",
        "....#..#......",
        "...#.##.#.....",
        "..#.####.#....",
        ".#.######.#...",
        ".##########...",
    ], GOLD),
    # the Bell is counting down on you
    "bell": ([
        "......##......",
        ".....####.....",
        "....######....",
        "...########...",
        "...########...",
        "..##########..",
        "..##########..",
        ".############.",
        ".############.",
        "..............",
        ".....####.....",
        "......##......",
    ], ORANGE),
    # dropped to Standing By after two silent turns
    "standing_by": ([
        "..............",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..####..####..",
        "..............",
        "..............",
    ], GREY),
}


def turn_chips():
    for name, (cells, col) in TURN_GLYPHS.items():
        im, d = img(24, 24)
        bevel_box(d, 0, 0, 23, 23, PANEL, PANEL_HI, INK)
        glyph(d, cells, col, ox=5, oy=6)
        save(im, f"ui/icons/turn/ui_icon_turn_{name}.png")


# --------------------------------------------------------------------------
# 3. Status badges (M4) — 24x24, one silhouette-readable shape each.
# --------------------------------------------------------------------------

STATUS_GLYPHS = {
    "stunned": ([                       # starburst
        "......#.#.....",
        "..#...#.#...#.",
        "...#..###..#..",
        "....#####.#...",
        "..############",
        "....#####.#...",
        "...#..###..#..",
        "..#...#.#...#.",
        "......#.#.....",
    ], GOLD),
    "bleeding": ([                      # droplet
        "......##......",
        "......##......",
        ".....####.....",
        "....######....",
        "...########...",
        "..##########..",
        "..##########..",
        "...########...",
        ".....####.....",
    ], CRIMSON_HI),
    "slowed": ([                        # stacked downward chevrons
        "#############.",
        ".###########..",
        "..#########...",
        "...#######....",
        "....#####.....",
        "..............",
        "#############.",
        ".###########..",
        "..#########...",
    ], VIOLET_HI),
    "off_guard": ([                     # cracked shield
        "..#########...",
        "..##..#..##...",
        "..##.##..##...",
        "..##..#..##...",
        "..##.###.##...",
        "...##.#.##....",
        "....##.##.....",
        ".....###......",
        "......#.......",
    ], ORANGE),
    "guarded": ([                       # intact shield
        "..#########...",
        "..#########...",
        "..#########...",
        "..#########...",
        "..#########...",
        "...#######....",
        "....#####.....",
        ".....###......",
        "......#.......",
    ], VERDIGRIS),
    "marked": ([                        # crosshair / sigil
        "......#.......",
        "......#.......",
        "...#######....",
        "..##..#..##...",
        "###...#...###.",
        "..##..#..##...",
        "...#######....",
        "......#.......",
        "......#.......",
    ], VIOLET_HI),
    # --- 4 more budgeted at M6 (PLAN § 9 caps v1.0 at 10 effects) ---
    "dazed":    (["....#####.....", "...#.....#....", "..#..###..#...",
                  ".#..#...#..#..", ".#..#...#..#..", ".#...###...#..",
                  "..#.......#...", "...#.....#....", "....#####....."], BONE),
    "confused": (["...########...", "..#........#..", ".#..##..##..#.",
                  "#..#..##..#..#", "#.....##.....#", "#....##......#",
                  ".#...##.....#.", "..#........#..", "...########..."], VIOLET),
    "hasted":   ([".........###..", "........###...", ".......###....",
                  "..############", ".......###....", "........###...",
                  ".........###..", "..............", ".####....####."], GOLD),
    "shielded": (["..#########...", ".##.......##..", ".#..#####..#..",
                  ".#.#.....#.#..", ".#.#.....#.#..", ".#..#####..#..",
                  "..##.....##...", "...#######....", ".....###......"], SILVER),
    # --- the cross-tier trio (Combat.lua:305-309), one per save channel ------
    # STAND-INS. Each reads at 24x24 and shares nothing with the badge above or
    # below it; that is the whole bar a placeholder has to clear, because a
    # missing PNG falls back to a two-letter glyph and these are the icons that
    # replace Ob / Ss / Bk. Redraw when the real pass happens.
    #
    # A TILTED PLUMB LINE — the weight has swung off true. Physical.
    "off_balance": ([".....###......", "......#.......", "......#.......",
                     ".....#........", "....#.........", "...#..........",
                     "..#...........", ".###..........", "..............",
                     ], ORANGE),
    # A BROKEN RING — the resistance column, opened up. Magical.
    "spellshocked": (["...#######....", "..#.......#...", ".#....#....#..",
                      "#....##.....#.", "#...##......#.", "#..##.......#.",
                      ".#..#......#..", "..#.......#...", "...#######...."], VIOLET_HI),
    # A CLOSED PADLOCK — one talent shut, and nothing cooling down. Mental.
    "brainlocked": (["....#####.....", "...#.....#....", "...#.....#....",
                     ".###########..", ".#.........#..", ".#....#....#..",
                     ".#...###...#..", ".#....#....#..", ".###########.."], BONE),
}


def status_badges():
    for name, (cells, col) in STATUS_GLYPHS.items():
        im, d = img(24, 24)
        d.rectangle([0, 0, 23, 23], fill=(33, 8, 46, 200))
        d.rectangle([0, 0, 23, 23], outline=INK)
        d.rectangle([1, 1, 22, 22], outline=SLATE)
        glyph(d, cells, col, ox=5, oy=7)
        save(im, f"ui/icons/status/icon_status_{name}.png")


# --------------------------------------------------------------------------
# 4. Speaking indicators (M4) — 16x16. Two states only, never a volume ladder.
# --------------------------------------------------------------------------

def speaking():
    im, d = img(16, 16)
    d.rectangle([3, 6, 5, 9], fill=PARCHMENT)          # the mouth/box
    d.polygon([(6, 4), (6, 11), (9, 8), (9, 7)], fill=PARCHMENT)
    for i, r in enumerate((3, 5)):                      # two arcs
        d.arc([10 - r + 2, 8 - r, 10 + r + 2, 8 + r], 300, 60, fill=GOLD)
    save(im, "ui/icons/ui_icon_speaking.png")

    im, d = img(16, 16)
    d.rectangle([3, 6, 5, 9], fill=GREY)
    d.polygon([(6, 4), (6, 11), (9, 8), (9, 7)], fill=GREY)
    d.line([(10, 4), (15, 12)], fill=CRIMSON_HI)        # the slash
    d.line([(11, 4), (15, 11)], fill=CRIMSON)
    save(im, "ui/icons/ui_icon_speaking_muted.png")


# --------------------------------------------------------------------------
# 5. Hotbar slots (M3) — 72x72 holding a 64x64 icon with a 4 px border.
# --------------------------------------------------------------------------

def hotbar():
    states = {
        "idle":     (PANEL,    GREY,    INK,    None),
        "hover":    (SLATE,    GOLD,    VOID,   GOLD),
        "disabled": ((30, 26, 36, 255), (64, 60, 70, 255), INK, None),
    }
    for name, (fill, edge, dark, glow) in states.items():
        im, d = img(72, 72)
        bevel_box(d, 0, 0, 71, 71, fill, edge, dark)
        d.rectangle([3, 3, 68, 68], outline=dark)       # the 64x64 icon well
        corner_ticks(d, 1, 1, 70, 70, edge, n=4)
        if glow:
            d.rectangle([1, 1, 70, 70], outline=glow)
        if name == "disabled":
            # A dim diagonal so 'cannot afford / on cooldown' reads without
            # relying on colour alone (accessibility: never colour-only).
            for i in range(0, 72, 6):
                d.line([(i, 71), (71, i)], fill=(64, 60, 70, 90))
        save(im, f"ui/chrome/ui_hotbar_slot_{name}.png")


# --------------------------------------------------------------------------
# 6. Resource pips (M3) — 12x12. Discrete, never a bar.
# --------------------------------------------------------------------------

def pips():
    def diamond(col, filled):
        im, d = img(12, 12)
        pts = [(6, 0), (11, 6), (6, 11), (0, 6)]
        d.polygon(pts, fill=col if filled else CLEAR, outline=col)
        if filled:
            d.point((5, 4), (255, 255, 255, 120))
        return im

    def circle(col, filled):
        im, d = img(12, 12)
        d.ellipse([0, 0, 11, 11], fill=col if filled else CLEAR, outline=col)
        if filled:
            d.point((4, 3), (255, 255, 255, 130))
        return im

    def flask(col, filled):
        im, d = img(12, 12)
        d.line([(4, 0), (4, 4)], fill=col); d.line([(7, 0), (7, 4)], fill=col)
        body = [(4, 4), (1, 10), (10, 10), (7, 4)]
        d.polygon(body, fill=col if filled else CLEAR, outline=col)
        return im

    # AP is the intra-turn budget — 6 per round, spent within your own turn.
    save(diamond(GOLD, True),      "ui/pips/ui_pip_ap_full.png")
    save(diamond(GOLD, False),     "ui/pips/ui_pip_ap_empty.png")
    save(circle(VIOLET_HI, True),  "ui/pips/ui_pip_mp_full.png")
    save(circle(VIOLET_HI, False), "ui/pips/ui_pip_mp_empty.png")
    save(flask(ORANGE, True),      "ui/pips/ui_pip_reagent_full.png")
    save(flask(ORANGE, False),     "ui/pips/ui_pip_reagent_empty.png")
    # Class resources get distinct SHAPES, not just colours, so a glance at the
    # party panel says who can still act.
    im, d = img(12, 12)                                  # Resolve — a bar/ingot
    d.rectangle([1, 3, 10, 8], fill=BONE, outline=SILVER)
    d.line([(2, 4), (9, 4)], fill=PARCHMENT)
    save(im, "ui/pips/ui_pip_resolve.png")

    im, d = img(12, 12)                                  # Focus — an eye
    d.polygon([(0, 6), (6, 1), (11, 6), (6, 10)], outline=VIOLET_HI)
    d.ellipse([4, 4, 7, 7], fill=VIOLET_HI)
    save(im, "ui/pips/ui_pip_focus.png")


# --------------------------------------------------------------------------
# 7. Cursors (M3) — 32x32 with a declared hotspot.
# --------------------------------------------------------------------------

def cursors():
    im, d = img(32, 32)                                  # default: arrow
    d.polygon([(2, 1), (2, 20), (7, 15), (11, 23), (14, 21), (10, 14), (17, 13)],
              fill=PARCHMENT, outline=INK)
    save(im, "ui/cursors/ui_cursor_default.png")         # hotspot 0,0

    im, d = img(32, 32)                                  # target: crosshair
    ring(d, 16, 16, 10, 10, GOLD)
    for a, b in (((16, 0), (16, 8)), ((16, 24), (16, 31)),
                 ((0, 16), (8, 16)), ((24, 16), (31, 16))):
        d.line([a, b], fill=GOLD)
    d.point((16, 16), GOLD)
    save(im, "ui/cursors/ui_cursor_target.png")          # hotspot 16,16

    im, d = img(32, 32)                                  # invalid
    ring(d, 16, 16, 10, 10, CRIMSON_HI)
    d.line([(9, 9), (23, 23)], fill=CRIMSON_HI)
    d.line([(23, 9), (9, 23)], fill=CRIMSON_HI)
    save(im, "ui/cursors/ui_cursor_invalid.png")         # hotspot 16,16


# --------------------------------------------------------------------------
# 8. Tile markers (M3) — 32x32 floor-plane stamps on a 32 px stride.
#    NOT 64x64: at 64 each marker blankets 2x2 tiles and mis-registers.
# --------------------------------------------------------------------------

def tile_markers():
    im, d = img(32, 32)                                  # cursor: corner brackets
    for (cx, cy, dx, dy) in ((0, 0, 1, 1), (31, 0, -1, 1), (0, 31, 1, -1), (31, 31, -1, -1)):
        for i in range(8):
            d.point((cx + dx * i, cy), PARCHMENT)
            d.point((cx, cy + dy * i), PARCHMENT)
    save(im, "ui/markers/ui_tile_marker_cursor.png")

    im, d = img(32, 32)                                  # valid
    d.rectangle([0, 0, 31, 31], fill=(86, 138, 116, 46), outline=VERDIGRIS)
    save(im, "ui/markers/ui_tile_marker_valid.png")

    im, d = img(32, 32)                                  # invalid
    d.rectangle([0, 0, 31, 31], fill=(150, 30, 44, 46), outline=CRIMSON)
    d.line([(6, 6), (25, 25)], fill=CRIMSON_HI)
    d.line([(25, 6), (6, 25)], fill=CRIMSON_HI)
    save(im, "ui/markers/ui_tile_marker_invalid.png")

    im, d = img(32, 32)                                  # aoe
    d.rectangle([0, 0, 31, 31], fill=(255, 132, 39, 50), outline=ORANGE)
    for i in range(-32, 32, 8):                          # hatch, not colour-only
        d.line([(i, 0), (i + 32, 32)], fill=(255, 132, 39, 70))
    save(im, "ui/markers/ui_tile_marker_aoe.png")

    # min-range hole. The Inspector cannot shoot adjacent (min_range 3). If the
    # dead zone is invisible the class reads as broken, so this is deliberately
    # the loudest marker in the set.
    im, d = img(32, 32)
    d.rectangle([0, 0, 31, 31], fill=(33, 8, 46, 120), outline=CRIMSON)
    for i in range(-32, 32, 6):
        d.line([(i, 31), (i + 31, 0)], fill=(206, 62, 74, 110))
    d.rectangle([0, 0, 31, 31], outline=CRIMSON_HI)
    save(im, "ui/markers/ui_tile_marker_minrange.png")


# --------------------------------------------------------------------------
# 9. Map markers (M4) — 32x32
# --------------------------------------------------------------------------

def map_markers():
    # downed — must be spottable across a 30x30 room instantly.
    im, d = img(32, 32)
    d.ellipse([4, 20, 27, 29], fill=(150, 30, 44, 70), outline=CRIMSON)
    for a, b in (((10, 8), (22, 20)), ((22, 8), (10, 20))):
        d.line([a, b], fill=CRIMSON_HI)
        d.line([(a[0] + 1, a[1]), (b[0] + 1, b[1])], fill=CRIMSON_HI)
    save(im, "ui/markers/ui_marker_downed.png")

    # erased — the 5-turn timer expired. A redaction bar: the Index's own
    # visual language for something struck from the record.
    im, d = img(32, 32)
    d.rectangle([2, 12, 29, 21], fill=INK, outline=VOID)
    d.line([(4, 16), (27, 16)], fill=VIOLET)
    d.rectangle([2, 12, 29, 21], outline=VIOLET_HI)
    save(im, "ui/markers/ui_marker_erased.png")

    # point — the map ping. One PNG covers all six players; per-player colour is
    # a canvas tint.
    im, d = img(32, 32)
    for r, col in ((13, (255, 228, 121, 90)), (9, (255, 228, 121, 150)), (5, GOLD)):
        ring(d, 16, 16, r, r, col)
    d.point((16, 16), PARCHMENT)
    save(im, "ui/markers/ui_marker_point.png")


# --------------------------------------------------------------------------
# 10. Panels (M4) — 9-slice sources, 16 px corners / 16 px stretch centre.
# --------------------------------------------------------------------------

def panels():
    im, d = img(48, 48)                                  # case file: outer panel
    d.rectangle([0, 0, 47, 47], fill=PANEL)
    d.rectangle([0, 0, 47, 47], outline=INK)
    d.rectangle([1, 1, 46, 46], outline=GREY)
    d.rectangle([2, 2, 45, 45], outline=PANEL_HI)
    corner_ticks(d, 3, 3, 44, 44, GOLD, n=3)
    save(im, "ui/panels/ui_panel_9slice_case_file.png")

    im, d = img(48, 48)                                  # inset: scrolling regions
    d.rectangle([0, 0, 47, 47], fill=(24, 20, 30, 255))
    d.rectangle([0, 0, 47, 47], outline=INK)
    d.rectangle([1, 1, 46, 46], outline=SLATE)
    d.line([(1, 1), (46, 1)], fill=INK)                  # inset = dark top edge
    d.line([(1, 1), (1, 46)], fill=INK)
    d.line([(1, 46), (46, 46)], fill=PANEL_HI)
    d.line([(46, 1), (46, 46)], fill=PANEL_HI)
    save(im, "ui/panels/ui_panel_9slice_inset.png")

    im, d = img(96, 24)                                  # header strip
    d.rectangle([0, 0, 95, 23], fill=VOID)
    d.rectangle([0, 0, 95, 23], outline=INK)
    d.line([(0, 23), (95, 23)], fill=VIOLET)
    d.line([(2, 2), (93, 2)], fill=(99, 64, 158, 120))
    for x in range(4, 92, 8):                            # filed-record notches
        d.point((x, 21), VIOLET_HI)
    save(im, "ui/panels/ui_panel_header_strip.png")


# --------------------------------------------------------------------------
# 11. Item rarity frames + inventory cells (M6)
# --------------------------------------------------------------------------

RARITY = {
    "common":    GREY,
    "uncommon":  VERDIGRIS,
    "rare":      (78, 116, 190, 255),
    "epic":      VIOLET_HI,
    "legendary": ORANGE,
}


def item_frames():
    for name, col in RARITY.items():
        im, d = img(72, 72)
        bevel_box(d, 0, 0, 71, 71, PANEL, col, INK)
        d.rectangle([3, 3, 68, 68], outline=INK)
        corner_ticks(d, 1, 1, 70, 70, col, n=4)
        if name in ("epic", "legendary"):
            d.rectangle([2, 2, 69, 69], outline=col)
        save(im, f"ui/chrome/ui_item_frame_{name}.png")

    for name, fill, edge in (("empty", (28, 24, 34, 255), SLATE),
                             ("hover", (44, 38, 52, 255), GOLD)):
        im, d = img(40, 40)
        d.rectangle([0, 0, 39, 39], fill=fill)
        d.rectangle([0, 0, 39, 39], outline=INK)
        d.rectangle([1, 1, 38, 38], outline=edge)
        save(im, f"ui/chrome/ui_inventory_cell_{name}.png")


# --------------------------------------------------------------------------
# 12. Branding — the Developer Portal requires an app icon before an Activity
#     can exist. The mark is an iron safe citing an address that does not.
# --------------------------------------------------------------------------

def emblem(size: int) -> Image.Image:
    """Drawn at 64x64 then integer-upscaled, so it stays pixel art at 1024."""
    im, d = img(64, 64)
    d.rectangle([0, 0, 63, 63], fill=VOID)
    d.rectangle([0, 0, 63, 63], outline=INK)
    d.rectangle([2, 2, 61, 61], outline=VIOLET)

    # the safe body
    d.rectangle([12, 14, 51, 53], fill=SLATE, outline=INK)
    d.rectangle([14, 16, 49, 51], outline=GREY)
    corner_ticks(d, 15, 17, 48, 50, GREY_HI, n=3)

    # the dial — an index wheel
    ring(d, 32, 34, 11, 11, SILVER)
    ring(d, 32, 34, 7, 7, GREY_HI)
    for ang in range(0, 360, 45):
        import math
        rad = math.radians(ang)
        x = 32 + int(round(9.5 * math.cos(rad)))
        y = 34 + int(round(9.5 * math.sin(rad)))
        d.point((x, y), GOLD)
    d.line([(32, 34), (32, 26)], fill=GOLD)
    d.point((32, 34), PARCHMENT)

    # the door seam + handle
    d.line([(32, 16), (32, 22)], fill=INK)
    d.line([(44, 33), (47, 33)], fill=SILVER)
    d.line([(44, 35), (47, 35)], fill=SILVER)

    # the address plate that cites nowhere — a redaction bar
    d.rectangle([18, 6, 45, 11], fill=INK, outline=VIOLET)
    d.line([(20, 8), (43, 8)], fill=VIOLET_HI)

    if size != 64:
        f = size // 64
        im = im.resize((64 * f, 64 * f), Image.NEAREST)
        if im.size[0] != size:
            im = im.resize((size, size), Image.NEAREST)
    return im


def branding():
    save(emblem(1024), "branding/innerdatum_app_icon_1024.png")

    # favicon: redraw simplified at 32 rather than downscaling 1024 (which
    # would alias the dial into noise).
    im, d = img(32, 32)
    d.rectangle([0, 0, 31, 31], fill=VOID)
    d.rectangle([4, 6, 27, 27], fill=SLATE, outline=INK)
    ring(d, 16, 17, 6, 6, SILVER)
    d.line([(16, 17), (16, 12)], fill=GOLD)
    d.rectangle([8, 2, 23, 4], fill=INK, outline=VIOLET)
    save(im, "branding/favicon_32.png")

    # cover: 1024x1024, emblem on a void field with a rule line.
    cover = Image.new("RGBA", (1024, 1024), VOID)
    cd = ImageDraw.Draw(cover)
    for y in range(0, 1024, 64):                          # faint filing grid
        cd.line([(0, y), (1024, y)], fill=(99, 64, 158, 26))
    for x in range(0, 1024, 64):
        cd.line([(x, 0), (x, 1024)], fill=(99, 64, 158, 26))
    em = emblem(640)
    cover.alpha_composite(em, (192, 132))
    cd.rectangle([160, 100, 863, 875], outline=(99, 64, 158, 160))
    cd.rectangle([176, 820, 847, 828], fill=INK)          # the redaction rule
    cd.rectangle([176, 820, 847, 828], outline=VIOLET_HI)
    save(cover, "branding/innerdatum_cover_1024.png")


# --------------------------------------------------------------------------
# 13. Class portraits (M3/M6) — 64x64, matching the existing five
# --------------------------------------------------------------------------

def portraits():
    src = REPO / "client" / "public" / "assets" / "characters"
    specs = {
        "the_alchemist":   ("chr_player_alchemist_s.png",   ORANGE),
        "the_cipher_clerk": ("chr_player_cipher_clerk_s.png", VIOLET_HI),
    }
    for name, (token_file, accent) in specs.items():
        im, d = img(64, 64)
        d.rectangle([0, 0, 63, 63], fill=VOID)
        # rim light, matching the existing character icons' framing
        d.rectangle([0, 0, 63, 63], outline=INK)
        d.rectangle([1, 1, 62, 62], outline=SLATE)
        d.ellipse([8, 10, 55, 57], fill=(49, 41, 56, 255), outline=accent)
        tok = src / token_file
        if tok.exists():
            t = Image.open(tok).convert("RGBA")
            # 24x32 -> x2 = 48x64; crop the head/torso and centre it.
            big = t.resize((48, 64), Image.NEAREST).crop((0, 0, 48, 48))
            im.alpha_composite(big, (8, 12))
        corner_ticks(d, 2, 2, 61, 61, accent, n=4)
        save(im, f"ui/icons/characters/icon_character_{name}.png")


# --------------------------------------------------------------------------

BUILDERS = [
    token_rings, turn_chips, status_badges, speaking, hotbar, pips,
    cursors, tile_markers, map_markers, panels, item_frames, branding,
    portraits,
]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    for fn in BUILDERS:
        if args.only and args.only not in fn.__name__:
            continue
        fn()

    print(f"{len(MADE)} UI assets generated -> {OUT}")
    for m in MADE:
        print(f"  {m}")
