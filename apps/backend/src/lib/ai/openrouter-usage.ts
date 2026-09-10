import { getOpenRouterProxyBaseUrl } from "@/lib/ai/models";
import { callInternalTool } from "@/lib/ai/internal-tool-client";
import type { GenerationUsageFields, OpenRouterGenerationData } from "@/lib/ai/types";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError } from "@hexclave/shared/dist/utils/errors";

type OpenRouterGenerationResponse = {
  data: OpenRouterGenerationData,
};
const GENERATION_RETRY_DELAYS_MS = [1500, 4000, 10000];
const GENERATION_PER_REQUEST_TIMEOUT_MS = 5000;

function isOpenRouterGenerationResponse(value: unknown): value is OpenRouterGenerationResponse {
  return typeof value === "object" && value !== null
    && "data" in value
    && typeof value.data === "object" && value.data !== null;
}

async function fetchGenerationOnce(
  generationId: string,
): Promise<GenerationUsageFields | null | "not_ready"> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GENERATION_PER_REQUEST_TIMEOUT_MS);
  const apiKey = getEnvVariable("STACK_OPENROUTER_API_KEY", "");
  const url = apiKey && apiKey !== "FORWARD_TO_PRODUCTION"
    ? `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`
    : `${getOpenRouterProxyBaseUrl()}/generation?id=${encodeURIComponent(generationId)}`;
  const headers = apiKey && apiKey !== "FORWARD_TO_PRODUCTION"
    ? { "Authorization": `Bearer ${apiKey}` }
    : undefined;
  try {
    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
    });
    if (res.status === 404) return "not_ready";
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter /generation returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const json: unknown = await res.json();
    if (!isOpenRouterGenerationResponse(json)) return null;
    const data = json.data;
    return {
      inputTokens: data.native_tokens_prompt ?? data.tokens_prompt ?? undefined,
      outputTokens: data.native_tokens_completion ?? data.tokens_completion ?? undefined,
      cachedInputTokens: data.native_tokens_cached ?? undefined,
      costUsd: data.total_cost,
      cacheDiscountUsd: data.cache_discount ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function refineGenerationUsage(opts: {
  generationId: string,
  correlationId: string,
}): Promise<void> {
  // Tracks how the final attempt failed so exhaustion is never silent: the
  // not_ready path used to fall out of the loop without any error report,
  // leaving rows permanently missing cost data with no trace of why.
  let sawNotReadyOnLastAttempt = false;
  for (let attempt = 0; attempt < GENERATION_RETRY_DELAYS_MS.length; attempt++) {
    await new Promise(r => setTimeout(r, GENERATION_RETRY_DELAYS_MS[attempt]));
    try {
      const result = await fetchGenerationOnce(opts.generationId);
      if (result === "not_ready") {
        sawNotReadyOnLastAttempt = true;
        continue;
      }
      if (result == null) return;
      await callInternalTool("/api/backend/update-ai-query-usage", {
        body: {
          correlationId: opts.correlationId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedInputTokens: result.cachedInputTokens,
          costUsd: result.costUsd,
          cacheDiscountUsd: result.cacheDiscountUsd,
        },
      });
      return;
    } catch (err) {
      sawNotReadyOnLastAttempt = false;
      if (attempt === GENERATION_RETRY_DELAYS_MS.length - 1) {
        captureError("openrouter-generation-usage-refine", err);
      }
    }
  }
  if (sawNotReadyOnLastAttempt) {
    captureError("openrouter-generation-usage-refine", new Error(
      `OpenRouter generation ${opts.generationId} was still not ready after ${GENERATION_RETRY_DELAYS_MS.length} attempts; usage for AI query ${opts.correlationId} was not refined (no cost data recorded)`,
    ));
  }
}
