import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSmartRequest } from "./smart-request";

function bodyBufferFor(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  const bodyBuffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(bodyBuffer).set(encoded);
  return bodyBuffer;
}

describe("Smart Request raw body parsing", () => {
  it("preserves Sentry envelope bytes without materializing the envelope", async () => {
    const bodyBuffer = bodyBufferFor('{"event_id":"0123456789abcdef0123456789abcdef"}\n{"type":"event"}\n{}\n');
    const request = new Request("http://localhost/api/latest/analytics/sentry", {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope; charset=utf-8" },
    });

    const smartRequest = await createSmartRequest(request, bodyBuffer);

    expect(smartRequest.body).toEqual(new Uint8Array(bodyBuffer));
    expect(smartRequest.bodyBuffer).toBe(bodyBuffer);
    expect(new Uint8Array(smartRequest.bodyBuffer)).toEqual(new Uint8Array(bodyBuffer));
  });

  it("decodes transport compression without interpreting envelope framing", async () => {
    const envelope = '{"event_id":"0123456789abcdef0123456789abcdef"}\n';
    const compressed = gzipSync(new TextEncoder().encode(envelope));
    const request = new Request("http://localhost/api/latest/analytics/sentry", {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "content-encoding": "gzip" },
    });
    const compressedBuffer = new ArrayBuffer(compressed.byteLength);
    new Uint8Array(compressedBuffer).set(compressed);

    const smartRequest = await createSmartRequest(request, compressedBuffer);

    if (!(smartRequest.body instanceof Uint8Array)) throw new Error("Expected a decoded envelope byte array");
    expect(new Uint8Array(smartRequest.body)).toEqual(new TextEncoder().encode(envelope));
  });

  it("does not broaden the accepted content-type boundary", async () => {
    const request = new Request("http://localhost/api/latest/analytics/unknown", {
      method: "POST",
      headers: { "content-type": "application/x-unknown" },
    });

    await expect(createSmartRequest(request, bodyBufferFor("opaque"))).rejects.toThrow("Unknown content type in request body");
  });
});
