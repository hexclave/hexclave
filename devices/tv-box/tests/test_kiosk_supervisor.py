from __future__ import annotations

import io
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from hexclave_tv_box.kiosk_supervisor import (
    ProcessInfo,
    RendererProcessTree,
    DOCUMENT_RETRY_SECONDS,
    MAX_RENDERER_DIAGNOSTIC_LINES,
    MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS,
    MAX_RENDERER_OUTPUT_LINE_BYTES,
    RENDERER_GRACEFUL_STOP_SECONDS,
    RENDERER_KILL_WAIT_SECONDS,
    _RendererOutputTail,
    _signal_exact_process,
    _sanitize_renderer_output,
    descendant_processes,
    renderer_health,
    supervise,
)


class FakeProcess:
    def __init__(self, pid: int = 100) -> None:
        self.pid = pid
        self.terminated = False
        self.stdout = None

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        self.terminated = True

    def wait(self, timeout: int | None = None) -> int:
        del timeout
        return 0


class KioskSupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch("hexclave_tv_box.kiosk_supervisor.RendererProcessTree")
        self.tree_factory = patcher.start()
        self.addCleanup(patcher.stop)

    def test_process_ownership_excludes_preexisting_pam_helper_and_tracks_adopted_children(self) -> None:
        processes = {99: ProcessInfo(90, "(sd-pam)", start_ticks=1)}
        tree = RendererProcessTree(90, lambda: processes)
        processes.update({
            100: ProcessInfo(90, "cage", start_ticks=2),
            101: ProcessInfo(100, "cog", start_ticks=3),
            102: ProcessInfo(99, "pam-helper", start_ticks=4),
            103: ProcessInfo(1, "unrelated", start_ticks=5),
        })
        self.assertEqual(set(tree.processes()), {100, 101})
        del processes[100]
        processes[101] = ProcessInfo(90, "cog", start_ticks=3)
        self.assertEqual(set(tree.processes()), {101})

    def test_exact_signal_never_targets_reused_pid(self) -> None:
        original = ProcessInfo(90, "cog", start_ticks=10)
        replacement = ProcessInfo(90, "cog", start_ticks=11)
        with (
            mock.patch("hexclave_tv_box.kiosk_supervisor.os.pidfd_open", return_value=123),
            mock.patch("hexclave_tv_box.kiosk_supervisor.os.close") as close,
            mock.patch("hexclave_tv_box.kiosk_supervisor.signal.pidfd_send_signal") as send,
        ):
            _signal_exact_process(100, original, signal.SIGTERM, lambda: {100: replacement})
        send.assert_not_called()
        close.assert_called_once_with(123)

    def test_exact_signal_uses_pinned_process_descriptor(self) -> None:
        original = ProcessInfo(90, "cog", start_ticks=10)
        with (
            mock.patch("hexclave_tv_box.kiosk_supervisor.os.pidfd_open", return_value=123),
            mock.patch("hexclave_tv_box.kiosk_supervisor.os.close"),
            mock.patch("hexclave_tv_box.kiosk_supervisor.signal.pidfd_send_signal") as send,
        ):
            _signal_exact_process(100, original, signal.SIGTERM, lambda: {100: original})
        send.assert_called_once_with(123, signal.SIGTERM)

    def test_shutdown_escalates_the_exact_tree_and_fails_if_it_cannot_exit(self) -> None:
        processes: dict[int, ProcessInfo] = {}
        tree = RendererProcessTree(90, lambda: processes)
        processes[100] = ProcessInfo(90, "cage", start_ticks=2)
        times = iter((0, 0, 10, 15))
        with mock.patch("hexclave_tv_box.kiosk_supervisor._signal_exact_process") as send:
            with self.assertRaisesRegex(RuntimeError, "shutdown deadline"):
                tree.stop(FakeProcess(), monotonic=lambda: next(times), sleeper=lambda _seconds: None)
        self.assertEqual([call.args[2] for call in send.call_args_list], [signal.SIGTERM, signal.SIGKILL])

    def test_renderer_diagnostics_are_bounded_and_suppress_sensitive_values(self) -> None:
        self.assertEqual(
            _sanitize_renderer_output(b"failed URL https://example.com/tv-box?code=secret#fragment\n"),
            "<redacted renderer output>",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"Cookie: session=abc\n"),
            "<redacted renderer output>",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"https://u:p@host/x?token=1\n"),
            "https://host/x",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"https://app.hexclave.com/tv-box password=secret\n"),
            "https://app.hexclave.com/tv-box",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"https://u:p@host/x?token=1 extra=secret\n"),
            "https://host/x",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"renderer-exit code=1 password=secret\n"),
            "renderer-exit",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"Cookie: session=abc https://example.com/x\n"),
            "<redacted renderer output>",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"WebKit: failed https://u:p@host/x?token=1\n"),
            "WebKit: failed https://host/x",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"(WebKitNetworkProcess:123): WebKit-WARNING **: warning\n"),
            "(WebKitNetworkProcess:123): WebKit-WARNING **: warning",
        )
        self.assertEqual(_sanitize_renderer_output(b"\n"), None)

    def test_native_renderer_sensitive_values_are_suppressed_before_retention(self) -> None:
        prefixes = (
            "Cog-WARNING **: ",
            "(WebKitNetworkProcess:123): WebKit-WARNING **: ",
            "(cog:123): GLib-GObject-CRITICAL **: ",
        )
        fields = (
            "password=example-sensitive-value",
            "PASSWORD : example-sensitive-value",
            "passwd=example-sensitive-value",
            "Authorization: Bearer example-sensitive-value",
            "Proxy-Authorization: Basic example-sensitive-value",
            "Cookie: session=example-sensitive-value",
            "Set-Cookie: session=example-sensitive-value; HttpOnly",
            "client-secret=example-sensitive-value",
            "client_secret = example-sensitive-value",
            "access-token=example-sensitive-value",
            '"access_token": "example-sensitive-value"',
            "refresh-token=example-sensitive-value",
            "refreshToken=example-sensitive-value",
            "pairing-code=example-sensitive-value",
            "pairing_code=example-sensitive-value",
            "pairing code=example-sensitive-value",
            "token=example-sensitive-value",
            "api-key=example-sensitive-value",
            "session=example-sensitive-value",
            "secret=example-sensitive-value",
            "credential=example-sensitive-value",
            "credentials: example-sensitive-value",
            "{'password': 'example-sensitive-value', 'snapshot': 'example-display-title'}",
        )
        for prefix in prefixes:
            for field in fields:
                with self.subTest(prefix=prefix, field=field):
                    tail = _RendererOutputTail()
                    raw_line = (prefix + field + "\n").encode()
                    tail.consume(io.BytesIO(raw_line + raw_line))
                    self.assertEqual(tail.snapshot(), ("<redacted renderer output>",))
        self.assertEqual(
            _sanitize_renderer_output(b"(cog:12): Cog-WARNING **: tokenizer ready\n"),
            "(cog:12): Cog-WARNING **: tokenizer ready",
        )

    def test_renderer_tail_preserves_useful_diagnostics_and_existing_redaction(self) -> None:
        tail = _RendererOutputTail()
        tail.consume(io.BytesIO(
            b"Cog-WARNING **: platform initialization failed\n"
            b"WebKit-WARNING **: network process exited unexpectedly\n"
            b"(cog:123): GLib-GObject-CRITICAL **: object reference assertion failed\n"
            b"Unable to create the wlroots backend\n"
            b"WebKit: failed https://example-user:example-password@example.com/x?password=example-query#example-fragment\n"
            b"renderer-exit password=example-password-value\n"
            b"https://example.com/x snapshot=example-display-title\n"
            b"console.log snapshot={title:example-display-title}\n"
            b"page console password=example-password-value\n"
        ))
        self.assertEqual(tail.snapshot(), (
            "Cog-WARNING **: platform initialization failed",
            "WebKit-WARNING **: network process exited unexpectedly",
            "(cog:123): GLib-GObject-CRITICAL **: object reference assertion failed",
            "Unable to create the wlroots backend",
            "WebKit: failed https://example.com/x",
            "renderer-exit",
            "https://example.com/x",
            "<redacted renderer output>",
        ))

    def test_renderer_tail_remains_bounded_and_checks_the_whole_diagnostic(self) -> None:
        tail = _RendererOutputTail()
        lines = [
            f"Cog-WARNING **: diagnostic {index} " + "x" * MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS
            for index in range(MAX_RENDERER_DIAGNOSTIC_LINES + 2)
        ]
        tail.consume(io.BytesIO(("\n".join(lines) + "\n").encode()))
        self.assertEqual(tail.snapshot(), tuple(
            line[:MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS]
            for line in lines[-MAX_RENDERER_DIAGNOSTIC_LINES:]
        ))
        # A sensitive field beyond the retained width still suppresses the
        # entire message, including any earlier unstructured contents.
        tail.consume(io.BytesIO((
            "Cog-WARNING **: " + "x" * MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS
            + " password=example-sensitive-value\n"
        ).encode()))
        self.assertEqual(len(tail.snapshot()), MAX_RENDERER_DIAGNOSTIC_LINES)
        self.assertEqual(tail.snapshot()[-1], "<redacted renderer output>")

    def test_renderer_ingestion_bounds_each_read_and_resumes_after_an_oversized_line(self) -> None:
        testcase = self

        class BoundedStream(io.BytesIO):
            def readline(self, size: int = -1) -> bytes:
                testcase.assertGreater(size, 0)
                testcase.assertLessEqual(size, MAX_RENDERER_OUTPUT_LINE_BYTES + 1)
                return super().readline(size)

        tail = _RendererOutputTail()
        tail.consume(BoundedStream(
            b"Cog-WARNING **: " + b"x" * (4 * 1024 * 1024)
            + b" password=fixture-secret\n"
            + b"WebKit-WARNING **: bounded diagnostic\n"
        ))
        self.assertEqual(tail.snapshot(), (
            "<redacted renderer output>",
            "WebKit-WARNING **: bounded diagnostic",
        ))

    def test_incomplete_or_oversized_renderer_lines_never_publish_prefixes_or_document_events(self) -> None:
        prefix = b"Cog-Core-Message: <https://example.com/"
        cases = (
            b"Cog-WARNING **: " + b"x" * MAX_RENDERER_OUTPUT_LINE_BYTES + b" password=fixture-secret\n",
            prefix + b"x" * MAX_RENDERER_OUTPUT_LINE_BYTES + b"> Loaded successfully.\n",
            prefix + b"x" * MAX_RENDERER_OUTPUT_LINE_BYTES + b"> Load started.\n",
            b"Cog-WARNING **: incomplete diagnostic",
            prefix + b"tv-box> Loaded successfully.",
            prefix + b"\xff> Loaded successfully.\n",
        )
        for content in cases:
            with self.subTest(size=len(content), tail=content[-24:]):
                tail = _RendererOutputTail()
                tail.consume(io.BytesIO(content))
                self.assertEqual(tail.snapshot(), ("<redacted renderer output>",))
                self.assertEqual(tail.document_status(), ("loading", 0))

    def test_renderer_ingestion_accepts_the_exact_line_bound_and_coalesces_discarded_lines(self) -> None:
        prefix = b"Cog-WARNING **: "
        line = prefix + b"x" * (MAX_RENDERER_OUTPUT_LINE_BYTES - len(prefix) - 1) + b"\n"
        tail = _RendererOutputTail()
        tail.consume(io.BytesIO(line + line[:-1] + b"x\n" + b"z" * 8192 + b"\n"))
        self.assertEqual(tail.snapshot(), (
            line[:MAX_RENDERER_DIAGNOSTIC_LINE_CHARACTERS].decode(),
            "<redacted renderer output>",
        ))

    def test_renderer_health_requires_cage_cog_and_the_real_web_process(self) -> None:
        processes = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "bwrap"),
            103: ProcessInfo(102, "WPEWebProcess"),
            200: ProcessInfo(1, "WPEWebProcess"),
        }

        self.assertEqual(set(descendant_processes(processes, 100)), {101, 102, 103})
        health = renderer_health(processes, 100)
        self.assertTrue(health.ready)
        self.assertEqual(health.summary(), "cage=ready,cog=ready,web-process=ready")

        missing_web_process = dict(processes)
        del missing_web_process[103]
        self.assertFalse(renderer_health(missing_web_process, 100).ready)

    def test_renderer_health_never_counts_an_unrelated_process(self) -> None:
        processes = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            200: ProcessInfo(1, "WPEWebProcess"),
        }

        health = renderer_health(processes, 100)
        self.assertFalse(health.ready)
        self.assertFalse(health.web_process)

    def test_stopped_or_zombie_renderer_processes_are_not_ready(self) -> None:
        healthy = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "WPEWebProcess"),
        }
        for pid in healthy:
            for state in ("T", "t", "Z", "X"):
                with self.subTest(pid=pid, state=state):
                    processes = dict(healthy)
                    info = processes[pid]
                    processes[pid] = ProcessInfo(info.parent_pid, info.name, state)
                    self.assertFalse(renderer_health(processes, 100).ready)

    def test_native_load_error_is_not_cleared_by_error_page_load_finished(self) -> None:
        tail = _RendererOutputTail()
        tail.consume(io.BytesIO(
            b"Cog-Core-Message: 10:00:00.000: <https://example.com/tv-box> Load started.\n"
            b"(cog:123): Cog-Core-WARNING **: 10:00:00.001: <https://example.com/tv-box> TLS Error: certificate problem\n"
            b"Cog-Core-Message: 10:00:00.002: <https://example.com/tv-box> Load started.\n"
            b"Cog-Core-Message: 10:00:00.003: <https://example.com/tv-box> Loaded successfully.\n"
        ))
        self.assertEqual(tail.document_status(), ("failed", 2))
        self.assertEqual(tail.snapshot(), ())

    def test_native_success_is_observable_without_logging_document_urls(self) -> None:
        tail = _RendererOutputTail()
        tail.consume(io.BytesIO(
            b"Cog-Core-Message: 10:00:00.000: <https://example.com/tv-box> Load started.\n"
            b"Cog-Core-Message: 10:00:00.001: <https://example.com/tv-box> Loading...\n"
            b"Cog-Core-Message: 10:00:00.002: <https://example.com/tv-box> Loaded successfully.\n"
        ))
        self.assertEqual(tail.document_status(), ("loaded", 1))
        self.assertEqual(tail.snapshot(), ())

    def test_document_timeout_and_failure_retry_without_spending_the_crash_budget(self) -> None:
        healthy = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "WPEWebProcess"),
        }
        for state, times, expected_state in (
            ("loading", (0, 0, 120, 359, 360), "document-timeout"),
            ("failed", (0, 0, 239, 240), "document-failed"),
        ):
            with self.subTest(state=state), tempfile.TemporaryDirectory(suffix=".untracked") as directory:
                clock = iter(times)
                process = FakeProcess()
                health_path = Path(directory) / "health"
                with mock.patch("hexclave_tv_box.kiosk_supervisor._RendererOutputTail") as output:
                    output.return_value.document_status.return_value = (state, 0)
                    result = supervise(
                        ["cage", "--", "cog"],
                        health_path=health_path,
                        process_reader=lambda: healthy,
                        process_factory=lambda *_args, **_kwargs: process,
                        monotonic=lambda: next(clock),
                        sleeper=lambda _seconds: None,
                        require_document_load=True,
                    )
                self.assertEqual(result, 1)
                self.assertTrue(health_path.read_text().startswith(expected_state))

    def test_successful_document_is_not_restarted_because_time_passes(self) -> None:
        healthy = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "WPEWebProcess"),
        }
        process = FakeProcess()
        times = iter((0, 0, 10_000))
        polls = iter((None, None, 1))
        with tempfile.TemporaryDirectory(suffix=".untracked") as directory:
            with (
                mock.patch.object(process, "poll", side_effect=lambda: next(polls)),
                mock.patch("hexclave_tv_box.kiosk_supervisor._RendererOutputTail") as output,
                mock.patch("hexclave_tv_box.kiosk_supervisor.LOGGER.warning") as warning,
            ):
                output.return_value.document_status.return_value = ("loaded", 1)
                output.return_value.snapshot.return_value = ()
                supervise(
                    ["cage", "--", "cog"],
                    health_path=Path(directory) / "health",
                    process_reader=lambda: healthy,
                    process_factory=lambda *_args, **_kwargs: process,
                    monotonic=lambda: next(times),
                    sleeper=lambda _seconds: None,
                    require_document_load=True,
                )
            warning.assert_not_called()

    def test_systemd_budget_covers_slow_failures_but_not_document_outages(self) -> None:
        unit = (Path(__file__).resolve().parents[1] / "image/rootfs/etc/systemd/system/hexclave-tv-box-kiosk.service").read_text()
        self.assertIn("StartLimitIntervalSec=15min", unit)
        self.assertIn("StartLimitBurst=5", unit)
        self.assertIn("StartLimitAction=reboot", unit)
        interval = 15 * 60
        burst = 5
        worst_failure_cycle = 60 + 45 + RENDERER_GRACEFUL_STOP_SECONDS + RENDERER_KILL_WAIT_SECONDS + 2
        self.assertLess(burst * worst_failure_cycle, interval)
        self.assertGreater(burst * DOCUMENT_RETRY_SECONDS, interval)
        self.assertLess(RENDERER_GRACEFUL_STOP_SECONDS + RENDERER_KILL_WAIT_SECONDS + 2, 20)

    def test_real_subreaper_kills_and_reaps_session_escaping_orphans_only(self) -> None:
        # Run prctl and fork in a dedicated test process, never change the
        # unittest runner's adoption policy or signal an existing host process.
        program = r'''
import os, subprocess, sys, time
from hexclave_tv_box.kiosk_supervisor import enable_child_subreaper, RendererProcessTree, read_process_table
enable_child_subreaper()
protected = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(5)"])
tree = RendererProcessTree(os.getpid(), read_process_table)
renderer = subprocess.Popen([sys.executable, "-B", "-c", """
import os, signal, time
if os.fork() != 0:
    os._exit(0)
os.setsid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(os.getpid(), flush=True)
time.sleep(5)
"""], stdout=subprocess.PIPE)
try:
    orphan = int(renderer.stdout.readline())
    renderer.wait(timeout=2)
    assert orphan in tree.processes(), "renderer orphan was not adopted"
    tree.stop(renderer, graceful_seconds=0.1, kill_seconds=2)
    assert not tree.processes(), "renderer descendants survived"
    assert orphan not in read_process_table(), "renderer zombie was not reaped"
    assert protected.poll() is None, "pre-existing PAM-equivalent child was signalled"
finally:
    renderer.stdout.close()
    protected.terminate()
    protected.wait(timeout=2)
'''
        result = subprocess.run([sys.executable, "-B", "-c", program], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_readiness_timeout_fails_and_terminates_the_exact_cage_process(self) -> None:
        process = FakeProcess()
        times = iter((0.0, 0.0, 46.0))
        with tempfile.TemporaryDirectory() as directory:
            health_file = Path(directory) / "health"
            result = supervise(
                ["cage", "--", "cog"],
                health_path=health_file,
                process_reader=lambda: {100: ProcessInfo(90, "cage")},
                monotonic=lambda: next(times),
                sleeper=lambda _seconds: None,
                process_factory=lambda _command, **_options: process,
            )

            self.assertEqual(result, 1)
            self.tree_factory.return_value.stop.assert_called_once_with(process)
            self.assertEqual(
                health_file.read_text(encoding="utf-8"),
                "failed-readiness cage=ready,cog=missing,web-process=missing\n",
            )

    def test_liveness_loss_is_tolerated_briefly_then_fails_the_renderer(self) -> None:
        process = FakeProcess()
        ready = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "WPEWebProcess"),
        }
        degraded = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
        }
        snapshots = iter((ready, degraded, degraded))
        current_snapshot = [degraded]

        def process_reader() -> dict[int, ProcessInfo]:
            try:
                current_snapshot[0] = next(snapshots)
            except StopIteration:
                pass
            return current_snapshot[0]

        times = iter((0.0, 0.0, 1.0, 17.0))
        with tempfile.TemporaryDirectory() as directory:
            health_file = Path(directory) / "health"
            result = supervise(
                ["cage", "--", "cog"],
                health_path=health_file,
                process_reader=process_reader,
                monotonic=lambda: next(times),
                sleeper=lambda _seconds: None,
                process_factory=lambda _command, **_options: process,
            )

            self.assertEqual(result, 1)
            self.tree_factory.return_value.stop.assert_called_once_with(process)
            self.assertEqual(
                health_file.read_text(encoding="utf-8"),
                "failed-liveness cage=ready,cog=ready,web-process=missing\n",
            )

    def test_renderer_exit_reports_the_sanitized_stderr_tail(self) -> None:
        class ExitedProcess(FakeProcess):
            def __init__(self) -> None:
                super().__init__()
                self.stdout = io.BytesIO(
                    b"Unable to create the wlroots backend\n"
                    b"Authorization: Bearer must-not-appear\n"
                    b"Cog-WARNING **: password=example-password-value\n"
                    b"WebKit-WARNING **: Authorization: Bearer example-auth-value\n"
                    b"(cog:123): GLib-WARNING **: Cookie: session=example-cookie-value\n"
                    b"console.log snapshot={title:example-display-title}\n"
                    b"WebKit-WARNING **: network process exited unexpectedly\n"
                )

            def poll(self) -> int | None:
                return 1

        process = ExitedProcess()
        with tempfile.TemporaryDirectory() as directory:
            health_file = Path(directory) / "health"
            with self.assertLogs("hexclave-tv-box-kiosk", level="ERROR") as logs:
                result = supervise(
                    ["cage", "--", "cog"],
                    health_path=health_file,
                    process_factory=lambda _command, **_options: process,
                )
            self.assertEqual(result, 1)
            output = "\n".join(logs.output)
            self.assertIn("Unable to create the wlroots backend", output)
            self.assertIn("<redacted renderer output>", output)
            self.assertNotIn("must-not-appear", output)
            self.assertNotIn("example-password-value", output)
            self.assertNotIn("example-auth-value", output)
            self.assertNotIn("example-cookie-value", output)
            self.assertNotIn("example-display-title", output)
            self.assertIn("WebKit-WARNING **: network process exited unexpectedly", output)
            self.assertEqual(health_file.read_text(encoding="utf-8"), "exited\n")


if __name__ == "__main__":
    unittest.main()
