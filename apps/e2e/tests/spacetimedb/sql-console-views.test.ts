import { describe } from "vitest";
import { it } from "../helpers";
import { callReducer, isSpacetimedbReachable, mintIdentity, opt, signMemberToken, sqlQuery, touchSession } from "./helpers";

const canRun = await isSpacetimedbReachable();

describe.skipIf(!canRun)("SQL console full-history views", () => {
  it("does not expose any query view rows to non-members", async ({ expect }) => {
    const stranger = await mintIdentity();
    for (const view of ["query_ai_usage", "query_mcp_calls", "query_feedback"]) {
      const result = await sqlQuery(stranger.token, `SELECT * FROM ${view} LIMIT 1`);
      expect(result.rows).toMatchInlineSnapshot("[]");
    }
  });

  it("queries rows older than the live window and supports projections and COUNT", async ({ expect }) => {
    const token = await signMemberToken();
    const session = await touchSession(token);
    expect(session.ok, session.body).toBe(true);
    const marker = `sql-console-${crypto.randomUUID()}`;
    const inserted: string[] = [];
    try {
      // This fixture exceeds the live window without depending on existing rows.
      for (let index = 0; index < 201; index++) {
        const correlationId = `${marker}-${index}`;
        const result = await callReducer(token, "log_mcp_call", [
          correlationId, opt(null), "ask_hexclave", "reason", "prompt", marker, "response",
          1, "[]", 0n, "model", opt(null), opt(null), opt(null), opt(null),
        ]);
        expect(result.ok, result.body).toBe(true);
        inserted.push(correlationId);
      }
      const oldest = await sqlQuery(token, `SELECT question FROM query_mcp_calls WHERE "correlationId" = '${marker}-0' LIMIT 1`);
      expect(oldest.rows).toEqual([{ question: marker }]);
      const live = await sqlQuery(token, `SELECT question FROM my_visible_mcp_call_log WHERE "correlationId" = '${marker}-0' LIMIT 1`);
      expect(live.rows).toMatchInlineSnapshot("[]");
      const count = await sqlQuery(token, `SELECT COUNT(*) AS n FROM query_mcp_calls WHERE question = '${marker}' LIMIT 1`);
      expect(count.rows).toEqual([{ n: 201 }]);
      const stranger = await mintIdentity();
      const hidden = await sqlQuery(stranger.token, `SELECT question FROM query_mcp_calls WHERE question = '${marker}' LIMIT 1`);
      expect(hidden.rows).toMatchInlineSnapshot("[]");
    } finally {
      for (const correlationId of inserted) {
        const result = await callReducer(token, "delete_mcp_call_log", [correlationId]);
        if (!result.ok) throw new Error("SQL console fixture cleanup failed.");
      }
    }
  });
});
