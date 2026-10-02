import { describe, expect, it } from "vitest";
import { scrubErrorIngestPayload } from "./error-ingest-scrubber";

describe("scrubErrorIngestPayload", () => {
  it("removes request secrets and strips query data from nested envelope and OTLP shapes", () => {
    const payload = {
      attributes: new Map<string, unknown>([
        ["http.request.header.authorization", "Bearer top-secret"],
        ["url.query", "token=top-secret&email=user@example.com"],
        ["http.route", "/checkout"],
      ]),
      message: "request failed: Authorization: Bearer message-secret; token=inline-secret",
      request: {
        auth: { accessToken: "auth-secret" },
        body: { password: "body-secret", safe: "not retained" },
        headers: { authorization: "header-secret", "x-request-id": "request-id" },
        query: { customer: "customer-secret" },
        url: "https://example.test/checkout?token=url-secret&customer=customer-secret#fragment",
      },
      safe: { method: "POST", status_code: 500 },
    };

    const result = scrubErrorIngestPayload(payload);
    const serialized = JSON.stringify(result.value);

    expect(result.value).toEqual({
      attributes: { "http.route": "/checkout" },
      message: "request failed: Authorization: Bearer [Filtered]; token=[Filtered]",
      request: { url: "https://example.test/checkout" },
      safe: { method: "POST", status_code: 500 },
    });
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("customer-secret");
    expect(result.dropped).toEqual([...result.dropped].sort());
    expect(result.truncated).toBe(true);
  });

  it("filters secrets in serialized JSON messages and protocol-relative URL credentials", () => {
    const result = scrubErrorIngestPayload({
      message: 'sign-in failed: {"password":"hunter2","user":"bob"} via //login:hunter3@secret-suffix@auth.example.test/callback',
      detail: "config {'api_key':'abc123'}",
    });

    const serialized = JSON.stringify(result.value);
    expect(result.value).toEqual({
      message: 'sign-in failed: {"password":"[Filtered]","user":"bob"} via //[Filtered]@auth.example.test/callback',
      detail: "config {'api_key':'[Filtered]'}",
    });
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("hunter3");
    expect(serialized).not.toContain("abc123");
  });

  it("filters quoted assignment values containing whitespace and delimiters", () => {
    const result = scrubErrorIngestPayload({
      message: String.raw`password="two words,still secret" api_key='alpha;beta' token=bare-secret`,
    });

    expect(result.value).toEqual({
      message: 'password="[Filtered]" api_key=\'[Filtered]\' token=[Filtered]',
    });
    expect(JSON.stringify(result.value)).not.toContain("two words");
    expect(JSON.stringify(result.value)).not.toContain("alpha;beta");
    expect(JSON.stringify(result.value)).not.toContain("bare-secret");
  });

  it("filters bare auth assignments", () => {
    const result = scrubErrorIngestPayload({ message: "connect failed auth: hunter2 auth=other-secret" });

    expect(result.value).toEqual({ message: "connect failed auth: [Filtered] auth=[Filtered]" });
  });

  it("filters quoted credentials following authorization schemes", () => {
    const result = scrubErrorIngestPayload({
      message: String.raw`authorization=Bearer "two words,still secret" credential=Basic 'alpha;beta'`,
    });

    expect(result.value).toEqual({
      message: "authorization=Bearer [Filtered] credential=Basic [Filtered]",
    });
    expect(JSON.stringify(result.value)).not.toContain("two words");
    expect(JSON.stringify(result.value)).not.toContain("alpha;beta");
  });

  it("does not consume query or fragment at-signs as URL password text", () => {
    const result = scrubErrorIngestPayload({
      message: "redirect https://user:pass@example.test/callback?next=a@b#owner=c@d",
    });

    expect(result.value).toEqual({
      message: "redirect https://[Filtered]@example.test/callback?next=a@b#owner=c@d",
    });
  });

  it("filters structurally sensitive keys embedded in free-form query strings", () => {
    const result = scrubErrorIngestPayload({
      message: "request failed ?body=secret-body&form_data=secret-form&session_id=secret-session&safe=value",
    });
    expect(result.value).toEqual({
      message: "request failed ?body=[Filtered]&form_data=[Filtered]&session_id=[Filtered]&safe=value",
    });
  });

  it("keeps the built-in drop policy authoritative over urlKeys overrides", () => {
    const result = scrubErrorIngestPayload(
      { tags: { password: "https://example.test/reset?code=secret-code", plain: "https://example.test/page?q=1" } },
      { overrides: { urlKeys: ["tags.password", "tags.plain"] } },
    );

    expect(result.value).toEqual({ tags: { plain: "https://example.test/page" } });
    expect(JSON.stringify(result.value)).not.toContain("secret-code");
    expect(result.dropped).toContain("$.tags.password.sensitive");
  });

  it("is cycle-safe, bounds recursion and collections, and emits deterministic output", () => {
    const payload: Record<string, unknown> = {
      z: "last",
      nested: { b: "second", a: "first" },
      items: ["one", "two", "three"],
    };
    payload.aCycle = payload;
    payload.deep = { level: { next: { value: "too deep" } } };

    const options = { maxDepth: 3, maxCollectionEntries: 3, maxPayloadBytes: 512 };
    const first = scrubErrorIngestPayload(payload, options);
    const second = scrubErrorIngestPayload(payload, options);

    expect(first).toEqual(second);
    expect(first.value).toEqual({
      deep: { level: {} },
      items: ["one", "two", "three"],
    });
    expect(first.dropped.some((reason) => reason.endsWith(".cycle"))).toBe(true);
    expect(first.dropped.some((reason) => reason.endsWith(".depth"))).toBe(true);
    expect(first.byteLength).toBeLessThanOrEqual(options.maxPayloadBytes);
  });

  it("enforces UTF-8 string and total payload bounds", () => {
    const result = scrubErrorIngestPayload(
      { first: "😀😀😀😀", second: "this field is removed when the budget is full" },
      { maxStringBytes: 5, maxPayloadBytes: 24 },
    );

    expect(result.byteLength).toBeLessThanOrEqual(24);
    expect(result.value).toEqual({ first: "😀" });
    expect(result.dropped).toContain("$.first.string");
    expect(result.dropped.some((reason) => reason.endsWith(".bytes"))).toBe(true);
  });

  it("fails closed for non-JSON values and accessor properties", () => {
    const payload = Object.defineProperties(
      { bigint: BigInt(1), functionValue: () => "secret" },
      { computed: { enumerable: true, get: () => "should not run" } },
    );

    const result = scrubErrorIngestPayload(payload);

    expect(result.value).toEqual({});
    expect(result.truncated).toBe(true);
    expect(result.dropped.some((reason) => reason.endsWith(".type"))).toBe(true);
    expect(result.dropped.some((reason) => reason.endsWith(".accessor"))).toBe(true);
  });
});
