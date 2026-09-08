from __future__ import annotations

import io
import signal
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from hexclave_tv_box.kiosk_supervisor import (
    ProcessInfo,
    _terminate_exact_tree,
    _wait_for_renderer_shutdown,
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
    def test_supervisor_initiated_shutdown_signals_only_its_exact_cog_child(self) -> None:
        process = FakeProcess()
        processes = {
            100: ProcessInfo(90, "cage"),
            101: ProcessInfo(100, "cog"),
            102: ProcessInfo(101, "WPENetworkProcess"),
            103: ProcessInfo(101, "bwrap"),
            104: ProcessInfo(103, "WPEWebProcess"),
        }

        with mock.patch("hexclave_tv_box.kiosk_supervisor.os.kill") as kill:
            tracked = _terminate_exact_tree(process, lambda: processes)

        kill.assert_called_once_with(101, signal.SIGTERM)
        self.assertFalse(process.terminated)
        self.assertEqual(tracked, {
            101: "cog",
            102: "WPENetworkProcess",
            103: "bwrap",
            104: "WPEWebProcess",
        })

    def test_shutdown_falls_back_to_exact_cage_when_cog_is_missing(self) -> None:
        process = FakeProcess()

        _terminate_exact_tree(process, lambda: {100: ProcessInfo(90, "cage")})

        self.assertTrue(process.terminated)

    def test_shutdown_waits_for_exact_renderer_processes_and_ignores_pid_reuse(self) -> None:
        snapshots = iter((
            {
                101: ProcessInfo(100, "cog"),
                102: ProcessInfo(101, "WPENetworkProcess"),
            },
            {
                101: ProcessInfo(1, "unrelated"),
            },
        ))
        sleeps: list[float] = []

        self.assertTrue(_wait_for_renderer_shutdown(
            {101: "cog", 102: "WPENetworkProcess"},
            lambda: next(snapshots),
            sleeps.append,
            attempts=2,
        ))
        self.assertEqual(sleeps, [0.1])

    def test_shutdown_wait_is_bounded_when_a_renderer_process_is_stuck(self) -> None:
        sleeps: list[float] = []

        self.assertFalse(_wait_for_renderer_shutdown(
            {101: "cog"},
            lambda: {101: ProcessInfo(1, "cog")},
            sleeps.append,
            attempts=2,
        ))
        self.assertEqual(sleeps, [0.1, 0.1])

    def test_renderer_diagnostics_are_bounded_and_suppress_sensitive_values(self) -> None:
        self.assertEqual(
            _sanitize_renderer_output(b"failed URL https://example.com/tv-box?code=secret#fragment\n"),
            "failed URL https://example.com/tv-box",
        )
        self.assertEqual(
            _sanitize_renderer_output(b"Authorization: Bearer secret\n"),
            "[sensitive renderer diagnostic suppressed]",
        )
        self.assertEqual(_sanitize_renderer_output(b"\n"), None)

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
            self.assertTrue(process.terminated)
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
            with mock.patch("hexclave_tv_box.kiosk_supervisor.os.kill") as kill:
                result = supervise(
                    ["cage", "--", "cog"],
                    health_path=health_file,
                    process_reader=process_reader,
                    monotonic=lambda: next(times),
                    sleeper=lambda _seconds: None,
                    process_factory=lambda _command, **_options: process,
                )

            self.assertEqual(result, 1)
            kill.assert_called_once_with(101, signal.SIGTERM)
            self.assertFalse(process.terminated)
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
            self.assertIn("sensitive renderer diagnostic suppressed", output)
            self.assertNotIn("must-not-appear", output)
            self.assertEqual(health_file.read_text(encoding="utf-8"), "exited\n")


if __name__ == "__main__":
    unittest.main()
