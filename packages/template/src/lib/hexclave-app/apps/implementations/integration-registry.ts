import type {
  CaptureExceptionOptions,
  ErrorBreadcrumb,
  ErrorEventId,
  ErrorLevel,
} from "../interfaces/error-capture";
import type { BrowserResourceErrorHandler } from "./browser-resource-errors";
import { truncateUtf8Bytes } from "./telemetry-core";

/**
 * Runtime-neutral equivalents of the Sentry integrations which are safe to
 * wire from a browser or server adapter. The registry owns ordering and
 * deduplication; adapters own the actual platform monkey-patching/event
 * subscription and return an exact cleanup function.
 */

export const ERROR_INTEGRATION_NAMES = [
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
  "node.process-errors",
] as const;

export type ErrorIntegrationName = typeof ERROR_INTEGRATION_NAMES[number];

/** An uninstall operation must remove exactly the hooks installed by one integration. */
export type ErrorIntegrationUninstall = () => void;

export type BrowserGlobalErrorSignal = {
  error?: unknown,
  message?: string,
  filename?: string,
  lineno?: number,
  colno?: number,
};

export type BrowserUnhandledRejectionSignal = {
  reason: unknown,
};

export const BROWSER_CONSOLE_LEVELS = ["debug", "info", "log", "warn", "error", "assert", "trace"] as const;
export type BrowserConsoleLevel = typeof BROWSER_CONSOLE_LEVELS[number];

export type BrowserConsoleBreadcrumbSignal = {
  level: BrowserConsoleLevel,
  args?: readonly unknown[],
  message?: string,
  timestamp?: number,
};

export type BrowserDomBreadcrumbSignal = {
  name: string,
  tagName?: string,
  componentName?: string,
  target?: string,
  timestamp?: number,
};

export type BrowserHistoryBreadcrumbSignal = {
  operation: "pushState" | "replaceState" | "popstate",
  from?: string,
  to?: string,
  timestamp?: number,
};

export type BrowserHttpBreadcrumbSignal = {
  method?: string,
  url?: string,
  statusCode?: number,
  durationMs?: number,
  error?: unknown,
  timestamp?: number,
};

export type BrowserGlobalErrorHandler = (signal: BrowserGlobalErrorSignal) => void;
export type BrowserUnhandledRejectionHandler = (signal: BrowserUnhandledRejectionSignal) => void;
export type BrowserConsoleBreadcrumbHandler = (signal: BrowserConsoleBreadcrumbSignal) => void;
export type BrowserDomBreadcrumbHandler = (signal: BrowserDomBreadcrumbSignal) => void;
export type BrowserHistoryBreadcrumbHandler = (signal: BrowserHistoryBreadcrumbSignal) => void;
export type BrowserHttpBreadcrumbHandler = (signal: BrowserHttpBreadcrumbSignal) => void;

export type BrowserErrorIntegrationRuntime = {
  onGlobalError?: (handler: BrowserGlobalErrorHandler) => ErrorIntegrationUninstall,
  onUnhandledRejection?: (handler: BrowserUnhandledRejectionHandler) => ErrorIntegrationUninstall,
  onConsole?: (handler: BrowserConsoleBreadcrumbHandler) => ErrorIntegrationUninstall,
  onDom?: (handler: BrowserDomBreadcrumbHandler) => ErrorIntegrationUninstall,
  onResourceError?: (handler: BrowserResourceErrorHandler) => ErrorIntegrationUninstall,
  onHistory?: (handler: BrowserHistoryBreadcrumbHandler) => ErrorIntegrationUninstall,
  onFetch?: (handler: BrowserHttpBreadcrumbHandler) => ErrorIntegrationUninstall,
  onXhr?: (handler: BrowserHttpBreadcrumbHandler) => ErrorIntegrationUninstall,
};

export type NodeRequestErrorSignal = {
  error: unknown,
  framework?: string,
  method?: string,
  path?: string,
  route?: string,
  statusCode?: number,
  handled?: boolean,
};

export type NodeLibraryErrorSignal = {
  error: unknown,
  library: string,
  operation?: string,
  handled?: boolean,
};

export type NodeRequestErrorHandler = (signal: NodeRequestErrorSignal) => void;
export type NodeLibraryErrorHandler = (signal: NodeLibraryErrorSignal) => void;

/**
 * Process hooks are observers by default. An adapter must preserve Node's
 * normal uncaught-exception/unhandled-rejection behavior unless a future,
 * explicitly opted-in shutdown integration replaces this contract.
 */
export type NodeProcessHookOptions = {
  preserveDefaultBehavior: true,
};

export type NodeProcessErrorIntegrationRuntime = {
  onUncaughtException?: (
    handler: (error: unknown) => void,
    options: NodeProcessHookOptions,
  ) => ErrorIntegrationUninstall,
  onUnhandledRejection?: (
    handler: (error: unknown) => void,
    options: NodeProcessHookOptions,
  ) => ErrorIntegrationUninstall,
};

export type NodeErrorIntegrationRuntime = NodeProcessErrorIntegrationRuntime & {
  onRequestError?: (handler: NodeRequestErrorHandler) => ErrorIntegrationUninstall,
  onLibraryError?: (handler: NodeLibraryErrorHandler) => ErrorIntegrationUninstall,
};

export type ErrorIntegrationRuntime = {
  captureException: (error: unknown, options?: CaptureExceptionOptions) => ErrorEventId,
  addBreadcrumb: (breadcrumb: ErrorBreadcrumb) => void,
  browser?: BrowserErrorIntegrationRuntime,
  node?: NodeErrorIntegrationRuntime,
};

export type ErrorIntegrationRegistryOptions = {
  enabled?: boolean,
  integrations?: Partial<Record<ErrorIntegrationName, boolean>>,
  maxBreadcrumbs?: number,
  maxBreadcrumbMessageBytes?: number,
  duplicateBreadcrumbWindowMs?: number,
  /** Structured console arguments are never copied; this controls only safe primitive text. */
  includeConsoleMessage?: boolean,
  /** DOM target HTML/text is private by default and is omitted unless explicitly enabled. */
  includeDomTarget?: boolean,
  /** Injectable monotonic clock for deterministic duplicate suppression tests. */
  now?: () => number,
};

export type ErrorIntegrationContext = {
  readonly runtime: ErrorIntegrationRuntime,
  readonly captureException: ErrorIntegrationRuntime["captureException"],
  readonly addBreadcrumb: (breadcrumb: ErrorBreadcrumb) => void,
  readonly options: NormalizedErrorIntegrationOptions,
};

export type ErrorIntegrationInstaller = (context: ErrorIntegrationContext) => ErrorIntegrationUninstall;

export type ErrorIntegrationDefinition = {
  readonly name: ErrorIntegrationName,
  readonly order: number,
  readonly isAvailable: (runtime: ErrorIntegrationRuntime) => boolean,
  readonly install: ErrorIntegrationInstaller,
};

export type ErrorIntegrationHandle = {
  readonly name: ErrorIntegrationName,
  readonly order: number,
  readonly active: boolean,
  readonly uninstall: ErrorIntegrationUninstall,
};

export const DEFAULT_ERROR_INTEGRATION_ORDER: readonly ErrorIntegrationName[] = ERROR_INTEGRATION_NAMES;

const DEFAULT_MAX_BREADCRUMBS = 100;
const DEFAULT_MAX_BREADCRUMB_MESSAGE_BYTES = 512;
const DEFAULT_DUPLICATE_BREADCRUMB_WINDOW_MS = 1_000;
const MAX_BREADCRUMB_SIGNATURES = 256;
const MAX_CONTEXT_TEXT_BYTES = 256;

export type NormalizedErrorIntegrationOptions = {
  readonly enabled: boolean,
  readonly integrations: Partial<Record<ErrorIntegrationName, boolean>>,
  readonly maxBreadcrumbs: number,
  readonly maxBreadcrumbMessageBytes: number,
  readonly duplicateBreadcrumbWindowMs: number,
  readonly includeConsoleMessage: boolean,
  readonly includeDomTarget: boolean,
  readonly now: () => number,
};

function defaultMonotonicNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function normalizeNonNegativeInteger(name: string, value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Hexclave ${name} must be a finite non-negative number`);
  return Math.floor(value);
}

function normalizeOptions(options: ErrorIntegrationRegistryOptions): NormalizedErrorIntegrationOptions {
  return {
    enabled: options.enabled !== false,
    integrations: { ...options.integrations },
    maxBreadcrumbs: normalizeNonNegativeInteger("integration maxBreadcrumbs", options.maxBreadcrumbs, DEFAULT_MAX_BREADCRUMBS),
    maxBreadcrumbMessageBytes: normalizeNonNegativeInteger(
      "integration maxBreadcrumbMessageBytes",
      options.maxBreadcrumbMessageBytes,
      DEFAULT_MAX_BREADCRUMB_MESSAGE_BYTES,
    ),
    duplicateBreadcrumbWindowMs: normalizeNonNegativeInteger(
      "integration duplicateBreadcrumbWindowMs",
      options.duplicateBreadcrumbWindowMs,
      DEFAULT_DUPLICATE_BREADCRUMB_WINDOW_MS,
    ),
    includeConsoleMessage: options.includeConsoleMessage === true,
    includeDomTarget: options.includeDomTarget === true,
    now: options.now ?? defaultMonotonicNow,
  };
}

function noOpUninstall(): void {
}

function installOptionalHook<Handler>(
  installer: ((handler: Handler) => ErrorIntegrationUninstall) | undefined,
  handler: Handler,
): ErrorIntegrationUninstall {
  return installer === undefined ? noOpUninstall : installer(handler);
}

function installHooks(installers: readonly (() => ErrorIntegrationUninstall)[]): ErrorIntegrationUninstall {
  const uninstalls: ErrorIntegrationUninstall[] = [];
  try {
    for (const install of installers) uninstalls.push(install());
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const uninstall of uninstalls.reverse()) {
      try {
        uninstall();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Hexclave error integration setup failed");
    throw error;
  }

  let uninstalled = false;
  return () => {
    if (uninstalled) return;
    uninstalled = true;
    const cleanupErrors: unknown[] = [];
    for (const uninstall of uninstalls.reverse()) {
      try {
        uninstall();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Hexclave error integration teardown failed");
  };
}

function safeText(value: string, maxBytes: number): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|cookie|password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "<redacted>")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf8Bytes(redacted, maxBytes);
}

function safeUrlPath(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined || value === "") return undefined;

  const normalized = value.replace(/^[\u0000-\u0020]+/u, "");
  const explicitScheme = /^([a-z][a-z\d+.-]*):/iu.exec(normalized)?.[1]?.toLowerCase();
  if (explicitScheme !== undefined && explicitScheme !== "http" && explicitScheme !== "https") {
    return truncateUtf8Bytes(`<${explicitScheme}-url>`, maxBytes);
  }

  try {
    const parsed = new URL(normalized, "https://hexclave.invalid");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return truncateUtf8Bytes(`<${parsed.protocol.slice(0, -1)}-url>`, maxBytes);
    }
    return truncateUtf8Bytes(parsed.pathname || "/", maxBytes);
  } catch {
    const queryStart = value.search(/[?#]/);
    return truncateUtf8Bytes(value.slice(0, queryStart === -1 ? value.length : queryStart), maxBytes);
  }
}

function safeFiniteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function safePositiveInteger(value: number | undefined): number | undefined {
  const finite = safeFiniteNumber(value);
  return finite === undefined || finite < 0 ? undefined : Math.floor(finite);
}

function safeMethod(value: string | undefined): string | undefined {
  return value === undefined ? undefined : safeText(value.toUpperCase(), 16);
}

function safeRoute(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = safeText(value, MAX_CONTEXT_TEXT_BYTES);
  const queryStart = sanitized.search(/[?#]/);
  return sanitized.slice(0, queryStart === -1 ? sanitized.length : queryStart);
}

function safeConsoleArgument(value: unknown, maxBytes: number): string | undefined {
  if (typeof value === "string") return safeText(value, maxBytes);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return "<symbol>";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return "<object>";
}

function safeConsoleMessage(signal: BrowserConsoleBreadcrumbSignal, options: NormalizedErrorIntegrationOptions): string | undefined {
  if (!options.includeConsoleMessage) return undefined;
  const directMessage = signal.message === undefined ? undefined : safeText(signal.message, options.maxBreadcrumbMessageBytes);
  if (directMessage !== undefined && directMessage !== "") return directMessage;
  if (signal.args === undefined) return undefined;
  const parts = signal.args
    .map((value) => safeConsoleArgument(value, options.maxBreadcrumbMessageBytes))
    .filter((value): value is string => value !== undefined && value !== "");
  if (parts.length === 0) return undefined;
  return safeText(parts.join(" "), options.maxBreadcrumbMessageBytes);
}

function consoleLevelToErrorLevel(level: BrowserConsoleLevel): ErrorLevel {
  switch (level) {
    case "debug": {
      return "debug";
    }
    case "info": {
      return "info";
    }
    case "warn": {
      return "warning";
    }
    case "error": {
      return "error";
    }
    case "assert": {
      return "warning";
    }
    case "trace": {
      return "debug";
    }
    case "log": {
      return "log";
    }
  }
}

function httpStatusToErrorLevel(statusCode: number | undefined, failed: boolean): ErrorLevel {
  if (failed || (statusCode !== undefined && statusCode >= 500)) return "error";
  if (statusCode !== undefined && statusCode >= 400) return "warning";
  return "info";
}

function breadcrumbTimestamp(timestamp: number | undefined): number | undefined {
  return safeFiniteNumber(timestamp);
}

function safeBreadcrumbCategory(value: string, fallback: string): string {
  const category = safeText(value, MAX_CONTEXT_TEXT_BYTES);
  return category === "" ? fallback : category;
}

function safeHttpBreadcrumb(
  category: "fetch" | "xhr",
  signal: BrowserHttpBreadcrumbSignal,
  options: NormalizedErrorIntegrationOptions,
): ErrorBreadcrumb {
  const data: Record<string, unknown> = {};
  const method = safeMethod(signal.method);
  const url = safeUrlPath(signal.url, options.maxBreadcrumbMessageBytes);
  const statusCode = safePositiveInteger(signal.statusCode);
  const durationMs = safePositiveInteger(signal.durationMs);
  if (method !== undefined && method !== "") data.method = method;
  if (url !== undefined && url !== "") data.url = url;
  if (statusCode !== undefined) data.status_code = statusCode;
  if (durationMs !== undefined) data.duration_ms = durationMs;
  return {
    category,
    level: httpStatusToErrorLevel(signal.statusCode, signal.error !== undefined),
    data,
    ...breadcrumbTimestamp(signal.timestamp) === undefined ? {} : { timestamp: breadcrumbTimestamp(signal.timestamp) },
  };
}

function readOwnDataProperty(value: object, key: string): { found: boolean, value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value };
}

/** Reads browser PromiseRejectionEvent/CustomEvent reasons without invoking hostile getters. */
export function getUnhandledRejectionReason(value: unknown): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;

  const reason = readOwnDataProperty(value, "reason");
  if (reason.found) return reason.value;

  const detail = readOwnDataProperty(value, "detail");
  if (!detail.found || ((typeof detail.value !== "object" || detail.value === null) && typeof detail.value !== "function")) {
    return value;
  }
  const nestedReason = readOwnDataProperty(detail.value, "reason");
  return nestedReason.found ? nestedReason.value : value;
}

function globalErrorSource(signal: BrowserGlobalErrorSignal): unknown {
  if (signal.error !== undefined) return signal.error;
  if (signal.message !== undefined && signal.message !== "") return signal.message;
  return new Error("Unknown browser global error");
}

function globalErrorOptions(signal: BrowserGlobalErrorSignal): CaptureExceptionOptions {
  const extra: Record<string, unknown> = {};
  const filename = safeUrlPath(signal.filename, MAX_CONTEXT_TEXT_BYTES);
  const lineno = safePositiveInteger(signal.lineno);
  const colno = safePositiveInteger(signal.colno);
  if (filename !== undefined) extra.filename = filename;
  if (lineno !== undefined) extra.lineno = lineno;
  if (colno !== undefined) extra.colno = colno;
  return {
    handled: false,
    level: "error",
    mechanism: "auto.browser.global_handlers.onerror",
    ...Object.keys(extra).length === 0 ? {} : { extra },
  };
}

function installBrowserGlobalErrors(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onGlobalError, signal => {
    context.captureException(globalErrorSource(signal), globalErrorOptions(signal));
  });
}

function installBrowserUnhandledRejections(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onUnhandledRejection, signal => {
    context.captureException(getUnhandledRejectionReason(signal.reason), {
      handled: false,
      level: "error",
      mechanism: "auto.browser.global_handlers.onunhandledrejection",
      extra: { unhandled_promise_rejection: true },
    });
  });
}

function installBrowserConsoleBreadcrumbs(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onConsole, signal => {
    const message = safeConsoleMessage(signal, context.options);
    context.addBreadcrumb({
      category: "console",
      level: consoleLevelToErrorLevel(signal.level),
      ...message === undefined ? {} : { message },
      ...breadcrumbTimestamp(signal.timestamp) === undefined ? {} : { timestamp: breadcrumbTimestamp(signal.timestamp) },
      data: { logger: "console" },
    });
  });
}

function installBrowserDomBreadcrumbs(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onDom, signal => {
    const data: Record<string, unknown> = {};
    const tagName = signal.tagName === undefined ? undefined : safeText(signal.tagName.toLowerCase(), 64);
    const componentName = signal.componentName === undefined ? undefined : safeText(signal.componentName, MAX_CONTEXT_TEXT_BYTES);
    if (tagName !== undefined && tagName !== "") data.tag = tagName;
    if (componentName !== undefined && componentName !== "") data.component = componentName;
    const target = context.options.includeDomTarget && signal.target !== undefined
      ? safeText(signal.target, context.options.maxBreadcrumbMessageBytes)
      : undefined;
    context.addBreadcrumb({
      category: `ui.${safeBreadcrumbCategory(signal.name, "event")}`,
      ...target === undefined || target === "" ? {} : { message: target },
      ...breadcrumbTimestamp(signal.timestamp) === undefined ? {} : { timestamp: breadcrumbTimestamp(signal.timestamp) },
      ...Object.keys(data).length === 0 ? {} : { data },
    });
  });
}

function installBrowserResourceErrors(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onResourceError, signal => {
    const url = truncateUtf8Bytes(signal.url, MAX_CONTEXT_TEXT_BYTES);
    const resource = {
      type: signal.resourceType,
      url,
    };
    context.addBreadcrumb({
      category: "resource",
      level: "error",
      data: {
        resource_type: signal.resourceType,
        url,
      },
    });
    const error = new Error(`Failed to load ${signal.resourceType} resource`);
    error.name = "ResourceLoadError";
    context.captureException(error, {
      handled: false,
      level: "error",
      mechanism: "auto.browser.resource_load",
      contexts: { resource },
    });
  });
}

function installBrowserHistoryBreadcrumbs(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onHistory, signal => {
    const from = safeUrlPath(signal.from, context.options.maxBreadcrumbMessageBytes);
    const to = safeUrlPath(signal.to, context.options.maxBreadcrumbMessageBytes);
    const data: { operation: typeof signal.operation, from?: string, to?: string } = { operation: signal.operation };
    if (from !== undefined) data.from = from;
    if (to !== undefined) data.to = to;
    context.addBreadcrumb({
      category: "navigation",
      ...to === undefined ? {} : { message: to },
      ...breadcrumbTimestamp(signal.timestamp) === undefined ? {} : { timestamp: breadcrumbTimestamp(signal.timestamp) },
      data,
    });
  });
}

function installBrowserFetchBreadcrumbs(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onFetch, signal => {
    context.addBreadcrumb(safeHttpBreadcrumb("fetch", signal, context.options));
  });
}

function installBrowserXhrBreadcrumbs(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const browser = context.runtime.browser;
  return installOptionalHook(browser?.onXhr, signal => {
    context.addBreadcrumb(safeHttpBreadcrumb("xhr", signal, context.options));
  });
}

function requestContext(signal: NodeRequestErrorSignal): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  const framework = signal.framework === undefined ? undefined : safeText(signal.framework, MAX_CONTEXT_TEXT_BYTES);
  const method = safeMethod(signal.method);
  const path = safeUrlPath(signal.path, MAX_CONTEXT_TEXT_BYTES);
  const route = safeRoute(signal.route);
  const statusCode = safePositiveInteger(signal.statusCode);
  if (framework !== undefined && framework !== "") request.framework = framework;
  if (method !== undefined && method !== "") request.method = method;
  if (path !== undefined && path !== "") request.path = path;
  if (route !== undefined && route !== "") request.route = route;
  if (statusCode !== undefined) request.status_code = statusCode;
  return request;
}

function installNodeRequestErrors(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const node = context.runtime.node;
  return installOptionalHook(node?.onRequestError, signal => {
    context.captureException(signal.error, {
      ...signal.handled === undefined ? {} : { handled: signal.handled },
      level: "error",
      mechanism: "auto.node.request",
      contexts: { request: requestContext(signal) },
    });
  });
}

function installNodeLibraryErrors(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const node = context.runtime.node;
  return installOptionalHook(node?.onLibraryError, signal => {
    const library = safeText(signal.library, MAX_CONTEXT_TEXT_BYTES);
    const operation = signal.operation === undefined ? undefined : safeText(signal.operation, MAX_CONTEXT_TEXT_BYTES);
    const libraryContext: Record<string, unknown> = {};
    if (library !== "") libraryContext.name = library;
    if (operation !== undefined && operation !== "") libraryContext.operation = operation;
    context.captureException(signal.error, {
      ...signal.handled === undefined ? {} : { handled: signal.handled },
      level: "error",
      mechanism: "auto.node.library",
      ...Object.keys(libraryContext).length === 0 ? {} : { contexts: { library: libraryContext } },
    });
  });
}

function installNodeProcessErrors(context: ErrorIntegrationContext): ErrorIntegrationUninstall {
  const node = context.runtime.node;
  const processOptions: NodeProcessHookOptions = { preserveDefaultBehavior: true };
  return installHooks([
    ...node?.onUncaughtException === undefined ? [] : [
      () => {
        const installer = node.onUncaughtException;
        if (installer === undefined) return noOpUninstall;
        return installer(error => {
          context.captureException(error, {
            handled: false,
            level: "fatal",
            mechanism: "auto.node.onuncaughtexception",
          });
        }, processOptions);
      },
    ],
    ...node?.onUnhandledRejection === undefined ? [] : [
      () => {
        const installer = node.onUnhandledRejection;
        if (installer === undefined) return noOpUninstall;
        return installer(error => {
          context.captureException(error, {
            handled: false,
            level: "error",
            mechanism: "auto.node.onunhandledrejection",
            extra: { unhandled_promise_rejection: true },
          });
        }, processOptions);
      },
    ],
  ]);
}

const DEFAULT_DEFINITIONS: readonly ErrorIntegrationDefinition[] = [
  {
    name: "browser.console-breadcrumbs",
    order: 10,
    isAvailable: (runtime) => runtime.browser?.onConsole !== undefined,
    install: installBrowserConsoleBreadcrumbs,
  },
  {
    name: "browser.dom-breadcrumbs",
    order: 20,
    isAvailable: (runtime) => runtime.browser?.onDom !== undefined,
    install: installBrowserDomBreadcrumbs,
  },
  {
    name: "browser.resource-errors",
    order: 25,
    isAvailable: (runtime) => runtime.browser?.onResourceError !== undefined,
    install: installBrowserResourceErrors,
  },
  {
    name: "browser.history-breadcrumbs",
    order: 30,
    isAvailable: (runtime) => runtime.browser?.onHistory !== undefined,
    install: installBrowserHistoryBreadcrumbs,
  },
  {
    name: "browser.fetch-breadcrumbs",
    order: 40,
    isAvailable: (runtime) => runtime.browser?.onFetch !== undefined,
    install: installBrowserFetchBreadcrumbs,
  },
  {
    name: "browser.xhr-breadcrumbs",
    order: 50,
    isAvailable: (runtime) => runtime.browser?.onXhr !== undefined,
    install: installBrowserXhrBreadcrumbs,
  },
  {
    name: "browser.global-errors",
    order: 60,
    isAvailable: (runtime) => runtime.browser?.onGlobalError !== undefined,
    install: installBrowserGlobalErrors,
  },
  {
    name: "browser.unhandled-rejections",
    order: 70,
    isAvailable: (runtime) => runtime.browser?.onUnhandledRejection !== undefined,
    install: installBrowserUnhandledRejections,
  },
  {
    name: "node.request-errors",
    order: 80,
    isAvailable: (runtime) => runtime.node?.onRequestError !== undefined,
    install: installNodeRequestErrors,
  },
  {
    name: "node.library-errors",
    order: 90,
    isAvailable: (runtime) => runtime.node?.onLibraryError !== undefined,
    install: installNodeLibraryErrors,
  },
  {
    name: "node.process-errors",
    order: 100,
    isAvailable: (runtime) => runtime.node?.onUncaughtException !== undefined || runtime.node?.onUnhandledRejection !== undefined,
    install: installNodeProcessErrors,
  },
];

export const DEFAULT_ERROR_INTEGRATIONS: readonly ErrorIntegrationDefinition[] = DEFAULT_DEFINITIONS;

class BreadcrumbGate {
  private _accepted = 0;
  private _lastSeen = new Map<string, number>();

  constructor(
    private readonly _sink: (breadcrumb: ErrorBreadcrumb) => void,
    private readonly _options: NormalizedErrorIntegrationOptions,
  ) {}

  add(breadcrumb: ErrorBreadcrumb): void {
    if (this._accepted >= this._options.maxBreadcrumbs) return;
    const timestamp = this._options.now();
    const signature = this._signature(breadcrumb);
    const previous = this._lastSeen.get(signature);
    if (previous !== undefined && timestamp >= previous && timestamp - previous < this._options.duplicateBreadcrumbWindowMs) return;
    this._lastSeen.delete(signature);
    this._lastSeen.set(signature, timestamp);
    while (this._lastSeen.size > MAX_BREADCRUMB_SIGNATURES) {
      const oldest = this._lastSeen.keys().next().value;
      if (oldest === undefined) break;
      this._lastSeen.delete(oldest);
    }
    this._sink(breadcrumb);
    this._accepted += 1;
  }

  private _signature(breadcrumb: ErrorBreadcrumb): string {
    const data = breadcrumb.data === undefined ? "" : JSON.stringify(breadcrumb.data);
    return [breadcrumb.category ?? "", breadcrumb.level ?? "", breadcrumb.message ?? "", data].join("\u0000");
  }
}

type SharedInstallation = {
  readonly definition: ErrorIntegrationDefinition,
  readonly uninstall: ErrorIntegrationUninstall,
  references: number,
};

const sharedInstallations = new WeakMap<ErrorIntegrationRuntime, Map<ErrorIntegrationName, SharedInstallation>>();

function throwUnknownIntegration(name: string): never {
  throw new Error(`Hexclave error integration is not registered: ${name}`);
}

function throwDuplicateDefinition(name: ErrorIntegrationName): never {
  throw new Error(`Hexclave error integration has duplicate definition: ${name}`);
}

function releaseSharedInstallation(runtime: ErrorIntegrationRuntime, handle: SharedInstallation, name: ErrorIntegrationName): void {
  handle.references -= 1;
  if (handle.references > 0) return;
  const map = sharedInstallations.get(runtime);
  if (map === undefined || map.get(name) !== handle) {
    throw new Error(`Hexclave error integration registry lost installation state for ${name}`);
  }
  map.delete(name);
  handle.uninstall();
}

export class ErrorIntegrationRegistry {
  private readonly _runtime: ErrorIntegrationRuntime;
  private readonly _options: NormalizedErrorIntegrationOptions;
  private readonly _definitions: Map<ErrorIntegrationName, ErrorIntegrationDefinition>;
  private readonly _context: ErrorIntegrationContext;
  private readonly _installed = new Map<ErrorIntegrationName, ErrorIntegrationHandle>();

  constructor(
    runtime: ErrorIntegrationRuntime,
    options: ErrorIntegrationRegistryOptions = {},
    definitions: readonly ErrorIntegrationDefinition[] = DEFAULT_ERROR_INTEGRATIONS,
  ) {
    this._runtime = runtime;
    this._options = normalizeOptions(options);
    this._definitions = new Map();
    for (const definition of definitions) {
      if (this._definitions.has(definition.name)) throwDuplicateDefinition(definition.name);
      this._definitions.set(definition.name, definition);
    }
    const breadcrumbGate = new BreadcrumbGate(runtime.addBreadcrumb, this._options);
    this._context = {
      runtime,
      captureException: runtime.captureException,
      addBreadcrumb: (breadcrumb) => breadcrumbGate.add(breadcrumb),
      options: this._options,
    };
  }

  installDefaults(): readonly ErrorIntegrationHandle[] {
    if (!this._options.enabled) return [];
    const handles: ErrorIntegrationHandle[] = [];
    try {
      for (const definition of [...this._definitions.values()].sort((left, right) => left.order - right.order)) {
        if (this._options.integrations[definition.name] === false) continue;
        if (!definition.isAvailable(this._runtime)) continue;
        handles.push(this.install(definition.name));
      }
      return handles;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const handle of handles.reverse()) {
        try {
          handle.uninstall();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Hexclave error integration defaults failed");
      throw error;
    }
  }

  install(name: ErrorIntegrationName): ErrorIntegrationHandle {
    const existing = this._installed.get(name);
    if (existing !== undefined) return existing;
    const definition = this._definitions.get(name);
    if (definition === undefined) return throwUnknownIntegration(name);

    if (!definition.isAvailable(this._runtime)) {
      const inactive = this._createHandle(name, definition.order, false, undefined);
      this._installed.set(name, inactive);
      return inactive;
    }

    let map = sharedInstallations.get(this._runtime);
    if (map === undefined) {
      map = new Map();
      sharedInstallations.set(this._runtime, map);
    }
    const existingShared = map.get(name);
    if (existingShared !== undefined) {
      if (existingShared.definition !== definition) throw new Error(`Hexclave error integration definition changed for ${name}`);
      existingShared.references += 1;
      const handle = this._createHandle(name, definition.order, true, existingShared);
      this._installed.set(name, handle);
      return handle;
    }

    const uninstall = definition.install(this._context);
    const shared: SharedInstallation = { definition, uninstall, references: 1 };
    map.set(name, shared);
    const handle = this._createHandle(name, definition.order, true, shared);
    this._installed.set(name, handle);
    return handle;
  }

  uninstall(name: ErrorIntegrationName): boolean {
    const handle = this._installed.get(name);
    if (handle === undefined) return false;
    handle.uninstall();
    return true;
  }

  uninstallAll(): void {
    const handles = [...this._installed.values()].sort((left, right) => right.order - left.order);
    const cleanupErrors: unknown[] = [];
    for (const handle of handles) {
      try {
        handle.uninstall();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Hexclave error integration teardown failed");
  }

  getInstalled(): readonly ErrorIntegrationHandle[] {
    return [...this._installed.values()].sort((left, right) => left.order - right.order);
  }

  private _createHandle(
    name: ErrorIntegrationName,
    order: number,
    active: boolean,
    shared: SharedInstallation | undefined,
  ): ErrorIntegrationHandle {
    let uninstalled = false;
    const handle: ErrorIntegrationHandle = {
      name,
      order,
      active,
      uninstall: () => {
        if (uninstalled) return;
        uninstalled = true;
        this._installed.delete(name);
        if (shared !== undefined) releaseSharedInstallation(this._runtime, shared, name);
      },
    };
    return handle;
  }
}

export function createDefaultErrorIntegrationRegistry(
  runtime: ErrorIntegrationRuntime,
  options?: ErrorIntegrationRegistryOptions,
): ErrorIntegrationRegistry {
  return new ErrorIntegrationRegistry(runtime, options);
}
