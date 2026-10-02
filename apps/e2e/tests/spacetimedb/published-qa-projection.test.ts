import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { callReducer, createCleanupScope, isSpacetimedbReachable, signMemberToken, mintIdentity, sqlQuery, type CleanupScope } from "./helpers";

const canRun = await isSpacetimedbReachable();

const EXPECTED_PUBLISHED_QA_COLUMNS = ["id", "question", "answer", "published_at"] as const;

// Fields from mcp_call_log that MUST NOT appear in the public view. If any of these
// reappear, the projection has regressed and internal metadata is leaking to the
// unauthenticated /questions page.
const FORBIDDEN_COLUMNS = [
  "human_reviewed_by",
  "human_reviewed_at",
  "user_prompt",
  "qa_reviewed_at",
  "qa_flags_json",
  "qa_improvement_suggestions",
  "qa_conversation_json",
  "model_id",
  "correlation_id",
  "conversation_id",
  "response",
  "reason",
  "tool_name",
  "inner_tool_calls_json",
  "human_corrected_question",
  "human_corrected_answer",
];

describe.skipIf(!canRun)("published_qa view projection", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("exposes only {id, question, answer, publishedAt} — no reviewer or QA internals", async ({ expect }) => {
    const reviewerToken = await signMemberToken();

    const markerQuestion = `test-projection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    scope.trackMcpQuestion(markerQuestion);
    const markerAnswer = "answer-for-projection-test";

    const publish = await callReducer(reviewerToken, "add_manual_qa", [markerQuestion, markerAnswer, true, markerQuestion]);
    expect(publish.ok, publish.body).toBe(true);

    // Query with a fresh claimless token — published_qa is anonymousView so any
    // bearer works; using a stranger identity matches the real public-page scenario.
    const stranger = await mintIdentity();
    const result = await sqlQuery(stranger.token, "SELECT * FROM published_qa");

    // Regression: the projected column set must be exactly these four names.
    expect([...result.columns].sort()).toEqual([...EXPECTED_PUBLISHED_QA_COLUMNS].sort());
    for (const forbidden of FORBIDDEN_COLUMNS) {
      expect(result.columns).not.toContain(forbidden);
    }

    // Our marker row must be present and carry the corrected (answer) payload, not
    // the raw response (which would be empty for a manually-added row).
    const ours = result.rows.find(r => r.question === markerQuestion);
    expect(ours).toBeDefined();
    expect(ours).toMatchObject({ question: markerQuestion, answer: markerAnswer });
  });
});
