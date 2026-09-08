from __future__ import annotations

import tempfile
import threading
import unittest
import json
import os
from contextlib import nullcontext
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from hexclave_tv_box.setup_portal import SetupPortalServer, SubmissionLimiter
from hexclave_tv_box.kiosk_supervisor import ProcessInfo
from hexclave_tv_box.support import (
    ADMIN_CONFIRMATION,
    _sqlite_store_state,
    diagnostics,
    execute,
    factory_reset,
    forced_command_main,
    previous_service_logs,
    recent_service_logs,
    reset_pairing,
    support_mutation_lock,
)


class PortalAndSupportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.lock_patch = mock.patch("hexclave_tv_box.support.support_mutation_lock", return_value=nullcontext())
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
        ui_root = Path(__file__).resolve().parents[1] / "setup-ui"
        self.server = SetupPortalServer(("127.0.0.1", 0), ui_root=ui_root, agent_socket=Path("/unused"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_submission_limiter_is_bounded_per_client(self) -> None:
        limiter = SubmissionLimiter()
        for _ in range(5):
            self.assertTrue(limiter.allow("10.42.0.2", 10))
        self.assertFalse(limiter.allow("10.42.0.2", 10))
        self.assertTrue(limiter.allow("10.42.0.3", 10))
        self.assertTrue(limiter.allow("10.42.0.2", 71))

    def test_portal_requires_session_csrf_before_forwarding_wifi_secret(self) -> None:
        port = self.server.server_address[1]
        forwarded: list[dict[str, object]] = []

        def agent(_path: Path, request: dict[str, object]) -> dict[str, object]:
            forwarded.append(request)
            if request["command"] == "status":
                return {"mode": "setup", "setupSsid": "Hexclave TV Box-TEST", "setupPassword": "temporary-password"}
            return {"connected": True}

        with mock.patch("hexclave_tv_box.setup_portal.send_agent_request", side_effect=agent):
            connection = HTTPConnection("127.0.0.1", port, timeout=2)
            connection.request("GET", "/api/status")
            status_response = connection.getresponse()
            status = json.loads(status_response.read())
            self.assertEqual(status_response.status, 200)

            body = b'{"command":"reset-network","ssid":"Office","security":"wpa-personal","password":"local-secret","hidden":false,"timezone":"UTC"}'
            connection.request("POST", "/api/wifi", body=body, headers={"Content-Type": "application/json"})
            forbidden = connection.getresponse()
            forbidden.read()
            self.assertEqual(forbidden.status, 403)
            self.assertEqual(len(forwarded), 1)

            connection.request("POST", "/api/wifi", body=body, headers={
                "Content-Type": "application/json",
                "X-Hexclave-CSRF": status["csrfToken"],
            })
            accepted = connection.getresponse()
            accepted.read()
            self.assertEqual(accepted.status, 200)
            self.assertEqual(forwarded[-1]["command"], "connect")
            self.assertEqual(forwarded[-1]["password"], "local-secret")
            connection.close()

    def test_pairing_reset_requires_confirmation_and_uses_the_network_owner(self) -> None:
        with self.assertRaisesRegex(ValueError, "admin-unpair"):
            reset_pairing("NO")
        with (
            mock.patch("hexclave_tv_box.support.run") as runner,
            mock.patch("hexclave_tv_box.support.agent_request", return_value={"reset": True}) as agent,
        ):
            reset_pairing(ADMIN_CONFIRMATION)
        runner.assert_not_called()
        agent.assert_called_once_with({"command": "reset-pairing", "confirmation": ADMIN_CONFIRMATION})

    def test_support_interface_rejects_arbitrary_commands(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            execute("shell", ["/bin/sh"])

    def test_support_kiosk_restart_is_owned_by_the_network_agent(self) -> None:
        with (
            mock.patch("hexclave_tv_box.support.run") as runner,
            mock.patch("hexclave_tv_box.support.agent_request", return_value={"restarted": True}) as agent,
        ):
            self.assertEqual(execute("restart-kiosk", []), "Display reconciled with the current network mode.")
        runner.assert_not_called()
        agent.assert_called_once_with({"command": "restart-kiosk"})

    def test_recent_logs_are_bounded_to_tv_box_units(self) -> None:
        with mock.patch("hexclave_tv_box.support.run", return_value="logs") as runner:
            self.assertEqual(recent_service_logs(), "logs\nlogs")
            self.assertEqual(runner.call_count, 2)
            service_command = runner.call_args_list[0].args[0]
            renderer_command = runner.call_args_list[1].args[0]
            self.assertIn("--lines=200", service_command)
            self.assertIn("--boot=0", service_command)
            self.assertNotIn("NetworkManager.service", service_command)
            self.assertIn("--unit=hexclave-tv-box-setup-display.service", service_command)
            self.assertTrue(
                all("hexclave-tv-box-" in value for value in service_command if value.startswith("--unit="))
            )
            self.assertIn("--lines=200", renderer_command)
            self.assertIn("--boot=0", renderer_command)
            self.assertIn("--identifier=hexclave-tv-box-kiosk", renderer_command)
            self.assertFalse(any(value.startswith("--unit=") for value in renderer_command))

    def test_previous_logs_use_the_same_bounded_tv_box_scope(self) -> None:
        with mock.patch("hexclave_tv_box.support.run", return_value="previous logs") as runner:
            self.assertEqual(previous_service_logs(), "previous logs\nprevious logs")
            self.assertEqual(execute("previous-logs", []), "previous logs\nprevious logs")
            self.assertEqual(runner.call_count, 4)
            for call in runner.call_args_list:
                command = call.args[0]
                self.assertIn("--boot=-1", command)
                self.assertIn("--lines=200", command)
                self.assertNotIn("NetworkManager.service", command)
                self.assertTrue(
                    any(value.startswith("--unit=hexclave-tv-box-") for value in command)
                    or "--identifier=hexclave-tv-box-kiosk" in command
                )

    def test_diagnostics_exposes_only_the_public_device_identifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            runtime_root = state_root / "runtime"
            (state_root / "identity").mkdir()
            runtime_root.mkdir()
            (state_root / "identity/device-id").write_text("public-device-id\n", encoding="utf-8")
            (runtime_root / "kiosk-url").write_text("https://pilot-box.trycloudflare.com/tv-box\n", encoding="utf-8")
            with (
                mock.patch("hexclave_tv_box.support.STATE_ROOT", state_root),
                mock.patch("hexclave_tv_box.support.RUNTIME_ROOT", runtime_root),
                mock.patch("hexclave_tv_box.support.run", return_value="healthy"),
            ):
                result = diagnostics()
        self.assertIn("device-id=public-device-id", result)
        self.assertIn("effective-renderer-url=https://pilot-box.trycloudflare.com/tv-box", result)
        self.assertIn("browser-credential-store=missing", result)
        self.assertNotIn("password", result.casefold())

    def test_browser_credential_diagnostic_reports_only_sqlite_structure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Path(directory) / "cookies.sqlite"
            self.assertEqual(_sqlite_store_state(store), "missing")
            store.write_bytes(b"")
            self.assertEqual(_sqlite_store_state(store), "empty")
            store.write_bytes(b"not a credential database")
            self.assertEqual(_sqlite_store_state(store), "invalid")
            store.write_bytes(b"SQLite format 3\x00" + b"secret-must-not-be-read")
            self.assertEqual(_sqlite_store_state(store), "present")
            target = Path(directory) / "outside"
            target.write_bytes(b"SQLite format 3\x00")
            store.unlink()
            store.symlink_to(target)
            self.assertEqual(_sqlite_store_state(store), "invalid")

    def test_diagnostics_rejects_multiline_runtime_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            runtime_root = state_root / "runtime"
            (state_root / "identity").mkdir()
            runtime_root.mkdir()
            (state_root / "identity/device-id").write_text("public-device-id\n", encoding="utf-8")
            (runtime_root / "kiosk-url").write_text("https://example.com/tv-box\ninjected=value\n", encoding="utf-8")
            with (
                mock.patch("hexclave_tv_box.support.STATE_ROOT", state_root),
                mock.patch("hexclave_tv_box.support.RUNTIME_ROOT", runtime_root),
                mock.patch("hexclave_tv_box.support.run", return_value="healthy"),
            ):
                result = diagnostics()
        self.assertIn("effective-renderer-url=invalid", result)
        self.assertNotIn("injected=value", result)

    def test_diagnostics_reports_only_bounded_kiosk_process_health(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            runtime_root = state_root / "runtime"
            health_path = runtime_root / "kiosk-health"
            (state_root / "identity").mkdir()
            runtime_root.mkdir()
            (state_root / "identity/device-id").write_text("public-device-id\n", encoding="utf-8")
            (runtime_root / "kiosk-url").write_text("https://example.com/tv-box\n", encoding="utf-8")
            health_path.write_text("ready cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")

            def fake_run(command: list[str]) -> str:
                if "--property=MainPID" in command:
                    return "100"
                return "healthy"

            with (
                mock.patch("hexclave_tv_box.support.STATE_ROOT", state_root),
                mock.patch("hexclave_tv_box.support.RUNTIME_ROOT", runtime_root),
                mock.patch("hexclave_tv_box.support.KIOSK_HEALTH_PATH", health_path),
                mock.patch("hexclave_tv_box.support.run", side_effect=fake_run),
                mock.patch("hexclave_tv_box.support.read_process_table", return_value={
                    100: ProcessInfo(1, "python3"),
                    101: ProcessInfo(100, "cage"),
                    102: ProcessInfo(101, "cog"),
                    103: ProcessInfo(102, "WPEWebProcess"),
                    200: ProcessInfo(1, "customer-process-name-must-not-appear"),
                }),
            ):
                result = diagnostics()

        self.assertIn("kiosk-process-health=supervisor=ready,cage=ready,cog=ready,web-process=ready", result)
        self.assertIn("kiosk-health-state=ready cage=ready,cog=ready,web-process=ready", result)
        self.assertNotIn("customer-process", result)

    def test_forced_support_command_never_interprets_shell_syntax(self) -> None:
        with (
            mock.patch.dict("os.environ", {"SSH_ORIGINAL_COMMAND": "diagnostics; id"}),
            mock.patch("hexclave_tv_box.support.subprocess.run") as runner,
        ):
            with self.assertRaisesRegex(ValueError, "Invalid support command syntax"):
                forced_command_main()
            runner.assert_not_called()

        with (
            mock.patch.dict("os.environ", {"SSH_ORIGINAL_COMMAND": "diagnostics"}),
            mock.patch("hexclave_tv_box.support.subprocess.run") as runner,
        ):
            forced_command_main()
            runner.assert_called_once_with(
                ["sudo", "-n", "/usr/lib/hexclave-tv-box/support", "diagnostics"],
                check=True,
            )

    def test_factory_reset_removes_networkmanager_state_before_local_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            for name in ("browser", "network-connections", "journal", "identity", "ssh", "firstboot-state"):
                (root / name).mkdir(parents=True)
                (root / name / "value").write_text("remove", encoding="utf-8")
            calls: list[tuple[str, object]] = []
            with (
                mock.patch("hexclave_tv_box.support.agent_request", side_effect=lambda request: calls.append(("agent", request)) or {"reset": True}),
                mock.patch("hexclave_tv_box.support.run", side_effect=lambda command: calls.append(("run", command)) or ""),
            ):
                factory_reset(root, ADMIN_CONFIRMATION)
            self.assertEqual(calls[0], ("agent", {"command": "prepare-factory-reset", "confirmation": ADMIN_CONFIRMATION}))
            self.assertIn(("run", [
                "systemctl", "stop",
                "hexclave-tv-box-network.service",
            ]), calls)
            self.assertIn(("run", ["journalctl", "--rotate"]), calls)
            self.assertIn(("run", ["journalctl", "--vacuum-time=1s"]), calls)
            self.assertEqual(calls[-1], ("run", ["systemctl", "reboot"]))
            for name in ("browser", "network-connections", "journal", "identity", "ssh", "firstboot-state"):
                self.assertEqual(list((root / name).iterdir()), [])

    @unittest.skipUnless(os.geteuid() == 0, "The production support lock requires a root owner.")
    def test_support_mutation_lock_serializes_independent_sessions(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            path = Path(directory) / "support.lock"
            second_attempted = threading.Event()
            second_entered = threading.Event()

            def second_session() -> None:
                second_attempted.set()
                with support_mutation_lock(path):
                    second_entered.set()

            with support_mutation_lock(path):
                thread = threading.Thread(target=second_session)
                thread.start()
                self.assertTrue(second_attempted.wait(2))
                self.assertFalse(second_entered.wait(0.05))
            thread.join(2)
            self.assertTrue(second_entered.is_set())

    def test_support_mutation_lock_rejects_symlink_and_non_private_files(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("keep", encoding="utf-8")
            linked = root / "linked"
            linked.symlink_to(target)
            with self.assertRaises(OSError), support_mutation_lock(linked):
                self.fail("A linked support lock must be rejected.")
            target.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private root-owned"), support_mutation_lock(target):
                self.fail("A public support lock must be rejected.")
            fifo = root / "fifo"
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(OSError), support_mutation_lock(fifo):
                self.fail("A FIFO must not block the support lock opener.")
            self.assertEqual(target.read_text(encoding="utf-8"), "keep")

    def test_all_mutating_support_commands_use_the_shared_lock_but_diagnostics_do_not(self) -> None:
        for command, arguments in (
            ("restart-kiosk", []), ("restart-network", []), ("reset-network", []),
            ("reset-pairing", [ADMIN_CONFIRMATION]), ("factory-reset", [ADMIN_CONFIRMATION]),
            ("reboot", []), ("shutdown", []), ("diagnostics", []), ("recent-logs", []),
        ):
            with (
                self.subTest(command=command),
                mock.patch("hexclave_tv_box.support.support_mutation_lock", return_value=nullcontext()) as lock,
                mock.patch("hexclave_tv_box.support._execute", return_value="completed"),
            ):
                self.assertEqual(execute(command, arguments), "completed")
                self.assertEqual(lock.call_count, 0 if command in {"diagnostics", "recent-logs"} else 1)

    @unittest.skipUnless(os.geteuid() == 0, "The production support lock requires a root owner.")
    def test_factory_reset_excludes_network_restart_while_diagnostics_remain_accessible(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory) / "state"
            root.mkdir()
            for name in ("browser", "network-connections", "journal", "identity", "ssh", "firstboot-state"):
                (root / name).mkdir()
                (root / name / "simulated-state").write_text("remove", encoding="utf-8")
            lock_path = Path(directory) / "support.lock"
            cleanup_entered = threading.Event()
            release_cleanup = threading.Event()
            restart_attempted = threading.Event()
            restart_entered = threading.Event()
            failures: list[Exception] = []
            commands: list[list[str]] = []

            def runner(command: list[str]) -> str:
                commands.append(command)
                if command == ["journalctl", "--rotate"]:
                    cleanup_entered.set()
                    if not release_cleanup.wait(2):
                        raise TimeoutError("Test reset cleanup was not released.")
                if command == ["systemctl", "restart", "hexclave-tv-box-network.service"]:
                    restart_entered.set()
                return ""

            def reset_session() -> None:
                try:
                    execute("factory-reset", [ADMIN_CONFIRMATION], root)
                except (OSError, ValueError, RuntimeError) as error:
                    failures.append(error)

            def restart_session() -> None:
                restart_attempted.set()
                try:
                    execute("restart-network", [], root)
                except (OSError, ValueError, RuntimeError) as error:
                    failures.append(error)

            with (
                mock.patch("hexclave_tv_box.support.support_mutation_lock", side_effect=lambda: support_mutation_lock(lock_path)),
                mock.patch("hexclave_tv_box.support.agent_request", return_value={"prepared": True}),
                mock.patch("hexclave_tv_box.support.run", side_effect=runner),
                mock.patch("hexclave_tv_box.support.diagnostics", return_value="diagnostics remain available"),
            ):
                reset_thread = threading.Thread(target=reset_session)
                reset_thread.start()
                self.assertTrue(cleanup_entered.wait(2))
                restart_thread = threading.Thread(target=restart_session)
                restart_thread.start()
                try:
                    self.assertTrue(restart_attempted.wait(2))
                    self.assertFalse(restart_entered.wait(0.05))
                    self.assertEqual(execute("diagnostics", [], root), "diagnostics remain available")
                finally:
                    release_cleanup.set()
                    reset_thread.join(2)
                    restart_thread.join(2)
            self.assertEqual(failures, [])
            self.assertTrue(restart_entered.is_set())
            self.assertLess(
                commands.index(["systemctl", "reboot"]),
                commands.index(["systemctl", "restart", "hexclave-tv-box-network.service"]),
            )


if __name__ == "__main__":
    unittest.main()
