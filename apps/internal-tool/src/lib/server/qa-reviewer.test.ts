import { describe, expect, it, vi } from "vitest";

// The module under test imports the `server-only` marker package, which throws
// outside a Next.js server context. Same workaround as the sibling server tests.
vi.mock("server-only", () => ({}));

const { qaReviewSchema } = await import("./qa-reviewer");

const baseReview = {
  needsHumanReview: false,
  answerCorrect: true,
  answerRelevant: true,
  flags: [],
  overallScore: 92,
};

describe("qaReviewSchema", () => {
  it("treats an omitted featureRequest as 'not detected' instead of failing the review", () => {
    const parsed = qaReviewSchema.parse(baseReview);
    expect(parsed.featureRequest).toEqual({ detected: false, summary: "", evidence: "" });
    expect(parsed.improvementSuggestions).toBe("");
  });

  it("fills missing summary and evidence with empty strings", () => {
    const parsed = qaReviewSchema.parse({ ...baseReview, featureRequest: { detected: false } });
    expect(parsed.featureRequest).toEqual({ detected: false, summary: "", evidence: "" });
  });

  it("passes a fully specified featureRequest through unchanged", () => {
    const featureRequest = { detected: true, summary: "Support SAML", evidence: "User asked for SAML; docs list no SAML provider." };
    const parsed = qaReviewSchema.parse({ ...baseReview, featureRequest });
    expect(parsed.featureRequest).toEqual(featureRequest);
  });

  it("still rejects a featureRequest without the detected verdict", () => {
    expect(() => qaReviewSchema.parse({ ...baseReview, featureRequest: { summary: "x", evidence: "y" } })).toThrow();
  });
});
