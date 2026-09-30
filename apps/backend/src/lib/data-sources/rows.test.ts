import { describe, expect, it } from "vitest";
import { buildDestinationRow, buildSourceRow, versionFromCursorValue } from "./rows";

describe("source row conversion", () => {
  it("preserves prototype-sensitive PostgreSQL column names as own fields", () => {
    const source = buildSourceRow(["__proto__", "constructor", "toString"], ["proto", "ctor", "string"]);

    expect(Object.hasOwn(source, "__proto__")).toBe(true);
    expect(source["__proto__"]).toBe("proto");
    expect(source["constructor"]).toBe("ctor");
    expect(source["toString"]).toBe("string");

    const destination = buildDestinationRow({
      values: source,
      columns: [
        { name: "__proto__", dataType: "text", nullable: false },
        { name: "constructor", dataType: "text", nullable: false },
        { name: "toString", dataType: "text", nullable: false },
      ],
      version: 1n,
      deleted: false,
      extractedAt: new Date("2026-08-22T00:00:00Z"),
    });

    expect(Object.hasOwn(destination, "__proto__")).toBe(true);
    expect(destination["__proto__"]).toBe("proto");
    expect(destination["constructor"]).toBe("ctor");
    expect(destination["toString"]).toBe("string");
  });

  it("rejects array rows whose field metadata does not match", () => {
    expect(() => buildSourceRow(["one"], [])).toThrow("1 columns");
  });
});

describe("sync versions", () => {
  it("keeps pre-1970 timestamps positive for a UInt64 column", () => {
    // ClickHouse rejects a leading '-' outright, and ORDER BY cursor ASC puts the
    // oldest rows in the very first batch — so this used to fail every sync.
    const old = versionFromCursorValue(new Date("1900-01-01T00:00:00Z"));
    expect(old > 0n).toBe(true);
    expect(old < versionFromCursorValue(new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("orders timestamps regardless of representation", () => {
    expect(versionFromCursorValue(new Date("2026-01-01T00:00:00Z")))
      .toBe(versionFromCursorValue("2026-01-01T00:00:00.000Z"));
  });

  it("clamps negative integer cursors instead of failing the batch", () => {
    expect(versionFromCursorValue(-5)).toBe(0n);
    expect(versionFromCursorValue("42")).toBe(42n);
  });

  it("refuses a value it cannot order", () => {
    expect(() => versionFromCursorValue({})).toThrow("Cannot derive a sync version");
  });
});
