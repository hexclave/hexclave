import type { GrowthAdminInterviewQuestion } from "@/lib/growth/growth-interview-admin-api";
import { describe, expect, it } from "vitest";
import { formatGrowthAdminInterviewAnswer } from "./interview-card";

function question(answer: Pick<GrowthAdminInterviewQuestion, "answerOptionIds" | "answerFreeText" | "answeredAtMillis">): GrowthAdminInterviewQuestion {
  return {
    id: "question-1",
    orderIndex: 0,
    questionKey: "primary-goal",
    prompt: "What matters most?",
    kind: "single",
    options: [
      { id: "signups", label: "More signups", description: null },
      { id: "other", label: "Other", description: "Write your own answer" },
    ],
    allowSkip: true,
    origin: "planned",
    ...answer,
  };
}

describe("formatGrowthAdminInterviewAnswer", () => {
  it("shows the selected option label", () => {
    expect(formatGrowthAdminInterviewAnswer(question({
      answerOptionIds: ["signups"],
      answerFreeText: null,
      answeredAtMillis: 1,
    }))).toBe("Answered: More signups");
  });

  it("includes written context for Other", () => {
    expect(formatGrowthAdminInterviewAnswer(question({
      answerOptionIds: ["other"],
      answerFreeText: "Partnerships",
      answeredAtMillis: 1,
    }))).toBe("Answered: Other — Partnerships");
  });

  it("distinguishes a skipped question from an unanswered one", () => {
    expect(formatGrowthAdminInterviewAnswer(question({
      answerOptionIds: null,
      answerFreeText: null,
      answeredAtMillis: 1,
    }))).toBe("Skipped");
    expect(formatGrowthAdminInterviewAnswer(question({
      answerOptionIds: null,
      answerFreeText: null,
      answeredAtMillis: null,
    }))).toBeNull();
  });
});
