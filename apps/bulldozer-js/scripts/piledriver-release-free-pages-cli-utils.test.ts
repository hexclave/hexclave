import { describe, expect, it } from "vitest";
import { formatReleaseFreePagesSummary, parseReleaseFreePagesArgs, shouldRequestAgain } from "./piledriver-release-free-pages-cli-utils.js";

const mib = 1024 * 1024;

describe("release-free-pages CLI arguments", () => {
  it("defaults to one 1024 MiB release against the configured URL", () => {
    expect(parseReleaseFreePagesArgs([])).toEqual({ kind: "release", maxBytes: 1024 * mib, all: false, url: undefined });
  });

  it("reads every release option", () => {
    expect(parseReleaseFreePagesArgs(["--max-mib", "64", "--all", "--url", "http://bulldozer:8146"]))
      .toEqual({ kind: "release", maxBytes: 64 * mib, all: true, url: "http://bulldozer:8146" });
  });

  it("a dry run carries no limit, so it can't send one", () => {
    expect(parseReleaseFreePagesArgs(["--dry-run", "--url", "http://bulldozer:8146"])).toEqual({ kind: "dry-run", url: "http://bulldozer:8146" });
  });

  it("shows help instead of running when asked", () => {
    expect(parseReleaseFreePagesArgs(["--help"]).kind).toBe("help");
    expect(parseReleaseFreePagesArgs(["--all", "-h"]).kind).toBe("help");
  });

  it.each([["0"], ["-5"], ["1.5"], ["lots"]])("rejects --max-mib %s", value => {
    expect(() => parseReleaseFreePagesArgs([`--max-mib=${value}`])).toThrow("--max-mib must be a positive whole number");
  });

  it("rejects options a dry run would silently ignore", () => {
    expect(() => parseReleaseFreePagesArgs(["--dry-run", "--max-mib", "64"])).toThrow("--dry-run can't be combined with --max-mib or --all");
    expect(() => parseReleaseFreePagesArgs(["--dry-run", "--all"])).toThrow("--dry-run can't be combined with --max-mib or --all");
    expect(parseReleaseFreePagesArgs(["--dry-run"]).kind).toBe("dry-run");
  });

  it("rejects a --url that isn't an http(s) URL", () => {
    for (const url of ["not-a-url", "localhost:8146", "ftp://bulldozer:8146"]) {
      expect(() => parseReleaseFreePagesArgs(["--url", url])).toThrow("--url must be an http:// or https:// URL");
    }
    expect(parseReleaseFreePagesArgs(["--url", "https://bulldozer.internal"])).toMatchObject({ url: "https://bulldozer.internal" });
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

  it("says a release made no progress instead of claiming the limit was reached", () => {
    const summary = formatReleaseFreePagesSummary({
      stoppedBecause: "no-progress",
      dryRun: false,
      before: snapshot(500, 3000, 12, 1),
      after: snapshot(500, 3000, 12, 1),
      released: { pages: 0, bytes: 0 },
      chunks: { count: 1, largestPages: 16, maxMs: 1, totalMs: 1 },
      checkpoint: { busy: false, logFrames: 0, checkpointedFrames: 0 },
      elapsedMs: 2,
    });
    expect(summary).not.toContain("limit reached");
    expect(summary).toContain("made no progress");
  });

  it("a dry run on a file without auto_vacuum says its pages can't be released, not that they could be", () => {
    const legacy = { ...snapshot(500, 3000, 12, 1), canRelease: false };
    const summary = formatReleaseFreePagesSummary({
      stoppedBecause: "dry-run",
      dryRun: true,
      before: legacy,
      after: legacy,
      released: { pages: 0, bytes: 0 },
      chunks: { count: 0, largestPages: 0, maxMs: 0, totalMs: 0 },
      checkpoint: null,
      elapsedMs: 1,
    });
    expect(summary).not.toContain("could be released");
    expect(summary).toContain("created without auto_vacuum");
  });
});

describe("release-free-pages --all", () => {
  it("only asks for another request after one that used its whole limit", () => {
    expect(shouldRequestAgain("limit")).toBe(true);
    for (const stoppedBecause of ["no-free-pages", "no-progress", "dry-run"] as const) {
      expect(shouldRequestAgain(stoppedBecause)).toBe(false);
    }
  });
});
