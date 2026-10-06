import type { Tenancy } from "@/lib/tenancies";
import type { SmartRequest } from "@/route-handlers/smart-request";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseErrorIngestEnvelope } from "@/lib/error-ingest";
import { POST as ingestEnvelope } from "./route";

const mocks = vi.hoisted(() => ({
  arePlanLimitsEnforced: vi.fn(() => true),
  enqueueQstashMessage: vi.fn(),
  getBillingTeamId: vi.fn(() => "billing-team"),
  insertBatchEvents: vi.fn(),
  insertOtlpTraces: vi.fn(),
  tryDecreasePlanItemQuantities: vi.fn(),
}));

vi.mock("@/lib/error-ingest", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/error-ingest")>();
  return { ...original, parseErrorIngestEnvelope: vi.fn(original.parseErrorIngestEnvelope) };
});
vi.mock("@/lib/analytics-telemetry-writers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/analytics-telemetry-writers")>();
  return { ...original, insertBatchEvents: mocks.insertBatchEvents };
});
vi.mock("@/lib/otlp/trace-writer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/otlp/trace-writer")>();
  return { ...original, insertOtlpTraces: mocks.insertOtlpTraces };
});
vi.mock("@/lib/qstash-outbox", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/qstash-outbox")>();
  return { ...original, enqueueQstashMessage: mocks.enqueueQstashMessage };
});
vi.mock("@/lib/clickhouse", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/clickhouse")>();
  return { ...original, getSharedClickhouseAdminClient: vi.fn(() => ({})) };
});
vi.mock("@/lib/plan-entitlements", () => ({
  arePlanLimitsEnforced: mocks.arePlanLimitsEnforced,
  getBillingTeamId: mocks.getBillingTeamId,
}));
vi.mock("@/lib/plan-metering", () => ({
  tryDecreasePlanItemQuantities: mocks.tryDecreasePlanItemQuantities,
}));
vi.mock("@/utils/background-tasks", () => ({
  runAsynchronouslyAndWaitUntil: vi.fn(),
}));

// SAFETY: the envelope route only reads tenancy.id, branchId, project.id, the observability app gate, and the
// observability grouping/ingest config sections; the rest of the Tenancy surface is unused. Starting from an empty
// base means any new Tenancy dependency of the route fails loudly here instead of being silently satisfied.
const tenancy = Object.assign({} as Tenancy, {
  id: "11111111-2222-4333-8444-555555555555",
  branchId: "main",
  project: { id: "envelope-route-test-project" },
  config: {
    apps: { installed: { observability: { enabled: true } } },
    observability: { errorGrouping: {}, errorIngest: {} },
  },
});

function request(body: unknown): SmartRequest {
  return {
    auth: {
      type: "server",
      project: tenancy.project,
      branchId: tenancy.branchId,
      tenancy,
    },
    url: "http://localhost/api/latest/analytics/envelope",
    method: "POST",
    body,
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: {},
    params: {},
    clientVersion: undefined,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-06T00:00:05.000Z"));
  vi.clearAllMocks();
  vi.mocked(parseErrorIngestEnvelope).mockClear();
  mocks.arePlanLimitsEnforced.mockReturnValue(true);
  mocks.getBillingTeamId.mockReturnValue("billing-team");
  mocks.tryDecreasePlanItemQuantities.mockResolvedValue({ insufficientItemId: null, createdChangeIds: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

function sentryEnvelopeBytes(sentAt = "2026-08-06T00:00:02.000Z"): Uint8Array {
  const eventId = "55555555555555555555555555555555";
  const lines = [
    JSON.stringify({ event_id: eventId, sent_at: sentAt }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({ event_id: eventId, timestamp: "2026-08-06T00:00:01.000Z", message: "captured", handled: true }),
    JSON.stringify({ type: "transaction", content_type: "application/json" }),
    JSON.stringify({
      event_id: eventId,
      type: "transaction",
      transaction: "/checkout",
      start_timestamp: 1_754_444_800,
      timestamp: 1_754_444_801,
      contexts: { trace: { trace_id: "66666666666666666666666666666666", span_id: "7777777777777777" } },
      spans: [{
        trace_id: "66666666666666666666666666666666",
        span_id: "8888888888888888",
        parent_span_id: "7777777777777777",
        start_timestamp: 1_754_444_800.25,
        timestamp: 1_754_444_800.75,
        op: "db",
      }],
    }),
  ];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

describe("sentry envelope parse boundary", () => {
  it("returns 400 with the parser's fixed message for a malformed envelope", async () => {
    await expect(ingestEnvelope.invoke(request(new TextEncoder().encode("this is not an envelope"))))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 400, message: "Envelope header is missing its newline" });
  });

  it("returns 400 with a fixed message for a non-binary body", async () => {
    await expect(ingestEnvelope.invoke(request({ not: "binary" })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 400, message: "Sentry envelope body must be binary" });
  });

  it("does not reflect unexpected parser failures as 400 responses", async () => {
    vi.mocked(parseErrorIngestEnvelope).mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'internal detail')");
    });
    const error = await ingestEnvelope.invoke(request(new Uint8Array([1, 2, 3]))).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    if (error === null) throw new Error("Expected the envelope invocation to reject, but it resolved");
    expect(error).toBeInstanceOf(TypeError);
    expect(StatusError.isStatusError(error)).toBe(false);
  });

  it("meters accepted events and transaction spans once before durable writes", async () => {
    const result = await ingestEnvelope.invoke(request(sentryEnvelopeBytes()));

    expect(mocks.tryDecreasePlanItemQuantities).toHaveBeenCalledWith("billing-team", [
      {
        itemId: "analytics_events",
        quantity: 1,
        idempotency: {
          key: "sentry-envelope-events:11111111-2222-4333-8444-555555555555:envelope:event:55555555555555555555555555555555",
          createdAt: new Date("2026-08-06T00:00:02.000Z"),
        },
      },
      {
        itemId: "analytics_spans",
        quantity: 2,
        idempotency: {
          key: expect.stringMatching(/^sentry-envelope-spans:11111111-2222-4333-8444-555555555555:[0-9a-f]{64}$/u),
          createdAt: new Date("2026-08-06T00:00:02.000Z"),
        },
      },
    ]);
    expect(mocks.tryDecreasePlanItemQuantities).toHaveBeenCalledOnce();
    expect(mocks.insertBatchEvents).toHaveBeenCalledOnce();
    expect(mocks.insertOtlpTraces).toHaveBeenCalledOnce();
    expect(result.body).toMatchObject({ inserted: 2, status: "accepted" });
  });

  it("uses accepted item time when the envelope sent_at is malformed", async () => {
    vi.setSystemTime(new Date("2025-08-06T01:46:45.000Z"));
    await ingestEnvelope.invoke(request(sentryEnvelopeBytes("not-a-date")));

    expect(mocks.tryDecreasePlanItemQuantities).toHaveBeenCalledWith("billing-team", expect.arrayContaining([
      expect.objectContaining({
        idempotency: expect.objectContaining({ createdAt: new Date("2025-08-06T01:46:40.000Z") }),
      }),
    ]));
  });
});
