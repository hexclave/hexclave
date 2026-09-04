import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { parseResponseJson } from "@hexclave/shared/dist/utils/http";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { ManualTransactionRow } from "@/lib/payments/schema/types";

const BULLDOZER_FETCH_MAX_ATTEMPTS = 5;
const BULLDOZER_FETCH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];
const SAFE_CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"]);
const RETRIABLE_GET_RESPONSE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type ErrorWithCause = {
  cause?: unknown,
  code?: unknown,
  errors?: unknown,
};

function isErrorWithCause(value: unknown): value is ErrorWithCause {
  return typeof value === "object" && value !== null;
}

/**
 * A fetch failure is safe to retry only when every low-level error is a
 * connect-phase failure. In particular, ECONNRESET and timeouts are excluded:
 * they can happen after a non-idempotent request reached bulldozer.
 */
export function isRetriableBulldozerFetchError(error: unknown): boolean {
  const visited = new Set<object>();
  let foundSafeCode = false;

  function visit(value: unknown): boolean {
    if (!isErrorWithCause(value)) return false;
    if (visited.has(value)) return true;
    visited.add(value);

    const code = typeof value.code === "string" ? value.code : undefined;
    if (code !== undefined) {
      if (!SAFE_CONNECT_ERROR_CODES.has(code)) return false;
      foundSafeCode = true;
    }

    const children: unknown[] = [];
    if ("cause" in value && value.cause !== undefined) children.push(value.cause);
    if ("errors" in value && Array.isArray(value.errors)) children.push(...value.errors);
    if (children.length === 0) return code !== undefined;
    return children.every(visit);
  }

  return visit(error) && foundSafeCode;
}

function getBulldozerServerBaseUrl(): string {
  const configuredUrl = getEnvVariable("HEXCLAVE_BULLDOZER_SERVER_URL", "");
  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, "");
  }
  return `http://localhost:${getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81")}46`;
}

export function bulldozerCustomerPath(options: {
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
  suffix: string,
}): string {
  return urlString`/v1/${options.tenancyId}/customers/${options.customerType}/${options.customerId}/${options.suffix}`;
}

export async function fetchBulldozerServerJson<T>(options: {
  method: "GET" | "POST",
  path: string,
  body?: unknown,
}): Promise<T> {
  let attempt = 0;
  let firstRetryError: unknown;
  const response = await (async (): Promise<Response> => {
    while (true) {
      attempt++;
      try {
        const response = await fetch(`${getBulldozerServerBaseUrl()}${options.path}`, {
          method: options.method,
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${getEnvVariable("HEXCLAVE_BULLDOZER_SERVER_SECRET")}`,
          },
          ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        });

        if (
          options.method === "GET"
          && RETRIABLE_GET_RESPONSE_STATUSES.has(response.status)
          && attempt < BULLDOZER_FETCH_MAX_ATTEMPTS
        ) {
          firstRetryError ??= new HexclaveAssertionError("Bulldozer GET received a transient HTTP response", {
            method: options.method,
            path: options.path,
            status: response.status,
          });
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, BULLDOZER_FETCH_RETRY_DELAYS_MS[attempt - 1]));
          continue;
        }

        if (attempt > 1 && response.ok) {
          captureError("bulldozer-server-connect-retry", new HexclaveAssertionError("Bulldozer server request recovered after transient failures", {
            cause: firstRetryError,
            attempts: attempt,
            method: options.method,
            path: options.path,
          }));
        }
        return response;
      } catch (error) {
        const isRetriable = options.method === "GET" || isRetriableBulldozerFetchError(error);
        if (!isRetriable || attempt >= BULLDOZER_FETCH_MAX_ATTEMPTS) {
          throw error;
        }
        firstRetryError ??= error;
        await new Promise((resolve) => setTimeout(resolve, BULLDOZER_FETCH_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  })();

  if (!response.ok) {
    const responseText = await response.text();
    throw new HexclaveAssertionError("Bulldozer server request failed", {
      method: options.method,
      path: options.path,
      status: response.status,
      responseText,
    });
  }

  return await parseResponseJson<T>(response);
}

export type BulldozerManualTransactionsPage = {
  rows: ManualTransactionRow[],
  next_cursor: string | null,
};

/**
 * Pages Bulldozer GET /v1/manual-transactions (identifier-ordered derived view).
 * Cursor is the last `rowIdentifier` / sort key from the previous page (same as
 * `txnId` today via `rowIdField: "txnId"`).
 */
export async function fetchBulldozerManualTransactionsPage(options: {
  limit?: number,
  cursor?: string | null,
} = {}): Promise<BulldozerManualTransactionsPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor != null && options.cursor.length > 0) params.set("cursor", options.cursor);
  const query = params.toString();
  return await fetchBulldozerServerJson<BulldozerManualTransactionsPage>({
    method: "GET",
    path: query.length > 0 ? `/v1/manual-transactions?${query}` : "/v1/manual-transactions",
  });
}
