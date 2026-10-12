import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { signJWT } from "@hexclave/shared/dist/utils/jwt";

// HTTP client for the internal tool's /api/backend/* ingest routes. The tool
// owns all SpacetimeDB interaction (module, OIDC issuer, signing key); the
// backend only ships telemetry to it over HTTP.
//
// Auth: a short-lived JWT assertion signed with the Stack Auth project keys
// the backend inherently holds (via STACK_SERVER_SECRET) — no shared secret.
// The tool verifies it against the project's public JWKS. The reserved
// subject + `token_use` claim distinguish it from ordinary user access tokens
// (which always carry UUID subjects), so those can't be replayed against the
// ingest routes.

const INTERNAL_TOOL_FETCH_TIMEOUT_MS = 10_000;

const ASSERTION_SUBJECT = "__internal_tool_backend__";
const ASSERTION_TOKEN_USE = "internal-tool-backend";
const ASSERTION_TTL_MILLIS = 5 * 60 * 1000;
const ASSERTION_REFRESH_MARGIN_MILLIS = 60 * 1000;

function toolBase(): string | null {
  const base = getEnvVariable("HEXCLAVE_INTERNAL_TOOL_URL", "").trim().replace(/\/+$/, "");
  return base === "" ? null : base;
}

// The Hexclave project the internal tool runs on — its id is the assertion
// audience (the public JWKS endpoint serves keys per project id, so the tool
// can verify without any shared secret).
function internalToolProjectId(): string {
  return getEnvVariable("HEXCLAVE_INTERNAL_TOOL_PROJECT_ID");
}

let cachedAssertion: { token: string, expiresAtMillis: number } | null = null;

async function getAssertion(): Promise<string> {
  if (cachedAssertion && Date.now() < cachedAssertion.expiresAtMillis - ASSERTION_REFRESH_MARGIN_MILLIS) {
    return cachedAssertion.token;
  }
  const apiUrl = getEnvVariable("NEXT_PUBLIC_STACK_API_URL").replace(/\/+$/, "");
  const projectId = internalToolProjectId();
  const token = await signJWT({
    issuer: `${apiUrl}/api/v1/projects/${projectId}`,
    audience: projectId,
    expirationTime: `${ASSERTION_TTL_MILLIS / 1000}s`,
    payload: {
      sub: ASSERTION_SUBJECT,
      token_use: ASSERTION_TOKEN_USE,
    },
  });
  cachedAssertion = { token, expiresAtMillis: Date.now() + ASSERTION_TTL_MILLIS };
  return token;
}

/**
 * Calls an internal-tool ingest route. Returns `null` (without doing
 * anything) when `HEXCLAVE_INTERNAL_TOOL_URL` is unset — telemetry is disabled,
 * mirroring the old "no SpacetimeDB configured" behavior. Throws on non-2xx.
 */
export async function callInternalTool<T = unknown>(path: string, options?: {
  method?: "GET" | "POST",
  body?: unknown,
  timeoutMs?: number,
}): Promise<T | null> {
  const base = toolBase();
  if (!base) return null;

  const method = options?.method ?? "POST";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${await getAssertion()}`,
      ...options?.body !== undefined ? { "Content-Type": "application/json" } : {},
    },
    ...options?.body !== undefined ? { body: JSON.stringify(options.body) } : {},
    signal: AbortSignal.timeout(options?.timeoutMs ?? INTERNAL_TOOL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const preview = (await res.text()).slice(0, 200);
    const detail = `Internal tool ${method} ${path} failed (${res.status}): ${preview}`;
    if (res.status >= 400 && res.status < 500) throw new StatusError(res.status, detail);
    throw new StatusError(StatusError.BadGateway, detail);
  }
  return await res.json() as T;
}

/**
 * Like {@link callInternalTool}, but throws when telemetry is unconfigured
 * instead of silently skipping.
 */
export async function callInternalToolStrict<T = unknown>(path: string, options?: {
  method?: "GET" | "POST",
  body?: unknown,
  timeoutMs?: number,
}): Promise<T> {
  const result = await callInternalTool<T>(path, options);
  if (result === null) {
    throw new HexclaveAssertionError(
      `Internal tool is not configured; ${path} cannot run. Check HEXCLAVE_INTERNAL_TOOL_URL.`,
    );
  }
  return result;
}
