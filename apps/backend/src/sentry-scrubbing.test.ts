import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Event } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { prepareBackendSentryEvent, sanitizeBackendSentryEvent } from "./sentry-scrubbing";

describe("sanitizeBackendSentryEvent", () => {
  it("removes request and trace data that can contain credentials or PII", () => {
    const event: Event = {
      request: {
        method: "POST",
        url: "https://api.example.com/api/latest/users?token=secret",
        query_string: "token=secret",
        data: { password: "secret" },
        headers: { authorization: "Bearer secret" },
        cookies: { refreshToken: "secret" },
      },
      user: {
        id: "user-secret",
        email: "user@example.com",
      },
      tags: {
        project: "project-secret",
        host: "api2.hexclave.com",
      },
      transaction: "POST /api/latest/users/user-secret",
      extra: {
        location: "backend-global-error",
        connectionString: "postgres://secret",
      },
      contexts: {
        "stack-request": {
          requestId: "request-123",
          method: "POST",
          route: "/api/latest/users/[user_id]",
          host: "api2.hexclave.com",
          authorization: "Bearer secret",
        },
        response: {
          headers: {
            "set-cookie": "refresh-token=secret",
          },
        },
        trace: {
          data: {
            "db.statement": "SELECT * FROM users WHERE email = 'user@example.com'",
            "http.route": "/api/latest/users/{user_id}",
          },
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      breadcrumbs: [{
        category: "http",
        message: "POST https://api.example.com/api/latest/users?token=secret",
        data: { authorization: "Bearer secret" },
      }],
      spans: [{
        data: {
          "db.statement": "SELECT * FROM users WHERE email = 'user@example.com'",
          "http.request.method": "POST",
          "http.route": "/api/latest/users/{user_id}",
          "stack.request.host": "api2.hexclave.com",
          "stack.request.path": "/api/latest/users",
          "stack.smart-request.user.primary-email": "user@example.com",
        },
        description: "POST /api/latest/users?token=secret",
        span_id: "0123456789abcdef",
        start_timestamp: 1,
        trace_id: "0123456789abcdef0123456789abcdef",
      }],
    };

    const result = sanitizeBackendSentryEvent(event);

    expect(result).toMatchInlineSnapshot(`
      {
        "breadcrumbs": [
          {
            "category": "http",
            "level": undefined,
            "timestamp": undefined,
            "type": undefined,
          },
        ],
        "contexts": {
          "stack-request": {
            "host": "api2.hexclave.com",
            "method": "POST",
            "requestId": "request-123",
            "route": "/api/latest/users/[user_id]",
          },
          "trace": {
            "data": {
              "http.route": "/api/latest/users/{user_id}",
            },
            "links": undefined,
            "span_id": "0123456789abcdef",
            "tags": undefined,
            "trace_id": "0123456789abcdef0123456789abcdef",
          },
        },
        "extra": undefined,
        "request": {
          "method": "POST",
        },
        "spans": [
          {
            "data": {
              "http.request.method": "POST",
              "http.route": "/api/latest/users/{user_id}",
              "stack.request.host": "api2.hexclave.com",
            },
            "description": "POST /api/latest/users/{user_id}",
            "span_id": "0123456789abcdef",
            "start_timestamp": 1,
            "trace_id": "0123456789abcdef0123456789abcdef",
          },
        ],
        "tags": {
          "host": "api2.hexclave.com",
        },
        "transaction": "POST /api/latest/users/[user_id]",
        "user": undefined,
      }
    `);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("user@example.com");
  });

  it("retains audited application span names while stripping data-bearing descriptions", () => {
    const safeSpan = {
      data: {},
      description: "STACK: smart request parseAuth",
      span_id: "0123456789abcdef",
      start_timestamp: 1,
      trace_id: "0123456789abcdef0123456789abcdef",
    };
    const unsafeSpan = {
      data: {},
      description: "STACK: sending email to user@example.com",
      span_id: "fedcba9876543210",
      start_timestamp: 1,
      trace_id: "0123456789abcdef0123456789abcdef",
    };

    const result = sanitizeBackendSentryEvent({
      spans: [safeSpan, unsafeSpan],
    });

    expect(result.spans.map((span) => span.description)).toEqual([
      "STACK: smart request parseAuth",
      undefined,
    ]);
  });

  it("does not use concrete URLs or malformed route metadata as transaction names", () => {
    const result = sanitizeBackendSentryEvent({
      transaction: "GET /users/customer-123?token=secret",
      contexts: {
        "stack-request": {
          method: "GET",
          route: "/users/customer-123?token=secret",
          requestId: "request-123",
        },
      },
    });

    expect(result.transaction).toBe("backend.request");
  });

  it("does not use unsupported extension methods in request descriptions", () => {
    const event: Event = {
      request: {
        method: "BREW",
      },
      transaction: "BREW /api/latest/users",
      contexts: {
        trace: {
          data: {
            "http.request.method": "BREW",
            "http.route": "/api/latest/users",
          },
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      spans: [{
        data: {
          "http.request.method": "BREW",
          "http.route": "/api/latest/users",
        },
        description: "BREW /api/latest/users",
        span_id: "0123456789abcdef",
        start_timestamp: 1,
        trace_id: "0123456789abcdef0123456789abcdef",
      }],
    };

    const result = sanitizeBackendSentryEvent(event);

    expect({
      spanDescription: result.spans?.[0]?.description,
      transaction: result.transaction,
    }).toEqual({
      spanDescription: undefined,
      transaction: "backend.request",
    });
  });

  it("retains a fixed placeholder for requests that finish before route matching", () => {
    const event: Event = {
      request: {
        method: "OPTIONS",
        url: "https://api.example.com/api/latest/users/customer-secret",
      },
      contexts: {
        trace: {
          data: {},
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
    };
    const result = sanitizeBackendSentryEvent(event);

    expect(result.transaction).toBe("OPTIONS <unmatched>");
    expect(result.request).toEqual({ method: "OPTIONS" });
    expect(result.contexts).toEqual({
      trace: {
        data: {
          "http.request.method": "OPTIONS",
          "http.route": "<unmatched>",
        },
        links: undefined,
        span_id: "0123456789abcdef",
        tags: undefined,
        trace_id: "0123456789abcdef0123456789abcdef",
      },
    });
    expect(JSON.stringify(result)).not.toContain("customer-secret");
  });

  it("keeps a safe inbound host on stack-request and tags, including when requestId is absent", () => {
    const result = sanitizeBackendSentryEvent({
      tags: {
        host: "api2.hexclave.com",
        project: "project-secret",
      },
      contexts: {
        "stack-request": {
          host: "api2.hexclave.com",
          authorization: "Bearer secret",
        },
      },
    });

    expect(result.tags).toEqual({ host: "api2.hexclave.com" });
    expect(result.contexts).toEqual({
      "stack-request": {
        host: "api2.hexclave.com",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("drops unsafe host values from tags, stack-request, and span data", () => {
    const result = sanitizeBackendSentryEvent({
      tags: {
        host: "https://api.example.com/api/latest/users?token=secret",
      },
      contexts: {
        "stack-request": {
          requestId: "request-123",
          host: "https://api.example.com/api/latest/users?token=secret",
        },
        trace: {
          data: {
            "stack.request.host": "https://api.example.com/api/latest/users?token=secret",
            "http.request.method": "GET",
            "http.route": "/api/latest/users/[user_id]",
          },
          span_id: "0123456789abcdef",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      spans: [{
        data: {
          "stack.request.host": "https://api.example.com/api/latest/users?token=secret",
          "http.request.method": "GET",
          "http.route": "/api/latest/users/[user_id]",
        },
        description: "GET /api/latest/users/[user_id]",
        span_id: "0123456789abcdef",
        start_timestamp: 1,
        trace_id: "0123456789abcdef0123456789abcdef",
      }],
    });

    expect(result.tags).toBeUndefined();
    expect(result.contexts["stack-request"]).toEqual({
      requestId: "request-123",
    });
    expect(result.contexts.trace.data).toEqual({
      "http.request.method": "GET",
      "http.route": "/api/latest/users/[user_id]",
    });
    expect(result.spans[0].data).toEqual({
      "http.request.method": "GET",
      "http.route": "/api/latest/users/[user_id]",
    });
    expect(JSON.stringify(result)).not.toContain("token=secret");
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  it("clears all extras, including ones that look like diagnostics", () => {
    const result = sanitizeBackendSentryEvent({
      extra: {
        location: "js-execution-freestyle-failed",
        connectionString: "postgres://secret",
        leftover: "should not survive sanitize alone",
      },
    });

    expect(result.extra).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("postgres://secret");
  });
});

describe("prepareBackendSentryEvent", () => {
  it("rebuilds extra from location + exception diagnostics after scrubbing", () => {
    const cause = new Error("upstream sandbox failure");
    const error = new HexclaveAssertionError(
      "JS execution freestyle engine failed, falling back to vercel sandbox engine",
      { cause, innerCode: "<redacted workflow>", innerOptions: { timeoutMs: 1_000 } },
    );

    const result = prepareBackendSentryEvent(
      {
        request: {
          method: "POST",
          url: "https://api.example.com/api/latest/users?token=secret",
          data: { password: "secret" },
        },
        extra: {
          location: "js-execution-freestyle-failed",
          connectionString: "postgres://secret",
        },
      },
      { originalException: error },
    );

    expect(result.request).toEqual({ method: "POST" });
    expect(result.extra).toEqual(expect.objectContaining({
      location: "js-execution-freestyle-failed",
      cause: {
        name: "Error",
        message: "upstream sandbox failure",
      },
      errorProps: {
        extraData: {
          cause: {
            name: "Error",
            message: "upstream sandbox failure",
          },
          innerCode: "<redacted workflow>",
          innerOptions: { timeoutMs: 1_000 },
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("postgres://secret");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("redacts credential-shaped keys in extraData", () => {
    const error = new HexclaveAssertionError(
      "OAuth callback failed",
      {
        innerCode: "<safe>",
        password: "hunter2",
        connectionString: "postgres://user:hunter2@db/app",
        authorization: "Bearer hunter2",
        oauth: {
          accessToken: "hunter2-token",
          timeoutMs: 1_000,
        },
      },
    );

    const result = prepareBackendSentryEvent(
      { extra: { location: "oauth-callback" } },
      { originalException: error },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      location: "oauth-callback",
      errorProps: {
        extraData: {
          innerCode: "<safe>",
          password: "[redacted]",
          connectionString: "[redacted]",
          authorization: "[redacted]",
          oauth: {
            accessToken: "[redacted]",
            timeoutMs: 1_000,
          },
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("redacts plural credential keys", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "plural-keys" } },
      {
        originalException: new HexclaveAssertionError("plural extraData", {
          tokens: ["rawTokenValue"],
          passwords: ["hunter2"],
          secrets: ["shh"],
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          tokens: "[redacted]",
          passwords: "[redacted]",
          secrets: "[redacted]",
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("rawTokenValue");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("redacts URL userinfo even under a non-sensitive key", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "url-userinfo" } },
      {
        originalException: new HexclaveAssertionError("url extraData", {
          url: "postgres://user:hunter2@db/app",
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          url: "postgres://[redacted]@db/app",
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("ignores non-string location values", () => {
    const result = prepareBackendSentryEvent({
      extra: {
        location: { spoofed: true },
      },
    });

    expect(result.extra).toBeUndefined();
  });

  it("truncates deeply nested diagnostic values", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 20; depth++) {
      nested = { child: nested };
    }
    const result: Event = prepareBackendSentryEvent(
      { extra: { location: "deep-error" } },
      { originalException: new HexclaveAssertionError("deep extraData", { nested }) },
    );

    const errorProps = result.extra?.errorProps;
    expect(JSON.stringify(errorProps)).toContain("[truncated]");
    expect(JSON.stringify(errorProps)).not.toContain("leaf");
  });

  it("redacts URL userinfo when the password contains @ or space", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "url-userinfo-special-chars" } },
      {
        originalException: new HexclaveAssertionError("url extraData", {
          url: "postgres://user:p@ss word@db/app",
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          url: "postgres://[redacted]@db/app",
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("p@ss word");
  });

  it("does not treat a host followed by a prose email as URL userinfo", () => {
    const prose = "failed to reach https://api.example.com, page ops@company.com";
    const result = prepareBackendSentryEvent(
      { extra: { location: "url-prose" } },
      {
        originalException: new HexclaveAssertionError("url extraData", { note: prose }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          note: prose,
        },
      },
    }));
    expect(JSON.stringify(result)).toContain("api.example.com");
    expect(JSON.stringify(result)).toContain("ops@company.com");
  });

  it("redacts backend admin keys and extra credential-shaped fields", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "admin-key" } },
      {
        originalException: new HexclaveAssertionError("key extraData", {
          note: "issued sak_abcdefghijklmnopqrstuvwxyz",
          pwd: "hunter2",
          jwt: "header.payload.sig",
          otp: "123456",
          signature: "sig-value",
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          note: "issued [redacted]",
          pwd: "[redacted]",
          jwt: "[redacted]",
          otp: "[redacted]",
          signature: "[redacted]",
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("sak_abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("caps oversized diagnostic strings", () => {
    const huge = "x".repeat(8_000);
    const result = prepareBackendSentryEvent(
      { extra: { location: "huge-string" } },
      { originalException: new HexclaveAssertionError("huge extraData", { dump: huge }) },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          dump: `${"x".repeat(5_000)}…`,
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("x".repeat(5_001));
  });

  it("still serializes cyclic extraData", () => {
    const extraData: Record<string, unknown> = { name: "cycle-root" };
    extraData.self = extraData;
    const result = prepareBackendSentryEvent(
      { extra: { location: "cycle" } },
      { originalException: new HexclaveAssertionError("cycle extraData", extraData) },
    );

    const extra = result.extra;
    expect(JSON.stringify(extra)).toContain("cycle-root");
    expect(JSON.stringify(extra)).toContain("[truncated]");
    expect(() => JSON.stringify(extra)).not.toThrow();
  });

  it("JSON.stringify of extra does not throw on bigint, Date, Buffer, or URL", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "exotic-types" } },
      {
        originalException: new HexclaveAssertionError("exotic extraData", {
          id: 1n,
          occurredAt: new Date("2026-08-19T12:00:00.000Z"),
          payload: Buffer.from("secret-bytes"),
          href: new URL("postgres://user:hunter2@db/app"),
        }),
      },
    );

    expect(() => JSON.stringify(result.extra)).not.toThrow();
    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          id: "1",
          occurredAt: {},
          payload: "[bytes 12]",
          href: {},
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("secret-bytes");
  });

  it("redacts userinfo in redis URLs and in query-embedded URLs", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "url-variants" } },
      {
        originalException: new HexclaveAssertionError("url extraData", {
          redis: "redis://:hunter2@localhost:6379/0",
          redirect: "https://app.example.com/oauth?next=https://user:hunter2@evil.example.com/cb",
          pathAt: "https://example.com/@aman",
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          redis: "redis://[redacted]@localhost:6379/0",
          redirect: "https://app.example.com/oauth?next=https://[redacted]@evil.example.com/cb",
          pathAt: "https://example.com/@aman",
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("redacts credential keys inside webhook-shaped nested data", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "webhook" } },
      {
        originalException: new HexclaveAssertionError("Error sending Svix webhook!", {
          event: "user.created",
          data: {
            id: "user_123",
            authorization: "Bearer hunter2",
            client_secret: "shhh",
          },
        }),
      },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      errorProps: {
        extraData: {
          event: "user.created",
          data: {
            id: "user_123",
            authorization: "[redacted]",
            client_secret: "[redacted]",
          },
        },
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("shhh");
  });

  it("scrubs credential-shaped text in Error messages", () => {
    const cause = new Error("upstream postgres://user:hunter2@db/app sak_abcdefghijklmnopqrstuvwxyz");
    const result = prepareBackendSentryEvent(
      { extra: { location: "cause-message" } },
      { originalException: new HexclaveAssertionError("wrapped", { cause }) },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      cause: {
        name: "Error",
        message: "upstream postgres://[redacted]@db/app [redacted]",
      },
    }));
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("sak_abcdefghijklmnopqrstuvwxyz");
  });

  it("dumps a cause chain, not only the first Error", () => {
    const root = new Error("root failure");
    const mid = new Error("mid failure", { cause: root });
    const result = prepareBackendSentryEvent(
      { extra: { location: "cause-chain" } },
      { originalException: new HexclaveAssertionError("wrapped", { cause: mid }) },
    );

    expect(result.extra).toEqual(expect.objectContaining({
      cause: {
        name: "Error",
        message: "mid failure",
        cause: {
          name: "Error",
          message: "root failure",
        },
      },
    }));
  });

  it("does not dump extra for non-Error throws", () => {
    const result = prepareBackendSentryEvent(
      { extra: { location: "non-error" } },
      { originalException: { reason: "sandbox-timeout" } },
    );

    expect(result.extra).toEqual({
      location: "non-error",
    });
  });
});
