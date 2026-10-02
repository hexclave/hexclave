import { randomBytes } from "node:crypto";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch } from "../../../backend-helpers";

function sentryEnvelope(eventId: string): Uint8Array {
  const event = {
    event_id: eventId,
    message: "sentry envelope e2e",
    exception: {
      values: [{ type: "Error", value: "sentry envelope e2e", stacktrace: { frames: [{ filename: "e2e.ts", function: "capture", lineno: 7, colno: 3 }] } }],
    },
  };
  const encoder = new TextEncoder();
  const attachment = encoder.encode("e2e private attachment");
  const chunks = [
    encoder.encode(`${JSON.stringify({ event_id: eventId, sdk: { name: "e2e.sentry-compatible", version: "1.0.0" } })}\n`),
    encoder.encode(`${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`),
    encoder.encode(`${JSON.stringify({ type: "client_report" })}\n${JSON.stringify({ timestamp: "2026-08-06T00:00:00.000Z", discarded_events: [{ reason: "network_error", category: "error", quantity: 1 }] })}\n`),
    encoder.encode(`${JSON.stringify({ type: "attachment", length: attachment.byteLength, filename: "e2e.txt", content_type: "text/plain" })}\n`),
    attachment,
    encoder.encode("\n"),
  ];
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sentryTransactionEnvelope(eventId: string, traceId: string, rootSpanId: string, childSpanId: string): Uint8Array {
  const transaction = {
    event_id: eventId,
    type: "transaction",
    transaction: "GET /checkout/:id?token=transaction-secret",
    transaction_info: { source: "route" },
    start_timestamp: 1_754_444_800,
    timestamp: 1_754_444_801.25,
    contexts: { trace: { trace_id: traceId, span_id: rootSpanId, op: "http.server", status: "ok" } },
    spans: [{
      trace_id: traceId,
      span_id: childSpanId,
      parent_span_id: rootSpanId,
      start_timestamp: 1_754_444_800.25,
      timestamp: 1_754_444_800.75,
      op: "db",
      description: "SELECT users",
      data: { "db.system": "postgres", password: "child-secret" },
    }],
  };
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify(transaction));
  const chunks = [
    encoder.encode(`${JSON.stringify({ event_id: eventId, sdk: { name: "e2e.sentry-compatible", version: "1.0.0" } })}\n`),
    encoder.encode(`${JSON.stringify({ type: "transaction", length: payload.byteLength, content_type: "application/json" })}\n`),
    payload,
    encoder.encode("\n"),
  ];
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function querySpansUntil(traceId: string): Promise<{ status: number, body: { result?: Record<string, unknown>[] } }> {
  let response: { status: number, body: { result?: Record<string, unknown>[] } } = { status: 0, body: {} };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "admin",
      body: {
        query: "SELECT span_id, span_type, parent_span_id, data FROM spans WHERE trace_id = {traceId:String} ORDER BY span_id",
        params: { traceId },
      },
    });
    if (response.status === 200 && response.body.result?.length === 2) return response;
  }
  return response;
}

async function queryEnvelopeErrorsUntil(batchId: string): Promise<{ status: number, body: { result?: Record<string, unknown>[] } }> {
  let response: { status: number, body: { result?: Record<string, unknown>[] } } = { status: 0, body: {} };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    response = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "admin",
      body: {
        query: "SELECT occurrence_id FROM logs WHERE batch_id = {batchId:String} AND event_type = '$error' ORDER BY occurrence_id LIMIT 2",
        params: { batchId },
      },
    });
    if (response.status === 200 && response.body.result?.length === 1) return response;
    await wait(250);
  }
  return response;
}

it("accepts an authenticated Sentry envelope and returns itemized outcomes", { timeout: 120_000 }, async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const eventId = randomBytes(16).toString("hex");
  const response = await niceBackendFetch("/api/v1/analytics/envelope", {
    method: "POST",
    accessType: "server",
    rawBody: sentryEnvelope(eventId),
    rawContentType: "application/x-sentry-envelope",
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    inserted: 1,
    status: "accepted",
    ingest: {
      counts: { accepted: 3 },
      outcomes: [
        expect.objectContaining({ itemType: "event", eventId, status: "accepted" }),
        expect.objectContaining({ itemType: "client_report", status: "accepted" }),
        expect.objectContaining({ itemType: "attachment", eventId, status: "accepted" }),
      ],
    },
  });

  const retry = await niceBackendFetch("/api/v1/analytics/envelope", {
    method: "POST",
    accessType: "server",
    rawBody: sentryEnvelope(eventId),
    rawContentType: "application/x-sentry-envelope",
  });
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({
    batch_id: response.body.batch_id,
    inserted: 1,
    status: "accepted",
    ingest: {
      counts: { accepted: 3 },
      idempotency_key: response.body.ingest.idempotency_key,
    },
  });

  const persistedErrors = await queryEnvelopeErrorsUntil(response.body.batch_id);
  expect(persistedErrors.status).toBe(200);
  expect(persistedErrors.body.result).toHaveLength(1);

  const attachments = await niceBackendFetch(`/api/v1/analytics/attachments?event_id=${eventId}`, {
    method: "GET",
    accessType: "server",
  });
  expect(attachments.status).toBe(200);
  expect(attachments.body.attachments).toEqual([
    expect.objectContaining({ event_id: eventId, filename: "e2e.txt", content_type: "text/plain" }),
  ]);
});

it("stores a Sentry transaction and embedded span through canonical OTLP spans", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const eventId = randomBytes(16).toString("hex");
  const traceId = randomBytes(16).toString("hex");
  const rootSpanId = randomBytes(8).toString("hex");
  const childSpanId = randomBytes(8).toString("hex");
  const response = await niceBackendFetch("/api/v1/analytics/envelope", {
    method: "POST",
    accessType: "server",
    rawBody: sentryTransactionEnvelope(eventId, traceId, rootSpanId, childSpanId),
    rawContentType: "application/x-sentry-envelope",
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    inserted: 1,
    status: "accepted",
    ingest: {
      counts: { accepted: 1 },
      outcomes: [expect.objectContaining({ itemType: "transaction", eventId, status: "accepted" })],
    },
  });

  const query = await querySpansUntil(traceId);
  expect(query.status).toBe(200);
  expect(query.body.result).toEqual(expect.arrayContaining([
    expect.objectContaining({ span_id: rootSpanId, span_type: "GET /checkout/:id?token=[Filtered]", parent_span_id: null }),
    expect.objectContaining({ span_id: childSpanId, span_type: "db", parent_span_id: rootSpanId }),
  ]));
  expect(JSON.stringify(query.body.result)).not.toContain("transaction-secret");
  expect(JSON.stringify(query.body.result)).not.toContain("child-secret");
});
