from __future__ import annotations

import subprocess
import sys
import unittest
from unittest import mock

from hexclave_tv_box import relay_metrics


PROPERTIES = "\n".join((
    "ActiveState=active", "SubState=running", "InvocationID=" + "a" * 32,
    "NRestarts=2", "CPUUsageNSec=321000000", "MemoryCurrent=4194304",
    "MemoryPeak=6291456", "TasksCurrent=1", "MainPID=1234",
))


class RelayMetricsTests(unittest.TestCase):
    def collect(self, properties: str) -> str:
        with (
            mock.patch.object(relay_metrics, "_query_properties", return_value=properties),
            mock.patch.object(relay_metrics.time, "monotonic_ns", return_value=123456789),
        ):
            return relay_metrics.collect_relay_metrics()

    def test_reports_only_fixed_scalars_with_source_sample_and_invocation(self) -> None:
        self.assertEqual(self.collect(PROPERTIES), "\n".join((
            "relay-metrics-source=systemd-unit-cgroup",
            "sample-monotonic-nsec=123456789",
            "relay-active-state=active",
            "relay-sub-state=running",
            "relay-invocation-id=" + "a" * 32,
            "relay-restarts=2",
            "relay-cpu-usage-nsec=321000000",
            "relay-memory-current-bytes=4194304",
            "relay-memory-peak-bytes=6291456",
            "relay-tasks-current=1",
            "relay-main-pid=1234",
        )))

    def test_unavailable_and_malformed_counters_are_not_reported_as_zero(self) -> None:
        for value in ("", "[not set]", "infinity", "n/a", "-1", "1.5", " 12", "12 ", "\u0661", "18446744073709551615", "9" * 21):
            with self.subTest(value=value):
                result = self.collect(PROPERTIES.replace("MemoryCurrent=4194304", "MemoryCurrent=" + value))
                self.assertIn("relay-memory-current-bytes=unavailable", result)
                self.assertIn("relay-cpu-usage-nsec=321000000", result)
        result = self.collect(PROPERTIES.replace("MemoryPeak=6291456\n", ""))
        self.assertIn("relay-memory-peak-bytes=unavailable", result)
        self.assertIn("relay-memory-current-bytes=4194304", result)

    def test_inactive_unit_preserves_actual_zero_but_not_missing_accounting(self) -> None:
        result = self.collect("ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nInvocationID=\n")
        self.assertIn("relay-active-state=inactive", result)
        self.assertIn("relay-main-pid=0", result)
        self.assertIn("relay-restarts=0", result)
        self.assertIn("relay-invocation-id=unavailable", result)
        self.assertIn("relay-cpu-usage-nsec=unavailable", result)
        self.assertIn("relay-tasks-current=unavailable", result)

    def test_untrusted_states_invocations_and_pid_are_never_echoed(self) -> None:
        for field, old, invalid, output in (
            ("ActiveState", "active", "private-endpoint", "relay-active-state"),
            ("SubState", "running", "private-key-material", "relay-sub-state"),
            ("InvocationID", "a" * 32, "private-identifier", "relay-invocation-id"),
            ("InvocationID", "a" * 32, "0" * 32, "relay-invocation-id"),
            ("MainPID", "1234", "2147483648", "relay-main-pid"),
        ):
            with self.subTest(field=field, invalid=invalid):
                result = self.collect(PROPERTIES.replace(f"{field}={old}", f"{field}={invalid}"))
                self.assertIn(f"{output}=unavailable", result)
                self.assertNotIn(invalid, result)

    def test_malformed_duplicate_and_oversized_documents_are_unavailable(self) -> None:
        for suffix in ("\nMainPID=44", "\nEnvironment=private-value", "\nprivate-value", "x" * 4097):
            with self.subTest(suffix=suffix[:40]):
                result = self.collect(PROPERTIES + suffix)
                self.assertIn("relay-active-state=unavailable", result)
                self.assertIn("relay-cpu-usage-nsec=unavailable", result)
                self.assertNotIn("private-value", result)

    def test_query_failures_do_not_disclose_exception_output(self) -> None:
        failures = (
            FileNotFoundError("private path"),
            subprocess.TimeoutExpired(["private command"], 5, output=b"private output"),
            subprocess.CalledProcessError(1, ["private command"], stderr=b"private error"),
            UnicodeDecodeError("ascii", b"\xff", 0, 1, "private text"),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(relay_metrics, "_query_properties", side_effect=failure):
                    result = relay_metrics.collect_relay_metrics()
                self.assertIn("relay-cpu-usage-nsec=unavailable", result)
                self.assertNotIn("private", result)

    def test_separate_requests_sample_again_and_expose_restart_boundaries(self) -> None:
        restarted = PROPERTIES.replace("a" * 32, "b" * 32).replace("CPUUsageNSec=321000000", "CPUUsageNSec=1000")
        with (
            mock.patch.object(relay_metrics, "_query_properties", side_effect=[PROPERTIES, restarted]) as query,
            mock.patch.object(relay_metrics.time, "monotonic_ns", side_effect=[10000, 20000]),
        ):
            first = relay_metrics.collect_relay_metrics()
            second = relay_metrics.collect_relay_metrics()
        self.assertEqual(query.call_count, 2)
        self.assertIn("relay-invocation-id=" + "a" * 32, first)
        self.assertIn("relay-invocation-id=" + "b" * 32, second)
        self.assertIn("relay-cpu-usage-nsec=1000", second)
        self.assertIn("sample-monotonic-nsec=20000", second)

    def query_with_process(self, code: str) -> tuple[str, list[str]]:
        original_popen = subprocess.Popen
        commands: list[list[str]] = []
        processes: list[subprocess.Popen[bytes]] = []

        def launch(command: list[str], *, stdin: int, stdout: int, stderr: int) -> subprocess.Popen[bytes]:
            commands.append(command)
            process = original_popen([sys.executable, "-B", "-c", code], stdin=stdin, stdout=stdout, stderr=stderr)
            processes.append(process)
            return process

        try:
            with mock.patch.object(relay_metrics.subprocess, "Popen", side_effect=launch):
                result = relay_metrics._query_properties()
        finally:
            self.assertEqual(len(commands), 1)
            self.assertIsNotNone(processes[0].returncode, "The inspection subprocess must be reaped even on timeout.")
        return result, commands[0]

    def test_query_has_fixed_scope_and_discards_stderr(self) -> None:
        result, command = self.query_with_process("import sys; print('MainPID=1234'); print('private stderr', file=sys.stderr)")
        self.assertEqual(result, "MainPID=1234\n")
        self.assertEqual(command, [
            "/usr/bin/systemctl", "show", "--no-pager",
            "--property=" + ",".join(relay_metrics.PROPERTIES),
            "hexclave-tv-box-relay.service",
        ])
        self.assertNotIn("Environment", command[3])
        self.assertNotIn("ExecStart", command[3])

    def test_query_rejects_failed_and_oversized_output(self) -> None:
        for code in ("raise SystemExit(1)", "print('x' * 4097)"):
            with self.subTest(code=code):
                with self.assertRaises(ValueError):
                    self.query_with_process(code)

    def test_query_deadline_kills_and_reaps_a_stalled_inspection(self) -> None:
        with mock.patch.object(relay_metrics, "QUERY_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.query_with_process("import time; time.sleep(60)")


if __name__ == "__main__":
    unittest.main()
