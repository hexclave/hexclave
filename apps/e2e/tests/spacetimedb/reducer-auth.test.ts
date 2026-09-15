import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { callReducer, createCleanupScope, isSpacetimedbReachable, signMemberToken, mintIdentity, opt, sqlQuery, touchSession, type CleanupScope } from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Args for every mutating reducer: used to smoke-test the membership gate. If
// a reducer is added to the module, it must be added here too or this smoke
// covers one less attack surface.
const ALL_MUTATING_REDUCERS: Array<{ name: string, args: unknown[] }> = [
  { name: "set_human_reviewed", args: ["corr", true] },
  { name: "upsert_qa_from_call_and_mark_reviewed", args: ["corr", "q", "a", false] },
  { name: "add_manual_qa", args: ["q", "a", false, "req-id"] },
  { name: "delete_qa_entry", args: [0n] },
  { name: "update_qa_entry_with_publish", args: [0n, "q", "a", false] },
  {
    name: "log_mcp_call",
    args: ["corr", opt(null), "tool", "reason", "prompt", "q", "r", 0, "[]", 0n, "model", opt(null)],
  },
  {
    name: "log_ai_query",
    args: ["corr", "chat", "sys", "q", "s", "model", false, opt(null), opt(null), "[]", "[]", "[]", "text", opt(null), opt(null), opt(null), opt(null), opt(null), opt(null), opt(null), 0, 0n, opt(null), opt(null)],
  },
  { name: "update_ai_query_usage", args: ["corr", opt(null), opt(null), opt(null), opt(null), opt(null)] },
  { name: "delete_mcp_call_log", args: ["corr"] },
  { name: "delete_ai_query_log", args: ["corr"] },
  { name: "clear_mcp_qa_review", args: ["corr"] },
  { name: "update_mcp_qa_review", args: ["corr", false, false, false, "[]", "", 0, "model", opt(null), opt(null)] },
  {
    name: "log_feedback",
    args: ["corr", opt(null), "bug", "message", "mcp-ask-hexclave", opt(null), opt(null), opt(null), opt(null), opt(null)],
  },
  { name: "delete_feedback", args: ["corr"] },
];

describe.skipIf(!canRun)("SpacetimeDB reducer auth", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("an identity without Stack Auth claims sees zero rows in my_visible_mcp_call_log", async ({ expect }) => {
    // Seed mcp_call_log itself (the table the view projects) so it is
    // definitely non-empty — otherwise a 0-row result could be a false
    // positive from an empty table.
    const memberToken = await signMemberToken();
    const seedMarker = uniqueMarker("reducer-auth-seed");
    scope.trackMcpQuestion(seedMarker);
    const seed = await callReducer(memberToken, "log_mcp_call", [
      seedMarker, // correlationId
      opt(null), // conversationId
      "reducer-auth-seed-tool",
      "reason",
      "prompt",
      seedMarker, // question — cleanup looks rows up by this marker
      "response",
      0, // stepCount
      "[]", // innerToolCallsJson
      0n, // durationMs
      "model",
      opt(null), // errorMessage
    ]);
    expect(seed.ok, seed.body).toBe(true);

    const stranger = await mintIdentity();
    await touchSession(stranger.token).catch(() => undefined);
    const result = await sqlQuery(stranger.token, "SELECT * FROM my_visible_mcp_call_log");
    expect(result.rows.length).toBe(0);
  });

  it("every mutating reducer rejects a SpacetimeDB-native token without Stack Auth claims", async ({ expect }) => {
    const stranger = await mintIdentity();
    for (const { name, args } of ALL_MUTATING_REDUCERS) {
      const result = await callReducer(stranger.token, name, args);
      expect(result.ok, `reducer ${name} should reject a non-member token`).toBe(false);
      expect(result.body, `reducer ${name} should report an unauthorized error`).toContain("Unauthorized");
    }
  });

  it("every mutating reducer accepts a project-member token (gate check, not state check)", async ({ expect }) => {
    // These target a nonexistent correlationId, so a passing gate surfaces as
    // the domain "not found" error rather than the unauthorized error.
    const memberToken = await signMemberToken();
    const result = await callReducer(memberToken, "clear_mcp_qa_review", [uniqueMarker("nonexistent")]);
    expect(result.ok).toBe(false);
    expect(result.body).toContain("Call log not found");
  });
});
