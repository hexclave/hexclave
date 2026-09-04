"""Browser-independent HDMI instructions for first-time Wi-Fi setup."""

from __future__ import annotations

import argparse
import signal
import sys
import time
from collections.abc import Mapping
from pathlib import Path

from .setup_portal import send_agent_request
from .state import RUNTIME_ROOT


def _display_value(status: Mapping[str, object], key: str) -> str:
    value = status.get(key)
    if not isinstance(value, str) or value == "" or not value.isprintable():
        raise RuntimeError("TV Box setup credentials are not ready for display.")
    return value


def format_setup_screen(status: Mapping[str, object]) -> str:
    if status.get("mode") != "setup":
        raise RuntimeError("TV Box is not in Wi-Fi setup mode.")
    network = _display_value(status, "setupSsid")
    password = _display_value(status, "setupPassword")
    return (
        "\033[2J\033[H\033[?25l"
        "\n\n"
        "                         HEXCLAVE TV BOX\n\n"
        "                         Connect this display\n\n"
        "  Join the temporary Wi-Fi network below from your phone or laptop.\n"
        "  The setup page should open automatically.\n\n"
        f"  Network:   {network}\n"
        f"  Password:  {password}\n\n"
        "  If setup does not open, visit http://10.42.0.1\n\n"
        "  Wi-Fi credentials stay only on this TV Box.\n"
    )


def wait_for_setup_status(socket_path: Path, timeout: int) -> Mapping[str, object]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            status = send_agent_request(socket_path, {"command": "status"})
            format_setup_screen(status)
            return status
        except (ConnectionError, OSError, RuntimeError, ValueError):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("TV Box setup credentials did not become ready.")
            time.sleep(min(0.25, remaining))


def main() -> None:
    parser = argparse.ArgumentParser(description="Display local Hexclave TV Box Wi-Fi setup credentials.")
    parser.add_argument("--agent-socket", type=Path, default=RUNTIME_ROOT / "control.sock")
    parser.add_argument("--ready-timeout", type=int, default=15)
    arguments = parser.parse_args()
    if arguments.ready_timeout <= 0:
        raise ValueError("TV Box setup display timeout must be positive.")

    status = wait_for_setup_status(arguments.agent_socket, arguments.ready_timeout)
    sys.stdout.write(format_setup_screen(status))
    sys.stdout.flush()

    def terminate(_signal_number: int, _frame: object) -> None:
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
