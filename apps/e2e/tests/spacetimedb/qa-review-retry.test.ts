// Covers the review-retry lifecycle on mcp_call_log's qaReviewRequestedAt:
// stamped at insert, re-stamped by clear_mcp_qa_review, untouched by
// update_mcp_qa_review. The UI derives its "Reviewing…" vs "Review failed"
// state from max(createdAt, qaReviewRequestedAt); without the re-stamp, a
// retried row older than the failed-threshold would immediately read as
// failed again while the re-review is still running.

import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import {
  callReducer, createCleanupScope, decodeOptional, findCorrelationIdByQuestion,
  isSpacetimedbReachable, opt, signMemberToken, sqlQuery, touchSession, type CleanupScope,
} from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// SpacetimeDB /sql encodes timestamps as a single-element product array
// ([micros]); accept object/bare-numeric encodings too for robustness across
// versions (mirrors decodeOptional in helpers.ts). Normalized to bigint micros.
function timestampMicros(value: unknown): bigint {
  if (Array.isArray(value) && value.length === 1) {
    return timestampMicros(value[0]);
  }
  if (typeof value === "object" && value != null && "__timestamp_micros_since_unix_epoch__" in value) {
    return timestampMicros((value as Record<string, unknown>).__timestamp_micros_since_unix_epoch__);
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`Cannot interpret timestamp value: ${JSON.stringify(value)}`);
}

async function fetchRow(token: string, question: string): Promise<Record<string, unknown>> {
  const { rows } = await sqlQuery(token, "SELECT * FROM my_visible_mcp_call_log");
  const row = rows.find(r => r.question === question);
  if (row == null) throw new Error(`Row not found for question marker: ${question}`);
  return row;
}

describe.skipIf(!canRun)("qa review retry lifecycle", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("stamps qaReviewRequestedAt at insert and re-stamps it on clear_mcp_qa_review", async ({ expect }) => {
    const token = await signMemberToken();
    await touchSession(token);
    const marker = uniqueMarker("qa-retry-lifecycle");
    scope.trackMcpQuestion(marker);
    const correlationId = crypto.randomUUID();

    const insert = await callReducer(token, "log_mcp_call", [
      correlationId, opt(null), "tool", "reason", "prompt", marker, "response", 0, "[]", 0n, "model", opt(null),
    ]);
    expect(insert.ok, insert.body).toBe(true);

    const inserted = await fetchRow(token, marker);
    // Insert stamps the initial review request in the same reducer call, so
    // both timestamps are identical.
    expect(timestampMicros(inserted.qa_review_requested_at)).toBe(timestampMicros(inserted.created_at));
    expect(decodeOptional(inserted.qa_reviewed_at)).toBeUndefined();

    // Simulate a completed review, then a retry (retry-review always clears
    // before re-running).
    const update = await callReducer(token, "update_mcp_qa_review", [
      correlationId, false, false, false, "[]", "", 80, "model", opt(null), opt(null),
    ]);
    expect(update.ok, update.body).toBe(true);
    const reviewed = await fetchRow(token, marker);
    expect(decodeOptional(reviewed.qa_reviewed_at)).toBeDefined();
    // Completion must not touch the requested-at stamp.
    expect(timestampMicros(reviewed.qa_review_requested_at)).toBe(timestampMicros(inserted.qa_review_requested_at));

    const clear = await callReducer(token, "clear_mcp_qa_review", [correlationId]);
    expect(clear.ok, clear.body).toBe(true);

    const cleared = await fetchRow(token, marker);
    expect(decodeOptional(cleared.qa_reviewed_at)).toBeUndefined();
    expect(decodeOptional(cleared.qa_overall_score)).toBeUndefined();
    // The re-stamp is what keeps a retried row in the UI's "Reviewing…" state
    // instead of instantly re-entering "Review failed".
    expect(timestampMicros(cleared.qa_review_requested_at) > timestampMicros(cleared.created_at)).toBe(true);

    // Sanity-check cleanup wiring: the row must be discoverable the way the
    // cleanup scope looks it up.
    expect(await findCorrelationIdByQuestion(token, marker)).toBe(correlationId);
  });
});
