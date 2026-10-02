import { isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { BAGGAGE_HEADER, encodeCorrelationBaggage, type SpanPropagationContext } from "@hexclave/shared/dist/utils/span-context-codec";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clickhouse from "./clickhouse";
import { getVerifiedCustomerRequestLinkTarget, resolveCustomerRequestObservability, runWithCustomerRequestObservability } from "./customer-request-observability";
import type { SpanInsertRow } from "./spans";

function sampledTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function request(options: {
  path?: string,
  traceparent?: string,
  correlation?: SpanPropagationContext,
} = {}): Request {
  const headers = new Headers();
  if (options.traceparent !== undefined) headers.set("traceparent", options.traceparent);
  if (options.correlation !== undefined) {
    const baggage = encodeCorrelationBaggage(options.correlation);
    if (baggage !== null) headers.set(BAGGAGE_HEADER, baggage);
  }
  return new Request(`http://localhost${options.path ?? "/api/v1/auth/oauth/token"}`, {
    method: "POST",
    headers,
  });
}

describe("customer request observability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes a scrubbed customer span under the incoming W3C parent and supports late refresh-token enrichment", async () => {
    const traceId = "11111111111111111111111111111111";
    const parentSpanId = "2222222222222222";
    const rows: SpanInsertRow[] = [];
    const writer = vi.fn(async (row: SpanInsertRow) => {
      rows.push(row);
    });

    const response = await runWithCustomerRequestObservability(
      request({
        traceparent: sampledTraceparent(traceId, parentSpanId),
        correlation: { sessionReplaySegmentId: "33333333-3333-4333-8333-333333333333" },
      }),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: null,
          refreshTokenId: null,
          headers: request({ correlation: { sessionReplaySegmentId: "33333333-3333-4333-8333-333333333333" } }).headers,
        });
        expect(getVerifiedCustomerRequestLinkTarget()).toEqual({
          traceId,
          spanId: parentSpanId,
          projectId: "project",
          branchId: "main",
        });
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user",
          refreshTokenId: "refresh",
        });
        return new Response(null, { status: 201 });
      },
      writer,
    );

    expect(response.status).toBe(201);
    expect(writer).toHaveBeenCalledOnce();
    expect(rows[0]).toMatchObject({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      span_type: "hexclave.api.request",
      kind: "server",
      status_code: "ok",
      status_message: null,
      producer: "hexclave-backend",
      project_id: "project",
      branch_id: "main",
      user_id: "user",
      refresh_token_id: "refresh",
      session_replay_segment_id: "33333333-3333-4333-8333-333333333333",
      data: JSON.stringify({ method: "POST", status_code: 201 }),
    });
    expect(rows[0]?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0]?.resource_attributes).toBe("{}");
  });

  it("continues a sampled external W3C parent without requiring Hexclave baggage", async () => {
    const traceId = "33333333333333333333333333333333";
    const parentSpanId = "4444444444444444";
    const rows: SpanInsertRow[] = [];
    const writer = vi.fn(async (row: SpanInsertRow) => {
      rows.push(row);
    });

    const incoming = request({
      traceparent: sampledTraceparent(traceId, parentSpanId),
    });
    await runWithCustomerRequestObservability(
      incoming,
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: null,
          refreshTokenId: null,
          headers: incoming.headers,
        });
        return new Response(null, { status: 200 });
      },
      writer,
    );

    expect(rows[0]?.parent_span_id).toBe(parentSpanId);
    expect(rows[0]?.trace_id).toBe(traceId);
  });

  it("does not combine a first user's identity with a conflicting refresh token", async () => {
    const rows: SpanInsertRow[] = [];

    await runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user-a",
          refreshTokenId: null,
        });
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user-b",
          refreshTokenId: "refresh-b",
        });
        return new Response(null, { status: 200 });
      },
      async (row) => {
        rows.push(row);
      },
    );

    expect(rows[0]).toMatchObject({ user_id: "user-a", refresh_token_id: null });
  });

  it("does not fill a missing pair member from an enrichment without its counterpart", async () => {
    const rows: SpanInsertRow[] = [];

    await runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user-a",
          refreshTokenId: null,
        });
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: null,
          refreshTokenId: "refresh-b",
        });
        return new Response(null, { status: 200 });
      },
      async (row) => {
        rows.push(row);
      },
    );

    expect(rows[0]).toMatchObject({ user_id: "user-a", refresh_token_id: null });
  });

  it("starts a fresh rooted trace for an unsampled caller", async () => {
    const traceId = "55555555555555555555555555555555";
    const rows: SpanInsertRow[] = [];
    const writer = vi.fn(async (row: SpanInsertRow) => {
      rows.push(row);
    });
    const incoming = request({
      traceparent: `00-${traceId}-6666666666666666-00`,
    });

    await runWithCustomerRequestObservability(
      incoming,
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: null,
          refreshTokenId: null,
          headers: incoming.headers,
        });
        return new Response(null, { status: 200 });
      },
      writer,
    );

    expect(rows[0]?.parent_span_id).toBeNull();
    expect(rows[0]?.trace_id).not.toBe(traceId);
    expect(isW3cTraceId(rows[0]?.trace_id)).toBe(true);
  });

  it("does not duplicate the internal project's own detailed request span", async () => {
    const writer = vi.fn(async (_row: SpanInsertRow) => {});

    await runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "internal",
          branchId: "main",
          userId: "user",
          refreshTokenId: "refresh",
        });
        return new Response(null, { status: 200 });
      },
      writer,
    );

    expect(writer).not.toHaveBeenCalled();
  });

  it("does not write an unauthenticated or telemetry-ingestion request", async () => {
    const writer = vi.fn(async (_row: SpanInsertRow) => {});

    await runWithCustomerRequestObservability(
      request(),
      async () => new Response(null, { status: 401 }),
      writer,
    );
    await runWithCustomerRequestObservability(
      request({ path: "/api/v1/analytics/events/batch" }),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user",
          refreshTokenId: "refresh",
        });
        return new Response(null, { status: 200 });
      },
      writer,
    );

    expect(writer).not.toHaveBeenCalled();
  });

  it("does not write a customer request span when observability is off", async () => {
    const writer = vi.fn(async (_row: SpanInsertRow) => {});

    await runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          userId: "user",
          refreshTokenId: "refresh",
        });
        return new Response(null, { status: 200 });
      },
      writer,
    );

    expect(writer).not.toHaveBeenCalled();
  });

  it("returns the response without creating a ClickHouse client when ClickHouse is absent", async () => {
    vi.stubEnv("HEXCLAVE_CLICKHOUSE_URL", "");
    vi.stubEnv("STACK_CLICKHOUSE_URL", "");
    const getClient = vi.spyOn(clickhouse, "getSharedClickhouseAdminClient").mockImplementation(() => {
      throw new Error("ClickHouse client must not be created");
    });

    const response = await runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project",
          branchId: "main",
          observabilityEnabled: true,
          userId: "user",
          refreshTokenId: "refresh",
        });
        return new Response(null, { status: 204 });
      },
    );

    expect(response.status).toBe(204);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("rejects cross-project mutation of one request holder", async () => {
    await expect(runWithCustomerRequestObservability(
      request(),
      async () => {
        resolveCustomerRequestObservability({
          projectId: "project-a",
          branchId: "main",
          userId: null,
          refreshTokenId: null,
        });
        resolveCustomerRequestObservability({
          projectId: "project-b",
          branchId: "main",
          userId: null,
          refreshTokenId: null,
        });
        return new Response();
      },
    )).rejects.toThrow("tenancy changed");
  });
});
