from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "inner_datum_gen_content_assets", REPO / "tools" / "gen_content_assets.py"
)
assert SPEC is not None and SPEC.loader is not None
gen_content_assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen_content_assets)


class GenContentAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="gen-content-assets-test-")
        self.root = Path(self.temp.name)
        self.old_out = gen_content_assets.OUT
        self.old_made = list(gen_content_assets.MADE)
        gen_content_assets.OUT = self.root
        gen_content_assets.MADE.clear()

    def tearDown(self) -> None:
        gen_content_assets.OUT = self.old_out
        gen_content_assets.MADE[:] = self.old_made
        self.temp.cleanup()

    def test_save_preserves_installed_native_map_art(self) -> None:
        rel = "enemies/enemy_high_inquisitor_s.png"
        deployed = self.root / rel
        deployed.parent.mkdir(parents=True, exist_ok=True)
        native = Image.new("RGBA", (48, 64), (0, 0, 0, 0))
        for y in range(3, 62):
            for x in range(8, 40):
                native.putpixel((x, y), ((x * 13) % 255, (y * 19) % 255, 90, 255))
        native.save(deployed)
        before = deployed.read_bytes()

        fallback = Image.new("RGBA", (24, 32), (120, 80, 40, 255))
        gen_content_assets.save(fallback, rel)

        self.assertEqual(deployed.read_bytes(), before)

    def test_save_rebuilds_an_exact_2x_map_stand_in(self) -> None:
        rel = "props/prop_eldritch_test_01.png"
        deployed = self.root / rel
        deployed.parent.mkdir(parents=True, exist_ok=True)
        old = Image.new("RGBA", (16, 16), (20, 30, 40, 255)).resize(
            (32, 32), Image.Resampling.NEAREST
        )
        old.save(deployed)

        fallback = Image.new("RGBA", (16, 16), (90, 100, 110, 255))
        gen_content_assets.save(fallback, rel)

        rebuilt = Image.open(deployed).convert("RGBA")
        self.assertEqual(rebuilt.size, (32, 32))
        self.assertEqual(rebuilt.getpixel((0, 0)), (90, 100, 110, 255))


if __name__ == "__main__":
    unittest.main()
