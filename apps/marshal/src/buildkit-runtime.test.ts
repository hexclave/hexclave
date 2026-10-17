import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildkitRuntimeScript } from "./buildkit-runtime.js";

function run(options: { failure?: string, diskAvailable?: boolean, mountWorks?: boolean, fallback?: boolean, targets?: number }) {
  const root = mkdtempSync(join(tmpdir(), "buildkit-runtime.untracked-"));
  const bin = join(root, "bin.untracked");
  mkdirSync(bin);
  function command(name: string, contents: string) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${contents}\n`, { mode: 0o700 });
  }
  command("mount", 'test "$MOUNT_WORKS" = 1');
  command("umount", 'echo unmount >> "$TEST_ROOT/events"');
  command("awk", 'if [ "$1" = -v ]; then test "$DISK_AVAILABLE" = 1; else exec /usr/bin/awk "$@"; fi');
  command("buildkitd", 'exec sleep 600');
  command("buildctl", `
if [ "$1" = debug ]; then exit 0; fi
n=0; if [ -f "$TEST_ROOT/count" ]; then n=$(cat "$TEST_ROOT/count"); fi
n=$((n+1)); echo "$n" > "$TEST_ROOT/count"
echo "attempt $n"
case "$FAILURE:$n" in
  space:1|second-space:2|always-space:*) echo 'error: no space left on device' >&2; exit 42 ;;
  daemon-space:1) echo "error: no space left on device" >> "$TEST_ROOT/buildkitd.log"; echo "connection closed"; exit 42 ;;
  stale-daemon:1) echo "error: no space left on device" >> "$TEST_ROOT/buildkitd.log"; exit 0 ;;
  app:1|stale-daemon:2) echo 'compiler rejected the source' >&2; exit 43 ;;
  fake-space:1) echo 'no space left on device'; exit 0 ;;
esac
exit 0`);
  // Keep writes in this fixture. Stub the commands while executing the actual
  // shell lifecycle, FIFO log reader, exit-code handling and retry control flow.
  const script = buildkitRuntimeScript().replaceAll("/tmp/", `${root}/`).replaceAll("/var/lib/buildkit", `${root}/store`);
  const source = `set -u
fail() { echo "FAILED: $1"; exit 1; }
cleanup() {
  if [ -n "\${BUILDKIT_PID:-}" ]; then
    kill "$BUILDKIT_PID" 2>/dev/null || true
    wait "$BUILDKIT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
${script}
${Array.from({ length: options.targets ?? 1 }, () => `
run_buildkit build
status=$?
echo "result $status"
[ "$status" = 0 ] || exit "$status"
`).join("")}
`;
  try {
    const result = spawnSync("/bin/sh", ["-c", source], {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root,
        FAILURE: options.failure ?? "none", DISK_AVAILABLE: options.diskAvailable === false ? "0" : "1",
        MOUNT_WORKS: options.mountWorks === false ? "0" : "1",
        BUILDKIT_TMPFS_SIZE: "4g", BUILDKIT_DISK_DIR: `${root}/disk`,
        HEXCLAVE_BUILDKIT_DISK_FALLBACK: options.fallback === false ? "" : "1",
      },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr, attempts: Number(readFileSync(join(root, "count"), "utf8")) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("BuildKit disk recovery", () => {
  it("keeps successful builds on tmpfs and streams their output", () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.output).toContain("MARSHAL_BUILDKIT_STORE tmpfs 4g");
    expect(result.output).toContain("attempt 1\nresult 0");
    expect(result.output).not.toContain("MARSHAL_BUILDKIT_DISK_FALLBACK:");
  });

  it("retries an exhausted tmpfs once on disk", () => {
    const result = run({ failure: "space" });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.output).toContain("MARSHAL_BUILDKIT_DISK_FALLBACK:");
    expect(result.output).toContain("MARSHAL_BUILDKIT_STORE disk");
    expect(result.output).toContain("attempt 2\nresult 0");
  });

  it("recovers when only the daemon reports capacity exhaustion", () => {
    const result = run({ failure: "daemon-space" });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
  });

  it("retries only the current target and keeps later targets on disk", () => {
    const result = run({ failure: "second-space", targets: 3 });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(4);
    expect(result.output.match(/MARSHAL_BUILDKIT_DISK_FALLBACK:/g)).toHaveLength(1);
    expect(result.output.match(/result 0/g)).toHaveLength(3);
  });

  it("ignores daemon errors from an earlier successful target", () => {
    const result = run({ failure: "stale-daemon", targets: 2 });
    expect(result.status).toBe(43);
    expect(result.attempts).toBe(2);
    expect(result.output).not.toContain("MARSHAL_BUILDKIT_DISK_FALLBACK:");
  });

  it("preserves ordinary build failures without retrying", () => {
    const result = run({ failure: "app" });
    expect(result.status).toBe(43);
    expect(result.attempts).toBe(1);
  });

  it("does not retry a successful build that prints a capacity error", () => {
    expect(run({ failure: "fake-space" }).attempts).toBe(1);
  });

  it("fails when disk also fills instead of looping", () => {
    const result = run({ failure: "always-space" });
    expect(result.status).toBe(42);
    expect(result.attempts).toBe(2);
  });

  it("reports unavailable disk storage clearly", () => {
    const result = run({ failure: "space", diskAvailable: false });
    expect(result.status).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.output).toContain("no disk-backed store is available");
  });

  it("starts on disk when mounting tmpfs fails", () => {
    const result = run({ mountWorks: false });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.output).toContain("MARSHAL_TMPFS_MOUNT_FAILED");
    expect(result.output).toContain("MARSHAL_BUILDKIT_STORE disk");
  });

  it("does not retry capacity failures after starting on disk", () => {
    const result = run({ failure: "space", mountWorks: false });
    expect(result.status).toBe(42);
    expect(result.attempts).toBe(1);
  });

  it("preserves the original failure when recovery is disabled", () => {
    const result = run({ failure: "space", fallback: false });
    expect(result.status).toBe(42);
    expect(result.attempts).toBe(1);
  });
});
