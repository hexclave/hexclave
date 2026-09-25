import { captureError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { callInternalTool } from "../internal-tool-client";

// The human-verified published Q&A block injected into AI system prompts.
// Served by the internal tool (which owns all SpacetimeDB access); cached
// in-memory because this sits on the hot path of every AI query. Fail-soft:
// any error just omits the block from the prompt.

const CACHE_TTL_MILLIS = 60 * 1000;

let cached: { value: string, expiresAtMillis: number } | null = null;

export async function getVerifiedQaContext(): Promise<string> {
  if (cached && Date.now() < cached.expiresAtMillis) {
    return cached.value;
  }
  const result = await Result.fromPromise(getVerifiedQaContextInner());
  if (result.status === "error") {
    captureError("verified-qa", result.error);
    cached = { value: cached?.value ?? "", expiresAtMillis: Date.now() + CACHE_TTL_MILLIS };
    return cached.value;
  }
  cached = { value: result.data, expiresAtMillis: Date.now() + CACHE_TTL_MILLIS };
  return result.data;
}
const VERIFIED_QA_FETCH_TIMEOUT_MS = 2_000;

async function getVerifiedQaContextInner(): Promise<string> {
  const response = await callInternalTool<{ context: string }>("/api/backend/verified-qa", { method: "GET", timeoutMs: VERIFIED_QA_FETCH_TIMEOUT_MS });
  // Telemetry/internal tool not configured — prompts simply omit the block.
  if (response == null) return "";
  if (typeof response.context !== "string") {
    throw new Error("Internal tool /api/backend/verified-qa returned an invalid response");
  }
  return response.context;
}
