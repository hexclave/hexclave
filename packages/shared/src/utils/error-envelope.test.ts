import { describe, expect, it } from "vitest";
import {
  deriveErrorEnvelopeEventId,
  normalizeErrorEnvelope,
} from "./error-envelope";

describe("error envelope normalization", () => {
  it("preserves the rich event contract when normalizing a flat error payload", () => {
    const envelope = normalizeErrorEnvelope({
      event_id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      name: "DatabaseError",
      message: "query failed",
      stack: "DatabaseError: query failed\n    at handler (/srv/app.ts:20:4)",
      handled: false,
      mechanism_type: "node.uncaughtexception",
      level: "fatal",
      user: { id: "user-123", email: "foo@example.com" },
      request: {
        url: "https://example.test/orders?authorization=secret",
        method: "post",
        status_code: 500,
        headers: { authorization: "Bearer secret" },
        body: { password: "secret" },
      },
      tags: { component: "billing" },
      contexts: { trace: { trace_id: "abc" } },
      extra: { retry: 2 },
      breadcrumbs: [{ category: "http", message: "POST /orders" }],
      fingerprint: ["{{ default }}", "billing"],
      sdk: { name: "@hexclave/node", version: "1.2.3" },
      release: "2026.08.06",
      environment: "production",
      debug_images: [{ type: "javascript", debug_id: "debug-1", code_file: "app.js" }],
      attachments: [{ filename: "event.json", content_type: "application/json", size: 42 }],
      item_metadata: { item_type: "event", content_type: "application/json", length: 123 },
    });

    expect(envelope.event_id).toBe("abcdefabcdef4abc8defabcdefabcdef");
    expect(envelope.schema).toBe("hexclave.error-envelope");
    expect(envelope.version).toBe(1);
    expect(envelope.exception?.values[0]?.type).toBe("DatabaseError");
    expect(envelope.exception?.values[0]?.value).toBe("query failed");
    expect(envelope.handled).toBe(false);
    expect(envelope.level).toBe("fatal");
    expect(envelope.request).toEqual({ url: "https://example.test/orders", method: "POST", status_code: 500 });
    expect(envelope.tags).toEqual({ component: "billing" });
    expect(envelope.sdk).toEqual({ name: "@hexclave/node", version: "1.2.3" });
    expect(envelope.debug_meta?.images).toHaveLength(1);
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.item_metadata.length).toBe(123);
  });

  it("does not shape-sniff customer payloads that resemble OTLP records", () => {
    const envelope = normalizeErrorEnvelope({
      name: "TypeError",
      message: "bad value",
      extra: { eventName: "$error" },
    });

    expect(envelope.kind).toBe("exception");
    expect(envelope.message).toBe("bad value");
    expect(envelope.extra).toEqual({ eventName: "$error" });
  });

  it("bounds strings, collections, recursion, and total size with visible drop metadata", () => {
    const cyclic: Record<string, unknown> = { secret: "do-not-retain", nested: {} };
    cyclic.nested = cyclic;
    const envelope = normalizeErrorEnvelope({
      name: "HugeError",
      message: "x".repeat(10_000),
      extra: { cyclic, values: Array.from({ length: 20 }, (_, index) => ({ index, deep: { value: "y".repeat(100) } })) },
      breadcrumbs: Array.from({ length: 10 }, (_, index) => ({ category: `crumb-${index}`, data: { value: "z".repeat(100) } })),
      exception: { values: Array.from({ length: 4 }, () => ({ type: "Error", value: "value", stacktrace: { frames: Array.from({ length: 5 }, () => ({ filename: "file.js" })) } })) },
    }, { maxDepth: 3, maxStringBytes: 64, maxFrames: 6, maxBreadcrumbs: 3, maxEventBytes: 1_500 });

    expect(new TextEncoder().encode(JSON.stringify(envelope)).length).toBeLessThanOrEqual(1_500);
    expect(envelope.exception?.values.length).toBeLessThanOrEqual(4);
    expect(envelope.exception?.values.flatMap((value) => value.stacktrace?.frames ?? []).length).toBeLessThanOrEqual(6);
    expect(envelope.breadcrumbs.length).toBeLessThanOrEqual(3);
    expect(envelope.normalization.truncated).toBe(true);
    expect(envelope.normalization.dropped.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope)).not.toContain("do-not-retain");
  });

  it("derives a stable event ID when an adapter has no event ID", () => {
    const input = { name: "Error", message: "same input", handled: true };
    expect(deriveErrorEnvelopeEventId(input)).toMatch(/^[0-9a-f]{32}$/);
    expect(normalizeErrorEnvelope(input).event_id).toBe(normalizeErrorEnvelope(input).event_id);
    expect(normalizeErrorEnvelope(input).event_id).toBe(deriveErrorEnvelopeEventId({
      kind: "exception",
      level: "error",
      handled: true,
      synthetic: undefined,
      message: "same input",
      name: "Error",
      stack: undefined,
      exception: [{ type: "Error", value: "same input", mechanism: undefined }],
      mechanism: undefined,
      request: undefined,
      user: undefined,
      tags: {},
      contexts: {},
      extra: {},
      breadcrumbs: [],
      fingerprint: [],
      sdk: undefined,
      runtime: undefined,
      release: undefined,
      dist: undefined,
      environment: undefined,
      correlation: undefined,
      debugMeta: undefined,
      attachments: [],
      itemMetadata: { item_type: "event" },
    }));
  });

  it("reads only the canonical snake_case frame and request keys", () => {
    const envelope = normalizeErrorEnvelope({
      name: "TypeError",
      message: "bad value",
      handled: true,
      exception: {
        values: [{
          type: "TypeError",
          value: "bad value",
          stacktrace: {
            frames: [{
              filename: "app.ts",
              abs_path: "https://app.example.com/app.ts",
              absPath: "https://ignored.example.com/camel.ts",
              in_app: true,
              inApp: false,
              context_line: "throw new Error(\"bad value\");",
              contextLine: "ignored",
            }],
          },
        }],
      },
      request: {
        url: "https://example.test/orders",
        status_code: 502,
        statusCode: 418,
      },
    });

    expect(envelope.exception?.values[0]?.stacktrace?.frames).toEqual([{
      filename: "app.ts",
      abs_path: "https://app.example.com/app.ts",
      in_app: true,
      context_line: "throw new Error(\"bad value\");",
    }]);
    expect(envelope.request).toEqual({ url: "https://example.test/orders", status_code: 502 });
  });

  it("does not retain request secrets or secret-shaped nested fields", () => {
    const envelope = normalizeErrorEnvelope({
      name: "RequestError",
      message: "failed",
      request: {
        url: "https://example.test/login?token=query-secret",
        headers: { authorization: "header-secret", cookie: "cookie-secret", "x-api-key": "key-secret" },
        cookies: { session: "cookie-secret" },
        query: { password: "query-secret" },
        body: { password: "body-secret", nested: { access_token: "nested-secret" } },
      },
      extra: {
        authorization: "extra-secret",
        safe: "retained",
        nested: { refresh_token: "nested-secret", value: "retained" },
      },
    });

    const serialized = JSON.stringify(envelope);
    expect(envelope.request).toEqual({ url: "https://example.test/login" });
    expect(envelope.extra).toEqual({ nested: { value: "retained" }, safe: "retained" });
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("cookie-secret");
    expect(serialized).not.toContain("body-secret");
    expect(serialized).not.toContain("nested-secret");
  });
});
