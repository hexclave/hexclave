import "server-only";

import { createMCPClient } from "@ai-sdk/mcp";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod";
import { callReducerStrict, opt } from "./spacetimedb-client";
import { getVerifiedQaContext } from "./verified-qa";

const QA_SYSTEM_PROMPT = `You are a QA reviewer for Hexclave's AI documentation assistant.
You will receive a question, the agent's stated reason for asking, and the AI's response.

Your tasks:
1. RELEVANCE: Does the response actually answer the question? Does the stated reason align with what was asked?
2. CORRECTNESS: Verify factual claims about Hexclave. Use human-verified Q&A (appended below, if any) as the highest-priority source of truth — these are always correct. Then use the available tools to look up additional information from the Hexclave codebase. If the AI response contradicts a human-verified answer, flag it as incorrect.

The repo name for all tool calls is "hexclave/hexclave". Only use the repository documentation tools (read_wiki_structure, read_wiki_contents, ask_question) — do not create sessions or modify any other resources.

Produce a structured review. For each issue you find, add an entry to "flags" with a type, severity (one of "low", "medium", "high", "critical"), and explanation.

Flag types: "factual_error", "incomplete_answer", "off_topic", "hallucination", "outdated_info", "missing_context", "misleading", "reason_mismatch"

Scoring:
- 90-100: Excellent — factually correct, fully addresses the question
- 70-89: Good — minor issues or missing details
- 50-69: Acceptable — notable issues but core answer is present
- 30-49: Poor — significant problems
- 0-29: Unacceptable — fundamentally wrong or irrelevant

Set needsHumanReview=true if: score < 50, any critical flag, or you are uncertain about correctness.`;

const REVIEW_MODEL_ID = "x-ai/grok-build-0.1";

const qaReviewSchema = z.object({
  needsHumanReview: z.boolean(),
  answerCorrect: z.boolean(),
  answerRelevant: z.boolean(),
  flags: z.array(z.object({
    type: z.string(),
    severity: z.string(),
    explanation: z.string(),
  })),
  // Optional in practice: the model omits this for good answers with nothing to suggest.
  // Defaulting (rather than requiring) avoids turning those into structured-output failures.
  improvementSuggestions: z.string().default(""),
  overallScore: z.number(),
});

function createOpenRouterProvider() {
  return createOpenRouter({
    apiKey: getEnvVariable("HEXCLAVE_OPENROUTER_API_KEY"),
  });
}

export async function clearMcpQaReview(accessToken: string, correlationId: string): Promise<void> {
  await callReducerStrict(accessToken, "clear_mcp_qa_review", [
    correlationId,
  ]);
}

export async function reviewMcpCall(accessToken: string, entry: {
  correlationId: string,
  question: string,
  reason: string,
  response: string,
}): Promise<void> {
  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;

  // Null until a review verdict is produced. On any failure we leave it null and
  // skip the reducer write, so the row keeps `qaReviewedAt = null` (reads as
  // unreviewed) rather than being fail-closed into a permanent "reviewed but
  // broken" state. Unreviewed rows are picked up later by the "Review visible"
  // button (and, in future, a scheduled backfill).
  let update: {
    qaNeedsHumanReview: boolean,
    qaAnswerCorrect: boolean,
    qaAnswerRelevant: boolean,
    qaFlagsJson: string,
    qaImprovementSuggestions: string,
    qaOverallScore: number,
    qaConversationJson: string | undefined,
    qaErrorMessage: string | undefined,
  } | null = null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: "https://mcp.deepwiki.com/mcp",
      },
    });

    const mcpTools = await mcpClient.tools();
    const openrouter = createOpenRouterProvider();
    const model = openrouter(REVIEW_MODEL_ID);

    const maxResponseChars = 12_000;
    const truncatedResponse = entry.response.length > maxResponseChars
      ? `${entry.response.slice(0, maxResponseChars)}\n\n[...truncated ${entry.response.length - maxResponseChars} chars]`
      : entry.response;

    const userMessage = [
      "## Question",
      entry.question,
      "",
      "## Agent's Reason for Asking",
      entry.reason,
      "",
      "## AI Response",
      truncatedResponse,
    ].join("\n");

    const verifiedQa = await getVerifiedQaContext(accessToken);

    const result = await generateText({
      model,
      system: QA_SYSTEM_PROMPT + verifiedQa,
      // The MCP SDK returns FlexibleSchema<unknown> tools, while generateText's
      // ToolSet type over-constrains the schema generic. Runtime execution is
      // still validated by the MCP client/tool schemas.
      tools: mcpTools as Parameters<typeof generateText>[0]["tools"],
      stopWhen: stepCountIs(10),
      output: Output.object({ schema: qaReviewSchema }),
      messages: [{ role: "user", content: userMessage }],
      abortSignal: controller.signal,
      maxOutputTokens: 2000,
    });

    const conversation = result.steps.map((step, i) => {
      const toolCalls = step.toolCalls.map(tc => ({ toolName: tc.toolName, toolCallId: tc.toolCallId, args: tc.input }));
      const toolResults = step.toolResults.map(tr => ({
        toolName: tr.toolName,
        toolCallId: tr.toolCallId,
        result: tr.output,
      }));
      return {
        step: i + 1,
        text: step.text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      };
    });

    // The model is constrained to the schema via structured output, so the result is
    // already a validated object — no fragile text extraction or JSON.parse needed.
    // If the model fails to produce schema-conforming output, generateText throws and
    // we fail open below (row stays unreviewed), same as the old parse-failure path.
    const parsed = result.output;
    const overallScore = Math.max(0, Math.min(100, Math.round(parsed.overallScore)));
    const hasCriticalFlag = parsed.flags.some(flag => flag.severity === "critical");
    const needsHumanReview = parsed.needsHumanReview || overallScore < 50 || hasCriticalFlag;

    update = {
      qaNeedsHumanReview: needsHumanReview,
      qaAnswerCorrect: parsed.answerCorrect,
      qaAnswerRelevant: parsed.answerRelevant,
      qaFlagsJson: JSON.stringify(parsed.flags),
      qaImprovementSuggestions: parsed.improvementSuggestions,
      qaOverallScore: overallScore,
      qaConversationJson: JSON.stringify(conversation),
      qaErrorMessage: undefined,
    };
  } catch (err) {
    // Fail open: leave `update` null so we skip the reducer write and the row
    // stays unreviewed, eligible to be re-reviewed later.
    captureError("internal-tool-qa-reviewer-review-failed", err);
  } finally {
    clearTimeout(timeoutId);
  }

  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch (err) {
      captureError("internal-tool-qa-reviewer-mcp-client-close", err);
    }
  }

  if (update == null) return;

  try {
    await callReducerStrict(accessToken, "update_mcp_qa_review", [
      entry.correlationId,
      update.qaNeedsHumanReview,
      update.qaAnswerCorrect,
      update.qaAnswerRelevant,
      update.qaFlagsJson,
      update.qaImprovementSuggestions,
      update.qaOverallScore,
      REVIEW_MODEL_ID,
      opt(update.qaConversationJson),
      opt(update.qaErrorMessage),
    ]);
  } catch (err) {
    captureError("internal-tool-qa-reviewer-update-reducer-failed", err);
  }
}
