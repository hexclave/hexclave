import { describe, expect, it } from "vitest";
import {
  normalizeNetworkCaptureOptions,
  shouldCaptureNetworkRequest,
  type NetworkCaptureConfig,
} from "./network-capture";

describe("normalizeNetworkCaptureOptions", () => {
  it("defaults to capture-everything", () => {
    expect(normalizeNetworkCaptureOptions(undefined)).toMatchInlineSnapshot(`
      {
        "allowOrigins": null,
        "denyOrigins": null,
        "enabled": true,
        "ignoreUrls": [],
      }
    `);
  });

  it("throws when allowOrigins and denyOrigins are both set", () => {
    expect(() => normalizeNetworkCaptureOptions({ allowOrigins: ["https://a.example"], denyOrigins: ["https://b.example"] }))
      .toThrow(/mutually exclusive/);
  });
});

describe("shouldCaptureNetworkRequest", () => {
  const base = normalizeNetworkCaptureOptions(undefined);

  it("respects enabled: false", () => {
    expect(shouldCaptureNetworkRequest({ ...base, enabled: false }, new URL("https://x.example/a"))).toBe(false);
  });

  it("allowOrigins restricts to exactly those origins", () => {
    const config: NetworkCaptureConfig = { ...base, allowOrigins: ["https://api.example.com"] };
    expect(shouldCaptureNetworkRequest(config, new URL("https://api.example.com/a"))).toBe(true);
    expect(shouldCaptureNetworkRequest(config, new URL("https://other.example.com/a"))).toBe(false);
  });

  it("denyOrigins excludes those origins", () => {
    const config: NetworkCaptureConfig = { ...base, denyOrigins: ["https://blocked.example.com"] };
    expect(shouldCaptureNetworkRequest(config, new URL("https://blocked.example.com/a"))).toBe(false);
    expect(shouldCaptureNetworkRequest(config, new URL("https://fine.example.com/a"))).toBe(true);
  });

  it("ignoreUrls matches substrings of the full url (empty strings never match)", () => {
    const config: NetworkCaptureConfig = { ...base, ignoreUrls: ["/health", ""] };
    expect(shouldCaptureNetworkRequest(config, new URL("https://x.example/api/health?probe=1"))).toBe(false);
    expect(shouldCaptureNetworkRequest(config, new URL("https://x.example/api/orders"))).toBe(true);
  });
});
