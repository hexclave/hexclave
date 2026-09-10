import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "./route-utils";
import { callReducerStrict, callSql } from "./spacetimedb-client";

// The modules under test import the `server-only` marker package, which throws
// when loaded outside a React Server Components bundler context.
vi.mock("server-only", () => ({}));

// A stand-in for what SpacetimeDB actually puts in error bodies: reducer panic
// text with module internals that must never reach an API caller.
const UPSTREAM_BODY = "panic in reducer update_mcp_qa_review: no such row in mcp_call_log";

function stubDefaultEnv() {
  // The HTTP base is derived from the single public WS host (scheme-swapped).
  vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "wss://spacetimedb.example.com");
}

function stubUpstreamResponse(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "callReducerStrict", call: () => callReducerStrict("token", "some_reducer", []) },
  { name: "callSql", call: () => callSql("token", "SELECT 1") },
])("$name upstream error mapping", ({ call }) => {
  it("maps an upstream 4xx to an assertion error, never a client StatusError", async () => {
    stubDefaultEnv();
    stubUpstreamResponse(400, UPSTREAM_BODY);

    const err = await rejectionOf(call());
    // A client (4xx) StatusError would make handleApiError return the message
    // — including the upstream body — verbatim to the API caller.
    expect(err).toBeInstanceOf(HexclaveAssertionError);
    expect(String((err as Error).message)).toContain(UPSTREAM_BODY);
  });

  it("maps an upstream 5xx to a BadGateway StatusError, keeping the body in the message for logs", async () => {
    stubDefaultEnv();
    stubUpstreamResponse(503, UPSTREAM_BODY);

    const err = await rejectionOf(call());
    expect(StatusError.isStatusError(err)).toBe(true);
    expect((err as StatusError).statusCode).toBe(502);
    expect((err as StatusError).isClientError()).toBe(false);
    expect((err as Error).message).toContain(UPSTREAM_BODY);
  });
});

describe("SpacetimeDB HTTP base resolution", () => {
  function stubOkFetch() {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("derives the https base from the wss host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "wss://spacetime.example.com");
    const fetchMock = stubOkFetch();

    await callSql("token", "SELECT 1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0]).startsWith("https://spacetime.example.com/")).toBe(true);
  });

  it("uses NEXT_PUBLIC_SPACETIMEDB_DB_NAME in the request path", async () => {
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "wss://spacetime.example.com");
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_DB_NAME", "hexclave-ai-analytics-dev");
    const fetchMock = stubOkFetch();

    await callSql("token", "SELECT 1");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/database/hexclave-ai-analytics-dev/sql");
  });

  it("falls back to hexclave-ai-analytics when the db name is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "wss://spacetime.example.com");
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_DB_NAME", "");
    const fetchMock = stubOkFetch();

    await callSql("token", "SELECT 1");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/database/hexclave-ai-analytics/sql");
  });

  it("throws when the host is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "");
    stubOkFetch();

    const err = await rejectionOf(callSql("token", "SELECT 1"));
    expect(err).toBeInstanceOf(HexclaveAssertionError);
  });
});

describe("handleApiError responses for upstream failures", () => {
  it("never returns the upstream body to the API caller", async () => {
    stubDefaultEnv();
    for (const upstreamStatus of [400, 401, 404, 500, 503]) {
      stubUpstreamResponse(upstreamStatus, UPSTREAM_BODY);
      const err = await rejectionOf(callReducerStrict("token", "some_reducer", []));

      const res = handleApiError("test-scope", err);
      const body = await res.text();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(body).not.toContain(UPSTREAM_BODY);
      expect(body).not.toContain("some_reducer");
    }
  });

  it("still returns authored client StatusError messages verbatim", async () => {
    const res = handleApiError("test-scope", new StatusError(StatusError.BadRequest, "Request body must be valid JSON."));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Request body must be valid JSON.");
  });
});
