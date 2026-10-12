import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { callReducer, createCleanupScope, isSpacetimedbReachable, signMemberToken, mintIdentity, opt, sqlQuery, touchSession, type CleanupScope } from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedAiQueryLog(logWriterToken: string, correlationId: string) {
  return await callReducer(logWriterToken, "log_ai_query", [
    correlationId,
    "chat",
    "system-prompt-id",
    "high",
    "fast",
    "some-model",
    false,
    opt(null),
    opt(null),
    "[]",
    "[]",
    "[]",
    "final text",
    opt(null),
    opt(null),
    opt(null),
    opt(null),
    opt(null),
    opt(null),
    opt(null),
    0,
    0n,
    opt(null),
    opt(null),
  ]);
}

describe.skipIf(!canRun)("private log tables and view gating", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("an identity without Stack Auth claims sees zero rows in my_visible_ai_query_log", async ({ expect }) => {
    const logWriterToken = await signMemberToken();
    const aiQueryCorrelationId = uniqueMarker("ai-query-corr");
    scope.trackAiQueryCorrelationId(aiQueryCorrelationId);
    const seed = await seedAiQueryLog(logWriterToken, aiQueryCorrelationId);
    expect(seed.ok, seed.body).toBe(true);

    const stranger = await mintIdentity();
    await touchSession(stranger.token).catch(() => undefined);
    const { rows } = await sqlQuery(stranger.token, "SELECT * FROM my_visible_ai_query_log");
    expect(rows.length).toBe(0);
  });

  it("cannot subscribe to the private mcp_call_log table directly", async ({ expect }) => {
    // Seed a row so the table isn't empty — we're testing access control, not emptiness.
    const reviewerToken = await signMemberToken();
    const seedMarker = uniqueMarker("private-mcp-seed");
    scope.trackMcpQuestion(seedMarker);
    const seed = await callReducer(reviewerToken, "add_manual_qa", [seedMarker, "a", false, seedMarker]);
    expect(seed.ok, seed.body).toBe(true);

    // Private table: SpacetimeDB should either reject the query outright or return
    // zero rows to unauthorized callers. Either outcome is acceptable — the invariant
    // is "the caller does not see any private-table rows." If rejection, the error
    // must come from our own sqlQuery helper's HTTP-4xx path against this exact
    // table (not a network blip, not a helper regression).
    const stranger = await mintIdentity();
    const result = await sqlQuery(stranger.token, "SELECT * FROM mcp_call_log")
      .then(r => ({ ok: true as const, rows: r.rows }))
      .catch(err => ({ ok: false as const, err }));
    if (result.ok) {
      expect(result.rows.length).toBe(0);
    } else {
      expect(result.err).toBeInstanceOf(Error);
      expect((result.err as Error).message).toMatch(
        /SQL\s+"SELECT \* FROM mcp_call_log"\s+failed: HTTP 4\d\d/,
      );
    }
  });

  it("cannot subscribe to the private ai_query_log table directly", async ({ expect }) => {
    const logWriterToken = await signMemberToken();
    const aiQueryCorrelationId = uniqueMarker("ai-query-corr");
    scope.trackAiQueryCorrelationId(aiQueryCorrelationId);
    const seed = await seedAiQueryLog(logWriterToken, aiQueryCorrelationId);
    expect(seed.ok, seed.body).toBe(true);

    const stranger = await mintIdentity();
    const result = await sqlQuery(stranger.token, "SELECT * FROM ai_query_log")
      .then(r => ({ ok: true as const, rows: r.rows }))
      .catch(err => ({ ok: false as const, err }));
    if (result.ok) {
      expect(result.rows.length).toBe(0);
    } else {
      expect(result.err).toBeInstanceOf(Error);
      expect((result.err as Error).message).toMatch(
        /SQL\s+"SELECT \* FROM ai_query_log"\s+failed: HTTP 4\d\d/,
      );
    }
  });

  it("cannot read the private sessions table directly", async ({ expect }) => {
    // Ensure at least one session row exists.
    const reviewerToken = await signMemberToken();
    const touch = await touchSession(reviewerToken);
    expect(touch.ok, touch.body).toBe(true);

    const stranger = await mintIdentity();
    const result = await sqlQuery(stranger.token, "SELECT * FROM sessions")
      .then(r => ({ ok: true as const, rows: r.rows }))
      .catch(err => ({ ok: false as const, err }));
    if (result.ok) {
      expect(result.rows.length).toBe(0);
    } else {
      expect(result.err).toBeInstanceOf(Error);
      expect((result.err as Error).message).toMatch(
        /SQL\s+"SELECT \* FROM sessions"\s+failed: HTTP 4\d\d/,
      );
    }
  });
});
