import { refineGenerationUsage } from "@/lib/ai/openrouter-usage";
import type { AiQueryLogEntry, LogAiQueryArgs } from "@/lib/ai/types";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { type StepResult, type ToolSet } from "ai";
import { callInternalTool } from "../internal-tool-client";

const MAX_TOOL_RESULT_CHARS = 50_000;

function truncateLargeToolResult(toolName: string, output: unknown): unknown {
  const serializableOutput = output === undefined || typeof output === "function" || typeof output === "symbol"
    ? {
      _nonJsonResult: true,
      valueType: typeof output,
    }
    : output;
  const serialized = JSON.stringify(serializableOutput);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serializableOutput;
  return {
    _truncated: true,
    toolName,
    originalSize: serialized.length,
    preview: serialized.slice(0, 10000),
  };
}

function serializeSteps(steps: ReadonlyArray<StepResult<ToolSet>>): string {
  try {
    return JSON.stringify(steps.map((step, i) => ({
      step: i,
      text: step.text || undefined,
      toolCalls: step.toolCalls.map(tc => ({
        toolName: tc.toolName,
        toolCallId: tc.toolCallId,
        args: tc.input,
      })),
      toolResults: step.toolResults.map(tr => ({
        toolName: tr.toolName,
        toolCallId: tr.toolCallId,
        result: truncateLargeToolResult(tr.toolName, tr.output),
      })),
    })));
  } catch (e) {
    captureError("ai-query-steps-serialize", e);
    // Must stay array-shaped: UsageDetail JSON.parses this as StepEntry[] and
    // calls .map on it unguarded, so an object here crashes the analytics view.
    return JSON.stringify([{
      step: 0,
      text: `[serialization of ${steps.length} steps failed]`,
      toolCalls: [],
      toolResults: [],
    }]);
  }
}

export function logAiQuery(args: LogAiQueryArgs): void {
  // Build the row inside the async task so any throw (serialization,
  // metadata extraction, etc.) is contained by the async boundary instead
  // of bubbling up into the user-facing request path.
  runAsynchronouslyAndWaitUntil(async () => {
    let entry: AiQueryLogEntry;
    if (args.type === "entry") {
      entry = args.entry;
    } else if (args.type === "success") {
      entry = {
        ...args.common,
        stepsJson: serializeSteps(args.steps),
        finalText: args.text,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cachedInputTokens: args.usage.inputTokenDetails.cacheReadTokens,
        cacheCreationTokens: args.usage.inputTokenDetails.cacheWriteTokens ?? undefined,
        costUsd: undefined,
        cacheDiscountUsd: undefined,
        openrouterGenerationId: args.openrouterGenerationId,
        stepCount: args.steps.length,
        durationMs: Math.round(performance.now() - args.startedAt),
        errorMessage: undefined,
      };
    } else {
      captureError("ai-query-upstream", args.err);
      entry = {
        ...args.common,
        stepsJson: args.partialSteps && args.partialSteps.length > 0 ? serializeSteps(args.partialSteps) : "[]",
        finalText: "",
        inputTokens: undefined,
        outputTokens: undefined,
        cachedInputTokens: undefined,
        cacheCreationTokens: undefined,
        costUsd: undefined,
        cacheDiscountUsd: undefined,
        openrouterGenerationId: undefined,
        stepCount: args.partialSteps?.length ?? 0,
        durationMs: Math.round(performance.now() - args.startedAt),
        errorMessage: args.err instanceof Error ? args.err.stack ?? `${args.err.name}: ${args.err.message}` : String(args.err),
      };
    }
    await callInternalTool("/api/backend/log-ai-query", { body: entry });
  });

  if (args.type === "success" && args.openrouterGenerationId != null) {
    runAsynchronouslyAndWaitUntil(refineGenerationUsage({
      generationId: args.openrouterGenerationId,
      correlationId: args.common.correlationId,
    }));
  }
  if (args.type === "entry" && args.entry.openrouterGenerationId != null) {
    runAsynchronouslyAndWaitUntil(refineGenerationUsage({
      generationId: args.entry.openrouterGenerationId,
      correlationId: args.entry.correlationId,
    }));
  }
}
