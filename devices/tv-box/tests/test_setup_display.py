from __future__ import annotations

import io
import unittest
from unittest import mock

from hexclave_tv_box.setup_display import format_setup_screen, main


class SetupDisplayTests(unittest.TestCase):
    def test_screen_contains_only_the_local_setup_instructions_and_credentials(self) -> None:
        screen = format_setup_screen({
            "mode": "setup",
            "setupSsid": "Hexclave TV Box-61B4",
            "setupPassword": "temporary-password",
        })

        self.assertIn("Hexclave TV Box-61B4", screen)
        self.assertIn("temporary-password", screen)
        self.assertIn("http://10.42.0.1", screen)
        self.assertNotIn("app.hexclave.com", screen)

    def test_screen_refuses_non_setup_or_terminal_control_values(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "not in Wi-Fi setup mode"):
            format_setup_screen({
                "mode": "connected",
                "setupSsid": "Hexclave TV Box-61B4",
                "setupPassword": "temporary-password",
            })
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            format_setup_screen({
                "mode": "setup",
                "setupSsid": "Hexclave TV Box-61B4\033[2J",
                "setupPassword": "temporary-password",
            })

    def test_running_console_repaints_when_failed_join_rotates_credentials(self) -> None:
        initial = {"mode": "setup", "setupSsid": "Simulated AP", "setupPassword": "password-before"}
        next_status = {**initial, "setupPassword": "password-after"}
        output = io.StringIO()
        with (
            mock.patch("sys.argv", ["setup-display"]),
            mock.patch("sys.stdout", output),
            mock.patch("hexclave_tv_box.setup_display.wait_for_setup_status", return_value=initial),
            mock.patch("hexclave_tv_box.setup_display.send_agent_request", return_value=next_status),
            mock.patch("hexclave_tv_box.setup_display.signal.signal"),
            mock.patch("hexclave_tv_box.setup_display.time.sleep", side_effect=[None, None, SystemExit(0)]),
            self.assertRaises(SystemExit),
        ):
            main()
        self.assertEqual(output.getvalue().count("password-before"), 1)
        self.assertEqual(output.getvalue().count("password-after"), 1)

    def test_running_console_recovers_after_temporary_agent_failure(self) -> None:
        initial = {"mode": "setup", "setupSsid": "Simulated AP", "setupPassword": "password-before"}
        output = io.StringIO()
        with (
            mock.patch("sys.argv", ["setup-display"]),
            mock.patch("sys.stdout", output),
            mock.patch("hexclave_tv_box.setup_display.wait_for_setup_status", return_value=initial),
            mock.patch("hexclave_tv_box.setup_display.send_agent_request", side_effect=[ConnectionError(), {**initial, "setupPassword": "password-after"}]),
            mock.patch("hexclave_tv_box.setup_display.signal.signal"),
            mock.patch("hexclave_tv_box.setup_display.time.sleep", side_effect=[None, None, SystemExit(0)]),
            self.assertLogs("hexclave-tv-box-setup-display", level="WARNING") as logs,
            self.assertRaises(SystemExit),
        ):
            main()
        self.assertIn("password-after", output.getvalue())
        self.assertNotIn("password-before", "\n".join(logs.output))
        self.assertNotIn("password-after", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
