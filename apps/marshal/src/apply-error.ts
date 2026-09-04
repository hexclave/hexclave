import { MarshalError } from "./errors.js";
import { GcpApiError } from "./gcp/client.js";

// The user-facing half of the same rule marshal-app.ts::errorResponse enforces for HTTP
// responses, applied to the OTHER channel a failure travels down: the `error` string stored
// on a service and on a deployment's per-service outcome.
//
// That string is not internal. The backend relays it verbatim, `hexclave deploy` prints it
// under the failing service, and the dashboard renders it in the deployment panel — so
// nothing the infrastructure provider produced may appear in it: not its wording, not its
// status codes, and not the org/app identifiers that its endpoints (and therefore
// GcpApiError.message) embed.
//
// The relay is therefore an allowlist, not a filter: only messages this codebase authored
// are passed through, and every other error collapses to a fixed string. Callers log the
// original — that is where the provider's own detail belongs, and the only place it goes.

const GENERIC_APPLY_FAILURE = "the service could not be deployed. Check its logs, then deploy again; contact support if it keeps failing";

/**
 * The user-facing text for an error caught while applying a service spec.
 *
 * Never returns the caught error's message unless we wrote it. Log the error
 * alongside calling this — it is the only remaining record of what really
 * happened.
 */
export function applyErrorMessage(error: unknown): string {
  // Our own request-level rejections: written for the caller in the first place
  // (an unresolvable ref, a volume that may not shrink), and provider-free by
  // the same rule that lets marshal-app.ts return them over HTTP.
  if (error instanceof MarshalError) return error.message;
  // Runtime waits consistently use 408 for a service that did not become ready. Preserve
  // the useful startup guidance without relaying the provider's endpoint or error body.
  if (error instanceof GcpApiError && error.status === 408) {
    return "the service did not start in time. Check its logs for a crash on startup";
  }
  return GENERIC_APPLY_FAILURE;
}
