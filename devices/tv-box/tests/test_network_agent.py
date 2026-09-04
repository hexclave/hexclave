from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from hexclave_tv_box.network_agent import (
    NetworkManagerController,
    NetworkMode,
    PRODUCTION_URL,
    TvBoxNetworkAgent,
    parse_test_renderer_origin,
    resolve_renderer_url,
    split_nmcli_line,
    validate_wifi_request,
)
from hexclave_tv_box.policy import NetworkPolicy


class FakeController:
    def __init__(self, *, saved: bool, connected: bool) -> None:
        self.saved = saved
        self.is_connected = connected
        self.setup_ssid = None
        self.setup_password = None
        self.calls: list[str] = []

    def saved_connections(self) -> list[str]:
        return ["hexclave-tv-network-test"] if self.saved else []

    def connected(self) -> bool:
        return self.is_connected

    def start_setup(self) -> None:
        self.calls.append("start-setup")
        self.setup_ssid = "Hexclave TV Box-TEST"
        self.setup_password = "temporary-password"

    def stop_setup(self) -> None:
        self.calls.append("stop-setup")
        self.setup_ssid = None
        self.setup_password = None

    def activate_saved_connections(self) -> None:
        self.calls.append("activate-saved")

    def scan(self) -> list[dict[str, str]]:
        return [{"ssid": "Network", "security": "wpa-personal", "signal": "strong"}]

    def connect(self, request: dict[str, object]) -> None:
        self.calls.append("connect")
        self.saved = True
        self.is_connected = True
        self.setup_ssid = None
        self.setup_password = None

    def clear_saved_connections(self) -> None:
        self.calls.append("clear-saved")
        self.saved = False


class NetworkAgentTests(unittest.TestCase):
    def test_test_renderer_origin_accepts_only_one_exact_quick_tunnel_origin(self) -> None:
        origin = "https://pilot-box.trycloudflare.com"
        self.assertEqual(parse_test_renderer_origin(origin), origin)
        self.assertEqual(parse_test_renderer_origin(f"{origin}\n"), origin)
        self.assertEqual(parse_test_renderer_origin(f"{origin}\r\n"), origin)
        for rejected in (
            "",
            "http://pilot-box.trycloudflare.com",
            "https://*.trycloudflare.com",
            "https://trycloudflare.com",
            "https://nested.pilot-box.trycloudflare.com",
            "https://pilot-box.trycloudflare.com/",
            "https://pilot-box.trycloudflare.com/tv-box",
            "https://pilot-box.trycloudflare.com?preview=true",
            "https://pilot-box.trycloudflare.com:443",
            "https://user@pilot-box.trycloudflare.com",
            "https://PILOT-box.trycloudflare.com",
            f" {origin}",
            f"{origin}\nhttps://other-box.trycloudflare.com\n",
            "https://pilot-box.example.com",
        ):
            with self.subTest(origin=rejected):
                with self.assertRaisesRegex(ValueError, "TV Box test origin"):
                    parse_test_renderer_origin(rejected)

    def test_production_image_ignores_boot_origin_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin_file = root / "hexclave-tv-box-test-origin.txt"
            origin_file.write_text("https://pilot-box.trycloudflare.com\n", encoding="utf-8")
            self.assertEqual(
                resolve_renderer_url(
                    test_image_marker=root / "missing-marker",
                    test_origin_file=origin_file,
                ),
                PRODUCTION_URL,
            )

    def test_test_image_uses_valid_boot_origin_and_rejects_invalid_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "test-image"
            origin_file = root / "hexclave-tv-box-test-origin.txt"
            marker.write_text("test\n", encoding="utf-8")
            origin_file.write_text("https://pilot-box.trycloudflare.com\n", encoding="utf-8")
            self.assertEqual(
                resolve_renderer_url(test_image_marker=marker, test_origin_file=origin_file),
                "https://pilot-box.trycloudflare.com/tv-box",
            )

            origin_file.write_text("https://*.trycloudflare.com\n", encoding="utf-8")
            with self.assertLogs("hexclave-tv-box-network", level="ERROR") as logs:
                result = resolve_renderer_url(test_image_marker=marker, test_origin_file=origin_file)
            self.assertEqual(result, PRODUCTION_URL)
            self.assertIn("test-renderer-origin-rejected", "\n".join(logs.output))

            origin_file.write_bytes(b"\xff\xfe")
            with self.assertLogs("hexclave-tv-box-network", level="ERROR"):
                self.assertEqual(
                    resolve_renderer_url(test_image_marker=marker, test_origin_file=origin_file),
                    PRODUCTION_URL,
                )

    def test_nmcli_escape_parser_preserves_colons_and_backslashes(self) -> None:
        self.assertEqual(split_nmcli_line(r"Office\:West:WPA2:72"), ["Office:West", "WPA2", "72"])
        self.assertEqual(split_nmcli_line(r"Back\\Slash:--:40"), [r"Back\Slash", "--", "40"])

    def test_wifi_validation_rejects_unsupported_or_unsafe_values(self) -> None:
        valid = validate_wifi_request({
            "ssid": "Office",
            "security": "wpa-personal",
            "password": "correct-horse",
            "hidden": False,
            "timezone": "UTC",
        })
        self.assertEqual(valid, ("Office", "wpa-personal", "correct-horse", False, "UTC"))
        with self.assertRaisesRegex(ValueError, "Only open"):
            validate_wifi_request({"ssid": "Corp", "security": "enterprise", "password": "password", "timezone": "UTC"})
        with self.assertRaisesRegex(ValueError, "Only open"):
            validate_wifi_request({"ssid": "Corp", "security": [], "password": "password", "timezone": "UTC"})
        with self.assertRaisesRegex(ValueError, "Time zone"):
            validate_wifi_request({"ssid": "Office", "security": "open", "timezone": "../../etc/passwd"})
        for unsafe_password in ("line-one\nline-two", "pässword1", "short"):
            with self.subTest(password=unsafe_password):
                with self.assertRaisesRegex(ValueError, "printable ASCII"):
                    validate_wifi_request({
                        "ssid": "Office",
                        "security": "wpa-personal",
                        "password": unsafe_password,
                        "timezone": "UTC",
                    })
        with self.assertRaisesRegex(ValueError, "Wi-Fi name"):
            validate_wifi_request({"ssid": "Office\nInjected", "security": "open", "timezone": "UTC"})

    def test_networkmanager_receives_wifi_password_only_through_ephemeral_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands: list[list[str]] = []
            secret = "do-not-place-in-argv"

            def runner(command: list[str], _timeout: int) -> str:
                commands.append(list(command))
                return ""

            controller = NetworkManagerController(state_root=root / "state", runtime_root=root / "run", runner=runner)
            controller.connect({
                "ssid": "Office",
                "security": "wpa-personal",
                "password": secret,
                "hidden": False,
                "timezone": "UTC",
            })
            self.assertNotIn(secret, "\n".join(" ".join(command) for command in commands))
            self.assertTrue(any("passwd-file" in command for command in commands))
            secret_root = root / "run" / "secrets"
            self.assertEqual(list(secret_root.iterdir()), [])

    def test_connected_state_uses_one_bounded_networkmanager_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            commands: list[list[str]] = []

            def runner(command: list[str], _timeout: int) -> str:
                commands.append(list(command))
                return "100 (connected)\nhexclave-tv-network-test\n192.0.2.10/24\n"

            controller = NetworkManagerController(
                state_root=Path(directory) / "state",
                runtime_root=Path(directory) / "run",
                runner=runner,
            )
            self.assertTrue(controller.connected())
            self.assertEqual(len(commands), 1)
            self.assertIn("GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS", commands[0])

    def test_controller_removes_only_stale_ephemeral_secret_files_on_start(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secrets_root = root / "run" / "secrets"
            secrets_root.mkdir(parents=True)
            (secrets_root / "nm-interrupted").write_text("old-secret", encoding="utf-8")
            sibling = root / "run" / "keep"
            sibling.write_text("keep", encoding="utf-8")
            NetworkManagerController(state_root=root / "state", runtime_root=root / "run", runner=lambda _command, _timeout: "")
            self.assertEqual(list(secrets_root.iterdir()), [])
            self.assertEqual(sibling.read_text(encoding="utf-8"), "keep")

    def test_controller_refuses_a_linked_secret_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "keep"
            target.mkdir()
            (target / "value").write_text("keep", encoding="utf-8")
            runtime = root / "run"
            runtime.mkdir()
            (runtime / "secrets").symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symbolic link"):
                NetworkManagerController(state_root=root / "state", runtime_root=runtime, runner=lambda _command, _timeout: "")
            self.assertEqual((target / "value").read_text(encoding="utf-8"), "keep")

    def test_failed_setup_activation_does_not_publish_or_latch_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "state/identity").mkdir(parents=True)
            (root / "state/identity/hostname").write_text("hexclave-tv-abcdef\n", encoding="utf-8")
            activation_attempts = 0

            def runner(command: list[str], _timeout: int) -> str:
                nonlocal activation_attempts
                if "wifi" in command and "list" in command:
                    return ""
                if "connection" in command and "up" in command:
                    activation_attempts += 1
                    raise subprocess.CalledProcessError(10, command)
                return ""

            controller = NetworkManagerController(state_root=root / "state", runtime_root=root / "run", runner=runner)
            for expected_attempts in (1, 2):
                with self.assertRaises(subprocess.CalledProcessError):
                    controller.start_setup()
                self.assertIsNone(controller.setup_ssid)
                self.assertIsNone(controller.setup_password)
                self.assertEqual(activation_attempts, expected_attempts)

    def test_agent_applies_timed_modes_without_backend_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            services: list[tuple[str, ...]] = []
            controller = FakeController(saved=True, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                policy=NetworkPolicy(initial_retry_seconds=5, setup_window_seconds=10, retry_window_seconds=2),
                service_runner=lambda command, _timeout: services.append(tuple(command)) or "",
                frontend_probe=lambda _url, _timeout: True,
                setup_portal_waiter=lambda _url, _timeout: True,
                monotonic=lambda: now[0],
            )
            agent.tick()
            self.assertEqual(agent.state.mode, NetworkMode.STATION_INITIAL)
            self.assertIn("activate-saved", controller.calls)
            now[0] = 5
            agent.tick()
            self.assertEqual(agent.state.mode, NetworkMode.SETUP)
            self.assertEqual(agent.handle_request({"command": "status"})["setupPassword"], "temporary-password")
            self.assertIn(("systemctl", "stop", "hexclave-tv-box-kiosk.service"), services)
            self.assertIn(("systemctl", "start", "hexclave-tv-box-setup-display.service"), services)
            self.assertIn(("systemctl", "start", "hexclave-tv-box-setup.service"), services)
            self.assertNotIn("http://127.0.0.1", (Path(directory) / "kiosk-url").read_text(encoding="utf-8"))

    def test_connect_switches_state_but_leaves_service_stop_for_next_tick(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            services: list[tuple[str, ...]] = []
            controller = FakeController(saved=False, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=lambda command, _timeout: services.append(tuple(command)) or "",
                frontend_probe=lambda _url, _timeout: True,
                setup_portal_waiter=lambda _url, _timeout: True,
                monotonic=lambda: now[0],
            )
            agent.tick()
            before = list(services)
            result = agent.handle_request({
                "command": "connect", "ssid": "Office", "security": "open", "password": None,
                "hidden": False, "timezone": "UTC",
            })
            self.assertEqual(result, {"connected": True})
            self.assertTrue(agent.has_saved_network)
            self.assertEqual(services, before)
            agent.tick()
            self.assertEqual(agent.state.mode, NetworkMode.CONNECTED)
            self.assertIn(("systemctl", "stop", "hexclave-tv-box-setup-display.service"), services)
            self.assertIn(("systemctl", "stop", "hexclave-tv-box-setup.service"), services)
            self.assertIn(("systemctl", "restart", "hexclave-tv-box-kiosk.service"), services)

            agent.handle_request({"command": "reset-network"})
            self.assertFalse(agent.has_saved_network)

    def test_frontend_origin_recovery_restarts_only_the_kiosk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            probe_results = iter((False, True))
            probed_urls: list[str] = []
            services: list[tuple[str, ...]] = []
            controller = FakeController(saved=True, connected=True)

            def probe(url: str, _timeout: int) -> bool:
                probed_urls.append(url)
                return next(probe_results)

            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=lambda command, _timeout: services.append(tuple(command)) or "",
                frontend_probe=probe,
                setup_portal_waiter=lambda _url, _timeout: True,
                monotonic=lambda: now[0],
                renderer_url="https://pilot-box.trycloudflare.com/tv-box",
            )
            agent.tick()
            self.assertEqual(
                (Path(directory) / "kiosk-url").read_text(encoding="utf-8"),
                "https://pilot-box.trycloudflare.com/tv-box\n",
            )
            services.clear()
            now[0] = 60
            agent.tick()
            self.assertEqual(services, [("systemctl", "try-restart", "hexclave-tv-box-kiosk.service")])
            self.assertEqual(probed_urls, [
                "https://pilot-box.trycloudflare.com/tv-box",
                "https://pilot-box.trycloudflare.com/tv-box",
            ])
            self.assertEqual(controller.calls, ["stop-setup"])

    def test_setup_credentials_remain_on_console_when_the_portal_is_slow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            services: list[tuple[str, ...]] = []
            controller = FakeController(saved=False, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=lambda command, _timeout: services.append(tuple(command)) or "",
                setup_portal_waiter=lambda _url, _timeout: False,
            )

            with self.assertRaisesRegex(TimeoutError, "setup portal"):
                agent.tick()

            self.assertIsNone(agent.applied_mode)
            self.assertEqual(controller.setup_password, "temporary-password")
            self.assertLess(
                services.index(("systemctl", "start", "hexclave-tv-box-setup-display.service")),
                services.index(("systemctl", "start", "hexclave-tv-box-setup.service")),
            )
            self.assertNotIn(("systemctl", "restart", "hexclave-tv-box-kiosk.service"), services)


if __name__ == "__main__":
    unittest.main()
