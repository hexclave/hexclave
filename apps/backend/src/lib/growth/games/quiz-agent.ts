import { captureError } from "@hexclave/shared/dist/utils/errors";
import { postToEveForResult } from "../eve-dispatch";
import type { QuizFact, QuizFactOption } from "./quiz-facts";

/**
 * Asks the growth agent to write the prose for a round's questions.
 *
 * THE AGENT NEVER SUPPLIES A NUMBER. It receives, per fact, the metric's label, the catalog's
 * description of it, and the *shape* of the question — never the true value and never the options —
 * and returns only a question sentence and a one-line explanation. Everything the game scores was
 * already computed from real rows in quiz-facts.ts. If this contract ever loosened, the game could
 * assert a false fact about a customer's own product on the one surface whose whole premise is that
 * the numbers are trustworthy.
 *
 * Failure is not fatal. Every fact already carries deterministic `templateText`, so a failed or
 * malformed turn degrades the round's *wording* and nothing else; the caller records
 * `textSource: "template"` on the round so the degradation is recorded rather than hidden.
 */

/** Upper bound on one authoring turn. Kept under the route's maxDuration so a stall surfaces as a fallback, not a client abort. */
const QUIZ_AUTHORING_TIMEOUT_MS = 90 * 1000;

/** Guards against a runaway generation filling a card with an essay. Generous enough for a real question. */
const MAX_QUESTION_TEXT_LENGTH = 400;
const MAX_EXPLANATION_LENGTH = 600;

export type AuthoredQuizQuestion = {
  factId: string,
  text: string,
  explanation: string,
};

export type QuizAuthoringProduct = {
  websiteUrl: string | null,
  companySummary: string | null,
  additionalNotes: string | null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Narrows the agent's response to exactly one authored question per requested fact.
 *
 * Strict on purpose — partial coverage is rejected rather than merged with template text for the
 * missing entries. A round whose questions are half agent-written and half templated would record a
 * single `textSource` that is true of neither half, and the wording would visibly change voice
 * mid-round.
 */
export function parseQuizAuthoringResponse(response: unknown, facts: readonly QuizFact[]): Map<string, AuthoredQuizQuestion> | null {
  if (!isRecord(response) || !Array.isArray(response.questions)) return null;
  const expectedFactIds = new Set(facts.map((fact) => fact.factId));
  const authored = new Map<string, AuthoredQuizQuestion>();

  for (const entry of response.questions) {
    if (!isRecord(entry)) return null;
    const factId = readBoundedString(entry.fact_id, 200);
    if (factId == null || !expectedFactIds.has(factId) || authored.has(factId)) return null;
    const text = readBoundedString(entry.text, MAX_QUESTION_TEXT_LENGTH);
    const explanation = readBoundedString(entry.explanation, MAX_EXPLANATION_LENGTH);
    if (text == null || explanation == null) return null;
    authored.set(factId, { factId, text, explanation });
  }

  return authored.size === expectedFactIds.size ? authored : null;
}

/**
 * Detects an authored question that gives its own answer away.
 *
 * The agent is not sent the true value, so it cannot state it deliberately — but it is told what the
 * question is about, and a model that decides to be helpful ("Your signups grew 34% — by how much
 * did they grow?") would hand the player the answer. Any number in the question text that matches an
 * option's digits is treated as a leak and drops the whole round to template wording.
 *
 * Takes just the options rather than a whole QuizFact because staff edits run through it too (see
 * updateQuizQuestion in quiz-games.ts), and a stored question row is not a fact — a reviewer can
 * paste the answer into the prompt more easily than a model can, since they can see it.
 */
export function authoredQuestionLeaksAnswer(text: string, fact: { readonly options: readonly QuizFactOption[] }): boolean {
  const digitsIn = (value: string): string[] => (value.match(/\d[\d,.]*/g) ?? []).map((match) => match.replace(/[,.]/g, "").replace(/0+$/, ""));
  const questionNumbers = new Set(digitsIn(text).filter((digits) => digits.length > 0));
  if (questionNumbers.size === 0) return false;
  // Compared against every option, not just the correct one: naming a distractor is just as much of
  // a giveaway, because it collapses the choice from four options to three.
  return fact.options.some((option) => digitsIn(option.label).some((digits) => digits.length > 0 && questionNumbers.has(digits)));
}

/**
 * Returns authored prose for every fact, or null when the round should fall back to template text.
 * Never throws: a game that 500s because the copywriter was slow is worse than a game with plainer
 * wording.
 */
export async function authorQuizQuestions(input: {
  projectId: string,
  branchId: string,
  roundId: string,
  facts: readonly QuizFact[],
  product: QuizAuthoringProduct,
}): Promise<Map<string, AuthoredQuizQuestion> | null> {
  try {
    const response = await postToEveForResult("/quiz", {
      project_id: input.projectId,
      branch_id: input.branchId,
      round_id: input.roundId,
      product: {
        website_url: input.product.websiteUrl,
        company_summary: input.product.companySummary,
        additional_notes: input.product.additionalNotes,
      },
      facts: input.facts.map((fact) => ({
        fact_id: fact.factId,
        // Label + description + kind only. No true value, no options — see the file header.
        metric_label: fact.metricLabel,
        metric_description: fact.metricDescription,
        kind: fact.kind,
        unit: fact.unit,
        default_text: fact.templateText,
      })),
    }, { timeoutMs: QUIZ_AUTHORING_TIMEOUT_MS });

    const authored = parseQuizAuthoringResponse(response, input.facts);
    if (authored == null) {
      captureError("growth-quiz-authoring-malformed", new Error(`Quiz authoring returned a response that did not cover every fact: round=${input.roundId}`));
      return null;
    }

    for (const fact of input.facts) {
      const question = authored.get(fact.factId);
      if (question != null && authoredQuestionLeaksAnswer(question.text, fact)) {
        captureError("growth-quiz-authoring-leak", new Error(`Quiz authoring wrote a question containing one of its own options: round=${input.roundId} fact=${fact.factId}`));
        return null;
      }
    }

    return authored;
  } catch (error) {
    // Deliberate catch at the integration boundary, and the only one in this file: every failure
    // mode of a separate HTTP service (timeout, non-2xx, unparseable body) has the same correct
    // response here — log it and let the round play with template wording.
    captureError("growth-quiz-authoring-failed", error);
    return null;
  }
}
