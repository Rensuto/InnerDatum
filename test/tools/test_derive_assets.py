from __future__ import annotations

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "inner_datum_derive_assets", REPO / "tools" / "derive_assets.py"
)
assert SPEC is not None and SPEC.loader is not None
derive_assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(derive_assets)


class DeriveAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="derive-assets-test-")
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.deployed = self.root / "deployed"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def source_image(self, rel: str, size: tuple[int, int]) -> Path:
        path = self.source / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", size, (0, 0, 0, 0)).save(path)
        return path

    def run_main(self, *args: str) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            derive_assets.main(list(args))

    def test_eidolon_uses_its_explicit_64_pixel_frame(self) -> None:
        source = self.source_image(
            "sprites/enemies/enemy_index_eidolon_s.png", (384, 64)
        )
        image = Image.open(source).convert("RGBA")
        # The real frame has transparent staging margins. Put a distinctive
        # right-edge detail inside the approved centered 48px source envelope,
        # and a different colour at the start of frame two.
        for y in range(64):
            for x in range(15, 55):
                image.putpixel((x, y), (20, 30, 40, 255))
            image.putpixel((54, y), (220, 120, 20, 255))
            image.putpixel((64, y), (10, 200, 240, 255))
        image.save(source)

        self.run_main("--src", str(self.source), "--out", str(self.deployed))

        result = Image.open(
            self.deployed / "enemies" / "enemy_index_eidolon_s.png"
        ).convert("RGBA")
        self.assertEqual(result.size, (96, 128))
        self.assertEqual(result.getpixel((92, 40)), (220, 120, 20, 255))
        self.assertEqual(result.getpixel((93, 40)), (220, 120, 20, 255))
        self.assertEqual(result.getpixel((94, 40)), (0, 0, 0, 0))

    def test_check_builds_elsewhere_and_does_not_overwrite_deployment(self) -> None:
        source = self.source_image(
            "sprites/enemies/enemy_index_wraith_s.png", (144, 32)
        )
        Image.new("RGBA", (144, 32), (40, 50, 60, 255)).save(source)
        self.run_main("--src", str(self.source), "--out", str(self.deployed))

        deployed = self.deployed / "enemies" / "enemy_index_wraith_s.png"
        before = deployed.read_bytes()
        Image.new("RGBA", (144, 32), (90, 100, 110, 255)).save(source)

        with self.assertRaisesRegex(SystemExit, "deployed outputs differ"):
            self.run_main(
                "--src",
                str(self.source),
                "--out",
                str(self.deployed),
                "--check",
            )

        self.assertEqual(deployed.read_bytes(), before)

    def test_downed_pose_uses_the_unscaled_standing_token(self) -> None:
        source = self.source_image(
            "sprites/characters/player/chr_player_watchman_s.png", (144, 32)
        )
        image = Image.open(source).convert("RGBA")
        colours = (
            (180, 20, 30, 255),
            (30, 160, 60, 255),
            (40, 80, 190, 255),
            (220, 180, 40, 255),
        )
        for y in range(32):
            for x in range(24):
                image.putpixel((x, y), colours[(x >= 12) + 2 * (y >= 16)])
        image.save(source)

        self.run_main("--src", str(self.source), "--out", str(self.deployed))

        original = derive_assets.frame0_south(source)
        expected = derive_assets.to_cell(
            derive_assets.prone(original),
            "characters/chr_player_watchman_downed_s.png",
        )
        actual = Image.open(
            self.deployed / "characters" / "chr_player_watchman_downed_s.png"
        ).convert("RGBA")
        self.assertEqual(actual.size, (64, 48))
        self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_runtime_save_preserves_an_installed_native_map_sprite(self) -> None:
        rel = "characters/chr_player_watchman_s.png"
        deployed = self.deployed / rel
        deployed.parent.mkdir(parents=True, exist_ok=True)
        native = Image.new("RGBA", (48, 64), (0, 0, 0, 0))
        # Deliberately break 2x repetition while remaining valid native pixels.
        for y in range(8, 62):
            for x in range(9, 39):
                native.putpixel((x, y), ((x * 17) % 255, (y * 11) % 255, 90, 255))
        native.save(deployed)
        before = deployed.read_bytes()

        old_out = derive_assets.OUT
        derive_assets.OUT = self.deployed
        try:
            legacy = Image.new("RGBA", (24, 32), (120, 80, 40, 255))
            derive_assets.save(legacy, rel, self.deployed)
        finally:
            derive_assets.OUT = old_out

        self.assertEqual(deployed.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
