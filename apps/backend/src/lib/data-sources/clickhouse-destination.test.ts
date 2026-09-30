import { describe, expect, it } from "vitest";
import { getDestinationTableName } from "./clickhouse-destination";

describe("data-source destination table names", () => {
  it("is stable for one source table", () => {
    expect(getDestinationTableName("source-1", "public", "users"))
      .toBe(getDestinationTableName("source-1", "public", "users"));
  });

  it("distinguishes names that collide when schema and table are flattened", () => {
    expect(getDestinationTableName("source-1", "a_b", "c"))
      .not.toBe(getDestinationTableName("source-1", "a", "b_c"));
  });

  it("distinguishes quoted names that sanitize to the same prefix", () => {
    expect(getDestinationTableName("source-1", "public", "audit-log"))
      .not.toBe(getDestinationTableName("source-1", "public", "audit_log"));
  });

  it("distinguishes the same table connected through different sources", () => {
    expect(getDestinationTableName("source-1", "public", "users"))
      .not.toBe(getDestinationTableName("source-2", "public", "users"));
  });
});
