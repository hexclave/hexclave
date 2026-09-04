"""Restricted support and exact-scope reset commands for pilot appliances."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
from collections.abc import Sequence
from pathlib import Path

from .state import RUNTIME_ROOT, STATE_ROOT, clear_exact_state_directory

ADMIN_CONFIRMATION = "CONFIRM-ADMIN-UNPAIRED"
SERVICES = (
    "hexclave-tv-box-kiosk.service",
    "hexclave-tv-box-network.service",
    "hexclave-tv-box-setup-display.service",
    "hexclave-tv-box-setup.service",
)


def run(command: Sequence[str]) -> str:
    result = subprocess.run(  # noqa: S603
        command,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )
    return result.stdout.strip()


def agent_request(request: dict[str, object], socket_path: Path = RUNTIME_ROOT / "control.sock") -> dict[str, object]:
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(30)
        connection.connect(str(socket_path))
        connection.sendall(payload)
        response = connection.makefile("rb").readline(16_385)
    result = json.loads(response)
    if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("result"), dict):
        raise RuntimeError("The TV Box network operation failed.")
    return result["result"]


def diagnostics() -> str:
    lines = ["Hexclave TV Box diagnostics"]
    release = Path("/etc/hexclave-tv-box-release")
    lines.append(release.read_text(encoding="utf-8").strip() if release.exists() else "image-version=unknown")
    device_id = STATE_ROOT / "identity" / "device-id"
    lines.append(f"device-id={device_id.read_text(encoding='utf-8').strip() if device_id.exists() else 'unknown'}")
    checks: tuple[tuple[str, Sequence[str]], ...] = (
        ("uptime", ["uptime", "-p"]),
        ("memory", ["free", "-h"]),
        ("swap", ["swapon", "--show", "--noheadings"]),
        ("disk", ["df", "-h", "/", str(STATE_ROOT)]),
        ("temperature", ["vcgencmd", "measure_temp"]),
        ("throttled", ["vcgencmd", "get_throttled"]),
        ("timesync", ["timedatectl", "show", "--property=NTPSynchronized", "--value"]),
        ("wifi-state", ["nmcli", "--get-values", "GENERAL.STATE", "device", "show", "wlan0"]),
        ("drm", ["sh", "-c", "for f in /sys/class/drm/card*-HDMI-A-*/status; do printf '%s=' \"$(basename \"$(dirname \"$f\")\")\"; cat \"$f\"; done"]),
    )
    for label, command in checks:
        try:
            value = run(command)
        except (OSError, subprocess.SubprocessError):
            value = "unavailable"
        lines.append(f"{label}:\n{value}")
    for service in SERVICES:
        try:
            active = run(["systemctl", "is-active", service])
        except (OSError, subprocess.SubprocessError):
            active = "inactive"
        try:
            restarts = run(["systemctl", "show", service, "--property=NRestarts", "--value"])
        except (OSError, subprocess.SubprocessError):
            restarts = "unknown"
        lines.append(f"service={service} state={active} restarts={restarts}")
    return "\n".join(lines)


def recent_service_logs() -> str:
    return run([
        "journalctl",
        "--no-pager",
        "--output=short-iso",
        "--lines=200",
        "--unit=hexclave-tv-box-firstboot.service",
        "--unit=hexclave-tv-box-network.service",
        "--unit=hexclave-tv-box-setup-display.service",
        "--unit=hexclave-tv-box-setup.service",
        "--unit=hexclave-tv-box-kiosk.service",
    ])


def reset_pairing(state_root: Path, confirmation: str) -> None:
    if confirmation != ADMIN_CONFIRMATION:
        raise ValueError("Pairing reset requires dashboard admin-unpair confirmation.")
    run(["systemctl", "stop", "hexclave-tv-box-kiosk.service"])
    clear_exact_state_directory(state_root, "browser")
    run(["chown", "hexclave-tv:hexclave-tv", str(state_root / "browser")])
    run(["systemctl", "start", "hexclave-tv-box-kiosk.service"])


def factory_reset(state_root: Path, confirmation: str) -> None:
    if confirmation != ADMIN_CONFIRMATION:
        raise ValueError("Factory reset requires dashboard admin-unpair confirmation.")
    # NetworkManager owns an in-memory copy of its profiles. Ask the scoped
    # root agent to remove only Hexclave TV Box profiles before stopping it;
    # deleting files underneath a live NetworkManager process is not enough.
    agent_request({"command": "reset-network"})
    run([
        "systemctl", "stop",
        "hexclave-tv-box-kiosk.service",
        "hexclave-tv-box-setup-display.service",
        "hexclave-tv-box-setup.service",
        "hexclave-tv-box-network.service",
    ])
    # Rotate first so journald closes its active file before exact-scope
    # cleanup. The state helper preserves the bind-mount source directory.
    run(["journalctl", "--rotate"])
    run(["journalctl", "--vacuum-time=1s"])
    for name in ("browser", "network-connections", "journal", "identity", "ssh", "firstboot-state"):
        clear_exact_state_directory(state_root, name)
    run(["systemctl", "reboot"])


def execute(command: str, arguments: list[str], state_root: Path = STATE_ROOT) -> str:
    if command == "diagnostics" and not arguments:
        return diagnostics()
    if command == "recent-logs" and not arguments:
        return recent_service_logs()
    if command == "restart-kiosk" and not arguments:
        run(["systemctl", "restart", "hexclave-tv-box-kiosk.service"])
        return "Kiosk restarted."
    if command == "restart-network" and not arguments:
        run(["systemctl", "restart", "hexclave-tv-box-network.service"])
        return "Network service restarted."
    if command == "reset-network" and not arguments:
        agent_request({"command": "reset-network"})
        return "Saved Hexclave TV Box networks removed; setup mode started."
    if command == "reset-pairing" and len(arguments) == 1:
        reset_pairing(state_root, arguments[0])
        return "Local pairing identity reset."
    if command == "factory-reset" and len(arguments) == 1:
        factory_reset(state_root, arguments[0])
        return "Factory reset scheduled."
    if command in {"reboot", "shutdown"} and not arguments:
        run(["systemctl", "poweroff" if command == "shutdown" else "reboot"])
        return f"{command.capitalize()} scheduled."
    raise ValueError("Unsupported support command or arguments.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Restricted Hexclave TV Box support interface.")
    parser.add_argument("command")
    parser.add_argument("arguments", nargs="*")
    parsed = parser.parse_args()
    print(execute(parsed.command, parsed.arguments))


def forced_command_main() -> None:
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    if original == "":
        print("Allowed commands: diagnostics, recent-logs, restart-kiosk, restart-network, reset-network, reset-pairing, factory-reset, reboot, shutdown")
        return
    # Support commands deliberately use a tiny token grammar; quoting, shell
    # metacharacters and arbitrary paths are never interpreted.
    tokens = original.split(" ")
    if any(token == "" or not all(character.isalnum() or character in "-_" for character in token) for token in tokens):
        raise ValueError("Invalid support command syntax.")
    subprocess.run(["sudo", "-n", "/usr/lib/hexclave-tv-box/support", *tokens], check=True)  # noqa: S603


if __name__ == "__main__":
    main()
