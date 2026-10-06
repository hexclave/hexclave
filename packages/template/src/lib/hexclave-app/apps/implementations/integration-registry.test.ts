import type { CaptureExceptionOptions, ErrorBreadcrumb } from "../interfaces/error-capture";
import { describe, expect, it } from "vitest";
import type { BrowserResourceErrorHandler } from "./browser-resource-errors";
import type {
  BrowserConsoleBreadcrumbHandler,
  BrowserDomBreadcrumbHandler,
  BrowserGlobalErrorHandler,
  BrowserHistoryBreadcrumbHandler,
  BrowserHttpBreadcrumbHandler,
  BrowserUnhandledRejectionHandler,
  ErrorIntegrationRuntime,
  ErrorIntegrationUninstall,
  NodeLibraryErrorHandler,
  NodeRequestErrorHandler,
} from "./integration-registry";
import {
  createDefaultErrorIntegrationRegistry,
  DEFAULT_ERROR_INTEGRATION_ORDER,
  ErrorIntegrationRegistry,
  getUnhandledRejectionReason,
} from "./integration-registry";

type Hook<T> = { handler: T, uninstall: ErrorIntegrationUninstall };

function makeRuntime() {
  const captures: Array<{ error: unknown, options: CaptureExceptionOptions | undefined }> = [];
  const breadcrumbs: ErrorBreadcrumb[] = [];
  const installs: string[] = [];
  const uninstalls: string[] = [];
  let globalError: Hook<BrowserGlobalErrorHandler> | undefined;
  let unhandledRejection: Hook<BrowserUnhandledRejectionHandler> | undefined;
  let consoleBreadcrumb: Hook<BrowserConsoleBreadcrumbHandler> | undefined;
  let domBreadcrumb: Hook<BrowserDomBreadcrumbHandler> | undefined;
  let resourceError: Hook<BrowserResourceErrorHandler> | undefined;
  let historyBreadcrumb: Hook<BrowserHistoryBreadcrumbHandler> | undefined;
  let fetchBreadcrumb: Hook<BrowserHttpBreadcrumbHandler> | undefined;
  let xhrBreadcrumb: Hook<BrowserHttpBreadcrumbHandler> | undefined;
  let requestError: Hook<NodeRequestErrorHandler> | undefined;
  let libraryError: Hook<NodeLibraryErrorHandler> | undefined;
  let uncaughtException: Hook<(error: unknown) => void> | undefined;
  let nodeUnhandledRejection: Hook<(error: unknown) => void> | undefined;

  function install<T>(name: string, _handler: T): ErrorIntegrationUninstall {
    installs.push(name);
    const uninstall: ErrorIntegrationUninstall = () => {
      uninstalls.push(name);
    };
    return uninstall;
  }

  const runtime: ErrorIntegrationRuntime = {
    captureException: (error, options) => {
      captures.push({ error, options });
      return "0123456789abcdef0123456789abcdef";
    },
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
    },
    browser: {
      onGlobalError: (handler) => {
        const uninstall = install("browser.global-errors", handler);
        globalError = { handler, uninstall };
        return uninstall;
      },
      onUnhandledRejection: (handler) => {
        const uninstall = install("browser.unhandled-rejections", handler);
        unhandledRejection = { handler, uninstall };
        return uninstall;
      },
      onConsole: (handler) => {
        const uninstall = install("browser.console-breadcrumbs", handler);
        consoleBreadcrumb = { handler, uninstall };
        return uninstall;
      },
      onDom: (handler) => {
        const uninstall = install("browser.dom-breadcrumbs", handler);
        domBreadcrumb = { handler, uninstall };
        return uninstall;
      },
      onResourceError: (handler) => {
        const uninstall = install("browser.resource-errors", handler);
        resourceError = { handler, uninstall };
        return uninstall;
      },
      onHistory: (handler) => {
        const uninstall = install("browser.history-breadcrumbs", handler);
        historyBreadcrumb = { handler, uninstall };
        return uninstall;
      },
      onFetch: (handler) => {
        const uninstall = install("browser.fetch-breadcrumbs", handler);
        fetchBreadcrumb = { handler, uninstall };
        return uninstall;
      },
      onXhr: (handler) => {
        const uninstall = install("browser.xhr-breadcrumbs", handler);
        xhrBreadcrumb = { handler, uninstall };
        return uninstall;
      },
    },
    node: {
      onRequestError: (handler) => {
        const uninstall = install("node.request-errors", handler);
        requestError = { handler, uninstall };
        return uninstall;
      },
      onLibraryError: (handler) => {
        const uninstall = install("node.library-errors", handler);
        libraryError = { handler, uninstall };
        return uninstall;
      },
      onUncaughtException: (handler) => {
        const uninstall = install("node.process-errors.uncaught", handler);
        uncaughtException = { handler, uninstall };
        return uninstall;
      },
      onUnhandledRejection: (handler) => {
        const uninstall = install("node.process-errors.unhandled", handler);
        nodeUnhandledRejection = { handler, uninstall };
        return uninstall;
      },
    },
  };

  return {
    runtime,
    captures,
    breadcrumbs,
    installs,
    uninstalls,
    get globalError() { return globalError; },
    get unhandledRejection() { return unhandledRejection; },
    get consoleBreadcrumb() { return consoleBreadcrumb; },
    get domBreadcrumb() { return domBreadcrumb; },
    get resourceError() { return resourceError; },
    get historyBreadcrumb() { return historyBreadcrumb; },
    get fetchBreadcrumb() { return fetchBreadcrumb; },
    get xhrBreadcrumb() { return xhrBreadcrumb; },
    get requestError() { return requestError; },
    get libraryError() { return libraryError; },
    get uncaughtException() { return uncaughtException; },
    get nodeUnhandledRejection() { return nodeUnhandledRejection; },
  };
}

describe("error integration registry", () => {
  it("installs the Sentry-shaped defaults in deterministic order and tears them down in reverse", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);

    const handles = registry.installDefaults();

    expect(handles.map((handle) => handle.name)).toEqual(DEFAULT_ERROR_INTEGRATION_ORDER);
    expect(handles.every((handle) => handle.active)).toBe(true);
    expect(fixture.installs).toEqual([
      "browser.console-breadcrumbs",
      "browser.dom-breadcrumbs",
      "browser.resource-errors",
      "browser.history-breadcrumbs",
      "browser.fetch-breadcrumbs",
      "browser.xhr-breadcrumbs",
      "browser.global-errors",
      "browser.unhandled-rejections",
      "node.request-errors",
      "node.library-errors",
      "node.process-errors.uncaught",
      "node.process-errors.unhandled",
    ]);

    registry.uninstallAll();

    expect(fixture.uninstalls).toEqual([
      "node.process-errors.unhandled",
      "node.process-errors.uncaught",
      "node.library-errors",
      "node.request-errors",
      "browser.unhandled-rejections",
      "browser.global-errors",
      "browser.xhr-breadcrumbs",
      "browser.fetch-breadcrumbs",
      "browser.history-breadcrumbs",
      "browser.resource-errors",
      "browser.dom-breadcrumbs",
      "browser.console-breadcrumbs",
    ]);
  });

  it("is idempotent within and across registries, and does not duplicate platform hooks", () => {
    const fixture = makeRuntime();
    const first = new ErrorIntegrationRegistry(fixture.runtime);
    const second = new ErrorIntegrationRegistry(fixture.runtime);

    const firstHandle = first.install("browser.console-breadcrumbs");
    expect(first.install("browser.console-breadcrumbs")).toBe(firstHandle);
    const secondHandle = second.install("browser.console-breadcrumbs");
    expect(secondHandle).not.toBe(firstHandle);
    expect(fixture.installs).toEqual(["browser.console-breadcrumbs"]);

    firstHandle.uninstall();
    expect(fixture.uninstalls).toEqual([]);
    secondHandle.uninstall();
    expect(fixture.uninstalls).toEqual(["browser.console-breadcrumbs"]);

    firstHandle.uninstall();
    secondHandle.uninstall();
    expect(fixture.uninstalls).toEqual(["browser.console-breadcrumbs"]);
  });

  it("honors disabled defaults without installing platform hooks", () => {
    const disabledFixture = makeRuntime();
    const disabled = createDefaultErrorIntegrationRegistry(disabledFixture.runtime, { enabled: false });
    expect(disabled.installDefaults()).toEqual([]);
    expect(disabledFixture.installs).toEqual([]);

    const integrationFixture = makeRuntime();
    const consoleDisabled = createDefaultErrorIntegrationRegistry(integrationFixture.runtime, {
      integrations: { "browser.console-breadcrumbs": false },
    });
    const handles = consoleDisabled.installDefaults();
    expect(handles.map((handle) => handle.name)).not.toContain("browser.console-breadcrumbs");
    expect(integrationFixture.installs).not.toContain("browser.console-breadcrumbs");
    consoleDisabled.uninstallAll();
  });

  it("captures browser globals with handled=false and strips URL query data", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);
    registry.install("browser.global-errors");
    registry.install("browser.unhandled-rejections");

    const error = new Error("render failed");
    fixture.globalError?.handler({
      error,
      filename: "https://app.example.test/assets/app.js?token=secret#source",
      lineno: 4,
      colno: 8,
    });
    fixture.unhandledRejection?.handler({ reason: { reason: error } });

    expect(fixture.captures).toEqual([
      {
        error,
        options: {
          handled: false,
          level: "error",
          mechanism: "auto.browser.global_handlers.onerror",
          extra: { filename: "/assets/app.js", lineno: 4, colno: 8 },
        },
      },
      {
        error,
        options: {
          handled: false,
          level: "error",
          mechanism: "auto.browser.global_handlers.onunhandledrejection",
          extra: { unhandled_promise_rejection: true },
        },
      },
    ]);
  });

  it("captures resource failures with bounded context and breadcrumb metadata", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);
    registry.install("browser.resource-errors");

    fixture.resourceError?.handler({ resourceType: "script", url: "/assets/app.js" });

    expect(fixture.breadcrumbs).toEqual([{
      category: "resource",
      level: "error",
      data: { resource_type: "script", url: "/assets/app.js" },
    }]);
    expect(fixture.captures).toHaveLength(1);
    expect(fixture.captures[0]).toMatchObject({
      error: expect.objectContaining({ name: "ResourceLoadError", message: "Failed to load script resource" }),
      options: {
        handled: false,
        level: "error",
        mechanism: "auto.browser.resource_load",
        contexts: { resource: { type: "script", url: "/assets/app.js" } },
      },
    });
  });

  it("turns browser activity into bounded, deduplicated, metadata-only breadcrumbs", () => {
    const fixture = makeRuntime();
    let now = 100;
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime, {
      now: () => now,
      maxBreadcrumbs: 3,
      maxBreadcrumbMessageBytes: 40,
      duplicateBreadcrumbWindowMs: 10,
      includeConsoleMessage: true,
    });
    registry.installDefaults();

    fixture.consoleBreadcrumb?.handler({ level: "error", args: ["token=secret", { password: "private" }] });
    fixture.consoleBreadcrumb?.handler({ level: "error", args: ["token=secret", { password: "private" }] });
    now += 11;
    fixture.domBreadcrumb?.handler({ name: "click", tagName: "BUTTON", target: "<button>private text</button>" });
    fixture.historyBreadcrumb?.handler({
      operation: "pushState",
      from: "/before?secret=one",
      to: "/after?secret=two",
    });
    fixture.fetchBreadcrumb?.handler({ method: "post", url: "https://api.example.test/pay?card=secret", statusCode: 500 });

    expect(fixture.breadcrumbs).toEqual([
      {
        category: "console",
        level: "error",
        message: "token=<redacted> <object>",
        data: { logger: "console" },
      },
      {
        category: "ui.click",
        data: { tag: "button" },
      },
      {
        category: "navigation",
        message: "/after",
        data: { operation: "pushState", from: "/before", to: "/after" },
      },
    ]);
  });

  it("omits console text and DOM target data under the safe default", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);
    registry.install("browser.console-breadcrumbs");
    registry.install("browser.dom-breadcrumbs");

    fixture.consoleBreadcrumb?.handler({ level: "error", message: "customer email is private@example.test" });
    fixture.domBreadcrumb?.handler({ name: "click", target: "<button>private text</button>" });

    expect(fixture.breadcrumbs).toEqual([
      { category: "console", level: "error", data: { logger: "console" } },
      { category: "ui.click" },
    ]);
  });

  it("keeps DOM target opt-in and preserves only safe HTTP metadata", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime, { includeDomTarget: true });
    registry.install("browser.dom-breadcrumbs");
    registry.install("browser.xhr-breadcrumbs");

    fixture.domBreadcrumb?.handler({ name: "input", target: "<input value='private'>" });
    fixture.xhrBreadcrumb?.handler({
      method: "get",
      url: "/users?email=private",
      statusCode: 404,
      durationMs: 12.8,
      error: new Error("not found"),
    });

    expect(fixture.breadcrumbs).toEqual([
      {
        category: "ui.input",
        message: "<input value='private'>",
      },
      {
        category: "xhr",
        level: "error",
        data: { method: "GET", url: "/users", status_code: 404, duration_ms: 12 },
      },
    ]);
  });

  it("collapses non-HTTP(S) URLs to scheme markers instead of leaking their payloads", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);
    registry.install("browser.xhr-breadcrumbs");

    fixture.xhrBreadcrumb?.handler({ method: "get", url: "data:text/plain;base64,c2VjcmV0", statusCode: 200 });
    fixture.xhrBreadcrumb?.handler({ method: "post", url: "DATA:text/plain,secret", statusCode: 201 });
    fixture.xhrBreadcrumb?.handler({ method: "put", url: "blob:https://private.example.test/some-uuid", statusCode: 202 });
    fixture.xhrBreadcrumb?.handler({ method: "patch", url: "file:///Users/private/secret.txt", statusCode: 203 });
    fixture.xhrBreadcrumb?.handler({ method: "delete", url: "file://[private/secret", statusCode: 204 });
    fixture.xhrBreadcrumb?.handler({ method: "head", url: "\u0000data:text/plain,secret", statusCode: 205 });
    fixture.xhrBreadcrumb?.handler({ method: "options", url: "  javascript:alert(secret)", statusCode: 206 });

    expect(fixture.breadcrumbs).toEqual([
      { category: "xhr", level: "info", data: { method: "GET", url: "<data-url>", status_code: 200 } },
      { category: "xhr", level: "info", data: { method: "POST", url: "<data-url>", status_code: 201 } },
      { category: "xhr", level: "info", data: { method: "PUT", url: "<blob-url>", status_code: 202 } },
      { category: "xhr", level: "info", data: { method: "PATCH", url: "<file-url>", status_code: 203 } },
      { category: "xhr", level: "info", data: { method: "DELETE", url: "<file-url>", status_code: 204 } },
      { category: "xhr", level: "info", data: { method: "HEAD", url: "<data-url>", status_code: 205 } },
      { category: "xhr", level: "info", data: { method: "OPTIONS", url: "<javascript-url>", status_code: 206 } },
    ]);
  });

  it("captures Node process, request, and library failures without changing process semantics", () => {
    const fixture = makeRuntime();
    const registry = createDefaultErrorIntegrationRegistry(fixture.runtime);
    registry.installDefaults();

    fixture.uncaughtException?.handler(new Error("fatal"));
    fixture.nodeUnhandledRejection?.handler("rejected");
    fixture.requestError?.handler({
      error: new Error("request failed"),
      framework: "next",
      method: "post",
      path: "/api/pay?token=secret",
      route: "/api/pay",
      statusCode: 500,
      handled: false,
    });
    fixture.libraryError?.handler({ error: new Error("query failed"), library: "pg", operation: "query" });

    expect(fixture.captures).toEqual([
      {
        error: expect.any(Error),
        options: { handled: false, level: "fatal", mechanism: "auto.node.onuncaughtexception" },
      },
      {
        error: "rejected",
        options: {
          handled: false,
          level: "error",
          mechanism: "auto.node.onunhandledrejection",
          extra: { unhandled_promise_rejection: true },
        },
      },
      {
        error: expect.any(Error),
        options: {
          handled: false,
          level: "error",
          mechanism: "auto.node.request",
          contexts: { request: {
            framework: "next",
            method: "POST",
            path: "/api/pay",
            route: "/api/pay",
            status_code: 500,
          } },
        },
      },
      {
        error: expect.any(Error),
        options: {
          level: "error",
          mechanism: "auto.node.library",
          contexts: { library: { name: "pg", operation: "query" } },
        },
      },
    ]);
  });

  it("passes observer-only process options and safely no-ops unavailable defaults", () => {
    const processOptions: Array<{ preserveDefaultBehavior: true }> = [];
    const runtime: ErrorIntegrationRuntime = {
      captureException: () => "0123456789abcdef0123456789abcdef",
      addBreadcrumb: () => undefined,
      node: {
        onUncaughtException: (_handler, options) => {
          processOptions.push(options);
          return () => undefined;
        },
      },
    };
    const registry = createDefaultErrorIntegrationRegistry(runtime);
    const handles = registry.installDefaults();

    expect(handles.filter((handle) => handle.active).map((handle) => handle.name)).toEqual(["node.process-errors"]);
    expect(processOptions).toEqual([{ preserveDefaultBehavior: true }]);
    registry.uninstall("browser.console-breadcrumbs");
    expect(registry.uninstall("browser.console-breadcrumbs")).toBe(false);
  });

  it("extracts rejection reasons without invoking accessors", () => {
    const error = new Error("reason");
    const event = Object.create({ reason: error });
    expect(getUnhandledRejectionReason(event)).toBe(event);
    expect(getUnhandledRejectionReason({ detail: { reason: error } })).toBe(error);
    expect(getUnhandledRejectionReason(error)).toBe(error);
  });
});
