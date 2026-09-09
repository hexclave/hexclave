"""Restricted support and exact-scope reset commands for pilot appliances."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import re
import socket
import stat
import subprocess
import sys
import syslog
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from .kiosk_supervisor import read_process_table, renderer_health
from .network_agent import OFFLINE_URL, PRODUCTION_URL, SETUP_URL, parse_test_renderer_origin
from .policy import ADMIN_CONFIRMATION
from .relay import relay_diagnostics, relay_enrollment_public_key
from .state import RUNTIME_ROOT, STATE_ROOT, clear_exact_state_directory

SERVICES = (
    "hexclave-tv-box-kiosk.service",
    "hexclave-tv-box-network.service",
    "hexclave-tv-box-setup-display.service",
    "hexclave-tv-box-setup.service",
    "hexclave-tv-box-relay.service",
)
MAX_DIAGNOSTIC_FILE_BYTES = 2_048
KIOSK_HEALTH_PATH = STATE_ROOT / "browser" / "kiosk-health"
KIOSK_LOG_IDENTIFIER = "hexclave-tv-box-kiosk"
SUPPORT_LOG_IDENTIFIER = "hexclave-tv-box-support"
FACTORY_RESET_JOB_PATH = "/usr/lib/hexclave-tv-box/factory-reset-job"
SQLITE_HEADER = b"SQLite format 3\x00"
SUPPORT_MUTATION_LOCK_PATH = Path("/run/hexclave-tv-box-support.lock")
MUTATING_COMMANDS = frozenset({
    "restart-kiosk", "restart-network", "reset-network", "reset-pairing", "factory-reset", "reboot", "shutdown",
})
READ_ONLY_COMMANDS = frozenset({"diagnostics", "recent-logs", "previous-logs"})
KIOSK_HEALTH_PATTERN = re.compile(
    r"(?:starting|stopping|exited|ready|failed-readiness|failed-liveness|degraded|document-loading|document-failed|document-timeout)"
    r"(?: cage=(?:ready|missing),cog=(?:ready|missing),web-process=(?:ready|missing))?"
)


def _support_session_pid() -> int | None:
    """Correlate with native sshd certificate logs, not client-supplied identity."""
    try:
        processes = read_process_table()
    except OSError:
        return None
    pid = os.getppid()
    # sudo may have a monitor process between the helper and forced command.
    # Do not log argv or accept an operator name through the SSH environment.
    for _ in range(8):
        process = processes.get(pid)
        if process is None or pid <= 1:
            return None
        if process.name in {"sshd", "sshd-session"}:
            return pid
        pid = process.parent_pid
    return None


def _audit_event(message: str) -> None:
    try:
        syslog.openlog(SUPPORT_LOG_IDENTIFIER, syslog.LOG_PID, syslog.LOG_AUTHPRIV)
        syslog.syslog(syslog.LOG_INFO, message)
    except OSError:
        # Reporting failure after a completed reset must not imply that reset
        # was rolled back or encourage an automatic duplicate destructive call.
        print("WARNING: TV Box support audit delivery failed.", file=sys.stderr)


def _validate_support_command(command: str, arguments: list[str]) -> None:
    if command in {"reset-pairing", "factory-reset"}:
        if arguments != [ADMIN_CONFIRMATION]:
            raise ValueError("Pairing reset requires dashboard admin-unpair confirmation.")
    elif command not in READ_ONLY_COMMANDS | MUTATING_COMMANDS or arguments:
        raise ValueError("Unsupported support command or arguments.")


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


@contextmanager
def _diagnostic_descriptor(path: Path) -> Iterator[int]:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Diagnostic paths must be absolute and confined.")
    # Walk with directory descriptors: a renamed renderer-owned directory or
    # an ancestor symlink must not redirect a root support read elsewhere.
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent)
            parent = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Diagnostic targets must be regular files.")
        yield descriptor
    finally:
        os.close(descriptor)


def _diagnostic_text(path: Path) -> str:
    with _diagnostic_descriptor(path) as descriptor:
        if os.fstat(descriptor).st_size > MAX_DIAGNOSTIC_FILE_BYTES:
            raise ValueError("Diagnostic file exceeds the bounded size.")
        contents = os.read(descriptor, MAX_DIAGNOSTIC_FILE_BYTES + 1)
    if len(contents) > MAX_DIAGNOSTIC_FILE_BYTES:
        raise ValueError("Diagnostic file exceeds the bounded size.")
    return contents.decode("utf-8")


def _diagnostic_file_value(path: Path) -> str:
    try:
        raw_value = _diagnostic_text(path)
    except ValueError:
        return "invalid"
    except OSError as error:
        return "invalid" if error.errno in {errno.ELOOP, errno.ENOTDIR} else "unavailable"
    except UnicodeError:
        return "unavailable"
    lines = raw_value.splitlines()
    if len(lines) != 1 or raw_value not in {lines[0], f"{lines[0]}\n", f"{lines[0]}\r\n"} or not lines[0].isprintable():
        return "invalid"
    return lines[0]


def _kiosk_health_diagnostic(path: Path) -> str:
    value = _diagnostic_file_value(path)
    if value in {"invalid", "unavailable"} or KIOSK_HEALTH_PATTERN.fullmatch(value):
        return value
    return "invalid"


def _renderer_url_diagnostic(path: Path) -> str:
    value = _diagnostic_file_value(path)
    if value in {"invalid", "unavailable", PRODUCTION_URL, OFFLINE_URL, SETUP_URL}:
        return value
    if value.endswith("/tv-box"):
        try:
            parse_test_renderer_origin(value[:-len("/tv-box")])
            return value
        except ValueError:
            pass
    return "invalid"


def _release_diagnostic(path: Path) -> str:
    try:
        value = _diagnostic_text(path)
    except FileNotFoundError:
        return "image-version=unknown"
    except (OSError, ValueError, UnicodeError):
        return "image-version=invalid"
    patterns = {
        "image-version": r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?",
        "image-channel": r"(?:test|production)",
        "renderer-url": re.escape(PRODUCTION_URL),
        "source-commit": r"[a-f0-9]{40}",
        "wifi-region": r"[A-Z]{2}",
    }
    seen: set[str] = set()
    for line in value.splitlines():
        field, separator, item = line.partition("=")
        if separator != "=" or field in seen or field not in patterns or re.fullmatch(patterns[field], item) is None:
            return "image-version=invalid"
        seen.add(field)
    return value.strip() if seen == set(patterns) else "image-version=invalid"


def _sqlite_store_state(path: Path) -> str:
    """Report only structural state; never inspect or expose credential rows."""
    try:
        with _diagnostic_descriptor(path) as descriptor:
            if os.fstat(descriptor).st_size == 0:
                return "empty"
            header = os.read(descriptor, len(SQLITE_HEADER))
    except FileNotFoundError:
        return "missing"
    except ValueError:
        return "invalid"
    except OSError as error:
        return "invalid" if error.errno in {errno.ELOOP, errno.ENOTDIR} else "unavailable"
    return "present" if header == SQLITE_HEADER else "invalid"


def agent_request(request: dict[str, object], socket_path: Path = RUNTIME_ROOT / "control.sock") -> dict[str, object]:
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        # A support transaction can include bounded renderer shutdown and
        # NetworkManager operations; it must outlive those component budgets.
        connection.settimeout(600)
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
    lines.append(_release_diagnostic(release))
    device_id = STATE_ROOT / "identity" / "device-id"
    lines.append(f"device-id={_diagnostic_file_value(device_id)}")
    # This is the root-written public document URL, never a credential or an
    # API token. Reporting the effective value distinguishes production from
    # an explicitly enabled test-image origin without broad shell access.
    lines.append(f"effective-renderer-url={_renderer_url_diagnostic(RUNTIME_ROOT / 'kiosk-url')}")
    lines.append(f"browser-credential-store={_sqlite_store_state(STATE_ROOT / 'browser' / 'cookies.sqlite')}")
    lines.extend(relay_diagnostics(state_root=STATE_ROOT))
    lines.append(f"relay-enrollment-public-key={relay_enrollment_public_key(state_root=STATE_ROOT)}")
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
        f"{_kiosk_health_diagnostic(KIOSK_HEALTH_PATH)}"
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
        "--unit=hexclave-tv-box-relay.service",
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
        f"SYSLOG_IDENTIFIER={KIOSK_LOG_IDENTIFIER}",
        "+",
        f"SYSLOG_IDENTIFIER={SUPPORT_LOG_IDENTIFIER}",
        "_UID=0",
    ])
    sections = [section for section in (service_logs, renderer_logs) if section != ""]
    return "\n".join(sections)


def recent_service_logs() -> str:
    return _bounded_service_logs("0")


def previous_service_logs() -> str:
    return _bounded_service_logs("-1")


def reset_pairing(confirmation: str) -> None:
    if confirmation != ADMIN_CONFIRMATION:
        raise ValueError("Pairing reset requires dashboard admin-unpair confirmation.")
    agent_request({"command": "reset-pairing", "confirmation": confirmation})


def factory_reset(state_root: Path, confirmation: str) -> None:
    if confirmation != ADMIN_CONFIRMATION:
        raise ValueError("Factory reset requires dashboard admin-unpair confirmation.")
    # Stop the outbound client before erasing its exact per-device identity.
    # The caller is a systemd-owned job, so closing the support connection
    # cannot terminate cleanup. Relay-side revocation remains an operator duty.
    run(["systemctl", "stop", "hexclave-tv-box-relay.service"])
    # NetworkManager owns an in-memory copy of its profiles. Ask the scoped
    # root agent to remove only Hexclave TV Box profiles before stopping it;
    # deleting files underneath a live NetworkManager process is not enough.
    agent_request({"command": "prepare-factory-reset", "confirmation": confirmation})
    run(["systemctl", "stop", "hexclave-tv-box-network.service"])
    # Rotate first so journald closes its active file before exact-scope
    # cleanup. The state helper preserves the bind-mount source directory.
    run(["journalctl", "--rotate"])
    run(["journalctl", "--vacuum-time=1s"])
    for name in ("browser", "network-connections", "journal", "identity", "ssh", "relay", "firstboot-state"):
        clear_exact_state_directory(state_root, name)
    run(["systemctl", "reboot"])


def schedule_factory_reset(confirmation: str) -> None:
    if confirmation != ADMIN_CONFIRMATION:
        raise ValueError("Factory reset requires dashboard admin-unpair confirmation.")
    # A fixed transient timer gives the support response time to leave before
    # the job closes its relay/Wi-Fi transport. The unit name also rejects a
    # second pending reset instead of queuing competing destructive jobs.
    run([
        "systemd-run", "--quiet", "--collect", "--unit=hexclave-tv-box-factory-reset",
        "--on-active=2s", "--timer-property=AccuracySec=1s", "--property=Type=oneshot",
        "--property=User=root", FACTORY_RESET_JOB_PATH,
    ])


def factory_reset_job_main() -> None:
    if os.geteuid() != 0:
        raise PermissionError("TV Box factory reset jobs require root.")
    # This entry point is not in the SSH/sudo command grammar. Only the fixed
    # root-owned scheduler may call it; the lock covers the actual mutation,
    # not just the earlier request that scheduled it.
    _audit_event("factory-reset-job=started")
    outcome = "failed"
    try:
        with support_mutation_lock():
            factory_reset(STATE_ROOT, ADMIN_CONFIRMATION)
        outcome = "reboot-scheduled"
    finally:
        _audit_event(f"factory-reset-job={outcome}")


@contextmanager
def support_mutation_lock(path: Path = SUPPORT_MUTATION_LOCK_PATH) -> Iterator[None]:
    # This lock outlives network.service's RuntimeDirectory. Separate support
    # sessions must not restart that service midway through a factory reset
    # after its in-process maintenance lock has necessarily disappeared.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ValueError("TV Box support lock must be a private root-owned regular file.")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def execute(command: str, arguments: list[str], state_root: Path = STATE_ROOT) -> str:
    # Validate before recording any user input. Only these static command
    # labels enter the journal; arguments and command output never do.
    _validate_support_command(command, arguments)
    operation_id = uuid.uuid4().hex
    session_pid = _support_session_pid()
    context = (
        f"operation={operation_id} command={command} executor-uid={os.geteuid()} "
        f"ssh-session-pid={session_pid if session_pid is not None else 'none'}"
    )
    started_at = time.monotonic()
    _audit_event(f"support-command=started {context}")
    outcome = "failed"
    try:
        if command in MUTATING_COMMANDS:
            with support_mutation_lock():
                result = _execute(command, arguments, state_root)
        else:
            result = _execute(command, arguments, state_root)
        outcome = "scheduled" if command in {"factory-reset", "reboot", "shutdown"} else "complete"
        return result
    finally:
        # No exception text: subprocess errors may contain operational or
        # customer data. A started event still identifies an interrupted run.
        _audit_event(f"support-command={outcome} {context} duration-seconds={max(0.0, time.monotonic() - started_at):.1f}")


def _execute(command: str, arguments: list[str], state_root: Path) -> str:
    if command == "diagnostics" and not arguments:
        return diagnostics()
    if command == "recent-logs" and not arguments:
        return recent_service_logs()
    if command == "previous-logs" and not arguments:
        return previous_service_logs()
    if command == "restart-kiosk" and not arguments:
        agent_request({"command": "restart-kiosk"})
        return "Display reconciled with the current network mode."
    if command == "restart-network" and not arguments:
        run(["systemctl", "restart", "hexclave-tv-box-network.service"])
        return "Network service restarted."
    if command == "reset-network" and not arguments:
        agent_request({"command": "reset-network"})
        return "Saved Hexclave TV Box networks removed; setup mode started."
    if command == "reset-pairing" and len(arguments) == 1:
        reset_pairing(arguments[0])
        return "Local pairing identity reset."
    if command == "factory-reset" and len(arguments) == 1:
        schedule_factory_reset(arguments[0])
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
