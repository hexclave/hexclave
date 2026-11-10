import { describe, expect, it } from "vitest";
import { FEATURE_REQUEST_FLAG_TYPE } from "../../lib/feature-request-flag";
import { QA_REVIEW_FAILED_THRESHOLD_MS } from "../../utils";
import { isAiReviewRetryable, needsHumanReview, parseQaFlags, qaStatus, qaStatusLabel, qualityFlagTypes } from "./mcp";
import { FIXTURE_NOW, mcpRow, timestampAt } from "./test-fixtures";

describe("qaStatus", () => {
  it("bands completed scores", () => {
    expect(qaStatus(mcpRow({ qaOverallScore: 92 }), FIXTURE_NOW)).toEqual({ kind: "scored", score: 92, band: "pass" });
    expect(qaStatus(mcpRow({ qaOverallScore: 80 }), FIXTURE_NOW)).toMatchObject({ band: "pass" });
    expect(qaStatus(mcpRow({ qaOverallScore: 79 }), FIXTURE_NOW)).toMatchObject({ band: "warn" });
    expect(qaStatus(mcpRow({ qaOverallScore: 50 }), FIXTURE_NOW)).toMatchObject({ band: "warn" });
    expect(qaStatus(mcpRow({ qaOverallScore: 49 }), FIXTURE_NOW)).toMatchObject({ band: "fail" });
  });

  it("lets a review error win over a score, matching the server-side QA state filter", () => {
    expect(qaStatus(mcpRow({ qaOverallScore: 90, qaErrorMessage: "timeout" }), FIXTURE_NOW)).toEqual({ kind: "error", message: "timeout" });
  });

  it("flips pending to review-failed once the threshold passes", () => {
    const row = mcpRow();
    expect(qaStatus(row, FIXTURE_NOW + QA_REVIEW_FAILED_THRESHOLD_MS)).toEqual({ kind: "pending" });
    expect(qaStatus(row, FIXTURE_NOW + QA_REVIEW_FAILED_THRESHOLD_MS + 1)).toEqual({ kind: "review-failed" });
  });

  it("measures the threshold from a later re-request, not the call time", () => {
    const row = mcpRow({ qaReviewRequestedAt: timestampAt(FIXTURE_NOW + 10 * 60 * 1000) });
    expect(qaStatus(row, FIXTURE_NOW + 11 * 60 * 1000)).toEqual({ kind: "pending" });
  });

  it("labels every state", () => {
    expect(qaStatusLabel({ kind: "scored", score: 64, band: "warn" })).toBe("64");
    expect(qaStatusLabel({ kind: "error", message: "x" })).toBe("Error");
    expect(qaStatusLabel({ kind: "review-failed" })).toBe("Failed");
    expect(qaStatusLabel({ kind: "pending" })).toBe("Pending");
  });
});

describe("isAiReviewRetryable", () => {
  const late = FIXTURE_NOW + QA_REVIEW_FAILED_THRESHOLD_MS + 1;

  it("allows retrying errored and silently failed reviews", () => {
    expect(isAiReviewRetryable(mcpRow({ qaErrorMessage: "boom" }), FIXTURE_NOW)).toBe(true);
    expect(isAiReviewRetryable(mcpRow(), late)).toBe(true);
  });

  it("refuses pending, scored, and already-reviewed calls", () => {
    expect(isAiReviewRetryable(mcpRow(), FIXTURE_NOW)).toBe(false);
    expect(isAiReviewRetryable(mcpRow({ qaOverallScore: 70 }), late)).toBe(false);
    expect(isAiReviewRetryable(mcpRow({ qaErrorMessage: "boom", qaReviewedAt: timestampAt(FIXTURE_NOW) }), late)).toBe(false);
  });
});

describe("needsHumanReview", () => {
  it("is true only for flagged calls nobody has reviewed", () => {
    expect(needsHumanReview(mcpRow({ qaNeedsHumanReview: true }))).toBe(true);
    expect(needsHumanReview(mcpRow({ qaNeedsHumanReview: true, humanReviewedAt: timestampAt(FIXTURE_NOW) }))).toBe(false);
    expect(needsHumanReview(mcpRow({ qaNeedsHumanReview: false }))).toBe(false);
    expect(needsHumanReview(mcpRow())).toBe(false);
  });
});

describe("parseQaFlags", () => {
  it("keeps well-formed flags and drops malformed entries", () => {
    expect(parseQaFlags(JSON.stringify([
      { type: "hallucination", severity: "high", explanation: "Invented an API" },
      { type: "missing-fields" },
      "nonsense",
    ]))).toMatchInlineSnapshot(`
      [
        {
          "explanation": "Invented an API",
          "severity": "high",
          "type": "hallucination",
        },
      ]
    `);
  });

  it("treats empty, missing, non-array and malformed JSON as no flags", () => {
    expect(parseQaFlags(undefined)).toEqual([]);
    expect(parseQaFlags("")).toEqual([]);
    expect(parseQaFlags("{}")).toEqual([]);
    expect(parseQaFlags("{not json")).toEqual([]);
  });
});

describe("qualityFlagTypes", () => {
  it("dedupes flag types and leaves out the feature-request marker", () => {
    const row = mcpRow({
      qaFlagsJson: JSON.stringify([
        { type: "outdated", severity: "low", explanation: "a" },
        { type: "outdated", severity: "medium", explanation: "b" },
        { type: FEATURE_REQUEST_FLAG_TYPE, severity: "low", explanation: "c" },
      ]),
    });
    expect(qualityFlagTypes(row)).toEqual(["outdated"]);
  });
});
