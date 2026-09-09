from __future__ import annotations

import copy
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import image_preflight


def make_raw_image(image: Path) -> None:
    header = bytearray(512)
    header[510:] = b"\x55\xaa"
    for index, kind in enumerate((0x0C, 0x83, 0x83, 0x82)):
        header[446 + index * 16 + 4] = kind
        struct.pack_into("<II", header, 446 + index * 16 + 8, (index + 1) * 16, 16)
    image.write_bytes(header + bytes(80 * 512 - len(header)))


def mount_command_environment(image: Path, rootfs: Path, state: Path, temporary_root: Path, boot: Path | None = None) -> dict[str, str]:
    """Fake only read-only kernel inspection; the real preflight/verifier still run."""
    tools = temporary_root / "inspection-tools"
    tools.mkdir()
    inspector = tools / "inspector"
    inspector.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "name = Path(sys.argv[0]).name\n"
        "image = Path(os.environ['TVBOX_FIXTURE_IMAGE'])\n"
        "if name == 'findmnt':\n"
        "    target = sys.argv[sys.argv.index('--mountpoint') + 1]\n"
        "    root = target == os.environ['TVBOX_FIXTURE_ROOT']\n"
        "    boot = target == os.environ.get('TVBOX_FIXTURE_BOOT')\n"
        "    print(json.dumps({'filesystems': [{'source': '/dev/loop982' if boot else '/dev/loop980' if root else '/dev/loop981', 'target': target, 'fstype': 'vfat' if boot else 'ext4', 'options': 'ro', 'fsroot': '/'}]}))\n"
        "elif name == 'losetup':\n"
        "    stat = image.stat()\n"
        "    print(json.dumps({'loopdevices': [{'name': sys.argv[-1], 'back-ino': stat.st_ino, 'back-maj:min': f'{os.major(stat.st_dev)}:{os.minor(stat.st_dev)}', 'offset': 8192 if sys.argv[-1] == '/dev/loop982' else 16384 if sys.argv[-1] == '/dev/loop980' else 24576, 'ro': True, 'sizelimit': 8192}]}))\n"
        "elif name == 'blockdev':\n"
        "    print(8192)\n"
        "else:\n"
        "    raise RuntimeError('Unexpected inspection tool')\n",
        encoding="utf-8",
    )
    inspector.chmod(0o755)
    for name in ("findmnt", "losetup", "blockdev"):
        (tools / name).symlink_to(inspector)
    return {
        **os.environ,
        "PATH": f"{tools}:{os.environ['PATH']}",
        "TVBOX_FIXTURE_IMAGE": str(image),
        "TVBOX_FIXTURE_ROOT": str(rootfs),
        "TVBOX_FIXTURE_BOOT": str(boot) if boot is not None else "",
    }


class ImagePreflightTests(unittest.TestCase):
    def test_complete_mount_preflight_requires_boot_from_the_same_readonly_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.img"
            make_raw_image(image)
            rootfs, state, boot = (root / name for name in ("rootfs", "state", "boot"))
            for path in (rootfs, state, boot):
                path.mkdir()
            environment = mount_command_environment(image, rootfs, state, root, boot)
            command = [sys.executable, "-B", str(ROOT / "scripts/image_preflight.py"), "mounts", str(image), str(rootfs), str(state), str(boot)]
            accepted = subprocess.run(command, env=environment, text=True, capture_output=True)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            for change in ("missing-boot", "root-used-as-boot"):
                with self.subTest(change=change):
                    rejected_command = command[:-1] if change == "missing-boot" else [*command[:-1], str(rootfs)]
                    rejected = subprocess.run(rejected_command, env=environment, text=True, capture_output=True)
                    self.assertNotEqual(rejected.returncode, 0)

    def test_manufacturing_requires_complete_receipt_before_inspecting_any_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.img"
            make_raw_image(image)
            rejected = subprocess.run(
                ["sh", str(ROOT / "scripts/manufacture.sh"), str(image), "/dev/not-a-real-device", str(root / "verification")],
                text=True, capture_output=True,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("Image verification failed", rejected.stderr)
            self.assertNotIn("unsupported manufacturing target", rejected.stderr)

    def test_raw_image_layout_and_compression_are_checked_before_any_device_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "image.img"
            make_raw_image(image)
            self.assertEqual(image_preflight.raw_image_partitions(image)[1], image_preflight.Partition(16384, 8192))
            for magic in (b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd", b"\x1f\x8b", b"PK\x03\x04"):
                image.write_bytes(magic + bytes(512))
                rejected = subprocess.run(
                    ["sh", str(ROOT / "scripts/manufacture.sh"), str(image), "/dev/not-a-real-device", str(Path(directory) / "verification")],
                    text=True, capture_output=True, check=False,
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("Compressed image supplied", rejected.stderr)

    def test_rejects_truncation_overlaps_and_non_appliance_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "image.img"
            for mutation in ("truncated", "overlap", "partition-type", "signature"):
                with self.subTest(mutation=mutation):
                    make_raw_image(image)
                    content = bytearray(image.read_bytes())
                    if mutation == "truncated":
                        content = content[:1024]
                    elif mutation == "overlap":
                        struct.pack_into("<I", content, 446 + 16 + 8, 16)
                    elif mutation == "partition-type":
                        content[446 + 32 + 4] = 0x82
                    else:
                        content[510:] = bytes(len(content) - 510)
                    image.write_bytes(content)
                    with self.assertRaises(ValueError):
                        image_preflight.raw_image_partitions(image)

    def test_mount_requires_exact_readonly_image_and_expected_partition(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.img"
            make_raw_image(image)
            mount = root / "rootfs"
            mount.mkdir()
            stat = image.stat()
            filesystem = {"source": "/dev/loop980", "target": str(mount), "fstype": "ext4", "options": "ro,relatime", "fsroot": "/"}
            loop = {"name": "/dev/loop980", "back-ino": stat.st_ino, "back-maj:min": f"{os.major(stat.st_dev)}:{os.minor(stat.st_dev)}", "offset": 16384, "ro": True, "sizelimit": 8192}
            expected = image_preflight.Partition(16384, 8192)

            def verify(fs: dict, device: dict) -> None:
                with patch.object(image_preflight, "read_json", side_effect=[{"filesystems": [fs]}, {"loopdevices": [device]}]), patch.object(
                    image_preflight.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "8192\n", ""),
                ):
                    image_preflight.verify_mount(image, mount, expected)

            verify(filesystem, loop)
            for location, field, value in (
                ("fs", "options", "rw,relatime"), ("fs", "fsroot", "/subdir"),
                ("fs", "fstype", "vfat"), ("fs", "target", str(root)),
                ("fs", "source", "/dev/sda2"),
                ("loop", "ro", False), ("loop", "back-ino", stat.st_ino + 1),
                ("loop", "back-maj:min", "999:999"), ("loop", "offset", 24576),
                ("loop", "sizelimit", 4096),
            ):
                with self.subTest(field=field, value=value):
                    fs, device = copy.deepcopy(filesystem), copy.deepcopy(loop)
                    (fs if location == "fs" else device)[field] = value
                    with self.assertRaises(ValueError):
                        verify(fs, device)

    def test_verifier_does_not_accept_plain_directories_as_image_mounts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.img"
            make_raw_image(image)
            rootfs, state, boot = root / "rootfs", root / "state", root / "boot"
            rootfs.mkdir()
            state.mkdir()
            boot.mkdir()
            manifest = root / "manifest"
            manifest.write_text("fixture\t1\n", encoding="utf-8")
            result = subprocess.run(
                ["sh", str(ROOT / "scripts/verify-image.sh"), str(image), str(rootfs), str(state), str(boot), str(manifest), str(root / "verification")],
                text=True, capture_output=True, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Image preflight failed", result.stderr)
            self.assertFalse((root / "verification").exists())


if __name__ == "__main__":
    unittest.main()
