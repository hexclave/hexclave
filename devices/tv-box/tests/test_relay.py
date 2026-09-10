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
            "ConnectTimeout=15", "ConnectionAttempts=1", "ServerAliveInterval=30", "ServerAliveCountMax=3",
        ):
            self.assertIn(option, command)
        self.assertEqual(command[:4], ["/usr/bin/ssh", "-F", "/dev/null", "-N"])
        self.assertIn("-q", command)
        self.assertNotIn("-v", command)

    def test_endpoint_is_operator_configured_without_provider_assumptions(self) -> None:
        for hostname in ("support.example.net", "127.0.0.1", "relay.internal"):
            with self.subTest(hostname=hostname):
                config = relay.parse_config({**enrollment(), "host": hostname, "port": 443})
                command = relay.ssh_command(config)
                self.assertEqual(command[-1], f"tvbox-example0001@{hostname}")
                self.assertEqual(command[command.index("-p") + 1], "443")

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

    def test_service_is_optional_unprivileged_and_cannot_reboot(self) -> None:
        root = Path(__file__).resolve().parents[1]
        unit = (root / "image/rootfs/etc/systemd/system/hexclave-tv-box-relay.service").read_text()
        self.assertIn("User=hexclave-tv-relay", unit)
        self.assertIn("ConditionPathExists=/var/lib/hexclave-tv-box/relay/enrollment.json", unit)
        self.assertIn("RestartPreventExitStatus=78", unit)
        for setting in (
            "Type=exec", "Restart=always", "RestartSec=5s", "RestartSteps=6", "RestartMaxDelaySec=5min",
            "StartLimitIntervalSec=0", "StandardInput=null", "StandardOutput=null", "StandardError=null",
            "CPUAccounting=yes", "MemoryAccounting=yes", "TasksAccounting=yes",
        ):
            self.assertIn(setting, unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("KillMode=control-group", unit)
        self.assertNotIn("reboot", unit)
        self.assertNotIn("Requires=hexclave-tv-box-kiosk", unit)
        self.assertNotIn("RuntimeDirectory=", unit)
        self.assertNotIn("ReadWritePaths=", unit)
        self.assertNotIn("network-online.target", unit)
        for name in ("network", "kiosk", "setup", "setup-display", "firstboot"):
            critical_unit = (root / f"image/rootfs/etc/systemd/system/hexclave-tv-box-{name}.service").read_text()
            for line in critical_unit.splitlines():
                if line.startswith(("Requires=", "Wants=", "After=")):
                    self.assertNotIn("hexclave-tv-box-relay", line)
        template = (root / "support-relay/sshd_config.template").read_text()
        for boundary in ("MaxSessions 0", "GatewayPorts no", "PermitOpen none", "PermitListen none", "AllowTcpForwarding remote", "AllowTcpForwarding local"):
            self.assertIn(boundary, template)


@unittest.skipUnless(os.geteuid() == 0, "Tests enforce actual root-owned enrollment metadata.")
class RelayStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(suffix=".untracked")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "state"
        self.root.mkdir(mode=0o700)
        relay.initialize_relay_identity(self.root, group_id=os.getgid())
        self.source = Path(self.temporary.name) / "approved.json"
        self.source.write_text(json.dumps(enrollment()))
        self.source.chmod(0o600)

    def test_unenrolled_is_disabled_without_connecting(self) -> None:
        self.assertIsNone(relay.load_config(self.root))
        self.assertEqual(relay.relay_diagnostics(self.root), ["support-relay=disabled"])
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
        with self.assertRaisesRegex(ValueError, "Partial relay identity"):
            relay.initialize_relay_identity(self.root, group_id=os.getgid())

    def test_public_only_key_identity_is_not_silently_replaced(self) -> None:
        (self.root / "relay/id_ed25519").unlink()
        with self.assertRaisesRegex(ValueError, "Partial relay identity"):
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

    def test_diagnostics_describe_configuration_without_claiming_connection(self) -> None:
        relay.install_enrollment(self.source, self.root)
        self.assertEqual(relay.relay_diagnostics(self.root), ["support-relay=configured"])
        for name in ("known_hosts", "id_ed25519"):
            path = self.root / "relay" / name
            contents = path.read_text()
            path.unlink()
            self.assertEqual(relay.relay_diagnostics(self.root), ["support-relay=invalid-config"])
            path.write_text(contents)
            path.chmod(0o640)
        (self.root / "relay/enrollment.json").write_text('{"private-data": "never-export"}')
        self.assertEqual(relay.relay_diagnostics(self.root), ["support-relay=invalid-config"])

    def test_absent_identity_is_disabled_but_linked_identity_is_invalid(self) -> None:
        empty = Path(self.temporary.name) / "empty"
        empty.mkdir(mode=0o700)
        self.assertEqual(relay.relay_diagnostics(empty), ["support-relay=disabled"])
        (empty / "relay").symlink_to(self.root / "relay")
        self.assertEqual(relay.relay_diagnostics(empty), ["support-relay=invalid-config"])

    def test_startup_replaces_python_with_one_ssh_process_and_clean_environment(self) -> None:
        relay.install_enrollment(self.source, self.root)
        with (
            patch.object(relay.os, "execve") as execute,
            patch.object(relay.subprocess, "Popen") as spawn,
            patch.dict(os.environ, {"SSH_AUTH_SOCK": "/untrusted/agent", "SSH_ASKPASS": "/untrusted/program"}),
        ):
            relay.start_transport(self.root)
        execute.assert_called_once_with(
            "/usr/bin/ssh", relay.ssh_command(relay.parse_config(enrollment()), self.root),
            {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
        spawn.assert_not_called()
        self.assertFalse((self.root / "relay/status").exists())

    def test_real_exec_handoff_keeps_pid_but_leaves_no_python_supervisor(self) -> None:
        with socket.socket() as handshake:
            handshake.bind(("127.0.0.1", 0))
            handshake.listen()
            handshake.settimeout(5)
            self.source.write_text(json.dumps({**enrollment(), "host": "127.0.0.1", "port": handshake.getsockname()[1]}))
            relay.install_enrollment(self.source, self.root)
            client = subprocess.Popen(
                [sys.executable, "-c", "import sys; from pathlib import Path; from hexclave_tv_box.relay import start_transport; start_transport(Path(sys.argv[1]))", str(self.root)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            try:
                # Hold an isolated connection before its SSH handshake. The
                # executing PID must already be ssh, not a supervising Python
                # parent; no system account or deployed endpoint is involved.
                accepted, _address = handshake.accept()
                with accepted:
                    self.assertEqual(Path(f"/proc/{client.pid}/comm").read_text().strip(), "ssh")
                    self.assertEqual(Path(f"/proc/{client.pid}/task/{client.pid}/children").read_text(), "")
            finally:
                if client.poll() is None:
                    client.terminate()
                try:
                    output, errors = client.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    client.kill()
                    output, errors = client.communicate(timeout=5)
            self.assertEqual(output, b"")
            self.assertEqual(errors, b"")

    def test_missing_or_malformed_config_fails_closed_without_spawning_or_retrying(self) -> None:
        for contents, label in ((None, "disabled"), ("{", "invalid-config"), ('{"secret":"never-log"}', "invalid-config")):
            with self.subTest(contents=contents):
                if contents is not None:
                    path = self.root / "relay/enrollment.json"
                    path.write_text(contents)
                    path.chmod(0o600)
                with patch.object(relay.os, "execve") as execute, self.assertLogs(relay.LOG, level="INFO") as logs:
                    with self.assertRaises(SystemExit) as failure:
                        relay.start_transport(self.root)
                self.assertEqual(failure.exception.code, 78)
                self.assertEqual(logs.output, [f"{'INFO' if label == 'disabled' else 'ERROR'}:hexclave_tv_box.relay:relay-state={label}"])
                execute.assert_not_called()

    def test_missing_pins_keys_or_ssh_executable_are_nonretryable(self) -> None:
        relay.install_enrollment(self.source, self.root)
        for name in ("known_hosts", "id_ed25519"):
            with self.subTest(name=name):
                path = self.root / "relay" / name
                contents = path.read_text()
                path.unlink()
                with patch.object(relay.os, "execve") as execute, self.assertLogs(relay.LOG, level="ERROR"):
                    with self.assertRaises(SystemExit) as failure:
                        relay.start_transport(self.root)
                self.assertEqual(failure.exception.code, 78)
                execute.assert_not_called()
                path.write_text(contents)
                path.chmod(0o640)
        with (
            patch.object(relay.os, "execve", side_effect=OSError("private-error")),
            self.assertLogs(relay.LOG, level="ERROR") as logs,
            self.assertRaises(SystemExit) as failure,
        ):
            relay.start_transport(self.root)
        self.assertEqual(failure.exception.code, 78)
        self.assertEqual(logs.output, ["ERROR:hexclave_tv_box.relay:relay-state=launch-failed"])

    def test_identity_and_enrollment_reject_nonroot_callers(self) -> None:
        with patch.object(relay.os, "geteuid", return_value=65534):
            with self.assertRaises(PermissionError):
                relay.initialize_relay_identity(self.root)
            with self.assertRaises(PermissionError):
                relay.install_enrollment(self.source, self.root)

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
        banner = Path(self.temporary.name) / "server-banner"
        banner.write_text("PRIVATE_SERVER_BANNER_MUST_NOT_REACH_LOGS\n")
        # Do not connect to or replace the host's real SSH daemon on port 22.
        # The production target is asserted above; only this isolated client's
        # target port is redirected to a disposable local protocol fixture.
        target = socket.socket()
        self.addCleanup(target.close)
        target.bind(("127.0.0.1", 0))
        target.listen()
        target.settimeout(5)
        target_port = target.getsockname()[1]
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
            f"PermitListen 127.0.0.1:{forwarded_port}", "AllowTcpForwarding remote", "LogLevel VERBOSE", f"Banner {banner}", "",
        ]))
        subprocess.run(["/usr/sbin/sshd", "-t", "-f", str(server_config)], check=True, timeout=10)
        daemon = subprocess.Popen(
            ["/usr/sbin/sshd", "-D", "-e", "-f", str(server_config)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True,
        )
        if daemon.stderr is not None:
            os.set_blocking(daemon.stderr.fileno(), False)
        client: subprocess.Popen[bytes] | None = None
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

            command = relay.ssh_command(config, self.root)
            forward_index = command.index("-R")
            command[forward_index + 1] = f"127.0.0.1:{forwarded_port}:127.0.0.1:{target_port}"
            client = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
            deadline = time.monotonic() + 10
            while True:
                try:
                    forwarded = socket.create_connection(("127.0.0.1", forwarded_port), timeout=0.1)
                    break
                except OSError:
                    if client.poll() is not None or time.monotonic() >= deadline:
                        details = daemon.stderr.read(16384) if daemon.stderr is not None else b""
                        self.fail(f"Real OpenSSH did not create the exact loopback listener: {details!r}")
                    time.sleep(0.025)
            with forwarded:
                forwarded.settimeout(5)
                accepted, _address = target.accept()
                with accepted:
                    accepted.sendall(b"isolated-target-reached\n")
                    self.assertEqual(forwarded.recv(256), b"isolated-target-reached\n")
            self.assertEqual(Path(f"/proc/{client.pid}/comm").read_text().strip(), "ssh")
            # Reuse pinned/authenticated options, removing only the tunnel
            # and no-session switch for explicitly forbidden requests.
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
            # Public-bind requests cannot satisfy either exact PermitListen.
            denied_public = subprocess.run(
                [*base, "-N", "-R", f"0.0.0.0:{forwarded_port}:127.0.0.1:22", destination],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_public.returncode, 0)
            denied_collision = subprocess.run(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_collision.returncode, 0)
            unknown_key_command = list(command)
            unknown_key_command[unknown_key_command.index("-i") + 1] = str(server_key)
            denied_key = subprocess.run(
                unknown_key_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_key.returncode, 0)
            (self.root / "relay/known_hosts").write_text(f"[127.0.0.1]:{ssh_port} {PUBLIC_KEY}\n")
            denied_host = subprocess.run(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
            )
            self.assertNotEqual(denied_host.returncode, 0)
            for result in (denied_shell, denied_local, denied_remote, denied_public, denied_collision, denied_key, denied_host):
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"")
        finally:
            if client is not None:
                if client.poll() is None:
                    client.terminate()
                try:
                    output, errors = client.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    client.kill()
                    output, errors = client.communicate(timeout=5)
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
        self.assertEqual(output, b"")
        self.assertEqual(errors, b"")


if __name__ == "__main__":
    unittest.main()
