"""Supervise the Cage/Cog renderer as one observable appliance process."""

from __future__ import annotations

import argparse
import collections
import ctypes
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
RENDERER_GRACEFUL_STOP_SECONDS = 10
RENDERER_KILL_WAIT_SECONDS = 5
DOCUMENT_LOAD_TIMEOUT_SECONDS = 120
DOCUMENT_RETRY_SECONDS = 240
MAX_RENDERER_DIAGNOSTIC_LINES = 64
MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS = 512
REDACTED_RENDERER_OUTPUT = "<redacted renderer output>"
SAFE_RENDERER_DIAGNOSTIC_PATTERN = re.compile(
    r"^(?:"
    r"(?:\([^)]*\): )?(?:GLib|WebKit|WebKitNetworkProcess|Cog|Cog-Core|Wayland|wlroots)"
    r"|Unable to create the wlroots backend"
    r")"
)
TOKEN_RENDERER_DIAGNOSTIC_PATTERN = re.compile(
    r"^(?:https?://|kiosk-renderer-[a-z0-9-]+|renderer-[a-z0-9-]+)"
)
URL_USERINFO_PATTERN = re.compile(r"(https?://)(?:[^/\s@]+@)([^/\s?#]+)")
URL_QUERY_PATTERN = re.compile(r"(https?://[^\s?#]+)(?:\?[^\s#]*)?(?:#[^\s]*)?")


@dataclass(frozen=True)
class ProcessInfo:
    parent_pid: int
    name: str
    state: str = "S"
    start_ticks: int = 0

    @property
    def runnable(self) -> bool:
        return self.state not in {"T", "t", "Z", "X"}


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
    if SAFE_RENDERER_DIAGNOSTIC_PATTERN.match(line) is None:
        if TOKEN_RENDERER_DIAGNOSTIC_PATTERN.match(line) is None:
            return REDACTED_RENDERER_OUTPUT
        line = line.split(maxsplit=1)[0]
    # Renderer failures occasionally contain the document URL. Query strings
    # and fragments are unnecessary for diagnosing Cage/Cog and may contain
    # application state, so retain only the public URL path.
    line = URL_USERINFO_PATTERN.sub(r"\1\2", line)
    line = URL_QUERY_PATTERN.sub(r"\1", line)
    return line[:MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS]


class _RendererOutputTail:
    """Drain renderer stderr continuously while retaining only a bounded tail."""

    def __init__(self) -> None:
        self._lines: collections.deque[str] = collections.deque(maxlen=MAX_RENDERER_DIAGNOSTIC_LINES)
        self._lock = threading.Lock()
        self.document_state = "loading"
        self.document_generation = 0
        self.document_failed = False

    def document_status(self) -> tuple[str, int]:
        with self._lock:
            return self.document_state, self.document_generation

    def consume(self, stream: BinaryIO) -> None:
        redacted_burst = False
        for raw_line in iter(stream.readline, b""):
            # Cog's native load callbacks are independent of page console
            # forwarding. Never forward these URL-bearing progress messages.
            native = raw_line.decode("utf-8", errors="replace").strip()
            if "Cog-Core" in native:
                progress = True
                with self._lock:
                    if re.search(r"> Load started\.$", native):
                        self.document_generation += 1
                        if not self.document_failed:
                            self.document_state = "loading"
                    elif re.search(r"> (?:Page load error|TLS Error):", native):
                        self.document_state = "failed"
                        self.document_failed = True
                    elif re.search(r"> Loaded successfully\.$", native):
                        # WebKit also emits LOAD_FINISHED after a failed load;
                        # that event must not make its engine error page ready.
                        if not self.document_failed:
                            self.document_state = "loaded"
                    elif re.search(r"> (?:Loading\.\.\.|Redirected\.)$", native) is None:
                        progress = False
                if progress:
                    continue
            line = _sanitize_renderer_output(raw_line)
            if line is None:
                redacted_burst = False
                continue
            if line == REDACTED_RENDERER_OUTPUT:
                if redacted_burst:
                    continue
                redacted_burst = True
            else:
                redacted_burst = False
            with self._lock:
                self._lines.append(line)

    def snapshot(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(self._lines)


def read_process_table(proc_root: Path = Path("/proc")) -> dict[int, ProcessInfo]:
    """Read process identity/state, never arguments or environments."""
    result: dict[int, ProcessInfo] = {}
    # An unreadable /proc is not evidence that the owned tree exited. Fail
    # visibly instead of declaring cleanup successful with unknown ownership.
    entries = list(proc_root.iterdir())
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            stat_value = (entry / "stat").read_text(encoding="utf-8")
            # comm (field 2) may contain spaces or parentheses. Fields after
            # its final ')' start with state (field 3); starttime is field 22.
            stat_fields = stat_value[stat_value.rindex(")") + 2:].split()
            result[int(entry.name)] = ProcessInfo(
                parent_pid=int(stat_fields[1]),
                name=stat_value[stat_value.index("(") + 1:stat_value.rindex(")")],
                state=stat_fields[0],
                start_ticks=int(stat_fields[19]),
            )
        except (IndexError, KeyError, OSError, UnicodeError, ValueError):
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
    names = {info.name for info in descendants.values() if info.runnable}
    return RendererHealth(
        cage=cage is not None and cage.name == "cage" and cage.runnable,
        cog="cog" in names,
        web_process="WPEWebProcess" in names,
    )


def _health_value(state: str, health: RendererHealth | None = None) -> str:
    suffix = "" if health is None else f" {health.summary()}"
    return f"{state}{suffix}\n"


def enable_child_subreaper() -> None:
    """Keep renderer orphans attributable even when PAM uses a session scope."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _signal_exact_process(
    pid: int,
    identity: ProcessInfo,
    signum: int,
    process_reader: Callable[[], dict[int, ProcessInfo]],
) -> None:
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        current = process_reader().get(pid)
        if current is None or current.start_ticks != identity.start_ticks:
            return
        # The pidfd pins this process across the check/send race. Never signal
        # a recycled PID, a global process name, or the user's entire session.
        signal.pidfd_send_signal(descriptor, signum)
    except ProcessLookupError:
        pass
    finally:
        os.close(descriptor)


class RendererProcessTree:
    def __init__(self, owner_pid: int, process_reader: Callable[[], dict[int, ProcessInfo]]) -> None:
        self.owner_pid = owner_pid
        self.process_reader = process_reader
        # systemd's pre-existing PAM helper must outlive renderer cleanup. The
        # supervisor creates no other children besides its one Cage launch.
        self.preexisting = descendant_processes(process_reader(), owner_pid)

    def processes(self) -> dict[int, ProcessInfo]:
        current = self.process_reader()
        excluded: set[int] = set()
        for pid, original in self.preexisting.items():
            existing = current.get(pid)
            if existing is not None and existing.start_ticks == original.start_ticks:
                excluded.add(pid)
                excluded.update(descendant_processes(current, pid))
        return {
            pid: info
            for pid, info in descendant_processes(current, self.owner_pid).items()
            if pid not in excluded
        }

    def stop(
        self,
        process: subprocess.Popen[bytes],
        *,
        monotonic: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        graceful_seconds: float = RENDERER_GRACEFUL_STOP_SECONDS,
        kill_seconds: float = RENDERER_KILL_WAIT_SECONDS,
    ) -> None:
        started = monotonic()
        signalled: set[tuple[int, int, int]] = set()
        forced = False
        while True:
            process.poll()  # Reap Cage through Popen, preserving its exit code.
            remaining = self.processes()
            for pid, info in remaining.items():
                if info.parent_pid == self.owner_pid and pid != process.pid:
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            remaining = self.processes()
            if not remaining:
                LOGGER.info("kiosk-renderer-stopped forced=%s", "yes" if forced else "no")
                return
            elapsed = monotonic() - started
            if elapsed >= graceful_seconds + kill_seconds:
                raise RuntimeError("TV Box renderer descendants survived their exact shutdown deadline.")
            signum = signal.SIGTERM if elapsed < graceful_seconds else signal.SIGKILL
            if signum == signal.SIGKILL and not forced:
                LOGGER.warning("kiosk-renderer-force-stop")
                forced = True
            for pid, info in remaining.items():
                key = (pid, info.start_ticks, signum)
                if key not in signalled:
                    # Signal the network process as well as Cog so the existing
                    # persistent-cookie flush behavior is preserved. Re-scan
                    # adopted children until the entire owned tree is reaped.
                    _signal_exact_process(pid, info, signum, self.process_reader)
                    signalled.add(key)
            sleeper(RENDERER_EXIT_WAIT_SECONDS)


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
    require_document_load: bool = False,
    document_load_timeout: int = DOCUMENT_LOAD_TIMEOUT_SECONDS,
    document_retry_seconds: int = DOCUMENT_RETRY_SECONDS,
) -> int:
    if min(readiness_timeout, liveness_grace, document_load_timeout, document_retry_seconds) <= 0:
        raise ValueError("TV Box kiosk supervision intervals must be positive.")

    # Page console forwarding is disabled in the Cog command below. Capture
    # only compositor/browser output so a failed appliance can report the
    # actual platform error without allowing an unbounded local log file.
    tree = RendererProcessTree(os.getpid(), process_reader)
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
    stop_started = False

    def stop_renderer() -> None:
        nonlocal stop_started
        stop_started = True
        tree.stop(process)

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
        document_generation = 0
        document_started_at = started_at
        document_retry_at: float | None = None
        publish_health("starting")
        LOGGER.info("kiosk-supervisor-started")

        while True:
            if stopping:
                publish_health("stopping")
                stop_renderer()
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
                if not require_document_load:
                    publish_health("ready", health)
            elif not was_ready:
                publish_health("starting", health)
                if now - started_at >= readiness_timeout:
                    LOGGER.error("kiosk-renderer-readiness-timeout %s", health.summary())
                    publish_health("failed-readiness", health)
                    stop_renderer()
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
                    stop_renderer()
                    report_renderer_failure()
                    return 1
            if require_document_load and health.ready:
                document_state, generation = output_tail.document_status()
                if generation != document_generation:
                    document_generation = generation
                    document_started_at = now
                timed_out = document_state == "loading" and now - document_started_at >= document_load_timeout
                if document_state == "failed" or timed_out:
                    if document_retry_at is None:
                        document_retry_at = now + document_retry_seconds
                        LOGGER.warning("kiosk-document-recovery-scheduled")
                    publish_health("document-failed" if document_state == "failed" else "document-timeout", health)
                elif document_retry_at is None:
                    publish_health("ready" if document_state == "loaded" else "document-loading", health)
                if document_retry_at is not None and now >= document_retry_at:
                    # Origin outages are not a hardware crash loop. This wait
                    # keeps navigation-only retries below systemd's restart
                    # budget without changing or erasing browser credentials.
                    stop_renderer()
                    return 1
            sleeper(POLL_SECONDS)
    finally:
        try:
            if not stop_started:
                stop_renderer()
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
    enable_child_subreaper()
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
        require_document_load=True,
    )
    raise SystemExit(return_code)


if __name__ == "__main__":
    main()
