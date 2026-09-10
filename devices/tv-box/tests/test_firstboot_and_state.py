from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from hexclave_tv_box.firstboot import apply_system_hostname, initialize_device
from hexclave_tv_box.state import atomic_write, clear_exact_state_directory, require_exact_child


class FirstBootTests(unittest.TestCase):
    def test_initialization_is_unique_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / "state"

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            first = initialize_device(state_root, fake_keygen, "a" * 32, relay_group=None)
            second = initialize_device(state_root, fake_keygen, "a" * 32, relay_group=None)
            self.assertEqual(first, second)
            self.assertRegex(first["device_id"], r"^[0-9a-f-]{36}$")
            self.assertTrue(first["hostname"].startswith("hexclave-tv-"))
            self.assertEqual((state_root / "ssh" / "ssh_host_ed25519_key").stat().st_mode & 0o777, 0o600)
            self.assertEqual((state_root / "firstboot-state" / "complete").read_text(encoding="utf-8"), "complete\n")

    def test_system_hostname_writes_only_the_expected_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            system_root = Path(directory)
            (system_root / "etc").mkdir()
            (system_root / "etc/hostname").write_text("image-default\n", encoding="utf-8")
            (system_root / "etc/hosts").write_text(
                "127.0.0.1\tlocalhost\n127.0.1.1\timage-default\n192.0.2.10\tkeep.example\n",
                encoding="utf-8",
            )
            identity = {"device_id": "unused", "machine_id": "a" * 32, "hostname": "hexclave-tv-abcdef"}
            apply_system_hostname(identity, system_root)
            apply_system_hostname(identity, system_root)
            self.assertEqual((system_root / "etc" / "hostname").read_text(encoding="utf-8"), "hexclave-tv-abcdef\n")
            self.assertEqual(
                (system_root / "etc" / "hosts").read_text(encoding="utf-8"),
                "127.0.0.1\tlocalhost\n127.0.1.1\thexclave-tv-abcdef\n192.0.2.10\tkeep.example\n",
            )

    def test_system_hostname_refuses_a_linked_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            system_root = Path(directory)
            (system_root / "etc").mkdir()
            outside = system_root / "outside"
            outside.write_text("keep\n", encoding="utf-8")
            (system_root / "etc/hostname").symlink_to(outside)
            identity = {"device_id": "unused", "machine_id": "a" * 32, "hostname": "hexclave-tv-abcdef"}
            with self.assertRaises(OSError):
                apply_system_hostname(identity, system_root)
            self.assertEqual(outside.read_text(encoding="utf-8"), "keep\n")

    def test_system_hostname_refuses_a_linked_hosts_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            system_root = Path(directory)
            (system_root / "etc").mkdir()
            (system_root / "etc/hostname").write_text("image-default\n", encoding="utf-8")
            outside = system_root / "outside"
            outside.write_text("127.0.0.1\tkeep\n", encoding="utf-8")
            (system_root / "etc/hosts").symlink_to(outside)
            identity = {"device_id": "unused", "machine_id": "a" * 32, "hostname": "hexclave-tv-abcdef"}
            with self.assertRaises(OSError):
                apply_system_hostname(identity, system_root)
            self.assertEqual(outside.read_text(encoding="utf-8"), "127.0.0.1\tkeep\n")

    def test_exact_state_clear_cannot_escape_or_remove_siblings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            browser = root / "browser"
            sibling = root / "ssh"
            browser.mkdir(parents=True)
            sibling.mkdir()
            (browser / "cookies.sqlite").write_text("secret", encoding="utf-8")
            (sibling / "host-key").write_text("keep", encoding="utf-8")
            browser_inode = browser.stat().st_ino
            clear_exact_state_directory(root, "browser")
            self.assertEqual(list(browser.iterdir()), [])
            self.assertEqual(browser.stat().st_ino, browser_inode)
            self.assertEqual((sibling / "host-key").read_text(encoding="utf-8"), "keep")
            with self.assertRaisesRegex(ValueError, "exact TV Box state target"):
                clear_exact_state_directory(root, "../ssh")

    def test_exact_state_clear_rejects_a_symlink_to_a_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            ssh = root / "ssh"
            ssh.mkdir(parents=True)
            (ssh / "host-key").write_text("keep", encoding="utf-8")
            (root / "browser").symlink_to(ssh, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "linked TV Box state target"):
                clear_exact_state_directory(root, "browser")
            self.assertEqual((ssh / "host-key").read_text(encoding="utf-8"), "keep")

    def test_state_helpers_reject_symlinked_roots_and_parents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            real_root = base / "real"
            real_root.mkdir()
            linked_root = base / "linked"
            linked_root.symlink_to(real_root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "linked"):
                require_exact_child(linked_root / "browser", linked_root, "browser")

            parent = base / "parent"
            target = base / "target"
            target.mkdir()
            parent.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "directory"):
                atomic_write(parent / "value", "secret")

            nested_parent = base / "nested"
            nested_parent.mkdir()
            (nested_parent / "linked").symlink_to(target, target_is_directory=True)
            (target / "child").mkdir()
            escaped_path = nested_parent / "linked" / "child" / "value"
            with self.assertRaisesRegex(ValueError, "directory"):
                atomic_write(escaped_path, "secret")
            self.assertFalse((target / "child" / "value").exists())
            with self.assertRaisesRegex(ValueError, "linked"):
                require_exact_child(nested_parent / "linked" / "browser", nested_parent, "browser")

    def test_exact_state_clear_unlinks_child_symlinks_without_following_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            browser = root / "browser"
            outside = Path(directory) / "outside"
            browser.mkdir(parents=True)
            outside.mkdir()
            (outside / "keep").write_text("keep", encoding="utf-8")
            (browser / "linked").symlink_to(outside, target_is_directory=True)
            clear_exact_state_directory(root, "browser")
            self.assertEqual(list(browser.iterdir()), [])
            self.assertEqual((outside / "keep").read_text(encoding="utf-8"), "keep")

    def test_initialization_rejects_a_different_persisted_machine_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / "state"

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            initialize_device(state_root, fake_keygen, "a" * 32, relay_group=None)
            with self.assertRaisesRegex(RuntimeError, "do not match"):
                initialize_device(state_root, fake_keygen, "b" * 32, relay_group=None)

    def test_initialization_rejects_state_child_symlink_without_writing_through_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_root = root / "state"
            state_root.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (state_root / "identity").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                initialize_device(state_root, lambda _command: None, "a" * 32, relay_group=None)
            self.assertEqual(list(outside.iterdir()), [])

    def test_initialization_creates_and_validates_relay_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_root = root / "state"

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            initialize_device(state_root, fake_keygen, "a" * 32, relay_group=None)
            relay = state_root / "relay"
            self.assertEqual(relay.stat().st_mode & 0o777, 0o750)
            self.assertEqual(relay.stat().st_uid, os.getuid())

            outside = root / "outside"
            outside.mkdir()
            relay.rmdir()
            relay.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                initialize_device(state_root, fake_keygen, "a" * 32, relay_group=None)
            self.assertEqual(list(outside.iterdir()), [])

    def test_hosts_update_preserves_aliases_comments_and_other_managed_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            system_root = Path(directory)
            (system_root / "etc").mkdir()
            (system_root / "etc/hostname").write_text("image-default\n", encoding="utf-8")
            (system_root / "etc/hosts").write_text(
                "127.0.1.1\timage-default alias.example # keep this comment\n"
                "127.0.1.1 other-name other-alias\n",
                encoding="utf-8",
            )
            identity = {"device_id": "unused", "machine_id": "a" * 32, "hostname": "hexclave-tv-abcdef"}
            apply_system_hostname(identity, system_root)
            self.assertEqual(
                (system_root / "etc/hosts").read_text(encoding="utf-8"),
                "127.0.1.1\thexclave-tv-abcdef\talias.example # keep this comment\n"
                "127.0.1.1 other-name other-alias\n",
            )

if __name__ == "__main__":
    unittest.main()
