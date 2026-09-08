"""Supervise the Cage/Cog renderer as one observable appliance process."""

from __future__ import annotations

import argparse
import collections
import logging
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .state import atomic_write

LOGGER = logging.getLogger("hexclave-tv-box-kiosk")
READINESS_TIMEOUT_SECONDS = 45
LIVENESS_GRACE_SECONDS = 15
POLL_SECONDS = 1
RENDERER_EXIT_WAIT_SECONDS = 0.1
RENDERER_EXIT_WAIT_ATTEMPTS = 40
MAX_RENDERER_DIAGNOSTIC_LINES = 64
MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS = 512
SENSITIVE_RENDERER_VALUE_PATTERN = re.compile(
    r"(?i)(?:authorization|proxy-authorization|set-cookie|password|passwd|client-secret|"
    r"access-token|refresh-token|pairing[-_ ]?code)\s*[:=]"
)
URL_QUERY_PATTERN = re.compile(r"(https?://[^\s?#]+)(?:\?[^\s#]*)?(?:#[^\s]*)?")


@dataclass(frozen=True)
class ProcessInfo:
    parent_pid: int
    name: str


@dataclass(frozen=True)
class RendererHealth:
    cage: bool
    cog: bool
    web_process: bool

    @property
    def ready(self) -> bool:
        return self.cage and self.cog and self.web_process

    def summary(self) -> str:
        return ",".join(
            f"{name}={'ready' if present else 'missing'}"
            for name, present in (
                ("cage", self.cage),
                ("cog", self.cog),
                ("web-process", self.web_process),
            )
        )


def _sanitize_renderer_output(raw_line: bytes) -> str | None:
    line = raw_line.decode("utf-8", errors="replace").strip()
    if line == "":
        return None
    if SENSITIVE_RENDERER_VALUE_PATTERN.search(line) is not None:
        return "[sensitive renderer diagnostic suppressed]"
    # Renderer failures occasionally contain the document URL. Query strings
    # and fragments are unnecessary for diagnosing Cage/Cog and may contain
    # application state, so retain only the public URL path.
    line = URL_QUERY_PATTERN.sub(r"\1", line)
    return line[:MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS]


class _RendererOutputTail:
    """Drain renderer stderr continuously while retaining only a bounded tail."""

    def __init__(self) -> None:
        self._lines: collections.deque[str] = collections.deque(maxlen=MAX_RENDERER_DIAGNOSTIC_LINES)
        self._lock = threading.Lock()

    def consume(self, stream: BinaryIO) -> None:
        for raw_line in iter(stream.readline, b""):
            line = _sanitize_renderer_output(raw_line)
            if line is not None:
                with self._lock:
                    self._lines.append(line)

    def snapshot(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(self._lines)


def read_process_table(proc_root: Path = Path("/proc")) -> dict[int, ProcessInfo]:
    """Read only process names and parent IDs; never inspect process arguments or environments."""
    result: dict[int, ProcessInfo] = {}
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return result
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            status_lines = (entry / "status").read_text(encoding="utf-8").splitlines()
            values = {
                key: value.strip()
                for line in status_lines
                if ":" in line
                for key, value in (line.split(":", maxsplit=1),)
            }
            result[int(entry.name)] = ProcessInfo(
                parent_pid=int(values["PPid"]),
                name=values["Name"],
            )
        except (KeyError, OSError, UnicodeError, ValueError):
            # Processes may exit between listing /proc and reading status.
            continue
    return result


def descendant_processes(process_table: Mapping[int, ProcessInfo], root_pid: int) -> dict[int, ProcessInfo]:
    descendants: dict[int, ProcessInfo] = {}
    frontier = [root_pid]
    while frontier:
        parent_pid = frontier.pop()
        children = {
            pid: info
            for pid, info in process_table.items()
            if info.parent_pid == parent_pid and pid not in descendants
        }
        descendants.update(children)
        frontier.extend(children)
    return descendants


def renderer_health(process_table: Mapping[int, ProcessInfo], cage_pid: int) -> RendererHealth:
    cage = process_table.get(cage_pid)
    descendants = descendant_processes(process_table, cage_pid)
    names = {info.name for info in descendants.values()}
    return RendererHealth(
        cage=cage is not None and cage.name == "cage",
        cog="cog" in names,
        web_process="WPEWebProcess" in names,
    )


def _health_value(state: str, health: RendererHealth | None = None) -> str:
    suffix = "" if health is None else f" {health.summary()}"
    return f"{state}{suffix}\n"


def _terminate_exact_tree(
    process: subprocess.Popen[bytes],
    process_reader: Callable[[], dict[int, ProcessInfo]],
) -> dict[int, str]:
    if process.poll() is not None:
        return {}
    processes = process_reader()
    descendants = descendant_processes(processes, process.pid)
    tracked_descendants = {pid: info.name for pid, info in descendants.items()}
    cog_processes = sorted(
        pid
        for pid, info in descendants.items()
        if info.name == "cog"
    )
    if len(cog_processes) == 1:
        # Cog owns the WebKit processes. Signal it directly for supervisor-
        # initiated recovery; during a systemd stop, KillMode=control-group has
        # already delivered the same graceful signal to the complete renderer
        # tree, including the process that persists cookies.
        try:
            os.kill(cog_processes[0], signal.SIGTERM)
        except ProcessLookupError:
            pass
        return tracked_descendants
    # A missing or ambiguous Cog child cannot complete the normal lifecycle.
    # Stop only this exact Cage process; systemd's cgroup timeout remains the
    # bounded fallback for descendants that do not exit with it.
    try:
        process.terminate()
    except ProcessLookupError:
        pass
    return tracked_descendants


def _wait_for_renderer_shutdown(
    tracked_processes: Mapping[int, str],
    process_reader: Callable[[], dict[int, ProcessInfo]],
    sleeper: Callable[[float], None],
    attempts: int = RENDERER_EXIT_WAIT_ATTEMPTS,
) -> bool:
    """Wait for the exact pre-signal renderer processes without following reparented children."""
    if attempts < 0:
        raise ValueError("Renderer shutdown attempts cannot be negative.")
    for attempt in range(attempts + 1):
        current = process_reader()
        remaining = {
            pid
            for pid, name in tracked_processes.items()
            if (process_info := current.get(pid)) is not None and process_info.name == name
        }
        if len(remaining) == 0:
            return True
        if attempt < attempts:
            sleeper(RENDERER_EXIT_WAIT_SECONDS)
    return False


def _stop_renderer(
    process: subprocess.Popen[bytes],
    process_reader: Callable[[], dict[int, ProcessInfo]],
    sleeper: Callable[[float], None],
) -> None:
    tracked_processes = _terminate_exact_tree(process, process_reader)
    cage_exited = False
    try:
        process.wait(timeout=5)
        cage_exited = True
    except subprocess.TimeoutExpired:
        pass
    descendants_exited = _wait_for_renderer_shutdown(tracked_processes, process_reader, sleeper)
    if not cage_exited or not descendants_exited:
        # systemd retains a bounded SIGKILL fallback for exactly this unit's
        # control group after the graceful stop deadline.
        LOGGER.warning("kiosk-renderer-stop-timeout")


def supervise(
    command: Sequence[str],
    *,
    health_path: Path,
    process_reader: Callable[[], dict[int, ProcessInfo]] = read_process_table,
    monotonic: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
    process_factory: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    readiness_timeout: int = READINESS_TIMEOUT_SECONDS,
    liveness_grace: int = LIVENESS_GRACE_SECONDS,
) -> int:
    if readiness_timeout <= 0 or liveness_grace <= 0:
        raise ValueError("TV Box kiosk supervision intervals must be positive.")

    # Page console forwarding is disabled in the Cog command below. Capture
    # only compositor/browser output so a failed appliance can report the
    # actual platform error without allowing an unbounded local log file.
    process = process_factory(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output_tail = _RendererOutputTail()
    output_thread: threading.Thread | None = None
    if process.stdout is not None:
        output_thread = threading.Thread(
            target=output_tail.consume,
            args=(process.stdout,),
            name="tv-box-renderer-output",
            daemon=True,
        )
        output_thread.start()
    stopping = False
    last_health_value: str | None = None

    def report_renderer_failure() -> None:
        if output_thread is not None:
            output_thread.join(timeout=1)
        lines = output_tail.snapshot()
        if len(lines) == 0:
            LOGGER.error("kiosk-renderer-diagnostic unavailable")
            return
        for line in lines:
            LOGGER.error("kiosk-renderer-diagnostic %s", line)

    def publish_health(state: str, health: RendererHealth | None = None) -> None:
        nonlocal last_health_value
        value = _health_value(state, health)
        if value == last_health_value:
            return
        atomic_write(health_path, value, 0o600)
        last_health_value = value

    def request_stop(_signal_number: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    previous_sigterm = signal.signal(signal.SIGTERM, request_stop)
    previous_sigint = signal.signal(signal.SIGINT, request_stop)
    try:
        started_at = monotonic()
        missing_since: float | None = None
        was_ready = False
        publish_health("starting")
        LOGGER.info("kiosk-supervisor-started")

        while True:
            if stopping:
                publish_health("stopping")
                _stop_renderer(process, process_reader, sleeper)
                return 0

            return_code = process.poll()
            if return_code is not None:
                publish_health("exited")
                report_renderer_failure()
                LOGGER.error("kiosk-renderer-exited code=%s", return_code)
                return return_code if return_code != 0 else 1

            now = monotonic()
            health = renderer_health(process_reader(), process.pid)
            if health.ready:
                if not was_ready:
                    LOGGER.info("kiosk-renderer-ready")
                was_ready = True
                missing_since = None
                publish_health("ready", health)
            elif not was_ready:
                publish_health("starting", health)
                if now - started_at >= readiness_timeout:
                    LOGGER.error("kiosk-renderer-readiness-timeout %s", health.summary())
                    publish_health("failed-readiness", health)
                    _stop_renderer(process, process_reader, sleeper)
                    report_renderer_failure()
                    return 1
            else:
                if missing_since is None:
                    missing_since = now
                    LOGGER.warning("kiosk-renderer-degraded %s", health.summary())
                publish_health("degraded", health)
                if now - missing_since >= liveness_grace:
                    LOGGER.error("kiosk-renderer-liveness-timeout %s", health.summary())
                    publish_health("failed-liveness", health)
                    _stop_renderer(process, process_reader, sleeper)
                    report_renderer_failure()
                    return 1
            sleeper(POLL_SECONDS)
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        signal.signal(signal.SIGINT, previous_sigint)


def main() -> None:
    parser = argparse.ArgumentParser(description="Supervise the Hexclave TV Box Cage/Cog renderer.")
    parser.add_argument("--health-file", type=Path, required=True)
    parser.add_argument("--cookie-jar", type=Path, required=True)
    parser.add_argument("url")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if os.environ.get("WLR_LIBINPUT_NO_DEVICES") != "1":
        raise RuntimeError("TV Box kiosk requires explicit no-input Cage operation.")
    return_code = supervise(
        [
            "/usr/bin/cage",
            "--",
            "/usr/bin/cog",
            "--platform=wl",
            f"--cookie-jar=sqlite:{arguments.cookie_jar}",
            "--webprocess-failure=exit",
            "--enable-write-console-messages-to-stdout=false",
            arguments.url,
        ],
        health_path=arguments.health_file,
    )
    raise SystemExit(return_code)


if __name__ == "__main__":
    main()
