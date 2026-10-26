import { afterEach, describe, expect, it, vi } from "vitest";
import { executeConsoleSql } from "./sql-console";
import { callReducerStrict } from "./spacetimedb-client";
import { handleApiError } from "./route-utils";

vi.mock("server-only", () => ({}));
vi.mock("./spacetimedb-client", () => ({ callReducerStrict: vi.fn(async () => {}) }));

function setup(response: Response) {
  vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "ws://localhost:9139");
  vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_DB_NAME", "test-db");
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const sql = "SELECT * FROM query_ai_usage LIMIT 10";
const signal = new AbortController().signal;

describe("SQL console server", () => {
  it("uses the member token, configured host, column order and nullable values", async () => {
    const fetchMock = setup(Response.json([{
      schema: { elements: [{ name: { some: "id" } }, { name: { some: "projectId" } }] },
      rows: [[1, { none: [] }]],
    }]));
    const result = await executeConsoleSql("member-token", sql, signal);
    expect(callReducerStrict).toHaveBeenCalledWith("member-token", "touch_session", []);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9139/v1/database/test-db/sql", expect.objectContaining({
      body: sql, headers: { "Content-Type": "text/plain", Authorization: "Bearer member-token" },
    }));
    expect(result.columns).toEqual(["id", "projectId"]);
    expect(result.rows).toEqual([[1, { none: [] }]]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
  it("validates before sending anything upstream", async () => {
    const fetchMock = setup(Response.json([]));
    await expect(executeConsoleSql("token", "DELETE FROM query_ai_usage", signal)).rejects.toThrow("Only SELECT");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callReducerStrict).not.toHaveBeenCalled();
  });
  it("does not expose upstream bodies on syntax errors or failures", async () => {
    for (const status of [400, 401, 403, 500]) {
      setup(new Response("internal private diagnostic", { status }));
      const response = await executeConsoleSql("token", sql, signal).then(
        () => { throw new Error("Expected query failure"); },
        error => handleApiError("sql-test", error),
      );
      expect(await response.text()).not.toContain("private diagnostic");
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
  it.each([
    { payload: [] },
    { payload: [{ schema: { elements: [{ name: { some: "id" } }] }, rows: [[1, 2]] }] },
    { payload: [{ schema: { elements: [] }, rows: Array.from({ length: 1001 }, () => []) }] },
  ])("rejects malformed responses", async ({ payload }) => {
    setup(Response.json(payload));
    await expect(executeConsoleSql("token", sql, signal)).rejects.toThrow();
  });
  it("preserves integers larger than JavaScript's safe range", async () => {
    setup(new Response('[{"schema":{"elements":[{"name":{"some":"id"}}]},"rows":[[18446744073709551615]]}]'));
    const result = await executeConsoleSql("token", sql, signal);
    expect(result.rows).toEqual([["18446744073709551615"]]);
  });
  it("rejects oversized responses", async () => {
    setup(new Response(" ".repeat(5_000_001)));
    await expect(executeConsoleSql("token", sql, signal)).rejects.toThrow("Results exceed 5 MB");
  });
});
