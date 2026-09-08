import { describe, expect, it } from "vitest";
import { buildInterviewAnswerDraft, interviewOptionsWithOther } from "./question-card";

describe("interviewOptionsWithOther", () => {
  it("adds Other to legacy questions that do not have it", () => {
    expect(interviewOptionsWithOther([{ id: "signups", label: "More signups", description: null }])).toEqual([
      { id: "signups", label: "More signups", description: null },
      { id: "__growth_other__", label: "Other", description: "Write your own answer" },
    ]);
  });

  it("normalizes an existing Other option and keeps it last", () => {
    expect(interviewOptionsWithOther([
      { id: "other", label: "Someone else", description: null },
      { id: "agencies", label: "Agencies", description: null },
    ])).toEqual([
      { id: "agencies", label: "Agencies", description: null },
      { id: "other", label: "Other", description: "Write your own answer" },
    ]);
  });

  it("omits Other when staff disabled it for the question", () => {
    expect(interviewOptionsWithOther([
      { id: "signups", label: "More signups", description: null },
      { id: "other", label: "Other", description: "Write your own answer" },
    ], false)).toEqual([
      { id: "signups", label: "More signups", description: null },
    ]);
  });
});

describe("buildInterviewAnswerDraft", () => {
  it("sends a typed Other answer without the synthetic legacy id", () => {
    expect(buildInterviewAnswerDraft(["__growth_other__"], "  Partnerships  ")).toEqual({
      optionIds: [],
      freeText: "Partnerships",
      skipped: false,
    });
  });

  it("keeps the persisted Other id and custom text for new questions", () => {
    expect(buildInterviewAnswerDraft(["organic", "other"], "Events")).toEqual({
      optionIds: ["organic", "other"],
      freeText: "Events",
      skipped: false,
    });
  });

  it("does not send stale text with an ordinary option", () => {
    expect(buildInterviewAnswerDraft(["organic"], "old custom answer")).toEqual({
      optionIds: ["organic"],
      freeText: null,
      skipped: false,
    });
  });
});
