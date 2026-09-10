from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from hexclave_tv_box.network_agent import (
    AgentRequestHandler,
    NetworkManagerController,
    NetworkMode,
    OFFLINE_URL,
    PRODUCTION_URL,
    TEST_SETUP_PASSWORD_ALPHABET,
    TEST_SETUP_PASSWORD_LENGTH,
    TvBoxNetworkAgent,
    _generate_setup_password,
    _failure_code,
    parse_test_renderer_origin,
    resolve_renderer_url,
    serve,
    split_nmcli_line,
    validate_wifi_request,
)
from hexclave_tv_box.policy import ADMIN_CONFIRMATION, NetworkPolicy


class FakeController:
    def __init__(self, *, saved: bool, connected: bool) -> None:
        self.saved = saved
        self.is_connected = connected
        self.setup_ssid = None
        self.setup_password = None
        self.calls: list[str] = []
        self.state_root = Path("/unused")
        self.ap_active = False
        self.setup_generation = 0

    def saved_connections(self) -> list[str]:
        return ["hexclave-tv-network-test"] if self.saved else []

    def connected(self) -> bool:
        return self.is_connected

    def start_setup(self) -> None:
        if self.setup_ssid is not None and self.ap_active:
            return
        self.calls.append("start-setup")
        self.ap_active = True
        self.setup_generation += 1
        self.setup_ssid = "Hexclave TV Box-TEST"
        self.setup_password = "temporary-password" if self.setup_generation == 1 else f"temporary-password-{self.setup_generation}"

    def stop_setup(self) -> None:
        self.calls.append("stop-setup")
        self.setup_ssid = None
        self.setup_password = None
        self.ap_active = False

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


class FakeServices:
    def __init__(self) -> None:
        self.active: set[str] = set()
        self.calls: list[tuple[str, ...]] = []
        self.states: dict[str, tuple[str, str, str]] = {}

    def __call__(self, command: list[str], _timeout: int) -> str:
        if command[0] != "systemctl":
            self.calls.append(tuple(command))
            return ""
        action, name = command[1], command[-1]
        if action == "show":
            state, substate, result = self.states.get(name, ("active", "running", "success") if name in self.active else ("inactive", "dead", "success"))
            return f"ActiveState={state}\nSubState={substate}\nResult={result}\n"
        self.calls.append(tuple(command))
        if action == "start":
            self.active.add(name)
        elif action == "stop":
            self.active.discard(name)
        elif action == "reset-failed":
            self.states.pop(name, None)
        return ""


class BudgetedServices(FakeServices):
    def __init__(self) -> None:
        super().__init__()
        self.starts_since_reset = 0
        self.total_starts = 0

    def __call__(self, command: list[str], timeout: int) -> str:
        if command[-1] == "hexclave-tv-box-kiosk.service":
            if command[1] == "reset-failed":
                self.starts_since_reset = 0
            elif command[1] == "start":
                if self.starts_since_reset >= 5:
                    self.states[command[-1]] = ("failed", "failed", "start-limit-hit")
                    raise subprocess.CalledProcessError(1, command)
                self.starts_since_reset += 1
                self.total_starts += 1
        return super().__call__(command, timeout)


class NetworkAgentTests(unittest.TestCase):
    def test_test_setup_password_is_short_but_still_wpa_personal_compatible(self) -> None:
        password = _generate_setup_password(test_image=True)
        self.assertEqual(len(password), TEST_SETUP_PASSWORD_LENGTH)
        self.assertEqual(TEST_SETUP_PASSWORD_LENGTH, 8)
        self.assertTrue(all(character in TEST_SETUP_PASSWORD_ALPHABET for character in password))

    def test_production_setup_password_keeps_the_high_entropy_length(self) -> None:
        password = _generate_setup_password(test_image=False)
        self.assertGreaterEqual(len(password), 16)

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

    def test_test_image_falls_back_when_boot_origin_is_unreadable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "test-image"
            marker.write_text("test\n", encoding="utf-8")
            origin_file = root / "hexclave-tv-box-test-origin.txt"
            origin_file.write_text("https://pilot-box.trycloudflare.com\n", encoding="utf-8")
            if os.geteuid() == 0:
                class UnreadablePath(type(origin_file)):
                    def read_text(self, *args, **kwargs):
                        raise OSError("origin file is unreadable")

                origin_file = UnreadablePath(origin_file)
            else:
                origin_file.chmod(0)
            self.assertEqual(
                resolve_renderer_url(test_image_marker=marker, test_origin_file=origin_file),
                PRODUCTION_URL,
            )

    def test_frontend_probe_does_not_follow_redirects(self) -> None:
        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", "/redirected")
                self.end_headers()

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            from hexclave_tv_box.network_agent import _frontend_reachable
            self.assertFalse(_frontend_reachable(f"http://127.0.0.1:{server.server_port}"))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_saved_profile_failure_still_advances_retry_throttle(self) -> None:
        class FailingController(FakeController):
            def __init__(self) -> None:
                super().__init__(saved=True, connected=False)
                self.fail_saved_lookup = False

            def saved_connections(self) -> list[str]:
                if self.fail_saved_lookup:
                    raise RuntimeError("NetworkManager unavailable")
                return super().saved_connections()

            def activate_saved_connections(self) -> None:
                self.calls.append("activate-saved")
                self.fail_saved_lookup = True
                self.saved_connections()

        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            controller = FailingController()
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                policy=NetworkPolicy(initial_retry_seconds=100, setup_window_seconds=100, retry_window_seconds=100),
                service_runner=FakeServices(),
                frontend_probe=lambda _url, _timeout: True,
                setup_portal_waiter=lambda _url, _timeout: True,
                monotonic=lambda: now[0],
            )
            agent.state = agent.state.__class__(NetworkMode.STATION_RETRY, 0)
            agent.applied_mode = NetworkMode.STATION_RETRY
            with self.assertRaisesRegex(RuntimeError, "NetworkManager"):
                agent.apply_mode()
            now[0] = 5
            agent.apply_mode()
            self.assertEqual(controller.calls.count("activate-saved"), 1)

    def test_connected_accepts_global_ipv6_but_not_link_local_only(self) -> None:
        responses = iter(("100 (connected)\nOffice\n\n2001:db8::1/64\n", "100 (connected)\nOffice\n\nfe80::1/64\n"))
        commands: list[list[str]] = []
        controller = NetworkManagerController(
            runner=lambda command, _timeout: commands.append(command) or next(responses),
        )
        self.assertTrue(controller.connected())
        self.assertFalse(controller.connected())
        self.assertTrue(any("IP6.ADDRESS" in command for command in commands[0]))

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

    def test_timezone_validation_requires_decodable_installed_timezone_data(self) -> None:
        for timezone in ("UTC", "America/Los_Angeles", "Asia/Kolkata"):
            with self.subTest(timezone=timezone):
                result = validate_wifi_request({"ssid": "Office", "security": "open", "timezone": timezone})
                self.assertEqual(result[-1], timezone)
        for timezone in ("zone.tab", "zone1970.tab", "iso3166.tab", "tzdata.zi", "", "/etc/localtime", "../UTC", "Mars/Olympus"):
            with self.subTest(timezone=timezone), self.assertRaisesRegex(ValueError, "Time zone"):
                validate_wifi_request({"ssid": "Office", "security": "open", "timezone": timezone})

    def test_timezone_validation_does_not_write_os_or_application_state(self) -> None:
        with (
            mock.patch("hexclave_tv_box.network_agent.atomic_write") as writer,
            mock.patch("hexclave_tv_box.network_agent._run") as runner,
            mock.patch("pathlib.Path.write_text") as path_writer,
        ):
            validate_wifi_request({"ssid": "Office", "security": "open", "timezone": "UTC"})
        writer.assert_not_called()
        runner.assert_not_called()
        path_writer.assert_not_called()

    def test_failure_codes_never_contain_command_output_or_arguments(self) -> None:
        command = ["nmcli", "private-network", "private-password"]
        self.assertEqual(_failure_code(subprocess.CalledProcessError(4, command, output="private-password")), "exit-4")
        self.assertEqual(_failure_code(subprocess.TimeoutExpired(command, 30, output="private-password")), "timeout")
        self.assertEqual(_failure_code(ValueError("private-password")), "invalid-request")

    def test_network_transition_logs_are_bounded_and_include_recovery_timing(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            controller = FakeController(saved=True, connected=True)
            services = FakeServices()
            now = [0.0]
            agent = TvBoxNetworkAgent(
                controller, runtime_root=Path(directory), service_runner=services,
                frontend_probe=lambda *_: True, monotonic=lambda: now[0],
            )
            with self.assertLogs("hexclave-tv-box-network", level="INFO") as logs:
                agent.tick()
                initial_count = len(logs.output)
                for value in range(1, 10):
                    now[0] = float(value)
                    agent.tick()
                self.assertEqual(len(logs.output), initial_count)
                now[0] = 10.0
                controller.is_connected = False
                agent.tick()
                now[0] = 35.0
                controller.is_connected = True
                agent.tick()
            output = "\n".join(logs.output)
            self.assertIn("reason=wifi-lost", output)
            self.assertIn("reason=wifi-restored", output)
            self.assertIn("outage-seconds=25.0", output)
            self.assertNotIn("temporary-password", output)
            self.assertNotIn("hexclave-tv-network-test", output)

    def test_wifi_submission_failure_logs_have_only_safe_reason_and_duration(self) -> None:
        controller = FakeController(saved=False, connected=False)
        agent = TvBoxNetworkAgent(controller, service_runner=FakeServices(), monotonic=lambda: 20.0)
        error = subprocess.CalledProcessError(10, ["nmcli", "private-network"], output="private-password")
        with (
            mock.patch.object(controller, "connect", side_effect=error),
            self.assertLogs("hexclave-tv-box-network", level="INFO") as logs,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            agent.handle_request({"command": "connect", "ssid": "private-network", "password": "private-password"})
        output = "\n".join(logs.output)
        self.assertIn("wifi-submission=failed reason=exit-10 duration-seconds=0.0", output)
        self.assertNotIn("private-network", output)
        self.assertNotIn("private-password", output)

    def test_frontend_probe_logs_only_state_edges_not_every_success_or_failure(self) -> None:
        results = iter([False, False, True, True])
        now = [0.0]
        agent = TvBoxNetworkAgent(
            FakeController(saved=True, connected=True), service_runner=FakeServices(),
            frontend_probe=lambda *_: next(results), monotonic=lambda: now[0],
        )
        with self.assertLogs("hexclave-tv-box-network", level="INFO") as logs:
            for minute in range(4):
                now[0] = float(minute * 60)
                agent._probe_frontend_recovery()
        self.assertEqual(len(logs.output), 2)
        self.assertIn("frontend-probe=unreachable", logs.output[0])
        self.assertIn("frontend-probe=reachable observed-outage-seconds=120.0", logs.output[1])

    def test_repeated_policy_failures_are_coalesced_and_recovery_is_logged(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            socket_path = Path(directory) / "control.sock"
            server = mock.Mock()
            agent = mock.Mock()
            agent.tick.side_effect = [OSError(5, "private-details")] * 3 + [None, subprocess.TimeoutExpired(["private-command"], 45)]
            now = [0.0]

            def create_server(_path: str, _agent: object) -> mock.Mock:
                socket_path.touch()
                return server

            def sleep(_seconds: float) -> None:
                now[0] += 5
                if now[0] == 25:
                    raise KeyboardInterrupt

            with (
                mock.patch("hexclave_tv_box.network_agent.AgentServer", side_effect=create_server),
                mock.patch("hexclave_tv_box.network_agent.grp.getgrnam", return_value=mock.Mock(gr_gid=0)),
                mock.patch("hexclave_tv_box.network_agent.os.chown"),
                mock.patch("hexclave_tv_box.network_agent.time.monotonic", side_effect=lambda: now[0]),
                mock.patch("hexclave_tv_box.network_agent.time.sleep", side_effect=sleep),
                self.assertLogs("hexclave-tv-box-network", level="INFO") as logs,
                self.assertRaises(KeyboardInterrupt),
            ):
                serve(agent, socket_path, "test-group")
            self.assertEqual(len(logs.output), 3)
            self.assertIn("network-tick-failed=os-error-5", logs.output[0])
            self.assertIn("network-tick-recovered previous-reason=os-error-5 suppressed-failures=2", logs.output[1])
            self.assertIn("network-tick-failed=timeout", logs.output[2])
            self.assertNotIn("private", "\n".join(logs.output))
            server.shutdown.assert_called_once_with()
            server.server_close.assert_called_once_with()
            self.assertFalse(socket_path.exists())

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
            self.assertIn("GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP6.ADDRESS", commands[0])

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

    def test_saved_profile_activation_retries_at_most_every_thirty_seconds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            controller = FakeController(saved=True, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                policy=NetworkPolicy(initial_retry_seconds=100, setup_window_seconds=100, retry_window_seconds=100),
                service_runner=FakeServices(),
                frontend_probe=lambda _url, _timeout: True,
                setup_portal_waiter=lambda _url, _timeout: True,
                monotonic=lambda: now[0],
            )
            agent.tick()
            self.assertEqual(controller.calls.count("activate-saved"), 1)
            now[0] = 5
            agent.tick()
            self.assertEqual(controller.calls.count("activate-saved"), 1)
            now[0] = 30
            agent.tick()
            self.assertEqual(controller.calls.count("activate-saved"), 2)

    def test_privileged_restart_sets_offline_url_for_station_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller = FakeController(saved=True, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=lambda _command, _timeout: "",
                setup_portal_waiter=lambda _url, _timeout: True,
            )
            agent.state = agent.state.__class__(NetworkMode.STATION_RETRY, 0)
            agent.applied_mode = NetworkMode.STATION_RETRY
            agent.handle_request({"command": "restart-kiosk"}, privileged=True)
            self.assertEqual((Path(directory) / "kiosk-url").read_text(encoding="utf-8"), f"{OFFLINE_URL}\n")

    def test_saved_network_activation_avoids_offline_kiosk_restart_when_it_connects(self) -> None:
        class ConnectingController(FakeController):
            def activate_saved_connections(self) -> None:
                super().activate_saved_connections()
                self.is_connected = True

        with tempfile.TemporaryDirectory() as directory:
            services: list[tuple[str, ...]] = []
            controller = ConnectingController(saved=True, connected=False)
            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=lambda command, _timeout: services.append(tuple(command)) or "",
                frontend_probe=lambda _url, _timeout: True,
                setup_portal_waiter=lambda _url, _timeout: True,
                renderer_url="https://pilot-box.trycloudflare.com/tv-box",
            )

            agent.tick()

            self.assertEqual(agent.state.mode, NetworkMode.CONNECTED)
            self.assertEqual(controller.calls, ["activate-saved", "stop-setup"])
            self.assertEqual(
                (Path(directory) / "kiosk-url").read_text(encoding="utf-8"),
                "https://pilot-box.trycloudflare.com/tv-box\n",
            )
            self.assertIn(("systemctl", "stop", "hexclave-tv-box-kiosk.service"), services)
            self.assertIn(("systemctl", "start", "hexclave-tv-box-kiosk.service"), services)
            self.assertNotIn("file:///", (Path(directory) / "kiosk-url").read_text(encoding="utf-8"))

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
            self.assertIn(("systemctl", "stop", "hexclave-tv-box-kiosk.service"), services)
            self.assertIn(("systemctl", "start", "hexclave-tv-box-kiosk.service"), services)

            agent.handle_request({"command": "reset-network"}, privileged=True)
            self.assertFalse(agent.has_saved_network)

    def test_frontend_origin_recovery_restarts_only_the_kiosk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            now = [0.0]
            probe_results = iter((False, True))
            probed_urls: list[str] = []
            services = FakeServices()
            controller = FakeController(saved=True, connected=True)
            controller.state_root = Path(directory)
            (controller.state_root / "browser").mkdir()
            (controller.state_root / "browser/kiosk-health").write_text(
                "document-failed cage=ready,cog=ready,web-process=ready\n", encoding="utf-8",
            )

            def probe(url: str, _timeout: int) -> bool:
                probed_urls.append(url)
                return next(probe_results)

            agent = TvBoxNetworkAgent(
                controller,
                runtime_root=Path(directory),
                service_runner=services,
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
            services.calls.clear()
            now[0] = 60
            agent.tick()
            self.assertEqual(services.calls, [
                ("systemctl", "reset-failed", "hexclave-tv-box-kiosk.service"),
                ("systemctl", "stop", "hexclave-tv-box-kiosk.service"),
                ("systemctl", "start", "hexclave-tv-box-kiosk.service"),
            ])
            self.assertEqual(probed_urls, [
                "https://pilot-box.trycloudflare.com/tv-box",
                "https://pilot-box.trycloudflare.com/tv-box",
            ])
            self.assertEqual(controller.calls, ["stop-setup"])

    def test_setup_reconciles_a_lost_ap_and_stopped_services_without_mode_change(self) -> None:
        controller = FakeController(saved=False, connected=False)
        services = FakeServices()
        agent = TvBoxNetworkAgent(controller, service_runner=services, setup_portal_waiter=lambda *_: True)
        agent.tick()
        first_password = controller.setup_password
        controller.ap_active = False
        services.active.remove("hexclave-tv-box-setup-display.service")
        services.active.remove("hexclave-tv-box-setup.service")
        services.calls.clear()

        agent.tick()

        self.assertEqual(agent.state.mode, NetworkMode.SETUP)
        self.assertTrue(controller.ap_active)
        self.assertNotEqual(controller.setup_password, first_password)
        self.assertEqual(services.active, {"hexclave-tv-box-setup-display.service", "hexclave-tv-box-setup.service"})
        services.calls.clear()
        agent.tick()
        self.assertEqual(services.calls, [])
        self.assertEqual(controller.setup_generation, 2)

    def test_failed_wifi_join_publishes_the_new_setup_session_to_running_display(self) -> None:
        class RejectingController(FakeController):
            def connect(self, request: dict[str, object]) -> None:
                self.stop_setup()
                raise subprocess.CalledProcessError(4, ["nmcli"])

        controller = RejectingController(saved=False, connected=False)
        services = FakeServices()
        agent = TvBoxNetworkAgent(controller, service_runner=services, setup_portal_waiter=lambda *_: True)
        agent.tick()
        first_status = agent.handle_request({"command": "status"})
        with self.assertRaises(subprocess.CalledProcessError):
            agent.handle_request({"command": "connect"})
        agent.tick()
        next_status = agent.handle_request({"command": "status"})
        self.assertNotEqual(first_status["setupPassword"], next_status["setupPassword"])
        self.assertEqual(next_status["setupPassword"], controller.setup_password)
        self.assertEqual(services.active, {"hexclave-tv-box-setup-display.service", "hexclave-tv-box-setup.service"})

    def test_support_commands_require_a_root_peer_and_reset_confirmation(self) -> None:
        agent = TvBoxNetworkAgent(FakeController(saved=False, connected=False))
        for command in ("restart-kiosk", "reset-network", "reset-pairing", "prepare-factory-reset"):
            with self.subTest(command=command), self.assertRaises(PermissionError):
                agent.handle_request({"command": command, "confirmation": ADMIN_CONFIRMATION})
        for command in ("reset-pairing", "prepare-factory-reset"):
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, "admin-unpair"):
                agent.handle_request({"command": command}, privileged=True)

    def test_pairing_reset_and_support_restart_preserve_setup_and_exact_state_scope(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            controller = FakeController(saved=False, connected=False)
            controller.state_root = Path(directory)
            browser = controller.state_root / "browser"
            browser.mkdir()
            (browser / "cookies.sqlite").write_text("simulated-cookie", encoding="utf-8")
            sibling = controller.state_root / "keep"
            sibling.write_text("keep", encoding="utf-8")
            services = FakeServices()
            agent = TvBoxNetworkAgent(controller, service_runner=services, setup_portal_waiter=lambda *_: True)
            agent.tick()
            password = controller.setup_password
            services.calls.clear()
            agent.handle_request({"command": "reset-pairing", "confirmation": ADMIN_CONFIRMATION}, privileged=True)
            agent.handle_request({"command": "restart-kiosk"}, privileged=True)
            self.assertEqual(list(browser.iterdir()), [])
            self.assertEqual(sibling.read_text(encoding="utf-8"), "keep")
            self.assertEqual(controller.setup_password, password)
            self.assertNotIn(("systemctl", "start", "hexclave-tv-box-kiosk.service"), services.calls)
            self.assertEqual(services.active, {"hexclave-tv-box-setup-display.service", "hexclave-tv-box-setup.service"})

    def test_pairing_reset_blocks_policy_tick_until_store_cleanup_finishes(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            controller = FakeController(saved=True, connected=True)
            controller.state_root = Path(directory)
            services = FakeServices()
            agent = TvBoxNetworkAgent(controller, runtime_root=Path(directory), service_runner=services, frontend_probe=lambda *_: True)
            agent.tick()
            cleanup_entered = threading.Event()
            allow_cleanup = threading.Event()
            tick_finished = threading.Event()
            failures: list[BaseException] = []

            def cleanup(_root: Path, _name: str) -> None:
                cleanup_entered.set()
                if not allow_cleanup.wait(2):
                    raise TimeoutError("Test cleanup was not released.")

            def reset() -> None:
                try:
                    agent.handle_request({"command": "reset-pairing", "confirmation": ADMIN_CONFIRMATION}, privileged=True)
                except (OSError, ValueError) as error:
                    failures.append(error)

            def tick() -> None:
                agent.tick()
                tick_finished.set()

            with mock.patch("hexclave_tv_box.network_agent.clear_exact_state_directory", side_effect=cleanup):
                reset_thread = threading.Thread(target=reset)
                reset_thread.start()
                self.assertTrue(cleanup_entered.wait(2))
                tick_thread = threading.Thread(target=tick)
                tick_thread.start()
                try:
                    self.assertFalse(tick_finished.wait(0.05))
                    self.assertNotIn("hexclave-tv-box-kiosk.service", services.active)
                finally:
                    allow_cleanup.set()
                    reset_thread.join(2)
                    tick_thread.join(2)
            self.assertEqual(failures, [])
            self.assertTrue(tick_finished.is_set())
            self.assertIn("hexclave-tv-box-kiosk.service", services.active)

    def test_factory_reset_preparation_quiesces_ticks_and_removes_only_box_connections(self) -> None:
        controller = FakeController(saved=False, connected=False)
        services = FakeServices()
        agent = TvBoxNetworkAgent(controller, service_runner=services, setup_portal_waiter=lambda *_: True)
        agent.tick()
        agent.handle_request({"command": "prepare-factory-reset", "confirmation": ADMIN_CONFIRMATION}, privileged=True)
        self.assertTrue(agent.maintenance_active)
        self.assertEqual(services.active, set())
        self.assertIsNone(controller.setup_password)
        services.calls.clear()
        agent.tick()
        self.assertEqual(services.calls, [])
        with self.assertRaisesRegex(ValueError, "maintenance"):
            agent.handle_request({"command": "connect"})

    def test_networkmanager_deletion_failure_is_not_reported_as_success(self) -> None:
        def runner(command: list[str], _timeout: int) -> str:
            if "delete" in command:
                raise subprocess.CalledProcessError(1, command)
            return "hexclave-tv-network-test\n"

        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            controller = NetworkManagerController(runtime_root=Path(directory), runner=runner)
            with self.assertRaises(subprocess.CalledProcessError):
                controller._delete_connection("hexclave-tv-network-test")

    def test_reset_deletes_only_saved_box_profiles_in_one_bounded_nmcli_operation(self) -> None:
        commands: list[tuple[list[str], int]] = []

        def runner(command: list[str], timeout: int) -> str:
            commands.append((command, timeout))
            return "hexclave-tv-network-one:wifi\nhexclave-tv-network-two:802-11-wireless\nkeep:wifi\nhexclave-tv-setup:wifi\n"

        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            controller = NetworkManagerController(runtime_root=Path(directory), runner=runner)
            controller.clear_saved_connections()
        deletions = [(command, timeout) for command, timeout in commands if "delete" in command]
        self.assertEqual(deletions, [([
            "nmcli", "--terse", "--escape", "yes", "connection", "delete", "id",
            "hexclave-tv-network-one", "hexclave-tv-network-two",
        ], 30)])

    def test_controller_verifies_actual_ap_activity_before_reusing_credentials(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "identity").mkdir()
            (root / "identity/hostname").write_text("hexclave-tv-test\n", encoding="utf-8")
            active = False
            activations = 0
            profiles: set[str] = set()

            def runner(command: list[str], _timeout: int) -> str:
                nonlocal active, activations
                if "GENERAL.STATE,GENERAL.CONNECTION" in command:
                    return "100 (connected)\nhexclave-tv-setup\n" if active else "30 (disconnected)\n--\n"
                if "--get-values" in command and "NAME" in command:
                    return "\n".join(profiles)
                if "add" in command:
                    profiles.add("hexclave-tv-setup")
                if "delete" in command:
                    profiles.remove("hexclave-tv-setup")
                    active = False
                if "up" in command:
                    active = True
                    activations += 1
                return ""

            controller = NetworkManagerController(state_root=root, runtime_root=root / "run", runner=runner)
            controller.start_setup()
            first_password = controller.setup_password
            controller.start_setup()
            self.assertEqual(activations, 1)
            active = False
            controller.start_setup()
            self.assertEqual(activations, 2)
            self.assertNotEqual(first_password, controller.setup_password)
            self.assertEqual(list((root / "run/secrets").iterdir()), [])

    def test_agent_uses_kernel_peer_identity_instead_of_request_privilege_fields(self) -> None:
        for user_id in (0, 12345):
            with self.subTest(user_id=user_id):
                handler = AgentRequestHandler.__new__(AgentRequestHandler)
                handler.request = mock.Mock()
                handler.request.getsockopt.return_value = struct.pack("3i", 123, user_id, 100)
                handler.rfile = io.BytesIO(b'{"command":"reset-network","privileged":true}\n')
                handler.wfile = io.BytesIO()
                handler.server = mock.Mock()
                handler.server.agent.handle_request.return_value = {"reset": True}
                handler.handle()
                handler.server.agent.handle_request.assert_called_once_with(
                    {"command": "reset-network", "privileged": True}, privileged=user_id == 0,
                )
                self.assertEqual(json.loads(handler.wfile.getvalue()), {"ok": True, "result": {"reset": True}})

    def test_failed_factory_reset_preparation_leaves_policy_recovery_enabled(self) -> None:
        controller = FakeController(saved=False, connected=False)
        services = FakeServices()
        agent = TvBoxNetworkAgent(controller, service_runner=services, setup_portal_waiter=lambda *_: True)
        agent.tick()
        with mock.patch.object(controller, "clear_saved_connections", side_effect=OSError("simulated failure")):
            with self.assertRaises(OSError):
                agent.handle_request({"command": "prepare-factory-reset", "confirmation": ADMIN_CONFIRMATION}, privileged=True)
        self.assertFalse(agent.maintenance_active)
        agent.tick()
        self.assertTrue(controller.ap_active)

    def test_service_reconciliation_preserves_systemd_restart_and_failure_budgets(self) -> None:
        for state, substate, result in (
            ("activating", "auto-restart", "exit-code"),
            ("activating", "start-post", "success"),
            ("deactivating", "stop-sigterm", "success"),
            ("failed", "failed", "start-limit-hit"),
            ("failed", "failed", "exit-code"),
        ):
            with self.subTest(state=state, substate=substate):
                services = FakeServices()
                services.states["hexclave-tv-box-kiosk.service"] = (state, substate, result)
                agent = TvBoxNetworkAgent(FakeController(saved=True, connected=True), service_runner=services)
                agent._reconcile_services()
                self.assertEqual(services.calls, [])

    def test_origin_recovery_does_not_restart_a_failed_or_restarting_kiosk(self) -> None:
        for state, substate in (("failed", "failed"), ("activating", "auto-restart")):
            with self.subTest(state=state):
                services = FakeServices()
                services.states["hexclave-tv-box-kiosk.service"] = (state, substate, "start-limit-hit")
                agent = TvBoxNetworkAgent(FakeController(saved=True, connected=True), service_runner=services, frontend_probe=lambda *_: True)
                agent.frontend_reachable = False
                with mock.patch.object(agent, "_document_recovery_requested", return_value=True):
                    agent._probe_frontend_recovery()
                self.assertEqual(services.calls, [])

    def test_public_origin_flapping_does_not_restart_a_loaded_healthy_application(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            (root / "browser/kiosk-health").write_text("ready cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            services = FakeServices()
            results = iter([False, True] * 6)
            now = [0.0]
            agent = TvBoxNetworkAgent(
                controller, runtime_root=root, service_runner=services, frontend_probe=lambda *_: next(results),
                monotonic=lambda: now[0],
            )
            agent.tick()
            services.calls.clear()
            for minute in range(1, 12):
                now[0] = minute * 60
                agent.tick()
            self.assertEqual(services.calls, [])

    def test_document_recovery_signal_accepts_only_bounded_regular_failure_records(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            path = root / "browser/kiosk-health"
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            agent = TvBoxNetworkAgent(controller)
            self.assertFalse(agent._document_recovery_requested())
            for state in ("document-failed", "document-timeout"):
                path.write_text(f"{state} cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
                self.assertTrue(agent._document_recovery_requested())
            for value in (
                "ready cage=ready,cog=ready,web-process=ready\n",
                "document-loading cage=ready,cog=ready,web-process=ready\n",
                "document-failed cage=ready,cog=ready,web-process=missing\n",
                "document-failed\nanything-else\n",
                "x" * 257,
            ):
                path.write_text(value, encoding="utf-8")
                self.assertFalse(agent._document_recovery_requested())
            path.unlink()
            target = root / "target"
            target.write_text("document-failed cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
            path.symlink_to(target)
            self.assertFalse(agent._document_recovery_requested())
            path.unlink()
            path.mkdir()
            self.assertFalse(agent._document_recovery_requested())

    def test_healthy_wifi_mode_changes_do_not_consume_the_crash_restart_budget(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            (root / "browser/kiosk-health").write_text("ready cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            services = BudgetedServices()
            now = [0.0]
            agent = TvBoxNetworkAgent(
                controller, runtime_root=root, service_runner=services, frontend_probe=lambda *_: True, monotonic=lambda: now[0],
            )
            agent.tick()
            for _ in range(6):
                now[0] += 10
                controller.is_connected = False
                agent.tick()
                now[0] += 10
                controller.is_connected = True
                agent.tick()
            self.assertEqual(services.total_starts, 13)
            self.assertEqual(services.starts_since_reset, 1)
            self.assertEqual(agent.state.mode, NetworkMode.CONNECTED)

    def test_document_only_fast_recovery_does_not_consume_the_crash_restart_budget(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            (root / "browser/kiosk-health").write_text("document-failed cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            services = BudgetedServices()
            now = [0.0]
            results = iter([False, True] * 7)
            agent = TvBoxNetworkAgent(
                controller, runtime_root=root, service_runner=services, frontend_probe=lambda *_: next(results),
                monotonic=lambda: now[0],
            )
            for minute in range(14):
                now[0] = minute * 60
                agent.tick()
            self.assertEqual(services.total_starts, 8)
            self.assertEqual(services.starts_since_reset, 1)

    def test_process_failure_records_never_reset_the_crash_restart_budget(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            path = root / "browser/kiosk-health"
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            for state in ("failed-readiness", "failed-liveness", "stopped", "starting", "degraded"):
                with self.subTest(state=state):
                    path.write_text(f"{state} cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
                    services = BudgetedServices()
                    services.active.add("hexclave-tv-box-kiosk.service")
                    agent = TvBoxNetworkAgent(controller, service_runner=services)
                    for _ in range(5):
                        agent._restart_kiosk()
                    with self.assertRaises(subprocess.CalledProcessError):
                        agent._restart_kiosk()
                    self.assertFalse(any(call[1] == "reset-failed" for call in services.calls))

    def test_stale_healthy_record_does_not_clear_inactive_failed_or_transitional_unit_budget(self) -> None:
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            (root / "browser/kiosk-health").write_text("ready cage=ready,cog=ready,web-process=ready\n", encoding="utf-8")
            controller = FakeController(saved=True, connected=True)
            controller.state_root = root
            for state in ("inactive", "failed", "activating", "deactivating"):
                with self.subTest(state=state):
                    services = FakeServices()
                    services.states["hexclave-tv-box-kiosk.service"] = (state, "simulated", "exit-code")
                    agent = TvBoxNetworkAgent(controller, service_runner=services)
                    agent._restart_kiosk()
                    self.assertNotIn(("systemctl", "reset-failed", "hexclave-tv-box-kiosk.service"), services.calls)

    def test_explicit_support_restart_can_clear_exhausted_display_budget(self) -> None:
        services = FakeServices()
        services.states["hexclave-tv-box-setup-display.service"] = ("failed", "failed", "start-limit-hit")
        controller = FakeController(saved=False, connected=False)
        agent = TvBoxNetworkAgent(controller, service_runner=services)
        agent.handle_request({"command": "restart-kiosk"}, privileged=True)
        self.assertIn("hexclave-tv-box-setup-display.service", services.active)
        self.assertNotIn("hexclave-tv-box-kiosk.service", services.active)
        self.assertTrue(controller.ap_active)

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
