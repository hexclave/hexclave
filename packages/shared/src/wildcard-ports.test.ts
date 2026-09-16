import { describe, expect, it } from "vitest";
import { wildcardProtocolAndDomainSchema, wildcardUrlSchema } from "./schema-fields";
import { validateRedirectUrl } from "./utils/redirect-urls";
import { isValidHostWithWildcards } from "./utils/urls";

describe("trusted domain port wildcards", () => {
  it.each([
    "example.com:*",
    "*.example.com:*",
    "**.example.com:*",
    "api-*.example.com:*",
    "localhost:*",
    "127.0.0.1:*",
    "[::1]:*",
  ])("accepts %s in the dashboard and configuration schemas", (host) => {
    expect(isValidHostWithWildcards(host)).toBe(true);
    for (const protocol of ["http", "https"]) {
      const pattern = `${protocol}://${host}`;
      expect(wildcardUrlSchema.isValidSync(pattern)).toBe(true);
      expect(wildcardProtocolAndDomainSchema.isValidSync(pattern)).toBe(true);
      expect(wildcardUrlSchema.validateSync(pattern)).toBe(pattern);
    }
  });

  it.each([
    ":*",
    "example.com:**",
    "example.com:4*",
    "example.com:*5",
    "example.com:*:443",
    "example..com:*",
    "user@example.com:*",
    "example.com:*/path",
    "example.com:*?query=value",
    "example.com:*#fragment",
  ])("rejects invalid dashboard host %s", (host) => {
    expect(isValidHostWithWildcards(host)).toBe(false);
  });

  it.each([
    "https://example.com:**",
    "https://example.com:4*",
    "https://example.com:*5",
    "https://example.com:*:443",
    "https://user:*@example.com",
    "https://user:*@example.com:*",
    "https://example.com:*/path*",
    "https://example.com:*/path:*",
    "https://example.com:*?query=*",
    "https://example.com:*#*",
    "https://example.com/path:*",
    "https://example.com\\path:*",
    "https://example.com?query=:*",
    "https://example.com#:*",
    "https://example..com:*",
    "ftp://example.com:*",
  ])("rejects invalid wildcard URL %s", (pattern) => {
    expect(wildcardUrlSchema.isValidSync(pattern)).toBe(false);
    expect(wildcardProtocolAndDomainSchema.isValidSync(pattern)).toBe(false);
  });

  it("preserves the distinction between URL and origin schemas", () => {
    for (const suffix of ["/handler", "?query=value", "#fragment"]) {
      const pattern = `https://*.example.com:*${suffix}`;
      expect(wildcardUrlSchema.isValidSync(pattern)).toBe(true);
      expect(wildcardProtocolAndDomainSchema.isValidSync(pattern)).toBe(false);
    }
  });

  it.each(["https://example.com:*", "https://*.example.com:*", "https://**.example.com:*"])(
    "matches configured %s across ports without changing the protocol or hostname scope",
    (pattern) => {
      const trustedDomain = wildcardUrlSchema.validateSync(pattern);
      const config = { allowLocalhost: false, trustedDomains: [trustedDomain] };
      const host = pattern.includes("*.") ? "app.example.com" : "example.com";
      for (const port of ["", ":443", ":4405", ":65535"]) {
        expect(validateRedirectUrl(`https://${host}${port}/handler/oauth-callback`, config)).toBe(true);
      }
      expect(validateRedirectUrl(`http://${host}:4405/handler`, config)).toBe(false);
      expect(validateRedirectUrl("https://unrelated.example.org:4405/handler", config)).toBe(false);
      expect(validateRedirectUrl(`https://${host}.example.org:4405/handler`, config)).toBe(false);
      expect(validateRedirectUrl("https://nested.app.example.com:4405/handler", config)).toBe(pattern.includes("**"));
    },
  );

  it.each(["https://example.com", "https://*.example.com", "https://**.example.com"])(
    "keeps %s restricted to the default port",
    (pattern) => {
      const config = { allowLocalhost: false, trustedDomains: [wildcardUrlSchema.validateSync(pattern)] };
      const host = pattern.includes("*.") ? "app.example.com" : "example.com";
      expect(validateRedirectUrl(`https://${host}:443/handler`, config)).toBe(true);
      expect(validateRedirectUrl(`https://${host}:4405/handler`, config)).toBe(false);
    },
  );
});
