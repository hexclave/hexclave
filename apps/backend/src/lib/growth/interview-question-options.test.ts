import { describe, expect, it } from "vitest";
import { normalizeGrowthInterviewOptionalOther, withGrowthInterviewOtherOption } from "./interview-question-options";

describe("withGrowthInterviewOtherOption", () => {
  it("appends the escape hatch when the writer left it out", () => {
    expect(withGrowthInterviewOtherOption([{ id: "signups", label: "More signups" }])).toEqual([
      { id: "signups", label: "More signups", description: undefined },
      { id: "other", label: "Other", description: "Write your own answer" },
    ]);
  });

  it("is idempotent, so re-saving an unchanged question does not duplicate or reorder it", () => {
    const once = withGrowthInterviewOtherOption([{ id: "signups", label: "More signups" }]);
    expect(withGrowthInterviewOtherOption(once)).toEqual(once);
  });

  it("moves an out-of-place escape hatch to the end and normalizes its copy", () => {
    // The agent has produced plans with "Other" in the middle, or labelled "Someone else". The id is
    // the durable contract, so the copy is rewritten while the reviewer's description survives.
    expect(withGrowthInterviewOtherOption([
      { id: "Other", label: "Someone else", description: "Tell us more" },
      { id: "revenue", label: "More revenue" },
    ])).toEqual([
      { id: "revenue", label: "More revenue", description: undefined },
      { id: "other", label: "Other", description: "Tell us more" },
    ]);
  });

  it("collapses case variants rather than storing two ids that answer validation cannot tell apart", () => {
    const normalized = withGrowthInterviewOtherOption([
      { id: "other", label: "Other" },
      { id: "OTHER", label: "Other again" },
    ]);
    expect(normalized.filter((option) => option.id === "other")).toHaveLength(1);
    expect(normalized).toHaveLength(1);
  });
});

describe("normalizeGrowthInterviewOptionalOther", () => {
  it("preserves an explicit staff choice to omit Other", () => {
    expect(normalizeGrowthInterviewOptionalOther([{ id: "signups", label: "More signups" }])).toEqual([
      { id: "signups", label: "More signups", description: undefined },
    ]);
  });

  it("normalizes Other when staff keep it enabled", () => {
    expect(normalizeGrowthInterviewOptionalOther([
      { id: "Other", label: "Custom", description: "Explain" },
      { id: "signups", label: "More signups" },
    ])).toEqual([
      { id: "signups", label: "More signups", description: undefined },
      { id: "other", label: "Other", description: "Explain" },
    ]);
  });
});
