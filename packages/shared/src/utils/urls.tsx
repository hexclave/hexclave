import { generateSecureRandomString } from "./crypto";
import { templateIdentity } from "./strings";

export function createUrlIfValid(...args: ConstructorParameters<typeof URL>) {
  try {
    return new URL(...args);
  } catch (e) {
    return null;
  }
}
import.meta.vitest?.test("createUrlIfValid", ({ expect }) => {
  // Test with valid URLs
  expect(createUrlIfValid("https://example.com")).toBeInstanceOf(URL);
  expect(createUrlIfValid("https://example.com/path?query=value#hash")).toBeInstanceOf(URL);
  expect(createUrlIfValid("/path", "https://example.com")).toBeInstanceOf(URL);

  // Test with invalid URLs
  expect(createUrlIfValid("")).toBeNull();
  expect(createUrlIfValid("not a url")).toBeNull();
  expect(createUrlIfValid("http://")).toBeNull();
});

export function isValidUrl(url: string) {
  return !!createUrlIfValid(url);
}
import.meta.vitest?.test("isValidUrl", ({ expect }) => {
  // Test with valid URLs
  expect(isValidUrl("https://example.com")).toBe(true);
  expect(isValidUrl("http://localhost:3000")).toBe(true);
  expect(isValidUrl("ftp://example.com")).toBe(true);

  // Test with invalid URLs
  expect(isValidUrl("")).toBe(false);
  expect(isValidUrl("not a url")).toBe(false);
  expect(isValidUrl("http://")).toBe(false);
});

export function isValidHostname(hostname: string) {
  // Basic validation
  if (!hostname || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    return false;
  }

  const url = createUrlIfValid(`https://${hostname}`);
  if (!url) return false;
  return url.hostname === hostname;
}
import.meta.vitest?.test("isValidHostname", ({ expect }) => {
  // Test with valid hostnames
  expect(isValidHostname("example.com")).toBe(true);
  expect(isValidHostname("localhost")).toBe(true);
  expect(isValidHostname("sub.domain.example.com")).toBe(true);
  expect(isValidHostname("127.0.0.1")).toBe(true);

  // Test with invalid hostnames
  expect(isValidHostname("")).toBe(false);
  expect(isValidHostname("example.com/path")).toBe(false);
  expect(isValidHostname("https://example.com")).toBe(false);
  expect(isValidHostname("example com")).toBe(false);
});

export function isValidHostnameWithWildcards(hostname: string) {
  // Empty hostnames are invalid
  if (!hostname) return false;

  // Check if it contains wildcards
  const hasWildcard = hostname.includes('*');

  if (!hasWildcard) {
    // If no wildcards, validate as a normal hostname
    return isValidHostname(hostname);
  }

  // Basic validation checks that apply even with wildcards
  // - Hostname cannot start or end with a dot
  if (hostname.startsWith('.') || hostname.endsWith('.')) {
    return false;
  }

  // - No consecutive dots
  if (hostname.includes('..')) {
    return false;
  }

  // For wildcard validation, check that non-wildcard parts contain valid characters
  // Replace wildcards with a valid placeholder to check the rest
  const testHostname = hostname.replace(/\*+/g, 'wildcard');

  // Check if the resulting string would be a valid hostname
  if (!/^[a-zA-Z0-9.-]+$/.test(testHostname)) {
    return false;
  }

  // Additional check: ensure the pattern makes sense
  // Check each segment between wildcards
  const segments = hostname.split(/\*+/);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '') continue; // Empty segments are OK (consecutive wildcards)

    // First segment can't start with dot
    if (i === 0 && segment.startsWith('.')) {
      return false;
    }

    // Last segment can't end with dot
    if (i === segments.length - 1 && segment.endsWith('.')) {
      return false;
    }

    // No segment should have consecutive dots
    if (segment.includes('..')) {
      return false;
    }
  }

  return true;
}
import.meta.vitest?.test("isValidHostnameWithWildcards", ({ expect }) => {
  // Test with valid regular hostnames
  expect(isValidHostnameWithWildcards("example.com")).toBe(true);
  expect(isValidHostnameWithWildcards("localhost")).toBe(true);
  expect(isValidHostnameWithWildcards("sub.domain.example.com")).toBe(true);

  // Test with valid wildcard hostnames
  expect(isValidHostnameWithWildcards("*.example.com")).toBe(true);
  expect(isValidHostnameWithWildcards("a-*.example.com")).toBe(true);
  expect(isValidHostnameWithWildcards("*.*.org")).toBe(true);
  expect(isValidHostnameWithWildcards("**.example.com")).toBe(true);
  expect(isValidHostnameWithWildcards("sub.**.com")).toBe(true);
  expect(isValidHostnameWithWildcards("*-api.*.com")).toBe(true);

  // Test with invalid hostnames
  expect(isValidHostnameWithWildcards("")).toBe(false);
  expect(isValidHostnameWithWildcards("example.com/path")).toBe(false);
  expect(isValidHostnameWithWildcards("https://example.com")).toBe(false);
  expect(isValidHostnameWithWildcards("example com")).toBe(false);
  expect(isValidHostnameWithWildcards(".example.com")).toBe(false);
  expect(isValidHostnameWithWildcards("example.com.")).toBe(false);
  expect(isValidHostnameWithWildcards("example..com")).toBe(false);
  expect(isValidHostnameWithWildcards("*.example..com")).toBe(false);
});

/**
 * Like `isValidHostnameWithWildcards`, but additionally accepts an optional numeric `:<port>` suffix, which is what
 * `wildcardUrlSchema` accepts for trusted domain base URLs (e.g. `*.example.com:4250`).
 */
export function isValidHostWithWildcards(host: string) {
  // Bracketed IPv6 literals contain colons themselves; only a colon after the closing bracket separates the port
  const portSeparatorIndex = host.startsWith('[')
    ? (host.includes(']:') ? host.lastIndexOf(':') : -1)
    : host.lastIndexOf(':');
  if (portSeparatorIndex === -1) {
    return isValidHostnameWithWildcards(host);
  }
  const hostname = host.slice(0, portSeparatorIndex);
  const port = host.slice(portSeparatorIndex + 1);
  // Leading zeroes are rejected because URL parsing normalizes ports, so a pattern like `:04250` would never match
  const numericPort = Number(port);
  if (!/^\d{1,5}$/.test(port) || numericPort < 1 || numericPort > 65535 || String(numericPort) !== port) return false;
  return isValidHostnameWithWildcards(hostname);
}
import.meta.vitest?.test("isValidHostWithWildcards", ({ expect }) => {
  expect(isValidHostWithWildcards("example.com")).toBe(true);
  expect(isValidHostWithWildcards("example.com:4250")).toBe(true);
  expect(isValidHostWithWildcards("localhost:3000")).toBe(true);
  expect(isValidHostWithWildcards("*.example.com:4250")).toBe(true);
  expect(isValidHostWithWildcards("*.*.ts.net:4250")).toBe(true);
  expect(isValidHostWithWildcards("**.example.com:8080")).toBe(true);
  expect(isValidHostWithWildcards("[::1]")).toBe(true);
  expect(isValidHostWithWildcards("[::1]:3000")).toBe(true);

  expect(isValidHostWithWildcards("")).toBe(false);
  expect(isValidHostWithWildcards("example.com:")).toBe(false);
  expect(isValidHostWithWildcards(":4250")).toBe(false);
  expect(isValidHostWithWildcards("example.com:abc")).toBe(false);
  expect(isValidHostWithWildcards("example.com:*")).toBe(false);
  expect(isValidHostWithWildcards("example.com:70000")).toBe(false);
  expect(isValidHostWithWildcards("example.com:04250")).toBe(false);
  expect(isValidHostWithWildcards("example.com:0")).toBe(false);
  expect(isValidHostWithWildcards("example.com:4250/path")).toBe(false);
  expect(isValidHostWithWildcards("https://example.com:4250")).toBe(false);
  expect(isValidHostWithWildcards("*.example..com:4250")).toBe(false);
  expect(isValidHostWithWildcards("[::1]:")).toBe(false);
  expect(isValidHostWithWildcards("[::1]:abc")).toBe(false);
});

export function matchHostnamePattern(pattern: string, hostname: string): boolean {
  // If no wildcards, it's an exact match
  if (!pattern.includes('*')) {
    return pattern === hostname;
  }

  // Convert the pattern to a regex
  // First, escape all regex special characters except *
  let regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  // Use a placeholder for ** to handle it separately from single *
  const doubleWildcardPlaceholder = '\x00DOUBLE_WILDCARD\x00';
  regexPattern = regexPattern.replace(/\*\*/g, doubleWildcardPlaceholder);

  // Replace single * with a pattern that matches anything except dots
  regexPattern = regexPattern.replace(/\*/g, '[^.]*');

  // Replace the double wildcard placeholder with a pattern that matches anything including dots
  regexPattern = regexPattern.replace(new RegExp(doubleWildcardPlaceholder, 'g'), '.*');

  // Anchor the pattern to match the entire hostname
  regexPattern = '^' + regexPattern + '$';

  try {
    const regex = new RegExp(regexPattern);
    return regex.test(hostname);
  } catch {
    return false;
  }
}
import.meta.vitest?.test("matchHostnamePattern", ({ expect }) => {
  // Test exact matches
  expect(matchHostnamePattern("example.com", "example.com")).toBe(true);
  expect(matchHostnamePattern("example.com", "other.com")).toBe(false);

  // Test single wildcard matches
  expect(matchHostnamePattern("*.example.com", "api.example.com")).toBe(true);
  expect(matchHostnamePattern("*.example.com", "www.example.com")).toBe(true);
  expect(matchHostnamePattern("*.example.com", "example.com")).toBe(false);
  expect(matchHostnamePattern("*.example.com", "api.v2.example.com")).toBe(false);

  // Test double wildcard matches
  expect(matchHostnamePattern("**.example.com", "api.example.com")).toBe(true);
  expect(matchHostnamePattern("**.example.com", "api.v2.example.com")).toBe(true);
  expect(matchHostnamePattern("**.example.com", "a.b.c.example.com")).toBe(true);
  expect(matchHostnamePattern("**.example.com", "example.com")).toBe(false);

  // Test complex patterns
  expect(matchHostnamePattern("api-*.example.com", "api-v1.example.com")).toBe(true);
  expect(matchHostnamePattern("api-*.example.com", "api-v2.example.com")).toBe(true);
  expect(matchHostnamePattern("api-*.example.com", "api.example.com")).toBe(false);
  expect(matchHostnamePattern("*.*.org", "mail.example.org")).toBe(true);
  expect(matchHostnamePattern("*.*.org", "example.org")).toBe(false);
});

export function getHardcodedFallbackUrls(primaryBaseUrl: string): string[] {
  // `defaultBaseUrl` in `@stackframe/*` SDK builds is `https://api.stack-auth.com`
  // (see `packages/template/src/lib/hexclave-app/apps/implementations/common.ts`).
  // The `@hexclave/*` mirror packages will get this rewritten to the hexclave
  // hostname by `scripts/rewrite-packages-to-hexclave.ts` in a follow-up PR; both
  // branches below stay listed so either build resolves its own fallback set.
  if (primaryBaseUrl === "https://api.stack-auth.com") {
    return ["https://api1.stack-auth.com", "https://api2.stack-auth.com"];
  }
  if (primaryBaseUrl === "https://api.dev.stack-auth.com") {
    return ["https://api1.dev.stack-auth.com", "https://api2.dev.stack-auth.com"];
  }
  if (primaryBaseUrl === "https://api.hexclave.com") {
    return ["https://api1.hexclave.com", "https://api2.hexclave.com"];
  }
  if (primaryBaseUrl === "https://api.dev.hexclave.com") {
    return ["https://api1.dev.hexclave.com", "https://api2.dev.hexclave.com"];
  }
  const localhostMatch = primaryBaseUrl.match(/^http:\/\/localhost:(\d+)02$/);
  if (localhostMatch) {
    return [`http://localhost:${localhostMatch[1]}10`];
  }
  return [];
}

export function getDefaultApiUrls(primaryBaseUrl: string): string[] {
  return [primaryBaseUrl, ...getHardcodedFallbackUrls(primaryBaseUrl)];
}

export function isLocalhost(urlOrString: string | URL) {
  const url = createUrlIfValid(urlOrString);
  if (!url) return false;
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return true;
  if (url.hostname.match(/^127\.\d+\.\d+\.\d+$/)) return true;
  if (url.hostname === "[::1]" || url.hostname === "::1") return true;
  return false;
}
import.meta.vitest?.test("isLocalhost", ({ expect }) => {
  // Test with localhost URLs
  expect(isLocalhost("http://localhost")).toBe(true);
  expect(isLocalhost("https://localhost:8080")).toBe(true);
  expect(isLocalhost("http://sub.localhost")).toBe(true);
  expect(isLocalhost("http://127.0.0.1")).toBe(true);
  expect(isLocalhost("http://127.1.2.3")).toBe(true);
  expect(isLocalhost("http://[::1]")).toBe(true);

  // Test with non-localhost URLs
  expect(isLocalhost("https://example.com")).toBe(false);
  expect(isLocalhost("http://192.168.1.1")).toBe(false);
  expect(isLocalhost("http://10.0.0.1")).toBe(false);

  // Test with URL objects
  expect(isLocalhost(new URL("http://localhost"))).toBe(true);
  expect(isLocalhost(new URL("https://example.com"))).toBe(false);

  // Test with invalid URLs
  expect(isLocalhost("not a url")).toBe(false);
  expect(isLocalhost("")).toBe(false);
});

export function isRelative(url: string) {
  const randomDomain = `${generateSecureRandomString()}.stack-auth.example.com`;
  const u = createUrlIfValid(url, `https://${randomDomain}`);
  if (!u) return false;
  if (u.host !== randomDomain) return false;
  if (u.protocol !== "https:") return false;
  return true;
}
import.meta.vitest?.test("isRelative", ({ expect }) => {
  // We can't easily mock generateSecureRandomString in this context
  // but we can still test the function's behavior

  // Test with relative URLs
  expect(isRelative("/")).toBe(true);
  expect(isRelative("/path")).toBe(true);
  expect(isRelative("/path?query=value#hash")).toBe(true);

  // Test with absolute URLs
  expect(isRelative("https://example.com")).toBe(false);
  expect(isRelative("http://example.com")).toBe(false);
  expect(isRelative("//example.com")).toBe(false);

  // Note: The implementation treats empty strings and invalid URLs as relative
  // This is because they can be resolved against a base URL
  expect(isRelative("")).toBe(true);
  expect(isRelative("not a url")).toBe(true);
});

export function getRelativePart(url: URL) {
  return url.pathname + url.search + url.hash;
}
import.meta.vitest?.test("getRelativePart", ({ expect }) => {
  // Test with various URLs
  expect(getRelativePart(new URL("https://example.com"))).toBe("/");
  expect(getRelativePart(new URL("https://example.com/path"))).toBe("/path");
  expect(getRelativePart(new URL("https://example.com/path?query=value"))).toBe("/path?query=value");
  expect(getRelativePart(new URL("https://example.com/path#hash"))).toBe("/path#hash");
  expect(getRelativePart(new URL("https://example.com/path?query=value#hash"))).toBe("/path?query=value#hash");

  // Test with different domains but same paths
  const url1 = new URL("https://example.com/path?query=value#hash");
  const url2 = new URL("https://different.com/path?query=value#hash");
  expect(getRelativePart(url1)).toBe(getRelativePart(url2));
});

/**
 * A template literal tag that returns a URL.
 *
 * Any values passed are encoded.
 */
export function url(strings: TemplateStringsArray | readonly string[], ...values: (string | number | boolean)[]): URL {
  return new URL(urlString(strings, ...values));
}
import.meta.vitest?.test("url", ({ expect }) => {
  // Test with no interpolation
  expect(url`https://example.com`).toBeInstanceOf(URL);
  expect(url`https://example.com`.href).toBe("https://example.com/");

  // Test with string interpolation
  expect(url`https://example.com/${"path"}`).toBeInstanceOf(URL);
  expect(url`https://example.com/${"path"}`.pathname).toBe("/path");

  // Test with number interpolation
  expect(url`https://example.com/${42}`).toBeInstanceOf(URL);
  expect(url`https://example.com/${42}`.pathname).toBe("/42");

  // Test with boolean interpolation
  expect(url`https://example.com/${true}`).toBeInstanceOf(URL);
  expect(url`https://example.com/${true}`.pathname).toBe("/true");

  // Test with special characters in interpolation
  expect(url`https://example.com/${"path with spaces"}`).toBeInstanceOf(URL);
  expect(url`https://example.com/${"path with spaces"}`.pathname).toBe("/path%20with%20spaces");

  // Test with multiple interpolations
  expect(url`https://example.com/${"path"}?query=${"value"}`).toBeInstanceOf(URL);
  expect(url`https://example.com/${"path"}?query=${"value"}`.pathname).toBe("/path");
  expect(url`https://example.com/${"path"}?query=${"value"}`.search).toBe("?query=value");
});


/**
 * A template literal tag that returns a URL string.
 *
 * Any values passed are encoded.
 */
export function urlString(strings: TemplateStringsArray | readonly string[], ...values: (string | number | boolean)[]): string {
  return templateIdentity(strings, ...values.map(encodeURIComponent));
}
import.meta.vitest?.test("urlString", ({ expect }) => {
  // Test with no interpolation
  expect(urlString`https://example.com`).toBe("https://example.com");

  // Test with string interpolation
  expect(urlString`https://example.com/${"path"}`).toBe("https://example.com/path");

  // Test with number interpolation
  expect(urlString`https://example.com/${42}`).toBe("https://example.com/42");

  // Test with boolean interpolation
  expect(urlString`https://example.com/${true}`).toBe("https://example.com/true");

  // Test with special characters in interpolation
  expect(urlString`https://example.com/${"path with spaces"}`).toBe("https://example.com/path%20with%20spaces");
  expect(urlString`https://example.com/${"?&="}`).toBe("https://example.com/%3F%26%3D");

  // Test with multiple interpolations
  expect(urlString`https://example.com/${"path"}?query=${"value"}`).toBe("https://example.com/path?query=value");
  expect(urlString`https://example.com/${"path"}?query=${"value with spaces"}`).toBe("https://example.com/path?query=value%20with%20spaces");
});

export function isChildUrl(parentUrl: URL, maybeChildUrl: URL) {
  return parentUrl.origin === maybeChildUrl.origin
    && isChildPath(parentUrl.pathname, maybeChildUrl.pathname)
    && [...parentUrl.searchParams].every(([key, value]) => maybeChildUrl.searchParams.get(key) === value)
    && (!parentUrl.hash || parentUrl.hash === maybeChildUrl.hash);
}
import.meta.vitest?.test("isChildUrl", ({ expect }) => {
  // true
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://abc.com/"))).toBe(true);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://abc.com/path"))).toBe(true);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://abc.com/path?query=value"))).toBe(true);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://abc.com/path?query=value#hash"))).toBe(true);

  // false
  expect(isChildUrl(new URL("https://abc.com"), new URL("https://example.com"))).toBe(false);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://example.com/path"))).toBe(false);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://example.com/path?query=value"))).toBe(false);
  expect(isChildUrl(new URL("https://abc.com/"), new URL("https://example.com/path?query=value#hash"))).toBe(false);
  expect(isChildUrl(new URL("https://example.com"), new URL("https://abc.com/path?query=value#hash"))).toBe(false);
  expect(isChildUrl(new URL("https://example.com?query=value123"), new URL("https://example.com/path?query=value#hash"))).toBe(false);
});

export function isChildPath(parentPath: string, maybeChildPath: string) {
  parentPath = parentPath.endsWith("/") ? parentPath : parentPath + "/";
  maybeChildPath = maybeChildPath.endsWith("/") ? maybeChildPath : maybeChildPath + "/";
  return maybeChildPath.startsWith(parentPath);
}
import.meta.vitest?.test("isSubPath", ({ expect }) => {
  expect(isChildPath("/", "/")).toBe(true);
  expect(isChildPath("/", "/path")).toBe(true);
  expect(isChildPath("/path", "/")).toBe(false);
  expect(isChildPath("/path", "/path")).toBe(true);
  expect(isChildPath("/path/", "/path")).toBe(true);
  expect(isChildPath("/path", "/path/")).toBe(true);
  expect(isChildPath("/path/", "/path/")).toBe(true);
  expect(isChildPath("/path", "/path/abc")).toBe(true);
  expect(isChildPath("/path/", "/path/abc")).toBe(true);
  expect(isChildPath("/path", "/path-abc")).toBe(false);
  expect(isChildPath("/path", "/path-abc/")).toBe(false);
  expect(isChildPath("/path/", "/path-abc")).toBe(false);
  expect(isChildPath("/path/", "/path-abc/")).toBe(false);
});
