from __future__ import annotations

import grp
import os
import pwd
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from hexclave_tv_box.firstboot import apply_device_permissions, apply_system_hostname, initialize_device
from hexclave_tv_box.relay import initialize_relay_identity
from hexclave_tv_box.state import atomic_write, clear_exact_state_directory, require_exact_child


class SimulatedRootOwnership:
    def __init__(self, scope: Path) -> None:
        self.scope = scope.resolve()
        self.scope_ancestors = frozenset((self.scope, *self.scope.parents))
        self.owners: dict[tuple[int, int], tuple[int, int]] = {}
        self.chowns: list[tuple[Path, int, int]] = []
        self._real_lstat = os.lstat
        self._real_stat = os.stat
        self._patches = []

    def __enter__(self) -> SimulatedRootOwnership:
        self._patches = [
            mock.patch.object(os, "geteuid", return_value=0),
            mock.patch.object(os, "lstat", side_effect=self._lstat),
            mock.patch.object(os, "stat", side_effect=self._stat),
            mock.patch.object(os, "chown", side_effect=self._chown),
        ]
        for patch in self._patches:
            patch.start()
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        for patch in reversed(self._patches):
            patch.stop()

    def _absolute_path(self, path: object) -> Path | None:
        try:
            return Path(os.path.abspath(os.fsdecode(os.fspath(path))))
        except (TypeError, ValueError):
            return None

    def _scoped_path(self, path: object) -> Path | None:
        absolute = self._absolute_path(path)
        if absolute is None:
            return None
        try:
            absolute.relative_to(self.scope)
        except ValueError:
            return None
        return absolute

    def _metadata_with_owner(self, path: object, metadata: os.stat_result) -> os.stat_result:
        absolute = self._absolute_path(path)
        if absolute is None:
            return metadata
        try:
            absolute.relative_to(self.scope)
        except ValueError:
            if absolute not in self.scope_ancestors:
                return metadata
        uid, gid = self.owners.get((metadata.st_dev, metadata.st_ino), (0, 0))
        return os.stat_result((
            metadata.st_mode,
            metadata.st_ino,
            metadata.st_dev,
            metadata.st_nlink,
            uid,
            gid,
            metadata.st_size,
            metadata.st_atime,
            metadata.st_mtime,
            metadata.st_ctime,
        ))

    def _lstat(self, path: object, *args: object, **kwargs: object) -> os.stat_result:
        return self._metadata_with_owner(path, self._real_lstat(path, *args, **kwargs))

    def _stat(self, path: object, *args: object, **kwargs: object) -> os.stat_result:
        return self._metadata_with_owner(path, self._real_stat(path, *args, **kwargs))

    def _chown(self, path: object, uid: int, gid: int, **kwargs: object) -> None:
        scoped_path = self._scoped_path(path)
        if scoped_path is None:
            raise AssertionError(f"Simulated chown escaped fixture scope: {path}")
        metadata = self._real_lstat(path)
        self.chowns.append((Path(os.fspath(path)), uid, gid))
        self.owners[(metadata.st_dev, metadata.st_ino)] = (uid, gid)

    def owner_of(self, path: Path) -> tuple[int, int]:
        metadata = self._real_lstat(path)
        default_owner = (0, 0) if self._scoped_path(path) is not None else (metadata.st_uid, metadata.st_gid)
        return self.owners.get((metadata.st_dev, metadata.st_ino), default_owner)


class FirstBootTests(unittest.TestCase):
    def test_initialization_is_unique_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / "state"

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            first = initialize_device(state_root, fake_keygen, "a" * 32)
            second = initialize_device(state_root, fake_keygen, "a" * 32)
            self.assertEqual(first, second)
            self.assertRegex(first["device_id"], r"^[0-9a-f-]{36}$")
            self.assertTrue(first["hostname"].startswith("hexclave-tv-"))
            self.assertEqual((state_root / "ssh" / "ssh_host_ed25519_key").stat().st_mode & 0o777, 0o600)
            self.assertEqual((state_root / "firstboot-state" / "complete").read_text(encoding="utf-8"), "complete\n")

    @unittest.skipUnless(os.geteuid() == 0, "Tests exercise actual appliance ownership transitions.")
    def test_reboot_after_permissions_preserves_browser_identity_and_wifi(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            state_root = Path(directory) / "state"
            kiosk_user = pwd.struct_passwd(("hexclave-tv", "x", 12345, 12345, "", "/nonexistent", "/usr/sbin/nologin"))
            groups = {
                name: grp.struct_group((name, "x", group_id, []))
                for name, group_id in (("hexclave-tv-runtime", 12346), ("systemd-journal", 12347))
            }

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            with (
                mock.patch("hexclave_tv_box.firstboot.pwd.getpwnam", return_value=kiosk_user),
                mock.patch("hexclave_tv_box.firstboot.grp.getgrnam", side_effect=groups.__getitem__),
            ):
                first = initialize_device(state_root, fake_keygen, "a" * 32)
                apply_device_permissions(state_root)
                browser = state_root / "browser"
                browser_inode = browser.stat().st_ino
                cookies = browser / "cookies.sqlite"
                cookies.write_bytes(b"browser-session-fixture")
                os.chown(cookies, kiosk_user.pw_uid, kiosk_user.pw_gid)
                wifi = state_root / "network-connections" / "saved.nmconnection"
                wifi.write_text("[connection]\nid=fixture-network\n", encoding="utf-8")
                wifi.chmod(0o600)
                persisted = {path.relative_to(state_root): path.read_bytes() for path in state_root.rglob("*") if path.is_file()}

                for _reboot in range(2):
                    second = initialize_device(state_root, lambda _command: self.fail("SSH keys were regenerated."), "a" * 32)
                    apply_device_permissions(state_root)
                    self.assertEqual(first, second)
                    self.assertEqual(browser.stat().st_ino, browser_inode)
                    self.assertEqual(browser.stat().st_uid, kiosk_user.pw_uid)
                    self.assertEqual(browser.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(cookies.stat().st_uid, kiosk_user.pw_uid)
                    self.assertEqual(wifi.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(
                        {path.relative_to(state_root): path.read_bytes() for path in state_root.rglob("*") if path.is_file()},
                        persisted,
                    )

    def test_simulated_reboot_transitions_browser_from_root_to_kiosk_and_preserves_state(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory, SimulatedRootOwnership(Path(directory)) as simulator:
            state_root = Path(directory) / "state"
            kiosk_user = pwd.struct_passwd(("hexclave-tv", "x", 12345, 12345, "", "/nonexistent", "/usr/sbin/nologin"))
            groups = {
                name: grp.struct_group((name, "x", group_id, []))
                for name, group_id in (("hexclave-tv-runtime", 12346), ("systemd-journal", 12347))
            }

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            with (
                mock.patch("hexclave_tv_box.firstboot.pwd.getpwnam", return_value=kiosk_user),
                mock.patch("hexclave_tv_box.firstboot.grp.getgrnam", side_effect=groups.__getitem__),
            ):
                first = initialize_device(state_root, fake_keygen, "a" * 32)
                browser = state_root / "browser"
                self.assertEqual(simulator.owner_of(browser), (0, 0))
                apply_device_permissions(state_root)
                browser_inode = browser.stat().st_ino
                self.assertEqual(simulator.owner_of(browser), (12345, 12345))
                self.assertEqual(
                    simulator.chowns,
                    [
                        (state_root, 0, 12346),
                        (state_root / "identity", 0, 12346),
                        (state_root / "browser", 12345, 12345),
                        (state_root / "journal", 0, 12347),
                    ],
                )
                cookies = browser / "cookies.sqlite"
                cookies.write_bytes(b"browser-session-fixture")
                os.chown(cookies, kiosk_user.pw_uid, kiosk_user.pw_gid)
                wifi = state_root / "network-connections" / "saved.nmconnection"
                wifi.write_text("[connection]\nid=fixture-network\n", encoding="utf-8")
                wifi.chmod(0o600)
                persisted = {path.relative_to(state_root): path.read_bytes() for path in state_root.rglob("*") if path.is_file()}

                expected_chowns = [
                    (state_root, 0, 12346),
                    (state_root / "identity", 0, 12346),
                    (state_root / "browser", 12345, 12345),
                    (state_root / "journal", 0, 12347),
                ]
                for _reboot in range(2):
                    simulator.chowns.clear()
                    second = initialize_device(state_root, lambda _command: self.fail("SSH keys were regenerated."), "a" * 32)
                    apply_device_permissions(state_root)
                    self.assertEqual(first, second)
                    self.assertEqual(browser.stat().st_ino, browser_inode)
                    self.assertEqual(simulator.owner_of(browser), (12345, 12345))
                    self.assertEqual(browser.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(wifi.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(
                        {path.relative_to(state_root): path.read_bytes() for path in state_root.rglob("*") if path.is_file()},
                        persisted,
                    )
                    self.assertEqual(simulator.chowns, expected_chowns)

    @unittest.skipUnless(os.geteuid() == 0, "Tests enforce actual directory ownership.")
    def test_initialization_rejects_unexpected_owners_including_browser(self) -> None:
        kiosk_user = pwd.struct_passwd(("hexclave-tv", "x", 12345, 12345, "", "/nonexistent", "/usr/sbin/nologin"))
        for name, owner in (("browser", 12349), ("identity", kiosk_user.pw_uid), ("network-connections", kiosk_user.pw_uid)):
            with self.subTest(name=name), tempfile.TemporaryDirectory(suffix=".untracked") as directory:
                state_root = Path(directory) / "state"
                child = state_root / name
                child.mkdir(parents=True)
                os.chown(child, owner, owner)
                with mock.patch("hexclave_tv_box.firstboot.pwd.getpwnam", return_value=kiosk_user):
                    with self.assertRaisesRegex(RuntimeError, "unexpected owner"):
                        initialize_device(state_root, lambda _command: None, "a" * 32)

    def test_simulated_initialization_rejects_unexpected_owners_including_browser(self) -> None:
        kiosk_user = pwd.struct_passwd(("hexclave-tv", "x", 12345, 12345, "", "/nonexistent", "/usr/sbin/nologin"))
        for name, owner in (("browser", 12349), ("identity", kiosk_user.pw_uid), ("network-connections", kiosk_user.pw_uid)):
            with self.subTest(name=name), tempfile.TemporaryDirectory(suffix=".untracked") as directory, SimulatedRootOwnership(Path(directory)) as simulator:
                state_root = Path(directory) / "state"
                child = state_root / name
                child.mkdir(parents=True)
                os.chown(child, owner, owner)
                with mock.patch("hexclave_tv_box.firstboot.pwd.getpwnam", return_value=kiosk_user):
                    with self.assertRaisesRegex(RuntimeError, "unexpected owner"):
                        initialize_device(state_root, lambda _command: None, "a" * 32)

    def test_simulated_initialization_accepts_kiosk_owned_browser(self) -> None:
        kiosk_user = pwd.struct_passwd(("hexclave-tv", "x", 12345, 12345, "", "/nonexistent", "/usr/sbin/nologin"))
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory, SimulatedRootOwnership(Path(directory)):
            state_root = Path(directory) / "state"
            browser = state_root / "browser"
            browser.mkdir(parents=True)
            os.chown(browser, kiosk_user.pw_uid, kiosk_user.pw_gid)

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            with mock.patch("hexclave_tv_box.firstboot.pwd.getpwnam", return_value=kiosk_user):
                initialize_device(state_root, fake_keygen, "a" * 32)

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

            initialize_device(state_root, fake_keygen, "a" * 32)
            with self.assertRaisesRegex(RuntimeError, "do not match"):
                initialize_device(state_root, fake_keygen, "b" * 32)

    def test_initialization_rejects_state_child_symlink_without_writing_through_it(self) -> None:
        for name in ("browser", "identity", "journal", "network-connections", "ssh"):
            with self.subTest(name=name), tempfile.TemporaryDirectory(suffix=".untracked") as directory:
                root = Path(directory)
                state_root = root / "state"
                state_root.mkdir()
                outside = root / "outside"
                outside.mkdir()
                (state_root / name).symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, "symlink"):
                    initialize_device(state_root, lambda _command: None, "a" * 32)
                self.assertEqual(list(outside.iterdir()), [])

    def test_initialization_creates_only_missing_relay_mountpoint_without_relay_group(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            state_root = root / "state"

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            with mock.patch("hexclave_tv_box.firstboot.grp.getgrnam", side_effect=KeyError("hexclave-tv-relay")) as group_lookup:
                first = initialize_device(state_root, fake_keygen, "a" * 32)
                second = initialize_device(state_root, fake_keygen, "a" * 32)
                group_lookup.assert_not_called()
            self.assertEqual(first, second)
            relay = state_root / "relay"
            self.assertFalse(relay.is_symlink())
            self.assertEqual(relay.stat().st_mode & 0o777, 0o750)
            self.assertEqual(relay.stat().st_uid, os.getuid())
            self.assertEqual(list(relay.iterdir()), [])

    def test_simulated_unsafe_optional_relay_path_blocks_only_relay_initialization(self) -> None:
        for kind, error_type in (
            ("symlink", ValueError),
            ("dangling-symlink", ValueError),
            ("wrong-owner", ValueError),
            ("unsafe-mode", ValueError),
            ("regular-file", FileExistsError),
        ):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(suffix=".untracked") as directory, SimulatedRootOwnership(Path(directory)) as simulator:
                root = Path(directory)
                state_root = root / "state"
                state_root.mkdir(mode=0o700)
                outside = root / "outside"
                outside.mkdir(mode=0o700)
                (outside / "keep").write_text("unchanged", encoding="utf-8")
                relay = state_root / "relay"
                if kind == "symlink":
                    relay.symlink_to(outside, target_is_directory=True)
                elif kind == "dangling-symlink":
                    relay.symlink_to(root / "missing", target_is_directory=True)
                elif kind == "regular-file":
                    relay.write_text("unchanged", encoding="utf-8")
                else:
                    relay.mkdir(mode=0o750)
                    if kind == "wrong-owner":
                        os.chown(relay, 12349, 12349)
                    else:
                        relay.chmod(0o777)
                before = relay.lstat()
                simulator.chowns.clear()

                def fake_keygen(command: list[str]) -> None:
                    key_path = Path(command[command.index("-f") + 1])
                    key_path.write_text("private", encoding="utf-8")
                    Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

                with self.assertRaises(error_type):
                    initialize_relay_identity(state_root, group_id=os.getgid())
                initialize_device(state_root, fake_keygen, "a" * 32)
                after = relay.lstat()
                self.assertEqual(
                    (after.st_ino, after.st_mode, after.st_uid, after.st_gid),
                    (before.st_ino, before.st_mode, before.st_uid, before.st_gid),
                )
                self.assertEqual((outside / "keep").read_text(encoding="utf-8"), "unchanged")
                self.assertFalse((root / "missing").exists())
                self.assertEqual(simulator.chowns, [])
                with self.assertRaises(error_type):
                    initialize_relay_identity(state_root, group_id=os.getgid())

    @unittest.skipUnless(os.geteuid() == 0, "Relay initialization enforces actual root-owned metadata.")
    def test_unsafe_optional_relay_path_blocks_only_relay_initialization(self) -> None:
        for kind, error_type in (
            ("symlink", ValueError),
            ("dangling-symlink", ValueError),
            ("wrong-owner", ValueError),
            ("unsafe-mode", ValueError),
            ("regular-file", FileExistsError),
        ):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(suffix=".untracked") as directory:
                root = Path(directory)
                state_root = root / "state"
                state_root.mkdir(mode=0o700)
                outside = root / "outside"
                outside.mkdir(mode=0o700)
                (outside / "keep").write_text("unchanged", encoding="utf-8")
                relay = state_root / "relay"
                if kind == "symlink":
                    relay.symlink_to(outside, target_is_directory=True)
                elif kind == "dangling-symlink":
                    relay.symlink_to(root / "missing", target_is_directory=True)
                elif kind == "regular-file":
                    relay.write_text("unchanged", encoding="utf-8")
                else:
                    relay.mkdir(mode=0o750)
                    if kind == "wrong-owner":
                        os.chown(relay, 12349, 12349)
                    else:
                        relay.chmod(0o777)
                before = relay.lstat()

                def fake_keygen(command: list[str]) -> None:
                    key_path = Path(command[command.index("-f") + 1])
                    key_path.write_text("private", encoding="utf-8")
                    Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

                with self.assertRaises(error_type):
                    initialize_relay_identity(state_root, group_id=os.getgid())
                initialize_device(state_root, fake_keygen, "a" * 32)
                after = relay.lstat()
                self.assertEqual(
                    (after.st_ino, after.st_mode, after.st_uid, after.st_gid),
                    (before.st_ino, before.st_mode, before.st_uid, before.st_gid),
                )
                self.assertEqual((state_root / "firstboot-state" / "complete").read_text(encoding="utf-8"), "complete\n")
                self.assertEqual((outside / "keep").read_text(encoding="utf-8"), "unchanged")
                self.assertFalse((root / "missing").exists())
                with self.assertRaises(error_type):
                    initialize_relay_identity(state_root, group_id=os.getgid())

    def test_simulated_initialization_preserves_existing_private_relay_mountpoint_metadata(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory, SimulatedRootOwnership(Path(directory)) as simulator:
            state_root = Path(directory) / "state"
            relay = state_root / "relay"
            relay.mkdir(mode=0o700, parents=True)
            os.chown(relay, 0, 12349)
            (relay / "keep").write_text("unchanged", encoding="utf-8")
            before = relay.stat()
            simulator.chowns.clear()

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            initialize_device(state_root, fake_keygen, "a" * 32)
            after = relay.stat()
            self.assertEqual(
                (after.st_ino, after.st_mode, after.st_uid, after.st_gid),
                (before.st_ino, before.st_mode, before.st_uid, before.st_gid),
            )
            self.assertEqual((relay / "keep").read_text(encoding="utf-8"), "unchanged")
            self.assertEqual(simulator.chowns, [])

    @unittest.skipUnless(os.geteuid() == 0, "Tests enforce actual relay directory metadata.")
    def test_initialization_preserves_existing_private_relay_mountpoint_metadata(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            state_root = Path(directory) / "state"
            relay = state_root / "relay"
            relay.mkdir(mode=0o700, parents=True)
            os.chown(relay, 0, 12349)
            (relay / "keep").write_text("unchanged", encoding="utf-8")
            before = relay.stat()

            def fake_keygen(command: list[str]) -> None:
                key_path = Path(command[command.index("-f") + 1])
                key_path.write_text("private", encoding="utf-8")
                Path(f"{key_path}.pub").write_text("public", encoding="utf-8")

            initialize_device(state_root, fake_keygen, "a" * 32)
            after = relay.stat()
            self.assertEqual(
                (after.st_ino, after.st_mode, after.st_uid, after.st_gid),
                (before.st_ino, before.st_mode, before.st_uid, before.st_gid),
            )
            self.assertEqual((relay / "keep").read_text(encoding="utf-8"), "unchanged")

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
