import type { SandboxSession } from "eve/sandbox";
import {
  isBrowserRuntimeUnavailableError,
  renderPageInBrowser,
  type BrowserPageResult,
  type BrowserSessionContext,
} from "#lib/browser-session.ts";

/**
 * Renders a page with the browser installed in the website-research
 * subagent's own Eve sandbox. Every page in one research phase therefore
 * shares one isolated browser process, while different phases still receive
 * different durable child sessions and sandboxes.
 */
const CURL_FALLBACK_BODY_BYTE_CAP = 2_000_000;
const SNAPSHOT_CHAR_CAP = 20_000;

function isCurlFallbackSandboxSafe(): boolean {
  const configuredBackend = process.env.HEXCLAVE_GROWTH_SANDBOX_BACKEND;
  const backend = configuredBackend != null && configuredBackend.length > 0
    ? configuredBackend
    : process.env.VERCEL != null && process.env.VERCEL.length > 0 ? "vercel" : "docker";
  // The website-research Vercel sandbox has a subnet denylist that applies to
  // DNS results and redirects. Its local Docker backend is allow-all, so the
  // literal-IP URL preflight alone is not enough to safely curl an untrusted
  // hostname there.
  return backend === "vercel";
}

type CurlFallbackSandbox = Pick<SandboxSession, "readBinaryFile" | "removePath" | "run">;

function decodeHtmlEntities(value: string): string {
  const namedEntities = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["nbsp", " "],
    ["quot", "\""],
  ]);
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entityText, entityName: string) => {
    if (entityName.startsWith("#x")) {
      const codePoint = Number.parseInt(entityName.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entityText;
    }
    if (entityName.startsWith("#")) {
      const codePoint = Number.parseInt(entityName.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entityText;
    }
    return namedEntities.get(entityName.toLowerCase()) ?? entityText;
  });
}

/**
 * Turns a curl-fetched HTML document into a compact, model-readable fallback.
 * This is deliberately not presented as a rendered browser snapshot: scripts
 * and styles are removed, block boundaries become newlines, and the result is
 * labelled so the researcher knows client-rendered content may be missing.
 */
export function extractCurlFallbackPage(html: string, requestedUrl: string, finalUrl: string): BrowserPageResult {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeHtmlEntities(titleMatch?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "");
  const visibleText = decodeHtmlEntities(html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/(?:article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|tr|ul)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  const fallbackNotice = `[curl fallback: Chromium was unavailable; this is static HTML from ${requestedUrl} and may omit client-rendered content.]`;
  const fullSnapshot = `${fallbackNotice}\n${visibleText}`;
  const snapshotText = fullSnapshot.length > SNAPSHOT_CHAR_CAP
    ? `${fullSnapshot.slice(0, SNAPSHOT_CHAR_CAP)}\n… [snapshot truncated at ${SNAPSHOT_CHAR_CAP} characters]`
    : fullSnapshot;
  return { finalUrl, title, snapshotText };
}

/**
 * Fetches a public page through the website-research subagent's SSRF-hardened
 * Eve sandbox. The URL is passed through the process environment instead of
 * interpolated into the shell command, so arbitrary URL characters cannot
 * become shell syntax. This is the automatic fallback when Chromium cannot
 * run in the session sandbox.
 */
export async function fetchPageWithCurl(options: {
  readonly url: string,
  readonly requestId: string,
  readonly sandbox: CurlFallbackSandbox,
}): Promise<BrowserPageResult> {
  const validatedUrl = validateBrowseUrl(options.url);
  const safeRequestId = options.requestId.replace(/[^A-Za-z0-9_-]/g, "_");
  const outputPath = `/workspace/browse-page-${safeRequestId}.untracked.html`;
  try {
    const result = await options.sandbox.run({
      command: "curl --silent --show-error --location --compressed --fail-with-body --max-time 30 --max-filesize 2000000 --output \"$HEXCLAVE_BROWSE_OUTPUT_PATH\" --write-out '%{url_effective}' -- \"$HEXCLAVE_BROWSE_URL\"",
      env: {
        HEXCLAVE_BROWSE_OUTPUT_PATH: outputPath,
        HEXCLAVE_BROWSE_URL: validatedUrl.toString(),
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(`curl fallback failed with exit code ${result.exitCode}: ${result.stderr.trim() || "no error detail"}`);
    }
    const body = await options.sandbox.readBinaryFile({ path: outputPath });
    if (body == null) throw new Error("curl fallback completed without producing a response body.");
    const html = new TextDecoder().decode(body.slice(0, CURL_FALLBACK_BODY_BYTE_CAP));
    const finalUrl = result.stdout.trim() || validatedUrl.toString();
    return extractCurlFallbackPage(html, validatedUrl.toString(), finalUrl);
  } finally {
    await options.sandbox.removePath({ path: outputPath, force: true, recursive: false });
  }
}

export async function browsePageWithCurlFallback(options: {
  readonly context: BrowserSessionContext,
  readonly url: string,
  readonly requestId: string,
}): Promise<BrowserPageResult> {
  const curlFallback = async (): Promise<BrowserPageResult> => await fetchPageWithCurl({
    url: options.url,
    requestId: options.requestId,
    sandbox: await options.context.getSandbox(),
  });
  try {
    return await browsePage({ context: options.context, url: options.url, screenshot: false });
  } catch (error) {
    if (!isBrowserRuntimeUnavailableError(error)) throw error;
    if (!isCurlFallbackSandboxSafe()) throw error;
    return await curlFallback();
  }
}

class BrowseUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowseUrlValidationError";
  }
}

function parseIpv4(hostname: string): readonly number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match == null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  // Mirrors PRIVATE_SUBNET_DENYLIST above: 0/8, 10/8, 100.64/10, 127/8,
  // 169.254/16, 172.16/12, 192.168/16.
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Belt-and-braces pre-flight validation before spending sandbox time: the
 * session sandbox firewall is the real enforcement layer, but
 * rejecting obviously-internal targets here fails fast with an actionable
 * message instead of a generic navigation error. http/https only; "localhost"
 * and literal private/loopback/link-local/CGNAT IPs are refused.
 */
export function validateBrowseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowseUrlValidationError(`Not a valid absolute URL: ${JSON.stringify(rawUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowseUrlValidationError(`Only http(s) URLs can be browsed, got protocol ${JSON.stringify(url.protocol)}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new BrowseUrlValidationError("Refusing to browse localhost");
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined && isPrivateIpv4(ipv4)) {
    throw new BrowseUrlValidationError(`Refusing to browse private/reserved IP address ${hostname}`);
  }
  // Literal IPv6 hosts appear bracketed in URLs; hostname strips the brackets
  // in Node's URL, but some runtimes keep them, so check both forms.
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    if (ipv6 === "::" || ipv6 === "::1" || /^(fe[89ab]|f[cd])/.test(ipv6)) {
      throw new BrowseUrlValidationError(`Refusing to browse loopback/link-local/unique-local IPv6 address ${hostname}`);
    }
  }
  return url;
}

/**
 * Open `url` in the website-research session's browser and return the rendered
 * page's title, final URL, and interactive accessibility snapshot.
 *
 * `screenshot: true` additionally returns a base64 PNG of the viewport. The
 * screenshot artifact tool sends these bytes directly to the backend rather
 * than placing a large base64 payload in the model's context.
 *
 * The browser process is intentionally left open. A subagent hook closes it
 * and stops the sandbox at the terminal session boundary.
 */
export async function browsePage(options: {
  readonly context: BrowserSessionContext,
  readonly url: string,
  readonly screenshot: boolean,
}): Promise<BrowserPageResult> {
  const validatedUrl = validateBrowseUrl(options.url);
  return await renderPageInBrowser({
    context: options.context,
    screenshot: options.screenshot,
    url: validatedUrl.toString(),
  });
}
