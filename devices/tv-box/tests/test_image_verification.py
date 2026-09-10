from __future__ import annotations

import base64
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import image_verification


def fixture_public_key() -> str:
    key_type = b"ssh-ed25519"
    payload = struct.pack(">I", len(key_type)) + key_type + struct.pack(">I", 32) + bytes(range(32))
    return f"ssh-ed25519 {base64.b64encode(payload).decode('ascii')} qualification-fixture\n"


def make_verification_fixture(rootfs: Path, manifest: Path, channel: str = "production") -> None:
    policy = json.loads(image_verification.POLICY.read_text(encoding="utf-8"))
    files = {
        "etc/os-release": "".join(f'{key}="{value}"\n' for key, value in policy["os"].items()),
        "etc/hexclave-tv-box-release": f"image-channel={channel}\nsource-commit={'a' * 40}\n",
        "var/lib/dpkg/arch": "armhf\n",
        "var/lib/dpkg/status": "\n\n".join(f"Package: {name}\nStatus: install ok installed\nArchitecture: armhf\nVersion: {version}" for name, version in policy["packages"].items()) + "\n",
        "etc/ssh/hexclave-support-ca.pub": fixture_public_key(),
    }
    for relative, content in files.items():
        path = rootfs / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    manifest.write_text("".join(f"{name}\t{version}\n" for name, version in policy["packages"].items()), encoding="utf-8")


class ImageVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(suffix=".untracked")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.rootfs, self.state, self.boot = (self.root / name for name in ("rootfs", "state", "boot"))
        for path in (self.rootfs, self.state, self.boot):
            path.mkdir()
        self.manifest = self.root / "manifest"
        make_verification_fixture(self.rootfs, self.manifest)

    def test_qualified_inventory_is_exact_and_rejects_wrong_os_arch_or_package_version(self) -> None:
        actual = image_verification.verify_runtime(self.rootfs)
        self.assertEqual(actual["cog"], ("0.18.4-1", "armhf"))
        for relative, before, after in (
            ("etc/os-release", "raspbian", "debian"),
            ("var/lib/dpkg/arch", "armhf", "arm64"),
            ("var/lib/dpkg/status", "0.18.4-1", "0.18.5-1"),
            ("var/lib/dpkg/status", "Architecture: armhf", "Architecture: arm64"),
        ):
            with self.subTest(relative=relative):
                path = self.rootfs / relative
                original = path.read_text(encoding="utf-8")
                path.write_text(original.replace(before, after), encoding="utf-8")
                with self.assertRaises(ValueError):
                    image_verification.verify_runtime(self.rootfs)
                path.write_text(original, encoding="utf-8")

    def test_dpkg_rejects_ambiguous_duplicate_and_not_installed_packages(self) -> None:
        path = self.rootfs / "var/lib/dpkg/status"
        original = path.read_text(encoding="utf-8")
        path.write_text(original + "\nPackage: cog\nStatus: install ok installed\nArchitecture: arm64\nVersion: 1\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            image_verification.installed_packages(self.rootfs)
        path.write_text(original.replace("Status: install ok installed", "Status: deinstall ok config-files"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "empty"):
            image_verification.installed_packages(self.rootfs)

    def test_image_absolute_symlinks_resolve_inside_image_and_cycles_fail(self) -> None:
        release = self.rootfs / "etc/os-release"
        target = self.rootfs / "usr/lib/os-release"
        target.parent.mkdir(parents=True)
        target.write_bytes(release.read_bytes())
        release.unlink()
        release.symlink_to("/usr/lib/os-release")
        self.assertEqual(image_verification.image_path(self.rootfs, "etc/os-release"), target)
        image_verification.verify_runtime(self.rootfs)
        target.unlink()
        target.symlink_to("/etc/os-release")
        with self.assertRaisesRegex(ValueError, "cycle"):
            image_verification.image_path(self.rootfs, "etc/os-release")
        with self.assertRaisesRegex(ValueError, "escapes"):
            image_verification.image_path(self.rootfs, "../../etc/shadow")

    def test_legacy_paths_reject_host_symlink_before_shell_inspection(self) -> None:
        inspected = Path("etc/ssh/hexclave-support-ca.pub")
        image_verification.verify_legacy_paths(self.rootfs, inspected)
        key = self.rootfs / inspected
        key.unlink()
        key.symlink_to("/etc/shadow")
        with self.assertRaisesRegex(ValueError, "forbidden symlink"):
            image_verification.verify_legacy_paths(self.rootfs, inspected)
        key.unlink()
        (self.rootfs / "etc/ssh").rmdir()
        (self.rootfs / "etc/ssh").symlink_to("/etc/ssh", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "forbidden symlink"):
            image_verification.verify_legacy_paths(self.rootfs, inspected)

    def test_strict_single_public_key_rejects_extra_material_and_bad_encoding(self) -> None:
        path = self.root / "ca.pub"
        path.write_text(fixture_public_key(), encoding="ascii")
        image_verification.validate_public_key(path)
        for content in (
            fixture_public_key() + fixture_public_key(), fixture_public_key() + "\n",
            fixture_public_key() + "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n",
            "ssh-ed25519 AAAA invalid\n", "ssh-rsa " + fixture_public_key().split()[1] + "\n",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPilotPublicKeyMaterial fixture\n",
        ):
            path.write_text(content, encoding="ascii")
            with self.subTest(content_length=len(content)), self.assertRaises(ValueError):
                image_verification.validate_public_key(path)

    def test_builder_inventory_rejects_duplicates_and_drift(self) -> None:
        packages = image_verification.builder_packages(self.manifest)
        self.assertEqual(packages["cog"], "0.18.4-1")
        self.manifest.write_text("cog\t1\ncog\t2\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            image_verification.builder_packages(self.manifest)

    def test_secret_scan_detects_private_keys_credentials_and_boot_test_origin_without_values(self) -> None:
        for name, content in (
            ("arbitrary.txt", b"-----BEGIN OPENSSH PRIVATE KEY-----\nDO-NOT-PRINT-SECRET\n"),
            ("saved.nmconnection", b"DO-NOT-PRINT-SECRET"),
            ("operator-cert.pub", b"DO-NOT-PRINT-SECRET"),
            ("cookies.sqlite", b"DO-NOT-PRINT-SECRET"),
            (".env.local", b"DO-NOT-PRINT-SECRET"),
            ("hexclave-tv-box-test-origin.txt", b"DO-NOT-PRINT-SECRET"),
        ):
            path = self.boot / name
            path.write_bytes(content)
            with self.subTest(name=name), self.assertRaises(ValueError) as rejected:
                image_verification.scan_clean_filesystem(self.boot, "boot", production=True)
            self.assertNotIn("DO-NOT-PRINT-SECRET", str(rejected.exception))
            path.unlink()

    def test_secret_scan_checks_chunk_boundaries_does_not_follow_symlinks_and_allows_public_trust(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "key").write_bytes(b"-----BEGIN PRIVATE KEY-----\nSECRET\n")
        (self.boot / "external").symlink_to(outside, target_is_directory=True)
        (self.boot / "public-ca.pub").write_text(fixture_public_key(), encoding="ascii")
        image_verification.scan_clean_filesystem(self.boot, "boot", production=True)
        path = self.boot / "hidden"
        path.write_bytes(b"x" * (1024 * 1024 - 8) + b"\n-----BEGIN PRIVATE KEY-----\nSECRET\n")
        with self.assertRaisesRegex(ValueError, "Private-key"):
            image_verification.scan_clean_filesystem(self.boot, "boot", production=True)

    def certificate_record(self) -> bytes:
        ca, operator = self.root / "ca.untracked", self.root / "operator.untracked"
        for key in (ca, operator):
            subprocess.run(
                ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(key)],
                check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
            )
        subprocess.run(
            ["ssh-keygen", "-q", "-s", str(ca), "-I", "do-not-export-fixture-identity",
             "-n", "hexclave-tv-support", "-V", "-1m:+5m", str(operator) + ".pub"],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
        )
        return (self.root / "operator.untracked-cert.pub").read_bytes()

    def test_renamed_certificate_records_are_rejected_on_every_image_filesystem_without_values(self) -> None:
        certificate = self.certificate_record()
        for filesystem, label in ((self.rootfs, "root"), (self.state, "state"), (self.boot, "boot")):
            path = filesystem / "support-material.untracked.txt"
            path.write_bytes(certificate)
            with self.subTest(filesystem=label), self.assertRaisesRegex(ValueError, "OpenSSH certificate") as rejected:
                image_verification.scan_clean_filesystem(filesystem, label, production=True)
            self.assertNotIn(certificate.split()[1].decode("ascii"), str(rejected.exception))
            self.assertNotIn("do-not-export-fixture-identity", str(rejected.exception))
            path.unlink()

    def test_certificate_records_are_detected_across_chunk_boundaries(self) -> None:
        certificate = self.certificate_record()
        path = self.boot / "support-material.untracked.txt"
        for split in (1, 24, 48, 80, 127):
            path.write_bytes(b"x" * (1024 * 1024 - split - 1) + b"\n" + certificate)
            with self.subTest(split=split), self.assertRaisesRegex(ValueError, "OpenSSH certificate"):
                image_verification.scan_clean_filesystem(self.boot, "boot", production=True)

    def test_certificate_algorithm_mentions_and_regular_public_ca_keys_remain_allowed(self) -> None:
        certificate = self.certificate_record()
        algorithm = certificate.split()[0]
        path = self.boot / "algorithm-documentation.untracked.txt"
        path.write_bytes(
            b"Supported algorithm: " + algorithm + b"\n"
            + algorithm + b"\n" + algorithm + b" AAAA example\n"
            + b"\x00" + algorithm + b"\x00" + certificate.split()[1] + b"\x00"
        )
        (self.boot / "support-ca.untracked.pub").write_bytes((self.root / "ca.untracked.pub").read_bytes())
        image_verification.scan_clean_filesystem(self.boot, "boot", production=True)
        # A retained chunk tail must not reinterpret inline documentation as
        # a line-start record just because it begins at the overlap boundary.
        path.write_bytes(b"x" * (1024 * 1024 - 512) + certificate)
        image_verification.scan_clean_filesystem(self.boot, "boot", production=True)

    def test_public_test_vector_exception_requires_exact_path_bytes_and_root_filesystem(self) -> None:
        path = self.rootfs / "public-fixture.py"
        path.write_bytes(b"-----BEGIN PRIVATE KEY-----\npublic-test-vector\n")
        with patch.object(image_verification.json, "loads", return_value={"public_test_vectors": {
            "public-fixture.py": {"sha256": image_verification.digest(path)},
        }}):
            image_verification.scan_clean_filesystem(self.rootfs, "root", production=True)
            with self.assertRaises(ValueError):
                image_verification.scan_clean_filesystem(self.rootfs, "boot", production=True)
            path.write_bytes(path.read_bytes() + b"unknown-extra-material")
            with self.assertRaises(ValueError):
                image_verification.scan_clean_filesystem(self.rootfs, "root", production=True)

    def test_rerun_invalidates_only_its_generated_receipt_and_rejects_unsafe_output(self) -> None:
        output = self.root / "verification"
        image_verification.begin_output(output, self.rootfs, self.state, self.boot, self.manifest)
        self.assertFalse(output.exists())
        output.mkdir()
        receipt = output / "verification.json"
        receipt.write_text('{"schema_version":1,"result":"passed"}', encoding="utf-8")
        unrelated = output / "keep-evidence.txt"
        unrelated.write_text("keep", encoding="utf-8")
        image_verification.begin_output(output, self.rootfs, self.state, self.boot, self.manifest)
        self.assertFalse(receipt.exists())
        self.assertEqual(unrelated.read_text(), "keep")
        with self.assertRaises(ValueError):
            image_verification.begin_output(self.boot / "verification", self.rootfs, self.state, self.boot, self.manifest)
        receipt.symlink_to(unrelated)
        with self.assertRaises(ValueError):
            image_verification.begin_output(output, self.rootfs, self.state, self.boot, self.manifest)
        self.assertEqual(unrelated.read_text(), "keep")
        receipt.unlink()
        (output / "rootfs-sha256.txt").symlink_to(unrelated)
        with self.assertRaises(ValueError):
            image_verification.begin_output(output, self.rootfs, self.state, self.boot, self.manifest)
        self.assertEqual(unrelated.read_text(), "keep")

    def test_test_marker_allowed_only_for_test_image(self) -> None:
        (self.rootfs / "etc/hexclave-tv-box-test-image").write_text("test\n", encoding="ascii")
        image_verification.scan_clean_filesystem(self.rootfs, "root", production=False)
        with self.assertRaises(ValueError):
            image_verification.scan_clean_filesystem(self.rootfs, "root", production=True)

    def test_receipt_binds_raw_image_inventory_and_policy_and_rejects_tampering(self) -> None:
        output, image = self.root / "verification", self.root / "image.img"
        output.mkdir()
        image.write_bytes(b"fixture-raw-image")
        for name in ("image-manifest.txt", "rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt", "disk-image-sha256.txt"):
            (output / name).write_text("fixture\n", encoding="ascii")
        image_verification.verify_final(self.rootfs, self.state, self.boot, self.manifest, output, image)
        image_verification.verify_receipt(image, output)
        receipt = json.loads((output / "verification.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["builder_source_sha256"], image_verification.digest(self.manifest))
        self.assertEqual(receipt["qualified_builder_commit"], json.loads(image_verification.POLICY.read_text())["image_builder_commit"])
        receipt_file = output / "verification.json"
        original_receipt = receipt_file.read_bytes()
        receipt["image_channel"] = "test"
        receipt_file.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "production-channel"):
            image_verification.verify_receipt(image, output)
        receipt_file.write_bytes(original_receipt)
        package_file = output / "packages.tsv"
        original = package_file.read_bytes()
        package_file.write_bytes(original + b"extra\t1\tarmhf\n")
        with self.assertRaisesRegex(ValueError, "artifact checksum"):
            image_verification.verify_receipt(image, output)
        package_file.write_bytes(original)
        image.write_bytes(b"changed-raw-image")
        with self.assertRaisesRegex(ValueError, "receipt"):
            image_verification.verify_receipt(image, output)

    def test_inventory_mismatch_prevents_receipt_creation(self) -> None:
        output, image = self.root / "verification", self.root / "image.img"
        image.write_bytes(b"fixture")
        self.manifest.write_text("cog\tincorrect\n", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            image_verification.verify_final(self.rootfs, self.state, self.boot, self.manifest, output, image)
        self.assertFalse((output / "verification.json").exists())

    def test_readback_requires_every_image_byte_and_ignores_unused_card_tail(self) -> None:
        image, target = self.root / "image.img", self.root / "card"
        image.write_bytes(b"qualified-image")
        output = self.root / "verification"
        output.mkdir()
        for name in ("image-manifest.txt", "rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt", "disk-image-sha256.txt"):
            (output / name).write_text("fixture\n", encoding="ascii")
        image_verification.verify_final(self.rootfs, self.state, self.boot, self.manifest, output, image)
        target.write_bytes(image.read_bytes() + b"unused-card-space")
        command = [sys.executable, "-B", str(ROOT / "scripts/image_verification.py"), "readback", str(output), str(target)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        target.write_bytes(b"wrong-image" + b"unused-card-space")
        rejected = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("read-back checksum mismatch", rejected.stderr)
        target.write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "ended before"):
            image_verification.digest(target, image.stat().st_size)

    def test_readback_verifies_against_receipt_not_current_image_file(self) -> None:
        output, image, target = (self.root / name for name in ("verification", "image.img", "card"))
        original = b"qualified-image"
        swapped = b"swapped-image!"
        image.write_bytes(original)
        output.mkdir()
        for name in ("image-manifest.txt", "rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt", "disk-image-sha256.txt"):
            (output / name).write_text("fixture\n", encoding="ascii")
        image_verification.verify_final(self.rootfs, self.state, self.boot, self.manifest, output, image)
        target.write_bytes(original + b"unused-card-space")
        image.write_bytes(swapped)
        image_verification.verify_readback(output, target)

        target.write_bytes(swapped + b"unused-card-space")
        with self.assertRaisesRegex(ValueError, "read-back checksum mismatch"):
            image_verification.verify_readback(output, target)

        receipt_file = output / "verification.json"
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        del receipt["image_bytes"]
        receipt_file.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "missing the image extent"):
            image_verification.verify_readback(output, target)

if __name__ == "__main__":
    unittest.main()
