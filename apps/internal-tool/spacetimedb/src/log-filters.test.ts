import { describe, expect, it } from "vitest";
import { aiLogMatches, mcpLogMatches, QA_REVIEW_FAILED_THRESHOLD_MICROS } from "./log-filters";

const NOW_MICROS = 10_000_000_000n;

function timestamp(micros: bigint) {
  return { microsSinceUnixEpoch: micros };
}

function aiRow(overrides: Partial<{
  systemPromptId: string,
  modelId: string,
  mode: string,
  isAuthenticated: boolean,
  errorMessage: string | undefined,
}> = {}) {
  return {
    systemPromptId: "docs-ask-ai",
    modelId: "openai/gpt-test",
    mode: "generate",
    isAuthenticated: true,
    errorMessage: undefined,
    ...overrides,
  };
}

function mcpRow(overrides: Partial<{
  toolName: string,
  errorMessage: string | undefined,
  qaOverallScore: number | undefined,
  qaErrorMessage: string | undefined,
  qaNeedsHumanReview: boolean | undefined,
  humanReviewedAt: { microsSinceUnixEpoch: bigint } | undefined,
  createdAt: { microsSinceUnixEpoch: bigint },
  qaReviewRequestedAt: { microsSinceUnixEpoch: bigint },
  qaFlagsJson: string | undefined,
}> = {}) {
  const recently = NOW_MICROS - 1_000_000n;
  return {
    toolName: "ask_hexclave",
    errorMessage: undefined,
    qaOverallScore: undefined,
    qaErrorMessage: undefined,
    qaNeedsHumanReview: undefined,
    humanReviewedAt: undefined,
    createdAt: timestamp(recently),
    qaReviewRequestedAt: timestamp(recently),
    qaFlagsJson: undefined,
    ...overrides,
  };
}

describe("aiLogMatches", () => {
  it("combines exact categorical filters", () => {
    const row = aiRow();
    expect(aiLogMatches(row, {
      systemPromptId: "docs-ask-ai",
      modelId: "openai/gpt-test",
      mode: "generate",
      isAuthenticated: true,
      hasError: false,
    })).toBe(true);
    expect(aiLogMatches(row, {
      systemPromptId: "command-center-ask-ai",
      modelId: undefined,
      mode: undefined,
      isAuthenticated: undefined,
      hasError: undefined,
    })).toBe(false);
  });

  it("treats only non-empty error messages as errors", () => {
    const filters = {
      systemPromptId: undefined,
      modelId: undefined,
      mode: undefined,
      isAuthenticated: undefined,
      hasError: false,
    };
    expect(aiLogMatches(aiRow({ errorMessage: "" }), filters)).toBe(true);
    expect(aiLogMatches(aiRow({ errorMessage: "provider failed" }), filters)).toBe(false);
  });
});

describe("mcpLogMatches", () => {
  function filters(overrides: Partial<{
    toolName: string | undefined,
    hasError: boolean | undefined,
    qaState: string | undefined,
    humanReviewState: string | undefined,
  }> = {}) {
    return {
      toolName: undefined,
      hasError: undefined,
      qaState: undefined,
      humanReviewState: undefined,
      ...overrides,
    };
  }

  it("separates pending reviews from timed-out and errored reviews", () => {
    expect(mcpLogMatches(mcpRow(), filters({ qaState: "pending" }), NOW_MICROS)).toBe(true);

    const timedOut = mcpRow({
      createdAt: timestamp(NOW_MICROS - QA_REVIEW_FAILED_THRESHOLD_MICROS - 1n),
      qaReviewRequestedAt: timestamp(NOW_MICROS - QA_REVIEW_FAILED_THRESHOLD_MICROS - 1n),
    });
    expect(mcpLogMatches(timedOut, filters({ qaState: "review-failed" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(timedOut, filters({ qaState: "pending" }), NOW_MICROS)).toBe(false);

    const errored = mcpRow({ qaErrorMessage: "review provider failed" });
    expect(mcpLogMatches(errored, filters({ qaState: "error" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(errored, filters({ qaState: "review-failed" }), NOW_MICROS)).toBe(false);
  });

  it("uses the most recent review request when deciding whether a retry timed out", () => {
    const oldCallWithRecentRetry = mcpRow({
      createdAt: timestamp(NOW_MICROS - QA_REVIEW_FAILED_THRESHOLD_MICROS - 1n),
      qaReviewRequestedAt: timestamp(NOW_MICROS - 1n),
    });
    expect(mcpLogMatches(oldCallWithRecentRetry, filters({ qaState: "pending" }), NOW_MICROS)).toBe(true);
  });

  it("maps QA scores to pass, warning, and fail bands", () => {
    expect(mcpLogMatches(mcpRow({ qaOverallScore: 80 }), filters({ qaState: "pass" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(mcpRow({ qaOverallScore: 79 }), filters({ qaState: "warn" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(mcpRow({ qaOverallScore: 49 }), filters({ qaState: "fail" }), NOW_MICROS)).toBe(true);
  });

  it("distinguishes required, reviewed, and not-reviewed human states", () => {
    const required = mcpRow({ qaNeedsHumanReview: true });
    const reviewed = mcpRow({ qaNeedsHumanReview: true, humanReviewedAt: timestamp(NOW_MICROS) });
    expect(mcpLogMatches(required, filters({ humanReviewState: "required" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(required, filters({ humanReviewState: "not-reviewed" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(reviewed, filters({ humanReviewState: "reviewed" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(reviewed, filters({ humanReviewState: "required" }), NOW_MICROS)).toBe(false);
  });

  it("combines tool, call status, QA, and human-review filters", () => {
    const row = mcpRow({
      qaOverallScore: 92,
      humanReviewedAt: timestamp(NOW_MICROS),
    });
    expect(mcpLogMatches(row, filters({
      toolName: "ask_hexclave",
      hasError: false,
      qaState: "pass",
      humanReviewState: "reviewed",
    }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(row, filters({ toolName: "other_tool" }), NOW_MICROS)).toBe(false);
  });

  it("finds AI-scanned feature requests without treating malformed flags as matches", () => {
    const featureRequest = mcpRow({
      qaFlagsJson: JSON.stringify([{ type: "unsupported_feature_request", severity: "low" }]),
    });
    expect(mcpLogMatches(featureRequest, filters({ qaState: "feature-request" }), NOW_MICROS)).toBe(true);
    expect(mcpLogMatches(mcpRow({ qaFlagsJson: "malformed" }), filters({ qaState: "feature-request" }), NOW_MICROS)).toBe(false);
    expect(mcpLogMatches(mcpRow(), filters({ qaState: "feature-request" }), NOW_MICROS)).toBe(false);
  });
});
