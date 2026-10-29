import { afterEach, describe, expect, it, vi } from "vitest";
import { getSafeClickhouseErrorMessage } from "./clickhouse-errors";

describe("getSafeClickhouseErrorMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the raw ClickHouse message for ALIAS_REQUIRED (code 206) without capturing", async () => {
    const errorsModule = await import("@hexclave/shared/dist/utils/errors");
    const captureErrorSpy = vi.spyOn(errorsModule, "captureError").mockImplementation(() => {});

    const message = "JOIN  CROSS JOIN ... no alias for subquery or table function SELECT 1 AS a. In scope SELECT * FROM (SELECT 1 AS a) CROSS JOIN (SELECT 2 AS b) LIMIT 1 (set joined_subquery_requires_alias = 0 to disable restriction). ";
    const result = getSafeClickhouseErrorMessage(
      { code: "206", message },
      "SELECT * FROM (SELECT 1 AS a) CROSS JOIN (SELECT 2 AS b) LIMIT 1",
    );

    // SAFE path returns the message verbatim — not the test/dev unsafe wrapper.
    expect(result).toBe(message);
    expect(result).not.toContain("As you are in development mode");
    expect(captureErrorSpy).not.toHaveBeenCalled();
  });

  it("wraps known unsafe codes in the generic message (even in test/dev)", async () => {
    const errorsModule = await import("@hexclave/shared/dist/utils/errors");
    const captureErrorSpy = vi.spyOn(errorsModule, "captureError").mockImplementation(() => {});

    const message = "There is no supertype for types String, UInt8";
    const result = getSafeClickhouseErrorMessage({ code: "386", message }, "SELECT 1");

    expect(result).toContain("Error during execution of this query.");
    expect(result).toContain("As you are in development mode");
    expect(result).toContain("386");
    expect(result).not.toBe(message);
    expect(captureErrorSpy).not.toHaveBeenCalled();
  });

  it("captures unknown ClickHouse error codes", async () => {
    const errorsModule = await import("@hexclave/shared/dist/utils/errors");
    const captureErrorSpy = vi.spyOn(errorsModule, "captureError").mockImplementation(() => {});

    const result = getSafeClickhouseErrorMessage(
      { code: "99999", message: "totally unknown" },
      "SELECT 1",
    );

    expect(captureErrorSpy).toHaveBeenCalledWith(
      "unknown-clickhouse-error-for-query",
      expect.objectContaining({
        message: expect.stringContaining("code 99999"),
      }),
    );
    expect(result).toContain("not known");
  });
});
