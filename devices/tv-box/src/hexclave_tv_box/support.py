"""Restricted support and exact-scope reset commands for pilot appliances."""

from __future__ import annotations

import argparse
import errno
import json
import os
import socket
import stat
import subprocess
from collections.abc import Sequence
from pathlib import Path

from .kiosk_supervisor import read_process_table, renderer_health
from .state import RUNTIME_ROOT, STATE_ROOT, clear_exact_state_directory

ADMIN_CONFIRMATION = "CONFIRM-ADMIN-UNPAIRED"
SERVICES = (
    "hexclave-tv-box-kiosk.service",
    "hexclave-tv-box-network.service",
    "hexclave-tv-box-setup-display.service",
    "hexclave-tv-box-setup.service",
)
MAX_DIAGNOSTIC_FILE_BYTES = 2_048
KIOSK_HEALTH_PATH = STATE_ROOT / "browser" / "kiosk-health"
KIOSK_LOG_IDENTIFIER = "hexclave-tv-box-kiosk"
SQLITE_HEADER = b"SQLite format 3\x00"


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


def _diagnostic_file_value(path: Path) -> str:
    try:
        raw_value = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return "unavailable"
    if len(raw_value.encode("utf-8")) > MAX_DIAGNOSTIC_FILE_BYTES:
        return "invalid"
    lines = raw_value.splitlines()
    if len(lines) != 1 or raw_value not in {lines[0], f"{lines[0]}\n", f"{lines[0]}\r\n"} or not lines[0].isprintable():
        return "invalid"
    return lines[0]


def _sqlite_store_state(path: Path) -> str:
    """Report only structural state; never inspect or expose credential rows."""
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return "missing"
    except OSError as error:
        return "invalid" if error.errno == errno.ELOOP else "unavailable"
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return "invalid"
        if metadata.st_size == 0:
            return "empty"
        header = os.read(descriptor, len(SQLITE_HEADER))
    except OSError:
        return "unavailable"
    finally:
        os.close(descriptor)
    return "present" if header == SQLITE_HEADER else "invalid"


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
    # This is the root-written public document URL, never a credential or an
    # API token. Reporting the effective value distinguishes production from
    # an explicitly enabled test-image origin without broad shell access.
    lines.append(f"effective-renderer-url={_diagnostic_file_value(RUNTIME_ROOT / 'kiosk-url')}")
    lines.append(f"browser-credential-store={_sqlite_store_state(STATE_ROOT / 'browser' / 'cookies.sqlite')}")
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
        ("active-vt", ["fgconsole"]),
        ("seat0-active-session", ["loginctl", "show-seat", "seat0", "--property=ActiveSession", "--value"]),
        ("sessions", ["loginctl", "list-sessions", "--no-legend", "--no-pager"]),
        ("renderer-account", ["id", "hexclave-tv"]),
        ("tty1", ["stat", "--format=%n mode=%a owner=%U group=%G", "/dev/tty1"]),
        ("drm-card", ["stat", "--format=%n mode=%a owner=%U group=%G", "/dev/dri/card0"]),
        ("drm-render", ["stat", "--format=%n mode=%a owner=%U group=%G", "/dev/dri/renderD128"]),
        ("cage-version", ["cage", "-v"]),
        ("cog-version", ["cog", "--version"]),
        ("kiosk-main-pid", ["systemctl", "show", "hexclave-tv-box-kiosk.service", "--property=MainPID", "--value"]),
    )
    for label, command in checks:
        try:
            value = run(command)
        except (OSError, subprocess.SubprocessError):
            value = "unavailable"
        lines.append(f"{label}:\n{value}")
    try:
        kiosk_pid_value = run([
            "systemctl", "show", "hexclave-tv-box-kiosk.service", "--property=MainPID", "--value",
        ])
        kiosk_pid = int(kiosk_pid_value)
        supervisor_processes = read_process_table()
        supervisor = supervisor_processes.get(kiosk_pid)
        cage_processes = [
            pid
            for pid, info in supervisor_processes.items()
            if info.parent_pid == kiosk_pid and info.name == "cage"
        ]
        if supervisor is None or supervisor.name != "python3" or len(cage_processes) != 1:
            process_health = "supervisor=missing,cage=missing,cog=missing,web-process=missing"
        else:
            health = renderer_health(supervisor_processes, cage_processes[0])
            process_health = f"supervisor=ready,{health.summary()}"
    except (OSError, subprocess.SubprocessError, ValueError):
        process_health = "unavailable"
    lines.append(f"kiosk-process-health={process_health}")
    lines.append(
        "kiosk-health-state="
        f"{_diagnostic_file_value(KIOSK_HEALTH_PATH)}"
    )
    wayland_runtime = Path("/run/hexclave-tv-box-wayland")
    try:
        runtime_stat = wayland_runtime.stat()
        sockets = sorted(
            path.name
            for path in wayland_runtime.iterdir()
            if path.name.startswith("wayland-") and path.is_socket()
        )
        wayland_status = (
            f"mode={runtime_stat.st_mode & 0o777:o},uid={runtime_stat.st_uid},gid={runtime_stat.st_gid},"
            f"sockets={','.join(sockets) if len(sockets) > 0 else 'none'}"
        )
    except OSError:
        wayland_status = "unavailable"
    lines.append(f"wayland-runtime={wayland_status}")
    lines.append(
        "cog-wayland-module="
        f"{'present' if Path('/usr/lib/arm-linux-gnueabihf/cog/modules/libcogplatform-wl.so').is_file() else 'missing'}"
    )
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


def _bounded_service_logs(boot: str) -> str:
    if boot not in {"0", "-1"}:
        raise ValueError("TV Box diagnostic boot selector is invalid.")
    service_logs = run([
        "journalctl",
        "--no-pager",
        "--output=short-iso",
        f"--boot={boot}",
        "--lines=200",
        "--unit=hexclave-tv-box-firstboot.service",
        "--unit=hexclave-tv-box-network.service",
        "--unit=hexclave-tv-box-setup-display.service",
        "--unit=hexclave-tv-box-setup.service",
        "--unit=hexclave-tv-box-kiosk.service",
    ])
    # PAM/logind may associate the renderer process with its interactive
    # session scope instead of the originating system service. The explicit
    # identifier preserves those bounded diagnostics without exposing the
    # rest of the system journal.
    renderer_logs = run([
        "journalctl",
        "--no-pager",
        "--output=short-iso",
        f"--boot={boot}",
        "--lines=200",
        f"--identifier={KIOSK_LOG_IDENTIFIER}",
    ])
    sections = [section for section in (service_logs, renderer_logs) if section != ""]
    return "\n".join(sections)


def recent_service_logs() -> str:
    return _bounded_service_logs("0")


def previous_service_logs() -> str:
    return _bounded_service_logs("-1")


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
    if command == "previous-logs" and not arguments:
        return previous_service_logs()
    if command == "restart-kiosk" and not arguments:
        # Keep shutdown and startup as independently bounded operations. A
        # wedged Cog/Cage shutdown may require the unit's SIGKILL fallback but
        # must not consume the timeout of the subsequent start operation.
        run(["systemctl", "stop", "hexclave-tv-box-kiosk.service"])
        run(["systemctl", "start", "hexclave-tv-box-kiosk.service"])
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
        print("Allowed commands: diagnostics, recent-logs, previous-logs, restart-kiosk, restart-network, reset-network, reset-pairing, factory-reset, reboot, shutdown")
        return
    # Support commands deliberately use a tiny token grammar; quoting, shell
    # metacharacters and arbitrary paths are never interpreted.
    tokens = original.split(" ")
    if any(token == "" or not all(character.isalnum() or character in "-_" for character in token) for token in tokens):
        raise ValueError("Invalid support command syntax.")
    subprocess.run(["sudo", "-n", "/usr/lib/hexclave-tv-box/support", *tokens], check=True)  # noqa: S603


if __name__ == "__main__":
    main()
