import type { ChannelFrom } from "eve/channels";
import { buildGrowthSessionAuth } from "#lib/run-context.ts";
import { followSessionEvents } from "#lib/session-stream.ts";
import { PLAIN_LANGUAGE_RULE } from "#lib/writing-style.ts";

export type QuizAuthoringRequest = {
  readonly project_id: string,
  readonly branch_id: string,
  readonly round_id: string,
  readonly product: {
    readonly website_url: string | null,
    readonly company_summary: string | null,
    readonly additional_notes: string | null,
  },
  readonly facts: readonly {
    readonly fact_id: string,
    readonly metric_label: string,
    readonly metric_description: string,
    readonly kind: string,
    readonly unit: string,
    /** The backend's own wording. A usable question already — improve on it or return it as-is. */
    readonly default_text: string,
  }[],
};

export type QuizAuthoringResult = {
  readonly questions: readonly {
    readonly fact_id: string,
    readonly text: string,
    readonly explanation: string,
  }[],
};

/**
 * Upper bound on one authoring turn. Below the backend's own Eve timeout so a stuck session surfaces
 * as this module's error (which the route maps to a 500, which the backend maps to template
 * wording) rather than as an opaque abort.
 */
const MAX_QUIZ_AUTHORING_MS = 75 * 1000;

/** What each question kind is asking about, so the wording matches the shape of the answer. */
const KIND_GUIDANCE = new Map<string, string>([
  ["latest_value", "asks for the metric's current total."],
  ["window_sum", "asks what the metric added up to across a recent window of days."],
  ["window_change_pct", "asks which direction the metric moved recently, and by how much, as a percentage."],
  ["peak_weekday", "asks which day of the week the metric peaks on, on average. The options are weekday names."],
  ["rank_among", "asks which of several named metrics was the largest. The options are metric names, not numbers."],
  ["ratio", "asks for the metric's recent average, as a percentage."],
]);

function buildQuizPrompt(input: QuizAuthoringRequest): string {
  const factLines = input.facts.map((fact, index) => [
    `${index + 1}. fact_id: ${fact.fact_id}`,
    `   metric: ${fact.metric_label}`,
    `   what it measures: ${fact.metric_description}`,
    `   question shape: ${KIND_GUIDANCE.get(fact.kind) ?? `"${fact.kind}" — follow the default wording closely.`}`,
    `   default wording: ${fact.default_text}`,
  ].join("\n")).join("\n\n");

  return [
    `You are the game master of a short quiz that asks a founder how well they know their own product's numbers. Rewrite the ${input.facts.length} questions below so they sound like a person hosting a game, not a database.`,
    "",
    input.product.company_summary != null
      ? `The product: ${input.product.company_summary}${input.product.website_url != null ? ` (${input.product.website_url})` : ""}`
      : "The product summary was not recorded; keep the wording generic rather than guessing what they build.",
    input.product.additional_notes != null ? `Additional context from the team: ${input.product.additional_notes}` : "",
    "",
    "Questions to write:",
    "",
    factLines,
    "",
    "Rules:",
    "- Output ONLY a JSON array, nothing else. No prose before or after, no markdown code fence.",
    '- Each element is exactly {"fact_id": "...", "text": "...", "explanation": "..."}.',
    "- Return one element for EVERY fact_id above, using the fact_id string verbatim. A missing or invented fact_id makes the whole response unusable.",
    // The single most important line in this prompt. The session is not given the values, so this is
    // about not guessing one out loud — a question that names a plausible figure is as damaging as
    // one that names the real one, because it anchors the player.
    "- NEVER state, guess, hint at, or bracket a numeric answer in `text`. You have not been told any of these values and must not invent one. No example figures, no ranges, no \"(around 500?)\". A question containing a number is thrown away.",
    "- `text` is the question itself: one sentence, second person, curious and a little challenging. It must be answerable by picking one of four options the player will see, so do not ask for anything the options could not express.",
    "- `explanation` is one sentence on why this metric is worth knowing — what a founder would actually do differently depending on the answer. It is shown only after they have answered.",
    `- ${PLAIN_LANGUAGE_RULE}`,
    "- Keep the game-show energy in the phrasing, not in punctuation. No exclamation marks, no emoji, no \"Let's see if...\" preamble.",
    "- Do not call any tools. Produce the JSON in your reply.",
  ].join("\n");
}

/**
 * Pulls the JSON array out of a model reply that may have wrapped it in a code fence or a stray
 * sentence. Returns null when nothing array-shaped is present; the backend then uses its own
 * template wording, so being strict here costs nothing but a plainer round.
 */
function extractJsonArray(reply: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const candidate = fenced != null ? fenced[1] : reply;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // A model that emitted almost-JSON is indistinguishable here from one that emitted prose, and
    // both have the same handling: report nothing usable and let the backend template the round.
    return null;
  }
}

function toAuthoredQuestions(entries: readonly unknown[]): QuizAuthoringResult["questions"] {
  const questions: { fact_id: string, text: string, explanation: string }[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.fact_id !== "string" || typeof record.text !== "string" || typeof record.explanation !== "string") continue;
    questions.push({ fact_id: record.fact_id, text: record.text.trim(), explanation: record.explanation.trim() });
  }
  // Not validated for completeness here: the backend re-validates coverage against the facts IT sent
  // (it is the only side that knows the authoritative list), so duplicating that check would just
  // give the same rejection two different error messages.
  return questions;
}

/** Runs the authoring session and returns the questions it wrote. */
export async function executeQuizAuthoring(input: QuizAuthoringRequest, helpers: { readonly from: ChannelFrom }): Promise<QuizAuthoringResult> {
  const session = await helpers.from(`quiz:${input.round_id}`).send(buildQuizPrompt(input), {
    auth: buildGrowthSessionAuth({
      project_id: input.project_id,
      branch_id: input.branch_id,
      // No run/phase context and no agent_token: this session calls no backend routes, so it holds
      // no capability. "report" is the honest finding_source bucket if a tool ever were added.
      finding_source: "report",
    }),
    // One session per round: a repeat request for the same round is a retry of the same work.
    mode: "task",
    title: `Growth quiz questions (round ${input.round_id})`,
    // Retries must queue behind an in-flight run instead of steering it away.
    turnPolicy: "queue",
  });

  const chunks: string[] = [];
  collect: for await (const event of followSessionEvents({ session, label: "Quiz authoring", maxSessionMs: MAX_QUIZ_AUTHORING_MS })) {
    switch (event.type) {
      case "message.completed": {
        if (event.data.message != null && event.data.message.length > 0 && !chunks.includes(event.data.message)) {
          chunks.push(event.data.message);
        }
        break;
      }
      case "session.completed": {
        break collect;
      }
      case "session.failed": {
        throw new Error(`Quiz authoring session failed: session=${session.id} code=${event.data.code} message=${event.data.message}`);
      }
      case "session.waiting": {
        throw new Error(`Quiz authoring session parked waiting for input in task mode: session=${session.id}`);
      }
      default: {
        break;
      }
    }
  }

  for (const chunk of [...chunks].reverse()) {
    const entries = extractJsonArray(chunk);
    if (entries != null) return { questions: toAuthoredQuestions(entries) };
  }
  throw new Error(`Quiz authoring produced no JSON array: session=${session.id}`);
}
