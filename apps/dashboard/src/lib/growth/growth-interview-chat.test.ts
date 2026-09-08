import { describe, expect, it } from "vitest";
import { buildGrowthDemoInterview, GROWTH_DEMO_NOW_MILLIS } from "./growth-demo-data";
import {
  applyAnswerToQuestions,
  baseStateFromGrowthInterview,
  buildAnswerTranscriptText,
  buildDemoTranscriptEntries,
  countAnsweredQuestions,
  deriveInterviewChatView,
  findNextUnansweredQuestion,
  getPlanAnswer,
  INTERVIEW_COMPLETE_TOOL_PART_TYPE,
  INTERVIEW_QUESTION_TOOL_PART_TYPE,
  parseInterviewQuestionToolInput,
  planQuestionForEntry,
  questionCardFromPlanQuestion,
  uiMessageToTranscriptEntries,
  type InterviewQuestionCard,
  type InterviewTranscriptEntry,
} from "./growth-interview-chat";
import type { GrowthInterview, GrowthInterviewQuestion } from "./growth-types";

function makeQuestion(overrides: Partial<GrowthInterviewQuestion> = {}): GrowthInterviewQuestion {
  return {
    questionKey: "primary-goal",
    orderIndex: 0,
    prompt: "What is your primary growth goal?",
    kind: "single",
    options: [
      { id: "signups", label: "More signups", description: null },
      { id: "revenue", label: "More revenue", description: "Convert existing users" },
    ],
    allowSkip: true,
    origin: "planned",
    answerOptionIds: null,
    answerFreeText: null,
    answeredAtMillis: null,
    ...overrides,
  };
}

function makeCard(overrides: Partial<InterviewQuestionCard> = {}): InterviewQuestionCard {
  return {
    questionKey: "primary-goal",
    text: "What is your primary growth goal?",
    kind: "single",
    options: [{ id: "signups", label: "More signups", description: null }],
    allowFreeText: true,
    allowSkip: true,
    ...overrides,
  };
}

const validToolInput = {
  question_id: "q-1",
  question_key: "primary-goal",
  text: "What is your primary growth goal?",
  kind: "single",
  options: [{ id: "signups", label: "More signups" }, { id: "revenue", label: "More revenue", description: "Convert" }],
  allow_free_text: true,
  allow_skip: false,
};

describe("parseInterviewQuestionToolInput", () => {
  it("maps a valid tool input to a card, defaulting missing option descriptions to null", () => {
    const card = parseInterviewQuestionToolInput(validToolInput);
    expect(card).toEqual({
      questionKey: "primary-goal",
      text: "What is your primary growth goal?",
      kind: "single",
      options: [
        { id: "signups", label: "More signups", description: null },
        { id: "revenue", label: "More revenue", description: "Convert" },
      ],
      allowFreeText: true,
      allowSkip: false,
    });
  });

  it("returns null for malformed inputs", () => {
    expect(parseInterviewQuestionToolInput(null)).toBeNull();
    expect(parseInterviewQuestionToolInput({ ...validToolInput, text: undefined })).toBeNull();
    expect(parseInterviewQuestionToolInput({ ...validToolInput, kind: "many" })).toBeNull();
    expect(parseInterviewQuestionToolInput({ ...validToolInput, options: [{ id: "x" }] })).toBeNull();
  });
});

describe("uiMessageToTranscriptEntries", () => {
  it("converts text, question, and completion parts with stable per-part ids", () => {
    const message = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Thanks! Next:" },
        { type: INTERVIEW_QUESTION_TOOL_PART_TYPE, toolCallId: "call-1", input: validToolInput },
        { type: INTERVIEW_COMPLETE_TOOL_PART_TYPE, toolCallId: "call-2", input: {} },
      ],
    };
    const result = uiMessageToTranscriptEntries(message, "fallback");
    expect(result.malformed).toEqual([]);
    expect(result.entries).toMatchObject([
      { type: "text", id: "msg-1:0", role: "assistant", text: "Thanks! Next:" },
      { type: "question", id: "msg-1:1", card: { questionKey: "primary-goal" } },
      { type: "complete", id: "msg-1:2" },
    ]);
  });

  it("uses the fallback message id when the message has none, and skips empty text parts", () => {
    const result = uiMessageToTranscriptEntries({ role: "user", parts: [{ type: "text", text: "" }, { type: "text", text: "hi" }] }, "loaded:3");
    expect(result.entries).toEqual([{ type: "text", id: "loaded:3:1", role: "user", text: "hi" }]);
    expect(result.malformed).toEqual([]);
  });

  it("reports renderable-but-broken parts as malformed but silently ignores unknown part types", () => {
    const brokenQuestion = { type: INTERVIEW_QUESTION_TOOL_PART_TYPE, toolCallId: "call-1", input: { nope: true } };
    const message = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking..." },
        { type: "tool-some-future-tool", toolCallId: "call-9", input: {} },
        brokenQuestion,
        { type: "text" },
      ],
    };
    const result = uiMessageToTranscriptEntries(message, "fallback");
    expect(result.entries).toEqual([]);
    expect(result.malformed).toEqual([brokenQuestion, { type: "text" }]);
  });

  it("treats non-message values and unknown roles as malformed", () => {
    expect(uiMessageToTranscriptEntries("nope", "f")).toEqual({ entries: [], malformed: ["nope"] });
    const systemMessage = { role: "system", parts: [{ type: "text", text: "hidden" }] };
    expect(uiMessageToTranscriptEntries(systemMessage, "f")).toEqual({ entries: [], malformed: [systemMessage] });
  });
});

describe("question plan helpers", () => {
  it("finds the lowest-order unanswered question and counts answered ones", () => {
    const interview = buildGrowthDemoInterview("interview", GROWTH_DEMO_NOW_MILLIS);
    expect(countAnsweredQuestions(interview.questions)).toBe(3);
    expect(findNextUnansweredQuestion(interview.questions)?.orderIndex).toBe(3);
    const completed = buildGrowthDemoInterview("steady-state", GROWTH_DEMO_NOW_MILLIS);
    expect(findNextUnansweredQuestion(completed.questions)).toBeNull();
  });

  it("resolves plan answers: unanswered, options, free text, and per-question skips", () => {
    expect(getPlanAnswer(makeQuestion())).toBeNull();
    expect(getPlanAnswer(makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 })))
      .toEqual({ skipped: false, optionLabels: ["More signups"], freeText: null });
    expect(getPlanAnswer(makeQuestion({ answerFreeText: "We want virality", answeredAtMillis: 1 })))
      .toEqual({ skipped: false, optionLabels: [], freeText: "We want virality" });
    expect(getPlanAnswer(makeQuestion({ answeredAtMillis: 1 })))
      .toEqual({ skipped: true, optionLabels: [], freeText: null });
  });

  it("falls back to the raw option id when an answered option id is no longer in the options", () => {
    const answer = getPlanAnswer(makeQuestion({ answerOptionIds: ["gone"], answeredAtMillis: 1 }));
    expect(answer).toEqual({ skipped: false, optionLabels: ["gone"], freeText: null });
  });
});

describe("buildAnswerTranscriptText", () => {
  it("mirrors the backend's user-message format", () => {
    const question = makeQuestion();
    expect(buildAnswerTranscriptText(question, { orderIndex: 0, skipped: true })).toBe("(skipped this question)");
    expect(buildAnswerTranscriptText(question, { orderIndex: 0, optionIds: ["signups", "revenue"], freeText: "and churn" }))
      .toBe("More signups\nMore revenue\nand churn");
    expect(buildAnswerTranscriptText(question, { orderIndex: 0, optionIds: ["unknown-id"] })).toBe("unknown-id");
  });
});

describe("applyAnswerToQuestions", () => {
  it("applies an answer onto the matching plan row only", () => {
    const questions = [makeQuestion(), makeQuestion({ questionKey: "second", orderIndex: 1 })];
    const next = applyAnswerToQuestions(questions, { orderIndex: 1, optionIds: ["signups"], freeText: "details" }, 42);
    expect(next[0]).toEqual(questions[0]);
    expect(next[1]).toMatchObject({ answerOptionIds: ["signups"], answerFreeText: "details", answeredAtMillis: 42 });
  });

  it("stores skipped answers with cleared options and free text", () => {
    const next = applyAnswerToQuestions([makeQuestion()], { orderIndex: 0, skipped: true, optionIds: [], freeText: "" }, 42);
    expect(next[0]).toMatchObject({ answerOptionIds: null, answerFreeText: null, answeredAtMillis: 42 });
  });

  it("throws for an order index that is not in the plan", () => {
    expect(() => applyAnswerToQuestions([makeQuestion()], { orderIndex: 9 }, 42)).toThrowError(/order_index 9/);
  });
});

describe("deriveInterviewChatView", () => {
  const questionEntry = (card: InterviewQuestionCard, id = "e-q"): InterviewTranscriptEntry => ({ type: "question", id, card });

  it("makes the last question card interactive when its plan row is unanswered", () => {
    const plan = [makeQuestion()];
    const view = deriveInterviewChatView({ status: "active", questions: plan }, [questionEntry(makeCard())]);
    expect(view.activeQuestion).toMatchObject({ entryId: "e-q", planQuestion: { questionKey: "primary-goal" } });
    expect(view.needsAssistantTurn).toBe(false);
    expect(view.completed).toBe(false);
  });

  it("asks for an assistant turn when the last card is already answered (dropped-stream resume)", () => {
    const plan = [makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 })];
    const view = deriveInterviewChatView({ status: "active", questions: plan }, [questionEntry(makeCard())]);
    expect(view.activeQuestion).toBeNull();
    expect(view.needsAssistantTurn).toBe(true);
  });

  it("asks for an assistant turn on an empty transcript (fresh start)", () => {
    const view = deriveInterviewChatView({ status: "pending", questions: [makeQuestion()] }, []);
    expect(view.activeQuestion).toBeNull();
    expect(view.needsAssistantTurn).toBe(true);
  });

  it("treats a completion tool part, a completed status, and a skipped status as completed", () => {
    const plan = [makeQuestion()];
    const entries: InterviewTranscriptEntry[] = [questionEntry(makeCard()), { type: "complete", id: "e-c" }];
    for (const view of [
      deriveInterviewChatView({ status: "active", questions: plan }, entries),
      deriveInterviewChatView({ status: "completed", questions: plan }, [questionEntry(makeCard())]),
      deriveInterviewChatView({ status: "skipped", questions: plan }, [questionEntry(makeCard())]),
    ]) {
      expect(view.completed).toBe(true);
      expect(view.activeQuestion).toBeNull();
      expect(view.needsAssistantTurn).toBe(false);
    }
  });

  it("falls back to the next unanswered plan question when the last card's key is missing from the plan", () => {
    const view = deriveInterviewChatView({ status: "active", questions: [makeQuestion()] }, [questionEntry(makeCard({ questionKey: "unplanned" }))]);
    // The unplanned card itself stays unanswerable, but the interview must not strand the founder.
    expect(view.planQuestionByEntryId.get("e-q")).toBeUndefined();
    expect(view.entries).toHaveLength(2);
    expect(view.activeQuestion).toMatchObject({ planQuestion: { questionKey: "primary-goal", orderIndex: 0 } });
    expect(view.activeQuestion?.entryId).not.toBe("e-q");
    expect(view.needsAssistantTurn).toBe(false);
  });

  it("keeps the interview answerable when the agent re-presents an already-answered question", () => {
    // The reported bug: the agent repeated question 1 instead of moving on, so every card on screen
    // mapped to an answered row, all options rendered disabled, and the only affordance left was
    // "Continue the interview".
    const plan = [
      makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 }),
      makeQuestion({ questionKey: "pricing-model", orderIndex: 1, prompt: "How do you price?" }),
    ];
    const entries = [questionEntry(makeCard(), "e-q1"), questionEntry(makeCard(), "e-q1-again")];
    const view = deriveInterviewChatView({ status: "active", questions: plan }, entries);
    expect(view.planQuestionByEntryId.get("e-q1")).toMatchObject({ orderIndex: 0 });
    expect(view.planQuestionByEntryId.get("e-q1-again")).toBeUndefined();
    expect(view.activeQuestion).toMatchObject({ planQuestion: { questionKey: "pricing-model", orderIndex: 1 } });
    expect(view.activeQuestion?.card.text).toBe("How do you price?");
    expect(view.entries).toHaveLength(3);
    expect(view.needsAssistantTurn).toBe(false);
  });

  it("pairs cards with plan rows positionally when two rows share a question key", () => {
    const plan = [
      makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 }),
      makeQuestion({ orderIndex: 1 }),
    ];
    const entries = [questionEntry(makeCard(), "e-q1"), questionEntry(makeCard(), "e-q2")];
    const view = deriveInterviewChatView({ status: "active", questions: plan }, entries);
    expect(view.planQuestionByEntryId.get("e-q1")).toMatchObject({ orderIndex: 0 });
    expect(view.planQuestionByEntryId.get("e-q2")).toMatchObject({ orderIndex: 1 });
    // The trailing card is answerable itself, so no recovery card is appended.
    expect(view.entries).toHaveLength(2);
    expect(view.activeQuestion).toMatchObject({ entryId: "e-q2", planQuestion: { orderIndex: 1 } });
  });

  it("asks for an assistant turn when a repeated card is the last one and every plan row is answered", () => {
    const plan = [makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 })];
    const entries = [questionEntry(makeCard(), "e-q1"), questionEntry(makeCard(), "e-q1-again")];
    const view = deriveInterviewChatView({ status: "active", questions: plan }, entries);
    expect(view.activeQuestion).toBeNull();
    expect(view.needsAssistantTurn).toBe(true);
  });
});

describe("baseStateFromGrowthInterview", () => {
  it("reconciles an adaptive question persisted during the turn with its streamed card", () => {
    const adaptiveQuestion = makeQuestion({
      questionKey: "rec_room_lever",
      orderIndex: 1,
      prompt: "Which recommendation-room lever matters most?",
      origin: "adaptive",
    });
    const adaptiveToolInput = {
      ...validToolInput,
      question_id: "adaptive-question-id",
      question_key: adaptiveQuestion.questionKey,
      text: adaptiveQuestion.prompt,
      options: adaptiveQuestion.options,
    };
    const interview: GrowthInterview = {
      status: "active",
      questions: [makeQuestion({ answerOptionIds: ["signups"], answeredAtMillis: 1 }), adaptiveQuestion],
      messages: [{
        id: "adaptive-turn",
        role: "assistant",
        parts: [
          {
            type: "tool-record-adaptive-question",
            toolCallId: "record-call",
            state: "output-available",
            input: { question_key: adaptiveQuestion.questionKey },
            output: { order_index: adaptiveQuestion.orderIndex },
          },
          {
            type: INTERVIEW_QUESTION_TOOL_PART_TYPE,
            toolCallId: "present-call",
            state: "output-available",
            input: adaptiveToolInput,
            output: { presented: true },
          },
        ],
      }],
    };

    const base = baseStateFromGrowthInterview(interview);
    expect(base.status).toBe("loaded");
    if (base.status !== "loaded") throw new Error("The interview has questions, so it must load.");
    const view = deriveInterviewChatView(
      { status: base.interviewStatus, questions: base.questions },
      base.loadedEntries,
    );
    expect(view.activeQuestion).toMatchObject({
      entryId: "adaptive-turn:1",
      planQuestion: { questionKey: "rec_room_lever", orderIndex: 1, origin: "adaptive" },
    });
    expect(view.needsAssistantTurn).toBe(false);
  });
});

describe("buildDemoTranscriptEntries", () => {
  it("synthesizes answered pairs plus the next presented card for the interview phase", () => {
    const interview = buildGrowthDemoInterview("interview", GROWTH_DEMO_NOW_MILLIS);
    const entries = buildDemoTranscriptEntries(interview);
    // intro + 3 answered (card + user answer) pairs + the 4th card, presented but unanswered.
    expect(entries).toHaveLength(1 + 3 * 2 + 1);
    expect(entries[0]).toMatchObject({ type: "text", role: "assistant" });
    expect(entries[1]).toMatchObject({ type: "question", card: { questionKey: "primary-goal" } });
    expect(entries[2]).toMatchObject({ type: "text", role: "user", text: "More signups" });
    expect(entries[entries.length - 1]).toMatchObject({ type: "question", card: { questionKey: "pricing-model" } });
    const view = deriveInterviewChatView(interview, entries);
    expect(view.activeQuestion?.planQuestion.orderIndex).toBe(3);
    expect(view.needsAssistantTurn).toBe(false);
  });

  it("ends a completed interview with an outro and the completion marker", () => {
    const interview = buildGrowthDemoInterview("steady-state", GROWTH_DEMO_NOW_MILLIS);
    const entries = buildDemoTranscriptEntries(interview);
    expect(entries[entries.length - 1]).toMatchObject({ type: "complete" });
    expect(deriveInterviewChatView(interview, entries).completed).toBe(true);
  });

  it("returns no entries when there is no question plan yet", () => {
    const interview = buildGrowthDemoInterview("analyzing", GROWTH_DEMO_NOW_MILLIS);
    expect(buildDemoTranscriptEntries(interview)).toEqual([]);
  });

  it("advances one question at a time when answers are applied locally (the demo answer flow)", () => {
    const interview = buildGrowthDemoInterview("interview", GROWTH_DEMO_NOW_MILLIS);
    const next = findNextUnansweredQuestion(interview.questions);
    expect(next).not.toBeNull();
    if (next == null) throw new Error("unreachable: asserted above");
    const questions = applyAnswerToQuestions(interview.questions, { orderIndex: next.orderIndex, optionIds: [next.options[0].id] }, GROWTH_DEMO_NOW_MILLIS);
    const entries = buildDemoTranscriptEntries({ status: "active", questions });
    // One more answered pair and the following card appear.
    expect(entries).toHaveLength(1 + 4 * 2 + 1);
    const view = deriveInterviewChatView({ status: "active", questions }, entries);
    expect(view.activeQuestion?.planQuestion.orderIndex).toBe(4);
  });
});

describe("questionCardFromPlanQuestion", () => {
  it("maps a plan row to a card and allows free text (plan rows do not carry that flag)", () => {
    const card = questionCardFromPlanQuestion(makeQuestion({ allowSkip: false }));
    expect(card).toEqual({
      questionKey: "primary-goal",
      text: "What is your primary growth goal?",
      kind: "single",
      options: makeQuestion().options,
      allowFreeText: true,
      allowSkip: false,
    });
  });
});

describe("planQuestionForEntry", () => {
  const answered = makeQuestion({ questionKey: "primary-goal", orderIndex: 0, answerOptionIds: ["signups"], answeredAtMillis: 1_000 });
  const next = makeQuestion({ questionKey: "biggest-blocker", orderIndex: 1, prompt: "What is blocking growth?" });
  const questions = [answered, next];
  const duplicateCard = makeCard({ questionKey: "primary-goal" });

  it("leaves a committed card the plan has no row left for unresolved", () => {
    // The agent re-presented an answered question, so the second card has no row of its own: showing
    // it the first row's answer would render a dead read-only duplicate of a question just answered.
    const entries: InterviewTranscriptEntry[] = [
      { id: "entry-1", type: "question", card: duplicateCard },
      { id: "entry-2", type: "question", card: duplicateCard },
    ];
    const view = deriveInterviewChatView({ status: "active", questions }, entries);

    expect(view.planQuestionByEntryId.get("entry-2")).toBeUndefined();
    const resolved = planQuestionForEntry({
      entryId: "entry-2",
      card: duplicateCard,
      streaming: false,
      activeQuestion: view.activeQuestion,
      planQuestionByEntryId: view.planQuestionByEntryId,
      questions,
    });
    expect(resolved).toBeNull();
    expect(planQuestionForEntry({
      entryId: "entry-1",
      card: duplicateCard,
      streaming: false,
      activeQuestion: view.activeQuestion,
      planQuestionByEntryId: view.planQuestionByEntryId,
      questions,
    })).toEqual(answered);
  });

  it("resolves a streaming card by key and the active card by the view's decision", () => {
    const streamingCard = makeCard({ questionKey: next.questionKey, text: next.prompt });

    expect(planQuestionForEntry({
      entryId: "streaming-1",
      card: streamingCard,
      streaming: true,
      activeQuestion: null,
      planQuestionByEntryId: new Map(),
      questions,
    })).toEqual(next);
    expect(planQuestionForEntry({
      entryId: "streaming-1",
      card: streamingCard,
      streaming: true,
      activeQuestion: { entryId: "streaming-1", card: streamingCard, planQuestion: next },
      planQuestionByEntryId: new Map(),
      questions,
    })).toEqual(next);
    // A key the plan never had cannot be answered, so it must not fall back to any other row.
    expect(planQuestionForEntry({
      entryId: "streaming-2",
      card: makeCard({ questionKey: "invented-by-the-agent" }),
      streaming: true,
      activeQuestion: null,
      planQuestionByEntryId: new Map(),
      questions,
    })).toBeNull();
  });
});
