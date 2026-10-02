import type { NetworkCaptureConfig } from "./network-capture";
import { shouldCaptureNetworkRequest } from "./network-capture";
import { truncateUtf8Bytes } from "./telemetry-core";

/** Browser resource kinds which can report a load error on an element. */
export const BROWSER_RESOURCE_ERROR_TYPES = ["script", "style", "image", "link"] as const;
export type BrowserResourceErrorType = typeof BROWSER_RESOURCE_ERROR_TYPES[number];

/** The privacy-safe signal handed from the DOM adapter to the error registry. */
export type BrowserResourceErrorSignal = {
  resourceType: BrowserResourceErrorType,
  /** Path-only or a fixed non-HTTP placeholder; never an origin/query/fragment. */
  url: string,
};

export type BrowserResourceErrorHandler = (signal: BrowserResourceErrorSignal) => void;
export type BrowserResourceErrorUninstall = () => void;

export type BrowserResourceErrorCaptureOptions = {
  networkCapture: NetworkCaptureConfig,
  /** Injectable only for tests; production uses the current page URL. */
  baseUrl?: string,
};

const MAX_RESOURCE_URL_BYTES = 256;

/**
 * Installs one capture-phase listener because resource-load `error` events do
 * not use `window.onerror`. Runtime errors still reach the existing global
 * handler; this listener only accepts known resource elements and therefore
 * cannot double-capture ordinary script exceptions.
 */
export function installBrowserResourceErrorCapture(
  handler: BrowserResourceErrorHandler,
  options: BrowserResourceErrorCaptureOptions,
): BrowserResourceErrorUninstall {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => undefined;

  const listener = (event: Event): void => {
    const signal = getBrowserResourceErrorSignal(event, options);
    if (signal !== null) handler(signal);
  };
  window.addEventListener("error", listener, true);
  return () => window.removeEventListener("error", listener, true);
}

/**
 * Converts a resource error event into a bounded signal after applying the
 * existing network allow/deny/ignore policy to the original resolved URL.
 * Filtering before normalization keeps exact `ignoreUrls` behavior, including
 * rules that intentionally match a query string, while the emitted value is
 * still path-only.
 */
export function getBrowserResourceErrorSignal(
  event: Event,
  options: BrowserResourceErrorCaptureOptions,
): BrowserResourceErrorSignal | null {
  const element = getElementTarget(event.target);
  if (element === null) return null;

  const resource = getResourceDescriptor(element);
  if (resource === null) return null;

  const baseUrl = options.baseUrl ?? (typeof window === "undefined" ? "https://hexclave.invalid/" : window.location.href);
  const resolvedUrl = resolveResourceUrl(resource.rawUrl, baseUrl);
  if (resolvedUrl === null || !shouldCaptureNetworkRequest(options.networkCapture, resolvedUrl)) return null;

  const safeUrl = normalizeBrowserResourceUrl(resolvedUrl);
  if (safeUrl === null) return null;
  return { resourceType: resource.resourceType, url: safeUrl };
}

/**
 * Keeps only the path for HTTP(S) resources. Other schemes get a fixed marker
 * so data/blob/file URLs cannot carry payloads or local filesystem paths into
 * an error event.
 */
export function normalizeBrowserResourceUrl(value: URL | string): string | null {
  const parsed = typeof value === "string" ? resolveResourceUrl(value, "https://hexclave.invalid/") : value;
  if (parsed === null) return null;

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return truncateUtf8Bytes(parsed.pathname || "/", MAX_RESOURCE_URL_BYTES);
  }
  if (parsed.protocol === "data:") return "<data-url>";
  if (parsed.protocol === "blob:") return "<blob-url>";
  return "<non-http-url>";
}

function getElementTarget(target: EventTarget | null): Element | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) return null;
  return target;
}

function getResourceDescriptor(element: Element): { resourceType: BrowserResourceErrorType, rawUrl: string } | null {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "script") {
    return resourceFromAttribute(element, "script", "src");
  }
  if (tagName === "img") {
    const currentSrc = element instanceof HTMLImageElement ? element.currentSrc : "";
    const rawUrl = currentSrc || element.getAttribute("src") || "";
    return rawUrl.trim() === "" ? null : { resourceType: "image", rawUrl };
  }
  if (tagName === "link") {
    const rel = element.getAttribute("rel")?.toLowerCase().split(/\s+/u) ?? [];
    return resourceFromAttribute(element, rel.includes("stylesheet") ? "style" : "link", "href");
  }
  return null;
}

function resourceFromAttribute(
  element: Element,
  resourceType: BrowserResourceErrorType,
  attribute: "src" | "href",
): { resourceType: BrowserResourceErrorType, rawUrl: string } | null {
  const rawUrl = element.getAttribute(attribute);
  return rawUrl === null || rawUrl.trim() === "" ? null : { resourceType, rawUrl };
}

function resolveResourceUrl(value: string, baseUrl: string): URL | null {
  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}
