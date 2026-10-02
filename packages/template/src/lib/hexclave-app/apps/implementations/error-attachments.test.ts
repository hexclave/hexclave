// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorAttachmentInput, PendingErrorAttachment } from "../interfaces/error-capture";
import {
  assertErrorAttachmentDeliveryConfigured,
  createErrorAttachmentTransport,
  deliverErrorAttachments,
  MAX_ERROR_ATTACHMENT_BYTES,
  normalizeErrorAttachmentInput,
} from "./error-attachments";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

describe("error attachments", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clones bounded string and binary inputs without putting bytes in event data", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const input: ErrorAttachmentInput = { data: bytes, filename: "dump.bin", contentType: "application/octet-stream" };
    const normalized = normalizeErrorAttachmentInput(input);

    expect(normalized).toEqual({
      data: new Uint8Array([1, 2, 3]),
      filename: "dump.bin",
      contentType: "application/octet-stream",
    });
    expect(normalized.data).not.toBe(bytes);
  });

  it("fails loudly when attachment bytes have no delivery or pending hand-off", () => {
    const attachment: ErrorAttachmentInput = { data: "bytes", filename: "notes.txt" };
    expect(() => assertErrorAttachmentDeliveryConfigured([attachment], undefined, undefined)).toThrow("never silently discarded");
  });

  it("enforces the binary and filename bounds before transport", () => {
    expect(() => normalizeErrorAttachmentInput({
      data: new Uint8Array(MAX_ERROR_ATTACHMENT_BYTES + 1),
      filename: "too-large.bin",
    })).toThrow("between 1 and");
    expect(() => normalizeErrorAttachmentInput({ data: "bytes", filename: "../secrets.txt" })).toThrow("safe path segment");
  });

  it("serializes the typed input through the injectable endpoint transport", async () => {
    const requests: Array<{ path: string, request: RequestInit }> = [];
    const transport = createErrorAttachmentTransport({
      sendRequest: async (path, request) => {
        requests.push({ path, request });
        return new Response(JSON.stringify({
          status: "uploaded",
          attachment: {
            id: "11111111-1111-4111-8111-111111111111",
            event_id: EVENT_ID,
            occurrence_id: null,
            filename: "dump.bin",
            content_type: "application/octet-stream",
            attachment_type: "event.attachment",
            byte_length: 3,
            sha256: "a".repeat(64),
            created_at: "2026-08-06T00:00:00.000Z",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await transport.upload({
      eventId: EVENT_ID,
      attachment: { data: new Uint8Array([1, 2, 3]), filename: "dump.bin" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/analytics/attachments");
    const body = requests[0]?.request.body;
    if (typeof body !== "string") throw new Error("test transport body should be JSON text");
    expect(JSON.parse(body)).toMatchObject({
      event_id: EVENT_ID,
      filename: "dump.bin",
      data_base64: "AQID",
    });
    expect(result.attachment.status).toBe("uploaded");
    expect(result.attachment.sha256).toHaveLength(64);
  });

  it("retries transient attachment responses with the server retry hint", async () => {
    vi.useFakeTimers();
    const requests: RequestInit[] = [];
    let attempt = 0;
    const transport = createErrorAttachmentTransport({
      sendRequest: async (_path, request) => {
        requests.push(request);
        attempt += 1;
        return attempt === 1
          ? new Response(undefined, { status: 429, headers: { "retry-after": "2" } })
          : new Response(JSON.stringify({
            status: "uploaded",
            attachment: {
              id: "11111111-1111-4111-8111-111111111111",
              event_id: EVENT_ID,
              occurrence_id: null,
              filename: "retry.txt",
              content_type: "application/octet-stream",
              attachment_type: "event.attachment",
              byte_length: 5,
              sha256: "a".repeat(64),
              created_at: "2026-08-06T00:00:00.000Z",
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const upload = transport.upload({ eventId: EVENT_ID, attachment: { data: "bytes", filename: "retry.txt" } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).resolves.toMatchObject({ status: "uploaded" });
    expect(requests).toHaveLength(2);
  });

  it("hands unconfigured uploads to the typed pending contract", async () => {
    const pending: PendingErrorAttachment[] = [];
    await deliverErrorAttachments({
      eventId: EVENT_ID,
      attachments: [{ data: "retry me", filename: "retry.txt" }],
      onPending: (attachment) => {
        pending.push(attachment);
      },
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.metadata).toMatchObject({ eventId: EVENT_ID, filename: "retry.txt", status: "pending" });
    await expect(pending[0]?.upload()).rejects.toThrow("No error attachment transport");
  });

  it("reports transport failures as failed pending items", async () => {
    const onPending = vi.fn<[PendingErrorAttachment], void>();
    await deliverErrorAttachments({
      eventId: EVENT_ID,
      attachments: [{ data: "retry me", filename: "retry.txt" }],
      transport: { upload: async () => { throw new Error("network unavailable"); } },
      onPending,
    });

    expect(onPending).toHaveBeenCalledOnce();
    expect(onPending.mock.calls[0]?.[0].metadata.status).toBe("failed");
  });
});
