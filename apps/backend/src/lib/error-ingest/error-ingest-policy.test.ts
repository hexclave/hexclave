import { describe, expect, it } from "vitest";
import {
  evaluateErrorIngestPolicy,
  parseErrorIngestPolicyConfig,
  ErrorIngestPolicyConfigError,
  type ErrorIngestPolicyItem,
} from "./error-ingest-policy";

function items(): readonly ErrorIngestPolicyItem[] {
  return [
    { itemId: "event:0", itemType: "event", data: { user: { email: "foo@example.com" }, url: "https://example.test/path?token=secret" } },
    { itemId: "span:0", itemType: "span", data: { message: "ok" } },
  ];
}

describe("server-side error-ingest policy", () => {
  it("adds only configured final scrubbing and keeps the default boundary", () => {
    const decision = evaluateErrorIngestPolicy({
      config: {
        observability: {
          errorIngest: {
            finalScrub: {
              dropKeys: { dropEmail: "user.email" },
              urlKeys: { pathOnlyUrl: "url" },
            },
          },
        },
      },
      items: items().slice(0, 1),
    });

    expect(decision.outcomes[0]).toMatchObject({ status: "accepted", scrubbed: true });
    expect(decision.scrubbedData.get("event:0")).toEqual({ url: "https://example.test/path", user: {} });
  });

  it("rejects unsafe override selectors without echoing configuration values", () => {
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { finalScrub: { dropKeys: { dropAuth: "request.headers.authorization" } } } },
    })).toThrowError(ErrorIngestPolicyConfigError);
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { finalScrub: { dropKeys: { dropAuth: "request.headers.authorization" } } } },
    })).toThrow("Unsupported error-ingest scrub override key");
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { finalScrub: { dropKeys: { "dotted.rule.id": "user.email" } } } },
    })).toThrow("rule ids must be short dotless identifiers");
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { finalScrub: { dropKeys: { nonStringSelector: true } } } },
    })).toThrow("Unsupported error-ingest scrub override key");
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { finalScrub: { dropUrl: { dropRule: "url" } } } },
    })).toThrow("Unsupported finalScrub policy field");
    expect(() => parseErrorIngestPolicyConfig({
      observability: { errorIngest: { unsupported: "raw-value" } },
    })).toThrow("Unsupported error-ingest policy field");
  });

  it("rejects malformed configs and keys outside the declarable policy surface", () => {
    expect(() => parseErrorIngestPolicyConfig(null)).toThrow(ErrorIngestPolicyConfigError);
    expect(() => parseErrorIngestPolicyConfig("not-a-config")).toThrow("observability config must be an object");
    expect(() => parseErrorIngestPolicyConfig({ observability: { errorIngest: { version: 1 } } })).toThrow("Unsupported error-ingest policy field");
    expect(() => parseErrorIngestPolicyConfig({ observability: { errorIngest: { rateLimit: { maxItemsPerWindow: 1, windowSeconds: 60 } } } })).toThrow("Unsupported error-ingest policy field");
    expect(() => parseErrorIngestPolicyConfig({ observability: { errorIngest: { quota: { maxBytesPerWindow: 1, windowSeconds: 60 } } } })).toThrow("Unsupported error-ingest policy field");
  });
});
