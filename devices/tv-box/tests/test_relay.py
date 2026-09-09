from __future__ import annotations

import base64
import json
import os
import grp
import pwd
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from hexclave_tv_box import relay
from hexclave_tv_box.state import clear_exact_state_directory


PUBLIC_KEY = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))).decode()


def enrollment() -> dict[str, object]:
    return {
        "version": 1, "host": "relay.example.invalid", "port": 22,
        "user": "tvbox-example0001", "listen_port": 22001, "host_key": PUBLIC_KEY,
    }


class RelayPolicyTests(unittest.TestCase):
    def test_strict_configuration_and_loopback_only_forward(self) -> None:
        config = relay.parse_config(enrollment())
        command = relay.ssh_command(config)
        self.assertEqual(command[command.index("-R") + 1], "127.0.0.1:22001:127.0.0.1:22")
        self.assertEqual(command[-1], "tvbox-example0001@relay.example.invalid")
        for option in (
            "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "IdentityAgent=none",
            "GlobalKnownHostsFile=/dev/null", "ExitOnForwardFailure=yes", "ForwardAgent=no",
            "ForwardX11=no", "ControlMaster=no", "PermitLocalCommand=no", "EscapeChar=none",
        ):
            self.assertIn(option, command)
        self.assertEqual(command[:4], ["/usr/bin/ssh", "-F", "/dev/null", "-N"])

    def test_invalid_enrollment_cannot_inject_ssh_options_or_widen_trust(self) -> None:
        cases = (
            ("host", "-oProxyCommand=evil"), ("host", "*.example.invalid"),
            ("host", "host\nProxyCommand evil"), ("host", "ssh://relay.example.invalid"),
            ("host", "user@relay.example.invalid"), ("host", "localhost:22"),
            ("user", "root"), ("user", "tvbox-example;id"), ("port", True),
            ("listen_port", 22), ("listen_port", 65536), ("port", "22"),
            ("host_key", PUBLIC_KEY + " comment"), ("host_key", "ssh-ed25519 AAAA"),
            ("version", True), ("arbitrary_forward", "0.0.0.0:22"),
        )
        for field, value in cases:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    relay.parse_config({**enrollment(), field: value})
        with self.assertRaises(ValueError):
            relay.parse_config({"host": "relay.example.invalid"})

    def test_known_host_pin_includes_nonstandard_port(self) -> None:
        config = relay.parse_config({**enrollment(), "port": 443})
        self.assertEqual(relay.known_hosts_entry(config), f"[relay.example.invalid]:443 {PUBLIC_KEY}\n")

    def test_backoff_is_positive_bounded_and_grows(self) -> None:
        self.assertEqual(relay.retry_delay(1, 0), 4)
        self.assertEqual(relay.retry_delay(1, 1), 5)
        self.assertEqual(relay.retry_delay(2, 1), 10)
        self.assertEqual(relay.retry_delay(100000, 1), 300)
        for failure in range(1, 30):
            self.assertLessEqual(relay.retry_delay(failure, 0.5), 300)
        for failures, jitter in ((0, 0.5), (True, 0.5), (1, -1), (1, 1.1)):
            with self.assertRaises(ValueError):
                relay.retry_delay(failures, jitter)

    def test_raw_ssh_messages_are_never_returned(self) -> None:
        self.assertEqual(relay.classify_ssh_line(b"Permission denied (publickey), password=secret"), "authentication")
        self.assertEqual(relay.classify_ssh_line(b"remote port forwarding failed for listen port 22001"), "listener")
        self.assertEqual(relay.classify_ssh_line(b"Host key verification failed"), "host-key")
        self.assertEqual(relay.classify_ssh_line(b"Could not resolve hostname private.example"), "dns")
        self.assertIsNone(relay.classify_ssh_line(b"PRIVATE_KEY=do-not-log"))
        self.assertIsNone(relay.classify_ssh_line(b"Welcome banner: remote forward success for: listen 127.0.0.1:22001"))
        self.assertIsNone(relay.classify_ssh_line(b"Welcome banner: debug1: remote forward success for: listen 127.0.0.1:22001"))
        self.assertEqual(relay.classify_ssh_line(b"debug1: remote forward success for: listen 127.0.0.1:22001, connect 127.0.0.1:22"), "connected")

    def test_service_is_optional_unprivileged_and_cannot_reboot(self) -> None:
        root = Path(__file__).resolve().parents[1]
        unit = (root / "image/rootfs/etc/systemd/system/hexclave-tv-box-relay.service").read_text()
        self.assertIn("User=hexclave-tv-relay", unit)
        self.assertIn("ConditionPathExists=/var/lib/hexclave-tv-box/relay/enrollment.json", unit)
        self.assertIn("RestartPreventExitStatus=78", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("KillMode=control-group", unit)
        self.assertNotIn("reboot", unit)
        self.assertNotIn("Requires=hexclave-tv-box-kiosk", unit)
        template = (root / "support-relay/sshd_config.template").read_text()
        for boundary in ("MaxSessions 0", "GatewayPorts no", "PermitOpen none", "PermitListen none", "AllowTcpForwarding remote", "AllowTcpForwarding local"):
            self.assertIn(boundary, template)


@unittest.skipUnless(os.geteuid() == 0, "Tests enforce actual root-owned enrollment metadata.")
class RelayStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "state"
        self.root.mkdir(mode=0o700)
        self.runtime = Path(self.temporary.name) / "runtime"
        self.runtime.mkdir(mode=0o700)
        relay.initialize_relay_identity(self.root, group_id=os.getgid())
        self.source = Path(self.temporary.name) / "approved.json"
        self.source.write_text(json.dumps(enrollment()))
        self.source.chmod(0o600)

    def test_unenrolled_is_disabled_without_connecting(self) -> None:
        self.assertIsNone(relay.load_config(self.root))
        self.assertEqual(relay.relay_diagnostics(self.root, self.runtime), ["support-relay=disabled"])
        self.assertFalse((self.root / "relay/enrollment.json").exists())

    def test_each_unit_identity_is_unique_and_reboot_keeps_key(self) -> None:
        key_before = relay.relay_enrollment_public_key(self.root)
        relay.initialize_relay_identity(self.root, group_id=os.getgid())
        self.assertEqual(relay.relay_enrollment_public_key(self.root), key_before)
        another = Path(self.temporary.name) / "another"
        another.mkdir(mode=0o700)
        relay.initialize_relay_identity(another, group_id=os.getgid())
        self.assertNotEqual(relay.relay_enrollment_public_key(another), key_before)
        self.assertTrue(key_before.startswith("ssh-ed25519 "))

    def test_enrollment_preserves_key_and_rejects_existing_registration(self) -> None:
        key_before = relay.relay_enrollment_public_key(self.root)
        relay.install_enrollment(self.source, self.root)
        self.assertEqual(relay.load_config(self.root), relay.parse_config(enrollment()))
        self.assertEqual(relay.relay_enrollment_public_key(self.root), key_before)
        with self.assertRaisesRegex(ValueError, "already enrolled"):
            relay.install_enrollment(self.source, self.root)
        self.assertEqual((self.root / "relay/enrollment.json").stat().st_mode & 0o777, 0o640)

    def test_concurrent_enrollment_cannot_replace_pin_or_registration(self) -> None:
        with relay._enrollment_lock(self.root / "relay"):
            with self.assertRaisesRegex(RuntimeError, "already in progress"):
                relay.install_enrollment(self.source, self.root)
        self.assertFalse((self.root / "relay/enrollment.json").exists())
        self.assertFalse((self.root / "relay/known_hosts").exists())
        relay.install_enrollment(self.source, self.root)
        original = (self.root / "relay/known_hosts").read_text()
        self.source.write_text(json.dumps({**enrollment(), "host": "another.example.invalid"}))
        with self.assertRaisesRegex(ValueError, "already enrolled"):
            relay.install_enrollment(self.source, self.root)
        self.assertEqual((self.root / "relay/known_hosts").read_text(), original)

    def test_relay_host_key_pin_cannot_be_silently_replaced(self) -> None:
        relay.install_enrollment(self.source, self.root)
        (self.root / "relay/known_hosts").write_text("untrusted\n")
        with self.assertRaisesRegex(ValueError, "host-key pin"):
            relay.load_config(self.root)

    def test_files_and_directory_must_be_private_root_owned_and_not_links(self) -> None:
        self.source.chmod(0o666)
        with self.assertRaises(ValueError):
            relay.install_enrollment(self.source, self.root)
        self.source.chmod(0o600)
        linked = Path(self.temporary.name) / "linked.json"
        linked.symlink_to(self.source)
        with self.assertRaises(OSError):
            relay.install_enrollment(linked, self.root)
        (self.root / "relay").chmod(0o777)
        with self.assertRaises(ValueError):
            relay.load_config(self.root)

    def test_linked_parent_and_target_are_refused(self) -> None:
        linked_state = Path(self.temporary.name) / "linked-state"
        linked_state.symlink_to(self.root)
        with self.assertRaises(ValueError):
            relay.load_config(linked_state)
        with self.assertRaises(ValueError):
            relay.initialize_relay_identity(linked_state, group_id=os.getgid())
        path = self.root / "relay/enrollment.json"
        path.symlink_to(self.source)
        with self.assertRaises(ValueError):
            relay.install_enrollment(self.source, self.root)

    def test_partial_key_identity_is_not_silently_replaced(self) -> None:
        (self.root / "relay/id_ed25519.pub").unlink()
        with self.assertRaises(FileNotFoundError):
            relay.initialize_relay_identity(self.root, group_id=os.getgid())

    def test_existing_key_pair_must_correspond(self) -> None:
        (self.root / "relay/id_ed25519.pub").write_text(PUBLIC_KEY + "\n")
        with self.assertRaisesRegex(ValueError, "key pair does not match"):
            relay.initialize_relay_identity(self.root, group_id=os.getgid())

    def test_root_owned_group_readable_private_key_is_usable_without_mutation_rights(self) -> None:
        try:
            nobody = pwd.getpwnam("nobody")
        except KeyError:
            self.skipTest("No existing unprivileged test account is available.")
        # This is the actual OpenSSH key loader, running as an unrelated UID;
        # do not assume it accepts root:relay 0640 merely because Python can.
        for directory in (Path(self.temporary.name), self.root, self.root / "relay"):
            os.chown(directory, 0, nobody.pw_gid)
            directory.chmod(0o750)
        key = self.root / "relay/id_ed25519"
        os.chown(key, 0, nobody.pw_gid)
        result = subprocess.run(
            ["/usr/bin/ssh-keygen", "-y", "-f", str(key)],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, user=nobody.pw_uid, group=nobody.pw_gid, extra_groups=[], timeout=10,
        )
        self.assertTrue(result.stdout.startswith("ssh-ed25519 "))
        self.assertEqual(key.stat().st_mode & 0o777, 0o640)
        self.assertEqual(key.stat().st_uid, 0)

    @unittest.skipUnless(Path("/usr/sbin/sshd").exists(), "OpenSSH server is unavailable.")
    def test_relay_template_effective_role_boundaries(self) -> None:
        try:
            nobody = pwd.getpwnam("nobody")
        except KeyError:
            self.skipTest("No existing unprivileged test account is available.")
        root = Path(__file__).resolve().parents[1]
        configuration = (root / "support-relay/sshd_config.template").read_text()
        configuration = configuration.replace("TVBOX_DEVICE_ACCOUNT", nobody.pw_name).replace("OPERATOR_ACCOUNT", "root")
        configuration = configuration.replace("hexclave-relay-devices", grp.getgrgid(nobody.pw_gid).gr_name).replace("hexclave-relay-operators", "root")
        configuration = configuration.replace("ASSIGNED_RELAY_PORT", "22001")
        key = self.root / "relay/id_ed25519"
        key.chmod(0o600)
        configuration = configuration.replace("/etc/ssh/ssh_host_ed25519_key", str(key))
        config_path = Path(self.temporary.name) / "sshd-test.conf"
        config_path.write_text(configuration)
        for user, role in ((nobody.pw_name, "remote"), ("root", "local")):
            with self.subTest(role=role):
                result = subprocess.run(
                    ["/usr/sbin/sshd", "-T", "-f", str(config_path), "-C", f"user={user},host=relay.example.invalid,addr=127.0.0.1"],
                    check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10,
                )
                options = dict(line.split(" ", 1) for line in result.stdout.splitlines())
                self.assertEqual(options["allowtcpforwarding"], role)
                self.assertEqual(options["permitlisten"], "127.0.0.1:22001" if role == "remote" else "none")
                self.assertEqual(options["permitopen"], "none" if role == "remote" else "127.0.0.1:22001")
                for setting, expected in (
                    ("maxsessions", "0"), ("gatewayports", "no"), ("permittty", "no"),
                    ("allowagentforwarding", "no"), ("allowstreamlocalforwarding", "no"),
                    ("x11forwarding", "no"), ("passwordauthentication", "no"),
                ):
                    self.assertEqual(options[setting], expected)

    def test_factory_clear_removes_registration_and_regenerates_unique_key_only(self) -> None:
        relay.install_enrollment(self.source, self.root)
        before = relay.relay_enrollment_public_key(self.root)
        (self.root / "browser").mkdir()
        sentinel = self.root / "browser/keep"
        sentinel.write_text("unrelated")
        clear_exact_state_directory(self.root, "relay")
        relay.initialize_relay_identity(self.root, group_id=os.getgid())
        self.assertNotEqual(relay.relay_enrollment_public_key(self.root), before)
        self.assertIsNone(relay.load_config(self.root))
        self.assertEqual(sentinel.read_text(), "unrelated")

    def test_diagnostics_never_return_enrollment_or_untrusted_runtime_contents(self) -> None:
        relay.install_enrollment(self.source, self.root)
        relay._write_status(self.runtime, "connected", "none", 1)
        self.assertEqual(relay.relay_diagnostics(self.root, self.runtime), ["support-relay=connected failure=none attempts=1"])
        for payload in ("secret" * 1000, '{"state":{"secret":"x"},"failure":"none","attempts":1}', '{"state":"PRIVATE_KEY"}'):
            (self.runtime / "status").write_text(payload)
            self.assertEqual(relay.relay_diagnostics(self.root, self.runtime), ["support-relay=configured status=unavailable"])

    def test_supervision_reports_connection_and_terminates_without_logging_stderr(self) -> None:
        config = relay.parse_config(enrollment())
        stop = threading.Event()
        original_popen = subprocess.Popen
        commands: list[list[str]] = []
        original_write_status = relay._write_status

        def fake_process(command: list[str], **_kwargs: object) -> subprocess.Popen[bytes]:
            commands.append(command)
            return original_popen(
                [sys.executable, "-c", "import sys,time; sys.stderr.write('PRIVATE_KEY=never-log\\ndebug1: remote forward success for: listen 127.0.0.1:22001\\n'); sys.stderr.flush(); time.sleep(30)"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )

        def write_status(runtime: Path, state: str, failure: str, attempts: int) -> None:
            original_write_status(runtime, state, failure, attempts)
            if state == "connected":
                stop.set()

        with patch.object(relay.subprocess, "Popen", side_effect=fake_process), patch.object(relay, "_write_status", side_effect=write_status), self.assertLogs(relay.LOG, level="INFO") as logs:
            relay.supervise(config, stop, self.root, self.runtime)
        self.assertEqual(len(commands), 1)
        self.assertTrue(any("relay-state=connected" in line for line in logs.output))
        self.assertNotIn("PRIVATE_KEY", "\n".join(logs.output))
        self.assertNotIn(config.host, "\n".join(logs.output))

    def test_failed_transport_uses_bounded_backoff_and_categorized_logs(self) -> None:
        stop = threading.Event()
        original_popen = subprocess.Popen

        def fake_process(_command: list[str], **_kwargs: object) -> subprocess.Popen[bytes]:
            return original_popen(
                [sys.executable, "-c", "import sys,time; sys.stderr.write('Permission denied private-address secret\\n'); sys.stderr.flush(); time.sleep(.05); sys.exit(255)"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )

        def stop_after_retry(delay: float) -> bool:
            self.assertGreaterEqual(delay, 4)
            self.assertLessEqual(delay, 5)
            stop.set()
            return True

        with patch.object(relay.subprocess, "Popen", side_effect=fake_process), patch.object(stop, "wait", side_effect=stop_after_retry), self.assertLogs(relay.LOG, level="INFO") as logs:
            relay.supervise(relay.parse_config(enrollment()), stop, self.root, self.runtime)
        self.assertTrue(any("reason=authentication" in line for line in logs.output))
        self.assertNotIn("private-address", "\n".join(logs.output))

    @unittest.skipUnless(Path("/usr/sbin/sshd").exists(), "OpenSSH server is unavailable.")
    def test_real_loopback_relay_forward_and_negative_permissions(self) -> None:
        # No system account, installed configuration, host key or public port
        # is changed. Root is used ONLY by this isolated loopback fixture;
        # shipped templates forbid root and bind real per-device accounts.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            ssh_port = reservation.getsockname()[1]
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            forwarded_port = reservation.getsockname()[1]
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            denied_port = reservation.getsockname()[1]
        self.assertEqual(len({ssh_port, forwarded_port, denied_port}), 3)
        server_key = Path(self.temporary.name) / "test-server-key"
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(server_key)],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        server_public = server_key.with_suffix(".pub").read_text().strip()
        key = self.root / "relay/id_ed25519"
        key.chmod(0o600)
        # OpenSSH StrictModes rejects any world-writable ancestor, including
        # sticky /tmp; keep ONLY the fixture's public authorization file in
        # a temporary directory below root's private home instead.
        authorizations = tempfile.TemporaryDirectory(prefix="tv-box-relay-ssh-", suffix=".untracked", dir=pwd.getpwuid(0).pw_dir)
        self.addCleanup(authorizations.cleanup)
        authorized_keys = Path(authorizations.name) / "authorized_keys"
        authorized_keys.write_text(
            f'restrict,port-forwarding,permitlisten="127.0.0.1:{forwarded_port}" '
            f'{relay.relay_enrollment_public_key(self.root)}\n',
        )
        authorized_keys.chmod(0o600)
        server_config = Path(self.temporary.name) / "loopback-sshd.conf"
        server_config.write_text("\n".join([
            f"Port {ssh_port}", "ListenAddress 127.0.0.1", f"HostKey {server_key}",
            f"PidFile {Path(self.temporary.name) / 'sshd.pid'}", f"AuthorizedKeysFile {authorized_keys}",
            "PermitRootLogin yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
            # The host's existing root account may be password-locked. PAM's
            # account check permits key auth without changing that account.
            "PubkeyAuthentication yes", "AuthenticationMethods publickey", "UsePAM yes", "AllowUsers root",
            "MaxSessions 0", "PermitTTY no", "AllowAgentForwarding no", "X11Forwarding no",
            "AllowStreamLocalForwarding no", "PermitTunnel no", "GatewayPorts no", "PermitOpen none",
            f"PermitListen 127.0.0.1:{forwarded_port}", "AllowTcpForwarding remote", "LogLevel VERBOSE", "",
        ]))
        subprocess.run(["/usr/sbin/sshd", "-t", "-f", str(server_config)], check=True, timeout=10)
        daemon = subprocess.Popen(
            ["/usr/sbin/sshd", "-D", "-e", "-f", str(server_config)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True,
        )
        stop = threading.Event()
        if daemon.stderr is not None:
            os.set_blocking(daemon.stderr.fileno(), False)
        supervisor: threading.Thread | None = None
        errors: list[BaseException] = []
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", ssh_port), timeout=0.1):
                        break
                except OSError:
                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        self.fail("Temporary loopback SSH daemon did not start.")
                    time.sleep(0.025)
            config = relay.RelayConfig("127.0.0.1", ssh_port, "root", forwarded_port, server_public)
            (self.root / "relay/known_hosts").write_text(relay.known_hosts_entry(config))
            (self.root / "relay/known_hosts").chmod(0o600)

            def run_supervisor() -> None:
                try:
                    relay.supervise(config, stop, self.root, self.runtime)
                except BaseException as error:
                    # Test thread failures must fail the test, not disappear
                    # into threading's stderr while the parent keeps waiting.
                    errors.append(error)
                    stop.set()

            supervisor = threading.Thread(target=run_supervisor)
            supervisor.start()
            deadline = time.monotonic() + 10
            while True:
                status_path = self.runtime / "status"
                if status_path.exists() and json.loads(status_path.read_text())["state"] == "connected":
                    break
                if errors or time.monotonic() >= deadline:
                    details = daemon.stderr.read(16384) if daemon.stderr is not None else b""
                    self.fail(f"Real OpenSSH remote-forward acknowledgement was not detected: {details!r}")
                time.sleep(0.025)
            # The only allowed destination is the box's ordinary SSH port.
            # Inspect its protocol banner without attempting authentication.
            try:
                with socket.create_connection(("127.0.0.1", 22), timeout=0.2) as local_ssh:
                    expected_banner = local_ssh.recv(256)
            except OSError:
                expected_banner = None
            if expected_banner is not None:
                with socket.create_connection(("127.0.0.1", forwarded_port), timeout=2) as forwarded:
                    self.assertEqual(forwarded.recv(256), expected_banner)
            command = relay.ssh_command(config, self.root)
            # Reuse pinned/authenticated options, removing only the tunnel
            # and no-session switch for explicitly forbidden requests.
            forward_index = command.index("-R")
            base = command[:forward_index]
            base.remove("-N")
            destination = command[-1]
            denied_shell = subprocess.run(
                [*base, destination, "true"], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_shell.returncode, 0)
            denied_local = subprocess.run(
                [*base, "-W", "127.0.0.1:22", destination], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_local.returncode, 0)
            denied_remote = subprocess.run(
                [*base, "-N", "-R", f"127.0.0.1:{denied_port}:127.0.0.1:22", destination],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_remote.returncode, 0)
            self.assertIn(b"remote port forwarding failed", denied_remote.stderr)
            # Public-bind requests cannot satisfy either exact PermitListen.
            denied_public = subprocess.run(
                [*base, "-N", "-R", f"0.0.0.0:{forwarded_port}:127.0.0.1:22", destination],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_public.returncode, 0)
            self.assertFalse(errors)
        finally:
            stop.set()
            if supervisor is not None:
                supervisor.join(timeout=15)
                self.assertFalse(supervisor.is_alive())
            # The group belongs only to the freshly started test daemon and
            # its children, never the host's real SSH service.
            if daemon.poll() is None:
                os.killpg(daemon.pid, signal.SIGTERM)
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(daemon.pid, signal.SIGKILL)
                    daemon.wait(timeout=5)
            if daemon.stderr is not None:
                daemon.stderr.close()


if __name__ == "__main__":
    unittest.main()
