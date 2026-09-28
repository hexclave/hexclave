"""One-shot, read-only accounting for the fixed outbound relay service."""

from __future__ import annotations

import os
import re
import selectors
import subprocess
import time


RELAY_UNIT = "hexclave-tv-box-relay.service"
MAX_QUERY_BYTES = 4096
QUERY_TIMEOUT_SECONDS = 5
PROPERTIES = (
    "ActiveState", "SubState", "InvocationID", "NRestarts", "CPUUsageNSec",
    "MemoryCurrent", "MemoryPeak", "TasksCurrent", "MainPID",
)
ACTIVE_STATES = frozenset({
    "active", "reloading", "inactive", "failed", "activating", "deactivating",
    "maintenance", "refreshing",
})
SERVICE_STATES = frozenset({
    "dead", "condition", "start-pre", "start", "start-post", "running", "exited",
    "reload", "reload-signal", "reload-notify", "stop", "stop-watchdog", "stop-sigterm",
    "stop-sigkill", "stop-post", "final-watchdog", "final-sigterm", "final-sigkill",
    "failed", "dead-before-auto-restart", "failed-before-auto-restart", "auto-restart",
    "auto-restart-queued", "cleaning",
})
NUMERIC_FIELDS = (
    ("NRestarts", "relay-restarts"),
    ("CPUUsageNSec", "relay-cpu-usage-nsec"),
    ("MemoryCurrent", "relay-memory-current-bytes"),
    ("MemoryPeak", "relay-memory-peak-bytes"),
    ("TasksCurrent", "relay-tasks-current"),
    ("MainPID", "relay-main-pid"),
)


def _query_properties() -> str:
    command = [
        "/usr/bin/systemctl", "show", "--no-pager",
        "--property=" + ",".join(PROPERTIES), RELAY_UNIT,
    ]
    # Only fixed scalar properties are requested. Bound the pipe as well as
    # elapsed time so an unavailable service manager cannot stall support or
    # turn a diagnostic request into unbounded output capture.
    with subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as process:
        try:
            if process.stdout is None:
                raise RuntimeError("Relay accounting requires its configured output pipe.")
            deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
            contents = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise subprocess.TimeoutExpired(command, QUERY_TIMEOUT_SECONDS)
                    chunk = os.read(process.stdout.fileno(), MAX_QUERY_BYTES + 1 - len(contents))
                    if not chunk:
                        break
                    contents.extend(chunk)
                    if len(contents) > MAX_QUERY_BYTES:
                        raise ValueError("Relay accounting exceeds its output limit.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, QUERY_TIMEOUT_SECONDS)
            if process.wait(timeout=remaining) != 0:
                raise ValueError("Relay accounting query failed.")
            return contents.decode("ascii")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def _parse_properties(contents: str) -> dict[str, str]:
    if len(contents) > MAX_QUERY_BYTES:
        raise ValueError("Relay accounting exceeds its output limit.")
    result: dict[str, str] = {}
    for line in contents.splitlines():
        name, separator, value = line.partition("=")
        if separator != "=" or name not in PROPERTIES or name in result:
            raise ValueError("Relay accounting returned unexpected properties.")
        result[name] = value
    return result


def _counter(value: str | None) -> str:
    if value is None or re.fullmatch(r"[0-9]{1,20}", value) is None:
        return "unavailable"
    number = int(value)
    # systemd uses UINT64_MAX for unavailable accounting on some versions;
    # neither that sentinel nor an absent property is a measured zero.
    return str(number) if number < (1 << 64) - 1 else "unavailable"


def collect_relay_metrics() -> str:
    """Return allowlisted scalar measurements, without reading relay secrets.

    CPU deltas are meaningful only within the same nonempty InvocationID.
    MemoryCurrent is cgroup-charged memory (including cache), not process RSS.
    Sampling runs only when this function is called; it retains no state.
    """
    try:
        properties = _parse_properties(_query_properties())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Expected diagnostic failures produce explicit missing measurements.
        # Never return systemctl stderr or exception text through support.
        properties = {}
    active_state = properties.get("ActiveState")
    sub_state = properties.get("SubState")
    invocation = properties.get("InvocationID")
    lines = [
        "relay-metrics-source=systemd-unit-cgroup",
        f"sample-monotonic-nsec={time.monotonic_ns()}",
        f"relay-active-state={active_state if active_state in ACTIVE_STATES else 'unavailable'}",
        f"relay-sub-state={sub_state if sub_state in SERVICE_STATES else 'unavailable'}",
        "relay-invocation-id=" + (
            invocation
            if invocation is not None and re.fullmatch(r"[0-9a-f]{32}", invocation) is not None
            and invocation != "0" * 32
            else "unavailable"
        ),
    ]
    for property_name, output_name in NUMERIC_FIELDS:
        value = _counter(properties.get(property_name))
        if property_name == "MainPID" and value != "unavailable" and int(value) > (1 << 31) - 1:
            value = "unavailable"
        lines.append(f"{output_name}={value}")
    return "\n".join(lines)
