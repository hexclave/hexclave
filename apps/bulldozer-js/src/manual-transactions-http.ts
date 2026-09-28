/**
 * Pure helpers for GET /v1/manual-transactions. Kept out of index.ts so they can
 * be unit-tested without booting the HTTP server / LMDB.
 */

export function parseManualTransactionsListQuery(query: {
  limit?: unknown,
  cursor?: unknown,
}): { limit: number, cursor: string | undefined } {
  // Cap at 200 so one request cannot pull the whole table.
  const parsedLimit = Number.parseInt(typeof query.limit === "string" ? query.limit : "100", 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 100));
  const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}

import.meta.vitest?.describe("parseManualTransactionsListQuery", (test) => {
  test("defaults limit to 100 and omits empty cursor", ({ expect }) => {
    expect(parseManualTransactionsListQuery({})).toEqual({ limit: 100, cursor: undefined });
    expect(parseManualTransactionsListQuery({ cursor: "" })).toEqual({ limit: 100, cursor: undefined });
  });

  test("clamps limit to [1, 200]", ({ expect }) => {
    expect(parseManualTransactionsListQuery({ limit: "0" }).limit).toBe(1);
    expect(parseManualTransactionsListQuery({ limit: "-3" }).limit).toBe(1);
    expect(parseManualTransactionsListQuery({ limit: "201" }).limit).toBe(200);
    expect(parseManualTransactionsListQuery({ limit: "150" }).limit).toBe(150);
  });

  test("falls back to 100 on non-numeric limit", ({ expect }) => {
    expect(parseManualTransactionsListQuery({ limit: "nope" }).limit).toBe(100);
  });

  test("passes through a non-empty cursor", ({ expect }) => {
    expect(parseManualTransactionsListQuery({ cursor: "txn-9" }).cursor).toBe("txn-9");
  });
});
