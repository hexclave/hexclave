import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { PRODUCTION_AI_PROXY_BASE_URL } from "./proxy-url";

export const MODEL_QUALITIES = ["dumb", "smart", "smartest"] as const;
export const MODEL_SPEEDS = ["slow", "fast"] as const;
export type ModelQuality = typeof MODEL_QUALITIES[number];
export type ModelSpeed = typeof MODEL_SPEEDS[number];

type ModelConfig = {
  modelId: string,
};

const MODEL_SELECTION_MATRIX: Record<
  ModelQuality,
  Record<ModelSpeed, { authenticated: ModelConfig, unauthenticated: ModelConfig }>
> = {
  dumb: {
    slow: {
      authenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
    fast: {
      authenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
  },
  smart: {
    slow: {
      authenticated: { modelId: "openai/gpt-5.6-sol:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
    fast: {
      authenticated: { modelId: "openai/gpt-5.6-sol:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
  },
  smartest: {
    slow: {
      authenticated: { modelId: "openai/gpt-5.6-sol:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
    fast: {
      authenticated: { modelId: "openai/gpt-5.6-sol:nitro" },
      unauthenticated: { modelId: "z-ai/glm-5.3-flash:nitro" },
    },
  },
};

// All unique model IDs referenced in the selection matrix, plus sonnet as the proxy default
export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set([
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  ...Object.values(MODEL_SELECTION_MATRIX).flatMap(quality =>
    Object.values(quality).flatMap(speed =>
      Object.values(speed).map(config => config.modelId)
    )
  ),
]);

export function getOpenRouterProxyBaseUrl() {
  // Development AI calls loop back into this backend's OpenRouter proxy. Use the
  // configured port prefix so non-default prefixes (91/92/93) don't ECONNREFUSED
  // against a hardcoded 8102 that isn't running.
  const portPrefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
  return (getNodeEnvironment() === "development")
    ? `http://localhost:${portPrefix}02/api/latest/integrations/ai-proxy/v1`
    : `${PRODUCTION_AI_PROXY_BASE_URL}/v1`;
}

export function createOpenRouterProvider() {
  const baseURL = getOpenRouterProxyBaseUrl();
  return createOpenRouter({
    apiKey: "forwarded",
    baseURL,
  });
}

export function createDirectOpenRouterProvider(apiKey: string) {
  return createOpenRouter({ apiKey });
}

export function selectModel(
  quality: ModelQuality,
  speed: ModelSpeed,
  isAuthenticated: boolean,
  directApiKey?: string,
) {
  if (!MODEL_QUALITIES.includes(quality)) throw new HexclaveAssertionError("Invalid quality");
  if (!MODEL_SPEEDS.includes(speed)) throw new HexclaveAssertionError("Invalid speed");

  const config =
    MODEL_SELECTION_MATRIX[quality][speed][isAuthenticated ? "authenticated" : "unauthenticated"];

  const openRouter = directApiKey
    ? createDirectOpenRouterProvider(directApiKey)
    : createOpenRouterProvider();
  const model = openRouter(config.modelId);
  return model;
}
