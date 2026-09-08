"use client";

import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessageChunk } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { getGrowthInterview, GrowthApiError, retakeGrowthInterview, skipGrowthInterview } from "./growth-api";
import { buildGrowthDemoInterview, GROWTH_DEMO_NOW_MILLIS } from "./growth-demo-data";
import type { GrowthPhase } from "./growth-status";
import {
  GROWTH_INTERVIEW_QUESTION_KINDS,
  type GrowthInterview,
  type GrowthInterviewQuestion,
  type GrowthInterviewQuestionKind,
  type GrowthInterviewQuestionOption,
  type GrowthInterviewStatus,
} from "./growth-types";

/**
 * Client-side logic for the growth interview chat page. Everything nontrivial lives here as pure,
 * unit-tested helpers (transcript derivation, view-state derivation, answer application); the React
 * hook at the bottom only wires those helpers to fetch/stream/state so the page components stay
 * declarative.
 *
 * The transcript is a list of AI SDK UIMessages (kept opaque in GrowthInterview.messages — see
 * growth-types.ts). This module narrows each message just far enough to render it: text parts, the
 * `present-interview-question` tool part (whose input is the structured question card), and the
 * `complete-interview` tool part (which ends the interview). Everything else — reasoning, step
 * markers, unknown tools — is intentionally ignored rather than treated as malformed, so the agent
 * can grow new part types without breaking old dashboards.
 */

// Tool names are part of the Eve interview agent's contract (see the backend's lib/growth/interview.ts
// and the growth-engine e2e tests, which pin `present-interview-question` on the wire).
export const INTERVIEW_QUESTION_TOOL_PART_TYPE = "tool-present-interview-question";
export const INTERVIEW_COMPLETE_TOOL_PART_TYPE = "tool-complete-interview";

// -------------------------------------------------- view models --------------------------------------------------

/**
 * The renderable question card, as carried by the `present-interview-question` tool input. Note that
 * this is NOT the same shape as the question plan rows from GET /interview: the tool input uses
 * `text`/`allow_free_text` and is the only place free-text permission is expressed.
 */
export type InterviewQuestionCard = {
  questionKey: string,
  text: string,
  kind: GrowthInterviewQuestionKind,
  options: GrowthInterviewQuestionOption[],
  allowFreeText: boolean,
  allowSkip: boolean,
};

export type InterviewTranscriptEntry =
  | { type: "text", id: string, role: "user" | "assistant", text: string }
  | { type: "question", id: string, card: InterviewQuestionCard }
  | { type: "complete", id: string };

/** The already-given answer of a plan question, resolved to display form (option labels, not ids). */
export type InterviewPlanAnswer = {
  skipped: boolean,
  optionLabels: string[],
  freeText: string | null,
};

export type InterviewAnswerInput = {
  orderIndex: number,
  optionIds?: string[],
  freeText?: string,
  skipped?: true,
};

export type InterviewChatView = {
  entries: InterviewTranscriptEntry[],
  /**
   * The single interactive question: the transcript's last question card, provided its plan row is
   * still unanswered. All earlier cards render read-only with the recorded answer.
   */
  activeQuestion: { entryId: string, card: InterviewQuestionCard, planQuestion: GrowthInterviewQuestion } | null,
  /**
   * The plan row each question card's answer belongs on, keyed by entry id. Cards cannot be resolved
   * by question key alone — see resolveTranscriptPlanQuestions.
   */
  planQuestionByEntryId: Map<string, GrowthInterviewQuestion>,
  /**
   * True when the interview is open but no unanswered card is on screen — either the customer never
   * started (empty transcript) or a previous turn's answer persisted but its stream dropped before
   * the assistant replied. Both are fixed the same way: request an assistant turn without an answer.
   */
  needsAssistantTurn: boolean,
  completed: boolean,
};

// -------------------------------------------------- pure helpers --------------------------------------------------

const questionToolInputSchema = z.object({
  question_key: z.string(),
  text: z.string(),
  kind: z.enum(GROWTH_INTERVIEW_QUESTION_KINDS),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullish(),
  })),
  allow_free_text: z.boolean(),
  allow_skip: z.boolean(),
}).passthrough();

/** Narrows a `present-interview-question` tool input to a renderable card; null if malformed. */
export function parseInterviewQuestionToolInput(input: unknown): InterviewQuestionCard | null {
  const parsed = questionToolInputSchema.safeParse(input);
  if (!parsed.success) return null;
  return {
    questionKey: parsed.data.question_key,
    text: parsed.data.text,
    kind: parsed.data.kind,
    options: parsed.data.options.map((option) => ({ id: option.id, label: option.label, description: option.description ?? null })),
    allowFreeText: parsed.data.allow_free_text,
    allowSkip: parsed.data.allow_skip,
  };
}

const uiMessageLikeSchema = z.object({
  id: z.string().optional(),
  role: z.string(),
  parts: z.array(z.unknown()),
}).passthrough();

const partTypeSchema = z.object({ type: z.string() }).passthrough();
const textPartSchema = z.object({ text: z.string() }).passthrough();
const toolInputPartSchema = z.object({ input: z.unknown() }).passthrough();

/**
 * Converts one opaque UIMessage into transcript entries. Renderable-but-broken content (a question
 * tool part with a malformed input, a text part without text) is returned in `malformed` so the
 * caller can report it loudly; genuinely unknown part types are skipped silently by design (see the
 * module comment).
 */
export function uiMessageToTranscriptEntries(message: unknown, fallbackMessageId: string): { entries: InterviewTranscriptEntry[], malformed: unknown[] } {
  const parsed = uiMessageLikeSchema.safeParse(message);
  if (!parsed.success) return { entries: [], malformed: [message] };
  const role = parsed.data.role;
  if (role !== "user" && role !== "assistant") return { entries: [], malformed: [message] };
  const messageId = parsed.data.id ?? fallbackMessageId;
  const entries: InterviewTranscriptEntry[] = [];
  const malformed: unknown[] = [];
  parsed.data.parts.forEach((part, index) => {
    const entryId = `${messageId}:${index}`;
    const typed = partTypeSchema.safeParse(part);
    if (!typed.success) {
      malformed.push(part);
      return;
    }
    if (typed.data.type === "text") {
      const textPart = textPartSchema.safeParse(part);
      if (!textPart.success) {
        malformed.push(part);
        return;
      }
      if (textPart.data.text.length > 0) entries.push({ type: "text", id: entryId, role, text: textPart.data.text });
      return;
    }
    if (typed.data.type === INTERVIEW_QUESTION_TOOL_PART_TYPE) {
      const inputPart = toolInputPartSchema.safeParse(part);
      const card = inputPart.success ? parseInterviewQuestionToolInput(inputPart.data.input) : null;
      if (card == null) {
        malformed.push(part);
        return;
      }
      entries.push({ type: "question", id: entryId, card });
      return;
    }
    if (typed.data.type === INTERVIEW_COMPLETE_TOOL_PART_TYPE) {
      entries.push({ type: "complete", id: entryId });
      return;
    }
    // Unknown part type (reasoning, step markers, future tools): not renderable here, not an error.
  });
  return { entries, malformed };
}

export function findNextUnansweredQuestion(questions: GrowthInterviewQuestion[]): GrowthInterviewQuestion | null {
  let next: GrowthInterviewQuestion | null = null;
  for (const question of questions) {
    if (question.answeredAtMillis != null) continue;
    if (next == null || question.orderIndex < next.orderIndex) next = question;
  }
  return next;
}

export function countAnsweredQuestions(questions: GrowthInterviewQuestion[]): number {
  return questions.filter((question) => question.answeredAtMillis != null).length;
}

/** Resolves a plan question's recorded answer to display form; null while unanswered. */
export function getPlanAnswer(question: GrowthInterviewQuestion): InterviewPlanAnswer | null {
  if (question.answeredAtMillis == null) return null;
  const optionIds = question.answerOptionIds ?? [];
  const freeText = question.answerFreeText != null && question.answerFreeText.length > 0 ? question.answerFreeText : null;
  // An answered question with neither options nor free text is a per-question skip (the backend
  // clears both when persisting skipped: true).
  if (optionIds.length === 0 && freeText == null) return { skipped: true, optionLabels: [], freeText: null };
  const optionLabels = optionIds.map((optionId) => question.options.find((option) => option.id === optionId)?.label ?? optionId);
  return { skipped: false, optionLabels, freeText };
}

/**
 * Mirrors the backend's buildAnswerUserMessage so the locally-appended user bubble matches what the
 * server persisted into the transcript (option labels, then free text; "(skipped this question)"
 * for skips).
 */
export function buildAnswerTranscriptText(question: GrowthInterviewQuestion, answer: InterviewAnswerInput): string {
  if (answer.skipped === true) return "(skipped this question)";
  const optionLabels = (answer.optionIds ?? []).map((optionId) => question.options.find((option) => option.id === optionId)?.label ?? optionId);
  const freeText = answer.freeText != null && answer.freeText.length > 0 ? [answer.freeText] : [];
  return [...optionLabels, ...freeText].join("\n");
}

/**
 * Applies one just-submitted answer onto the local question plan, mirroring what the backend
 * persisted before it streamed the assistant's reply — this keeps the plan in sync without a
 * refetch after every turn.
 */
export function applyAnswerToQuestions(questions: GrowthInterviewQuestion[], answer: InterviewAnswerInput, answeredAtMillis: number): GrowthInterviewQuestion[] {
  const target = questions.find((question) => question.orderIndex === answer.orderIndex)
    ?? throwErr(`Cannot apply an answer to order_index ${answer.orderIndex}: no such question in the plan. Answers are always submitted from a card resolved against this plan.`);
  return questions.map((question) => question !== target ? question : {
    ...question,
    answerOptionIds: answer.skipped === true || answer.optionIds == null || answer.optionIds.length === 0 ? null : answer.optionIds,
    answerFreeText: answer.skipped === true || answer.freeText == null || answer.freeText.length === 0 ? null : answer.freeText,
    answeredAtMillis,
  });
}

/**
 * Maps every question card in the transcript to the plan row its answer belongs on.
 *
 * A card carries only a question key, and a key does NOT identify a plan row: the agent picks the
 * key for an adaptive follow-up (`record-adaptive-question`), so it can reuse the key of a question
 * that was already asked and answered. Resolving by key alone then hands the trailing card the
 * earlier, already-answered row, which makes the card render as a dead read-only duplicate — the
 * customer sees the same question twice with the options disabled and no way to answer it.
 *
 * Cards and rows therefore pair up positionally per key, in transcript order: the n-th card with
 * key K answers the n-th plan row with key K (rows in plan order). Extra cards beyond the rows that
 * share their key resolve to nothing, which is the honest answer — there is no row to write to.
 */
export function resolveTranscriptPlanQuestions(
  questions: GrowthInterviewQuestion[],
  entries: InterviewTranscriptEntry[],
): Map<string, GrowthInterviewQuestion> {
  const remainingByKey = new Map<string, GrowthInterviewQuestion[]>();
  for (const question of [...questions].sort((a, b) => a.orderIndex - b.orderIndex)) {
    const bucket = remainingByKey.get(question.questionKey) ?? [];
    bucket.push(question);
    remainingByKey.set(question.questionKey, bucket);
  }
  const resolved = new Map<string, GrowthInterviewQuestion>();
  for (const entry of entries) {
    if (entry.type !== "question") continue;
    const planQuestion = remainingByKey.get(entry.card.questionKey)?.shift();
    if (planQuestion != null) resolved.set(entry.id, planQuestion);
  }
  return resolved;
}

/**
 * The plan row a rendered card takes its answer and state from.
 *
 * Committed cards go through the positional mapping only: a card the plan has no row left for
 * (see resolveTranscriptPlanQuestions) resolves to nothing rather than borrowing another row's
 * answer, which would show the customer an answer they never gave. Cards of a turn that is still
 * streaming are not in that mapping yet and have no recorded answer to show either way, so there
 * the key is all there is to go on.
 */
export function planQuestionForEntry(args: {
  entryId: string,
  card: InterviewQuestionCard,
  /** True for entries of the in-flight turn, which the committed mapping does not cover yet. */
  streaming: boolean,
  activeQuestion: InterviewChatView["activeQuestion"],
  planQuestionByEntryId: Map<string, GrowthInterviewQuestion>,
  questions: GrowthInterviewQuestion[],
}): GrowthInterviewQuestion | null {
  if (args.activeQuestion != null && args.activeQuestion.entryId === args.entryId) return args.activeQuestion.planQuestion;
  if (args.streaming) return args.questions.find((question) => question.questionKey === args.card.questionKey) ?? null;
  return args.planQuestionByEntryId.get(args.entryId) ?? null;
}

/** Synthetic entry id for the recovery card described in deriveInterviewChatView. */
export function planFallbackEntryId(question: GrowthInterviewQuestion): string {
  return `plan-fallback:${question.orderIndex}:${question.questionKey}`;
}

/** Derives the whole chat view (interactive card, continue affordance, completion) from status + plan + transcript. */
export function deriveInterviewChatView(
  interview: { status: GrowthInterviewStatus, questions: GrowthInterviewQuestion[] },
  entries: InterviewTranscriptEntry[],
): InterviewChatView {
  const completed = interview.status === "completed" || interview.status === "skipped" || entries.some((entry) => entry.type === "complete");
  const planQuestionByEntryId = resolveTranscriptPlanQuestions(interview.questions, entries);
  let viewEntries = entries;
  let activeQuestion: InterviewChatView["activeQuestion"] = null;
  if (!completed) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "question") continue;
      const planQuestion = planQuestionByEntryId.get(entry.id);
      // A card whose key is missing from the plan cannot be answered (the answer endpoint is keyed
      // by the plan's order_index) — fall through to the recovery card below instead of rendering a
      // dead interactive card. The hook reports this loudly when it happens.
      if (planQuestion != null && planQuestion.answeredAtMillis == null) {
        activeQuestion = { entryId: entry.id, card: entry.card, planQuestion };
      }
      break;
    }
  }
  // Recovery card: the interview is underway, the trailing card cannot be answered (it repeats an
  // answered question, or its key is not in the plan at all) and yet the plan still has unanswered
  // rows. Without this the customer is stranded — every card on screen is read-only and the only
  // affordance left is "Continue the interview", which asks the agent for another turn that can
  // repeat the same mistake. Appending the next unanswered plan question as a bare card keeps the
  // interview answerable without waiting on the agent. The opening turn is deliberately excluded
  // (no question card yet): there the assistant's introduction is the point.
  if (!completed && activeQuestion == null && entries.some((entry) => entry.type === "question")) {
    const next = findNextUnansweredQuestion(interview.questions);
    if (next != null) {
      const entryId = planFallbackEntryId(next);
      const card = questionCardFromPlanQuestion(next);
      viewEntries = [...entries, { type: "question", id: entryId, card }];
      planQuestionByEntryId.set(entryId, next);
      activeQuestion = { entryId, card, planQuestion: next };
    }
  }
  return {
    entries: viewEntries,
    activeQuestion,
    planQuestionByEntryId,
    needsAssistantTurn: !completed && activeQuestion == null,
    completed,
  };
}

/**
 * Builds a card straight from a plan row, used where no agent-authored card exists: the demo
 * transcript and the recovery card in deriveInterviewChatView. Plan rows don't carry
 * allow_free_text (only the agent's tool input does), and free text is the permissive choice — a
 * founder with something to say must not be blocked by a card we synthesized ourselves.
 */
export function questionCardFromPlanQuestion(question: GrowthInterviewQuestion): InterviewQuestionCard {
  return {
    questionKey: question.questionKey,
    text: question.prompt,
    kind: question.kind,
    options: question.options,
    allowFreeText: true,
    allowSkip: question.allowSkip,
  };
}

/**
 * Demo mode has no stored transcript (the fixtures keep messages empty — see growth-demo-data.ts),
 * so the chat is synthesized from the question plan instead: every answered question becomes a
 * card + user-answer pair, the next unanswered question becomes the presented card, and a completed
 * interview ends with the completion marker. Re-derived from the plan on every change, which is what
 * makes the demo's purely-local answer flow work.
 */
export function buildDemoTranscriptEntries(interview: { status: GrowthInterviewStatus, questions: GrowthInterviewQuestion[] }): InterviewTranscriptEntry[] {
  const sorted = [...interview.questions].sort((a, b) => a.orderIndex - b.orderIndex);
  if (sorted.length === 0) return [];
  const entries: InterviewTranscriptEntry[] = [
    { type: "text", id: "demo:intro", role: "assistant", text: "Thanks for the access! I've gone through your website and your data — a few quick questions so the report fits your business." },
  ];
  for (const question of sorted) {
    const answer = getPlanAnswer(question);
    entries.push({ type: "question", id: `demo:question:${question.questionKey}`, card: questionCardFromPlanQuestion(question) });
    if (answer == null) return entries;
    const answerText = answer.skipped ? "(skipped this question)" : [...answer.optionLabels, ...answer.freeText == null ? [] : [answer.freeText]].join("\n");
    entries.push({ type: "text", id: `demo:answer:${question.questionKey}`, role: "user", text: answerText });
  }
  if (interview.status === "completed") {
    entries.push({ type: "text", id: "demo:outro", role: "assistant", text: "That's everything I needed — I'm composing your growth report now. It will appear on the overview shortly." });
    entries.push({ type: "complete", id: "demo:complete" });
  }
  return entries;
}

// -------------------------------------------------- the hook --------------------------------------------------

export type GrowthInterviewBaseState =
  | { status: "loading" }
  | { status: "error", message: string }
  /** The analysis hasn't produced a question plan yet (404, or a pending interview without questions). */
  | { status: "not-ready" }
  | {
    status: "loaded",
    interviewStatus: GrowthInterviewStatus,
    questions: GrowthInterviewQuestion[],
    /** Entries parsed from the persisted transcript at load time. */
    loadedEntries: InterviewTranscriptEntry[],
    /** Entries committed by turns completed in this session (user answers + assistant replies). */
    localEntries: InterviewTranscriptEntry[],
  };

export type GrowthInterviewTurnState =
  | { status: "idle" }
  | { status: "streaming", entries: InterviewTranscriptEntry[] }
  | { status: "error", message: string };

export type UseGrowthInterviewChatResult = {
  base: GrowthInterviewBaseState,
  /** Non-null exactly when base is loaded. */
  view: InterviewChatView | null,
  turn: GrowthInterviewTurnState,
  sendAnswer: (answer: InterviewAnswerInput) => Promise<void>,
  requestAssistantTurn: () => Promise<void>,
  skipAll: () => Promise<void>,
  /** Discards the plan and transcript and re-runs question generation; research findings are kept. */
  retake: () => Promise<void>,
  reload: () => Promise<void>,
  demo: boolean,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractStreamErrorMessage(statusCode: number, bodyText: string): string {
  let message = `Growth request failed with status ${statusCode}`;
  try {
    const body = z.object({ error: z.string().optional() }).passthrough().parse(JSON.parse(bodyText));
    message = body.error ?? message;
  } catch {
    // Same policy as growth-api's requestJson: a non-JSON proxy response has no safe message.
  }
  return message;
}

function parseLoadedTranscript(messages: unknown[]): InterviewTranscriptEntry[] {
  const entries: InterviewTranscriptEntry[] = [];
  const malformed: unknown[] = [];
  messages.forEach((message, index) => {
    const result = uiMessageToTranscriptEntries(message, `loaded:${index}`);
    entries.push(...result.entries);
    malformed.push(...result.malformed);
  });
  if (malformed.length > 0) {
    captureError("growth-interview-transcript-parse", { message: "Stored growth interview transcript contained unrenderable parts", malformed });
  }
  return entries;
}

/**
 * Builds the authoritative client state from GET /interview. This is shared by the initial load and
 * the post-turn reconciliation: an interview turn may append an adaptive question while it runs,
 * so applying only the submitted answer to the old in-memory plan would leave the streamed card
 * without its newly-persisted plan row until the founder manually reloaded the page.
 */
export function baseStateFromGrowthInterview(interview: GrowthInterview): GrowthInterviewBaseState {
  if (interview.questions.length === 0 && (interview.status === "pending" || interview.status === "active")) {
    return { status: "not-ready" };
  }
  return {
    status: "loaded",
    interviewStatus: interview.status,
    questions: interview.questions,
    loadedEntries: parseLoadedTranscript(interview.messages),
    localEntries: [],
  };
}

/**
 * Loads and drives the interview chat. `app` must be the project's own admin app (same authorization
 * story as growth-api.ts). In demo mode nothing ever touches the network: the plan comes from the
 * phase fixture and answering advances a purely-local simulation (see buildDemoTranscriptEntries).
 */
export function useGrowthInterviewChat(options: { app: object, demo: boolean, demoPhase: GrowthPhase }): UseGrowthInterviewChatResult {
  const { app, demo, demoPhase } = options;
  const [base, setBase] = useState<GrowthInterviewBaseState>({ status: "loading" });
  const [turn, setTurn] = useState<GrowthInterviewTurnState>({ status: "idle" });
  // Refs mirror the latest state for the async turn machinery; a nonce invalidates in-flight turns
  // when the interview is reloaded (or the demo target changes) underneath them.
  const baseRef = useRef(base);
  baseRef.current = base;
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const loadNonceRef = useRef(0);

  const load = useCallback(async () => {
    loadNonceRef.current++;
    const nonce = loadNonceRef.current;
    setTurn({ status: "idle" });
    if (demo) {
      const fixture = buildGrowthDemoInterview(demoPhase, GROWTH_DEMO_NOW_MILLIS);
      setBase(fixture.questions.length === 0
        ? { status: "not-ready" }
        : { status: "loaded", interviewStatus: fixture.status, questions: fixture.questions, loadedEntries: [], localEntries: [] });
      return;
    }
    setBase({ status: "loading" });
    try {
      const interview = await getGrowthInterview(app);
      if (loadNonceRef.current !== nonce) return;
      setBase(baseStateFromGrowthInterview(interview));
    } catch (error) {
      if (loadNonceRef.current !== nonce) return;
      if (error instanceof GrowthApiError && error.statusCode === 404) {
        // "No interview exists yet" — the analysis is still preparing questions.
        setBase({ status: "not-ready" });
        return;
      }
      captureError("growth-interview-load", error);
      setBase({ status: "error", message: errorMessage(error) });
    }
  }, [app, demo, demoPhase]);

  useEffect(() => {
    runAsynchronously(load());
  }, [load]);

  const sendTurn = useCallback(async (answer: InterviewAnswerInput | undefined) => {
    const current = baseRef.current;
    if (current.status !== "loaded") {
      throw new Error("A growth interview turn was requested before the interview loaded — turn actions are only rendered in the loaded state.");
    }
    if (turnRef.current.status === "streaming") return;

    if (demo) {
      // Purely-local simulation: apply the answer to the plan and let buildDemoTranscriptEntries
      // re-derive the chat (which presents the next question, or completes the interview).
      if (answer == null) return;
      const questions = applyAnswerToQuestions(current.questions, answer, GROWTH_DEMO_NOW_MILLIS);
      const interviewStatus = findNextUnansweredQuestion(questions) == null ? "completed" : "active";
      setBase({ ...current, questions, interviewStatus });
      return;
    }

    const nonce = loadNonceRef.current;
    const userEntry: InterviewTranscriptEntry | null = answer == null ? null : {
      type: "text",
      id: `local-answer:${answer.orderIndex}:${Date.now()}`,
      role: "user",
      text: buildAnswerTranscriptText(
        current.questions.find((question) => question.orderIndex === answer.orderIndex)
          ?? throwErr(`Submitted an answer for order_index ${answer.orderIndex}, which is not in the loaded plan. The interactive card is always resolved against this plan.`),
        answer,
      ),
    };
    setTurn({ status: "streaming", entries: userEntry == null ? [] : [userEntry] });
    try {
      const response = await sendInternalAdminRequest(app, "/internal/growth/interview/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(answer == null ? {} : {
          answer: {
            order_index: answer.orderIndex,
            ...answer.skipped === true ? { skipped: true } : {},
            ...answer.optionIds != null && answer.optionIds.length > 0 ? { option_ids: answer.optionIds } : {},
            ...answer.freeText != null && answer.freeText.length > 0 ? { free_text: answer.freeText } : {},
          },
        }),
      });
      if (!response.ok) {
        throw new GrowthApiError(response.status, extractStreamErrorMessage(response.status, await response.text()));
      }
      if (response.body == null) {
        throw new Error("The interview stream response carried no body.");
      }
      // Same parse pipeline as chat-stream.ts's sendAiStreamRequest (which is hard-wired to the
      // unified ai/query route): SSE of JSON events, validated by the AI SDK's own chunk schema.
      const chunkStream = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(
        new TransformStream<
          { success: true, value: UIMessageChunk, rawValue: unknown } | { success: false, error: unknown, rawValue: unknown },
          UIMessageChunk
        >({
          transform(parseResult, controller) {
            if (parseResult.success) {
              controller.enqueue(parseResult.value);
            } else {
              captureError("growth-interview-stream-parse", { error: parseResult.error, rawValue: parseResult.rawValue });
            }
          },
        }),
      );
      let assistantEntries: InterviewTranscriptEntry[] = [];
      let malformed: unknown[] = [];
      for await (const uiMessage of readUIMessageStream({ stream: chunkStream })) {
        if (loadNonceRef.current !== nonce) return;
        const result = uiMessageToTranscriptEntries(uiMessage, `turn:${nonce}`);
        assistantEntries = result.entries;
        malformed = result.malformed;
        setTurn({ status: "streaming", entries: [...userEntry == null ? [] : [userEntry], ...assistantEntries] });
      }
      if (malformed.length > 0) {
        captureError("growth-interview-turn-parse", { message: "Streamed growth interview turn contained unrenderable parts", malformed });
      }
      if (loadNonceRef.current !== nonce) return;
      // The agent may have persisted an adaptive question during this turn. Reconcile the plan and
      // transcript together from the backend before committing the streamed card; otherwise the
      // card arrives in localEntries while its answerable plan row is absent from `questions`.
      const refreshedInterview = await getGrowthInterview(app);
      if (loadNonceRef.current !== nonce) return;
      setBase(baseStateFromGrowthInterview(refreshedInterview));
      setTurn({ status: "idle" });
    } catch (error) {
      if (loadNonceRef.current !== nonce) return;
      captureError("growth-interview-turn", error);
      setTurn({ status: "error", message: errorMessage(error) });
    }
  }, [app, demo]);

  const skipAll = useCallback(async () => {
    if (demo) {
      setBase((previous) => previous.status === "loaded" ? { ...previous, interviewStatus: "skipped" } : previous);
      return;
    }
    await skipGrowthInterview(app);
    await load();
  }, [app, demo, load]);

  const retake = useCallback(async () => {
    if (demo) {
      // Demo answers live only in local state, so "retake" is just clearing them.
      setBase((previous) => previous.status === "loaded"
        ? { ...previous, interviewStatus: "pending", loadedEntries: [], localEntries: [] }
        : previous);
      return;
    }
    await retakeGrowthInterview(app);
    // The reload will show an empty plan: the agent regenerates the questions asynchronously, so the
    // page lands on the not-ready panel until the new plan is saved. That is the honest state — the
    // alternative (optimistically keeping the stale questions) would show questions we just deleted.
    await load();
  }, [app, demo, load]);

  const view = useMemo(() => {
    if (base.status !== "loaded") return null;
    const interview = { status: base.interviewStatus, questions: base.questions };
    const entries = demo
      ? buildDemoTranscriptEntries(interview)
      : [...base.loadedEntries, ...base.localEntries];
    const derived = deriveInterviewChatView(interview, entries);
    if (!demo && !derived.completed) {
      // The trailing card being unanswerable means the agent presented a question that has no
      // unanswered plan row — either it repeated one already answered, or it presented a key that
      // was never persisted. The view recovers (recovery card / continue affordance), but the agent
      // behaviour behind it is a defect we want to see.
      const lastCard = [...entries].reverse().find((entry) => entry.type === "question");
      if (lastCard != null && derived.activeQuestion?.entryId !== lastCard.id) {
        captureError("growth-interview-unanswerable-question", {
          message: "The transcript's last question card has no unanswered plan row to answer",
          questionKey: lastCard.card.questionKey,
          inPlan: base.questions.some((question) => question.questionKey === lastCard.card.questionKey),
        });
      }
    }
    return derived;
  }, [base, demo]);

  return {
    base,
    view,
    turn,
    sendAnswer: useCallback(async (answer: InterviewAnswerInput) => await sendTurn(answer), [sendTurn]),
    requestAssistantTurn: useCallback(async () => await sendTurn(undefined), [sendTurn]),
    skipAll,
    retake,
    reload: load,
    demo,
  };
}
