import { describe, expect, it } from "vitest";
import { readTvSnapshotContractVersion } from "@/lib/tv-mode/snapshot-contract";

describe("readTvSnapshotContractVersion", () => {
  it.each([
    ["missing header", {}],
    ["empty header", { "x-hexclave-tv-snapshot-contract": [""] }],
    ["whitespace-only header", { "x-hexclave-tv-snapshot-contract": ["   "] }],
    ["zero", { "x-hexclave-tv-snapshot-contract": ["0"] }],
    ["negative version", { "x-hexclave-tv-snapshot-contract": ["-2"] }],
    ["scientific notation", { "x-hexclave-tv-snapshot-contract": ["1e3"] }],
    ["hexadecimal", { "x-hexclave-tv-snapshot-contract": ["0x10"] }],
    ["leading zero", { "x-hexclave-tv-snapshot-contract": ["03"] }],
    ["unsafe integer", { "x-hexclave-tv-snapshot-contract": ["9007199254740993"] }],
    ["overflowing digits", { "x-hexclave-tv-snapshot-contract": ["9".repeat(400)] }],
  ])("falls back to contract 1 for %s", (_label, headers) => {
    expect(readTvSnapshotContractVersion(headers)).toBe(1);
  });

  it.each([
    ["2", 2],
    ["3", 3],
    [" 3 ", 3],
    ["10", 10],
  ])("parses %s as contract %s", (raw, expected) => {
    expect(readTvSnapshotContractVersion({ "x-hexclave-tv-snapshot-contract": [raw] })).toBe(expected);
  });

  it("honors the legacy x-stack header", () => {
    expect(readTvSnapshotContractVersion({ "x-stack-tv-snapshot-contract": ["2"] })).toBe(2);
  });

  it("prefers the canonical header over the legacy one", () => {
    expect(readTvSnapshotContractVersion({
      "x-hexclave-tv-snapshot-contract": ["3"],
      "x-stack-tv-snapshot-contract": ["2"],
    })).toBe(3);
  });
});
