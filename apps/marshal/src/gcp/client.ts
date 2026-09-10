import { setTimeout as delay } from "node:timers/promises";
import { MutationOutcomeUnknownError, PROVIDER_MUTATION_TIMEOUT_MS, PROVIDER_READ_TIMEOUT_MS } from "../mutation-safety.js";
import { googleAccessToken } from "./auth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerMessage(body: unknown): string {
  if (!isRecord(body)) return "Google Cloud returned a non-object error";
  const error = body.error;
  if (!isRecord(error) || typeof error.message !== "string") return "Google Cloud returned an unrecognized error";
  return error.message.slice(0, 1000);
}

// The `google.rpc.*` type names carried in `error.details`, which is where Google says WHY a
// request failed when the status and message alone do not: a quota failure and a not-ready-yet
// precondition are both `400 "Precondition check failed."`, and only a `QuotaFailure` detail
// tells them apart. Callers that retry on a message must consult these before deciding.
function providerDetailTypes(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const error = body.error;
  if (!isRecord(error) || !Array.isArray(error.details)) return [];
  return error.details.flatMap((detail) => {
    if (!isRecord(detail) || typeof detail["@type"] !== "string") return [];
    return [detail["@type"].replace(/^type\.googleapis\.com\//, "")];
  });
}

function isApiActivationPropagationError(status: number, message: string): boolean {
  return status === 403
    && message.includes("has not been used in project")
    && message.includes("If you enabled this API recently, wait a few minutes");
}

function trustedGoogleApiUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || !(url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))) {
    throw new Error(`refusing to send Google credentials to untrusted API origin ${JSON.stringify(url.origin)}`);
  }
  return url;
}

function operationUrl(operationName: string, apiBaseUrl: string): string {
  // Operation names can be persisted in the state bucket. Treat them as resource names only:
  // accepting an absolute URL would turn a bucket write into an OAuth-token exfiltration path.
  const normalized = operationName.replace(/^\/+/, "");
  if (normalized === ""
    || operationName.includes("://")
    || operationName.includes("?")
    || operationName.includes("#")
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || !/^[A-Za-z0-9._~/-]+$/.test(normalized)) {
    throw new Error(`Google Cloud returned an invalid operation name ${JSON.stringify(operationName)}`);
  }
  const base = trustedGoogleApiUrl(apiBaseUrl);
  const baseWithSlash = base.pathname.endsWith("/") ? base : new URL(`${base.pathname}/`, base.origin);
  return new URL(normalized, baseWithSlash).toString();
}

export class GcpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly providerMessage: string,
    public readonly providerDetailTypes: readonly string[] = [],
  ) {
    // The detail types belong in the message because they are often the only thing that says
    // what actually went wrong — "Precondition check failed." reads as a transient hiccup until
    // a `google.rpc.QuotaFailure` next to it identifies it as an exhausted quota.
    const elaboration = providerDetailTypes.length === 0 ? "" : ` (${providerDetailTypes.join(", ")})`;
    super(`Google Cloud API error at ${endpoint}: HTTP ${status}: ${providerMessage}${elaboration}`);
    this.name = "GcpApiError";
  }
}

export type GcpOperation = {
  name: string,
  done?: boolean,
  error?: { code?: number, message?: string },
  response?: unknown,
};

export function parseGcpOperation(value: unknown): GcpOperation {
  if (!isRecord(value) || typeof value.name !== "string") throw new Error("Google Cloud returned an invalid operation");
  const done = value.done;
  if (done !== undefined && typeof done !== "boolean") throw new Error(`Google Cloud operation ${value.name} has an invalid done field`);
  const rawError = value.error;
  let error: GcpOperation["error"];
  if (rawError !== undefined) {
    if (!isRecord(rawError)) throw new Error(`Google Cloud operation ${value.name} has an invalid error field`);
    const code = rawError.code;
    const message = rawError.message;
    if (code !== undefined && typeof code !== "number") throw new Error(`Google Cloud operation ${value.name} has an invalid error code`);
    if (message !== undefined && typeof message !== "string") throw new Error(`Google Cloud operation ${value.name} has an invalid error message`);
    error = { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
  }
  return {
    name: value.name,
    ...(done === undefined ? {} : { done }),
    ...(error === undefined ? {} : { error }),
    ...(value.response === undefined ? {} : { response: value.response }),
  };
}

export class GcpClient {
  constructor(private readonly mock?: { url: string, token: string }) {}

  private requestUrl(url: string): string {
    const upstream = trustedGoogleApiUrl(url);
    if (this.mock === undefined) return upstream.toString();
    return `${this.mock.url}/googleapis/${upstream.host}${upstream.pathname}${upstream.search}`;
  }

  async request(url: string, options?: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
    allow404?: boolean,
  }): Promise<unknown | null> {
    // TODO(reliability): add a small, bounded retry policy for transient idempotent reads and
    // operation polls. Mutations must remain outcome-unknown after transport failure unless a
    // provider idempotency key makes replay demonstrably safe.
    const method = options?.method ?? "GET";
    const startedAt = performance.now();
    let retryDelayMillis = 1000;
    for (;;) {
      let response: Response;
      // The body read belongs inside the deadline and the mutation fence, not after them: a
      // response that stalls once its headers have arrived would otherwise never time out and
      // would hold a reconciliation lease indefinitely, and a body read that fails after a
      // mutation was already dispatched would surface as a definite failure when the provider
      // may well have applied it.
      let text: string;
      // Credentials are acquired BEFORE the mutation fence below, and bounded by the read
      // timeout rather than the mutation one. Federation makes this two extra round trips
      // (STS, then impersonation), and a failure in either means nothing was ever dispatched —
      // reporting that as outcome-unknown would hold a reconciliation lease through the drain
      // grace for what is simply a credential error.
      const token = this.mock?.token ?? await googleAccessToken(AbortSignal.timeout(PROVIDER_READ_TIMEOUT_MS));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`Google Cloud ${method} request timed out`)), method === "GET" ? PROVIDER_READ_TIMEOUT_MS : PROVIDER_MUTATION_TIMEOUT_MS);
      try {
        response = await fetch(this.requestUrl(url), {
          method,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
        if (options?.allow404 === true && response.status === 404) return null;
        text = await response.text();
      } catch (error) {
        if (method === "GET") throw error;
        throw new MutationOutcomeUnknownError(`Google Cloud mutation ${method} ${new URL(url).pathname} ended without a complete response`, { cause: error });
      } finally {
        clearTimeout(timeout);
      }
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          if (!response.ok) throw new GcpApiError(response.status, new URL(url).pathname, "Google Cloud returned a non-JSON error");
          throw new GcpApiError(502, new URL(url).pathname, "Google Cloud returned non-JSON success data");
        }
      }
      if (response.ok) return body;
      const message = providerMessage(body);
      if (isApiActivationPropagationError(response.status, message) && performance.now() - startedAt < 2 * 60 * 1000) {
        await delay(retryDelayMillis);
        retryDelayMillis = Math.min(retryDelayMillis * 2, 10_000);
        continue;
      }
      throw new GcpApiError(response.status, new URL(url).pathname, message, providerDetailTypes(body));
    }
  }

  // A SINGLE poll of a long-running operation, for callers that must not block: the project
  // pool advancer runs on a cron in a serverless function that is frozen at response time, so
  // it stores the operation name and re-polls it on a later tick instead of waiting here.
  // Throws when the operation itself failed, exactly as waitForOperation does.
  async pollOperation(operationName: string, options?: { apiBaseUrl?: string }): Promise<GcpOperation> {
    const url = operationUrl(operationName, options?.apiBaseUrl ?? "https://cloudresourcemanager.googleapis.com/v3/");
    const current = parseGcpOperation(await this.request(url) ?? throwError(`Google Cloud operation ${operationName} disappeared`));
    if (current.error !== undefined) {
      throw new GcpApiError(current.error.code ?? 500, current.name, current.error.message ?? "operation failed");
    }
    return current;
  }

  async waitForOperation(operation: GcpOperation, options?: { timeoutMillis?: number, apiBaseUrl?: string }): Promise<GcpOperation> {
    const timeoutMillis = options?.timeoutMillis ?? 10 * 60 * 1000;
    const startedAt = performance.now();
    let current = operation;
    while (current.done !== true) {
      if (performance.now() - startedAt >= timeoutMillis) {
        throw new GcpApiError(408, current.name, "timed out waiting for operation");
      }
      await delay(1000);
      const url = operationUrl(current.name, options?.apiBaseUrl ?? "https://cloudresourcemanager.googleapis.com/v3/");
      current = parseGcpOperation(await this.request(url) ?? throwError(`Google Cloud operation ${current.name} disappeared`));
    }
    if (current.error !== undefined) {
      throw new GcpApiError(current.error.code ?? 500, current.name, current.error.message ?? "operation failed");
    }
    return current;
  }
}

function throwError(message: string): never {
  throw new Error(message);
}
