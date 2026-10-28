import { describe, expect, it } from "vitest";
import { formatReleaseFreePagesSummary, parseReleaseFreePagesArgs } from "./piledriver-release-free-pages-cli-utils.js";

const mib = 1024 * 1024;

describe("release-free-pages CLI arguments", () => {
  it("defaults to one 1024 MiB release against the configured URL", () => {
    expect(parseReleaseFreePagesArgs([])).toEqual({ kind: "run", maxBytes: 1024 * mib, all: false, dryRun: false, url: undefined });
  });

  it("reads every option", () => {
    expect(parseReleaseFreePagesArgs(["--max-mib", "64", "--all", "--dry-run", "--url", "http://bulldozer:8146"]))
      .toEqual({ kind: "run", maxBytes: 64 * mib, all: true, dryRun: true, url: "http://bulldozer:8146" });
  });

  it("shows help instead of running when asked", () => {
    expect(parseReleaseFreePagesArgs(["--help"]).kind).toBe("help");
    expect(parseReleaseFreePagesArgs(["--all", "-h"]).kind).toBe("help");
  });

  it.each([["0"], ["-5"], ["1.5"], ["lots"]])("rejects --max-mib %s", value => {
    expect(() => parseReleaseFreePagesArgs([`--max-mib=${value}`])).toThrow("--max-mib must be a positive whole number");
  });

  it("rejects unknown options and stray arguments", () => {
    expect(() => parseReleaseFreePagesArgs(["--vacuum"])).toThrow();
    expect(() => parseReleaseFreePagesArgs(["1024"])).toThrow();
  });
});

describe("release-free-pages CLI summary", () => {
  const snapshot = (freePages: number, totalPages: number, mainMiB: number, walMiB: number) => ({
    pageSizeBytes: 4096,
    totalPages,
    freePages,
    canRelease: true,
    fileSizesInBytes: { "breezy.sqlite": mainMiB * mib, "breezy.sqlite-wal": walMiB * mib },
  });

  it("says how much was released, how the file changed, and whether to run again", () => {
    expect(formatReleaseFreePagesSummary({
      stoppedBecause: "limit",
      dryRun: false,
      before: snapshot(3000, 5000, 20, 4),
      after: snapshot(1000, 3000, 12, 64),
      released: { pages: 2000, bytes: 2000 * 4096 },
      chunks: { count: 2, largestPages: 1000, maxMs: 6.25, totalMs: 11 },
      checkpoint: { busy: false, logFrames: 10, checkpointedFrames: 10 },
      elapsedMs: 15,
    })).toBe("Released 7.8 MiB in 2 chunks (slowest 6.3 ms). breezy.sqlite 20.0 MiB -> 12.0 MiB, WAL 64.0 MiB. 1000 free pages (3.9 MiB) left: limit reached, run again to release more.");
  });

  it("says when there is nothing left, and what a dry run found", () => {
    const base = {
      before: snapshot(0, 3000, 12, 1),
      after: snapshot(0, 3000, 12, 1),
      released: { pages: 0, bytes: 0 },
      chunks: { count: 0, largestPages: 1000, maxMs: 0, totalMs: 0 },
      checkpoint: null,
      elapsedMs: 1,
    };
    expect(formatReleaseFreePagesSummary({ ...base, stoppedBecause: "no-free-pages", dryRun: false }))
      .toBe("Released 0.0 MiB in 0 chunks (slowest 0.0 ms). breezy.sqlite 12.0 MiB -> 12.0 MiB, WAL 1.0 MiB. No free pages left. If you expected some, run GC first (pnpm gc:piledriver).");
    expect(formatReleaseFreePagesSummary({ ...base, before: snapshot(500, 3000, 12, 1), after: snapshot(500, 3000, 12, 1), stoppedBecause: "dry-run", dryRun: true }))
      .toBe("Dry run: 500 free pages (2.0 MiB) could be released. breezy.sqlite is 12.0 MiB, WAL 1.0 MiB.");
  });
});
