import { KnownErrors } from "@hexclave/shared/dist/known-errors";

/**
 * Transport-level primitives shared by every telemetry sender (event tracker,
 * session recorder, server-key telemetry).
 */

export function generateUuid() {
  return crypto.randomUUID();
}

export function isAnalyticsNotEnabledError(error: unknown): boolean {
  return KnownErrors.AnalyticsNotEnabled.isInstance(error);
}

/**
 * Whether the error looks like a network failure caused by an ad blocker or
 * similar extension blocking analytics requests. These are expected in
 * production and should be silently ignored rather than logged as warnings.
 */
export function isAdBlockerNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("Failed to fetch")
      || error.message.includes("NetworkError")
      || error.message.includes("Load failed")
      || error.message.includes("network connection");
  }
  return false;
}
