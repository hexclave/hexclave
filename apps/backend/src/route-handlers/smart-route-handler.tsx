import "../polyfills";

import { recordRequestStats } from "@/lib/dev-request-stats";
import { getInboundRequestHost } from "@/lib/request-api-url";
import { requestContextALS } from "@/lib/runtime/request-context";
import { isRequestBodyTooLargeError } from "@/server/request-body-limit";
import * as Sentry from "@sentry/node";
import { EndpointDocumentation } from "@hexclave/shared/dist/crud";
import { KnownError, KnownErrors } from "@hexclave/shared/dist/known-errors";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError, errorToNiceString } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { traceSpan } from "@hexclave/shared/dist/utils/telemetry";
import { setTimeout as waitForTimeout } from "node:timers/promises";
import * as yup from "yup";
import { DeepPartialSmartRequestWithSentinel, MergeSmartRequest, SmartRequest, createSmartRequest, validateSmartRequest } from "./smart-request";
import { SmartResponse, createResponse, validateSmartResponse } from "./smart-response";

class InternalServerError extends StatusError {
  constructor(error: unknown, requestId: string) {
    super(
      StatusError.InternalServerError,
      ["development", "test"].includes(getNodeEnvironment()) ? `Internal Server Error. The error message follows, but will be stripped in production. ${errorToNiceString(error)}` : `Something went wrong. Please make sure the data you entered is correct.\n\nRequest ID: ${requestId}`,
    );
  }
}

/**
 * Some errors that are common and should not be logged with their stacktrace.
 */
function isCommonError(error: unknown): boolean {
  return KnownError.isKnownError(error)
    || error instanceof InternalServerError
    || KnownErrors.AccessTokenExpired.isInstance(error)
    || KnownErrors.CannotGetOwnUserWithoutUser.isInstance(error);
}

/**
 * Catches the given error, logs it if needed and returns it as a StatusError. Errors that are not actually errors
 * (such as Next.js redirects) will be re-thrown.
 */
function catchError(error: unknown, requestId: string): StatusError {
  // catch some Next.js non-errors and rethrow them
  if (error instanceof Error) {
    const digest = getErrorDigest(error);
    if (typeof digest === "string") {
      if (["NEXT_REDIRECT", "DYNAMIC_SERVER_USAGE", "NEXT_NOT_FOUND"].some(m => digest.startsWith(m))) {
        throw error;
      }
    }
  }

  // srvx aborts the request body stream with ERR_BODY_TOO_LARGE once the ingress cap
  // (maxRequestBodySize) is exceeded, and smart routes buffer the body with req.arrayBuffer()
  // before validation, so the abort surfaces here as an unknown error. Without this mapping the
  // client would get a sanitized 500 and Sentry would be spammed for a purely client-caused
  // condition; map it to a proper 413 instead.
  if (isRequestBodyTooLargeError(error)) {
    return new StatusError(StatusError.PayloadTooLarge);
  }

  if (StatusError.isStatusError(error)) return error;

  captureError(`route-handler`, error);
  return new InternalServerError(error, requestId);
}

function getErrorDigest(error: unknown): string | undefined {
  if (error == null || typeof error !== "object" || !("digest" in error)) {
    return undefined;
  }
  return typeof error.digest === "string" ? error.digest : undefined;
}

/**
 * A unique identifier for the current process. This is used to correlate logs in serverless environments that allow
 * multiple concurrent requests to be handled by the same instance.
 */
const processId = generateSecureRandomString(80);
let concurrentRequestsInProcess = 0;

/**
 * Catches any errors thrown in the handler and returns a 500 response with the thrown error message. Also logs the
 * request details.
 */
export function handleApiRequest(handler: (req: Request, options: any, requestId: string) => Promise<Response>): (req: Request, options: any) => Promise<Response> {
  return async (req: Request, options: any) => {
    concurrentRequestsInProcess++;
    try {
      const requestId = generateSecureRandomString(80);
      const requestUrl = new URL(req.url);
      // The route pattern (not the concrete path — see RequestContext.normalizedPath for why).
      // Optional access because unit tests may invoke handlers outside the server dispatcher.
      const normalizedPath = requestContextALS.getStore()?.normalizedPath;
      const host = getInboundRequestHost(req);
      // Sentry's httpIntegration already forks an isolation scope per incoming request (which is
      // what keeps concurrent requests on Fluid Compute / Cloud Run from leaking context into each
      // other), so we only need to attach the request context to that scope — error events must be
      // correlatable with the x-stack-request-id a user reports. Never add auth headers, query
      // values, or the concrete request path here; the former routinely contain credentials and
      // path params can contain customer identifiers. The route pattern is safe (it's the same
      // shape as the http.route span attribute) and is what triage uses to locate the endpoint.
      // `host` is the inbound API hostname (api vs api2), not a customer identifier.
      if (host != null) {
        Sentry.getIsolationScope().setTag("host", host);
      }
      Sentry.getIsolationScope().setContext("stack-request", {
        requestId,
        method: req.method,
        ...(normalizedPath == null ? {} : { route: normalizedPath }),
        ...(host == null ? {} : { host }),
      });
      return await traceSpan({
        description: 'handling API request',
        attributes: {
          "stack.request.request-id": requestId,
          "stack.request.method": req.method,
          ...(host == null ? {} : { "stack.request.host": host }),
          "stack.process.id": processId,
          "stack.process.concurrent-requests": concurrentRequestsInProcess,
        },
      }, async (span) => {
        // Production uses the normalized structured request log. Detailed
        // request URLs and project identifiers are useful locally, but can
        // contain customer data and must not enter hosted runtime logs.
        const shouldLogExtendedRequestDetails = getNodeEnvironment() === "development";

        let hasRequestFinished = false;
        try {
          // request duration warning
          const allowedLongRequestPaths = [
            "/api/latest/internal/email-queue-step",
            "/api/latest/analytics/clickmap",
            "/api/latest/analytics/query",
            "/api/latest/internal/analytics/clickmap",
            "/api/latest/ai/query/stream",
            "/api/latest/ai/query/generate",
            "/health/email",
            "/api/latest/internal/metrics",
            "/api/latest/internal/external-db-sync/poller",
            "/api/latest/internal/external-db-sync/sequencer",
            "/api/latest/internal/external-db-sync/sync-engine",
            "/api/latest/internal/workflow-engine-step",
          ];
          // Prefix entries for routes with dynamic path segments (which exact
          // matching can't express): deploys upload many files to Vercel and
          // the run-log stream follows a build until it finishes.
          const allowedLongRequestPathPrefixes = [
            "/api/latest/deployments/",
          ];
          const allAllowedLongRequestPaths = [
            ...allowedLongRequestPaths,
            ...allowedLongRequestPaths.map(path => path.replace(/^\/api\/latest\//, "/api/v1/")),
          ];
          const allAllowedLongRequestPathPrefixes = [
            ...allowedLongRequestPathPrefixes,
            ...allowedLongRequestPathPrefixes.map(path => path.replace(/^\/api\/latest\//, "/api/v1/")),
          ];
          const warnAfterSeconds = allAllowedLongRequestPaths.includes(requestUrl.pathname) || allAllowedLongRequestPathPrefixes.some(prefix => requestUrl.pathname.startsWith(prefix)) ? 240 : 12;
          runAsynchronously(async () => {
            // This diagnostic timer must not keep a drained server process alive.
            await waitForTimeout(warnAfterSeconds * 1000, undefined, { ref: false });
            if (!hasRequestFinished) {
              captureError("request-timeout-watcher", new Error(`Request with ID ${requestId} using ${req.method} ${normalizedPath ?? "<unknown route>"} has been running for ${warnAfterSeconds} seconds. Try to keep requests short. The request may be cancelled by the serverless provider if it takes too long.`));
            }
          });

          if (shouldLogExtendedRequestDetails) console.log(`[API REQ] [${requestId} @ ${req.headers.get("x-stack-project-id") ?? "<none>"}] ${req.method} ${requestUrl}`);
          const timeStart = performance.now();
          const res = await handler(req, options, requestId);
          const time = (performance.now() - timeStart);

          // Record request stats for dev-stats page
          recordRequestStats(req.method, requestUrl.pathname, time);

          if ([301, 302].includes(res.status)) {
            throw new HexclaveAssertionError("HTTP status codes 301 and 302 should not be returned by our APIs because the behavior for non-GET methods is inconsistent across implementations. Use 303 (to rewrite method to GET) or 307/308 (to preserve the original method and data) instead.", { status: res.status, url: requestUrl, req, res });
          }
          if (shouldLogExtendedRequestDetails) console.log(`[    RES] [${requestId}] ${req.method} ${requestUrl}: ${res.status} (in ${time.toFixed(0)}ms)`);
          return res;
        } catch (e) {
          let statusError: StatusError;
          try {
            statusError = catchError(e, requestId);
          } catch (e) {
            if (shouldLogExtendedRequestDetails) console.log(`[    EXC] [${requestId}] ${req.method} ${requestUrl.pathname}: Non-error caught (such as a redirect), will be re-thrown. Digest: ${String(getErrorDigest(e))}`);
            throw e;
          }

          if (shouldLogExtendedRequestDetails) console.log(`[    ERR] [${requestId}] ${req.method} ${requestUrl.pathname}: ${statusError.message}`);

          if (!isCommonError(statusError)) {
            // HACK: Log a nicified version of the error instead of statusError to get around buggy Next.js pretty-printing
            // https://www.reddit.com/r/nextjs/comments/1gkxdqe/comment/m19kxgn/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button
            if (shouldLogExtendedRequestDetails) console.debug(`For the error above with request ID ${requestId}, the full error is:`, errorToNiceString(statusError));
          }

          const res = await createResponse(req, requestId, {
            statusCode: statusError.statusCode,
            bodyType: "binary",
            body: statusError.getBody(),
            headers: {
              ...statusError.getHeaders(),
            },
          });
          return res;
        } finally {
          hasRequestFinished = true;
        }
      });
    } finally {
      concurrentRequestsInProcess--;
    }
  };
};

export type SmartRouteHandlerOverloadMetadata = EndpointDocumentation;

export type SmartRouteHandlerOverload<
  Req extends DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse,
> = {
  metadata?: SmartRouteHandlerOverloadMetadata,
  request: yup.Schema<Req>,
  response: yup.Schema<Res>,
  handler: (req: MergeSmartRequest<Req>, fullReq: SmartRequest) => Promise<Res>,
};

export type SmartRouteHandlerOverloadGenerator<
  OverloadParam,
  Req extends DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse,
> = (param: OverloadParam) => SmartRouteHandlerOverload<Req, Res>;

export type SmartRouteHandler<
  OverloadParam = unknown,
  Req extends DeepPartialSmartRequestWithSentinel = DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse = SmartResponse,
  InitArgs extends [readonly OverloadParam[], SmartRouteHandlerOverloadGenerator<OverloadParam, Req, Res>] | [SmartRouteHandlerOverload<Req, Res>] = any,
> = ((req: Request, options: any) => Promise<Response>) & {
  overloads: Map<OverloadParam, SmartRouteHandlerOverload<Req, Res>>,
  invoke: (smartRequest: SmartRequest) => Promise<Res>,
  initArgs: InitArgs,
}

function getSmartRouteHandlerSymbol() {
  // Hexclave rebrand: file-private symbol key, renamed outright (no cross-version compat needed).
  return Symbol.for("hexclave-smartRouteHandler");
}

export function isSmartRouteHandler(handler: any): handler is SmartRouteHandler {
  return handler?.[getSmartRouteHandlerSymbol()] === true;
}

export function createSmartRouteHandler<
  Req extends DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse,
>(
  handler: SmartRouteHandlerOverload<Req, Res>,
): SmartRouteHandler<void, Req, Res, [typeof handler]>
export function createSmartRouteHandler<
  OverloadParam,
  Req extends DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse,
>(
  overloadParams: readonly OverloadParam[],
  overloadGenerator: SmartRouteHandlerOverloadGenerator<OverloadParam, Req, Res>
): SmartRouteHandler<OverloadParam, Req, Res, [typeof overloadParams, typeof overloadGenerator]>
export function createSmartRouteHandler<
  Req extends DeepPartialSmartRequestWithSentinel,
  Res extends SmartResponse,
>(
  ...args: [readonly unknown[], SmartRouteHandlerOverloadGenerator<unknown, Req, Res>] | [SmartRouteHandlerOverload<Req, Res>]
): SmartRouteHandler<unknown, Req, Res> {
  const overloadParams = args.length > 1 ? args[0] as unknown[] : [undefined];
  const overloadGenerator = args.length > 1 ? args[1]! : () => (args[0] as SmartRouteHandlerOverload<Req, Res>);

  const overloads = new Map(overloadParams.map((overloadParam) => [
    overloadParam,
    overloadGenerator(overloadParam),
  ]));
  if (overloads.size !== overloadParams.length) {
    throw new HexclaveAssertionError("Duplicate overload parameters");
  }

  const invoke = async (nextRequest: Request | null, requestId: string, smartRequest: SmartRequest) => {
    const reqsParsed: [[Req, SmartRequest], SmartRouteHandlerOverload<Req, Res>][] = [];
    const reqsErrors: unknown[] = [];
    for (const [overloadParam, overload] of overloads.entries()) {
      try {
        const parsedReq = await traceSpan("validating smart request", async () => {
          return await validateSmartRequest(nextRequest, smartRequest, overload.request);
        });
        reqsParsed.push([[parsedReq, smartRequest], overload]);
      } catch (e) {
        reqsErrors.push(e);
      }
    }
    if (reqsParsed.length === 0) {
      if (reqsErrors.length === 1) {
        throw reqsErrors[0];
      } else {
        const caughtErrors = reqsErrors.map(e => catchError(e, requestId));
        throw createOverloadsError(caughtErrors);
      }
    }

    const smartReq = reqsParsed[0][0][0];
    const fullReq = reqsParsed[0][0][1];
    const handler = reqsParsed[0][1];

    let smartRes = await traceSpan({
      description: 'calling smart route handler callback',
      attributes: {
        "stack.smart-request.access-type": fullReq.auth?.type ?? "<none>",
        "stack.smart-request.client-version.platform": fullReq.clientVersion?.platform ?? "<none>",
        "stack.smart-request.client-version.version": fullReq.clientVersion?.version ?? "<none>",
        "stack.smart-request.client-version.sdk": fullReq.clientVersion?.sdk ?? "<none>",
      },
    }, async () => {
      return await handler.handler(smartReq as any, fullReq);
    });

    return await traceSpan("validating smart response", async () => {
      return await validateSmartResponse(nextRequest, fullReq, smartRes, handler.response);
    });
  };

  return Object.assign(handleApiRequest(async (req, options, requestId) => {
    const bodyBuffer = await req.arrayBuffer();
    const smartRequest = await createSmartRequest(req, bodyBuffer, options);

    const smartRes = await invoke(req, requestId, smartRequest);

    return await createResponse(req, requestId, smartRes);
  }), {
    [getSmartRouteHandlerSymbol()]: true,
    invoke: (smartRequest: SmartRequest) => invoke(null, "custom-endpoint-invocation", smartRequest),
    overloads,
    initArgs: args,
  });
}

function createOverloadsError(errors: StatusError[]) {
  const merged = mergeOverloadErrors(errors);
  if (merged.length === 1) {
    return merged[0];
  }
  return new KnownErrors.AllOverloadsFailed(merged.map(e => e.toDescriptiveJson()));
}

const mergeErrorPriority = [
  // any other error is first, then errors get priority in the following order
  // if an error has priority over another, the latter will be hidden when listing failed overloads
  KnownErrors.InsufficientAccessType,
];

function mergeOverloadErrors(errors: StatusError[]): StatusError[] {
  if (errors.length > 6) {
    // TODO fix this
    throw new HexclaveAssertionError("Too many overloads failed, refusing to trying to merge them as it would be computationally expensive and could be used for a DoS attack. Fix this if we ever have an endpoint with > 8 overloads");
  } else if (errors.length === 0) {
    throw new HexclaveAssertionError("No errors to merge");
  } else if (errors.length === 1) {
    return [errors[0]];
  } else if (errors.length === 2) {
    for (const [a, b] of [errors, [...errors].reverse()]) {
      // Merge errors with the same JSON
      if (JSON.stringify(a.toDescriptiveJson()) === JSON.stringify(b.toDescriptiveJson())) {
        return [a];
      }

      // Merge "InsufficientAccessType" errors
      if (
        KnownErrors.InsufficientAccessType.isInstance(a)
        && KnownErrors.InsufficientAccessType.isInstance(b)
        && a.constructorArgs[0] === b.constructorArgs[0]
      ) {
        return [new KnownErrors.InsufficientAccessType(a.constructorArgs[0], [...new Set([...a.constructorArgs[1], ...b.constructorArgs[1]])])];
      }

      // Merge priority
      const aPriority = mergeErrorPriority.indexOf(a.constructor as any);
      const bPriority = mergeErrorPriority.indexOf(b.constructor as any);
      if (aPriority < bPriority) {
        return [a];
      }
    }
    return errors;
  } else {
    // brute-force all combinations recursively
    let fewestErrors: StatusError[] = errors;
    for (let i = 0; i < errors.length; i++) {
      const errorsWithoutCurrent = [...errors];
      errorsWithoutCurrent.splice(i, 1);
      const mergedWithoutCurrent = mergeOverloadErrors(errorsWithoutCurrent);
      if (mergedWithoutCurrent.length < errorsWithoutCurrent.length) {
        const merged = mergeOverloadErrors([errors[i], ...mergedWithoutCurrent]);
        if (merged.length < fewestErrors.length) {
          fewestErrors = merged;
        }
      }
    }
    return fewestErrors;
  }
}

/**
 * needed in the multi-overload smartRouteHandler for weird TypeScript reasons that I don't understand
 *
 * if you can remove this wherever it's used without causing type errors, it's safe to remove
 */
export function routeHandlerTypeHelper<Req extends DeepPartialSmartRequestWithSentinel, Res extends SmartResponse>(handler: {
  request: yup.Schema<Req>,
  response: yup.Schema<Res>,
  handler: (req: Req & MergeSmartRequest<Req>, fullReq: SmartRequest) => Promise<Res>,
}): {
  request: yup.Schema<Req>,
  response: yup.Schema<Res>,
  handler: (req: Req & MergeSmartRequest<Req>, fullReq: SmartRequest) => Promise<Res>,
} {
  return handler;
}
