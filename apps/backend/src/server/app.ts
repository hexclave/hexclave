import { httpMethodNames } from "@/generated/route-modules";
import { getInboundRequestHost } from "@/lib/request-api-url";
import { serializeSetCookie } from "@/lib/runtime/headers";
import { parseCookieHeader, requestContextALS, type RequestContext } from "@/lib/runtime/request-context";
import { node } from "@elysia/node";
import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { trace } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";
import { Elysia } from "elysia";
import { gunzipSync } from "node:zlib";
import { createBackendRequest } from "./backend-request";
import { compressResponse } from "./compression";
import { withVercelCronMonitor } from "./cron-monitor";
import { formatDevelopmentRequestLog } from "./dev-request-log";
import { handleUncaughtBackendError } from "./error-handler";
import { getCorsHeadersInit, runRequestPipeline } from "./middleware";
import { createRequestCompletionLog } from "./request-log";
import { MalformedRouteParamError, matchRoute, type RouteMethods } from "./registry";

const globalSecurityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "",
};
const knownHttpMethods = new Set<string>(httpMethodNames);
const requestStartTimes = new WeakMap<Request, number>();
const requestLogPaths = new WeakMap<Request, string>();
const staticRequestLogPaths = new Set([
  "/",
  "/dev-stats",
  "/health/error-handler-debug",
  "/health/error-handler-debug/endpoint",
]);
const shouldLogDevelopmentRequests = getNodeEnvironment() === "development";

export const app = new Elysia({
  adapter: node(),
})
  .onRequest(({ request }) => {
    requestStartTimes.set(request, performance.now());
    const pathname = new URL(request.url).pathname;
    const staticRequestPath = staticRequestLogPaths.has(pathname) ? pathname : undefined;
    requestLogPaths.set(request, staticRequestPath ?? "<unmatched>");
    // Attach host before route matching so uncaught 500s (which never reach
    // handleApiRequest) still tell us which public API hostname was hit.
    attachInboundRequestHostToSentry(request);
  })
  .mapResponse(({ request, responseValue }) => responseValue instanceof Response
    ? compressResponse(request, responseValue)
    : undefined)
  .onAfterResponse(({ request, response, set }) => {
    const startedAt = requestStartTimes.get(request);
    if (shouldLogDevelopmentRequests) {
      console.log(formatDevelopmentRequestLog({
        method: request.method,
        pathname: new URL(request.url).pathname,
        status: getLoggedResponseStatus(response, set.status),
        elapsedMilliseconds: startedAt == null ? null : performance.now() - startedAt,
      }));
      return;
    }

    const event = createRequestCompletionLog({
      request,
      response,
      fallbackStatus: set.status,
      startedAt,
      normalizedPath: requestLogPaths.get(request) ?? "<unknown>",
    });
    const serializedEvent = JSON.stringify(event);
    const status = typeof event.status === "number" ? event.status : Number(event.status);
    if (Number.isFinite(status) && status >= 500) {
      console.error(serializedEvent);
    } else {
      console.log(serializedEvent);
    }
  })
  .onError(({ error, request }) => withResponseHeaders(handleUncaughtBackendError(error), getCorsHeadersInit(request)))
  .get("/", () => htmlResponse(homeHtml()))
  .get("/dev-stats", () => getNodeEnvironment() === "development"
    ? htmlResponse(devStatsHtml())
    : htmlResponse("<div>404 Not Found</div>", 404))
  .get("/health/error-handler-debug", () => htmlResponse(errorHandlerDebugHtml()))
  .get("/health/error-handler-debug/endpoint", () => {
    throw new Error("Server observability debug error thrown successfully!");
  })
  .all("/*", async ({ request }) => await dispatch(request), {
    parse: "none",
  });

async function dispatch(request: Request) {
  const method = request.method.toUpperCase();
  const pipeline = await runRequestPipeline(request);
  if (pipeline.shortCircuitResponse != null) {
    return withResponseHeaders(pipeline.shortCircuitResponse, pipeline.corsHeadersInit);
  }

  let match;
  try {
    match = await matchRoute(pipeline.dispatchPath);
  } catch (error) {
    if (error instanceof MalformedRouteParamError) {
      return withResponseHeaders(new Response("Bad Request", { status: 400 }), pipeline.corsHeadersInit);
    }
    throw error;
  }
  if (match == null) {
    return withResponseHeaders(new Response("<div>404 Not Found</div>", {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    }), pipeline.corsHeadersInit);
  }
  requestLogPaths.set(request, match.normalizedPath);

  // Sentry's Node HTTP integration owns the incoming request span. Elysia is not
  // one of Sentry's framework integrations, so attach the matched route pattern
  // here instead of registering a second OpenTelemetry provider through Elysia's
  // plugin. The normalized path is safe; the concrete path may contain customer IDs.
  if (isHttpMethod(method)) {
    updateRequestSpanName(method, match.normalizedPath, getInboundRequestHost(request));
  }
  const context: RequestContext = {
    abortSignal: request.signal,
    headers: pipeline.mergedHeaders,
    incomingCookies: parseCookieHeader(pipeline.mergedHeaders.get("cookie")),
    pendingSetCookies: [],
    deletedCookies: [],
    normalizedPath: match.normalizedPath,
  };

  return await requestContextALS.run(context, async () => {
    const methods = match.methods;
    if (!isHttpMethod(method)) {
      // Next rejects extension methods before route-method dispatch. Treating them as
      // an ordinary missing handler changes its wire response from 400 to 405.
      return withResponseHeaders(new Response("Bad Request", { status: 400 }), pipeline.corsHeadersInit);
    }
    if (method === "OPTIONS" && !methods.has("OPTIONS")) {
      // API preflights short-circuit in runRequestPipeline. Other app routes use
      // Next's automatic OPTIONS response unless they export an explicit handler.
      return withResponseHeaders(createAutomaticOptionsResponse(methods), pipeline.corsHeadersInit);
    }
    const handler = methods.get(method) ?? (method === "HEAD" ? methods.get("GET") : undefined);
    if (handler == null) {
      return withResponseHeaders(createMethodNotAllowedResponse(methods), pipeline.corsHeadersInit);
    }

    const backendRequest = createBackendRequest(request, pipeline.mergedHeaders, pipeline.originalUrl);
    const response = await withVercelCronMonitor(request, match.normalizedPath, async () => {
      try {
        return await handler(backendRequest, {
          params: Promise.resolve(match.params),
        });
      } catch (error) {
        if (isRedirectError(error)) {
          return new Response(null, {
            status: error.redirectStatus,
            headers: {
              Location: error.redirectUrl,
            },
          });
        }
        throw error;
      }
    });

    await discardHeadResponseBody(method, response);
    const finalResponse = method === "HEAD" ? new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }) : response;

    for (const cookie of context.pendingSetCookies) {
      finalResponse.headers.append("Set-Cookie", serializeSetCookie(cookie.name, cookie.value, cookie.options));
    }
    for (const cookie of context.deletedCookies) {
      finalResponse.headers.append("Set-Cookie", serializeSetCookie(cookie.name, cookie.value, cookie.options));
    }
    return withResponseHeaders(finalResponse, pipeline.corsHeadersInit);
  });
}

function attachInboundRequestHostToSentry(request: Request) {
  const host = getInboundRequestHost(request);
  if (host == null) {
    return;
  }
  Sentry.getIsolationScope().setTag("host", host);
  Sentry.getIsolationScope().setContext("stack-request", { host });
  const requestSpan = trace.getActiveSpan();
  requestSpan?.setAttribute("stack.request.host", host);
}

function updateRequestSpanName(method: typeof httpMethodNames[number], normalizedPath: string, host: string | undefined) {
  const requestSpan = trace.getActiveSpan();
  if (requestSpan == null) {
    return;
  }
  // Raw OpenTelemetry updateName() can be overwritten when Sentry finalizes an
  // http.server span. This helper also marks the normalized, non-customer path as
  // an authoritative custom name so the beforeSend scrubber can retain it.
  Sentry.updateSpanName(requestSpan, `${method} ${normalizedPath}`);
  requestSpan.setAttribute("http.request.method", method);
  requestSpan.setAttribute("http.route", normalizedPath);
  if (host != null) {
    requestSpan.setAttribute("stack.request.host", host);
  }
}

async function discardHeadResponseBody(method: string, response: Response): Promise<void> {
  if (method === "HEAD" && response.body != null && !response.body.locked) {
    await Promise.allSettled([response.body.cancel()]);
  }
}

function getLoggedResponseStatus(response: unknown, fallbackStatus: number | string | undefined) {
  return response instanceof Response ? response.status : fallbackStatus;
}

function createMethodNotAllowedResponse(methods: RouteMethods) {
  const allowedMethods = httpMethodNames.filter((method) => methods.has(method)
    || (method === "HEAD" && methods.has("GET")));
  return new Response(null, {
    status: 405,
    headers: {
      Allow: allowedMethods.join(", "),
    },
  });
}

function createAutomaticOptionsResponse(methods: RouteMethods) {
  const allowedMethods = new Set<string>(["OPTIONS"]);
  for (const method of httpMethodNames) {
    if (methods.has(method)) {
      allowedMethods.add(method);
    }
  }
  if (methods.has("GET")) {
    allowedMethods.add("HEAD");
  }
  return new Response(null, {
    status: 204,
    headers: {
      // Next sorts the synthesized Allow value, yielding GET, HEAD, OPTIONS for
      // an ordinary GET route rather than the generator's route-method order.
      Allow: [...allowedMethods].sort().join(", "),
    },
  });
}

import.meta.vitest?.test("development logging uses the returned Response status", ({ expect }) => {
  expect(getLoggedResponseStatus(new Response(null, { status: 404 }), 200)).toBe(404);
  expect(getLoggedResponseStatus("response body", 201)).toBe(201);
});

import.meta.vitest?.test("the Elysia response mapper compresses direct Node responses", async ({ expect }) => {
  const response = await app.handle(new Request("http://localhost/", {
    headers: { "accept-encoding": "gzip" },
  }));

  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toContain("Welcome to Hexclave's API endpoint");
});

import.meta.vitest?.test("HEAD responses remain usable when their source body is locked", async ({ expect }) => {
  const response = new Response("body");
  const reader = response.body?.getReader();
  await expect(discardHeadResponseBody("HEAD", response)).resolves.toBeUndefined();
  await reader?.cancel();
});

function isRedirectError(error: unknown): error is { redirectStatus: 307 | 308, redirectUrl: string } {
  if (!(error instanceof Error) || !("digest" in error) || !("redirectUrl" in error) || !("redirectStatus" in error)) {
    return false;
  }
  return typeof error.digest === "string"
    && error.digest.startsWith("NEXT_REDIRECT")
    && typeof error.redirectUrl === "string"
    && (error.redirectStatus === 307 || error.redirectStatus === 308);
}

function withGlobalHeaders(response: Response) {
  for (const [key, value] of Object.entries(globalSecurityHeaders)) {
    response.headers.set(key, value);
  }
  // Next.js added `Cache-Control: no-store` to every dynamic response. Smart
  // responses still set their own default, but raw-Response routes (/health,
  // the dispatcher's 404/405/400, the HTML pages) would otherwise emit no
  // cache-control at all and intermediaries could cache them. Only set when
  // absent so routes that intentionally cache stay cacheable — which is also
  // why this is NOT part of globalSecurityHeaders: that object is stamped
  // unconditionally and would overwrite smart responses' own values.
  if (!response.headers.has("cache-control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

function withResponseHeaders(response: Response, corsHeadersInit?: HeadersInit) {
  if (corsHeadersInit != null) {
    for (const [key, value] of new Headers(corsHeadersInit)) {
      response.headers.set(key, value);
    }
  }
  return withGlobalHeaders(response);
}

function htmlResponse(body: string, status = 200) {
  return withGlobalHeaders(new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  }));
}

import.meta.vitest?.test("the observability debug page is publicly available", async ({ expect }) => {
  const response = await app.handle(new Request("http://localhost/health/error-handler-debug"));

  expect({
    status: response.status,
    body: await response.text(),
  }).toMatchObject({
    status: 200,
    body: expect.stringContaining("Backend error debug"),
  });
});

import.meta.vitest?.test("dispatcher-generated API errors retain CORS headers", async ({ expect }) => {
  const [notFound, methodNotAllowed, unknownMethod] = await Promise.all([
    app.handle(new Request("http://localhost/api/latest/this-route-does-not-exist")),
    app.handle(new Request("http://localhost/api/v2beta1/migration-tests/smart-route-handler", {
      method: "POST",
    })),
    app.handle(new Request("http://localhost/api/v2beta1/migration-tests/smart-route-handler", {
      method: "BREW",
    })),
  ]);

  expect([
    { status: notFound.status, allowOrigin: notFound.headers.get("access-control-allow-origin") },
    { status: methodNotAllowed.status, allow: methodNotAllowed.headers.get("allow"), allowOrigin: methodNotAllowed.headers.get("access-control-allow-origin") },
    { status: unknownMethod.status, allow: unknownMethod.headers.get("allow"), allowOrigin: unknownMethod.headers.get("access-control-allow-origin") },
  ]).toMatchInlineSnapshot(`
    [
      {
        "allowOrigin": "*",
        "status": 404,
      },
      {
        "allow": "GET, HEAD",
        "allowOrigin": "*",
        "status": 405,
      },
      {
        "allow": null,
        "allowOrigin": "*",
        "status": 400,
      },
    ]
  `);
});

import.meta.vitest?.test("non-API OPTIONS and unknown methods match Next while API OPTIONS keeps its CORS short-circuit", async ({ expect }) => {
  const [automaticOptions, unknownMethod, apiOptions] = await Promise.all([
    app.handle(new Request("http://localhost/health", { method: "OPTIONS" })),
    app.handle(new Request("http://localhost/health", { method: "BREW" })),
    app.handle(new Request("http://localhost/api/latest/health-does-not-need-to-exist", { method: "OPTIONS" })),
  ]);

  expect({
    automaticOptions: {
      status: automaticOptions.status,
      allow: automaticOptions.headers.get("allow"),
      allowOrigin: automaticOptions.headers.get("access-control-allow-origin"),
      body: await automaticOptions.text(),
    },
    unknownMethod: {
      status: unknownMethod.status,
      allow: unknownMethod.headers.get("allow"),
      body: await unknownMethod.text(),
    },
    apiOptions: {
      status: apiOptions.status,
      allow: apiOptions.headers.get("allow"),
      allowMethods: apiOptions.headers.get("access-control-allow-methods"),
      allowOrigin: apiOptions.headers.get("access-control-allow-origin"),
      body: await apiOptions.text(),
    },
  }).toMatchInlineSnapshot(`
    {
      "apiOptions": {
        "allow": null,
        "allowMethods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "allowOrigin": "*",
        "body": "",
        "status": 200,
      },
      "automaticOptions": {
        "allow": "GET, HEAD, OPTIONS",
        "allowOrigin": null,
        "body": "",
        "status": 204,
      },
      "unknownMethod": {
        "allow": null,
        "body": "Bad Request",
        "status": 400,
      },
    }
  `);
});

import.meta.vitest?.test("global headers add a default cache-control only when the route set none", async ({ expect }) => {
  const [homePage, smartResponse] = await Promise.all([
    // The home page is a raw Response with no cache-control of its own
    // (unlike /api 404s, which the smart NotFoundHandler catch-all serves),
    // so it must receive the default.
    app.handle(new Request("http://localhost/")),
    // Smart responses set their own cache-control; the default must not
    // overwrite it.
    app.handle(new Request("http://localhost/api/v2beta1/migration-tests/smart-route-handler")),
  ]);

  expect({
    homePageCacheControl: homePage.headers.get("cache-control"),
    smartResponseCacheControl: smartResponse.headers.get("cache-control"),
  }).toEqual({
    homePageCacheControl: "private, no-store",
    smartResponseCacheControl: "no-store, max-age=0",
  });
});

import.meta.vitest?.test("uncaught /api/ dispatch errors use the global sanitized error boundary", async ({ expect }) => {
  const { vi } = import.meta.vitest!;
  vi.stubEnv("NODE_ENV", "production");
  const request = new Request("http://localhost/api/v1");
  const originalHeaders = request.headers;
  let headersReadCount = 0;
  let headerReadThrew = false;
  // Simulate an unexpected internal failure escaping dispatch for an /api/ request.
  // This depends on runRequestPipeline reading headers first; after the first throw,
  // return them because response compression reads request headers after the error handler.
  Object.defineProperty(request, "headers", {
    get() {
      headersReadCount++;
      if (headersReadCount === 1) {
        headerReadThrew = true;
        throw new Error("unexpected request header access");
      }
      return originalHeaders;
    },
  });

  try {
    const response = await app.handle(request);

    expect(headerReadThrew).toBe(true);
    expect(headersReadCount).toBeGreaterThan(1);
    expect({
      status: response.status,
      body: await response.text(),
      accessControlAllowOrigin: response.headers.get("access-control-allow-origin"),
      contentType: response.headers.get("content-type"),
      contentTypeOptions: response.headers.get("x-content-type-options"),
    }).toMatchInlineSnapshot(`
      {
        "accessControlAllowOrigin": "*",
        "body": "Internal Server Error",
        "contentType": "text/plain; charset=utf-8",
        "contentTypeOptions": "nosniff",
        "status": 500,
      }
    `);
  } finally {
    vi.unstubAllEnvs();
  }
});

function homeHtml() {
  const devStatsLink = getNodeEnvironment() === "development"
    ? `<br><a href="/dev-stats">Dev Stats</a><br>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hexclave API</title>
  </head>
  <body>
    <div>
      Welcome to Hexclave's API endpoint.<br>
      <br>
      Were you looking for <a href="https://app.hexclave.com">Hexclave's dashboard</a> instead?<br>
      <br>
      You can also return to <a href="https://hexclave.com">https://hexclave.com</a>.<br>
      <br>
      <a href="/api/v1">API v1</a><br>
      ${devStatsLink}
    </div>
  </body>
</html>`;
}

function devStatsHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hexclave Backend Dev Stats</title>
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      * { box-sizing: border-box; }
      body { background: #0b0f14; color: #d7dee7; margin: 0 auto; max-width: 1600px; padding: 20px; }
      header, .controls { align-items: center; display: flex; gap: 10px; }
      header { justify-content: space-between; margin-bottom: 18px; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      h2 { color: #f1f5f9; font-size: 13px; letter-spacing: .08em; margin: 0 0 12px; text-transform: uppercase; }
      p, #status { color: #8491a3; font-size: 12px; margin: 0; }
      button { background: #17202b; border: 1px solid #334155; border-radius: 4px; color: inherit; cursor: pointer; font: inherit; padding: 6px 10px; }
      button:hover { background: #243142; }
      button:disabled { cursor: wait; opacity: .45; }
      section { background: #101720; border: 1px solid #263241; border-radius: 6px; margin-bottom: 14px; overflow: hidden; padding: 14px; }
      .summary { display: grid; gap: 8px; grid-template-columns: repeat(4, minmax(120px, 1fr)); }
      .metric { background: #0b1118; border: 1px solid #202b38; border-radius: 4px; padding: 10px; }
      .metric span { color: #8491a3; display: block; font-size: 11px; margin-bottom: 5px; }
      .metric strong { color: #7dd3fc; font-size: 17px; font-weight: 600; }
      .tables { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); }
      .table-wrap { overflow-x: auto; }
      table { border-collapse: collapse; font-size: 11px; width: 100%; }
      th { color: #8491a3; font-weight: 500; text-align: left; }
      th, td { border-bottom: 1px solid #202b38; padding: 6px 8px; white-space: nowrap; }
      th:not(:first-child), td:not(:first-child) { text-align: right; }
      td:first-child { color: #b9c5d4; }
      td.endpoint { max-width: 460px; overflow: hidden; text-align: left; text-overflow: ellipsis; }
      td.method { color: #7dd3fc; font-weight: 600; text-align: left; }
      #error { background: #35151b; border: 1px solid #7f1d1d; color: #fecaca; font-size: 12px; margin-bottom: 14px; padding: 9px; }
      @media (max-width: 760px) {
        body { padding: 12px; }
        header { align-items: flex-start; flex-direction: column; }
        .summary { grid-template-columns: repeat(2, 1fr); }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Backend dev stats</h1>
        <p>Process-local request and runtime telemetry.</p>
      </div>
      <div class="controls">
        <span id="status">Loading…</span>
        <button id="refresh" type="button">Refresh</button>
        <button id="clear" type="button">Clear</button>
      </div>
    </header>
    <div id="error" role="alert" hidden></div>
    <section>
      <h2>Request aggregate</h2>
      <div class="summary">
        <div class="metric"><span>Total requests</span><strong id="total-requests">—</strong></div>
        <div class="metric"><span>Unique endpoints</span><strong id="unique-endpoints">—</strong></div>
        <div class="metric"><span>Average time</span><strong id="average-time">—</strong></div>
        <div class="metric"><span>Total time</span><strong id="total-time">—</strong></div>
      </div>
    </section>
    <section>
      <h2>Performance</h2>
      <div class="tables">
        <div>
          <p>Current</p>
          <div class="table-wrap"><table><tbody id="performance-current"></tbody></table></div>
        </div>
        <div>
          <p>Aggregate · recent history</p>
          <div class="table-wrap"><table><tbody id="performance-aggregate"></tbody></table></div>
        </div>
      </div>
    </section>
    <div class="tables">
      <section>
        <h2>Most common requests</h2>
        <div class="table-wrap"><table><thead><tr><th>Method</th><th>Endpoint</th><th>Count</th><th>Total</th><th>Avg</th><th>Min</th><th>Max</th><th>Last</th></tr></thead><tbody id="most-common"></tbody></table></div>
      </section>
      <section>
        <h2>Most time-consuming requests</h2>
        <div class="table-wrap"><table><thead><tr><th>Method</th><th>Endpoint</th><th>Count</th><th>Total</th><th>Avg</th><th>Min</th><th>Max</th><th>Last</th></tr></thead><tbody id="most-time-consuming"></tbody></table></div>
      </section>
      <section>
        <h2>Slowest requests</h2>
        <div class="table-wrap"><table><thead><tr><th>Method</th><th>Endpoint</th><th>Count</th><th>Total</th><th>Avg</th><th>Min</th><th>Max</th><th>Last</th></tr></thead><tbody id="slowest"></tbody></table></div>
      </section>
    </div>
    <script>
      const refreshButton = document.getElementById("refresh");
      const clearButton = document.getElementById("clear");
      const statusElement = document.getElementById("status");
      const errorElement = document.getElementById("error");

      function formatNumber(value, digits) {
        return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
      }

      function formatDuration(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return "—";
        return value < 1000 ? formatNumber(value, value < 10 ? 2 : 0) + "ms" : formatNumber(value / 1000, 2) + "s";
      }

      function formatPercent(value) {
        return typeof value === "number" && Number.isFinite(value) ? formatNumber(value * 100, 1) + "%" : "—";
      }

      function setText(id, value) {
        document.getElementById(id).textContent = value;
      }

      function replaceMetricRows(id, rows) {
        const body = document.getElementById(id);
        body.replaceChildren();
        for (const row of rows) {
          const tableRow = document.createElement("tr");
          for (const value of row) {
            const cell = document.createElement("td");
            cell.textContent = value;
            tableRow.appendChild(cell);
          }
          body.appendChild(tableRow);
        }
      }

      function replaceRequestRows(id, rows) {
        const body = document.getElementById(id);
        body.replaceChildren();
        if (rows.length === 0) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 8;
          cell.textContent = "No requests recorded";
          row.appendChild(cell);
          body.appendChild(row);
          return;
        }
        for (const request of rows) {
          const average = request.count === 0 ? 0 : request.totalTimeMs / request.count;
          const values = [
            request.method,
            request.path,
            String(request.count),
            formatDuration(request.totalTimeMs),
            formatDuration(average),
            formatDuration(request.minTimeMs),
            formatDuration(request.maxTimeMs),
            new Date(request.lastCalledAt).toLocaleTimeString(),
          ];
          const row = document.createElement("tr");
          for (let index = 0; index < values.length; index++) {
            const cell = document.createElement("td");
            cell.textContent = values[index];
            if (index === 0) cell.className = "method";
            if (index === 1) {
              cell.className = "endpoint";
              cell.title = request.path;
            }
            row.appendChild(cell);
          }
          body.appendChild(row);
        }
      }

      function render(stats) {
        setText("total-requests", String(stats.aggregate.totalRequests));
        setText("unique-endpoints", String(stats.aggregate.uniqueEndpoints));
        setText("average-time", formatDuration(stats.aggregate.averageTimeMs));
        setText("total-time", formatDuration(stats.aggregate.totalTimeMs));

        const current = stats.perfCurrent;
        replaceMetricRows("performance-current", [
          ["Event loop utilization", formatPercent(current.eventLoopUtilization?.utilization)],
          ["Event loop delay p50 / p95 / p99", current.eventLoopDelay == null ? "—" : formatNumber(current.eventLoopDelay.p50Ms, 2) + " / " + formatNumber(current.eventLoopDelay.p95Ms, 2) + " / " + formatNumber(current.eventLoopDelay.p99Ms, 2) + " ms"],
          ["PG pool total / idle / waiting", current.pgPool == null ? "—" : current.pgPool.total + " / " + current.pgPool.idle + " / " + current.pgPool.waiting],
          ["Heap used / total", formatNumber(current.memory.heapUsedMB, 1) + " / " + formatNumber(current.memory.heapTotalMB, 1) + " MB"],
          ["RSS / external / buffers", formatNumber(current.memory.rssMB, 1) + " / " + formatNumber(current.memory.externalMB, 1) + " / " + formatNumber(current.memory.arrayBuffersMB, 1) + " MB"],
        ]);

        const aggregate = stats.perfAggregate;
        replaceMetricRows("performance-aggregate", [
          ["Event loop utilization avg / max", aggregate.eventLoopUtilization == null ? "—" : formatPercent(aggregate.eventLoopUtilization.avgUtilization) + " / " + formatPercent(aggregate.eventLoopUtilization.maxUtilization)],
          ["Event loop delay p50 avg", aggregate.eventLoopDelay == null ? "—" : formatNumber(aggregate.eventLoopDelay.avgP50Ms, 2) + " ms"],
          ["Event loop delay p99 avg / max", aggregate.eventLoopDelay == null ? "—" : formatNumber(aggregate.eventLoopDelay.avgP99Ms, 2) + " / " + formatNumber(aggregate.eventLoopDelay.maxP99Ms, 2) + " ms"],
          ["Heap used avg", formatNumber(aggregate.memory.avgHeapUsedMB, 1) + " MB"],
          ["RSS avg / max", formatNumber(aggregate.memory.avgRssMB, 1) + " / " + formatNumber(aggregate.memory.maxRssMB, 1) + " MB"],
          ["PG pool total avg / idle avg / max waiting", aggregate.pgPool == null ? "—" : formatNumber(aggregate.pgPool.avgTotal, 1) + " / " + formatNumber(aggregate.pgPool.avgIdle, 1) + " / " + aggregate.pgPool.maxWaiting],
        ]);

        replaceRequestRows("most-common", stats.mostCommon);
        replaceRequestRows("most-time-consuming", stats.mostTimeConsuming);
        replaceRequestRows("slowest", stats.slowest);
      }

      function setBusy(busy) {
        refreshButton.disabled = busy;
        clearButton.disabled = busy;
      }

      function showError(error) {
        errorElement.textContent = error instanceof Error ? error.message : String(error);
        errorElement.hidden = false;
        statusElement.textContent = "Failed";
      }

      async function refresh() {
        const response = await fetch("/dev-stats/api", { headers: { "accept": "application/json" } });
        if (!response.ok) {
          throw new Error("GET /dev-stats/api returned HTTP " + response.status);
        }
        render(await response.json());
        statusElement.textContent = "Updated " + new Date().toLocaleTimeString();
      }

      async function clear() {
        const response = await fetch("/dev-stats/api", { method: "DELETE" });
        if (!response.ok) {
          throw new Error("DELETE /dev-stats/api returned HTTP " + response.status);
        }
        await refresh();
      }

      function runAction(action) {
        setBusy(true);
        errorElement.hidden = true;
        action().then(
          () => setBusy(false),
          error => {
            setBusy(false);
            showError(error);
          },
        );
      }

      refreshButton.addEventListener("click", () => runAction(refresh));
      clearButton.addEventListener("click", () => runAction(clear));
      runAction(refresh);
    </script>
  </body>
</html>`;
}

function errorHandlerDebugHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Backend Error Debug</title>
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      body { background: #0b0f14; color: #d7dee7; margin: 24px; }
      button { background: #17202b; border: 1px solid #334155; border-radius: 4px; color: inherit; font: inherit; padding: 7px 10px; }
      button:disabled { opacity: .45; }
      p, output { color: #8491a3; display: block; font-size: 12px; margin: 8px 0 14px; }
    </style>
  </head>
  <body>
    <h1>Backend error debug</h1>
    <p>Triggers an instrumented server exception. Browser error capture is tested from the dashboard debug page.</p>
    <button id="server-error" type="button">Throw server error</button>
    <output id="result" aria-live="polite"></output>
    <script>
      const button = document.getElementById("server-error");
      const result = document.getElementById("result");
      button.addEventListener("click", () => {
        button.disabled = true;
        result.textContent = "Sending…";
        fetch("/health/error-handler-debug/endpoint").then(response => {
          result.textContent = "Server returned HTTP " + response.status + ". Check server observability.";
          button.disabled = false;
        }, error => {
          result.textContent = "Request failed before a response: " + (error instanceof Error ? error.message : String(error));
          button.disabled = false;
        });
      });
    </script>
  </body>
</html>`;
}

import.meta.vitest?.test("internal HTML keeps the dev controls useful and the backend error trigger server-only", ({ expect }) => {
  const statsHtml = devStatsHtml();
  expect(statsHtml).toContain(`id="performance-current"`);
  expect(statsHtml).toContain(`id="most-common"`);
  expect(statsHtml).toContain(`method: "DELETE"`);

  const debugHtml = errorHandlerDebugHtml();
  expect(debugHtml).toContain(`id="server-error"`);
  expect(debugHtml).toContain("dashboard debug page");
  expect(debugHtml).not.toContain(`id="client-error"`);
  expect(debugHtml).not.toContain("Client debug error");
});

function isHttpMethod(method: string): method is typeof httpMethodNames[number] {
  return knownHttpMethods.has(method);
}
