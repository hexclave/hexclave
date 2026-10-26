import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireInternalAiChatReviewer } from "../../../lib/server/internal-auth";
import { executeConsoleSql } from "../../../lib/server/sql-console";
import { signSpacetimeToken } from "../../../lib/server/spacetimedb-token";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

vi.mock("server-only", () => ({}));
vi.mock("../../../lib/server/internal-auth", () => ({
  requireInternalAiChatReviewer: vi.fn(async () => ({ user: { id: "test-member" }, reviewerName: "Test member" })),
}));
vi.mock("../../../lib/server/spacetimedb-token", () => ({
  signSpacetimeToken: vi.fn(async () => "member-token"),
}));
vi.mock("../../../lib/server/sql-console", () => ({
  executeConsoleSql: vi.fn(async () => ({ columns: ["id"], rows: [[1]], elapsedMs: 2 })),
}));
afterEach(() => {
  vi.clearAllMocks();
});

function request(body: unknown) {
  return new Request("http://localhost/api/sql", { method: "POST", body: JSON.stringify(body) });
}

describe("SQL route", () => {
  it("requires the signed-in member before executing queries", async () => {
    vi.mocked(requireInternalAiChatReviewer).mockRejectedValueOnce(new StatusError(StatusError.Unauthorized, "Sign in required."));
    const response = await POST(request({ sql: "SELECT * FROM query_ai_usage LIMIT 1" }));
    expect(response.status).toBe(401);
    expect(executeConsoleSql).not.toHaveBeenCalled();
    expect(signSpacetimeToken).not.toHaveBeenCalled();
  });
  it("rejects invalid request bodies", async () => {
    const response = await POST(request({ sql: 123 }));
    expect(response.status).toBe(400);
    expect(executeConsoleSql).not.toHaveBeenCalled();
  });
  it("returns ordered results without exposing the member token", async () => {
    const response = await POST(request({ sql: "SELECT * FROM query_ai_usage LIMIT 1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(signSpacetimeToken).toHaveBeenCalledWith({ subject: "test-member", name: "Test member" });
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "columns": [
          "id",
        ],
        "elapsedMs": 2,
        "rows": [
          [
            1,
          ],
        ],
      }
    `);
  });
});
