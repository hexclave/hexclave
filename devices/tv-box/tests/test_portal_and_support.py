from __future__ import annotations

import tempfile
import threading
import unittest
import json
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from hexclave_tv_box.setup_portal import SetupPortalServer, SubmissionLimiter
from hexclave_tv_box.support import ADMIN_CONFIRMATION, diagnostics, execute, factory_reset, forced_command_main, recent_service_logs, reset_pairing


class PortalAndSupportTests(unittest.TestCase):
    def setUp(self) -> None:
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

    def test_pairing_reset_requires_explicit_admin_confirmation_and_is_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            (root / "browser").mkdir(parents=True)
            (root / "ssh").mkdir()
            (root / "browser" / "cookies.sqlite").write_text("remove", encoding="utf-8")
            (root / "ssh" / "host-key").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "admin-unpair"):
                reset_pairing(root, "NO")
            with mock.patch("hexclave_tv_box.support.run") as runner:
                reset_pairing(root, ADMIN_CONFIRMATION)
            self.assertEqual(list((root / "browser").iterdir()), [])
            self.assertTrue((root / "ssh" / "host-key").exists())
            self.assertEqual(runner.call_count, 3)

    def test_support_interface_rejects_arbitrary_commands(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            execute("shell", ["/bin/sh"])

    def test_recent_logs_are_bounded_to_tv_box_units(self) -> None:
        with mock.patch("hexclave_tv_box.support.run", return_value="logs") as runner:
            self.assertEqual(recent_service_logs(), "logs")
            command = runner.call_args.args[0]
            self.assertIn("--lines=200", command)
            self.assertNotIn("NetworkManager.service", command)
            self.assertIn("--unit=hexclave-tv-box-setup-display.service", command)
            self.assertTrue(all("hexclave-tv-box-" in value for value in command if value.startswith("--unit=")))

    def test_diagnostics_exposes_only_the_public_device_identifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            (state_root / "identity").mkdir()
            (state_root / "identity/device-id").write_text("public-device-id\n", encoding="utf-8")
            with (
                mock.patch("hexclave_tv_box.support.STATE_ROOT", state_root),
                mock.patch("hexclave_tv_box.support.run", return_value="healthy"),
            ):
                result = diagnostics()
        self.assertIn("device-id=public-device-id", result)
        self.assertNotIn("cookie", result.casefold())
        self.assertNotIn("password", result.casefold())

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
            self.assertEqual(calls[0], ("agent", {"command": "reset-network"}))
            self.assertIn(("run", [
                "systemctl", "stop",
                "hexclave-tv-box-kiosk.service",
                "hexclave-tv-box-setup-display.service",
                "hexclave-tv-box-setup.service",
                "hexclave-tv-box-network.service",
            ]), calls)
            self.assertIn(("run", ["journalctl", "--rotate"]), calls)
            self.assertIn(("run", ["journalctl", "--vacuum-time=1s"]), calls)
            self.assertEqual(calls[-1], ("run", ["systemctl", "reboot"]))
            for name in ("browser", "network-connections", "journal", "identity", "ssh", "firstboot-state"):
                self.assertEqual(list((root / name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
