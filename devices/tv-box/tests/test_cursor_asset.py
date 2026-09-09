from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/cursor_asset.py"
SPEC = importlib.util.spec_from_file_location("cursor_asset", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cursor asset module is unavailable.")
cursor_asset = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cursor_asset)


class CursorAssetTests(unittest.TestCase):
    def test_one_valid_transparent_frame_with_no_animation(self) -> None:
        data = cursor_asset.transparent_cursor()
        self.assertEqual(struct.unpack("<4I", data[:16]), (0x72756358, 16, 0x10000, 1))
        self.assertEqual(struct.unpack("<3I", data[16:28]), (0xFFFD0002, 32, 28))
        self.assertEqual(struct.unpack("<9I", data[28:64]), (36, 0xFFFD0002, 32, 1, 32, 32, 0, 0, 0))
        self.assertEqual(data[64:], bytes(4096))

    def test_install_is_deterministic_and_detects_missing_or_changed_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / cursor_asset.CURSOR_PATH
            with self.assertRaises(ValueError):
                cursor_asset.verify_cursor(target)
            cursor_asset.install_cursor(root)
            first = target.read_bytes()
            cursor_asset.install_cursor(root)
            self.assertEqual(target.read_bytes(), first)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            target.write_bytes(first[:-1] + b"\xff")
            with self.assertRaises(ValueError):
                cursor_asset.install_cursor(root)

    def test_install_refuses_escaping_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            outside = Path(directory) / "outside"
            outside.mkdir()
            (root / "usr").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                cursor_asset.install_cursor(root)
            self.assertEqual(list(outside.iterdir()), [])

    def test_private_cursor_policy_only_applies_to_appliance_launcher(self) -> None:
        tv_root = SCRIPT.parents[1]
        launcher = (tv_root / "image/rootfs/usr/lib/hexclave-tv-box/kiosk-launch").read_text()
        self.assertIn("export XCURSOR_PATH=/usr/share/hexclave-tv-box/cursors", launcher)
        self.assertIn('! -s "$XCURSOR_PATH/default/cursors/left_ptr"', launcher)
        layer = (tv_root / "image/layer/hexclave-tv-box-pilot.yaml").read_text()
        self.assertIn('scripts/cursor_asset.py" install "$1"', layer)


if __name__ == "__main__":
    unittest.main()
