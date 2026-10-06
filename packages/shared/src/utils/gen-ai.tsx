import { truncateUtf8Bytes } from "./analytics-wire";

/**
 * Normalization of AI/agent span attributes into one canonical shape.
 *
 * The wire carries three attribute vintages simultaneously and none of them is
 * frozen: the OTel GenAI semantic conventions are still marked Development (and
 * moved to their own repo in 2026), the Vercel AI SDK emitted its own `ai.*`
 * attribute family through v6 (and still does via `LegacyOpenTelemetry` in v7),
 * and pre-2025 gen_ai emitters use since-renamed attributes (`gen_ai.system`,
 * `gen_ai.usage.prompt_tokens`). Rather than teaching every reader all three
 * dialects, ingest extracts this canonical projection once; the raw attributes
 * stay stored losslessly, so a rename in the conventions only ever requires
 * extending the alias tables here.
 */

/**
 * Canonical `gen_ai.operation.name` values from the OTel GenAI semantic
 * conventions. Used to recognize spans that follow the `{operation} {model}`
 * span-name convention but omit `gen_ai.operation.name` itself (common among
 * pre-v1.37 instrumentations).
 */
export const KNOWN_GEN_AI_OPERATIONS = new Set([
  "chat",
  "generate_content",
  "text_completion",
  "embeddings",
  "retrieval",
  "fetch_response",
  "execute_tool",
  "create_agent",
  "invoke_agent",
  "invoke_workflow",
  "plan",
  "create_memory",
  "update_memory",
  "upsert_memory",
  "delete_memory",
  "search_memory",
  "create_memory_store",
  "delete_memory_store",
]);

/**
 * Legacy Vercel AI SDK `ai.operationId` values, mapped to the canonical
 * operation the SDK's own v7 gen_ai emitter (`@ai-sdk/otel`'s `OpenTelemetry`
 * class) produces for the same call: the outer generate/stream call becomes
 * `invoke_agent` and each per-step provider call becomes `chat`. Mirroring
 * that mapping makes a v5/v6 app and a v7 app look identical in queries.
 */
const VERCEL_AI_OPERATION_IDS: ReadonlyMap<string, string> = new Map([
  ["ai.generateText", "invoke_agent"],
  ["ai.streamText", "invoke_agent"],
  ["ai.generateObject", "invoke_agent"],
  ["ai.streamObject", "invoke_agent"],
  ["ai.generateText.doGenerate", "chat"],
  ["ai.streamText.doStream", "chat"],
  ["ai.generateObject.doGenerate", "chat"],
  ["ai.streamObject.doStream", "chat"],
  ["ai.toolCall", "execute_tool"],
  ["ai.embed", "embeddings"],
  ["ai.embedMany", "embeddings"],
  ["ai.embed.doEmbed", "embeddings"],
  ["ai.embedMany.doEmbed", "embeddings"],
]);

// Alias tables, most-current spelling first. A later (deprecated) alias is only
// consulted when every earlier one is absent or invalid, so an emitter that
// sends both vintages (the Vercel AI SDK doGenerate spans do) resolves to the
// current convention's value.
const PROVIDER_NAME_KEYS = ["gen_ai.provider.name", "gen_ai.system", "ai.model.provider"] as const;
const REQUEST_MODEL_KEYS = ["gen_ai.request.model", "ai.model.id"] as const;
const RESPONSE_MODEL_KEYS = ["gen_ai.response.model", "ai.response.model"] as const;
const INPUT_TOKEN_KEYS = ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.inputTokens", "ai.usage.promptTokens"] as const;
const OUTPUT_TOKEN_KEYS = ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "ai.usage.outputTokens", "ai.usage.completionTokens"] as const;
const CACHE_READ_INPUT_TOKEN_KEYS = ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cached_input_tokens", "ai.usage.cachedInputTokens"] as const;
const REASONING_OUTPUT_TOKEN_KEYS = ["gen_ai.usage.reasoning.output_tokens", "ai.usage.reasoningTokens"] as const;
const TOOL_NAME_KEYS = ["gen_ai.tool.name", "ai.toolCall.name"] as const;
const AGENT_NAME_KEYS = ["gen_ai.agent.name"] as const;
const CONVERSATION_ID_KEYS = ["gen_ai.conversation.id"] as const;

/**
 * Extracted column values are identity/dimension strings (operation, provider,
 * model, tool, agent, conversation), never content. Anything longer than this
 * is not one of those; truncating keeps a hostile or buggy emitter from turning
 * a dimension column into a blob store while the untruncated original remains
 * readable in the span's stored attributes.
 */
export const GEN_AI_EXTRACTED_STRING_MAX_BYTES = 256;

export type GenAiSpanInfo = {
  operationName: string,
  providerName: string | null,
  requestModel: string | null,
  responseModel: string | null,
  /**
   * Token counts are canonical base-10 uint64 strings (not numbers): OTLP int
   * attributes arrive as int64 strings, and passing them through verbatim
   * avoids a lossy detour through JS doubles on the ingest path.
   */
  inputTokens: string | null,
  outputTokens: string | null,
  cacheReadInputTokens: string | null,
  reasoningOutputTokens: string | null,
  toolName: string | null,
  agentName: string | null,
  conversationId: string | null,
};

/**
 * Accessor over a span's attribute bag. Returns the primitive value for a key,
 * or null when absent or non-primitive. Kept as a function rather than a
 * concrete map type so the backend's OTLP attribute representation and any
 * client-side representation can adapt without copying the whole bag.
 */
export type GenAiAttributeReader = (key: string) => string | number | boolean | null;

function readString(getAttribute: GenAiAttributeReader, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = getAttribute(key);
    if (typeof value === "string" && value !== "") {
      return truncateUtf8Bytes(value, GEN_AI_EXTRACTED_STRING_MAX_BYTES);
    }
  }
  return null;
}

const UINT64_MAX = 18446744073709551615n;

function asTokenCount(value: string | number | boolean | null): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  // Canonicalize before applying UInt64's 20-digit bound. OTLP integer text
  // may contain leading zeros, which do not contribute to the value's range.
  const canonical = value.replace(/^0+(?=\d)/, "");
  if (canonical.length > 20 || BigInt(canonical) > UINT64_MAX) return null;
  return canonical;
}

function readTokenCount(getAttribute: GenAiAttributeReader, keys: readonly string[]): string | null {
  for (const key of keys) {
    const count = asTokenCount(getAttribute(key));
    if (count !== null) return count;
  }
  return null;
}

function resolveOperationName(spanName: string, getAttribute: GenAiAttributeReader): string | null {
  const declared = getAttribute("gen_ai.operation.name");
  if (typeof declared === "string" && declared !== "") {
    return truncateUtf8Bytes(declared, GEN_AI_EXTRACTED_STRING_MAX_BYTES);
  }
  const vercelOperationId = getAttribute("ai.operationId");
  if (typeof vercelOperationId === "string") {
    const mapped = VERCEL_AI_OPERATION_IDS.get(vercelOperationId);
    if (mapped !== undefined) return mapped;
  }
  // Pre-v1.37 gen_ai emitters name spans `{operation} {model}` without always
  // setting gen_ai.operation.name. Only infer when another gen_ai attribute
  // corroborates, so an unrelated span that happens to be named "chat" is not
  // misclassified as AI telemetry.
  const inferred = spanName.split(" ")[0];
  if (KNOWN_GEN_AI_OPERATIONS.has(inferred) && readString(getAttribute, [...PROVIDER_NAME_KEYS, ...REQUEST_MODEL_KEYS, "gen_ai.agent.name", "gen_ai.tool.name"]) !== null) {
    return inferred;
  }
  return null;
}

/**
 * Returns the canonical AI projection of a span, or null when the span carries
 * no recognizable AI telemetry. Never throws on malformed attributes: this
 * runs against third-party OTLP exports, and a bad value in one alias must
 * degrade to the next alias (or to null), not reject the batch.
 */
export function extractGenAiSpanInfo(spanName: string, getAttribute: GenAiAttributeReader): GenAiSpanInfo | null {
  const operationName = resolveOperationName(spanName, getAttribute);
  if (operationName === null) return null;
  const agentName = readString(getAttribute, AGENT_NAME_KEYS)
    // The Vercel AI SDK's functionId names the logical operation the developer
    // instrumented; its v7 gen_ai emitter promotes it to gen_ai.agent.name on
    // the invoke_agent root, so give legacy spans the same treatment.
    ?? (operationName === "invoke_agent" || operationName === "create_agent"
      ? readString(getAttribute, ["ai.telemetry.functionId"])
      : null);
  return {
    operationName,
    providerName: readString(getAttribute, PROVIDER_NAME_KEYS),
    requestModel: readString(getAttribute, REQUEST_MODEL_KEYS),
    responseModel: readString(getAttribute, RESPONSE_MODEL_KEYS),
    inputTokens: readTokenCount(getAttribute, INPUT_TOKEN_KEYS),
    outputTokens: readTokenCount(getAttribute, OUTPUT_TOKEN_KEYS),
    cacheReadInputTokens: readTokenCount(getAttribute, CACHE_READ_INPUT_TOKEN_KEYS),
    reasoningOutputTokens: readTokenCount(getAttribute, REASONING_OUTPUT_TOKEN_KEYS),
    toolName: readString(getAttribute, TOOL_NAME_KEYS),
    agentName,
    conversationId: readString(getAttribute, CONVERSATION_ID_KEYS),
  };
}
