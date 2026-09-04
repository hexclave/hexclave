from __future__ import annotations

import unittest

from hexclave_tv_box.setup_display import format_setup_screen


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


if __name__ == "__main__":
    unittest.main()
